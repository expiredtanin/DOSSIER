//! Treppen im 3D (aus `src/plan/toWalls3d/stairs.ts`): Tritt-Prismen und Podeste als Slabs
//! (`slabs`), glatte Ortbeton-Laufplatten (je Lauf) als Mesh (`slab_meshes`), Handlauf und Pfosten
//! als Rohre (`railings`). Die Treppengeometrie selbst kommt aus `kernel2d` (`stair_geometry`); TS sammelt aus
//! dem `Project` nur Parameter, Höhen und Tragart und färbt die Ergebnisse ein.
//!
//! Eingabe (je Treppe 36 Zahlen, davor die Anzahl): die 22 Treppen-Parameter (s. [`crate::stair`]),
//! `zUnten, zOben, tragart (0 massiv, 1 beton, 2 offen: Wange/aufgesattelt/Spindel),
//! trittdicke, nase, geschlosseneSetzstufen (0/1), gelaender (0 keine, 1 links, 2 rechts, 3 beide),
//! saeulenRadius (0 keine; nur Wendel), [T3] handlaufProfil (0 rund, 1 rechteck, 2 flach), handlaufBreite,
//! handlaufHoehe, pfostenProfil, pfostenBreite, pfostenTiefe (fehlend = NaN = Standard)`.
//!
//! Ausgabe Slabs: `[n, (treppe, monolith 0/1, zUnten, zOben, nPkt, x, y …)…]`; Ausgabe Meshes
//! (Laufplatte, Geländer): `[n, (treppe, nPos, nIdx, positionen…, indizes…)…]`. `treppe` ist der
//! Index in der Eingabe. Unsinn (NaN, kaputte Puffer) ergibt ein leeres Ergebnis.

use crate::jsnum::ClampSafe;
use crate::flat_read::Reader;
use crate::jsmath::{hypot, hypot2};
use crate::mesh3d::Mesh;
use crate::stair::decode_params;
use crate::stair_rail::{landings_of, run_ranges, Helix, HELIX_SEGMENTS, RAIL_THICK};
use kernel2d::{stair_geometry, StairGeometry, StairParams};
#[cfg(test)]
use crate::stair_rail::{RAIL_HEIGHT, RAIL_INSET};

type P = [f64; 2];

/// Ignoriere entartete vertikale Ausschnitte (`EPS` in `toWalls3d/shared.ts`).
const EPS: f64 = 1e-4;
/// Laufplattendicke einer stufigen Ortbetontreppe (Meter).
const CONCRETE_WAIST: f64 = 0.18;
/// Max. Stufenhöhe der Soffit-Treppung im Schnitt.
const SOFFIT_SLICE_STEP: f64 = 0.015;

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
    /// [T3] Handlauf- und Pfostenprofil.
    rail: RailSpec,
}

impl StairIn {
    fn spiral(&self) -> bool {
        self.params.shape == "spiral"
    }
    /// Treppe aus geraden Läufen (gerade, L, U, gerade mit Podest).
    fn flights(&self) -> bool {
        matches!(self.params.shape.as_str(), "straight" | "L" | "U" | "straightLanding")
    }
}

