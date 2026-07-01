// Verifikation der drei Editier-/Eingabe-Verbesserungen:
//  (a) Beim Zeichnen zeigt die Befehlszeile LIVE Länge/Winkel (Feld-Werte folgen
//      der Maus); KEIN Wert-HUD mehr am Cursor (kein <text class="tool-hud">).
//  (b) Zwei Wände mit gemeinsamer Ecke (Shift beide wählen), Körper einer ziehen
//      → die gemeinsame Ecke bleibt verbunden (beide Enden wandern deckungsgleich).
//  (c) Vertex-Griff-Drag + Tab → Wert tippen → exakter Zielpunkt (Befehlsfeld).
import puppeteer from "puppeteer";
const URL = process.env.PROBE_URL || "http://localhost:5187/";
const b = await puppeteer.launch({
  headless: "new",
  args: ["--no-sandbox", "--use-gl=swiftshader", "--enable-unsafe-swiftshader"],
});
const p = await b.newPage();
await p.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1.25 });
const errs = [];
p.on("pageerror", (e) => errs.push(e.message));
await p.goto(URL, { waitUntil: "networkidle0", timeout: 20000 }).catch(() => {});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await wait(900);

const clickTool = (label) =>
  p.evaluate((l) => [...document.querySelectorAll("button.tool-row")]
    .find((x) => x.textContent.trim() === l)?.click(), label);
const planBox = () => p.evaluate(() => {
  const r = document.querySelector(".plan-svg").getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
});
const click = async (x, y, opts) => { await p.mouse.move(x, y); await p.mouse.click(x, y, opts); await wait(90); };
// Befehlsfeld-Felder (Tab-Zyklus): Label + Wert + locked/live/active.
const cmdFields = () => p.evaluate(() =>
  [...document.querySelectorAll(".cmdline-field")].map((f) => ({
    label: f.querySelector(".cmdline-field-label")?.textContent?.trim() ?? "",
    val: f.querySelector(".cmdline-field-val")?.textContent?.trim() ?? "",
    active: f.classList.contains("active"),
    locked: f.classList.contains("locked"),
    live: f.classList.contains("live"),
  })));
const hudCount = () => p.evaluate(() => document.querySelectorAll(".plan-svg text.tool-hud").length);
const grips = () => p.evaluate(() =>
  [...document.querySelectorAll(".plan-svg rect.plan-grip")].map((r) => ({
    x: Number(r.getAttribute("x")) + Number(r.getAttribute("width")) / 2,
    y: Number(r.getAttribute("y")) + Number(r.getAttribute("height")) / 2,
  })));

// Modell-Meter → Client-Pixel über die plan-svg viewBox (toScreen: x*90, -y*90).
const modelToClient = (m) => p.evaluate((mm) => {
  const svg = document.querySelector(".plan-svg");
  const r = svg.getBoundingClientRect();
  const vb = svg.viewBox.baseVal;
  // meet (xMidYMid): einheitliche Skala + Letterbox-Versatz.
  const s = Math.min(r.width / vb.width, r.height / vb.height);
  const offX = (r.width - vb.width * s) / 2;
  const offY = (r.height - vb.height * s) / 2;
  const sx = mm.x * 90, sy = -mm.y * 90; // toScreen
  return { x: r.x + offX + (sx - vb.x) * s, y: r.y + offY + (sy - vb.y) * s };
}, m);
const wallEnds = () => p.evaluate(() => {
  const proj = window.__store?.getState?.().project;
  if (!proj) return null;
  return proj.walls.map((w) => ({ id: w.id, start: w.start, end: w.end }));
});
const selectedWalls = () => p.evaluate(() => window.__store?.getState?.().selectedWallIds ?? []);

const box = await planBox();
const cx = box.x + box.w / 2, cy = box.y + box.h / 2;

// ── (a) Linie zeichnen: Befehlszeile zeigt LIVE Länge/Winkel, kein Cursor-HUD ──
await clickTool("Linie");
await wait(250);
await click(cx - 160, cy - 60); // Startpunkt
// Maus bewegen (ohne Klick) → Live-Vorschau + Live-Felder.
await p.mouse.move(cx + 120, cy - 60, { steps: 6 });
await wait(200);
const drawFields = await cmdFields();
const drawHud = await hudCount();
console.log("(a) draw fields:", JSON.stringify(drawFields));
console.log("(a) cursor HUD count (soll 0):", drawHud);
await p.screenshot({ path: "scripts/probe-edit-input-a-draw-live.png" });
// Linie verwerfen.
await p.keyboard.press("Escape");
await wait(150);
await clickTool("Auswahl");
await wait(150);

// ── (b) Zwei Wände mit gemeinsamer Ecke, Shift-Mehrfachwahl, Körper ziehen ────
// Erst auskzoomen (Wheel up) → freier Bereich neben dem Haus. Dann zwei Wände
// mit gemeinsamer Ecke in einem leeren Bildbereich (oben rechts) zeichnen.
await p.mouse.move(cx, cy);
for (let i = 0; i < 6; i++) { await p.mouse.wheel({ deltaY: 120 }); await wait(40); }
await wait(200);
// Pixel-Punkte im leeren oberen Bereich (über dem Haus).
const Ap = [cx - 120, box.y + 90], Cp = [cx + 40, box.y + 90], Dp = [cx + 40, box.y + 240];
const idsPre = (await wallEnds()).map((w) => w.id);
await clickTool("Wand"); await wait(120);
await click(Ap[0], Ap[1]); await click(Cp[0], Cp[1]);
await p.mouse.click(Cp[0], Cp[1], { button: "right" }); await wait(120);
await clickTool("Wand"); await wait(120);
await click(Cp[0], Cp[1]); await click(Dp[0], Dp[1]);
await p.mouse.click(Dp[0], Dp[1], { button: "right" }); await wait(120);
await clickTool("Auswahl"); await wait(150);

