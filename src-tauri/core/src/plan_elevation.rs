//! Ansichts-Geometrie ([K3c]): Verdeckungs-Clipping, Punkt-Verdeckung, Schlagschatten und
//! XOR-Umriss frontaler Flächengruppen (`toElevation.ts`: `clipSegmentVisible`, `isPointOccluded`,
//! `buildShadows`, `xorOutlineEdges`). Flächenaufbau, Stil, Painter-Ordnung und Pick-IDs bleiben in
//! TS. Rechenreihenfolge und Zahlsemantik wie dort.
//!
//! ## Verdecker (`occ`)
//! `[n, (tiefe, k, u0, v0 … u(k-1), v(k-1)) × n]`.
//!
//! ## Segmente
//! `clip_segments(occ, segs)` mit `segs = [m, (ax, ay, bx, by, tiefe) × m]` →
//! `[m, (c, (ax, ay, bx, by) × c) × m]` (sichtbare Teilstücke je Segment, c = 0 ganz verdeckt).
//!
//! ## Punkte
//! `occluded_points(occ, pts)` mit `pts = [m, (u, v, tiefe) × m]` → `[m, 0/1 × m]`.
//!
//! ## Schatten
//! `shadows(walls, slabs)`, je `[n, (tiefe, tiefeMin, k, u, v …) × n]` (Wände: tiefeMin ungenutzt) →
//! `[r, (tiefe, k, u, v …) × r]`.
//!
//! ## XOR-Umriss
//! `xor_outline(polys)` mit `[n, (k, u, v …) × n]` → `[e, (ax, ay, bx, by) × e]`.
//!
//! ## Flächen
//! `faces(frame, walls, slabs, roofs)`; `frame = [Px,Py,Pz, Nx,Ny,Nz, Ux,Uy,Uz]` (Welt, Y oben).
//! ```text
//! walls  [n, (sx, sz, ex, ez, dicke, hoehe, basis) × n]
//! slabs  [n, (zUnten, zOben, k, x, z …) × n]
//! roofs  [n, (nFl, nGiebel, (k, x, y, z …) × nFl, (k, x, y, z …) × nGiebel) × n]   Modell [x, y, Höhe]
//! → [m, (rolle 0 Wand|1 Decke|2 Dach, quelle, tiefe, tiefeMin, tiefeMax, nx, ny, nz, k, u, v …) × m]
//! ```
//! Reihenfolge: Wände, Decken, Dächer (je Quelle in Modellreihenfolge); nur sichtbare Flächen
//! (Rückseiten-Culling, Tiefe > 0).
//!
//! ## Öffnungen
//! `openings(frame, in)` mit `in = [n, Öffnung × n]`, Öffnung =
//! ```text
//! sx, sz, ex, ez, dicke, von, bis, zUnten, zOben,
//! istTuer, glasBlatt, glasAnteil (NaN = 1),
//! rahmenbreite, kaempferHoehe, sprossenZeilen (NaN = 1), sprossenSpalten (NaN = 1),
//! bankAn, typArt (0 fest, 1 dreh, 2 kipp, 3 drehkipp, 4 schiebe),
//! anschlag (Meter, 0 keiner), anschlagSeite (1 aussen | −1 innen; [94]),
//! nFluegel, (pfosten, pfostenBreite (NaN), autoBreite (0/1), breite (NaN), art (-1 = typArt), bandLinks) × nFluegel
//! ```
//! → `[n, (ok, tiefe, istTuer, 8 Ecken, Listen) × n]`; `ok` 0 = nicht sichtbar (sonst nichts mehr).
//! Listen in dieser Reihenfolge, je `[anzahl, Einträge]`: glas, tuerblatt (Vierecke à 8 Werte),
//! teilungen (Linien à 4), fluegel (Vierecke), bank (Vierecke), symbol (Linien).
//!
//! ## Eck-Verlängerung
//! `wall_extensions(in)` mit `in = [n, (geschoss, sx, sy, ex, ey, halbe dicke) × n]` →
//! `[n, (verlStart, verlEnde) × n]`: Wandenden bis zur Aussenfläche der dicksten anstossenden Wand
//! desselben Geschosses (`wallCornerExtensions`).

use crate::jsmath::{hypot, hypot2};
use crate::jsnum::{max, min, round};
use crate::ugrid::Grid1;
use std::collections::HashMap;

const OCC_MARGIN: f64 = 2e-3;
const EPS: f64 = 1e-6;
const MAX_SHADOW_DELTA: f64 = 1.2;
const SUN_U: f64 = 1.0;
const SUN_V: f64 = -1.0;

type P = (f64, f64);

struct Occ {
    poly: Vec<P>,
    bbox: [f64; 4], // uMin, uMax, vMin, vMax
    depth: f64,
}

fn bbox_of(pts: &[P]) -> [f64; 4] {
    let (mut u_min, mut u_max, mut v_min, mut v_max) = (f64::INFINITY, f64::NEG_INFINITY, f64::INFINITY, f64::NEG_INFINITY);
    for &(u, v) in pts {
        if u < u_min {
            u_min = u;
        }
        if u > u_max {
            u_max = u;
        }
        if v < v_min {
            v_min = v;
        }
        if v > v_max {
            v_max = v;
        }
    }
    [u_min, u_max, v_min, v_max]
}

/// Liest `[n, (kopf…, k, pts…) × n]`; `head` = Zahl der Kopfwerte je Eintrag. `None` bei Unsinn.
fn read_polys(f: &[f64], head: usize) -> Option<Vec<(Vec<f64>, Vec<P>)>> {
    if f.is_empty() || f.iter().any(|v| !v.is_finite()) || f[0] < 0.0 {
        return None;
    }
    let n = f[0] as usize;
    let mut i = 1;
    let mut out = Vec::with_capacity(n);
    for _ in 0..n {
        if i + head >= f.len() {
            return None;
        }
        let h = f[i..i + head].to_vec();
        let k = f[i + head];
        if k < 0.0 {
            return None;
        }
        let k = k as usize;
        i += head + 1;
        if i + 2 * k > f.len() {
            return None;
        }
        out.push((h, (0..k).map(|j| (f[i + 2 * j], f[i + 2 * j + 1])).collect()));
        i += 2 * k;
    }
    (i == f.len()).then_some(out)
}

fn read_occ(f: &[f64]) -> Option<Vec<Occ>> {
    Some(
        read_polys(f, 1)?
            .into_iter()
            .map(|(h, poly)| Occ { bbox: bbox_of(&poly), poly, depth: h[0] })
            .collect(),
    )
}

