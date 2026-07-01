// Verifikation: „Wand" als echter Engine-Befehl.
//  1) GUI-„Wand" klicken → Befehlsfeld aktiv (Wand-Prompt, Feld fokussiert).
//  2) Mehrere Punkte im Plan klicken → Wände entstehen (Plan-Primitive wachsen),
//     Rechtsklick beendet den (chainenden) Zug.
//  3) In 3D (Isometrie) schalten → die Wände sind dort sichtbar (Screenshot).
//  4) Getipptes „wand" startet DENSELBEN Befehl (Prompt = Wand-Prompt).
// Temporäres Verifikations-Gerüst (nicht eingecheckt).
import puppeteer from "puppeteer";
const URL = process.env.PROBE_URL || "http://localhost:5188/";
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
const click = async (x, y, opts) => { await p.mouse.move(x, y); await p.mouse.click(x, y, opts); await wait(110); };
const cmdState = () => p.evaluate(() => {
  const prompt = document.querySelector(".cmdline-prompt")?.textContent?.trim() ?? "";
  const input = document.querySelector(".cmdline-input");
  const focused = document.activeElement === input;
  const placeholder = input?.getAttribute("placeholder") ?? "";
  return { prompt, focused, active: placeholder === "" };
});
// Grobes Mass für „Wand-Geometrie im Plan": Anzahl Pfad-/Polygon-Primitive.
// Wände rendern als gefüllte Schicht-Polygone + Umriss-Pfade; jede neue Wand
// erhöht diese Zahl deutlich.
const primCount = () => p.evaluate(() =>
  document.querySelectorAll(".plan-svg path, .plan-svg polygon").length);
const typeInCmd = async (text) => {
  await p.evaluate(() => document.querySelector(".cmdline-input")?.focus());
  await p.keyboard.type(text);
  await p.keyboard.press("Enter");
  await wait(200);
};

const box = await planBox();
const cx = box.x + box.w / 2, cy = box.y + box.h / 2;

// ── 1) „Wand" anklicken → Befehlsfeld aktiv, Wand-Prompt ─────────────────────
const primStart = await primCount();
await clickTool("Wand");
await wait(300);
const afterToolClick = await cmdState();
console.log("after Wand-tool click → cmdline:", afterToolClick);
await p.screenshot({ path: "scripts/probe-wall-cmd-1-active.png" });

// ── 2) Mehrere Punkte → chainende Wände, dann Rechtsklick zum Beenden ────────
const P = [
  [cx - 220, cy - 120],
  [cx + 40, cy - 160],
  [cx + 200, cy + 10],
  [cx + 60, cy + 150],
];
for (const pt of P) await click(...pt);
await p.mouse.click(P[P.length - 1][0], P[P.length - 1][1], { button: "right" }); // Zug beenden
await wait(300);
const primAfter = await primCount();
console.log("plan primitives start / after walls:", primStart, primAfter, "→ delta", primAfter - primStart);
await p.screenshot({ path: "scripts/probe-wall-cmd-2-plan.png" });

// ── 3) In 3D (Isometrie) → Wände sichtbar ───────────────────────────────────
await clickView("Isometrie");
await wait(1500);
await p.screenshot({ path: "scripts/probe-wall-cmd-3-3d.png" });

// Zurück in den Grundriss.
await clickView("Grundriss");
await wait(600);

// ── 4) Getipptes „wand" startet DENSELBEN Befehl ────────────────────────────
await clickTool("Auswahl");
await wait(200);
const before = await cmdState();
await typeInCmd("wand");
const afterTyped = await cmdState();
console.log("after typing 'wand' → cmdline:", afterTyped, "(was:", before, ")");
// Einen Punkt setzen + Rechtsklick (Abbruch ohne 2. Punkt) — nur Prompt-Beleg.
await p.screenshot({ path: "scripts/probe-wall-cmd-4-typed.png" });
await p.keyboard.press("Escape");

console.log("errs:", errs.slice(0, 6));
console.log("RESULT activePrompt:", afterToolClick.active, afterToolClick.prompt,
  "| primDelta:", primAfter - primStart,
  "| typedPrompt:", afterTyped.active, afterTyped.prompt);
await b.close();
