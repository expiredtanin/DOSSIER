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
  return ELEMENT_KINDS.filter((k) => k !== "sectionLines" && k !== "site" && k !== "trees" && k !== "cameras").reduce((n, k) => n + sel[k].length, 0);
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
  /** Referenzlinie samt freiem Fugen-Versatz. */
  referenceLine: Common<string>;
}

export function selectionWallValues(project: Project, sel: Selection): SelectionWallValues {
  const types: string[] = [];
  const thick: number[] = [];
  const refs: string[] = [];
  for (const id of sel.walls.slice(0, MAX_COMPARED)) {
    const wall = deriveSelection(project, { walls: [id] })?.wall;
    if (!wall) continue;
    types.push(wall.wallTypeId);
    thick.push(wall.thickness);
    refs.push(`${wall.referenceLine}|${wall.referenceOffset ?? ""}`);
  }
  return { wallTypeId: commonValue(types), thickness: commonValue(thick), referenceLine: commonValue(refs) };
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

/** [195b] Dach-Felder der gewählten Dächer (alle ausser Umriss, Kanten, Gauben und Höfen, die je Dach eigen sind). */
export interface SelectionRoofValues {
  roofTypeId: Common<string>;
  pitchDeg: Common<number>;
  shape: Common<string>;
  ridgeAxis: Common<string>;
  pitchUpperDeg: Common<number>;
  mansardType: Common<string>;
  mansardKneeRatio: Common<number>;
  halfHipRatio: Common<number>;
  overhang: Common<number>;
  overhangGable: Common<number>;
  parapetHeight: Common<number>;
  parapetWidth: Common<number>;
  parapetComponentId: Common<string>;
  thickness: Common<number>;
  baseElevation: Common<number>;
}

export function selectionRoofValues(project: Project, sel: Selection): SelectionRoofValues {
  const v = {
    roofTypeId: [] as string[], pitchDeg: [] as number[], shape: [] as string[], ridgeAxis: [] as string[],
    pitchUpperDeg: [] as number[], mansardType: [] as string[], mansardKneeRatio: [] as number[], halfHipRatio: [] as number[],
    overhang: [] as number[], overhangGable: [] as number[], parapetHeight: [] as number[], parapetWidth: [] as number[],
    parapetComponentId: [] as string[], thickness: [] as number[], baseElevation: [] as number[],
  };
  for (const id of sel.roofs.slice(0, MAX_COMPARED)) {
    const r = deriveSelection(project, { roofs: [id] })?.roof;
    if (!r) continue;
    v.roofTypeId.push(r.roofTypeId ?? "");
    v.pitchDeg.push(r.pitchDeg);
    v.shape.push(r.shape);
    v.ridgeAxis.push(r.ridgeAxis);
    // Vorgaben wie in der Anzeige (RoofSection), damit „gleich angezeigt" auch „gleich" heisst.
    v.pitchUpperDeg.push(r.pitchUpperDeg ?? r.pitchDeg / 2);
    v.mansardType.push(r.mansardType ?? "giebel");
    v.mansardKneeRatio.push(r.mansardKneeRatio ?? 0.4);
    v.halfHipRatio.push(r.halfHipRatio ?? 0);
    v.overhang.push(r.overhang);
    v.overhangGable.push(r.overhangGable ?? r.overhang);
    v.parapetHeight.push(r.parapetHeight ?? 0);
    v.parapetWidth.push(r.parapetWidth ?? 0.2);
    v.parapetComponentId.push(r.parapetComponentId ?? "");
    v.thickness.push(r.thickness);
    v.baseElevation.push(r.baseElevation);
  }
  return Object.fromEntries(Object.entries(v).map(([k, a]) => [k, commonValue(a as (string | number)[])])) as unknown as SelectionRoofValues;
}

/** [195b] Breite, Höhe, Brüstung und Typ der gewählten Öffnungen. */
export interface SelectionOpeningValues {
  width: Common<number>;
  height: Common<number>;
  sillHeight: Common<number>;
  typeId: Common<string>;
  /** Tür: Anschlag, Aufschlag, Richtung; Fenster: Flügelzahl. */
  hinge: Common<string>;
  swing: Common<string>;
  openingDir: Common<string>;
  wingCount: Common<number>;
}

export function selectionOpeningValues(project: Project, sel: Selection): SelectionOpeningValues {
  const w: number[] = [];
  const h: number[] = [];
  const s: number[] = [];
  const ty: string[] = [];
  const hinge: string[] = [];
  const swing: string[] = [];
  const dir: string[] = [];
  const wings: number[] = [];
  for (const id of sel.openings.slice(0, MAX_COMPARED)) {
    const o = deriveSelection(project, { openings: [id] })?.opening;
    if (!o) continue;
    w.push(o.width);
    h.push(o.height);
    s.push(o.sillHeight);
    ty.push(o.typeId ?? "");
    hinge.push(o.hinge ?? "");
    swing.push(o.swing ?? "");
    dir.push(o.openingDir ?? "");
    wings.push(o.wingCount ?? 1);
  }
  return {
    width: commonValue(w),
    height: commonValue(h),
    sillHeight: commonValue(s),
    typeId: commonValue(ty),
    hinge: commonValue(hinge),
    swing: commonValue(swing),
    openingDir: commonValue(dir),
    wingCount: commonValue(wings),
  };
}

/** [195b] Form, Breite, Stufenzahl, Steighöhe und Typ der gewählten Treppen. */
export interface SelectionStairValues {
  shape: Common<string>;
  width: Common<number>;
  stepCount: Common<number>;
  totalRise: Common<number>;
  typeId: Common<string>;
}

export function selectionStairValues(project: Project, sel: Selection): SelectionStairValues {
  const shape: string[] = [];
  const width: number[] = [];
  const steps: number[] = [];
  const rise: number[] = [];
  const ty: string[] = [];
  for (const id of sel.stairs.slice(0, MAX_COMPARED)) {
    const st = deriveSelection(project, { stairs: [id] })?.stair;
    if (!st) continue;
    shape.push(st.shape);
    width.push(st.width);
    steps.push(st.stepCount);
    rise.push(st.totalRise);
    ty.push(st.typeId ?? "");
  }
  return { shape: commonValue(shape), width: commonValue(width), stepCount: commonValue(steps), totalRise: commonValue(rise), typeId: commonValue(ty) };
}

/** [195b] SIA-Kategorie der gewählten Räume (der Name bleibt je Raum eigen und wird nicht für alle gesetzt). */
export interface SelectionRoomValues {
  siaCategory: Common<string>;
}

export function selectionRoomValues(project: Project, sel: Selection): SelectionRoomValues {
  const sia: string[] = [];
  for (const id of sel.rooms.slice(0, MAX_COMPARED)) {
    const r = deriveSelection(project, { rooms: [id] })?.room;
    if (r) sia.push(r.siaCategory);
  }
  return { siaCategory: commonValue(sia) };
}

/** [195b] Höhe der gewählten Stützen bzw. Körper (Extrusionshöhe). */
export interface SelectionHeightValue {
  height: Common<number>;
}

export function selectionColumnValues(project: Project, sel: Selection): SelectionHeightValue {
  const h: number[] = [];
  for (const id of sel.columns.slice(0, MAX_COMPARED)) {
    const c = deriveSelection(project, { columns: [id] })?.column;
    if (c) h.push(c.height);
  }
  return { height: commonValue(h) };
}

export function selectionSolidValues(project: Project, sel: Selection): SelectionHeightValue {
  const h: number[] = [];
  for (const id of sel.solids.slice(0, MAX_COMPARED)) {
    const c = deriveSelection(project, { solids: [id] })?.extrudedSolid;
    if (c) h.push(c.height);
  }
  return { height: commonValue(h) };
}
