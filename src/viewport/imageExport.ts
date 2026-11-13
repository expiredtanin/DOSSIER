// [223] 3D-Bild für die Abgabe: reine Hilfen für den Bild-Export des 3D-Viewports (Zielgrösse, transparenter
// Hintergrund). Das Zeichnen selbst macht render3d in der Zielgrösse (`useWasm3dRenderer.exportImage`), nicht ein
// Bildschirmfoto des Fensters.

/** Längste Bildkante (px): WebGPU-Standardgrenze für 2D-Texturen (`maxTextureDimension2D`). */
export const IMAGE_MAX_EDGE = 8192;

export interface ImageSize {
  width: number;
  height: number;
  /** Auf `IMAGE_MAX_EDGE` verkleinert worden (Seitenverhältnis bleibt)? */
  clamped: boolean;
}

/** Zielgrösse ganzzahlig, mindestens 16 px, die lange Seite höchstens `maxEdge` (Seitenverhältnis bleibt). */
export function clampImageSize(width: number, height: number, maxEdge = IMAGE_MAX_EDGE): ImageSize {
  const w = Number.isFinite(width) ? Math.max(16, Math.round(width)) : 16;
  const h = Number.isFinite(height) ? Math.max(16, Math.round(height)) : 16;
  const k = Math.min(1, maxEdge / Math.max(w, h));
  if (k >= 1) return { width: w, height: h, clamped: false };
  return { width: Math.max(16, Math.round(w * k)), height: Math.max(16, Math.round(h * k)), clamped: true };
}

/**
 * Transparenter Hintergrund aus zwei Bildern derselben Szene: auf Schwarz (`onBlack`) und auf Weiss (`onWhite`) gezeichnet
 * (RGBA, gleiche Länge). Ein Pixel mit Deckkraft a ergibt auf Weiss `c·a + (1−a)`, auf Schwarz `c·a`; die Differenz ist
 * `1−a`. Schreibt das Ergebnis (nicht vormultipliziert) nach `onBlack`; die Kanten (Antialiasing) bleiben weich.
 */
export function matteFromBlackWhite(onBlack: Uint8ClampedArray, onWhite: Uint8ClampedArray): void {
  const n = Math.min(onBlack.length, onWhite.length) - 3;
  for (let i = 0; i < n; i += 4) {
    const d = (onWhite[i] - onBlack[i] + (onWhite[i + 1] - onBlack[i + 1]) + (onWhite[i + 2] - onBlack[i + 2])) / (3 * 255);
    const a = Math.min(1, Math.max(0, 1 - d));
    if (a < 1 / 255) {
      onBlack[i] = onBlack[i + 1] = onBlack[i + 2] = onBlack[i + 3] = 0;
      continue;
    }
    onBlack[i] = Math.min(255, Math.round(onBlack[i] / a));
    onBlack[i + 1] = Math.min(255, Math.round(onBlack[i + 1] / a));
    onBlack[i + 2] = Math.min(255, Math.round(onBlack[i + 2] / a));
    onBlack[i + 3] = Math.round(a * 255);
  }
}

/** Ist das Bild leer (alles transparent oder schwarz)? Stichprobe über ein Raster. */
export function isBlankImage(rgba: Uint8ClampedArray): boolean {
  const step = Math.max(1, Math.floor(rgba.length / 4 / 400)) * 4;
  for (let i = 0; i < rgba.length; i += step) if (rgba[i + 3] > 0 && (rgba[i] | rgba[i + 1] | rgba[i + 2]) !== 0) return false;
  return true;
}

/** Dateiname des Exports: `<projekt>-3d-<breite>x<hoehe>.png`. */
export function imageFileName(projectName: string, width: number, height: number): string {
  return `${(projectName || "projekt").replace(/[^\w.-]+/g, "_")}-3d-${width}x${height}.png`;
}