fn segment_inside_poly_interval(a: P, b: P, poly: &[P]) -> Option<(f64, f64)> {
    let n = poly.len();
    if n < 3 {
        return None;
    }
    let mut area = 0.0;
    for i in 0..n {
        let p = poly[i];
        let q = poly[(i + 1) % n];
        area += p.0 * q.1 - q.0 * p.1;
    }
    let sign = if area >= 0.0 { 1.0 } else { -1.0 };
    let dx = b.0 - a.0;
    let dy = b.1 - a.1;
    let (mut t0, mut t1) = (0.0, 1.0);
    for i in 0..n {
        let p = poly[i];
        let q = poly[(i + 1) % n];
        let ex = q.0 - p.0;
        let ey = q.1 - p.1;
        let c0 = sign * (ex * (a.1 - p.1) - ey * (a.0 - p.0));
        let cd = sign * (ex * dy - ey * dx);
        if cd.abs() < 1e-12 {
            if c0 < 0.0 {
                return None;
            }
        } else {
            let t_hit = -c0 / cd;
            if cd > 0.0 {
                t0 = max(t0, t_hit);
            } else {
                t1 = min(t1, t_hit);
            }
            if t0 > t1 {
                return None;
            }
        }
    }
    (t0 <= t1).then_some((t0, t1))
}

fn occ_grid(occ: &[Occ]) -> Grid1 {
    Grid1::new(&occ.iter().map(|o| (o.bbox[0], o.bbox[1])).collect::<Vec<_>>())
}

/// Verdecker je u-Zelle, nach Tiefe sortiert (nah zuerst), mit Rahmen im Eintrag: Linien prüfen nur
/// Verdecker vor sich, je einmal (in der ersten überdeckten Zelle der Abfrage), und hören auf, sobald
/// einer die Linie ganz deckt. Die Teilstücke hängen nicht von der Reihenfolge der Schnitte ab
/// (sortiert und vereinigt); ein ganzer Schnitt [0, 1] lässt nichts übrig.
struct OccCells {
    lo: f64,
    inv: f64,
    cells: Vec<Vec<(f64, [f64; 4], u32, u32)>>,
}

impl OccCells {
    fn new(occ: &[Occ]) -> OccCells {
        let (mut lo, mut hi) = (f64::INFINITY, f64::NEG_INFINITY);
        for o in occ {
            lo = lo.min(o.bbox[0]);
            hi = hi.max(o.bbox[1]);
        }
        let n = if hi > lo { ((occ.len() as f64).sqrt().ceil() as usize * 2).clamp(1, 1 << 14) } else { 1 };
        let mut g = OccCells { lo, inv: if n > 1 { n as f64 / (hi - lo) } else { 0.0 }, cells: vec![Vec::new(); n] };
        for (i, o) in occ.iter().enumerate() {
            let (a, c) = (g.cell(o.bbox[0]), g.cell(o.bbox[1]));
            for k in a..=c {
                g.cells[k].push((o.depth, o.bbox, a as u32, i as u32));
            }
        }
        for c in &mut g.cells {
            c.sort_by(|x, y| x.0.total_cmp(&y.0).then(x.3.cmp(&y.3)));
        }
        g
    }

    fn cell(&self, u: f64) -> usize {
        if self.inv == 0.0 {
            return 0;
        }
        let c = ((u - self.lo) * self.inv).floor();
        if c.is_nan() { 0 } else { c.clamp(0.0, (self.cells.len() - 1) as f64) as usize }
    }
}

fn clip_segment_visible(a: P, b: P, depth: f64, occ: &[Occ], grid: &OccCells) -> Vec<(P, P)> {
    let mut cuts: Vec<(f64, f64)> = Vec::new();
    let seg_min = (min(a.0, b.0), min(a.1, b.1));
    let seg_max = (max(a.0, b.0), max(a.1, b.1));
    let (c0, c1) = (grid.cell(seg_min.0), grid.cell(seg_max.0));
    for ci in c0..=c1 {
        for &(od, bb, first, oi) in &grid.cells[ci] {
            if od >= depth - OCC_MARGIN {
                break; // nach Tiefe sortiert: alle weiteren liegen nicht davor
            }
            if (first as usize).max(c0) != ci {
                continue; // in einer früheren Zelle dieser Abfrage schon geprüft
            }
            if bb[1] < seg_min.0 || bb[0] > seg_max.0 {
                continue;
            }
            if bb[3] < seg_min.1 || bb[2] > seg_max.1 {
                continue;
            }
            if let Some(iv) = segment_inside_poly_interval(a, b, &occ[oi as usize].poly) {
                if iv.1 - iv.0 > 1e-6 {
                    if iv.0 == 0.0 && iv.1 == 1.0 {
                        return Vec::new(); // ganz verdeckt
                    }
                    cuts.push(iv);
                }
            }
        }
    }
    if cuts.is_empty() {
        return vec![(a, b)];
    }
    cuts.sort_by(|x, y| x.0.partial_cmp(&y.0).unwrap_or(std::cmp::Ordering::Equal));
    let at = |t: f64| -> P { (a.0 + (b.0 - a.0) * t, a.1 + (b.1 - a.1) * t) };
    let mut out = Vec::new();
    let mut cursor = 0.0;
    for (s, e) in cuts {
        if s > cursor + 1e-6 {
            out.push((at(cursor), at(min(s, 1.0))));
        }
        cursor = max(cursor, e);
        if cursor >= 1.0 {
            break;
        }
    }
    if cursor < 1.0 - 1e-6 {
        out.push((at(cursor), at(1.0)));
    }
    out
}

pub fn clip_segments(occ: &[f64], segs: &[f64]) -> Vec<f64> {
    let Some(occ) = read_occ(occ) else { return Vec::new() };
    if segs.is_empty() || segs.iter().any(|v| !v.is_finite()) || segs[0] < 0.0 || segs.len() != 1 + 5 * segs[0] as usize {
        return Vec::new();
    }
    let m = segs[0] as usize;
    let mut f = vec![m as f64];
    let grid = OccCells::new(&occ);
    for k in 0..m {
        let s = &segs[1 + 5 * k..6 + 5 * k];
        let parts = clip_segment_visible((s[0], s[1]), (s[2], s[3]), s[4], &occ, &grid);
        f.push(parts.len() as f64);
        for (a, b) in parts {
            f.extend([a.0, a.1, b.0, b.1]);
        }
    }
    f
}

fn point_in_poly(pt: P, poly: &[P]) -> bool {
    let mut inside = false;
    let mut j = poly.len().wrapping_sub(1);
    for i in 0..poly.len() {
        let (xi, yi) = poly[i];
        let (xj, yj) = poly[j];
        if (yi > pt.1) != (yj > pt.1) && pt.0 < ((xj - xi) * (pt.1 - yi)) / (yj - yi) + xi {
            inside = !inside;
        }
        j = i;
    }
    inside
}

