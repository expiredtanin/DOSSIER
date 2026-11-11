// [173] Modelldarstellung (≙ Archicad „Modelldarstellung") — reine Logik ohne React/Store.
//
// Eine Modelldarstellung (`Project.modelViewOptions`) ist eine benannte Stufe über einem Basis-Detailgrad,
// mit Optionen je Bauteilart (Türen, Fenster, Treppen, Wände, Decken/Böden, Dächer, Stützen, Ansicht,
// Gelände, Raumstempel, Bemassung; Grundriss, Schnitt, Ansicht und 3D). Jede Option fehlt ⇒
// „wie Basis". Die Stufen „grob", „mittel", „fein" sind eingebaut (nicht in der Liste, nicht änderbar).
// Die Ansicht wählt ihre Modelldarstellung über das Feld `modelViewOptionId` der Ebene (Werkzeugleiste,
// Ansichtsvorlage); Ausschnitte tragen ein eigenes Feld (Blatt-Viewports). Mitgelieferte Vorlagen (Wettbewerb,
// Baueingabe, Ausführung, Rohbau) kommen aus den Standards des Kerns (`standardModelViews`, `adoptModelViewOps`). Rangfolge und Auflösung: Kern
// `plan/model_view.rs`. Alles liefert Ops (`applyChange`); eine Änderung = ein Undo-Schritt.

import { addItems, findItem, itemsOf, patchItem, removeItems } from "../core";
import type { CoreOp } from "../core";
import type { DrawingLevel, ModelViewOption, Project } from "../model/types";
import type { DetailLevel } from "../model/viewTypes";

/** Ids der eingebauten Stufen (= Detailgrade). */
export const BUILTIN_MODEL_VIEWS = ["grob", "mittel", "fein"] as const satisfies readonly DetailLevel[];

export function isBuiltinModelView(id: string | undefined | null): id is DetailLevel {
  return id === "grob" || id === "mittel" || id === "fein";
}

/** Abschnitte je Bauteilart. */
export type ModelViewSection =
  | "doors"
  | "windows"
  | "stairs"
  | "walls"
  | "slabs"
  | "roofs"
  | "columns"
  | "elevation"
  | "site"
  | "sectionMarks"
  | "roomStamps"
  | "dimensions";

/** Ein Eintrag der Auswahl (Werkzeugleiste, Vorlage): eingebaute Stufen zuerst, dann die eigenen. */
export interface ModelViewChoice {
  id: string;
  /** Eigener Name; eingebaute Stufen haben stattdessen `builtin` (Anzeige über `t("topbar.detail.<id>")`). */
  name?: string;
  builtin?: DetailLevel;
}

export function modelViewChoices(list: readonly ModelViewOption[] | undefined): ModelViewChoice[] {
  return [...BUILTIN_MODEL_VIEWS.map((id) => ({ id, builtin: id })), ...(list ?? []).map((m) => ({ id: m.id, name: m.name }))];
}

/**
 * Gewählte Stufe einer Ansicht: das Feld der Ebene (eingebaut oder vorhandene eigene), sonst der Detailgrad.
 * Eine Ebene, deren Stufe gelöscht wurde, zeigt wieder den Detailgrad.
 */
export function currentModelViewId(level: Pick<DrawingLevel, "modelViewOptionId"> | undefined, detail: DetailLevel, list: readonly ModelViewOption[] | undefined): string {
  const id = level?.modelViewOptionId;
  if (isBuiltinModelView(id)) return id;
  if (id && (list ?? []).some((m) => m.id === id)) return id;
  return detail;
}

/** Basis-Detailgrad einer Stufe (eingebaut: sie selbst; eigen: `baseDetail`, fehlt = `undefined`). */
export function modelViewBase(p: Pick<Project, "modelViewOptions">, id: string): DetailLevel | undefined {
  if (isBuiltinModelView(id)) return id;
  return (p.modelViewOptions ?? []).find((m) => m.id === id)?.baseDetail;
}

function withoutModelView<T extends { modelViewOptionId?: string }>(e: T): T {
  if (e.modelViewOptionId === undefined) return e;
  const { modelViewOptionId: _drop, ...rest } = e;
  return rest as T;
}

/**
 * Stufe für die Ansicht `levelId` wählen (Werkzeugleiste): eine eigene Stufe steht an der Ebene, eine
 * eingebaute entfernt das Feld (dann gilt der Detailgrad der Anzeige, den der Aufrufer mitsetzt).
 */
