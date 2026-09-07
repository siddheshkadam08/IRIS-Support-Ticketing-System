-- 003 — knowledge base, announcements, widget conversations

CREATE TABLE IF NOT EXISTS kb_article (
  id            text PRIMARY KEY,
  product_id    text NOT NULL REFERENCES product(id) ON DELETE CASCADE,
  title         text NOT NULL,
  body          text NOT NULL,
  category      text,
  status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
  is_public     boolean NOT NULL DEFAULT true,   -- exposed to the widget via the publishable key
  views         integer NOT NULL DEFAULT 0,
  helpful_yes   integer NOT NULL DEFAULT 0,
  helpful_no    integer NOT NULL DEFAULT 0,
  embedding     vector(384),                     -- populated by ai-service later
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  -- Title weighted 'A', body 'B': a title match should outrank a body mention.
  search_tsv    tsvector GENERATED ALWAYS AS (
                  setweight(to_tsvector('english'::regconfig, coalesce(title,'')), 'A') ||
                  setweight(to_tsvector('english'::regconfig, coalesce(body,'')),  'B')
                ) STORED
);
CREATE INDEX IF NOT EXISTS kb_product_status_idx ON kb_article (product_id, status);
CREATE INDEX IF NOT EXISTS kb_search_idx         ON kb_article USING gin (search_tsv);
CREATE INDEX IF NOT EXISTS kb_title_trgm_idx     ON kb_article USING gin (title gin_trgm_ops);

CREATE TABLE IF NOT EXISTS announcement (
  id           text PRIMARY KEY,
  product_id   text NOT NULL REFERENCES product(id) ON DELETE CASCADE,
  title        text NOT NULL,
  body         text NOT NULL,
  kind         text NOT NULL DEFAULT 'info' CHECK (kind IN ('info','maintenance','incident','release')),
  is_active    boolean NOT NULL DEFAULT true,
  published_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS announcement_product_idx ON announcement (product_id, published_at DESC);

-- ─────────────────────────────────────────────────────────────────────────
-- The SOLE source of the "Self-Served" metric.
--
-- outcome='self_served' means the user got an answer and NEVER filed a ticket.
-- This table counts conversations, never tickets. Deflection is not
-- auto-resolution — see docs/adr/009-deflection-is-not-auto-resolution.md
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS widget_conversation (
  id                text PRIMARY KEY,
  product_id        text NOT NULL REFERENCES product(id) ON DELETE CASCADE,
  product_tenant_id text,
  raised_by_ref     text,
  turns             jsonb NOT NULL DEFAULT '[]'::jsonb,
  outcome           text NOT NULL DEFAULT 'abandoned'
                      CHECK (outcome IN ('self_served','ticket_created','abandoned')),
  ticket_id         text REFERENCES ticket(id) ON DELETE SET NULL,
  started_at        timestamptz NOT NULL DEFAULT now(),
  ended_at          timestamptz
);
CREATE INDEX IF NOT EXISTS conversation_product_idx ON widget_conversation (product_id, started_at DESC);
CREATE INDEX IF NOT EXISTS conversation_raiser_idx  ON widget_conversation (product_id, raised_by_ref);
