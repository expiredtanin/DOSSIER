import { describe, expect, it, vi } from "vitest";
import type { Project } from "../model/types";
import { sampleProject } from "../model/sampleProject";
import { parseProjectFile, serializeProject } from "../io/projectFormat";
import type { ViewSnapshotState } from "./viewSnapshots";
import {
  activateTab,
  activeTab,
  closeTab,
  detachSnapshots,
  getViewTabs,
  initialTabs,
  linkActiveTab,
  openTab,
  restoreViewTabs,
  restoreViewTabsFromProject,
  serializeViewTabs,
  setViewStateBridge,
  tabTitle,
  uiStateForSave,
} from "./viewTabs";

const st = (activeLevelId: string, scaleDenominator = 100): ViewSnapshotState =>
  ({
    viewType: "plan",
    view3d: "iso",
    fov: 50,
    scaleDenominator,
    detail: "medium",
    activeLevelId,
    layerVisibility: {},
    drawingVisibility: {},
    enabledOverrideRuleIds: [],
  }) as unknown as ViewSnapshotState;

const snaps = [{ id: "vs-eg", name: "EG 1:100" }];

describe("viewTabs [136] — Reiter entkoppelt von Ausschnitten", () => {
  it("öffnet mehrere Reiter aus demselben Ausschnitt", () => {
    let s = initialTabs();
    s = linkActiveTab(s, "vs-eg");
    s = openTab(s, { snapshotId: "vs-eg" }, st("eg"));
    s = openTab(s, { snapshotId: "vs-eg" }, st("eg"));
    expect(s.tabs).toHaveLength(3);
    expect(s.tabs.every((t) => t.snapshotId === "vs-eg")).toBe(true);
    expect(new Set(s.tabs.map((t) => t.id)).size).toBe(3);
    expect(s.tabs.map((t) => tabTitle(t, snaps, () => "?"))).toEqual(["EG 1:100", "EG 1:100", "EG 1:100"]);
  });

  it("neuer Reiter ohne Ausschnitt nutzt den Ersatztitel; der alte Reiter merkt seinen Zustand", () => {
    const s0 = initialTabs();
    const s = openTab(s0, {}, st("og", 50));
    expect(s.activeId).not.toBe(s0.activeId);
    expect(s.tabs[0].state?.activeLevelId).toBe("og");
    expect(tabTitle(activeTab(s), snaps, () => "Live")).toBe("Live");
  });

  it("Wechsel merkt den Live-Zustand und liefert den Zustand des Ziels", () => {
    let s = initialTabs();
    const first = s.activeId;
    s = openTab(s, {}, st("eg"));
    const { next, apply } = activateTab(s, first, st("og"));
    expect(apply?.activeLevelId).toBe("eg");
    expect(next.activeId).toBe(first);
    expect(next.tabs[1].state?.activeLevelId).toBe("og");
    // Gleicher Reiter: nichts zu tun.
    expect(activateTab(next, first, st("x")).apply).toBeNull();
  });

  it("Schliessen entfernt nur den Reiter, nie den letzten; aktiver Nachbar wird angewendet", () => {
    let s = initialTabs();
    s = openTab(s, { snapshotId: "vs-eg" }, st("eg"));
    s = openTab(s, { snapshotId: "vs-eg" }, st("og"));
    const middle = s.tabs[1].id;
    const r = closeTab(s, s.activeId);
    expect(r.next.tabs).toHaveLength(2);
    expect(r.next.activeId).toBe(middle);
    expect(r.apply?.activeLevelId).toBe("og");
    // Nicht-aktiven Reiter schliessen: kein Wechsel.
    const r2 = closeTab(r.next, r.next.tabs[0].id);
    expect(r2.apply).toBeNull();
    expect(r2.next.tabs).toHaveLength(1);
    // Letzter Reiter bleibt.
    expect(closeTab(r2.next, r2.next.activeId).next).toBe(r2.next);
  });

  it("gelöschter Ausschnitt: Reiter bleiben offen, behalten den Namen und verlieren die Verbindung", () => {
    let s = linkActiveTab(initialTabs(), "vs-eg");
    s = openTab(s, { snapshotId: "vs-eg" }, st("eg"));
    s = openTab(s, {}, st("eg"));
    const d = detachSnapshots(s, [{ id: "vs-eg", name: "EG 1:100" }]);
    expect(d.tabs).toHaveLength(3);
    expect(d.tabs.some((t) => t.snapshotId)).toBe(false);
    expect(d.tabs.slice(0, 2).map((t) => tabTitle(t, [], () => "?"))).toEqual(["EG 1:100", "EG 1:100"]);
    expect(tabTitle(d.tabs[2], [], () => "Live")).toBe("Live");
    expect(detachSnapshots(d, [{ id: "vs-x", name: "x" }])).toBe(d);
  });

  it("Titel folgt dem Umbenennen des Ausschnitts", () => {
    const s = linkActiveTab(initialTabs(), "vs-eg");
    expect(tabTitle(activeTab(s), [{ id: "vs-eg", name: "EG neu" }], () => "?")).toBe("EG neu");
  });
});

