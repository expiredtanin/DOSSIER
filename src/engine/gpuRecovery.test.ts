// [206]/[118] Budget und Backoff beim WebGPU-Geräteverlust, Schutzhülle um gesperrte wasm-bindgen-Objekte.
import { describe, expect, it } from "vitest";
import { GpuRecovery, guardRenderer, isRendererAbort } from "./gpuRecovery";

describe("GpuRecovery", () => {
  it("baut mit wachsender Wartezeit neu auf und gibt nach dem Budget auf", () => {
    const r = new GpuRecovery({ maxLosses: 3, baseDelayMs: 500, factor: 4, now: () => 0 });
    expect([r.noteLoss(), r.noteLoss(), r.noteLoss()]).toEqual([500, 2000, 8000]);
    expect(r.disabled).toBe(false);
    expect(r.noteLoss()).toBeNull();
    expect(r.disabled).toBe(true);
    expect(r.noteLoss()).toBeNull();
  });

  it("vereinzelte Verluste (ausserhalb des Zeitfensters) werden immer wieder behoben, ohne Backoff-Aufbau", () => {
    let t = 0;
    const r = new GpuRecovery({ maxLosses: 1, windowMs: 1000, baseDelayMs: 500, now: () => t });
    for (let k = 0; k < 5; k++) {
      t += 5000;
      expect(r.noteLoss()).toBe(500);
    }
    expect(r.disabled).toBe(false);
  });
});

describe("guardRenderer", () => {
  class Fake {
    calls = 0;
    poisoned = false;
    work(mode: "ok" | "err" | "panic"): number {
      if (this.poisoned) throw new Error("recursive use of an object detected which would lead to unsafe aliasing in rust");
      this.calls++;
      if (mode === "err") throw "Modell parsen: kaputt"; // Rust Result::Err
      if (mode === "panic") {
        this.poisoned = true;
        throw new WebAssembly.RuntimeError("unreachable");
      }
      return this.calls;
    }
  }

  it("Result::Err (Zeichenkette) wird weitergereicht, das Objekt bleibt nutzbar", () => {
    const aborts: unknown[] = [];
    const g = guardRenderer(new Fake(), (e) => aborts.push(e));
    expect(() => g.renderer.work("err")).toThrow();
    expect(g.renderer.work("ok")).toBe(2);
    expect(aborts).toEqual([]);
    expect(isRendererAbort("x")).toBe(false);
  });

  it("nach einem Abbruch (Panic) wird das gesperrte Objekt nie wieder aufgerufen", () => {
    const raw = new Fake();
    const aborts: unknown[] = [];
    const g = guardRenderer(raw, (e) => aborts.push(e));
    expect(g.renderer.work("panic")).toBeUndefined();
    expect(g.renderer.work("ok")).toBeUndefined();
    expect(g.renderer.work("ok")).toBeUndefined();
    expect(aborts).toHaveLength(1);
    expect(g.dead()).toBe(true);
    expect(raw.calls).toBe(1);
  });
});
