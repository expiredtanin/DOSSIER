// [173] Modelldarstellung: Liste (neu/duplizieren/umbenennen/löschen), Optionen setzen/„wie Basis",
// Wahl in der Werkzeugleiste (Ebenen-Feld), Wirkung im Grundriss über den Kern.
import { describe, expect, it } from "vitest";
import { applyOps } from "../core/ops";
import { sampleProject } from "../model/sampleProject";
import type { Project } from "../model/types";
import { generatePlan } from "../plan/generatePlan";
import { computeSection, generateSectionPlan } from "../plan/toSection";
import { generateElevationPlan } from "../plan/toElevation";
import { de } from "../i18n/de";
import { en } from "../i18n/en";
import { standardModelViews } from "../model/standards";
import {
  addModelViewOps,
  adoptModelViewOps,
  currentModelViewId,
  deleteModelViewOps,
  duplicateModelViewOps,
  fieldValue,
  MODEL_VIEW_FIELDS,
  modelViewBase,
  modelViewChoices,
  newModelView,
  parseFieldValue,
  renameModelViewOps,
  selectModelViewOps,
  setModelViewBaseOps,
  setModelViewOptionOps,
  uniqueModelViewName,
} from "./modelViews";

function withMv(): Project {
  return applyOps(sampleProject, addModelViewOps(newModelView("mv1", "Werkplan", "fein")));
}

