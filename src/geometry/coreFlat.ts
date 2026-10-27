// Flache Puffer für den Rust-Kern (`src-tauri/core`): Schreiben/Lesen von Zahlen, Punktringen und
// Mehrfach-Polygonen (`flat.rs`: `[nPoly, (nRing, (nPkt, x, y, …)…)…]`, Ringe offen). Punkte als
// `Vec2`; Aufbau je Kern-Funktion steht bei der Rust-Bindung (`src-tauri/core/src/web/*.rs`).

import type { Vec2 } from "../model/types";

/** Mehrfach-Polygon: `[polygon][ring]`, Ring 0 aussen, weitere Löcher; Ringe offen. */
export type FlatPolygons = Vec2[][][];

export class FlatWriter {
  private buf: number[] = [];

  num(...v: number[]): this {
    for (const x of v) this.buf.push(x);
    return this;
  }

  /** Platz für eine erst später bekannte Zahl (z. B. Anzahl); Wert mit `set` nachtragen. */
  slot(): number {
    this.buf.push(0);
    return this.buf.length - 1;
  }

  set(slot: number, v: number): this {
    this.buf[slot] = v;
    return this;
  }

  /** Nur die Punkte: `x0, y0, x1, y1, …`. */
  pts(pts: readonly Vec2[]): this {
    for (const p of pts) this.buf.push(p.x, p.y);
    return this;
  }

  /** Anzahl, dann die Punkte. */
  ring(pts: readonly Vec2[]): this {
    this.buf.push(pts.length);
    return this.pts(pts);
  }

  /** Mehrfach-Polygon in `flat`-Kodierung. */
  polygons(polys: FlatPolygons): this {
    this.buf.push(polys.length);
    for (const poly of polys) {
      this.buf.push(poly.length);
      for (const r of poly) this.ring(r);
    }
    return this;
  }

  done(): Float64Array {
    return Float64Array.from(this.buf);
  }
}

/** Liest Zahlen der Reihe nach; fehlende Werte → NaN bzw. Anzahl 0. */
export class FlatReader {
  private i = 0;
  constructor(private readonly buf: Float64Array) {}

  num(): number {
    return this.i < this.buf.length ? this.buf[this.i++] : Number.NaN;
  }

  count(): number {
    const n = this.num();
    return Number.isInteger(n) && n > 0 ? n : 0;
  }

  pts(n: number): Vec2[] {
    const out: Vec2[] = [];
    for (let k = 0; k < n; k++) out.push({ x: this.num(), y: this.num() });
    return out;
  }

  ring(): Vec2[] {
    return this.pts(this.count());
  }

  polygons(): FlatPolygons {
    const out: FlatPolygons = [];
    for (let p = this.count(); p > 0; p--) {
      const poly: Vec2[][] = [];
      for (let r = this.count(); r > 0; r--) poly.push(this.ring());
      out.push(poly);
    }
    return out;
  }
}

/** `x0, y0, x1, y1, …` → Punkte. */
export function pointsOf(buf: Float64Array): Vec2[] {
  return new FlatReader(buf).pts(buf.length >> 1);
}
