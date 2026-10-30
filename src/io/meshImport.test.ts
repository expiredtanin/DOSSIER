// Mesh-Import: Rundreise mit dem eigenen OBJ/STL/glTF-Export (`export/exportMesh.ts`) → Rust-Leser →
// Kontext-Meshes; gleiche Dreieckszahl, Lage und Farbe. Sonderfälle (Quads, negative Indizes, kaputte
// Dateien) prüfen die Rust-Tests (`mesh_import_tests.rs`), hier die Fassade.

import "../engine/fileioWasm.setup";
import { describe, expect, it } from "vitest";
import { exportGlb, exportGltf, exportObj, exportStl } from "../export/exportMesh";
import type { ImportedMesh, Project, Wall } from "../model/types";
import {
  MESH_UNIT_SCALE,
  NO_FACES_PREFIX,
  formatMeshReport,
  handleMeshWorkerRequest,
  isMeshFile,
  meshReport,
  readMesh,
  type MeshReadOptions,
  type MeshWorkerRequest,
} from "./meshImport";
import { importMeshInto } from "./importView.testutil";

function baseProject(): Project {
  return {
    id: "t",
    name: "T",
    lineStyles: [],
    hatches: [],
    components: [{ id: "c", name: "C", color: "#ccc", hatchId: "none", joinPriority: 10 }],
    wallTypes: [{ id: "aw", name: "Aussenwand", layers: [{ componentId: "c", thickness: 0.4 }] }],
    ceilingTypes: [{ id: "dt", name: "Betondecke", layers: [{ componentId: "c", thickness: 0.2 }] }],
    drawingLevels: [
      { id: "eg", name: "EG", kind: "floor", visible: true, locked: false, floorHeight: 2.6, cutHeight: 1.0, baseElevation: 0 },
    ],
    layers: [{ code: "20", name: "Wände", color: "#0a0a0a", lw: 0.5, visible: true, locked: false }],
    walls: [],
    openings: [],
    ceilings: [],
    stairs: [],
    extrudedSolids: [],
    rooms: [],
    drawings2d: [],
    context: [],
  } as Project;
}

/** Eine Wand (0,0)–(5,0), 2,6 m hoch, und ein orangefarbener Kontext-Würfel bei (20, 30). */
function project(): Project {
  const p = baseProject();
  const wall: Wall = {
    id: "W1",
    type: "wall",
    floorId: "eg",
    categoryCode: "20",
    start: { x: 0, y: 0 },
    end: { x: 5, y: 0 },
    wallTypeId: "aw",
    height: 2.6,
  };
  p.walls = [wall];
  const cube: ImportedMesh = {
    id: "K1",
    type: "importedMesh",
    name: "Nachbar",
    color: "#ff8000",
    positions: [20, 30, 0, 24, 30, 0, 24, 36, 0, 20, 36, 0, 20, 30, 9, 24, 30, 9, 24, 36, 9, 20, 36, 9],
    indices: [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7],
  };
  p.context = [cube];
  return p;
}

const enc = new TextEncoder();

/** Objekte einer Datei als Kontext-Meshes (je Objekt, Datei-Koordinaten) über den Kern. */
async function objectsOf(bytes: Uint8Array, name: string, opts: MeshReadOptions = {}) {
  const r = await importMeshInto(baseProject(), bytes, name, { ...opts, placement: "original", group: "object" });
  return { objects: r.meshes, report: r.read.report };
}

function bbox(objs: ImportedMesh[]): { lo: number[]; hi: number[] } {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const o of objs) {
    for (let i = 0; i < o.positions.length; i += 3) {
      for (let a = 0; a < 3; a++) {
        lo[a] = Math.min(lo[a], o.positions[i + a]);
        hi[a] = Math.max(hi[a], o.positions[i + a]);
      }
    }
  }
  return { lo, hi };
}

const tris = (objs: ImportedMesh[]) => objs.reduce((n, o) => n + o.indices.length / 3, 0);

