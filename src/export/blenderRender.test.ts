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
  runBlenderSave,
  runBlenderOpen,
  blendOpenArgs,
  findRenderCamera,
  projectRenderCameras,
  renderCameraOf,
  splitRoofMaterials,
  TERRAIN_MATERIAL,
  type BlenderHost,
  type RenderOptions,
} from "./blenderRender";
import { exportGlb } from "./exportMesh";
import { meshSceneGroups } from "./meshScene.testutil";
import { cameraToView } from "../viewport/cameraView";

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
    // Blender 4.x (macOS): andere Fortschrittszeile
    expect(parseBlenderLine("Fra:1 Mem:120.4M (Peak 300M) | Time:00:03.21 | Remaining:00:09.12 | Mem:80M, Peak:90M | Scene, ViewLayer | Rendering 5 / 32 samples")).toEqual({ kind: "sample", done: 5, total: 32 });
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
  const launched: { exe: string; args: string[] }[] = [];
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
    readFile: async (path) => {
      if (o.png === false) throw new Error("fehlt");
      return path.endsWith(".blend") ? new TextEncoder().encode("BLENDER-v405") : new Uint8Array([137, 80, 78, 71]);
    },
    launch: async (exe, args) => {
      launched.push({ exe, args });
    },
    join: (d, r) => `${d}/${r}`,
  };
  return { host, written, calls, launched, wasCancelled: () => cancelled };
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

describe(".blend speichern / in Blender öffnen ([228])", () => {
  it("Paket im Modus „save“: scene.mode und Dateiname; Standard bleibt „render“ ohne blend", async () => {
    const save = await buildRenderPackage(sampleProject, opts({ mode: "save" }));
    expect(save.scene.mode).toBe("save");
    expect(save.scene.blend).toBe("dossier.blend");
    const json = JSON.parse(new TextDecoder().decode(save.files.find((f) => f.path === "scene.json")!.bytes));
    expect(json.mode).toBe("save");
    const render = await buildRenderPackage(sampleProject, opts());
    expect(render.scene.mode).toBe("render");
    expect(render.scene.blend).toBeUndefined();
  });

  it("GLB trägt die Zuordnung: Knotenname „Wand_<id>“, extras.type/id, Geschoss-Knoten, Baustoff als Materialname", async () => {
    const glb = exportGlb(buildComplexSampleProject());
    const dv = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
    const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + dv.getUint32(12, true))));
    const nodes = json.nodes as { name: string; mesh?: number; extras?: { type: string; id: string } }[];
    const wall = nodes.find((n) => n.extras?.type === "wall")!;
    expect(wall.name).toMatch(/^Wand_/);
    expect(wall.name).toBe(`Wand_${wall.extras!.id}`);
    for (const type of ["slab", "roof", "window", "door", "terrain", "level"]) expect(nodes.some((n) => n.extras?.type === type), type).toBe(true);
  });

  it("Blender-Aufruf wie beim Rendern (-b), der Modus steht in scene.json; Ergebnis = .blend", async () => {
    const pkg = await buildRenderPackage(sampleProject, opts({ mode: "save" }));
    const f = fakeHost(["DOSSIER_STAGE import", "DOSSIER_STAGE organize", "DOSSIER_STAGE save", "DOSSIER_DONE /tmp/job/dossier.blend"]);
    const stages: string[] = [];
    const res = await runBlenderSave(f.host, pkg, { script: "x", onProgress: (e) => stages.push(e.stage) });
    expect(f.calls[0].args).toEqual(blenderArgs("/tmp/job/render_dossier.py", "/tmp/job/scene.json"));
    expect(res.path).toBe("/tmp/job/dossier.blend");
    expect(new TextDecoder().decode(res.blend)).toBe("BLENDER-v405");
    expect(stages).toEqual(["import", "organize", "save", "done"]);
  });

  it("Paket im Modus „render“ lässt sich nicht speichern", async () => {
    const pkg = await buildRenderPackage(sampleProject, opts());
    await expect(runBlenderSave(fakeHost([]).host, pkg, { script: "" })).rejects.toThrow(/save/);
  });

  it("In Blender öffnen: erst speichern (-b), dann Blender MIT Oberfläche (ohne -b) auf die Datei starten, ohne zu warten", async () => {
    const pkg = await buildRenderPackage(sampleProject, opts({ mode: "save" }));
    const f = fakeHost(["DOSSIER_DONE /tmp/job/dossier.blend"]);
    const res = await runBlenderOpen(f.host, pkg, { script: "x", blenderPath: "/opt/Blender" });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].args).toContain("-b");
    expect(f.launched).toEqual([{ exe: "/opt/Blender", args: ["/tmp/job/dossier.blend"] }]);
    expect(f.launched[0].args).not.toContain("-b");
    expect(blendOpenArgs("/a/b.blend")).toEqual(["/a/b.blend"]);
    expect(res.path).toBe("/tmp/job/dossier.blend");
  });

  it("Öffnen ohne Blender: BlenderMissingError; Fehler beim Speichern verhindert den Start", async () => {
    const pkg = await buildRenderPackage(sampleProject, opts({ mode: "save" }));
    await expect(runBlenderOpen(fakeHost([], { exe: null }).host, pkg, { script: "" })).rejects.toBeInstanceOf(BlenderMissingError);
    const f = fakeHost(["DOSSIER_ERROR kaputt"], { code: 1 });
    await expect(runBlenderOpen(f.host, pkg, { script: "" })).rejects.toThrow("kaputt");
    expect(f.launched).toEqual([]);
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

  it("hat die Modi „render“ und „save“: Collections, Kamera «Dossier-Kamera», Bilder einpacken, .blend speichern ([228])", () => {
    for (const marker of ["pack_all()", "save_as_mainfile", "Dossier-Kamera", "Dossier-Himmel", "\"Wände\"", "\"Fenster und Türen\"", "MATERIAL", "view_perspective", "--mode"]) {
      expect(script).toContain(marker);
    }
  });

  it("nutzt keine Tangentenraum-Normalenkarte ohne UVs ([229]: sonst Streifen über triangulierten Dachflächen)", () => {
    expect(script).not.toContain("ShaderNodeNormalMap");
    expect(script).toContain("ShaderNodeBump");
  });

  it("ist gültiges Python", () => {
    const r = spawnSync("python3", ["-c", "import ast,sys; ast.parse(open(sys.argv[1]).read())", path]);
    if (r.error) return; // kein Python: übersprungen
    expect(r.status, String(r.stderr)).toBe(0);
  });
});

