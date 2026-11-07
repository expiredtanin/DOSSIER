// [154] Rundreise: eigener DXF-Export eines Geschosses → DXF-Import (Layer als Kategorien, neue Zeichnungsebene)
// → „Bauteile aus Zeichnung erkennen“ → Wände/Öffnungen mit dem Original vergleichen (Quote auf der Konsole).
// Wände: Achse (beide Richtungen, ±1 cm) und Dicke (±1 mm); Öffnungen: Art und Pfosten (±2 cm), Türen zusätzlich
// Scharnierpunkt und Aufschlagseite. Mit `DOSSIER_RECOGNIZE_OUT=<ordner>` werden Import und Ergebnis als .obp
// geschrieben (Bilder für den Bericht).

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { loadFileioForTests } from "../engine/fileioWasm.testing";
import { parseDxf } from "./dxfParser";
import { buildPlanDxf } from "../export/exportDxf";
import { generatePlan } from "../plan/generatePlan";
import { sampleProject } from "../model/sampleProject";
import { buildComplexSampleProject } from "../model/sampleProjectComplex";
import { flattenCategories } from "../model/types";
import type { Opening, Project, Vec2, Wall } from "../model/types";
import { ProjectDocument } from "../core/document";
import { bulgeArc } from "../geometry/bulge";
import { serializeProject } from "./projectFormat";
import { recognizeMutation, recognizeReport, type RecognizeReport } from "./recognizeDrawing";

const OUT = process.env.DOSSIER_RECOGNIZE_OUT;

const allCodes = (p: Project) => new Set(flattenCategories(p.layers).map((l) => l.code));
const thickness = (p: Project, w: Wall) => (p.wallTypes.find((t) => t.id === w.wallTypeId)?.layers ?? []).reduce((s, l) => s + l.thickness, 0);
const dist = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y);

interface Jambs {
  kind: "door" | "window" | "void";
  a: Vec2;
  b: Vec2;
  /** Tür: Scharnierpunkt und Aufschlagseite (Einheitsvektor quer zur Wand). */
  hinge?: Vec2;
  side?: Vec2;
}

function jambs(p: Project, o: Opening): Jambs | null {
  const w = p.walls.find((x) => x.id === o.hostWallId);
  if (!w) return null;
  const l = dist(w.start, w.end);
  const u = { x: (w.end.x - w.start.x) / l, y: (w.end.y - w.start.y) / l };
  // Bogenwand: Lage als Bogenlänge auf der Achse ab `start`.
  const arc = w.bulge ? bulgeArc(w.start, w.end, w.bulge) : null;
  const at = (s: number) =>
    arc
      ? { x: arc.center.x + arc.r * Math.cos(arc.a0 + Math.sign(arc.sweep) * (s / arc.r)), y: arc.center.y + arc.r * Math.sin(arc.a0 + Math.sign(arc.sweep) * (s / arc.r)) }
      : { x: w.start.x + u.x * s, y: w.start.y + u.y * s };
  const voidish = o.kind === "door" && (o.doorType === "wandoeffnung" || p.doorTypes?.find((t) => t.id === o.typeId)?.kind === "wandoeffnung");
  const kind = voidish ? "void" : o.kind;
  const j: Jambs = { kind, a: at(o.position), b: at(o.position + o.width) };
  if (kind === "door") {
    j.hinge = at(o.position + (o.hinge === "end" ? o.width : 0));
    const k = (o.swing === "right" ? -1 : 1) * (o.openingDir === "out" ? -1 : 1);
    j.side = { x: -u.y * k, y: u.x * k };
  }
  return j;
}

interface Quote {
  walls: [number, number];
  /** Achsen-Abdeckung 0…1. */
  axis: number;
  openings: [number, number];
  doors: [number, number];
  report: RecognizeReport;
  imported: Project;
  result: Project;
}

