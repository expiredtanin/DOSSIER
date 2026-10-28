// IFC4-Export (STEP Physical File / ISO-10303-21) des semantischen Modells.
//
// Gerechnet wird im Rust-Kern (`src-tauri/core/src/export_ifc.rs`, [K4] S2) auf dem Projekt-Dokument:
// Project → Site → Building → Storeys, Wände als öffnungsgenaue Dreiecks-Netze, Decken/Treppen/
// Körper/Stützen/Räume als Profil-Extrusionen, Dächer als Schicht-Netze, Wand-/Deckentypen mit
// Materialschichten; GUIDs deterministisch aus der Element-ID; bei gesetztem `geoAnchor` in LV95-
// Weltkoordinaten. Der Download (Blob + Anchor) passiert im App-Layer.

import type { Project } from "../model/types";
import { core } from "../engine/coreWasm";
import { documentFor } from "../core/document";

/** Deterministische 22-stellige IFC-GUID aus einer beliebigen Element-ID. */
export function ifcGuid(id: string): string {
  return core().ifc_guid(id);
}

/** STEP-String-Literal (ISO 10303-21): druckbares ASCII bleibt, alles andere wird als \X2\…\X0\ kodiert. */
export function ifcString(s: string): string {
  return core().ifc_string(s);
}

/**
 * Baut aus einem Projekt einen vollständigen IFC4-SPF-String (STEP Physical File). Leeres Projekt ⇒
 * valider Minimal-IFC. Wirft, wenn sich das Modell nicht ableiten lässt (z. B. unbekannter Wandtyp).
 */
export function exportIfcSpf(project: Project): string {
  return documentFor(project).exportIfc(Date.now());
}
