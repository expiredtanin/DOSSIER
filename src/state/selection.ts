// Auswahl als EIN Wert ([130]): je Element-Art eine Menge von IDs. Ersetzt die
// früheren zwölf `selected…Ids`-Felder im Store; alle Leser/Schreiber gehen über
// diesen Typ und die Helfer hier (Abbildung auf Befehls-/Transformations-Auswahl,
// Gruppen-Mitgliedschaft, BCF).
//
// Referenz-Stabilität ([121]): `mergeSelection` behält unveränderte Arrays (gleicher
// Inhalt → alte Referenz) und liefert bei gar keiner Änderung das alte Objekt — so
// rendern Komponenten, die `useStore(s => s.selection.walls)` lesen, nur bei echter
// Änderung ihrer Art neu.
//
// Bezeichner englisch, Kommentare deutsch.

import type { CommandSelection } from "../commands/types";
import type { TransformSelection } from "../tools/transform";
import type { GroupMembership } from "../core";

/** Gewählte Elemente, je Art eine Menge (Reihenfolge = Wahl-Reihenfolge). */
export interface Selection {
  walls: string[];
  /** 2D-Zeichenelemente. */
  drawings: string[];
  ceilings: string[];
  /** Fenster/Türen. */
  openings: string[];
  stairs: string[];
  rooms: string[];
  /** Extrudierte Körper (truck). */
  solids: string[];
  columns: string[];
  roofs: string[];
  /** Kontext-Objekte (importierte Gebäude/Terrain). */
  contextObjects: string[];
  /** Schnitt-/Ansichtslinien (DrawingLevel-Ids). */
  sectionLines: string[];
  /**
   * [137] Abgeleitete Lage-Darstellung (kein Modellelement): `"sunStudy"` (Schattenfläche angeklickt)
   * bzw. `"siteRules"` (Baurechtslinie) — die Objekt-Info zeigt die Einstellungen der Quelle.
   */
  site: string[];
  /** [149] Bäume (`Project.trees`). */
  trees: string[];
  /**
   * Gewählte Gruppen — rein informativ (Bounding-Box, Doppelklick-Ziel); die
   * Mitglieder stehen zusätzlich in den übrigen Arten (s. `groupActions.ts`).
   */
  groups: string[];
}

export type SelectionKind = keyof Selection;

/** Alle Arten; Reihenfolge = Vorrang für `primaryKind` (2D vor Wand, wie die Objekt-Info). */
export const SELECTION_KINDS: readonly SelectionKind[] = [
  "drawings",
  "walls",
  "ceilings",
  "openings",
  "stairs",
  "rooms",
  "solids",
  "columns",
  "roofs",
  "contextObjects",
  "sectionLines",
  "site",
  "trees",
  "groups",
];

/** Alle Element-Arten ohne die Gruppen (die nur Begleit-Information sind). */
export const ELEMENT_KINDS: readonly SelectionKind[] = SELECTION_KINDS.filter((k) => k !== "groups");

const NONE: string[] = Object.freeze([]) as unknown as string[];

/** Die leere Auswahl (geteilt, eingefroren — nie verändern). */
export const EMPTY_SELECTION: Selection = Object.freeze(
  Object.fromEntries(SELECTION_KINDS.map((k) => [k, NONE])) as unknown as Selection,
);

export function emptySelection(): Selection {
  return EMPTY_SELECTION;
}

/** Nichts gewählt? `withGroups: false` ignoriert die (informativen) Gruppen. */
export function isEmpty(sel: Selection, opts: { withGroups?: boolean } = {}): boolean {
  const kinds = opts.withGroups === false ? ELEMENT_KINDS : SELECTION_KINDS;
  return kinds.every((k) => sel[k].length === 0);
}

/** Das eine gewählte Element einer Art (nur bei genau einem), sonst null. */
export function single(sel: Selection, kind: SelectionKind): string | null {
  const ids = sel[kind];
  return ids.length === 1 ? ids[0] : null;
}

/** Auswahl, die nur `ids` der Art `kind` enthält. */
export function fromIds(kind: SelectionKind, ids: readonly string[]): Selection {
  return mergeSelection(EMPTY_SELECTION, { [kind]: [...ids] });
}

/** Erste nicht-leere Art nach Vorrang (`SELECTION_KINDS`), null bei leerer Auswahl. */
export function primaryKind(sel: Selection): SelectionKind | null {
  return SELECTION_KINDS.find((k) => sel[k].length > 0) ?? null;
}

/** Patch, der die genannten Arten leert — ohne Angabe alle Element-Arten (Gruppen bleiben). */
export function clearKinds(...kinds: SelectionKind[]): Partial<Selection> {
  const out: Partial<Selection> = {};
  for (const k of kinds.length ? kinds : ELEMENT_KINDS) out[k] = NONE;
  return out;
}

