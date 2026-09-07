# SKILLS.md — admin-panel

**The support team's UI.** Nine pages, per the mockup in `docs/images/Image.jpg`.

> Read [/SKILLS.md](../SKILLS.md) and [ui-spec-deltas.md](../docs/ui-spec-deltas.md) first — the mockup contradicts the HLD in three places and the reconciliation is authoritative.

| | |
|---|---|
| **Stack** | React 18 · TypeScript · Vite · TanStack Query · React Router · Tailwind · Recharts |
| **Port** | 3000 (dev) · static via nginx (prod) |
| **Talks to** | `gateway:4000/admin/*` — **never core-service directly** |

---

## 1. Build order — and where to stop

Nine pages is a lot for the time available. Build in this order and stop when time runs out; everything below the line is genuinely optional.

| # | Page | Priority | Notes |
|---|---|---|---|
| 1 | **Ticket Detail** | 🔴 P0 | **Build this first.** It alone answers four success criteria: history, audit, access grant/revoke events, comments |
| 2 | Dashboard | 🔴 P0 | Live counters, click-through, SLA health, triage queue |
| 3 | Tickets (list) | 🔴 P0 | Filter/search, cursor pagination |
| 4 | Agents | 🟠 P1 | Roles, scopes, skills, workload, per-user profile |
| 5 | Audit Logs | 🟠 P1 | Filterable. Cheap — the data model already supports it |
| 6 | AI Insights | 🟠 P1 | Reads the **same** eval code as the demo score |
| 7 | Analytics | 🟡 P2 | TAT p50/p90, SLA %, CSAT trend, top **and bottom** performers |
| 8 | Settings | 🟡 P2 | Per-product config — this is the zero-code proof, demo it |
| 9 | Knowledge Base | ⚪ P3 | |
| 10 | Automations | ⚪ P3 | Toggles over a fixed catalogue. **No visual rule builder** |

> The brief warns explicitly: *"The admin portal can swallow time if treated as a CRUD-screen exercise."* Build the views that do work — triage, breach-hunting, team management. **Skip ornate forms for things admins touch twice a year.**

---

## 2. Naming reconciliations — get these right or the UI drifts from the API

| API / DB | UI label | Rule |
|---|---|---|
| `severity` | **Priority** | Display label only. **Never** introduce a `priority` field |
| `waiting_on_raiser` | **On Hold** | Display mapping only |
| `assigned` | Open + assignee shown | Not a filter chip; the Assignee column carries it |
| `raised_by` | **Requester** | Display label |
| "Auto Resolved" *(mockup)* | **Self-Served** | Counts widget deflections, **never tickets**. See [ui-spec-deltas §1.1](../docs/ui-spec-deltas.md) |

**All of these live in exactly one file:** `src/lib/labels.ts`. A label mapping that appears in two components will disagree within a week.

```ts
export const SEVERITY_LABEL = { low: 'Low', medium: 'Medium', high: 'High', critical: 'Critical' } as const;
export const STATUS_LABEL = { open: 'Open', assigned: 'Open', in_progress: 'In Progress',
                              waiting_on_raiser: 'On Hold', resolved: 'Resolved', closed: 'Closed' } as const;
```

---

## 3. Folder map

```
src/
  pages/        One folder per route. Composes components, owns no logic
  components/   Reusable. ui/ (primitives) · tickets/ · charts/ · layout/
  api/          One file per resource. ALL fetch calls live here — never in a component
  auth/         Session, role context, <RequireRole>
  hooks/        Shared behaviour
  lib/          labels.ts, format.ts, constants.ts
```

**Rules:**
- **No `fetch` outside `src/api/`.** One place to add auth headers, error mapping, and retry.
- Pages compose; components render; hooks hold behaviour. A page with 300 lines of logic is a page that needs a hook.
- Every API response is parsed by a zod schema at the boundary — the API is `snake_case`, the app is `camelCase`, and that conversion happens exactly once, in `src/api/`.

---

## 4. Data fetching

