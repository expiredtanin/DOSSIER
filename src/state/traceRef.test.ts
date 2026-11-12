// [205] Pausfolie: Zustand je Reiter (Ein/Aus, Quelle, Verschieben/Drehen) und Speichern/Laden mit Reiter und Ausschnitt.
import { describe, expect, it } from "vitest";
import { buildComplexSampleProject } from "../model/sampleProjectComplex";
import { defaultTrace } from "../core";
import { defaultTraceSource, moveTrace, resetTracePosition, rotateTrace, showAsTrace, toggleTrace, traceMoved } from "./traceRef";
import { captureViewSnapshot, readViewSnapshot, type ViewSnapshotState } from "./viewSnapshots";
import { navigateToLevel, restoreViewTabs, serializeViewTabs } from "./viewTabs";

const p = buildComplexSampleProject();
const level = (id: string) => p.drawingLevels.find((l) => l.id === id)!;

describe("[205] Pausfolie: Zustand", () => {
  it("Vorgabe-Quelle: im Geschoss das darunter (UG unter EG, EG unter OG), sonst ±0.00", () => {
    expect(defaultTraceSource(p, level("eg"))).toBe("ug");
    expect(defaultTraceSource(p, level("og"))).toBe("eg");
    // Unterstes Geschoss: das nächsthöhere.
    expect(defaultTraceSource(p, level("ug"))).toBe("eg");
    expect(defaultTraceSource(p, level("schnitt-a"))).toBe("eg");
  });

  it("Ein/Aus behält Quelle, Farbe und Lage; erstes Einschalten mit Vorgabe-Quelle", () => {
    const first = toggleTrace(null, p, level("og"))!;
    expect(first).toEqual(defaultTrace("eg"));
    const styled = { ...first, color: "#cc3300", offset: { x: 1, y: 2 } };
    const off = toggleTrace(styled, p, level("og"))!;
    expect(off.show).toBe(false);
    expect(toggleTrace(off, p, level("og"))).toEqual(styled);
  });

  it("„Als Pausfolie zeigen“: neue Quelle setzt die Lage zurück, Farbe bleibt", () => {
    const t = { ...defaultTrace("eg"), color: "#123456", offset: { x: 3, y: 0 }, rotation: 10, show: false };
    expect(showAsTrace(t, "eg")).toEqual({ ...t, show: true });
    expect(showAsTrace(t, "schnitt-a")).toEqual({ ...t, sourceId: "schnitt-a", show: true, offset: { x: 0, y: 0 }, rotation: 0 });
    expect(showAsTrace(null, "og")).toEqual(defaultTrace("og"));
  });

  it("Verschieben, Drehen um einen Punkt, Zurücksetzen", () => {
    const t = defaultTrace("eg");
    const m = moveTrace(t, { x: 2, y: -1 });
    expect(m.offset).toEqual({ x: 2, y: -1 });
    expect(traceMoved(m)).toBe(true);
    // Um (1, 0) um 90° gedreht: Ursprung (Bild 0,0) → (1, −1).
    const r = rotateTrace(t, { x: 1, y: 0 }, 90);
    expect(r.rotation).toBe(90);
    expect(r.offset.x).toBeCloseTo(1, 12);
    expect(r.offset.y).toBeCloseTo(-1, 12);
    expect(rotateTrace({ ...t, rotation: 170 }, { x: 0, y: 0 }, 20).rotation).toBe(-170);
    expect(resetTracePosition(r)).toEqual(t);
    expect(traceMoved(t)).toBe(false);
  });
});

describe("[205] Pausfolie: Speichern und Laden", () => {
  const live: ViewSnapshotState = {
    viewType: "grundriss",
    view3d: "perspective",
    fov: 50,
    scaleDenominator: 100,
    detail: "mittel",
    activeLevelId: "eg",
    layerVisibility: {},
    drawingVisibility: {},
    enabledOverrideRuleIds: [],
    trace: { ...defaultTrace("schnitt-a"), color: "#2060c0", opacity: 0.3, offset: { x: -4, y: 1 }, rotation: 15, above: true },
  };

  it("mit dem Reiter (uiState.viewTabs) über JSON hin und zurück", () => {
    const ui = serializeViewTabs({ tabs: [{ id: "t1" }], activeId: "t1" }, live);
    const back = restoreViewTabs(JSON.parse(JSON.stringify({ uiState: ui, viewSnapshots: [] })));
    expect(back?.tabs[0].state?.trace).toEqual(live.trace);
  });

  it("gehört zum Reiter: der alte behält sie, ein neu geöffneter Schnitt-Reiter startet ohne", () => {
    const nav = navigateToLevel({ tabs: [{ id: "t1" }], activeId: "t1" }, live, p.drawingLevels, "schnitt-a");
    expect(nav.next.tabs.find((tab) => tab.id === "t1")?.state?.trace).toEqual(live.trace);
    expect(nav.apply?.activeLevelId).toBe("schnitt-a");
    expect(nav.apply && "trace" in nav.apply).toBe(false);
  });

  it("mit dem Ausschnitt (ViewSnapshot.trace), entkoppelt vom Live-Zustand", () => {
    const snap = captureViewSnapshot("v1", "EG mit Schnitt", live);
    expect(snap.trace).toEqual(live.trace);
    expect(snap.trace).not.toBe(live.trace);
    expect(readViewSnapshot(JSON.parse(JSON.stringify(snap))).trace).toEqual(live.trace);
    const { trace: _drop, ...without } = live;
    void _drop;
    expect("trace" in readViewSnapshot(captureViewSnapshot("v2", "ohne", without))).toBe(false);
  });
});
