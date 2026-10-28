// Objekt-Sperre (Nutzer-Wunsch: „Kein Objekt-Lock" aus der 2D-Lücken-
// Recherche) — anders als der Ebenen-/Geschoss-Sperrmodus (`DisplayMode`,
// s. `panels/displayMode.ts`, rein session-lokal/ephemer) ist das hier ein
// PERSISTIERTES Feld (`locked?: boolean`) direkt am Element. Deckt dieselben
// acht Elementarten ab wie `groupActions.ts` `MemberKind` (Wand/2D-Zeichnung/
// Decke/Raum/Treppe/Stütze/Dach/Öffnung) — ein gesperrtes Element lässt sich
// nicht anwählen (daher auch nicht verschieben/bearbeiten/löschen), s.
// `useMouseSelectionHandlers.ts` `onPlanSelect`/`onPlanMarquee`.
//
// Reines Modul: keine React-/Store-Abhängigkeit, wie `groupActions.ts`.
// Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

import type { Project } from "../model/types";
import { patchItem } from "../core";
import type { CoreOp } from "../core";
import type { MemberKind } from "./groupActions";

/** Ist das Element (Art + ID) gesperrt? `false` für unbekannte/fehlende IDs. */
export function isLocked(project: Project, kind: MemberKind, id: string): boolean {
  switch (kind) {
    case "wallIds":
      return !!project.walls.find((w) => w.id === id)?.locked;
    case "drawingIds":
      return !!project.drawings2d.find((d) => d.id === id)?.locked;
    case "ceilingIds":
      return !!(project.ceilings ?? []).find((c) => c.id === id)?.locked;
    case "roomIds":
      return !!(project.rooms ?? []).find((r) => r.id === id)?.locked;
    case "stairIds":
      return !!(project.stairs ?? []).find((s) => s.id === id)?.locked;
    case "columnIds":
      return !!(project.columns ?? []).find((c) => c.id === id)?.locked;
    case "roofIds":
      return !!(project.roofs ?? []).find((r) => r.id === id)?.locked;
    case "openingIds":
      return !!(project.openings ?? []).find((o) => o.id === id)?.locked;
  }
}

/** Ops: setzt die Sperre eines Elements; unbekannte IDs sind ein No-Op (keine Ops). */
export function lockOps(project: Project, kind: MemberKind, id: string, locked: boolean): CoreOp[] {
  switch (kind) {
    case "wallIds":
      return patchItem(project, "walls", id, { locked });
    case "drawingIds":
      return patchItem(project, "drawings2d", id, { locked });
    case "ceilingIds":
      return patchItem(project, "ceilings", id, { locked });
    case "roomIds":
      return patchItem(project, "rooms", id, { locked });
    case "stairIds":
      return patchItem(project, "stairs", id, { locked });
    case "columnIds":
      return patchItem(project, "columns", id, { locked });
    case "roofIds":
      return patchItem(project, "roofs", id, { locked });
    case "openingIds":
      return patchItem(project, "openings", id, { locked });
  }
}

/**
 * Setzt die Sperre einer ganzen `GroupMembership`-förmigen Auswahl in EINEM
 * Zug (ein Undo-Schritt für "Auswahl sperren/entsperren", nicht einer je
 * Element). Reihenfolge/Struktur wie `MemberKind` — jedes Feld optional.
 */
export function lockMembersOps(
  project: Project,
  members: Partial<Record<MemberKind, string[]>>,
  locked: boolean,
): CoreOp[] {
  const ops: CoreOp[] = [];
  for (const kind of Object.keys(members) as MemberKind[]) {
    for (const id of members[kind] ?? []) ops.push(...lockOps(project, kind, id, locked));
  }
  return ops;
}