fn decode(buf: &[f64]) -> Option<Vec<Option<StairIn>>> {
    let mut r = Reader::new(buf);
    let n = r.count()?;
    let mut out = Vec::with_capacity(n.min(1 << 16));
    for _ in 0..n {
        let mut p = [0.0; crate::stair::PARAMS];
        for v in p.iter_mut() {
            *v = r.num()?;
        }
        let (z_bottom, z_top, structure, tread_thickness, nosing, closed, railing, column) =
            (r.num()?, r.num()?, r.num()?, r.num()?, r.num()?, r.num()?, r.num()?, r.num()?);
        let (rail_profile, rail_w, rail_h, post_profile, post_w, post_d) = (r.num()?, r.num()?, r.num()?, r.num()?, r.num()?, r.num()?);
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
                rail: RailSpec::decode([rail_profile, rail_w, rail_h, post_profile, post_w, post_d]),
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

/// Lauf-/Querparameter eines geraden Laufs (Laufrichtung normiert, Quer = linke Normale).
struct RunAxes {
    start: P,
    u: P,
    w: P,
}

impl RunAxes {
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

/// Achsen eines geraden Laufs aus seinem ersten Tritt (Ecken: links vorn, links hinten, rechts
/// hinten, rechts vorn) und die Lauflänge bis zur Hinterkante des letzten Tritts.
fn run_axes(geo: &StairGeometry, r: &std::ops::Range<usize>) -> Option<(RunAxes, f64)> {
    let first = &geo.treads[r.start].pts;
    let last = &geo.treads[r.end - 1].pts;
    if first.len() < 4 || last.len() < 4 {
        return None;
    }
    let start = [(first[0].x + first[3].x) / 2.0, (first[0].y + first[3].y) / 2.0];
    let (dx, dy) = (first[1].x - first[0].x, first[1].y - first[0].y);
    let l = hypot2(dx, dy);
    if !(l > EPS) {
        return None;
    }
    let u = [dx / l, dy / l];
    let ax = RunAxes { start, u, w: [-u[1], u[0]] };
    let len = ax.run_of([(last[1].x + last[2].x) / 2.0, (last[1].y + last[2].y) / 2.0]);
    (len > EPS).then_some((ax, len))
}

/// Untersicht einer Ortbeton-Laufplatte entlang des Laufs (parallel zur Steigungslinie, Laufplattendicke
/// senkrecht gemessen, nicht unter der Treppen-UK).
fn soffit_fn<'a>(s: &'a StairIn, geo: &'a StairGeometry, r: &std::ops::Range<usize>, len: f64) -> impl Fn(f64) -> f64 + 'a {
    let base = s.z_bottom + geo.treads[r.start].base_rise;
    let lift = geo.treads[r.end - 1].top_rise - geo.treads[r.start].base_rise;
    let waist_v = concrete_waist(geo.riser_height);
    let z_bottom = s.z_bottom;
    move |run_s: f64| z_bottom.max(base + (run_s.max(0.0).min(len) / len) * lift - waist_v)
}

fn slabs_of(s: &StairIn, idx: usize, for_section: bool, coarse: bool, out: &mut Vec<Slab>) {
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
    let riser = geo.riser_height;
    let monolith = structure == MASSIV || structure == BETON;
    // Podeste der Laufformen (die Wendel hat stattdessen ihr Auge, s. unten).
    let landings: Vec<Slab> = if s.flights() {
        landings_of(&geo)
            .into_iter()
            .map(|(pts, top_rise)| {
                let top = z_bottom + top_rise;
                Slab { src: idx, monolith, z_bottom: if structure == BETON { z_bottom.max(top - riser - CONCRETE_WAIST) } else { z_bottom }, z_top: top, pts }
            })
            .collect()
    } else {
        Vec::new()
    };
    // Ortbeton: Läufe als glatte Laufplatten (`meshes_of`), hier nur Podeste und Säule; im Schnitt die
    // Läufe in dünnen Scheiben bis zur Untersicht.
    if structure == BETON && (s.flights() || s.spiral()) && !for_section {
        out.extend(landings);
        out.extend(column);
        return;
    }
    let open = structure != MASSIV;
    let nosing = if open { s.nosing } else { 0.0 };
    let treads: Vec<(Vec<P>, f64, f64)> =
        geo.treads.iter().map(|t| (t.pts.iter().map(pt).collect(), t.top_rise, t.base_rise)).collect();
    let neighbor_pts: Vec<Vec<P>> = treads.iter().map(|t| t.0.clone()).collect();

    if structure == BETON && s.flights() && for_section {
        // Ansicht (`coarse`): ein Block je Tritt bis zur Untersicht an seiner Vorderkante.
        let n = if coarse { 1.0 } else { ((riser / SOFFIT_SLICE_STEP).ceil()).max(1.0) };
        let n_int = n as usize;
        for r in run_ranges(&geo) {
            let Some((ax, len)) = run_axes(&geo, &r) else { continue };
            let soffit = soffit_fn(s, &geo, &r, len);
            for (pts, top_rise, _) in &treads[r] {
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
        }
        out.extend(landings);
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
    out.extend(landings);
    // Wendel: Auge als Block bis zur halben Höhe (bisheriges Verhalten).
    if s.spiral() {
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
    }
    out.extend(column);
}

/// Ecken der Mittelsäule (Vieleck).
const COLUMN_SEGMENTS: usize = 24;

fn helix_of(s: &StairIn) -> Option<Helix> {
    crate::stair_rail::helix_of(&s.params)
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
    if s.structure != BETON || !s.flights() || s.params.run_length <= EPS {
        return;
    }
    let Some((geo, _)) = geometry_of(s) else { return };
    let z_bottom = s.z_bottom;
    // Je Lauf eine Laufplatte (gerade Treppe: eine; L/U/gerade mit Podest: eine je Lauf).
    for r in run_ranges(&geo) {
        let Some((ax, len)) = run_axes(&geo, &r) else { continue };
        let soffit_h = soffit_fn(s, &geo, &r, len);
        let mut positions: Vec<f64> = Vec::new();
        let mut indices: Vec<u32> = Vec::new();
        for tr in &geo.treads[r] {
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
}

type V3 = [f64; 3];

/// Ecken des runden Handlauf-Profils.
const TUBE_SEGMENTS: usize = 12;

/// [T3] Querschnitt eines Handlaufs oder Pfostens: Punkte (quer, hoch) gegen den Uhrzeigersinn um die Achse.
type Section = Vec<[f64; 2]>;

fn round_section(radius: f64) -> Section {
    (0..TUBE_SEGMENTS)
        .map(|k| {
            let a = std::f64::consts::TAU * k as f64 / TUBE_SEGMENTS as f64;
            [crate::jsnum::cos(a) * radius, crate::jsnum::sin(a) * radius]
        })
        .collect()
}

fn rect_section(w: f64, h: f64) -> Section {
    let (a, b) = (w / 2.0, h / 2.0);
    vec![[a, -b], [a, b], [-a, b], [-a, -b]]
}

/// [T3] Profile von Handlauf und Pfosten einer Treppe (Mass in Metern); [`RailSpec::default`] = heutiges Rundrohr.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RailSpec {
    rail: (u8, f64, f64),
    post: (u8, f64, f64),
}

impl Default for RailSpec {
    fn default() -> Self {
        RailSpec { rail: (0, RAIL_THICK, RAIL_THICK), post: (0, RAIL_THICK * 0.75, RAIL_THICK * 0.75) }
    }
}

impl RailSpec {
    /// Aus `[profil, breite, höhe, pfostenProfil, pfostenBreite, pfostenTiefe]`; fehlend/unsinnig = Standard.
    pub fn decode(v: [f64; 6]) -> Self {
        let kind = |x: f64| if x == 1.0 { 1 } else if x == 2.0 { 2 } else { 0 };
        let dim = |x: f64, d: f64| if x.is_finite() && x > 0.0 { x.clamp(0.002, 0.5) } else { d };
        let (rk, pk) = (kind(v[0]), kind(v[3]));
        let rw = dim(v[1], RAIL_THICK);
        let pw = dim(v[4], if pk == 2 { 0.04 } else { RAIL_THICK * 0.75 });
        RailSpec {
            rail: (rk, rw, dim(v[2], if rk == 2 { 0.01 } else { RAIL_THICK })),
            post: (pk, pw, dim(v[5], if pk == 2 { 0.01 } else { RAIL_THICK * 0.75 })),
        }
    }

    /// Dünne Rundrohre für die Ansichtskanten im Schnitt ([`railings_with`]).
    fn thin(half: f64) -> Self {
        RailSpec { rail: (0, half * 2.0, half * 2.0), post: (0, half * 1.5, half * 1.5) }
    }

    fn section((k, w, h): (u8, f64, f64)) -> Section {
        if k == 0 { round_section(w / 2.0) } else { rect_section(w, h) }
    }

    fn rail_section(&self) -> Section {
        Self::section(self.rail)
    }

    fn post_section(&self) -> Section {
        Self::section(self.post)
    }

    fn area((k, w, h): (u8, f64, f64)) -> f64 {
        if k == 0 { std::f64::consts::PI * w * w / 4.0 } else { w * h }
    }

    /// Halbe Handlaufbreite (m): Abstand der Kanten der Doppellinie im Grundriss.
    pub fn rail_half_width(&self) -> f64 {
        self.rail.1 / 2.0
    }

    /// Querschnittsfläche des Handlaufs (m²), für die IFC-Basismengen.
    pub fn rail_area(&self) -> f64 {
        Self::area(self.rail)
    }
}

/// Richtung (waagrecht, Einheit) des Handlaufzugs bei `q`: Segment mit dem kleinsten Grundrissabstand.
fn path_dir(path: &[V3], q: P) -> Option<V3> {
    let mut best: Option<(f64, V3)> = None;
    for w in path.windows(2) {
        let d = [w[1][0] - w[0][0], w[1][1] - w[0][1]];
        let l2 = d[0] * d[0] + d[1] * d[1];
        if !(l2 > 1e-12) {
            continue;
        }
        let t = (((q[0] - w[0][0]) * d[0] + (q[1] - w[0][1]) * d[1]) / l2).clamp(0.0, 1.0);
        let dist = hypot2(w[0][0] + d[0] * t - q[0], w[0][1] + d[1] * t - q[1]);
        if best.map_or(true, |(b, _)| dist < b) {
            let l = l2.sqrt();
            best = Some((dist, [d[0] / l, d[1] / l, 0.0]));
        }
    }
    best.map(|b| b.1)
}

/// Querachse eines eckigen Handlaufprofils: waagrecht quer zum ersten Segment (Breite waagrecht, Höhe senkrecht).
/// Rundprofile brauchen keine (und behalten so ihre Netze bit-genau).
fn rail_across(kind: u8, path: &[V3]) -> Option<V3> {
    if kind == 0 {
        return None;
    }
    let w = path.windows(2).next()?;
    let (dx, dy) = (w[1][0] - w[0][0], w[1][1] - w[0][1]);
    let l = hypot2(dx, dy);
    (l > 1e-9).then(|| [-dy / l, dx / l, 0.0])
}

/// Rohr mit Kreisprofil: [`sweep`] mit rundem Querschnitt.
#[cfg(test)]
fn tube_along(path: &[V3], radius: f64) -> Option<(Vec<f64>, Vec<u32>)> {
    if !(radius > 0.0) {
        return None;
    }
    sweep(path, &round_section(radius), None)
}

/// Körper (beliebiger konvexer Querschnitt `section`) entlang eines Polygonzugs, mit Deckeln; geschlossenes,
/// nach aussen orientiertes Netz. Profil-Ebene je Punkt senkrecht zur gemittelten Tangente; die
/// Profil-Lage wird mitgeführt (Doppelspiegelung, ohne Verdrillen). Die erste Profilachse liegt zu Beginn
/// in `start_normal` (auf die Profil-Ebene projiziert); ohne sie senkrecht (für Rundprofile ohne Belang). `None` bei < 2
/// Punkten oder entarteten (zu kurzen/NaN-) Segmenten.
fn sweep(path: &[V3], section: &Section, start_normal: Option<V3>) -> Option<(Vec<f64>, Vec<u32>)> {
    let n = path.len();
    let m = section.len();
    if n < 2 || m < 3 {
        return None;
    }
    let sub = |a: V3, b: V3| [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    let dot = |a: V3, b: V3| a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    let cross = |a: V3, b: V3| [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    let unit = |a: V3| {
        let l = hypot(&[a[0], a[1], a[2]]);
        (l >= EPS).then(|| [a[0] / l, a[1] / l, a[2] / l])
    };
    let seg: Vec<V3> = path.windows(2).map(|w| unit(sub(w[1], w[0]))).collect::<Option<_>>()?;
    let tangents: Vec<V3> = (0..n)
        .map(|i| match (i.checked_sub(1).map(|k| seg[k]), seg.get(i).copied()) {
            (Some(a), Some(b)) => unit([a[0] + b[0], a[1] + b[1], a[2] + b[2]]).unwrap_or(b),
            (Some(a), None) => a,
            (None, Some(b)) => b,
            (None, None) => [0.0, 0.0, 1.0],
        })
        .collect();
    // [155] Geschlossener Zug (Anfang = Ende): Gehrung an der Naht, keine Deckel.
    let closed = n >= 4 && hypot(&sub(path[0], path[n - 1])) < 1e-9;
    let mut tangents = tangents;
    if closed {
        let (a, b) = (seg[n - 2], seg[0]);
        if let Some(t) = unit([a[0] + b[0], a[1] + b[1], a[2] + b[2]]) {
            tangents[0] = t;
            tangents[n - 1] = t;
        }
    }
    // Start-Normale: quer zur Tangente, möglichst waagrecht.
    let t0 = tangents[0];
    let up: V3 = if t0[2].abs() > 0.98 { [1.0, 0.0, 0.0] } else { [0.0, 0.0, 1.0] };
    let mut normal = unit(cross(cross(t0, up), t0))?;
    if let Some(sn) = start_normal {
        // gewünschte Querachse, senkrecht zur Tangente gestellt
        let d = dot(sn, t0);
        if let Some(u) = unit(sub(sn, t0.map(|x| x * d))) {
            normal = u;
        }
    }
    let mut positions = Vec::with_capacity(3 * (n * m + 2));
    for i in 0..n {
        if i > 0 {
            // Doppelspiegelung (Wang et al. 2008): rotationsminimierende Rahmen.
            let v1 = sub(path[i], path[i - 1]);
            let c1 = dot(v1, v1);
            let r_l = sub(normal, v1.map(|x| x * 2.0 / c1 * dot(v1, normal)));
            let t_l = sub(tangents[i - 1], v1.map(|x| x * 2.0 / c1 * dot(v1, tangents[i - 1])));
            let v2 = sub(tangents[i], t_l);
            let c2 = dot(v2, v2);
            normal = if c2 > 1e-24 { sub(r_l, v2.map(|x| x * 2.0 / c2 * dot(v2, r_l))) } else { r_l };
            normal = unit(normal)?;
        }
        let bi = cross(tangents[i], normal);
        for &[c, s] in section {
            for d in 0..3 {
                positions.push(path[i][d] + normal[d] * c + bi[d] * s);
            }
        }
    }
    for d in 0..3 {
        positions.push(path[0][d]);
    }
    for d in 0..3 {
        positions.push(path[n - 1][d]);
    }
    let m = m as u32;
    let ring = |i: usize, k: u32| i as u32 * m + k % m;
    let (c0, c1) = ((n * section.len()) as u32, (n * section.len()) as u32 + 1);
    let mut indices = Vec::with_capacity(6 * section.len() * n);
    for i in 0..n - 1 {
        for k in 0..m {
            let (a, b, c, d) = (ring(i, k), ring(i, k + 1), ring(i + 1, k + 1), ring(i + 1, k));
            indices.extend([a, b, c, a, c, d]);
        }
    }
    if !closed {
        for k in 0..m {
            indices.extend([c0, ring(0, k + 1), ring(0, k)]);
            indices.extend([c1, ring(n - 1, k), ring(n - 1, k + 1)]);
        }
    }
    Some((positions, indices))
}

/// Handlauf und Pfosten (Rohre) aus der gemeinsamen Handlauf-Achse ([`crate::stair_rail`]): je Gehseite
/// ein durchgehender Rohrzug samt Kropfstücken, runde Pfosten; bei der Wendel alles in einem Netz.
/// Wangendicke (m) und Lage zur Steigungslinie (über / unter der Trittvorderkante).
pub const STRINGER_THICK: f64 = 0.05;
const STRINGER_ABOVE: f64 = 0.05;
const STRINGER_BELOW: f64 = 0.30;

/// [157] Wangen je geradem Lauf (gerade, L, U, gerade mit Podest): ein Brett aussen an jeder Seite der Tritte,
/// Oberkante [`STRINGER_ABOVE`] über der Steigungslinie (Trittvorderkanten), [`STRINGER_BELOW`] darunter, unten
/// auf dem Antritt (Boden bzw. Podest) abgeschnitten, oben waagrecht auf Austrittshöhe. Für den Schnitt
/// (Ansichtskanten); die Eingabe enthält nur die Treppen, die Wangen haben.
pub fn stringers(buf: &[f64]) -> Vec<Mesh> {
    let mut out = Vec::new();
    let Some(stairs) = decode(buf) else { return out };
    for (i, s) in stairs.iter().enumerate() {
        let Some(s) = s.as_ref().filter(|s| s.flights()) else { continue };
        let Some((geo, _)) = geometry_of(s) else { continue };
        for r in run_ranges(&geo) {
            let n = r.len();
            let Some((ax, len)) = run_axes(&geo, &r) else { continue };
            let base = s.z_bottom + geo.treads[r.start].base_rise;
            let lift = geo.treads[r.end - 1].top_rise - geo.treads[r.start].base_rise;
            if n == 0 || !(lift > EPS) {
                continue;
            }
            let (rise, going) = (lift / n as f64, len / n as f64);
            let pitch = |run: f64| base + rise + run * lift / len;
            let top_end = base + lift + STRINGER_ABOVE;
            // Seitenprofil (Lauf, Höhe), gegen den Uhrzeigersinn.
            let rf = ((STRINGER_BELOW - rise) * len / lift).clamp_safe(0.0, len);
            let prof = [(0.0, base), (rf, base), (len, pitch(len) - STRINGER_BELOW), (len, top_end), (len - going, top_end), (0.0, pitch(0.0) + STRINGER_ABOVE)];
            let sides: Vec<f64> = geo.treads[r.clone()].iter().flat_map(|t| t.pts.iter().map(|q| ax.side_of(pt(q)))).collect();
            let (lo, hi) = sides.iter().fold((f64::INFINITY, f64::NEG_INFINITY), |(a, b), &x| (a.min(x), b.max(x)));
            if !(hi - lo > EPS) {
                continue;
            }
            for (w0, w1) in [(hi, hi + STRINGER_THICK), (lo - STRINGER_THICK, lo)] {
                let at = |run: f64, w: f64, z: f64| [ax.start[0] + ax.u[0] * run + ax.w[0] * w, ax.start[1] + ax.u[1] * run + ax.w[1] * w, z];
                let mut positions: Vec<f64> = Vec::new();
                for w in [w0, w1] {
                    for &(run, z) in &prof {
                        positions.extend(at(run, w, z));
                    }
                }
                let k = prof.len() as u32;
                let mut indices: Vec<u32> = Vec::new();
                for j in 1..k - 1 {
                    indices.extend([0, j + 1, j]); // Seite w0
                    indices.extend([k, k + j, k + j + 1]); // Seite w1
                }
                for j in 0..k {
                    let j1 = (j + 1) % k;
                    indices.extend([j, j1, k + j1, j, k + j1, k + j]);
                }
                let mut mesh = Mesh { src: i, positions, indices };
                if signed_volume(&mesh) < 0.0 {
                    for t in mesh.indices.chunks_mut(3) {
                        t.swap(1, 2);
                    }
                }
                out.push(mesh);
            }
        }
    }
    out
}

fn railings_of(s: &StairIn, idx: usize, thin: Option<f64>, out: &mut Vec<Mesh>) {
    if s.railing == 0 {
        return;
    }
    let Some((geo, _)) = geometry_of(s) else { return };
    let z0 = s.z_bottom;
    let spec = thin.map_or(s.rail, RailSpec::thin);
    let (rail_sec, post_sec) = (spec.rail_section(), spec.post_section());
    let mut tubes: Vec<(Vec<f64>, Vec<u32>)> = Vec::new();
    for rail in crate::stair_rail::rails(&s.params, &geo, s.railing) {
        let path: Vec<V3> = rail.path.iter().map(|q| [q[0], q[1], q[2] + z0]).collect();
        tubes.extend(sweep(&path, &rail_sec, rail_across(spec.rail.0, &path)));
        for (p, z) in &rail.posts {
            tubes.extend(sweep(&[[p[0], p[1], z0 + z], [p[0], p[1], z0 + z + crate::stair_rail::RAIL_HEIGHT]], &post_sec, path_dir(&path, *p)));
        }
    }
    if s.spiral() {
        let mut positions: Vec<f64> = Vec::new();
        let mut indices: Vec<u32> = Vec::new();
        for (p, i) in tubes {
            let base = (positions.len() / 3) as u32;
            positions.extend(p);
            indices.extend(i.into_iter().map(|k| k + base));
        }
        if !indices.is_empty() {
            out.push(Mesh { src: idx, positions, indices });
        }
    } else {
        out.extend(tubes.into_iter().map(|(positions, indices)| Mesh { src: idx, positions, indices }));
    }
}

pub fn slabs(buf: &[f64], for_section: bool) -> Vec<Slab> {
    slabs_with(buf, for_section, false)
}

/// [151] Für die Ansicht: wie im Schnitt, Ortbeton-Läufe aber als ein Block je Tritt (Untersicht gestuft).
pub fn slabs_coarse(buf: &[f64]) -> Vec<Slab> {
    slabs_with(buf, true, true)
}

fn slabs_with(buf: &[f64], for_section: bool, coarse: bool) -> Vec<Slab> {
    let mut out = Vec::new();
    let Some(stairs) = decode(buf) else { return out };
    for (i, s) in stairs.iter().enumerate() {
        if let Some(s) = s {
            slabs_of(s, i, for_section, coarse, &mut out);
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
    railings_in(buf, None)
}

/// [157] Wie [`railings`] mit Rohr-Halbmesser `half` (Schnitt: dünn, damit Handlauf und Pfosten als je eine
/// Linie erscheinen statt als Doppellinie im Rohrabstand).
pub fn railings_with(buf: &[f64], half: f64) -> Vec<Mesh> {
    railings_in(buf, Some(half))
}

/// `thin`: Rohr-Halbmesser statt des Profils der Treppe ([`railings_with`]).
fn railings_in(buf: &[f64], thin: Option<f64>) -> Vec<Mesh> {
    let mut out = Vec::new();
    let Some(stairs) = decode(buf) else { return out };
    for (i, s) in stairs.iter().enumerate() {
        if let Some(s) = s {
            railings_of(s, i, thin, &mut out);
        }
    }
    out
}

/// Stababstand der Füllung der Absturzsicherung (lichtes Mass ≤ 12 cm) und Pfostenabstand.
const GUARD_BALUSTER_GAP: f64 = 0.11;
const GUARD_POST_GAP: f64 = 1.2;

/// [155] Körper der Absturzsicherung am Deckenloch über den Achsen aus [`crate::stair_guard`] (Standhöhe `z`):
/// Pfosten an den Ecken und im Abstand, Handlauf in [`crate::stair_rail::RAIL_HEIGHT`], Stäbe als Füllung —
/// dieselben Rohrquerschnitte wie das Treppengeländer. Ein Netz (Quelle `src`), leer ohne Achsen.
pub fn guard_mesh(axes: &[Vec<P>], z: f64, src: usize, spec: &RailSpec) -> Option<Mesh> {
    let h = crate::stair_rail::RAIL_HEIGHT;
    let half = RAIL_THICK / 2.0;
    let (rail_sec, post_sec) = (spec.rail_section(), spec.post_section());
    let mut tubes: Vec<(Vec<f64>, Vec<u32>)> = Vec::new();
    for axis in axes {
        if axis.len() < 2 || axis.iter().any(|q| !q[0].is_finite() || !q[1].is_finite()) {
            continue;
        }
        let top: Vec<V3> = axis.iter().map(|q| [q[0], q[1], z + h]).collect();
        tubes.extend(sweep(&top, &rail_sec, rail_across(spec.rail.0, &top)));
        let post_at = |q: P, sec: &Section, dir: Option<V3>, z1: f64, tubes: &mut Vec<(Vec<f64>, Vec<u32>)>| tubes.extend(sweep(&[[q[0], q[1], z], [q[0], q[1], z1]], sec, dir));
        let bal_sec = round_section(0.006);
        for (i, w) in axis.windows(2).enumerate() {
            let len = hypot2(w[1][0] - w[0][0], w[1][1] - w[0][1]);
            if len < EPS {
                continue;
            }
            let at = |t: f64| [w[0][0] + (w[1][0] - w[0][0]) * t, w[0][1] + (w[1][1] - w[0][1]) * t];
            let dir = Some([(w[1][0] - w[0][0]) / len, (w[1][1] - w[0][1]) / len, 0.0]);
            let n_post = (len / GUARD_POST_GAP).ceil().max(1.0) as usize;
            for k in 0..n_post + usize::from(i + 2 == axis.len() && !crate::stair_rail::is_closed(axis)) {
                post_at(at(k as f64 / n_post as f64), &post_sec, dir, z + h, &mut tubes);
            }
            let n_bal = (len / GUARD_BALUSTER_GAP).round().max(1.0) as usize;
            for k in 1..n_bal {
                let t = k as f64 / n_bal as f64;
                if (t * n_post as f64).fract().min(1.0 - (t * n_post as f64).fract()) * len / n_post as f64 > 0.04 {
                    post_at(at(t), &bal_sec, None, z + h - half, &mut tubes);
                }
            }
        }
    }
    let mut positions: Vec<f64> = Vec::new();
    let mut indices: Vec<u32> = Vec::new();
    for (p, i) in tubes {
        let base = (positions.len() / 3) as u32;
        positions.extend(p);
        indices.extend(i.into_iter().map(|k| k + base));
    }
    (!indices.is_empty()).then_some(Mesh { src, positions, indices })
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
            nan, nan, nan, nan, nan, nan,
            0.0, 2.8, structure, 0.04, nosing, closed, railing, 0.0, f64::NAN, f64::NAN, f64::NAN, f64::NAN, f64::NAN, f64::NAN,
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
        assert!(r.iter().all(|m| m.positions.len() == 3 * (2 * TUBE_SEGMENTS + 2)));
        assert_eq!(railings(&straight(2.0, 1.0, 0.0, 0.0)).len(), 12);
        assert!(railings(&straight(2.0, 0.0, 0.0, 0.0)).is_empty());
    }

    /// L-Treppe: Start (0,0), +x, Lauf 2 m, Lauf2 1.5 m, Wendung `turn`, Breite 1 m, 10 Stufen.
    fn l_stair(turn: f64, railing: f64) -> Vec<f64> {
        let nan = f64::NAN;
        vec![
            1.0, 1.0, 0.0, 0.0, 1.0, 0.0, 2.0, 1.5, turn, nan, nan, nan, nan, 1.0, 10.0, nan, 0.0,
            nan, nan, nan, nan, nan, nan,
            0.0, 2.8, 0.0, 0.04, 0.0, 0.0, railing, 0.0, f64::NAN, f64::NAN, f64::NAN, f64::NAN, f64::NAN, f64::NAN,
        ]
    }

    fn bbox_z(m: &Mesh) -> (f64, f64) {
        let zs: Vec<f64> = m.positions.chunks(3).map(|p| p[2]).collect();
        (zs.iter().cloned().fold(f64::INFINITY, f64::min), zs.iter().cloned().fold(f64::NEG_INFINITY, f64::max))
    }

    #[test]
    fn l_gelaender_seiten_und_hoehe() {
        for turn in [1.0, -1.0] {
            assert!(railings(&l_stair(turn, 0.0)).is_empty());
            let one = railings(&l_stair(turn, 1.0));
            let two = railings(&l_stair(turn, 2.0));
            let both = railings(&l_stair(turn, 3.0));
            assert!(!one.is_empty() && !two.is_empty());
            assert_eq!(both.len(), one.len() + two.len());
            // Handlauf = erstes Netz je Seite: durchgehend vom Anfang (0.9) bis zum Ende (2.8 + 0.9)
            let (lo, hi) = bbox_z(&one[0]);
            assert!(lo > 0.9 - 0.03 && lo < 0.9 + 0.03, "{lo}");
            assert!((hi - (2.8 + 0.9)).abs() < 0.03, "{hi}");
            // Pfosten: Länge = Handlaufhöhe über Trittoberkante
            for m in &one[1..] {
                let (a, b) = bbox_z(m);
                assert!((b - a - RAIL_HEIGHT).abs() < 1e-9);
            }
        }
    }

    #[test]
    fn l_handlauf_durchgehend_und_ueber_podest_eben() {
        let buf = l_stair(1.0, 2.0); // rechts = Aussenseite bei Linkswendung
        let stairs = decode(&buf).unwrap();
        let s = stairs[0].as_ref().unwrap();
        let (geo, _) = geometry_of(s).unwrap();
        let mut out = Vec::new();
        railings_of(s, 0, None, &mut out);
        let rail = &out[0];
        // Podesthöhe: Oberkante Podest + 0.9 kommt als Ebene im Handlauf vor
        let z_land = geo.treads.iter().find(|t| t.index > 2).unwrap().base_rise + RAIL_HEIGHT;
        let (lo, hi) = bbox_z(rail);
        assert!(lo < z_land && hi > z_land);
        // Rohr verbindet sich lückenlos: jeder Ring liegt dicht am nächsten
        let pos = &rail.positions;
        let ring = 3 * TUBE_SEGMENTS;
        let n = (pos.len() / 3 - 2) / TUBE_SEGMENTS;
        let c = |i: usize| {
            let (mut x, mut y, mut z) = (0.0, 0.0, 0.0);
            for k in 0..TUBE_SEGMENTS {
                x += pos[i * ring + 3 * k];
                y += pos[i * ring + 3 * k + 1];
                z += pos[i * ring + 3 * k + 2];
            }
            let m = TUBE_SEGMENTS as f64;
            [x / m, y / m, z / m]
        };
        for i in 1..n {
            let (a, b) = (c(i - 1), c(i));
            let d = ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2) + (a[2] - b[2]).powi(2)).sqrt();
            assert!(d > 1e-6 && d < 2.5, "Lücke {d}");
        }
        // Handlaufhöhe über Nase: Tritt 3 (Lauf 1, Index 2) Vorderkante rechts
        let t = &geo.treads[2];
        let (px, py) = (t.pts[2].x, t.pts[2].y);
        let zt = t.top_rise + RAIL_HEIGHT;
        let (p0, p1) = (c(0), c(1));
        let f = (px - p0[0]) / (p1[0] - p0[0]);
        // rechte Seite, um RAIL_INSET nach innen (+y)
        assert!((p0[1] - (py + RAIL_INSET)).abs() < 1e-6 && (0.0..=1.0).contains(&f));
        let z_line = p0[2] + f * (p1[2] - p0[2]);
        assert!((z_line - zt).abs() < 0.03, "Handlauf nicht 0.9 über der Nase: {z_line} vs {zt}");
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
        flat[24] = 0.0;
        flat[23] = 0.0;
        assert!(slabs(&flat, true).is_empty() && railings(&flat).is_empty());
        let mut inf = straight(1.0, 3.0, 0.0, 0.0);
        inf[24] = f64::INFINITY;
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
            nan, nan, nan, nan, nan, nan,
            0.0, 2.8, 0.0, 0.04, 0.0, 0.0, 0.0, 0.0, f64::NAN, f64::NAN, f64::NAN, f64::NAN, f64::NAN, f64::NAN,
        ];
        let s = slabs(&l, false);
        assert!(s.len() >= 10);
        // [151] Podest auf der Antrittshöhe von Lauf 2: 9 Steigungen ohne Podest, Lauf 1 = round(9·2/3.5) = 5,
        // Podest = 6. Steigung (vorher fälschlich halbe Steighöhe 1.4)
        let last = s.last().unwrap();
        assert!((last.z_top - 6.0 * 0.28).abs() < 1e-9 && last.z_bottom == 0.0, "{}", last.z_top);
        let w = vec![
            1.0, 2.0, 1.0, 0.0, 1.0, 0.0, 1.0, nan, nan, 0.0, 0.0, 1.5, 270.0, 1.0, 12.0, nan, 0.0, // Wendel
            nan, nan, nan, nan, nan, nan,
            0.0, 2.8, 2.0, 0.04, 0.0, 0.0, 3.0, 0.0, f64::NAN, f64::NAN, f64::NAN, f64::NAN, f64::NAN, f64::NAN,
        ];
        assert!(!slabs(&w, false).is_empty());
        assert!(!railings(&w).is_empty()); // Wendelgeländer = Schraubensweep
    }

    fn spiral(structure: f64, railing: f64, column: f64) -> Vec<f64> {
        let nan = f64::NAN;
        vec![
            1.0, 2.0, 1.0, 0.0, 1.0, 0.0, 1.0, nan, nan, 0.0, 0.0, 1.5, 270.0, 1.0, 12.0, nan, 0.0, // Wendel
            nan, nan, nan, nan, nan, nan,
            0.0, 2.8, structure, 0.04, 0.0, 0.0, railing, column, f64::NAN, f64::NAN, f64::NAN, f64::NAN, f64::NAN, f64::NAN,
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
        // Handlauf liegt auf einem Kreis (Innenkante r = 1.0 + RAIL_INSET bei Linksgeländer, CCW) — alle
        // Punkte r ≈ 1.04 ± Querschnitt
        let big = rs.iter().max_by_key(|m| m.indices.len()).unwrap();
        let r: Vec<f64> = big.positions.chunks(3).map(|c| c[0].hypot(c[1])).collect();
        assert!(r.iter().all(|r| (r - 1.0 - RAIL_INSET).abs() < 0.05), "Radius streut");
        assert!(big.positions.chunks(3).any(|c| c[2] > 2.0) && big.positions.chunks(3).any(|c| c[2] < 1.2));
    }

    #[test]
    fn gerade_treppe_handlauf_rund() {
        // Handlauf + Pfosten sind Rohre (Profil mit TUBE_SEGMENTS Ecken, positives Volumen), keine Quader
        let rs = railings(&straight(2.0, 1.0, 0.0, 0.0));
        assert!(!rs.is_empty());
        for m in &rs {
            assert!(volume(m) > 0.0);
            assert_eq!(m.positions.len() / 3, 2 * TUBE_SEGMENTS + 2, "Rohr mit 2 Ringen + 2 Deckelmitten");
        }
    }

    #[test]
    fn rohr_ist_rund_geschlossen_und_aussen_orientiert() {
        // Schraubenlinie r = 1, Steigung 1 m je Umdrehung
        let path: Vec<V3> = (0..=48).map(|k| {
            let a = std::f64::consts::TAU * k as f64 / 48.0;
            [a.cos(), a.sin(), a / std::f64::consts::TAU]
        }).collect();
        let (positions, indices) = tube_along(&path, 0.02).unwrap();
        // jeder Profilpunkt liegt genau im Rohrradius um seinen Bahnpunkt
        for (i, c) in positions.chunks(3).take(path.len() * TUBE_SEGMENTS).enumerate() {
            let q = path[i / TUBE_SEGMENTS];
            assert!((hypot(&[c[0] - q[0], c[1] - q[1], c[2] - q[2]]) - 0.02).abs() < 1e-12);
        }
        let len: f64 = path.windows(2).map(|w| hypot(&[w[1][0] - w[0][0], w[1][1] - w[0][1], w[1][2] - w[0][2]])).sum();
        let v = volume(&Mesh { src: 0, positions, indices });
        // Polygon-Querschnitt (12 Ecken) ≈ 95.5 % des Kreises
        let ideal = std::f64::consts::PI * 0.02 * 0.02 * len;
        assert!(v > 0.9 * ideal && v < 1.01 * ideal, "Volumen {v} vs. {ideal}");
        assert!(tube_along(&[[0.0; 3]], 0.02).is_none());
        assert!(tube_along(&[[0.0; 3], [0.0; 3]], 0.02).is_none());
        assert!(tube_along(&[[0.0; 3], [f64::NAN, 0.0, 0.0]], 0.02).is_none());
    }

    #[test]
    fn wendel_handlauf_rund() {
        let rs = railings(&spiral(0.0, 1.0, 0.0));
        let m = &rs[0];
        // Netz geschlossen und nach aussen (Rohr + Pfosten, alle positiv)
        assert!(volume(m) > 0.0);
        // Querschnitt rund: Punkte des Handlaufs (oberhalb aller Pfosten-Fusspunkte im Mittelteil) streuen
        // im Abstand zur Schraubenachse r = 1 um ± Rohrradius, auch schräg (nicht nur Quaderecken).
        let near: Vec<f64> = m.positions.chunks(3).map(|c| c[0].hypot(c[1]) - 1.0 - RAIL_INSET).collect();
        let distinct = {
            let mut v: Vec<i64> = near.iter().map(|d| (d * 1e5).round() as i64).collect();
            v.sort();
            v.dedup();
            v.len()
        };
        assert!(distinct > 8, "nur {distinct} verschiedene Radien: Profil nicht rund");
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

    /// [151] U-Treppe: Start (0,0), +x, Läufe je 2.5 m, Linkswendung, Breite 1 m, Auge 0.2, 17 Steigungen
    /// (Steighöhe 2.89), optional Mittellauf.
    fn u_stair(structure: f64, railing: f64, mid: f64) -> Vec<f64> {
        let nan = f64::NAN;
        vec![
            1.0, 3.0, 0.0, 0.0, 1.0, 0.0, 2.5, 2.5, 1.0, nan, nan, nan, nan, 1.0, 17.0, nan, 0.0,
            0.2, nan, nan, mid, nan, nan,
            0.0, 2.89, structure, 0.04, 0.0, 0.0, railing, 0.0, f64::NAN, f64::NAN, f64::NAN, f64::NAN, f64::NAN, f64::NAN,
        ]
    }

    /// Ringmitten eines Rohrs (je Profilring).
    fn tube_centers(m: &Mesh) -> Vec<V3> {
        let pos = &m.positions;
        let ring = 3 * TUBE_SEGMENTS;
        let n = (pos.len() / 3 - 2) / TUBE_SEGMENTS;
        (0..n)
            .map(|i| {
                let (mut x, mut y, mut z) = (0.0, 0.0, 0.0);
                for k in 0..TUBE_SEGMENTS {
                    x += pos[i * ring + 3 * k];
                    y += pos[i * ring + 3 * k + 1];
                    z += pos[i * ring + 3 * k + 2];
                }
                let m = TUBE_SEGMENTS as f64;
                [x / m, y / m, z / m]
            })
            .collect()
    }

    #[test]
    fn u_massiv_stufen_steigung_und_podesthoehe() {
        let s = slabs(&u_stair(0.0, 0.0, f64::NAN), false);
        assert_eq!(s.len(), 16 + 1); // 17 Steigungen − Podest = 16 Tritte, dazu das Podest
        let h = 2.89 / 17.0;
        let mut tops: Vec<f64> = s.iter().map(|x| x.z_top).collect();
        tops.sort_by(f64::total_cmp);
        // jede Oberkante eine Steigung über der vorigen (Podest = 9. Steigung), letzte = Geschoss oben
        for (k, z) in tops.iter().enumerate() {
            assert!((z - (k + 1) as f64 * h).abs() < 1e-9, "{k}: {z}");
        }
        let land = s.last().unwrap();
        assert!((land.z_top - 9.0 * h).abs() < 1e-9 && land.pts.len() == 4);
        // Podest über beide Läufe und das Auge: 1 m tief, 2.2 m breit
        let area: f64 = (0..4).map(|i| {
            let (a, b) = (land.pts[i], land.pts[(i + 1) % 4]);
            a[0] * b[1] - b[0] * a[1]
        }).sum::<f64>() / 2.0;
        assert!((area.abs() - 2.2).abs() < 1e-9, "{area}");
        // Mittellauf: zwei Podeste (Antrittshöhe des folgenden Laufs)
        let m = slabs(&u_stair(0.0, 0.0, 2.0), false);
        assert_eq!(m.len(), 15 + 2);
        let lands: Vec<&Slab> = m.iter().filter(|x| x.pts.len() == 4 && (x.pts[0][0] - x.pts[1][0]).abs() + (x.pts[0][1] - x.pts[1][1]).abs() > 0.0).filter(|x| x.z_top > 0.0).collect();
        assert!(lands.len() >= 2);
    }

    #[test]
    fn u_beton_laufplatten_je_lauf_mit_volumen() {
        let b = u_stair(1.0, 0.0, f64::NAN);
        let m = slab_meshes(&b);
        assert_eq!(m.len(), 2, "eine Laufplatte je Lauf");
        // Grundriss/3D: nur das Podest als Platte; im Schnitt Scheiben bis zur Untersicht + Podest
        let s = slabs(&b, false);
        assert_eq!(s.len(), 1);
        assert!(slabs(&b, true).len() > 16);
        // Lauf 2 (8 Tritte à 2.5/8, Steigung h, Laufplatte senkrecht w): Volumen = n·a·(h/2 + w)·Breite
        let h = 2.89 / 17.0;
        let w = concrete_waist(h);
        let v2 = volume(&m[1]);
        assert!((v2 - 2.5 * (h / 2.0 + w)).abs() < 1e-6, "{v2}");
        // Lauf 1 knapp weniger (Untersicht am Antritt auf die UK gekappt)
        let v1 = volume(&m[0]);
        assert!(v1 > 0.0 && v1 < v2, "{v1} {v2}");
        // Podestplatte unter der Podest-Oberkante: Steigung + Plattenstärke
        assert!((s[0].z_top - 9.0 * h).abs() < 1e-9 && (s[0].z_top - s[0].z_bottom - h - CONCRETE_WAIST).abs() < 1e-9);
    }

    #[test]
    fn u_gelaender_um_das_auge_lueckenlos() {
        for mid in [f64::NAN, 2.0] {
            let both = railings(&u_stair(2.0, 3.0, mid));
            let left = railings(&u_stair(2.0, 1.0, mid));
            let right = railings(&u_stair(2.0, 2.0, mid));
            assert_eq!(both.len(), left.len() + right.len());
            for (rail, inner) in [(&left[0], true), (&right[0], false)] {
                let c = tube_centers(rail);
                for w in c.windows(2) {
                    let d = ((w[0][0] - w[1][0]).powi(2) + (w[0][1] - w[1][1]).powi(2) + (w[0][2] - w[1][2]).powi(2)).sqrt();
                    assert!(d > 1e-6 && d < 3.0, "Lücke {d}");
                }
                // Anfang 0.9 über dem Antritt, Ende 0.9 über der Austrittskante, beide auf der Laufseite
                assert!((c[0][2] - 0.9).abs() < 1e-9 && (c[c.len() - 1][2] - (2.89 + 0.9)).abs() < 1e-9);
                assert!(c[0][0].abs() < 1e-9 && c[c.len() - 1][0].abs() < 1e-9);
                let i = RAIL_INSET;
                if inner {
                    // links = Innenseite (Linkswendung): Handlauf quert das Auge (y 0.5 … 0.7) am Podestrand,
                    // um RAIL_INSET nach innen (Ecken 2.54/0.46 und 2.54/0.74)
                    assert!(c.iter().all(|p| p[0] <= 2.5 + i + 1e-9 || mid.is_finite()));
                    assert!(c.iter().any(|p| (p[1] - 0.5 + i).abs() < 1e-9) && c.iter().any(|p| (p[1] - 0.7 - i).abs() < 1e-9));
                } else {
                    // rechts = Aussenseite: über die äusseren Podestecken (x = 3.5, y = −0.5 und 1.7), versetzt
                    assert!(c.iter().any(|p| (p[0] - 3.5 + i).abs() < 1e-9 && (p[1] + 0.5 - i).abs() < 1e-9));
                    assert!(c.iter().any(|p| (p[0] - 3.5 + i).abs() < 1e-9 && (p[1] - 1.7 + i).abs() < 1e-9));
                }
            }
        }
    }

    #[test]
    fn gerade_mit_podest_massiv_und_beton() {
        let nan = f64::NAN;
        let b = |structure: f64| {
            vec![
                1.0, 4.0, 0.0, 0.0, 1.0, 0.0, 2.0, 2.0, nan, nan, nan, nan, nan, 1.0, 16.0, nan, 0.0,
                nan, 1.2, 8.0, nan, nan, nan,
                0.0, 2.8, structure, 0.04, 0.0, 0.0, 3.0, 0.0, f64::NAN, f64::NAN, f64::NAN, f64::NAN, f64::NAN, f64::NAN,
            ]
        };
        let s = slabs(&b(0.0), false);
        assert_eq!(s.len(), 15 + 1);
        let land = s.last().unwrap();
        assert!((land.z_top - 9.0 * 0.175).abs() < 1e-9);
        assert!(land.pts.iter().all(|p| (p[0] - 2.0).abs() < 1e-9 || (p[0] - 3.2).abs() < 1e-9));
        assert_eq!(slab_meshes(&b(1.0)).len(), 2);
        let r = railings(&b(0.0));
        assert!(!r.is_empty());
        let c = tube_centers(&r[0]);
        assert!((c[c.len() - 1][0] - 5.2).abs() < 1e-9 && (c[c.len() - 1][2] - 3.7).abs() < 1e-9);
    }

    /// [T3] Ohne Angabe: Standard-Rundrohr; Rechteck/Flachstahl: vier Ecken je Querschnitt, Mass wie angegeben.
    #[test]
    fn handlauf_profile() {
        assert_eq!(RailSpec::decode([f64::NAN; 6]), RailSpec::default());
        assert!((RailSpec::default().rail_area() - std::f64::consts::PI * 0.02 * 0.02).abs() < 1e-12);
        // Rechteck 6 × 2 cm entlang x: y-Spanne = Breite, z-Spanne = Höhe (Querachse waagrecht).
        let path: Vec<V3> = vec![[0.0, 0.0, 1.0], [2.0, 0.0, 1.0]];
        let (pos, idx) = sweep(&path, &rect_section(0.06, 0.02), rail_across(1, &path)).unwrap();
        assert_eq!(pos.len(), 3 * (2 * 4 + 2));
        let span = |d: usize| {
            let v: Vec<f64> = pos.chunks(3).take(8).map(|q| q[d]).collect();
            v.iter().cloned().fold(f64::MIN, f64::max) - v.iter().cloned().fold(f64::MAX, f64::min)
        };
        assert!((span(1) - 0.06).abs() < 1e-9 && (span(2) - 0.02).abs() < 1e-9, "{} {}", span(1), span(2));
        assert_eq!(idx.len(), 3 * (2 * 4 + 2 * 4)); // vier Seitenflächen (je 2 Dreiecke) + Deckel
        // nach aussen orientiert (positives Volumen)
        let m = Mesh { src: 0, positions: pos, indices: idx };
        assert!(signed_volume(&m) > 0.0);
        // Treppe: Rechteck-Handlauf hat weniger Ecken als das Rundrohr, das Profil wirkt auch auf den Pfosten
        let mut round = straight(2.0, 1.0, 0.0, 0.0);
        let r0 = railings(&round);
        let n = round.len();
        round[n - 6..].copy_from_slice(&[1.0, 0.06, 0.03, 1.0, 0.05, 0.02]);
        let r1 = railings(&round);
        assert_eq!(r0.len(), r1.len());
        assert!(r1[0].positions.len() < r0[0].positions.len());
        assert!(r1.iter().skip(1).all(|m| m.positions.len() == 3 * (2 * 4 + 2)), "Pfosten vierkant");
        // Ansichtskanten im Schnitt bleiben dünne Rundrohre
        assert_eq!(railings_with(&round, 0.004)[0].positions.len(), railings_with(&straight(2.0, 1.0, 0.0, 0.0), 0.004)[0].positions.len());
    }

    /// [T3] Absturzsicherung nimmt das Profil der Treppe; Pfosten stehen mit der Breite in Richtung des Handlaufs.
    #[test]
    fn absturzsicherung_profil() {
        let axes = vec![vec![[0.0, 0.0], [2.0, 0.0]]];
        let round = guard_mesh(&axes, 0.0, 0, &RailSpec::default()).unwrap();
        let spec = RailSpec::decode([1.0, 0.05, 0.03, 2.0, 0.04, 0.01]);
        let flat = guard_mesh(&axes, 0.0, 0, &spec).unwrap();
        assert!(flat.positions.len() < round.positions.len());
        // erster Pfosten (nach dem Handlauf): x-Spanne 4 cm (Breite), y-Spanne 1 cm (Dicke)
        let first = &flat.positions[3 * (2 * 4 + 2)..3 * (2 * 4 + 2) + 3 * 8];
        let span = |d: usize| {
            let v: Vec<f64> = first.chunks(3).map(|q| q[d]).collect();
            v.iter().cloned().fold(f64::MIN, f64::max) - v.iter().cloned().fold(f64::MAX, f64::min)
        };
        assert!((span(0) - 0.04).abs() < 1e-9 && (span(1) - 0.01).abs() < 1e-9, "{} {}", span(0), span(1));
    }

    /// [155] Geschlossener Zug (freier Lochring): ohne Deckel, Naht ohne Lücke.
    #[test]
    fn geschlossener_zug_ohne_deckel() {
        let path: Vec<V3> = vec![[0.0, 0.0, 1.0], [1.0, 0.0, 1.0], [1.0, 1.0, 1.0], [0.0, 1.0, 1.0], [0.0, 0.0, 1.0]];
        let (pos, idx) = sweep(&path, &round_section(0.02), None).unwrap();
        assert_eq!(idx.len(), 6 * TUBE_SEGMENTS * 4, "nur Mantel");
        // erster und letzter Ring fallen zusammen
        let m = TUBE_SEGMENTS * 3;
        for k in 0..m {
            assert!((pos[k] - pos[4 * m + k]).abs() < 1e-9, "{k}");
        }
        // offener Zug behält die Deckel
        assert_eq!(sweep(&path[..4], &round_section(0.02), None).unwrap().1.len(), 6 * TUBE_SEGMENTS * 3 + 6 * TUBE_SEGMENTS);
    }
}
