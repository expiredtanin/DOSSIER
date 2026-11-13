// [223] 3D-Bild für die Abgabe: reine Hilfen für den Bild-Export des 3D-Viewports (Zielgrösse, transparenter
// Hintergrund). Das Zeichnen selbst macht render3d in der Zielgrösse (`useWasm3dRenderer.exportImage`), nicht ein
// Bildschirmfoto des Fensters.

/** Längste Bildkante (px): WebGPU-Standardgrenze für 2D-Texturen (`maxTextureDimension2D`). */
export const IMAGE_MAX_EDGE = 8192;

/** [212] Samples je Pixel des Bild-Exports im Stil „Pathtracing (Vorschau)“: Vorgabe und Obergrenze (= Ziel der Vorschau). */
export const PT_EXPORT_SAMPLES = 64;
export const PT_EXPORT_MAX_SAMPLES = 1024;
/** [212] Pixel je Sample beim Export (die Vorschau rechnet ≤ 1.2 MPx und zieht hoch; das Bild feiner, Speicher ≈ 80 B/px). */
export const PT_EXPORT_MAX_PIXELS = 4_000_000;

/** [212] Samples des Exports: ganzzahlig 1 … `PT_EXPORT_MAX_SAMPLES`, sonst die Vorgabe. */
export function exportSamples(n: number | undefined): number {
  if (n === undefined || !Number.isFinite(n)) return PT_EXPORT_SAMPLES;
  return Math.min(PT_EXPORT_MAX_SAMPLES, Math.max(1, Math.round(n)));
}

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

/** [212] Fortschritt und Abbruch des Bild-Exports im Stil Pathtracing (Samples fertig / gesamt). */
export interface ExportProgress {
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
}

/** Der Teil von render3d, den das Rechnen in Häppchen braucht (`web::gpu_idle` wartet auf die GPU). */
export interface ChunkRenderer {
  render(): void;
  pathtrace_samples(): number;
  set_pathtrace_batch(n: number): void;
  gpu_idle(): Promise<unknown>;
}

/** Zieldauer eines Häppchens (ms): kurz genug für Fortschritt und Abbruch, lang genug gegen Leerlauf zwischen den Aufrufen. */
const CHUNK_MS = 250;

/**
 * [212] Etappe 3: rechnet die Samples des Exports bis auf das letzte Häppchen in Häppchen (Grösse nach gemessener Dauer,
 * Ziel `CHUNK_MS`), wartet nach jedem auf die GPU (`gpu_idle`), meldet den Fortschritt und prüft den Abbruch. Das letzte
 * Häppchen bleibt dem Aufrufer: es muss im selben Task wie das Auslesen des Canvas gezeichnet werden. Rückgabe: Samples,
 * die noch fehlen (≥ 1), oder null bei Abbruch. Stockt die Zahl (Obergrenze im Renderer), endet die Schleife.
 */
export async function renderPathtraceChunks(r: ChunkRenderer, total: number, p: ExportProgress = {}, now: () => number = () => performance.now()): Promise<number | null> {
  let batch = 1;
  let last = -1;
  while (r.pathtrace_samples() + batch < total) {
    if (p.signal?.aborted) return null;
    const before = r.pathtrace_samples();
    if (before === last) break;
    last = before;
    r.set_pathtrace_batch(batch);
    const t0 = now();
    r.render();
    await r.gpu_idle();
    const dt = Math.max(1, now() - t0);
    p.onProgress?.(r.pathtrace_samples(), total);
    batch = Math.max(1, Math.min(64, Math.round((batch * CHUNK_MS) / dt)));
  }
  if (p.signal?.aborted) return null;
  return Math.max(1, total - r.pathtrace_samples());
}
