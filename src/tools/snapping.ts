// Snapping (docs/design/drawing-tools.md §5). Läuft auf jedem Pointer-Move
// BEVOR der Punkt an das Werkzeug geht: sammelt Snap-Kandidaten, wählt den
// besten innerhalb der Bildschirm-Toleranz und liefert Marker-Info.
//
// Phase 2: endpoint · midpoint · intersection · onEdge (Lot) · grid · ortho.
// Prioritäts-Reihenfolge (Vorrang bei nahem Abstand): endpoint > intersection >
// midpoint > onEdge > grid; ortho/Winkelraster ist eine Projektion (überlagert).

import type { Project, Vec2, Wall } from "../model/types";
import { getWallType, wallTypeThickness } from "../model/types";
import { add, leftNormal, lineIntersect, normalize, scale, sub } from "../model/geometry";
import { wallReferenceOffset } from "../model/wall";
import { centroid as roomCentroid } from "../geometry/roomArea";
import type { SnapKind, SnapResult, SnapSettings } from "./types";
import { sampleBezierChain, sampleCatmullRom } from "./curves";

const dist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);
const mid = (a: Vec2, b: Vec2): Vec2 => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/** Bildschirm-px-Bonus je Snap-Art: höher = gewinnt knappe Vergleiche. */
const PRIORITY: Record<SnapKind, number> = {
  endpoint: 7,
  intersection: 5,
  midpoint: 3,
  center: 3,
  quadrant: 3,
  onEdge: 0,
  grid: -2,
  ortho: 0,
  extension: 0,
  angle: 0,
  divide: 3,
};

export interface SnapInput {
  raw: Vec2;
  project: Project;
  levelId: string;
  visibleCodes: Set<string>;
  settings: SnapSettings;
  draftPoints: Vec2[];
  lastPoint: Vec2 | null;
  pxPerMeter: number;
  shift: boolean;
  ctrl: boolean;
}

/** Eine Strecke als Snap-Quelle (Wandachse oder 2D-Segment). */
type Seg = [Vec2, Vec2];

/**
 * Schichttrennlinien einer Wand: für jede kumulierte Schichtgrenze (inkl.
 * beider Aussenflächen) eine zur Achse parallele Strecke, um den Betrag
 * entlang `leftNormal(u)` verschoben. Spiegelt EXAKT die Offset-Berechnung aus
 * `generatePlan.ts` (`addWallPoche`): Start bei `refOff − total/2`
 * (`wallReferenceOffset`), danach je Schicht `+= layer.thickness` aufsummiert.
 * Liefert `layers.length + 1` Segmente (leer bei unbekanntem Wandtyp).
 */
export function wallLayerBoundarySegments(project: Project, wall: Wall): Seg[] {
  let wt;
  try {
    wt = getWallType(project, wall);
  } catch {
    return [];
  }
  const total = wallTypeThickness(wt);
  const refOff = wallReferenceOffset(wall, total);
  const u = normalize(sub(wall.end, wall.start));
  const n = leftNormal(u);
  const out: Seg[] = [];
  let off = refOff - total / 2;
  const boundary = (o: number): Seg => [
    add(wall.start, scale(n, o)),
    add(wall.end, scale(n, o)),
  ];
  out.push(boundary(off)); // äussere Fläche
  for (const layer of wt.layers) {
    off += layer.thickness;
    out.push(boundary(off)); // Schichtfuge (letzte = innere Fläche)
  }
  return out;
}

