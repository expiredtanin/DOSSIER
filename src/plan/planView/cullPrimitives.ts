// Viewport-Culling für `PlanView`'s Primitiv-Liste — Nutzer-Report
// 2026-10-09: eine DXF-Kataster-Datei mit 59'391 Einzel-Textbeschriftungen
// liess die App nach dem Import "hängen". Ursache: `plan.primitives.map(...)`
// erzeugt für JEDES Primitiv ein SVG-Element, UNABHÄNGIG davon, ob es im
// aktuell sichtbaren Ausschnitt liegt — bei 59'391 Text-Primitiven (jedes mit
// eigenem Rich-Text-Layout, s. `primitives.tsx` Fall `"text"`/`"drawingText"`)
// bedeutet das 59'391 React-Elemente + DOM-Knoten AUF EINMAL, obwohl zu jedem
// Zeitpunkt nur ein Bruchteil davon im Bild ist.
//
// Diese Datei ist bewusst von PlanView.tsx GETRENNT (reine Funktionen, keine
// Hooks/JSX) — leicht testbar, und die React-Integration (Hysterese-Puffer,
// damit kleine Schwenks keine Neuberechnung auslösen, s. Kommentar bei
// `primitiveEls` in PlanView.tsx) bleibt dort.

import type { Vec2 } from "../../model/types";
import type { Primitive } from "../generatePlan";
import { PX_PER_M, toScreen, type ViewBox } from "./geometry";

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function expandByPoint(b: Bounds | null, p: Vec2): Bounds {
  const s = toScreen(p);
  if (!b) return { minX: s.x, maxX: s.x, minY: s.y, maxY: s.y };
  return {
    minX: Math.min(b.minX, s.x),
    maxX: Math.max(b.maxX, s.x),
    minY: Math.min(b.minY, s.y),
    maxY: Math.max(b.maxY, s.y),
  };
}

function circleBounds(center: Vec2, rModel: number): Bounds {
  const c = toScreen(center);
  const rVb = Math.abs(rModel) * PX_PER_M;
  return { minX: c.x - rVb, maxX: c.x + rVb, minY: c.y - rVb, maxY: c.y + rVb };
}

// Pauschale Text-Schätzungen für die konservative Bounding-Box — lieber zu
// grosszügig (ein unsichtbares Element bleibt gerendert) als zu knapp (ein
// sichtbares Element würde fälschlich wegfallen). Kein echtes Font-Layout
// hier — das wäre selbst wieder der teure Schritt, den wir vermeiden wollen.
const AVG_CHAR_WIDTH_FACTOR = 0.65; // Breite ≈ Zeichenzahl × Höhe × Faktor
const TEXT_LINE_HEIGHT_FACTOR = 1.3;
/** Pauschalradius (Meter) für `kind:"text"` (Rich-Text-Raumstempel) — ohne
 *  Doc-Layout ist die reale Breite hier nicht günstig zu schätzen; Raum-
 *  stempel sind aber selten (nicht der Massenfall aus Kataster-Importen). */
const ROOM_STAMP_PAD_M = 4;

/**
 * Grobe (konservative) Bounding-Box eines Primitivs in viewBox-Einheiten —
 * NUR fürs Viewport-Culling gedacht, nicht fürs exakte Rendering. `null` bei
 * leerer/entarteter Geometrie (z. B. 0-Punkt-Polygon) — solche Primitive
 * werden nie gerendert, also auch beim Culling übersprungen (sicher: sie
 * landeten so oder so als `null` im JSX, s. `renderPrimitive`).
 */
