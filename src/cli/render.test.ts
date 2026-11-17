// [211] dossier-cli render: Paket, Aufruf von Blender und Bild — mit einem Blender-Ersatz (Shell-Skript), das die
// Kommandozeile prüft, Cycles-Zeilen ausgibt und ein PNG neben scene.json schreibt. Ein echter Blender-Lauf
// steht nicht in der Testsuite (Beschreibung in TODO.md [211]).
import { describe, expect, it, beforeAll, vi } from "vitest";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { run } from "./main";
import { serializeProject } from "../core";
import { sampleProject } from "../model/sampleProject";
import { makeExr } from "../export/cyclesExr.testutil";
import { makeTmpDir } from "../test/tmpDir";

const dir = makeTmpDir("dossier-cli-render-");
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

// [215] `render --engine cycles`: Szene aus dem Kern, Ersatz-`cycles` (Shell-Skript) schreibt ein EXR; die CLI macht daraus das PNG.
describe("dossier-cli render --engine cycles", () => {
  const fakeCycles = join(dir, "cycles-fake");
  const fakeExr = join(dir, "fake.exr");
  beforeAll(() => {
    writeFileSync(fakeExr, makeExr(8, 4, new Float32Array(8 * 4 * 3).fill(0.4), true));
    writeFileSync(
      fakeCycles,
      `#!/bin/sh
echo "args: $@" > "${dir}/fake-cycles-args.txt"
out=""
prev=""
for a in "$@"; do
  [ "$prev" = "--output" ] && out="$a"
  prev="$a"
  scene="$a"
done
cp "$scene" "${dir}/fake-cycles-scene.xml"
printf 'Progress 50.00   Sample 4/8\\rProgress 100.00   Sample 8/8\\n'
cp "${fakeExr}" "$out"
echo "Finished Rendering."
`,
    );
    chmodSync(fakeCycles, 0o755);
  });
  const quiet = async <T,>(f: () => Promise<T>): Promise<{ result: T; err: string }> => {
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const result = await f();
      return { result, err: err.mock.calls.map((c) => String(c[0])).join("") };
    } finally {
      err.mockRestore();
    }
  };

  it("schreibt Szene, startet cycles mit Grösse/Samples und macht ein PNG", async () => {
    const png = join(dir, "cy.png");
    const { result, err } = await quiet(() => run([":musterhaus-komplex", "render", "--engine", "cycles", "--cycles", fakeCycles, "--out", png, "--camera", "Südost", "--samples", "8", "--size", "8x4"]));
    expect(result).toBe(0);
    expect(Array.from(readFileSync(png).subarray(1, 4))).toEqual([80, 78, 71]);
    expect(err).toContain("geschrieben:");
    const args = readFileSync(join(dir, "fake-cycles-args.txt"), "utf8");
    expect(args).toMatch(/--background --samples 8 --width 8 --height 4 --output .*render\.exr .*scene\.xml/);
    const xml = readFileSync(join(dir, "fake-cycles-scene.xml"), "utf8");
    expect(xml).toContain("<cycles>");
    expect(xml).toContain("camera_type=\"perspective\"");
    expect(xml).toMatch(/<mesh P=/);
    // Bildkarten der Bibliothek (Gelände: Wiese) liegen neben der XML.
    expect(xml).toContain("textures/");
  }, 120_000);

  // [271][272] Die Szene folgt `--renovation`/`--phase`/`--options`/`--combination`; Umbau-Farben nur mit `--renovation-colors`.
  it("Szene ohne Ausgeblendetes, Kombination und Umbau-Farben auf Wunsch", async () => {
    const sceneXml = () => readFileSync(join(dir, "fake-cycles-scene.xml"), "utf8");
    const meshes = (xml: string) => (xml.match(/<mesh /g) ?? []).length;
    const base = (extra: string[]) => run([":umbau", "render", "--engine", "cycles", "--cycles", fakeCycles, "--out", join(dir, "ren.png"), "--samples", "8", "--size", "8x4", "--no-context", ...extra]);
    expect((await quiet(() => base([]))).result).toBe(0);
    const ganz = sceneXml();
    expect((await quiet(() => base(["--renovation", "bestand"]))).result).toBe(0);
    const bestand = sceneXml();
    expect(meshes(bestand)).toBeLessThan(meshes(ganz));
    expect(bestand).not.toContain("Umbau-");
    expect((await quiet(() => base(["--renovation", "umbauplan"]))).result).toBe(0);
    expect(sceneXml()).not.toContain("Umbau-");
    expect((await quiet(() => base(["--renovation", "umbauplan", "--renovation-colors"]))).result).toBe(0);
    expect(sceneXml()).toContain("Umbau-ffd800");
    const vb = (extra: string[]) => run([":varianten", "render", "--engine", "cycles", "--cycles", fakeCycles, "--out", join(dir, "var.png"), "--samples", "8", "--size", "8x4", "--no-context", ...extra]);
    expect((await quiet(() => vb([]))).result).toBe(0);
    const studie1 = sceneXml();
    expect((await quiet(() => vb(["--combination", "Studie 2 Satteldach/Bandfenster"]))).result).toBe(0);
    expect(sceneXml()).not.toBe(studie1);
    expect((await quiet(() => vb(["--options", "Dachform=B"]))).result).toBe(0);
    expect(sceneXml()).not.toBe(studie1);
  }, 240_000);

  it("Programm aus DOSSIER_CYCLES; fehlt es: Hinweis und Exit-Code 3", async () => {
    const png = join(dir, "cy2.png");
    const old = process.env.DOSSIER_CYCLES;
    try {
      process.env.DOSSIER_CYCLES = fakeCycles;
      expect((await quiet(() => run([file, "render", "--engine", "cycles", "--out", png, "--samples", "8", "--size", "8x4"]))).result).toBe(0);
      expect(existsSync(png)).toBe(true);
      process.env.DOSSIER_CYCLES = join(dir, "gibt-es-nicht");
      const r = await quiet(() => run([file, "render", "--engine", "cycles", "--out", join(dir, "cy3.png")]));
      expect(r.result).toBe(3);
      expect(r.err).toContain("Cycles nicht gefunden");
    } finally {
      if (old === undefined) delete process.env.DOSSIER_CYCLES;
      else process.env.DOSSIER_CYCLES = old;
    }
  }, 120_000);

  it("--engine blender bleibt der Standardweg; unbekannte Engine/Look beenden mit Fehler", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as never);
    try {
      await quiet(async () => {
        await expect(run([file, "render", "--engine", "unity", "--out", join(dir, "u.png")])).rejects.toThrow("exit");
        await expect(run([file, "render", "--engine", "cycles", "--look", "grell", "--cycles", fakeCycles, "--out", join(dir, "u.png")])).rejects.toThrow("exit");
      });
    } finally {
      exit.mockRestore();
    }
    expect((await quiet(() => run([file, "render", "--engine", "blender", "--out", join(dir, "b.png"), "--blender", fake, "--size", "320x180", "--samples", "8"]))).result).toBe(0);
  }, 120_000);
});

