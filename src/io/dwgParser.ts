// DWG-Import → Kontext-Geometrie (three-frei), echtes In-Browser-Parsing.
//
// DWG ist ein geschlossenes Binärformat; wir lesen es hier über LibreDWG-WASM
// (`@mlightcad/libredwg-web`) DIREKT im Browser — KEIN ODA-Zwischenschritt mehr.
// Ergebnis ist dasselbe `{meshes, contours}`-Format wie der DXF-Parser, damit der
// gesamte nachgelagerte Import-Fluss (Dialog, Ziel-Ebene, Layer-Handling,
// Mesh→Kontext) unverändert wiederverwendet wird.
//
// API (aus den .d.ts der Lib abgelesen, NICHT geraten):
//   LibreDwg.create()                         → Promise<LibreDwgEx> (lädt WASM)
//   dwg.dwg_read_data(buffer, Dwg_File_Type.DWG) → Dwg_Data-Pointer
//   dwg.convert(ptr)                          → DwgDatabase (stark typisiert)
//   dwg.dwg_free(ptr)                         → Speicher freigeben
// Der WASM-Build dieser Lib hat DXF-Schreiben/-Lesen DEAKTIVIERT (disable-dxf),
// daher gehen wir bewusst NICHT über DWG→DXF-Text, sondern mappen die geparste
// DwgDatabase direkt (ein Mapping, gespiegelt aus dxfParser).
//
// Unterstützte Entities (Modellraum):
//   • 3DFACE                         → Dreiecks-Mesh (3 bzw. 4 Ecken → 1–2 Tri).
//   • POLYLINE2D (Polyface, Flag 64) → Dreiecks-Mesh (Polyface-Faces).
//   • LWPOLYLINE / POLYLINE2D / 3D   → Kontur (z aus elevation/Vertex-Z).
//   • LINE                           → Kontur (zwei-Punkt-Linienzug).
//
// Lazy: Das Paket wird per dynamischem import() geladen (kein Bloat im Initial-
// Bundle); WASM startet erst beim ersten DWG-Import.
//
// Bezeichner englisch, Kommentare deutsch (CLAUDE.md).

import type { Contour, ContourSet, ImportedMesh, Vec2 } from "../model/types";
import type { DxfImportResult } from "./dxfParser";

// Lose getippte Sicht auf die libredwg-web-Entities (wir greifen tolerant auf die
// Felder zu, die wir brauchen; alle Punkte sind {x,y,z}).
interface DwgPoint {
  x: number;
  y: number;
  z?: number;
}
// Polyface-/Polyline-Vertex: Punktkoordinaten + optionale Polyface-Indizes.
interface DwgVertexLike extends DwgPoint {
  polyfaceIndex0?: number;
  polyfaceIndex1?: number;
  polyfaceIndex2?: number;
  polyfaceIndex3?: number;
  flag?: number;
}
interface DwgEntityLike {
  type?: string;
  layer?: string;
  flag?: number;
  elevation?: number;
  startPoint?: DwgPoint;
  endPoint?: DwgPoint;
  corner1?: DwgPoint;
  corner2?: DwgPoint;
  corner3?: DwgPoint;
  corner4?: DwgPoint;
  vertices?: DwgVertexLike[];
  [k: string]: unknown;
}

// Schmale Sicht auf die LibreDWG-Instanz (nur die Methoden, die wir nutzen).
interface LibreDwgApi {
  dwg_read_data(data: ArrayBuffer, fileType: number): number | undefined;
  convert(ptr: number): { entities?: unknown[] };
  dwg_free(ptr: number): void;
}

// Singleton der WASM-Instanz (einmal laden, dann wiederverwenden).
let libredwgPromise: Promise<LibreDwgApi> | null = null;

/**
 * Lädt + initialisiert LibreDWG-WASM (lazy, einmalig). Wir laden die Emscripten-
 * Glue + die `.wasm`-URL explizit über Vite (`?url`), damit die WASM-Datei in
 * Dev UND Build mit korrektem MIME-Type aufgelöst wird (sonst liefert der Dev-
 * Server `index.html` statt der WASM → „Incorrect response MIME type").
 */
function createLibreDwg(): Promise<LibreDwgApi> {
  if (!libredwgPromise) {
    libredwgPromise = (async () => {
      const [{ LibreDwg }, glue, wasmUrlMod] = await Promise.all([
        import("@mlightcad/libredwg-web"),
        // Glue + WASM über ein lokales virtuelles Modul (Alias in vite.config),
        // da das Paket seine `wasm/`-Dateien nicht über `exports` freigibt.
        import("virtual:libredwg-glue"),
        // Vite gibt die WASM als gehashtes Asset aus und liefert ihre URL.
        import("virtual:libredwg-wasm-url"),
      ]);
      const createModule = glue.default;
      const wasmUrl = wasmUrlMod.default;
      const wasmInstance = await createModule({
        // locateFile bekommt den Original-Dateinamen; wir liefern die von Vite
        // aufgelöste (gehashte) URL zurück → korrektes Laden in Dev + Build.
        locateFile: () => wasmUrl,
      });
      // createByWasmInstance erwartet das (intern getippte) MainModule; die
      // Glue liefert es als unknown → bewusster Cast, Rückgabe schmal getippt.
      return LibreDwg.createByWasmInstance(
        wasmInstance as Parameters<typeof LibreDwg.createByWasmInstance>[0],
      ) as unknown as LibreDwgApi;
    })();
  }
  return libredwgPromise;
}

