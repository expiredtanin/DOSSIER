// Gruppen (Vectorworks-artig, s. `model/types.ts::Group`): Erzeugen/Auflösen und Zuordnen als Ops,
// Dimmen der Plan-Primitive bei Isolation. Die Mitgliedschafts-Logik (transitiv, sichtbare Gruppe,
// Auswahl erweitern) rechnet der Rust-Kern (`src-tauri/core/src/groups.rs`, Fassade `model/groups.ts`,
// [K4] S3); hier re-exportiert. Keine React-/Store-Abhängigkeit.
//
// Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

import type { Drawing2D, Group, Project } from "../model/types";
import type { Plan, UnderlayGroup } from "../core";
import { uniqueId } from "../tools/types";
import type { Primitive } from "../core";
import type { CoreOp } from "../core";
import { addItems, removeItems } from "../core";
import { transitiveMembership } from "../core";
import type { GroupMembership, MemberKind } from "../core";

export type { GroupMembership, MemberKind } from "../core";
export { EMPTY_MEMBERSHIP, containingGroupId, expandToGroups, isInsideActiveGroup, transitiveMembership } from "../core";

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

/** Vereinigung je Art (erste Vorkommen in Reihenfolge) — für Auswahl-Mengen in der Hülle. */
export function mergeMembership(a: GroupMembership, b: GroupMembership): GroupMembership {
  const out = { ...a };
  for (const k of KEYS) out[k] = [...new Set([...a[k], ...b[k]])];
  return out;
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
 * Wie `applyGroupDimming`, aber auf einem ganzen Plan: die kompakte Linien-
 * Unterlage (`plan.underlay`, bei Kataster-Importen Millionen Linien) bleibt
 * kompakt — ihre Zeichnungen ausserhalb der aktiven Gruppe wandern in eine
 * zusätzlich gedimmte Untergruppe (`tint`), statt dass alle Linien zu einzelnen
 * Primitiven materialisiert und geklont werden.
 */
export function applyGroupDimmingToPlan(plan: Plan, project: Project, groupPath: string[]): Plan {
  if (groupPath.length === 0) return plan;
  const primitives = applyGroupDimming(plan.primitives, project, groupPath);
  if (!plan.underlay || plan.underlay.length === 0) return { ...plan, primitives };
  const inside = new Set(transitiveMembership(project, groupPath[groupPath.length - 1]).drawingIds);
  const underlay: UnderlayGroup[] = [];
  for (const g of plan.underlay) {
    const inn: Drawing2D[] = [];
    const out: Drawing2D[] = [];
    for (const d of g.drawings) (inside.has(d.id) ? inn : out).push(d);
    if (inn.length) underlay.push(out.length ? { ...g, drawings: inn } : g);
    if (out.length) underlay.push({ ...g, drawings: out, tint: true });
  }
  return { ...plan, primitives, underlay };
}

/**
 * Erzeugt eine neue Gruppe aus einer Mengen-Auswahl (+ optional bereits
 * gewählte Gruppen, die dabei als Untergruppen verschachtelt werden — „zwei
 * Gruppen + Cmd+G" fasst sie in einer neuen äusseren Gruppe zusammen, statt
 * ihre Mitglieder platt zu vermischen). Leere Auswahl → `null` (nichts zu tun).
 */
export function groupSelection(
  sel: GroupMembership,
  selectedGroupIds: string[],
): { ops: CoreOp[]; groupId: string } | null {
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
  return { ops: addItems("groups", [g]), groupId: id };
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
): { ops: CoreOp[]; members: GroupMembership; subGroupIds: string[] } | null {
  const g = (project.groups ?? []).find((x) => x.id === groupId);
  if (!g) return null;
  return {
    ops: removeItems(project, "groups", [groupId]),
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
