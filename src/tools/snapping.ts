// Snapping (docs/design/drawing-tools.md §5). Läuft auf jedem Pointer-Move
// BEVOR der Punkt an das Werkzeug geht: sammelt Snap-Kandidaten, wählt den
// besten innerhalb der Bildschirm-Toleranz und liefert Marker-Info.
//
// Phase 2: endpoint · midpoint · intersection · onEdge (Lot) · grid · ortho.
// Prioritäts-Reihenfolge (Vorrang bei nahem Abstand): endpoint > intersection >
// midpoint > onEdge > grid; ortho/Winkelraster ist eine Projektion (überlagert).

import type { Drawing2D, Project, Vec2, Wall } from "../model/types";
import { getWallType, wallTypeThickness } from "../model/types";
import { add, leftNormal, lineIntersect, normalize, scale, sub } from "../model/geometry";
import { wallReferenceOffset } from "../model/wall";
import { centroid as roomCentroid } from "../core";
import { columnFootprint } from "../core";
import { stairOutline } from "../core";
import type { SnapKind, SnapResult, SnapSettings } from "./types";
import { sampleBezierChain, sampleCatmullRom, sampleUniformBSpline } from "../core";
import { buildDrawingIndex, drawingsNear, isIndexable, pointSegDist__geometry_drawingIndex as pointSegDist, type DrawingIndex } from "../core";
import { sheetSnapSegments } from "./sheetSnapGeometry";

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
  perpendicular: 1,
  tangent: 1,
  parallel: 1,
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

/** Kanten eines geschlossenen Polygons (Schlusspunkt nicht dupliziert). */
function closedPolySegs(pts: Vec2[]): Seg[] {
  const segs: Seg[] = [];
  for (let i = 0; i < pts.length - 1; i++) segs.push([pts[i], pts[i + 1]]);
  if (pts.length > 2) segs.push([pts[pts.length - 1], pts[0]]);
  return segs;
}

