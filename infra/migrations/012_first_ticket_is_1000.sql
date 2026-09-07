-- 012 — a new tenant's first ticket should be numbered 1000, not 1001.
--
-- `ticket_seq` holds the LAST issued number, and nextReference() increments
-- before returning — which is the correct concurrency-safe order, because the
-- UPDATE ... RETURNING takes a row lock and two simultaneous raises can never
-- be handed the same number. That is not the bug.
--
-- The bug is the starting value. A default of 1000 means "1000 has already
-- been issued", so the first ticket a tenant ever raises comes out as X-1001
-- and the number 1000 is silently skipped. Every seeded tenant shows it:
-- CARB-1001, ESG-1001, IFIL-1001, IDEA-1001. 999 means "none issued yet; the
-- next one is 1000", which is what an operator reads the default as.
--
-- Only tenants with NO tickets are corrected. A tenant that has already issued
-- references must keep its counter exactly where it is — winding it back would
-- reissue a number that is already printed in somebody's email.

ALTER TABLE product ALTER COLUMN ticket_seq SET DEFAULT 999;

UPDATE product p
   SET ticket_seq = 999
 WHERE p.ticket_seq = 1000
   AND NOT EXISTS (SELECT 1 FROM ticket t WHERE t.product_id = p.id);

COMMENT ON COLUMN product.ticket_seq IS
  'Last issued ticket number for this product. Starts at 999 so the first ticket is <prefix>-1000. See migration 012.';
