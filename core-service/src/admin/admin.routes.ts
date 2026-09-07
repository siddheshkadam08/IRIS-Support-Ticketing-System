import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  AppError,
  CATEGORY_VALUE,
  HEX_COLOR,
  WIDGET_CAPABILITIES,
  WIDGET_DEFAULTS,
  encryptSecret,
  hashPassword,
  hashSecret,
  newId,
  notFound,
  randomToken,
  type WidgetSettings,
} from '@iris/shared/types';
import { withScope } from '../db/with-scope.js';
import { writeAudit } from '../audit/index.js';
import {
  createUser,
  listUsers,
  replaceScopes,
  updateUser,
  type SupportRole,
} from '../users/user.repo.js';
import { assertTenant, requireRole, resolveAdminCaller } from './admin.context.js';

const CreateUserBody = z.object({
  email: z.string().email().max(200),
  display_name: z.string().min(1).max(120),
  role: z.enum(['super_admin', 'product_admin', 'manager', 'agent']),
  password: z.string().min(8).max(200),
  scopes: z.array(z.string()).default([]),
});

const UpdateUserBody = z.object({
  display_name: z.string().min(1).max(120).optional(),
  role: z.enum(['super_admin', 'product_admin', 'manager', 'agent']).optional(),
  availability: z.enum(['available', 'busy', 'away']).optional(),
  is_active: z.boolean().optional(),
  scopes: z.array(z.string()).optional(),
});

/**
 * Tell every gateway to drop its cached copy of this product's credentials.
 *
 * Sent inside the caller's transaction on purpose: Postgres holds NOTIFY until
 * commit, so a rolled-back edit never invalidates anything, and a committed one
 * always does. Nothing here depends on the gateway being reachable — if no
 * gateway is listening the message is simply dropped and its 60s TTL takes over.
 */
async function notifyProductChanged(tx: { query: (q: string, v?: unknown[]) => Promise<unknown> }, productId: string) {
  await tx.query(`SELECT pg_notify('iris_product_changed', $1)`, [productId]);
}

/**
 * A JWKS URL is fetched *by the gateway*, from inside the network — so an
 * operator who can set it can aim our server at anything reachable from here.
 * That is server-side request forgery, and the tenant form is exactly the kind
 * of place it hides. Require TLS and refuse private address space.
 *
 * localhost over http is allowed deliberately: local development and the mock
 * product on :6001 both need it, and neither is reachable from outside.
 */
function jwksUrlIsSafe(value: string | null | undefined): boolean {
  if (value === null || value === undefined || value === '') return true;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  const isLoopback = host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback)) return false;
  if (isLoopback) return true;

  // Literal private/link-local/metadata addresses. A hostname that *resolves*
  // to one still gets through — DNS rebinding is not solvable here, which is
  // why the gateway also caps the fetch at a 5s timeout and never echoes the
  // response body back to the caller.
  if (/^(10\.|127\.|0\.|169\.254\.|192\.168\.)/.test(host)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
  if (host === '169.254.169.254' || host.endsWith('.internal') || host.endsWith('.local')) return false;
  return true;
}

/**
 * Read the widget settings out of the nested `product.config` blob, applying
 * exactly the same defaults GET /v1/widget/config does — so what the portal
 * shows an operator is what the widget will actually render, including for a
 * tenant that has never been configured.
 */
function toWidgetSettings(config: Record<string, any>): WidgetSettings {
  const w = config.widget ?? {};
  return {
    branding: {
      title: w.title ?? WIDGET_DEFAULTS.title,
      subtitle: w.subtitle ?? WIDGET_DEFAULTS.subtitle,
      greeting: w.greeting ?? WIDGET_DEFAULTS.greeting,
      primary_color: w.primary_color ?? WIDGET_DEFAULTS.primary_color,
      accent_color: w.accent_color ?? WIDGET_DEFAULTS.accent_color,
      logo_text: w.logo_text ?? null,
    },
    capabilities: w.enabled_capabilities ?? [...WIDGET_CAPABILITIES],
    fields: {
      subject: w.fields?.subject ?? true,
      category: w.fields?.category ?? true,
      severity: w.fields?.severity ?? true,
      attachments: w.fields?.attachments ?? true,
    },
    suggestions: w.suggestions ?? [...WIDGET_DEFAULTS.suggestions],
    categories: config.categories ?? [],
    allow_anonymous: w.allow_anonymous ?? false,
    knowledge_base_enabled: config.knowledge_base?.enabled ?? true,
    deflection_enabled: config.deflection?.enabled ?? true,
  };
}

