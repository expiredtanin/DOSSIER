// dossier-cli — der Kern ohne UI (lessons-bimcraft [4], docs/core-ui-split.md Phase C).
// Importiert AUSSCHLIESSLICH `../core` (Wächter-Test `src/cli/boundary.test.ts`). Gebaut mit
// `npm run build:cli` → dist-cli/dossier-cli.mjs; aufgerufen mit `node dist-cli/dossier-cli.mjs`.
//
//   dossier-cli <projekt.obp> info
//   dossier-cli <projekt.obp> validate
//   dossier-cli <projekt.obp> migrate [--out neu.obp]
//   dossier-cli <projekt.obp> plan [--level EG] [--scale 100] [--out eg.svg]
//   dossier-cli <projekt.obp> section <Name> [--out schnitt.svg]       (braucht render3d-WASM)
//   dossier-cli <projekt.obp> elevation <Name> [--out ansicht.svg]
//   dossier-cli <projekt.obp> dxf|ifc|step|obj|stl|schedule [--level EG] [--out datei]
//   dossier-cli <projekt.obp> model3d [--out modell.json]   3D-Modell fürs Headless-Rendern (render_png)
//   dossier-cli <projekt.obp> bench [--runs 10]      Zeitprofil der Ableitungen (ms je Aufruf)
//
// WASM-Pakete (src/engine/pkg*) werden aus DOSSIER_WASM_DIR bzw. `<repo>/src/engine` gelesen.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildPlanDxf,
  computeSection,
  exportIfcSpf,
  exportObj,
  exportProjectStep,
  exportScheduleCsv,
  exportStl,
  generateElevationPlan,
  diffToOps,
  applyOps,
  generatePlan,
  generateSectionPlan,
  planToRenderScene,
  projectToModel3d,
  parseProjectFile,
  planToSvgString,
  serializeProject,
  setWasmBytesProvider,
  validateProject,
} from "../core";
import type { Project } from "../core";

type Args = { positional: string[]; flags: Map<string, string> };

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) flags.set(a.slice(2), "true");
      else {
        flags.set(a.slice(2), next);
        i++;
      }
    } else positional.push(a);
  }
  return { positional, flags };
}

function wasmDir(): string {
  if (process.env.DOSSIER_WASM_DIR) return process.env.DOSSIER_WASM_DIR;
  // dist-cli/dossier-cli.mjs → ../src/engine
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "src", "engine");
}

const WASM_FILES: Record<string, string> = {
  render3d: "pkg3d/render3d_bg.wasm",
  trucksolid: "pkgTruck/trucksolid_bg.wasm",
};

function fail(msg: string): never {
  process.stderr.write(`dossier-cli: ${msg}\n`);
  process.exit(1);
}

function loadProject(path: string): Project {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    fail(`Datei nicht lesbar: ${path} (${e instanceof Error ? e.message : String(e)})`);
  }
  const r = parseProjectFile(text);
  if (!r.ok) fail(r.error);
  for (const w of r.warnings) process.stderr.write(`Hinweis: ${w}\n`);
  return r.project;
}

function findLevel(project: Project, kinds: string[], name: string | undefined) {
  const levels = project.drawingLevels.filter((l) => kinds.includes(l.kind));
  if (!name) return levels[0];
  const n = name.toLowerCase();
  return levels.find((l) => l.id.toLowerCase() === n || l.name.toLowerCase() === n);
}

function out(args: Args, text: string, defaultName: string): void {
  const target = args.flags.get("out") ?? defaultName;
  if (target === "-") process.stdout.write(text);
  else {
    writeFileSync(target, text);
    process.stderr.write(`geschrieben: ${target} (${text.length} Zeichen)\n`);
  }
}

