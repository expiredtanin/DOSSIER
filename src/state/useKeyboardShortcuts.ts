// Bündelt die globalen Tastatur-Shortcut-Effekte (Undo/Redo, Tab-Feld-Zyklus,
// Werkzeug-Zifferntasten, aktives-Werkzeug Esc/Enter/Backspace, Alles-wählen +
// Löschen, Split/Join, Kopieren/Einfügen von 2D-Elementen, Boolean-Operationen,
// Transformations-Shortcuts) — nur aus App.tsx herausgezogen, um die Funktion
// zu entlasten. Reine Verlagerung der `useEffect`-Registrierungen inkl. ihrer
// Abhängigkeits-Arrays (auch dort, wo bewusst `eslint-disable` steht) — keine
// Verhaltensänderung. Die Aktions-Funktionen selbst (deleteSelection, runSplit,
// applyBoolean, …) bleiben in App.tsx, da sie auch von Menüs/TopBar gebraucht
// werden, und werden hier nur als Parameter durchgereicht.
//
// Extrahiert aus App.tsx. Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

import { useEffect, useRef } from "react";
import type { MutableRefObject, RefObject } from "react";
import { getTool } from "../tools/tools";
import type { ToolContext, ToolDraft, ToolId, ToolState } from "../tools/types";
import type { CopyMode, TransformOp } from "../tools/transform";
import type { CommandEngine } from "../commands/engine";
import type { CommandLineHandle } from "../ui/CommandLine";
import type { Drawing2D, Project, Vec2 } from "../model/types";
import { differenceDrawings, intersectionDrawings, unionDrawings } from "../editors/booleanOps";
import type { BooleanResult } from "../editors/booleanOps";
import { groupSelection, mergeMembership, ungroup, EMPTY_MEMBERSHIP } from "./groupActions";
import type { GroupMembership } from "./groupActions";

/** Aktive Transformation (Bewegen/Spiegeln/Drehen) — Form aus useDrawingToolState. */
type ActiveTransform = {
  op: TransformOp;
  copyMode: CopyMode;
  count: number;
  points: Vec2[];
} | null;

const isEditableTarget = (e: KeyboardEvent): boolean => {
  const el = e.target as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
};

/** Globaler Undo/Redo-Shortcut: Ctrl+Z / Cmd+Z, Ctrl+Shift+Z / Cmd+Shift+Z bzw. Ctrl+Y für redo. */
export function useUndoRedoShortcut(undo: () => void, redo: () => void): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (!mod || (key !== "z" && key !== "y")) return;
      if (isEditableTarget(e)) return;
      e.preventDefault();
      if (key === "y" || (key === "z" && e.shiftKey)) redo();
      else undo();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo]);
}

/**
 * Globaler Tab-Handler: läuft ein Befehl MIT Feldern (§2.7), zyklt Tab das
 * aktive Feld (Präzisionseingabe), ohne den Fokus zu stehlen — so kann man bei
 * der Maus bleiben. Sonst fokussiert/öffnet Tab die Command-Line. Direktes
 * Zahlen-Tippen beim Zeichnen (VW-Verhalten): läuft ein Befehl mit Tab-Feldern
 * und tippt man eine Ziffer (oder . , -), ohne dass ein Eingabefeld fokussiert
 * ist, startet das die Werteingabe in der Befehlszeile.
 */