const WidgetConfigBody = z.object({
  branding: z
    .object({
      title: z.string().min(1).max(60),
      subtitle: z.string().max(120),
      greeting: z.string().min(1).max(160),
      // Interpolated into the widget's stylesheet, so it is not merely a
      // formatting preference — anything but a hex literal is an injection.
      primary_color: z.string().regex(HEX_COLOR, 'Use a hex colour like #1D4ED8'),
      accent_color: z.string().regex(HEX_COLOR, 'Use a hex colour like #2563EB'),
      logo_text: z.string().max(24).nullish(),
    })
    .partial()
    .optional(),
  capabilities: z.array(z.enum(WIDGET_CAPABILITIES)).optional(),
  fields: z
    .object({
      subject: z.boolean(),
      category: z.boolean(),
      severity: z.boolean(),
      attachments: z.boolean(),
    })
    .partial()
    .optional(),
  suggestions: z.array(z.string().min(1).max(120)).max(6).optional(),
  categories: z
    .array(
      z.object({
        value: z.string().regex(CATEGORY_VALUE, 'Lowercase letters, digits and underscores only').max(40),
        label: z.string().min(1).max(60),
      }),
    )
    .max(30)
    .optional()
    // A duplicate value silently shadows the first: two visibly different
    // options that file identically, and a filter that can never separate them.
    .refine((list) => !list || new Set(list.map((c) => c.value)).size === list.length, {
      message: 'Two categories cannot share the same value.',
    }),
  allow_anonymous: z.boolean().optional(),
  knowledge_base_enabled: z.boolean().optional(),
  deflection_enabled: z.boolean().optional(),
});