pub fn occluded_points(occ: &[f64], pts: &[f64]) -> Vec<f64> {
    let Some(occ) = read_occ(occ) else { return Vec::new() };
    if pts.is_empty() || pts.iter().any(|v| !v.is_finite()) || pts[0] < 0.0 || pts.len() != 1 + 3 * pts[0] as usize {
        return Vec::new();
    }
    let m = pts[0] as usize;
    let mut f = vec![m as f64];
    let grid = occ_grid(&occ);
    let mut cand = Vec::new();
    for k in 0..m {
        let (u, v, depth) = (pts[1 + 3 * k], pts[2 + 3 * k], pts[3 + 3 * k]);
        grid.query(u, u, &mut cand);
        let hit = cand.iter().map(|&i| &occ[i as usize]).any(|o| {
            o.depth < depth - OCC_MARGIN
                && !(u < o.bbox[0] || u > o.bbox[1] || v < o.bbox[2] || v > o.bbox[3])
                && point_in_poly((u, v), &o.poly)
        });
        f.push(if hit { 1.0 } else { 0.0 });
    }
    f
}

fn clip_polygon_to_rect(poly: &[P], r: [f64; 4]) -> Vec<P> {
    fn clip(input: &[P], inside: impl Fn(P) -> bool, intersect: impl Fn(P, P) -> P) -> Vec<P> {
        let mut out = Vec::new();
        for i in 0..input.len() {
            let a = input[i];
            let b = input[(i + 1) % input.len()];
            let (ain, bin) = (inside(a), inside(b));
            if ain {
                out.push(a);
            }
            if ain != bin {
                out.push(intersect(a, b));
            }
        }
        out
    }
    let lerp = |a: P, b: P, t: f64| -> P { (a.0 + (b.0 - a.0) * t, a.1 + (b.1 - a.1) * t) };
    let (u_min, u_max, v_min, v_max) = (r[0], r[1], r[2], r[3]);
    let mut p = poly.to_vec();
    p = clip(&p, |q| q.0 >= u_min, |a, b| lerp(a, b, (u_min - a.0) / (b.0 - a.0)));
    if p.len() < 3 {
        return Vec::new();
    }
    p = clip(&p, |q| q.0 <= u_max, |a, b| lerp(a, b, (u_max - a.0) / (b.0 - a.0)));
    if p.len() < 3 {
        return Vec::new();
    }
    p = clip(&p, |q| q.1 >= v_min, |a, b| lerp(a, b, (v_min - a.1) / (b.1 - a.1)));
    if p.len() < 3 {
        return Vec::new();
    }
    p = clip(&p, |q| q.1 <= v_max, |a, b| lerp(a, b, (v_max - a.1) / (b.1 - a.1)));
    if p.len() < 3 {
        return Vec::new();
    }
    p
}

pub fn shadows(walls: &[f64], slabs: &[f64]) -> Vec<f64> {
    let (Some(walls), Some(slabs)) = (read_polys(walls, 2), read_polys(slabs, 2)) else {
        return Vec::new();
    };
    let mut res: Vec<(f64, Vec<P>)> = Vec::new();
    let wboxes: Vec<[f64; 4]> = walls.iter().map(|(_, w)| bbox_of(w)).collect();
    let grid = Grid1::new(&wboxes.iter().map(|b| (b[0], b[1])).collect::<Vec<_>>());
    let mut cand = Vec::new();
    for (sh, spts) in &slabs {
        let so = bbox_of(spts);
        grid.query(so[0], so[1], &mut cand);
        for &wi in &cand {
            let (wh, _) = &walls[wi as usize];
            let wo = wboxes[wi as usize];
            let delta = wh[0] - sh[1];
            if delta <= EPS || delta > MAX_SHADOW_DELTA {
                continue;
            }
            if so[1] <= wo[0] + EPS || so[0] >= wo[1] - EPS {
                continue;
            }
            let v_top = so[2];
            let par = [
                (so[0], v_top),
                (so[1], v_top),
                (so[1] + delta * SUN_U, v_top + delta * SUN_V),
                (so[0] + delta * SUN_U, v_top + delta * SUN_V),
            ];
            let clipped = clip_polygon_to_rect(&par, wo);
            if clipped.len() >= 3 {
                res.push((wh[0], clipped));
            }
        }
    }
    let mut f = vec![res.len() as f64];
    for (d, pts) in res {
        f.push(d);
        f.push(pts.len() as f64);
        for p in pts {
            f.extend([p.0, p.1]);
        }
    }
    f
}

pub fn xor_outline(polys: &[f64]) -> Vec<f64> {
    let Some(polys) = read_polys(polys, 0) else { return Vec::new() };
    const EPS_AX: f64 = 1e-6;
    let key_of = |x: f64| round(x * 1e5);
    // Gruppen in Einfügereihenfolge (wie `Map`; -0 und 0 sind derselbe Schlüssel).
    let mut horiz: Vec<(f64, Vec<(f64, f64)>)> = Vec::new();
    let mut vert: Vec<(f64, Vec<(f64, f64)>)> = Vec::new();
    let mut hidx: HashMap<i64, usize> = HashMap::new();
    let mut vidx: HashMap<i64, usize> = HashMap::new();
    let mut out: Vec<(P, P)> = Vec::new();
    fn add(list: &mut Vec<(f64, Vec<(f64, f64)>)>, idx: &mut HashMap<i64, usize>, k: f64, iv: (f64, f64)) {
        let slot = *idx.entry(k as i64).or_insert_with(|| {
            list.push((k, Vec::new()));
            list.len() - 1
        });
        list[slot].1.push(iv);
    }
    for (_, poly) in &polys {
        for i in 0..poly.len() {
            let a = poly[i];
            let b = poly[(i + 1) % poly.len()];
            if (a.1 - b.1).abs() < EPS_AX {
                add(&mut horiz, &mut hidx, key_of(a.1), (min(a.0, b.0), max(a.0, b.0)));
            } else if (a.0 - b.0).abs() < EPS_AX {
                add(&mut vert, &mut vidx, key_of(a.0), (min(a.1, b.1), max(a.1, b.1)));
            } else {
                out.push((a, b));
            }
        }
    }
    let sweep = |m: &Vec<(f64, Vec<(f64, f64)>)>, emit: &mut dyn FnMut(f64, f64, f64)| {
        for (k, ivs) in m {
            let mut evs: Vec<(f64, i32)> = Vec::new();
            for &(s, e) in ivs {
                if e - s < 1e-9 {
                    continue;
                }
                evs.push((s, 1));
                evs.push((e, -1));
            }
            evs.sort_by(|p, q| {
                let d = p.0 - q.0;
                let c = if d != 0.0 { d } else { (q.1 - p.1) as f64 };
                c.partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal)
            });
            let mut count = 0i32;
            let mut start = 0.0;
            let coord = k / 1e5;
            for (x, d) in evs {
                let was_odd = count % 2 == 1;
                count += d;
                let is_odd = count % 2 == 1;
                if !was_odd && is_odd {
                    start = x;
                } else if was_odd && !is_odd && x - start > 1e-9 {
                    emit(coord, start, x);
                }
            }
        }
    };
    sweep(&horiz, &mut |v, s, e| out.push(((s, v), (e, v))));
    sweep(&vert, &mut |u, s, e| out.push(((u, s), (u, e))));
    let mut f = vec![out.len() as f64];
    for (a, b) in out {
        f.extend([a.0, a.1, b.0, b.1]);
    }
    f
}

