// VORÜBERGEHEND ([K3c]): Messung alt (TS) gegen neu (Kern) für Schnitt und Ansicht (nur mit BENCH=1).
import { it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setWasmBytesProvider } from "../engine/wasmSource";
import { computeSection as oldCompute } from "./toSection";
import { generateSectionPlan as oldGen } from "./generatePlan";
import { sectionOpeningPrimitives } from "./sectionOpenings";
import { generateElevationPlan as oldElev } from "./toElevation";
import { computeSection as newCompute, generateSectionPlan as newGen, generateElevationPlan as newElev } from "./sectionCore";
import { planToRenderScene } from "./toRenderScene";
import { sampleProject } from "../model/sampleProject";
import { flattenCategories } from "../model/types";
import type { DrawingLevel, Project } from "../model/types";
import { bigSectionProject } from "./sectionParity.testing";

async function time(f: () => Promise<unknown> | unknown, runs: number): Promise<[number, number]> {
  await f();
  const t: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    await f();
    t.push(performance.now() - t0);
  }
  t.sort((a, b) => a - b);
  return [t[0], t[Math.floor(t.length / 2)]];
}

const fmt = ([a, b]: [number, number]) => `${a.toFixed(1)}/${b.toFixed(1)}`;

it.skipIf(!process.env.BENCH)("Messung Schnitt/Ansicht alt gegen neu", async () => {
  setWasmBytesProvider(async (name) => readFileSync(join(process.cwd(), "src", "engine", name === "trucksolid" ? "pkgTruck/trucksolid_bg.wasm" : "pkg3d/render3d_bg.wasm")));
  const only = process.env.BENCH_ONLY;
  const all: Array<[string, Project]> = [["Beispiel", sampleProject], ["big6", bigSectionProject(6)], ["big8", bigSectionProject(8)], ["big16", bigSectionProject(16)]];
  const cases = all.filter(([n]) => !only || only.split(",").includes(n));
  const rows: string[] = ["Projekt | Ebene | alt Plan | neu Plan | alt +Szene | neu +Szene (ms min/median)"];
  for (const [name, p] of cases) {
    const codes = new Set(flattenCategories(p.layers).map((c) => c.code));
    const levels = p.drawingLevels.filter((l) => (l.kind === "section" || l.kind === "elevation") && l.linePoints) as DrawingLevel[];
    const runs = Number(process.env.BENCH_RUNS ?? (name === "big16" ? 1 : name === "Beispiel" ? 20 : 5));
    for (const l of levels) {
      if (l.kind === "section") {
        const oldP = async () => {
          const o = (await oldCompute(p, l))!;
          const pl = oldGen(o, false, { hiddenLines: l.hiddenLines, visibleCodes: codes });
          return { ...pl, primitives: [...pl.primitives, ...sectionOpeningPrimitives(p, l, codes)] };
        };
        const newP = async () => newGen((await newCompute(p, l))!, false, { hiddenLines: l.hiddenLines, visibleCodes: codes, openings: true });
        const skipOld = !!process.env.BENCH_NEW_ONLY;
        const a = skipOld ? ([NaN, NaN] as [number, number]) : await time(oldP, runs);
        const b = await time(newP, runs);
        const c = skipOld ? ([NaN, NaN] as [number, number]) : await time(async () => planToRenderScene(await oldP(), 100), runs);
        const d = await time(async () => planToRenderScene(await newP(), 100), runs);
        // Umschalten (Schwarz-Weiss) auf einem vorbereiteten Schnitt: der Kern rechnet nicht neu.
        const prepared = (await newCompute(p, l))!;
        let flip = false;
        const e = await time(() => newGen(prepared, (flip = !flip), { hiddenLines: l.hiddenLines, visibleCodes: codes, openings: true }), runs);
        rows.push(`${name} | ${l.id} Schnitt | ${fmt(a)} | ${fmt(b)} | ${fmt(c)} | ${fmt(d)} | Umschalten ${fmt(e)}`);
        process.stderr.write(rows[rows.length - 1] + "\n");
      } else {
        const skipOld = !!process.env.BENCH_NEW_ONLY;
        const a = skipOld ? ([NaN, NaN] as [number, number]) : await time(() => oldElev(p, l), runs);
        const b = await time(() => newElev(p, l), runs);
        const c = skipOld ? ([NaN, NaN] as [number, number]) : await time(() => planToRenderScene(oldElev(p, l)!, 100), runs);
        const d = await time(() => planToRenderScene(newElev(p, l)!, 100), runs);
        rows.push(`${name} | ${l.id} Ansicht | ${fmt(a)} | ${fmt(b)} | ${fmt(c)} | ${fmt(d)}`);
        process.stderr.write(rows[rows.length - 1] + "\n");
      }
    }
  }
  console.log(rows.join("\n"));
}, 3_600_000);
