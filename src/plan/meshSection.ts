// Ebenenschnitt beliebiger Dreiecksnetze (docs/boolean-geometrie-plan.md, Baustein 1 / [G1]).
//
// Schneidet ein Netz (Modell-Koordinaten x, y, z = Höhe — wie `ImportedMesh`/`TerrainMesh`/truck-
// Meshes) mit einer SENKRECHTEN Ebene (Schnitt) oder einer WAAGRECHTEN Ebene (Grundriss auf
// Schnitthöhe) und liefert Linienzüge bzw. Ringe in den Ebenen-Koordinaten:
//   • senkrecht:  (u, v) wie die Schnitt-Pipeline (u entlang der Ebene, v = Höhe),
//   • waagrecht:  (x, y).
// Geschlossene Netze (Körper) ergeben geschlossene Ringe → Polygone mit Löchern; offene Netze
// (Gelände) ergeben offene Linienzüge (Geländelinie im Schnitt).
//
// Robustheit: Ecken exakt AUF der Ebene werden einheitlich der „hinteren" Seite zugeschlagen
// (symbolische Störung, `d > 0` ⇒ vorn) — so schliessen sich die Segmente auch bei Netzen, deren
// Ecken genau auf der Schnittlinie liegen (Achsen im Raster!).

export type Pt2 = [number, number];

export interface CutResult {
  /** Geschlossene Ringe (Körper). */
  rings: Pt2[][];
  /** Offene Linienzüge (offene Netze, z. B. Gelände). */
  lines: Pt2[][];
}

/** Ebene durch `point` (Modell x,y) in Richtung `dir` (Einheitsvektor): senkrechter Schnitt. */
export interface VerticalPlane {
  kind: "vertical";
  point: { x: number; y: number };
  dir: { x: number; y: number };
}
/** Waagrechte Ebene auf Höhe `z`. */
export interface HorizontalPlane {
  kind: "horizontal";
  z: number;
}
export type CutPlane = VerticalPlane | HorizontalPlane;

const QUANT = 1e6;
const key = (p: Pt2): string => `${Math.round(p[0] * QUANT)},${Math.round(p[1] * QUANT)}`;

/**
 * Schneidet das Netz mit `plane`. `positions` flach [x,y,z,…], `indices` je 3 ein Dreieck.
 * Entartete Segmente (Länge ~0) werden verworfen.
 */
export function cutMeshWithPlane(positions: ArrayLike<number>, indices: ArrayLike<number>, plane: CutPlane): CutResult {
  const nv = Math.floor(positions.length / 3);
  // Signierter Abstand + 2D-Koordinate je Vertex.
  const dist = new Float64Array(nv);
  const c0 = new Float64Array(nv);
  const c1 = new Float64Array(nv);
  for (let i = 0; i < nv; i++) {
    const x = positions[i * 3];
    const y = positions[i * 3 + 1];
    const z = positions[i * 3 + 2];
    if (plane.kind === "vertical") {
      // Normale der Ebene (im Grundriss): n = (dir.y, −dir.x); u = Position entlang dir.
      dist[i] = (x - plane.point.x) * plane.dir.y - (y - plane.point.y) * plane.dir.x;
      c0[i] = (x - plane.point.x) * plane.dir.x + (y - plane.point.y) * plane.dir.y;
      c1[i] = z;
    } else {
      dist[i] = z - plane.z;
      c0[i] = x;
      c1[i] = y;
    }
  }

  // Kanten-Schnittpunkte cachen (jede Kante gehört zu bis zu 2 Dreiecken → gleicher Punkt).
  const edgePt = new Map<number, Pt2>();
  const edgeKey = (a: number, b: number): number => (a < b ? a * nv + b : b * nv + a);
  const crossing = (a: number, b: number): Pt2 => {
    const k = edgeKey(a, b);
    let p = edgePt.get(k);
    if (!p) {
      const t = dist[a] / (dist[a] - dist[b]);
      p = [c0[a] + (c0[b] - c0[a]) * t, c1[a] + (c1[b] - c1[a]) * t];
      edgePt.set(k, p);
    }
    return p;
  };

  const segs: Array<[Pt2, Pt2]> = [];
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const a = indices[t];
    const b = indices[t + 1];
    const c = indices[t + 2];
    const sa = dist[a] > 0;
    const sb = dist[b] > 0;
    const sc = dist[c] > 0;
    if (sa === sb && sb === sc) continue;
    // Genau eine Ecke steht allein auf ihrer Seite: die beiden Kanten dort bilden das Segment.
    const odd = sa !== sb && sa !== sc ? a : sb !== sa && sb !== sc ? b : c;
    const o1 = odd === a ? b : odd === b ? c : a;
    const o2 = odd === a ? c : odd === b ? a : b;
    const p = crossing(odd, o1);
    const q = crossing(odd, o2);
    if (Math.abs(p[0] - q[0]) < 1e-9 && Math.abs(p[1] - q[1]) < 1e-9) continue;
    // Einheitlicher Umlaufsinn je Seite der Einzelecke → Segmente benachbarter Dreiecke fügen
    // sich bei gleichsinnig orientiertem Netz zu gleichsinnigen Ketten.
    segs.push(dist[odd] > 0 ? [q, p] : [p, q]);
  }
  return chain(segs);
}

