// Robustheit des Kerns gegen kaputte Projekte: Dateien von der Platte und Importe können hängende
// Verweise (Wandtyp, Bauteil, Geschoss, Gruppe, Schraffur, Linienstil, Stift …), fehlende Felder,
// NaN, leere Polygone, doppelte ids und Zyklen (Gruppen/Ordner, die sich selbst enthalten) tragen.
// Keine Abfrage und keine Fassade darf daran werfen oder (in Rust) in Panik geraten — sie fallen auf
// Vorgaben zurück, wie der übrige tolerante Modell-Code. `validate` meldet die Verweise als Warnung.

import { beforeAll, describe, expect, it } from "vitest";
import type { Layout, Project } from "../model/types";
import { sampleProject } from "../model/sampleProject";
import { bigSampleProject } from "../plan/bigSampleProject.testing";
import { randomProject, richProject, rng } from "../model/richProject.testing";
import {
  computeSection,
  generateElevationPlan,
  generatePlan,
  generateSectionPlan,
  generateVisibleLevelsPlan,
  pickGeometry,
  planSceneBin,
  planToRenderScene,
  projectToModel3d,
  wallMaterialColorMaps,
} from "./index";
import {
  buildPlanDxf,
  checkRoomProgram,
  checkSiteRules,
  compareRoomProgram,
  computeAreaTable,
  computeIvhb,
  computeKennzahlen,
  exportGlb,
  exportIfcSpf,
  exportObj,
  exportScheduleCsv,
  exportStl,
  layoutRoomProgram,
  parseProjectFile,
  planToSvgString,
  projectLatLon,
  serializeProject,
  shadowPolygons,
  sunPosition,
  validateProject,
  buildingFootprint,
  modelTop,
  projectWarnings,
} from "./extra";
import { loadFileioForTests } from "../engine/fileioWasm.testing";
import { buildLayoutTree, buildMasterTree, folderPdfPages, resolveTitleBlock, visibleCodesFromSnapshot } from "../model/layoutModel";

type Mut = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const clone = (p: Project): Mut => JSON.parse(JSON.stringify(p)) as Mut;
const list = (p: Mut, k: string): Mut[] => (Array.isArray(p[k]) ? (p[k] as Mut[]) : []);

/** Alle Kategorie-Codes (verschachtelt), wie die CLI. */
function allCodes(p: Project): Set<string> {
  const out = new Set<string>();
  const walk = (ls: unknown): void => {
    if (!Array.isArray(ls)) return;
    for (const l of ls as Mut[]) {
      if (l && typeof l.code === "string") out.add(l.code);
      walk(l?.children);
    }
  };
  walk(p.layers);
  return out;
}

