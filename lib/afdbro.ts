import { renderHtmlEmail } from "./renderHtmlEmail.ts";
import { sanitizeAfosText, sha256Hex } from "./utils.ts";

export const sourceUrl =
  "https://mesonet.agron.iastate.edu/cgi-bin/afos/retrieve.py?pil=AFDBRO&fmt=text&limit=1";

const LAST_BULLETIN_KEY = "AFDBRO:last";
const LAST_DELIVERY_KEY = "AFDBRO:delivery:last";
const DEFAULT_BASE_URL = "https://bro-weather-bot.jhonra121.workers.dev";

type Subscriber = {
  email: string;
  createdAt?: string;
  lastSentHash?: string;
  lastSentAt?: string | null;
  verified?: boolean;
  disabled?: boolean;
  unsubToken?: string;
};

type LastBulletin = {
  hash: string;
  seenAt: string;
};

export type Bulletin = {
  hash: string;
  sourceUrl: string;
  upstreamStatus: number;
  changedSinceLastDelivery: boolean;
  text: string;
};

export type InspectResult =
  | {
      status: "ok";
      bulletin: Bulletin;
    }
  | {
      status: "error";
      sourceUrl: string;
      error: string;
      upstreamStatus?: number;
    };

export type DeliveryIssue =
  | "smtp_not_configured"
  | "smtp_connect_failed"
  | "smtp_send_failed"
  | "subscriber_iteration_failed"
  | "upstream_fetch_failed";

export type DeliveryStatus = {
  status: "ok" | "partial" | "error";
  startedAt: string;
  completedAt: string;
  durationMs: number;
  hash?: string;
  changedSinceLastDelivery?: boolean;
  attempted: number;
  sent: number;
  upToDate: number;
  issues: DeliveryIssue[];
};

export type DeliveryResult =
  | {
      status: "ok" | "partial";
      bulletin: Bulletin;
      delivery: DeliveryStatus;
    }
  | {
      status: "error";
      sourceUrl: string;
      error: string;
      upstreamStatus?: number;
      delivery: DeliveryStatus;
    };

export type StatusResult = {
  lastBulletin: LastBulletin | null;
  lastDelivery: DeliveryStatus | null;
};

type Mailer = Awaited<
  ReturnType<(typeof import("worker-mailer"))["WorkerMailer"]["connect"]>
>;

type LoadedBulletin =
  | {
      status: "ok";
      bulletin: Bulletin & { text: string };
      previousHash?: string;
    }
  | {
      status: "error";
      sourceUrl: string;
      error: string;
      upstreamStatus?: number;
    };

function nowIso() {
  return new Date().toISOString();
}

function elapsedMs(startedAt: string, completedAt: string) {
  return Math.max(0, Date.parse(completedAt) - Date.parse(startedAt));
}

function uniqueIssues(issues: DeliveryIssue[]) {
  return [...new Set(issues)];
}

function withHtmlFooter(docHtml: string, footer: string): string {
  const needle = "</body></html>";
  const index = docHtml.lastIndexOf(needle);
  if (index === -1) return docHtml + footer;
  return docHtml.slice(0, index) + footer + docHtml.slice(index);
}

async function readLastBulletin(env: Env): Promise<LastBulletin | null> {
  const raw = await env.BRO_KV.get(LAST_BULLETIN_KEY);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<LastBulletin>;
    if (!value.hash || !value.seenAt) return null;
    return { hash: value.hash, seenAt: value.seenAt };
  } catch {
    return null;
  }
}

async function loadLatest(env: Env): Promise<LoadedBulletin> {
  try {
    const response = await fetch(sourceUrl, {
      headers: { "User-Agent": "bro-weather-bot (+Cloudflare Worker)" },
    });
    if (!response.ok) {
      return {
        status: "error",
        sourceUrl,
        error: `Upstream responded ${response.status}`,
        upstreamStatus: response.status,
      };
    }

    const body = await response.text();
    const text = body?.trim() ?? "";
    if (!text) {
      return {
        status: "error",
        sourceUrl,
        error: "Empty response from upstream",
        upstreamStatus: response.status,
      };
    }

    const clean = sanitizeAfosText(text);
    const hash = await sha256Hex(clean);
    const last = await readLastBulletin(env);

    return {
      status: "ok",
      previousHash: last?.hash,
      bulletin: {
        hash,
        text: clean,
        sourceUrl,
        upstreamStatus: response.status,
        changedSinceLastDelivery: last?.hash !== hash,
      },
    };
  } catch (error: any) {
    return {
      status: "error",
      sourceUrl,
      error: String(error?.message ?? error),
    };
  }
}

