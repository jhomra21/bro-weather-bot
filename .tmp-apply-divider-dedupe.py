from pathlib import Path

p = Path("lib/renderHtmlEmail.ts")
s = p.read_text()

anchor = '''  function isPrelimHeader(line: string): boolean {
    return /^\s*\.PRELIMINARY POINT TEMPS\/POPS/i.test(line);
  }
'''
helper = anchor + '''
  function nextNonEmptyLineIndex(start: number): number | null {
    for (let index = start + 1; index < lines.length; index++) {
      if ((lines[index] ?? "").trim() !== "") return index;
    }
    return null;
  }
'''
if helper not in s:
    if anchor not in s:
        raise SystemExit("prelim helper anchor not found")
    s = s.replace(anchor, helper, 1)

old = '''    if (i > 0 && ((isSectionHeader(line) && !isPrelimHeader(line)) || isAmpSeparator(line)) && !prevWasSeparator) {
      html += '<div style="margin:10px 0 6px 0;border-top:1px solid #e5e7eb;"></div>';
      prevWasSeparator = true;
    }

    if (isAmpSeparator(line)) {
      continue;
    }
'''
new = '''    const nextNonEmptyIndex = isAmpSeparator(line) ? nextNonEmptyLineIndex(i) : null;
    const isPrelimBoundary = nextNonEmptyIndex !== null && isPrelimHeader(lines[nextNonEmptyIndex] ?? "");

    if (i > 0 && ((isSectionHeader(line) && !isPrelimHeader(line)) || (isAmpSeparator(line) && !isPrelimBoundary)) && !prevWasSeparator) {
      html += '<div style="margin:10px 0 6px 0;border-top:1px solid #e5e7eb;"></div>';
      prevWasSeparator = true;
    }

    if (isAmpSeparator(line)) {
      if (isPrelimBoundary) i = nextNonEmptyIndex! - 1;
      continue;
    }
'''
if new not in s:
    if old not in s:
        raise SystemExit("separator block not found")
    s = s.replace(old, new, 1)

if not s.endswith("\n"):
    s += "\n"
p.write_text(s)
