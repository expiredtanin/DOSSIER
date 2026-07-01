// Vergleicht den GPU-(WebGL2-)Plan-Renderer gegen den SVG-Renderer.
// Lädt zweimal: einmal mit ?gl=1 (GPU), einmal ohne (SVG), und schießt je einen
// Screenshot. Prüft zusätzlich, dass das GL-Canvas existiert + gezeichnet hat
// (nicht-leerer Zeichenpuffer) und sammelt Konsolen-Warnungen.

import puppeteer from "puppeteer";

const BASE = process.env.PROBE_URL || "http://localhost:5187/";

const browser = await puppeteer.launch({
  headless: "new",
  args: ["--no-sandbox", "--use-gl=swiftshader", "--enable-unsafe-swiftshader"],
});

async function shoot(url, path, tag) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 2 });
  const logs = [];
  page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
  page.on("pageerror", (e) => logs.push(`[PAGEERROR] ${e.message}`));
  try {
    await page.goto(url, { waitUntil: "networkidle0", timeout: 25000 });
  } catch (e) {
    logs.push(`[GOTO] ${e.message}`);
  }
  // Kurz warten, bis der Plan + evtl. GL gezeichnet ist.
  await new Promise((r) => setTimeout(r, 1500));

  const info = await page.evaluate(() => {
    const svg = document.querySelector(".plan-svg");
    const canvas = document.querySelector(".plan-svg")
      ? document.querySelector("canvas")
      : null;
    // Irgendein <canvas> im Plan-Container?
    const planCanvas = document.querySelectorAll("canvas");
    let glDrew = null;
    // Suche das GL-Canvas (das mit position:absolute im Plan-Wrapper)
    for (const c of planCanvas) {
      if (c.width > 0 && c.height > 0) {
        try {
          const gl = c.getContext("webgl2");
          if (gl) {
            const px = new Uint8Array(4);
            gl.readPixels(
              Math.floor(c.width / 2),
              Math.floor(c.height / 2),
              1,
              1,
              gl.RGBA,
              gl.UNSIGNED_BYTE,
              px,
            );
            glDrew = { size: `${c.width}x${c.height}`, centerPx: [...px] };
            break;
          }
        } catch {
          /* readPixels nach Präsentation evtl. leer — egal */
        }
      }
    }
    return {
      hasSvg: !!svg,
      svgPaths: svg ? svg.querySelectorAll("path,polygon,polyline,line,rect").length : 0,
      canvasCount: planCanvas.length,
      glDrew,
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

await shoot(BASE, "scripts/probe-gl-plan-svg.png", "SVG-Renderer");
await shoot(BASE + "?gl=1", "scripts/probe-gl-plan-gpu.png", "GPU-Renderer");

await browser.close();
console.log("\nScreenshots: scripts/probe-gl-plan-svg.png  vs  scripts/probe-gl-plan-gpu.png");
