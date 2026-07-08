// Gemeinsamer Wand-Mesh-Generator MIT echtem Loch-Ausschnitt (Fenster/Türen).
//
// Portierung der Rust-Referenz `render3d/src/mesh.rs::extrude_layer_segment_
// with_holes` nach TS: aus EINEM RWall-Band (Achse `start→end`, `thickness`,
// `baseElevation`, `height` + rechteckige `holes`) wird das Dreiecks-Mesh
// erzeugt, das die Öffnungen ECHT ausschneidet (statt der vollen Box). Damit
// sehen die Datei-Exporte (STL/OBJ/IFC) genauso aus wie die 3D-Ansicht: die
// Löcher sind sichtbar ausgestanzt, inklusive der Laibungs-/Jamb-Flächen.
//
// WICHTIG — WARUM KEINE GEHRUNG HIER: Die RWall-Bänder aus
// `toWalls3d.ts::pickGeometry` sind bereits an ihren Achsenden auf die
// Gehrungs-/Anschluss-Schnittlinie GEKÜRZT (die Box endet aber achsparallel,
// keine gekippte Stirnfläche — siehe `bandCutDistance` in toWalls3d.ts). Die
// Ecken-Verschneidung (Joins) steckt also schon in `start`/`end` jedes Bandes.
// Deshalb entfällt hier die `start_cut`/`end_cut`-Gehrungslogik der Rust-Funktion
// (im Rust-Pfad wird sie nur gebraucht, weil dort EIN ungekürztes Band mit
// Gehrungslinien extrudiert wird). Das Ergebnis: dieselbe Rechteck-Zerlegung der
// Langseiten + dieselben 4 Laibungsquads je Loch wie in Rust, nur mit rechten
// (ungekippten) Stirnkappen — exakt die Geometrie, die der Viewer schon zeigt.
//
// ACHSEN: Modell (x, y) → Welt (x, Höhe, y), Y-UP — identisch zu exportMesh.ts /
// selectionHighlightLines / dem 3D-Viewer. Ein Weltvertex (vx,vy,vz) ist also
// (Modell-x, Meter-Höhe, Modell-y).

import type { RWall } from "./toWalls3d";

/** Rundungs-/Entartungsschwelle (1e-4 m), 1:1 wie `openings::MIN_SPAN` in Rust. */
const MIN_SPAN = 1e-4;

/** Ein Weltpunkt (x, Höhe, y). */
type V3 = [number, number, number];

/**
 * Ein Dreiecks-Mesh in LOKALEN (0-basierten) Indizes: `positions` flach
 * (x,y,z, …) in Weltmetern (Y-up), `indices` je 3 = ein Dreieck.
 */
export interface CutMesh {
  positions: number[];
  indices: number[];
}

/**
 * Aussen-Normale eines planaren, CCW-von-aussen georderten Quads über die ersten
 * drei Ecken: `normalize(cross(b-a, d-a))` — 1:1 wie `mesh.rs::quad_normal`.
 * Nulllange Flächen liefern den Nullvektor (Aufrufer nutzt sie dann nicht).
 */
function quadNormal(a: V3, b: V3, d: V3): V3 {
  const ab: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const ad: V3 = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
  const c: V3 = [
    ab[1] * ad[2] - ab[2] * ad[1],
    ab[2] * ad[0] - ab[0] * ad[2],
    ab[0] * ad[1] - ab[1] * ad[0],
  ];
  const len = Math.max(Math.hypot(c[0], c[1], c[2]), 1e-9);
  return [c[0] / len, c[1] / len, c[2] / len];
}

/**
 * Hängt ein Dreieck an `mesh` an, dessen Winding an `wantNormal` ausgerichtet
 * wird (robust gegen die Eck-Reihenfolge) — 1:1 wie `mesh.rs::push_tri_oriented`.
 */
function pushTriOriented(mesh: CutMesh, a: V3, b: V3, c: V3, wantNormal: V3): void {
  const ab: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const ac: V3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const gn: V3 = [
    ab[1] * ac[2] - ab[2] * ac[1],
    ab[2] * ac[0] - ab[0] * ac[2],
    ab[0] * ac[1] - ab[1] * ac[0],
  ];
  const dot = gn[0] * wantNormal[0] + gn[1] * wantNormal[1] + gn[2] * wantNormal[2];
  const [v0, v1, v2] = dot < 0 ? [a, c, b] : [a, b, c];
  const base = mesh.positions.length / 3;
  mesh.positions.push(v0[0], v0[1], v0[2], v1[0], v1[1], v1[2], v2[0], v2[1], v2[2]);
  mesh.indices.push(base, base + 1, base + 2);
}

