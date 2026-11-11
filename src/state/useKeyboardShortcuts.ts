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
import type { RefObject } from "react";
import type { ToolId } from "../tools/types";
import type { CommandEngine } from "../commands/engine";
import type { CommandLineHandle } from "../ui/CommandLine";
import type { Drawing2D, Project, Vec2 } from "../model/types";
import type { CoreOp } from "../core";
import { differenceDrawings, intersectionDrawings, unionDrawings } from "../editors/booleanOps";
import type { BooleanResult } from "../editors/booleanOps";
import { groupSelection, mergeMembership, ungroup, EMPTY_MEMBERSHIP } from "./groupActions";
import type { GroupMembership } from "./groupActions";
import { clearKinds, fromIdLists, isEmpty } from "./selection";
import { getState } from "./appStore";
import type { Selection } from "./selection";
import {
  collectElementClipboard,
  isClipboardEmpty,
  pasteElementClipboard,
} from "../editors/elementClipboard";
import type { ElementClipboard, ElementSelectionIds, PastedIds } from "../editors/elementClipboard";
import { parseClipboardText, serializeClipboardText } from "../editors/elementClipboardSerialize";
import { matchesShortcut, type ShortcutId, type ShortcutOverrides } from "./keyboardShortcuts";
import { hideSelectionIn3d, showSelectionIn3d, stepActiveFloor } from "./tabNavigation";

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
 * Tastatur für ein gewähltes, aber ruhendes Zeichenwerkzeug (sein Befehl ist nach dem Commit
 * beendet): Esc schaltet zurück auf Auswahl, Enter wird geschluckt. Läuft der Befehl, gehören
 * Esc/Enter der Engine (`commandKeys.ts`). In echten Eingaben inaktiv.
 */
export function useActiveToolKeys(
  activeTool: ToolId,
  engineRef: RefObject<CommandEngine | null>,
  setActiveTool: (id: ToolId) => void,
): void {
  useEffect(() => {
    if (activeTool === "select") return;
    const onKey = (e: KeyboardEvent) => {
      if (isEditableTarget(e)) return;
      if (engineRef.current?.isActive()) return;
      if (e.key === "Escape") {
        setActiveTool("select");
        e.preventDefault();
      } else if (e.key === "Enter") {
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeTool]);
}

/**
 * Tastatur im Auswahl-Werkzeug: Ctrl/Cmd+A = alles auf der aktiven Ebene
 * wählen; Entf/Backspace = ALLE Selektierten (Wände + 2D-Elemente) löschen.
 * `hasSelectionToDelete`/`deleteSelection` bleiben in App.tsx (auch vom Menü
 * „Bearbeiten > Löschen" gebraucht) und werden hier nur aufgerufen.
 */
export function useSelectAllAndDeleteShortcut(opts: {
  activeTool: ToolId;
  /** Läuft Bewegen/Drehen/Spiegeln? Dann löscht Entf nicht. */
  transformActive: boolean;
  activeLevelId: string;
  shortcutOverrides: ShortcutOverrides;
  selection: Selection;
  setSelection: (patch: Partial<Selection>) => void;
  hasSelectionToDelete: () => boolean;
  deleteSelection: () => void;
}): void {
  const {
    activeTool,
    transformActive,
    activeLevelId,
    shortcutOverrides,
    setSelection,
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
          if (isEmpty(opts.selection, { withGroups: false })) return;
          setSelection(clearKinds());
        });
        return;
      }
      // Alles auswählen (alle Bauteilarten des aktiven Geschosses/der Ebene +
      // die Schnittlinien-Symbole, die auf JEDEM Grundriss erscheinen).
      if (matchesShortcut(e, "selectAll", shortcutOverrides)) {
        // Projekt beim Tastendruck aus dem Store ([121]: App abonniert es nicht mehr).
        const project = getState().project;
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
        // Dachfenster/Deckenöffnungen ([103]): über das Dach bzw. die Decke des Geschosses.
        const roofIdSet = new Set((project.roofs ?? []).filter((r) => r.floorId === activeLevelId).map((r) => r.id));
        const ceilingIdSet = new Set(ceilingIds);
        const openingIds = (project.openings ?? [])
          .filter((o) => wallIdSet.has(o.hostWallId) || (!!o.hostRoofId && roofIdSet.has(o.hostRoofId)) || (!!o.hostCeilingId && ceilingIdSet.has(o.hostCeilingId)))
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
          setSelection({
            walls: wallIds,
            drawings: drawingIds,
            ceilings: ceilingIds,
            openings: openingIds,
            stairs: stairIds,
            rooms: roomIds,
            solids: extrudedSolidIds,
            columns: columnIds,
            roofs: roofIds,
            sectionLines: sectionLineIds,
          });
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
      if (transformActive) return; // während einer Transformation nicht löschen
      if (hasSelectionToDelete()) {
        deleteSelection();
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    opts.activeTool,
    opts.transformActive,
    opts.shortcutOverrides,
    opts.selection,
    opts.activeLevelId,
  ]);
}

