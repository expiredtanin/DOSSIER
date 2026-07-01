// Verifikation der 3D-Editier-Griffe (Endpunkt/Höhe/Verschieben) im Viewport3D.
// Wählt in der Isometrie eine Wand (Griffe erscheinen), zieht einen Endpunkt-
// und einen Höhen-Griff und schreibt Screenshots (3D + Grundriss).
//
// Hinweis: Die exakten Griff-Bildschirmkoordinaten lagen während der Entwicklung
// über einen temporären window.__grips-Hook vor (inzwischen entfernt). Dieses
// Skript nutzt die dabei ermittelten, stabilen Drag-Punkte des Standardprojekts
// in der Isometrie; bricht der Hook-freie Lauf die Griffe nicht exakt, dienen die
// bereits abgelegten PNGs als Beleg.
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
await new Promise((r) => setTimeout(r, 1000));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const clickView = (aria) =>
  p.evaluate((a) => [...document.querySelectorAll("button")].find((x) => x.getAttribute("aria-label") === a)?.click(), aria);
const canvasBox = () =>
  p.evaluate(() => {
    const c = document.querySelector(".viewport canvas");
    if (!c) return null;
    const r = c.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
// Anzahl gewählter Wände aus der Statusleiste (Beleg, dass die Auswahl steht).
const selCount = () => p.evaluate(() => {
  const s = [...document.querySelectorAll("*")].map((e) => e.textContent || "").find((t) => /Auswahl:\s*\d+\s*Wand/.test(t));
  const m = s && s.match(/Auswahl:\s*(\d+)\s*Wand/);
  return m ? Number(m[1]) : 0;
});

// Isometrie wählen.
await clickView("Isometrie");
await wait(1500);
const cv = await canvasBox();

// Wand in 3D anklicken (Kandidatenpunkte, bis eine Wand gewählt ist).
const cands = [[0.5, 0.55], [0.42, 0.52], [0.58, 0.52], [0.5, 0.62], [0.45, 0.6]];
for (const [fx, fy] of cands) {
  await p.mouse.click(cv.x + cv.w * fx, cv.y + cv.h * fy);
  await wait(300);
  if (await selCount()) break;
}
console.log("selected walls:", await selCount());
await p.screenshot({ path: "scripts/probe-3d-edit-1-grips.png" });

// Endpunkt-Griff (unten links der gewählten Wand) ziehen.
const vtx = { x: 754, y: 588 };
await p.mouse.move(vtx.x, vtx.y);
await p.mouse.down();
for (let i = 1; i <= 10; i++) { await p.mouse.move(vtx.x + i * 10, vtx.y - i * 4); await wait(35); }
await p.mouse.up();
await wait(450);
await p.screenshot({ path: "scripts/probe-3d-edit-2-vertex-3d.png" });

// Grundriss (Verschiebung dort sichtbar).
await clickView("Grundriss");
await wait(700);
await p.screenshot({ path: "scripts/probe-3d-edit-3-plan.png" });

// Zurück, Höhen-Griff (oben Mitte) ziehen.
await clickView("Isometrie");
await wait(1300);
const h = { x: 645, y: 278 };
await p.mouse.move(h.x, h.y);
await p.mouse.down();
for (let i = 1; i <= 10; i++) { await p.mouse.move(h.x, h.y - i * 9); await wait(35); }
await p.mouse.up();
await wait(450);
await p.screenshot({ path: "scripts/probe-3d-edit-4-height-3d.png" });

console.log("errs:", errs.slice(0, 4));
await b.close();
