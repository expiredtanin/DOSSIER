// [K4] S4: Rundreise TS → JSON → Rust (typisiertes Modell) → JSON → TS. Die TS-Typen kommen aus dem
// Rust-Modell (`types.generated.ts`); hier wird geprüft, dass ein Projekt, das zu diesen Typen passt,
// vom Rust-Modell OHNE Rest (keine `Extra`-Felder, keine `Unknown`-Varianten) gelesen und gleich
// zurückgeschrieben wird. Abfrage `modelJson` serialisiert das typisierte Modell ohne Extra-Felder —
// fehlt Rust ein Feld, fehlt es in der Antwort.
import { describe, expect, it } from "vitest";
import { ProjectDocument } from "../core/document";
import { sampleProject } from "./sampleProject";
import type { Project } from "./types";
import { plain, randomProject, richProject } from "./richProject.testing";

function viaRust(p: Project): unknown {
  const d = new ProjectDocument(p);
  try {
    return d.query("modelJson");
  } finally {
    d.close();
  }
}

/** Pfade, an denen sich zwei JSON-Bäume unterscheiden (für lesbare Fehlermeldungen). */
function diffPaths(a: unknown, b: unknown, path = "", out: string[] = []): string[] {
  if (out.length > 20) return out;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    if (JSON.stringify(a) !== JSON.stringify(b)) out.push(`${path}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`);
    return out;
  }
  if (Array.isArray(a) !== Array.isArray(b)) {
    out.push(`${path}: Liste/Objekt`);
    return out;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) diffPaths((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`, out);
  return out;
}

describe("Modell-Rundreise TS → Rust → TS ([K4] S4)", () => {
  it("Beispielprojekt bleibt gleich", () => {
    const back = viaRust(sampleProject);
    expect(diffPaths(back, plain(sampleProject))).toEqual([]);
  });

  it("Projekt mit allen Element-Arten bleibt gleich (keine Felder ausserhalb des Rust-Modells)", () => {
    const p = richProject();
    expect(diffPaths(viaRust(p), plain(p))).toEqual([]);
  });

  it("Zufallsprojekte bleiben gleich", () => {
    for (let seed = 1; seed <= 60; seed++) {
      const p = randomProject(seed);
      expect(diffPaths(viaRust(p), plain(p)), `Saat ${seed}`).toEqual([]);
    }
  });
});
