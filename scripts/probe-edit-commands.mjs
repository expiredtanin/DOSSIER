// Probe für die Tier-1-Editierbefehle: Move / Copy / Offset.
//
// Treibt das Rhino-artige Befehlssystem headless und prüft die EXAKTE Geometrie
// aus dem gerenderten SVG (Drawing2D → `line.draw2d`, Screen→Modell via
// model = {x: x/90, y: -y/90}; PX_PER_M=90, Y-flip). Schritte:
//   1) line „0,0"→„r4,0"   → eine waagerechte 4-m-Linie bei y=0
//   2) Linie anklicken (selektieren) → move „0,0"→„0,2"  → Linie liegt bei y=2
//   3) copy „0,0"→„r2,0"  → zwei Linien (Original + Kopie 2 m rechts)
//   4) eine Polylinie zeichnen + selektieren → offset Distanz 0.5 + Seite
//      → zweite, parallel um 0.5 versetzte Kurve
//
// Vorlage: scripts/probe-command-line.mjs / probe-draw-commands.mjs.

import puppeteer from "puppeteer";

const URL = process.env.PROBE_URL || "http://localhost:5173/";
const browser = await puppeteer.launch({
  headless: "new",
  args: ["--no-sandbox", "--use-gl=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 820, deviceScaleFactor: 1 });
const logs = [];
page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => logs.push(`[PAGEERROR] ${e.message}`));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  await page.goto(URL, { waitUntil: "networkidle0", timeout: 20000 });
} catch (e) {
  logs.push(`[GOTO-ERROR] ${e.message}`);
}
await sleep(600);

const PX = 90; // PX_PER_M

// Liest alle Drawing2D-Liniensegmente als Modell-Koordinaten (Screen→Modell).
async function segs() {
  return page.evaluate((PX) => {
    const out = [];
    for (const ln of document.querySelectorAll(".plan-svg line.draw2d")) {
      // Bildschirm-CTM: SVG-User → Screen. Wir wollen Modell, daher rechnen wir
      // über die Element-Endpunkte im SVG-User-Raum (x1/y1/x2/y2) zurück.
      const x1 = parseFloat(ln.getAttribute("x1"));
      const y1 = parseFloat(ln.getAttribute("y1"));
      const x2 = parseFloat(ln.getAttribute("x2"));
      const y2 = parseFloat(ln.getAttribute("y2"));
      out.push({
        a: { x: x1 / PX, y: -y1 / PX },
        b: { x: x2 / PX, y: -y2 / PX },
      });
    }
    return out;
  }, PX);
}

// Klick-Zentrum eines .draw2d-Segments in Client-Pixeln (über BoundingClientRect),
// damit die Auswahl pan/zoom-unabhängig trifft. `idx` = welches Segment.
async function clickSegment(idx) {
  const box = await page.evaluate((idx) => {
    const lines = document.querySelectorAll(".plan-svg line.draw2d");
    const ln = lines[idx];
    if (!ln) return null;
    const r = ln.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, idx);
  if (!box) {
    logs.push(`[WARN] Segment ${idx} nicht gefunden (übersprungen)`);
    return false;
  }
  await page.mouse.click(box.x, box.y);
  await sleep(120);
  return true;
}

// Fokussiert die Command-Line DIREKT (ohne Plan-Klick — ein Plan-Klick würde die
// Auswahl löschen, die Move/Copy/Offset gerade brauchen). Das Input ist immer im
// DOM; ein Fokus genügt, danach landet getippter Text in der Engine.
const focusCmd = async () => {
  await page.focus(".cmdline-input");
  await sleep(60);
};
const typeLine = async (t) => {
  await page.type(".cmdline-input", t, { delay: 8 });
  await page.keyboard.press("Enter");
  await sleep(110);
};
const prompt = () =>
  page.evaluate(() => document.querySelector(".cmdline-prompt")?.textContent || "");

// Hilfsfunktion: nahe Gleichheit.
const near = (a, b, eps = 0.02) => Math.abs(a - b) <= eps;

// ── 1) Linie zeichnen: 0,0 → r4,0 (waagerecht, y=0) ─────────────────────────
await focusCmd();
await typeLine("line");
await typeLine("0,0");
await typeLine("r4,0");
await sleep(150);
const afterLine = await segs();

// ── 2) Linie selektieren + Move 0,0 → 0,2 ───────────────────────────────────
await clickSegment(0); // die eine Linie wählen
const gripsAfterClick = await page.evaluate(
  () => document.querySelectorAll(".plan-svg .plan-grip").length,
);
await focusCmd();
const gripsAfterFocus = await page.evaluate(
  () => document.querySelectorAll(".plan-svg .plan-grip").length,
);
const moveSelInfo = gripsAfterClick;
logs.push(`[DBG] grips afterClick=${gripsAfterClick} afterFocus=${gripsAfterFocus}`);
await typeLine("move");
const movePrompt = await prompt();
await typeLine("0,0");
const moveTargetPrompt = await prompt();
await typeLine("0,2");
await sleep(150);
const afterMove = await segs();
await page.screenshot({ path: "scripts/probe-edit-move.png" });

// ── 3) Copy: 0,0 → r2,0 (Auswahl bleibt nach Move bestehen) ─────────────────
// Move hält die Auswahl (selectedDrawingId unverändert). Falls nicht, neu wählen.
await clickSegment(0);
await focusCmd();
await typeLine("copy");
const copyPrompt = await prompt();
await typeLine("0,0");
logs.push(`[DBG] copy after base: segs=${(await segs()).length}`);
await typeLine("r2,0");
logs.push(`[DBG] copy after r2,0: segs=${(await segs()).length}`);
await page.keyboard.press("Enter"); // Copy-Serie beenden
await sleep(150);
const afterCopy = await segs();
logs.push(`[DBG] copy after Enter: segs=${afterCopy.length}`);
await page.screenshot({ path: "scripts/probe-edit-copy.png" });

// ── 4) Offset einer Polylinie um 0.5 ────────────────────────────────────────
// Frische Polylinie: ein offener L-Zug (3,-3)→(7,-3)→(7,-1). Tief unten (y<0),
// damit sie sich nicht mit den obigen Linien überlagert.
await focusCmd();
await typeLine("polyline");
await typeLine("3,-3");
await typeLine("7,-3");
await typeLine("7,-1");
await page.keyboard.press("Enter"); // offenen Zug beenden
await sleep(150);
const afterPoly = await segs();
logs.push(`[DBG] afterPoly segs=${JSON.stringify(afterPoly.map((s) => ({ a: { x: +s.a.x.toFixed(2), y: +s.a.y.toFixed(2) }, b: { x: +s.b.x.toFixed(2), y: +s.b.y.toFixed(2) } })))}`);

// Eines der Polylinien-Segmente selektieren (das letzte gezeichnete Segment).
// Wir suchen ein Segment mit y≈-3 (die untere waagerechte Kante).
const polyIdx = await page.evaluate((PX) => {
  const lines = [...document.querySelectorAll(".plan-svg line.draw2d")];
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    const y1 = -parseFloat(ln.getAttribute("y1")) / PX;
    const y2 = -parseFloat(ln.getAttribute("y2")) / PX;
    if (Math.abs(y1 + 3) < 0.05 && Math.abs(y2 + 3) < 0.05) return i;
  }
  return -1;
}, PX);
await clickSegment(polyIdx);
const offsetSelGrips = await page.evaluate(
  () => document.querySelectorAll(".plan-svg .plan-grip").length,
);

await focusCmd();
await typeLine("offset");
const offsetPrompt = await prompt();
await typeLine("0.5"); // Distanz tippen (Seite via Vorzeichen/Default links)
await sleep(150);
const afterOffset = await segs();
await page.screenshot({ path: "scripts/probe-edit-offset.png" });

// ── Auswertung ───────────────────────────────────────────────────────────────
function summarize(list) {
  return list.map((s) => ({
    a: { x: +s.a.x.toFixed(3), y: +s.a.y.toFixed(3) },
    b: { x: +s.b.x.toFixed(3), y: +s.b.y.toFixed(3) },
  }));
}

// Move-Check: nach Move soll genau eine Linie existieren, beide Endpunkte y≈2.
const moveLine = afterMove.find(
  (s) => near(s.a.y, 2) && near(s.b.y, 2) && (near(s.a.x, 0) || near(s.b.x, 0)),
);
const moveOk =
  afterLine.length === afterMove.length && // gleiche Anzahl (kein neues Element)
  !!moveLine &&
  near(Math.abs(moveLine.b.x - moveLine.a.x), 4); // Länge bleibt 4 m

// Copy-Check: nach Copy zwei waagerechte Linien bei y≈2; eine bei x∈[0,4], eine
// um 2 m nach rechts (x∈[2,6]).
const horizAtY2 = afterCopy.filter((s) => near(s.a.y, 2) && near(s.b.y, 2));
const xsMin = horizAtY2.map((s) => Math.min(s.a.x, s.b.x)).sort((p, q) => p - q);
const copyOk =
  afterCopy.length === afterMove.length + 1 && // genau ein Segment dazu
  horizAtY2.length === 2 &&
  near(xsMin[0], 0) &&
  near(xsMin[1], 2);

// Offset-Check: das Offset fügt eine versetzte Polylinie hinzu. Wir prüfen, dass
// eine NEUE untere Kante bei y≈-3±0.5 existiert (parallel, Abstand 0.5). Die
// Seite (oben/unten) ergibt sich aus der Default-Klickseite; wir akzeptieren
// beide Vorzeichen, prüfen aber den Abstand = 0.5.
const addedByOffset = afterOffset.length - afterPoly.length;
// Untere Original-Kante: y=-3, von x=3..7. Versetzte Kante: y=-3±0.5.
const bottomEdges = afterOffset.filter(
  (s) => near(s.a.y, s.b.y) && Math.abs(s.a.x - s.b.x) > 1.0, // waagerechtes Segment
);
const ysBottom = [...new Set(bottomEdges.map((s) => +s.a.y.toFixed(3)))].sort(
  (p, q) => p - q,
);
// Erwartung: y=-3 (Original) + eine parallele Kante 0.5 entfernt.
const hasParallel = ysBottom.some(
  (y) => near(Math.abs(y - -3), 0.5) && !near(y, -3),
);
const offsetOk = addedByOffset >= 2 && hasParallel;

console.log(
  JSON.stringify(
    {
      prompts: { movePrompt, moveTargetPrompt, copyPrompt, offsetPrompt },
      counts: {
        afterLine: afterLine.length,
        afterMove: afterMove.length,
        afterCopy: afterCopy.length,
        afterPoly: afterPoly.length,
        afterOffset: afterOffset.length,
        addedByOffset,
      },
      grips: { moveSelInfo, offsetSelGrips },
      moveLine: moveLine ? summarize([moveLine])[0] : null,
      horizAtY2: summarize(horizAtY2),
      ysBottom,
      checks: { moveOk, copyOk, offsetOk },
      verdict: moveOk && copyOk && offsetOk ? "PASS" : "FAIL",
    },
    null,
    2,
  ),
);
if (logs.length) {
  console.log("=== Logs ===");
  console.log(logs.join("\n"));
}
await browser.close();
