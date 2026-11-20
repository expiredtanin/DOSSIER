//! [307] Gelände im 3D-Dokument (`axo.rs`): dieselbe Netz-Quelle wie 3D und Ansicht (`excavation::terrain_model_mesh`,
//! mit Baugruben, Höhen im Modellbezug) als deckende Flächen. Kanten nur am Rand (Netzrand und Schnittkante des
//! Ausschnitts), keine Dreiecksfugen. Das Netz wird auf einen Ausschnitt um das Gebäude zugeschnitten (Umfang des
//! Gebäudes + Rand), damit grosse Geländemodelle das Flächenbudget nicht sprengen. Klasse über `Visibility` und die
//! Ebenensichtbarkeit des Projekts ([180], [181]).

use super::section::{Kind, OwnerRef, ViewFaces, Visibility};
use crate::hlr;
use crate::model::*;
use std::collections::HashMap;

type V3 = [f64; 3];

/// Höchstens so viele Dreiecke je Gelände nach dem Zuschnitt (sonst wird der Rand enger).
const TRI_BUDGET: usize = 12_000;
/// Zellen des Rasters, auf das zu dichte Netze umgerechnet werden (je zwei Dreiecke).
const GRID_CELLS: f64 = 3_000.0;

/// [308] Zuschnitt des Geländes im 3D-Dokument (Modellsockel).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum TerrainClip {
    /// Parzelle (`siteRules.parcel`) + 2 m Rand, ohne Parzelle Gebäude + 5 m; mit Sockel-Seitenflächen.
    #[default]
    Parcel,
    /// Immer Gebäude + 5 m; mit Sockel.
    Building,
    /// Wie vor [308]: weiter Ausschnitt um das Gebäude, kein Sockel.
    None,
}

impl TerrainClip {
    pub fn parse(s: &str) -> Option<TerrainClip> {
        match s {
            "" | "parcel" => Some(TerrainClip::Parcel),
            "building" => Some(TerrainClip::Building),
            "none" => Some(TerrainClip::None),
            _ => None,
        }
    }
}

/// Rand um die Parzelle bzw. das Gebäude (m).
const PARCEL_MARGIN: f64 = 2.0;
const BUILDING_MARGIN: f64 = 5.0;
/// Sockel reicht so weit unter den tiefsten Geländepunkt (m).
const SOCKEL_DEPTH: f64 = 1.0;
/// [309] Sockel-Unterkante mindestens so weit unter dem tiefsten Bauteil (m).
const BUILDING_CLEARANCE: f64 = 0.5;

/// Weiter Ausschnitt [x0, y0, x1, y1] um das Gebäude (nur `TerrainClip::None`, ohne Sockel).
fn clip_rect_of(bounds: Option<[f64; 4]>) -> Option<[f64; 4]> {
    bounds.map(|b| {
        let margin = (0.6 * (b[2] - b[0]).max(b[3] - b[1])).max(8.0);
        [b[0] - margin, b[1] - margin, b[2] + margin, b[3] + margin]
    })
}

type R2 = [f64; 2];

/// [309] Zuschnittfläche des Sockels: einfacher Ring gegen den Uhrzeigersinn samt Ausdehnung und Fläche.
struct Area {
    ring: Vec<R2>,
    bbox: [f64; 4],
    area: f64,
}

fn ring_area(r: &[R2]) -> f64 {
    let n = r.len();
    (0..n).map(|i| r[i][0] * r[(i + 1) % n][1] - r[(i + 1) % n][0] * r[i][1]).sum::<f64>() / 2.0
}

fn rect_ring(b: [f64; 4]) -> Vec<R2> {
    vec![[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]]
}

