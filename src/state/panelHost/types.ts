// Panel-Host, gemeinsame Typen ([121]): was `usePanelHostBase` aus der App bekommt (`PanelHostOpts`),
// die flache Sicht darauf für die Teil-Bauer (`FlatHostOpts`, alle Unter-Bündel ausgepackt) und der
// Teil-Typ, den jeder Bauer liefert (`HostPart`). Die Teile zusammen ergeben den Basis-Host
// (`BaseHost` = `PanelHostValue` ohne Darstellungsmodus; den hängt `hostWithMode` je Dock an).

import type { CoreOp, ProjectMutation } from "../../core";
import type { RefObject } from "react";
import type { DrawingLevel, Project } from "../../model/types";
import type { ToolId } from "../../tools/types";
import type { ViewType } from "../../model/viewTypes";
import type { PlanViewHandle } from "../../views/plan/PlanView";
import type { PanelHostValue } from "../../panels/host";
import type { SelectionInfo } from "../selectionInfo";
import type { EngineView } from "../../commands/engine";
import type { TabId as ResourceTabId } from "../../ui/ResourceManager";
import type { useProjectActions } from "../useProjectActions";
import type { useSelectionState } from "../useSelectionState";
import type { useDrawingToolState } from "../useDrawingToolState";
import type { useTopBarState } from "../useTopBarState";
import type { useDialogState } from "../useDialogState";
import type { useContextMenuState } from "../../menus/useContextMenuState";

/** Basis-Host: alles ausser dem Darstellungsmodus je Dock. */
export type BaseHost = Omit<PanelHostValue, "displayMode">;

/** Ein Teil des Basis-Hosts (Rückgabe eines Teil-Bauers, mit `satisfies` geprüft). */
export type HostPart = Partial<BaseHost>;

/**
 * Eingaben der Teil-Bauer. `project` und `selection` (Objekt-Info) sind keine Host-Felder ([121]):
 * Panels lesen sie selbst aus dem Store (`useStore`, `useSelectionInfo`). Die Handler brauchen sie
 * aber weiter; `usePanelHostBase` setzt sie beim Bau aus dem Store (die App gibt nur `PanelHostInput`).
 */
export type PanelHostOpts = {
  project: Project;
  setProject: (updater: ProjectMutation) => void;
  /** Änderung direkt als Ops ([K4] S3), s. `ProjectSlice.applyChange`. */
  applyChange: (ops: readonly CoreOp[] | ((p: Project) => readonly CoreOp[]), coalesceKey?: string) => void;
  activeLevelId: string;
  setActiveLevelId: (id: string) => void;
  activeLevel: DrawingLevel;
  viewType: ViewType;
  setViewType: (v: ViewType) => void;
  engineView: EngineView;
  onSelectTool: (id: ToolId) => void;
  onRunCommand: (name: string) => void;
  sectionLine: DrawingLevel | null;
  onToggleSection3dCut: (id: string) => void;
  openLayerSettings: (code: string, x: number, y: number) => void;
  openSettings: () => void;
  onOpenStampEditor: (roomId: string) => void;
  openResources: (tab?: ResourceTabId) => void;
  dxfInputRef: RefObject<HTMLInputElement | null>;
  planViewRef: RefObject<PlanViewHandle | null>;
  selection: SelectionInfo | null;
  projectActions: Pick<
    ReturnType<typeof useProjectActions>,
    | "toggleLevelVisible"
    | "toggleCategoryVisible"
    | "addFloor"
    | "addDrawing"
    | "addSection"
    | "addElevation"
    | "addCeiling"
    | "addCategory"
    | "snapshotLayerVisibility"
    | "applyLayerVisibility"
    | "snapshotDrawingVisibility"
    | "applyDrawingVisibility"
    | "patchLevel"
    | "patchComponent"
    | "addComponent"
    | "deleteComponent"
    | "patchHatch"
    | "addHatch"
    | "deleteHatch"
    | "patchLineStyle"
    | "addLineStyle"
    | "deleteLineStyle"
    | "patchTextStyle"
    | "addTextStyle"
    | "deleteTextStyle"
    | "patchWallType"
    | "addWallType"
    | "deleteWallType"
    | "patchCeilingType"
    | "addCeilingType"
    | "deleteCeilingType"
    | "patchRoofType"
    | "addRoofType"
    | "deleteRoofType"
    | "importLineStyles"
    | "importHatches"
    | "addContextObjectsAndFit"
    | "removeContextObject"
    | "removeContextObjects"
    | "generateTerrain"
    | "patchContextObject"
    | "commitTransformOn"
    | "setElementColor"
    | "setElementWeight"
    | "setElementFill"
    | "setElementFillColor"
    | "setElementForeground"
    | "setElementBackground"
    | "updateDrawing2D"
    | "resizeElement"
    | "updateWall"
    | "setWallThickness"
    | "updateOpening"
    | "slideOpening"
    | "updateCeiling"
    | "setCeilingThickness"
    | "updateStair"
    | "updateRoom"
    | "addColorToCustomPalette"
  >;
  selectionState: Pick<
    ReturnType<typeof useSelectionState>,
    | "updateRoof"
    | "setSelection"
    | "selectedSectionLineId"
    | "section3dCutId"
  >;
  toolState: Pick<
    ReturnType<typeof useDrawingToolState>,
    "activeTool" | "activeWallTypeId" | "setActiveWallTypeId" | "activeCategoryCode" | "setActiveCategoryCode" | "snap" | "setSnap"
  >;
  topBarState: Pick<
    ReturnType<typeof useTopBarState>,
    | "detail"
    | "setDetail"
    | "view3d"
    | "setView3d"
    | "fov"
    | "setFov"
    | "scaleDenominator"
    | "setScaleDenominator"
    | "selectedViewSnapshotId"
    | "setSelectedViewSnapshotId"
  >;
  dialogState: Pick<ReturnType<typeof useDialogState>, "setActiveLayoutId" | "setOpeningEditorId">;
  contextMenuState: Pick<ReturnType<typeof useContextMenuState>, "setMenu">;
};

/** Was `App` an `usePanelHostBase` gibt: alles ausser Projekt und Objekt-Info (die kommen aus dem Store). */
export type PanelHostInput = Omit<PanelHostOpts, "project" | "selection">;

/**
 * Packt die Unter-Bündel aus: ein flaches Objekt mit allen Werten und Handlern. Die Felder der obersten
 * Ebene (`selection` = Objekt-Info …) gehen vor gleichnamigen Feldern der Bündel.
 */
export function flatHostOpts<O extends PanelHostInput>(o: O) {
  return {
    ...o.projectActions,
    ...o.selectionState,
    ...o.toolState,
    ...o.topBarState,
    ...o.dialogState,
    ...o.contextMenuState,
    ...o,
  };
}

/** Flache Sicht auf die Eingaben (s. `flatHostOpts`). */
export type FlatHostOpts = ReturnType<typeof flatHostOpts<PanelHostOpts>>;
