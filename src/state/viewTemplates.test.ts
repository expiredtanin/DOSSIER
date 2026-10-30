// Ansichtsvorlagen ([34]): erfassen, einmal anwenden, verknüpfen und Änderungen weitergeben,
// duplizieren, löschen (Verknüpfung lösen), Anzeigezustand-Abgleich.
import { describe, expect, it } from "vitest";
import { applyOps } from "../core/ops";
import { sampleProject } from "../model/sampleProject";
import type { Project, ViewSnapshot } from "../model/types";
import {
  addTemplateOps,
  applyToLevelOps,
  applyToSnapshotOps,
  captureTemplate,
  deleteTemplateOps,
  duplicateTemplateOps,
  linkedTemplate,
  patchTemplateOps,
  uiPatch,
  type ViewTemplateUi,
} from "./viewTemplates";

const ui: ViewTemplateUi = { detail: "mittel", scaleDenominator: 100, layerVisibility: { "20": true, "30": true }, enabledOverrideRuleIds: [], displayMode: "all", mono: false, scaleLineWeights: false };

function base(): Project {
  const snap: ViewSnapshot = {
    id: "s1", name: "S", viewType: "grundriss", view3d: "iso", scaleDenominator: 50, detail: "fein", activeLevelId: "eg",
    layerVisibility: { "20": true, "30": true }, drawingVisibility: {},
  };
  return { ...sampleProject, viewSnapshots: [snap] };
}

function withTemplate(p: Project): Project {
  const t = captureTemplate("t1", "Werkplan", p.drawingLevels.find((l) => l.id === "eg"), { ...ui, layerVisibility: { "20": true, "30": false } });
  return applyOps(p, addTemplateOps({ ...t, viewTop: 2.0, viewBottom: -0.5 }));
}

describe("viewTemplates", () => {
  it("erfasst Geschoss- und Anzeigewerte", () => {
    const p = base();
    const t = captureTemplate("t", "V", p.drawingLevels.find((l) => l.id === "eg"), ui);
    expect(t).toMatchObject({ detail: "mittel", scaleDenominator: 100, cutHeight: 1.0, mono: false });
    expect(t.layerVisibility).toEqual({ "20": true, "30": true });
  });

  it("einmal anwenden: Werte kopieren, nicht verknüpft; spätere Vorlagenänderung wirkt nicht", () => {
    let p = withTemplate(base());
    p = applyOps(p, applyToLevelOps(p, "t1", "eg", false));
    const eg = () => p.drawingLevels.find((l) => l.id === "eg")!;
    expect(eg()).toMatchObject({ viewTop: 2, viewBottom: -0.5, templateId: "t1", templateLinked: false });
    expect(linkedTemplate(p, eg())).toBeUndefined();
    p = applyOps(p, patchTemplateOps(p, "t1", { viewTop: 3 }));
    expect(eg().viewTop).toBe(2);
  });

  it("verknüpft: Änderung der Vorlage schlägt in Ansicht und Ausschnitt durch", () => {
    let p = withTemplate(base());
    p = applyOps(p, [...applyToLevelOps(p, "t1", "eg", true), ...applyToSnapshotOps(p, "t1", "s1", true)]);
    expect(p.viewSnapshots![0]).toMatchObject({ detail: "mittel", scaleDenominator: 100, layerVisibility: { "20": true, "30": false }, templateLinked: true });
    expect(linkedTemplate(p, p.drawingLevels.find((l) => l.id === "eg"))?.id).toBe("t1");
    p = applyOps(p, patchTemplateOps(p, "t1", { viewTop: 3, detail: "grob" }));
    expect(p.drawingLevels.find((l) => l.id === "eg")!.viewTop).toBe(3);
    expect(p.drawingLevels.find((l) => l.id === "og")!.viewTop).toBeUndefined();
    expect(p.viewSnapshots![0].detail).toBe("grob");
  });

  it("Feld entfernen (undefined) gibt die Einstellung frei", () => {
    let p = withTemplate(base());
    p = applyOps(p, patchTemplateOps(p, "t1", { viewBottom: undefined }));
    expect("viewBottom" in p.viewTemplates![0]).toBe(false);
  });

  it("duplizieren: Kopie direkt dahinter, unabhängig", () => {
    let p = withTemplate(base());
    p = applyOps(p, duplicateTemplateOps(p, "t1", "t2", "Werkplan Kopie"));
    expect(p.viewTemplates!.map((t) => t.id)).toEqual(["t1", "t2"]);
    expect(p.viewTemplates![1]).toMatchObject({ name: "Werkplan Kopie", viewTop: 2 });
    p = applyOps(p, patchTemplateOps(p, "t2", { viewTop: 9 }));
    expect(p.viewTemplates![0].viewTop).toBe(2);
  });

  it("löschen löst Verknüpfungen, Werte bleiben", () => {
    let p = withTemplate(base());
    p = applyOps(p, [...applyToLevelOps(p, "t1", "eg", true), ...applyToSnapshotOps(p, "t1", "s1", true)]);
    p = applyOps(p, deleteTemplateOps(p, "t1"));
    expect(p.viewTemplates).toEqual([]);
    const eg = p.drawingLevels.find((l) => l.id === "eg")!;
    expect(eg.templateId).toBeUndefined();
    expect(eg.viewTop).toBe(2);
    expect(p.viewSnapshots![0].templateId).toBeUndefined();
  });

  it("uiPatch: nur Abweichendes, nur vorhandene Kategorien", () => {
    const t = withTemplate(base()).viewTemplates![0];
    expect(uiPatch(t, ui)).toEqual({ layerVisibility: { "30": false } });
    expect(uiPatch(t, { ...ui, layerVisibility: { "20": true } })).toEqual({});
  });
});
