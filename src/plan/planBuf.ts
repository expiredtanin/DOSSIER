/**
 * Plan-Puffer ([K3b]): kompakte Binärkodierung der zeichnungsrelevanten Plan-Primitive als
 * flacher `Float64Array`. TS schreibt ihn vorerst aus `Plan.primitives`, der Rust-Kern liest ihn
 * (`src-tauri/core/src/plan_buf.rs`, dort dieselbe Formatbeschreibung) — heute für die GPU-
 * Kompilierung (`glPlan/glPlanCompile.ts`), ab [K3a] erzeugt Rust ihn direkt.
 *
 * ```text
 * Kopf        [MAGIC, VERSION, nColors, nHatches, nPrims]
 *             MAGIC = 0x504C4231 ("PLB1"), VERSION = 1 — Rust lehnt fremde Werte ab (leeres Ergebnis)
 * Farben      nColors × [r, g, b, a]           (0..1, hier aus dem Farbtext geparst)
 * Schraffuren nHatches × Hatch
 * Primitive   nPrims × Prim                    (genau ein Eintrag je Primitiv → Indizes bleiben gleich)
 *
 * Hatch  [pattern, kind, flags, scale, angle, colorIdx, lineWeight, originX, originY,
 *         seed, density, lengthMin, lengthMax, nDash, dash…, (Motiv: length, nPts, x,y…)]
 *        pattern 0 none · 1 solid · 2 diagonal (auch unbekannt) · 3 crosshatch · 4 insulation · 5 custom
 *        kind    0 vector · 1 image · 2 gradient   (Bild/Verlauf: GPU fällt auf die Füllung zurück)
 *        flags   1 random · 2 origin · 4 seed · 8 density · 16 lengthMin · 32 lengthMax · 64 Motiv
 *        (Felder ohne Flag stehen auf 0 und gelten als „nicht gesetzt")
 *
 * Prim   [tag, flags, …]   flags 1 greyed · 2 opacity gesetzt · 4 setzt den Linienzug der
 *                          vorigen Linie fort · 8 Zickzack · 16 Motiv
 *   0 Platzhalter      [0]                                   (Text, Bild … — zeichnet die GPU nicht)
 *   1 polygon          [1, flags, fillIdx, strokeIdx, strokeWidthMm, hatchIdx, opacity,
 *                       nPts, x,y…, nNoStroke, kante…]
 *   2 line             [2, flags, colorIdx, weightMm, opacity, ax, ay, bx, by, nDash, dash…,
 *                       (Zickzack: amplitude, wavelength), (Motiv: length, nPts, x,y…)]
 *   3 arc              [3, flags, colorIdx, weightMm, opacity, cx, cy, fromX, fromY, toX, toY, r,
 *                       nDash, dash…]
 *   4 drawingCircle    [4, flags, fillIdx, strokeIdx, weightMm, opacity, cx, cy, r, nDash, dash…]
 *   5 drawingArc       [5, flags, strokeIdx, weightMm, opacity, cx, cy, r, a0, a1, nDash, dash…]
 * ```
 * Farb-/Schraffur-Index −1 = keine (Farbtext ungültig, "none", fehlende Schraffur). Längen in
 * Metern, Strichstärken/Strichmuster/Zickzack/Motiv in Papier-mm, Winkel von drawingArc in
 * Bogenmass, Schraffur-Winkel in Grad (SVG-Drehsinn). Ohne opacity-Flag steht 1 im Feld; fehlende
 * Zahlen (`undefined`) werden NaN, der Verbraucher nimmt dann wie bisher seinen Standard.
 * Flag 4 (Linienzug): gleiches Element (`drawingId`), gleiche Farbe/Stärke/greyed/opacity/
 * Strichmuster (Referenz) und Anfang = Ende der vorigen Linie — dann zeichnet die GPU die
 * Einzelsegmente als EINEN Zug (zwei echte Kappen statt 2N). Pick-IDs stehen NICHT im Puffer
 * (Picken bleibt vorerst TS).
 */

