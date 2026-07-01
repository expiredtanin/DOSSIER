// TS<->Rust-Paritaet fuer compute_joins: dieselben Sample-Waende, flach gemacht
// wie in der Compute-Boundary, einmal durch die TS-Implementierung und einmal
// durch das Rust-geometry-Crate (examples/parity) — die Gehrungs-Schnittlinien
// muessen numerisch identisch sein. Belegt, dass der Rust-Port die Semantik
// erhaelt (Kernbeweis der Migration).

// @ts-ignore -- node:child_process ohne globales @types/node; im Vitest-Node-Lauf vorhanden
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { sampleProject } from "../model/sampleProject";
import { computeJoins as computeJoinsTS } from "../model/joins";
import type { WallCuts } from "../model/joins";
import type { Line } from "../model/geometry";
import { getWallType, wallTypeThickness } from "../model/types";
import { wallReferenceOffset } from "../model/wall";

const EPS = 1e-9;

/** Flach wie in src/compute/index.ts (Boundary) — Eingang fuer das Rust-Crate. */
function flatten() {
  return sampleProject.walls.map((w) => {
    const thickness = wallTypeThickness(getWallType(sampleProject, w));
    return {
      id: w.id,
      start: w.start,
      end: w.end,
      thickness,
      referenceOffset: wallReferenceOffset(w, thickness),
    };
  });
}

/** Rust-Ausgabe ueber das geometry-Beispiel (liest stdin-JSON, druckt stdout-JSON). */
function runRust(input: unknown): Map<string, WallCuts> {
  const out = execFileSync(
    "cargo",
    [
      "run",
      "-q",
      "--manifest-path",
      "src-tauri/geometry/Cargo.toml",
      "--example",
      "parity",
    ],
    { input: JSON.stringify(input), encoding: "utf8", timeout: 180000 },
  );
  const arr = JSON.parse(out) as Array<{
    wallId: string;
    startCut: Line | null;
    endCut: Line | null;
  }>;
  const map = new Map<string, WallCuts>();
  for (const c of arr) map.set(c.wallId, { startCut: c.startCut, endCut: c.endCut });
  return map;
}

function lineClose(a: Line | null, b: Line | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    Math.abs(a.point.x - b.point.x) < EPS &&
    Math.abs(a.point.y - b.point.y) < EPS &&
    Math.abs(a.dir.x - b.dir.x) < EPS &&
    Math.abs(a.dir.y - b.dir.y) < EPS
  );
}

describe("compute_joins TS<->Rust Paritaet", () => {
  it("liefert fuer alle Sample-Waende identische Gehrungslinien", () => {
    const walls = sampleProject.walls;
    const ts = computeJoinsTS(sampleProject, walls);
    const rust = runRust({ walls: flatten() });

    expect(rust.size).toBe(ts.size);

    // Mindestens eine Wand muss eine echte Gehrung haben (sonst prueft der Test nichts).
    let cutsSeen = 0;
    for (const w of walls) {
      const t = ts.get(w.id)!;
      const r = rust.get(w.id);
      expect(r, `Wand ${w.id} fehlt in Rust-Ausgabe`).toBeDefined();
      expect(lineClose(t.startCut, r!.startCut), `startCut ${w.id}`).toBe(true);
      expect(lineClose(t.endCut, r!.endCut), `endCut ${w.id}`).toBe(true);
      if (t.startCut) cutsSeen++;
      if (t.endCut) cutsSeen++;
    }
    expect(cutsSeen, "keine einzige Gehrung im Sample — Test waere aussagelos").toBeGreaterThan(0);
  });
});
