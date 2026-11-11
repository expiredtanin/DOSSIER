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
  navigateToLevel,
  switchViewKind,
  tabKindOf,
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

// ── [182] Reiter-Arten: Navigator und 3D/Grundriss ──────────────────────────
describe("Reiter-Arten und Navigation [182]", () => {
  const levels = [
    { id: "eg", kind: "floor" as const },
    { id: "og", kind: "floor" as const },
    { id: "sec", kind: "section" as const },
    { id: "sec2", kind: "section" as const },
    { id: "ans", kind: "elevation" as const },
    { id: "det", kind: "drawing" as const },
  ];
  const live = (activeLevelId: string, viewType: "grundriss" | "perspektive" = "grundriss"): ViewSnapshotState =>
    ({ ...st(activeLevelId), viewType, cameraCenter: { x: 1, y: 2 }, cameraPxPerMeter: 40 }) as ViewSnapshotState;
  const one = () => initialTabs();

  it("tabKindOf: Art aus Ansicht und Ebene", () => {
    expect(tabKindOf(live("eg"), levels)).toBe("plan");
    expect(tabKindOf(live("eg", "perspektive"), levels)).toBe("3d");
    expect(tabKindOf(live("sec"), levels)).toBe("section");
    expect(tabKindOf(live("ans"), levels)).toBe("elevation");
    expect(tabKindOf(live("det"), levels)).toBe("drawing");
    expect(tabKindOf(undefined, levels)).toBeNull();
  });

  it("Geschoss im 3D-Reiter: nur Geschoss wechselt, kein neuer Reiter", () => {
    const s = one();
    const r = navigateToLevel(s, live("eg", "perspektive"), levels, "og");
    expect(r.setLevel).toBe("og");
    expect(r.apply).toBeNull();
    expect(r.next).toBe(s);
  });

  it("Geschoss im Grundriss-Reiter: gleicher Reiter, Grundriss", () => {
    const r = navigateToLevel(one(), live("eg"), levels, "og");
    expect(r.setLevel).toBe("og");
  });

  it("Schnitt: neuer Reiter, 3D-Reiter bleibt bestehen", () => {
    const s = one();
    const r = navigateToLevel(s, live("eg", "perspektive"), levels, "sec");
    expect(r.next.tabs).toHaveLength(2);
    expect(r.next.tabs[0].id).toBe(s.tabs[0].id);
    expect(r.next.tabs[0].state?.viewType).toBe("perspektive");
    expect(r.apply?.activeLevelId).toBe("sec");
    expect(r.apply?.viewType).toBe("grundriss");
    expect(r.apply?.cameraCenter).toBeUndefined();
    expect(r.next.activeId).toBe(r.next.tabs[1].id);
  });

  it("Schnitt zweimal: springt zum offenen Reiter, anderer Schnitt öffnet weiteren", () => {
    const a = navigateToLevel(one(), live("eg"), levels, "sec");
    const back = navigateToLevel(a.next, live("sec"), levels, "eg"); // Grundriss-Reiter wieder aktiv
    expect(back.next.tabs).toHaveLength(2);
    expect(back.apply?.activeLevelId).toBe("eg");
    const again = navigateToLevel(back.next, live("eg"), levels, "sec");
    expect(again.next.tabs).toHaveLength(2);
    expect(again.next.activeId).toBe(a.next.activeId);
    const other = navigateToLevel(again.next, live("sec"), levels, "sec2");
    expect(other.next.tabs).toHaveLength(3);
    expect(navigateToLevel(other.next, live("sec2"), levels, "sec2").apply).toBeNull();
  });

  it("Geschoss aus dem Schnitt: Grundriss-Reiter, Schnitt-Reiter bleibt Schnitt", () => {
    const a = navigateToLevel(one(), live("eg"), levels, "sec");
    const r = navigateToLevel(a.next, live("sec"), levels, "og");
    expect(r.next.tabs).toHaveLength(2);
    expect(r.apply).toMatchObject({ activeLevelId: "og", viewType: "grundriss" });
    expect(r.next.tabs.find((t) => t.state?.activeLevelId === "sec")).toBeTruthy();
  });

  it("Ansicht und Zeichnung öffnen je einen eigenen Reiter", () => {
    const a = navigateToLevel(one(), live("eg"), levels, "ans");
    const b = navigateToLevel(a.next, live("ans"), levels, "det");
    expect(b.next.tabs).toHaveLength(3);
    expect(b.apply?.activeLevelId).toBe("det");
  });

  it("3D aus dem Schnitt: öffnet 3D-Reiter mit Geschoss, Schnitt-Reiter bleibt", () => {
    const a = navigateToLevel(one(), live("eg"), levels, "sec");
    const r = switchViewKind(a.next, live("sec"), levels, "perspektive");
    expect(r.next.tabs).toHaveLength(3);
    expect(r.apply).toMatchObject({ viewType: "perspektive", activeLevelId: "eg" });
    expect(r.next.tabs.some((t) => t.state?.activeLevelId === "sec" && t.state.viewType === "grundriss")).toBe(true);
  });

  it("3D mit vorhandenem 3D-Reiter: wechselt dorthin, aus dem Grundriss mit dessen Geschoss", () => {
    const s0 = one();
    const a = switchViewKind(s0, live("eg"), levels, "perspektive"); // Grundriss -> neuer 3D-Reiter
    expect(a.next.tabs).toHaveLength(2);
    const planBack = switchViewKind(a.next, live("eg", "perspektive"), levels, "grundriss");
    expect(planBack.next.tabs).toHaveLength(2);
    expect(planBack.next.activeId).toBe(s0.tabs[0].id);
    const toggle = navigateToLevel(planBack.next, live("eg"), levels, "og");
    expect(toggle.setLevel).toBe("og");
    const to3d = switchViewKind(planBack.next, live("og"), levels, "perspektive");
    expect(to3d.next.tabs).toHaveLength(2);
    expect(to3d.apply).toMatchObject({ viewType: "perspektive", activeLevelId: "og" });
  });

  it("Schon in der gewünschten Art: nichts zu tun", () => {
    expect(switchViewKind(one(), live("eg", "perspektive"), levels, "perspektive").apply).toBeNull();
    expect(switchViewKind(one(), live("eg"), levels, "grundriss").apply).toBeNull();
  });

  it("Grundriss aus dem Schnitt: zum vorhandenen Grundriss-Reiter, sonst neu", () => {
    const a = navigateToLevel(one(), live("eg"), levels, "sec");
    const r = switchViewKind(a.next, live("sec"), levels, "grundriss");
    expect(r.next.tabs).toHaveLength(2);
    expect(r.apply?.activeLevelId).toBe("eg");
    // Nur Schnitt-Reiter offen -> neuer Grundriss-Reiter mit erstem Geschoss
    const only = { tabs: [{ id: "x", state: live("sec") }], activeId: "x" };
    const n = switchViewKind(only, live("sec"), levels, "grundriss");
    expect(n.next.tabs).toHaveLength(2);
    expect(n.apply).toMatchObject({ viewType: "grundriss", activeLevelId: "eg" });
  });
});
