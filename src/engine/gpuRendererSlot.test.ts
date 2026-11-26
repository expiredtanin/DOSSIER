// [206]/[118] Neuaufbau eines WASM/WebGPU-Renderers (render3d) nach Geräteverlust, ohne GPU (Schein-Renderer).
import { describe, expect, it } from "vitest";
import { GpuRecovery } from "./gpuRecovery";
import { GpuRendererSlot, type LosableRenderer } from "./gpuRendererSlot";

class Fake implements LosableRenderer {
  static n = 0;
  readonly id = ++Fake.n;
  lost = false;
  poisoned = false;
  freed = false;
  busy = false;
  lostCb: ((why?: string) => void) | null = null;
  calls: string[] = [];
  private enter(name: string) {
    if (this.poisoned || this.busy) throw new Error("recursive use of an object detected which would lead to unsafe aliasing in rust");
    this.calls.push(name);
  }
  render(): void {
    this.enter("render");
    if (this.lost) {
      // wie wgpu auf totem Gerät: createBuffer(mappedAtCreation) wirft, Rust paniert, Objekt gesperrt
      this.poisoned = true;
      throw new WebAssembly.RuntimeError("unreachable");
    }
  }
  set_model(json: string): void {
    this.enter("model");
    if (json === "kaputt") throw "Modell parsen: kaputt";
  }
  is_lost(): boolean {
    return this.lost;
  }
  set_lost_callback(f: (why?: string) => void): void {
    this.lostCb = f;
  }
  free(): void {
    if (this.poisoned) throw new Error("recursive use of an object detected which would lead to unsafe aliasing in rust");
    this.freed = true;
  }
}

function setup(opts: { probationMs?: number; maxLosses?: number; failCreate?: (k: number) => boolean; release?: (r: Fake) => void } = {}) {
  const made: Fake[] = [];
  const warnings: string[] = [];
  /** Zeitgeber von Hand: [ms, fn]. */
  let timers: { ms: number; fn: () => void; off: boolean }[] = [];
  let creates = 0;
  const recovery = new GpuRecovery({ maxLosses: opts.maxLosses ?? 3, baseDelayMs: 100, factor: 4, now: () => 0 });
  const slot = new GpuRendererSlot<Fake>({
    label: "render3d",
    recovery,
    probationMs: opts.probationMs ?? 0,
    create: async () => {
      const k = creates++;
      if (opts.failCreate?.(k)) throw new Error("kein Adapter");
      const f = new Fake();
      made.push(f);
      return f;
    },
    schedule: (fn, ms) => {
      const t = { ms, fn, off: false };
      timers.push(t);
      return () => void (t.off = true);
    },
    warn: (m) => warnings.push(m),
    info: () => {},
    ...(opts.release ? { release: opts.release } : {}),
  });
  const delays: number[] = [];
  /** Mikrotasks abarbeiten und fällige Zeitgeber (alle) auslösen. */
  const settle = async (rounds = 6) => {
    for (let k = 0; k < rounds; k++) {
      await Promise.resolve();
      await Promise.resolve();
      const ts = timers;
      timers = [];
      for (const t of ts) {
        if (t.off) continue;
        if (t.ms > 0) delays.push(t.ms);
        t.fn();
      }
    }
  };
  return { slot, made, warnings, settle, delays, recovery };
}

