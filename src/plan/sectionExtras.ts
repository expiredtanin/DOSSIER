// Zusätze zum Schnitt, die nicht Wand/Decke/Dach sind (Baustein [G1], meshSection.ts):
//  • Geländelinie: das Gelände-Netz (`TerrainMesh`) geschnitten → Linienzug im Schnitt,
//    auf den Bereich des Gebäudes (± Rand) begrenzt.
//  • Körper: freie Körper (`ExtrudedSolid`, B-Rep) geschnitten → gefüllte Schnittflächen.

import type { ExtrudedSolid, Project } from "../model/types";
import { getFloor } from "../model/types";
import { buildSolidMesh } from "../engine/truckSolid";
import { extrudedSolidSpec } from "./extrudedSolidSpec";
import { isVoidSolid } from "./voids";
import { cutMeshWithPlane, ringsToPolygons } from "./meshSection";
import type { Pt2 } from "./meshSection";
import { keyhole } from "./voids";
import type { SectionCutPolygon, SectionOutput, SectionPlaneSpec } from "./toSection";

type UDir = { x: number; y: number };

/** Seitenrand (m) der Geländelinie um den Inhalt des Schnitts. */
const TERRAIN_MARGIN = 6;
/** Neutrale Füllung geschnittener freier Körper (kein Bauteil/Material zugeordnet). */
const BODY_FILL = "#d9dde2";
const BODY_RGB: [number, number, number] = [0.85, 0.87, 0.89];

function planeOf(plane: SectionPlaneSpec, dir: UDir) {
  return { kind: "vertical" as const, point: { x: plane.point[0], y: plane.point[2] }, dir };
}

/** Wertebereich in u über alle Cut-Polygone und Kanten (für die Geländebegrenzung). */
function uRange(output: SectionOutput): [number, number] | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (const cp of output.cutPolygons) for (const p of cp.pts) (lo = Math.min(lo, p[0])), (hi = Math.max(hi, p[0]));
  for (const e of [...output.visibleEdges, ...output.hiddenEdges]) {
    lo = Math.min(lo, e.a[0], e.b[0]);
    hi = Math.max(hi, e.a[0], e.b[0]);
  }
  return Number.isFinite(lo) ? [lo, hi] : null;
}

/** Schneidet einen Linienzug auf [lo, hi] in u (Segmentweise, interpoliert die Ränder). */
function clipLineToU(pts: Pt2[], lo: number, hi: number): Pt2[][] {
  const out: Pt2[][] = [];
  let cur: Pt2[] = [];
  const flush = () => {
    if (cur.length >= 2) out.push(cur);
    cur = [];
  };
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const [u0, u1] = [a[0], b[0]];
    if ((u0 < lo && u1 < lo) || (u0 > hi && u1 > hi)) {
      flush();
      continue;
    }
    const at = (u: number): Pt2 => {
      const t = u1 === u0 ? 0 : (u - u0) / (u1 - u0);
      return [u, a[1] + (b[1] - a[1]) * t];
    };
    const pa: Pt2 = u0 < lo ? at(lo) : u0 > hi ? at(hi) : a;
    const pb: Pt2 = u1 < lo ? at(lo) : u1 > hi ? at(hi) : b;
    if (cur.length === 0) cur.push(pa);
    cur.push(pb);
    if (u1 < lo || u1 > hi) flush();
  }
  flush();
  return out;
}

/** Hängt die Geländelinien aller Gelände-Netze an `output.profiles`. */
export function appendTerrainProfiles(output: SectionOutput, project: Project, plane: SectionPlaneSpec, uDir: UDir): void {
  const terrains = (project.context ?? []).filter((c) => c.type === "terrainMesh");
  if (terrains.length === 0) return;
  const range = uRange(output);
  const cut = planeOf(plane, uDir);
  for (const t of terrains) {
    if (t.type !== "terrainMesh" || t.positions.length < 9) continue;
    const { lines } = cutMeshWithPlane(t.positions, t.indices, cut);
    for (const line of lines) {
      const parts = range ? clipLineToU(line, range[0] - TERRAIN_MARGIN, range[1] + TERRAIN_MARGIN) : [line];
      for (const pts of parts) {
        (output.profiles ??= []).push({ kind: "terrain", id: t.id, categoryCode: t.categoryCode, pts });
      }
    }
  }
}

/** Welche Körper im Schnitt erscheinen (freie Körper, keine Abzugskörper). */
export function sectionSolids(project: Project): Array<{ index: number; solid: ExtrudedSolid }> {
  const out: Array<{ index: number; solid: ExtrudedSolid }> = [];
  (project.extrudedSolids ?? []).forEach((solid, index) => {
    if (solid.operation === "subtract" || isVoidSolid(solid)) return;
    out.push({ index, solid });
  });
  return out;
}

/** Hängt die geschnittenen freien Körper als Cut-Polygone an (truck-Mesh, asynchron). */
export async function appendBodySections(output: SectionOutput, project: Project, plane: SectionPlaneSpec, uDir: UDir): Promise<void> {
  const cut = planeOf(plane, uDir);
  for (const { index, solid } of sectionSolids(project)) {
    let baseZ = 0;
    try {
      baseZ = solid.levelId ? (getFloor(project, solid.levelId).baseElevation ?? 0) : 0;
    } catch {
      baseZ = 0;
    }
    const spec = extrudedSolidSpec(solid, baseZ);
    if (!spec) continue;
    let mesh: { positions: number[]; indices: number[] };
    try {
      mesh = await buildSolidMesh(spec, 0.01);
    } catch {
      continue; // Körper nicht baubar → im Schnitt weglassen, wie im 3D
    }
    const { rings } = cutMeshWithPlane(mesh.positions, mesh.indices, cut);
    for (const poly of ringsToPolygons(rings)) {
      const { pts } = poly.length > 1 ? keyhole(poly as [number, number][][]) : { pts: poly[0] };
      const cp: SectionCutPolygon = {
        component: { kind: "body", index },
        color: BODY_RGB,
        pts: pts as Array<[number, number]>,
        fill: BODY_FILL,
        noStrokeEdges: poly.length > 1 ? holeBridgeEdges(pts.length, poly) : undefined,
      };
      output.cutPolygons.push(cp);
    }
  }
}

/** Kanten-Indizes der Schlüsselloch-Stege eines Rings mit Löchern. */
function holeBridgeEdges(n: number, poly: Pt2[][]): number[] {
  return keyhole(poly as [number, number][][]).bridges.filter((i) => i < n);
}
