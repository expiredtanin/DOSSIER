// Native macOS-Systemmenüleiste (oben am Bildschirm) — NICHT zu verwechseln mit
// AppMenuBar (die In-App-Menüleiste in der TopBar). Nutzt die Tauri-v2-Menu-API
// (@tauri-apps/api/menu), die einen echten macOS-App-Menü-Baum baut. No-op im
// reinen Browser (kein Tauri) — s. isTauriRuntime.
//
// Aufbau: EIN Menü-Baum wird beim Mount EINMAL erzeugt (MenuItem.new ist async
// und teuer genug, um es nicht bei jedem Render neu zu bauen); alle Aktionen
// laufen über eine Ref auf die jeweils aktuellen Handler (klassisches Ref-
// Pattern gegen veraltete Closures, wie `toolShortcutRef` in App.tsx). Enabled-
// /Checked-Zustand (Undo/Redo/Löschen/Ansicht) wird in einem separaten Effekt
// synchron zum React-State über `setEnabled`/`setChecked` nachgezogen.
//
// Bezeichner englisch, UI-Text über i18n (CONVENTIONS.md).

import { useEffect, useRef } from "react";
import { isTauriRuntime } from "./projectFile";
import { t } from "../i18n";
import { APP_VERSION } from "../ui/TopBar";
import type { View3d, ViewType } from "../model/viewTypes";
import type { SelectionActionId } from "../state/selectionActions";

/** Alle Aktionen, die die native Menüleiste auslösen kann. */
export interface NativeAppMenuHandlers {
  onNewProject: () => void;
  onNewProjectFromSample: () => void;
  onNewProjectFromComplexSample: () => void;
  onNewProjectFromTemplate: () => void;
  onOpenProject: () => void;
  onSaveProject: () => void;
  onSaveProjectAs: () => void;
  onImport: () => void;
  onExportPdf: () => void;
  onExportDxf: () => void;
  onExportSchedule: () => void;
  onExportIfc: () => void;
  onExportObj: () => void;
  onExportStl: () => void;
  onExportGlb: () => void;
  onExportStep: () => void;
  onImportStep: () => void;
  onImportIfc: () => void;
  /** Punktwolke importieren ([27]); optional für ältere Aufrufer. */
  onImportPointCloud?: () => void;
  /** 3D-Modell importieren (OBJ/STL/glTF/GLB/PLY). */
  onImportMesh?: () => void;
  onClashCheck: () => void;
  onKennzahlen: () => void;

  onUndo: () => void;
  onRedo: () => void;
  onDeleteSelection: () => void;
  onMove: () => void;
  onMirror: () => void;
  onRotate: () => void;
  /** [189] Einstellungen des gewählten Objekts (Taste T; als Menüpunkt ohne Kürzel, ein nacktes „T" würde das Tippen in Textfeldern abfangen). */
  onObjectSettings?: () => void;

  onViewType: (v: ViewType) => void;
  onView3d: (v: View3d) => void;
  onReferenceLines: (v: boolean) => void;
  /** [185] Geschoss tiefer (−1, Cmd+5) / höher (+1, Cmd+6) im Grundriss-/3D-Reiter. */
  onFloorStep?: (dir: 1 | -1) => void;
  /** [185] Auswahl in 3D zeigen (Cmd+3; ohne Auswahl alles). */
  onShowSelection3d?: () => void;
  /** [185] Auswahl im 3D ausblenden (Cmd+4). */
  onHideSelection3d?: () => void;
  /** [190] Auswahl-Aktionen mit Kürzel (Cmd+D/J/L, Cmd+0, Cmd+Shift+F/H/A), s. `state/selectionActions.ts`. */
  onSelectionAction?: (id: SelectionActionId) => void;

  onToggleResources: () => void;
  onOpenSettings: () => void;
  /** Macht das Panel mit dieser ID sichtbar (siehe `revealPanel` in panels/layout.ts). */
  onOpenPanel: (panelId: string) => void;
  /** Öffnet den Zeichnungsebenen-Manager als eigenes Fenster (zusätzlich zum Dock-Panel). */
  onOpenDrawingLevelsWindow: () => void;
  /** Öffnet die Ebeneneinstellungen für die aktuell aktive Ebene (activeCategoryCode). */
  onOpenLayerSettingsWindow: () => void;
  /** Öffnet den Standort-Import (swisstopo/OSM). */
  onOpenContextImportWindow: () => void;
}

