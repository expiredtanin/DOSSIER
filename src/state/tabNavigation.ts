// Reiter-Navigation ([182], wie Archicad): Navigator, Ansichts-Umschalter und Layouts wählen den passenden
// Reiter, statt den aktiven umzubauen. Die Regeln selbst sind rein (`viewTabs.ts`: `navigateToLevel`,
// `switchViewKind`); hier werden sie auf den Store und den Darstellungszustand der App angewendet.

import type { ViewType } from "../model/viewTypes";
import { sheetLevelOf } from "../model/layoutModel";
import { getState } from "./appStore";
import type { ViewSnapshotState } from "./viewSnapshots";
import { getViewStateBridge, getViewTabs, navigateToLevel, setViewTabs, switchViewKind, type TabNav } from "./viewTabs";

function run(nav: (live: ViewSnapshotState) => TabNav): void {
  const bridge = getViewStateBridge();
  if (!bridge) return;
  const r = nav(bridge.live());
  setViewTabs(r.next);
  if (r.setLevel) {
    // Gleicher Reiter: nur das Geschoss wechselt, die Art (Grundriss/3D) bleibt.
    const st = getState();
    const keep = st.viewType;
    st.setActiveLevelId(r.setLevel);
    getState().setViewType(keep);
  } else if (r.apply) {
    bridge.apply(r.apply);
  }
}

/** Ebene im Navigator (oder per Link, z. B. Schnittmarke) öffnen. */
export function openLevel(levelId: string): void {
  run((live) => navigateToLevel(getViewTabs(), live, getState().project.drawingLevels, levelId));
}

/** „Grundriss" bzw. „3D" wählen: wechselt zum passenden Reiter oder öffnet ihn. */
export function switchViewType(want: ViewType): void {
  run((live) => switchViewKind(getViewTabs(), live, getState().project.drawingLevels, want));
}

/** Layout in eigenem Reiter öffnen (bzw. zu dessen offenem Reiter springen); danach `setActiveLayoutId`. */
export function openLayoutTab(layoutId: string): void {
  const sheet = sheetLevelOf(getState().project, layoutId);
  if (sheet) openLevel(sheet.id);
}
