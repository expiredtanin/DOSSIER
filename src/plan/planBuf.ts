/**
 * Plan-Puffer v2 ([K3d]): binäre Übergabe der Plan-Primitive zwischen Rust-Kern und TS — Format
 * und Bedeutung aller Felder stehen im Kopf von `src-tauri/core/src/plan_buf.rs` (hier gekürzt).
 * Der Kern schreibt ihn direkt aus der Plan-Erzeugung (Abfrage `planDomains`); TS liest ihn zu
 * `Primitive[]` ({@link decodePlanBuf}: Auswahl, Overlay, SVG/PDF/DXF) und schreibt ihn für
 * GPU-Chunks aus gemischten Listen ({@link encodePlanBuf}, `glPlanCompile.ts`). Die GPU-Kompilierung
 * liest Bereiche eines Kern-Puffers direkt (`compilePlanBufRange`), ohne Umweg über Objekte.
 *
 * ```text
 * Bytes: f64-Teil, dann UTF-16-Einheiten aller Texte
 * Kopf (16)  [MAGIC "PLB2", VERSION 2, flags (1 Hashes, 2 Ausmass), nStrings, nHatches, nHatchWords,
 *             nGroups, nPrims, nRecWords, nPool, nUnits, 0, minX, minY, maxX, maxY]
 * Strings    nStrings × [unitOff, unitLen]
 * Schraffur  nHatches × [jsonStr, Hatch]      (Hatch wie encodeHatch, Farbe = String-Index)
 * Gruppen    nGroups × [start, end)
 * Offsets    nPrims × Wortindex des Eintrags
 * Hashes     nPrims × Inhalts-Hash (nur Kern)
 * Primitive  [tag, flags, pickKind, pickStr, …]   1 polygon · 2 line · 3 arc · 4 drawingCircle ·
 *            5 drawingArc · 6 text · 7 drawingText · 8 drawingTextPath · 9 drawingImage (JSON) ·
 *            0 Platzhalter (nur `lean`)
 * Pool       Punkte, Strichmuster, Kantenlisten, Motive, weitere Ids
 * ```
 * Flags: 1 greyed gesetzt · 2 greyed · 4 opacity · 8 Linienzug · 16 Zickzack · 32 Motiv ·
 * 64 dash null · 128 dash Liste · 256 noStrokeEdges · 512 Farbe (line/arc) · 1024 weitere Ids.
 */

import type { HatchRender, Primitive } from "./generatePlan";
import type { Vec2 } from "../model/types";

export const PLAN_BUF_MAGIC = 0x504c4232;
export const PLAN_BUF_VERSION = 2;
/** Fehlerpuffer einer Kern-Abfrage ("PLBe"): `[ERR_MAGIC, nUnits]` + Meldung (UTF-16). */
export const PLAN_BUF_ERR_MAGIC = 0x504c4265;
const HEAD = 16;

const F_GREYED_SET = 1;
const F_GREYED = 2;
const F_OPACITY = 4;
const F_CHAIN = 8;
const F_ZIGZAG = 16;
const F_MOTIF = 32;
const F_DASH_NULL = 64;
const F_DASH_LIST = 128;
const F_NSE = 256;
const F_COLOR = 512;
const F_IDS = 1024;

/** Pick-Arten (Index + 1) = Feldname am Primitiv. */
const PICK_KEYS = [
  "wallId",
  "drawingId",
  "ceilingId",
  "openingId",
  "stairId",
  "roomId",
  "extrudedSolidId",
  "contextObjectId",
  "columnId",
  "roofId",
  "sectionLineId",
] as const;
type PickKey = (typeof PICK_KEYS)[number];

