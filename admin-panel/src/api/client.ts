/**
 * The only place the admin panel talks to the network.
 *
 * The session is an httpOnly cookie set by the gateway, so nothing here reads
 * or stores a token — `credentials: 'include'` is the whole auth story, and a
 * script injected into this page cannot steal the session.
 */

import type { WidgetSettings } from '@iris/shared/widget-config';

export type { WidgetSettings, WidgetCapability, WidgetCategory } from '@iris/shared/widget-config';

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    /** Per-field messages from the server, e.g. `{ slug: ['already used'] }`. */
    readonly fields?: Record<string, string[]>,
  ) {
    super(message);
  }
}

const BASE = '';

/**
 * `fetch` only *rejects* when the request never completed — the response never
 * started. In practice that is one of two things: the server is down, or the
 * browser reused a pooled keep-alive socket the server had already closed.
 *
 * The second is invisible and maddening: the browser silently retries a GET on
 * a dead socket but must not retry a POST, so it surfaces only on writes, only
 * after an idle period — like filling in a form. The server-side fix is a
 * keepAliveTimeout longer than the browser's (gateway/src/server.ts); this is
 * the client half.
 *
 * Retrying is safe here precisely because the request was never delivered.
 */
async function send(method: string, path: string, body?: unknown): Promise<Response> {
  try {
    return await fetch(`${BASE}${path}`, {
      method,
      credentials: 'include',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (cause) {
    throw new NetworkFailure(cause);
  }
}

class NetworkFailure extends Error {
  constructor(override readonly cause: unknown) {
    super('network');
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await send(method, path, body);
  } catch {
    // One retry, on a fresh connection. If this fails too, the server really
    // is unreachable rather than the socket merely being stale.
    try {
      res = await send(method, path, body);
    } catch {
      throw new ApiError(
        'network_error',
        'The connection dropped before the request was sent, so nothing was saved. ' +
          'Check that the gateway is running on port 4000, then try again.',
        0,
      );
    }
  }

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON */
  }

  if (!res.ok) {
    const err = (
      payload as {
        error?: { code: string; message: string; details?: { fields?: Record<string, string[]> } };
      } | null
    )?.error;
    throw new ApiError(
      err?.code ?? 'internal_error',
      err?.message ?? `Request failed (${res.status})`,
      res.status,
      err?.details?.fields,
    );
  }
  return payload as T;
}

export interface Me {
  id: string;
  email: string;
  display_name: string;
  role: 'super_admin' | 'product_admin' | 'manager' | 'agent';
  availability: string;
  scopes: string[];
  tenants: Array<{ id: string; name: string; slug: string; primary_color: string }>;
  must_change_password: boolean;
  last_login_at: string | null;
}

export interface TicketRow {
  id: string;
  reference: string;
  status: string;
  subject: string | null;
  description: string;
  category: string | null;
  severity: string | null;
  /** Phase 5: AI-generated, informational. Never the customer's own words. */
  summary?: string | null;
  raised_at: string;
  raised_by: { ref: string; name: string | null; email: string | null };
  assignee: { id: string; display_name: string } | null;
  tenant: { id: string | null; name: string | null };
  rating: number | null;
}

export interface Grant {
  id: string;
  layer: 'platform' | 'product';
  mechanism: string;
  state: string;
  support_user_id: string;
  support_user_name: string | null;
  scope_kind: string | null;
  resource_ref: string | null;
  granted_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  product_grant_ref: string | null;
  activation_response: unknown;
  revoke_response: unknown;
  attempt_count: number;
  last_error: string | null;
}

export interface Delivery {
  channel: string;
  target: string | null;
  attempt: number;
  status_code: number | null;
  ok: boolean;
  response_body: string | null;
  error: string | null;
  latency_ms: number | null;
  attempted_at: string;
}

export interface TicketDetail extends TicketRow {
  comments: Array<{
    id: string;
    author_type: string;
    author_name: string | null;
    body: string;
    is_internal: boolean;
    created_at: string;
  }>;
  attachments: Array<{ id: string; filename: string; size_bytes: number; created_at: string }>;
  grants: Grant[];
  deliveries: Delivery[];
  history: Array<{
    at: string;
    type: string;
    actor: { type: string; ref: string | null };
    before: unknown;
    after: unknown;
  }>;
  access: { has_platform_grant: boolean; reason: string | null };
  /**
   * Phase 4. Where the classification came from, and the AI's own record of
   * how it got there. `ai_classification` is deliberately `unknown`: it is
   * jsonb written by the AI pipeline, so the UI reads it defensively rather
   * than pretending to know its shape.
   */
  classification_source?: 'product' | 'ai_auto' | 'ai_uncertain' | 'unclassified';
  ai_classification?: unknown;
}

export interface AdminUser {
  id: string;
  email: string;
  display_name: string;
  role: string;
  availability: string;
  is_active: boolean;
  last_login_at: string | null;
  scopes: string[];
  skills: string[];
  open_tickets: number;
}

export interface Tenant {
  id: string;
  slug: string;
  name: string;
  ref_prefix: string;
  publishable_key: string;
  client_id: string;
  access_mechanism: string;
  access_callback_url: string | null;
  webhook_url: string | null;
  allowed_origins: string[];
  /** SSO: issuers whose identity tokens this tenant accepts. */
  allowed_issuers: string[];
  jwks_url: string | null;
  /** Whether a JWK set is pinned inline. The keys themselves are not returned. */
  has_jwks_inline: boolean;
  config: Record<string, unknown>;
  is_active: boolean;
  created_at: string;
  ticket_count: number;
  user_count: number;
}

export interface Dashboard {
  /**
   * Every key is always present — core-service defaults each status to 0.
   * Typed explicitly rather than as Record<string, number>, which under
   * noUncheckedIndexedAccess makes every read `number | undefined` and forces
   * defensive `?? 0` noise at each call site.
   */
  counters: {
    open: number;
    assigned: number;
    in_progress: number;
    waiting_on_raiser: number;
    resolved: number;
    closed: number;
    total: number;
  };
  by_tenant: Array<{ product_id: string; name: string; total: number; open: number }>;
  triage_queue: number;
  high_severity_open: number;
  csat: { average: number | null; responses: number };
  self_served: { count: number; rate: number };
  revoke_failures: number;
}

export interface SimilarTicket {
  reference: string;
  title: string;
  status: 'resolved' | 'closed';
  /**
   * Cosine similarity in [0,1]. READ COMPARATIVELY, NOT ABSOLUTELY — it is a
   * raw retrieval score, not a probability that the two tickets share a cause.
   */
  similarity: number;
  /** Last PUBLIC support reply. Null when none was recorded. Never internal. */
  resolution: string | null;
  resolved_at: string | null;
}

export interface SimilarTicketsResponse {
  items: SimilarTicket[];
  diagnostics: {
    corpus: number;
    returned: number;
    embed_ms: number | null;
    retrieval_ms: number;
    rerank_ms: number | null;
    outcome: string;
  };
}

export interface CopilotDraft {
  /** Absent when no draft could be produced. The agent writes the reply. */
  draft?: string;
  /** 1-based indexes into `sources`. Never identifiers. */
  citations: number[];
  sources: Array<{ source_number: number; kind: 'kb_article' | 'historical_ticket'; title: string }>;
  /** True when the draft cites nothing — read it harder before sending. */
  insufficient: boolean;
  outcome: string;
  diagnostics: {
    kb_evidence: number;
    historical_evidence: number;
    ticket_comments: number;
    retrieval_ms: number;
    generation_ms: number | null;
    total_ms: number;
    model: string | null;
    prompt_version: string;
  };
}


/**
 * Phase 16 — Suggested Assignees.
 *
 * ⚠️ NOT AI. No model, no prompt, no score: three counts and a total order over
 * them, computed in Core. The wording in the UI must stay "suggested" and
 * "evidence" — never "best agent", "AI ranking", "expertise" or a percentage.
 */
export interface AssigneeSuggestion {
  rank: number;
  support_user_id: string;
  display_name: string;
  role: 'agent' | 'product_admin' | 'manager';
  evidence_strength: 'strong' | 'moderate' | 'limited' | 'none';
  summary: string;
  factors: {
    similar_tickets: { count: number; best_similarity: number | null; label: string };
    category_experience: { count: number; label: string; category: string | null };
    active_tickets: { count: number; scope: 'all products'; label: string };
  };
  evidence: Array<{
    reference: string;
    title: string;
    similarity: number;
    resolved_at: string | null;
  }>;
}

export interface SuggestedAssigneesResponse {
  suggestions: AssigneeSuggestion[];
  caveats: string[];
  diagnostics: {
    eligible_candidates: number;
    suggestions_returned: number;
    similar_hits: number;
    similar_outcome: string;
    historical_corpus: number;
    embed_ms: number | null;
    total_ms: number;
    algorithm_version: string;
    outcome: string;
  };
}

export const api = {
  login: (email: string, password: string) =>
    request<{ user: Me }>('POST', '/admin/api/auth/login', { email, password }),
  logout: () => request<{ ok: boolean }>('POST', '/admin/api/auth/logout'),
  me: () => request<Me>('GET', '/admin/api/auth/me'),
  changePassword: (current_password: string, new_password: string) =>
    request<{ ok: boolean }>('POST', '/admin/api/auth/change-password', { current_password, new_password }),

  dashboard: () => request<Dashboard>('GET', '/admin/api/dashboard'),

  tickets: (qs: string) =>
    request<{ data: TicketRow[]; next_cursor: string | null; has_more: boolean }>(
      'GET',
      `/admin/api/tickets${qs ? `?${qs}` : ''}`,
    ),
  ticket: (id: string) => request<TicketDetail>('GET', `/admin/api/tickets/${id}`),
  /**
   * Phase 14 — historical tickets resembling this one. Read-only; changes
   * nothing about the ticket.
   */
  similarTickets: (id: string) =>
    request<SimilarTicketsResponse>('GET', `/admin/api/tickets/${id}/similar`),
  /**
   * Phase 16 — who could take this ticket, and the evidence behind each.
   * Read-only: it changes nothing and assigns nobody. Assignment stays
   * `assign()` below, which the human triggers separately.
   */
  suggestedAssignees: (id: string) =>
    request<SuggestedAssigneesResponse>('GET', `/admin/api/tickets/${id}/suggested-assignees`),
  /**
   * Phase 15 — generate a DRAFT reply. This does not send anything and creates
   * no comment; sending is `comment()` below, which the agent must trigger
   * separately after reviewing the text.
   */
  copilotDraft: (id: string) =>
    request<CopilotDraft>('POST', `/admin/api/tickets/${id}/copilot/draft`),
  assign: (id: string, support_user_id: string) =>
    request<TicketDetail>('POST', `/admin/api/tickets/${id}/assign`, { support_user_id }),
  setStatus: (id: string, status: string, reason?: string) =>
    request<TicketRow>('PATCH', `/admin/api/tickets/${id}/status`, { status, reason }),
  comment: (id: string, body: string, is_internal: boolean) =>
    request<{ id: string }>('POST', `/admin/api/tickets/${id}/comments`, { body, is_internal }),

  users: () => request<{ data: AdminUser[] }>('GET', '/admin/api/users'),
  createUser: (payload: Record<string, unknown>) => request<{ id: string }>('POST', '/admin/api/users', payload),
  updateUser: (id: string, payload: Record<string, unknown>) =>
    request<{ ok: boolean }>('PATCH', `/admin/api/users/${id}`, payload),

  widgetConfig: (id: string) =>
    request<WidgetSettings>('GET', `/admin/api/tenants/${id}/widget-config`),
  saveWidgetConfig: (id: string, payload: Partial<WidgetSettings>) =>
    request<WidgetSettings>('PATCH', `/admin/api/tenants/${id}/widget-config`, payload),

  tenants: () => request<{ data: Tenant[] }>('GET', '/admin/api/tenants'),
  createTenant: (payload: Record<string, unknown>) =>
    request<{ id: string; publishable_key: string; client_secret: string; webhook_secret: string }>(
      'POST',
      '/admin/api/tenants',
      payload,
    ),
  updateTenant: (id: string, payload: Record<string, unknown>) =>
    request<{ ok: boolean }>('PATCH', `/admin/api/tenants/${id}`, payload),

  audit: (qs: string) =>
    request<{ data: Array<Record<string, unknown>> }>('GET', `/admin/api/audit${qs ? `?${qs}` : ''}`),
};
