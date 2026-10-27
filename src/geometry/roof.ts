// Dach-Geometrie: Grundriss-Linien (Traufe/First/Grat/Knick) und 3D-Dachflächen eines Dachs.
// Gerechnet wird im Rust-Kern (`src-tauri/core/src/roof.rs`, Skelett für L/T/U und schiefe
// Umrisse in `roof_skeleton.rs`); hier bleiben die Typen, die flache Übergabe an die WASM-Grenze,
// die Memoisierung und `roofBaseElevation` (liest das Projekt).
//
// Koordinaten: Grundriss (x, y) in Metern; 3D-Punkte als [x, y, z] mit z = Höhe.
//
// Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

import type { Project, Roof, RoofShape, Vec2 } from "../model/types";
import { getFloor } from "../model/types";
import { core } from "../engine/coreWasm";

/** 3D-Punkt [x, y, z=Höhe] in Modell-Metern. */
export type Vec3 = [number, number, number];

/** Eine ebene Dachfläche als Polygon (3D-Eckpunkte in Umlaufreihenfolge). */
export interface RoofPlane {
  pts: Vec3[];
}

/** Vollständige Dach-Geometrie (Grundriss-Linien + 3D-Flächen). */
export interface RoofGeometry {
  /** Traufe-Umriss (Grundriss, inkl. Überstand) als geschlossener Ring. */
  eaves: Vec2[];
  /** Firstlinie(n) im Grundriss (leer bei Flach/Zelt). */
  ridges: [Vec2, Vec2][];
  /** Gratlinien (Walm/Zelt: Ecke → First/Spitze). */
  hips: [Vec2, Vec2][];
  /** Knicklinien (Mansarde). */
  breaks: [Vec2, Vec2][];
  /** 3D-Dachflächen. */
  planes: RoofPlane[];
  /** Giebelflächen (vertikale Polygone an Sattel-/Mansarde-Enden). */
  gables: Vec3[][];
  /** Firsthöhe über der Traufe (Meter). */
  ridgeHeight: number;
}

/** Bounding-Box eines Umrisses. */
export function roofBBox(outline: Vec2[]): { x0: number; y0: number; x1: number; y1: number } {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of outline) {
    if (p.x < x0) x0 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x;
    if (p.y > y1) y1 = p.y;
  }
  return { x0, y0, x1, y1 };
}

/**
 * Traufhöhe (absolutes Z) eines Dachs: `baseElevation`, sonst die OBERKANTE des
 * zugehörigen Geschosses (baseElevation + floorHeight) — das Dach sitzt also
 * standardmäßig auf der Geschossdecke auf.
 */
export function roofBaseElevation(project: Project, roof: Roof): number {
  if (roof.baseElevation !== undefined) return roof.baseElevation;
  try {
    const floor = getFloor(project, roof.floorId);
    return (floor.baseElevation ?? 0) + (floor.floorHeight ?? 0);
  } catch {
    return 0;
  }
}

// ── Flache Übergabe (Kodierung s. `roof.rs`) ────────────────────────────────

const SHAPE_CODE: Record<RoofShape, number> = { flach: 0, pult: 1, sattel: 2, walm: 3, mansarde: 4, zelt: 5 };
const MANSARD_CODE = { giebel: 0, walm: 1, zelt: 2 } as const;

function encodeRoof(roof: Roof): Float64Array {
  const pts = roof.outline;
  const buf = new Float64Array(10 + 2 * pts.length);
  buf[0] = SHAPE_CODE[roof.shape] ?? 0;
  buf[1] = roof.pitchDeg;
  buf[2] = roof.pitchUpperDeg ?? NaN;
  buf[3] = MANSARD_CODE[roof.mansardType ?? "giebel"] ?? 0;
  buf[4] = roof.mansardKneeRatio ?? NaN;
  buf[5] = roof.halfHipRatio ?? NaN;
  buf[6] = roof.overhang;
  buf[7] = roof.overhangGable ?? NaN;
  buf[8] = roof.ridgeAxis === "y" ? 1 : 0;
  buf[9] = pts.length;
  for (let i = 0; i < pts.length; i++) {
    buf[10 + 2 * i] = pts[i].x;
    buf[11 + 2 * i] = pts[i].y;
  }
  return buf;
}

