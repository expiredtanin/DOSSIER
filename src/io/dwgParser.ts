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
//   db.entities                               → Modellraum-Entities (DwgEntity[])
//   db.tables.BLOCK_RECORD.entries            → Block-Definitionen
//                                               (name → entities[]) für INSERT.
// Der WASM-Build dieser Lib hat DXF-Schreiben/-Lesen DEAKTIVIERT (disable-dxf),
// daher gehen wir bewusst NICHT über DWG→DXF-Text, sondern mappen die geparste
// DwgDatabase direkt (ein Mapping, gespiegelt aus dxfParser).
//
// Unterstützte Entities (Modellraum + expandierte Blöcke):
//   • 3DFACE                         → Dreiecks-Mesh (3 bzw. 4 Ecken → 1–2 Tri).
//   • POLYLINE2D (Polyface, Flag 64) → Dreiecks-Mesh (Polyface-Faces).
//   • POLYLINE_PFACE (DWG-Typ 29)    → Dreiecks-Mesh, NACH DXF-LAYER GRUPPIERT
//                                       (s. `extractPfaceMeshesByLayer` — eigener
//                                       Low-Level-Pfad, da `convert()` diesen Typ
//                                       nicht auf `.entities` abbildet; verifiziert
//                                       gegen swissBUILDINGS3D-v3-„separated"-
//                                       Kacheln, dort „Roof"/„Wall"/„Floor").
//   • LWPOLYLINE / POLYLINE2D / 3D   → Kontur (z aus elevation/Vertex-Z).
//   • LINE                           → Kontur (zwei-Punkt-Linienzug).
//   • ARC                            → Kontur (Bogen, ~6° je Segment, offen).
//   • CIRCLE                         → Kontur (geschlossen, 48 Segmente).
//   • ELLIPSE                        → Kontur (geschlossen bei Vollellipse).
//   • SPLINE                         → Kontur (fitPoints, sonst controlPoints).
//   • INSERT                         → Block-Expansion mit Transformation
//                                       (Translation/Skalierung/Rotation),
//                                       rekursiv (Tiefen-Limit gegen Zyklen).
//   • POINT                          → bewusst ignoriert (kein Polylinien-Bezug).
//
// Lazy: Das Paket wird per dynamischem import() geladen (kein Bloat im Initial-
// Bundle); WASM startet erst beim ersten DWG-Import.
//
// Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

import type { Contour, ContourSet, ImportedMesh, Vec2 } from "../model/types";
import type { DxfImportResult, ImportDiagnostics } from "./dxfParser";
import { GENERIC_IMPORT_CATEGORY } from "../model/contextCategories";

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
  // ── ARC / CIRCLE ──
  center?: DwgPoint;
  radius?: number;
  startAngle?: number;
  endAngle?: number;
  // ── ELLIPSE ──
  majorAxisEndPoint?: DwgPoint;
  axisRatio?: number;
  // ── SPLINE ──
  fitPoints?: DwgPoint[];
  controlPoints?: DwgPoint[];
  // ── INSERT ──
  name?: string;
  insertionPoint?: DwgPoint;
  xScale?: number;
  yScale?: number;
  zScale?: number;
  rotation?: number;
  [k: string]: unknown;
}

// Block-Record-Tabelleneintrag: Block-Name → Entities (siehe blockRecord.d.ts).
// `handle` (Hex-String, z. B. "5E") wird für die POLYLINE_PFACE-Owner-Auflösung
// gebraucht (s. {@link extractPfaceMeshesByLayer}) — dieselbe Form wie bei
// {@link DwgLayerEntry}.
export interface DwgBlockRecordLike {
  name?: string;
  handle?: string;
  entities?: DwgEntityLike[];
}

/** LAYER-Tabelleneintrag (Name + Hex-Handle) — für die Layer-Namensauflösung
 *  von POLYLINE_PFACE-Entities (s. {@link extractPfaceMeshesByLayer}). */
export interface DwgLayerEntry {
  name?: string;
  handle?: string;
}

/** Rückgabeform von `dwg_dynapi_entity_value`/`dwg_dynapi_entity_data`
 *  (generische Feld-Introspektion) — `data` ist je Feldtyp verschieden geformt
 *  (Zahl, `{x,y,z}`-Punkt, roher Heap-Pointer bei Array-/Handle-Feldern). */
export interface DwgDynapiResult {
  success: boolean;
  data?: unknown;
}

/** Aufgelöste Handle-Referenz (`Dwg_Object_Ref`) — `obj` ist der aufgelöste
 *  Objekt-Pointer (0/null = nicht auflösbar), `absolute_ref` das Handle selbst
 *  (Zahl ODER BigInt, je nach WASM-Build). */
export interface DwgObjectRefLike {
  obj: number;
  absolute_ref: number | bigint;
}

