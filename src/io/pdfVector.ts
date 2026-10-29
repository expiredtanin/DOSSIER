// Vektor-PDF-Import ([76] Vektorfang auf PDF): dünne Fassade über das Rust-Format-Modul
// (`src-tauri/fileio/src/pdf_vector.rs`, WASM `pkgFileIo`). Rust liest Pfade und Texte einer Seite in
// PDF-Punkten (angezeigte Seite: Ursprung links unten, /Rotate angewendet); den Puffer wandelt der Kern
// beim Import mit dem Massstab um wie einen DXF-Import (`core/src/import_drawing.rs`); hier wird er nur für
// Vorschau und Kalibrierung dekodiert. Die übernommenen Linien sind normale 2D-Zeichnungen
// und damit auch Fangziele (anders als die gerasterte PDF-Unterlage aus `pdfImport.ts`, die bleibt).
//
// Ebenen: gruppiert nach Strichstärke (Papier-mm) und Farbe, z. B. „PDF 0.35 #000000"; gestrichelte
// Linien mit Muster in Papier-mm, z. B. „PDF 0.18 #ff0000 (Strich 0.9/0.6)" (daraus wird beim Import
// ein Linienstil); Flächen als „PDF Fläche #rrggbb" (Füllfarbe), Texte als
// „PDF Text #rrggbb". Kreise/Bögen aus Bézier-Folgen kommen als echte Kurven (`Contour.curve`) an.
// Massstab: 1 pt = 25.4/72 mm Papier; Modell-Meter = pt × 25.4/72/1000 × Massstabszahl.

import { fileioLoaded } from "../engine/fileioWasm";
import { core } from "../engine/coreWasm";
import { parsedImport, type ImportChunk, type ParsedImport } from "./importSource";

/** Papier-Millimeter je PDF-Punkt. */
export const PT_TO_MM = 25.4 / 72;

/** Gängige Massstäbe für den Import-Dialog. */
export const PDF_SCALES = [1, 20, 50, 100, 200, 500, 1000] as const;

/** Kreis oder Kreisbogen (pt, Radiant, CCW von `a0` nach `a1`), von Rust aus Bézier-Folgen erkannt. */
export interface PdfVectorCurve {
  kind: "circle" | "arc";
  cx: number;
  cy: number;
  r: number;
  a0: number;
  a1: number;
}

export interface PdfVectorPath {
  /** Punkte in pt (angezeigte Seite, y nach oben). */
  pts: { x: number; y: number }[];
  closed: boolean;
  /** Strichfarbe `#rrggbb`, `null` = nicht gestrichen. */
  stroke: string | null;
  /** Füllfarbe `#rrggbb`, `null` = nicht gefüllt. */
  fill: string | null;
  evenOdd: boolean;
  /** Linienbreite in pt (0 = Haarlinie). */
  lineWidth: number;
  /** Strichmuster in pt (leer = durchgezogen, sonst gerade Länge: an/aus/an/aus …). */
  dash: number[];
  /** Erkannter Kreis/Bogen; `pts` bleibt das tessellierte Vieleck. */
  curve?: PdfVectorCurve;
}

export interface PdfVectorText {
  text: string;
  font: string;
  /** Einfügepunkt (Grundlinie) in pt. */
  x: number;
  y: number;
  /** Schriftgrösse in pt. */
  size: number;
  /** Radiant, CCW. */
  angle: number;
  color: string;
}

export interface PdfVectorPage {
  pageCount: number;
  /** 0-basiert. */
  pageIndex: number;
  /** Angezeigte Seitengrösse in pt. */
  width: number;
  height: number;
  mediaBox: [number, number, number, number];
  cropBox: [number, number, number, number];
  rotate: number;
  /** Budget überschritten, Seite nur teilweise gelesen. */
  truncated: boolean;
  /** Bilder auf der Seite (nicht übernommen). */
  images: number;
  paths: PdfVectorPath[];
  texts: PdfVectorText[];
}

const hex = (c: number): string => `#${(c & 0xffffff).toString(16).padStart(6, "0")}`;

/** Ist die Datei ein PDF (Endung oder Kopf `%PDF-`)? */
export function isPdfFile(name: string, bytes?: Uint8Array): boolean {
  if (/\.pdf$/i.test(name)) return true;
  if (!bytes) return false;
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 1024));
  return head.includes("%PDF-");
}