// ── Flächen ────────────────────────────────────────────────────────────────

const FACING_EPS: f64 = 1e-4;
type V3 = [f64; 3];

struct Frame {
    p: V3,
    n: V3,
    u: V3,
}

struct Projected {
    role: u8,
    src: usize,
    depth: f64,
    depth_min: f64,
    depth_max: f64,
    normal: V3,
    pts: Vec<P>,
}

fn normalize3(a: V3) -> V3 {
    let l = hypot(&a);
    let l = if l == 0.0 || l.is_nan() { 1.0 } else { l };
    [a[0] / l, a[1] / l, a[2] / l]
}

fn neg(a: V3) -> V3 {
    [-a[0], -a[1], -a[2]]
}

fn project_point(f: &Frame, w: V3) -> (f64, f64, f64) {
    let rx = w[0] - f.p[0];
    let ry = w[1] - f.p[1];
    let rz = w[2] - f.p[2];
    (
        rx * f.u[0] + ry * f.u[1] + rz * f.u[2],
        w[1],
        rx * f.n[0] + ry * f.n[1] + rz * f.n[2],
    )
}

fn project_face(f: &Frame, poly: &[V3], normal: V3, role: u8, src: usize) -> Option<Projected> {
    let facing = f.n[0] * normal[0] + f.n[1] * normal[1] + f.n[2] * normal[2];
    if facing >= -FACING_EPS {
        return None;
    }
    let mut pts = Vec::with_capacity(poly.len());
    let (mut sum, mut dmin, mut dmax) = (0.0, f64::INFINITY, f64::NEG_INFINITY);
    for &w in poly {
        let (u, v, d) = project_point(f, w);
        pts.push((u, v));
        sum += d;
        dmin = min(dmin, d);
        dmax = max(dmax, d);
    }
    let depth = sum / poly.len() as f64;
    if depth <= EPS {
        return None;
    }
    Some(Projected { role, src, depth, depth_min: dmin, depth_max: dmax, normal, pts })
}

fn wall_faces(f: &Frame, w: &[f64], src: usize, out: &mut Vec<Projected>) {
    let (sx, sz, ex, ez) = (w[0], w[1], w[2], w[3]);
    let ax = ex - sx;
    let az = ez - sz;
    let len = hypot2(ax, az);
    if len < 1e-9 || w[5] <= EPS {
        return;
    }
    let a_hat: V3 = [ax / len, 0.0, az / len];
    let n_hat: V3 = [az / len, 0.0, -ax / len];
    let ht = w[4] / 2.0;
    let zb = w[6];
    let zt = w[6] + w[5];
    let corner = |s_along: f64, t_off: f64, y: f64| -> V3 {
        [sx + a_hat[0] * s_along + n_hat[0] * t_off, y, sz + a_hat[2] * s_along + n_hat[2] * t_off]
    };
    let faces: [(V3, [V3; 4]); 6] = [
        (n_hat, [corner(0.0, ht, zb), corner(len, ht, zb), corner(len, ht, zt), corner(0.0, ht, zt)]),
        (neg(n_hat), [corner(0.0, -ht, zb), corner(0.0, -ht, zt), corner(len, -ht, zt), corner(len, -ht, zb)]),
        (neg(a_hat), [corner(0.0, -ht, zb), corner(0.0, ht, zb), corner(0.0, ht, zt), corner(0.0, -ht, zt)]),
        (a_hat, [corner(len, -ht, zb), corner(len, -ht, zt), corner(len, ht, zt), corner(len, ht, zb)]),
        ([0.0, 1.0, 0.0], [corner(0.0, -ht, zt), corner(0.0, ht, zt), corner(len, ht, zt), corner(len, -ht, zt)]),
        ([0.0, -1.0, 0.0], [corner(0.0, -ht, zb), corner(len, -ht, zb), corner(len, ht, zb), corner(0.0, ht, zb)]),
    ];
    for (normal, poly) in faces {
        if let Some(p) = project_face(f, &poly, normal, 0, src) {
            out.push(p);
        }
    }
}

fn slab_faces(f: &Frame, z_bottom: f64, z_top: f64, outline: &[P], src: usize, out: &mut Vec<Projected>) {
    let n = outline.len();
    if n < 3 || z_top - z_bottom <= EPS {
        return;
    }
    let (mut cx, mut cz) = (0.0, 0.0);
    for p in outline {
        cx += p.0;
        cz += p.1;
    }
    cx /= n as f64;
    cz /= n as f64;
    let bottom: Vec<V3> = outline.iter().map(|p| [p.0, z_bottom, p.1]).collect();
    let top: Vec<V3> = outline.iter().map(|p| [p.0, z_top, p.1]).collect();
    let mut push = |poly: &[V3], normal: V3| {
        if let Some(p) = project_face(f, poly, normal, 1, src) {
            out.push(p);
        }
    };
    push(&top, [0.0, 1.0, 0.0]);
    let rev: Vec<V3> = bottom.iter().rev().copied().collect();
    push(&rev, [0.0, -1.0, 0.0]);
    for i in 0..n {
        let j = (i + 1) % n;
        let ex = outline[j].0 - outline[i].0;
        let ez = outline[j].1 - outline[i].1;
        let mut m = normalize3([ez, 0.0, -ex]);
        let mid_x = (outline[i].0 + outline[j].0) / 2.0;
        let mid_z = (outline[i].1 + outline[j].1) / 2.0;
        if m[0] * (mid_x - cx) + m[2] * (mid_z - cz) < 0.0 {
            m = neg(m);
        }
        push(&[bottom[i], bottom[j], top[j], top[i]], m);
    }
}

fn newell(poly: &[V3]) -> V3 {
    let (mut nx, mut ny, mut nz) = (0.0, 0.0, 0.0);
    for i in 0..poly.len() {
        let a = poly[i];
        let b = poly[(i + 1) % poly.len()];
        nx += (a[1] - b[1]) * (a[2] + b[2]);
        ny += (a[2] - b[2]) * (a[0] + b[0]);
        nz += (a[0] - b[0]) * (a[1] + b[1]);
    }
    normalize3([nx, ny, nz])
}