const sameIds = (a: readonly string[], b: readonly string[]) =>
  a === b || (a.length === b.length && a.every((x, i) => x === b[i]));

/**
 * Führt einen Teil-Patch in die Auswahl ein. Arten mit gleichem Inhalt behalten
 * ihre alte Referenz, leere Arten die geteilte leere; ohne Änderung kommt `prev`
 * selbst zurück.
 */
export function mergeSelection(prev: Selection, patch: Partial<Selection>): Selection {
  let next: Selection | null = null;
  for (const k of SELECTION_KINDS) {
    const ids = patch[k];
    if (ids === undefined || sameIds(prev[k], ids)) continue;
    next ??= { ...prev };
    next[k] = ids.length === 0 ? NONE : ids;
  }
  return next ?? prev;
}

/** Auswahl → Befehlskontext (Einzel-Körper/-Stütze nur bei genau einem Element, wie bisher). */
export function toCommandSelection(sel: Selection): CommandSelection {
  return {
    wallIds: sel.walls,
    drawingId: single(sel, "drawings"),
    drawingIds: sel.drawings,
    extrudedSolidId: single(sel, "solids"),
    columnId: single(sel, "columns"),
    ceilingIds: sel.ceilings,
    roofIds: sel.roofs,
    stairIds: sel.stairs,
    roomIds: sel.rooms,
    openingIds: sel.openings,
    treeIds: sel.trees,
    contextIds: sel.contextObjects,
  };
}

/** Auswahl → Transformations-Auswahl (gleiche Form wie der Befehlskontext). */
export function toTransformSelection(sel: Selection): TransformSelection {
  return toCommandSelection(sel);
}

/** Hat die Auswahl etwas Transformierbares (wie `hasTransformSelection` auf dem Befehlskontext)? */
export function hasTransformable(sel: Selection): boolean {
  return (
    sel.walls.length > 0 ||
    sel.drawings.length > 0 ||
    single(sel, "solids") !== null ||
    single(sel, "columns") !== null ||
    sel.ceilings.length > 0 ||
    sel.roofs.length > 0 ||
    sel.stairs.length > 0 ||
    sel.rooms.length > 0 ||
    sel.openings.length > 0 ||
    sel.trees.length > 0 ||
    sel.contextObjects.length > 0
  );
}

/** Auswahl in der `…Ids`-Form (Gruppen-Mitgliedschaft, BCF, Sperr-Filter, Wahl-Speicher). */
export interface SelectionIdLists {
  wallIds: string[];
  drawingIds: string[];
  ceilingIds: string[];
  openingIds: string[];
  stairIds: string[];
  roomIds: string[];
  extrudedSolidIds: string[];
  columnIds: string[];
  roofIds: string[];
  contextObjectIds: string[];
  sectionLineIds: string[];
  groupIds: string[];
  /** [149] Bäume (nicht gruppierbar; Zwischenablage, Nachauswahl). */
  treeIds?: string[];
}

const ID_LIST_KEYS: [SelectionKind, keyof SelectionIdLists][] = [
  ["walls", "wallIds"],
  ["drawings", "drawingIds"],
  ["ceilings", "ceilingIds"],
  ["openings", "openingIds"],
  ["stairs", "stairIds"],
  ["rooms", "roomIds"],
  ["solids", "extrudedSolidIds"],
  ["columns", "columnIds"],
  ["roofs", "roofIds"],
  ["contextObjects", "contextObjectIds"],
  ["sectionLines", "sectionLineIds"],
  ["groups", "groupIds"],
  ["trees", "treeIds"],
];

/** Auswahl → `…Ids`-Listen (passt strukturell auf `GroupMembership` und `BcfSelection`). */
export function toIdLists(sel: Selection): SelectionIdLists {
  const out = {} as SelectionIdLists;
  for (const [k, key] of ID_LIST_KEYS) out[key] = sel[k];
  return out;
}

/** `…Ids`-Listen (auch nur teilweise, z. B. `GroupMembership`) → Auswahl-Patch der vorhandenen Arten. */
export function fromIdLists(lists: Partial<SelectionIdLists>): Partial<Selection> {
  const out: Partial<Selection> = {};
  for (const [k, key] of ID_LIST_KEYS) {
    const ids = lists[key];
    if (ids) out[k] = ids;
  }
  return out;
}

/** Auswahl → Gruppen-Mitgliedschaft (die acht gruppierbaren Arten). */
export function toMembership(sel: Selection): GroupMembership {
  return {
    wallIds: sel.walls,
    drawingIds: sel.drawings,
    ceilingIds: sel.ceilings,
    roomIds: sel.rooms,
    stairIds: sel.stairs,
    columnIds: sel.columns,
    roofIds: sel.roofs,
    openingIds: sel.openings,
    treeIds: sel.trees,
  };
}
