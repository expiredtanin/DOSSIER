// [189] Zuordnung der Panels: welche Abschnitte zeigt „Attribute" (nur Gestaltung: Stift, Linienenden,
// Bemassungs-Darstellung, Füllung) und welche die Objekt-Info (alles Bauteil-/BIM-bezogene: Typ, Aufbau, Masse,
// Raumdaten, Dach-/Treppen-Parameter, Verweise, Achsraster …). Rein, ohne React — der Test
// `groups.test.ts` hält die Aufteilung fest, `ObjectInfoPanel` und `AttributesPanel` richten sich danach.

import type { TranslationKey } from "../../i18n";
import type { SelectionInfo } from "../../state/selectionInfo";

/** Einklappbare Abschnitte der Objekt-Info (Reihenfolge = Anzeige). */
export type InfoGroupId =
  | "newComponent"
  | "sectionLine"
  | "wall"
  | "ceiling"
  | "roof"
  | "surfacePattern"
  | "opening"
  | "openingEditor"
  | "stair"
  | "room"
  | "roomStamp"
  | "extrudedSolid"
  | "column"
  | "detailRef"
  | "dimRefs"
  | "dimText"
  | "grid";

export const INFO_GROUP_TITLE: Record<InfoGroupId, TranslationKey> = {
  newComponent: "attr.newComponent",
  sectionLine: "objinfo.sectionLine.section",
  wall: "objinfo.wall.section",
  ceiling: "objinfo.ceiling.section",
  roof: "objinfo.roof.section",
  surfacePattern: "objinfo.surfacePattern",
  opening: "objinfo.opening.section",
  openingEditor: "objinfo.openingEditor.section",
  stair: "objinfo.stair.section",
  room: "objinfo.room.section",
  roomStamp: "roomStamp.title",
  extrudedSolid: "objinfo.extrudedSolid.section",
  column: "objinfo.column.section",
  detailRef: "objinfo.detailRef.section",
  dimRefs: "objinfo.dimRefs.section",
  dimText: "objinfo.dimText.section",
  grid: "attr.grid.section",
};

export interface InfoGroupContext {
  sel: SelectionInfo | null;
  /** Gewählte 2D-Form ist ein Achsraster. */
  isGrid: boolean;
  /** Eine Schnitt-/Ansichtslinie ist gewählt (kein Projekt-Bauteil, daher nicht in `sel`). */
  sectionLine: boolean;
  /** Wand- oder Decken-Werkzeug aktiv: Typ für das NEUE Bauteil wählen. */
  newComponentTool: boolean;
}

/** Abschnitte der Objekt-Info für die aktuelle Auswahl, in Anzeige-Reihenfolge. */
export function infoGroups(c: InfoGroupContext): InfoGroupId[] {
  const out: InfoGroupId[] = [];
  const { sel } = c;
  if (c.newComponentTool) out.push("newComponent");
  if (!sel) {
    if (c.sectionLine) out.push("sectionLine");
    return out;
  }
  if (sel.wall) out.push("wall");
  if (sel.ceiling) out.push("ceiling");
  if (sel.roof) out.push("roof");
  if (sel.wall || sel.roof) out.push("surfacePattern");
  if (sel.opening) out.push("opening", "openingEditor");
  if (sel.stair) out.push("stair");
  if (sel.room) out.push("room", "roomStamp");
  if (sel.extrudedSolid) out.push("extrudedSolid");
  if (sel.column) out.push("column");
  if (sel.detailRef) out.push("detailRef");
  if (sel.dimRefs) out.push("dimRefs");
  if (sel.dimTextMoved) out.push("dimText");
  if (c.isGrid) out.push("grid");
  return out;
}

/** Abschnitte des Attribute-Panels: nur Gestaltung. */
export type AttrGroupId = "stroke" | "ends" | "dimension" | "fill";

export interface AttrGroupContext {
  sel: SelectionInfo | null;
  /** Offene 2D-Form (oder Text mit Hinweislinie): trägt Linienenden. */
  openEnds: boolean;
  /** Gewählte 2D-Form ist eine Masskette. */
  isDimension: boolean;
}

export function attrGroups(c: AttrGroupContext): AttrGroupId[] {
  if (!c.sel) return [];
  const out: AttrGroupId[] = ["stroke"];
  if (c.openEnds) out.push("ends");
  if (c.isDimension) out.push("dimension");
  out.push("fill");
  return out;
}

/**
 * Ziel der Taste T ([195], wie Archicad Cmd+T): immer das Fenster Objekteinstellungen; `group` ist der Abschnitt
 * des Bereichs Objekt, der aufgeklappt und fokussiert wird (`null` = nur das Fenster). Ohne Auswahl die
 * Voreinstellung des aktiven Werkzeugs (Wand/Decke: Typ des neuen Bauteils), sonst nichts.
 */
export type ObjectSettingsTarget = { group: InfoGroupId | null } | null;

export function objectSettingsTarget(sel: SelectionInfo | null, activeTool: string, isGrid = false): ObjectSettingsTarget {
  if (!sel) return activeTool === "wall" || activeTool === "ceiling" ? { group: "newComponent" } : null;
  const first = infoGroups({ sel, isGrid, sectionLine: false, newComponentTool: false })[0];
  return { group: first ?? null };
}
