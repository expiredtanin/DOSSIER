/**
 * [206]/[118] Besitzer EINES WASM/WebGPU-Renderers an einem Canvas (render3d; render2d hat dafür
 * `views/plan/wasmRendererSession.ts` mit Szenen-Logik): erzeugt ihn, merkt Geräteverlust und Abbrüche,
 * baut mit Backoff neu auf (gemeinsames Budget {@link gpuRecovery}) und gibt ihn beim Abbau frei.
 *
 *  - `renderer` ist eine {@link guardRenderer}-Hülle: ein Abbruch (Panic, WebGPU-Ausnahme) macht weitere Aufrufe
 *    zu No-ops und löst den Neuaufbau aus, ohne das gesperrte Objekt je wieder anzufassen.
 *  - Der Verlust-Rückruf aus Rust wird erst im nächsten Takt verarbeitet (nie verschachtelt).
 *  - [118] Ein nach Verlust neu aufgebauter Renderer wird erst nach der Bewährungszeit (`probationMs`) ohne erneuten
 *    Verlust bekannt gemacht (`renderer`/`ready`): Verliert das Gerät jedes Mal beim ersten Präsentieren (headless),
 *    flackert die 3D-Ansicht nicht zwischen Hinweis und Bild. Der erste Aufbau ist davon unberührt.
 *  - Während des Neuaufbaus ist `renderer` null und `ready` false; danach ein NEUES Objekt: Abonnenten
 *    spielen Modell, Kamera usw. erneut ein.
 *
 * Rein (ohne DOM), getestet in `gpuRendererSlot.test.ts`.
 */
import { GpuRecovery, gpuRecovery, guardRenderer } from "./gpuRecovery";

/** Was der Slot vom wasm-bindgen-Objekt braucht (alles optional: ältere WASM-Builds). */
export interface LosableRenderer {
  is_lost?(): boolean;
  set_lost_callback?(f: (why?: string) => void): void;
  free?(): void;
}

export interface GpuRendererSlotOptions<R> {
  create(): Promise<R>;
  /** Kurzname für Meldungen („render3d“). */
  label: string;
  recovery?: GpuRecovery;
  /** Bewährungszeit nach einem Neuaufbau in ms (Vorgabe 1000, 0 = sofort): erst danach ohne erneuten Verlust `ready`. */
  probationMs?: number;
  /** Zeitgeber (Vorgabe `setTimeout`); liefert eine Abbruch-Funktion. */
  schedule?(fn: () => void, ms: number): () => void;
  warn?(msg: string, e?: unknown): void;
  /**
   * [333] Beim Abbau (`dispose`) statt `free`: der intakte Renderer geht an den Aufrufer (render3d parkt ihn für das
   * Wiederöffnen der 3D-Ansicht). Nach einem Verlust oder Abbruch wird wie bisher verworfen.
   */
  release?(raw: R): void;
  /** Weitere Neuaufbauten im selben Zeitfenster (Vorgabe `console.info`). */
  info?(msg: string, e?: unknown): void;
}

const defaultSchedule = (fn: () => void, ms: number) => {
  const h = setTimeout(fn, ms);
  return () => clearTimeout(h);
};

export class GpuRendererSlot<R extends LosableRenderer> {
  private raw: R | null = null;
  private guarded: { renderer: R; dead(): boolean; kill(): void } | null = null;
  private creating = false;
  private started = false;
  private recovering = false;
  private _failed = false;
  private disposed = false;
  /** Neuer Renderer ist noch in der Bewährungszeit (nach aussen nicht sichtbar). */
  private probation = false;
  private cancelProbation: (() => void) | null = null;
  private cancelTimer: (() => void) | null = null;
  private listeners = new Set<() => void>();
  private readonly recovery: GpuRecovery;
  private readonly schedule: (fn: () => void, ms: number) => () => void;

  constructor(private readonly opts: GpuRendererSlotOptions<R>) {
    this.recovery = opts.recovery ?? gpuRecovery;
    this.schedule = opts.schedule ?? defaultSchedule;
  }

  /** Der aktuelle (geschützte) Renderer oder null (noch nicht da, Neuaufbau, aufgegeben). */
  get renderer(): R | null {
    const g = this.guarded;
    if (!g || g.dead() || this.probation) return null;
    return g.renderer;
  }

  get ready(): boolean {
    return this.renderer !== null;
  }

