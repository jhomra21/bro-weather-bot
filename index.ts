import { Hono } from "hono";
import { html } from "hono/html";
import { WorkerMailer } from "worker-mailer";
import { checkAfdbro } from "./lib/checkAfdbro.ts";
import { renderHtmlEmail } from "./lib/renderHtmlEmail.ts";
import { sanitizeAfosText, sha256Hex } from "./lib/utils.ts";

const app = new Hono<{ Bindings: Env }>();

function renderEmailFormPage() {
  const page = html`
    <!doctype html>
    <html>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Send AFDBRO Report</title>
        <style>
          body { margin: 0; font-family: 'Courier New', Consolas, Menlo, 'Lucida Console', monospace; background: #111111; color: #ffffff; -webkit-text-size-adjust: 100%; font-size: 16px; line-height: 1.5; }
          .wrap { max-width: 720px; margin: 0 auto; padding: 24px; }
          h1 { font-size: 18px; margin: 0 0 14px 0; color: #cbd5e1; font-weight: 700; }
          form { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 14px; }
          input[type=email] { flex: 1 1 320px; background: #0b1222; color: #ffffff; border: 1px solid #2a3546; border-radius: 6px; padding: 10px 12px; font-size: 16px; line-height: 1.5; caret-color: #cbd5e1; font-family: inherit; appearance: none; -webkit-appearance: none; box-shadow: none; }
          input[type=email]::placeholder { color: #9ca3af; }
          button { background: #2a3546; color: #cbd5e1; border: 1px solid #2a3546; border-radius: 6px; padding: 10px 14px; cursor: pointer; font-family: inherit; font-size: 16px; line-height: 1.5; appearance: none; -webkit-appearance: none; box-shadow: none; }
          button:hover { background: #263244; }
          button:active { background: #212b3a; }
          button:disabled { opacity: .6; cursor: default; }
          input[type=email]:focus, button:focus { outline: 2px solid #263244; outline-offset: 2px; }
          .msg { min-height: 20px; color: #9ca3af; }
          .card { border: 1px solid #2a3546; border-radius: 8px; padding: 12px; background: #0b1222; margin-top: 10px; }
          .sep { margin: 10px 0 14px 0; border-top: 1px solid #2a3546; }
          a { color: #cbd5e1; text-decoration: underline; }
          a:hover { color: #ffffff; }
          a:visited { color: #9ca3af; }
          ::selection { background: #263244; color: #ffffff; }
        </style>
      </head>
      <body>
        <div class="wrap">
          <h1>Send the latest AFDBRO report to your email</h1>
          <div class="sep"></div>
          <form id="f" method="post" action="/email">
            <input name="to" type="email" placeholder="you@example.com" required />
            <button type="submit">Send</button>
          </form>
          <div id="m" class="msg">Enter your email and press Send.</div>
          <div class="sep"></div>
          <form id="s" method="post" action="/subscribe">
            <input name="email" type="email" placeholder="you@example.com" required />
            <button type="submit">Subscribe</button>
          </form>
          <div id="ms" class="msg">Subscribe to get future bulletins automatically.</div>
          <div class="card">
            <div style="margin-bottom:6px;color:#9ca3af;">Endpoints</div>
            <div>
              <a href="/">/</a> ·
              <a href="/check">/check</a> ·
              <a href="/check/raw">/check/raw</a> ·
              <a href="/check/html">/check/html</a>
            </div>
          </div>
        </div>
        <script>
          const f = document.getElementById('f');
          const m = document.getElementById('m');
          f.addEventListener('submit', async (e) => {
            e.preventDefault();
            m.textContent = 'Sending…';
            const btn = f.querySelector('button');
            btn.disabled = true;
            try {
              const fd = new FormData(f);
              const res = await fetch('/email', { method: 'POST', body: fd });
              const data = await res.json();
              if (data.ok) {
                m.textContent = 'Sent via ' + (data.via || 'email') + '.';
              } else {
                m.textContent = 'Failed: ' + (data.error || data.sendError || 'Unknown error');
              }
            } catch (err) {
              m.textContent = 'Error: ' + err;
            } finally {
              btn.disabled = false;
            }
          });
          const s = document.getElementById('s');
          const ms = document.getElementById('ms');
          s.addEventListener('submit', async (e) => {
            e.preventDefault();
            ms.textContent = 'Subscribing…';
            const btn = s.querySelector('button');
            btn.disabled = true;
            try {
              const fd = new FormData(s);
              const res = await fetch('/subscribe', { method: 'POST', body: fd });
              const data = await res.json();
              if (data.ok) {
                ms.textContent = data.message || 'Subscribed.';
              } else {
                ms.textContent = 'Failed: ' + (data.error || 'Unknown error');
              }
            } catch (err) {
              ms.textContent = 'Error: ' + err;
            } finally {
              btn.disabled = false;
            }
          });
        </script>
      </body>
    </html>
  `;
  return page;
}

app.get("/", async (c) => {
  const page = renderEmailFormPage();
  return c.html(page);
});

