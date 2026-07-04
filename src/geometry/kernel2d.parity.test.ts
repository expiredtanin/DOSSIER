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
  filletCorner,
  isCCW,
  lineCircleIntersect,
  lineSegmentIntersect,
  offsetPolyline,
  offsetSegment,
  pointSegmentDistance,
  projectParam,
  segmentCircleIntersect,
  segmentIntersect,
  segmentPolylineHits,
  signedArea,
  type Fillet,
  type Hit,
} from "./kernel2d";

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
