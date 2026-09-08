/**
 * The single error envelope. Every non-2xx response in every service uses this
 * exact shape — see docs/api-contract.md §2.4/§2.5.
 *
 * Callers branch on `code`, never on `message`. Messages may be reworded freely.
 */
export interface ErrorEnvelope {
  error: {
    code: ErrorCode;
    message: string;
    request_id: string;
    details?: Record<string, unknown>;
  };
}

export const ERROR_CODES = {
  invalid_request: 400,
  unsupported_category: 400,
  signature_invalid: 401,
  timestamp_out_of_window: 401,
  nonce_replayed: 401,
  identity_token_invalid: 401,
  identity_provider_unreachable: 401,
  unauthenticated: 401,
  credential_scope_exceeded: 403,
  origin_not_allowed: 403,
  knowledge_base_disabled: 403,
  forbidden: 403,
  ticket_not_found: 404,
  not_found: 404,
  invalid_state_transition: 409,
  idempotency_key_reuse: 409,
  already_exists: 409,
  attachment_too_large: 413,
  attachment_type_not_allowed: 415,
  preauth_grant_invalid: 422,
  rate_limited: 429,
  internal_error: 500,
  service_unavailable: 503,
  deflection_unavailable: 503,
  /**
   * Phase 15. Copilot is off for this deployment. 503 rather than 403: it is a
   * capability that is not running, not a permission the caller lacks — and an
   * agent seeing "unavailable" knows to write the reply themselves.
   */
  copilot_disabled: 503,
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

/**
 * Typed error thrown anywhere in a service; the edge middleware converts it to
 * the envelope. Handlers never build error responses by hand.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: Record<string, unknown> | undefined;
  readonly expose = true;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = ERROR_CODES[code];
    this.details = details;
  }
}

export const badRequest = (m: string, d?: Record<string, unknown>) =>
  new AppError('invalid_request', m, d);

/**
 * Deliberately indistinguishable from "does not exist".
 * A 403 would confirm the resource exists, leaking that another product has a
 * ticket with that id. See docs/api-contract.md §2.5.
 */
export const notFound = (m = 'No such resource is visible to this credential.') =>
  new AppError('ticket_not_found', m);

export function toEnvelope(err: AppError, requestId: string): ErrorEnvelope {
  return {
    error: {
      code: err.code,
      message: err.message,
      request_id: requestId,
      ...(err.details ? { details: err.details } : {}),
    },
  };
}
