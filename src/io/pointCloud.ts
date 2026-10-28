// Punktwolken lesen ([B9] für [27]): dünne Fassade über den Rust-Leser (`src-tauri/fileio/src/pointcloud*.rs`):
// LAS 1.0–1.4, LAZ, E57, PLY, XYZ, PTS. Gleicher Weg wie der DWG-Import (`dwgParser.ts`): im Browser in
// einem Web-Worker (`pointCloud.worker.ts`), damit die UI bei hunderten MB nicht einfriert; ohne `Worker`
// (Node: CLI, Tests) direkt im aufrufenden Thread.
//
// Rust dünnt STREAMEND aus (Voxel-Raster und/oder Punktbudget), sodass auch 50 Mio. Punkte als
// wenige Millionen im Browser ankommen. Koordinaten sind f32 RELATIV zu `origin` (ganze Meter, f64):
// absolut = origin + xyz. In LV95 reicht f32 so auf Kachelgrösse für mm; absolut hätte es ~0,25 m.
//
// Nur die Datei laden — im Modell (`Project.pointClouds`) und im Renderer ist noch nichts verdrahtet
// (Vorschlag in TODO.md [27]).

import { fileioLoaded, loadFileio } from "../engine/fileioWasm";
import type { PointCloudWorkerRequest, PointCloudWorkerResponse } from "./pointCloud.worker";

/** Voreinstellung des Punktbudgets für die Anzeige (Rust dünnt darüber hinaus aus). */
export const DEFAULT_MAX_POINTS = 5_000_000;

export interface PointCloudOptions {
  /** Voxel-Kantenlänge in m (0/leer = kein festes Raster). */
  voxel?: number;
  /** Höchstzahl behaltener Punkte (Voreinstellung {@link DEFAULT_MAX_POINTS}; 0 = unbegrenzt). */
  maxPoints?: number;
}

/** Bericht aus Rust (`PointReport`, camelCase). */
export interface PointCloudReport {
  format: "las" | "laz" | "e57" | "ply" | "xyz" | "pts";
  version: string;
  pointFormat: number | null;
  pointsDeclared: number;
  pointsRead: number;
  pointsKept: number;
  pointsInvalid: number;
  /** Zuletzt verwendete Voxelkante in m (0 = nicht ausgedünnt). */
  voxel: number;
  /** Bounding-Box aller gelesenen Punkte, absolut. */
  bboxMin: [number, number, number];
  bboxMax: [number, number, number];
  origin: [number, number, number];
  hasColor: boolean;
  hasIntensity: boolean;
  hasClassification: boolean;
  intensityRange: [number, number] | null;
  /** `[Klassifikationscode, Anzahl]`, aufsteigend. */
  classCounts: Array<[number, number]>;
  /** EPSG-Code laut Datei (LV95 = 2056), falls genannt. */
  epsg: number | null;
  truncated: boolean;
  warnings: string[];
}

export interface PointCloudData {
  /** Ursprung in Dateikoordinaten; absolut = origin + xyz. */
  origin: [number, number, number];
  /** x,y,z je Punkt (f32, relativ zu `origin`). */
  xyz: Float32Array;
  /** r,g,b je Punkt (8 Bit) oder `null`. */
  rgb: Uint8Array | null;
  /** Intensität je Punkt (u16) oder `null`. */
  intensity: Uint16Array | null;
  /** ASPRS-Klassifikation je Punkt oder `null`. */
  classification: Uint8Array | null;
  report: PointCloudReport;
}

/** Dateien, die als Punktwolke geöffnet werden können (Endungen, klein). */
export const POINT_CLOUD_EXTENSIONS = ["las", "laz", "e57", "ply", "xyz", "pts"] as const;

export function isPointCloudFile(name: string): boolean {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  return (POINT_CLOUD_EXTENSIONS as readonly string[]).includes(ext);
}

function resolveOptions(o: PointCloudOptions | undefined): { voxel: number; maxPoints: number } {
  const voxel = o?.voxel !== undefined && Number.isFinite(o.voxel) && o.voxel > 0 ? o.voxel : 0;
  const maxPoints = o?.maxPoints === undefined ? DEFAULT_MAX_POINTS : o.maxPoints;
  return { voxel, maxPoints: Number.isFinite(maxPoints) && maxPoints > 0 ? Math.floor(maxPoints) : 0 };
}

/** Synchron lesen; das Format-Modul muss geladen sein (`loadFileio()`). Wirft bei unlesbaren Dateien. */
export function readPointCloudFlat(
  input: ArrayBuffer | Uint8Array,
  name: string,
  options?: PointCloudOptions,
): PointCloudData {
  const m = fileioLoaded();
  if (!m) throw new Error("Format-Modul nicht geladen: loadFileio() muss vor dem Lesen laufen.");
  const { voxel, maxPoints } = resolveOptions(options);
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let res: ReturnType<typeof m.read_point_cloud>;
  try {
    res = m.read_point_cloud(bytes, name, voxel, maxPoints);
  } catch (e) {
    throw new Error(typeof e === "string" ? e : e instanceof Error ? e.message : "Punktwolke nicht lesbar");
  }
  try {
    const rgb = res.rgb();
    const intensity = res.intensity();
    const classification = res.classification();
    const o = res.origin();
    return {
      origin: [o[0], o[1], o[2]],
      xyz: res.xyz(),
      rgb: rgb.length ? rgb : null,
      intensity: intensity.length ? intensity : null,
      classification: classification.length ? classification : null,
      report: JSON.parse(res.report_json()) as PointCloudReport,
    };
  } finally {
    res.free();
  }
}

async function runWorker(req: PointCloudWorkerRequest, transfer: Transferable[]): Promise<PointCloudWorkerResponse> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./pointCloud.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent<PointCloudWorkerResponse>) => {
      worker.terminate();
      resolve(e.data);
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message || "Punktwolken-Import (Worker) fehlgeschlagen"));
    };
    worker.postMessage(req, transfer);
  });
}

/**
 * Liest eine Punktwolke (Format wird am Inhalt erkannt, `name` nur für XYZ/PTS). Im Browser im Worker
 * (der Eingabepuffer wird dorthin ÜBERTRAGEN und ist danach leer), sonst im aufrufenden Thread.
 */
export async function readPointCloud(
  data: ArrayBuffer,
  name: string,
  options?: PointCloudOptions,
): Promise<PointCloudData> {
  if (typeof Worker === "undefined") {
    await loadFileio();
    return readPointCloudFlat(data, name, options);
  }
  const res = await runWorker({ type: "read", data, name, options }, [data]);
  if (res.type === "result") return res.cloud;
  throw new Error(res.message);
}