/** Dekodiert den Puffer aus `pdf_vector.rs::encode` (Aufbau dort beschrieben). */
export function decodePdfPage(geom: Float64Array, strings: readonly string[]): PdfVectorPage {
  let i = 0;
  const num = () => geom[i++];
  const str = () => strings[geom[i++]] ?? "";
  if (num() !== 2) throw new Error("Unbekanntes PDF-Importformat (Version).");
  const pageCount = num();
  const pageIndex = num();
  const width = num();
  const height = num();
  const mediaBox = [num(), num(), num(), num()] as [number, number, number, number];
  const cropBox = [num(), num(), num(), num()] as [number, number, number, number];
  const rotate = num();
  const truncated = num() === 1;
  const images = num();
  const paths: PdfVectorPath[] = [];
  for (let n = num(), k = 0; k < n; k++) {
    const flags = num();
    const s = num();
    const f = num();
    const lineWidth = num();
    const nd = num();
    const dash = Array.from(geom.subarray(i, i + nd));
    i += nd;
    const np = num();
    const pts = new Array(np);
    for (let p = 0; p < np; p++) pts[p] = { x: geom[i + 2 * p], y: geom[i + 2 * p + 1] };
    i += 2 * np;
    let curve: PdfVectorCurve | undefined;
    if (flags & 16) {
      curve = { kind: flags & 32 ? "circle" : "arc", cx: geom[i], cy: geom[i + 1], r: geom[i + 2], a0: geom[i + 3], a1: geom[i + 4] };
      i += 5;
    }
    paths.push({
      pts,
      closed: (flags & 1) !== 0,
      stroke: flags & 2 ? hex(s) : null,
      fill: flags & 4 ? hex(f) : null,
      evenOdd: (flags & 8) !== 0,
      lineWidth,
      dash,
      ...(curve ? { curve } : {}),
    });
  }
  const texts: PdfVectorText[] = [];
  for (let n = num(), k = 0; k < n; k++) {
    const text = str();
    const font = str();
    texts.push({ text, font, x: num(), y: num(), size: num(), angle: num(), color: hex(num()) });
  }
  return { pageCount, pageIndex, width, height, mediaBox, cropBox, rotate, truncated, images, paths, texts };
}

/** Gelesene Seite: Puffer des Format-Moduls (für den Kern) und dekodierte Seite (Vorschau, Kalibrierung). */
export interface PdfRead {
  chunk: ImportChunk;
  page: PdfVectorPage;
}

/** Liest Seite `pageIndex` (0-basiert) samt Puffer. Wirft bei unlesbaren/verschlüsselten Dateien. */
export function readPdfVector(bytes: Uint8Array, pageIndex = 0): PdfRead {
  const m = fileioLoaded();
  if (!m) throw new Error("Format-Modul nicht geladen: loadFileio() muss vor dem Import laufen.");
  const res = m.pdf_read_page(bytes, pageIndex);
  try {
    const chunk = { geom: res.geom(), strings: res.strings() };
    return { chunk, page: decodePdfPage(chunk.geom, chunk.strings) };
  } finally {
    res.free();
  }
}

/**
 * Seite als Import bei Massstab 1:`scale` (Dialog-Zustand). Die Umwandlung — Ebenen nach Strichstärke/Farbe
 * bzw. Strichmuster, Flächen, Texte, Linienstile der Strichmuster — macht der Kern (`import_drawing.rs`).
 */
export function pdfImport(read: PdfRead, scale: number, opts: { texts?: boolean } = {}): ParsedImport {
  return parsedImport([read.chunk], { kind: "pdf", scale, ...(opts.texts === false ? { texts: false } : {}) });
}

/** Kurzbericht einer Seite (CLI `pdf-info`, Kern): Zahlen, Ebenen und Umriss in pt und Papier-mm. */
export function pdfPageInfo(read: PdfRead): Record<string, unknown> {
  const out = core().pdf_page_info(read.chunk.geom, JSON.stringify(read.chunk.strings));
  if (out.startsWith("\u0001")) throw new Error(out.slice(1));
  return JSON.parse(out) as Record<string, unknown>;
}
