// [272] Varianten (Archicad „Design Options“): Variantensätze mit Varianten, Elemente im Hauptmodell oder in genau einer
// Variante, je Ebene/Ausschnitt/Viewport eine Kombination. Was sichtbar ist, entscheidet der Kern (`renovation.rs`, ein Ort
// mit dem Umbaufilter; Modell und Ops in `design_options.rs`); hier nur, was die Oberfläche zum Lesen und Setzen braucht.

import type { CoreOp } from "../core/ops";
import { documentFor } from "../core/document";
import { patchItem, setField } from "../core/opsBuild";
import type { DesignOption, DesignOptionCombination, DesignOptionRef, DesignOptionSet, DrawingLevel, Project } from "./types";

/** Listen, deren Elemente einer Variante angehören können (gleich wie `design_options::COLLECTIONS`). */
export const DESIGN_OPTION_COLLECTIONS = ["walls", "openings", "ceilings", "roofs", "stairs", "columns", "beams", "extrudedSolids", "rooms", "drawings2d"] as const;
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

/** Benannte Kombinationen des Projekts ([272] Nachtrag, wie Archicads „Design Option Combinations“). */
export function designOptionCombinations(project: Project): readonly DesignOptionCombination[] {
  return project.designOptionCombinations ?? [];
}

/** Vollständige Wahl einer benannten Kombination: je Satz die gespeicherte Variante, sonst (fehlender Satz, gelöschte Variante) die Hauptvariante. */
export function combinationChoice(project: Project, c: DesignOptionCombination): Combination {
  return resolveCombination(project, c.choices);
}

/**
 * Rangfolge der gespeicherten Wahl eines Objekts (Ebene, Vorlage, Ausschnitt, Viewport; Kern `design_options::stored_choice`):
 * verweist es auf eine vorhandene benannte Kombination, gilt diese vollständig (fehlende Sätze ⇒ Hauptvariante) und die freie
 * Wahl `designOptions` desselben Objekts wird übergangen; sonst (kein oder unbekannter Verweis) die freie Wahl; `undefined` ohne Wahl.
 */
export function storedChoice(project: Project, holder: { designOptionCombination?: string | null; designOptions?: Combination | null } | null | undefined): Combination | undefined {
  const c = holder?.designOptionCombination ? designOptionCombinations(project).find((x) => x.id === holder.designOptionCombination) : undefined;
  if (c) return combinationChoice(project, c);
  return holder?.designOptions ?? undefined;
}

/** Kombination einer Ebene (`DrawingLevel`: benannte Kombination bzw. freie Wahl über den Hauptvarianten). */
export function levelCombination(project: Project, level: DrawingLevel | undefined): Combination {
  return resolveCombination(project, storedChoice(project, level));
}

/** Zustand der Kombination einer Ansicht wie in Archicad: benannte Kombination (`named`; auch bei gleicher Wahl wie eine gespeicherte) oder „Eigene“. */
export type CombinationState = { kind: "named"; id: string; name: string; assigned: boolean } | { kind: "custom" };

