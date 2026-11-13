// dossier-cli — der Kern ohne UI (lessons-bimcraft [4], docs/core-ui-split.md Phase C).
// Importiert AUSSCHLIESSLICH `../core` (Wächter-Test `src/cli/boundary.test.ts`). Gebaut mit
// `npm run build:cli` → dist-cli/dossier-cli.mjs; aufgerufen mit `node dist-cli/dossier-cli.mjs`.
//
//   dossier-cli <projekt.obp> info
//   dossier-cli <projekt.obp> validate
//   dossier-cli <projekt.obp> migrate [--out neu.obp]
//   dossier-cli <projekt.obp> plan [--level EG] [--ceiling] [--scale 100] [--sketch] [--hatch] [--color] [--format svg|json] [--out eg.svg]
//                                                  json = render2d-Szene (planToRenderScene)
//   dossier-cli <projekt.obp> section <Name> [--sketch] [--hatch] [--color] [--out schnitt.svg]       (--format json: render2d-Szene)
//   dossier-cli <projekt.obp> elevation <Name> [--sketch] [--hatch] [--color] [--out ansicht.svg]     (--sketch: Skizzenstil [67])
//                                                  section/elevation: --format dxf|dxfbin|dwg schreibt die Zeichnung als CAD-Datei [200]
//                                                  (Modell-Space in Metern: x entlang der Schnitt-/Ansichtslinie, y = Höhe; --scale, --dim-unit cm, --layout wie bei dxf)
//                                                  --color: Darstellung „Farbig" statt Tusche (Standard, [140])
//                                                  plan/section/elevation: --template <Vorlage> wendet eine Ansichtsvorlage ganz an
//                                                  (Ebenen-Felder wie verdeckte Kanten/Schnittflächen schraffiert/Schatten/Skizze,
//                                                  Detailgrad, Massstab, Tusche/Farbe, ausgeblendete Kategorien, Override-Regeln;
//                                                  --scale/--color gehen vor; ohne Flag gilt die an der Ebene verknüpfte Vorlage [34]), --rule <Regel> schaltet eine
//                                                  Override-Regel ein (auch Standard-Baustein, z. B. --rule "Deckenaufbau weiss") [33];
//                                                  das Massstab-Kriterium einer Regel (ab/bis 1:n) gilt nach --scale;
//                                                  --model-view <Name> wählt eine Modelldarstellung (eigene Stufe oder grob/mittel/fein) [173]
//                                                  --hide <Code|Name,…> blendet Klassen aus (z. B. --hide "Schatten,Auto-Bemassung") [180]
//                                                  --snapshot <Name|id> übernimmt Geschoss, Massstab, Vorlage und Sichtbarkeit eines Ausschnitts [207]
//   dossier-cli <projekt.obp> ifc [--ebkph] [--ebenen]   (IFC mit eBKP-H-Hauptgruppen bzw. Modell-Ebenen als Klassifikation)
//                                                  --schema 4|2x3: IFC4 (Standard) oder IFC2x3 (Coordination View 2.0)
//   dossier-cli <projekt.obp> dxf [--binary] [--scale 100] [--dim-unit cm] [--layout]|dwg|ifc|step|obj [--no-mtl]|stl|glb|gltf|schedule [--openings|--elements|--rooms] [--format json|csv|svg|pdf]|kennzahlen [--sia416] [--ivhb] [--format json|csv|svg|pdf] [--agsf m2] [--gruenflaeche m2] [--agf-basis gf|ngf|nf] [--untergeschosse]|raumprogramm [--import tabelle] [--sheet name|nr] [--mode replace|append] [--tolerance %] [--generate] [--format json|csv|svg|pdf] [--save projekt.obp]|sun [--level EG] [--out datei]
//                                                  glb/gltf = glTF 2.0 (Y-up, Meter, Geschoss als Eltern; --flat ohne Geschoss-Knoten)
//   dossier-cli convert <eingabe> <ausgabe> [--cmd "befehl"]…   Format nach Endung: dxf/dwg/ifc/obp → obp-Import,
//                                                  obp → dxf/dwg/ifc/obj/stl/glb/gltf/step; --cmd: weitere Befehle
//                                                  gegen das Ergebnis, {last} = zuletzt geschriebene Datei
//   dossier-cli <projekt.obp> import-ifc <datei.ifc> [--out neu.obp] [--group product|class] [--elements]
//                                                  IFC als Kontext-Meshes ([B3]), mit --elements als echte
//                                                  Bauteile ([B4]); Bericht als JSON auf stdout
//   dossier-cli <projekt.obp> import-mesh <datei.obj|stl|gltf|glb|ply> [--out neu.obp] [--unit mm|cm|m|inch|foot] [--up z|y|auto]
//                                                  [--placement center|original]   3D-Modell als Kontext-Meshes; Bericht als JSON
//   dossier-cli <projekt.obp> erkennen [--level EG] [--source ebene] [--out neu.obp]
//                                                  [154] Bauteile aus 2D-Zeichnung erkennen (Wände, Öffnungen, Räume
//                                                  ins Geschoss); Bericht als JSON. Z. B. convert plan.dxf p.obp --cmd "erkennen --out e.obp"
//   dossier-cli <projekt.obp> render --out bild.png [--view iso|perspective|front|back|left|right|top] [--when 2026-06-21T10:00Z]
//                                                  [--camera Name|id] [--samples 128] [--size 1920x1080] [--cpu] [--excavation] [--blender pfad] [--keep]   [211] [227] (--excavation: Baugrube im Bild lassen) Rendering mit Blender/Cycles
//   dossier-cli <projekt.obp> blend --out x.blend [--view …] [--camera …] [--when …] [--samples 128] [--size 1920x1080] [--cpu] [--excavation] [--blender pfad] [--keep]   [228] Szene als .blend (Collections nach Bauteil, Bilder eingepackt, Kamera «Dossier-Kamera»), ohne zu rendern
//   dossier-cli <projekt.obp> model3d [--explode 3] [--hide …] [--grey …] [--out modell.json]   3D-Modell fürs Headless-Rendern (render_png)
//   dossier-cli pointcloud-info <datei.las|laz|e57|ply|xyz|pts> [--voxel 0.05] [--max 2000000]
//                                                  Punktwolke lesen ([B9]) und Bericht als JSON (ohne Projekt)
//   dossier-cli pdf-info <datei.pdf> [--page 1]    Vektor-PDF lesen ([76]): Seiten, Pfade, Texte, BBox (pt) als JSON
//   dossier-cli convert plan.pdf plan.obp [--scale 100] [--page 1] [--no-text]
//                                                  Vektor-PDF als 2D-Zeichnung (Ebenen nach Farbe/Strichstärke)
//   dossier-cli <projekt.obp> mcp                  MCP-Server (stdio) auf der Datei: Werkzeuge aus core/aiToolDefs.ts
//   dossier-cli mcp --app [--port 7979] [--token …] MCP-Brücke zur offenen App ([9], KI-Zugriff in den Einstellungen)
//   dossier-cli <projekt.obp> bench [--runs 10]      Zeitprofil der Ableitungen (ms je Aufruf)
//   dossier-cli bench --big [--floors 8 --apartments 15]   dasselbe am parametrischen Grossgebäude (`:gross`, [20])
//
// Statt einer Datei nimmt `:beispiel` das eingebaute Demo-Haus (sampleProject), `:musterhaus-komplex` das
// grosse Beispiel (model/sampleProjectComplex.ts; als Datei: `dossier-cli :musterhaus-komplex migrate --out mk.obp`),
// `:wettbewerb` das Wettbewerbs-Beispiel der Kurzanleitung (model/sampleProjectWettbewerb.ts, [210]).
//
// WASM-Pakete (src/engine/pkg*) werden aus DOSSIER_WASM_DIR bzw. `<repo>/src/engine` gelesen.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildPlanDxf,
  buildPlanDwg,
  buildPlanDxfBinary,
  loadFileio,
  readPointCloudFlat,
  readPdfVector,
  pdfImport,
  pdfPageInfo,
  readIfcFlat,
  readMesh,
  isMeshFile,
  MESH_UNITS,
  sharedDocument,
  projectToWorldCoords,
  computeSection,
  exportIfcSpf,
  exportObj,
  exportMtl,
  exportProjectStep,
  exportScheduleCsv,
  computeKennzahlen,
  computeAreaTable,
  computeIvhb,
  buildAreaReport,
  buildOpeningReport,
  openingSchedule,
  elementSchedule,
  roomBook,
  buildRoomBookReport,
  buildElementReport,
  areaReportToCsv,
  areaReportToSvg,
  buildAreaReportPdf,
  exportProjectName,
  sunPosition,
  shadowPolygons,
  projectLatLon,
  checkRoomProgram,
  compareRoomProgram,
  readSheetFile,
  suggestMapping,
  mapRows,
  importedRows,
  applyRoomProgram,
  buildProgramReport,
  buildProgramSheet,
  addProgramSheet,
  defaultSheetLabels,
  checkSiteRules,
  excavationQuantities,
  exportStl,
  exportGlb,
  exportGltf,
  parseDxf,
  emptyProject,
  generateElevationPlan,
  applyOps,
  patchItem,
  generatePlan,
  generateSectionPlan,
  viewportLevelPlan,
  planToRenderScene,
  projectToModel3d,
  pathtraceMaterials,
  emitDrawingLineVerts,
  emitSurfacePatternLines,
  ghostFilter3d,
  parseProjectFile,
  planToSvgString,
  serializeProject,
  parseBcf,
  bcfInfo,
  setWasmBytesProvider,
  initCore,
  validateProject,
  projectWarnings,
  sampleProject,
  buildComplexSampleProject,
  buildWettbewerbSampleProject,
  buildBigSampleProject,
  withDocument,
  AI_BRIDGE_DEFAULT_PORT,
  standardOverrideRules,
  linkedViewTemplate,
  projectWithTemplate,
  templateDisplay,
  recognizeMutation,
  recognizeReport,
  recognizeSourceLevels,
  buildRenderPackage,
  runBlenderRender,
  runBlenderSave,
  defaultRenderTime,
  BlenderMissingError,
  BLENDER_CANDIDATES,
  BLENDER_DOWNLOAD_URL,
  RENDER_VIEW_PRESETS,
  findRenderCamera,
  projectRenderCameras,
} from "../core";
import type { BlenderHost, Filter3d, Project, RenderMode, RenderPackage, RenderViewPreset, TextureLoader, ViewTemplate } from "../core";
import { serveStdio } from "./mcp";
import { startBridge } from "./mcpBridge";

