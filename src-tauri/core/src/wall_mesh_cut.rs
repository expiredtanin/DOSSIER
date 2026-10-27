//! Wand-Mesh MIT echtem Loch-Ausschnitt (Fenster/Türen) für die Datei-Exporte (STL/OBJ/IFC):
//! aus EINEM Wandband (`RWall`: Achse, Dicke, UK, Höhe, rechteckige Löcher) entsteht das
//! Dreiecksnetz mit ausgestanzten Öffnungen samt Laibungsflächen — dieselbe Zerlegung wie
//! `render3d/src/mesh.rs::extrude_layer_segment_with_holes`, aber ohne Gehrung (die Bänder aus
//! [`crate::wall_bands`] sind an den Enden schon gekürzt). Portiert aus `src/plan/wallMeshCut.ts`.
//!
//! Achsen: Modell (x, y) → Welt (x, Höhe, y), Y-up. Jedes Dreieck hat drei eigene Ecken; die
//! Indizes sind daher fortlaufend `0, 1, 2, …` und werden nicht übertragen.
//!
//! Bitgleich zur früheren TS-Fassung (gleiche Operationsreihenfolge, `Math.hypot` wie V8).

use crate::flat_read::Reader;
use crate::joins::js_hypot;
use crate::openings3d::{jmax, jmin};
use kernel2d::{add, left_normal, scale, Vec2};

/// Rundungs-/Entartungsschwelle (wie `openings::MIN_SPAN` in render3d).
const MIN_SPAN: f64 = 1e-4;

type V3 = [f64; 3];

/// Ein Wandband mit Löchern `[from, to, zBottom, zTop]` (Achs-Meter ab Start, absolute Höhen).
#[derive(Clone, Debug, PartialEq)]
pub struct CutWall {
    pub start: [f64; 2],
    pub end: [f64; 2],
    pub thickness: f64,
    pub base_elevation: f64,
    pub height: f64,
    pub holes: Vec<[f64; 4]>,
}

/// `Math.hypot(x, y, z)` wie V8 (Skalierung mit dem Maximum, kompensierte Summe).
fn js_hypot3(x: f64, y: f64, z: f64) -> f64 {
    let v = [x.abs(), y.abs(), z.abs()];
    if v.iter().any(|a| a.is_infinite()) {
        return f64::INFINITY;
    }
    if v.iter().any(|a| a.is_nan()) {
        return f64::NAN;
    }
    let max = v[0].max(v[1]).max(v[2]);
    if max == 0.0 {
        return 0.0;
    }
    let mut sum = 0.0;
    let mut comp = 0.0;
    for a in v {
        let n = a / max;
        let summand = n * n - comp;
        let pre = sum + summand;
        comp = (pre - sum) - summand;
        sum = pre;
    }
    sum.sqrt() * max
}

fn cross(a: V3, b: V3) -> V3 {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

fn sub3(a: V3, b: V3) -> V3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

/// Aussen-Normale eines planaren Quads über die Ecken a, b, d (`mesh.rs::quad_normal`).
fn quad_normal(a: V3, b: V3, d: V3) -> V3 {
    let c = cross(sub3(b, a), sub3(d, a));
    let l = js_hypot3(c[0], c[1], c[2]);
    // `Math.max(len, 1e-9)` (NaN bleibt NaN).
    let l = if l.is_nan() { l } else { l.max(1e-9) };
    [c[0] / l, c[1] / l, c[2] / l]
}

/// Dreieck mit Wicklung nach `want` (`mesh.rs::push_tri_oriented`).
fn push_tri(out: &mut Vec<f64>, a: V3, b: V3, c: V3, want: V3) {
    let g = cross(sub3(b, a), sub3(c, a));
    let dot = g[0] * want[0] + g[1] * want[1] + g[2] * want[2];
    let (v1, v2) = if dot < 0.0 { (c, b) } else { (b, c) };
    out.extend_from_slice(&[a[0], a[1], a[2], v1[0], v1[1], v1[2], v2[0], v2[1], v2[2]]);
}

fn push_quad(out: &mut Vec<f64>, a: V3, b: V3, c: V3, d: V3, want: V3) {
    push_tri(out, a, b, c, want);
    push_tri(out, a, c, d, want);
}

fn by_value(a: &f64, b: &f64) -> std::cmp::Ordering {
    a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal)
}

