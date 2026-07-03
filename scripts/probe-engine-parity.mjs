// Vergleicht den SVG-Referenzpfad gegen den nativen render2d-WASM/WebGPU-Pfad
// (?engine=wasm): lädt die App einmal ohne Engine-Param (SVG) und einmal mit
// ?engine=wasm, gleicher Viewport/Zoom, schießt je einen Screenshot. Prüft
// zusätzlich, ob WebGPU verfügbar ist und der native Renderer tatsächlich
// initialisiert hat (statt still auf SVG zurückzufallen).

import puppeteer from "puppeteer";

const BASE = process.env.PROBE_URL || "http://localhost:5187/";

const browser = await puppeteer.launch({
  headless: "new",
  args: [
    "--no-sandbox",
    "--enable-unsafe-webgpu",
    "--enable-features=Vulkan",
    "--use-angle=vulkan",
    "--ignore-gpu-blocklist",
  ],
});

async function shoot(url, path, tag) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
  const logs = [];
  page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
  page.on("pageerror", (e) => logs.push(`[PAGEERROR] ${e.message}`));
  try {
    await page.goto(url, { waitUntil: "networkidle0", timeout: 30000 });
  } catch (e) {
    logs.push(`[GOTO] ${e.message}`);
  }
  // Warten, bis Plan + evtl. WASM/WebGPU-Renderer initialisiert und gezeichnet hat.
  await new Promise((r) => setTimeout(r, 2500));

  const info = await page.evaluate(() => {
    const svg = document.querySelector(".plan-svg");
    const canvases = document.querySelectorAll("canvas");
    return {
      hasGpu: typeof navigator !== "undefined" && "gpu" in navigator,
      hasSvg: !!svg,
      svgChildren: svg ? svg.querySelectorAll("path,polygon,polyline,line,rect,text").length : 0,
      canvasCount: canvases.length,
    };
  });

  await page.screenshot({ path });
  console.log(`\n=== ${tag} (${url}) ===`);
  console.log(JSON.stringify(info, null, 2));
  const warns = logs.filter((l) => /warn|error|PAGEERROR/i.test(l));
  console.log("Warnungen/Fehler:", warns.length ? "\n" + warns.join("\n") : "(keine)");
  await page.close();
  return info;
}

await shoot(BASE + "?gl=0", "scripts/probe-parity-svg.png", "SVG-Referenzpfad");
await shoot(BASE + "?engine=wasm", "scripts/probe-parity-wasm.png", "WASM/WebGPU-Engine");

await browser.close();
console.log("\nScreenshots: scripts/probe-parity-svg.png  vs  scripts/probe-parity-wasm.png");
