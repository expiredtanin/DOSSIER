// Host-Context für die Panels: baut den (dock-unabhängigen) `PanelHostValue`-
// Basisvertrag aus Projekt/Selektion/Snap-/View-State + den Projekt-Mutationen
// zusammen — die eine grosse Adapter-Schicht zwischen App-State und dem
// PanelHostContext, den die Docks/Floating-Panels konsumieren (`hostWithMode`
// hängt je Dock nur noch den Darstellungsmodus an). Reine Verschiebung aus
// App.tsx, keine Verhaltensänderung.
//
// Extrahiert aus App.tsx. Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

import { applyFillMode } from "./fillMode";
import { addItems, cmdMutation, fieldOps, opsMutation, patchItem, patchItems, removeItems, removeRoofHole, setFieldIfChanged, setRoofEdge } from "../core";
import type { CoreOp, ProjectMutation } from "../core";
import { useMemo, type RefObject } from "react";
import type { DrawingLevel, Project } from "../model/types";
import { resolvePenColor } from "../model/penSets";
import type { ToolId } from "../tools/types";
import type { ViewType } from "../model/viewTypes";
import type { TransformSelection } from "../tools/transform";
import type { PlanViewHandle } from "../views/plan/PlanView";
import type { PanelHostValue } from "../panels/host";
import type { Selection } from "./selectionInfo";
import type { EngineView } from "../commands/engine";
import type { ScheduleKind } from "../export/exportSchedule";
import type { TabId as ResourceTabId } from "../ui/ResourceManager";
import { isTauriRuntime } from "../native/projectFile";
import { openDrawingLevelsWindowNative } from "../native/drawingLevelsWindow";
import { t } from "../i18n";
import {
  applyOverrideRuleEnabled,
  captureViewSnapshot,
  matchingComboName,
  readViewSnapshot,
  type ViewSnapshotState,
} from "./viewSnapshots";
import {
  createViewSnapshotFolder,
  deleteFolder as deleteViewSnapshotFolder,
  moveSnapshotToFolder,
  moveFolder as moveViewSnapshotFolder,
} from "./viewSnapshotFolders";
import {
  listDrawingCombos,
  listLayerCombos,
  loadDrawingCombo,
  loadLayerCombo,
} from "./visibilitySets";
import {
  createLayout,
  createLayoutFolder,
  createMasterLayout,
  deleteFolder as deleteLayoutFolder,
  deleteMasterFolder,
  moveLayoutToFolder,
  moveFolderToFolder,
  createSheetLevel,
} from "../model/layoutModel";
import { folderPdfBytes } from "../export/layoutPdf";
import { addPublishSetOps, deletePublishSetOps, patchPublishSetOps, publishSet } from "./publishActions";
import { saveBinaryFile } from "../native/saveFile";
import type { useProjectActions } from "./useProjectActions";
import type { useSelectionState } from "./useSelectionState";
import type { useDrawingToolState } from "./useDrawingToolState";
import type { useTopBarState } from "./useTopBarState";
import type { useDialogState } from "./useDialogState";
import type { useContextMenuState } from "../menus/useContextMenuState";

/**
 * Baut eine TransformSelection für GENAU EIN Element (Object-Info: Verschieben/
 * Drehen per Zahlenfeld, siehe onMoveSelectionBy/onRotateSelectionAround unten).
 * Deckt nur die vom Transform-Kern (tools/transform.ts) unterstützten Arten ab
 * — Decke/Öffnung/Treppe/Raum kennt er nicht, dort liefert die Funktion `null`
 * (Aufrufer macht dann No-op, wie bei onResizeSelection).
 */
function singleTransformSel(kind: string, id: string): TransformSelection | null {
  if (kind === "wall") return { wallIds: [id], drawingId: null };
  if (kind === "drawing2d") return { wallIds: [], drawingId: id };
  if (kind === "extrudedSolid") return { wallIds: [], drawingId: null, extrudedSolidId: id };
  if (kind === "column") return { wallIds: [], drawingId: null, columnId: id };
  if (kind === "ceiling") return { wallIds: [], drawingId: null, ceilingIds: [id] };
  // Dach: Move geht (Umriss verschiebt sich), Rotate no-opt bewusst (s.
  // TransformSelection.roofIds) — der Host-Aufruf degradiert dafür von
  // selbst über `gatherItems`, kein Sonderfall hier nötig.
  if (kind === "roof") return { wallIds: [], drawingId: null, roofIds: [id] };
  if (kind === "stair") return { wallIds: [], drawingId: null, stairIds: [id] };
  if (kind === "room") return { wallIds: [], drawingId: null, roomIds: [id] };
  return null;
}

/**
 * Grundriss-Kamera für einen View-Snapshot einsammeln (Bildmitte + Zoom) —
 * nur möglich, wenn gerade ein Grundriss gemountet ist (`viewType==="grundriss"`,
 * `planViewRef.current` also nicht null); sonst leeres Objekt (kein Feld
 * gesetzt), damit `{...captureCameraState(...)}` additiv in ein
 * `ViewSnapshotState`-Objektliteral eingemischt werden kann, ohne `undefined`-
 * Werte explizit zu setzen.
 */
function captureCameraState(
  planViewRef: RefObject<PlanViewHandle | null>,
  viewType: ViewType,
): Partial<Pick<ViewSnapshotState, "cameraCenter" | "cameraPxPerMeter">> {
  if (viewType !== "grundriss") return {};
  const pv = planViewRef.current;
  if (!pv) return {};
  const pxPerMeter = pv.pxPerMeter();
  if (!(pxPerMeter > 0)) return {};
  return { cameraCenter: pv.viewCenterModel(), cameraPxPerMeter: pxPerMeter };
}

