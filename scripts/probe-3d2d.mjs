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
 page.on("console", (m) => { if (m.text().includes("DBG")) logs.push(m.text()); });
try { await page.goto(URL, { waitUntil: "networkidle0", timeout: 20000 }); } catch (e) { logs.push(`[GOTO] ${e.message}`); }
await new Promise((r) => setTimeout(r, 600));
const clickTool = (label) => page.evaluate((l) => [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === l)?.click(), label);
const click = async (x, y) => { await page.mouse.move(x, y); await page.mouse.click(x, y); await new Promise((r) => setTimeout(r, 60)); };
const box = await page.evaluate(() => { const r = document.querySelector(".plan-svg").getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
const cx = box.x + box.w / 2, cy = box.y + box.h / 2;

// Ein kleines Linien-Raster in den Raum zeichnen (3 horizontale + 3 vertikale).
await clickTool("Linie");
await new Promise((r) => setTimeout(r, 100));
const L = box.x + box.w * 0.34, Rr = box.x + box.w * 0.66;
const T = box.y + box.h * 0.42, Bb = box.y + box.h * 0.72;
for (let i = 0; i <= 2; i++) {
  const y = T + ((Bb - T) * i) / 2;
  await click(L, y); await click(Rr, y);
}
for (let i = 0; i <= 2; i++) {
  const x = L + ((Rr - L) * i) / 2;
  await click(x, T); await click(x, Bb);
}
await clickTool("Auswahl");
await new Promise((r) => setTimeout(r, 100));
const draw2dPlan = await page.evaluate(() => document.querySelectorAll(".plan-svg line.draw2d").length);

// Obergeschoss ausblenden (Augen-Icon), damit der EG-Boden mit dem Raster oben
// offen sichtbar ist.
await page.evaluate(() => {
  let row = [...document.querySelectorAll("*")].find((e) => e.children.length === 0 && e.textContent.trim() === "Obergeschoss");
  while (row && !row.querySelector?.(".eye")) row = row.parentElement;
  row?.querySelector(".eye")?.click();
});
await new Promise((r) => setTimeout(r, 200));

// In die Perspektive wechseln und rendern lassen.
await clickTool("Perspektive");
await new Promise((r) => setTimeout(r, 1200));
await page.screenshot({ path: "scripts/probe-3d2d.png" });
console.log("draw2dPlan lines:", draw2dPlan);
console.log(logs.length ? logs.join("\n") : "(no errors)");
await browser.close();
