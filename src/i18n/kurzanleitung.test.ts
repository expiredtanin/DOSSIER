// [247] Die Kurzanleitung (doc/KURZANLEITUNG.md) muss zur App passen: was sich automatisch belegen lässt, wird hier
// geprüft. Wenige sichere Regeln statt vieler brüchiger:
//   1. Menüpfade in *Kursiv* mit „→“: jedes Glied ist ein Text aus de.ts.
//   2. **Fette** Bedienelemente und „Anführungszeichen“-Texte sind (ohne abschliessendes „…“) ein Text aus de.ts —
//      ausgenommen Gliederungswörter (enden auf „:“ oder „.“) und Beispieldaten, die in `DATA` stehen.
//   3. Befehle und Kürzel in `Backticks` (nur Kleinbuchstaben/Ziffern) lösen in der Befehls-Registry auf.
//   4. Tastenkürzel (⌘…, ⇧⌘…) stehen in SHORTCUT_DEFS oder als Accelerator im Menü (`native/appMenu.ts`).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { de } from "./de";
import { ALIASES, COMMANDS } from "../commands/registry";
import { SHORTCUT_DEFS } from "../state/keyboardShortcuts";

const ROOT = process.cwd();
const doc = readFileSync(join(ROOT, "doc", "KURZANLEITUNG.md"), "utf8");
const menuSrc = readFileSync(join(ROOT, "src", "native", "appMenu.ts"), "utf8");

const standardsSrc = readFileSync(join(ROOT, "src-tauri", "core", "src", "standards.rs"), "utf8");

const strip = (s: string) => s.replace(/\s*…\s*$/, "").replace(/\s+/g, " ").trim();
const VALUES = new Set(Object.values(de as Record<string, string>).map(strip));

/** Texte, die keine UI-Texte sind, sondern Beispieldaten, Dateiformate oder Zahlen aus dem Beispielprojekt. */
const DATA = new Set([
  "A1", "Wettbewerb & Vorprojekt", "Parzelle 880 m² · zulässig", "Höhe 9.50 m ≤ 12.00 m",
  "Erdgeschoss", "Schnitt A", "Schnitt B", "3D · Erdgeschoss", "Pathtracing: n Samples · x/s", "Blatt n",
  "Plan x/n", "(fertig)", "Alt", "Nicht geprüft", "PDF", "DXF", "IFC", "Wettbewerb",
]);

/** Der Browser-Menüpunkt „Exportieren: DXF“ setzt sich aus „Exportieren“ und dem Format zusammen (`AppMenuBar`). */
const composedExport = (s: string) => /^Exportieren: [A-Z]+$/.test(s) && VALUES.has("Exportieren");
/** Namen der Standard-Ansichtsvorlagen und -Modelldarstellungen (Kern `standards.rs`). */
const standardName = (s: string) => standardsSrc.includes(`"name": "${s}"`);
const known = (s: string) => VALUES.has(s) || DATA.has(s) || composedExport(s) || standardName(s);

const isLabel = (s: string) => /[:.]$/.test(s);

function items(re: RegExp): string[] {
  return [...new Set([...doc.matchAll(re)].map((m) => m[1]!))];
}

describe("doc/KURZANLEITUNG.md passt zur App", () => {
  it("Menüpfade: jedes Glied steht in de.ts", () => {
    const paths = items(/(?<![*\w])\*([^*\n]+→[^*\n]+)\*(?!\*)/g);
    expect(paths.length).toBeGreaterThan(5);
    const bad = paths.flatMap((p) => p.split("→").map(strip)).filter((s) => !known(s));
    expect(bad).toEqual([]);
  });

  it("fette Bedienelemente und Anführungszeichen-Texte stehen in de.ts", () => {
    const texts = [...items(/\*\*([^*\n]+)\*\*/g), ...items(/„([^“\n]+)“/g)]
      .filter((s) => !isLabel(s))
      .map(strip);
    expect(texts.length).toBeGreaterThan(30);
    const bad = texts.filter((s) => !known(s));
    expect(bad).toEqual([]);
  });

  it("Befehle in Backticks gibt es in der Registry", () => {
    const cmds = items(/`([a-z0-9]+)`/g);
    expect(cmds).toEqual(expect.arrayContaining(["wand", "rf", "solidtoparts", "schnittlinie", "praesentation", "bild3d"]));
    const bad = cmds.filter((c) => !COMMANDS[c] && !ALIASES[c]);
    expect(bad).toEqual([]);
  });

  it("Tastenkürzel sind in SHORTCUT_DEFS oder im Menü belegt", () => {
    const norm = (combo: string) => combo.toLowerCase().replace(/cmdorctrl|cmd|ctrl/g, "mod");
    const combos = new Set<string>();
    for (const d of SHORTCUT_DEFS) combos.add(norm(d.defaultCombo));
    for (const m of menuSrc.matchAll(/accelerator:\s*"([^"]+)"/g)) combos.add(norm(m[1]!));
    const used = items(/(⇧?⌘[A-Za-z0-9])/g).map((k) => {
      const shift = k.startsWith("⇧");
      return `mod+${shift ? "shift+" : ""}${k.slice(-1).toLowerCase()}`;
    });
    expect(used.length).toBeGreaterThan(4);
    expect(used.filter((u) => !combos.has(u))).toEqual([]);
  });
});