export function usePanelHostBase(opts: {
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
  selection: Selection | null;
  projectActions: Pick<
    ReturnType<typeof useProjectActions>,
    | "toggleLevelVisible"
    | "toggleCategoryVisible"
    | "addFloor"
    | "addDrawing"
    | "addSection"
    | "addElevation"
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
    | "updateCeiling"
    | "setCeilingThickness"
    | "updateStair"
    | "updateRoom"
    | "addColorToCustomPalette"
  >;
  selectionState: Pick<
    ReturnType<typeof useSelectionState>,
    | "updateRoof"
    | "setSelectedWallIds"
    | "setSelectedDrawingId"
    | "selectedContextObjectIds"
    | "setSelectedCeilingIds"
    | "setSelectedOpeningIds"
    | "setSelectedStairIds"
    | "setSelectedRoomIds"
    | "setSelectedExtrudedSolidIds"
    | "setSelectedColumnIds"
    | "setSelectedRoofIds"
    | "setSelectedContextObjectIds"
    | "selectedSectionLineId"
    | "setSelectedSectionLineIds"
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
}): Omit<PanelHostValue, "displayMode"> {
  const {
    project,
    setProject,
    applyChange,
    activeLevelId,
    setActiveLevelId,
    activeLevel,
    viewType,
    setViewType,
    engineView,
    onSelectTool,
    onRunCommand,
    sectionLine,
    onToggleSection3dCut,
    openLayerSettings,
    openSettings,
    onOpenStampEditor,
    openResources,
    dxfInputRef,
    planViewRef,
    selection,
    projectActions,
    selectionState,
    toolState,
    topBarState,
    dialogState,
    contextMenuState,
  } = opts;
  const {
    toggleLevelVisible,
    toggleCategoryVisible,
    addFloor,
    addDrawing,
    addSection,
    addElevation,
    addCategory,
    snapshotLayerVisibility,
    applyLayerVisibility,
    snapshotDrawingVisibility,
    applyDrawingVisibility,
    patchLevel,
    patchComponent,
    addComponent,
    deleteComponent,
    patchHatch,
    addHatch,
    deleteHatch,
    patchLineStyle,
    addLineStyle,
    deleteLineStyle,
    patchTextStyle,
    addTextStyle,
    deleteTextStyle,
    patchWallType,
    addWallType,
    deleteWallType,
    patchCeilingType,
    addCeilingType,
    deleteCeilingType,
    patchRoofType,
    addRoofType,
    deleteRoofType,
    importLineStyles,
    importHatches,
    addContextObjectsAndFit,
    removeContextObject,
    removeContextObjects,
    generateTerrain,
    patchContextObject,
    commitTransformOn,
    setElementColor,
    setElementWeight,
    setElementFill,
    setElementFillColor,
    setElementForeground,
    setElementBackground,
    updateDrawing2D,
    resizeElement,
    updateWall,
    setWallThickness,
    updateOpening,
    updateCeiling,
    setCeilingThickness,
    updateStair,
    updateRoom,
    addColorToCustomPalette,
  } = projectActions;
  const {
    updateRoof,
    setSelectedWallIds,
    setSelectedDrawingId,
    selectedContextObjectIds,
    setSelectedCeilingIds,
    setSelectedOpeningIds,
    setSelectedStairIds,
    setSelectedRoomIds,
    setSelectedExtrudedSolidIds,
    setSelectedColumnIds,
    setSelectedRoofIds,
    setSelectedContextObjectIds,
    selectedSectionLineId,
    setSelectedSectionLineIds,
    section3dCutId,
  } = selectionState;
  const { activeTool, activeWallTypeId, setActiveWallTypeId, activeCategoryCode, setActiveCategoryCode, snap, setSnap } =
    toolState;
  const {
    detail,
    setDetail,
    view3d,
    setView3d,
    fov,
    setFov,
    scaleDenominator,
    setScaleDenominator,
    selectedViewSnapshotId,
    setSelectedViewSnapshotId,
  } = topBarState;
  const { setActiveLayoutId, setOpeningEditorId } = dialogState;
  const { setMenu } = contextMenuState;

  const baseHost = useMemo(() => {
    const value: Omit<PanelHostValue, "displayMode"> = {
      project,
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
      onSelectLevel: setActiveLevelId,
      onToggleLevel: toggleLevelVisible,
      onAddFloor: addFloor,
      onAddDrawing: addDrawing,
      onAddSection: addSection,
      onAddElevation: addElevation,
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
      selection,
      // Platzhalter — der LIVE-Wert wird in `hostWithMode` je Render injiziert
      // (nicht hier, weil `draft` bewusst kein Dep dieses Memos ist, s. dort).
      measurement: null,
      onSetSelectionColor: (color) => {
        if (!selection) return;
        if (selection.kind === "wall" || selection.kind === "drawing2d")
          setElementColor(selection.kind, selection.id, color);
        else if (selection.kind === "ceiling")
          updateCeiling(selection.id, { color });
        else if (selection.kind === "opening")
          updateOpening(selection.id, { color });
        else if (selection.kind === "stair")
          updateStair(selection.id, { color });
        else if (selection.kind === "room")
          updateRoom(selection.id, { color });
      },
      // Stift-Kopplung der Farbe oben (s. `Selection.colorPenId`-Doku) —
      // dieselben Selektionsarten wie `onSetSelectionColor`. `penId` gesetzt ⇒ Farbe sofort aus dem aktiven
      // Stiftsatz backen; `undefined` ⇒ nur die Kopplung lösen, letzter
      // gebackener Wert bleibt als freie Farbe stehen.
      onSetSelectionColorPen: (penId) => {
        if (!selection) return;
        const color = penId ? resolvePenColor(project, penId) : undefined;
        const patch = color !== undefined ? { colorPenId: penId, color } : { colorPenId: penId };
        if (selection.kind === "wall") updateWall(selection.id, patch);
        else if (selection.kind === "drawing2d") updateDrawing2D(selection.id, patch);
        else if (selection.kind === "ceiling") updateCeiling(selection.id, patch);
        else if (selection.kind === "opening") updateOpening(selection.id, patch);
        else if (selection.kind === "stair") updateStair(selection.id, patch);
        else if (selection.kind === "room") updateRoom(selection.id, patch);
      },
      onSetSelectionWeight: (weightMm) => {
        // Strichstärke-Override: Wand/Decke (`strokeWeight`) oder Drawing2D (`weightMm`).
        if (selection?.kind === "wall") updateWall(selection.id, { strokeWeight: weightMm });
        else if (selection?.kind === "ceiling")
          updateCeiling(selection.id, { strokeWeight: weightMm });
        else if (selection?.kind === "drawing2d")
          setElementWeight(selection.id, weightMm);
      },
      onSetSelectionFill: (hatchId) => {
        // Schraffur-Override: Wand, Decke oder Drawing2D (geschlossene Formen).
        // `null` löscht das Feld (→ „Nach System"/Quelle).
        if (selection?.kind === "wall")
          updateWall(selection.id, { hatchId: hatchId ?? undefined });
        else if (selection?.kind === "ceiling")
          updateCeiling(selection.id, { hatchId: hatchId ?? undefined });
        else if (selection?.kind === "drawing2d")
          setElementFill(selection.id, hatchId);
      },
      onSetSelectionLineStyle: (lineStyleId) => {
        // Nur Drawing2D trägt einen Linienstil (Wand/Decke/etc. nicht).
        if (selection?.kind === "drawing2d")
          updateDrawing2D(selection.id, { lineStyleId });
      },
      onSetSelectionFillColor: (color) => {
        // Vollton-Füllfarbe nur bei Drawing2D (geschlossene Formen).
        if (selection?.kind === "drawing2d")
          setElementFillColor(selection.id, color);
      },
      onSetSelectionFillMode: (mode) => {
        if (selection?.kind !== "drawing2d") return;
        const id = selection.id;
        setProject(opsMutation((p) => patchItem(p, "drawings2d", id, (d) => applyFillMode(d, p.hatches, mode))));
      },
      onSetSelectionFillOpacity: (opacity) => {
        if (selection?.kind === "drawing2d")
          setProject(
            opsMutation((p) =>
              patchItem(p, "drawings2d", selection.id, (d) => {
                const { fillOpacity: _old, ...rest } = d;
                return opacity >= 1 ? rest : { ...rest, fillOpacity: Math.max(0, opacity) };
              }),
            ),
          );
      },
      onSetSelectionOpacity: (opacity) => {
        // Deckkraft eines 2D-Elements. Bei BILDERN bleibt es die Deckkraft der
        // Bildgeometrie (bestehendes Verhalten, eigenes Feld); bei allen
        // übrigen Formen die neue OBJEKT-Transparenz, die auf Striche UND
        // Füllungen wirkt (`Drawing2D.opacity`). Nur EIN Bedienfeld — welches
        // Feld gesetzt wird, entscheidet die Form.
        if (selection?.kind === "drawing2d")
          setProject(
            opsMutation((p) =>
              patchItem(p, "drawings2d", selection.id, (d) =>
                d.geom.shape === "image" ? { ...d, geom: { ...d.geom, opacity } } : { ...d, opacity },
              ),
            ),
          );
        else if (selection?.kind === "contextObject")
          applyChange((p) =>
            patchItem(p, "context", selection.id, (o) => (o.type === "image" ? { ...o, opacity } : o)),
          );
      },
      onSetSelectionImageFilters: (filters) => {
        // Nur Kontext-Objekt-Bilder tragen `filters` (s. `ContextImage`) —
        // gemergt mit den bestehenden Werten (Teil-Update, ein Slider ändert
        // nur SEINEN eigenen Wert).
        if (selection?.kind !== "contextObject") return;
        applyChange((p) =>
          patchItem(p, "context", selection.id, (o) =>
            o.type === "image" ? { ...o, filters: { ...o.filters, ...filters } } : o,
          ),
        );
      },
      onSetSelectionForeground: (color) => {
        // Vordergrund-Override: Wand, Decke oder Drawing2D.
        if (
          selection?.kind === "wall" ||
          selection?.kind === "ceiling" ||
          selection?.kind === "drawing2d"
        )
          setElementForeground(selection.kind, selection.id, color);
      },
      onSetSelectionBackground: (color) => {
        // Hintergrund-Override: Wand, Decke oder Drawing2D.
        if (
          selection?.kind === "wall" ||
          selection?.kind === "ceiling" ||
          selection?.kind === "drawing2d"
        )
          setElementBackground(selection.kind, selection.id, color);
      },
      // Stift-Kopplung von Vordergrund/Hintergrund (s. `Selection.
      // foregroundPenId`/`backgroundPenId`-Doku) — dieselben Selektionsarten
      // wie `onSetSelectionForeground`/`onSetSelectionBackground` (Wand/Decke/
      // Drawing2D; Stütze trägt zwar dasselbe Feld im Modell, hat aber ebenso
      // wie bei `onSetSelectionColorPen` noch KEINEN UI-Schreibpfad — s.
      // PENDENZEN.md-Scope-Entscheid). `penId` gesetzt ⇒ sofort aus dem aktiven
      // Stiftsatz backen; `undefined` ⇒ nur die Kopplung lösen, letzter
      // gebackener Wert bleibt als freier Override stehen.
      onSetSelectionForegroundPen: (penId) => {
        if (!selection) return;
        const foreground = penId ? resolvePenColor(project, penId) : undefined;
        const patch =
          foreground !== undefined
            ? { foregroundPenId: penId, foreground }
            : { foregroundPenId: penId };
        if (selection.kind === "wall") updateWall(selection.id, patch);
        else if (selection.kind === "ceiling") updateCeiling(selection.id, patch);
        else if (selection.kind === "drawing2d") updateDrawing2D(selection.id, patch);
      },
      onAddColorToCustomPalette: (paletteId, hex) => addColorToCustomPalette(paletteId, hex),
      onSetDashScale: (drawingId, scale) =>
        setProject(opsMutation((p) => patchItem(p, "drawings2d", drawingId, { dashScale: scale }))),
      onDetachDimension: (drawingId) => setProject(cmdMutation({ cmd: "dimdetach", ids: [drawingId] })),
      onSetDetailRefLabel: (drawingId, label) =>
        setProject(
          opsMutation((p) =>
            patchItem(p, "drawings2d", drawingId, (d) =>
              d.geom.shape === "detailref" ? { ...d, geom: { ...d.geom, label } } : d,
            ),
          ),
        ),
      onSetDetailRefSheetLayout: (drawingId, sheetLayoutId) =>
        setProject(
          opsMutation((p) =>
            patchItem(p, "drawings2d", drawingId, (d) => {
              if (d.geom.shape !== "detailref") return d;
              const geom = { ...d.geom };
              if (sheetLayoutId) geom.sheetLayoutId = sheetLayoutId;
              else delete geom.sheetLayoutId;
              return { ...d, geom };
            }),
          ),
        ),
      onSetDetailRefSheetLabel: (drawingId, sheetLabel) =>
        setProject(
          opsMutation((p) =>
            patchItem(p, "drawings2d", drawingId, (d) =>
              d.geom.shape === "detailref" ? { ...d, geom: { ...d.geom, sheetLabel } } : d,
            ),
          ),
        ),
      onSetHatchPlacement: (drawingId, patch) =>
        setProject(
          opsMutation((p) =>
            patchItem(p, "drawings2d", drawingId, (d) => {
            const next = { ...d };
            // `null` = zurück auf die Ressource (Feld entfernen).
            if ("angleDeg" in patch)
              patch.angleDeg === null ? delete next.hatchAngleDeg : (next.hatchAngleDeg = patch.angleDeg);
            if ("scale" in patch)
              patch.scale === null ? delete next.hatchScale : (next.hatchScale = patch.scale);
            if ("origin" in patch)
              patch.origin === null ? delete next.hatchOrigin : (next.hatchOrigin = patch.origin);
            return next;
            }),
          ),
        ),
      onSetEndMarks: (drawingId, patch) =>
        setProject(
          opsMutation((p) =>
            patchItem(p, "drawings2d", drawingId, (d) => ({ ...d, endMarks: { ...d.endMarks, ...patch } })),
          ),
        ),
      onSetDimensionStyle: (drawingId, patch) =>
        setProject(
          opsMutation((p) =>
            patchItem(p, "drawings2d", drawingId, (d) =>
              d.geom.shape === "dimension" ? { ...d, geom: { ...d.geom, ...patch } } : d,
            ),
          ),
        ),
      onSetSelectionBackgroundPen: (penId) => {
        if (!selection) return;
        const background = penId ? resolvePenColor(project, penId) : undefined;
        const patch =
          background !== undefined
            ? { backgroundPenId: penId, background }
            : { backgroundPenId: penId };
        if (selection.kind === "wall") updateWall(selection.id, patch);
        else if (selection.kind === "ceiling") updateCeiling(selection.id, patch);
        else if (selection.kind === "drawing2d") updateDrawing2D(selection.id, patch);
      },
      // ── By-Layer/By-Object-Quellen (Vordergrund/Hintergrund/Strichstärke/
      // Schraffur): "layer" erzwingt die Ebene, "object" erbt vom Bauteil —
      // beide löschen dabei den expliziten Wert (siehe Modell-Kommentar
      // `AttributeSource`); „eigener Wert" läuft weiterhin über die
      // onSetSelection{Foreground,Background,Weight,Fill}-Setter oben.
      onSetSelectionForegroundSource: (source) => {
        if (!selection) return;
        const patch = {
          foregroundSource: source === "layer" ? ("layer" as const) : undefined,
          foreground: undefined,
        };
        if (selection.kind === "wall") updateWall(selection.id, patch);
        else if (selection.kind === "ceiling") updateCeiling(selection.id, patch);
        else if (selection.kind === "drawing2d") updateDrawing2D(selection.id, patch);
      },
      onSetSelectionBackgroundSource: (source) => {
        if (!selection) return;
        const patch = {
          backgroundSource: source === "layer" ? ("layer" as const) : undefined,
          background: undefined,
        };
        if (selection.kind === "wall") updateWall(selection.id, patch);
        else if (selection.kind === "ceiling") updateCeiling(selection.id, patch);
        else if (selection.kind === "drawing2d") updateDrawing2D(selection.id, patch);
      },
      onSetSelectionStrokeWeightSource: (source) => {
        if (!selection) return;
        const strokeWeightSource = source === "layer" ? ("layer" as const) : undefined;
        if (selection.kind === "wall")
          updateWall(selection.id, { strokeWeightSource, strokeWeight: undefined });
        else if (selection.kind === "ceiling")
          updateCeiling(selection.id, { strokeWeightSource, strokeWeight: undefined });
        else if (selection.kind === "drawing2d")
          updateDrawing2D(selection.id, { strokeWeightSource, weightMm: undefined });
      },
      onSetSelectionHatchSource: (source) => {
        if (!selection) return;
        const hatchSource = source === "layer" ? ("layer" as const) : undefined;
        if (selection.kind === "wall")
          updateWall(selection.id, { hatchSource, hatchId: undefined });
        else if (selection.kind === "ceiling")
          updateCeiling(selection.id, { hatchSource, hatchId: undefined });
        else if (selection.kind === "drawing2d")
          updateDrawing2D(selection.id, { hatchSource, hatchId: undefined });
      },
      onResizeSelection: (w, h, anchor) => {
        if (selection?.kind === "wall" || selection?.kind === "drawing2d")
          resizeElement(selection.kind, selection.id, w, h, anchor);
      },
      onMoveSelectionBy: (dx, dy) => {
        if (!selection) return;
        if (!isFinite(dx) || !isFinite(dy) || (dx === 0 && dy === 0)) return;
        const sel2 = singleTransformSel(selection.kind, selection.id);
        if (!sel2) return;
        commitTransformOn(sel2, "move", [{ x: 0, y: 0 }, { x: dx, y: dy }], "move", 1);
      },
      // Objektinfo-Kopf: Klasse (Grafik-Kategorie) + Zeichnungsebene ändern
      // (VW-Muster „Klasse"/„Ebene"). Je Elementart der passende Store-Weg.
      onSetSelectionCategory: (code) => {
        if (!selection || !code) return;
        const id = selection.id;
        switch (selection.kind) {
          case "wall": updateWall(id, { categoryCode: code }); break;
          case "ceiling": updateCeiling(id, { categoryCode: code }); break;
          case "roof": updateRoof(id, { categoryCode: code }); break;
          case "opening": updateOpening(id, { categoryCode: code }); break;
          case "stair": updateStair(id, { categoryCode: code }); break;
          case "room": updateRoom(id, { categoryCode: code }); break;
          case "drawing2d": updateDrawing2D(id, { categoryCode: code }); break;
          case "column":
            applyChange((p) => patchItem(p, "columns", id, { categoryCode: code }));
            break;
          default: break; // extrudedSolid/door: keine Kategorie am Element
        }
      },
      onSetSelectionLevel: (levelId) => {
        if (!selection || !levelId) return;
        const id = selection.id;
        switch (selection.kind) {
          case "wall": updateWall(id, { floorId: levelId }); break;
          case "ceiling": updateCeiling(id, { floorId: levelId }); break;
          case "roof": updateRoof(id, { floorId: levelId }); break;
          case "stair": updateStair(id, { floorId: levelId }); break;
          case "room": updateRoom(id, { floorId: levelId }); break;
          case "drawing2d": updateDrawing2D(id, { levelId }); break;
          case "extrudedSolid":
            applyChange((p) => patchItem(p, "extrudedSolids", id, { levelId }));
            break;
          case "column":
            applyChange((p) => patchItem(p, "columns", id, { floorId: levelId }));
            break;
          default: break; // opening: Ebene kommt aus der Wirts-Wand
        }
      },
      onRotateSelectionAround: (cx, cy, deg) => {
        if (!selection) return;
        if (!isFinite(deg) || deg === 0) return;
        const sel2 = singleTransformSel(selection.kind, selection.id);
        if (!sel2) return;
        const rad = (deg * Math.PI) / 180;
        commitTransformOn(
          sel2,
          "rotate",
          [
            { x: cx, y: cy },
            { x: cx + 1, y: cy },
            { x: cx + Math.cos(rad), y: cy + Math.sin(rad) },
          ],
          "move",
          1,
        );
      },
      onSetDrawingLineLength: (length) => {
        if (selection?.kind !== "drawing2d" || !isFinite(length) || length <= 0) return;
        const d = project.drawings2d.find((x) => x.id === selection.id);
        if (!d || d.geom.shape !== "line") return;
        const { a, b } = d.geom;
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        if (len < 1e-9) return;
        const ux = (b.x - a.x) / len, uy = (b.y - a.y) / len;
        updateDrawing2D(selection.id, {
          geom: { ...d.geom, b: { x: a.x + ux * length, y: a.y + uy * length } },
        });
      },
      onSetDrawingLineAngle: (deg) => {
        if (selection?.kind !== "drawing2d" || !isFinite(deg)) return;
        const d = project.drawings2d.find((x) => x.id === selection.id);
        if (!d || d.geom.shape !== "line") return;
        const { a, b } = d.geom;
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        if (len < 1e-9) return;
        const rad = (deg * Math.PI) / 180;
        updateDrawing2D(selection.id, {
          geom: { ...d.geom, b: { x: a.x + Math.cos(rad) * len, y: a.y + Math.sin(rad) * len } },
        });
      },
      onSetDrawingCircleRadius: (radius) => {
        if (selection?.kind !== "drawing2d" || !isFinite(radius) || radius <= 0) return;
        const d = project.drawings2d.find((x) => x.id === selection.id);
        if (!d || d.geom.shape !== "circle") return;
        updateDrawing2D(selection.id, { geom: { ...d.geom, r: radius } });
      },
      onSetDrawingArcRadius: (radius) => {
        if (selection?.kind !== "drawing2d" || !isFinite(radius) || radius <= 0) return;
        const d = project.drawings2d.find((x) => x.id === selection.id);
        if (!d || d.geom.shape !== "arc") return;
        updateDrawing2D(selection.id, { geom: { ...d.geom, r: radius } });
      },
      onSetDrawingArcStartAngle: (deg) => {
        if (selection?.kind !== "drawing2d" || !isFinite(deg)) return;
        const d = project.drawings2d.find((x) => x.id === selection.id);
        if (!d || d.geom.shape !== "arc") return;
        updateDrawing2D(selection.id, { geom: { ...d.geom, a0: (deg * Math.PI) / 180 } });
      },
      onSetDrawingArcEndAngle: (deg) => {
        if (selection?.kind !== "drawing2d" || !isFinite(deg)) return;
        const d = project.drawings2d.find((x) => x.id === selection.id);
        if (!d || d.geom.shape !== "arc") return;
        updateDrawing2D(selection.id, { geom: { ...d.geom, a1: (deg * Math.PI) / 180 } });
      },
      // ── Wand-Attribute (nur bei selektierter Wand) ─────────────────────────
      onSetWallReferenceLine: (ref) => {
        if (selection?.kind === "wall")
          // Benannte Linie gewählt ⇒ freien Fugen-Versatz löschen (er übersteuert sonst).
          updateWall(selection.id, { referenceLine: ref, referenceOffset: undefined });
      },
      onSetWallReferenceOffset: (offset) => {
        if (selection?.kind === "wall")
          updateWall(selection.id, { referenceOffset: offset ?? undefined });
      },
      onSetSurfacePatternPlacement: (patch) => {
        if (selection?.kind === "wall") updateWall(selection.id, patch, "surface-pattern");
        else if (selection?.kind === "roof") updateRoof(selection.id, patch, "surface-pattern");
      },
      onSetWallSliceTermination: (termination) => {
        if (selection?.kind === "wall")
          // "both" ist der Default ⇒ als undefined speichern (Alt-Projekt-Parität).
          updateWall(selection.id, {
            sliceTermination: termination === "both" ? undefined : termination,
          });
      },
      onSetWallType: (wallTypeId) => {
        if (selection?.kind === "wall")
          updateWall(selection.id, { wallTypeId });
      },
      onSetWallThickness: (thickness) => {
        if (selection?.kind === "wall")
          setWallThickness(selection.id, thickness);
      },
      onSetWallBottom: (anchor) => {
        if (selection?.kind === "wall")
          updateWall(selection.id, { bottom: anchor ?? undefined });
      },
      onSetWallTop: (anchor) => {
        if (selection?.kind === "wall")
          updateWall(selection.id, { top: anchor ?? undefined });
      },
      // ── Decken-Attribute (nur bei selektierter Decke) ──────────────────────
      onSetCeilingType: (ceilingTypeId) => {
        if (selection?.kind === "ceiling")
          updateCeiling(selection.id, { ceilingTypeId, thickness: undefined });
      },
      onSetCeilingThickness: (thickness) => {
        if (selection?.kind === "ceiling")
          setCeilingThickness(selection.id, thickness);
      },
      onRemoveCeilingOpening: (index) => {
        if (selection?.kind !== "ceiling") return;
        const c = (project.ceilings ?? []).find((x) => x.id === selection.id);
        if (!c?.openings || index < 0 || index >= c.openings.length) return;
        updateCeiling(selection.id, {
          openings: c.openings.filter((_, i) => i !== index),
        });
      },
      onSetCeilingTop: (anchor) => {
        if (selection?.kind === "ceiling")
          updateCeiling(selection.id, { top: anchor ?? undefined });
      },
      onSetCeilingBottom: (anchor) => {
        if (selection?.kind === "ceiling")
          updateCeiling(selection.id, { bottom: anchor ?? undefined });
      },
      // ── Öffnungs-Attribute (nur bei selektierter Öffnung) ──────────────────
      onSetOpeningKind: (kind) => {
        if (selection?.kind === "opening")
          updateOpening(
            selection.id,
            kind === "door"
              ? { kind, sillHeight: 0, hinge: "start", swing: "left", openingDir: "in", swingAngle: 90 }
              : { kind },
          );
      },
      onSetOpeningWidth: (width) => {
        if (selection?.kind === "opening" && width > 0)
          updateOpening(selection.id, { width });
      },
      onSetOpeningHeight: (height) => {
        if (selection?.kind === "opening" && height > 0)
          updateOpening(selection.id, { height });
      },
      onSetOpeningSill: (sillHeight) => {
        if (selection?.kind === "opening" && sillHeight >= 0)
          updateOpening(selection.id, { sillHeight });
      },
      onSetOpeningPosition: (position) => {
        if (selection?.kind === "opening" && position >= 0)
          updateOpening(selection.id, { position });
      },
      onSetOpeningSwingAngle: (swingAngle) => {
        if (selection?.kind === "opening" && swingAngle > 0)
          updateOpening(selection.id, { swingAngle });
      },
      onSetOpeningHinge: (hinge) => {
        if (selection?.kind === "opening") updateOpening(selection.id, { hinge });
      },
      onSetOpeningSwing: (swing) => {
        if (selection?.kind === "opening") updateOpening(selection.id, { swing });
      },
      onSetOpeningDir: (openingDir) => {
        if (selection?.kind === "opening") updateOpening(selection.id, { openingDir });
      },
      onSetOpeningWingCount: (wingCount) => {
        if (selection?.kind === "opening")
          updateOpening(selection.id, { wingCount: Math.max(1, Math.min(4, Math.round(wingCount))) });
      },
      onSetOpeningDoorType: (doorType) => {
        if (selection?.kind === "opening") updateOpening(selection.id, { doorType });
      },
      onSetOpeningLintelLines: (lintelLines) => {
        if (selection?.kind === "opening") updateOpening(selection.id, { lintelLines });
      },
      onSetOpeningHost: (patch) => {
        if (selection?.kind === "opening") updateOpening(selection.id, patch);
      },
      onSetOpeningDetailLevel: (detailLevel) => {
        if (selection?.kind === "opening") updateOpening(selection.id, { detailLevel });
      },
      onSetOpeningFrameLine: (v) => {
        if (selection?.kind === "opening") updateOpening(selection.id, { frameLine: v });
      },
      onSetOpeningFrameViewLine: (v) => {
        if (selection?.kind === "opening") updateOpening(selection.id, { frameViewLine: v });
      },
      onSetOpeningSashLine: (v) => {
        if (selection?.kind === "opening") updateOpening(selection.id, { sashLine: v });
      },
      onSetOpeningSillLineStyle: (v) => {
        if (selection?.kind === "opening") updateOpening(selection.id, { sillLineStyle: v });
      },
      // Typ-Zuweisung (Bibliothek): Tür-/Fenstertyp per typeId; leerer String löst
      // die Zuweisung wieder (Inline-Verhalten).
      onSetOpeningType: (typeId) => {
        if (selection?.kind === "opening")
          updateOpening(selection.id, { typeId: typeId || undefined });
      },
      onEditOpeningType: (kind) => {
        openResources(kind === "door" ? "doorStyles" : "windowStyles");
      },
      onOpenOpeningEditor: (id) => setOpeningEditorId(id),
      // ── Dach-Attribute (nur bei selektiertem Dach) ─────────────────────────
      onSetRoofPatch: (patch, coalesceKey) => {
        if (selection?.kind === "roof") updateRoof(selection.id, patch, coalesceKey);
      },
      onSetRoofEdge: (index, spec) => {
        if (selection?.kind !== "roof") return;
        const r = (project.roofs ?? []).find((x) => x.id === selection.id);
        if (!r) return;
        // Zahl tippen: gleicher Schlüssel je Kante ⇒ ein Undo-Schritt; Giebel-Schalter einzeln.
        updateRoof(selection.id, setRoofEdge(r, index, spec), spec.kind === "pitch" ? `roof-edge-${selection.id}-${index}` : undefined);
      },
      onRemoveRoofHole: (k) => {
        if (selection?.kind !== "roof") return;
        const r = (project.roofs ?? []).find((x) => x.id === selection.id);
        if (r) updateRoof(selection.id, removeRoofHole(r, k));
      },
      // ── Schnitt-/Ansichtslinie (nur bei selektierter Linie) ────────────────
      sectionLine,
      onSetSectionLinePatch: (patch) => {
        if (sectionLine) patchLevel(sectionLine.id, patch);
      },
      onDeleteSectionLine: () => {
        if (sectionLine) patchLevel(sectionLine.id, { linePoints: undefined });
      },
      // 3D-Live-Schnitt an die gewählte Schnittlinie binden (Toggle im Objekt-Info).
      section3dCutActive: section3dCutId != null && section3dCutId === sectionLine?.id,
      onToggleSection3dCut,
      // ── Treppen-Attribute (nur bei selektierter Treppe) ────────────────────
      onSetStairShape: (shape) => {
        if (selection?.kind === "stair") updateStair(selection.id, { shape });
      },
      onSetStairWidth: (width) => {
        if (selection?.kind === "stair" && width > 0)
          updateStair(selection.id, { width });
      },
      onSetStairSteps: (stepCount) => {
        if (selection?.kind === "stair" && stepCount >= 2)
          updateStair(selection.id, { stepCount: Math.round(stepCount) });
      },
      onSetStairRise: (totalRise) => {
        if (selection?.kind === "stair" && totalRise > 0)
          updateStair(selection.id, { totalRise });
      },
      onSetStairUp: (up) => {
        if (selection?.kind === "stair") updateStair(selection.id, { up });
      },
      onSetStairArrowStyle: (arrowStyle) => {
        if (selection?.kind === "stair") updateStair(selection.id, { arrowStyle });
      },
      onSetStairColumn: (radius) => {
        if (selection?.kind === "stair")
          updateStair(selection.id, { centerColumn: radius > 0 ? radius : undefined });
      },
      onSetStairReferenz: (referenz) => {
        if (selection?.kind === "stair") updateStair(selection.id, { referenz });
      },
      // Typ-Zuweisung (Bibliothek): Treppentyp per typeId; leerer String löst die
      // Zuweisung (Inline-Verhalten). Treibt u. a. die 3D-Tragart (massiv/offen).
      onSetStairType: (typeId) => {
        if (selection?.kind === "stair")
          updateStair(selection.id, { typeId: typeId || undefined });
      },
      // ── Raum-Attribute (nur bei selektiertem Raum) ─────────────────────────
      onSetRoomName: (name) => {
        if (selection?.kind === "room") updateRoom(selection.id, { name });
      },
      onSetRoomSia: (category) => {
        if (selection?.kind === "room") updateRoom(selection.id, { siaCategory: category });
      },
      onEditRoomStamp: (roomId) => onOpenStampEditor(roomId),
      // ── Extrusions-Attribute (truck-Integration; nur bei selektiertem Körper) ──
      onSetExtrudedSolidHeight: (height) => {
        if (selection?.kind !== "extrudedSolid" || !(height > 0)) return;
        const id = selection.id;
        applyChange((p) => patchItem(p, "extrudedSolids", id, { height }));
      },
      onSetExtrudedSolidTaper: (taper) => {
        if (selection?.kind !== "extrudedSolid") return;
        const clamped = Math.min(1, Math.max(0, taper));
        const id = selection.id;
        applyChange((p) => patchItem(p, "extrudedSolids", id, { taper: clamped }));
      },
      onSetExtrudedSolidCornerRadius: (radius) => {
        if (selection?.kind !== "extrudedSolid") return;
        const r = Math.max(0, radius);
        const id = selection.id;
        applyChange((p) => patchItem(p, "extrudedSolids", id, { cornerRadius: r > 0 ? r : undefined }));
      },
      onSetExtrudedSolidChamfer: (chamfer) => {
        if (selection?.kind !== "extrudedSolid") return;
        const c = Math.max(0, chamfer);
        const id = selection.id;
        applyChange((p) => patchItem(p, "extrudedSolids", id, { chamfer: c > 0 ? c : undefined }));
      },
      onSetExtrudedSolidSubtract: (subtract) => {
        if (selection?.kind !== "extrudedSolid") return;
        const id = selection.id;
        applyChange((p) => patchItem(p, "extrudedSolids", id, { operation: subtract ? ("subtract" as const) : undefined }));
      },
      onSetExtrudedSolidBaseOffset: (offset) => {
        if (selection?.kind !== "extrudedSolid" || !Number.isFinite(offset)) return;
        const id = selection.id;
        applyChange((p) => patchItem(p, "extrudedSolids", id, { baseOffset: Math.abs(offset) > 1e-9 ? offset : undefined }));
      },
      // ── Stützen-Attribute (Tragwerk; nur bei selektierter Stütze) ──────────
      onSetColumnProfileKind: (kind) => {
        if (selection?.kind !== "column") return;
        const id = selection.id;
        applyChange((p) =>
          patchItem(p, "columns", id, (c) => {
            if (kind === c.profile.kind) return c;
            // Profil-Typ wechseln: sinnvolles Mass aus dem bisherigen ableiten.
            if (kind === "round") {
              const r =
                c.profile.kind === "rect"
                  ? Math.max(c.profile.width, c.profile.depth) / 2
                  : c.profile.radius;
              return { ...c, profile: { kind: "round" as const, radius: r } };
            }
            const side = c.profile.kind === "round" ? c.profile.radius * 2 : 0.3;
            return { ...c, profile: { kind: "rect" as const, width: side, depth: side } };
          }),
        );
      },
      onSetColumnWidth: (width) => {
        if (selection?.kind !== "column" || !(width > 0)) return;
        const id = selection.id;
        applyChange((p) =>
          patchItem(p, "columns", id, (c) =>
            c.profile.kind === "rect" ? { ...c, profile: { ...c.profile, width } } : c,
          ),
        );
      },
      onSetColumnDepth: (depth) => {
        if (selection?.kind !== "column" || !(depth > 0)) return;
        const id = selection.id;
        applyChange((p) =>
          patchItem(p, "columns", id, (c) =>
            c.profile.kind === "rect" ? { ...c, profile: { ...c.profile, depth } } : c,
          ),
        );
      },
      onSetColumnRadius: (radius) => {
        if (selection?.kind !== "column" || !(radius > 0)) return;
        const id = selection.id;
        applyChange((p) =>
          patchItem(p, "columns", id, (c) =>
            c.profile.kind === "round" ? { ...c, profile: { ...c.profile, radius } } : c,
          ),
        );
      },
      onSetColumnHeight: (height) => {
        if (selection?.kind !== "column" || !(height > 0)) return;
        const id = selection.id;
        applyChange((p) => patchItem(p, "columns", id, { height }));
      },
      onSetColumnRotation: (deg) => {
        if (selection?.kind !== "column" || !Number.isFinite(deg)) return;
        const id = selection.id;
        const rotation = (deg * Math.PI) / 180;
        applyChange((p) => patchItem(p, "columns", id, { rotation }));
      },
      // ── Site-/Kontext-Schicht ──────────────────────────────────────────────
      contextObjects: project.context ?? [],
      selectedContextObjectIds,
      onAddContextObjects: addContextObjectsAndFit,
      onRemoveContextObject: removeContextObject,
      onRemoveContextObjects: removeContextObjects,
      onGenerateTerrain: generateTerrain,
      onPatchContextObject: patchContextObject,
      onStartExcavation: () => onRunCommand("excavation"),
      onSetGeoAnchor: (anchor) => {
        applyChange((p) => setFieldIfChanged(p, "geoAnchor", anchor));
      },
      onImportDxf: () => dxfInputRef.current?.click(),
      onStartGeoref: () => onRunCommand("georef"),
      // ── Element-Baum (Elemente-Panel) ────────────────────────────────────
      onSelectScheduleRow: (
        kind: ScheduleKind,
        id: string,
        floorId: string | undefined,
        opts?: { zoom?: boolean },
      ) => {
        const applySelection = () => {
          setSelectedWallIds([]);
          setSelectedDrawingId(null);
          setSelectedCeilingIds([]);
          setSelectedOpeningIds([]);
          setSelectedStairIds([]);
          setSelectedRoomIds([]);
          setSelectedExtrudedSolidIds([]);
          setSelectedColumnIds([]);
          setSelectedRoofIds([]);
          setSelectedContextObjectIds([]);
          setSelectedSectionLineIds([]);
          switch (kind) {
            case "Wand":
              setSelectedWallIds([id]);
              break;
            case "Decke":
              setSelectedCeilingIds([id]);
              break;
            case "Fenster":
            case "Öffnung":
              setSelectedOpeningIds([id]);
              break;
            case "Treppe":
              setSelectedStairIds([id]);
              break;
            case "Extrusion":
              setSelectedExtrudedSolidIds([id]);
              break;
            case "Dach":
              setSelectedRoofIds([id]);
              break;
            case "Stütze":
              setSelectedColumnIds([id]);
              break;
            default:
              // z. B. Legacy-„Tür"-Datensätze (project.doors) — kein Auswahl-Kanal.
              return;
          }
          if (opts?.zoom) requestAnimationFrame(() => planViewRef.current?.fit());
        };
        if (floorId && floorId !== activeLevelId) {
          // Der Geschosswechsel-Effekt (oben, deps [activeLevelId]) leert die
          // Auswahl NACH diesem Render — die neue Auswahl daher einen Tick
          // später anwenden, sonst überschreibt der Effekt sie sofort wieder.
          setActiveLevelId(floorId);
          requestAnimationFrame(applySelection);
        } else {
          applySelection();
        }
      },

      // ── Ausschnitte / View-Snapshots (DOSSIER A2) ─────────────────────────
      // Erfassen: aktuellen Darstellungszustand einsammeln (View-State +
      // Sichtbarkeits-Snapshots + aktive Overrides) → pure captureViewSnapshot →
      // an project.viewSnapshots anhängen (im Dokument, nicht localStorage).
      onCaptureViewSnapshot: (name: string, folderId?: string): string => {
        const trimmed = name.trim();
        if (!trimmed) return "";
        const st: ViewSnapshotState = {
          viewType,
          view3d,
          fov,
          scaleDenominator,
          detail,
          activeLevelId,
          layerVisibility: snapshotLayerVisibility(),
          drawingVisibility: snapshotDrawingVisibility(),
          enabledOverrideRuleIds: (project.overrideRules ?? [])
            .filter((r) => r.enabled)
            .map((r) => r.id),
          ...captureCameraState(planViewRef, viewType),
        };
        const snap = captureViewSnapshot(`vs-${Date.now()}`, trimmed, st);
        // Neuer Ausschnitt landet im aktiven Ordner (falls das Panel einen
        // mitgibt), sonst auf der Wurzelebene — additiv (folderId optional).
        const full = folderId ? { ...snap, folderId } : snap;
        applyChange(addItems("viewSnapshots", [full]));
        return full.id;
      },

      // Wie `onCaptureViewSnapshot`, aber OHNE getippten Namen: die Ausschnitt-
      // Tab-Leiste (DrawingTabs.tsx) legt per „+" einen neuen Tab aus dem
      // aktuellen Stand an — Name automatisch die aktive Zeichnungskombination
      // (falls deren Sichtbarkeits-Map exakt passt) oder sonst das aktive Blatt
      // (Nutzer-Wunsch). Wählt den neuen Ausschnitt sofort an (Tab wird aktiv).
      viewSnapshotAutoName: (): string => {
        const combo = matchingComboName(listDrawingCombos(), loadDrawingCombo, snapshotDrawingVisibility());
        return combo ?? project.drawingLevels.find((l) => l.id === activeLevelId)?.name ?? activeLevelId;
      },

      onCaptureViewSnapshotAuto: (): string => {
        const drawingVisibility = snapshotDrawingVisibility();
        const combo = matchingComboName(listDrawingCombos(), loadDrawingCombo, drawingVisibility);
        const levelName =
          project.drawingLevels.find((l) => l.id === activeLevelId)?.name ?? activeLevelId;
        const name = combo ?? levelName;
        const st: ViewSnapshotState = {
          viewType,
          view3d,
          fov,
          scaleDenominator,
          detail,
          activeLevelId,
          layerVisibility: snapshotLayerVisibility(),
          drawingVisibility,
          enabledOverrideRuleIds: (project.overrideRules ?? [])
            .filter((r) => r.enabled)
            .map((r) => r.id),
          ...captureCameraState(planViewRef, viewType),
        };
        const snap = captureViewSnapshot(`vs-${Date.now()}`, name, st);
        applyChange(addItems("viewSnapshots", [snap]));
        setSelectedViewSnapshotId(snap.id);
        return snap.id;
      },

      // Wiederherstellen: ALLE Felder zurückspielen. Reihenfolge: Geschoss ZUERST
      // (setActiveLevelId setzt viewType provisorisch aus viewTypeByLevel), danach
      // die Ansicht (überschreibt es synchron), dann Sichtbarkeit + Overrides.
      // Die Store-Setter laufen synchron im selben Tick; nur den imperativen
      // Massstab-Zoom (Plan muss für den neuen View gemountet sein) via rAF
      // nachziehen — analog zum BIM-Tree-Geschosswechsel.
      onApplyViewSnapshot: (id: string) => {
        const snap = (project.viewSnapshots ?? []).find((s) => s.id === id);
        if (!snap) return;
        const st = readViewSnapshot(snap);
        setActiveLevelId(st.activeLevelId);
        setViewType(st.viewType);
        setView3d(st.view3d);
        setFov(st.fov);
        setDetail(st.detail);
        setScaleDenominator(st.scaleDenominator);
        applyLayerVisibility(st.layerVisibility);
        applyDrawingVisibility(st.drawingVisibility);
        applyChange((p) =>
          fieldOps(p, "overrideRules", applyOverrideRuleEnabled(p.overrideRules ?? [], st.enabledOverrideRuleIds)),
        );
        requestAnimationFrame(() => {
          planViewRef.current?.applyScale(st.scaleDenominator);
          // Kamera NACH `applyScale` restaurieren (nicht statt): `applyScale`
          // setzt auch die Papier-Massstab-Referenz für Strichbreiten
          // (`setPaperScale`, s. `PlanView.tsx`), hält dabei aber die BISHERIGE
          // Bildmitte. `setCamera` schwenkt danach im selben Tick (kein
          // sichtbares Doppel-Springen) auf die erfasste Mitte — nur wenn der
          // Ausschnitt eine Kamera trägt (Alt-Ausschnitte/3D-Erfassung: Mitte
          // bleibt wie bisher unverändert).
          if (st.cameraCenter && st.cameraPxPerMeter) {
            planViewRef.current?.setCamera(st.cameraCenter, st.cameraPxPerMeter);
          }
        });
        // Klick = Anwenden UND Anwählen: der Ausschnitt bleibt markiert, bis der
        // Nutzer eine erfasste Grösse ändert (Abweichungs-Effekt löscht ihn dann).
        setSelectedViewSnapshotId(id);
      },

      onRenameViewSnapshot: (id: string, name: string) => {
        const trimmed = name.trim();
        if (!trimmed) return;
        applyChange((p) => patchItem(p, "viewSnapshots", id, { name: trimmed }));
      },

      onDeleteViewSnapshot: (id: string) => {
        applyChange((p) => removeItems(p, "viewSnapshots", [id]));
        if (selectedViewSnapshotId === id) setSelectedViewSnapshotId(null);
      },

      // ── Ausschnitte-Baum (Ordner, DOSSIER A2) ─────────────────────────────
      // Immutable CRUD über pure Helfer (state/viewSnapshotFolders.ts). Löschen
      // zieht Inhalt auf die Elternebene hoch (kein Datenverlust).
      onAddViewSnapshotFolder: (parentId) => {
        const id = `vsf-${Date.now()}`;
        const folder = createViewSnapshotFolder(
          id,
          t("viewsnap.folder.defaultName"),
          parentId,
        );
        applyChange(addItems("viewSnapshotFolders", [folder]));
        return id;
      },
      onRenameViewSnapshotFolder: (id, name) => {
        const trimmed = name.trim();
        if (!trimmed) return;
        applyChange((p) => patchItem(p, "viewSnapshotFolders", id, { name: trimmed }));
      },
      onDeleteViewSnapshotFolder: (id) => {
        applyChange((p) => {
          const { folders, snapshots } = deleteViewSnapshotFolder(
            id,
            p.viewSnapshotFolders ?? [],
            p.viewSnapshots ?? [],
          );
          return [...fieldOps(p, "viewSnapshotFolders", folders), ...fieldOps(p, "viewSnapshots", snapshots)];
        });
      },
      onMoveViewSnapshotToFolder: (snapshotId, folderId) => {
        applyChange((p) => fieldOps(p, "viewSnapshots", moveSnapshotToFolder(p.viewSnapshots ?? [], snapshotId, folderId)));
      },
      onMoveViewSnapshotFolder: (folderId, parentId) => {
        applyChange((p) =>
          fieldOps(p, "viewSnapshotFolders", moveViewSnapshotFolder(p.viewSnapshotFolders ?? [], folderId, parentId)),
        );
      },

      // Footer-Bar des Ausschnitte-Panels: die aktuell „angewählte" Id plus
      // Lesezugriff auf die benannten Sichtbarkeits-Kombinationen (localStorage),
      // damit der Footer den Kombi-NAMEN zu den gespeicherten Maps auflösen kann.
      selectedViewSnapshotId,
      listLayerCombos,
      loadLayerCombo,
      listDrawingCombos,
      loadDrawingCombo,

      // ── Layouts / Masterlayouts (DOSSIER A3) ──────────────────────────────
      // Immutable CRUD über pure Helfer (panels/layoutModel.ts); das Blatt öffnet
      // als erstklassige Ansicht IM HAUPT-Viewport (activeLayoutId, Phase 2b).
      // Anlegen öffnet es direkt; Löschen schliesst es, falls es das offene trifft.
      onAddLayout: (name, paper, orientation) => {
        const lay = createLayout(`lay-${Date.now()}`, name, paper, orientation);
        // Jedes Blatt trägt seine Blatt-Ebene (2D-Zeichnung auf dem Blatt, s. layoutModel).
        applyChange([...addItems("layouts", [lay]), ...addItems("drawingLevels", [createSheetLevel(`sheet-${lay.id}`, lay)])]);
        setActiveLayoutId(lay.id);
      },
      onRenameLayout: (id, name) => {
        applyChange((p) => patchItem(p, "layouts", id, { name }));
      },
      onDeleteLayout: (id) => {
        // Mit dem Layout gehen seine Blatt-Ebene und deren Zeichnungen (ein Undo-Schritt).
        applyChange((p) => {
          const levels = p.drawingLevels.filter((l) => l.layoutId === id).map((l) => l.id);
          const drawings = p.drawings2d.filter((d) => levels.includes(d.levelId)).map((d) => d.id);
          return [
            ...removeItems(p, "drawings2d", drawings),
            ...removeItems(p, "drawingLevels", levels),
            ...removeItems(p, "layouts", [id]),
          ];
        });
        setActiveLayoutId((cur) => (cur === id ? null : cur));
      },
      onOpenLayout: (id) => setActiveLayoutId(id),
      onAddMasterLayout: (name) => {
        const m = createMasterLayout(`mas-${Date.now()}`, name, "a4", "portrait");
        applyChange(addItems("masterLayouts", [m]));
      },
      onRenameMasterLayout: (id, name) => {
        applyChange((p) => patchItem(p, "masterLayouts", id, { name }));
      },
      onDeleteMasterLayout: (id) => {
        // Master löschen UND Bindungen der Layouts lösen (masterId → undefined).
        applyChange((p) => [
          ...removeItems(p, "masterLayouts", [id]),
          ...patchItems(p, "layouts", (l) => l.masterId === id, (l) => ({ ...l, masterId: undefined })),
        ]);
      },
      onPatchMasterLayout: (id, patch) => {
        applyChange((p) => patchItem(p, "masterLayouts", id, patch));
      },

      // ── Layouts-Baum (Ordner) + Erstell-Dialoge (DOSSIER A3) ────────────
      onAddLayoutFolder: (parentId) => {
        const id = `folder-${Date.now()}`;
        const folder = createLayoutFolder(id, t("layouts.folder.defaultName"), parentId);
        applyChange(addItems("layoutFolders", [folder]));
        return id;
      },
      onAddMasterFolder: (parentId) => {
        const id = `mfolder-${Date.now()}`;
        const folder = createLayoutFolder(
          id,
          t("layouts.folder.defaultName"),
          parentId,
          "master",
        );
        applyChange(addItems("layoutFolders", [folder]));
        return id;
      },
      onDeleteMasterFolder: (id) => {
        applyChange((p) => {
          const { folders, masters } = deleteMasterFolder(
            id,
            p.layoutFolders ?? [],
            p.masterLayouts ?? [],
          );
          return [...fieldOps(p, "layoutFolders", folders), ...fieldOps(p, "masterLayouts", masters)];
        });
      },
      onRenameLayoutFolder: (id, name) => {
        applyChange((p) => patchItem(p, "layoutFolders", id, { name }));
      },
      onDeleteLayoutFolder: (id) => {
        applyChange((p) => {
          const { folders, layouts } = deleteLayoutFolder(
            id,
            p.layoutFolders ?? [],
            p.layouts ?? [],
          );
          return [...fieldOps(p, "layoutFolders", folders), ...fieldOps(p, "layouts", layouts)];
        });
      },
      onCreateLayout: (opts) => {
        const id = `lay-${Date.now()}`;
        // Bei gebundenem Master erbt das Blatt dessen Papier/Ausrichtung/Grösse.
        const master = opts.masterId
          ? (project.masterLayouts ?? []).find((m) => m.id === opts.masterId)
          : undefined;
        const paper = master?.paper ?? opts.paper;
        const orientation = master?.orientation ?? opts.orientation;
        const customWidthMm = master ? master.customWidthMm : opts.customWidthMm;
        const customHeightMm = master ? master.customHeightMm : opts.customHeightMm;
        const lay = createLayout(id, t("layouts.defaultName"), paper, orientation);
        const full = {
          ...lay,
          ...(opts.masterId ? { masterId: opts.masterId } : {}),
          ...(opts.folderId ? { folderId: opts.folderId } : {}),
          ...(customWidthMm !== undefined && customHeightMm !== undefined
            ? { customWidthMm, customHeightMm }
            : {}),
        };
        applyChange([...addItems("layouts", [full]), ...addItems("drawingLevels", [createSheetLevel(`sheet-${id}`, full)])]);
        return id;
      },
      onCreateMasterLayout: (opts) => {
        const id = `mas-${Date.now()}`;
        const custom =
          opts.customWidthMm !== undefined && opts.customHeightMm !== undefined
            ? { widthMm: opts.customWidthMm, heightMm: opts.customHeightMm }
            : undefined;
        const m = createMasterLayout(
          id,
          t("layouts.defaultMasterName"),
          opts.paper,
          opts.orientation,
          custom,
        );
        const full = opts.folderId ? { ...m, folderId: opts.folderId } : m;
        applyChange(addItems("masterLayouts", [full]));
        return id;
      },
      onExportFolderPdf: (folderId) => {
        const folder = (project.layoutFolders ?? []).find((f) => f.id === folderId);
        const name = folder?.name?.trim() || "layouts";
        void folderPdfBytes(project, folderId).then((bytes) => {
          if (bytes) return saveBinaryFile(bytes, `${name}.pdf`, "application/pdf");
        });
      },
      onMoveLayoutToFolder: (layoutId, folderId) => {
        applyChange((p) => fieldOps(p, "layouts", moveLayoutToFolder(p.layouts ?? [], layoutId, folderId)));
      },
      onMoveFolderToFolder: (folderId, parentId) => {
        applyChange((p) =>
          fieldOps(p, "layoutFolders", moveFolderToFolder(p.layoutFolders ?? [], folderId, parentId)),
        );
      },
      onAddPublishSet: () => {
        const id = `pubset-${Date.now()}`;
        applyChange((p) => addPublishSetOps(p, id));
        return id;
      },
      onPatchPublishSet: (id, patch) => applyChange((p) => patchPublishSetOps(p, id, patch), `pubset-${id}`),
      onSetProjectNumber: (value) => applyChange((p) => fieldOps(p, "projectNumber", value.trim() ? value : undefined), "projectNumber"),
      onDeletePublishSet: (id) => applyChange((p) => deletePublishSetOps(p, id)),
      onPublishSet: (id) => {
        void publishSet(project, id).then((ops) => {
          if (ops && ops.length > 0) applyChange(ops);
        });
      },
    };
    return value;
    // setProject-Closures sind stabil genug; Neuberechnung bei project/active.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    project,
    activeLevelId,
    activeCategoryCode,
    activeTool,
    engineView.commandName,
    activeWallTypeId,
    snap,
    viewType,
    view3d,
    fov,
    detail,
    scaleDenominator,
    selection,
    sectionLine,
    selectedSectionLineId,
    section3dCutId,
    onToggleSection3dCut,
    selectedViewSnapshotId,
    selectedContextObjectIds,
  ]);

  return baseHost;
}
