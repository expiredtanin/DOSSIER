// Differential-Paritaet: Rust-WASM-Kernel (`src-tauri/kernel2d`, Feature "web")
// gegen die TS-Referenz `kernel2d.ts` — auf identischen Eingaben muessen beide
// bis auf ein funktionsspezifisches Epsilon dasselbe liefern (siehe PORT_PLAN §5).
// Kern der Migration: beweist, dass der Port die Semantik bitnah erhaelt.
//
// VORAUSSETZUNG: `npm run build:kernel2d` muss vorher gelaufen sein (das Paket
// `src/engine/pkgKernel2d` ist git-ignoriert). Init synchron via `initSync` mit
// den WASM-Bytes aus `readFileSync` (kein fetch im Node-Lauf).
//
// Zwei Testklassen, NIE gemischt: Zufalls-Paritaet (naiv==naiv) und Golden
// (explizite Grenzfaelle). Robuste Praedikate sind hier NICHT im Spiel (v1).

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

import type { Vec2 } from "../model/types";
import {
  circleCircleIntersect,
  closestPointOnSegment,
  extendSegment,
  filletCorner,
  isCCW,
  joinChains,
  lineCircleIntersect,
  lineSegmentIntersect,
  offsetPolyline,
  offsetSegment,
  pointSegmentDistance,
  projectParam,
  removeSegment,
  segmentCircleIntersect,
  segmentIntersect,
  segmentPolylineHits,
  signedArea,
  splitAtIntersections,
  splitClosedByChord,
  splitPolylineAtParam,
  splitSegmentByCutters,
  trimPolyline,
  trimSegment,
  type Fillet,
  type Hit,
} from "./kernel2d";
import {
  ceilingArea,
  isValidOutline,
  normalizeOutline,
  outlineBBox,
  outlineCentroid,
  pointInOutline,
} from "./ceiling";
import { centroid, perimeter, polygonArea } from "./roomArea";
import {
  defaultStepCount,
  pointHitsStair,
  pointInPolygon as stairPointInPolygon,
  stairBBox,
  stairCut,
  stairGeometry,
  type StairGeometry as TSStairGeometry,
} from "./stair";
import type { Stair } from "../model/types";
import {
  detectRooms,
  pointInPolygon as rbPointInPolygon,
  roomFromPointInside,
  roomFromPointInsideFaces,
  type WallSegment,
  type WallFace,
} from "./roomBoundary";

type Poly = { pts: Vec2[]; closed: boolean };

// Das WASM-Paket ist git-ignoriert und wird nur von `npm run build:kernel2d`
// erzeugt. Fehlt es, wird die Suite SAUBER uebersprungen (statt Collection-Fehler),
// damit `vitest run` ohne vorherigen WASM-Build gruen bleibt. Darum dynamischer
// Import erst in `beforeAll` (kein statischer Top-Level-Import des Pakets).
type Batch = (json: string) => string;
const wasmPath = fileURLToPath(
  new URL("../engine/pkgKernel2d/kernel2d_bg.wasm", import.meta.url),
);
const built = existsSync(wasmPath);
let K: Record<string, Batch>;

beforeAll(async () => {
  if (!built) return;
  const m = await import("../engine/pkgKernel2d/kernel2d.js");
  (m as { initSync: (o: { module: Buffer }) => unknown }).initSync({
    module: readFileSync(wasmPath),
  });
  K = m as unknown as Record<string, Batch>;
});

if (!built) {
  // eslint-disable-next-line no-console
  console.warn(
    "[kernel2d.parity] pkgKernel2d fehlt — `npm run build:kernel2d` fuer den Diff-Test noetig. Uebersprungen.",
  );
}

// ── Seed-basierter RNG (mulberry32), deterministisch ─────────────────────────
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Koordinate in [-100,100] m, mit Clustern nahe 0 und im 1e-6..1e-3-Bereich. */
function coord(rng: () => number): number {
  const r = rng();
  if (r < 0.15) return (rng() * 2 - 1) * 1e-3; // nahe 0
  if (r < 0.25) return (rng() * 2 - 1) * 1e-6 + Math.round(rng() * 4 - 2); // Schwellen
  return (rng() * 2 - 1) * 100;
}
const v = (rng: () => number): Vec2 => ({ x: coord(rng), y: coord(rng) });

/** Zwei sich garantiert schneidende Strecken um ein Zentrum c. */
function crossingSegs(rng: () => number) {
  const c = v(rng);
  const ang1 = rng() * Math.PI;
  const ang2 = ang1 + 0.2 + rng() * (Math.PI - 0.4); // nicht (fast) parallel
  const d1 = { x: Math.cos(ang1), y: Math.sin(ang1) };
  const d2 = { x: Math.cos(ang2), y: Math.sin(ang2) };
  const ext = () => 0.1 + rng() * 3;
  return {
    a1: { x: c.x - d1.x * ext(), y: c.y - d1.y * ext() },
    a2: { x: c.x + d1.x * ext(), y: c.y + d1.y * ext() },
    b1: { x: c.x - d2.x * ext(), y: c.y - d2.y * ext() },
    b2: { x: c.x + d2.x * ext(), y: c.y + d2.y * ext() },
  };
}

// ── Vergleichs-Helfer (Struktur zuerst, dann Werte mit op-Epsilon) ───────────
/** Abs-ODER-relative Toleranz: eng bei ~1, skaliert bei grossen Werten. */
function closeNum(a: number, b: number, rel = 1e-9): boolean {
  return Math.abs(a - b) <= rel * Math.max(1, Math.abs(a), Math.abs(b));
}
function closeVec(a: Vec2, b: Vec2, rel = 1e-9): boolean {
  return closeNum(a.x, b.x, rel) && closeNum(a.y, b.y, rel);
}
function closeHit(a: Hit, b: Hit): boolean {
  return closeVec(a.point, b.point) && closeNum(a.t, b.t) && closeNum(a.s, b.s);
}
function eqPts(w: Vec2[], t: Vec2[]): boolean {
  return w.length === t.length && t.every((p, i) => closeVec(w[i], p));
}
function eqPtsLists(w: Vec2[][], t: Vec2[][]): boolean {
  return w.length === t.length && t.every((s, i) => eqPts(w[i], s));
}
function eqPolyList(w: Poly[], t: Poly[]): boolean {
  return w.length === t.length && t.every((pl, i) => w[i].closed === pl.closed && eqPts(w[i].pts, pl.pts));
}
function eqPairs(w: [Vec2, Vec2][], t: [Vec2, Vec2][]): boolean {
  return w.length === t.length && t.every((pr, i) => closeVec(w[i][0], pr[0]) && closeVec(w[i][1], pr[1]));
}
/** Ein paar lange Schneider-Segmente quer durch die BBox (als offene Cutter). */
function genCutters(rng: () => number): Poly[] {
  const k = 1 + Math.floor(rng() * 3);
  return Array.from({ length: k }, () => ({
    pts: [
      { x: -80, y: (rng() * 2 - 1) * 60 },
      { x: 80, y: (rng() * 2 - 1) * 60 },
    ],
    closed: false,
  }));
}
function genPolyline(rng: () => number, minN: number, maxN: number): Vec2[] {
  const n = minN + Math.floor(rng() * (maxN - minN + 1));
  return Array.from({ length: n }, () => ({ x: (rng() * 2 - 1) * 50, y: (rng() * 2 - 1) * 50 }));
}

