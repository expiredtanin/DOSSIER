// [200] Schnitt und Ansicht als DXF/DWG: dieselbe Ableitung wie in der App und im PDF-Blatt
// (`viewportLevelPlan`) geht durch den Plan-Sammler des Kerns. Gegengelesen mit dem eigenen Import und
// (falls installiert) ezdxf; Stifte je Element wie im Grundriss.

import "../engine/fileioWasm.setup";
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPlanDwg, buildPlanDxf } from "./exportDxf";
import { countByType, readDxf } from "./cadReadBack.testutil";
import { parseDxf } from "../io/dxfParser";
import { buildComplexSampleProject } from "../model/sampleProjectComplex";
import { collectVisibleCodes } from "../model/types";
import { viewportLevelPlan } from "../plan/viewportPlan";

const hasEzdxf = spawnSync("python3", ["-c", "import ezdxf"]).status === 0;
const p = buildComplexSampleProject();
const codes = collectVisibleCodes(p.layers);

describe.each([
  ["schnitt-a", "Schnitt"],
  ["ansicht-sued", "Ansicht"],
])("[200] %s als DXF/DWG", (levelId, label) => {
  it(`${label}: Entitäten, eigene Stifte, Rückimport`, async () => {
    const plan = await viewportLevelPlan(p, levelId, codes, "mittel", 100, true, false);
    expect(plan.primitives.length).toBeGreaterThan(100);
    const text = buildPlanDxf(plan, p, { scaleDenominator: 100, levelId });
    const dxf = readDxf(text);
    const n = countByType(dxf.entities);
    expect((n.LINE ?? 0) + (n.LWPOLYLINE ?? 0)).toBeGreaterThan(100);
    // Farbig (mono: false): Elemente mit eigener Farbe tragen True-Color (420), abweichende Stärken 370.
    expect(dxf.entities.filter((e) => e.codes.some(([c]) => c === 420)).length).toBeGreaterThan(0);
    expect(dxf.entities.filter((e) => e.codes.some(([c]) => c === 370)).length).toBeGreaterThan(0);
    // Der eigene Import liest die Zeichnung zurück.
    const parsed = parseDxf(text);
    expect(parsed.summary.contours).toBeGreaterThan(50);
    // DWG derselben Zeichnung.
    expect(Buffer.from(buildPlanDwg(plan, p, { scaleDenominator: 100, levelId }).subarray(0, 6)).toString()).toBe("AC1032");
  }, 60_000);

  it.skipIf(!hasEzdxf)(`${label}: ezdxf liest ohne Auditor-Fehler`, async () => {
    const plan = await viewportLevelPlan(p, levelId, codes, "mittel", 100, true, false);
    const dir = mkdtempSync(join(tmpdir(), "dossier-dxf-"));
    const file = join(dir, `${levelId}.dxf`);
    writeFileSync(file, buildPlanDxf(plan, p, { scaleDenominator: 100, levelId }));
    const r = spawnSync("python3", ["scripts/validate-dxf.py", file], { encoding: "utf8", timeout: 60_000, maxBuffer: 256 * 1024 * 1024 });
    const res = JSON.parse(r.stdout) as { errors: string[]; entities: unknown[] };
    expect(res.errors).toEqual([]);
    expect(r.status).toBe(0);
    expect(res.entities.length).toBeGreaterThan(100);
  }, 60_000);
});
