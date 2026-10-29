// Ebenen-/Kategorien-Baum und Geschoss-Höhen im Rust-Kern ([K4] S3, `src-tauri/core/src/layers.rs`,
// `levels.rs`): Abflachen, Nachschlagen, Sichtbarkeit, Isolieren, Baum-Umbauten, freie Codes,
// Import-Kategorien, Geschoss-Stapelung. Dünne Fassade über zustandslose Kern-Bindungen (JSON hinein,
// JSON hinaus; die Bäume sind klein). Die Op-Bauer (`state/projectSlice.ts`, `state/selectionLayers.ts`)
// bleiben in TS und rechnen über diese Funktionen. Ergebnis-Objekte sind Kopien aus dem Kern, nicht die
// Eingabe-Objekte; „nichts zu tun" meldet der Kern, die Fassade gibt dann die Eingabe zurück.

import type { DrawingLevel, LayerCategory, Project } from "./types.generated";
import { core } from "../engine/coreWasm";
import { documentFor } from "../core/document";

function call<T>(name: string, layers: readonly LayerCategory[], arg?: unknown): T {
  const out = core().layers_call(name, JSON.stringify(layers), arg === undefined ? "" : JSON.stringify(arg), Date.now());
  if (out === "") throw new Error(`Kern: Ebenen-Rechnung „${name}" fehlgeschlagen`);
  return JSON.parse(out) as T;
}

interface FlatIndex {
  flat: LayerCategory[];
  byCode: Map<string, LayerCategory>;
}
/** Abgeflachter Baum je Baum-Array (die Arrays gelten als unveränderlich): Aufrufe je Bauteil bleiben billig. */
const flatCache = new WeakMap<readonly LayerCategory[], FlatIndex>();

function indexOf(cats: readonly LayerCategory[]): FlatIndex {
  let ix = flatCache.get(cats);
  if (!ix) {
    const flat = call<LayerCategory[]>("flatten", cats);
    const byCode = new Map<string, LayerCategory>();
    for (const c of flat) if (!byCode.has(c.code)) byCode.set(c.code, c);
    ix = { flat, byCode };
    flatCache.set(cats, ix);
  }
  return ix;
}

/** Flacht den Kategorie-Baum (Tiefensuche) in eine Liste ab. */
export const flattenCategories = (cats: LayerCategory[]): LayerCategory[] => [...indexOf(cats).flat];

/** Findet eine Kategorie (per Code) im Baum oder `undefined` (erster Treffer). */
export function findCategory(cats: LayerCategory[], code: string): LayerCategory | undefined {
  return indexOf(cats).byCode.get(code);
}

/**
 * Liefert die LayerCategory zu einem Kategorie-Code (Baum durchsucht), oder `undefined`, falls der Code auf
 * keine Ebene verweist (verwaister `categoryCode`). Nicht-werfend, damit die Attribut-Resolve-Kette
 * (`plan/generatePlan.ts`) robust auf einen fehlenden Ebenen-Wert zurückfallen kann.
 */
export const getLayerCategory = (project: Project, code: string): LayerCategory | undefined => findCategory(project.layers, code);

/** Menge aller Codes sichtbarer Kategorien (Baum berücksichtigt). */
export const collectVisibleCodes = (layers: LayerCategory[]): Set<string> => new Set(call<string[]>("visibleCodes", layers));

/** Beschriftung einer Kategorie für die Status-Leiste: „Code Name". */
export function categoryLabel(cats: LayerCategory[], code: string): string {
  const c = findCategory(cats, code);
  return c ? `${c.code} ${c.name}` : code;
}

/** Anzeigenamen der Kategorien zu den Codes (für Menü-Beschriftungen). */
export const categoryNames = (layers: LayerCategory[], codes: readonly string[]): string[] => call<string[]>("names", layers, codes);

/** Setzt `visible` genau für die gegebenen Codes; nichts zu tun → dieselbe Liste. */
export function setCategoriesVisible(layers: LayerCategory[], codes: ReadonlySet<string>, visible: boolean): LayerCategory[] {
  return call<LayerCategory[] | null>("setVisible", layers, { codes: [...codes], visible }) ?? layers;
}