/** Sammelt alle sichtbaren Strecken des Geschosses (Wandachsen + 2D-Segmente). */
function collectSegments(input: SnapInput): Seg[] {
  const segs: Seg[] = [];
  for (const w of input.project.walls) {
    if (w.floorId !== input.levelId) continue;
    if (!input.visibleCodes.has(w.categoryCode)) continue;
    segs.push([w.start, w.end]);
    for (const seg of wallLayerBoundarySegments(input.project, w)) segs.push(seg);
  }
  for (const d of input.project.drawings2d) {
    if (d.levelId !== input.levelId) continue;
    if (!input.visibleCodes.has(d.categoryCode)) continue;
    const g = d.geom;
    if (g.shape === "line") segs.push([g.a, g.b]);
    else if (g.shape === "xline") {
      // Weit verlängert (wie beim Rendern) — Lot-/Nächster-Punkt-Snap soll
      // entlang der ganzen (optisch unendlichen) Linie greifen, nicht nur
      // zwischen den beiden gesetzten Punkten.
      const dx = g.b.x - g.a.x, dy = g.b.y - g.a.y;
      const len = Math.hypot(dx, dy);
      if (len > 1e-6) {
        const ux = dx / len, uy = dy / len, ext = 1000;
        segs.push([
          { x: g.a.x - ux * ext, y: g.a.y - uy * ext },
          { x: g.b.x + ux * ext, y: g.b.y + uy * ext },
        ]);
      }
    }
    else if (g.shape === "polyline") {
      for (let i = 0; i < g.pts.length - 1; i++) segs.push([g.pts[i], g.pts[i + 1]]);
      if (g.closed && g.pts.length > 2) segs.push([g.pts[g.pts.length - 1], g.pts[0]]);
    } else if (g.shape === "rect") {
      const c1 = g.min, c3 = g.max;
      const c2 = { x: g.max.x, y: g.min.y }, c4 = { x: g.min.x, y: g.max.y };
      segs.push([c1, c2], [c2, c3], [c3, c4], [c4, c1]);
    } else if (g.shape === "bezier") {
      const pts = sampleBezierChain(g.pts);
      for (let i = 0; i < pts.length - 1; i++) segs.push([pts[i], pts[i + 1]]);
    } else if (g.shape === "spline") {
      const closed = g.closed && g.pts.length > 2;
      const pts = sampleCatmullRom(g.pts, closed);
      for (let i = 0; i < pts.length - 1; i++) segs.push([pts[i], pts[i + 1]]);
      if (closed) segs.push([pts[pts.length - 1], pts[0]]);
    }
  }
  // Bereits gesetzte Draft-Segmente (Polylinie/Wand im Bau).
  for (let i = 0; i < input.draftPoints.length - 1; i++) {
    segs.push([input.draftPoints[i], input.draftPoints[i + 1]]);
  }
  return segs;
}

/** Kreis-/Bogen-Geometrie für Center-/Quadrant-/Endpunkt-Snaps. `arc=null` =
 *  Vollkreis (keine Endpunkte, alle vier Quadranten). */
interface CircleGeom {
  center: Vec2;
  r: number;
  arc: { a0: number; a1: number } | null;
}

/** Sammelt sichtbare Kreise/Bögen des aktiven Geschosses (aus `drawings2d`). */
function collectCircles(input: SnapInput): CircleGeom[] {
  const out: CircleGeom[] = [];
  for (const d of input.project.drawings2d) {
    if (d.levelId !== input.levelId) continue;
    if (!input.visibleCodes.has(d.categoryCode)) continue;
    const g = d.geom;
    if (g.shape === "circle") out.push({ center: g.center, r: g.r, arc: null });
    else if (g.shape === "arc")
      out.push({ center: g.center, r: g.r, arc: { a0: g.a0, a1: g.a1 } });
  }
  return out;
}

/** Lotfußpunkt von p auf die Strecke a-b, auf das Segment geklemmt. */
function perpFoot(p: Vec2, a: Vec2, b: Vec2): Vec2 {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-12) return a;
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return { x: a.x + dx * t, y: a.y + dy * t };
}

