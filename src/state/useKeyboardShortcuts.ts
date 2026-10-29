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
import type { CoreOp, ProjectMutation } from "../core";
import { differenceDrawings, intersectionDrawings, unionDrawings } from "../editors/booleanOps";
import type { BooleanResult } from "../editors/booleanOps";
import { groupSelection, mergeMembership, ungroup, EMPTY_MEMBERSHIP } from "./groupActions";
import type { GroupMembership } from "./groupActions";
import {
  collectElementClipboard,
  isClipboardEmpty,
  pasteElementClipboard,
} from "../editors/elementClipboard";
import type { ElementClipboard, ElementSelectionIds } from "../editors/elementClipboard";
import { parseClipboardText, serializeClipboardText } from "../editors/elementClipboardSerialize";
import { matchesShortcut, type ShortcutId, type ShortcutOverrides } from "./keyboardShortcuts";

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

/**
 * Globaler Undo/Redo-Shortcut: rebindbare Haupt-Kombination (Default Ctrl/
 * Cmd+Z bzw. Ctrl/Cmd+Shift+Z, s. `state/keyboardShortcuts.ts::SHORTCUT_DEFS`)
 * + fest verdrahtete Ctrl/Cmd+Y-Zusatzbelegung für Redo (Excel/Windows-
 * Konvention, bleibt IMMER aktiv, unabhängig von einer Übersteuerung).
 */
export function useUndoRedoShortcut(
  undo: () => void,
  redo: () => void,
  overrides: ShortcutOverrides,
): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isEditableTarget(e)) return;
      if (matchesShortcut(e, "redo", overrides)) {
        e.preventDefault();
        redo();
        return;
      }
      if (matchesShortcut(e, "undo", overrides)) {
        e.preventDefault();
        undo();
        return;
      }
      const mod = e.ctrlKey || e.metaKey;
      if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "y") {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo, overrides]);
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
/** Reihenfolge/Zuordnung Ziffer→Werkzeug — Ids der rebindbaren Kombination in `keyboardShortcuts.ts`. */
const TOOL_SHORTCUT_IDS: { id: ShortcutId; tool: ToolId }[] = [
  { id: "toolText", tool: "text" },
  { id: "toolLine", tool: "line" },
  { id: "toolCircle", tool: "circle" },
  { id: "toolRect", tool: "rect" },
  { id: "toolPolyline", tool: "polyline" },
  { id: "toolWall", tool: "wall" },
  { id: "toolCeiling", tool: "ceiling" },
  { id: "toolWindow", tool: "window" },
  { id: "toolDoor", tool: "door" },
  { id: "toolRoom", tool: "room" },
];

