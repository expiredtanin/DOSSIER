// Geometrie-Helfer für Treppen (Stairs) — reine Funktionen über `Vec2`, kein
// externer Kernel. Aus einer `Stair` (gerade/L/Wendel) werden abgeleitet:
//   • die Tritt-Rechtecke im Grundriss (jeweils mit ihrer Z-Höhe der Setzstufe),
//   • das Zwischenpodest-Polygon (L / Wendel-Auge),
//   • die Lauflinie (Polyline) + der Auf-/Abpfeil,
//   • die Schnittposition (welche Tritte unter/über der Grundriss-Schnitthöhe
//     liegen → im Plan durchgezogen vs. gestrichelt) samt SIA-Bruchlinie.
//
// Die 3D-Darstellung baut aus denselben Tritt-Rechtecken + Setzstufen-Höhen die
// Stufenboxen (siehe Viewport3D). So bleiben Plan und 3D konsistent aus EINER
// Quelle abgeleitet.
//
// Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

import type { Stair, Vec2 } from "../model/types";

const DEG = Math.PI / 180;

const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
const scale = (a: Vec2, s: number): Vec2 => ({ x: a.x * s, y: a.y * s });
const lenOf = (a: Vec2): number => Math.hypot(a.x, a.y);
const norm = (a: Vec2): Vec2 => {
  const l = lenOf(a) || 1e-9;
  return { x: a.x / l, y: a.y / l };
};
/** Linke Normale (n = (−u.y, u.x)) — quer zur Laufrichtung. */
const leftN = (u: Vec2): Vec2 => ({ x: -u.y, y: u.x });

/**
 * Perp-Versatz von der Referenzkante zur visuellen Treppen-MITTE, entlang der
 * linken Normale `n = leftN(u)`. Entspricht `mid_off` aus `_treppe_2d_side_offsets`
 * im Rhino-Plugin (Konvention: `perp` = CCW-Normale = linke Normale):
 *   • referenz "links"  → Achse ist die LINKE Kante; die Mitte liegt eine
 *     halbe Breite in −n-Richtung (rechts) → mid_off = −width/2.
 *   • referenz "rechts" → Achse ist die RECHTE Kante; die Mitte liegt eine
 *     halbe Breite in +n-Richtung (links) → mid_off = +width/2.
 *   • referenz "mitte"/undefined → Achse ist bereits die Mitte → 0.
 *
 * ANNAHME (selbstkritisch): „links" heisst „linke Kante in Laufrichtung", und die
 * linke Kante liegt in +n (n = leftN(u), 90° links der Laufrichtung). Von der
 * linken Kante zur Mitte geht es also nach −n, daher mid_off = −width/2. Das
 * deckt sich mit `_treppe_2d_side_offsets` (referenz="links" → off_a=0, off_b=−b,
 * Mitte = −b/2·perp). Wird die Richtung im UI als seitenverkehrt empfunden, ist
 * hier das Vorzeichen zu drehen — die Geometrie bleibt in sich konsistent.
 */
function referenzMidShift(stair: Stair, u: Vec2): Vec2 {
  const ref = stair.referenz ?? "mitte";
  if (ref === "mitte") return { x: 0, y: 0 };
  const n = leftN(u);
  const halfW = Math.max(0.05, stair.width / 2);
  const midOff = ref === "links" ? -halfW : halfW;
  return scale(n, midOff);
}

/** SIA-nahe Schrittregel: gute Steigungshöhe ≈ 0.17 m, Auftritt ≈ 0.29 m. */
export const IDEAL_RISER = 0.17;
export const IDEAL_TREAD = 0.29;
export const MIN_STEPS = 2;

/**
 * Sinnvolle Default-Stufenzahl aus Steighöhe + verfügbarer Lauflänge: möglichst
 * nahe an der idealen Steigungshöhe, gedeckelt durch die Lauflänge (min.
 * Auftritt ~0.24 m). Immer ≥ MIN_STEPS.
 */
export function defaultStepCount(totalRise: number, runLength: number): number {
  const byRise = Math.max(MIN_STEPS, Math.round(totalRise / IDEAL_RISER));
  // Auftrittstiefe = runLength / (steps − 1); mind. 0.24 m halten.
  const maxByRun = runLength > 0 ? Math.max(MIN_STEPS, Math.floor(runLength / 0.24) + 1) : byRise;
  return Math.max(MIN_STEPS, Math.min(byRise, maxByRun));
}