/** Verdorbene Fassungen eines Projekts: Name → Projekt. */
function corruptions(base: Project, seed: number): [string, Project][] {
  const r = rng(seed);
  const out: [string, Project][] = [];
  const add = (name: string, f: (p: Mut) => void) => {
    const p = clone(base);
    f(p);
    out.push([name, p as unknown as Project]);
  };
  const some = <T,>(a: T[]): T[] => a.filter((_, i) => i === 0 || r() < 0.5);

  add("Wandtyp hängt", (p) => some(list(p, "walls")).forEach((w) => (w.wallTypeId = "nope")));
  add("alle Wandtypen weg", (p) => (p.wallTypes = []));
  add("Bauteil hängt", (p) => {
    for (const k of ["wallTypes", "ceilingTypes", "roofTypes"]) for (const t of list(p, k)) for (const l of t.layers ?? []) l.componentId = "nope";
  });
  add("Bauteile weg", (p) => (p.components = []));
  add("Schraffur/Linienstil hängt", (p) => {
    for (const c of list(p, "components")) {
      c.hatchId = "nope";
      c.cutHatchId = "nope";
      c.lineStyleId = "nope";
    }
    const walk = (ls: Mut[]) => {
      for (const l of ls) {
        l.hatchId = "nope";
        l.lineStyleId = "nope";
        l.penId = "nope";
        walk(l.children ?? []);
      }
    };
    walk(list(p, "layers"));
    for (const d of list(p, "drawings2d")) {
      d.hatchId = "nope";
      d.lineStyleId = "nope";
      d.penId = "nope";
      d.fillPenId = "nope";
    }
    p.hatches = [];
    p.lineStyles = [];
  });
  add("Stifte hängen", (p) => {
    p.activePenSetId = "nope";
    p.penSets = [{ id: "ps", name: "x", pens: { nope: { color: "not-a-color", weight: NaN } } }];
    for (const w of list(p, "walls")) w.penId = "nope";
  });
  add("Geschoss hängt", (p) => {
    for (const k of ["walls", "stairs", "columns", "ceilings", "rooms"]) for (const e of list(p, k)) e.floorId = "nope";
    for (const k of ["drawings2d", "extrudedSolids"]) for (const e of list(p, k)) e.levelId = "nope";
    for (const e of list(p, "roofs")) e.floorId = "nope";
    for (const w of list(p, "walls")) {
      w.bottom = { mode: "floor", floorId: "nope", offset: 0 };
      w.top = { mode: "floor", floorId: "nope2" };
    }
  });
  add("Öffnung ohne Wand", (p) => list(p, "openings").forEach((o) => (o.hostWallId = "nope")));
  add("Typen hängen", (p) => {
    for (const o of list(p, "openings")) o.typeId = "nope";
    for (const s of list(p, "stairs")) s.typeId = "nope";
    for (const c of list(p, "ceilings")) {
      c.ceilingTypeId = "nope";
      c.wallTypeId = "nope";
    }
    for (const rf of list(p, "roofs")) rf.roofTypeId = "nope";
    for (const d of list(p, "drawings2d")) if (d.geom?.shape === "block") d.geom.blockDefId = "nope";
    for (const pw of list(p, "parametricWalls")) pw.defaultWallTypeId = "nope";
  });
  add("Gruppen hängen und enthalten sich", (p) => {
    p.groups = [
      { id: "g1", name: "A", wallIds: ["nope"], drawingIds: ["nope"], ceilingIds: [], roomIds: [], stairIds: [], columnIds: [], roofIds: [], openingIds: [], groupIds: ["g1", "g2", "nope"] },
      { id: "g2", name: "B", wallIds: [list(p, "walls")[0]?.id ?? "x"], drawingIds: [], ceilingIds: [], roomIds: [], stairIds: [], columnIds: [], roofIds: [], openingIds: [], groupIds: ["g1"] },
    ];
  });
  add("Ordner zyklisch", (p) => {
    p.viewSnapshotFolders = [
      { id: "f1", name: "A", parentId: "f2" },
      { id: "f2", name: "B", parentId: "f1" },
      { id: "f3", name: "C", parentId: "f3" },
    ];
    p.layoutFolders = [
      { id: "lf1", name: "A", kind: "layout", parentId: "lf2" },
      { id: "lf2", name: "B", kind: "layout", parentId: "lf1" },
      { id: "lf3", name: "C", kind: "master", parentId: "lf3" },
    ];
    for (const l of list(p, "layouts")) l.folderId = "lf1";
    for (const m of list(p, "masterLayouts")) m.folderId = "lf3";
    for (const s of list(p, "viewSnapshots")) s.folderId = "f1";
  });
  add("Layouts hängen", (p) => {
    for (const l of list(p, "layouts")) {
      l.masterId = "nope";
      l.folderId = "nope";
      for (const v of l.viewports ?? []) v.snapshotId = "nope";
    }
    for (const s of list(p, "viewSnapshots")) {
      s.activeLevelId = "nope";
      s.enabledOverrideRuleIds = ["nope"];
    }
  });
  add("leere Polygone", (p) => {
    for (const c of list(p, "ceilings")) c.outline = [];
    for (const rm of list(p, "rooms")) rm.boundary = [];
    for (const rf of list(p, "roofs")) rf.outline = [];
    for (const x of list(p, "extrudedSolids")) x.points = [];
    if (p.siteRules) p.siteRules.parcel = [];
    for (const d of list(p, "drawings2d")) if (Array.isArray(d.geom?.pts)) d.geom.pts = [];
  });
  add("Ein-Punkt-Polygone", (p) => {
    for (const c of list(p, "ceilings")) c.outline = c.outline?.slice(0, 1) ?? [];
    for (const rm of list(p, "rooms")) rm.boundary = rm.boundary?.slice(0, 2) ?? [];
    for (const rf of list(p, "roofs")) rf.outline = rf.outline?.slice(0, 2) ?? [];
    for (const w of list(p, "walls")) w.end = { ...w.start };
  });
  add("NaN", (p) => {
    const ws = list(p, "walls");
    if (ws[0]) ws[0].start = { x: NaN, y: 0 };
    if (ws[1]) ws[1].height = NaN;
    for (const c of list(p, "ceilings").slice(0, 1)) c.outline = [{ x: NaN, y: NaN }, { x: 1, y: 0 }, { x: 1, y: 1 }];
    for (const t of list(p, "wallTypes").slice(0, 1)) for (const l of t.layers ?? []) l.thickness = NaN;
    for (const lv of list(p, "drawingLevels")) lv.baseElevation = NaN;
    for (const o of list(p, "openings").slice(0, 2)) o.width = NaN;
    for (const s of list(p, "stairs").slice(0, 1)) s.width = NaN;
  });
  add("Unendlich und negativ", (p) => {
    for (const w of list(p, "walls").slice(0, 2)) w.height = -3;
    for (const t of list(p, "wallTypes")) for (const l of t.layers ?? []) l.thickness = -0.1;
    for (const o of list(p, "openings").slice(0, 2)) {
      o.width = 1e300;
      o.offset = -1e300;
    }
    for (const s of list(p, "stairs")) {
      s.steps = 1e9;
      s.width = 0;
    }
    for (const c of list(p, "columns")) c.height = -1;
  });
  add("fehlende Felder", (p) => {
    for (const k of ["walls", "openings", "ceilings", "roofs", "stairs", "rooms", "columns", "drawings2d", "extrudedSolids", "wallTypes", "components", "drawingLevels", "hatches", "lineStyles", "layouts", "viewSnapshots"]) {
      for (const e of some(list(p, k))) {
        const keys = Object.keys(e).filter((x) => x !== "id");
        for (const x of keys) if (r() < 0.4) delete e[x];
      }
    }
  });
  add("doppelte ids", (p) => {
    for (const k of ["walls", "openings", "ceilings", "roofs", "stairs", "rooms", "drawings2d", "wallTypes", "components", "drawingLevels", "hatches", "lineStyles", "layers"]) {
      const a = list(p, k);
      if (a.length) p[k] = [...a, ...a.map((e) => ({ ...e }))];
    }
  });
  add("falsche Typen", (p) => {
    for (const w of list(p, "walls").slice(0, 1)) {
      w.height = "hoch";
      w.start = null;
    }
    for (const c of list(p, "ceilings").slice(0, 1)) c.outline = "keine Liste";
    for (const d of list(p, "drawings2d").slice(0, 2)) d.geom = { shape: "unbekannt" };
    for (const lv of list(p, "drawingLevels").slice(0, 1)) lv.kind = "unbekannt";
  });
  add("Schnitt-/Ansichtslinien kaputt", (p) => {
    for (const lv of list(p, "drawingLevels")) {
      if (lv.kind === "section" || lv.kind === "elevation") {
        lv.line = { a: { x: 0, y: 0 }, b: { x: 0, y: 0 } };
        lv.depth = NaN;
      }
    }
  });
  add("Gauben kaputt ([G5])", (p) => {
    const roofs = list(p, "roofs");
    const bad = [NaN, -1, 0, 1e9, Infinity];
    if (!Array.isArray(p.openings)) p.openings = [];
    for (const [i, rf] of roofs.entries()) {
      const o = rf.outline as { x: number; y: number }[] | undefined;
      const c = Array.isArray(o) && o[0] ? { x: o[0].x + 1, y: o[0].y + 1 } : { x: 1, y: 1 };
      rf.dormers = [
        { id: `GD${i}a`, kind: "sattel", position: c, width: 2, frontHeight: 1.2 },
        { id: `GD${i}b`, kind: "unbekannt", position: { x: NaN, y: 0 }, width: bad[i % bad.length], frontHeight: bad[(i + 1) % bad.length] },
        { id: `GD${i}c`, kind: "schlepp", position: c, width: 1e-9, frontHeight: 1, depth: -5, pitchDeg: 89, overhang: NaN, wallTypeId: "fehlt", roofTypeId: "fehlt" },
        { id: `GD${i}d`, kind: "walm", position: c, width: 3, frontHeight: 1, overhang: 1e6 },
      ];
      list(p, "openings").push({ id: `GW${i}`, type: "opening", hostWallId: "", hostRoofId: rf.id, hostDormerId: `GD${i}a`, categoryCode: "21", kind: "window", position: NaN, width: 0.8, height: 0.8, sillHeight: 0.1 });
      list(p, "openings").push({ id: `GX${i}`, type: "opening", hostWallId: "", hostRoofId: rf.id, hostDormerId: "fehlt", categoryCode: "21", kind: "window", position: 0, width: 0.8, height: 0.8, sillHeight: 0 });
    }
  });
  add("Baurecht/Sonne kaputt", (p) => {
    p.siteRules = { parcel: [{ x: 0, y: 0 }, { x: NaN, y: 1 }, { x: 1, y: 1 }], setbacks: [NaN, -1], defaultSetback: NaN, buildingLines: [{ a: { x: 0, y: 0 }, b: { x: 0, y: 0 } }], maxHeight: NaN, show: true };
    p.sunStudy = { when: "kein Datum", show: true };
    p.geoAnchor = { lv95: { e: NaN, n: 1e12 }, height: NaN, model: { x: 0, y: 0 } };
  });
  return out;
}

