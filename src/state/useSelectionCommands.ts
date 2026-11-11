// Befehle auf der aktuellen Auswahl ([163], aus App.tsx herausgelöst): Löschen, Split, 2D-Booleans,
// Stil übertragen, Sperren, Ebenen ausblenden/isolieren, „Nicht drucken", Bemassung lösen, Gruppen
// betreten/verlassen, Segment schneiden — samt der zugehörigen Tastenkürzel (gleiche Reihenfolge wie
// zuvor in App). Aufgerufen von `App.tsx`; die Rückgaben speisen Kontextmenü (`AppContextMenu`),
// Menüleisten, Export-Dialoge und die Hauptansicht.
//
// [121] Ohne Projekt-Abo: Handler lesen das Projekt beim Aufruf aus dem Store (`getState()`); was das
// Kontextmenü im Render anzeigt (alles gesperrt? Ebenen der Auswahl …), rechnet `selectionMenuState`
// im Menü selbst (`AppContextMenu` abonniert das Projekt, solange es offen ist).

import { useMemo } from "react";
import type { Drawing2D, DrawingLevel, Project, Vec2 } from "../model/types";
import type { Selection } from "./selection";
import { addItems, cmdMutation, fieldOps, opsMutation, patchItems, removeItems } from "../core";
import type { ToolId } from "../tools/types";
import type { DrawingStyle } from "../editors/matchProps";
import { applyDrawingStyleOps, readDrawingStyle } from "../editors/matchProps";
import { cutSegmentOps, splitOps } from "../editors/splitJoin";
import type { BooleanResult } from "../editors/booleanOps";
import type { EngineView } from "../commands/engine";
import { clearKinds, fromIdLists, hasTransformable, isEmpty, toMembership } from "./selection";
import { containingGroupId, EMPTY_MEMBERSHIP } from "./groupActions";
import type { GroupMembership, MemberKind } from "./groupActions";
import { isLocked, lockMembersOps } from "./objectLock";
import { isolateCategories, selectionCategoryCodes, setCategoriesVisible } from "./selectionLayers";
import type { ShortcutOverrides } from "./keyboardShortcuts";
import {
  useBooleanOpsShortcut,
  useGroupShortcut,
  useSelectAllAndDeleteShortcut,
  useSplitJoinShortcut,
  useTransformShortcuts,
  useViewNavigationShortcuts,
} from "./useKeyboardShortcuts";
import { TRANSFORM_COMMANDS } from "./useToolInput";
import { getState, type RootState } from "./appStore";
import type { useSelectionState } from "./useSelectionState";
import type { useProjectActions } from "./useProjectActions";
import type { useCommandEngineHost } from "./useCommandEngineHost";

type Sel = ReturnType<typeof useSelectionState>;

/**
 * Anzeige-Werte des Kontextmenüs zur Auswahl (rein, aus Projekt + Auswahl): alles gesperrt, alles
 * „nicht drucken", Ebenen der Auswahl (nur mit `withLayers`, teuer bei grossen Importen), Bemassungen
 * mit Bezügen. Dieselbe Rechnung nutzen die Handler beim Aufruf.
 */
export function selectionMenuState(project: Project, selection: Selection, withLayers: boolean) {
  const members: Partial<Record<MemberKind, string[]>> = toMembership(selection);
  const lockIds = (Object.entries(members) as [MemberKind, string[]][]).flatMap(([kind, ids]) =>
    ids.map((id) => [kind, id] as const),
  );
  const selectionAllLocked = lockIds.length > 0 && lockIds.every(([kind, id]) => isLocked(project, kind, id));
  const selectionLayerCodes = withLayers ? selectionCategoryCodes(project, members) : [];
  const selectionAllNoPrint =
    selection.drawings.length > 0 &&
    selection.drawings.every((id) => project.drawings2d.find((d) => d.id === id)?.noPrint);
  const attachedDimensionIds = selection.drawings.filter((id) => {
    const g = project.drawings2d.find((d) => d.id === id)?.geom;
    return g?.shape === "dimension" && !!g.refs?.some(Boolean);
  });
  const movedDimTextIds = selection.drawings.filter((id) => {
    const g = project.drawings2d.find((d) => d.id === id)?.geom;
    return g?.shape === "dimension" && !!g.textOffsetsMm?.some((o) => o.along !== 0 || o.perp !== 0);
  });
  return { selectionAllLocked, selectionLayerCodes, selectionAllNoPrint, attachedDimensionIds, movedDimTextIds };
}