/** Ein Tritt im Grundriss (Rechteck-Polygon) samt Setzstufen-Z (Oberkante). */
export interface TreadRect {
  /** Vier Eckpunkte (CCW), Grundriss-Meter. */
  pts: Vec2[];
  /** Index der Stufe (0 = unterste). */
  index: number;
  /** Oberkante dieses Tritts relativ zur Treppen-UK (Meter). */
  topRise: number;
  /** Unterkante-Höhe (Setzstufe darunter) relativ zur UK (Meter). */
  baseRise: number;
}

/** Vollständige, abgeleitete Treppengeometrie (Plan + 3D + Schnitt). */
export interface StairGeometry {
  /** Alle Tritt-Rechtecke (untere → obere Stufe). */
  treads: TreadRect[];
  /** Zwischenpodest-Polygon (L/Wendel) oder null (gerade). */
  landing: Vec2[] | null;
  /** Setzstufen-Höhe (Meter). */
  riserHeight: number;
  /** Auftrittstiefe (Meter) des geraden Laufs. */
  treadDepth: number;
  /** Lauflinie als Polyline (Meter) — Mitte des Laufs, Start → Austritt. */
  runLine: Vec2[];
  /** Auf-/Abpfeil-Geometrie (Schaft + zwei Spitzenflügel). */
  arrow: { shaft: [Vec2, Vec2]; head: [Vec2, Vec2, Vec2] };
  /** Gesamt-Steighöhe (Meter). */
  totalRise: number;
}

/** Rechteck-Tritt zwischen Achsparametern a0..a1 entlang `dir`, Breite `width`. */
function treadRect(
  origin: Vec2,
  dir: Vec2,
  n: Vec2,
  a0: number,
  a1: number,
  halfW: number,
): Vec2[] {
  const p0 = add(origin, scale(dir, a0));
  const p1 = add(origin, scale(dir, a1));
  return [
    add(p0, scale(n, halfW)),
    add(p1, scale(n, halfW)),
    add(p1, scale(n, -halfW)),
    add(p0, scale(n, -halfW)),
  ];
}

/**
 * Leitet die vollständige Geometrie einer Treppe ab. `totalRise` MUSS vom
 * Aufrufer aufgelöst übergeben werden (Geschosshöhe-Default liegt in
 * `stairVerticalExtent`), damit dieses Modul three-/projektfrei bleibt.
 */
export function stairGeometry(stair: Stair, totalRise: number): StairGeometry {
  const steps = Math.max(MIN_STEPS, Math.round(stair.stepCount));
  const riserHeight = totalRise / steps;
  const halfW = Math.max(0.05, stair.width / 2);
  const u = norm(stair.dir);
  const n = leftN(u);

  // Referenz (links/mitte/rechts): die gespeicherte Achse wird auf die visuelle
  // Treppen-MITTE versetzt, danach greift die bestehende, um die Achse zentrierte
  // Tritt-/Lauflinien-Logik unverändert. So bleibt die Lauflinie samt Pfeil stets
  // auf der Mitte (nicht auf der Referenzkante). "mitte"/undefined ⇒ Nullversatz.
  const c = referenzMidShift(stair, u);
  const s = stair.referenz && stair.referenz !== "mitte"
    ? { ...stair, start: add(stair.start, c), center: stair.center ? add(stair.center, c) : stair.center }
    : stair;

  if (s.shape === "spiral") {
    return spiralGeometry(s, totalRise, steps, riserHeight, halfW);
  }
  if (s.shape === "L") {
    return lGeometry(s, totalRise, steps, riserHeight, halfW, u, n);
  }
  return straightGeometry(s, totalRise, steps, riserHeight, halfW, u, n);
}

/** Gerade Treppe: gleich breite Tritte über die Lauflänge. */
function straightGeometry(
  stair: Stair,
  totalRise: number,
  steps: number,
  riserHeight: number,
  halfW: number,
  u: Vec2,
  n: Vec2,
): StairGeometry {
  const runLength = Math.max(0.1, stair.runLength);
  const treadDepth = runLength / steps;
  const treads: TreadRect[] = [];
  for (let i = 0; i < steps; i++) {
    treads.push({
      pts: treadRect(stair.start, u, n, i * treadDepth, (i + 1) * treadDepth, halfW),
      index: i,
      baseRise: i * riserHeight,
      topRise: (i + 1) * riserHeight,
    });
  }
  const runLine: Vec2[] = [
    add(stair.start, scale(u, treadDepth * 0.5)),
    add(stair.start, scale(u, runLength - treadDepth * 0.15)),
  ];
  return {
    treads,
    landing: null,
    riserHeight,
    treadDepth,
    runLine,
    arrow: arrowFor(runLine, stair.up !== false),
    totalRise,
  };
}

