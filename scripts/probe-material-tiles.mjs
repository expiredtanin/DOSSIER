// Probe (Materialien-Tab — PBR-Kugel-Vorschau + Filter): öffnet den Ressourcen-
// Manager, wechselt in den neuen „Materialien"-Tab, prüft dass Kacheln
// erscheinen, mindestens eine Kugel-Vorschau (Bild) gerendert wurde, und dass
// Such-/Kategorie-Filter die Trefferzahl verändern.
//
// Aufruf: PROBE_URL=http://localhost:5187/ node scripts/probe-material-tiles.mjs
import puppeteer from "puppeteer";

const URL = process.env.PROBE_URL || "http://localhost:5187/";
const OUT = "scripts";

const browser = await puppeteer.launch({
  headless: "new",
  args: ["--no-sandbox", "--use-gl=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1360, height: 900, deviceScaleFactor: 2 });

const logs = [];
page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => logs.push(`[PAGEERROR] ${e.message}`));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = (n) => page.screenshot({ path: `${OUT}/${n}` });

async function clickByText(selector, text) {
  const handle = await page.evaluateHandle(
    (sel, t) =>
      [...document.querySelectorAll(sel)].find((el) => el.textContent.includes(t)),
    selector,
    text,
  );
  const el = handle.asElement();
  if (!el) throw new Error(`nicht gefunden: ${selector} ~ "${text}"`);
  await el.click();
  return el;
}

await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 20000 });
await page.waitForSelector(".topbar", { timeout: 20000 });
await sleep(600);

// 1) Ressourcen öffnen → in den Materialien-Tab wechseln.
await page.waitForSelector('button[aria-label="Ressourcen"]', { timeout: 8000 });
await page.click('button[aria-label="Ressourcen"]');
await page.waitForSelector(".res-drawer", { timeout: 8000 });
await clickByText(".res-tab-btn", "Materialien");
await page.waitForSelector(".mat-lib-grid .mat-tile", { timeout: 8000 });

const tileCount = await page.$$eval(".mat-lib-grid .mat-tile", (els) => els.length);
console.log("Material-Kacheln (ungefiltert):", tileCount);

// 2) Warten, bis mindestens eine Kugel-Vorschau gerendert ist (Bild im Tile).
await page.waitForFunction(
  () => document.querySelectorAll(".mat-sphere img").length > 0,
  { timeout: 10000 },
);
// Sichtbare Kacheln lazy nachladen lassen (Warteschlange rendert seriell).
await sleep(2500);
const renderedCount = await page.$$eval(".mat-sphere img", (els) => els.length);
console.log("Gerenderte Kugel-Vorschauen (sichtbarer Bereich):", renderedCount);

// Erstes Vorschaubild darf kein leeres/transparentes 1x1-Pixelbild sein.
const firstSrc = await page.$eval(".mat-sphere img", (img) => img.src);
console.log("Erste Vorschau-DataURL-Länge:", firstSrc.length);

await shot("probe-material-tiles-1-grid.png");

// 3) Kategorie-Filter: erste konkrete Kategorie-Chip anklicken (nicht "Alle").
const chipLabels = await page.$$eval(".mat-chip", (els) => els.map((e) => e.textContent));
console.log("Kategorie-Chips:", chipLabels);
const firstCategoryChip = chipLabels[1]; // Index 0 = "Alle".
await clickByText(".mat-chip", firstCategoryChip);
await sleep(300);
const filteredByCategory = await page.$$eval(".mat-lib-grid .mat-tile", (els) => els.length);
console.log(`Kacheln nach Kategorie-Filter ("${firstCategoryChip}"):`, filteredByCategory);
await shot("probe-material-tiles-2-category.png");

// Filter zurücksetzen ("Alle").
await clickByText(".mat-chip", "Alle");
await sleep(200);

// 4) Textsuche: nach "Holz" suchen (mehrere Bibliotheks-Einträge betroffen).
await page.type(".mat-search", "Holz");
await sleep(400);
const filteredByText = await page.$$eval(".mat-lib-grid .mat-tile", (els) => els.length);
console.log('Kacheln nach Textsuche ("Holz"):', filteredByText);
await shot("probe-material-tiles-3-search.png");

// 5) Kachel auswählen → aktiv-Zustand + Statuszeile prüfen.
await page.click(".mat-lib-grid .mat-tile");
await sleep(200);
const hasActive = await page.$(".mat-lib-grid .mat-tile.active");
const selectedLine = await page.$eval(".mat-lib-selected", (el) => el.textContent).catch(() => null);
console.log("Aktive Kachel vorhanden:", !!hasActive, "| Auswahl-Zeile:", selectedLine);
await shot("probe-material-tiles-4-selected.png");

console.log("--- console ---");
for (const l of logs.slice(-30)) console.log(l);

if (tileCount === 0) throw new Error("Keine Material-Kacheln gefunden");
if (renderedCount === 0) throw new Error("Keine Kugel-Vorschau gerendert");
if (firstSrc.length < 200) throw new Error("Vorschau-DataURL wirkt leer");
if (filteredByCategory >= tileCount) throw new Error("Kategorie-Filter hat nichts gefiltert");
if (filteredByText >= tileCount) throw new Error("Textsuche hat nichts gefiltert");
if (!hasActive) throw new Error("Kachel-Auswahl hat keinen aktiven Zustand gesetzt");

await browser.close();
console.log("done");
