// Editier-Operationen Split / Segment-Löschen für 2D-Zeichenelemente (Join: Kern `cmd_edit.rs`)
// (Drawing2D). Wandeln Drawing2D ↔ {pts, closed}, rufen den reinen Geometrie-
// Kernel (`../geometry/kernel2d`) und liefern neue Drawing2D-Listen. Stil-,
// Kategorie- und Level-Attribute der Quelle werden geerbt.
//
// Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

import type { Drawing2D, Drawing2DGeom, Vec2 } from "../model/types";
import { removeSegment, removeSegmentWithBulge, splitAtIntersections, splitClosedByChord, splitPolylineAtParam, vecEqual } from "../core";
import { bulgeArcPoints, hasRealBulge } from "../core";

/** Eine Polylinien-Darstellung eines Drawing2D (für die Kernel-Funktionen). */
export interface PolyForm {
  pts: Vec2[];
  closed: boolean;
  /** Bogen-Segmente (DXF-bulge, s. `geometry/bulge.ts`) — nur bei `toPolyFormAllowBulge`. */
  bulge?: number[];
}

/**
 * Wandelt die Geometrie eines Drawing2D in eine Polylinien-Form `{pts, closed}`.
 * Nur line/polyline/rect werden unterstützt (circle/arc/text → `null`).
 */
export function toPolyForm(geom: Drawing2DGeom): PolyForm | null {
  switch (geom.shape) {
    case "line":
      return { pts: [geom.a, geom.b], closed: false };
    case "polyline":
      // Bogen-Segmente (bulge) hier noch nicht unterstützt — Split/Segment-
      // Löschen bauen pts komplett neu auf und würden bestehende Bögen
      // stillschweigend zu Geraden entarten lassen, s. offset.ts. (Join hat
      // eine eigene, bulge-erhaltende Variante, s. `toPolyFormAllowBulge`.)
      if (hasRealBulge(geom.bulge)) return null;
      return { pts: geom.pts.slice(), closed: geom.closed };
    case "rect":
      return {
        pts: [
          geom.min,
          { x: geom.max.x, y: geom.min.y },
          geom.max,
          { x: geom.min.x, y: geom.max.y },
        ],
        closed: true,
      };
    default:
      return null;
  }
}

/**
 * Wie {@link toPolyForm}, aber lässt Bogen-Segmente (bulge) durch — für Segment-Löschen
 * (`cutSegment`/`nearestEdgeIndex`), das den bulge an seinem Punktepaar mitträgt.
 */
function toPolyFormAllowBulge(geom: Drawing2DGeom): PolyForm | null {
  if (geom.shape === "polyline") return { pts: geom.pts.slice(), closed: geom.closed, bulge: geom.bulge };
  return toPolyForm(geom);
}

/**
 * Baut aus einer Polylinien-Form die passende Drawing2D-Geometrie. Zwei Punkte +
 * offen → `line`; sonst `polyline` (geschlossen oder offen). Rechtecke werden
 * NICHT rekonstruiert (nach dem Schneiden sind die Teile beliebige Polygone).
 */
export function fromPolyForm(form: PolyForm): Drawing2DGeom {
  const pts = form.pts;
  if (pts.length === 2 && !form.closed && !hasRealBulge(form.bulge)) {
    return { shape: "line", a: pts[0], b: pts[1] };
  }
  const geom: Drawing2DGeom = { shape: "polyline", pts, closed: form.closed };
  if (hasRealBulge(form.bulge)) geom.bulge = form.bulge;
  return geom;
}