/** L-Treppe: zwei Läufe + quadratisches Zwischenpodest an der Ecke. */
function lGeometry(
  stair: Stair,
  totalRise: number,
  steps: number,
  riserHeight: number,
  halfW: number,
  u: Vec2,
  n: Vec2,
): StairGeometry {
  const run1 = Math.max(0.1, stair.runLength);
  const run2 = Math.max(0.1, stair.run2Length ?? stair.runLength);
  const turn = stair.turn ?? 1;
  // Podest quadratisch (Kantenlänge = Laufbreite) am Ende des ersten Laufs.
  const podest = 2 * halfW;
  // Stufen auf beide Läufe verteilen (grob proportional zur Lauflänge), ein Tritt
  // fällt aufs Podest.
  const bodySteps = steps - 1; // ein Tritt = Podest
  const s1 = Math.max(1, Math.round((bodySteps * run1) / (run1 + run2)));
  const s2 = Math.max(1, bodySteps - s1);
  const td1 = run1 / s1;
  const td2 = run2 / s2;

  const treads: TreadRect[] = [];
  let rise = 0;
  for (let i = 0; i < s1; i++) {
    treads.push({
      pts: treadRect(stair.start, u, n, i * td1, (i + 1) * td1, halfW),
      index: i,
      baseRise: rise,
      topRise: rise + riserHeight,
    });
    rise += riserHeight;
  }
  // Zweiter Lauf beginnt am Ende des Podests. Richtung um 90° gedreht (turn).
  const cornerCenter = add(stair.start, scale(u, run1 + halfW));
  const u2: Vec2 = turn > 0 ? n : scale(n, -1); // links/rechts abbiegen
  const n2 = leftN(u2);
  // Podest-Tritt (quadratisch um cornerCenter, an u/u2 ausgerichtet).
  const landing: Vec2[] = [
    add(add(cornerCenter, scale(u, -halfW)), scale(n, halfW)),
    add(add(cornerCenter, scale(u, halfW)), scale(n, halfW)),
    add(add(cornerCenter, scale(u, halfW)), scale(n, -halfW)),
    add(add(cornerCenter, scale(u, -halfW)), scale(n, -halfW)),
  ];
  const podestTopRise = rise + riserHeight;
  rise += riserHeight;
  // Startpunkt des zweiten Laufs: Podest-Kante in Richtung u2.
  const run2Start = add(cornerCenter, scale(u2, halfW));
  for (let i = 0; i < s2; i++) {
    treads.push({
      pts: treadRect(run2Start, u2, n2, i * td2, (i + 1) * td2, halfW),
      index: s1 + 1 + i,
      baseRise: rise,
      topRise: rise + riserHeight,
    });
    rise += riserHeight;
  }
  void podest;
  void podestTopRise;

  const runLine: Vec2[] = [
    add(stair.start, scale(u, td1 * 0.5)),
    cornerCenter,
    add(run2Start, scale(u2, run2 - td2 * 0.15)),
  ];
  return {
    treads,
    landing,
    riserHeight,
    treadDepth: td1,
    runLine,
    arrow: arrowFor(runLine, stair.up !== false),
    totalRise,
  };
}

