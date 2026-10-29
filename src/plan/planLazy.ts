/**
 * Plan mit lazy gelesenen Primitiven ([K3d]): `generatePlan` setzt einen Plan aus Stücken zusammen
 * — Abschnitten eines Kern-Plan-Puffers (`planDomains`) und Listen, die TS selbst erzeugt
 * (2D-Zeichnungen, Schatten, Baurecht). `plan.primitives` entsteht erst beim ersten Zugriff; die
 * Verbraucher im Kern (Szene, Auswahl, Fang, SVG, DXF) lesen die Stücke direkt (`planParts.ts`),
 * Einzelzugriffe gehen über {@link planPrimAt}, Texte/Bilder über {@link planTextEntries}.
 *
 * Wer einen Plan umbaut (`{ ...plan, primitives: … }`), bekommt einen gewöhnlichen Plan; die
 * Stücke gelten nur für das Objekt, das {@link lazyPlan} erzeugt hat. Die gelesene Liste
 * `primitives` eines solchen Plans wird nicht verändert (Konvention wie bei allen Plänen).
 */

import type { Plan, PlanBufRun, Primitive } from "./generatePlan";
import type { DecodedPlanBuf } from "./planBuf";

/** Abschnitt `[from, to)` eines Kern-Puffers. */
export interface BufPiece {
  buf: DecodedPlanBuf;
  from: number;
  to: number;
}

/** Ein Stück: Kern-Abschnitt oder eine Liste von TS-Primitiven. */
export type PlanPiece = BufPiece | readonly Primitive[];

export function isBufPiece(p: PlanPiece): p is BufPiece {
  return !Array.isArray(p);
}

const pieceLen = (p: PlanPiece): number => (isBufPiece(p) ? p.to - p.from : p.length);

interface LazyState {
  pieces: PlanPiece[];
  /** Erster Plan-Index je Stück. */
  starts: number[];
  count: number;
}

const lazyState = new WeakMap<Plan, LazyState>();
/** Lazy Pläne, deren `primitives` schon gelesen wurden. */
const readPlans = new WeakSet<Plan>();

/**
 * Plan aus Stücken; `primitives` wird beim ersten Zugriff gelesen (und bleibt dann dieselbe
 * Liste). `bufRuns` folgen aus den Kern-Abschnitten.
 */
export function lazyPlan(rest: Omit<Plan, "primitives" | "bufRuns">, pieces: readonly PlanPiece[]): Plan {
  const ps: PlanPiece[] = [];
  for (const p of pieces) {
    // Leere Stücke weglassen; Kern-Abschnitte bleiben getrennt wie erzeugt (Chunk-Grenzen der GPU).
    if (pieceLen(p) > 0) ps.push(p);
  }
  const starts: number[] = [];
  const runs: PlanBufRun[] = [];
  let count = 0;
  for (const p of ps) {
    starts.push(count);
    if (isBufPiece(p)) runs.push({ at: count, buf: p.buf, from: p.from, to: p.to });
    count += pieceLen(p);
  }
  const plan = {} as Plan;
  let mat: Primitive[] | null = null;
  Object.defineProperty(plan, "primitives", {
    enumerable: true,
    configurable: true,
    get(): Primitive[] {
      if (!mat) {
        const out: Primitive[] = new Array(count);
        let k = 0;
        for (const p of ps) {
          if (isBufPiece(p)) {
            for (let i = p.from; i < p.to; i++) out[k++] = p.buf.prim(i);
          } else {
            for (const q of p) out[k++] = q;
          }
        }
        mat = out;
        readPlans.add(plan);
      }
      return mat;
    },
    set(v: Primitive[]) {
      // Ersetzt: ab jetzt ein gewöhnlicher Plan.
      Object.defineProperty(plan, "primitives", { value: v, writable: true, enumerable: true, configurable: true });
      lazyState.delete(plan);
    },
  });
  Object.assign(plan, rest);
  if (runs.length) plan.bufRuns = runs;
  else delete plan.bufRuns;
  lazyState.set(plan, { pieces: ps, starts, count });
  return plan;
}

/** Stücke eines lazy Plans (oder null bei einem gewöhnlichen Plan). */
export function lazyPieces(plan: Plan): readonly PlanPiece[] | null {
  return lazyState.get(plan)?.pieces ?? null;
}

/** Ist `plan` ein lazy Plan, dessen `primitives` noch nicht gelesen wurden? (Messung/Tests.) */
export function isLazyUnread(plan: Plan): boolean {
  return lazyState.has(plan) && !readPlans.has(plan);
}

/**
 * Stücke eines beliebigen Plans: lazy → seine Stücke; sonst die Liste, an den (per
 * Objekt-Identität geprüften) Kern-Abschnitten `bufRuns` zerlegt.
 */