export function primitiveBoundsVb(p: Primitive): Bounds | null {
  switch (p.kind) {
    case "polygon": {
      if (p.pts.length === 0) return null;
      let b: Bounds | null = null;
      for (const pt of p.pts) b = expandByPoint(b, pt);
      return b;
    }
    case "line":
      return expandByPoint(expandByPoint(null, p.a), p.b);
    case "arc":
      // Volle Kreis-Bbox statt Bogen-Spanne — überschätzt, aber einfach und
      // immer sicher (der Bogen liegt stets innerhalb dieses Kreises).
      return circleBounds(p.center, p.r);
    case "drawingCircle":
      return circleBounds(p.center, p.r);
    case "drawingArc":
      return circleBounds(p.center, p.r);
    case "drawingImage":
      return expandByPoint(expandByPoint(null, p.min), p.max);
    case "drawingTextPath": {
      if (p.pathPts.length === 0) return null;
      let b: Bounds | null = null;
      for (const pt of p.pathPts) b = expandByPoint(b, pt);
      const padVb = p.heightM * 2 * PX_PER_M;
      return b && {
        minX: b.minX - padVb,
        maxX: b.maxX + padVb,
        minY: b.minY - padVb,
        maxY: b.maxY + padVb,
      };
    }
    case "drawingText": {
      const estW = p.text.length * p.heightM * AVG_CHAR_WIDTH_FACTOR;
      const estH = p.heightM * TEXT_LINE_HEIGHT_FACTOR;
      // Radius statt Rechteck (rotationsunabhängig korrekt, s. Kopfkommentar):
      // `angle` dreht den Text im Modell, ein Rechteck müsste mitgedreht
      // werden — der Halbdiagonal-Radius deckt jede Rotation gleichermassen ab.
      const halfDiag = 0.5 * Math.hypot(estW, estH);
      return circleBounds(p.at, halfDiag);
    }
    case "text":
      return circleBounds(p.at, ROOM_STAMP_PAD_M);
  }
}

/** `region` um `margin` (viewBox-Einheiten) nach allen Seiten vergrössert. */
export function expandRegion(view: ViewBox, margin: number): Bounds {
  return {
    minX: view.x - margin,
    minY: view.y - margin,
    maxX: view.x + view.w + margin,
    maxY: view.y + view.h + margin,
  };
}

/** Ob `view` vollständig innerhalb `region` liegt (Hysterese-Test). */
export function regionContains(region: Bounds, view: ViewBox): boolean {
  return (
    view.x >= region.minX &&
    view.x + view.w <= region.maxX &&
    view.y >= region.minY &&
    view.y + view.h <= region.maxY
  );
}

function intersects(a: Bounds, b: Bounds): boolean {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

/**
 * Ob ein Text-Primitiv bei der aktuellen Zoomstufe zu klein wäre, um lesbar
 * zu sein — UNABHÄNGIG von der Viewport-Position (betrifft auch den
 * eingepassten Übersichts-Ausschnitt direkt nach einem Import, wo technisch
 * ALLE Elemente "im Bild" liegen, aber bei einem kilometerweiten Umriss jedes
 * einzelne Label nur wenige Bildschirm-Pixel gross und damit unleserlich
 * wäre). `minHeightVb` ist die Mindesthöhe in viewBox-Einheiten (s.
 * `PlanView.tsx`: `view.h × MIN_RELATIVE_TEXT_HEIGHT`) — reine Text-
 * Primitive (Raumstempel, `kind:"text"`) bleiben unangetastet: sie sind
 * selten (nicht die Masse aus einem Kataster-Import) und meist bewusst
 * platziert.
 */
function isTooSmallToRead(p: Primitive, minHeightVb: number): boolean {
  if (minHeightVb <= 0) return false;
  if (p.kind === "drawingText" || p.kind === "drawingTextPath") {
    return p.heightM * PX_PER_M < minHeightVb;
  }
  return false;
}

/**
 * Filtert `primitives` auf die, deren (grobe) Bounding-Box `region`
 * schneidet UND (falls `minTextHeightVb > 0`) bei der aktuellen Zoomstufe
 * gross genug wäre, um lesbar zu sein — behält den URSPRÜNGLICHEN Index
 * (wichtig: Auswahl/Hit-Testing in PlanView.tsx indiziert direkt in
 * `plan.primitives[i]`, Hatch-Pattern-IDs sind `hatch-${i}` — ein
 * renummeriertes Array würde beides zerstören).
 */
export function primitivesInRegion(
  primitives: readonly Primitive[],
  region: Bounds,
  minTextHeightVb = 0,
): Array<{ p: Primitive; i: number }> {
  return indexedInRegion(primitives.map((p, i) => ({ p, i })), region, minTextHeightVb);
}

/** Wie {@link primitivesInRegion}, aber über eine schon vorgefilterte, indizierte Liste. */
export function indexedInRegion(
  items: ReadonlyArray<{ p: Primitive; i: number }>,
  region: Bounds,
  minTextHeightVb = 0,
): Array<{ p: Primitive; i: number }> {
  const out: Array<{ p: Primitive; i: number }> = [];
  for (const item of items) {
    if (isTooSmallToRead(item.p, minTextHeightVb)) continue;
    const b = primitiveBoundsVb(item.p);
    if (b === null || intersects(b, region)) out.push(item);
  }
  return out;
}