describe("Mesh-Import: Rundreise mit dem eigenen Export", () => {
  it("GLB: Objekte, Dreieckszahl, Lage und Farbe bleiben erhalten", async () => {
    const p = project();
    const { objects, report } = await objectsOf(exportGlb(p), "m.glb");
    expect(report.format).toBe("gltf");
    expect(report.up).toBe("y");
    expect(objects.length).toBeGreaterThanOrEqual(2);
    const nachbar = objects.find((o) => o.name.startsWith("Kontext_"));
    expect(nachbar).toBeTruthy();
    expect(nachbar!.indices.length / 3).toBe(12);
    // Lage: Würfel (20..24, 30..36, 0..9) liegt wieder dort.
    const b = bbox([nachbar!]);
    expect(b.lo[0]).toBeCloseTo(20, 4);
    expect(b.hi[0]).toBeCloseTo(24, 4);
    expect(b.lo[1]).toBeCloseTo(30, 4);
    expect(b.hi[1]).toBeCloseTo(36, 4);
    expect(b.hi[2]).toBeCloseTo(9, 4);
    // Farbe #ff8000 (sRGB → linear → sRGB).
    expect(nachbar!.color).toBe("#ff8000");
    // Wand: 0..5 in x, Höhe 2,6.
    const wall = objects.find((o) => o.name.startsWith("Wand_"))!;
    const bw = bbox([wall]);
    expect(bw.lo[0]).toBeCloseTo(0, 4);
    expect(bw.hi[0]).toBeCloseTo(5, 4);
    expect(bw.hi[2]).toBeCloseTo(2.6, 4);
  });

  it("glTF (eingebettet), OBJ und STL ergeben dieselbe Dreieckszahl und Ausdehnung wie GLB", async () => {
    const p = project();
    const glb = await objectsOf(exportGlb(p), "m.glb");
    const gltf = await objectsOf(enc.encode(exportGltf(p)), "m.gltf");
    const obj = await objectsOf(enc.encode(exportObj(p)), "m.obj");
    const stl = await objectsOf(enc.encode(exportStl(p)), "m.stl");
    const n = tris(glb.objects);
    expect(tris(gltf.objects)).toBe(n);
    expect(tris(obj.objects)).toBe(n);
    expect(tris(stl.objects)).toBe(n);
    // OBJ trägt den Kopfkommentar (Y oben, sicher); STL wird an der Ausdehnung erkannt.
    expect(obj.report.up).toBe("y");
    expect(obj.report.upCertain).toBe(true);
    expect(stl.report.up).toBe("y");
    const ref = bbox(glb.objects);
    for (const r of [gltf, obj, stl]) {
      const b = bbox(r.objects);
      for (let a = 0; a < 3; a++) {
        expect(b.lo[a]).toBeCloseTo(ref.lo[a], 3);
        expect(b.hi[a]).toBeCloseTo(ref.hi[a], 3);
      }
    }
  });

  it("OBJ: Einheit und erzwungene Achse", async () => {
    const p = project();
    const mm = await objectsOf(enc.encode(exportObj(p)), "m.obj", { unit: "mm" });
    const m = await objectsOf(enc.encode(exportObj(p)), "m.obj");
    expect(bbox(mm.objects).hi[0]).toBeCloseTo(bbox(m.objects).hi[0] * MESH_UNIT_SCALE.mm, 6);
    const z = await readMesh(enc.encode(exportObj(p)), "m.obj", { up: "z" });
    expect(z.report.up).toBe("z");
    expect(z.report.upAuto).toBe(false);
  });
});