type Args = { positional: string[]; flags: Map<string, string>; cmds: string[] };

/** `--schema 4|ifc4|2x3|ifc2x3` → IFC-Schema des Exports (ohne Angabe IFC4). */
function ifcSchemaFlag(args: Args): "IFC4" | "IFC2X3" {
  const v = args.flags.get("schema");
  if (v === undefined) return "IFC4";
  const k = v.toLowerCase().replace(/^ifc/, "");
  if (k === "4") return "IFC4";
  if (k === "2x3") return "IFC2X3";
  return fail(`--schema: "${v}" unbekannt (4 oder 2x3)`);
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  const cmds: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) flags.set(a.slice(2), "true");
      else {
        // `--cmd` darf mehrfach vorkommen (Reihenfolge bleibt), bei allen anderen Flags gilt das letzte.
        if (a === "--cmd") cmds.push(next);
        else flags.set(a.slice(2), next);
        i++;
      }
    } else positional.push(a);
  }
  return { positional, flags, cmds };
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

function loadProject(path: string, args: Args): Project {
  if (path === ":beispiel") return sampleProject;
  if (path === ":musterhaus-komplex") return buildComplexSampleProject();
  if (path === ":wettbewerb") return buildWettbewerbSampleProject();
  if (path === ":gross") return buildBigSampleProject({ floors: Number(args.flags.get("floors") ?? 8), apartments: Number(args.flags.get("apartments") ?? 15) });
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
  const levels = project.drawingLevels.filter((l) => kinds.includes(l.kind) && !l.layoutId);
  if (!name) return levels[0];
  const n = name.toLowerCase();
  return levels.find((l) => l.id.toLowerCase() === n || l.name.toLowerCase() === n);
}

/**
 * [33]/[34] Wirksame Ansichtsvorlage der Ebene: `--template <Name|id>`, sonst die an der Ebene verknüpfte
 * (`templateLinked`). Gilt vollständig für Grundriss, Schnitt und Ansicht: Ebenen-Felder (Schnitthöhe,
 * Ansichtsbereich, Schatten, verdeckte Kanten, Skizze, Schnittflächen schraffiert, Bodenbelag, Gelände),
 * Override-Regeln, Strichstärken nach Massstab, dazu Detailgrad, Massstab, Tusche/Farbe und ausgeblendete
 * Kategorien ({@link templateView}).
 */
function templateFor(project: Project, levelId: string, args: Args): ViewTemplate | undefined {
  const tName = args.flags.get("template");
  if (tName) {
    const n = tName.toLowerCase();
    const tpl = (project.viewTemplates ?? []).find((x) => x.id.toLowerCase() === n || x.name.toLowerCase() === n);
    if (!tpl) fail(`Ansichtsvorlage nicht gefunden: ${tName}`);
    return tpl;
  }
  return linkedViewTemplate(project, project.drawingLevels.find((l) => l.id === levelId));
}

/** [180] --hide <Code|Name,…>: Klassen ausblenden (z. B. --hide "Schatten,Auto-Bemassung"); Codes. */
function hideFlagCodes(project: Project, args: Args, flag = "hide"): string[] {
  const out: string[] = [];
  for (const w of (args.flags.get(flag) ?? "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean)) {
    const find = (ls: Project["layers"]): string | undefined => {
      for (const l of ls) {
        if (l.code.toLowerCase() === w || l.name.toLowerCase() === w) return l.code;
        const c = l.children ? find(l.children) : undefined;
        if (c) return c;
      }
      return undefined;
    };
    const code = find(project.layers);
    if (!code) fail(`Klasse nicht gefunden: ${w}`);
    out.push(code);
  }
  return out;
}

/** [180] --grey-floor <id|Name,…>: Geschosse (Zeichnungsebenen) im Modus „grau"; Ids. */
function greyFloorIds(project: Project, args: Args): string[] {
  return (args.flags.get("grey-floor") ?? "")
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean)
    .map((w) => {
      const l = project.drawingLevels.find((d) => d.id.toLowerCase() === w || d.name.toLowerCase() === w);
      if (!l) fail(`Geschoss nicht gefunden: ${w}`);
      return l.id;
    });
}

/** Darstellung einer Ebene nach Vorlage und Aufruf: ausdrückliche Optionen (`--scale`, `--color`) gehen vor. */
function templateView(project: Project, levelId: string, args: Args, allCodes: Set<string>) {
  const tpl = templateFor(project, levelId, args);
  const d = templateDisplay(tpl);
  const hidden = new Set(d.hiddenCodes);
  for (const code of hideFlagCodes(project, args)) hidden.add(code);
  return {
    tpl,
    detail: d.detail,
    scale: args.flags.has("scale") ? Number(args.flags.get("scale")) : (d.scaleDenominator ?? 100),
    mono: args.flags.has("color") ? inkArg(args) : (d.mono ?? true),
    codes: hidden.size ? new Set([...allCodes].filter((c) => !hidden.has(c))) : allCodes,
  };
}

/**
 * [33]/[34] Ansichtsvorlage `tpl` auf die Ebene anwenden; `--rule <Name|id>`: eine Override-Regel einschalten —
 * fehlt sie im Projekt, aus den Standard-Bausteinen (z. B. „Deckenaufbau weiss").
 */
function withTemplate(project: Project, levelId: string, tpl: ViewTemplate | undefined, args: Args): Project {
  let p = tpl ? projectWithTemplate(project, levelId, tpl, true) : project;
  const rName = args.flags.get("rule");
  if (rName) {
    const n = rName.toLowerCase();
    const hit = (r: { id: string; name: string }) => r.id.toLowerCase() === n || r.name.toLowerCase() === n;
    const rules = p.overrideRules ?? [];
    if (rules.some(hit)) p = { ...p, overrideRules: rules.map((r) => (hit(r) ? { ...r, enabled: true } : r)) };
    else {
      const std = standardOverrideRules(p).find(hit);
      if (!std) fail(`Override-Regel nicht gefunden: ${rName}`);
      p = { ...p, overrideRules: [...rules, { ...std, enabled: true }] };
    }
  }
  // [173] `--model-view <Name|id>`: Modelldarstellung der Ebene (eigene Stufe oder grob/mittel/fein); geht der Vorlage vor.
  const mName = args.flags.get("model-view");
  if (mName) {
    const n = mName.toLowerCase();
    const builtin = ["grob", "mittel", "fein"].find((b) => b === n);
    const mv = builtin ?? (p.modelViewOptions ?? []).find((m) => m.id.toLowerCase() === n || m.name.toLowerCase() === n)?.id;
    if (!mv) fail(`Modelldarstellung nicht gefunden: ${mName} (vorhanden: grob, mittel, fein${(p.modelViewOptions ?? []).map((m) => `, ${m.name}`).join("")})`);
    p = { ...p, drawingLevels: p.drawingLevels.map((l) => (l.id === levelId ? { ...l, modelViewOptionId: mv } : l)) };
  }
  return p;
}

/** `--sketch` ([67]): die Ebene im Skizzenstil (wie `DrawingLevel.sketch`); sonst das Projekt unverändert. */
function withSketch(project: Project, levelId: string, args: Args): Project {
  if (!args.flags.has("sketch")) return project;
  return { ...project, drawingLevels: project.drawingLevels.map((l) => (l.id === levelId ? { ...l, sketch: true } : l)) };
}

/** Zuletzt geschriebene Datei (für `{last}` in `--cmd`). */
let lastOutput = "";

function out(args: Args, text: string | Uint8Array, defaultName: string): void {
  const target = args.flags.get("out") ?? defaultName;
  lastOutput = target;
  if (target === "-") process.stdout.write(text);
  else {
    writeFileSync(target, text);
    const size = typeof text === "string" ? `${text.length} Zeichen` : `${text.length} Bytes`;
    process.stderr.write(`geschrieben: ${target} (${size})\n`);
  }
}