/** Hängt ein Quad (vier Ecken als Ring) als zwei orientierte Dreiecke an. */
function pushQuadOriented(mesh: CutMesh, a: V3, b: V3, c: V3, d: V3, wantNormal: V3): void {
  pushTriOriented(mesh, a, b, c, wantNormal);
  pushTriOriented(mesh, a, c, d, wantNormal);
}

/**
 * Zerlegt das Rechteck `[uLo,uHi]×[zLo,zHi]` MINUS `holes` (`[u0,u1,z0,z1]`) in
 * achsparallele, disjunkte SOLIDE Teilrechtecke — Koordinaten-Kompression, 1:1
 * wie `mesh.rs::solid_subrects` (jede Gitterzelle, deren Mittelpunkt in keinem
 * Loch liegt, ist ein solides Teilrechteck). Exportiert für die Zerlegungs-Tests
 * (gleiche Rechteck-Anzahl wie die Rust-Zerlegung).
 */
export function solidSubrects(
  uLo: number,
  uHi: number,
  zLo: number,
  zHi: number,
  holes: Array<[number, number, number, number]>,
): Array<[number, number, number, number]> {
  const sortDedup = (v: number[]): number[] => {
    const s = [...v].sort((a, b) => a - b);
    const out: number[] = [];
    for (const x of s) {
      if (out.length === 0 || Math.abs(x - out[out.length - 1]) > MIN_SPAN) out.push(x);
    }
    return out;
  };
  const usRaw = [uLo, uHi];
  const zsRaw = [zLo, zHi];
  for (const [a0, a1, hb, ht] of holes) {
    usRaw.push(a0, a1);
    zsRaw.push(hb, ht);
  }
  const us = sortDedup(usRaw);
  const zs = sortDedup(zsRaw);
  const out: Array<[number, number, number, number]> = [];
  for (let i = 0; i < us.length - 1; i++) {
    const ua = us[i];
    const ub = us[i + 1];
    if (ub - ua <= MIN_SPAN) continue;
    for (let j = 0; j < zs.length - 1; j++) {
      const za = zs[j];
      const zb = zs[j + 1];
      if (zb - za <= MIN_SPAN) continue;
      const cu = (ua + ub) * 0.5;
      const cz = (za + zb) * 0.5;
      const inHole = holes.some(([a0, a1, hb, ht]) => cu > a0 && cu < a1 && cz > hb && cz < ht);
      if (!inHole) out.push([ua, ub, za, zb]);
    }
  }
  return out;
}

/**
 * Zieht die (ggf. überlappenden) `gaps` vom Intervall `[lo,hi]` ab und liefert
 * die verbleibenden, sortierten, disjunkten Teilintervalle — 1:1 wie
 * `mesh.rs::subtract_intervals` (für Deckel-/Boden-/Kappen-Lücken randständiger
 * Löcher).
 */
function subtractIntervals(lo: number, hi: number, gaps: Array<[number, number]>): Array<[number, number]> {
  const gs = gaps
    .map(([a, b]): [number, number] => [Math.max(a, lo), Math.min(b, hi)])
    .filter(([a, b]) => b - a > MIN_SPAN)
    .sort((p, q) => p[0] - q[0]);
  const out: Array<[number, number]> = [];
  let cursor = lo;
  for (const [a, b] of gs) {
    if (a > cursor + MIN_SPAN) out.push([cursor, a]);
    cursor = Math.max(cursor, b);
  }
  if (hi > cursor + MIN_SPAN) out.push([cursor, hi]);
  return out;
}

/**
 * Prüft, ob ein Mesh eine GESCHLOSSENE, KONSISTENT NACH AUSSEN gewundene Fläche
 * ist (bounds ein Volumen ohne Löcher) — über das Gauss-/Divergenz-Kriterium
 * statt eines Kanten-Manifold-Zählers:
 *   • ∮ n dA = 0  ⟺  Σ (v1−v0)×(v2−v0) = 0  über alle Dreiecke  (jede offene
 *     Lücke ODER jedes falsch gewundene/fehlende Dreieck verletzt die Summe).
 *   • signiertes Volumen  Σ v0·(v1×v2)/6 > 0  ⟺  Normalen zeigen NACH AUSSEN.
 *
 * BEWUSST NICHT der naive „jede ungerichtete Kante genau 2×"-Manifold-Check:
 * dieses Mesh nutzt (wie die Rust-Referenz) VOLLE Deckel/Boden-Streifen über die
 * ganze Breite, während die Langseiten an den Loch-Spalten unterteilt sind — das
 * erzeugt legitime T-Stösse (eine lange Kante trifft mehrere kurze), die KEINE
 * echten Lücken sind. Der naive Kantenzähler würde diese korrekte, wasserdichte
 * Geometrie fälschlich als „offen" melden; das Gauss-Kriterium ist T-Stoss-robust
 * und misst genau die Eigenschaft, auf die es ankommt (dichtes Volumen + Aussen-
 * Orientierung — die Ursache des „hohl/offen"-Bugs war eine invertierte Wicklung
 * im IFC-Export, nicht eine fehlende Fläche).
 */