import type { HatchRender, Primitive } from "./generatePlan";
import type { Vec2 } from "../model/types";

export const PLAN_BUF_MAGIC = 0x504c4231;
export const PLAN_BUF_VERSION = 1;

/** RGBA-Farbe, Komponenten in [0,1]. */
export type PlanRgba = [number, number, number, number];

const FLAG_GREYED = 1;
const FLAG_OPACITY = 2;
const FLAG_CHAIN = 4;
const FLAG_ZIGZAG = 8;
const FLAG_MOTIF = 16;

/**
 * Farbe → RGBA[0..1]; ungültig/"none"/"transparent" → null.
 * Unterstützt "#rgb", "#rrggbb", "#rrggbbaa" und "rgb()/rgba()".
 */
export function parseColor(hex: string | undefined): PlanRgba | null {
  if (!hex) return null;
  const s = hex.trim().toLowerCase();
  if (s === "none" || s === "transparent") return null;

  if (s.startsWith("rgb")) {
    const m = s.match(/[\d.]+/g);
    if (!m || m.length < 3) return null;
    const a = m.length >= 4 ? parseFloat(m[3]) : 1;
    return [+m[0] / 255, +m[1] / 255, +m[2] / 255, a > 1 ? a / 255 : a];
  }

  let h = s[0] === "#" ? s.slice(1) : s;
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  if (h.length !== 6 && h.length !== 8) return null;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
  if (isNaN(r) || isNaN(g) || isNaN(b)) return null;
  return [r / 255, g / 255, b / 255, a];
}

/** Wachsender `Float64Array`-Schreiber. */
class F64Writer {
  buf = new Float64Array(1024);
  length = 0;
  private grow(need: number): void {
    let cap = this.buf.length * 2;
    while (cap < need) cap *= 2;
    const next = new Float64Array(cap);
    next.set(this.buf.subarray(0, this.length));
    this.buf = next;
  }
  push(v: number): void {
    if (this.length + 1 > this.buf.length) this.grow(this.length + 1);
    this.buf[this.length++] = v;
  }
  /** Platz für `n` weitere Werte; liefert den Startindex (danach direkt in `buf` schreiben). */
  reserve(n: number): number {
    if (this.length + n > this.buf.length) this.grow(this.length + n);
    const o = this.length;
    this.length += n;
    return o;
  }
  list(l: readonly number[] | null | undefined): void {
    const n = l ? l.length : 0;
    const o = this.reserve(n + 1);
    this.buf[o] = n;
    for (let i = 0; i < n; i++) this.buf[o + 1 + i] = l![i];
  }
  pts(p: readonly Vec2[]): void {
    const n = p.length;
    const o = this.reserve(2 * n + 1);
    const b = this.buf;
    b[o] = n;
    for (let i = 0; i < n; i++) {
      b[o + 1 + 2 * i] = p[i].x;
      b[o + 2 + 2 * i] = p[i].y;
    }
  }
}

const PATTERN_CODE: Record<string, number> = {
  none: 0,
  solid: 1,
  diagonal: 2,
  crosshatch: 3,
  insulation: 4,
  custom: 5,
};