/** Verkettet Segmente zu Ringen und Linienzügen. */
function chain(segs: Array<[Pt2, Pt2]>): CutResult {
  // Start-/Endpunkt-Index.
  const byStart = new Map<string, number[]>();
  const byEnd = new Map<string, number[]>();
  segs.forEach((s, i) => {
    const ks = key(s[0]);
    const ke = key(s[1]);
    (byStart.get(ks) ?? byStart.set(ks, []).get(ks)!).push(i);
    (byEnd.get(ke) ?? byEnd.set(ke, []).get(ke)!).push(i);
  });
  const used = new Array<boolean>(segs.length).fill(false);
  const take = (m: Map<string, number[]>, k: string): number => {
    const l = m.get(k);
    if (!l) return -1;
    while (l.length) {
      const i = l.pop()!;
      if (!used[i]) return i;
    }
    return -1;
  };
  const rings: Pt2[][] = [];
  const lines: Pt2[][] = [];
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    const pts: Pt2[] = [segs[i][0], segs[i][1]];
    const startKey = key(pts[0]);
    // vorwärts
    for (;;) {
      const k = key(pts[pts.length - 1]);
      if (k === startKey && pts.length > 2) break;
      const n = take(byStart, k);
      if (n < 0) break;
      used[n] = true;
      pts.push(segs[n][1]);
    }
    if (key(pts[pts.length - 1]) === startKey && pts.length > 3) {
      pts.pop();
      rings.push(pts);
      continue;
    }
    // rückwärts verlängern (offener Zug)
    for (;;) {
      const k = key(pts[0]);
      const n = take(byEnd, k);
      if (n < 0) break;
      used[n] = true;
      pts.unshift(segs[n][0]);
      if (key(pts[0]) === key(pts[pts.length - 1])) {
        pts.shift();
        rings.push(pts);
        pts.length = 0;
        break;
      }
    }
    if (pts.length >= 2) lines.push(pts);
  }
  return { rings, lines };
}

export const ringArea = (r: Pt2[]): number => {
  let a = 0;
  for (let i = 0; i < r.length; i++) {
    const p = r[i];
    const q = r[(i + 1) % r.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
};

function pointInRing(p: Pt2, r: Pt2[]): boolean {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i];
    const [xj, yj] = r[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Ring mit Löchern (Aussenring zuerst, dann Löcher). */
export type RingSet = Pt2[][];

/**
 * Ordnet geschlossene Ringe zu Aussenring + Löchern (Schachtelungstiefe gerade = aussen, ungerade =
 * Loch). Unabhängig vom Umlaufsinn. Aussenringe zuerst-gross; Löcher folgen ihrem Aussenring.
 */
export function ringsToPolygons(rings: Pt2[][]): RingSet[] {
  const items = rings
    .filter((r) => r.length >= 3 && Math.abs(ringArea(r)) > 1e-12)
    .map((r) => ({ r, area: Math.abs(ringArea(r)) }))
    .sort((a, b) => b.area - a.area);
  const depth: number[] = items.map(() => 0);
  const parent: number[] = items.map(() => -1);
  for (let i = 0; i < items.length; i++) {
    for (let j = i - 1; j >= 0; j--) {
      // Kandidat j (grösser) enthält i? Test mit einem Punkt von i (nicht auf dem Rand von j).
      if (pointInRing(items[i].r[0], items[j].r)) {
        parent[i] = j;
        depth[i] = depth[j] + 1;
        break;
      }
    }
  }
  const out: RingSet[] = [];
  const idx = new Map<number, number>();
  items.forEach((it, i) => {
    if (depth[i] % 2 === 0) {
      idx.set(i, out.length);
      out.push([it.r]);
    }
  });
  items.forEach((it, i) => {
    if (depth[i] % 2 === 1) {
      const owner = idx.get(parent[i]);
      if (owner !== undefined) out[owner].push(it.r);
    }
  });
  return out;
}