let counter = 0;
/** Eindeutige Drawing2D-ID (zeitbasiert + Zähler, damit ein Split nicht kollidiert). */
function newId(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}`;
}

/** Übernimmt Stil-/Kategorie-/Level-Attribute der Quelle auf ein neues Drawing2D. */
function inherit(src: Drawing2D, geom: Drawing2DGeom): Drawing2D {
  const out: Drawing2D = {
    id: newId("d2d"),
    type: "drawing2d",
    levelId: src.levelId,
    categoryCode: src.categoryCode,
    geom,
  };
  if (src.lineStyleId !== undefined) out.lineStyleId = src.lineStyleId;
  if (src.color !== undefined) out.color = src.color;
  if (src.weightMm !== undefined) out.weightMm = src.weightMm;
  // Füllung/Schraffur nur an geschlossene Ergebnisse weitergeben.
  const closed =
    geom.shape === "polyline" ? geom.closed : geom.shape === "rect";
  if (closed) {
    if (src.hatchId !== undefined) out.hatchId = src.hatchId;
    if (src.fillColor !== undefined) out.fillColor = src.fillColor;
  }
  return out;
}

/**
 * Split eines Drawing2D gegen alle ANDEREN Elemente (`others`, als PolyForm).
 *  • Trifft das Ziel andere Elemente, wird an den Schnittpunkten geteilt
 *    (geschlossen + 2 Schnitte → zwei GESCHLOSSENE Polygone via Sehne).
 *  • Ohne Schnitt: Fallback — an der Kanten-MITTE der „längsten" Kante teilen
 *    (offen → zwei Stücke; geschlossen → an einer Kantenmitte + der gegenüber-
 *    liegenden Kantenmitte zu zwei geschlossenen Hälften).
 * Liefert ≥2 neue Drawing2D, oder `[src]` (unverändert), wenn keine Teilung
 * möglich war (z. B. nicht-polyline Form). Stil/Kategorie/Level werden geerbt.
 */
export function splitDrawing(
  src: Drawing2D,
  others: PolyForm[],
): Drawing2D[] {
  const form = toPolyForm(src.geom);
  if (!form) return [src];

  const otherPts = others.map((o) =>
    // Geschlossene als Ring (erster==letzter) übergeben, damit der Kernel die
    // Schlusskante als Kante erkennt.
    o.closed && o.pts.length > 2 ? [...o.pts, o.pts[0]] : o.pts,
  );

  let pieces = splitAtIntersections(form.pts, form.closed, otherPts);

  // Kein Schnitt-Ergebnis (eine Liste, identisch zur Quelle) → Fallback.
  const noCut = pieces.length < 2;
  if (noCut) {
    pieces = fallbackSplit(form);
  }

  if (pieces.length < 2) return [src];

  // Jedes Stück: geschlossen bleibt geschlossen NUR, wenn das Original
  // geschlossen war UND der Schnitt zwei geschlossene Hälften erzeugte
  // (Sehnen-Split / Fallback-geschlossen). Bei offenem Aufschneiden sind die
  // Stücke offen.
  const piecesClosed = form.closed && isClosedSplit(form, pieces);
  return pieces.map((pts) =>
    inherit(src, fromPolyForm({ pts, closed: piecesClosed })),
  );
}

/**
 * Heuristik: erzeugte der Schnitt zwei GESCHLOSSENE Hälften (Sehnen-Split)?
 * Wahr, wenn das Original geschlossen war und genau zwei Stücke entstanden
 * (Chord-Split) — diese sollen wieder geschlossen sein. Bei mehr Stücken
 * (geschlossen an >2 Schnitten aufgetrennt) bleiben sie offen.
 */
function isClosedSplit(form: PolyForm, pieces: Vec2[][]): boolean {
  return form.closed && pieces.length === 2;
}

/**
 * Fallback ohne Schnitt mit anderen Elementen: an der Mitte teilen.
 *  • Offen: längste Kante an t=0.5 in zwei offene Stücke.
 *  • Geschlossen: an den Mitten zweier „gegenüberliegender" Kanten in zwei
 *    geschlossene Polygone (Sehne zwischen den beiden Kantenmitten).
 */
function fallbackSplit(form: PolyForm): Vec2[][] {
  const n = form.pts.length;
  if (n < 2) return [form.pts];
  if (!form.closed) {
    // Längste Kante suchen.
    let best = 0;
    let bestLen = -1;
    for (let i = 0; i < n - 1; i++) {
      const d = dist(form.pts[i], form.pts[i + 1]);
      if (d > bestLen) {
        bestLen = d;
        best = i;
      }
    }
    return splitPolylineAtParam(form.pts, false, best, 0.5);
  }
  // Geschlossen: Kante 0 und die „gegenüberliegende" Kante.
  const i = 0;
  const j = Math.max(1, Math.floor(n / 2)) % n;
  if (i === j) return [form.pts];
  // Direkt den Kernel-Chord-Split nutzen.
  const res = splitClosedHalf(form.pts, i, j);
  return res ?? [form.pts];
}

/** Geschlossenes Polygon an den Mitten der Kanten i und j halbieren. */
function splitClosedHalf(pts: Vec2[], i: number, j: number): Vec2[][] | null {
  // Reuse: splitClosedByChord ist im Kernel; hier über splitAtIntersections-Form
  // nachzubauen wäre umständlich — direkt importieren.
  const res = chordSplit(pts, i, 0.5, j, 0.5);
  return res;
}

function chordSplit(
  pts: Vec2[],
  i: number,
  ti: number,
  j: number,
  tj: number,
): Vec2[][] | null {
  const r = splitClosedByChord(pts, i, ti, j, tj);
  return r ? [r[0], r[1]] : null;
}

const dist = (a: Vec2, b: Vec2): number =>
  Math.hypot(a.x - b.x, a.y - b.y);

/**
 * Segment-Löschen (Schere): entfernt das Segment `edgeIndex` aus einem
 * Drawing2D. Geschlossene Form → offene Polylinie. Liefert das geänderte
 * Drawing2D, oder `null`, wenn weniger als 2 Punkte übrig blieben (Element
 * komplett löschen) bzw. die Form nicht unterstützt wird. Bogen-Segmente
 * (bulge) bleiben dabei an ihrem Punktepaar erhalten (s. `removeSegmentWithBulge`).
 */
export function cutSegment(src: Drawing2D, edgeIndex: number): Drawing2D | null {
  const form = toPolyFormAllowBulge(src.geom);
  if (!form) return src; // nicht unterstützte Form unverändert lassen
  const res = hasRealBulge(form.bulge)
    ? removeSegmentWithBulge(form.pts, form.bulge!, form.closed, edgeIndex)
    : removeSegment(form.pts, form.closed, edgeIndex);
  if (res.pts.length < 2) return null;
  return inherit(src, fromPolyForm(res));
}

/**
 * Liefert den Index der Kante eines Drawing2D, die dem Modellpunkt `p` am
 * nächsten liegt (für Alt+Klick = Segment-Löschen). `null`, wenn die Form keine
 * Kanten hat (circle/arc/text) oder zu wenige Punkte. Bei Bogen-Segmenten
 * (bulge) wird der Abstand gegen die tessellierte Bogenkurve gemessen (nicht
 * gegen die Sehne), der Index bleibt aber der der ORIGINAL-Kante — wichtig,
 * da `cutSegment` denselben Index gegen das bulge-Array auflöst.
 */
export function nearestEdgeIndex(geom: Drawing2DGeom, p: Vec2): number | null {
  const form = toPolyFormAllowBulge(geom);
  if (!form || form.pts.length < 2) return null;
  const n = form.pts.length;
  const edgeCount = form.closed ? n : n - 1;
  let best: number | null = null;
  let bestD = Infinity;
  for (let i = 0; i < edgeCount; i++) {
    const a = form.pts[i];
    const b = form.pts[(i + 1) % n];
    const arcPts = hasRealBulge(form.bulge) ? bulgeArcPoints(a, b, form.bulge?.[i]) : [a, b];
    for (let k = 0; k < arcPts.length - 1; k++) {
      const d = segDist(p, arcPts[k], arcPts[k + 1]);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
  }
  return best;
}

/** Abstand Punkt → Strecke (lokal, klein gehalten). */
function segDist(p: Vec2, a: Vec2, b: Vec2): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const l2 = abx * abx + aby * aby;
  let t = l2 > 0 ? ((p.x - a.x) * abx + (p.y - a.y) * aby) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = a.x + abx * t;
  const cy = a.y + aby * t;
  return Math.hypot(p.x - cx, p.y - cy);
}

// `vecEqual` re-export für etwaige Aufrufer (Auswahl-Vergleich).
export { vecEqual };