/// Umriss um `d` nach aussen versetzt (Gehrung über den 2D-Kern, Ecken höchstens 4·d weit), Selbstschnitte an
/// einspringenden Ecken über eine Vereinigung geheilt: ein einfacher Ring gegen den Uhrzeigersinn.
fn offset_outline(ring: &[R2], d: f64) -> Vec<Vec<R2>> {
    let mut pts: Vec<R2> = Vec::new();
    for &q in ring {
        if pts.last().is_none_or(|l| (l[0] - q[0]).hypot(l[1] - q[1]) > 1e-9) {
            pts.push(q);
        }
    }
    while pts.len() > 1 && (pts[0][0] - pts[pts.len() - 1][0]).hypot(pts[0][1] - pts[pts.len() - 1][1]) <= 1e-9 {
        pts.pop();
    }
    if pts.len() < 3 || ring_area(&pts).abs() < 1e-9 {
        return Vec::new();
    }
    if ring_area(&pts) < 0.0 {
        pts.reverse();
    }
    // CCW: links = innen, also nach aussen mit −d.
    let v: Vec<kernel2d::Vec2> = pts.iter().map(|q| kernel2d::Vec2::new(q[0], q[1])).collect();
    let off = kernel2d::offset_polyline(&v, -d, true);
    let out: Vec<R2> = off
        .iter()
        .zip(&pts)
        .map(|(o, q)| {
            let (dx, dy) = (o.x - q[0], o.y - q[1]);
            let l = dx.hypot(dy);
            let f = if l > 4.0 * d { 4.0 * d / l } else { 1.0 };
            [q[0] + dx * f, q[1] + dy * f]
        })
        .collect();
    if out.iter().any(|q| !q[0].is_finite() || !q[1].is_finite()) {
        return Vec::new();
    }
    vec![out]
}

/// [309] Zuschnittfläche: Umriss der Parzelle (`siteRules.parcel`) + 2 m (Gehrung, konkave Umrisse sauber), vereinigt mit dem
/// Gebäude + 2 m; ohne Parzelle bzw. bei `Building` das Gebäude + 5 m. `None` bei `TerrainClip::None` oder ohne Gebäude.
fn clip_area_of(p: &Project, bounds: Option<[f64; 4]>, clip: TerrainClip) -> Option<Area> {
    if clip == TerrainClip::None {
        return None;
    }
    let grow = |b: [f64; 4], m: f64| [b[0] - m, b[1] - m, b[2] + m, b[3] + m];
    let parcel = (clip == TerrainClip::Parcel)
        .then(|| p.site_rules.as_ref().map(|r| &r.parcel))
        .flatten()
        .filter(|r| r.len() >= 3 && r.iter().all(|q| q.x.is_finite() && q.y.is_finite()));
    let polys: Vec<Vec<R2>> = match (parcel, bounds) {
        (Some(r), b) => {
            let ring: Vec<R2> = r.iter().map(|q| [q.x, q.y]).collect();
            let mut v = offset_outline(&ring, PARCEL_MARGIN);
            if v.is_empty() {
                return None;
            }
            if let Some(b) = b {
                v.push(rect_ring(grow(b, PARCEL_MARGIN)));
            }
            v
        }
        (None, Some(b)) => vec![rect_ring(grow(b, BUILDING_MARGIN))],
        (None, None) => return None,
    };
    // Vereinigung (heilt Selbstschnitte); der grösste Aussenring zählt.
    let u = crate::polygon_bool::union(&polys.into_iter().map(|r| vec![r]).collect::<Vec<_>>());
    let ring = u.into_iter().filter_map(|mut q| (!q.is_empty()).then(|| q.swap_remove(0))).max_by(|a, b| ring_area(a).abs().total_cmp(&ring_area(b).abs()))?;
    let area = ring_area(&ring);
    if !(area.abs() > 1e-6) {
        return None;
    }
    let ring = if area < 0.0 { ring.into_iter().rev().collect() } else { ring };
    let bbox = ring.iter().fold([f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY], |a, q| [a[0].min(q[0]), a[1].min(q[1]), a[2].max(q[0]), a[3].max(q[1])]);
    Some(Area { area: area.abs(), ring, bbox })
}

/// Grundrissausdehnung des Gebäudes (Wände, Decken); `None` ohne Bauteile.
fn building_bounds(p: &Project) -> Option<[f64; 4]> {
    let mut b = [f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY];
    let mut add = |x: f64, y: f64| {
        if x.is_finite() && y.is_finite() {
            b = [b[0].min(x), b[1].min(y), b[2].max(x), b[3].max(y)];
        }
    };
    for w in &p.walls {
        add(w.start.x, w.start.y);
        add(w.end.x, w.end.y);
    }
    for c in p.ceilings.as_deref().unwrap_or(&[]) {
        for q in c.ring_xy() {
            add(q[0], q[1]);
        }
    }
    (b[0].is_finite() && b[2].is_finite()).then_some(b)
}

