// dossier-cli (Phase C): importiert nur src/core, und die Befehle laufen headless gegen das
// Beispielprojekt (inkl. der echten WASM-Pakete aus src/engine/pkg*).
import { describe, expect, it, beforeAll } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "./main";
import { serializeProject } from "../core";
import { sampleProject } from "../model/sampleProject";

const dir = mkdtempSync(join(tmpdir(), "dossier-cli-"));
const file = join(dir, "demo.obp");

beforeAll(() => {
  process.env.DOSSIER_WASM_DIR = join(process.cwd(), "src", "engine");
  writeFileSync(file, serializeProject(sampleProject));
});

const call = async (...a: string[]) => run([file, ...a]);

describe("dossier-cli", () => {
  it("importiert ausschliesslich ../core", () => {
    const src = readFileSync(join(process.cwd(), "src", "cli", "main.ts"), "utf8");
    const rel = [...src.matchAll(/from\s+"(\.[^"]+)"/g)].map((m) => m[1]);
    expect(rel.every((r) => r === "../core")).toBe(true);
    expect(readdirSync(join(process.cwd(), "src", "cli")).filter((f) => statSync(join(process.cwd(), "src", "cli", f)).isFile() && f.endsWith(".ts") && !f.endsWith(".test.ts"))).toEqual(["main.ts"]);
  });

  it("info, validate, migrate", async () => {
    expect(await call("info")).toBe(0);
    expect(await call("validate")).toBe(0);
    const out = join(dir, "migriert.obp");
    expect(await call("migrate", "--out", out)).toBe(0);
    expect(JSON.parse(readFileSync(out, "utf8")).formatVersion).toBeGreaterThanOrEqual(1);
  });

  it("Plan als SVG", async () => {
    const out = join(dir, "eg.svg");
    expect(await call("plan", "--out", out)).toBe(0);
    const svg = readFileSync(out, "utf8");
    expect(svg).toMatch(/^<\?xml/);
    expect(svg).toContain("<polygon");
    expect(svg).toContain("</svg>");
  });

  it("IFC, OBJ, CSV, DXF", async () => {
    for (const [cmd, ext, needle] of [["ifc", "ifc", "ISO-10303-21"], ["obj", "obj", "v "], ["schedule", "csv", "Typ"], ["dxf", "dxf", "SECTION"]] as const) {
      const out = join(dir, `x.${ext}`);
      expect(await call(cmd, "--out", out)).toBe(0);
      expect(readFileSync(out, "utf8")).toContain(needle);
    }
  });

  it("Schnitt und STEP über das WASM", async () => {
    const section = sampleProject.drawingLevels.find((l) => l.kind === "section");
    if (section) {
      const out = join(dir, "s.svg");
      expect(await call("section", section.name, "--out", out)).toBe(0);
      expect(readFileSync(out, "utf8")).toContain("<svg");
    }
    const stp = join(dir, "k.stp");
    expect(await call("step", "--out", stp)).toBe(0);
    expect(readFileSync(stp, "utf8").startsWith("ISO-10303-21;")).toBe(true);
  }, 60_000);

  it("unbekannter Befehl und fehlende Datei geben Fehlercode", async () => {
    expect(await call("gibtsnicht")).toBe(2);
    expect(await run([])).toBe(2);
  });
});
