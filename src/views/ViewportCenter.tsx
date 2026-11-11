// Mitte der App ([121]): Hauptansicht (`Content`) und die Befehlszeile darunter, samt allem, was dafür
// das ganze Projekt liest — Eingaben der Griffe (`useGripInputs`), 2D- und 3D-Griffe
// (`useGripEditing`, `useGrip3dEditing`), Zifferntasten der Werkzeuge (brauchen die Griff-Zustände) und
// die Bindung von Befehlszeile und Cursor-HUD (`useCommandLineBinding`). Diese Komponente abonniert das
// Projekt, nicht `App`: eine Op am Modell rendert hier und in den Panels, die die Daten zeigen, aber
// nicht die ganze App. Gerendert von `App.tsx`; die Werte und Handler kommen von dort durch.

import type { ComponentProps, RefObject } from "react";
import type { DrawingLevel } from "../model/types";
import type { ToolId } from "../tools/types";
import type { DisplayUnits } from "../tools/displayUnits";
import type { EngineView } from "../commands/engine";
import { useStore } from "../state/appStore";
import type { RootState } from "../state/appStore";
import { useEventBundle } from "../state/useEvent";
import { useGripInputs } from "../state/useGripInputs";
import { useGripEditing } from "../state/useGripEditing";
import { useGrip3dEditing } from "../state/useGrip3dEditing";
import { useCommandLineBinding } from "../state/useCommandLineBinding";
import { useToolNumberShortcuts } from "../state/useKeyboardShortcuts";
import type { ShortcutOverrides } from "../state/keyboardShortcuts";
import type { useCommandEngineHost } from "../state/useCommandEngineHost";
import type { useProjectActions } from "../state/useProjectActions";
import type { useSelectionState } from "../state/useSelectionState";
import type { SnapSettings, ToolDraft } from "../tools/types";
import { CommandLine, type CommandLineHandle } from "../ui/CommandLine";
import type { PlanViewHandle } from "./plan/PlanView";
import { Content } from "./viewportContent";

type ContentProps = ComponentProps<typeof Content>;
type EngineHost = ReturnType<typeof useCommandEngineHost>;
type Sel = ReturnType<typeof useSelectionState>;

/** Props von `Content`, die hier (aus Projekt und Griffen) entstehen statt in `App`. */
type DerivedContentProps =
  | "project"
  | "roomStamp"
  | "hudFields"
  | "grips"
  | "gripHandleLines"
  | "edgeGrips"
  | "gripHandlers"
  | "edit3dWalls"
  | "edit3dDrawings"
  | "edit3dCeilings"
  | "edit3dRoofs"
  | "onEdit3dVertex"
  | "onEdit3dBody"
  | "onEdit3dEdge"
  | "onEdit3dRoofPitch"
  | "onEdit3dWallTop"
  | "onEdit3dEnd"
  | "onGrip3dEditTab"
  | "onGrip3dEditCancel";

