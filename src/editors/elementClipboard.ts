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
import { uniqueStamp } from "../tools/types";
import { documentFor } from "../core/document";
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

/** Projekt-Liste → Feld in {@link PastedIds}. */
const PASTED_KEY: Record<string, keyof PastedIds> = {
  walls: "wallIds",
  drawings2d: "drawingIds",
  ceilings: "ceilingIds",
  roofs: "roofIds",
  openings: "openingIds",
  stairs: "stairIds",
  rooms: "roomIds",
  extrudedSolids: "extrudedSolidIds",
  columns: "columnIds",
};

/**
 * Fügt eine Zwischenablage ins Projekt ein ([K4] S3: gerechnet im Kern, `cmd_paste.rs`): Klone mit
 * neuen IDs auf dem AKTIVEN Geschoss (`activeLevelId`), an denselben Modell-Koordinaten; Öffnungen
 * an die mitkopierte Wirtswand umgehängt. Liefert die Ops (Anhängen je Liste) + die neuen IDs (für
 * die Nachauswahl). `project` bestimmt nur das Kern-Dokument der Anfrage.
 */
export function pasteElementClipboard(
  project: Project,
  clip: ElementClipboard,
  activeLevelId: string,
): { ops: CoreOp[]; pastedIds: PastedIds } {
  const ops = documentFor(project).cmdOps({ cmd: "paste", clip, levelId: activeLevelId, stamp: uniqueStamp() });
  const pastedIds: PastedIds = {
    wallIds: [],
    drawingIds: [],
    ceilingIds: [],
    roofIds: [],
    openingIds: [],
    stairIds: [],
    roomIds: [],
    extrudedSolidIds: [],
    columnIds: [],
  };
  for (const op of ops) {
    const key = op.kind === "add" ? PASTED_KEY[op.collection] : undefined;
    if (op.kind === "add" && key) for (const e of op.items) pastedIds[key].push((e as { id: string }).id);
  }
  return { ops, pastedIds };
}

export { EMPTY_CLIPBOARD };
