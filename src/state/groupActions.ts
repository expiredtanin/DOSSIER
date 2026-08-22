// Gruppen (Vectorworks-artig, s. `model/types.ts::Group`): reine Funktionen
// über Mitgliedschaft/Verschachtelung + Erzeugen/Auflösen. Keine React-/Store-
// Abhängigkeit — testbar ohne Mock, wird von `useGroupHandlers.ts` (Klick-/
// Tastatur-Verdrahtung) und `PlanView.tsx` (Dimm-Rendering) konsumiert.
//
// Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

import type { Group, Project } from "../model/types";
import { uniqueId } from "../tools/types";
import type { Primitive } from "../plan/generatePlan/shared";

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

const KEYS: MemberKind[] = [
  "wallIds",
  "drawingIds",
  "ceilingIds",
  "roomIds",
  "stairIds",
  "columnIds",
  "roofIds",
  "openingIds",
];

export function mergeMembership(a: GroupMembership, b: GroupMembership): GroupMembership {
  const out = { ...a };
  for (const k of KEYS) out[k] = [...new Set([...a[k], ...b[k]])];
  return out;
}

/**
 * Transitive Mitgliedschaft einer Gruppe: löst verschachtelte Gruppen
 * (`groupIds`) rekursiv auf und vereinigt alle Mitglieds-IDs. Zyklenschutz
 * über `seen` (sollte nie vorkommen — `groupSelection` verhindert das beim
 * Erzeugen —, ist aber billig und schützt gegen manuell kaputte Projekte).
 */
export function transitiveMembership(
  project: Project,
  groupId: string,
  seen: Set<string> = new Set(),
): GroupMembership {
  if (seen.has(groupId)) return EMPTY_MEMBERSHIP;
  seen.add(groupId);
  const g = (project.groups ?? []).find((x) => x.id === groupId);
  if (!g) return EMPTY_MEMBERSHIP;
  let out: GroupMembership = {
    wallIds: [...g.wallIds],
    drawingIds: [...g.drawingIds],
    ceilingIds: [...g.ceilingIds],
    roomIds: [...g.roomIds],
    stairIds: [...g.stairIds],
    columnIds: [...g.columnIds],
    roofIds: [...g.roofIds],
    openingIds: [...g.openingIds],
  };
  for (const sub of g.groupIds) out = mergeMembership(out, transitiveMembership(project, sub, seen));
  return out;
}

/** IDs aller Gruppen, die als Untergruppe in irgendeiner ANDEREN Gruppe stehen. */
function nestedGroupIds(project: Project): Set<string> {
  const s = new Set<string>();
  for (const g of project.groups ?? []) for (const id of g.groupIds) s.add(id);
  return s;
}

/** Top-Level-Gruppen (nicht Untergruppe einer anderen Gruppe) — Kandidaten ausserhalb jeder Isolation. */
export function topLevelGroups(project: Project): Group[] {
  const nested = nestedGroupIds(project);
  return (project.groups ?? []).filter((g) => !nested.has(g.id));
}

/**
 * Die „sichtbare" Gruppe, die ein Element enthält, relativ zum aktuellen
 * Isolations-Kontext `groupPath` (leer = nicht isoliert):
 *  • nicht isoliert: sucht unter den TOP-LEVEL-Gruppen (verschachtelte
 *    Untergruppen sind dabei „unsichtbar", man sieht nur die äusserste Hülle).
 *  • isoliert (aktive Gruppe = letztes Element von `groupPath`): sucht NUR
 *    unter den DIREKTEN Untergruppen der aktiven Gruppe — direkte Mitglieder
 *    der aktiven Gruppe selbst zählen NICHT als „von einer Gruppe enthalten"
 *    (die sind ja gerade einzeln bearbeitbar, weil man in der Gruppe ist).
 * `null` = das Element gehört zu keiner (in diesem Kontext sichtbaren) Gruppe.
 */
