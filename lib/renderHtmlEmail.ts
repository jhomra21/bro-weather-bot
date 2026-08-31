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

  function isClimateRecordsHeader(line: string): boolean {
    return /^\s*Record High Temperatures from .+:\s*$/i.test(line);
  }

  function parseClimateDate(line: string): string | null {
    const m = line.match(/^\s*((?:Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day,\s+[A-Za-z]+\s+\d{1,2},\s+\d{4})\s*$/i);
    return m ? m[1]! : null;
  }

  function parseClimateRecordRow(row: string): [string, string] | null {
    const m = row.match(/^\s*([A-Za-z][A-Za-z ./'()\-]*?):\s*(\d{2,3}F(?:\s+\([^)]+\))?)\s*$/i);
    if (!m) return null;
    return [m[1]!.trim(), m[2]!.trim()];
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

  function buildClimateRecordsTable(days: Array<{ date: string; records: Record<string, string> }>, sites: string[]): string {
    const wrapperStyle = 'overflow-x:auto;-webkit-overflow-scrolling:touch;margin:14px 0 18px 0;';
    const tableStyle = 'width:100%;max-width:100%;min-width:760px;border:1px solid #e5e7eb;border-radius:6px;border-collapse:separate;border-spacing:0;background:transparent;table-layout:auto;';
    const rowSep = 'border-top:1px solid #e5e7eb;';
    const thBase = 'padding:7px 10px;border-bottom:1px solid #e5e7eb;color:#0f172a;font-weight:700;white-space:nowrap;text-align:right;';
    const siteTd = 'padding:8px 12px;text-align:left;white-space:nowrap;font-weight:600;';
    const valueTd = 'padding:8px 10px;text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums;';
    let out = `<div style="${wrapperStyle}"><table role="presentation" cellpadding="0" cellspacing="0" style="${tableStyle}">`;
    out += '<thead><tr>' +
      `<th style="${thBase} text-align:left;">City</th>` +
      days.map((day) => `<th style="${thBase}">${escapeHtml(day.date)}</th>`).join('') +
    '</tr></thead>';
    sites.forEach((site, idx) => {
      const trStyle = idx === 0 ? '' : rowSep;
      const zebra = idx % 2 === 1 ? 'background:rgba(0,0,0,0.03);' : '';
      out += `<tr style="${trStyle}${zebra}">` +
        `<td style="${siteTd}">${escapeHtml(site)}</td>` +
        days.map((day) => `<td style="${valueTd}">${escapeHtml(day.records[site] ?? '—')}</td>`).join('') +
      '</tr>';
    });
    out += '</table></div>';
    return out;
  }

  function parseIssuedDate(): Date | null {
    const months: Record<string, number> = {
      Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
      Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
    };
    for (const line of lines) {
      const m = line.match(/\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{4})\b/);
      if (!m) continue;
      const month = months[m[1]!];
      if (month === undefined) continue;
      return new Date(Date.UTC(Number(m[3]), month, Number(m[2])));
    }
    return null;
  }

  function addDays(date: Date, count: number): Date {
    return new Date(date.getTime() + count * 86400000);
  }

  function formatForecastDate(date: Date): string {
    const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${weekdays[date.getUTCDay()]} ${months[date.getUTCMonth()]} ${date.getUTCDate()}`;
  }

  function formatClimateLookupDate(date: Date): string {
    const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    return `${weekdays[date.getUTCDay()]}, ${months[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()}`;
  }

  function recordFor(
    days: Array<{ date: string; records: Record<string, string> }>,
    city: string,
    date: Date
  ): { temperature: number; text: string } | null {
    const targetDate = formatClimateLookupDate(date).toLowerCase();
    const day = days.find((item) => item.date.toLowerCase() === targetDate);
    if (!day) return null;
    const entry = Object.entries(day.records).find(([site]) => site.toLowerCase() === city.toLowerCase());
    if (!entry) return null;
    const m = entry[1].match(/^(\d{2,3})F\b/i);
    if (!m) return null;
    return { temperature: Number(m[1]), text: entry[1] };
  }

  function buildPrelimRanges(
    rows: Array<[string,string,string,string,string,string,string,string,string]>,
    climateDays: Array<{ date: string; records: Record<string, string> }>
  ): string {
    const issuedDate = parseIssuedDate();
    const firstStartsWithHigh = Number(rows[0]?.[1] ?? 0) >= Number(rows[0]?.[2] ?? 0);
    const allTemps = rows.flatMap((r) => [Number(r[1]), Number(r[2]), Number(r[3]), Number(r[4])]);
    let scaleMin = Math.min(...allTemps) - 2;
    let scaleMax = Math.max(...allTemps) + 2;

    if (issuedDate) {
      rows.forEach((r) => {
        const city = r[0];
        for (let pair = 0; pair < 2; pair++) {
          const dayOffset = firstStartsWithHigh ? pair : pair + 1;
          const rec = recordFor(climateDays, city, addDays(issuedDate, dayOffset));
          if (rec) scaleMax = Math.max(scaleMax, rec.temperature + 2);
        }
      });
    }

    const span = Math.max(1, scaleMax - scaleMin);
    const widthFor = (value: number) => Math.max(0, Math.min(100, ((value - scaleMin) / span) * 100));
    const wrapperStyle = 'margin:12px 0 18px 0;border-top:1px solid #e5e7eb;';
    let out = `<div style="${wrapperStyle}">`;

    rows.forEach((r, rowIndex) => {
      const [city, t1, t2, t3, t4, p1, p2, p3, p4] = r;
      const temps = [Number(t1), Number(t2), Number(t3), Number(t4)];
      const pops = [Number(p1), Number(p2), Number(p3), Number(p4)];
      const startsWithHigh = temps[0]! >= temps[1]!;
      out += `<div style="padding:12px 0 ${rowIndex === rows.length - 1 ? '4px' : '12px'} 0;${rowIndex > 0 ? 'border-top:1px solid #e5e7eb;' : ''}">`;
      out += `<div style="font-weight:700;color:#0f172a;margin-bottom:7px;">${escapeHtml(city)}</div>`;

      for (let pair = 0; pair < 2; pair++) {
        const a = pair * 2;
        const b = a + 1;
        const high = startsWithHigh ? temps[a]! : temps[b]!;
        const low = startsWithHigh ? temps[b]! : temps[a]!;
        const dayPop = startsWithHigh ? pops[a]! : pops[b]!;
        const nightPop = startsWithHigh ? pops[b]! : pops[a]!;
        const dayOffset = startsWithHigh ? pair : pair + 1;
        const date = issuedDate ? addDays(issuedDate, dayOffset) : null;
        const dateLabel = date ? formatForecastDate(date) : `Forecast day ${pair + 1}`;
        const rec = date ? recordFor(climateDays, city, date) : null;
        const left = widthFor(low);
        const right = widthFor(high);
        const rangeWidth = Math.max(2, right - left);
        const rightWidth = Math.max(0, 100 - left - rangeWidth);

        out += '<div style="margin:0 0 11px 0;">';
        out += '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;">' +
          '<tr>' +
            `<td style="padding:0 8px 4px 0;font-weight:600;white-space:nowrap;">${escapeHtml(dateLabel)}</td>` +
            `<td align="right" style="padding:0 0 4px 8px;white-space:nowrap;font-variant-numeric:tabular-nums;color:#374151;">Low ${low}° &nbsp; High <strong style="color:#111111;">${high}°</strong></td>` +
          '</tr>' +
        '</table>';
        out += '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;height:8px;border-collapse:collapse;table-layout:fixed;">' +
          '<tr>' +
            `<td width="${left.toFixed(1)}%" style="height:8px;background:#e5e7eb;font-size:0;line-height:0;">&nbsp;</td>` +
            `<td width="${rangeWidth.toFixed(1)}%" style="height:8px;background:#475569;font-size:0;line-height:0;">&nbsp;</td>` +
            `<td width="${rightWidth.toFixed(1)}%" style="height:8px;background:#e5e7eb;font-size:0;line-height:0;">&nbsp;</td>` +
          '</tr>' +
        '</table>';
        out += `<div style="margin-top:4px;color:#6b7280;font-size:14px;">Rain: day ${dayPop}% · night ${nightPop}%`;
        if (rec) {
          const delta = rec.temperature - high;
          const comparison = delta === 0 ? 'record tie' : delta > 0 ? `${delta}° below record` : `${Math.abs(delta)}° above record`;
          out += ` &nbsp;·&nbsp; Record ${escapeHtml(rec.text)} · <strong style="color:#374151;">${comparison}</strong>`;
        }
        out += '</div></div>';
      }
      out += '</div>';
    });

    out += '</div>';
    return out;
  }

  let html = "";
  let prevWasSeparator = false;
  let climateDays: Array<{ date: string; records: Record<string, string> }> = [];
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
      html += '<div style="margin:10px 0 6px 0;border-top:1px solid #e5e7eb;"></div>';
      prevWasSeparator = true;
    }
    // If it's a bare '&&' separator, do not render the line text itself
    if (isAmpSeparator(line)) {
      continue;
    }

    // Record-high block inside .CLIMATE: preserve its heading and turn the repeated
    // date/site lines into a compact table without duplicating the source text.
    if (isClimateRecordsHeader(line)) {
      const headerContent = escapeHtml(line);
      html += '<div style="white-space:pre-wrap;word-break:normal;overflow-wrap:normal;color:#0f172a;font-weight:700;">' + headerContent + '</div>';

      const days: Array<{ date: string; records: Record<string, string> }> = [];
      const sites: string[] = [];
      let currentDay: { date: string; records: Record<string, string> } | undefined;
      let j = i + 1;
      for (; j < lines.length; j++) {
        const nxt = lines[j] ?? '';
        const trimmed = nxt.trim();
        if (isSectionHeader(nxt) || isAmpSeparator(nxt)) break;
        if (trimmed === '') continue;

        const date = parseClimateDate(nxt);
        if (date) {
          currentDay = { date, records: {} };
          days.push(currentDay);
          continue;
        }

        const record = parseClimateRecordRow(nxt);
        if (record && currentDay) {
          const [site, value] = record;
          currentDay.records[site] = value;
          if (!sites.includes(site)) sites.push(site);
          continue;
        }

        break;
      }

      if (days.length > 0 && sites.length > 0) {
        climateDays = days;
        html += buildClimateRecordsTable(days, sites);
        i = j - 1;
        prevWasSeparator = false;
        continue;
      }
    }

    // PRELIMINARY POINT TEMPS/POPS block: render as labeled low/high range bars.
    if (isPrelimHeader(line)) {
      const headerContent = (escapeHtml(line).length === 0 ? '&nbsp;' : escapeHtml(line));
      html += '<div style="white-space:pre-wrap;word-break:normal;overflow-wrap:normal;color:#0f172a;font-weight:700;">' + headerContent + '</div>';
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
          break;
        }
      }
      if (rows.length > 0) {
        html += buildPrelimRanges(rows, climateDays);
        i = j - 1;
        prevWasSeparator = false;
        continue;
      }
    }
    // Render each original line as its own block; preserve spaces and allow wrapping
    const content = esc.length === 0 ? "&nbsp;" : esc;
    const baseStyle = 'white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere;';
    const headerExtra = isSectionHeader(line) ? 'color:#0f172a;font-weight:700!important;' : '';
    html += '<div style="' + baseStyle + headerExtra + '">' + content + "</div>";
    prevWasSeparator = false;
  }

  return (
    "<!doctype html>" +
    '<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="x-apple-disable-message-reformatting"><meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"><style>html,body{margin:0!important;padding:0!important;width:100%!important;min-width:100%!important;background:#fafafa!important;color:#111111!important}table{border-collapse:collapse!important}@media (prefers-color-scheme: dark){ html,body{ background:#fafafa!important; color:#111111!important } }</style></head>' +
    '<body bgcolor="#fafafa" style="margin:0;padding:0;padding-inline:8px!important;font-size:16px;line-height:1.5;background:#fafafa!important;color:#111111!important;">' +
      '<div style="width:100vw;min-width:100vw;max-width:100vw;margin-left:calc(50% - 50vw);margin-right:calc(50% - 50vw);background:#fafafa;">' +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#fafafa" style="background:#fafafa;color:#111111!important;margin:0;padding:0;border-collapse:collapse;table-layout:fixed;width:100%!important;min-width:100%!important;max-width:100%!important;">' +
        '<tr><td align="left" bgcolor="#fafafa" style="padding:0;background:#fafafa;">' +
          '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#fafafa" style="border-collapse:collapse;table-layout:fixed;width:100%!important;min-width:100%!important;max-width:100%!important;margin:0;background:#fafafa;">' +
            '<tr><td bgcolor="#fafafa" style="background:#fafafa;">' +
            '<div style="font-family:\'Courier New\',Consolas,Menlo,\'Lucida Console\',monospace;' +
              'font-variant-ligatures:none;tab-size:8;letter-spacing:0;font-size:18px!important;line-height:1.5;text-align:left;color:#111111!important;font-weight:500;">' +
              html +
            '</div>' +
          '</td></tr></table>' +
        '</td></tr>' +
      '</table>' +
      '</div>' +
    '</body></html>'
  );
}
