// Gruppen-Logik im Rust-Kern ([K4] S3, `src-tauri/core/src/groups.rs`): transitive Mitgliedschaft,
// die im Isolations-Kontext sichtbare Gruppe eines Elements, Auswahl um Gruppen erweitern. Dünne
// Fassade über Kern-Abfragen auf dem Dokument des Projekts (`documentFor`); die Op-Bauer und das
// Dimmen der Plan-Primitive bleiben in `state/groupActions.ts`.

import type { Project } from "./types";
import { documentFor } from "../core/document";

/** Mitglieds-IDs je Elementart — dieselbe Form wie `Group`, ohne `id`/`name`/`groupIds`. */
export interface GroupMembership {
  wallIds: string[];
  drawingIds: string[];
  ceilingIds: string[];
  roomIds: string[];
  stairIds: string[];
  columnIds: string[];
  roofIds: string[];
  openingIds: string[];
}

export type MemberKind = keyof GroupMembership;

export const EMPTY_MEMBERSHIP: GroupMembership = {
  wallIds: [],
  drawingIds: [],
  ceilingIds: [],
  roomIds: [],
  stairIds: [],
  columnIds: [],
  roofIds: [],
  openingIds: [],
};

/** Letzte transitive Mitgliedschaft (Projekt + Gruppe): Klick-/Rahmen-Filter fragen je Element. */
let memo: { project: Project; groupId: string; m: GroupMembership; sets: Map<MemberKind, Set<string>> } | null = null;

function cached(project: Project, groupId: string) {
  if (memo && memo.project === project && memo.groupId === groupId) return memo;
  const m = documentFor(project).query<GroupMembership>("groupMembership", [], groupId);
  memo = { project, groupId, m, sets: new Map() };
  return memo;
}

/**
 * Transitive Mitgliedschaft einer Gruppe: löst verschachtelte Gruppen (`groupIds`) rekursiv auf und
 * vereinigt alle Mitglieds-IDs (Zyklenschutz). Unbekannte Gruppe = leer.
 */
export function transitiveMembership(project: Project, groupId: string): GroupMembership {
  return cached(project, groupId).m;
}

/**
 * Die „sichtbare" Gruppe, die ein Element enthält, relativ zum Isolations-Kontext `groupPath`
 * (leer = nicht isoliert): ohne Isolation unter den obersten Gruppen, isoliert nur unter den
 * DIREKTEN Untergruppen der aktiven Gruppe (direkte Mitglieder der aktiven Gruppe zählen nicht).
 * `null` = keine.
 */
export function containingGroupId(project: Project, kind: MemberKind, id: string, groupPath: string[]): string | null {
  if (!project.groups?.length) return null;
  return documentFor(project).query<string | null>("containingGroup", [], JSON.stringify({ kind, id, path: groupPath }));
}

/**
 * Ob ein Element im Isolations-Kontext editierbar ist: ohne aktive Gruppe immer, isoliert nur, wenn
 * es TRANSITIV zur aktiven (innersten) Gruppe gehört.
 */
export function isInsideActiveGroup(project: Project, kind: MemberKind, id: string, groupPath: string[]): boolean {
  if (groupPath.length === 0) return true;
  const c = cached(project, groupPath[groupPath.length - 1]);
  let set = c.sets.get(kind);
  if (!set) {
    set = new Set(c.m[kind]);
    c.sets.set(kind, set);
  }
  return set.has(id);
}

/**
 * Erweitert eine Treffer-Mitgliedschaft (Einzelklick oder Rahmen) um Gruppen: jede id einer im
 * Kontext sichtbaren Gruppe wird durch deren transitive Mitgliedschaft ersetzt, ids ohne Gruppe
 * bleiben einzeln; dazu die getroffenen Gruppen-ids.
 */
export function expandToGroups(
  project: Project,
  raw: GroupMembership,
  groupPath: string[],
): { expanded: GroupMembership; groupIds: string[] } {
  if (!project.groups?.length) {
    // Ohne Gruppen: nur vereinigen (wie der Kern, ohne Übergabe).
    const expanded = { ...EMPTY_MEMBERSHIP };
    for (const k of Object.keys(EMPTY_MEMBERSHIP) as MemberKind[]) expanded[k] = [...new Set(raw[k])];
    return { expanded, groupIds: [] };
  }
  return documentFor(project).query("expandToGroups", [], JSON.stringify({ raw, path: groupPath }));
}