/** Ruft alle Kern-Abfragen/Fassaden auf ein Projekt auf; liefert die Fehler (Name: Meldung). */
async function runAll(project: Project): Promise<string[]> {
  const errors: string[] = [];
  const run = async (name: string, f: () => unknown): Promise<unknown> => {
    try {
      return await f();
    } catch (e) {
      errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
      return undefined;
    }
  };
  const codes = allCodes(project);
  const levels = Array.isArray(project.drawingLevels) ? project.drawingLevels.filter((l) => l && typeof l === "object") : [];
  const plans: unknown[] = [];
  for (const l of levels) {
    if (l.kind === "section") {
      const o = (await run(`computeSection ${l.id}`, () => computeSection(project, l))) as Awaited<ReturnType<typeof computeSection>> | undefined;
      if (o) plans.push(await run(`generateSectionPlan ${l.id}`, () => generateSectionPlan(o, false, { visibleCodes: codes, hiddenLines: true, openings: true })));
    } else if (l.kind === "elevation") {
      plans.push(await run(`generateElevationPlan ${l.id}`, () => generateElevationPlan(project, l)));
    } else {
      plans.push(await run(`generatePlan ${l.id}`, () => generatePlan(project, l.id, codes, undefined, "fein", true, false, true, 50)));
      await run(`generateVisibleLevelsPlan ${l.id}`, () => generateVisibleLevelsPlan(project, l.id, codes));
    }
  }
  await run("generatePlan unbekanntes Geschoss", () => generatePlan(project, "nope", codes));
  for (const [i, plan] of plans.entries()) {
    if (!plan) continue;
    const pl = plan as Parameters<typeof planToRenderScene>[0];
    await run(`planToRenderScene #${i}`, () => planToRenderScene(pl, 100));
    await run(`planSceneBin #${i}`, () => planSceneBin(pl, 100));
    await run(`planToSvgString #${i}`, () => planToSvgString(pl, { scaleDenominator: 100 }));
    await run(`buildPlanDxf #${i}`, () => buildPlanDxf(pl, project));
  }
  await run("projectToModel3d", () => projectToModel3d(project));
  await run("pickGeometry", () => pickGeometry(project));
  await run("wallMaterialColorMaps", () => wallMaterialColorMaps(project));
  await run("exportIfcSpf", () => exportIfcSpf(project));
  await run("exportObj", () => exportObj(project));
  await run("exportStl", () => exportStl(project));
  await run("exportGlb", () => exportGlb(project));
  await run("exportScheduleCsv", () => exportScheduleCsv(project));
  await run("computeKennzahlen", () => computeKennzahlen(project));
  await run("checkRoomProgram", () => checkRoomProgram(project));
  await run("compareRoomProgram", () => compareRoomProgram(project));
  await run("layoutRoomProgram", () => layoutRoomProgram(project));
  await run("computeAreaTable", () => computeAreaTable(project));
  await run("computeIvhb", () => computeIvhb(project));
  await run("checkSiteRules", () => checkSiteRules(project));
  await run("buildingFootprint", () => buildingFootprint(project));
  await run("modelTop", () => modelTop(project));
  await run("sun", () => {
    const { lat, lon } = projectLatLon(project);
    return shadowPolygons(project, sunPosition(lat, lon, new Date(Date.UTC(2026, 5, 21, 10))));
  });
  await run("Layouts", () => {
    const layouts = Array.isArray(project.layouts) ? project.layouts : [];
    const masters = Array.isArray(project.masterLayouts) ? project.masterLayouts : [];
    const folders = Array.isArray(project.layoutFolders) ? project.layoutFolders : [];
    buildLayoutTree(folders, layouts);
    buildMasterTree(folders, masters);
    for (const f of folders) folderPdfPages(project, f.id);
    for (const l of layouts as Layout[]) {
      resolveTitleBlock(project, l, masters.find((m) => m.id === l.masterId), "2026-10-29");
      for (const v of l.viewports ?? []) {
        const snap = (project.viewSnapshots ?? []).find((s) => s.id === v.snapshotId);
        if (snap) generatePlan(project, snap.activeLevelId ?? "", visibleCodesFromSnapshot(snap));
      }
    }
  });
  await run("validateProject", () => validateProject(project));
  await run("projectWarnings", () => projectWarnings(project));
  await run("serialize/parse", () => {
    const r = parseProjectFile(serializeProject(project));
    if (!r.ok) throw new Error(r.error);
  });
  return errors;
}