// Echter Lauf mit dem gebauten Cycles (nur wenn `DOSSIER_CYCLES` auf das Programm zeigt): `:beispiel` klein mit 8 Samples.
const realCycles = process.env.DOSSIER_CYCLES;
describe.skipIf(!realCycles || !existsSync(realCycles))("dossier-cli render --engine cycles mit echtem Cycles", () => {
  it(":beispiel 320x180, 8 Samples → PNG mit Himmel, Haus und Boden", async () => {
    const png = join(dir, "echt.png");
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(await run([":beispiel", "render", "--engine", "cycles", "--out", png, "--samples", "8", "--size", "320x180", "--cpu"])).toBe(0);
    } finally {
      err.mockRestore();
    }
    const bytes = readFileSync(png);
    expect(Array.from(bytes.subarray(1, 4))).toEqual([80, 78, 71]);
    const dv = new DataView(bytes.buffer, bytes.byteOffset);
    expect([dv.getUint32(16), dv.getUint32(20)]).toEqual([320, 180]);
    const { inflateSync } = await import("node:zlib");
    const raw = inflateSync(bytes.subarray(41, 41 + dv.getUint32(33)));
    // Nicht einfarbig und nicht schwarz: Mittelwert hell genug, Streuung vorhanden.
    let sum = 0;
    let min = 255;
    let max = 0;
    for (let i = 0; i < raw.length; i++) {
      if (i % (320 * 3 + 1) === 0) continue;
      sum += raw[i];
      min = Math.min(min, raw[i]);
      max = Math.max(max, raw[i]);
    }
    expect(sum / (raw.length - 180)).toBeGreaterThan(40);
    expect(max - min).toBeGreaterThan(80);
  }, 240_000);

  // [271][272] Ansicht: Umbau „Endzustand“ und Variantenkombination „Studie 2“ rendern (klein, 4 Samples).
  it(":umbau im Endzustand und :varianten Studie 2 geben ein PNG", async () => {
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      for (const [name, extra] of [
        [":umbau", ["--renovation", "endzustand"]],
        [":varianten", ["--combination", "Studie 2 Satteldach/Bandfenster"]],
      ] as const) {
        const png = join(dir, `echt-${name.slice(1)}.png`);
        expect(await run([name, "render", "--engine", "cycles", "--out", png, "--samples", "4", "--size", "160x90", "--cpu", ...extra])).toBe(0);
        expect(Array.from(readFileSync(png).subarray(1, 4))).toEqual([80, 78, 71]);
      }
    } finally {
      err.mockRestore();
    }
  }, 360_000);
});