const N = 300;

describe.skipIf(!built)("kernel2d Rust-WASM ⇄ TS Paritaet — Zufall", () => {
  it("projectParam / closestPointOnSegment / pointSegmentDistance", () => {
    const rng = mulberry32(1);
    const qs = Array.from({ length: N }, () => ({ p: v(rng), a: v(rng), b: v(rng) }));

    const wProj = JSON.parse(K.project_param_batch_json(JSON.stringify(qs))) as number[];
    const wClose = JSON.parse(K.closest_point_batch_json(JSON.stringify(qs))) as Vec2[];
    const wDist = JSON.parse(K.point_segment_distance_batch_json(JSON.stringify(qs))) as number[];

    qs.forEach((q, i) => {
      expect(closeNum(wProj[i], projectParam(q.p, q.a, q.b)), `proj#${i}`).toBe(true);
      expect(closeVec(wClose[i], closestPointOnSegment(q.p, q.a, q.b)), `close#${i}`).toBe(true);
      expect(closeNum(wDist[i], pointSegmentDistance(q.p, q.a, q.b)), `dist#${i}`).toBe(true);
    });
  });

  it("segmentIntersect / lineSegmentIntersect (Zufall + garantierte Kreuzungen)", () => {
    const rng = mulberry32(2);
    const qs = Array.from({ length: N }, (_, i) =>
      i % 2 === 0
        ? { a1: v(rng), a2: v(rng), b1: v(rng), b2: v(rng) }
        : crossingSegs(rng),
    );
    const wSeg = JSON.parse(K.segment_intersect_batch_json(JSON.stringify(qs))) as (Hit | null)[];
    const wLine = JSON.parse(K.line_segment_intersect_batch_json(JSON.stringify(qs))) as (Hit | null)[];

    let hits = 0;
    qs.forEach((q, i) => {
      const t = segmentIntersect(q.a1, q.a2, q.b1, q.b2);
      // Struktur exakt: null ⇔ null.
      expect(wSeg[i] === null, `seg-null#${i}`).toBe(t === null);
      if (t && wSeg[i]) {
        expect(closeHit(wSeg[i]!, t), `seg#${i}`).toBe(true);
        hits++;
      }
      const tl = lineSegmentIntersect(q.a1, q.a2, q.b1, q.b2);
      expect(wLine[i] === null, `line-null#${i}`).toBe(tl === null);
      if (tl && wLine[i]) expect(closeHit(wLine[i]!, tl), `line#${i}`).toBe(true);
    });
    expect(hits, "keine einzige Kreuzung getroffen — Test waere aussagelos").toBeGreaterThan(50);
  });

  it("segmentPolylineHits (Struktur exakt + Werte)", () => {
    const rng = mulberry32(3);
    const qs = Array.from({ length: N }, () => {
      const n = 3 + Math.floor(rng() * 18);
      const pts = Array.from({ length: n }, () => v(rng));
      // Langer Schneider quer durch die BBox.
      return { a1: { x: -120, y: coord(rng) }, a2: { x: 120, y: coord(rng) }, pts, closed: rng() < 0.5 };
    });
    const wHits = JSON.parse(K.segment_polyline_hits_batch_json(JSON.stringify(qs))) as Hit[][];
    qs.forEach((q, i) => {
      const t = segmentPolylineHits(q.a1, q.a2, q.pts, q.closed);
      expect(wHits[i].length, `hits-len#${i}`).toBe(t.length);
      t.forEach((h, j) => expect(closeHit(wHits[i][j], h), `hit#${i}.${j}`).toBe(true));
    });
  });

  it("lineCircleIntersect / segmentCircleIntersect (Struktur + Werte)", () => {
    const rng = mulberry32(4);
    const qs = Array.from({ length: N }, () => ({
      a: v(rng),
      b: v(rng),
      center: v(rng),
      r: 0.01 + rng() * 50,
    }));
    const wLine = JSON.parse(K.line_circle_intersect_batch_json(JSON.stringify(qs))) as Vec2[][];
    const wSeg = JSON.parse(K.segment_circle_intersect_batch_json(JSON.stringify(qs))) as Vec2[][];
    qs.forEach((q, i) => {
      const tl = lineCircleIntersect(q.a, q.b, q.center, q.r);
      expect(wLine[i].length, `lc-len#${i}`).toBe(tl.length);
      tl.forEach((p, j) => expect(closeVec(wLine[i][j], p), `lc#${i}.${j}`).toBe(true));
      const ts = segmentCircleIntersect(q.a, q.b, q.center, q.r);
      expect(wSeg[i].length, `sc-len#${i}`).toBe(ts.length);
      ts.forEach((p, j) => expect(closeVec(wSeg[i][j], p), `sc#${i}.${j}`).toBe(true));
    });
  });

  it("circleCircleIntersect (Struktur + Werte)", () => {
    const rng = mulberry32(5);
    const qs = Array.from({ length: N }, () => ({
      c1: v(rng),
      r1: 0.01 + rng() * 50,
      c2: v(rng),
      r2: 0.01 + rng() * 50,
    }));
    const w = JSON.parse(K.circle_circle_intersect_batch_json(JSON.stringify(qs))) as Vec2[][];
    qs.forEach((q, i) => {
      const t = circleCircleIntersect(q.c1, q.r1, q.c2, q.r2);
      expect(w[i].length, `cc-len#${i}`).toBe(t.length);
      t.forEach((p, j) => expect(closeVec(w[i][j], p), `cc#${i}.${j}`).toBe(true));
    });
  });

  it("signedArea (rel 1e-9) / isCCW (Struktur exakt)", () => {
    const rng = mulberry32(6);
    const polys = Array.from({ length: N }, () => {
      const n = 3 + Math.floor(rng() * 8);
      return Array.from({ length: n }, () => v(rng));
    });
    const wArea = JSON.parse(K.signed_area_batch_json(JSON.stringify(polys))) as number[];
    const wCcw = JSON.parse(K.is_ccw_batch_json(JSON.stringify(polys))) as boolean[];
    polys.forEach((p, i) => {
      const a = signedArea(p);
      expect(Math.abs(wArea[i] - a) <= 1e-9 * Math.max(1, Math.abs(a)), `area#${i}`).toBe(true);
      expect(wCcw[i], `ccw#${i}`).toBe(isCCW(p));
    });
  });

  it("offsetSegment / offsetPolyline (Miter, Struktur + Werte rel 1e-9)", () => {
    const rng = mulberry32(7);
    const segs = Array.from({ length: N }, () => ({
      a: v(rng),
      b: v(rng),
      d: (rng() * 2 - 1) * 5,
    }));
    const wSeg = JSON.parse(K.offset_segment_batch_json(JSON.stringify(segs))) as [Vec2, Vec2][];
    segs.forEach((q, i) => {
      const [a, b] = offsetSegment(q.a, q.b, q.d);
      expect(closeVec(wSeg[i][0], a) && closeVec(wSeg[i][1], b), `offSeg#${i}`).toBe(true);
    });

    const polys = Array.from({ length: N }, () => {
      const n = 3 + Math.floor(rng() * 10);
      const pts = Array.from({ length: n }, () => v(rng));
      return { pts, d: (rng() * 2 - 1) * 5, closed: rng() < 0.5 };
    });
    const wPoly = JSON.parse(K.offset_polyline_batch_json(JSON.stringify(polys))) as Vec2[][];
    polys.forEach((q, i) => {
      const t = offsetPolyline(q.pts, q.d, q.closed);
      expect(wPoly[i].length, `offPoly-len#${i}`).toBe(t.length);
      t.forEach((p, j) => expect(closeVec(wPoly[i][j], p), `offPoly#${i}.${j}`).toBe(true));
    });
  });

  it("filletCorner (Struktur exakt + Werte, Winkel abs 1e-7)", () => {
    const rng = mulberry32(8);
    // Halb kontrolliert (garantiert gueltige Verrundung), halb Zufall (None-Paritaet).
    const qs = Array.from({ length: N }, (_, i) => {
      if (i % 2 === 0) {
        const corner = v(rng);
        const a0 = rng() * Math.PI * 2;
        const half = 0.3 + rng() * 0.9; // theta = 2*half ∈ [0.6, 2.4] rad (weg von 0/π)
        const legLen = 3 + rng() * 7;
        const rMax = legLen * Math.tan(half);
        const r = 0.1 + rng() * 0.8 * rMax;
        const dir = (ang: number) => ({ x: Math.cos(ang), y: Math.sin(ang) });
        const d1 = dir(a0 + half);
        const d2 = dir(a0 - half);
        return {
          corner,
          p1: { x: corner.x + d1.x * legLen, y: corner.y + d1.y * legLen },
          p2: { x: corner.x + d2.x * legLen, y: corner.y + d2.y * legLen },
          r,
        };
      }
      return { corner: v(rng), p1: v(rng), p2: v(rng), r: 0.1 + rng() * 5 };
    });
    const w = JSON.parse(K.fillet_corner_batch_json(JSON.stringify(qs))) as (Fillet | null)[];
    let valid = 0;
    qs.forEach((q, i) => {
      const t = filletCorner(q.corner, q.p1, q.p2, q.r);
      expect(w[i] === null, `fil-null#${i}`).toBe(t === null);
      if (t && w[i]) {
        const f = w[i]!;
        expect(closeVec(f.center, t.center), `fil-center#${i}`).toBe(true);
        expect(closeVec(f.tangentA, t.tangentA), `fil-tA#${i}`).toBe(true);
        expect(closeVec(f.tangentB, t.tangentB), `fil-tB#${i}`).toBe(true);
        expect(closeNum(f.radius, t.radius), `fil-r#${i}`).toBe(true);
        expect(Math.abs(f.startAngle - t.startAngle) <= 1e-7, `fil-sa#${i}`).toBe(true);
        expect(Math.abs(f.endAngle - t.endAngle) <= 1e-7, `fil-ea#${i}`).toBe(true);
        valid++;
      }
    });
    expect(valid, "keine gueltige Verrundung — Test waere aussagelos").toBeGreaterThan(50);
  });

  it("splitSegmentByCutters / trimSegment (Struktur + Werte)", () => {
    const rng = mulberry32(9);
    const qs = Array.from({ length: N }, () => ({
      a1: { x: -60, y: (rng() * 2 - 1) * 40 },
      a2: { x: 60, y: (rng() * 2 - 1) * 40 },
      cutters: genCutters(rng),
      pick: { x: (rng() * 2 - 1) * 60, y: (rng() * 2 - 1) * 40 },
    }));
    const wSplit = JSON.parse(K.split_segment_by_cutters_batch_json(JSON.stringify(qs))) as [Vec2, Vec2][][];
    const wTrim = JSON.parse(K.trim_segment_batch_json(JSON.stringify(qs))) as [Vec2, Vec2][][];
    qs.forEach((q, i) => {
      expect(eqPairs(wSplit[i], splitSegmentByCutters(q.a1, q.a2, q.cutters)), `split#${i}`).toBe(true);
      expect(eqPairs(wTrim[i], trimSegment(q.a1, q.a2, q.cutters, q.pick)), `trim#${i}`).toBe(true);
    });
  });

  it("trimPolyline / splitAtIntersections (offen+geschlossen, Struktur exakt)", () => {
    const rng = mulberry32(10);
    const qs = Array.from({ length: N }, () => ({
      pts: genPolyline(rng, 4, 9),
      closed: rng() < 0.5,
      cutters: genCutters(rng),
      pick: { x: (rng() * 2 - 1) * 50, y: (rng() * 2 - 1) * 50 },
      others: genCutters(rng).map((c) => c.pts),
    }));
    const wTrim = JSON.parse(K.trim_polyline_batch_json(JSON.stringify(qs))) as Poly[][];
    const wSplit = JSON.parse(
      K.split_at_intersections_batch_json(
        JSON.stringify(qs.map((q) => ({ targetPts: q.pts, closed: q.closed, others: q.others }))),
      ),
    ) as Vec2[][][];
    qs.forEach((q, i) => {
      expect(eqPolyList(wTrim[i], trimPolyline(q.pts, q.closed, q.cutters, q.pick)), `trimPoly#${i}`).toBe(true);
      expect(eqPtsLists(wSplit[i], splitAtIntersections(q.pts, q.closed, q.others)), `splitAt#${i}`).toBe(true);
    });
  });

  it("splitPolylineAtParam / splitClosedByChord / removeSegment", () => {
    const rng = mulberry32(11);
    const qs = Array.from({ length: N }, () => {
      const pts = genPolyline(rng, 4, 9);
      const n = pts.length;
      const closed = rng() < 0.5;
      return { pts, closed, edgeIndex: Math.floor(rng() * (closed ? n : n - 1)), t: rng() };
    });
    const wSap = JSON.parse(K.split_polyline_at_param_batch_json(JSON.stringify(qs))) as Vec2[][][];
    const wRem = JSON.parse(
      K.remove_segment_batch_json(
        JSON.stringify(qs.map((q) => ({ pts: q.pts, closed: q.closed, edgeIndex: q.edgeIndex }))),
      ),
    ) as Poly[];
    const chords = Array.from({ length: N }, () => {
      const pts = genPolyline(rng, 4, 8);
      const n = pts.length;
      const i = Math.floor(rng() * n);
      let j = Math.floor(rng() * n);
      if (j === i) j = (j + 1) % n;
      return { pts, i, ti: rng(), j, tj: rng() };
    });
    const wChord = JSON.parse(K.split_closed_by_chord_batch_json(JSON.stringify(chords))) as ([Vec2[], Vec2[]] | null)[];
    qs.forEach((q, i) => {
      expect(eqPtsLists(wSap[i], splitPolylineAtParam(q.pts, q.closed, q.edgeIndex, q.t)), `sap#${i}`).toBe(true);
      const tr = removeSegment(q.pts, q.closed, q.edgeIndex);
      expect(wRem[i].closed === tr.closed && eqPts(wRem[i].pts, tr.pts), `rem#${i}`).toBe(true);
    });
    chords.forEach((q, i) => {
      const t = splitClosedByChord(q.pts, q.i, q.ti, q.j, q.tj);
      expect((wChord[i] === null) === (t === null), `chord-null#${i}`).toBe(true);
      if (t && wChord[i]) {
        expect(eqPts(wChord[i]![0], t[0]) && eqPts(wChord[i]![1], t[1]), `chord#${i}`).toBe(true);
      }
    });
  });

  it("extendSegment (start/end, null-Paritaet + Werte)", () => {
    const rng = mulberry32(12);
    const qs = Array.from({ length: N }, (_, k) => {
      const c = { x: (rng() * 2 - 1) * 30, y: (rng() * 2 - 1) * 30 };
      return {
        a1: { x: c.x - 1, y: c.y },
        a2: { x: c.x + 1, y: c.y },
        end: (k % 2 === 0 ? "end" : "start") as "start" | "end",
        cutters: genCutters(rng).concat([
          { pts: [{ x: c.x + 5, y: -50 }, { x: c.x + 5, y: 50 }], closed: false },
        ]),
      };
    });
    const w = JSON.parse(K.extend_segment_batch_json(JSON.stringify(qs))) as ([Vec2, Vec2] | null)[];
    qs.forEach((q, i) => {
      const t = extendSegment(q.a1, q.a2, q.end, q.cutters);
      expect((w[i] === null) === (t === null), `ext-null#${i}`).toBe(true);
      if (t && w[i]) expect(closeVec(w[i]![0], t[0]) && closeVec(w[i]![1], t[1]), `ext#${i}`).toBe(true);
    });
  });

  it("joinChains (mergeable + Zufall, Struktur exakt)", () => {
    const rng = mulberry32(13);
    const groups = Array.from({ length: N }, () => {
      const base = genPolyline(rng, 4, 7);
      const chains: Poly[] = [];
      for (let k = 0; k < base.length - 1; k++) {
        const seg = [base[k], base[k + 1]];
        chains.push({ pts: rng() < 0.5 ? seg : [seg[1], seg[0]], closed: false });
      }
      if (rng() < 0.5) chains.push({ pts: genPolyline(rng, 2, 3), closed: false });
      for (let k = chains.length - 1; k > 0; k--) {
        const j = Math.floor(rng() * (k + 1));
        [chains[k], chains[j]] = [chains[j], chains[k]];
      }
      return chains;
    });
    const w = JSON.parse(K.join_chains_batch_json(JSON.stringify(groups))) as Poly[][];
    groups.forEach((g, i) => {
      expect(eqPolyList(w[i], joinChains(g)), `join#${i}`).toBe(true);
    });
  });
});