export async function run(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const [file, command, ...rest] = args.positional;
  if (!file || !command) {
    process.stderr.write(
      "Aufruf: dossier-cli <projekt.obp> <info|validate|migrate|plan|section|elevation|dxf|ifc|step|obj|stl|schedule> [Optionen]\n",
    );
    return 2;
  }
  setWasmBytesProvider(async (name) => {
    const rel = WASM_FILES[name];
    if (!rel) throw new Error(`unbekanntes WASM-Modul ${name}`);
    return readFileSync(join(wasmDir(), rel));
  });
  const project = loadProject(file);
  const scale = Number(args.flags.get("scale") ?? 100);
  const allCodes = new Set(project.layers.map((l) => l.code));

  switch (command) {
    case "info": {
      const levels = project.drawingLevels.map((l) => `${l.kind}:${l.name}`);
      process.stdout.write(
        JSON.stringify(
          {
            name: project.name,
            walls: project.walls.length,
            ceilings: project.ceilings?.length ?? 0,
            roofs: project.roofs?.length ?? 0,
            openings: project.openings?.length ?? 0,
            stairs: project.stairs?.length ?? 0,
            rooms: project.rooms?.length ?? 0,
            drawings2d: project.drawings2d.length,
            extrudedSolids: project.extrudedSolids?.length ?? 0,
            levels,
          },
          null,
          2,
        ) + "\n",
      );
      return 0;
    }
    case "validate": {
      const problems = validateProject(project);
      if (problems.length) {
        process.stderr.write(problems.join("\n") + "\n");
        return 1;
      }
      process.stdout.write("ok\n");
      return 0;
    }
    case "migrate":
      out(args, serializeProject(project), args.flags.get("out") ?? file);
      return 0;
    case "plan": {
      const lvl = findLevel(project, ["floor"], args.flags.get("level"));
      if (!lvl) fail(`Geschoss nicht gefunden: ${args.flags.get("level") ?? "(erstes)"}`);
      const plan = generatePlan(project, lvl.id, allCodes);
      out(args, planToSvgString(plan, { scaleDenominator: scale }), `${lvl.name}.svg`);
      return 0;
    }
    case "section":
    case "elevation": {
      const name = rest[0];
      const kind = command === "section" ? "section" : "elevation";
      const lvl = findLevel(project, [kind], name);
      if (!lvl) fail(`${command} nicht gefunden: ${name ?? "(erste)"}`);
      let plan;
      if (kind === "section") {
        const o = await computeSection(project, lvl);
        if (!o) fail("keine gültige Schnittlinie");
        plan = generateSectionPlan(o, false, { visibleCodes: allCodes });
      } else {
        plan = generateElevationPlan(project, lvl);
        if (!plan) fail("keine gültige Ansichtslinie");
      }
      out(args, planToSvgString(plan, { scaleDenominator: scale }), `${lvl.name}.svg`);
      return 0;
    }
    case "dxf": {
      const lvl = findLevel(project, ["floor"], args.flags.get("level"));
      if (!lvl) fail("Geschoss nicht gefunden");
      out(args, buildPlanDxf(generatePlan(project, lvl.id, allCodes), project), `${lvl.name}.dxf`);
      return 0;
    }
    case "ifc":
      out(args, exportIfcSpf(project), `${project.name || "projekt"}.ifc`);
      return 0;
    case "obj":
      out(args, exportObj(project), `${project.name || "projekt"}.obj`);
      return 0;
    case "stl":
      out(args, exportStl(project), `${project.name || "projekt"}.stl`);
      return 0;
    case "schedule":
      out(args, exportScheduleCsv(project), `${project.name || "projekt"}-liste.csv`);
      return 0;
    case "step": {
      const r = await exportProjectStep(project, project.name || "projekt");
      if (r.skipped.length) process.stderr.write(`${r.skipped.length} Körper übersprungen/ungeschnitten.\n`);
      out(args, r.text, `${project.name || "projekt"}.stp`);
      return 0;
    }
    case "model3d":
      out(args, JSON.stringify(projectToModel3d(project)), `${project.name || "projekt"}.model3d.json`);
      return 0;
    case "bench": {
      const runs = Number(args.flags.get("runs") ?? 10);
      const floor = findLevel(project, ["floor"], undefined);
      const sec = findLevel(project, ["section"], undefined);
      const elev = findLevel(project, ["elevation"], undefined);
      const rows: Array<[string, number]> = [];
      const time = async (name: string, f: () => unknown | Promise<unknown>, n = runs) => {
        await f(); // Aufwärmen (füllt Caches wie roofGeometry)
        const t0 = performance.now();
        for (let i = 0; i < n; i++) await f();
        rows.push([name, (performance.now() - t0) / n]);
      };
      if (floor) {
        await time("generatePlan", () => generatePlan(project, floor.id, allCodes));
        const plan = generatePlan(project, floor.id, allCodes);
        await time("planToRenderScene", () => planToRenderScene(plan));
        await time("planToSvgString", () => planToSvgString(plan, { scaleDenominator: scale }));
      }
      await time("projectToModel3d", () => projectToModel3d(project));
      if (sec) await time("computeSection", () => computeSection(project, sec), Math.max(3, runs / 2));
      if (elev) await time("generateElevationPlan", () => generateElevationPlan(project, elev), Math.max(3, runs / 2));
      if (project.walls.length) {
        const moved = { ...project, walls: [{ ...project.walls[0], height: (project.walls[0].height ?? 2.6) + 0.1 }, ...project.walls.slice(1)] };
        await time("Op: diff+apply (1 Wand)", () => applyOps(project, diffToOps(project, moved)), runs * 20);
      }
      for (const [n, ms] of rows) process.stdout.write(`${n.padEnd(28)} ${ms.toFixed(2).padStart(9)} ms\n`);
      return 0;
    }
    default:
      process.stderr.write(`unbekannter Befehl: ${command}\n`);
      return 2;
  }
}

// Direktaufruf (nicht beim Import in Tests).
if (process.argv[1] && /dossier-cli\.mjs$/.test(process.argv[1])) {
  run(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write(`dossier-cli: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
      process.exit(1);
    },
  );
}
