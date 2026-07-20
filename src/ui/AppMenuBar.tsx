// Klassische Menüleiste (Bearbeiten/Ansicht/Fenster) neben der Wortmarke in
// der TopBar — ergänzt die bestehende Quick-Access-Icon-Leiste um textuelle
// Menüs im Rhino-/Desktop-Stil. Reine Darstellung + Callbacks (voll gesteuert,
// wie die übrige TopBar); jeder Eintrag ruft eine bereits existierende
// App.tsx-Funktion auf (kein Dummy-/Platzhalter-Eintrag).
//
// Bezeichner englisch, UI-Text über i18n (CONVENTIONS.md).

import { Dropdown } from "./Dropdown";
import type { DropdownItem } from "./Dropdown";
import { t } from "../i18n";
import type { View3d, ViewType } from "./TopBar";

export interface AppMenuBarProps {
  /** Bearbeiten: Undo/Redo (Store) + Löschen der aktuellen Auswahl. */
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  onDeleteSelection: () => void;
  hasSelection: boolean;

  /** Ansicht: Grundriss/Perspektive-Umschalter, 3D-Blickwinkel-Presets,
   * Referenzlinien-Toggle. */
  viewType: ViewType;
  onViewType: (v: ViewType) => void;
  view3d: View3d;
  onView3d: (v: View3d) => void;
  referenceLines: boolean;
  onReferenceLines: (v: boolean) => void;

  /** Fenster: Ressourcen-Fenster + Einstellungen (bestehende Panels). */
  resourcesOpen: boolean;
  onToggleResources: () => void;
  onOpenSettings: () => void;
}

/** Menüleiste (Bearbeiten/Ansicht/Fenster) — sitzt in der TopBar neben der Wortmarke. */
export function AppMenuBar({
  onUndo,
  onRedo,
  canUndo,
  canRedo,
  onDeleteSelection,
  hasSelection,
  viewType,
  onViewType,
  view3d,
  onView3d,
  referenceLines,
  onReferenceLines,
  resourcesOpen,
  onToggleResources,
  onOpenSettings,
}: AppMenuBarProps) {
  const editItems: DropdownItem[] = [
    { label: t("menu.edit.undo"), onSelect: onUndo, disabled: !canUndo },
    { label: t("menu.edit.redo"), onSelect: onRedo, disabled: !canRedo },
    { divider: true },
    {
      label: t("menu.edit.delete"),
      onSelect: onDeleteSelection,
      disabled: !hasSelection,
      danger: true,
    },
  ];

  const VIEW3D_PRESETS: [View3d, string][] = [
    ["front", t("view3d.front")],
    ["back", t("view3d.back")],
    ["side", t("view3d.side")],
    ["left", t("view3d.left")],
    ["top", t("view3d.top")],
    ["iso", t("view3d.iso")],
    ["perspective", t("view3d.perspective")],
  ];
  const viewItems: DropdownItem[] = [
    {
      label: t("menu.view.floorplan"),
      onSelect: () => onViewType("grundriss"),
      active: viewType === "grundriss",
    },
    {
      label: t("menu.view.perspective"),
      onSelect: () => onViewType("perspektive"),
      active: viewType === "perspektive",
    },
    { divider: true },
    ...VIEW3D_PRESETS.map(([id, label]) => ({
      label,
      onSelect: () => onView3d(id),
      active: view3d === id,
      disabled: viewType !== "perspektive",
    })),
    { divider: true },
    {
      label: t("menu.view.referenceLines"),
      onSelect: () => onReferenceLines(!referenceLines),
      active: referenceLines,
    },
  ];

  const windowItems: DropdownItem[] = [
    {
      label: t("menu.window.resources"),
      onSelect: onToggleResources,
      active: resourcesOpen,
    },
    { divider: true },
    { label: t("menu.window.settings"), onSelect: onOpenSettings },
  ];

  return (
    <div className="tb-menubar" role="menubar">
      <Dropdown
        items={editItems}
        placeholder={t("menu.edit")}
        title={t("menu.edit")}
        triggerClassName="tb-menubar-item"
      />
      <Dropdown
        items={viewItems}
        placeholder={t("menu.view")}
        title={t("menu.view")}
        triggerClassName="tb-menubar-item"
      />
      <Dropdown
        items={windowItems}
        placeholder={t("menu.window")}
        title={t("menu.window")}
        triggerClassName="tb-menubar-item"
      />
    </div>
  );
}
