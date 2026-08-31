from pathlib import Path

p = Path("lib/renderHtmlEmail.ts")
s = p.read_text()

anchor = "  function isPrelimHeader(line: string): boolean {\n    return /^\\s*\\.PRELIMINARY POINT TEMPS\\/POPS/i.test(line);\n  }\n"
helper = anchor + "\n  function nextNonEmptyLineIndex(start: number): number | null {\n    for (let index = start + 1; index < lines.length; index++) {\n      if ((lines[index] ?? \\\"\\\").trim() !== \\\"\\\") return index;\n    }\n    return null;\n  }\n"
if helper not in s:
    if anchor not in s:
        raise SystemExit("prelim helper anchor not found")
    s = s.replace(anchor, helper, 1)

old = "    if (i > 0 && ((isSectionHeader(line) && !isPrelimHeader(line)) || isAmpSeparator(line)) && !prevWasSeparator) {\n      html += '<div style=\\\"margin:10px 0 6px 0;border-top:1px solid #e5e7eb;\\\"></div>';\n      prevWasSeparator = true;\n    }\n\n    if (isAmpSeparator(line)) {\n      continue;\n    }\n"
new = "    const nextNonEmptyIndex = isAmpSeparator(line) ? nextNonEmptyLineIndex(i) : null;\n    const isPrelimBoundary = nextNonEmptyIndex !== null && isPrelimHeader(lines[nextNonEmptyIndex] ?? \\\"\\\");\n\n    if (i > 0 && ((isSectionHeader(line) && !isPrelimHeader(line)) || (isAmpSeparator(line) && !isPrelimBoundary)) && !prevWasSeparator) {\n      html += '<div style=\\\"margin:10px 0 6px 0;border-top:1px solid #e5e7eb;\\\"></div>';\n      prevWasSeparator = true;\n    }\n\n    if (isAmpSeparator(line)) {\n      if (isPrelimBoundary) i = nextNonEmptyIndex! - 1;\n      continue;\n    }\n"
if new not in s:
    if old not in s:
        raise SystemExit("separator block not found")
    s = s.replace(old, new, 1)

if not s.endswith("\n"):
    s += "\n"
p.write_text(s)
