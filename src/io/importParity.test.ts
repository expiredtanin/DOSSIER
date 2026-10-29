// VORÜBERGEHEND ([K4] S4): Gleichheit alte TS-Umwandlung ↔ Kern-Import (`ProjectDocument.importDrawing/
// importIfc/importMesh`). Gleiches Projekt (bis auf erzeugte ids), gleiche Zusammenfassung/Berichte. Wird mit
// der TS-Fassung gelöscht. Fixtures: `DOSSIER_PARITY_FX` (Verzeichnis), sonst übersprungen.

import "../engine/fileioWasm.setup";
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { applyOps } from "../core/ops";
import type { CoreOp } from "../core/ops";
import { addItems, fieldOps } from "../core/opsBuild";
import { ProjectDocument } from "../core/document";
import type { DrawingImportDecision } from "../core/document";
import { emptyProject, sampleProject } from "../model/sampleProject";
import type { ContextObject, ContourSet, Drawing2D, ImportedMesh, ImportedText, Project, Vec2 } from "../model/types";
import { flattenCategories } from "../model/types";
import { ensureContextCategories } from "../model/contextCategories";
import { projectGeoOrigin } from "../model/geoRebase";
import { decodeImport, importDrawingFlat, parseDxf, type DxfImportResult } from "./dxfParser";
import { countContours, distinctImportLayers, distinctLayers, planImportCategories } from "./dxfToDrawings";
import { buildDrawings } from "../ui/ImportDialog";
import { planDashLineStyles } from "./pdfLineStyles";
import { pdfPageInfo, pdfPageToImport, readPdfVectorPage } from "./pdfVector";
import { packChunks, importSummary } from "./importSource";
import { fileioLoaded } from "../engine/fileioWasm";
import { t } from "../i18n";
import { ifcElementsToProject, readIfcElements } from "./ifcElements";
import { ifcToImportedMeshes, importIfcFlat, readIfc } from "./ifcImport";
import { decodeMesh, importMeshFlat, meshObjectsToImportedMeshes, type MeshUnit, type MeshUp } from "./meshImport";
import { core } from "../engine/coreWasm";

const FX = process.env.DOSSIER_PARITY_FX ?? "";
const have = FX !== "" && existsSync(FX);
const fx = (n: string) => new Uint8Array(readFileSync(join(FX, n)));

/** Erzeugte ids (Zeit + Zähler) durch Platzhalter in Reihenfolge des ersten Auftretens ersetzen. */
function normalize(v: unknown): string {
  const text = JSON.stringify(v);
  const map = new Map<string, string>();
  return text.replace(
    /"((?:c\d+-)?imported-\d+-\d+|dxf2d-\d+-\d+|drawing-\d+|ifc-[a-z]+-[0-9a-z]+-\d+|imported-ifc-[0-9a-z]+-\d+|imported-mesh-[0-9a-z]+-\d+)"/g,
    (_, id: string) => {
      if (!map.has(id)) map.set(id, `#${map.size}`);
      return `"${map.get(id)}"`;
    },
  );
}

/** Schlüssel sortiert (Leseansicht ↔ Dokument: Felder mit `undefined` behalten in TS ihre Stelle). */
function canon(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().filter((k) => (v as Record<string, unknown>)[k] !== undefined).map((k) => [k, canon((v as Record<string, unknown>)[k])]));
  return v;
}

// ── Alte App-Fassung (`useProjectFileActions.runImportSteps`, Kopie der privaten Helfer) ─────────

function drawingsBBox(drawings: Drawing2D[]) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const acc = (x: number, y: number) => {
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  };
  for (const d of drawings) {
    const g = d.geom;
    if (g.shape === "line") { acc(g.a.x, g.a.y); acc(g.b.x, g.b.y); }
    else if (g.shape === "polyline") for (const p of g.pts) acc(p.x, p.y);
    else if (g.shape === "circle" || g.shape === "arc") { acc(g.center.x - g.r, g.center.y - g.r); acc(g.center.x + g.r, g.center.y + g.r); }
    else if (g.shape === "text") acc(g.at.x, g.at.y);
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}

