// Befehls-Engine der App ([121] aus App.tsx herausgelöst): EINE stabile `CommandEngine`-Instanz
// mit Host (Kontext, Fang, Commit, Text-Fokus), die Nutzer-Übersteuerungen der Befehls-Kürzel und
// Tastatur-Shortcuts (localStorage, Abgleich mit dem nativen Einstellungs-Fenster), das Neurendern
// bei Engine-Änderungen und das Freigeben des Befehlsfelds nach Befehlsende.
//
// Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

import { useEffect, useRef, useState, type RefObject } from "react";
import type { DrawingLevel, Project } from "../model/types";
import type { SnapSettings, ToolDraft } from "../tools/types";
import type { TransformSelection } from "../tools/transform";
import { computeSnap } from "../tools/snapping";
import { unitsForLevel } from "../tools/displayUnits";
import { cmdMutation, type ProjectMutation } from "../core";
import { CommandEngine } from "../commands/engine";
import type { EngineHost } from "../commands/engine";
import type { CommandContext } from "../commands/types";
import type { CommandLineHandle } from "../ui/CommandLine";
import type { PlanViewHandle } from "../views/plan/PlanView";
import { loadAliasOverrides, saveAliasOverrides } from "./commandAliasOverrides";
import { loadShortcutOverrides, saveShortcutOverrides, type ShortcutOverrides } from "./keyboardShortcuts";
import { useCommandKeys } from "./commandKeys";
import { t } from "../i18n";
import { getState } from "./appStore";
import { clearKinds, toCommandSelection } from "./selection";
import type { useSelectionState } from "./useSelectionState";
import type { useContextMenuState } from "../menus/useContextMenuState";

/**
 * Auswahl für Transformationen/Befehle: im Schnitt/in der Ansicht nur die
 * 2D-Elemente der Ebene. Bauteile (Wand/Decke/…) sind dort zwar anwählbar
 * (Objekt-Info, Löschen), leben aber im Grundriss-Raum — ein im Schnitt-Blatt
 * gemessenes Delta/Drehzentrum würde sie an eine falsche Stelle setzen.
 */
function sheetOnlySelection(level: DrawingLevel, sel: TransformSelection): TransformSelection {
  if (level.kind !== "section" && level.kind !== "elevation") return sel;
  return {
    wallIds: [],
    drawingId: sel.drawingId,
    drawingIds: sel.drawingIds,
    extrudedSolidId: null,
    columnId: null,
    ceilingIds: [],
    roofIds: [],
    stairIds: [],
    roomIds: [],
    openingIds: [],
  };
}

type Sel = ReturnType<typeof useSelectionState>;
type Menu = ReturnType<typeof useContextMenuState>;