// Schmale Sicht auf die LibreDWG-Instanz (nur die Methoden, die wir nutzen).
export interface LibreDwgApi {
  dwg_read_data(data: ArrayBuffer, fileType: number): number | undefined;
  convert(ptr: number): {
    entities?: unknown[];
    tables?: {
      BLOCK_RECORD?: { entries?: DwgBlockRecordLike[] };
      LAYER?: { entries?: DwgLayerEntry[] };
    };
  };
  dwg_free(ptr: number): void;
  // ── Low-Level-API für POLYLINE_PFACE (s. Moduldoc bei {@link extractPfaceMeshesByLayer}) ──
  dwg_getall_entity_by_type(dwgPtr: number, type: number): number[];
  dwg_dynapi_entity_value(objOrTio: number, field: string): DwgDynapiResult;
  dwg_object_to_entity_tio(objPtr: number): number;
  dwg_object_entity_get_layer_object_ref(entityPtr: number): DwgObjectRefLike;
  dwg_object_entity_get_ownerhandle_object(entityPtr: number): DwgObjectRefLike;
  dwg_ptr_to_object_ref_array(ptr: number, size: number): DwgObjectRefLike[];
  dwg_dynapi_entity_field_offset(tio: number, field: string): number;
  dwg_ptr_to_int16_t_array(ptr: number, size: number): number[];
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

// Tessellierungs-Parameter (Bögen/Kreise/Ellipsen/Splines).
const ARC_SEG_RAD = (8 * Math.PI) / 180; // ~8° je Bogen-Segment …
const ARC_MIN_SEGMENTS = 6; //              … aber mindestens 6 Segmente.
const CIRCLE_SEGMENTS = 48; //              Vollkreis-Auflösung.
const ELLIPSE_SEGMENTS = 64; //             Vollellipse-Auflösung.
const SPLINE_SEGMENTS = 64; //              Spline-Auflösung (controlPoints-Fall).

// Block-Expansions-Tiefenlimit (gegen zyklische INSERTs / Blöcke in Blöcken).
const MAX_BLOCK_DEPTH = 10;

/**
 * 2D-Affin-Transform (für INSERT-Expansion). Bildet einen Block-Modellraum auf
 * den Welt-Modellraum ab: `[x', y'] = M·[x, y] + t`. Z wird separat (additiv +
 * zScale) behandelt, da unsere Konturen 2D-Punkte + eine z-Höhe führen.
 */
interface Transform2D {
  // Lineare 2×2-Matrix (Skalierung · Rotation), spaltenweise.
  m00: number;
  m01: number;
  m10: number;
  m11: number;
  // Translation.
  tx: number;
  ty: number;
  // Z-Anteil (additiver Versatz + Skalierung).
  zOffset: number;
  zScale: number;
}

const IDENTITY: Transform2D = {
  m00: 1,
  m01: 0,
  m10: 0,
  m11: 1,
  tx: 0,
  ty: 0,
  zOffset: 0,
  zScale: 1,
};

/** Wendet eine Transform2D auf einen 2D-Punkt an. */
function applyXY(t: Transform2D, x: number, y: number): Vec2 {
  return {
    x: t.m00 * x + t.m01 * y + t.tx,
    y: t.m10 * x + t.m11 * y + t.ty,
  };
}

/** Wendet die Z-Komponente einer Transform2D auf einen z-Wert an. */
function applyZ(t: Transform2D, z: number): number {
  return z * t.zScale + t.zOffset;
}

/**
 * Verkettet zwei Transforms: `outer ∘ inner` (inner wird zuerst angewandt, dann
 * outer). Für rekursive Block-Expansion (Block in Block).
 */
function compose(outer: Transform2D, inner: Transform2D): Transform2D {
  return {
    m00: outer.m00 * inner.m00 + outer.m01 * inner.m10,
    m01: outer.m00 * inner.m01 + outer.m01 * inner.m11,
    m10: outer.m10 * inner.m00 + outer.m11 * inner.m10,
    m11: outer.m10 * inner.m01 + outer.m11 * inner.m11,
    tx: outer.m00 * inner.tx + outer.m01 * inner.ty + outer.tx,
    ty: outer.m10 * inner.tx + outer.m11 * inner.ty + outer.ty,
    zOffset: outer.zScale * inner.zOffset + outer.zOffset,
    zScale: outer.zScale * inner.zScale,
  };
}

/**
 * Baut die Einfüge-Transform eines INSERT: Skalierung (xScale/yScale/zScale) →
 * Rotation (um Z) → Translation (insertionPoint).
 */
function insertTransform(e: DwgEntityLike): Transform2D {
  const ip = e.insertionPoint ?? { x: 0, y: 0, z: 0 };
  const sx = Number.isFinite(e.xScale) ? (e.xScale as number) : 1;
  const sy = Number.isFinite(e.yScale) ? (e.yScale as number) : 1;
  const sz = Number.isFinite(e.zScale) ? (e.zScale as number) : 1;
  const rot = Number.isFinite(e.rotation) ? (e.rotation as number) : 0;
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  // M = R · S (erst skalieren, dann rotieren).
  return {
    m00: cos * sx,
    m01: -sin * sy,
    m10: sin * sx,
    m11: cos * sy,
    tx: ip.x,
    ty: ip.y,
    zOffset: ip.z ?? 0,
    zScale: sz,
  };
}

/** Positions-/Indexpuffer EINER Mesh-Gruppe (s. {@link Accum.meshesByLayer}). */
interface MeshBucket {
  positions: number[];
  indices: number[];
}

// Aufnahme-Kontext für ein Mapping-Durchlauf (Meshes + Konturen + Histogramm).
// Meshes werden NACH DXF-LAYER-NAMEN gruppiert (statt in einem einzigen Puffer)
// — swissBUILDINGS3D v3 „separated" liefert z. B. „Roof"/„Wall"/„Floor" als
// eigene Layer je Gebäudefläche; damit sich das (Nutzer-Wunsch: Dach als eigene,
// ausblendbare Sub-Ebene) im Ergebnis widerspiegelt, MUSS die Gruppierung schon
// hier beim Parsen erhalten bleiben statt in einem Layer-losen Blob zu verschwinden.
// Ein DWG ohne (oder mit nur einem) Layer ergibt weiterhin genau EIN Mesh — die
// Gruppierung ist rein additiv, kein Verhaltensbruch für den generischen Fall.
interface Accum {
  meshesByLayer: Map<string, MeshBucket>;
  contours: Contour[];
  entityCounts: Record<string, number>;
  total: number;
}

/** Liefert (und legt bei Bedarf an) den Mesh-Puffer für einen DXF-Layernamen;
 *  leerer/fehlender Layername fällt auf `"0"` zurück (AutoCAD-Konvention für
 *  „kein eigener Layer"). */
function meshBucket(acc: Accum, layer: string | undefined): MeshBucket {
  const key = layer && layer.length > 0 ? layer : "0";
  let b = acc.meshesByLayer.get(key);
  if (!b) {
    b = { positions: [], indices: [] };
    acc.meshesByLayer.set(key, b);
  }
  return b;
}

// DWG_TYPE_POLYLINE_PFACE (29) — Polyface-Mesh, wie in libredwgs `dwg.h`
// (`_dwg_entity_POLYLINE_PFACE`) benannt. Literal (statt Enum-Import), damit
// kein zusätzlicher Typ-Import den lazy WASM-Chunk aufbläht — analog zu
// `FILE_TYPE_DWG` oben.
const DWG_TYPE_POLYLINE_PFACE = 29;

/** Baut eine Hex-Handle → Name-Map aus einer Tabelle (LAYER oder BLOCK_RECORD).
 *  `handle`/`absolute_ref` sind teils `number`, teils `bigint` (je WASM-Build)
 *  — als `BigInt` normalisiert, damit der Vergleich unabhängig davon stimmt. */
function handleToNameMap(
  entries: { name?: string; handle?: string }[] | undefined,
): Map<bigint, string> {
  const map = new Map<bigint, string>();
  for (const e of entries ?? []) {
    if (!e.name || !e.handle) continue;
    const h = Number.parseInt(e.handle, 16);
    if (Number.isFinite(h)) map.set(BigInt(h), e.name);
  }
  return map;
}

/** Baut Blockname → Einfüge-Transform aus den Modellraum-INSERT-Entities
 *  (bereits von `convert()` korrekt geliefert, inkl. `layer`) — s. Moduldoc
 *  bei {@link extractPfaceMeshesByLayer}: jeder anonyme FME-Block wird genau
 *  EINMAL per INSERT platziert, dessen Transform auf die Block-lokalen
 *  POLYLINE_PFACE-Punktkoordinaten angewendet werden muss. */
function buildInsertTransformsByBlockName(
  modelSpaceEntities: DwgEntityLike[],
): Map<string, Transform2D> {
  const map = new Map<string, Transform2D>();
  for (const e of modelSpaceEntities) {
    if ((e.type ?? "").toUpperCase() !== "INSERT" || !e.name) continue;
    map.set(e.name, insertTransform(e));
  }
  return map;
}

/**
 * Extrahiert POLYLINE_PFACE-Entities (Polyface-Mesh, DWG-Typ 29) NACH LAYER
 * GRUPPIERT — direkt über die Low-Level-LibreDWG-API, weil `convert()` diesen
 * Entity-Typ NICHT auf `Dwg_Entity`-Objekte abbildet (leeres `.entities` an
 * jedem betroffenen `BLOCK_RECORD`, empirisch verifiziert gegen echte
 * swissBUILDINGS3D-v3-„separated"-Kacheln — nicht dokumentiert, kein Bug-Report
 * dazu gefunden). Die für den Zugriff nötige Ableitungskette (an echten Daten
 * durchgetestet, jeder Schritt reproduzierbar):
 *  1. `dwg_getall_entity_by_type(dwgPtr, 29)` → TIO-Pointer je Polyface-Mesh.
 *  2. `dwg_dynapi_entity_value(tio, "num_owned"/"vertex")` → Anzahl + Pointer
 *     auf das Handle-Array der referenzierten VERTEX_PFACE/_FACE-Kinder.
 *  3. `dwg_dynapi_entity_value(tio, "parent")` → `Dwg_Object_Entity*` (NICHT
 *     mit dem TIO identisch — TIO ist ein weiterer Zeiger-Schritt tiefer).
 *  4. Über `parent`: `dwg_object_entity_get_layer_object_ref`/
 *     `..._get_ownerhandle_object` → Layer- bzw. Owner-Block-Handle, gegen die
 *     LAYER-/BLOCK_RECORD-Tabelle aufgelöst (Schritt 3 ist zwingend — dieselben
 *     Funktionen mit dem TIO direkt aufgerufen liefern nur Nullen).
 *  5. `dwg_ptr_to_object_ref_array(vertexPtr, numOwned)` löst das Handle-Array
 *     zu `{obj}`-Objekten auf; `dwg_object_to_entity_tio(ref.obj)` + erneutes
 *     `dwg_dynapi_entity_value(..., "point")` liefert je nach Kind entweder
 *     einen Geometriepunkt (VERTEX_PFACE) ODER (Erfolg `false`) eine Face.
 *  6. Für Faces ist `vertind` (4× int16, DXF 71–74) ein FESTES C-Array — weder
 *     `dwg_dynapi_entity_value` NOCH `..._data` liefern es (leer/`undefined`,
 *     vermutlich in diesem WASM-Build nicht kompiliert); einziger funktio-
 *     nierender Weg: `dwg_dynapi_entity_field_offset(tio, "vertind")` (Byte-
 *     Offset im Struct) + `dwg_ptr_to_int16_t_array(tio + offset, 4)`.
 * Punkte werden mit der zum Owner-Block gehörenden INSERT-Transform (s.
 * {@link buildInsertTransformsByBlockName}) in Welt-/Tile-lokale Koordinaten
 * gebracht — Punkte liegen block-lokal nahe (0,0,0), ohne diese Transform
 * bekäme man keine brauchbaren (LV95-nahen) Koordinaten.
 */
export function extractPfaceMeshesByLayer(
  libredwg: LibreDwgApi,
  dwgPtr: number,
  db: ReturnType<LibreDwgApi["convert"]>,
  modelSpaceEntities: DwgEntityLike[],
): Map<string, MeshBucket> {
  const result = new Map<string, MeshBucket>();
  const layerNames = handleToNameMap(db.tables?.LAYER?.entries);
  const blockNames = handleToNameMap(db.tables?.BLOCK_RECORD?.entries);
  const xformByBlock = buildInsertTransformsByBlockName(modelSpaceEntities);

  const bucketFor = (layer: string): MeshBucket => {
    let b = result.get(layer);
    if (!b) {
      b = { positions: [], indices: [] };
      result.set(layer, b);
    }
    return b;
  };

  let pfaces: number[];
  try {
    pfaces = libredwg.dwg_getall_entity_by_type(dwgPtr, DWG_TYPE_POLYLINE_PFACE);
  } catch {
    return result; // WASM-Build ohne diese Low-Level-Funktion — kein harter Fehler.
  }

  for (const tio of pfaces) {
    const numOwned = libredwg.dwg_dynapi_entity_value(tio, "num_owned").data;
    const vertexArrPtr = libredwg.dwg_dynapi_entity_value(tio, "vertex").data;
    if (typeof numOwned !== "number" || numOwned <= 0 || typeof vertexArrPtr !== "number" || !vertexArrPtr) {
      continue;
    }
    const entityPtr = libredwg.dwg_dynapi_entity_value(tio, "parent").data;
    if (typeof entityPtr !== "number" || !entityPtr) continue;

    const layerRef = libredwg.dwg_object_entity_get_layer_object_ref(entityPtr);
    const layerName = layerNames.get(BigInt(layerRef.absolute_ref ?? 0)) ?? "0";
    const ownerRef = libredwg.dwg_object_entity_get_ownerhandle_object(entityPtr);
    const blockName = blockNames.get(BigInt(ownerRef.absolute_ref ?? 0));
    const xform = (blockName ? xformByBlock.get(blockName) : undefined) ?? IDENTITY;

    const bucket = bucketFor(layerName);
    const base = bucket.positions.length / 3;
    const faceRecords: number[][] = [];
    for (const ref of libredwg.dwg_ptr_to_object_ref_array(vertexArrPtr, numOwned)) {
      if (!ref.obj) continue;
      const childTio = libredwg.dwg_object_to_entity_tio(ref.obj);
      if (!childTio) continue;
      const point = libredwg.dwg_dynapi_entity_value(childTio, "point");
      if (point.success && point.data && typeof point.data === "object") {
        const p = point.data as { x: number; y: number; z: number };
        const xy = applyXY(xform, p.x, p.y);
        bucket.positions.push(xy.x, xy.y, applyZ(xform, p.z));
        continue;
      }
      // Kein Punkt → Face-Record (vertind, s. Moduldoc Schritt 6).
      const off = libredwg.dwg_dynapi_entity_field_offset(childTio, "vertind");
      if (!off) continue;
      faceRecords.push(libredwg.dwg_ptr_to_int16_t_array(childTio + off, 4));
    }
    for (const vertind of faceRecords) {
      // 1-basiert, ggf. negativ (unsichtbare Kante) — wie DXF-Faces (s.
      // `faceIndicesOf`/`dxfParser.ts`); 0 = ungenutzter 4. Slot bei Dreiecken.
      const ring = vertind
        .map((i) => Math.abs(i))
        .filter((i) => i >= 1)
        .map((i) => base + (i - 1));
      if (ring.length < 3) continue;
      for (let i = 1; i + 1 < ring.length; i++) {
        pushTri(bucket.indices, bucket.positions, ring[0], ring[i], ring[i + 1]);
      }
    }
  }
  return result;
}

/**
 * Parst eine DWG-Datei (als ArrayBuffer) in dasselbe Kontext-Geometrie-Format
 * wie der DXF-Parser. Lädt LibreDWG-WASM lazy. Wirft bei fatalen Fehlern (der
 * Aufrufer fängt das ab und zeigt den ODA-Fallback) — pro-Entity-Fehler nicht.
 *
 * Reale DWGs stecken Geometrie oft in BLÖCKEN, die nur per INSERT referenziert
 * werden; wir lesen die Block-Definitionen aus `db.tables.BLOCK_RECORD` und
 * expandieren jedes INSERT mit Transformation (rekursiv, Tiefen-Limit).
 * Zusätzlich (s. {@link extractPfaceMeshesByLayer}) werden POLYLINE_PFACE-
 * Polyface-Meshes über die Low-Level-API gelesen und NACH LAYER GRUPPIERT
 * zurückgegeben — bei swissBUILDINGS3D v3 „separated" ergeben sich so z. B.
 * eigene Meshes je „Roof"/„Wall"/„Floor" statt eines einzigen Blobs.
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

    // Block-Definitionen (name → entities) für die INSERT-Expansion.
    const blockEntries = db?.tables?.BLOCK_RECORD?.entries ?? [];
    const blocks = new Map<string, DwgEntityLike[]>();
    for (const b of blockEntries) {
      if (b?.name && Array.isArray(b.entities)) {
        blocks.set(b.name, b.entities);
      }
    }

    const acc: Accum = {
      meshesByLayer: new Map(),
      contours: [],
      entityCounts: {},
      total: 0,
    };

    // Modellraum-Entities mappen (INSERTs expandieren Blöcke rekursiv).
    mapEntities(entities, IDENTITY, blocks, 0, acc);

    // POLYLINE_PFACE-Meshes (von `convert()` nicht abgedeckt) additiv dazu.
    for (const [layer, pfaceBucket] of extractPfaceMeshesByLayer(
      libredwg,
      dwgPtr,
      db,
      entities,
    )) {
      if (pfaceBucket.indices.length === 0) continue;
      const bucket = meshBucket(acc, layer);
      const base = bucket.positions.length / 3;
      // KEIN `push(...pfaceBucket.positions)`: bei grossen Kacheln (v3-
      // Städtetiles, tausende Gebäude) sprengt der Spread-Operator die
      // Argumentzahl-Grenze von `push`/`apply` (RangeError „Maximum call
      // stack size exceeded" — an einer echten 2000-Gebäude-Kachel verifiziert).
      for (const p of pfaceBucket.positions) bucket.positions.push(p);
      for (const i of pfaceBucket.indices) bucket.indices.push(base + i);
    }

    const meshes: ImportedMesh[] = [];
    const multiLayer = acc.meshesByLayer.size > 1;
    for (const [layer, bucket] of acc.meshesByLayer) {
      if (bucket.indices.length === 0) continue;
      meshes.push({
        id: nextId("imported"),
        type: "importedMesh",
        name: multiLayer ? `DWG-Mesh (${layer})` : "DWG-Mesh",
        categoryCode: GENERIC_IMPORT_CATEGORY.code,
        layer: layer === "0" ? undefined : layer,
        positions: bucket.positions,
        indices: bucket.indices,
      });
    }

    const contourSets: ContourSet[] = [];
    if (acc.contours.length > 0) {
      contourSets.push({
        id: nextId("contours"),
        type: "contourSet",
        name: "DWG-Konturen",
        categoryCode: GENERIC_IMPORT_CATEGORY.code,
        contours: acc.contours,
      });
    }

    const diagnostics: ImportDiagnostics = {
      entityCounts: acc.entityCounts,
      total: acc.total,
    };

    // Diagnose immer loggen; im „nichts gemappt"-Fall hervorheben (Histogramm
    // macht die Ursache sichtbar: 0 Entities = Encoding/Version vs. Abdeckungs-
    // lücke = z. B. „500 ARC, 200 INSERT").
    const mapped = meshes.length + contourSets.length;
    if (mapped === 0) {
      console.info(
        "[dwgParser] Keine Geometrie gemappt. Entity-Histogramm:",
        acc.entityCounts,
        `(${acc.total} Entities)`,
      );
    } else {
      console.info(
        "[dwgParser] Entity-Histogramm:",
        acc.entityCounts,
        `(${acc.total} Entities)`,
      );
    }

    return { meshes, contours: contourSets, diagnostics };
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

/**
 * Mappt eine Entity-Liste unter einer Transform in den Aufnahme-Kontext. INSERTs
 * werden über `blocks` aufgelöst und rekursiv (mit verketteter Transform) erneut
 * gemappt; `depth` begrenzt die Rekursion gegen zyklische Blöcke.
 */
function mapEntities(
  entities: DwgEntityLike[],
  xform: Transform2D,
  blocks: Map<string, DwgEntityLike[]>,
  depth: number,
  acc: Accum,
): void {
  for (const e of entities) {
    const type = (e.type ?? "").toUpperCase();
    // Histogramm zählt JEDE betrachtete Entity (auch ignorierte/expandierte).
    acc.entityCounts[type] = (acc.entityCounts[type] ?? 0) + 1;
    acc.total += 1;

    switch (type) {
      case "3DFACE":
        addFace(acc, e, xform);
        break;
      case "POLYLINE2D":
      case "POLYLINE3D":
        if (isPolyfaceMesh(e)) {
          addPolyfaceMesh(acc, e, xform);
        } else {
          const ct = polylineContour(e, xform);
          if (ct) acc.contours.push(ct);
        }
        break;
      case "LWPOLYLINE": {
        const ct = polylineContour(e, xform);
        if (ct) acc.contours.push(ct);
        break;
      }
      case "LINE": {
        const ct = lineContour(e, xform);
        if (ct) acc.contours.push(ct);
        break;
      }
      case "ARC": {
        const ct = arcContour(e, xform);
        if (ct) acc.contours.push(ct);
        break;
      }
      case "CIRCLE": {
        const ct = circleContour(e, xform);
        if (ct) acc.contours.push(ct);
        break;
      }
      case "ELLIPSE": {
        const ct = ellipseContour(e, xform);
        if (ct) acc.contours.push(ct);
        break;
      }
      case "SPLINE": {
        const ct = splineContour(e, xform);
        if (ct) acc.contours.push(ct);
        break;
      }
      case "INSERT": {
        if (depth >= MAX_BLOCK_DEPTH) break; // Zyklen-/Tiefenschutz.
        const blockEntities = e.name ? blocks.get(e.name) : undefined;
        if (!blockEntities || blockEntities.length === 0) break;
        const local = compose(xform, insertTransform(e));
        mapEntities(blockEntities, local, blocks, depth + 1, acc);
        break;
      }
      case "POINT":
        // POINT bewusst ignorieren (kein Polylinien-/Flächenbezug).
        break;
      default:
        // Unbekannte/irrelevante Entity → ignorieren (tolerant).
        break;
    }
  }
}

// ── Mesh-Entities ────────────────────────────────────────────────────────────

/**
 * 3DFACE: 3 oder 4 Eckpunkte (corner1..4). Bei 4 ≠ 3 Punkten zwei Dreiecke (Fan).
 * Punkte werden mit der aktiven Transform in den Modellraum gebracht.
 */
function addFace(acc: Accum, e: DwgEntityLike, xform: Transform2D): void {
  const bucket = meshBucket(acc, e.layer);
  const positions = bucket.positions;
  const indices = bucket.indices;
  const corners = [e.corner1, e.corner2, e.corner3, e.corner4].filter(
    (c): c is DwgPoint => !!c && Number.isFinite(c.x) && Number.isFinite(c.y),
  );
  if (corners.length < 3) return;
  const idx = corners.map((c) => {
    const p = applyXY(xform, c.x, c.y);
    return pushVertex(positions, p.x, p.y, applyZ(xform, c.z ?? 0));
  });
  pushTri(indices, positions, idx[0], idx[1], idx[2]);
  if (idx.length >= 4) pushTri(indices, positions, idx[0], idx[2], idx[3]);
}

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
  acc: Accum,
  e: DwgEntityLike,
  xform: Transform2D,
): void {
  const bucket = meshBucket(acc, e.layer);
  const positions = bucket.positions;
  const indices = bucket.indices;
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
  for (const v of geom) {
    const p = applyXY(xform, v.x, v.y);
    positions.push(p.x, p.y, applyZ(xform, v.z ?? 0));
  }
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
 * Punkte werden mit der aktiven Transform abgebildet.
 */
function polylineContour(e: DwgEntityLike, xform: Transform2D): Contour | null {
  const vs = e.vertices ?? [];
  const pts: Vec2[] = [];
  let zFromVertex: number | undefined;
  for (const v of vs) {
    if (!Number.isFinite(v.x) || !Number.isFinite(v.y)) continue;
    pts.push(applyXY(xform, v.x, v.y));
    if (zFromVertex === undefined && Number.isFinite(v.z)) zFromVertex = v.z;
  }
  if (pts.length < 2) return null;
  const z0 =
    zFromVertex ??
    (Number.isFinite(e.elevation) ? (e.elevation as number) : 0);
  const closed = ((e.flag ?? 0) & CLOSED_FLAG) !== 0;
  return { z: applyZ(xform, z0), pts, closed, layer: e.layer };
}

/** LINE → zweipunktige (offene) Kontur. Z aus dem Startpunkt (sonst 0). */
function lineContour(e: DwgEntityLike, xform: Transform2D): Contour | null {
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
  const z0 = Number.isFinite(a.z) ? (a.z as number) : 0;
  return {
    z: applyZ(xform, z0),
    pts: [applyXY(xform, a.x, a.y), applyXY(xform, b.x, b.y)],
    closed: false,
    layer: e.layer,
  };
}

/**
 * ARC → offene Polylinien-Kontur. Wir tessellieren von startAngle nach endAngle
 * (CCW, normalisiert) in ~ARC_SEG_RAD-Schritten (min. ARC_MIN_SEGMENTS). Winkel
 * sind im Bogenmaß (libredwg liefert ARC-Winkel in Radiant).
 */
function arcContour(e: DwgEntityLike, xform: Transform2D): Contour | null {
  const c = e.center;
  const r = e.radius;
  if (
    !c ||
    !Number.isFinite(c.x) ||
    !Number.isFinite(c.y) ||
    !Number.isFinite(r) ||
    (r as number) <= 0
  ) {
    return null;
  }
  let a0 = Number.isFinite(e.startAngle) ? (e.startAngle as number) : 0;
  let a1 = Number.isFinite(e.endAngle) ? (e.endAngle as number) : 2 * Math.PI;
  // Sweep CCW normalisieren (a1 stets ≥ a0).
  while (a1 < a0) a1 += 2 * Math.PI;
  const sweep = a1 - a0;
  const segments = Math.max(
    ARC_MIN_SEGMENTS,
    Math.ceil(sweep / ARC_SEG_RAD),
  );
  const pts: Vec2[] = [];
  const radius = r as number;
  for (let i = 0; i <= segments; i++) {
    const ang = a0 + (sweep * i) / segments;
    const x = c.x + radius * Math.cos(ang);
    const y = c.y + radius * Math.sin(ang);
    pts.push(applyXY(xform, x, y));
  }
  const z0 = Number.isFinite(c.z) ? (c.z as number) : 0;
  return { z: applyZ(xform, z0), pts, closed: false, layer: e.layer };
}

/** CIRCLE → geschlossene Polylinien-Kontur (CIRCLE_SEGMENTS Segmente). */
function circleContour(e: DwgEntityLike, xform: Transform2D): Contour | null {
  const c = e.center;
  const r = e.radius;
  if (
    !c ||
    !Number.isFinite(c.x) ||
    !Number.isFinite(c.y) ||
    !Number.isFinite(r) ||
    (r as number) <= 0
  ) {
    return null;
  }
  const radius = r as number;
  const pts: Vec2[] = [];
  for (let i = 0; i < CIRCLE_SEGMENTS; i++) {
    const ang = (2 * Math.PI * i) / CIRCLE_SEGMENTS;
    const x = c.x + radius * Math.cos(ang);
    const y = c.y + radius * Math.sin(ang);
    pts.push(applyXY(xform, x, y));
  }
  const z0 = Number.isFinite(c.z) ? (c.z as number) : 0;
  return { z: applyZ(xform, z0), pts, closed: true, layer: e.layer };
}

/**
 * ELLIPSE → Polylinien-Kontur. `majorAxisEndPoint` ist der Endpunkt der Haupt-
 * achse RELATIV zum Zentrum (WCS); `axisRatio` = Nebenachse/Hauptachse. start/
 * endAngle sind Parameter (0 … 2π bei Vollellipse). Geschlossen, wenn der Sweep
 * (nahezu) eine volle Umdrehung ist.
 */
function ellipseContour(e: DwgEntityLike, xform: Transform2D): Contour | null {
  const c = e.center;
  const maj = e.majorAxisEndPoint;
  if (
    !c ||
    !maj ||
    !Number.isFinite(c.x) ||
    !Number.isFinite(c.y) ||
    !Number.isFinite(maj.x) ||
    !Number.isFinite(maj.y)
  ) {
    return null;
  }
  const ratio = Number.isFinite(e.axisRatio) ? (e.axisRatio as number) : 1;
  // Hauptachsen-Vektor (relativ) + dazu senkrechter Nebenachsen-Vektor.
  const ux = maj.x;
  const uy = maj.y;
  const vx = -uy * ratio;
  const vy = ux * ratio;
  let p0 = Number.isFinite(e.startAngle) ? (e.startAngle as number) : 0;
  let p1 = Number.isFinite(e.endAngle) ? (e.endAngle as number) : 2 * Math.PI;
  while (p1 < p0) p1 += 2 * Math.PI;
  const sweep = p1 - p0;
  const full = sweep >= 2 * Math.PI - 1e-6;
  const segments = Math.max(
    ARC_MIN_SEGMENTS,
    Math.ceil((ELLIPSE_SEGMENTS * sweep) / (2 * Math.PI)),
  );
  const pts: Vec2[] = [];
  // Bei Vollellipse Endpunkt = Startpunkt → letztes Segment auslassen (closed).
  const count = full ? segments : segments + 1;
  for (let i = 0; i < count; i++) {
    const param = p0 + (sweep * i) / segments;
    const ct = Math.cos(param);
    const st = Math.sin(param);
    const x = c.x + ux * ct + vx * st;
    const y = c.y + uy * ct + vy * st;
    pts.push(applyXY(xform, x, y));
  }
  if (pts.length < 2) return null;
  const z0 = Number.isFinite(c.z) ? (c.z as number) : 0;
  return { z: applyZ(xform, z0), pts, closed: full, layer: e.layer };
}

/**
 * SPLINE → Polylinien-Kontur. Bevorzugt `fitPoints` (durch die der Spline läuft);
 * fehlen sie, tessellieren wir eine offene uniforme B-Spline über die
 * `controlPoints` (De-Boor mit Standard-Clamped-Knoten, Grad aus `degree`).
 * `closed` aus Flag 1 (geschlossener Spline). Z aus dem ersten Punkt.
 */
function splineContour(e: DwgEntityLike, xform: Transform2D): Contour | null {
  const closed = ((e.flag ?? 0) & CLOSED_FLAG) !== 0;
  const fit = (e.fitPoints ?? []).filter(
    (p) => !!p && Number.isFinite(p.x) && Number.isFinite(p.y),
  );
  let raw: Vec2[];
  let z0 = 0;
  if (fit.length >= 2) {
    raw = fit.map((p) => ({ x: p.x, y: p.y }));
    z0 = Number.isFinite(fit[0].z) ? (fit[0].z as number) : 0;
  } else {
    const ctrl = (e.controlPoints ?? []).filter(
      (p) => !!p && Number.isFinite(p.x) && Number.isFinite(p.y),
    );
    if (ctrl.length < 2) return null;
    z0 = Number.isFinite(ctrl[0].z) ? (ctrl[0].z as number) : 0;
    const degree = Number.isFinite(e.degree)
      ? Math.max(1, Math.min(ctrl.length - 1, e.degree as number))
      : Math.min(3, ctrl.length - 1);
    raw = tessellateBSpline(
      ctrl.map((p) => ({ x: p.x, y: p.y })),
      degree,
      SPLINE_SEGMENTS,
    );
  }
  if (raw.length < 2) return null;
  const pts = raw.map((p) => applyXY(xform, p.x, p.y));
  return { z: applyZ(xform, z0), pts, closed, layer: e.layer };
}

/**
 * Uniforme Clamped-B-Spline über `ctrl` (Grad `degree`) in `samples` gleichmäßige
 * Auswertungspunkte. Standard-Knotenvektor (clamped: Endknoten degree+1-fach).
 * Bewusst einfach; ausreichend für Kontext-/Snap-Geometrie. Liefert bei < degree+1
 * Kontrollpunkten einfach den Kontrollpolygonzug zurück.
 */
function tessellateBSpline(ctrl: Vec2[], degree: number, samples: number): Vec2[] {
  const n = ctrl.length - 1;
  if (n < degree) return ctrl.slice();
  // Clamped uniform knots: 0…0 (degree+1×), 1,2,…, m-degree-1, dann max (degree+1×).
  const knotCount = n + degree + 2;
  const knots: number[] = [];
  const interior = knotCount - 2 * (degree + 1);
  for (let i = 0; i < degree + 1; i++) knots.push(0);
  for (let i = 1; i <= interior; i++) knots.push(i / (interior + 1));
  for (let i = 0; i < degree + 1; i++) knots.push(1);
  const out: Vec2[] = [];
  for (let s = 0; s <= samples; s++) {
    // u im halboffenen [0,1); letztes Sample exakt 1.
    const u = s === samples ? 1 - 1e-9 : s / samples;
    out.push(deBoor(ctrl, knots, degree, u));
  }
  return out;
}

/** De-Boor-Auswertung einer B-Spline an Parameter u (0…1). */
function deBoor(ctrl: Vec2[], knots: number[], degree: number, u: number): Vec2 {
  // Knoten-Span k finden mit knots[k] <= u < knots[k+1].
  const n = ctrl.length - 1;
  let k = degree;
  while (k < n && knots[k + 1] <= u) k++;
  // Lokale Kontrollpunkte kopieren.
  const d: Vec2[] = [];
  for (let j = 0; j <= degree; j++) {
    const cp = ctrl[k - degree + j] ?? ctrl[ctrl.length - 1];
    d.push({ x: cp.x, y: cp.y });
  }
  for (let r = 1; r <= degree; r++) {
    for (let j = degree; j >= r; j--) {
      const i = k - degree + j;
      const denom = knots[i + degree - r + 1] - knots[i];
      const alpha = denom === 0 ? 0 : (u - knots[i]) / denom;
      d[j] = {
        x: (1 - alpha) * d[j - 1].x + alpha * d[j].x,
        y: (1 - alpha) * d[j - 1].y + alpha * d[j].y,
      };
    }
  }
  return d[degree];
}