/// Dreieck an das Rechteck `r` = [x0, y0, x1, y1] zuschneiden (Sutherland-Hodgman); `rim[i]`: Kante i → i+1 zeichnen.
/// Neue Kanten am Rechteck werden gezeichnet (Schnittkante des Ausschnitts).
fn clip_rect(tri: [V3; 3], rim: [bool; 3], r: [f64; 4]) -> Option<(Vec<V3>, Vec<bool>)> {
    let mut pts: Vec<V3> = tri.to_vec();
    let mut flags: Vec<bool> = rim.to_vec();
    let sides: [&dyn Fn(V3) -> f64; 4] = [&|p| p[0] - r[0], &|p| r[2] - p[0], &|p| p[1] - r[1], &|p| r[3] - p[1]];
    for g in sides {
        let n = pts.len();
        let vals: Vec<f64> = pts.iter().map(|&p| g(p)).collect();
        if vals.iter().all(|v| *v >= 0.0) {
            continue;
        }
        let (mut op, mut of) = (Vec::new(), Vec::new());
        for i in 0..n {
            let j = (i + 1) % n;
            let (p, q, gp, gq) = (pts[i], pts[j], vals[i], vals[j]);
            let x = || {
                let t = gp / (gp - gq);
                [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t]
            };
            match (gp >= 0.0, gq >= 0.0) {
                (true, true) => {
                    op.push(p);
                    of.push(flags[i]);
                }
                (true, false) => {
                    op.push(p);
                    of.push(flags[i]);
                    op.push(x());
                    of.push(true);
                }
                (false, true) => {
                    op.push(x());
                    of.push(flags[i]);
                }
                (false, false) => {}
            }
        }
        if op.len() < 3 {
            return None;
        }
        pts = op;
        flags = of;
    }
    Some((pts, flags))
}

