// Treppen im IFC-Export ([B5], 28.10.): statt eines Fussabdruck-Quaders die Teile der Treppe wie im 3D —
// Läufe (IfcStairFlight), Podest (IfcSlab LANDING) und Handlauf/Pfosten (IfcRailing), zusammengefasst
// von der IfcStair (IfcRelAggregates). Quelle sind dieselben Ableitungen wie im 3D-Viewer
// (`emitStairs` Tritt-Prismen und Podest, `emitStairMeshes` glatte Ortbeton-Laufplatte,
// `emitStairRailings`), je Treppe mit einem Ein-Treppen-Projekt aufgerufen (die Ableitungen liefern keine
// ids). Dieses Modul sammelt und rechnet die Basismengen; die Entitäten schreibt Rust (`ifc_export.rs`, STAIR).
//
// Zuordnung der Tritt-Prismen: bei "L" ist das Podest das Prisma mit dem Umriss des Podest-Polygons der
// Treppengeometrie; Tritte bis zur Podest-Oberkante gehören zum ersten, die darüber zum zweiten Lauf.
// Gerade und Wendeltreppen haben einen Lauf (die Wendel-Mitte bleibt Teil davon, wie im 3D).

import type { Project, Stair, Vec2 } from "../model/types";
import { getStairType } from "../model/types";
import { stairVerticalExtent } from "../model/wall";
import { stairGeometry } from "../geometry/stair";
import type { RSlab } from "../plan/toWalls3d";
import { orientOutward } from "./meshOrient";
import { flightQuantities, meshVolume, railingQuantities, ringArea, slabQuantities, type Qty } from "./ifcQuantities";
import { emitStairMeshes, emitStairRailings, emitStairs } from "./model3dParts";

/** Ein Prisma (Profil in Welt-XY, Unterkante relativ zum Geschoss, Tiefe). */
export interface StairSolid {
  pts: Vec2[];
  zRel: number;
  depth: number;
}

export interface StairFlightParts {
  name: string;
  risers: number;
  treads: number;
  riserHeight: number;
  treadLength: number;
  /** IfcStairFlightTypeEnum. */
  predefined: "STRAIGHT" | "SPIRAL";
  quantities: Qty[];
  /** Entweder Prismen oder ein Dreiecks-Netz (IFC: x, y, z-hoch, Z relativ zum Geschoss). */
  solids?: StairSolid[];
  mesh?: { positions: number[]; indices: number[] };
}

export interface StairParts {
  flights: StairFlightParts[];
  landing: { name: string; pts: Vec2[]; zRel: number; depth: number; quantities: Qty[] } | null;
  rail: { name: string; predefined: "HANDRAIL"; mesh: { positions: number[]; indices: number[] }; quantities: Qty[] } | null;
}

const EPS = 1e-6;

