/**
 * Knowledge base authoring contract — Phase 18.
 *
 * ⚠️ THIS FILE IS THE ONLY DEFINITION OF THE KB LIFECYCLE.
 *
 * The transition matrix, the role rules and the index-state derivation live
 * here, once, because all three are needed on BOTH sides of the wire. The
 * route enforces them and the admin panel renders them, and a second copy in
 * the panel would drift — silently, and in the direction that matters: a
 * button offered for a transition the server rejects, or worse, a button
 * withheld for one it allows.
 *
 * ⚠️ NO NODE IMPORTS, EVER. This module is imported by browser code through
 * the `@iris/shared/kb` subpath rather than through the `@iris/shared/types`
 * barrel, precisely so that `node:crypto` (via ids.ts) never reaches the
 * bundle. Keep it dependency-free; a single import here is a broken build in
 * admin-panel, and the error will point at the barrel rather than at this line.
 */

// ─────────────────────────────────────────────────────────────────────────
// Lifecycle
// ─────────────────────────────────────────────────────────────────────────

export const KB_STATUSES = ['draft', 'published', 'archived'] as const;
export type KbArticleStatus = (typeof KB_STATUSES)[number];

/**
 * Legal transitions, as data.
 *
 * Read it as "from this state, you may go to these". A state is never listed
 * in its own row, so `draft -> draft` is illegal rather than a silent no-op —
 * a re-publish of an already-published article should tell the operator the
 * article is already published, not write an audit row claiming a change that
 * did not happen.
 *
 * ⚠️ `archived -> published` IS ABSENT ON PURPOSE, and it is the one entry
 * people will try to add.
 *
 * A retired article is retired because someone decided its content should stop
 * being an answer. Republishing it directly puts that content straight back
 * into KB_CORPUS, where RAG will ground on it and Copilot will cite it, with
 * no one having re-read it. Routing through `draft` costs one extra click and
 * buys a point at which the text is in front of a human before it is in front
 * of a customer. If it turns out the text was fine, the draft publishes
 * immediately and nothing was lost.
 */
export const KB_TRANSITIONS: Readonly<Record<KbArticleStatus, readonly KbArticleStatus[]>> = {
  draft: ['published', 'archived'],
  published: ['draft', 'archived'],
  archived: ['draft'],
};

export function isKbStatus(value: unknown): value is KbArticleStatus {
  return typeof value === 'string' && (KB_STATUSES as readonly string[]).includes(value);
}

export function isLegalKbTransition(from: KbArticleStatus, to: KbArticleStatus): boolean {
  return KB_TRANSITIONS[from].includes(to);
}

/** The transitions this article can currently make. Drives the UI's controls. */
export function allowedKbTransitions(from: KbArticleStatus): readonly KbArticleStatus[] {
  return KB_TRANSITIONS[from];
}

// ─────────────────────────────────────────────────────────────────────────
// Who may do what
// ─────────────────────────────────────────────────────────────────────────

/**
 * The staff roles that reach `/admin/api`. Mirrors ADMIN_ROLES in
 * core-service/src/admin/admin.context.ts; `product` and `raiser` never get
 * here, and are not modelled.
 */
export type KbActorRole = 'agent' | 'manager' | 'product_admin' | 'super_admin';

/**
 * ⚠️ THE LINE IS DRAWN AT PUBLICATION, NOT AT AUTHORING.
 *
 * An agent may write and edit a draft, because the agent who just solved the
 * ticket is the person who knows the answer, and a draft costs nothing and is
 * seen by nobody outside the tenant's staff.
 *
 * An agent may not publish, because publication is the moment the text becomes
 * customer-visible AND becomes something the AI will ground a grounded answer
 * on. That is a governance decision about what the platform asserts, which is
 * the same reason classification is deterministic rather than model-driven:
 * the AI proposes, IRIS decides. Here, the author proposes and a manager
 * decides.
 */
export const KB_PUBLISHER_ROLES: readonly KbActorRole[] = ['manager', 'product_admin', 'super_admin'];

export function canPublishKb(role: string): boolean {
  return (KB_PUBLISHER_ROLES as readonly string[]).includes(role);
}

/**
 * May this role edit an article's TEXT in this state?
 *
 * ⚠️ ARCHIVED IS UNEDITABLE BY EVERYONE, super_admin included. That is not an
 * oversight and not a permission gap.
 *
 * An archived article is a record of what was once published, and a citation
 * that a customer has already been shown may point at it. Editing it in place
 * rewrites what that citation said, after the fact, with the audit trail
 * showing an edit but nothing showing that a live answer changed meaning.
 * Restoring it to draft first makes the intent explicit: this text is coming
 * back, and it is being reworked before it does.
 */
export function canEditKbArticle(role: string, status: KbArticleStatus): boolean {
  if (status === 'archived') return false;
  if (status === 'published') return canPublishKb(role);
  return role === 'agent' || canPublishKb(role);
}

// ─────────────────────────────────────────────────────────────────────────
// Index state
// ─────────────────────────────────────────────────────────────────────────