function translateDrawing(d: Drawing2D, dx: number, dy: number): Drawing2D {
  const mv = (p: Vec2): Vec2 => ({ x: p.x + dx, y: p.y + dy });
  const g = d.geom;
  switch (g.shape) {
    case "line": return { ...d, geom: { ...g, a: mv(g.a), b: mv(g.b) } };
    case "polyline": return { ...d, geom: { ...g, pts: g.pts.map(mv) } };
    case "circle": return { ...d, geom: { ...g, center: mv(g.center) } };
    case "arc": return { ...d, geom: { ...g, center: mv(g.center) } };
    case "text": return { ...d, geom: { ...g, at: mv(g.at) } };
    default: return d;
  }
}

interface Case {
  target: DrawingImportDecision["target"];
  categoryMode: "byLayer" | "active";
  importMeshes: boolean;
  viewCenter?: [number, number];
}

function oldApp(project: Project, parsed: DxfImportResult, c: Case, active: string, parentName: string): Project {
  let p = project;
  const apply = (ops: CoreOp[]) => {
    p = applyOps(p, ops);
  };
  let levelId: string;
  if (c.target.kind === "new") {
    const id = `drawing-${Date.now()}`;
    const n = p.drawingLevels.filter((z) => z.kind === "drawing").length + 1;
    apply(addItems("drawingLevels", [{ id, name: c.target.name.trim() || t("default.drawingName", { n }), kind: "drawing", visible: true, locked: false }]));
    levelId = id;
  } else levelId = c.target.levelId;
  let codeByLayer: Map<string, string> | undefined;
  if (c.categoryMode === "byLayer") {
    const plan = planImportCategories(distinctImportLayers(parsed.contours, parsed.texts ?? []), flattenCategories(project.layers), parentName, parsed.layerColors, parsed.layerLineWeights);
    codeByLayer = plan.codeByLayer;
    if (plan.parent) apply(fieldOps(p, "layers", [...p.layers, plan.parent]));
  }
  const dashPlan = planDashLineStyles(parsed.layerDashes, project.lineStyles);
  if (dashPlan.created.length) apply(addItems("lineStyles", dashPlan.created.filter((x) => !p.lineStyles.some((l) => l.id === x.id))));
  let drawings = buildDrawings(
    { target: c.target, categoryMode: c.categoryMode, importMeshes: c.importMeshes, placement: c.viewCenter ? "viewCenter" : "origin", parsed },
    levelId,
    project,
    active,
    codeByLayer,
    dashPlan.styleByLayer,
  );
  if (c.viewCenter && drawings.length) {
    const bb = drawingsBBox(drawings);
    if (bb) {
      const dx = c.viewCenter[0] - (bb.minX + bb.maxX) / 2;
      const dy = c.viewCenter[1] - (bb.minY + bb.maxY) / 2;
      drawings = drawings.map((d) => translateDrawing(d, dx, dy));
    }
  }
  if (drawings.length) apply(addItems("drawings2d", drawings));
  if (c.importMeshes && parsed.meshes.length) {
    const added = parsed.meshes as ContextObject[];
    const codes = added.map((o) => o.categoryCode).filter((x): x is string => !!x);
    apply([...addItems("context", added), ...fieldOps(p, "layers", ensureContextCategories(p.layers, codes))]);
  }
  return p;
}

function oldSummary(parsed: DxfImportResult) {
  const texts = parsed.texts ?? [];
  return {
    contours: countContours(parsed.contours),
    texts: texts.length,
    meshes: parsed.meshes.length,
    layers: distinctLayers(parsed.contours),
    diagnostics: parsed.diagnostics,
    ...(parsed.insUnits !== undefined ? { insUnits: parsed.insUnits } : {}),
    ...(parsed.unitScale !== undefined ? { unitScale: parsed.unitScale } : {}),
    ...(parsed.layouts !== undefined ? { layouts: parsed.layouts } : {}),
    ...(parsed.layout !== undefined ? { layout: parsed.layout } : {}),
    recovered: parsed.recovered ?? false,
  };
}

const LEVEL_TEMPLATE = t("default.drawingName", { n: "{n}" });
const DASH_TEMPLATE = t("import.pdf.dashStyleName", { pattern: "{pattern}" });

