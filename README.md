# bro-weather-bot

To install dependencies:

```bash
bun install
```

To run locally (Cloudflare Workers dev):

```bash
bun run dev
```

This project was created using `bun init` in bun v1.2.21. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.

## Subscriptions (KV-backed)

- POST `/subscribe` with `email` to subscribe an address to scheduled bulletins.
  - Duplicate subscriptions are ignored.
  - Re-subscribing a previously disabled address will reactivate it.
  - The default `RECIPIENT` from `wrangler.jsonc` is always kept subscribed (cannot be unsubscribed).
- GET `/unsubscribe?token=...` to disable a subscription (tokenized link is included at the bottom of scheduled emails).
  - The default `RECIPIENT` cannot be unsubscribed.

### One-off sends

- POST `/email` sends the latest bulletin to a single address.
- If that address is already an active subscriber in KV, the email will include an unsubscribe link at the bottom.
- If it is not a subscriber (true one-off), the unsubscribe link is omitted.

### Re-subscribe behavior

- Re-subscribe reuses the same `SUBS:<sha256(email)>` KV record (no new entry).
- We set `disabled = false` and keep their previous `lastSentHash`.
- If they are behind (their `lastSentHash !== current hash`), they are caught up on the next run of cron or `/check` even if the global hash doesn’t change during that run.

### Unsubscribe tokens

- Each subscriber has an `unsubToken`, and `UNSUB:<token>` maps back to the subscriber key for fast lookup.
- After unsubscribing, we keep the `UNSUB:<token>` mapping so the link remains idempotent (clicking again shows a confirmation rather than an error). This has no effect on sending; delivery is governed by `disabled: true`.

### Base URL for unsubscribe links

- For request-driven routes (e.g., `/check` during development), the unsubscribe link uses the request origin automatically:
  - Dev (wrangler dev): `http://127.0.0.1:8787`
  - Prod: your deployed host
- For scheduled runs (no request), the Worker uses `BASE_URL` if set in `wrangler.jsonc`; otherwise it falls back to `https://bro-weather-bot.jhonra121.workers.dev`.

Home page `/` includes:
- A one-off send form (POST `/email`) to send the latest bulletin to a single address.
- A subscribe form (POST `/subscribe`) to add your address to the KV subscriber list.

## Endpoints

- GET `/` — Home with forms to send one-off email and subscribe.
- POST `/email` — One-off send. Adds unsubscribe link only if the recipient is already a subscriber in KV.
- POST `/subscribe` — Adds or reactivates a subscriber; deduplicates by `sha256(email)`.
- GET `/unsubscribe?token=...` — Disables the subscriber and shows an HTML confirmation page.
- GET `/check` — Fetches latest AFDBRO, updates state, attempts per-subscriber catch-up delivery, returns JSON.
- GET `/check/raw` — Returns latest AFDBRO text.
- GET `/check/html` — Returns latest AFDBRO rendered as HTML email.
- POST `/check` — Same as GET `/check`.

## Email sending (SMTP-only)

This Worker uses SMTP via `worker-mailer` exclusively.

- Configure: `SMTP_HOST`, `SMTP_PORT`, `SMTP_USERNAME`, `SMTP_PASSWORD`, and optionally `SMTP_SECURE` and `SMTP_STARTTLS`.
- One email is sent per recipient for privacy and clearer retries.

## KV keys

- `AFDBRO:last` → `{ hash: string, seenAt: string }` latest bulletin hash and timestamp
- `SUBS:<sha256(email)>` → per-subscriber record:
  ```json
  {
    "email": "user@example.com",
    "createdAt": "2025-09-06T14:00:00Z",
    "lastSentHash": "abc123...",
    "lastSentAt": "2025-09-06T14:05:00Z",
    "verified": true,
    "disabled": false
  }
  ```
 - `UNSUB:<token>` → maps unsubscribe token to the subscriber key (for fast lookup)

### KV record examples

AFDBRO last-seen record:

```json
{
  "hash": "0ce6c7482efca882a7212737bf26203f9d07b4ba6ee2b0d797ebbd9c7eb2d3d",
  "seenAt": "2025-09-06T14:51:32.000Z"
}
```

Active subscriber (`SUBS:<sha256(email)>`):

```json
{
  "email": "user@example.com",
  "createdAt": "2025-09-06T14:00:00.000Z",
  "lastSentHash": "0ce6c7482ef...",
  "lastSentAt": "2025-09-06T14:05:00.000Z",
  "verified": true,
  "disabled": false,
  "unsubToken": "u_1rhokqbg5t6u8wytogifuk"
}
```

Disabled subscriber after unsubscribe:

```json
{
  "email": "user@example.com",
  "createdAt": "2025-09-06T14:00:00.000Z",
  "lastSentHash": "0ce6c7482ef...",
  "lastSentAt": null,
  "verified": true,
  "disabled": true,
  "unsubToken": "u_1rhokqbg5t6u8wytogifuk"
}
```

