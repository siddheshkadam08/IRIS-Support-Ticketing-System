import {
  AppError,
  DEFAULT_CORE_CATEGORIES,
  DEFAULT_IMPACTS,
  PRIORITY_TO_SEVERITY,
  SEVERITIES,
  notFound,
  type ClassificationSource,
  type Priority,
  type PriorityFactors,
  type Severity,
  type TicketDTO,
} from '@iris/shared/types';
import type { ScopeContext, Tx } from '../db/with-scope.js';
import { writeAudit } from '../audit/index.js';
import { determinePriority } from '../internal/classification.rules.js';
import type { ProductConfig } from '../products/product.repo.js';
import { findTicket } from './ticket.repo.js';

/**
 * Human classification review and override — Phase 20.
 *
 * ⚠️ AI PREDICTS. HUMAN REVIEWS. IRIS DECIDES.
 *
 * Until now the third clause was only half true. `applyClassification` wrote a
 * ticket's category and severity exactly once, guarded
 * `WHERE classification_source = 'unclassified'`, and no endpoint anywhere
 * could change them afterwards. So the model's answer stood permanently — and
 * `ai_uncertain`, the band whose whole meaning is "a human should look at
 * this", had no way for a human to act on what they saw.
 *
 * ⚠️ A SEPARATE WRITER, DELIBERATELY, AND `applyClassification` IS UNTOUCHED.
 *
 * Reusing it would mean relaxing its `unclassified` guard, and that guard is
 * the only thing stopping a late or replayed AI result from overwriting a human
 * decision. Two writers with two different preconditions keep the authorship
 * question answerable from the SQL: the AI writer can only move a row OUT of
 * `unclassified`, and this one can only move it INTO `human`.
 *
 * ⚠️ SEVERITY IS AN OUTPUT OF THE PRIORITY ENGINE, NOT AN INPUT TO IT.
 *
 * `determinePriority` takes factors, issue type, category, impact and the
 * product's own lists; `severity` is then `PRIORITY_TO_SEVERITY[priority]`.
 * There is no `priority` column at all — severity IS the persisted projection.
 *
 * That makes the two corrections genuinely different operations:
 *
 *   correcting CATEGORY   corrects an INPUT. The engine re-derives the
 *                         outcome, and IRIS still owns the decision.
 *   supplying SEVERITY    OVERRIDES the engine's output. A reviewer who
 *                         cannot disagree with the engine has not been given
 *                         a review — so this is allowed, and recorded AS an
 *                         override rather than disguised as a derivation.
 *
 * The audit therefore always carries what the engine derived alongside what was
 * stored, so a divergence is visible rather than silent.
 */

// ─────────────────────────────────────────────────────────────────────────
// Shapes
// ─────────────────────────────────────────────────────────────────────────

export interface ExpectedClassification {
  category: string | null;
  severity: string | null;
  classification_source: ClassificationSource;
}

export interface CorrectionRequest {
  /** Ticket id or human reference, resolved the same way every other route does. */
  ticketRef: string;
  /** Omitted means "leave the category as it is". */
  category?: string | null;
  /** Omitted means "let the engine derive it". */
  severity?: Severity;
  /** What the reviewer saw. The compare-and-set guard, not a hint. */
  expected: ExpectedClassification;
}

export interface CorrectionOutcome {
  /** `noop` when nothing requested differed from the stored values. */
  kind: 'corrected' | 'noop';
  ticket: TicketDTO;
  /** Present on a real correction. Exactly what the audit row recorded. */
  audit?: CorrectionAudit;
}

export interface CorrectionAudit {
  before: { category: string | null; severity: string | null; classification_source: string };
  after: {
    category: string | null;
    severity: string | null;
    classification_source: 'human';
    derived_priority: Priority | null;
    derived_severity: Severity | null;
    severity_overridden: boolean;
    /** Only when the engine could not run at all. */
    reason?: 'no_ai_factors';
  };
}

interface TicketClassificationRow {
  id: string;
  product_id: string;
  category: string | null;
  severity: string | null;
  classification_source: ClassificationSource;
  ai_classification: Record<string, unknown> | null;
}

/** What the engine needs, recovered from the stored AI record. */
interface EngineInputs {
  factors: PriorityFactors;
  issue_type: string;
  impact: string;
}

// ─────────────────────────────────────────────────────────────────────────
// Reading the stored AI record
// ─────────────────────────────────────────────────────────────────────────

/**
 * Recover the priority engine's inputs from `ticket.ai_classification`.
 *
 * ⚠️ READ DEFENSIVELY AND RETURN NULL RATHER THAN THROWING. This is jsonb
 * written by an earlier version of the pipeline, and a ticket that was never
 * classified has none of it at all — 4,624 rows in the live database. "The
 * engine cannot run here" is an ordinary, expected state that the caller
 * handles by requiring an explicit severity, not an error.
 */
