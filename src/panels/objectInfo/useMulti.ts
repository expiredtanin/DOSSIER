// [195b] Gemeinsame Werte bei Mehrfachauswahl gleicher Art für die Abschnitte der Objekt-Info: `null` bei einem
// einzelnen Element, sonst das Ergebnis der Abfrage aus `state/mixedValues.ts` (je Wert gleich oder „gemischt").

import { useMemo } from "react";
import type { Project } from "../../model/types";
import { useStore } from "../../state/appStore";
import type { Selection } from "../../state/selection";

export function useMulti<T>(kind: "walls" | "ceilings" | "roofs" | "openings" | "stairs" | "rooms" | "columns" | "solids", compute: (p: Project, sel: Selection) => T): T | null {
  const multi = useStore((s) => s.selection[kind].length > 1);
  const selection = useStore((s) => s.selection);
  // Projekt nur bei Mehrfachauswahl abonnieren: bei einem Element kein Neurendern je Projektänderung ([121]).
  const project = useStore((s) => (multi ? s.project : null));
  // `compute` ist je Aufrufstelle eine Modul-Funktion (stabil).
  return useMemo(() => (multi && project ? compute(project, selection) : null), [multi, project, selection, compute]);
}