/// Rechteck `[u_lo,u_hi] × [z_lo,z_hi]` MINUS `holes` als disjunkte Teilrechtecke
/// (Koordinaten-Kompression, `mesh.rs::solid_subrects`).
pub fn solid_subrects(u_lo: f64, u_hi: f64, z_lo: f64, z_hi: f64, holes: &[[f64; 4]]) -> Vec<[f64; 4]> {
    let sort_dedup = |mut v: Vec<f64>| -> Vec<f64> {
        v.sort_by(by_value);
        let mut out: Vec<f64> = Vec::with_capacity(v.len());
        for x in v {
            match out.last() {
                Some(&l) if !((x - l).abs() > MIN_SPAN) => {}
                _ => out.push(x),
            }
        }
        out
    };
    let mut us = vec![u_lo, u_hi];
    let mut zs = vec![z_lo, z_hi];
    for h in holes {
        us.extend([h[0], h[1]]);
        zs.extend([h[2], h[3]]);
    }
    let us = sort_dedup(us);
    let zs = sort_dedup(zs);
    let mut out = Vec::new();
    for i in 0..us.len().saturating_sub(1) {
        let (ua, ub) = (us[i], us[i + 1]);
        if ub - ua <= MIN_SPAN {
            continue;
        }
        for j in 0..zs.len().saturating_sub(1) {
            let (za, zb) = (zs[j], zs[j + 1]);
            if zb - za <= MIN_SPAN {
                continue;
            }
            let cu = (ua + ub) * 0.5;
            let cz = (za + zb) * 0.5;
            let in_hole = holes.iter().any(|h| cu > h[0] && cu < h[1] && cz > h[2] && cz < h[3]);
            if !in_hole {
                out.push([ua, ub, za, zb]);
            }
        }
    }
    out
}

/// `[lo, hi]` minus die (ggf. überlappenden) `gaps` (`mesh.rs::subtract_intervals`). Bewusst
/// nicht `wall_bands::subtract_spans`: andere Randregeln, das Ergebnis soll bitgleich bleiben.
fn subtract_intervals(lo: f64, hi: f64, gaps: &[[f64; 2]]) -> Vec<[f64; 2]> {
    let mut gs: Vec<[f64; 2]> = gaps.iter().map(|&[a, b]| [jmax(a, lo), jmin(b, hi)]).filter(|&[a, b]| b - a > MIN_SPAN).collect();
    gs.sort_by(|p, q| by_value(&p[0], &q[0]));
    let mut out = Vec::new();
    let mut cursor = lo;
    for [a, b] in gs {
        if a > cursor + MIN_SPAN {
            out.push([cursor, a]);
        }
        cursor = jmax(cursor, b);
    }
    if hi > cursor + MIN_SPAN {
        out.push([cursor, hi]);
    }
    out
}

