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

const clickTool = (label) =>
  page.evaluate((l) => [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === l)?.click(), label);
const svgBox = () => page.evaluate(() => { const r = document.querySelector(".plan-svg").getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
const clickAt = async (x, y) => { await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.up(); await new Promise((r) => setTimeout(r, 70)); };

const box = await svgBox();
const cx = box.x + box.w / 2, cy = box.y + box.h / 2;

// 1) Rechteck (zwei Ecken).
await clickTool("Rechteck");
await new Promise((r) => setTimeout(r, 120));
await clickAt(cx - 210, cy - 110);
await clickAt(cx - 40, cy + 40);

// 2) Polylinie (offen, 4 Punkte, Rechtsklick beendet).
await clickTool("Polylinie");
await new Promise((r) => setTimeout(r, 120));
const poly = [[cx + 40, cy - 100], [cx + 200, cy - 100], [cx + 200, cy + 30], [cx + 90, cy + 60]];
for (const [x, y] of poly) await clickAt(x, y);
await page.mouse.move(cx + 90, cy + 60);
await page.mouse.click(cx + 90, cy + 60, { button: "right" });
await new Promise((r) => setTimeout(r, 150));

// 3) Snap-Menü öffnen (Fang) und screenshoten.
await page.evaluate(() => {
  const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim().startsWith("Fang"));
  if (b) b.click();
});
await new Promise((r) => setTimeout(r, 150));
const popover = await page.evaluate(() => !!document.querySelector(".snap-popover"));
await page.screenshot({ path: "scripts/probe-phase2-snapmenu.png" });
// Menü schließen.
await page.keyboard.press("Escape");
await new Promise((r) => setTimeout(r, 100));

await clickTool("Auswahl");
await new Promise((r) => setTimeout(r, 150));
const counts = await page.evaluate(() => ({
  draw2dLines: document.querySelectorAll(".plan-svg line.draw2d").length,
}));
await page.screenshot({ path: "scripts/probe-phase2.png" });
console.log("popoverOpened:", popover);
console.log("counts:", JSON.stringify(counts));
console.log(logs.length ? logs.join("\n") : "(no errors)");
await browser.close();
