# Port Mapping

Single public entry point is Nginx. Everything else is either behind it or internal-only.
Authoritative for `infra/nginx/` and the target deployment.

> **Building locally?** Jump to [§ Local development](#local-development-as-actually-running) — the running stack differs from the table below in three ways, all recorded there.

| Service | Port | Public? | Notes |
|---|---|---|---|
| Nginx / reverse proxy | 80 / 443 | ✅ Yes | The only public entry point — routes to admin-panel, widget assets, and the gateway by path/subdomain |
| admin-panel (React) | 3000 (dev) / static via nginx (prod) | ✅ Yes (via reverse proxy) | Judges access this directly for the demo |
| widget (static JS bundle) | static assets via nginx, e.g. `/widget.js` | ✅ Yes | Must be publicly fetchable — sample products load it via `<script src="...">` |
| gateway (Node.js API Gateway) | 4000 | ✅ Yes, `/v1/*` + `/admin/*` only | The real external API surface integrating products talk to |
| core-service (Node.js) | 4100 | ❌ Internal only | Only the gateway calls this. **Sole holder of a DB credential** |
| ai-service (Python) | 5000 | ❌ Internal only | Called by worker / core-service, never by a client. **Holds no DB credential** |
| notification-service | 5100 | ❌ Internal only | Primarily a queue consumer; the HTTP port serves health + admin test-send/template-preview only |
| worker (BullMQ) | — no HTTP port | ❌ N/A | Background consumer; needs network access to Redis + core-service + ai-service only |
| Postgres (+ pgvector) | 5432 | ❌ Internal only | Never expose on the VM's public interface — most common accidental hole in hackathon demos |
| Redis | 6379 | ❌ Internal only | Same caution |
| MinIO (attachments, S3 API) | 9000 (API) / 9001 (console) | ❌ Internal only | Azure Blob replaces this in production, behind the same adapter. Console optionally exposed for debugging only |
| pgvector | same as Postgres (extension, not a service) | — | No separate port |
| sample-integrations/product-a (Carbon) | **6001** | ✅ Yes | ⚠️ **Changed from 6000** — see below. Reachable so judges see a "real" integrating product with the widget embedded |
| sample-integrations/product-b (iFile) | **6101** | ✅ Yes | Second demo product, proves portability |
| Admin portal auth callback (OAuth-style support-user login) | reuses admin-panel's port | — | Not a separate service |

## ⚠️ Port 6000 is unusable in a browser — do not revert

Chrome, Firefox, and Safari **hard-refuse** port 6000 (`ERR_UNSAFE_PORT`) because it is reserved for X11. A sample product served there is unreachable from any browser, and the failure looks like a networking problem rather than a blocked port — an expensive thing to debug on demo day.

**product-a moved 6000 → 6001**, and product-b to 6101 for symmetry.

Other browser-blocked ports to avoid if reassigning anything: 1, 7, 9, 11, 13, 15, 17, 19–23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101–104, 109–111, 113, 115, 117, 119, 123, 135, 137–139, 143, 161, 179, 389, 427, 465, 512–515, 526, 530–532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, **6000**, 6566, 6665–6669, 6679, 6697, 10080.

Everything else in the table above (3000, 4000, 4100, 5000, 5100, 6001, 6101, 9000, 9001) is clear.

## Windows: check for reserved port ranges before the demo

Hyper-V / WinNAT reserves dynamic TCP ranges that can silently swallow a port we need, producing a bind failure that reads like a code bug:

```powershell
netsh int ipv4 show excludedportrange protocol=tcp
```

If any service port falls inside an excluded range:

```powershell
net stop winnat
docker compose up -d
net start winnat
```

## Local development (as actually running)

Verified on the dev machine, 2026-07-26. **Docker CLI is absent, but Podman 5.8.3 is installed and working** — an earlier note in this repo said containers were unavailable; that was wrong and has been corrected.

```powershell
podman-compose -f infra/podman-compose.yml up -d   # Postgres + Redis
npm run migrate && npm run seed
npm run dev                                        # core + gateway + test page
```

| Service | Local port | Notes |
|---|---|---|
| **gateway** | **4000** | Public. Also **serves `widget.js`** — there is no nginx locally, and this makes integration a single origin |
| **core-service** | **4100** | Bound to `127.0.0.1` only |
| **widget test page** | **3100** | `widget/demo/index.html`, served on a separate origin so the widget is exercised cross-origin as a real product would |
| **Postgres** (`iris-postgres`) | **5432** | `pgvector/pgvector:pg17` container — Postgres 17.10, pgvector 0.8.5 |
| **Redis** (`iris-redis`) | **6380** | ⚠️ Not 6379 — see below |

### Three deliberate local deviations

| # | Deviation | Why |
|---|---|---|
| 1 | Postgres is a **container on 5432**, not the machine's native install | The native Windows **PostgreSQL 18 on port 5433** cannot take pgvector without the Visual Studio C++ workload (not installed) plus an elevated `nmake install`. The container ships pgvector prebuilt. **The native instance is left completely untouched.** |
| 2 | Redis on **6380** | Port 6379 is held by an unrelated `rfp-redis` container belonging to another project. Ours is isolated rather than sharing a keyspace |
| 3 | The **gateway serves `widget.js`** | No nginx locally. It also simplifies integration to one origin — see [widget/INTEGRATION.md](../widget/INTEGRATION.md) |

### Ports on this machine that are already taken

`5433` native PostgreSQL 18 · `6379` `rfp-redis` container · `5173` a Vite dev server · `5040` Windows service. None collide with the table above.

## Rules of thumb

- Only `80/443` and the two demo product ports bind to the host's public interface.
- `4100`, `5000`, `5100`, `5432`, `6379`, `9000` have **no `ports:` stanza** in `docker-compose.yml` — they are reachable only on the compose-internal network, by service DNS name.
- Services address each other by compose service name (`http://core-service:4100`), never `localhost`. A sample product calling `localhost:4000` from inside a container reaches itself, not the gateway.
- `4000` is public, but only `/v1/*` (products) and `/admin/*` (support users, separately authenticated) are routed. Everything else 404s at nginx.
