import { describe, expect, it } from "vitest";
import type { Project } from "../model/types";
import { applyProjectDelta, projectDelta } from "./projectDelta";

const base = {
  id: "p",
  name: "Demo",
  walls: [{ id: "w1" }],
  hatches: [{ id: "h1" }],
  rooms: [],
} as unknown as Project;

describe("projectDelta", () => {
  it("ohne Änderung: null", () => {
    expect(projectDelta(base, { ...base })).toBeNull();
  });

  it("nur geänderte Felder (Referenz), zusammengesetzt gleich dem neuen Stand", () => {
    const next = { ...base, walls: [{ id: "w1" }, { id: "w2" }] } as unknown as Project;
    const d = projectDelta(base, next)!;
    expect(Object.keys(d.set)).toEqual(["walls"]);
    expect(d.unset).toEqual([]);
    expect(applyProjectDelta(base, d)).toEqual(next);
  });

  it("neue und entfernte Felder", () => {
    const next = { ...base, projectNumber: "42" } as Record<string, unknown>;
    delete next.rooms;
    const d = projectDelta(base, next as unknown as Project)!;
    expect(d.set).toEqual({ projectNumber: "42" });
    expect(d.unset).toEqual(["rooms"]);
    const out = applyProjectDelta(base, d) as unknown as Record<string, unknown>;
    expect(out).toEqual(next);
    expect("rooms" in out).toBe(false);
    // Die Basis bleibt unverändert.
    expect((base as unknown as Record<string, unknown>).rooms).toEqual([]);
  });

  it("überlebt die JSON-Serialisierung der Brücke (undefined-Feld → entfernt)", () => {
    const next = { ...base, name: "Neu", projectNumber: undefined } as unknown as Project;
    const d = projectDelta(base, next)!;
    const wire = JSON.parse(JSON.stringify(d));
    expect(applyProjectDelta(base, wire)).toEqual(JSON.parse(JSON.stringify(next)));
  });

  it("auf undefined gesetztes Feld wird entfernt", () => {
    const withNumber = { ...base, projectNumber: "1" } as unknown as Project;
    const next = { ...withNumber, projectNumber: undefined } as unknown as Project;
    const d = projectDelta(withNumber, next)!;
    expect(d.unset).toEqual(["projectNumber"]);
    const wire = JSON.parse(JSON.stringify(d));
    expect("projectNumber" in applyProjectDelta(withNumber, wire)).toBe(false);
  });
});
