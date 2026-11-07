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
  addRuleBlockOps,
  patchTemplateOps,
  uiPatch,
  type ViewTemplateUi,
} from "./viewTemplates";
import { standardOverrideRules } from "../model/standards";

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
  it("[156] setzt „Bodenbelag zeigen“ am Geschoss", () => {
    const p = applyOps(base(), addTemplateOps({ id: "tb", name: "Nass", floorFinish: "wet" }));
    const q = applyOps(p, applyToLevelOps(p, "tb", "eg", false));
    expect(q.drawingLevels.find((l) => l.id === "eg")?.floorFinish).toBe("wet");
  });
  it("[157] setzt „Gelände zeigen“ am Geschoss", () => {
    const p = applyOps(base(), addTemplateOps({ id: "tg", name: "Umgebung", showTerrain: true }));
    const q = applyOps(p, applyToLevelOps(p, "tg", "og", false));
    expect(q.drawingLevels.find((l) => l.id === "og")?.showTerrain).toBe(true);
  });
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

  it("[67] Skizzenstil: verknüpfte Vorlage schaltet ihn an der Ansicht", () => {
    let p = withTemplate(base());
    p = applyOps(p, applyToLevelOps(p, "t1", "eg", true));
    p = applyOps(p, patchTemplateOps(p, "t1", { sketch: true }));
    expect(p.drawingLevels.find((l) => l.id === "eg")!.sketch).toBe(true);
    expect(captureTemplate("t2", "S", p.drawingLevels.find((l) => l.id === "eg"), ui).sketch).toBe(true);
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

  it("[33] Baustein „Deckenaufbau weiss“: Regel aus den Standards ins Projekt (aus), in der Vorlage eingeschaltet", () => {
    let p = withTemplate(base());
    const blocks = standardOverrideRules(p);
    const block = blocks.find((r) => r.id === "std-or-deckenaufbau-weiss")!;
    expect(block).toMatchObject({ name: "Deckenaufbau weiss", enabled: false, actions: { fillColor: "#ffffff", hatch: "none", outline: true } });
    p = applyOps(p, addRuleBlockOps(p, "t1", block));
    expect(p.overrideRules!.find((r) => r.id === block.id)).toMatchObject({ enabled: false });
    expect(p.viewTemplates![0].enabledOverrideRuleIds).toEqual([block.id]);
    // Zweimal: nichts doppelt; Baustein bleibt in der Liste (jetzt aus dem Projekt).
    p = applyOps(p, addRuleBlockOps(p, "t1", block));
    expect(p.overrideRules!.filter((r) => r.id === block.id)).toHaveLength(1);
    expect(p.viewTemplates![0].enabledOverrideRuleIds).toEqual([block.id]);
    expect(standardOverrideRules(p).map((r) => r.id)).toContain(block.id);
    // Vorlage anwenden schaltet die Regel ein (Anzeigezustand).
    expect(uiPatch(p.viewTemplates![0], ui).enabledOverrideRuleIds).toEqual([block.id]);
  });

  it("[33] Baustein „Ansicht ohne Materialschraffur“: nur in Ansichten, Öffnungen ausgenommen, ausgeschaltet", () => {
    const block = standardOverrideRules(withTemplate(base())).find((r) => r.id === "std-or-ansicht-ohne-materialschraffur")!;
    expect(block).toMatchObject({
      name: "Ansicht ohne Materialschraffur",
      enabled: false,
      condition: { type: "view_kind", operator: "equals", value: "elevation" },
      conditions: [{ type: "element_kind", operator: "not_equals", value: "opening" }],
      actions: { fillColor: "#ffffff", hatch: "none" },
    });
  });
});
