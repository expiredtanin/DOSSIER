// Projektdatei-Format (`.obp`/`.obpt`/Alt-`.json`): Versionierung, Migration und EIN
// Parser für alle Ladestellen.
//
// Regeln:
//  • Jede gespeicherte Datei trägt `formatVersion` (s. {@link PROJECT_FORMAT_VERSION}).
//  • Ältere Dateien (auch ohne `formatVersion` = Version 0) laufen durch die Migrationskette.
//  • Neuere Dateien werden mit klarer Meldung ABGELEHNT (ein altes Programm würde Felder, die
//    es nicht kennt, beim nächsten Speichern verlieren).
//  • Tolerant lesen: fehlende Listen werden leer ergänzt, unbekannte Felder bleiben erhalten und
//    werden gemeldet (nicht gelöscht — die Liste bekannter Felder kann hinter dem Typ
//    zurückliegen, Löschen wäre dann Datenverlust).
//  • Was kein Dossier-Projekt ist (kein JSON-Objekt, keine Wände/Ebenen/Geschossliste), ist ein
//    Fehler mit Meldung — nie ein stilles `console.warn`.

import type { Project } from "../model/types";

/** Aktuelle Version des Dateiformats. Bei jeder Formatänderung erhöhen + Migration anhängen. */
export const PROJECT_FORMAT_VERSION = 2;

/**
 * Migrationen: `MIGRATIONS[i]` hebt eine Datei von Version `i` auf `i + 1`. Arbeitet auf dem
 * rohen JSON-Objekt (kopiert, nie das Original verändern).
 */
const MIGRATIONS: Array<(raw: Record<string, unknown>) => Record<string, unknown>> = [
  // 0 → 1: Einführung von `formatVersion`; Inhalt unverändert.
  (raw) => raw,
  // 1 → 2: Legacy-Türen (`doors`) werden zu Öffnungen (`openings`, kind "door"). Es gibt nur noch
  // EINEN Datensatz-Typ für Türen und Fenster.
  (raw) => {
    const doors = Array.isArray(raw.doors) ? (raw.doors as Array<Record<string, unknown>>) : [];
    const { doors: _drop, ...rest } = raw;
    if (doors.length === 0) return rest;
    const openings = Array.isArray(rest.openings) ? [...(rest.openings as Array<Record<string, unknown>>)] : [];
    const taken = new Set(openings.map((o) => String(o.id)));
    const doorTypes = Array.isArray(rest.doorTypes) ? (rest.doorTypes as Array<{ id?: string }>) : [];
    for (const d of doors) {
      let id = String(d.id);
      while (taken.has(id)) id = `${id}-t`;
      taken.add(id);
      openings.push({
        id,
        type: "opening",
        hostWallId: d.hostWallId,
        categoryCode: d.categoryCode,
        kind: "door",
        position: d.position,
        width: d.width,
        height: d.height,
        sillHeight: 0,
        swing: d.swing,
        hinge: d.hinge,
        ...(doorTypes[0]?.id ? { typeId: doorTypes[0].id } : {}),
      });
    }
    return { ...rest, openings };
  },
];

/** Pflichtlisten: fehlen sie, ist es kein Dossier-Projekt. */
const REQUIRED_ARRAYS = ["walls", "layers", "drawingLevels"] as const;
/** Listen, die bei Fehlen leer ergänzt werden. */
const DEFAULT_ARRAYS = ["lineStyles", "hatches", "components", "wallTypes", "drawings2d"] as const;

/** Bekannte Felder von `Project` (für die Meldung unbekannter Felder). */
const KNOWN_KEYS = new Set<string>([
  "formatVersion", "id", "name", "lineStyles", "textStyles", "hatches", "components", "wallTypes",
  "ceilingTypes", "roofTypes", "blockDefs", "doorTypes", "windowTypes", "stairTypes", "pens",
  "penSets", "activePenSetId", "customPalettes", "builtinPaletteBanks", "drawingLevels", "layers",
  "walls", "ceilings", "roofs", "openings", "stairs", "rooms", "drawings2d", "context",
  "extrudedSolids", "columns", "groups", "parametricWalls", "overrideRules", "viewSnapshots",
  "viewSnapshotFolders", "layouts", "masterLayouts", "layoutFolders", "referenceElevationMasl",
  "geoAnchor", "roomProgram", "parcelArea", "sunStudy",
]);

export type ParseProjectResult =
  | { ok: true; project: Project; warnings: string[]; migratedFrom: number | null }
  | { ok: false; error: string };

/** Liest eine Projektdatei (Text) tolerant ein, migriert und prüft sie. */
export function parseProjectFile(text: string): ParseProjectResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `Die Datei ist kein gültiges JSON (${e instanceof Error ? e.message : String(e)}).` };
  }
  return parseProjectObject(raw);
}

/** Wie {@link parseProjectFile}, für ein bereits geparstes Objekt. */
export function parseProjectObject(raw: unknown): ParseProjectResult {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "Die Datei enthält kein Dossier-Projekt." };
  }
  let obj = { ...(raw as Record<string, unknown>) };
  const warnings: string[] = [];

  const v = obj.formatVersion;
  let version = 0;
  if (v !== undefined) {
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
      return { ok: false, error: `Ungültige Formatversion „${String(v)}".` };
    }
    version = v;
  }
  if (version > PROJECT_FORMAT_VERSION) {
    return {
      ok: false,
      error:
        `Die Datei wurde mit einer neueren Dossier-Version gespeichert (Format ${version}, ` +
        `dieses Programm kennt bis ${PROJECT_FORMAT_VERSION}). Bitte Dossier aktualisieren.`,
    };
  }

  for (const key of REQUIRED_ARRAYS) {
    if (!Array.isArray(obj[key])) {
      return { ok: false, error: `Die Datei enthält kein Dossier-Projekt (Liste „${key}" fehlt).` };
    }
  }

  const migratedFrom = version < PROJECT_FORMAT_VERSION ? version : null;
  for (let i = version; i < PROJECT_FORMAT_VERSION; i++) obj = MIGRATIONS[i]({ ...obj });
  obj.formatVersion = PROJECT_FORMAT_VERSION;

  for (const key of DEFAULT_ARRAYS) {
    if (obj[key] === undefined) obj[key] = [];
    else if (!Array.isArray(obj[key])) {
      warnings.push(`Feld „${key}" ist keine Liste und wurde geleert.`);
      obj[key] = [];
    }
  }
  if (typeof obj.id !== "string" || !obj.id) obj.id = `project-${Date.now().toString(36)}`;
  if (typeof obj.name !== "string") obj.name = "";

  const unknown = Object.keys(obj).filter((k) => !KNOWN_KEYS.has(k));
  if (unknown.length) warnings.push(`Unbekannte Felder behalten: ${unknown.join(", ")}.`);

  return { ok: true, project: obj as unknown as Project, warnings, migratedFrom };
}

/** Serialisiert ein Projekt für die Datei (mit aktueller Formatversion vorne). */
export function serializeProject(project: Project): string {
  const { formatVersion: _old, ...rest } = project as Project & { formatVersion?: number };
  return JSON.stringify({ formatVersion: PROJECT_FORMAT_VERSION, ...rest }, null, 2);
}
