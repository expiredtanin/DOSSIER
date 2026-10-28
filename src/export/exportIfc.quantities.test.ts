// Basismengen im IFC-Export ([B5], 28.10.): Qto_Wall/Slab/Roof/Column/Door/Window/StairFlight/Railing
// werden gegen die Geometrie geprüft, die ifcopenshell aus derselben Datei liest (± 1 %), dazu Schema und
// Express-Regeln (`scripts/validate-ifc.py`, 0 Befunde). Ohne Python/ifcopenshell wird der zweite Teil übersprungen.

import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "../engine/fileioWasm.setup";
import { exportIfcSpf } from "./exportIfc";
import { sampleProject } from "../model/sampleProject";
import type { Column, Project, Stair } from "../model/types";

const hasIfcOpenShell = spawnSync("python3", ["-c", "import ifcopenshell, ifcopenshell.validate, numpy"]).status === 0;

/** Das Demo-Haus plus Stütze, Deckenaussparung, L-Treppe (massiv) und gerade Treppe mit Geländer. */
function project(): Project {
  const eg = "eg";
  const column: Column = { id: "C1", type: "column", floorId: eg, categoryCode: "50", position: { x: 6.5, y: 1 }, profile: { kind: "rect", width: 0.3, depth: 0.2 }, rotation: 0.3, height: 2.5 };
  const st0 = sampleProject.stairs![0];
  const lStair: Stair = { ...st0, id: "ST-L", typeId: "stair-massiv", shape: "L", start: { x: 7.5, y: 0.4 }, run2Length: 1.5, turn: 1, stepCount: 14 };
  const railed: Stair = { ...st0, id: "ST-R", typeId: "stair-rail", start: { x: 10, y: 0.4 } };
  return {
    ...sampleProject,
    ceilings: sampleProject.ceilings!.map((c) => ({ ...c, openings: [[{ x: 1, y: 1 }, { x: 2.5, y: 1 }, { x: 2.5, y: 2 }, { x: 1, y: 2 }]] })),
    columns: [column],
    stairTypes: [...sampleProject.stairTypes!, { id: "stair-rail", name: "Massiv mit Handlauf", structure: "massiv", closedRisers: true, treadThickness: 0.04, nosing: 0.03, railing: "beide", defaultWidth: 1 }],
    stairs: [...sampleProject.stairs!, lStair, railed],
  } as Project;
}

function writeIfc(name: string, ifc: string): string {
  const dir = mkdtempSync(join(tmpdir(), "dossier-qto-"));
  const file = join(dir, `${name}.ifc`);
  writeFileSync(file, ifc);
  return file;
}

/**
 * Je Bauteil mit Basismengen: Klasse, Name, Mengen und unabhängig aus der Geometrie gelesene Werte
 * (Volumen mit/ohne Öffnungsabzug, nach oben zeigende Fläche, Bounding-Box lokal).
 */
const QTO_INFO = `
import json, sys
import numpy as np
import ifcopenshell, ifcopenshell.geom, ifcopenshell.util.element as ue, ifcopenshell.util.shape as us
m = ifcopenshell.open(sys.argv[1])
net = ifcopenshell.geom.settings()
gross = ifcopenshell.geom.settings()
gross.set("disable-opening-subtractions", True)
local = ifcopenshell.geom.settings()
local.set("use-world-coords", False)

def up_areas(geom):
    v = np.array(geom.verts).reshape(-1, 3)
    f = np.array(geom.faces).reshape(-1, 3)
    n = np.cross(v[f[:, 1]] - v[f[:, 0]], v[f[:, 2]] - v[f[:, 0]])
    area = np.linalg.norm(n, axis=1) / 2
    nz = n[:, 2] / np.maximum(np.linalg.norm(n, axis=1), 1e-12)
    up = nz > 0.1
    return float(area[up].sum()), float((area[up] * nz[up]).sum())

def opening_dims(wall):
    out = []
    for rel in wall.HasOpenings:
        e = rel.RelatedOpeningElement
        g = ifcopenshell.geom.create_shape(local, e).geometry
        v = np.array(g.verts).reshape(-1, 3)
        d = v.max(axis=0) - v.min(axis=0)
        out.append([float(x) for x in d])
    return out

out = []
for el in m.by_type("IfcElement"):
    qtos = ue.get_psets(el, qtos_only=True)
    if not qtos:
        continue
    item = {"cls": el.is_a(), "name": el.Name, "predefined": getattr(el, "PredefinedType", None), "qto": qtos}
    if el.Representation is not None:
        shape = ifcopenshell.geom.create_shape(net, el)
        item["volume"] = us.get_volume(shape.geometry)
        item["area"] = us.get_area(shape.geometry)
        item["up"] = up_areas(shape.geometry)
        item["rep"] = [r for r in el.Representation.Representations if r.RepresentationIdentifier == "Body"][0].RepresentationType
        if el.is_a("IfcWall"):
            item["grossVolume"] = us.get_volume(ifcopenshell.geom.create_shape(gross, el).geometry)
            item["openings"] = opening_dims(el)
            g = shape.geometry
            v = np.array(g.verts).reshape(-1, 3)
            item["zExtent"] = float(v[:, 2].max() - v[:, 2].min())
        if el.is_a("IfcSlab"):
            prof = [r for r in el.Representation.Representations if r.RepresentationIdentifier == "Body"][0].Items[0].SweptArea
            holes = []
            if prof.is_a("IfcArbitraryProfileDefWithVoids"):
                for c in prof.InnerCurves:
                    p = np.array([q.Coordinates for q in c.Points])
                    holes.append(float(abs(0.5 * np.sum(p[:-1, 0] * p[1:, 1] - p[1:, 0] * p[:-1, 1]))))
            item["holeAreas"] = holes
            item["depth"] = float(el.Representation.Representations[0].Items[0].Depth)
    if el.is_a("IfcDoor") or el.is_a("IfcWindow"):
        host = [r.RelatingOpeningElement for r in el.FillsVoids]
        g = ifcopenshell.geom.create_shape(local, host[0]).geometry
        v = np.array(g.verts).reshape(-1, 3)
        item["openingDims"] = [float(x) for x in (v.max(axis=0) - v.min(axis=0))]
    out.append(item)
print(json.dumps(out))
`;

