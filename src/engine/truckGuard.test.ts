import { describe, expect, it, vi } from "vitest";

// `guarded` wird gegen ein Fake-WASM geprüft: Trap → neu instanziieren + einmal wiederholen.
vi.mock("./pkgTruck/trucksolid.js", () => {
  let instances = 0;
  return {
    default: async () => {
      instances++;
      (globalThis as { __instances?: number }).__instances = instances;
    },
  };
});

import { guarded } from "./truckSolid";

const instances = () => (globalThis as { __instances?: number }).__instances ?? 0;

describe("guarded (WASM-Wächter)", () => {
  it("normale Fehler laufen unveraendert durch, ohne Neustart", async () => {
    const before = instances();
    await expect(guarded(() => { throw new Error("Boolean fehlgeschlagen"); })).rejects.toThrow("Boolean fehlgeschlagen");
    expect(instances()).toBe(before || 1);
  });
  it("Trap: Instanz wird neu erzeugt, zweiter Versuch gelingt", async () => {
    let calls = 0;
    const r = await guarded(() => {
      if (calls++ === 0) throw new WebAssembly.RuntimeError("unreachable");
      return "ok";
    });
    expect(r).toBe("ok");
    expect(calls).toBe(2);
    expect(instances()).toBeGreaterThanOrEqual(2);
  });
  it("wiederholter Trap: klare Meldung statt rohem Trap", async () => {
    await expect(guarded(() => { throw new WebAssembly.RuntimeError("unreachable"); })).rejects.toThrow(/abgestürzt/);
  });
});
