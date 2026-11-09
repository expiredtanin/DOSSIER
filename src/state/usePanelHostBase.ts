// Host-Context für die Panels: baut den (dock-unabhängigen) Basis-Host aus Snap-/View-State, Auswahl
// und den Projekt-Mutationen zusammen — die Adapter-Schicht zwischen App-Zustand und dem
// PanelHostContext, den Docks und schwebende Panels konsumieren (`hostWithMode` hängt je Dock nur noch
// den Darstellungsmodus an). Aufgerufen von `App.tsx`.
//
// [121] Zerlegt in Teil-Bauer unter `panelHost/` (je Themenbereich eine Datei, s. dort): Werkzeuge und
// Ressourcen, Darstellung der Auswahl, Bauteil-Attribute, Lage/Elemente, Ausschnitte/Reiter, Layouts.
// Das Projekt und die Objekt-Info sind KEINE Host-Felder mehr — Panels abonnieren sie selbst im Store
// (`useStore`, `useSelectionInfo`). Der Host wird zwar bei jeder Projekt-/Auswahl-Änderung neu gebaut
// (die Handler schliessen über den aktuellen Stand), `useStableHost` hält aber seine Identität, solange
// sich kein Wert-Feld ändert: eine Op am Modell rendert die Panels nicht über den Host neu.

import { useMemo } from "react";
import { buildElementAttributesHost } from "./panelHost/elementAttributesHost";
import { buildLayoutsHost } from "./panelHost/layoutsHost";
import { buildSelectionStyleHost } from "./panelHost/selectionStyleHost";
import { buildSiteHost } from "./panelHost/siteHost";
import { useStableHost } from "./panelHost/stableHost";
import { buildToolsHost } from "./panelHost/toolsHost";
import { flatHostOpts, type BaseHost, type PanelHostOpts } from "./panelHost/types";
import { buildViewSnapshotsHost } from "./panelHost/viewSnapshotsHost";
import { buildViewStateFns } from "./panelHost/viewState";

export type { PanelHostOpts } from "./panelHost/types";

export function usePanelHostBase(opts: PanelHostOpts): BaseHost {
  const c = flatHostOpts(opts);
  const {
    project,
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
    selection,
    sectionLine,
    selectedSectionLineId,
    section3dCutId,
    onToggleSection3dCut,
    selectedViewSnapshotId,
  } = c;
  const commandName = opts.engineView.commandName;
  const baseHost = useMemo((): BaseHost => {
    const view = buildViewStateFns(c);
    return {
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
    // Die Handler-Bündel (Projekt-Aktionen, Setter) sind stabil genug; neu gebaut wird bei
    // Projekt, Auswahl und den Wert-Feldern.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    project,
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
    selection,
    sectionLine,
    selectedSectionLineId,
    section3dCutId,
    onToggleSection3dCut,
    selectedViewSnapshotId,
  ]);

  return useStableHost(baseHost);
}
