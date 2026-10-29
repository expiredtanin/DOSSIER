// Ablauf des WASM-render2d-Renderers ohne GPU: ein Schein-Renderer, der wie die wasm-bindgen-Fassade
// reagiert (überlappender Aufruf → „recursive use …", nach einem Abbruch bleibt das Objekt gesperrt).
import { describe, expect, it } from "vitest";
import { type PlanFrame, type WebPlanRendererLike, WasmPlanRendererSession } from "./wasmRendererSession";

type Scene = { name: string };

/** Schein-Renderer: protokolliert Aufrufe, erkennt Überlappung, kann ausfallen. */
class FakeRenderer implements WebPlanRendererLike {
  static nextId = 1;
  readonly id = FakeRenderer.nextId++;
  calls: string[] = [];
  busy = false;
  /** Nach einem Abbruch (Panic in Rust) bleibt das wasm-bindgen-Objekt gesperrt. */
  poisoned = false;
  lost = false;
  failNextScene = false;
  onRender: (() => void) | null = null;
  lostCb: (() => void) | null = null;
  freed = false;

  private enter(name: string): void {
    if (this.poisoned || this.busy) {
      throw new Error("recursive use of an object detected which would lead to unsafe aliasing in rust");
    }
    this.busy = true;
    this.calls.push(name);
  }
  private leave(): void {
    this.busy = false;
  }
  set_scene_bin(bytes: Uint8Array): void {
    this.enter(`scene:${new TextDecoder().decode(bytes)}`);
    if (this.failNextScene) {
      this.failNextScene = false;
      this.poisoned = true; // Panic: Borrow wird nie freigegeben
      throw new Error("RuntimeError: unreachable");
    }
    this.leave();
  }
  set_view_box(x: number): void {
    this.enter(`view:${x}`);
    this.leave();
  }
  set_paper_scale(): void {
    this.enter("paper");
    this.leave();
  }
  set_text_scale(): void {
    this.enter("text");
    this.leave();
  }
  resize(): void {
    this.enter("resize");
    this.leave();
  }
  render(): void {
    this.enter("render");
    try {
      this.onRender?.();
    } finally {
      this.leave();
    }
  }
  is_lost(): boolean {
    this.enter("is_lost");
    this.leave();
    this.calls.pop();
    return this.lost;
  }
  set_lost_callback(f: () => void): void {
    this.lostCb = f;
  }
  free(): void {
    this.freed = true;
  }
}

const frame = (x: number): PlanFrame => ({
  viewBox: { x, y: 0, w: 10, h: 10 },
  paperScaleN: 100,
  textScaleN: 100,
  width: 100,
  height: 100,
});

function setup(opts: { maxRecoveries?: number; failCreate?: () => boolean; now?: () => number } = {}) {
  const made: FakeRenderer[] = [];
  const ready: boolean[] = [];
  const warnings: string[] = [];
  let pending: (() => void)[] = [];
  const session = new WasmPlanRendererSession<Scene>({
    create: () =>
      new Promise<WebPlanRendererLike>((resolve, reject) => {
        pending.push(() => {
          if (opts.failCreate?.()) return reject(new Error("kein Adapter"));
          const r = new FakeRenderer();
          made.push(r);
          resolve(r);
        });
      }),
    encode: (s) => new TextEncoder().encode(s.name),
    onReadyChange: (r) => ready.push(r),
    warn: (m) => warnings.push(m),
    maxRecoveries: opts.maxRecoveries,
    recoveryWindowMs: 1000,
    now: opts.now ?? (() => 0),
  });
  /** Ausstehende `create`-Aufrufe erfüllen und die Mikrotasks abarbeiten. */
  const settle = async () => {
    for (let k = 0; k < 5; k++) {
      const p = pending;
      pending = [];
      for (const f of p) f();
      await new Promise((r) => setTimeout(r, 0));
    }
  };
  return { session, made, ready, warnings, settle };
}