export function ViewportCenter(props: {
  /** Alle übrigen Props der Hauptansicht, unverändert aus `App`. */
  content: Omit<ContentProps, DerivedContentProps>;
  activeLevel: DrawingLevel;
  selection: Sel["selection"];
  selectedDrawingId: string | null;
  selectedCeilingId: string | null;
  selectedRoomId: string | null;
  visibleCodes: Set<string>;
  snap: SnapSettings;
  /** Massstab der Arbeitsebene (Blatt: 1:1). */
  planScale: number;
  setDraft: (d: ToolDraft | null) => void;
  undo: RootState["undo"];
  groupChanges: RootState["groupChanges"];
  pa: ReturnType<typeof useProjectActions>;
  updateRoof: Sel["updateRoof"];
  moveRoofGrip: Sel["moveRoofGrip"];
  moveRoofBy: Sel["moveRoofBy"];
  engineRef: EngineHost["engineRef"];
  engine: EngineHost["engine"];
  engineView: EngineView;
  commandActive: boolean;
  commandLineRef: RefObject<CommandLineHandle>;
  cmdTyped: string;
  setCmdTyped: EngineHost["setCmdTyped"];
  shortcutOverrides: ShortcutOverrides;
  onSelectTool: (id: ToolId) => void;
  displayUnits: DisplayUnits;
  planViewRef: RefObject<PlanViewHandle>;
  /** Stabile Handler der Befehlszeile aus `App` (Option, noch aktiv?, Vorschläge). */
  onCommandOption: (id: string) => void;
  cmdStillActive: () => boolean;
  cmdSuggest: EngineHost["engine"]["suggest"];
}) {
  const {
    activeLevel,
    selection,
    visibleCodes,
    snap,
    planScale,
    setDraft,
    groupChanges,
    pa,
    engineRef,
    commandLineRef,
  } = props;
  const project = useStore((s) => s.project);

  // ── Einzeln gewählte Elemente, Blatt, Fang für die Griffe → state/useGripInputs.ts ──
  const { selectedDrawing, selectedCeiling, selectedExcavation, selectedRoof, selectedRoom, roomStamp, sectionSheet, snapFor } = useGripInputs({
    project,
    activeLevel,
    selection,
    selectedDrawingId: props.selectedDrawingId,
    selectedCeilingId: props.selectedCeilingId,
    selectedRoomId: props.selectedRoomId,
    visibleCodes,
    snap,
    planScale,
  });

  // ── 2D-Griffe (Eckpunkt-/Kanten-Griffe + Feld-Controller) der Auswahl → state/useGripEditing.ts ──
  const grip2d = useGripEditing({
    project,
    selectedDrawing,
    selectedCeiling,
    selectedExcavation,
    selectedRoof,
    selectedRoom,
    selection,
    levelId: activeLevel.id,
    modelEditable: activeLevel.kind !== "section" && activeLevel.kind !== "elevation",
    sheet: sectionSheet,
    visibleCodes,
    scaleDenominator: planScale,
    snap,
    setDraft,
    snapFor,
    engineRef,
    commandLineRef,
    updateOpening: pa.updateOpening,
    slideOpening: pa.slideOpening,
    sheetHeightGrip: pa.sheetHeightGrip,
    moveStairBy: pa.moveStairBy,
    dragStairParam: pa.dragStairParam,
    moveRoomGrip: pa.moveRoomGrip,
    moveCeilingGrip: pa.moveCeilingGrip,
    moveExcavationGrip: pa.moveExcavationGrip,
    moveExcavationEdge: pa.moveExcavationEdge,
    moveRoofVertex: pa.moveRoofVertex,
    moveRoofEdge: pa.moveRoofEdge,
    moveGripOf: pa.moveGripOf,
    moveRoomEdge: pa.moveRoomEdge,
    moveCeilingEdge: pa.moveCeilingEdge,
    moveEdgeOf: pa.moveEdgeOf,
    moveRoomBy: pa.moveRoomBy,
    moveCeilingBy: pa.moveCeilingBy,
    moveElementByOf: pa.moveElementByOf,
    groupChanges,
  });
  const { grips, gripHandleLines, edgeGrips, gripHandlers, gripDragInfoRef, edgeDragInfoRef } = grip2d;

  // Nummern-Shortcuts für Zeichenwerkzeuge (Vectorworks-Stil): 1 Text, 2 Linie,
  // 3 Kreis, 4 Rechteck, 5 Polylinie, 6 Wand, 7 Decke, 8 Fenster, 9 Türe, 0 Raum.
  // Siehe state/useKeyboardShortcuts.ts. Braucht gripDragInfoRef/edgeDragInfoRef
  // (s. o.), daher erst hier nach useGripEditing() registriert.
  useToolNumberShortcuts(
    props.onSelectTool,
    activeLevel.kind === "floor",
    engineRef,
    props.shortcutOverrides,
    gripDragInfoRef,
    edgeDragInfoRef,
  );

  // ── 3D-Editier-Griffe (direkt im Viewport3D) → state/useGrip3dEditing.ts ───
  const grip3d = useGrip3dEditing({
    project,
    levelId: activeLevel.id,
    visibleCodes,
    snap,
    setDraft,
    undo: props.undo,
    commandLineRef,
    selection,
    updateRoof: props.updateRoof,
    moveRoofGrip: props.moveRoofGrip,
    moveRoofBy: props.moveRoofBy,
    moveCeilingGrip: pa.moveCeilingGrip,
    moveCeilingBy: pa.moveCeilingBy,
    moveCeilingEdge: pa.moveCeilingEdge,
    moveGripOf: pa.moveGripOf,
    moveElementByOf: pa.moveElementByOf,
    updateWall: pa.updateWall,
  });
  const {
    edit3dWalls, edit3dDrawings, edit3dCeilings, edit3dRoofs, onEdit3dVertex, onEdit3dBody, onEdit3dEdge,
    onEdit3dRoofPitch, onEdit3dWallTop, onEdit3dEnd, cycleGrip3dEditField, cancelGrip3dEdit,
  } = grip3d;

  // Befehlszeile + Cursor-HUD: Feld-Controller der Griffe oder Engine → state/useCommandLineBinding.ts.
  const {
    hudFields, cmdLineActive, cmdLinePromptKey, cmdLineOptions, cmdLineFields, cmdLineSteps, onCmdSubmit,
    onCmdCycleField, onCmdCancel,
  } = useCommandLineBinding({
    engine: props.engine,
    engineView: props.engineView,
    commandActive: props.commandActive,
    cmdTyped: props.cmdTyped,
    displayUnits: props.displayUnits,
    planViewRef: props.planViewRef,
    grip2d,
    grip3d,
  });
  // Stabile Handler für die memoisierte Befehlszeile ([121]).
  const cmd = useEventBundle({ onCmdSubmit, onCmdCycleField, onCmdCancel });

  return (
    <>
      {/* Hauptansicht (Mitte) — füllt den verbleibenden Platz. Die Plan-
          Ansicht meldet Cursor + Zoom an die Status-/Oberleiste und nimmt
          das Zoom-Handle entgegen. */}
      <Content
        {...props.content}
        project={project}
        roomStamp={roomStamp}
        hudFields={hudFields}
        grips={grips}
        gripHandleLines={gripHandleLines}
        edgeGrips={edgeGrips}
        gripHandlers={gripHandlers}
        edit3dWalls={edit3dWalls}
        edit3dDrawings={edit3dDrawings}
        edit3dCeilings={edit3dCeilings}
        edit3dRoofs={edit3dRoofs}
        onEdit3dVertex={onEdit3dVertex}
        onEdit3dBody={onEdit3dBody}
        onEdit3dEdge={onEdit3dEdge}
        onEdit3dRoofPitch={onEdit3dRoofPitch}
        onEdit3dWallTop={onEdit3dWallTop}
        onEdit3dEnd={onEdit3dEnd}
        onGrip3dEditTab={cycleGrip3dEditField}
        onGrip3dEditCancel={cancelGrip3dEdit}
      />
      {/* Command-Line (Rhino-artig) UNTER dem Viewport — nur Viewport-breit.
          Prompt + klickbare Inline-Optionen + Texteingabe + Autocomplete. */}
      <CommandLine
        ref={commandLineRef}
        units={props.displayUnits}
        active={cmdLineActive}
        promptKey={cmdLinePromptKey}
        options={cmdLineOptions}
        fields={cmdLineFields}
        onSubmit={cmd.onCmdSubmit}
        onOption={props.onCommandOption}
        onCycleField={cmd.onCmdCycleField}
        onCancel={cmd.onCmdCancel}
        stillActive={props.cmdStillActive}
        steps={cmdLineSteps}
        suggest={props.cmdSuggest}
        onTextChange={props.setCmdTyped}
      />
    </>
  );
}
