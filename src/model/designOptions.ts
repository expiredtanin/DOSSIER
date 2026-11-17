// [272] Varianten (Archicad „Design Options“): Variantensätze mit Varianten, Elemente im Hauptmodell oder in genau einer
// Variante, je Ebene/Ausschnitt/Viewport eine Kombination. Was sichtbar ist, entscheidet der Kern (`renovation.rs`, ein Ort
// mit dem Umbaufilter; Modell und Ops in `design_options.rs`); hier nur, was die Oberfläche zum Lesen und Setzen braucht.

import type { CoreOp } from "../core/ops";
import { documentFor } from "../core/document";
import { patchItem, setField } from "../core/opsBuild";
import type { DesignOption, DesignOptionRef, DesignOptionSet, DrawingLevel, Project } from "./types";

/** Listen, deren Elemente einer Variante angehören können (gleich wie `design_options::COLLECTIONS`). */
export const DESIGN_OPTION_COLLECTIONS = ["walls", "openings", "ceilings", "roofs", "stairs", "columns", "extrudedSolids", "rooms", "drawings2d"] as const;
export type DesignOptionCollection = (typeof DESIGN_OPTION_COLLECTIONS)[number];

/** Kombination: Satz-Id → Varianten-Id. */
export type Combination = Record<string, string>;

/** Variantensätze des Projekts. */
export function designOptionSets(project: Project): readonly DesignOptionSet[] {
  return project.designOptionSets ?? [];
}

/** Hauptvariante eines Satzes (`primary`, sonst die erste). */
export function primaryOption(s: DesignOptionSet): string | undefined {
  return s.primary && s.options.some((o) => o.id === s.primary) ? s.primary : s.options[0]?.id;
}

/** Wirksame Kombination: Hauptvarianten, darüber die gespeicherten Wahlen (spätere gehen vor; unbekannte übergangen). */
export function resolveCombination(project: Project, ...stored: (Combination | undefined | null)[]): Combination {
  const out: Combination = {};
  for (const s of designOptionSets(project)) {
    const p = primaryOption(s);
    if (p) out[s.id] = p;
  }
  for (const m of stored) {
    for (const [k, v] of Object.entries(m ?? {})) {
      const s = designOptionSets(project).find((x) => x.id === k);
      if (s?.options.some((o) => o.id === v)) out[k] = v;
    }
  }
  return out;
}

/** Kombination einer Ebene (`DrawingLevel.designOptions` über den Hauptvarianten). */
export function levelCombination(project: Project, level: DrawingLevel | undefined): Combination {
  return resolveCombination(project, level?.designOptions);
}

/** Lesbarer Name „Dachform B, Fassade A“ (nur Sätze mit Varianten). */
export function combinationLabel(project: Project, c: Combination): string {
  const parts: string[] = [];
  for (const s of designOptionSets(project)) {
    const o = s.options.find((x) => x.id === c[s.id]);
    if (o) parts.push(`${s.name} ${o.name}`.trim());
  }
  return parts.join(", ");
}

/** Kurzname nur der Varianten, die von der Hauptvariante abweichen (Titelzusatz im Blatt); leer = Hauptkombination. */
export function combinationSuffix(project: Project, c: Combination | undefined | null): string {
  if (!c) return "";
  const full = resolveCombination(project, c);
  const prim = resolveCombination(project);
  const diff: Combination = {};
  for (const [k, v] of Object.entries(full)) if (prim[k] !== v) diff[k] = v;
  return combinationLabel(project, diff);
}

/** Text „Satz=Variante,…“ (Namen) einer Kombination — Format der CLI `--options`. */
export function combinationSpec(project: Project, c: Combination): string {
  const parts: string[] = [];
  for (const s of designOptionSets(project)) {
    const o = s.options.find((x) => x.id === c[s.id]);
    if (o) parts.push(`${s.name}=${o.name}`);
  }
  return parts.join(",");
}

