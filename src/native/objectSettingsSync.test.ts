// [195b] Sync-Brücke des nativen Fensters „Objekteinstellungen": Spiegelung (Projekt + Auswahl + Host-Werte)
// hin, Ops zurück. Hauptfenster und Nebenfenster teilen sich im Test denselben Store; die Rollen wechseln über
// den Abfluss (`setChangeSink`).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getState, setState } from "../state/appStore";
import { setChangeSink } from "../state/changeSink";
import { selectionInfoFor } from "../state/useSelectionInfo";
import { buildComplexSampleProject } from "../model/sampleProjectComplex";
import { patchItem } from "../core/opsBuild";
import type { CoreOp } from "../core/ops";
import { EMPTY_SELECTION } from "../state/selection";
import {
  applyObjectSettingsSync,
  applyForwardedChange,
  hostSnapshot,
  mirrorIntoStore,
  objectSettingsSync,
  remoteHost,
  type ObjectSettingsSnapshot,
} from "./objectSettingsSync";

const st = () => getState();

/** Stand, wie ihn das Hauptfenster sendet. */
function snapshot(focus: ObjectSettingsSnapshot["ui"]["focus"] = null): ObjectSettingsSnapshot {
  const s = st();
  return {
    project: s.project,
    ui: { selection: s.selection, activeLevelId: s.activeLevelId, ...hostSnapshot({ activeTool: "select", onSetWallType: () => {} }), focus },
  };
}

beforeEach(() => {
  st().loadProject(buildComplexSampleProject());
  setState({ selection: EMPTY_SELECTION });
});
afterEach(() => setChangeSink(null));

describe("Sync-Nachrichten [195b]", () => {
  it("erst der ganze Stand, dann nur Auswahl-Patch bei Auswahlwechsel", () => {
    const a = snapshot();
    const first = objectSettingsSync(null, a);
    expect(first && "full" in first).toBe(true);
    expect(objectSettingsSync(a, snapshot())).toBeNull();

    const wall = st().project.walls[0].id;
    setState({ selection: { ...EMPTY_SELECTION, walls: [wall] } });
    const b = snapshot();
    const msg = objectSettingsSync(a, b);
    expect(msg).not.toBeNull();
    expect(msg && "project" in msg ? msg.project : undefined).toBeUndefined();
    expect(msg && "ui" in msg ? Object.keys(msg.ui!.set) : []).toEqual(["selection"]);

    // Fensterseite: aus ganzem Stand + Patch entsteht derselbe Stand.
    const mirrored = applyObjectSettingsSync(applyObjectSettingsSync(null, first!), JSON.parse(JSON.stringify(msg)));
    expect(mirrored!.ui.selection.walls).toEqual([wall]);
  });

  it("Projektänderung schickt nur die geänderten Felder; Undo ebenso", () => {
    const a = snapshot();
    const w = st().project.walls[0];
    st().applyChange((p) => patchItem(p, "walls", w.id, { height: 2.333 }));
    const b = snapshot();
    const msg = objectSettingsSync(a, b)!;
    // Wände und davon abhängige Felder (z. B. angehängte Masse), nicht das ganze Projekt.
    const fields = "project" in msg ? Object.keys(msg.project!.set) : [];
    expect(fields).toContain("walls");
    expect(fields.length).toBeLessThan(4);
    expect("ui" in msg ? msg.ui : undefined).toBeUndefined();

    st().undo();
    const c = snapshot();
    const back = objectSettingsSync(b, c)!;
    expect("project" in back ? Object.keys(back.project!.set) : []).toContain("walls");
    const mirrored = applyObjectSettingsSync(b, JSON.parse(JSON.stringify(back)))!;
    expect(mirrored.project.walls.find((x) => x.id === w.id)!.height).toBe(w.height);
  });

  it("Fokus-Anfrage (Taste T) geht als UI-Patch", () => {
    const a = snapshot();
    const msg = objectSettingsSync(a, snapshot({ seq: 1, group: "wall" }))!;
    expect("ui" in msg && msg.ui!.set.focus).toEqual({ seq: 1, group: "wall" });
  });
});

describe("Spiegel im Nebenfenster [195b]", () => {
  it("Spiegel trägt Projekt, Auswahl und Kern-Dokument (Objekt-Info rechnet darauf)", () => {
    const wall = st().project.walls[0].id;
    const snap = { ...snapshot(), ui: { ...snapshot().ui, selection: { ...EMPTY_SELECTION, walls: [wall] } } };
    const copy = JSON.parse(JSON.stringify(snap)) as ObjectSettingsSnapshot; // über IPC: neue Identität
    mirrorIntoStore(null, copy);
    expect(st().project).toBe(copy.project);
    expect(selectionInfoFor(st().project, st().selection)?.kind).toBe("wall");
  });

  it("mit Abfluss: Änderung wird nicht lokal angewendet, sondern als Ops abgegeben; Hauptfenster wendet sie mit Undo an", () => {
    const w = st().project.walls[0];
    const before = st().project;
    const sent: Array<[readonly CoreOp[], string | undefined]> = [];
    setChangeSink((ops, key) => sent.push([ops, key]));

    st().applyChange((p) => patchItem(p, "walls", w.id, { height: 2.271 }), "wall-height");
    st().updateWall(w.id, { height: 2.272 });
    expect(st().project).toBe(before);
    expect(sent.length).toBe(2);
    expect(sent[0][1]).toBe("wall-height");

    // Hauptfenster: ohne Abfluss, Ops kommen über JSON.
    setChangeSink(null);
    const depth = st().undoDepth;
    for (const [ops, key] of JSON.parse(JSON.stringify(sent)) as Array<[CoreOp[], string | null]>) applyForwardedChange(ops, key);
    expect(st().project.walls.find((x) => x.id === w.id)!.height).toBe(2.272);
    expect(st().undoDepth).toBe(depth + 2);
    st().undo();
    expect(st().project.walls.find((x) => x.id === w.id)!.height).toBe(2.271);
  });
});

describe("Host im Nebenfenster [195b]", () => {
  it("Wert-Felder gespiegelt, Handler ans Hauptfenster weitergeleitet, fehlende Handler fehlen", () => {
    const snap = hostSnapshot({ activeTool: "wall", sectionLine: null, onSetWallType: () => {}, displayMode: { mode: "all", setMode: () => {} } });
    expect(snap.handlers).toEqual(["onSetWallType"]);
    expect(snap.host).toEqual({ activeTool: "wall", sectionLine: null });
    const calls: Array<[string, unknown[]]> = [];
    const host = remoteHost(snap, (name, args) => calls.push([name, args])) as unknown as Record<string, unknown>;
    expect(host.activeTool).toBe("wall");
    expect(host.measurement).toBeNull();
    expect(host.onSetStairType).toBeUndefined();
    (host.onSetWallType as (id: string) => void)("wt-1");
    expect(calls).toEqual([["onSetWallType", ["wt-1"]]]);
  });
});