/// Liest `k, (x, y, z) × k` ab `i`; Modell [x, y, Höhe] → Welt [x, Höhe, y].
fn read_world_poly(f: &[f64], i: &mut usize) -> Option<Vec<V3>> {
    let k = *f.get(*i)?;
    if k < 0.0 || k.fract() != 0.0 {
        return None;
    }
    let k = k as usize;
    *i += 1;
    if *i + 3 * k > f.len() {
        return None;
    }
    let poly = (0..k).map(|j| [f[*i + 3 * j], f[*i + 3 * j + 2], f[*i + 3 * j + 1]]).collect();
    *i += 3 * k;
    Some(poly)
}

fn roof_faces(f: &Frame, planes: &[Vec<V3>], gables: &[Vec<V3>], src: usize, out: &mut Vec<Projected>) {
    let (mut cx, mut cy, mut cz, mut cn) = (0.0, 0.0, 0.0, 0usize);
    for pl in planes {
        for p in pl {
            // Welt [x, Höhe, y] → Modell-Reihenfolge der TS-Summen: p[0], p[2], p[1].
            cx += p[0];
            cy += p[1];
            cz += p[2];
            cn += 1;
        }
    }
    if cn == 0 {
        return;
    }
    let cnf = cn as f64;
    cx /= cnf;
    cy /= cnf;
    cz /= cnf;
    for poly in planes {
        let mut n = newell(poly);
        if n[1] < 0.0 {
            n = neg(n);
        }
        if let Some(p) = project_face(f, poly, n, 2, src) {
            out.push(p);
        }
    }
    for poly in gables {
        if poly.len() < 3 {
            continue;
        }
        let mut n = newell(poly);
        let to_c = [cx - poly[0][0], cy - poly[0][1], cz - poly[0][2]];
        if n[0] * to_c[0] + n[1] * to_c[1] + n[2] * to_c[2] > 0.0 {
            n = neg(n);
        }
        if let Some(p) = project_face(f, poly, n, 2, src) {
            out.push(p);
        }
    }
}

fn counted(f: &[f64]) -> Option<usize> {
    let n = *f.first()?;
    (n >= 0.0 && n.fract() == 0.0 && f.iter().all(|v| v.is_finite())).then_some(n as usize)
}

pub fn faces(frame: &[f64], walls: &[f64], slabs: &[f64], roofs: &[f64]) -> Vec<f64> {
    if frame.len() != 9 || frame.iter().any(|v| !v.is_finite()) {
        return Vec::new();
    }
    let fr = Frame {
        p: [frame[0], frame[1], frame[2]],
        n: [frame[3], frame[4], frame[5]],
        u: [frame[6], frame[7], frame[8]],
    };
    let (Some(nw), Some(ns), Some(nr)) = (counted(walls), counted(slabs), counted(roofs)) else {
        return Vec::new();
    };
    if walls.len() != 1 + 7 * nw {
        return Vec::new();
    }
    let mut out: Vec<Projected> = Vec::new();
    for k in 0..nw {
        wall_faces(&fr, &walls[1 + 7 * k..8 + 7 * k], k, &mut out);
    }
    let mut i = 1;
    for k in 0..ns {
        let Some(&kk) = slabs.get(i + 2) else { return Vec::new() };
        if kk < 0.0 || kk.fract() != 0.0 || i + 3 + 2 * kk as usize > slabs.len() {
            return Vec::new();
        }
        let kk = kk as usize;
        let outline: Vec<P> = (0..kk).map(|j| (slabs[i + 3 + 2 * j], slabs[i + 4 + 2 * j])).collect();
        slab_faces(&fr, slabs[i], slabs[i + 1], &outline, k, &mut out);
        i += 3 + 2 * kk;
    }
    if i != slabs.len() {
        return Vec::new();
    }
    let mut i = 1;
    for k in 0..nr {
        let (Some(&nf), Some(&ng)) = (roofs.get(i), roofs.get(i + 1)) else { return Vec::new() };
        if nf < 0.0 || ng < 0.0 || nf.fract() != 0.0 || ng.fract() != 0.0 {
            return Vec::new();
        }
        i += 2;
        let mut planes = Vec::new();
        for _ in 0..nf as usize {
            let Some(p) = read_world_poly(roofs, &mut i) else { return Vec::new() };
            planes.push(p);
        }
        let mut gables = Vec::new();
        for _ in 0..ng as usize {
            let Some(p) = read_world_poly(roofs, &mut i) else { return Vec::new() };
            gables.push(p);
        }
        roof_faces(&fr, &planes, &gables, k, &mut out);
    }
    if i != roofs.len() {
        return Vec::new();
    }
    let mut f = vec![out.len() as f64];
    for p in &out {
        f.extend([
            p.role as f64, p.src as f64, p.depth, p.depth_min, p.depth_max,
            p.normal[0], p.normal[1], p.normal[2], p.pts.len() as f64,
        ]);
        for q in &p.pts {
            f.extend([q.0, q.1]);
        }
    }
    f
}

// ── Eck-Verlängerung ───────────────────────────────────────────────────────

fn body_contains(w: &[f64], half: f64, p: P) -> bool {
    let dx = w[3] - w[1];
    let dy = w[4] - w[2];
    let len = hypot2(dx, dy);
    if len < 1e-9 {
        return false;
    }
    let ux = dx / len;
    let uy = dy / len;
    let rx = p.0 - w[1];
    let ry = p.1 - w[2];
    let along = rx * ux + ry * uy;
    let perp = (-uy * rx + ux * ry).abs();
    along >= -1e-6 && along <= len + 1e-6 && perp <= half + 1e-6
}

pub fn wall_extensions(inp: &[f64]) -> Vec<f64> {
    let Some(n) = counted(inp) else { return Vec::new() };
    if inp.len() != 1 + 6 * n {
        return Vec::new();
    }
    let w = |k: usize| &inp[1 + 6 * k..7 + 6 * k];
    let mut f = vec![n as f64];
    // Ausdehnung in x je Wand (Achse ± halbe Dicke, mit Rand für die Toleranzen von `body_contains`).
    let xr: Vec<(f64, f64)> = (0..n)
        .map(|k| {
            let q = w(k);
            let r = q[5].abs() + 1e-3;
            (q[1].min(q[3]) - r, q[1].max(q[3]) + r)
        })
        .collect();
    let grid = Grid1::new(&xr);
    let mut cand = Vec::new();
    for k in 0..n {
        let me = w(k);
        let mut ext_at = |p: P| -> f64 {
            let mut max_other = 0.0;
            grid.query(p.0, p.0, &mut cand);
            for &o in cand.iter() {
                let o = o as usize;
                let other = w(o);
                if o == k || other[0] != me[0] {
                    continue;
                }
                if body_contains(other, other[5], p) {
                    max_other = max(max_other, other[5]);
                }
            }
            max_other
        };
        f.push(ext_at((me[1], me[2])));
        f.push(ext_at((me[3], me[4])));
    }
    f
}

// ── Öffnungen ──────────────────────────────────────────────────────────────

