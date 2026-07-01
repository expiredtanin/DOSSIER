// Probe: VEKTOR-PDF-Export des Grundrisses.
//  1) App öffnen (EG-Grundriss mit Beispielraum).
//  2) Export-Dialog über den PDF-Button öffnen, A4 / 1:100 wählen, exportieren.
//  3) Den Download (jsPDF blob) abfangen und ins Scratchpad speichern.
//  4) Vektor-Nachweis: Pfad-/Text-Operatoren > 0, KEIN Rasterbild für den Plan.
//  5) Massstab: bekannte Wandlänge (5 m bei 1:100 → 50 mm) im PDF nachmessen.
//  6) PDF → PNG rendern (pdfjs) für die visuelle Prüfung.

import puppeteer from "puppeteer";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const URL = process.env.PROBE_URL || "http://localhost:5187/";
const OUT = process.env.SCRATCH || "/tmp/pdf-probe";
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({
  headless: "new",
  args: ["--no-sandbox", "--use-gl=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
const logs = [];
page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => logs.push(`[PAGEERROR] ${e.message}`));

await page.goto(URL, { waitUntil: "networkidle0", timeout: 30000 });
await new Promise((r) => setTimeout(r, 600));

// jsPDF (v4) erzeugt das PDF als Blob und übergibt es an URL.createObjectURL,
// bevor es den Download auslöst. Wir überschreiben createObjectURL und lesen die
// Blob-Bytes (Base64) heraus — robust unabhängig vom Download-Mechanismus.
await page.evaluateOnNewDocument(() => {
  window.__pdfCaptured = null;
  const orig = URL.createObjectURL.bind(URL);
  URL.createObjectURL = function (obj) {
    try {
      if (obj instanceof Blob) {
        obj.arrayBuffer().then((buf) => {
          const u8 = new Uint8Array(buf);
          const head = String.fromCharCode.apply(null, u8.slice(0, 5));
          if (head === "%PDF-") {
            let bin = "";
            for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
            window.__pdfCaptured = { name: "grundriss.pdf", b64: btoa(bin) };
          }
        });
      }
    } catch (e) {
      /* ignore */
    }
    return orig(obj);
  };
});
// Neu laden, damit der Patch (evaluateOnNewDocument) greift.
await page.reload({ waitUntil: "networkidle0", timeout: 30000 });
await new Promise((r) => setTimeout(r, 600));

// Plan-Bounds + Beispiel-Wandlänge aus dem Store lesen (best effort, sonst aus
// dem bekannten Sample: W1 = (0,0)→(5,0) = 5 m).
const info = await page.evaluate(() => {
  const st = window.__store?.getState?.();
  const p = st?.project;
  if (!p) return null;
  const eg = p.walls.filter((w) => w.floorId === "eg");
  const w1 = eg.find((w) => w.id === "W1");
  const len = w1 ? Math.hypot(w1.end.x - w1.start.x, w1.end.y - w1.start.y) : null;
  return { wallCount: eg.length, w1Len: len };
});
console.log("Store:", JSON.stringify(info));

// PDF-Button in der Oberleiste klicken (Text „PDF"). Öffnet den Export-Dialog.
const clickedBtn = await page.evaluate(() => {
  const btns = Array.from(document.querySelectorAll(".tb-btn"));
  const b = btns.find((x) => x.textContent.trim() === "PDF");
  if (b) {
    b.click();
    return true;
  }
  return false;
});
console.log("PDF-Button geklickt?", clickedBtn);
await page.waitForSelector(".imp-dialog", { timeout: 5000 });
await new Promise((r) => setTimeout(r, 200));
await page.screenshot({ path: join(OUT, "export-dialog.png") });
console.log("Dialog-Screenshot:", join(OUT, "export-dialog.png"));

// A4 / 1:100 sind die Defaults (initialScale = scaleDenominator; A4 default).
// Sicherstellen: Massstab-Dropdown auf 1:100 stellen, falls nicht schon. Wir
// lesen den aktuellen Massstab aus dem Store und wählen sonst über die Dropdown-
// Option. Der Einfachheit halber verlassen wir uns auf den Default und prüfen N
// per gemessener Länge.
const exported = await page.evaluate(() => {
  const btns = Array.from(document.querySelectorAll(".imp-btn.primary"));
  const b = btns.find((x) => x.textContent.includes("Exportieren") || x.textContent.includes("Export"));
  if (b) {
    b.click();
    return true;
  }
  return false;
});
console.log("Exportieren geklickt?", exported);

// Auf den abgefangenen Blob warten.
let captured = null;
for (let i = 0; i < 60; i++) {
  captured = await page.evaluate(() => window.__pdfCaptured);
  if (captured) break;
  await new Promise((r) => setTimeout(r, 100));
}
if (!captured) {
  console.log("FEHLER: kein PDF abgefangen.");
  console.log(logs.join("\n"));
  await browser.close();
  process.exit(1);
}
const pdfBytes = Buffer.from(captured.b64, "base64");
const pdfPath = join(OUT, captured.name.endsWith(".pdf") ? captured.name : captured.name + ".pdf");
writeFileSync(pdfPath, pdfBytes);

// Visuelle Prüfung: das DRUCK-SVG (exakt die Vektor-Quelle des PDF) im Browser
// erzeugen und nach PNG rastern. Zeigt scharfe Linien, Schraffuren, weisses Blatt.
try {
  const svgPng = await page.evaluate(async () => {
    const gp = await import("/src/plan/generatePlan.ts");
    const sp = await import("/src/model/sampleProject.ts");
    const ptp = await import("/src/export/planToPrintSvg.ts");
    const proj = sp.sampleProject;
    const codes = new Set();
    const walk = (cs) =>
      cs.forEach((c) => {
        if (c.visible) {
          codes.add(c.code);
          if (c.children) walk(c.children);
        }
      });
    walk(proj.layers);
    const plan = gp.generatePlan(proj, "eg", codes, undefined, "mittel", false, false);
    const print = ptp.planToPrintSvg(plan, {
      scaleDenominator: 100,
      pageWidthMm: 297,
      pageHeightMm: 210,
      marginMm: 10,
    });
    const xml = new XMLSerializer().serializeToString(print.svg);
    const blob = new Blob([xml], { type: "image/svg+xml" });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    await new Promise((res, rej) => {
      img.onload = res;
      img.onerror = rej;
      img.src = url;
    });
    const scale = 4;
    const canvas = document.createElement("canvas");
    canvas.width = 297 * scale;
    canvas.height = 210 * scale;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/png");
  });
  const b64 = svgPng.split(",")[1];
  writeFileSync(join(OUT, "print-svg.png"), Buffer.from(b64, "base64"));
  console.log("Druck-SVG → PNG:", join(OUT, "print-svg.png"));
} catch (e) {
  console.log("(SVG-Render übersprungen:", e.message + ")");
}

console.log(`PDF gespeichert: ${pdfPath} (${pdfBytes.length} Bytes)`);

// ── Vektor-Nachweis per Byte-Inspektion (Streams entpacken via zlib) ──────────
const zlib = await import("node:zlib");
const raw = pdfBytes;
// Alle FlateDecode-Streams entpacken und die Operatoren zählen.
let allOps = "";
let imageXObjects = 0;
let dctImages = 0;
const text = raw.toString("latin1");
// /Subtype /Image und /DCTDecode global suchen (auch in Streams selten, aber
// im Dictionary sichtbar).
imageXObjects += (text.match(/\/Subtype\s*\/Image/g) || []).length;
dctImages += (text.match(/\/DCTDecode/g) || []).length;

const streamRe = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
let m;
while ((m = streamRe.exec(text)) !== null) {
  const chunk = Buffer.from(m[1], "latin1");
  let inflated = null;
  try {
    inflated = zlib.inflateSync(chunk).toString("latin1");
  } catch {
    try {
      inflated = zlib.inflateRawSync(chunk).toString("latin1");
    } catch {
      inflated = null;
    }
  }
  if (inflated) allOps += inflated + "\n";
}

// Pfad-Operatoren: m (moveto), l (lineto), c (curveto), re (rect), f/S (fill/stroke).
const countOp = (re) => (allOps.match(re) || []).length;
const moveTo = countOp(/(^|\s)m(\s|$)/gm);
const lineTo = countOp(/(^|\s)l(\s|$)/gm);
const curveTo = countOp(/(^|\s)c(\s|$)/gm);
const fillStroke = countOp(/(^|\s)(f|S|B|b|f\*)(\s|$)/gm);
const textShow = countOp(/(^|\s)(Tj|TJ)(\s|$)/gm);
const pathOps = moveTo + lineTo + curveTo;

console.log("\n=== VEKTOR-NACHWEIS ===");
console.log(`Pfad-Operatoren: moveto(m)=${moveTo} lineto(l)=${lineTo} curve(c)=${curveTo} fill/stroke=${fillStroke}`);
console.log(`Gesamt-Pfadbefehle: ${pathOps}`);
console.log(`Text-Operatoren (Tj/TJ): ${textShow}`);
console.log(`Bild-XObjects (/Subtype/Image): ${imageXObjects}`);
console.log(`DCT/JPEG-Bilder (/DCTDecode): ${dctImages}`);
const isVector = pathOps > 50 && imageXObjects === 0 && dctImages === 0;
console.log(`→ VEKTOR (Pfade > 0, kein Rasterbild)? ${isVector ? "JA" : "NEIN"}`);

// ── Massstab-Messung über pdfjs (Pfad-Koordinaten der gezeichneten Linien) ────
let scaleResult = "n/a";
try {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(pdfBytes) }).promise;
  const pg = await doc.getPage(1);
  const vp = pg.getViewport({ scale: 1 }); // Einheiten = PDF-Punkte (1pt=1/72 inch)
  const ptToMm = 25.4 / 72;
  const pageWpt = vp.width, pageHpt = vp.height;
  const ops = await pg.getOperatorList();
  const OPS = pdfjs.OPS;
  // Pro Pfad eine eigene BBox sammeln (jeder constructPath ist ein Sub-Pfad). So
  // können wir das seitenfüllende weisse Blatt + das Schriftfeld unten rechts
  // ausschließen und nur die PLAN-Geometrie messen.
  const boxes = [];
  for (let i = 0; i < ops.fnArray.length; i++) {
    if (ops.fnArray[i] !== OPS.constructPath) continue;
    const coords = ops.argsArray[i][1];
    let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
    for (let k = 0; k + 1 < coords.length; k += 2) {
      const x = coords[k], y = coords[k + 1];
      if (typeof x === "number" && typeof y === "number" && isFinite(x) && isFinite(y)) {
        if (x < bx0) bx0 = x; if (x > bx1) bx1 = x;
        if (y < by0) by0 = y; if (y > by1) by1 = y;
      }
    }
    if (isFinite(bx0)) boxes.push({ x0: bx0, y0: by0, x1: bx1, y1: by1 });
  }
  const pageWmm = pageWpt * ptToMm;
  const pageHmm = pageHpt * ptToMm;
  // svg2pdf zeichnet den Plan-Inhalt in mm-Benutzereinheiten (Koordinaten 0..297
  // bei A4-quer). Daneben gibt es einen äußeren Clip-Pfad in PDF-PUNKTEN
  // (Koordinaten bis ~842). Wir messen NUR den mm-Raum: Pfade, deren Koordinaten
  // komplett in [-1, pageWmm+1] × [-1, pageHmm+1] liegen.
  const inMmSpace = (b) =>
    b.x0 >= -1 && b.x1 <= pageWmm + 1 && b.y0 >= -1 && b.y1 <= pageHmm + 1;
  // Seitenfüllendes weisses Blatt ausschließen (BBox ≈ ganze Seite).
  const pageLike = (b) =>
    b.x1 - b.x0 > pageWmm * 0.9 && b.y1 - b.y0 > pageHmm * 0.9;
  // Schriftfeld unten rechts: ~70mm am rechten Rand. Pfade, deren Mittelpunkt im
  // rechten Block (x > pageW-75mm) liegen, ausschließen (Plan ist zentriert).
  const titleXmm = pageWmm - 75;
  const inTitleBlock = (b) => (b.x0 + b.x1) / 2 > titleXmm;
  const plan = boxes.filter(
    (b) => inMmSpace(b) && !pageLike(b) && !inTitleBlock(b),
  );
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const b of plan) {
    if (b.x0 < minX) minX = b.x0; if (b.x1 > maxX) maxX = b.x1;
    if (b.y0 < minY) minY = b.y0; if (b.y1 > maxY) maxY = b.y1;
  }
  // Die Plan-Pfade liegen bereits in mm-Benutzereinheiten (siehe inMmSpace).
  const widthMm = maxX - minX;
  const heightMm = maxY - minY;
  console.log("\n=== MASSSTAB ===");
  console.log(`Plan-Pfade (ohne Blatt/Schriftfeld): ${plan.length} von ${boxes.length}`);
  console.log(`Plan-Inhalt BBox: ${widthMm.toFixed(2)} × ${heightMm.toFixed(2)} mm auf dem Blatt`);
  // Bei 1:100: Welt-Breite (W1=5 m + Wanddicke ~0.345 m) ≈ 5.345 m → 53.45 mm.
  // Höhe (W2=4 m + Dicke) ≈ 4.345 m → 43.45 mm.
  const expectedWmm = 5.345 * (1000 / 100);
  const expectedHmm = 4.345 * (1000 / 100);
  console.log(`Erwartet bei 1:100: ~${expectedWmm.toFixed(2)} × ~${expectedHmm.toFixed(2)} mm`);
  const okW = Math.abs(widthMm - expectedWmm) < 2;
  const okH = Math.abs(heightMm - expectedHmm) < 2;
  console.log(`→ Massstab korrekt (±2mm)? Breite ${okW ? "OK" : "ABWEICHUNG"}, Höhe ${okH ? "OK" : "ABWEICHUNG"}`);
  scaleResult = `${widthMm.toFixed(2)}×${heightMm.toFixed(2)}mm (erwartet ${expectedWmm.toFixed(1)}×${expectedHmm.toFixed(1)})`;

  // PDF → PNG rendern (scharfe Linien/Schraffuren sichtbar prüfen). @napi-rs/
  // canvas hat vorgebaute Binaries (kein nativer Build nötig). Text wird vom
  // Renderer ggf. nicht unterstützt → Geometrie genügt für die Sichtprüfung.
  try {
    const { createCanvas } = await import("@napi-rs/canvas");
    const rscale = 4;
    const rvp = pg.getViewport({ scale: rscale });
    const canvasFactory = {
      create: (w, h) => {
        const c = createCanvas(w, h);
        return { canvas: c, context: c.getContext("2d") };
      },
      reset: (co, w, h) => {
        co.canvas.width = w;
        co.canvas.height = h;
      },
      destroy: (co) => {
        co.canvas.width = 0;
        co.canvas.height = 0;
      },
    };
    const canvas = createCanvas(Math.ceil(rvp.width), Math.ceil(rvp.height));
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await pg.render({ canvasContext: ctx, viewport: rvp, canvasFactory }).promise;
    writeFileSync(join(OUT, "export.png"), canvas.toBuffer("image/png"));
    console.log("PDF→PNG:", join(OUT, "export.png"));
  } catch (e) {
    console.log("(PNG-Render übersprungen:", e.message + ")");
  }
} catch (e) {
  console.log("pdfjs-Messung fehlgeschlagen:", e.message);
}

console.log("\n=== Logs ===");
console.log(logs.length ? logs.slice(-15).join("\n") : "(keine)");
await browser.close();