export function selectModelViewOps(p: Project, levelId: string, id: string): CoreOp[] {
  if (isBuiltinModelView(id)) return patchItem(p, "drawingLevels", levelId, withoutModelView);
  if (!findItem(p, "modelViewOptions", id)) return [];
  return patchItem(p, "drawingLevels", levelId, { modelViewOptionId: id });
}

/** Neue eigene Stufe über einer Basis (alle Optionen „wie Basis"). */
export function newModelView(id: string, name: string, baseDetail: DetailLevel = "mittel"): ModelViewOption {
  return { id, name, baseDetail };
}

export function addModelViewOps(mv: ModelViewOption): CoreOp[] {
  return addItems("modelViewOptions", [mv]);
}

/**
 * Vorlage aus der Bibliothek (`standardModelViews`) ins Projekt übernehmen: mit ihrer Standard-Kennung, damit
 * „Standards aktualisieren" sie später abgleicht; schon vorhanden (gleiche id) ⇒ keine Ops.
 */
export function adoptModelViewOps(p: Project, mv: ModelViewOption): CoreOp[] {
  if (findItem(p, "modelViewOptions", mv.id)) return [];
  return addModelViewOps(JSON.parse(JSON.stringify(mv)) as ModelViewOption);
}

/** Kopie direkt hinter dem Original; eine eingebaute Stufe wird zur eigenen mit ihrer Basis. */
export function duplicateModelViewOps(p: Project, id: string, newId: string, name: string): CoreOp[] {
  if (isBuiltinModelView(id)) return addModelViewOps(newModelView(newId, name, id));
  const src = findItem(p, "modelViewOptions", id);
  if (!src) return [];
  const list = itemsOf(p, "modelViewOptions");
  const copy: ModelViewOption = JSON.parse(JSON.stringify({ ...src, id: newId, name }));
  return addItems("modelViewOptions", [copy], list.findIndex((x) => x.id === id) + 1);
}

export function renameModelViewOps(p: Project, id: string, name: string): CoreOp[] {
  return patchItem(p, "modelViewOptions", id, { name });
}

/** Löschen: Ebenen, Vorlagen und Ausschnitte, die die Stufe wählen, fallen auf den Detailgrad zurück. */
export function deleteModelViewOps(p: Project, id: string): CoreOp[] {
  const unlink = <T extends { modelViewOptionId?: string }>(e: T): T => (e.modelViewOptionId === id ? withoutModelView(e) : e);
  return [
    ...removeItems(p, "modelViewOptions", [id]),
    ...itemsOf(p, "drawingLevels").flatMap((l) => patchItem(p, "drawingLevels", l.id, unlink)),
    ...itemsOf(p, "viewTemplates").flatMap((t) => patchItem(p, "viewTemplates", t.id, unlink)),
    ...itemsOf(p, "viewSnapshots").flatMap((s) => patchItem(p, "viewSnapshots", s.id, unlink)),
  ];
}

/** Basis-Detailgrad setzen (`undefined` = Detailgrad der Ansicht). */
export function setModelViewBaseOps(p: Project, id: string, base: DetailLevel | undefined): CoreOp[] {
  return patchItem(p, "modelViewOptions", id, (m) => {
    const next = { ...m, baseDetail: base };
    if (base === undefined) delete next.baseDetail;
    return next;
  });
}

/**
 * Eine Option eines Abschnitts setzen; `undefined` = „wie Basis" (Feld entfernt, ein leerer Abschnitt
 * verschwindet ganz — die Datei bleibt so klein wie möglich).
 */
export function setModelViewOptionOps(p: Project, id: string, section: ModelViewSection, key: string, value: unknown): CoreOp[] {
  return patchItem(p, "modelViewOptions", id, (m) => {
    const sec: Record<string, unknown> = { ...((m[section] as Record<string, unknown> | undefined) ?? {}) };
    if (value === undefined) delete sec[key];
    else sec[key] = value;
    const next: Record<string, unknown> = { ...m };
    if (Object.keys(sec).length) next[section] = sec;
    else delete next[section];
    return next as unknown as ModelViewOption;
  });
}

/** Wert einer Option (fehlt = „wie Basis"). */
export function modelViewOption(m: ModelViewOption, section: ModelViewSection, key: string): unknown {
  return (m[section] as Record<string, unknown> | undefined)?.[key];
}

/** Auswahlfelder je Abschnitt (Ressourcen-Tab): Schlüssel und Werte (bool ⇒ an/aus). */
export interface ModelViewField {
  section: ModelViewSection;
  key: string;
  /** Werte als Liste (Auswahl) oder `"bool"`/`"number"`. */
  values: readonly (string | number)[] | "bool" | "number";
}

