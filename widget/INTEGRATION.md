# Integrating the IRIS Support Widget

Add support to your product with one `<script>` tag. No ticketing code, no UI to build, no redeploy when you change categories or branding.

**Three levels, each additive.** Start at level 1; you can stop there.

| Level | You write | You get | Time |
|---|---|---|---|
| **1 — Zero-code** | One script tag | Raise a ticket, ask questions, search docs, track tickets | ~5 minutes |
| **2 — Identity (SSO)** | ~20 lines in your backend | The widget knows who the user is; no re-login | ~1 hour |
| **3 — Server API** | Backend REST calls | Raise/read tickets programmatically, receive webhooks | ~1 day |

---

## Level 1 — Zero-code

### Step 1. Get your publishable key

From the IRIS admin portal, or ask the support team. It looks like `pub_live_carbon_8f2a`.

It is **safe to put in your page source** — it is designed to be public. It permits only four operations, all scoped to the person using it: create a ticket, read their own tickets, ask a question, search the knowledge base. A leaked key is rate-limited spam, not a breach.

### Step 2. Add the script tag

Anywhere before `</body>`, on any page where you want support available:

```html
<script
  src="https://support.your-iris-host.example/widget.js"
  data-product-key="pub_live_carbon_8f2a"
  defer
></script>
```

**Local development** — the gateway serves the bundle:

```html
<script src="http://localhost:4000/widget.js" data-product-key="pub_live_carbon_8f2a" defer></script>
```

That is the whole integration. A blue launcher appears bottom-right.

### Step 3. Register your origin

Tell the support team which origins will load the widget (`https://app.yourproduct.com`). Requests from anywhere else are refused with `403 origin_not_allowed`.

> This is why a scraped key is not useful to an attacker — it only works from your domain.

### Step 4. Configure it — server-side, no redeploy

Everything the widget shows comes from your product config in the admin portal: which of the eight tiles appear, categories, severities, default severity, field visibility, title, subtitle, greeting, colours, and the suggested questions.

**Change any of it and your users see the change on their next page load.** You do not deploy anything. That is what makes the zero-code claim literal rather than marketing.

### All script-tag options

| Attribute | Required | Default | Purpose |
|---|---|---|---|
| `data-product-key` | ✅ | — | Your publishable key |
| `data-identity-token` | — | none | Short-lived identity JWT (level 2) |
| `data-origin` | — | script's origin | Override the API origin |
| `data-position` | — | `bottom-right` | `bottom-right` or `bottom-left` |
| `data-primary-color` | — | from config | Overrides the launcher colour |
| `data-auto-open` | — | `false` | Open on load |
| `data-open-view` | — | home | Deep link: `ask`, `create`, `docs`, `tickets`, `announcements` |
| `data-z-index` | — | `2147483000` | If your app has very high z-indexes |

### Deep linking to a view

Wire your own entry points straight to the right screen — e.g. a "Report a problem with this invoice" button that opens the ticket form rather than the menu:

```html
<script src="…/widget.js"
        data-product-key="pub_live_carbon_8f2a"
        data-open-view="create"
        data-auto-open="true"
        defer></script>
```

---

## Level 2 — Identity (SSO)

Without this the widget works, but every ticket is anonymous and users cannot see their own history. With it, the user is already known — **no second login**.

### How it works

Your product already authenticated the user. You mint a short-lived JWT asserting that, and the platform verifies it against your public key. The platform never sees a password, never stores an account, and depends on your identity provider **only at the moment a ticket is raised** — existing tickets stay readable even if your IdP is down.

### Step 1. Generate a key pair

```bash
openssl genrsa -out iris-identity-private.pem 2048
openssl rsa -in iris-identity-private.pem -pubout -out iris-identity-public.pem
```

Keep the private key with your other secrets. Never ship it to the browser.

### Step 2. Publish a JWKS endpoint

