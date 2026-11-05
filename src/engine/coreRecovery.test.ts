// [118] Wiederanlauf nach Kern-Panic: der versteckte Test-Export `__debug_panic` (web/document.rs)
// panict mitten in einem Dokument-Zugriff — danach wäre die alte Instanz tot (geborgte RefCell).
// Geprüft: `core()` startet (asynchron) neu, die Dokumente öffnen sich aus der Leseansicht samt Verlauf (TS-Kopie,
// `core/historyBackup.ts`), der Store behält das Projekt, Undo/Redo laufen wie vorher, der Vorgang wird nicht wiederholt.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { core, coreEpoch, coreReady, CoreRestartingError, CoreTrapError, isCoreTrap, onCoreRestart } from "./coreWasm";
import * as raw from "./pkgCore/core.js";
import { getState } from "../state/appStore";
import { storeDocument } from "../state/historySlice";
import { sampleProject } from "../model/sampleProject";
import { patchItem } from "../core/opsBuild";
import { documentFor, ProjectDocument } from "../core/document";
import { HistoryBackup } from "../core/historyBackup";
import type { Project } from "../model/types";

const st = () => getState();

/** Kern-Dokument == TS-Leseansicht (JSON). */
function expectMirror(): void {
  const p = st().project;
  expect(JSON.parse(storeDocument(p).json())).toEqual(JSON.parse(JSON.stringify(p)));
}

beforeEach(() => {
  st().loadProject(structuredClone(sampleProject));
  st().clearHistory();
});