function compareDrawing(project: Project, parsed: DxfImportResult, src: ReturnType<typeof packChunks>, c: Case, label: string) {
  const active = project.layers[0].code;
  const parentName = `Import ${label}`;
  const old = oldApp(project, parsed, c, active, parentName);
  const doc = new ProjectDocument(project);
  const r = doc.importDrawing(project, src, { ...c, activeCategoryCode: active, levelNameTemplate: LEVEL_TEMPLATE, parentName, dashStyleTemplate: DASH_TEMPLATE }, Date.now());
  if ("problems" in r) throw new Error(`${label}: ${r.problems.join("; ")}`);
  expect(normalize(r.project), label).toBe(normalize(old));
  // Kern-Dokument = Leseansicht.
  expect(normalize(canon(JSON.parse(doc.json()))), `${label} (Dokument)`).toBe(normalize(canon(r.project)));
  doc.close();
}

const CASES: Case[] = [
  { target: { kind: "new", name: "" }, categoryMode: "byLayer", importMeshes: true },
  { target: { kind: "new", name: " Plan " }, categoryMode: "active", importMeshes: false, viewCenter: [12.5, -3.25] },
  { target: { kind: "existing", levelId: "eg" }, categoryMode: "byLayer", importMeshes: false, viewCenter: [0, 0] },
];

const BASES: [string, Project][] = [
  ["leer", emptyProject],
  ["beispiel", sampleProject],
];

function dxfFiles(): string[] {
  return readdirSync(FX).filter((n) => /\.(dxf|dwg)$/i.test(n) && !n.startsWith("kataster150k"));
}

describe.skipIf(!have)("Parität Zeichnungs-Import (DXF/DWG/PDF)", { timeout: 600_000 }, () => {
  it("DXF/DWG: Projekt und Zusammenfassung gleich", () => {
    let n = 0;
    for (const name of dxfFiles()) {
      const bytes = fx(name);
      const flat = importDrawingFlat(bytes);
      const parsed = decodeImport(flat.geom, flat.strings);
      const src = packChunks([flat]);
      expect(importSummary(src), name).toEqual(JSON.parse(JSON.stringify(oldSummary(parsed))));
      for (const [bn, base] of BASES) {
        const levelId = base.drawingLevels[0].id;
        for (const c of CASES) {
          const cc = c.target.kind === "existing" ? { ...c, target: { kind: "existing" as const, levelId } } : c;
          compareDrawing(base, parsed, src, cc, `${name}/${bn}/${JSON.stringify(cc)}`);
          n++;
        }
      }
    }
    expect(n).toBeGreaterThan(20);
  });

  it("Layouts (Papierbereich)", () => {
    const bytes = fx("layouts.dxf");
    const layouts = parseDxf(bytes).layouts ?? [];
    expect(layouts.length).toBeGreaterThan(0);
    for (const l of layouts) {
      const flat = importDrawingFlat(bytes, l.name);
      const parsed = decodeImport(flat.geom, flat.strings);
      const src = packChunks([flat]);
      expect(importSummary(src)).toEqual(JSON.parse(JSON.stringify(oldSummary(parsed))));
      compareDrawing(sampleProject, parsed, src, CASES[0], `layout ${l.name}`);
    }
  });

  it("parallel gelesene Stücke (grosse DXF)", () => {
    for (const name of ["kataster150k.dxf"]) {
      const bytes = fx(name);
      const offsets = Array.from(fileioLoaded()!.dxf_split_offsets(bytes, 4));
      expect(offsets.length, name).toBeGreaterThanOrEqual(3);
      const closer = new TextEncoder().encode("0\nENDSEC\n0\nEOF\n");
      const pre = bytes.subarray(0, offsets[0]);
      const chunks: Uint8Array[] = [];
      for (let i = 0; i + 1 < offsets.length; i++) {
        const body = bytes.subarray(offsets[i], offsets[i + 1]);
        const c = new Uint8Array(pre.length + body.length + closer.length);
        c.set(pre, 0);
        c.set(body, pre.length);
        c.set(closer, pre.length + body.length);
        chunks.push(c);
      }
      const flats = chunks.map((c) => importDrawingFlat(c));
      const parts = flats.map((f, i) => decodeImport(f.geom, f.strings, `c${i}-`));
      const merged = mergeResults(parts);
      const src = packChunks(flats);
      expect(importSummary(src), name).toEqual(JSON.parse(JSON.stringify(oldSummary(merged))));
      compareDrawing(sampleProject, merged, src, CASES[0], `${name} Stücke`);
      compareDrawing(emptyProject, merged, src, CASES[1], `${name} Stücke aktiv`);
    }
  });

  it("Vektor-PDF: Seiten, Massstäbe, Texte, Strichmuster", () => {
    for (const name of ["plan.pdf", "plan-rot.pdf"]) {
      const bytes = fx(name);
      const res = fileioLoaded()!.pdf_read_page(bytes, 0);
      const flat = { geom: res.geom(), strings: res.strings() };
      res.free();
      const page = readPdfVectorPage(bytes, 0);
      // pdf-info
      expect(JSON.parse(core().pdf_page_info(flat.geom, JSON.stringify(flat.strings)))).toEqual(JSON.parse(JSON.stringify(pdfPageInfo(page))));
      for (const scale of [100, 50, 1, 333.3]) {
        for (const texts of [true, false]) {
          const parsed = pdfPageToImport(page, scale, { texts });
          const src = packChunks([flat], { kind: "pdf", scale, texts });
          expect(importSummary(src)).toEqual(JSON.parse(JSON.stringify(oldSummary(parsed))));
          for (const [bn, base] of BASES) {
            for (const c of CASES) {
              const cc = c.target.kind === "existing" ? { ...c, target: { kind: "existing" as const, levelId: base.drawingLevels[0].id } } : c;
              compareDrawing(base, parsed, src, cc, `${name}/${scale}/${texts}/${bn}`);
            }
          }
        }
      }
      // Projekt mit schon passendem Linienstil: wird wiederverwendet.
      const withStyle: Project = { ...sampleProject, lineStyles: [...sampleProject.lineStyles, { id: "x", name: "x", weight: 0.1, color: "#000", dash: [1.05, 0.7] }] };
      compareDrawing(withStyle, pdfPageToImport(page, 100), packChunks([flat], { kind: "pdf", scale: 100 }), CASES[0], `${name} Stil`);
    }
  });
});