export function useCommandTabShortcut(
  engineRef: RefObject<CommandEngine | null>,
  commandLineRef: RefObject<CommandLineHandle | null>,
  gripDragInfoRef: RefObject<{ index: number; raw: Vec2 } | null>,
  gripEditRef: RefObject<{
    anchor: Vec2;
    active: "length" | "angle";
    locks: { length?: number; angle?: number };
  } | null>,
  cycleGripEditFieldRef: RefObject<() => void>,
  // Dasselbe für einen Kanten-Griff (Seite parallel verschieben) — separater
  // Drag-Kanal, aber identisches Tab-Verhalten (öffnen/zyklen + Befehlsfeld
  // fokussieren).
  edgeDragInfoRef?: RefObject<{ edge: unknown; raw: Vec2 } | null>,
  edgeEditRef?: RefObject<unknown>,
  cycleEdgeEditFieldRef?: RefObject<() => void>,
): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const inInput = isEditableTarget(e);
      if (
        !inInput &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        /^[0-9.,-]$/.test(e.key) &&
        engineRef.current?.isActive() &&
        engineRef.current.hasFields()
      ) {
        e.preventDefault();
        commandLineRef.current?.beginTyping(e.key);
        return;
      }
      if (e.key !== "Tab") return;
      if (inInput) {
        return;
      }
      e.preventDefault();
      const eng = engineRef.current;
      if (eng?.isActive() && eng.hasFields()) {
        eng.cycleField();
        return;
      }
      // (c) Läuft ein Vertex-Griff-Drag, öffnet/zyklt Tab das Editier-Feld
      // (Länge/Winkel relativ zur Nachbarecke). Beim ersten Tab wird zusätzlich
      // das Befehlsfeld fokussiert, damit man den Zahlenwert direkt tippen kann.
      if (gripDragInfoRef.current) {
        const wasOpen = gripEditRef.current !== null;
        cycleGripEditFieldRef.current?.();
        if (!wasOpen) commandLineRef.current?.focus();
        return;
      }
      // Dasselbe für einen laufenden Kanten-Drag (Seite parallel verschieben).
      if (edgeDragInfoRef?.current) {
        const wasOpen = edgeEditRef?.current != null;
        cycleEdgeEditFieldRef?.current?.();
        if (!wasOpen) commandLineRef.current?.focus();
        return;
      }
      commandLineRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

/**
 * Nummern-Shortcuts für Zeichenwerkzeuge (Vectorworks-Stil): 1 Text, 2 Linie,
 * 3 Kreis, 4 Rechteck, 5 Polylinie, 6 Wand, 7 Decke, 8 Fenster, 9 Türe, 0 Raum.
 * Nur auf Geschoss-Tabs, nicht mit Modifikator (Ctrl/Cmd/Alt bleiben frei). Der
 * Handler wird einmal registriert und liest die aktuelle Auswahl-Funktion/
 * Ebenen-Art über ein Ref (sonst müsste der Effekt bei jedem Render neu
 * registrieren).
 */
