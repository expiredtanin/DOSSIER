import { firefox } from "playwright";
const browser = await firefox.launch({ firefoxUserPrefs: { "webgl.disabled": true } });
const page = await browser.newPage({ viewport: { width: 1200, height: 760 } });
const logs = [];
page.on("pageerror", (e) => logs.push(`[PAGEERROR] ${e.message}`));
await page.goto("http://localhost:5173/", { waitUntil: "networkidle", timeout: 20000 });
await page.waitForTimeout(1200);
const info = await page.evaluate(() => ({
  rootLen: document.getElementById("root")?.innerHTML.length ?? -1,
  hasFallback: !!document.querySelector(".viewport-fallback"),
  hasPlanSvg: !!document.querySelector(".plan-svg polygon"),
  header: document.querySelector(".brand")?.textContent?.trim().slice(0, 20),
}));
await page.screenshot({ path: "scripts/probe-ff-verify.png" });
console.log("=== Firefox OHNE WebGL — nach Fix ===");
console.log("root innerHTML Länge:", info.rootLen, info.rootLen > 0 ? "✅ nicht weiß" : "❌ weiß");
console.log("Fallback-Meldung sichtbar:", info.hasFallback ? "✅" : "❌");
console.log("Grundriss-SVG gerendert:", info.hasPlanSvg ? "✅" : "❌");
console.log("Header:", JSON.stringify(info.header));
console.log("PageErrors:", logs.length ? logs.join("\n") : "✅ keine");
await browser.close();
