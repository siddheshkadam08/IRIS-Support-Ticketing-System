# SKILLS.md — infra

**One command from a cold machine to a working demo.** Compose stack, nginx, migrations, seed data.

> Read [/SKILLS.md](../SKILLS.md) and [port-mapping.md](../docs/port-mapping.md) first.

| | |
|---|---|
| **Contents** | `docker-compose.yml` · `nginx/` · `migrations/` · `seed/` · `helm/` (stub) |
| **Target** | Local dev and the demo VM. Production Helm is **not built** |

---

## 0. Runtime: Podman, not Docker

**Correction to an earlier note in this repo:** the Docker CLI is absent on this machine, but **Podman 5.8.3 is installed and working**, along with `podman-compose`. Everything here runs on it.

```powershell
podman-compose -f infra/podman-compose.yml up -d
podman ps
podman logs iris-postgres
podman-compose -f infra/podman-compose.yml down -v   # wipe volumes
```

Verified: `node v22.17.0` ✅ · `python 3.12.4` ✅ · `podman 5.8.3` ✅ · `docker` ❌ (not needed).

**Do not touch the native Windows PostgreSQL 18 on port 5433.** It belongs to the machine, cannot take pgvector without a toolchain we do not have, and this project runs its own container on 5432 instead.

---

## 1. Non-negotiables

### 🔒 Internal services are never published

```yaml
core-service:
  # NO ports: stanza. Reachable only as http://core-service:4100 on the compose network.
gateway:
  ports: ["4000:4000"]   # public — this is the API surface
```

**No `ports:` for:** `core-service`, `ai-service`, `notification-service`, `postgres`, `redis`, `minio`.

> An exposed Postgres is the single most common accidental security hole in hackathon demos, and it is a one-line mistake. A PR adding a `ports:` line to an internal service needs an explicit justification in the description.

### 🔒 Services address each other by compose service name

`http://core-service:4100`, never `http://localhost:4100`. Inside a container, `localhost` is the container itself — a sample product calling `localhost:4000` reaches itself, not the gateway. This wastes an hour every time, and it always looks like a networking problem rather than a naming one.

### 🔒 The app connects as a non-owner role

```sql
CREATE ROLE iris_migrator LOGIN PASSWORD :'migrator_pw';  -- owns tables, runs DDL
CREATE ROLE iris_app      LOGIN PASSWORD :'app_pw';       -- app runtime, RLS APPLIES
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO iris_app;
REVOKE UPDATE, DELETE ON audit_event FROM iris_app;       -- append-only, enforced by the DB
```

Never `SUPERUSER`, never `BYPASSRLS`. **In Postgres, table owners bypass RLS by default** — if the app connects as the owner, every RLS policy is decorative and the platform's central security claim is false with no error anywhere.

---

## 2. Compose stack

| Service | Published? | Notes |
|---|---|---|
| `nginx` | ✅ 80/443 | Only public entry: static admin-panel + widget, proxy to gateway |
| `gateway` | ✅ 4000 | `/v1/*` and `/admin/*` |
| `admin-panel` | ✅ 3000 (dev only) | Static via nginx in prod |
| `core-service` | ❌ | 4100 internal |
| `ai-service` | ❌ | 5000 internal |
| `notification-service` | ❌ | 5100 internal |
| `worker` | ❌ | No port |
| `postgres` (pgvector) | ❌ | 5432 internal |
| `redis` | ❌ | 6379 internal |
| `minio` | ❌ | 9000/9001 internal |
| `mailhog` | ✅ 8025 (dev only) | Email inbox for local dev |

**Every service needs a `healthcheck` and `depends_on: condition: service_healthy`.** Without it, `core-service` races Postgres on boot and fails in a way that looks like a code bug. This costs ten minutes to add and saves the demo.

---

## 3. Port discipline

Authoritative table: [port-mapping.md](../docs/port-mapping.md).

> ### ⚠️ Port 6000 is unusable — do not revert it
> Chrome and Firefox **hard-refuse** port 6000 (`ERR_UNSAFE_PORT`, reserved for X11). Sample product-a was moved to **6001**, product-b to **6101**. If anyone reverts this, product-a becomes unreachable in a browser with an error that reads as a network failure.

**Windows:** Hyper-V/WinNAT reserves dynamic TCP ranges that silently swallow ports.

```powershell
netsh int ipv4 show excludedportrange protocol=tcp
# if a needed port is inside a range:
net stop winnat; docker compose up -d; net start winnat
```

---

## 4. Migrations

