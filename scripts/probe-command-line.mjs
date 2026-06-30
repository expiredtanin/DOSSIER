// Probe für das Rhino-artige Befehlssystem (Tier 0 + Line).
// Treibt: Tab → „line"⏎ → „0,0"⏎ → „r3,0"⏎  und screenshotet das Ergebnis.
// Erwartung: eine deutlich DUNKLE 3-m-Linie im Plan + Command-Line zeigt Prompts.
//
// Headless Puppeteer (swiftshader für WebGL). Zweiter Lauf mit „3<45" prüft die
// polare Eingabe. Vorlage: scripts/probe-tools.mjs.

import puppeteer from "puppeteer";

const URL = process.env.PROBE_URL || "http://localhost:5173/";
const browser = await puppeteer.launch({
  headless: "new",
  args: ["--no-sandbox", "--use-gl=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1200, height: 800, deviceScaleFactor: 2 });
const logs = [];
page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => logs.push(`[PAGEERROR] ${e.message}`));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  await page.goto(URL, { waitUntil: "networkidle0", timeout: 20000 });
} catch (e) {
  logs.push(`[GOTO-ERROR] ${e.message}`);
}
await sleep(600);

// Zählt 2D-Zeichenlinien + liefert die computed stroke der ersten (Tinte-Check).
async function inkInfo() {
  return page.evaluate(() => {
    const lines = [...document.querySelectorAll(".plan-svg line.draw2d")];
    const first = lines[0];
    const stroke = first ? getComputedStyle(first).stroke : null;
    return { count: lines.length, stroke };
  });
}

// Tippt einen Befehl/Eine Zeile in die fokussierte Command-Line + Enter.
async function typeLine(text) {
  await page.type(".cmdline-input", text, { delay: 12 });
  await page.keyboard.press("Enter");
  await sleep(150);
}

// 1) Tab → Command-Line fokussieren (globaler Tab-Handler in App).
//    Erst in den Body klicken, damit Tab nicht von einem anderen Feld geschluckt wird.
await page.mouse.click(600, 400);
await sleep(80);
await page.keyboard.press("Tab");
await sleep(120);
const focused1 = await page.evaluate(
  () => document.activeElement?.className || "",
);

// 2) Befehl + zwei getippte Koordinaten. Startpunkt 1,7 liegt ÜBER dem Raum
//    (freies Papier), damit die 3-m-Linie eindeutig sichtbar ist (nicht von einer
//    Wandkante überdeckt). Verlangt: 1,7 ⏎  r3,0 ⏎  → 3-m-Linie nach rechts.
await typeLine("line");
const promptAfterLine = await page.evaluate(
  () => document.querySelector(".cmdline-prompt")?.textContent || "",
);
await typeLine("1,2");
const promptAfterStart = await page.evaluate(
  () => document.querySelector(".cmdline-prompt")?.textContent || "",
);
await typeLine("r3,0");
await sleep(200);

const ink1 = await inkInfo();
await page.screenshot({ path: "scripts/probe-command-line.png" });

// 3) Zweiter Lauf: polare Eingabe 3<45 (neue Linie ab Ursprung).
await page.mouse.click(600, 400);
await sleep(80);
await page.keyboard.press("Tab");
await sleep(120);
await typeLine("line");
await typeLine("1,1");
await typeLine("3<45");
await sleep(200);
const ink2 = await inkInfo();
await page.screenshot({ path: "scripts/probe-command-line-polar.png" });

console.log("focused after Tab:", focused1);
console.log("prompt after 'line':", JSON.stringify(promptAfterLine));
console.log("prompt after '0,0':", JSON.stringify(promptAfterStart));
console.log("ink (after 0,0 + r3,0):", JSON.stringify(ink1));
console.log("ink (after polar 3<45):", JSON.stringify(ink2));
console.log("=== Logs ===");
console.log(logs.length ? logs.join("\n") : "(keine)");
await browser.close();
