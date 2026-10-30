//! Treppen im 3D (aus `src/plan/toWalls3d/stairs.ts`): Tritt-Prismen und Podeste als Slabs
//! (`slabs`), glatte Ortbeton-Laufplatte als Mesh (`slab_meshes`), Handlauf und Pfosten als Quader
//! (`railings`). Die Treppengeometrie selbst kommt aus `kernel2d` (`stair_geometry`); TS sammelt aus
//! dem `Project` nur Parameter, Höhen und Tragart und färbt die Ergebnisse ein.
//!
//! Eingabe (je Treppe 24 Zahlen, davor die Anzahl): die 16 Treppen-Parameter (s. [`crate::stair`]),
//! `zUnten, zOben, tragart (0 massiv, 1 beton, 2 offen: Wange/aufgesattelt/Spindel),
//! trittdicke, nase, geschlosseneSetzstufen (0/1), gelaender (0 keine, 1 links, 2 rechts, 3 beide),
//! saeulenRadius (0 keine; nur Wendel)`.
//!
//! Ausgabe Slabs: `[n, (treppe, monolith 0/1, zUnten, zOben, nPkt, x, y …)…]`; Ausgabe Meshes
//! (Laufplatte, Geländer): `[n, (treppe, nPos, nIdx, positionen…, indizes…)…]`. `treppe` ist der
//! Index in der Eingabe. Unsinn (NaN, kaputte Puffer) ergibt ein leeres Ergebnis.

use crate::flat_read::Reader;
use crate::jsmath::{hypot, hypot2};
use crate::mesh3d::Mesh;
use crate::stair::decode_params;
use kernel2d::{stair_geometry, StairGeometry, StairParams};

type P = [f64; 2];

/// Ignoriere entartete vertikale Ausschnitte (`EPS` in `toWalls3d/shared.ts`).
const EPS: f64 = 1e-4;
/// Laufplattendicke einer stufigen Ortbetontreppe (Meter).
const CONCRETE_WAIST: f64 = 0.18;
/// Max. Stufenhöhe der Soffit-Treppung im Schnitt.
const SOFFIT_SLICE_STEP: f64 = 0.015;
/// Handlaufhöhe über der Trittvorderkante und Querschnitt von Handlauf/Pfosten.
const RAIL_HEIGHT: f64 = 0.9;
const RAIL_THICK: f64 = 0.04;

const MASSIV: u8 = 0;
const BETON: u8 = 1;

struct StairIn {
    params: StairParams,
    z_bottom: f64,
    z_top: f64,
    structure: u8,
    tread_thickness: f64,
    nosing: f64,
    closed_risers: bool,
    railing: u8,
    column_radius: f64,
}

impl StairIn {
    fn straight(&self) -> bool {
        self.params.shape == "straight"
    }
    fn spiral(&self) -> bool {
        self.params.shape == "spiral"
    }
}

fn decode(buf: &[f64]) -> Option<Vec<Option<StairIn>>> {
    let mut r = Reader::new(buf);
    let n = r.count()?;
    let mut out = Vec::with_capacity(n.min(1 << 16));
    for _ in 0..n {
        let mut p = [0.0; 16];
        for v in p.iter_mut() {
            *v = r.num()?;
        }
        let (z_bottom, z_top, structure, tread_thickness, nosing, closed, railing, column) =
            (r.num()?, r.num()?, r.num()?, r.num()?, r.num()?, r.num()?, r.num()?, r.num()?);
        // Eine unbrauchbare Treppe fällt einzeln weg (Index bleibt erhalten).
        let valid = [z_bottom, z_top, tread_thickness, nosing].iter().all(|v| v.is_finite());
        out.push(match (valid, decode_params(&p)) {
            (true, Some(params)) => Some(StairIn {
                params,
                z_bottom,
                z_top,
                structure: if structure == 0.0 { MASSIV } else if structure == 1.0 { BETON } else { 2 },
                tread_thickness,
                nosing,
                closed_risers: closed != 0.0,
                railing: railing.clamp(0.0, 3.0) as u8,
                column_radius: if column.is_finite() && column > 0.0 { column.min(5.0) } else { 0.0 },
            }),
            _ => None,
        });
    }
    Some(out)
}

pub struct Slab {
    pub src: usize,
    pub monolith: bool,
    pub z_bottom: f64,
    pub z_top: f64,
    pub pts: Vec<P>,
}

fn pt(p: &kernel2d::Vec2) -> P {
    [p.x, p.y]
}

fn centroid_of(pts: &[P]) -> P {
    let (mut x, mut y) = (0.0, 0.0);
    for p in pts {
        x += p[0];
        y += p[1];
    }
    [x / pts.len() as f64, y / pts.len() as f64]
}

/// JS `a || b`: 0 und NaN gelten als falsch.
fn or(v: f64, fallback: f64) -> f64 {
    if v == 0.0 || v.is_nan() {
        fallback
    } else {
        v
    }
}

