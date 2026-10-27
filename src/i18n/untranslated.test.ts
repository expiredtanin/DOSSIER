// [50] Wächter gegen fest eingebaute UI-Texte: sichtbarer JSX-Text und Attribute (title,
// placeholder, aria-label, alt) ohne `t(...)`. Die Typen erzwingen schon, dass jeder `t("key")`
// in de UND en existiert (en ist `Record<TranslationKey,string>`); hier geht es um Texte, die
// gar nicht erst übersetzt werden. Bestehende Fundstellen stehen in `untranslated.baseline.json`
// (Ziel: leer); NEUE Fundstellen lassen den Test fehlschlagen.
//
// Aktualisieren der Baseline nach Aufräumen: UPDATE_I18N_BASELINE=1 npx vitest run src/i18n
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const SRC = join(process.cwd(), "src");
const BASELINE = join(SRC, "i18n", "untranslated.baseline.json");

function files(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) {
      if (/^pkg/.test(n)) continue;
      files(p, out);
    } else if (/\.tsx$/.test(n) && !/\.test\.tsx$/.test(n)) out.push(p);
  }
  return out;
}

// Buchstaben-Text zwischen Tags: >Text<  (ohne {…}-Ausdrücke, mindestens ein Wort mit 3+ Buchstaben)
const JSX_TEXT = />\s*([A-Za-zÄÖÜäöüß][^<>{}\n]*[A-Za-zÄÖÜäöüß.:!?])\s*</g;
const ATTR_TEXT = /\b(title|placeholder|aria-label|alt)="([^"{}]*[A-Za-zÄÖÜäöüß]{3,}[^"{}]*)"/g;

/** Zählt Fundstellen je Datei (Zeilennummern wandern bei Edits, Zählung nicht). */
function scan(): Record<string, string[]> {
  const found: Record<string, string[]> = {};
  for (const f of files(SRC)) {
    const rel = relative(SRC, f).split(sep).join("/");
    const text = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    const hits: string[] = [];
    for (const m of text.matchAll(JSX_TEXT)) {
      const s = m[1].trim();
      // Generics/Typ-Ausdrücke wie `Array<string>` und reine Platzhalter ausnehmen
      if (/^[a-z]+(\.[a-z]+)*$/.test(s) && !s.includes(" ")) continue;
      if (/=>|=|;|\(|\)/.test(s)) continue;
      if (!/[a-zäöüß]{3,}/i.test(s)) continue;
      hits.push(s);
    }
    for (const m of text.matchAll(ATTR_TEXT)) hits.push(`${m[1]}="${m[2]}"`);
    if (hits.length) found[rel] = hits.sort();
  }
  return found;
}

describe("UI-Texte ohne t()", () => {
  it("keine neuen fest eingebauten Texte gegenüber der Baseline", () => {
    const now = scan();
    if (process.env.UPDATE_I18N_BASELINE) {
      writeFileSync(BASELINE, JSON.stringify(now, null, 1) + "\n");
      return;
    }
    let base: Record<string, string[]> = {};
    try {
      base = JSON.parse(readFileSync(BASELINE, "utf8"));
    } catch {
      /* keine Baseline: alles ist neu */
    }
    const fresh: string[] = [];
    for (const [file, hits] of Object.entries(now)) {
      const allowed = [...(base[file] ?? [])];
      for (const h of hits) {
        const i = allowed.indexOf(h);
        if (i >= 0) allowed.splice(i, 1);
        else fresh.push(`${file}: ${h}`);
      }
    }
    expect(fresh).toEqual([]);
  });
});