**Forward-only, numbered, idempotent.** No down-migrations — in practice they are written once, never tested, and fail when finally needed.

```
migrations/
  0001_extensions.sql        pgvector, pgcrypto
  0002_roles.sql             iris_app, iris_migrator, grants
  0003_product.sql
  0004_ticket.sql
  0005_rls_policies.sql      ← ENABLE + FORCE on every product-scoped table
  ...
```

### Every product-scoped table needs all four

```sql
CREATE TABLE ticket ( id text PRIMARY KEY, product_id text NOT NULL REFERENCES product(id), ... );
CREATE INDEX ON ticket (product_id, raised_at DESC);      -- 1. every index leads with product_id
ALTER TABLE ticket ENABLE ROW LEVEL SECURITY;             -- 2.
ALTER TABLE ticket FORCE  ROW LEVEL SECURITY;             -- 3. applies to the owner too
CREATE POLICY ticket_isolation ON ticket                  -- 4.
  USING (product_id = ANY (string_to_array(current_setting('app.product_scope', true), ',')));
```

**CI fails a migration that creates a product-scoped table without all four.** Write that check early — it is the cheapest possible defence of the isolation claim.

Rules: never edit a committed migration (add a new one); always `IF NOT EXISTS` / `ON CONFLICT DO NOTHING`; test on a **fresh** database and on one with existing data.

---

## 5. Seed data

`npm run seed` must produce a **demo-ready** system, not an empty one.

| Seeds | Why |
|---|---|
| 2 products (CARBON, iFile) with distinct branding, categories, and **different access mechanisms** | Callback vs pre-auth — proves both, per [ui-spec-deltas](../docs/ui-spec-deltas.md) |
| 4 support users, one per role, with skills and scopes | Demonstrates RBAC and the isolation tests |
| ~120 historical tickets with ratings, TAT spread, resolved/closed mix | **Analytics charts need real distributions.** Three data points read as broken |
| The pre-seeded ambiguous ticket (`p1=0.60`, margin `0.25`) | The brief's 60/35 example, demoed live |
| KB articles | Deflection has nothing to deflect to without them |
| AI training + eval sets | **Synthetic or anonymised only** — never real customer data |

**Seed must be idempotent and re-runnable.** `docker compose down -v && up && migrate && seed` is the demo reset path and gets run under pressure — time it and know the number.

---

## 6. nginx

- Serves `admin-panel` static build and `widget.js` (versioned, immutable, long cache; the `widget.js` alias short-cached).
- Proxies `/v1/*` and `/admin/*` → `gateway:4000`. **Everything else 404s** — no catch-all proxy.
- **CORS for widget assets only.** The API's origin allowlist is enforced at the gateway, not here.
- Sets `X-Content-Type-Options: nosniff`, `X-Frame-Options` (except widget routes, which need framing), and CSP.
- **Attachments served from a separate origin**, always `Content-Disposition: attachment`. Never inline — an SVG rendered inline in the admin panel is stored XSS in a super-admin session.
- Forwards/generates `X-Request-Id`.

---

## 7. Helm

`helm/` is a **stub with a README** stating the intended AKS shape. It is deliberately not built.

> Claiming Kubernetes readiness we have not tested is worse than saying "compose today, charts sketched." Judges ask; the honest answer scores better than a chart that has never run.

---

## 8. Common mistakes

| ❌ Don't | ✅ Do |
|---|---|
| Add `ports:` to an internal service | Compose network only |
| Use `localhost` between containers | Service names |
| Connect the app as the table owner | `iris_app`, non-owner |
| Create a table without `FORCE ROW LEVEL SECURITY` | All four lines, every time |
| Edit a committed migration | Add a new one |
| Skip healthchecks | Race conditions that look like code bugs |
| Seed three tickets | ~120, with a real distribution |
| Put a real secret in `docker-compose.yml` | `.env` + `.env.example` |
| Use port 6000 | 6001 / 6101 |
| Build Helm charts instead of the demo | Compose is the deliverable |

---

## 9. Definition of done

- [ ] `docker compose down -v && up -d --build && migrate && seed` works from cold, timed
- [ ] No internal service publishes a port
- [ ] Every service has a healthcheck and ordered `depends_on`
- [ ] New tables: `product_id`, leading index, ENABLE + FORCE, policy
- [ ] Migration idempotent, tested on fresh **and** existing data
- [ ] Seed idempotent and re-runnable
- [ ] `.env.example` updated with any new variable
- [ ] All five security tests pass against the freshly seeded stack
