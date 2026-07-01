// 2D-Boolean-Operationen (Union / Subtract / Intersect) für GESCHLOSSENE
// 2D-Zeichenelemente (Drawing2D). Ergänzt Split/Join (`splitJoin.ts`). Wandelt
// Drawing2D ↔ polygon-clipping-Format (Martinez-Algorithmus, robust) und liefert
// neue Drawing2D-Listen. Stil-, Kategorie- und Level-Attribute werden geerbt
// (vom ersten bzw. Basis-Element).
//
// Loch-Handling: Das Drawing2D-Modell kennt KEINE Innenringe (Löcher). Liefert
// polygon-clipping ein Polygon mit Innenringen, wird der Außenring als gefüllte
// Form emittiert und JEDER Innenring als SEPARATE, ungefüllte geschlossene
// Polylinie (Loch-Umriss). So geht keine Geometrie verloren und nichts crasht;
// der Lochrand bleibt sichtbar, ohne dass eine gefüllte Insel entsteht.
//
// Nur geschlossene Elemente (rect / polyline closed) zählen; offene Linien/
// Polylinien und Kreise/Bögen/Text werden ignoriert. Wände sind kein Drawing2D
// und damit ohnehin ausgenommen (No-op).
//
// Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

import polygonClipping from "polygon-clipping";
import type { MultiPolygon, Polygon, Ring } from "polygon-clipping";
import type { Drawing2D, Drawing2DGeom, Vec2 } from "../model/types";
import { toPolyForm } from "./splitJoin";
import type { PolyForm } from "./splitJoin";

/** Ist die Geometrie eines Drawing2D eine GESCHLOSSENE Fläche (für Boolean)? */
export function isClosedArea(geom: Drawing2DGeom): boolean {
  if (geom.shape === "rect") return true;
  if (geom.shape === "polyline") return geom.closed && geom.pts.length >= 3;
  return false;
}

/**
 * Wandelt ein geschlossenes Drawing2D in ein polygon-clipping-`Polygon`
 * (Ring-Liste). Reuse: `toPolyForm` aus splitJoin liefert die Stützpunkte. Der
 * Ring wird als `[x,y]`-Paare gebildet; polygon-clipping schließt selbst
 * (erster==letzter ist nicht erforderlich, aber unschädlich). Liefert `null`,
 * wenn die Form nicht geschlossen ist oder zu wenige Punkte hat.
 */
export function drawingToPolygon(geom: Drawing2DGeom): Polygon | null {
  if (!isClosedArea(geom)) return null;
  const form = toPolyForm(geom);
  if (!form) return null;
  const ring = formToRing(form);
  if (ring.length < 3) return null;
  return [ring];
}

/** PolyForm → polygon-clipping-Ring (`[x,y]`-Paare). */
function formToRing(form: PolyForm): Ring {
  return form.pts.map((p): [number, number] => [p.x, p.y]);
}

/** Ein polygon-clipping-Ring → Vec2-Punktliste (für fromPolyForm/Drawing2D). */
function ringToPts(ring: Ring): Vec2[] {
  // polygon-clipping liefert geschlossene Ringe (letzter == erster Punkt). Den
  // doppelten Schlusspunkt entfernen, damit unsere Polyline-Form sauber ist.
  const pts = ring.map((p): Vec2 => ({ x: p[0], y: p[1] }));
  if (
    pts.length > 1 &&
    pts[0].x === pts[pts.length - 1].x &&
    pts[0].y === pts[pts.length - 1].y
  ) {
    pts.pop();
  }
  return pts;
}

