// [180] Klassen im 3D: ausgeblendete Klassen (Ebenen-Baum bzw. Darstellungsmodus `hide`) fehlen im Modell, in den
// Teil-Updates des Viewers und in der Pick-Geometrie; Umschalten hält die Einträge des Kern-Caches (nichts neu).

import { describe, expect, it } from "vitest";
import type { Project } from "../model/types";
import { buildComplexSampleProject } from "../model/sampleProjectComplex";
import { emitSurfacePatternLines, hiddenClassCodes, pickGeometry, projectToModel3d, projectToModel3dParts } from "./toWalls3d";
import { documentFor } from "../core/document";
import { pickNearest, type Ray } from "../viewport/raycast3d";

const withLayer = (p: Project, code: string, visible: boolean): Project => ({
  ...p,
  layers: p.layers.map((c) => (c.code === code ? { ...c, visible } : c)),
});

describe("3D nach Klassen ([180])", () => {
  const p = buildComplexSampleProject();
  const roofs = (m: ReturnType<typeof projectToModel3d>) => m.roofLayers.length;

  it("Dächer aus: weder im Modell noch anwählbar; Wände bleiben", () => {
    const all = projectToModel3d(p);
    expect(roofs(all)).toBeGreaterThan(0);
    expect(pickGeometry(p).roofs.length).toBeGreaterThan(0);
    for (const [q, hide] of [
      [withLayer(p, "31", false), undefined],
      [p, ["31"]],
    ] as const) {
      const m = projectToModel3d(q, { hide });
      expect(roofs(m)).toBe(0);
      expect(m.walls.length).toBe(all.walls.length);
      expect(m.meshes.length).toBeLessThan(all.meshes.length);
      const g = pickGeometry(q, 0, hide);
      expect(g.roofs).toHaveLength(0);
      expect(g.walls.length).toBeGreaterThan(0);
      // Senkrechter Strahl auf die Dachmitte trifft kein Dach mehr.
      const t = pickGeometry(p).roofs[0].tris[0];
      const c = [0, 1, 2].map((i) => (t[0][i] + t[1][i] + t[2][i]) / 3);
      const ray: Ray = { origin: [c[0], 200, c[2]], dir: [0, -1, 0] };
      const hit = pickNearest(ray, g.walls, g.slabs, g.openings, g.stairs, g.roofs, g.contextMeshes, g.drawings, g.columns, g.solids, g.openingMeshes, g.stairMeshes, g.drawingMeshes, g.trees);
      expect(hit?.kind).not.toBe("roof");
    }
  });

  it("Wände aus: Wände, ihre Öffnungen und Wandmuster fehlen", () => {
    const m = projectToModel3d(p, { hide: ["20"] });
    expect(m.walls).toHaveLength(0);
    const g = pickGeometry(p, 0, ["20"]);
    expect(g.walls).toHaveLength(0);
    expect(g.openings).toHaveLength(0);
    expect(emitSurfacePatternLines(p, 0, ["20", "30", "31"]).length).toBe(0);
  });

  it("Teil-Updates: ausgeblendete Wand-Einträge bleiben gehalten, Einblenden schickt sie nicht neu", () => {
    const doc = documentFor(p);
    const all = projectToModel3dParts(p)!;
    const wallParts = all.filter((x) => x.id.startsWith("w"));
    expect(wallParts.length).toBeGreaterThan(0);
    const hidden = projectToModel3dParts(p, { hide: ["20"] })!;
    expect(hidden.filter((x) => x.id.startsWith("w"))).toHaveLength(0);
    // Wieder ein: dieselben unveränderlichen Teile (gleiche ids), ohne erneutes Ausschreiben im Kern.
    const spy = doc.queryJson.bind(doc);
    let delta = "";
    doc.queryJson = (name, args, text) => {
      const out = spy(name, args, text);
      if (name === "model3dPartsDelta") delta = out;
      return out;
    };
    try {
      const again = projectToModel3dParts(p)!;
      expect(again.filter((x) => x.id.startsWith("w")).map((x) => x.id)).toEqual(wallParts.map((x) => x.id));
      expect(JSON.parse(delta).wallNew).toHaveLength(0);
    } finally {
      doc.queryJson = spy;
    }
  });

  it("hiddenClassCodes: Elternklasse aus ⇒ Kinder aus; hide ergänzt", () => {
    const s = hiddenClassCodes(withLayer(p, "20", false), ["31"]);
    expect(s.has("20") && s.has("21") && s.has("31")).toBe(true);
    expect(s.has("30")).toBe(false);
  });
});
