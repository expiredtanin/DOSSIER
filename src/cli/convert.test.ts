// dossier-cli convert ([C4]): Format nach Endung, Rundreisen über echte Dateien, --cmd mit {last}.
import { describe, expect, it, beforeAll } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "./main";
import { parseProjectFile, serializeProject, sampleProject } from "../core";

const dir = mkdtempSync(join(tmpdir(), "dossier-convert-"));
const p = (name: string) => join(dir, name);
const obp = p("demo.obp");

beforeAll(() => {
  process.env.DOSSIER_WASM_DIR = join(process.cwd(), "src", "engine");
  writeFileSync(obp, serializeProject(sampleProject));
});

describe("dossier-cli convert", () => {
  it("obp → glb/gltf/obj/stl/ifc/step nach Endung", async () => {
    for (const [ext, needle] of [
      ["obj", "o Wand_"],
      ["stl", "solid dossier"],
      ["gltf", '"version":"2.0"'],
      ["ifc", "ISO-10303-21"],
      ["step", "ISO-10303-21"],
    ] as const) {
      expect(await run(["convert", obp, p(`a.${ext}`)]), ext).toBe(0);
      expect(readFileSync(p(`a.${ext}`), "latin1"), ext).toContain(needle);
    }
    expect(await run(["convert", obp, p("a.glb")])).toBe(0);
    const glb = readFileSync(p("a.glb"));
    expect(glb.subarray(0, 4).toString("latin1")).toBe("glTF");
    expect(glb.readUInt32LE(8)).toBe(glb.length);
  }, 60_000);

  it("obp → dxf/dwg und zurück nach obp (2D-Zeichnung kommt an)", async () => {
    expect(await run(["convert", obp, p("g.dxf")])).toBe(0);
    expect(readFileSync(p("g.dxf"), "utf8")).toContain("SECTION");
    expect(await run(["convert", obp, p("g.dwg")])).toBe(0);
    for (const src of ["g.dxf", "g.dwg"]) {
      const back = p(`von-${src}.obp`);
      expect(await run(["convert", p(src), back]), src).toBe(0);
      const r = parseProjectFile(readFileSync(back, "utf8"));
      expect(r.ok, src).toBe(true);
      if (r.ok) expect(r.project.drawings2d.length, src).toBeGreaterThan(0);
    }
  }, 120_000);

  it("ifc → obp übernimmt die Bauteile als Kontext-Meshes", async () => {
    expect(await run(["convert", obp, p("h.ifc")])).toBe(0);
    expect(await run(["convert", p("h.ifc"), p("von-ifc.obp")])).toBe(0);
    const r = parseProjectFile(readFileSync(p("von-ifc.obp"), "utf8"));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.project.context?.length ?? 0).toBeGreaterThan(0);
  }, 120_000);

  it("--cmd mehrfach, {last} ist die zuletzt geschriebene Datei", async () => {
    const first = p("k.obj");
    const second = p("k2.stl");
    expect(await run(["convert", obp, first, "--cmd", `stl --out ${second}`, "--cmd", "validate"])).toBe(0);
    expect(existsSync(second)).toBe(true);
    // {last} = zuletzt geschriebene Datei (l.stl) → Nachbar-Datei l.stl.csv
    expect(await run([":beispiel", "--cmd", `stl --out ${p("l.stl")}`, "--cmd", "schedule --out {last}.csv"])).toBe(0);
    expect(existsSync(p("l.stl.csv"))).toBe(true);
  }, 60_000);

  it("Fehlerfälle: unbekannte Endungen, fehlende Datei, fehlende Argumente", async () => {
    expect(await run(["convert", obp])).toBe(2);
    // `fail()` beendet den Prozess (im Test: process.exit wirft).
    await expect(run(["convert", p("gibtsnicht.dxf"), p("x.obp")])).rejects.toThrow(/process\.exit/);
    await expect(run(["convert", obp, p("x.xyz")])).rejects.toThrow(/process\.exit/);
    await expect(run(["convert", p("a.pdf"), p("x.obp")])).rejects.toThrow(/process\.exit/);
  });
});
