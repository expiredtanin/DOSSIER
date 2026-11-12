// „Alles auswählen" (Cmd/Ctrl+A) als reine Funktion: Id-Listen des Projekts für das aktive Geschoss.
// Geschossbezogene Elemente nach floorId/levelId; Schnittlinien-Symbole und Kontext-Elemente
// (Gelände, Höhenlinien, Baugrube, Netze, Bilder) sind projektweit — Kontext nur, wenn seine Klasse
// sichtbar und nicht gesperrt ist ([193], seit [181] normale Elemente mit Klasse).

import type { Project } from "../model/types";
import { collectVisibleCodes, flattenCategories } from "../model/layers";
import type { Selection } from "./selection";

export function selectAllIds(project: Project, levelId: string): Partial<Selection> {
  const wallIds = project.walls.filter((w) => w.floorId === levelId).map((w) => w.id);
  const wallIdSet = new Set(wallIds);
  const drawingIds = project.drawings2d.filter((d) => d.levelId === levelId).map((d) => d.id);
  const ceilingIds = (project.ceilings ?? []).filter((c) => c.floorId === levelId).map((c) => c.id);
  const ceilingIdSet = new Set(ceilingIds);
  const roofIds = (project.roofs ?? []).filter((r) => r.floorId === levelId).map((r) => r.id);
  const roofIdSet = new Set(roofIds);
  // Öffnungen haben kein eigenes floorId (Geschoss über die Wirtswand); Dachfenster/Deckenöffnungen
  // ([103]) über das Dach bzw. die Decke des Geschosses.
  const openingIds = (project.openings ?? [])
    .filter((o) => wallIdSet.has(o.hostWallId) || (!!o.hostRoofId && roofIdSet.has(o.hostRoofId)) || (!!o.hostCeilingId && ceilingIdSet.has(o.hostCeilingId)))
    .map((o) => o.id);
  const stairIds = (project.stairs ?? []).filter((s) => s.floorId === levelId).map((s) => s.id);
  const roomIds = (project.rooms ?? []).filter((r) => r.floorId === levelId).map((r) => r.id);
  const solids = (project.extrudedSolids ?? []).filter((s) => s.levelId === levelId).map((s) => s.id);
  const columnIds = (project.columns ?? []).filter((c) => c.floorId === levelId).map((c) => c.id);
  // [213] Kameras des Geschosses (Symbol im Grundriss), gesperrte bleiben.
  const cameras = (project.cameras ?? []).filter((c) => c.floorId === levelId && !c.locked).map((c) => c.id);
  // Schnittführungs-Symbole sind projektweit (kein floorId; plan/context.rs, plan_section_lines).
  const sectionLines = project.drawingLevels
    .filter((l) => (l.kind === "section" || l.kind === "elevation") && l.linePoints)
    .map((l) => l.id);
  // Kontext-Elemente: projektweit, nur sichtbare und nicht gesperrte Klasse.
  const ctx = project.context ?? [];
  let contextObjects: string[] = [];
  if (ctx.length) {
    const visible = collectVisibleCodes(project.layers);
    const locked = new Set(flattenCategories(project.layers).filter((c) => c.locked).map((c) => c.code));
    contextObjects = ctx.filter((c) => visible.has(c.categoryCode) && !locked.has(c.categoryCode)).map((c) => c.id);
  }
  // Schattenfläche der Sonnenstudie: abgeleitet, aber angeklickt wählbar ([137]) — also auch hier; Entf blendet sie aus.
  const level = project.drawingLevels.find((l) => l.id === levelId);
  // [193] dito der Schlagschatten der Ansicht (`DrawingLevel.shadows`), nur in einer Ansicht.
  const site = project.sunStudy?.show && level?.kind === "floor" ? ["sunStudy"] : level?.kind === "elevation" && level.shadows ? ["viewShadows"] : [];
  return {
    site,
    walls: wallIds,
    drawings: drawingIds,
    ceilings: ceilingIds,
    openings: openingIds,
    stairs: stairIds,
    rooms: roomIds,
    solids,
    columns: columnIds,
    cameras,
    roofs: roofIds,
    contextObjects,
    sectionLines,
  };
}

/** Hat „Alles auswählen" überhaupt etwas gewählt? */
export const selectAllHasAny = (sel: Partial<Selection>): boolean => Object.values(sel).some((l) => (l?.length ?? 0) > 0);
