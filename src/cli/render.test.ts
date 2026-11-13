// [211] dossier-cli render: Paket, Aufruf von Blender und Bild — mit einem Blender-Ersatz (Shell-Skript), das die
// Kommandozeile prüft, Cycles-Zeilen ausgibt und ein PNG neben scene.json schreibt. Ein echter Blender-Lauf
// steht nicht in der Testsuite (Beschreibung in TODO.md [211]).
import { describe, expect, it, beforeAll, vi } from "vitest";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { run } from "./main";
import { serializeProject } from "../core";
import { sampleProject } from "../model/sampleProject";

const dir = mkdtempSync(join(tmpdir(), "dossier-cli-render-"));
const file = join(dir, "demo.obp");
const fake = join(dir, "blender-fake");
const fakeBlend = join(dir, "blender-fake-blend");

beforeAll(() => {
  process.env.DOSSIER_WASM_DIR = join(process.cwd(), "src", "engine");
  writeFileSync(file, serializeProject(sampleProject));
  // Ersatz-Blender: sucht scene.json hinter `--`, prüft das Skript, schreibt das Bild (PNG-Kopf) daneben.
  writeFileSync(
    fake,
    `#!/bin/sh
echo "args: $@" > "${dir}/fake-args.txt"
scene=""
script=""
prev=""
for a in "$@"; do
  if [ "$prev" = "--python" ]; then script="$a"; fi
  prev="$a"
  scene="$a"
done
[ -f "$script" ] || { echo "DOSSIER_ERROR Skript fehlt"; exit 1; }
[ -f "$scene" ] || { echo "DOSSIER_ERROR scene.json fehlt"; exit 1; }
cp "$scene" "${dir}/fake-scene.json"
echo "DOSSIER_STAGE render"
echo "Fra:1 Mem:1M | Sample 8/16"
echo "Fra:1 Mem:1M | Sample 16/16"
printf '\\211PNG\\r\\n\\032\\n' > "$(dirname "$scene")/render.png"
echo "DOSSIER_DONE x"
`,
  );
  chmodSync(fake, 0o755);
  // Ersatz-Blender für `blend` ([228]): schreibt `dossier.blend` statt des Bildes, wenn scene.json den Modus save verlangt.
  writeFileSync(
    fakeBlend,
    `#!/bin/sh
echo "args: $@" > "${dir}/fake-args.txt"
for a in "$@"; do scene="$a"; done
cp "$scene" "${dir}/fake-scene.json"
echo "DOSSIER_STAGE save"
printf 'BLENDER-v405' > "$(dirname "$scene")/dossier.blend"
echo "DOSSIER_DONE x"
`,
  );
  chmodSync(fakeBlend, 0o755);
});

describe("dossier-cli render", () => {
  it("baut das Paket, ruft Blender mit dem Skript auf und schreibt das Bild", async () => {
    const png = join(dir, "bild.png");
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(await run([file, "render", "--out", png, "--view", "front", "--when", "2026-06-21T10:00Z", "--samples", "16", "--size", "640x360", "--cpu", "--blender", fake])).toBe(0);
    } finally {
      err.mockRestore();
    }
    expect(existsSync(png)).toBe(true);
    expect(Array.from(readFileSync(png).subarray(1, 4))).toEqual([80, 78, 71]);
    const args = readFileSync(join(dir, "fake-args.txt"), "utf8");
    expect(args).toMatch(/-b --python-exit-code 1 --python .*render_dossier\.py -- .*scene\.json/);
    const scene = JSON.parse(readFileSync(join(dir, "fake-scene.json"), "utf8"));
    expect(scene.camera).toEqual({ preset: "front" });
    expect(scene.resolution).toEqual({ width: 640, height: 360 });
    expect(scene.samples).toBe(16);
    expect(scene.device).toBe("cpu");
    expect(scene.sun.when).toBe("2026-06-21T10:00:00.000Z");
    expect(scene.sun.elevation).toBeGreaterThan(40);
  }, 60_000);

  it("--camera: gespeicherte Kamera und deren Sonnenzeit (--when übersteuert)", async () => {
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(await run([":musterhaus-komplex", "render", "--out", join(dir, "k.png"), "--camera", "Südost", "--samples", "8", "--size", "320x180", "--cpu", "--blender", fake])).toBe(0);
      const scene = JSON.parse(readFileSync(join(dir, "fake-scene.json"), "utf8"));
      expect(scene.camera.kind).toBe("perspective");
      expect(scene.camera.position[0]).toBeCloseTo(17, 6);
      expect(scene.camera.position[1]).toBeCloseTo(-3, 6);
      expect(scene.camera.fovDeg).toBe(50);
      expect(scene.sun.when).toBe("2026-06-21T16:00:00.000Z");
      expect(await run([":musterhaus-komplex", "render", "--out", join(dir, "k2.png"), "--camera", "kamera-suedost", "--when", "2026-06-21T08:00Z", "--samples", "8", "--size", "320x180", "--cpu", "--blender", fake])).toBe(0);
      expect(JSON.parse(readFileSync(join(dir, "fake-scene.json"), "utf8")).sun.when).toBe("2026-06-21T08:00:00.000Z");
      // `fail()` beendet den Prozess: hier als Ausnahme abfangen.
      const exit = vi.spyOn(process, "exit").mockImplementation((() => {
        throw new Error("exit");
      }) as never);
      await expect(run([":musterhaus-komplex", "render", "--out", join(dir, "k3.png"), "--camera", "gibt-es-nicht", "--blender", fake])).rejects.toThrow("exit");
      exit.mockRestore();
      expect(err.mock.calls.map((c) => String(c[0])).join("")).toContain("--camera");
    } finally {
      err.mockRestore();
    }
  }, 120_000);

  it("blend ([228]): Modus save, Kamera/Sonne wie beim Rendern, .blend nach --out, nicht gerendert", async () => {
    const out = join(dir, "szene.blend");
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(await run([":musterhaus-komplex", "blend", "--out", out, "--camera", "Südost", "--size", "640x360", "--cpu", "--blender", fakeBlend])).toBe(0);
    } finally {
      err.mockRestore();
    }
    expect(readFileSync(out, "utf8")).toBe("BLENDER-v405");
    expect(readFileSync(join(dir, "fake-args.txt"), "utf8")).toMatch(/^args: -b --python-exit-code 1 --python .*render_dossier\.py -- .*scene\.json/);
    const scene = JSON.parse(readFileSync(join(dir, "fake-scene.json"), "utf8"));
    expect(scene.mode).toBe("save");
    expect(scene.blend).toBe("dossier.blend");
    expect(scene.camera.kind).toBe("perspective");
    expect(scene.resolution).toEqual({ width: 640, height: 360 });
  }, 120_000);

  it("blend ohne Blender: Exit-Code 3", async () => {
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(await run([file, "blend", "--out", join(dir, "x.blend"), "--blender", join(dir, "gibt-es-nicht")])).toBe(3);
    } finally {
      err.mockRestore();
    }
  }, 60_000);

  it("ohne Blender: Hinweis und Exit-Code 3", async () => {
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(await run([file, "render", "--out", join(dir, "x.png"), "--blender", join(dir, "gibt-es-nicht")])).toBe(3);
      expect(err.mock.calls.map((c) => String(c[0])).join("")).toContain("Blender nicht gefunden");
    } finally {
      err.mockRestore();
    }
  }, 60_000);
});

