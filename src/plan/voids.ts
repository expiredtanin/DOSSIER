// Abzugskörper (`ExtrudedSolid.operation === "subtract"`): Aussparungen, Durchbrüche und
// Nischen, die sich von Wänden, Decken und Stützen abziehen — in ALLEN abgeleiteten
// Ansichten aus demselben Modell:
//
//  • Grundriss: Poché-Polygone der getroffenen Bauteile minus Körper-Grundfläche, sofern der
//    Körper die Schnitthöhe (Wände/Stützen) bzw. die Platte (Decken) durchdringt — rechnet der
//    Kern (`core/src/plan/extras.rs::subtract_voids`).
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

import type { Pair } from "../geometry/polygonBool";
import { core } from "../engine/coreWasm";
import type { ExtrudedSolid, Project, Vec2 } from "../model/types";
import { getFloor } from "../model/types";
import type { SolidSpec } from "../engine/truckSolid";
import type { RWall } from "./toWalls3d/shared";

export interface VoidPrism {
  id: string;
  pts: Vec2[];
  z0: number;
  z1: number;
}

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

// ── Polygon-Booleans (Rust-Kern, `voids.rs`) ─────────────────────────────────

/** Ringliste flach für den Kern (`[n, (k, x, y …) × n]`). */
function encodeRings(rings: Pair[][]): Float64Array {
  const b: number[] = [rings.length];
  for (const r of rings) {
    b.push(r.length);
    for (const p of r) b.push(p[0], p[1]);
  }
  return Float64Array.from(b);
}

/**
 * Löcher per Steg in den Aussenring einhängen (Schlüsselloch). Liefert die Punkte und die
 * Indizes der Stegkanten (Kante i = pts[i] → pts[i+1]).
 */
export function keyhole(poly: Pair[][]): { pts: Pair[]; bridges: number[] } {
  const f = core().voids_keyhole_flat(encodeRings(poly));
  const n = f[0];
  const pts = new Array<Pair>(n);
  for (let i = 0; i < n; i++) pts[i] = [f[1 + 2 * i], f[2 + 2 * i]];
  const nb = f[1 + 2 * n];
  const bridges = new Array<number>(nb);
  for (let i = 0; i < nb; i++) bridges[i] = f[2 + 2 * n + i];
  return { pts, bridges };
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
  const f = core().voids_subtract_rings_flat(
    encodeRings([pts]).subarray(1),
    encodeRings(cutters),
    Float64Array.from([noStroke.length, ...noStroke]),
  );
  if (f.length === 0 || f[0] < 0) return null;
  const out: Array<{ pts: Pair[]; noStrokeEdges: number[] }> = [];
  let i = 1;
  for (let k = 0; k < f[0]; k++) {
    const n = f[i++];
    const rp = new Array<Pair>(n);
    for (let j = 0; j < n; j++, i += 2) rp[j] = [f[i], f[i + 1]];
    const m = f[i++];
    const ns = new Array<number>(m);
    for (let j = 0; j < m; j++) ns[j] = f[i++];
    out.push({ pts: rp, noStrokeEdges: ns });
  }
  return out;
}

// ── Schnitt ──────────────────────────────────────────────────────────────────

/**
 * Schnitt-Rechtecke (u, v) eines Abzugskörpers mit der senkrechten Ebene durch `base` in
 * Richtung `uDir` (Einheitsvektor; u = Abstand entlang uDir ab `base`).
 */
export function voidSectionRects(v: VoidPrism, base: Vec2, uDir: Vec2): Pair[][] {
  const f = core().voids_section_rects_flat(
    Float64Array.from([v.pts.length, ...v.pts.flatMap((p) => [p.x, p.y])]),
    Float64Array.from([base.x, base.y, uDir.x, uDir.y]),
  );
  const rects: Pair[][] = [];
  for (let k = 0; k < (f[0] ?? 0); k++) {
    const u0 = f[1 + 2 * k];
    const u1 = f[2 + 2 * k];
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

