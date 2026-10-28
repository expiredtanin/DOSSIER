// IFC-Export gegen ifcopenshell prüfen ([B1]/[18]): Schema, Express-Regeln und Geometrie je Bauteil
// (`scripts/validate-ifc.py`). Ohne Python/ifcopenshell wird der Test übersprungen — in der CI ist
// es installiert (.github/workflows/check.yml).

import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "../engine/fileioWasm.setup";
import { exportIfcSpf, ifcGuid } from "./exportIfc";
import { pickGeometry } from "../plan/toWalls3d";
import { wallCutMeshes } from "../plan/wallMeshCut";
import { sampleProject } from "../model/sampleProject";
import type { Project } from "../model/types";

const hasIfcOpenShell = spawnSync("python3", ["-c", "import ifcopenshell, ifcopenshell.validate, _pytest"]).status === 0;

function writeIfc(name: string, ifc: string): string {
  const dir = mkdtempSync(join(tmpdir(), "dossier-ifc-"));
  const file = join(dir, `${name}.ifc`);
  writeFileSync(file, ifc);
  return file;
}

function validate(name: string, ifc: string): { status: number | null; out: string } {
  const r = spawnSync("python3", ["scripts/validate-ifc.py", writeIfc(name, ifc)], { encoding: "utf8", timeout: 120_000 });
  return { status: r.status, out: `${r.stdout}\n${r.stderr}` };
}

// Volumen je IfcWall nach ifcopenshell (Öffnungen abgezogen) und die Öffnungs-Beziehungen.
const WALL_VOLUMES = `
import json, sys
import ifcopenshell, ifcopenshell.geom, ifcopenshell.util.shape as us
m = ifcopenshell.open(sys.argv[1])
s = ifcopenshell.geom.settings()
out = {}
for w in m.by_type("IfcWall"):
    sh = ifcopenshell.geom.create_shape(s, w)
    out[w.GlobalId] = {"volume": us.get_volume(sh.geometry), "openings": len(w.HasOpenings),
        "fills": sum(len(r.RelatedOpeningElement.HasFillings) for r in w.HasOpenings),
        "rep": [r for r in w.Representation.Representations if r.RepresentationIdentifier == "Body"][0].RepresentationType}
print(json.dumps(out))
`;

type WallVolume = { volume: number; openings: number; fills: number; rep: string };

/** Je IfcWall (Schlüssel GlobalId): Volumen, Anzahl Öffnungen/Füllungen, Darstellungsart. */
function wallVolumes(name: string, ifc: string): Record<string, WallVolume> {
  const r = spawnSync("python3", ["-c", WALL_VOLUMES, writeIfc(name, ifc)], { encoding: "utf8", timeout: 120_000 });
  expect(r.status, r.stderr).toBe(0);
  return JSON.parse(r.stdout);
}

// Achse und IfcMaterialLayerSetUsage je IfcWall: Placement, Achs-Polylinie (lokal), Usage und je
// Körper (Extrusion) der Bereich quer zur Achse (lokal Y) — alles unabhängig vom Exporter gelesen.
const WALL_AXES = `
import json, sys
import ifcopenshell, ifcopenshell.util.placement as up
m = ifcopenshell.open(sys.argv[1])
out = {}
for w in m.by_type("IfcWall"):
    reps = {r.RepresentationIdentifier: r for r in w.Representation.Representations}
    mat = up.get_local_placement(w.ObjectPlacement)
    item = {"identifiers": sorted(reps), "usage": None, "axis": None, "items": []}
    if "Axis" in reps:
        pts = [p.Coordinates for p in reps["Axis"].Items[0].Points]
        a = mat @ [pts[0][0], pts[0][1], 0, 1]
        b = mat @ [pts[1][0], pts[1][1], 0, 1]
        item["axis"] = [[a[0], a[1]], [b[0], b[1]], reps["Axis"].RepresentationType, [list(p) for p in pts]]
    for e in reps["Body"].Items:
        if e.is_a("IfcExtrudedAreaSolid"):
            ys = [p.Coordinates[1] for p in e.SweptArea.OuterCurve.Points]
            item["items"].append([min(ys), max(ys)])
    for rel in w.HasAssociations:
        if rel.is_a("IfcRelAssociatesMaterial") and rel.RelatingMaterial.is_a("IfcMaterialLayerSetUsage"):
            u = rel.RelatingMaterial
            item["usage"] = {"dir": u.LayerSetDirection, "sense": u.DirectionSense, "offset": u.OffsetFromReferenceLine,
                "layers": [l.LayerThickness for l in u.ForLayerSet.MaterialLayers]}
    out[w.GlobalId] = item
print(json.dumps(out))
`;

interface WallAxis {
  identifiers: string[];
  usage: { dir: string; sense: string; offset: number; layers: number[] } | null;
  axis: [number[], number[], string, number[][]] | null;
  items: number[][];
}