function mergeResults(results: DxfImportResult[]): DxfImportResult {
  const meshes: ImportedMesh[] = [];
  const contours: ContourSet[] = [];
  const texts: ImportedText[] = [];
  const layerColors: Record<string, string> = {};
  const diagnostics = { entityCounts: {} as Record<string, number>, total: 0 };
  for (const r of results) {
    for (const m of r.meshes) meshes.push(m);
    for (const c of r.contours) contours.push(c);
    for (const tt of r.texts ?? []) texts.push(tt);
    Object.assign(layerColors, r.layerColors);
    for (const [k, n] of Object.entries(r.diagnostics?.entityCounts ?? {})) diagnostics.entityCounts[k] = (diagnostics.entityCounts[k] ?? 0) + n;
    diagnostics.total += r.diagnostics?.total ?? 0;
  }
  return { meshes, contours, texts, layerColors, diagnostics, insUnits: results[0]?.insUnits, unitScale: results[0]?.unitScale, layouts: results[0]?.layouts };
}

// ── IFC ──────────────────────────────────────────────────────────────────────

function contextOps(project: Project, meshes: NonNullable<Project["context"]>): CoreOp[] {
  return [
    ...(project.context ? addItems("context", meshes) : fieldOps(project, "context", meshes)),
    ...fieldOps(project, "layers", ensureContextCategories(project.layers, meshes.flatMap((m) => (m.categoryCode ? [m.categoryCode] : [])))),
  ];
}

const geoProject: Project = { ...sampleProject, geoAnchor: { lv95: { e: 2600000, n: 1200000 }, model: { x: 0, y: 0 } } } as Project;
const IFC_BASES: [string, Project][] = [["leer", emptyProject], ["beispiel", sampleProject], ["geo", geoProject], ["ohneListen", { ...emptyProject, context: undefined, rooms: undefined, columns: undefined, ceilingTypes: undefined } as unknown as Project]];

