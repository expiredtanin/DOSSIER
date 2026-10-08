// Export-Scope „nur Auswahl" (Nutzer-Wunsch aus der 2D-Lücken-Recherche:
// „Export exportiert immer den GANZEN Plan" — weder DXF- noch PDF-Dialog
// bieten einen Scope). Reine Projekt-Transform-Funktion: baut ein Project,
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
// Reines Modul: keine React-/Store-Abhängigkeit, wie `objectLock.ts`.
// Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

import type { Project } from "../model/types";
import type { GroupMembership } from "./groupActions";

/**
 * Baut ein Project, das nur die in `members` aufgeführten Elemente der acht
 * Arten enthält — jede Art OHNE Eintrag (oder mit leerer Liste) wird
 * komplett geleert (das ist der Zweck: „nur Auswahl", nicht „alles ausser
 * explizit ausgeschlossen").
 */
export function filterProjectToSelection(
  project: Project,
  members: Partial<GroupMembership>,
): Project {
  const wallIds = new Set(members.wallIds ?? []);
  const drawingIds = new Set(members.drawingIds ?? []);
  const ceilingIds = new Set(members.ceilingIds ?? []);
  const roomIds = new Set(members.roomIds ?? []);
  const stairIds = new Set(members.stairIds ?? []);
  const columnIds = new Set(members.columnIds ?? []);
  const roofIds = new Set(members.roofIds ?? []);
  const openingIds = new Set(members.openingIds ?? []);
  return {
    ...project,
    walls: project.walls.filter((w) => wallIds.has(w.id)),
    drawings2d: project.drawings2d.filter((d) => drawingIds.has(d.id)),
    ceilings: (project.ceilings ?? []).filter((c) => ceilingIds.has(c.id)),
    rooms: (project.rooms ?? []).filter((r) => roomIds.has(r.id)),
    stairs: (project.stairs ?? []).filter((s) => stairIds.has(s.id)),
    columns: (project.columns ?? []).filter((c) => columnIds.has(c.id)),
    roofs: (project.roofs ?? []).filter((r) => roofIds.has(r.id)),
    openings: (project.openings ?? []).filter((o) => openingIds.has(o.id)),
  };
}

/** Gesamtzahl ausgewählter Elemente über alle acht Arten (0 = keine Auswahl). */
export function selectionMemberCount(members: Partial<GroupMembership>): number {
  return Object.values(members).reduce((sum, ids) => sum + (ids?.length ?? 0), 0);
}
