// Export-Scope „nur Auswahl" (Nutzer-Wunsch aus der 2D-Lücken-Recherche:
// „Export exportiert immer den GANZEN Plan" — weder DXF- noch PDF-Dialog
// bieten einen Scope). Projekt-Transform ([K4] S3: Rechnung im Kern): baut ein Project,
// das NUR die ausgewählten Elemente der acht `MemberKind`-Arten enthält
// (dieselbe Abdeckung wie `objectLock.ts`/`groupActions.ts`), sonst
// unverändert (Bibliotheken/Ebenen/Geschosse bleiben stehen, damit ID-
// Referenzen — Wandtyp, Linienstil, Layer — weiter auflösen). Wird VOR
// `generatePlan()` angewendet, analog `projectToWorldCoords()` beim
// DXF-Export — `generatePlan.ts` selbst bleibt unangetastet.
//
// `project.doors` (Legacy-Feld, s. PENDENZEN.md — echte Türen sind
// `Opening kind=door`) braucht KEINEN eigenen Filter: `generatePlan.ts`
// filtert Türen ohnehin über `hostWallId` gegen die (hier bereits
// gefilterten) Wände, nicht ausgewählte Wände nehmen also automatisch
// keine Türen mehr mit.
//
// Keine React-/Store-Abhängigkeit, wie `objectLock.ts`.
// Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

import type { Project } from "../model/types";
import { documentFor } from "../core/document";
import type { GroupMembership } from "./groupActions";

/**
 * Baut ein Project, das nur die in `members` aufgeführten Elemente der acht
 * Arten enthält — jede Art OHNE Eintrag (oder mit leerer Liste) wird
 * komplett geleert (das ist der Zweck: „nur Auswahl", nicht „alles ausser
 * explizit ausgeschlossen"). Die Kürzung rechnet der Kern (`selection_filter.rs`).
 */
export function filterProjectToSelection(
  project: Project,
  members: Partial<GroupMembership>,
): Project {
  const patch = documentFor(project).queryRoot<Partial<Project>>("selectionFilterPatch", JSON.stringify(members));
  return { ...project, ...patch };
}

/** Gesamtzahl ausgewählter Elemente über alle acht Arten (0 = keine Auswahl). */
export function selectionMemberCount(members: Partial<GroupMembership>): number {
  return Object.values(members).reduce((sum, ids) => sum + (ids?.length ?? 0), 0);
}