export function useToolNumberShortcuts(
  onSelectTool: (id: ToolId) => void,
  isFloor: boolean,
  engineRef: RefObject<CommandEngine | null>,
  overrides: ShortcutOverrides,
  gripDragInfoRef?: RefObject<{ index: number; raw: Vec2 } | null>,
  edgeDragInfoRef?: RefObject<unknown>,
): void {
  const toolShortcutRef = useRef({ onSelectTool, floor: isFloor, overrides });
  toolShortcutRef.current = { onSelectTool, floor: isFloor, overrides };
  useEffect(() => {
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
      const match = TOOL_SHORTCUT_IDS.find(({ id }) =>
        matchesShortcut(e, id, toolShortcutRef.current.overrides),
      );
      if (!match) return;
      if (!toolShortcutRef.current.floor) return; // Werkzeuge nur auf Geschossen
      e.preventDefault();
      toolShortcutRef.current.onSelectTool(match.tool);
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
  setProject: (next: ProjectMutation) => void,
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
  shortcutOverrides: ShortcutOverrides;
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
  selectedSectionLineIds: string[];
  setSelectedWallIds: (ids: string[]) => void;
  setSelectedDrawingIds: (ids: string[]) => void;
  setSelectedCeilingIds: (ids: string[]) => void;
  setSelectedOpeningIds: (ids: string[]) => void;
  setSelectedStairIds: (ids: string[]) => void;
  setSelectedRoomIds: (ids: string[]) => void;
  setSelectedExtrudedSolidIds: (ids: string[]) => void;
  setSelectedColumnIds: (ids: string[]) => void;
  setSelectedRoofIds: (ids: string[]) => void;
  setSelectedContextObjectIds: (ids: string[]) => void;
  setSelectedSectionLineIds: (ids: string[]) => void;
  hasSelectionToDelete: () => boolean;
  deleteSelection: () => void;
}): void {
  const {
    activeTool,
    activeTransform,
    project,
    activeLevelId,
    shortcutOverrides,
    setSelectedWallIds,
    setSelectedDrawingIds,
    setSelectedCeilingIds,
    setSelectedOpeningIds,
    setSelectedStairIds,
    setSelectedRoomIds,
    setSelectedExtrudedSolidIds,
    setSelectedColumnIds,
    setSelectedRoofIds,
    setSelectedSectionLineIds,
    hasSelectionToDelete,
    deleteSelection,
  } = opts;
  useEffect(() => {
    if (activeTool !== "select") return;
    const onKey = (e: KeyboardEvent) => {
      if (isEditableTarget(e)) return;
      // Escape = Auswahl aufheben. Erst NACH den anderen Escape-Handlern prüfen
      // (bewaffneter Griff, Entwurf, Dialoge verbrauchen Esc per preventDefault) —
      // daher im Mikro-Task: nur wenn niemand sonst Esc beansprucht hat.
      if (e.key === "Escape" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        queueMicrotask(() => {
          if (e.defaultPrevented) return;
          const any =
            opts.selectedDrawingIds.length > 0 ||
            opts.selectedWallIds.length > 0 ||
            opts.selectedCeilingIds.length > 0 ||
            opts.selectedOpeningIds.length > 0 ||
            opts.selectedStairIds.length > 0 ||
            opts.selectedRoomIds.length > 0 ||
            opts.selectedExtrudedSolidIds.length > 0 ||
            opts.selectedColumnIds.length > 0 ||
            opts.selectedRoofIds.length > 0 ||
            opts.selectedContextObjectIds.length > 0 ||
            opts.selectedSectionLineIds.length > 0;
          if (!any) return;
          setSelectedWallIds([]);
          setSelectedDrawingIds([]);
          setSelectedCeilingIds([]);
          setSelectedOpeningIds([]);
          setSelectedStairIds([]);
          setSelectedRoomIds([]);
          setSelectedExtrudedSolidIds([]);
          setSelectedColumnIds([]);
          setSelectedRoofIds([]);
          opts.setSelectedContextObjectIds([]);
          setSelectedSectionLineIds([]);
        });
        return;
      }
      // Alles auswählen (alle Bauteilarten des aktiven Geschosses/der Ebene +
      // die Schnittlinien-Symbole, die auf JEDEM Grundriss erscheinen).
      if (matchesShortcut(e, "selectAll", shortcutOverrides)) {
        const wallIds = project.walls
          .filter((w) => w.floorId === activeLevelId)
          .map((w) => w.id);
        const wallIdSet = new Set(wallIds);
        const drawingIds = project.drawings2d
          .filter((d) => d.levelId === activeLevelId)
          .map((d) => d.id);
        const ceilingIds = (project.ceilings ?? [])
          .filter((c) => c.floorId === activeLevelId)
          .map((c) => c.id);
        // Öffnungen haben kein eigenes floorId (das Geschoss ergibt sich aus
        // der Wirtswand) — über die bereits geschossgefilterten Wand-Ids.
        const openingIds = (project.openings ?? [])
          .filter((o) => wallIdSet.has(o.hostWallId))
          .map((o) => o.id);
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
        const roofIds = (project.roofs ?? [])
          .filter((r) => r.floorId === activeLevelId)
          .map((r) => r.id);
        // Schnittführungs-Symbole sind projektweit (kein floorId-Bezug — sie
        // werden auf JEDEM Grundriss gezeichnet, s. plan/context.rs im Kern,
        // plan_section_lines), anders als die übrigen, geschossgefilterten Kanäle.
        const sectionLineIds = project.drawingLevels
          .filter((l) => (l.kind === "section" || l.kind === "elevation") && l.linePoints)
          .map((l) => l.id);
        // Kontext-Objekte (importierte Gebäude/Terrain) sind ebenfalls
        // projektweit, aber bewusst NICHT Teil von „Alles auswählen" — anders
        // als Schnittlinien sind sie Hintergrund-/Referenzgeometrie, kein
        // Geschossinhalt; ein versehentliches Löschen wäre riskanter als
        // hilfreich. Bleibt daher unverändert (kein Clear, kein Select).
        if (
          wallIds.length ||
          drawingIds.length ||
          ceilingIds.length ||
          openingIds.length ||
          stairIds.length ||
          roomIds.length ||
          extrudedSolidIds.length ||
          columnIds.length ||
          roofIds.length ||
          sectionLineIds.length
        ) {
          setSelectedWallIds(wallIds);
          setSelectedDrawingIds(drawingIds);
          setSelectedCeilingIds(ceilingIds);
          setSelectedOpeningIds(openingIds);
          setSelectedStairIds(stairIds);
          setSelectedRoomIds(roomIds);
          setSelectedExtrudedSolidIds(extrudedSolidIds);
          setSelectedColumnIds(columnIds);
          setSelectedRoofIds(roofIds);
          setSelectedSectionLineIds(sectionLineIds);
          e.preventDefault();
        }
        return;
      }
      // Backspace bleibt fest verdrahtete Zusatzbelegung (bare, kein Modifikator)
      // neben der rebindbaren Haupt-Kombination (Default "Delete").
      const isDelete =
        matchesShortcut(e, "deleteSelection", shortcutOverrides) ||
        (e.key === "Backspace" && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey);
      if (!isDelete) return;
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
    opts.shortcutOverrides,
    opts.selectedDrawingIds,
    opts.selectedWallIds,
    opts.selectedCeilingIds,
    opts.selectedOpeningIds,
    opts.selectedStairIds,
    opts.selectedRoomIds,
    opts.selectedExtrudedSolidIds,
    opts.selectedColumnIds,
    opts.selectedRoofIds,
    opts.selectedContextObjectIds,
    opts.selectedSectionLineIds,
    opts.project.walls,
    opts.project.drawings2d,
    opts.project.ceilings,
    opts.project.openings,
    opts.project.roofs,
    opts.project.stairs,
    opts.project.rooms,
    opts.project.extrudedSolids,
    opts.project.columns,
    opts.project.drawingLevels,
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
  overrides: ShortcutOverrides,
): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isEditableTarget(e)) return;
      const isSplit = matchesShortcut(e, "split", overrides);
      const isJoin = !isSplit && matchesShortcut(e, "join", overrides);
      if (!isSplit && !isJoin) return;
      const ids = selectedDrawingIds;
      if (ids.length === 0) return; // nur 2D-Auswahl bedient; Wände → no-op
      e.preventDefault();

      if (isSplit) {
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
  }, [selectedDrawingIds, engine, overrides]);
}

/**
 * Ctrl/Cmd+C / Ctrl/Cmd+V = Bauteile kopieren/einfügen — über ALLE 9 Auswahl-
 * Kanäle hinweg (Wand/Decke/Dach/Öffnung/Treppe/Raum/Extrusion/Stütze +
 * 2D-Zeichenelemente), s. `editors/elementClipboard.ts` für die reine Logik
 * (inkl. der Öffnung↔Wand-Paarkopplung). Einfügen erzeugt Klone mit neuen IDs
 * auf dem AKTIVEN Geschoss (an denselben Modell-Koordinaten) und wählt sie
 * aus — so wandert z. B. importiertes Mobiliar von einem Geschoss auf ein
 * anderes. Im Textfeld bleibt das native Copy/Paste; ohne Auswahl kein
 * preventDefault (Browser-Copy bleibt möglich).
 *
 * OS-Zwischenablage (Nutzer-Wunsch: „kein Copy/Paste zwischen zwei Fenstern/
 * Projekten derselben App"): Kopieren schreibt ZUSÄTZLICH zum React-State
 * einen markierten JSON-Text via `navigator.clipboard.writeText` (s.
 * `editors/elementClipboardSerialize.ts`) — bestes Bemühen, Fehler (Rechte
 * verweigert, API fehlt) werden verschluckt, der In-App-State bleibt der
 * verlässliche Pfad. Einfügen liest ZUERST `navigator.clipboard.readText()`
 * (deshalb async): parst der Text erfolgreich als unsere Marke, hat er
 * Vorrang (ermöglicht Einfügen aus einem ANDEREN Fenster/derselben-App-
 * Instanz); scheitert das (fremder Text, keine Berechtigung, API fehlt),
 * fällt es auf den In-App-`elementClipboard`-State zurück — unverändertes
 * Verhalten für den bisherigen Innerhalb-eines-Fensters-Fall.
 */
export function useElementClipboardShortcut(
  sel: ElementSelectionIds,
  elementClipboard: ElementClipboard | null,
  setElementClipboard: (c: ElementClipboard | null) => void,
  activeLevelId: string,
  project: Project,
  applyChange: (ops: readonly CoreOp[]) => void,
  setSelected: {
    wallIds: (ids: string[]) => void;
    drawingIds: (ids: string[]) => void;
    ceilingIds: (ids: string[]) => void;
    roofIds: (ids: string[]) => void;
    openingIds: (ids: string[]) => void;
    stairIds: (ids: string[]) => void;
    roomIds: (ids: string[]) => void;
    extrudedSolidIds: (ids: string[]) => void;
    columnIds: (ids: string[]) => void;
  },
  overrides: ShortcutOverrides,
): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const isCopy = matchesShortcut(e, "copyElements", overrides);
      const isPaste = !isCopy && matchesShortcut(e, "pasteElements", overrides);
      if (!isCopy && !isPaste) return;
      if (isEditableTarget(e)) return;
      if (isCopy) {
        const clip = collectElementClipboard(project, sel);
        if (!clip) return; // nichts gewählt → natives Browser-Copy zulassen
        e.preventDefault();
        setElementClipboard(clip);
        // Bestes Bemühen, OS-weit verfügbar zu machen — Fehler (Rechte
        // verweigert, API fehlt in diesem Webview) verschluckt, der In-App-
        // State oben ist bereits gesetzt und bleibt der verlässliche Pfad.
        navigator.clipboard?.writeText(serializeClipboardText(clip)).catch(() => {});
        return;
      }
      // Einfügen: erst OS-Zwischenablage versuchen (ermöglicht Fenster-
      // übergreifend), sonst die In-App-Zwischenablage. `preventDefault`
      // sofort (synchron) — wir sind hier NIE in einem Textfeld
      // (isEditableTarget oben hat das schon ausgeschlossen), also gibt es
      // kein natives Paste-Ziel, das verloren gehen könnte.
      e.preventDefault();
      const paste = (clip: ElementClipboard | null) => {
        if (!clip || isClipboardEmpty(clip)) return;
        const { ops, pastedIds } = pasteElementClipboard(clip, activeLevelId);
        applyChange(ops);
        setSelected.wallIds(pastedIds.wallIds);
        setSelected.drawingIds(pastedIds.drawingIds);
        setSelected.ceilingIds(pastedIds.ceilingIds);
        setSelected.roofIds(pastedIds.roofIds);
        setSelected.openingIds(pastedIds.openingIds);
        setSelected.stairIds(pastedIds.stairIds);
        setSelected.roomIds(pastedIds.roomIds);
        setSelected.extrudedSolidIds(pastedIds.extrudedSolidIds);
        setSelected.columnIds(pastedIds.columnIds);
      };
      if (navigator.clipboard?.readText) {
        navigator.clipboard
          .readText()
          .then((text) => paste(parseClipboardText(text) ?? elementClipboard))
          .catch(() => paste(elementClipboard));
      } else {
        paste(elementClipboard);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel, elementClipboard, activeLevelId, project, overrides]);
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
  overrides: ShortcutOverrides,
): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isEditableTarget(e)) return;
      if (selectedDrawingIds.length < 2) return;
      if (matchesShortcut(e, "booleanUnion", overrides)) {
        e.preventDefault();
        applyBoolean(unionDrawings);
      } else if (matchesShortcut(e, "booleanDifference", overrides)) {
        e.preventDefault();
        applyBoolean(differenceDrawings);
      } else if (matchesShortcut(e, "booleanIntersection", overrides)) {
        e.preventDefault();
        applyBoolean(intersectionDrawings);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDrawingIds, drawings2d, overrides]);
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
  selectedDrawingIds: string[],
  selectedExtrudedSolidId: string | null,
  selectedColumnId: string | null,
  selectedCeilingIds: string[],
  selectedRoofIds: string[],
  selectedStairIds: string[],
  selectedRoomIds: string[],
  engine: CommandEngine,
  setDraft: (draft: ToolDraft | null) => void,
  requestCopyCount: (mode: "array" | "distribute") => void,
  onRunCommand: (name: string) => void,
  commandLineRef: RefObject<CommandLineHandle | null>,
  overrides: ShortcutOverrides,
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
      if (matchesShortcut(e, "measure", overrides)) {
        onRunCommand("measure");
        e.preventDefault();
        return;
      }
      // Transformierbar sind Wände, 2D-Zeichnungen, extrudierte Körper, Stützen,
      // Decken/Dächer/Treppen/Räume (dieselben Arten wie transformSel). Öffnungen
      // laufen bewusst NICHT hierüber, sondern über ihre eigenen Bewegpunkte
      // (Grips) — sie sind wandgebunden (Position = Abstand entlang der
      // Wandachse), kein freier 2D-Punkt.
      const hasSel =
        selectedWallIds.length > 0 ||
        !!selectedDrawingId ||
        selectedDrawingIds.length > 0 ||
        !!selectedExtrudedSolidId ||
        !!selectedColumnId ||
        selectedCeilingIds.length > 0 ||
        selectedRoofIds.length > 0 ||
        selectedStairIds.length > 0 ||
        selectedRoomIds.length > 0;
      if (!hasSel) return;
      // Bewegen/Spiegeln/Drehen laufen ALLE über die interaktive Transformation
      // (`activeTransform`) mit den U/I/O/P-Kopiermodi (Bewegen/Kopie/Reihe/
      // Verteilen). Prompt + Optionen + Live-Feld speisen die Command-Line; die
      // Kürzel U/I/O/P wirken dort auch bei fokussiertem Eingabefeld (options.key).
      const op: TransformOp | null = matchesShortcut(e, "transformMove", overrides)
        ? "move"
        : matchesShortcut(e, "transformMirror", overrides)
          ? "mirror"
          : matchesShortcut(e, "transformRotate", overrides)
            ? "rotate"
            : null;
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
    selectedDrawingIds,
    selectedExtrudedSolidId,
    selectedColumnId,
    selectedCeilingIds,
    selectedRoofIds,
    selectedStairIds,
    selectedRoomIds,
    engine,
    overrides,
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
  applyChange: (ops: readonly CoreOp[]) => void,
  currentSelection: GroupMembership,
  selectedGroupIds: string[],
  applySelection: (mem: GroupMembership, groupIds: string[]) => void,
  overrides: ShortcutOverrides,
): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const isUngroup = matchesShortcut(e, "ungroup", overrides);
      const isGroup = !isUngroup && matchesShortcut(e, "group", overrides);
      if (!isUngroup && !isGroup) return;
      if (isEditableTarget(e)) return;
      e.preventDefault();
      if (isUngroup) {
        // Ungruppieren: für jede gewählte Gruppe eine Hülle auflösen; ihre
        // direkten Mitglieder (+ Untergruppen) werden die neue Auswahl.
        if (selectedGroupIds.length === 0) return;
        const ops: CoreOp[] = [];
        let members: GroupMembership = { ...EMPTY_MEMBERSHIP };
        const newGroupIds: string[] = [];
        for (const gid of selectedGroupIds) {
          const res = ungroup(project, gid);
          if (!res) continue;
          ops.push(...res.ops);
          members = mergeMembership(members, res.members);
          newGroupIds.push(...res.subGroupIds);
        }
        applyChange(ops);
        applySelection(members, newGroupIds);
        return;
      }
      // Gruppieren: aktuelle Auswahl (+ bereits gewählte Gruppen als Untergruppen).
      const res = groupSelection(currentSelection, selectedGroupIds);
      if (!res) return;
      applyChange(res.ops);
      applySelection(currentSelection, [res.groupId]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, currentSelection, selectedGroupIds, overrides]);
}
