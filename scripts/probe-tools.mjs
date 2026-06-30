import puppeteer from "puppeteer";

const URL = process.env.PROBE_URL || "http://localhost:5173/";
const browser = await puppeteer.launch({
  headless: "new",
  args: ["--no-sandbox", "--use-gl=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1200, height: 800, deviceScaleFactor: 2 });
const logs = [];
page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => logs.push(`[PAGEERROR] ${e.message}`));

try {
  await page.goto(URL, { waitUntil: "networkidle0", timeout: 20000 });
} catch (e) {
  logs.push(`[GOTO-ERROR] ${e.message}`);
}
await new Promise((r) => setTimeout(r, 600));

// 1) Wand-Werkzeug aktivieren (Button per Text finden).
const clickedWall = await page.evaluate(() => {
  const btns = [...document.querySelectorAll("button")];
  const b = btns.find((x) => x.textContent.trim() === "Wand");
  if (b) { b.click(); return true; }
  return false;
});

await new Promise((r) => setTimeout(r, 200));

// 2) SVG-Box ermitteln und eine L-Polylinie zeichnen (3 Punkte + Rechtsklick).
const box = await page.evaluate(() => {
  const svg = document.querySelector(".plan-svg");
  const r = svg.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
});
const cx = box.x + box.w / 2;
const cy = box.y + box.h / 2;
const pts = [
  [cx - 160, cy - 120],
  [cx - 160, cy + 60],
  [cx + 80, cy + 60],
];
for (const [x, y] of pts) {
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.up();
  await new Promise((r) => setTimeout(r, 80));
}
// Hover, damit das letzte lebende Segment + Snap-Marker zu sehen sind.
await page.mouse.move(cx + 80, cy - 60);
await new Promise((r) => setTimeout(r, 120));
await page.screenshot({ path: "scripts/probe-tools-drawing.png" });

// Rechtsklick = Polylinie abschließen (commit).
await page.mouse.click(cx + 80, cy - 60, { button: "right" });
await new Promise((r) => setTimeout(r, 200));

// 3) Zurück auf Auswahl und Ergebnis screenshoten.
await page.evaluate(() => {
  const b = [...document.querySelectorAll("button")].find(
    (x) => x.textContent.trim() === "Auswahl",
  );
  if (b) b.click();
});
await new Promise((r) => setTimeout(r, 200));

// Wand-/Drawing-Zählung aus dem DOM (Polygone mit Wandbezug sind schwer zu
// zählen; stattdessen Anzahl Pfade/Polygone als grober Indikator).
const counts = await page.evaluate(() => ({
  polygons: document.querySelectorAll(".plan-svg polygon").length,
  lines: document.querySelectorAll(".plan-svg line").length,
}));

await page.screenshot({ path: "scripts/probe-tools.png" });
console.log("clickedWall:", clickedWall);
console.log("counts:", JSON.stringify(counts));
console.log("=== Logs ===");
console.log(logs.length ? logs.join("\n") : "(keine)");
await browser.close();
