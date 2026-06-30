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
const click = async (x, y, opts) => { await page.mouse.move(x, y); await page.mouse.click(x, y, opts); await new Promise((r) => setTimeout(r, 80)); };
const box = await page.evaluate(() => { const r = document.querySelector(".plan-svg").getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
const cx = box.x + box.w / 2, cy = box.y + box.h / 2;

// 1) Eine Wand zeichnen (A→B), Rechtsklick beendet.
await clickTool("Wand");
await new Promise((r) => setTimeout(r, 120));
const A = [cx - 160, cy - 150], B = [cx + 160, cy - 150];
await click(...A); await click(...B);
await page.mouse.click(B[0], B[1], { button: "right" });
await new Promise((r) => setTimeout(r, 150));

// 2) Auswahl-Werkzeug, Wand in der Mitte anklicken → Griffe erscheinen.
await clickTool("Auswahl");
await new Promise((r) => setTimeout(r, 120));
await click(cx, cy - 150);
const gripsAfterSelect = await page.evaluate(() => document.querySelectorAll(".plan-svg .plan-grip").length);
await page.screenshot({ path: "scripts/probe-grips-selected.png" });

// 3) Den End-Griff bei B nach unten ziehen.
await page.mouse.move(B[0], B[1]);
await page.mouse.down();
await page.mouse.move(B[0], B[1] + 90, { steps: 6 });
await page.mouse.move(B[0] - 30, B[1] + 130, { steps: 6 });
await page.mouse.up();
await new Promise((r) => setTimeout(r, 150));
await page.screenshot({ path: "scripts/probe-grips-dragged.png" });

// 4) Eine Linie zeichnen, auswählen, Endpunkt-Griff prüfen.
await clickTool("Linie");
await new Promise((r) => setTimeout(r, 100));
const L1 = [cx - 180, cy + 120], L2 = [cx + 150, cy + 160];
await click(...L1); await click(...L2);
await clickTool("Auswahl");
await new Promise((r) => setTimeout(r, 100));
// Mittig auf die Linie klicken (Mittelpunkt der beiden Endpunkte).
await click((L1[0] + L2[0]) / 2, (L1[1] + L2[1]) / 2);
const gripsLine = await page.evaluate(() => document.querySelectorAll(".plan-svg .plan-grip").length);
await page.screenshot({ path: "scripts/probe-grips-line.png" });

// 5) Linie löschen (Entf).
await page.keyboard.press("Delete");
await new Promise((r) => setTimeout(r, 120));
const draw2dAfterDelete = await page.evaluate(() => document.querySelectorAll(".plan-svg line.draw2d").length);

console.log("gripsAfterSelect:", gripsAfterSelect);
console.log("gripsLine:", gripsLine);
console.log("draw2dAfterDelete:", draw2dAfterDelete);
console.log(logs.length ? logs.join("\n") : "(no errors)");
await browser.close();
