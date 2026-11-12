// [195b] Gemeinsame Werte bei Mehrfachauswahl gleicher Art für die Abschnitte der Objekt-Info: `null` bei einem
// einzelnen Element, sonst das Ergebnis der Abfrage aus `state/mixedValues.ts` (je Wert gleich oder „gemischt").

import { useMemo } from "react";
import type { Project } from "../../model/types";
import { useStore } from "../../state/appStore";
import type { Selection } from "../../state/selection";

export function useMulti<T>(kind: "walls" | "ceilings" | "roofs" | "openings", compute: (p: Project, sel: Selection) => T): T | null {
  const project = useStore((s) => s.project);
  const selection = useStore((s) => s.selection);
  // `compute` ist je Aufrufstelle eine Modul-Funktion (stabil).
  return useMemo(() => (selection[kind].length > 1 ? compute(project, selection) : null), [project, selection, kind, compute]);
}
