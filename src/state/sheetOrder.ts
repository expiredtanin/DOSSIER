// [333] Blätter-Leiste: reine Logik für Umsortieren, Duplizieren und Löschen eines Blatts (Op-Bauer, ohne UI).

import { addItems, fieldOps, removeItems } from "../core";
import type { CoreOp } from "../core";
import type { Layout, Project } from "../model/types";
import { createSheetLevel } from "../model/layoutModel";

/**
 * Verschiebt `fromId` an die Einfüge-Stelle `slot` (0…n, gezählt in der ALTEN Liste: „vor dem Blatt mit diesem Index“).
 * Ohne Änderung (unbekannte id, Stelle direkt vor/nach dem Blatt) kommt dieselbe Liste zurück.
 */
export function moveSheetIds(ids: readonly string[], fromId: string, slot: number): readonly string[] {
  const from = ids.indexOf(fromId);
  if (from < 0) return ids;
  const s = Math.max(0, Math.min(ids.length, Math.round(slot)));
  if (s === from || s === from + 1) return ids;
  const rest = ids.filter((id) => id !== fromId);
  rest.splice(s > from ? s - 1 : s, 0, fromId);
  return rest;
}

/** Ops, die das Blatt `fromId` an die Stelle `slot` setzen (ein Undo-Schritt); leer, wenn sich nichts ändert. */
export function reorderSheetsOps(p: Project, fromId: string, slot: number): CoreOp[] {
  const layouts = p.layouts ?? [];
  const ids = layouts.map((l) => l.id);
  const next = moveSheetIds(ids, fromId, slot);
  if (next === ids) return [];
  const byId = new Map(layouts.map((l) => [l.id, l]));
  return fieldOps(p, "layouts", next.map((id) => byId.get(id)!));
}

/** Ops, die ein Blatt samt Blatt-Ebene und deren Zeichnungen entfernen. */
export function deleteSheetOps(p: Project, id: string): CoreOp[] {
  const levels = p.drawingLevels.filter((l) => l.layoutId === id).map((l) => l.id);
  const drawings = p.drawings2d.filter((d) => levels.includes(d.levelId)).map((d) => d.id);
  return [
    ...removeItems(p, "drawings2d", drawings),
    ...removeItems(p, "drawingLevels", levels),
    ...removeItems(p, "layouts", [id]),
  ];
}

/**
 * Ops, die ein Blatt direkt hinter dem Original kopieren: eigene Blatt-Ebene samt Zeichnungen (neue ids),
 * ohne eigene Plannummer (sonst doppelt). Leer, wenn das Blatt fehlt.
 */
export function duplicateSheetOps(p: Project, id: string, newId: string, copyName: string): CoreOp[] {
  const layouts = p.layouts ?? [];
  const at = layouts.findIndex((l) => l.id === id);
  if (at < 0) return [];
  const copy: Layout = { ...layouts[at], id: newId, name: copyName, planNumber: undefined };
  const levelIds = new Map<string, string>();
  const newLevels = p.drawingLevels
    .filter((l) => l.layoutId === id)
    .map((l) => {
      const nid = `sheet-${newId}${levelIds.size ? `-${levelIds.size}` : ""}`;
      levelIds.set(l.id, nid);
      return { ...createSheetLevel(nid, copy), ...l, id: nid, name: copyName, layoutId: newId };
    });
  const newDrawings = p.drawings2d
    .filter((d) => levelIds.has(d.levelId))
    .map((d, i) => ({ ...d, id: `${d.id}-${newId}-${i}`, levelId: levelIds.get(d.levelId)! }));
  return [...addItems("layouts", [copy], at + 1), ...addItems("drawingLevels", newLevels), ...addItems("drawings2d", newDrawings)];
}
