// DXF-Export gegen ezdxf prüfen ([C1]/[C2]): eine zweite, unabhängige Implementierung liest die
// von acadrust geschriebene Datei (`scripts/validate-dxf.py`, mit Auditor). Ohne Python/ezdxf wird der
// Test übersprungen (Muster `exportIfc.validate.test.ts`; `pip install ezdxf`). DWG liest ezdxf nicht
// selbst (nur über den ODA-Konverter) — die DWG-Rundreise prüft `exportDxf.roundtrip.test.ts` mit libredwg.

import "../engine/fileioWasm.setup";
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPlanDxf } from "./exportDxf";
import { sampleProject } from "../model/sampleProject";
import { generatePlan } from "../plan/generatePlan";
import type { Plan } from "../plan/generatePlan";
import { flattenCategories } from "../model/types";
import type { Project } from "../model/types";
import { projectToWorldCoords } from "../model/geoRebase";

const hasEzdxf = spawnSync("python3", ["-c", "import ezdxf"]).status === 0;

interface EzEntity {
  type: string;
  layer: string;
  pts?: number[][];
  closed?: boolean;
  text?: string;
}
interface EzResult {
  version: string;
  insunits: number;
  errors: string[];
  layers: Record<string, { lineweight: number; rgb: number[] | null }>;
  entities: EzEntity[];
}

function ezdxfRead(name: string, dxf: string): { status: number | null; result: EzResult | null; err: string } {
  const dir = mkdtempSync(join(tmpdir(), "dossier-dxf-"));
  const file = join(dir, `${name}.dxf`);
  writeFileSync(file, dxf);
  const r = spawnSync("python3", ["scripts/validate-dxf.py", file], { encoding: "utf8", timeout: 60_000 });
  let result: EzResult | null = null;
  try {
    result = JSON.parse(r.stdout) as EzResult;
  } catch {
    /* Ausgabe unten im Fehlertext */
  }
  return { status: r.status, result, err: `${r.stdout}\n${r.stderr}` };
}

describe.skipIf(!hasEzdxf)("DXF-Export gegen ezdxf", { timeout: 60_000 }, () => {
  it("Demo-Haus georeferenziert: fehlerfrei, gleiche Entitäten, LV95 bitgleich", () => {
    const world = projectToWorldCoords({
      ...sampleProject,
      geoAnchor: { lv95: { e: 2_600_123.456_789_1, n: 1_200_456.987_654_3 }, model: { x: 0, y: 0 } },
    });
    const plan = generatePlan(world, "eg", new Set(flattenCategories(world.layers).map((l) => l.code)));
    const r = ezdxfRead("demo-haus", buildPlanDxf(plan, world));
    expect(r.result, r.err).not.toBeNull();
    expect(r.result!.errors).toEqual([]);
    expect(r.status).toBe(0);
    expect(r.result!.version).toBe("AC1032");
    expect(r.result!.insunits).toBe(6);
    const polys = plan.primitives.filter((p): p is Extract<Plan["primitives"][number], { kind: "polygon" }> => p.kind === "polygon");
    const ezPolys = r.result!.entities.filter((e) => e.type === "LWPOLYLINE");
    expect(ezPolys.length).toBe(polys.length);
    for (let i = 0; i < polys.length; i++) {
      expect(ezPolys[i].closed).toBe(true);
      expect(ezPolys[i].pts).toEqual(polys[i].pts.map((p) => [p.x, p.y]));
    }
    for (const c of flattenCategories(world.layers)) {
      const l = r.result!.layers[`${c.code}_${c.name}`.replace(/[<>/\\":;?*|=`]/g, "_").replace(/\s+/g, "_")];
      expect(l, c.name).toBeDefined();
      expect(l.lineweight).toBe(Math.round(c.lw * 100));
    }
  });

  it("Umlaute in Ebene und Text", () => {
    const cat0 = sampleProject.layers[0];
    const project: Project = {
      ...sampleProject,
      layers: [{ ...cat0, name: "Gelände Süd" }, ...sampleProject.layers.slice(1)],
      drawings2d: [{ ...(sampleProject.drawings2d[0] ?? {}), id: "d1", categoryCode: cat0.code } as Project["drawings2d"][number]],
    };
    const plan = {
      primitives: [{ kind: "drawingText", at: { x: 1, y: 2 }, text: "Grünfläche ≥ 30 %", heightM: 0.25, angle: 0, color: "#000", drawingId: "d1" }],
      bounds: { minX: 0, minY: 0, maxX: 1, maxY: 1 },
    } as unknown as Plan;
    const r = ezdxfRead("umlaute", buildPlanDxf(plan, project));
    expect(r.status, r.err).toBe(0);
    expect(r.result!.entities).toEqual([
      expect.objectContaining({ type: "TEXT", layer: `${cat0.code}_Gelände_Süd`, text: "Grünfläche ≥ 30 %" }),
    ]);
  });
});