/** Eine Schraffur im Hatch-Format (auch Eingabe der Einzel-Bindungen in `glPlanHatch.ts`). */
function writeHatch(w: F64Writer, h: HatchRender, colorIdx: number): void {
  let flags = 0;
  if (h.lines === "random") flags |= 1;
  if (h.origin != null) flags |= 2;
  if (h.seed != null) flags |= 4;
  if (h.density != null) flags |= 8;
  if (h.lengthMin != null) flags |= 16;
  if (h.lengthMax != null) flags |= 32;
  if (h.motif) flags |= 64;
  const o = w.reserve(13);
  const b = w.buf;
  b[o] = PATTERN_CODE[h.pattern] ?? 2;
  b[o + 1] = h.kind === "image" ? 1 : h.kind === "gradient" ? 2 : 0;
  b[o + 2] = flags;
  b[o + 3] = h.scale;
  b[o + 4] = h.angle;
  b[o + 5] = colorIdx;
  b[o + 6] = h.lineWeight;
  b[o + 7] = h.origin != null ? h.origin.x : 0;
  b[o + 8] = h.origin != null ? h.origin.y : 0;
  b[o + 9] = h.seed ?? 0;
  b[o + 10] = h.density ?? 0;
  b[o + 11] = h.lengthMin ?? 0;
  b[o + 12] = h.lengthMax ?? 0;
  w.list(h.dash);
  if (h.motif) {
    w.push(h.motif.length);
    w.pts(h.motif.points);
  }
}

/** Einzelne Schraffur kodieren (Farbe −1) — Eingabe der Schraffur-Bindungen des Kerns. */
export function encodeHatch(h: HatchRender): Float64Array {
  const w = new F64Writer();
  writeHatch(w, h, -1);
  return w.buf.subarray(0, w.length);
}

/** Zwischenspeicher Farbtext → Farbindex-Eintrag (geparste Farbe oder null). */
const colorCache = new Map<string, PlanRgba | null>();

type LinePrim = Extract<Primitive, { kind: "line" }>;

const isPlainLine = (p: Primitive | undefined): p is LinePrim =>
  p !== undefined && p.kind === "line" && !p.zigzag && !p.motif;

/** Setzt `p` den Linienzug von `prev` fort (gleiches Element und gleicher Stil, lückenlos)? */
function chainsPrev(prev: Primitive | undefined, p: LinePrim): boolean {
  return (
    isPlainLine(prev) &&
    p.drawingId === prev.drawingId &&
    p.color === prev.color &&
    p.weightMm === prev.weightMm &&
    p.greyed === prev.greyed &&
    p.opacity === prev.opacity &&
    p.dash === prev.dash &&
    p.a.x === prev.b.x &&
    p.a.y === prev.b.y
  );
}

