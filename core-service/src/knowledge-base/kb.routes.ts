import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  EMBEDDING_MODEL_ID,
  KB_BODY_MAX,
  KB_CATEGORY_MAX,
  KB_LIST_DEFAULT_LIMIT,
  KB_LIST_MAX_LIMIT,
  KB_QUERY_MAX,
  KB_STATUSES,
  KB_TITLE_MAX,
  newId,
  notFound,
  type KbArticleListResponse,
} from '@iris/shared/types';
import { withScope } from '../db/with-scope.js';
import { writeAudit } from '../audit/index.js';
import { assertTenant, resolveAdminCaller } from '../admin/admin.context.js';
import {
  createArticle,
  findArticleForAdmin,
  listArticlesForAdmin,
  toAdminDTO,
  updateArticleStatus,
  updateArticleText,
} from './kb.admin.repo.js';
import { assertCanEditKb, assertCanTransitionKb, assertKbTransition } from './kb.service.js';

/**
 * Knowledge base authoring — Phase 18.
 *
 * ⚠️ WHY THIS LIVES ON /admin/api AND NOWHERE ELSE.
 *
 * `/v1` belongs to integrating products and their end users. It already serves
 * the KB, read-only, through kb.repo.ts, and an authoring endpoint there would
 * let a product write its own knowledge base with a credential issued for
 * raising tickets. `/internal` is service-authenticated and never routed by the
 * gateway, so a human-facing editor cannot reach it. `/admin/api` is the only
 * surface with an authenticated support-user identity, a role, a product scope
 * and gateway routing — all four of which this feature needs, and none of which
 * it should reinvent.
 *
 * ⚠️ FIVE ENDPOINTS, ONE OF WHICH IS THE WHOLE LIFECYCLE.
 *
 * There is no /publish, /unpublish or /archive. IRIS already made this choice
 * for tickets: `PATCH /admin/api/tickets/:id/status` takes the target state in
 * the body and consults one transition matrix. Four verb endpoints would mean
 * the matrix is either duplicated four times or lives in a helper that four
 * routes must each remember to call, and a fifth state later means a fifth
 * route. One endpoint means adding a state is editing a table.
 *
 * ⚠️ NO OUTBOX EVENT IS EMITTED BY ANY HANDLER HERE, DELIBERATELY.
 *
 * Publishing an article does not need to tell the embedding pipeline anything.
 * The pipeline is a pull: `selectPending` asks the database which rows are
 * eligible and stale, and the answer changes the moment this transaction
 * commits. Migration 014 records the reasoning in full — an event would have to
 * be emitted from lifecycle code, and it still would not notice a later edit,
 * which the generated `embedding_content_sha` does for free.
 */

// ─────────────────────────────────────────────────────────────────────────
// Request shapes
// ─────────────────────────────────────────────────────────────────────────

