// Probe: Kontext/Gelände-Integration (Phase 2, UI).
//
// 1) Erzeugt eine kleine Test-DXF (LWPOLYLINE-Höhenlinien Z=400/401/402).
// 2) Treibt den Import über das versteckte DXF-<input type=file> (uploadFile) —
//    derselbe Pfad wie der Panel-Button „DXF importieren".
// 3) Screenshot Grundriss: Konturen als dezente Linien sichtbar.
// 4) Site-Panel-Tab aktivieren, „Gelände erzeugen" klicken.
// 5) In die Perspektive/Isometrie wechseln, orbiten, Screenshot: TIN im 3D.
import puppeteer from "puppeteer";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const URL = process.env.PROBE_URL || "http://localhost:5173/";

// ── Test-DXF: drei geschlossene LWPOLYLINE-Höhenlinien (Elevation-Gruppe 38) ──
function ring(z, pts, layer) {
  let s = `0\nLWPOLYLINE\n8\n${layer}\n38\n${z}\n90\n${pts.length}\n70\n1\n`;
  for (const [x, y] of pts) s += `10\n${x}\n20\n${y}\n`;
  return s;
}
// Etwas größere Konturen, damit sie im Plan gut sichtbar sind (Meter).
const dxf =
  `0\nSECTION\n2\nENTITIES\n` +
  ring(400, [[0, 0], [20, 0], [20, 20], [0, 20]], "contours") +
  ring(401, [[4, 4], [16, 4], [16, 16], [4, 16]], "contours") +
  ring(402, [[8, 8], [12, 8], [12, 12], [8, 12]], "contours") +
  `0\nENDSEC\n0\nEOF\n`;

const dir = mkdtempSync(join(tmpdir(), "cad-dxf-"));
const dxfPath = join(dir, "contours.dxf");
writeFileSync(dxfPath, dxf);

const browser = await puppeteer.launch({
  headless: "new",
  args: ["--no-sandbox", "--use-gl=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
const logs = [];
page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => logs.push(`[PAGEERROR] ${e.message}`));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

await page.goto(URL, { waitUntil: "networkidle0", timeout: 20000 });
await wait(600);

// Frisches Default-Layout erzwingen (neuer „site"-Tab), localStorage leeren.
await page.evaluate(() => {
  try { localStorage.clear(); } catch { /* ignore */ }
});
await page.reload({ waitUntil: "networkidle0", timeout: 20000 });
await wait(600);

const clickByText = async (sel, re) => {
  const el = (
    await page.evaluateHandle(
      (sel, reSrc) => {
        const re = new RegExp(reSrc);
        return [...document.querySelectorAll(sel)].find((e) => re.test(e.textContent.trim()));
      },
      sel,
      re.source,
    )
  ).asElement();
  if (!el) throw new Error(`kein ${sel} matcht ${re}`);
  await el.click();
  return el;
};

// ── 2) Import über das versteckte DXF-Input ───────────────────────────────────
const input = await page.$('input[type=file][accept*=".dxf"]');
if (!input) throw new Error("DXF-Datei-Input nicht gefunden");
await input.uploadFile(dxfPath);
await wait(700);

// ── 3) Grundriss-Screenshot (Konturen sichtbar) ──────────────────────────────
// „Einpassen" über die Plan-Zoom-Buttons, damit die Konturen gerahmt werden.
await page.evaluate(() => {
  const btn = [...document.querySelectorAll("button")].find((b) =>
    /einpassen|fit|⊡|⤢/i.test(b.textContent || b.title || ""),
  );
  btn?.click();
});
await wait(500);
await page.screenshot({ path: "scripts/probe-terrain-ui-a-plan.png" });

// ── 4) Site-Panel öffnen + „Gelände erzeugen" ────────────────────────────────
// Den „Gelände/Terrain"-Tab in der rechten Gruppe aktivieren (TabStrip nutzt
// .tab-Buttons; ein Klick aktiviert den Tab über den Drag-Controller).
await clickByText(".tab", /^(Gelände|Terrain)$/);
await wait(400);
await page.screenshot({ path: "scripts/probe-terrain-ui-b-panel.png" });

// „Gelände erzeugen"-Button im Site-Panel klicken.
const genClicked = await page.evaluate(() => {
  const btn = [...document.querySelectorAll(".site-panel .site-btn")].find((b) =>
    /Gelände erzeugen|Generate terrain/i.test(b.textContent),
  );
  if (btn) { btn.click(); return true; }
  return false;
});
console.log("Gelände-erzeugen geklickt:", genClicked);
await wait(600);

// Kontext-Objekte zählen (Liste im Site-Panel).
const rows = await page.evaluate(
  () => document.querySelectorAll(".site-panel .site-row").length,
);
const badges = await page.evaluate(() =>
  [...document.querySelectorAll(".site-panel .site-badge")].map((b) => b.textContent.trim()),
);
console.log("Site-Listenzeilen:", rows, "Badges:", JSON.stringify(badges));

// ── 5) Isometrie → 3D-Screenshot (TIN sichtbar) ──────────────────────────────
// Der „Isometrie"-view-btn setzt view3d=iso UND wechselt zugleich in die
// Perspektive (echter Ansichtswechsel) — ein Klick genügt.
await clickByText("button.view-btn", /^Isometrie$|^Isometric$/);
await wait(1200);

const vp = await page.evaluate(() => {
  const r = document.querySelector(".viewport")?.getBoundingClientRect();
  return r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null;
});
if (vp) {
  const cx = vp.x + vp.w / 2, cy = vp.y + vp.h / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down({ button: "middle" });
  await page.mouse.move(cx + 120, cy + 30, { steps: 12 });
  await page.mouse.up({ button: "middle" });
  await wait(500);
}
await page.screenshot({ path: "scripts/probe-terrain-ui-c-3d.png" });

console.log("logs:", logs.length ? logs.join("\n") : "(keine)");
await browser.close();
