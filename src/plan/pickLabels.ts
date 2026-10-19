// Kategorie-/Layer-Name eines per Cmd/Strg+Klick auswählbaren Objekts — für die
// Objekt-Liste ("Fläche · 01421"). Bei Kataster-Importen heissen die Kategorien
// wie die DXF-Layer; so erkennt man in der Liste, welches der übereinander-
// liegenden Objekte zu welchem Layer gehört.

import type { Project } from "../model/types";
import { flattenCategories } from "../model/types";
import type { PickKind } from "./PlanView";

type WithCategory = { id: string; categoryCode?: string };

function collection(project: Project, kind: PickKind): readonly WithCategory[] {
  const p = project as unknown as Record<string, readonly WithCategory[] | undefined>;
  switch (kind) {
    case "wall": return p.walls ?? [];
    case "drawing": return p.drawings2d ?? [];
    case "ceiling": return p.ceilings ?? [];
    case "opening": return [...(p.openings ?? []), ...(p.doors ?? [])];
    case "stair": return p.stairs ?? [];
    case "room": return p.rooms ?? [];
    case "roof": return p.roofs ?? [];
    case "column": return p.columns ?? [];
    case "context": return p.context ?? [];
    case "solid": return p.extrudedSolids ?? [];
    case "section": return [];
  }
}

/** Name der Kategorie des Objekts, oder `undefined` (unbekannt/ohne Kategorie). */
export function categoryNameForPick(project: Project, kind: PickKind, id: string): string | undefined {
  const obj = collection(project, kind).find((o) => o.id === id);
  const code = obj?.categoryCode;
  if (!code) return undefined;
  return flattenCategories(project.layers).find((c) => c.code === code)?.name;
}
