import { renderHtmlEmail } from "./lib/renderHtmlEmail.ts";

const sample = `FXUS64 KBRO 311135 AAB
AFDBRO
Area Forecast Discussion...UPDATED
National Weather Service Brownsville TX
635 AM CDT Mon Aug 31 2026

.CLIMATE...
Record High Temperatures from August 31st to September 4th:

Monday, August 31, 2026
Brownsville: 103F (2023)
Harlingen: 104F (1958)
McAllen: 104F (2023, 2017)

Tuesday, September 1, 2026
Brownsville: 100F (2023, 2020)
Harlingen: 103F (1928, 1952)
McAllen: 106F (2018)

&&

.PRELIMINARY POINT TEMPS/POPS...
BROWNSVILLE 98 80 98 80 / 0 0 0 0
HARLINGEN 102 76 102 76 / 0 0 0 0
MCALLEN 104 80 104 81 / 0 0 0 0

.BRO WATCHES/WARNINGS/ADVISORIES...
TX...None.`;

const html = renderHtmlEmail(sample);
const climate = html.indexOf("Record highs");
const forecast = html.indexOf("Point forecast");
if (climate < 0 || forecast < 0) throw new Error("structured sections missing");

const between = html.slice(climate, forecast);
const dividers = between.match(/border-top:1px solid #e5e7eb;/g) ?? [];
if (dividers.length !== 1) {
  throw new Error(`expected one divider between climate and forecast, found ${dividers.length}`);
}
if (between.includes(">&nbsp;</div>")) {
  throw new Error("source blank spacer remains between climate and forecast");
}
if (html.includes("border:1px solid #e5e7eb;border-radius:12px")) {
  throw new Error("rounded climate-table border returned");
}
if (!html.includes("border:0;border-collapse:separate!important;border-spacing:0;background:transparent;table-layout:fixed;")) {
  throw new Error("borderless climate-table style missing");
}

console.log("actual NWS divider boundary: PASS");
