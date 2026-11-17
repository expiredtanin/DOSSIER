// Ops der Nutzungseinheiten ([278]): Einheit anlegen, Räumen zuordnen, löschen. Jede Funktion liefert alle Ops einer
// Benutzeraktion (Projekt-Feld `units` und `unitId` der Räume), damit `applyChange` sie zu EINEM Undo-Schritt macht.

import type { Project, Room, Unit } from "../model/types";
import { setField, patchItems, nextUnitName, newUnitId } from "../core";
import type { CoreOp } from "../core";

/** Räume `roomIds` der Einheit `unitId` zuordnen (`undefined` = keiner Einheit). */
export function assignRoomsOps(p: Project, roomIds: readonly string[], unitId: string | undefined): CoreOp[] {
  return patchItems(p, "rooms", roomIds, (r) => ({ ...r, unitId }) as Room);
}

/** Neue Einheit anlegen und (optional) `roomIds` ihr zuordnen. `id` kommt vom Aufrufer, damit er sie danach kennt. */
export function addUnitOps(p: Project, unit: Unit, roomIds: readonly string[] = []): CoreOp[] {
  return [setField("units", [...(p.units ?? []), unit]), ...assignRoomsOps(p, roomIds, unit.id)];
}

/** Vorschlag einer neuen Einheit (Name „Whg n“, frische id). */
export function draftUnit(p: Project, namePrefix: string): Unit {
  const units = p.units ?? [];
  return { id: newUnitId(units), name: nextUnitName(units, namePrefix) };
}

/** Einheit ändern. */
export function patchUnitOps(p: Project, id: string, patch: Partial<Unit>): CoreOp[] {
  const units = p.units ?? [];
  return [setField("units", units.map((u) => (u.id === id ? { ...u, ...patch } : u)))];
}

/** Einheit löschen; ihre Räume bleiben, ohne Einheit. */
export function deleteUnitOps(p: Project, id: string): CoreOp[] {
  const next = (p.units ?? []).filter((u) => u.id !== id);
  return [setField("units", next.length > 0 ? next : undefined), ...patchItems(p, "rooms", (r) => r.unitId === id, (r) => ({ ...r, unitId: undefined }) as Room)];
}
