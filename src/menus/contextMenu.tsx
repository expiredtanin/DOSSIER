// Kontextmenü-Builder — baut die Menü-Einträge je Quelle (Ebene / Zeichnungs-
// ebene / Grundriss / 3D-Viewport). 1:1 nach docs/design/context-menu.md.
// JEDER Eintrag ist verdrahtet ODER klar deaktiviert mit Tooltip (`title`, nennt
// den Grund) — kein stiller No-Op.
//
// Extrahiert aus App.tsx (reine Funktionen, keine Hooks/kein Store-Zugriff — die
// Aktionen kommen als `MenuActions` von App herein). Bezeichner englisch,
// Kommentare deutsch (CONVENTIONS.md).

import { t } from "../i18n";
import { canSetVertexType, vertexTypeOf, type PolylineVertexType } from "../core";
import { nearestPolylineTarget, toleranceFor } from "../core";
import type { LayerCategory, Project, Vec2 } from "../model/types";
import { flattenCategories } from "../model/types";
import { findCategory } from "../state/projectSlice";
import { MenuIcon } from "../ui/ContextMenu";
import type { ContextMenuItem } from "../ui/ContextMenu";

/** Offenes Kontextmenü (genau eines). `x/y` = Anker in Viewport-Px. */
export type MenuState =
  | { kind: "layer"; code: string; x: number; y: number }
  | { kind: "level"; id: string; x: number; y: number }
  | { kind: "plan"; wallId: string | null; model: Vec2; x: number; y: number }
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
  /** Sortiert eine Zeichnungsebene in der Überlagerungs-Reihenfolge um (z. B.
   *  eine Ansicht als Kalkierpapier-Unterlage nach hinten legen). */
  reorderLevel: (id: string, op: "front" | "back" | "forward" | "backward") => void;
  clearSelection: () => void;
  fit: () => void;
  fitSelection: () => void;
  /** Anzahl geschlossener Flächen in der aktuellen 2D-Auswahl (Boolean-Aktivierung). */
  closedSelectionCount: number;
  union: () => void;
  difference: () => void;
  intersect: () => void;
  /** Anzahl aktuell selektierter 2D-Zeichnungselemente (z-Anordnen-Menü +
   *  „Eigenschaften übertragen"). */
  drawingSelectionCount: number;
  bringToFront: () => void;
  bringForward: () => void;
  sendBackward: () => void;
  sendToBack: () => void;
  /**
   * Einzeln selektierte Polylinie (2D) — Grundlage für „Punkt einfügen/
   * löschen" im Grundriss-Kontextmenü. `null`, wenn nichts oder etwas
   * anderes selektiert ist; dann entfallen die beiden Einträge.
   */
  selectedPolyline: { id: string; pts: Vec2[]; closed: boolean; bulge?: number[] } | null;
  /** Ob eine Element-Stil-Zwischenablage gefüllt ist (aktiviert „Einfügen"). */
  hasDrawingStyleClipboard: boolean;
  /** Kopiert das Aussehen des ERSTEN gewählten 2D-Elements. */
  copyDrawingStyle: () => void;
  /** Überträgt das kopierte Aussehen auf alle gewählten 2D-Elemente. */
  pasteDrawingStyle: () => void;
  insertPolylinePoint: (id: string, segIndex: number, pt: Vec2) => void;
  deletePolylinePoint: (id: string, index: number) => void;
  setPolylineVertexType: (id: string, index: number, type: PolylineVertexType) => void;
  /** Anzahl aktuell selektierter Elemente ÜBER ALLE Arten (Wand/2D/Decke/
   *  Raum/Treppe/Stütze/Dach/Öffnung) — Grundlage für „Sperren"/„Entsperren". */
  lockableSelectionCount: number;
  /** Sind ALLE aktuell gewählten Elemente bereits gesperrt? Bestimmt Label/Icon. */
  selectionAllLocked: boolean;
  /** Sperrt/entsperrt die gesamte aktuelle Auswahl in einem Zug. */
  toggleSelectionLock: () => void;
  /** Anzeigenamen der Ebenen (Kategorien) der aktuellen Auswahl — leer ohne Auswahl. */
  selectionLayerNames: string[];
  /** Blendet die Ebene(n) der aktuellen Auswahl aus (ein Undo-Schritt). */
  hideSelectionLayers: () => void;
  /** Zeigt NUR die Ebene(n) der aktuellen Auswahl, alle übrigen werden ausgeblendet. */
  isolateSelectionLayers: () => void;
  /**
   * Sind ALLE aktuell gewählten 2D-Zeichnungen bereits `noPrint`? Bestimmt
   * Label/Icon von „Nicht drucken"/„Drucken" — nur `Drawing2D` kennt das
   * Feld (Nutzer-Wunsch „Kein 'nicht druckend'-Flag"), daher an
   * `drawingSelectionCount` gekoppelt statt einer eigenen Zählung.
   */
  selectionAllNoPrint: boolean;
  /** Setzt/löscht `noPrint` für die gesamte aktuelle 2D-Auswahl in einem Zug. */
  toggleSelectionNoPrint: () => void;
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
      return planMenuItems(menu.wallId, menu.model, a);
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
    // Überlagerungs-Reihenfolge (wie beim 2D-z-Anordnen): wirkt, sobald mehrere
    // Ebenen gleichzeitig sichtbar sind (Geschoss-/Zeichnungs-Überlagerung,
    // Schnitt-/Ansichts-Referenzüberlagerung) — Nutzer-Wunsch "Ansichten in den
    // Hintergrund legen können".
    {
      label: t("ctx.arrange.front"),
      icon: <MenuIcon name="flip_to_front" />,
      onClick: () => a.reorderLevel(id, "front"),
    },
    {
      label: t("ctx.arrange.forward"),
      icon: <MenuIcon name="arrow_upward" />,
      onClick: () => a.reorderLevel(id, "forward"),
    },
    {
      label: t("ctx.arrange.backward"),
      icon: <MenuIcon name="arrow_downward" />,
      onClick: () => a.reorderLevel(id, "backward"),
    },
    {
      label: t("ctx.arrange.back"),
      icon: <MenuIcon name="flip_to_back" />,
      onClick: () => a.reorderLevel(id, "back"),
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
  model: Vec2,
  a: MenuActions,
): ContextMenuItem[] {
  // Stützpunkt-Einträge NUR, wenn genau eine Polylinie selektiert ist UND der
  // Rechtsklick nahe genug an ihr liegt (sonst würde „Punkt löschen" einen
  // weit entfernten, nicht gemeinten Eckpunkt treffen).
  const poly = a.selectedPolyline;
  const target = poly ? nearestPolylineTarget(poly, model, toleranceFor(poly)) : null;
  const pointItems: ContextMenuItem[] = [];
  if (poly && target?.kind === "segment") {
    pointItems.push({
      label: t("ctx.insertPoint"),
      icon: <MenuIcon name="add_circle" />,
      onClick: () => a.insertPolylinePoint(poly.id, target.segIndex, target.at),
    });
  }
  if (poly && target?.kind === "vertex") {
    const min = poly.closed ? 4 : 3;
    const enabled = poly.pts.length >= min;
    pointItems.push({
      label: t("ctx.deletePoint"),
      icon: <MenuIcon name="do_not_disturb_on" />,
      disabled: !enabled,
      title: enabled ? undefined : t("alert.polylineMinPoints"),
      onClick: () => a.deletePolylinePoint(poly.id, target.index),
    });
    // Punkttyp (ArchiCAD/Vectorworks): Eckpunkt / Bogenpunkt / Splinepunkt.
    const current = vertexTypeOf(poly, target.index);
    const typeItem = (type: PolylineVertexType, key: string, icon: string): ContextMenuItem => {
      const possible = canSetVertexType(poly, target.index, type);
      return {
        label: `${current === type ? "✓ " : ""}${t(key)}`,
        icon: <MenuIcon name={icon} />,
        disabled: !possible,
        title: possible ? undefined : t("ctx.vertexType.needsNeighbors"),
        onClick: () => a.setPolylineVertexType(poly.id, target.index, type),
      };
    };
    pointItems.push(
      typeItem("corner", "ctx.vertexType.corner", "north_east"),
      typeItem("arc", "ctx.vertexType.arc", "radio_button_unchecked"),
      typeItem("spline", "ctx.vertexType.spline", "gesture"),
    );
  }
  // Eigenschaften übertragen — dasselbe Muster wie im Ebenen-Menü, nur für
  // 2D-Elemente. Kopieren ab einem gewählten Element, Einfügen sobald etwas
  // in der Zwischenablage liegt.
  const styleItems: ContextMenuItem[] =
    a.drawingSelectionCount >= 1
      ? [
          {
            label: t("ctx.copyProps"),
            icon: <MenuIcon name="content_copy" />,
            onClick: a.copyDrawingStyle,
          },
          {
            label: t("ctx.pasteProps"),
            icon: <MenuIcon name="content_paste" />,
            disabled: !a.hasDrawingStyleClipboard,
            title: a.hasDrawingStyleClipboard ? undefined : t("ctx.pasteProps.disabled"),
            onClick: a.pasteDrawingStyle,
          },
        ]
      : [];

  // Objekt sperren/entsperren — wirkt auf die GANZE aktuelle Auswahl (nicht
  // nur 2D-Zeichnungen wie `styleItems`/`arrangeItems`), ein Undo-Schritt.
  const lockItems: ContextMenuItem[] =
    a.lockableSelectionCount >= 1
      ? [
          {
            label: a.selectionAllLocked ? t("ctx.unlock") : t("ctx.lock"),
            icon: <MenuIcon name={a.selectionAllLocked ? "lock_open" : "lock"} />,
            onClick: a.toggleSelectionLock,
          },
        ]
      : [];

  // Ebene(n) der Auswahl ausblenden / nur diese zeigen. Beschriftung nennt bei
  // EINER Ebene deren Namen ("Ebene ausblenden: 01421"), sonst die Anzahl.
  const layerLabel = (key: "ctx.hideLayer" | "ctx.isolateLayer"): string =>
    a.selectionLayerNames.length === 1
      ? t(key, { name: a.selectionLayerNames[0] })
      : t(`${key}.n` as "ctx.hideLayer.n", { n: a.selectionLayerNames.length });
  const layerItems: ContextMenuItem[] =
    a.selectionLayerNames.length >= 1
      ? [
          {
            label: layerLabel("ctx.hideLayer"),
            icon: <MenuIcon name="visibility_off" />,
            onClick: a.hideSelectionLayers,
          },
          {
            label: layerLabel("ctx.isolateLayer"),
            icon: <MenuIcon name="filter_alt" />,
            onClick: a.isolateSelectionLayers,
          },
        ]
      : [];

  // Nicht drucken/Drucken — nur für die 2D-Auswahl (`Drawing2D.noPrint`).
  const noPrintItems: ContextMenuItem[] =
    a.drawingSelectionCount >= 1
      ? [
          {
            label: a.selectionAllNoPrint ? t("ctx.print") : t("ctx.noPrint"),
            icon: <MenuIcon name={a.selectionAllNoPrint ? "print" : "print_disabled"} />,
            onClick: a.toggleSelectionNoPrint,
          },
        ]
      : [];

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
      ...pointItems,
      ...(pointItems.length ? [{ divider: true } as ContextMenuItem] : []),
      ...styleItems,
      ...(styleItems.length ? [{ divider: true } as ContextMenuItem] : []),
      ...lockItems,
      ...(lockItems.length ? [{ divider: true } as ContextMenuItem] : []),
      ...layerItems,
      ...(layerItems.length ? [{ divider: true } as ContextMenuItem] : []),
      ...noPrintItems,
      ...(noPrintItems.length ? [{ divider: true } as ContextMenuItem] : []),
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
    ...pointItems,
    ...(pointItems.length ? [{ divider: true } as ContextMenuItem] : []),
    ...styleItems,
    ...(styleItems.length ? [{ divider: true } as ContextMenuItem] : []),
    ...lockItems,
    ...(lockItems.length ? [{ divider: true } as ContextMenuItem] : []),
    ...layerItems,
    ...(layerItems.length ? [{ divider: true } as ContextMenuItem] : []),
    ...noPrintItems,
    ...(noPrintItems.length ? [{ divider: true } as ContextMenuItem] : []),
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