/**
 * What the embedding pipeline has actually done with this article.
 *
 * ⚠️ WHY THIS EXISTS AT ALL, AND WHY IT IS NOT COSMETIC.
 *
 * Publishing makes an article retrievable by full-text and trigram search
 * IMMEDIATELY, because `search_tsv` is a GENERATED column. It does NOT make it
 * retrievable by vector search: that waits for the worker's sweep, which runs
 * every five minutes and is OFF BY DEFAULT (`EMBEDDING_ENABLED`).
 *
 * So a manager can publish an article, watch it appear in search, and
 * reasonably conclude it is in the AI corpus — while the third retrieval
 * strategy has never seen it and, on a deployment where the sweep was never
 * enabled, never will. The article works in two strategies out of three and
 * nothing anywhere reports the third. Showing this state is the fix.
 */
export type KbIndexState = 'indexed' | 'pending' | 'failed';

export interface KbIndexInputs {
  status: KbArticleStatus;
  is_public: boolean;
  /** `embedding IS NOT NULL`, projected by SQL. Not inferred from embedded_at. */
  has_embedding: boolean;
  embedding_error: string | null;
  embedding_fingerprint: string | null;
  embedding_content_sha: string | null;
  embedding_model: string | null;
  /** EMBEDDING_MODEL_ID this deployment is configured for. */
  current_model: string;
}

/**
 * ⚠️ THIS MIRRORS `pendingPredicate` IN embedding.repo.ts. It is not a
 * simplification of it, and the difference is load-bearing.
 *
 * The obvious derivation — "failed when embedding_error IS NOT NULL" — is
 * WRONG, and wrong in the direction that hides working behaviour. Quarantine
 * (migration 015) stamps the error alongside the FINGERPRINT of the text that
 * caused it, and the pending predicate only excludes the row while that
 * fingerprint still matches the content hash. Edit the text and the equality
 * breaks: the row becomes pending again and will be retried, even though
 * `embedding_error` is still set from the previous attempt. A UI that read the
 * error alone would show "failed" forever on an article the pipeline had
 * already picked back up.
 *
 * Hence the order below: quarantine is checked with its fingerprint guard, and
 * only then does staleness decide between pending and indexed.
 *
 * NULL means the article is not eligible for the corpus at all — a draft, an
 * archive, or a non-public article. Not "pending", which would promise
 * something that will never happen while the article is in that state, and not
 * "indexed", which would be a lie. Eligibility is a separate axis from index
 * state, exactly as `is_public` is a separate axis from `status`.
 */
export function kbIndexState(row: KbIndexInputs): KbIndexState | null {
  if (row.status !== 'published' || !row.is_public) return null;

  const fingerprintCurrent =
    row.embedding_fingerprint !== null &&
    row.embedding_content_sha !== null &&
    row.embedding_fingerprint === row.embedding_content_sha;

  // Quarantined: this exact text failed permanently and will not be retried
  // until it changes. Checked FIRST — a row here may still hold a good vector
  // from the previous revision, which would otherwise read as 'indexed' and
  // hide a real, billed failure.
  if (row.embedding_error !== null && fingerprintCurrent) return 'failed';

  if (!row.has_embedding || !fingerprintCurrent || row.embedding_model !== row.current_model) {
    return 'pending';
  }
  return 'indexed';
}

// ─────────────────────────────────────────────────────────────────────────
// Wire shapes
// ─────────────────────────────────────────────────────────────────────────

/**
 * Bounds. `body` is generous because an article is prose, but not unbounded:
 * the text is concatenated into the embedding input and into RAG prompts, so
 * an unbounded field is a token-cost problem and a provider-limit problem
 * rather than merely untidy. EMBEDDING_MAX_CHARS truncates for the vector; the
 * limit here is what a human is allowed to write in the first place.
 */
export const KB_TITLE_MAX = 200;
export const KB_BODY_MAX = 50_000;
export const KB_CATEGORY_MAX = 40;
export const KB_QUERY_MAX = 200;
export const KB_LIST_DEFAULT_LIMIT = 25;
export const KB_LIST_MAX_LIMIT = 100;

/**
 * The admin view of an article.
 *
 * DELIBERATELY NOT `KbArticleDTO`. That type is the customer-facing shape: it
 * carries an `excerpt` and a `helpful_pct` and hides `status` entirely, because
 * a widget reader has no business knowing an article's editorial state. This
 * one carries the lifecycle and the index state and no derived excerpt, because
 * an editor needs the former and never wants the latter. Two audiences, two
 * shapes; merging them is how `status` ends up on a public response.
 */
export interface KbArticleAdminDTO {
  id: string;
  product_id: string;
  title: string;
  category: string | null;
  status: KbArticleStatus;
  is_public: boolean;
  views: number;
  helpful_yes: number;
  helpful_no: number;
  created_at: string;
  updated_at: string;
  /** null when the article is not eligible for the corpus. See kbIndexState. */
  index_state: KbIndexState | null;
  embedded_at: string | null;
  embedding_error: string | null;
  /** Full text. Present on the single-article read only, never on the list. */
  body?: string;
}

export interface KbArticleListResponse {
  data: KbArticleAdminDTO[];
  total: number;
  limit: number;
  offset: number;
  has_more: boolean;
}
