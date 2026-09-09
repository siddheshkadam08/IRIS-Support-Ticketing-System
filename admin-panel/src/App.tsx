import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from './auth/AuthContext';
import { api } from './api/client';
import { BRAND_FOOTER, ROLE_LABEL } from './lib/labels';
import { Spinner, TenantChip, initials } from './components/ui';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Tickets from './pages/Tickets';
import TicketDetail from './pages/TicketDetail';
import Agents from './pages/Agents';
import Tenants from './pages/Tenants';
import AuditLog from './pages/AuditLog';
import AIGovernance from './pages/AIGovernance';
import KnowledgeBase from './pages/KnowledgeBase';

const NAV = [
  { to: '/', label: 'Dashboard', end: true, roles: null },
  { to: '/tickets', label: 'Tickets', roles: null },
  { to: '/agents', label: 'Agents', roles: null },
  { to: '/tenants', label: 'Tenants', roles: null },
  // Phase 18. No role gate: every staff role may author drafts. Publishing is
  // gated by the API, not by hiding the page from the people who write articles.
  { to: '/knowledge-base', label: 'Knowledge Base', roles: null },
  { to: '/audit', label: 'Audit Logs', roles: ['super_admin', 'product_admin', 'manager'] },
  // Phase 17. Hidden from agents, who also get a 403 from the API — the nav is
  // a convenience, never the control.
  { to: '/ai-governance', label: 'AI Governance', roles: ['super_admin', 'product_admin', 'manager'] },
] as const;

const TITLES: Record<string, string> = {
  '/': 'Dashboard',
  '/tickets': 'Tickets',
  '/agents': 'Agents',
  '/tenants': 'Tenants',
  '/knowledge-base': 'Knowledge Base',
  '/audit': 'Audit Logs',
  '/ai-governance': 'AI Governance',
};

export default function App() {
  const { me, loading, signOut } = useAuth();
  const location = useLocation();

  if (loading) return <Spinner />;
  if (!me) return <Login />;

  const title =
    TITLES[location.pathname] ??
    (location.pathname.startsWith('/tickets/') ? 'Ticket' : 'IRIS Support');

  return (
    <div className="shell">
      <aside className="side">
        <div className="side-brand">
          <div className="side-logo">
            <svg width="19" height="19" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <rect x="4" y="7" width="16" height="12" rx="3.2" stroke="#fff" strokeWidth="1.8" />
              <path d="M12 3.4v3.6" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" />
              <circle cx="9.3" cy="12.6" r="1.4" fill="#fff" />
              <circle cx="14.7" cy="12.6" r="1.4" fill="#fff" />
            </svg>
          </div>
          <div>
            <div className="side-title">IRIS Support</div>
            <div className="side-sub">Admin portal</div>
          </div>
        </div>

        <nav className="nav">
          {NAV.filter((n) => !n.roles || (n.roles as readonly string[]).includes(me.role)).map((n) => (
            <NavLink key={n.to} to={n.to} end={'end' in n ? n.end : false}>
              {n.label}
              {n.to === '/tenants' ? <span className="nav-badge">{me.tenants.length}</span> : null}
            </NavLink>
          ))}
        </nav>

        <div className="side-foot">
          <div style={{ marginBottom: 6, color: '#94a3b8' }}>
            {me.role === 'super_admin' ? 'All tenants' : 'Your tenants'}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 10 }}>
            {me.tenants.map((t) => (
              <span key={t.id} style={{ fontSize: 10.5, color: '#cbd5e1', display: 'flex', alignItems: 'center', gap: 4 }}>
                <span className="tenant-dot" style={{ background: t.primary_color }} />
                {t.name}
              </span>
            ))}
          </div>
          {BRAND_FOOTER}
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <h1>{title}</h1>
          <div className="spacer" />
          <div className="who">
            <div className="who-name">{me.display_name}</div>
            <div className="who-role">{ROLE_LABEL[me.role]}</div>
          </div>
          <div className="avatar">{initials(me.display_name)}</div>
          <button className="btn btn-ghost btn-sm" onClick={() => void signOut()}>Sign out</button>
        </header>

        <div className="content">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/tickets" element={<Tickets />} />
            <Route path="/tickets/:id" element={<TicketDetail />} />
            <Route path="/agents" element={<Agents />} />
            <Route path="/tenants" element={<Tenants />} />
            <Route path="/knowledge-base" element={<KnowledgeBase />} />
            <Route path="/audit" element={<AuditLog />} />
            <Route path="/ai-governance" element={<AIGovernance />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </div>
      </main>
    </div>
  );
}
