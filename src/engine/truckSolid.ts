let modulePromise: Promise<any> | null = null;

async function getModule(): Promise<any> {
  if (!modulePromise) {
    modulePromise = import("./pkgTruck/trucksolid.js").then(async (m: any) => {
      await m.default();
      return m;
    });
  }
  return modulePromise;
}

export interface ExtrudedMesh {
  positions: number[];
  indices: number[];
}

/** `taper` 0 (Prisma, Default) … 1 (Spitze/Kegel-Pyramide) — linear zum
 *  Profil-Schwerpunkt skaliert. */
export async function extrudePolygon(
  points: number[],
  height: number,
  taper = 0,
): Promise<ExtrudedMesh> {
  const m = await getModule();
  const json = m.extrude_polygon(JSON.stringify({ points, height, taper }));
  return JSON.parse(json) as ExtrudedMesh;
}

export async function extrudeCircle(
  cx: number,
  cy: number,
  r: number,
  height: number,
  taper = 0,
): Promise<ExtrudedMesh> {
  const m = await getModule();
  const json = m.extrude_circle(JSON.stringify({ cx, cy, r, height, taper }));
  return JSON.parse(json) as ExtrudedMesh;
}

export type BooleanOp = "union" | "difference" | "intersection";

export interface BooleanMeshResult {
  positions: number[];
  indices: number[];
  empty: boolean;
}

/** Boolesche Operation zweier Dreiecks-Meshes (Mesh-Ebenen-CSG via csgrs,
 *  truck-Integration Phase 4). Beide Meshes müssen konsistent nach außen
 *  gewundene Dreiecke haben (Rechte-Hand-Regel) — sonst liefert csgrs ein
 *  falsches Ergebnis, ohne das zu erkennen. */
export async function booleanMesh(
  a: ExtrudedMesh,
  b: ExtrudedMesh,
  op: BooleanOp,
): Promise<BooleanMeshResult> {
  const m = await getModule();
  const json = m.boolean_mesh(
    JSON.stringify({
      a_positions: a.positions,
      a_indices: a.indices,
      b_positions: b.positions,
      b_indices: b.indices,
      op,
    }),
  );
  return JSON.parse(json) as BooleanMeshResult;
}
