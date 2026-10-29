// OBJ-/STL-/glTF-Export des 3D-Gebäudemodells als Dreiecks-Mesh. Seit [K4]/[C11] (29.10.) rechnet alles
// in Rust: der Kern sammelt aus dem Projekt-Dokument die Szene (`src-tauri/core/src/mesh_data.rs`,
// Abfrage `meshExportData`: ein Knoten je Bauteil, Teil-Netze je Material, Materialtabelle,
// Geschosse; Wicklung nach aussen), das Format-Modul schreibt daraus die Datei
// (`src-tauri/fileio/src/mesh_export.rs`). TS gibt nur die Optionen weiter und reicht die Bytes vom
// Kern an `fileio`. Verlangt das geladene Format-Modul (`await loadFileio()`). Kein Datei-IO hier.
//
// Achsen: Datei rechtshändig, Y-up — Modell (x, y, z-hoch) → (x, z, −y), Norden = −Z, Meter.
// Dreiecks-Quelle, Prisma-Näherung der Extrusionen und Grenzen: Kopf von `mesh_data.rs`, `TODO.md` [C11].

import type { Project } from "../model/types";
import { fileio } from "../engine/fileioWasm";
import { documentFor } from "../core/document";
import { decodeExportFlat } from "./exportIfc";

/** Was in die Szene kommt. Alles standardmässig an (vollständiges 3D-Modell). */
export interface MeshOptions {
  /** Verglasung und Rahmenteile je Öffnung als eigener Knoten (Standard: ja). */
  openingParts?: boolean;
  /** Gelände und importierte Kontext-Meshes (IFC/DXF) mitnehmen (Standard: ja). */
  context?: boolean;
}

/** Ruft eine Rust-Bindung; leeres Ergebnis (kaputter Puffer) wird zum Fehler mit dem Grund. */
function write<T extends string | Uint8Array>(project: Project, opts: MeshOptions, byLevel: boolean, run: (m: ReturnType<typeof fileio>, buf: Float64Array, strings: string) => T): T {
  const args = [(opts.openingParts ?? true) ? 1 : 0, (opts.context ?? true) ? 1 : 0, byLevel ? 1 : 0];
  const [buf, strings] = decodeExportFlat(documentFor(project).queryBin("meshExportData", args));
  const m = fileio();
  const out = run(m, buf, strings);
  if (out.length === 0) {
    const why = m.export_mesh_check_flat(buf, strings);
    throw new Error(`Mesh-Export fehlgeschlagen${why ? `: ${why}` : ""}`);
  }
  return out;
}

/**
 * Baut einen vollständigen Wavefront-OBJ-String des 3D-Gebäudemodells (Meter, Y-up rechtshändig:
 * Modell (x, y, z-hoch) → (x, z, −y)). Ein `o`-Objekt je Bauteil-Vorkommen (Wand, Decke, Extrusion, Dach,
 * Treppe, Stütze, Fenster/Tür, Kontext-Mesh). Leeres Projekt ⇒ gültige Datei nur mit Kopf-Kommentaren.
 * Verlangt das geladene Format-Modul (`await loadFileio()`).
 */
export function exportObj(project: Project, opts: MeshOptions = {}): string {
  return write(project, opts, false, (m, b, s) => m.export_mesh_obj_flat(b, s));
}

/**
 * Baut einen vollständigen ASCII-STL-String (Meter, dieselben Achsen wie {@link exportObj}); je Dreieck
 * eine Facettennormale. Leeres Projekt ⇒ gültiges leeres `solid`-Gerüst. Verlangt das geladene
 * Format-Modul (`await loadFileio()`).
 */
export function exportStl(project: Project, opts: MeshOptions = {}): string {
  return write(project, opts, false, (m, b, s) => m.export_mesh_stl_flat(b, s));
}

/** Optionen des glTF-Exports. */
export interface GltfOptions extends MeshOptions {
  /** Geschoss als Eltern-Knoten der Bauteile (Standard: ja). */
  byLevel?: boolean;
}

/**
 * glTF 2.0 binär (GLB) für Blender, Twinmotion, Enscape, Web-Viewer. Ein Knoten je Bauteil (Name
 * `Wand_<id>`, `Decke_<id>`, `Dach_<id>`, `Treppe_<id>`, `Stuetze_<id>`, `Fenster_<id>`, `Tuer_<id>`,
 * `Extrusion_<id>`, `Kontext_<id>`, `Gelaende_<id>`; `extras` = Typ + id), PBR-Materialien mit der
 * Farbe der Bauteilschicht, Verglasung transparent (`BLEND`), Geschosse als Eltern-Knoten. Meter;
 * rechtshändig, Y-up: Modell (x, y, z-hoch) → (x, z, −y), Norden = −Z. Verlangt das geladene
 * Format-Modul (`await loadFileio()`).
 */
export function exportGlb(project: Project, opts: GltfOptions = {}): Uint8Array {
  return write(project, opts, opts.byLevel ?? true, (m, b, s) => m.export_mesh_glb_flat(b, s));
}

/** Wie {@link exportGlb}, aber als `.gltf` (JSON, Puffer als Base64-Data-URI eingebettet). */
export function exportGltf(project: Project, opts: GltfOptions = {}): string {
  return write(project, opts, opts.byLevel ?? true, (m, b, s) => m.export_mesh_gltf_flat(b, s));
}
