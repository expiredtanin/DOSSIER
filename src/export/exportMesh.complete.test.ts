// Mesh-Export vollständig ([C11], 28.10.): Dächer, Treppen, Stützen, Kontext-Meshes, ein Knoten je Öffnung,
// rechtshändige Achsen in OBJ/STL/glTF, Dreieckszahl wie die 3D-Ableitung, Khronos-Validator.
import { describe, it, expect } from "vitest";
import "../engine/fileioWasm.setup";
import validator from "gltf-validator";
import { exportGlb, exportGltf, exportObj, exportStl } from "./exportMesh";
import { orientOutward } from "./meshOrient";
import { sampleProject } from "../model/sampleProject";
import type { Column, ImportedMesh, Project, TerrainMesh } from "../model/types";
import { emitOpeningMeshes } from "../plan/toWalls3d/openings";
import { emitRoofs } from "../plan/toWalls3d/roofs";
import { emitColumns } from "../plan/toWalls3d/columns";
import { emitStairMeshes, emitStairRailings, emitStairs } from "../plan/toWalls3d/stairs";

interface Gltf {
  nodes: { name: string; mesh?: number; children?: number[]; extras?: { type: string; id: string } }[];
  meshes: { primitives: { attributes: { POSITION: number }; indices: number; material: number }[] }[];
  accessors: { count: number; min?: number[]; max?: number[] }[];
  materials: { name: string; pbrMetallicRoughness: { baseColorFactor: number[] } }[];
}

function glbJson(glb: Uint8Array): Gltf {
  const dv = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  const len = dv.getUint32(12, true);
  return JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + len))) as Gltf;
}

const nodeTris = (g: Gltf, n: { mesh?: number }): number =>
  n.mesh === undefined ? 0 : g.meshes[n.mesh].primitives.reduce((t, p) => t + g.accessors[p.indices].count / 3, 0);

/** Würfel 2 m (x, y, z-hoch ab z = 0) mit Wicklung nach aussen im Modell (rechtshändig, z hoch). */
const CUBE_POS = [0, 0, 0, 2, 0, 0, 2, 2, 0, 0, 2, 0, 0, 0, 2, 2, 0, 2, 2, 2, 2, 0, 2, 2];
const CUBE_IDX = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7];

function withContext(base: Project): Project {
  const imported: ImportedMesh = {
    id: "IM1",
    type: "importedMesh",
    name: "Nachbar",
    color: "#ff0000",
    positions: CUBE_POS.map((v, i) => (i % 3 === 0 ? v + 20 : v)),
    indices: CUBE_IDX,
  };
  const terrain: TerrainMesh = {
    id: "TM1",
    type: "terrainMesh",
    name: "Gelände",
    positions: [-5, -5, 0, 25, -5, 0, 25, 25, 0, -5, 25, 0],
    indices: [0, 1, 2, 0, 2, 3],
  };
  const column: Column = {
    id: "C1",
    type: "column",
    floorId: base.drawingLevels.find((l) => l.kind === "floor")!.id,
    categoryCode: "50",
    position: { x: 8, y: 1 },
    profile: { kind: "rect", width: 0.3, depth: 0.3 },
    rotation: 0,
    height: 2.6,
  } as Column;
  // Zweite Treppe ohne Typ ⇒ massives Tritt-Prisma (die Beispieltreppe ist Ortbeton: glatte Laufplatte als Mesh).
  const massive = { ...base.stairs![0], id: "ST2", typeId: undefined, start: { x: 6, y: 0.4 } };
  return {
    ...base,
    context: [...(base.context ?? []), imported, terrain],
    columns: [...(base.columns ?? []), column],
    stairs: [...(base.stairs ?? []), massive],
  };
}

/** Signiertes Volumen je OBJ-Objekt ({@code o}-Zeilen), aus den Weltkoordinaten der Datei. */
function objVolumes(obj: string): Map<string, number> {
  const verts: number[][] = [];
  const out = new Map<string, number>();
  let cur = "";
  for (const l of obj.split("\n")) {
    if (l.startsWith("v ")) verts.push(l.slice(2).trim().split(/\s+/).map(Number));
    else if (l.startsWith("o ")) {
      cur = l.slice(2).trim();
      out.set(cur, 0);
    } else if (l.startsWith("f ")) {
      const [a, b, c] = l.slice(2).trim().split(/\s+/).map((i) => verts[Number(i) - 1]);
      const v =
        a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
      out.set(cur, (out.get(cur) ?? 0) + v / 6);
    }
  }
  return out;
}

