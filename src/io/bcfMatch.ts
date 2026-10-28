// BCF ↔ Dossier: IFC-GlobalId eines Komponenten-Verweises ↔ Bauteil-ids des Projekts.
//
// Dieselbe Ableitung wie der IFC-Export (`exportIfc.ts`/`ifc_export.rs`: `ifcGuid("<Projekt-id>/<Art>/<id>")`),
// damit die Rundreise Dossier → IFC → Solibri → BCF → Dossier trifft. Importierte Meshes tragen die
// GlobalId ihres Quell-Bauteils (`ImportedMesh.ifcGlobalId`). Bauteile, die im Export nicht vorkommen
// (2D-Zeichnungen, Gruppen), haben keine GlobalId.

import type { BcfViewpoint } from "./bcf";
import { ifcGuid } from "../export/exportIfc";
import type { Project } from "../model/types";

/** Ids je Auswahlkanal (Namen wie `selected…Ids` im Zustand). */
export interface BcfSelection {
  wallIds: string[];
  ceilingIds: string[];
  openingIds: string[];
  stairIds: string[];
  roomIds: string[];
  extrudedSolidIds: string[];
  columnIds: string[];
  roofIds: string[];
  contextObjectIds: string[];
}

export type BcfChannel = keyof BcfSelection;

export const emptyBcfSelection = (): BcfSelection => ({
  wallIds: [],
  ceilingIds: [],
  openingIds: [],
  stairIds: [],
  roomIds: [],
  extrudedSolidIds: [],
  columnIds: [],
  roofIds: [],
  contextObjectIds: [],
});

export function bcfSelectionSize(s: BcfSelection): number {
  return Object.values(s).reduce((n, ids) => n + ids.length, 0);
}

interface Target {
  channel: BcfChannel;
  id: string;
}

/** GlobalId → Bauteil (alle Bauteile, die der IFC-Export mit dieser GlobalId schreibt). */
export function buildGuidIndex(project: Project): Map<string, Target> {
  const index = new Map<string, Target>();
  const pid = project.id;
  const add = (key: string, channel: BcfChannel, id: string) => index.set(ifcGuid(`${pid}/${key}/${id}`), { channel, id });
  for (const w of project.walls ?? []) add("wall", "wallIds", w.id);
  for (const c of project.ceilings ?? []) add("slab", "ceilingIds", c.id);
  for (const r of project.roofs ?? []) add("roof", "roofIds", r.id);
  for (const c of project.columns ?? []) add("column", "columnIds", c.id);
  for (const s of project.stairs ?? []) add("stair", "stairIds", s.id);
  for (const e of project.extrudedSolids ?? []) add("extrusion", "extrudedSolidIds", e.id);
  for (const r of project.rooms ?? []) add("space", "roomIds", r.id);
  for (const o of project.openings ?? []) {
    // Tür/Fenster (IfcDoor/IfcWindow) und Öffnung (IfcOpeningElement) gehören zur selben Dossier-Öffnung.
    add("fill", "openingIds", o.id);
    add("opening", "openingIds", o.id);
  }
  for (const o of project.context ?? []) {
    if (o.type === "importedMesh" && o.ifcGlobalId) index.set(o.ifcGlobalId, { channel: "contextObjectIds", id: o.id });
  }
  return index;
}

/** Komponenten-GUIDs → Auswahl; unbekannte GUIDs landen in `missing`. */
export function resolveGuids(project: Project, guids: string[]): { selection: BcfSelection; missing: string[] } {
  const index = buildGuidIndex(project);
  const selection = emptyBcfSelection();
  const missing: string[] = [];
  for (const g of guids) {
    const hit = index.get(g);
    if (!hit) {
      missing.push(g);
      continue;
    }
    if (!selection[hit.channel].includes(hit.id)) selection[hit.channel].push(hit.id);
  }
  return { selection, missing };
}

/** GUIDs, auf die ein Viewpoint zeigt: gewählte Komponenten, sonst die sichtbaren Ausnahmen bei „alles unsichtbar". */
export function viewpointGuids(vp: BcfViewpoint): string[] {
  const picked = vp.selection.map((c) => c.ifcGuid);
  if (picked.length > 0) return [...new Set(picked)];
  if (!vp.defaultVisibility) return [...new Set(vp.exceptions.map((c) => c.ifcGuid))];
  return [];
}

/** Auswahl → IFC-GlobalIds (Umkehrung von {@link resolveGuids}); Elemente ohne GlobalId entfallen. */
export function selectionToGuids(project: Project, sel: BcfSelection): string[] {
  const pid = project.id;
  const guids: string[] = [];
  const g = (key: string, ids: string[]) => ids.forEach((id) => guids.push(ifcGuid(`${pid}/${key}/${id}`)));
  g("wall", sel.wallIds);
  g("slab", sel.ceilingIds);
  g("roof", sel.roofIds);
  g("column", sel.columnIds);
  g("stair", sel.stairIds);
  g("extrusion", sel.extrudedSolidIds);
  g("space", sel.roomIds);
  g("fill", sel.openingIds);
  for (const id of sel.contextObjectIds) {
    const o = (project.context ?? []).find((c) => c.id === id);
    if (o?.type === "importedMesh" && o.ifcGlobalId) guids.push(o.ifcGlobalId);
  }
  return guids;
}