/** Wachsender `Float64Array`-Schreiber. */
class F64Writer {
  buf: Float64Array;
  length = 0;
  constructor(cap = 256) {
    this.buf = new Float64Array(cap);
  }
  private grow(need: number): void {
    let cap = this.buf.length * 2;
    while (cap < need) cap *= 2;
    const next = new Float64Array(cap);
    next.set(this.buf.subarray(0, this.length));
    this.buf = next;
  }
  push(v: number): void {
    if (this.length + 1 > this.buf.length) this.grow(this.length + 1);
    this.buf[this.length++] = v;
  }
  /** Platz für `n` weitere Werte; liefert den Startindex (danach direkt in `buf` schreiben). */
  reserve(n: number): number {
    if (this.length + n > this.buf.length) this.grow(this.length + n);
    const o = this.length;
    this.length += n;
    return o;
  }
  list(l: readonly number[] | null | undefined): void {
    const n = l ? l.length : 0;
    const o = this.reserve(n + 1);
    this.buf[o] = n;
    for (let i = 0; i < n; i++) this.buf[o + 1 + i] = l![i];
  }
  pts(p: readonly Vec2[]): void {
    const n = p.length;
    const o = this.reserve(2 * n + 1);
    const b = this.buf;
    b[o] = n;
    for (let i = 0; i < n; i++) {
      b[o + 1 + 2 * i] = p[i].x;
      b[o + 2 + 2 * i] = p[i].y;
    }
  }
}

const PATTERN_CODE: Record<string, number> = {
  none: 0,
  solid: 1,
  diagonal: 2,
  crosshatch: 3,
  insulation: 4,
  custom: 5,
  insulationHard: 6,
  insulationWave: 7,
  timber: 8,
  earth: 9,
  gravel: 10,
  stone: 11,
};

/** Ein Hatch-Datensatz (auch Eingabe der Einzel-Bindungen in `glPlanHatch.ts`). */
function writeHatch(w: F64Writer, h: HatchRender, colorIdx: number): void {
  let flags = 0;
  if (h.lines === "random") flags |= 1;
  if (h.origin != null) flags |= 2;
  if (h.seed != null) flags |= 4;
  if (h.density != null) flags |= 8;
  if (h.lengthMin != null) flags |= 16;
  if (h.lengthMax != null) flags |= 32;
  if (h.motif) flags |= 64;
  const o = w.reserve(13);
  const b = w.buf;
  b[o] = PATTERN_CODE[h.pattern] ?? 2;
  b[o + 1] = h.kind === "image" ? 1 : h.kind === "gradient" ? 2 : 0;
  b[o + 2] = flags;
  b[o + 3] = h.scale;
  b[o + 4] = h.angle;
  b[o + 5] = colorIdx;
  b[o + 6] = h.lineWeight;
  b[o + 7] = h.origin != null ? h.origin.x : 0;
  b[o + 8] = h.origin != null ? h.origin.y : 0;
  b[o + 9] = h.seed ?? 0;
  b[o + 10] = h.density ?? 0;
  b[o + 11] = h.lengthMin ?? 0;
  b[o + 12] = h.lengthMax ?? 0;
  w.list(h.dash);
  if (h.motif) {
    w.push(h.motif.length);
    w.pts(h.motif.points);
  }
}

/** Einzelne Schraffur kodieren (Farbe −1) — Eingabe der Schraffur-Bindungen des Kerns. */
export function encodeHatch(h: HatchRender): Float64Array {
  const w = new F64Writer(32);
  writeHatch(w, h, -1);
  return w.buf.subarray(0, w.length);
}

type LinePrim = Extract<Primitive, { kind: "line" }>;

const isPlainLine = (p: Primitive | undefined): p is LinePrim =>
  p !== undefined && p.kind === "line" && !p.zigzag && !p.motif;

/** Setzt `p` den Linienzug von `prev` fort (gleiches Element und gleicher Stil, lückenlos)? */
function chainsPrev(prev: Primitive | undefined, p: LinePrim): boolean {
  return (
    isPlainLine(prev) &&
    p.drawingId === prev.drawingId &&
    p.color === prev.color &&
    p.weightMm === prev.weightMm &&
    p.greyed === prev.greyed &&
    p.opacity === prev.opacity &&
    p.dash === prev.dash &&
    p.a.x === prev.b.x &&
    p.a.y === prev.b.y
  );
}