/** Wendeltreppe: keilförmige Tritte um ein Zentrum (vereinfachtes Modell). */
function spiralGeometry(
  stair: Stair,
  totalRise: number,
  steps: number,
  riserHeight: number,
  halfW: number,
): StairGeometry {
  const center = stair.center ?? stair.start;
  const radius = Math.max(halfW + 0.1, stair.radius ?? stair.width);
  const sweep = (stair.sweep ?? 270) * DEG;
  // Startwinkel aus start→center (Lauflinie beginnt am Startpunkt).
  const startVec = sub(stair.start, center);
  const a0 = Math.atan2(startVec.y, startVec.x);
  const dA = sweep / steps;
  const rIn = Math.max(0.02, radius - halfW);
  const rOut = radius + halfW;

  const treads: TreadRect[] = [];
  for (let i = 0; i < steps; i++) {
    const t0 = a0 + i * dA;
    const t1 = a0 + (i + 1) * dA;
    // Keil-Viereck: innen(t0) → außen(t0) → außen(t1) → innen(t1).
    const pts: Vec2[] = [
      { x: center.x + rIn * Math.cos(t0), y: center.y + rIn * Math.sin(t0) },
      { x: center.x + rOut * Math.cos(t0), y: center.y + rOut * Math.sin(t0) },
      { x: center.x + rOut * Math.cos(t1), y: center.y + rOut * Math.sin(t1) },
      { x: center.x + rIn * Math.cos(t1), y: center.y + rIn * Math.sin(t1) },
    ];
    treads.push({
      pts,
      index: i,
      baseRise: i * riserHeight,
      topRise: (i + 1) * riserHeight,
    });
  }
  // Lauflinie = Bogen auf Radius `radius` (mittlere Lauflinie).
  const runLine: Vec2[] = [];
  const N = Math.max(2, steps);
  for (let i = 0; i <= N; i++) {
    const tt = a0 + (sweep * i) / N;
    runLine.push({ x: center.x + radius * Math.cos(tt), y: center.y + radius * Math.sin(tt) });
  }
  return {
    treads,
    // Wendel-Auge (Innenkreis) als „Podest"-Polygon.
    landing: eyePolygon(center, rIn),
    riserHeight,
    treadDepth: (2 * Math.PI * radius * (sweep / (2 * Math.PI))) / steps,
    runLine,
    arrow: arrowFor(runLine, stair.up !== false),
    totalRise,
  };
}

/** Achteck-Approximation des Wendel-Auges (Innenkreis). */
function eyePolygon(center: Vec2, r: number): Vec2[] {
  const pts: Vec2[] = [];
  for (let i = 0; i < 12; i++) {
    const t = (i / 12) * Math.PI * 2;
    pts.push({ x: center.x + r * Math.cos(t), y: center.y + r * Math.sin(t) });
  }
  return pts;
}

/**
 * Auf-/Abpfeil aus der Lauflinie: Schaft = erstes→letztes Segment, Spitze am
 * oberen (bzw. bei `up=false` am unteren) Ende. `up` kehrt die Richtung um.
 */
function arrowFor(
  runLine: Vec2[],
  up: boolean,
): { shaft: [Vec2, Vec2]; head: [Vec2, Vec2, Vec2] } {
  const a = runLine[0];
  const b = runLine[runLine.length - 1];
  const tip = up ? b : a;
  const from = up ? runLine[runLine.length - 2] : runLine[1];
  const dir = norm(sub(tip, from));
  const n = leftN(dir);
  const s = 0.22; // Flügellänge (Meter)
  const back = add(tip, scale(dir, -s));
  const w1 = add(back, scale(n, s * 0.55));
  const w2 = add(back, scale(n, -s * 0.55));
  return { shaft: [a, b], head: [w1, tip, w2] };
}

/**
 * Schnitt-Aufteilung im Grundriss: DOSSIER schneidet die Treppe auf `cutRise`
 * (Schnitthöhe über OKFF). Tritte mit Oberkante ≤ cutRise werden durchgezogen
 * gezeichnet (unterhalb der Schnittebene), darüberliegende gestrichelt (oberhalb,
 * verdeckt). Der ERSTE Tritt oberhalb markiert die SIA-Bruchlinie (diagonaler
 * Doppelstrich über die Laufbreite).
 */
export interface StairCut {
  /** Indizes der Tritte UNTER der Schnittebene (durchgezogen). */
  belowIndices: number[];
  /** Indizes der Tritte ÜBER der Schnittebene (gestrichelt/verdeckt). */
  aboveIndices: number[];
  /** Bruchlinie (SIA): zwei parallele Diagonalstriche über die Laufbreite. */
  breakLine: [Vec2, Vec2][] | null;
}

/**
 * Bestimmt die Schnittaufteilung. `cutRise` = Schnitthöhe über der Treppen-UK.
 * Findet den ersten Tritt, dessen Oberkante die Schnittebene überschreitet, und
 * legt dort die Bruchlinie quer über den Lauf.
 */
