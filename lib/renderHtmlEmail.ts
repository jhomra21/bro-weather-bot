// Render HTML email to preserve each original line and insert minimal section separators
export function renderHtmlEmail(text: string): string {
  function escapeHtml(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  const normalized = text.replace(/\t/g, "        ");
  const lines = normalized.split("\n");

  function isAmpSeparator(line: string): boolean {
    return /^&{2,}$/.test(line.trim());
  }

  function isSectionHeader(line: string): boolean {
    const t = line.trim();
    return t.startsWith("...") || t.startsWith(".");
  }

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

  function parsePrelimRow(row: string): [string,string,string,string,string,string,string,string,string] | null {
    const m = row.match(/^\s*([A-Z0-9][A-Z0-9 ./'()\-]*?)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\/\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/i);
    if (!m) return null;
    return [
      m[1]!.trim(), m[2]!, m[3]!, m[4]!, m[5]!,
      m[6]!, m[7]!, m[8]!, m[9]!,
    ];
  }

  function parseClimateRecordValue(value: string): { temperature: number; years: string[] } | null {
    const m = value.match(/^(\d{2,3})F(?:\s+\(([^)]+)\))?$/i);
    if (!m) return null;
    const years = (m[2] ?? "").split(",").map((year) => year.trim()).filter(Boolean);
    return { temperature: Number(m[1]), years };
  }

  function formatClimateTableDate(value: string): { weekday: string; date: string } {
    const m = value.match(/^([A-Za-z]+),\s+([A-Za-z]+)\s+(\d{1,2}),\s+\d{4}$/);
    if (!m) return { weekday: "", date: value };
    return {
      weekday: m[1]!.slice(0, 3),
      date: `${m[2]!.slice(0, 3)} ${m[3]!}`,
    };
  }

  function titleCasePlace(value: string): string {
    return value.toLowerCase().replace(/(^|[\s/\-])([a-z])/g, (_, before: string, letter: string) => {
      return before + letter.toUpperCase();
    });
  }

  function buildClimateRecordsTable(
    days: Array<{ date: string; records: Record<string, string> }>,
    sites: string[]
  ): string {
    const uiFont = "font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text','Helvetica Neue',Arial,sans-serif;";
    const dateWidth = `${Math.max(10, Math.floor(70 / Math.max(1, days.length)))}%`;
    let out = `<div style="${uiFont}margin:16px 0 22px 0;color:#111827;">`;

    out += '<div style="font-size:19px;line-height:1.25;font-weight:700;letter-spacing:-0.01em;margin-bottom:3px;">Record highs</div>';
    out += '<div style="font-size:13px;line-height:1.35;color:#6b7280;margin-bottom:10px;">Daily record high temperatures · °F</div>';
    out += '<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;max-width:100%;border:1px solid #e5e7eb;border-radius:12px;border-collapse:separate!important;border-spacing:0;background:#ffffff;table-layout:fixed;overflow:hidden;">';
    out += '<thead><tr>';
    out += '<th style="width:30%;padding:9px 8px;text-align:left;border-bottom:1px solid #e5e7eb;color:#6b7280;font-size:12px;font-weight:600;">City</th>';
    out += days.map((day) => {
      const label = formatClimateTableDate(day.date);
      return `<th style="width:${dateWidth};padding:8px 2px;text-align:center;border-bottom:1px solid #e5e7eb;color:#6b7280;font-weight:500;line-height:1.15;white-space:nowrap;"><span style="display:block;font-size:11px;">${escapeHtml(label.weekday)}</span><span style="display:block;margin-top:2px;font-size:12px;color:#374151;font-weight:600;">${escapeHtml(label.date)}</span></th>`;
    }).join("");
    out += '</tr></thead>';

    sites.forEach((site, idx) => {
      const border = idx === 0 ? "" : "border-top:1px solid #f0f1f3;";
      out += '<tr>';
      out += `<td style="padding:10px 8px;text-align:left;${border}font-size:13px;font-weight:600;line-height:1.2;">${escapeHtml(titleCasePlace(site))}</td>`;
      out += days.map((day) => {
        const parsed = parseClimateRecordValue(day.records[site] ?? "");
        const value = parsed ? `${parsed.temperature}°` : "—";
        return `<td style="padding:10px 2px;text-align:center;${border}font-size:15px;font-weight:650;font-variant-numeric:tabular-nums;white-space:nowrap;">${escapeHtml(value)}</td>`;
      }).join("");
      out += '</tr>';
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
    const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return `${weekdays[date.getUTCDay()]}, ${months[date.getUTCMonth()]} ${date.getUTCDate()}`;
  }

  function formatClimateLookupDate(date: Date): string {
    const weekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    return `${weekdays[date.getUTCDay()]}, ${months[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()}`;
  }

  function recordFor(
    days: Array<{ date: string; records: Record<string, string> }>,
    city: string,
    date: Date
  ): { temperature: number; years: string[] } | null {
    const targetDate = formatClimateLookupDate(date).toLowerCase();
    const day = days.find((item) => item.date.toLowerCase() === targetDate);
    if (!day) return null;
    const entry = Object.entries(day.records).find(([site]) => site.toLowerCase() === city.toLowerCase());
    if (!entry) return null;
    return parseClimateRecordValue(entry[1]);
  }

  function formatYears(years: string[]): string {
    if (years.length === 0) return "";
    if (years.length === 1) return years[0]!;
    if (years.length === 2) return `${years[0]} and ${years[1]}`;
    return `${years.slice(0, -1).join(", ")}, and ${years[years.length - 1]}`;
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
    const uiFont = "font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text','Helvetica Neue',Arial,sans-serif;";
    let out = `<div style="${uiFont}margin:16px 0 20px 0;color:#111827;">`;

    out += '<div style="font-size:19px;line-height:1.25;font-weight:700;letter-spacing:-0.01em;margin-bottom:3px;">Point forecast</div>';
    out += '<div style="font-size:13px;line-height:1.35;color:#6b7280;margin-bottom:14px;">Daily low–high range and precipitation chance</div>';

    rows.forEach((r, rowIndex) => {
      const [city, t1, t2, t3, t4, p1, p2, p3, p4] = r;
      const temps = [Number(t1), Number(t2), Number(t3), Number(t4)];
      const pops = [Number(p1), Number(p2), Number(p3), Number(p4)];
      const startsWithHigh = temps[0]! >= temps[1]!;

      out += `<div style="padding:${rowIndex === 0 ? "0" : "18px"} 0 4px 0;${rowIndex > 0 ? "border-top:1px solid #e5e7eb;" : ""}">`;
      out += `<div style="font-size:16px;line-height:1.3;font-weight:700;letter-spacing:-0.005em;margin-bottom:12px;">${escapeHtml(titleCasePlace(city))}</div>`;

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
        const rainText = dayPop === nightPop
          ? `Rain ${dayPop}%`
          : `Rain · day ${dayPop}% · night ${nightPop}%`;

        out += `<div style="margin:0 0 ${pair === 0 ? "18px" : "8px"} 0;">`;
        out += '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse!important;">';
        out += '<tr>';
        out += `<td style="padding:0 8px 7px 0;font-size:15px;line-height:1.25;font-weight:650;white-space:nowrap;color:#111827!important;text-decoration:none!important;"><span x-apple-data-detectors="false" style="color:#111827!important;text-decoration:none!important;">${escapeHtml(dateLabel)}</span></td>`;
        out += `<td align="right" style="padding:0 0 7px 8px;font-size:14px;line-height:1.25;white-space:nowrap;font-variant-numeric:tabular-nums;color:#6b7280;">Low <span style="color:#374151;font-weight:600;">${low}°</span>&nbsp;&nbsp; High <strong style="color:#111827;font-weight:700;">${high}°</strong></td>`;
        out += '</tr></table>';

        out += '<div style="width:100%;height:7px;background:#e5e7eb;border-radius:999px;overflow:hidden;line-height:0;font-size:0;">';
        out += `<div style="height:7px;margin-left:${left.toFixed(1)}%;width:${rangeWidth.toFixed(1)}%;background:#64748b;border-radius:999px;line-height:0;font-size:0;">&nbsp;</div>`;
        out += '</div>';

        out += `<div style="margin-top:7px;font-size:13px;line-height:1.35;color:#6b7280;">${escapeHtml(rainText)}</div>`;

        if (rec) {
          const delta = rec.temperature - high;
          const comparison = delta === 0
            ? "Ties the record high"
            : delta > 0
              ? `${delta}° below the record high`
              : `${Math.abs(delta)}° above the record high`;

          out += `<div style="margin-top:4px;font-size:13px;line-height:1.35;color:#374151;font-weight:650;white-space:nowrap;">${escapeHtml(comparison)}</div>`;

          if (delta <= 0 && rec.years.length > 0) {
            const years = formatYears(rec.years);
            const context = delta === 0
              ? `Previously reached in ${years}`
              : `Previous record reached in ${years}`;
            out += `<div style="margin-top:1px;font-size:12px;line-height:1.35;color:#8a8f98;">${escapeHtml(context)}</div>`;
          }
        }

        out += '</div>';
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
    const esc0 = escapeHtml(line);
    const esc = esc0.replace(/ {2,}/g, (m) => {
      const pairs = Math.floor(m.length / 2);
      const rem = m.length % 2;
      return "&nbsp; ".repeat(pairs) + (rem ? "&nbsp;" : "");
    });

    if (i > 0 && (isSectionHeader(line) || isAmpSeparator(line)) && !prevWasSeparator) {
      html += '<div style="margin:10px 0 6px 0;border-top:1px solid #e5e7eb;"></div>';
      prevWasSeparator = true;
    }

    if (isAmpSeparator(line)) {
      continue;
    }

    if (isClimateRecordsHeader(line)) {
      const days: Array<{ date: string; records: Record<string, string> }> = [];
      const sites: string[] = [];
      let currentDay: { date: string; records: Record<string, string> } | undefined;
      let j = i + 1;

      for (; j < lines.length; j++) {
        const nxt = lines[j] ?? "";
        const trimmed = nxt.trim();
        if (isSectionHeader(nxt) || isAmpSeparator(nxt)) break;
        if (trimmed === "") continue;

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

    if (isPrelimHeader(line)) {
      const rows: Array<[string,string,string,string,string,string,string,string,string]> = [];
      let j = i + 1;

      for (; j < lines.length; j++) {
        const nxt = lines[j] ?? "";
        const t = nxt.trim();
        if (t === "" || isSectionHeader(nxt) || isAmpSeparator(nxt)) break;

        const parsed = parsePrelimRow(nxt);
        if (!parsed) break;
        rows.push(parsed);
      }

      if (rows.length > 0) {
        html += buildPrelimRanges(rows, climateDays);
        i = j - 1;
        prevWasSeparator = false;
        continue;
      }
    }

    const content = esc.length === 0 ? "&nbsp;" : esc;
    const baseStyle = "white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere;";
    const headerExtra = isSectionHeader(line) ? "color:#0f172a;font-weight:700!important;" : "";
    html += `<div style="${baseStyle}${headerExtra}">${content}</div>`;
    prevWasSeparator = false;
  }

  return (
    "<!doctype html>" +
    '<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="x-apple-disable-message-reformatting"><meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"><style>html,body{margin:0!important;padding:0!important;width:100%!important;min-width:100%!important;background:#fafafa!important;color:#111111!important}table{border-collapse:collapse!important}a[x-apple-data-detectors]{color:inherit!important;text-decoration:none!important;font:inherit!important}#MessageViewBody a{color:inherit!important;text-decoration:none!important}@media (prefers-color-scheme: dark){html,body{background:#fafafa!important;color:#111111!important}}</style></head>' +
    '<body bgcolor="#fafafa" style="margin:0;padding:0;padding-inline:8px!important;font-size:16px;line-height:1.5;background:#fafafa!important;color:#111111!important;">' +
      '<div style="width:100vw;min-width:100vw;max-width:100vw;margin-left:calc(50% - 50vw);margin-right:calc(50% - 50vw);background:#fafafa;">' +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#fafafa" style="background:#fafafa;color:#111111!important;margin:0;padding:0;border-collapse:collapse;table-layout:fixed;width:100%!important;min-width:100%!important;max-width:100%!important;">' +
        '<tr><td align="left" bgcolor="#fafafa" style="padding:0;background:#fafafa;">' +
          '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#fafafa" style="border-collapse:collapse;table-layout:fixed;width:100%!important;min-width:100%!important;max-width:100%!important;margin:0;background:#fafafa;">' +
            '<tr><td bgcolor="#fafafa" style="background:#fafafa;">' +
            '<div style="font-family:\'Courier New\',Consolas,Menlo,\'Lucida Console\',monospace;font-variant-ligatures:none;tab-size:8;letter-spacing:0;font-size:18px!important;line-height:1.5;text-align:left;color:#111111!important;font-weight:500;">' +
              html +
            '</div>' +
          '</td></tr></table>' +
        '</td></tr>' +
      '</table>' +
      '</div>' +
    '</body></html>'
  );
}
