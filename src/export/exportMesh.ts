// OBJ-/STL-Export des 3D-Gebäudemodells als reines Dreiecks-Mesh. Gerechnet wird im Rust-Kern
// (`src-tauri/core/src/export_mesh.rs`, [K4] S2) auf dem Projekt-Dokument:
//   • Wände: dieselben Schicht-Bänder wie der 3D-Viewer (Gehrungen, Decken-Dominanz); Bänder mit
//     Öffnungs-Löchern öffnungsgenau ausgeschnitten (inkl. Laibungen), lochlose als Box.
//   • Decken und extrudierte Profile (truck): Umriss-Prisma mit Ear-Clipping-Kappen, Seitenmantel,
//     `taper` linear zum Schwerpunkt. (Bewusst nicht die asynchronen truck-Dreiecke: der Export
//     bleibt synchron.)
// Achsen: Modell (x, y) → Welt (x, Höhe, y), Y-up, rechtshändig, Meter — wie der 3D-Viewer.

import type { Project } from "../model/types";
import { documentFor } from "../core/document";

/**
 * Vollständiger Wavefront-OBJ-String (Meter, rechtshändig, Y-up). Ein `o`-Objekt je Bauteil-
 * Vorkommen. Leeres Projekt ⇒ gültige Datei nur mit Kopf-Kommentaren.
 */
export function exportObj(project: Project): string {
  return documentFor(project).queryJson("objFile");
}

/**
 * Vollständiger ASCII-STL-String (Meter, dieselbe Achsen-Konvention). Jedes Dreieck trägt eine aus
 * dem Kreuzprodukt berechnete Facettennormale. Leeres Projekt ⇒ gültiges leeres `solid`-Gerüst.
 */
export function exportStl(project: Project): string {
  return documentFor(project).queryJson("stlFile");
}
