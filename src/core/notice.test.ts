// [51] Herkunft übernommenen Codes: Jede Quelldatei, die im Kopf (erste 40 Zeilen) `Herkunft:` oder
// `Herkunft (…):` trägt, muss mit ihrem Pfad in `NOTICE` stehen — und jeder dort genannte Pfad unter src-tauri/ muss existieren.
// Neue Übernahme: Dateikopf mit `Herkunft:` (Projekt, URL, Lizenz, Copyright) UND NOTICE-Eintrag.
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(__dirname, "..", "..");
const SKIP = new Set(["node_modules", "target", "dist", "dist-cli", "dist-test", ".git", ".claude"]);
const EXT = /\.(rs|ts|tsx|mjs)$/;

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name) || name.startsWith("pkg")) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (EXT.test(name)) out.push(p);
  }
}

describe("NOTICE", () => {
  const notice = readFileSync(join(ROOT, "NOTICE"), "utf8");
  const files: string[] = [];
  walk(join(ROOT, "src"), files);
  walk(join(ROOT, "src-tauri"), files);

  it("nennt jede Datei mit Kopfzeile `Herkunft:`", () => {
    const missing: string[] = [];
    let marked = 0;
    for (const f of files) {
      if (f === __filename) continue;
      const head = readFileSync(f, "utf8").split("\n", 40).join("\n");
      if (!/Herkunft( \([^)]*\))?:/.test(head)) continue;
      marked++;
      const rel = relative(ROOT, f).split("\\").join("/");
      if (!notice.includes(rel)) missing.push(rel);
    }
    expect(marked).toBeGreaterThan(0);
    expect(missing, "Datei trägt `Herkunft:`, steht aber nicht in NOTICE").toEqual([]);
  });

  it("verweist nur auf vorhandene Quelldateien", () => {
    const paths = notice.match(/(?<![\w/.])src-tauri\/[\w./-]+\.(?:rs|tsx|ts)/g) ?? [];
    const gone = [...new Set(paths)].filter((p) => !existsSync(join(ROOT, p)));
    expect(gone).toEqual([]);
  });

  it("liefert zu jeder gebündelten Schrift eine OFL.txt", () => {
    const dir = join(ROOT, "public", "fonts");
    const bad = readdirSync(dir).filter((d) => statSync(join(dir, d)).isDirectory() && !existsSync(join(dir, d, "OFL.txt")));
    expect(bad).toEqual([]);
  });
});