/** `dossier-cli bcf-info <datei.bcfzip>`: Themen einer BCF-Datei (2.1/3.0) als JSON, ohne Snapshot-Bytes. */
async function runBcfInfo(path: string | undefined): Promise<number> {
  if (!path) {
    process.stderr.write("Aufruf: dossier-cli bcf-info <datei.bcfzip>\n");
    return 2;
  }
  setWasmBytesProvider(async (name) => {
    const rel = WASM_FILES[name];
    if (!rel) throw new Error(`unbekanntes WASM-Modul ${name}`);
    return readFileSync(join(wasmDir(), rel));
  });
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(readFileSync(path));
  } catch (e) {
    fail(`Datei nicht lesbar: ${path} (${e instanceof Error ? e.message : String(e)})`);
  }
  try {
    process.stdout.write(JSON.stringify(bcfInfo(await parseBcf(bytes)), null, 2) + "\n");
  } catch (e) {
    fail(`BCF: ${e instanceof Error ? e.message : String(e)}`);
  }
  return 0;
}

/** `--page n` (1-basiert) → Seitenindex (0-basiert). */
function pageArg(args: Args): number {
  const v = Number(args.flags.get("page") ?? 1);
  if (!Number.isInteger(v) || v < 1) fail("--page: ganze Zahl ab 1");
  return v - 1;
}

/** `pdf-info <datei.pdf> [--page 1]`: Seitenzahl, Pfade/Texte/Bilder, Umriss (pt) und Ebenen als JSON. */
async function runPdfInfo(args: Args, path: string | undefined): Promise<number> {
  if (!path) {
    process.stderr.write("Aufruf: dossier-cli pdf-info <datei.pdf> [--page 1]\n");
    return 2;
  }
  setWasmBytesProvider(async (name) => {
    const rel = WASM_FILES[name];
    if (!rel) throw new Error(`unbekanntes WASM-Modul ${name}`);
    return readFileSync(join(wasmDir(), rel));
  });
  await loadFileio();
  await initCore();
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(readFileSync(path));
  } catch (e) {
    fail(`Datei nicht lesbar: ${path} (${e instanceof Error ? e.message : String(e)})`);
  }
  const t0 = performance.now();
  let read;
  try {
    read = readPdfVector(bytes, pageArg(args));
  } catch (e) {
    fail(`${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const ms = Math.round(performance.now() - t0);
  process.stdout.write(JSON.stringify({ file: path, bytes: bytes.byteLength, ms, ...pdfPageInfo(read) }, null, 2) + "\n");
  return 0;
}

/** `pointcloud-info <datei> [--voxel m] [--max n]`: liest und dünnt aus, gibt den Bericht als JSON aus. */
async function pointCloudInfo(args: Args, src: string | undefined): Promise<number> {
  if (!src) fail("pointcloud-info: Datei fehlt (Aufruf: pointcloud-info <datei> [--voxel 0.05] [--max 2000000])");
  setWasmBytesProvider(async (name) => {
    const rel = WASM_FILES[name];
    if (!rel) throw new Error(`unbekanntes WASM-Modul ${name}`);
    return readFileSync(join(wasmDir(), rel));
  });
  await loadFileio();
  let bytes: Buffer;
  try {
    bytes = readFileSync(src);
  } catch (e) {
    fail(`Datei nicht lesbar: ${src} (${e instanceof Error ? e.message : String(e)})`);
  }
  const num = (k: string, d: number): number => {
    const v = Number(args.flags.get(k) ?? d);
    if (!Number.isFinite(v) || v < 0) fail(`--${k}: keine gültige Zahl`);
    return v;
  };
  const t0 = performance.now();
  let cloud;
  try {
    cloud = readPointCloudFlat(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), src, {
      voxel: num("voxel", 0),
      maxPoints: num("max", 2_000_000),
    });
  } catch (e) {
    fail(`${src}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const ms = Math.round(performance.now() - t0);
  process.stdout.write(JSON.stringify({ file: src, bytes: bytes.byteLength, ms, ...cloud.report }, null, 2) + "\n");
  return 0;
}

export async function run(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const convertMode = args.positional[0] === "convert";
  // `dossier-cli bench --big [--floors 8 --apartments 15]` = `dossier-cli :gross bench` ([20]).
  if (args.positional[0] === "bench" && args.flags.has("big")) args.positional.unshift(":gross");
  const [file, command, ...rest] = args.positional;
  if (file === "bcf-info") return runBcfInfo(command);
  if (file === "pointcloud-info") return pointCloudInfo(args, command);
  if (file === "pdf-info") return runPdfInfo(args, command);
  if (file === "mcp" && args.flags.has("app")) return runAppBridge(args);
  if (!file || (!command && args.cmds.length === 0)) {
    process.stderr.write(
      "Aufruf: dossier-cli <projekt.obp> <info|validate|migrate|plan|section|elevation|dxf|dwg|ifc|import-ifc|import-mesh|erkennen|step|obj [--no-mtl]|stl|glb|gltf|schedule|kennzahlen|raumprogramm|sun|model3d|render|blend> [Optionen]\n" +
        "        dossier-cli convert <eingabe.dxf|dwg|ifc|pdf|obj|stl|gltf|glb|ply|obp> <ausgabe.obp|dxf|dwg|ifc|obj|stl|glb|gltf|step> [--cmd \"befehl …\"]…\n" +
        "        dossier-cli <projekt.obp> --cmd \"befehl …\" [--cmd …]   ({last} = zuletzt geschriebene Datei)\n" +
        "        dossier-cli pointcloud-info <datei> [--voxel 0.05] [--max 2000000]\n" +
        "        dossier-cli bcf-info <datei.bcfzip>\n" +
        "        dossier-cli pdf-info <datei.pdf> [--page 1]\n" +
        "        dossier-cli mcp --app [--port 7979] [--token schlüssel]   (MCP-Brücke zur offenen App)\n",
    );
    return 2;
  }
  setWasmBytesProvider(async (name) => {
    const rel = WASM_FILES[name];
    if (!rel) throw new Error(`unbekanntes WASM-Modul ${name}`);
    return readFileSync(join(wasmDir(), rel));
  });
  await initCore();
  if (convertMode) return convert(command, rest[0], args);
  const project = loadProject(file, args);
  let code = 0;
  if (command) code = await execute(project, file, command, rest, args);
  return code === 0 ? runCmds(project, file, args) : code;
}

/**
 * [9] `dossier-cli mcp --app [--port 7979] [--token …]`: MCP über stdio, Werkzeuge laufen in der offenen App.
 * Schlüssel aus `--token` oder `DOSSIER_AI_TOKEN` (Einstellungen der App → KI-Zugriff).
 */
async function runAppBridge(args: Args): Promise<number> {
  const token = args.flags.get("token") ?? process.env.DOSSIER_AI_TOKEN ?? "";
  if (!token || token === "true") fail("mcp --app: Schlüssel fehlt (--token oder DOSSIER_AI_TOKEN, s. Einstellungen der App → KI-Zugriff)");
  const port = Number(args.flags.get("port") ?? AI_BRIDGE_DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail("--port: 1 bis 65535");
  let bridge;
  try {
    bridge = await startBridge({ port, token });
  } catch (e) {
    fail(`mcp --app: Port ${port} nicht verfügbar (${e instanceof Error ? e.message : String(e)})`);
  }
  process.stderr.write(`Dossier MCP-Brücke auf 127.0.0.1:${bridge.port} — wartet auf die App.\n`);
  await serveStdio(bridge.handle);
  await bridge.close();
  return 0;
}

/** Endung (klein, ohne Punkt) eines Dateinamens. */
const extOf = (path: string): string => (path.includes(".") ? (path.split(".").pop() ?? "").toLowerCase() : "");

/** Zerlegt eine `--cmd`-Zeile in Wörter (Anführungszeichen "…" und '…' fassen zusammen). */
function splitCommand(line: string): string[] {
  return [...line.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
}

/** Führt alle `--cmd` der Reihe nach gegen das Projekt aus; `{last}` = zuletzt geschriebene Datei. Bricht beim ersten Fehler ab. */
async function runCmds(project: Project, file: string, args: Args): Promise<number> {
  for (const line of args.cmds) {
    const words = splitCommand(line.replaceAll("{last}", lastOutput));
    const sub = parseArgs(words);
    const [command, ...rest] = sub.positional;
    if (!command) fail("--cmd: leerer Befehl");
    const code = await execute(project, file, command, rest, sub);
    if (code !== 0) return code;
  }
  return 0;
}

/**
 * Dokument für einen Import ([K4] S4): das gemeinsame Abfrage-Dokument mit `project` geladen — danach spiegelt
 * es das Ergebnis, Speichern und Abfragen darauf brauchen keinen neuen Abgleich (grosse Kataster-Importe).
 */
function importDoc(project: Project) {
  const doc = sharedDocument();
  doc.load(project);
  return doc;
}

/** Liest Eingabe nach Endung in ein Projekt: obp direkt, dxf/dwg als 2D-Zeichnung + Meshes, ifc als Kontext-Meshes (`--elements`: Bauteile). */
async function importAny(path: string, args: Args): Promise<Project> {
  const ext = extOf(path);
  if (ext === "obp" || ext === "json" || path === ":beispiel" || path === ":musterhaus-komplex" || path === ":wettbewerb") return loadProject(path, args);
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(readFileSync(path));
  } catch (e) {
    return fail(`Datei nicht lesbar: ${path} (${e instanceof Error ? e.message : String(e)})`);
  }
  const fileName = path.split(/[\\/]/).pop() ?? path;
  const base: Project = { ...emptyProject, name: fileName.replace(/\.[^.]+$/, "") };
  if (ext === "ifc") return (await ifcInto(base, bytes, fileName, args)).next;
  if (isMeshFile(fileName)) return (await meshInto(base, bytes, path, args)).next;
  if (ext === "dxf" || ext === "dwg" || ext === "pdf") {
    await loadFileio();
    let parsed;
    try {
      // Vektor-PDF ([76]): Massstab 1:--scale (Standard 100), Seite --page (Standard 1).
      if (ext === "pdf") {
        const scale = Number(args.flags.get("scale") ?? 100);
        if (!Number.isFinite(scale) || scale <= 0) return fail("--scale: Massstabszahl > 0, z. B. 100 für 1:100");
        parsed = pdfImport(readPdfVector(bytes, pageArg(args)), scale, { texts: !args.flags.has("no-text") });
      } else parsed = parseDxf(bytes);
    } catch (e) {
      return fail(`${path}: ${e instanceof Error ? e.message : String(e)}`);
    }
    const level = base.drawingLevels.find((l) => l.kind === "floor");
    if (!level) return fail("kein Geschoss für den Import");
    // Wie die App („Layer als Kategorien", ein Undo-Schritt im Kern): fehlende Layer als Unterkategorien einer
    // neuen Elternkategorie, Linienstile der PDF-Strichmuster, Meshes als Kontext.
    const r = importDoc(base).importDrawing(
      base,
      parsed.src,
      {
        target: { kind: "existing", levelId: level.id },
        categoryMode: "byLayer",
        activeCategoryCode: base.layers[0].code,
        importMeshes: true,
        terrainContours: (parsed.summary.terrainContours ?? 0) > 0,
        terrainName: "Höhenlinien",
        parentName: `Import ${fileName}`,
        dashStyleTemplate: "PDF-Strich {pattern} mm",
        geoLabel: fileName,
      },
      Date.now(),
    );
    if ("problems" in r) return fail(`${path}: ${r.problems.join("; ")}`);
    return r.project;
  }
  return fail(`Eingabeformat nicht unterstützt: .${ext} (obp, dxf, dwg, ifc, pdf, obj, stl, gltf, glb, ply)`);
}

/** [140] Darstellung wie der App-Standard „Tusche" (Schwarz-Weiss); `--color` = „Farbig". */
function inkArg(args: Args): boolean {
  return !(args.flags.has("color") && args.flags.get("color") !== "false");
}

/** `convert <eingabe> <ausgabe>`: Eingabe nach Endung lesen, Ausgabe nach Endung schreiben, dann `--cmd` ausführen. */
async function convert(input: string | undefined, output: string | undefined, args: Args): Promise<number> {
  if (!input || !output) {
    process.stderr.write("Aufruf: dossier-cli convert <eingabe> <ausgabe> [--cmd \"befehl\"]…\n");
    return 2;
  }
  const project = await importAny(input, args);
  const ext = extOf(output);
  const sub: Args = { positional: [], flags: new Map(args.flags), cmds: [] };
  sub.flags.set("out", output);
  let code: number;
  switch (ext) {
    case "obp":
      out(sub, serializeProject(project), output);
      code = 0;
      break;
    case "dxf":
    case "dwg":
    case "ifc":
    case "obj":
    case "stl":
    case "glb":
    case "gltf":
      code = await execute(project, input, ext, [], sub);
      break;
    case "step":
    case "stp":
      code = await execute(project, input, "step", [], sub);
      break;
    default:
      return fail(`Ausgabeformat nicht unterstützt: .${ext} (obp, dxf, dwg, ifc, obj, stl, glb, gltf, step)`);
  }
  return code === 0 ? runCmds(project, input, args) : code;
}

/** IFC in ein Projekt übernehmen (Kontext-Meshes, mit `--elements` als Bauteile; Kern, ein Schritt); `report` = Bericht für `import-ifc`. */
async function ifcInto(project: Project, bytes: Uint8Array, fileName: string, args: Args): Promise<{ next: Project; report: unknown }> {
  const group = args.flags.get("group");
  const grouping = group === "product" || group === "class" ? group : "auto";
  const elements = args.flags.has("elements");
  const flat = await readIfcFlat(bytes, elements);
  const r = importDoc(project).importIfc(project, flat, { fileName, group: grouping, elements }, Date.now());
  if ("problems" in r) return fail(`${fileName}: ${r.problems.join("; ")}`);
  const report = elements
    ? { ...r.report, products: undefined, byClass: undefined, triangles: undefined, kept: r.kept }
    : { ...r.report, contextObjects: r.contextObjects };
  return { next: r.project, report };
}

/** Begleitdateien eines Mesh-Modells aus demselben Verzeichnis: `.mtl` (OBJ `mtllib`), externe `.bin` (glTF). */
function meshSidecars(path: string, bytes: Uint8Array): { name: string; bytes: Uint8Array }[] {
  const names: string[] = [];
  const ext = extOf(path);
  if (ext === "obj") {
    for (const m of new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 1 << 20))).matchAll(/^mtllib[ \t]+(.+)$/gm)) {
      names.push(...m[1].trim().split(/\s+/));
    }
  } else if (ext === "gltf") {
    try {
      const j = JSON.parse(new TextDecoder().decode(bytes)) as { buffers?: { uri?: string }[] };
      for (const b of j.buffers ?? []) if (b.uri && !b.uri.startsWith("data:")) names.push(decodeURIComponent(b.uri));
    } catch {
      /* kaputtes JSON meldet der Leser */
    }
  }
  const out: { name: string; bytes: Uint8Array }[] = [];
  for (const n of names) {
    try {
      out.push({ name: n, bytes: new Uint8Array(readFileSync(join(dirname(path), n))) });
    } catch {
      /* fehlende Datei meldet der Leser (MTL: Hinweis, glTF: Fehler) */
    }
  }
  return out;
}