export function stairCut(geo: StairGeometry, cutRise: number): StairCut {
  const below: number[] = [];
  const above: number[] = [];
  let breakIdx = -1;
  for (const tr of geo.treads) {
    if (tr.topRise <= cutRise + 1e-6) {
      below.push(tr.index);
    } else {
      if (breakIdx < 0) breakIdx = tr.index;
      above.push(tr.index);
    }
  }
  let breakLine: [Vec2, Vec2][] | null = null;
  if (breakIdx >= 0) {
    const tr = geo.treads.find((t) => t.index === breakIdx);
    if (tr) {
      // Diagonale Bruchlinie über den Tritt: von einer Ecke zur gegenüberliegenden,
      // als Doppelstrich (leicht versetzt) — SIA-Treppen-Schnittsymbol.
      const [c0, c1, c2, c3] = tr.pts;
      const mid01 = scale(add(c0, c1), 0.5);
      const mid23 = scale(add(c2, c3), 0.5);
      const off = scale(norm(sub(c1, c0)), 0.06);
      breakLine = [
        [add(mid01, off), add(mid23, off)],
        [sub(mid01, off), sub(mid23, off)],
      ];
    }
  }
  return { belowIndices: below, aboveIndices: above, breakLine };
}

/** Achsparallele Bounding-Box aller Tritte (+ Podest) einer Treppengeometrie. */
export function stairBBox(geo: StairGeometry): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
} {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  const acc = (p: Vec2) => {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  };
  for (const tr of geo.treads) for (const p of tr.pts) acc(p);
  if (geo.landing) for (const p of geo.landing) acc(p);
  if (!isFinite(minX)) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return { minX, minY, maxX, maxY };
}

/** Punkt-in-Polygon (Ray-Casting) — für die Body-Auswahl im Grundriss/3D. */
export function pointInPolygon(p: Vec2, poly: Vec2[]): boolean {
  let inside = false;
  const nn = poly.length;
  for (let i = 0, j = nn - 1; i < nn; j = i++) {
    const a = poly[i];
    const b = poly[j];
    const intersect =
      a.y > p.y !== b.y > p.y &&
      p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y || 1e-12) + a.x;
    if (intersect) inside = !inside;
  }
  return inside;
}

/** Ob ein Modellpunkt IRGENDEINEN Tritt (oder das Podest) einer Treppe trifft. */
export function pointHitsStair(p: Vec2, geo: StairGeometry): boolean {
  for (const tr of geo.treads) if (pointInPolygon(p, tr.pts)) return true;
  if (geo.landing && pointInPolygon(p, geo.landing)) return true;
  return false;
}

// ── Treppen-Aussenlinie (Plan-Outline) ───────────────────────────────────────

/**
 * Schliessendes Umriss-Polygon einer geraden Treppe im Grundriss (4 Ecken CCW).
 * Entspricht `_aussen_gerade` im Rhino-Plugin (Rechteck über Laufbreite + Lauflänge).
 * Liefert null bei entarteter Geometrie.
 */
function straightOutlinePoints(stair: Stair, halfW: number): Vec2[] | null {
  const u = norm({ x: stair.dir.x, y: stair.dir.y });
  const n = leftN(u);
  const L = Math.max(1e-4, stair.runLength);
  const s = stair.start;
  // Vier Ecken: Start-links → Start-rechts → End-rechts → End-links (CCW).
  return [
    add(s, scale(n, halfW)),
    add(s, scale(n, -halfW)),
    add(add(s, scale(u, L)), scale(n, -halfW)),
    add(add(s, scale(u, L)), scale(n, halfW)),
  ];
}

/**
 * 2D-Linien-Schnittpunkt. Liefert null bei Parallelität (det < ε).
 * Entspricht `_line_intersect_xy` im Rhino-Plugin.
 */
function lineIntersect2d(p1: Vec2, d1: Vec2, p2: Vec2, d2: Vec2): Vec2 | null {
  const det = d1.x * (-d2.y) - d1.y * (-d2.x);
  if (Math.abs(det) < 1e-9) return null;
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const t = (dx * (-d2.y) - dy * (-d2.x)) / det;
  return { x: p1.x + d1.x * t, y: p1.y + d1.y * t };
}

/**
 * Umriss-Polygon einer L-Treppe im Grundriss. Entspricht `_aussen_l_polygon`
 * im Rhino-Plugin: Linien-Schnittpunkte liefern die Ecken des L-Polygons.
 * Liefert null bei entarteter Geometrie.
 */
