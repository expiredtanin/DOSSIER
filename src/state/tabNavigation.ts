// Reiter-Navigation ([182], wie Archicad): Navigator, Ansichts-Umschalter und Layouts wählen den passenden
// Reiter, statt den aktiven umzubauen. Die Regeln selbst sind rein (`viewTabs.ts`: `navigateToLevel`,
// `switchViewKind`); hier werden sie auf den Store und den Darstellungszustand der App angewendet.

import type { ViewType } from "../model/viewTypes";
import { sheetLevelOf } from "../model/layoutModel";
import { getState } from "./appStore";
import type { ViewSnapshotState } from "./viewSnapshots";
import { cycleTab, getViewStateBridge, getViewTabs, navigateToLevel, setViewTabs, stepFloor, switchViewKind, type TabNav } from "./viewTabs";
import { getView3dFilter, hideSelection3d, selectionIds3d, setView3dFilter, showSelection3d } from "./view3dFilter";
import { clearKinds } from "./selection";

function run(nav: (live: ViewSnapshotState) => TabNav | null): void {
  const bridge = getViewStateBridge();
  if (!bridge) return;
  const r = nav(bridge.live());
  if (!r) return;
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

/** [252] Ctrl+Tab (+1) / Ctrl+Umschalt+Tab (−1): durch die Ansichts-Reiter springen, zyklisch. */
export function cycleViewTab(dir: 1 | -1): void {
  const bridge = getViewStateBridge();
  if (!bridge) return;
  const r = cycleTab(getViewTabs(), dir, bridge.live());
  if (r.next === getViewTabs()) return;
  setViewTabs(r.next);
  if (r.apply) bridge.apply(r.apply);
}

/** [185] Cmd/Ctrl+5 (−1) bzw. Cmd/Ctrl+6 (+1): im Grundriss-/3D-Reiter ein Geschoss tiefer/höher (Zoom bleibt). */
export function stepActiveFloor(dir: 1 | -1): void {
  run((live) => stepFloor(getViewTabs(), live, getState().project.drawingLevels, dir));
}

/**
 * [185] Cmd/Ctrl+3 „Auswahl in 3D zeigen": mit Auswahl zeigt der 3D-Reiter nur diese (Titel „3D · Auswahl"), ohne
 * Auswahl wieder alles; wechselt in den 3D-Reiter bzw. öffnet ihn, die Kamera bleibt stehen (Einpassen nur Cmd/Ctrl+Shift+F).
 */
export function showSelectionIn3d(): void {
  setView3dFilter(showSelection3d(selectionIds3d(getState().selection)));
  switchViewType("perspektive");
}

/** [185] Cmd/Ctrl+4: gewählte Elemente im 3D temporär ausblenden (nicht anwählbar, kein Undo-Schritt); Auswahl leeren. */
export function hideSelectionIn3d(): void {
  const st = getState();
  const ids = selectionIds3d(st.selection);
  if (!ids.length) return;
  setView3dFilter(hideSelection3d(getView3dFilter(), ids));
  st.setSelection(clearKinds("walls", "ceilings", "openings", "stairs", "solids", "columns", "roofs", "contextObjects", "trees", "cameras", "drawings", "groups"));
}