function wallAxes(name: string, ifc: string): Record<string, WallAxis> {
  const r = spawnSync("python3", ["-c", WALL_AXES, writeIfc(name, ifc)], { encoding: "utf8", timeout: 120_000 });
  expect(r.status, r.stderr).toBe(0);
  return JSON.parse(r.stdout);
}

/** Eine freistehende Wand 5 × 0.4 × 2.6 m mit einem Fenster 1.2 × 1.2 m (Brüstung 0.9 m). */
function singleWall(recess: boolean): Project {
  return {
    ...sampleProject,
    walls: [{ id: "W1", type: "wall", floorId: "eg", categoryCode: "20", start: { x: 0, y: 0 }, end: { x: 5, y: 0 }, wallTypeId: "solo", height: 2.6 }],
    wallTypes: [...sampleProject.wallTypes, { id: "solo", name: "Beton 40", layers: [{ componentId: sampleProject.components[0].id, thickness: 0.4 }] }],
    windowTypes: [{ id: "wt", name: "Fenster", kind: "drehkipp", wingCount: 1, glazing: "dreifach", frameThickness: 0.08, defaultSillHeight: 0.9, defaultWidth: 1.2, defaultHeight: 1.2, innerLayerRecess: recess }],
    openings: [{ id: "F1", type: "opening", hostWallId: "W1", categoryCode: "21", kind: "window", position: 1, width: 1.2, height: 1.2, sillHeight: 0.9, typeId: "wt" }],
    ceilings: [],
    roofs: [],
    rooms: [],
    stairs: [],
    columns: [],
  } as Project;
}

