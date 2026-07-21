// Kontextmenü-Builder — baut die Menü-Einträge je Quelle (Ebene / Zeichnungs-
// ebene / Grundriss / 3D-Viewport). 1:1 nach docs/design/context-menu.md.
// JEDER Eintrag ist verdrahtet ODER klar deaktiviert mit Tooltip (`title`, nennt
// den Grund) — kein stiller No-Op.
//
// Extrahiert aus App.tsx (reine Funktionen, keine Hooks/kein Store-Zugriff — die
// Aktionen kommen als `MenuActions` von App herein). Bezeichner englisch,
// Kommentare deutsch (CONVENTIONS.md).

import { t } from "../i18n";
import type { LayerCategory, Project } from "../model/types";
import { flattenCategories } from "../model/types";
import { findCategory } from "../state/projectSlice";
import { MenuIcon } from "../ui/ContextMenu";
import type { ContextMenuItem } from "../ui/ContextMenu";

/** Offenes Kontextmenü (genau eines). `x/y` = Anker in Viewport-Px. */
export type MenuState =
  | { kind: "layer"; code: string; x: number; y: number }
  | { kind: "level"; id: string; x: number; y: number }
  | { kind: "plan"; wallId: string | null; x: number; y: number }
  | { kind: "viewport"; wallId: string | null; x: number; y: number }
  | null;

/** Offener Inline-Editor (aus einem Menüpunkt). `x/y` = Anker in Viewport-Px. */
export type EditorState =
  | { kind: "layer"; code: string; x: number; y: number }
  | { kind: "level"; id: string; x: number; y: number }
  | null;

/** Titel des Kontextmenüs je Quelle (Ebenenname / Geschossname / Wand/Ansicht). */
export function menuTitle(menu: NonNullable<MenuState>, project: Project): string {
  switch (menu.kind) {
    case "layer": {
      const c = findCategory(project.layers, menu.code);
      return c ? `${c.code} · ${c.name}` : menu.code;
    }
    case "level": {
      const l = project.drawingLevels.find((z) => z.id === menu.id);
      return l ? l.name : t("ctx.title.level");
    }
    case "plan":
    case "viewport":
      return menu.wallId ? t("ctx.title.wall") : t("ctx.title.view");
  }
}

/** Aktionen, die der Kontextmenü-Builder von App braucht (alle verdrahtet). */
export interface MenuActions {
  project: Project;
  selectedWallId: string | null;
  layerClipboard: { color: string; lw: number } | null;
  openLayerEditor: (code: string) => void;
  openLevelEditor: (id: string) => void;
  addSubCategory: (parentCode: string) => void;
  assignWallCategory: (wallId: string, code: string) => void;
  duplicateCategory: (code: string) => void;
  deleteCategory: (code: string) => void;
  setLayerClipboard: (clip: { color: string; lw: number } | null) => void;
  patchCategory: (code: string, patch: Partial<LayerCategory>) => void;
  duplicateLevel: (id: string) => void;
  deleteLevel: (id: string) => void;
  clearSelection: () => void;
  fit: () => void;
  fitSelection: () => void;
  /** Anzahl geschlossener Flächen in der aktuellen 2D-Auswahl (Boolean-Aktivierung). */
  closedSelectionCount: number;
  union: () => void;
  difference: () => void;
  intersect: () => void;
  /** Anzahl aktuell selektierter 2D-Zeichnungselemente (z-Anordnen-Menü). */
  drawingSelectionCount: number;
  bringToFront: () => void;
  bringForward: () => void;
  sendBackward: () => void;
  sendToBack: () => void;
}

/**
 * Baut die Kontextmenü-Einträge je Quelle — 1:1 nach docs/design/context-menu.md.
 * JEDER Eintrag ist verdrahtet ODER klar deaktiviert mit Tooltip (`title`,
 * nennt den Grund) — kein stiller No-Op.
 */
