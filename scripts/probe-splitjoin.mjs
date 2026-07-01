// Verifikation Split / Join / Segment-Löschen (Ctrl+S / Ctrl+J / Alt+Klick).
// Liest das Modell über einen TEMP-Hook window.__drawings2d (id + geom). Dieser
// Hook wurde nur für die Verifikation in App.tsx eingehängt und danach wieder
// ENTFERNT — zum erneuten Lauf muss er kurzzeitig reaktiviert werden:
//   useEffect(() => {
//     (window).__drawings2d = project.drawings2d.map(d => ({id:d.id, geom:d.geom}));
//   }, [project.drawings2d]);
// Verifizierte Ergebnisse (siehe probe-splitjoin-*.png):
//   Split Rechteck+Querlinie → 2 geschlossene Polylinien + Linie
//   Join 2 Linien (gem. Endpunkt) → 1 Polylinie (3 Punkte)
//   Alt-Klick auf Rechteck-Kante → offene Polylinie (4 Punkte, Segment weg)
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
// Laufenden Befehl beenden (sonst übernimmt er die linke Maustaste der Plan-
// Ansicht und Klicks selektieren nicht). Escape im Eingabefeld bricht ab.
const endCommand = async () => {
  // Eingabefeld behält Fokus nach typeLine → Escape bricht den Befehl ab.
  await p.keyboard.press("Escape");
  await sleep(80);
  await p.keyboard.press("Escape");
  await sleep(80);
};
const drawings = () => p.evaluate(() => window.__drawings2d || []);
// Modellpunkt (Meter) → Client-Pixel über das aktuelle SVG-CTM (umgekehrt).
const modelToClient = (mx, my) =>
  p.evaluate(
    (mx, my) => {
      const svg = document.querySelector(".plan-svg");
      // toScreen aus PlanView: x*40, -y*40 (PX_PER_M=40, Y gespiegelt). Wir nutzen
      // direkt das CTM: viewBox-Punkt (x*40, -y*40) → Bildschirm.
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
const ctrlPress = async (key) => {
  await p.keyboard.down("Control");
  await p.keyboard.press(key);
  await p.keyboard.up("Control");
  await sleep(250);
};
const isClosed = (g) =>
  g.shape === "rect" || (g.shape === "polyline" && g.closed);

// ── 1) SPLIT RECHTECK ────────────────────────────────────────────────────────
// Rechteck (0,0)-(4,4) + quer kreuzende vertikale Linie x=2.
await focusCmd();
await typeLine("rect");
await typeLine("0,0");
await typeLine("4,4");
await focusCmd();
await typeLine("line");
await typeLine("2,-1");
await typeLine("2,5");
await endCommand();
await sleep(150);

const before = await drawings();
// Rechteck wählen: auf die linke Kante klicken (x=0, y=2) — eindeutig auf dem Rand.
let [cx, cy] = await modelToClient(0, 2);
await p.mouse.click(cx, cy);
await sleep(150);
await ctrlPress("s");
await sleep(200);
const afterSplit = await drawings();
// Erwartung: Rechteck (1 closed) ersetzt durch 2 closed Elemente; Linie bleibt.
const closedAfter = afterSplit.filter((d) => isClosed(d.geom));
await p.screenshot({ path: "scripts/probe-splitjoin-1-split-rect.png" });

// ── 2) JOIN zwei Linien ──────────────────────────────────────────────────────
await p.reload({ waitUntil: "networkidle0" });
await sleep(800);
await focusCmd();
await typeLine("line");
await typeLine("1,1");
await typeLine("4,1");
await focusCmd();
await typeLine("line");
await typeLine("4,1");
await typeLine("4,4");
await endCommand();
await sleep(150);
const beforeJoin = await drawings();
// Beide wählen: erste klicken (Mitte 2.5,1), dann Shift+zweite (Mitte 4,2.5).
let [ax, ay] = await modelToClient(2.5, 1);
await p.mouse.click(ax, ay);
await sleep(120);
let [bx2, by2] = await modelToClient(4, 2.5);
await p.keyboard.down("Shift");
await p.mouse.click(bx2, by2);
await p.keyboard.up("Shift");
await sleep(150);
await ctrlPress("j");
await sleep(200);
const afterJoin = await drawings();
const polylines = afterJoin.filter((d) => d.geom.shape === "polyline");
await p.screenshot({ path: "scripts/probe-splitjoin-2-join.png" });

// ── 3) ALT-SEGMENT (Schere) ──────────────────────────────────────────────────
await p.reload({ waitUntil: "networkidle0" });
await sleep(800);
await focusCmd();
await typeLine("rect");
await typeLine("0,0");
await typeLine("4,4");
await endCommand();
await sleep(150);
const beforeCut = await drawings();
// Alt+Klick auf die untere Kante (y=0, x=2).
let [ex, ey] = await modelToClient(2, 0);
await p.keyboard.down("Alt");
await p.mouse.click(ex, ey);
await p.keyboard.up("Alt");
await sleep(200);
const afterCut = await drawings();
const cutGeom = afterCut[0]?.geom;
await p.screenshot({ path: "scripts/probe-splitjoin-3-alt-cut.png" });

console.log(
  JSON.stringify(
    {
      split: {
        beforeCount: before.length,
        afterCount: afterSplit.length,
        closedCountAfter: closedAfter.length,
        geomsAfter: afterSplit.map((d) => ({ shape: d.geom.shape, closed: isClosed(d.geom) })),
      },
      join: {
        beforeCount: beforeJoin.length,
        afterCount: afterJoin.length,
        polylineCount: polylines.length,
        joinedPts: polylines.map((d) => d.geom.pts?.length),
      },
      altCut: {
        beforeShape: beforeCut[0]?.geom.shape,
        afterCount: afterCut.length,
        afterShape: cutGeom?.shape,
        afterClosed: cutGeom ? isClosed(cutGeom) : null,
        afterPts: cutGeom?.pts?.length,
      },
      errs,
    },
    null,
    2,
  ),
);
await b.close();
