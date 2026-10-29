import { wasmInitArg } from "./wasmSource";

let modulePromise: Promise<any> | null = null;

async function getModule(): Promise<any> {
  if (!modulePromise) {
    modulePromise = import("./pkgTruck/trucksolid.js").then(async (m: any) => {
      await m.default(await wasmInitArg("trucksolid"));
      return m;
    });
  }
  return modulePromise;
}

/** Ob ein Fehler ein WASM-Panic ist (Rust `panic!`/`unwrap` → Trap „unreachable"). */
function isWasmTrap(e: unknown): boolean {
  const msg = e instanceof Error ? `${e.name} ${e.message}` : String(e);
  return /RuntimeError|unreachable|memory access out of bounds|recursive use of an object/i.test(msg);
}

/**
 * Ruft eine WASM-Funktion abgesichert auf (lessons-bimcraft [14]): nach einem Panic ist die
 * Modul-Instanz unbrauchbar (Rust-Zustand verwaist) — sie wird verworfen, neu instanziiert und
 * der Aufruf EINMAL wiederholt. Scheitert auch das, kommt eine klare Fehlermeldung statt des
 * rohen Traps; der Aufrufer fällt auf Prisma/Platzhalter zurück (so tun es voids3d/extrusions).
 * Normale Rust-Fehler (`JsError`, z. B. „Boolean fehlgeschlagen") laufen unverändert durch.
 */
export async function guarded<T>(call: (m: any) => T): Promise<T> {
  try {
    return call(await getModule());
  } catch (e) {
    if (!isWasmTrap(e)) throw e;
    modulePromise = null; // Instanz verwerfen
    try {
      return call(await getModule());
    } catch (e2) {
      if (isWasmTrap(e2)) {
        modulePromise = null;
        throw new Error("Geometrie-Kern (truck) ist abgestürzt und wurde neu gestartet — Vorgang übersprungen.");
      }
      throw e2;
    }
  }
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
  const json = await guarded((m) => m.extrude_polygon(JSON.stringify({ points, height, taper })));
  return JSON.parse(json) as ExtrudedMesh;
}

export async function extrudeCircle(
  cx: number,
  cy: number,
  r: number,
  height: number,
  taper = 0,
): Promise<ExtrudedMesh> {
  const json = await guarded((m) => m.extrude_circle(JSON.stringify({ cx, cy, r, height, taper })));
  return JSON.parse(json) as ExtrudedMesh;
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
  | { kind: "translate"; v: [number, number, number]; solid: SolidSpec }
  | { kind: "transform"; m: number[]; solid: SolidSpec }
  /** Fertiges Dreiecks-Mesh: nur Kennwerte, Kollision, Mesh-Booleans (kein STEP-Export). */
  | { kind: "mesh"; positions: number[]; indices: number[] };

/** Tesselliert einen B-Rep-Körper (Sehnenabweichung `tol` Meter). */
export async function buildSolidMesh(spec: SolidSpec, tol = 0.01): Promise<ExtrudedMesh> {
  return JSON.parse(await guarded((m) => m.build_solid_mesh(JSON.stringify({ spec, tol })))) as ExtrudedMesh;
}

/** Kennwerte eines Körpers (Meter / m² / m³). */
export interface SolidProps {
  volume: number;
  area: number;
  centroid: [number, number, number];
  /** Wasserdicht (geschlossenes, orientiertes Mesh). */
  closed: boolean;
  min: [number, number, number];
  max: [number, number, number];
}

export async function solidProps(spec: SolidSpec, tol = 0.005): Promise<SolidProps> {
  return JSON.parse(await guarded((m) => m.solid_props(JSON.stringify({ spec, tol })))) as SolidProps;
}

export interface ClashResult {
  colliding: boolean;
  /** Durchdringungslinien [x0,y0,z0,x1,y1,z1]. */
  lines: Array<[number, number, number, number, number, number]>;
  /** Volumen der Durchdringung (m³), falls berechenbar. */
  overlapVolume: number | null;
}

/** Kollisionsprüfung zweier Körper (truck-meshalgo). */
export async function solidClash(a: SolidSpec, b: SolidSpec, tol = 0.01): Promise<ClashResult> {
  const r = JSON.parse(await guarded((m) => m.solid_clash(JSON.stringify({ a, b, tol })))) as {
    colliding: boolean;
    lines: ClashResult["lines"];
    overlap_volume: number | null;
  };
  return { colliding: r.colliding, lines: r.lines, overlapVolume: r.overlap_volume };
}

/** Exportiert Körper als STEP-Text (ISO 10303-42 B-Rep). */
export async function exportStepSolids(
  solids: SolidSpec[],
  fileName = "",
): Promise<string> {
  return guarded((m) => m.export_step(JSON.stringify({ solids, fileName, organizationSystem: "dossier" })));
}

/**
 * Liest STEP-Text und liefert die tessellierten Körper als flachen Puffer für den Kern
 * (`ProjectDocument.importStep`; Aufbau `trucksolid::brep::step_meshes_flat`). `relTol` relativ zur Diagonale.
 */
export async function readStepFlat(text: string, relTol = 0.0005): Promise<Float64Array> {
  return guarded((m) => m.import_step_flat(text, relTol));
}