/** Liest „Dachform=B,Fassade=A“ (Ids oder Namen, ohne Gross-/Kleinschreibung); Unbekanntes übergangen. */
export function parseCombination(project: Project, spec: string): Combination {
  const out: Combination = {};
  for (const part of spec.split(/[,;]/)) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    const k = part.slice(0, i).trim().toLowerCase();
    const v = part.slice(i + 1).trim().toLowerCase();
    const s = designOptionSets(project).find((x) => x.id.toLowerCase() === k || x.name.trim().toLowerCase() === k);
    const o = s?.options.find((x) => x.id.toLowerCase() === v || x.name.trim().toLowerCase() === v);
    if (s && o) out[s.id] = o.id;
  }
  return out;
}

/** Erscheint ein Element mit dieser Zugehörigkeit in der Kombination? (Gleiche Regel wie `Combination::shows` im Kern.) */
export function showsInCombination(c: Combination, r: DesignOptionRef | undefined | null): boolean {
  if (!r) return true;
  const chosen = c[r.set];
  return chosen === undefined || chosen === r.option;
}

/** Name „Dachform: B“ einer Zugehörigkeit; leer = Hauptmodell. */
export function designOptionLabel(project: Project, r: DesignOptionRef | undefined | null): string {
  if (!r) return "";
  const s = designOptionSets(project).find((x) => x.id === r.set);
  const o = s?.options.find((x) => x.id === r.option);
  return s && o ? `${s.name}: ${o.name}` : "";
}

/** Auswahl je Liste (ids), wie der Kern sie für Zuweisen/Kopieren nimmt. */
export function designOptionSelection(project: Project, ids: Iterable<string>): Record<string, string[]> {
  const set = new Set(ids);
  const out: Record<string, string[]> = {};
  for (const c of DESIGN_OPTION_COLLECTIONS) {
    const hit = ((project[c] ?? []) as { id: string }[]).filter((e) => set.has(e.id)).map((e) => e.id);
    if (hit.length) out[c] = hit;
  }
  return out;
}

/** Ids der Auswahl, die einer Variante angehören können. */
export function designOptionIds(project: Project, ids: Iterable<string>): string[] {
  return Object.values(designOptionSelection(project, ids)).flat();
}

/** Gemeinsame Zugehörigkeit der Elemente `ids` als `"set/option"` (`""` = Hauptmodell, `"mixed"`, `null` ohne Elemente). */
export function commonDesignOption(project: Project, ids: Iterable<string>): string | "mixed" | null {
  const set = new Set(ids);
  let out: string | null = null;
  for (const c of DESIGN_OPTION_COLLECTIONS) {
    for (const e of (project[c] ?? []) as { id: string; designOption?: DesignOptionRef }[]) {
      if (!set.has(e.id)) continue;
      const k = e.designOption ? `${e.designOption.set}/${e.designOption.option}` : "";
      if (out === null) out = k;
      else if (out !== k) return "mixed";
    }
  }
  return out;
}

/** Ziel aus `"set/option"` (`""` = Hauptmodell). */
export function parseTarget(key: string): { set: string; option: string } | null {
  const i = key.indexOf("/");
  return i > 0 ? { set: key.slice(0, i), option: key.slice(i + 1) } : null;
}

/** Alle Ziele „Satz: Variante“ für Auswahllisten (`key` = `"set/option"`). */
export function designOptionTargets(project: Project): { key: string; label: string }[] {
  const out: { key: string; label: string }[] = [];
  for (const s of designOptionSets(project)) for (const o of s.options) out.push({ key: `${s.id}/${o.id}`, label: `${s.name}: ${o.name}` });
  return out;
}

// ── Ops ─────────────────────────────────────────────────────────────────────

/** Ops: Variante zuweisen (`null` = Hauptmodell) für die Auswahl (Kern `design_options::assign_ops`; ein Undo-Schritt). */
export function assignDesignOptionOps(project: Project, ids: Iterable<string>, target: { set: string; option: string } | null): CoreOp[] {
  const sel = designOptionSelection(project, ids);
  if (!Object.keys(sel).length) return [];
  return documentFor(project).queryRoot<CoreOp[]>("designOptionAssignOps", JSON.stringify({ ...(target ?? {}), sel }));
}