export interface EncodeOptions {
  /**
   * Nur für die GPU: ohne Pick-Ids, Linienklassen und Schraffur-JSON, Texte/Bilder als Platzhalter
   * (tag 0). Schneller; {@link decodePlanBuf} kann so einen Puffer nicht vollständig lesen.
   */
  lean?: boolean;
  /**
   * `false`: Texte/Bilder ohne JSON (String-Index −1), aber mit Typ und Pick-Ids — für Kern-
   * Verbraucher, die Texte nicht lesen (Render-Szene, Auswahl). {@link decodePlanBuf} kann so
   * einen Puffer nicht lesen. Standard `true`.
   */
  textJson?: boolean;
  /** `false`: Schraffuren ohne JSON (nur das Hatch-Format, wie `lean`). Standard `true`. */
  hatchJson?: boolean;
  /** Gruppen `[start, end)` in den Kopf schreiben. */
  groups?: ReadonlyArray<readonly [number, number]>;
  bounds?: readonly [number, number, number, number];
}

/** Primitive → Plan-Puffer v2 (Format s. Dateikopf). */
export function encodePlanBuf(prims: readonly Primitive[], opts: EncodeOptions = {}): Uint8Array {
  const lean = opts.lean === true;
  const textJson = opts.textJson !== false;
  const hatchJson = !lean && opts.hatchJson !== false;
  const strParts: string[] = [];
  const strTab = new F64Writer(64);
  const strIdx = new Map<string, number>();
  let units = 0;
  const str = (s: string | undefined): number => {
    if (s === undefined) return -1;
    let i = strIdx.get(s);
    if (i === undefined) {
      i = strTab.length >> 1;
      strTab.push(units);
      strTab.push(s.length);
      units += s.length;
      strParts.push(s);
      strIdx.set(s, i);
    }
    return i;
  };
  const hatchW = new F64Writer(64);
  const hatchIdx = new Map<HatchRender, number>();
  const hatch = (h: HatchRender | undefined): number => {
    if (!h) return -1;
    let i = hatchIdx.get(h);
    if (i === undefined) {
      i = hatchIdx.size;
      hatchW.push(hatchJson ? str(JSON.stringify(h)) : -1);
      writeHatch(hatchW, h, str(h.color));
      hatchIdx.set(h, i);
    }
    return i;
  };
  const offsets = new Float64Array(prims.length);
  const w = new F64Writer(Math.max(256, prims.length * 14));
  const pool = new F64Writer(Math.max(256, prims.length * 4));
  const poolList = (l: readonly number[]): void => {
    w.push(pool.length);
    w.push(l.length);
    const o = pool.reserve(l.length);
    for (let i = 0; i < l.length; i++) pool.buf[o + i] = l[i];
  };
  const poolPts = (p: readonly Vec2[]): void => {
    w.push(pool.length);
    w.push(p.length);
    const o = pool.reserve(2 * p.length);
    const b = pool.buf;
    for (let i = 0; i < p.length; i++) {
      b[o + 2 * i] = p[i].x;
      b[o + 2 * i + 1] = p[i].y;
    }
  };
  const styleFlags = (greyed: boolean | undefined, opacity: number | undefined): number =>
    (greyed === undefined ? 0 : greyed ? F_GREYED_SET | F_GREYED : F_GREYED_SET) | (opacity !== undefined ? F_OPACITY : 0);
  const dashFlags = (d: number[] | null | undefined): number => (d === null ? F_DASH_NULL : d ? F_DASH_LIST : 0);
  const op = (opacity: number | undefined): number => (opacity !== undefined ? opacity : 1);
  /** Kopf [tag, flags, pickKind, pickStr]; liefert die weiteren Ids. */
  const head = (tag: number, flags: number, p: Primitive): number[] | null => {
    let pk = 0;
    let ps = -1;
    let more: number[] | null = null;
    if (!lean) {
      const r = p as Partial<Record<PickKey, string>>;
      for (let k = 0; k < PICK_KEYS.length; k++) {
        const id = r[PICK_KEYS[k]];
        if (id === undefined) continue;
        if (pk === 0) {
          pk = k + 1;
          ps = str(id);
        } else (more ??= []).push(k + 1, str(id));
      }
    }
    const o = w.reserve(4);
    const b = w.buf;
    b[o] = tag;
    b[o + 1] = flags | (more ? F_IDS : 0);
    b[o + 2] = pk;
    b[o + 3] = ps;
    return more;
  };
  const tail = (more: number[] | null): void => {
    if (!more) return;
    w.push(pool.length);
    w.push(more.length / 2);
    for (const v of more) pool.push(v);
  };

  for (let i = 0; i < prims.length; i++) {
    const p = prims[i];
    offsets[i] = w.length;
    switch (p.kind) {
      case "polygon": {
        const more = head(1, styleFlags(p.greyed, p.opacity) | (p.noStrokeEdges ? F_NSE : 0), p);
        const fill = str(p.fill);
        const stroke = str(p.stroke);
        const h = hatch(p.hatch);
        const o = w.reserve(5);
        const b = w.buf;
        b[o] = fill;
        b[o + 1] = stroke;
        b[o + 2] = p.strokeWidthMm;
        b[o + 3] = h;
        b[o + 4] = op(p.opacity);
        poolPts(p.pts);
        if (p.noStrokeEdges) poolList(p.noStrokeEdges);
        tail(more);
        break;
      }
      case "line": {
        let flags = styleFlags(p.greyed, p.opacity) | dashFlags(p.dash);
        if (isPlainLine(p) && chainsPrev(prims[i - 1], p)) flags |= F_CHAIN;
        if (p.zigzag) flags |= F_ZIGZAG;
        if (p.motif) flags |= F_MOTIF;
        if (p.color !== undefined) flags |= F_COLOR;
        const more = head(2, flags, p);
        const cls = lean ? -1 : str(p.cls);
        const c = str(p.color);
        const o = w.reserve(8);
        const b = w.buf;
        b[o] = cls;
        b[o + 1] = c;
        b[o + 2] = p.weightMm;
        b[o + 3] = op(p.opacity);
        b[o + 4] = p.a.x;
        b[o + 5] = p.a.y;
        b[o + 6] = p.b.x;
        b[o + 7] = p.b.y;
        if (p.dash) poolList(p.dash);
        if (p.zigzag) {
          w.push(p.zigzag.amplitude);
          w.push(p.zigzag.wavelength);
        }
        if (p.motif) {
          w.push(p.motif.length);
          poolPts(p.motif.points);
        }
        tail(more);
        break;
      }
      case "arc": {
        const color = (p as { color?: string }).color;
        const more = head(3, styleFlags(p.greyed, p.opacity) | dashFlags(p.dash) | (color !== undefined ? F_COLOR : 0), p);
        const cls = lean ? -1 : str(p.cls);
        const c = str(color);
        const o = w.reserve(11);
        const b = w.buf;
        b[o] = cls;
        b[o + 1] = c;
        b[o + 2] = p.weightMm;
        b[o + 3] = op(p.opacity);
        b[o + 4] = p.center.x;
        b[o + 5] = p.center.y;
        b[o + 6] = p.from.x;
        b[o + 7] = p.from.y;
        b[o + 8] = p.to.x;
        b[o + 9] = p.to.y;
        b[o + 10] = p.r;
        if (p.dash) poolList(p.dash);
        tail(more);
        break;
      }
      case "drawingCircle": {
        const more = head(4, styleFlags(p.greyed, p.opacity) | dashFlags(p.dash), p);
        const fill = str(p.fill);
        const stroke = str(p.stroke);
        const o = w.reserve(7);
        const b = w.buf;
        b[o] = fill;
        b[o + 1] = stroke;
        b[o + 2] = p.weightMm;
        b[o + 3] = op(p.opacity);
        b[o + 4] = p.center.x;
        b[o + 5] = p.center.y;
        b[o + 6] = p.r;
        if (p.dash) poolList(p.dash);
        tail(more);
        break;
      }
      case "drawingArc": {
        const more = head(5, styleFlags(p.greyed, p.opacity) | dashFlags(p.dash), p);
        const stroke = str(p.stroke);
        const o = w.reserve(8);
        const b = w.buf;
        b[o] = stroke;
        b[o + 1] = p.weightMm;
        b[o + 2] = op(p.opacity);
        b[o + 3] = p.center.x;
        b[o + 4] = p.center.y;
        b[o + 5] = p.r;
        b[o + 6] = p.a0;
        b[o + 7] = p.a1;
        if (p.dash) poolList(p.dash);
        tail(more);
        break;
      }
      default: {
        if (lean) {
          head(0, 0, p);
          break;
        }
        const tag = p.kind === "text" ? 6 : p.kind === "drawingText" ? 7 : p.kind === "drawingTextPath" ? 8 : 9;
        head(tag, 0, p);
        w.push(textJson ? str(JSON.stringify(p)) : -1);
      }
    }
  }

  const groups = opts.groups ?? [];
  const nStrings = strTab.length >> 1;
  const nF64 = HEAD + strTab.length + hatchW.length + 2 * groups.length + prims.length + w.length + pool.length;
  const out = new ArrayBuffer(nF64 * 8 + units * 2);
  const f = new Float64Array(out, 0, nF64);
  const bounds = opts.bounds;
  f.set([
    PLAN_BUF_MAGIC,
    PLAN_BUF_VERSION,
    bounds ? 2 : 0,
    nStrings,
    hatchIdx.size,
    hatchW.length,
    groups.length,
    prims.length,
    w.length,
    pool.length,
    units,
    0,
    bounds ? bounds[0] : 0,
    bounds ? bounds[1] : 0,
    bounds ? bounds[2] : 0,
    bounds ? bounds[3] : 0,
  ]);
  let k = HEAD;
  f.set(strTab.buf.subarray(0, strTab.length), k);
  k += strTab.length;
  f.set(hatchW.buf.subarray(0, hatchW.length), k);
  k += hatchW.length;
  for (const [a, b] of groups) {
    f[k++] = a;
    f[k++] = b;
  }
  f.set(offsets, k);
  k += prims.length;
  f.set(w.buf.subarray(0, w.length), k);
  k += w.length;
  f.set(pool.buf.subarray(0, pool.length), k);
  if (units > 0) {
    const u = new Uint16Array(out, nF64 * 8, units);
    let j = 0;
    for (const s of strParts) for (let c = 0; c < s.length; c++) u[j++] = s.charCodeAt(c);
  }
  return new Uint8Array(out);
}

