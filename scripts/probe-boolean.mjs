// Verifikation 2D-Boolean (Union / Difference / Intersection) über das
// Kontextmenü bzw. die Tastatur. Liest das Modell über den TEMP-Hook
// window.__drawings2d (id + geom), der für die Verifikation kurzzeitig in
// App.tsx eingehängt ist (siehe probe-splitjoin.mjs). Danach ENTFERNEN.
//
// Ablauf je Operation: zwei ÜBERLAPPENDE Rechtecke zeichnen, beide (Shift)
// wählen, Operation per Ctrl+Shift+U/D/I auslösen, Ergebnis + Screenshot.
import puppeteer from "puppeteer";

const b = await puppeteer.launch({
  headless: "new",
  args: ["--no-sandbox", "--use-gl=swiftshader", "--enable-unsafe-swiftshader"],
});
const p = await b.newPage();
await p.setViewport({ width: 1280, height: 820, deviceScaleFactor: 1 });
const errs = [];
p.on("pageerror", (e) => errs.push(e.message));
await p.goto("http://localhost:5187/", { waitUntil: "networkidle0", timeout: 20000 }).catch(() => {});
await new Promise((r) => setTimeout(r, 800));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const focusCmd = async () => {
  const el = await p.$(".cmdline-input");
  const bx = await el.boundingBox();
  await p.mouse.click(bx.x + bx.width / 2, bx.y + bx.height / 2);
  await sleep(60);
};
const typeLine = async (t) => {
  await p.type(".cmdline-input", t, { delay: 5 });
  await p.keyboard.press("Enter");
  await sleep(80);
};
const endCommand = async () => {
  await p.keyboard.press("Escape");
  await sleep(80);
  await p.keyboard.press("Escape");
  await sleep(80);
};
const drawings = () => p.evaluate(() => window.__drawings2d || []);
const modelToClient = (mx, my) =>
  p.evaluate(
    (mx, my) => {
      const svg = document.querySelector(".plan-svg");
      const ctm = svg.getScreenCTM();
      const q = svg.createSVGPoint();
      q.x = mx * 90;
      q.y = -my * 90;
      const s = q.matrixTransform(ctm);
      return [s.x, s.y];
    },
    mx,
    my,
  );
const ctrlShift = async (key) => {
  await p.keyboard.down("Control");
  await p.keyboard.down("Shift");
  await p.keyboard.press(key);
  await p.keyboard.up("Shift");
  await p.keyboard.up("Control");
  await sleep(300);
};
const isClosed = (g) =>
  g.shape === "rect" || (g.shape === "polyline" && g.closed);

// Zwei überlappende Rechtecke zeichnen: A (0,0)-(4,4), B (2,2)-(6,6).
// Auswahl-Reihenfolge: A zuerst (= Basis für Differenz).
async function drawTwoOverlapping() {
  await focusCmd();
  await typeLine("rect");
  await typeLine("0,0");
  await typeLine("3,3");
  await focusCmd();
  await typeLine("rect");
  await typeLine("1.5,1.5");
  await typeLine("4.5,4.5");
  await endCommand();
  await sleep(150);
  // A wählen: linke Kante (x=0,y=1.5). Dann Shift+B: rechte Kante (x=4.5,y=3).
  let [ax, ay] = await modelToClient(0, 1.5);
  await p.mouse.click(ax, ay);
  await sleep(120);
  let [bx, by] = await modelToClient(4.5, 3);
  await p.keyboard.down("Shift");
  await p.mouse.click(bx, by);
  await p.keyboard.up("Shift");
  await sleep(150);
}

// ── 1) UNION ──────────────────────────────────────────────────────────────────
await drawTwoOverlapping();
const beforeU = await drawings();
await ctrlShift("u");
await sleep(200);
const afterU = await drawings();
await p.screenshot({ path: "scripts/probe-boolean-1-union.png" });

// ── 2) DIFFERENCE (A − B) ─────────────────────────────────────────────────────
await p.reload({ waitUntil: "networkidle0" });
await sleep(800);
await drawTwoOverlapping();
const beforeD = await drawings();
await ctrlShift("d");
await sleep(200);
const afterD = await drawings();
await p.screenshot({ path: "scripts/probe-boolean-2-difference.png" });

// ── 3) INTERSECTION ───────────────────────────────────────────────────────────
await p.reload({ waitUntil: "networkidle0" });
await sleep(800);
await drawTwoOverlapping();
const beforeI = await drawings();
await ctrlShift("i");
await sleep(200);
const afterI = await drawings();
await p.screenshot({ path: "scripts/probe-boolean-3-intersection.png" });

// Punktanzahl + Bounding-Box des Ergebnis-Außenrings (zur Plausibilität).
const summarize = (arr) =>
  arr
    .filter((d) => isClosed(d.geom))
    .map((d) => {
      const pts =
        d.geom.shape === "polyline"
          ? d.geom.pts
          : [
              d.geom.min,
              { x: d.geom.max.x, y: d.geom.min.y },
              d.geom.max,
              { x: d.geom.min.x, y: d.geom.max.y },
            ];
      let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
      for (const q of pts) {
        minX = Math.min(minX, q.x); minY = Math.min(minY, q.y);
        maxX = Math.max(maxX, q.x); maxY = Math.max(maxY, q.y);
      }
      return { shape: d.geom.shape, n: pts.length, bbox: [minX, minY, maxX, maxY] };
    });

console.log(
  JSON.stringify(
    {
      union: { before: beforeU.length, after: afterU.length, result: summarize(afterU) },
      difference: { before: beforeD.length, after: afterD.length, result: summarize(afterD) },
      intersection: { before: beforeI.length, after: afterI.length, result: summarize(afterI) },
      errs,
    },
    null,
    2,
  ),
);
await b.close();
