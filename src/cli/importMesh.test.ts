// dossier-cli import-mesh und convert mit Mesh-Eingabe: Rundreise über echte Dateien (glb, gltf, obj+mtl, stl).
import { beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "./main";
import { parseProjectFile, sampleProject, serializeProject } from "../core";
import type { Project } from "../core";

const dir = mkdtempSync(join(tmpdir(), "dossier-import-mesh-"));
const p = (name: string) => join(dir, name);
const obp = p("demo.obp");

/** Projektdatei lesen; schlägt der Test fehl, wenn sie ungültig ist. */
function load(path: string): Project {
  const r = parseProjectFile(readFileSync(path, "utf8"));
  if (!r.ok) throw new Error(r.error);
  return r.project;
}

beforeAll(() => {
  process.env.DOSSIER_WASM_DIR = join(process.cwd(), "src", "engine");
  writeFileSync(obp, serializeProject(sampleProject));
});

describe("dossier-cli: Mesh-Import", () => {
  it("convert: glb/gltf/obj/stl → obp mit Kontext-Meshes", async () => {
    for (const ext of ["glb", "gltf", "obj", "stl"]) {
      expect(await run(["convert", obp, p(`m.${ext}`)]), ext).toBe(0);
      const out = p(`von-${ext}.obp`);
      expect(await run(["convert", p(`m.${ext}`), out]), ext).toBe(0);
      const project = load(out);
      const ctx = project.context ?? [];
      expect(ctx.length, ext).toBeGreaterThan(0);
      expect(ctx.every((c) => c.type === "importedMesh" && c.indices.length > 0), ext).toBe(true);
    }
  }, 120_000);

  it("import-mesh: glTF mit Farbe, --out schreibt das Projekt", async () => {
    const out = p("import.obp");
    expect(await run([obp, "import-mesh", p("m.glb"), "--out", out, "--placement", "original"])).toBe(0);
    const project = load(out);
    const before = sampleProject.context?.length ?? 0;
    expect((project.context ?? []).length).toBeGreaterThan(before);
    // Wände des Beispielprojekts haben Farben aus ihren Bauteilen.
    expect((project.context ?? []).some((c) => c.type === "importedMesh" && typeof c.color === "string")).toBe(true);
  }, 120_000);

  it("import-mesh: OBJ mit MTL aus dem Verzeichnis, Einheit und Achse", async () => {
    writeFileSync(p("z.obj"), "mtllib z.mtl\no Kiste\nusemtl rot\nv 0 0 0\nv 1000 0 0\nv 0 1000 0\nv 0 0 2000\nf 1 3 2\nf 1 2 4\nf 2 3 4\nf 3 1 4\n");
    writeFileSync(p("z.mtl"), "newmtl rot\nKd 1 0 0\n");
    const out = p("z.obp");
    expect(await run([obp, "import-mesh", p("z.obj"), "--unit", "mm", "--up", "z", "--placement", "original", "--out", out])).toBe(0);
    const project = load(out);
    const m = (project.context ?? []).find((c) => c.name === "Kiste");
    if (m?.type !== "importedMesh") throw new Error("Kiste fehlt");
    expect(m.color).toBe("#ff0000");
    expect(Math.max(...m.positions.filter((_, i) => i % 3 === 2))).toBeCloseTo(2, 9);
  }, 60_000);

  it("ungültige Optionen und kaputte Dateien: Exit-Code ≠ 0", async () => {
    expect(await run([obp, "import-mesh", p("z.obj"), "--unit", "km"]).catch(() => 1)).not.toBe(0);
    writeFileSync(p("kaputt.glb"), "kein glb");
    expect(await run([obp, "import-mesh", p("kaputt.glb")]).catch(() => 1)).not.toBe(0);
  }, 60_000);
});
