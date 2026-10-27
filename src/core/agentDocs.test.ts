// [53] Die CLAUDE.md bleibt kurz (BIMCraft: 3000 Wörter) und ihre Modulkarte zeigt auf Orte, die es gibt.
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const text = readFileSync(join(process.cwd(), "CLAUDE.md"), "utf8");

describe("CLAUDE.md", () => {
  it("höchstens 3000 Wörter", () => {
    expect(text.split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(3000);
  });
  it("genannte Pfade und npm-Skripte existieren", () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
    for (const m of text.matchAll(/`((?:src|scripts|src-tauri)\/[A-Za-z0-9_./-]+?)`/g)) {
      const p = m[1].replace(/\/$/, "");
      if (/[*…]/.test(p) || p.includes(" ")) continue;
      expect(existsSync(join(process.cwd(), p)), `Pfad fehlt: ${p}`).toBe(true);
    }
    for (const m of text.matchAll(/npm run ([a-z0-9:]+)/g)) {
      expect(pkg.scripts[m[1]], `npm-Skript fehlt: ${m[1]}`).toBeTruthy();
    }
  });
});
