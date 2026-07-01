// Screenshot des Plans in LIGHT- vs DARK-Theme (prefers-color-scheme emuliert),
// um theme-abhängige Linien-/Textfarben aufzudecken. Default-App (SVG-Renderer).

import puppeteer from "puppeteer";
const BASE = process.env.PROBE_URL || "http://localhost:5187/";
const browser = await puppeteer.launch({
  headless: "new",
  args: ["--no-sandbox", "--use-gl=swiftshader", "--enable-unsafe-swiftshader"],
});

async function shoot(scheme, path) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 2 });
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: scheme }]);
  try {
    await page.goto(BASE, { waitUntil: "networkidle0", timeout: 25000 });
  } catch (e) {
    console.log(`[goto ${scheme}]`, e.message);
  }
  await new Promise((r) => setTimeout(r, 1200));
  const colors = await page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    return {
      sheet: cs.getPropertyValue("--sheet").trim(),
      ink: cs.getPropertyValue("--ink").trim(),
    };
  });
  await page.screenshot({ path });
  console.log(`${scheme}: --sheet=${colors.sheet} --ink=${colors.ink} → ${path}`);
  await page.close();
}

await shoot("light", "scripts/probe-theme-light.png");
await shoot("dark", "scripts/probe-theme-dark.png");
await browser.close();
