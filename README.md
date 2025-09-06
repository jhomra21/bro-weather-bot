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

Home page `/` includes:
- A one-off send form (POST `/email`) to send the latest bulletin to a single address.
- A subscribe form (POST `/subscribe`) to add your address to the KV subscriber list.

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

## Notes

- The scheduled cron checks AFDBRO, updates `AFDBRO:last`, and sends to any subscribers whose `lastSentHash` is behind the current hash.
- For testing without waiting for cron, hitting `/check` will also fetch the latest AFDBRO and attempt catch-up delivery for subscribers who missed the last send.
- Unsubscribe links are included at the bottom of scheduled emails. Set `BASE_URL` (for example, your Workers.dev or custom domain) so the unsubscribe link is an absolute URL:
  - `BASE_URL="https://your-worker.example.workers.dev"`
  - If omitted, the link may be relative and some email clients will not resolve it correctly.