/** Ops: Kopien der Auswahl in die Variante (`null` = Hauptmodell); Öffnungen gewählter Wände wandern mit. */
export function copyToDesignOptionOps(project: Project, ids: Iterable<string>, target: { set: string; option: string } | null, stamp = `v${Date.now().toString(36)}`): CoreOp[] {
  const sel = designOptionSelection(project, ids);
  if (!Object.keys(sel).length) return [];
  return documentFor(project).queryRoot<CoreOp[]>("designOptionCopyOps", JSON.stringify({ ...(target ?? {}), sel, stamp }));
}

/** Ops: „Variante übernehmen“ — ihre Elemente ins Hauptmodell, die übrigen Varianten des Satzes gelöscht, Satz weg. */
export function acceptDesignOptionOps(project: Project, set: string, option: string): CoreOp[] {
  return documentFor(project).queryRoot<CoreOp[]>("designOptionAcceptOps", JSON.stringify({ set, option }));
}

/** Ops: Satz (ohne `option`) bzw. Variante löschen samt ihren Elementen. */
export function deleteDesignOptionOps(project: Project, set: string, option?: string): CoreOp[] {
  return documentFor(project).queryRoot<CoreOp[]>("designOptionDeleteOps", JSON.stringify(option ? { set, option } : { set }));
}

/** Nächste freie Id mit Präfix. */
function freeId(used: Iterable<string>, prefix: string): string {
  const u = new Set(used);
  let i = u.size + 1;
  while (u.has(`${prefix}${i}`)) i++;
  return `${prefix}${i}`;
}

/** Variantenname „A“, „B“, … (nächster freier Buchstabe). */
export function nextOptionName(s: DesignOptionSet | undefined): string {
  const used = new Set((s?.options ?? []).map((o) => o.name.trim().toUpperCase()));
  for (let i = 0; i < 26; i++) {
    const n = String.fromCharCode(65 + i);
    if (!used.has(n)) return n;
  }
  return String((s?.options.length ?? 0) + 1);
}

/** Ops: neuer Satz `name` mit den Varianten A und B (A = Hauptvariante). Gibt auch die neue Satz-Id zurück. */
export function addDesignOptionSetOps(project: Project, name: string): { ops: CoreOp[]; id: string } {
  const sets = designOptionSets(project);
  const id = freeId(sets.map((s) => s.id), "satz-");
  const options: DesignOption[] = [
    { id: "a", name: "A" },
    { id: "b", name: "B" },
  ];
  return { ops: [setField("designOptionSets", [...sets, { id, name: name.trim() || id, options, primary: "a" }])], id };
}

/** Ops: weitere Variante im Satz (nächster Buchstabe). */
export function addDesignOptionOps(project: Project, setId: string): CoreOp[] {
  const sets = designOptionSets(project);
  const s = sets.find((x) => x.id === setId);
  if (!s) return [];
  const name = nextOptionName(s);
  const id = freeId(s.options.map((o) => o.id), "v");
  return [setField("designOptionSets", sets.map((x) => (x.id === setId ? { ...x, options: [...x.options, { id, name }] } : x)))];
}

/** Ops: Satz bzw. Variante umbenennen, Hauptvariante setzen. */
export function renameDesignOptionSetOps(project: Project, setId: string, name: string): CoreOp[] {
  const sets = designOptionSets(project);
  if (!sets.some((s) => s.id === setId)) return [];
  return [setField("designOptionSets", sets.map((s) => (s.id === setId ? { ...s, name } : s)))];
}

export function renameDesignOptionOps(project: Project, setId: string, optionId: string, name: string): CoreOp[] {
  const sets = designOptionSets(project);
  if (!sets.some((s) => s.id === setId && s.options.some((o) => o.id === optionId))) return [];
  return [setField("designOptionSets", sets.map((s) => (s.id === setId ? { ...s, options: s.options.map((o) => (o.id === optionId ? { ...o, name } : o)) } : s)))];
}

