// `extractPfaceMeshesByLayer` liest POLYLINE_PFACE-Entities (DWG-Typ 29, Polyface-
// Mesh) über die LOW-LEVEL-LibreDWG-API, weil `convert()` diesen Typ nachweislich
// NICHT auf `.entities` abbildet (leeres Ergebnis an jedem betroffenen
// BLOCK_RECORD — empirisch gegen echte swissBUILDINGS3D-v3-„separated"-Kacheln
// verifiziert). Die Ableitungskette (Pointer→TIO→parent→layer/owner-Handle,
// Vertex-Array→Punkte/Face-Records) ist fehleranfällig genug, um eine echte
// Regressionsabsicherung zu verdienen — dieser Test baut eine handgeschriebene
// Fake-`LibreDwgApi` nach exakt dem Schema, das gegen echte Daten verifiziert
// wurde (s. Moduldoc in dwgParser.ts), statt echtes WASM zu laden.

import { describe, it, expect } from "vitest";
import {
  extractPfaceMeshesByLayer,
  type LibreDwgApi,
  type DwgDynapiResult,
  type DwgObjectRefLike,
} from "./dwgParser";

/** Baut eine Fake-API mit genau EINEM Polyface-Mesh: 3 Punkte + 1 Dreieck-Face,
 *  Layer + Owner-Block wählbar (für Mehr-Layer-Tests). Punkte sind block-lokal
 *  bei (0,0,z)/(1,0,z)/(0,1,z); die INSERT-Transform verschiebt sie um `insert`. */
function fakeApi(opts: {
  layerHandle: string;
  layerName: string;
  blockHandle: string;
  blockName: string;
  insert: { x: number; y: number; z: number };
}): LibreDwgApi {
  const pfaceTio = 1;
  const entityPtr = 2;
  const vertexArrPtr = 3;
  // Vertex-Ref-Objekte: 3 Punkte (10/11/12) + 1 Face-Record (13).
  const refs: DwgObjectRefLike[] = [
    { obj: 10, absolute_ref: 0 },
    { obj: 11, absolute_ref: 0 },
    { obj: 12, absolute_ref: 0 },
    { obj: 13, absolute_ref: 0 },
  ];
  const tioOf = (objPtr: number): number => objPtr * 100; // 10->1000, 13->1300 …
  const points: Record<number, { x: number; y: number; z: number }> = {
    [tioOf(10)]: { x: 0, y: 0, z: 1808.7 },
    [tioOf(11)]: { x: 1, y: 0, z: 1809 },
    [tioOf(12)]: { x: 0, y: 1, z: 1810 },
  };
  const VERTIND_OFFSET = 8;

  return {
    dwg_read_data: () => undefined,
    convert: () => ({
      entities: [
        {
          type: "INSERT",
          name: opts.blockName,
          layer: opts.layerName,
          insertionPoint: opts.insert,
          rotation: 0,
          xScale: 1,
          yScale: 1,
          zScale: 1,
        },
      ],
      tables: {
        LAYER: { entries: [{ name: opts.layerName, handle: opts.layerHandle }] },
        BLOCK_RECORD: { entries: [{ name: opts.blockName, handle: opts.blockHandle }] },
      },
    }),
    dwg_free: () => {},
    dwg_getall_entity_by_type: () => [pfaceTio],
    dwg_dynapi_entity_value: (objOrTio: number, field: string): DwgDynapiResult => {
      if (objOrTio === pfaceTio) {
        if (field === "num_owned") return { success: true, data: refs.length };
        if (field === "vertex") return { success: true, data: vertexArrPtr };
        if (field === "parent") return { success: true, data: entityPtr };
      }
      if (field === "point") {
        const p = points[objOrTio];
        return p ? { success: true, data: p } : { success: false };
      }
      return { success: false };
    },
    dwg_object_to_entity_tio: (objPtr: number) => tioOf(objPtr),
    dwg_object_entity_get_layer_object_ref: () => ({
      obj: 0,
      absolute_ref: Number.parseInt(opts.layerHandle, 16),
    }),
    dwg_object_entity_get_ownerhandle_object: () => ({
      obj: 0,
      absolute_ref: Number.parseInt(opts.blockHandle, 16),
    }),
    dwg_ptr_to_object_ref_array: (ptr: number) => (ptr === vertexArrPtr ? refs : []),
    dwg_dynapi_entity_field_offset: (tio: number, field: string) =>
      field === "vertind" && tio === tioOf(13) ? VERTIND_OFFSET : 0,
    dwg_ptr_to_int16_t_array: (ptr: number) =>
      ptr === tioOf(13) + VERTIND_OFFSET ? [1, 2, 3, 0] : [],
  };
}