describe("Mesh-Import: Abbildung auf Kontext-Meshes", () => {
  it("Farbe ins Feld color, Gruppe als Ebene, Platzierung Mitte/Original", async () => {
    const p = project();
    const orig = (await importMeshInto(baseProject(), exportGlb(p), "Haus.glb", { placement: "original" })).meshes;
    const nachbar = orig.find((m) => m.name.startsWith("Kontext_"))!;
    expect(nachbar.type).toBe("importedMesh");
    expect(nachbar.color).toBe("#ff8000");
    expect(nachbar.positions.length).toBe(24);
    expect(Math.min(...nachbar.positions.filter((_, i) => i % 3 === 0))).toBeCloseTo(20, 4);
    // Mitte: Grundriss-Mitte aller Objekte auf (0, 0), Unterkante auf z = 0.
    const centered = (await importMeshInto(baseProject(), exportGlb(p), "Haus.glb", { placement: "center" })).meshes;
    const xs = centered.flatMap((m) => m.positions.filter((_, i) => i % 3 === 0));
    const ys = centered.flatMap((m) => m.positions.filter((_, i) => i % 3 === 1));
    const zs = centered.flatMap((m) => m.positions.filter((_, i) => i % 3 === 2));
    expect((Math.min(...xs) + Math.max(...xs)) / 2).toBeCloseTo(0, 6);
    expect((Math.min(...ys) + Math.max(...ys)) / 2).toBeCloseTo(0, 6);
    expect(Math.min(...zs)).toBeCloseTo(0, 6);
  });

  it("Landeskoordinaten werden bei Original-Platzierung auf den Modell-Nullpunkt geschoben", async () => {
    const ply = enc.encode(
      "ply\nformat ascii 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\nelement face 1\nproperty list uchar int vertex_indices\nend_header\n" +
        "2600010 1200010 0\n2600020 1200010 0\n2600020 1200020 5\n3 0 1 2\n",
    );
    const geo: Project = { ...baseProject(), geoAnchor: { lv95: { e: 2600000, n: 1200000 }, model: { x: 0, y: 0 } } };
    const [m] = (await importMeshInto(geo, ply, "n.ply", { up: "z", placement: "original" })).meshes;
    expect(m.positions.slice(0, 3)).toEqual([10, 10, 0]);
    const [n] = (await importMeshInto(baseProject(), ply, "n.ply", { up: "z", placement: "original" })).meshes;
    expect(n.positions[0]).toBeCloseTo(2600010, 3);
  });

  it("Bericht als Text", async () => {
    const { report } = await readMesh(enc.encode(exportObj(project())), "m.obj");
    const text = formatMeshReport(report, (k, v) => `${k}${v ? JSON.stringify(v) : ""}`);
    expect(text).toContain("mesh.import.done");
    expect(text).toContain("mesh.import.up");
  });

  it("Bericht nennt die Reparatur ([T5]) nur, wenn etwas repariert wurde", () => {
    const base = { format: "stl" as const, up: "z" as const, upAuto: false, upCertain: true, unitScale: 1, triangles: 12, degenerate: 0, badFaces: 0, truncated: false, warnings: [] as string[], objects: 1 };
    const tr = (k: string, v?: Record<string, string | number>) => `${k}${v ? JSON.stringify(v) : ""}`;
    expect(formatMeshReport({ ...base, repaired: { welded: 0, degenerate: 0, holes: 0 } }, tr)).not.toContain("repaired");
    expect(formatMeshReport({ ...base, repaired: { welded: 28, degenerate: 1, holes: 2 } }, tr)).toContain('mesh.import.repaired{"welded":28,"tris":1,"holes":2}');
  });
});

describe("Mesh-Import: Fehler", () => {
  it("kaputte Dateien: Fehlermeldung statt Absturz", async () => {
    await expect(readMesh(enc.encode("das ist kein Mesh"), "x.obj")).rejects.toThrow();
    await expect(readMesh(new Uint8Array([1, 2, 3, 4]), "x.glb")).rejects.toThrow();
    await expect(readMesh(new Uint8Array(0), "x.stl")).rejects.toThrow();
    const glb = exportGlb(project());
    await expect(readMesh(glb.slice(0, 100), "x.glb")).rejects.toThrow();
  });

  it("PLY ohne Flächen meldet die Punktwolke", async () => {
    const ply = "ply\nformat ascii 1.0\nelement vertex 1\nproperty float x\nproperty float y\nproperty float z\nend_header\n0 0 0\n";
    await expect(readMesh(enc.encode(ply), "x.ply")).rejects.toThrow(NO_FACES_PREFIX);
  });

  it("externe .bin: Meldung, dann mit Begleitdatei lesbar", async () => {
    const bin = new Uint8Array(new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1]).buffer);
    const j = JSON.stringify({
      asset: { version: "2.0" },
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3" }],
      bufferViews: [{ buffer: 0, byteLength: 36 }],
      buffers: [{ uri: "d.bin", byteLength: 36 }],
    });
    await expect(readMesh(enc.encode(j), "d.gltf")).rejects.toThrow("d.bin");
    const { report } = await readMesh(enc.encode(j), "d.gltf", { files: [{ name: "d.bin", bytes: bin }] });
    expect(report.triangles).toBe(1);
  });

  it("beschädigte Puffer: Meldung des Kerns", () => {
    expect(() => meshReport({ flat: new Float64Array([9, 0]), strings: [] })).toThrow();
  });

  it("Worker-Protokoll: Antwort und Fehler", async () => {
    const data = exportGlb(project()).slice().buffer;
    const req: MeshWorkerRequest = { type: "parse", data, name: "m.glb", unit: "m", up: "auto", maxTriangles: 0, files: [] };
    const ok = await handleMeshWorkerRequest(req);
    expect(ok.res.type).toBe("result");
    expect(ok.transfer.length).toBe(1);
    const bad = await handleMeshWorkerRequest({ ...req, data: new Uint8Array([1, 2]).buffer });
    expect(bad.res.type).toBe("error");
  });

  it("Endungen", () => {
    expect(isMeshFile("a.GLB")).toBe(true);
    expect(isMeshFile("a.ifc")).toBe(false);
  });
});
