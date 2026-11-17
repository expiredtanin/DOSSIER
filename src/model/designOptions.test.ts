// [272] Varianten: Kombinationen lesen, Sätze/Varianten anlegen, Zuweisen/Kopieren/Übernehmen/Löschen über den Kern,
// Grundriss/Schnitt/3D/Kennzahlen je Kombination am Varianten-Beispiel, Vergleich und CSV, CLI-Kombination.

import { describe, expect, it } from "vitest";
import { applyOps } from "../core/ops";
import {
  acceptDesignOptionOps, addDesignOptionOps, addDesignOptionSetOps, assignDesignOptionOps, combinationLabel, combinationSpec, combinationSuffix, commonDesignOption,
  compareDesignOptions, compareDesignOptionsCsv, copyToDesignOptionOps, deleteDesignOptionOps, levelCombination, nextOptionName, parseCombination, projectWithCombination,
  resolveCombination, setLevelCombinationOps, setPrimaryOptionOps, showsInCombination,
  addCombinationOps, assignCombinationOps, combinationChoice, deleteCombinationOps, designOptionCombinations, levelCombinationState, renameCombinationOps, setCombinationChoiceOps,
  storedChoice,
  DESIGN_OPTION_GHOST_FILL, designOptionEditArg, designOptionLocked, eyeClick, penClick, unlockedSelection, visibleOption,
} from "./designOptions";
import { viewportDesignOptions } from "../plan/viewportPlan";
import { viewportVariantSuffix } from "./posterTemplates";
import { buildVariantenSampleProject } from "./sampleProjectVarianten";
import { sampleProject } from "./sampleProject";
import { generatePlan } from "../plan/generatePlan";
import { computeKennzahlen } from "../analysis/kennzahlen";
import { projectToModel3d, projectToModel3dParts } from "../plan/toWalls3d";
import { withDocument } from "../core/document";
import type { Project } from "./types";

const ALL = new Set(["20", "21", "30", "31", "40", "60"]);

/** Ids der Öffnungen/Dächer im Grundriss des OG bzw. EG einer Projekt-Fassung. */
function planIds(p: Project, level: string): Set<string> {
  return withDocument(p, () => {
    const out = new Set<string>();
    for (const x of generatePlan(p, level, ALL).primitives) {
      const r = x as { openingId?: string; roofId?: string };
      if (r.openingId) out.add(r.openingId);
      if (r.roofId) out.add(r.roofId);
    }
    return out;
  });
}

