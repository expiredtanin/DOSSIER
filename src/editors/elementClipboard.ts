// Kopieren/Einfügen (Ctrl/Cmd+C/V) für ALLE Bauteil-Arten, nicht nur 2D-
// Zeichenelemente (die das schon länger konnten, s. `useKeyboardShortcuts.ts`).
// Reine Funktionen; die Tastatur-Verdrahtung bleibt in `useKeyboardShortcuts.ts`
// (`useElementClipboardShortcut`), analog zum bisherigen 2D-only-Mechanismus.
//
// Einfügen legt Klone mit NEUEN IDs auf dem AKTIVEN Geschoss an, an denselben
// Modell-Koordinaten wie beim Kopieren (Nutzer verschiebt danach bei Bedarf) —
// exakt dasselbe Verhalten wie das bestehende 2D-Kopieren.
//
// Öffnungen (Fenster/Türen) sind an eine Wand gebunden (`hostWallId`) — eine
// Öffnung ohne gültige Wirtswand ist im Modell nicht vorgesehen (dieselbe
// Invariante wie beim Löschen einer Zeichnungsebene, s. `projectSlice.ts`
// `deleteLevel`). Eine Öffnung wird daher NUR mitkopiert, wenn ihre Wirtswand
// ebenfalls Teil der Kopie ist (Paar-Kopie, `hostWallId` wird auf die neue
// Wand-ID umgehängt); eine isoliert gewählte Öffnung ohne ihre Wand hat kein
// sinnvolles Einfüge-Ziel und wird beim Kopieren stillschweigend übersprungen
// — bewusste, dokumentierte Scope-Entscheidung statt eines rätselhaften No-ops.
//
// Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

import type {
  Ceiling,
  Column,
  Drawing2D,
  ExtrudedSolid,
  Opening,
  Project,
  Roof,
  Room,
  Stair,
  Wall,
} from "../model/types";
import { uniqueId } from "../tools/types";
import { addItems } from "../core";
import type { CoreOp } from "../core";

/** Auswahl-IDs je Bauteil-Art, wie sie die 9 Auswahl-Kanäle des Stores liefern. */
export interface ElementSelectionIds {
  wallIds: string[];
  drawingIds: string[];
  ceilingIds: string[];
  roofIds: string[];
  openingIds: string[];
  stairIds: string[];
  roomIds: string[];
  extrudedSolidIds: string[];
  columnIds: string[];
}

/** Tiefe Kopie der gewählten Elemente über alle Bauteil-Arten hinweg. */
export interface ElementClipboard {
  walls: Wall[];
  drawings: Drawing2D[];
  ceilings: Ceiling[];
  roofs: Roof[];
  openings: Opening[];
  stairs: Stair[];
  rooms: Room[];
  extrudedSolids: ExtrudedSolid[];
  columns: Column[];
}

const EMPTY_CLIPBOARD: ElementClipboard = {
  walls: [],
  drawings: [],
  ceilings: [],
  roofs: [],
  openings: [],
  stairs: [],
  rooms: [],
  extrudedSolids: [],
  columns: [],
};

/** Ist die Zwischenablage leer (nichts zum Einfügen)? */
export function isClipboardEmpty(c: ElementClipboard): boolean {
  return (
    c.walls.length === 0 &&
    c.drawings.length === 0 &&
    c.ceilings.length === 0 &&
    c.roofs.length === 0 &&
    c.openings.length === 0 &&
    c.stairs.length === 0 &&
    c.rooms.length === 0 &&
    c.extrudedSolids.length === 0 &&
    c.columns.length === 0
  );
}

/**
 * Sammelt die gewählten Elemente (über alle 9 Auswahl-Kanäle) tief kopiert in
 * eine Zwischenablage. `null`, wenn NICHTS gewählt ist (Aufrufer lässt dann
 * das native Browser-Copy laufen statt `preventDefault`, s. bisheriges
 * 2D-Verhalten).
 */
export function collectElementClipboard(
  project: Project,
  sel: ElementSelectionIds,
): ElementClipboard | null {
  const wallIds = new Set(sel.wallIds);
  const walls = project.walls.filter((w) => wallIds.has(w.id));
  const drawings = project.drawings2d.filter((d) => sel.drawingIds.includes(d.id));
  const ceilingIds = new Set(sel.ceilingIds);
  const ceilings = (project.ceilings ?? []).filter((c) => ceilingIds.has(c.id));
  const roofIds = new Set(sel.roofIds);
  const roofs = (project.roofs ?? []).filter((r) => roofIds.has(r.id));
  // Öffnungen: automatisch mitkopiert, wenn ihre Wirtswand mitkopiert wird
  // (kaskadiert wie beim Löschen einer Wand/Ebene, unabhängig davon, ob die
  // Öffnung selbst zusätzlich explizit markiert war, s. Kopfkommentar).
  const openings = (project.openings ?? []).filter((o) => wallIds.has(o.hostWallId));
  const stairIds = new Set(sel.stairIds);
  const stairs = (project.stairs ?? []).filter((s) => stairIds.has(s.id));
  const roomIds = new Set(sel.roomIds);
  const rooms = (project.rooms ?? []).filter((r) => roomIds.has(r.id));
  const extrudedSolidIds = new Set(sel.extrudedSolidIds);
  const extrudedSolids = (project.extrudedSolids ?? []).filter((s) => extrudedSolidIds.has(s.id));
  const columnIds = new Set(sel.columnIds);
  const columns = (project.columns ?? []).filter((c) => columnIds.has(c.id));

  const clip: ElementClipboard = {
    walls: walls.map((w) => structuredClone(w)),
    drawings: drawings.map((d) => structuredClone(d)),
    ceilings: ceilings.map((c) => structuredClone(c)),
    roofs: roofs.map((r) => structuredClone(r)),
    openings: openings.map((o) => structuredClone(o)),
    stairs: stairs.map((s) => structuredClone(s)),
    rooms: rooms.map((r) => structuredClone(r)),
    extrudedSolids: extrudedSolids.map((s) => structuredClone(s)),
    columns: columns.map((c) => structuredClone(c)),
  };
  return isClipboardEmpty(clip) ? null : clip;
}

