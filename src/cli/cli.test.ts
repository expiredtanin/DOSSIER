// dossier-cli (Phase C): importiert nur src/core, und die Befehle laufen headless gegen das
// Beispielprojekt (inkl. der echten WASM-Pakete aus src/engine/pkg*).
import { describe, expect, it, beforeAll } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "./main";
import { projectToModel3d, serializeProject } from "../core";
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
    for (const f of ["main.ts", "mcp.ts"]) {
      const text = readFileSync(join(process.cwd(), "src", "cli", f), "utf8");
      const rel = [...text.matchAll(/from\s+"(\.[^"]+)"/g)].map((m) => m[1]);
      expect(rel.every((r) => r === "../core" || r === "./mcp"), f).toBe(true);
    }
    expect(src.length).toBeGreaterThan(0);
    expect(readdirSync(join(process.cwd(), "src", "cli")).filter((f) => statSync(join(process.cwd(), "src", "cli", f)).isFile() && f.endsWith(".ts") && !f.endsWith(".test.ts")).sort()).toEqual(["main.ts", "mcp.ts"]);
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

  it("Plan als render2d-Szene (JSON)", async () => {
    const out = join(dir, "eg.scene.json");
    expect(await call("plan", "--format", "json", "--out", out)).toBe(0);
    const scene = JSON.parse(readFileSync(out, "utf8"));
    expect(scene.fills.length).toBeGreaterThan(0);
    expect(scene.fills[0].pts[0]).toHaveLength(2);
    expect(scene.fills[0].color).toHaveLength(4);
    expect(Array.isArray(scene.texts)).toBe(true);
  });

  it("Ansichtspaket (bundle) für die egui-Oberfläche", async () => {
    const out = join(dir, "demo.bundle.json");
    expect(await call("bundle", "--out", out)).toBe(0);
    const b = JSON.parse(readFileSync(out, "utf8"));
    expect(b.format).toBe("dossier-bundle");
    expect(b.version).toBe(1);
    expect(b.name).toBe(sampleProject.name);
    const floors = sampleProject.drawingLevels.filter((l) => l.kind === "floor");
    expect(b.levels.map((l: { id: string }) => l.id)).toEqual(floors.map((l) => l.id));
    const eg = b.levels[0];
    expect(eg.scene.fills.length).toBeGreaterThan(0);
    // 3D je Geschoss: zusammen ergeben die Geschosse das ganze Modell (Wand-Schichtbänder)
    expect(eg.model3d.walls.length).toBeGreaterThan(0);
    const sum = b.levels.reduce((s: number, l: { model3d: { walls: unknown[] } }) => s + l.model3d.walls.length, 0);
    expect(sum).toBe(projectToModel3d(sampleProject).walls.length);
    const wall = eg.elements.find((e: { kind: string }) => e.kind === "wall");
    expect(wall.shape.type).toBe("segment");
    expect(wall.shape.width).toBeGreaterThan(0);
    expect(wall.props.some(([k]: [string, unknown]) => k === "height")).toBe(true);
    const room = eg.elements.find((e: { kind: string }) => e.kind === "room");
    expect(room.shape.type).toBe("polygon");
    expect(b.kennzahlen.levels.length).toBe(floors.length);
    expect(b.raumprogramm).toBeDefined();
  });

  it("Beispielprojekt ohne Datei (:beispiel)", async () => {
    const out = join(dir, "beispiel.bundle.json");
    expect(await run([":beispiel", "bundle", "--out", out])).toBe(0);
    expect(JSON.parse(readFileSync(out, "utf8")).name).toBe(sampleProject.name);
  });

  it("IFC, OBJ, CSV, DXF", async () => {
    for (const [cmd, ext, needle] of [["ifc", "ifc", "ISO-10303-21"], ["obj", "obj", "v "], ["schedule", "csv", "Typ"], ["dxf", "dxf", "SECTION"]] as const) {
      const out = join(dir, `x.${ext}`);
      expect(await call(cmd, "--out", out)).toBe(0);
      expect(readFileSync(out, "utf8")).toContain(needle);
    }
  });

  it("DWG über das Format-WASM (acadrust, R2018)", async () => {
    const out = join(dir, "eg.dwg");
    expect(await call("dwg", "--level", "eg", "--out", out)).toBe(0);
    const bytes = readFileSync(out);
    expect(bytes.subarray(0, 6).toString("latin1")).toBe("AC1032");
    expect(bytes.length).toBeGreaterThan(10_000);
  }, 60_000);

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

import { handleMessage } from "./mcp";

describe("MCP-Server", () => {
  it("initialize, tools/list, project_info, apply_ops mit Validierung", async () => {
    const init = (await handleMessage(file, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} })) as { result: { serverInfo: { name: string } } };
    expect(init.result.serverInfo.name).toBe("dossier");
    const list = (await handleMessage(file, { jsonrpc: "2.0", id: 2, method: "tools/list" })) as { result: { tools: Array<{ name: string }> } };
    expect(list.result.tools.map((t) => t.name)).toEqual(["project_info", "query", "render_svg", "apply_ops", "validate"]);
    expect(await handleMessage(file, { jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();

    const call = async (name: string, args: Record<string, unknown>) =>
      ((await handleMessage(file, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name, arguments: args } })) as {
        result: { content: Array<{ text: string }>; isError: boolean };
      }).result;

    const info = await call("project_info", {});
    expect(JSON.parse(info.content[0].text).counts.walls).toBe(sampleProject.walls.length);

    const w = sampleProject.walls[0];
    // gültige Änderung → Datei geändert
    const ok = await call("apply_ops", { ops: [{ kind: "replace", collection: "walls", entity: { ...w, height: 9 } }] });
    expect(ok.isError).toBe(false);
    const q = await call("query", { collection: "walls", id: w.id });
    expect(JSON.parse(q.content[0].text)[0].height).toBe(9);
    // ungültig (NaN → JSON-null ist nicht NaN; Doppel-id wird geprüft) → abgelehnt, Datei unverändert
    const bad = await call("apply_ops", { ops: [{ kind: "add", collection: "walls", items: [{ ...w }] }] });
    expect(bad.isError).toBe(true);
    const q2 = await call("query", { collection: "walls", limit: 1000 });
    expect(JSON.parse(q2.content[0].text).length).toBe(sampleProject.walls.length);
    expect((await call("validate", {})).isError).toBe(false);
    expect((await call("render_svg", { kind: "floor" })).content[0].text).toContain("<svg");
    expect((await handleMessage(file, { jsonrpc: "2.0", id: 9, method: "gibts/nicht" })) as { error: { code: number } }).toMatchObject({ error: { code: -32601 } });
  }, 30_000);
});