export function piecesOf(plan: Plan): readonly PlanPiece[] {
  const lazy = lazyPieces(plan);
  if (lazy) return lazy;
  const prims = plan.primitives;
  const out: PlanPiece[] = [];
  let at = 0;
  const runs = [...(plan.bufRuns ?? [])].sort((a, b) => a.at - b.at);
  for (const r of runs) {
    if (r.at < at) continue;
    const n = Math.min(r.to - r.from, prims.length - r.at);
    let ok = n > 0;
    for (let k = 0; ok && k < n; k++) ok = prims[r.at + k] === r.buf.prims[r.from + k];
    if (!ok) continue;
    if (r.at > at) out.push(prims.slice(at, r.at));
    out.push({ buf: r.buf, from: r.from, to: r.from + n });
    at = r.at + n;
  }
  if (at < prims.length) out.push(at === 0 ? prims : prims.slice(at));
  return out;
}

/** Anzahl Primitive (ohne sie zu lesen). */
export function planCount(plan: Plan): number {
  const s = lazyState.get(plan);
  return s ? s.count : plan.primitives.length;
}

/** Primitiv `i` (bei einem lazy Plan nur dieser Eintrag gelesen); `undefined` ausserhalb. */
export function planPrimAt(plan: Plan, i: number): Primitive | undefined {
  const s = lazyState.get(plan);
  if (!s) return plan.primitives[i];
  if (!(i >= 0 && i < s.count) || !Number.isInteger(i)) return undefined;
  // Letztes Stück mit Start ≤ i.
  let lo = 0;
  let hi = s.starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (s.starts[mid] <= i) lo = mid;
    else hi = mid - 1;
  }
  const p = s.pieces[lo];
  const k = i - s.starts[lo];
  return isBufPiece(p) ? p.buf.prim(p.from + k) : p[k];
}

/** Text-/Bild-Primitive (`text`, `drawingText`, `drawingTextPath`, `drawingImage`). */
export type TextEntryPrim = Extract<Primitive, { kind: "text" | "drawingText" | "drawingTextPath" | "drawingImage" }>;

/** Typ-Kennungen der Text-/Bild-Einträge im Plan-Puffer (6…9, s. `plan_buf.rs`). */
const TEXT_TAG_MIN = 6;
const TEXT_TAG_MAX = 9;

const isTextKind = (p: Primitive): p is TextEntryPrim =>
  p.kind === "text" || p.kind === "drawingText" || p.kind === "drawingTextPath" || p.kind === "drawingImage";

const textCache = new WeakMap<Plan, ReadonlyArray<{ i: number; p: TextEntryPrim }>>();

/**
 * Text- und Bild-Einträge eines Plans in Zeichenreihenfolge mit ihrem Plan-Index — bei einem
 * lazy Plan aus den Typ-Kennungen der Puffer gelesen (nur diese Einträge werden dekodiert).
 * Einmal je Plan.
 */
export function planTextEntries(plan: Plan): ReadonlyArray<{ i: number; p: TextEntryPrim }> {
  let out = textCache.get(plan);
  if (out) return out;
  const list: Array<{ i: number; p: TextEntryPrim }> = [];
  const s = lazyState.get(plan);
  if (s) {
    s.pieces.forEach((pc, n) => {
      const at = s.starts[n];
      if (isBufPiece(pc)) {
        for (let j = pc.from; j < pc.to; j++) {
          const t = pc.buf.tag(j);
          if (t >= TEXT_TAG_MIN && t <= TEXT_TAG_MAX) list.push({ i: at + j - pc.from, p: pc.buf.prim(j) as TextEntryPrim });
        }
      } else {
        pc.forEach((p, k) => {
          if (isTextKind(p)) list.push({ i: at + k, p });
        });
      }
    });
  } else {
    plan.primitives.forEach((p, i) => {
      if (isTextKind(p)) list.push({ i, p });
    });
  }
  out = list;
  textCache.set(plan, out);
  return out;
}

/**
 * Plan um Primitive davor/danach ergänzt, ohne die Primitive des Plans zu lesen (Überlagerungen
 * der Ansicht). Gedimmte Bereiche wandern mit.
 */
export function planWithExtra(plan: Plan, before: readonly Primitive[], after: readonly Primitive[], patch: Partial<Omit<Plan, "primitives" | "bufRuns">> = {}): Plan {
  const rest = planFields(plan);
  const shift = before.length;
  const greyed = plan.greyedRanges?.map(([a, b]): [number, number] => [a + shift, b + shift]);
  return lazyPlan({ ...rest, ...(greyed ? { greyedRanges: greyed } : {}), ...patch }, [before, ...piecesOf(plan), after]);
}

/** Alle Felder eines Plans ausser `primitives` und `bufRuns`, ohne den Getter auszulösen. */
export function planFields(plan: Plan): Omit<Plan, "primitives" | "bufRuns"> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(plan)) if (k !== "primitives" && k !== "bufRuns") out[k] = (plan as unknown as Record<string, unknown>)[k];
  return out as unknown as Omit<Plan, "primitives" | "bufRuns">;
}
