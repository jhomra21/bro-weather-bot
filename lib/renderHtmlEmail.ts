// Render HTML email to preserve each original line and insert minimal section separators
export function renderHtmlEmail(text: string): string {
  // Escape HTML entities
  function escapeHtml(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

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
    const wrapperStyle = 'overflow-x:auto;-webkit-overflow-scrolling:touch;margin:14px 0 18px 0;';
    const tableStyle = 'width:100%;max-width:100%;min-width:560px;border:1px solid #2a3546;border-radius:6px;border-collapse:separate;border-spacing:0;background:transparent;table-layout:auto;';
    const rowSep = 'border-top:1px solid #263244;';
    const nameTd = 'padding:8px 12px;text-align:left;white-space:nowrap;word-break:keep-all;overflow-wrap:normal;font-weight:600;min-width:10ch;width:35%;';
    const numTd = 'padding:8px 10px;text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums;width:3ch;min-width:3ch;';
    const slashTd = 'padding:8px 8px;color:#9ca3af;text-align:center;width:1ch;min-width:1ch;';
    const thBase = 'padding:6px 10px;border-bottom:1px solid #2a3546;color:#cbd5e1;font-weight:600;white-space:nowrap;';
    let out = `<div style="${wrapperStyle}"><table role="presentation" cellpadding="0" cellspacing="0" style="${tableStyle}">`;
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
    out += '</table></div>';
    return out;
  }
  let html = "";
  let prevWasSeparator = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    // Escape, then preserve spacing faithfully
    const esc0 = escapeHtml(line);
    // Convert runs of 2+ spaces to a breakable pattern ("&nbsp; ") to avoid long unbreakable sequences
    const esc = esc0.replace(/ {2,}/g, (m) => {
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
    const baseStyle = 'white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere;';
    const headerExtra = isSectionHeader(line) ? 'color:#cbd5e1;font-weight:600;' : '';
    html += '<div style="' + baseStyle + headerExtra + '">' + content + "</div>";
    prevWasSeparator = false;
  }

  return (
    "<!doctype html>" +
    '<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="x-apple-disable-message-reformatting"><style>html,body{margin:0!important;padding:0!important;width:100%!important;min-width:100%!important;background:#111111!important}table{border-collapse:collapse!important}</style></head>' +
    '<body style="margin:0;padding:0 4px;font-size:16px;line-height:1.5;">' +
      '<div style="width:100vw;min-width:100vw;max-width:100vw;margin-left:calc(50% - 50vw);margin-right:calc(50% - 50vw);background:#111111;">' +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#111111;color:#ffffff;margin:0;padding:0;border-collapse:collapse;table-layout:fixed;width:100%!important;min-width:100%!important;max-width:100%!important;">' +
        '<tr><td align="left" style="padding:0;">' +
          '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;table-layout:fixed;width:100%!important;min-width:100%!important;max-width:100%!important;margin:0;"><tr><td>' +
            '<div style="font-family:\'Courier New\',Consolas,Menlo,\'Lucida Console\',monospace;' +
              'font-variant-ligatures:none;tab-size:8;letter-spacing:0;font-size:16px;line-height:1.5;text-align:left;">' +
              html +
            '</div>' +
          '</td></tr></table>' +
        '</td></tr>' +
      '</table>' +
      '</div>' +
    '</body></html>'
  );
}