export function levelCombinationState(project: Project, level: DrawingLevel | undefined): CombinationState {
  const ref = level?.designOptionCombination ? designOptionCombinations(project).find((x) => x.id === level.designOptionCombination) : undefined;
  if (ref) return { kind: "named", id: ref.id, name: ref.name, assigned: true };
  const cur = levelCombination(project, level);
  const same = (a: Combination, b: Combination) => Object.keys({ ...a, ...b }).every((k) => a[k] === b[k]);
  const hit = designOptionCombinations(project).find((c) => same(combinationChoice(project, c), cur));
  if (hit) return { kind: "named", id: hit.id, name: hit.name, assigned: false };
  return { kind: "custom" };
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

/** Name einer benannten Kombination mit genau dieser Wahl (erste in der Liste); sonst `undefined`. */
export function combinationNameFor(project: Project, c: Combination): string | undefined {
  const full = resolveCombination(project, c);
  return designOptionCombinations(project).find((x) => Object.entries(combinationChoice(project, x)).every(([k, v]) => full[k] === v))?.name;
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

/** Ops: Wahl der Ebene setzen (eine Variante je Satz; die Hauptvariante wird nicht gespeichert). Verweist die Ebene auf eine benannte
 * Kombination, wird deren Wahl zur freien Wahl der Ebene (Verweis weg, Zustand „Eigene“) und dann der Satz geändert. */
export function setLevelCombinationOps(project: Project, levelId: string, setId: string, optionId: string): CoreOp[] {
  const s = designOptionSets(project).find((x) => x.id === setId);
  if (!s || !s.options.some((o) => o.id === optionId)) return [];
  return patchItem(project, "drawingLevels", levelId, (l) => {
    const m: Combination = { ...freeOf(project, l) };
    if (primaryOption(s) === optionId) delete m[setId];
    else m[setId] = optionId;
    return withFree(l, m);
  });
}

/** Freie Wahl ohne Hauptvarianten, die die Ebene wirksam zeigt (benannte Kombination aufgelöst). */
function freeOf(project: Project, l: DrawingLevel): Combination {
  const eff = storedChoice(project, l) ?? {};
  const prim = resolveCombination(project);
  const out: Combination = {};
  for (const [k, v] of Object.entries(eff)) if (prim[k] !== v) out[k] = v;
  return out;
}

/** Die Ebene mit freier Wahl `m` und ohne Verweis auf eine benannte Kombination. */
function withFree(l: DrawingLevel, m: Combination): DrawingLevel {
  const next = { ...l } as DrawingLevel;
  delete next.designOptionCombination;
  if (Object.keys(m).length) next.designOptions = m;
  else delete next.designOptions;
  return next;
}

// ── Benannte Kombinationen ──────────────────────────────────────────────────

/** Ops: Ebene `levelId` zeigt die benannte Kombination `combinationId` (`null` = Verweis lösen: die Wahl bleibt als freie Wahl, „Eigene“). */
export function assignCombinationOps(project: Project, levelId: string, combinationId: string | null): CoreOp[] {
  if (combinationId !== null && !designOptionCombinations(project).some((c) => c.id === combinationId)) return [];
  return patchItem(project, "drawingLevels", levelId, (l) => {
    if (combinationId === null) return withFree(l, freeOf(project, l));
    const next = { ...l, designOptionCombination: combinationId } as DrawingLevel;
    delete next.designOptions;
    return next;
  });
}

/** Ops: Layout-Viewport-Felder für die Wahl einer Kombination (`""` = wie Ausschnitt): Verweis setzen, freie Wahl des Viewports entfällt. */
export function viewportCombinationPatch(combinationId: string): { designOptionCombination?: string; designOptions?: undefined } {
  return combinationId ? { designOptionCombination: combinationId, designOptions: undefined } : { designOptionCombination: undefined };
}

/** Nächster freier Name „Kombination n“ nach Muster `base`. */
export function nextCombinationName(project: Project, base: string): string {
  const used = new Set(designOptionCombinations(project).map((c) => c.name.trim().toLowerCase()));
  for (let n = designOptionCombinations(project).length + 1; ; n++) {
    const name = `${base} ${n}`;
    if (!used.has(name.toLowerCase())) return name;
  }
}

/** Ops: neue benannte Kombination `name` mit der Wahl `choices` (ganz aufgelöst gespeichert, je Satz eine Variante). Gibt die neue Id zurück. */
export function addCombinationOps(project: Project, name: string, choices: Combination): { ops: CoreOp[]; id: string } {
  const list = designOptionCombinations(project);
  const id = freeId(list.map((c) => c.id), "komb-");
  const full = resolveCombination(project, choices);
  return { ops: [setField("designOptionCombinations", [...list, { id, name: name.trim() || id, choices: full }])], id };
}

/** Ops: Kombination umbenennen. */
export function renameCombinationOps(project: Project, id: string, name: string): CoreOp[] {
  const list = designOptionCombinations(project);
  if (!list.some((c) => c.id === id)) return [];
  return [setField("designOptionCombinations", list.map((c) => (c.id === id ? { ...c, name } : c)))];
}

/** Ops: Wahl eines Satzes in einer benannten Kombination ändern. */
export function setCombinationChoiceOps(project: Project, id: string, setId: string, optionId: string): CoreOp[] {
  const list = designOptionCombinations(project);
  const s = designOptionSets(project).find((x) => x.id === setId);
  if (!list.some((c) => c.id === id) || !s || !s.options.some((o) => o.id === optionId)) return [];
  return [setField("designOptionCombinations", list.map((c) => (c.id === id ? { ...c, choices: { ...c.choices, [setId]: optionId } } : c)))];
}

/** Ops: Kombination löschen samt Verweisen an Ebenen, Vorlagen, Ausschnitten und Viewports (Kern; ein Undo-Schritt). */
export function deleteCombinationOps(project: Project, id: string): CoreOp[] {
  return documentFor(project).queryRoot<CoreOp[]>("designOptionCombinationDeleteOps", JSON.stringify({ id }));
}

// ── Vergleich ───────────────────────────────────────────────────────────────

/** Zeile der Vergleichstabelle (Kern `design_options::CompareRow`). */
export interface DesignOptionCompareRow {
  choice: Combination;
  /** Zeilentitel: Name der benannten Kombination, sonst die Wahl als Text. */
  label: string;
  /** Id der benannten Kombination (fehlt in Zeilen aus dem Kreuzprodukt). */
  combination?: string | null;
  /** Wahl je Satz als Text („Dachform B, Fassade A“). */
  detail: string;
  primary: boolean;
  gf: number;
  hnf: number;
  gv: number;
  footprint: number;
  az?: number | null;
  uez?: number | null;
  cost: number;
}

/**
 * Kennzahlen und Kosten je gespeicherte benannte Kombination (Name als Zeilentitel); ohne gespeicherte Kombination, oder mit
 * `all`, je Kombination der Sätze (Hauptkombination zuerst). `renovation`: Umbau-Zustand (Filter-Id).
 */
export function compareDesignOptions(project: Project, renovation = "", all = false): DesignOptionCompareRow[] {
  if (!designOptionSets(project).length) return [];
  const a = { ...(renovation ? { renovation } : {}), ...(all ? { all } : {}) };
  return documentFor(project).query<DesignOptionCompareRow[]>("designOptionCompare", [], Object.keys(a).length ? JSON.stringify(a) : "");
}

/** Vergleich als CSV (Semikolon) mit den Spaltenköpfen `head` (übersetzt). */
export function compareDesignOptionsCsv(project: Project, head: readonly string[], renovation = "", all = false): string {
  if (!designOptionSets(project).length) return "";
  return documentFor(project).query<string>("designOptionCompare", [], JSON.stringify({ head, ...(renovation ? { renovation } : {}), ...(all ? { all } : {}) }));
}

/**
 * Das Projekt so, dass die Kombination `c` überall gilt (CLI `--options`): die gewählten Varianten werden Hauptvarianten,
 * gespeicherte Wahlen dieser Sätze an Ebenen, Vorlagen, Ausschnitten und Viewports entfallen. Kein Op (Kopie für Exporte).
 */
export function projectWithCombination(project: Project, c: Combination): Project {
  const keys = Object.keys(c);
  if (!keys.length) return project;
  // Benannte Kombinationen der Objekte werden zuerst zur freien Wahl aufgelöst, dann fallen die Sätze von `c` heraus.
  const strip = <T extends { designOptions?: Combination | null; designOptionCombination?: string | null }>(x: T): T => {
    if (!x.designOptions && !x.designOptionCombination) return x;
    const eff = storedChoice(project, x) ?? {};
    const m: Combination = {};
    for (const [k, v] of Object.entries(eff)) if (!keys.includes(k)) m[k] = v;
    const next = { ...x };
    delete next.designOptionCombination;
    if (Object.keys(m).length) next.designOptions = m;
    else delete next.designOptions;
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

// ── Bearbeiten wie im Archicad-Manager (Nachtrag 17.11.): Auge, Stift, grau einfärben, sperren ─────────────────────
//
// Stift = Bearbeitungsvariante (`drawDesignOption` im Store, Zustand der Sitzung wie in Archicad die Einstellungen des
// Managers, kein Undo-Schritt): neue Elemente der Zeichenbefehle gehören ihr (Kern `design_options::stamp_ops`), die
// Bildschirm-Ansichten zeigen sie (Stift impliziert Auge) und färben mit „grau“ alles ausserhalb grau (Kern
// `design_options::Edit`, `renovation::View::editing` — der eine Sichtbarkeits-Ort; Druck/PDF/Exporte fragen nie damit).

/** Variante als Ziel (Satz-Id, Varianten-Id). */
export type DesignOptionTarget = { set: string; option: string };

/** Anfrage-Feld `designOptionEdit` der Bildschirm-Ansichten (Grundriss, Schnitt, Ansicht, Axo, 3D). */
export interface DesignOptionEditArg {
  set: string;
  option: string;
  /** Häkchen „Elemente ausserhalb der Variante grau einfärben“. */
  grey: boolean;
  /** 3D-Pick: „sperren“ — Elemente ausserhalb der Variante sind nicht anwählbar (Kern `design_options::Edit::locked`). */
  lock?: boolean;
  /** 3D-Fenster: das Grau kommt als durchscheinende Geisterschicht (render3d), nicht als helle Teilefarbe. */
  layer?: boolean;
}

/** Füllfarbe des Graus ausserhalb der Bearbeitungsvariante (gleich wie `renovation::ghost_style` im Kern). */
export const DESIGN_OPTION_GHOST_FILL = "#e3e3e3";
/** Linien-/Randfarbe des Grau (Kern `renovation::ghost_style`): Räume, Möbel und andere 2D-Elemente ausserhalb. */
export const DESIGN_OPTION_GHOST_LINE = "#a8a8a8";

function knownTarget(project: Project, t: DesignOptionTarget | null | undefined): t is DesignOptionTarget {
  return !!t && designOptionSets(project).some((s) => s.id === t.set && s.options.some((o) => o.id === t.option));
}

/** Bearbeitungsvariante für Bildschirm-Anfragen; `null` ohne Stift oder bei unbekannter Variante. */
export function designOptionEditArg(
  project: Project,
  draw: DesignOptionTarget | null | undefined,
  grey: boolean,
  /** Nur das 3D-Fenster: Sperre im Pick (`lock`) und Geisterschicht statt Teilefarbe (`layer`). */
  view3d?: { lock: boolean },
): DesignOptionEditArg | null {
  if (!knownTarget(project, draw)) return null;
  const e: DesignOptionEditArg = { set: draw.set, option: draw.option, grey };
  if (view3d) {
    e.layer = true;
    if (view3d.lock) e.lock = true;
  }
  return e;
}

/** Auge: die in der aktiven Ansicht sichtbare Variante des Satzes (der Stift geht vor, sonst die Kombination der Ebene). */
export function visibleOption(project: Project, level: DrawingLevel | undefined, draw: DesignOptionTarget | null | undefined, setId: string): string | undefined {
  if (knownTarget(project, draw) && draw.set === setId) return draw.option;
  return levelCombination(project, level)[setId];
}

/**
 * Klick aufs Auge einer Variante: die Ebene zeigt sie (Ops, ein Undo-Schritt). Im Satz des Stifts endet damit die Bearbeitung
 * (Stift impliziert Auge, eine andere Variante dieses Satzes sichtbar zu machen heisst, den Stift abzugeben).
 */
export function eyeClick(project: Project, levelId: string, draw: DesignOptionTarget | null, setId: string, optionId: string): { draw: DesignOptionTarget | null; ops: CoreOp[] } {
  if (draw && draw.set === setId && draw.option === optionId) return { draw, ops: [] };
  const level = project.drawingLevels.find((l) => l.id === levelId);
  const ops = levelCombination(project, level)[setId] === optionId ? [] : setLevelCombinationOps(project, levelId, setId, optionId);
  return { draw: draw && draw.set === setId ? null : draw, ops };
}

/** Klick auf den Stift einer Variante: sie wird Bearbeitungsvariante; der Stift der bearbeiteten Variante gibt zurück ans Hauptmodell. */
export function penClick(project: Project, draw: DesignOptionTarget | null, setId: string, optionId: string): DesignOptionTarget | null {
  if (draw && draw.set === setId && draw.option === optionId) return null;
  const t = { set: setId, option: optionId };
  return knownTarget(project, t) ? t : null;
}

/** Auswahl-Art → Liste im Projekt (nur Arten, deren Elemente einer Variante angehören können). */
const KIND_COLLECTION: Record<string, DesignOptionCollection> = {
  walls: "walls",
  openings: "openings",
  ceilings: "ceilings",
  roofs: "roofs",
  stairs: "stairs",
  columns: "columns",
  solids: "extrudedSolids",
  rooms: "rooms",
  drawings: "drawings2d",
};

/** Modell-Arten ohne Variante (immer ausserhalb einer Bearbeitungsvariante). */
const OUTSIDE_KINDS = new Set(["trees", "cameras", "contextObjects"]);

/**
 * Häkchen „Elemente ausserhalb der Variante sperren“: ist das Element (Auswahl-Art, Id) bei Bearbeitungsvariante `edit` gesperrt?
 * Gesperrt ist alles ausserhalb der Variante (Hauptmodell, andere Varianten, Bäume, Kameras, Kontext); eine Öffnung ohne eigene
 * Variante folgt ihrer Wand. Schnittlinien, Lage-Darstellung und Gruppen bleiben wählbar. Ohne `edit` nichts gesperrt.
 */
export function designOptionLocked(project: Project, edit: DesignOptionTarget | null | undefined, kind: string, id: string): boolean {
  if (!edit) return false;
  if (OUTSIDE_KINDS.has(kind)) return true;
  const coll = KIND_COLLECTION[kind];
  if (!coll) return false;
  type El = { id: string; designOption?: DesignOptionRef; hostWallId?: string };
  // [280] Träger liegen im Auswahlkanal der Stützen.
  const pool = ((project[coll] ?? []) as El[]).concat(coll === "columns" ? ((project.beams ?? []) as El[]) : []);
  const e = pool.find((x) => x.id === id);
  if (!e) return false;
  const r = e.designOption ?? (coll === "openings" ? project.walls.find((w) => w.id === e.hostWallId)?.designOption : undefined);
  return !(r && r.set === edit.set && r.option === edit.option);
}

/** Auswahl ohne gesperrte Elemente ({@link designOptionLocked}); unveränderte Listen behalten ihre Referenz. */
export function unlockedSelection<T extends Record<string, string[] | undefined>>(project: Project, edit: DesignOptionTarget | null | undefined, sel: T): T {
  if (!edit) return sel;
  const out = { ...sel } as Record<string, string[] | undefined>;
  for (const [k, ids] of Object.entries(sel)) {
    if (!ids?.length) continue;
    const keep = ids.filter((id) => !designOptionLocked(project, edit, k, id));
    if (keep.length !== ids.length) out[k] = keep;
  }
  return out as T;
}
