// 3D-Teile einzelner Bauteile für die Exporte (OBJ/STL/glTF, IFC): dieselben Ableitungen wie das 3D,
// gerechnet im Kern auf dem Projekt-Dokument (`queries.rs`, [K4]). Die Exporte rufen sie je Bauteil
// mit einem Ein-Bauteil-Projekt auf (die Ableitungen liefern keine ids); damit das gemeinsame
// Dokument der App nicht bei jedem Aufruf umgebaut wird, bekommt jeder Aufruf ein eigenes, kurzlebiges
// Dokument.

import type { Project } from "../model/types";
import type { RMesh, RSlab } from "../plan/toWalls3d/shared";
import { ProjectDocument, type QueryName } from "../core/document";

const DETAIL_CODE: Record<string, number> = { grob: 0, mittel: 1, fein: 2 };

function queryOnce<T>(project: Project, name: QueryName, args: number[] = [], text = ""): T {
  const doc = new ProjectDocument(project);
  try {
    return doc.query<T>(name, args, text);
  } finally {
    doc.close();
  }
}

/** Dach-Meshes (geschlossene Schicht-Körper je Dach). */
export function emitRoofs(project: Project): RMesh[] {
  return queryOnce<RMesh[]>(project, "roofMeshes");
}

/** Stützen als Profil-Extrusionen. */
export function emitColumns(project: Project): RMesh[] {
  return queryOnce<RMesh[]>(project, "columnMeshes");
}

/** Öffnungs-Einbauteile (Rahmen, Glas, Blatt) im Detailgrad `detail`. */
export function emitOpeningMeshes(project: Project, detail: "grob" | "mittel" | "fein" = "fein"): RMesh[] {
  return queryOnce<RMesh[]>(project, "openingMeshes", [DETAIL_CODE[detail] ?? 2]);
}

/** Treppentritte (und Podeste) als extrudierte Platten; `forSection` wie im Schnitt. */
export function emitStairs(project: Project, forSection = false): RSlab[] {
  return queryOnce<RSlab[]>(project, "stairSlabs", [forSection ? 1 : 0]);
}

/** Glatte Ortbeton-Laufplatten. */
export function emitStairMeshes(project: Project): RMesh[] {
  return queryOnce<RMesh[]>(project, "stairMeshes");
}

/** Handläufe und Pfosten. */
export function emitStairRailings(project: Project): RMesh[] {
  return queryOnce<RMesh[]>(project, "stairRailings");
}
