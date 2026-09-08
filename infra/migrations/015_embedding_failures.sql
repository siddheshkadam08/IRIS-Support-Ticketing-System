-- 015 — Permanent embedding failures
--
-- WHY THIS EXISTS. 014 made "pending" a pure function of the row's own text:
--
--     embedding IS NULL OR embedding_fingerprint IS DISTINCT FROM embedding_content_sha
--
-- which is exactly right for work that will eventually succeed, and exactly
-- wrong for work that never will. A ticket Azure's content filter refuses is a
-- PERMANENT failure — the platform's retry model says permanent errors stop
-- immediately rather than burning attempts — but under 014 alone that row
-- stays pending forever and is re-attempted every cycle, billing a provider
-- call each time and filling the log with a failure nobody can act on.
--
-- So a permanent failure is RECORDED AGAINST THE CONTENT THAT CAUSED IT:
--
--     embedding_error       the stable code ('provider_content_filter', ...)
--     embedding_fingerprint the sha of the text that failed
--
-- and the pending predicate excludes a row whose recorded failure matches its
-- CURRENT content. Editing the text changes `embedding_content_sha`, the match
-- breaks, and the row becomes pending again with no operator action and no
-- separate retry queue — the same mechanism that already detects edits, doing
-- one more job.
--
-- Nothing here retries. It is the absence of a retry, made durable.

BEGIN;

ALTER TABLE ticket     ADD COLUMN IF NOT EXISTS embedding_error text;
ALTER TABLE kb_article ADD COLUMN IF NOT EXISTS embedding_error text;

COMMENT ON COLUMN ticket.embedding_error IS
  'Stable code of a PERMANENT embedding failure for the content in embedding_fingerprint. Suppresses re-attempts until the text changes. NULL means no permanent failure. Never holds provider prose or ticket text.';
COMMENT ON COLUMN kb_article.embedding_error IS
  'Stable code of a PERMANENT embedding failure for the content in embedding_fingerprint. Suppresses re-attempts until the text changes.';

-- Deliberately NOT indexed. These are expected to be rare — zero across the
-- current 120-row corpus — and the pending sweep already scans the partial
-- index from 014. An index on a column that is almost entirely NULL earns
-- nothing and costs every write.

COMMIT;
