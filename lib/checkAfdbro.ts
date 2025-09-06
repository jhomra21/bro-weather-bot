import { WorkerMailer } from "worker-mailer";
import { sha256Hex, sanitizeAfosText } from "./utils.ts";
import { renderHtmlEmail } from "./renderHtmlEmail.ts";

export async function checkAfdbro(
  env: Env,
  opts?: { includeText?: boolean; baseUrlOverride?: string }
): Promise<{
  changed: boolean;
  hash?: string;
  error?: string;
  text?: string;
  sourceUrl: string;
  notified?: boolean;
  upstreamStatus?: number;
  sendError?: string;
  notifiedCount?: number;
  attemptedCount?: number;
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
    const previousHash = last?.hash;
    const changed = previousHash !== hash;
    // Always update latest seen hash for status/visibility
    await env.BRO_KV.put(
      "AFDBRO:last",
      JSON.stringify({ hash, seenAt: new Date().toISOString() })
    );

    const subject = "New AFDBRO (Brownsville) bulletin";
    let notifiedCount = 0;
    let attemptedCount = 0;
    let sendError: string | undefined;
    const envAny = env as any;

    // Ensure default env.RECIPIENT exists as a subscriber and cannot be disabled
    if (env.RECIPIENT) {
      const defaultEmail = String(env.RECIPIENT).trim().toLowerCase();
      const defId = await sha256Hex(defaultEmail);
      const defKey = `SUBS:${defId}`;
      const existing = await env.BRO_KV.get(defKey);
      if (!existing) {
        // Initialize with previousHash to avoid retroactive send if nothing changed
        const token = `u_${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
        const rec = {
          email: defaultEmail,
          createdAt: new Date().toISOString(),
          lastSentHash: previousHash ?? hash,
          lastSentAt: null as string | null,
          verified: true,
          disabled: false,
          unsubToken: token,
        };
        await env.BRO_KV.put(defKey, JSON.stringify(rec));
        await env.BRO_KV.put(`UNSUB:${token}`, defKey);
      } else {
        try {
          const obj = JSON.parse(existing) as any;
          // Force enabled for default recipient
          if (obj.disabled) obj.disabled = false;
          if (!obj.email) obj.email = defaultEmail;
          if (!obj.unsubToken) {
            obj.unsubToken = `u_${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
            await env.BRO_KV.put(`UNSUB:${obj.unsubToken}`, defKey);
          }
          await env.BRO_KV.put(defKey, JSON.stringify(obj));
        } catch {
          const token2 = `u_${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
          await env.BRO_KV.put(
            defKey,
            JSON.stringify({
              email: defaultEmail,
              createdAt: new Date().toISOString(),
              lastSentHash: previousHash ?? hash,
              lastSentAt: null as string | null,
              verified: true,
              disabled: false,
              unsubToken: token2,
            })
          );
          await env.BRO_KV.put(`UNSUB:${token2}`, defKey);
        }
      }
    }

    // Helper to inject an HTML footer before </body></html>
    function withHtmlFooter(docHtml: string, footer: string): string {
      const needle = "</body></html>";
      const idx = docHtml.lastIndexOf(needle);
      if (idx === -1) return docHtml + footer; // fallback append
      return docHtml.slice(0, idx) + footer + docHtml.slice(idx);
    }

    // Compute base URL for unsubscribe links
    const base = (opts?.baseUrlOverride
      || String(envAny.BASE_URL || "https://bro-weather-bot.jhonra121.workers.dev")).trim().replace(/\/+$/, "");

    // Prepare SMTP mailer if credentials provided
    let mailer: any = null;
    if (
      envAny.SMTP_HOST &&
      envAny.SMTP_PORT &&
      envAny.SMTP_USERNAME &&
      envAny.SMTP_PASSWORD
    ) {
      try {
        const port = Number(envAny.SMTP_PORT);
        const secure = envAny.SMTP_SECURE === "true" || port === 465;
        const startTls =
          envAny.SMTP_STARTTLS === undefined ? true : envAny.SMTP_STARTTLS === "true";
        mailer = await WorkerMailer.connect({
          host: envAny.SMTP_HOST,
          port,
          secure,
          startTls,
          authType: ["plain", "login"],
          credentials: { username: envAny.SMTP_USERNAME, password: envAny.SMTP_PASSWORD },
        });
      } catch (e: any) {
        const msg = String(e?.message ?? e);
        console.error("SMTP connect failed:", msg);
        sendError = sendError || msg;
      }
    }

    // Iterate subscribers and send to those behind
    try {
      let cursor: string | undefined = undefined;
      do {
        const listRes: any = await env.BRO_KV.list({ prefix: "SUBS:", cursor });
        cursor = listRes.cursor;
        for (const key of listRes.keys) {
          try {
            const subRaw = await env.BRO_KV.get(key.name);
            if (!subRaw) continue;
            const sub = JSON.parse(subRaw) as any;
            if (sub.disabled) continue;
            const email = String(sub.email || "").trim().toLowerCase();
            if (!email || !email.includes("@") || email.length > 254) continue;
            if (sub.lastSentHash === hash) continue; // already up to date
            // Ensure unsubscribe token exists and map token -> subscriber key
            if (!sub.unsubToken) {
              sub.unsubToken = `u_${Math.random().toString(36).slice(2)}${Math.random()
                .toString(36)
                .slice(2)}`;
              await env.BRO_KV.put(key.name, JSON.stringify(sub));
              await env.BRO_KV.put(`UNSUB:${sub.unsubToken}`, key.name);
            }
            attemptedCount++;

            if (!env.SENDER) {
              sendError = sendError || "SENDER not configured.";
              continue;
            }

            let sent = false;
            if (mailer) {
              // Build per-subscriber bodies with unsubscribe link
              const unsubUrl = `${base}/unsubscribe?token=${sub.unsubToken}`;
              const textBody = clean + `\n\n—\nTo unsubscribe: ${unsubUrl}\n`;
              const footerHtml =
                `<div style="margin-top:18px;padding-top:10px;border-top:1px solid #2a3546;color:#9ca3af;font-size:14px;">` +
                `This message was sent by bro-weather-bot. ` +
                `<a style="color:#cbd5e1;" href="${unsubUrl}">Unsubscribe</a>.` +
                `</div>`;
              const htmlEmail = renderHtmlEmail(clean);
              const htmlBody = withHtmlFooter(htmlEmail, footerHtml);
              try {
                await mailer.send({
                  from: env.SENDER,
                  to: email,
                  subject,
                  text: textBody,
                  html: htmlBody,
                });
                sent = true;
              } catch (e: any) {
                const msg = String(e?.message ?? e);
                console.error("SMTP send failed:", msg);
                sendError = sendError || msg;
              }
            }

            if (sent) {
              notifiedCount++;
              // Update subscriber state to the latest hash
              sub.lastSentHash = hash;
              sub.lastSentAt = new Date().toISOString();
              await env.BRO_KV.put(key.name, JSON.stringify(sub));
            }
          } catch (e) {
            // Skip malformed subscriber records
            continue;
          }
        }
      } while (cursor);
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      console.error("Subscriber iteration failed:", msg);
      sendError = sendError || msg;
    }

    return {
      changed,
      hash,
      ...(opts?.includeText ? { text: clean } : {}),
      sourceUrl: url,
      upstreamStatus: res.status,
      notified: notifiedCount > 0,
      ...(sendError ? { sendError } : {}),
      notifiedCount,
      attemptedCount,
    };
  } catch (err: any) {
    return { changed: false, error: String(err?.message ?? err), sourceUrl: url };
  }
}