describe("WasmPlanRendererSession", () => {
  it("lädt jede Szene einmal hoch, zeichnet danach den letzten Ausschnitt", async () => {
    const { session, made, settle, ready } = setup();
    session.start();
    await settle();
    expect(ready).toEqual([true]);
    const a = { name: "A" };
    session.setScene(a);
    session.draw(frame(1));
    session.setScene(a); // gleiche Szene (Rad-Zoom über eine LOD-Stufe) → kein zweites Hochladen
    session.draw(frame(2));
    expect(made[0].calls.filter((c) => c.startsWith("scene"))).toEqual(["scene:A"]);
    expect(made[0].calls.at(-2)).toBe("view:2");
    expect(made[0].calls.at(-1)).toBe("render");
  });

  it("Szene und Ausschnitt vor dem Start gehen nicht verloren", async () => {
    const { session, made, settle } = setup();
    session.start();
    session.setScene({ name: "früh" });
    session.draw(frame(7));
    await settle();
    expect(made[0].calls).toEqual(["scene:früh", "resize", "paper", "text", "view:7", "render"]);
  });

  it("nach einem Abbruch (gesperrtes Objekt) neu aufbauen, letzte Szene gewinnt", async () => {
    const { session, made, settle, ready, warnings } = setup();
    session.start();
    await settle();
    session.setScene({ name: "A" });
    session.draw(frame(1));
    made[0].failNextScene = true;
    session.setScene({ name: "B" }); // Panic in Rust
    expect(ready).toEqual([true, false]); // SVG übernimmt, solange neu aufgebaut wird
    // Während des Neuaufbaus weitere Aufrufe: kein Zugriff auf das gesperrte Objekt.
    session.draw(frame(2));
    session.setScene({ name: "C" });
    session.draw(frame(3));
    expect(made[0].calls.filter((c) => c === "render")).toHaveLength(1);
    await settle();
    expect(made).toHaveLength(2);
    expect(made[0].freed).toBe(false); // gesperrtes Objekt nicht anfassen
    expect(made[1].calls).toEqual(["scene:C", "resize", "paper", "text", "view:3", "render"]);
    expect(ready).toEqual([true, false, true]);
    expect(warnings.some((w) => w.includes("recursive"))).toBe(false);
  });

  it("verlorenes Gerät (is_lost) → neuer Renderer, Szene erneut hochgeladen", async () => {
    const { session, made, settle } = setup();
    session.start();
    await settle();
    session.setScene({ name: "A" });
    session.draw(frame(1));
    made[0].lost = true;
    session.draw(frame(2));
    await settle();
    expect(made[0].freed).toBe(true);
    expect(made[1].calls).toEqual(["scene:A", "resize", "paper", "text", "view:2", "render"]);
  });

  it("Meldung „Gerät verloren“ im Leerlauf zeichnet neu, ohne auf Pan/Zoom zu warten", async () => {
    const { session, made, settle } = setup();
    session.start();
    await settle();
    session.setScene({ name: "A" });
    session.draw(frame(4));
    made[0].lost = true;
    made[0].lostCb?.();
    await settle();
    expect(made).toHaveLength(2);
    expect(made[1].calls.at(-1)).toBe("render");
    expect(made[1].calls).toContain("scene:A");
  });

  it("überlappender Aufruf aus einem Rückruf wird nachgeholt statt verschachtelt", async () => {
    const { session, made, settle, warnings } = setup();
    session.start();
    await settle();
    session.setScene({ name: "A" });
    let once = true;
    made[0].onRender = () => {
      if (!once) return;
      once = false;
      session.setScene({ name: "B" });
      session.draw(frame(9));
    };
    session.draw(frame(1));
    expect(warnings).toEqual([]);
    expect(made).toHaveLength(1);
    const c = made[0].calls;
    expect(c.filter((x) => x.startsWith("scene"))).toEqual(["scene:A", "scene:B"]);
    expect(c.at(-2)).toBe("view:9");
  });

  it("wiederholte Ausfälle: nach dem Budget aufgeben (SVG-Rückfall bleibt)", async () => {
    const { session, made, settle, ready } = setup({ maxRecoveries: 2 });
    session.start();
    await settle();
    session.setScene({ name: "A" });
    for (let k = 0; k < 5; k++) {
      made[made.length - 1].lost = true;
      session.draw(frame(k));
      await settle();
    }
    expect(made).toHaveLength(3); // erster + 2 Neuaufbauten
    expect(ready.at(-1)).toBe(false);
    session.draw(frame(99)); // kein Zugriff mehr
    expect(made[2].calls).not.toContain("view:99");
  });

  it("vereinzelte Ausfälle (ausserhalb des Zeitfensters) werden immer wieder behoben", async () => {
    let t = 0;
    const { session, made, settle, ready } = setup({ maxRecoveries: 1, now: () => t });
    session.start();
    await settle();
    session.setScene({ name: "A" });
    for (let k = 0; k < 4; k++) {
      t += 5000;
      made[made.length - 1].lost = true;
      session.draw(frame(k));
      await settle();
    }
    expect(made).toHaveLength(5);
    expect(ready.at(-1)).toBe(true);
    expect(made[4].calls.at(-1)).toBe("render");
  });

  it("scheitert der Aufbau, bleibt ready aus", async () => {
    const { session, settle, ready } = setup({ failCreate: () => true });
    session.start();
    await settle();
    expect(ready).toEqual([]);
    expect(session.ready).toBe(false);
  });

  it("nach dispose keine Aufrufe mehr, auch wenn der Aufbau später fertig wird", async () => {
    const { session, made, settle } = setup();
    session.start();
    session.dispose();
    await settle();
    session.setScene({ name: "A" });
    session.draw(frame(1));
    expect(made.flatMap((m) => m.calls)).toEqual([]);
  });
});
