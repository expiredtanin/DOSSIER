/**
 * Dekodiert die Material-Farbkarten eines Projekts für den nativen render3d-
 * Renderer (Stil „Textured"). Der native Renderer bekommt KEINE Bild-Dateien —
 * er kennt weder Datei-Pfade noch einen PNG/JPG-Decoder. Deshalb dekodiert diese
 * Datei die eindeutigen Material-Farb-Maps IM BROWSER (Image/ImageBitmap →
 * Canvas → `getImageData`) zu rohen RGBA8-Pixeln und packt sie zu EINEM Puffer
 * (je Textur eine 256×256-Ebene), den {@link WebModelRenderer.set_material_textures}
 * als Textur-Array hochlädt.
 *
 * REIHENFOLGE-VERTRAG: Die Ebenen liegen exakt in der Reihenfolge von
 * {@link wallMaterialColorMaps} — dieselbe Funktion, aus der `toWalls3d` den
 * `materialIndex` je Wand-Band ableitet (1-basiert; Ebene 0 = Fallback-
 * Schachbrett). So zeigt Band-Index i+1 auf die (i)-te dekodierte Ebene, ohne
 * dass eine explizite Zuordnungstabelle zwischen JS und Rust wandern muss.
 */

import { netFetch } from "../net/net";
import type { Project } from "../model/types";
import { wallMaterialColorMaps } from "../core";

/** Kantenlänge einer Textur-Ebene in Texeln (muss zu render3d `TEXTURE_SIZE`). */
const TEX_SIZE = 256;

/** Ergebnis von {@link decodeMaterialTextures}: gepackte RGBA8-Ebenen + Anzahl. */
export interface DecodedMaterialTextures {
  /** `count * TEX_SIZE * TEX_SIZE * 4` Bytes: je Material eine 256×256-RGBA-Ebene. */
  data: Uint8Array;
  /** Anzahl Material-Ebenen (== `wallMaterialColorMaps(project).length`). */
  count: number;
  /** Signatur (die URL-Liste), um unveränderte Material-Mengen nicht neu zu dekodieren. */
  signature: string;
}

/**
 * Dekodiert die eindeutigen Material-Farbkarten von `project` zu gepackten
 * RGBA8-Ebenen. `null`, wenn das Projekt keine Material-Farbkarten benutzt oder
 * kein Browser-Kontext vorliegt (SSR/Test) — der Aufrufer lädt dann nichts hoch
 * (render3d bleibt beim Schachbrett). Fehlgeschlagene Einzelbilder bleiben als
 * schwarze Ebene erhalten (kein Abbruch der ganzen Menge).
 */
export async function decodeMaterialTextures(
  project: Project,
): Promise<DecodedMaterialTextures | null> {
  if (typeof document === "undefined") return null;
  const urls = wallMaterialColorMaps(project);
  if (urls.length === 0) return null;

  const canvas = document.createElement("canvas");
  canvas.width = TEX_SIZE;
  canvas.height = TEX_SIZE;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;

  const bytesPerLayer = TEX_SIZE * TEX_SIZE * 4;
  const data = new Uint8Array(urls.length * bytesPerLayer);
  for (let i = 0; i < urls.length; i++) {
    try {
      const img = await loadImage(urls[i]);
      ctx.clearRect(0, 0, TEX_SIZE, TEX_SIZE);
      // Auf 256×256 skalieren (die Ebenen eines Arrays müssen gleich groß sein).
      ctx.drawImage(img, 0, 0, TEX_SIZE, TEX_SIZE);
      const pixels = ctx.getImageData(0, 0, TEX_SIZE, TEX_SIZE);
      data.set(pixels.data, i * bytesPerLayer);
    } catch {
      // Fehlgeschlagenes Bild: Ebene bleibt schwarz (0) — render3d klemmt bei
      // Bedarf ohnehin auf gültige Ebenen; die übrigen Materialien stimmen.
    }
  }
  return { data, count: urls.length, signature: urls.join("") };
}

/**
 * Lädt eine Bild-URL (Data-URL, Object-URL oder Asset-Pfad) zu einem
 * zeichenbaren Bild. Nutzt `createImageBitmap` (schnell, entkoppelt vom
 * DOM-Layout), fällt auf ein `HTMLImageElement` zurück, wo es fehlt.
 */
async function loadImage(url: string): Promise<CanvasImageSource> {
  if (typeof createImageBitmap === "function" && typeof fetch === "function") {
    try {
      const res = await netFetch(url);
      const blob = await res.blob();
      return await createImageBitmap(blob);
    } catch {
      // Fallback unten (z. B. wenn fetch die URL nicht mag).
    }
  }
  return await new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Bild laden fehlgeschlagen: ${url}`));
    img.src = url;
  });
}
