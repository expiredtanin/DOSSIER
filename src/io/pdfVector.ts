// Vektor-PDF-Import ([76] Vektorfang auf PDF): dünne Fassade über das Rust-Format-Modul
// (`src-tauri/fileio/src/pdf_vector.rs`, WASM `pkgFileIo`). Rust liest Pfade und Texte einer Seite in
// PDF-Punkten (angezeigte Seite: Ursprung links unten, /Rotate angewendet); hier wird daraus mit dem
// Massstab dieselbe Form wie beim DXF-Import (`DxfImportResult`), damit Import-Dialog und
// `dxfToDrawings.ts` unverändert weiterarbeiten. Die übernommenen Linien sind normale 2D-Zeichnungen
// und damit auch Fangziele (anders als die gerasterte PDF-Unterlage aus `pdfImport.ts`, die bleibt).
//
// Ebenen: gruppiert nach Strichstärke (Papier-mm) und Farbe, z. B. „PDF 0.35 #000000"; gestrichelte
// Linien mit Muster in Papier-mm, z. B. „PDF 0.18 #ff0000 (Strich 0.9/0.6)" (daraus wird beim Import
// ein Linienstil, s. `pdfLineStyles.ts`); Flächen als „PDF Fläche #rrggbb" (Füllfarbe), Texte als
// „PDF Text #rrggbb". Kreise/Bögen aus Bézier-Folgen kommen als echte Kurven (`Contour.curve`) an.
// Massstab: 1 pt = 25.4/72 mm Papier; Modell-Meter = pt × 25.4/72/1000 × Massstabszahl.

import type { Contour, ContourSet, ImportedText } from "../model/types";
import { GENERIC_IMPORT_CATEGORY } from "../model/contextCategories";
import { fileioLoaded } from "../engine/fileioWasm";
import type { DxfImportResult } from "./dxfParser";

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

