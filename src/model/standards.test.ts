import { describe, expect, it } from "vitest";
import { emptyProject, sampleProject } from "./sampleProject";
import { standardsMergeOps, withStandards } from "./standards";

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
});