/// Wand-Mesh eines Bandes mit echten Loch-Ausschnitten: Langseiten (Gitter minus Löcher), Deckel/
/// Boden und Stirnkappen minus randständiger Löcher, Laibungen je Loch. Liefert die Weltpunkte
/// (x, Höhe, y) je Dreieck; entartetes Band ⇒ leer.
pub fn wall_cut_mesh(w: &CutWall) -> Vec<f64> {
    let mut out = Vec::new();
    let [sx, sy] = w.start;
    let dx = w.end[0] - sx;
    let dy = w.end[1] - sy;
    let length = js_hypot(dx, dy);
    if length < 1e-9 || w.height <= 1e-9 || w.thickness <= 1e-9 {
        return out;
    }
    let ux = dx / length;
    let uy = dy / length;
    let n = left_normal(Vec2 { x: ux, y: uy });
    let y0 = w.base_elevation;
    let y1 = w.base_elevation + w.height;
    let off_a = w.thickness / 2.0;
    let off_b = -w.thickness / 2.0;
    // Planpunkt bei Achsen-Position `a` und Dicken-Versatz `o`, in die Welt (x, y, Planz).
    let at = |a: f64, o: f64, y: f64| -> V3 {
        let g = add(Vec2 { x: sx + ux * a, y: sy + uy * a }, scale(n, o));
        [g.x, y, g.y]
    };

    let hs: Vec<[f64; 4]> = w
        .holes
        .iter()
        .map(|h| [jmax(h[0], 0.0), jmin(h[1], length), jmax(h[2], y0), jmin(h[3], y1)])
        .filter(|h| h[1] - h[0] > MIN_SPAN && h[3] - h[2] > MIN_SPAN)
        .collect();

    // Langseiten (+n / −n).
    let np = [n.x, 0.0, n.y];
    let nn = [-n.x, 0.0, -n.y];
    for [ua, ub, za, zb] in solid_subrects(0.0, length, y0, y1, &hs) {
        push_quad(&mut out, at(ua, off_a, za), at(ub, off_a, za), at(ub, off_a, zb), at(ua, off_a, zb), np);
        push_quad(&mut out, at(ua, off_b, za), at(ub, off_b, za), at(ub, off_b, zb), at(ua, off_b, zb), nn);
    }

    // Deckel / Boden.
    let top_gaps: Vec<[f64; 2]> = hs.iter().filter(|h| h[3] >= y1 - MIN_SPAN).map(|h| [h[0], h[1]]).collect();
    for [ua, ub] in subtract_intervals(0.0, length, &top_gaps) {
        push_quad(&mut out, at(ua, off_a, y1), at(ub, off_a, y1), at(ub, off_b, y1), at(ua, off_b, y1), [0.0, 1.0, 0.0]);
    }
    let bot_gaps: Vec<[f64; 2]> = hs.iter().filter(|h| h[2] <= y0 + MIN_SPAN).map(|h| [h[0], h[1]]).collect();
    for [ua, ub] in subtract_intervals(0.0, length, &bot_gaps) {
        push_quad(&mut out, at(ua, off_a, y0), at(ub, off_a, y0), at(ub, off_b, y0), at(ua, off_b, y0), [0.0, -1.0, 0.0]);
    }

    // Stirnkappen.
    let start_normal = quad_normal(at(0.0, off_b, y0), at(0.0, off_a, y0), at(0.0, off_b, y1));
    let start_gaps: Vec<[f64; 2]> = hs.iter().filter(|h| h[0] <= MIN_SPAN).map(|h| [h[2], h[3]]).collect();
    for [za, zb] in subtract_intervals(y0, y1, &start_gaps) {
        push_quad(&mut out, at(0.0, off_b, za), at(0.0, off_a, za), at(0.0, off_a, zb), at(0.0, off_b, zb), start_normal);
    }
    let end_normal = quad_normal(at(length, off_a, y0), at(length, off_b, y0), at(length, off_a, y1));
    let end_gaps: Vec<[f64; 2]> = hs.iter().filter(|h| h[1] >= length - MIN_SPAN).map(|h| [h[2], h[3]]).collect();
    for [za, zb] in subtract_intervals(y0, y1, &end_gaps) {
        push_quad(&mut out, at(length, off_a, za), at(length, off_b, za), at(length, off_b, zb), at(length, off_a, zb), end_normal);
    }

    // Laibungen je Loch (nur die im Wand-Inneren liegenden Seiten).
    for &[a0, a1, zb, zt] in &hs {
        if a0 > MIN_SPAN {
            push_quad(&mut out, at(a0, off_a, zb), at(a0, off_b, zb), at(a0, off_b, zt), at(a0, off_a, zt), [ux, 0.0, uy]);
        }
        if a1 < length - MIN_SPAN {
            push_quad(&mut out, at(a1, off_a, zb), at(a1, off_b, zb), at(a1, off_b, zt), at(a1, off_a, zt), [-ux, 0.0, -uy]);
        }
        if zb > y0 + MIN_SPAN {
            push_quad(&mut out, at(a0, off_a, zb), at(a1, off_a, zb), at(a1, off_b, zb), at(a0, off_b, zb), [0.0, 1.0, 0.0]);
        }
        if zt < y1 - MIN_SPAN {
            push_quad(&mut out, at(a0, off_a, zt), at(a1, off_a, zt), at(a1, off_b, zt), at(a0, off_b, zt), [0.0, -1.0, 0.0]);
        }
    }
    out
}