// ── Slice 1: roomArea / ceiling ───────────────────────────────────────────────

/** Zufaelliges konvexes Polygon mit n=3..10 Ecken in [-30,30]×[-30,30]. */
function genConvexPoly(rng: () => number, n: number): Vec2[] {
  // Einfache Methode: Einheitswinkel sortieren + skalieren.
  const angles = Array.from({ length: n }, () => rng() * 2 * Math.PI);
  angles.sort((a, b) => a - b);
  const rx = 1 + rng() * 20;
  const ry = 1 + rng() * 20;
  const cx = (rng() * 2 - 1) * 10;
  const cy = (rng() * 2 - 1) * 10;
  return angles.map((a) => ({ x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a) }));
}

describe.skipIf(!built)("kernel2d Rust-WASM ⇄ TS Paritaet — Slice 1: roomArea + ceiling", () => {
  it("polygonArea / perimeter / centroid (Zufallspolygone 3–10 Ecken, rel 1e-9)", () => {
    const rng = mulberry32(20);
    const polys = Array.from({ length: N }, () => {
      const n = 3 + Math.floor(rng() * 8);
      return genConvexPoly(rng, n);
    });
    const wArea = JSON.parse(K.polygon_area_batch_json(JSON.stringify(polys))) as number[];
    const wPerim = JSON.parse(K.perimeter_batch_json(JSON.stringify(polys))) as number[];
    const wCent = JSON.parse(K.centroid_batch_json(JSON.stringify(polys))) as Vec2[];

    polys.forEach((p, i) => {
      const a = polygonArea(p);
      const pe = perimeter(p);
      const c = centroid(p);
      expect(closeNum(wArea[i], a), `area#${i}`).toBe(true);
      expect(closeNum(wPerim[i], pe), `perim#${i}`).toBe(true);
      expect(closeVec(wCent[i], c), `centroid#${i}`).toBe(true);
    });
  });

  it("normalizeOutline: Struktur exakt (null↔null) + Werte + None-Paritaet", () => {
    const rng = mulberry32(21);
    // Haelfte: gueltige Polygone; Haelfte: degenerierte (< 3 Punkte oder kollinear).
    const inputs = Array.from({ length: N }, (_, i) => {
      if (i % 4 < 3) {
        const n = 3 + Math.floor(rng() * 8);
        return genConvexPoly(rng, n);
      }
      // Degeneriert: 0, 1 oder 2 Punkte.
      const k = Math.floor(rng() * 3);
      return Array.from({ length: k }, () => ({ x: rng() * 10, y: rng() * 10 }));
    });
    const w = JSON.parse(K.normalize_outline_batch_json(JSON.stringify(inputs))) as (Vec2[] | null)[];
    inputs.forEach((p, i) => {
      const t = normalizeOutline(p);
      expect(w[i] === null, `norm-null#${i}`).toBe(t === null);
      if (t !== null && w[i] !== null) {
        const wp = w[i]!;
        expect(wp.length, `norm-len#${i}`).toBe(t.length);
        t.forEach((pt, j) => expect(closeVec(wp[j], pt), `norm-pt#${i}.${j}`).toBe(true));
      }
    });
  });

  it("isValidOutline / ceilingArea (Struktur exakt + Werte)", () => {
    const rng = mulberry32(22);
    const polys = Array.from({ length: N }, (_, i) => {
      if (i % 5 < 4) return genConvexPoly(rng, 3 + Math.floor(rng() * 8));
      return Array.from({ length: Math.floor(rng() * 3) }, () => ({ x: rng() * 5, y: rng() * 5 }));
    });
    const wValid = JSON.parse(K.is_valid_outline_batch_json(JSON.stringify(polys))) as boolean[];
    const wArea = JSON.parse(K.ceiling_area_batch_json(JSON.stringify(polys))) as number[];

    polys.forEach((p, i) => {
      expect(wValid[i], `valid#${i}`).toBe(isValidOutline(p));
      expect(closeNum(wArea[i], ceilingArea(p)), `ceilArea#${i}`).toBe(true);
    });
  });

  it("outlineBBox / outlineCentroid (Werte rel 1e-9)", () => {
    const rng = mulberry32(23);
    const polys = Array.from({ length: N }, () => genConvexPoly(rng, 3 + Math.floor(rng() * 8)));
    const wBBox = JSON.parse(K.outline_bbox_batch_json(JSON.stringify(polys))) as {
      minX: number;
      minY: number;
      maxX: number;
      maxY: number;
    }[];
    const wCent = JSON.parse(K.outline_centroid_batch_json(JSON.stringify(polys))) as Vec2[];

    polys.forEach((p, i) => {
      const bb = outlineBBox(p);
      const c = outlineCentroid(p);
      expect(closeNum(wBBox[i].minX, bb.minX), `bbox-minX#${i}`).toBe(true);
      expect(closeNum(wBBox[i].minY, bb.minY), `bbox-minY#${i}`).toBe(true);
      expect(closeNum(wBBox[i].maxX, bb.maxX), `bbox-maxX#${i}`).toBe(true);
      expect(closeNum(wBBox[i].maxY, bb.maxY), `bbox-maxY#${i}`).toBe(true);
      expect(closeVec(wCent[i], c), `outCentroid#${i}`).toBe(true);
    });
  });

  it("pointInOutline (Struktur exakt: true↔true, Zufallspunkte innen+aussen)", () => {
    const rng = mulberry32(24);
    const qs = Array.from({ length: N }, () => {
      const n = 3 + Math.floor(rng() * 8);
      const outline = genConvexPoly(rng, n);
      // Schwerpunkt des Polygons als garantiert innerer Punkt.
      const cx = outline.reduce((s, p) => s + p.x, 0) / outline.length;
      const cy = outline.reduce((s, p) => s + p.y, 0) / outline.length;
      const p = rng() < 0.5 ? { x: cx, y: cy } : { x: (rng() * 2 - 1) * 50, y: (rng() * 2 - 1) * 50 };
      return { p, outline };
    });
    const w = JSON.parse(K.point_in_outline_batch_json(JSON.stringify(qs))) as boolean[];
    qs.forEach((q, i) => {
      expect(w[i], `pio#${i}`).toBe(pointInOutline(q.p, q.outline));
    });
  });
});

