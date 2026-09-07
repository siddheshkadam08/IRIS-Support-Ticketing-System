import { AppError } from '@iris/shared/types';

/**
 * What a publishable key is allowed to do — api-contract §3.4.
 *
 * A publishable key is scrapeable from any page by design, so it must not be
 * load-bearing. It permits exactly these four operations, all scoped to the
 * bearer of the accompanying identity JWT. Anything else is
 * 403 credential_scope_exceeded.
 */
interface Rule {
  method: string;
  pattern: RegExp;
}

const PUBLISHABLE_KEY_ALLOWED: Rule[] = [
  // Create a ticket
  { method: 'POST', pattern: /^\/v1\/tickets$/ },
  // Read own tickets (RLS additionally restricts to raised_by_ref)
  { method: 'GET', pattern: /^\/v1\/tickets$/ },
  { method: 'GET', pattern: /^\/v1\/tickets\/[^/]+$/ },
  { method: 'GET', pattern: /^\/v1\/tickets\/[^/]+\/history$/ },
  // Comment on and rate own tickets
  { method: 'POST', pattern: /^\/v1\/tickets\/[^/]+\/comments$/ },
  { method: 'POST', pattern: /^\/v1\/tickets\/[^/]+\/rating$/ },
  { method: 'PATCH', pattern: /^\/v1\/tickets\/[^/]+\/status$/ },
  { method: 'POST', pattern: /^\/v1\/tickets\/[^/]+\/attachments$/ },
  // Ask / deflect
  { method: 'POST', pattern: /^\/v1\/widget\/ask$/ },
  // Search the knowledge base
  { method: 'GET', pattern: /^\/v1\/kb\/articles$/ },
  { method: 'GET', pattern: /^\/v1\/kb\/articles\/[^/]+$/ },
  { method: 'POST', pattern: /^\/v1\/kb\/articles\/[^/]+\/helpful$/ },
  // Bootstrap + supporting
  { method: 'GET', pattern: /^\/v1\/widget\/config$/ },
  { method: 'GET', pattern: /^\/v1\/announcements$/ },
  { method: 'POST', pattern: /^\/v1\/attachments$/ },
  { method: 'GET', pattern: /^\/v1\/attachments\/[^/]+\/content$/ },
];

export function assertPublishableKeyScope(method: string, path: string): void {
  const clean = path.split('?')[0]!;
  const ok = PUBLISHABLE_KEY_ALLOWED.some(
    (r) => r.method === method.toUpperCase() && r.pattern.test(clean),
  );
  if (!ok) {
    throw new AppError(
      'credential_scope_exceeded',
      'This publishable key may not perform that operation.',
      { method, path: clean },
    );
  }
}

/** Which rate-limit bucket a request falls into. */
export function bucketFor(method: string, path: string): 'ask' | 'create_ticket' | 'read' | 'write' {
  const clean = path.split('?')[0]!;
  if (clean === '/v1/widget/ask') return 'ask';
  if (method === 'POST' && clean === '/v1/tickets') return 'create_ticket';
  return method === 'GET' ? 'read' : 'write';
}