describe("Kern robust gegen kaputte Projekte", () => {
  beforeAll(async () => {
    await loadFileioForTests();
  });

  const bases: [string, () => Project][] = [
    ["Beispiel", () => sampleProject],
    ["alle Element-Arten", () => richProject()],
    ...[1, 3, 5, 8, 11, 13, 21].map((seed): [string, () => Project] => [`Zufall ${seed}`, () => randomProject(seed)]),
    ["Kacheln 2×2", () => bigSampleProject(2)],
  ];

  for (const [baseName, make] of bases) {
    it(`${baseName}: keine Abfrage wirft`, async () => {
      const base = make();
      const failures: string[] = [];
      for (const [i, [name, p]] of corruptions(base, 7 + baseName.length).entries()) {
        for (const e of await runAll(p)) failures.push(`[${name} #${i}] ${e}`);
      }
      expect(failures).toEqual([]);
    }, 240_000);
  }

  it("hängender Wandtyp: Plan wie mit dem Rückfall-Typ (kein Werfen, Wand bleibt sichtbar)", () => {
    const p = clone(sampleProject);
    p.walls[0].wallTypeId = "nope";
    const floor = sampleProject.drawingLevels.find((l) => l.kind === "floor")!;
    const plan = generatePlan(p as Project, floor.id, allCodes(sampleProject));
    expect(plan.primitives.some((x) => x.kind === "polygon" && (x as { wallId?: string }).wallId === p.walls[0].id)).toBe(true);
  });

  it("validate meldet hängende Verweise als Warnung", () => {
    const p = clone(sampleProject);
    p.walls[0].wallTypeId = "nope";
    p.openings[0].hostWallId = "wand-fehlt";
    const w = projectWarnings(p as Project);
    expect(w.some((x) => x.includes("nope"))).toBe(true);
    expect(w.some((x) => x.includes("wand-fehlt"))).toBe(true);
    expect(projectWarnings(sampleProject)).toEqual([]);
  });
});