Serve your public key at a stable URL, e.g. `https://app.yourproduct.com/.well-known/jwks.json`:

```json
{ "keys": [ { "kty": "RSA", "use": "sig", "alg": "RS256", "kid": "iris-1",
              "n": "…", "e": "AQAB" } ] }
```

Then register both against your tenant, in the admin portal under **Tenants → Configure → Single sign-on**:

| Field | What goes in it |
|---|---|
| **Token issuer** | Your `iss` claim, e.g. `https://auth.yourproduct.com`. Tokens from any other issuer are rejected outright |
| **JWKS URL** | The URL above. Must be `https` |

*(If you would rather not run an endpoint, a static JWK can be pinned against the tenant instead — ask.)*

**Key rotation needs no coordination with us.** Publish the new key in your JWKS and start signing with it. We cache the key set for 5 minutes, but a token we cannot verify triggers an immediate re-fetch, so rotation closes in seconds rather than waiting out the cache. Keep the old public key in the set until the last token signed with it has expired — five minutes is plenty.

### Step 3. Mint a token in your backend

**Node**

```js
import { SignJWT, importPKCS8 } from 'jose';
import { readFileSync } from 'node:fs';

const key = await importPKCS8(readFileSync('iris-identity-private.pem', 'utf8'), 'RS256');

export async function mintIrisToken(user) {
  return new SignJWT({
    product_tenant_id: user.companyId,   // YOUR customer's id — required
    name: user.fullName,
    email: user.email,
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'iris-1' })
    .setIssuer('https://app.yourproduct.com')
    .setAudience('iris-ticketing')
    .setSubject(user.id)                 // opaque, stable, immutable. NOT an email
    .setIssuedAt()
    .setExpirationTime('5m')             // max 5 minutes
    .setJti(crypto.randomUUID())
    .sign(key);
}
```

**Python**

```python
import time, uuid, jwt   # PyJWT

PRIVATE_KEY = open("iris-identity-private.pem").read()

def mint_iris_token(user):
    now = int(time.time())
    return jwt.encode(
        {
            "iss": "https://app.yourproduct.com",
            "aud": "iris-ticketing",
            "sub": user.id,                      # opaque, stable. NOT an email
            "product_tenant_id": user.company_id,
            "name": user.full_name,
            "email": user.email,
            "iat": now,
            "exp": now + 300,                    # max 5 minutes
            "jti": str(uuid.uuid4()),
        },
        PRIVATE_KEY,
        algorithm="RS256",
        headers={"kid": "iris-1"},
    )
```

### Step 4. Pass it to the widget

Server-rendered:

```html
<script src="https://support.your-iris-host.example/widget.js"
        data-product-key="pub_live_carbon_8f2a"
        data-identity-token="{{ iris_token }}"
        defer></script>
```

Single-page app — fetch it after login and hand it over:

```js
const { token } = await fetch('/api/iris-token').then((r) => r.json());
window.IrisSupport.setIdentity(token);
```

### Step 5. Refresh before it expires

Tokens last 5 minutes. For a long session, refresh:

```js
setInterval(async () => {
  const { token } = await fetch('/api/iris-token').then((r) => r.json());
  window.IrisSupport.setIdentity(token);
}, 4 * 60 * 1000);
```

### Claim reference

| Claim | Required | Notes |
|---|---|---|
| `iss` | ✅ | Must match the issuer you registered |
| `aud` | ✅ | Exactly `iris-ticketing` |
| `sub` | ✅ | **Opaque, stable, immutable** user id. Not an email — emails change and are not unique across your tenants |
| `product_tenant_id` | ✅ | Your customer/company id. Scopes and filters the ticket |
| `iat` / `exp` | ✅ | `exp − iat ≤ 300` seconds |
| `jti` | ✅ | Unique per token |
| `name`, `email` | recommended | Cached on the ticket so support can work it during an IdP outage |

