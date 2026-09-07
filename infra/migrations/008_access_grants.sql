-- 008 — just-in-time access grants
--
-- The platform's differentiating feature. Support users hold ZERO standing
-- access to ticket payloads. Assignment grants access on two layers; resolve
-- revokes both. See docs/HLD.md §13 and docs/adr/008-dual-access-mechanism.md

-- ─────────────────────────────────────────────────────────────────────────
-- access_grant
--
-- ONE assignment writes TWO rows:
--   layer='platform'  mechanism='rls'          — enforced here, synchronously
--   layer='product'   mechanism='callback'|'preauth_link'
--                                              — relayed to the product, async
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS access_grant (
  id                  text PRIMARY KEY,
  product_id          text NOT NULL REFERENCES product(id) ON DELETE CASCADE,
  ticket_id           text NOT NULL REFERENCES ticket(id) ON DELETE CASCADE,
  support_user_id     text NOT NULL REFERENCES support_user(id) ON DELETE CASCADE,
  layer               text NOT NULL CHECK (layer IN ('platform','product')),
  mechanism           text NOT NULL CHECK (mechanism IN ('rls','callback','preauth_link')),
  scope_kind          text,          -- section | file | dataset | tenant
  resource_ref        text,          -- chosen by the PRODUCT, never by us
  state               text NOT NULL DEFAULT 'granted'
                        CHECK (state IN ('grant_pending','granted','revoke_pending',
                                         'revoked','grant_failed','revoke_failed')),
  granted_at          timestamptz NOT NULL DEFAULT now(),
  -- min(SLA target, product max_ttl, 72h). Three independent expiries protect
  -- a grant and ANY ONE surviving is sufficient.
  expires_at          timestamptz,
  revoke_due_at       timestamptz,
  revoked_at          timestamptz,
  product_grant_ref   text,          -- the product's own handle for the grant
  activation_response jsonb,
  revoke_response     jsonb,
  attempt_count       integer NOT NULL DEFAULT 0,
  last_error          text,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS grant_ticket_idx  ON access_grant (product_id, ticket_id);
-- The hot path: "does THIS user have an active grant on THIS ticket?" — every
-- comment and attachment read hits this via the RLS policy below.
CREATE INDEX IF NOT EXISTS grant_active_idx  ON access_grant (support_user_id, ticket_id, state)
  WHERE state = 'granted';
CREATE INDEX IF NOT EXISTS grant_pending_idx ON access_grant (state)
  WHERE state IN ('grant_pending','revoke_pending');

-- ─────────────────────────────────────────────────────────────────────────
-- preauth_token — the client-minted capability (ADR-008 mechanism B)
--
-- The product mints this at raise time and it arrives INERT: bound to nobody,
-- usable by nobody. We can only bind it to an assignee and time-box it. We
-- never hold the product's signing key, so a fully compromised platform still
-- cannot fabricate access — it can only replay what the product already minted.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS preauth_token (
  id                    text PRIMARY KEY,
  product_id            text NOT NULL REFERENCES product(id) ON DELETE CASCADE,
  ticket_id             text NOT NULL REFERENCES ticket(id) ON DELETE CASCADE,
  token_ciphertext      text NOT NULL,   -- opaque + product-signed; encrypted at rest, never logged
  scope_kind            text,
  resource_ref          text,
  max_ttl_seconds       integer NOT NULL DEFAULT 86400,
  launch_url_template   text,
  bound_support_user_id text REFERENCES support_user(id),
  state                 text NOT NULL DEFAULT 'inert'
                          CHECK (state IN ('inert','active','expired','revoked')),
  bound_at              timestamptz,
  expires_at            timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS preauth_ticket_idx ON preauth_token (product_id, ticket_id);

-- ─────────────────────────────────────────────────────────────────────────
-- delivery_log — every outbound attempt, for webhooks and access callbacks
--
-- This is the ledger that answers "did the product actually receive the
-- revoke?" and it is what the Ticket Detail timeline renders, including the
-- product's own response body and latency.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS delivery_log (
  id            bigserial PRIMARY KEY,
  product_id    text NOT NULL REFERENCES product(id) ON DELETE CASCADE,
  channel       text NOT NULL,     -- webhook | access_callback | email | slack
  event_id      text,
  target        text,
  attempt       integer NOT NULL DEFAULT 1,
  status_code   integer,
  ok            boolean NOT NULL DEFAULT false,
  response_body text,
  error         text,
  latency_ms    integer,
  attempted_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS delivery_event_idx   ON delivery_log (event_id, attempted_at);
CREATE INDEX IF NOT EXISTS delivery_product_idx ON delivery_log (product_id, attempted_at DESC);

-- ── RLS ──────────────────────────────────────────────────────────────────
ALTER TABLE access_grant  ENABLE ROW LEVEL SECURITY;
ALTER TABLE access_grant  FORCE  ROW LEVEL SECURITY;
ALTER TABLE preauth_token ENABLE ROW LEVEL SECURITY;
ALTER TABLE preauth_token FORCE  ROW LEVEL SECURITY;
ALTER TABLE delivery_log  ENABLE ROW LEVEL SECURITY;
ALTER TABLE delivery_log  FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS grant_isolation ON access_grant;
CREATE POLICY grant_isolation ON access_grant
  USING (product_id = ANY (app_scope()) OR app_role() = 'super_admin')
  WITH CHECK (product_id = ANY (app_scope()) OR app_role() = 'super_admin');

DROP POLICY IF EXISTS preauth_isolation ON preauth_token;
CREATE POLICY preauth_isolation ON preauth_token
  USING (product_id = ANY (app_scope()) OR app_role() = 'super_admin')
  WITH CHECK (product_id = ANY (app_scope()) OR app_role() = 'super_admin');

DROP POLICY IF EXISTS delivery_isolation ON delivery_log;
CREATE POLICY delivery_isolation ON delivery_log
  USING (product_id = ANY (app_scope()) OR app_role() = 'super_admin')
  WITH CHECK (true);

-- ─────────────────────────────────────────────────────────────────────────
-- Helper: does the current actor hold an active platform grant on a ticket?
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION has_active_grant(p_ticket_id text) RETURNS boolean
  LANGUAGE sql STABLE AS
$$
  SELECT EXISTS (
    SELECT 1 FROM access_grant g
     WHERE g.ticket_id       = p_ticket_id
       AND g.support_user_id = app_support_user()
       AND g.layer           = 'platform'
       AND g.state           = 'granted'
       AND (g.expires_at IS NULL OR g.expires_at > now())
  )
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- T1 gating, now actually enforced.
--
-- Previously ANY agent in scope could read EVERY comment in that product —
-- which is standing access, exactly what the design says we do not have.
-- An agent now needs an active grant on that specific ticket.
--
-- product_admin / manager / super_admin keep policy-level visibility: they
-- triage and supervise, and their reads are audited like everyone else's.
-- ─────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS comment_isolation ON comment;
CREATE POLICY comment_isolation ON comment
  USING (
    (product_id = ANY (app_scope()) OR app_role() = 'super_admin')
    AND (
      app_role() IN ('super_admin','product_admin','manager')
      OR (app_role() = 'agent' AND has_active_grant(comment.ticket_id))
      OR (
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

DROP POLICY IF EXISTS attachment_isolation ON attachment;
CREATE POLICY attachment_isolation ON attachment
  USING (
    (product_id = ANY (app_scope()) OR app_role() = 'super_admin')
    AND (
      app_role() IN ('super_admin','product_admin','manager')
      OR (app_role() = 'agent' AND ticket_id IS NOT NULL AND has_active_grant(attachment.ticket_id))
      OR (
        app_role() = 'raiser'
        AND ticket_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM ticket t
                     WHERE t.id = attachment.ticket_id AND t.raised_by_ref = app_raiser())
      )
      OR (app_role() = 'product' AND ticket_id IS NOT NULL)
      OR ticket_id IS NULL   -- freshly uploaded, not yet linked to a ticket
    )
  )
  WITH CHECK (product_id = ANY (app_scope()));

GRANT SELECT, INSERT, UPDATE, DELETE ON access_grant, preauth_token, delivery_log TO iris_app;
GRANT USAGE, SELECT ON SEQUENCE delivery_log_id_seq TO iris_app;
