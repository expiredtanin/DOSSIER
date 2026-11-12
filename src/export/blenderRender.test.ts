// [211] Rendering mit Blender: Szenen-JSON (Kamera, Sonne aus dem Sonnenstand, Materialzuordnung), Paket und
// Prozess-Ablauf gegen einen gemockten Gastgeber. Blender selbst läuft hier nicht.
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import "../engine/fileioWasm.setup";
import { sampleProject } from "../model/sampleProject";
import { buildComplexSampleProject } from "../model/sampleProjectComplex";
import type { Project } from "../model/types";
import { projectLatLon, sunPosition } from "../analysis/sun";
import {
  BlenderMissingError,
  RenderCancelled,
  blenderArgs,
  buildRenderPackage,
  defaultRenderTime,
  glbMaterials,
  paperPixels,
  parseBlenderLine,
  renderSun,
  runBlenderRender,
  type BlenderHost,
  type RenderOptions,
} from "./blenderRender";
import { exportGlb } from "./exportMesh";

const when = new Date(Date.UTC(2026, 5, 21, 10, 0, 0));
const opts = (over: Partial<RenderOptions> = {}): RenderOptions => ({ width: 640, height: 360, samples: 16, when, camera: { preset: "iso" }, ...over });

describe("Sonne und Kamera in scene.json", () => {
  it("Sonne = Sonnenstand des Projekts am gewählten Zeitpunkt", () => {
    const { lat, lon } = projectLatLon(sampleProject);
    const s = sunPosition(lat, lon, when);
    const r = renderSun(sampleProject, when);
    expect(r.azimuth).toBeCloseTo(s.azimuth, 9);
    expect(r.elevation).toBeCloseTo(s.elevation, 9);
    expect(r.when).toBe("2026-06-21T10:00:00.000Z");
    // Mittsommer, Vormittag in Zürich: Sonne im Südosten und hoch.
    expect(r.azimuth).toBeGreaterThan(90);
    expect(r.azimuth).toBeLessThan(180);
    expect(r.elevation).toBeGreaterThan(40);
  });

  it("Vorbelegung der Zeit aus der Sonnenstudie, sonst Mittsommer", () => {
    const p: Project = { ...sampleProject, sunStudy: { when: "2026-12-21T11:00:00Z", show: true } };
    expect(defaultRenderTime(p).toISOString()).toBe("2026-12-21T11:00:00.000Z");
    expect(defaultRenderTime({ ...sampleProject, sunStudy: undefined }).getUTCMonth()).toBe(5);
    expect(defaultRenderTime({ ...sampleProject, sunStudy: { when: "kaputt", show: true } }).getUTCMonth()).toBe(5);
  });

  it("A-Formate bei 300 dpi", () => {
    expect(paperPixels("a4", "landscape", 300)).toEqual({ width: 3508, height: 2480 });
    expect(paperPixels("a3", "portrait", 300)).toEqual({ width: 3508, height: 4961 });
  });
});

describe("Materialien aus dem GLB", () => {
  it("Farbe sRGB, Rauheit, Glas = Alpha-Blend mit Deckkraft < 1", () => {
    const mats = glbMaterials(exportGlb(buildComplexSampleProject()));
    expect(mats.length).toBeGreaterThan(2);
    const glass = mats.filter((m) => m.glass);
    expect(glass.length).toBeGreaterThan(0);
    for (const g of glass) expect(g.opacity).toBeLessThan(1);
    for (const m of mats.filter((m) => !m.glass)) {
      expect(m.opacity).toBe(1);
      expect(m.color.every((c) => c >= 0 && c <= 1)).toBe(true);
    }
  });
});

