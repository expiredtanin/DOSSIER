// dossier-cli — der Kern ohne UI (lessons-bimcraft [4], docs/core-ui-split.md Phase C).
// Importiert AUSSCHLIESSLICH `../core` (Wächter-Test `src/cli/boundary.test.ts`). Gebaut mit
// `npm run build:cli` → dist-cli/dossier-cli.mjs; aufgerufen mit `node dist-cli/dossier-cli.mjs`.
//
//   dossier-cli <projekt.obp> info
//   dossier-cli <projekt.obp> validate
//   dossier-cli <projekt.obp> migrate [--out neu.obp]
//   dossier-cli <projekt.obp> plan [--level EG] [--scale 100] [--format svg|json] [--out eg.svg]
//                                                  json = render2d-Szene (planToRenderScene)
//   dossier-cli <projekt.obp> section <Name> [--out schnitt.svg]       (braucht render3d-WASM)
//   dossier-cli <projekt.obp> elevation <Name> [--out ansicht.svg]
//   dossier-cli <projekt.obp> dxf|dwg|ifc|step|obj|stl|schedule|kennzahlen|sun [--level EG] [--out datei]
//   dossier-cli <projekt.obp> import-ifc <datei.ifc> [--out neu.obp] [--group product|class]
//                                                  IFC als Kontext-Meshes ([B3]); Bericht als JSON auf stdout
//   dossier-cli <projekt.obp> model3d [--out modell.json]   3D-Modell fürs Headless-Rendern (render_png)
//   dossier-cli <projekt.obp> bundle [--scale 100] [--out projekt.bundle.json]
//                                                  Ansichtspaket für die egui-Oberfläche (src-tauri/dossier-egui):
//                                                  je Geschoss render2d-Szene, 3D-Modell, Bauteile; dazu Kennzahlen
//   dossier-cli <projekt.obp> mcp                  MCP-Server (stdio): project_info, query, render_svg, apply_ops, validate
//   dossier-cli <projekt.obp> bench [--runs 10]      Zeitprofil der Ableitungen (ms je Aufruf)
//
// Statt einer Datei nimmt `:beispiel` das eingebaute Demo-Haus (sampleProject).
//
// WASM-Pakete (src/engine/pkg*) werden aus DOSSIER_WASM_DIR bzw. `<repo>/src/engine` gelesen.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildPlanDxf,
  buildPlanDwg,
  loadFileio,
  readIfc,
  ifcToImportedMeshes,
  projectGeoOrigin,
  ensureContextCategories,
  projectToWorldCoords,
  computeSection,
  exportIfcSpf,
  exportObj,
  exportProjectStep,
  exportScheduleCsv,
  computeKennzahlen,
  sunPosition,
  shadowPolygons,
  projectLatLon,
  checkRoomProgram,
  checkSiteRules,
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
  initCore,
  validateProject,
  polygonArea,
  sampleProject,
} from "../core";
import type { Project } from "../core";
import { serveStdio } from "./mcp";

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
  core: "pkgCore/core_bg.wasm",
  fileio: "pkgFileIo/fileio_bg.wasm",
  render3d: "pkg3d/render3d_bg.wasm",
  trucksolid: "pkgTruck/trucksolid_bg.wasm",
};

function fail(msg: string): never {
  process.stderr.write(`dossier-cli: ${msg}\n`);
  process.exit(1);
}

