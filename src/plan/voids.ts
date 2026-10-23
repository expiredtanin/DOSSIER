// Abzugskörper (`ExtrudedSolid.operation === "subtract"`): Aussparungen, Durchbrüche und
// Nischen, die sich von Wänden, Decken und Stützen abziehen — in ALLEN abgeleiteten
// Ansichten aus demselben Modell:
//
//  • Grundriss: Poché-Polygone der getroffenen Bauteile minus Körper-Grundfläche, sofern der
//    Körper die Schnitthöhe (Wände/Stützen) bzw. die Platte (Decken) durchdringt.
//  • Schnitt:   Cut-Polygone minus Körper-Schnitt (Grundfläche ∩ Schnittspur × Höhenbereich).
//  • 3D/STEP:   Boolean-Differenz (truck, Mesh-CSG-Fallback), s. `toWalls3d/voids3d.ts`
//               bzw. `exportStep.ts`.
//
// Abzugskörper sind senkrechte Prismen (Profil × Höhe, ohne Verjüngung/B-Rep) — damit bleiben
// Grundriss und Schnitt exakt analytisch (ein Prisma schneidet eine waagrechte Ebene in seiner
// Grundfläche und eine senkrechte Ebene in Rechtecken).
//
// Polygone mit Loch (Körper ganz im Bauteil) werden über einen Steg an den Aussenring
// gehängt (Schlüsselloch); die beiden Stegkanten sind nicht gestrichen (`noStrokeEdges`).

import polygonClipping from "polygon-clipping";
import type { Pair, Polygon as PcPolygon, MultiPolygon } from "polygon-clipping";
import type { ExtrudedSolid, Project, Vec2 } from "../model/types";
import { getFloor } from "../model/types";
import { ceilingVerticalExtent, columnVerticalExtent } from "../model/wall";
import type { Primitive } from "./generatePlan/shared";
import type { SolidSpec } from "../engine/truckSolid";
import type { RWall } from "./toWalls3d/shared";

export interface VoidPrism {
  id: string;
  pts: Vec2[];
  z0: number;
  z1: number;
}

const EPS = 1e-7;

/** Ob ein Körper als Abzugskörper wirkt (Prisma mit gültigem Profil). */
export function isVoidSolid(s: ExtrudedSolid): boolean {
  return s.operation === "subtract" && !s.brep && (s.taper ?? 0) < 1e-6 && s.points.length >= 3 && s.height > 0;
}

/** UK des Körpers (Geschoss-UK + `baseOffset`). */
export function solidBaseZ(project: Project, s: ExtrudedSolid): number {
  let base = 0;
  try {
    base = getFloor(project, s.levelId).baseElevation ?? 0;
  } catch {
    base = 0;
  }
  return base + (s.baseOffset ?? 0);
}

/** Alle Abzugskörper des Projekts (Welt-Höhen). */
export function voidPrisms(project: Project): VoidPrism[] {
  const out: VoidPrism[] = [];
  for (const s of project.extrudedSolids ?? []) {
    if (!isVoidSolid(s)) continue;
    const z0 = solidBaseZ(project, s);
    out.push({ id: s.id, pts: s.points, z0, z1: z0 + s.height });
  }
  return out;
}

// ── Polygon-Booleans ─────────────────────────────────────────────────────────

const ring = (pts: Vec2[]): Pair[] => pts.map((p) => [p.x, p.y] as Pair);