async function ensureDefaultSubscriber(
  env: Env,
  currentHash: string,
  previousHash?: string,
) {
  if (!env.RECIPIENT) return;

  const email = String(env.RECIPIENT).trim().toLowerCase();
  const id = await sha256Hex(email);
  const key = `SUBS:${id}`;
  const raw = await env.BRO_KV.get(key);

  if (!raw) {
    const token = createUnsubscribeToken();
    const subscriber: Subscriber = {
      email,
      createdAt: nowIso(),
      lastSentHash: previousHash ?? currentHash,
      lastSentAt: null,
      verified: true,
      disabled: false,
      unsubToken: token,
    };
    await env.BRO_KV.put(key, JSON.stringify(subscriber));
    await env.BRO_KV.put(`UNSUB:${token}`, key);
    return;
  }

  try {
    const subscriber = JSON.parse(raw) as Subscriber;
    subscriber.email = email;
    subscriber.disabled = false;
    if (!subscriber.unsubToken) {
      subscriber.unsubToken = createUnsubscribeToken();
      await env.BRO_KV.put(`UNSUB:${subscriber.unsubToken}`, key);
    }
    await env.BRO_KV.put(key, JSON.stringify(subscriber));
  } catch {
    const token = createUnsubscribeToken();
    const subscriber: Subscriber = {
      email,
      createdAt: nowIso(),
      lastSentHash: previousHash ?? currentHash,
      lastSentAt: null,
      verified: true,
      disabled: false,
      unsubToken: token,
    };
    await env.BRO_KV.put(key, JSON.stringify(subscriber));
    await env.BRO_KV.put(`UNSUB:${token}`, key);
  }
}

