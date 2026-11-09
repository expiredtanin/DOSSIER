// [121] Sync-Brücke der Nebenfenster: nur inhaltlich geänderte Felder gehen als Patch über IPC.
import { describe, expect, it } from "vitest";
import { applyStateDelta, stateDelta } from "./windowBridge";

describe("stateDelta", () => {
  it("inhaltlich gleicher, neu abgeleiteter Zustand: nichts senden", () => {
    const a = { levels: [{ id: "eg", name: "EG" }], active: "eg" };
    const b = { levels: [{ id: "eg", name: "EG" }], active: "eg" };
    expect(stateDelta(a, b)).toBeNull();
  });

  it("nur geänderte Felder im Patch", () => {
    const a = { levels: [{ id: "eg", name: "EG" }], active: "eg", mode: "all" };
    const b = { levels: [{ id: "eg", name: "EG" }], active: "og", mode: "all" };
    expect(stateDelta(a, b)).toEqual({ set: { active: "og" }, unset: [] });
  });

  it("auf undefined gesetzte Felder als entfernt", () => {
    const a = { hatchId: "h1", name: "A" };
    const b = { hatchId: undefined, name: "A" };
    expect(stateDelta(a, b)).toEqual({ set: {}, unset: ["hatchId"] });
  });

  it("kein Objekt (null): ganz senden, ausser beide gleich", () => {
    expect(stateDelta(null, { a: 1 })).toBe("full");
    expect(stateDelta({ a: 1 }, null)).toBe("full");
    expect(stateDelta(null, null)).toBeNull();
  });

  it("Patch angewendet ergibt den neuen Zustand", () => {
    const a = { hatchId: "h1", name: "A", lw: 0.25 };
    const b = { name: "B", lw: 0.25, color: "#f00" };
    const d = stateDelta(a, b);
    expect(d).not.toBeNull();
    expect(d).not.toBe("full");
    const merged = applyStateDelta(a, d as Exclude<typeof d, null | "full">);
    expect(merged).toEqual(b);
    expect(a).toEqual({ hatchId: "h1", name: "A", lw: 0.25 });
  });
});