/** Nur die gegebenen Codes sichtbar, alle übrigen ausgeblendet; nichts zu tun → dieselbe Liste. */
export function isolateCategories(layers: LayerCategory[], codes: ReadonlySet<string>): LayerCategory[] {
  return call<LayerCategory[] | null>("isolate", layers, [...codes]) ?? layers;
}

/** Schaltet die Sichtbarkeit der Kategorie mit `code` im Baum um. */
export const toggleCategoryByCode = (cats: LayerCategory[], code: string): LayerCategory[] => call("toggle", cats, code);

/** Setzt im Baum die `visible`-Flags gemäß `codes` (Code → sichtbar?); unbekannte Codes werden ignoriert. */
export const applyVisibilityByCode = (cats: LayerCategory[], codes: Record<string, boolean>): LayerCategory[] =>
  call("applyVisibility", cats, codes);

/** Nächster freier zweistelliger Code über den ganzen Baum hinweg. */
export const nextFreeCode = (cats: LayerCategory[]): string => call("nextFreeCode", cats);

/** Patcht die Kategorie mit `code` im Baum (`undefined`-Werte entfernen das Feld). */
export const patchCategoryByCode = (cats: LayerCategory[], code: string, patch: Partial<LayerCategory>): LayerCategory[] =>
  call(
    "patch",
    cats,
    { code, patch: Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, v === undefined ? null : v])) },
  );

/** Hängt `child` als letztes Kind an die Kategorie mit `parentCode`. */
export const addChildByCode = (cats: LayerCategory[], parentCode: string, child: LayerCategory): LayerCategory[] =>
  call("addChild", cats, { parent: parentCode, child });

/** Fügt `clone` direkt nach der Kategorie mit `code` auf derselben Ebene ein. */
export const insertAfterCode = (cats: LayerCategory[], code: string, clone: LayerCategory): LayerCategory[] =>
  call("insertAfter", cats, { code, clone });

/** Entfernt die Kategorie mit `code` (samt Kindern) aus dem Baum. */
export const removeCategoryByCode = (cats: LayerCategory[], code: string): LayerCategory[] => call("remove", cats, code);

/** Neue Kategorien für Import-Layer ohne gleichnamige Kategorie (s. `planImportCategories`, `io/dxfToDrawings.ts`). */
export function planImportLayers(
  layerNames: readonly string[],
  existing: readonly LayerCategory[],
  colors: Readonly<Record<string, string>>,
  weights: Readonly<Record<string, number>>,
): { children: LayerCategory[]; parentCode: string; codeByLayer: Map<string, string> } {
  const r = call<{ children: LayerCategory[]; parentCode: string; codeByLayer: [string, string][] }>("planImport", existing as LayerCategory[], {
    names: layerNames,
    colors,
    weights,
  });
  return { children: r.children, parentCode: r.parentCode, codeByLayer: new Map(r.codeByLayer) };
}

/** Auswahl nach Elementart (ids je Art, wie `selectionLockMembers` in App.tsx). */
export interface SelectionMembers {
  wallIds?: readonly string[];
  drawingIds?: readonly string[];
  ceilingIds?: readonly string[];
  roomIds?: readonly string[];
  stairIds?: readonly string[];
  columnIds?: readonly string[];
  roofIds?: readonly string[];
  openingIds?: readonly string[];
}

/** Kategorie-Codes aller gewählten Objekte (eindeutig, in Fundreihenfolge). */
export function selectionCategoryCodes(project: Project, sel: SelectionMembers): string[] {
  return documentFor(project).query<string[]>("selectionCategoryCodes", [], JSON.stringify(sel));
}

/**
 * Stapelt baseElevation der Geschosse in Dokumentreihenfolge: Das erste Geschoss beginnt bei 0, jedes weitere
 * bei baseElevation + floorHeight des vorigen Geschosses. Nicht-Geschoss-Ebenen behalten baseElevation
 * undefined. Liefert eine neue Liste; die Eingabe bleibt unverändert.
 */
export function recomputeFloorElevations(levels: DrawingLevel[]): DrawingLevel[] {
  const out = core().levels_recompute_elevations(JSON.stringify(levels));
  if (out === "") throw new Error("Kern: Geschoss-Höhen fehlgeschlagen");
  return JSON.parse(out) as DrawingLevel[];
}
