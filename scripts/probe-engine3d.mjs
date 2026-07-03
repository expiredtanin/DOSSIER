// Probe: belegt den nativen render3d-Renderer als WASM/WebGPU-Viewport in der
// 3D-Ansicht (`?engine=wasm`, siehe src/viewport/Wasm3DViewport.tsx).
//
// Ablauf: App mit ?engine=wasm laden, in die Perspektive wechseln (Ansichts-
// Icon-Grid der Oberleiste), auf die Engine-Initialisierung warten, Screenshot
// scripts/probe-engine3d.png schiessen und dann PRÜFEN, dass das Engine-Canvas
// (canvas[data-engine="render3d"]) vorhanden ist UND Geometrie zeigt.
//
// PIXEL-SAMPLING über den Screenshot (nicht drawImage): ein WebGPU-Canvas
// liefert nach dem Present über drawImage/getImageData nur transparente Pixel
// (der Frame ist bereits verbraucht). Der CDP-Screenshot enthält dagegen die
// komposittierte Ausgabe — er wird als Data-URL zurück in die Seite geladen und
// im Rechteck des Engine-Canvas gegen die Löschfarbe (#f5f5f5) ausgezählt.
//
// WebGPU liegt in Chromium/Linux hinter Flags (siehe scripts/chromium-shell.sh):
// --enable-unsafe-webgpu --enable-features=Vulkan. HEADLESS initialisiert die
// API zwar (Adapter/Device ok, Init-Logs erscheinen), PRÄSENTIERT aber keine
// Frames — das gilt genauso für den etablierten render2d-Viewport (gegen-
// geprüft). Verlässlich verifiziert daher nur headful:
//   HEADFUL=1 [CHROMIUM_BIN=/usr/bin/chromium] node scripts/probe-engine3d.mjs

import puppeteer from "puppeteer";

const BASE = process.env.PROBE_URL || "http://localhost:5187/";
const URL = BASE.replace(/\/?$/, "/") + "?engine=wasm";
const HEADFUL = !!process.env.HEADFUL;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  headless: HEADFUL ? false : "new",
  // Headful: das System-Chromium nutzen (Puppeteers gebündeltes Chrome kommt
  // mit der Wayland/niri-Session hier nicht hoch).
  executablePath: HEADFUL ? process.env.CHROMIUM_BIN || "/usr/bin/chromium" : undefined,
  args: ["--no-sandbox", "--enable-unsafe-webgpu", "--enable-features=Vulkan"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });

const logs = [];
page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => logs.push(`[PAGEERROR] ${e.message}`));

await page.goto(URL, { waitUntil: "networkidle0", timeout: 25000 });
const hasGpu = await page.evaluate(() => "gpu" in navigator);

// In die Perspektive wechseln: die 3D-Blicke im Ansichts-Icon-Grid tragen ihr
// Label als aria-label (TopBar.tsx).
const clicked = await page.evaluate(() => {
  const btn = document.querySelector('button.view-icon[aria-label="Perspektive"]');
  if (!btn) return false;
  btn.click();
  return true;
});

// Engine-Init (WASM-Load + Adapter/Device) + erster Frame brauchen einen Moment.
await wait(3500);

// Position/Größe des Engine-Canvas im Viewport (CSS-Pixel, dsf=1).
const rect = await page.evaluate(() => {
  const c = document.querySelector('canvas[data-engine="render3d"]');
  if (!c) return null;
  const r = c.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
});

await page.screenshot({ path: "scripts/probe-engine3d.png" });

let verdict = { present: !!rect };
if (rect && rect.w > 4 && rect.h > 4) {
  // Screenshot zurück in die Seite laden und im Canvas-Rechteck auszählen.
  const b64 = await page.screenshot({ encoding: "base64" });
  verdict = await page.evaluate(
    async (b64Png, r) => {
      const img = new Image();
      img.src = "data:image/png;base64," + b64Png;
      await img.decode();
      const s = document.createElement("canvas");
      s.width = img.width;
      s.height = img.height;
      const ctx = s.getContext("2d");
      ctx.drawImage(img, 0, 0);
      const d = ctx.getImageData(
        Math.round(r.x),
        Math.round(r.y),
        Math.round(r.w),
        Math.round(r.h),
      ).data;
      let nonBackground = 0;
      const total = d.length / 4;
      for (let i = 0; i < d.length; i += 4) {
        if (
          Math.abs(d[i] - 245) > 12 ||
          Math.abs(d[i + 1] - 245) > 12 ||
          Math.abs(d[i + 2] - 245) > 12
        ) {
          nonBackground++;
        }
      }
      return { present: true, rect: r, total, nonBackground };
    },
    b64,
    rect,
  );
}

console.log(`URL: ${URL}`);
console.log("navigator.gpu:", hasGpu, "| Perspektive-Button:", clicked);
console.log(JSON.stringify(verdict, null, 2));
const relevant = logs.filter((l) => /render3d|render2d|webgpu|wasm|error|warn/i.test(l));
console.log("Logs:", relevant.length ? "\n" + relevant.join("\n") : "(keine)");

await browser.close();

// Erfolg: Canvas vorhanden und deutlich mehr als nur die Löschfarbe sichtbar
// (>3 % der Pixel abseits von #f5f5f5 — das Gebäude deckt real ~40 % ab; das
// Ansichts-Badge allein läge unter 1 %).
const ok = verdict.present && (verdict.nonBackground ?? 0) > (verdict.total ?? 1) * 0.03;
if (ok) {
  console.log(
    `\nOK: Engine-Canvas zeigt Geometrie (${verdict.nonBackground}/${verdict.total} Pixel abseits der Löschfarbe). Screenshot: scripts/probe-engine3d.png`,
  );
} else {
  console.error(
    `\nFEHLSCHLAG: Engine-Canvas ${verdict.present ? "ohne sichtbare Geometrie" : "fehlt"} (navigator.gpu=${hasGpu}). ` +
      "Headless präsentiert keine WebGPU-Frames — mit HEADFUL=1 erneut ausführen.",
  );
  process.exit(1);
}
