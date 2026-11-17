// [271][272] Ansicht für Export-/Rendering-Dialog: Umbaufilter (mit Anzeigename) und Variantenkombination der aktiven Ebene.
import { beforeEach, describe, expect, it } from "vitest";
import { getState, setState } from "./appStore";
import { activeExportView } from "./exportViewState";
import { buildUmbauSampleProject } from "../model/sampleProjectUmbau";
import { buildVariantenSampleProject } from "../model/sampleProjectVarianten";
import { hasExportView } from "../core";

beforeEach(() => {
  setState({ project: buildVariantenSampleProject(), activeLevelId: "eg" });
});

describe("activeExportView", () => {
  it("ohne Filter und Wahl: leer, die Dialoge zeigen Hauptvarianten", () => {
    const v = activeExportView();
    expect(hasExportView(v.view)).toBe(false);
    expect(v.labels).toEqual({ renovation: null, combination: null });
  });

  it("Kombination der aktiven Ebene mit Namen", () => {
    const p = buildVariantenSampleProject();
    setState({ project: { ...p, drawingLevels: p.drawingLevels.map((l) => (l.id === "eg" ? { ...l, designOptionCombination: "studie-2" } : l)) } });
    const v = activeExportView();
    expect(v.view.designOptions).toEqual({ dachform: "b", fassade: "b" });
    expect(v.labels.combination).toBe("Studie 2 Satteldach/Bandfenster");
    // Andere Ebene: eigene Ansicht (hier ohne Wahl).
    getState().setActiveLevelId("og");
    expect(hasExportView(activeExportView().view)).toBe(false);
  });

  it("Umbaufilter der aktiven Ebene mit Anzeigename und Etappe", () => {
    const p = buildUmbauSampleProject();
    const phase = p.renovation?.phases?.[0];
    setState({ project: { ...p, drawingLevels: p.drawingLevels.map((l) => (l.id === "eg" ? { ...l, renovationFilter: "endzustand", renovationPhase: phase?.id } : l)) } });
    const v = activeExportView();
    expect(v.view).toEqual({ renovation: "endzustand", renovationPhase: phase?.id });
    expect(v.labels.renovation).toContain("Endzustand");
    expect(v.labels.renovation).toContain(phase!.name);
  });
});
