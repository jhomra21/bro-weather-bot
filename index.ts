import { Hono } from "hono";
import { html } from "hono/html";
import { EmailMessage } from "cloudflare:email";
import { WorkerMailer } from "worker-mailer";
import { checkAfdbro } from "./lib/checkAfdbro.ts";
import { renderHtmlEmail } from "./lib/renderHtmlEmail.ts";
import { sanitizeAfosText } from "./lib/utils.ts";

const app = new Hono<{ Bindings: Env }>();

app.get("/", async (c) => {
  const lastRaw = await c.env.BRO_KV.get("AFDBRO:last");
  const last = lastRaw ? JSON.parse(lastRaw) : null;
  return c.json({ ok: true, last });
});

app.get("/check", async (c) => {
  const result = await checkAfdbro(c.env, { includeText: true });
  return c.json(result);
});

app.get("/check/raw", async (c) => {
  const result = await checkAfdbro(c.env, { includeText: true });
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
  const result = await checkAfdbro(c.env, { includeText: true });
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

// Simple form to send the latest report to a specified email
app.get("/email", async (c) => {
  const page = html`
    <!doctype html>
    <html>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Send AFDBRO Report</title>
        <style>
          body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, "Apple Color Emoji", "Segoe UI Emoji"; background: #0f172a; color: #E5E7EB; }
          .wrap { max-width: 740px; margin: 0 auto; padding: 24px; }
          h1 { font-size: 18px; margin: 0 0 14px 0; color: #cbd5e1; }
          form { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 14px; }
          input[type=email] { flex: 1 1 320px; background: #111827; color: #E5E7EB; border: 1px solid #374151; border-radius: 6px; padding: 10px 12px; font-size: 1rem; line-height: calc(1.5 / 1) }
          button { background: #2563eb; color: white; border: 0; border-radius: 6px; padding: 10px 14px; cursor: pointer; }
          button:disabled { opacity: .6; cursor: default; }
          .msg { min-height: 20px; color: #9ca3af; }
          .card { border: 1px solid #1f2937; border-radius: 8px; padding: 12px; background: #0b1222; }
          a { color: #93c5fd; }
        </style>
      </head>
      <body>
        <div class="wrap">
          <h1>Send the latest AFDBRO report to your email</h1>
          <form id="f" method="post" action="/email">
            <input name="to" type="email" placeholder="you@example.com" required />
            <button type="submit">Send</button>
          </form>
          <div id="m" class="msg">Enter your email and press Send.</div>
          <div class="card">
            Preview the text: <a href="/check/raw" target="_blank" rel="noopener">/check/raw</a> · Preview HTML: <a href="/check/html" target="_blank" rel="noopener">/check/html</a>
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
        </script>
      </body>
    </html>
  `;
  return c.html(page);
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

    let via: "smtp" | "email" | "" = "";
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
          await mailer.send({ from: c.env.SENDER, to, subject, text: clean, html: renderHtmlEmail(clean) });
          via = "smtp";
        } else if (c.env.EMAIL) {
          const boundary = `b_${Math.random().toString(36).slice(2)}`;
          const textPart = clean.replace(/\n/g, "\r\n");
          const htmlPart = renderHtmlEmail(clean);
          const headers = [
            `From: ${c.env.SENDER}`,
            `To: ${to}`,
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
          const msg = new EmailMessage(c.env.SENDER, to, raw);
          await c.env.EMAIL.send(msg);
          via = "email";
        } else {
          sendError = "No email binding available (missing SMTP vars and EMAIL binding).";
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

app.post("/check", async (c) => {
  const result = await checkAfdbro(c.env, { includeText: true });
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
    ctx.waitUntil(checkAfdbro(env));
  },
};
