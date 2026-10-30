// [9] Gemeinsame KI-Werkzeuge: Verteilung auf einen Host (App oder Datei) und Anmeldung der Brücke.
import { describe, expect, it } from "vitest";
import { callAiTool, type AiHost } from "./aiTools";
import { AI_TOOLS, hmacHex, randomHex, sameMac } from "./aiToolDefs";
import { applyOps, validateOps, type CoreOp } from "./ops";
import { sampleProject } from "../model/sampleProject";
import type { Project } from "../model/types";

/** Host im Speicher, merkt sich Commits (Beschriftung) und Auswahl. */
function fakeHost(withApp: boolean) {
  let project: Project = sampleProject;
  const labels: string[] = [];
  let selected: string[] = [];
  let zoomed: string[] = [];
  const host: AiHost = {
    project: () => project,
    commit: (ops: CoreOp[], label: string) => {
      const next = applyOps(project, ops);
      const problems = validateOps(next, ops, project);
      if (problems.length) return problems.join("; ");
      project = next;
      labels.push(label);
      return null;
    },
    ...(withApp
      ? {
          activeLevelId: () => sampleProject.drawingLevels.find((l) => l.kind === "floor")?.id,
          selection: () => ({ walls: selected }),
          select: (ids: string[]) => void (selected = ids),
          zoomTo: (ids: string[]) => ((zoomed = ids), true),
        }
      : {}),
  };
  return { host, labels, get: () => project, sel: () => selected, zoom: () => zoomed };
}

const textOf = (r: { content: { type: string; text?: string }[] }) => (r.content[0] as { text: string }).text;

describe("KI-Werkzeuge (gemeinsame Liste)", () => {
  it("Liste: eindeutige Namen, Schema je Werkzeug, Kennzeichen für App/Änderung", () => {
    const names = AI_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const n of ["project_info", "query", "render_svg", "apply_ops", "validate", "run_command", "select", "zoom_to", "export"]) expect(names).toContain(n);
    expect(AI_TOOLS.filter((t) => t.mutating).map((t) => t.name).sort()).toEqual(["apply_ops", "run_command"]);
  });

  it("project_info und query lesen das Projekt des Hosts", async () => {
    const { host } = fakeHost(false);
    const info = JSON.parse(textOf(await callAiTool(host, "project_info", {})));
    expect(info.counts.walls).toBe(sampleProject.walls.length);
    const w = sampleProject.walls[1];
    const q = JSON.parse(textOf(await callAiTool(host, "query", { collection: "walls", ids: [w.id] })));
    expect(q.map((e: { id: string }) => e.id)).toEqual([w.id]);
    expect((await callAiTool(host, "query", { collection: "gibtsnicht" })).isError).toBe(true);
  });

  it("run_command: Kern-Befehl mit JSON = ein Commit mit Beschriftung „KI: run_command“", async () => {
    const h = fakeHost(true);
    const before = h.get().walls.length;
    const r = await callAiTool(h.host, "run_command", { cmd: "wall", params: { pts: [[0, 0], [4, 0]] } });
    expect(r.isError).toBe(false);
    expect(h.get().walls.length).toBe(before + 1);
    expect(h.labels).toEqual(["KI: run_command"]);
    const added = h.get().walls.find((w) => !sampleProject.walls.some((o) => o.id === w.id))!;
    expect(added.floorId).toBe(h.host.activeLevelId!());
    expect(added.categoryCode).toBe(sampleProject.walls[0].categoryCode); // sichtbar wie in der Oberfläche
    expect(textOf(r)).toContain(added.id);
    // unbekannter Befehl → Fehler, kein Commit
    const bad = await callAiTool(h.host, "run_command", { cmd: "gibtsnicht" });
    expect(bad.isError).toBe(true);
    expect(h.labels.length).toBe(1);
  });

  it("apply_ops: abgelehnte Ops melden den Grund, das Projekt bleibt", async () => {
    const h = fakeHost(false);
    const w = sampleProject.walls[0];
    const bad = await callAiTool(h.host, "apply_ops", { ops: [{ kind: "add", collection: "walls", items: [{ ...w }] }] });
    expect(bad.isError).toBe(true);
    expect(h.get()).toBe(sampleProject);
    expect((await callAiTool(h.host, "apply_ops", { ops: "x" })).isError).toBe(true);
    const ok = await callAiTool(h.host, "apply_ops", { ops: [{ kind: "replace", collection: "walls", entity: { ...w, height: 7 } }] });
    expect(ok.isError).toBe(false);
    expect(h.labels).toEqual(["KI: apply_ops"]);
  });

  it("App-Werkzeuge: ohne App Fehler, mit App Auswahl/Zoom über den Host", async () => {
    const off = fakeHost(false);
    expect((await callAiTool(off.host, "select", { ids: ["a"] })).isError).toBe(true);
    const on = fakeHost(true);
    const id = sampleProject.walls[0].id;
    expect((await callAiTool(on.host, "select", { ids: [id] })).isError).toBe(false);
    expect(on.sel()).toEqual([id]);
    expect(JSON.parse(textOf(await callAiTool(on.host, "get_selection", {})))).toEqual({ walls: [id] });
    expect((await callAiTool(on.host, "zoom_to", { ids: [id] })).isError).toBe(false);
    expect(on.zoom()).toEqual([id]);
    expect((await callAiTool(on.host, "select", { ids: "x" })).isError).toBe(true);
  });

  it("Auswertungen und Export ohne Dateizugriff", async () => {
    const { host } = fakeHost(false);
    expect(JSON.parse(textOf(await callAiTool(host, "kennzahlen", {}))).kennzahlen).toBeTruthy();
    expect(Array.isArray(JSON.parse(textOf(await callAiTool(host, "schedule", { kind: "openings" }))))).toBe(true);
    expect(textOf(await callAiTool(host, "export", { format: "svg" }))).toContain("<svg");
    expect((await callAiTool(host, "export", { format: "pdf" })).isError).toBe(true); // PDF nur in der App
    expect((await callAiTool(host, "export", { format: "svg", save: true })).isError).toBe(true); // Speichern nur mit Dialog
    expect((await callAiTool(host, "gibtsnicht", {})).isError).toBe(true);
  });
});

describe("Brücken-Anmeldung", () => {
  it("HMAC ist deterministisch, schlüsselabhängig; Vergleich in konstanter Zeit", async () => {
    const tok = randomHex();
    expect(tok).toMatch(/^[0-9a-f]{32}$/);
    const a = await hmacHex(tok, "app:123");
    expect(a).toBe(await hmacHex(tok, "app:123"));
    expect(a).not.toBe(await hmacHex(tok, "bridge:123"));
    expect(a).not.toBe(await hmacHex(randomHex(), "app:123"));
    expect(sameMac(a, a)).toBe(true);
    expect(sameMac(a.slice(1), a)).toBe(false);
    expect(sameMac(undefined, a)).toBe(false);
  });
});
