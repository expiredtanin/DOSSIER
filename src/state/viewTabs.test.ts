import { describe, expect, it } from "vitest";
import type { ViewSnapshotState } from "./viewSnapshots";
import {
  activateTab,
  activeTab,
  closeTab,
  detachSnapshots,
  initialTabs,
  linkActiveTab,
  openTab,
  tabTitle,
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