/**
 * Gelesener Plan-Puffer (Kern-Ergebnis); `bytes` bleibt für die GPU-Kompilierung erhalten.
 * Die Primitive entstehen erst bei Bedarf ([K3d]): `prim(i)` liest einen Eintrag, `prims` alle
 * (dieselben Objekte — einmal gelesen, bleibt ein Eintrag dasselbe Objekt).
 */
export interface DecodedPlanBuf {
  bytes: Uint8Array;
  /** Alle Primitive (beim ersten Zugriff gelesen). */
  readonly prims: Primitive[];
  /** Anzahl Einträge. */
  count: number;
  /** Eintrag `i` als Primitiv (gelesen bei Bedarf, danach gemerkt). */
  prim(i: number): Primitive;
  /** Typ-Kennung des Eintrags `i` (1 polygon · 2 line · … · 6 text · 7 drawingText · 8 drawingTextPath · 9 drawingImage). */
  tag(i: number): number;
  groups: Array<[number, number]>;
  bounds?: [number, number, number, number];
  /** Inhalts-Hash je Primitiv (vom Kern; Schlüssel des GPU-Chunk-Caches) oder null. */
  hashes: Float64Array | null;
  /** Nummer des im Kern gehaltenen Puffers (0 = keiner), s. `compilePlanBufRange`. */
  hold: number;
}