/** Neue IDs je Bauteil-Art (für die Nachauswahl nach dem Einfügen). */
export interface PastedIds {
  wallIds: string[];
  drawingIds: string[];
  ceilingIds: string[];
  roofIds: string[];
  openingIds: string[];
  stairIds: string[];
  roomIds: string[];
  extrudedSolidIds: string[];
  columnIds: string[];
}

/**
 * Fügt eine Zwischenablage ins Projekt ein: Klone mit neuen IDs auf dem
 * AKTIVEN Geschoss (`activeLevelId`), an denselben Modell-Koordinaten. Liefert
 * die Ops (Anhängen je Liste) + die neuen IDs (für die Nachauswahl).
 */
export function pasteElementClipboard(
  clip: ElementClipboard,
  activeLevelId: string,
): { ops: CoreOp[]; pastedIds: PastedIds } {
  const wallIdMap = new Map<string, string>();
  const newWalls: Wall[] = clip.walls.map((w) => {
    const id = uniqueId("W");
    wallIdMap.set(w.id, id);
    return { ...w, id, floorId: activeLevelId };
  });
  const newDrawings: Drawing2D[] = clip.drawings.map((d) => ({
    ...d,
    id: uniqueId("dr2d"),
    levelId: activeLevelId,
  }));
  const newCeilings: Ceiling[] = clip.ceilings.map((c) => ({
    ...c,
    id: uniqueId("C"),
    floorId: activeLevelId,
  }));
  const newRoofs: Roof[] = clip.roofs.map((r) => ({
    ...r,
    id: uniqueId("RF"),
    floorId: activeLevelId,
  }));
  // Nur Öffnungen mit einer erfolgreich mitkopierten Wirtswand ergeben eine
  // gültige neue Öffnung (sollte durch `collectElementClipboard` immer
  // gegeben sein — Map-Miss defensiv übersprungen statt eine kaputte
  // Öffnung ohne Wirt zu erzeugen).
  const newOpenings: Opening[] = [];
  for (const o of clip.openings) {
    const hostWallId = wallIdMap.get(o.hostWallId);
    if (!hostWallId) continue;
    newOpenings.push({ ...o, id: uniqueId("O"), hostWallId });
  }
  const newStairs: Stair[] = clip.stairs.map((s) => ({
    ...s,
    id: uniqueId("ST"),
    floorId: activeLevelId,
  }));
  const newRooms: Room[] = clip.rooms.map((r) => ({
    ...r,
    id: uniqueId("RM"),
    floorId: activeLevelId,
  }));
  const newExtrudedSolids: ExtrudedSolid[] = clip.extrudedSolids.map((s) => ({
    ...s,
    id: uniqueId("extrude"),
    levelId: activeLevelId,
  }));
  const newColumns: Column[] = clip.columns.map((c) => ({
    ...c,
    id: uniqueId("column"),
    floorId: activeLevelId,
  }));

  // Wände vor Öffnungen (Wirtswand zuerst), sonst Reihenfolge der Projekt-Listen.
  const ops: CoreOp[] = [
    ...addItems("walls", newWalls),
    ...addItems("drawings2d", newDrawings),
    ...addItems("ceilings", newCeilings),
    ...addItems("roofs", newRoofs),
    ...addItems("openings", newOpenings),
    ...addItems("stairs", newStairs),
    ...addItems("rooms", newRooms),
    ...addItems("extrudedSolids", newExtrudedSolids),
    ...addItems("columns", newColumns),
  ];

  return {
    ops,
    pastedIds: {
      wallIds: newWalls.map((w) => w.id),
      drawingIds: newDrawings.map((d) => d.id),
      ceilingIds: newCeilings.map((c) => c.id),
      roofIds: newRoofs.map((r) => r.id),
      openingIds: newOpenings.map((o) => o.id),
      stairIds: newStairs.map((s) => s.id),
      roomIds: newRooms.map((r) => r.id),
      extrudedSolidIds: newExtrudedSolids.map((s) => s.id),
      columnIds: newColumns.map((c) => c.id),
    },
  };
}

export { EMPTY_CLIPBOARD };