// ── Slice 2: stair ────────────────────────────────────────────────────────────

/** Erzeugt einen einfachen Stair-Stub mit geometrisch relevanten Feldern. */
function genStair(
  rng: () => number,
  shape: "straight" | "L" | "spiral",
): Stair & { totalRise: number } {
  const start = { x: (rng() * 2 - 1) * 10, y: (rng() * 2 - 1) * 10 };
  const angle = rng() * Math.PI * 2;
  const dir = { x: Math.cos(angle), y: Math.sin(angle) };
  const runLength = 1 + rng() * 5;
  const width = 0.8 + rng() * 1.5;
  const stepCount = 3 + Math.floor(rng() * 12);
  const totalRise = 0.5 + rng() * 3;
  const up = rng() < 0.5 ? true : false;
  const base: Stair = {
    id: "test",
    type: "stair",
    floorId: "f1",
    categoryCode: "40",
    shape,
    start,
    dir,
    runLength,
    width,
    stepCount,
    up,
  };
  if (shape === "L") {
    return { ...base, run2Length: 1 + rng() * 4, turn: rng() < 0.5 ? 1 : -1, totalRise };
  }
  if (shape === "spiral") {
    return {
      ...base,
      center: { x: start.x + rng() * 2, y: start.y + rng() * 2 },
      radius: 0.5 + rng() * 2,
      sweep: 90 + rng() * 270,
      totalRise,
    };
  }
  return { ...base, totalRise };
}