struct Front {
    a: usize,
    b: usize,
    dir: P,
}

/// Vordere Kante eines Tritt-Vielecks (Richtung des Nachbartritts), s. TS `frontEdgeOf`.
fn front_edge_of(pts: &[P], target: P, prefer_near: bool) -> Front {
    let n = pts.len();
    let c = centroid_of(pts);
    let mut best = 0;
    let mut best_dist = if prefer_near { f64::INFINITY } else { f64::NEG_INFINITY };
    for e in 0..n {
        let (p0, p1) = (pts[e], pts[(e + 1) % n]);
        let mid = [(p0[0] + p1[0]) / 2.0, (p0[1] + p1[1]) / 2.0];
        let d = hypot2(mid[0] - target[0], mid[1] - target[1]);
        if if prefer_near { d < best_dist } else { d > best_dist } {
            best_dist = d;
            best = e;
        }
    }
    let (p0, p1) = (pts[best], pts[(best + 1) % n]);
    let mid = [(p0[0] + p1[0]) / 2.0, (p0[1] + p1[1]) / 2.0];
    let (dx, dy) = (mid[0] - c[0], mid[1] - c[1]);
    let len = or(hypot2(dx, dy), 1e-9);
    Front { a: best, b: (best + 1) % n, dir: [dx / len, dy / len] }
}

fn with_nosing(pts: &[P], neighbors: &[Vec<P>], k: usize, nosing: f64) -> Vec<P> {
    if nosing <= 1e-6 {
        return pts.to_vec();
    }
    let has_next = k + 1 < neighbors.len();
    let reference = if has_next {
        Some(&neighbors[k + 1])
    } else if k > 0 {
        Some(&neighbors[k - 1])
    } else {
        None
    };
    let Some(reference) = reference else { return pts.to_vec() };
    let f = front_edge_of(pts, centroid_of(reference), has_next);
    let mut out = pts.to_vec();
    out[f.a] = [pts[f.a][0] + f.dir[0] * nosing, pts[f.a][1] + f.dir[1] * nosing];
    out[f.b] = [pts[f.b][0] + f.dir[0] * nosing, pts[f.b][1] + f.dir[1] * nosing];
    out
}

fn closed_riser_outline(tr_pts: &[P], neighbors: &[Vec<P>], k: usize, tread_thickness: f64) -> Option<Vec<P>> {
    let has_next = k + 1 < neighbors.len();
    let reference = if has_next {
        Some(&neighbors[k + 1])
    } else if k > 0 {
        Some(&neighbors[k - 1])
    } else {
        None
    }?;
    let front = front_edge_of(tr_pts, centroid_of(reference), has_next);
    let n = tr_pts.len();
    let back_a = (front.a + n / 2) % n;
    let back_b = (front.b + n / 2) % n;
    let (ra, rb) = (tr_pts[back_a], tr_pts[back_b]);
    let thin = or(tread_thickness.min(0.02), 0.01);
    let off_a = [ra[0] - front.dir[0] * thin, ra[1] - front.dir[1] * thin];
    let off_b = [rb[0] - front.dir[0] * thin, rb[1] - front.dir[1] * thin];
    Some(vec![ra, rb, off_b, off_a])
}

/// Laufplattendicke (vertikal) der glatten Betontreppe.
fn concrete_waist(riser_height: f64) -> f64 {
    0.24_f64.min(0.14_f64.max(riser_height * 1.2))
}

fn lerp(p: P, q: P, t: f64) -> P {
    [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]
}

/// Geometrie samt Höhen; `None`, wenn die Treppe nicht ableitbar ist (Steighöhe ≤ EPS, Unsinn).
fn geometry_of(s: &StairIn) -> Option<(StairGeometry, f64)> {
    let total_rise = s.z_top - s.z_bottom;
    if total_rise.is_nan() || total_rise <= EPS {
        return None;
    }
    let geo = stair_geometry(&s.params, total_rise);
    Some((geo, total_rise))
}

/// Lauf-/Querparameter einer geraden Treppe (Laufrichtung normiert, Quer = linke Normale).
struct RunAxes {
    start: P,
    u: P,
    w: P,
}

impl RunAxes {
    fn of(s: &StairIn) -> Self {
        let (dx, dy) = (s.params.dir.x, s.params.dir.y);
        let l = or(hypot2(dx, dy), 1.0);
        let u = [dx / l, dy / l];
        RunAxes { start: [s.params.start.x, s.params.start.y], u, w: [-u[1], u[0]] }
    }
    fn run_of(&self, p: P) -> f64 {
        (p[0] - self.start[0]) * self.u[0] + (p[1] - self.start[1]) * self.u[1]
    }
    fn side_of(&self, p: P) -> f64 {
        (p[0] - self.start[0]) * self.w[0] + (p[1] - self.start[1]) * self.w[1]
    }
}

