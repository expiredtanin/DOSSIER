import puppeteer from "puppeteer";

const URL = process.env.PROBE_URL || "http://localhost:5173/";
const browser = await puppeteer.launch({
  headless: "new",
  args: ["--no-sandbox", "--use-gl=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage();
// HiDPI simulieren — das ist die Bedingung, die die Schleife auslöste.
await page.setViewport({ width: 1200, height: 800, deviceScaleFactor: 2 });

const logs = [];
page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => logs.push(`[PAGEERROR] ${e.message}`));

try {
  await page.goto(URL, { waitUntil: "networkidle0", timeout: 20000 });
} catch (e) {
  logs.push(`[GOTO-ERROR] ${e.message}`);
}

const measure = () =>
  page.evaluate(() => {
    const c = document.querySelector(".viewport canvas");
    const v = document.querySelector(".viewport");
    const r = c?.getBoundingClientRect();
    return {
      canvasCss: r ? `${Math.round(r.width)}x${Math.round(r.height)}` : "none",
      canvasBuffer: c ? `${c.width}x${c.height}` : "none",
      viewport: v ? `${Math.round(v.clientWidth)}x${Math.round(v.clientHeight)}` : "none",
      bodyScrollH: document.body.scrollHeight,
    };
  });

const m1 = await measure();
await new Promise((r) => setTimeout(r, 1200));
const m2 = await measure();

await page.screenshot({ path: "scripts/probe.png" });

const stable = JSON.stringify(m1) === JSON.stringify(m2);
console.log("=== Messung 1 ===", JSON.stringify(m1));
console.log("=== Messung 2 ===", JSON.stringify(m2));
console.log(stable ? "✅ STABIL — keine Schleife" : "❌ INSTABIL — wächst/schrumpft noch");
console.log("\n=== Logs ===");
console.log(logs.length ? logs.join("\n") : "(keine)");
await browser.close();
