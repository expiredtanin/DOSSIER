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

/** Setzt die Sperre eines Elements (immutabel); unbekannte IDs sind ein No-Op. */
export function setLocked(project: Project, kind: MemberKind, id: string, locked: boolean): Project {
  switch (kind) {
    case "wallIds":
      return { ...project, walls: project.walls.map((w) => (w.id === id ? { ...w, locked } : w)) };
    case "drawingIds":
      return {
        ...project,
        drawings2d: project.drawings2d.map((d) => (d.id === id ? { ...d, locked } : d)),
      };
    case "ceilingIds":
      return {
        ...project,
        ceilings: (project.ceilings ?? []).map((c) => (c.id === id ? { ...c, locked } : c)),
      };
    case "roomIds":
      return { ...project, rooms: (project.rooms ?? []).map((r) => (r.id === id ? { ...r, locked } : r)) };
    case "stairIds":
      return {
        ...project,
        stairs: (project.stairs ?? []).map((s) => (s.id === id ? { ...s, locked } : s)),
      };
    case "columnIds":
      return {
        ...project,
        columns: (project.columns ?? []).map((c) => (c.id === id ? { ...c, locked } : c)),
      };
    case "roofIds":
      return { ...project, roofs: (project.roofs ?? []).map((r) => (r.id === id ? { ...r, locked } : r)) };
    case "openingIds":
      return {
        ...project,
        openings: (project.openings ?? []).map((o) => (o.id === id ? { ...o, locked } : o)),
      };
  }
}

/**
 * Setzt die Sperre einer ganzen `GroupMembership`-förmigen Auswahl in EINEM
 * Zug (ein Undo-Schritt für "Auswahl sperren/entsperren", nicht einer je
 * Element). Reihenfolge/Struktur wie `MemberKind` — jedes Feld optional.
 */
export function setLockedForMembers(
  project: Project,
  members: Partial<Record<MemberKind, string[]>>,
  locked: boolean,
): Project {
  let next = project;
  for (const kind of Object.keys(members) as MemberKind[]) {
    for (const id of members[kind] ?? []) {
      next = setLocked(next, kind, id, locked);
    }
  }
  return next;
}