fn cmp(a: f64, b: f64) -> std::cmp::Ordering {
    a.partial_cmp(&b).unwrap_or(std::cmp::Ordering::Equal)
}

/// Tritt-Ecken einer geraden Treppe: `(Startkante links→rechts, Endkante links→rechts)`.
fn tread_edges(ax: &RunAxes, pts: &[P]) -> ([P; 2], [P; 2]) {
    let mut by_run = pts.to_vec();
    by_run.sort_by(|a, b| cmp(ax.run_of(*a), ax.run_of(*b)));
    let mut a = [by_run[0], by_run[1]];
    a.sort_by(|p, q| cmp(ax.side_of(*p), ax.side_of(*q)));
    let mut b = [by_run[2], by_run[3]];
    b.sort_by(|p, q| cmp(ax.side_of(*p), ax.side_of(*q)));
    (a, b)
}

fn slabs_of(s: &StairIn, idx: usize, for_section: bool, out: &mut Vec<Slab>) {
    let Some((geo, total_rise)) = geometry_of(s) else { return };
    let z_bottom = s.z_bottom;
    let structure = s.structure;
    let mut column: Option<Slab> = None;
    if s.spiral() && s.column_radius > 0.0 {
        if let Some(c) = &s.params.center {
            let pts = (0..COLUMN_SEGMENTS)
                .map(|k| {
                    let a = std::f64::consts::TAU * k as f64 / COLUMN_SEGMENTS as f64;
                    [c.x + s.column_radius * a.cos(), c.y + s.column_radius * a.sin()]
                })
                .collect();
            // Säule zuletzt einfügen: siehe unten; hier nur vormerken
            column = Some(Slab { src: idx, monolith: true, z_bottom, z_top: s.z_top, pts });
        }
    }
    if structure == BETON && (s.straight() || s.spiral()) && !for_section {
        out.extend(column);
        return;
    }
    let riser = geo.riser_height;
    let open = structure != MASSIV;
    let monolith = structure == MASSIV || structure == BETON;
    let nosing = if open { s.nosing } else { 0.0 };
    let treads: Vec<(Vec<P>, f64, f64)> =
        geo.treads.iter().map(|t| (t.pts.iter().map(pt).collect(), t.top_rise, t.base_rise)).collect();
    let neighbor_pts: Vec<Vec<P>> = treads.iter().map(|t| t.0.clone()).collect();

    if structure == BETON && s.straight() && for_section && s.params.run_length > EPS {
        let ax = RunAxes::of(s);
        let run_length = s.params.run_length;
        let waist_v = concrete_waist(riser);
        let soffit = |run_s: f64| {
            let t = run_s.max(0.0).min(run_length);
            z_bottom.max(z_bottom + (t / run_length) * total_rise - waist_v)
        };
        let n = ((riser / SOFFIT_SLICE_STEP).ceil()).max(1.0);
        let n_int = n as usize;
        for (pts, top_rise, _) in &treads {
            if pts.len() < 4 {
                continue;
            }
            let (a, b) = tread_edges(&ax, pts);
            let top = z_bottom + top_rise;
            for j in 0..n_int {
                let t0 = j as f64 / n;
                let t1 = (j + 1) as f64 / n;
                let bottom = soffit(ax.run_of(lerp(a[0], b[0], t0)));
                if top - bottom <= EPS {
                    continue;
                }
                let quad = vec![lerp(a[0], b[0], t0), lerp(a[0], b[0], t1), lerp(a[1], b[1], t1), lerp(a[1], b[1], t0)];
                out.push(Slab { src: idx, monolith, z_bottom: bottom, z_top: top, pts: quad });
            }
        }
        return;
    }

    for k in 0..treads.len() {
        let (tr_pts, top_rise, base_rise) = &treads[k];
        if tr_pts.len() < 3 {
            continue;
        }
        let pts = with_nosing(tr_pts, &neighbor_pts, k, nosing);
        let top = z_bottom + top_rise;
        let bottom = match structure {
            MASSIV => z_bottom,
            BETON => z_bottom.max(top - riser - CONCRETE_WAIST),
            _ => top - s.tread_thickness,
        };
        if top - bottom > EPS {
            out.push(Slab { src: idx, monolith, z_bottom: bottom, z_top: top, pts });
        }
        if open && s.closed_risers {
            if let Some(ro) = closed_riser_outline(tr_pts, &neighbor_pts, k, s.tread_thickness) {
                out.push(Slab {
                    src: idx,
                    monolith: false,
                    z_bottom: z_bottom + base_rise,
                    z_top: z_bottom + top_rise,
                    pts: ro,
                });
            }
        }
    }
    if let Some(landing) = &geo.landing {
        if landing.len() >= 3 {
            let landing_top = z_bottom + total_rise * 0.5;
            out.push(Slab {
                src: idx,
                monolith,
                z_bottom: if structure == BETON { z_bottom.max(landing_top - riser - CONCRETE_WAIST) } else { z_bottom },
                z_top: landing_top,
                pts: landing.iter().map(pt).collect(),
            });
        }
    }
    out.extend(column);
}

