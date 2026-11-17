import { memo } from "react";
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
import { openRenderDialog } from "../state/renderDialogHook";
import { create3dDocument } from "../state/doc3dAction";
import { openAboutDialog } from "../state/aboutDialogHook";
import { openBugReport, openQuickGuide } from "../state/helpMenuHook";
import { openShortcutOverview } from "../state/shortcutOverviewHook";
import { openImageExportDialog } from "../state/imageExportDialogHook";
import { createElevationSet } from "../state/elevationSet";

export interface AppMenuBarProps {
  /** Datei: Neu/Neu aus Vorlage/Öffnen/Speichern/Importieren. */
  onNewProject: () => void;
  onNewProjectFromSample: () => void;
  onNewProjectFromComplexSample: () => void;
  onNewProjectFromWettbewerbSample: () => void;
  onNewProjectFromTemplate: () => void;
  onOpenProject: () => void;
  onSaveProject: () => void;
  onSaveProjectAs: () => void;
  /** Datei: vorige Fassung (.obp~) der aktuellen Datei wiederherstellen ([116]). */
  onRestoreBackup: () => void;
  onImport: () => void;
  /** Datei: Punktwolke importieren ([27]). */
  onImportPointCloud?: () => void;
  onImportMesh?: () => void;
  /** Datei: Export-Dialoge (im Browser/Electron die einzige Quelle — das native Menü gibt es nur unter Tauri). */
  onExportPdf?: () => void;
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
export const AppMenuBar = memo(function AppMenuBar({
  onNewProject,
  onNewProjectFromSample,
  onNewProjectFromComplexSample,
  onNewProjectFromWettbewerbSample,
  onNewProjectFromTemplate,
  onOpenProject,
  onSaveProject,
  onSaveProjectAs,
  onRestoreBackup,
  onImport,
  onImportPointCloud,
  onImportMesh,
  onExportPdf,
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
    { label: t("file.newFromComplexSample"), onSelect: onNewProjectFromComplexSample },
    { label: t("file.newFromWettbewerbSample"), onSelect: onNewProjectFromWettbewerbSample },
    { label: t("file.newFromTemplateFile"), onSelect: onNewProjectFromTemplate },
    { divider: true },
    { label: t("file.open"), onSelect: onOpenProject },
    { label: t("file.save"), onSelect: onSaveProject },
    { label: t("menu.native.saveAs"), onSelect: onSaveProjectAs },
    { label: t("menu.native.restoreBackup"), onSelect: onRestoreBackup },
    { divider: true },
    { label: t("file.import"), onSelect: onImport },
    ...(onImportPointCloud ? [{ label: t("menu.native.importPointCloud"), onSelect: onImportPointCloud }] : []),
    ...(onImportMesh ? [{ label: t("menu.native.importMesh"), onSelect: onImportMesh }] : []),
    ...(onExportPdf || onExportDxf || onExportIfc || onExportObj || onExportStl ? [{ divider: true }] : []),
    ...(onExportPdf ? [{ label: `${t("menu.native.export")}: PDF`, onSelect: onExportPdf }] : []),
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
    { divider: true },
    // [267] Ansichten Nord/Ost/Süd/West um das Gebäude anlegen (ein Undo-Schritt, Meldung statt Dialog).
    { label: t("menu.view.elevations"), onSelect: createElevationSet },
    { divider: true },
    // [211] Rendering mit Blender/Cycles (Dialog in App montiert, Öffner über den Modul-Hook).
    { label: t("menu.view.image3d"), onSelect: openImageExportDialog },
    // [266] 3D-Dokument: die aktuelle 3D-Kamera als Vektorzeichnung (Ausschnitt + Blatt).
    { label: t("menu.view.doc3d"), onSelect: () => void create3dDocument() },
    { label: t("menu.view.rendering"), onSelect: openRenderDialog, preview: true },
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

  const helpItems: DropdownItem[] = [
    { label: t("menu.help.guide"), onSelect: openQuickGuide },
    { label: t("menu.help.shortcuts"), onSelect: openShortcutOverview },
    { label: t("menu.help.bugReport"), onSelect: openBugReport },
    { divider: true },
    // [263] Auf macOS (natives Menü) steht „Über dossier“ im App-Menü; dieses Menü gibt es nur im Browser/Electron.
    { label: t("menu.help.about"), onSelect: openAboutDialog },
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
      <Dropdown
        items={helpItems}
        placeholder={t("menu.help")}
        title={t("menu.help")}
        triggerClassName="tb-menubar-item"
      />
    </div>
  );
});