export function setPrimaryOptionOps(project: Project, setId: string, optionId: string): CoreOp[] {
  const sets = designOptionSets(project);
  if (!sets.some((s) => s.id === setId && s.options.some((o) => o.id === optionId))) return [];
  return [setField("designOptionSets", sets.map((s) => (s.id === setId ? { ...s, primary: optionId } : s)))];
}

/** Ops: Kombination der Ebene setzen (eine Variante je Satz; die Hauptvariante wird nicht gespeichert). */
export function setLevelCombinationOps(project: Project, levelId: string, setId: string, optionId: string): CoreOp[] {
  const s = designOptionSets(project).find((x) => x.id === setId);
  if (!s || !s.options.some((o) => o.id === optionId)) return [];
  return patchItem(project, "drawingLevels", levelId, (l) => {
    const m: Combination = { ...(l.designOptions ?? {}) };
    if (primaryOption(s) === optionId) delete m[setId];
    else m[setId] = optionId;
    const next = { ...l, designOptions: m };
    if (!Object.keys(m).length) delete (next as { designOptions?: Combination }).designOptions;
    return next;
  });
}

// ── Vergleich ───────────────────────────────────────────────────────────────

/** Zeile der Vergleichstabelle (Kern `design_options::CompareRow`). */
export interface DesignOptionCompareRow {
  choice: Combination;
  label: string;
  primary: boolean;
  gf: number;
  hnf: number;
  gv: number;
  footprint: number;
  az?: number | null;
  uez?: number | null;
  cost: number;
}

/** Kennzahlen und Kosten je Kombination (Hauptkombination zuerst); `renovation`: Umbau-Zustand (Filter-Id). */
export function compareDesignOptions(project: Project, renovation = ""): DesignOptionCompareRow[] {
  if (!designOptionSets(project).length) return [];
  return documentFor(project).query<DesignOptionCompareRow[]>("designOptionCompare", [], renovation ? JSON.stringify({ renovation }) : "");
}

/** Vergleich als CSV (Semikolon) mit den Spaltenköpfen `head` (übersetzt). */
export function compareDesignOptionsCsv(project: Project, head: readonly string[], renovation = ""): string {
  if (!designOptionSets(project).length) return "";
  return documentFor(project).query<string>("designOptionCompare", [], JSON.stringify(renovation ? { renovation, head } : { head }));
}

/**
 * Das Projekt so, dass die Kombination `c` überall gilt (CLI `--options`): die gewählten Varianten werden Hauptvarianten,
 * gespeicherte Wahlen dieser Sätze an Ebenen, Vorlagen, Ausschnitten und Viewports entfallen. Kein Op (Kopie für Exporte).
 */
export function projectWithCombination(project: Project, c: Combination): Project {
  const keys = Object.keys(c);
  if (!keys.length) return project;
  const strip = <T extends { designOptions?: Combination | null }>(x: T): T => {
    if (!x.designOptions || !keys.some((k) => k in x.designOptions!)) return x;
    const m = { ...x.designOptions };
    for (const k of keys) delete m[k];
    const next = { ...x, designOptions: m };
    if (!Object.keys(m).length) delete (next as { designOptions?: Combination | null }).designOptions;
    return next;
  };
  return {
    ...project,
    designOptionSets: designOptionSets(project).map((s) => (c[s.id] && s.options.some((o) => o.id === c[s.id]) ? { ...s, primary: c[s.id] } : s)),
    drawingLevels: project.drawingLevels.map(strip),
    ...(project.viewTemplates ? { viewTemplates: project.viewTemplates.map(strip) } : {}),
    ...(project.viewSnapshots ? { viewSnapshots: project.viewSnapshots.map(strip) } : {}),
    ...(project.layouts ? { layouts: project.layouts.map((l) => ({ ...l, viewports: l.viewports.map(strip) })) } : {}),
  };
}