/// Kreisbogenstücke je Tritt in Wendelfläche und Handlauf.
const HELIX_SEGMENTS: usize = 6;
/// Ecken der Mittelsäule (Vieleck).
const COLUMN_SEGMENTS: usize = 24;

/// Wendel-Masse: Zentrum, Winkelbereich, Radien (wie `spiral_geometry` in `kernel2d`).
struct Helix {
    center: P,
    a0: f64,
    sweep: f64,
    r_in: f64,
    r_out: f64,
}

fn helix_of(s: &StairIn) -> Option<Helix> {
    let p = &s.params;
    let half_w = 0.05_f64.max(p.width / 2.0);
    let center = p.center.unwrap_or(p.start);
    let radius = (half_w + 0.1).max(p.radius.unwrap_or(p.width));
    let a0 = (p.start.y - center.y).atan2(p.start.x - center.x);
    let sweep = p.sweep.unwrap_or(270.0).to_radians();
    if !(sweep.abs() > 1e-6) {
        return None;
    }
    Some(Helix { center: [center.x, center.y], a0, sweep, r_in: (radius - half_w).max(0.02), r_out: radius + half_w })
}

impl Helix {
    fn at(&self, r: f64, ang: f64) -> P {
        [self.center[0] + r * ang.cos(), self.center[1] + r * ang.sin()]
    }
}

/// Wendelfläche einer Ortbetontreppe: je Tritt ein geschlossener Block, dessen Untersicht eine echte
/// Schraubenfläche ist (z linear im Winkel, radiale Erzeugende); Oberseite = ebener Tritt.
fn spiral_mesh(s: &StairIn, idx: usize, out: &mut Vec<Mesh>) {
    let Some((geo, total_rise)) = geometry_of(s) else { return };
    let Some(h) = helix_of(s) else { return };
    let n = geo.treads.len();
    if n == 0 {
        return;
    }
    let waist = concrete_waist(geo.riser_height);
    let z_bottom = s.z_bottom;
    let soffit = |frac: f64| z_bottom.max(z_bottom + frac * total_rise - waist);
    let d_a = h.sweep / n as f64;
    let mut positions: Vec<f64> = Vec::new();
    let mut indices: Vec<u32> = Vec::new();
    for (i, tr) in geo.treads.iter().enumerate() {
        let top = z_bottom + tr.top_rise;
        // Ringe entlang des Tritts: (innen unten, aussen unten, Winkel)
        let m = HELIX_SEGMENTS;
        let base = (positions.len() / 3) as u32;
        for j in 0..=m {
            let f = j as f64 / m as f64;
            let ang = h.a0 + (i as f64 + f) * d_a;
            let zb = soffit((i as f64 + f) / n as f64);
            for (r, z) in [(h.r_in, zb), (h.r_out, zb), (h.r_in, top), (h.r_out, top)] {
                let q = h.at(r, ang);
                positions.extend([q[0], q[1], z]);
            }
        }
        // Eckindizes je Ring j: 0 = innen unten, 1 = aussen unten, 2 = innen oben, 3 = aussen oben
        let v = |j: usize, k: u32| base + 4 * j as u32 + k;
        let mut quad = |a: u32, b: u32, c: u32, d: u32| indices.extend([a, b, c, a, c, d]);
        for j in 0..m {
            quad(v(j, 0), v(j, 1), v(j + 1, 1), v(j + 1, 0)); // Untersicht (Wendelfläche)
            quad(v(j, 2), v(j + 1, 2), v(j + 1, 3), v(j, 3)); // Trittfläche
            quad(v(j, 0), v(j + 1, 0), v(j + 1, 2), v(j, 2)); // innere Wange
            quad(v(j, 1), v(j, 3), v(j + 1, 3), v(j + 1, 1)); // äussere Wange
        }
        quad(v(0, 0), v(0, 2), v(0, 3), v(0, 1)); // Setzstufe (Anfang)
        quad(v(m, 0), v(m, 1), v(m, 3), v(m, 2)); // Ende
    }
    if indices.is_empty() {
        return;
    }
    // Drehsinn legt die Orientierung fest: bei negativem Volumen alle Dreiecke wenden.
    let mut mesh = Mesh { src: idx, positions, indices };
    if signed_volume(&mesh) < 0.0 {
        for t in mesh.indices.chunks_mut(3) {
            t.swap(1, 2);
        }
    }
    out.push(mesh);
}