function loadProject(path: string): Project {
  if (path === ":beispiel") return sampleProject;
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

function out(args: Args, text: string | Uint8Array, defaultName: string): void {
  const target = args.flags.get("out") ?? defaultName;
  if (target === "-") process.stdout.write(text);
  else {
    writeFileSync(target, text);
    const size = typeof text === "string" ? `${text.length} Zeichen` : `${text.length} Bytes`;
    process.stderr.write(`geschrieben: ${target} (${size})\n`);
  }
}

// ── Ansichtspaket für die egui-Oberfläche (`bundle`) ─────────────────────────
// Das Modell ist noch TS ([K4]); die egui-App (src-tauri/dossier-egui) liest deshalb ein
// JSON, das alles Abgeleitete enthält: je Geschoss die render2d-Szene, das 3D-Modell nur
// dieses Geschosses (damit die App Geschosse im 3D ein-/ausblenden kann) und eine
// vereinfachte Bauteil-Liste (Form zum Anklicken + Eigenschaften als Schlüssel/Wert).

type BPt = [number, number];
type BShape =
  | { type: "segment"; a: BPt; b: BPt; width: number }
  | { type: "polygon"; pts: BPt[] }
  | { type: "circle"; c: BPt; r: number };
type BElement = { id: string; kind: string; label: string; shape: BShape; props: Array<[string, string | number]> };

const r3 = (n: number): number => Math.round(n * 1000) / 1000;
const pt = (v: { x: number; y: number }): BPt => [v.x, v.y];

/** Projekt auf ein Geschoss eingeschränkt: Arrays mit `floorId` gefiltert, Öffnungen über ihre Wand. */
function projectForFloor(project: Project, floorId: string | null): Project {
  const p: Record<string, unknown> = { ...project };
  for (const [k, v] of Object.entries(project)) {
    if (!Array.isArray(v) || k === "drawingLevels") continue;
    if (v.some((e) => e && typeof e === "object" && "floorId" in e)) {
      p[k] = v.filter((e) => e && typeof e === "object" && (e as { floorId?: string }).floorId === floorId);
    }
  }
  const walls = new Set((p.walls as Project["walls"]).map((w) => w.id));
  p.openings = (project.openings ?? []).filter((o) => walls.has(o.hostWallId));
  if (floorId !== null) p.context = [];
  return p as unknown as Project;
}

function floorElements(project: Project, floorId: string): BElement[] {
  const els: BElement[] = [];
  const wallTypes = new Map(project.wallTypes.map((t) => [t.id, t]));
  const thickness = (typeId: string) => (wallTypes.get(typeId)?.layers ?? []).reduce((s, l) => s + l.thickness, 0);
  const wallsById = new Map(project.walls.map((w) => [w.id, w]));
  for (const w of project.walls) {
    if (w.floorId !== floorId) continue;
    const t = thickness(w.wallTypeId);
    const len = Math.hypot(w.end.x - w.start.x, w.end.y - w.start.y);
    els.push({
      id: w.id,
      kind: "wall",
      label: wallTypes.get(w.wallTypeId)?.name ?? w.id,
      shape: { type: "segment", a: pt(w.start), b: pt(w.end), width: t || 0.1 },
      props: [["type", wallTypes.get(w.wallTypeId)?.name ?? "—"], ["thickness", r3(t)], ["length", r3(len)], ["height", r3(w.height)], ["category", w.categoryCode]],
    });
  }
  for (const o of project.openings ?? []) {
    const w = wallsById.get(o.hostWallId);
    if (!w || w.floorId !== floorId) continue;
    const len = Math.hypot(w.end.x - w.start.x, w.end.y - w.start.y) || 1;
    const ux = (w.end.x - w.start.x) / len;
    const uy = (w.end.y - w.start.y) / len;
    // `position` = erster Pfosten entlang der Wandachse (Meter ab Wandanfang).
    const at = (s: number): BPt => [w.start.x + ux * s, w.start.y + uy * s];
    els.push({
      id: o.id,
      kind: o.kind,
      label: o.kind,
      shape: { type: "segment", a: at(o.position), b: at(o.position + o.width), width: (thickness(w.wallTypeId) || 0.1) + 0.04 },
      props: [["width", r3(o.width)], ["height", r3(o.height)], ["sill", r3(o.sillHeight)], ["wall", w.id]],
    });
  }
  for (const r of project.rooms ?? []) {
    if (r.floorId !== floorId) continue;
    els.push({
      id: r.id,
      kind: "room",
      label: r.name,
      shape: { type: "polygon", pts: r.boundary.map(pt) },
      props: [["name", r.name], ["sia", r.siaCategory], ["area", r3(polygonArea(r.boundary))], ["category", r.categoryCode]],
    });
  }
  for (const c of project.columns ?? []) {
    if (c.floorId !== floorId) continue;
    const r = c.profile.kind === "round" ? c.profile.radius : Math.hypot(c.profile.width, c.profile.depth) / 2;
    const profile = c.profile.kind === "round" ? `Ø ${r3(c.profile.radius * 2)}` : `${r3(c.profile.width)} × ${r3(c.profile.depth)}`;
    els.push({ id: c.id, kind: "column", label: c.id, shape: { type: "circle", c: pt(c.position), r }, props: [["profile", profile], ["height", r3(c.height)]] });
  }
  for (const s of project.stairs ?? []) {
    if (s.floorId !== floorId) continue;
    const dl = Math.hypot(s.dir.x, s.dir.y) || 1;
    const end: BPt = [s.start.x + (s.dir.x / dl) * s.runLength, s.start.y + (s.dir.y / dl) * s.runLength];
    els.push({
      id: s.id,
      kind: "stair",
      label: s.id,
      shape: { type: "segment", a: pt(s.start), b: end, width: s.width },
      props: [["shape", s.shape], ["width", r3(s.width)], ["steps", s.stepCount], ["runLength", r3(s.runLength)]],
    });
  }
  for (const c of project.ceilings ?? []) {
    if (c.floorId !== floorId) continue;
    els.push({ id: c.id, kind: "ceiling", label: c.id, shape: { type: "polygon", pts: c.outline.map(pt) }, props: [["area", r3(polygonArea(c.outline))], ["thickness", r3(c.thickness ?? 0)]] });
  }
  for (const r of project.roofs ?? []) {
    if (r.floorId !== floorId) continue;
    els.push({ id: r.id, kind: "roof", label: r.shape, shape: { type: "polygon", pts: r.outline.map(pt) }, props: [["shape", r.shape], ["pitch", r3(r.pitchDeg)], ["thickness", r3(r.thickness)]] });
  }
  return els;
}

function buildBundle(project: Project, allCodes: Set<string>, scale: number) {
  const floors = project.drawingLevels.filter((l) => l.kind === "floor");
  const levels = floors.map((lvl) => {
    const plan = generatePlan(project, lvl.id, allCodes, undefined, "mittel", false, false, true, scale);
    return {
      id: lvl.id,
      name: lvl.name,
      elevation: lvl.baseElevation ?? 0,
      height: lvl.floorHeight ?? 0,
      visible: lvl.visible,
      scene: planToRenderScene(plan, scale),
      model3d: projectToModel3d(projectForFloor(project, lvl.id)),
      elements: floorElements(project, lvl.id),
    };
  });
  const context = (project.context ?? []).length ? projectToModel3d(projectForFloor(project, null)) : null;
  return {
    format: "dossier-bundle",
    version: 1,
    name: project.name,
    scale,
    levels,
    context3d: context,
    kennzahlen: computeKennzahlen(project),
    raumprogramm: checkRoomProgram(project),
  };
}

export async function run(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const [file, command, ...rest] = args.positional;
  if (!file || !command) {
    process.stderr.write(
      "Aufruf: dossier-cli <projekt.obp> <info|validate|migrate|plan|section|elevation|dxf|dwg|ifc|import-ifc|step|obj|stl|schedule|kennzahlen|sun|model3d|bundle> [Optionen]\n",
    );
    return 2;
  }
  setWasmBytesProvider(async (name) => {
    const rel = WASM_FILES[name];
    if (!rel) throw new Error(`unbekanntes WASM-Modul ${name}`);
    return readFileSync(join(wasmDir(), rel));
  });
  await initCore();
  const project = loadProject(file);
  const scale = Number(args.flags.get("scale") ?? 100);
  // Alle Ebenen-Codes inkl. verschachtelter (z. B. „10 Situation" unter „05 Kontext").
  const allCodes = new Set<string>();
  const collectCodes = (ls: Project["layers"]): void => {
    for (const l of ls) {
      allCodes.add(l.code);
      if (l.children) collectCodes(l.children);
    }
  };
  collectCodes(project.layers);

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
      // Massstab geht in die Plan-Erzeugung ein (Bemassung in Papier-mm, Strichstärken nach Massstab).
      const plan = generatePlan(project, lvl.id, allCodes, undefined, "mittel", false, false, true, scale);
      if (args.flags.get("format") === "json") {
        out(args, JSON.stringify(planToRenderScene(plan, scale)), `${lvl.name}.scene.json`);
        return 0;
      }
      out(args, planToSvgString(plan, { scaleDenominator: scale }), `${lvl.name}.svg`);
      return 0;
    }
    case "bundle":
      out(args, JSON.stringify(buildBundle(project, allCodes, scale)), `${project.name || "projekt"}.bundle.json`);
      return 0;
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
    case "dxf":
    case "dwg": {
      const lvl = findLevel(project, ["floor"], args.flags.get("level"));
      if (!lvl) fail("Geschoss nicht gefunden");
      // Wie in der App: georeferenziert (LV95), wenn das Projekt einen Standort-Bezug hat.
      const world = projectToWorldCoords(project);
      const plan = generatePlan(world, lvl.id, allCodes);
      await loadFileio();
      if (command === "dxf") out(args, buildPlanDxf(plan, world), `${lvl.name}.dxf`);
      else out(args, buildPlanDwg(plan, world), `${lvl.name}.dwg`);
      return 0;
    }
    case "ifc":
      await loadFileio();
      out(args, exportIfcSpf(project), `${project.name || "projekt"}.ifc`);
      return 0;
    case "obj":
      out(args, exportObj(project), `${project.name || "projekt"}.obj`);
      return 0;
    case "stl":
      out(args, exportStl(project), `${project.name || "projekt"}.stl`);
      return 0;
    case "kennzahlen": {
      const k = computeKennzahlen(project);
      const prog = checkRoomProgram(project);
      const baurecht = checkSiteRules(project);
      out(args, JSON.stringify({ kennzahlen: k, raumprogramm: prog, baurecht }, null, 2), `${project.name || "projekt"}-kennzahlen.json`);
      return 0;
    }
    case "sun": {
      // Sonnenstand + Schatten-Polygone (Boden, Meter) für Datum/Uhrzeit (UTC), z. B. --when 2026-06-21T10:00Z
      const when = new Date(String(args.flags.get("when") ?? "2026-06-21T10:00:00Z"));
      if (Number.isNaN(when.getTime())) throw new Error("--when: ungültiges Datum");
      const { lat, lon } = projectLatLon(project);
      const sun = sunPosition(lat, lon, when);
      out(args, JSON.stringify({ when: when.toISOString(), lat, lon, sun, shadows: shadowPolygons(project, sun) }, null, 2), `${project.name || "projekt"}-sonne.json`);
      return 0;
    }
    case "schedule":
      out(args, exportScheduleCsv(project), `${project.name || "projekt"}-liste.csv`);
      return 0;
    case "step": {
      const r = await exportProjectStep(project, project.name || "projekt");
      if (r.skipped.length) process.stderr.write(`${r.skipped.length} Körper übersprungen/ungeschnitten.\n`);
      out(args, r.text, `${project.name || "projekt"}.stp`);
      return 0;
    }
    case "import-ifc": {
      const src = rest[0];
      if (!src) fail("import-ifc: IFC-Datei fehlt");
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(readFileSync(src));
      } catch (e) {
        fail(`Datei nicht lesbar: ${src} (${e instanceof Error ? e.message : String(e)})`);
      }
      const { products, report } = await readIfc(bytes);
      const group = args.flags.get("group");
      const meshes = ifcToImportedMeshes(products, src.split(/[\\/]/).pop() ?? src, {
        geoOrigin: projectGeoOrigin(project),
        group: group === "product" || group === "class" ? group : "auto",
      });
      const byClass: Record<string, number> = {};
      for (const p of products) byClass[p.ifcClass] = (byClass[p.ifcClass] ?? 0) + 1;
      const triangles = products.reduce((s, p) => s + p.indices.length / 3, 0);
      process.stdout.write(JSON.stringify({ ...report, byClass, triangles, contextObjects: meshes.length }, null, 2) + "\n");
      const target = args.flags.get("out");
      if (target) {
        const next = applyOps(project, diffToOps(project, {
          ...project,
          context: [...(project.context ?? []), ...meshes],
          // Wie in der App (siteSlice): fehlende Kontext-Kategorie als Ebene ergänzen.
          layers: ensureContextCategories(project.layers, meshes.flatMap((m) => (m.categoryCode ? [m.categoryCode] : []))),
        }));
        out(args, serializeProject(next), target);
      }
      return 0;
    }
    case "mcp":
      await serveStdio(file);
      return 0;
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
