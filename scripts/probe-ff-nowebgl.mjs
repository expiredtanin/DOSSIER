import { firefox } from "playwright";
const browser = await firefox.launch({ firefoxUserPrefs: { "webgl.disabled": true } });
const page = await browser.newPage();
const logs = [];
page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => logs.push(`[PAGEERROR] ${e.message}`));
try { await page.goto("http://localhost:5173/", { waitUntil: "networkidle", timeout: 20000 }); }
catch (e) { logs.push(`[GOTO-ERROR] ${e.message}`); }
await page.waitForTimeout(1500);
const root = await page.evaluate(() => { const r = document.getElementById("root"); return r ? r.innerHTML.length : -1; });
console.log("=== mit WebGL DEAKTIVIERT ===");
console.log("#root innerHTML Länge:", root, root === 0 ? "→ KOMPLETT WEISS (reproduziert!)" : "");
console.log(logs.join("\n"));
await browser.close();
