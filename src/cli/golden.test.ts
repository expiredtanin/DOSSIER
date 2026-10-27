// [17] Referenzbilder: Plan, Schnitt und Ansicht des Beispielprojekts als SVG-Text gegen
// eingecheckte Goldens (src/cli/__golden__). Jede Abweichung der Ableitung fällt auf; ein
// gewollter Unterschied wird bewusst übernommen mit
//   UPDATE_GOLDEN=1 npx vitest run src/cli/golden.test.ts
// und der Diff der .svg-Dateien im Commit angesehen.
import { describe, expect, it, beforeAll } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { computeSection, generateElevationPlan, generatePlan, generateSectionPlan, planToSvgString, setWasmBytesProvider } from "../core";
import { sampleProject as project } from "../model/sampleProject";

const DIR = join(process.cwd(), "src", "cli", "__golden__");
const codes = new Set(project.layers.map((l) => l.code));

beforeAll(() => {
  setWasmBytesProvider(async () => readFileSync(join(process.cwd(), "src", "engine", "pkg3d", "render3d_bg.wasm")));
});

function check(name: string, svg: string): void {
  const file = join(DIR, name);
  if (process.env.UPDATE_GOLDEN || !existsSync(file)) {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(file, svg);
    return;
  }
  expect(svg).toBe(readFileSync(file, "utf8"));
}

describe("Referenzbilder (Golden-SVG)", () => {
  it("Grundriss Erdgeschoss", () => {
    const floor = project.drawingLevels.find((l) => l.kind === "floor")!;
    check("grundriss-eg.svg", planToSvgString(generatePlan(project, floor.id, codes), { scaleDenominator: 100 }));
  });
  it("Schnitt", async () => {
    const sec = project.drawingLevels.find((l) => l.kind === "section");
    if (!sec) return;
    const out = await computeSection(project, sec);
    expect(out).toBeTruthy();
    check("schnitt.svg", planToSvgString(generateSectionPlan(out!, false, { visibleCodes: codes }), { scaleDenominator: 100 }));
  }, 30_000);
  it("Ansicht", () => {
    const el = project.drawingLevels.find((l) => l.kind === "elevation");
    if (!el) return;
    const plan = generateElevationPlan(project, el);
    expect(plan).toBeTruthy();
    check("ansicht.svg", planToSvgString(plan!, { scaleDenominator: 100 }));
  });
});