app.get("/check", async (c) => {
  const origin = new URL(c.req.url).origin;
  const result = await checkAfdbro(c.env, { includeText: true, baseUrlOverride: origin });
  return c.json(result);
});

app.get("/check/raw", async (c) => {
  const origin = new URL(c.req.url).origin;
  const result = await checkAfdbro(c.env, { includeText: true, baseUrlOverride: origin });
  if (result.error) {
    const status = result.upstreamStatus ?? 502;
    return new Response(`Error: ${result.error}`, {
      status,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  return new Response(result.text ?? "", {
    status: 200,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
});

app.get("/check/html", async (c) => {
  const origin = new URL(c.req.url).origin;
  const result = await checkAfdbro(c.env, { includeText: true, baseUrlOverride: origin });
  if (result.error || !result.text) {
    const status = result.upstreamStatus ?? 502;
    return new Response(`Error: ${result.error ?? "No text"}`, {
      status,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  return new Response(renderHtmlEmail(result.text), {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
});

// Handle POST from the form and send to the supplied recipient
app.post("/email", async (c) => {
  try {
    const form = await c.req.formData();
    const to = String(form.get("to") || "").trim();
    if (!to || !to.includes("@") || to.length > 254) {
      return c.json({ ok: false, error: "Invalid email" }, { status: 400 });
    }
    const url = "https://mesonet.agron.iastate.edu/cgi-bin/afos/retrieve.py?pil=AFDBRO&fmt=text&limit=1";
    const res = await fetch(url, { headers: { "User-Agent": "bro-weather-bot (+Cloudflare Worker)" } });
    if (!res.ok) return c.json({ ok: false, error: `Upstream responded ${res.status}` }, { status: 502 });
    const text = (await res.text())?.trim() ?? "";
    if (!text) return c.json({ ok: false, error: "Empty response from upstream" }, { status: 502 });
    const clean = sanitizeAfosText(text);
    const subject = "New AFDBRO (Brownsville) bulletin";
    const origin = new URL(c.req.url).origin;
    // If this recipient is an existing subscriber, include an unsubscribe link
    const toLower = to.toLowerCase();
    const id = await sha256Hex(toLower);
    const subKey = `SUBS:${id}`;
    const subRaw = await c.env.BRO_KV.get(subKey);
    let unsubUrl: string | undefined;
    if (subRaw) {
      try {
        const sub = JSON.parse(subRaw) as any;
        if (!sub.disabled) {
          if (!sub.unsubToken) {
            sub.unsubToken = `u_${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
            await c.env.BRO_KV.put(subKey, JSON.stringify(sub));
            await c.env.BRO_KV.put(`UNSUB:${sub.unsubToken}`, subKey);
          }
          unsubUrl = `${origin}/unsubscribe?token=${sub.unsubToken}`;
        }
      } catch {}
    }
    function withHtmlFooter(docHtml: string, footer: string): string {
      const needle = "</body></html>";
      const idx = docHtml.lastIndexOf(needle);
      if (idx === -1) return docHtml + footer;
      return docHtml.slice(0, idx) + footer + docHtml.slice(idx);
    }

    let via: "smtp" | "" = "";
    let sendError: string | undefined;
    if (c.env.SENDER) {
      try {
        const envAny = c.env as any;
        if (envAny.SMTP_HOST && envAny.SMTP_PORT && envAny.SMTP_USERNAME && envAny.SMTP_PASSWORD) {
          const port = Number(envAny.SMTP_PORT);
          const secure = envAny.SMTP_SECURE === "true" || port === 465;
          const startTls = envAny.SMTP_STARTTLS === undefined ? true : envAny.SMTP_STARTTLS === "true";
          const mailer = await WorkerMailer.connect({
            host: envAny.SMTP_HOST,
            port,
            secure,
            startTls,
            authType: ["plain", "login"],
            credentials: { username: envAny.SMTP_USERNAME, password: envAny.SMTP_PASSWORD },
          });
          const textBody = unsubUrl ? (clean + `\n\n—\nTo unsubscribe: ${unsubUrl}\n`) : clean;
          const htmlEmail = renderHtmlEmail(clean);
          const footerHtml = unsubUrl
            ? (`<div style="margin-top:18px;padding-top:10px;border-top:1px solid #2a3546;color:#9ca3af;font-size:14px;">This message was sent by bro-weather-bot. <a style="color:#cbd5e1;" href="${unsubUrl}">Unsubscribe</a>.</div>`)
            : "";
          const htmlBody = footerHtml ? withHtmlFooter(htmlEmail, footerHtml) : htmlEmail;
          await mailer.send({ from: c.env.SENDER, to, subject, text: textBody, html: htmlBody });
          via = "smtp";
        } else {
          sendError = "SMTP is not configured (missing SMTP_* vars).";
        }
      } catch (err: any) {
        sendError = String(err?.message ?? err);
      }
    } else {
      sendError = "SENDER not configured.";
    }

    const ok = !sendError && via !== "";
    return c.json({ ok, via, sendError });
  } catch (e: any) {
    return c.json({ ok: false, error: String(e?.message ?? e) }, { status: 500 });
  }
});

// Subscribe an email address to KV-backed subscriber list
app.post("/subscribe", async (c) => {
  try {
    const form = await c.req.formData();
    const email = String(form.get("email") || "").trim().toLowerCase();
    if (!email || !email.includes("@") || email.length > 254) {
      return c.json({ ok: false, error: "Invalid email" }, { status: 400 });
    }
    const id = await sha256Hex(email);
    const key = `SUBS:${id}`;
    const existingRaw = await c.env.BRO_KV.get(key);
    // Determine current latest hash so new subs do not receive retroactively
    let lastHash = "";
    const lastRaw = await c.env.BRO_KV.get("AFDBRO:last");
    if (lastRaw) {
      try {
        const obj = JSON.parse(lastRaw) as { hash?: string };
        if (obj?.hash) lastHash = obj.hash;
      } catch {}
    }
    if (existingRaw) {
      try {
        const obj = JSON.parse(existingRaw) as any;
        if (obj.disabled) {
          obj.disabled = false;
          if (!obj.lastSentHash) obj.lastSentHash = lastHash;
          if (!obj.createdAt) obj.createdAt = new Date().toISOString();
          if (!obj.unsubToken) {
            obj.unsubToken = `u_${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
          }
          await c.env.BRO_KV.put(key, JSON.stringify(obj));
          // Map token to subscriber key for O(1) lookup
          if (obj.unsubToken) {
            await c.env.BRO_KV.put(`UNSUB:${obj.unsubToken}`, key);
          }
          return c.json({ ok: true, message: "Subscription reactivated." });
        }
        return c.json({ ok: true, message: "You are already subscribed." });
      } catch {
        // Malformed value; overwrite with a clean record
      }
    }
    const token = `u_${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
    const record = {
      email,
      createdAt: new Date().toISOString(),
      lastSentHash: lastHash,
      lastSentAt: null as string | null,
      verified: true,
      disabled: false,
      unsubToken: token,
    };
    await c.env.BRO_KV.put(key, JSON.stringify(record));
    await c.env.BRO_KV.put(`UNSUB:${token}`, key);
    return c.json({ ok: true, message: "Subscribed." });
  } catch (e: any) {
    return c.json({ ok: false, error: String(e?.message ?? e) }, { status: 500 });
  }
});

// Unsubscribe via token; returns a simple HTML confirmation page
app.get("/unsubscribe", async (c) => {
  const url = new URL(c.req.url);
  const token = (url.searchParams.get("token") || "").trim();
  const home = "/";
  function page(title: string, message: string) {
    const body = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
    <style>body{margin:0;background:#111;color:#fff;font-family:'Courier New',Consolas,Menlo,'Lucida Console',monospace} .wrap{max-width:720px;margin:0 auto;padding:24px} a{color:#cbd5e1;text-decoration:underline} a:hover{color:#fff}</style>
    </head><body><div class="wrap"><h1 style="font-size:18px;margin:0 0 14px 0;color:#cbd5e1;font-weight:700;">${title}</h1>
    <div style="border-top:1px solid #2a3546;margin:10px 0 14px 0"></div>
    <div style="color:#9ca3af;line-height:1.6">${message}</div>
    <div class="sep" style="border-top:1px solid #2a3546;margin:14px 0 14px 0"></div>
    <div><a href="${home}">Go to home</a></div>
    </div></body></html>`;
    return new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
  }
  if (!token) {
    return page("Unsubscribe", "Missing token.");
  }
  try {
    const subKey = await c.env.BRO_KV.get(`UNSUB:${token}`);
    if (!subKey) {
      return page("Unsubscribe", "Invalid or expired unsubscribe link.");
    }
    const subRaw = await c.env.BRO_KV.get(subKey);
    if (!subRaw) {
      return page("Unsubscribe", "Subscription not found or already removed.");
    }
    try {
      const sub = JSON.parse(subRaw) as any;
      // Protect default RECIPIENT from being unsubscribed
      if (c.env.RECIPIENT && String(sub.email || "").toLowerCase() === String(c.env.RECIPIENT).toLowerCase()) {
        return page("Unsubscribe", "This address is a default recipient and cannot be unsubscribed.");
      }
      sub.disabled = true;
      await c.env.BRO_KV.put(subKey, JSON.stringify(sub));
      return page("Unsubscribe", "Your email has been removed from the list and will no longer receive updates.");
    } catch {
      await c.env.BRO_KV.delete(subKey);
      return page("Unsubscribe", "Your email has been removed from the list.");
    }
  } catch (e: any) {
    return page("Unsubscribe", "An error occurred: " + String(e?.message ?? e));
  }
});

app.post("/check", async (c) => {
  const origin = new URL(c.req.url).origin;
  const result = await checkAfdbro(c.env, { includeText: true, baseUrlOverride: origin });
  return c.json(result);
});

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) =>
    app.fetch(request, env, ctx),
  scheduled: async (
    event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext
  ) => {
    ctx.waitUntil(checkAfdbro(env, { send: true }));
  },
};