describe("GpuRendererSlot", () => {
  it("Geräteverlust (Rückruf) → im nächsten Takt verwerfen, mit Wartezeit neu aufbauen", async () => {
    const { slot, made, settle, delays } = setup();
    const seen: (Fake | null)[] = [];
    slot.subscribe(() => seen.push(slot.renderer && made[made.length - 1]));
    slot.start();
    await settle();
    expect(slot.ready).toBe(true);
    made[0].lost = true;
    made[0].lostCb?.("Unknown: weg");
    // Rückruf verarbeitet NICHTS synchron (kein Zugriff aus dem Rückruf heraus).
    expect(slot.ready).toBe(true);
    await settle();
    expect(made).toHaveLength(2);
    expect(made[0].freed).toBe(true);
    expect(delays).toEqual([100]);
    expect(slot.ready).toBe(true);
    expect(seen.at(-1)).toBe(made[1]);
  });

  it("[333] Abbau mit `release`: intakter Renderer geht an den Aufrufer statt `free`, ein verlorener nicht", async () => {
    const released: Fake[] = [];
    const a = setup({ release: (r) => released.push(r) });
    a.slot.start();
    await a.settle(1);
    a.slot.dispose();
    expect(released).toEqual([a.made[0]]);
    expect(a.made[0].freed).toBe(false);
    const b = setup({ release: (r) => released.push(r) });
    b.slot.start();
    await b.settle(1);
    b.made[0].lost = true;
    b.slot.renderer!.render(); // Abbruch: Hülle tot
    b.slot.dispose();
    expect(released).toHaveLength(1);
  });

  it("Abbruch (Panic) mitten im Aufruf: gesperrtes Objekt nie wieder angefasst, auch nicht free", async () => {
    const { slot, made, settle, warnings } = setup();
    slot.start();
    await settle(1);
    const r = slot.renderer!;
    made[0].lost = true;
    r.render(); // wirft intern, Hülle schluckt
    r.render();
    expect(made[0].calls).toEqual(["render"]);
    expect(slot.renderer).toBeNull();
    await settle();
    expect(made[0].freed).toBe(false);
    expect(made).toHaveLength(2);
    expect(warnings.some((w) => /recursive/.test(w))).toBe(false);
  });

  it("Result::Err bleibt ein gewöhnlicher Fehler ohne Neuaufbau", async () => {
    const { slot, made, settle } = setup();
    slot.start();
    await settle();
    expect(() => slot.renderer!.set_model("kaputt")).toThrow();
    await settle();
    expect(made).toHaveLength(1);
    expect(slot.ready).toBe(true);
  });

  it("wiederholte Verluste: Backoff wächst, danach bleibt WebGPU aus (keine Schleife)", async () => {
    const { slot, made, settle, delays, recovery, warnings } = setup({ maxLosses: 2 });
    slot.start();
    await settle();
    for (let k = 0; k < 5; k++) {
      const f = made[made.length - 1];
      f.lost = true;
      f.lostCb?.();
      await settle();
    }
    expect(made).toHaveLength(3);
    expect(delays).toEqual([100, 400]);
    expect(slot.failed).toBe(true);
    expect(slot.ready).toBe(false);
    expect(recovery.disabled).toBe(true);
    expect(warnings.filter((w) => /wiederholt/.test(w))).toHaveLength(1);
  });

  it("scheitert der Neuaufbau (kein Adapter), zählt das als weiterer Verlust", async () => {
    const { slot, made, settle } = setup({ failCreate: (k) => k === 1 });
    slot.start();
    await settle();
    made[0].lostCb?.();
    await settle(10);
    expect(made).toHaveLength(2);
    expect(slot.ready).toBe(true);
  });

  it("erster Aufbau scheitert: failed, kein Neuaufbau", async () => {
    const { slot, made, settle } = setup({ failCreate: () => true });
    slot.start();
    await settle();
    expect(slot.failed).toBe(true);
    expect(made).toHaveLength(0);
  });

  it("dispose gibt frei und bricht einen geplanten Neuaufbau ab", async () => {
    const { slot, made, settle } = setup();
    slot.start();
    await settle();
    made[0].lostCb?.();
    await settle(1); // Verlust verarbeitet, Neuaufbau geplant
    slot.dispose();
    await settle();
    expect(made).toHaveLength(1);
    const s2 = setup();
    s2.slot.start();
    await s2.settle();
    s2.slot.dispose();
    expect(s2.made[0].freed).toBe(true);
  });

  it("Budget schon erschöpft: startet gar nicht erst", async () => {
    const { slot, made, settle, recovery } = setup({ maxLosses: 0 });
    recovery.noteLoss();
    slot.start();
    await settle();
    expect(made).toHaveLength(0);
    expect(slot.failed).toBe(true);
  });

  it("[118] Bewährungszeit: neu aufgebauter Renderer erst nach Ablauf bekannt, erster Aufbau sofort", async () => {
    const { slot, made, settle, delays } = setup({ probationMs: 777 });
    let emits = 0;
    slot.subscribe(() => emits++);
    slot.start();
    await settle(2);
    expect(slot.ready).toBe(true); // erster Aufbau unverändert
    made[0].lost = true;
    made[0].lostCb?.("weg");
    // Verlust verarbeiten, Wartezeit abwarten, Neuaufbau: Probezeit-Zeitgeber steht noch aus
    for (let k = 0; k < 8 && made.length < 2; k++) await settle(1);
    expect(made).toHaveLength(2);
    expect(slot.ready).toBe(false);
    expect(slot.renderer).toBeNull();
    await settle(1); // Probezeit läuft ab
    expect(delays).toContain(777);
    expect(slot.ready).toBe(true);
    expect(slot.renderer).not.toBeNull();
    expect(emits).toBeGreaterThan(0);
  });

  it("[118] Verlust in der Bewährungszeit: gesperrt, freigegeben, nächster Neuaufbau", async () => {
    const { slot, made, settle } = setup({ probationMs: 777 });
    slot.start();
    await settle(2);
    made[0].lost = true;
    made[0].lostCb?.("weg");
    for (let k = 0; k < 8 && made.length < 2; k++) await settle(1);
    expect(made).toHaveLength(2);
    made[1].lostCb?.("weg"); // sofort wieder weg, noch vor Ablauf
    expect(slot.ready).toBe(false);
    await settle(1);
    expect(made[1].freed).toBe(true);
  });
});