describe("[272] Varianten", () => {
  it("Kombination: Hauptvarianten, gespeicherte Wahl, Namen, Text", () => {
    const p = buildVariantenSampleProject();
    expect(resolveCombination(p)).toEqual({ dachform: "a", fassade: "a" });
    expect(resolveCombination(p, { dachform: "b", weg: "x" }, { fassade: "z" })).toEqual({ dachform: "b", fassade: "a" });
    expect(combinationLabel(p, { dachform: "b", fassade: "a" })).toBe("Dachform B Satteldach, Fassade A Lochfenster");
    expect(combinationSuffix(p, { dachform: "b", fassade: "a" })).toBe("Dachform B Satteldach");
    expect(combinationSuffix(p, {})).toBe("");
    expect(parseCombination(p, "dachform=b satteldach; Fassade = B Bandfenster, Unsinn")).toEqual({ dachform: "b", fassade: "b" });
    expect(combinationSpec(p, { dachform: "b" })).toBe("Dachform=B Satteldach");
    expect(showsInCombination({ dachform: "a" }, { set: "dachform", option: "b" })).toBe(false);
    expect(showsInCombination({ dachform: "a" }, undefined)).toBe(true);
    expect(showsInCombination({ dachform: "a" }, { set: "weg", option: "b" })).toBe(true);
  });

  it("Sätze und Varianten anlegen, Hauptvariante, Kombination der Ebene (ohne Hauptvariante gespeichert)", () => {
    const { ops, id } = addDesignOptionSetOps(sampleProject, "Dachform");
    let p = applyOps(sampleProject, ops);
    expect(p.designOptionSets?.[0]).toMatchObject({ id, name: "Dachform", primary: "a" });
    p = applyOps(p, addDesignOptionOps(p, id));
    expect(p.designOptionSets?.[0].options.map((o) => o.name)).toEqual(["A", "B", "C"]);
    expect(nextOptionName(p.designOptionSets?.[0])).toBe("D");
    p = applyOps(p, setLevelCombinationOps(p, "eg", id, "b"));
    expect(p.drawingLevels.find((l) => l.id === "eg")?.designOptions).toEqual({ [id]: "b" });
    expect(levelCombination(p, p.drawingLevels.find((l) => l.id === "eg"))[id]).toBe("b");
    p = applyOps(p, setLevelCombinationOps(p, "eg", id, "a"));
    expect(p.drawingLevels.find((l) => l.id === "eg")).not.toHaveProperty("designOptions");
    p = applyOps(p, setPrimaryOptionOps(p, id, "b"));
    expect(p.designOptionSets?.[0].primary).toBe("b");
    expect(setPrimaryOptionOps(p, id, "zz")).toHaveLength(0);
  });

  it("Grundriss je Kombination: Dächer und Fenster der anderen Variante fehlen", () => {
    const p = buildVariantenSampleProject();
    const a = planIds(p, "eg");
    expect(a.has("O2")).toBe(true);
    expect(a.has("O-band")).toBe(false);
    const q = applyOps(p, setLevelCombinationOps(p, "eg", "fassade", "b"));
    const b = planIds(q, "eg");
    expect(b.has("O2")).toBe(false);
    expect(b.has("O-band")).toBe(true);
  });

  it("3D und Kennzahlen je Kombination; Teil-Cache aus bei Varianten", () => {
    const p = buildVariantenSampleProject();
    withDocument(p, () => {
      expect(projectToModel3dParts(p)).toBeNull();
      const roofs = (opts?: Record<string, string>) => JSON.stringify(projectToModel3d(p, opts ? { hide: { designOptions: opts } } : {}));
      expect(roofs()).not.toEqual(roofs({ dachform: "b" }));
    });
    const ka = withDocument(p, () => computeKennzahlen(p));
    const pb = projectWithCombination(p, { dachform: "b" });
    const kb = withDocument(pb, () => computeKennzahlen(pb));
    expect(ka.gv).not.toBeCloseTo(kb.gv, 3);
  });

  it("Vergleich: alle Kombinationen, Hauptkombination zuerst, CSV mit Kopf", () => {
    const p = buildVariantenSampleProject();
    const rows = withDocument(p, () => compareDesignOptions(p, "", true));
    expect(rows).toHaveLength(4);
    expect(rows[0].primary).toBe(true);
    expect(rows[0].label).toBe("Dachform A Flachdach, Fassade A Lochfenster");
    expect(new Set(rows.map((r) => r.gv)).size).toBeGreaterThan(1);
    expect(rows.every((r) => Number.isFinite(r.cost) && r.cost > 0)).toBe(true);
    const csv = withDocument(p, () => compareDesignOptionsCsv(p, ["Kombination", "GF", "HNF", "GV", "Fussabdruck", "AZ", "ÜZ", "Kosten"], "", true));
    expect(csv.split("\n")[0]).toBe("Kombination;GF;HNF;GV;Fussabdruck;AZ;ÜZ;Kosten");
    expect(csv.trim().split("\n")).toHaveLength(5);
    expect(compareDesignOptions(sampleProject)).toEqual([]);
  });

  it("Zuweisen (Mehrfachauswahl, ein Schritt), gemeinsamer Wert, Kopieren, Übernehmen, Löschen", () => {
    const p = buildVariantenSampleProject();
    withDocument(p, () => {
      const ops = assignDesignOptionOps(p, ["W1", "W2", "nix"], { set: "fassade", option: "b" });
      expect(ops).toHaveLength(2);
      const q = applyOps(p, ops);
      expect(commonDesignOption(q, ["W1", "W2"])).toBe("fassade/b");
      expect(commonDesignOption(q, ["W1", "W3"])).toBe("mixed");
      expect(commonDesignOption(q, ["W3"])).toBe("");
      const copy = copyToDesignOptionOps(p, ["W3"], { set: "fassade", option: "b" }, "k");
      const c = applyOps(p, copy);
      const w = c.walls.find((x) => x.id.startsWith("k-"));
      expect(w?.designOption).toEqual({ set: "fassade", option: "b" });
      expect((c.openings ?? []).filter((o) => o.hostWallId === w?.id).length).toBeGreaterThan(0);
    });
    // Übernehmen: B Satteldach bleibt (ohne Variante), Flachdach weg, Satz weg.
    const acc = withDocument(p, () => applyOps(p, acceptDesignOptionOps(p, "dachform", "b")));
    expect(acc.roofs?.map((r) => r.id)).toEqual(["RF1"]);
    expect(acc.roofs?.[0]).not.toHaveProperty("designOption");
    expect(acc.designOptionSets?.map((s) => s.id)).toEqual(["fassade"]);
    // Satz löschen: alle Fenster beider Fassaden-Varianten weg.
    const del = withDocument(p, () => applyOps(p, deleteDesignOptionOps(p, "fassade")));
    expect((del.openings ?? []).some((o) => o.id === "O2" || o.id === "O-band")).toBe(false);
  });

  it("CLI-Kombination: gewählte Varianten werden Hauptvarianten, gespeicherte Wahlen entfallen", () => {
    const p0 = buildVariantenSampleProject();
    const p = { ...p0, drawingLevels: p0.drawingLevels.map((l) => (l.id === "eg" ? { ...l, designOptions: { dachform: "a", fassade: "b" } } : l)) };
    const q = projectWithCombination(p, { dachform: "b" });
    expect(q.designOptionSets?.find((s) => s.id === "dachform")?.primary).toBe("b");
    expect(q.drawingLevels.find((l) => l.id === "eg")?.designOptions).toEqual({ fassade: "b" });
    expect(projectWithCombination(p, {})).toBe(p);
  });
});

