import { Hono } from "hono";
import { html } from "hono/html";
import { EmailMessage } from "cloudflare:email";
import { WorkerMailer } from "worker-mailer";

type Bindings = {
  BRO_KV: any; // KVNamespace
  EMAIL: any; // SendEmail binding
  SENDER?: string;
  RECIPIENT?: string;
  SMTP_HOST?: string;
  SMTP_PORT?: string; // string from env; parse to number when used
  SMTP_USERNAME?: string;
  SMTP_PASSWORD?: string;
  SMTP_SECURE?: string; // "true" | "false"
  SMTP_STARTTLS?: string; // "true" | "false"
};

const app = new Hono<{ Bindings: Bindings }>();

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(digest);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Remove SOH and other control chars, normalize newlines, and tidy whitespace
function sanitizeAfosText(raw: string): string {
  let out = raw.replace(/\r\n?|\u000d\u000a?/g, "\n");
  // Strip ASCII control characters except tab (\t) and newline (\n)
  out = out.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
  // Trim spaces at EOL
  out = out.replace(/[ \t]+\n/g, "\n");
  // Collapse 3+ blank lines to 2
  out = out.replace(/\n{3,}/g, "\n\n");
  // Ensure a single trailing newline
  out = out.trimEnd() + "\n";
  return out;
}