let importSeq = 0;
const nextId = (prefix: string): string => `${prefix}-${Date.now()}-${importSeq++}`;

// POLYLINE-Flag 64 = Polyface-Mesh (siehe DwgPolylineFlag in der Lib).
const POLYFACE_FLAG = 64;
// POLYLINE-Flag 1 = geschlossen.
const CLOSED_FLAG = 1;

/**
 * Parst eine DWG-Datei (als ArrayBuffer) in dasselbe Kontext-Geometrie-Format
 * wie der DXF-Parser. Lädt LibreDWG-WASM lazy. Wirft bei fatalen Fehlern (der
 * Aufrufer fängt das ab und zeigt den ODA-Fallback) — pro-Entity-Fehler nicht.
 */
export async function parseDwg(data: ArrayBuffer): Promise<DxfImportResult> {
  const libredwg = await createLibreDwg();

  let dwgPtr: number | undefined;
  try {
    // Dwg_File_Type.DWG === 0 (siehe enums.d.ts der Lib). Literal, damit wir den
    // Enum-Wert nicht zusätzlich in den lazy Chunk ziehen.
    const FILE_TYPE_DWG = 0;
    dwgPtr = libredwg.dwg_read_data(data, FILE_TYPE_DWG);
    if (dwgPtr == null) {
      throw new Error("LibreDWG: dwg_read_data lieferte keinen Pointer.");
    }
    const db = libredwg.convert(dwgPtr);
    const entities = (db?.entities ?? []) as unknown as DwgEntityLike[];

    const meshTriangles: number[] = [];
    const meshIndices: number[] = [];
    const contours: Contour[] = [];

    for (const e of entities) {
      const type = (e.type ?? "").toUpperCase();
      switch (type) {
        case "3DFACE":
          addFace(meshTriangles, meshIndices, e);
          break;
        case "POLYLINE2D":
        case "POLYLINE3D":
          if (isPolyfaceMesh(e)) {
            addPolyfaceMesh(meshTriangles, meshIndices, e);
          } else {
            const ct = polylineContour(e);
            if (ct) contours.push(ct);
          }
          break;
        case "LWPOLYLINE": {
          const ct = polylineContour(e);
          if (ct) contours.push(ct);
          break;
        }
        case "LINE": {
          const ct = lineContour(e);
          if (ct) contours.push(ct);
          break;
        }
        default:
          // Unbekannte/irrelevante Entity → ignorieren (tolerant).
          break;
      }
    }

    const meshes: ImportedMesh[] = [];
    if (meshIndices.length > 0) {
      meshes.push({
        id: nextId("imported"),
        type: "importedMesh",
        name: "DWG-Mesh",
        positions: meshTriangles,
        indices: meshIndices,
      });
    }

    const contourSets: ContourSet[] = [];
    if (contours.length > 0) {
      contourSets.push({
        id: nextId("contours"),
        type: "contourSet",
        name: "DWG-Konturen",
        contours,
      });
    }

    return { meshes, contours: contourSets };
  } finally {
    // Speicher der WASM-Instanz freigeben (auch im Fehlerfall).
    if (dwgPtr != null) {
      try {
        libredwg.dwg_free(dwgPtr);
      } catch {
        // Freigabe-Fehler ignorieren — nicht fatal.
      }
    }
  }
}

// ── Mesh-Entities ────────────────────────────────────────────────────────────

/** Fügt einen Vertex zu positions hinzu und liefert seinen Index. */
function pushVertex(
  positions: number[],
  x: number,
  y: number,
  z: number,
): number {
  const idx = positions.length / 3;
  positions.push(x, y, z);
  return idx;
}

/**
 * 3DFACE: 3 oder 4 Eckpunkte (corner1..4). Bei 4 ≠ 3 Punkten zwei Dreiecke (Fan).
 */
function addFace(
  positions: number[],
  indices: number[],
  e: DwgEntityLike,
): void {
  const corners = [e.corner1, e.corner2, e.corner3, e.corner4].filter(
    (c): c is DwgPoint => !!c && Number.isFinite(c.x) && Number.isFinite(c.y),
  );
  if (corners.length < 3) return;
  const idx = corners.map((c) =>
    pushVertex(positions, c.x, c.y, c.z ?? 0),
  );
  pushTri(indices, positions, idx[0], idx[1], idx[2]);
  if (idx.length >= 4) pushTri(indices, positions, idx[0], idx[2], idx[3]);
}

