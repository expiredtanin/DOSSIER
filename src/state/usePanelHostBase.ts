// Host-Context für die Panels: baut den (dock-unabhängigen) Basis-Host aus Snap-/View-State, Auswahl
// und den Projekt-Mutationen zusammen — die Adapter-Schicht zwischen App-Zustand und dem
// PanelHostContext, den Docks und schwebende Panels konsumieren (`hostWithMode` hängt je Dock nur noch
// den Darstellungsmodus an). Aufgerufen von `App.tsx`.
//
// [121] Zerlegt in Teil-Bauer unter `panelHost/` (je Themenbereich eine Datei, s. dort): Werkzeuge und
// Ressourcen, Darstellung der Auswahl, Bauteil-Attribute, Lage/Elemente, Ausschnitte/Reiter, Layouts.
// Das Projekt und die Objekt-Info sind KEINE Host-Felder: Panels abonnieren sie selbst im Store
// (`useStore`, `useSelectionInfo`). Auch `App` abonniert das Projekt nicht mehr: die Teil-Bauer
// bekommen Projekt und Objekt-Info aus dem Store zum Zeitpunkt des Baus, und `useStableHost` ruft über
// seine Trampoline eine Fassung, die bei geändertem Projekt, geänderter Auswahl oder neuen Eingaben
// (neuer App-Render) erst beim Aufruf neu gebaut wird. Neu (als Objekt) wird der Host nur bei
// geänderten Wert-Feldern: eine Op am Modell rendert weder `App` noch die Panels über den Host.

import { useMemo, useRef } from "react";
import type { Project } from "../model/types";
import { getState } from "./appStore";
import { buildElementAttributesHost } from "./panelHost/elementAttributesHost";
import { buildLayoutsHost } from "./panelHost/layoutsHost";
import { buildSelectionStyleHost } from "./panelHost/selectionStyleHost";
import { buildSiteHost } from "./panelHost/siteHost";
import { useStableHost } from "./panelHost/stableHost";
import { buildToolsHost } from "./panelHost/toolsHost";
import { flatHostOpts, type BaseHost, type PanelHostInput } from "./panelHost/types";
import { buildViewSnapshotsHost } from "./panelHost/viewSnapshotsHost";
import { buildViewStateFns } from "./panelHost/viewState";
import { selectionInfoFor } from "./useSelectionInfo";
import type { SelectionInfo } from "./selectionInfo";

export type { PanelHostInput, PanelHostOpts } from "./panelHost/types";

/**
 * Woher Projekt und Objekt-Info kommen: `project` und `key` (Auswahl) entscheiden, ob neu gebaut wird.
 * Standard ist der Store; Tests geben eine eigene Quelle.
 */
export interface HostSource {
  project: Project;
  /** Auswahl (oder ein anderer Schlüssel): bei neuer Identität wird neu gebaut. */
  key: unknown;
  selection: SelectionInfo | null;
}

/** Projekt und Objekt-Info aus dem Store (Objekt-Info aus dem gemeinsamen Cache, `useSelectionInfo`). */
function storeSource(): HostSource {
  const s = getState();
  return { project: s.project, key: s.selection, selection: selectionInfoFor(s.project, s.selection) };
}

/** Gebaute Fassung und woraus sie entstand. */
interface Built {
  input: PanelHostInput;
  project: Project;
  key: unknown;
  host: BaseHost;
}

/** Baut den Basis-Host aus den Eingaben und dem aktuellen Stand der Quelle. */
function buildHost(input: PanelHostInput, src: HostSource): Built {
  const c = flatHostOpts({ ...input, project: src.project, selection: src.selection });
  const view = buildViewStateFns(c);
  const host: BaseHost = {
    ...buildToolsHost(c),
    // Platzhalter — der LIVE-Wert wird in `hostWithMode` je Render injiziert
    // (nicht hier, weil `draft` bewusst kein Dep dieses Memos ist, s. dort).
    measurement: null,
    ...buildSelectionStyleHost(c),
    ...buildElementAttributesHost(c),
    ...buildSiteHost(c),
    ...buildViewSnapshotsHost(c, view),
    ...buildLayoutsHost(c),
  };
  return { input, project: src.project, key: src.key, host };
}

export function usePanelHostBase(input: PanelHostInput, source: () => HostSource = storeSource): BaseHost {
  const c = flatHostOpts(input);
  const {
    activeLevelId,
    activeCategoryCode,
    activeTool,
    activeWallTypeId,
    snap,
    viewType,
    view3d,
    fov,
    detail,
    scaleDenominator,
    sectionLine,
    selectedSectionLineId,
    section3dCutId,
    onToggleSection3dCut,
    selectedViewSnapshotId,
  } = c;
  const commandName = input.engineView.commandName;
  // Jüngste Eingaben (je App-Render) und die zuletzt gebaute Fassung.
  const inputRef = useRef(input);
  inputRef.current = input;
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const built = useRef<Built | null>(null);
  // Fassung für die Wert-Felder: neu bei geänderten Wert-Feldern (wie zuvor; Projekt und Auswahl sind
  // keine Deps mehr, s. Kopf).
  const baseHost = useMemo((): BaseHost => {
    built.current = buildHost(input, sourceRef.current());
    return built.current.host;
    // Die Handler-Bündel (Projekt-Aktionen, Setter) sind stabil genug; neu gebaut wird bei den Wert-Feldern.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    activeLevelId,
    activeCategoryCode,
    activeTool,
    commandName,
    activeWallTypeId,
    snap,
    viewType,
    view3d,
    fov,
    detail,
    scaleDenominator,
    sectionLine,
    selectedSectionLineId,
    section3dCutId,
    onToggleSection3dCut,
    selectedViewSnapshotId,
  ]);
  // Ziel der Trampoline: die gebaute Fassung, frisch gebaut, wenn sich seither Projekt, Auswahl oder die
  // Eingaben geändert haben (Handler schliessen dann über den aktuellen Stand).
  const latest = useMemo(
    () => ({
      get current(): BaseHost {
        const src = sourceRef.current();
        const b = built.current;
        if (!b || b.project !== src.project || b.key !== src.key || b.input !== inputRef.current) {
          const next = buildHost(inputRef.current, src);
          built.current = next;
          return next.host;
        }
        return b.host;
      },
    }),
    [],
  );
  return useStableHost(baseHost, latest);
}