describe("Materialzuordnung Gelände und Dach ([211])", () => {
  const mk = buildComplexSampleProject();

  it("Dachschichten bekommen eigene Materialien nach Baustoff (Ziegel, Kies, Blech), nicht mehr alle „Dach“", async () => {
    const pkg = await buildRenderPackage(mk, opts(), async () => new Uint8Array([1]));
    const roofs = pkg.scene.materials.filter((m) => m.role === "roof");
    const names = roofs.map((m) => m.name);
    expect(names).toContain("Dach: Tonziegel");
    expect(names).toContain("Dach: Kies / Sauberkeitsschicht");
    expect(names).toContain("Dach: Trapezblech");
    expect(names).not.toContain("Dach");
    const tile = roofs.find((m) => m.name === "Dach: Tonziegel")!;
    expect(tile.component).toBe("Tonziegel");
    // Bildkarten des Baustoffs „Tonziegel“ (RoofingTiles013A), nicht des Namens „Dach“.
    expect(tile.textures?.color).toBeDefined();
    expect(tile.sizeM).toBeGreaterThan(0);
  });

  it("das neue GLB bleibt gültig und die Dachknoten zeigen auf die neuen Materialien", () => {
    const glb = splitRoofMaterials(exportGlb(mk), mk);
    const dv = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
    expect(dv.getUint32(0, true)).toBe(0x46546c67);
    expect(dv.getUint32(8, true)).toBe(glb.byteLength);
    expect(dv.getUint32(12, true) % 4).toBe(0);
    const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + dv.getUint32(12, true))));
    // BIN-Chunk dahinter unverändert vorhanden.
    const binLen = dv.getUint32(20 + dv.getUint32(12, true), true);
    expect(20 + dv.getUint32(12, true) + 8 + binLen).toBe(glb.byteLength);
    const roofNode = json.nodes.find((n: { name?: string }) => n.name === "Dach_dach-haupt");
    const used = json.meshes[roofNode.mesh].primitives.map((p: { material: number }) => json.materials[p.material].name);
    expect(used).toEqual(["Dach: Tonziegel"]);
  });

  it("Gelände: Rolle terrain mit Wiese aus der Bibliothek; ohne Bildkarten bleibt die Rolle für den Leser", async () => {
    const pkg = await buildRenderPackage(mk, opts(), async () => new Uint8Array([1]));
    const terrain = pkg.scene.materials.find((m) => m.name === "Gelaende")!;
    expect(terrain.role).toBe("terrain");
    expect(terrain.textures?.color).toMatch(/^textures\/\d+_color\.jpg$/);
    expect(terrain.sizeM).toBe(TERRAIN_MATERIAL.sizeM);
    expect(TERRAIN_MATERIAL.libraryId).toBe("Grass005");
    const bare = await buildRenderPackage(mk, opts());
    const t2 = bare.scene.materials.find((m) => m.name === "Gelaende")!;
    expect(t2.role).toBe("terrain");
    expect(t2.textures).toBeUndefined();
  });

  it("Glas und Öffnungsteile haben ihre Rolle, Wände „building“", async () => {
    const pkg = await buildRenderPackage(mk, opts());
    expect(pkg.scene.materials.find((m) => m.glass)?.role).toBe("opening");
    expect(pkg.scene.materials.find((m) => m.name === "Aussenputz")?.role).toBe("building");
  });

  it("jedes Material des GLB hat eine Rolle und kommt in der Tabelle vor, nicht benutzte (altes „Dach“) fehlen", () => {
    const mats = glbMaterials(splitRoofMaterials(exportGlb(mk), mk));
    expect(mats.every((m) => m.role)).toBe(true);
    expect(mats.some((m) => m.name === "Dach")).toBe(false);
  });
});

