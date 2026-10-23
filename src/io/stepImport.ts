// STEP-Import (ISO 10303-42 B-Rep) über truck-stepio: jede Shell der Datei wird zu einem
// tessellierten `ImportedMesh` des Kontexts (Kategorie „Import"), anwählbar wie jeder
// andere importierte Körper. Koordinaten bleiben unverändert (Meter, Z = Höhe).

import { importStepMeshes } from "../engine/truckSolid";
import { GENERIC_IMPORT_CATEGORY } from "../model/contextCategories";
import type { ImportedMesh } from "../model/types";

let counter = 0;

/** Liest STEP-Text → ein `ImportedMesh` je Körper. Wirft bei unlesbarer Datei. */
export async function stepTextToImportedMeshes(text: string, fileName: string): Promise<ImportedMesh[]> {
  const base = fileName.replace(/\.[^.]+$/, "") || "STEP";
  const meshes = await importStepMeshes(text);
  const stamp = Date.now().toString(36);
  return meshes.map((m, i) => ({
    id: `imported-step-${stamp}-${counter++}`,
    type: "importedMesh" as const,
    name: meshes.length > 1 ? `${base} (${i + 1}/${meshes.length})` : base,
    categoryCode: GENERIC_IMPORT_CATEGORY.code,
    positions: m.positions,
    indices: m.indices,
  }));
}