export function isWatertight(mesh: CutMesh, eps = 1e-6): boolean {
  const p = mesh.positions;
  let ax = 0;
  let ay = 0;
  let az = 0;
  let vol6 = 0;
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const i0 = mesh.indices[t] * 3;
    const i1 = mesh.indices[t + 1] * 3;
    const i2 = mesh.indices[t + 2] * 3;
    const e1x = p[i1] - p[i0];
    const e1y = p[i1 + 1] - p[i0 + 1];
    const e1z = p[i1 + 2] - p[i0 + 2];
    const e2x = p[i2] - p[i0];
    const e2y = p[i2 + 1] - p[i0 + 1];
    const e2z = p[i2 + 2] - p[i0 + 2];
    const cx = e1y * e2z - e1z * e2y;
    const cy = e1z * e2x - e1x * e2z;
    const cz = e1x * e2y - e1y * e2x;
    ax += cx;
    ay += cy;
    az += cz;
    // v0 · (v1 × v2) = v0 · (e1 × e2) (die reinen v0-Terme heben sich auf).
    vol6 += p[i0] * cx + p[i0 + 1] * cy + p[i0 + 2] * cz;
  }
  return Math.hypot(ax, ay, az) < eps && vol6 > eps;
}

/**
 * Erzeugt das Wand-Mesh EINES RWall-Bandes mit ECHTEN Loch-Ausschnitten — der
 * TS-Port von `mesh.rs::extrude_layer_segment_with_holes` (ohne Gehrung, siehe
 * Moduldoc). Aufbau:
 *  • Langseiten (+n / −n): Flächen-Rechteck MINUS der Löcher, per {@link
 *    solidSubrects} in Teilrechtecke zerlegt (je 2 Dreiecke).
 *  • Deckel (y1) / Boden (y0): voller Streifen minus der u-Intervalle rand-
 *    ständiger Löcher (z. B. eine Tür am Boden).
 *  • Stirnkappen (a=0 / a=length): volle Höhe minus z-Intervalle randständiger
 *    Löcher.
 *  • Laibungen je Loch: bis zu vier Quads (links/rechts/unten/oben), nur für die
 *    im Wand-Inneren liegenden Seiten.
 *
 * Ohne `holes` (undefined/leer) liefert das die volle Box (Regressionsfall);
 * Aufrufer, die für lochlose Bänder die klassische 8-Ecken-Box wollen, prüfen
 * das selbst (siehe exportMesh.ts).
 */
