# Architecture Decision Records

Each ADR records one decision: what we picked, what we rejected, and why. The **Alternatives considered** table is the load-bearing part — the brief's §4 ("Design Decisions You Must Defend") asks for exactly that.

| ADR | Decision | Brief § |
|---|---|---|
| [001](001-integration-contract-rest-webhooks.md) | Integration contract — REST + webhooks | 4.1 |
| [002](002-callback-security-hmac.md) | Callback security model — HMAC-SHA256 | 4.2 |
| [003](003-sso-signed-jwt-handoff.md) | SSO and identity federation — signed JWT handoff | 4.3 |
| [004](004-isolation-row-level-security.md) | Multi-product isolation — Row-Level Security | 4.4 |
| [005](005-ai-confidence-thresholds.md) | AI confidence handling — margin-aware routing | 4.5 |
| [006](006-tat-definitions-and-clock-pauses.md) | TAT definitions and clock pauses — two clocks | 4.6 |
| [007](007-polyglot-topology-one-db-credential.md) | Polyglot topology + one-DB-credential invariant | — |
| [008](008-dual-access-mechanism.md) | Dual access mechanism — callback + pre-auth link | — |
| [009](009-deflection-is-not-auto-resolution.md) | Deflection is not auto-resolution | — |
| [010](010-automations-fixed-catalogue.md) | Automations as a fixed catalogue | — |
| [011](011-live-chat-deferred.md) | Live Chat deferred — stub converts to a ticket | — |

**001–006** answer the brief directly. **007–008** cover architecture choices the brief does not name but a judge will ask about. **009–011** record decisions forced by the UI mockups — these are the ones most likely to be re-litigated mid-build by someone reading a mockup instead of the HLD.

## Writing a new ADR

Copy the structure of any existing one:

```markdown
# ADR-0NN: <Title>
**Status:** Accepted · **Date:** YYYY-MM-DD · **Related:** …
## Context      — the forces, including any brief requirement
## Decision     — what we picked, stated flatly
## Alternatives considered   — table: Option | Verdict | Why
## Consequences — positive / negative / mitigations
## Related      — HLD §, api-contract §, other ADRs
```

Rules: one decision per ADR · at least two rejected alternatives with real reasons · never edit an accepted ADR to change its decision — supersede it with a new one and mark the old `Superseded by ADR-0NN`.
