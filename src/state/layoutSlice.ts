// Layout-Slice: das Panel-Layout (Docks/Tabs/Größen + schwebende Fenster) und
// alle Mutationen darauf. Nutzt die reinen Helfer aus src/panels/layout.ts
// (nicht dupliziert). Reiner Umzug aus App.tsx. Bezeichner englisch, Kommentare
// deutsch (CONVENTIONS.md).
//
// Persistenz (saveLayout) und das Init-Reconcile bleiben in App (useState-Init +
// useEffect); diese Slice liefert nur die Mutationen + reconcileLayout-Helfer.

import {
  bringToFront,
  defaultLayout,
  loadLayout,
  moveToDock,
  moveToFloat,
  moveToGroup,
  moveToNewGroup,
  removeFloat,
  reorderInGroup,
  setActiveTab,
  setGroupWeights,
  updateFloat,
} from "../panels/layout";
import { DEFAULT_FLOAT_W, DEFAULT_FLOAT_H } from "../panels/panelDrag";
import { hasPanel } from "../panels/registry";
// Seiteneffekt: registriert die dockbaren Kern-Panels in der Registry. MUSS vor
// `reconcileLayout(loadLayout())` (Slice-Init) laufen, sonst filtert hasPanel
// alle Tabs weg und die Docks blieben leer (Import-Reihenfolge!).
import "../panels/builtinPanels";
import type { DockId, DockState, LayoutState } from "../panels/types";
import type { StoreApi } from "./store";

/** Felder, die diese Slice in den RootState beisteuert. */
export interface LayoutSlice {
  layout: LayoutState;

  /** Layout direkt ersetzen (z. B. nach „Layout anwenden" aus dem Menü). */
  setLayout: (next: LayoutState | ((l: LayoutState) => LayoutState)) => void;

  // ── Dock-Größen / Gruppen ────────────────────────────────────────────────
  resizeDock: (side: "left" | "right", size: number) => void;
  resizeGroups: (side: "left" | "right", weights: number[]) => void;

  // ── Tab-Drag-Auflösung (Reorder / Einreihen / Stapeln / Lösen) ────────────
  activateTab: (panelId: string) => void;
  joinGroup: (
    panelId: string,
    dock: DockId,
    group: number,
    index?: number,
  ) => void;
  newGroup: (panelId: string, dock: DockId, at: number) => void;
  dropFloat: (panelId: string, x: number, y: number) => void;

  // ── Schwebende Fenster ────────────────────────────────────────────────────
  focusFloat: (panelId: string) => void;
  moveFloat: (panelId: string, x: number, y: number) => void;
  resizeFloat: (panelId: string, w: number, h: number) => void;
  closeFloat: (panelId: string) => void;
  redockFloat: (panelId: string) => void;
  /** Titel-Drop eines schwebenden Fensters auf eine Rand-Zone (dock). */
  dockFloatTo: (panelId: string, dock: DockId) => void;
}

