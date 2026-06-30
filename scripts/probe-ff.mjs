import { firefox } from "playwright";

const URL = process.env.PROBE_URL || "http://localhost:5173/";
const browser = await firefox.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: 2 });

const logs = [];
page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => logs.push(`[PAGEERROR] ${e.message}\n${e.stack || ""}`));
page.on("requestfailed", (r) =>
  logs.push(`[REQFAIL] ${r.url()} :: ${r.failure()?.errorText}`),
);

try {
  await page.goto(URL, { waitUntil: "networkidle", timeout: 20000 });
} catch (e) {
  logs.push(`[GOTO-ERROR] ${e.message}`);
}
await page.waitForTimeout(1500);

const rootHtml = await page.evaluate(() => {
  const r = document.getElementById("root");
  return r ? r.innerHTML.slice(0, 300) : "NO #root";
});

await page.screenshot({ path: "scripts/probe-ff.png" });
console.log("=== FIREFOX CONSOLE / ERRORS ===");
console.log(logs.length ? logs.join("\n") : "(keine Logs)");
console.log("\n=== #root innerHTML (erste 300 Zeichen) ===");
console.log(rootHtml);
await browser.close();
