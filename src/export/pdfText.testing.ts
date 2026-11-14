// Test-Helfer ([208]): sichtbarer Text eines PDFs über `pdftotext` (Poppler). Mit den eingebetteten Schriften steht
// Text nicht mehr als `(Text)` im Inhaltsstrom, sondern als Glyphen-Nummern (Identity-H).
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const HAVE_POPPLER = spawnSync("pdftotext", ["-v"]).error === undefined && spawnSync("pdffonts", ["-v"]).error === undefined;

export function withPdfFile<T>(bytes: Uint8Array, fn: (file: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "dossier-pdf-"));
  try {
    const file = join(dir, "t.pdf");
    writeFileSync(file, bytes);
    return fn(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Sichtbarer Text (Zeilen so, wie sie auf dem Blatt stehen); leer ohne Poppler. */
export function pdfVisibleText(bytes: Uint8Array): string {
  if (!HAVE_POPPLER) return "";
  return withPdfFile(bytes, (f) => spawnSync("pdftotext", ["-layout", f, "-"], { encoding: "utf8" }).stdout);
}
