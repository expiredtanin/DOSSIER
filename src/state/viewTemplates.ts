// Ansichtsvorlagen ([34]) — reine Logik ohne React/Store.
//
// Eine Vorlage (`Project.viewTemplates`) bündelt Ansichts-Einstellungen. Sie wirkt auf
//  • Ansichten (Geschoss/Schnitt/Ansicht = `DrawingLevel`): Schnitthöhe, Ansichtsbereich, Schatten,
//    verdeckte Kanten stehen am Geschoss selbst; Detail, Massstab, Kategorien, Override-Regeln,
//    Darstellungsmodus und Schwarz-Weiss sind Anzeigezustand (`ViewTemplateUi`, App setzt sie), und
//  • Ausschnitte (`ViewSnapshot`): Detail, Massstab, Kategorien, Override-Regeln.
// „Einmal anwenden" kopiert die Werte und merkt nur die Vorlage (`templateLinked: false`);
// „verknüpft" (`templateLinked: true`) lässt Änderungen an der Vorlage durchschlagen
// (`patchTemplateOps` schreibt sie in einem Schritt in alle verknüpften Ansichten/Ausschnitte).
// Alles liefert Ops (`applyChange`); eine Änderung = ein Undo-Schritt.

import { addItems, findItem, itemsOf, patchItem, removeItems } from "../core";
import type { CoreOp } from "../core";
import type { DrawingLevel, Project, ViewSnapshot, ViewTemplate } from "../model/types";
import type { DetailLevel } from "../model/viewTypes";

/** Anzeigezustand, den Vorlagen zusätzlich steuern (liegt nicht am Geschoss). */
export interface ViewTemplateUi {
  detail: DetailLevel;
  scaleDenominator: number;
  /** Kategorie-`code` → sichtbar. */
  layerVisibility: Record<string, boolean>;
  enabledOverrideRuleIds: string[];
  displayMode: string;
  mono: boolean;
  /** Projekt-Option „Strichstärken mit dem Massstab skalieren". */
  scaleLineWeights: boolean;
}

/** Geschoss-Felder, die eine Vorlage setzt (fehlt das Vorlagen-Feld, bleibt die Ansicht unberührt). */
const LEVEL_KEYS = ["cutHeight", "viewTop", "viewBottom", "viewDepth", "shadows", "hiddenLines"] as const;

/** Teilobjekt für das Geschoss aus den gesetzten Feldern der Vorlage. */
export function levelPatch(t: ViewTemplate): Partial<DrawingLevel> {
  const out: Record<string, unknown> = {};
  for (const k of LEVEL_KEYS) if (t[k] !== undefined) out[k] = t[k];
  return out as Partial<DrawingLevel>;
}

/** Teilobjekt für einen Ausschnitt (Kategorien werden zusammengeführt, nicht ersetzt). */
export function snapshotPatch(t: ViewTemplate, s: ViewSnapshot): Partial<ViewSnapshot> {
  const out: Partial<ViewSnapshot> = {};
  if (t.detail !== undefined) out.detail = t.detail;
  if (t.scaleDenominator !== undefined) out.scaleDenominator = t.scaleDenominator;
  if (t.layerVisibility) out.layerVisibility = { ...s.layerVisibility, ...t.layerVisibility };
  if (t.enabledOverrideRuleIds) out.enabledOverrideRuleIds = [...t.enabledOverrideRuleIds];
  return out;
}

/** Neue Vorlage aus dem aktuellen Zustand einer Ansicht. */
export function captureTemplate(id: string, name: string, level: DrawingLevel | undefined, ui: ViewTemplateUi): ViewTemplate {
  const t: ViewTemplate = {
    id,
    name,
    detail: ui.detail,
    scaleDenominator: ui.scaleDenominator,
    layerVisibility: { ...ui.layerVisibility },
    enabledOverrideRuleIds: [...ui.enabledOverrideRuleIds],
    displayMode: ui.displayMode,
    mono: ui.mono,
    scaleLineWeights: ui.scaleLineWeights,
  };
  if (level) for (const k of LEVEL_KEYS) if (level[k] !== undefined) (t as unknown as Record<string, unknown>)[k] = level[k];
  return t;
}

/** Vorlage anlegen. */
export function addTemplateOps(t: ViewTemplate): CoreOp[] {
  return addItems("viewTemplates", [t]);
}

/** Vorlage duplizieren (Kopie ohne Verknüpfungen), direkt hinter dem Original. */
export function duplicateTemplateOps(p: Project, id: string, newId: string, name: string): CoreOp[] {
  const src = findItem(p, "viewTemplates", id);
  if (!src) return [];
  const list = itemsOf(p, "viewTemplates");
  const copy: ViewTemplate = JSON.parse(JSON.stringify({ ...src, id: newId, name }));
  return addItems("viewTemplates", [copy], list.findIndex((x) => x.id === id) + 1);
}

