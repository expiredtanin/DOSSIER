// Probe (Welle A — 3D-Materialien): weist einem Wand-Bauteil ein Bibliotheks-
// Material (Backstein) zu, schaltet 3D auf „Texturiert" und beweist die
// texturierte Wand mit Normal-Map-Tiefe. Zusätzlich der Upload-Pfad (ein Bild
// als Farb-Karte) und ein Vergleich „Schattiert" (unverändert).
//
// Aufruf: PROBE_URL=http://localhost:5174/ node scripts/probe-materials.mjs
import puppeteer from "puppeteer";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const URL = process.env.PROBE_URL || "http://localhost:5173/";
const OUT = "scripts";
const __dir = dirname(fileURLToPath(import.meta.url));

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
}

await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 20000 });
await page.waitForSelector(".topbar", { timeout: 20000 });
await sleep(600);

// 1) Ressourcen öffnen → Tab Bauteile (Default).
await clickByText("button.res-trigger", "Ressourcen");
await sleep(400);
await page.waitForSelector(".res-material-btn", { timeout: 8000 });

// 2) Beim ersten Bauteil (Wand-Schicht) den Material-Picker öffnen.
const matBtns = await page.$$(".res-material-btn");
console.log("Material-Buttons:", matBtns.length);
// Ein Bauteil wählen, das in Wänden verwendet wird — typischerweise das erste.
await matBtns[0].click();
await page.waitForSelector(".mat-dialog", { timeout: 8000 });
await shot("probe-materials-1-picker.png");

// 3) Bibliotheks-Material „Backstein" (Bricks104) zuweisen.
await clickByText(".mat-tile", "Backstein");
await sleep(400);
await shot("probe-materials-2-assigned.png");

// 4) Ressourcen-Panel zuverlässig schließen, dann in die Perspektive wechseln.
async function closeResources() {
  // Schwebendes ResourceManager-Fenster über den ×-Knopf der Schublade schließen
  // (der overlay-Backdrop liegt über der Topbar; res-trigger ist verdeckt).
  const closeBtn = await page.$(".res-drawer .res-close");
  if (closeBtn) {
    await closeBtn.click();
    await page.waitForSelector(".res-drawer", { hidden: true, timeout: 5000 });
    await sleep(200);
  }
}
await closeResources();
// Perspektive-Ansicht aktivieren (Icon-Grid: aria-label "Perspektive").
const persp = await page.$('button[aria-label="Perspektive"]');
if (persp) await persp.click();
await sleep(1200);

// Darstellung-Dropdown auf „Texturiert".
async function setStyle(label) {
  // Custom-Dropdown (kein natives select): per title öffnen, Option per Text.
  const trigger = await page.$('button.tb-dd-trigger[title*="Darstellungsart der"]');
  if (!trigger) throw new Error("Darstellung-Dropdown nicht gefunden");
  await trigger.click();
  await page.waitForSelector("button.tb-dd-item", { timeout: 4000 });
  await sleep(150);
  await clickByText("button.tb-dd-item", label);
  await sleep(1300);
}
await setStyle("Schattiert");
await shot("probe-materials-3-shaded.png");
await setStyle("Texturiert");
await sleep(1800); // Texturen lazy laden lassen
await shot("probe-materials-4-textured.png");

// 5) Upload-Pfad: ein Bild als Farb-Karte hochladen + zuweisen.
//    Wieder Ressourcen öffnen, Picker öffnen, Datei wählen, zuweisen.
await clickByText("button.res-trigger", "Ressourcen");
await sleep(400);
const matBtns2 = await page.$$(".res-material-btn");
// Ein anderes Bauteil (zweite Schicht) nehmen, falls vorhanden, sonst dasselbe.
await (matBtns2[1] ?? matBtns2[0]).click();
await page.waitForSelector(".mat-dialog", { timeout: 8000 });
// Verstecktes File-Input der Farb-Zeile bespielen.
const fileInput = await page.$('.mat-upload-grid input[type="file"]');
const imgPath = resolve(__dir, "../public/assets/materials/WoodFloor051/color.jpg");
await fileInput.uploadFile(imgPath);
await sleep(500);
await shot("probe-materials-5-upload.png");
await clickByText(".mat-actions .res-add", "Zuweisen");
await sleep(400);

// Zurück in 3D (Texturiert ist noch aktiv): Panel schließen.
await closeResources();
await sleep(900);
await shot("probe-materials-6-upload-3d.png");

console.log("--- console ---");
for (const l of logs.slice(-30)) console.log(l);

await browser.close();
console.log("done");
