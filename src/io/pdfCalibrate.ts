// Zwei-Punkt-Kalibrierung des PDF-Imports ([76]): Massstab aus einer gemessenen Strecke, Fangindex
// über die gelesenen Pfadpunkte der Seite. Reine Rechnung ohne UI (Dialog: `ui/PdfCalibrate.tsx`).
//
// Alle Koordinaten in PDF-pt der angezeigten Seite (Ursprung links unten, y nach oben).

import type { PdfVectorPage } from "./pdfVector";
import { PT_TO_MM } from "./pdfVector";

export interface Pt {
  x: number;
  y: number;
}

/** Abstand zweier Punkte. */
export function pdfDistance(a: Pt, b: Pt): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/** Länge der gemessenen Strecke auf dem Blatt in Papier-mm. */
export function pdfPaperMm(a: Pt, b: Pt): number {
  return pdfDistance(a, b) * PT_TO_MM;
}

/**
 * Massstabszahl (1:n), bei der die Strecke a–b im Modell `trueLengthM` Meter misst.
 * `null` bei Nulllänge oder unsinnigen Eingaben.
 */
export function pdfScaleFromDistance(a: Pt, b: Pt, trueLengthM: number): number | null {
  const mm = pdfPaperMm(a, b);
  if (!(mm > 1e-9) || !Number.isFinite(mm) || !(trueLengthM > 0) || !Number.isFinite(trueLengthM)) return null;
  const n = (trueLengthM * 1000) / mm;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Massstabszahl für die Anzeige („98.7", „100"): auf 0.01 gerundet, ohne Nullen. */
export function formatScale(n: number): string {
  return String(Math.round(n * 100) / 100);
}

/** Höchstzahl Fangpunkte (Schutz gegen riesige Seiten). */
const MAX_SNAP_POINTS = 2_000_000;

/** Räumlicher Index der Pfadpunkte: Gitter (CSR), Abfrage nach nächstem Punkt im Radius. */
export interface SnapIndex {
  count: number;
  nearest(x: number, y: number, radius: number): Pt | null;
}

/**
 * Fangpunkte einer Seite: alle Pfadpunkte (Ecken), bei erkannten Kreisen/Bögen zusätzlich Mittelpunkt
 * und Quadranten (bzw. Endpunkte), damit sich auch an runden Bauteilen messen lässt.
 */
export function collectSnapPoints(page: PdfVectorPage): { xs: Float64Array; ys: Float64Array } {
  let n = 0;
  for (const p of page.paths) n += p.pts.length + (p.curve ? 5 : 0);
  n = Math.min(n, MAX_SNAP_POINTS);
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  let i = 0;
  const add = (x: number, y: number) => {
    if (i < n && Number.isFinite(x) && Number.isFinite(y)) {
      xs[i] = x;
      ys[i++] = y;
    }
  };
  for (const p of page.paths) {
    for (const q of p.pts) add(q.x, q.y);
    const c = p.curve;
    if (c) {
      add(c.cx, c.cy);
      if (c.kind === "circle") {
        add(c.cx + c.r, c.cy);
        add(c.cx, c.cy + c.r);
        add(c.cx - c.r, c.cy);
        add(c.cx, c.cy - c.r);
      } else {
        add(c.cx + c.r * Math.cos(c.a0), c.cy + c.r * Math.sin(c.a0));
        add(c.cx + c.r * Math.cos(c.a1), c.cy + c.r * Math.sin(c.a1));
      }
    }
  }
  return { xs: xs.subarray(0, i), ys: ys.subarray(0, i) };
}

export function buildSnapIndex(page: PdfVectorPage): SnapIndex {
  const { xs, ys } = collectSnapPoints(page);
  const n = xs.length;
  const w = Math.max(page.width, 1);
  const h = Math.max(page.height, 1);
  // ≈ 1 Punkt je Zelle im Mittel, höchstens 512 × 512 Zellen.
  const cells = Math.max(1, Math.min(512, Math.round(Math.sqrt(n / 2)) || 1));
  const cw = w / cells;
  const ch = h / cells;
  const cellX = (x: number) => Math.min(cells - 1, Math.max(0, Math.floor(x / cw)));
  const cellY = (y: number) => Math.min(cells - 1, Math.max(0, Math.floor(y / ch)));
  const start = new Int32Array(cells * cells + 1);
  for (let k = 0; k < n; k++) start[cellY(ys[k]) * cells + cellX(xs[k]) + 1]++;
  for (let c = 0; c < cells * cells; c++) start[c + 1] += start[c];
  const fill = start.slice(0, cells * cells);
  const items = new Int32Array(n);
  for (let k = 0; k < n; k++) items[fill[cellY(ys[k]) * cells + cellX(xs[k])]++] = k;
  return {
    count: n,
    nearest(x, y, radius) {
      if (n === 0 || !(radius > 0)) return null;
      const x0 = cellX(x - radius);
      const x1 = cellX(x + radius);
      const y0 = cellY(y - radius);
      const y1 = cellY(y + radius);
      let best = -1;
      let bestD = radius * radius;
      for (let cy = y0; cy <= y1; cy++) {
        for (let cx = x0; cx <= x1; cx++) {
          const c = cy * cells + cx;
          for (let q = start[c]; q < start[c + 1]; q++) {
            const k = items[q];
            const d = (xs[k] - x) ** 2 + (ys[k] - y) ** 2;
            if (d <= bestD) {
              bestD = d;
              best = k;
            }
          }
        }
      }
      return best < 0 ? null : { x: xs[best], y: ys[best] };
    },
  };
}
