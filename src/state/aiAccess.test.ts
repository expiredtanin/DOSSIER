// [9] KI-Zugriff in der App: Aufrufe gegen den echten Store (ein Undo-Schritt „KI: …“, Protokoll,
// Pause, Auswahl, Zoom). Die Verbindung selbst prüft `cli/mcpBridge.test.ts`.
import { beforeEach, describe, expect, it } from "vitest";
import { getState, setState } from "./appStore";
import { sampleProject } from "../model/sampleProject";
import { getAiAccess, handleAiCall, setAiAccessEnabled, setAiPaused, setAiView } from "./aiAccess";

beforeEach(() => {
  setState({ project: sampleProject, activeLevelId: "eg", undoDepth: 0, redoDepth: 0, canUndo: false, canRedo: false });
  getState().clearHistory();
  getState().clearSelection();
  setAiPaused(false);
});

const text = (r: { content: { type: string }[] }) => (r.content[0] as unknown as { text: string }).text;

describe("KI-Zugriff (App-Host)", () => {
  it("aus per Vorgabe; Einschalten erzeugt einen Sitzungsschlüssel, der bleibt", () => {
    expect(getAiAccess().enabled).toBe(false);
    setAiAccessEnabled(true);
    const tok = getAiAccess().token;
    expect(tok).toMatch(/^[0-9a-f]{32}$/);
    setAiAccessEnabled(false);
    setAiAccessEnabled(true);
    expect(getAiAccess().token).toBe(tok);
    setAiAccessEnabled(false);
    expect(getAiAccess().status).toBe("off");
  });

  it("run_command = ein Undo-Schritt „KI: run_command“, im Protokoll als Änderung", async () => {
    const n = getState().project.walls.length;
    const r = await handleAiCall("run_command", { cmd: "wall", params: { pts: [[0, 0], [3, 0], [3, 3]] } });
    expect(r.isError).toBe(false);
    expect(getState().project.walls.length).toBe(n + 2);
    expect(getState().historyEntries().undo).toEqual(["KI: run_command"]);
    getState().undo();
    expect(getState().project.walls.length).toBe(n);
    const last = getAiAccess().log[0];
    expect(last).toMatchObject({ tool: "run_command", mutating: true, ok: true });
  });

  it("abgelehnte Ops: Fehler mit Grund, kein Schritt", async () => {
    const w = sampleProject.walls[0];
    const r = await handleAiCall("apply_ops", { ops: [{ kind: "add", collection: "walls", items: [{ ...w }] }] });
    expect(r.isError).toBe(true);
    expect(getState().historyEntries().undo).toEqual([]);
    expect(getAiAccess().log[0]).toMatchObject({ tool: "apply_ops", ok: false });
  });

  it("Pause: jeder Aufruf wird abgewiesen und protokolliert", async () => {
    setAiPaused(true);
    const r = await handleAiCall("project_info", {});
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("pausiert");
    expect(getAiAccess().log[0]).toMatchObject({ tool: "project_info", ok: false });
  });

  it("select, get_selection und zoom_to über Store und Planansicht", async () => {
    const wall = sampleProject.walls[0];
    const room = sampleProject.rooms![0];
    expect((await handleAiCall("select", { ids: [wall.id, room.id, "gibtsnicht"] })).isError).toBe(false);
    expect(getState().selectedWallIds).toEqual([wall.id]);
    expect(getState().selectedRoomIds).toEqual([room.id]);
    expect(JSON.parse(text(await handleAiCall("get_selection", {})))).toMatchObject({ walls: [wall.id], rooms: [room.id] });
    let fitted: { x: number; y: number }[] = [];
    setAiView({ fitBounds: (pts) => (fitted = pts) });
    expect((await handleAiCall("zoom_to", { ids: [wall.id] })).isError).toBe(false);
    await new Promise((r) => setTimeout(r, 5));
    expect(fitted.length).toBeGreaterThanOrEqual(2);
    expect(getState().activeLevelId).toBe(wall.floorId);
    expect((await handleAiCall("zoom_to", { ids: ["gibtsnicht"] })).isError).toBe(true);
    setAiView(null);
  });
});