describe("extractPfaceMeshesByLayer", () => {
  it("liest Punkte + Dreieck-Face eines Polyface-Meshes und ordnet sie dem DXF-Layer zu", () => {
    const api = fakeApi({
      layerHandle: "5E",
      layerName: "Roof",
      blockHandle: "60",
      blockName: "FMEBLOCK1",
      insert: { x: 2739334.4, y: 1176965.2, z: 0 },
    });
    const db = api.convert(0);
    const result = extractPfaceMeshesByLayer(api, 0, db, db.entities as never);

    expect([...result.keys()]).toEqual(["Roof"]);
    const bucket = result.get("Roof")!;
    // 3 Punkte, je um die INSERT-Insertion verschoben (Skalierung 1, Rotation 0).
    expect(bucket.positions).toEqual([
      2739334.4, 1176965.2, 1808.7,
      2739335.4, 1176965.2, 1809,
      2739334.4, 1176966.2, 1810,
    ]);
    // Ein Dreieck (vertind [1,2,3,0] -> 0-basiert [0,1,2], 4. Slot ungenutzt).
    expect(bucket.indices).toEqual([0, 1, 2]);
  });

  it("gruppiert mehrere Polyface-Meshes nach ihrem jeweiligen Layer getrennt", () => {
    const roofApi = fakeApi({
      layerHandle: "5E",
      layerName: "Roof",
      blockHandle: "60",
      blockName: "B1",
      insert: { x: 0, y: 0, z: 0 },
    });
    // Zweite Fake-Instanz mit Layer "Wall" statt "Roof" — dieselbe Struktur,
    // andere Handle-Zuordnung, um die Gruppierung (nicht nur den Einzelfall) zu prüfen.
    const wallApi = fakeApi({
      layerHandle: "E3C",
      layerName: "Wall",
      blockHandle: "8C6",
      blockName: "B2",
      insert: { x: 0, y: 0, z: 0 },
    });
    const roofDb = roofApi.convert(0);
    const wallDb = wallApi.convert(0);
    const roofResult = extractPfaceMeshesByLayer(roofApi, 0, roofDb, roofDb.entities as never);
    const wallResult = extractPfaceMeshesByLayer(wallApi, 0, wallDb, wallDb.entities as never);

    expect([...roofResult.keys()]).toEqual(["Roof"]);
    expect([...wallResult.keys()]).toEqual(["Wall"]);
  });

  it("überspringt ein Polyface-Mesh ohne auflösbares num_owned/vertex statt zu werfen", () => {
    const api = fakeApi({
      layerHandle: "5E",
      layerName: "Roof",
      blockHandle: "60",
      blockName: "FMEBLOCK1",
      insert: { x: 0, y: 0, z: 0 },
    });
    const broken: LibreDwgApi = {
      ...api,
      dwg_dynapi_entity_value: (objOrTio, field) =>
        field === "num_owned" || field === "vertex"
          ? { success: false }
          : api.dwg_dynapi_entity_value(objOrTio, field),
    };
    const db = broken.convert(0);
    const result = extractPfaceMeshesByLayer(broken, 0, db, db.entities as never);
    expect(result.size).toBe(0);
  });

  it("liefert eine leere Map, wenn dwg_getall_entity_by_type nicht verfügbar ist (kein Absturz)", () => {
    const api = fakeApi({
      layerHandle: "5E",
      layerName: "Roof",
      blockHandle: "60",
      blockName: "FMEBLOCK1",
      insert: { x: 0, y: 0, z: 0 },
    });
    const unsupported: LibreDwgApi = {
      ...api,
      dwg_getall_entity_by_type: () => {
        throw new Error("nicht in diesem WASM-Build kompiliert");
      },
    };
    const db = unsupported.convert(0);
    const result = extractPfaceMeshesByLayer(unsupported, 0, db, db.entities as never);
    expect(result.size).toBe(0);
  });
});
