// glTF-/GLB-Export ([C4]): Khronos-Validator ohne Fehler, Rundreise (Knoten- und Dreieckszahl gegen den
// OBJ-Export derselben Szene), Geschosse als Eltern, transparentes Glas.
import { describe, it, expect } from "vitest";
import "../engine/fileioWasm.setup";
import validator from "gltf-validator";
import { exportGlb, exportGltf, exportMtl, exportObj } from "./exportMesh";
import { sampleProject } from "../model/sampleProject";

interface Gltf {
  asset: { version: string };
  scenes: { nodes: number[] }[];
  nodes: { name: string; mesh?: number; children?: number[]; extras?: { type: string; id: string } }[];
  meshes: { primitives: { attributes: { POSITION: number }; indices: number; material: number }[] }[];
  accessors: { count: number; type: string }[];
  materials: { name: string; alphaMode?: string; pbrMetallicRoughness: { baseColorFactor: number[] } }[];
}

/** JSON-Chunk eines GLB. */
function glbJson(glb: Uint8Array): Gltf {
  const dv = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  expect(dv.getUint32(0, true)).toBe(0x46546c67);
  expect(dv.getUint32(8, true)).toBe(glb.byteLength);
  const len = dv.getUint32(12, true);
  return JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + len))) as Gltf;
}

const triangles = (g: Gltf): number =>
  g.meshes.reduce((s, m) => s + m.primitives.reduce((t, p) => t + g.accessors[p.indices].count / 3, 0), 0);

describe("glTF-Export", () => {
  it("GLB besteht den Khronos-Validator ohne Fehler", async () => {
    const glb = exportGlb(sampleProject);
    const report = await validator.validateBytes(glb, { maxIssues: 50 });
    expect(report.issues.messages.filter((m) => m.severity === 0)).toEqual([]);
    expect(report.issues.numErrors).toBe(0);
    expect(report.info.version).toBe("2.0");
  });

  it(".gltf (Base64-Puffer) besteht den Validator ohne Fehler", async () => {
    const text = exportGltf(sampleProject);
    const report = await validator.validateString(text, { maxIssues: 50 });
    expect(report.issues.messages.filter((m) => m.severity === 0)).toEqual([]);
    expect(report.issues.numErrors).toBe(0);
  });

  it("Rundreise: ein Knoten je Bauteil, Dreiecke und Objekte wie im OBJ", () => {
    const g = glbJson(exportGlb(sampleProject));
    const obj = exportObj(sampleProject);
    const objGroups = obj.split("\n").filter((l) => l.startsWith("o "));
    const objFaces = obj.split("\n").filter((l) => l.startsWith("f ")).length;
    const parts = g.nodes.filter((n) => n.mesh !== undefined);
    const element = parts;
    expect(element.length).toBe(objGroups.length);
    for (const n of element) expect(objGroups).toContain(`o ${n.name}`);
    const elementTris = element.reduce(
      (s, n) => s + g.meshes[n.mesh!].primitives.reduce((t, p) => t + g.accessors[p.indices].count / 3, 0),
      0,
    );
    expect(elementTris).toBe(objFaces);
    expect(triangles(g)).toBe(objFaces);
  });

  it("Geschosse sind Eltern-Knoten der Bauteile; ohne byLevel liegen alle an der Wurzel", () => {
    const g = glbJson(exportGlb(sampleProject));
    const levels = g.nodes.filter((n) => n.extras?.type === "level");
    expect(levels.length).toBeGreaterThan(0);
    const kids = levels.flatMap((l) => l.children ?? []);
    expect(kids.length).toBeGreaterThan(0);
    for (const k of kids) expect(g.nodes[k].mesh).toBeDefined();
    const flat = glbJson(exportGlb(sampleProject, { byLevel: false }));
    expect(flat.nodes.some((n) => n.children)).toBe(false);
    expect(flat.scenes[0].nodes.length).toBe(flat.nodes.length);
  });

  it("Verglasung ist ein transparentes PBR-Material, Farben stammen aus dem Modell", () => {
    const g = glbJson(exportGlb(sampleProject));
    const glass = g.materials.find((m) => m.name === "Glas");
    expect(glass?.alphaMode).toBe("BLEND");
    expect(glass!.pbrMetallicRoughness.baseColorFactor[3]).toBeLessThan(1);
    expect(g.nodes.some((n) => n.extras?.type === "window")).toBe(true);
    // Wandmaterial trägt den Namen der Komponente.
    const names = sampleProject.components.map((c) => c.name);
    expect(g.materials.some((m) => names.includes(m.name))).toBe(true);
  });
});

describe("[201] Normalen und MTL", () => {
  it("jede Primitive trägt NORMAL (gleiche Anzahl wie POSITION); Validator ohne Meldung zu Normalen", async () => {
    const glb = exportGlb(sampleProject);
    const g = glbJson(glb) as Gltf & { meshes: { primitives: { attributes: { POSITION: number; NORMAL?: number } }[] }[] };
    for (const m of g.meshes) {
      for (const p of m.primitives) {
        expect(p.attributes.NORMAL).toBeDefined();
        expect(g.accessors[p.attributes.NORMAL!].count).toBe(g.accessors[p.attributes.POSITION].count);
        expect(g.accessors[p.attributes.NORMAL!].type).toBe("VEC3");
      }
    }
    const report = await validator.validateBytes(glb, { maxIssues: 200 });
    const normalIssues = report.issues.messages.filter((m) => /NORMAL|normal/.test(m.code + m.message));
    expect(normalIssues).toEqual([]);
  });

  it("OBJ: vn zu jeder Fläche, usemtl je Material, mtllib nur mit MTL; MTL nennt jedes verwendete Material", () => {
    const withMtl = exportObj(sampleProject, {}, "haus.mtl");
    const lines = withMtl.split("\n");
    expect(lines).toContain("mtllib haus.mtl");
    const faces = lines.filter((l) => l.startsWith("f "));
    expect(lines.filter((l) => l.startsWith("vn ")).length).toBeGreaterThan(0);
    for (const f of faces) expect(f).toMatch(/^f \d+\/\/\d+ \d+\/\/\d+ \d+\/\/\d+$/);
    const used = new Set(lines.filter((l) => l.startsWith("usemtl ")).map((l) => l.slice(7)));
    expect(used.size).toBeGreaterThan(1);
    const mtl = exportMtl(sampleProject);
    const defined = new Set(mtl.split("\n").filter((l) => l.startsWith("newmtl ")).map((l) => l.slice(7)));
    for (const u of used) expect(defined.has(u), u).toBe(true);
    expect(mtl).toMatch(/\nKd [\d.]+ [\d.]+ [\d.]+\n/);
    // Ohne MTL: keine mtllib, Farben im Kopf als Kommentar.
    const plain = exportObj(sampleProject);
    expect(plain).not.toContain("mtllib");
    expect(plain).toMatch(/\n# \S+: Kd /);
  });
});
