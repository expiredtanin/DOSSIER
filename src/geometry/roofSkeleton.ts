// Walmdach über einem RECHTWINKLIGEN, nicht-rechteckigen Grundriss (L/T/U/Z …):
// echte Dachflächen mit Graten UND Kehlen statt der Bounding-Box-Vereinfachung
// aus `roof.ts` (dort wurde z. B. ein L-Grundriss mit einem Rechteck-Walmdach
// überdeckt — Dach über Luft, im Schnitt/in der Ansicht sichtbar falsch).
//
// Modell (Straight-Skeleton-Dach bei gleicher Neigung ringsum, für achs-
// parallele Kanten): jede Traufkante e "regiert" in ihrem Keil — begrenzt von
// der Kante selbst und den beiden 45°-Winkelhalbierenden an ihren Enden (an
// einer einspringenden Ecke wird die Halbierende zur Kehle). Die Dachhöhe ist
// die NIEDRIGSTE Ebene aller Kanten, deren Keil den Punkt enthält:
//   z(p) = e + tan(Neigung) · min{ dist(p, Gerade f) | p ∈ Keil(f) }.
// Die Fläche von e = (Traufpolygon ∩ Keil(e)) minus alle Bereiche, in denen eine
// andere Kante tiefer liegt. Polygon-Booleans über `polygon-clipping`
// (Martinez, wie `editors/booleanOps.ts`). Danach in KONVEXE Teilflächen zerlegt
// (Ohr-Schnitt + Hertel–Mehlhorn), weil Renderer/Schnitt konvexe Flächen
// erwarten (Fächer-Triangulierung, Cyrus–Beck).
//
// Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

import polygonClipping from "polygon-clipping";
import type { MultiPolygon, Ring } from "polygon-clipping";
import type { Vec2 } from "../model/types";
import type { Vec3 } from "./roof";

/** Ausgabe-Raster (Meter): entfernt Rundungsrauschen der Polygon-Booleans. */
const SNAP = 1e-6;
const snap = (v: number) => Math.round(v / SNAP) * SNAP;

/** Signierte Fläche (CCW > 0). */
function signedArea(pts: Vec2[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

/** Doppelte und kollineare Punkte entfernen. */
export function cleanRing(pts: Vec2[]): Vec2[] {
  let out = pts.filter((p, i) => {
    const q = pts[(i + 1) % pts.length];
    return Math.hypot(p.x - q.x, p.y - q.y) > 1e-9;
  });
  let changed = true;
  while (changed && out.length > 3) {
    changed = false;
    for (let i = 0; i < out.length; i++) {
      const a = out[(i + out.length - 1) % out.length];
      const b = out[i];
      const c = out[(i + 1) % out.length];
      const cr = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
      if (Math.abs(cr) < 1e-9) {
        out = out.filter((_, k) => k !== i);
        changed = true;
        break;
      }
    }
  }
  return out;
}

/** Ob alle Kanten achsparallel sind (und es mehr als ein Rechteck ist). */
export function isRectilinearNonRect(outline: Vec2[]): boolean {
  const pts = cleanRing(outline);
  if (pts.length <= 4) return false;
  return pts.every((p, i) => {
    const q = pts[(i + 1) % pts.length];
    return Math.abs(p.x - q.x) < 1e-9 || Math.abs(p.y - q.y) < 1e-9;
  });
}

/**
 * Ring (CCW) um `dist` nach aussen versetzen (Traufüberstand) — Gehrung an jeder
 * Ecke (Schnitt der beiden versetzten Kantengeraden), auch bei schiefen Winkeln.
 * `dist` kann je Kante verschieden sein (Traufe/Ortgang).
 */
export function offsetRectilinear(ring: Vec2[], dist: number | ((a: Vec2, b: Vec2) => number)): Vec2[] {
  if (typeof dist === "number" && dist <= 0) return ring.map((p) => ({ ...p }));
  const n = ring.length;
  // Aussen-Normale (Einheit) + Versatz je Kante (CCW → rechte Normale).
  const edges = ring.map((p, i) => {
    const q = ring[(i + 1) % n];
    const len = Math.hypot(q.x - p.x, q.y - p.y) || 1;
    return { nx: (q.y - p.y) / len, ny: -(q.x - p.x) / len, d: typeof dist === "number" ? dist : dist(p, q) };
  });
  return ring.map((p, i) => {
    const a = edges[(i + n - 1) % n];
    const b = edges[i];
    const det = a.nx * b.ny - a.ny * b.nx;
    // (fast) kollineare Nachbarkanten: einfach entlang der Normale versetzen.
    if (Math.abs(det) < 1e-6) return { x: p.x + a.nx * a.d, y: p.y + a.ny * a.d };
    let dx = (a.d * b.ny - b.d * a.ny) / det;
    let dy = (a.nx * b.d - b.nx * a.d) / det;
    // Sehr spitze Ecken: Gehrungsspitze begrenzen.
    const lim = 4 * Math.max(a.d, b.d);
    const len = Math.hypot(dx, dy);
    if (len > lim && len > 0) {
      dx *= lim / len;
      dy *= lim / len;
    }
    return { x: p.x + dx, y: p.y + dy };
  });
}

/** Schneiden sich zwei Strecken echt (nicht nur an einem gemeinsamen Endpunkt)? */
function segmentsCross(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const o = (p: Vec2, q: Vec2, r: Vec2) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const d1 = o(a, b, c), d2 = o(a, b, d), d3 = o(c, d, a), d4 = o(c, d, b);
  return d1 * d2 < -1e-12 && d3 * d4 < -1e-12;
}

/**
 * Ob der Umriss ein einfaches (selbstüberschneidungsfreies) Polygon ist, das KEIN
 * achsparalleles Rechteck ist — dafür liefert das Skelett ({@link rectilinearHipRoof})
 * für gleichmässig geneigte Dächer (Walm/Zelt) die echten Flächen statt der Bounding-Box.
 */
export function isSkeletonRoofable(outline: Vec2[]): boolean {
  const pts = cleanRing(outline);
  const n = pts.length;
  if (n < 3) return false;
  if (n === 4) {
    const axisRect =
      pts.every((p, i) => {
        const q = pts[(i + 1) % n];
        return Math.abs(p.x - q.x) < 1e-9 || Math.abs(p.y - q.y) < 1e-9;
      });
    if (axisRect) return false; // Rechteck: Bounding-Box-Dach reicht
  }
  if (Math.abs(signedArea(pts)) < 1e-6) return false;
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue; // benachbarte Kanten
      if (segmentsCross(pts[i], pts[(i + 1) % n], pts[j], pts[(j + 1) % n])) return false;
    }
  }
  return true;
}