describe("modelViews", () => {
  it("Auswahl: eingebaute Stufen zuerst, dann die eigenen", () => {
    const p = withMv();
    expect(modelViewChoices(p.modelViewOptions).map((c) => c.id)).toEqual(["grob", "mittel", "fein", "mv1"]);
    expect(modelViewBase(p, "grob")).toBe("grob");
    expect(modelViewBase(p, "mv1")).toBe("fein");
    expect(modelViewBase(p, "gibts-nicht")).toBeUndefined();
  });

  it("Wahl an der Ebene: eigene Stufe setzt das Feld, eingebaute entfernt es", () => {
    const p = withMv();
    const lvl = (q: Project) => q.drawingLevels.find((l) => l.id === "eg")!;
    expect(currentModelViewId(lvl(p), "mittel", p.modelViewOptions)).toBe("mittel");
    const q = applyOps(p, selectModelViewOps(p, "eg", "mv1"));
    expect(lvl(q).modelViewOptionId).toBe("mv1");
    expect(currentModelViewId(lvl(q), "mittel", q.modelViewOptions)).toBe("mv1");
    const r = applyOps(q, selectModelViewOps(q, "eg", "grob"));
    expect("modelViewOptionId" in lvl(r)).toBe(false);
    expect(currentModelViewId(lvl(r), "fein", r.modelViewOptions)).toBe("fein");
    expect(selectModelViewOps(p, "eg", "gibts-nicht")).toEqual([]);
  });

  it("Option setzen und „wie Basis“ entfernt Feld und leeren Abschnitt", () => {
    const p = withMv();
    const q = applyOps(p, setModelViewOptionOps(p, "mv1", "doors", "lintelLineStyle", "keine"));
    expect(q.modelViewOptions![0].doors).toEqual({ lintelLineStyle: "keine" });
    const f = MODEL_VIEW_FIELDS.find((x) => x.key === "lintelLineStyle")!;
    expect(fieldValue(q.modelViewOptions![0], f)).toBe("keine");
    const r = applyOps(q, setModelViewOptionOps(q, "mv1", "doors", "lintelLineStyle", undefined));
    expect(r.modelViewOptions![0].doors).toBeUndefined();
    expect(parseFieldValue(MODEL_VIEW_FIELDS.find((x) => x.key === "frame")!, "false")).toBe(false);
    expect(parseFieldValue(MODEL_VIEW_FIELDS.find((x) => x.key === "swingAngle")!, "45")).toBe(45);
    expect(parseFieldValue(f, "")).toBeUndefined();
    const b = applyOps(r, setModelViewBaseOps(r, "mv1", undefined));
    expect("baseDetail" in b.modelViewOptions![0]).toBe(false);
  });

  it("duplizieren, umbenennen, löschen (Ebenen fallen auf den Detailgrad zurück)", () => {
    let p = withMv();
    p = applyOps(p, setModelViewOptionOps(p, "mv1", "stairs", "walkLine", false));
    p = applyOps(p, duplicateModelViewOps(p, "mv1", "mv2", uniqueModelViewName(p.modelViewOptions, "Werkplan")));
    expect(p.modelViewOptions!.map((m) => [m.id, m.name])).toEqual([["mv1", "Werkplan"], ["mv2", "Werkplan 2"]]);
    expect(p.modelViewOptions![1].stairs).toEqual({ walkLine: false });
    p = applyOps(p, duplicateModelViewOps(p, "grob", "mv3", "Aus grob"));
    expect(p.modelViewOptions![2]).toEqual({ id: "mv3", name: "Aus grob", baseDetail: "grob" });
    p = applyOps(p, renameModelViewOps(p, "mv2", "Eingabe"));
    expect(p.modelViewOptions![1].name).toBe("Eingabe");
    p = applyOps(p, selectModelViewOps(p, "eg", "mv1"));
    p = applyOps(p, deleteModelViewOps(p, "mv1"));
    expect(p.modelViewOptions!.map((m) => m.id)).toEqual(["mv2", "mv3"]);
    expect(p.drawingLevels.find((l) => l.id === "eg")!.modelViewOptionId).toBeUndefined();
  });

  it("Grundriss: Sturzlinie „keine“ der Stufe an der Ebene wirkt im Kern; ohne Stufe wie heute", () => {
    const codes = new Set(sampleProject.layers.flatMap(function all(c): string[] {
      return [c.code, ...(c.children ?? []).flatMap(all)];
    }));
    const lintels = (p: Project) => generatePlan(p, "eg", codes, undefined, "mittel", false, false, true, 50).primitives.filter((q) => q.kind === "line" && q.cls === "door-lintel").length;
    const heute = lintels(sampleProject);
    expect(heute).toBeGreaterThan(0);
    let p = withMv();
    p = applyOps(p, setModelViewOptionOps(p, "mv1", "doors", "lintelLineStyle", "keine"));
    expect(lintels(p)).toBe(heute);
    p = applyOps(p, selectModelViewOps(p, "eg", "mv1"));
    expect(lintels(p)).toBe(0);
  });

  it("[173] Etappe 2: jede Option und jeder Wert hat einen Text (de, en)", () => {
    for (const f of MODEL_VIEW_FIELDS) {
      const keys = [`resources.modelViews.section.${f.section}`, `resources.modelViews.opt.${f.section}.${f.key}`];
      if (Array.isArray(f.values) && typeof f.values[0] === "string") keys.push(...f.values.map((v) => `resources.modelViews.val.${v}`));
      for (const k of keys) {
        expect(de, k).toHaveProperty([k]);
        expect(en, k).toHaveProperty([k]);
      }
    }
  });

  it("[173] Etappe 2: Schnitt und Ansicht folgen der Stufe der Ebene; ohne Stufe wie heute", async () => {
    const wallPolys = async (p: Project) => {
      const out = await computeSection(p, p.drawingLevels.find((l) => l.id === "schnitt-a")!);
      return generateSectionPlan(out!, false, { scaleDenominator: 50 }).primitives.filter((q) => q.kind === "polygon" && !!q.wallId).length;
    };
    const heute = await wallPolys(sampleProject);
    let p = withMv();
    p = applyOps(p, setModelViewOptionOps(p, "mv1", "walls", "layers", "core"));
    expect(await wallPolys(p)).toBe(heute);
    p = applyOps(p, selectModelViewOps(p, "schnitt-a", "mv1"));
    expect(await wallPolys(p)).toBeLessThan(heute);
    // Ansicht: Schatten aus der Stufe, solange die Ebene keinen Wert setzt (Musterhaus: Ebene mit Schatten).
    const noShadow = (q: Project): Project => ({ ...q, drawingLevels: q.drawingLevels.map((l) => (l.id === "ansicht-sued" ? { ...l, shadows: undefined } : l)) });
    const elev = (q: Project) => JSON.stringify(generateElevationPlan(q, q.drawingLevels.find((l) => l.id === "ansicht-sued")!)?.primitives.length);
    const ohne = elev(noShadow(sampleProject));
    expect(ohne).not.toBe(elev(sampleProject));
    // [184] Basis „mittel" wie der Massstab des Musterhauses (fein zeichnet in der Ansicht zusätzlich die Fensterbank).
    let e = noShadow(applyOps(sampleProject, addModelViewOps(newModelView("mv1", "Werkplan", "mittel"))));
    e = applyOps(e, setModelViewOptionOps(e, "mv1", "elevation", "shadows", true));
    e = applyOps(e, selectModelViewOps(e, "ansicht-sued", "mv1"));
    expect(elev(e)).toBe(elev(sampleProject));
  });

  it("[173] Etappe 3: Vorlagen aus den Standards übernehmen; wirken auf Raumstempel und Treppe", () => {
    const lib = standardModelViews(sampleProject);
    expect(lib.map((m) => m.id)).toEqual(["std-mv-wettbewerb-200", "std-mv-baueingabe-100", "std-mv-ausfuehrung-50", "std-mv-situation-wbw", "std-mv-schwarzplan", "std-mv-rohbau"]);
    let p = applyOps(sampleProject, adoptModelViewOps(sampleProject, lib[2]!));
    expect(p.modelViewOptions?.map((m) => m.id)).toEqual(["std-mv-ausfuehrung-50"]);
    expect(adoptModelViewOps(p, lib[2]!)).toEqual([]);
    expect(standardModelViews(p).map((m) => m.id)).not.toContain("std-mv-ausfuehrung-50");
    const codes = new Set(p.layers.flatMap(function all(c): string[] {
      return [c.code, ...(c.children ?? []).flatMap(all)];
    }));
    const stepNumbers = (q: Project) => generatePlan(q, "eg", codes, undefined, "fein", false, false, true, 50).primitives.filter((x) => x.kind === "drawingText" && /^\d+$/.test(x.text)).length;
    const heute = stepNumbers(p);
    p = applyOps(p, selectModelViewOps(p, "eg", "std-mv-ausfuehrung-50"));
    expect(stepNumbers(p)).toBeGreaterThan(heute);
  });
});