type Quad = [P; 4];
type Line = (P, P);

#[derive(Default)]
struct OpeningOut {
    glass: Vec<Quad>,
    door_leaf: Vec<Quad>,
    divisions: Vec<Line>,
    sash_rects: Vec<Quad>,
    sill: Vec<Quad>,
    symbol: Vec<Line>,
}

fn lerp(a: P, b: P, t: f64) -> P {
    (a.0 + (b.0 - a.0) * t, a.1 + (b.1 - a.1) * t)
}

fn quad_at(q: &Quad, fa: f64, fz: f64) -> P {
    lerp(lerp(q[0], q[1], fa), lerp(q[3], q[2], fa), fz)
}

fn rect(q: &Quad, fa0: f64, fa1: f64, fz0: f64, fz1: f64) -> Quad {
    [quad_at(q, fa0, fz0), quad_at(q, fa1, fz0), quad_at(q, fa1, fz1), quad_at(q, fa0, fz1)]
}

/// Feste Werte je Öffnung vor der Flügelliste (der letzte = Flügelzahl).
const REC: usize = 21;

/// Projiziert die zum Betrachter zeigende Wand-Langseite der Öffnung; `None` ohne sichtbare Seite.
fn project_opening_rect(f: &Frame, o: &[f64]) -> Option<(Quad, f64)> {
    project_opening_side(f, o).map(|(q, d, _)| (q, d))
}

/// Wie [`project_opening_rect`], dazu die Seite (+1 = Seite +n, die Aussenseite; −1 = innen).
fn project_opening_side(f: &Frame, o: &[f64]) -> Option<(Quad, f64, f64)> {
    let (sx, sz) = (o[0], o[1]);
    let ax = o[2] - o[0];
    let az = o[3] - o[1];
    let len = hypot2(ax, az);
    let (from, to, z_bottom, z_top) = (o[5], o[6], o[7], o[8]);
    if len < 1e-9 || to - from <= EPS || z_top - z_bottom <= EPS {
        return None;
    }
    let a_hat: V3 = [ax / len, 0.0, az / len];
    let n_hat: V3 = [az / len, 0.0, -ax / len];
    let ht = o[4] / 2.0;
    for side in [ht, -ht] {
        let normal = if side > 0.0 { n_hat } else { neg(n_hat) };
        let facing = f.n[0] * normal[0] + f.n[1] * normal[1] + f.n[2] * normal[2];
        if facing >= -FACING_EPS {
            continue;
        }
        let corner = |s_along: f64, y: f64| -> V3 {
            [sx + a_hat[0] * s_along + n_hat[0] * side, y, sz + a_hat[2] * s_along + n_hat[2] * side]
        };
        let world = [corner(from, z_bottom), corner(to, z_bottom), corner(to, z_top), corner(from, z_top)];
        let mut pts = [(0.0, 0.0); 4];
        let mut depth_sum = 0.0;
        for (k, w) in world.iter().enumerate() {
            let (u, v, d) = project_point(f, *w);
            pts[k] = (u, v);
            depth_sum += d;
        }
        let depth = depth_sum / 4.0;
        if depth <= EPS {
            continue;
        }
        return Some((pts, depth, if side > 0.0 { 1.0 } else { -1.0 }));
    }
    None
}