// ── Verweil-Erkennung fürs Teilpunkte-Snapping ("divide") ───────────────────
// Modul-weiter Zustand (wie `lastCoalesceKey` in projectSlice.ts) statt in
// SnapInput/computeSnap-Parametern: computeSnap wird von mehreren, völlig
// unabhängigen Stellen aufgerufen (Zeichnen über die Command-Engine UND die
// älteren Legacy-Werkzeuge, Griff-Ziehen, Transformieren) — der Verweil-
// Zustand muss all diese Aufrufer TEILEN, damit "verweilt der Cursor lange
// genug auf derselben Linie" aufrufer-übergreifend gilt (Nutzer-Wunsch:
// "wenn der Snappunkt eines neuen Elements auch [z. B. 200ms] auf der Linie
// ist, sollten die Teilpunkte auch snapbar sein — aber NUR dann").
let dwellSegKey: string | null = null;
let dwellSince = 0;
let dwellRevealedSeg: Seg | null = null;

const segKey = (seg: Seg): string =>
  `${seg[0].x},${seg[0].y}|${seg[1].x},${seg[1].y}`;

/** Nächstgelegene Strecke zu `raw` innerhalb der Fangtoleranz (Meter), oder null. */
function nearestSegment(raw: Vec2, segs: Seg[], tolM: number): Seg | null {
  let best: Seg | null = null;
  let bestD = tolM;
  for (const seg of segs) {
    const d = dist(perpFoot(raw, seg[0], seg[1]), raw);
    if (d < bestD) {
      bestD = d;
      best = seg;
    }
  }
  return best;
}

/**
 * Verankert/verwirft den Verweil-Zustand für den aktuellen Cursor und liefert
 * die "freigegebene" Strecke (Teilpunkte fangbar), sobald der Cursor lange
 * genug (`delayMs`) auf DERSELBEN Strecke geblieben ist — sonst `null`. Ein
 * Streckenwechsel (auch zu "keine Strecke") setzt die Verweildauer zurück.
 */
function updateDwell(raw: Vec2, segs: Seg[], delayMs: number, tolM: number): Seg | null {
  const seg = nearestSegment(raw, segs, tolM);
  const key = seg ? segKey(seg) : null;
  const now = Date.now();
  if (key !== dwellSegKey) {
    dwellSegKey = key;
    dwellSince = now;
    dwellRevealedSeg = null;
    return null;
  }
  if (seg && dwellRevealedSeg === null && now - dwellSince >= delayMs) {
    dwellRevealedSeg = seg;
  }
  return dwellRevealedSeg;
}

/**
 * Bestimmt den effektiven Snap für den rohen Cursor-Punkt (oder null).
 * Punkt-Snaps haben Vorrang vor Ortho und Raster (Prioritäts-Bonus).
 */