TanStack Query for everything server-side. **No `useEffect` + `fetch`.**

```ts
export const ticketKeys = {
  all:    ['tickets'] as const,
  list:   (f: TicketFilters) => [...ticketKeys.all, 'list', f] as const,
  detail: (id: string)       => [...ticketKeys.all, 'detail', id] as const,
};
```

| Rule | Why |
|---|---|
| Structured query keys in one place | Invalidation that misses a key produces stale UI nobody can reproduce |
| Invalidate on mutation, don't hand-patch cache | Except optimistic updates, where you must roll back on error |
| Dashboard counters: `refetchInterval: 15_000` | "Live counters" is a stated criterion — it must visibly move during the demo |
| Cursor pagination, never offset | Rows insert constantly; offsets drift and duplicate |
| Every list has empty / loading / error states | An empty table with no message reads as a bug to a judge |

---

## 5. RBAC in the UI

```tsx
<RequireRole roles={['super_admin', 'product_admin']}>
  <ProductConfigPage />
</RequireRole>
```

> ### ⚠️ UI role checks are UX, not security
> Hiding a button hides nothing. **Every permission is enforced server-side**, and the UI check exists only so users don't see actions that will fail. Never assume the UI is the gate — and never add an endpoint whose only protection is that no button points at it.

| Role | Sees |
|---|---|
| `super_admin` | Everything, all products |
| `product_admin` | Scoped products + their config |
| `manager` | Scoped products, assignment, analytics. No config |
| `agent` | Queue metadata (T0) + full data on **assigned tickets only** (T1) |

An agent viewing an unassigned ticket sees metadata and an explicit **"Assign to yourself to view full details"** — not an error, and not a silently empty panel. The zero-standing-access model should read as intentional, because it is.

---

## 6. Ticket Detail — the highest-value screen

One chronological timeline merging state transitions, comments, attachments, **access grant/revoke events with the product's actual responses and latencies**, and raw audit rows.

- Internal notes visually distinct (amber left border + a lock icon) and **never** confusable with a customer-visible comment. This is the mistake that leaks an internal note to a customer.
- Access events show scope, expiry, mechanism, and the product's response body — this is the audit proof judges look for.
- A failed revoke renders **red, at the top, unmissable**. It is a security incident, not a delivery warning.

---

## 7. Charts

Recharts. Rules that matter more than the library:

- **p50 and p90, never averages.** A mean TAT hides the tail that matters — that is the whole point of §14 in the HLD.
- **Two clocks side by side** on TAT views (SLA clock vs customer wall clock), always labelled. Showing one alone starts an argument.
- Colour-blind-safe palette; never colour alone to convey state — pair it with a label or icon.
- SLA health: `On Track` / `At Risk` (≥80% consumed) / `Breached`.
- Every chart needs an empty state. Seed data must produce real distributions, not three points.

---

## 8. Common mistakes

| ❌ Don't | ✅ Do |
|---|---|
| `fetch` in a component | Call through `src/api/` |
| Introduce a `priority` field | `severity` + a label mapping |
| Hardcode a label string in a component | `src/lib/labels.ts` |
| Rely on a hidden button for security | Server-side enforcement always |
| `useEffect` + `setState` for server data | TanStack Query |
| Offset pagination | Cursors |
| Render an attachment inline | Download link only — inline SVG/HTML is stored XSS in an admin session |
| Show an average TAT | p50 / p90 |
| Build a visual automation rule builder | Toggles over a fixed catalogue |
| Ship a page with no empty state | Every list handles empty, loading, error |

---

## 9. Definition of done

- [ ] Route added to the router and to the nav with the correct role guard
- [ ] All network calls in `src/api/`, responses zod-parsed at the boundary
- [ ] Labels from `src/lib/labels.ts`
- [ ] Empty / loading / error states present
- [ ] Keyboard accessible; interactive elements labelled
- [ ] Readable at 150% zoom (the demo runs at 150%)
- [ ] No secret, token, or internal id leaked into the DOM or a log
- [ ] Server enforces every permission the UI hides
