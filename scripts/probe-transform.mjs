import puppeteer from "puppeteer";
const URL = process.env.PROBE_URL || "http://localhost:5173/";
const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--use-gl=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage();
await page.setViewport({ width: 1200, height: 800, deviceScaleFactor: 2 });
const logs = [];
page.on("pageerror", (e) => logs.push(`[PAGEERROR] ${e.message}`));
page.on("dialog", async (d) => { await d.accept("3"); }); // Kopienanzahl-Prompt → 3
try { await page.goto(URL, { waitUntil: "networkidle0", timeout: 20000 }); } catch (e) { logs.push(`[GOTO] ${e.message}`); }
await new Promise((r) => setTimeout(r, 600));
const clickTool = (l) => page.evaluate((x) => [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === x)?.click(), l);
const click = async (x, y) => { await page.mouse.move(x, y); await page.mouse.click(x, y); await new Promise((r) => setTimeout(r, 60)); };
const nLines = () => page.evaluate(() => document.querySelectorAll(".plan-svg line.draw2d").length);
const box = await page.evaluate(() => { const r = document.querySelector(".plan-svg").getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
const cx = box.x + box.w / 2, cy = box.y + box.h / 2;

// Eine Linie zeichnen + selektieren.
await clickTool("Linie"); await new Promise((r) => setTimeout(r, 80));
const A = [cx - 160, cy - 120], B = [cx - 40, cy - 120];
await click(...A); await click(...B);
await clickTool("Auswahl"); await new Promise((r) => setTimeout(r, 60));
await click((A[0] + B[0]) / 2, A[1]); // selektieren
const n0 = await nLines();

// ── Modusleiste: 'm' drücken → Bar erscheint (Screenshot) ──
await page.keyboard.press("m");
await new Promise((r) => setTimeout(r, 120));
const barVisible = await page.evaluate(() => !!document.querySelector(".transform-bar"));
await page.screenshot({ path: "scripts/probe-transform-bar.png" });

// ── Move (U, default): Basispunkt → Ziel ──
await click(A[0], A[1]); // Basispunkt
await click(A[0] + 80, A[1] + 140); // Ziel
await new Promise((r) => setTimeout(r, 120));
const nMove = await nLines();
const movedPos = await page.evaluate(() => { const l = document.querySelector(".plan-svg line.draw2d"); return +l.getAttribute("y1"); });

// ── Copy (I): m, i, base, dest → +1 ──
await click((A[0] + B[0]) / 2 + 80, A[1] + 140); // selektieren (verschobene Linie)
await page.keyboard.press("m");
await page.keyboard.press("i");
await new Promise((r) => setTimeout(r, 60));
await click(cx, cy); await click(cx + 100, cy + 40);
await new Promise((r) => setTimeout(r, 120));
const nCopy = await nLines();

// ── Array (O=3): select a line, m, o(→3), base, dest → +3 ──
await click(cx + 50, cy + 20); // selektieren (eine der Linien)
await page.keyboard.press("m");
await page.keyboard.press("o");
await new Promise((r) => setTimeout(r, 150));
await click(cx - 50, cy + 120); await click(cx - 20, cy + 150);
await new Promise((r) => setTimeout(r, 150));
const nArray = await nLines();

await page.screenshot({ path: "scripts/probe-transform.png" });
console.log("n0(initial):", n0, "barVisible:", barVisible);
console.log("nMove(expect ==n0):", nMove, "movedY:", movedPos);
console.log("nCopy(expect n0+1):", nCopy);
console.log("nArray(expect nCopy+3):", nArray);
console.log(logs.length ? logs.join("\n") : "(no errors)");
await browser.close();