export function useToolNumberShortcuts(
  onSelectTool: (id: ToolId) => void,
  isFloor: boolean,
  engineRef: RefObject<CommandEngine | null>,
  gripDragInfoRef?: RefObject<{ index: number; raw: Vec2 } | null>,
  edgeDragInfoRef?: RefObject<unknown>,
): void {
  const toolShortcutRef = useRef({ onSelectTool, floor: isFloor });
  toolShortcutRef.current = { onSelectTool, floor: isFloor };
  useEffect(() => {
    const MAP: Record<string, ToolId> = {
      "1": "text",
      "2": "line",
      "3": "circle",
      "4": "rect",
      "5": "polyline",
      "6": "wall",
      "7": "ceiling",
      "8": "window",
      "9": "door",
      "0": "room",
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      // Ein Punkt-Griff ist bewaffnet (s. useGripEditing.ts) — Zifferntasten
      // gehören dann IMMER dessen Länge/Winkel-Feld, nie dem Werkzeug-Wechsel.
      // Die `eng?.hasFields()`-Prüfung unten greift hier nicht, weil während
      // der Griff-Bearbeitung gar kein Zeichenbefehl der Engine läuft (Bug:
      // getippter Wert schaltete auf das per Ziffer gemappte Zeichenwerkzeug
      // um, sobald das leere, fokussierte Befehlsfeld erkannt wurde).
      if (gripDragInfoRef?.current) return;
      if (edgeDragInfoRef?.current) return;
      const el = e.target as HTMLElement | null;
      const isInput =
        !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
      if (isInput) {
        const isCmdLineInput = el.classList.contains("cmdline-input");
        const empty = isCmdLineInput && (el as HTMLInputElement).value === "";
        const eng = engineRef.current;
        const cmdLineFreeToSwitch =
          empty && !eng?.hasFields() && !eng?.acceptsFreeText();
        if (!cmdLineFreeToSwitch) return;
      }
      const id = MAP[e.key];
      if (!id) return;
      if (!toolShortcutRef.current.floor) return; // Werkzeuge nur auf Geschossen
      e.preventDefault();
      toolShortcutRef.current.onSelectTool(id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

/**
 * Tastatur für aktive Zeichenwerkzeuge: Esc verwirft den Entwurf (bzw. schaltet
 * im Ruhezustand zurück auf Auswahl), Enter schließt mehrteilige Werkzeuge ab,
 * Backspace nimmt den letzten Punkt zurück. In echten Eingaben inaktiv. Läuft
 * ein gekoppelter Befehl (Linie/Rechteck/Polylinie über die Engine), gehören
 * Esc/Enter/Backspace der Engine bzw. dem Befehlsfeld — der Legacy-Werkzeug-
 * Pfad bleibt stumm (keine doppelte Mechanik).
 */
export function useActiveToolKeys(
  activeTool: ToolId,
  toolCtx: ToolContext,
  engineRef: RefObject<CommandEngine | null>,
  toolStateRef: MutableRefObject<ToolState>,
  setDraft: (draft: ToolDraft | null) => void,
  setActiveTool: (id: ToolId) => void,
  setProject: (next: Project | ((p: Project) => Project)) => void,
): void {
  useEffect(() => {
    if (activeTool === "select") return;
    const onKey = (e: KeyboardEvent) => {
      if (isEditableTarget(e)) return;
      if (engineRef.current?.isActive()) return;
      const tool = getTool(activeTool);
      const drawing = toolStateRef.current.phase !== "idle";
      if (e.key === "Escape") {
        if (drawing) {
          const [st] = tool.onCancel(toolStateRef.current);
          toolStateRef.current = st;
          setDraft(null);
        } else {
          setActiveTool("select");
        }
        e.preventDefault();
      } else if (e.key === "Enter") {
        const [st, res] = tool.onCommitGesture(toolStateRef.current, toolCtx);
        toolStateRef.current = st;
        if (res.commit) setProject(res.commit);
        setDraft(null);
        if (res.done) toolStateRef.current = tool.init();
        e.preventDefault();
      } else if (e.key === "Backspace" && tool.onUndoPoint) {
        const [st, res] = tool.onUndoPoint(toolStateRef.current, toolCtx);
        toolStateRef.current = st;
        setDraft(res.draft);
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeTool, toolCtx]);
}

/**
 * Tastatur im Auswahl-Werkzeug: Ctrl/Cmd+A = alles auf der aktiven Ebene
 * wählen; Entf/Backspace = ALLE Selektierten (Wände + 2D-Elemente) löschen.
 * `hasSelectionToDelete`/`deleteSelection` bleiben in App.tsx (auch vom Menü
 * „Bearbeiten > Löschen" gebraucht) und werden hier nur aufgerufen.
 */
export function useSelectAllAndDeleteShortcut(opts: {
  activeTool: ToolId;
  activeTransform: ActiveTransform;
  project: Project;
  activeLevelId: string;
  selectedDrawingIds: string[];
  selectedWallIds: string[];
  selectedCeilingIds: string[];
  selectedOpeningIds: string[];
  selectedStairIds: string[];
  selectedRoomIds: string[];
  selectedExtrudedSolidIds: string[];
  selectedColumnIds: string[];
  selectedRoofIds: string[];
  selectedContextObjectIds: string[];
  selectedSectionLineId: string | null;
  setSelectedWallIds: (ids: string[]) => void;
  setSelectedDrawingIds: (ids: string[]) => void;
  setSelectedCeilingIds: (ids: string[]) => void;
  setSelectedStairIds: (ids: string[]) => void;
  setSelectedRoomIds: (ids: string[]) => void;
  setSelectedExtrudedSolidIds: (ids: string[]) => void;
  setSelectedColumnIds: (ids: string[]) => void;
  hasSelectionToDelete: () => boolean;
  deleteSelection: () => void;
}): void {
  const {
    activeTool,
    activeTransform,
    project,
    activeLevelId,
    setSelectedWallIds,
    setSelectedDrawingIds,
    setSelectedCeilingIds,
    setSelectedStairIds,
    setSelectedRoomIds,
    setSelectedExtrudedSolidIds,
    setSelectedColumnIds,
    hasSelectionToDelete,
    deleteSelection,
  } = opts;
  useEffect(() => {
    if (activeTool !== "select") return;
    const onKey = (e: KeyboardEvent) => {
      if (isEditableTarget(e)) return;
      // Alles auswählen (Wände + Zeichnungen des aktiven Geschosses/der Ebene).
      if ((e.ctrlKey || e.metaKey) && (e.key === "a" || e.key === "A")) {
        const wallIds = project.walls
          .filter((w) => w.floorId === activeLevelId)
          .map((w) => w.id);
        const drawingIds = project.drawings2d
          .filter((d) => d.levelId === activeLevelId)
          .map((d) => d.id);
        const ceilingIds = (project.ceilings ?? [])
          .filter((c) => c.floorId === activeLevelId)
          .map((c) => c.id);
        const stairIds = (project.stairs ?? [])
          .filter((s) => s.floorId === activeLevelId)
          .map((s) => s.id);
        const roomIds = (project.rooms ?? [])
          .filter((r) => r.floorId === activeLevelId)
          .map((r) => r.id);
        const extrudedSolidIds = (project.extrudedSolids ?? [])
          .filter((s) => s.levelId === activeLevelId)
          .map((s) => s.id);
        const columnIds = (project.columns ?? [])
          .filter((c) => c.floorId === activeLevelId)
          .map((c) => c.id);
        if (
          wallIds.length ||
          drawingIds.length ||
          ceilingIds.length ||
          stairIds.length ||
          roomIds.length ||
          extrudedSolidIds.length ||
          columnIds.length
        ) {
          setSelectedWallIds(wallIds);
          setSelectedDrawingIds(drawingIds);
          setSelectedCeilingIds(ceilingIds);
          setSelectedStairIds(stairIds);
          setSelectedRoomIds(roomIds);
          setSelectedExtrudedSolidIds(extrudedSolidIds);
          setSelectedColumnIds(columnIds);
          e.preventDefault();
        }
        return;
      }
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      if (activeTransform) return; // während einer Transformation nicht löschen
      if (hasSelectionToDelete()) {
        deleteSelection();
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    opts.activeTool,
    opts.activeTransform,
    opts.selectedDrawingIds,
    opts.selectedWallIds,
    opts.selectedCeilingIds,
    opts.selectedOpeningIds,
    opts.selectedStairIds,
    opts.selectedExtrudedSolidIds,
    opts.selectedColumnIds,
    opts.selectedRoofIds,
    opts.selectedContextObjectIds,
    opts.selectedSectionLineId,
    opts.project.walls,
    opts.project.drawings2d,
    opts.project.ceilings,
    opts.project.roofs,
    opts.project.stairs,
    opts.project.extrudedSolids,
    opts.project.columns,
    opts.activeLevelId,
  ]);
}

/**
 * Ctrl/Cmd+S = Split, Ctrl/Cmd+J = Join der selektierten Drawing2D-Elemente.
 * Join läuft über DENSELBEN Engine-Befehl wie getipptes „join" (Sofort-
 * Befehl, autoRun). Split bleibt die direkte Aktion (`runSplit`, in App.tsx —
 * bleibt dort, da es auch für einen etwaigen Menü-Eintrag geteilt wird). Beide
 * rufen preventDefault (sonst Browser-Speichern/-Lesezeichen). Wände sind
 * ausgenommen (no-op). Tool-unabhängig, solange eine 2D-Auswahl steht.
 */
export function useSplitJoinShortcut(
  selectedDrawingIds: string[],
  engine: CommandEngine,
  runSplit: (ids: string[]) => void,
  setSelectedDrawingIds: (ids: string[]) => void,
  setSelectedWallIds: (ids: string[]) => void,
): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      if (k !== "s" && k !== "j") return;
      if (isEditableTarget(e)) return;
      const ids = selectedDrawingIds;
      if (ids.length === 0) return; // nur 2D-Auswahl bedient; Wände → no-op
      e.preventDefault();

      if (k === "s") {
        runSplit(ids);
        return;
      }
      // Join: exakt derselbe Befehl wie „join" tippen (Sofort-Befehl, autoRun).
      // Nach dem Verbinden zeigt die alte Auswahl auf ersetzte IDs → aufräumen.
      engine.start("join");
      setSelectedDrawingIds([]);
      setSelectedWallIds([]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDrawingIds, engine]);
}

/**
 * Ctrl/Cmd+C / Ctrl/Cmd+V = 2D-Zeichenelemente kopieren/einfügen. Kopieren legt
 * die GEWÄHLTEN Drawing2D tief in die Zwischenablage; Einfügen erzeugt Klone mit
 * neuen IDs auf dem AKTIVEN Geschoss (Zeichnungsebene) und wählt sie aus — so
 * wandert z. B. importiertes Mobiliar von einem Geschoss auf ein anderes. Im
 * Textfeld bleibt das native Copy/Paste; ohne 2D-Auswahl kein preventDefault.
 */
export function useDrawingClipboardShortcut(
  selectedDrawingIds: string[],
  drawingClipboard: Drawing2D[],
  setDrawingClipboard: (items: Drawing2D[]) => void,
  activeLevelId: string,
  drawings2d: Drawing2D[],
  importDrawings: (drawings: Drawing2D[]) => void,
  setSelectedDrawingIds: (ids: string[]) => void,
): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k !== "c" && k !== "v") return;
      if (isEditableTarget(e)) return;
      if (k === "c") {
        const ids = new Set(selectedDrawingIds);
        if (ids.size === 0) return; // nur bei 2D-Auswahl (sonst Browser-Copy)
        const picked = drawings2d.filter((d) => ids.has(d.id));
        if (picked.length === 0) return;
        e.preventDefault();
        setDrawingClipboard(picked.map((d) => structuredClone(d)));
        return;
      }
      // Einfügen: Klone auf dem aktiven Geschoss, neue IDs, danach ausgewählt.
      if (drawingClipboard.length === 0) return;
      e.preventDefault();
      const stamp = Date.now();
      const pasted: Drawing2D[] = drawingClipboard.map((d, i) => ({
        ...structuredClone(d),
        id: `drawing-${stamp}-${i}`,
        levelId: activeLevelId,
      }));
      importDrawings(pasted);
      setSelectedDrawingIds(pasted.map((p) => p.id));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDrawingIds, drawingClipboard, activeLevelId, drawings2d]);
}

/**
 * Ctrl/Cmd+Shift+U/D/I = Boolean Vereinigung/Subtraktion/Schnitt der gewählten
 * geschlossenen Drawing2D. preventDefault (sonst Browser-Aktionen). Braucht ≥2
 * geschlossene Flächen; sonst No-op. (Menü spiegelt diese Aktionen.) `applyBoolean`
 * bleibt in App.tsx (auch vom Kontextmenü gebraucht).
 */
export function useBooleanOpsShortcut(
  selectedDrawingIds: string[],
  drawings2d: Drawing2D[],
  applyBoolean: (op: (srcs: Drawing2D[]) => BooleanResult) => void,
): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || !e.shiftKey) return;
      const k = e.key.toLowerCase();
      if (k !== "u" && k !== "d" && k !== "i") return;
      if (isEditableTarget(e)) return;
      if (selectedDrawingIds.length < 2) return;
      e.preventDefault();
      if (k === "u") applyBoolean(unionDrawings);
      else if (k === "d") applyBoolean(differenceDrawings);
      else applyBoolean(intersectionDrawings);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDrawingIds, drawings2d]);
}

