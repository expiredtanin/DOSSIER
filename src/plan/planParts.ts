/**
 * Zusammengesetzter Plan für Kern-Verbraucher ([K3d], Rust: `src-tauri/core/src/plan_parts.rs`):
 * die Primitive eines {@link Plan} als Abschnitte gehaltener Plan-Puffer, in Zeichenreihenfolge.
 * Was unverändert aus einem Kern-Puffer stammt (`Plan.bufRuns`, Objekt-Identität geprüft), geht
 * ohne Umweg über Objekte; der Rest (2D-Zeichnungen, Schatten, Baurecht, zerlegte Polygone,
 * gedimmte Klone) wird einmal in einen eigenen Puffer geschrieben. Der Index eines Primitivs im
 * Kern ist seine Stelle in `plan.primitives`.
 *
 * Abschnitte reisen als `[Puffer-Nr, von, bis, …]` (Nr = `plan_buf_hold`), gedimmte Bereiche
 * (`Plan.greyedRanges`) als `[von, bis, …]`. Verdrängt der Kern einen Puffer, liefert er ein
 * leeres Ergebnis; {@link withPlanParts} legt dann alles neu ab und fragt nochmals.
 */

import type { Plan, PlanBufRun, Primitive } from "./generatePlan";
import { encodePlanBuf } from "./planBuf";
import { core } from "../engine/coreWasm";

/** Ein im Kern ablegbarer Puffer (Kern-Ergebnis `DecodedPlanBuf` oder eigener). */
interface HoldableBuf {
  bytes: Uint8Array;
  hold: number;
}

export interface PlanParts {
  bufs: HoldableBuf[];
  /** Abschnitte `[Index in bufs, von, bis, …]`. */
  segs: number[];
  /** Anzahl Primitive (= `plan.primitives.length`). */
  count: number;
}

/** Unveränderte Kern-Abschnitte (Objekt-Identität) in Plan-Reihenfolge. */
function verifiedRuns(primitives: readonly Primitive[], runs: readonly PlanBufRun[] | undefined) {
  const out: Array<{ start: number; end: number; buf: PlanBufRun["buf"]; from: number }> = [];
  for (const r of runs ?? []) {
    const n = Math.min(r.to - r.from, primitives.length - r.at);
    let k = 0;
    while (k < n) {
      while (k < n && primitives[r.at + k] !== r.buf.prims[r.from + k]) k++;
      const k0 = k;
      while (k < n && primitives[r.at + k] === r.buf.prims[r.from + k]) k++;
      if (k > k0) out.push({ start: r.at + k0, end: r.at + k, buf: r.buf, from: r.from + k0 });
    }
  }
  out.sort((a, b) => a.start - b.start);
  // Überlappungen (sollte es nicht geben) verwerfen.
  const clean: typeof out = [];
  let last = 0;
  for (const s of out) {
    if (s.start < last) continue;
    clean.push(s);
    last = s.end;
  }
  return clean;
}

const cache = new WeakMap<readonly Primitive[], { text: PlanParts | null; noText: PlanParts | null }>();

/**
 * Abschnitte eines Plans; einmal je `plan.primitives` (und Modus) gebaut. `texts`: der eigene
 * Puffer trägt Texte/Bilder mit JSON (SVG-Export) — sonst nur deren Typ (Szene, Auswahl).
 */
export function planParts(plan: Plan, texts = false): PlanParts {
  const prims = plan.primitives;
  let c = cache.get(prims);
  if (!c) {
    c = { text: null, noText: null };
    cache.set(prims, c);
  }
  const hit = texts ? c.text : c.noText;
  if (hit) return hit;
  const runs = verifiedRuns(prims, plan.bufRuns);
  const bufs: HoldableBuf[] = [];
  const bufIdx = new Map<HoldableBuf, number>();
  const idx = (b: HoldableBuf): number => {
    let i = bufIdx.get(b);
    if (i === undefined) {
      i = bufs.length;
      bufs.push(b);
      bufIdx.set(b, i);
    }
    return i;
  };
  // Lücken zwischen den Kern-Abschnitten sammeln: [Plan-Start, Plan-Ende, Start im eigenen Puffer].
  const rest: Primitive[] = [];
  const gaps: Array<[number, number, number]> = [];
  let at = 0;
  const gap = (end: number) => {
    if (end <= at) return;
    gaps.push([at, end, rest.length]);
    for (let i = at; i < end; i++) rest.push(prims[i]);
  };
  for (const r of runs) {
    gap(r.start);
    at = r.end;
  }
  gap(prims.length);
  const own: HoldableBuf | null = rest.length ? { bytes: encodePlanBuf(rest, { textJson: texts }), hold: 0 } : null;
  const segs: number[] = [];
  let gi = 0;
  let ri = 0;
  // Abschnitte in Plan-Reihenfolge zusammenführen.
  while (gi < gaps.length || ri < runs.length) {
    const g = gaps[gi];
    const r = runs[ri];
    if (r === undefined || (g !== undefined && g[0] < r.start)) {
      segs.push(idx(own!), g[2], g[2] + (g[1] - g[0]));
      gi++;
    } else {
      segs.push(idx(r.buf), r.from, r.from + (r.end - r.start));
      ri++;
    }
  }
  const out: PlanParts = { bufs, segs, count: prims.length };
  if (texts) c.text = out;
  else c.noText = out;
  return out;
}

/** Gedimmte Bereiche flach (`Plan.greyedRanges`). */
export function greyedFlat(plan: Plan): Float64Array {
  const r = plan.greyedRanges ?? [];
  const out = new Float64Array(r.length * 2);
  r.forEach(([a, b], i) => {
    out[2 * i] = a;
    out[2 * i + 1] = b;
  });
  return out;
}

/** Abschnitte mit den Kern-Nummern der Puffer (legt fehlende ab). */
function heldSegs(parts: PlanParts, fresh: boolean): Float64Array {
  const c = core();
  for (const b of parts.bufs) if (!b.hold || (fresh && !c.plan_buf_is_held(b.hold))) b.hold = c.plan_buf_hold(b.bytes);
  const s = new Float64Array(parts.segs.length);
  for (let i = 0; i < parts.segs.length; i += 3) {
    s[i] = parts.bufs[parts.segs[i]].hold;
    s[i + 1] = parts.segs[i + 1];
    s[i + 2] = parts.segs[i + 2];
  }
  return s;
}

/**
 * Kern-Aufruf mit den gehaltenen Abschnitten. `call` liefert ein leeres Ergebnis, wenn ein
 * Puffer verdrängt ist — dann werden alle neu abgelegt und es wird einmal wiederholt.
 */
export function withPlanParts<T extends { length: number }>(parts: PlanParts, call: (segs: Float64Array) => T): T {
  const out = call(heldSegs(parts, false));
  if (out.length > 0 || parts.segs.length === 0) return out;
  return call(heldSegs(parts, true));
}
