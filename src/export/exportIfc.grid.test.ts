// [112] Achsraster → IfcGrid im IFC-Export (IFC4 und IFC2x3), Prüfung mit ifcopenshell, wenn installiert.

import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "../engine/fileioWasm.setup";
import { exportIfcSpf } from "./exportIfc";
import { sampleProject } from "../model/sampleProject";
import type { Drawing2D, Project } from "../model/types";

const hasIfcOpenShell = spawnSync("python3", ["-c", "import ifcopenshell, ifcopenshell.validate, _pytest"]).status === 0;

function gridProject(radial = false): Project {
  const floor = sampleProject.drawingLevels.find((l) => l.kind === "floor")!;
  const grid = {
    id: "grid-1",
    type: "drawing2d",
    levelId: floor.id,
    categoryCode: sampleProject.layers[0]?.code ?? "00",
    geom: radial
      ? { shape: "grid", origin: { x: 0, y: 0 }, angle: 0, radial: true, a: [{ label: "1", pos: 0 }, { label: "2", pos: 90 }], b: [{ label: "A", pos: 3 }, { label: "B", pos: 6 }] }
      : {
          shape: "grid",
          origin: { x: 1, y: 2 },
          angle: 0,
          a: [{ label: "1", pos: 0 }, { label: "2", pos: 5 }, { label: "3", pos: 9 }],
          b: [{ label: "A", pos: 0 }, { label: "B", pos: 4 }],
        },
  } as unknown as Drawing2D;
  return { ...sampleProject, drawings2d: [...sampleProject.drawings2d, grid] };
}

describe("IfcGrid im Export [112]", () => {
  it("IFC4: IfcGrid mit U-/V-Achsen und Beschriftung", () => {
    const ifc = exportIfcSpf(gridProject());
    expect(ifc).toMatch(/^#\d+=IFCGRID\(/m);
    const tags = [...ifc.matchAll(/^#\d+=IFCGRIDAXIS\('([^']*)'/gm)].map((m) => m[1]);
    expect(tags).toEqual(["1", "2", "3", "A", "B"]);
    // UAxes = 3, VAxes = 2.
    const g = ifc.match(/^#\d+=IFCGRID\(.*,\((#\d+(?:,#\d+)*)\),\((#\d+(?:,#\d+)*)\),\$\);$/m)!;
    expect(g[1].split(",")).toHaveLength(3);
    expect(g[2].split(",")).toHaveLength(2);
  });

  it("ohne Raster kein IfcGrid; IFC2x3 ebenfalls", () => {
    expect(exportIfcSpf(sampleProject)).not.toContain("IFCGRID(");
    expect(exportIfcSpf(gridProject(), { schema: "IFC2X3" })).toMatch(/^#\d+=IFCGRID\(/m);
  });

  it.skipIf(!hasIfcOpenShell)("ifcopenshell: gültig, Achsen lesbar (rechtwinklig und radial)", () => {
    for (const [name, p] of [["ortho", gridProject()], ["radial", gridProject(true)]] as const) {
      const dir = mkdtempSync(join(tmpdir(), "dossier-ifc-grid-"));
      const file = join(dir, `${name}.ifc`);
      writeFileSync(file, exportIfcSpf(p));
      const r = spawnSync("python3", ["scripts/validate-ifc.py", file], { encoding: "utf8", timeout: 120_000 });
      expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
      const read = spawnSync(
        "python3",
        ["-c", "import sys, ifcopenshell\nm = ifcopenshell.open(sys.argv[1])\ng = m.by_type('IfcGrid')[0]\nprint(len(g.UAxes), len(g.VAxes), ','.join(a.AxisTag for a in g.UAxes + g.VAxes))", file],
        { encoding: "utf8" },
      );
      expect(read.status, read.stderr).toBe(0);
      expect(read.stdout.trim()).toBe(name === "ortho" ? "3 2 1,2,3,A,B" : "2 2 1,2,A,B");
    }
  }, 240_000);
});