/**
 * Transformations-Shortcuts (nur im Auswahl-Werkzeug):
 *  m = Bewegen, s = Spiegeln, d = Drehen (startet auf der Auswahl);
 *  während einer Transformation: u/i/o/p = Modus (move/copy/array/distribute),
 *  Esc = abbrechen. O/P fragen die Kopienanzahl ab. „q" = Messen (Distanz/
 *  Winkel) — braucht KEINE Auswahl.
 */
export function useTransformShortcuts(
  activeTool: ToolId,
  activeTransform: ActiveTransform,
  setActiveTransform: (
    next: ActiveTransform | ((t: ActiveTransform) => ActiveTransform),
  ) => void,
  selectedWallIds: string[],
  selectedDrawingId: string | null,
  selectedExtrudedSolidId: string | null,
  selectedColumnId: string | null,
  engine: CommandEngine,
  setDraft: (draft: ToolDraft | null) => void,
  requestCopyCount: (mode: "array" | "distribute") => void,
  onRunCommand: (name: string) => void,
  commandLineRef: RefObject<CommandLineHandle | null>,
): void {
  useEffect(() => {
    if (activeTool !== "select") return;
    const onKey = (e: KeyboardEvent) => {
      if (isEditableTarget(e)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (activeTransform) {
        const k = e.key.toLowerCase();
        if (k === "u") setActiveTransform((t) => (t ? { ...t, copyMode: "move" } : t));
        else if (k === "i") setActiveTransform((t) => (t ? { ...t, copyMode: "copy" } : t));
        else if (k === "o") {
          requestCopyCount("array");
        } else if (k === "p") {
          requestCopyCount("distribute");
        } else if (e.key === "Escape") {
          setActiveTransform(null);
          setDraft(null);
        } else return;
        e.preventDefault();
        return;
      }
      // „q" = Messen (Distanz/Winkel) — braucht KEINE Auswahl, daher vor hasSel.
      if (e.key.toLowerCase() === "q") {
        onRunCommand("measure");
        e.preventDefault();
        return;
      }
      // Transformierbar sind Wände, 2D-Zeichnungen, extrudierte Körper und Stützen
      // (dieselben Arten wie transformSel). Öffnungen/Treppen laufen bewusst NICHT
      // hierüber, sondern über ihre eigenen Bewegpunkte (Grips) — sie sind wand-
      // bzw. geschossgebunden.
      const hasSel =
        selectedWallIds.length > 0 ||
        !!selectedDrawingId ||
        !!selectedExtrudedSolidId ||
        !!selectedColumnId;
      if (!hasSel) return;
      const k = e.key.toLowerCase();
      // Bewegen/Spiegeln/Drehen laufen ALLE über die interaktive Transformation
      // (`activeTransform`) mit den U/I/O/P-Kopiermodi (Bewegen/Kopie/Reihe/
      // Verteilen). Prompt + Optionen + Live-Feld speisen die Command-Line; die
      // Kürzel U/I/O/P wirken dort auch bei fokussiertem Eingabefeld (options.key).
      const op: TransformOp | null =
        k === "m" ? "move" : k === "s" ? "mirror" : k === "d" ? "rotate" : null;
      if (op) {
        setActiveTransform({ op, copyMode: "move", count: 1, points: [] });
        setDraft(null);
        requestAnimationFrame(() => commandLineRef.current?.focus());
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    activeTool,
    activeTransform,
    selectedWallIds,
    selectedDrawingId,
    selectedExtrudedSolidId,
    selectedColumnId,
    engine,
  ]);
}

/**
 * Ctrl/Cmd+G = Auswahl gruppieren (Vectorworks-artig); Ctrl/Cmd+Shift+G =
 * gewählte Gruppe(n) auflösen (EIN Level — Untergruppen bleiben bestehen).
 * `applySelection` setzt danach alle betroffenen `selected…Ids`-Kanäle +
 * `selectedGroupIds` auf einen Schlag (s. App.tsx, dieselbe Form wie die
 * Gruppen-Erweiterung beim Klicken in `useMouseSelectionHandlers.ts`).
 */
export function useGroupShortcut(
  project: Project,
  setProject: (updater: (p: Project) => Project) => void,
  currentSelection: GroupMembership,
  selectedGroupIds: string[],
  applySelection: (mem: GroupMembership, groupIds: string[]) => void,
): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key.toLowerCase() !== "g") return;
      if (isEditableTarget(e)) return;
      e.preventDefault();
      if (e.shiftKey) {
        // Ungruppieren: für jede gewählte Gruppe eine Hülle auflösen; ihre
        // direkten Mitglieder (+ Untergruppen) werden die neue Auswahl.
        if (selectedGroupIds.length === 0) return;
        let p = project;
        let members: GroupMembership = { ...EMPTY_MEMBERSHIP };
        const newGroupIds: string[] = [];
        for (const gid of selectedGroupIds) {
          const res = ungroup(p, gid);
          if (!res) continue;
          p = res.project;
          members = mergeMembership(members, res.members);
          newGroupIds.push(...res.subGroupIds);
        }
        setProject(() => p);
        applySelection(members, newGroupIds);
        return;
      }
      // Gruppieren: aktuelle Auswahl (+ bereits gewählte Gruppen als Untergruppen).
      const res = groupSelection(project, currentSelection, selectedGroupIds);
      if (!res) return;
      setProject(() => res.project);
      applySelection(currentSelection, [res.groupId]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, currentSelection, selectedGroupIds]);
}