/** Prueft Tritt-Listen-Gleichheit: Laenge, dann je Tritt index/baseRise/topRise/pts. */
function eqTreads(
  w: { pts: Vec2[]; index: number; topRise: number; baseRise: number }[],
  t: TSStairGeometry["treads"],
): boolean {
  if (w.length !== t.length) return false;
  return t.every((tr, i) => {
    const wtr = w[i];
    if (wtr.index !== tr.index) return false;
    if (!closeNum(wtr.topRise, tr.topRise)) return false;
    if (!closeNum(wtr.baseRise, tr.baseRise)) return false;
    if (!eqPts(wtr.pts, tr.pts)) return false;
    return true;
  });
}

describe.skipIf(!built)("kernel2d Rust-WASM ⇄ TS Paritaet — Slice 2: stair", () => {
  it("defaultStepCount (Struktur exakt + Werte)", () => {
    const rng = mulberry32(30);
    const qs = Array.from({ length: N }, () => ({
      totalRise: 0.1 + rng() * 5,
      runLength: rng() * 8,
    }));
    const w = JSON.parse(K.default_step_count_batch_json(JSON.stringify(qs))) as number[];
    qs.forEach((q, i) => {
      expect(w[i], `dsc#${i}`).toBe(defaultStepCount(q.totalRise, q.runLength));
    });
  });

  it("stairGeometry gerade: Tritte + Werte (Struktur exakt, rel 1e-9)", () => {
    const rng = mulberry32(31);
    const qs = Array.from({ length: 100 }, () => {
      const s = genStair(rng, "straight");
      return { stair: s, totalRise: s.totalRise };
    });
    const wGeos = JSON.parse(K.stair_geometry_batch_json(JSON.stringify(qs))) as {
      treads: { pts: Vec2[]; index: number; topRise: number; baseRise: number }[];
      landing: Vec2[] | null;
      riserHeight: number;
      treadDepth: number;
      runLine: Vec2[];
      totalRise: number;
    }[];
    qs.forEach((q, i) => {
      const t = stairGeometry(q.stair, q.totalRise);
      const w = wGeos[i];
      expect(eqTreads(w.treads, t.treads), `treads#${i}`).toBe(true);
      expect(w.landing === null, `landing-null#${i}`).toBe(t.landing === null);
      expect(closeNum(w.riserHeight, t.riserHeight), `riser#${i}`).toBe(true);
      expect(closeNum(w.treadDepth, t.treadDepth), `depth#${i}`).toBe(true);
      expect(eqPts(w.runLine, t.runLine), `runLine#${i}`).toBe(true);
    });
  });

  it("stairGeometry L + spiral: Struktur exakt + Werte", () => {
    const rng = mulberry32(32);
    const lqs = Array.from({ length: 50 }, () => {
      const s = genStair(rng, "L");
      return { stair: s, totalRise: s.totalRise };
    });
    const spiralqs = Array.from({ length: 50 }, () => {
      const s = genStair(rng, "spiral");
      return { stair: s, totalRise: s.totalRise };
    });
    const wL = JSON.parse(K.stair_geometry_batch_json(JSON.stringify(lqs))) as {
      treads: { pts: Vec2[]; index: number; topRise: number; baseRise: number }[];
      landing: Vec2[] | null;
      riserHeight: number;
      treadDepth: number;
      runLine: Vec2[];
    }[];
    lqs.forEach((q, i) => {
      const t = stairGeometry(q.stair, q.totalRise);
      const w = wL[i];
      expect(eqTreads(w.treads, t.treads), `L-treads#${i}`).toBe(true);
      expect(w.landing !== null, `L-landing#${i}`).toBe(t.landing !== null);
      if (t.landing && w.landing) expect(eqPts(w.landing, t.landing), `L-landingPts#${i}`).toBe(true);
      expect(eqPts(w.runLine, t.runLine), `L-runLine#${i}`).toBe(true);
    });
    const wSp = JSON.parse(K.stair_geometry_batch_json(JSON.stringify(spiralqs))) as typeof wL;
    spiralqs.forEach((q, i) => {
      const t = stairGeometry(q.stair, q.totalRise);
      const w = wSp[i];
      expect(eqTreads(w.treads, t.treads), `sp-treads#${i}`).toBe(true);
      expect(eqPts(w.runLine, t.runLine), `sp-runLine#${i}`).toBe(true);
    });
  });

  it("stairCut (Struktur exakt: Indizes + breakLine-null)", () => {
    const rng = mulberry32(33);
    const qs = Array.from({ length: 100 }, () => {
      const s = genStair(rng, "straight");
      const geo = stairGeometry(s, s.totalRise);
      const cutRise = rng() * s.totalRise * 1.1;
      return { geo, cutRise };
    });
    const w = JSON.parse(K.stair_cut_batch_json(JSON.stringify(qs))) as {
      belowIndices: number[];
      aboveIndices: number[];
      breakLine: [Vec2, Vec2][] | null;
    }[];
    qs.forEach((q, i) => {
      const t = stairCut(q.geo, q.cutRise);
      expect(w[i].belowIndices.length, `cut-below-len#${i}`).toBe(t.belowIndices.length);
      expect(w[i].aboveIndices.length, `cut-above-len#${i}`).toBe(t.aboveIndices.length);
      expect(w[i].belowIndices, `cut-below#${i}`).toEqual(t.belowIndices);
      expect(w[i].aboveIndices, `cut-above#${i}`).toEqual(t.aboveIndices);
      expect(w[i].breakLine === null, `cut-break-null#${i}`).toBe(t.breakLine === null);
    });
  });

  it("stairBBox (Werte rel 1e-9)", () => {
    const rng = mulberry32(34);
    const geos = Array.from({ length: 100 }, () => {
      const s = genStair(rng, "straight");
      return stairGeometry(s, s.totalRise);
    });
    const w = JSON.parse(K.stair_bbox_batch_json(JSON.stringify(geos))) as {
      minX: number; minY: number; maxX: number; maxY: number;
    }[];
    geos.forEach((g, i) => {
      const t = stairBBox(g);
      expect(closeNum(w[i].minX, t.minX), `bbox-minX#${i}`).toBe(true);
      expect(closeNum(w[i].minY, t.minY), `bbox-minY#${i}`).toBe(true);
      expect(closeNum(w[i].maxX, t.maxX), `bbox-maxX#${i}`).toBe(true);
      expect(closeNum(w[i].maxY, t.maxY), `bbox-maxY#${i}`).toBe(true);
    });
  });

  it("pointInPolygon / pointHitsStair (Struktur exakt)", () => {
    const rng = mulberry32(35);
    const pipQs = Array.from({ length: N }, () => {
      const n = 3 + Math.floor(rng() * 8);
      const poly = genConvexPoly(rng, n);
      const cx = poly.reduce((s, p) => s + p.x, 0) / poly.length;
      const cy = poly.reduce((s, p) => s + p.y, 0) / poly.length;
      const p = rng() < 0.5 ? { x: cx, y: cy } : { x: (rng() * 2 - 1) * 50, y: (rng() * 2 - 1) * 50 };
      return { p, poly };
    });
    const wPip = JSON.parse(K.point_in_polygon_batch_json(JSON.stringify(pipQs))) as boolean[];
    pipQs.forEach((q, i) => {
      expect(wPip[i], `pip#${i}`).toBe(stairPointInPolygon(q.p, q.poly));
    });

    const phsQs = Array.from({ length: 50 }, () => {
      const s = genStair(rng, "straight");
      const geo = stairGeometry(s, s.totalRise);
      const p = { x: s.start.x + rng() * 6 - 1, y: s.start.y + (rng() * 2 - 1) * 2 };
      return { p, geo };
    });
    const wPhs = JSON.parse(K.point_hits_stair_batch_json(JSON.stringify(phsQs))) as boolean[];
    phsQs.forEach((q, i) => {
      expect(wPhs[i], `phs#${i}`).toBe(pointHitsStair(q.p, q.geo));
    });
  });
});

