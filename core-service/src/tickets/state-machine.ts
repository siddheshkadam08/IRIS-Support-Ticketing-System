import { AppError, TRANSITIONS, type TicketStatus } from '@iris/shared/types';

/**
 * The ticket state machine lives here and nowhere else.
 *
 * `assigned` exists because it is the transition that fires the dual JIT
 * access grant (HLD §13). It is not a UI filter chip — see HLD §10.1 — but
 * collapsing it would destroy the access model, so it stays.
 */
export function assertTransition(from: TicketStatus, to: TicketStatus): void {
  const allowed = TRANSITIONS[from];
  if (!allowed.includes(to)) {
    throw new AppError(
      'invalid_state_transition',
      `Cannot move a ticket from '${from}' to '${to}'.`,
      { from, to, allowed: [...allowed] },
    );
  }
}

export interface TransitionEffects {
  /** Timestamp columns to stamp, as column → value. */
  stamp: Partial<Record<'assigned_at' | 'resolved_at' | 'closed_at', string | null>>;
  /** Domain event emitted to the outbox in the same transaction. */
  event: string;
  /** Access grants to issue / revoke once the access module exists. */
  accessAction: 'issue' | 'revoke' | 'reissue' | null;
}

export function effectsFor(to: TicketStatus, now: string): TransitionEffects {
  switch (to) {
    case 'assigned':
      return { stamp: { assigned_at: now }, event: 'ticket.assigned', accessAction: 'issue' };
    case 'in_progress':
      return { stamp: {}, event: 'ticket.in_progress', accessAction: null };
    case 'waiting_on_raiser':
      // SLA clock pauses here; displayed as "On Hold".
      return { stamp: {}, event: 'ticket.waiting_on_raiser', accessAction: null };
    case 'resolved':
      return { stamp: { resolved_at: now }, event: 'ticket.resolved', accessAction: 'revoke' };
    case 'closed':
      // Idempotent re-assert of revoke — the brief says close, we revoke at
      // resolve too, and the second call is a no-op. (HLD §3.5)
      return { stamp: { closed_at: now }, event: 'ticket.closed', accessAction: 'revoke' };
    case 'open':
      return {
        stamp: { resolved_at: null, closed_at: null },
        event: 'ticket.reopened',
        accessAction: 'reissue',
      };
    default:
      return { stamp: {}, event: 'ticket.updated', accessAction: null };
  }
}