let counter = 0;
/** Eindeutige Drawing2D-ID (zeitbasiert + Zähler). */
function newId(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}`;
}

/**
 * Erzeugt aus einem Punktring ein neues geschlossenes Drawing2D, das Stil/
 * Kategorie/Level der Quelle erbt. `filled` steuert, ob Füllung/Schraffur
 * mitwandern (Außenring = ja, Loch-Umriss = nein).
 */
function ringDrawing(src: Drawing2D, pts: Vec2[], filled: boolean): Drawing2D {
  const out: Drawing2D = {
    id: newId("bool"),
    type: "drawing2d",
    levelId: src.levelId,
    categoryCode: src.categoryCode,
    geom: { shape: "polyline", pts, closed: true },
  };
  if (src.lineStyleId !== undefined) out.lineStyleId = src.lineStyleId;
  if (src.color !== undefined) out.color = src.color;
  if (src.weightMm !== undefined) out.weightMm = src.weightMm;
  if (filled) {
    if (src.hatchId !== undefined) out.hatchId = src.hatchId;
    if (src.fillColor !== undefined) out.fillColor = src.fillColor;
  }
  return out;
}

/**
 * Wandelt eine polygon-clipping-`MultiPolygon` in Drawing2D[] zurück. Je Polygon
 * wird der Außenring (filled) emittiert; jeder Innenring (Loch) als separater
 * ungefüllter geschlossener Umriss. Quelle liefert Stil/Kategorie/Level.
 */
function multiPolygonToDrawings(
  src: Drawing2D,
  mp: MultiPolygon,
): Drawing2D[] {
  const out: Drawing2D[] = [];
  for (const poly of mp) {
    poly.forEach((ring, i) => {
      const pts = ringToPts(ring);
      if (pts.length < 3) return;
      // Erster Ring = Außenkontur (gefüllt), weitere = Löcher (nur Umriss).
      out.push(ringDrawing(src, pts, i === 0));
    });
  }
  return out;
}

/** Geschlossene Quellen → polygon-clipping-Polygone (mit Drawing-Zuordnung). */
function collectPolygons(
  srcs: Drawing2D[],
): { poly: Polygon; src: Drawing2D }[] {
  const out: { poly: Polygon; src: Drawing2D }[] = [];
  for (const d of srcs) {
    const poly = drawingToPolygon(d.geom);
    if (poly) out.push({ poly, src: d });
  }
  return out;
}

/**
 * Vereinigung (Union) der gegebenen geschlossenen Drawing2D. Liefert die neuen
 * Drawing2D (≥1 — MultiPolygon → mehrere) und die IDs der ERSETZTEN Quellen.
 * Stil/Kategorie/Level werden vom ersten geschlossenen Element geerbt. Weniger
 * als 2 geschlossene Quellen → No-op (`{ created: [], replacedIds: [] }`).
 */
export function unionDrawings(srcs: Drawing2D[]): BooleanResult {
  const polys = collectPolygons(srcs);
  if (polys.length < 2) return EMPTY_RESULT;
  const first = polys[0];
  const rest = polys.slice(1).map((p) => p.poly);
  const mp = polygonClipping.union(first.poly, ...rest);
  return {
    created: multiPolygonToDrawings(first.src, mp),
    replacedIds: polys.map((p) => p.src.id),
  };
}

/**
 * Differenz (Subtract): das ERSTE geschlossene Element ist die Basis, alle
 * übrigen werden abgezogen. Liefert neue Drawing2D + ersetzte IDs (nur die
 * tatsächlich beteiligten geschlossenen Quellen). Stil/Kategorie/Level von der
 * Basis. Weniger als 2 geschlossene Quellen → No-op.
 */
export function differenceDrawings(srcs: Drawing2D[]): BooleanResult {
  const polys = collectPolygons(srcs);
  if (polys.length < 2) return EMPTY_RESULT;
  const base = polys[0];
  const clips = polys.slice(1).map((p) => p.poly);
  const mp = polygonClipping.difference(base.poly, ...clips);
  return {
    created: multiPolygonToDrawings(base.src, mp),
    replacedIds: polys.map((p) => p.src.id),
  };
}

/**
 * Schnittmenge (Intersection): nur die gemeinsame Überlappung aller geschlossenen
 * Elemente bleibt. Liefert neue Drawing2D + ersetzte IDs. Stil/Kategorie/Level
 * vom ersten Element. Weniger als 2 geschlossene Quellen → No-op. Ohne
 * Überlappung ist `created` leer (die Quellen werden trotzdem ersetzt = entfernt,
 * weil der leere Schnitt das gewünschte Ergebnis ist).
 */
export function intersectionDrawings(srcs: Drawing2D[]): BooleanResult {
  const polys = collectPolygons(srcs);
  if (polys.length < 2) return EMPTY_RESULT;
  const first = polys[0];
  const rest = polys.slice(1).map((p) => p.poly);
  const mp = polygonClipping.intersection(first.poly, ...rest);
  return {
    created: multiPolygonToDrawings(first.src, mp),
    replacedIds: polys.map((p) => p.src.id),
  };
}

/** Ergebnis einer Boolean-Operation: neue Elemente + zu ersetzende Quell-IDs. */
export interface BooleanResult {
  /** Neu erzeugte Drawing2D (ersetzen die Quellen). */
  created: Drawing2D[];
  /** IDs der geschlossenen Quellen, die durch das Ergebnis ersetzt werden. */
  replacedIds: string[];
}

const EMPTY_RESULT: BooleanResult = { created: [], replacedIds: [] };

/** Zählt geschlossene Flächen in einer Auswahl (für Menü-Aktivierung). */
export function countClosedAreas(srcs: Drawing2D[]): number {
  let n = 0;
  for (const d of srcs) if (isClosedArea(d.geom)) n++;
  return n;
}
