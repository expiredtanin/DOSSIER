// [273] Temp-Ordner in Tests: immer wieder aufräumen. `makeTmpDir` legt einen Ordner an und löscht ihn nach der Testdatei
// (afterAll), `withTmpDir` nach dem Aufruf (auch bei Fehler). Kein `mkdtempSync(join(tmpdir(), …))` mehr direkt in Tests.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

const made: string[] = [];

function removeAll(): void {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
}

// Beim Import (Sammelphase der Testdatei) eintragen: ein afterAll im laufenden Test würde nie ausgeführt.
afterAll(removeAll);

/** Neuer Temp-Ordner mit Präfix; wird am Ende der Testdatei gelöscht. */
export function makeTmpDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  made.push(d);
  return d;
}

/** Temp-Ordner nur für `fn`; danach gelöscht (auch bei Fehler). */
export async function withTmpDir<T>(prefix: string, fn: (dir: string) => T | Promise<T>): Promise<T> {
  const d = mkdtempSync(join(tmpdir(), prefix));
  try {
    return await fn(d);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
}
