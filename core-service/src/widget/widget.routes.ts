import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  AppError,
  BRAND_FOOTER,
  AI_DISCLAIMER,
  WIDGET_CAPABILITIES,
  WIDGET_DEFAULTS,
  notFound,
} from '@iris/shared/types';
import { withScope } from '../db/with-scope.js';
import { resolveCaller } from '../http/context.js';
import { getArticle, listArticles, searchArticles, voteHelpful } from '../knowledge-base/kb.repo.js';
import { ask } from './ask.service.js';

const AskBody = z.object({
  question: z.string().min(1).max(2000),
  conversation_id: z.string().max(80).nullish(),
  context: z.record(z.unknown()).optional(),
});

export async function widgetRoutes(app: FastifyInstance): Promise<void> {
  // ── GET /v1/widget/config ──────────────────────────────────────────────
  // Everything product-specific comes from here. This is what makes the
  // zero-code claim literally true: a product changes its widget by editing
  // config, with no redeploy on its side.
  app.get('/v1/widget/config', async (req) => {
    const caller = await resolveCaller(req);
    const cfg = caller.product.config ?? {};
    const w = cfg.widget ?? {};

    return {
      product: { id: caller.product.id, name: caller.product.name, slug: caller.product.slug },
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
      categories: cfg.categories ?? [],
      severities: cfg.severities ?? [
        { value: 'low', label: 'Low' },
        { value: 'medium', label: 'Medium' },
        { value: 'high', label: 'High' },
        { value: 'critical', label: 'Critical' },
      ],
      default_severity: cfg.default_severity ?? 'medium',
      suggestions: w.suggestions ?? [...WIDGET_DEFAULTS.suggestions],
      knowledge_base_enabled: cfg.knowledge_base?.enabled ?? true,
      deflection_enabled: cfg.deflection?.enabled ?? true,
      allow_anonymous: w.allow_anonymous ?? false,
      identity: {
        authenticated: caller.scope.role === 'raiser',
        name: caller.raiserName,
        email: caller.raiserEmail,
      },
      disclaimer: AI_DISCLAIMER,
      footer: BRAND_FOOTER,
    };
  });

  // ── POST /v1/widget/ask ────────────────────────────────────────────────
  // ⚠️ Never creates a ticket. Deflection ≠ auto-resolution (ADR-009).
  app.post('/v1/widget/ask', async (req) => {
    const caller = await resolveCaller(req);
    const body = AskBody.parse(req.body);

    if (caller.product.config.deflection?.enabled === false) {
      throw new AppError('deflection_unavailable', 'Deflection is not enabled for this product.');
    }

    return withScope(caller.scope, (tx) =>
      ask(tx, {
        productId: caller.product.id,
        productTenantId: caller.productTenantId,
        raiserRef: caller.scope.raiserRef ?? null,
        question: body.question,
        conversationId: body.conversation_id ?? null,
        config: caller.product.config ?? {},
        requestId: caller.scope.requestId,
      }),
    );
  });

  // ── GET /v1/kb/articles ────────────────────────────────────────────────
  app.get('/v1/kb/articles', async (req) => {
    const caller = await resolveCaller(req);
    if (caller.product.config.knowledge_base?.enabled === false) {
      throw new AppError('knowledge_base_disabled', 'Knowledge base is not enabled.');
    }
    const q = req.query as Record<string, string | undefined>;
    const limit = Math.min(Number(q.limit) || 20, 50);

    const data = await withScope(caller.scope, (tx) =>
      q.q?.trim()
        ? searchArticles(tx, q.q, { category: q.category ?? null, limit })
        : listArticles(tx, { category: q.category ?? null, limit }),
    );
    return { data, next_cursor: null, has_more: false };
  });

  // ── GET /v1/kb/articles/:id ────────────────────────────────────────────
  app.get<{ Params: { id: string } }>('/v1/kb/articles/:id', async (req) => {
    const caller = await resolveCaller(req);
    const article = await withScope(caller.scope, (tx) => getArticle(tx, req.params.id));
    if (!article) throw notFound('No such article.');
    return article;
  });

  // ── POST /v1/kb/articles/:id/helpful ───────────────────────────────────
  app.post<{ Params: { id: string } }>('/v1/kb/articles/:id/helpful', async (req) => {
    const caller = await resolveCaller(req);
    const body = z.object({ helpful: z.boolean() }).parse(req.body);
    await withScope(caller.scope, (tx) => voteHelpful(tx, req.params.id, body.helpful));
    return { ok: true };
  });

  // ── GET /v1/announcements ──────────────────────────────────────────────
  app.get('/v1/announcements', async (req) => {
    const caller = await resolveCaller(req);
    const data = await withScope(caller.scope, async (tx) => {
      const { rows } = await tx.query<{
        id: string;
        title: string;
        body: string;
        kind: string;
        published_at: Date;
      }>(
        `SELECT id, title, body, kind, published_at
           FROM announcement
          ORDER BY published_at DESC
          LIMIT 20`,
      );
      return rows.map((r) => ({ ...r, published_at: r.published_at.toISOString() }));
    });
    return { data };
  });
}