/** Geschoss `levelId` von `orig` exportieren, in ein leeres Projekt mit denselben Typen importieren, erkennen. */
function roundtrip(orig: Project, levelId: string): Quote {
  const plan = generatePlan(orig, levelId, allCodes(orig));
  const dxf = buildPlanDxf(plan, orig, { scaleDenominator: 100, levelId });
  const parsed = parseDxf(dxf);
  const base: Project = { ...orig, walls: [], openings: [], rooms: [], drawings2d: [], stairs: [], ceilings: [], roofs: [], columns: [] };
  const doc = new ProjectDocument(base);
  const r = doc.importDrawing(
    base,
    parsed.src,
    {
      target: { kind: "new", name: "Import" },
      categoryMode: "byLayer",
      activeCategoryCode: "20",
      importMeshes: false,
      levelNameTemplate: "Import {n}",
      parentName: "Import",
      dashStyleTemplate: "{pattern}",
    },
    0,
  );
  if ("problems" in r) throw new Error(r.problems.join("; "));
  const imported = r.project;
  const level = imported.drawingLevels.find((l) => l.id === levelId)!;
  const opts = { levelId, floorHeight: level.floorHeight, sourceLevelId: r.levelId, wallTypeId: orig.wallTypes[0]?.id, typeName: "Wand {cm} cm (erkannt)" };
  const report = recognizeReport(imported, opts);
  const result = recognizeMutation(opts)(imported);
  doc.close();

  const ow = orig.walls.filter((w) => w.floorId === levelId);
  const nw = result.walls.filter((w) => w.floorId === levelId);
  // Gleiche Wand: Dicke, Endpunkte (±1 cm), bei Bogenwänden derselbe Bogen (Bulge, umgekehrt mit Gegenzeichen).
  const sameWall = (w: Wall, n: Wall) => {
    if (Math.abs(thickness(orig, w) - thickness(result, n)) >= 1e-3) return false;
    const fwd = dist(w.start, n.start) < 0.01 && dist(w.end, n.end) < 0.01;
    const rev = dist(w.start, n.end) < 0.01 && dist(w.end, n.start) < 0.01;
    const [bw, bn] = [w.bulge ?? 0, n.bulge ?? 0];
    return (fwd && Math.abs(bw - bn) < 1e-3) || (rev && Math.abs(bw + bn) < 1e-3);
  };
  const wallOk = ow.filter((w) => nw.some((n) => sameWall(w, n))).length;
  // Achsen-Abdeckung (gerade Wände): Anteil der Achslänge, die eine erkannte Achse gleicher Dicke trägt
  // (zusammengelegte Wände über einen T-Stoss zählen hier voll).
  const onAxis = (p: Vec2, n: Wall) => {
    const l2 = (n.end.x - n.start.x) ** 2 + (n.end.y - n.start.y) ** 2;
    const s = Math.max(0, Math.min(1, ((p.x - n.start.x) * (n.end.x - n.start.x) + (p.y - n.start.y) * (n.end.y - n.start.y)) / l2));
    return dist(p, { x: n.start.x + s * (n.end.x - n.start.x), y: n.start.y + s * (n.end.y - n.start.y) }) < 0.01;
  };
  let [axisOk, axisAll] = [0, 0];
  for (const w of ow.filter((x) => !x.bulge)) {
    const l = dist(w.start, w.end);
    const k = Math.max(1, Math.round(l / 0.05));
    for (let i = 0; i < k; i++) {
      const s = (i + 0.5) / k;
      const p = { x: w.start.x + s * (w.end.x - w.start.x), y: w.start.y + s * (w.end.y - w.start.y) };
      axisAll += l / k;
      if (nw.some((n) => !n.bulge && Math.abs(thickness(orig, w) - thickness(result, n)) < 1e-3 && onAxis(p, n))) axisOk += l / k;
    }
  }
  const oo = (orig.openings ?? []).filter((o) => ow.some((w) => w.id === o.hostWallId)).map((o) => jambs(orig, o)).filter((j): j is Jambs => !!j);
  const no = (result.openings ?? []).map((o) => jambs(result, o)).filter((j): j is Jambs => !!j);
  const same = (x: Jambs, y: Jambs) =>
    x.kind === y.kind && ((dist(x.a, y.a) < 0.02 && dist(x.b, y.b) < 0.02) || (dist(x.a, y.b) < 0.02 && dist(x.b, y.a) < 0.02));
  const openOk = oo.filter((x) => no.some((y) => same(x, y))).length;
  const od = oo.filter((x) => x.kind === "door");
  const doorOk = od.filter((x) =>
    no.some((y) => same(x, y) && dist(x.hinge!, y.hinge!) < 0.02 && dist(x.side!, y.side!) < 1e-6),
  ).length;
  return { walls: [wallOk, ow.length], axis: axisAll ? axisOk / axisAll : 1, openings: [openOk, oo.length], doors: [doorOk, od.length], report, imported, result };
}

