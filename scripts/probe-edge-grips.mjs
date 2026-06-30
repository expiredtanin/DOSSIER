import puppeteer from "puppeteer";
const URL = process.env.PROBE_URL || "http://localhost:5173/";
const browser = await puppeteer.launch({
  headless: "new",
  args: ["--no-sandbox", "--use-gl=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1200, height: 800, deviceScaleFactor: 2 });
const logs = [];
page.on("pageerror", (e) => logs.push(`[PAGEERROR] ${e.message}`));
try { await page.goto(URL, { waitUntil: "networkidle0", timeout: 20000 }); } catch (e) { logs.push(`[GOTO] ${e.message}`); }
await new Promise((r) => setTimeout(r, 700));

const click = async (x, y) => { await page.mouse.move(x, y); await page.mouse.click(x, y); await new Promise((r) => setTimeout(r, 100)); };
const box = await page.evaluate(() => { const r = document.querySelector(".plan-svg").getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });

// 1) Auswahl-Werkzeug ist Default: die OBERE Wand des Beispiel-Raums anklicken
//    → Eckpunkt-Griffe (Quadrate) + 1 dreieckiger Kanten-Anfasser erscheinen.
const tx = box.x + box.w * 0.5;
const ty = box.y + box.h * 0.26; // mittig auf das obere Wandband
await click(tx, ty);
const c1 = await page.evaluate(() => ({
  grips: document.querySelectorAll(".plan-svg .plan-grip").length,
  edges: document.querySelectorAll(".plan-svg .plan-edge-grip").length,
}));
await page.screenshot({ path: "scripts/probe-edge-grips-selected.png" });

// 2) Den Kanten-Anfasser (sitzt etwas OBERHALB der Kante, da Außennormale nach
//    oben zeigt) nach OBEN ziehen → die ganze Wand verschiebt sich senkrecht.
const handleX = tx;
const handleY = ty - 13; // EDGE_GRIP_OFFSET_PX nach außen (oben)
await page.mouse.move(handleX, handleY);
await page.mouse.down();
await page.mouse.move(handleX, handleY - 100, { steps: 10 });
await page.mouse.up();
await new Promise((r) => setTimeout(r, 200));
const c2 = await page.evaluate(() => ({
  grips: document.querySelectorAll(".plan-svg .plan-grip").length,
  edges: document.querySelectorAll(".plan-svg .plan-edge-grip").length,
}));
await page.screenshot({ path: "scripts/probe-edge-grips-dragged.png" });

console.log("after select:", JSON.stringify(c1));
console.log("after drag:", JSON.stringify(c2));
console.log(logs.length ? logs.join("\n") : "(no errors)");
await browser.close();