fn dist_seg(p: R2, a: R2, b: R2) -> f64 {
    let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
    let l2 = dx * dx + dy * dy;
    let t = if l2 > 0.0 { (((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2).clamp(0.0, 1.0) } else { 0.0 };
    (p[0] - a[0] - t * dx).hypot(p[1] - a[1] - t * dy)
}

const ON_EPS: f64 = 1e-7;

/// [309] Dreieck an die Zuschnittfläche zuschneiden (Schnitt über i_overlay, Ohrenschnitt der Stücke, Höhen auf der
/// Dreiecksebene). `rim[i]`: Kante i → i+1 des Dreiecks ist Netzrand. Randkanten der Ergebnisdreiecke: Kanten auf dem
/// Ring der Fläche (gerade Zuschnittkante) und Teile der Netzrandkanten.
fn clip_tri_area(tri: [V3; 3], rim: [bool; 3], a: &Area) -> Vec<(Vec<V3>, Vec<bool>)> {
    let xy: Vec<R2> = tri.iter().map(|v| [v[0], v[1]]).collect();
    let b = a.bbox;
    if xy.iter().all(|q| q[0] < b[0]) || xy.iter().all(|q| q[0] > b[2]) || xy.iter().all(|q| q[1] < b[1]) || xy.iter().all(|q| q[1] > b[3]) {
        return Vec::new();
    }
    let n = a.ring.len();
    let near = |q: R2| (0..n).any(|i| dist_seg(q, a.ring[i], a.ring[(i + 1) % n]) < ON_EPS);
    let cut = crate::roof_skeleton::rings_cross(&xy, &a.ring) || xy.iter().any(|q| near(*q));
    if !cut {
        let c = [(xy[0][0] + xy[1][0] + xy[2][0]) / 3.0, (xy[0][1] + xy[1][1] + xy[2][1]) / 3.0];
        return if crate::roof_skeleton::point_in_ring(c, &a.ring) { vec![(tri.to_vec(), rim.to_vec())] } else { Vec::new() };
    }
    let det = (xy[1][0] - xy[0][0]) * (xy[2][1] - xy[0][1]) - (xy[2][0] - xy[0][0]) * (xy[1][1] - xy[0][1]);
    if !(det.abs() > 1e-14) {
        return Vec::new();
    }
    let z_at = |q: R2| {
        let l1 = ((q[0] - xy[0][0]) * (xy[2][1] - xy[0][1]) - (xy[2][0] - xy[0][0]) * (q[1] - xy[0][1])) / det;
        let l2 = ((xy[1][0] - xy[0][0]) * (q[1] - xy[0][1]) - (q[0] - xy[0][0]) * (xy[1][1] - xy[0][1])) / det;
        tri[0][2] + l1 * (tri[1][2] - tri[0][2]) + l2 * (tri[2][2] - tri[0][2])
    };
    let on_tri_rim = |u: R2, v: R2| (0..3).any(|k| rim[k] && dist_seg(u, xy[k], xy[(k + 1) % 3]) < ON_EPS && dist_seg(v, xy[k], xy[(k + 1) % 3]) < ON_EPS);
    let on_ring = |u: R2, v: R2| (0..n).any(|i| dist_seg(u, a.ring[i], a.ring[(i + 1) % n]) < ON_EPS && dist_seg(v, a.ring[i], a.ring[(i + 1) % n]) < ON_EPS);
    let mut out = Vec::new();
    for poly in crate::polygon_bool::intersection(&[vec![xy.clone()]], &[vec![a.ring.clone()]]) {
        let Some(outer) = poly.first() else { continue };
        for [i, j, k] in crate::solid_bool::ear_clip(outer) {
            let q = [outer[i], outer[j], outer[k]];
            let flags = (0..3).map(|e| on_ring(q[e], q[(e + 1) % 3]) || on_tri_rim(q[e], q[(e + 1) % 3])).collect();
            out.push((q.iter().map(|&c| [c[0], c[1], z_at(c)]).collect(), flags));
        }
    }
    out
}

/// [309] Höhe des Geländes an (x, y); ausserhalb des Netzes die nächste Netzhöhe (Rand am Netz ergänzt).
fn height_at(tin: &crate::terrain::Tin, ix: &crate::terrain::TinIndex, tb: [f64; 4], x: f64, y: f64) -> f64 {
    ix.z_at(x, y)
        .or_else(|| ix.z_at(x.clamp(tb[0], tb[2]), y.clamp(tb[1], tb[3])))
        .unwrap_or_else(|| {
            let (mut best, mut bz) = (f64::INFINITY, 0.0);
            for (q, z) in tin.xy.iter().zip(&tin.z) {
                let d = (q[0] - x).hypot(q[1] - y);
                if d < best {
                    (best, bz) = (d, *z);
                }
            }
            bz
        })
}

/// [309] Regelmässiges Dreiecksraster über der Zuschnittfläche (höchstens `GRID_CELLS` Zellen, je zwei Dreiecke). Das Netz ist
/// über seinen Rand hinaus ergänzt, so dass die Fläche lückenlos bis an die gerade Zuschnittkante reicht.
fn grid_over_area(pos: &[f64], idx: &[f64], a: &Area) -> Vec<[V3; 3]> {
    let tin = crate::terrain::Tin::from_flat(pos, idx);
    let tb = tin.bbox();
    let b = a.bbox;
    let (w, h) = (b[2] - b[0], b[3] - b[1]);
    if !(w > 1e-6 && h > 1e-6 && w.is_finite() && h.is_finite() && tb.iter().all(|v| v.is_finite())) {
        return Vec::new();
    }
    let step = (w * h / GRID_CELLS).sqrt().max(1e-3);
    let (nx, ny) = (((w / step).ceil() as usize).clamp(1, 400), ((h / step).ceil() as usize).clamp(1, 400));
    let (dx, dy) = (w / nx as f64, h / ny as f64);
    let ix = crate::terrain::TinIndex::new(&tin);
    let pt: Vec<V3> = (0..=ny).flat_map(|j| (0..=nx).map(move |i| (i, j))).map(|(i, j)| {
        let (x, y) = (b[0] + i as f64 * dx, b[1] + j as f64 * dy);
        [x, y, height_at(&tin, &ix, tb, x, y)]
    }).collect();
    let at = |i: usize, j: usize| pt[j * (nx + 1) + i];
    let mut out = Vec::with_capacity(2 * nx * ny);
    for j in 0..ny {
        for i in 0..nx {
            let (p00, p10, p11, p01) = (at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1));
            out.push([p00, p10, p11]);
            out.push([p00, p11, p01]);
        }
    }
    out
}

type K3 = (i64, i64, i64);

fn key(p: V3) -> K3 {
    ((p[0] * 1e6).round() as i64, (p[1] * 1e6).round() as i64, (p[2] * 1e6).round() as i64)
}

fn ekey(a: V3, b: V3) -> (K3, K3) {
    let (ka, kb) = (key(a), key(b));
    if ka <= kb { (ka, kb) } else { (kb, ka) }
}

/// Netz auf ein regelmässiges Raster (höchstens `GRID_CELLS` Zellen) im Ausschnitt `rect` (sonst Netzausdehnung)
/// umrechnen; Zellen mit einer Ecke ausserhalb des Netzes entfallen, offene Zellkanten sind der Rand.
fn resample(pos: &[f64], idx: &[f64], rect: Option<[f64; 4]>) -> Vec<(Vec<V3>, Vec<bool>)> {
    let tin = crate::terrain::Tin::from_flat(pos, idx);
    let tb = tin.bbox();
    let r = match rect {
        Some(r) => [r[0].max(tb[0]), r[1].max(tb[1]), r[2].min(tb[2]), r[3].min(tb[3])],
        None => tb,
    };
    let (w, h) = (r[2] - r[0], r[3] - r[1]);
    if !(w > 1e-6 && h > 1e-6 && w.is_finite() && h.is_finite()) {
        return Vec::new();
    }
    let step = (w * h / GRID_CELLS).sqrt().max(1e-3);
    let (nx, ny) = (((w / step).ceil() as usize).clamp(1, 400), ((h / step).ceil() as usize).clamp(1, 400));
    let (dx, dy) = (w / nx as f64, h / ny as f64);
    let ix = crate::terrain::TinIndex::new(&tin);
    let z: Vec<Option<V3>> = (0..=ny).flat_map(|j| (0..=nx).map(move |i| (i, j))).map(|(i, j)| {
        let (x, y) = (r[0] + i as f64 * dx, r[1] + j as f64 * dy);
        ix.z_at(x, y).map(|z| [x, y, z])
    }).collect();
    let at = |i: usize, j: usize| z[j * (nx + 1) + i];
    let cell = |i: isize, j: isize| -> Option<[V3; 4]> {
        if i < 0 || j < 0 || i >= nx as isize || j >= ny as isize {
            return None;
        }
        let (i, j) = (i as usize, j as usize);
        Some([at(i, j)?, at(i + 1, j)?, at(i + 1, j + 1)?, at(i, j + 1)?])
    };
    let mut out = Vec::new();
    for j in 0..ny as isize {
        for i in 0..nx as isize {
            let Some([a, b, c, d]) = cell(i, j) else { continue };
            // Kanten des Vierecks a-b (unten), b-c (rechts), c-d (oben), d-a (links): Rand, wenn dort keine Zelle liegt.
            let (bot, right, top, left) = (cell(i, j - 1).is_none(), cell(i + 1, j).is_none(), cell(i, j + 1).is_none(), cell(i - 1, j).is_none());
            out.push((vec![a, b, c], vec![bot, right, false]));
            out.push((vec![a, c, d], vec![false, top, left]));
        }
    }
    out
}

/// Modell (x, y, Höhe) → Welt (x, Höhe, y) (Umkehrung von `model_of`).
fn to_world(m: V3) -> V3 {
    [m[0], m[2], m[1]]
}

/// Gelände-Flächen an `vf` / `refs` anhängen. `view`/`view_n`: wie bei `model_view_faces` (Welt: x, Höhe, y).
pub(super) fn add_terrain(p: &Project, vis: &Visibility, view: &dyn Fn(V3) -> V3, view_n: &dyn Fn(V3) -> V3, clip: TerrainClip, lowest: f64, vf: &mut ViewFaces, refs: &mut Vec<OwnerRef>) {
    let hidden = crate::model3d::hidden_category_codes(&p.layers);
    let bounds = building_bounds(p);
    for t in crate::excavation::terrains(p) {
        if hidden.contains(t.category_code.as_str()) || !(vis.visible(&t.category_code) && vis.render(&t.category_code)) || t.positions.len() < 9 || t.indices.len() < 3 {
            continue;
        }
        let (pos, idx, _) = crate::excavation::terrain_model_mesh(p, t);
        let nv = pos.len() / 3;
        let vert = |i: usize| [pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]];
        let tris: Vec<[V3; 3]> = idx
            .chunks_exact(3)
            .filter(|c| c.iter().all(|x| x.is_finite() && *x >= 0.0 && x.fract() == 0.0 && (*x as usize) < nv))
            .map(|c| [vert(c[0] as usize), vert(c[1] as usize), vert(c[2] as usize)])
            .filter(|t| t.iter().all(|v| v.iter().all(|x| x.is_finite())))
            .collect();
        // Kanten, die nur ein Dreieck hat, sind Netzrand.
        let mut count: HashMap<(K3, K3), u32> = HashMap::new();
        for t in &tris {
            for k in 0..3 {
                *count.entry(ekey(t[k], t[(k + 1) % 3])).or_default() += 1;
            }
        }
        let mut clipped: Vec<(Vec<V3>, Vec<bool>)> = Vec::new();
        let area = clip_area_of(p, bounds, clip);
        let rim_of = |t: &[V3; 3]| [0, 1, 2].map(|k| count.get(&ekey(t[k], t[(k + 1) % 3])).copied().unwrap_or(0) < 2);
        if let Some(area) = &area {
            // [309] Zuschnitt auf die Fläche (Parzellenumriss + 2 m): gerade Kanten. Zu dicht oder das Netz deckt die Fläche
            // nicht ganz: regelmässiges Raster über der Fläche, am Netzrand ergänzt (keine gezackte Kante).
            for t in &tris {
                clipped.extend(clip_tri_area(*t, rim_of(t), area));
            }
            let covered: f64 = clipped.iter().map(|(q, _)| ring_area(&q.iter().map(|v| [v[0], v[1]]).collect::<Vec<_>>()).abs()).sum();
            if clipped.len() > TRI_BUDGET || covered < 0.999 * area.area {
                clipped = grid_over_area(&pos, &idx, area).iter().flat_map(|t| clip_tri_area(*t, [false; 3], area)).collect();
            }
        } else {
            // Ohne Sockel: weiter Ausschnitt um das Gebäude, Netzrand bleibt Rand.
            let rect = clip_rect_of(bounds);
            for t in &tris {
                let rim = rim_of(t);
                match rect {
                    Some(r) => {
                        let (lo, hi) = t.iter().fold(([f64::INFINITY; 2], [f64::NEG_INFINITY; 2]), |(l, h), v| ([l[0].min(v[0]), l[1].min(v[1])], [h[0].max(v[0]), h[1].max(v[1])]));
                        if hi[0] < r[0] || lo[0] > r[2] || hi[1] < r[1] || lo[1] > r[3] {
                            continue;
                        }
                        if let Some(c) = clip_rect(*t, rim, r) {
                            clipped.push(c);
                        }
                    }
                    None => clipped.push((t.to_vec(), rim.to_vec())),
                }
            }
            // Zu dicht (Vermessungsnetze, Zentimeter-Dreiecke): auf ein regelmässiges Raster umrechnen.
            if clipped.len() > TRI_BUDGET {
                clipped = resample(&pos, &idx, rect);
            }
        }
        if clipped.is_empty() {
            continue;
        }
        let owner = refs.len() as u32;
        refs.push(OwnerRef { kind: Kind::Mesh, id: Some(t.id.clone()), stair: false, column: false, railing: false, glass: false, perforated: false, opening: false, terrain: true, terrain_side: false });
        vf.owners.push((Kind::Mesh, usize::MAX));
        let mut oriented: Vec<(Vec<V3>, Vec<bool>, V3)> = Vec::new();
        for (pts, rim) in clipped {
            let (a, b, c) = (pts[0], pts[1], pts[2]);
            let (u, w) = ([b[0] - a[0], b[1] - a[1], b[2] - a[2]], [c[0] - a[0], c[1] - a[1], c[2] - a[2]]);
            let mut n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
            let l = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
            if !(l > 1e-12) {
                continue;
            }
            let (mut pts, mut rim) = (pts, rim);
            // Normale nach oben (Höhe = z im Modell).
            if n[2] < 0.0 {
                n = [-n[0], -n[1], -n[2]];
                pts.reverse();
                // Kante i → i+1 des umgedrehten Rings ist die Kante (m−2−i) → (m−1−i) des alten.
                let m = rim.len();
                rim = (0..m).map(|i| rim[(2 * m - 2 - i) % m]).collect();
            }
            let n = [n[0] / l, n[1] / l, n[2] / l];
            oriented.push((pts, rim, n));
        }
        for (pts, rim, n) in &oriented {
            let mut f = hlr::Face::new(pts.iter().map(|&q| view(to_world(q))).collect(), view_n(to_world(*n)), owner);
            f.no_edge = rim.iter().map(|r| !r).collect();
            vf.faces.push(f);
        }
        if area.is_some() {
            add_sockel(&oriented, t.id.as_str(), lowest, view, view_n, vf, refs);
        }
    }
}