describe("orientOutward", () => {
  it("dreht einen innen gewickelten Würfel nach aussen und gleicht gemischte Wicklung an", () => {
    const pos = CUBE_POS;
    const mixed = CUBE_IDX.slice();
    // ein Dreieck umdrehen ⇒ widersprüchliche Wicklung
    [mixed[1], mixed[2]] = [mixed[2], mixed[1]];
    const inward: number[] = [];
    for (let i = 0; i < CUBE_IDX.length; i += 3) inward.push(CUBE_IDX[i], CUBE_IDX[i + 2], CUBE_IDX[i + 1]);
    const vol = (idx: number[]) => {
      let v = 0;
      for (let i = 0; i < idx.length; i += 3) {
        const [a, b, c] = [idx[i] * 3, idx[i + 1] * 3, idx[i + 2] * 3];
        v +=
          pos[a] * (pos[b + 1] * pos[c + 2] - pos[b + 2] * pos[c + 1]) -
          pos[a + 1] * (pos[b] * pos[c + 2] - pos[b + 2] * pos[c]) +
          pos[a + 2] * (pos[b] * pos[c + 1] - pos[b + 1] * pos[c]);
      }
      return v / 6;
    };
    expect(vol(CUBE_IDX)).toBeCloseTo(8, 9);
    expect(vol(orientOutward(pos, inward))).toBeCloseTo(8, 9);
    expect(vol(orientOutward(pos, mixed))).toBeCloseTo(8, 9);
  });
});