/** Liest Seite `pageIndex` (0-basiert). Wirft bei unlesbaren/verschlüsselten Dateien (Meldung aus Rust). */
export function readPdfVectorPage(bytes: Uint8Array, pageIndex = 0): PdfVectorPage {
  const m = fileioLoaded();
  if (!m) throw new Error("Format-Modul nicht geladen: loadFileio() muss vor dem Import laufen.");
  const res = m.pdf_read_page(bytes, pageIndex);
  try {
    return decodePdfPage(res.geom(), res.strings());
  } finally {
    res.free();
  }
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

/** Modell-Meter je PDF-Punkt bei Massstab 1:`scale`. */
export function pdfMetersPerPt(scale: number): number {
  return (PT_TO_MM / 1000) * scale;
}

/** Strichstärke in Papier-mm, auf 0.01 mm gerundet (Haarlinie = 0). */
export function pdfLineWeightMm(lineWidthPt: number): number {
  return Math.round(lineWidthPt * PT_TO_MM * 100) / 100;
}

/** Strichmuster in Papier-mm (an/aus/an/aus …), auf 0.05 mm gerundet; Punkte (an = 0) bleiben 0. */
export function pdfDashMm(dashPt: readonly number[]): number[] {
  return dashPt.map((d) => Math.round((d * PT_TO_MM) / 0.05) * 0.05).map((d) => Math.round(d * 100) / 100);
}

/** Kurzschrift eines Strichmusters für Ebenen-/Stilnamen: „0.9/0.6". */
export function pdfDashLabel(dashMm: readonly number[]): string {
  return dashMm.map((d) => String(Math.round(d * 100) / 100)).join("/");
}

/** Ebenenname einer gestrichenen Linie (Stärke + Farbe, ggf. Strichmuster in Papier-mm). */
export function pdfStrokeLayer(p: Pick<PdfVectorPath, "lineWidth" | "stroke" | "dash">): string {
  const lw = pdfLineWeightMm(p.lineWidth).toFixed(2);
  const dash = p.dash.length ? ` (Strich ${pdfDashLabel(pdfDashMm(p.dash))})` : "";
  return `PDF ${lw} ${p.stroke ?? "#000000"}${dash}`;
}

export interface PdfImportOptions {
  /** Texte übernehmen (Standard: ja). */
  texts?: boolean;
}

/**
 * Seite → DXF-Import-Form (Konturen, Texte, Ebenenfarben/-stärken, Flächenfarben) bei Massstab
 * 1:`scale`. Die linke untere Seitenecke liegt im Nullpunkt. Gefüllte und gestrichene Pfade ergeben
 * zwei Konturen (Fläche auf der Flächen-Ebene, Umriss auf der Linien-Ebene); weisse Hintergrund-
 * Flächen, die mehr als die halbe Seite bedecken, werden weggelassen.
 */
export function pdfPageToImport(page: PdfVectorPage, scale: number, opts: PdfImportOptions = {}): DxfImportResult {
  const k = pdfMetersPerPt(scale);
  const layerColors: Record<string, string> = {};
  const layerLineWeights: Record<string, number> = {};
  const layerFillColors: Record<string, string> = {};
  const layerDashes: Record<string, number[]> = {};
  const contours: Contour[] = [];
  const pageArea = page.width * page.height;
  const counts: Record<string, number> = {};
  const toM = (pts: { x: number; y: number }[]) => pts.map((p) => ({ x: p.x * k, y: p.y * k }));
  for (const p of page.paths) {
    if (p.fill && p.closed && !(p.fill === "#ffffff" && !p.stroke && polygonArea(p.pts) > 0.5 * pageArea)) {
      const layer = `PDF Fläche ${p.fill}`;
      layerColors[layer] = p.fill;
      layerFillColors[layer] = p.fill;
      layerLineWeights[layer] ??= 0.05;
      contours.push({ z: 0, pts: toM(p.pts), closed: true, filled: true, layer });
      counts.fill = (counts.fill ?? 0) + 1;
    }
    if (p.stroke) {
      const layer = pdfStrokeLayer(p);
      layerColors[layer] = p.stroke;
      layerLineWeights[layer] = Math.max(0.05, pdfLineWeightMm(p.lineWidth));
      if (p.dash.length) layerDashes[layer] ??= pdfDashMm(p.dash);
      const contour: Contour = { z: 0, pts: toM(p.pts), closed: p.closed, layer };
      if (p.curve) {
        const c = p.curve;
        contour.curve = { kind: c.kind, cx: c.cx * k, cy: c.cy * k, r: c.r * k, a0: c.a0, a1: c.a1 };
      }
      contours.push(contour);
      counts.stroke = (counts.stroke ?? 0) + 1;
    }
  }
  const texts: ImportedText[] = [];
  if (opts.texts !== false) {
    for (const t of page.texts) {
      const layer = `PDF Text ${t.color}`;
      layerColors[layer] = t.color;
      texts.push({ at: { x: t.x * k, y: t.y * k }, text: t.text, height: t.size * k, angle: t.angle, layer });
    }
  }
  const sets: ContourSet[] = contours.length
    ? [
        {
          id: `pdf-contours-${Date.now()}-${page.pageIndex}`,
          type: "contourSet",
          name: "PDF-Konturen",
          categoryCode: GENERIC_IMPORT_CATEGORY.code,
          contours,
        },
      ]
    : [];
  return {
    meshes: [],
    contours: sets,
    texts,
    layerColors,
    layerLineWeights,
    layerFillColors,
    layerDashes,
    diagnostics: {
      entityCounts: { PATH: counts.stroke ?? 0, FILL: counts.fill ?? 0, TEXT: texts.length, IMAGE: page.images },
      total: page.paths.length + page.texts.length,
    },
    unitScale: k,
    recovered: page.truncated,
  };
}

function polygonArea(pts: { x: number; y: number }[]): number {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += (pts[j].x + pts[i].x) * (pts[j].y - pts[i].y);
  return Math.abs(a / 2);
}

/** Kurzbericht einer Seite (CLI `pdf-info`): Zahlen und Umriss der Geometrie in pt und Papier-mm. */
export function pdfPageInfo(page: PdfVectorPage) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let points = 0;
  const grow = (x: number, y: number) => {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  };
  for (const p of page.paths) {
    points += p.pts.length;
    for (const q of p.pts) grow(q.x, q.y);
  }
  for (const t of page.texts) grow(t.x, t.y);
  const layers: Record<string, number> = {};
  for (const p of page.paths) {
    if (p.stroke) {
      const l = pdfStrokeLayer(p);
      layers[l] = (layers[l] ?? 0) + 1;
    }
    if (p.fill) {
      const l = `PDF Fläche ${p.fill}`;
      layers[l] = (layers[l] ?? 0) + 1;
    }
  }
  const r = (v: number) => Math.round(v * 100) / 100;
  return {
    pages: page.pageCount,
    page: page.pageIndex + 1,
    sizePt: [r(page.width), r(page.height)],
    sizeMm: [r(page.width * PT_TO_MM), r(page.height * PT_TO_MM)],
    rotate: page.rotate,
    paths: page.paths.length,
    points,
    texts: page.texts.length,
    images: page.images,
    truncated: page.truncated,
    bboxPt: Number.isFinite(minX) ? [r(minX), r(minY), r(maxX), r(maxY)] : null,
    layers,
  };
}
