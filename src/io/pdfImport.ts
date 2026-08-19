// PDF-Import als Rasterbild: jede Seite wird auf ein `<canvas>` gerendert
// (pdfjs-dist, reine Browser-/Webview-API — kein Tauri-fs nötig) und als
// Data-URL zurückgegeben. Kein eigener PDF-Rendering-Pfad im Plan/Layout —
// eine importierte PDF-Seite ist danach ein ganz normales Bild-Element
// (Drawing2D `{shape:"image"}` bzw. LayoutAnnotation `kind:"image"`).

import * as pdfjsLib from "pdfjs-dist";
import type { LoadedImageAsset } from "./imageAsset";

// Worker-Bundle-URL über `import.meta.url` auflösen (Vite-Standardmuster für
// Asset-URLs) — braucht keine `?url`-Modul-Deklaration wie ein direkter Import.
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url,
).href;

/**
 * Rastert alle Seiten einer PDF-Datei zu PNG-Data-URLs. `scale` steuert die
 * Auflösung (2 ≈ Bildschirm-Retina-Schärfe bei üblichen Seitengrössen).
 */
export async function rasterizePdfPages(file: File, scale = 2): Promise<LoadedImageAsset[]> {
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  const pages: LoadedImageAsset[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.ceil(viewport.width));
    canvas.height = Math.max(1, Math.ceil(viewport.height));
    const ctx = canvas.getContext("2d");
    if (!ctx) continue;
    await page.render({ canvasContext: ctx, viewport, canvas }).promise;
    pages.push({
      src: canvas.toDataURL("image/png"),
      naturalWidth: canvas.width,
      naturalHeight: canvas.height,
    });
  }
  return pages;
}
