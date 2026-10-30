// setProject läuft über Ops (core/ops.ts, `opsMutation`): das Ergebnis muss dem gewünschten Projekt
// gleichen, ungültige Änderungen werden zurückgerollt, Ops werden protokolliert und sind JSON-fähig.
// Laden ([K4] S4): `loadProject`/`openProjectFile` ersetzen das Projekt im Kern und leeren den Verlauf.
import { describe, expect, it } from "vitest";
import { getState } from "./appStore";
import { emptyProject, sampleProject } from "../model/sampleProject";
import { addItems, opsMutation, patchItem, serializeProject } from "../core";

const st = () => getState();

describe("setProject über CoreOps", () => {
  it("Änderung kommt unverändert an, Op wird protokolliert (JSON-fähig), Undo stellt zurück", () => {
    st().loadProject(structuredClone(sampleProject));
    const before = st().project;
    const w = before.walls[0];
    const wanted = { ...before, walls: [{ ...w, height: (w.height ?? 2.6) + 1 }, ...before.walls.slice(1)] };
    st().setProject(opsMutation((p) => patchItem(p, "walls", w.id, { height: (w.height ?? 2.6) + 1 })));
    expect(st().project).toEqual(wanted);
    const ops = st().recentOps();
    expect(ops.length).toBeGreaterThan(0);
    expect(JSON.parse(JSON.stringify(ops.at(-1)))).toEqual(ops.at(-1));
    st().undo();
    // Undo kommt als inverse Ops aus dem Kern: inhaltlich gleich, unveränderte Elemente identisch.
    expect(st().project).toEqual(before);
    expect(st().project.walls[1]).toBe(before.walls[1]);
  });

  it("NaN-Änderung wird verworfen, Projekt bleibt, Undo-Stapel unverändert", () => {
    const before = st().project;
    const depth = st().undoDepth;
    st().setProject(opsMutation((p) => patchItem(p, "walls", p.walls[0].id, { height: NaN })));
    expect(st().project).toBe(before);
    expect(st().undoDepth).toBe(depth);
  });

  it("doppelte ids beim Einfügen werden verworfen", () => {
    const before = st().project;
    st().setProject(opsMutation((p) => addItems("walls", [{ ...p.walls[0] }])));
    expect(st().project).toBe(before);
  });
});

describe("Projekt laden ([K4] S4)", () => {
  it("loadProject: Projekt als Ganzes, Verlauf leer, Leseansicht = übergebenes Objekt", () => {
    st().loadProject(structuredClone(sampleProject));
    st().setProject(opsMutation((p) => patchItem(p, "walls", p.walls[0].id, { height: 9 })));
    expect(st().canUndo).toBe(true);
    const next = structuredClone(emptyProject);
    st().loadProject(next);
    expect(st().project).toBe(next);
    expect(st().undoDepth).toBe(0);
    st().undo();
    expect(st().project).toBe(next);
    // Kern-Dokument = Leseansicht (Speichern aus dem Kern).
    expect(JSON.parse(serializeProject(st().project))).toEqual({ ...next, formatVersion: 4 });
  });

  it("openProjectFile: Kern liest, migriert und lädt direkt; Verlauf leer; kaputte Datei ändert nichts", () => {
    st().loadProject(structuredClone(sampleProject));
    st().setProject(opsMutation((p) => patchItem(p, "walls", p.walls[0].id, { height: 9 })));
    const before = st().project;
    const bad = st().openProjectFile("{kaputt");
    expect(bad.ok).toBe(false);
    expect(st().project).toBe(before);
    expect(st().undoDepth).toBe(1);

    const doors = [{ id: "TX", hostWallId: sampleProject.walls[0].id, position: 0.5, width: 0.9, height: 2.1 }];
    const old = { ...structuredClone(sampleProject), formatVersion: 1, doors };
    const r = st().openProjectFile(JSON.stringify(old));
    expect(r.ok && r.migratedFrom).toBe(1);
    expect(st().undoDepth).toBe(0);
    expect(st().redoDepth).toBe(0);
    expect(st().project.formatVersion).toBe(4);
    expect(st().project.openings?.some((o) => o.id === "TX" && o.kind === "door")).toBe(true);
    expect("doors" in st().project).toBe(false);
    // Danach normal weiterarbeiten: ein Schritt, Undo zurück auf den geladenen Stand.
    const loaded = st().project;
    st().setProject(opsMutation((p) => patchItem(p, "walls", p.walls[0].id, { height: 7 })));
    st().undo();
    expect(st().project).toEqual(loaded);
    expect(serializeProject(st().project)).toBe(JSON.stringify({ formatVersion: 4, ...loaded }, null, 2));
  });
});