/** Gleicher Umriss (gleiche Punktmenge, auch bei anderer Reihenfolge/Startpunkt). */
function sameRing(a: readonly [number, number][], b: readonly Vec2[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((p) => b.some((q) => Math.abs(p[0] - q.x) < EPS && Math.abs(p[1] - q.y) < EPS));
}

const centroid = (pts: readonly Vec2[]): Vec2 => ({
  x: pts.reduce((s, p) => s + p.x, 0) / pts.length,
  y: pts.reduce((s, p) => s + p.y, 0) / pts.length,
});

/** Netz (Modell x, y, z-hoch) nach IFC: Z relativ zum Geschoss, Wicklung nach aussen. */
function ifcMesh(positions: readonly number[], indices: readonly number[], base: number): { positions: number[]; indices: number[] } {
  const pos = positions.slice();
  for (let i = 2; i < pos.length; i += 3) pos[i] -= base;
  return { positions: pos, indices: orientOutward(pos, indices) };
}

/**
 * Teile einer Treppe für den IFC-Export; `base` = Oberkante des Geschosses, dem die Treppe zugeordnet
 * ist (Z-Werte werden relativ dazu geschrieben). Leere Teile (keine Geometrie) ergeben `flights: []`,
 * `landing: null`, `rail: null` — der Aufrufer fällt dann auf den Fussabdruck zurück.
 */
export function stairParts(project: Project, stair: Stair, base: number): StairParts {
  const one: Project = { ...project, stairs: [stair] };
  const { zBottom, zTop } = stairVerticalExtent(project, stair);
  const rise = zTop - zBottom;
  const geo = stairGeometry(stair, rise);
  const slabs = emitStairs(one);
  const meshes = emitStairMeshes(one);
  const predefined = stair.shape === "spiral" ? "SPIRAL" : "STRAIGHT";

  // Podest nur bei "L" (bei der Wendel ist das Polygon die Treppenmitte, Teil des Laufs).
  let landingSlab: RSlab | undefined;
  if (stair.shape === "L" && geo.landing) landingSlab = slabs.find((s) => sameRing(s.outline, geo.landing as Vec2[]));
  const treadSlabs = slabs.filter((s) => s !== landingSlab);

  const solidOf = (s: RSlab): StairSolid => ({ pts: s.outline.map(([x, y]) => ({ x, y })), zRel: s.zBottom - base, depth: s.zTop - s.zBottom });
  const groups: RSlab[][] = [];
  if (landingSlab) {
    const top = landingSlab.zTop + EPS;
    const lower = treadSlabs.filter((s) => s.zTop <= top);
    const upper = treadSlabs.filter((s) => s.zTop > top);
    for (const g of [lower, upper]) if (g.length > 0) groups.push(g);
  } else if (treadSlabs.length > 0) {
    groups.push(treadSlabs);
  }

  const flights: StairFlightParts[] = [];
  groups.forEach((g, k) => {
    // Tritte = verschiedene Oberkanten (Setzstufen-Platten und Nasen teilen die Höhe ihres Tritts).
    const tops = [...new Set(g.map((s) => Math.round(s.zTop / 1e-4)))];
    const treads = tops.length;
    // Lauflänge: Weg zwischen erstem und letztem Tritt (Schwerpunkte) plus eine Trittiefe, mit der Steigung.
    const lowest = g.reduce((m, s) => (s.zTop < m.zTop ? s : m), g[0]);
    const highest = g.reduce((m, s) => (s.zTop > m.zTop ? s : m), g[0]);
    const c0 = centroid(solidOf(lowest).pts);
    const c1 = centroid(solidOf(highest).pts);
    const run = Math.hypot(c1.x - c0.x, c1.y - c0.y) + geo.treadDepth;
    const lift = highest.zTop - lowest.zTop + geo.riserHeight;
    const solids = g.map(solidOf);
    const volume = g.reduce((s, x) => s + ringArea(x.outline.map(([px, py]) => ({ x: px, y: py }))) * (x.zTop - x.zBottom), 0);
    flights.push({
      name: groups.length > 1 ? `Lauf ${k + 1}` : "Lauf",
      risers: treads,
      treads,
      riserHeight: geo.riserHeight,
      treadLength: geo.treadDepth,
      predefined,
      quantities: flightQuantities(Math.hypot(run, lift), volume),
      solids,
    });
  });
  // Glatte Ortbeton-Laufplatte (gerade Betontreppe): ein Lauf als Netz.
  if (meshes.length > 0) {
    const positions: number[] = [];
    const indices: number[] = [];
    for (const m of meshes) {
      const at = positions.length / 3;
      for (const v of m.positions) positions.push(v);
      for (const i of m.indices) indices.push(at + i);
    }
    const mesh = ifcMesh(positions, indices, base);
    flights.push({
      name: flights.length > 0 ? `Lauf ${flights.length + 1}` : "Lauf",
      risers: geo.treads.length,
      treads: geo.treads.length,
      riserHeight: geo.riserHeight,
      treadLength: geo.treadDepth,
      predefined,
      quantities: flightQuantities(Math.hypot(stair.runLength, rise), meshVolume(mesh.positions, mesh.indices)),
      mesh,
    });
  }

  let landing: StairParts["landing"] = null;
  if (landingSlab) {
    const s = solidOf(landingSlab);
    landing = { name: "Podest", pts: s.pts, zRel: s.zRel, depth: s.depth, quantities: slabQuantities(s.pts, [], s.depth) };
  }

  let rail: StairParts["rail"] = null;
  const railMeshes = emitStairRailings(one);
  if (railMeshes.length > 0) {
    const positions: number[] = [];
    const indices: number[] = [];
    for (const m of railMeshes) {
      const at = positions.length / 3;
      for (const v of m.positions) positions.push(v);
      for (const i of m.indices) indices.push(at + i);
    }
    const sides = getStairType(project, stair)?.railing === "beide" ? 2 : 1;
    rail = {
      name: "Handlauf",
      predefined: "HANDRAIL",
      mesh: ifcMesh(positions, indices, base),
      quantities: railingQuantities(Math.hypot(stair.runLength, rise) * sides),
    };
  }
  return { flights, landing, rail };
}
