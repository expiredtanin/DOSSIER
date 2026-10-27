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
