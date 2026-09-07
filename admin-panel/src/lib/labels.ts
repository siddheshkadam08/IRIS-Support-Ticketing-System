/**
 * Display labels — the ONLY place UI wording maps to stored values.
 *
 * A label that appears in two components disagrees within a week. More
 * importantly, these mappings are load-bearing decisions, not cosmetics:
 * the mockup says "Priority" but the brief, the API and the database all say
 * `severity`, and we do not introduce a second field to paper over that.
 * See docs/ui-spec-deltas.md §1.
 */

export const SEVERITY_LABEL: Record<string, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  critical: 'Critical',
};

/** The column header. The stored field is and stays `severity`. */
export const SEVERITY_COLUMN_LABEL = 'Priority';

/**
 * `assigned` is a real state — it fires the dual JIT grant — but it is not a
 * filter chip, because the Assignee column already communicates it.
 * `waiting_on_raiser` displays as "On Hold" (HLD §10.1).
 */
export const STATUS_LABEL: Record<string, string> = {
  open: 'Open',
  assigned: 'Open',
  in_progress: 'In Progress',
  waiting_on_raiser: 'On Hold',
  resolved: 'Resolved',
  closed: 'Closed',
};

export const STATUS_FILTERS = [
  { value: 'open,assigned', label: 'Open' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'waiting_on_raiser', label: 'On Hold' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'closed', label: 'Closed' },
];

export const ROLE_LABEL: Record<string, string> = {
  super_admin: 'Super Admin',
  product_admin: 'Tenant Admin',
  manager: 'Manager',
  agent: 'Agent',
};

export const ROLE_DESCRIPTION: Record<string, string> = {
  super_admin: 'All tenants. Onboards tenants and manages every user.',
  product_admin: 'Their tenants only. Configuration and user management within scope.',
  manager: 'Their tenants only. Assigns work and sees analytics. No configuration.',
  agent: 'Their tenants only. Full ticket data only on tickets assigned to them.',
};

export const GRANT_STATE_LABEL: Record<string, string> = {
  grant_pending: 'Grant pending',
  granted: 'Active',
  revoke_pending: 'Revoke pending',
  revoked: 'Revoked',
  grant_failed: 'Grant failed',
  revoke_failed: 'REVOKE FAILED',
};

/** Actions render as sentences, not raw event names. */
export const ACTION_LABEL: Record<string, string> = {
  'auth.login': 'Signed in',
  'auth.logout': 'Signed out',
  'auth.password_changed': 'Changed password',
  'ticket.created': 'Ticket raised',
  'ticket.assigned': 'Assigned',
  'ticket.status_changed': 'Status changed',
  'ticket.comment_added': 'Replied',
  'ticket.internal_note_added': 'Internal note added',
  'ticket.rated': 'Rated',
  'access.granted': 'Access granted',
  'access.revoked': 'Access revoked',
  'attachment.uploaded': 'Attachment uploaded',
  'support_user.created': 'User created',
  'support_user.updated': 'User updated',
  'tenant.created': 'Tenant created',
  'tenant.updated': 'Tenant updated',
};

export const BRAND_FOOTER = 'Powered by Elevate - X.';

export function relTime(iso: string | null): string {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return d < 30 ? `${d}d ago` : new Date(iso).toLocaleDateString();
}

export function absTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}