/** Ein Eintrag für „Fenster > Panels" — id + fertiges i18n-Label. */
export interface NativeAppMenuPanel {
  id: string;
  label: string;
}

/** Ortsabhängiger Zustand, der Enabled-/Checked-Häkchen der Menüpunkte treibt. */
export interface NativeAppMenuState {
  canUndo: boolean;
  canRedo: boolean;
  hasSelection: boolean;
  viewType: ViewType;
  view3d: View3d;
  referenceLines: boolean;
  resourcesOpen: boolean;
}

const VIEW3D_IDS: View3d[] = [
  "front",
  "back",
  "side",
  "left",
  "top",
  "iso",
  "perspective",
];

/**
 * Baut die native macOS-Menüleiste einmal auf und hält Enabled-/Checked-
 * Zustand synchron zum übergebenen `state`. `handlers` darf sich bei jedem
 * Render ändern (wird über eine Ref gelesen, kein Neu-Erzeugen der Menüpunkte).
 */
export function useNativeAppMenu(
  handlers: NativeAppMenuHandlers,
  state: NativeAppMenuState,
  panels: NativeAppMenuPanel[],
): void {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  // Panel-Liste ist beim Mount bekannt (Registry ist statisch) — als Ref nur,
  // damit der Aufbau-Effekt (deps: []) sie ohne Lint-Warnung lesen darf.
  const panelsRef = useRef(panels);
  panelsRef.current = panels;

  // Menüpunkte, die Enabled-/Checked-Zustand nachgezogen bekommen — als Ref,
  // damit der Sync-Effekt unten sie ohne Neu-Aufbau erreicht.
  const itemsRef = useRef<{
    undo?: import("@tauri-apps/api/menu").MenuItem;
    redo?: import("@tauri-apps/api/menu").MenuItem;
    delete?: import("@tauri-apps/api/menu").MenuItem;
    floorplan?: import("@tauri-apps/api/menu").CheckMenuItem;
    perspective?: import("@tauri-apps/api/menu").CheckMenuItem;
    view3d: Map<View3d, import("@tauri-apps/api/menu").CheckMenuItem>;
    referenceLines?: import("@tauri-apps/api/menu").CheckMenuItem;
    resources?: import("@tauri-apps/api/menu").CheckMenuItem;
  }>({ view3d: new Map() });

  // Baut den Menü-Baum EINMAL. Aktionen rufen ausschliesslich über
  // `handlersRef.current` — so bleibt der Baum stabil, während die
  // eigentlichen Callbacks (aus App.tsx, jeden Render neu) trotzdem aktuell
  // bleiben.
  useEffect(() => {
    if (!isTauriRuntime()) return;
    let disposed = false;
    void (async () => {
      const {
        Menu,
        Submenu,
        MenuItem,
        CheckMenuItem,
        PredefinedMenuItem,
      } = await import("@tauri-apps/api/menu");
      if (disposed) return;

      const fileMenu = await Submenu.new({
        text: t("menu.native.file"),
        items: [
          await MenuItem.new({
            text: t("menu.native.new"),
            accelerator: "CmdOrCtrl+N",
            action: () => handlersRef.current.onNewProject(),
          }),
          await Submenu.new({
            text: t("menu.native.newFromTemplate"),
            items: [
              await MenuItem.new({
                text: t("menu.native.newFromSample"),
                action: () => handlersRef.current.onNewProjectFromSample(),
              }),
              await MenuItem.new({
                text: t("menu.native.newFromComplexSample"),
                action: () => handlersRef.current.onNewProjectFromComplexSample(),
              }),
              await MenuItem.new({
                text: t("menu.native.newFromTemplateFile"),
                action: () => handlersRef.current.onNewProjectFromTemplate(),
              }),
            ],
          }),
          await PredefinedMenuItem.new({ item: "Separator" }),
          await MenuItem.new({
            text: t("menu.native.open"),
            accelerator: "CmdOrCtrl+O",
            action: () => handlersRef.current.onOpenProject(),
          }),
          await MenuItem.new({
            text: t("menu.native.save"),
            accelerator: "CmdOrCtrl+S",
            action: () => handlersRef.current.onSaveProject(),
          }),
          await MenuItem.new({
            text: t("menu.native.saveAs"),
            accelerator: "CmdOrCtrl+Shift+S",
            action: () => handlersRef.current.onSaveProjectAs(),
          }),
          await MenuItem.new({
            text: t("menu.native.import"),
            action: () => handlersRef.current.onImport(),
          }),
          await MenuItem.new({
            text: t("menu.native.importStep"),
            action: () => handlersRef.current.onImportStep(),
          }),
          await MenuItem.new({
            text: t("menu.native.importIfc"),
            action: () => handlersRef.current.onImportIfc(),
          }),
          await MenuItem.new({
            text: t("menu.native.importPointCloud"),
            action: () => handlersRef.current.onImportPointCloud?.(),
          }),
          await MenuItem.new({
            text: t("menu.native.importMesh"),
            action: () => handlersRef.current.onImportMesh?.(),
          }),
          await Submenu.new({
            text: t("menu.native.export"),
            items: [
              await MenuItem.new({
                text: "PDF",
                action: () => handlersRef.current.onExportPdf(),
              }),
              await MenuItem.new({
                text: "DXF",
                action: () => handlersRef.current.onExportDxf(),
              }),
              await MenuItem.new({
                text: t("menu.native.exportSchedule"),
                action: () => handlersRef.current.onExportSchedule(),
              }),
              await MenuItem.new({
                text: "IFC",
                action: () => handlersRef.current.onExportIfc(),
              }),
              await MenuItem.new({
                text: "OBJ",
                action: () => handlersRef.current.onExportObj(),
              }),
              await MenuItem.new({
                text: "STL",
                action: () => handlersRef.current.onExportStl(),
              }),
              await MenuItem.new({
                text: "glTF (GLB)",
                action: () => handlersRef.current.onExportGlb(),
              }),
              await MenuItem.new({
                text: "STEP",
                action: () => handlersRef.current.onExportStep(),
              }),
            ],
          }),
        ],
      });

      const undoItem = await MenuItem.new({
        text: t("menu.edit.undo"),
        accelerator: "CmdOrCtrl+Z",
        action: () => handlersRef.current.onUndo(),
      });
      const redoItem = await MenuItem.new({
        text: t("menu.edit.redo"),
        accelerator: "CmdOrCtrl+Shift+Z",
        action: () => handlersRef.current.onRedo(),
      });
      const deleteItem = await MenuItem.new({
        text: t("menu.edit.delete"),
        action: () => handlersRef.current.onDeleteSelection(),
      });
      itemsRef.current.undo = undoItem;
      itemsRef.current.redo = redoItem;
      itemsRef.current.delete = deleteItem;

      const editMenu = await Submenu.new({
        text: t("menu.native.edit"),
        items: [
          undoItem,
          redoItem,
          await PredefinedMenuItem.new({ item: "Separator" }),
          deleteItem,
          // [190] Archicad-Kürzel (dieselben laufen im Browser über `useSelectionActionShortcuts`).
          await MenuItem.new({
            text: t("menu.edit.duplicate"),
            accelerator: "CmdOrCtrl+D",
            action: () => handlersRef.current.onSelectionAction?.("duplicate"),
          }),
          await MenuItem.new({
            text: t("menu.edit.join"),
            accelerator: "CmdOrCtrl+J",
            action: () => handlersRef.current.onSelectionAction?.("join"),
          }),
          await MenuItem.new({
            text: t("menu.edit.toggleLock"),
            accelerator: "CmdOrCtrl+L",
            action: () => handlersRef.current.onSelectionAction?.("toggleLock"),
          }),
          await PredefinedMenuItem.new({ item: "Separator" }),
          await MenuItem.new({
            text: t("menu.native.move"),
            action: () => handlersRef.current.onMove(),
          }),
          await MenuItem.new({
            text: t("menu.native.mirror"),
            action: () => handlersRef.current.onMirror(),
          }),
          await MenuItem.new({
            text: t("menu.native.rotate"),
            action: () => handlersRef.current.onRotate(),
          }),
          await MenuItem.new({
            text: t("menu.native.objectSettings"),
            action: () => handlersRef.current.onObjectSettings?.(),
          }),
          await PredefinedMenuItem.new({ item: "Separator" }),
          await MenuItem.new({
            text: t("menu.native.clashCheck"),
            action: () => handlersRef.current.onClashCheck(),
          }),
          await MenuItem.new({
            text: t("menu.native.kennzahlen"),
            action: () => handlersRef.current.onKennzahlen(),
          }),
        ],
      });

      const floorplanItem = await CheckMenuItem.new({
        text: t("menu.view.floorplan"),
        action: () => handlersRef.current.onViewType("grundriss"),
      });
      const perspectiveItem = await CheckMenuItem.new({
        text: t("menu.view.perspective"),
        action: () => handlersRef.current.onViewType("perspektive"),
      });
      itemsRef.current.floorplan = floorplanItem;
      itemsRef.current.perspective = perspectiveItem;

      const view3dLabels: Record<View3d, string> = {
        front: t("view3d.front"),
        back: t("view3d.back"),
        side: t("view3d.side"),
        left: t("view3d.left"),
        top: t("view3d.top"),
        iso: t("view3d.iso"),
        isoFrontLeft: t("view3d.iso"),
        isoBackRight: t("view3d.iso"),
        isoBackLeft: t("view3d.iso"),
        perspective: t("view3d.perspective"),
      };
      const view3dItems: import("@tauri-apps/api/menu").CheckMenuItem[] = [];
      for (const id of VIEW3D_IDS) {
        const item = await CheckMenuItem.new({
          text: view3dLabels[id],
          action: () => handlersRef.current.onView3d(id),
        });
        itemsRef.current.view3d.set(id, item);
        view3dItems.push(item);
      }

      const referenceLinesItem = await CheckMenuItem.new({
        text: t("menu.view.referenceLines"),
        action: () => handlersRef.current.onReferenceLines(!state.referenceLines),
      });
      itemsRef.current.referenceLines = referenceLinesItem;

      const viewMenu = await Submenu.new({
        text: t("menu.native.view"),
        items: [
          floorplanItem,
          perspectiveItem,
          await PredefinedMenuItem.new({ item: "Separator" }),
          ...view3dItems,
          await PredefinedMenuItem.new({ item: "Separator" }),
          referenceLinesItem,
          // [185] Navigation wie Archicad (dieselben Kürzel laufen im Browser über `useViewNavigationShortcuts`).
          await PredefinedMenuItem.new({ item: "Separator" }),
          await MenuItem.new({
            text: t("menu.view.floorDown"),
            accelerator: "CmdOrCtrl+5",
            action: () => handlersRef.current.onFloorStep?.(-1),
          }),
          await MenuItem.new({
            text: t("menu.view.floorUp"),
            accelerator: "CmdOrCtrl+6",
            action: () => handlersRef.current.onFloorStep?.(1),
          }),
          await MenuItem.new({
            text: t("menu.view.showSelection3d"),
            accelerator: "CmdOrCtrl+3",
            action: () => handlersRef.current.onShowSelection3d?.(),
          }),
          await MenuItem.new({
            text: t("menu.view.hideSelection3d"),
            accelerator: "CmdOrCtrl+4",
            action: () => handlersRef.current.onHideSelection3d?.(),
          }),
          // [190] Einpassen und Ebenen ein-/ausblenden.
          await PredefinedMenuItem.new({ item: "Separator" }),
          await MenuItem.new({
            text: t("menu.view.fitAll"),
            accelerator: "CmdOrCtrl+0",
            action: () => handlersRef.current.onSelectionAction?.("fitAll"),
          }),
          await MenuItem.new({
            text: t("menu.view.fitSelection"),
            accelerator: "CmdOrCtrl+Shift+F",
            action: () => handlersRef.current.onSelectionAction?.("fitSelection"),
          }),
          await MenuItem.new({
            text: t("menu.view.hideSelectionLayers"),
            accelerator: "CmdOrCtrl+Shift+H",
            action: () => handlersRef.current.onSelectionAction?.("hideLayers"),
          }),
          await MenuItem.new({
            text: t("menu.view.showAllLayers"),
            accelerator: "CmdOrCtrl+Shift+A",
            action: () => handlersRef.current.onSelectionAction?.("showAllLayers"),
          }),
        ],
      });

      const resourcesItem = await CheckMenuItem.new({
        text: t("menu.window.resources"),
        action: () => handlersRef.current.onToggleResources(),
      });
      itemsRef.current.resources = resourcesItem;

      // Ein Menüpunkt je registriertem Panel (ToolsPanel/Attribute/Objekt-Info/
      // Zeichnungsebenen/Ebenen/Umgebung/Flächenbilanz/Element-Baum/Ausschnitte/
      // Layouts) — macht das jeweilige Panel sichtbar (`revealPanel`), egal ob es
      // gerade angedockt, schwebend oder gar nicht offen ist.
      const panelItems = await Promise.all(
        panelsRef.current.map((p) =>
          MenuItem.new({
            text: p.label,
            action: () => handlersRef.current.onOpenPanel(p.id),
          }),
        ),
      );
      const panelsMenu = await Submenu.new({
        text: t("menu.native.panels"),
        items: panelItems,
      });

      const windowMenu = await Submenu.new({
        text: t("menu.native.window"),
        items: [
          resourcesItem,
          await PredefinedMenuItem.new({ item: "Separator" }),
          panelsMenu,
          await MenuItem.new({
            text: t("menu.window.drawingLevels"),
            action: () => handlersRef.current.onOpenDrawingLevelsWindow(),
          }),
          await MenuItem.new({
            text: t("menu.window.layerSettings"),
            action: () => handlersRef.current.onOpenLayerSettingsWindow(),
          }),
          await MenuItem.new({
            text: t("menu.window.contextImport"),
            action: () => handlersRef.current.onOpenContextImportWindow(),
          }),
          await PredefinedMenuItem.new({ item: "Separator" }),
          await MenuItem.new({
            text: t("menu.window.settings"),
            action: () => handlersRef.current.onOpenSettings(),
          }),
        ],
      });

      // macOS: der allererste Eintrag ist das App-Menü (Über/Beenden). Ohne ihn
      // rutscht „Datei" an die Stelle, an der macOS sonst den App-Namen zeigt.
      // „Über dossier" nutzt das NATIVE macOS-Info-Fenster (PredefinedMenuItem
      // „About") statt des eigenen In-App-Dialogs (AboutDialog in TopBar.tsx) —
      // an dieser Stelle erwartet macOS exakt diesen Eintrag, kein Custom-Dialog.
      // Metadaten spiegeln den In-App-Dialog: kleingeschriebener Name „dossier",
      // Beschreibung + Lizenz/Suite als `credits` (macOS zeigt sie als Textblock
      // unter der Version), Copyright unten. Das Icon zieht macOS aus dem Bundle
      // (tauri.conf.json bundle.icon → icon.icns). Auf macOS NICHT unterstützt
      // und daher weggelassen: authors/comments/license/website.
      const appMenu = await Submenu.new({
        text: "dossier",
        items: [
          await PredefinedMenuItem.new({
            item: {
              About: {
                name: "dossier",
                version: APP_VERSION,
                shortVersion: APP_VERSION,
                copyright: t("about.copyright"),
                credits: `${t("about.desc")}\n\n${t("about.license")} · ${t("about.suite")}`,
              },
            },
            text: t("menu.native.about"),
          }),
          await PredefinedMenuItem.new({ item: "Separator" }),
          await PredefinedMenuItem.new({ item: "Quit", text: t("menu.native.quit") }),
        ],
      });

      if (disposed) return;
      const menu = await Menu.new({
        items: [appMenu, fileMenu, editMenu, viewMenu, windowMenu],
      });
      await menu.setAsAppMenu();
    })().catch((e) => {
      console.debug("useNativeAppMenu: Aufbau fehlgeschlagen (kein Tauri-Menu?)", e);
    });
    return () => {
      disposed = true;
    };
    // Nur beim Mount aufbauen — Aktionen laufen über handlersRef, State-
    // Synchronisation über den Effekt unten. Ein Neu-Aufbau bei jedem Render
    // wäre teuer (mehrere async IPC-Aufrufe) und unnötig.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Enabled-/Checked-Zustand synchron zum React-State halten (billig, kein
  // Neu-Aufbau der Menüpunkte).
  useEffect(() => {
    if (!isTauriRuntime()) return;
    const items = itemsRef.current;
    void items.undo?.setEnabled(state.canUndo);
    void items.redo?.setEnabled(state.canRedo);
    void items.delete?.setEnabled(state.hasSelection);
    void items.floorplan?.setChecked(state.viewType === "grundriss");
    void items.perspective?.setChecked(state.viewType === "perspektive");
    for (const [id, item] of items.view3d) {
      void item.setChecked(state.view3d === id);
      void item.setEnabled(state.viewType === "perspektive");
    }
    void items.referenceLines?.setChecked(state.referenceLines);
    void items.resources?.setChecked(state.resourcesOpen);
  }, [
    state.canUndo,
    state.canRedo,
    state.hasSelection,
    state.viewType,
    state.view3d,
    state.referenceLines,
    state.resourcesOpen,
  ]);
}