export function useSelectionCommands(opts: {
  setProject: RootState["setProject"];
  applyChange: RootState["applyChange"];
  groupChanges: RootState["groupChanges"];
  selection: Sel["selection"];
  setSelection: Sel["setSelection"];
  groupPath: Sel["groupPath"];
  setGroupPath: Sel["setGroupPath"];
  patchLevel: ReturnType<typeof useProjectActions>["patchLevel"];
  activeTool: ToolId;
  activeLevel: DrawingLevel;
  engine: ReturnType<typeof useCommandEngineHost>["engine"];
  engineView: EngineView;
  shortcutOverrides: ShortcutOverrides;
  drawingStyleClipboard: DrawingStyle | null;
  setDrawingStyleClipboard: (s: DrawingStyle | null) => void;
  onCommandOption: (id: string) => void;
  onRunCommand: (name: string) => void;
}) {
  const {
    setProject,
    applyChange,
    groupChanges,
    selection,
    setSelection,
    groupPath,
    setGroupPath,
    patchLevel,
    activeTool,
    activeLevel,
    engine,
    engineView,
    shortcutOverrides,
    drawingStyleClipboard,
    setDrawingStyleClipboard,
    onCommandOption,
    onRunCommand,
  } = opts;
  // Anzeige-Werte des Menüs, beim Aufruf eines Handlers frisch gerechnet.
  const menuState = (withLayers = false) => selectionMenuState(getState().project, selection, withLayers);

  // Ob irgendeine löschbare Auswahl ansteht — geteilt zwischen dem Entf-
  // Tastatur-Handler unten und dem Menüpunkt „Bearbeiten > Löschen" (AppMenuBar).
  const hasSelectionToDelete = () => !isEmpty(selection, { withGroups: false });

  // Löscht die AKTUELLE Auswahl (alle Kanäle) — geteilte Logik zwischen dem
  // Entf-Tastatur-Handler und dem Menüpunkt „Bearbeiten > Löschen".
  const deleteSelection = () => {
    // Ein Undo-Schritt für alles (Schnittlinien + Elemente), [K4] S3.
    groupChanges(() => deleteSelectionChanges());
    setSelection(clearKinds());
  };
  const deleteSelectionChanges = () => {
    // Schnittlinie(n): Entf löscht NUR ihre Linie (linePoints), die Ebene
    // bleibt — ADDITIV zu den übrigen Kanälen unten (nicht mehr exklusiv:
    // seit Cmd/Ctrl+A Schnittlinien zusammen mit Wänden/etc. mitselektiert,
    // würde ein frühes `return` hier die übrigen Kanäle stumm überspringen).
    if (selection.sectionLines.length) {
      for (const id of selection.sectionLines) patchLevel(id, { linePoints: undefined });
    }
    // Objekt-Sperre: gesperrte Elemente aus der Löschung ausnehmen (s.
    // `moveGrip`/`moveElementBy` im Kern, `grips.rs`, für dieselbe Prüfung
    // beim Ziehen). ExtrudedSolid/Kontext-Objekte haben kein `locked`-Feld
    // (s. deren Typdefinitionen) — bleiben ungefiltert.
    const project = getState().project;
    const notLocked = (kind: MemberKind, ids: string[]) =>
      ids.filter((id) => !isLocked(project, kind, id));
    const dids = new Set(notLocked("drawingIds", selection.drawings));
    const wids = new Set(notLocked("wallIds", selection.walls));
    const cids = new Set(notLocked("ceilingIds", selection.ceilings));
    const oids = new Set(notLocked("openingIds", selection.openings));
    const stids = new Set(notLocked("stairIds", selection.stairs));
    const rmids = new Set(notLocked("roomIds", selection.rooms));
    const exids = new Set(selection.solids);
    const colids = new Set(notLocked("columnIds", selection.columns));
    const rfids = new Set(notLocked("roofIds", selection.roofs));
    const ctxids = new Set(selection.contextObjects);
    // [149] Bäume (gesperrte bleiben).
    const treeids = new Set(selection.trees.filter((id) => !(project.trees ?? []).find((t) => t.id === id)?.locked));
    // [193] Abgeleitete Lage-Darstellung (Schatten, Baurecht) ist kein Element: Entf blendet sie aus
    // (`show: false`; über die Lage-Panels wieder einschaltbar).
    const siteHide: ReturnType<typeof fieldOps> = [];
    if (selection.site.includes("sunStudy") && project.sunStudy?.show) siteHide.push(...fieldOps(project, "sunStudy", { ...project.sunStudy, show: false }));
    if (selection.site.includes("siteRules") && project.siteRules && project.siteRules.show !== false) siteHide.push(...fieldOps(project, "siteRules", { ...project.siteRules, show: false }));
    setProject(
      opsMutation((p) => [
        ...siteHide,
        ...removeItems(p, "drawings2d", dids),
        ...removeItems(p, "walls", wids),
        ...removeItems(p, "ceilings", cids),
        ...removeItems(p, "roofs", rfids),
        ...removeItems(p, "stairs", stids),
        ...removeItems(p, "rooms", rmids),
        ...removeItems(p, "extrudedSolids", exids),
        ...removeItems(p, "columns", colids),
        // Öffnungen: eigene Auswahl löschen UND alle, deren Wirt (Wand, Dach, Decke [103]) entfällt.
        ...removeItems(p, "openings", (o) => oids.has(o.id) || wids.has(o.hostWallId) || (!!o.hostRoofId && rfids.has(o.hostRoofId)) || (!!o.hostCeilingId && cids.has(o.hostCeilingId))),
        ...removeItems(p, "context", ctxids),
        ...removeItems(p, "trees", treeids),
      ]),
    );
  };

  // Tastatur im Auswahl-Werkzeug: Ctrl/Cmd+A = alles wählen, Entf/Backspace =
  // Auswahl löschen — siehe state/useKeyboardShortcuts.ts.
  useSelectAllAndDeleteShortcut({
    activeTool,
    transformActive: TRANSFORM_COMMANDS.has(engineView.commandName ?? ""),
    activeLevelId: activeLevel.id,
    shortcutOverrides,
    selection,
    setSelection,
    hasSelectionToDelete,
    deleteSelection,
  });

  // Split der gewählten 2D-Elemente an einem Punkt in mehrere Stücke (shared von
  // Ctrl+S und einem etwaigen Menü-Eintrag). Ersetzt jedes Quell-Drawing durch ≥1
  // Ergebnis; neue Elemente werden ausgewählt. Wände sind ausgenommen (no-op).
  const runSplit = (ids: string[]) => {
    if (ids.length === 0) return;
    let newIds: string[] = [];
    applyChange((p) => {
      const r = splitOps(p, ids);
      newIds = r.selectIds;
      return r.ops;
    });
    setSelection({ drawings: newIds, walls: [] });
  };

  // Ctrl/Cmd+S = Split, Ctrl/Cmd+J = Join der selektierten Drawing2D-Elemente —
  // siehe state/useKeyboardShortcuts.ts.
  useSplitJoinShortcut(selection.drawings, engine, runSplit, setSelection, shortcutOverrides);

  // Ctrl/Cmd+Shift+U/D/I = Boolean Vereinigung/Subtraktion/Schnitt — siehe
  // state/useKeyboardShortcuts.ts. (Ctrl/Cmd+C/V-Kopieren/Einfügen folgt weiter
  // unten, nach `importDrawings`.)

  // 2D-Boolean-Operation (Union / Subtract / Intersect) auf die gewählten
  // geschlossenen Drawing2D anwenden. Reihenfolge der Auswahl = Reihenfolge in
  // `selection.drawings` (für Differenz: erstes Element = Basis). Ersetzt die
  // beteiligten Quellen durch das Ergebnis und selektiert die neuen Elemente.
  // Braucht ≥2 geschlossene Flächen; sonst No-op.
  const applyBoolean = (
    op: (srcs: Drawing2D[]) => BooleanResult,
  ) => {
    const order = selection.drawings;
    if (order.length < 2) return;
    const byId = new Map(getState().project.drawings2d.map((d) => [d.id, d]));
    // In Auswahl-Reihenfolge (Basis zuerst) auflösen.
    const srcs = order
      .map((id) => byId.get(id))
      .filter((d): d is Drawing2D => d !== undefined);
    const result = op(srcs);
    if (result.replacedIds.length === 0) return; // <2 geschlossene → No-op
    const replaced = new Set(result.replacedIds);
    applyChange((p) => [...removeItems(p, "drawings2d", replaced), ...addItems("drawings2d", result.created)]);
    setSelection({ drawings: result.created.map((d) => d.id), walls: [] });
  };
  useBooleanOpsShortcut(selection.drawings, applyBoolean, shortcutOverrides);

  // „Eigenschaften übertragen" (2D-Kontextmenü) — dasselbe Zwischenablage-
  // Muster wie beim Ebenen-Menü (`layerClipboard`), nur für den vollen
  // Aussehen-Stil eines 2D-Elements (s. `editors/matchProps.ts`).
  const copyDrawingStyle = () => {
    const d = getState().project.drawings2d.find((x) => x.id === selection.drawings[0]);
    if (d) setDrawingStyleClipboard(readDrawingStyle(d));
  };
  const pasteDrawingStyle = () => {
    if (!drawingStyleClipboard || selection.drawings.length === 0) return;
    applyChange((p) => applyDrawingStyleOps(p, selection.drawings, drawingStyleClipboard));
  };

  // Objekt sperren/entsperren (Kontextmenü) — wirkt auf die GANZE aktuelle
  // Auswahl (alle Elementarten, nicht nur 2D-Zeichnungen), ein Undo-Schritt.
  // Anders als der Ebenen-/Geschoss-Sperrmodus (`DisplayMode`, session-lokal)
  // ist `locked` hier ein persistiertes Feld am Element selbst, s.
  // `state/objectLock.ts`.
  const groupMembers = useMemo(() => toMembership(selection), [selection]);
  const selectionLockMembers: Partial<Record<MemberKind, string[]>> = groupMembers;
  const selectionLockIds = (
    Object.entries(selectionLockMembers) as [MemberKind, string[]][]
  ).flatMap(([kind, ids]) => ids.map((id) => [kind, id] as const));
  const toggleSelectionLock = () => {
    if (selectionLockIds.length === 0) return;
    const { selectionAllLocked } = menuState();
    applyChange((p) => lockMembersOps(p, selectionLockMembers, !selectionAllLocked));
  };

  // Ebene(n) der Auswahl ausblenden / isolieren (Kontextmenü). Die Codes rechnet das offene Menü
  // (`selectionMenuState`) bzw. der Handler beim Aufruf — bei Kataster-Importen (~10^5 Zeichnungen)
  // nicht bei jedem Render.
  const hideSelectionLayers = () => {
    const { selectionLayerCodes } = menuState(true);
    if (selectionLayerCodes.length === 0) return;
    const codes = new Set(selectionLayerCodes);
    applyChange((p) => fieldOps(p, "layers", setCategoriesVisible(p.layers, codes, false)));
  };
  const isolateSelectionLayers = () => {
    const { selectionLayerCodes } = menuState(true);
    if (selectionLayerCodes.length === 0) return;
    const codes = new Set(selectionLayerCodes);
    applyChange((p) => fieldOps(p, "layers", isolateCategories(p.layers, codes)));
  };

  // „Nicht drucken"/„Drucken" (Kontextmenü) — nur `Drawing2D` kennt
  // `noPrint` (Nutzer-Wunsch „Kein 'nicht druckend'-Flag im Modell"), daher
  // simpler als die Sperre oben: direkt über `selection.drawings`.
  const toggleSelectionNoPrint = () => {
    if (selection.drawings.length === 0) return;
    const next = !menuState().selectionAllNoPrint;
    applyChange((p) => patchItems(p, "drawings2d", selection.drawings, (d) => ({ ...d, noPrint: next })));
  };

  // „Bemassung lösen" ([38]): gewählte Bemassungen mit Bezügen auf Modell-Elemente.
  const detachDimensions = () => {
    const { attachedDimensionIds } = menuState();
    if (attachedDimensionIds.length) applyChange((p) => cmdMutation({ cmd: "dimdetach", ids: attachedDimensionIds }).toOps(p));
  };

  // „Text zurücksetzen" ([172]): Masszahlen der gewählten Bemassungen zurück auf die Vorgabe (mittig).
  const resetDimensionTexts = () => {
    const { movedDimTextIds } = menuState();
    if (!movedDimTextIds.length) return;
    applyChange((p) =>
      patchItems(p, "drawings2d", movedDimTextIds, (d) => {
        if (d.geom.shape !== "dimension") return d;
        const { textOffsetsMm: _drop, ...geom } = d.geom;
        return { ...d, geom };
      }),
    );
  };

  // Ctrl/Cmd+G / Ctrl/Cmd+Shift+G = Gruppieren/Auflösen (Vectorworks-artig,
  // s. state/groupActions.ts). `applyGroupSelection` setzt nach dem Gruppieren/
  // Auflösen alle betroffenen Auswahl-Kanäle auf einen Schlag.
  const applyGroupSelection = (mem: GroupMembership, groupIds: string[]) =>
    setSelection({ ...fromIdLists(mem), groups: groupIds });
  useGroupShortcut(
    applyChange,
    groupMembers,
    selection.groups,
    applyGroupSelection,
    shortcutOverrides,
  );
  // [185] Cmd/Ctrl+3/4/5/6: Auswahl in 3D zeigen/ausblenden, Geschoss tiefer/höher.
  useViewNavigationShortcuts(shortcutOverrides);

  // Doppelklick auf ein gruppiertes Element → Gruppe betreten (Isolation):
  // alles ausserhalb wird gedimmt/gesperrt gerendert (s. viewportContent.tsx/
  // PlanView „greyed"-Pass) und lässt sich nicht mehr anwählen (s.
  // useMouseSelectionHandlers.ts). Auswahl wird geleert, damit man sauber
  // "in" der Gruppe startet.
  const onEnterGroup = (hit: {
    wallId?: string;
    drawingId?: string;
    ceilingId?: string;
    roomId?: string;
    stairId?: string;
    columnId?: string;
    roofId?: string;
  }): boolean => {
    const kind = hit.wallId
      ? "wallIds"
      : hit.drawingId
        ? "drawingIds"
        : hit.ceilingId
          ? "ceilingIds"
          : hit.roomId
            ? "roomIds"
            : hit.stairId
              ? "stairIds"
              : hit.columnId
                ? "columnIds"
                : hit.roofId
                  ? "roofIds"
                  : null;
    const id = hit.wallId ?? hit.drawingId ?? hit.ceilingId ?? hit.roomId ?? hit.stairId ?? hit.columnId ?? hit.roofId;
    if (!kind || !id) return false;
    const gid = containingGroupId(getState().project, kind, id, groupPath);
    if (!gid) return false;
    setGroupPath([...groupPath, gid]);
    applyGroupSelection({ ...EMPTY_MEMBERSHIP }, []);
    return true;
  };
  // "Gruppe verlassen"-Knopf (oben links im Grundriss): verlässt genau EIN
  // Isolations-Level (Vectorworks-Verhalten bei verschachtelten Gruppen).
  const onLeaveGroup = () => {
    setGroupPath(groupPath.slice(0, -1));
    applyGroupSelection({ ...EMPTY_MEMBERSHIP }, []);
  };

  // Alt+Klick im Grundriss = Segment löschen (Schere): PlanView meldet das
  // getroffene Drawing2D + den Modellpunkt; App ermittelt daraus die nächst-
  // gelegene Kante (Kern `cmd_split.rs`) und entfernt sie. Geschlossene Form →
  // offene Polylinie; bleiben <2 Punkte übrig, wird das Element gelöscht.
  const onSegmentCut = (drawingId: string, model: Vec2) => {
    let removed = false;
    applyChange((p) => {
      const r = cutSegmentOps(p, drawingId, model);
      removed = r.removed;
      return r.ops;
    });
    if (removed) setSelection({ drawings: [] });
  };

  // Transformations-Shortcuts (m/s/d, U/I/O/P-Modusleiste, „q" Messen) — siehe
  // state/useKeyboardShortcuts.ts.
  useTransformShortcuts(
    activeTool,
    hasTransformable(selection),
    engine,
    (id) => onCommandOption(id),
    onRunCommand,
    shortcutOverrides,
  );

  return {
    hasSelectionToDelete,
    deleteSelection,
    applyBoolean,
    copyDrawingStyle,
    pasteDrawingStyle,
    selectionLockMembers,
    selectionLockIds,
    toggleSelectionLock,
    hideSelectionLayers,
    isolateSelectionLayers,
    toggleSelectionNoPrint,
    detachDimensions,
    resetDimensionTexts,
    onEnterGroup,
    onLeaveGroup,
    onSegmentCut,
  };
}
