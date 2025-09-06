import { EmailMessage } from "cloudflare:email";
import { WorkerMailer } from "worker-mailer";
import { sha256Hex, sanitizeAfosText } from "./utils.ts";
import { renderHtmlEmail } from "./renderHtmlEmail.ts";

export async function checkAfdbro(
  env: Env,
  opts?: { includeText?: boolean }
): Promise<{
  changed: boolean;
  hash?: string;
  error?: string;
  text?: string;
  sourceUrl: string;
  notified?: boolean;
  upstreamStatus?: number;
  sendError?: string;
}> {
  const url =
    "https://mesonet.agron.iastate.edu/cgi-bin/afos/retrieve.py?pil=AFDBRO&fmt=text&limit=1";
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "bro-weather-bot (+Cloudflare Worker)" },
    });
    if (!res.ok) {
      return {
        changed: false,
        error: `Upstream responded ${res.status}`,
        sourceUrl: url,
        upstreamStatus: res.status,
      };
    }
    const body = await res.text();
    const text = body?.trim() ?? "";
    const clean = sanitizeAfosText(text);
    if (text.length === 0) {
      return {
        changed: false,
        error: "Empty response from upstream",
        sourceUrl: url,
        upstreamStatus: res.status,
      };
    }

    const hash = await sha256Hex(clean);
    const lastRaw = await env.BRO_KV.get("AFDBRO:last");
    const last = lastRaw ? (JSON.parse(lastRaw) as { hash?: string }) : undefined;
    if (last?.hash === hash) {
      return {
        changed: false,
        hash,
        ...(opts?.includeText ? { text: clean } : {}),
        sourceUrl: url,
        upstreamStatus: res.status,
        notified: false,
      };
    }

    const subject = "New AFDBRO (Brownsville) bulletin";
    let notified = false;
    let sendError: string | undefined;
    const envAny = env as any;
    try {
      if (env.SENDER && env.RECIPIENT) {
        // Prefer SMTP via worker-mailer if credentials are provided
        if (
          envAny.SMTP_HOST &&
          envAny.SMTP_PORT &&
          envAny.SMTP_USERNAME &&
          envAny.SMTP_PASSWORD
        ) {
          const port = Number(envAny.SMTP_PORT);
          const secure = envAny.SMTP_SECURE === "true" || port === 465;
          const startTls = envAny.SMTP_STARTTLS === undefined
            ? true
            : envAny.SMTP_STARTTLS === "true";

          const mailer = await WorkerMailer.connect({
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

          await mailer.send({
            from: env.SENDER,
            to: env.RECIPIENT,
            subject,
            text: clean,
            html: renderHtmlEmail(clean),
          });
          notified = true;
        } else if (env.EMAIL) {
          // Fallback to Cloudflare Email binding (requires verified sender/recipient)
          // Build a multipart/alternative MIME (text + HTML) manually
          const boundary = `b_${Math.random().toString(36).slice(2)}`;
          const textPart = clean.replace(/\n/g, "\r\n");
          const htmlPart = renderHtmlEmail(clean); // keep \n for HTML
          const headers = [
            `From: ${env.SENDER}`,
            `To: ${env.RECIPIENT}`,
            `Subject: ${subject}`,
            `Date: ${new Date().toUTCString()}`,
            `MIME-Version: 1.0`,
            `Content-Type: multipart/alternative; boundary="${boundary}"`,
          ];
          const parts = [
            `--${boundary}`,
            `Content-Type: text/plain; charset=UTF-8`,
            `Content-Transfer-Encoding: 8bit`,
            ``,
            textPart,
            `--${boundary}`,
            `Content-Type: text/html; charset=UTF-8`,
            `Content-Transfer-Encoding: 8bit`,
            ``,
            htmlPart,
            `--${boundary}--`,
            ``,
          ];
          const raw = headers.join("\r\n") + "\r\n\r\n" + parts.join("\r\n");
          const msg = new EmailMessage(env.SENDER, env.RECIPIENT, raw);
          await env.EMAIL.send(msg);
          notified = true;
        }
      }
    } catch (e: any) {
      // Do not fail the check if email sending fails; report error instead.
      const msg = String(e?.message ?? e);
      console.error("Email send failed:", msg);
      sendError = msg;
    }

    await env.BRO_KV.put(
      "AFDBRO:last",
      JSON.stringify({ hash, seenAt: new Date().toISOString() })
    );
    return {
      changed: true,
      hash,
      ...(opts?.includeText ? { text: clean } : {}),
      sourceUrl: url,
      upstreamStatus: res.status,
      notified,
      ...(sendError ? { sendError } : {}),
    };
  } catch (err: any) {
    return { changed: false, error: String(err?.message ?? err), sourceUrl: url };
  }
}