/** Löschen: Verknüpfungen lösen die Ansichten/Ausschnitte (deren Einstellungen bleiben, wie sie sind). */
export function deleteTemplateOps(p: Project, id: string): CoreOp[] {
  const unlink = <T extends { templateId?: string; templateLinked?: boolean }>(e: T): T => {
    if (e.templateId !== id) return e;
    const { templateId: _a, templateLinked: _b, ...rest } = e;
    return rest as T;
  };
  return [
    ...removeItems(p, "viewTemplates", [id]),
    ...itemsOf(p, "drawingLevels").flatMap((l) => patchItem(p, "drawingLevels", l.id, unlink)),
    ...itemsOf(p, "viewSnapshots").flatMap((s) => patchItem(p, "viewSnapshots", s.id, unlink)),
  ];
}

/** Ansicht (Geschoss/Schnitt/Ansicht) mit der Vorlage versehen: Werte übernehmen, Vorlage merken. */
export function applyToLevelOps(p: Project, templateId: string, levelId: string, linked: boolean): CoreOp[] {
  const t = findItem(p, "viewTemplates", templateId);
  if (!t) return [];
  return patchItem(p, "drawingLevels", levelId, { ...levelPatch(t), templateId, templateLinked: linked });
}

/** Ausschnitt mit der Vorlage versehen. */
export function applyToSnapshotOps(p: Project, templateId: string, snapshotId: string, linked: boolean): CoreOp[] {
  const t = findItem(p, "viewTemplates", templateId);
  const s = findItem(p, "viewSnapshots", snapshotId);
  if (!t || !s) return [];
  return patchItem(p, "viewSnapshots", snapshotId, { ...snapshotPatch(t, s), templateId, templateLinked: linked });
}

/** Vorlage ändern und in alle verknüpften Ansichten und Ausschnitte schreiben (ein Schritt). */
export function patchTemplateOps(p: Project, id: string, patch: Partial<ViewTemplate>): CoreOp[] {
  const old = findItem(p, "viewTemplates", id);
  if (!old) return [];
  const next: ViewTemplate = { ...old, ...patch };
  // Entfernte Felder (`undefined`) wirklich löschen, damit die Vorlage die Einstellung wieder freigibt.
  for (const k of Object.keys(next) as (keyof ViewTemplate)[]) if (next[k] === undefined) delete next[k];
  const ops = patchItem(p, "viewTemplates", id, () => next);
  for (const l of itemsOf(p, "drawingLevels")) {
    if (l.templateId === id && l.templateLinked) ops.push(...patchItem(p, "drawingLevels", l.id, levelPatch(next)));
  }
  for (const s of itemsOf(p, "viewSnapshots")) {
    if (s.templateId === id && s.templateLinked) ops.push(...patchItem(p, "viewSnapshots", s.id, snapshotPatch(next, s)));
  }
  return ops;
}

/** Die verknüpfte Vorlage einer Ansicht/eines Ausschnitts (nur bei `templateLinked`). */
export function linkedTemplate(p: Project, target: { templateId?: string; templateLinked?: boolean } | undefined): ViewTemplate | undefined {
  if (!target?.templateId || !target.templateLinked) return undefined;
  return findItem(p, "viewTemplates", target.templateId);
}

/** Anzeigezustand, den die Vorlage ändern würde (nur abweichende Felder; leer = nichts zu tun). */
export function uiPatch(t: ViewTemplate, cur: ViewTemplateUi): Partial<ViewTemplateUi> {
  const out: Partial<ViewTemplateUi> = {};
  if (t.detail !== undefined && t.detail !== cur.detail) out.detail = t.detail;
  if (t.scaleDenominator !== undefined && t.scaleDenominator !== cur.scaleDenominator) out.scaleDenominator = t.scaleDenominator;
  if (t.layerVisibility) {
    const diff: Record<string, boolean> = {};
    for (const [code, vis] of Object.entries(t.layerVisibility)) if (code in cur.layerVisibility && cur.layerVisibility[code] !== vis) diff[code] = vis;
    if (Object.keys(diff).length) out.layerVisibility = diff;
  }
  if (t.enabledOverrideRuleIds) {
    const a = [...t.enabledOverrideRuleIds].sort();
    const b = [...cur.enabledOverrideRuleIds].sort();
    if (a.length !== b.length || a.some((x, i) => x !== b[i])) out.enabledOverrideRuleIds = [...t.enabledOverrideRuleIds];
  }
  if (t.displayMode !== undefined && t.displayMode !== cur.displayMode) out.displayMode = t.displayMode;
  if (t.mono !== undefined && t.mono !== cur.mono) out.mono = t.mono;
  if (t.scaleLineWeights !== undefined && t.scaleLineWeights !== cur.scaleLineWeights) out.scaleLineWeights = t.scaleLineWeights;
  return out;
}
