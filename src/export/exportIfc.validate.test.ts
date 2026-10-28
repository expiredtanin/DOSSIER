// IFC-Export gegen ifcopenshell prüfen ([B1]/[18]): Schema, Express-Regeln und Geometrie je Bauteil
// (`scripts/validate-ifc.py`). Ohne Python/ifcopenshell wird der Test übersprungen — in der CI ist
// es installiert (.github/workflows/check.yml).

import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
        "rep": w.Representation.Representations[0].RepresentationType}
print(json.dumps(out))
`;

type WallVolume = { volume: number; openings: number; fills: number; rep: string };

/** Je IfcWall (Schlüssel GlobalId): Volumen, Anzahl Öffnungen/Füllungen, Darstellungsart. */
function wallVolumes(name: string, ifc: string): Record<string, WallVolume> {
  const r = spawnSync("python3", ["-c", WALL_VOLUMES, writeIfc(name, ifc)], { encoding: "utf8", timeout: 120_000 });
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
});