describe("[272] Benannte Variantenkombinationen", () => {
  it("Beispiel hat zwei Kombinationen; Vergleich je Kombination (Name als Zeilentitel), alle über `all`", () => {
    const p = buildVariantenSampleProject();
    expect(designOptionCombinations(p).map((c) => c.name)).toEqual(["Studie 1 Flachdach/Lochfenster", "Studie 2 Satteldach/Bandfenster"]);
    const rows = withDocument(p, () => compareDesignOptions(p));
    expect(rows.map((r) => r.label)).toEqual(["Studie 1 Flachdach/Lochfenster", "Studie 2 Satteldach/Bandfenster"]);
    expect(rows[0].primary).toBe(true);
    expect(rows[1].detail).toBe("Dachform B Satteldach, Fassade B Bandfenster");
    expect(rows[0].gv).not.toBeCloseTo(rows[1].gv, 3);
    const csv = withDocument(p, () => compareDesignOptionsCsv(p, ["Kombination", "GF", "HNF", "GV", "Fussabdruck", "AZ", "ÜZ", "Kosten"]));
    expect(csv.split("\n")[1].startsWith("Studie 1 Flachdach/Lochfenster;")).toBe(true);
    expect(withDocument(p, () => compareDesignOptions(p, "", true))).toHaveLength(4);
  });

  it("Speichern, umbenennen, Wahl ändern, löschen (ein Undo-Schritt im Kern); fehlende Sätze zeigen die Hauptvariante", () => {
    const p0 = buildVariantenSampleProject();
    const base = { ...p0, designOptionCombinations: undefined } as typeof p0;
    delete (base as { designOptionCombinations?: unknown }).designOptionCombinations;
    const { ops, id } = addCombinationOps(base, "Studie A", { dachform: "b" });
    let p = applyOps(base, ops);
    expect(p.designOptionCombinations?.[0]).toMatchObject({ id, name: "Studie A", choices: { dachform: "b", fassade: "a" } });
    p = applyOps(p, renameCombinationOps(p, id, "Satteldach"));
    p = applyOps(p, setCombinationChoiceOps(p, id, "fassade", "b"));
    expect(combinationChoice(p, p.designOptionCombinations![0])).toEqual({ dachform: "b", fassade: "b" });
    expect(setCombinationChoiceOps(p, id, "fassade", "zz")).toHaveLength(0);
    // Eine Kombination mit fehlendem Satz zeigt dort die Hauptvariante.
    const miss = { ...p, designOptionCombinations: [{ id: "m", name: "M", choices: { dachform: "b" } }] };
    expect(combinationChoice(miss, miss.designOptionCombinations[0])).toEqual({ dachform: "b", fassade: "a" });
    // Zuweisen an eine Ebene, danach Löschen räumt den Verweis auf.
    p = applyOps(p, assignCombinationOps(p, "eg", id));
    const eg = () => p.drawingLevels.find((l) => l.id === "eg")!;
    expect(eg().designOptionCombination).toBe(id);
    expect(levelCombinationState(p, eg())).toMatchObject({ kind: "named", name: "Satteldach", assigned: true });
    p = withDocument(p, () => applyOps(p, deleteCombinationOps(p, id)));
    expect(p.designOptionCombinations).toEqual([]);
    expect(eg()).not.toHaveProperty("designOptionCombination");
  });

  it("Rangfolge: Kombination vor freier Wahl; „Eigene“ nach Änderung; gleiche Wahl erkennt den Namen", () => {
    const p0 = buildVariantenSampleProject();
    // Studie 2 zugewiesen ⇒ Dach B und Fassade B im Grundriss/Wahl.
    let p = applyOps(p0, assignCombinationOps(p0, "eg", "studie-2"));
    expect(storedChoice(p, p.drawingLevels.find((l) => l.id === "eg"))).toEqual({ dachform: "b", fassade: "b" });
    expect(levelCombination(p, p.drawingLevels.find((l) => l.id === "eg"))).toEqual({ dachform: "b", fassade: "b" });
    const ids = planIds(p, "eg");
    expect(ids.has("O-band")).toBe(true);
    expect(ids.has("O2")).toBe(false);
    // Wahl der zugewiesenen Kombination ändern: der Grundriss folgt sofort (kein Cache-Rest).
    const edited = applyOps(p, setCombinationChoiceOps(p, "studie-2", "fassade", "a"));
    expect(planIds(edited, "eg").has("O2")).toBe(true);
    expect(planIds(edited, "eg").has("O-band")).toBe(false);
    // Eine Wahländerung löst den Verweis: „Eigene“ (Fassade A + Dach B passt zu keiner gespeicherten Kombination).
    p = applyOps(p, setLevelCombinationOps(p, "eg", "fassade", "a"));
    const l = p.drawingLevels.find((x) => x.id === "eg")!;
    expect(l).not.toHaveProperty("designOptionCombination");
    expect(l.designOptions).toEqual({ dachform: "b" });
    expect(levelCombinationState(p, l).kind).toBe("custom");
    // Zurück zur Wahl von Studie 2 ohne Verweis: gleicher Name (nicht zugewiesen).
    p = applyOps(p, setLevelCombinationOps(p, "eg", "fassade", "b"));
    expect(levelCombinationState(p, p.drawingLevels.find((x) => x.id === "eg")!)).toMatchObject({ kind: "named", name: "Studie 2 Satteldach/Bandfenster", assigned: false });
    // Verweis lösen behält die Wahl als freie Wahl.
    const q = applyOps(p0, [...assignCombinationOps(p0, "eg", "studie-2"), ...[]]);
    const r = applyOps(q, assignCombinationOps(q, "eg", null));
    expect(r.drawingLevels.find((x) => x.id === "eg")?.designOptions).toEqual({ dachform: "b", fassade: "b" });
    // Unbekannte Kombination: keine Ops.
    expect(assignCombinationOps(p0, "eg", "weg")).toHaveLength(0);
  });

  it("Viewport/Ausschnitt: Kombination, Titelzusatz = Kombinationsname", () => {
    const p = buildVariantenSampleProject();
    const snap = { id: "s", name: "EG", activeLevelId: "eg" } as never;
    expect(viewportDesignOptions(p, snap, { designOptionCombination: "studie-2" })).toEqual({ dachform: "b", fassade: "b" });
    // Viewport vor Ausschnitt; freie Wahl des Viewports wird bei Kombination übergangen.
    expect(viewportDesignOptions(p, { designOptionCombination: "studie-1" }, { designOptions: { dachform: "b" }, designOptionCombination: "studie-1" })).toEqual({ dachform: "a", fassade: "a" });
    const q = { ...p, viewSnapshots: [{ id: "s", name: "EG", activeLevelId: "eg", designOptionCombination: "studie-1" }] } as never as typeof p;
    const vp = { id: "v", snapshotId: "s", designOptionCombination: "studie-2" } as never;
    expect(viewportVariantSuffix(q, vp)).toBe("Studie 2 Satteldach/Bandfenster");
    expect(viewportVariantSuffix(q, { id: "v2", snapshotId: "s" } as never)).toBe("Studie 1 Flachdach/Lochfenster");
    expect(viewportVariantSuffix({ ...q, viewSnapshots: [{ id: "s", name: "EG", activeLevelId: "eg" }] } as never, { id: "v2", snapshotId: "s" } as never)).toBe("");
    expect(viewportVariantSuffix(q, { id: "v3", snapshotId: "s", designOptions: { dachform: "b", fassade: "b" } } as never)).toBe("Studie 2 Satteldach/Bandfenster");
  });

  it("CLI-Kombination: benannte Kombination wird Hauptkombination, Verweise lösen sich auf", () => {
    const p0 = buildVariantenSampleProject();
    const p = applyOps(p0, assignCombinationOps(p0, "eg", "studie-2"));
    const q = projectWithCombination(p, combinationChoice(p, p.designOptionCombinations![0]));
    expect(q.designOptionSets?.map((s) => s.primary)).toEqual(["a", "a"]);
    expect(q.drawingLevels.find((l) => l.id === "eg")).not.toHaveProperty("designOptionCombination");
    expect(q.drawingLevels.find((l) => l.id === "eg")).not.toHaveProperty("designOptions");
    const q2 = projectWithCombination(p, { dachform: "a" });
    expect(q2.drawingLevels.find((l) => l.id === "eg")?.designOptions).toEqual({ fassade: "b" });
  });
});

