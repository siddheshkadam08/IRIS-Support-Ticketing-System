-- 019 — human classification review and override
--
-- Phase 20. One constraint, widened by one value.
--
-- NO NEW COLUMNS. NO NEW TABLE. NO NEW INDEX. NO GRANT CHANGES.
--
-- ── WHY THIS IS THE WHOLE MIGRATION ─────────────────────────────────────
--
-- Everything else the feature needs already exists:
--
--   `iris_app` already holds UPDATE on ticket.category, ticket.severity and
--   ticket.classification_source — verified against the live database, not
--   assumed, so no grant is added here. (Contrast migration 018, where the
--   application genuinely could not INSERT and the grant was the point.)
--
--   `ticket.ai_classification` already retains everything needed to re-run the
--   deterministic priority engine after a correction: priority_factors,
--   issue_type, impact, the original category and the original decision. A
--   human correction therefore needs no new storage — it edits the ticket's
--   own columns and leaves the AI's record beside them, untouched.
--
--   The divergence between the two is derivable from what is already stored:
--
--     ticket.severity <> ai_classification->'decision'->>'severity'
--
--   A `severity_source` column would restate what three existing fields imply.
--
-- ── WHY `human` AND NOT `agent` ─────────────────────────────────────────
--
-- The value names WHAT DECIDED, not WHO. The existing members are the same
-- shape: `product` is an integrating system, `ai_auto` and `ai_uncertain` are
-- the model at two confidence bands, `unclassified` is nobody yet. `human` sits
-- in that series; `manager` or `agent` would name a role, and the role that may
-- correct is an authorization question that can change without the meaning of
-- the stored value changing with it.
--
-- ⚠️ THE AI WRITE-ONCE GUARD IS WHAT MAKES THIS SAFE, AND IT IS UNTOUCHED.
--
-- `applyClassification` (tickets/ticket.repo.ts) updates only
-- `WHERE classification_source = 'unclassified'`. Once a human has corrected a
-- ticket the source is `human`, so a late or replayed AI result matches zero
-- rows and cannot overwrite the human decision. That protection is inherited,
-- not added, and no code in Phase 20 modifies it.

ALTER TABLE ticket DROP CONSTRAINT IF EXISTS ticket_classification_source_check;

ALTER TABLE ticket
  ADD CONSTRAINT ticket_classification_source_check
  CHECK (classification_source IN ('product', 'ai_auto', 'ai_uncertain', 'unclassified', 'human'));

COMMENT ON COLUMN ticket.classification_source IS
  'What decided this ticket''s category and severity. unclassified: nobody yet. '
  'product: the integrating system supplied it at creation. ai_auto / ai_uncertain: '
  'the model, at the two confidence bands ADR-005 defines. human: a manager, product '
  'admin or super admin reviewed and corrected it — see audit action '
  'ticket.classification_corrected for the before/after and the actor. The AI writer '
  'only ever moves a row out of ''unclassified'', so it can never overwrite a human.';
