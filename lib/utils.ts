export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(digest);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Remove SOH and other control chars, normalize newlines, and tidy whitespace
export function sanitizeAfosText(raw: string): string {
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