export function computeSnap(input: SnapInput): SnapResult | null {
  const { raw, settings, pxPerMeter, shift, ctrl } = input;
  if (ctrl || !settings.enabled) return null;
  const tolM = settings.tolerancePx / Math.max(pxPerMeter, 1e-6);

  // Bester Kandidat nach (distPx − Prioritäts-Bonus).
  let best: SnapResult | null = null;
  let bestScore = Infinity;
  const consider = (point: Vec2, kind: SnapKind, refA?: Vec2) => {
    const d = dist(point, raw);
    if (d > tolM) return;
    const distPx = d * pxPerMeter;
    const score = distPx - PRIORITY[kind];
    if (score < bestScore) {
      bestScore = score;
      best = { point, kind, distPx, refA };
    }
  };

  const needSegs =
    settings.midpoint || settings.intersection || settings.onEdge || settings.endpoint;
  const segs = needSegs ? collectSegments(input) : [];

  // Teilpunkt-Verweilerkennung: braucht dieselben Strecken wie oben. Ohne sie
  // (alle vier Objekt-Snap-Arten aus) bleibt "divide" ebenfalls inaktiv —
  // konsistent dazu, dass dann ohnehin keine Linien-bezogenen Snaps gelten.
  const revealed = updateDwell(raw, segs, settings.hoverDivideDelayMs, tolM);
  if (revealed) {
    const [a, b] = revealed;
    const n = Math.max(2, Math.round(settings.hoverDivideCount));
    for (let i = 1; i < n; i++) {
      const t = i / n;
      consider({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, "divide");
    }
  }

  // endpoint (Strecken-Endpunkte + Draft-Knoten + Raum-Stempel-Anker).
  if (settings.endpoint) {
    for (const [a, b] of segs) {
      consider(a, "endpoint");
      consider(b, "endpoint");
    }
    for (const p of input.draftPoints) consider(p, "endpoint");
    // Raum-Stempel-Anker (fixer Anker, sonst Flächenschwerpunkt) des Geschosses.
    for (const room of input.project.rooms ?? []) {
      if (room.floorId !== input.levelId) continue;
      if (!input.visibleCodes.has(room.categoryCode)) continue;
      if (room.boundary.length < 3) continue;
      consider(room.stampAnchor ?? roomCentroid(room.boundary), "endpoint");
    }
  }
  // midpoint.
  if (settings.midpoint) {
    for (const [a, b] of segs) consider(mid(a, b), "midpoint");
  }
  // intersection (paarweise Geraden-Schnitt der Strecken, nahe am Cursor).
  if (settings.intersection) {
    for (let i = 0; i < segs.length; i++) {
      for (let j = i + 1; j < segs.length; j++) {
        const [a, b] = segs[i];
        const [c, d] = segs[j];
        const x = lineIntersect(a, { x: b.x - a.x, y: b.y - a.y }, c, {
          x: d.x - c.x,
          y: d.y - c.y,
        });
        if (x) consider(x, "intersection");
      }
    }
  }
  // onEdge (Lotfußpunkt auf nahe Strecken; niedrige Priorität).
  if (settings.onEdge) {
    for (const [a, b] of segs) consider(perpFoot(raw, a, b), "onEdge");
  }

  // Kreis-/Bogen-Snaps: Mittelpunkt + Quadranten (Ost/Nord/West/Süd); bei Bögen
  // nur die Quadranten IM Bogen-Bereich, plus die beiden Bogen-Endpunkte. Center/
  // Quadrant hängen an der `center`-Einstellung, die Endpunkte an `endpoint`.
  if (settings.center || settings.endpoint) {
    const TAU = Math.PI * 2;
    const norm = (x: number) => ((x % TAU) + TAU) % TAU;
    const onCircle = (c: CircleGeom, ang: number): Vec2 => ({
      x: c.center.x + c.r * Math.cos(ang),
      y: c.center.y + c.r * Math.sin(ang),
    });
    for (const c of collectCircles(input)) {
      if (settings.center) {
        consider(c.center, "center");
        // Volle CCW-Spanne (0 ⇒ Vollkreis); Quadrant nur, wenn im Bogen liegt.
        const sweep = c.arc ? norm(c.arc.a1 - c.arc.a0) || TAU : TAU;
        for (let q = 0; q < 4; q++) {
          const ang = q * (Math.PI / 2);
          if (c.arc && norm(ang - c.arc.a0) > sweep + 1e-9) continue;
          consider(onCircle(c, ang), "quadrant");
        }
      }
      if (settings.endpoint && c.arc) {
        consider(onCircle(c, c.arc.a0), "endpoint");
        consider(onCircle(c, c.arc.a1), "endpoint");
      }
    }
    // Ellipse: nur der Mittelpunkt (keine Quadranten — bei gedrehter Ellipse
    // wären die "Achsenpunkte" ohnehin keine Kreis-Quadranten mehr).
    if (settings.center) {
      for (const d of input.project.drawings2d) {
        if (d.levelId !== input.levelId) continue;
        if (!input.visibleCodes.has(d.categoryCode)) continue;
        if (d.geom.shape === "ellipse") consider(d.geom.center, "center");
      }
    }
  }

  if (best) return best;

  // Ortho / Winkelraster (hart, Projektion relativ zum letzten Punkt). Shift
  // erzwingt zusätzlich — beides UNVERÄNDERT gegenüber dem weichen Winkelraster
  // unten, das nur greift, wenn weder Shift noch die Ortho-Einstellung aktiv ist.
  if ((settings.ortho || shift) && input.lastPoint) {
    const point = applyAngleConstraint(input.lastPoint, raw, settings.angleStep);
    return { point, kind: "ortho", refA: input.lastPoint, distPx: 0 };
  }

  // Weiches Winkelraster (gängige Winkel, 15°-Vielfache) — nur wenn kein
  // Objekt-Snap UND kein harter Ortho-Zwang gegriffen hat (Vorrang-Reihenfolge).
  if (settings.commonAngles && input.lastPoint) {
    const snapped = snapCommonAngle(input.lastPoint, raw, settings.commonAngleTolerance);
    if (snapped) {
      return {
        point: snapped.point,
        kind: "angle",
        refA: input.lastPoint,
        angleDeg: snapped.angleDeg,
        distPx: 0,
      };
    }
  }

  // Raster.
  if (settings.grid) {
    const g = snapToGrid(raw, settings.gridSize);
    if (dist(g, raw) <= tolM) {
      return { point: g, kind: "grid", distPx: dist(g, raw) * pxPerMeter };
    }
  }

  return null;
}

/** Projiziert `to` auf die nächste erlaubte Richtung vom Punkt `from`. */
export function applyAngleConstraint(from: Vec2, to: Vec2, stepDeg: number): Vec2 {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const ang = Math.atan2(dy, dx);
  const step = (stepDeg * Math.PI) / 180;
  const k = Math.round(ang / step) * step;
  const len = Math.hypot(dx, dy);
  return { x: from.x + Math.cos(k) * len, y: from.y + Math.sin(k) * len };
}

/** Rundet einen Punkt auf das Raster (Meter). */
function snapToGrid(p: Vec2, size: number): Vec2 {
  if (!(size > 0)) return p;
  return { x: Math.round(p.x / size) * size, y: Math.round(p.y / size) * size };
}

/** Winkel (Grad) auf den Bereich (−180,180] normalisieren (VW-Konvention). */
function normalizeAngleDeg(deg: number): number {
  let a = deg % 360;
  if (a <= -180) a += 360;
  if (a > 180) a -= 360;
  return a;
}

/** Schrittweite des weichen Winkelrasters: deckt 0/15/30/45/60/75/90/… ab. */
const COMMON_ANGLE_STEP_DEG = 15;

/**
 * Weiches Winkel-Einrasten (Vectorworks-Stil): rastet den Roh-Winkel von `from`
 * nach `raw` auf den NÄCHSTEN gängigen Winkel (15°-Vielfache), wenn die
 * Abweichung ≤ `toleranceDeg` — sonst `null`. Die LÄNGE bleibt die Roh-Distanz,
 * projiziert auf den gerasterten Strahl (nicht die rohe Luftlinie). Reine
 * Geometrie, unabhängig von Objekt-Snaps/Settings (Integration in
 * {@link computeSnap} entscheidet über den Vorrang).
 */
export function snapCommonAngle(
  from: Vec2,
  raw: Vec2,
  toleranceDeg = 2.5,
): { point: Vec2; angleDeg: number } | null {
  const dx = raw.x - from.x;
  const dy = raw.y - from.y;
  const rawLen = Math.hypot(dx, dy);
  if (rawLen < 1e-9) return null;
  const rawAngleDeg = (Math.atan2(dy, dx) * 180) / Math.PI; // bereits (−180,180]
  const snappedRaw = Math.round(rawAngleDeg / COMMON_ANGLE_STEP_DEG) * COMMON_ANGLE_STEP_DEG;
  const delta = snappedRaw - rawAngleDeg; // klein (≤ halbe Schrittweite), keine Wraparound-Sorgen
  if (Math.abs(delta) > toleranceDeg) return null;
  const angleDeg = normalizeAngleDeg(snappedRaw);
  const rad = (angleDeg * Math.PI) / 180;
  const length = rawLen * Math.cos((delta * Math.PI) / 180); // Projektion auf den Strahl
  const point = { x: from.x + Math.cos(rad) * length, y: from.y + Math.sin(rad) * length };
  return { point, angleDeg };
}
