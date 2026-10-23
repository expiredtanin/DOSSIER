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

// ── B-Rep-Körper (truck 0.6): Spezifikation → Mesh / STEP ────────────────────

/** Ein Loft-Schnitt: Höhe + geschlossener Ring [x0,y0,x1,y1,…]. */
export interface LoftSectionSpec {
  z: number;
  points: number[];
}

/**
 * Beschreibung eines Volumenkörpers (1:1 `brep::SolidSpec` in `trucksolid`). Koordinaten
 * in Modell-Metern, Z = Höhe. `Boolean` arbeitet auf B-Rep-Ebene und scheitert bei
 * bündigen Flächen — Schneidkörper überstehen lassen, oder `ExtrudePlane` mit Loch nutzen.
 */
export type SolidSpec =
  | {
      kind: "extrude";
      points: number[];
      holes?: number[][];
      height: number;
      z0?: number;
      /** Eckenradius (m) der Aussenkontur — echte Kreisbögen, auch im STEP. */
      cornerRadius?: number;
      /** Fase (m) an den Ecken der Aussenkontur (gerade Abschrägung). */
      chamfer?: number;
    }
  | {
      kind: "extrudePlane";
      points: number[];
      holes?: number[][];
      origin: [number, number, number];
      uAxis: [number, number, number];
      vAxis: [number, number, number];
      depth: number;
    }
  | { kind: "revolve"; profile: number[]; cx?: number; cy?: number; angleDeg?: number }
  | { kind: "loft"; sections: LoftSectionSpec[] }
  | { kind: "cuboid"; min: [number, number, number]; max: [number, number, number] }
  | { kind: "sphere"; center: [number, number, number]; r: number }
  | { kind: "cylinder"; cx: number; cy: number; z0: number; r: number; height: number }
  | { kind: "cone"; cx: number; cy: number; z0: number; r: number; height: number }
  | { kind: "torus"; center: [number, number, number]; major: number; minor: number }
  | { kind: "boolean"; op: "union" | "difference" | "intersection"; a: SolidSpec; b: SolidSpec }
  | { kind: "translate"; v: [number, number, number]; solid: SolidSpec };

/** Tesselliert einen B-Rep-Körper (Sehnenabweichung `tol` Meter). */
export async function buildSolidMesh(spec: SolidSpec, tol = 0.01): Promise<ExtrudedMesh> {
  const m = await getModule();
  return JSON.parse(m.build_solid_mesh(JSON.stringify({ spec, tol }))) as ExtrudedMesh;
}

/** Exportiert Körper als STEP-Text (ISO 10303-42 B-Rep). */
export async function exportStepSolids(
  solids: SolidSpec[],
  fileName = "",
): Promise<string> {
  const m = await getModule();
  return m.export_step(JSON.stringify({ solids, fileName, organizationSystem: "dossier" }));
}

/** Liest STEP-Text und liefert je Körper ein Dreiecks-Mesh (`relTol` relativ zur Diagonale). */
export async function importStepMeshes(text: string, relTol = 0.0005): Promise<ExtrudedMesh[]> {
  const m = await getModule();
  return JSON.parse(m.import_step(text, relTol)) as ExtrudedMesh[];
}
