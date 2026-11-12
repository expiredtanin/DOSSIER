// [195b] Sync-Brücke des nativen Fensters „Objekteinstellungen": Spiegelung (Projekt + Auswahl + Host-Werte)
// hin, Ops zurück. Hauptfenster und Nebenfenster teilen sich im Test denselben Store; die Rollen wechseln über
// den Abfluss (`setChangeSink`).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getState, setState } from "../state/appStore";
import { storeDocument } from "../state/historySlice";
import { ProjectDocument } from "../core/document";
import { buildBigSampleProject } from "../model/sampleProjectBig";
import { applyProjectDelta, projectDelta } from "./projectDelta";
import { setChangeSink } from "../state/changeSink";
import { selectionInfoFor } from "../state/useSelectionInfo";
import { buildComplexSampleProject } from "../model/sampleProjectComplex";
import { patchItem } from "../core/opsBuild";
import type { CoreOp } from "../core/ops";
import { EMPTY_SELECTION } from "../state/selection";
import {
  ObjectSettingsReceiver,
  ObjectSettingsSender,
  applyForwardedChange,
  hostSnapshot,
  mirrorIntoStore,
  objectSettingsSync,
  remoteHost,
  type ObjectSettingsSnapshot,
  type ObjectSettingsSync,
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
afterEach(() => {
  setChangeSink(null);
  for (const fn of cleanup.splice(0)) fn();
});
const cleanup: Array<() => void> = [];

/** Über IPC: JSON hin und zurück (neue Identität, `undefined` fällt weg). */
const wire = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/**
 * Hauptfenster (Store + Store-Dokument) und Nebenfenster (eigenes Kern-Dokument + Empfänger) über die
 * Nachrichten verbunden. `sync()` = ein gebündelter Sync wie `flush` im Hauptfenster; `lose()` verliert ihn.
 */
function link() {
  const sender = new ObjectSettingsSender();
  cleanup.push(storeDocument(st().project).onChange((b, a, ops) => sender.record(b, a, ops)));
  let winDoc: ProjectDocument | null = null;
  cleanup.push(() => winDoc?.close());
  const receiver = new ObjectSettingsReceiver((p) => (winDoc ??= new ProjectDocument(p)));
  const msgs: ObjectSettingsSync[] = [];
  const sync = (): ObjectSettingsSync | null => {
    const msg = sender.next(snapshot());
    if (!msg) return null;
    msgs.push(msg);
    if (receiver.receive(wire(msg)) === "resync") {
      // Fenster meldet „ready" erneut → ganzer Stand.
      sender.reset();
      return sync();
    }
    return msg;
  };
  const lose = () => sender.next(snapshot());
  /** Fenster gleicht dem Hauptfenster: Leseansicht und Kern-Dokument. */
  const expectSame = () => {
    expect(receiver.current!.project).toEqual(wire(st().project));
    expect(JSON.parse(winDoc!.json())).toEqual(JSON.parse(storeDocument(st().project).json()));
  };
  sync();
  return { sender, receiver, sync, lose, expectSame, msgs, doc: () => winDoc! };
}

describe("Sync-Nachrichten [195b]", () => {
  it("erst der ganze Stand, dann nur Auswahl-Patch bei Auswahlwechsel", () => {
    const sender = new ObjectSettingsSender();
    const first = sender.next(snapshot())!;
    expect("full" in first).toBe(true);
    expect(sender.next(snapshot())).toBeNull();

    const wall = st().project.walls[0].id;
    setState({ selection: { ...EMPTY_SELECTION, walls: [wall] } });
    const msg = sender.next(snapshot())!;
    expect(msg.seq).toBe(first.seq + 1);
    expect("project" in msg || "ops" in msg).toBe(false);
    expect("ui" in msg ? Object.keys(msg.ui!.set) : []).toEqual(["selection"]);

    // Fensterseite: aus ganzem Stand + Patch entsteht derselbe Stand.
    const receiver = new ObjectSettingsReceiver(storeDocument);
    receiver.receive(wire(first));
    const mirrored = receiver.receive(wire(msg));
    expect(mirrored !== "resync" && mirrored!.ui.selection.walls).toEqual([wall]);
  });

  it("Rückfall ohne Ops: Projekt als Feld-Differenz (nur die geänderten Felder)", () => {
    const a = snapshot();
    const w = st().project.walls[0];
    st().applyChange((p) => patchItem(p, "walls", w.id, { height: 2.333 }));
    const msg = objectSettingsSync(a, snapshot())!;
    const fields = "project" in msg ? Object.keys(msg.project!.set) : [];
    expect(fields).toContain("walls");
    expect(fields.length).toBeLessThan(4);
    expect("ui" in msg ? msg.ui : undefined).toBeUndefined();
  });

  it("Fokus-Anfrage (Taste T) geht als UI-Patch", () => {
    const a = snapshot();
    const msg = objectSettingsSync(a, snapshot({ seq: 1, group: "wall" }))!;
    expect("ui" in msg && msg.ui!.set.focus).toEqual({ seq: 1, group: "wall" });
  });
});

describe("Ops-Strom [195b]", () => {
  it("Änderung, Undo, Redo gehen als Ops; Fenster lädt nie neu und gleicht dem Hauptfenster", () => {
    const l = link();
    const w = st().project.walls[0];
    st().applyChange((p) => patchItem(p, "walls", w.id, { height: 2.333 }));
    const m1 = l.sync()!;
    expect("ops" in m1 && !("project" in m1)).toBe(true);
    l.expectSame();

    st().updateWall(w.id, { height: 2.4 });
    l.sync();
    st().undo();
    expect("ops" in l.sync()!).toBe(true);
    l.expectSame();
    st().undo();
    l.sync();
    expect(l.receiver.current!.project.walls.find((x) => x.id === w.id)!.height).toBe(w.height);
    st().redo();
    st().redo(); // zwei Schritte in einem Sync: Ops beider Schritte hintereinander
    expect("ops" in l.sync()!).toBe(true);
    l.expectSame();
    expect(l.receiver.fullLoads).toBe(0);
  });

  it("gruppierte Änderungen (ein Undo-Schritt, mehrere Commits) und deren Undo", () => {
    const l = link();
    const [a, b] = st().project.walls;
    st().groupChanges(() => {
      st().updateWall(a.id, { height: 2.61 });
      st().updateWall(b.id, { height: 2.62 });
      st().applyChange((p) => patchItem(p, "walls", a.id, { height: 2.63 }));
    });
    expect("ops" in l.sync()!).toBe(true);
    l.expectSame();
    st().undo();
    l.sync();
    l.expectSame();
    expect(l.receiver.current!.project.walls.find((x) => x.id === a.id)!.height).toBe(a.height);
    expect(l.receiver.fullLoads).toBe(0);
  });

  it("Lücke in der Folge → Fenster fordert den ganzen Stand an (Vollabgleich)", () => {
    const l = link();
    const w = st().project.walls[0];
    st().updateWall(w.id, { height: 2.71 });
    l.lose(); // Nachricht geht verloren
    st().updateWall(w.id, { height: 2.72 });
    const before = l.msgs.length;
    l.sync();
    expect(l.msgs.length).toBe(before + 2); // abgelehnte Differenz + ganzer Stand
    expect("full" in l.msgs[l.msgs.length - 1]).toBe(true);
    expect(l.receiver.fullLoads).toBe(1);
    l.expectSame();
    // danach wieder Ops
    st().updateWall(w.id, { height: 2.73 });
    expect("ops" in l.sync()!).toBe(true);
    l.expectSame();
  });

  it("vom Fenster abgelehnte Ops → ganzen Stand anfordern (einmal)", () => {
    const l = link();
    const w = st().project.walls[0];
    st().updateWall(w.id, { height: 2.81 });
    const msg = l.sender.next(snapshot())!;
    // Fenster-Dokument spiegelt einen anderen Stand (z. B. nach Neustart dort neu geladen): Ops passen nicht.
    l.doc().load(wire(l.receiver.current!.project));
    expect(l.receiver.receive(wire(msg))).toBe("resync");
    expect(l.receiver.receive(wire({ ...msg, seq: msg.seq + 1 }))).toBeNull(); // nur einmal anfordern
  });

  it("Projekt neu laden → Feld-Differenz mit Vollabgleich, danach wieder Ops", () => {
    const l = link();
    st().loadProject(buildComplexSampleProject());
    const msg = l.sync()!;
    expect("project" in msg && !("ops" in msg)).toBe(true);
    expect(l.receiver.fullLoads).toBe(1);
    l.expectSame();
    st().updateWall(st().project.walls[1].id, { height: 2.91 });
    expect("ops" in l.sync()!).toBe(true);
    expect(l.receiver.fullLoads).toBe(1);
    l.expectSame();
  });

  it("Messung grosses Projekt: Ops-Strom statt Neuladen", () => {
    st().loadProject(buildBigSampleProject());
    const l = link();
    const w = st().project.walls[42];
    const runs = 5;
    let tOps = 0;
    let tFull = 0;
    for (let i = 0; i < runs; i++) {
      const prev = l.receiver.current!.project;
      st().updateWall(w.id, { height: 2.5 + i / 100 });
      let t0 = performance.now();
      l.sync();
      tOps += performance.now() - t0;
      // Bisheriger Weg: Feld-Differenz über IPC + ganzes Projekt ins Kern-Dokument laden.
      const doc = new ProjectDocument(prev);
      t0 = performance.now();
      doc.load(applyProjectDelta(prev, wire(projectDelta(prev, st().project)!)));
      tFull += performance.now() - t0;
      doc.close();
    }
    l.expectSame();
    expect(l.receiver.fullLoads).toBe(0);
    console.info(
      `[195b] ${st().project.walls.length} Wände: Sync per Ops ${(tOps / runs).toFixed(2)} ms, bisher Vollabgleich ${(tFull / runs).toFixed(2)} ms`,
    );
    expect(tOps).toBeLessThan(tFull);
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
