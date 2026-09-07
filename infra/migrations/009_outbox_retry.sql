-- 009 — retry scheduling for the outbox
--
-- The drainer needs somewhere to record "don't try this again until X".
-- Without it a failing callback would be retried every poll tick instead of
-- backing off 1s → 5s → 25s → 2m → 10m.

ALTER TABLE event_outbox ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz;
ALTER TABLE event_outbox ADD COLUMN IF NOT EXISTS attempt_count   integer NOT NULL DEFAULT 0;

-- Replaces the plain unpublished index: the drainer always filters on both
-- published_at IS NULL and the retry schedule.
DROP INDEX IF EXISTS outbox_unpublished_idx;
CREATE INDEX IF NOT EXISTS outbox_due_idx
  ON event_outbox (next_attempt_at NULLS FIRST, created_at)
  WHERE published_at IS NULL;