/** Primitive → Plan-Puffer (Format s. Dateikopf). */
export function encodePlanBuf(prims: readonly Primitive[]): Float64Array {
  const colors: PlanRgba[] = [];
  const colorIdx = new Map<string, number>();
  let lastColor: string | undefined;
  let lastColorIdx = -1;
  const color = (s: string | undefined): number => {
    if (!s) return -1;
    if (s === lastColor) return lastColorIdx;
    let i = colorIdx.get(s);
    if (i !== undefined) {
      lastColor = s;
      lastColorIdx = i;
      return i;
    }
    let c = colorCache.get(s);
    if (c === undefined) {
      c = parseColor(s);
      if (colorCache.size > 4096) colorCache.clear();
      colorCache.set(s, c);
    }
    i = c ? colors.push(c) - 1 : -1;
    colorIdx.set(s, i);
    return i;
  };
  const hatchW = new F64Writer();
  const hatchIdx = new Map<HatchRender, number>();
  const hatch = (h: HatchRender | undefined): number => {
    if (!h) return -1;
    let i = hatchIdx.get(h);
    if (i === undefined) {
      i = hatchIdx.size;
      writeHatch(hatchW, h, color(h.color));
      hatchIdx.set(h, i);
    }
    return i;
  };
  const style = (greyed: boolean | undefined, opacity: number | undefined): number =>
    (greyed ? FLAG_GREYED : 0) | (opacity !== undefined ? FLAG_OPACITY : 0);
  const op = (opacity: number | undefined): number => (opacity !== undefined ? opacity : 1);

  const w = new F64Writer();
  for (let i = 0; i < prims.length; i++) {
    const p = prims[i];
    switch (p.kind) {
      case "polygon": {
        const fill = color(p.fill);
        const stroke = color(p.stroke);
        const h = hatch(p.hatch);
        const o = w.reserve(7);
        const b = w.buf;
        b[o] = 1;
        b[o + 1] = style(p.greyed, p.opacity);
        b[o + 2] = fill;
        b[o + 3] = stroke;
        b[o + 4] = p.strokeWidthMm;
        b[o + 5] = h;
        b[o + 6] = op(p.opacity);
        w.pts(p.pts);
        w.list(p.noStrokeEdges);
        break;
      }
      case "line": {
        let flags = style(p.greyed, p.opacity);
        if (isPlainLine(p) && chainsPrev(prims[i - 1], p)) flags |= FLAG_CHAIN;
        if (p.zigzag) flags |= FLAG_ZIGZAG;
        if (p.motif) flags |= FLAG_MOTIF;
        const c = color(p.color);
        const o = w.reserve(9);
        const b = w.buf;
        b[o] = 2;
        b[o + 1] = flags;
        b[o + 2] = c;
        b[o + 3] = p.weightMm;
        b[o + 4] = op(p.opacity);
        b[o + 5] = p.a.x;
        b[o + 6] = p.a.y;
        b[o + 7] = p.b.x;
        b[o + 8] = p.b.y;
        w.list(p.dash);
        if (p.zigzag) {
          w.push(p.zigzag.amplitude);
          w.push(p.zigzag.wavelength);
        }
        if (p.motif) {
          w.push(p.motif.length);
          w.pts(p.motif.points);
        }
        break;
      }
      case "arc": {
        const c = color((p as { color?: string }).color);
        const o = w.reserve(12);
        const b = w.buf;
        b[o] = 3;
        b[o + 1] = style(p.greyed, p.opacity);
        b[o + 2] = c;
        b[o + 3] = p.weightMm;
        b[o + 4] = op(p.opacity);
        b[o + 5] = p.center.x;
        b[o + 6] = p.center.y;
        b[o + 7] = p.from.x;
        b[o + 8] = p.from.y;
        b[o + 9] = p.to.x;
        b[o + 10] = p.to.y;
        b[o + 11] = p.r;
        w.list(p.dash);
        break;
      }
      case "drawingCircle": {
        const fill = color(p.fill);
        const stroke = color(p.stroke);
        const o = w.reserve(9);
        const b = w.buf;
        b[o] = 4;
        b[o + 1] = style(p.greyed, p.opacity);
        b[o + 2] = fill;
        b[o + 3] = stroke;
        b[o + 4] = p.weightMm;
        b[o + 5] = op(p.opacity);
        b[o + 6] = p.center.x;
        b[o + 7] = p.center.y;
        b[o + 8] = p.r;
        w.list(p.dash);
        break;
      }
      case "drawingArc": {
        const stroke = color(p.stroke);
        const o = w.reserve(10);
        const b = w.buf;
        b[o] = 5;
        b[o + 1] = style(p.greyed, p.opacity);
        b[o + 2] = stroke;
        b[o + 3] = p.weightMm;
        b[o + 4] = op(p.opacity);
        b[o + 5] = p.center.x;
        b[o + 6] = p.center.y;
        b[o + 7] = p.r;
        b[o + 8] = p.a0;
        b[o + 9] = p.a1;
        w.list(p.dash);
        break;
      }
      default:
        // Text, Bild …: Platzhalter, damit Indizes/Bereiche gleich bleiben.
        w.push(0);
    }
  }

  const head = 5 + colors.length * 4;
  const out = new Float64Array(head + hatchW.length + w.length);
  out[0] = PLAN_BUF_MAGIC;
  out[1] = PLAN_BUF_VERSION;
  out[2] = colors.length;
  out[3] = hatchIdx.size;
  out[4] = prims.length;
  for (let i = 0; i < colors.length; i++) out.set(colors[i], 5 + i * 4);
  out.set(hatchW.buf.subarray(0, hatchW.length), head);
  out.set(w.buf.subarray(0, w.length), head + hatchW.length);
  return out;
}
