/**
 * Besitzer des WASM-render2d-Renderers (WebGPU) eines Canvas: EIN Ort, der den Renderer aufruft.
 *
 * Fehlerbild (G10, 29.10.): headless beim Rad-Zoom „recursive use of an object detected which would
 * lead to unsafe aliasing in rust", danach blieb der Plan leer. Ursache war keine echte Überlappung
 * (alle Aufrufe sind synchron), sondern ein Abbruch MITTEN in einem `&mut self`-Aufruf: das WebGPU-Gerät
 * ging verloren (headless SwiftShader verliert es beim ersten Präsentieren, real: Treiber-Reset,
 * GPU-Prozess-Absturz), `createBuffer(mappedAtCreation)` warf, wgpu machte daraus einen Panic, WASM
 * brach ab — und die Ausleih-Sperre des wasm-bindgen-Objekts wurde nie freigegeben. Jeder weitere
 * Aufruf (`render`, `set_scene_bin`) scheiterte dann mit „recursive use …", der GPU-Pfad blieb aber
 * „bereit" und verdeckte den SVG-Rückfall.
 *
 * Daher hier:
 *  - Szene und Ausschnitt werden nur gemerkt und in `flush` angewandt — die letzte Szene gewinnt,
 *    gleiche Szene (Objekt-Identität) wird nicht erneut hochgeladen (render2d ist zoomunabhängig).
 *  - Ein Aufruf während eines laufenden (Rückruf aus dem Renderer) wird nachgeholt, nie verschachtelt.
 *  - Wirft ein Aufruf oder meldet der Renderer „Gerät verloren", wird das Objekt verworfen (ein
 *    gesperrtes nicht mehr angefasst), `ready` geht aus (SVG zeichnet den Plan) und ein neuer Renderer
 *    entsteht; danach werden letzte Szene und letzter Ausschnitt erneut angewandt. Höchstens
 *    `maxRecoveries` Neuaufbauten je Zeitfenster — sonst bleibt der SVG-Rückfall.
 *
 * Rein (ohne React/DOM) und mit einem Schein-Renderer getestet (`wasmRendererSession.test.ts`).
 */

/** Was die Sitzung vom wasm-bindgen-Objekt `WebPlanRenderer` braucht. */
export interface WebPlanRendererLike {
  set_scene_bin(bytes: Uint8Array): void;
  set_view_box(x: number, y: number, w: number, h: number): void;
  set_paper_scale(n: number): void;
  set_text_scale(n: number): void;
  resize(w: number, h: number): void;
  render(): void;
  /** true, sobald das WebGPU-Gerät verloren ist (dann zeichnet der Renderer nichts mehr). */
  is_lost(): boolean;
  /** Rückruf beim Geräteverlust (aus dem `device.lost`-Promise). */
  set_lost_callback?(f: () => void): void;
  free?(): void;
}

/** Ein zu zeichnender Frame (Geräte-Pixel bereits mit DPR gerechnet). */
export interface PlanFrame {
  viewBox: { x: number; y: number; w: number; h: number };
  paperScaleN: number;
  textScaleN: number;
  width: number;
  height: number;
}

export interface SessionOptions<S> {
  /** Neuen Renderer erzeugen (WebGPU-Adapter/-Gerät, Canvas-Kontext). */
  create(): Promise<WebPlanRendererLike>;
  /** Szene → Binärpuffer (`planSceneBin`). */
  encode(scene: S): Uint8Array;
  /** Bereitschaft geändert (false → Aufrufer zeichnet über SVG). */
  onReadyChange(ready: boolean): void;
  warn?(msg: string, e?: unknown): void;
  /** Neuaufbauten je Zeitfenster, danach endgültig SVG (Vorgabe 3 je 60 s). */
  maxRecoveries?: number;
  recoveryWindowMs?: number;
  /** Uhr in ms (Vorgabe `performance.now`; im Test austauschbar). */
  now?(): number;
}

export class WasmPlanRendererSession<S> {
  private renderer: WebPlanRendererLike | null = null;
  private scene: S | undefined = undefined;
  /** Zuletzt in den AKTUELLEN Renderer hochgeladene Szene. */
  private uploaded: S | undefined = undefined;
  private frame: PlanFrame | null = null;
  private inCall = false;
  /** Während eines laufenden Aufrufs angefragt: danach nachholen (true = auch zeichnen). */
  private pending: boolean | null = null;
  private creating = false;
  private started = false;
  private failed = false;
  private disposed = false;
  /** Zeitpunkte der Neuaufbauten im laufenden Fenster. */
  private recoveries: number[] = [];
  private _ready = false;
  private readonly maxRecoveries: number;