/// Geschlossen und nach aussen gewunden? Gauss-Kriterium: Σ (v1−v0)×(v2−v0) = 0 (keine Lücke,
/// T-Stoss-robust) und signiertes Volumen > 0. Index ausserhalb ⇒ `false`.
pub fn is_watertight(positions: &[f64], indices: &[u32], eps: f64) -> bool {
    let p = positions;
    let (mut ax, mut ay, mut az, mut vol6) = (0.0, 0.0, 0.0, 0.0);
    for t in indices.chunks(3) {
        if t.len() < 3 {
            // TS liest dann `undefined` ⇒ NaN ⇒ nicht dicht.
            return false;
        }
        // In u64 rechnen: auf wasm32 liefe `u32 * 3` als usize sonst über.
        let (j0, j1, j2) = (t[0] as u64 * 3, t[1] as u64 * 3, t[2] as u64 * 3);
        if j0.max(j1).max(j2) + 2 >= p.len() as u64 {
            return false;
        }
        let (i0, i1, i2) = (j0 as usize, j1 as usize, j2 as usize);
        let e1 = sub3([p[i1], p[i1 + 1], p[i1 + 2]], [p[i0], p[i0 + 1], p[i0 + 2]]);
        let e2 = sub3([p[i2], p[i2 + 1], p[i2 + 2]], [p[i0], p[i0 + 1], p[i0 + 2]]);
        let c = cross(e1, e2);
        ax += c[0];
        ay += c[1];
        az += c[2];
        vol6 += p[i0] * c[0] + p[i0 + 1] * c[1] + p[i0 + 2] * c[2];
    }
    js_hypot3(ax, ay, az) < eps && vol6 > eps
}

// ── Flache Kodierung ─────────────────────────────────────────────────────────
//
// Eingabe: `[nBänder, (sx, sy, ex, ey, Dicke, UK, Höhe, nLöcher, (from, to, zb, zt)…)…]`.
// Ausgabe: `[nBänder, (nZahlen, x, Höhe, y, …)…]` — je Band die Weltpunkte, drei je Dreiecksecke.
// Kaputte Eingabe ⇒ `[0]`; ein Band mit NaN/∞ ⇒ leeres Mesh.

fn decode(buf: &[f64]) -> Option<Vec<CutWall>> {
    let mut r = Reader::new(buf);
    let n = r.count()?;
    let mut out = Vec::with_capacity(n.min(1 << 16));
    for _ in 0..n {
        let start = [r.num()?, r.num()?];
        let end = [r.num()?, r.num()?];
        let (thickness, base_elevation, height) = (r.num()?, r.num()?, r.num()?);
        let nh = r.count()?;
        let mut holes = Vec::with_capacity(nh.min(1024));
        for _ in 0..nh {
            holes.push([r.num()?, r.num()?, r.num()?, r.num()?]);
        }
        out.push(CutWall { start, end, thickness, base_elevation, height, holes });
    }
    Some(out)
}

fn finite(w: &CutWall) -> bool {
    [w.start[0], w.start[1], w.end[0], w.end[1], w.thickness, w.base_elevation, w.height].iter().all(|v| v.is_finite())
        && w.holes.iter().flatten().all(|v| v.is_finite())
}

/// Flache Bindung für viele Bänder auf einmal; nie ein Panic.
pub fn wall_cut_meshes_flat(buf: &[f64]) -> Vec<f64> {
    let Some(walls) = decode(buf) else { return vec![0.0] };
    let mut out = vec![walls.len() as f64];
    for w in &walls {
        let m = if finite(w) { wall_cut_mesh(w) } else { Vec::new() };
        out.push(m.len() as f64);
        out.extend_from_slice(&m);
    }
    out
}

