from pathlib import Path

p = Path("lib/renderHtmlEmail.ts")
s = p.read_text()

anchor = '''  function isPrelimHeader(line: string): boolean {
    return /^\\s*\\.PRELIMINARY POINT TEMPS\\/POPS/i.test(line);
  }
'''
helper = anchor + '''
  function formatSectionHeaderForDisplay(line: string): string {
    const match = line.match(/^(\\s*)\\.([^.].*?)\\.\\.\\.(\\s*)$/);
    if (!match) return line;
    return `${match[1]}${match[2]!.toUpperCase()}${match[3]}`;
  }
'''
if helper not in s:
    if anchor not in s:
        raise SystemExit("section helper anchor not found")
    s = s.replace(anchor, helper, 1)

old = '''    const line = lines[i] ?? "";
    const esc0 = escapeHtml(line);
'''
new = '''    const line = lines[i] ?? "";
    const esc0 = escapeHtml(formatSectionHeaderForDisplay(line));
'''
if new not in s:
    if old not in s:
        raise SystemExit("display escape anchor not found")
    s = s.replace(old, new, 1)

if not s.endswith("\n"):
    s += "\n"
p.write_text(s)