export function useCommandEngineHost(opts: {
  project: Project;
  activeLevel: DrawingLevel;
  activeCategoryCode: string;
  activeLineStyleId: string;
  activeWallTypeId: string;
  visibleCodes: Set<string>;
  snap: SnapSettings;
  sel: Pick<Sel, "selection" | "groupPath" | "setSelection">;
  setProject: (m: ProjectMutation) => void;
  setDraft: (d: ToolDraft | null) => void;
  notify: (msg: string, kind: "info" | "warning" | "error") => void;
  planViewRef: RefObject<PlanViewHandle>;
  setEditTextId: Menu["setEditTextId"];
  setEditTextMinHeightM: Menu["setEditTextMinHeightM"];
}) {
  const {
    project,
    activeLevel,
    activeCategoryCode,
    activeLineStyleId,
    activeWallTypeId,
    visibleCodes,
    snap,
    setProject,
    setDraft,
    notify,
    planViewRef,
    setEditTextId,
    setEditTextMinHeightM,
  } = opts;
  const { selection, groupPath, setSelection } = opts.sel;
  // ── Command-Engine (Rhino-artiges Befehlssystem) ──────────────────────────
  // Eine stabile Engine-Instanz; alle Live-Werte (Kontext/Snap/visibleCodes)
  // liest der Host über einen jeweils aktualisierten `latest`-Ref, damit die
  // Instanz nicht je Render neu gebaut werden muss. Die Engine speist Picks +
  // getippte Eingabe in DENSELBEN Schritt (ein Eingabepfad). Koexistenz: läuft
  // ein Befehl, übernimmt er die linke Maustaste der Plan-Ansicht über denselben
  // toolHandlers-Pfad wie die Alt-Tools (siehe unten).
  const cmdLatest = useRef({
    project,
    activeLevel,
    activeCategoryCode,
    activeLineStyleId,
    activeWallTypeId,
    visibleCodes,
    snap,
    selection,
    groupPath,
    setProject,
    setDraft,
  });
  cmdLatest.current = {
    project,
    activeLevel,
    activeCategoryCode,
    activeLineStyleId,
    activeWallTypeId,
    visibleCodes,
    snap,
    selection,
    groupPath,
    setProject,
    setDraft,
  };
  const commandLineRef = useRef<CommandLineHandle>(null);
  const engineRef = useRef<CommandEngine | null>(null);
  if (engineRef.current === null) {
    const host: EngineHost = {
      context: (lastPoint): CommandContext => {
        const c = cmdLatest.current;
        return {
          project: c.project,
          level: c.activeLevel,
          defaultCategoryCode: c.activeCategoryCode,
          scaleDenominator: getState().scaleDenominator,
          activeLineStyleId: c.activeLineStyleId,
          activeWallTypeId: c.activeWallTypeId,
          lastPoint,
          // Vorab gesetzte Auswahl aus dem Store (Rhino: erst selektieren, dann
          // Befehl). Move/Copy/Offset operieren darauf.
          // Im Schnitt/in der Ansicht nur die 2D-Elemente der Ebene: Bauteile
          // leben im Grundriss-Raum, ein Schnitt-Delta wäre dort falsch.
          selection: sheetOnlySelection(c.activeLevel, toCommandSelection(c.selection)),
        };
      },
      snap: (raw, draftPoints, mods) => {
        const c = cmdLatest.current;
        return computeSnap({
          raw,
          project: c.project,
          levelId: c.activeLevel.id,
          visibleCodes: c.visibleCodes,
          settings: c.snap,
          draftPoints,
          lastPoint: draftPoints.length ? draftPoints[draftPoints.length - 1] : null,
          scale: getState().scaleDenominator,
          pxPerMeter: planViewRef.current?.pxPerMeter() ?? 90,
          // Shift = Ortho, Ctrl = Snap aus — auch für den ERSTEN Punkt (ohne
          // Draft): so fängt der Startpunkt einer neuen Linie/Polylinie/Wand an
          // vorhandene Endpunkte/Mitten, statt erst ab dem zweiten Punkt.
          shift: mods?.shift ?? false,
          ctrl: mods?.ctrl ?? false,
        });
      },
      pxPerMeter: () => planViewRef.current?.pxPerMeter() ?? 90,
      setDraft: (d) => cmdLatest.current.setDraft(d),
      // Zeichnet man WÄHREND man eine Gruppe betreten hat (Isolation), wird
      // das neue Element automatisch Mitglied dieser Gruppe (Nutzer-Wunsch:
      // „wenn man etwas neu zeichnet ... zeichnet man in der Gruppe"). [K4] S3:
      // Befehle tragen ihre Kern-Anfrage mit (`cmdMutation`); die Gruppen-Zuordnung
      // rechnet der Kern im selben Commit (`group`, `cmd_create::group_ops`).
      commit: (mutate) => {
        const groupPath = cmdLatest.current.groupPath;
        const group = groupPath[groupPath.length - 1];
        // Befehle ohne Kern-Anfrage (Georeferenz, Ausrichten) legen keine Elemente an.
        cmdLatest.current.setProject(group && mutate.coreReq ? cmdMutation({ ...mutate.coreReq, group }) : mutate);
      },
      isFloor: () => cmdLatest.current.activeLevel.kind === "floor",
      // Befehl braucht eine Auswahl (Bewegen/Drehen/Spiegeln), es ist keine da.
      notify: (key, params, kind) => notify(t(key as Parameters<typeof t>[0], params), kind ?? "info"),
      // Getippte Werte auf einem Layout-Blatt in Papier-mm, y nach unten ([93]).
      inputUnits: () => unitsForLevel(cmdLatest.current.activeLevel),
      // Frisch über `text`/`textbox` erzeugtes Element sofort inline editieren
      // (kein Lookup nötig — der Commit hat es bereits angehängt, s. engine.ts
      // applyResult-Reihenfolge commit→focusDrawing). Auswahl-Löschen wie
      // onEditDrawingText (useMouseSelectionHandlers.ts), damit kein anderes
      // Element gleichzeitig markiert bleibt.
      focusDrawing: (id, minHeightM) => {
        setSelection({ ...clearKinds(), drawings: [id] });
        setEditTextMinHeightM(minHeightM ?? null);
        setEditTextId(id);
      },
    };
    engineRef.current = new CommandEngine(host);
  }
  const engine = engineRef.current;
  // [99] Esc/Enter eines laufenden Befehls unabhängig vom Fokus (ein Verteiler, s. commandKeys.ts).
  useCommandKeys(engineRef);

  // Nutzer-Kürzel-Übersteuerungen (Einstellungen → Remap) — aus localStorage
  // geladen, bei jeder Änderung sofort an die Engine gereicht (s. `commands/
  // engine.ts::setAliasOverrides`, `state/commandAliasOverrides.ts`).
  const [aliasOverrides, setAliasOverridesState] = useState<Record<string, string>>(() =>
    loadAliasOverrides(),
  );
  useEffect(() => engine.setAliasOverrides(aliasOverrides), [engine, aliasOverrides]);
  const setAliasOverrides = (next: Record<string, string>) => {
    setAliasOverridesState(next);
    saveAliasOverrides(next);
  };
  // Ändert das native Einstellungs-Fenster (separates Tauri-Fenster) die
  // Kürzel, landen sie zwar in localStorage, aber das `storage`-Event feuert
  // NIE im Fenster, das selbst geschrieben hat — nur in den ANDEREN Fenstern
  // (Web-Storage-API-Standardverhalten). Genau der Fall hier: dieses
  // (Haupt-)Fenster empfängt die Änderung darüber und zieht sie nach.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === "cad.commandAliasOverrides") setAliasOverridesState(loadAliasOverrides());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  // Nutzer-Übersteuerungen der echten Tastatur-Shortcuts (Einstellungen →
  // Tastenkürzel) — analoges Muster zu `aliasOverrides` oben, aber für
  // `state/keyboardShortcuts.ts` (Ctrl/Cmd+Z usw.) statt der Befehlszeilen-
  // Kürzel. Direkt an alle betroffenen Hooks unten durchgereicht.
  const [shortcutOverrides, setShortcutOverridesState] = useState<ShortcutOverrides>(() =>
    loadShortcutOverrides(),
  );
  const setShortcutOverrides = (next: ShortcutOverrides) => {
    setShortcutOverridesState(next);
    saveShortcutOverrides(next);
  };
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === "dossier.keyboardShortcutOverrides") {
        setShortcutOverridesState(loadShortcutOverrides());
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  // Auf Engine-Zustandsänderungen re-rendern (Prompt/Optionen aktualisieren).
  const [engineTick, setEngineTick] = useState(0);
  useEffect(
    () => engine.subscribe(() => setEngineTick((n) => n + 1)),
    [engine],
  );
  // engineTick wird nur als Re-Render-Trigger gelesen (kein direkter Konsum).
  void engineTick;
  const engineView = engine.view();
  const commandActive = engineView.active;
  // Fokus wieder freigeben, sobald ein Befehl fertig ist (Commit ODER Abbruch):
  // beim Start wird das Befehlsfeld fokussiert (onSelectTool), bliebe es das
  // auch danach, würde die nächste Zifferntaste im (inaktiven) Feld landen
  // statt beim globalen Werkzeug-Kürzel anzukommen — Esc wäre nötig. Mit dem
  // Blur bei aktiv→inaktiv wählt man wie in Vectorworks sofort das nächste
  // Werkzeug per Zifferntaste, ohne dazwischen Esc zu drücken.
  const prevCommandActiveRef = useRef(commandActive);
  useEffect(() => {
    if (prevCommandActiveRef.current && !commandActive) {
      commandLineRef.current?.blur();
    }
    prevCommandActiveRef.current = commandActive;
  }, [commandActive]);
  // Live-Echo des Befehlszeilen-Texts fürs Cursor-HUD: der getippte Wert
  // erscheint sofort im aktiven Tab-Feld am Cursor (VW-Verhalten).
  const [cmdTyped, setCmdTyped] = useState("");

  return {
    engineRef,
    engine,
    engineView,
    commandActive,
    commandLineRef,
    aliasOverrides,
    setAliasOverrides,
    shortcutOverrides,
    setShortcutOverrides,
    cmdTyped,
    setCmdTyped,
  };
}
