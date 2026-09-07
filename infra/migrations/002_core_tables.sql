-- 002 — product, support users, tickets, comments, attachments

CREATE TABLE IF NOT EXISTS product (
  id                    text PRIMARY KEY,
  slug                  text NOT NULL UNIQUE,
  name                  text NOT NULL,
  ref_prefix            text NOT NULL,              -- CARB → CARB-1042. Per-product, never a global sequence.
  ticket_seq            integer NOT NULL DEFAULT 1000,
  client_id             text NOT NULL UNIQUE,
  client_secret_hash    text NOT NULL,
  publishable_key       text NOT NULL UNIQUE,
  webhook_url           text,
  webhook_secret_hash   text,
  access_callback_url   text,
  access_mechanism      text NOT NULL DEFAULT 'preauth'
                          CHECK (access_mechanism IN ('callback','preauth','both')),
  jwks_url              text,
  jwks_inline           jsonb,                      -- registered static JWK; avoids needing a second server locally
  allowed_issuers       text[] NOT NULL DEFAULT '{}',
  allowed_origins       text[] NOT NULL DEFAULT '{}',
  api_version_pin       text NOT NULL DEFAULT 'v1',
  config                jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_active             boolean NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS support_user (
  id            text PRIMARY KEY,
  email         text NOT NULL UNIQUE,
  display_name  text NOT NULL,
  password_hash text,
  role          text NOT NULL DEFAULT 'agent'
                  CHECK (role IN ('super_admin','product_admin','manager','agent')),
  availability  text NOT NULL DEFAULT 'available'
                  CHECK (availability IN ('available','busy','away')),
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS support_user_skill (
  support_user_id text NOT NULL REFERENCES support_user(id) ON DELETE CASCADE,
  skill           text NOT NULL,
  proficiency     smallint NOT NULL DEFAULT 3 CHECK (proficiency BETWEEN 1 AND 5),
  PRIMARY KEY (support_user_id, skill)
);

CREATE TABLE IF NOT EXISTS ticket (
  id                    text PRIMARY KEY,
  product_id            text NOT NULL REFERENCES product(id) ON DELETE CASCADE,
  reference             text NOT NULL,
  product_tenant_id     text NOT NULL,
  raised_by_ref         text NOT NULL,
  raiser_identity       jsonb NOT NULL DEFAULT '{}'::jsonb,  -- snapshot: survives the product's IdP going down
  identity_assurance    text NOT NULL DEFAULT 'sso'
                          CHECK (identity_assurance IN ('sso','email_verified','anonymous')),
  subject               text,
  description           text NOT NULL,
  category              text,
  severity              text CHECK (severity IN ('low','medium','high','critical')),
  status                text NOT NULL DEFAULT 'open'
                          CHECK (status IN ('open','assigned','in_progress','waiting_on_raiser','resolved','closed')),
  classification_source text NOT NULL DEFAULT 'unclassified'
                          CHECK (classification_source IN ('product','ai_auto','ai_uncertain','unclassified')),
  ai_classification     jsonb,
  summary               text,
  assignee_id           text REFERENCES support_user(id),
  conversation_id       text,
  rating                smallint CHECK (rating BETWEEN 1 AND 5),
  rating_comment        text,
  sentiment             text,
  metadata              jsonb NOT NULL DEFAULT '{}'::jsonb,
  embedding             vector(384),                 -- populated by ai-service later
  raised_at             timestamptz NOT NULL DEFAULT now(),
  first_response_at     timestamptz,                 -- first NON-INTERNAL support comment. Locked definition (ADR-006)
  assigned_at           timestamptz,
  resolved_at           timestamptz,
  closed_at             timestamptz,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  search_tsv            tsvector GENERATED ALWAYS AS (
                          to_tsvector('english'::regconfig,
                            coalesce(subject,'') || ' ' || coalesce(description,''))
                        ) STORED,
  UNIQUE (product_id, reference)
);

-- Every index on a product-scoped table LEADS with product_id — RLS adds a
-- predicate on it to every single query.
CREATE INDEX IF NOT EXISTS ticket_product_raised_idx  ON ticket (product_id, raised_at DESC);
CREATE INDEX IF NOT EXISTS ticket_product_status_idx  ON ticket (product_id, status);
CREATE INDEX IF NOT EXISTS ticket_product_raiser_idx  ON ticket (product_id, raised_by_ref, raised_at DESC);
CREATE INDEX IF NOT EXISTS ticket_product_updated_idx ON ticket (product_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS ticket_search_idx          ON ticket USING gin (search_tsv);

CREATE TABLE IF NOT EXISTS comment (
  id          text PRIMARY KEY,
  product_id  text NOT NULL REFERENCES product(id) ON DELETE CASCADE,
  ticket_id   text NOT NULL REFERENCES ticket(id) ON DELETE CASCADE,
  author_type text NOT NULL CHECK (author_type IN ('raiser','assignee','system')),
  author_ref  text,
  author_name text,
  body        text NOT NULL,
  is_internal boolean NOT NULL DEFAULT false,   -- never leaves the platform
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS comment_product_ticket_idx ON comment (product_id, ticket_id, created_at);

CREATE TABLE IF NOT EXISTS attachment (
  id           text PRIMARY KEY,
  product_id   text NOT NULL REFERENCES product(id) ON DELETE CASCADE,
  ticket_id    text REFERENCES ticket(id) ON DELETE CASCADE,
  comment_id   text REFERENCES comment(id) ON DELETE CASCADE,
  blob_key     text NOT NULL,
  filename     text NOT NULL,
  content_type text NOT NULL,
  size_bytes   bigint NOT NULL,
  uploaded_by  text,
  scan_status  text NOT NULL DEFAULT 'skipped',
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS attachment_product_ticket_idx ON attachment (product_id, ticket_id);