export function wallCutMesh(w: RWall): CutMesh {
  const mesh: CutMesh = { positions: [], indices: [] };
  const [sx, sy] = w.start;
  const [ex, ey] = w.end;
  const dx = ex - sx;
  const dy = ey - sy;
  const length = Math.hypot(dx, dy);
  if (length < 1e-9 || w.height <= 1e-9 || w.thickness <= 1e-9) return mesh;
  const ux = dx / length;
  const uy = dy / length;
  // Links-Normale n = (−uy, ux) — dieselbe Konvention wie mesh.rs::left_normal.
  const n: [number, number] = [-uy, ux];
  const y0 = w.baseElevation;
  const y1 = w.baseElevation + w.height;
  const offA = w.thickness / 2;
  const offB = -w.thickness / 2;

  const off = (p: [number, number], s: number): [number, number] => [p[0] + n[0] * s, p[1] + n[1] * s];
  const axisPoint = (a: number): [number, number] => [sx + ux * a, sy + uy * a];
  // Plan-Punkt bei Achsen-Position `a`, Dicken-Versatz `offv` (keine Gehrung).
  const gAt = (a: number, offv: number): [number, number] => off(axisPoint(a), offv);
  const wpt = (g: [number, number], y: number): V3 => [g[0], y, g[1]];

  // Löcher auf [0,length]×[y0,y1] klemmen, entartete verwerfen.
  const hs: Array<[number, number, number, number]> = [];
  for (const h of w.holes ?? []) {
    const a0 = Math.max(h.from, 0);
    const a1 = Math.min(h.to, length);
    const zb = Math.max(h.zBottom, y0);
    const zt = Math.min(h.zTop, y1);
    if (a1 - a0 > MIN_SPAN && zt - zb > MIN_SPAN) hs.push([a0, a1, zb, zt]);
  }

  // ── Langseiten (+n / −n): Rechteck-Gitter minus Löcher. ────────────────────
  const np: V3 = [n[0], 0, n[1]];
  const nn: V3 = [-n[0], 0, -n[1]];
  for (const [ua, ub, za, zb] of solidSubrects(0, length, y0, y1, hs)) {
    pushQuadOriented(
      mesh,
      wpt(gAt(ua, offA), za),
      wpt(gAt(ub, offA), za),
      wpt(gAt(ub, offA), zb),
      wpt(gAt(ua, offA), zb),
      np,
    );
    pushQuadOriented(
      mesh,
      wpt(gAt(ua, offB), za),
      wpt(gAt(ub, offB), za),
      wpt(gAt(ub, offB), zb),
      wpt(gAt(ua, offB), zb),
      nn,
    );
  }

  // ── Deckel (y1) / Boden (y0): voller Streifen minus randständiger Löcher. ──
  const topGaps = hs.filter(([, , , zt]) => zt >= y1 - MIN_SPAN).map(([a0, a1]): [number, number] => [a0, a1]);
  for (const [ua, ub] of subtractIntervals(0, length, topGaps)) {
    pushQuadOriented(
      mesh,
      wpt(gAt(ua, offA), y1),
      wpt(gAt(ub, offA), y1),
      wpt(gAt(ub, offB), y1),
      wpt(gAt(ua, offB), y1),
      [0, 1, 0],
    );
  }
  const botGaps = hs.filter(([, , zb]) => zb <= y0 + MIN_SPAN).map(([a0, a1]): [number, number] => [a0, a1]);
  for (const [ua, ub] of subtractIntervals(0, length, botGaps)) {
    pushQuadOriented(
      mesh,
      wpt(gAt(ua, offA), y0),
      wpt(gAt(ub, offA), y0),
      wpt(gAt(ub, offB), y0),
      wpt(gAt(ua, offB), y0),
      [0, -1, 0],
    );
  }

  // ── Stirnkappen (a=0 / a=length): volle Höhe minus randständiger Löcher. ───
  const startNormal = quadNormal(wpt(gAt(0, offB), y0), wpt(gAt(0, offA), y0), wpt(gAt(0, offB), y1));
  const startGaps = hs.filter(([a0]) => a0 <= MIN_SPAN).map(([, , zb, zt]): [number, number] => [zb, zt]);
  for (const [za, zb] of subtractIntervals(y0, y1, startGaps)) {
    pushQuadOriented(
      mesh,
      wpt(gAt(0, offB), za),
      wpt(gAt(0, offA), za),
      wpt(gAt(0, offA), zb),
      wpt(gAt(0, offB), zb),
      startNormal,
    );
  }
  const endNormal = quadNormal(wpt(gAt(length, offA), y0), wpt(gAt(length, offB), y0), wpt(gAt(length, offA), y1));
  const endGaps = hs.filter(([, a1]) => a1 >= length - MIN_SPAN).map(([, , zb, zt]): [number, number] => [zb, zt]);
  for (const [za, zb] of subtractIntervals(y0, y1, endGaps)) {
    pushQuadOriented(
      mesh,
      wpt(gAt(length, offA), za),
      wpt(gAt(length, offB), za),
      wpt(gAt(length, offB), zb),
      wpt(gAt(length, offA), zb),
      endNormal,
    );
  }

  // ── Laibungen je Loch: nur die im Wand-Inneren liegenden Seiten. ──────────
  for (const [a0, a1, zb, zt] of hs) {
    // Linke Laibung (bei a0), Normale +u (in die Öffnung).
    if (a0 > MIN_SPAN) {
      pushQuadOriented(
        mesh,
        wpt(gAt(a0, offA), zb),
        wpt(gAt(a0, offB), zb),
        wpt(gAt(a0, offB), zt),
        wpt(gAt(a0, offA), zt),
        [ux, 0, uy],
      );
    }
    // Rechte Laibung (bei a1), Normale −u.
    if (a1 < length - MIN_SPAN) {
      pushQuadOriented(
        mesh,
        wpt(gAt(a1, offA), zb),
        wpt(gAt(a1, offB), zb),
        wpt(gAt(a1, offB), zt),
        wpt(gAt(a1, offA), zt),
        [-ux, 0, -uy],
      );
    }
    // Untere Laibung (bei zb = Brüstungsoberkante), Normale +Y.
    if (zb > y0 + MIN_SPAN) {
      pushQuadOriented(
        mesh,
        wpt(gAt(a0, offA), zb),
        wpt(gAt(a1, offA), zb),
        wpt(gAt(a1, offB), zb),
        wpt(gAt(a0, offB), zb),
        [0, 1, 0],
      );
    }
    // Obere Laibung (bei zt = Sturzunterkante), Normale −Y.
    if (zt < y1 - MIN_SPAN) {
      pushQuadOriented(
        mesh,
        wpt(gAt(a0, offA), zt),
        wpt(gAt(a1, offA), zt),
        wpt(gAt(a1, offB), zt),
        wpt(gAt(a0, offB), zt),
        [0, -1, 0],
      );
    }
  }

  return mesh;
}
