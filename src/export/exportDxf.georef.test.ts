// Georeferenzierter DXF-/DWG-Export ([154]-Befund, 7.11.): ALLE Entitäten liegen im selben Rahmen (LV95).
// Vorher blieben die Baugrube (Kontext `excavation`, Ebene CONTEXT) und Parzelle/Baulinien (`siteRules`,
// Ebene SYMBOLS) in lokalen Koordinaten, weil die Projekt-Verschiebung sie nicht mitnahm — nach dem Import
// lagen sie Hunderte Kilometer neben dem Gebäude. Geprüft am Musterhaus komplex (Kataster, Raster, Bemassung,
// Blöcke/INSERT mit ATTRIB, Texte, Schraffur bei 1:50, Kontext), je Geschoss: DXF (Gruppen-Codes), DWG
// (libredwg) und die Rundreise durch den eigenen Import.

import "../engine/fileioWasm.setup";
import { describe, expect, it } from "vitest";
import { buildPlanDwg, buildPlanDxf } from "./exportDxf";
import { libreDwgReader, nums, readDxf } from "./cadReadBack.testutil";
import { buildComplexSampleProject } from "../model/sampleProjectComplex";
import { generatePlan } from "../plan/generatePlan";
import { flattenCategories } from "../model/types";
import type { Project } from "../model/types";
import { projectGeoOrigin, projectToWorldCoords } from "../model/geoRebase";
import { parseDxf } from "../io/dxfParser";
import { ProjectDocument } from "../core/document";

const allCodes = (p: Project) => new Set(flattenCategories(p.layers).map((l) => l.code));

const project = buildComplexSampleProject();
const origin = projectGeoOrigin(project)!;
const world = projectToWorldCoords(project);
const floors = project.drawingLevels.filter((l) => l.kind === "floor");
/** Rahmen um das Grundstück (Kataster der Nachbarn reicht ≈ 55 m weit). */
const R = 200;
const inFrame = (x: number, y: number) => Math.abs(x - origin.e) < R && Math.abs(y - origin.n) < R;

describe("Georeferenzierter Export: alle Entitäten im LV95-Rahmen", () => {
  it("Baugrube und Baurecht wandern mit dem Projekt", () => {
    const ex = world.context?.find((c) => c.type === "excavation");
    expect(ex && "outline" in ex && ex.outline.every((p) => inFrame(p.x, p.y))).toBe(true);
    expect(ex && "positions" in ex).toBe(false);
    expect(world.siteRules!.parcel.every((p) => inFrame(p.x, p.y))).toBe(true);
    expect(world.siteRules!.buildingLines!.every((l) => inFrame(l.a.x, l.a.y) && inFrame(l.b.x, l.b.y))).toBe(true);
  });

  for (const lvl of floors) {
    it(`${lvl.name}: DXF (alle Punkt-Codes) und DWG (libredwg)`, async () => {
      // 1:50: Wände mit Schraffur (HATCH) statt schwarzer Füllung.
      const plan = generatePlan(world, lvl.id, allCodes(world), undefined, "mittel", false, false, true, 50);
      const dxf = readDxf(buildPlanDxf(plan, world, { scaleDenominator: 50, levelId: lvl.id }));
      const bad: string[] = [];
      // Punkt-Codes der Modellbereichs-Entitäten (10/11/13/14 x, 20/21/23/24 y): Endpunkte, Ecken, Einfügepunkte,
      // Textlagen, Bemassungs-Definitionspunkte, Schraffur-Ränder.
      for (const e of dxf.entities) {
        for (const [cx, cy] of [[10, 20], [11, 21], [13, 23], [14, 24]]) {
          // ELLIPSE 11/21: Hauptachse als Vektor zur Mitte ([169]), kein Lagepunkt.
          if (e.type === "ELLIPSE" && cx === 11) continue;
          const xs = nums(e, cx);
          const ys = nums(e, cy);
          for (let i = 0; i < Math.min(xs.length, ys.length); i++) {
            // HATCH: Seed-/Musterbasispunkt (0, 0) ist kein Lagepunkt.
            if (e.type === "HATCH" && xs[i] === 0 && ys[i] === 0) continue;
            if (!inFrame(xs[i], ys[i])) bad.push(`${e.layer}/${e.type} ${cx}: ${xs[i]}, ${ys[i]}`);
          }
        }
      }
      expect(bad.slice(0, 5)).toEqual([]);
      expect(dxf.entities.some((e) => e.type === "INSERT")).toBe(true);

      const db = (await libreDwgReader())(buildPlanDwg(plan, world, { scaleDenominator: 50, levelId: lvl.id }));
      // TEXT links/Grundlinie: der Ausrichtungspunkt ist nicht gespeichert und lautet (0, 0) wie bei AutoCAD
      // (`(11 0 0 0)`); er gilt nur bei Mitte/rechts — dort steht er im Rahmen (endPoint geprüft).
      const unset = (e: { type: string }, p?: { x: number; y: number }) => e.type === "TEXT" && p?.x === 0 && p?.y === 0;
      const dwgBad = db.entities.flatMap((e) =>
        [e.startPoint, unset(e, e.endPoint) ? undefined : e.endPoint, e.center, ...(e.vertices ?? [])]
          .filter((p) => p && !inFrame(p.x, p.y))
          .map((p) => `${e.layer}/${e.type}: ${p!.x}, ${p!.y}`),
      );
      expect(dwgBad.slice(0, 5)).toEqual([]);
    });
  }

  it("Rundreise Export → Import: alle importierten Zeichnungen im selben Rahmen", () => {
    const plan = generatePlan(world, "eg", allCodes(world));
    const parsed = parseDxf(buildPlanDxf(plan, world, { levelId: "eg" }));
    const base: Project = {
      ...project,
      geoAnchor: undefined,
      siteRules: undefined,
      walls: [],
      openings: [],
      rooms: [],
      drawings2d: [],
      stairs: [],
      ceilings: [],
      roofs: [],
      columns: [],
      context: [],
    };
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
    doc.close();
    if ("problems" in r) throw new Error(r.problems.join("; "));
    // Alle Punkte der importierten Zeichnungen (wie immer der Import sie verschiebt: gemeinsam).
    const xs: number[] = [];
    const ys: number[] = [];
    for (const d of r.project.drawings2d) {
      for (const m of JSON.stringify(d.geom).matchAll(/\{"x":(-?[\d.e+-]+),"y":(-?[\d.e+-]+)\}/g)) {
        xs.push(Number(m[1]));
        ys.push(Number(m[2]));
      }
    }
    expect(xs.length).toBeGreaterThan(1000);
    const span = (v: number[]) => v.reduce((a, b) => Math.max(a, b), -Infinity) - v.reduce((a, b) => Math.min(a, b), Infinity);
    expect(span(xs)).toBeLessThan(2 * R);
    expect(span(ys)).toBeLessThan(2 * R);
  });
});