describe("Paket", () => {
  it("GLB, scene.json und Materialtabelle; Kamera der Ansicht wird übernommen", async () => {
    const camera = { kind: "perspective" as const, position: [10, -12, 8] as [number, number, number], direction: [-0.5, 0.7, -0.5] as [number, number, number], up: [0, 0, 1] as [number, number, number], fovDeg: 50, orthoHeight: 0 };
    const pkg = await buildRenderPackage(sampleProject, opts({ camera, samples: 64 }));
    expect(pkg.files.map((f) => f.path)).toEqual(["model.glb", "scene.json"]);
    const json = JSON.parse(new TextDecoder().decode(pkg.files[1].bytes));
    expect(json.camera).toEqual(camera);
    expect(json.resolution).toEqual({ width: 640, height: 360 });
    expect(json.samples).toBe(64);
    expect(json.denoise).toBe(true);
    expect(json.model).toBe("model.glb");
    expect(json.sun.azimuth).toBeCloseTo(renderSun(sampleProject, when).azimuth, 9);
    expect(json.materials.length).toBeGreaterThan(0);
    const glb = pkg.files[0].bytes;
    expect(new DataView(glb.buffer, glb.byteOffset).getUint32(0, true)).toBe(0x46546c67);
  });

  it("Texturen aus dem Material-System: nach Bauteilname zugeordnet, einmal gespeichert, fehlende gemeldet", async () => {
    // Bauteil, das im GLB vorkommt: dessen Name steht in der Materialtabelle.
    const names = new Set(glbMaterials(exportGlb(sampleProject)).map((m) => m.name));
    const comp = sampleProject.components.find((c) => names.has(c.name));
    expect(comp).toBeDefined();
    const withMat: Project = {
      ...sampleProject,
      components: sampleProject.components.map((c) =>
        c.id === comp!.id ? { ...c, material: { color: "/assets/materials/Concrete048/color.jpg", normal: "/assets/materials/Concrete048/normal.jpg", roughness: "https://example.test/gibt-es-nicht.png", sizeM: 2 } } : c,
      ),
    };
    const loaded: string[] = [];
    const pkg = await buildRenderPackage(withMat, opts(), async (url) => {
      loaded.push(url);
      return url.includes("example.test") ? null : new Uint8Array([1, 2, 3]);
    });
    const used = pkg.scene.materials.filter((m) => m.name === comp!.name && m.textures);
    expect(used.length).toBeGreaterThan(0);
    expect(used[0].textures).toEqual({ color: "textures/0_color.jpg", normal: "textures/1_normal.jpg" });
    expect(used[0].sizeM).toBe(2);
    expect(pkg.files.map((f) => f.path)).toContain("textures/0_color.jpg");
    expect(pkg.missingTextures).toEqual(["https://example.test/gibt-es-nicht.png"]);
  });

  it("Glas bekommt keine Textur", async () => {
    const pkg = await buildRenderPackage(buildComplexSampleProject(), opts(), async () => new Uint8Array([1]));
    for (const m of pkg.scene.materials.filter((m) => m.glass)) expect(m.textures).toBeUndefined();
  });
});

describe("Blender-Ausgabe", () => {
  it("liest Cycles-Fortschritt und die Marken des Skripts", () => {
    expect(parseBlenderLine("Fra:1 Mem:34.12M (Peak 40M) | Time:00:02.10 | Remaining:00:10.5 | Mem:2M | Scene, ViewLayer | Sample 16/128")).toEqual({ kind: "sample", done: 16, total: 128 });
    expect(parseBlenderLine("DOSSIER_STAGE render")).toEqual({ kind: "stage", stage: "render" });
    expect(parseBlenderLine("DOSSIER_DONE /tmp/x/render.png")).toEqual({ kind: "done", path: "/tmp/x/render.png" });
    expect(parseBlenderLine("DOSSIER_ERROR kaputt")).toEqual({ kind: "error", message: "kaputt" });
    expect(parseBlenderLine("Blender 4.2.0")).toBeNull();
  });

  it("Kommandozeile", () => {
    expect(blenderArgs("/a/s.py", "/a/scene.json")).toEqual(["-b", "--python-exit-code", "1", "--python", "/a/s.py", "--", "/a/scene.json"]);
  });
});

/** Gemockter Gastgeber: Blender gibt eine feste Ausgabe und schreibt (oder nicht) das Bild. */
function fakeHost(lines: string[], o: { code?: number; png?: boolean; exe?: string | null; hang?: boolean } = {}) {
  const written: { path: string; bytes: Uint8Array }[] = [];
  const calls: { exe: string; args: string[] }[] = [];
  let cancelled = false;
  const host: BlenderHost = {
    find: async (custom) => (o.exe === undefined ? (custom ?? "/usr/bin/blender") : o.exe),
    prepare: async (files) => {
      written.push(...files);
      return "/tmp/job";
    },
    spawn: (exe, args, onLine) => {
      calls.push({ exe, args });
      let end!: (c: number) => void;
      const done = new Promise<number>((r) => (end = r));
      const cancel = () => {
        cancelled = true;
        end(-1);
      };
      if (!o.hang) {
        queueMicrotask(() => {
          for (const l of lines) onLine(l);
          end(o.code ?? 0);
        });
      }
      return { done, cancel };
    },
    readFile: async () => {
      if (o.png === false) throw new Error("fehlt");
      return new Uint8Array([137, 80, 78, 71]);
    },
    join: (d, r) => `${d}/${r}`,
  };
  return { host, written, calls, wasCancelled: () => cancelled };
}