/// Flache Bindung von [`solid_subrects`]: `holes` als `[from, to, zb, zt, …]`; Ausgabe ebenso.
pub fn solid_subrects_flat(u_lo: f64, u_hi: f64, z_lo: f64, z_hi: f64, holes: &[f64]) -> Vec<f64> {
    let hs: Vec<[f64; 4]> = holes.chunks_exact(4).map(|c| [c[0], c[1], c[2], c[3]]).collect();
    solid_subrects(u_lo, u_hi, z_lo, z_hi, &hs).into_iter().flatten().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn band(holes: Vec<[f64; 4]>) -> CutWall {
        CutWall { start: [0.0, 0.0], end: [5.0, 0.0], thickness: 0.4, base_elevation: 0.0, height: 2.6, holes }
    }

    fn tight(pos: &[f64]) -> bool {
        let idx: Vec<u32> = (0..(pos.len() / 3) as u32).collect();
        is_watertight(pos, &idx, 1e-6)
    }

    #[test]
    fn zerlegung_wie_render3d() {
        assert_eq!(solid_subrects(0.0, 5.0, 0.0, 2.6, &[]), vec![[0.0, 5.0, 0.0, 2.6]]);
        assert_eq!(solid_subrects(0.0, 5.0, 0.0, 2.6, &[[2.0, 3.0, 0.9, 2.4]]).len(), 8);
        assert_eq!(solid_subrects(0.0, 5.0, 0.0, 2.6, &[[2.0, 3.0, 0.0, 2.1]]).len(), 5);
        assert_eq!(subtract_intervals(0.0, 5.0, &[[1.0, 2.0], [1.5, 3.0]]), vec![[0.0, 1.0], [3.0, 5.0]]);
    }

    #[test]
    fn volle_box_ohne_loch() {
        let m = wall_cut_mesh(&band(vec![]));
        // 2 Langseiten + Deckel + Boden + 2 Kappen = 6 Quads = 12 Dreiecke.
        assert_eq!(m.len(), 12 * 9);
        assert!(tight(&m));
    }

    #[test]
    fn fenster_und_tuer_bleiben_dicht() {
        let fenster = wall_cut_mesh(&band(vec![[2.0, 3.0, 0.9, 2.1]]));
        // 8 Teilrechtecke × 2 Seiten + Deckel + Boden + 2 Kappen + 4 Laibungen = 24 Quads.
        assert_eq!(fenster.len(), 24 * 2 * 9);
        assert!(tight(&fenster));
        let tuer = wall_cut_mesh(&band(vec![[2.0, 3.0, 0.0, 2.1]]));
        assert!(tight(&tuer));
        // Loch am Wandende und über die ganze Höhe.
        let rand = wall_cut_mesh(&band(vec![[4.0, 6.0, 0.5, 2.0], [0.0, 1.0, -1.0, 9.0]]));
        assert!(tight(&rand));
    }

    #[test]
    fn dichtheit_erkennt_luecken_und_wicklung() {
        let m = wall_cut_mesh(&band(vec![]));
        assert!(!tight(&m[..m.len() - 9]));
        let mut flipped = m.clone();
        for t in flipped.chunks_mut(9) {
            let (a, b) = t.split_at_mut(6);
            a[3..6].swap_with_slice(&mut b[0..3]);
        }
        assert!(!tight(&flipped));
        assert!(!is_watertight(&m, &[0, 1, 99], 1e-6));
        assert!(!is_watertight(&m, &[0, 1], 1e-6));
        assert!(!is_watertight(&m, &[u32::MAX, 0, 1], 1e-6));
        assert!(!is_watertight(&[], &[], 1e-6));
    }

    #[test]
    fn hypot3_wie_js() {
        assert_eq!(js_hypot3(3.0, 4.0, 12.0), 13.0);
        assert_eq!(js_hypot3(0.0, 0.0, 0.0), 0.0);
        assert!(js_hypot3(f64::NAN, 1.0, 0.0).is_nan());
        assert_eq!(js_hypot3(f64::NAN, f64::INFINITY, 0.0), f64::INFINITY);
    }

    #[test]
    fn flach_viele_baender() {
        let buf = [2.0, 0.0, 0.0, 5.0, 0.0, 0.4, 0.0, 2.6, 0.0, 0.0, 0.0, 0.0, 0.0, 0.4, 0.0, 2.6, 1.0, 1.0, 2.0, 0.0, 2.0];
        let out = wall_cut_meshes_flat(&buf);
        assert_eq!(out[0], 2.0);
        assert_eq!(out[1], 108.0);
        assert_eq!(out[2 + 108], 0.0); // Nullwand ⇒ leer
        assert_eq!(solid_subrects_flat(0.0, 5.0, 0.0, 2.6, &[2.0, 3.0, 0.0, 2.1, 9.0]).len(), 5 * 4);
    }

    #[test]
    fn unsinn_ohne_panic() {
        assert_eq!(wall_cut_meshes_flat(&[]), vec![0.0]);
        assert_eq!(wall_cut_meshes_flat(&[f64::NAN]), vec![0.0]);
        assert_eq!(wall_cut_meshes_flat(&[1e300]), vec![0.0]);
        assert_eq!(wall_cut_meshes_flat(&[1.0, 0.0, 0.0, 5.0]), vec![0.0]);
        let out = wall_cut_meshes_flat(&[1.0, 0.0, 0.0, f64::NAN, 0.0, 0.4, 0.0, 2.6, 0.0]);
        assert_eq!(out, vec![1.0, 0.0]);
        // Löcher verkehrt herum, riesig, negativ.
        let w = band(vec![[3.0, 1.0, 2.0, 0.5], [-1e9, 1e9, -1e9, 1e9], [f64::NAN, 1.0, 0.0, 1.0]]);
        let _ = wall_cut_mesh(&w);
        let _ = solid_subrects(f64::NAN, 1.0, 0.0, f64::INFINITY, &[[f64::NAN; 4]]);
        let _ = solid_subrects_flat(0.0, 1.0, 0.0, 1.0, &[1.0, 2.0]);
    }
}
