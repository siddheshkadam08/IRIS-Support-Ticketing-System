import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type Delivery, type Grant, type TicketDetail as TDetail } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { Banner, Card, Empty, PageFooter, Pill, Spinner, TenantChip } from '../components/ui';
import { ACTION_LABEL, absTime, relTime } from '../lib/labels';

/**
 * The highest-value screen in the portal.
 *
 * One timeline merges state transitions, comments, internal notes and — the
 * part nothing else shows — access grant/revoke events with the integrating
 * product's ACTUAL response bodies and latencies. That is what makes the
 * access cycle auditable rather than asserted.
 */
export default function TicketDetail() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const qc = useQueryClient();
  const { me, can, tenantColor } = useAuth();
  const [reply, setReply] = useState('');
  const [internal, setInternal] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const { data: ticket, isLoading } = useQuery({
    queryKey: ['ticket', id],
    queryFn: () => api.ticket(id!),
    enabled: Boolean(id),
    refetchInterval: 10_000,
  });

  const { data: users } = useQuery({ queryKey: ['users'], queryFn: api.users });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['ticket', id] });
    void qc.invalidateQueries({ queryKey: ['tickets'] });
    void qc.invalidateQueries({ queryKey: ['dashboard'] });
  };

  const assign = useMutation({
    mutationFn: (userId: string) => api.assign(id!, userId),
    onSuccess: invalidate,
    onError: (e: Error) => setErr(e.message),
  });
  const setStatus = useMutation({
    mutationFn: (status: string) => api.setStatus(id!, status),
    onSuccess: invalidate,
    onError: (e: Error) => setErr(e.message),
  });
  const comment = useMutation({
    mutationFn: () => api.comment(id!, reply, internal),
    onSuccess: () => {
      setReply('');
      setInternal(false);
      invalidate();
    },
    onError: (e: Error) => setErr(e.message),
  });

  if (isLoading) return <Spinner />;
  if (!ticket) return <Empty title="Ticket not found">It may belong to a tenant you cannot see.</Empty>;

  const failedRevoke = ticket.grants.find((g) => g.state === 'revoke_failed');
  const nextStatuses = allowedNext(ticket.status);

  return (
    <>
      {/* A dead-lettered revoke means access may outlive the ticket. It is a
          security incident, so it goes first and it is red. */}
      {failedRevoke ? (
        <Banner kind="err">
          <strong>Access revoke failed.</strong> The integrating product did not confirm revocation
          after all retries, so access may still be live on their side. Grant{' '}
          <span className="mono">{failedRevoke.id}</span> — {failedRevoke.last_error}
        </Banner>
      ) : null}

      {err ? <Banner kind="err">{err}</Banner> : null}

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <button className="btn btn-ghost btn-sm" onClick={() => nav(-1)}>← Back</button>
        <span className="mono" style={{ fontSize: 15, fontWeight: 700 }}>{ticket.reference}</span>
        <Pill kind="status" value={ticket.status} />
        {ticket.severity ? <Pill kind="severity" value={ticket.severity} /> : null}
        <TenantChip name={ticket.tenant?.name ?? null} color={tenantColor(ticket.tenant?.id ?? null)} />
      </div>

      <div className="detail-grid">
        <div>
          <Card style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 16, fontWeight: 650, marginBottom: 6 }}>
              {ticket.subject || 'Support request'}
            </div>
            <div style={{ fontSize: 13, color: 'var(--ink-soft)', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
              {ticket.description}
            </div>
          </Card>

          {/* When an agent has no grant, say why rather than showing an empty
              panel that reads like a bug. */}
          {!ticket.access.has_platform_grant ? (
            <Banner kind="warn">
              <strong>Details hidden — no active access grant.</strong> {ticket.access.reason}
              {' '}Support users hold zero standing access to ticket data; assignment grants it and
              resolving revokes it.
            </Banner>
          ) : null}

          <Card title="Activity" style={{ marginBottom: 14 }}>
            <Timeline ticket={ticket} />
          </Card>

          {ticket.access.has_platform_grant ? (
            <Card title="Reply">
              <textarea
                className="textarea"
                value={reply}
                onChange={(e) => setReply(e.target.value)}
                placeholder={internal ? 'Internal note — never sent to the customer' : 'Reply to the customer…'}
              />
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 10, flexWrap: 'wrap' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}>
                  <input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} />
                  Internal note
                </label>
                <div className="spacer" />
                <button
                  className="btn"
                  disabled={!reply.trim() || comment.isPending}
                  onClick={() => comment.mutate()}
                >
                  {comment.isPending ? 'Sending…' : internal ? 'Add note' : 'Send reply'}
                </button>
              </div>
              {internal ? (
                <div className="hint">
                  Internal notes are filtered out of every product-facing response at the database,
                  not just in this UI.
                </div>
              ) : null}
            </Card>
          ) : null}
        </div>

        <div>
          <Card title="Details" style={{ marginBottom: 14 }}>
            <dl className="kv">
              <dt>Raised by</dt>
              <dd>{ticket.raised_by.name ?? ticket.raised_by.ref}</dd>
              <dt>Raised</dt>
              <dd title={absTime(ticket.raised_at)}>{relTime(ticket.raised_at)}</dd>
              <dt>Category</dt>
              <dd>{ticket.category ?? '—'}</dd>
              <dt>Assignee</dt>
              <dd>{ticket.assignee?.display_name ?? <span style={{ color: 'var(--muted)' }}>Unassigned</span>}</dd>
              {ticket.rating ? (<><dt>Rating</dt><dd>{'★'.repeat(ticket.rating)}</dd></>) : null}
            </dl>
          </Card>

          <Card title="Assignment" style={{ marginBottom: 14 }}>
            {can('super_admin', 'product_admin', 'manager') ? (
              <select
                className="select"
                value={ticket.assignee?.id ?? ''}
                onChange={(e) => e.target.value && assign.mutate(e.target.value)}
              >
                <option value="">Assign to…</option>
                {users?.data
                  .filter((u) => u.role !== 'super_admin')
                  .map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.display_name} ({u.open_tickets} open)
                    </option>
                  ))}
              </select>
            ) : ticket.assignee?.id === me?.id ? (
              <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>Assigned to you.</div>
            ) : (
              <button
                className="btn"
                style={{ width: '100%' }}
                disabled={assign.isPending}
                onClick={() => me && assign.mutate(me.id)}
              >
                {assign.isPending ? 'Assigning…' : 'Assign to me'}
              </button>
            )}
            <div className="hint">
              Assignment issues a just-in-time access grant on both layers. Resolving revokes them.
            </div>
          </Card>

          {nextStatuses.length ? (
            <Card title="Move to" style={{ marginBottom: 14 }}>
              <div className="btn-row">
                {nextStatuses.map((s) => (
                  <button
                    key={s.value}
                    className="btn btn-ghost btn-sm"
                    disabled={setStatus.isPending}
                    onClick={() => setStatus.mutate(s.value)}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            </Card>
          ) : null}

          <Card title={`Access grants (${ticket.grants.length})`}>
            {ticket.grants.length === 0 ? (
              <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>
                None yet. Grants are issued on assignment.
              </div>
            ) : (
              ticket.grants.map((g) => <GrantCard key={g.id} grant={g} deliveries={ticket.deliveries} />)
            )}
          </Card>
        </div>
      </div>
      <PageFooter />
    </>
  );
}

function GrantCard({ grant, deliveries }: { grant: Grant; deliveries: Delivery[] }) {
  const failed = grant.state.endsWith('_failed');
  const response = grant.revoke_response ?? grant.activation_response;
  const attempts = deliveries.filter((d) => d.channel === 'access_callback');

  return (
    <div className={`grant-row ${failed ? 'failed' : ''}`}>
      <div className="grant-head">
        <span className="grant-layer">
          {grant.layer === 'platform' ? 'T1 · platform' : 'T2 · product'}
        </span>
        <Pill kind="grant" value={grant.state} />
      </div>
      <div style={{ color: 'var(--muted)', marginBottom: 4 }}>
        {grant.mechanism === 'rls'
          ? 'Enforced by row-level security — no network call'
          : `Relayed via ${grant.mechanism.replace('_', ' ')}`}
      </div>
      <div style={{ fontSize: 12 }}>
        {grant.support_user_name ?? grant.support_user_id} · granted {relTime(grant.granted_at)}
        {grant.revoked_at ? ` · revoked ${relTime(grant.revoked_at)}` : ''}
      </div>
      {grant.product_grant_ref ? (
        <div style={{ fontSize: 11.5, marginTop: 4 }}>
          Product reference <span className="mono">{grant.product_grant_ref}</span>
        </div>
      ) : null}
      {grant.last_error ? (
        <div style={{ fontSize: 11.5, marginTop: 5, color: 'var(--danger)' }}>{grant.last_error}</div>
      ) : null}
      {/* The product's own words, verbatim — this is the audit evidence. */}
      {response ? <pre className="resp">{JSON.stringify(response)}</pre> : null}
      {grant.layer === 'product' && attempts.length ? (
        <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 5 }}>
          {attempts.length} delivery attempt{attempts.length === 1 ? '' : 's'} ·{' '}
          last {attempts[attempts.length - 1]!.status_code ?? 'network error'} in{' '}
          {attempts[attempts.length - 1]!.latency_ms}ms
        </div>
      ) : null}
    </div>
  );
}