describe.skipIf(!have)("Parität IFC-Import", { timeout: 600_000 }, () => {
  it("Bauteile und Kontext-Meshes: Projekt, Zusammenfassung, Bericht gleich", async () => {
    const files = readdirSync(FX).filter((n) => n.endsWith(".ifc"));
    expect(files.length).toBeGreaterThanOrEqual(5);
    for (const name of files) {
      const bytes = fx(name);
      const flat = await importIfcFlat(bytes, true);
      const { products, report, elements } = await readIfcElements(bytes);
      for (const [bn, base] of IFC_BASES) {
        for (const group of ["auto", "product", "class"] as const) {
          const label = `${name}/${bn}/${group}`;
          const old = ifcElementsToProject(base, products, elements, { fileName: name, geoOrigin: projectGeoOrigin(base), group });
          const doc = new ProjectDocument(base);
          const r = doc.importIfc(base, flat, { fileName: name, group, elements: true }, Date.now());
          if ("problems" in r) throw new Error(`${label}: ${r.problems.join("; ")}`);
          expect(normalize(r.project), label).toBe(normalize(old.project));
          expect(r.summary, label).toEqual(old.summary);
          expect(r.kept, label).toEqual(elements.kept);
          // CLI `import-ifc --elements`: Bericht wie früher `{ ...report, products: undefined, elements: summary, kept }`.
          expect(JSON.stringify({ ...r.report, products: undefined, byClass: undefined, triangles: undefined, kept: r.kept })).toBe(
            JSON.stringify({ ...report, products: undefined, elements: old.summary, kept: elements.kept }),
          );
          expect(normalize(canon(JSON.parse(doc.json()))), `${label} (Dokument)`).toBe(normalize(canon(r.project)));
          doc.close();
          // Nur Kontext-Meshes ([B3]).
          const m = await readIfc(bytes);
          const meshes = ifcToImportedMeshes(m.products, name, { geoOrigin: projectGeoOrigin(base), group });
          const oldMesh = applyOps(base, contextOps(base, meshes));
          const flat2 = await importIfcFlat(bytes, false);
          const doc2 = new ProjectDocument(base);
          const r2 = doc2.importIfc(base, flat2, { fileName: name, group }, Date.now());
          if ("problems" in r2) throw new Error(r2.problems.join("; "));
          expect(normalize(r2.project), `${label} Meshes`).toBe(normalize(oldMesh));
          const byClass: Record<string, number> = {};
          for (const p of m.products) byClass[p.ifcClass] = (byClass[p.ifcClass] ?? 0) + 1;
          const triangles = m.products.reduce((s, p) => s + p.indices.length / 3, 0);
          expect(r2.report).toEqual(JSON.parse(JSON.stringify({ ...m.report, byClass, triangles })));
          expect(r2.contextObjects).toBe(meshes.length);
          doc2.close();
        }
      }
    }
  });
});

// ── Meshes ───────────────────────────────────────────────────────────────────

describe.skipIf(!have)("Parität Mesh-Import", { timeout: 600_000 }, () => {
  it("OBJ/STL/glTF/GLB/PLY: Projekt und Bericht gleich", async () => {
    const files = readdirSync(FX).filter((n) => /\.(obj|stl|glb|gltf|ply)$/i.test(n));
    expect(files.length).toBeGreaterThanOrEqual(6);
    const sidecars = (n: string) => (n === "gruppen.obj" ? [{ name: "farben.mtl", bytes: fx("farben.mtl") }] : []);
    for (const name of files) {
      for (const [unit, up] of [["m", "auto"], ["mm", "y"], ["cm", "z"]] as [MeshUnit, MeshUp][]) {
        const flat = await importMeshFlat(fx(name), name, { unit, up, maxTriangles: 0, files: sidecars(name) });
        const { objects, report } = decodeMesh(flat);
        expect(JSON.parse(core().mesh_import_report(flat.flat, JSON.stringify(flat.strings)))).toEqual(JSON.parse(JSON.stringify(report)));
        for (const [bn, base] of [["beispiel", sampleProject], ["geo", geoProject], ["leer", { ...emptyProject, context: undefined } as unknown as Project]] as [string, Project][]) {
          for (const placement of ["center", "original"] as const) {
            for (const group of ["auto", "object", "merge"] as const) {
              const label = `${name}/${unit}/${bn}/${placement}/${group}`;
              const meshes = meshObjectsToImportedMeshes(objects, name, { placement, geoOrigin: projectGeoOrigin(base), group });
              const old = applyOps(base, contextOps(base, meshes));
              const doc = new ProjectDocument(base);
              const r = doc.importMesh(base, flat, { fileName: name, placement, group }, Date.now());
              if ("problems" in r) throw new Error(`${label}: ${r.problems.join("; ")}`);
              expect(normalize(r.project), label).toBe(normalize(old));
              expect(r.contextObjects).toBe(meshes.length);
              doc.close();
            }
          }
        }
      }
    }
  });
});
