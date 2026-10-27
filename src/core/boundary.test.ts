// Wächter für die Kern/Hülle-Grenze (docs/core-ui-split.md, Phase A). Es gibt kein ESLint im
// Projekt — die Regeln laufen deshalb als Test über die Importzeilen aller Quelldateien.
//
//  1. Der KERN (model, geometry, plan, io, export, analysis, materials, text, engine) importiert
//     nie die HÜLLE (ui, panels, views, menus, editors, viewport, native, tools, state, commands,
//     App) und nie React/Zustand/Tauri statisch.
//  2. Die HÜLLE holt Funktionen aus `plan/` und `geometry/` nur über die Fassade `src/core`.
//     (`model/` — Typen und kleine Modell-Helfer — darf sie direkt importieren.)
//
// Ausnahmen stehen in den Listen unten; Ziel: leer.

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, relative, sep } from "node:path";

const SRC = join(process.cwd(), "src");
const CORE_DIRS = new Set(["core", "model", "geometry", "plan", "io", "export", "analysis", "materials", "text", "engine"]);
const SHELL_DIRS = new Set(["ui", "panels", "views", "menus", "editors", "viewport", "native", "tools", "state", "commands"]);
const FACADE_DIRS = new Set(["plan", "geometry"]);
const FORBIDDEN_PACKAGES = /^(react|react-dom|zustand|@tauri-apps\/.*)$/;

/** Kern-Dateien, die (noch) Hüllen-Verzeichnisse oder UI-Pakete importieren — Ziel: leer. */
const CORE_EXCEPTIONS: string[] = [];
/** Hüllen-Dateien, die `plan/`/`geometry/` direkt importieren — Ziel: leer. */
const SHELL_EXCEPTIONS: string[] = [];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

/** Oberstes Verzeichnis unter src/ ("App"/"main" für Dateien direkt darin). */
function top(file: string): string {
  const parts = relative(SRC, file).split(sep);
  return parts.length > 1 ? parts[0] : parts[0].replace(/\.tsx?$/, "");
}

interface Imp {
  spec: string;
  /** aufgelöst relativ zu src/, mit "/" (nur bei relativen Importen) */
  target: string | null;
}

const IMPORT_RE = /(?:import|export)\s+(?:type\s+)?(?:[^"';]*?\s+from\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

function importsOf(file: string): Imp[] {
  const src = readFileSync(file, "utf8");
  const out: Imp[] = [];
  for (const m of src.matchAll(IMPORT_RE)) {
    const spec = m[1] ?? m[2];
    if (!spec) continue;
    out.push({
      spec,
      target: spec.startsWith(".") ? normalize(join(dirname(file), spec)).slice(SRC.length + 1).split(sep).join("/") : null,
    });
  }
  return out;
}

const files = walk(SRC);

describe("Kern/Hülle-Grenze", () => {
  it("der Kern importiert keine Hülle und keine UI-Pakete", () => {
    const violations: string[] = [];
    for (const f of files) {
      const t = top(f);
      if (!CORE_DIRS.has(t)) continue;
      const rel = relative(SRC, f).split(sep).join("/");
      if (CORE_EXCEPTIONS.includes(rel)) continue;
      for (const i of importsOf(f)) {
        const tt = i.target?.split("/")[0];
        if (tt && (SHELL_DIRS.has(tt) || tt === "App" || tt === "main")) violations.push(`${rel} → ${i.target}`);
        if (!i.target && FORBIDDEN_PACKAGES.test(i.spec)) violations.push(`${rel} → ${i.spec}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("die Hülle holt plan/ und geometry/ nur über die Fassade src/core", () => {
    const violations: string[] = [];
    for (const f of files) {
      const t = top(f);
      if (!SHELL_DIRS.has(t) && t !== "App" && t !== "main") continue;
      const rel = relative(SRC, f).split(sep).join("/");
      if (SHELL_EXCEPTIONS.includes(rel)) continue;
      for (const i of importsOf(f)) {
        const tt = i.target?.split("/")[0];
        if (tt && FACADE_DIRS.has(tt)) violations.push(`${rel} → ${i.target}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("die Fassade zeigt nur auf plan/ und geometry/ und importiert keine Hülle", () => {
    const f = join(SRC, "core", "index.ts");
    for (const i of importsOf(f)) {
      const tt = i.target?.split("/")[0];
      expect(tt === undefined || FACADE_DIRS.has(tt)).toBe(true);
    }
  });
});