fn signed_volume(m: &Mesh) -> f64 {
    let p = |i: u32| {
        let k = 3 * i as usize;
        [m.positions[k], m.positions[k + 1], m.positions[k + 2]]
    };
    m.indices
        .chunks(3)
        .map(|t| {
            let (a, b, c) = (p(t[0]), p(t[1]), p(t[2]));
            (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6.0
        })
        .sum()
}

fn meshes_of(s: &StairIn, idx: usize, out: &mut Vec<Mesh>) {
    if s.structure == BETON && s.spiral() {
        return spiral_mesh(s, idx, out);
    }
    if s.structure != BETON || !s.straight() || s.params.run_length <= EPS {
        return;
    }
    let Some((geo, total_rise)) = geometry_of(s) else { return };
    let z_bottom = s.z_bottom;
    let ax = RunAxes::of(s);
    let run_total = s.params.run_length;
    let waist_v = concrete_waist(geo.riser_height);
    let soffit_h = |run_s: f64| {
        let t = run_s.max(0.0).min(run_total);
        z_bottom.max(z_bottom + (t / run_total) * total_rise - waist_v)
    };
    let mut positions: Vec<f64> = Vec::new();
    let mut indices: Vec<u32> = Vec::new();
    for tr in &geo.treads {
        if tr.pts.len() < 4 {
            continue;
        }
        let pts: Vec<P> = tr.pts.iter().map(pt).collect();
        let mut by_run = pts.clone();
        by_run.sort_by(|a, b| cmp(ax.run_of(*a), ax.run_of(*b)));
        let (start_edge, end_edge) = tread_edges(&ax, &pts);
        let run_s = ax.run_of(by_run[0]).min(ax.run_of(by_run[1]));
        let run_e = ax.run_of(by_run[2]).max(ax.run_of(by_run[3]));
        let top_h = z_bottom + tr.top_rise;
        let (b_s, b_e) = (soffit_h(run_s), soffit_h(run_e));
        if top_h - b_s.max(b_e) <= EPS {
            continue;
        }
        let base = (positions.len() / 3) as u32;
        let mut push = |p: P, z: f64| positions.extend([p[0], p[1], z]);
        push(start_edge[0], b_s);
        push(start_edge[1], b_s);
        push(end_edge[0], b_e);
        push(end_edge[1], b_e);
        push(start_edge[0], top_h);
        push(start_edge[1], top_h);
        push(end_edge[0], top_h);
        push(end_edge[1], top_h);
        let mut quad = |a: u32, b: u32, c: u32, d: u32| {
            indices.extend([base + a, base + b, base + c, base + a, base + c, base + d])
        };
        quad(0, 1, 3, 2); // Untersicht
        quad(4, 6, 7, 5); // Oberseite
        quad(0, 4, 5, 1); // Startkante
        quad(2, 3, 7, 6); // Endkante
        quad(0, 2, 6, 4); // linke Wange
        quad(1, 5, 7, 3); // rechte Wange
    }
    if !indices.is_empty() {
        out.push(Mesh { src: idx, positions, indices });
    }
}

type V3 = [f64; 3];

/// Schlanker Quader zwischen zwei 3D-Punkten; `None` bei zu kurzem Segment.
fn strut_box(a: V3, b: V3, half: f64) -> Option<(Vec<f64>, Vec<u32>)> {
    let (dx, dy, dz) = (b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    let len = hypot(&[dx, dy, dz]);
    if !(len >= EPS) {
        return None;
    }
    let d = [dx / len, dy / len, dz / len];
    let up_ref: V3 = if d[2].abs() > 0.98 { [1.0, 0.0, 0.0] } else { [0.0, 0.0, 1.0] };
    let mut rx = d[1] * up_ref[2] - d[2] * up_ref[1];
    let mut ry = d[2] * up_ref[0] - d[0] * up_ref[2];
    let mut rz = d[0] * up_ref[1] - d[1] * up_ref[0];
    let rl = or(hypot(&[rx, ry, rz]), 1.0);
    rx /= rl;
    ry /= rl;
    rz /= rl;
    let ux = ry * d[2] - rz * d[1];
    let uy = rz * d[0] - rx * d[2];
    let uz = rx * d[1] - ry * d[0];
    let mut positions = Vec::with_capacity(24);
    for p in [a, b] {
        for (sr, su) in [(-1.0, -1.0), (1.0, -1.0), (1.0, 1.0), (-1.0, 1.0)] {
            positions.push(p[0] + rx * sr * half + ux * su * half);
            positions.push(p[1] + ry * sr * half + uy * su * half);
            positions.push(p[2] + rz * sr * half + uz * su * half);
        }
    }
    let mut indices = Vec::with_capacity(36);
    let mut quad = |a0: u32, b0: u32, c0: u32, d0: u32| indices.extend([a0, b0, c0, a0, c0, d0]);
    quad(0, 1, 2, 3);
    quad(7, 6, 5, 4);
    quad(0, 4, 5, 1);
    quad(1, 5, 6, 2);
    quad(2, 6, 7, 3);
    quad(3, 7, 4, 0);
    Some((positions, indices))
}

/// Handlauf einer Wendeltreppe als Schraubensweep (Quader-Stücke auf der Schraubenlinie) samt
/// Pfosten auf den Trittmitten, in einem Netz je Treppe.
fn spiral_railing(s: &StairIn, idx: usize, out: &mut Vec<Mesh>) {
    let Some((geo, total_rise)) = geometry_of(s) else { return };
    let Some(h) = helix_of(s) else { return };
    let n = geo.treads.len();
    if n == 0 {
        return;
    }
    // Laufrichtung = Drehsinn: links der Laufrichtung liegt bei CCW der Innenrand.
    let ccw = h.sweep > 0.0;
    let sides: &[bool] = match s.railing {
        3 => &[true, false],
        1 => &[true],
        _ => &[false],
    };
    let half = RAIL_THICK / 2.0;
    let mut positions: Vec<f64> = Vec::new();
    let mut indices: Vec<u32> = Vec::new();
    let mut push = |m: Option<(Vec<f64>, Vec<u32>)>| {
        if let Some((p, i)) = m {
            let base = (positions.len() / 3) as u32;
            positions.extend(p);
            indices.extend(i.into_iter().map(|k| k + base));
        }
    };
    let rail_z = |frac: f64| s.z_bottom + frac * total_rise + RAIL_HEIGHT;
    for &left in sides {
        let r = if left == ccw { h.r_in } else { h.r_out };
        let total_seg = n * HELIX_SEGMENTS;
        let pt_at = |k: usize| {
            let f = k as f64 / total_seg as f64;
            let q = h.at(r, h.a0 + f * h.sweep);
            [q[0], q[1], rail_z(f)]
        };
        for k in 0..total_seg {
            push(strut_box(pt_at(k), pt_at(k + 1), half));
        }
        for (i, tr) in geo.treads.iter().enumerate() {
            let f = (i as f64 + 0.5) / n as f64;
            let q = h.at(r, h.a0 + f * h.sweep);
            push(strut_box([q[0], q[1], s.z_bottom + tr.top_rise], [q[0], q[1], rail_z(f)], half));
        }
    }
    if !indices.is_empty() {
        out.push(Mesh { src: idx, positions, indices });
    }
}

fn railings_of(s: &StairIn, idx: usize, out: &mut Vec<Mesh>) {
    if s.railing == 0 {
        return;
    }
    if s.spiral() {
        return spiral_railing(s, idx, out);
    }
    if !s.straight() {
        return;
    }
    let Some((geo, _)) = geometry_of(s) else { return };
    if geo.treads.is_empty() {
        return;
    }
    let sides: &[bool] = match s.railing {
        3 => &[true, false],
        1 => &[true],
        _ => &[false],
    };
    let half = RAIL_THICK / 2.0;
    let mut push = |m: Option<(Vec<f64>, Vec<u32>)>| {
        if let Some((positions, indices)) = m {
            out.push(Mesh { src: idx, positions, indices });
        }
    };
    for &left in sides {
        let (i_start, i_end) = if left { (0, 1) } else { (3, 2) };
        let first = &geo.treads[0];
        let last = &geo.treads[geo.treads.len() - 1];
        if first.pts.len() < 4 || last.pts.len() < 4 {
            continue;
        }
        let start_pt = pt(&first.pts[i_start]);
        let end_pt = pt(&last.pts[i_end]);
        push(strut_box(
            [start_pt[0], start_pt[1], s.z_bottom + RAIL_HEIGHT],
            [end_pt[0], end_pt[1], s.z_top + RAIL_HEIGHT],
            half,
        ));
        let post = |p: P, top_z: f64| strut_box([p[0], p[1], top_z], [p[0], p[1], top_z + RAIL_HEIGHT], half);
        push(post(start_pt, s.z_bottom));
        for tr in &geo.treads {
            if tr.pts.len() < 4 {
                continue;
            }
            push(post(pt(&tr.pts[i_end]), s.z_bottom + tr.top_rise));
        }
    }
}

pub fn slabs(buf: &[f64], for_section: bool) -> Vec<Slab> {
    let mut out = Vec::new();
    let Some(stairs) = decode(buf) else { return out };
    for (i, s) in stairs.iter().enumerate() {
        if let Some(s) = s {
            slabs_of(s, i, for_section, &mut out);
        }
    }
    out
}

pub fn slab_meshes(buf: &[f64]) -> Vec<Mesh> {
    let mut out = Vec::new();
    let Some(stairs) = decode(buf) else { return out };
    for (i, s) in stairs.iter().enumerate() {
        if let Some(s) = s {
            meshes_of(s, i, &mut out);
        }
    }
    out
}

pub fn railings(buf: &[f64]) -> Vec<Mesh> {
    let mut out = Vec::new();
    let Some(stairs) = decode(buf) else { return out };
    for (i, s) in stairs.iter().enumerate() {
        if let Some(s) = s {
            railings_of(s, i, &mut out);
        }
    }
    out
}


#[cfg(test)]
mod tests {
    use super::*;

    /// Eingabe einer geraden Treppe: Start (0,0), Richtung +x, Lauf 3 m, Breite 1 m, 10 Stufen.
    fn straight(structure: f64, railing: f64, closed: f64, nosing: f64) -> Vec<f64> {
        let nan = f64::NAN;
        vec![
            1.0, // eine Treppe
            0.0, 0.0, 0.0, 1.0, 0.0, 3.0, nan, nan, nan, nan, nan, nan, 1.0, 10.0, nan, 0.0, // Parameter
            0.0, 2.8, structure, 0.04, nosing, closed, railing, 0.0,
        ]
    }

    #[test]
    fn massiv_gerade_ein_block_je_tritt() {
        let s = slabs(&straight(0.0, 0.0, 0.0, 0.0), false);
        assert_eq!(s.len(), 10);
        assert!(s.iter().all(|x| x.monolith && x.z_bottom == 0.0 && x.pts.len() == 4));
        // Trittoberkanten steigen um die Steighöhe 0.28 (Index 0 liegt bei 0.28)
        assert!((s[0].z_top - 0.28).abs() < 1e-9 && (s[9].z_top - 2.8).abs() < 1e-9);
    }

    #[test]
    fn offene_tritte_duenn_und_mit_setzstufen() {
        let s = slabs(&straight(2.0, 0.0, 1.0, 0.03), false);
        assert_eq!(s.len(), 20); // je Tritt Platte + Setzstufe
        assert!((s[0].z_top - s[0].z_bottom - 0.04).abs() < 1e-9);
        assert!(!s[0].monolith && !s[1].monolith);
    }

    #[test]
    fn beton_gerade_nur_im_schnitt_als_slabs_sonst_mesh() {
        let b = straight(1.0, 0.0, 0.0, 0.0);
        assert!(slabs(&b, false).is_empty());
        assert!(slabs(&b, true).len() >= 10);
        let m = slab_meshes(&b);
        assert_eq!(m.len(), 1);
        assert_eq!(m[0].positions.len() % 24, 0);
        assert_eq!(m[0].indices.len() / 36, m[0].positions.len() / 24);
        assert!(slab_meshes(&straight(0.0, 0.0, 0.0, 0.0)).is_empty());
    }

    #[test]
    fn gelaender_beide_seiten() {
        let r = railings(&straight(2.0, 3.0, 0.0, 0.0));
        // je Seite 1 Handlauf + 1 Fusspfosten + 10 Pfosten
        assert_eq!(r.len(), 24);
        assert!(r.iter().all(|m| m.positions.len() == 24 && m.indices.len() == 36));
        assert_eq!(railings(&straight(2.0, 1.0, 0.0, 0.0)).len(), 12);
        assert!(railings(&straight(2.0, 0.0, 0.0, 0.0)).is_empty());
    }

    #[test]
    fn unsinn_ohne_panic() {
        let mut bad = straight(0.0, 3.0, 1.0, 0.0);
        bad[1] = f64::NAN;
        assert!(slabs(&bad, false).is_empty());
        assert!(slabs(&[], false).is_empty());
        assert!(slabs(&[5.0, 1.0], true).is_empty());
        assert!(slab_meshes(&[f64::NAN]).is_empty());
        assert!(railings(&[1e300]).is_empty());
        // Steighöhe 0 und unendliche Höhen
        let mut flat = straight(1.0, 3.0, 0.0, 0.0);
        flat[18] = 0.0;
        flat[17] = 0.0;
        assert!(slabs(&flat, true).is_empty() && railings(&flat).is_empty());
        let mut inf = straight(1.0, 3.0, 0.0, 0.0);
        inf[18] = f64::INFINITY;
        assert!(slabs(&inf, true).is_empty() && slab_meshes(&inf).is_empty());
        // Stufenzahl riesig
        let mut huge = straight(0.0, 0.0, 0.0, 0.0);
        huge[14] = 1e12;
        assert!(slabs(&huge, false).is_empty());
    }

    #[test]
    fn l_und_wendel_haben_podest() {
        let nan = f64::NAN;
        let l = vec![
            1.0, 1.0, 0.0, 0.0, 1.0, 0.0, 2.0, 1.5, 1.0, nan, nan, nan, nan, 1.0, 10.0, nan, 0.0, // L
            0.0, 2.8, 0.0, 0.04, 0.0, 0.0, 0.0, 0.0,
        ];
        let s = slabs(&l, false);
        assert!(s.len() >= 10);
        let last = s.last().unwrap();
        assert!((last.z_top - 1.4).abs() < 1e-9 && last.z_bottom == 0.0);
        let w = vec![
            1.0, 2.0, 1.0, 0.0, 1.0, 0.0, 1.0, nan, nan, 0.0, 0.0, 1.5, 270.0, 1.0, 12.0, nan, 0.0, // Wendel
            0.0, 2.8, 2.0, 0.04, 0.0, 0.0, 3.0, 0.0,
        ];
        assert!(!slabs(&w, false).is_empty());
        assert!(!railings(&w).is_empty()); // Wendelgeländer = Schraubensweep
    }

    fn spiral(structure: f64, railing: f64, column: f64) -> Vec<f64> {
        let nan = f64::NAN;
        vec![
            1.0, 2.0, 1.0, 0.0, 1.0, 0.0, 1.0, nan, nan, 0.0, 0.0, 1.5, 270.0, 1.0, 12.0, nan, 0.0, // Wendel
            0.0, 2.8, structure, 0.04, 0.0, 0.0, railing, column,
        ]
    }

    /// Volumen eines geschlossenen Netzes (Divergenzsatz); positiv = Normalen nach aussen.
    fn volume(m: &Mesh) -> f64 {
        let p = |i: u32| [m.positions[3 * i as usize], m.positions[3 * i as usize + 1], m.positions[3 * i as usize + 2]];
        m.indices
            .chunks(3)
            .map(|t| {
                let (a, b, c) = (p(t[0]), p(t[1]), p(t[2]));
                (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6.0
            })
            .sum()
    }

    #[test]
    fn wendel_beton_hat_schraubenfläche() {
        let ms = slab_meshes(&spiral(1.0, 0.0, 0.0));
        assert_eq!(ms.len(), 1);
        let m = &ms[0];
        // Ringsektor 270° (r 1…2) = 7.07 m², mittlere Dicke ≈ Laufplatte + halbe Steigung
        let v = volume(m);
        assert!(v > 1.5 && v < 3.2, "Volumen {v}");
        // Untersicht folgt der Schraube: an jedem Punkt z_unten = z0 + Winkelanteil·Steighöhe − Dicke (oder 0)
        let a0 = 0.0_f64; // Start (1,0) um Zentrum (0,0)
        let waist = concrete_waist(2.8 / 12.0);
        let mut checked = 0;
        for c in m.positions.chunks(3) {
            let ang = c[1].atan2(c[0]).rem_euclid(std::f64::consts::TAU) - a0;
            let f = ang / (270.0_f64).to_radians();
            let on_helix = (0.0..=1.0).contains(&f) && (c[2] - (f * 2.8 - waist).max(0.0)).abs() < 1e-6;
            if on_helix {
                checked += 1;
            }
        }
        assert!(checked > 12 * 2, "zu wenige Punkte auf der Wendelfläche: {checked}");
        // Im Grundriss/3D werden die Tritt-Prismen für Beton nicht doppelt gezeichnet, im Schnitt schon
        assert!(slabs(&spiral(1.0, 0.0, 0.0), false).is_empty());
        assert!(!slabs(&spiral(1.0, 0.0, 0.0), true).is_empty());
        // Drehsinn negativ: Netz bleibt geschlossen/nach aussen orientiert
        let mut cw = spiral(1.0, 0.0, 0.0);
        cw[12] = -270.0;
        assert!(volume(&slab_meshes(&cw)[0]) > 1.5);
    }

    #[test]
    fn wendel_handlauf_ist_schraubensweep() {
        let rs = railings(&spiral(1.0, 1.0, 0.0));
        assert!(!rs.is_empty());
        let zs: Vec<f64> = rs.iter().flat_map(|m| m.positions.chunks(3).map(|c| c[2])).collect();
        let (lo, hi) = (zs.iter().cloned().fold(f64::INFINITY, f64::min), zs.iter().cloned().fold(f64::NEG_INFINITY, f64::max));
        assert!(lo < 0.95 && hi > 2.8 + 0.85, "{lo} {hi}");
        // Handlauf liegt auf einem Kreis (Innenkante r = 1.0 bei Linksgeländer, CCW) — alle Punkte r ≈ 1 ± Querschnitt
        let big = rs.iter().max_by_key(|m| m.indices.len()).unwrap();
        let r: Vec<f64> = big.positions.chunks(3).map(|c| c[0].hypot(c[1])).collect();
        assert!(r.iter().all(|r| (r - 1.0).abs() < 0.05), "Radius streut");
        assert!(big.positions.chunks(3).any(|c| c[2] > 2.0) && big.positions.chunks(3).any(|c| c[2] < 1.2));
    }

    #[test]
    fn wendel_mittelsaeule_als_block() {
        let none = slabs(&spiral(0.0, 0.0, 0.0), false).len();
        let with = slabs(&spiral(0.0, 0.0, 0.12), false);
        assert_eq!(with.len(), none + 1);
        let col = with.last().unwrap();
        assert!(col.z_bottom == 0.0 && (col.z_top - 2.8).abs() < 1e-9 && col.pts.len() >= 12);
        assert!(col.pts.iter().all(|p| (p[0].hypot(p[1]) - 0.12).abs() < 1e-9));
        // auch bei Beton (Grundriss ohne Tritt-Prismen) und nur für Wendel
        assert_eq!(slabs(&spiral(1.0, 0.0, 0.12), false).len(), 1);
    }
}
