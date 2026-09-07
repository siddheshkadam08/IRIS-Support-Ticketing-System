import type { ReactNode } from 'react';
import { BRAND_FOOTER, STATUS_LABEL, SEVERITY_LABEL, ROLE_LABEL, GRANT_STATE_LABEL } from '../lib/labels';

export function Pill({ kind, value }: { kind: 'status' | 'severity' | 'role' | 'grant'; value: string }) {
  const label =
    kind === 'status' ? (STATUS_LABEL[value] ?? value)
    : kind === 'severity' ? (SEVERITY_LABEL[value] ?? value)
    : kind === 'role' ? (ROLE_LABEL[value] ?? value)
    : (GRANT_STATE_LABEL[value] ?? value);
  return <span className={`pill pill-${value}`}>{label}</span>;
}

export function Spinner() {
  return <div className="spinner" aria-label="Loading" />;
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-title">{title}</div>
      {children ? <div style={{ fontSize: 12.5, lineHeight: 1.55 }}>{children}</div> : null}
    </div>
  );
}

export function Banner({ kind, children }: { kind: 'err' | 'ok' | 'info' | 'warn'; children: ReactNode }) {
  return <div className={`banner banner-${kind}`}>{children}</div>;
}

export function Card({ title, children, style }: { title?: string; children: ReactNode; style?: React.CSSProperties }) {
  return (
    <div className="card" style={style}>
      {title ? <div className="card-title">{title}</div> : null}
      {children}
    </div>
  );
}

export function Stat({
  value,
  label,
  tone,
}: {
  value: string | number;
  label: string;
  tone?: 'accent' | 'danger' | 'ok';
}) {
  return (
    <div className="card">
      <div className={`stat-value ${tone ? `stat-${tone}` : ''}`}>{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

/** Tenant identity, shown wherever a row could belong to more than one. */
export function TenantChip({ name, color }: { name: string | null; color?: string }) {
  if (!name) return <span style={{ color: 'var(--muted)' }}>—</span>;
  return (
    <span className="tenant-chip">
      <span className="tenant-dot" style={{ background: color ?? '#94a3b8' }} />
      {name}
    </span>
  );
}

export function PageFooter() {
  return <div className="page-foot">{BRAND_FOOTER}</div>;
}

export function initials(name: string): string {
  return name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('');
}