function engineInputsFrom(ai: Record<string, unknown> | null): EngineInputs | null {
  if (!ai) return null;

  const factors = ai.priority_factors as PriorityFactors | undefined;
  const issue_type = ai.issue_type;
  const impact = ai.impact;

  if (
    !factors ||
    typeof factors !== 'object' ||
    typeof factors.security_or_data_loss !== 'boolean' ||
    typeof issue_type !== 'string' ||
    typeof impact !== 'string'
  ) {
    return null;
  }
  return { factors, issue_type, impact };
}

// ─────────────────────────────────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────────────────────────────────

/**
 * A category must be one the PRODUCT configured.
 *
 * ⚠️ VALIDATED AGAINST CONFIGURATION, NOT AGAINST A PLATFORM CONSTANT, for the
 * same reason `validateClassification` re-checks the model's category against
 * the product's own vocabulary: a category that is not in the product's list is
 * a value no filter can ever match and no report can ever group by. A human
 * typing one is exactly as wrong as a model inventing one.
 */
function assertCategory(value: string, config: ProductConfig): void {
  const allowed = (config.categories ?? []).map((c) => c.value);
  if (allowed.length === 0) {
    throw new AppError(
      'invalid_request',
      'This tenant has no categories configured, so a category cannot be set.',
    );
  }
  if (!allowed.includes(value)) {
    throw new AppError('invalid_request', `"${value}" is not a category configured for this tenant.`, {
      fields: { category: [`Allowed: ${allowed.join(', ')}`] },
    });
  }
}

