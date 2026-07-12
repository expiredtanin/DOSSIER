// swissBUILDINGS3D-Import (STAC-API) — echte Gebäude-3D-Geometrie (Wände +
// Dachformen) statt der pauschal auf DEFAULT_BUILDING_HEIGHT extrudierten
// VEC25-Footprints (s. `swissTopo.ts::fetchBuildings`). Zwei Datensatz-
// Generationen, beide über dieselbe offene STAC-API (`stacApi.ts`):
//   • v2 ("ch.swisstopo.swissbuildings3d_2")   — stabil, 1-km-Tiles, ~50 MB.
//   • v3 ("ch.swisstopo.swissbuildings3d_3_0") — Beta, Solid/Separated-
//     Varianten, in Städten teils >150 MB/Tile (nicht 1-km-strukturiert) →
//     wir fallen bei leeren/zu grossen v3-Treffern automatisch auf v2 zurück.
// Referenz-Implementierung (Rhino-Vorgänger-Plugin, 1:1 als Blaupause genutzt):
// git.kgva.ch/karim/DOSSIER, Datei rhino/swisstopo.py.
//
// Assets liegen als DXF/DWG/OBJ/IFC vor (teils `.zip`) — wir wählen bevorzugt
// DXF: `parseDxf` (dxfParser.ts) liest 3DFACE/MESH/Polyface-Entities bereits
// verlustfrei zu `ImportedMesh` (positions/indices, echtes Z) — kein neuer
// Parser nötig.
//
// Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md). Einheiten: Meter.

import { bboxAround, lv95BboxToWgs84, makeOrigin } from "./lv95";
import type { GeoOrigin, LV95 } from "./lv95";
import { stacQuery, pickAsset, downloadAssetText } from "./stacApi";
import { parseDxf } from "./dxfParser";
import type { ImportedMesh } from "../model/types";

const COLLECTION_V2 = "ch.swisstopo.swissbuildings3d_2";
const COLLECTION_V3 = "ch.swisstopo.swissbuildings3d_3_0";

/** Bevorzugte Asset-Endungen, in Prioritätsreihenfolge (DXF am stabilsten,
 *  da `parseDxf` ihn direkt zu `ImportedMesh` verarbeitet). */
const ASSET_PRIORITY = [
  ".dxf",
  ".dwg",
  ".obj",
  ".ifc",
  ".dxf.zip",
  ".dwg.zip",
  ".obj.zip",
  ".ifc.zip",
];

export type BuildingsVersion = "v2" | "v3";

/** Verschiebt ein DXF-geparstes Mesh (rohe LV95-Koordinaten) um die Origin in
 *  lokale Modell-Meter — dieselbe Konvention wie `swissTopo.ts::fetchBuildings`.
 *  Exportiert (pur, kein Netzwerk) für Unit-Tests der Koordinaten-Verschiebung. */
export function shiftMeshToOrigin(
  mesh: ImportedMesh,
  origin: GeoOrigin,
  sourceId: string,
): ImportedMesh {
  const positions = mesh.positions.slice();
  for (let i = 0; i < positions.length; i += 3) {
    positions[i] -= origin.e;
    positions[i + 1] -= origin.n;
  }
  return { ...mesh, positions, name: `swissBUILDINGS3D ${sourceId}` };
}

/**
 * Schneidet ein Mesh auf eine (bereits origin-verschobene, lokale) Bounding-Box
 * zurecht: ein Dreieck bleibt, sobald MINDESTENS EIN Eckpunkt innerhalb der Box
 * liegt (grosszügig — schneidet Gebäude am Rand nicht mittendurch ab). Nötig,
 * weil eine einzelne swissBUILDINGS3D-DXF-Kachel (STAC-Tile) alle Gebäude der
 * GANZEN Kachel als EIN gemeinsames Mesh liefert (s. `dxfParser.ts::parseDxf`
 * — alle 3DFACE/Polyface-Entities eines Files landen im selben Positions-/
 * Indexpuffer) — ohne diesen Zuschnitt liefert ein einzelner Import ALLES in
 * der Kachel, auch weit ausserhalb des gesuchten Radius (bis zu mehreren km,
 * je nach Kachelgrösse). `positions` wird dabei KOMPAKTIERT (nicht referenzierte
 * Ecken entfernt, Indizes neu gemappt) — sonst sähe jeder Verbraucher, der roh
 * über `positions` statt über `indices` iteriert (z. B. eine Bounding-Box/
 * Kamera-Fit-Berechnung), weiterhin die volle, ungeschnittene Ausdehnung. Rein
 * (kein Netzwerk), exportiert für Unit-Tests.
 */
