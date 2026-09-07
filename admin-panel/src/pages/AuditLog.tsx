import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { Card, Empty, PageFooter, PageFooter as _F, Spinner } from '../components/ui';
import { ACTION_LABEL, absTime } from '../lib/labels';

/**
 * The audit trail is append-only at the database — UPDATE and DELETE are
 * revoked from the application role, so a compromised application cannot
 * rewrite what is shown here.
 */
export default function AuditLog() {
  const [action, setAction] = useState('');
  const [entity, setEntity] = useState('');

  const qs = new URLSearchParams();
  if (action) qs.set('action', action);
  if (entity) qs.set('entity_type', entity);
  qs.set('limit', '150');

  const { data, isLoading } = useQuery({
    queryKey: ['audit', qs.toString()],
    queryFn: () => api.audit(qs.toString()),
  });

  return (
    <>
      <div className="filters">
        <input className="input" placeholder="Action contains…" value={action}
               onChange={(e) => setAction(e.target.value)} />
        <select className="select" value={entity} onChange={(e) => setEntity(e.target.value)}>
          <option value="">All entities</option>
          <option value="ticket">Ticket</option>
          <option value="comment">Comment</option>
          <option value="support_user">Support user</option>
          <option value="product">Tenant</option>
          <option value="attachment">Attachment</option>
        </select>
        {action || entity ? (
          <button className="btn btn-ghost btn-sm" onClick={() => { setAction(''); setEntity(''); }}>
            Clear
          </button>
        ) : null}
      </div>

      {isLoading ? (
        <Spinner />
      ) : !data?.data.length ? (
        <Empty title="No matching audit entries" />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>When</th><th>Actor</th><th>Action</th><th>Entity</th><th>Detail</th><th>Request</th></tr>
            </thead>
            <tbody>
              {data.data.map((a, i) => {
                const r = a as Record<string, string | null>;
                return (
                  <tr key={String(r.id ?? i)}>
                    <td style={{ whiteSpace: 'nowrap', color: 'var(--muted)', fontSize: 12 }}>
                      {absTime(r.occurred_at ?? null)}
                    </td>
                    <td>
                      <div style={{ fontSize: 12.5 }}>{r.actor_name ?? r.actor_ref ?? '—'}</div>
                      <div style={{ fontSize: 10.5, color: 'var(--muted)' }}>{r.actor_type}</div>
                    </td>
                    <td style={{ fontWeight: 600, fontSize: 12.5 }}>
                      {ACTION_LABEL[r.action ?? ''] ?? r.action}
                    </td>
                    <td style={{ fontSize: 12 }}>
                      {r.entity_type}
                      {r.entity_id ? (
                        <div className="mono" style={{ fontSize: 10.5, color: 'var(--muted)' }}>
                          {String(r.entity_id).slice(0, 20)}
                        </div>
                      ) : null}
                    </td>
                    <td className="truncate" style={{ fontSize: 11.5, color: 'var(--muted)' }}>
                      {(a as Record<string, unknown>).after
                        ? JSON.stringify((a as Record<string, unknown>).after)
                        : '—'}
                    </td>
                    <td className="mono" style={{ fontSize: 10.5, color: 'var(--muted)' }}>
                      {String(r.request_id ?? '').slice(0, 14)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <Card style={{ marginTop: 14 }}>
        <div style={{ fontSize: 12.5, color: 'var(--ink-soft)', lineHeight: 1.6 }}>
          This log is <strong>append-only, enforced by the database</strong> — <span className="mono">UPDATE</span>{' '}
          and <span className="mono">DELETE</span> are revoked from the application role, so history
          cannot be rewritten even if the application were fully compromised.
        </div>
      </Card>
      <PageFooter />
    </>
  );
}
