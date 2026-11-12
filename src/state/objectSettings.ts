// [195] Taste T (wie Archicad Cmd+T): das Fenster „Objekteinstellungen" öffnen (unter Tauri ein natives Nebenfenster,
// [195b] `native/objectSettingsWindow.ts`; sonst das schwebende Panel `object-settings`; folgt der Auswahl; Bereiche
// Objekt + Darstellung). Der passende Abschnitt des Bereichs Objekt wird aufgeklappt
// und fokussiert; ohne Auswahl die Voreinstellung des aktiven Werkzeugs (Wand/Decke: Typ des neuen Bauteils), sonst
// nichts. Die Zuordnung Auswahl → Abschnitt ist rein (`panels/objectInfo/groups.ts::objectSettingsTarget`).

import { objectSettingsTarget, type InfoGroupId } from "../panels/objectInfo/groups";
import { setSettingsArea } from "../panels/objectSettings/areaState";
import { expandAndFocusInfoGroup } from "../panels/objectInfo/infoGroupState";
import { getState } from "./appStore";
import { selectionInfoFor } from "./useSelectionInfo";

export interface ObjectSettingsDeps {
  /** Aktives Werkzeug (React-State der App). */
  activeTool: string;
  /** Fenster Objekteinstellungen sichtbar machen (öffnen bzw. nach vorne holen); `group` = aufzuklappender Abschnitt. */
  revealObjectSettings: (group: InfoGroupId | null) => void;
}

/** Öffnet die Einstellungen; `false`, wenn es nichts zu öffnen gibt. */
export function openObjectSettings(deps: ObjectSettingsDeps): boolean {
  const { project, selection } = getState();
  const sel = selectionInfoFor(project, selection);
  let target = objectSettingsTarget(sel, deps.activeTool, isGridDrawing(sel?.kind === "drawing2d" ? sel.id : undefined));
  // Baum, Lage-Darstellung und Schnittlinie sind keine `SelectionInfo`, haben aber ihre Felder in der Objekt-Info.
  if (!target && (selection.trees.length > 0 || selection.cameras.length > 0 || selection.site.length > 0 || selection.sectionLines.length > 0)) {
    target = { group: selection.sectionLines.length > 0 ? "sectionLine" : null };
  }
  if (!target) return false;
  setSettingsArea("object");
  if (target.group) expandAndFocusInfoGroup(target.group);
  deps.revealObjectSettings(target.group);
  return true;
}

function isGridDrawing(id: string | undefined): boolean {
  if (!id) return false;
  return getState().project.drawings2d.find((d) => d.id === id)?.geom.shape === "grid";
}
