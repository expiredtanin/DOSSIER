// Kopfzeilen-Elemente der App ([163], aus App.tsx herausgelöst): die In-App-Menüleiste (nur im
// Browser/Electron; unter Tauri übernimmt das native Menü) und das Ansichts-Ribbon (`ViewRibbonTab`)
// samt Ebenen-/Zeichnungs-Kombinationen — als memoisierte Elemente mit denselben Abhängigkeiten wie
// zuvor ([121]), damit ein App-Render sie nicht neu zeichnet. Aufgerufen von `App.tsx` für die `TopBar`.

import { useMemo } from "react";
import type { DrawingLevel, ModelViewOption, ViewType } from "../model/types";
import { currentModelViewId, modelViewChoices } from "../state/modelViews";
import type { TextStylePreset } from "../text/richText";
import { isTauriRuntime } from "../native/projectFile";
import type { useTopBarState } from "../state/useTopBarState";
import {
  deleteDrawingCombo,
  deleteLayerCombo,
  listDrawingCombos,
  listLayerCombos,
} from "../state/visibilitySets";
import { AppMenuBar, type AppMenuBarProps } from "./AppMenuBar";
import { ViewRibbonTab, type ComboMenuHandlers, type TextTarget, type ViewRibbonTabProps } from "./TopBar";

type TopBar = ReturnType<typeof useTopBarState>;

/** Stabile Handler aus dem Bündel der App (`useEventBundle`). */
export type TopBarEvents = Required<
  Pick<
    AppMenuBarProps,
    | "onNewProject"
    | "onNewProjectFromSample"
    | "onNewProjectFromComplexSample"
    | "onNewProjectFromTemplate"
    | "onOpenProject"
    | "onSaveProject"
    | "onSaveProjectAs"
    | "onImport"
    | "onImportPointCloud"
    | "onImportMesh"
    | "onExportIfc"
    | "onExportObj"
    | "onExportStl"
    | "onDeleteSelection"
    | "onToggleResources"
    | "onOpenSettings"
    | "onOpenBcf"
    | "onOpenHistory"
  >
> & {
  onOpenExportDxf: () => void;
  applyScale: ViewRibbonTabProps["onApplyScale"];
  fitPlan: ViewRibbonTabProps["onFit"];
  fitSelection: ViewRibbonTabProps["onFitSelection"];
  zoomToApplied: ViewRibbonTabProps["onZoom100"];
  onShadows: ViewRibbonTabProps["onShadows"];
  onSketch: ViewRibbonTabProps["onSketch"];
  /** [173] Modelldarstellung der aktiven Ansicht wählen (Werkzeugleiste). */
  onModelView: (id: string) => void;
  saveLayerCombo: ComboMenuHandlers["saveLayerCombo"];
  loadLayerCombo: ComboMenuHandlers["loadLayerCombo"];
  saveDrawingCombo: ComboMenuHandlers["saveDrawingCombo"];
  loadDrawingCombo: ComboMenuHandlers["loadDrawingCombo"];
};

