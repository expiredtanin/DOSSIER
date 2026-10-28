// App-Store: komponiert die vier Domänen-Slices (project/selection/view/layout)
// über `createStore` zu EINEM RootState und exportiert die Store-Schnittstelle
// (useStore/getState/setState). Jede Slice ist eine Factory `(api) => slice`;
// alle bekommen dieselbe `set/get`-API über den Gesamt-RootState, sodass
// Cross-Slice-Aktionen (z. B. deleteLevel ↔ activeLevelId) typsicher arbeiten.
//
// Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

import { createStore } from "./store";
import type { StoreApi } from "./store";
import { createProjectSlice } from "./projectSlice";
import type { ProjectSlice } from "./projectSlice";
import type { HistorySlice } from "./historySlice";
import { createSelectionSlice } from "./selectionSlice";
import type { SelectionSlice } from "./selectionSlice";
import { createViewSlice } from "./viewSlice";
import type { ViewSlice } from "./viewSlice";
import { createLayoutSlice } from "./layoutSlice";
import type { LayoutSlice } from "./layoutSlice";
import { createSiteSlice } from "./siteSlice";
import type { SiteSlice } from "./siteSlice";
import { createNotifySlice } from "./notifySlice";
import type { NotifySlice } from "./notifySlice";

/** Gesamtzustand: Vereinigung aller Slice-Felder + Actions. */
export type RootState = ProjectSlice &
  HistorySlice &
  SelectionSlice &
  ViewSlice &
  LayoutSlice &
  SiteSlice &
  NotifySlice;

const store = createStore<RootState>((api) => ({
  // Jede Slice-Factory bekommt die volle RootState-API. Die Slices tippen nur
  // ihren eigenen Ausschnitt; die Cast auf die enge Slice-API ist sicher, weil
  // `set/get` immer über den Gesamt-RootState laufen. ProjectSlice bringt die
  // History (undo/redo) gleich mit (setProject ist der einzige Durchlauf-
  // punkt jeder Projekt-Mutation, siehe projectSlice.ts) und braucht `notify`
  // (Cross-Slice) für die Lösch-Schutz-Warnungen (statt window.alert, siehe
  // notifySlice.ts).
  ...createProjectSlice(
    api as unknown as StoreApi<
      ProjectSlice & HistorySlice & { activeLevelId: string } & Pick<NotifySlice, "notify">
    >,
  ),
  ...createNotifySlice(api as unknown as StoreApi<NotifySlice>),
  ...createSelectionSlice(api as unknown as StoreApi<SelectionSlice>),
  ...createViewSlice(api as unknown as StoreApi<ViewSlice>),
  ...createLayoutSlice(api as unknown as StoreApi<LayoutSlice>),
  // Site-/Kontext-Slice liest `project` und schreibt über `setProject`
  // (beide aus der Projekt-Slice) — daher die kombinierte Sicht im Cast.
  ...createSiteSlice(
    api as unknown as StoreApi<
      SiteSlice & {
        project: ProjectSlice["project"];
        setProject: ProjectSlice["setProject"];
      }
    >,
  ),
}));

export const useStore = store.useStore;
export const getState = store.getState;
export const setState = store.setState;


// Aktive Ebene nach Projektänderungen absichern: Undo/Redo (oder jede andere Änderung) kann die
// aktive Ebene entfernen, z. B. Undo von „Räume generieren" oder eines DXF-Imports in eine neue
// Ebene. Dann auf die zuletzt aktive, noch vorhandene Ebene zurückfallen, sonst aufs erste
// Geschoss (bzw. die erste Ebene). `activeLevelId` ist UI-Zustand: kein Undo-Schritt. Geprüft wird
// nur, wenn sich `project` geändert hat, damit eine vor dem Projekt gesetzte Id (Laden) bleibt.
const recentLevelIds: string[] = [];
const remember = (id: string) => {
  if (recentLevelIds[recentLevelIds.length - 1] === id) return;
  recentLevelIds.push(id);
  if (recentLevelIds.length > 20) recentLevelIds.shift();
};
let lastProject = store.getState().project;
store.subscribe(() => {
  const s = store.getState();
  const id = s.activeLevelId;
  const levels = s.project.drawingLevels;
  const exists = levels.some((l) => l.id === id);
  if (exists) remember(id);
  if (s.project === lastProject) return;
  lastProject = s.project;
  if (exists || levels.length === 0) return;
  let fallback: string | undefined;
  for (let i = recentLevelIds.length - 1; i >= 0 && !fallback; i--) {
    if (levels.some((l) => l.id === recentLevelIds[i])) fallback = recentLevelIds[i];
  }
  fallback ??= (levels.find((l) => l.kind === "floor") ?? levels[0]).id;
  store.setState({ activeLevelId: fallback });
});