// ── Slice 3: roomBoundary ─────────────────────────────────────────────────────

/** Erzeugt eine Menge rechtwinkliger Wandsegmente, die ein einfaches Rechteck
 *  (oder L-Form) bilden. */
function genRectWalls(rng: () => number): WallSegment[] {
  const x0 = (rng() * 2 - 1) * 5;
  const y0 = (rng() * 2 - 1) * 5;
  const w = 2 + rng() * 5;
  const h = 2 + rng() * 5;
  const t = 0.1 + rng() * 0.3;
  return [
    { a: { x: x0, y: y0 }, b: { x: x0 + w, y: y0 }, thickness: t },
    { a: { x: x0 + w, y: y0 }, b: { x: x0 + w, y: y0 + h }, thickness: t },
    { a: { x: x0 + w, y: y0 + h }, b: { x: x0, y: y0 + h }, thickness: t },
    { a: { x: x0, y: y0 + h }, b: { x: x0, y: y0 }, thickness: t },
  ];
}

/** Erzeugt WallFace-Liste aus einem geschlossenen Polygon. */
function polyToFaces(pts: Vec2[]): WallFace[] {
  const n = pts.length;
  return Array.from({ length: n }, (_, i) => ({ a: pts[i], b: pts[(i + 1) % n] }));
}

