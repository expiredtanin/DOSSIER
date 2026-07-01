// Probe (ambientCG Live-Browse): öffnet den Material-Picker, wechselt in den
// Modus „Bibliothek durchsuchen", sucht „wood", zeigt die Live-Treffer mit
// Thumbnails, wählt ein Material (lädt die Maps über den Proxy + entpackt), und
// beweist die texturierte Wand im 3D-Modus „Texturiert".
//
// Aufruf: PROBE_URL=http://localhost:5187/ node scripts/probe-ambientcg.mjs
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
}

await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 20000 });
await page.waitForSelector(".topbar", { timeout: 20000 });
await sleep(600);

// 1) Ressourcen öffnen → Bauteile (Default) → Material-Picker öffnen.
const resBtn = await page.$('button[aria-label="Ressourcen"]');
if (!resBtn) throw new Error("Ressourcen-Button nicht gefunden");
await resBtn.click();
await sleep(400);
await page.waitForSelector(".res-material-btn", { timeout: 8000 });
const matBtns = await page.$$(".res-material-btn");
await matBtns[0].click();
await page.waitForSelector(".mat-dialog", { timeout: 8000 });

// 2) In den Modus „Bibliothek durchsuchen" wechseln.
await clickByText(".mat-mode-btn", "Bibliothek durchsuchen");
await page.waitForSelector(".mat-browse", { timeout: 8000 });
await sleep(500);

// 3) Nach „wood" suchen.
await page.type(".mat-search", "wood");
await clickByText(".mat-browse-bar .res-add", "Suchen");
// Auf Live-Treffer warten (Kacheln im Browse-Grid).
await page.waitForSelector(".mat-browse-grid .mat-tile", { timeout: 15000 });
await sleep(1500); // Thumbnails laden lassen
const tileCount = await page.$$eval(".mat-browse-grid .mat-tile", (els) => els.length);
console.log("Live-Treffer (wood):", tileCount);
await shot("probe-ambientcg-1-browse.png");

// 4) Erstes Ergebnis wählen → lädt Maps über Proxy + entpackt + weist zu.
const firstTile = await page.$(".mat-browse-grid .mat-tile");
await firstTile.click();
// Warten, bis Dialog schließt (Download fertig → onAssign → onClose).
await page.waitForSelector(".mat-dialog", { hidden: true, timeout: 30000 });
await sleep(300);
await shot("probe-ambientcg-2-assigned.png");

// 5) Ressourcen schließen, in die Perspektive wechseln, „Texturiert".
async function closeResources() {
  const closeBtn = await page.$(".res-drawer .res-close");
  if (closeBtn) {
    await closeBtn.click();
    await page.waitForSelector(".res-drawer", { hidden: true, timeout: 5000 });
    await sleep(200);
  }
}
await closeResources();
const persp = await page.$('button[aria-label="Perspektive"]');
if (persp) await persp.click();
await sleep(1200);

async function setStyle(label) {
  const trigger = await page.$('button.tb-dd-trigger[title*="Darstellungsart der"]');
  if (!trigger) throw new Error("Darstellung-Dropdown nicht gefunden");
  await trigger.click();
  await page.waitForSelector("button.tb-dd-item", { timeout: 4000 });
  await sleep(150);
  await clickByText("button.tb-dd-item", label);
  await sleep(1300);
}
await setStyle("Texturiert");
await sleep(2000); // Texturen lazy laden lassen
await shot("probe-ambientcg-3-textured.png");

console.log("--- console (letzte 30) ---");
for (const l of logs.slice(-30)) console.log(l);

await browser.close();
console.log("done");
