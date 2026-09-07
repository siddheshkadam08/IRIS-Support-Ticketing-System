import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { Banner, Card, PageFooter, Spinner, Stat, TenantChip } from '../components/ui';

export default function Dashboard() {
  const { me, tenantColor } = useAuth();
  const { data, isLoading } = useQuery({
    queryKey: ['dashboard'],
    queryFn: api.dashboard,
    // "Live counters" is a stated requirement — they must visibly move.
    refetchInterval: 15_000,
  });

  if (isLoading || !data) return <Spinner />;
  const c = data.counters;

  return (
    <>
      {/* A failed revoke means access may outlive its ticket. Top of the page,
          in red, every time. */}
      {data.revoke_failures > 0 ? (
        <Banner kind="err">
          <strong>{data.revoke_failures} access revocation{data.revoke_failures === 1 ? '' : 's'} failed.</strong>{' '}
          The integrating product did not confirm revocation after all retries — access may still be
          live. <Link to="/tickets?status=resolved">Review affected tickets →</Link>
        </Banner>
      ) : null}

      <div className="grid grid-4" style={{ marginBottom: 14 }}>
        <Stat value={c.open + c.assigned} label="Open" tone="accent" />
        <Stat value={c.in_progress} label="In progress" />
        <Stat value={c.waiting_on_raiser} label="On hold" />
        <Stat value={c.resolved + c.closed} label="Resolved / closed" tone="ok" />
      </div>

      <div className="grid grid-3" style={{ marginBottom: 14 }}>
        <Link to="/tickets?status=open" style={{ color: 'inherit' }}>
          <Stat value={data.triage_queue} label="Unassigned — needs triage" tone={data.triage_queue > 0 ? 'danger' : undefined} />
        </Link>
        <Link to="/tickets?severity=high,critical" style={{ color: 'inherit' }}>
          <Stat value={data.high_severity_open} label="High severity, still open" tone={data.high_severity_open > 0 ? 'danger' : undefined} />
        </Link>
        <Stat
          value={data.csat.average ? `${data.csat.average} ★` : '—'}
          label={`CSAT over ${data.csat.responses} ratings`}
          tone="ok"
        />
      </div>

      <div className="grid grid-2">
        <Card title={`Tickets by tenant${me?.role === 'super_admin' ? '' : ' (your tenants)'}`}>
          <table>
            <thead>
              <tr><th>Tenant</th><th style={{ textAlign: 'right' }}>Open</th><th style={{ textAlign: 'right' }}>Total</th></tr>
            </thead>
            <tbody>
              {data.by_tenant.map((t) => (
                <tr key={t.product_id}>
                  <td><TenantChip name={t.name} color={tenantColor(t.product_id)} /></td>
                  <td style={{ textAlign: 'right', fontWeight: 600 }}>{t.open}</td>
                  <td style={{ textAlign: 'right', color: 'var(--muted)' }}>{t.total}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>

        <Card title="Deflection">
          <div className="stat-value stat-ok">{data.self_served.rate}%</div>
          <div className="stat-label">
            Self-served — {data.self_served.count} conversations answered without a ticket
          </div>
          <div className="hint" style={{ marginTop: 12 }}>
            This counts widget conversations that never became tickets. It is <strong>not</strong> AI
            resolving tickets on its own — no AI response is ever sent on an open ticket without a
            human.
          </div>
        </Card>
      </div>
      <PageFooter />
    </>
  );
}
