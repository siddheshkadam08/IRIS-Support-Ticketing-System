-- 007 — support-user authentication and tenant scoping
--
-- This is the migration that makes the platform genuinely multi-tenant on the
-- support side. Until now `support_user` had a role but no way to say WHICH
-- tenants that role applied to.

-- ─────────────────────────────────────────────────────────────────────────
-- support_user_scope — the tenant-wise assignment
--
-- A row means "this user may work tickets for this product".
-- A super_admin has NO rows, which means all tenants; that is expressed as a
-- policy branch (app_role() = 'super_admin'), never as a wildcard row, so
-- there is no magic value to leak or mistype.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS support_user_scope (
  support_user_id   text NOT NULL REFERENCES support_user(id) ON DELETE CASCADE,
  product_id        text NOT NULL REFERENCES product(id) ON DELETE CASCADE,
  -- Optional narrowing to a single customer tenant inside the product.
  -- NULL = the whole product.
  product_tenant_id text,
  granted_at        timestamptz NOT NULL DEFAULT now(),
  granted_by        text REFERENCES support_user(id),
  PRIMARY KEY (support_user_id, product_id)
);
CREATE INDEX IF NOT EXISTS scope_by_product_idx ON support_user_scope (product_id);

-- ── support_user: authentication state ───────────────────────────────────
ALTER TABLE support_user ADD COLUMN IF NOT EXISTS last_login_at        timestamptz;
ALTER TABLE support_user ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT false;
ALTER TABLE support_user ADD COLUMN IF NOT EXISTS failed_login_count   integer NOT NULL DEFAULT 0;
ALTER TABLE support_user ADD COLUMN IF NOT EXISTS locked_until         timestamptz;

-- ─────────────────────────────────────────────────────────────────────────
-- product: symmetric secrets, encrypted rather than hashed
--
-- client_secret_hash / webhook_secret_hash are one-way. HMAC is a SYMMETRIC
-- operation — to verify an inbound signature or sign an outbound callback we
-- need the secret itself, which cannot be recovered from a hash. Hashing was
-- the wrong primitive here.
--
-- The hashes stay for cheap constant-time equality checks; the encrypted
-- copies (AES-256-GCM, key from SECRET_ENCRYPTION_KEY) are what actually get
-- used for signing and verification.
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE product ADD COLUMN IF NOT EXISTS client_secret_enc  text;
ALTER TABLE product ADD COLUMN IF NOT EXISTS webhook_secret_enc text;

-- ── RLS ──────────────────────────────────────────────────────────────────
ALTER TABLE support_user_scope ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_user_scope FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS scope_visibility ON support_user_scope;
CREATE POLICY scope_visibility ON support_user_scope
  USING (
    app_role() = 'super_admin'
    -- A product_admin or manager sees scope rows only for tenants they
    -- themselves hold. They cannot enumerate staffing of other tenants.
    OR (app_role() IN ('product_admin', 'manager') AND product_id = ANY (app_scope()))
    -- Anyone may read their own scopes (the portal shows "your tenants").
    OR support_user_id = app_support_user()
  )
  WITH CHECK (app_role() IN ('super_admin', 'product_admin'));

-- support_user was previously readable by any support role. Keep that (the
-- portal needs assignee pickers) but allow writes only to admins.
DROP POLICY IF EXISTS support_user_visibility ON support_user;
CREATE POLICY support_user_visibility ON support_user
  USING (app_role() IN ('super_admin', 'product_admin', 'manager', 'agent'))
  WITH CHECK (app_role() IN ('super_admin', 'product_admin'));

GRANT SELECT, INSERT, UPDATE, DELETE ON support_user_scope TO iris_app;
-- The runtime now manages support users (create, role change, lockout).
GRANT INSERT, UPDATE ON support_user TO iris_app;
GRANT UPDATE (client_secret_enc, webhook_secret_enc, webhook_url,
              access_callback_url, access_mechanism, config,
              allowed_origins, allowed_issuers, jwks_url, is_active)
  ON product TO iris_app;
GRANT INSERT ON product TO iris_app;