/** Fläche (vorzeichenbehaftet) eines Rings. */
function signedArea(r: Pair[]): number {
  let a = 0;
  for (let i = 0; i < r.length; i++) {
    const p = r[i];
    const q = r[(i + 1) % r.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

/** Ring ohne doppelten Schlusspunkt (polygon-clipping liefert geschlossene Ringe). */
function openRing(r: Pair[]): Pair[] {
  if (r.length > 1) {
    const a = r[0];
    const b = r[r.length - 1];
    if (Math.abs(a[0] - b[0]) < EPS && Math.abs(a[1] - b[1]) < EPS) return r.slice(0, -1);
  }
  return r;
}

/**
 * Löcher per Steg in den Aussenring einhängen (Schlüsselloch). Liefert die Punkte und die
 * Indizes der Stegkanten (Kante i = pts[i] → pts[i+1]).
 */
export function keyhole(poly: Pair[][]): { pts: Pair[]; bridges: number[] } {
  let outer = openRing(poly[0]);
  const bridges: number[] = [];
  const holes = poly.slice(1).map(openRing).filter((h) => h.length >= 3);
  // Löcher von rechts nach links einhängen (Stege kreuzen sich so nicht).
  holes.sort((a, b) => Math.max(...b.map((p) => p[0])) - Math.max(...a.map((p) => p[0])));
  for (const hole of holes) {
    // Lochpunkt mit grösstem x, nächster Aussenring-Punkt dazu.
    let hi = 0;
    for (let i = 1; i < hole.length; i++) if (hole[i][0] > hole[hi][0]) hi = i;
    const h = hole[hi];
    let oi = 0;
    let best = Infinity;
    for (let i = 0; i < outer.length; i++) {
      const d = Math.hypot(outer[i][0] - h[0], outer[i][1] - h[1]);
      if (d < best) {
        best = d;
        oi = i;
      }
    }
    const holeSeq = [...hole.slice(hi), ...hole.slice(0, hi), h];
    const next: Pair[] = [...outer.slice(0, oi + 1), ...holeSeq, outer[oi], ...outer.slice(oi + 1)];
    // Indizes der beiden Stegkanten (alte Stegindizes hinter oi verschieben sich).
    const shift = holeSeq.length + 1;
    for (let k = 0; k < bridges.length; k++) if (bridges[k] > oi) bridges[k] += shift;
    bridges.push(oi, oi + holeSeq.length);
    outer = next;
  }
  return { pts: outer, bridges };
}

/** Liegt Segment a→b auf Segment p→q (kollinear, innerhalb)? */
function onSegment(a: Pair, b: Pair, p: Pair, q: Pair, tol = 1e-6): boolean {
  const dx = q[0] - p[0];
  const dy = q[1] - p[1];
  const len = Math.hypot(dx, dy);
  if (len < EPS) return false;
  const dist = (r: Pair) => Math.abs((r[0] - p[0]) * dy - (r[1] - p[1]) * dx) / len;
  const t = (r: Pair) => ((r[0] - p[0]) * dx + (r[1] - p[1]) * dy) / (len * len);
  return dist(a) < tol && dist(b) < tol && t(a) > -tol && t(a) < 1 + tol && t(b) > -tol && t(b) < 1 + tol;
}

/**
 * Polygon (Ring `pts`, optional nicht gestrichene Kanten) minus Schneider. Liefert die
 * Rest-Polygone mit übertragenen `noStrokeEdges` (eine Kante bleibt ungestrichen, wenn sie
 * auf einer ungestrichenen Kante des Originals liegt; Stege sind immer ungestrichen).
 * `null` = keine Überschneidung (Original unverändert lassen).
 */
export function subtractRings(
  pts: Pair[],
  cutters: Pair[][],
  noStroke: number[] = [],
): Array<{ pts: Pair[]; noStrokeEdges: number[] }> | null {
  if (pts.length < 3 || cutters.length === 0) return null;
  const subject: PcPolygon = [pts];
  const clips: MultiPolygon = cutters.filter((c) => c.length >= 3).map((c) => [c] as PcPolygon);
  if (clips.length === 0) return null;
  // Schnell-Test: überlappen die Hüllen überhaupt?
  let hit = false;
  try {
    hit = polygonClipping.intersection(subject, ...clips).length > 0;
  } catch {
    return null;
  }
  if (!hit) return null;
  let diff: MultiPolygon;
  try {
    diff = polygonClipping.difference(subject, ...clips);
  } catch {
    return null;
  }
  const area0 = Math.abs(signedArea(pts));
  const out: Array<{ pts: Pair[]; noStrokeEdges: number[] }> = [];
  for (const poly of diff) {
    const { pts: kp, bridges } = keyhole(poly);
    if (kp.length < 3 || Math.abs(signedArea(openRing(poly[0]))) < area0 * 1e-9) continue;
    // Orientierung des Originals beibehalten (Schraffur-/Strich-Logik ist orientierungsfrei,
    // aber Tests und Nachbearbeitungen erwarten den Umlaufsinn).
    const sameDir = Math.sign(signedArea(kp)) === Math.sign(signedArea(pts)) || signedArea(pts) === 0;
    const ringPts = sameDir ? kp : [...kp].reverse();
    const n = ringPts.length;
    const bridgeSet = new Set(sameDir ? bridges : bridges.map((i) => (n - 2 - i + n) % n));
    const ns: number[] = [];
    for (let i = 0; i < n; i++) {
      const a = ringPts[i];
      const b = ringPts[(i + 1) % n];
      if (bridgeSet.has(i)) {
        ns.push(i);
        continue;
      }
      for (const e of noStroke) {
        const p = pts[e];
        const q = pts[(e + 1) % pts.length];
        if (p && q && onSegment(a, b, p, q)) {
          ns.push(i);
          break;
        }
      }
    }
    out.push({ pts: ringPts, noStrokeEdges: ns });
  }
  return out;
}

// ── Grundriss ────────────────────────────────────────────────────────────────

function pointInRing(x: number, y: number, r: Pair[]): boolean {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i];
    const [xj, yj] = r[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Teile der Strecke a→b ausserhalb aller Ringe, als Parameter-Intervalle [t0, t1]. */
export function segmentOutside(a: Vec2, b: Vec2, cutters: Pair[][]): Array<[number, number]> {
  const ts = [0, 1];
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  for (const r of cutters) {
    for (let i = 0; i < r.length; i++) {
      const p = r[i];
      const q = r[(i + 1) % r.length];
      const ex = q[0] - p[0];
      const ey = q[1] - p[1];
      const den = dx * ey - dy * ex;
      if (Math.abs(den) < 1e-14) continue;
      const t = ((p[0] - a.x) * ey - (p[1] - a.y) * ex) / den;
      const u = ((p[0] - a.x) * dy - (p[1] - a.y) * dx) / den;
      if (t > 0 && t < 1 && u >= -1e-9 && u <= 1 + 1e-9) ts.push(t);
    }
  }
  ts.sort((x, y) => x - y);
  const out: Array<[number, number]> = [];
  for (let i = 0; i + 1 < ts.length; i++) {
    const [t0, t1] = [ts[i], ts[i + 1]];
    if (t1 - t0 < 1e-9) continue;
    const tm = (t0 + t1) / 2;
    const mx = a.x + dx * tm;
    const my = a.y + dy * tm;
    if (cutters.some((r) => pointInRing(mx, my, r))) continue;
    const last = out[out.length - 1];
    if (last && Math.abs(last[1] - t0) < 1e-9) last[1] = t1;
    else out.push([t0, t1]);
  }
  return out;
}

/** Linien-Klassen der Wand-Poché, die ein Abzugskörper auf Schnitthöhe unterbricht. */
const WALL_LINE_CLS = new Set(["wall-outline", "layer-joint", "layer-joint-l"]);

/**
 * Zieht die Abzugskörper von den Bauteil-Polygonen eines Grundrisses ab (in place).
 * Wände: wenn der Körper die Schnitthöhe `cutZ` durchdringt. Stützen: ebenso, über ihren
 * Höhenbereich. Decken: wenn der Körper die Platte durchdringt (Deckendurchbruch).
 */
export function subtractVoidsInPlan(prims: Primitive[], project: Project, cutZ: number): void {
  const voids = voidPrisms(project);
  if (voids.length === 0) return;
  const ceilings = new Map((project.ceilings ?? []).map((c) => [c.id, c]));
  const columns = new Map((project.columns ?? []).map((c) => [c.id, c]));
  const cuttersFor = (z0: number, z1: number): Pair[][] =>
    voids.filter((v) => v.z0 < z1 - EPS && v.z1 > z0 + EPS).map((v) => ring(v.pts));
  const wallCutters = cuttersFor(cutZ - 1e-4, cutZ + 1e-4);
  const out: Primitive[] = [];
  for (const pr of prims) {
    if (pr.kind === "line" && WALL_LINE_CLS.has(pr.cls) && wallCutters.length) {
      const parts = segmentOutside(pr.a, pr.b, wallCutters);
      const whole = parts.length === 1 && parts[0][0] === 0 && parts[0][1] === 1;
      if (whole) out.push(pr);
      else
        for (const [t0, t1] of parts) {
          const at = (t: number) => ({ x: pr.a.x + (pr.b.x - pr.a.x) * t, y: pr.a.y + (pr.b.y - pr.a.y) * t });
          out.push({ ...pr, a: at(t0), b: at(t1) });
        }
      continue;
    }
    if (pr.kind !== "polygon" || pr.extrudedSolidId) {
      out.push(pr);
      continue;
    }
    let cutters: Pair[][] | null = null;
    if (pr.wallId) cutters = wallCutters;
    else if (pr.ceilingId) {
      const c = ceilings.get(pr.ceilingId);
      if (c) {
        const { zBottom, zTop } = ceilingVerticalExtent(project, c);
        cutters = cuttersFor(zBottom, zTop);
      }
    } else if (pr.columnId) {
      const c = columns.get(pr.columnId);
      if (c) {
        const { zBottom, zTop } = columnVerticalExtent(project, c);
        cutters = zBottom <= cutZ && zTop >= cutZ ? wallCutters : cuttersFor(zBottom, zTop);
      }
    }
    if (!cutters || cutters.length === 0) {
      out.push(pr);
      continue;
    }
    const rest = subtractRings(ring(pr.pts), cutters, pr.noStrokeEdges ?? []);
    if (rest === null) {
      out.push(pr);
      continue;
    }
    for (const r of rest) {
      out.push({
        ...pr,
        pts: r.pts.map(([x, y]) => ({ x, y })),
        noStrokeEdges: r.noStrokeEdges.length ? r.noStrokeEdges : undefined,
      });
    }
  }
  prims.length = 0;
  for (const p of out) prims.push(p);
}

// ── Schnitt ──────────────────────────────────────────────────────────────────

/**
 * Schnitt-Rechtecke (u, v) eines Abzugskörpers mit der senkrechten Ebene durch `base` in
 * Richtung `uDir` (Einheitsvektor; u = Abstand entlang uDir ab `base`).
 */
export function voidSectionRects(v: VoidPrism, base: Vec2, uDir: Vec2): Pair[][] {
  const ts: number[] = [];
  const n = v.pts.length;
  // Normale der Schnittspur: Punkt-Seite über das Kreuzprodukt.
  const side = (p: Vec2) => (p.x - base.x) * uDir.y - (p.y - base.y) * uDir.x;
  for (let i = 0; i < n; i++) {
    const a = v.pts[i];
    const b = v.pts[(i + 1) % n];
    const sa = side(a);
    const sb = side(b);
    // Halboffene Regel (eine Ecke auf der Spur zählt nur einmal).
    if ((sa > 0) === (sb > 0)) continue;
    const t = sa / (sa - sb);
    const px = a.x + (b.x - a.x) * t;
    const py = a.y + (b.y - a.y) * t;
    ts.push((px - base.x) * uDir.x + (py - base.y) * uDir.y);
  }
  ts.sort((a, b) => a - b);
  const rects: Pair[][] = [];
  for (let i = 0; i + 1 < ts.length; i += 2) {
    const [u0, u1] = [ts[i], ts[i + 1]];
    if (u1 - u0 < 1e-6) continue;
    rects.push([
      [u0, v.z0],
      [u1, v.z0],
      [u1, v.z1],
      [u0, v.z1],
    ]);
  }
  return rects;
}

/** Minimal-Form eines Schnitt-Polygons (s. `SectionCutPolygon` in toSection.ts). */
interface CutPolyLike {
  pts: Array<[number, number]>;
  noStrokeEdges?: number[];
}

/** Zieht die Abzugskörper von den Cut-Polygonen eines Schnitts ab (neue Liste). */
export function subtractVoidsInSection<T extends CutPolyLike>(
  cuts: T[],
  project: Project,
  base: Vec2,
  uDir: Vec2,
): T[] {
  const voids = voidPrisms(project);
  if (voids.length === 0) return cuts;
  const rects = voids.flatMap((v) => voidSectionRects(v, base, uDir));
  if (rects.length === 0) return cuts;
  const out: T[] = [];
  for (const cp of cuts) {
    const rest = subtractRings(cp.pts as Pair[], rects, cp.noStrokeEdges ?? []);
    if (rest === null) {
      out.push(cp);
      continue;
    }
    for (const r of rest) {
      out.push({ ...cp, pts: r.pts as Array<[number, number]>, noStrokeEdges: r.noStrokeEdges.length ? r.noStrokeEdges : undefined });
    }
  }
  return out;
}

// ── 3D / B-Rep ───────────────────────────────────────────────────────────────

export type Box2 = { x0: number; y0: number; x1: number; y1: number };
export const bbox = (pts: Array<{ x: number; y: number }>): Box2 => ({
  x0: Math.min(...pts.map((p) => p.x)),
  y0: Math.min(...pts.map((p) => p.y)),
  x1: Math.max(...pts.map((p) => p.x)),
  y1: Math.max(...pts.map((p) => p.y)),
});
const boxHit = (a: Box2, b: Box2) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

export function wallCorners(w: RWall): Array<{ x: number; y: number }> {
  const dx = w.end[0] - w.start[0];
  const dy = w.end[1] - w.start[1];
  const len = Math.hypot(dx, dy) || 1;
  const nx = (-dy / len) * (w.thickness / 2);
  const ny = (dx / len) * (w.thickness / 2);
  return [
    { x: w.start[0] + nx, y: w.start[1] + ny },
    { x: w.end[0] + nx, y: w.end[1] + ny },
    { x: w.end[0] - nx, y: w.end[1] - ny },
    { x: w.start[0] - nx, y: w.start[1] - ny },
  ];
}

const voidSpec = (v: VoidPrism): SolidSpec => ({
  kind: "extrude",
  points: v.pts.flatMap((p) => [p.x, p.y]),
  height: v.z1 - v.z0,
  z0: v.z0,
});

/** Bauteil minus alle Körper (verkettete Differenzen). */
export function subtractSpec(base: SolidSpec, voids: VoidPrism[]): SolidSpec {
  return voids.reduce<SolidSpec>((acc, v) => ({ kind: "boolean", op: "difference", a: acc, b: voidSpec(v) }), base);
}

/** Abzugskörper, die ein Prisma (Grundriss-Hülle + Höhenbereich) treffen. */
export function hittingVoids(voids: VoidPrism[], foot: Box2, z0: number, z1: number): VoidPrism[] {
  return voids.filter((v) => v.z0 < z1 - 1e-6 && v.z1 > z0 + 1e-6 && boxHit(bbox(v.pts), foot));
}