**RS256 or ES256 only.** Symmetric algorithms are rejected — `alg: none` and HS256-confusion are the two classic JWT breaks, so the verifier uses an explicit allowlist.

---

## JavaScript API

Available on `window.IrisSupport` once the script loads:

```js
window.IrisSupport.open();              // open the panel
window.IrisSupport.close();
window.IrisSupport.toggle();
window.IrisSupport.isOpen();            // → boolean
window.IrisSupport.setIdentity(token);  // set or refresh the identity token
```

Add your own entry point anywhere in your UI:

```html
<button onclick="window.IrisSupport.open()">Need help?</button>
```

---

## Level 3 — Server-to-server API

For raising tickets from your backend, syncing state, or receiving webhooks. Full reference: [docs/api-contract.md](../docs/api-contract.md).

Briefly: server calls authenticate with **HMAC-SHA256** over a canonical request string using your `client_secret`. The contract publishes a **verifiable test vector** ([§3.3](../docs/api-contract.md)) — implement signing, check it reproduces `194eb588…93fb`, and you know your code is right before your first live call.

Webhooks (`ticket.assigned`, `ticket.resolved`, …) are signed the same way, Stripe-style. Verify against the **raw body bytes before parsing** — re-serialising changes whitespace and key order and every signature will fail.

---

## What your users get

All eight capabilities work out of the box:

| | |
|---|---|
| **Ask a Question** | Searches your knowledge base and past resolved tickets, and answers |
| **Create a Ticket** | With category, severity and attachments |
| **Search Docs** | Direct knowledge-base search |
| **My Tickets** | Their own tickets only — enforced at the database, not just the UI |
| **Upload Screenshot** | Attach an image to a ticket |
| **Live Chat** | ⚠️ Converts the conversation into a ticket and says so — real-time chat is not built yet ([ADR-011](../docs/adr/011-live-chat-deferred.md)) |
| **AI Suggestions** | Relevant articles and past fixes before submitting |
| **Announcements** | Your product updates and incident notices |

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| No launcher appears | `data-product-key` missing or wrong | Check the browser console — the loader warns and exits quietly rather than throwing on your page |
| Widget shows "This site is not registered" | Origin not allowlisted | Register your origin with the support team |
| `401 identity_token_invalid` | `aud` is not `iris-ticketing`, `exp − iat` > 5 min, or the wrong `kid` | Compare against the claim table above |
| `identity_provider_unreachable` | Your JWKS URL is unreachable | Confirm it is publicly reachable and serves valid JSON |
| Users see no tickets in My Tickets | Anonymous mode — no identity token | Complete level 2 |
| `403 credential_scope_exceeded` | Publishable key used for a server-side operation | Use your `client_secret` and HMAC (level 3) |
| `429 rate_limited` | Bucket exceeded | Honour `Retry-After`. Ask for a raise if legitimate |
| `503 deflection_unavailable` | Search backend down | Ticket creation is unaffected — the widget falls through to the form |
| Signature always fails (level 3) | Body parsed before signing | Sign the **raw bytes**. This is the single most common integration bug |
| Widget styling looks wrong | It can't — it renders in an iframe | If layout is off, check for a host `z-index` above 2147483000 |

---

## Security notes

- The widget runs in an **iframe**. It cannot read your page, and your CSS cannot break it.
- It holds **no secret**. The publishable key is public by design; your `client_secret` never goes near a browser.
- The identity token is held **in memory only**, never in `localStorage` — an XSS on your page should not yield a replayable identity assertion.
- `postMessage` uses an explicit target origin, and inbound messages are origin-checked.
- Users can only ever read their own tickets. That is enforced by a row-level security policy in the database, not by an application `if`.

## Support

- API reference — [docs/api-contract.md](../docs/api-contract.md)
- Architecture and decisions — [docs/HLD.md](../docs/HLD.md), [docs/adr/](../docs/adr/)
- Local test page — `widget/demo/index.html`
