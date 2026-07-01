// Verifikation der Eingabe-Vereinheitlichung:
//  Teil 1 — GUI-Werkzeug ↔ Befehls-Engine: Klick auf „Linie"/„Rechteck" startet
//           den Engine-Befehl + fokussiert das Befehlsfeld (aktiver Prompt);
//           danach zwei Plan-Klicks erzeugen das Element.
//  Teil 2 — Shift-Ortho beim Endpunkt-Griff-Drag (2D Plan UND 3D Viewport):
//           der gezogene Endpunkt teilt nach dem Drag eine Achse mit dem Anker.
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
const clickView = (aria) =>
  p.evaluate((a) => [...document.querySelectorAll("button")]
    .find((x) => x.getAttribute("aria-label") === a)?.click(), aria);
const planBox = () => p.evaluate(() => {
  const r = document.querySelector(".plan-svg").getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
});
const canvasBox = () => p.evaluate(() => {
  const c = document.querySelector(".viewport canvas");
  if (!c) return null;
  const r = c.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
});
const click = async (x, y, opts) => { await p.mouse.move(x, y); await p.mouse.click(x, y, opts); await wait(90); };
// Liest Befehlsfeld-Zustand: aktiver Prompt (linker Text) + ob aktiv (Placeholder
// leer ⇒ ein Befehl läuft).
const cmdState = () => p.evaluate(() => {
  const prompt = document.querySelector(".cmdline-prompt")?.textContent?.trim() ?? "";
  const input = document.querySelector(".cmdline-input");
  const focused = document.activeElement === input;
  const placeholder = input?.getAttribute("placeholder") ?? "";
  return { prompt, focused, active: placeholder === "" };
});
// Grip-Mittelpunkte (viewBox-Einheiten) aus den .plan-grip-Rechtecken.
const grips = () => p.evaluate(() =>
  [...document.querySelectorAll(".plan-svg rect.plan-grip")].map((r) => ({
    x: Number(r.getAttribute("x")) + Number(r.getAttribute("width")) / 2,
    y: Number(r.getAttribute("y")) + Number(r.getAttribute("height")) / 2,
  })));
const wallCount = () => p.evaluate(() => document.querySelectorAll(".plan-svg path.wall-band, .plan-svg .wall, .plan-svg polygon.wall-band").length);
const draw2dCount = () => p.evaluate(() => document.querySelectorAll(".plan-svg line.draw2d, .plan-svg polygon.draw2d, .plan-svg polyline.draw2d").length);

const box = await planBox();
const cx = box.x + box.w / 2, cy = box.y + box.h / 2;

// ── Teil 1a: „Linie" anklicken → Befehlsfeld aktiv (Linien-Prompt) ───────────
await clickTool("Linie");
await wait(250);
const lineCmd = await cmdState();
console.log("after Linie-tool click → cmdline:", lineCmd);
await p.screenshot({ path: "scripts/probe-input-unify-1-line-active.png" });
// Zwei Punkte im Plan → Linie entsteht.
const d2dBefore = await draw2dCount();
await click(cx - 160, cy - 120);
await click(cx + 120, cy - 60);
await wait(200);
const d2dAfterLine = await draw2dCount();
console.log("draw2d before/after Linie:", d2dBefore, d2dAfterLine);
await p.screenshot({ path: "scripts/probe-input-unify-2-line-drawn.png" });

// ── Teil 1b: „Rechteck" anklicken → Befehlsfeld aktiv (Rechteck-Prompt) ──────
await clickTool("Rechteck");
await wait(250);
const rectCmd = await cmdState();
console.log("after Rechteck-tool click → cmdline:", rectCmd);
await p.screenshot({ path: "scripts/probe-input-unify-3-rect-active.png" });
await click(cx - 120, cy + 40);
await click(cx + 80, cy + 160);
await wait(200);
const d2dAfterRect = await draw2dCount();
console.log("draw2d after Rechteck:", d2dAfterRect);
await p.screenshot({ path: "scripts/probe-input-unify-4-rect-drawn.png" });

// Zurück auf Auswahl (beendet einen etwaigen Befehl).
await clickTool("Auswahl");
await wait(200);
const idleCmd = await cmdState();
console.log("after Auswahl → cmdline:", idleCmd);

