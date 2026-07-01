import puppeteer from "puppeteer";

const URL = process.env.PROBE_URL || "http://localhost:5187/";
const b = await puppeteer.launch({
  headless: "new",
  args: ["--no-sandbox", "--use-gl=swiftshader", "--enable-unsafe-swiftshader"],
});
const p = await b.newPage();
await p.setViewport({ width: 1600, height: 300, deviceScaleFactor: 2 });

const logs = [];
p.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
p.on("pageerror", (e) => logs.push(`[PAGEERROR] ${e.message}`));

await p.goto(URL, { waitUntil: "networkidle0", timeout: 25000 }).catch((e) =>
  logs.push(`[GOTO] ${e.message}`),
);
await new Promise((r) => setTimeout(r, 900));

// Ganze Oberleiste (unabhängig vom horizontalen Scroll) breit einfangen.
const info = await p.evaluate(() => {
  const tb = document.querySelector(".topbar");
  const stat = document.querySelector(".tb-stat");
  const segs = document.querySelectorAll(".tb-seg").length;
  const textGroup = !!document.querySelector(".tb-textgroup");
  const looseZoom = document.querySelectorAll(".tb-zoom").length; // sollte 0 sein
  const addText = !!document.querySelector(".tb-addtext");
  const iconBtns = document.querySelectorAll(".tb-iconbtn").length;
  return {
    barH: tb ? Math.round(tb.getBoundingClientRect().height) : null,
    scrollW: tb ? tb.scrollWidth : null,
    statPresent: !!stat,
    segmentCount: segs,
    textGroup,
    looseZoomSpans: looseZoom,
    addText,
    iconBtns,
  };
});
console.log("INFO", JSON.stringify(info));

// Oberleiste voll ins Bild scrollen und mehrere Ausschnitte schiessen.
const tb = await p.$(".topbar");
const box = await tb.boundingBox();
await p.screenshot({
  path: "scripts/probe-topbar-dossier-1-left.png",
  clip: { x: 0, y: 0, width: 1600, height: Math.ceil(box.height) + 6 },
});
// Nach rechts scrollen, um Zoom-Cluster + Text-Gruppe zu zeigen.
await p.evaluate(() => {
  const el = document.querySelector(".topbar");
  if (el) el.scrollLeft = Math.max(0, el.scrollWidth - el.clientWidth);
});
await new Promise((r) => setTimeout(r, 400));
await p.screenshot({
  path: "scripts/probe-topbar-dossier-2-right.png",
  clip: { x: 0, y: 0, width: 1600, height: Math.ceil(box.height) + 6 },
});

console.log("\n=== Konsole ===");
console.log(logs.length ? logs.join("\n") : "(keine)");
const errors = logs.filter(
  (l) => l.startsWith("[error]") || l.startsWith("[PAGEERROR]"),
);
console.log(errors.length ? `\nFEHLER: ${errors.length}` : "\nKeine Konsolenfehler.");
await b.close();
process.exit(errors.length ? 1 : 0);
