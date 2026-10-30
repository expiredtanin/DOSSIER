// dossier-cli — der Kern ohne UI (lessons-bimcraft [4], docs/core-ui-split.md Phase C).
// Importiert AUSSCHLIESSLICH `../core` (Wächter-Test `src/cli/boundary.test.ts`). Gebaut mit
// `npm run build:cli` → dist-cli/dossier-cli.mjs; aufgerufen mit `node dist-cli/dossier-cli.mjs`.
//
//   dossier-cli <projekt.obp> info
//   dossier-cli <projekt.obp> validate
//   dossier-cli <projekt.obp> migrate [--out neu.obp]
//   dossier-cli <projekt.obp> plan [--level EG] [--scale 100] [--format svg|json] [--out eg.svg]
//                                                  json = render2d-Szene (planToRenderScene)
//   dossier-cli <projekt.obp> section <Name> [--out schnitt.svg]       (--format json: render2d-Szene)
//   dossier-cli <projekt.obp> elevation <Name> [--out ansicht.svg]
//   dossier-cli <projekt.obp> ifc [--ebkph] [--ebenen]   (IFC mit eBKP-H-Hauptgruppen bzw. Modell-Ebenen als Klassifikation)
//                                                  --schema 4|2x3: IFC4 (Standard) oder IFC2x3 (Coordination View 2.0)
//   dossier-cli <projekt.obp> dxf [--binary] [--scale 100] [--dim-unit cm] [--layout]|dwg|ifc|step|obj|stl|glb|gltf|schedule [--openings|--elements] [--format json|csv|svg|pdf]|kennzahlen [--sia416] [--ivhb] [--format json|csv|svg|pdf] [--agsf m2] [--gruenflaeche m2] [--agf-basis gf|ngf|nf] [--untergeschosse]|raumprogramm [--import tabelle] [--sheet name|nr] [--mode replace|append] [--tolerance %] [--generate] [--format json|csv|svg|pdf] [--save projekt.obp]|sun [--level EG] [--out datei]
//                                                  glb/gltf = glTF 2.0 (Y-up, Meter, Geschoss als Eltern; --flat ohne Geschoss-Knoten)
//   dossier-cli convert <eingabe> <ausgabe> [--cmd "befehl"]…   Format nach Endung: dxf/dwg/ifc/obp → obp-Import,
//                                                  obp → dxf/dwg/ifc/obj/stl/glb/gltf/step; --cmd: weitere Befehle
//                                                  gegen das Ergebnis, {last} = zuletzt geschriebene Datei
//   dossier-cli <projekt.obp> import-ifc <datei.ifc> [--out neu.obp] [--group product|class] [--elements]
//                                                  IFC als Kontext-Meshes ([B3]), mit --elements als echte
//                                                  Bauteile ([B4]); Bericht als JSON auf stdout
//   dossier-cli <projekt.obp> import-mesh <datei.obj|stl|gltf|glb|ply> [--out neu.obp] [--unit mm|cm|m|inch|foot] [--up z|y|auto]
//                                                  [--placement center|original]   3D-Modell als Kontext-Meshes; Bericht als JSON
//   dossier-cli <projekt.obp> model3d [--out modell.json]   3D-Modell fürs Headless-Rendern (render_png)
//   dossier-cli pointcloud-info <datei.las|laz|e57|ply|xyz|pts> [--voxel 0.05] [--max 2000000]
//                                                  Punktwolke lesen ([B9]) und Bericht als JSON (ohne Projekt)
//   dossier-cli pdf-info <datei.pdf> [--page 1]    Vektor-PDF lesen ([76]): Seiten, Pfade, Texte, BBox (pt) als JSON
//   dossier-cli convert plan.pdf plan.obp [--scale 100] [--page 1] [--no-text]
//                                                  Vektor-PDF als 2D-Zeichnung (Ebenen nach Farbe/Strichstärke)
//   dossier-cli <projekt.obp> mcp                  MCP-Server (stdio) auf der Datei: Werkzeuge aus core/aiToolDefs.ts
//   dossier-cli mcp --app [--port 7979] [--token …] MCP-Brücke zur offenen App ([9], KI-Zugriff in den Einstellungen)
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
  exportProjectStep,
  exportScheduleCsv,
  computeKennzahlen,
  computeAreaTable,
  computeIvhb,
  buildAreaReport,
  buildOpeningReport,
  openingSchedule,
  elementSchedule,
  buildElementReport,
  areaReportToCsv,
  areaReportToSvg,
  buildAreaReportPdf,
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
  planToRenderScene,
  projectToModel3d,
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
  AI_BRIDGE_DEFAULT_PORT,
} from "../core";
import type { Project } from "../core";
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
  const levels = project.drawingLevels.filter((l) => kinds.includes(l.kind) && !l.layoutId);
  if (!name) return levels[0];
  const n = name.toLowerCase();
  return levels.find((l) => l.id.toLowerCase() === n || l.name.toLowerCase() === n);
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
  const [file, command, ...rest] = args.positional;
  if (file === "bcf-info") return runBcfInfo(command);
  if (file === "pointcloud-info") return pointCloudInfo(args, command);
  if (file === "pdf-info") return runPdfInfo(args, command);
  if (file === "mcp" && args.flags.has("app")) return runAppBridge(args);
  if (!file || (!command && args.cmds.length === 0)) {
    process.stderr.write(
      "Aufruf: dossier-cli <projekt.obp> <info|validate|migrate|plan|section|elevation|dxf|dwg|ifc|import-ifc|import-mesh|step|obj|stl|glb|gltf|schedule|kennzahlen|raumprogramm|sun|model3d> [Optionen]\n" +
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
  const project = loadProject(file);
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
  if (ext === "obp" || ext === "json" || path === ":beispiel") return loadProject(path);
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
        parentName: `Import ${fileName}`,
        dashStyleTemplate: "PDF-Strich {pattern} mm",
      },
      Date.now(),
    );
    if ("problems" in r) return fail(`${path}: ${r.problems.join("; ")}`);
    return r.project;
  }
  return fail(`Eingabeformat nicht unterstützt: .${ext} (obp, dxf, dwg, ifc, pdf, obj, stl, gltf, glb, ply)`);
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
      const lvl = findLevel(project, ["floor", "drawing"], args.flags.get("level"));
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
        // Wie die App: verdeckte Kanten nach der Ebene, geschnittene Fenster/Türen.
        plan = generateSectionPlan(o, false, { visibleCodes: allCodes, hiddenLines: lvl.hiddenLines, openings: true });
      } else {
        plan = generateElevationPlan(project, lvl, { scaleDenominator: scale });
        if (!plan) fail("keine gültige Ansichtslinie");
      }
      if (args.flags.get("format") === "json") {
        out(args, JSON.stringify(planToRenderScene(plan, scale)), `${lvl.name}.scene.json`);
        return 0;
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
      out(args, exportIfcSpf(project, { ebkph: args.flags.has("ebkph"), layerCodes: args.flags.has("ebenen"), schema: ifcSchemaFlag(args) }), `${project.name || "projekt"}.ifc`);
      return 0;
    case "obj":
      await loadFileio();
      out(args, exportObj(project), `${project.name || "projekt"}.obj`);
      return 0;
    case "stl":
      await loadFileio();
      out(args, exportStl(project), `${project.name || "projekt"}.stl`);
      return 0;
    case "glb":
      await loadFileio();
      out(args, exportGlb(project, { byLevel: !args.flags.has("flat") }), `${project.name || "projekt"}.glb`);
      return 0;
    case "gltf":
      await loadFileio();
      out(args, exportGltf(project, { byLevel: !args.flags.has("flat") }), `${project.name || "projekt"}.gltf`);
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
        const stem = `${project.name || "projekt"}-flaechen`;
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
      out(args, JSON.stringify({ kennzahlen: k, raumprogramm: prog, baurecht, erdarbeiten }, null, 2), `${project.name || "projekt"}-kennzahlen.json`);
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
      out(args, JSON.stringify({ when: when.toISOString(), lat, lon, sun, shadows: shadowPolygons(project, sun) }, null, 2), `${project.name || "projekt"}-sonne.json`);
      return 0;
    }
    case "schedule": {
      // --openings: Fenster- und Türliste statt Bauteilliste [--format json|csv|svg|pdf] (Default csv)
      if (args.flags.has("openings")) {
        const format = args.flags.get("format") ?? "csv";
        const stem = `${project.name || "projekt"}-fenster-tueren`;
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
      // --elements: Bauteilliste mit U-Werten aus den Schichten ([71]) [--format json|csv|svg|pdf] (Default csv)
      if (args.flags.has("elements")) {
        const format = args.flags.get("format") ?? "csv";
        const stem = `${project.name || "projekt"}-bauteile`;
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
      out(args, exportScheduleCsv(project), `${project.name || "projekt"}-liste.csv`);
      return 0;
    }
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
      const r = await ifcInto(project, bytes, src.split(/[\\/]/).pop() ?? src, args);
      process.stdout.write(JSON.stringify(r.report, null, 2) + "\n");
      const target = args.flags.get("out");
      if (target) out(args, serializeProject(r.next), target);
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
      if (sec) await time("Schnitt (Kern)", async () => generateSectionPlan((await computeSection(project, sec))!, false, { visibleCodes: allCodes }), Math.max(3, runs / 2));
      if (elev) await time("generateElevationPlan", () => generateElevationPlan(project, elev), Math.max(3, runs / 2));
      if (project.walls.length) {
        const w0 = project.walls[0];
        await time("Op: patch+apply (1 Wand)", () => applyOps(project, patchItem(project, "walls", w0.id, { height: (w0.height ?? 2.6) + 0.1 })), runs * 20);
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
