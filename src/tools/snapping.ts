// Snapping (docs/design/drawing-tools.md §5). Läuft auf jedem Pointer-Move
// BEVOR der Punkt an das Werkzeug geht: sammelt Snap-Kandidaten, wählt den
// besten innerhalb der Bildschirm-Toleranz und liefert Marker-Info.
//
// Phase 2: endpoint · midpoint · intersection · onEdge (Lot) · grid · ortho.
// Prioritäts-Reihenfolge (Vorrang bei nahem Abstand): endpoint > intersection >
// midpoint > onEdge > grid; ortho/Winkelraster ist eine Projektion (überlagert).

import type { Project, Vec2 } from "../model/types";
import type { SnapKind, SnapResult, SnapSettings } from "./types";
import { pointSegDist__geometry_drawingIndex as pointSegDist } from "../core";
import { sheetSnapSegments } from "./sheetSnapGeometry";
import { holdModelSnap, queryModelSnap, type ModelSnapCand } from "../core";

const dist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);

/** Bildschirm-px-Bonus je Snap-Art: höher = gewinnt knappe Vergleiche (Kern: `snap.rs::priority`). */
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

/** Eine Strecke als Snap-Quelle (Entwurf, Blatt-Geometrie, Verweil-Referenz). */
type Seg = [Vec2, Vec2];

/** Bereits gesetzte Draft-Segmente (Polylinie/Wand im Bau). */
function draftSegments(input: SnapInput): Seg[] {
  const segs: Seg[] = [];
  for (let i = 0; i < input.draftPoints.length - 1; i++) {
    segs.push([input.draftPoints[i], input.draftPoints[i + 1]]);
  }
  return segs;
}

/**
 * Nummer der im Kern gesammelten Fang-Kandidaten je Projekt/Geschoss/Sichtbarkeit (`modelSnap.ts`):
 * ohne Kern-Aufruf, solange dasselbe Projekt-Objekt gefragt wird; nach einer Änderung liefert der
 * Kern dieselbe Nummer, wenn die betroffenen Felder gleich geblieben sind.
 */
interface LevelHold {
  project: Project;
  levelId: string;
  codes: Set<string>;
  held: number;
}
const levelHolds: LevelHold[] = [];
const MAX_LEVEL_HOLDS = 4;
function levelHold(input: SnapInput, fresh: boolean): number {
  let e = levelHolds.find((h) => h.project === input.project && h.levelId === input.levelId && h.codes === input.visibleCodes);
  if (e && !fresh) return e.held;
  const held = holdModelSnap(input.project, input.levelId, input.visibleCodes);
  if (!e) {
    e = { project: input.project, levelId: input.levelId, codes: input.visibleCodes, held };
    levelHolds.push(e);
    if (levelHolds.length > MAX_LEVEL_HOLDS) levelHolds.shift();
  }
  e.held = held;
  return held;
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

/**
 * Verankert/verwirft den Verweil-Zustand für den aktuellen Cursor und liefert
 * die "freigegebene" Strecke (Teilpunkte fangbar), sobald der Cursor lange
 * genug (`delayMs`) auf DERSELBEN Strecke geblieben ist — sonst `null`. Ein
 * Streckenwechsel (auch zu "keine Strecke") setzt die Verweildauer zurück.
 * `seg` ist die nächste Strecke innerhalb der Fangtoleranz (aus dem Kern) oder null.
 */
function updateDwell(seg: Seg | null, delayMs: number): Seg | null {
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
  // Abgeleitete Blatt-Geometrie (Schnitt/Ansicht, s. sheetSnapGeometry.ts): nur die Strecken in
  // Cursornähe — eine Ansicht hat schnell Tausende Kanten, der paarweise Schnittpunkt-Fang bliebe
  // sonst nicht flüssig.
  let sheetNear: Seg[] = [];
  if (needSegs) {
    const sheet = sheetSnapSegments(input.levelId);
    if (sheet.length > 0) {
      const intRadius = tolM * 6;
      sheetNear = sheet
        .map((seg) => ({ seg, d: pointSegDist(raw, seg[0], seg[1]) }))
        .filter((e) => e.d <= intRadius)
        .sort((x, y) => x.d - y.d)
        .slice(0, 64)
        .map((e) => e.seg);
    }
  }
  // Modell-Fang im Kern (`modelSnap.ts`): Strecken (Lot, Endpunkte, Mitte, Schnitt, Kante, nächste
  // Strecke), Raum-Anker, Kreise/Bögen/Ellipsen; bei grossen Projekten (> 2000 Zeichnungen) nur die
  // Strecken in Cursornähe.
  const q = {
    raw,
    tolM,
    pxPerMeter,
    segs: needSegs,
    perpendicular: settings.perpendicular,
    endpoint: settings.endpoint,
    midpoint: settings.midpoint,
    intersection: settings.intersection,
    onEdge: settings.onEdge,
    center: settings.center,
    tangent: settings.tangent,
    lastPoint: input.lastPoint,
  };
  const draft = needSegs ? draftSegments(input) : [];
  let m = queryModelSnap(levelHold(input, false), draft, sheetNear, q);
  // Abgelegte Kandidaten verdrängt: neu ablegen und nochmals.
  if (!m) m = queryModelSnap(levelHold(input, true), draft, sheetNear, q);
  // Kern-Kandidat übernehmen, wenn er besser ist (gleiche Regel wie `consider`).
  const offer = (c: ModelSnapCand | null | undefined) => {
    if (c && c.score < bestScore) {
      bestScore = c.score;
      const ref = c.kind === "perpendicular" || c.kind === "tangent" ? input.lastPoint ?? undefined : undefined;
      best = { point: c.point, kind: c.kind, distPx: c.distPx, refA: ref };
    }
  };

  // Teilpunkt-Verweilerkennung: braucht dieselben Strecken wie oben. Ohne sie
  // (alle Objekt-Snap-Arten aus) bleiben "divide"/"parallel" ebenfalls inaktiv
  // — konsistent dazu, dass dann ohnehin keine Linien-bezogenen Snaps gelten.
  const revealed = updateDwell(m?.nearest ?? null, settings.hoverDivideDelayMs);
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
  // rechten Winkel zur Referenz-Strecke; dann die Strecken-Endpunkte (Kern, Block A).
  offer(m?.a);

  // endpoint: Draft-Knoten, dann Raum-Stempel-Anker (Kern).
  if (settings.endpoint) {
    for (const p of input.draftPoints) consider(p, "endpoint");
    offer(m?.anchors);
  }
  // midpoint, intersection (paarweise Geraden-Schnitt der Strecken, nahe am Cursor), onEdge
  // (Lotfußpunkt auf nahe Strecken; niedrige Priorität) — Kern, Block B.
  offer(m?.b);

  // Kreis-/Bogen-Snaps (Kern): Mittelpunkt + Quadranten (nur im Bogen-Bereich), Bogen-Endpunkte,
  // Tangentenpunkte vom letzten Punkt; Ellipsen nur Mittelpunkt.
  offer(m?.c);

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