/** Merges comments and audit events into one chronological story. */
function Timeline({ ticket }: { ticket: TDetail }) {
  type Item = { at: string; kind: 'comment' | 'event'; node: React.ReactNode; tone?: string };
  const items: Item[] = [];

  for (const c of ticket.comments) {
    items.push({
      at: c.created_at,
      kind: 'comment',
      tone: 'comment',
      node: (
        <div className={c.is_internal ? 'note-internal' : undefined}>
          <div className="tl-head">
            <span className="tl-title">{c.author_name ?? (c.author_type === 'raiser' ? 'Customer' : 'Support')}</span>
            <span className="tl-time">{relTime(c.created_at)}</span>
          </div>
          <div className="tl-body">{c.body}</div>
        </div>
      ),
    });
  }

  for (const h of ticket.history) {
    const isAccess = h.type.startsWith('access.');
    items.push({
      at: h.at,
      kind: 'event',
      tone: h.type === 'access.revoked' ? 'access' : isAccess ? 'access' : undefined,
      node: (
        <>
          <div className="tl-head">
            <span className="tl-title">{ACTION_LABEL[h.type] ?? h.type}</span>
            <span className="tl-time" title={absTime(h.at)}>{relTime(h.at)}</span>
          </div>
          {h.after ? (
            <div className="tl-body" style={{ fontSize: 12, color: 'var(--muted)' }}>
              {summarise(h.type, h.after)}
            </div>
          ) : null}
        </>
      ),
    });
  }

  items.sort((a, b) => a.at.localeCompare(b.at));
  if (!items.length) return <Empty title="No activity yet" />;

  return (
    <div className="timeline">
      {items.map((it, i) => (
        <div className="tl-item" key={i}>
          <div className={`tl-dot ${it.tone ?? ''}`} />
          {it.node}
        </div>
      ))}
    </div>
  );
}

