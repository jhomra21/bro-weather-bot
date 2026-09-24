# bro-weather-bot

Cloudflare Worker that fetches the latest NWS Brownsville Area Forecast Discussion (AFDBRO) and emails subscribers when they are behind the current bulletin.

## Development

Install dependencies and start Wrangler:

```bash
bun install
bun run dev
```

Run the full verification path:

```bash
bun run check
```

`bun run check` generates Cloudflare types, runs TypeScript, then runs the HTTP-level notification-state E2E. The E2E writes `artifacts/e2e-notification-state.json`. CI uploads the same file as the `notification-state-e2e` artifact.

## Delivery model

The Worker has separate read and write operations.

`GET /check`, `GET /check/raw`, and `GET /check/html` fetch the current AFDBRO but do not write KV and do not send email. Reading or previewing a new bulletin cannot consume a scheduled notification.

`POST /check` runs catch-up delivery. The daily cron uses the same delivery operation. Delivery compares the current bulletin hash with each subscriber's `lastSentHash`. A subscriber who is behind is attempted even when the global bulletin hash has not changed since the previous delivery run.

This per-subscriber check is the delivery source of truth. `AFDBRO:last` records the bulletin seen by the most recent delivery run. It does not decide whether a subscriber receives mail.

## Endpoints

| Method | Path | Behavior |
| --- | --- | --- |
| GET | `/` | One-off send and subscription forms |
| GET | `/check` | Read-only current bulletin JSON |
| GET | `/check/raw` | Read-only current bulletin text |
| GET | `/check/html` | Read-only rendered email preview |
| GET | `/status` | Last delivery-run state and counts |
| POST | `/check` | Run subscriber catch-up delivery |
| POST | `/email` | Send the current bulletin to one address |
| POST | `/subscribe` | Add or reactivate a subscriber |
| GET | `/unsubscribe?token=...` | Disable a subscriber |

The one-off `POST /email` route does not mark scheduled subscriber delivery as complete. If the address is already an active subscriber, the message includes its unsubscribe link.

## AFDBRO module

`lib/afdbro.ts` is the bulletin module. Callers use three operations:

```ts
import * as Afdbro from "./lib/afdbro.ts";

await Afdbro.inspect(env);
await Afdbro.deliver(env, { baseUrlOverride });
await Afdbro.status(env);
```

`inspect()` is read-only. It returns a tagged result with either `status: "ok"` and the bulletin, or `status: "error"` and upstream error details.

`deliver()` fetches the bulletin, checks every active subscriber, sends only to subscribers whose `lastSentHash` differs from the current hash, and persists one delivery summary. Its summary contains counts and stable issue codes rather than recipient addresses.

`status()` reads the last bulletin marker and last delivery summary without contacting the upstream feed or mutating KV.

The HTTP routes and cron call the same module. There is no separate scheduled-send implementation.

## Delivery status

Each delivery run writes `AFDBRO:delivery:last` with:

```json
{
  "status": "ok",
  "startedAt": "2026-09-24T12:00:00.000Z",
  "completedAt": "2026-09-24T12:00:01.000Z",
  "durationMs": 1000,
  "hash": "abc123...",
  "changedSinceLastRun": true,
  "attempted": 1,
  "sent": 1,
  "upToDate": 0,
  "issues": []
}
```

Possible issue codes are `smtp_not_configured`, `smtp_connect_failed`, `smtp_send_failed`, `subscriber_iteration_failed`, and `upstream_fetch_failed`.

The Worker also emits one structured `afdbro.delivery` log per delivery run. SMTP failures use dedicated structured log events. Logs do not include subscriber addresses.

## KV keys

`AFDBRO:last` stores the bulletin hash from the most recent successful upstream fetch performed by a delivery run:

```json
{
  "hash": "abc123...",
  "seenAt": "2026-09-24T12:00:01.000Z"
}
```

`AFDBRO:delivery:last` stores the delivery summary shown by `GET /status`.

`SUBS:<sha256(email)>` stores one subscriber:

```json
{
  "email": "user@example.com",
  "createdAt": "2026-09-24T11:00:00.000Z",
  "lastSentHash": "abc123...",
  "lastSentAt": "2026-09-24T12:00:01.000Z",
  "verified": true,
  "disabled": false,
  "unsubToken": "u_example"
}
```

`UNSUB:<token>` maps an unsubscribe token back to its `SUBS:` key.

The configured `RECIPIENT` is kept active and cannot be unsubscribed.

## Email

The Worker sends through SMTP with `worker-mailer`. Set these production secrets:

```bash
wrangler secret put SMTP_HOST
wrangler secret put SMTP_PORT
wrangler secret put SMTP_USERNAME
wrangler secret put SMTP_PASSWORD
```

Optional SMTP settings are `SMTP_SECURE` and `SMTP_STARTTLS`.

`SENDER`, `RECIPIENT`, and `BASE_URL` are configured in `wrangler.jsonc`. `BASE_URL` is used for unsubscribe links during scheduled runs.

## Schedule

`wrangler.jsonc` runs the Worker once per day at `0 12 * * *`, which is 12:00 UTC.

The scheduled handler calls `Afdbro.deliver(env)`. Because delivery checks subscriber state rather than only the global bulletin marker, a failed or missed subscriber remains eligible on the next run.

## Code map

- `index.ts`: Hono routes, forms, one-off email handling, and the Cloudflare scheduled entry point.
- `lib/afdbro.ts`: AFDBRO fetch, inspection, subscriber catch-up delivery, delivery status, and structured delivery logs.
- `lib/renderHtmlEmail.ts`: email rendering for the NWS bulletin.
- `lib/utils.ts`: hashing and AFOS text cleanup.
- `scripts/e2e-notification-state.ts`: HTTP-level regression test for read-only checks and per-subscriber catch-up.
- `wrangler.jsonc`: Worker bindings, variables, observability, and cron configuration.