export const MODEL_VIEW_FIELDS: readonly ModelViewField[] = [
  { section: "doors", key: "lintelLineStyle", values: ["gestrichelt", "punktiert", "durchgehend", "keine"] },
  { section: "doors", key: "swingAngle", values: [90, 60, 45, 30] },
  { section: "doors", key: "swingArc", values: "bool" },
  { section: "doors", key: "frame", values: "bool" },
  { section: "doors", key: "leaf", values: ["line", "rect"] },
  { section: "doors", key: "threshold", values: ["off", "liftSlide", "all"] },
  { section: "doors", key: "sectionDetail", values: "bool" },
  { section: "windows", key: "sashSymbols", values: "bool" },
  { section: "windows", key: "planSwingArcs", values: "bool" },
  { section: "windows", key: "sill", values: "bool" },
  { section: "windows", key: "sashFrames", values: "bool" },
  { section: "windows", key: "simplified", values: "bool" },
  { section: "windows", key: "shadingBox", values: "bool" },
  { section: "windows", key: "lintelLine", values: "bool" },
  { section: "windows", key: "sectionDetail", values: "bool" },
  { section: "windows", key: "elevationDivision", values: "bool" },
  { section: "stairs", key: "walkLine", values: "bool" },
  { section: "stairs", key: "arrow", values: "bool" },
  { section: "stairs", key: "breakLine", values: "bool" },
  { section: "stairs", key: "aboveCut", values: ["dashed", "off"] },
  { section: "stairs", key: "handrail", values: ["off", "single", "double"] },
  { section: "stairs", key: "sectionBeyond", values: "bool" },
  { section: "stairs", key: "runStartMm", values: [0, 1, 2, 3, 5] },
  { section: "stairs", key: "runEndMm", values: [0, 1, 2, 3, 5] },
  { section: "stairs", key: "startMark", values: "bool" },
  { section: "stairs", key: "stepNumbers", values: "bool" },
  { section: "walls", key: "layers", values: ["all", "simplified", "core"] },
  { section: "walls", key: "thinLayerMm", values: [0.25, 0.5, 0.75, 1] },
  { section: "walls", key: "reveals", values: "bool" },
  { section: "walls", key: "cutHatch", values: "bool" },
  { section: "slabs", key: "floorFinish", values: ["off", "wet", "all"] },
  { section: "slabs", key: "layers", values: ["all", "simplified", "core"] },
  { section: "slabs", key: "buildUp", values: ["show", "merged"] },
  { section: "slabs", key: "outline", values: "bool" },
  { section: "slabs", key: "viewHatch", values: "bool" },
  { section: "roofs", key: "layers", values: ["all", "simplified", "core"] },
  { section: "roofs", key: "overhead", values: "bool" },
  { section: "roofs", key: "viewHatch", values: "bool" },
  { section: "columns", key: "cutFill", values: ["material", "solid", "empty"] },
  { section: "elevation", key: "shadows", values: "bool" },
  { section: "elevation", key: "materialHatch", values: "bool" },
  { section: "site", key: "terrain", values: "bool" },
  { section: "sectionMarks", key: "style", values: ["arrow", "lAngle"] },
  { section: "roomStamps", key: "number", values: "bool" },
  { section: "roomStamps", key: "area", values: "bool" },
  { section: "roomStamps", key: "usage", values: "bool" },
  { section: "roomStamps", key: "height", values: "bool" },
  { section: "roomStamps", key: "finish", values: "bool" },
  { section: "roomStamps", key: "divider", values: "bool" },
  { section: "dimensions", key: "chains", values: ["all", "outer", "total"] },
  { section: "dimensions", key: "levelMarks", values: "bool" },
];

/** Auswahlwert eines Feldes als Text (`""` = wie Basis); Gegenstück: {@link parseFieldValue}. */
export function fieldValue(m: ModelViewOption, f: ModelViewField): string {
  const v = modelViewOption(m, f.section, f.key);
  return v === undefined || v === null ? "" : String(v);
}

export function parseFieldValue(f: ModelViewField, s: string): unknown {
  if (s === "") return undefined;
  if (f.values === "bool") return s === "true";
  if (f.values === "number" || (Array.isArray(f.values) && typeof f.values[0] === "number")) {
    const n = Number(s);
    return Number.isFinite(n) ? n : undefined;
  }
  return s;
}

/** Name einer Stufe, eindeutig in der Liste (`base`, `base 2`, …). */
export function uniqueModelViewName(list: readonly ModelViewOption[] | undefined, base: string): string {
  const names = new Set((list ?? []).map((m) => m.name));
  if (!names.has(base)) return base;
  for (let k = 2; ; k++) if (!names.has(`${base} ${k}`)) return `${base} ${k}`;
}
