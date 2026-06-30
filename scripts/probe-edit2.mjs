import puppeteer from "puppeteer";
const URL = process.env.PROBE_URL || "http://localhost:5173/";
const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--use-gl=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage();
await page.setViewport({ width: 1200, height: 800, deviceScaleFactor: 2 });
const logs = [];
page.on("pageerror", (e) => logs.push(`[PAGEERROR] ${e.message}`));
try { await page.goto(URL, { waitUntil: "networkidle0", timeout: 20000 }); } catch (e) { logs.push(`[GOTO] ${e.message}`); }
await new Promise((r) => setTimeout(r, 600));
const clickTool = (label) => page.evaluate((l) => [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === l)?.click(), label);
const click = async (x, y, opts) => { await page.mouse.move(x, y); await page.mouse.click(x, y, opts); await new Promise((r) => setTimeout(r, 60)); };
const box = await page.evaluate(() => { const r = document.querySelector(".plan-svg").getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
const cx = box.x + box.w / 2, cy = box.y + box.h / 2;

// ── 1) Aktive Ebene auf "60 Plangrafik" (#c0a040) setzen, Linie zeichnen ──
await page.evaluate(() => {
  const sel = [...document.querySelectorAll("select")].find((s) => [...s.options].some((o) => o.value === "60"));
  if (sel) sel.id = "ebene-test";
});
await page.select("#ebene-test", "60");
await new Promise((r) => setTimeout(r, 100));
await clickTool("Linie");
await new Promise((r) => setTimeout(r, 80));
await click(cx - 150, cy - 120); await click(cx + 120, cy - 60);
await clickTool("Auswahl");
await new Promise((r) => setTimeout(r, 80));
const lineColor = await page.evaluate(() => document.querySelector(".plan-svg line.draw2d")?.getAttribute("stroke"));

// ── 2) Parallel verschieben: Linie selektieren, Körper greifen + ziehen ──
const mid = [(cx - 150 + cx + 120) / 2, (cy - 120 + cy - 60) / 2];
await click(mid[0], mid[1]); // selektieren
const before = await page.evaluate(() => { const l = document.querySelector(".plan-svg line.draw2d"); return { x1: +l.getAttribute("x1"), y1: +l.getAttribute("y1") }; });
await page.mouse.move(mid[0], mid[1]); await page.mouse.down();
await page.mouse.move(mid[0] + 60, mid[1] + 120, { steps: 6 }); await page.mouse.up();
await new Promise((r) => setTimeout(r, 100));
const after = await page.evaluate(() => { const l = document.querySelector(".plan-svg line.draw2d"); return { x1: +l.getAttribute("x1"), y1: +l.getAttribute("y1") }; });
const moved = Math.hypot(after.x1 - before.x1, after.y1 - before.y1) > 5;

// ── 3) Shift-Ortho: Endpunkt-Griff mit Shift ziehen → achsparallel ──
// Neue Linie zeichnen.
await clickTool("Linie");
await new Promise((r) => setTimeout(r, 60));
const a = [cx - 180, cy + 90], b = [cx - 40, cy + 140];
await click(...a); await click(...b);
await clickTool("Auswahl");
await new Promise((r) => setTimeout(r, 60));
await click((a[0] + b[0]) / 2, (a[1] + b[1]) / 2); // selektieren
// Endpunkt b mit Shift senkrecht-ish wegziehen → sollte exakt H oder V werden.
await page.keyboard.down("Shift");
await page.mouse.move(b[0], b[1]); await page.mouse.down();
await page.mouse.move(b[0] + 140, b[1] + 20, { steps: 8 }); // fast horizontal
await page.mouse.up();
await page.keyboard.up("Shift");
await new Promise((r) => setTimeout(r, 100));
// Die gerade bearbeitete Linie ist die ZWEITE draw2d-Linie.
const orthoLine = await page.evaluate(() => {
  const ls = document.querySelectorAll(".plan-svg line.draw2d");
  const l = ls[ls.length - 1];
  return { x1: +l.getAttribute("x1"), y1: +l.getAttribute("y1"), x2: +l.getAttribute("x2"), y2: +l.getAttribute("y2") };
});
const dx = Math.abs(orthoLine.x2 - orthoLine.x1), dy = Math.abs(orthoLine.y2 - orthoLine.y1);
const isOrtho = dx < 1 || dy < 1; // exakt H oder V

await page.screenshot({ path: "scripts/probe-edit2.png" });
console.log("lineColor:", lineColor, "(expect #c0a040)");
console.log("parallelMoved:", moved);
console.log("shiftOrtho dx,dy:", dx.toFixed(2), dy.toFixed(2), "isOrtho:", isOrtho);
console.log(logs.length ? logs.join("\n") : "(no errors)");
await browser.close();