// Startet je Fall einen Python-Prozess (~3 s, unter Last mehr): eigenes Zeitlimit statt 5 s.
describe.skipIf(!hasIfcOpenShell)("IFC-Export gegen ifcopenshell", { timeout: 60_000 }, () => {
  it("Demo-Haus: gültig, alle Körper erzeugbar", () => {
    const r = validate("demo-haus", exportIfcSpf(sampleProject));
    expect(r.out).toContain("0 Befunde");
    expect(r.status).toBe(0);
  });
  it("Umlaute in Namen", () => {
    const p = { ...sampleProject, name: "Wohnüberbauung «Süd»", rooms: (sampleProject.rooms ?? []).map((r) => ({ ...r, name: "Küche/Essen" })) };
    const r = validate("umlaute", exportIfcSpf(p));
    expect(r.out).toContain("0 Befunde");
    expect(r.status).toBe(0);
  });
  it("mit Stütze (Rechteck und rund)", () => {
    const col = (id: string, profile: { kind: "rect"; width: number; depth: number } | { kind: "round"; radius: number }) => ({
      id, type: "column" as const, floorId: "eg", categoryCode: "50", position: { x: 1, y: 1 }, profile, rotation: 0.3, height: 2.5,
    });
    const p = { ...sampleProject, columns: [col("S1", { kind: "rect", width: 0.3, depth: 0.2 }), col("S2", { kind: "round", radius: 0.15 })] };
    const r = validate("stuetzen", exportIfcSpf(p));
    expect(r.out).toContain("0 Befunde");
    expect(r.status).toBe(0);
  });
  it("[B5] Wand als Extrusion mit IfcOpeningElement: Volumen = Wand − Öffnung", () => {
    const ifc = exportIfcSpf(singleWall(false));
    const r = validate("oeffnung", ifc);
    expect(r.out).toContain("0 Befunde");
    const [w] = Object.values(wallVolumes("oeffnung", ifc));
    expect(w.rep).toBe("SweptSolid");
    expect(w.openings).toBe(1);
    expect(w.fills).toBe(1);
    expect(w.volume).toBeCloseTo(5 * 0.4 * 2.6 - 1.2 * 1.2 * 0.4, 4);
  });
  it("[B5] Mesh-Wand (Laibungs-Rücksprung) mit Öffnung+Füllung: Öffnung zieht nichts doppelt ab", () => {
    const ifc = exportIfcSpf(singleWall(true));
    const r = validate("oeffnung-mesh", ifc);
    expect(r.out).toContain("0 Befunde");
    const [w] = Object.values(wallVolumes("oeffnung-mesh", ifc));
    expect(w.rep).toBe("Tessellation");
    expect(w.openings).toBe(1);
    expect(w.fills).toBe(1);
    // Rücksprung = Schichtdicke 0.4 rundum: Loch 2.0 × 2.0 m durch die ganze Wand.
    expect(w.volume).toBeCloseTo(5 * 0.4 * 2.6 - 2.0 * 2.0 * 0.4, 3);
  });
  it("[B5] Demo-Haus: jede Wand hat nach ifcopenshell (Öffnungen abgezogen) das Volumen des 3D-Meshes", () => {
    const project = sampleProject;
    const bands = pickGeometry(project).walls;
    const meshVolume = new Map<string, number>();
    wallCutMeshes(bands).forEach((m, i) => {
      let v6 = 0;
      for (let k = 0; k < m.indices.length; k += 3) {
        const [a, b, c] = [m.indices[k], m.indices[k + 1], m.indices[k + 2]].map((j) => m.positions.slice(j * 3, j * 3 + 3));
        v6 += a[0] * (b[1] * c[2] - b[2] * c[1]) + a[1] * (b[2] * c[0] - b[0] * c[2]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
      }
      const id = bands[i].wallId;
      meshVolume.set(id, (meshVolume.get(id) ?? 0) + Math.abs(v6) / 6);
    });
    const walls = wallVolumes("demo-volumen", exportIfcSpf(project));
    let swept = 0;
    for (const wall of project.walls) {
      const w = walls[ifcGuid(`${project.id}/wall/${wall.id}`)];
      expect(w, wall.id).toBeDefined();
      if (w.rep === "SweptSolid") swept++;
      expect(w.volume, wall.id).toBeCloseTo(meshVolume.get(wall.id)!, 4);
    }
    expect(swept).toBeGreaterThan(0);
  });

  it("[B5] Wandachse + LayerSetUsage: Achse = Wandachse, Schichten ab Aussenfläche in Normalenrichtung", () => {
    // Zwei Schichten (0.1 aussen, 0.3 innen), Wand schräg gestellt und rückwärts gezeichnet.
    const [c0, c1] = sampleProject.components;
    const base = singleWall(false);
    const rotated: Project = {
      ...base,
      walls: [{ ...base.walls[0], start: { x: 12, y: 7 }, end: { x: 9, y: 3 } }],
      wallTypes: [...base.wallTypes.filter((t) => t.id !== "solo"), { id: "solo", name: "Zweischicht", layers: [{ componentId: c0.id, thickness: 0.1 }, { componentId: c1.id, thickness: 0.3 }] }],
      openings: [],
    };
    const ifc = exportIfcSpf(rotated);
    expect(validate("achse", ifc).out).toContain("0 Befunde");
    const [w] = Object.values(wallAxes("achse", ifc));
    expect(w.identifiers).toEqual(["Axis", "Body"]);
    expect(w.axis![2]).toBe("Curve2D");
    expect(w.axis![0][0]).toBeCloseTo(12, 6);
    expect(w.axis![0][1]).toBeCloseTo(7, 6);
    expect(w.axis![1][0]).toBeCloseTo(9, 6);
    expect(w.axis![1][1]).toBeCloseTo(3, 6);
    expect(w.axis![3][1]).toEqual([5, 0]); // Länge √(9+16) = 5 entlang lokal X
    expect(w.usage).toMatchObject({ dir: "AXIS2", sense: "POSITIVE", layers: [0.1, 0.3] });
    // Referenzlinie in der Mitte (Standard) → Offset −total/2; Körper je Schicht in Reihenfolge.
    const off = w.usage!.offset;
    let y = off;
    expect(w.items.length).toBe(2);
    w.items.forEach(([lo, hi], i) => {
      expect(lo).toBeCloseTo(y, 6);
      y += w.usage!.layers[i];
      expect(hi).toBeCloseTo(y, 6);
    });
  });
  it("[B5] Demo-Haus: jede Extrusions-Wand hat Achse und Usage, Körper-Bänder = Schichten in Reihenfolge", () => {
    const project = sampleProject;
    const axes = wallAxes("demo-achsen", exportIfcSpf(project));
    let withAxis = 0;
    for (const wall of project.walls) {
      const w = axes[ifcGuid(`${project.id}/wall/${wall.id}`)];
      expect(w, wall.id).toBeDefined();
      if (!w.axis) {
        expect(w.usage, wall.id).toBeNull(); // Mesh-Wand
        continue;
      }
      withAxis++;
      expect(w.axis[0][0], wall.id).toBeCloseTo(wall.start.x, 6);
      expect(w.axis[0][1], wall.id).toBeCloseTo(wall.start.y, 6);
      expect(w.axis[1][0], wall.id).toBeCloseTo(wall.end.x, 6);
      expect(w.axis[1][1], wall.id).toBeCloseTo(wall.end.y, 6);
      if (!w.usage) continue; // Schichtsumme passt nicht zum Querschnitt
      // Mehrere Bänder je Schicht möglich (Joins): die verschiedenen Querbereiche ergeben die Schichten.
      const spans = [...new Map(w.items.map(([lo, hi]) => [`${lo.toFixed(6)}/${hi.toFixed(6)}`, [lo, hi]])).values()].sort((a, b) => a[0] - b[0]);
      expect(spans.length, wall.id).toBe(w.usage.layers.length);
      let y = w.usage.offset;
      spans.forEach(([lo, hi], i) => {
        expect(lo, `${wall.id} Schicht ${i}`).toBeCloseTo(y, 6);
        y += w.usage!.layers[i];
        expect(hi, `${wall.id} Schicht ${i}`).toBeCloseTo(y, 6);
      });
    }
    expect(withAxis).toBeGreaterThan(0);
  });
});