/** Konvexes Polygon gegen die Halbebene f(p) ≥ 0 schneiden (Sutherland–Hodgman). */
function clipHalf(poly: Vec2[], f: (p: Vec2) => number): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const fa = f(a);
    const fb = f(b);
    if (fa >= 0) out.push(a);
    if ((fa >= 0) !== (fb >= 0)) {
      const t = fa / (fa - fb);
      out.push({ x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) });
    }
  }
  return out;
}

/** Polygon-Booleans brauchen exakt zusammenfallende Punkte: auf ein feines Raster runden. */
let ROUND = 1e-9;
const rnd = (v: number) => Math.round(v / ROUND) * ROUND;
const toRing = (pts: Vec2[]): Ring => pts.map((p) => [rnd(p.x), rnd(p.y)] as [number, number]);

interface EdgeInfo {
  a: Vec2;
  b: Vec2;
  /** Innen-Normale (Einheit). */
  n: Vec2;
}

/** Ergebnis: Dachflächen (konvex, 3D), Grundriss-Linien, Firsthöhe. */
export interface SkeletonRoof {
  planes: Vec3[][];
  ridges: [Vec2, Vec2][];
  hips: [Vec2, Vec2][];
  /** Knicklinien der Mansarde. */
  breaks: [Vec2, Vec2][];
  /** Senkrechte Giebelflächen (nur Satteldach, s. `ridgeAxis`). */
  gables: Vec3[][];
  ridgeHeight: number;
}

/**
 * Walmdach-Flächen über dem rechtwinkligen Traufring `eaves` (beliebige
 * Orientierung) bei Neigung `tan` und Traufhöhe `e`.
 */
