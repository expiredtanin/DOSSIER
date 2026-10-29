// Projektdatei-Format (`.obp`/`.obpt`/Alt-`.json`): Versionierung, Migration und EIN Parser für alle
// Ladestellen. Gerechnet wird im Rust-Kern (`src-tauri/core/src/project_format.rs`, [K4] S4): der Kern
// liest den Text, migriert und lädt das Ergebnis direkt in ein Kern-Dokument; Speichern schreibt der
// Kern aus dem Dokument (Zeichen für Zeichen wie `JSON.stringify(…, null, 2)`).
//
// Regeln:
//  • Jede gespeicherte Datei trägt `formatVersion` (s. {@link PROJECT_FORMAT_VERSION}).
//  • Ältere Dateien (auch ohne `formatVersion` = Version 0) laufen durch die Migrationskette.
//  • Neuere Dateien werden mit klarer Meldung ABGELEHNT (ein altes Programm würde Felder, die es
//    nicht kennt, beim nächsten Speichern verlieren).
//  • Tolerant lesen: fehlende Listen werden leer ergänzt, unbekannte Felder bleiben erhalten und
//    werden gemeldet (nicht gelöscht).
//  • Was kein Dossier-Projekt ist, ist ein Fehler mit Meldung — nie ein stilles `console.warn`.
//
// Im Store öffnet `openProjectFile` (projectSlice) die Datei im Store-Dokument (mit Verlauf); diese
// Fassade lädt ins gemeinsame Abfrage-Dokument (CLI, MCP, Tests) — die Abfragen auf dem gelesenen
// Projekt laufen danach ohne erneute Übergabe.

import type { Project } from "../model/types";
import { documentFor, sharedDocument } from "../core/document";
import type { LoadFileResult } from "../core/document";

/** Aktuelle Version des Dateiformats (muss `PROJECT_FORMAT_VERSION` im Kern entsprechen — Test). */
export const PROJECT_FORMAT_VERSION = 2;

export type ParseProjectResult = LoadFileResult;

/** Liest eine Projektdatei (Text) tolerant ein, migriert und prüft sie (Kern, gemeinsames Dokument). */
export function parseProjectFile(text: string): ParseProjectResult {
  return sharedDocument().loadFile(text);
}

/** Serialisiert ein Projekt für die Datei (mit aktueller Formatversion vorne). */
export function serializeProject(project: Project): string {
  return documentFor(project).serialize();
}
