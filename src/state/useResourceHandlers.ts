// Ressourcen-Fenster der App ([163], aus App.tsx herausgelöst): Handler-Bündel für den
// `ResourceManager` (Typen, Bauteile, Schraffuren, Linien-/Textstile, Stifte, Paletten,
// Ansichtsvorlagen) und das Öffnen bzw. Umschalten. Aufgerufen von `App.tsx`; `openResources` geht an
// die Panels, `toggleResources` an Menüs. Den Abgleich mit dem nativen Ressourcen-Fenster (Tauri, braucht
// das ganze Projekt) macht `ProjectSync` (`src/ui/ProjectSync.tsx`), damit `App` das Projekt nicht
// abonniert ([121]).

import type { RefObject } from "react";
import type { DrawingLevel } from "../model/types";
import { isTauriRuntime } from "../native/projectFile";
import { openResourceWindowNative } from "../native/resourceWindow";
import { BUILTIN_PANEL_IDS } from "../panels/builtinPanels";
import type { ResourceManagerHandlers, TabId as ResourceTabId } from "../ui/ResourceManager";
import type { PlanViewHandle } from "../views/plan/PlanView";
import type { RootState } from "./appStore";
import type { useDialogState } from "./useDialogState";
import type { useProjectActions } from "./useProjectActions";
import type { useTopBarState } from "./useTopBarState";
import { useViewTemplateHandlers } from "./useViewTemplateHandlers";
import { modelViewHandlers } from "./useModelViewHandlers";

type TopBar = ReturnType<typeof useTopBarState>;
type Dialogs = ReturnType<typeof useDialogState>;

