// Projektdatei-Format (`.obp`/`.obpt`/Alt-`.json`): Versionierung, Migration und EIN Parser für alle
// Ladestellen. Gerechnet wird im Rust-Kern (`src-tauri/core/src/project_format.rs`, [K4]).
//
// Regeln:
//  • Jede gespeicherte Datei trägt `formatVersion` (s. {@link PROJECT_FORMAT_VERSION}).
//  • Ältere Dateien (auch ohne `formatVersion` = Version 0) laufen durch die Migrationskette.
//  • Neuere Dateien werden mit klarer Meldung ABGELEHNT (ein altes Programm würde Felder, die es
//    nicht kennt, beim nächsten Speichern verlieren).
//  • Tolerant lesen: fehlende Listen werden leer ergänzt, unbekannte Felder bleiben erhalten und
//    werden gemeldet (nicht gelöscht).
//  • Was kein Dossier-Projekt ist, ist ein Fehler mit Meldung — nie ein stilles `console.warn`.

import type { Project } from "../model/types";
import { core } from "../engine/coreWasm";
import { documentFor } from "../core/document";

/** Aktuelle Version des Dateiformats (muss `PROJECT_FORMAT_VERSION` im Kern entsprechen — Test). */
export const PROJECT_FORMAT_VERSION = 2;

export type ParseProjectResult =
  | { ok: true; project: Project; warnings: string[]; migratedFrom: number | null }
  | { ok: false; error: string };

/** Liest eine Projektdatei (Text) tolerant ein, migriert und prüft sie. */
export function parseProjectFile(text: string): ParseProjectResult {
  return JSON.parse(core().project_parse(text, Date.now())) as ParseProjectResult;
}

/** Wie {@link parseProjectFile}, für ein bereits geparstes Objekt. */
export function parseProjectObject(raw: unknown): ParseProjectResult {
  return parseProjectFile(JSON.stringify(raw ?? null));
}

/** Serialisiert ein Projekt für die Datei (mit aktueller Formatversion vorne). */
export function serializeProject(project: Project): string {
  return documentFor(project).serialize();
}