// Escape HTML entities
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Render HTML email to preserve each original line and insert minimal section separators
function renderHtmlEmail(text: string): string {
  // Convert tabs to 8 spaces for consistent alignment across email clients
  const normalized = text.replace(/\t/g, "        ");
  const lines = normalized.split("\n");
  function isAmpSeparator(line: string): boolean {
    const t = line.trim();
    // Treat any line consisting solely of 2+ ampersands as a separator
    return /^&{2,}$/.test(t);
  }
  function isSectionHeader(line: string): boolean {
    const t = line.trim();
    if (t.startsWith("...")) return true; // e.g. ...NEW DISCUSSION
    if (t.startsWith(".")) return true;   // e.g. .KEY MESSAGES...
    return false;
  }

  // Detect the PRELIMINARY POINT TEMPS/POPS header line
  function isPrelimHeader(line: string): boolean {
    return /^\s*\.PRELIMINARY POINT TEMPS\/POPS/i.test(line);
  }

  // Parse a Temps/POPS data row, return tuple or null if it doesn't match
  function parsePrelimRow(row: string): [string,string,string,string,string,string,string,string,string] | null {
    const m = row.match(/^\s*([A-Z0-9][A-Z0-9 ./'()\-]*?)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\/\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/i);
    if (!m) return null;
    const city = m[1]!.trim();
    const t1 = m[2]!; const t2 = m[3]!; const t3 = m[4]!; const t4 = m[5]!;
    const p1 = m[6]!; const p2 = m[7]!; const p3 = m[8]!; const p4 = m[9]!;
    return [city, t1, t2, t3, t4, p1, p2, p3, p4];
  }

  function buildPrelimTable(rows: Array<[string,string,string,string,string,string,string,string,string]>): string {
    const tableStyle = 'width:100%;max-width:100%;border:1px solid #2a3546;border-radius:6px;margin:14px 0 18px 0;border-collapse:separate;border-spacing:0;background:transparent;';
    const rowSep = 'border-top:1px solid #263244;';
    const nameTd = 'padding:8px 12px;text-align:left;white-space:nowrap;font-weight:600;';
    const numTd = 'padding:8px 10px;text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums;min-width:2ch;';
    const slashTd = 'padding:8px 8px;color:#9ca3af;text-align:center;';
    const thBase = 'padding:6px 10px;border-bottom:1px solid #2a3546;color:#cbd5e1;font-weight:600;white-space:nowrap;';
    let out = `<table role="presentation" cellpadding="0" cellspacing="0" style="${tableStyle}">`;
    out += '<thead><tr>' +
      `<th style="${thBase} text-align:left;">City</th>` +
      `<th style="${thBase} text-align:center;" colspan="4">Temps</th>` +
      `<th style="${thBase} text-align:center;">/</th>` +
      `<th style="${thBase} text-align:center;" colspan="4">PoPs</th>` +
    '</tr></thead>';
    rows.forEach((r, idx) => {
      const [city, t1, t2, t3, t4, p1, p2, p3, p4] = r;
      const trStyle = idx === 0 ? '' : rowSep;
      const zebra = idx % 2 === 1 ? 'background:rgba(255,255,255,0.02);' : '';
      out += `<tr style="${trStyle}${zebra}">` +
        `<td style="${nameTd}">${escapeHtml(city)}</td>` +
        `<td style="${numTd}">${t1}</td>` +
        `<td style="${numTd}">${t2}</td>` +
        `<td style="${numTd}">${t3}</td>` +
        `<td style="${numTd}">${t4}</td>` +
        `<td style="${slashTd}">/</td>` +
        `<td style="${numTd}">${p1}</td>` +
        `<td style="${numTd}">${p2}</td>` +
        `<td style="${numTd}">${p3}</td>` +
        `<td style="${numTd}">${p4}</td>` +
      '</tr>';
    });
    out += '</table>';
    return out;
  }
  let html = "";
  let prevWasSeparator = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    // Escape, then preserve spacing faithfully
    const esc0 = escapeHtml(line);
    const esc1 = esc0.replace(/^ +/g, (m) => "&nbsp;".repeat(m.length));
    const esc = esc1.replace(/ {2,}/g, (m) => {
      const pairs = Math.floor(m.length / 2);
      const rem = m.length % 2;
      return "&nbsp; ".repeat(pairs) + (rem ? "&nbsp;" : "");
    });
    // Insert a subtle separator before headers or '&&' separators (but not at very top)
    if (i > 0 && (isSectionHeader(line) || isAmpSeparator(line)) && !prevWasSeparator) {
      html += '<div style="margin:10px 0 6px 0;border-top:1px solid #2a3546;"></div>';
      prevWasSeparator = true;
    }
    // If it's a bare '&&' separator, do not render the line text itself
    if (isAmpSeparator(line)) {
      continue;
    }

    // PRELIMINARY POINT TEMPS/POPS block: render as a minimal table
    if (isPrelimHeader(line)) {
      // Render the header line with emphasis
      const headerContent = (escapeHtml(line).length === 0 ? '&nbsp;' : escapeHtml(line));
      html += '<div style="white-space:pre-wrap;word-break:normal;overflow-wrap:normal;color:#cbd5e1;font-weight:600;">' + headerContent + '</div>';
      // Collect following rows until blank line, next header, or separator
      const rows: Array<[string,string,string,string,string,string,string,string,string]> = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        const nxt = lines[j] ?? '';
        const t = nxt.trim();
        if (t === '' || isSectionHeader(nxt) || isAmpSeparator(nxt)) {
          break;
        }
        const parsed = parsePrelimRow(nxt);
        if (parsed) {
          rows.push(parsed);
        } else {
          // Stop at the first unparseable row to avoid swallowing other content
          break;
        }
      }
      if (rows.length > 0) {
        html += buildPrelimTable(rows);
        i = j - 1; // skip the rows we consumed
        prevWasSeparator = false;
        continue;
      }
      // If no parsed rows, fall through to normal rendering of this line
    }
    // Render each original line as its own block; preserve spaces and allow wrapping
    const content = esc.length === 0 ? "&nbsp;" : esc;
    const baseStyle = 'white-space:pre-wrap;word-break:normal;overflow-wrap:normal;';
    const headerExtra = isSectionHeader(line) ? 'color:#cbd5e1;font-weight:600;' : '';
    html += '<div style="' + baseStyle + headerExtra + '">' + content + "</div>";
    prevWasSeparator = false;
  }

  return (
    "<!doctype html>" +
    '<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>' +
    '<body style="margin:0;">' +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#111111;color:#ffffff;">' +
        '<tr><td align="center" style="padding:16px;">' +
          '<table role="presentation" width="720" cellpadding="0" cellspacing="0" style="max-width:100%;"><tr><td>' +
            '<div style="font-family:\'Courier New\',Consolas,Menlo,\'Lucida Console\',monospace;' +
              'font-variant-ligatures:none;tab-size:8;letter-spacing:0;font-size:16px;line-height:1.5;text-align:left;">' +
              html +
            '</div>' +
          '</td></tr></table>' +
        '</td></tr>' +
      '</table>' +
    '</body></html>'
  );
}

async function checkAfdbro(
  env: Bindings,
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
    try {
      if (env.SENDER && env.RECIPIENT) {
        // Prefer SMTP via worker-mailer if credentials are provided
        if (
          env.SMTP_HOST &&
          env.SMTP_PORT &&
          env.SMTP_USERNAME &&
          env.SMTP_PASSWORD
        ) {
          const port = Number(env.SMTP_PORT);
          const secure = env.SMTP_SECURE === "true" || port === 465;
          const startTls = env.SMTP_STARTTLS === undefined
            ? true
            : env.SMTP_STARTTLS === "true";

          const mailer = await WorkerMailer.connect({
            host: env.SMTP_HOST,
            port,
            secure,
            startTls,
            authType: ["plain", "login"],
            credentials: {
              username: env.SMTP_USERNAME,
              password: env.SMTP_PASSWORD,
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

app.get("/send/test", async (c) => {
  const subject = "New AFDBRO (Brownsville) bulletin";
  const url =
    "https://mesonet.agron.iastate.edu/cgi-bin/afos/retrieve.py?pil=AFDBRO&fmt=text&limit=1";
  let notified = false;
  let via: "smtp" | "email" | "" = "";
  let sendError: string | undefined;
  let clean = "";
  try {
    // Fetch real AFDBRO text, sanitize it, then send regardless of change
    const res = await fetch(url, {
      headers: { "User-Agent": "bro-weather-bot (+Cloudflare Worker)" },
    });
    if (!res.ok) {
      return c.json({ ok: false, error: `Upstream responded ${res.status}`, sourceUrl: url }, { status: 502 });
    }
    const body = await res.text();
    const text = body?.trim() ?? "";
    clean = sanitizeAfosText(text);
    if (text.length === 0) {
      return c.json({ ok: false, error: "Empty response from upstream", sourceUrl: url }, { status: 502 });
    }

    const env = c.env;
    if (env.SENDER && env.RECIPIENT) {
      if (
        env.SMTP_HOST &&
        env.SMTP_PORT &&
        env.SMTP_USERNAME &&
        env.SMTP_PASSWORD
      ) {
        const port = Number(env.SMTP_PORT);
        const secure = env.SMTP_SECURE === "true" || port === 465;
        const startTls = env.SMTP_STARTTLS === undefined
          ? true
          : env.SMTP_STARTTLS === "true";
        const mailer = await WorkerMailer.connect({
          host: env.SMTP_HOST,
          port,
          secure,
          startTls,
          authType: ["plain", "login"],
          credentials: {
            username: env.SMTP_USERNAME,
            password: env.SMTP_PASSWORD,
          },
        });
        await mailer.send({
          from: env.SENDER,
          to: env.RECIPIENT,
          subject,
          text: clean,
          html: renderHtmlEmail(clean),
        });
        via = "smtp";
        notified = true;
      } else if (env.EMAIL) {
        const boundary = `b_${Math.random().toString(36).slice(2)}`;
        const textPart = clean.replace(/\n/g, "\r\n");
        const htmlPart = renderHtmlEmail(clean);
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
        via = "email";
        notified = true;
      } else {
        sendError = "No email binding available (missing SMTP vars and EMAIL binding).";
      }
    } else {
      sendError = "SENDER/RECIPIENT not configured.";
    }
  } catch (e: any) {
    sendError = String(e?.message ?? e);
  }
  return c.json({ ok: notified && !sendError, notified, via, sendError, sourceUrl: url, bytes: clean.length });
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
        if (c.env.SMTP_HOST && c.env.SMTP_PORT && c.env.SMTP_USERNAME && c.env.SMTP_PASSWORD) {
          const port = Number(c.env.SMTP_PORT);
          const secure = c.env.SMTP_SECURE === "true" || port === 465;
          const startTls = c.env.SMTP_STARTTLS === undefined ? true : c.env.SMTP_STARTTLS === "true";
          const mailer = await WorkerMailer.connect({
            host: c.env.SMTP_HOST,
            port,
            secure,
            startTls,
            authType: ["plain", "login"],
            credentials: { username: c.env.SMTP_USERNAME, password: c.env.SMTP_PASSWORD },
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
  fetch: (request: Request, env: Bindings, ctx: ExecutionContext) =>
    app.fetch(request, env, ctx),
  scheduled: async (
    event: ScheduledEvent,
    env: Bindings,
    ctx: ExecutionContext
  ) => {
    ctx.waitUntil(checkAfdbro(env));
  },
};