Unsubscribe token mapping (`UNSUB:<token>`):

```json
"SUBS:1dca91be2c6874bc7982c6d5963b180fb0d0e8563a1d493ae497afcde0f600110"
```

## Notes

- The scheduled cron checks AFDBRO, updates `AFDBRO:last`, and sends to any subscribers whose `lastSentHash` is behind the current hash.
- For testing without waiting for cron, hitting `/check` will also fetch the latest AFDBRO and attempt catch-up delivery for subscribers who missed the last send.
- Unsubscribe links are included at the bottom of scheduled emails and for one-off emails only if the address is an active subscriber.
- `env.RECIPIENT` is always kept subscribed and cannot be unsubscribed.
- Ensure `BASE_URL` is set for production so scheduled emails generate absolute links (in dev, the link uses the request origin automatically).

## Code map and examples

### `index.ts`

- Home UI: `renderEmailFormPage()` renders forms and basic JS.
- One-off send: `app.post("/email", ...)`

```ts
// Build unsubscribe link only if recipient is an active subscriber
const origin = new URL(c.req.url).origin;
const id = await sha256Hex(to.toLowerCase());
const subKey = `SUBS:${id}`;
const subRaw = await c.env.BRO_KV.get(subKey);
let unsubUrl: string | undefined;
if (subRaw) {
  const sub = JSON.parse(subRaw) as any;
  if (!sub.disabled) {
    if (!sub.unsubToken) { /* ensure token + mapping */ }
    unsubUrl = `${origin}/unsubscribe?token=${sub.unsubToken}`;
  }
}
// Append footer if unsubUrl exists, then send via SMTP (worker-mailer)
```

- Subscribe: `app.post("/subscribe", ...)`

```ts
// Deduplicate by sha256(email); reactivate if disabled; seed lastSentHash from AFDBRO:last
await c.env.BRO_KV.put(`SUBS:${id}`, JSON.stringify({
  email, createdAt, lastSentHash, lastSentAt: null,
  verified: true, disabled: false, unsubToken
}));
await c.env.BRO_KV.put(`UNSUB:${unsubToken}`, `SUBS:${id}`);
```

- Unsubscribe: `app.get("/unsubscribe", ...)`

```ts
// Lookup by token → SUBS key; disable and show confirmation page
const subKey = await c.env.BRO_KV.get(`UNSUB:${token}`);
const sub = JSON.parse(await c.env.BRO_KV.get(subKey)!);
sub.disabled = true;
await c.env.BRO_KV.put(subKey, JSON.stringify(sub));
```

- Passing the base URL to checks in dev: `origin = new URL(c.req.url).origin`

```ts
// GET /check in dev ⇒ http://127.0.0.1:8787, prod ⇒ deployed host
const origin = new URL(c.req.url).origin;
const result = await checkAfdbro(c.env, { includeText: true, baseUrlOverride: origin });
```

### `lib/checkAfdbro.ts`

- Core flow (simplified):

```ts
export async function checkAfdbro(env: Env, opts?: { includeText?: boolean; baseUrlOverride?: string }) {
  // 1) Fetch AFDBRO, sanitize, compute hash
  // 2) Update AFDBRO:last { hash, seenAt }
  // 3) Bootstrap env.RECIPIENT subscriber with unsubToken + mapping
  // 4) Compute base = opts.baseUrlOverride || env.BASE_URL || default prod URL
  // 5) Connect SMTP via worker-mailer
  // 6) List SUBS:* and send per-subscriber if behind; inject per-user unsubscribe link
  // 7) Update subscriber.lastSentHash/lastSentAt on success
}
```

- Injecting unsubscribe into HTML:

```ts
function withHtmlFooter(docHtml: string, footer: string) {
  const needle = "</body></html>";
  const i = docHtml.lastIndexOf(needle);
  return i === -1 ? docHtml + footer : docHtml.slice(0, i) + footer + docHtml.slice(i);
}
const unsubUrl = `${base}/unsubscribe?token=${sub.unsubToken}`;
const footerHtml = `<div style="margin-top:18px;padding-top:10px;border-top:1px solid #2a3546;color:#9ca3af;font-size:14px;">This message was sent by bro-weather-bot. <a style="color:#cbd5e1;" href="${unsubUrl}">Unsubscribe</a>.</div>`;
const htmlBody = withHtmlFooter(renderHtmlEmail(clean), footerHtml);
```

## Setup

1) Configure SMTP (worker-mailer)

```bash
wrangler secret put SMTP_HOST
wrangler secret put SMTP_PORT
wrangler secret put SMTP_USERNAME
wrangler secret put SMTP_PASSWORD
```

2) Vars in `wrangler.jsonc` (example)

```jsonc
{
  "vars": {
    "SENDER": "sender@your-domain.tld",
    "RECIPIENT": "you@example.com",
    "BASE_URL": "https://bro-weather-bot.jhonra121.workers.dev"
  }
}
```

3) Dev server

```bash
bun run dev
```