const TenantBody = z.object({
  slug: z.string().min(2).max(40).regex(/^[a-z0-9-]+$/),
  name: z.string().min(1).max(120),
  ref_prefix: z.string().min(2).max(8),
  access_mechanism: z.enum(['callback', 'preauth', 'both']).default('preauth'),
  access_callback_url: z.string().url().nullish(),
  webhook_url: z.string().url().nullish(),
  allowed_origins: z.array(z.string()).default(['*']),
  config: z.record(z.unknown()).default({}),
});

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  // ═══ Dashboard ═════════════════════════════════════════════════════════
  app.get('/admin/api/dashboard', async (req) => {
    const caller = resolveAdminCaller(req);

    return withScope(caller.scope, async (tx) => {
      const { rows: counters } = await tx.query<{ status: string; n: string }>(
        `SELECT status, count(*) AS n FROM ticket GROUP BY status`,
      );
      const byStatus: Record<string, number> = {};
      for (const r of counters) byStatus[r.status] = Number(r.n);

      const { rows: byTenant } = await tx.query<{
        product_id: string;
        name: string;
        total: string;
        open: string;
      }>(
        `SELECT p.id AS product_id, p.name,
                count(t.id) AS total,
                count(t.id) FILTER (WHERE t.status IN ('open','assigned','in_progress','waiting_on_raiser')) AS open
           FROM product p LEFT JOIN ticket t ON t.product_id = p.id
          GROUP BY p.id, p.name ORDER BY p.name`,
      );

      // Unassigned + high severity — the two views that drive real work.
      const { rows: triage } = await tx.query<{ n: string }>(
        `SELECT count(*) AS n FROM ticket WHERE status = 'open' AND assignee_id IS NULL`,
      );
      const { rows: urgent } = await tx.query<{ n: string }>(
        `SELECT count(*) AS n FROM ticket
          WHERE severity IN ('high','critical')
            AND status NOT IN ('resolved','closed')`,
      );
      const { rows: csat } = await tx.query<{ avg: string | null; n: string }>(
        `SELECT avg(rating)::numeric(3,2) AS avg, count(rating) AS n FROM ticket WHERE rating IS NOT NULL`,
      );
      const { rows: deflection } = await tx.query<{ served: string; total: string }>(
        `SELECT count(*) FILTER (WHERE outcome = 'self_served') AS served,
                count(*) AS total
           FROM widget_conversation`,
      );
      // A dead-lettered revoke is a security incident, surfaced first.
      const { rows: failed } = await tx.query<{ n: string }>(
        `SELECT count(*) AS n FROM access_grant WHERE state = 'revoke_failed'`,
      );

      const served = Number(deflection[0]?.served ?? 0);
      const totalConv = Number(deflection[0]?.total ?? 0);

      return {
        counters: {
          open: byStatus.open ?? 0,
          assigned: byStatus.assigned ?? 0,
          in_progress: byStatus.in_progress ?? 0,
          waiting_on_raiser: byStatus.waiting_on_raiser ?? 0,
          resolved: byStatus.resolved ?? 0,
          closed: byStatus.closed ?? 0,
          total: Object.values(byStatus).reduce((a, b) => a + b, 0),
        },
        by_tenant: byTenant.map((r) => ({
          product_id: r.product_id,
          name: r.name,
          total: Number(r.total),
          open: Number(r.open),
        })),
        triage_queue: Number(triage[0]?.n ?? 0),
        high_severity_open: Number(urgent[0]?.n ?? 0),
        csat: { average: csat[0]?.avg ? Number(csat[0].avg) : null, responses: Number(csat[0]?.n ?? 0) },
        // "Self-Served", never "Auto Resolved" — this counts conversations
        // that never became tickets. See docs/adr/009.
        self_served: {
          count: served,
          rate: totalConv > 0 ? Math.round((served / totalConv) * 100) : 0,
        },
        revoke_failures: Number(failed[0]?.n ?? 0),
      };
    });
  });

  // ═══ Users ═════════════════════════════════════════════════════════════
  app.get('/admin/api/users', async (req) => {
    const caller = resolveAdminCaller(req);
    return withScope(caller.scope, async (tx) => ({
      data: await listUsers(tx, caller.scopes, caller.isSuper),
    }));
  });

  app.post('/admin/api/users', async (req, reply) => {
    const caller = resolveAdminCaller(req);
    requireRole(caller, 'super_admin', 'product_admin');
    const body = CreateUserBody.parse(req.body);

    // Only a platform super admin may mint another one, or grant a tenant
    // they do not themselves hold.
    if (body.role === 'super_admin') requireRole(caller, 'super_admin');
    for (const productId of body.scopes) assertTenant(caller, productId);

    const id = await withScope(caller.scope, async (tx) => {
      const { rows: dupe } = await tx.query(`SELECT 1 FROM support_user WHERE lower(email) = lower($1)`, [
        body.email,
      ]);
      if (dupe.length) throw new AppError('invalid_request', 'That email is already registered.');

      const userId = await createUser(tx, {
        email: body.email,
        displayName: body.display_name,
        role: body.role as SupportRole,
        passwordHash: hashPassword(body.password),
        scopes: body.scopes,
        createdBy: caller.userId,
      });
      await writeAudit(tx, caller.scope, {
        action: 'support_user.created',
        entityType: 'support_user',
        entityId: userId,
        after: { email: body.email, role: body.role, scopes: body.scopes },
        sourceIp: req.ip,
      });
      return userId;
    });

    return reply.status(201).send({ id, must_change_password: true });
  });

  app.patch<{ Params: { id: string } }>('/admin/api/users/:id', async (req) => {
    const caller = resolveAdminCaller(req);
    requireRole(caller, 'super_admin', 'product_admin');
    const body = UpdateUserBody.parse(req.body);

    if (body.role === 'super_admin') requireRole(caller, 'super_admin');
    for (const productId of body.scopes ?? []) assertTenant(caller, productId);

    await withScope(caller.scope, async (tx) => {
      const { scopes, ...patch } = body;
      await updateUser(tx, req.params.id, patch);
      if (scopes) await replaceScopes(tx, req.params.id, scopes, caller.userId);

      await writeAudit(tx, caller.scope, {
        action: 'support_user.updated',
        entityType: 'support_user',
        entityId: req.params.id,
        after: body,
        sourceIp: req.ip,
      });
    });

    return { ok: true };
  });

  // ═══ Tenants ═══════════════════════════════════════════════════════════
  app.get('/admin/api/tenants', async (req) => {
    const caller = resolveAdminCaller(req);
    return withScope(caller.scope, async (tx) => {
      const { rows } = await tx.query<{
        id: string;
        slug: string;
        name: string;
        ref_prefix: string;
        publishable_key: string;
        client_id: string;
        access_mechanism: string;
        access_callback_url: string | null;
        webhook_url: string | null;
        allowed_origins: string[];
        allowed_issuers: string[];
        jwks_url: string | null;
        has_jwks_inline: boolean;
        config: Record<string, unknown>;
        is_active: boolean;
        created_at: Date;
        ticket_count: string;
        user_count: string;
      }>(
        `SELECT p.id, p.slug, p.name, p.ref_prefix, p.publishable_key, p.client_id,
                p.access_mechanism, p.access_callback_url, p.webhook_url,
                p.allowed_origins, p.allowed_issuers, p.jwks_url,
                (p.jwks_inline IS NOT NULL) AS has_jwks_inline,
                p.config, p.is_active, p.created_at,
                (SELECT count(*) FROM ticket t WHERE t.product_id = p.id) AS ticket_count,
                (SELECT count(*) FROM support_user_scope s WHERE s.product_id = p.id) AS user_count
           FROM product p ORDER BY p.name`,
      );
      return {
        data: rows.map((r) => ({
          ...r,
          created_at: r.created_at.toISOString(),
          ticket_count: Number(r.ticket_count),
          user_count: Number(r.user_count),
          // Secrets are never returned, not even to a super admin. Rotation
          // returns the new value once and only once.
          client_secret: null,
        })),
      };
    });
  });

  app.post('/admin/api/tenants', async (req, reply) => {
    const caller = resolveAdminCaller(req);
    requireRole(caller, 'super_admin');
    const body = TenantBody.parse(req.body);

    const created = await withScope(caller.scope, async (tx) => {
      const id = `prod_${body.slug.replace(/-/g, '_')}`;
      const clientSecret = `sk_live_${randomToken(24)}`;
      const webhookSecret = `whsec_${randomToken(24)}`;

      // Check before inserting so the operator gets a field-level message.
      // The unique constraints are still the real guarantee — this is only
      // here so a taken slug reads as "that slug is taken" rather than as an
      // unexplained 500. Both are checked in one round trip.
      const { rows: clash } = await tx.query<{ slug: string; ref_prefix: string }>(
        `SELECT slug, ref_prefix FROM product WHERE slug = $1 OR ref_prefix = $2 OR id = $3`,
        [body.slug, body.ref_prefix.toUpperCase(), id],
      );
      if (clash.length) {
        const fields: Record<string, string[]> = {};
        if (clash.some((c) => c.slug === body.slug)) {
          fields.slug = [`The slug "${body.slug}" is already used by another tenant.`];
        }
        if (clash.some((c) => c.ref_prefix === body.ref_prefix.toUpperCase())) {
          // Not cosmetic: the prefix is half of every ticket reference, so a
          // duplicate makes CARB-1042 ambiguous forever. See migration 011.
          fields.ref_prefix = [
            `The ticket prefix "${body.ref_prefix.toUpperCase()}" is already used by another tenant. ` +
              'Ticket references must be unique, so pick a different one.',
          ];
        }
        throw new AppError('already_exists', 'That tenant already exists.', { fields });
      }

      await tx.query(
        `INSERT INTO product
           (id, slug, name, ref_prefix, client_id, client_secret_hash, client_secret_enc,
            publishable_key, webhook_secret_hash, webhook_secret_enc,
            access_mechanism, access_callback_url, webhook_url, allowed_origins, config)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [
          id,
          body.slug,
          body.name,
          body.ref_prefix.toUpperCase(),
          `iris_${body.slug}_client`,
          hashSecret(clientSecret),
          encryptSecret(clientSecret),
          `pub_live_${body.slug}_${randomToken(4)}`,
          hashSecret(webhookSecret),
          encryptSecret(webhookSecret),
          body.access_mechanism,
          body.access_callback_url ?? null,
          body.webhook_url ?? null,
          body.allowed_origins,
          JSON.stringify(body.config),
        ],
      );

      await writeAudit(tx, caller.scope, {
        action: 'tenant.created',
        entityType: 'product',
        entityId: id,
        productId: id,
        after: { slug: body.slug, name: body.name },
        sourceIp: req.ip,
      });
      // A publishable key probed before the tenant existed is cached as a miss.
      await notifyProductChanged(tx, id);

      const { rows } = await tx.query<{ publishable_key: string }>(
        `SELECT publishable_key FROM product WHERE id = $1`,
        [id],
      );
      // The only time these are ever shown.
      return { id, publishable_key: rows[0]!.publishable_key, client_secret: clientSecret, webhook_secret: webhookSecret };
    });

    return reply.status(201).send(created);
  });

  // ── Widget configuration ───────────────────────────────────────────────
  //
  // Its own endpoint rather than a raw `config` blob on the tenant PATCH.
  // Handing an operator a free-form JSON field means a typo'd key writes
  // successfully, reads back successfully, and simply never takes effect —
  // the widget falls through to its default and nothing reports a problem.
  // A validated, merging endpoint makes a bad key a 400 instead.
  app.get<{ Params: { id: string } }>('/admin/api/tenants/:id/widget-config', async (req) => {
    const caller = resolveAdminCaller(req);
    assertTenant(caller, req.params.id);

    return withScope(caller.scope, async (tx) => {
      const { rows } = await tx.query<{ config: Record<string, any>; name: string }>(
        `SELECT config, name FROM product WHERE id = $1`,
        [req.params.id],
      );
      const row = rows[0];
      if (!row) throw notFound('No such tenant.');
      return toWidgetSettings(row.config ?? {});
    });
  });

  app.patch<{ Params: { id: string } }>('/admin/api/tenants/:id/widget-config', async (req) => {
    const caller = resolveAdminCaller(req);
    requireRole(caller, 'super_admin', 'product_admin');
    assertTenant(caller, req.params.id);
    const body = WidgetConfigBody.parse(req.body);

    return withScope(caller.scope, async (tx) => {
      const { rows } = await tx.query<{ config: Record<string, any> }>(
        `SELECT config FROM product WHERE id = $1 FOR UPDATE`,
        [req.params.id],
      );
      const row = rows[0];
      if (!row) throw notFound('No such tenant.');

      // Merge, never replace. `config` also holds access policy (scope_kind,
      // max_ttl_seconds) that this editor knows nothing about; a wholesale
      // write would silently discard it.
      const current = row.config ?? {};
      const widget = { ...(current.widget ?? {}) };

      if (body.branding) Object.assign(widget, body.branding);
      if (body.capabilities) widget.enabled_capabilities = body.capabilities;
      if (body.fields) widget.fields = { ...(widget.fields ?? {}), ...body.fields };
      if (body.suggestions) widget.suggestions = body.suggestions;
      if (body.allow_anonymous !== undefined) widget.allow_anonymous = body.allow_anonymous;

      const next: Record<string, unknown> = { ...current, widget };
      if (body.categories) next.categories = body.categories;
      if (body.knowledge_base_enabled !== undefined) {
        next.knowledge_base = { ...(current.knowledge_base ?? {}), enabled: body.knowledge_base_enabled };
      }
      if (body.deflection_enabled !== undefined) {
        next.deflection = { ...(current.deflection ?? {}), enabled: body.deflection_enabled };
      }

      await tx.query(`UPDATE product SET config = $2::jsonb WHERE id = $1`, [
        req.params.id,
        JSON.stringify(next),
      ]);
      await writeAudit(tx, caller.scope, {
        action: 'tenant.widget_config_updated',
        entityType: 'product',
        entityId: req.params.id,
        productId: req.params.id,
        before: toWidgetSettings(current),
        after: toWidgetSettings(next),
        sourceIp: req.ip,
      });
      await notifyProductChanged(tx, req.params.id);

      return toWidgetSettings(next);
    });
  });

  app.patch<{ Params: { id: string } }>('/admin/api/tenants/:id', async (req) => {
    const caller = resolveAdminCaller(req);
    requireRole(caller, 'super_admin', 'product_admin');
    assertTenant(caller, req.params.id);

    const body = z
      .object({
        name: z.string().min(1).max(120).optional(),
        access_mechanism: z.enum(['callback', 'preauth', 'both']).optional(),
        access_callback_url: z.string().url().nullish(),
        webhook_url: z.string().url().nullish(),
        allowed_origins: z.array(z.string()).optional(),
        config: z.record(z.unknown()).optional(),
        is_active: z.boolean().optional(),

        // ── SSO (end-user identity) ──────────────────────────────────────
        // The product mints a short-lived JWT for its signed-in user; we verify
        // it against the product's own keys. These three fields are what make
        // that possible, so without them a tenant can only use the dev issuer.
        allowed_issuers: z.array(z.string().min(1).max(400)).max(10).optional(),
        jwks_url: z.string().url().nullish().refine(jwksUrlIsSafe, {
          message:
            'JWKS URL must be https (http allowed only for localhost) and must not point at a private address.',
        }),
        jwks_inline: z.record(z.unknown()).nullish(),
      })
      .parse(req.body);

    await withScope(caller.scope, async (tx) => {
      const sets: string[] = [];
      const params: unknown[] = [req.params.id];
      const asJson = new Set(['config', 'jwks_inline']);
      for (const [key, value] of Object.entries(body)) {
        if (value === undefined) continue;
        params.push(asJson.has(key) && value !== null ? JSON.stringify(value) : value);
        sets.push(`${key} = $${params.length}${asJson.has(key) ? '::jsonb' : ''}`);
      }
      if (!sets.length) return;

      await tx.query(`UPDATE product SET ${sets.join(', ')} WHERE id = $1`, params);
      await writeAudit(tx, caller.scope, {
        action: 'tenant.updated',
        entityType: 'product',
        entityId: req.params.id,
        productId: req.params.id,
        after: body,
        sourceIp: req.ip,
      });
      await notifyProductChanged(tx, req.params.id);
    });

    return { ok: true };
  });

  // ═══ Audit log ═════════════════════════════════════════════════════════
  app.get('/admin/api/audit', async (req) => {
    const caller = resolveAdminCaller(req);
    requireRole(caller, 'super_admin', 'product_admin', 'manager');
    const q = req.query as Record<string, string | undefined>;

    return withScope(caller.scope, async (tx) => {
      const where: string[] = [];
      const params: unknown[] = [];
      const add = (clause: string, value: unknown) => {
        params.push(value);
        where.push(clause.replace('?', `$${params.length}`));
      };
      if (q.action) add('action ILIKE ?', `%${q.action}%`);
      if (q.actor) add('actor_ref = ?', q.actor);
      if (q.entity_type) add('entity_type = ?', q.entity_type);
      if (q.entity_id) add('entity_id = ?', q.entity_id);
      if (q.since) add('occurred_at >= ?', new Date(q.since));

      const limit = Math.min(Number(q.limit) || 100, 500);
      params.push(limit);

      const { rows } = await tx.query<{
        id: string;
        product_id: string | null;
        actor_type: string;
        actor_ref: string | null;
        actor_name: string | null;
        action: string;
        entity_type: string;
        entity_id: string | null;
        before: unknown;
        after: unknown;
        request_id: string | null;
        source_ip: string | null;
        occurred_at: Date;
      }>(
        `SELECT a.id, a.product_id, a.actor_type, a.actor_ref, a.action, a.entity_type,
                a.entity_id, a.before, a.after, a.request_id, a.source_ip, a.occurred_at,
                u.display_name AS actor_name
           FROM audit_event a
           LEFT JOIN support_user u ON u.id = a.actor_ref
          ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
          ORDER BY a.occurred_at DESC
          LIMIT $${params.length}`,
        params,
      );

      return {
        data: rows.map((r) => ({ ...r, occurred_at: r.occurred_at.toISOString() })),
      };
    });
  });
}
