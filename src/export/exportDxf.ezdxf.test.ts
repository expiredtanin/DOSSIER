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
import { buildPlanDxf, buildPlanDxfBinary } from "./exportDxf";
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
  solid?: boolean;
  paths?: number;
  pattern_lines?: number;
  rgb?: number[] | null;
  gradient?: { name: string; rotation: number; color1: number[]; color2: number[] } | null;
}
interface EzResult {
  version: string;
  insunits: number;
  errors: string[];
  layers: Record<string, { lineweight: number; rgb: number[] | null }>;
  entities: EzEntity[];
}

function ezdxfRead(name: string, dxf: string | Uint8Array): { status: number | null; result: EzResult | null; err: string } {
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
    // Ohne unsichtbare Pick-Bänder und ohne Öffnungs-Polygone (Fensterrahmen liegen im Block, nicht im Modellbereich).
    const polys = plan.primitives.filter(
      (p): p is Extract<Plan["primitives"][number], { kind: "polygon" }> =>
        p.kind === "polygon" && !p.openingId && !(p.stroke === "none" && p.fill === "none" && p.hatch.pattern === "none"),
    );
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

  it("HATCH: Vollfüllung, Kreuzschraffur und gestrichelt — ezdxf liest Rand, Farbe, Musterzeilen ohne Auditor-Fehler", () => {
    const sq = [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }, { x: 0, y: 3 }];
    const poly = (hatch: object) => ({
      kind: "polygon", pts: sq, fill: "#eee", stroke: "#111", strokeWidthMm: 0.25,
      hatch: { pattern: "crosshatch", scale: 1, angle: 45, color: "#336699", lineWeight: 0.13, dash: null, ...hatch },
    });
    const plan = {
      primitives: [poly({ pattern: "solid" }), poly({}), poly({ pattern: "diagonal", dash: [2, 1] })],
      bounds: { minX: 0, minY: 0, maxX: 4, maxY: 3 },
    } as unknown as Plan;
    const r = ezdxfRead("hatch", buildPlanDxf(plan, sampleProject));
    expect(r.result, r.err).not.toBeNull();
    expect(r.result!.errors).toEqual([]);
    expect(r.status).toBe(0);
    const hs = r.result!.entities.filter((e) => e.type === "HATCH");
    expect(hs.length).toBe(3);
    expect(hs.map((h) => h.solid)).toEqual([true, false, false]);
    expect(hs.map((h) => h.pattern_lines)).toEqual([0, 2, 1]);
    for (const h of hs) {
      expect(h.layer).toBe("HATCH");
      expect(h.paths).toBe(1);
      expect(h.rgb).toEqual([0x33, 0x66, 0x99]);
      expect(h.pts).toEqual(sq.map((p) => [p.x, p.y]));
    }
  });

  const gradPlan = (): Plan => {
    const sq = [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }, { x: 0, y: 3 }];
    const poly = (gradient: object) => ({
      kind: "polygon", pts: sq, fill: "#eee", stroke: "#111", strokeWidthMm: 0.25,
      hatch: { pattern: "crosshatch", scale: 1, angle: 0, color: "#336699", lineWeight: 0.13, dash: null, kind: "gradient", gradient },
    });
    return {
      primitives: [
        poly({ color1: "#ffffff", color2: "#003399", angle: 90, type: "linear" }),
        poly({ color1: "#f00", color2: "#00f", angle: 0, type: "radial" }),
      ],
      bounds: { minX: 0, minY: 0, maxX: 4, maxY: 3 },
    } as unknown as Plan;
  };

  it("Verlauf: ezdxf liest echte Gradient-HATCHs (linear, radial) ohne Auditor-Fehler", () => {
    const r = ezdxfRead("gradient", buildPlanDxf(gradPlan(), sampleProject));
    expect(r.result, r.err).not.toBeNull();
    expect(r.result!.errors).toEqual([]);
    expect(r.status).toBe(0);
    const hs = r.result!.entities.filter((e) => e.type === "HATCH");
    expect(hs.length).toBe(2);
    expect(hs[0].gradient).toMatchObject({ name: "LINEAR", color1: [255, 255, 255], color2: [0, 0x33, 0x99] });
    expect(hs[0].gradient!.rotation).toBeCloseTo(90, 6);
    expect(hs[1].gradient).toMatchObject({ name: "SPHERICAL", color1: [255, 0, 0], color2: [0, 0, 255] });
  });

  it("Binär-DXF: ezdxf liest dieselbe Zeichnung wie die ASCII-Fassung ohne Auditor-Fehler", () => {
    const plan = generatePlan(sampleProject, "eg", new Set(flattenCategories(sampleProject.layers).map((l) => l.code)));
    const asc = ezdxfRead("bin-asc", buildPlanDxf(plan, sampleProject));
    const bin = ezdxfRead("bin-bin", buildPlanDxfBinary(plan, sampleProject));
    expect(bin.result, bin.err).not.toBeNull();
    expect(bin.result!.errors).toEqual([]);
    expect(bin.status).toBe(0);
    expect(bin.result!.entities).toEqual(asc.result!.entities);
    expect(Object.keys(bin.result!.layers)).toEqual(Object.keys(asc.result!.layers));
    // und kleiner als der Text
    expect(buildPlanDxfBinary(plan, sampleProject).length).toBeLessThan(buildPlanDxf(plan, sampleProject).length);
  });

  it("Binär-DXF mit Verlauf: Gradient bleibt erhalten", () => {
    const r = ezdxfRead("bin-grad", buildPlanDxfBinary(gradPlan(), sampleProject));
    expect(r.result!.errors).toEqual([]);
    expect(r.result!.entities.filter((e) => e.type === "HATCH").map((h) => h.gradient?.name)).toEqual(["LINEAR", "SPHERICAL"]);
  });
});
