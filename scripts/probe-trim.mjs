// Verifikation Trim (Quick-Trim „stutzen"). Zwei sich kreuzende Linien zeichnen,
// dann `trim` und auf den Überstand einer Linie klicken → der Überstand ist bis
// zum Schnittpunkt weg (neuer Endpunkt = Schnittpunkt). Liest die gerenderten
// `line.draw2d`-Segmente direkt aus dem SVG (Modellkoord. = SVG/PX_PER_M).
import puppeteer from "puppeteer";

const PX = 90; // PX_PER_M in PlanView
const b = await puppeteer.launch({
  headless: "new",
  args: ["--no-sandbox", "--use-gl=swiftshader", "--enable-unsafe-swiftshader"],
});
const p = await b.newPage();
await p.setViewport({ width: 1280, height: 820, deviceScaleFactor: 1 });
const errs = [];
p.on("pageerror", (e) => errs.push(e.message));
await p.goto("http://localhost:5187/", { waitUntil: "networkidle0", timeout: 20000 }).catch(() => {});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(800);

const focusCmd = async () => {
  const el = await p.$(".cmdline-input");
  const bx = await el.boundingBox();
  await p.mouse.click(bx.x + bx.width / 2, bx.y + bx.height / 2);
  await sleep(60);
};
const typeLine = async (t) => {
  await p.type(".cmdline-input", t, { delay: 6 });
  await p.keyboard.press("Enter");
  await sleep(90);
};
const segs = () =>
  p.evaluate((PX) => {
    return [...document.querySelectorAll(".plan-svg line.draw2d")].map((l) => ({
      x1: +l.getAttribute("x1") / PX,
      y1: -l.getAttribute("y1") / PX,
      x2: +l.getAttribute("x2") / PX,
      y2: -l.getAttribute("y2") / PX,
    }));
  }, PX);
// Modellpunkt → Client-Pixel über das aktuelle SVG-CTM.
const modelToClient = (mx, my) =>
  p.evaluate(
    (mx, my, PX) => {
      const svg = document.querySelector(".plan-svg");
      const ctm = svg.getScreenCTM();
      const q = svg.createSVGPoint();
      q.x = mx * PX;
      q.y = -my * PX;
      const s = q.matrixTransform(ctm);
      return [s.x, s.y];
    },
    mx,
    my,
    PX,
  );

// ── Zwei sich kreuzende Linien ───────────────────────────────────────────────
// A: horizontal y=2, x=0..6 (Überstand rechts ab x=4). B: vertikal x=4, y=0..4.
await focusCmd();
await typeLine("line");
await typeLine("0,2");
await typeLine("6,2");
await focusCmd();
await typeLine("line");
await typeLine("4,0");
await typeLine("4,4");
await p.keyboard.press("Escape");
await sleep(120);

const before = await segs();

// ── Trim: auf den Überstand von A (x=5, y=2) klicken ─────────────────────────
await focusCmd();
await typeLine("trim");
// Befehl ist aktiv; jetzt in der Plan-Ansicht auf den Überstand klicken.
// Eingabefeld behält Fokus → der Klick geht trotzdem an PlanView (pick).
const [hx, hy] = await modelToClient(5, 2);
await p.mouse.move(hx, hy);
await sleep(120);
await p.mouse.click(hx, hy);
await sleep(200);
await p.keyboard.press("Escape");
await sleep(120);

const after = await segs();
await p.screenshot({ path: "scripts/probe-trim.png" });

// ── Auswertung: gibt es ein horizontales Segment (y≈2), das bei x≈4 endet und
// NICHT über x=4 hinausragt? Der Überstand x∈(4,6] muss weg sein. ────────────
const horiz = after.filter((s) => Math.abs(s.y1 - 2) < 0.05 && Math.abs(s.y2 - 2) < 0.05);
const maxX = horiz.reduce((m, s) => Math.max(m, s.x1, s.x2), -Infinity);
const trimmedToIntersection = Math.abs(maxX - 4) < 0.05;

console.log(
  JSON.stringify(
    {
      beforeCount: before.length,
      afterCount: after.length,
      horizSegments: horiz,
      maxXofHoriz: maxX,
      trimmedToIntersection,
      errs,
    },
    null,
    2,
  ),
);
await b.close();
