import { withSystemScope, type Tx } from '../db/with-scope.js';

export interface ProductRow {
  id: string;
  slug: string;
  name: string;
  ref_prefix: string;
  client_id: string;
  client_secret_hash: string;
  publishable_key: string;
  webhook_url: string | null;
  access_mechanism: string;
  jwks_url: string | null;
  jwks_inline: unknown;
  allowed_issuers: string[];
  allowed_origins: string[];
  config: ProductConfig;
  is_active: boolean;
}

export interface ProductConfig {
  categories?: Array<{ value: string; label: string }>;
  severities?: Array<{ value: string; label: string }>;
  default_severity?: string;
  widget?: {
    title?: string;
    subtitle?: string;
    greeting?: string;
    primary_color?: string;
    accent_color?: string;
    logo_text?: string;
    enabled_capabilities?: string[];
    suggestions?: string[];
    allow_anonymous?: boolean;
    fields?: { subject?: boolean; category?: boolean; severity?: boolean; attachments?: boolean };
  };
  knowledge_base?: { enabled?: boolean };
  deflection?: { enabled?: boolean; min_score?: number; max_suggestions?: number };
  ai_thresholds?: { auto_route_p1?: number; auto_route_margin?: number; triage_floor?: number };
  /**
   * Phase 4 classification vocabularies. All optional: an unconfigured product
   * falls back to the platform defaults and still classifies.
   *
   * `core_categories` must be a subset of `categories[].value` — a typo there
   * silently changes priority scoring rather than failing, so the admin schema
   * validates it on write.
   */
  issue_types?: string[];
  impacts?: string[];
  core_categories?: string[];
  auto_close_days?: number;
}

/**
 * Credential lookups use withSystemScope: resolving which product is calling
 * is what *establishes* the scope, so the query cannot itself be scoped
 * without being circular. Each is a lookup by unique key and can only match
 * one product, so it cannot widen visibility.
 */
export async function findByPublishableKey(
  key: string,
  requestId = 'bootstrap',
): Promise<ProductRow | null> {
  return withSystemScope(requestId, async (tx) => {
    const { rows } = await tx.query<ProductRow>(
      `SELECT * FROM product WHERE publishable_key = $1 AND is_active = true`,
      [key],
    );
    return rows[0] ?? null;
  });
}

export async function findByClientId(
  clientId: string,
  requestId = 'bootstrap',
): Promise<ProductRow | null> {
  return withSystemScope(requestId, async (tx) => {
    const { rows } = await tx.query<ProductRow>(
      `SELECT * FROM product WHERE client_id = $1 AND is_active = true`,
      [clientId],
    );
    return rows[0] ?? null;
  });
}

export async function findById(id: string, requestId = 'bootstrap'): Promise<ProductRow | null> {
  return withSystemScope(requestId, async (tx) => {
    const { rows } = await tx.query<ProductRow>(`SELECT * FROM product WHERE id = $1`, [id]);
    return rows[0] ?? null;
  });
}

/** Allocates the next per-product ticket reference, e.g. CARB-1042. */
export async function nextReference(tx: Tx, productId: string): Promise<string> {
  const { rows } = await tx.query<{ ref_prefix: string; ticket_seq: number }>(
    `UPDATE product SET ticket_seq = ticket_seq + 1
      WHERE id = $1
      RETURNING ref_prefix, ticket_seq`,
    [productId],
  );
  const row = rows[0];
  if (!row) throw new Error(`product ${productId} not found while allocating reference`);
  return `${row.ref_prefix.toUpperCase()}-${row.ticket_seq}`;
}

/**
 * The classification taxonomy invariant — Phase 4 Step 3A.
 *
 *     core_categories ⊆ categories[].value
 *
 * WHY THIS IS NOT A ZOD REFINEMENT ON THE REQUEST BODY.
 *
 * The config endpoint MERGES: a caller may send `core_categories` alone, or
 * `categories` alone, and the stored config supplies the other half. A body-level
 * check can therefore only see one side of the relationship, and silently passes
 * whenever the other side is absent — which is exactly when it is most needed.
 * Two ways that goes wrong, both reachable through the existing API:
 *
 *   1. set core_categories against categories the caller never sent;
 *   2. narrow categories out from under core_categories that already exist.
 *
 * So the check runs against the MERGED, post-write configuration instead. That
 * is the only representation where the invariant is a complete statement, and
 * checking it there means it holds after every successful write rather than
 * after some of them.
 *
 * A violation is silent rather than loud at runtime: an unmatched
 * core_categories entry simply never matches, so the +15 core-category bonus
 * quietly never applies and every affected ticket is scored one tier too low,
 * indefinitely. Nothing errors, nothing logs. Write time is the only cheap
 * place to catch it.
 *
 * Returns the offending values so the caller can name them — "invalid" without
 * saying which value is a support ticket waiting to happen.
 */
export function invalidCoreCategories(config: ProductConfig): string[] {
  const core = config.core_categories;
  if (!core || core.length === 0) return []; // empty is valid: nothing is core
  const known = new Set((config.categories ?? []).map((c) => c.value));
  return core.filter((value) => !known.has(value));
}
