-- ─────────────────────────────────────────────────────────────────────────
-- 017 — Governance foundation: make ai_execution.confidence authoritative
--
-- Pre-Phase-17 hardening, finding G-1.
--
-- THE PROBLEM
--
-- `ai_execution.confidence` was NULL in all 12,787 rows. Not because the value
-- did not exist, but because Core stored `req.result.confidence` — which
-- `ai-service/src/api/features.py` deliberately sets to None for every feature:
--
--   "The weakest-link composite is computed by CORE, from these same numbers.
--    Reporting one here too would be a second source of truth for a value Core
--    must own."
--
-- Core computed the composite, wrote it into `result.decision`, and then stored
-- Python's null in the column designed to hold it. The forward fix is in
-- ai.service.ts. This migration makes the historical rows agree with it.
--
-- ⚠️ THIS IS A PROJECTION, NOT A RECONSTRUCTION.
--
-- Every value written here already exists in the SAME ROW, at
-- `result->'decision'->>'composite_confidence'`, put there by Core's own
-- deterministic `compositeConfidence()` at the time the execution completed. It
-- is copied, not recomputed and not inferred. If the formula changes tomorrow,
-- these rows still carry what was actually decided then — which is what a
-- governance record is for.
--
-- Nothing is invented. Rows with no `decision` (summary, noop, failures, and
-- one classification row that predates the decision payload) keep NULL, and
-- NULL keeps its meaning: this feature produces no comparable scalar.
--
-- ⚠️ NON-DESTRUCTIVE. `WHERE confidence IS NULL` means an existing value can
-- never be overwritten, so re-running is a no-op and no history is rewritten.
-- The DELETE prohibition from 013 is untouched.
--
-- WHY BACKFILL AT ALL, rather than leaving history NULL:
--
-- The alternative is a column that means "populated only after September 2026"
-- and analytics that must read two places depending on the row's age. The
-- Phase 17 audit was explicit that confidence must have ONE source. This makes
-- the column that source for every row where the value legitimately exists.
-- ─────────────────────────────────────────────────────────────────────────

UPDATE ai_execution
   SET confidence = (result -> 'decision' ->> 'composite_confidence')::numeric
 WHERE confidence IS NULL
   AND result -> 'decision' ? 'composite_confidence'
   -- Belt and braces: the composite is a [0,1] weakest-link minimum. Anything
   -- outside that is not the value this column is defined to hold, so leave it
   -- NULL and let it be investigated rather than silently stored.
   AND (result -> 'decision' ->> 'composite_confidence') ~ '^0(\.[0-9]+)?$|^1(\.0+)?$';

COMMENT ON COLUMN ai_execution.confidence IS
  'Feature-level scalar confidence, where the feature defines one. Classification: Core''s weakest-link composite (the MINIMUM of the four field confidences the model reported), computed by compositeConfidence() in classification.rules.ts. Summary and noop: NULL — neither produces a comparable scalar. UNCALIBRATED and self-reported: this is a model signal, NOT a probability of correctness. Per-field values remain in result.';
