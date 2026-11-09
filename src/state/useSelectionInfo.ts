// Objekt-Info der Auswahl als feines Store-Abo ([121]). Panels (Objekt-Info, Attribute, Baurecht)
// lesen die abgeleitete `SelectionInfo` hier statt über den Panel-Host: so rendern sie nur, wenn
// sich die Info selbst ändert, nicht bei jeder Op am Projekt.
//
// `selectionInfoFor` merkt sich das letzte Paar (Projekt, Auswahl) und rechnet nur bei neuem Paar
// (eine Kern-Abfrage). Ist das Ergebnis inhaltlich gleich wie das vorige (Strukturvergleich),
// bleibt das alte Objekt — Leser mit Referenzvergleich rendern dann nicht. `App.tsx`
// (`useSectionLineState`) nutzt denselben Cache, die Info wird je Änderung nur einmal gerechnet.

import type { Project } from "../model/types";
import { useStore } from "./appStore";
import { dataEqual } from "./dataEqual";
import type { Selection } from "./selection";
import { deriveSelection, type SelectionInfo } from "./selectionInfo";

let last: { project: Project; selection: Partial<Selection>; info: SelectionInfo | null } | null = null;

/** Objekt-Info für (Projekt, Auswahl), zwischengespeichert und inhaltlich stabil (s. Kopf). */
export function selectionInfoFor(project: Project, selection: Partial<Selection>): SelectionInfo | null {
  if (last && last.project === project && last.selection === selection) return last.info;
  const info = deriveSelection(project, selection);
  const kept = last && dataEqual(last.info, info) ? last.info : info;
  last = { project, selection, info: kept };
  return kept;
}

/** Objekt-Info der aktuellen Auswahl; rendert nur neu, wenn sie sich inhaltlich ändert. */
export function useSelectionInfo(): SelectionInfo | null {
  return useStore((s) => selectionInfoFor(s.project, s.selection));
}
