/** Thin API client. Every network call in the widget goes through here. */

export interface WidgetConfig {
  product: { id: string; name: string; slug: string };
  branding: {
    title: string;
    subtitle: string;
    greeting: string;
    primary_color: string;
    accent_color: string;
    logo_text: string | null;
  };
  capabilities: string[];
  fields: { subject: boolean; category: boolean; severity: boolean; attachments: boolean };
  categories: Array<{ value: string; label: string }>;
  severities: Array<{ value: string; label: string }>;
  default_severity: string;
  suggestions: string[];
  knowledge_base_enabled: boolean;
  deflection_enabled: boolean;
  allow_anonymous: boolean;
  identity: { authenticated: boolean; name: string | null; email: string | null };
  disclaimer: string;
  footer: string;
}

export interface ApiErrorShape {
  code: string;
  message: string;
  request_id?: string;
}

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

let baseUrl = '';
let publishableKey = '';
let identityToken: string | null = null;

export function configure(origin: string, key: string): void {
  baseUrl = origin.replace(/\/$/, '');
  publishableKey = key;
}

/** Held in memory only — never localStorage. An XSS on the host page should
 *  not yield a replayable identity assertion. */
export function setIdentityToken(token: string | null): void {
  identityToken = token;
}

export function hasIdentity(): boolean {
  return Boolean(identityToken);
}

function uuid(): string {
  return crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  opts: { idempotent?: boolean } = {},
): Promise<T> {
  const headers: Record<string, string> = { 'X-IRIS-Publishable-Key': publishableKey };
  if (identityToken) headers['X-IRIS-Identity'] = identityToken;
  if (body !== undefined && !(body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
  }
  // A retried POST on a flaky network creates a duplicate ticket that a human
  // then has to merge — so every mutation carries a key.
  if (opts.idempotent) headers['Idempotency-Key'] = uuid();

  let res: Response;
  try {
    res = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body:
        body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
    });
  } catch {
    throw new ApiError('network_error', 'Could not reach support. Check your connection.', 0);
  }

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON error body */
  }

  if (!res.ok) {
    const err = (payload as { error?: ApiErrorShape } | null)?.error;
    throw new ApiError(
      err?.code ?? 'internal_error',
      err?.message ?? `Request failed (${res.status})`,
      res.status,
    );
  }
  return payload as T;
}

export const api = {
  config: () => request<WidgetConfig>('GET', '/v1/widget/config'),

  ask: (question: string, conversationId: string | null) =>
    request<import('./types').AskResponse>('POST', '/v1/widget/ask', {
      question,
      conversation_id: conversationId,
    }),

  searchDocs: (q: string) =>
    request<{ data: import('./types').KbArticle[] }>(
      'GET',
      `/v1/kb/articles${q ? `?q=${encodeURIComponent(q)}` : ''}`,
    ),

  article: (id: string) => request<import('./types').KbArticle>('GET', `/v1/kb/articles/${id}`),

  voteHelpful: (id: string, helpful: boolean) =>
    request<{ ok: boolean }>('POST', `/v1/kb/articles/${id}/helpful`, { helpful }),

  announcements: () =>
    request<{ data: import('./types').Announcement[] }>('GET', '/v1/announcements'),

  createTicket: (body: Record<string, unknown>) =>
    request<import('./types').Ticket>('POST', '/v1/tickets', body, { idempotent: true }),

  myTickets: () => request<{ data: import('./types').Ticket[] }>('GET', '/v1/tickets?limit=25'),

  ticket: (id: string) => request<import('./types').Ticket>('GET', `/v1/tickets/${id}`),

  addComment: (id: string, body: string) =>
    request<{ id: string }>('POST', `/v1/tickets/${id}/comments`, { body }, { idempotent: true }),

  uploadAttachment: (file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return request<{ id: string; filename: string; size_bytes: number }>(
      'POST',
      '/v1/attachments',
      fd,
    );
  },

  linkAttachments: (ticketId: string, ids: string[]) =>
    request<{ linked: number }>('POST', `/v1/tickets/${ticketId}/attachments`, {
      attachment_ids: ids,
    }),
};