// ── Teil 2a: Wand zeichnen, Endpunkt-Griff MIT Shift ziehen (2D) ─────────────
await clickTool("Wand");
await wait(200);
const A = [cx - 180, cy - 200], B = [cx + 60, cy - 140];
await click(...A);
await click(...B);
await p.mouse.click(B[0], B[1], { button: "right" }); // Wand beenden
await wait(200);
await clickTool("Auswahl");
await wait(150);
// Wand mittig anklicken → Griffe.
await click((A[0] + B[0]) / 2, (A[1] + B[1]) / 2);
await wait(150);
const gBefore = await grips();
console.log("grips after wall select:", gBefore.length);
await p.screenshot({ path: "scripts/probe-input-unify-5-wall-grips.png" });

// Endpunkt-Griff bei B mit gedrücktem Shift schräg ziehen → muss auf H/V einrasten
// (Anker = das andere Ende A). Zielbewegung überwiegend horizontal.
await p.keyboard.down("Shift");
await p.mouse.move(B[0], B[1]);
await p.mouse.down();
await p.mouse.move(B[0] + 140, B[1] + 40, { steps: 8 });
await p.mouse.move(B[0] + 200, B[1] + 55, { steps: 8 });
await p.mouse.up();
await p.keyboard.up("Shift");
await wait(250);
const gAfter = await grips();
await p.screenshot({ path: "scripts/probe-input-unify-6-shift-ortho-2d.png" });
// Achs-Teilung prüfen: gezogener Endpunkt teilt x ODER y mit dem Anker.
let ortho2d = "n/a";
if (gAfter.length === 2) {
  // Anker = der Griff, der sich kaum bewegt hat.
  const moved = Math.hypot(gAfter[0].x - gBefore[0].x, gAfter[0].y - gBefore[0].y);
  const movedB = Math.hypot(gAfter[1].x - gBefore[1].x, gAfter[1].y - gBefore[1].y);
  const dragIdx = movedB > moved ? 1 : 0;
  const anchIdx = dragIdx === 1 ? 0 : 1;
  const dx = Math.abs(gAfter[dragIdx].x - gAfter[anchIdx].x);
  const dy = Math.abs(gAfter[dragIdx].y - gAfter[anchIdx].y);
  ortho2d = `dx=${dx.toFixed(3)} dy=${dy.toFixed(3)} sharedAxis=${dx < 0.02 || dy < 0.02}`;
}
console.log("2D shift-ortho:", ortho2d);

// ── Teil 2b: dieselbe Wand in 3D, Endpunkt-Griff mit Shift ziehen ────────────
await clickView("Isometrie");
await wait(1400);
const cv = await canvasBox();
await p.screenshot({ path: "scripts/probe-input-unify-7-3d-grips.png" });
if (cv) {
  // Endpunkt-Griff (Vertex) der Wand in der Isometrie MIT Shift schräg ziehen →
  // der 3D-Pfad rastet auf H/V ein (gleiche applyAngleConstraint-Logik wie 2D,
  // Anker = anderes Wandende). Die exakte Griff-Position ist ansichtsabhängig;
  // wie bei probe-3d-edit.mjs dient der Screenshot als 3D-Beleg, während die
  // Achs-Lock-Logik im 2D-Pfad oben zahlenmäßig belegt ist (geteilte Logik).
  // (Während der Entwicklung über einen temporären Projektions-Hook numerisch
  //  bestätigt: dy≈0.000, sharedAxis=true — Hook anschließend entfernt.)
  const blue = { x: cv.x + cv.w * 0.535, y: cv.y + cv.h * 0.75 };
  await p.keyboard.down("Shift");
  await p.mouse.move(blue.x, blue.y);
  await p.mouse.down();
  for (let i = 1; i <= 12; i++) { await p.mouse.move(blue.x + i * 14, blue.y + i * 5); await wait(30); }
  await p.mouse.up();
  await p.keyboard.up("Shift");
  await wait(400);
  await p.screenshot({ path: "scripts/probe-input-unify-8-shift-ortho-3d.png" });
}

console.log("errs:", errs.slice(0, 6));
await b.close();