  constructor(private readonly opts: SessionOptions<S>) {
    this.maxRecoveries = opts.maxRecoveries ?? 3;
  }

  get ready(): boolean {
    return this._ready;
  }

  /** Ersten Renderer erzeugen (mehrfacher Aufruf unschädlich). */
  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    this.spawn();
  }

  /** Neue Szene; wird sofort hochgeladen, wenn möglich, sonst beim nächsten Renderer. */
  setScene(scene: S): void {
    this.scene = scene;
    this.flush(false);
  }

  /** Einen Frame zeichnen (lädt eine ausstehende Szene vorher hoch). */
  draw(frame: PlanFrame): void {
    this.frame = frame;
    this.flush(true);
  }

  dispose(): void {
    this.disposed = true;
    this.setReady(false);
    this.release(this.renderer, true);
    this.renderer = null;
  }

  private setReady(r: boolean): void {
    if (this._ready === r) return;
    this._ready = r;
    this.opts.onReadyChange(r);
  }

  private warn(msg: string, e?: unknown): void {
    (this.opts.warn ?? ((m: string, x?: unknown) => console.warn(m, x)))(msg, e);
  }

  private release(r: WebPlanRendererLike | null, healthy: boolean): void {
    // Ein nach einem Abbruch gesperrtes Objekt nicht anfassen (auch `free` liefe in die Sperre).
    if (!r || !healthy) return;
    try {
      r.free?.();
    } catch {
      /* bereits unbrauchbar */
    }
  }

  private spawn(): void {
    if (this.creating || this.disposed || this.failed) return;
    this.creating = true;
    this.opts.create().then(
      (r) => {
        this.creating = false;
        if (this.disposed || this.failed) {
          this.release(r, true);
          return;
        }
        this.renderer = r;
        this.uploaded = undefined;
        r.set_lost_callback?.(() => {
          if (this.renderer === r) this.fail(new Error("WebGPU-Gerät verloren"), true);
        });
        this.setReady(true);
        this.flush(this.frame !== null);
      },
      (e) => {
        this.creating = false;
        this.failed = true;
        this.setReady(false);
        if (!this.disposed) this.warn("render2d WASM/WebGPU-Init fehlgeschlagen → SVG", e);
      },
    );
  }

  /** Renderer ausgefallen: verwerfen und (im Budget) neu aufbauen. */
  private fail(e: unknown, healthy: boolean): void {
    const old = this.renderer;
    this.renderer = null;
    this.uploaded = undefined;
    this.release(old, healthy);
    this.setReady(false);
    if (this.disposed) return;
    const now = (this.opts.now ?? (() => performance.now()))();
    const windowMs = this.opts.recoveryWindowMs ?? 60_000;
    this.recoveries = this.recoveries.filter((t) => now - t < windowMs);
    if (this.recoveries.length >= this.maxRecoveries) {
      this.failed = true;
      this.warn("render2d: WebGPU wiederholt ausgefallen → Plan über SVG", e);
      return;
    }
    this.recoveries.push(now);
    this.warn("render2d: Renderer ausgefallen, wird neu aufgebaut", e);
    this.spawn();
  }

  private flush(drawFrame: boolean): void {
    if (this.inCall) {
      this.pending = (this.pending ?? false) || drawFrame;
      return;
    }
    const r = this.renderer;
    if (!r || this.disposed) return;

    let bytes: Uint8Array | null = null;
    const scene = this.scene;
    if (scene !== undefined && scene !== this.uploaded) {
      try {
        bytes = this.opts.encode(scene);
      } catch (e) {
        // Kodierfehler betrifft die Szene, nicht den Renderer: nicht erneut versuchen.
        this.warn("render2d: Szene kodieren fehlgeschlagen", e);
        this.uploaded = scene;
      }
    }

    this.inCall = true;
    let lost = false;
    try {
      lost = r.is_lost();
      if (!lost) {
        if (bytes) {
          r.set_scene_bin(bytes);
          this.uploaded = scene;
        }
        const f = this.frame;
        if (drawFrame && f) {
          r.resize(f.width, f.height);
          r.set_paper_scale(f.paperScaleN);
          r.set_text_scale(f.textScaleN);
          r.set_view_box(f.viewBox.x, f.viewBox.y, f.viewBox.w, f.viewBox.h);
          r.render();
        }
      }
    } catch (e) {
      this.inCall = false;
      this.pending = null;
      this.fail(e, false);
      return;
    }
    this.inCall = false;
    if (lost) {
      this.pending = null;
      this.fail(new Error("WebGPU-Gerät verloren"), true);
      return;
    }
    const again = this.pending;
    this.pending = null;
    if (again !== null) this.flush(again);
  }
}