const idsAll = (await wallEnds()).map((w) => w.id);
const newIds = idsAll.filter((id) => !idsPre.includes(id));
console.log("(b) new wall ids:", newIds);
const w1id = newIds[0]; // Ap→Cp
const w2id = newIds[1]; // Cp→Dp
const w1mid = [(Ap[0] + Cp[0]) / 2, (Ap[1] + Cp[1]) / 2];
const w2mid = [(Cp[0] + Dp[0]) / 2, (Cp[1] + Dp[1]) / 2];
// Beide per Shift wählen.
await click(w1mid[0], w1mid[1]);
await p.keyboard.down("Shift");
await click(w2mid[0], w2mid[1]);
await p.keyboard.up("Shift");
await wait(150);
console.log("(b) selected after shift:", await selectedWalls(), "expect:", [w1id, w2id]);
await p.screenshot({ path: "scripts/probe-edit-input-b1-both-selected.png" });

const endsBefore = (await wallEnds()).filter((w) => w.id === w1id || w.id === w2id);
console.log("(b) two new walls before:", JSON.stringify(endsBefore));

// Körper von Wand 1 mittig greifen und parallel ziehen.
await p.mouse.move(w1mid[0], w1mid[1]);
await p.mouse.down();
await p.mouse.move(w1mid[0] + 40, w1mid[1] - 55, { steps: 10 });
await p.mouse.move(w1mid[0] + 60, w1mid[1] - 90, { steps: 10 });
await p.mouse.up();
await wait(250);
await p.screenshot({ path: "scripts/probe-edit-input-b2-moved.png" });
const endsAfter = (await wallEnds()).filter((w) => w.id === w1id || w.id === w2id);
console.log("(b) two new walls after:", JSON.stringify(endsAfter));
const near = (a, b) => Math.hypot(a.x - b.x, a.y - b.y) < 0.01;
let stillJoined = "n/a", moved = "n/a";
if (endsAfter.length === 2) {
  const wA = endsAfter.find((w) => w.id === w1id), wB = endsAfter.find((w) => w.id === w2id);
  let shared = false;
  for (const a of [wA.start, wA.end]) for (const c of [wB.start, wB.end]) if (near(a, c)) shared = true;
  stillJoined = shared ? "JOINED ✓" : "SPLIT ✗";
  const b0 = endsBefore.find((w) => w.id === w1id);
  moved = b0 && near(b0.start, wA.start) && near(b0.end, wA.end) ? "NOT MOVED ✗" : "MOVED ✓";
}
console.log("(b) common corner:", stillJoined, "| wall1", moved);

// ── (c) Vertex-Griff-Drag + Tab → Länge tippen → exakter Punkt ────────────────
await clickTool("Auswahl"); await wait(120);
// Genau Wand 2 selektieren (Store direkt — robuster als ein Pixel-Klick auf die
// verschobene Geometrie). Testet (c) isoliert: Grip-Drag + Tab + Wert.
await p.evaluate((id) => window.__store.getState().setSelectedWallIds([id]), w2id);
await p.evaluate(() => window.__store.getState().setSelectedDrawingIds([]));
await wait(200);
let gBefore = await grips();
console.log("(c) grips:", gBefore.length, "selected:", await selectedWalls());
const gripToClient = (g) => p.evaluate((gg) => {
  const svg = document.querySelector(".plan-svg");
  const r = svg.getBoundingClientRect();
  const vb = svg.viewBox.baseVal;
  const s = Math.min(r.width / vb.width, r.height / vb.height);
  const offX = (r.width - vb.width * s) / 2, offY = (r.height - vb.height * s) / 2;
  return { x: r.x + offX + (gg.x - vb.x) * s, y: r.y + offY + (gg.y - vb.y) * s };
}, g);
if (gBefore.length >= 2) {
  // Den Endpunkt-Griff bei Dm greifen (der dem Anker Cm gegenüberliegt).
  const dGrip = gBefore.reduce((best, g) => {
    // Wähle den Griff, der weiter von Cm (gemeinsame Ecke) entfernt ist.
    return best; // erster Versuch: nehme den ZWEITEN Griff (Index 1 = end).
  }, gBefore[1]);
  const gc = await gripToClient(gBefore[1]);
  await p.mouse.move(gc.x, gc.y);
  await p.mouse.down();
  await p.mouse.move(gc.x + 35, gc.y - 15, { steps: 6 });
  await wait(150);
  await p.screenshot({ path: "scripts/probe-edit-input-c1-drag.png" });
  // Tab öffnet das Editier-Feld + fokussiert das Befehlsfeld.
  await p.keyboard.press("Tab");
  await wait(200);
  const editFields = await cmdFields();
  console.log("(c) edit fields after Tab:", JSON.stringify(editFields));
  // Länge 5 tippen + Enter → Zielpunkt exakt 5 m vom Anker (Cm).
  await p.keyboard.type("5");
  await p.keyboard.press("Enter");
  await wait(150);
  await p.mouse.up();
  await wait(250);
  await p.screenshot({ path: "scripts/probe-edit-input-c2-locked.png" });
  const w2after = (await wallEnds()).find((w) => w.id === w2id);
  if (w2after) {
    const len = Math.hypot(w2after.end.x - w2after.start.x, w2after.end.y - w2after.start.y);
    console.log("(c) wall2 after lock:", JSON.stringify(w2after), "len=", len.toFixed(3));
  }
}

console.log("errs:", errs.slice(0, 6));
await b.close();