function buildHipRoof(
  eavesIn: Vec2[],
  tan: number,
  e: number,
  /** Gesetzt → Satteldach: Kanten quer zu dieser Firstrichtung sind senkrechte Giebel (Ortgang). */
  ridgeAxis?: "x" | "y",
  /** Mansarde: ab Traufabstand `d` flacher (Steigung `tanUp`); Knicklinien landen in `breaks`. */
  knee?: { d: number; tanUp: number },
): SkeletonRoof {
  let eaves = cleanRing(eavesIn);
  if (signedArea(eaves) < 0) eaves = [...eaves].reverse();
  const n = eaves.length;
  const edges: EdgeInfo[] = eaves.map((a, i) => {
    const b = eaves[(i + 1) % n];
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    return { a, b, n: { x: -(b.y - a.y) / len, y: (b.x - a.x) / len } };
  });
  // Giebelkante = quer zur Firstrichtung: keine Neigung, begrenzt nur die Nachbarkeile.
  const isGable = edges.map((ed) =>
    ridgeAxis === undefined
      ? false
      : ridgeAxis === "x"
        ? Math.abs(ed.b.x - ed.a.x) < Math.abs(ed.b.y - ed.a.y)
        : Math.abs(ed.b.y - ed.a.y) < Math.abs(ed.b.x - ed.a.x),
  );
  const dist = (k: number, p: Vec2) => (p.x - edges[k].a.x) * edges[k].n.x + (p.y - edges[k].a.y) * edges[k].n.y;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of eaves) {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
  }
  const pad = (maxX - minX + maxY - minY) * 2 + 10;
  const big: Vec2[] = [
    { x: minX - pad, y: minY - pad },
    { x: maxX + pad, y: minY - pad },
    { x: maxX + pad, y: maxY + pad },
    { x: minX - pad, y: maxY + pad },
  ];
  // Keil je Kante: Innenseite der Kante ∩ Innenseiten der beiden Halbierenden.
  const wedge = edges.map((ed, k) => {
    const prev = edges[(k + n - 1) % n];
    const next = edges[(k + 1) % n];
    // An Giebelkanten steht die Keilgrenze senkrecht zur Traufe (= Verlängerung des Giebels).
    const bisA = isGable[(k + n - 1) % n] ? ed.n : { x: ed.n.x + prev.n.x, y: ed.n.y + prev.n.y };
    const bisB = isGable[(k + 1) % n] ? ed.n : { x: ed.n.x + next.n.x, y: ed.n.y + next.n.y };
    const side = (o: Vec2, dir: Vec2, ref: Vec2) => {
      const s = Math.sign(dir.x * (ref.y - o.y) - dir.y * (ref.x - o.x)) || 1;
      return (p: Vec2) => s * (dir.x * (p.y - o.y) - dir.y * (p.x - o.x));
    };
    let w = clipHalf(big, (p) => dist(k, p));
    // Giebelgrenze minimal nach aussen schieben: deckungsgleich mit der Traufring-Kante
    // würde der Polygon-Boolean an kollinearen Segmenten scheitern.
    const len = Math.hypot(ed.b.x - ed.a.x, ed.b.y - ed.a.y) || 1;
    const ux = ((ed.b.x - ed.a.x) / len) * 1e-4;
    const uy = ((ed.b.y - ed.a.y) / len) * 1e-4;
    const oa = isGable[(k + n - 1) % n] ? { x: ed.a.x - ux, y: ed.a.y - uy } : ed.a;
    const ob = isGable[(k + 1) % n] ? { x: ed.b.x + ux, y: ed.b.y + uy } : ed.b;
    w = clipHalf(w, side(oa, bisA, ed.b));
    w = clipHalf(w, side(ob, bisB, ed.a));
    return w;
  });
  const eavesPoly = [toRing(eaves)];
  const planes: Vec3[][] = [];
  const lineKeys = new Set<string>();
  const ridges: [Vec2, Vec2][] = [];
  const hips: [Vec2, Vec2][] = [];
  const breaks: [Vec2, Vec2][] = [];
  let ridgeHeight = 0;
  // Liegt die Strecke p–q auf einer Traufkante (Gerade UND innerhalb der Strecke)?
  const onSeg = (k: number, p: Vec2) => {
    const { a, b } = edges[k];
    const len2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
    const t = ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / (len2 || 1);
    return Math.abs(dist(k, p)) < 1e-5 && t > -1e-6 && t < 1 + 1e-6;
  };
  const onEaves = (p: Vec2, q: Vec2) => edges.some((_, k) => onSeg(k, p) && onSeg(k, q));

  edges.forEach((_, k) => {
    if (isGable[k] || wedge[k].length < 3) return;
    let face: MultiPolygon = polygonClipping.intersection(eavesPoly, [toRing(wedge[k])]);
    // Bereiche, in denen eine andere Kante tiefer liegt, abziehen.
    const subtract: Ring[][] = [];
    for (let f = 0; f < n; f++) {
      if (f === k || isGable[f] || wedge[f].length < 3) continue;
      // Deckungsgleiche Ebenen (gleiche Gerade/Normale, z. B. zwei Traufkanten einer Flucht
      // mit Versatz dazwischen): g ≡ 0 — nur EINE der beiden Flächen darf die andere
      // abziehen, sonst fällt der überlappende Teil aus beiden heraus (Lücke im Dach).
      const coplanar =
        Math.abs(edges[k].n.x - edges[f].n.x) < 1e-9 &&
        Math.abs(edges[k].n.y - edges[f].n.y) < 1e-9 &&
        Math.abs(dist(f, edges[k].a)) < 1e-9;
      if (coplanar && f > k) continue;
      // dist_f(p) < dist_k(p)  ⇔  g(p) = dist_k(p) − dist_f(p) > 0
      const lower = clipHalf(wedge[f], (p) => dist(k, p) - dist(f, p));
      if (lower.length >= 3 && Math.abs(signedArea(lower)) > 1e-9) subtract.push([toRing(lower)]);
    }
    if (subtract.length > 0 && face.length > 0) face = polygonClipping.difference(face, ...subtract);
    for (const poly of face) {
      const outer = cleanRing(poly[0].slice(0, -1).map(([x, y]) => ({ x: snap(x), y: snap(y) })));
      if (outer.length < 3 || Math.abs(signedArea(outer)) < 1e-6) continue;
      const z = (p: Vec2) => {
        const d = Math.max(0, dist(k, p));
        return knee ? e + tan * Math.min(d, knee.d) + knee.tanUp * Math.max(0, d - knee.d) : e + tan * d;
      };
      for (const piece of convexPieces(outer)) {
        // Mansarde: Teilfläche an der Knicklinie (Traufabstand = knee.d) teilen.
        const parts = knee
          ? [clipHalf(piece, (p) => knee.d - dist(k, p)), clipHalf(piece, (p) => dist(k, p) - knee.d)]
          : [piece];
        for (const part of parts) {
          if (part.length < 3 || Math.abs(signedArea(part)) < 1e-9) continue;
          planes.push(part.map((p) => [p.x, p.y, z(p)] as Vec3));
        }
        if (knee) {
          const low = clipHalf(piece, (p) => knee.d - dist(k, p));
          for (let i = 0; i < low.length; i++) {
            const p = low[i];
            const q = low[(i + 1) % low.length];
            if (Math.abs(dist(k, p) - knee.d) < 1e-6 && Math.abs(dist(k, q) - knee.d) < 1e-6) breaks.push([p, q]);
          }
        }
      }
      // Grat-/Kehl-/Firstlinien: Flächenränder, die nicht auf der Traufe liegen.
      for (let i = 0; i < outer.length; i++) {
        const p = outer[i];
        const q = outer[(i + 1) % outer.length];
        if (onEaves(p, q)) continue;
        const r = (v: number) => Math.round(v * 1e5);
        const kp = `${r(p.x)},${r(p.y)}`;
        const kq = `${r(q.x)},${r(q.y)}`;
        const key = kp < kq ? `${kp}|${kq}` : `${kq}|${kp}`;
        if (lineKeys.has(key)) continue;
        lineKeys.add(key);
        const zp = z(p);
        const zq = z(q);
        ridgeHeight = Math.max(ridgeHeight, zp - e, zq - e);
        if (Math.abs(zp - zq) < 1e-6) ridges.push([p, q]);
        else hips.push([p, q]);
      }
    }
  });
  // Giebelflächen: Profil = alle Flächenecken auf der Giebelkante, nach Lage sortiert.
  const gables: Vec3[][] = [];
  edges.forEach((ed, k) => {
    if (!isGable[k]) return;
    const len2 = (ed.b.x - ed.a.x) ** 2 + (ed.b.y - ed.a.y) ** 2;
    const top: { t: number; v: Vec3 }[] = [];
    for (const pl of planes) {
      for (const v of pl) {
        const t = ((v[0] - ed.a.x) * (ed.b.x - ed.a.x) + (v[1] - ed.a.y) * (ed.b.y - ed.a.y)) / len2;
        if (Math.abs(dist(k, { x: v[0], y: v[1] })) < 1e-5 && t > -1e-6 && t < 1 + 1e-6) top.push({ t, v });
      }
    }
    top.sort((p, q) => p.t - q.t);
    const prof = top.filter((p, i) => i === 0 || Math.abs(p.t - top[i - 1].t) > 1e-6);
    if (prof.length < 2) return;
    const poly: Vec3[] = [
      [ed.a.x, ed.a.y, e],
      [ed.b.x, ed.b.y, e],
      ...prof.reverse().map((p) => p.v),
    ];
    gables.push(poly);
  });
  return { planes, ridges, hips, breaks, gables, ridgeHeight };
}