/// [308] Sockel: senkrechte Seitenflächen unter allen Randkanten bis `tiefster Punkt − 1 m` (Schnittkante des Modells).
/// Senkrechte Kanten nur an Ecken des Umrisses, die obere Kante zeichnet die Geländefläche selbst.
fn add_sockel(tris: &[(Vec<V3>, Vec<bool>, V3)], id: &str, lowest: f64, view: &dyn Fn(V3) -> V3, view_n: &dyn Fn(V3) -> V3, vf: &mut ViewFaces, refs: &mut Vec<OwnerRef>) {
    let zmin = tris.iter().flat_map(|t| t.0.iter().map(|q| q[2])).fold(f64::INFINITY, f64::min);
    if !zmin.is_finite() {
        return;
    }
    // [309] Mindestens 0.5 m unter dem tiefsten Bauteil (Keller unter dem Gelände).
    let zb = if lowest.is_finite() { (zmin - SOCKEL_DEPTH).min(lowest - BUILDING_CLEARANCE) } else { zmin - SOCKEL_DEPTH };
    // Randkanten (Umlaufsinn: Fläche links) und Richtung der einlaufenden Kante je Punkt.
    let mut rim: Vec<(V3, V3)> = Vec::new();
    for (pts, flags, _) in tris {
        let m = pts.len();
        for i in 0..m {
            if flags[i] {
                rim.push((pts[i], pts[(i + 1) % m]));
            }
        }
    }
    // [309] Einlaufende Kante je Punkt auf 0.1 mm gerastert, mit den acht Nachbarzellen: Splitter aus dem Zuschnitt
    // (Punkte um 1e-8 verschoben) gelten nicht als Ecke.
    let q = |v: f64| (v * 1e4).floor() as i64;
    let mut incoming: HashMap<(i64, i64), Vec<[f64; 2]>> = HashMap::new();
    for (a, b) in &rim {
        incoming.entry((q(b[0]), q(b[1]))).or_default().push([b[0] - a[0], b[1] - a[1]]);
    }
    let incoming_at = |p: V3| -> Vec<[f64; 2]> {
        let (cx, cy) = (q(p[0]), q(p[1]));
        (-1..=1).flat_map(|i| (-1..=1).map(move |j| (cx + i, cy + j))).filter_map(|c| incoming.get(&c)).flatten().copied().collect()
    };
    let owner = refs.len() as u32;
    refs.push(OwnerRef { kind: Kind::Mesh, id: Some(id.to_string()), stair: false, column: false, railing: false, glass: false, perforated: false, opening: false, terrain: true, terrain_side: true });
    vf.owners.push((Kind::Mesh, usize::MAX));
    for (a, b) in rim {
        let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
        let l = (dx * dx + dy * dy).sqrt();
        if !(l > 1e-9) {
            continue;
        }
        let n = [dy / l, -dx / l, 0.0];
        let inc = incoming_at(a);
        let corner = inc.is_empty() || inc.iter().all(|d| {
            let dl = (d[0] * d[0] + d[1] * d[1]).sqrt();
            dl > 1e-9 && ((d[0] * dy - d[1] * dx).abs() > 1e-3 * dl * l || d[0] * dx + d[1] * dy < 0.0)
        });
        let (al, bl) = ([a[0], a[1], zb], [b[0], b[1], zb]);
        let mut f = hlr::Face::new([a, al, bl, b].iter().map(|&q| view(to_world(q))).collect(), view_n(to_world(n)), owner);
        f.no_edge = vec![!corner, false, true, true];
        vf.faces.push(f);
    }
}

/// Fläche der Zuschnittfläche des Projekts (Tests).
#[cfg(test)]
pub(super) fn clip_area_for_test(p: &Project) -> Option<f64> {
    clip_area_of(p, building_bounds(p), TerrainClip::Parcel).map(|a| a.area)
}