function lOutlinePoints(stair: Stair, halfW: number): Vec2[] | null {
  const u1 = norm(stair.dir);
  const n1 = leftN(u1);
  const L1 = Math.max(1e-4, stair.runLength);
  const turn = stair.turn ?? 1;
  const u2: Vec2 = turn > 0 ? n1 : scale(n1, -1);
  const n2 = leftN(u2);
  const L2 = Math.max(1e-4, stair.run2Length ?? stair.runLength);

  // Podest-Zentrum am Ende des ersten Laufs (Mitte = halfW hinter dem Lauf-Ende).
  const corner = add(stair.start, scale(u1, L1 + halfW));
  const run2Start = add(corner, scale(u2, halfW));

  // Lauf-1-Anfang je Seite
  const p0l = add(stair.start, scale(n1, halfW));
  const p0r = add(stair.start, scale(n1, -halfW));
  // Lauf-2-Ende je Seite
  const endRun2 = add(run2Start, scale(u2, L2));
  const p3l = add(endRun2, scale(n2, halfW));
  const p3r = add(endRun2, scale(n2, -halfW));
  // Innere Eck-Punkte: Schnittpunkt der parallelen Seitenlinien je Seite.
  const cornerL = lineIntersect2d(p0l, u1, p3l, scale(u2, -1)) ?? add(corner, scale(n1, halfW));
  const cornerR = lineIntersect2d(p0r, u1, p3r, scale(u2, -1)) ?? add(corner, scale(n1, -halfW));
  // CCW-Polygon: p0l → p0r → cornerR → p3r → p3l → cornerL
  return [p0l, p0r, cornerR, p3r, p3l, cornerL];
}

/**
 * Spiral-Outline: Innenbogen + Aussenbogen + zwei radiale Schliesslinien.
 * Entspricht `_aussen_wendel` im Rhino-Plugin (immer vollständig, ohne Cut).
 * Die Bögen werden als Kreisbogen-Parameter geliefert (cx/cy/r/a0/a1), die
 * radialen Schliesslinien als Segment-Paare.
 */
export interface SpiralOutlineSegments {
  /** Radiale Abschlusslinien (jeweils Innenpunkt → Aussenpunkt). */
  lines: [Vec2, Vec2][];
  /** Kreisbogen-Parameter: Innen- und Aussenkreis. */
  arcs: { cx: number; cy: number; r: number; a0: number; a1: number }[];
}

function spiralOutline(stair: Stair, halfW: number): SpiralOutlineSegments | null {
  const center = stair.center ?? stair.start;
  const radius = Math.max(halfW + 0.1, stair.radius ?? stair.width);
  const sweep = (stair.sweep ?? 270) * (Math.PI / 180);
  const startVec = sub(stair.start, center);
  const a0 = Math.atan2(startVec.y, startVec.x);
  const a1 = a0 + sweep;
  const rIn = Math.max(0.02, radius - halfW);
  const rOut = radius + halfW;

  const ptAt = (r: number, a: number): Vec2 => ({
    x: center.x + r * Math.cos(a),
    y: center.y + r * Math.sin(a),
  });

  return {
    lines: [
      [ptAt(rIn, a0), ptAt(rOut, a0)],
      [ptAt(rIn, a1), ptAt(rOut, a1)],
    ],
    arcs: [
      { cx: center.x, cy: center.y, r: rIn, a0, a1 },
      { cx: center.x, cy: center.y, r: rOut, a0, a1 },
    ],
  };
}

/**
 * Aussenlinie einer Treppe im Grundriss je nach Form:
 *   • gerade → geschlossenes Rechteck als Polygon-Punkte.
 *   • L       → L-Polygon via Linien-Schnittpunkten.
 *   • Wendel  → `SpiralOutlineSegments` (Bögen + radiale Linien).
 *
 * Genau einer von `polygon` / `spiral` ist nicht null.
 */
export function stairOutline(
  stair: Stair,
  totalRise: number,
): { polygon: Vec2[] | null; spiral: SpiralOutlineSegments | null } {
  void totalRise; // Signatur-Konsistenz mit stairGeometry; derzeit ungenutzt
  const halfW = Math.max(0.05, stair.width / 2);
  // Referenz (links/mitte/rechts): die gespeicherte Achse zuerst auf die
  // visuelle Treppen-Mitte versetzen, danach die um die Mitte zentrierte
  // Aussenlinien-Logik unverändert anwenden (identisch zu `stairGeometry`).
  const u = norm(stair.dir);
  const c = referenzMidShift(stair, u);
  const s = stair.referenz && stair.referenz !== "mitte"
    ? { ...stair, start: add(stair.start, c), center: stair.center ? add(stair.center, c) : stair.center }
    : stair;
  if (s.shape === "spiral") {
    return { polygon: null, spiral: spiralOutline(s, halfW) };
  }
  if (s.shape === "L") {
    return { polygon: lOutlinePoints(s, halfW), spiral: null };
  }
  return { polygon: straightOutlinePoints(s, halfW), spiral: null };
}
