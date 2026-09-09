import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import { AppError, toEnvelope } from '@iris/shared/types';
import { config, isDev } from './config.js';
import { logger } from './logger.js';
import { assertNotOwner, closePool } from './db/pool.js';
import { registerErrorHandler } from './http/errors.js';
import { ticketRoutes } from './tickets/ticket.routes.js';
import { widgetRoutes } from './widget/widget.routes.js';
import { attachmentRoutes } from './attachments/attachment.routes.js';
import { authRoutes } from './auth/auth.routes.js';
import { adminRoutes } from './admin/admin.routes.js';
import { adminTicketRoutes } from './admin/tickets.routes.js';
import { aiOpsRoutes } from './admin/ai-ops.routes.js';
import { kbRoutes } from './knowledge-base/kb.routes.js';
import { startPublisher, stopPublisher } from './events/publisher.js';
import { startAIDispatcher, stopAIDispatcher } from './events/ai-dispatcher.js';
import { startAIReaper, stopAIReaper } from './events/ai-reaper.js';
import { internalRoutes } from './internal/internal.routes.js';

export async function buildServer() {
  const app = Fastify({
    loggerInstance: logger,
    // Accept the gateway's correlation id so one id traces the whole request
    // across services, into audit_event.
    genReqId: (req) => (req.headers['x-request-id'] as string) ?? `req_${Date.now().toString(36)}`,
    trustProxy: true,
    bodyLimit: config.MAX_ATTACHMENT_BYTES + 1_048_576,
    // Same reasoning as the gateway, one hop in: the gateway's `fetch` pools
    // connections to us, so a 72s reap here turns an idle period into a
    // spurious ECONNRESET on the next proxied write.
    keepAliveTimeout: 620_000,
  });
  app.server.headersTimeout = 625_000;

  await app.register(multipart, { limits: { fileSize: config.MAX_ATTACHMENT_BYTES } });
  registerErrorHandler(app);

  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('X-Request-Id', req.id as string);
    return payload;
  });

  /**
   * core-service is never publicly bound, but a shared key stops anything else
   * on the host from calling it directly. Defence in depth for a boundary that
   * is currently only enforced by network topology.
   */
  app.addHook('onRequest', async (req) => {
    if (req.url.startsWith('/health')) return;
    /**
     * /internal/* authenticates with a PER-SERVICE HMAC signature instead
     * (see internal/service-auth.ts), so it is skipped here.
     *
     * This is not a hole. INTERNAL_API_KEY is the GATEWAY's credential, and
     * core-service accepts it on every route — including /v1/* and
     * /admin/api/*, where resolveCaller and resolveAdminCaller trust
     * x-iris-product-id / x-iris-role / x-iris-support-user-id as plain
     * headers. Phase 1 gave that key to the worker, which meant a compromised
     * worker could read any tenant's tickets and reach the admin API as
     * super_admin. Verified against a running stack.
     *
     * The worker now holds only AI_WORKER_HMAC_SECRET, which is valid on
     * /internal/ai/* and nowhere else. The internal plugin registers its own
     * onRequest + preHandler hooks and is the sole gate for this prefix;
     * phase2.security.test.ts asserts an unsigned /internal/* request is 401.
     */
    if (req.url.startsWith('/internal/')) return;
    const key = req.headers['x-internal-key'];
    if (key !== config.INTERNAL_API_KEY) {
      throw new AppError('unauthenticated', 'core-service is not directly reachable.');
    }
  });

  // Liveness only — deliberately does NOT check dependencies, or one slow
  // database takes the service out of rotation.
  app.get('/health', async () => ({
    status: 'ok',
    service: 'core-service',
    version: '1.0.0',
    uptime_s: Math.round(process.uptime()),
  }));

  app.get('/health/ready', async () => {
    const { pool } = await import('./db/pool.js');
    await pool.query('SELECT 1');
    return { status: 'ready', database: 'ok' };
  });

  await app.register(ticketRoutes);
  await app.register(widgetRoutes);
  await app.register(attachmentRoutes);
  await app.register(authRoutes);
  await app.register(adminRoutes);
  await app.register(adminTicketRoutes);
  // Phase 3 Step 8: operational read + safe replay over ai_execution.
  await app.register(aiOpsRoutes);
  // Phase 18: KB authoring and lifecycle. Admin surface only — the widget's
  // read-only KB endpoints stay in widgetRoutes above and are untouched.
  await app.register(kbRoutes);
  // Service-to-service only. Authenticated by the x-internal-key hook above and
  // never routed by the gateway, which proxies /v1/* and /admin/api/* only.
  await app.register(internalRoutes);

  return app;
}

async function main(): Promise<void> {
  // Refuse to start if we are connected as a role that bypasses RLS.
  // Better to fail loudly at boot than serve traffic with a false claim.
  await assertNotOwner();

  const app = await buildServer();
  await app.listen({ port: config.CORE_PORT, host: '127.0.0.1' });
  logger.info(
    { port: config.CORE_PORT, env: config.NODE_ENV },
    'core-service listening (internal only)',
  );

  // Drains access-callback events from the outbox. Stand-in for `worker`.
  startPublisher();
  // Bridges AI-relevant outbox events onto the single ai.jobs BullMQ queue.
  // Refuses to start unless explicitly enabled AND given a watermark, so it
  // can never flood the queue with historical events.
  startAIDispatcher();
  // Reconciles ai_execution rows left at 'running' by a crash, a stall, or a
  // terminal report that never reached Core. Never re-enqueues anything —
  // BullMQ remains the sole retry owner. Off unless AI_REAPER_ENABLED is set,
  // because it is the one background loop that mutates business state.
  startAIReaper();

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down');
    stopPublisher();
    await stopAIDispatcher();
    await stopAIReaper();
    await app.close();
    await closePool();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

// Only auto-start when run directly, so tests can import buildServer().
if (process.argv[1]?.includes('server')) {
  main().catch((err) => {
    logger.error({ err }, 'failed to start core-service');
    process.exit(1);
  });
}

export { toEnvelope, isDev };
