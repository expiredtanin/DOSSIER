// Kontextmenü der App ([163], aus App.tsx herausgelöst): verdrahtet das offene Menü (`MenuState`,
// genau eines: Ebene, Zeichnungsebene, Grundriss, 3D) mit den Projekt-Aktionen und den Befehlen auf
// der Auswahl. Die Einträge selbst baut `buildMenuItems` (contextMenu.tsx). Gerendert von `App.tsx`,
// solange ein Menü offen ist. Das Projekt abonniert das Menü selbst ([121], App liest es nicht mehr);
// die Anzeige-Werte zur Auswahl rechnet `selectionMenuState`.

import type { RefObject } from "react";
import { useStore } from "../state/appStore";
import { ContextMenu } from "../ui/ContextMenu";
import type { PlanViewHandle } from "../views/plan/PlanView";
import { countClosedAreas, differenceDrawings, intersectionDrawings, unionDrawings } from "../editors/booleanOps";
import { categoryNames } from "../state/selectionLayers";
import type { useProjectActions } from "../state/useProjectActions";
import { selectionMenuState, type useSelectionCommands } from "../state/useSelectionCommands";
import type { useSelectionState } from "../state/useSelectionState";
import { buildMenuItems, menuTitle, type MenuState } from "./contextMenu";
import type { useContextMenuState } from "./useContextMenuState";

type Menu = ReturnType<typeof useContextMenuState>;
type Sel = ReturnType<typeof useSelectionState>;

export function AppContextMenu(props: {
  menu: NonNullable<MenuState>;
  selection: Sel["selection"];
  setSelection: Sel["setSelection"];
  selectedWallId: string | null;
  layerClipboard: Menu["layerClipboard"];
  setLayerClipboard: Menu["setLayerClipboard"];
  drawingStyleClipboard: Menu["drawingStyleClipboard"];
  setMenu: Menu["setMenu"];
  setEditor: Menu["setEditor"];
  openLayerSettings: (code: string, x: number, y: number) => void;
  planViewRef: RefObject<PlanViewHandle | null>;
  pa: ReturnType<typeof useProjectActions>;
  selCmds: ReturnType<typeof useSelectionCommands>;
}) {
  const {
    menu,
    selection,
    setSelection,
    selectedWallId,
    layerClipboard,
    setLayerClipboard,
    drawingStyleClipboard,
    setMenu,
    setEditor,
    openLayerSettings,
    planViewRef,
  } = props;
  const {
    addSubCategory,
    assignWallCategory,
    duplicateCategory,
    deleteCategory,
    patchCategory,
    duplicateLevel,
    deleteLevel,
    reorderDrawings,
    insertDrawingPoint,
    insertSectionBend,
    deleteSectionBend,
    deleteDrawingPoint,
    setPolylineVertexType,
    reorderDrawingLevels,
  } = props.pa;
  const {
    applyBoolean,
    copyDrawingStyle,
    pasteDrawingStyle,
    selectionLockIds,
    toggleSelectionLock,
    hideSelectionLayers,
    isolateSelectionLayers,
    toggleSelectionNoPrint,
    detachDimensions,
    resetDimensionTexts,
  } = props.selCmds;
  const project = useStore((s) => s.project);
  const { selectionAllLocked, selectionLayerCodes, selectionAllNoPrint, attachedDimensionIds, movedDimTextIds } = selectionMenuState(
    project,
    selection,
    true,
  );
  return (
    <ContextMenu
      x={menu.x}
      y={menu.y}
      title={menuTitle(menu, project)}
      items={buildMenuItems(menu, {
        project,
        selectedWallId,
        layerClipboard,
        openLayerEditor: (code) => openLayerSettings(code, menu.x, menu.y),
        openLevelEditor: (id) =>
          setEditor({ kind: "level", id, x: menu.x, y: menu.y }),
        addSubCategory,
        assignWallCategory,
        duplicateCategory,
        deleteCategory,
        setLayerClipboard,
        patchCategory,
        duplicateLevel,
        deleteLevel,
        clearSelection: () => setSelection({ walls: [] }),
        fit: () => planViewRef.current?.fit(),
        fitSelection: () => planViewRef.current?.fitSelection(),
        closedSelectionCount: countClosedAreas(
          project.drawings2d.filter((d) =>
            selection.drawings.includes(d.id),
          ),
        ),
        union: () => applyBoolean(unionDrawings),
        difference: () => applyBoolean(differenceDrawings),
        intersect: () => applyBoolean(intersectionDrawings),
        drawingSelectionCount: selection.drawings.length,
        hasDrawingStyleClipboard: drawingStyleClipboard !== null,
        copyDrawingStyle,
        pasteDrawingStyle,
        lockableSelectionCount: selectionLockIds.length,
        selectionAllLocked,
        toggleSelectionLock,
        selectionLayerNames: categoryNames(project.layers, selectionLayerCodes),
        hideSelectionLayers,
        isolateSelectionLayers,
        selectionAllNoPrint: !!selectionAllNoPrint,
        toggleSelectionNoPrint,
        attachedDimensionCount: attachedDimensionIds.length,
        detachDimensions,
        movedDimensionTextCount: movedDimTextIds.length,
        resetDimensionTexts,
        bringToFront: () => reorderDrawings(selection.drawings, "front"),
        bringForward: () => reorderDrawings(selection.drawings, "forward"),
        sendBackward: () => reorderDrawings(selection.drawings, "backward"),
        sendToBack: () => reorderDrawings(selection.drawings, "back"),
        // Stützpunkt-Einträge nur bei GENAU EINER selektierten Polylinie
        // (mehrere gleichzeitig hätten keinen eindeutigen Klick-Bezug).
        selectedPolyline: (() => {
          if (selection.drawings.length !== 1) return null;
          const d = project.drawings2d.find((x) => x.id === selection.drawings[0]);
          return d && d.geom.shape === "polyline"
            ? { id: d.id, pts: d.geom.pts, closed: d.geom.closed, bulge: d.geom.bulge }
            : null;
        })(),
        // [176] Geknickte Schnittlinie: Knick einfügen/löschen am gewählten Schnitt.
        selectedSectionLine: (() => {
          if (selection.sectionLines.length !== 1) return null;
          const l = project.drawingLevels.find((x) => x.id === selection.sectionLines[0] && x.linePoints);
          return l?.linePoints ? { id: l.id, pts: [l.linePoints[0], ...(l.bendPoints ?? []), l.linePoints[1]] } : null;
        })(),
        insertSectionBend,
        deleteSectionBend,
        insertPolylinePoint: insertDrawingPoint,
        deletePolylinePoint: deleteDrawingPoint,
        setPolylineVertexType,
        reorderLevel: (id, op) => reorderDrawingLevels([id], op),
      })}
      onClose={() => setMenu(null)}
    />
  );
}
