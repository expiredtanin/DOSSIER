// [118] Wiederanlauf nach Kern-Panic: der versteckte Test-Export `__debug_panic` (web/document.rs)
// panict mitten in einem Dokument-Zugriff — danach wäre die alte Instanz tot (geborgte RefCell).
// Geprüft: `core()` startet (asynchron) neu, die Dokumente öffnen sich aus der Leseansicht, der Store behält
// das Projekt, weitere Abfragen/Änderungen/Undo laufen, der Vorgang wird nicht wiederholt.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { core, coreEpoch, coreReady, CoreRestartingError, CoreTrapError, isCoreTrap, onCoreRestart } from "./coreWasm";
import * as raw from "./pkgCore/core.js";
import { getState } from "../state/appStore";
import { storeDocument } from "../state/historySlice";
import { sampleProject } from "../model/sampleProject";
import { patchItem } from "../core/opsBuild";
import { documentFor, ProjectDocument } from "../core/document";
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

  it("Panic während einer Store-Änderung: Projekt unverändert, Verlauf leer, danach Änderung + Undo", async () => {
    const id = st().project.walls[0].id;
    st().applyChange((p) => patchItem(p, "walls", id, { height: 3.1 }));
    expect(st().undoDepth).toBe(1);
    const before = st().project;
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() =>
      st().applyChange((p) => {
        core().__debug_panic(storeDocument(p).id);
        return patchItem(p, "walls", id, { height: 9 });
      }),
    ).toThrow(CoreTrapError);
    await coreReady();
    err.mockRestore();
    expect(st().project).toBe(before);
    expect(st().project.walls[0].height).toBe(3.1);
    expectMirror();
    // Verlauf nach dem Neustart leer (nicht wiederhergestellt); neue Änderungen haben wieder Undo.
    expect(storeDocument(st().project).historyState().undo).toBe(0);
    st().applyChange((p) => patchItem(p, "walls", id, { height: 3.4 }));
    expect(st().project.walls[0].height).toBe(3.4);
    st().undo();
    expect(st().project.walls[0].height).toBe(3.1);
    expectMirror();
    // Abfragen über das gemeinsame Dokument laufen (Plan, Kennzahlen).
    expect(() => documentFor(st().project).query("kennzahlen")).not.toThrow();
  });

  it("isCoreTrap: Trap ja, gewöhnlicher Fehler nein", () => {
    expect(isCoreTrap(new WebAssembly.RuntimeError("unreachable"))).toBe(true);
    expect(isCoreTrap(new Error("Kern-Abfrage: Dokument nicht offen"))).toBe(false);
  });
});
