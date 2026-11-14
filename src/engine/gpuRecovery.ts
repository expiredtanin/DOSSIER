/**
 * [206]/[118] Geräteverlust der WASM/WebGPU-Renderer (render2d, render3d) geordnet behandeln.
 *
 * Ein WebGPU-Gerät kann jederzeit verloren gehen (Mac: Ruhezustand, Grafikwechsel, eGPU, Speicherdruck; headless
 * SwiftShader: schon beim ersten Präsentieren). Dann gilt:
 *  - Der Verlust-Rückruf (aus Rust, `device.lost`) setzt nur Zustand; neu aufgebaut wird AUSSERHALB, in einem
 *    eigenen Takt (nie verschachtelt in einen laufenden Renderer-Aufruf → kein „recursive use of an object …“).
 *  - Ein verlorener/gesperrter Renderer wird nicht mehr aufgerufen (Rust kehrt bei `is_lost` sofort zurück; ein
 *    nach einem Abbruch gesperrtes Objekt fasst {@link guardRenderer} nicht mehr an).
 *  - Neuaufbau mit Backoff (0,5 s, 2 s, 8 s …) und einem GEMEINSAMEN Budget für alle Renderer der Seite: gehen
 *    zu viele Geräte in kurzer Zeit verloren, bleibt WebGPU für diese Sitzung aus (Plan über SVG, 3D-Hinweis),
 *    statt im Kreis neu aufzubauen.
 *
 * Rein (ohne DOM), getestet in `gpuRecovery.test.ts`.
 */

export interface GpuRecoveryOptions {
  /** Verluste je Zeitfenster, die noch neu aufgebaut werden; der nächste schaltet WebGPU ab (Vorgabe 3). */
  maxLosses?: number;
  /** Zeitfenster in ms (Vorgabe 60 s). */
  windowMs?: number;
  /** Wartezeit vor dem ersten Neuaufbau in ms (Vorgabe 500), danach je Verlust im Fenster × `factor`. */
  baseDelayMs?: number;
  factor?: number;
  /** Uhr in ms (Vorgabe `performance.now`; im Test austauschbar). */
  now?(): number;
}

export class GpuRecovery {
  private losses: number[] = [];
  private _disabled = false;
  private readonly maxLosses: number;
  private readonly windowMs: number;
  private readonly baseDelayMs: number;
  private readonly factor: number;
  private readonly now: () => number;

  constructor(opts: GpuRecoveryOptions = {}) {
    this.maxLosses = opts.maxLosses ?? 3;
    this.windowMs = opts.windowMs ?? 60_000;
    this.baseDelayMs = opts.baseDelayMs ?? 500;
    this.factor = opts.factor ?? 4;
    this.now = opts.now ?? (() => (typeof performance !== "undefined" ? performance.now() : Date.now()));
  }

  /** Verluste im laufenden Zeitfenster (nach `noteLoss` inklusive des eben gemeldeten). Der erste wird als Warnung
   *  gemeldet, weitere Neuaufbauten nur als Info (die Aufgabe am Ende wieder als Warnung). */
  get recentLosses(): number {
    return this.losses.length;
  }

  /** WebGPU für diese Sitzung aufgegeben (zu viele Verluste)? Neue Renderer starten dann gar nicht erst. */
  get disabled(): boolean {
    return this._disabled;
  }

  /**
   * Ein Gerät ist verloren (oder ein Renderer gesperrt, oder der Neuaufbau scheiterte). Liefert die Wartezeit bis
   * zum Neuaufbau in ms, oder `null` = aufgeben (ab jetzt {@link disabled}).
   */
  noteLoss(): number | null {
    if (this._disabled) return null;
    const t = this.now();
    this.losses = this.losses.filter((x) => t - x < this.windowMs);
    if (this.losses.length >= this.maxLosses) {
      this._disabled = true;
      return null;
    }
    const delay = this.baseDelayMs * this.factor ** this.losses.length;
    this.losses.push(t);
    return delay;
  }
}

/** Das gemeinsame Budget aller WASM/WebGPU-Renderer der Seite. */
export const gpuRecovery = new GpuRecovery();

/**
 * Ein wasm-bindgen-Aufruf warf. Ein Rust-`Result::Err` kommt als Zeichenkette (`JsValue::from_str`) und lässt das
 * Objekt intakt (z. B. „Szene lesen: …“, „Modell parsen: …“). Alles andere — `RuntimeError: unreachable` (Panic),
 * eine aus WebGPU durchgereichte Ausnahme (`createBuffer` auf totem Gerät), „recursive use of an object …“ — heisst:
 * das Objekt ist mitten in einem `&mut self`-Aufruf abgebrochen und bleibt gesperrt.
 */
export function isRendererAbort(e: unknown): boolean {
  return typeof e !== "string";
}

/**
 * Hülle um ein wasm-bindgen-Renderer-Objekt: jeder Methodenaufruf, der das Objekt sperrt ({@link isRendererAbort}),
 * meldet `onAbort` (einmal) und macht alle weiteren Aufrufe zu No-ops (`undefined`) — ein gesperrtes Objekt wird nie
 * wieder angefasst, auch `free` nicht. Ebenso nach `is_lost()`: dann gar keine Aufrufe mehr. `Result::Err` (Zeichenkette)
 * wird unverändert weitergeworfen.
 */
export function guardRenderer<R extends object>(raw: R, onAbort: (e: unknown) => void): { renderer: R; dead(): boolean; kill(): void } {
  let dead = false;
  const die = (e: unknown) => {
    if (dead) return;
    dead = true;
    onAbort(e);
  };
  const cache = new Map<PropertyKey, unknown>();
  const renderer = new Proxy(raw, {
    get(target, prop) {
      const v = Reflect.get(target, prop, target);
      if (typeof v !== "function") return v;
      let w = cache.get(prop);
      if (!w) {
        w = (...args: unknown[]) => {
          if (dead) return undefined;
          try {
            return (v as (...a: unknown[]) => unknown).apply(target, args);
          } catch (e) {
            if (!isRendererAbort(e)) throw e;
            die(e);
            return undefined;
          }
        };
        cache.set(prop, w);
      }
      return w;
    },
  });
  return { renderer, dead: () => dead, kill: () => void (dead = true) };
}
