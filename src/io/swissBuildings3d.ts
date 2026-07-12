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
  const bboxWgs = lv95BboxToWgs84(bboxAround(center, radius));

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
      for (const m of parsed.meshes) meshes.push(shiftMeshToOrigin(m, origin, item.id));
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