export function useTopBarElements(opts: {
  ev: TopBarEvents;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  hasSelection: boolean;
  viewType: ViewType;
  setViewType: (v: ViewType) => void;
  view3d: TopBar["view3d"];
  setView3d: TopBar["setView3d"];
  referenceLines: boolean;
  setReferenceLines: TopBar["setReferenceLines"];
  resourcesOpen: boolean;
  has3dView: boolean;
  planActive: boolean;
  detail: TopBar["detail"];
  setDetail: TopBar["setDetail"];
  scaleDenominator: number;
  renderMode: TopBar["renderMode"];
  setRenderMode: TopBar["setRenderMode"];
  planColorMode: TopBar["planColorMode"];
  setPlanColorMode: TopBar["setPlanColorMode"];
  activeLevel: DrawingLevel;
  /** [173] Eigene Modelldarstellungen des Projekts. */
  modelViewOptions?: ModelViewOption[];
  textTarget: TextTarget | null;
  textStyles: TextStylePreset[];
}) {
  const {
    ev,
    undo,
    redo,
    canUndo,
    canRedo,
    hasSelection,
    viewType,
    setViewType,
    view3d,
    setView3d,
    referenceLines,
    setReferenceLines,
    resourcesOpen,
    has3dView,
    planActive,
    detail,
    setDetail,
    scaleDenominator,
    renderMode,
    setRenderMode,
    planColorMode,
    setPlanColorMode,
    activeLevel,
    modelViewOptions,
    textTarget,
    textStyles,
  } = opts;
  // Unter Tauri (macOS) übernimmt die native Systemmenüleiste (oben am Bildschirm,
  // useNativeAppMenu) exakt dieselben Aktionen bereits — die In-App-Menüleiste wäre reine
  // Dopplung und kostet nur Platz in der Kopfzeile. Im Browser/Electron (kein natives
  // App-Menü) bleibt sie die einzige Quelle dafür.
  const menuBarEl = useMemo(
    () =>
      isTauriRuntime() ? undefined : (
        <AppMenuBar
          onNewProject={ev.onNewProject}
          onNewProjectFromSample={ev.onNewProjectFromSample}
          onNewProjectFromComplexSample={ev.onNewProjectFromComplexSample}
          onNewProjectFromTemplate={ev.onNewProjectFromTemplate}
          onOpenProject={ev.onOpenProject}
          onSaveProject={ev.onSaveProject}
          onSaveProjectAs={ev.onSaveProjectAs}
          onImport={ev.onImport}
          onImportPointCloud={ev.onImportPointCloud}
          onImportMesh={ev.onImportMesh}
          onExportDxf={ev.onOpenExportDxf}
          onExportIfc={ev.onExportIfc}
          onExportObj={ev.onExportObj}
          onExportStl={ev.onExportStl}
          onUndo={undo}
          onRedo={redo}
          canUndo={canUndo}
          canRedo={canRedo}
          onDeleteSelection={ev.onDeleteSelection}
          hasSelection={hasSelection}
          viewType={viewType}
          onViewType={setViewType}
          view3d={view3d}
          onView3d={setView3d}
          referenceLines={referenceLines}
          onReferenceLines={setReferenceLines}
          resourcesOpen={resourcesOpen}
          onToggleResources={ev.onToggleResources}
          onOpenSettings={ev.onOpenSettings}
          onOpenBcf={ev.onOpenBcf}
          onOpenHistory={ev.onOpenHistory}
        />
      ),
    [ev, undo, redo, canUndo, canRedo, hasSelection, viewType, setViewType, view3d, setView3d, referenceLines, setReferenceLines, resourcesOpen],
  );
  const combos = useMemo(
    () => ({
      listLayerCombos,
      saveLayerCombo: ev.saveLayerCombo,
      loadLayerCombo: ev.loadLayerCombo,
      deleteLayerCombo,
      listDrawingCombos,
      saveDrawingCombo: ev.saveDrawingCombo,
      loadDrawingCombo: ev.loadDrawingCombo,
      deleteDrawingCombo,
    }),
    [ev],
  );
  const shadowsAvailable = activeLevel.kind === "elevation";
  const shadows = activeLevel.shadows ?? false;
  // [67] Skizzenstil: Grundriss, Schnitt, Ansicht (nicht auf Blättern).
  const sketchAvailable = !activeLevel.layoutId && (activeLevel.kind === "floor" || activeLevel.kind === "section" || activeLevel.kind === "elevation");
  const sketch = activeLevel.sketch ?? false;
  const viewControlsEl = useMemo(
    () => (
      <ViewRibbonTab
        viewToggleEnabled={true} /* [182] 3D/Grundriss sind aus jedem Reiter erreichbar */
        viewType={viewType}
        onViewType={setViewType}
        view3d={view3d}
        onView3d={setView3d}
        detail={detail}
        onDetail={setDetail}
        modelViews={modelViewChoices(modelViewOptions)}
        modelViewId={currentModelViewId(activeLevel, detail, modelViewOptions)}
        onModelView={ev.onModelView}
        // Detailgrad wirkt im Grundriss UND in der 3D-Sicht
        // (projectToModel3d bekommt `detail` durchgereicht).
        // [173] auch Schnitt und Ansicht: die Modelldarstellung wirkt dort (Schichten, Öffnungen, Schatten …).
        detailEnabled={planActive || viewType === "perspektive" || (viewType === "grundriss" && (activeLevel.kind === "section" || activeLevel.kind === "elevation"))}
        scaleDenominator={scaleDenominator}
        onApplyScale={ev.applyScale}
        zoomEnabled={planActive}
        onFit={ev.fitPlan}
        onFitSelection={ev.fitSelection}
        onZoom100={ev.zoomToApplied}
        renderMode={renderMode}
        onRenderMode={setRenderMode}
        renderModeEnabled={viewType === "perspektive"}
        planColorMode={planColorMode}
        onPlanColorMode={setPlanColorMode}
        shadowsAvailable={shadowsAvailable}
        shadows={shadows}
        onShadows={ev.onShadows}
        sketchAvailable={sketchAvailable}
        sketch={sketch}
        onSketch={ev.onSketch}
        combos={combos}
        textTarget={textTarget}
        textStyles={textStyles}
      />
    ),
    [
      ev,
      combos,
      has3dView,
      viewType,
      setViewType,
      view3d,
      setView3d,
      detail,
      setDetail,
      planActive,
      scaleDenominator,
      renderMode,
      setRenderMode,
      planColorMode,
      setPlanColorMode,
      shadowsAvailable,
      shadows,
      sketchAvailable,
      sketch,
      textTarget,
      textStyles,
      activeLevel.modelViewOptionId,
      activeLevel.kind,
      modelViewOptions,
    ],
  );

  return { menuBarEl, viewControlsEl };
}