const ListQuery = z.object({
  product_id: z.string().max(64).optional(),
  status: z.enum(KB_STATUSES).optional(),
  q: z.string().max(KB_QUERY_MAX).optional(),
  limit: z.coerce.number().int().min(1).max(KB_LIST_MAX_LIMIT).default(KB_LIST_DEFAULT_LIMIT),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

/**
 * ⚠️ THERE IS NO `status` FIELD, AND THERE MUST NEVER BE ONE.
 *
 * Creation always produces a draft. Accepting a status here would let a caller
 * publish in one step, skipping the role check and the audit row that the
 * transition endpoint attaches to publication — the single review point in the
 * whole lifecycle, bypassed by a field. The repository writes 'draft' as a SQL
 * literal for the same reason, so this is defence in depth rather than the only
 * guard.
 *
 * `is_public` is absent for the same class of reason: it is not writable at the
 * database (migration 018), and a published-but-not-public article would sit in
 * no corpus while looking live.
 */
const CreateBody = z.object({
  product_id: z.string().min(1).max(64),
  title: z.string().trim().min(1).max(KB_TITLE_MAX),
  body: z.string().trim().min(1).max(KB_BODY_MAX),
  category: z.string().trim().min(1).max(KB_CATEGORY_MAX).nullish(),
});

/**
 * Partial by design: an editor fixing a title should not have to send the body
 * back. `.strict()` so that a field this endpoint does not accept — `status`,
 * `product_id`, `views` — is a loud 400 rather than a silently ignored key that
 * reads back unchanged and looks like a lost save.
 */
const UpdateBody = z
  .object({
    title: z.string().trim().min(1).max(KB_TITLE_MAX).optional(),
    body: z.string().trim().min(1).max(KB_BODY_MAX).optional(),
    category: z.string().trim().min(1).max(KB_CATEGORY_MAX).nullish(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'Send at least one field to change.' });

const StatusBody = z.object({ status: z.enum(KB_STATUSES) }).strict();

/**
 * What an edit records in the audit trail.
 *
 * ⚠️ THE BODY TEXT IS NOT STORED, and `content_sha` is why that is not a gap.
 * It is the GENERATED `embedding_content_sha` — a sha256 of the normalised
 * title and body, maintained by Postgres — so the audit row identifies the
 * exact text before and after without copying it. Storing 50 kB of prose twice
 * per save into an append-only table nobody can prune would turn `audit_event`
 * into a revision store, and revisions are a declared non-goal; the sha gives
 * the property that actually matters, which is being able to tell whether the
 * text changed and whether a given revision is the one being looked at.
 */
function auditShape(row: { title: string; category: string | null; embedding_content_sha: string | null }, bodyChars: number) {
  return {
    title: row.title,
    category: row.category,
    body_chars: bodyChars,
    content_sha: row.embedding_content_sha,
  };
}

export async function kbRoutes(app: FastifyInstance): Promise<void> {
  /**
   * The scope narrowing every query in this file uses.
   *
   * NULL only for a super admin whose session carries no scope header, which is
   * a real state (see KbListArgs). Everyone else is narrowed to their own
   * tenants, alongside RLS rather than instead of it.
   */
  const narrowing = (caller: ReturnType<typeof resolveAdminCaller>): string[] | null =>
    caller.isSuper && caller.scopes.length === 0 ? null : caller.scopes;

  // ═══ GET /admin/api/kb/articles ═══════════════════════════════════════
  app.get('/admin/api/kb/articles', async (req) => {
    const caller = resolveAdminCaller(req);
    const q = ListQuery.parse(req.query);

    // A tenant filter is authorization, not presentation: assert it before it
    // reaches SQL so an out-of-scope id is a refusal rather than an empty page
    // that looks like the tenant has no articles.
    if (q.product_id) assertTenant(caller, q.product_id);

    return withScope(caller.scope, async (tx): Promise<KbArticleListResponse> => {
      const { rows, total } = await listArticlesForAdmin(tx, {
        productIds: narrowing(caller),
        productId: q.product_id ?? null,
        status: q.status ?? null,
        q: q.q ?? null,
        limit: q.limit,
        offset: q.offset,
      });

      return {
        data: rows.map((r) => toAdminDTO(r, EMBEDDING_MODEL_ID)),
        total,
        limit: q.limit,
        offset: q.offset,
        has_more: q.offset + rows.length < total,
      };
    });
  });

  // ═══ POST /admin/api/kb/articles ══════════════════════════════════════
  //
  // Every staff role may create, agents included. A draft is invisible to
  // customers, invisible to all three retrieval strategies and excluded from
  // the embedding corpus, so authoring costs nothing and risks nothing; the
  // gate is on publication, where the consequences are.
  app.post('/admin/api/kb/articles', async (req, reply) => {
    const caller = resolveAdminCaller(req);
    const body = CreateBody.parse(req.body);

    /**
     * ⚠️ THE TENANT COMES FROM THE REQUEST HERE, WHICH IS THE ONE PLACE IT CAN.
     *
     * On every other endpoint in this file the product is read from the stored
     * row and the client's copy is ignored. A create has no stored row yet, so
     * the caller genuinely has to name the tenant — which makes this the single
     * point where an unchecked value would be a cross-tenant write. It is
     * asserted here, and RLS `WITH CHECK` refuses it independently at COMMIT.
     */
    assertTenant(caller, body.product_id);

    // ID_PREFIX.kbArticle === 'kb'; newId takes the prefix value, as seed.ts does.
    const id = newId('kb');

    const created = await withScope(caller.scope, async (tx) => {
      await createArticle(tx, {
        id,
        productId: body.product_id,
        title: body.title,
        body: body.body,
        category: body.category ?? null,
      });

      const row = await findArticleForAdmin(tx, id);
      // Unreachable unless RLS rejected the read of a row it just accepted the
      // write of. Throwing rather than returning a half-built response means a
      // policy change that broke this is a visible 500, not a silent null.
      if (!row) throw notFound('The article was created but is not readable in this scope.');

      await writeAudit(tx, caller.scope, {
        action: 'kb_article.created',
        entityType: 'kb_article',
        entityId: id,
        productId: body.product_id,
        after: { status: 'draft', ...auditShape(row, body.body.length) },
        sourceIp: req.ip,
      });

      return toAdminDTO(row, EMBEDDING_MODEL_ID, true);
    });

    return reply.status(201).send(created);
  });

  // ═══ GET /admin/api/kb/articles/:id ═══════════════════════════════════
  //
  // ⚠️ THIS DOES NOT USE kb.repo.ts:getArticle, AND THAT IS THE POINT.
  //
  // That function increments `views` as a side effect of reading, which is
  // correct for a customer opening an article and wrong for an editor opening
  // one to proofread it. Reusing it would inflate the counter that orders the
  // widget's article list every time someone looked at their own draft.
  app.get<{ Params: { id: string } }>('/admin/api/kb/articles/:id', async (req) => {
    const caller = resolveAdminCaller(req);

    return withScope(caller.scope, async (tx) => {
      const row = await findArticleForAdmin(tx, req.params.id);
      if (!row) throw notFound('No such article is visible to this account.');
      assertTenant(caller, row.product_id);
      return toAdminDTO(row, EMBEDDING_MODEL_ID, true);
    });
  });

  // ═══ PATCH /admin/api/kb/articles/:id ═════════════════════════════════
  app.patch<{ Params: { id: string } }>('/admin/api/kb/articles/:id', async (req) => {
    const caller = resolveAdminCaller(req);
    const body = UpdateBody.parse(req.body);

    return withScope(caller.scope, async (tx) => {
      const row = await findArticleForAdmin(tx, req.params.id);
      if (!row) throw notFound('No such article is visible to this account.');

      /**
       * ⚠️ THE PRODUCT AND THE STATUS BOTH COME FROM THE ROW.
       *
       * Not from the request, and not from anything the client could influence.
       * A client that sent its own `product_id` would be asserting authorization
       * over a tenant it may not hold; a client that sent its own `status` would
       * be choosing which permission rule applies to it. Both are read here from
       * what the database actually holds, inside the transaction that will do
       * the write.
       */
      assertTenant(caller, row.product_id);
      assertCanEditKb(caller.role, row.status);

      const before = auditShape(row, (row.body ?? '').length);
      const title = body.title ?? row.title;
      const nextBody = body.body ?? row.body ?? '';
      // `category` is nullable, so `undefined` (absent) and `null` (clear it)
      // are genuinely different requests and `??` alone would conflate them.
      const category = body.category === undefined ? row.category : (body.category ?? null);

      const ok = await updateArticleText(tx, {
        id: row.id,
        productId: row.product_id,
        title,
        body: nextBody,
        category,
      });
      if (!ok) throw notFound('No such article is visible to this account.');

      const updated = await findArticleForAdmin(tx, row.id);
      if (!updated) throw notFound('No such article is visible to this account.');

      await writeAudit(tx, caller.scope, {
        action: 'kb_article.updated',
        entityType: 'kb_article',
        entityId: row.id,
        productId: row.product_id,
        before,
        after: auditShape(updated, nextBody.length),
        sourceIp: req.ip,
      });

      return toAdminDTO(updated, EMBEDDING_MODEL_ID, true);
    });
  });

  // ═══ PATCH /admin/api/kb/articles/:id/status ══════════════════════════
  //
  // Publish, unpublish, restore and archive are all this one endpoint. What
  // each of them does to the AI pipeline is nothing, explicitly:
  //
  //   published   the row starts matching KB_CORPUS and the embedding corpus
  //               predicate at COMMIT. The next sweep embeds it if its text
  //               has never been embedded; if it has, the fingerprint still
  //               matches and it is already current at no cost.
  //   draft       the row stops matching both, at COMMIT, so it leaves all
  //               three retrieval strategies in the same instant.
  //   archived    identical withdrawal. The vector is NOT cleared: it is
  //               unreachable while the status excludes it, and keeping it
  //               makes a later restore free rather than a billed re-embedding.
  app.patch<{ Params: { id: string } }>('/admin/api/kb/articles/:id/status', async (req) => {
    const caller = resolveAdminCaller(req);
    const body = StatusBody.parse(req.body);

    return withScope(caller.scope, async (tx) => {
      const row = await findArticleForAdmin(tx, req.params.id);
      if (!row) throw notFound('No such article is visible to this account.');

      assertTenant(caller, row.product_id);
      assertCanTransitionKb(caller.role);
      assertKbTransition(row.status, body.status);

      const ok = await updateArticleStatus(tx, {
        id: row.id,
        productId: row.product_id,
        status: body.status,
      });
      if (!ok) throw notFound('No such article is visible to this account.');

      await writeAudit(tx, caller.scope, {
        action: 'kb_article.status_changed',
        entityType: 'kb_article',
        entityId: row.id,
        productId: row.product_id,
        before: { status: row.status },
        after: { status: body.status, title: row.title },
        sourceIp: req.ip,
      });

      const updated = await findArticleForAdmin(tx, row.id);
      if (!updated) throw notFound('No such article is visible to this account.');
      return toAdminDTO(updated, EMBEDDING_MODEL_ID, true);
    });
  });
}
