// Lage einer importierten Punktwolke im Projekt ([27] Stufe 1). Rein rechnend, ohne UI.
//
// Der Leser liefert `xyz` (f32) relativ zu `origin` (f64, Dateikoordinaten). Hier entsteht der
// Modellversatz dieses Ursprungs (f64, Modell-Meter x = Ost, y = Nord, z = Höhe); render3d bildet
// `versatz + xyz` in f64 und rundet erst danach auf f32 (LV95-fest, s. `render3d/src/points.rs`).
//
//  • Projekt hat einen Standort-Bezug (`geoAnchor`) und die Wolke liegt in LV95 (EPSG 2056, oder
//    ohne EPSG-Angabe mit LV95-typischen Koordinaten): lagerichtig einpassen. Höhe: mit
//    `geoAnchor.height` (m ü. M. des Bezugspunkts) absolut, sonst tiefster Punkt auf 0 + Hinweis.
//  • Sonst: Ursprung der Wolke = Projekt-Nullpunkt. Kleine (lokale) Koordinaten bleiben wie in
//    der Datei; grosse (Landeskoordinaten ohne Bezug) werden mit der Mitte auf den Nullpunkt und
//    dem tiefsten Punkt auf 0 gelegt. Immer mit Hinweis.

export type PointCloudPlacementMode = "georef" | "local" | "centered";

export interface PointCloudPlacement {
  /** Modell-Meter des Wolken-Ursprungs (x = Ost, y = Nord, z = Höhe); Punkt = offset + xyz. */
  offset: [number, number, number];
  mode: PointCloudPlacementMode;
  /** Höhe absolut übernommen (sonst tiefster Punkt auf 0 bzw. Dateihöhe). */
  heightFromAnchor: boolean;
  /** Ohne EPSG-Angabe wurde LV95 aus den Koordinaten erschlossen. */
  epsgAssumed: boolean;
}

export interface PointCloudPlacementInput {
  origin: [number, number, number];
  bboxMin: [number, number, number];
  bboxMax: [number, number, number];
  epsg: number | null;
}

/** LV95-Bereich der Schweiz (grosszügig): E 2,45–2,85 Mio., N 1,05–1,32 Mio. m. */
export function looksLikeLv95(min: [number, number, number], max: [number, number, number]): boolean {
  return min[0] >= 2_450_000 && max[0] <= 2_850_000 && min[1] >= 1_050_000 && max[1] <= 1_320_000;
}

/** Ab dieser Ausdehnung vom Nullpunkt gelten Koordinaten als „Landeskoordinaten" (nicht lokal). */
const LOCAL_LIMIT_M = 50_000;

export function placePointCloud(
  cloud: PointCloudPlacementInput,
  geoOrigin: { e: number; n: number } | null,
  geoHeight?: number,
): PointCloudPlacement {
  const [ox, oy, oz] = cloud.origin;
  const isLv95 = cloud.epsg === 2056;
  const assumeLv95 = cloud.epsg === null && looksLikeLv95(cloud.bboxMin, cloud.bboxMax);
  if (geoOrigin && (isLv95 || assumeLv95)) {
    const heightFromAnchor = geoHeight !== undefined && Number.isFinite(geoHeight);
    return {
      offset: [ox - geoOrigin.e, oy - geoOrigin.n, heightFromAnchor ? oz - geoHeight : oz - cloud.bboxMin[2]],
      mode: "georef",
      heightFromAnchor,
      epsgAssumed: assumeLv95,
    };
  }
  const far = [...cloud.bboxMin, ...cloud.bboxMax].some((v) => Math.abs(v) > LOCAL_LIMIT_M);
  if (!far) return { offset: [ox, oy, oz], mode: "local", heightFromAnchor: false, epsgAssumed: false };
  const cx = (cloud.bboxMin[0] + cloud.bboxMax[0]) / 2;
  const cy = (cloud.bboxMin[1] + cloud.bboxMax[1]) / 2;
  return {
    offset: [ox - cx, oy - cy, oz - cloud.bboxMin[2]],
    mode: "centered",
    heightFromAnchor: false,
    epsgAssumed: false,
  };
}