export function containingGroupId(
  project: Project,
  kind: MemberKind,
  id: string,
  groupPath: string[],
): string | null {
  let candidates: Group[];
  if (groupPath.length === 0) {
    candidates = topLevelGroups(project);
  } else {
    const active = (project.groups ?? []).find((g) => g.id === groupPath[groupPath.length - 1]);
    if (!active) return null;
    candidates = active.groupIds
      .map((gid) => (project.groups ?? []).find((g) => g.id === gid))
      .filter((g): g is Group => !!g);
  }
  for (const g of candidates) {
    if (transitiveMembership(project, g.id)[kind].includes(id)) return g.id;
  }
  return null;
}

/**
 * Ob ein Element im aktuellen Isolations-Kontext editierbar ist: ohne aktive
 * Gruppe (`groupPath` leer) immer `true`; isoliert nur, wenn das Element
 * TRANSITIV zur aktiven (innersten) Gruppe gehört — alles andere ist „grau
 * und gesperrt", analog zum bestehenden Ebenen-Sperren-Modus.
 */
export function isInsideActiveGroup(
  project: Project,
  kind: MemberKind,
  id: string,
  groupPath: string[],
): boolean {
  if (groupPath.length === 0) return true;
  const active = groupPath[groupPath.length - 1];
  return transitiveMembership(project, active)[kind].includes(id);
}

/**
 * Erweitert eine rohe Treffer-Mitgliedschaft (aus Einzelklick ODER Marquee,
 * beliebig viele IDs je Art) um Gruppen: jede ID, die zu einer im aktuellen
 * Isolations-Kontext (`groupPath`) SICHTBAREN Gruppe gehört (s.
 * `containingGroupId`), wird durch die TRANSITIVE Mitgliedschaft dieser
 * Gruppe ersetzt; IDs ohne Gruppe bleiben einzeln. Liefert zusätzlich die
 * Menge der dabei „getroffenen" Gruppen-IDs (für `selectedGroupIds`/die
 * Bounding-Box-Anzeige). Deckt Einzelklick (eine ID) UND Marquee (viele IDs
 * über mehrere Arten) mit derselben Logik ab.
 */
export function expandToGroups(
  project: Project,
  raw: GroupMembership,
  groupPath: string[],
): { expanded: GroupMembership; groupIds: string[] } {
  let expanded: GroupMembership = { ...EMPTY_MEMBERSHIP };
  const groupIds = new Set<string>();
  for (const k of KEYS) {
    for (const id of raw[k]) {
      const gid = containingGroupId(project, k, id, groupPath);
      if (gid) {
        groupIds.add(gid);
        expanded = mergeMembership(expanded, transitiveMembership(project, gid));
      } else {
        expanded = mergeMembership(expanded, { ...EMPTY_MEMBERSHIP, [k]: [id] });
      }
    }
  }
  return { expanded, groupIds: [...groupIds] };
}

/** Primitiv-ID-Feld → zugehörige `MemberKind` (Reihenfolge irrelevant). */
const ID_FIELD_TO_KIND: [string, MemberKind][] = [
  ["wallId", "wallIds"],
  ["drawingId", "drawingIds"],
  ["ceilingId", "ceilingIds"],
  ["roomId", "roomIds"],
  ["stairId", "stairIds"],
  ["columnId", "columnIds"],
  ["roofId", "roofIds"],
  ["openingId", "openingIds"],
];

/**
 * Dimmt (setzt `greyed: true`) jedes Primitiv, das zu einem ECHTEN Element
 * (trägt eines der bekannten ID-Felder) gehört, das NICHT transitiv zur
 * aktiven (innersten) Gruppe von `groupPath` gehört — die visuelle Seite der
 * Isolation (Vectorworks „Gruppe betreten"), analog zum Sperren beim Klicken
 * (`isInsideActiveGroup`). Primitive OHNE jede solche ID (Raster, Massstabs-
 * leiste o. Ä.) bleiben unverändert. `groupPath` leer → unverändert (kein
 * Isolations-Kontext, alles normal sichtbar).
 */
