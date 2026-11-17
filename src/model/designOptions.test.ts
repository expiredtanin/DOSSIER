// [272] Varianten: Kombinationen lesen, Sätze/Varianten anlegen, Zuweisen/Kopieren/Übernehmen/Löschen über den Kern,
// Grundriss/Schnitt/3D/Kennzahlen je Kombination am Varianten-Beispiel, Vergleich und CSV, CLI-Kombination.

import { describe, expect, it } from "vitest";
import { applyOps } from "../core/ops";
import {
  acceptDesignOptionOps, addDesignOptionOps, addDesignOptionSetOps, assignDesignOptionOps, combinationLabel, combinationSpec, combinationSuffix, commonDesignOption,
  compareDesignOptions, compareDesignOptionsCsv, copyToDesignOptionOps, deleteDesignOptionOps, levelCombination, nextOptionName, parseCombination, projectWithCombination,
  resolveCombination, setLevelCombinationOps, setPrimaryOptionOps, showsInCombination,
} from "./designOptions";
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
    const rows = withDocument(p, () => compareDesignOptions(p));
    expect(rows).toHaveLength(4);
    expect(rows[0].primary).toBe(true);
    expect(rows[0].label).toBe("Dachform A Flachdach, Fassade A Lochfenster");
    expect(new Set(rows.map((r) => r.gv)).size).toBeGreaterThan(1);
    expect(rows.every((r) => Number.isFinite(r.cost) && r.cost > 0)).toBe(true);
    const csv = withDocument(p, () => compareDesignOptionsCsv(p, ["Kombination", "GF", "HNF", "GV", "Fussabdruck", "AZ", "ÜZ", "Kosten"]));
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
