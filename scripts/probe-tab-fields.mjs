// Probe für den Tab-Feld-Zyklus (Rhino-Präzisionseingabe §2.7).
//
// Treibt headless:
//   A) Tab → „line"⏎ → Startpunkt „0,0"⏎ → „3"⏎ (lockt Länge, weiter zu Winkel)
//      → „45"⏎ (lockt Winkel ⇒ committet) ⇒ EXAKTE 3-m-Linie unter 45°.
//   B) Tab → „rect"⏎ → erste Ecke „0,-3"⏎ → Maus nach rechts-oben (Quadrant)
//      → „4"⏎ (Breite) → „2"⏎ (Höhe ⇒ committet) ⇒ 4×2-Rechteck.
//
// Verifikation: liest die gerenderten `.plan-svg line.draw2d`-Endpunkte. Die
// Plan-Transform ist toScreen(p) = { x: p.x*90, y: -p.y*90 } (PX_PER_M=90, Y
// geflippt), also gilt für Modell-Längen/-Winkel:
//   modelLen   = pixelLen / 90
//   modelAngle = atan2(-(y2-y1), x2-x1)   (Y-Flip rückgängig)
// Screenshot scripts/probe-tab-fields.png zeigt Linie + Rechteck + Feld-Boxen.

import puppeteer from "puppeteer";

const URL = process.env.PROBE_URL || "http://localhost:5173/";
const PX_PER_M = 90;
const browser = await puppeteer.launch({
  headless: "new",
  args: ["--no-sandbox", "--use-gl=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1200, height: 800, deviceScaleFactor: 2 });
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

// Liest die draw2d-Segmente (in toScreen-Koordinaten = x*90 / -y*90) und rechnet
// in Modell-Länge/-Winkel zurück.
async function segments() {
  const raw = await page.evaluate(() =>
    [...document.querySelectorAll(".plan-svg line.draw2d")].map((l) => ({
      x1: +l.getAttribute("x1"),
      y1: +l.getAttribute("y1"),
      x2: +l.getAttribute("x2"),
      y2: +l.getAttribute("y2"),
    })),
  );
  return raw.map((s) => {
    const dxPx = s.x2 - s.x1;
    const dyPx = s.y2 - s.y1;
    const lenM = Math.hypot(dxPx, dyPx) / PX_PER_M;
    // Y-Flip rückgängig: Modell-dy = -(Screen-dy).
    let ang = (Math.atan2(-dyPx, dxPx) * 180) / Math.PI;
    if (ang <= -0.0001) ang += 360; // 0..360
    return { lenM: +lenM.toFixed(4), angleDeg: +ang.toFixed(2) };
  });
}

// Liest die aktuellen Feld-Boxen der Command-Line (Label + Wert/„—" + aktiv).
async function fieldBoxes() {
  return page.evaluate(() =>
    [...document.querySelectorAll(".cmdline-field")].map((f) => ({
      label: f.querySelector(".cmdline-field-label")?.textContent || "",
      val: f.querySelector(".cmdline-field-val")?.textContent || "",
      active: f.classList.contains("active"),
    })),
  );
}

async function focusCmdline() {
  await page.mouse.click(600, 400); // in den Body, damit Tab nicht ein Feld trifft
  await sleep(80);
  await page.keyboard.press("Tab");
  await sleep(120);
}

async function typeLine(text) {
  await page.type(".cmdline-input", text, { delay: 12 });
  await page.keyboard.press("Enter");
  await sleep(140);
}

const box = await page.evaluate(() => {
  const r = document.querySelector(".plan-svg").getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
});
const cx = box.x + box.w / 2;
const cy = box.y + box.h / 2;

// ── A) Linie über Felder: Länge 3, Winkel 45° ───────────────────────────────
await focusCmdline();
await typeLine("line");
const promptLine = await page.evaluate(
  () => document.querySelector(".cmdline-prompt")?.textContent || "",
);
await typeLine("0,0"); // Startpunkt → Schritt „end" (Feld-Modus aktiv)
const fieldsAtStart = await fieldBoxes();
// Maus woanders hin (zeigt: ungelockte Felder folgen der Maus, gelockte nicht).
await page.mouse.move(cx + 120, cy - 30);
await sleep(80);
await typeLine("3"); // lockt Länge → weiter zu Winkel
const fieldsAfterLen = await fieldBoxes();
// Screenshot MITTEN im Befehl: zeigt die Feld-Boxen (Länge=3, Winkel aktiv „—")
// in der Command-Line + die schon gelockte Vorschau-Linie.
await page.screenshot({ path: "scripts/probe-tab-fields-midcmd.png" });
await typeLine("45"); // lockt Winkel ⇒ committet die Linie
await sleep(150);
const segsA = await segments();

await page.screenshot({ path: "scripts/probe-tab-fields.png" });

// ── B) Rechteck über Felder: Breite 4, Höhe 2 ───────────────────────────────
await focusCmdline();
await typeLine("rect");
await typeLine("0,-3"); // erste Ecke (unter dem Ursprung, freie Fläche)
// Maus nach rechts-oben → Quadrant +x,+y (bestimmt Vorzeichen der Locks).
await page.mouse.move(cx + 150, cy - 80);
await sleep(80);
await typeLine("4"); // Breite
const rectFieldsAfterW = await fieldBoxes();
await typeLine("2"); // Höhe ⇒ committet
await sleep(150);

// Rechteck wird als 4 draw2d-Linien gerendert; sammeln + auf Auswahl umschalten,
// damit das PNG das fertige Rechteck zeigt.
const allSegs = await segments();
await page.screenshot({ path: "scripts/probe-tab-fields-rect.png" });

console.log("prompt after 'line':", JSON.stringify(promptLine));
console.log("fields at end-step start:", JSON.stringify(fieldsAtStart));
console.log("fields after locking length=3:", JSON.stringify(fieldsAfterLen));
console.log("LINE segments (model len/angle):", JSON.stringify(segsA));
console.log("rect fields after width=4:", JSON.stringify(rectFieldsAfterW));
console.log("ALL segments after rect (len/angle):", JSON.stringify(allSegs));

// ── Assertions ───────────────────────────────────────────────────────────────
const line3 = segsA.find((s) => Math.abs(s.lenM - 3) < 0.02 && Math.abs(s.angleDeg - 45) < 0.5);
console.log(
  line3
    ? `PASS: line length≈3 (${line3.lenM}) angle≈45 (${line3.angleDeg})`
    : "FAIL: no 3m/45° line found",
);

// Rechteck: zwei horizontale Kanten der Länge 4 + zwei vertikale der Länge 2.
const horiz4 = allSegs.filter(
  (s) => Math.abs(s.lenM - 4) < 0.03 && (Math.abs(s.angleDeg) < 1 || Math.abs(s.angleDeg - 180) < 1 || Math.abs(s.angleDeg - 360) < 1),
);
const vert2 = allSegs.filter(
  (s) => Math.abs(s.lenM - 2) < 0.03 && (Math.abs(s.angleDeg - 90) < 1 || Math.abs(s.angleDeg - 270) < 1),
);
console.log(
  horiz4.length >= 2 && vert2.length >= 2
    ? `PASS: rect 4×2 (horiz4=${horiz4.length}, vert2=${vert2.length})`
    : `FAIL: rect not 4×2 (horiz4=${horiz4.length}, vert2=${vert2.length})`,
);

console.log("=== Logs ===");
console.log(logs.length ? logs.join("\n") : "(keine)");
await browser.close();
