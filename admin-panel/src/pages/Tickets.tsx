import { useSearchParams, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { Empty, PageFooter, Pill, Spinner, TenantChip } from '../components/ui';
import { SEVERITY_COLUMN_LABEL, STATUS_FILTERS, relTime } from '../lib/labels';

export default function Tickets() {
  const [params, setParams] = useSearchParams();
  const nav = useNavigate();
  const { me, tenantColor } = useAuth();

  const qs = params.toString();
  const { data, isLoading } = useQuery({
    queryKey: ['tickets', qs],
    queryFn: () => api.tickets(qs ? `${qs}&limit=50` : 'limit=50'),
  });

  const set = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next);
  };

  return (
    <>
      <div className="filters">
        <select className="select" value={params.get('status') ?? ''} onChange={(e) => set('status', e.target.value)}>
          <option value="">All statuses</option>
          {STATUS_FILTERS.map((s) => (
            <option key={s.value} value={s.value}>{s.label}</option>
          ))}
        </select>
        <select className="select" value={params.get('severity') ?? ''} onChange={(e) => set('severity', e.target.value)}>
          <option value="">All priorities</option>
          <option value="critical">Critical</option>
          <option value="high">High</option>
          <option value="medium">Medium</option>
          <option value="low">Low</option>
        </select>
        <input
          className="input"
          placeholder="Customer tenant…"
          defaultValue={params.get('product_tenant_id') ?? ''}
          onBlur={(e) => set('product_tenant_id', e.target.value)}
        />
        {qs ? (
          <button className="btn btn-ghost btn-sm" onClick={() => setParams(new URLSearchParams())}>
            Clear
          </button>
        ) : null}
        <div className="spacer" />
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>
          {me?.role === 'super_admin' ? 'All tenants' : `${me?.scopes.length} tenant${me?.scopes.length === 1 ? '' : 's'}`}
        </span>
      </div>

      {isLoading ? (
        <Spinner />
      ) : !data?.data.length ? (
        <Empty title="No tickets match">Try clearing the filters.</Empty>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Reference</th>
                <th>Subject</th>
                <th>Tenant</th>
                <th>Category</th>
                {/* Column reads "Priority"; the stored field is `severity`. */}
                <th>{SEVERITY_COLUMN_LABEL}</th>
                <th>Status</th>
                <th>Assignee</th>
                <th>Raised</th>
              </tr>
            </thead>
            <tbody>
              {data.data.map((t) => (
                <tr key={t.id} className="clickable" onClick={() => nav(`/tickets/${t.id}`)}>
                  <td className="mono">{t.reference}</td>
                  <td className="truncate">{t.subject || t.description.slice(0, 70)}</td>
                  <td><TenantChip name={t.tenant.name} color={tenantColor(t.tenant.id)} /></td>
                  <td style={{ color: 'var(--muted)' }}>{t.category ?? '—'}</td>
                  <td>{t.severity ? <Pill kind="severity" value={t.severity} /> : '—'}</td>
                  <td><Pill kind="status" value={t.status} /></td>
                  <td style={{ color: t.assignee ? undefined : 'var(--muted)' }}>
                    {t.assignee?.display_name ?? 'Unassigned'}
                  </td>
                  <td style={{ color: 'var(--muted)', whiteSpace: 'nowrap' }}>{relTime(t.raised_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <PageFooter />
    </>
  );
}
