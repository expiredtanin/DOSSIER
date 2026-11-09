// Panel-Host, Teil Ausschnitte und Zeichnungs-Reiter ([121], aus `usePanelHostBase` herausgelöst):
// Ausschnitte erfassen, anwenden, aktualisieren, umbenennen, löschen, in Ordner legen; Reiter
// öffnen/schliessen (`viewTabs.ts`); Sichtbarkeits-Kombinationen für den Panel-Fuss. Der
// Darstellungszustand selbst (`liveViewState`/`applyViewState`) kommt aus `viewState.ts`.

import { addItems, fieldOps, patchItem, removeItems } from "../../core";
import { t } from "../../i18n";
import { getState } from "../appStore";
import { captureViewSnapshot, matchingComboName, readViewSnapshot } from "../viewSnapshots";
import { setViewStateBridge, activateTab, activeTab, closeTab, detachSnapshots, getViewTabs, linkActiveTab, openTab, setViewTabs, storeActiveState, type ViewTabsState } from "../viewTabs";
import { createViewSnapshotFolder, deleteFolder as deleteViewSnapshotFolder, moveSnapshotToFolder, moveFolder as moveViewSnapshotFolder } from "../viewSnapshotFolders";
import { listDrawingCombos, listLayerCombos, loadDrawingCombo, loadLayerCombo } from "../visibilitySets";
import type { FlatHostOpts, HostPart } from "./types";
import type { ViewStateFns } from "./viewState";

/** Letzter Klick auf einen Ausschnitt im Panel (Doppelklick-Erkennung, [136]). */
let lastPanelClick: { id: string; at: number; tabs: ViewTabsState } | null = null;

