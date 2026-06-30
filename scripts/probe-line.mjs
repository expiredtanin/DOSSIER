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
await new Promise((r) => setTimeout(r, 600));
await page.evaluate(() => [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "Linie")?.click());
await new Promise((r) => setTimeout(r, 150));
const box = await page.evaluate(() => { const r = document.querySelector(".plan-svg").getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
// Zwei-Klick-Strecke quer durch den Raum.
for (const [x, y] of [[cx - 200, cy - 40], [cx + 200, cy + 90]]) {
  await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.up();
  await new Promise((r) => setTimeout(r, 100));
}
await page.evaluate(() => [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "Auswahl")?.click());
await new Promise((r) => setTimeout(r, 200));
const draw2d = await page.evaluate(() => document.querySelectorAll(".plan-svg line.draw2d").length);
await page.screenshot({ path: "scripts/probe-line.png" });
console.log("draw2d lines:", draw2d);
console.log(logs.length ? logs.join("\n") : "(no errors)");
await browser.close();