function createUnsubscribeToken() {
  return `u_${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
}

async function writeDeliveryStatus(env: Env, value: DeliveryStatus) {
  await env.BRO_KV.put(LAST_DELIVERY_KEY, JSON.stringify(value));
}

function logDelivery(value: DeliveryStatus, error?: string) {
  const payload = {
    event: "afdbro.delivery",
    ...value,
    ...(error ? { error } : {}),
  };
  if (value.status === "error") {
    console.error(JSON.stringify(payload));
  } else if (value.status === "partial") {
    console.warn(JSON.stringify(payload));
  } else {
    console.log(JSON.stringify(payload));
  }
}

export async function inspect(env: Env): Promise<InspectResult> {
  const loaded = await loadLatest(env);
  if (loaded.status === "error") return loaded;

  return {
    status: "ok",
    bulletin: loaded.bulletin,
  };
}

export async function deliver(
  env: Env,
  options: { baseUrlOverride?: string } = {},
): Promise<DeliveryResult> {
  const startedAt = nowIso();
  const loaded = await loadLatest(env);

  if (loaded.status === "error") {
    const completedAt = nowIso();
    const delivery: DeliveryStatus = {
      status: "error",
      startedAt,
      completedAt,
      durationMs: elapsedMs(startedAt, completedAt),
      attempted: 0,
      sent: 0,
      upToDate: 0,
      issues: ["upstream_fetch_failed"],
    };
    await writeDeliveryStatus(env, delivery);
    logDelivery(delivery, loaded.error);
    return { ...loaded, delivery };
  }

  const { bulletin, previousHash } = loaded;
  await ensureDefaultSubscriber(env, bulletin.hash, previousHash);

  const envAny = env as any;
  const issues: DeliveryIssue[] = [];
  let mailer: Mailer | null | undefined;

  async function getMailer(): Promise<Mailer | null> {
    if (mailer !== undefined) return mailer;

    if (
      !env.SENDER ||
      !envAny.SMTP_HOST ||
      !envAny.SMTP_PORT ||
      !envAny.SMTP_USERNAME ||
      !envAny.SMTP_PASSWORD
    ) {
      issues.push("smtp_not_configured");
      mailer = null;
      return null;
    }

    try {
      const { WorkerMailer } = await import("worker-mailer");
      const port = Number(envAny.SMTP_PORT);
      const secure = envAny.SMTP_SECURE === "true" || port === 465;
      const startTls =
        envAny.SMTP_STARTTLS === undefined
          ? true
          : envAny.SMTP_STARTTLS === "true";

      mailer = await WorkerMailer.connect({
        host: envAny.SMTP_HOST,
        port,
        secure,
        startTls,
        authType: ["plain", "login"],
        credentials: {
          username: envAny.SMTP_USERNAME,
          password: envAny.SMTP_PASSWORD,
        },
      });
      return mailer;
    } catch (error: any) {
      issues.push("smtp_connect_failed");
      mailer = null;
      console.error(
        JSON.stringify({
          event: "afdbro.smtp.connect_failed",
          error: String(error?.message ?? error),
        }),
      );
      return null;
    }
  }

  const baseUrl = (
    options.baseUrlOverride ||
    String(envAny.BASE_URL || DEFAULT_BASE_URL)
  )
    .trim()
    .replace(/\/+$/, "");

  let attempted = 0;
  let sent = 0;
  let upToDate = 0;

  try {
    let cursor: string | undefined;
    do {
      const page: any = await env.BRO_KV.list({
        prefix: "SUBS:",
        ...(cursor ? { cursor } : {}),
      });
      cursor = page.cursor || undefined;

      for (const key of page.keys) {
        try {
          const raw = await env.BRO_KV.get(key.name);
          if (!raw) continue;

          const subscriber = JSON.parse(raw) as Subscriber;
          if (subscriber.disabled) continue;

          const email = String(subscriber.email || "")
            .trim()
            .toLowerCase();
          if (!email || !email.includes("@") || email.length > 254) continue;

          if (subscriber.lastSentHash === bulletin.hash) {
            upToDate++;
            continue;
          }

          attempted++;

          const activeMailer = await getMailer();
          if (!activeMailer || !env.SENDER) continue;

          if (!subscriber.unsubToken) {
            subscriber.unsubToken = createUnsubscribeToken();
            await env.BRO_KV.put(
              `UNSUB:${subscriber.unsubToken}`,
              key.name,
            );
          }

          const unsubscribeUrl = `${baseUrl}/unsubscribe?token=${subscriber.unsubToken}`;
          const textBody =
            bulletin.text + `\n\n—\nTo unsubscribe: ${unsubscribeUrl}\n`;
          const footerHtml =
            '<div style="margin-top:18px;padding-top:10px;border-top:1px solid #2a3546;color:#9ca3af;font-size:14px;">' +
            "This message was sent by bro-weather-bot. " +
            `<a style="color:#cbd5e1;" href="${unsubscribeUrl}">Unsubscribe</a>.` +
            "</div>";
          const htmlBody = withHtmlFooter(
            renderHtmlEmail(bulletin.text),
            footerHtml,
          );

          try {
            await activeMailer.send({
              from: env.SENDER,
              to: email,
              subject: "New AFDBRO (Brownsville) bulletin",
              text: textBody,
              html: htmlBody,
            });
          } catch (error: any) {
            issues.push("smtp_send_failed");
            console.error(
              JSON.stringify({
                event: "afdbro.smtp.send_failed",
                error: String(error?.message ?? error),
              }),
            );
            continue;
          }

          sent++;
          subscriber.lastSentHash = bulletin.hash;
          subscriber.lastSentAt = nowIso();
          await env.BRO_KV.put(key.name, JSON.stringify(subscriber));
        } catch {
          continue;
        }
      }
    } while (cursor);
  } catch (error: any) {
    issues.push("subscriber_iteration_failed");
    console.error(
      JSON.stringify({
        event: "afdbro.subscribers.iteration_failed",
        error: String(error?.message ?? error),
      }),
    );
  }

  const completedAt = nowIso();
  const dedupedIssues = uniqueIssues(issues);
  const status: DeliveryStatus["status"] =
    dedupedIssues.length === 0
      ? "ok"
      : sent > 0
        ? "partial"
        : "error";

  const delivery: DeliveryStatus = {
    status,
    startedAt,
    completedAt,
    durationMs: elapsedMs(startedAt, completedAt),
    hash: bulletin.hash,
    changedSinceLastDelivery: bulletin.changedSinceLastDelivery,
    attempted,
    sent,
    upToDate,
    issues: dedupedIssues,
  };

  await env.BRO_KV.put(
    LAST_BULLETIN_KEY,
    JSON.stringify({ hash: bulletin.hash, seenAt: completedAt }),
  );
  await writeDeliveryStatus(env, delivery);
  logDelivery(delivery);

  const result = {
    status: status === "ok" ? "ok" : "partial",
    bulletin,
    delivery,
  } as const;

  if (status === "error") {
    return {
      ...result,
      status: "partial",
    };
  }
  return result;
}

export async function status(env: Env): Promise<StatusResult> {
  const [lastBulletin, deliveryRaw] = await Promise.all([
    readLastBulletin(env),
    env.BRO_KV.get(LAST_DELIVERY_KEY),
  ]);

  let lastDelivery: DeliveryStatus | null = null;
  if (deliveryRaw) {
    try {
      lastDelivery = JSON.parse(deliveryRaw) as DeliveryStatus;
    } catch {
      lastDelivery = null;
    }
  }

  return { lastBulletin, lastDelivery };
}