/**
 * Walm-/Satteldach-Flächen über dem Traufring (s. {@link buildHipRoof}). Die Polygon-
 * Booleans scheitern bei schiefen Winkeln gelegentlich an Rundungsrauschen ("Unable to
 * complete output ring") — dann mit gröberem Raster erneut versuchen.
 */
export function rectilinearHipRoof(
  eavesIn: Vec2[],
  tan: number,
  e: number,
  ridgeAxis?: "x" | "y",
  knee?: { d: number; tanUp: number },
): SkeletonRoof {
  let lastError: unknown;
  for (const step of [1e-9, 1e-7, 1e-6, 1e-5]) {
    ROUND = step;
    try {
      return buildHipRoof(eavesIn, tan, e, ridgeAxis, knee);
    } catch (err) {
      lastError = err;
    }
  }
  ROUND = 1e-9;
  throw lastError;
}

// ── Konvexe Zerlegung ───────────────────────────────────────────────────────

const cross = (o: Vec2, a: Vec2, b: Vec2) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

function isConvex(poly: Vec2[]): boolean {
  for (let i = 0; i < poly.length; i++) {
    if (cross(poly[i], poly[(i + 1) % poly.length], poly[(i + 2) % poly.length]) < -1e-12) return false;
  }
  return true;
}