describe("Kamera wählen ([213])", () => {
  const mk = buildComplexSampleProject();

  it("Südost: gleiche Sicht wie cameraToView, Sonnenzeit der Kamera", () => {
    const choice = findRenderCamera(mk, "Südost")!;
    expect(choice).toBeTruthy();
    expect(choice.id).toBe("kamera-suedost");
    const cam = mk.cameras![0];
    const view = cameraToView(mk, cam)!;
    expect(choice.camera.position).toEqual(view.position);
    expect(choice.camera.direction).toEqual(view.direction);
    expect(choice.camera.up).toEqual(view.up);
    expect(choice.camera.fovDeg).toBe(view.fovDeg);
    expect(choice.camera.kind).toBe(view.kind);
    expect(choice.camera.orthoHeight).toBe(view.orthoHeight);
    expect(choice.sunWhen?.toISOString()).toBe("2026-06-21T16:00:00.000Z");
    // Augenhöhe 1.6 m über OK EG.
    expect(choice.camera.position[2]).toBeCloseTo(1.6 + (mk.drawingLevels.find((l) => l.id === "eg")?.baseElevation ?? 0), 9);
  });

  it("Suche nach Id oder Name (Schreibweise egal), unbekannt = null", () => {
    expect(findRenderCamera(mk, "kamera-suedost")?.name).toBe("Südost");
    expect(findRenderCamera(mk, "südost")?.id).toBe("kamera-suedost");
    expect(findRenderCamera(mk, "gibt es nicht")).toBeNull();
    expect(projectRenderCameras(sampleProject)).toEqual([]);
  });

  it("entartete Kamera (Standpunkt = Ziel) fällt aus der Liste", () => {
    const cam = { ...mk.cameras![0], target: { ...mk.cameras![0].position } };
    expect(renderCameraOf(mk, { ...cam, targetHeight: 1.6 })).toBeNull();
    expect(projectRenderCameras({ ...mk, cameras: [{ ...cam, targetHeight: 1.6 }] })).toEqual([]);
  });

  it("das Paket trägt die Kamera und die Sonne der Kamera", async () => {
    const choice = findRenderCamera(mk, "Südost")!;
    const pkg = await buildRenderPackage(mk, opts({ camera: choice.camera, when: choice.sunWhen! }));
    expect(pkg.scene.camera).toEqual(choice.camera);
    expect(pkg.scene.sun.when).toBe("2026-06-21T16:00:00.000Z");
    // Abendsonne: tiefer als zur Vormittagszeit des Projekts.
    expect(pkg.scene.sun.elevation).toBeLessThan(renderSun(mk, defaultRenderTime(mk)).elevation);
  });
});

describe("Baugrube im Rendering ausblenden ([227])", () => {
  const complex = buildComplexSampleProject();
  const lowest = (groups: ReturnType<typeof meshSceneGroups>, kind: string): number => {
    let m = Infinity;
    for (const g of groups) if (g.kind === kind) for (const p of g.prims) for (let i = 1; i < p.positions.length; i += 3) m = Math.min(m, p.positions[i]);
    return m;
  };

  it("hinterfüllt: das Gelände ist das gewachsene, ohne Sohle bei −3.35 m; sonst bleibt die Grube", () => {
    expect(lowest(meshSceneGroups(complex), "terrain")).toBeCloseTo(-3.35, 2);
    expect(lowest(meshSceneGroups(complex, true), "terrain")).toBeGreaterThan(-3.3);
  });

  it("Paket: Vorgabe an (scene.backfilled, kleineres/anderes GLB), mit backfilled: false bleibt die Grube", async () => {
    const on = await buildRenderPackage(complex, opts());
    const off = await buildRenderPackage(complex, opts({ backfilled: false }));
    expect(on.scene.backfilled).toBe(true);
    expect(off.scene.backfilled).toBe(false);
    const size = (p: typeof on) => p.files.find((f) => f.path === "model.glb")!.bytes.length;
    expect(size(on)).not.toBe(size(off));
  });

  it("das normale GLB (Export, Anzeige) behält die Baugrube", () => {
    expect(exportGlb(complex).length).toBe(exportGlb(complex, { backfilled: false }).length);
    expect(exportGlb(complex).length).not.toBe(exportGlb(complex, { backfilled: true }).length);
  });
});