function summarise(type: string, after: unknown): string {
  const a = after as Record<string, unknown>;
  if (type === 'ticket.status_changed') return `→ ${String(a.status)}`;
  if (type === 'ticket.assigned') return `→ ${String(a.assignee ?? '')}`;
  if (type === 'access.granted') {
    return `${(a.layers as string[] | undefined)?.join(' + ') ?? ''} via ${String(a.mechanism ?? '')}`;
  }
  if (type === 'access.revoked') return `${String(a.grants_revoked ?? 0)} grant(s) revoked · ${String(a.reason ?? '')}`;
  return '';
}

function allowedNext(status: string): Array<{ value: string; label: string }> {
  const map: Record<string, Array<{ value: string; label: string }>> = {
    assigned: [
      { value: 'in_progress', label: 'Start work' },
      { value: 'resolved', label: 'Resolve' },
    ],
    in_progress: [
      { value: 'waiting_on_raiser', label: 'Put on hold' },
      { value: 'resolved', label: 'Resolve' },
    ],
    waiting_on_raiser: [
      { value: 'in_progress', label: 'Resume' },
      { value: 'resolved', label: 'Resolve' },
    ],
    resolved: [
      { value: 'closed', label: 'Close' },
      { value: 'open', label: 'Reopen' },
    ],
    closed: [{ value: 'open', label: 'Reopen' }],
    open: [{ value: 'closed', label: 'Close' }],
  };
  return map[status] ?? [];
}