describe.skipIf(!built)("kernel2d Rust-WASM ⇄ TS Paritaet — Slice 3: roomBoundary", () => {
  it("rbPointInPolygon (roomBoundary-Variante, kein Nenner-Guard, Struktur exakt)", () => {
    const rng = mulberry32(40);
    const qs = Array.from({ length: N }, () => {
      const n = 3 + Math.floor(rng() * 8);
      const poly = genConvexPoly(rng, n);
      const cx = poly.reduce((s, p) => s + p.x, 0) / poly.length;
      const cy = poly.reduce((s, p) => s + p.y, 0) / poly.length;
      const p = rng() < 0.5 ? { x: cx, y: cy } : { x: (rng() * 2 - 1) * 50, y: (rng() * 2 - 1) * 50 };
      return { p, poly };
    });
    const w = JSON.parse(K.rb_point_in_polygon_batch_json(JSON.stringify(qs))) as boolean[];
    qs.forEach((q, i) => {
      expect(w[i], `rbpip#${i}`).toBe(rbPointInPolygon(q.p, q.poly));
    });
  });

  it("detectRooms — Rechteck-Grundriss: gleiche Anzahl + Reihenfolge Raeume", () => {
    const rng = mulberry32(41);
    const qs = Array.from({ length: 50 }, () => ({
      walls: genRectWalls(rng),
      gapTol: 0.05,
      minArea: 0.05,
      offsetToInner: true,
    }));
    const w = JSON.parse(K.detect_rooms_batch_json(JSON.stringify(qs))) as Vec2[][][];
    qs.forEach((q, i) => {
      const t = detectRooms(q.walls, { gapTol: q.gapTol, minArea: q.minArea, offsetToInner: q.offsetToInner });
      // Gleiche Anzahl Raeume.
      expect(w[i].length, `dr-count#${i}`).toBe(t.length);
      // Je Raum: gleiche Punktanzahl (Reihenfolge-abhaengig, aber deterministisch).
      t.forEach((room, j) => {
        expect(w[i][j]?.length, `dr-roomLen#${i}.${j}`).toBe(room.length);
        room.forEach((pt, k) => expect(closeVec(w[i][j][k], pt), `dr-pt#${i}.${j}.${k}`).toBe(true));
      });
    });
  });

  it("detectRooms ohne Offset + degeneriert (< 3 Waende → leer)", () => {
    const rng = mulberry32(42);
    const qs = Array.from({ length: 30 }, () => ({
      walls: genRectWalls(rng),
      gapTol: 0.05,
      minArea: 0.05,
      offsetToInner: false,
    }));
    const w = JSON.parse(K.detect_rooms_batch_json(JSON.stringify(qs))) as Vec2[][][];
    qs.forEach((q, i) => {
      const t = detectRooms(q.walls, { gapTol: q.gapTol, minArea: q.minArea, offsetToInner: q.offsetToInner });
      expect(w[i].length, `drno-count#${i}`).toBe(t.length);
    });
    // Degeneriert: < 3 Waende → leer.
    const deg = [{ walls: [{ a: { x: 0, y: 0 }, b: { x: 1, y: 0 }, thickness: 0.2 }], gapTol: 0.05, minArea: 0.05, offsetToInner: true }];
    const wd = JSON.parse(K.detect_rooms_batch_json(JSON.stringify(deg))) as Vec2[][][];
    expect(wd[0].length).toBe(detectRooms(deg[0].walls, {}).length);
    expect(wd[0].length).toBe(0);
  });

  it("roomFromPointInside — Schwerpunkt als Saatpunkt findet den Raum (nicht null)", () => {
    const rng = mulberry32(43);
    const qs = Array.from({ length: 50 }, () => {
      const walls = genRectWalls(rng);
      // Mittelpunkt des Rechtecks als Saatpunkt.
      const xs = walls.flatMap((w) => [w.a.x, w.b.x]);
      const ys = walls.flatMap((w) => [w.a.y, w.b.y]);
      const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
      const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
      return { point: { x: cx, y: cy }, walls, gapTol: 0.05, offsetToInner: true };
    });
    const w = JSON.parse(K.room_from_point_inside_batch_json(JSON.stringify(qs))) as (Vec2[] | null)[];
    qs.forEach((q, i) => {
      const t = roomFromPointInside(q.point, q.walls, { gapTol: q.gapTol, offsetToInner: q.offsetToInner });
      expect(w[i] === null, `rfpi-null#${i}`).toBe(t === null);
      if (t !== null && w[i] !== null) {
        expect(w[i]!.length, `rfpi-len#${i}`).toBe(t.length);
        t.forEach((pt, j) => expect(closeVec(w[i]![j], pt), `rfpi-pt#${i}.${j}`).toBe(true));
      }
    });
  });

  it("roomFromPointInsideFaces — Struktur exakt (null↔null, Laenge, Punkte)", () => {
    const rng = mulberry32(44);
    const qs = Array.from({ length: 30 }, () => {
      const n = 4 + Math.floor(rng() * 4);
      const poly = genConvexPoly(rng, n);
      const faces = polyToFaces(poly);
      const cx = poly.reduce((s, p) => s + p.x, 0) / poly.length;
      const cy = poly.reduce((s, p) => s + p.y, 0) / poly.length;
      const inOrOut = rng() < 0.7 ? { x: cx, y: cy } : { x: (rng() * 2 - 1) * 40, y: (rng() * 2 - 1) * 40 };
      return { point: inOrOut, wallFaces: faces, gapTol: 0.05 };
    });
    const w = JSON.parse(K.room_from_point_inside_faces_batch_json(JSON.stringify(qs))) as (Vec2[] | null)[];
    qs.forEach((q, i) => {
      const t = roomFromPointInsideFaces(q.point, q.wallFaces, q.gapTol);
      expect(w[i] === null, `rfpif-null#${i}`).toBe(t === null);
      if (t !== null && w[i] !== null) {
        expect(w[i]!.length, `rfpif-len#${i}`).toBe(t.length);
        t.forEach((pt, j) => expect(closeVec(w[i]![j], pt), `rfpif-pt#${i}.${j}`).toBe(true));
      }
    });
  });
});

