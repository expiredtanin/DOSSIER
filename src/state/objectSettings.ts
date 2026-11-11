// [189] Taste T (wie Archicad Cmd+T): Einstellungen des gewählten Objekts öffnen. Fenster/Tür → der Öffnungs-
// Dialog; alles andere → die Objekt-Info (Panel zeigen, passenden Abschnitt aufklappen und fokussieren);
// ohne Auswahl die Voreinstellung des aktiven Werkzeugs (Wand/Decke: Typ des neuen Bauteils), sonst nichts.
// Die Zuordnung Auswahl → Ziel ist rein (`panels/objectInfo/groups.ts::objectSettingsTarget`).

import { objectSettingsTarget } from "../panels/objectInfo/groups";
import { expandAndFocusInfoGroup } from "../panels/objectInfo/infoGroupState";
import { getState } from "./appStore";
import { selectionInfoFor } from "./useSelectionInfo";

export interface ObjectSettingsDeps {
  /** Aktives Werkzeug (React-State der App). */
  activeTool: string;
  openOpeningEditor: (openingId: string) => void;
  /** Objekt-Info-Panel sichtbar machen (Dock-Tab, schwebendes Fenster …). */
  revealObjectInfo: () => void;
}

/** Öffnet die Einstellungen; `false`, wenn es nichts zu öffnen gibt. */
export function openObjectSettings(deps: ObjectSettingsDeps): boolean {
  const { project, selection } = getState();
  const sel = selectionInfoFor(project, selection);
  let target = objectSettingsTarget(sel, deps.activeTool, isGridDrawing(sel?.kind === "drawing2d" ? sel.id : undefined));
  // Baum, Lage-Darstellung und Schnittlinie sind keine `SelectionInfo`, haben aber ihre Felder in der Objekt-Info.
  if (!target && (selection.trees.length > 0 || selection.site.length > 0 || selection.sectionLines.length > 0)) {
    target = { kind: "info", group: selection.sectionLines.length > 0 ? "sectionLine" : null };
  }
  if (!target) return false;
  if (target.kind === "opening") {
    deps.openOpeningEditor(target.id);
    return true;
  }
  if (target.group) expandAndFocusInfoGroup(target.group);
  deps.revealObjectInfo();
  return true;
}

function isGridDrawing(id: string | undefined): boolean {
  if (!id) return false;
  return getState().project.drawings2d.find((d) => d.id === id)?.geom.shape === "grid";
}