describe("[272] Varianten bearbeiten wie Archicad (Auge, Stift, grau, sperren)", () => {
  const dach = (option: string) => ({ set: "dachform", option });

  it("Bearbeitungsvariante der Bildschirm-Anfrage: nur mit Stift und bekannter Variante", () => {
    const p = buildVariantenSampleProject();
    expect(designOptionEditArg(p, null, true)).toBeNull();
    expect(designOptionEditArg(p, { set: "dachform", option: "zz" }, true)).toBeNull();
    expect(designOptionEditArg(p, dach("b"), true)).toEqual({ set: "dachform", option: "b", grey: true });
    expect(designOptionEditArg(p, dach("b"), false)).toEqual({ set: "dachform", option: "b", grey: false });
  });

  it("Auge: sichtbare Variante je Satz (Stift geht vor); Klick schaltet die Ebene um, im Stift-Satz endet die Bearbeitung", () => {
    const p = buildVariantenSampleProject();
    const eg = p.drawingLevels.find((l) => l.id === "eg");
    expect(visibleOption(p, eg, null, "dachform")).toBe("a");
    expect(visibleOption(p, eg, dach("b"), "dachform")).toBe("b");
    expect(visibleOption(p, eg, dach("b"), "fassade")).toBe(levelCombination(p, eg).fassade);
    // Auge in einem anderen Satz: Ebene wechselt, Stift bleibt.
    const other = eyeClick(p, "eg", dach("b"), "fassade", "b");
    expect(other.draw).toEqual(dach("b"));
    const q = applyOps(p, other.ops);
    expect(levelCombination(q, q.drawingLevels.find((l) => l.id === "eg")).fassade).toBe("b");
    // Auge im Satz des Stifts auf eine andere Variante: Bearbeitung endet (Stift impliziert Auge).
    const same = eyeClick(p, "eg", dach("b"), "dachform", "a");
    expect(same.draw).toBeNull();
    // Auge auf die bearbeitete Variante: nichts zu tun.
    expect(eyeClick(p, "eg", dach("b"), "dachform", "b")).toEqual({ draw: dach("b"), ops: [] });
  });

  it("Stift: setzt die Bearbeitungsvariante, zweiter Klick zurück aufs Hauptmodell (kein Undo-Schritt)", () => {
    const p = buildVariantenSampleProject();
    expect(penClick(p, null, "dachform", "b")).toEqual(dach("b"));
    expect(penClick(p, dach("b"), "dachform", "b")).toBeNull();
    expect(penClick(p, dach("b"), "fassade", "a")).toEqual({ set: "fassade", option: "a" });
    expect(penClick(p, null, "dachform", "zz")).toBeNull();
  });

  it("Sperren: ausserhalb der Bearbeitungsvariante nicht wählbar (Öffnung folgt ihrer Wand), ohne Stift nichts gesperrt", () => {
    const p = buildVariantenSampleProject();
    const main = p.walls.find((w) => !w.designOption)!;
    const roofB = (p.roofs ?? []).find((r) => r.designOption?.option === "b" && r.designOption.set === "dachform")!;
    const roofA = (p.roofs ?? []).find((r) => r.designOption?.option === "a" && r.designOption.set === "dachform")!;
    expect(designOptionLocked(p, dach("b"), "walls", main.id)).toBe(true);
    expect(designOptionLocked(p, dach("b"), "roofs", roofB.id)).toBe(false);
    expect(designOptionLocked(p, dach("b"), "roofs", roofA.id)).toBe(true);
    expect(designOptionLocked(p, null, "walls", main.id)).toBe(false);
    // Öffnung ohne eigene Variante in einer Wand der Variante: frei.
    const q: Project = { ...p, walls: p.walls.map((w) => (w.id === main.id ? { ...w, designOption: dach("b") } : w)) };
    const o = (q.openings ?? []).find((x) => x.hostWallId === main.id && !x.designOption);
    expect(o).toBeDefined();
    expect(designOptionLocked(q, dach("b"), "openings", o!.id)).toBe(false);
    expect(designOptionLocked(p, dach("b"), "openings", o!.id)).toBe(true);
    // Schnittlinien und Gruppen bleiben wählbar; Auswahl gefiltert.
    expect(designOptionLocked(p, dach("b"), "sectionLines", "schnitt-a")).toBe(false);
    expect(unlockedSelection(p, dach("b"), { walls: [main.id], roofs: [roofB.id, roofA.id] })).toEqual({ walls: [], roofs: [roofB.id] });
    expect(unlockedSelection(p, null, { walls: [main.id] })).toEqual({ walls: [main.id] });
  });

  it("Grau nur in der Bildschirm-Anfrage: Hauptmodell grau, bearbeitete Variante nicht, Druck unverändert", () => {
    const p = buildVariantenSampleProject();
    const fills = (edit: ReturnType<typeof designOptionEditArg>) =>
      withDocument(p, () => {
        const plan = generatePlan(p, "eg", ALL, undefined, "mittel", false, false, true, 100, false, false, null, null, edit);
        return plan.primitives.filter((x) => x.kind === "polygon" && (x as { wallId?: string }).wallId).map((x) => (x as { fill: string }).fill);
      });
    expect(fills(null)).not.toContain(DESIGN_OPTION_GHOST_FILL);
    expect(fills(designOptionEditArg(p, dach("b"), true))).toContain(DESIGN_OPTION_GHOST_FILL);
    expect(fills(designOptionEditArg(p, dach("b"), false))).not.toContain(DESIGN_OPTION_GHOST_FILL);
  });
});
