import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError, SEVERITIES, TICKET_STATUSES, notFound, type TicketStatus } from '@iris/shared/types';
import { withScope } from '../db/with-scope.js';
import { writeAudit } from '../audit/index.js';
import { emitEvent } from '../events/outbox.js';
import { assertTransition, effectsFor } from '../tickets/state-machine.js';
import {
  findTicket,
  insertComment,
  listAttachments,
  listTickets,
  updateStatus,
} from '../tickets/ticket.repo.js';
import { deliveriesForTicket, grantsForTicket, issueGrants, revokeGrants } from '../access/grant.service.js';
import { findSimilar } from '../tickets/similar.service.js';
import { draftReply } from '../tickets/copilot.service.js';
import { config } from '../config.js';
import { assertTenant, requireRole, resolveAdminCaller } from './admin.context.js';

const AssignBody = z.object({ support_user_id: z.string().min(1) });
const StatusBody = z.object({
  status: z.enum(TICKET_STATUSES),
  reason: z.string().max(500).optional(),
});
const CommentBody = z.object({
  body: z.string().min(1).max(10_000),
  is_internal: z.boolean().default(false),
});

export async function adminTicketRoutes(app: FastifyInstance): Promise<void> {
  // ── GET /admin/tickets ─────────────────────────────────────────────────
  app.get('/admin/api/tickets', async (req) => {
    const caller = resolveAdminCaller(req);
    const q = req.query as Record<string, string | undefined>;
    const csv = (v?: string) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined);

    return withScope(caller.scope, async (tx) => {
      const page = await listTickets(tx, {
        status: csv(q.status) as TicketStatus[] | undefined,
        category: csv(q.category),
        severity: csv(q.severity) as never,
        productTenantId: q.product_tenant_id,
        raisedBy: q.raised_by,
        limit: Math.min(Number(q.limit) || 25, 200),
        cursor: q.cursor ?? null,
      });

      // Which tenant each ticket belongs to — the cross-tenant list needs it.
      const { rows } = await tx.query<{ id: string; product_id: string; product_name: string }>(
        `SELECT t.id, t.product_id, p.name AS product_name
           FROM ticket t JOIN product p ON p.id = t.product_id
          WHERE t.id = ANY($1::text[])`,
        [page.data.map((t) => t.id)],
      );
      const tenantById = new Map(rows.map((r) => [r.id, r]));

      return {
        ...page,
        data: page.data.map((t) => ({
          ...t,
          tenant: {
            id: tenantById.get(t.id)?.product_id ?? null,
            name: tenantById.get(t.id)?.product_name ?? null,
          },
        })),
      };
    });
  });

  // ── GET /admin/tickets/:id ─────────────────────────────────────────────
  app.get<{ Params: { id: string } }>('/admin/api/tickets/:id', async (req) => {
    const caller = resolveAdminCaller(req);

    return withScope(caller.scope, async (tx) => {
      const ticket = await findTicket(tx, req.params.id);
      if (!ticket) throw notFound();

      // Comments and attachments are RLS-gated: an agent sees them only with
      // an active grant. Absence here is the zero-standing-access model
      // working, not an error.
      const [comments, attachments, grants, deliveries] = await Promise.all([
        adminComments(tx, ticket.id),
        listAttachments(tx, ticket.id),
        grantsForTicket(tx, ticket.id),
        deliveriesForTicket(tx, ticket.id),
      ]);

      const { rows: audit } = await tx.query<{
        action: string;
        actor_type: string;
        actor_ref: string | null;
        before: unknown;
        after: unknown;
        occurred_at: Date;
      }>(
        `SELECT action, actor_type, actor_ref, before, after, occurred_at
           FROM audit_event
          WHERE entity_id = $1 OR after->>'ticket_id' = $1
          ORDER BY occurred_at ASC`,
        [ticket.id],
      );

      const hasGrant =
        caller.isSuper ||
        caller.role === 'product_admin' ||
        caller.role === 'manager' ||
        grants.some(
          (g) => g.layer === 'platform' && g.state === 'granted' && g.support_user_id === caller.userId,
        );

      // Detail must carry the same `tenant` shape as the list. Omitting it
      // here made every consumer special-case one endpoint.
      const { rows: tenantRows } = await tx.query<{ product_id: string; name: string }>(
        `SELECT t.product_id, p.name
           FROM ticket t JOIN product p ON p.id = t.product_id
          WHERE t.id = $1`,
        [ticket.id],
      );

      /**
       * Phase 4: the AI's own record of how it classified this ticket.
       *
       * Read HERE rather than added to TicketDTO on purpose. That DTO is the
       * product-facing /v1 contract, and model output — rationale, sentiment,
       * per-field confidences — is internal triage material for support staff,
       * not something to start returning to every integrating product as a
       * side effect of a UI change.
       */
      const { rows: aiRows } = await tx.query<{ ai_classification: unknown }>(
        `SELECT ai_classification FROM ticket WHERE id = $1`,
        [ticket.id],
      );

      return {
        ...ticket,
        ai_classification: aiRows[0]?.ai_classification ?? null,
        tenant: {
          id: tenantRows[0]?.product_id ?? null,
          name: tenantRows[0]?.name ?? null,
        },
        comments,
        attachments,
        grants,
        deliveries,
        history: audit.map((a) => ({
          at: a.occurred_at.toISOString(),
          type: a.action,
          actor: { type: a.actor_type, ref: a.actor_ref },
          before: a.before,
          after: a.after,
        })),
        // Lets the UI explain *why* the payload is hidden instead of showing
        // a confusing empty panel.
        access: {
          has_platform_grant: hasGrant,
          reason: hasGrant ? null : 'Assign this ticket to yourself to view its full details.',
        },
      };
    });
  });

  // ── POST /admin/tickets/:id/assign ─────────────────────────────────────
  // The transition that fires the dual JIT grant.
  // ── GET /admin/tickets/:id/similar ─────────────────────────────────────
  //
  // "Have we seen this before, and what happened?"
  //
  // ⚠️ READ-ONLY. No write, no state transition, no audit event — nothing
  // auditable happened. Fabricating one to make the feature look governed
  // would put noise into an append-only compliance log.
  //
  // Scope comes from `caller.scope` as every admin route does, and the
  // PRODUCT comes from the ticket row itself — a caller cannot name a product,
  // so cannot ask for similarity inside someone else's.
  app.get<{ Params: { id: string } }>('/admin/api/tickets/:id/similar', async (req) => {
    const caller = resolveAdminCaller(req);
    const q = req.query as Record<string, string | undefined>;
    const limit = Number(q.limit) || undefined;

    return withScope(caller.scope, async (tx) => {
      const result = await findSimilar(tx, {
        ticketId: req.params.id,
        limit,
        requestId: caller.scope.requestId,
        // Optional narrowing for a genuinely tenant-bound caller. Omitted for
        // support staff, who serve the whole product — matching the behaviour
        // of GET /admin/api/tickets above.
        productTenantId: q.product_tenant_id ?? null,
      });

      // null means the ticket is not visible under this scope. 404 rather than
      // 403, so an unauthorized id cannot be used to probe for existence.
      if (!result) throw notFound();

      /**
       * Bounded, non-sensitive diagnostics. NOT LOGGED: ticket text, resolution
       * text, references, or any customer content.
       */
      req.log.info(
        { request_id: caller.scope.requestId, ...result.diagnostics },
        'similar tickets',
      );

      return result;
    });
  });

  app.post<{ Params: { id: string } }>('/admin/api/tickets/:id/assign', async (req) => {
    const caller = resolveAdminCaller(req);
    const body = AssignBody.parse(req.body);

    return withScope(caller.scope, async (tx) => {
      const ticket = await findTicket(tx, req.params.id);
      if (!ticket) throw notFound();

      const { rows: prodRows } = await tx.query<{
        id: string;
        access_mechanism: 'callback' | 'preauth' | 'both';
        access_callback_url: string | null;
        config: { access?: { max_ttl_seconds?: number; scope_kind?: string } };
      }>(
        `SELECT p.id, p.access_mechanism, p.access_callback_url, p.config
           FROM product p JOIN ticket t ON t.product_id = p.id
          WHERE t.id = $1`,
        [ticket.id],
      );
      const product = prodRows[0];
      if (!product) throw notFound();
      assertTenant(caller, product.id);

      // An agent may self-assign; assigning someone else needs a manager.
      if (caller.role === 'agent' && body.support_user_id !== caller.userId) {
        throw new AppError('forbidden', 'Agents may only assign tickets to themselves.');
      }

      // The assignee must actually be scoped to this tenant.
      const { rows: scopeRows } = await tx.query<{ ok: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM support_user u
            LEFT JOIN support_user_scope s ON s.support_user_id = u.id
            WHERE u.id = $1 AND u.is_active = true
              AND (u.role = 'super_admin' OR s.product_id = $2)
         ) AS ok`,
        [body.support_user_id, product.id],
      );
      if (!scopeRows[0]?.ok) {
        throw new AppError('invalid_request', 'That user is not assigned to this tenant.');
      }

      if (ticket.status !== 'assigned') assertTransition(ticket.status, 'assigned');
      const now = new Date().toISOString();
      const effects = effectsFor('assigned', now);

      await tx.query(
        `UPDATE ticket SET assignee_id = $2, status = 'assigned',
                           assigned_at = COALESCE(assigned_at, now()), updated_at = now()
          WHERE id = $1`,
        [ticket.id, body.support_user_id],
      );

      // Grants, audit and the outbox event all commit with the status change.
      const grants = await issueGrants(tx, caller.scope, {
        productId: product.id,
        ticketId: ticket.id,
        ticketReference: ticket.reference,
        supportUserId: body.support_user_id,
        product,
      });

      await writeAudit(tx, caller.scope, {
        action: 'ticket.assigned',
        entityType: 'ticket',
        entityId: ticket.id,
        before: { status: ticket.status, assignee: ticket.assignee?.id ?? null },
        after: { status: 'assigned', assignee: body.support_user_id },
        sourceIp: req.ip,
      });
      await emitEvent(
        tx,
        caller.scope,
        effects.event,
        { ticket_id: ticket.id, assignee_id: body.support_user_id },
        'ticket',
        ticket.id,
      );

      return { ...(await findTicket(tx, ticket.id))!, grants };
    });
  });

  // ── PATCH /admin/tickets/:id/status ────────────────────────────────────
  app.patch<{ Params: { id: string } }>('/admin/api/tickets/:id/status', async (req) => {
    const caller = resolveAdminCaller(req);
    const body = StatusBody.parse(req.body);

    return withScope(caller.scope, async (tx) => {
      const ticket = await findTicket(tx, req.params.id);
      if (!ticket) throw notFound();

      assertTransition(ticket.status, body.status);
      const now = new Date().toISOString();
      const effects = effectsFor(body.status, now);

      await updateStatus(tx, ticket.id, body.status, effects.stamp);

      // Resolve revokes both layers. Close re-asserts idempotently.
      if (effects.accessAction === 'revoke') {
        await revokeGrants(tx, caller.scope, { ticketId: ticket.id, reason: body.status });
      }

      await writeAudit(tx, caller.scope, {
        action: 'ticket.status_changed',
        entityType: 'ticket',
        entityId: ticket.id,
        before: { status: ticket.status },
        after: { status: body.status, reason: body.reason ?? null },
        sourceIp: req.ip,
      });
      await emitEvent(
        tx,
        caller.scope,
        effects.event,
        { ticket_id: ticket.id, from: ticket.status, to: body.status },
        'ticket',
        ticket.id,
      );

      return (await findTicket(tx, ticket.id))!;
    });
  });

  // ── POST /admin/tickets/:id/copilot/draft ──────────────────────────────
  //
  // ⚠️ THIS DOES NOT SEND ANYTHING, AND CANNOT.
  //
  // It returns draft text to the agent's browser. Creating a customer-facing
  // comment is POST /admin/api/tickets/:id/comments below — a different
  // endpoint, requiring the same authenticated support user to act again. This
  // route writes no comment, changes no ticket state, and persists no draft.
  //
  // POST rather than GET because it is not cacheable and it spends money on a
  // provider call; it is still read-only with respect to IRIS state.
  app.post<{ Params: { id: string } }>('/admin/api/tickets/:id/copilot/draft', async (req) => {
    const caller = resolveAdminCaller(req);
    if (!config.COPILOT_ENABLED) {
      throw new AppError('copilot_disabled', 'Copilot is not enabled for this deployment.');
    }

    return withScope(caller.scope, async (tx) => {
      const result = await draftReply(tx, {
        ticketId: req.params.id,
        requestId: caller.scope.requestId,
      });

      // null means the ticket is not visible under this scope. 404 rather than
      // 403, so an unauthorized id cannot be used to probe for existence.
      if (!result) throw notFound();

      /**
       * ⚠️ AUDITED, unlike the Phase 14 similar-tickets read.
       *
       * Nothing changed in IRIS, so this is not a state transition — but the
       * ticket's text was sent to a third-party provider and content was
       * generated that a human may put in front of a customer. That is worth a
       * durable record even though no row changed, and it is the provenance
       * trail for "where did this reply come from?".
       *
       * METADATA ONLY. Never the draft, the ticket body or any evidence text.
       * Attached to the ticket so it appears in that ticket's history, which is
       * where someone would look.
       */
      await writeAudit(tx, caller.scope, {
        action: 'ai.copilot_drafted',
        entityType: 'ticket',
        entityId: req.params.id,
        after: {
          outcome: result.outcome,
          kb_evidence: result.diagnostics.kb_evidence,
          historical_evidence: result.diagnostics.historical_evidence,
          citations: result.citations.length,
          draft_chars: result.draft?.length ?? 0,
          model: result.diagnostics.model,
          prompt_version: result.diagnostics.prompt_version,
        },
        sourceIp: req.ip,
      });

      req.log.info(
        { request_id: caller.scope.requestId, outcome: result.outcome, ...result.diagnostics },
        'copilot draft',
      );

      return result;
    });
  });

  // ── POST /admin/tickets/:id/comments ───────────────────────────────────
  app.post<{ Params: { id: string } }>('/admin/api/tickets/:id/comments', async (req, reply) => {
    const caller = resolveAdminCaller(req);
    const body = CommentBody.parse(req.body);

    const result = await withScope(caller.scope, async (tx) => {
      const ticket = await findTicket(tx, req.params.id);
      if (!ticket) throw notFound();

      const created = await insertComment(tx, caller.scope, {
        productId: (await productIdFor(tx, ticket.id))!,
        ticketId: ticket.id,
        authorType: 'assignee',
        authorRef: caller.userId,
        authorName: null,
        body: body.body,
        isInternal: body.is_internal,
      });

      await writeAudit(tx, caller.scope, {
        action: body.is_internal ? 'ticket.internal_note_added' : 'ticket.comment_added',
        entityType: 'comment',
        entityId: created.id,
        after: { ticket_id: ticket.id, is_internal: body.is_internal },
        sourceIp: req.ip,
      });
      // Internal notes never leave the platform — no outbound event.
      if (!body.is_internal) {
        await emitEvent(
          tx,
          caller.scope,
          'ticket.comment_added',
          { ticket_id: ticket.id, comment_id: created.id },
          'ticket',
          ticket.id,
        );
      }
      return created;
    });

    return reply.status(201).send(result);
  });
}

/** Admin view includes internal notes; the product-facing one never does. */
async function adminComments(tx: import('../db/with-scope.js').Tx, ticketId: string) {
  const { rows } = await tx.query<{
    id: string;
    author_type: string;
    author_name: string | null;
    author_ref: string | null;
    body: string;
    is_internal: boolean;
    created_at: Date;
  }>(
    `SELECT c.id, c.author_type, c.author_ref, c.body, c.is_internal, c.created_at,
            COALESCE(c.author_name, u.display_name) AS author_name
       FROM comment c
       LEFT JOIN support_user u ON u.id = c.author_ref
      WHERE c.ticket_id = $1
      ORDER BY c.created_at ASC`,
    [ticketId],
  );
  return rows.map((r) => ({ ...r, created_at: r.created_at.toISOString() }));
}

async function productIdFor(tx: import('../db/with-scope.js').Tx, ticketId: string) {
  const { rows } = await tx.query<{ product_id: string }>(
    `SELECT product_id FROM ticket WHERE id = $1`,
    [ticketId],
  );
  return rows[0]?.product_id ?? null;
}