export function buildMenuItems(
  menu: NonNullable<MenuState>,
  a: MenuActions,
): ContextMenuItem[] {
  switch (menu.kind) {
    case "layer":
      return layerMenuItems(menu.code, a);
    case "level":
      return levelMenuItems(menu.id, a);
    case "plan":
      return planMenuItems(menu.wallId, a);
    case "viewport":
      return viewportMenuItems(menu.wallId, a);
  }
}

/** Ebenen-Kontextmenü (Rechtsklick auf Ebenen-Zeile). */
function layerMenuItems(code: string, a: MenuActions): ContextMenuItem[] {
  const total = flattenCategories(a.project.layers).length;
  const hasSelection = a.selectedWallId !== null;
  const hasClipboard = a.layerClipboard !== null;
  return [
    {
      label: t("ctx.layerSettings"),
      icon: <MenuIcon name="settings" />,
      onClick: () => a.openLayerEditor(code),
    },
    { divider: true },
    {
      label: t("ctx.addSubLayer"),
      icon: <MenuIcon name="add" />,
      onClick: () => a.addSubCategory(code),
    },
    {
      label: t("ctx.assignSelection"),
      icon: <MenuIcon name="move_down" />,
      disabled: !hasSelection,
      title: hasSelection ? undefined : t("ctx.assignSelection.disabled"),
      onClick: () => {
        if (a.selectedWallId) a.assignWallCategory(a.selectedWallId, code);
      },
    },
    { divider: true },
    {
      label: t("ctx.duplicate"),
      icon: <MenuIcon name="content_copy" />,
      onClick: () => a.duplicateCategory(code),
    },
    {
      label: t("ctx.copyProps"),
      icon: <MenuIcon name="colorize" />,
      onClick: () => {
        const c = findCategory(a.project.layers, code);
        if (c) a.setLayerClipboard({ color: c.color, lw: c.lw });
      },
    },
    {
      label: t("ctx.pasteProps"),
      icon: <MenuIcon name="format_paint" />,
      disabled: !hasClipboard,
      title: hasClipboard ? undefined : t("ctx.pasteProps.disabled"),
      onClick: () => {
        if (a.layerClipboard)
          a.patchCategory(code, {
            color: a.layerClipboard.color,
            lw: a.layerClipboard.lw,
          });
      },
    },
    { divider: true },
    {
      label: t("ctx.delete"),
      icon: <MenuIcon name="delete" />,
      danger: true,
      disabled: total <= 1,
      title: total <= 1 ? t("ctx.delete.lastLayer") : undefined,
      onClick: () => a.deleteCategory(code),
    },
  ];
}

/** Zeichnungsebenen-Kontextmenü (Rechtsklick auf Geschoss/Schnitt/Zeichnung). */
function levelMenuItems(id: string, a: MenuActions): ContextMenuItem[] {
  const total = a.project.drawingLevels.length;
  return [
    {
      label: t("ctx.levelSettings"),
      icon: <MenuIcon name="settings" />,
      onClick: () => a.openLevelEditor(id),
    },
    { divider: true },
    {
      label: t("ctx.duplicate"),
      icon: <MenuIcon name="content_copy" />,
      onClick: () => a.duplicateLevel(id),
    },
    { divider: true },
    {
      label: t("ctx.delete"),
      icon: <MenuIcon name="delete" />,
      danger: true,
      disabled: total <= 1,
      title: total <= 1 ? t("ctx.delete.lastLevel") : undefined,
      onClick: () => a.deleteLevel(id),
    },
  ];
}

/**
 * Grundriss-Kontextmenü. Bezug ist die getroffene/gewählte Wand. Einträge sind
 * verdrahtet: „Auf Auswahl einpassen" (PlanView-Handle) und „Auswahl aufheben".
 * Ohne getroffene Wand bleibt nur „Einpassen". (Eigenschaften-Panel/Bemaßung
 * folgen später — daher hier KEIN Schein-Eintrag.)
 */
