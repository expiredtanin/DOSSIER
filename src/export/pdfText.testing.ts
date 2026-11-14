// Test-Helfer ([208]): sichtbarer Text eines PDFs über `pdftotext` (Poppler). Mit den eingebetteten Schriften steht
// Text nicht mehr als `(Text)` im Inhaltsstrom, sondern als Glyphen-Nummern (Identity-H).
import { jsPDF } from "jspdf";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const HAVE_POPPLER = spawnSync("pdftotext", ["-v"]).error === undefined && spawnSync("pdffonts", ["-v"]).error === undefined;
/** In der CI muss Poppler da sein: fehlt es, schlägt der Test fehl, statt still zu entfallen. */
export const IN_CI = !!process.env.CI;
/** Für `it.runIf(...)`: Poppler-Tests laufen, wenn es Poppler gibt — oder in der CI (dann scheitern sie hart, s. `needPoppler`). */
export const RUN_POPPLER_TESTS = HAVE_POPPLER || IN_CI;
if (!HAVE_POPPLER && !IN_CI) console.warn("[pdfText] pdftotext/pdffonts (Poppler) fehlt: Text-Prüfungen am PDF werden übersprungen bzw. lassen nur die Prüfung der übergebenen Zeichenketten gelten.");

/** Wirft in der CI, wenn Poppler fehlt (kein stilles Durchlaufen). */
export function needPoppler(): void {
  if (!HAVE_POPPLER && IN_CI) throw new Error("pdftotext/pdffonts (poppler-utils) fehlt in der CI — Text-Prüfungen am PDF wären wirkungslos");
}

/**
 * Fängt alle Zeichenketten ab, die an `jsPDF.text` gehen — unabhängig von Poppler. Anonymitäts-Prüfungen können so
 * auch ohne `pdftotext` den eigentlichen Text prüfen. Wiederherstellen mit `restore()`.
 */
export function captureJsPdfText(): { strings: () => string; mark: () => number; since: (m: number) => string; restore: () => void } {
  // jsPDF meldet jeden `text()`-Aufruf (auch aus Plugins wie autoTable) an die Ereignisse `preProcessText`; sie gelten für
  // Dokumente, die nach dem Eintragen erzeugt werden.
  const events = (jsPDF as unknown as { API: { events: [string, (p: { text: unknown }) => void][] } }).API.events;
  const seen: string[] = [];
  const entry: [string, (p: { text: unknown }) => void] = [
    "preProcessText",
    (p) => {
      const t = p.text;
      if (Array.isArray(t)) seen.push(...t.flat(Infinity).map(String));
      else if (t !== undefined && t !== null) seen.push(String(t));
    },
  ];
  events.push(entry);
  return {
    strings: () => seen.join("\n"),
    mark: () => seen.length,
    since: (m) => seen.slice(m).join("\n"),
    restore: () => {
      const i = events.indexOf(entry);
      if (i >= 0) events.splice(i, 1);
    },
  };
}

export function withPdfFile<T>(bytes: Uint8Array, fn: (file: string) => T): T {
  needPoppler();
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
  needPoppler();
  if (!HAVE_POPPLER) return "";
  return withPdfFile(bytes, (f) => spawnSync("pdftotext", ["-layout", f, "-"], { encoding: "utf8" }).stdout);
}
