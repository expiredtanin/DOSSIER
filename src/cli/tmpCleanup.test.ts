// [273] Arbeitsordner von `render`/`blend` (Blender und Cycles): nach Erfolg UND Fehler weg, ausser bei `--keep`.
// Eigener TMPDIR je Test, damit nachgezählt werden kann, was die CLI liegen lässt (Ersatzprogramme wie in render.test.ts).
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { chmodSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "./main";
import { serializeProject } from "../core";
import { sampleProject } from "../model/sampleProject";
import { makeExr } from "../export/cyclesExr.testutil";
import { makeTmpDir } from "../test/tmpDir";

const dir = makeTmpDir("dossier-cli-cleanup-");
const file = join(dir, "demo.obp");
const okBlender = join(dir, "blender-ok");
const failBlender = join(dir, "blender-fail");
const okCycles = join(dir, "cycles-ok");
const failCycles = join(dir, "cycles-fail");
const realTmp = process.env.TMPDIR;

beforeAll(() => {
  process.env.DOSSIER_WASM_DIR = join(process.cwd(), "src", "engine");
  writeFileSync(file, serializeProject(sampleProject));
  const exr = join(dir, "fake.exr");
  writeFileSync(exr, makeExr(8, 4, new Float32Array(8 * 4 * 3).fill(0.4), true));
  const script = (name: string, body: string) => {
    writeFileSync(name, `#!/bin/sh\n${body}\n`);
    chmodSync(name, 0o755);
  };
  script(okBlender, `for a in "$@"; do scene="$a"; done\nprintf '\\211PNG\\r\\n\\032\\n' > "$(dirname "$scene")/render.png"\nprintf 'BLENDER-v405' > "$(dirname "$scene")/dossier.blend"\necho "DOSSIER_DONE x"`);
  script(failBlender, `echo "DOSSIER_ERROR kaputt"\nexit 1`);
  script(okCycles, `for a in "$@"; do [ "$p" = "--output" ] && out="$a"; p="$a"; done\ncp "${exr}" "$out"`);
  script(failCycles, `echo "boom"\nexit 2`);
});

/** Läuft in eigenem leeren TMPDIR und gibt zurück, was dort nach dem Lauf liegt. */
async function leftover(argv: string[]): Promise<{ code: number; left: string[] }> {
  const t = makeTmpDir("dossier-cli-tmp-");
  process.env.TMPDIR = t;
  const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    const code = await run(argv);
    return { code, left: readdirSync(t) };
  } finally {
    err.mockRestore();
    process.env.TMPDIR = realTmp;
    rmSync(t, { recursive: true, force: true });
  }
}

afterEach(() => {
  process.env.TMPDIR = realTmp;
});

const small = ["--samples", "8", "--size", "8x4", "--cpu"];

describe("[273] CLI räumt Arbeitsordner auf", () => {
  it("render (Blender) Erfolg: kein Ordner übrig", async () => {
    const r = await leftover([file, "render", "--out", join(dir, "a.png"), ...small, "--blender", okBlender]);
    expect(r.code).toBe(0);
    expect(r.left).toEqual([]);
  }, 60_000);

  it("render (Blender) Fehler: kein Ordner übrig", async () => {
    const r = await leftover([file, "render", "--out", join(dir, "b.png"), ...small, "--blender", failBlender]);
    expect(r.code).toBe(1);
    expect(r.left).toEqual([]);
  }, 60_000);

  it("blend Erfolg und Fehler: kein Ordner übrig", async () => {
    expect((await leftover([file, "blend", "--out", join(dir, "c.blend"), ...small, "--blender", okBlender])).left).toEqual([]);
    const f = await leftover([file, "blend", "--out", join(dir, "d.blend"), ...small, "--blender", failBlender]);
    expect(f.code).toBe(1);
    expect(f.left).toEqual([]);
  }, 60_000);

  it("render --engine cycles Erfolg und Fehler: kein Ordner übrig", async () => {
    const ok = await leftover([":musterhaus-komplex", "render", "--engine", "cycles", "--cycles", okCycles, "--out", join(dir, "e.png"), ...small]);
    expect(ok.code).toBe(0);
    expect(ok.left).toEqual([]);
    const bad = await leftover([":musterhaus-komplex", "render", "--engine", "cycles", "--cycles", failCycles, "--out", join(dir, "f.png"), ...small]);
    expect(bad.code).toBe(1);
    expect(bad.left).toEqual([]);
  }, 120_000);

  it("--keep behält den Arbeitsordner", async () => {
    const r = await leftover([file, "render", "--out", join(dir, "g.png"), ...small, "--blender", okBlender, "--keep"]);
    expect(r.code).toBe(0);
    expect(r.left).toHaveLength(1);
    expect(r.left[0]).toMatch(/^dossier-render-/);
  }, 60_000);
});