function planMenuItems(
  wallId: string | null,
  a: MenuActions,
): ContextMenuItem[] {
  // Boolean-Einträge (Vereinigen/Subtrahieren/Schneiden) auf die 2D-Auswahl.
  // Aktiv ab 2 geschlossenen Flächen; sonst deaktiviert mit erklärendem Tooltip.
  const boolEnabled = a.closedSelectionCount >= 2;
  const boolTitle = boolEnabled ? undefined : t("ctx.boolean.disabled");
  const booleanItems: ContextMenuItem[] = [
    {
      label: t("ctx.union"),
      icon: <MenuIcon name="join_full" />,
      disabled: !boolEnabled,
      title: boolTitle,
      onClick: a.union,
    },
    {
      label: t("ctx.subtract"),
      icon: <MenuIcon name="join_left" />,
      disabled: !boolEnabled,
      title: boolTitle,
      onClick: a.difference,
    },
    {
      label: t("ctx.intersect"),
      icon: <MenuIcon name="join_inner" />,
      disabled: !boolEnabled,
      title: boolTitle,
      onClick: a.intersect,
    },
  ];

  // Z-Anordnen (nach vorn/hinten holen) — wirkt auf die aktuelle 2D-Auswahl,
  // sortiert `drawings2d` um (Array-Reihenfolge = Zeichenreihenfolge). Aktiv
  // ab 1 selektiertem Element; sonst deaktiviert mit erklärendem Tooltip.
  const arrangeEnabled = a.drawingSelectionCount >= 1;
  const arrangeTitle = arrangeEnabled ? undefined : t("ctx.arrange.disabled");
  const arrangeItems: ContextMenuItem[] = [
    {
      label: t("ctx.arrange.front"),
      icon: <MenuIcon name="flip_to_front" />,
      disabled: !arrangeEnabled,
      title: arrangeTitle,
      onClick: a.bringToFront,
    },
    {
      label: t("ctx.arrange.forward"),
      icon: <MenuIcon name="arrow_upward" />,
      disabled: !arrangeEnabled,
      title: arrangeTitle,
      onClick: a.bringForward,
    },
    {
      label: t("ctx.arrange.backward"),
      icon: <MenuIcon name="arrow_downward" />,
      disabled: !arrangeEnabled,
      title: arrangeTitle,
      onClick: a.sendBackward,
    },
    {
      label: t("ctx.arrange.back"),
      icon: <MenuIcon name="flip_to_back" />,
      disabled: !arrangeEnabled,
      title: arrangeTitle,
      onClick: a.sendToBack,
    },
  ];

  if (wallId) {
    return [
      {
        label: t("ctx.fitSelection"),
        icon: <MenuIcon name="center_focus_strong" />,
        onClick: a.fitSelection,
      },
      {
        label: t("ctx.clearSelection"),
        icon: <MenuIcon name="deselect" />,
        onClick: a.clearSelection,
      },
      { divider: true },
      ...booleanItems,
      { divider: true },
      ...arrangeItems,
      { divider: true },
      {
        label: t("ctx.fit"),
        icon: <MenuIcon name="fit_screen" />,
        onClick: a.fit,
      },
    ];
  }
  return [
    ...booleanItems,
    { divider: true },
    ...arrangeItems,
    { divider: true },
    {
      label: t("ctx.fit"),
      icon: <MenuIcon name="fit_screen" />,
      onClick: a.fit,
    },
  ];
}

/**
 * 3D-Kontextmenü. Im 3D gibt es (noch) kein Einpassen-Handle wie im Grundriss;
 * verdrahtet ist „Auswahl aufheben" (mit getroffener Wand). Ohne Wand ist das
 * Menü leer-sinnvoll: ein deaktivierter Hinweis, kein stiller No-Op.
 */
function viewportMenuItems(
  wallId: string | null,
  a: MenuActions,
): ContextMenuItem[] {
  if (wallId) {
    return [
      {
        label: t("ctx.clearSelection"),
        icon: <MenuIcon name="deselect" />,
        onClick: a.clearSelection,
      },
    ];
  }
  return [
    {
      label: t("ctx.noWallHit"),
      disabled: true,
      title: t("ctx.noWallHit.hint"),
    },
  ];
}
