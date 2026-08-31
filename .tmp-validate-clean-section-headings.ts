import { renderHtmlEmail } from "./lib/renderHtmlEmail.ts";

const source = `.DISCUSSION...\nDiscussion body\n\n.AVIATION...\nAviation body\n\n.MARINE...\nMarine body\n\n.CLIMATE...\nClimate body\n\n.SHORT TERM /TODAY AND TONIGHT/...\nShort term body\n\n...UPDATE...\nUpdate body`;

const html = renderHtmlEmail(source);

for (const heading of ["DISCUSSION", "AVIATION", "MARINE", "CLIMATE", "SHORT TERM /TODAY AND TONIGHT/"]) {
  if (!html.includes(`>${heading}</div>`)) {
    throw new Error(`clean heading missing: ${heading}`);
  }
}

for (const dotted of [".DISCUSSION...", ".AVIATION...", ".MARINE...", ".CLIMATE...", ".SHORT TERM /TODAY AND TONIGHT/..."]) {
  if (html.includes(dotted)) {
    throw new Error(`dotted heading still rendered: ${dotted}`);
  }
}

if (!html.includes(">...UPDATE...</div>")) {
  throw new Error("ellipsis-prefixed update heading should remain unchanged");
}

const expectedStyle = 'white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere;color:#0f172a;font-weight:700!important;';
if (!html.includes(`<div style="${expectedStyle}">DISCUSSION</div>`)) {
  throw new Error("section heading styling changed");
}

console.log("clean section headings: PASS");