/** Ob eine POLYLINE eine Polyface-Mesh-Variante ist (Flag 64 oder Polyface-Indizes). */
function isPolyfaceMesh(e: DwgEntityLike): boolean {
  if (((e.flag ?? 0) & POLYFACE_FLAG) !== 0) return true;
  return (e.vertices ?? []).some(
    (v) =>
      Number.isFinite(v.polyfaceIndex0) ||
      Number.isFinite(v.polyfaceIndex1) ||
      Number.isFinite(v.polyfaceIndex2) ||
      Number.isFinite(v.polyfaceIndex3),
  );
}

/**
 * Polyface-Mesh (POLYLINE, Flag 64): Geometrie-Vertices (mit Koordinaten, keine
 * Polyface-Indizes) und Face-Records (mit 1-basierten, ggf. negativen = unsicht-
 * bare Kante Polyface-Indizes). Wir trennen beide und fan-triangulieren jede Face.
 */
function addPolyfaceMesh(
  positions: number[],
  indices: number[],
  e: DwgEntityLike,
): void {
  const all = e.vertices ?? [];
  const hasFaceIdx = (v: DwgVertexLike): boolean =>
    !!(
      v.polyfaceIndex0 ||
      v.polyfaceIndex1 ||
      v.polyfaceIndex2 ||
      v.polyfaceIndex3
    );
  const geom = all.filter((v) => !hasFaceIdx(v));
  const faceRecs = all.filter((v) => hasFaceIdx(v));
  if (geom.length < 3) return;
  const base = positions.length / 3;
  for (const v of geom) positions.push(v.x, v.y, v.z ?? 0);
  for (const fr of faceRecs) {
    // 1-basierte Indizes; Vorzeichen markiert (un)sichtbare Kanten → abs().
    const ring = [
      fr.polyfaceIndex0,
      fr.polyfaceIndex1,
      fr.polyfaceIndex2,
      fr.polyfaceIndex3,
    ]
      .map((i) => Math.abs(i ?? 0))
      .filter((i) => i >= 1)
      .map((i) => base + (i - 1));
    if (ring.length < 3) continue;
    for (let i = 1; i + 1 < ring.length; i++) {
      pushTri(indices, positions, ring[0], ring[i], ring[i + 1]);
    }
  }
}

/**
 * Fügt ein Dreieck hinzu, sofern es nicht entartet ist (gleiche/ungültige
 * Indizes). Hält das importierte Mesh sauber.
 */
function pushTri(
  indices: number[],
  positions: number[],
  a: number,
  b: number,
  c: number,
): void {
  if (a === b || b === c || a === c) return;
  const n = positions.length / 3;
  if (a < 0 || b < 0 || c < 0 || a >= n || b >= n || c >= n) return;
  indices.push(a, b, c);
}

// ── Kontur-Entities ──────────────────────────────────────────────────────────

/**
 * LWPOLYLINE / POLYLINE2D / POLYLINE3D → Kontur. Z-Höhe: erster gültiger
 * Vertex-Z, sonst `elevation`, sonst 0. `closed` aus Flag 1. < 2 Punkte → null.
 */
function polylineContour(e: DwgEntityLike): Contour | null {
  const vs = e.vertices ?? [];
  const pts: Vec2[] = [];
  let zFromVertex: number | undefined;
  for (const v of vs) {
    if (!Number.isFinite(v.x) || !Number.isFinite(v.y)) continue;
    pts.push({ x: v.x, y: v.y });
    if (zFromVertex === undefined && Number.isFinite(v.z)) zFromVertex = v.z;
  }
  if (pts.length < 2) return null;
  const z =
    zFromVertex ??
    (Number.isFinite(e.elevation) ? (e.elevation as number) : 0);
  const closed = ((e.flag ?? 0) & CLOSED_FLAG) !== 0;
  return { z, pts, closed, layer: e.layer };
}

/** LINE → zweipunktige (offene) Kontur. Z aus dem Startpunkt (sonst 0). */
function lineContour(e: DwgEntityLike): Contour | null {
  const a = e.startPoint;
  const b = e.endPoint;
  if (
    !a ||
    !b ||
    !Number.isFinite(a.x) ||
    !Number.isFinite(a.y) ||
    !Number.isFinite(b.x) ||
    !Number.isFinite(b.y)
  ) {
    return null;
  }
  const z = Number.isFinite(a.z) ? (a.z as number) : 0;
  return {
    z,
    pts: [
      { x: a.x, y: a.y },
      { x: b.x, y: b.y },
    ],
    closed: false,
    layer: e.layer,
  };
}
