// Extrusions-Domäne der 3D-Ableitung (truck-Integration, `docs/design/
// truck-plan.md`): extrudiert `project.extrudedSolids` asynchron zu Kontext-
// Meshes, über einen modulweiten Cache je Solid-Id (siehe Moduldoc unten).

import type { ExtrudedSolid, Project } from "../../model/types";
import { getFloor } from "../../model/types";
import { buildSolidMesh, extrudeCircle, extrudePolygon } from "../../engine/truckSolid";
import { extrudedSolidSpec, needsBrepPath } from "../extrudedSolidSpec";
import type { RMesh, RRgb } from "./shared";

/** Warmes Orange für truck-Profil-Extrusionen (hebt sie klar von Wand/Decke/Kontext ab). */
const EXTRUSION_RGB: RRgb = [0.85, 0.55, 0.25];

/** Event-Name für den "Extrusion(en) geladen"-Stoss (s. Wasm3DViewport.tsx/nativeSync.ts). */
export const TRUCK_MESH_READY_EVENT = "dossier:truck-mesh-ready";

/**
 * Extrudiert `project.extrudedSolids` (truck-Integration, `docs/design/
 * truck-plan.md`) zu Kontext-Meshes. `extrudePolygon` lädt WASM asynchron;
 * `emitMeshes`/`emitExtrudedSolids` selbst bleiben synchron (Aufrufer wie
 * `updateModel`/`pushNativeWalls` erwarten das) — daher ein modulweiter Cache
 * je Solid-Id, der bei fehlendem/veraltetem Eintrag die Extrusion im
 * Hintergrund anstösst und `TRUCK_MESH_READY_EVENT` feuert, sobald sie fertig
 * ist (Wasm3DViewport/nativeSync hören darauf und re-pushen das Modell — ohne
 * das Signal käme eine fertige Extrusion trotz Erfolgs NIE ins Bild, weil
 * `updateModel` nur bei PROJEKT-Änderungen erneut läuft). Nur im Browser (kein
 * `window` unter vitest/node) und mit stillem Fallback bei Fehlern.
 */
interface TruckCacheEntry {
  /** Signatur (Punkte+Höhe) des Solids beim Laden — invalidiert den Eintrag bei Änderung. */
  signature: string;
  /** null, solange die Extrusion noch lädt. */
  mesh: RMesh | null;
}
const truckMeshCache = new Map<string, TruckCacheEntry>();

function extrudedSolidSignature(solid: ExtrudedSolid): string {
  const brep = solid.brep ? `${JSON.stringify(solid.brep.spec)}@${solid.brep.origin.x},${solid.brep.origin.y}` : "";
  return `${solid.height}|${solid.taper ?? 0}|${solid.cornerRadius ?? 0}|${brep}|${solid.points.map((p) => `${p.x},${p.y}`).join(";")}`;
}

export function emitExtrudedSolids(project: Project): RMesh[] {
  if (typeof window === "undefined") return [];
  const out: RMesh[] = [];
  // Cache-Einträge gelöschter/nicht mehr existierender Körper verwerfen (sonst
  // wächst der Cache unbegrenzt über eine Session, z. B. nach Extrudieren →
  // Kopieren → Löschen in Serie).
  const liveIds = new Set((project.extrudedSolids ?? []).map((s) => s.id));
  for (const id of truckMeshCache.keys()) {
    if (!liveIds.has(id)) truckMeshCache.delete(id);
  }
  for (const solid of project.extrudedSolids ?? []) {
    if (solid.points.length < 3 || solid.height <= 0) continue;
    const signature = extrudedSolidSignature(solid);
    let entry = truckMeshCache.get(solid.id);
    if (!entry || entry.signature !== signature) {
      // Die bisherige Mesh (falls vorhanden) WEITER anzeigen, bis die neue
      // Extrusion fertig geladen ist — sonst verschwindet der Körper kurz,
      // während der Nutzer Höhe/Verjüngung im Attribute-Panel tippt (jeder
      // Tastendruck feuert onChange → neue Signatur).
      const staleMesh = entry?.mesh ?? null;
      entry = { signature, mesh: staleMesh };
      truckMeshCache.set(solid.id, entry);
      let baseZ = 0;
      try {
        baseZ = getFloor(project, solid.levelId).baseElevation ?? 0;
      } catch {
        // Geschoss nicht (mehr) auflösbar: bei UK 0 extrudieren (Fallback).
      }
      // Kreis-Profil: echte runde truck-Extrusion (extrudeCircle) statt der
      // 48-Eck-Tessellierung in `points` — glattes Zylinder-Mesh.
      const taper = solid.taper ?? 0;
      // B-Rep-Pfad (Grundkörper, Eckenradius): die Spezifikation trägt die UK (baseZ) selbst.
      const brepSpec = needsBrepPath(solid) ? extrudedSolidSpec(solid, baseZ) : null;
      const extrusion = brepSpec
        ? buildSolidMesh(brepSpec, 0.005)
        : solid.circle
          ? extrudeCircle(solid.circle.center.x, solid.circle.center.y, solid.circle.r, solid.height, taper)
          : extrudePolygon(solid.points.flatMap((p) => [p.x, p.y]), solid.height, taper);
      extrusion
        .then((mesh) => {
          // Prisma-Pfad: truck extrudiert ab z=0 — auf die Geschoss-UK anheben.
          const positions =
            brepSpec || baseZ === 0
              ? mesh.positions
              : mesh.positions.map((v, i) => (i % 3 === 2 ? v + baseZ : v));
          const cur = truckMeshCache.get(solid.id);
          if (!cur || cur.signature !== signature) return; // inzwischen veraltet
          cur.mesh = { positions, indices: mesh.indices, kind: "extrusion", color: EXTRUSION_RGB };
          window.dispatchEvent(new Event(TRUCK_MESH_READY_EVENT));
        })
        .catch((e) => console.warn("truck-Extrusion fehlgeschlagen:", e));
    }
    if (entry.mesh) out.push(entry.mesh);
  }
  return out;
}