function assertSeverity(value: string): asserts value is Severity {
  if (!(SEVERITIES as readonly string[]).includes(value)) {
    throw new AppError('invalid_request', `"${value}" is not a valid severity.`, {
      fields: { severity: [`Allowed: ${SEVERITIES.join(', ')}`] },
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// The correction
// ─────────────────────────────────────────────────────────────────────────

/**
 * Apply one human correction, atomically, inside the caller's scope.
 *
 * `authorize` is invoked with the product read FROM THE DATABASE ROW, never
 * from the request. Passing it in keeps `assertTenant` — which needs the
 * caller — at the route boundary, while the value it judges comes from the only
 * authoritative source.
 */
export async function correctClassification(
  tx: Tx,
  ctx: ScopeContext,
  args: CorrectionRequest & { authorize: (productId: string) => void; sourceIp?: string | null },
): Promise<CorrectionOutcome> {
  // ── 1. The authoritative row ──────────────────────────────────────────
  const { rows } = await tx.query<TicketClassificationRow>(
    `SELECT id, product_id, category, severity, classification_source, ai_classification
       FROM ticket
      WHERE id = $1 OR upper(reference) = upper($1)
      LIMIT 1`,
    [args.ticketRef],
  );
  const row = rows[0];
  // Indistinguishable from "not visible": a 403 here would confirm that a
  // ticket with this id exists in some other tenant.
  if (!row) throw notFound();

  args.authorize(row.product_id);

  // ── 2. The product's own vocabulary ───────────────────────────────────
  const { rows: productRows } = await tx.query<{ config: ProductConfig | null }>(
    `SELECT config FROM product WHERE id = $1`,
    [row.product_id],
  );
  const config = productRows[0]?.config ?? {};

  if (args.category !== undefined && args.category !== null) assertCategory(args.category, config);
  if (args.severity !== undefined) assertSeverity(args.severity);

  // ── 3. No-op ──────────────────────────────────────────────────────────
  /**
   * ⚠️ COMPARED AGAINST THE CURRENT STORED VALUES, NOT AGAINST `expected`.
   *
   * `expected` answers "has anything moved under me?"; this answers "am I
   * actually changing anything?". They are different questions and conflating
   * them would make a stale request look like a no-op.
   *
   * A request that names only values already stored writes nothing and audits
   * nothing. That deliberately includes the case where re-deriving severity
   * TODAY would produce a different answer than it did originally, because the
   * product's scoring config has since changed: silently rewriting a ticket
   * nobody asked to change is a worse surprise than a stale derivation.
   */
  const categoryChanges = args.category !== undefined && args.category !== row.category;
  const severityChanges = args.severity !== undefined && args.severity !== row.severity;

  if (!categoryChanges && !severityChanges) {
    const ticket = await findTicket(tx, row.id);
    if (!ticket) throw notFound();
    return { kind: 'noop', ticket };
  }

  const nextCategory = args.category !== undefined ? args.category : row.category;

  // ── 4. The deterministic engine ───────────────────────────────────────
  /**
   * ⚠️ `determinePriority`, NOT `decide`.
   *
   * `decide` additionally computes the routing band and the composite
   * confidence, both of which are statements about the MODEL's confidence in
   * its own output. Neither has any meaning for a human decision, and
   * recomputing a routing band from a human correction would be inventing a
   * confidence signal for a judgement that did not come from a model.
   *
   * `scoring` is deliberately not passed, so DEFAULT_SCORING applies — exactly
   * as it does on the AI path, which also omits it.
   */
  const inputs = engineInputsFrom(row.ai_classification);
  let derivedPriority: Priority | null = null;
  let derivedSeverity: Severity | null = null;

  if (inputs && nextCategory !== null) {
    const result = determinePriority({
      factors: inputs.factors,
      issue_type: inputs.issue_type,
      category: nextCategory,
      impact: inputs.impact,
      impacts: config.impacts ?? DEFAULT_IMPACTS,
      core_categories: config.core_categories ?? DEFAULT_CORE_CATEGORIES,
    });
    derivedPriority = result.priority;
    derivedSeverity = PRIORITY_TO_SEVERITY[result.priority];
  }

  /**
   * A ticket that was never classified has no factors, so the engine cannot
   * run and there is nothing to derive. Requiring an explicit severity is the
   * honest answer; inventing factors to make the engine produce something
   * would be fabricating the input to a deterministic decision.
   */
  if (derivedSeverity === null && args.severity === undefined) {
    throw new AppError(
      'invalid_request',
      'This ticket has no AI classification, so severity cannot be derived. Supply a severity explicitly.',
      { fields: { severity: ['Required for a ticket with no AI classification.'] } },
    );
  }

  const storedSeverity: Severity = args.severity ?? (derivedSeverity as Severity);
  const severityOverridden =
    args.severity !== undefined && derivedSeverity !== null && args.severity !== derivedSeverity;

  // ── 5. Compare-and-set ────────────────────────────────────────────────
  /**
   * ⚠️ THE GUARD IS THE THREE CLASSIFICATION FIELDS, NOT `updated_at`.
   *
   * `updated_at` moves on status changes and assignment too, so using it would
   * reject a correction because someone else replied to the ticket — a
   * conflict that is not a conflict. Guarding on the exact fields at stake
   * means a 409 happens when, and only when, the classification itself moved
   * under the reviewer.
   *
   * `IS NOT DISTINCT FROM` rather than `=`: category and severity are nullable
   * on an unclassified ticket, and `NULL = NULL` is NULL, which would fail the
   * guard for every such row.
   *
   * Same technique as `applyClassification` and `applyEmbedding`. No new
   * locking primitive, no version column.
   */
  const updated = await tx.query(
    `UPDATE ticket
        SET category              = $2,
            severity              = $3,
            classification_source = 'human',
            updated_at            = now()
      WHERE id = $1
        AND category              IS NOT DISTINCT FROM $4
        AND severity              IS NOT DISTINCT FROM $5
        AND classification_source = $6`,
    [
      row.id,
      nextCategory,
      storedSeverity,
      args.expected.category,
      args.expected.severity,
      args.expected.classification_source,
    ],
  );

  if ((updated.rowCount ?? 0) === 0) {
    /**
     * 409 rather than 404 or 400: the request was well formed and the ticket is
     * visible, but the resource is no longer in the state the caller assumed.
     * `invalid_state_transition` is the code the ticket state machine already
     * uses for exactly that shape of refusal, so no new vocabulary is added.
     *
     * Nothing was written, so nothing is audited. A correction that did not
     * happen must leave no trace claiming it did.
     */
    throw new AppError(
      'invalid_state_transition',
      "This ticket's classification changed while you were reviewing it. Reload and try again.",
    );
  }

  // ── 6. Audit, in the same transaction ─────────────────────────────────
  /**
   * EXACTLY ONE EVENT PER CORRECTION, never one per field. A reviewer changing
   * category and severity together made ONE decision, and splitting it into two
   * rows would make the audit trail imply two.
   *
   * `before` comes from the row Core read, not from `expected` — the caller's
   * copy is a claim, and the audit records what was actually true.
   *
   * No subject, no description, no raiser identity. The classification is the
   * subject of this event; the customer's words are not.
   */
  const audit: CorrectionAudit = {
    before: {
      category: row.category,
      severity: row.severity,
      classification_source: row.classification_source,
    },
    after: {
      category: nextCategory,
      severity: storedSeverity,
      classification_source: 'human',
      derived_priority: derivedPriority,
      derived_severity: derivedSeverity,
      severity_overridden: severityOverridden,
      ...(inputs === null ? { reason: 'no_ai_factors' as const } : {}),
    },
  };

  await writeAudit(tx, ctx, {
    action: 'ticket.classification_corrected',
    entityType: 'ticket',
    entityId: row.id,
    productId: row.product_id,
    before: audit.before,
    after: audit.after,
    sourceIp: args.sourceIp ?? null,
  });

  const ticket = await findTicket(tx, row.id);
  if (!ticket) throw notFound();
  return { kind: 'corrected', ticket, audit };
}