const pct = ([a, b]: [number, number]) => `${a}/${b} (${b ? Math.round((100 * a) / b) : 100} %)`;

function log(name: string, q: Quote) {
  console.log(
    `[154] ${name}: Wände ${pct(q.walls)} (Achsen ${Math.round(q.axis * 100)} %), Öffnungen ${pct(q.openings)}, Türen mit Anschlag/Aufschlag ${pct(q.doors)}; ` +
      `erkannt ${q.report.walls} Wände, ${q.report.doors} Türen, ${q.report.windows} Fenster, ${q.report.voids} Durchbrüche, ${q.report.rooms} Räume, unklar ${q.report.unclear.length} (${[...new Set(q.report.unclear.map((u) => u.code))].join(", ")})`,
  );
  if (OUT) {
    writeFileSync(join(OUT, `${name}-import.obp`), serializeProject(q.imported));
    writeFileSync(join(OUT, `${name}-erkannt.obp`), serializeProject(q.result));
  }
}

describe("[154] Rundreise DXF-Export → Import → Bauteile erkennen", () => {
  beforeAll(loadFileioForTests);

  it("Musterhaus EG: alle Wände und Öffnungen, Tür mit Anschlag und Aufschlag", () => {
    const q = roundtrip(sampleProject, "eg");
    log("musterhaus-eg", q);
    expect(q.walls).toEqual([5, 5]);
    expect(q.openings).toEqual([3, 3]);
    expect(q.doors).toEqual([1, 1]);
    // Wandtypen nach Dicke wiederverwendet, keine neuen.
    expect(q.result.wallTypes.length).toBe(sampleProject.wallTypes.length);
    expect(q.report.layerFilter).toBe(true);
    // Raum mit Name aus dem Raumstempel.
    expect(q.result.rooms?.some((r) => r.name === "Wohnen")).toBe(true);
  });

  it("Musterhaus OG", () => {
    const q = roundtrip(sampleProject, "og");
    log("musterhaus-og", q);
    expect(q.walls[0]).toBe(q.walls[1]);
    expect(q.openings[0]).toBe(q.openings[1]);
  });

  it("Musterhaus komplex: Quote je Geschoss", () => {
    const p = buildComplexSampleProject();
    const floors = p.drawingLevels.filter((l) => l.kind === "floor" && p.walls.some((w) => w.floorId === l.id));
    let [w, wn, o, on, ax] = [0, 0, 0, 0, 0];
    for (const l of floors) {
      const q = roundtrip(p, l.id);
      log(`komplex-${l.id}`, q);
      w += q.walls[0];
      ax += q.axis / floors.length;
      wn += q.walls[1];
      o += q.openings[0];
      on += q.openings[1];
    }
    console.log(`[154] Musterhaus komplex gesamt: Wände ${pct([w, wn])} (Achsen ${Math.round(ax * 100)} %), Öffnungen ${pct([o, on])}`);
    expect(wn).toBeGreaterThan(0);
    expect(w / wn).toBeGreaterThan(0.6);
  }, 120_000);
});