describe("Mesh-Export vollständig", () => {
  const project = withContext(sampleProject);

  it("Achsen rechtshändig: Norden (Modell +y) liegt bei −Z, Höhe bei Y, Ost bei +X — OBJ, STL und glTF", () => {
    const obj = exportObj(sampleProject);
    const zs = obj.split("\n").filter((l) => l.startsWith("v ")).map((l) => Number(l.split(" ")[3]));
    const ys = obj.split("\n").filter((l) => l.startsWith("v ")).map((l) => Number(l.split(" ")[2]));
    // Das Beispielhaus liegt bei y = 0 … 4 (Norden), Höhe bis über das Dach.
    expect(Math.max(...zs)).toBeLessThan(0.7);
    expect(Math.min(...zs)).toBeLessThan(-3.9);
    expect(Math.min(...ys)).toBeGreaterThan(-0.5);
    expect(Math.max(...ys)).toBeGreaterThan(4);
    // STL: gleiche Spanne
    const stlZ = exportStl(sampleProject)
      .split("\n")
      .filter((l) => l.startsWith("vertex "))
      .map((l) => Number(l.split(" ")[3]));
    expect(Math.min(...stlZ)).toBeCloseTo(Math.min(...zs), 6);
    // glTF: Positionen min/max aller Knoten
    const g = glbJson(exportGlb(sampleProject));
    const minZ = Math.min(...g.accessors.filter((a) => a.min).map((a) => a.min![2]));
    expect(minZ).toBeCloseTo(Math.min(...zs), 4);
  });

  it("alle Bauteile haben ein positives Volumen (Wicklung nach aussen) in OBJ", () => {
    const vols = objVolumes(exportObj(project));
    expect(vols.size).toBeGreaterThan(10);
    for (const [name, v] of vols) {
      // Offene Flächen (Gelände) haben kein Volumen.
      if (name.startsWith("Gelaende_")) continue;
      expect(v, name).toBeGreaterThan(0);
    }
    expect(vols.get("Kontext_IM1")).toBeCloseTo(8, 6);
  });

  it("Dächer, Treppen, Stützen, Kontext und Gelände sind Knoten mit Bauteil-id", () => {
    const g = glbJson(exportGlb(project));
    const by = (type: string) => g.nodes.filter((n) => n.extras?.type === type).map((n) => n.extras!.id);
    expect(by("roof")).toEqual((project.roofs ?? []).map((r) => r.id));
    expect(by("stair")).toEqual((project.stairs ?? []).map((s) => s.id));
    expect(by("column")).toEqual(["C1"]);
    expect(by("context")).toEqual(["IM1"]);
    expect(by("terrain")).toEqual(["TM1"]);
    for (const n of g.nodes.filter((x) => x.extras && x.extras.type !== "level")) expect(nodeTris(g, n)).toBeGreaterThan(0);
  });

  it("importiertes Mesh trägt seine Farbe (linear umgerechnet), Gelände die Grundfarbe", () => {
    const g = glbJson(exportGlb(project));
    const node = g.nodes.find((n) => n.extras?.id === "IM1")!;
    const mat = g.meshes[node.mesh!].primitives[0].material;
    const c = g.materials[mat].pbrMetallicRoughness.baseColorFactor;
    expect(c[0]).toBeCloseTo(1, 6);
    expect(c[1]).toBeCloseTo(0, 6);
    expect(c[2]).toBeCloseTo(0, 6);
  });

  it("je Öffnung ein Knoten (Fenster_/Tuer_) mit Glas bzw. Rahmen; kein Sammelknoten mehr", () => {
    const g = glbJson(exportGlb(project));
    const ops = project.openings ?? [];
    expect(ops.length).toBeGreaterThan(2);
    for (const op of ops) {
      const n = g.nodes.find((x) => x.extras?.id === op.id);
      expect(n, op.id).toBeDefined();
      expect(n!.extras!.type).toBe(op.kind);
      expect(n!.name).toBe(`${op.kind === "window" ? "Fenster" : "Tuer"}_${op.id}`);
    }
    expect(g.nodes.some((n) => n.extras?.type === "glazing" || n.extras?.type === "frame")).toBe(false);
  });

  it("Dreieckszahl je Bauteilart = Summe der 3D-Ableitungen (Dach, Treppe, Stütze, Öffnungsteile)", () => {
    const g = glbJson(exportGlb(project));
    const tris = (type: string) => g.nodes.filter((n) => n.extras?.type === type).reduce((s, n) => s + nodeTris(g, n), 0);
    const meshTris = (ms: { indices: number[] }[]) => ms.reduce((s, m) => s + m.indices.length / 3, 0);
    expect(tris("roof")).toBe(meshTris(emitRoofs(project)));
    expect(tris("column")).toBe(meshTris(emitColumns(project)));
    expect(tris("window") + tris("door")).toBe(meshTris(emitOpeningMeshes(project, "mittel")));
    const stairMeshes = meshTris(emitStairMeshes(project)) + meshTris(emitStairRailings(project));
    // Stufen-Prismen: jede Stufe wird zu einem Prisma (2 Kappen + Mantel) — mindestens die Mesh-Dreiecke.
    expect(emitStairs(project).length).toBeGreaterThan(0);
    expect(tris("stair")).toBeGreaterThanOrEqual(stairMeshes + emitStairs(project).length * 12);
    // OBJ und glTF enthalten dieselben Dreiecke
    const faces = exportObj(project).split("\n").filter((l) => l.startsWith("f ")).length;
    const all = g.nodes.reduce((s, n) => s + nodeTris(g, n), 0);
    expect(all).toBe(faces);
  });

  it("openingParts:false / context:false lassen die Teile weg", () => {
    const g = glbJson(exportGlb(project, { openingParts: false, context: false }));
    expect(g.nodes.some((n) => n.extras?.type === "window" || n.extras?.type === "door")).toBe(false);
    expect(g.nodes.some((n) => n.extras?.type === "context" || n.extras?.type === "terrain")).toBe(false);
    expect(g.nodes.some((n) => n.extras?.type === "roof")).toBe(true);
  });

  it("GLB und .gltf bestehen den Khronos-Validator ohne Fehler", async () => {
    const r1 = await validator.validateBytes(exportGlb(project), { maxIssues: 50 });
    expect(r1.issues.messages.filter((m) => m.severity === 0)).toEqual([]);
    const r2 = await validator.validateString(exportGltf(project), { maxIssues: 50 });
    expect(r2.issues.numErrors).toBe(0);
  });
});
