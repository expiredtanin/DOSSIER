// [273] vitest-globalSetup: die Testläufe bekommen einen eigenen TMPDIR. Am Ende wird nachgezählt: was Tests dort liegen
// lassen, wird gemeldet (Lauf schlägt fehl) und trotzdem gelöscht — so wächst /tmp nie.
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let root = "";
let before: string | undefined;

export function setup(): void {
  before = process.env.TMPDIR;
  root = mkdtempSync(join(tmpdir(), "dossier-vitest-"));
  process.env.TMPDIR = root;
}

export function teardown(): void {
  if (before === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = before;
  let left: string[] = [];
  try {
    left = readdirSync(root);
  } catch {
    // schon weg
  }
  rmSync(root, { recursive: true, force: true });
  if (left.length > 0) {
    throw new Error(`[273] Tests haben ${left.length} Temp-Ordner/-Dateien liegen lassen (src/test/tmpDir.ts nutzen): ${left.slice(0, 20).join(", ")}`);
  }
}
