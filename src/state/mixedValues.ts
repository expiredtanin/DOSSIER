// [195] Mehrfachauswahl im Objekteinstellungs-Fenster: gemeinsamer Wert einer Eigenschaft über alle gewählten
// Elemente. Weichen die Werte ab, zeigt das Feld nichts („gemischt"); eine Änderung gilt für alle.

import type { Project } from "../model/types";
import { ELEMENT_KINDS, type Selection, type SelectionKind } from "./selection";
import { deriveSelection } from "./selectionInfo";

/** Gemeinsamer Wert (`value`) oder `mixed`, wenn die Werte abweichen. Leere Liste: weder Wert noch gemischt. */
export interface Common<T> {
  value: T | undefined;
  mixed: boolean;
}

export function commonValue<T>(values: readonly T[]): Common<T> {
  if (values.length === 0) return { value: undefined, mixed: false };
  const first = values[0];
  return values.every((v) => v === first) ? { value: first, mixed: false } : { value: undefined, mixed: true };
}

/** Arten, deren Stift (Farbe, Strichstärke) das Fenster für alle gewählten Elemente setzt. */
export const STYLE_KINDS: readonly SelectionKind[] = ["walls", "ceilings", "drawings"];

/** Obergrenze, damit eine riesige Auswahl das Fenster nicht ausbremst (je Element eine Kern-Abfrage). */
const MAX_COMPARED = 200;

export interface SelectionAppearance {
  /** Anzahl gewählter Elemente (ohne gemeinsame Gruppen/Lage-Marker). */
  count: number;
  weightMm: Common<number>;
  color: Common<string>;
  /** [195b] Wirksame Schraffur (Ressourcen-id, "" = keine). */
  hatch: Common<string>;
}

/** Zahl der gewählten Elemente (ohne Gruppen, Schnittlinien, Lage-Darstellung, Bäume). */
export function selectedCount(sel: Selection): number {
  return ELEMENT_KINDS.filter((k) => k !== "sectionLines" && k !== "site" && k !== "trees").reduce((n, k) => n + sel[k].length, 0);
}

/** Effektive Strichstärke und Farbe über die gewählten Wände/Decken/2D-Elemente. */
export function selectionAppearance(project: Project, sel: Selection): SelectionAppearance {
  const weights: number[] = [];
  const colors: string[] = [];
  const hatches: string[] = [];
  let n = 0;
  for (const kind of STYLE_KINDS) {
    for (const id of sel[kind]) {
      if (n++ >= MAX_COMPARED) break;
      const info = deriveSelection(project, { [kind]: [id] });
      if (!info) continue;
      weights.push(info.weightMm);
      colors.push(info.color);
      hatches.push(info.effectiveHatchId ?? "");
    }
  }
  return { count: selectedCount(sel), weightMm: commonValue(weights), color: commonValue(colors), hatch: commonValue(hatches) };
}

/** [195b] Wandtyp und Dicke über die gewählten Wände (Typ und Masse bei Mehrfachauswahl). */
export interface SelectionWallValues {
  wallTypeId: Common<string>;
  thickness: Common<number>;
}

export function selectionWallValues(project: Project, sel: Selection): SelectionWallValues {
  const types: string[] = [];
  const thick: number[] = [];
  for (const id of sel.walls.slice(0, MAX_COMPARED)) {
    const wall = deriveSelection(project, { walls: [id] })?.wall;
    if (!wall) continue;
    types.push(wall.wallTypeId);
    thick.push(wall.thickness);
  }
  return { wallTypeId: commonValue(types), thickness: commonValue(thick) };
}

/** Schlüssel einer Höhenangabe (Anker + aufgelöstes Z), damit gleiche Lagen als gleich gelten. */
function heightKey(anchor: unknown, z: number): string {
  return `${JSON.stringify(anchor ?? null)}|${Math.round(z * 1e6)}`;
}

/** [195b] Unter-/Oberkante der gewählten Wände. */
export interface SelectionHeights {
  bottom: Common<string>;
  top: Common<string>;
}

/** Wandtyp/Dicke und Höhen: eine Abfrage je Wand. */
export function selectionWallHeights(project: Project, sel: Selection): SelectionHeights {
  const b: string[] = [];
  const t: string[] = [];
  for (const id of sel.walls.slice(0, MAX_COMPARED)) {
    const w = deriveSelection(project, { walls: [id] })?.wall;
    if (!w) continue;
    b.push(heightKey(w.bottom, w.zBottom));
    t.push(heightKey(w.top, w.zTop));
  }
  return { bottom: commonValue(b), top: commonValue(t) };
}

/** [195b] Typ, Dicke und Höhen der gewählten Decken. */
export interface SelectionCeilingValues extends SelectionHeights {
  typeId: Common<string>;
  thickness: Common<number>;
}

export function selectionCeilingValues(project: Project, sel: Selection): SelectionCeilingValues {
  const types: string[] = [];
  const thick: number[] = [];
  const b: string[] = [];
  const t: string[] = [];
  for (const id of sel.ceilings.slice(0, MAX_COMPARED)) {
    const c = deriveSelection(project, { ceilings: [id] })?.ceiling;
    if (!c) continue;
    types.push(c.typeId);
    thick.push(c.thickness);
    b.push(heightKey(c.bottom, c.zBottom));
    t.push(heightKey(c.top, c.zTop));
  }
  return { typeId: commonValue(types), thickness: commonValue(thick), bottom: commonValue(b), top: commonValue(t) };
}

/** [195b] Typ und Neigung der gewählten Dächer. */
export interface SelectionRoofValues {
  roofTypeId: Common<string>;
  pitchDeg: Common<number>;
}

export function selectionRoofValues(project: Project, sel: Selection): SelectionRoofValues {
  const types: string[] = [];
  const pitch: number[] = [];
  for (const id of sel.roofs.slice(0, MAX_COMPARED)) {
    const r = deriveSelection(project, { roofs: [id] })?.roof;
    if (!r) continue;
    types.push(r.roofTypeId ?? "");
    pitch.push(r.pitchDeg);
  }
  return { roofTypeId: commonValue(types), pitchDeg: commonValue(pitch) };
}

/** [195b] Breite, Höhe, Brüstung und Typ der gewählten Öffnungen. */
export interface SelectionOpeningValues {
  width: Common<number>;
  height: Common<number>;
  sillHeight: Common<number>;
  typeId: Common<string>;
}

export function selectionOpeningValues(project: Project, sel: Selection): SelectionOpeningValues {
  const w: number[] = [];
  const h: number[] = [];
  const s: number[] = [];
  const ty: string[] = [];
  for (const id of sel.openings.slice(0, MAX_COMPARED)) {
    const o = deriveSelection(project, { openings: [id] })?.opening;
    if (!o) continue;
    w.push(o.width);
    h.push(o.height);
    s.push(o.sillHeight);
    ty.push(o.typeId ?? "");
  }
  return { width: commonValue(w), height: commonValue(h), sillHeight: commonValue(s), typeId: commonValue(ty) };
}
