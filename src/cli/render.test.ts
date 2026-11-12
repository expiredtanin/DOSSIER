// [211] dossier-cli render: Paket, Aufruf von Blender und Bild — mit einem Blender-Ersatz (Shell-Skript), das die
// Kommandozeile prüft, Cycles-Zeilen ausgibt und ein PNG neben scene.json schreibt. Ein echter Blender-Lauf
// steht nicht in der Testsuite (Beschreibung in TODO.md [211]).
import { describe, expect, it, beforeAll, vi } from "vitest";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "./main";
import { serializeProject } from "../core";
import { sampleProject } from "../model/sampleProject";

const dir = mkdtempSync(join(tmpdir(), "dossier-cli-render-"));
const file = join(dir, "demo.obp");
const fake = join(dir, "blender-fake");

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
