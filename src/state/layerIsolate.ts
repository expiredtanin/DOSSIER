// [192] Ebenen schnell schalten: „Nur diese Ebene zeigen", „Ebene ausblenden", „Alle einblenden".
// Die Sichtbarkeit ist ein Projektfeld (`layers[].visible`) und ändert sich wie jede Änderung über Ops:
// jede Aktion ist EIN Undo-Schritt. Der Zustand VOR dem ersten Isolieren wird gemerkt (nur diese Sitzung,
// an die Projekt-Epoche gebunden); „Alle einblenden" stellt ihn wieder her, sonst wird alles eingeblendet.
// Reine Funktionen oben (getestet in `layerIsolate.test.ts`), Store-Anbindung unten.

import { fieldOps } from "../core";
import type { LayerCategory } from "../model/types";
import { flattenCategories } from "../model/types";
import { applyVisibilityByCode, isolateCategories, selectionCategoryCodes, setCategoriesVisible } from "../model/layers";
import { toMembership } from "./selection";
import { getState } from "./appStore";

/** Codes samt aller Elternklassen (damit eine isolierte Unterklasse sichtbar bleibt). */
export function withAncestors(layers: LayerCategory[], codes: readonly string[]): Set<string> {
  const out = new Set(codes);
  const walk = (cats: LayerCategory[], path: string[]): void => {
    for (const c of cats) {
      if (out.has(c.code)) path.forEach((p) => out.add(p));
      if (c.children?.length) walk(c.children, [...path, c.code]);
    }
  };
  walk(layers, []);
  return out;
}

/** Nur `codes` (und ihre Elternklassen) sichtbar, alle übrigen aus. */
export function isolateKeepingParents(layers: LayerCategory[], codes: readonly string[]): LayerCategory[] {
  return isolateCategories(layers, withAncestors(layers, codes));
}

/** Sichtbarkeits-Abbild je Code. */
export function visibilityOf(layers: LayerCategory[]): Record<string, boolean> {
  return Object.fromEntries(flattenCategories(layers).map((c) => [c.code, c.visible]));
}

const sameVisibility = (a: Record<string, boolean>, b: Record<string, boolean>): boolean =>
  Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((k) => a[k] === b[k]);

/** „Alle einblenden": gemerkter Zustand, falls vorhanden und wirksam, sonst alles an. */
export function showAllLayers(layers: LayerCategory[], memory: Record<string, boolean> | null): LayerCategory[] {
  if (memory) {
    const restored = applyVisibilityByCode(layers, memory);
    if (!sameVisibility(visibilityOf(restored), visibilityOf(layers))) return restored;
  }
  return setCategoriesVisible(layers, new Set(flattenCategories(layers).map((c) => c.code)), true);
}

// ── Store-Anbindung ─────────────────────────────────────────────────────────

let memory: { epoch: number; vis: Record<string, boolean> } | null = null;

const memoryNow = (): Record<string, boolean> | null =>
  memory && memory.epoch === getState().projectEpoch ? memory.vis : null;

/** Isoliert die Ebenen `codes` (Elternklassen bleiben an); merkt beim ersten Mal den Zustand davor. */
export function isolateLayerCodes(codes: readonly string[]): void {
  if (codes.length === 0) return;
  const st = getState();
  if (!memoryNow()) memory = { epoch: st.projectEpoch, vis: visibilityOf(st.project.layers) };
  st.applyChange((p) => fieldOps(p, "layers", isolateKeepingParents(p.layers, codes)));
}

export function hideLayerCodes(codes: readonly string[]): void {
  if (codes.length === 0) return;
  getState().applyChange((p) => fieldOps(p, "layers", setCategoriesVisible(p.layers, new Set(codes), false)));
}

/** Alle Ebenen einblenden bzw. den Zustand vor dem Isolieren wiederherstellen. */
export function showAllLayerCodes(): void {
  const mem = memoryNow();
  memory = null;
  getState().applyChange((p) => fieldOps(p, "layers", showAllLayers(p.layers, mem)));
}

/** Ebenen-Codes der aktuellen Auswahl. */
export function selectionLayerCodes(): string[] {
  const st = getState();
  return selectionCategoryCodes(st.project, toMembership(st.selection));
}

export const isolateSelectionLayerCodes = (): void => isolateLayerCodes(selectionLayerCodes());