  /** Endgültig ohne GPU (kein WebGPU, Init gescheitert, Budget erschöpft). */
  get failed(): boolean {
    return this._failed;
  }

  /** Zustandsänderung abonnieren (Renderer da/weg/neu, gescheitert); liefert die Abmeldung. */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    if (this.recovery.disabled) {
      this._failed = true;
      this.emit();
      return;
    }
    this.spawn();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelTimer?.();
    this.cancelTimer = null;
    this.cancelProbation?.();
    this.cancelProbation = null;
    this.drop(true, this.opts.release);
    this.listeners.clear();
  }

  private emit(): void {
    for (const l of [...this.listeners]) l();
  }

  private warn(msg: string, e?: unknown): void {
    (this.opts.warn ?? ((m: string, x?: unknown) => console.warn(m, x ?? "")))(msg, e);
  }

  /** Aktuellen Renderer verwerfen; `free` nur, wenn das Objekt nicht gesperrt ist. */
  private drop(healthy: boolean, release?: (raw: R) => void): void {
    const raw = this.raw;
    const g = this.guarded;
    this.cancelProbation?.();
    this.cancelProbation = null;
    this.probation = false;
    this.raw = null;
    this.guarded = null;
    if (!raw || !g) return;
    const intact = healthy && !g.dead();
    g.kill();
    if (!intact) return;
    if (release) {
      release(raw);
      return;
    }
    try {
      raw.free?.();
    } catch {
      /* bereits unbrauchbar */
    }
  }

  private spawn(): void {
    if (this.creating || this.disposed || this._failed) return;
    this.creating = true;
    this.opts.create().then(
      (raw) => {
        this.creating = false;
        if (this.disposed || this._failed) {
          try {
            raw.free?.();
          } catch {
            /* egal */
          }
          return;
        }
        const rebuilt = this.recovering;
        this.recovering = false;
        this.raw = raw;
        this.guarded = guardRenderer(raw, (e) => this.later(() => this.lost(raw, e, false)));
        try {
          raw.set_lost_callback?.((why?: string) => this.later(() => this.lost(raw, why ?? "Gerät verloren", true)));
          if (raw.is_lost?.()) this.later(() => this.lost(raw, "Gerät verloren", true));
        } catch (e) {
          this.later(() => this.lost(raw, e, false));
        }
        const wait = this.opts.probationMs ?? 1000;
        if (rebuilt && wait > 0) {
          this.probation = true;
          this.cancelProbation = this.schedule(() => {
            this.cancelProbation = null;
            if (this.disposed || this.raw !== raw) return;
            this.probation = false;
            this.emit();
          }, wait);
          return;
        }
        this.emit();
      },
      (e) => {
        this.creating = false;
        if (this.disposed) return;
        if (this.recovering) {
          // Neuaufbau gescheitert (z. B. kurz nach dem Verlust noch kein Adapter): wie ein weiterer Verlust.
          this.retry(e);
          return;
        }
        this._failed = true;
        this.warn(`${this.opts.label} WASM/WebGPU-Init fehlgeschlagen`, e);
        this.emit();
      },
    );
  }

  /** Im nächsten Takt ausführen (nie verschachtelt in einen laufenden Renderer-Aufruf). */
  private later(fn: () => void): void {
    this.schedule(fn, 0);
  }

  private lost(raw: R, why: unknown, healthy: boolean): void {
    if (this.disposed || this.raw !== raw) return;
    this.drop(healthy);
    this.emit();
    this.retry(why);
  }

  private retry(why: unknown): void {
    const delay = this.recovery.noteLoss();
    if (delay === null) {
      this._failed = true;
      this.warn(`${this.opts.label}: WebGPU wiederholt ausgefallen, bleibt aus`, why);
      this.emit();
      return;
    }
    this.recovering = true;
    const msg = `${this.opts.label}: WebGPU-Gerät verloren, Neuaufbau in ${Math.round(delay)} ms`;
    if (this.recovery.recentLosses <= 1) this.warn(msg, why);
    else (this.opts.info ?? ((m: string, x?: unknown) => console.info(m, x ?? "")))(msg, why);
    this.cancelTimer = this.schedule(() => {
      this.cancelTimer = null;
      // Inzwischen hat ein anderer Renderer der Seite das Budget erschöpft: nicht mehr aufbauen (still).
      if (this.recovery.disabled) {
        this._failed = true;
        this.emit();
        return;
      }
      this.spawn();
    }, delay);
  }
}
