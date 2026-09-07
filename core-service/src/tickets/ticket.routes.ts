import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  AppError,
  PRODUCT_SETTABLE_STATUSES,
  SEVERITIES,
  TICKET_STATUSES,
  notFound,
  type TicketStatus,
} from '@iris/shared/types';
import { withScope } from '../db/with-scope.js';
import { writeAudit } from '../audit/index.js';
import { emitEvent } from '../events/outbox.js';
import { resolveCaller } from '../http/context.js';
import { assertTransition, effectsFor } from './state-machine.js';
import {
  findTicket,
  insertComment,
  insertTicket,
  listAttachments,
  listComments,
  listTickets,
  setRating,
  updateStatus,
} from './ticket.repo.js';
import { conversationTranscript, markConversationEscalated } from '../widget/ask.service.js';

const CreateBody = z.object({
  product_tenant_id: z.string().min(1).max(200).optional(),
  subject: z.string().max(200).nullish(),
  description: z.string().min(1).max(20_000),
  category: z.string().max(80).nullish(),
  severity: z.enum(SEVERITIES).nullish(),
  conversation_id: z.string().max(80).nullish(),
  /** Set by the Live Chat tile — see ADR-011. */
  from_live_chat: z.boolean().optional(),
  metadata: z.record(z.unknown()).optional(),
});

const CommentBody = z.object({ body: z.string().min(1).max(10_000) });
const StatusBody = z.object({
  status: z.enum(TICKET_STATUSES),
  reason: z.string().max(500).optional(),
});
const RatingBody = z.object({
  rating: z.number().int().min(1).max(5),
  comment: z.string().max(2000).nullish(),
});