/** 3D-Modell (OBJ/STL/glTF/GLB/PLY) als Kontext-Meshes in ein Projekt übernehmen; `report` = Bericht für `import-mesh`. */
async function meshInto(project: Project, bytes: Uint8Array, path: string, args: Args): Promise<{ next: Project; report: unknown }> {
  const fileName = path.split(/[\\/]/).pop() ?? path;
  const unit = args.flags.get("unit") ?? "m";
  if (!(MESH_UNITS as readonly string[]).includes(unit)) return fail(`--unit: ${MESH_UNITS.join("|")}`);
  const up = args.flags.get("up") ?? "auto";
  if (up !== "auto" && up !== "z" && up !== "y") return fail("--up: z|y|auto");
  const placement = args.flags.get("placement") ?? "original";
  if (placement !== "center" && placement !== "original") return fail("--placement: center|original");
  let read;
  try {
    read = await readMesh(bytes, fileName, { unit: unit as (typeof MESH_UNITS)[number], up, files: meshSidecars(path, bytes) });
  } catch (e) {
    return fail(`${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const r = importDoc(project).importMesh(project, read.flat, { fileName, placement }, Date.now());
  if ("problems" in r) return fail(`${path}: ${r.problems.join("; ")}`);
  return { next: r.project, report: { ...read.report, contextObjects: r.contextObjects } };
}

/** [211] Das Blender-Skript: neben `dist-cli/` (`<repo>/scripts/blender`) bzw. aus `src/cli/` (Vitest); `--script` übersteuert. */
function renderScript(args: Args): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const own = args.flags.get("script");
  const candidates = own ? [own] : [resolve(here, "..", "scripts", "blender", "render_dossier.py"), resolve(here, "..", "..", "scripts", "blender", "render_dossier.py")];
  const found = candidates.find((c) => existsSync(c));
  if (!found) return fail(`render: Blender-Skript nicht gefunden (${candidates.join(", ")})`);
  return readFileSync(found, "utf8");
}

/** [211] Bildkarten der mitgelieferten Materialien (`/assets/materials/…` unter `<repo>/public`); Web-Adressen lädt die CLI nicht. */
function localTextureLoader(): TextureLoader {
  const here = dirname(fileURLToPath(import.meta.url));
  const roots = [resolve(here, "..", "public"), resolve(here, "..", "..", "public")];
  return async (url) => {
    if (/^[a-z]+:/i.test(url)) return null;
    for (const r of roots) {
      const p = join(r, url);
      if (existsSync(p)) return new Uint8Array(readFileSync(p));
    }
    return null;
  };
}

/** [211] Blender als Kindprozess (Node): Programmdatei suchen, Arbeitsordner im Temp-Ordner, Ausgabe zeilenweise. */
function nodeBlenderHost(keep: boolean): BlenderHost {
  let dir = "";
  return {
    async find(custom) {
      const c = custom?.trim();
      if (c) {
        if (existsSync(c)) return c;
        const inner = join(c, "Contents", "MacOS", "Blender");
        return existsSync(inner) ? inner : null;
      }
      for (const d of (process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":")) {
        if (d && existsSync(join(d, "blender"))) return join(d, "blender");
      }
      return BLENDER_CANDIDATES.find((p) => existsSync(p)) ?? null;
    },
    async prepare(files) {
      dir = mkdtempSync(join(tmpdir(), "dossier-render-"));
      for (const f of files) {
        const target = join(dir, f.path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, f.bytes);
      }
      if (keep) process.stderr.write(`Arbeitsordner: ${dir}\n`);
      return dir;
    },
    spawn(exe, argv, onLine) {
      const child = spawn(exe, argv, { stdio: ["ignore", "pipe", "pipe"] });
      const feed = (): ((d: Buffer) => void) => {
        let rest = "";
        return (d) => {
          const parts = (rest + d.toString("utf8")).split(/[\r\n]+/);
          rest = parts.pop() ?? "";
          for (const p of parts) if (p) onLine(p);
        };
      };
      child.stdout.on("data", feed());
      child.stderr.on("data", feed());
      const done = new Promise<number>((res) => {
        child.on("error", (e) => {
          onLine(`DOSSIER_ERROR ${e.message}`);
          res(1);
        });
        child.on("close", (code) => res(code ?? -1));
      });
      return { done, cancel: () => void child.kill() };
    },
    async readFile(path) {
      return new Uint8Array(readFileSync(path));
    },
    async launch(exe, argv) {
      spawn(exe, argv, { detached: true, stdio: "ignore" }).unref();
    },
    join: (d, r) => join(d, r),
  };
}

/** Optionen von `render` und `blend` ([211] [228]): Kamera, Zeit, Grösse, Samples → Paket (bei ungültigen Optionen beendet `fail()` den Prozess). */
async function buildCliPackage(project: Project, args: Args, mode: RenderMode): Promise<RenderPackage> {
  const view = (args.flags.get("view") ?? "iso") as RenderViewPreset;
  if (!(RENDER_VIEW_PRESETS as readonly string[]).includes(view)) return fail(`--view: ${RENDER_VIEW_PRESETS.join("|")}`);
  // [213] `--camera <Name|id>`: gespeicherte Kamera (Standpunkt, Ziel, Bildwinkel; Sonnenzeit der Kamera, falls `--when` fehlt).
  const camKey = args.flags.get("camera");
  const choice = camKey ? findRenderCamera(project, camKey) : null;
  if (camKey && !choice) return fail(`--camera: "${camKey}" nicht gefunden (vorhanden: ${projectRenderCameras(project).map((c) => c.name).join(", ") || "keine"})`);
  const whenText = args.flags.get("when");
  const when = whenText ? new Date(whenText) : (choice?.sunWhen ?? defaultRenderTime(project));
  if (Number.isNaN(when.getTime())) return fail("--when: ungültiges Datum");
  const samples = Number(args.flags.get("samples") ?? 128);
  if (!Number.isFinite(samples) || samples < 1) return fail("--samples: Zahl ≥ 1");
  const sizeText = args.flags.get("size") ?? "1920x1080";
  const m = /^(\d+)x(\d+)$/i.exec(sizeText);
  if (!m) return fail("--size: BreitexHöhe in Pixeln, z. B. 1920x1080");
  await loadFileio();
  const pkg = await buildRenderPackage(
    project,
    { mode, width: Number(m[1]), height: Number(m[2]), samples, when, camera: choice ? choice.camera : { preset: view }, device: args.flags.has("cpu") ? "cpu" : "auto", backfilled: !args.flags.has("excavation") },
    localTextureLoader(),
  );
  if (pkg.missingTextures.length > 0) process.stderr.write(`Hinweis: ${pkg.missingTextures.length} Bildkarten nicht lesbar (Material erscheint einfarbig)\n`);
  return pkg;
}

/** Fehlermeldung eines Blender-Laufs → Exit-Code (3 = Blender fehlt). */
function blenderFailure(e: unknown): number {
  if (e instanceof BlenderMissingError) {
    process.stderr.write(`Blender nicht gefunden. Installieren (${BLENDER_DOWNLOAD_URL}) oder --blender <pfad> angeben.\n`);
    return 3;
  }
  process.stderr.write(`dossier-cli: ${e instanceof Error ? e.message : String(e)}\n`);
  return 1;
}

/** `dossier-cli … render`: Paket bauen, Blender starten, Bild nach `--out`. Rückgabe = Exit-Code. */
async function runRender(project: Project, args: Args): Promise<number> {
  const pkg = await buildCliPackage(project, args, "render");
  const target = args.flags.get("out") ?? `${exportProjectName(project) || "projekt"}.png`;
  try {
    const res = await runBlenderRender(nodeBlenderHost(args.flags.has("keep")), pkg, {
      script: renderScript(args),
      blenderPath: args.flags.get("blender"),
      onLine: args.flags.has("verbose") ? (l) => process.stderr.write(`  ${l}\n`) : undefined,
      onProgress: (e) => {
        if (e.stage === "render" && e.done > 0 && e.total > 0 && (e.done === e.total || e.done % Math.max(1, Math.floor(e.total / 8)) === 0)) process.stderr.write(`Sample ${e.done}/${e.total}\n`);
      },
    });
    writeFileSync(target, res.png);
    lastOutput = target;
    process.stderr.write(`geschrieben: ${target} (${res.png.length} Bytes)\n`);
    return 0;
  } catch (e) {
    return blenderFailure(e);
  }
}

/** [228] `dossier-cli … blend`: Szene wie fürs Rendering aufbauen und als .blend nach `--out` speichern (nicht rendern). */
async function runBlend(project: Project, args: Args): Promise<number> {
  const pkg = await buildCliPackage(project, args, "save");
  const target = args.flags.get("out") ?? `${exportProjectName(project) || "projekt"}.blend`;
  try {
    const res = await runBlenderSave(nodeBlenderHost(args.flags.has("keep")), pkg, {
      script: renderScript(args),
      blenderPath: args.flags.get("blender"),
      onLine: args.flags.has("verbose") ? (l) => process.stderr.write(`  ${l}\n`) : undefined,
    });
    writeFileSync(target, res.blend);
    lastOutput = target;
    process.stderr.write(`geschrieben: ${target} (${res.blend.length} Bytes)\n`);
    return 0;
  } catch (e) {
    return blenderFailure(e);
  }
}

/** Führt EINEN Befehl gegen ein geladenes Projekt aus (Rückgabe = Exit-Code). */
async function execute(project: Project, file: string, command: string, rest: string[], args: Args): Promise<number> {
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

  // [207] `--snapshot <Name|id>` (plan/section/elevation): Geschoss, Massstab, verknüpfte Ansichtsvorlage und Sichtbarkeit eines
  // Ausschnitts (`viewSnapshots`) übernehmen, z. B. `plan --snapshot "Situation 1:500" --hatch`. Ausdrückliche Flags gehen vor.
  const snapName = args.flags.get("snapshot");
  if (snapName && (command === "plan" || command === "section" || command === "elevation")) {
    const n = snapName.toLowerCase();
    const snap = (project.viewSnapshots ?? []).find((s) => s.id.toLowerCase() === n || s.name.toLowerCase() === n);
    if (!snap) fail(`Ausschnitt nicht gefunden: ${snapName}`);
    const level = project.drawingLevels.find((l) => l.id === snap.activeLevelId);
    if (!level) fail(`Ausschnitt ${snap.name}: Ebene ${snap.activeLevelId} fehlt`);
    const f = args.flags;
    if (!f.has("level")) f.set("level", level.id);
    if (!f.has("scale")) f.set("scale", String(snap.scaleDenominator));
    if (!f.has("template") && snap.templateId && snap.templateLinked) f.set("template", snap.templateId);
    const hidden = [...allCodes].filter((c) => snap.layerVisibility[c] === false || !(c in snap.layerVisibility));
    if (!f.has("hide") && hidden.length) f.set("hide", hidden.join(","));
    if (command !== "plan") rest = [rest[0] ?? level.id];
  }

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
      // Hängende Verweise u. Ä.: das Projekt lässt sich rechnen (Vorgaben), aber es soll auffallen.
      const warnings = projectWarnings(project);
      if (warnings.length) process.stderr.write(warnings.map((w) => `Warnung: ${w}`).join("\n") + "\n");
      if (problems.length) {
        process.stderr.write(problems.join("\n") + "\n");
        return 1;
      }
      process.stdout.write(warnings.length ? `ok (${warnings.length} Warnung${warnings.length === 1 ? "" : "en"})\n` : "ok\n");
      return 0;
    }
    case "migrate":
      out(args, serializeProject(project), args.flags.get("out") ?? file);
      return 0;
    case "plan": {
      // Geschosse und freie 2D-Zeichnungsebenen (z. B. das Blatt „Raumprogramm").
      let planProject = project;
      let lvl = findLevel(project, ["floor", "drawing", "ceiling"], args.flags.get("level"));
      if (!lvl) fail(`Geschoss nicht gefunden: ${args.flags.get("level") ?? "(erstes)"}`);
      // `--ceiling` ([100]): Deckenspiegel des Geschosses (vorhandene Ebene, sonst vorübergehend angelegt).
      if (args.flags.has("ceiling") && lvl.kind === "floor") {
        const floorId = lvl.id;
        const own = project.drawingLevels.find((l) => l.kind === "ceiling" && l.ceilingOfId === floorId);
        lvl = own ?? { id: `ceiling-${floorId}`, name: `Deckenspiegel ${lvl.name}`, kind: "ceiling", visible: true, locked: false, ceilingOfId: floorId };
        if (!own) planProject = { ...project, drawingLevels: [...project.drawingLevels, lvl] };
      }
      // Massstab geht in die Plan-Erzeugung ein (Bemassung in Papier-mm, Strichstärken nach Massstab).
      const tv = templateView(planProject, lvl.id, args, allCodes);
      const plan = generatePlan(withSketch(withTemplate(planProject, lvl.id, tv.tpl, args), lvl.id, args), lvl.id, tv.codes, undefined, tv.detail ?? "mittel", false, tv.mono, true, tv.scale);
      if (args.flags.get("format") === "json") {
        out(args, JSON.stringify(planToRenderScene(plan, tv.scale)), `${lvl.name}.scene.json`);
        return 0;
      }
      out(args, planToSvgString(plan, { scaleDenominator: tv.scale, hatch: args.flags.has("hatch") && args.flags.get("hatch") !== "false" }), `${lvl.name}.svg`);
      return 0;
    }
      return 0;
    case "section":
    case "elevation": {
      const name = rest[0];
      const kind = command === "section" ? "section" : "elevation";
      const found = findLevel(project, [kind], name);
      if (!found) fail(`${command} nicht gefunden: ${name ?? "(erste)"}`);
      const tv = templateView(project, found.id, args, allCodes);
      const sp = withSketch(withTemplate(project, found.id, tv.tpl, args), found.id, args);
      const lvl = sp.drawingLevels.find((l) => l.id === found.id) ?? found;
      // [157] Wie die App (`viewportLevelPlan`): verdeckte Kanten nach der Ebene, geschnittene Fenster/Türen,
      // automatische Höhenkoten (`levelMarks`) und die eigenen 2D-Elemente der Schnitt-/Ansichtsebene.
      const plan = await viewportLevelPlan(sp, lvl.id, tv.codes, tv.detail, tv.scale, false, tv.mono);
      if (plan.primitives.length === 0) fail(kind === "section" ? "keine gültige Schnittlinie" : "keine gültige Ansichtslinie");
      if (args.flags.get("format") === "json") {
        out(args, JSON.stringify(planToRenderScene(plan, tv.scale)), `${lvl.name}.scene.json`);
        return 0;
      }
      // [200] `--format dxf|dxfbin|dwg`: Schnitt/Ansicht als Modell-Space-Zeichnung (Plan-Einheiten: Meter, y = Höhe).
      const cadFormat = args.flags.get("format");
      if (cadFormat === "dxf" || cadFormat === "dxfbin" || cadFormat === "dwg") {
        await loadFileio();
        const cad = { scaleDenominator: tv.scale, dimUnit: args.flags.get("dim-unit") === "cm" ? ("cm" as const) : ("m" as const), paperLayout: args.flags.has("layout"), levelId: lvl.id };
        if (cadFormat === "dxf") out(args, buildPlanDxf(plan, sp, cad), `${lvl.name}.dxf`);
        else if (cadFormat === "dxfbin") out(args, buildPlanDxfBinary(plan, sp, cad), `${lvl.name}.dxf`);
        else out(args, buildPlanDwg(plan, sp, cad), `${lvl.name}.dwg`);
        return 0;
      }
      out(args, planToSvgString(plan, { scaleDenominator: tv.scale, hatch: args.flags.has("hatch") && args.flags.get("hatch") !== "false" }), `${lvl.name}.svg`);
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
      // --scale N (Massstabsnenner, Default 100): Bemassungsstil, Linientypen, Raumstempel, Ansichtsfenster.
      // --dim-unit cm: Masszahlen in Zentimetern; --layout: zusätzlich Papierbereich mit Ansichtsfenster.
      const cad = { scaleDenominator: scale, dimUnit: args.flags.get("dim-unit") === "cm" ? ("cm" as const) : ("m" as const), paperLayout: args.flags.has("layout"), levelId: lvl.id };
      if (command === "dxf" && args.flags.has("binary")) out(args, buildPlanDxfBinary(plan, world, cad), `${lvl.name}.dxf`);
      else if (command === "dxf") out(args, buildPlanDxf(plan, world, cad), `${lvl.name}.dxf`);
      else out(args, buildPlanDwg(plan, world, cad), `${lvl.name}.dwg`);
      return 0;
    }
    case "ifc":
      await loadFileio();
      // --ebkph: eBKP-H-Hauptgruppen je Bauteilart; --ebenen: Ebene (categoryCode) des Modells als Klassifikation.
      out(args, exportIfcSpf(project, { ebkph: args.flags.has("ebkph"), layerCodes: args.flags.has("ebenen"), schema: ifcSchemaFlag(args) }), `${exportProjectName(project) || "projekt"}.ifc`);
      return 0;
    case "obj":
      await loadFileio();
      // [201] Mit MTL (Farben) daneben: `--out haus.obj` schreibt auch `haus.mtl`; `--out -` oder `--no-mtl`: nur das OBJ
      // (Farben dann als Kommentar im Kopf).
      {
        const target = args.flags.get("out") ?? `${exportProjectName(project) || "projekt"}.obj`;
        if (target === "-" || args.flags.has("no-mtl")) {
          out(args, exportObj(project), `${exportProjectName(project) || "projekt"}.obj`);
        } else {
          const mtlPath = target.replace(/\.obj$/i, "") + ".mtl";
          out(args, exportObj(project, {}, basename(mtlPath)), target);
          writeFileSync(mtlPath, exportMtl(project));
          process.stderr.write(`geschrieben: ${mtlPath}\n`);
        }
      }
      return 0;
    case "stl":
      await loadFileio();
      out(args, exportStl(project), `${exportProjectName(project) || "projekt"}.stl`);
      return 0;
    case "glb":
      await loadFileio();
      out(args, exportGlb(project, { byLevel: !args.flags.has("flat") }), `${exportProjectName(project) || "projekt"}.glb`);
      return 0;
    case "gltf":
      await loadFileio();
      out(args, exportGltf(project, { byLevel: !args.flags.has("flat") }), `${exportProjectName(project) || "projekt"}.gltf`);
      return 0;
    case "kennzahlen": {
      // --sia416 / --ivhb: Flächentabelle bzw. IVHB-Kennziffern [70]; --format json|csv|svg|pdf (Default json).
      if (args.flags.has("sia416") || args.flags.has("ivhb")) {
        const num = (k: string): number | undefined => {
          const v = args.flags.get(k);
          if (v === undefined) return undefined;
          const n = Number(v.replace(",", "."));
          if (!Number.isFinite(n)) throw new Error(`--${k}: keine Zahl`);
          return n;
        };
        const basis = args.flags.get("agf-basis") ?? "ngf";
        if (basis !== "gf" && basis !== "ngf" && basis !== "nf") throw new Error("--agf-basis: gf, ngf oder nf");
        const ivhbOptions = { agsf: num("agsf"), greenArea: num("gruenflaeche"), agfBasis: basis, includeUnderground: args.flags.has("untergeschosse") } as const;
        const wantAreas = args.flags.has("sia416");
        const wantIvhb = args.flags.has("ivhb");
        const format = args.flags.get("format") ?? "json";
        const stem = `${exportProjectName(project) || "projekt"}-flaechen`;
        if (format === "json") {
          const json = { ...(wantAreas ? { flaechentabelle: computeAreaTable(project) } : {}), ...(wantIvhb ? { ivhb: computeIvhb(project, ivhbOptions) } : {}) };
          out(args, JSON.stringify(json, null, 2), `${stem}.json`);
          return 0;
        }
        const report = buildAreaReport(project, { areas: wantAreas, ivhb: wantIvhb, ivhbOptions });
        if (format === "csv") out(args, areaReportToCsv(report), `${stem}.csv`);
        else if (format === "svg") out(args, areaReportToSvg(report), `${stem}.svg`);
        else if (format === "pdf") out(args, new Uint8Array(buildAreaReportPdf(report).output("arraybuffer")), `${stem}.pdf`);
        else throw new Error("--format: json, csv, svg oder pdf");
        return 0;
      }
      const k = computeKennzahlen(project);
      const prog = checkRoomProgram(project);
      const baurecht = checkSiteRules(project);
      // [68] Erdarbeiten je Baugrube (Abtrag/Auftrag/Hinterfüllung, m³).
      const erdarbeiten = excavationQuantities(project);
      out(args, JSON.stringify({ kennzahlen: k, raumprogramm: prog, baurecht, erdarbeiten }, null, 2), `${exportProjectName(project) || "projekt"}-kennzahlen.json`);
      return 0;
    }
    case "raumprogramm": {
      // Raumprogramm: [--import tabelle.xlsx|ods|csv [--sheet Name|Nr] [--mode replace|append]] [--tolerance 5]
      // [--generate] [--format json|csv|svg|pdf] [--out datei] [--save projekt.obp]
      let next = project;
      const src = args.flags.get("import");
      if (src && src !== "true") {
        let bytes: Uint8Array;
        try {
          bytes = new Uint8Array(readFileSync(src));
        } catch (e) {
          fail(`Datei nicht lesbar: ${src} (${e instanceof Error ? e.message : String(e)})`);
        }
        const sheets = await readSheetFile(bytes, src.split(/[\\/]/).pop() ?? src);
        const want = args.flags.get("sheet");
        const sheet = (want !== undefined ? sheets.find((s, i) => s.name === want || String(i + 1) === want) : sheets.find((s) => s.rows.length > 0)) ?? sheets[0];
        if (!sheet) fail("import: kein Tabellenblatt gefunden");
        const rows = importedRows(mapRows(sheet.rows, suggestMapping(sheet.rows)));
        next = applyRoomProgram(next, rows, args.flags.get("mode") === "append" ? "append" : "replace");
        process.stderr.write(`${rows.length} Programmzeilen aus Blatt "${sheet.name}" übernommen.\n`);
      }
      const tol = args.flags.get("tolerance");
      if (tol !== undefined) {
        const v = Number(tol);
        if (!Number.isFinite(v) || v < 0 || v > 100) fail("--tolerance: Prozent 0 bis 100");
        next = { ...next, roomProgramTolerance: v / 100 };
      }
      if (args.flags.has("generate")) {
        const sheet = buildProgramSheet(next, defaultSheetLabels());
        next = addProgramSheet(next, sheet);
        process.stderr.write(`${sheet.layout.items.length} Räume auf Blatt "${sheet.level.name}" (${sheet.level.id}) angelegt.\n`);
      }
      const save = args.flags.get("save");
      if (save && save !== "true") {
        const target = save;
        writeFileSync(target, serializeProject(next));
        process.stderr.write(`geschrieben: ${target}\n`);
      }
      const format = args.flags.get("format") ?? "json";
      const stem = `${next.name || "projekt"}-raumprogramm`;
      if (format === "json") out(args, JSON.stringify(compareRoomProgram(next), null, 2), `${stem}.json`);
      else {
        const report = buildProgramReport(next);
        if (format === "csv") out(args, areaReportToCsv(report), `${stem}.csv`);
        else if (format === "svg") out(args, areaReportToSvg(report), `${stem}.svg`);
        else if (format === "pdf") out(args, new Uint8Array(buildAreaReportPdf(report).output("arraybuffer")), `${stem}.pdf`);
        else throw new Error("--format: json, csv, svg oder pdf");
      }
      return 0;
    }
    case "sun": {
      // Sonnenstand + Schatten-Polygone (Boden, Meter) für Datum/Uhrzeit (UTC), z. B. --when 2026-06-21T10:00Z
      const when = new Date(String(args.flags.get("when") ?? "2026-06-21T10:00:00Z"));
      if (Number.isNaN(when.getTime())) throw new Error("--when: ungültiges Datum");
      const { lat, lon } = projectLatLon(project);
      const sun = sunPosition(lat, lon, when);
      out(args, JSON.stringify({ when: when.toISOString(), lat, lon, sun, shadows: shadowPolygons(project, sun) }, null, 2), `${exportProjectName(project) || "projekt"}-sonne.json`);
      return 0;
    }
    case "schedule": {
      // --openings: Fenster- und Türliste statt Bauteilliste [--format json|csv|svg|pdf] (Default csv)
      if (args.flags.has("openings")) {
        const format = args.flags.get("format") ?? "csv";
        const stem = `${exportProjectName(project) || "projekt"}-fenster-tueren`;
        if (format === "json") out(args, JSON.stringify(openingSchedule(project), null, 2), `${stem}.json`);
        else {
          const report = buildOpeningReport(project);
          if (format === "csv") out(args, areaReportToCsv(report), `${stem}.csv`);
          else if (format === "svg") out(args, areaReportToSvg(report), `${stem}.svg`);
          else if (format === "pdf") out(args, new Uint8Array(buildAreaReportPdf(report).output("arraybuffer")), `${stem}.pdf`);
          else throw new Error("--format: json, csv, svg oder pdf");
        }
        return 0;
      }
      // --rooms: Raumbuch mit Oberflächen und Mengen ([158]) [--format json|csv|svg|pdf] (Default csv)
      if (args.flags.has("rooms")) {
        const format = args.flags.get("format") ?? "csv";
        const stem = `${exportProjectName(project) || "projekt"}-raumbuch`;
        if (format === "json") out(args, JSON.stringify(roomBook(project), null, 2), `${stem}.json`);
        else {
          const report = buildRoomBookReport(project);
          if (format === "csv") out(args, areaReportToCsv(report), `${stem}.csv`);
          else if (format === "svg") out(args, areaReportToSvg(report), `${stem}.svg`);
          else if (format === "pdf") out(args, new Uint8Array(buildAreaReportPdf(report).output("arraybuffer")), `${stem}.pdf`);
          else throw new Error("--format: json, csv, svg oder pdf");
        }
        return 0;
      }
      // --elements: Bauteilliste mit U-Werten aus den Schichten ([71]) [--format json|csv|svg|pdf] (Default csv)
      if (args.flags.has("elements")) {
        const format = args.flags.get("format") ?? "csv";
        const stem = `${exportProjectName(project) || "projekt"}-bauteile`;
        if (format === "json") out(args, JSON.stringify(elementSchedule(project), null, 2), `${stem}.json`);
        else {
          const report = buildElementReport(project);
          if (format === "csv") out(args, areaReportToCsv(report), `${stem}.csv`);
          else if (format === "svg") out(args, areaReportToSvg(report), `${stem}.svg`);
          else if (format === "pdf") out(args, new Uint8Array(buildAreaReportPdf(report).output("arraybuffer")), `${stem}.pdf`);
          else throw new Error("--format: json, csv, svg oder pdf");
        }
        return 0;
      }
      out(args, exportScheduleCsv(project), `${exportProjectName(project) || "projekt"}-liste.csv`);
      return 0;
    }
    case "step": {
      const r = await exportProjectStep(project, project.name || "projekt");
      if (r.skipped.length) process.stderr.write(`${r.skipped.length} Körper übersprungen/ungeschnitten.\n`);
      out(args, r.text, `${exportProjectName(project) || "projekt"}.stp`);
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
      const r = await ifcInto(project, bytes, src.split(/[\\/]/).pop() ?? src, args);
      process.stdout.write(JSON.stringify(r.report, null, 2) + "\n");
      const target = args.flags.get("out");
      if (target) out(args, serializeProject(r.next), target);
      return 0;
    }
    case "erkennen": {
      // [154] Quelle: --source (Ebene, id oder Name), sonst die Zeichnung des Geschosses, sonst die erste Ebene mit Zeichnung.
      const lvl = findLevel(project, ["floor"], args.flags.get("level"));
      if (!lvl) fail("Geschoss nicht gefunden");
      const sources = recognizeSourceLevels(project);
      const want = args.flags.get("source")?.toLowerCase();
      const src = want
        ? project.drawingLevels.find((l) => l.id.toLowerCase() === want || l.name.toLowerCase() === want)?.id
        : sources.includes(lvl.id)
          ? lvl.id
          : sources[0];
      if (!src) fail("erkennen: keine 2D-Zeichnung (--source)");
      const opts = { levelId: lvl.id, floorHeight: lvl.floorHeight, sourceLevelId: src, wallTypeId: project.wallTypes[0]?.id, typeName: "Wand {cm} cm (erkannt)" };
      process.stdout.write(JSON.stringify(recognizeReport(project, opts), null, 2) + "\n");
      const target = args.flags.get("out");
      if (target) out(args, serializeProject(recognizeMutation(opts)(project)), target);
      return 0;
    }
    case "import-mesh": {
      const src = rest[0];
      if (!src) fail("import-mesh: Modelldatei fehlt");
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(readFileSync(src));
      } catch (e) {
        fail(`Datei nicht lesbar: ${src} (${e instanceof Error ? e.message : String(e)})`);
      }
      const r = await meshInto(project, bytes, src, args);
      process.stdout.write(JSON.stringify(r.report, null, 2) + "\n");
      const target = args.flags.get("out");
      if (target) out(args, serializeProject(r.next), target);
      return 0;
    }
    case "mcp":
      await serveStdio(file);
      return 0;
    case "render":
      // [211] Rendering mit Blender/Cycles (Paket + Blender-Prozess, `export/blenderRender.ts`)
      return runRender(project, args);
    case "blend":
      // [228] Szene als .blend (Skript im Modus save, `export/blenderRender.ts`)
      return runBlend(project, args);
    case "model3d":
    {
      // `--explode <m>`: Explosionsaxonometrie ([65]), Geschosse um Index × Abstand angehoben. `--hide`: Klassen aus ([180]).
      // `--grey`: Klassen grau ([180]): fehlen im Modell und stehen in `ghost` (Geisterschicht, render_png zeichnet sie
      // durchscheinend wie der Viewer).
      const explode = Number(args.flags.get("explode") ?? 0) || 0;
      // `--grey-floor <id|Name,…>`: Geschosse grau (Zeichnungsebenen-Modus), ebenso in der Geisterschicht.
      const filter: Filter3d = { hide: hideFlagCodes(project, args), grey: hideFlagCodes(project, args, "grey"), greyFloors: greyFloorIds(project, args) };
      const ghost = ghostFilter3d(filter);
      const model = {
        ...projectToModel3d(project, { explode, hide: filter }),
        // Flächenmuster ([100]) des Modells (render_png zeichnet sie in den Kanten-Stilen).
        patternLines: Array.from(emitSurfacePatternLines(project, explode, filter)),
        // [212] Materialtabelle des Pathtracers (render_png `--style pathtrace`).
        ptMaterials: pathtraceMaterials(project),
      };
      // Geisterschicht: Modell, dazu gedämpfte 2D-Spuren und Flächenmuster (render_png `ghostDrawing`/`ghostPattern`).
      const json = ghost
        ? {
            ...model,
            ghost: projectToModel3d(project, { explode, hide: ghost }),
            ghostDrawing: Array.from(emitDrawingLineVerts(project, explode, ghost)),
            ghostPattern: Array.from(emitSurfacePatternLines(project, explode, ghost)),
          }
        : model;
      out(args, JSON.stringify(json), `${exportProjectName(project) || "projekt"}.model3d.json`);
      return 0;
    }
    case "bench": {
      const runs = Number(args.flags.get("runs") ?? 10);
      const floor = findLevel(project, ["floor"], undefined);
      const sec = findLevel(project, ["section"], undefined);
      const elev = findLevel(project, ["elevation"], undefined);
      const rows: Array<[string, number]> = [];
      process.stdout.write(`${project.name}: ${project.walls.length} Wände, ${(project.openings?.length ?? 0)} Öffnungen, ${(project.rooms?.length ?? 0)} Räume, ${project.stairs?.length ?? 0} Treppen\n`);
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
        await time("planToSvgString", () => planToSvgString(plan, { scaleDenominator: scale, hatch: args.flags.has("hatch") && args.flags.get("hatch") !== "false" }));
      }
      {
        // Erstes Mal auf einem frischen Dokument (ohne Cache, [58]); die Zeile darunter misst die Wiederholung.
        const cold = structuredClone(project);
        withDocument(cold, () => {
          const t0 = performance.now();
          projectToModel3d(cold);
          rows.push(["projectToModel3d (kalt)", performance.now() - t0]);
        });
      }
      // [159] Grundriss auf einem frischen Dokument (ohne Plan-Cache), erster Aufruf.
      for (const f of project.drawingLevels.filter((l) => l.kind === "floor" && !l.layoutId)) {
        const cold = structuredClone(project);
        withDocument(cold, () => {
          const t0 = performance.now();
          generatePlan(cold, f.id, allCodes, undefined, "mittel", false, false, true, scale);
          rows.push([`Grundriss ${f.id} 1:${scale} (kalt)`, performance.now() - t0]);
        });
      }
      await time("projectToModel3d (unverändert)", () => projectToModel3d(project));
      if (sec) await time("Schnitt (Kern)", async () => generateSectionPlan((await computeSection(project, sec))!, false, { visibleCodes: allCodes }), Math.max(3, runs / 2));
      if (elev) await time("generateElevationPlan", () => generateElevationPlan(project, elev), Math.max(3, runs / 2));
      if (project.walls.length) {
        const w0 = project.walls[0];
        await time("Op: patch+apply (1 Wand)", () => applyOps(project, patchItem(project, "walls", w0.id, { height: (w0.height ?? 2.6) + 0.1 })), runs * 20);
      }
      // Exporte ([20]): DXF eines Geschosses, IFC des ganzen Modells.
      if (floor) {
        const world = projectToWorldCoords(project);
        await loadFileio();
        await time("DXF (1 Geschoss)", () => buildPlanDxf(generatePlan(world, floor.id, allCodes), world, { scaleDenominator: scale, levelId: floor.id }), Math.max(3, runs / 2));
      }
      await loadFileio();
      await time("IFC (Modell)", () => exportIfcSpf(project, {}), Math.max(2, runs / 5));
      // Ops am Dokument ([20]): Stapel von Änderungen annehmen (ein Verlaufsschritt), Undo, Redo.
      if (project.walls.length) {
        const batch = project.walls.slice(0, Math.min(200, project.walls.length));
        const opsFor = (p: Project, dh: number) => batch.flatMap((w) => patchItem(p, "walls", w.id, { height: (w.height ?? 2.6) + dh }));
        withDocument(project, (doc) => {
          let cur = project;
          const lap = (name: string, f: () => void, n = Math.max(3, runs)) => {
            f();
            const t0 = performance.now();
            for (let i = 0; i < n; i++) f();
            rows.push([name, (performance.now() - t0) / n]);
          };
          let k = 0;
          lap(`Doc: commit (${batch.length} Wände, 1 Schritt)`, () => {
            const r = doc.commit(cur, opsFor(cur, 0.01 * ++k), undefined, Date.now());
            if ("project" in r) cur = r.project;
          });
          lap(`Doc: undo (${batch.length} Wände)`, () => { cur = doc.undo(cur) ?? cur; }, Math.max(3, runs / 2));
          lap(`Doc: redo (${batch.length} Wände)`, () => { cur = doc.redo(cur) ?? cur; }, Math.max(3, runs / 2));
          lap("Doc: commit (1 Wand)", () => {
            const r = doc.commit(cur, opsFor({ ...cur, walls: cur.walls.slice(0, 1) } as Project, 0.01 * ++k).slice(0, 1), undefined, Date.now());
            if ("project" in r) cur = r.project;
          }, runs * 5);
          // [159] Grundriss je Geschoss und Massstab nach einer kleinen Änderung (Wand um 1 cm verschieben): die
          // Domänen neu, die 2D-Zeichnungen aus dem Cache des Dokuments.
          const floors = project.drawingLevels.filter((l) => l.kind === "floor" && !l.layoutId);
          // Erste Wand des Erdgeschosses (Musterhaus: Aussenwand, der Fussabdruck ändert) und eine Innenwand.
          const ground = cur.walls.filter((w) => w.floorId === "eg");
          const movers = [ground[0] ?? cur.walls[0], ground.find((w) => /-iw-/.test(w.id))].filter((w): w is NonNullable<typeof w> => !!w);
          for (const f of floors) {
            for (const s of [100, 50]) {
              const plan = () => generatePlan(cur, f.id, allCodes, undefined, "mittel", false, false, true, s);
              plan();
              for (const [mi, moved] of movers.entries()) {
                if (mi > 0 && f.id !== "eg") continue;
                lap(`Grundriss ${f.id} 1:${s} nach ${mi ? "Innenwand" : "Wand"} verschieben`, () => {
                  const w = cur.walls.find((x) => x.id === moved.id)!;
                  const dx = 0.01; // immer weiter (Hin und Her träfe die Zwischenspeicher)
                  const r = doc.commit(cur, patchItem(cur, "walls", w.id, { start: { x: w.start.x + dx, y: w.start.y }, end: { x: w.end.x + dx, y: w.end.y } }), undefined, Date.now());
                  if ("project" in r) cur = r.project;
                  plan();
                });
              }
            }
          }
          // [58] Inkrementelle 3D-Ableitung (Cache im Dokument, Änderungs-Antworten): eine Änderung, dann das ganze
          // 3D-Modell neu abfragen; zum Vergleich die volle Abfrage ohne Cache-Weg in TS.
          lap("projectToModel3d (Dokument)", () => projectToModel3d(cur));
          lap("  model3dParts voll: Kern (JSON)", () => doc.queryJson("model3dParts", [1, 2, 0, 0, 0]));
          const partsJson = doc.queryJson("model3dParts", [1, 2, 0, 0, 0]);
          lap("  model3dParts voll: JSON.parse", () => JSON.parse(partsJson));
          lap("projectToModel3d nach 1 Wand-Änderung", () => {
            const w = cur.walls[++k % cur.walls.length];
            const r = doc.commit(cur, patchItem(cur, "walls", w.id, { height: (w.height ?? 2.6) + (k % 2 ? 0.01 : -0.01) }), undefined, Date.now());
            if ("project" in r) cur = r.project;
            projectToModel3d(cur);
          });
          const ops = cur.openings ?? [];
          if (ops.length) {
            lap("projectToModel3d nach 1 Öffnungs-Änderung", () => {
              const o = (cur.openings ?? [])[++k % ops.length];
              const r = doc.commit(cur, patchItem(cur, "openings", o.id, { width: o.width + (k % 2 ? 0.01 : -0.01) }), undefined, Date.now());
              if ("project" in r) cur = r.project;
              projectToModel3d(cur);
            });
          }
        });
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
    // Erst beenden, wenn stdout geleert ist: sonst schneidet `--out -` grosse Ausgaben in einer Pipe ab.
    (code) => process.stdout.write("", () => process.exit(code)),
    (e) => {
      process.stderr.write(`dossier-cli: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
      process.exit(1);
    },
  );
}
