import { describe, expect, it } from "vitest";
import { emptyProject, sampleProject } from "./sampleProject";
import { standardsChangeKey, standardsMergeCounts, standardsMergeOps, standardsUpdateOps, standardsUpdatePlan, withStandards } from "./standards";
import { applyOps } from "../core/ops";

describe("Standard-Bibliothek ([100]–[102])", () => {
  it("bringt Baustoffe, Linientypen und Aufbauten in ein neues Projekt", () => {
    const p = withStandards({ ...emptyProject, components: [], hatches: [], lineStyles: [], wallTypes: [], ceilingTypes: [], roofTypes: [] });
    const stb = p.components.find((c) => c.name === "Stahlbeton")!;
    expect(stb.lambda).toBe(2.3);
    expect(stb.fireClass).toBe("RF1");
    expect(p.hatches.some((h) => h.id === stb.hatchId)).toBe(true);
    expect(p.components.find((c) => c.name === "Backstein")!.surfacePattern?.kind).toBe("runningBond");
    expect(p.lineStyles.find((l) => l.name === "Strichpunktlinie (Achse)")!.dash).toEqual([12, 1.5, 0, 1.5]);
    expect(p.wallTypes.map((t) => t.name)).toContain("Holzständerwand hinterlüftet");
    expect(p.ceilingTypes?.length).toBe(1);
    expect(p.roofTypes?.length).toBe(1);
    expect(standardsMergeOps(p)).toEqual([]);
  });

  it("verdoppelt im bestehenden Projekt nichts und nutzt gleichnamige Einträge", () => {
    const p = withStandards(sampleProject);
    const names = p.components.map((c) => c.name.toLowerCase());
    expect(names.filter((n) => n === "backstein").length).toBe(1);
    // Beispiel-Bauteil „Backstein" (id brick) bleibt und wird vom Standard-Aufbau benutzt
    const iw = p.wallTypes.find((t) => t.id === "std-wt-iw-backstein")!;
    expect(iw.layers[1].componentId).toBe("brick");
    expect(p.components.length).toBeGreaterThan(sampleProject.components.length);
    expect(standardsMergeOps(p)).toEqual([]);
  });

  it("zählt, was „Standards laden“ hinzufügt (Rückmeldung)", () => {
    const empty = { ...emptyProject, components: [], hatches: [], lineStyles: [], wallTypes: [], ceilingTypes: [], roofTypes: [] };
    const c = standardsMergeCounts(standardsMergeOps(empty));
    expect(c.components).toBe(34);
    expect(c.lineStyles).toBeGreaterThan(5);
    expect(c.wallTypes + c.ceilingTypes + c.roofTypes).toBe(5);
    expect(standardsMergeCounts(standardsMergeOps(withStandards(empty)))).toEqual({ lineStyles: 0, hatches: 0, components: 0, wallTypes: 0, ceilingTypes: 0, roofTypes: 0 });
  });

  it("Putz, Keramik und Faserzement haben eine Schraffur", () => {
    const p = withStandards({ ...emptyProject, components: [], hatches: [], lineStyles: [], wallTypes: [], ceilingTypes: [], roofTypes: [] });
    const hatchOf = (name: string) => p.hatches.find((h) => h.id === p.components.find((c) => c.name === name)!.hatchId)!;
    expect(hatchOf("Innenputz").pattern).toBe("dots");
    expect(hatchOf("Aussenputz").pattern).toBe("dots");
    expect(hatchOf("Keramikplatten").pattern).toBe("crosshatch");
    expect(hatchOf("Faserzementplatten").pattern).toBe("diagonal");
  });

  it("„Standards aktualisieren“: alte Definitionen auf heutigen Stand, Auswahl, ein Op-Satz", () => {
    const full = withStandards({ ...emptyProject, components: [], hatches: [], lineStyles: [], wallTypes: [], ceilingTypes: [], roofTypes: [] });
    expect(standardsUpdatePlan(full).changes).toEqual([]);
    // Stand 29.10.: EPS mit alter Schraffur, Putz ohne Schraffur, XPS umbenannt
    const old = {
      ...full,
      hatches: full.hatches.filter((h) => h.id !== "std-h-putz").map((h) => (h.id === "std-h-eps" ? { ...h, pattern: "insulation" as const } : h.id === "std-h-xps" ? { ...h, name: "Meine XPS", pattern: "diagonal" as const } : h)),
      components: full.components.map((c) => (c.id === "std-c-innenputz" ? { ...c, hatchId: "std-h-ohne" } : c)),
    };
    const plan = standardsUpdatePlan(old);
    expect(plan.added).toBe(1);
    expect(plan.changes.map((c) => c.id).sort()).toEqual(["std-c-innenputz", "std-h-eps", "std-h-xps"]);
    expect(plan.changes.find((c) => c.id === "std-h-xps")!.renamed).toBe(true);
    const selected = plan.changes.filter((c) => !c.renamed).map(standardsChangeKey);
    const after = applyOps(old, standardsUpdateOps(old, selected));
    expect(after.hatches.find((h) => h.id === "std-h-eps")!.pattern).toBe("insulationHard");
    expect(after.hatches.find((h) => h.id === "std-h-xps")!.pattern).toBe("diagonal");
    expect(after.components.find((c) => c.id === "std-c-innenputz")!.hatchId).toBe("std-h-putz");
    expect(standardsUpdatePlan(after).changes.map((c) => c.id)).toEqual(["std-h-xps"]);
  });
});
