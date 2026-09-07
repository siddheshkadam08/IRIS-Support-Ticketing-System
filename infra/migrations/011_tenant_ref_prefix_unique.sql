-- 011 — a ticket prefix must identify exactly one tenant.
--
-- Human-facing references are `<prefix>-<per-product sequence>`: CARB-1042.
-- The sequence is per product, so two products sharing a prefix produce two
-- different tickets both called CARB-1042. Every reference a human quotes —
-- in an email, on a call, in an escalation — becomes ambiguous, and there is
-- no way to repair it after the fact because the references are already out
-- in the world.
--
-- `slug` and `publishable_key` were already unique; `ref_prefix` was not, so
-- the admin portal happily onboarded a second tenant with prefix CARB. Caught
-- while reproducing a tenant-creation failure.

ALTER TABLE product ADD CONSTRAINT product_ref_prefix_key UNIQUE (ref_prefix);

COMMENT ON CONSTRAINT product_ref_prefix_key ON product IS
  'Ticket references (CARB-1042) must resolve to one tenant. See migration 011.';