fn layout_opening(o: &[f64], sashes: &[f64], pts: &Quad) -> OpeningOut {
    let mut out = OpeningOut::default();
    let (from, to, z_bottom, z_top) = (o[5], o[6], o[7], o[8]);
    let w = to - from;
    let h = z_top - z_bottom;
    if o[9] != 0.0 {
        // Tür: Blatt-Fläche, bei Glasblatt mit Teilverglasung (Kämpferhöhe von OBEN).
        if o[10] != 0.0 {
            let ratio = max(0.05, min(1.0, if o[11].is_nan() { 1.0 } else { o[11] }));
            if ratio >= 1.0 - EPS {
                out.glass.push(rect(pts, 0.04, 0.96, 0.0, 0.97));
            } else {
                let split_z = 0.97 * (1.0 - ratio);
                out.glass.push(rect(pts, 0.04, 0.96, split_z, 0.97));
                out.door_leaf.push(rect(pts, 0.04, 0.96, 0.0, split_z));
                out.divisions.push((quad_at(pts, 0.04, split_z), quad_at(pts, 0.96, split_z)));
            }
        } else {
            out.door_leaf.push(rect(pts, 0.04, 0.96, 0.0, 0.97));
        }
        return out;
    }
    let fw = o[12];
    let fa = min(0.45, fw / max(w, 1e-6));
    let fz = min(0.45, fw / max(h, 1e-6));
    let transom = max(0.0, o[13]);
    let f_tr = if transom > EPS && transom < h - fw { 1.0 - transom / h } else { 0.0 };
    let field_top = if f_tr > 0.0 { f_tr - fz / 2.0 } else { 1.0 - fz };
    let inner_w = max(1e-6, w * (1.0 - 2.0 * fa));
    let n_sashes = sashes.len() / 6;
    let sash = |k: usize| &sashes[6 * k..6 * k + 6];
    let (mut fixed_sum, mut auto_count) = (0.0, 0usize);
    for k in 0..n_sashes {
        let sd = sash(k);
        if sd[0] != 0.0 {
            fixed_sum += max(0.0, if sd[1].is_nan() { 0.06 } else { sd[1] });
        } else if sd[2] == 0.0 {
            fixed_sum += max(0.0, if sd[3].is_nan() { 0.0 } else { sd[3] });
        } else {
            auto_count += 1;
        }
    }
    let auto_w = if auto_count > 0 { max(0.02, (inner_w - fixed_sum) / auto_count as f64) } else { 0.0 };
    let mut cursor = fa;
    for k in 0..n_sashes {
        let sd = sash(k);
        let sw = if sd[0] != 0.0 {
            max(0.0, if sd[1].is_nan() { 0.06 } else { sd[1] })
        } else if sd[2] == 0.0 {
            max(0.0, if sd[3].is_nan() { auto_w } else { sd[3] })
        } else {
            auto_w
        };
        let fa0 = cursor;
        let fa1 = cursor + sw / w;
        cursor = fa1;
        if sd[0] != 0.0 {
            let fm = (fa0 + fa1) / 2.0;
            out.divisions.push((quad_at(pts, fm, fz), quad_at(pts, fm, field_top)));
            continue;
        }
        out.sash_rects.push(rect(pts, fa0, fa1, fz, field_top));
        let spw = min(0.06, max(0.03, fw));
        let g_u = spw / max(w, 1e-6);
        let g_v = spw / max(h, 1e-6);
        let g_a = fa0 + g_u;
        let g_b = fa1 - g_u;
        let gz0 = fz + g_v;
        let gz1 = field_top - g_v;
        let rows = max(1.0, round(if o[14].is_nan() { 1.0 } else { o[14] })) as usize;
        let cols = max(1.0, round(if o[15].is_nan() { 1.0 } else { o[15] })) as usize;
        if g_b - g_a > 1e-6 && gz1 - gz0 > 1e-6 {
            for r in 0..rows {
                let rf = r as f64;
                let rows_f = rows as f64;
                let rz0 = gz0 + ((gz1 - gz0) * rf) / rows_f + if r > 0 { g_v / 2.0 } else { 0.0 };
                let rz1 = gz0 + ((gz1 - gz0) * (rf + 1.0)) / rows_f - if r < rows - 1 { g_v / 2.0 } else { 0.0 };
                if rz1 - rz0 <= 1e-6 {
                    continue;
                }
                for c in 0..cols {
                    let cf = c as f64;
                    let cols_f = cols as f64;
                    let ca0 = g_a + ((g_b - g_a) * cf) / cols_f + if c > 0 { g_u / 2.0 } else { 0.0 };
                    let ca1 = g_a + ((g_b - g_a) * (cf + 1.0)) / cols_f - if c < cols - 1 { g_u / 2.0 } else { 0.0 };
                    if ca1 - ca0 > 1e-6 {
                        out.glass.push(rect(pts, ca0, ca1, rz0, rz1));
                    }
                }
            }
            for r in 1..rows {
                let rz = gz0 + ((gz1 - gz0) * r as f64) / rows as f64;
                out.divisions.push((quad_at(pts, g_a, rz), quad_at(pts, g_b, rz)));
            }
            for c in 1..cols {
                let ca = g_a + ((g_b - g_a) * c as f64) / cols as f64;
                out.divisions.push((quad_at(pts, ca, gz0), quad_at(pts, ca, gz1)));
            }
        }
        if fa1 < 1.0 - fa - 1e-6 {
            out.divisions.push((quad_at(pts, fa1, fz), quad_at(pts, fa1, field_top)));
        }
        let kind = if sd[4] >= 0.0 { sd[4] as i64 } else { o[17] as i64 };
        let hinge_left = sd[5] != 0.0;
        if kind == 1 || kind == 3 {
            let apex = quad_at(pts, if hinge_left { g_a } else { g_b }, (gz0 + gz1) / 2.0);
            let far_u = if hinge_left { g_b } else { g_a };
            out.symbol.push((quad_at(pts, far_u, gz0), apex));
            out.symbol.push((quad_at(pts, far_u, gz1), apex));
        }
        if kind == 2 || kind == 3 {
            let apex = quad_at(pts, (g_a + g_b) / 2.0, gz1);
            out.symbol.push((quad_at(pts, g_a, gz0), apex));
            out.symbol.push((quad_at(pts, g_b, gz0), apex));
        }
        if kind == 4 {
            let zc = (gz0 + gz1) / 2.0;
            let to_right = hinge_left;
            let tail = if to_right { g_a } else { g_b };
            let head = if to_right { g_b } else { g_a };
            let barb = (head - tail) * 0.22;
            let head_pt = quad_at(pts, head, zc);
            out.symbol.push((quad_at(pts, tail, zc), head_pt));
            out.symbol.push((quad_at(pts, head - barb, gz0 + (gz1 - gz0) * 0.32), head_pt));
            out.symbol.push((quad_at(pts, head - barb, gz0 + (gz1 - gz0) * 0.68), head_pt));
        }
    }
    if o[16] != 0.0 {
        let ov1 = 0.02 / max(w, 1e-6);
        let ov2 = 0.05 / max(w, 1e-6);
        let h1 = 0.035 / max(h, 1e-6);
        let h2 = 0.025 / max(h, 1e-6);
        out.sill.push(rect(pts, -ov1, 1.0 + ov1, -h1, 0.0));
        out.sill.push(rect(pts, -ov2, 1.0 + ov2, -(h1 + h2), -h1));
    }
    if f_tr > 0.0 {
        out.glass.push(rect(pts, fa, 1.0 - fa, f_tr + fz / 2.0, 1.0 - fz));
        out.divisions.push((quad_at(pts, 0.0, f_tr), quad_at(pts, 1.0, f_tr)));
    }
    out
}

fn push_quads(f: &mut Vec<f64>, list: &[Quad]) {
    f.push(list.len() as f64);
    for q in list {
        for p in q {
            f.extend([p.0, p.1]);
        }
    }
}

fn push_lines(f: &mut Vec<f64>, list: &[Line]) {
    f.push(list.len() as f64);
    for (a, b) in list {
        f.extend([a.0, a.1, b.0, b.1]);
    }
}