// [228] Echter Lauf mit dem pip-Modul bpy (nur wenn `DOSSIER_BPY_PYTHON` auf ein Python mit `import bpy` zeigt; sonst übersprungen):
// .blend speichern, in bpy wieder öffnen, Collections/Namen/Kamera/eingepackte Bilder prüfen.
const bpyPython = process.env.DOSSIER_BPY_PYTHON;
describe.skipIf(!bpyPython || spawnSync(bpyPython, ["-c", "import bpy"]).status !== 0)("dossier-cli blend mit echtem bpy", () => {
  it("Collections nach Bauteil, lesbare Namen, Kamera «Dossier-Kamera», Bilder eingepackt, 3D-Fenster in Material-Vorschau", async () => {
    const wrapper = join(dir, "blender-bpy");
    writeFileSync(wrapper, `#!/bin/sh\nwhile [ $# -gt 0 ]; do case "$1" in --python) script="$2"; shift 2;; --) shift; break;; *) shift;; esac; done\nexec "${bpyPython}" "$script" -- "$@"\n`);
    chmodSync(wrapper, 0o755);
    const out = join(dir, "echt.blend");
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(await run([":musterhaus-komplex", "blend", "--out", out, "--camera", "Südost", "--size", "320x180", "--cpu", "--blender", wrapper])).toBe(0);
    } finally {
      err.mockRestore();
    }
    const probe = join(dir, "probe.py");
    writeFileSync(
      probe,
      `import sys, json, bpy
bpy.ops.wm.open_mainfile(filepath=sys.argv[-1])
sc = bpy.context.scene
views = [sp for s in bpy.data.screens for a in s.areas if a.type == "VIEW_3D" for sp in a.spaces if sp.type == "VIEW_3D"]
print("PROBE " + json.dumps({
  "collections": {c.name: len(c.objects) for c in sc.collection.children},
  "camera": sc.camera.name, "world": sc.world.name, "engine": sc.render.engine,
  "wall": "Wand eg-aw-s" in bpy.data.objects,
  "unpacked": [i.name for i in bpy.data.images if i.source == "FILE" and i.packed_file is None],
  "images": len(bpy.data.images),
  "shading": sorted({v.shading.type for v in views}), "persp": sorted({v.region_3d.view_perspective for v in views}),
}))
`,
    );
    const r = spawnSync(bpyPython!, ["-I", probe, out], { encoding: "utf8" });
    const line = String(r.stdout).split("\n").find((l) => l.startsWith("PROBE "));
    expect(line, String(r.stderr)).toBeTruthy();
    const info = JSON.parse(line!.slice(6));
    for (const c of ["Geschosse", "Wände", "Decken", "Dächer", "Fenster und Türen", "Treppen", "Gelände", "Kontext", "Dossier"]) expect(info.collections[c], c).toBeGreaterThan(0);
    expect(info.camera).toBe("Dossier-Kamera");
    expect(info.world).toBe("Dossier-Himmel");
    expect(info.engine).toBe("CYCLES");
    expect(info.wall).toBe(true);
    expect(info.images).toBeGreaterThan(0);
    expect(info.unpacked).toEqual([]);
    expect(info.shading).toEqual(["MATERIAL"]);
    expect(info.persp).toEqual(["CAMERA"]);
  }, 300_000);
});
