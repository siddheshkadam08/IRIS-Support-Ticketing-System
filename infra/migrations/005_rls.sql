-- 005 — Row-Level Security
--
-- This file IS the isolation guarantee. Everything else is defence in depth.
--
-- Session GUCs set by core-service/src/db/with-scope.ts, via SET LOCAL inside a
-- transaction (never plain SET — that persists for the life of a pooled
-- connection and leaks request A's scope into request B):
--
--   app.product_scope   comma-joined product ids the actor may see
--   app.role            product | raiser | agent | manager | product_admin | super_admin
--   app.raiser_ref      the end user's opaque `sub`, when role = 'raiser'
--   app.support_user_id when the actor is support staff
--   app.request_id      correlation only
--
-- If a GUC is unset, current_setting(...,true) returns NULL, string_to_array
-- returns NULL, and `= ANY(NULL)` is NULL → the policy denies. Fails CLOSED.

CREATE OR REPLACE FUNCTION app_scope() RETURNS text[]
  LANGUAGE sql STABLE AS
$$ SELECT string_to_array(nullif(current_setting('app.product_scope', true), ''), ',') $$;

CREATE OR REPLACE FUNCTION app_role() RETURNS text
  LANGUAGE sql STABLE AS
$$ SELECT coalesce(nullif(current_setting('app.role', true), ''), 'none') $$;

CREATE OR REPLACE FUNCTION app_raiser() RETURNS text
  LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('app.raiser_ref', true), '') $$;

CREATE OR REPLACE FUNCTION app_support_user() RETURNS text
  LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('app.support_user_id', true), '') $$;

-- ── product ──────────────────────────────────────────────────────────────
ALTER TABLE product ENABLE ROW LEVEL SECURITY;
ALTER TABLE product FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS product_scope ON product;
CREATE POLICY product_scope ON product
  USING (id = ANY (app_scope()) OR app_role() = 'super_admin');

-- ── ticket ───────────────────────────────────────────────────────────────
-- A raiser sees ONLY their own tickets, enforced here rather than in app code.
-- That is what makes a scraped publishable key a nuisance and not a breach.
ALTER TABLE ticket ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ticket_isolation ON ticket;
CREATE POLICY ticket_isolation ON ticket
  USING (
    (product_id = ANY (app_scope()) OR app_role() = 'super_admin')
    AND (app_role() <> 'raiser' OR raised_by_ref = app_raiser())
  )
  WITH CHECK (
    product_id = ANY (app_scope())
    AND (app_role() <> 'raiser' OR raised_by_ref = app_raiser())
  );

-- ── comment ──────────────────────────────────────────────────────────────
-- is_internal comments are invisible to products and raisers, at the database.
-- Filtering them in application code alone is how an internal note reaches a
-- customer.
ALTER TABLE comment ENABLE ROW LEVEL SECURITY;
ALTER TABLE comment FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS comment_isolation ON comment;
CREATE POLICY comment_isolation ON comment
  USING (
    (product_id = ANY (app_scope()) OR app_role() = 'super_admin')
    AND (
      app_role() IN ('super_admin','product_admin','manager','agent')
      OR (
        -- product / raiser: non-internal only, and raisers only on their own tickets
        is_internal = false
        AND EXISTS (
          SELECT 1 FROM ticket t
          WHERE t.id = comment.ticket_id
            AND (app_role() <> 'raiser' OR t.raised_by_ref = app_raiser())
        )
      )
    )
  )
  WITH CHECK (product_id = ANY (app_scope()));

-- ── attachment ───────────────────────────────────────────────────────────
ALTER TABLE attachment ENABLE ROW LEVEL SECURITY;
ALTER TABLE attachment FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS attachment_isolation ON attachment;
CREATE POLICY attachment_isolation ON attachment
  USING (
    (product_id = ANY (app_scope()) OR app_role() = 'super_admin')
    AND (
      app_role() <> 'raiser'
      OR ticket_id IS NULL
      OR EXISTS (SELECT 1 FROM ticket t
                 WHERE t.id = attachment.ticket_id AND t.raised_by_ref = app_raiser())
    )
  )
  WITH CHECK (product_id = ANY (app_scope()));

-- ── knowledge base ───────────────────────────────────────────────────────
-- Products and raisers see published, public articles only. Drafts never leak.
ALTER TABLE kb_article ENABLE ROW LEVEL SECURITY;
ALTER TABLE kb_article FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS kb_isolation ON kb_article;
CREATE POLICY kb_isolation ON kb_article
  USING (
    (product_id = ANY (app_scope()) OR app_role() = 'super_admin')
    AND (
      app_role() IN ('super_admin','product_admin','manager','agent')
      OR (status = 'published' AND is_public = true)
    )
  )
  WITH CHECK (product_id = ANY (app_scope()));

-- ── announcement ─────────────────────────────────────────────────────────
ALTER TABLE announcement ENABLE ROW LEVEL SECURITY;
ALTER TABLE announcement FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS announcement_isolation ON announcement;
CREATE POLICY announcement_isolation ON announcement
  USING (
    (product_id = ANY (app_scope()) OR app_role() = 'super_admin')
    AND (app_role() IN ('super_admin','product_admin','manager','agent') OR is_active = true)
  )
  WITH CHECK (product_id = ANY (app_scope()));

-- ── widget_conversation ──────────────────────────────────────────────────
ALTER TABLE widget_conversation ENABLE ROW LEVEL SECURITY;
ALTER TABLE widget_conversation FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS conversation_isolation ON widget_conversation;
CREATE POLICY conversation_isolation ON widget_conversation
  USING (
    (product_id = ANY (app_scope()) OR app_role() = 'super_admin')
    AND (app_role() <> 'raiser' OR raised_by_ref IS NOT DISTINCT FROM app_raiser())
  )
  WITH CHECK (product_id = ANY (app_scope()));

-- ── support_user ─────────────────────────────────────────────────────────
-- Not product-scoped, but a raiser must never enumerate staff.
ALTER TABLE support_user ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_user FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS support_user_visibility ON support_user;
CREATE POLICY support_user_visibility ON support_user
  USING (app_role() IN ('super_admin','product_admin','manager','agent'));

-- ── audit_event ──────────────────────────────────────────────────────────
ALTER TABLE audit_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_event FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS audit_isolation ON audit_event;
CREATE POLICY audit_isolation ON audit_event
  USING (
    (product_id = ANY (app_scope()) OR app_role() = 'super_admin')
    -- A product may read its own audit trail — GET /v1/tickets/{id}/history is
    -- a published, product-facing endpoint. An end user may not: the trail
    -- includes internal actor references and support-side actions.
    AND app_role() <> 'raiser'
  )
  WITH CHECK (true);   -- anyone may append; nobody may rewrite (see grants)

-- ── event_outbox ─────────────────────────────────────────────────────────
ALTER TABLE event_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_outbox FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS outbox_isolation ON event_outbox;
CREATE POLICY outbox_isolation ON event_outbox
  USING (app_role() = 'super_admin' OR product_id = ANY (app_scope()))
  WITH CHECK (true);
