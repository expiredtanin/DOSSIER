// Abgleich Punktwolken-Store → render3d ([27]): welche Wolken neu hochgeladen, nur umgestellt
// (Farbmodus/Grösse/Sichtbarkeit) oder entfernt werden müssen. Rein rechnend (testbar); der Hook
// `useWasm3dRenderer.syncPointClouds` führt die Schritte aus.
//
// Neu hochladen (teuer: Millionen Punkte über die WASM-Grenze) nur, wenn sich die DATEN (Objekt-
// identität) oder die LAGE (Versatz, z. B. neuer Standort-Bezug) geändert haben — Darstellungs-
// änderungen gehen über den kleinen `set_point_cloud_style`-Weg.

import type { PointCloudData } from "../io/pointCloud";
import type { PointCloudEntry, PointColorMode } from "../state/pointCloudStore";
import { placePointCloud } from "../state/pointCloudPlacement";

export interface PointCloudSyncItem {
  id: number;
  data: PointCloudData;
  /** Modell-Meter des Wolken-Ursprungs (s. `placePointCloud`). */
  offset: [number, number, number];
  colorMode: PointColorMode;
  pointSize: number;
  visible: boolean;
}

/** Was im Renderer liegt (je id). */
export interface UploadedPointCloud {
  data: PointCloudData;
  offset: [number, number, number];
  colorMode: PointColorMode;
  pointSize: number;
  visible: boolean;
}

export type PointCloudSyncOp =
  | { kind: "set"; item: PointCloudSyncItem }
  | { kind: "style"; item: PointCloudSyncItem }
  | { kind: "remove"; id: number };

export function planPointCloudSync(
  uploaded: ReadonlyMap<number, UploadedPointCloud>,
  items: readonly PointCloudSyncItem[],
): PointCloudSyncOp[] {
  const ops: PointCloudSyncOp[] = [];
  const ids = new Set(items.map((i) => i.id));
  for (const id of uploaded.keys()) if (!ids.has(id)) ops.push({ kind: "remove", id });
  for (const item of items) {
    const prev = uploaded.get(item.id);
    const sameData =
      prev !== undefined &&
      prev.data === item.data &&
      prev.offset[0] === item.offset[0] &&
      prev.offset[1] === item.offset[1] &&
      prev.offset[2] === item.offset[2];
    if (!sameData) {
      ops.push({ kind: "set", item });
    } else if (
      prev.colorMode !== item.colorMode ||
      prev.pointSize !== item.pointSize ||
      prev.visible !== item.visible
    ) {
      ops.push({ kind: "style", item });
    }
  }
  return ops;
}

/** Store-Einträge → Abgleich-Einträge, Lage aus dem aktuellen Standort-Bezug (nur gelesen). */
export function pointCloudSyncItems(
  clouds: readonly PointCloudEntry[],
  geoOrigin: { e: number; n: number } | null,
  geoHeight: number | undefined,
): PointCloudSyncItem[] {
  return clouds.map((c) => {
    const r = c.data.report;
    const placement = placePointCloud(
      { origin: c.data.origin, bboxMin: r.bboxMin, bboxMax: r.bboxMax, epsg: r.epsg },
      geoOrigin,
      geoHeight,
    );
    return {
      id: c.id,
      data: c.data,
      offset: placement.offset,
      colorMode: c.colorMode,
      pointSize: c.pointSize,
      visible: c.visible,
    };
  });
}
