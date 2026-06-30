// Probe: Gelände-TIN (Kontext-Schicht) im 3D sichtbar.
// Seedet über window.__seedTerrain() einen Höhenlinien-Satz + abgeleitetes TIN,
// wechselt in die Perspektive, orbitet ein wenig und screenshotet.
// Erwartung: eine plausible Geländefläche (TIN) im 3D.
import puppeteer from "puppeteer";

const URL = process.env.PROBE_URL || "http://localhost:5173/";
const browser = await puppeteer.launch({
  headless: "new",
  args: ["--no-sandbox", "--use-gl=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });

const logs = [];
page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => logs.push(`[PAGEERROR] ${e.message}`));

await page.goto(URL, { waitUntil: "networkidle0", timeout: 20000 });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// 1) Gelände seeden (echte siteSlice-Actions über window.__seedTerrain).
const seed = await page.evaluate(() => window.__seedTerrain?.());
console.log("seed:", JSON.stringify(seed));
await wait(400);

// 2) In die Perspektive wechseln (löst Szenen-Neuaufbau inkl. Kontext aus).
const clickByText = async (sel, text) => {
  const handle = await page.evaluateHandle(
    (sel, text) =>
      [...document.querySelectorAll(sel)].find((el) => el.textContent.trim() === text),
    sel,
    text,
  );
  const el = handle.asElement();
  if (!el) throw new Error(`Button "${text}" (${sel}) nicht gefunden`);
  await el.click();
};
await clickByText("button.view-btn", "Perspektive");
await wait(1000);

// 3) Isometrie für einen guten Blick auf die Geländefläche.
await clickByText("button.view-btn", "Isometrie");
await wait(900);

// 4) Etwas orbiten (mittlere Maustaste über dem Viewport).
const vp = await page.evaluate(() => {
  const r = document.querySelector(".viewport")?.getBoundingClientRect();
  return r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null;
});
if (vp) {
  const cx = vp.x + vp.w / 2;
  const cy = vp.y + vp.h / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down({ button: "middle" });
  await page.mouse.move(cx + 120, cy + 40, { steps: 12 });
  await page.mouse.up({ button: "middle" });
  await wait(500);
}

await page.screenshot({ path: "scripts/probe-terrain.png" });

// Diagnostik: Anzahl Meshes in der Szene ist im Headless nicht direkt lesbar;
// wir berichten Seed-Resultat + Konsolenfehler.
console.log("logs:", logs.length ? logs.join("\n") : "(keine)");
await browser.close();