pub fn openings(frame: &[f64], inp: &[f64]) -> Vec<f64> {
    if frame.len() != 9 || frame.iter().any(|v| !v.is_finite()) {
        return Vec::new();
    }
    let fr = Frame {
        p: [frame[0], frame[1], frame[2]],
        n: [frame[3], frame[4], frame[5]],
        u: [frame[6], frame[7], frame[8]],
    };
    // Werte dürfen NaN tragen (= „fehlt"); sonst nur endliche.
    let Some(n) = inp.first().copied().filter(|n| *n >= 0.0 && n.fract() == 0.0).map(|n| n as usize) else {
        return Vec::new();
    };
    let mut f = vec![n as f64];
    let mut i = 1;
    for _ in 0..n {
        if i + REC > inp.len() {
            return Vec::new();
        }
        let o = &inp[i..i + REC];
        let ns = o[REC - 1];
        if !(ns >= 0.0) || ns.fract() != 0.0 || i + REC + 6 * ns as usize > inp.len() {
            return Vec::new();
        }
        let ns = ns as usize;
        let sashes = &inp[i + REC..i + REC + 6 * ns];
        i += REC + 6 * ns;
        let geo = &o[..9];
        if geo.iter().any(|v| !v.is_finite()) {
            return Vec::new();
        }
        // Anschlag ([94]): von der Anschlag-Seite aus deckt die Wandnase Rahmen links, rechts und oben ab.
        let mut oo = o.to_vec();
        if let Some((_, _, side)) = project_opening_side(&fr, o) {
            let rd = min(if o[18].is_nan() { 0.0 } else { o[18] }, (o[6] - o[5]) / 2.0 - 0.01);
            if rd > 1e-4 && side * o[19] > 0.0 && o[8] - o[7] > 2.0 * rd {
                oo[5] += rd;
                oo[6] -= rd;
                oo[8] -= rd;
            }
        }
        let o = &oo[..];
        match project_opening_rect(&fr, o) {
            None => f.push(0.0),
            Some((pts, depth)) => {
                f.extend([1.0, depth, o[9]]);
                for p in &pts {
                    f.extend([p.0, p.1]);
                }
                let out = layout_opening(o, sashes, &pts);
                push_quads(&mut f, &out.glass);
                push_quads(&mut f, &out.door_leaf);
                push_lines(&mut f, &out.divisions);
                push_quads(&mut f, &out.sash_rects);
                push_quads(&mut f, &out.sill);
                push_lines(&mut f, &out.symbol);
            }
        }
    }
    if i != inp.len() {
        return Vec::new();
    }
    f
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verdecktes_segment_wird_zerschnitten() {
        // Verdecker [1,2]×[-1,1] vor einer Linie bei v=0 von u=0..3.
        let occ = [1.0, 0.0, 4.0, 1.0, -1.0, 2.0, -1.0, 2.0, 1.0, 1.0, 1.0];
        let f = clip_segments(&occ, &[1.0, 0.0, 0.0, 3.0, 0.0, 1.0]);
        assert_eq!(f, vec![1.0, 2.0, 0.0, 0.0, 1.0, 0.0, 2.0, 0.0, 3.0, 0.0]);
        // Tiefer als die Linie: kein Effekt.
        let f = clip_segments(&occ, &[1.0, 0.0, 0.0, 3.0, 0.0, -1.0]);
        assert_eq!(f, vec![1.0, 1.0, 0.0, 0.0, 3.0, 0.0]);
    }

    #[test]
    fn xor_hebt_innenkante_auf() {
        let sq = |x0: f64, x1: f64| [4.0, x0, 0.0, x1, 0.0, x1, 1.0, x0, 1.0];
        let mut inp = vec![2.0];
        inp.extend(sq(0.0, 1.0));
        inp.extend(sq(1.0, 2.0));
        let f = xor_outline(&inp);
        // Oben/unten je 2 Teilstücke (an der Naht nicht verschmolzen) + 2 senkrechte Aussenkanten;
        // die Innenkante bei u=1 hebt sich auf.
        assert_eq!(f[0], 6.0);
    }

    #[test]
    fn wand_sichtbar_nur_aus_der_sueden() {
        // Betrachter bei z = -2, Blick +z; Wand 4 m lang bei z = 0, 3 m hoch.
        let frame = [-1.0, 0.0, -2.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0];
        let walls = [1.0, 0.0, 0.0, 4.0, 0.0, 0.2, 3.0, 0.0];
        let f = faces(&frame, &walls, &[0.0], &[0.0]);
        assert_eq!(f[0], 1.0);
        assert_eq!((f[1], f[2]), (0.0, 0.0)); // Rolle Wand, Quelle 0
        assert!((f[3] - 1.9).abs() < 1e-9); // Südseite bei z = -0.1
        // hinter dem Betrachter: nichts
        let walls = [1.0, 0.0, -5.0, 4.0, -5.0, 0.2, 3.0, 0.0];
        assert_eq!(faces(&frame, &walls, &[0.0], &[0.0]), vec![0.0]);
    }

    #[test]
    fn t_stoss_verlaengert_das_ende() {
        // Wand 0 endet an der Seite von Wand 1 (Dicke 0.4): Verlängerung = halbe Dicke 0.2.
        let f = wall_extensions(&[
            2.0, //
            0.0, 0.0, 0.0, 3.0, 0.0, 0.1, // Wand 0 endet bei (3, 0)
            0.0, 3.0, -2.0, 3.0, 2.0, 0.2, // Wand 1 läuft durch (3, 0)
        ]);
        assert_eq!(f, vec![2.0, 0.0, 0.2, 0.0, 0.0]);
    }

    #[test]
    fn unsinn_ist_leer() {
        assert!(clip_segments(&[f64::NAN], &[0.0]).is_empty());
        assert!(shadows(&[1.0], &[0.0]).is_empty());
        assert!(xor_outline(&[1.0, 5.0, 0.0]).is_empty());
    }
}

#[cfg(test)]
mod tests_ts {
    use super::*;

    // Früher `toElevation.test.ts` (buildShadows): Überstand vor der Fassade wirft Schatten.
    #[test]
    fn ueberstand_wirft_schatten_nur_bei_ueberlapp() {
        // Wandfläche u 1..5, v 0..3, Tiefe 1.9; Überstand näher (Tiefe 1.4, depthMin 1.4), unten v 2.8.
        let wall = [1.0, 1.9, 1.9, 4.0, 1.0, 0.0, 5.0, 0.0, 5.0, 3.0, 1.0, 3.0];
        let slab = |u0: f64, u1: f64| vec![1.0, 1.4, 1.4, 4.0, u0, 2.8, u1, 2.8, u1, 3.0, u0, 3.0];
        let f = shadows(&wall, &slab(1.0, 5.0));
        assert_eq!(f[0], 1.0);
        assert_eq!(f[1], 1.9);
        assert_eq!(shadows(&wall, &slab(20.0, 24.0)), vec![0.0]);
    }

    #[test]
    fn verdeckte_punkte_ueber_das_raster_wie_ohne() {
        // Viele Verdecker nebeneinander; Punkt in einem davon und vor/hinter.
        let mut occ = vec![50.0];
        for k in 0..50 {
            let u0 = k as f64;
            occ.extend([1.0, 4.0, u0, 0.0, u0 + 1.0, 0.0, u0 + 1.0, 1.0, u0, 1.0]);
        }
        let f = occluded_points(&occ, &[3.0, 10.5, 0.5, 5.0, 10.5, 0.5, 0.5, 99.0, 0.5, 5.0]);
        assert_eq!(f, vec![3.0, 1.0, 0.0, 0.0]);
    }

    /// [94] Anschlag: von der Anschlag-Seite aus ist die sichtbare Öffnung um die Wandnasen kleiner.
    #[test]
    fn anschlag_verkleinert_die_ansicht_nur_von_seiner_seite() {
        let frame = [0.0, 0.0, -3.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0];
        let rec = |rebate: f64, side: f64| {
            let mut b = vec![1.0, 0.0, 0.0, 5.0, 0.0, 0.3, 1.0, 2.2, 0.9, 2.3, 0.0, 0.0, f64::NAN, 0.06, 0.0, f64::NAN, f64::NAN, 1.0, 1.0, rebate, side, 0.0];
            b.truncate(1 + REC);
            b
        };
        let width = |f: &[f64]| {
            assert_eq!(f[1], 1.0);
            let xs = [f[4], f[6], f[8], f[10]];
            xs.iter().cloned().fold(f64::NEG_INFINITY, f64::max) - xs.iter().cloned().fold(f64::INFINITY, f64::min)
        };
        let w0 = width(&openings(&frame, &rec(0.0, 1.0)));
        let w1 = width(&openings(&frame, &rec(0.05, 1.0)));
        let w2 = width(&openings(&frame, &rec(0.05, -1.0)));
        assert!((w0 - 1.2).abs() < 1e-9 && (w1 - 1.1).abs() < 1e-9 && (w2 - 1.2).abs() < 1e-9, "{w0} {w1} {w2}");
    }
}
