// Polygon-Booleans des Rust-Kerns (`src-tauri/core/src/polygon_bool.rs`, i_overlay) — Ersatz für
// `polygon-clipping` mit derselben Form der Daten, damit die Aufrufer unverändert bleiben:
// Ring = [x, y]-Paare MIT Schlusspunkt im Ergebnis, Polygon = Ringe (0 aussen), MultiPolygon.
// Eingaben dürfen offen oder geschlossen sein und beliebigen Umlaufsinn haben.
// Genauigkeit: i_overlay rechnet auf einem Ganzzahlraster über die Ausdehnung der Eingabe
// (≈ Ausdehnung / 2³⁰, bei 50 m also ~5·10⁻⁸ m) und vereinfacht kollineare Punkte. Konvexe
// Zerlegungen können daher anders ausfallen als mit polygon-clipping (gleiche Fläche/Ebene).
//   union(a, ...rest)        Vereinigung aller
//   difference(a, ...rest)   a minus Vereinigung von rest
//   intersection(a, ...rest) Schnitt aller

import { core } from "../engine/coreWasm";

export type Pair = [number, number];
export type Ring = Pair[];
export type Polygon = Ring[];
export type MultiPolygon = Polygon[];
export type Geom = Polygon | MultiPolygon;

/** Polygon oder MultiPolygon → MultiPolygon (Polygon: erstes Element ist ein Ring aus Paaren). */
function asMulti(g: Geom): MultiPolygon {
  if (g.length === 0) return [];
  const first = g[0] as unknown[];
  const isPolygon = first.length > 0 && Array.isArray(first[0]) && typeof (first[0] as unknown[])[0] === "number";
  return isPolygon ? [g as Polygon] : (g as MultiPolygon);
}

function encode(geoms: Geom[]): Float64Array {
  const polys = geoms.flatMap(asMulti);
  let n = 1;
  for (const p of polys) {
    n += 1;
    for (const r of p) n += 1 + 2 * r.length;
  }
  const out = new Float64Array(n);
  let i = 0;
  out[i++] = polys.length;
  for (const p of polys) {
    out[i++] = p.length;
    for (const r of p) {
      out[i++] = r.length;
      for (const [x, y] of r) {
        out[i++] = x;
        out[i++] = y;
      }
    }
  }
  return out;
}

function decode(buf: Float64Array): MultiPolygon {
  let i = 0;
  const nPolys = buf[i++] ?? 0;
  const out: MultiPolygon = [];
  for (let p = 0; p < nPolys; p++) {
    const nRings = buf[i++];
    const poly: Polygon = [];
    for (let r = 0; r < nRings; r++) {
      const nPts = buf[i++];
      const ring: Ring = [];
      for (let k = 0; k < nPts; k++) {
        ring.push([buf[i], buf[i + 1]]);
        i += 2;
      }
      if (ring.length > 0) ring.push([ring[0][0], ring[0][1]]);
      poly.push(ring);
    }
    out.push(poly);
  }
  return out;
}

export function union(a: Geom, ...rest: Geom[]): MultiPolygon {
  return decode(core().poly_union(encode([a, ...rest])));
}

export function difference(a: Geom, ...rest: Geom[]): MultiPolygon {
  return decode(core().poly_difference(encode([a]), encode(rest)));
}

export function intersection(a: Geom, ...rest: Geom[]): MultiPolygon {
  let acc = encode([a]);
  for (const g of rest) acc = core().poly_intersection(acc, encode([g]));
  return decode(acc);
}