export function createLayoutSlice(api: StoreApi<LayoutSlice>): LayoutSlice {
  const { set, get } = api;

  const setLayout: LayoutSlice["setLayout"] = (next) =>
    set((s) => ({
      layout: typeof next === "function" ? (next as (l: LayoutState) => LayoutState)(s.layout) : next,
    }));

  // Welcher Dock enthält ein Panel gerade?
  const dockOf = (panelId: string): DockId | null => {
    const layout = get().layout;
    if (layout.left.groups.some((g) => g.tabs.includes(panelId))) return "left";
    if (layout.right.groups.some((g) => g.tabs.includes(panelId))) return "right";
    return null;
  };

  // Genaue Lage eines Panels im Layout: Dock + Gruppen-Index + Tab-Index.
  const locate = (
    panelId: string,
  ): { dock: DockId; group: number; tab: number } | null => {
    const layout = get().layout;
    for (const dock of ["left", "right"] as const) {
      const groups = layout[dock].groups;
      for (let g = 0; g < groups.length; g++) {
        const tab = groups[g].tabs.indexOf(panelId);
        if (tab >= 0) return { dock, group: g, tab };
      }
    }
    return null;
  };

  return {
    layout: reconcileLayout(loadLayout()),

    setLayout,

    resizeDock: (side, size) =>
      setLayout((l) => ({ ...l, [side]: { ...l[side], size } })),
    resizeGroups: (side, weights) =>
      setLayout((l) => setGroupWeights(l, side, weights)),

    // Unter der Schwelle losgelassen → Klick: Tab in seiner Gruppe aktivieren.
    activateTab: (panelId) => {
      const side = dockOf(panelId);
      if (side) setLayout((l) => setActiveTab(l, side, panelId));
    },

    // Über einer Tab-Leiste → in DIESE Gruppe einreihen (Stapel zusammenlegen).
    joinGroup: (panelId, dock, group, index) => {
      const from = locate(panelId);
      const layout = get().layout;
      if (from && from.dock === dock && from.group === group && index !== undefined) {
        setLayout((l) =>
          reorderInGroup(l, dock, group, from.tab, clampReorderIndex(from.tab, index)),
        );
        return;
      }
      const shift =
        from &&
        from.dock === dock &&
        from.group < group &&
        layout[dock].groups[from.group].tabs.length === 1
          ? 1
          : 0;
      setLayout((l) => moveToGroup(l, panelId, dock, group - shift, index));
    },

    // Über einem Gruppen-Körper / einer Rand-Zone → NEUE gestapelte Gruppe.
    newGroup: (panelId, dock, at) => {
      const from = locate(panelId);
      const layout = get().layout;
      const shift =
        from &&
        from.dock === dock &&
        from.group < at &&
        layout[dock].groups[from.group].tabs.length === 1
          ? 1
          : 0;
      setLayout((l) => moveToNewGroup(l, panelId, dock, at - shift));
    },

    // Über der Arbeitsfläche → lösen (schweben) an der Cursorposition.
    dropFloat: (panelId, x, y) =>
      setLayout((l) =>
        moveToFloat(l, panelId, {
          x: Math.max(0, x),
          y: Math.max(0, y),
          w: DEFAULT_FLOAT_W,
          h: DEFAULT_FLOAT_H,
        }),
      ),

    focusFloat: (panelId) => setLayout((l) => bringToFront(l, panelId)),
    moveFloat: (panelId, x, y) =>
      setLayout((l) => updateFloat(l, panelId, { x: Math.max(0, x), y: Math.max(0, y) })),
    resizeFloat: (panelId, w, h) =>
      setLayout((l) => updateFloat(l, panelId, { w, h })),
    closeFloat: (panelId) => setLayout((l) => removeFloat(l, panelId)),
    redockFloat: (panelId) => setLayout((l) => moveToDock(l, panelId, "left")),
    dockFloatTo: (panelId, dock) => setLayout((l) => moveToDock(l, panelId, dock)),
  };
}

// ── Layout-Helfer (verschoben aus App.tsx, 1:1) ──────────────────────────────

/**
 * Übersetzt einen Einfüge-Index (0..n) in einen Reorder-Zielindex (0..n-1).
 */
export function clampReorderIndex(fromIndex: number, insertIndex: number): number {
  const to = insertIndex > fromIndex ? insertIndex - 1 : insertIndex;
  return Math.max(0, to);
}

/**
 * Gleicht ein (geladenes) Layout gegen die Registry ab: Tabs ohne registriertes
 * Panel werden entfernt, ein verwaister activeTab korrigiert. Wird ein Dock
 * dadurch leer, bleibt es leer (Größe erhalten).
 */
export function reconcileLayout(layout: LayoutState): LayoutState {
  const def = defaultLayout();
  const fix = (dock: DockState): DockState => {
    const groups = dock.groups
      .map((g) => {
        const tabs = g.tabs.filter((id) => hasPanel(id));
        const activeTab =
          g.activeTab && tabs.includes(g.activeTab) ? g.activeTab : (tabs[0] ?? null);
        return { tabs, activeTab, weight: g.weight };
      })
      .filter((g) => g.tabs.length > 0);
    return { groups, size: dock.size };
  };
  const floating = layout.floating.filter((f) => hasPanel(f.panelId));
  return {
    left: fix(layout.left),
    right: fix(layout.right),
    floating,
    version: def.version,
  };
}
