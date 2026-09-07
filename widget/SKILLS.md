# SKILLS.md — widget

**The embeddable support assistant.** Ships as one `<script>` tag onto pages we do not control, for products we do not own.

> Read [/SKILLS.md](../SKILLS.md) and [ui-spec-deltas.md §2.4](../docs/ui-spec-deltas.md) first — the mockup expands this roughly 4× beyond the HLD, and the priority table below is what we actually build.

| | |
|---|---|
| **Stack** | Vanilla TypeScript + Vite. **No React, no framework** |
| **Ships as** | `widget.js` loader (< 15 KB gzipped) + an iframe app |
| **Served by** | nginx as a static, versioned asset |

---

## 1. Scope — build P0/P1, honestly stub P3

The mockup shows eight capabilities. Ranked by value-to-cost:

| Capability | Priority | Note |
|---|---|---|
| **Create a Ticket** | 🔴 **P0** | The mandated core. Never at risk |
| **My Tickets** | 🔴 **P0** | One list call against an existing endpoint |
| **Ask a Question / Search Docs** | 🟠 **P1** | Deflection — retrieval over KB + resolved tickets, both already embedded |
| **AI Suggestions** (pre-submit) | 🟠 **P1** | Same retrieval pipeline, shown before submit. Near-free once P1 exists |
| **Upload Screenshot** | 🟡 P2 | Upload is P0 anyway; *vision understanding* is the stretch |
| **Announcements** | 🟡 P2 | Cheap, low value. Cut without hesitation |
| **Live Chat** | 🔴 **P3 — STUB** | WebSocket transport, presence, agent routing, typing state, transcripts, reconnect. **The single largest scope risk in the mockup** |

**How to stub Live Chat honestly:** the button converts the conversation into a ticket and says *"An agent will pick this up — you'll get an email."* That is a real, working outcome. It is not a fake chat window that never connects.

> Never let a stub look finished. A judge discovering a dead feature costs more than the feature was worth.

---

## 2. Non-negotiables

### 🔒 The widget holds no secret

It carries a **publishable key** (`pub_live_…`), which is scrapeable by design and therefore low-privilege: create a ticket, and read tickets belonging to the accompanying identity JWT. Nothing else. A leaked publishable key is rate-limited spam, not a breach.

**Never** put a `client_secret`, webhook secret, or pre-auth token in widget code, config, or `postMessage` payloads.

### 🔒 Iframe, not inline DOM

Total isolation in both directions. The host page cannot read the widget's data or the user's typed text; host CSS cannot break the widget's layout.

The **loader** (`widget.js`) injects only a positioned iframe + a launcher button. All UI lives inside the iframe.

### 🔒 Config is server-side

Fields, categories, severities, defaults, branding, locale — all from `GET /v1/widget/config`. **Nothing product-specific is hardcoded or passed as a script attribute beyond the key.**

This is what makes "zero-code" literally true: a product changes its widget by editing config in the admin portal, with no redeploy on their side. It is demoed live (§7.4 of [demo-script.md](../docs/demo-script.md)) — so it must actually work that way.

---

## 3. Host page discipline — we are a guest

This code runs on someone else's page. It must be invisible until invoked and impossible to blame.

| Rule | Why |
|---|---|
| **Never touch host globals.** No `window.$`, no prototype patching, no global CSS | We break their app and they blame us — correctly |
| **Namespace everything** — `iris-support-*` for ids, classes, storage keys | Collisions in the wild are silent and unreproducible |
| **Load async/deferred; never block render** | A support widget must never slow a customer's product |
| **Fail silently on the host page** | If our API is down, the launcher shows an error *inside the iframe*. Never an alert, never a console error storm, never a thrown exception on their page |
| **`postMessage` with an explicit `targetOrigin`** and validate `event.origin` on receipt | `'*'` leaks data to any frame |
| Loader < 15 KB gzipped | It is on every page load of every integrating product |
| Never `document.write`, never sync XHR | |

---

## 4. Identity

The host passes a short-lived JWT the product minted (`data-identity-token`, or via `postMessage` for refresh).

- The widget **never** verifies the JWT — it forwards it. The gateway verifies against the product's JWKS.
- Token TTL is ~5 minutes. For a long session, request a fresh one from the host via `postMessage` before expiry; on failure show *"Session expired — please refresh"*, never a silent failure.
- **Never persist the token** in `localStorage`. Memory only. An XSS on the host page should not yield a replayable identity assertion.

---

## 5. Reliability the user can feel

| Behaviour | Why |
|---|---|
| **Draft persistence** — save typed description to `sessionStorage` under a namespaced key, restore on reopen, clear on success | A user who types 300 words and loses them to a network blip will never use the widget again |
| **`Idempotency-Key` on every submit** | A retried POST on a flaky mobile network creates a duplicate ticket a human then has to merge |
| Explicit retry on failure, description preserved | Never lose user input to an error state |
| Optimistic confirmation only after `201` | Show the real reference (`CARB-1042`), never a fake one |
| Attachment: validate type + size **client-side before upload** | Fast feedback; the server re-validates because client checks are advice, not enforcement |

---

## 6. Theming

`themes/` holds per-product tokens applied as CSS custom properties from the server config.

```css
:root { --iris-primary:#1D4ED8; --iris-radius:8px; --iris-font:system-ui, sans-serif; }
```

- Tokens only — **never** per-product CSS files or `if (product === 'carbon')` branches. That is how "one widget, many products" quietly becomes N widgets.
- Two visually distinct sample products (different primary colour, logo, categories) is a **scored** proof of portability. Verify both render correctly before the demo.
- Respect `prefers-reduced-motion`. Meet WCAG AA contrast **using the product's colours** — validate at config-save time in the admin portal, not at render time.

---

## 7. Build and versioning

```powershell
npm run dev --workspace=widget     # local harness page simulating a host
npm run build --workspace=widget   # → dist/
```

- `dist/` output is **versioned and immutable**: `widget.v1.2.0.js`, with `widget.js` as a stable alias.
- Never mutate a published version — integrating products cache it and a silent change breaks them without a deploy on their side.
- Check the gzipped loader size on every build; treat a regression as a bug.

---

## 8. Common mistakes

| ❌ Don't | ✅ Do |
|---|---|
| Put a secret in widget code | Publishable key only |
| Render inline in the host DOM | Iframe |
| Hardcode categories/branding | Server config |
| `postMessage(data, '*')` | Explicit `targetOrigin`, validate `origin` on receipt |
| Persist the identity JWT | Memory only |
| Submit without `Idempotency-Key` | Always send one |
| Lose the user's typed text on error | `sessionStorage` draft |
| Throw or log noisily on the host page | Fail silently outward, show the error inside the iframe |
| Add React "just for the chat panel" | Vanilla TS — bundle size is a feature here |
| Build real Live Chat | Stub it: convert to a ticket and say so |

---

## 9. Definition of done

- [ ] Works inside the iframe with zero host-page side effects
- [ ] No secret in the bundle (grep the built output before shipping)
- [ ] All product-specific behaviour comes from server config
- [ ] Renders correctly for **both** sample products with different branding
- [ ] Draft persisted and restored; `Idempotency-Key` sent
- [ ] Keyboard accessible; focus trapped in the iframe while open; Esc closes
- [ ] Loader still < 15 KB gzipped
- [ ] Graceful behaviour when the API is unreachable
- [ ] Any stub says what it does, in the UI
