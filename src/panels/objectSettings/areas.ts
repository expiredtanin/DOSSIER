// [195] Bereiche des Objekteinstellungs-Fensters (Taste T): „Objekt" = Typ/Aufbau/Masse/Höhen/Parameter (die
// Objekt-Info samt ihren Abschnitten, `objectInfo/groups.ts`), „Darstellung" = Stift, Füllung, Schraffur,
// Linienstil, Linienenden (das Attribute-Panel, `attrGroups`). Rein, ohne React; das Fenster
// (`ObjectSettingsPanel`) zeigt nur die Bereiche, die es für die Auswahl gibt.

import type { SelectionInfo } from "../../state/selectionInfo";
import { attrGroups, infoGroups } from "../objectInfo/groups";

export type SettingsArea = "object" | "appearance";

export interface SettingsAreaContext {
  sel: SelectionInfo | null;
  /** Baum, Lage-Darstellung (Schatten/Baurecht) oder Schnittlinie gewählt: keine `SelectionInfo`, aber Objekt-Felder. */
  otherSelected: boolean;
  isGrid?: boolean;
  sectionLine?: boolean;
  /** Wand-/Decken-Werkzeug aktiv: Typ des neuen Bauteils. */
  newComponentTool?: boolean;
}

/** Bereiche in Anzeige-Reihenfolge; leer = „Keine Auswahl". */
export function settingsAreas(c: SettingsAreaContext): SettingsArea[] {
  const out: SettingsArea[] = [];
  const groups = infoGroups({ sel: c.sel, isGrid: !!c.isGrid, sectionLine: !!c.sectionLine, newComponentTool: !!c.newComponentTool });
  // Jedes gewählte Element hat Objekt-Felder (Kopf mit Art, Ebene, Mass); die Abschnitte kommen dazu.
  if (c.sel || c.otherSelected || groups.length > 0) out.push("object");
  if (attrGroups({ sel: c.sel, openEnds: false, isDimension: false }).length > 0) out.push("appearance");
  return out;
}