describe.skipIf(!built)("kernel2d Rust-WASM ⇄ TS Paritaet — Golden (Grenzfaelle)", () => {
  it("parallele/kollineare Strecken → null (beide)", () => {
    const qs = [
      { a1: { x: 0, y: 0 }, a2: { x: 2, y: 0 }, b1: { x: 0, y: 1 }, b2: { x: 2, y: 1 } }, // parallel
      { a1: { x: 0, y: 0 }, a2: { x: 4, y: 0 }, b1: { x: 1, y: 0 }, b2: { x: 3, y: 0 } }, // kollinear
      { a1: { x: 0, y: 0 }, a2: { x: 0, y: 0 }, b1: { x: 1, y: 1 }, b2: { x: 2, y: 2 } }, // Null-Laenge
    ];
    const w = JSON.parse(K.segment_intersect_batch_json(JSON.stringify(qs))) as (Hit | null)[];
    qs.forEach((q, i) => {
      const t = segmentIntersect(q.a1, q.a2, q.b1, q.b2);
      expect(w[i] === null, `#${i}`).toBe(t === null);
      if (t && w[i]) expect(closeHit(w[i]!, t)).toBe(true);
    });
  });

  it("tangentiale Gerade → genau 1 Punkt; konzentrische/getrennte Kreise → leer", () => {
    const lc = [{ a: { x: -1, y: 1 }, b: { x: 1, y: 1 }, center: { x: 0, y: 0 }, r: 1 }]; // Tangente
    const wlc = JSON.parse(K.line_circle_intersect_batch_json(JSON.stringify(lc))) as Vec2[][];
    expect(wlc[0].length).toBe(lineCircleIntersect(lc[0].a, lc[0].b, lc[0].center, lc[0].r).length);
    expect(wlc[0].length).toBe(1);

    const cc = [
      { c1: { x: 0, y: 0 }, r1: 1, c2: { x: 0, y: 0 }, r2: 2 }, // konzentrisch → leer
      { c1: { x: 0, y: 0 }, r1: 1, c2: { x: 5, y: 0 }, r2: 1 }, // getrennt → leer
      { c1: { x: 0, y: 0 }, r1: 2, c2: { x: 1, y: 0 }, r2: 1 }, // innen tangential → 1
    ];
    const wcc = JSON.parse(K.circle_circle_intersect_batch_json(JSON.stringify(cc))) as Vec2[][];
    cc.forEach((q, i) => {
      const t = circleCircleIntersect(q.c1, q.r1, q.c2, q.r2);
      expect(wcc[i].length, `cc#${i}`).toBe(t.length);
      t.forEach((p, j) => expect(closeVec(wcc[i][j], p)).toBe(true));
    });
  });

  it("degeneriertes Null-Flaeche-Polygon (kollinear) → Flaeche 0, nicht CCW", () => {
    const polys = [[{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }]];
    const wArea = JSON.parse(K.signed_area_batch_json(JSON.stringify(polys))) as number[];
    const wCcw = JSON.parse(K.is_ccw_batch_json(JSON.stringify(polys))) as boolean[];
    expect(closeNum(wArea[0], signedArea(polys[0]))).toBe(true);
    expect(Math.abs(wArea[0])).toBeLessThan(1e-12);
    expect(wCcw[0]).toBe(isCCW(polys[0]));
  });

  it("Offset L-Ecke (Gehrung) und Fillet rechter Winkel / kollinear→null / zu gross→null", () => {
    const off = [{ pts: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }], d: 0.5, closed: false }];
    const wOff = JSON.parse(K.offset_polyline_batch_json(JSON.stringify(off))) as Vec2[][];
    const tOff = offsetPolyline(off[0].pts, off[0].d, off[0].closed);
    expect(wOff[0].length).toBe(tOff.length);
    tOff.forEach((p, j) => expect(closeVec(wOff[0][j], p)).toBe(true));

    const fil = [
      { corner: { x: 0, y: 0 }, p1: { x: 5, y: 0 }, p2: { x: 0, y: 5 }, r: 1 }, // rechter Winkel
      { corner: { x: 0, y: 0 }, p1: { x: 1, y: 0 }, p2: { x: -1, y: 0 }, r: 0.5 }, // kollinear → null
      { corner: { x: 0, y: 0 }, p1: { x: 0.1, y: 0 }, p2: { x: 0, y: 0.1 }, r: 10 }, // zu gross → null
    ];
    const wFil = JSON.parse(K.fillet_corner_batch_json(JSON.stringify(fil))) as (Fillet | null)[];
    fil.forEach((q, i) => {
      const t = filletCorner(q.corner, q.p1, q.p2, q.r);
      expect(wFil[i] === null, `golden-fil#${i}`).toBe(t === null);
      if (t && wFil[i]) {
        expect(closeVec(wFil[i]!.center, t.center)).toBe(true);
        expect(closeVec(wFil[i]!.tangentA, t.tangentA)).toBe(true);
      }
    });
  });
});