/** Ohr-Schnitt eines einfachen CCW-Polygons → Dreiecke (Indizes). */
function earClip(poly: Vec2[]): number[][] {
  const idx = poly.map((_, i) => i);
  const tris: number[][] = [];
  const inTri = (p: Vec2, a: Vec2, b: Vec2, c: Vec2) =>
    cross(a, b, p) >= -1e-12 && cross(b, c, p) >= -1e-12 && cross(c, a, p) >= -1e-12;
  let guard = 0;
  while (idx.length > 3 && guard++ < 10000) {
    let cut = false;
    for (let i = 0; i < idx.length; i++) {
      const ia = idx[(i + idx.length - 1) % idx.length];
      const ib = idx[i];
      const ic = idx[(i + 1) % idx.length];
      const a = poly[ia], b = poly[ib], c = poly[ic];
      if (cross(a, b, c) <= 1e-12) continue; // einspringend/entartet
      const blocked = idx.some((j) => j !== ia && j !== ib && j !== ic && inTri(poly[j], a, b, c));
      if (blocked) continue;
      tris.push([ia, ib, ic]);
      idx.splice(i, 1);
      cut = true;
      break;
    }
    if (!cut) break; // numerisch entartet: Rest als Fächer
  }
  for (let i = 1; i + 1 < idx.length; i++) tris.push([idx[0], idx[i], idx[i + 1]]);
  return tris;
}

/** Konvexe Teilpolygone (CCW-Eingabe): Ohr-Schnitt, dann Hertel–Mehlhorn-Verschmelzen. */
export function convexPieces(polyIn: Vec2[]): Vec2[][] {
  const poly = signedArea(polyIn) < 0 ? [...polyIn].reverse() : polyIn;
  if (isConvex(poly)) return [poly];
  let pieces: number[][] = earClip(poly);
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < pieces.length; i++) {
      for (let j = i + 1; j < pieces.length; j++) {
        const A = pieces[i];
        const B = pieces[j];
        // Gemeinsame Kante (u→v in A, v→u in B) suchen.
        for (let s = 0; s < A.length; s++) {
          const u = A[s];
          const v = A[(s + 1) % A.length];
          const t = B.findIndex((x, k) => x === v && B[(k + 1) % B.length] === u);
          if (t < 0) continue;
          // A ab v rundum bis u, dann B ab u (ohne u) bis vor v.
          const rotA: number[] = [];
          for (let k = 0; k < A.length; k++) rotA.push(A[(s + 1 + k) % A.length]); // v … u
          const rotB: number[] = [];
          for (let k = 2; k < B.length; k++) rotB.push(B[(t + k) % B.length]); // nach u … vor v
          const cand = [...rotA, ...rotB];
          if (isConvex(cand.map((q) => poly[q]))) {
            pieces = pieces.filter((_, k) => k !== i && k !== j);
            pieces.push(cand);
            merged = true;
            break outer;
          }
        }
      }
    }
  }
  return pieces.map((pc) => pc.map((q) => poly[q]));
}