export async function ticketRoutes(app: FastifyInstance): Promise<void> {
  // ── POST /v1/tickets ───────────────────────────────────────────────────
  app.post('/v1/tickets', async (req, reply) => {
    const caller = await resolveCaller(req);
    const body = CreateBody.parse(req.body);

    const tenantId = body.product_tenant_id ?? caller.productTenantId;
    if (!tenantId) {
      throw new AppError('invalid_request', 'product_tenant_id is required.');
    }
    if (caller.scope.role === 'raiser' && !caller.scope.raiserRef) {
      throw new AppError('unauthenticated', 'Identity required to raise a ticket.');
    }

    const categories = caller.product.config.categories?.map((c) => c.value);
    if (body.category && categories?.length && !categories.includes(body.category)) {
      throw new AppError('unsupported_category', `Category '${body.category}' is not enabled.`, {
        allowed: categories,
      });
    }

    const ticket = await withScope(caller.scope, async (tx) => {
      let description = body.description;

      // Live Chat stub: fold the conversation transcript into the ticket so the
      // user's context is not lost. ADR-011.
      if (body.conversation_id) {
        const transcript = await conversationTranscript(tx, body.conversation_id);
        if (transcript && body.from_live_chat) {
          description = `${description}\n\n--- Conversation before requesting an agent ---\n${transcript}`;
        }
      }

      const created = await insertTicket(tx, {
        productId: caller.product.id,
        productTenantId: tenantId,
        raisedByRef: caller.scope.raiserRef ?? `anon:${req.id}`,
        raiserIdentity: { name: caller.raiserName, email: caller.raiserEmail },
        identityAssurance: caller.scope.raiserRef ? 'sso' : 'anonymous',
        subject: body.subject ?? null,
        description,
        category: body.category ?? null,
        severity: body.severity ?? null,
        conversationId: body.conversation_id ?? null,
        metadata: body.metadata ?? {},
      });

      if (body.conversation_id) {
        await markConversationEscalated(tx, body.conversation_id, created.id);
      }

      await writeAudit(tx, caller.scope, {
        action: 'ticket.created',
        entityType: 'ticket',
        entityId: created.id,
        after: { status: created.status, reference: created.reference },
        sourceIp: req.ip,
      });
      await emitEvent(
        tx,
        caller.scope,
        'ticket.created',
        { ticket_id: created.id, reference: created.reference },
        'ticket',
        created.id,
      );
      return created;
    });

    return reply.status(201).send(ticket);
  });

  // ── GET /v1/tickets/:id ────────────────────────────────────────────────
  app.get<{ Params: { id: string } }>('/v1/tickets/:id', async (req) => {
    const caller = await resolveCaller(req);
    return withScope(caller.scope, async (tx) => {
      const ticket = await findTicket(tx, req.params.id);
      // RLS already filtered by product scope AND (for raisers) ownership.
      // A miss is indistinguishable from "does not exist" — deliberately.
      if (!ticket) throw notFound();
      const [comments, attachments] = await Promise.all([
        listComments(tx, ticket.id),
        listAttachments(tx, ticket.id),
      ]);
      return { ...ticket, comments, attachments };
    });
  });

  // ── GET /v1/tickets ────────────────────────────────────────────────────
  app.get('/v1/tickets', async (req) => {
    const caller = await resolveCaller(req);
    const q = req.query as Record<string, string | undefined>;
    const csv = (v?: string) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined);

    return withScope(caller.scope, (tx) =>
      listTickets(tx, {
        status: csv(q.status) as TicketStatus[] | undefined,
        category: csv(q.category),
        severity: csv(q.severity) as never,
        productTenantId: q.product_tenant_id,
        // A raiser is already constrained by RLS; this is the readable echo.
        raisedBy: caller.scope.role === 'raiser' ? (caller.scope.raiserRef ?? undefined) : q.raised_by,
        limit: Math.min(Number(q.limit) || 20, 200),
        cursor: q.cursor ?? null,
      }),
    );
  });

  // ── POST /v1/tickets/:id/comments ──────────────────────────────────────
  app.post<{ Params: { id: string } }>('/v1/tickets/:id/comments', async (req, reply) => {
    const caller = await resolveCaller(req);
    const body = CommentBody.parse(req.body);

    const result = await withScope(caller.scope, async (tx) => {
      const ticket = await findTicket(tx, req.params.id);
      if (!ticket) throw notFound();

      const authorType = caller.scope.role === 'raiser' ? 'raiser' : 'system';
      const created = await insertComment(tx, caller.scope, {
        productId: caller.product.id,
        ticketId: ticket.id,
        authorType,
        authorRef: caller.scope.raiserRef ?? null,
        authorName: caller.raiserName ?? (authorType === 'raiser' ? 'You' : caller.product.name),
        body: body.body,
        // A product credential can never author an internal note — internal
        // notes are a support-side concept and are not writable across the
        // boundary.
        isInternal: false,
      });

      await writeAudit(tx, caller.scope, {
        action: 'ticket.comment_added',
        entityType: 'comment',
        entityId: created.id,
        after: { ticket_id: ticket.id },
        sourceIp: req.ip,
      });
      await emitEvent(
        tx,
        caller.scope,
        'ticket.comment_added',
        { ticket_id: ticket.id, comment_id: created.id },
        'ticket',
        ticket.id,
      );

      return { id: created.id, ticket_id: ticket.id, created_at: created.created_at };
    });

    return reply.status(201).send(result);
  });

  // ── PATCH /v1/tickets/:id/status ───────────────────────────────────────
  app.patch<{ Params: { id: string } }>('/v1/tickets/:id/status', async (req) => {
    const caller = await resolveCaller(req);
    const body = StatusBody.parse(req.body);

    // Products and raisers may only close or reopen. Assignment, in_progress
    // and resolve are support-side actions — a product cannot mark its own
    // ticket resolved.
    if (
      (caller.scope.role === 'product' || caller.scope.role === 'raiser') &&
      !PRODUCT_SETTABLE_STATUSES.includes(body.status)
    ) {
      throw new AppError(
        'credential_scope_exceeded',
        `This credential may only set: ${PRODUCT_SETTABLE_STATUSES.join(', ')}.`,
        { allowed: [...PRODUCT_SETTABLE_STATUSES] },
      );
    }

    return withScope(caller.scope, async (tx) => {
      const ticket = await findTicket(tx, req.params.id);
      if (!ticket) throw notFound();

      assertTransition(ticket.status, body.status);
      const now = new Date().toISOString();
      const effects = effectsFor(body.status, now);

      await updateStatus(tx, ticket.id, body.status, effects.stamp);
      await writeAudit(tx, caller.scope, {
        action: 'ticket.status_changed',
        entityType: 'ticket',
        entityId: ticket.id,
        before: { status: ticket.status },
        after: { status: body.status, reason: body.reason ?? null },
        sourceIp: req.ip,
      });
      // Status change + audit + event, one transaction. Either all of it
      // happened or none of it did.
      await emitEvent(
        tx,
        caller.scope,
        effects.event,
        { ticket_id: ticket.id, from: ticket.status, to: body.status },
        'ticket',
        ticket.id,
      );

      const updated = await findTicket(tx, ticket.id);
      return updated!;
    });
  });

  // ── POST /v1/tickets/:id/rating ────────────────────────────────────────
  app.post<{ Params: { id: string } }>('/v1/tickets/:id/rating', async (req) => {
    const caller = await resolveCaller(req);
    const body = RatingBody.parse(req.body);

    return withScope(caller.scope, async (tx) => {
      const ticket = await findTicket(tx, req.params.id);
      if (!ticket) throw notFound();
      if (ticket.status !== 'resolved' && ticket.status !== 'closed') {
        throw new AppError('invalid_state_transition', 'Only a resolved ticket can be rated.', {
          status: ticket.status,
        });
      }

      await setRating(tx, ticket.id, body.rating, body.comment ?? null);
      await writeAudit(tx, caller.scope, {
        action: 'ticket.rated',
        entityType: 'ticket',
        entityId: ticket.id,
        after: { rating: body.rating },
        sourceIp: req.ip,
      });
      await emitEvent(
        tx,
        caller.scope,
        'ticket.rated',
        { ticket_id: ticket.id, rating: body.rating },
        'ticket',
        ticket.id,
      );
      return { ok: true, rating: body.rating };
    });
  });

  // ── GET /v1/tickets/:id/history ────────────────────────────────────────
  app.get<{ Params: { id: string } }>('/v1/tickets/:id/history', async (req) => {
    const caller = await resolveCaller(req);
    return withScope(caller.scope, async (tx) => {
      const ticket = await findTicket(tx, req.params.id);
      if (!ticket) throw notFound();

      const { rows } = await tx.query<{
        action: string;
        actor_type: string;
        actor_ref: string | null;
        after: unknown;
        occurred_at: Date;
      }>(
        `SELECT action, actor_type, actor_ref, after, occurred_at
           FROM audit_event
          WHERE entity_id = $1 OR (entity_type = 'comment' AND after->>'ticket_id' = $1)
          ORDER BY occurred_at ASC`,
        [ticket.id],
      );

      return {
        data: rows.map((r) => ({
          at: r.occurred_at.toISOString(),
          type: r.action,
          actor: { type: r.actor_type, ref: r.actor_ref },
          detail: r.after,
        })),
      };
    });
  });
}