/** Strecken EINER Zeichnung (Fangkandidaten), je nach Form. */
function drawingSegs(d: Drawing2D, segs: Seg[]): void {
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
  else if (g.shape === "ray") {
    // Wie xline, aber NUR über `b` hinaus verlängert (Anker `a` bleibt fest).
    const dx = g.b.x - g.a.x, dy = g.b.y - g.a.y;
    const len = Math.hypot(dx, dy);
    if (len > 1e-6) {
      const ux = dx / len, uy = dy / len, ext = 1000;
      segs.push([g.a, { x: g.b.x + ux * ext, y: g.b.y + uy * ext }]);
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
    const pts = g.mode === "control" ? sampleUniformBSpline(g.pts, closed) : sampleCatmullRom(g.pts, closed);
    for (let i = 0; i < pts.length - 1; i++) segs.push([pts[i], pts[i + 1]]);
    if (closed) segs.push([pts[pts.length - 1], pts[0]]);
  }
}

/** Kreise/Bögen/Ellipsen & Co.: bei grossen Projekten ohne die vielen Linien. */
function nonLineDrawings(all: readonly Drawing2D[]): readonly Drawing2D[] {
  return all.length > LARGE_DRAWINGS ? getSnapIndex(all).others : all;
}

/** Ab so vielen Zeichnungen: nur Strecken in Cursornähe (Raster-Index) statt aller. */
const LARGE_DRAWINGS = 2000;

interface SnapDrawingIndex {
  /** Linien/Polylinien (Massenfall), räumlich indiziert. */
  index: DrawingIndex | null;
  /** Alle übrigen Formen (Kreis, Bogen, Rechteck, Spline, …) — wenige, immer geprüft. */
  others: Drawing2D[];
}
const snapIndexCache = new WeakMap<readonly Drawing2D[], SnapDrawingIndex>();
/** Index je `drawings2d`-Array-Identität (Projekt-Updates teilen unveränderte Arrays). */
function getSnapIndex(drawings: readonly Drawing2D[]): SnapDrawingIndex {
  let c = snapIndexCache.get(drawings);
  if (!c) {
    const indexable: Drawing2D[] = [];
    const others: Drawing2D[] = [];
    for (const d of drawings) (isIndexable(d) ? indexable : others).push(d);
    c = { index: buildDrawingIndex(indexable), others };
    snapIndexCache.set(drawings, c);
  }
  return c;
}

/**
 * Zeichnungen des Geschosses, die für den Fang in Frage kommen: bei grossen
 * Projekten (Kataster-Import, ~10^5 Zeichnungen) nur die in `r` Umkreis von `at`
 * (+ alle Nicht-Linien-Formen), sonst alle.
 */
function snapDrawings(input: SnapInput, near?: { at: Vec2; r: number }): Drawing2D[] {
  const all = input.project.drawings2d;
  const ok = (d: Drawing2D) => d.levelId === input.levelId && input.visibleCodes.has(d.categoryCode);
  const out: Drawing2D[] = [];
  if (near && all.length > LARGE_DRAWINGS) {
    const c = getSnapIndex(all);
    if (c.index) {
      for (const i of drawingsNear(c.index, near.at, near.r)) {
        const d = c.index.drawings[i];
        if (ok(d)) out.push(d);
      }
    }
    for (const d of c.others) if (ok(d)) out.push(d);
    return out;
  }
  for (const d of all) if (ok(d)) out.push(d);
  return out;
}

/** Sammelt alle sichtbaren Strecken des Geschosses (Wandachsen + 2D-Segmente). */
function collectSegments(input: SnapInput, near?: { at: Vec2; r: number }): Seg[] {
  const segs: Seg[] = [];
  for (const w of input.project.walls) {
    if (w.floorId !== input.levelId) continue;
    if (!input.visibleCodes.has(w.categoryCode)) continue;
    segs.push([w.start, w.end]);
    for (const seg of wallLayerBoundarySegments(input.project, w)) segs.push(seg);
  }
  // Raum-/Decken-/Dach-/Treppen-/Stützen-Umrisse: bisher komplett blind (nur
  // der Raum-Stempel-Anker war als Endpunkt fangbar, s. u.) — eine Wand oder
  // Bemassung liess sich nicht bündig an eine Raum-/Dachkante setzen.
  for (const room of input.project.rooms ?? []) {
    if (room.floorId !== input.levelId) continue;
    if (!input.visibleCodes.has(room.categoryCode)) continue;
    segs.push(...closedPolySegs(room.boundary));
  }
  for (const c of input.project.ceilings ?? []) {
    if (c.floorId !== input.levelId) continue;
    if (!input.visibleCodes.has(c.categoryCode)) continue;
    segs.push(...closedPolySegs(c.outline));
    for (const hole of c.openings ?? []) segs.push(...closedPolySegs(hole));
  }
  for (const r of input.project.roofs ?? []) {
    if (r.floorId !== input.levelId) continue;
    if (!input.visibleCodes.has(r.categoryCode)) continue;
    segs.push(...closedPolySegs(r.outline));
  }
  for (const s of input.project.stairs ?? []) {
    if (s.floorId !== input.levelId) continue;
    if (!input.visibleCodes.has(s.categoryCode)) continue;
    const { polygon, spiral } = stairOutline(s, 0);
    if (polygon) segs.push(...closedPolySegs(polygon));
    else if (spiral) for (const line of spiral.lines) segs.push(line); // Innen-/Aussenbögen s. collectCircles
  }
  for (const col of input.project.columns ?? []) {
    if (col.floorId !== input.levelId) continue;
    if (!input.visibleCodes.has(col.categoryCode)) continue;
    if (col.profile.kind === "rect") segs.push(...closedPolySegs(columnFootprint(col)));
    // Runde Stützen: s. collectCircles (Zentrum/Quadranten statt Vieleck-Kanten).
  }
  for (const d of snapDrawings(input, near)) drawingSegs(d, segs);
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

/**
 * Sammelt sichtbare Kreise/Bögen des aktiven Geschosses: `drawings2d`
 * (circle/arc), runde Stützen (Zentrum/Quadranten statt Vieleck-Näherung)
 * und die Innen-/Aussenbögen von Wendeltreppen (s. `stairOutline`).
 */
function collectCircles(input: SnapInput): CircleGeom[] {
  const out: CircleGeom[] = [];
  for (const d of nonLineDrawings(input.project.drawings2d)) {
    if (d.levelId !== input.levelId) continue;
    if (!input.visibleCodes.has(d.categoryCode)) continue;
    const g = d.geom;
    if (g.shape === "circle") out.push({ center: g.center, r: g.r, arc: null });
    else if (g.shape === "arc")
      out.push({ center: g.center, r: g.r, arc: { a0: g.a0, a1: g.a1 } });
  }
  for (const col of input.project.columns ?? []) {
    if (col.floorId !== input.levelId) continue;
    if (!input.visibleCodes.has(col.categoryCode)) continue;
    if (col.profile.kind === "round") {
      out.push({ center: col.position, r: col.profile.radius, arc: null });
    }
  }
  for (const s of input.project.stairs ?? []) {
    if (s.floorId !== input.levelId) continue;
    if (!input.visibleCodes.has(s.categoryCode)) continue;
    const { spiral } = stairOutline(s, 0);
    if (!spiral) continue;
    for (const a of spiral.arcs) {
      out.push({ center: { x: a.cx, y: a.cy }, r: a.r, arc: { a0: a.a0, a1: a.a1 } });
    }
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

/**
 * „Erfasste" Parallel-Referenz — bewusst SEPARAT vom obigen `dwellRevealedSeg`:
 * "divide" soll seine Teilpunkte NUR zeigen, solange der Cursor tatsächlich
 * auf der Linie bleibt (reine Hover-Sichtbarkeitshilfe), aber „parallel"
 * braucht die Referenzrichtung gerade dann noch, wenn der Cursor die Linie
 * schon längst wieder VERLASSEN hat (Richtung Ziel-Punkt). Wird gesetzt,
 * sobald "divide"s Verweil-Erkennung eine Strecke freigibt UND `parallel`
 * aktiv ist — bleibt danach bestehen, bis eine ANDERE Strecke neu erfasst
 * wird (kein Reset beim blossen Wegbewegen).
 */
let acquiredParallelSeg: Seg | null = null;

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
    settings.midpoint ||
    settings.intersection ||
    settings.onEdge ||
    settings.endpoint ||
    settings.perpendicular ||
    settings.parallel;
  // Bei grossen Projekten (Kataster-Import: ~10^5 Zeichnungen, Mio. Strecken) NUR
  // die Strecken in Cursornähe — vorher wurde bei JEDER Mausbewegung die ganze
  // Liste gebaut und der Schnittpunkt-Fang prüfte ALLE Paare (O(N²): die Seite
  // blockierte beim ersten Klick eines Zeichenwerkzeugs). Kleine Projekte bleiben
  // exakt wie bisher.
  const nearMode = input.project.drawings2d.length > LARGE_DRAWINGS;
  const intRadius = tolM * 6;
  let segs: Seg[] = [];
  let intSegs: Seg[] = [];
  if (needSegs) {
    if (nearMode) {
      const cand = collectSegments(input, { at: raw, r: intRadius });
      const withDist = cand
        .map((seg) => ({ seg, d: pointSegDist(raw, seg[0], seg[1]) }))
        .filter((e) => e.d <= intRadius)
        .sort((x, y) => x.d - y.d);
      segs = withDist.filter((e) => e.d <= tolM).map((e) => e.seg);
      // Schnittpunkte nur unter den nächsten Strecken (paarweise → quadratisch).
      intSegs = withDist.slice(0, 64).map((e) => e.seg);
    } else {
      segs = collectSegments(input);
      intSegs = segs;
    }
    // Abgeleitete Blatt-Geometrie (Schnitt/Ansicht, s. sheetSnapGeometry.ts):
    // nur die Strecken in Cursornähe — eine Ansicht hat schnell Tausende Kanten,
    // der paarweise Schnittpunkt-Fang bliebe sonst nicht flüssig.
    const sheet = sheetSnapSegments(input.levelId);
    if (sheet.length > 0) {
      const near = sheet
        .map((seg) => ({ seg, d: pointSegDist(raw, seg[0], seg[1]) }))
        .filter((e) => e.d <= intRadius)
        .sort((x, y) => x.d - y.d)
        .slice(0, 64)
        .map((e) => e.seg);
      if (near.length > 0) {
        const shared = intSegs === segs;
        segs = segs.concat(near);
        intSegs = shared ? segs : intSegs.concat(near);
      }
    }
  }

  // Teilpunkt-Verweilerkennung: braucht dieselben Strecken wie oben. Ohne sie
  // (alle Objekt-Snap-Arten aus) bleiben "divide"/"parallel" ebenfalls inaktiv
  // — konsistent dazu, dass dann ohnehin keine Linien-bezogenen Snaps gelten.
  const revealed = updateDwell(raw, segs, settings.hoverDivideDelayMs, tolM);
  if (revealed) {
    const [a, b] = revealed;
    const n = Math.max(2, Math.round(settings.hoverDivideCount));
    for (let i = 1; i < n; i++) {
      const t = i / n;
      consider({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, "divide");
    }
  }

  // parallel: sobald "divide"s Verweil-Erkennung eine Strecke freigibt,
  // dieselbe Strecke zusätzlich als STICKY Parallel-Referenz übernehmen (s.
  // Kommentar bei `acquiredParallelSeg` — bleibt bestehen, auch wenn der
  // Cursor die Linie danach wieder verlässt).
  if (settings.parallel && revealed) acquiredParallelSeg = revealed;

  // parallel: die erfasste Referenzstrecke liefert nur die RICHTUNG — der
  // Fangpunkt liegt auf der Parallelen DURCH den letzten gesetzten Punkt, an
  // der Stelle, die dem Cursor am nächsten ist (Projektion von `raw` auf
  // diese Gerade).
  if (settings.parallel && input.lastPoint && acquiredParallelSeg) {
    const [ra, rb] = acquiredParallelSeg;
    const dirX = rb.x - ra.x;
    const dirY = rb.y - ra.y;
    const dirLen = Math.hypot(dirX, dirY);
    if (dirLen > 1e-9) {
      const ux = dirX / dirLen;
      const uy = dirY / dirLen;
      const vx = raw.x - input.lastPoint.x;
      const vy = raw.y - input.lastPoint.y;
      const t = vx * ux + vy * uy;
      consider(
        { x: input.lastPoint.x + ux * t, y: input.lastPoint.y + uy * t },
        "parallel",
        input.lastPoint,
      );
    }
  }

  // perpendicular: Lotfusspunkt VOM LETZTEN PUNKT (nicht vom Cursor wie
  // "onEdge") auf nahe Strecken — die Strecke lastPoint→Fangpunkt steht im
  // rechten Winkel zur Referenz-Strecke.
  if (settings.perpendicular && input.lastPoint) {
    for (const [a, b] of segs) {
      consider(perpFoot(input.lastPoint, a, b), "perpendicular", input.lastPoint);
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
    for (let i = 0; i < intSegs.length; i++) {
      for (let j = i + 1; j < intSegs.length; j++) {
        const [a, b] = intSegs[i];
        const [c, d] = intSegs[j];
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
  // Quadrant hängen an der `center`-Einstellung, die Endpunkte an `endpoint`,
  // die Tangentenpunkte an `tangent` (+ zwingend `lastPoint`).
  if (settings.center || settings.endpoint || settings.tangent) {
    const TAU = Math.PI * 2;
    const norm = (x: number) => ((x % TAU) + TAU) % TAU;
    const onCircle = (c: CircleGeom, ang: number): Vec2 => ({
      x: c.center.x + c.r * Math.cos(ang),
      y: c.center.y + c.r * Math.sin(ang),
    });
    const inArc = (c: CircleGeom, ang: number): boolean => {
      if (!c.arc) return true;
      const sweep = norm(c.arc.a1 - c.arc.a0) || TAU;
      return norm(ang - c.arc.a0) <= sweep + 1e-9;
    };
    for (const c of collectCircles(input)) {
      if (settings.center) {
        consider(c.center, "center");
        // Volle CCW-Spanne (0 ⇒ Vollkreis); Quadrant nur, wenn im Bogen liegt.
        for (let q = 0; q < 4; q++) {
          const ang = q * (Math.PI / 2);
          if (inArc(c, ang)) consider(onCircle(c, ang), "quadrant");
        }
      }
      if (settings.endpoint && c.arc) {
        consider(onCircle(c, c.arc.a0), "endpoint");
        consider(onCircle(c, c.arc.a1), "endpoint");
      }
      // Tangente von aussen (lastPoint) an den Kreis: klassische Konstruktion
      // — zwei Lösungen, Dreieck center/lastPoint/Tangentenpunkt ist bei T
      // rechtwinklig, daher angAtC = acos(r/d) der Winkel zwischen center→
      // lastPoint und center→T. Innerhalb/auf dem Kreis (d ≤ r) gibt es keine
      // Tangente von aussen.
      if (settings.tangent && input.lastPoint) {
        const dx = input.lastPoint.x - c.center.x;
        const dy = input.lastPoint.y - c.center.y;
        const d = Math.hypot(dx, dy);
        if (d > c.r + 1e-9) {
          const thetaCP = Math.atan2(dy, dx);
          const angAtC = Math.acos(Math.min(1, c.r / d));
          for (const sign of [1, -1]) {
            const ang = thetaCP + sign * angAtC;
            if (inArc(c, ang)) consider(onCircle(c, ang), "tangent", input.lastPoint);
          }
        }
      }
    }
    // Ellipse: nur der Mittelpunkt (keine Quadranten — bei gedrehter Ellipse
    // wären die "Achsenpunkte" ohnehin keine Kreis-Quadranten mehr).
    if (settings.center) {
      for (const d of nonLineDrawings(input.project.drawings2d)) {
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