describe("viewTabs [136] — mit dem Projekt gesichert", () => {
  const snapVs = (id: string) => ({ id }) as unknown as NonNullable<Project["viewSnapshots"]>[number];

  it("Rundreise Speichern → Öffnen: Reihenfolge, aktiver Reiter, Zustand, Ausschnitt-Bezug", () => {
    let s = initialTabs();
    s = linkActiveTab(s, "vs-eg");
    s = openTab(s, {}, st("eg", 100));
    s = openTab(s, { snapshotId: "vs-og" }, st("og", 50));
    const ui = serializeViewTabs(s, st("og", 200));
    // Datei-Rundreise über den Kern (uiState ersetzt nur in der Datei; Dokument unverändert).
    const base = { ...sampleProject, viewSnapshots: [snapVs("vs-eg"), snapVs("vs-og")] } as Project;
    const text = serializeProject(base, ui);
    expect(serializeProject(base)).not.toContain("uiState");
    const r = parseProjectFile(text);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.warnings).toEqual([]);
    const back = restoreViewTabs(r.project)!;
    expect(back.tabs.map((t) => t.id)).toEqual(s.tabs.map((t) => t.id));
    expect(back.activeId).toBe(s.activeId);
    expect(back.tabs.map((t) => t.snapshotId)).toEqual(["vs-eg", undefined, "vs-og"]);
    expect(back.tabs[2].state?.scaleDenominator).toBe(200); // Live-Zustand des aktiven Reiters
    expect(back.tabs[1].state?.scaleDenominator).toBe(50);
    expect(back.tabs[0].state?.activeLevelId).toBe("eg");
  });

  it("Reiter auf gelöschte Ausschnitte fallen weg; war der aktive darunter, ist der nächste aktiv", () => {
    let s = initialTabs();
    s = openTab(s, { snapshotId: "gone" }, st("eg"));
    s = openTab(s, { snapshotId: "gone" }, st("og"));
    s = openTab(s, { snapshotId: "vs-eg" }, st("dg"));
    const act = activateTab(s, s.tabs[2].id, st("dg"));
    const project = { uiState: serializeViewTabs(act.next, st("og")), viewSnapshots: [snapVs("vs-eg")] } as unknown as Project;
    const back = restoreViewTabs(project)!;
    expect(back.tabs.map((t) => t.snapshotId)).toEqual([undefined, "vs-eg"]);
    expect(back.activeId).toBe(back.tabs[1].id);
    // Aktiver Reiter gelöscht → der nächste behaltene rechts.
    const act2 = activateTab(s, s.tabs[1].id, st("eg"));
    const back2 = restoreViewTabs({ uiState: serializeViewTabs(act2.next, st("eg")), viewSnapshots: [snapVs("vs-eg")] } as unknown as Project)!;
    expect(back2.tabs.map((t) => t.snapshotId)).toEqual([undefined, "vs-eg"]);
    expect(back2.activeId).toBe(back2.tabs[1].id);
    // Nur Reiter auf gelöschte Ausschnitte → null (ein Reiter wie bisher).
    const ui = serializeViewTabs(s, undefined);
    ui.viewTabs!.tabs = ui.viewTabs!.tabs.filter((t) => t.snapshotId);
    expect(restoreViewTabs({ uiState: ui, viewSnapshots: [] } as unknown as Project)).toBeNull();
  });

  it("altes Projekt ohne Feld oder kaputtes Feld: wie bisher (null)", () => {
    expect(restoreViewTabs({ viewSnapshots: [] } as unknown as Project)).toBeNull();
    expect(restoreViewTabs({ uiState: { viewTabs: { tabs: [{ nope: 1 }], activeId: "x" } } } as unknown as Project)).toBeNull();
  });

  it("Öffnen stellt die Reiter her und wendet den Zustand des aktiven an; ohne Feld ein Reiter", () => {
    vi.useFakeTimers();
    const applied: ViewSnapshotState[] = [];
    setViewStateBridge({ live: () => st("eg"), apply: (x) => applied.push(x) });
    const s = openTab(initialTabs(), {}, st("eg"));
    restoreViewTabsFromProject({ uiState: serializeViewTabs(s, st("og", 77)), viewSnapshots: [] } as unknown as Project);
    expect(getViewTabs().tabs).toHaveLength(2);
    expect(getViewTabs().activeId).toBe(s.activeId);
    vi.runAllTimers();
    expect(applied.map((a) => a.scaleDenominator)).toEqual([77]);
    // Speichern liest den Live-Zustand der Brücke für den aktiven Reiter.
    expect(uiStateForSave().viewTabs?.tabs.find((t) => t.id === s.activeId)?.state?.activeLevelId).toBe("eg");
    restoreViewTabsFromProject({ viewSnapshots: [] } as unknown as Project);
    expect(getViewTabs().tabs).toHaveLength(1);
    setViewStateBridge(null);
    vi.useRealTimers();
  });
});
