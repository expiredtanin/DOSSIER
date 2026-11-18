// [285] Standardaufbauten neuer Projekte haben für jede Schicht eine Wärmeleitfähigkeit (sonst „U-Wert unvollständig“).
import { describe, expect, it } from "vitest";
import { emptyProject } from "./sampleProject";

describe("Wärmeleitfähigkeit der Standard-Baustoffe [285]", () => {
  it("jede Schicht aller Wand-/Decken-/Dachtypen hat λ > 0", () => {
    const types = [...emptyProject.wallTypes, ...(emptyProject.ceilingTypes ?? []), ...(emptyProject.roofTypes ?? [])];
    for (const t of types) {
      for (const l of t.layers) {
        const c = emptyProject.components.find((x) => x.id === l.componentId);
        expect(c?.lambda, `${t.name}: ${l.componentId}`).toBeGreaterThan(0);
      }
    }
  });
});
