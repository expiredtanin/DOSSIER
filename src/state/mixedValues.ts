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
