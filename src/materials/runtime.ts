// Material-Helfer: Kachelgröße und Umrechnung Bibliotheks-Asset → `ComponentMaterial`.
// (Die frühere three.js-Material-Laufzeit ist entfernt — Texturen lädt der Nordstern-Renderer
// über `viewport/materialTextures.ts`.)

import type { ComponentMaterial } from "../model/types";
import type { MaterialAsset } from "./library";

/** Default-Kachelgröße in Metern, falls `sizeM` fehlt. */
export const DEFAULT_TILE_SIZE_M = 1.0;

/** Baut aus einem Bibliotheks-Asset ein `ComponentMaterial` (Karten + Größe). */
export function materialFromAsset(
  asset: MaterialAsset,
  sizeM = DEFAULT_TILE_SIZE_M,
): ComponentMaterial {
  return {
    libraryId: asset.id,
    color: asset.maps.color,
    normal: asset.maps.normal,
    roughness: asset.maps.roughness,
    metalness: asset.maps.metalness,
    displacement: asset.maps.displacement,
    ao: asset.maps.ao,
    sizeM,
  };
}