export function applyGroupDimming(
  primitives: Primitive[],
  project: Project,
  groupPath: string[],
): Primitive[] {
  if (groupPath.length === 0) return primitives;
  const active = groupPath[groupPath.length - 1];
  const mem = transitiveMembership(project, active);
  const sets: Record<MemberKind, Set<string>> = {
    wallIds: new Set(mem.wallIds),
    drawingIds: new Set(mem.drawingIds),
    ceilingIds: new Set(mem.ceilingIds),
    roomIds: new Set(mem.roomIds),
    stairIds: new Set(mem.stairIds),
    columnIds: new Set(mem.columnIds),
    roofIds: new Set(mem.roofIds),
    openingIds: new Set(mem.openingIds),
  };
  return primitives.map((p) => {
    const rec = p as unknown as Record<string, unknown>;
    let hasId = false;
    let inside = false;
    for (const [field, kind] of ID_FIELD_TO_KIND) {
      const v = rec[field];
      if (typeof v !== "string") continue;
      hasId = true;
      if (sets[kind].has(v)) inside = true;
    }
    return hasId && !inside ? { ...p, greyed: true } : p;
  });
}

/**
 * Erzeugt eine neue Gruppe aus einer Mengen-Auswahl (+ optional bereits
 * gewählte Gruppen, die dabei als Untergruppen verschachtelt werden — „zwei
 * Gruppen + Cmd+G" fasst sie in einer neuen äusseren Gruppe zusammen, statt
 * ihre Mitglieder platt zu vermischen). Leere Auswahl → `null` (nichts zu tun).
 */
export function groupSelection(
  project: Project,
  sel: GroupMembership,
  selectedGroupIds: string[],
): { project: Project; groupId: string } | null {
  const totalCount =
    KEYS.reduce((n, k) => n + sel[k].length, 0) + selectedGroupIds.length;
  if (totalCount < 2) return null; // Gruppieren braucht ≥ 2 Elemente (Vectorworks-Konvention)
  const id = uniqueId("grp");
  const g: Group = {
    id,
    wallIds: sel.wallIds,
    drawingIds: sel.drawingIds,
    ceilingIds: sel.ceilingIds,
    roomIds: sel.roomIds,
    stairIds: sel.stairIds,
    columnIds: sel.columnIds,
    roofIds: sel.roofIds,
    openingIds: sel.openingIds,
    groupIds: [...selectedGroupIds],
  };
  return { project: { ...project, groups: [...(project.groups ?? []), g] }, groupId: id };
}

/**
 * Löst EINE Gruppenhülle auf (ein Level, Vectorworks-Ungroup): Untergruppen
 * bleiben als eigene Gruppen bestehen (werden nicht rekursiv aufgelöst). Die
 * direkten Mitglieder (Elemente + Untergruppen-IDs) der aufgelösten Gruppe
 * kommen als Ergebnis zurück, damit der Aufrufer sie als neue Auswahl setzen
 * kann. `null`, wenn die ID keine Gruppe ist.
 */
export function ungroup(
  project: Project,
  groupId: string,
): { project: Project; members: GroupMembership; subGroupIds: string[] } | null {
  const g = (project.groups ?? []).find((x) => x.id === groupId);
  if (!g) return null;
  return {
    project: { ...project, groups: (project.groups ?? []).filter((x) => x.id !== groupId) },
    members: {
      wallIds: g.wallIds,
      drawingIds: g.drawingIds,
      ceilingIds: g.ceilingIds,
      roomIds: g.roomIds,
      stairIds: g.stairIds,
      columnIds: g.columnIds,
      roofIds: g.roofIds,
      openingIds: g.openingIds,
    },
    subGroupIds: g.groupIds,
  };
}
