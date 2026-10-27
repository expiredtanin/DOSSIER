// Ebenen (Kategorien) der aktuellen Auswahl: ausblenden bzw. isolieren
// ("nur diese Ebene(n) zeigen"). Reine Funktionen — der Aufrufer (App) legt sie
// über `setProject`, also EIN Undo-Schritt.

import type { LayerCategory, Project } from "../model/types";
import { flattenCategories } from "../model/types";

/** Ausgewählte Objekt-IDs je Art (wie `selectionLockMembers` in App.tsx). */
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

type WithCat = { id: string; categoryCode?: string };

/** Kategorie-Codes aller gewählten Objekte (eindeutig, in Fundreihenfolge). */
export function selectionCategoryCodes(project: Project, sel: SelectionMembers): string[] {
  const p = project as unknown as Record<string, readonly WithCat[] | undefined>;
  const sources: Array<[readonly string[] | undefined, readonly WithCat[]]> = [
    [sel.wallIds, p.walls ?? []],
    [sel.drawingIds, p.drawings2d ?? []],
    [sel.ceilingIds, p.ceilings ?? []],
    [sel.roomIds, p.rooms ?? []],
    [sel.stairIds, p.stairs ?? []],
    [sel.columnIds, p.columns ?? []],
    [sel.roofIds, p.roofs ?? []],
    [sel.openingIds, p.openings ?? []],
  ];
  const out = new Set<string>();
  for (const [ids, objects] of sources) {
    if (!ids || ids.length === 0) continue;
    const wanted = new Set(ids);
    for (const o of objects) if (o.categoryCode && wanted.has(o.id)) out.add(o.categoryCode);
  }
  return [...out];
}

function mapCategories(
  layers: LayerCategory[],
  fn: (c: LayerCategory) => LayerCategory,
): LayerCategory[] {
  let changed = false;
  const next = layers.map((c) => {
    const children = c.children ? mapCategories(c.children, fn) : undefined;
    const base = children !== c.children ? { ...c, children } : c;
    const out = fn(base);
    if (out !== c) changed = true;
    return out;
  });
  return changed ? next : layers;
}

/** Setzt `visible` genau für die gegebenen Codes; unveränderte Teilbäume bleiben dieselben Objekte. */
export function setCategoriesVisible(
  layers: LayerCategory[],
  codes: ReadonlySet<string>,
  visible: boolean,
): LayerCategory[] {
  return mapCategories(layers, (c) => (codes.has(c.code) && c.visible !== visible ? { ...c, visible } : c));
}

/** Nur die gegebenen Codes sichtbar, alle übrigen ausgeblendet. */
export function isolateCategories(layers: LayerCategory[], codes: ReadonlySet<string>): LayerCategory[] {
  return mapCategories(layers, (c) => {
    const want = codes.has(c.code);
    return c.visible !== want ? { ...c, visible: want } : c;
  });
}

/** Anzeigenamen der Kategorien zu den Codes (für Menü-Beschriftungen). */
export function categoryNames(layers: LayerCategory[], codes: readonly string[]): string[] {
  const all = flattenCategories(layers);
  return codes.map((code) => all.find((c) => c.code === code)?.name ?? code);
}