/**
 * Ctrl/Cmd+Shift+J = Split (Ctrl/Cmd+S ist Speichern), Ctrl/Cmd+J = Join der selektierten Drawing2D-Elemente.
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
  setSelection: (patch: Partial<Selection>) => void,
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
      setSelection({ drawings: [], walls: [] });
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
  applyChange: (ops: readonly CoreOp[] | ((p: Project) => readonly CoreOp[])) => void,
  setSelection: (patch: Partial<Selection>) => void,
  overrides: ShortcutOverrides,
): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const isCopy = matchesShortcut(e, "copyElements", overrides);
      const isPaste = !isCopy && matchesShortcut(e, "pasteElements", overrides);
      if (!isCopy && !isPaste) return;
      if (isEditableTarget(e)) return;
      if (isCopy) {
        const clip = collectElementClipboard(getState().project, sel);
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
        // Kern rechnet auf dem aktuellen Store-Projekt; die neuen ids für die Nachauswahl.
        const out: { ids?: PastedIds } = {};
        applyChange((p) => {
          const r = pasteElementClipboard(p, clip, activeLevelId);
          out.ids = r.pastedIds;
          return r.ops;
        });
        const pastedIds = out.ids;
        if (!pastedIds) return;
        setSelection(fromIdLists(pastedIds));
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
  }, [sel, elementClipboard, activeLevelId, overrides]);
}

/**
 * Ctrl/Cmd+Shift+U/D/I = Boolean Vereinigung/Subtraktion/Schnitt der gewählten
 * geschlossenen Drawing2D. preventDefault (sonst Browser-Aktionen). Braucht ≥2
 * geschlossene Flächen; sonst No-op. (Menü spiegelt diese Aktionen.) `applyBoolean`
 * bleibt in App.tsx (auch vom Kontextmenü gebraucht).
 */
export function useBooleanOpsShortcut(
  selectedDrawingIds: string[],
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
  }, [selectedDrawingIds, overrides]);
}

/**
 * Transformations-Shortcuts (nur im Auswahl-Werkzeug):
 *  m = Bewegen, s = Spiegeln, d = Drehen (startet den Befehl auf der Auswahl);
 *  läuft ein Befehl mit Options-Kürzeln (U/I/O/P der Transformations-Befehle), wählen diese
 *  Tasten die Option auch ohne Fokus im Befehlsfeld. O/P fragen die Kopienanzahl ab.
 *  „q" = Messen (Distanz/Winkel) — braucht KEINE Auswahl.
 */
