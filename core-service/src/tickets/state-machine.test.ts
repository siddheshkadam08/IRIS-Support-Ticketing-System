import { describe, expect, it } from 'vitest';
import { AppError, TICKET_STATUSES, canTransition, type TicketStatus } from '@iris/shared/types';
import { assertTransition, effectsFor } from './state-machine.js';

describe('ticket state machine', () => {
  it('allows the documented happy path', () => {
    const path: TicketStatus[] = ['open', 'assigned', 'in_progress', 'resolved', 'closed'];
    for (let i = 0; i < path.length - 1; i++) {
      expect(() => assertTransition(path[i]!, path[i + 1]!)).not.toThrow();
    }
  });

  it('rejects open → resolved and reports the legal set', () => {
    try {
      assertTransition('open', 'resolved');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      const e = err as AppError;
      expect(e.code).toBe('invalid_state_transition');
      expect(e.status).toBe(409);
      expect(e.details?.allowed).toEqual(['assigned', 'closed']);
    }
  });

  it('supports reopen from both resolved and closed', () => {
    expect(canTransition('resolved', 'open')).toBe(true);
    expect(canTransition('closed', 'open')).toBe(true);
  });

  it('pauses and resumes via waiting_on_raiser', () => {
    expect(canTransition('in_progress', 'waiting_on_raiser')).toBe(true);
    expect(canTransition('waiting_on_raiser', 'in_progress')).toBe(true);
  });

  it('never allows a transition to a status that is not defined', () => {
    for (const from of TICKET_STATUSES) {
      for (const to of TICKET_STATUSES) {
        if (!canTransition(from, to)) {
          expect(() => assertTransition(from, to)).toThrow();
        }
      }
    }
  });

  it('has no self-transitions', () => {
    for (const s of TICKET_STATUSES) expect(canTransition(s, s)).toBe(false);
  });
});

describe('transition effects', () => {
  const now = '2026-07-26T10:00:00.000Z';

  it('assignment issues access and stamps assigned_at', () => {
    const e = effectsFor('assigned', now);
    expect(e.accessAction).toBe('issue');
    expect(e.stamp.assigned_at).toBe(now);
    expect(e.event).toBe('ticket.assigned');
  });

  it('resolve revokes access — not close', () => {
    expect(effectsFor('resolved', now).accessAction).toBe('revoke');
    expect(effectsFor('resolved', now).stamp.resolved_at).toBe(now);
  });

  it('close re-asserts revoke idempotently', () => {
    expect(effectsFor('closed', now).accessAction).toBe('revoke');
  });

  it('reopen re-issues access and clears the terminal timestamps', () => {
    const e = effectsFor('open', now);
    expect(e.accessAction).toBe('reissue');
    expect(e.stamp.resolved_at).toBeNull();
    expect(e.stamp.closed_at).toBeNull();
  });
});