function unitsToString(u: Uint16Array): string {
  let s = "";
  for (let i = 0; i < u.length; i += 8192) {
    s += String.fromCharCode.apply(null, u.subarray(i, Math.min(u.length, i + 8192)) as unknown as number[]);
  }
  return s;
}

function bad(why: string): never {
  throw new Error(`Plan-Puffer unlesbar: ${why}`);
}

/**
 * Plan-Puffer → Primitive (in der JSON-Form, die der Kern früher lieferte: gleiche Felder, gleiche
 * Reihenfolge). Wirft bei einem Fehlerpuffer des Kerns (mit dessen Meldung) oder kaputtem Puffer.
 */
export function decodePlanBuf(input: Uint8Array): DecodedPlanBuf {
  const bytes = input.byteOffset % 8 === 0 ? input : input.slice();
  if (bytes.byteLength >= 16) {
    const h = new Float64Array(bytes.buffer, bytes.byteOffset, 2);
    if (h[0] === PLAN_BUF_ERR_MAGIC) {
      const n = h[1];
      throw new Error(unitsToString(new Uint16Array(bytes.buffer, bytes.byteOffset + 16, Math.min(n, (bytes.byteLength - 16) >> 1))));
    }
  }
  if (bytes.byteLength < HEAD * 8) bad("zu kurz");
  const hd = new Float64Array(bytes.buffer, bytes.byteOffset, HEAD);
  if (hd[0] !== PLAN_BUF_MAGIC || hd[1] !== PLAN_BUF_VERSION) bad("fremde Version");
  const [, , flags, nStrings, nHatches, nHatchWords, nGroups, nPrims, nRec, nPool, nUnits] = hd;
  const hashes = (flags & 1) !== 0;
  const strAt = HEAD;
  const hatchAt = strAt + 2 * nStrings;
  const groupAt = hatchAt + nHatchWords;
  const offAt = groupAt + 2 * nGroups;
  const hashAt = offAt + nPrims;
  const recAt = hashAt + (hashes ? nPrims : 0);
  const poolAt = recAt + nRec;
  const nF64 = poolAt + nPool;
  if (!Number.isInteger(nF64) || bytes.byteLength !== nF64 * 8 + nUnits * 2) bad("Länge");
  const f = new Float64Array(bytes.buffer, bytes.byteOffset, nF64);
  // Texte erst beim ersten Zugriff als ein String gelesen.
  let all: string | null = null;
  const strs: Array<string | undefined> = new Array(nStrings);
  const S = (i: number): string => {
    let s = strs[i];
    if (s === undefined) {
      all ??= unitsToString(new Uint16Array(bytes.buffer, bytes.byteOffset + nF64 * 8, nUnits));
      const o = f[strAt + 2 * i];
      s = all.slice(o, o + f[strAt + 2 * i + 1]);
      strs[i] = s;
    }
    return s;
  };
  // Schraffuren: einmal je Eintrag aus dem JSON (geteilt von allen Polygonen).
  // JSON je Schraffur erst beim ersten Polygon, das sie braucht (dann geteilt).
  const hatchJs: number[] = [];
  const hatchObjs: Array<HatchRender | undefined> = new Array(nHatches);
  const hatchAtIdx = (h: number): HatchRender => {
    let o = hatchObjs[h];
    if (o === undefined) {
      const js = hatchJs[h];
      o = js >= 0 ? (JSON.parse(S(js)) as HatchRender) : (undefined as unknown as HatchRender);
      hatchObjs[h] = o;
    }
    return o;
  };
  let k = hatchAt;
  for (let i = 0; i < nHatches; i++) {
    // [jsonStr, pattern, kind, flags, scale, angle, color, lineWeight, ox, oy, seed, density,
    //  lengthMin, lengthMax, nDash, dash…, (Motiv: length, nPts, x,y…)]
    hatchJs.push(f[k]);
    const hf = f[k + 3];
    k += 15 + f[k + 14];
    if (hf & 64) k += 2 + 2 * f[k + 1];
    if (!(k <= groupAt)) bad("Schraffuren");
  }
  if (k !== groupAt) bad("Schraffuren");
  const groups: Array<[number, number]> = [];
  for (let g = 0; g < nGroups; g++) groups.push([f[groupAt + 2 * g], f[groupAt + 2 * g + 1]]);
  const pts = (o: number, n: number): Vec2[] => {
    const out: Vec2[] = new Array(n);
    const b = poolAt + o;
    for (let i = 0; i < n; i++) out[i] = { x: f[b + 2 * i], y: f[b + 2 * i + 1] };
    return out;
  };
  const list = (o: number, n: number): number[] => {
    const out: number[] = new Array(n);
    const b = poolAt + o;
    for (let i = 0; i < n; i++) out[i] = f[b + i];
    return out;
  };
  /** Pick-Ids in Art-Reihenfolge (= Feldreihenfolge der Kern-JSON-Form). */
  const setIds = (o: Record<string, unknown>, pk: number, ps: number, fl: number, tailAt: number): void => {
    if (!(fl & F_IDS)) {
      o[PICK_KEYS[pk - 1]] = S(ps);
      return;
    }
    const found: Array<[number, string]> = [[pk, S(ps)]];
    const po = poolAt + f[tailAt];
    const n = f[tailAt + 1];
    for (let j = 0; j < n; j++) found.push([f[po + 2 * j], S(f[po + 2 * j + 1])]);
    found.sort((a, b) => a[0] - b[0]);
    for (const [kk, id] of found) o[PICK_KEYS[kk - 1]] = id;
  };
  const read = (i: number): Primitive => {
    let r = recAt + f[offAt + i];
    const tag = f[r];
    const fl = f[r + 1];
    const pk = f[r + 2];
    const ps = f[r + 3];
    r += 4;
    let o: Record<string, unknown>;
    switch (tag) {
      case 1: {
        o = { kind: "polygon", pts: pts(f[r + 5], f[r + 6]), fill: S(f[r]), stroke: S(f[r + 1]), strokeWidthMm: f[r + 2] };
        if (f[r + 3] >= 0) o.hatch = hatchAtIdx(f[r + 3]);
        if (fl & F_GREYED_SET) o.greyed = (fl & F_GREYED) !== 0;
        if (fl & F_OPACITY) o.opacity = f[r + 4];
        let t = r + 7;
        if (fl & F_NSE) {
          o.noStrokeEdges = list(f[t], f[t + 1]);
          t += 2;
        }
        if (pk > 0 || fl & F_IDS) setIds(o, pk, ps, fl, t);
        break;
      }
      case 2: {
        o = { kind: "line", a: { x: f[r + 4], y: f[r + 5] }, b: { x: f[r + 6], y: f[r + 7] }, cls: S(f[r]), weightMm: f[r + 2] };
        let t = r + 8;
        if (fl & F_DASH_NULL) o.dash = null;
        else if (fl & F_DASH_LIST) {
          o.dash = list(f[t], f[t + 1]);
          t += 2;
        }
        if (fl & F_ZIGZAG) {
          o.zigzag = { amplitude: f[t], wavelength: f[t + 1] };
          t += 2;
        }
        if (fl & F_MOTIF) {
          o.motif = { points: pts(f[t + 1], f[t + 2]), length: f[t] };
          t += 3;
        }
        if (fl & F_COLOR) o.color = S(f[r + 1]);
        if (pk > 0 || fl & F_IDS) setIds(o, pk, ps, fl, t);
        if (fl & F_GREYED_SET) o.greyed = (fl & F_GREYED) !== 0;
        if (fl & F_OPACITY) o.opacity = f[r + 3];
        break;
      }
      case 3: {
        o = {
          kind: "arc",
          center: { x: f[r + 4], y: f[r + 5] },
          from: { x: f[r + 6], y: f[r + 7] },
          to: { x: f[r + 8], y: f[r + 9] },
          r: f[r + 10],
          cls: S(f[r]),
          weightMm: f[r + 2],
        };
        let t = r + 11;
        if (fl & F_DASH_NULL) o.dash = null;
        else if (fl & F_DASH_LIST) {
          o.dash = list(f[t], f[t + 1]);
          t += 2;
        }
        if (fl & F_COLOR) o.color = S(f[r + 1]);
        if (pk > 0 || fl & F_IDS) setIds(o, pk, ps, fl, t);
        if (fl & F_GREYED_SET) o.greyed = (fl & F_GREYED) !== 0;
        if (fl & F_OPACITY) o.opacity = f[r + 3];
        break;
      }
      case 4: {
        o = { kind: "drawingCircle", center: { x: f[r + 4], y: f[r + 5] }, r: f[r + 6], fill: S(f[r]), stroke: S(f[r + 1]), weightMm: f[r + 2] };
        let t = r + 7;
        if (fl & F_DASH_NULL) o.dash = null;
        else if (fl & F_DASH_LIST) {
          o.dash = list(f[t], f[t + 1]);
          t += 2;
        }
        if (pk > 0 || fl & F_IDS) setIds(o, pk, ps, fl, t);
        if (fl & F_GREYED_SET) o.greyed = (fl & F_GREYED) !== 0;
        if (fl & F_OPACITY) o.opacity = f[r + 3];
        break;
      }
      case 5: {
        o = { kind: "drawingArc", center: { x: f[r + 3], y: f[r + 4] }, r: f[r + 5], a0: f[r + 6], a1: f[r + 7], stroke: S(f[r]), weightMm: f[r + 1] };
        let t = r + 8;
        if (fl & F_DASH_NULL) o.dash = null;
        else if (fl & F_DASH_LIST) {
          o.dash = list(f[t], f[t + 1]);
          t += 2;
        }
        if (pk > 0 || fl & F_IDS) setIds(o, pk, ps, fl, t);
        if (fl & F_GREYED_SET) o.greyed = (fl & F_GREYED) !== 0;
        if (fl & F_OPACITY) o.opacity = f[r + 2];
        break;
      }
      case 6:
      case 7:
      case 8:
      case 9:
        o = JSON.parse(S(f[r])) as Record<string, unknown>;
        break;
      default:
        bad(`Primitiv-Typ ${tag}`);
    }
    return o as unknown as Primitive;
  };
  // Einmal gelesene Einträge bleiben dieselben Objekte (Identität zählt für `Plan.bufRuns`).
  const cache: Array<Primitive | undefined> = new Array(nPrims);
  const prim = (i: number): Primitive => {
    if (!(i >= 0 && i < nPrims)) bad(`Eintrag ${i}`);
    let p = cache[i];
    if (p === undefined) {
      p = read(i);
      cache[i] = p;
    }
    return p;
  };
  let allPrims: Primitive[] | null = null;
  return {
    bytes,
    get prims(): Primitive[] {
      if (!allPrims) {
        const out: Primitive[] = new Array(nPrims);
        for (let i = 0; i < nPrims; i++) out[i] = prim(i);
        allPrims = out;
      }
      return allPrims;
    },
    count: nPrims,
    prim,
    tag: (i: number): number => f[recAt + f[offAt + i]],
    groups,
    bounds: flags & 2 ? [hd[12], hd[13], hd[14], hd[15]] : undefined,
    hashes: hashes ? new Float64Array(bytes.buffer, bytes.byteOffset + hashAt * 8, nPrims) : null,
    hold: 0,
  };
}