export function useResourceHandlers(opts: {
  applyChange: RootState["applyChange"];
  groupChanges: RootState["groupChanges"];
  activeLevel: DrawingLevel;
  detail: TopBar["detail"];
  setDetail: TopBar["setDetail"];
  scaleDenominator: TopBar["scaleDenominator"];
  setScaleDenominator: TopBar["setScaleDenominator"];
  planColorMode: TopBar["planColorMode"];
  setPlanColorMode: TopBar["setPlanColorMode"];
  modeFor: RootState["modeFor"];
  setModeFor: RootState["setModeFor"];
  planViewRef: RefObject<PlanViewHandle>;
  pa: ReturnType<typeof useProjectActions>;
  setResourcesTab: Dialogs["setResourcesTab"];
  setResourcesOpen: Dialogs["setResourcesOpen"];
}) {
  const {
    applyChange,
    groupChanges,
    activeLevel,
    detail,
    setDetail,
    scaleDenominator,
    setScaleDenominator,
    planColorMode,
    setPlanColorMode,
    modeFor,
    setModeFor,
    planViewRef,
    setResourcesTab,
    setResourcesOpen,
  } = opts;
  const {
    addCeilingType,
    addColorToCustomPalette,
    addComponent,
    addCustomPalette,
    addDoorType,
    addHatch,
    addLineStyle,
    addPen,
    addPenSet,
    addRoofType,
    addStairType,
    addTextStyle,
    addWallType,
    addWindowType,
    deleteCeilingType,
    deleteComponent,
    deleteCustomPalette,
    deleteDoorType,
    deleteHatch,
    deleteLineStyle,
    deletePen,
    deletePenSet,
    deleteRoofType,
    deleteStairType,
    deleteTextStyle,
    deleteWallType,
    deleteWindowType,
    importHatches,
    importLineStyles,
    loadStandards,
    patchCeilingType,
    patchComponent,
    patchDoorType,
    patchHatch,
    patchLineStyle,
    patchPenSetColor,
    patchPenSetWeight,
    patchRoofType,
    patchStairType,
    patchTextStyle,
    patchWallType,
    patchWindowType,
    removeColorFromCustomPalette,
    renameCustomPalette,
    renamePen,
    renamePenSet,
    seedStandardPenSet,
    setActivePenSet,
    setBuiltinPaletteVisible,
    setCustomPaletteVisible,
    setOverrideRules,
    updateStandards,
    snapshotLayerVisibility,
    applyLayerVisibility,
  } = opts.pa;

  // Ansichtsvorlagen ([34]): Ressourcen-Handler + Abgleich der verknüpften Vorlage der aktiven Ansicht.
  const viewTemplateHandlers = useViewTemplateHandlers({
    applyChange,
    groupChanges,
    activeLevel,
    detail,
    setDetail,
    scaleDenominator,
    setScaleDenominator,
    snapshotLayerVisibility,
    applyLayerVisibility,
    mono: planColorMode === "mono",
    setMono: (m) => setPlanColorMode(m ? "mono" : "color"),
    displayMode: modeFor(BUILTIN_PANEL_IDS.drawingLevels),
    setDisplayMode: (m) => setModeFor(BUILTIN_PANEL_IDS.drawingLevels, m),
    planViewRef,
  });

  // Handler-Bündel für das schwebende Ressourcen-Fenster (ResourceManager).
  const resourceHandlers: ResourceManagerHandlers = {
    ...viewTemplateHandlers,
    // [173] Modelldarstellung (neue Stufe über dem Detailgrad der Anzeige).
    ...modelViewHandlers(applyChange, () => detail),
    onPatchComponent: patchComponent,
    onPatchWallType: patchWallType,
    onAddWallType: addWallType,
    onDeleteWallType: deleteWallType,
    onPatchCeilingType: patchCeilingType,
    onAddCeilingType: addCeilingType,
    onDeleteCeilingType: deleteCeilingType,
    onPatchRoofType: patchRoofType,
    onAddRoofType: addRoofType,
    onDeleteRoofType: deleteRoofType,
    onAddDoorType: addDoorType,
    onPatchDoorType: patchDoorType,
    onDeleteDoorType: deleteDoorType,
    onAddWindowType: addWindowType,
    onPatchWindowType: patchWindowType,
    onDeleteWindowType: deleteWindowType,
    onAddStairType: addStairType,
    onPatchStairType: patchStairType,
    onDeleteStairType: deleteStairType,
    onAddComponent: addComponent,
    onDeleteComponent: deleteComponent,
    onPatchHatch: patchHatch,
    onAddHatch: addHatch,
    onDeleteHatch: deleteHatch,
    onPatchLineStyle: patchLineStyle,
    onAddLineStyle: addLineStyle,
    onDeleteLineStyle: deleteLineStyle,
    onImportLineStyles: importLineStyles,
    onImportHatches: importHatches,
    onPatchTextStyle: patchTextStyle,
    onAddTextStyle: addTextStyle,
    onDeleteTextStyle: deleteTextStyle,
    onSetOverrideRules: setOverrideRules,
    onAddPen: addPen,
    onRenamePen: renamePen,
    onDeletePen: deletePen,
    onAddPenSet: addPenSet,
    onRenamePenSet: renamePenSet,
    onDeletePenSet: deletePenSet,
    onSetActivePenSet: setActivePenSet,
    onPatchPenSetColor: patchPenSetColor,
    onPatchPenSetWeight: patchPenSetWeight,
    onSeedStandardPenSet: seedStandardPenSet,
    onLoadStandards: loadStandards,
    onUpdateStandards: updateStandards,
    onAddCustomPalette: addCustomPalette,
    onRenameCustomPalette: renameCustomPalette,
    onDeleteCustomPalette: deleteCustomPalette,
    onRemoveColorFromCustomPalette: removeColorFromCustomPalette,
    onSetCustomPaletteVisible: setCustomPaletteVisible,
    onSetBuiltinPaletteVisible: setBuiltinPaletteVisible,
    onAddColorToCustomPalette: addColorToCustomPalette,
  };

  // Öffnet die Ressourcen: unter Tauri das native Zweitfenster, sonst (reiner
  // Browser, kein OS-Fenster-Konzept) das bisherige schwebende Overlay.
  const openResources = (tab?: ResourceTabId) => {
    if (isTauriRuntime()) {
      void openResourceWindowNative(tab);
    } else {
      if (tab) setResourcesTab(tab);
      setResourcesOpen(true);
    }
  };
  const toggleResources = () => {
    if (isTauriRuntime()) {
      void openResourceWindowNative();
    } else {
      setResourcesOpen((v) => !v);
    }
  };

  return { resourceHandlers, openResources, toggleResources };
}