interface Item {
  cls: string;
  name: string;
  predefined: string | null;
  qto: Record<string, Record<string, number>>;
  volume?: number;
  area?: number;
  up?: [number, number];
  rep?: string;
  grossVolume?: number;
  openings?: number[][];
  zExtent?: number;
  holeAreas?: number[];
  depth?: number;
  openingDims?: number[];
}

function info(name: string, ifc: string): Item[] {
  const r = spawnSync("python3", ["-c", QTO_INFO, writeIfc(name, ifc)], { encoding: "utf8", timeout: 120_000 });
  expect(r.status, r.stderr).toBe(0);
  return JSON.parse(r.stdout);
}

const rel = (a: number, b: number) => Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), 1e-9);
const close = (a: number, b: number, tol = 0.01) => expect(rel(a, b), `${a} ≠ ${b}`).toBeLessThanOrEqual(tol);
const qof = (it: Item, set: string) => it.qto[set] ?? {};

describe("Basismengen im Export (ohne ifcopenshell)", () => {
  it("jedes Bauteil trägt seine Mengen; Treppe mit Läufen, Podest und Geländer; Deckenaussparung", () => {
    const ifc = exportIfcSpf(project());
    const count = (cls: string) => (ifc.match(new RegExp(`^#\\d+=${cls}\\(`, "gm")) ?? []).length;
    const sets = (name: string) => (ifc.match(new RegExp(`IFCELEMENTQUANTITY\\('[^']*',#\\d+,'${name}'`, "g")) ?? []).length;
    expect(sets("Qto_WallBaseQuantities")).toBe(count("IFCWALL"));
    expect(sets("Qto_SlabBaseQuantities")).toBe(count("IFCSLAB")); // Decke + Podest der L-Treppe
    expect(sets("Qto_RoofBaseQuantities")).toBe(1);
    expect(sets("Qto_ColumnBaseQuantities")).toBe(1);
    expect(sets("Qto_DoorBaseQuantities")).toBe(count("IFCDOOR"));
    expect(sets("Qto_WindowBaseQuantities")).toBe(count("IFCWINDOW"));
    expect(sets("Qto_StairFlightBaseQuantities")).toBe(count("IFCSTAIRFLIGHT"));
    expect(sets("Qto_RailingBaseQuantities")).toBe(count("IFCRAILING"));
    expect(count("IFCSTAIR")).toBe(3);
    expect(count("IFCSTAIRFLIGHT")).toBe(1 /* Beton: Netz */ + 2 /* L */ + 1);
    expect(count("IFCRAILING")).toBe(1);
    expect(count("IFCARBITRARYPROFILEDEFWITHVOIDS")).toBe(1);
    expect(ifc).toContain(".LANDING.);");
  });

  it("Export ist deterministisch (GUIDs der Mengen stabil)", () => {
    const strip = (s: string) => s.replace(/FILE_NAME\([^\n]*\n/, "").replace(/IFCOWNERHISTORY\([^\n]*\n/, "");
    expect(strip(exportIfcSpf(project()))).toBe(strip(exportIfcSpf(project())));
  });
});

describe.skipIf(!hasIfcOpenShell)("Basismengen gegen ifcopenshell", { timeout: 120_000 }, () => {
  const ifc = exportIfcSpf(project());
  const items = info("qto", ifc);
  const of = (cls: string) => items.filter((i) => i.cls === cls);

  it("schema- und regelkonform, alle Körper erzeugbar (0 Befunde)", () => {
    const r = spawnSync("python3", ["scripts/validate-ifc.py", writeIfc("qto-validate", ifc)], { encoding: "utf8", timeout: 120_000 });
    expect(`${r.stdout}\n${r.stderr}`).toContain("0 Befunde");
    expect(r.status).toBe(0);
  });

  it("Wände: Netto-Volumen = Geometrie mit Öffnungsabzug, Brutto = ohne (Extrusions-Wände), Länge/Höhe/Seitenfläche", () => {
    const walls = of("IfcWall");
    expect(walls.length).toBe(9);
    for (const w of walls) {
      const q = qof(w, "Qto_WallBaseQuantities");
      close(q.NetVolume, w.volume!);
      if (w.rep === "SweptSolid") {
        close(q.GrossVolume, w.grossVolume!);
        // Seitenfläche brutto = Länge × Höhe; netto zieht die Öffnungen ab (Breite × Höhe der Öffnungskörper).
        close(q.GrossSideArea, q.Length * q.Height);
        const holes = (w.openings ?? []).reduce((s, d) => s + Math.max(...d.slice(0, 2)) * d[2], 0);
        // Öffnungsquader sind quer 4 cm dicker als die Wand: die längere der zwei Grundrissmasse ist die Öffnungsbreite,
        // sofern sie grösser als die Wanddicke ist.
        if ((w.openings ?? []).every((d) => Math.max(d[0], d[1]) > q.Width + 0.05)) close(q.NetSideArea, q.GrossSideArea - holes);
        close(q.Height, w.zExtent!);
      } else {
        // Netz-Wand: Brutto ≥ Netto, Seitenfläche netto ≤ brutto.
        expect(q.GrossVolume).toBeGreaterThanOrEqual(q.NetVolume);
      }
      expect(q.NetSideArea).toBeLessThanOrEqual(q.GrossSideArea + 1e-9);
    }
    expect(walls.some((w) => w.rep === "SweptSolid")).toBe(true);
    expect(walls.some((w) => w.rep === "Tessellation")).toBe(true);
    // Mindestens eine Wand mit Öffnung: Netto < Brutto.
    expect(walls.some((w) => qof(w, "Qto_WallBaseQuantities").NetVolume < qof(w, "Qto_WallBaseQuantities").GrossVolume - 1e-6)).toBe(true);
  });

  it("Decken und Podest: Volumen nach ifcopenshell, Aussparung = Brutto − Netto", () => {
    const slabs = of("IfcSlab");
    const floor = slabs.find((s) => s.predefined === "FLOOR")!;
    const q = qof(floor, "Qto_SlabBaseQuantities");
    close(q.NetVolume, floor.volume!);
    const holes = floor.holeAreas!.reduce((a, b) => a + b, 0);
    expect(holes).toBeCloseTo(1.5, 9);
    close(q.GrossVolume - q.NetVolume, holes * floor.depth!);
    close(q.GrossArea - q.NetArea, holes);
    close(q.Width, floor.depth!);
    const landing = slabs.find((s) => s.predefined === "LANDING")!;
    const ql = qof(landing, "Qto_SlabBaseQuantities");
    close(ql.NetVolume, landing.volume!);
    close(ql.GrossArea * ql.Width, ql.GrossVolume);
  });

  it("Dach: Grundrissprojektion und geneigte Fläche = nach oben zeigende Netz-Dreiecke", () => {
    const [roof] = of("IfcRoof");
    const q = qof(roof, "Qto_RoofBaseQuantities");
    close(q.GrossArea, roof.up![0]);
    close(q.ProjectedArea, roof.up![1]);
    expect(q.GrossArea).toBeGreaterThan(q.ProjectedArea);
  });

  it("Stütze: Volumen, Querschnitt × Länge", () => {
    const [col] = of("IfcColumn");
    const q = qof(col, "Qto_ColumnBaseQuantities");
    close(q.GrossVolume, col.volume!);
    close(q.CrossSectionArea * q.Length, q.GrossVolume);
    close(q.CrossSectionArea, 0.3 * 0.2);
    expect(q.Length).toBeCloseTo(2.5, 9);
  });

  it("Türen und Fenster: Breite/Höhe wie der Öffnungskörper, Fläche = Breite × Höhe", () => {
    const fills = [...of("IfcDoor"), ...of("IfcWindow")];
    expect(fills.length).toBe(3);
    for (const f of fills) {
      const q = qof(f, f.cls === "IfcDoor" ? "Qto_DoorBaseQuantities" : "Qto_WindowBaseQuantities");
      close(q.Area, q.Width * q.Height);
      close(q.Height, f.openingDims![2]);
      expect([f.openingDims![0], f.openingDims![1]].some((d) => rel(d, q.Width) <= 0.01), `${f.name} Breite ${q.Width}`).toBe(true);
    }
  });

  it("Treppenläufe: Brutto-Volumen = Geometrie; Geländer mit Länge", () => {
    const flights = of("IfcStairFlight");
    expect(flights.length).toBe(4);
    for (const f of flights) {
      const q = qof(f, "Qto_StairFlightBaseQuantities");
      // Massive Treppen: Prismen können sich an den Nasen überlappen — ifcopenshell vereinigt nicht, Summe stimmt.
      close(q.GrossVolume, f.volume!, 0.011);
      expect(q.Length).toBeGreaterThan(1);
    }
    const [rail] = of("IfcRailing");
    expect(qof(rail, "Qto_RailingBaseQuantities").Length).toBeGreaterThan(3);
  });
});
