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
import type { View3d, ViewType } from "../model/viewTypes";

export interface AppMenuBarProps {
  /** Datei: Neu/Neu aus Vorlage/Öffnen/Speichern/Importieren. */
  onNewProject: () => void;
  onNewProjectFromSample: () => void;
  onNewProjectFromTemplate: () => void;
  onOpenProject: () => void;
  onSaveProject: () => void;
  onImport: () => void;
  /** Datei: Punktwolke importieren ([27]). */
  onImportPointCloud?: () => void;
  onImportMesh?: () => void;
  /** Datei: Export-Dialoge (im Browser/Electron die einzige Quelle — das native Menü gibt es nur unter Tauri). */
  onExportDxf?: () => void;
  onExportIfc?: () => void;
  onExportObj?: () => void;
  onExportStl?: () => void;

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
  /** BCF-Themen-Panel öffnen (`revealPanel`); ohne diese Funktion entfällt der Menüpunkt. */
  onOpenBcf?: () => void;
  /** Verlauf-Panel öffnen ([84]). */
  onOpenHistory?: () => void;
}

/** Menüleiste (Bearbeiten/Ansicht/Fenster) — sitzt in der TopBar neben der Wortmarke. */
export function AppMenuBar({
  onNewProject,
  onNewProjectFromSample,
  onNewProjectFromTemplate,
  onOpenProject,
  onSaveProject,
  onImport,
  onImportPointCloud,
  onImportMesh,
  onExportDxf,
  onExportIfc,
  onExportObj,
  onExportStl,
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
  onOpenBcf,
  onOpenHistory,
}: AppMenuBarProps) {
  const fileItems: DropdownItem[] = [
    { label: t("file.new"), onSelect: onNewProject },
    { label: t("file.newFromSample"), onSelect: onNewProjectFromSample },
    { label: t("file.newFromTemplateFile"), onSelect: onNewProjectFromTemplate },
    { divider: true },
    { label: t("file.open"), onSelect: onOpenProject },
    { label: t("file.save"), onSelect: onSaveProject },
    { divider: true },
    { label: t("file.import"), onSelect: onImport },
    ...(onImportPointCloud ? [{ label: t("menu.native.importPointCloud"), onSelect: onImportPointCloud }] : []),
    ...(onImportMesh ? [{ label: t("menu.native.importMesh"), onSelect: onImportMesh }] : []),
    ...(onExportDxf || onExportIfc || onExportObj || onExportStl ? [{ divider: true }] : []),
    ...(onExportDxf ? [{ label: `${t("menu.native.export")}: DXF`, onSelect: onExportDxf }] : []),
    ...(onExportIfc ? [{ label: `${t("menu.native.export")}: IFC`, onSelect: onExportIfc }] : []),
    ...(onExportObj ? [{ label: `${t("menu.native.export")}: OBJ`, onSelect: onExportObj }] : []),
    ...(onExportStl ? [{ label: `${t("menu.native.export")}: STL`, onSelect: onExportStl }] : []),
  ];

  const editItems: DropdownItem[] = [
    { label: t("menu.edit.undo"), onSelect: onUndo, disabled: !canUndo },
    { label: t("menu.edit.redo"), onSelect: onRedo, disabled: !canRedo },
    ...(onOpenHistory ? [{ label: t("nav.history"), onSelect: onOpenHistory }] : []),
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
    ...(onOpenBcf ? [{ label: t("nav.bcf"), onSelect: onOpenBcf }] : []),
    { label: t("menu.window.settings"), onSelect: onOpenSettings },
  ];

  return (
    <div className="tb-menubar" role="menubar">
      <Dropdown
        items={fileItems}
        placeholder={t("file.menu")}
        title={t("file.menu")}
        triggerClassName="tb-menubar-item"
      />
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