export function clipMeshToBbox(
  mesh: ImportedMesh,
  bboxLocal: [number, number, number, number],
): ImportedMesh {
  const [xMin, yMin, xMax, yMax] = bboxLocal;
  const pos = mesh.positions;
  const inBox = (idx: number): boolean => {
    const x = pos[idx * 3];
    const y = pos[idx * 3 + 1];
    return x >= xMin && x <= xMax && y >= yMin && y <= yMax;
  };
  const keptTris: [number, number, number][] = [];
  for (let i = 0; i + 2 < mesh.indices.length; i += 3) {
    const a = mesh.indices[i];
    const b = mesh.indices[i + 1];
    const c = mesh.indices[i + 2];
    if (inBox(a) || inBox(b) || inBox(c)) keptTris.push([a, b, c]);
  }
  const remap = new Map<number, number>();
  const positions: number[] = [];
  const indices: number[] = [];
  const mapVertex = (old: number): number => {
    let ni = remap.get(old);
    if (ni === undefined) {
      ni = positions.length / 3;
      positions.push(pos[old * 3], pos[old * 3 + 1], pos[old * 3 + 2]);
      remap.set(old, ni);
    }
    return ni;
  };
  for (const [a, b, c] of keptTris) indices.push(mapVertex(a), mapVertex(b), mapVertex(c));
  return { ...mesh, positions, indices };
}

export interface FetchBuildings3dResult {
  origin: GeoOrigin;
  meshes: ImportedMesh[];
  /** Tatsächlich gelieferte Version (nach evtl. v3→v2-Fallback). */
  versionUsed: BuildingsVersion;
  /**
   * Anzahl STAC-Kacheln, die NICHT geladen werden konnten (zu gross — DXF
   * komprimiert stark, eine Kachel unter {@link MAX_ASSET_BYTES} kann
   * entpackt trotzdem die max. Textlänge sprengen —, Netzwerkfehler oder
   * fehlender Inhalt). Dient der UI, „0 Gebäude" von „X Kacheln übersprungen,
   * zu gross" zu unterscheiden statt eines stummen Leer-Ergebnisses.
   */
  skippedTiles: number;
}

/**
 * Echte swissBUILDINGS3D-Gebäude (Wände + Dachformen, keine Box-Extrusion) für
 * eine LV95-bbox. `version="v3"` versucht zuerst die Beta-Generation und fällt
 * bei leeren/unbrauchbaren Treffern automatisch auf v2 zurück (analog zum
 * Rhino-Referenz-Plugin — v3-Tiles können in Städten riesig sein).
 *
 * `originIn` fehlt ⇒ neue Origin aus `center` (wie `swissTopo.ts::fetchBuildings`) —
 * so teilen sich mehrere Importquellen eines Laufs dieselbe Origin, wenn der
 * Aufrufer die erste zurückgelieferte `origin` an die nächste Quelle reicht.
 */
export async function fetchBuildings3d(
  center: LV95,
  radius: number,
  originIn?: GeoOrigin,
  version: BuildingsVersion = "v2",
): Promise<FetchBuildings3dResult> {
  const origin = originIn ?? makeOrigin(center);
  const bboxLv95 = bboxAround(center, radius);
  const bboxWgs = lv95BboxToWgs84(bboxLv95);
  // Lokale (origin-verschobene) Zuschnitt-Box — s. clipMeshToBbox: eine STAC-
  // Kachel liefert ALLE Gebäude der Kachel als EIN Mesh, nicht nur die im
  // gesuchten Radius (kann mehrere km ausserhalb des Suchpunkts umfassen).
  const clipBoxLocal: [number, number, number, number] = [
    bboxLv95[0] - origin.e,
    bboxLv95[1] - origin.n,
    bboxLv95[2] - origin.e,
    bboxLv95[3] - origin.n,
  ];

  const tryCollection = async (
    collectionId: string,
  ): Promise<{ meshes: ImportedMesh[]; skipped: number }> => {
    const items = await stacQuery(collectionId, bboxWgs, ASSET_PRIORITY);
    const meshes: ImportedMesh[] = [];
    let skipped = 0;
    for (const item of items) {
      const asset = pickAsset(item, ASSET_PRIORITY);
      if (!asset) {
        skipped++;
        continue;
      }
      const text = await downloadAssetText(asset, [".dxf"]);
      if (!text) {
        skipped++;
        continue;
      }
      const parsed = parseDxf(text);
      for (const m of parsed.meshes) {
        const clipped = clipMeshToBbox(shiftMeshToOrigin(m, origin, item.id), clipBoxLocal);
        if (clipped.indices.length > 0) meshes.push(clipped);
      }
    }
    return { meshes, skipped };
  };

  if (version === "v3") {
    const v3 = await tryCollection(COLLECTION_V3);
    if (v3.meshes.length > 0) {
      return { origin, meshes: v3.meshes, versionUsed: "v3", skippedTiles: v3.skipped };
    }
  }
  const v2 = await tryCollection(COLLECTION_V2);
  return { origin, meshes: v2.meshes, versionUsed: "v2", skippedTiles: v2.skipped };
}
