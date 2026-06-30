// Probe für das DOSSIER-Dokumentmodell (Augen-Navigator + Mehrgeschoss-3D).
// Erfasst fünf Zustände in separate PNGs (deviceScaleFactor 2):
//   (a) Standard: EG Grundriss mit Augen-Navigator (EG aktiv, andere gedimmt).
//   (b) Perspektive mit EG + OG sichtbar → zwei Räume vertikal gestapelt.
//   (c) OG-Auge ausgeschaltet → nur EG bleibt im 3D.
//   (d) EG Geschosshöhe auf 3.5 → größerer Abstand zu OG; "+ Ebene" anklicken
//       → neue Kategorie erscheint im Navigator.
//   (e) Zeichnungsebene "Detail 1" → leerer Zeichnungs-Platzhalter.
//
// Aufruf: node scripts/probe-dossier.mjs
import puppeteer from "puppeteer";

const URL = process.env.PROBE_URL || "http://localhost:5173/";
const OUT = "scripts";

const browser = await puppeteer.launch({
  headless: "new",
  args: ["--no-sandbox", "--use-gl=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 820, deviceScaleFactor: 2 });

const logs = [];
page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => logs.push(`[PAGEERROR] ${e.message}`));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Klick auf das Element, dessen Textinhalt `text` enthält (innerhalb selector).
async function clickByText(selector, text) {
  const handle = await page.evaluateHandle(
    (sel, t) =>
      [...document.querySelectorAll(sel)].find((el) =>
        el.textContent.includes(t),
      ),
    selector,
    text,
  );
  const el = handle.asElement();
  if (!el) throw new Error(`Element nicht gefunden: ${selector} ~ "${text}"`);
  await el.click();
}

// Klick auf das Augen-Symbol einer Zeichnungsebene mit gegebenem Namen.
async function toggleLevelEyeByName(name) {
  const ok = await page.evaluate((n) => {
    const row = [...document.querySelectorAll(".nav-row")].find((r) =>
      r.querySelector(".nav-label")?.textContent.trim().includes(n),
    );
    const eye = row?.querySelector(".eye");
    if (!eye) return false;
    eye.click();
    return true;
  }, name);
  if (!ok) throw new Error(`Augen-Schalter nicht gefunden für Ebene: ${name}`);
}

// Diagnose: aktueller Navigator-Zustand (für Querprüfung der Screenshots).
const navState = () =>
  page.evaluate(() => {
    const levels = [...document.querySelectorAll(".nav-row")].map((r) => ({
      name: r.querySelector(".nav-label")?.textContent.trim(),
      active: r.classList.contains("active"),
      dimmed: r.classList.contains("hidden"),
      elev: r.querySelector(".nav-elev")?.textContent.trim() ?? null,
    }));
    const cats = [...document.querySelectorAll(".cat-row")].map((r) =>
      r.querySelector(".cat-name")?.textContent.trim(),
    );
    const canvas = document.querySelector(".viewport canvas");
    return {
      levels,
      catCount: cats.length,
      catNames: cats,
      hasCanvas: !!canvas,
      egHeight: document.querySelector(".props-strip input")?.value ?? null,
    };
  });

try {
  await page.goto(URL, { waitUntil: "networkidle0", timeout: 20000 });
} catch (e) {
  logs.push(`[GOTO-ERROR] ${e.message}`);
}
await sleep(700);

// ── (a) Standard: EG Grundriss mit Augen-Navigator ──────────────────────────
await page.screenshot({ path: `${OUT}/probe-a-eg-grundriss.png` });
logs.push("(a) STATE " + JSON.stringify(await navState()));

// ── (b) Perspektive mit EG + OG sichtbar ───────────────────────────────────
await clickByText(".view-btn", "Perspektive");
await sleep(1400);
await page.screenshot({ path: `${OUT}/probe-b-eg-og-perspektive.png` });
logs.push("(b) STATE " + JSON.stringify(await navState()));

// ── (c) OG-Auge ausschalten → nur EG bleibt im 3D ──────────────────────────
await toggleLevelEyeByName("Obergeschoss");
await sleep(1400);
await page.screenshot({ path: `${OUT}/probe-c-only-eg-3d.png` });
logs.push("(c) STATE " + JSON.stringify(await navState()));

// OG wieder einblenden, damit (d) den Stapel-Abstand zeigt.
await toggleLevelEyeByName("Obergeschoss");
await sleep(400);

// ── (d) EG Geschosshöhe auf 3.5 → größerer Abstand zu OG ───────────────────
// EG ist die Standardauswahl; die props-strip zeigt das aktive Geschoss.
await page.evaluate(() => {
  const input = document.querySelector(".props-strip input");
  if (!input) throw new Error("Geschosshöhe-Feld nicht gefunden");
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  ).set;
  setter.call(input, "3.5");
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
});
await sleep(1400);
// "+ Ebene" anklicken → neue Kategorie erscheint im Navigator.
await clickByText(".nav-add", "+ Ebene");
await sleep(500);
await page.screenshot({ path: `${OUT}/probe-d-height-and-addlayer.png` });
logs.push("(d) STATE " + JSON.stringify(await navState()));

// ── (e) Zeichnungsebene "Detail 1" → leerer Zeichnungs-Platzhalter ─────────
await clickByText(".nav-label", "Detail 1");
await sleep(500);
await page.screenshot({ path: `${OUT}/probe-e-detail-drawing.png` });
logs.push("(e) STATE " + JSON.stringify(await navState()));

console.log(logs.join("\n"));
await browser.close();