describe("Kern-Neustart nach Panic ([118])", () => {
  it("Trap → CoreTrapError, Dokument aus der Leseansicht neu geöffnet, Abfragen laufen weiter", async () => {
    const doc = new ProjectDocument(structuredClone(sampleProject) as Project);
    const before = doc.query<unknown>("kennzahlen");
    const text = doc.serialize();
    const epoch = coreEpoch();
    const seen = vi.fn();
    const off = onCoreRestart(seen);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    let thrown: unknown;
    try {
      core().__debug_panic(doc.id);
    } catch (e) {
      thrown = e;
    }
    // Neustart asynchron (Chromium: kein synchrones Instanziieren > 8 MB): bis dahin wirft `core()`.
    expect(() => core()).toThrow(CoreRestartingError);
    expect(() => doc.serialize()).toThrow(CoreRestartingError);
    expect(seen).not.toHaveBeenCalled();
    await coreReady();
    off();
    err.mockRestore();
    expect(thrown).toBeInstanceOf(CoreTrapError);
    expect((thrown as CoreTrapError).fn).toBe("__debug_panic");
    expect(coreEpoch()).toBe(epoch + 1);
    expect(seen).toHaveBeenCalledTimes(1); // einmal gemeldet, kein Wiederholen
    expect(doc.id).toBeGreaterThan(0);
    expect(doc.serialize()).toBe(text);
    expect(doc.query<unknown>("kennzahlen")).toEqual(before);
    // Ohne Neustart wäre die Tabelle geborgt: jeder Dokument-Zugriff träfe wieder auf einen Trap.
    expect(raw.doc_serialize(doc.id)).toBe(text);
    doc.close();
  });

  it("Panic während einer Store-Änderung: Projekt unverändert, Verlauf wiederhergestellt, Undo/Redo wie vorher", async () => {
    const [w0, w1] = st().project.walls;
    const h0 = w0.height;
    st().applyChange((p) => patchItem(p, "walls", w0.id, { height: 3.1 }));
    // Koaleszenz (Tippen) und Gruppe: je ein Schritt.
    st().applyChange((p) => patchItem(p, "walls", w1.id, { height: 2.5 }), "tippen");
    st().applyChange((p) => patchItem(p, "walls", w1.id, { height: 2.6 }), "tippen");
    st().groupChanges(() => {
      st().applyChange((p) => patchItem(p, "walls", w0.id, { loadBearing: true }));
      st().applyChange((p) => patchItem(p, "walls", w1.id, { loadBearing: true }));
    });
    st().applyChange((p) => patchItem(p, "walls", w0.id, { height: 3.3 }));
    st().undo(); // ein Redo-Schritt liegt bereit
    expect([st().undoDepth, st().redoDepth]).toEqual([3, 1]);
    const states = [st().project];
    const before = st().project;
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() =>
      st().applyChange((p) => {
        core().__debug_panic(storeDocument(p).id);
        return patchItem(p, "walls", w0.id, { height: 9 });
      }),
    ).toThrow(CoreTrapError);
    await coreReady();
    err.mockRestore();
    expect(st().project).toBe(before);
    expect(st().project.walls[0].height).toBe(3.1);
    expectMirror();
    // Verlauf wiederhergestellt (ohne die abgebrochene Änderung): gleiche Tiefen, Undo/Redo wie vorher.
    const doc = storeDocument(st().project);
    expect(doc.historyKept).toBe(true);
    expect(doc.historyState()).toMatchObject({ undo: 3, redo: 1 });
    st().redo();
    expect(st().project.walls[0].height).toBe(3.3);
    expectMirror();
    st().undo();
    for (const expected of [
      { h0: 3.1, h1: 2.6, t0: w0.loadBearing, t1: w1.loadBearing }, // Gruppe zurück
      { h0: 3.1, h1: w1.height, t0: w0.loadBearing, t1: w1.loadBearing }, // Tipp-Serie zurück
      { h0, h1: w1.height, t0: w0.loadBearing, t1: w1.loadBearing }, // erste Änderung zurück
    ]) {
      st().undo();
      const [a, b] = st().project.walls;
      expect({ h0: a.height, h1: b.height, t0: a.loadBearing, t1: b.loadBearing }).toEqual(expected);
      expectMirror();
    }
    expect(st().canUndo).toBe(false);
    st().redo();
    st().redo();
    st().redo();
    expect(st().project.walls[0].loadBearing).toBe(true);
    expect(JSON.parse(storeDocument(st().project).json())).toEqual(JSON.parse(JSON.stringify(states[0])));
    // Neue Änderungen nach dem Neustart: eigener Undo-Schritt.
    st().applyChange((p) => patchItem(p, "walls", w0.id, { height: 3.4 }));
    expect(st().project.walls[0].height).toBe(3.4);
    st().undo();
    expect(st().project.walls[0].height).toBe(3.1);
    expectMirror();
    // Abfragen über das gemeinsame Dokument laufen (Plan, Kennzahlen).
    expect(() => documentFor(st().project).query("kennzahlen")).not.toThrow();
  });

  it("Verlaufskopie nur für die Leseansicht, zu der sie gehört", () => {
    const doc = new ProjectDocument(structuredClone(sampleProject) as Project);
    const id = doc.current.walls[0].id;
    const r = doc.commit(doc.current, patchItem(doc.current, "walls", id, { height: 2.9 }), undefined, 0);
    expect("project" in r).toBe(true);
    const backup = new HistoryBackup();
    backup.sync(doc.id, doc.current);
    const other = new ProjectDocument(structuredClone(sampleProject) as Project);
    expect(backup.restore(other.id, other.current)).toBe(false);
    expect(other.historyState().undo).toBe(0);
    backup.sync(doc.id, doc.current);
    const fresh = new ProjectDocument(doc.current);
    expect(backup.restore(fresh.id, fresh.current)).toBe(true);
    expect(fresh.historyState().undo).toBe(1);
    expect(fresh.undo(fresh.current)?.walls[0].height).toBe(sampleProject.walls[0].height);
    for (const d of [doc, other, fresh]) d.close();
  });

  it("isCoreTrap: Trap ja, gewöhnlicher Fehler nein", () => {
    expect(isCoreTrap(new WebAssembly.RuntimeError("unreachable"))).toBe(true);
    expect(isCoreTrap(new Error("Kern-Abfrage: Dokument nicht offen"))).toBe(false);
  });
});