describe("Prozess-Fassade (gemockt)", () => {
  it("startet Blender mit dem Skript, meldet Fortschritt und liefert das Bild", async () => {
    const pkg = await buildRenderPackage(sampleProject, opts());
    const f = fakeHost(["DOSSIER_STAGE import", "DOSSIER_STAGE render", "Fra:1 | Sample 8/16", "Fra:1 | Sample 16/16", "DOSSIER_DONE /tmp/job/render.png"]);
    const seen: string[] = [];
    const res = await runBlenderRender(f.host, pkg, {
      script: "print('x')",
      blenderPath: "/opt/Blender",
      onProgress: (e) => seen.push(`${e.stage}:${Math.round(e.fraction * 100)}`),
    });
    expect(f.calls[0].exe).toBe("/opt/Blender");
    expect(f.calls[0].args).toEqual(blenderArgs("/tmp/job/render_dossier.py", "/tmp/job/scene.json"));
    expect(new TextDecoder().decode(f.written.find((w) => w.path === "render_dossier.py")!.bytes)).toBe("print('x')");
    expect(seen).toContain("render:50");
    expect(seen.at(-1)).toBe("done:100");
    expect(Array.from(res.png)).toEqual([137, 80, 78, 71]);
    expect(res.path).toBe("/tmp/job/render.png");
  });

  it("ohne Blender: BlenderMissingError, nichts wird geschrieben", async () => {
    const pkg = await buildRenderPackage(sampleProject, opts());
    const f = fakeHost([], { exe: null });
    await expect(runBlenderRender(f.host, pkg, { script: "" })).rejects.toBeInstanceOf(BlenderMissingError);
    expect(f.written).toEqual([]);
  });

  it("Fehler des Skripts kommt mit seinem Text", async () => {
    const pkg = await buildRenderPackage(sampleProject, opts());
    const f = fakeHost(["DOSSIER_ERROR Das Modell enthaelt keine Koerper"], { code: 1 });
    await expect(runBlenderRender(f.host, pkg, { script: "" })).rejects.toThrow("Das Modell enthaelt keine Koerper");
  });

  it("Abbrechen beendet den Prozess", async () => {
    const pkg = await buildRenderPackage(sampleProject, opts());
    const f = fakeHost([], { hang: true });
    const ac = new AbortController();
    const p = runBlenderRender(f.host, pkg, { script: "", signal: ac.signal });
    await new Promise((r) => setTimeout(r, 10));
    ac.abort();
    await expect(p).rejects.toBeInstanceOf(RenderCancelled);
    expect(f.wasCancelled()).toBe(true);
  });

  it("Exit 0 ohne Bild ist ein Fehler", async () => {
    const pkg = await buildRenderPackage(sampleProject, opts());
    const f = fakeHost([], { png: false });
    await expect(runBlenderRender(f.host, pkg, { script: "" })).rejects.toThrow();
  });
});

describe("Blender-Skript", () => {
  const path = join(process.cwd(), "scripts", "blender", "render_dossier.py");
  const script = readFileSync(path, "utf8");

  it("enthält die Schritte: glTF-Import, Himmel mit Sonne, Cycles mit Entrauscher, PNG", () => {
    for (const marker of ["import_scene.gltf", "ShaderNodeTexSky", "sun_rotation", "OPENIMAGEDENOISE", "METAL", "render.render(write_still=True)", "DOSSIER_DONE"]) {
      expect(script).toContain(marker);
    }
  });

  it("ist gültiges Python", () => {
    const r = spawnSync("python3", ["-c", "import ast,sys; ast.parse(open(sys.argv[1]).read())", path]);
    if (r.error) return; // kein Python: übersprungen
    expect(r.status, String(r.stderr)).toBe(0);
  });
});