/** Flächen der Geometrie als flacher Puffer `[n, (m, (x, y, z)…)…]` (für `roofUndersideAt`). */
const planesFlat = new WeakMap<RoofGeometry, Float64Array>();

function decodeGeometry(b: Float64Array): RoofGeometry {
  let i = 0;
  const ridgeHeight = b[i++];
  const pt = (): Vec2 => ({ x: b[i++], y: b[i++] });
  const eaves: Vec2[] = [];
  for (let n = b[i++]; n > 0; n--) eaves.push(pt());
  const lines = (): [Vec2, Vec2][] => {
    const out: [Vec2, Vec2][] = [];
    for (let n = b[i++]; n > 0; n--) out.push([pt(), pt()]);
    return out;
  };
  const ridges = lines();
  const hips = lines();
  const breaks = lines();
  const planesStart = i;
  const polys = (): Vec3[][] => {
    const out: Vec3[][] = [];
    for (let n = b[i++]; n > 0; n--) {
      const poly: Vec3[] = [];
      for (let m = b[i++]; m > 0; m--) poly.push([b[i++], b[i++], b[i++]]);
      out.push(poly);
    }
    return out;
  };
  const planes = polys().map((pts) => ({ pts }));
  const planesEnd = i;
  const gables = polys();
  const geo: RoofGeometry = { eaves, ridges, hips, breaks, planes, gables, ridgeHeight };
  planesFlat.set(geo, b.subarray(planesStart, planesEnd));
  return geo;
}

/**
 * Dach-Geometrie aus Form/Neigung/Überstand + Traufhöhe `eavesZ` (Rust-Kern). Rechteck: auf der
 * Bounding-Box des Umrisses, um den Überstand geweitet, First entlang `ridgeAxis`; L/T/U und
 * schiefe Umrisse: Skelett mit Graten, Kehlen und Giebeln.
 */
export function roofGeometry(roof: Roof, eavesZ: number): RoofGeometry {
  // Memo je Dach-Objekt: Dächer sind immutabel (structural sharing), die Geometrie wird je
  // Ableitung (3D, Schnitt, Pick, Highlight …) mehrfach gebraucht — ungecacht rechnete
  // projectToModel3d bei 10 Dächern ~550 ms (TS-Skelett), mit Memo ~3 ms.
  const hit = roofGeometryCache.get(roof);
  if (hit && hit.eavesZ === eavesZ) return hit.geo;
  const geo = decodeGeometry(core().roof_geometry_flat(encodeRoof(roof), eavesZ));
  roofGeometryCache.set(roof, { eavesZ, geo });
  return geo;
}

const roofGeometryCache = new WeakMap<Roof, { eavesZ: number; geo: RoofGeometry }>();

/**
 * Dach-UNTERKANTE (Innenseite der untersten Schicht) an einem Grundriss-Punkt
 * (x,y) — `null`, wenn der Punkt ausserhalb aller Dachflächen liegt (Aufsicht).
 * Ebene der ersten Fläche, die den Punkt enthält, minus `totalLayerThickness`
 * (Summe aller Dachschicht-Dicken, s. `roofLayers`). Dient dem Wand-Zuschnitt unter
 * geneigten Dächern (`toWalls3d/bands.ts`) — vermeidet, dass ein flacher Wand-Top die
 * Dachfläche durchdringt (Z-Fighting).
 */
export function roofUndersideAt(
  geo: RoofGeometry,
  totalLayerThickness: number,
  x: number,
  y: number,
): number | null {
  const z = core().roof_underside_at(roofPlanesFlat(geo), totalLayerThickness, x, y);
  return Number.isNaN(z) ? null : z;
}

/** Dachflächen als flacher Puffer `[n, (m, (x, y, z)…)…]` (Kodierung `roof.rs`), je Geometrie gemerkt. */
export function roofPlanesFlat(geo: RoofGeometry): Float64Array {
  let flat = planesFlat.get(geo);
  if (!flat) {
    const vals = [geo.planes.length];
    for (const pl of geo.planes) {
      vals.push(pl.pts.length);
      for (const v of pl.pts) vals.push(v[0], v[1], v[2]);
    }
    flat = Float64Array.from(vals);
    planesFlat.set(geo, flat);
  }
  return flat;
}