export function buildViewSnapshotsHost(c: FlatHostOpts, view: ViewStateFns) {
  const { activeLevelId, applyChange, project, selectedViewSnapshotId, setSelectedViewSnapshotId, snapshotDrawingVisibility } = c;
  const { liveViewState, applyViewState } = view;
  setViewStateBridge({ live: liveViewState, apply: applyViewState }); // [136] Reiter mit dem Projekt sichern
  return {
    // ── Ausschnitte / View-Snapshots (DOSSIER A2) und Reiter ([136]) ──────
    // Ausschnitte leben im Projekt (Panel „Ausschnitte"), Reiter sind reiner UI-Zustand
    // (state/viewTabs.ts). Klick im Panel zeigt den Ausschnitt im aktiven Reiter, Doppelklick/Knopf
    // öffnet ihn in einem neuen; Reiter schliessen löscht keinen Ausschnitt; „Aktualisieren" schreibt
    // die aktuelle Ansicht ausdrücklich in den Ausschnitt zurück.
    onCaptureViewSnapshot: (name: string, folderId?: string): string => {
      const trimmed = name.trim();
      if (!trimmed) return "";
      const snap = captureViewSnapshot(`vs-${Date.now()}`, trimmed, liveViewState());
      // Neuer Ausschnitt landet im aktiven Ordner (falls das Panel einen
      // mitgibt), sonst auf der Wurzelebene — additiv (folderId optional).
      const full = folderId ? { ...snap, folderId } : snap;
      applyChange(addItems("viewSnapshots", [full]));
      // Der aktive Reiter zeigt jetzt diesen Ausschnitt (Titel), der Ausschnitt ist im Panel gewählt.
      setViewTabs(linkActiveTab(getViewTabs(), full.id));
      setSelectedViewSnapshotId(full.id);
      return full.id;
    },

    // Titel eines Reiters ohne Ausschnitt: aktive Zeichnungskombination (falls deren
    // Sichtbarkeits-Map exakt passt), sonst die Zeichnungsebene des Reiters.
    viewTabAutoName: (levelId?: string): string => {
      if (!levelId || levelId === activeLevelId) {
        const combo = matchingComboName(listDrawingCombos(), loadDrawingCombo, snapshotDrawingVisibility());
        if (combo) return combo;
      }
      const id = levelId ?? activeLevelId;
      return project.drawingLevels.find((l) => l.id === id)?.name ?? id;
    },

    // Klick im Panel: Ausschnitt im AKTIVEN Reiter anzeigen und im Panel wählen.
    onApplyViewSnapshot: (id: string) => {
      // Aktuellen Stand lesen (direkt nach einer Änderung am Ausschnitt ist `project` hier noch der alte).
      const snap = (getState().project.viewSnapshots ?? []).find((s) => s.id === id);
      if (!snap) return;
      // Für einen folgenden Doppelklick merken, was der aktive Reiter vorher zeigte.
      lastPanelClick = { id, at: Date.now(), tabs: storeActiveState(getViewTabs(), liveViewState()) };
      applyViewState(readViewSnapshot(snap));
      setViewTabs(linkActiveTab(getViewTabs(), id));
      setSelectedViewSnapshotId(id);
    },

    // Doppelklick/Knopf im Panel: Ausschnitt in einem NEUEN Reiter öffnen.
    onOpenViewSnapshotInNewTab: (id: string) => {
      const snap = (getState().project.viewSnapshots ?? []).find((s) => s.id === id);
      if (!snap) return;
      // Doppelklick: die beiden vorangehenden Klicks haben den Ausschnitt schon im aktiven Reiter gezeigt —
      // dieser behält seinen früheren Inhalt, nur der neue Reiter zeigt den Ausschnitt.
      const prev = lastPanelClick;
      lastPanelClick = null;
      const base = prev && prev.id === id && Date.now() - prev.at < 1000 ? prev.tabs : undefined;
      const cur = getViewTabs();
      setViewTabs(
        base && base.activeId === cur.activeId
          ? openTab({ ...cur, tabs: cur.tabs.map((tb) => (tb.id === cur.activeId ? activeTab(base) : tb)) }, { snapshotId: id })
          : openTab(cur, { snapshotId: id }, liveViewState()),
      );
      applyViewState(readViewSnapshot(snap));
      setSelectedViewSnapshotId(id);
    },

    // Ausdrücklich: aktuelle Ansicht in den Ausschnitt schreiben (Name, Ordner, Vorlage bleiben).
    onUpdateViewSnapshot: (id: string) => {
      const live = liveViewState();
      applyChange((p) =>
        patchItem(p, "viewSnapshots", id, (v) => {
          const fresh = captureViewSnapshot(v.id, v.name, live);
          const { cameraCenter: _c, cameraPxPerMeter: _m, ...rest } = v;
          return { ...rest, ...fresh };
        }),
      );
    },

    // Reiterleiste.
    onActivateViewTab: (tabId: string) => {
      const { next, apply } = activateTab(getViewTabs(), tabId, liveViewState());
      setViewTabs(next);
      if (apply) applyViewState(apply);
      const snapId = next.tabs.find((tb) => tb.id === next.activeId)?.snapshotId;
      if (snapId) setSelectedViewSnapshotId(snapId);
    },
    onNewViewTab: () => {
      setViewTabs(openTab(getViewTabs(), {}, liveViewState()));
    },
    onCloseViewTab: (tabId: string) => {
      const { next, apply } = closeTab(getViewTabs(), tabId);
      setViewTabs(next);
      if (apply) applyViewState(apply);
    },

    onRenameViewSnapshot: (id: string, name: string) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      applyChange((p) => patchItem(p, "viewSnapshots", id, { name: trimmed }));
    },

    onDuplicateViewSnapshot: (id: string) => {
      // [40] Kopie gleich hinter dem Original, gleicher Ordner, „… Kopie"; danach angewählt.
      const list = project.viewSnapshots ?? [];
      const i = list.findIndex((v) => v.id === id);
      if (i < 0) return;
      const copy = { ...list[i], id: `vs-${Date.now()}`, name: t("viewsnap.copyName", { name: list[i].name }) };
      applyChange(() => addItems("viewSnapshots", [copy], i + 1));
      setSelectedViewSnapshotId(copy.id);
    },

    // Löschen nur im Panel. Offene Reiter des Ausschnitts bleiben (eigener Zustand, letzter Name als Titel).
    onDeleteViewSnapshot: (id: string) => {
      const snap = (getState().project.viewSnapshots ?? []).find((s) => s.id === id);
      applyChange((p) => removeItems(p, "viewSnapshots", [id]));
      if (snap) setViewTabs(detachSnapshots(getViewTabs(), [{ id, name: snap.name }]));
      if (selectedViewSnapshotId === id) setSelectedViewSnapshotId(null);
    },

    // ── Ausschnitte-Baum (Ordner, DOSSIER A2) ─────────────────────────────
    // Immutable CRUD über pure Helfer (state/viewSnapshotFolders.ts). Löschen
    // zieht Inhalt auf die Elternebene hoch (kein Datenverlust).
    onAddViewSnapshotFolder: (parentId) => {
      const id = `vsf-${Date.now()}`;
      const folder = createViewSnapshotFolder(
        id,
        t("viewsnap.folder.defaultName"),
        parentId,
      );
      applyChange(addItems("viewSnapshotFolders", [folder]));
      return id;
    },
    onRenameViewSnapshotFolder: (id, name) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      applyChange((p) => patchItem(p, "viewSnapshotFolders", id, { name: trimmed }));
    },
    onDeleteViewSnapshotFolder: (id) => {
      applyChange((p) => {
        const { folders, snapshots } = deleteViewSnapshotFolder(
          id,
          p.viewSnapshotFolders ?? [],
          p.viewSnapshots ?? [],
        );
        return [...fieldOps(p, "viewSnapshotFolders", folders), ...fieldOps(p, "viewSnapshots", snapshots)];
      });
    },
    onMoveViewSnapshotToFolder: (snapshotId, folderId) => {
      applyChange((p) => fieldOps(p, "viewSnapshots", moveSnapshotToFolder(p.viewSnapshots ?? [], snapshotId, folderId)));
    },
    onMoveViewSnapshotFolder: (folderId, parentId) => {
      applyChange((p) =>
        fieldOps(p, "viewSnapshotFolders", moveViewSnapshotFolder(p.viewSnapshotFolders ?? [], folderId, parentId)),
      );
    },

    // Footer-Bar des Ausschnitte-Panels: die aktuell „angewählte" Id plus
    // Lesezugriff auf die benannten Sichtbarkeits-Kombinationen (localStorage),
    // damit der Footer den Kombi-NAMEN zu den gespeicherten Maps auflösen kann.
    selectedViewSnapshotId,
    listLayerCombos,
    loadLayerCombo,
    listDrawingCombos,
    loadDrawingCombo,

  } satisfies HostPart;
}