export function useTransformShortcuts(
  activeTool: ToolId,
  hasTransformSelection: boolean,
  engine: CommandEngine,
  onCommandOption: (id: string) => void,
  onRunCommand: (name: string) => void,
  overrides: ShortcutOverrides,
): void {
  useEffect(() => {
    if (activeTool !== "select") return;
    const onKey = (e: KeyboardEvent) => {
      if (isEditableTarget(e)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (engine.isActive()) {
        const k = e.key.toLowerCase();
        const opt = e.key.length === 1 ? engine.view().options.find((o) => o.key?.toLowerCase() === k) : undefined;
        if (!opt) return;
        onCommandOption(opt.id);
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
      // Decken/Dächer/Treppen/Räume und ([144]) Öffnungen — die gleiten beim Verschieben entlang ihrer
      // Wand; Drehen/Spiegeln lehnt die Engine für sie allein mit Hinweis ab. Ohne Auswahl: still.
      if (!hasTransformSelection) return;
      const op = matchesShortcut(e, "transformMove", overrides)
        ? "move"
        : matchesShortcut(e, "transformMirror", overrides)
          ? "mirror"
          : matchesShortcut(e, "transformRotate", overrides)
            ? "rotate"
            : null;
      if (op) {
        onRunCommand(op);
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTool, hasTransformSelection, engine, overrides]);
}

/**
 * Ctrl/Cmd+G = Auswahl gruppieren (Vectorworks-artig); Ctrl/Cmd+Shift+G =
 * gewählte Gruppe(n) auflösen (EIN Level — Untergruppen bleiben bestehen).
 * `applySelection` setzt danach alle betroffenen `selected…Ids`-Kanäle +
 * `selectedGroupIds` auf einen Schlag (s. App.tsx, dieselbe Form wie die
 * Gruppen-Erweiterung beim Klicken in `useMouseSelectionHandlers.ts`).
 */
export function useGroupShortcut(
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
        const project = getState().project;
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
  }, [currentSelection, selectedGroupIds, overrides]);
}

/**
 * [185] Navigation wie Archicad: Cmd/Ctrl+5 Geschoss tiefer, Cmd/Ctrl+6 höher (Grundriss- und 3D-Reiter, Zoom
 * bleibt), Cmd/Ctrl+3 Auswahl in 3D zeigen (ohne Auswahl: alles), Cmd/Ctrl+4 Auswahl im 3D ausblenden. Unter Tauri
 * fängt das native Menü dieselben Kürzel ab (`native/appMenu.ts`).
 */
export function useViewNavigationShortcuts(overrides: ShortcutOverrides): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Die (oft fokussierte) Befehlszeile tippt keine Cmd/Ctrl-Ziffern: dort gelten die Kürzel.
      if (isEditableTarget(e) && !(e.target as HTMLElement).classList.contains("cmdline-input")) return;
      const fn = matchesShortcut(e, "floorDown", overrides)
        ? () => stepActiveFloor(-1)
        : matchesShortcut(e, "floorUp", overrides)
          ? () => stepActiveFloor(1)
          : matchesShortcut(e, "showSelection3d", overrides)
            ? showSelectionIn3d
            : matchesShortcut(e, "hideSelection3d", overrides)
              ? hideSelectionIn3d
              : null;
      if (!fn) return;
      e.preventDefault();
      fn();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [overrides]);
}

/**
 * [189] Taste T (rebindbar, `objectSettings`): Einstellungen des gewählten Objekts öffnen (`state/objectSettings.ts`).
 * Nicht in Textfeldern/Auswahllisten und nicht, wenn ein laufender Befehl diese Taste als Option-Kürzel belegt.
 * `run` liefert `true`, wenn es etwas zu öffnen gab (dann wird die Taste verbraucht).
 */
export function useObjectSettingsShortcut(
  overrides: ShortcutOverrides,
  engineRef: RefObject<CommandEngine | null>,
  run: () => boolean,
): void {
  const runRef = useRef(run);
  runRef.current = run;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || isEditableTarget(e) || (e.target as HTMLElement | null)?.tagName === "SELECT") return;
      if (!matchesShortcut(e, "objectSettings", overrides)) return;
      // Ein laufender Befehl behält seine Option-Kürzel (U/I/O/P …); sonst gilt T auch mitten im Zeichnen.
      const eng = engineRef.current;
      const k = e.key.toLowerCase();
      if (eng?.isActive() && eng.view().options.some((o) => o.key?.toLowerCase() === k)) return;
      if (runRef.current()) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [overrides, engineRef]);
}
