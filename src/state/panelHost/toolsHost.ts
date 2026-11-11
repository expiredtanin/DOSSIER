// Panel-Host, Teil Werkzeuge, Zeichnungsebenen, Ebenen und Ressourcen ([121], aus
// `usePanelHostBase` herausgelöst): Werkzeug-Palette (aktives Werkzeug, Wandtyp, Fang), Zeichnungs-
// ebenen- und Ebenen-Handler sowie das CRUD der Ressourcen (Bauteile, Schraffuren, Linien-/Textstile,
// Wand-/Decken-/Dachtypen). Reine Verdrahtung auf die Projekt-Aktionen.

import { isTauriRuntime } from "../../native/projectFile";
import { openDrawingLevelsWindowNative } from "../../native/drawingLevelsWindow";
import { openLevel } from "../tabNavigation";
import type { FlatHostOpts, HostPart } from "./types";

export function buildToolsHost(c: FlatHostOpts) {
  const { activeCategoryCode, activeLevel, activeLevelId, activeTool, activeWallTypeId, addCategory, addCeiling, addCeilingType, addComponent, addDrawing, addElevation, addFloor, addHatch, addLineStyle, addRoofType, addSection, addTextStyle, addWallType, deleteCeilingType, deleteComponent, deleteHatch, deleteLineStyle, deleteRoofType, deleteTextStyle, deleteWallType, engineView, importHatches, importLineStyles, onRunCommand, onSelectTool, openLayerSettings, openSettings, patchCeilingType, patchComponent, patchHatch, patchLineStyle, patchRoofType, patchTextStyle, patchWallType, setActiveCategoryCode, setActiveWallTypeId, setMenu, setSnap, snap, toggleCategoryVisible, toggleLevelVisible } = c;
  return {
    activeLevelId,
    activeTool,
    onSelectTool,
    // Werkzeuge auch in der Perspektive: der Cursor wird per Raycast auf die
    // Geschoss-Arbeitsebene (OKFF) projiziert und über onWorkplanePoint in
    // dieselbe Engine wie im Grundriss gespeist (Viewport3D).
    toolsEnabled: activeLevel.kind === "floor",
    activeCommand: engineView.commandName,
    onRunCommand,
    activeWallTypeId,
    onActiveWallTypeId: setActiveWallTypeId,
    snap,
    onSnapChange: setSnap,
    onSelectLevel: openLevel,
    onToggleLevel: toggleLevelVisible,
    onAddFloor: addFloor,
    onAddDrawing: addDrawing,
    onAddSection: addSection,
    onAddElevation: addElevation,
    onAddCeiling: addCeiling,
    onLevelContextMenu: (id, x, y) =>
      setMenu({ kind: "level", id, x, y }),
    activeCategoryCode,
    onSelectCategory: setActiveCategoryCode,
    onToggleCategory: toggleCategoryVisible,
    onAddCategory: addCategory,
    onLayerContextMenu: (code, x, y) =>
      setMenu({ kind: "layer", code, x, y }),
    onOpenLayerSettings: (code, x, y) => openLayerSettings(code, x, y),
    onOpenDrawingLevelsWindow: () => {
      if (isTauriRuntime()) void openDrawingLevelsWindowNative();
    },
    onOpenSettings: () => openSettings(),
    onPatchComponent: patchComponent,
    onAddComponent: addComponent,
    onDeleteComponent: deleteComponent,
    onPatchHatch: patchHatch,
    onAddHatch: addHatch,
    onDeleteHatch: deleteHatch,
    onPatchLineStyle: patchLineStyle,
    onAddLineStyle: addLineStyle,
    onDeleteLineStyle: deleteLineStyle,
    onPatchTextStyle: patchTextStyle,
    onAddTextStyle: addTextStyle,
    onDeleteTextStyle: deleteTextStyle,
    onPatchWallType: patchWallType,
    onAddWallType: addWallType,
    onDeleteWallType: deleteWallType,
    onPatchCeilingType: patchCeilingType,
    onAddCeilingType: addCeilingType,
    onDeleteCeilingType: deleteCeilingType,
    onPatchRoofType: patchRoofType,
    onAddRoofType: addRoofType,
    onDeleteRoofType: deleteRoofType,
    onImportLineStyles: importLineStyles,
    onImportHatches: importHatches,
  } satisfies HostPart;
}
