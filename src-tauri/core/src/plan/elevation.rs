//! Ansicht auf dem Dokument ([K3c]): Rust-Gegenstück zu `src/plan/toElevation.ts` (Orchestrierung,
//! Stil, Painter-Reihenfolge). Die Geometrie (Flächen, Eck-Verlängerung, Öffnungen, Verdeckung,
//! Schatten, XOR-Umriss) rechnet `plan_elevation.rs`; hier werden sie aus dem Dokument gespeist,
//! gestylt, mit Pick-Ids versehen und fern → nah sortiert. Zahlsemantik wie in TS.

use super::prim::Primitive;
use super::section::{line, polygon, v2, Acc, LevelSpec, Visibility};
use super::style::no_hatch;
use crate::js_fmt::js_number;
use crate::jsmath::{hypot, hypot2};
use crate::jsnum::{max, min, round};
use crate::model::*;
use crate::model3d::{self, RSlab, RWall};
use crate::plan::overrides::js_trim;
use std::collections::HashMap;

const EDGE_INK: &str = "#2b3039";
const EDGE_MM: f64 = 0.13;
const FRAME_MM: f64 = 0.18;
const GLASS_FILL_MONO: &str = "#c4c8cd";
const GLASS_FILL_COLOR: &str = "#9fc2d9";
const SHADOW_FILL: &str = "#8f959e";
const OPENING_SHADOW_FILL: &str = "#a7adb5";
const GROUND_INK: &str = "#1f242c";
const GROUND_MM: f64 = 0.5;
const FRAME_FILL_COLOR: &str = "#d9d9d4";
const SILL_FILL_COLOR: &str = "#cccccb";
const DOOR_LEAF_FILL_COLOR: &str = "#ede6d9";
const SYMBOL_INK: &str = "#7d858f";
const ROOF_RGB_FALLBACK: [f64; 3] = [0.72, 0.45, 0.36];
const EPS: f64 = 1e-6;

type Pt = [f64; 2];

/// `hexToRgb` der Ansicht (mit JS-`trim`).
fn hex_to_rgb(hex: &str, fallback: [f64; 3]) -> [f64; 3] {
    let t = js_trim(hex);
    let h = t.strip_prefix('#').unwrap_or(t);
    if h.len() != 6 || !h.bytes().all(|b| b.is_ascii_hexdigit()) {
        return fallback;
    }
    let p = |i: usize| u32::from_str_radix(&h[i..i + 2], 16).unwrap_or(0) as f64 / 255.0;
    [p(0), p(2), p(4)]
}

/// `rgbToHex`.
fn rgb_to_hex(c: [f64; 3]) -> String {
    let b = |v: f64| -> String {
        let x = max(0.0, min(255.0, round(v * 255.0)));
        if x.is_nan() {
            return "NaN".into();
        }
        format!("{:02x}", x as u32)
    };
    format!("#{}{}{}", b(c[0]), b(c[1]), b(c[2]))
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Role {
    Wall,
    Slab,
    Roof,
}

struct Face {
    pts: Vec<Pt>,
    depth: f64,
    depth_min: f64,
    depth_max: f64,
    role: Role,
    id: String,
    fill: [f64; 3],
    normal: [f64; 3],
}

/// Stirnflächen der Dachscheibe an den freien Rändern der Dachflächen (Traufe, Ortgang): je Rand ein
/// Viereck von der Oberkante senkrecht zur Fläche um die Dicke nach innen (wie die 3D-Schichten).
fn fascia_quads(planes: &[Vec<[f64; 3]>], total: f64) -> Vec<[[f64; 3]; 4]> {
    let mut out = Vec::new();
    if !(total > 1e-6) {
        return out;
    }
    let same = |a: [f64; 3], b: [f64; 3]| (a[0] - b[0]).abs() < 1e-6 && (a[1] - b[1]).abs() < 1e-6 && (a[2] - b[2]).abs() < 1e-6;
    for (i, pl) in planes.iter().enumerate() {
        if pl.len() < 3 {
            continue;
        }
        let n = model3d::plane_normal_up(pl);
        if !(n[2] > 1e-3) {
            continue;
        }
        for k in 0..pl.len() {
            let (a, b) = (pl[k], pl[(k + 1) % pl.len()]);
            let shared = planes.iter().enumerate().any(|(j, o)| j != i && (0..o.len()).any(|m| { let (c, d) = (o[m], o[(m + 1) % o.len()]); (same(a, c) && same(b, d)) || (same(a, d) && same(b, c)) }));
            if shared || same(a, b) {
                continue;
            }
            let off = |q: [f64; 3]| [q[0] - n[0] * total, q[1] - n[1] * total, q[2] - n[2] * total];
            out.push([a, b, off(b), off(a)]);
        }
    }
    out
}

/// Dach-Scheiben für die Verdeckung der Wände darunter ([G2]): je Dachfläche Ober- und Unterkante,
/// dazu die Stirnflächen der Ränder.
struct RoofSheet {
    top: Vec<crate::wall_bands::RoofFacet>,
    under: Vec<crate::wall_bands::RoofFacet>,
    fascia: Vec<[[f64; 3]; 4]>,
    bounds: [f64; 4],
}

/// Kreuzt die waagrechte Strecke `a → b` (Grundriss) auf Höhe `z` eine Stirnfläche (im Innern)?
fn crosses_fascia(q: &[[f64; 3]; 4], a: (f64, f64), b: (f64, f64), z: f64) -> bool {
    let e1 = [q[1][0] - q[0][0], q[1][1] - q[0][1], q[1][2] - q[0][2]];
    let e2 = [q[3][0] - q[0][0], q[3][1] - q[0][1], q[3][2] - q[0][2]];
    let m = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    let side = |x: f64, y: f64| m[0] * (x - q[0][0]) + m[1] * (y - q[0][1]) + m[2] * (z - q[0][2]);
    let (s0, s1) = (side(a.0, a.1), side(b.0, b.1));
    if !(s0 * s1 < 0.0) {
        return false;
    }
    let t = s0 / (s0 - s1);
    let x = [a.0 + (b.0 - a.0) * t - q[0][0], a.1 + (b.1 - a.1) * t - q[0][1], z - q[0][2]];
    let dot = |u: [f64; 3], v: [f64; 3]| u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
    let (l1, l2) = (dot(e1, e1), dot(e2, e2));
    if !(l1 > 1e-12 && l2 > 1e-12) {
        return false;
    }
    let (al, be) = (dot(x, e1) / l1, dot(x, e2) / l2);
    (0.0..=1.0).contains(&al) && be > 1e-6 && be < 1.0 - 1e-6
}

impl RoofSheet {
    /// Oberkante minus `z` über dem Grundriss-Punkt (`None`: kein Dach), nur wo die Unterkante echt unter
    /// `z` liegt oder die Oberkante darunter (Strahl über dem Dach).
    fn above(&self, x: f64, y: f64, z: f64) -> Option<f64> {
        let b = self.bounds;
        if x < b[0] || x > b[2] || y < b[1] || y > b[3] {
            return None;
        }
        self.top.iter().zip(&self.under).filter(|(t, _)| t.contains(x, y)).map(|(t, u)| if u.z(x, y) < z - 1e-4 { t.z(x, y) - z } else { -1.0 }).reduce(f64::max)
    }
}

/// Wandflächen unter Dächern ([G2]) gegen die Dachscheiben vor ihnen: Ecken, deren Sichtstrahl (zum
/// Betrachter) durch ein Dach läuft, sind verdeckt. Ganz verdeckte Flächen entfallen (Oberseiten,
/// Laibungen und Stirnen innen unter dem Dach); bei senkrechten Kanten wird die Fläche auf die Höhe
/// gekappt, ab der das Dach sie verdeckt (Traufe vor der Wand). Ersetzt keine HLR ([G4]).
fn cull_under_roofs(p: &Project, frame: &[f64; 9], walls: &[RWall], faces: &mut Vec<Face>) {
    let affected: std::collections::HashSet<&str> = walls.iter().filter(|w| w.top_plane.is_some() || w.joint != [false; 2]).map(|w| w.wall_id.as_str()).collect();
    if affected.is_empty() {
        return;
    }
    let sheets: Vec<RoofSheet> = p
        .roofs
        .as_deref()
        .unwrap_or(&[])
        .iter()
        .map(|r| {
            let g = crate::roof::roof_geometry(&r.params(), p.roof_base_elevation(r));
            let total: f64 = p.roof_layers(r).iter().map(|l| l.thickness.max(0.0)).sum();
            let top = crate::wall_bands::plane_facets(&g.planes, 0.0);
            let under = crate::wall_bands::plane_facets(&g.planes, total);
            let mut b = [f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY];
            for q in g.planes.iter().flatten() {
                b = [b[0].min(q[0]), b[1].min(q[1]), b[2].max(q[0]), b[3].max(q[1])];
            }
            // Stirnflächen, die in einem anderen Dach stecken (Kehlen verschnittener Dächer), verdecken nicht.
            let others: Vec<Vec<[f64; 3]>> = p
                .roofs
                .as_deref()
                .unwrap_or(&[])
                .iter()
                .filter(|o| o.id != r.id && o.floor_id == r.floor_id)
                .flat_map(|o| crate::roof::roof_geometry(&o.params(), p.roof_base_elevation(o)).planes)
                .collect();
            let fascia = fascia_quads(&g.planes, total)
                .into_iter()
                .filter(|q| !others.iter().any(|o| crate::dormer::point_in_xy((q[0][0] + q[1][0]) / 2.0, (q[0][1] + q[1][1]) / 2.0, o)))
                .collect();
            RoofSheet { top, under, fascia, bounds: b }
        })
        .filter(|s| s.top.len() == s.under.len() && !s.top.is_empty())
        .collect();
    if sheets.is_empty() {
        return;
    }
    let (o, n, u) = ([frame[0], frame[2]], [frame[3], frame[5]], [frame[6], frame[8]]);
    let reach = sheets.iter().map(|s| (s.bounds[2] - s.bounds[0]).max(s.bounds[3] - s.bounds[1])).fold(0.0, f64::max) + 1.0;
    // Gaubenstirnen und -wangen als senkrechte Verdecker (lokal u, v; z von der Hauptdach-Unterkante bis
    // zum Gaubendach).
    let dormers: Vec<crate::dormer::DormerGeom> = p
        .roofs
        .as_deref()
        .unwrap_or(&[])
        .iter()
        .flat_map(|r| r.dormers.as_deref().unwrap_or(&[]).iter().filter_map(move |d| crate::dormer::geometry(p, r, d)))
        .collect();
    let dormer_hit = |a: (f64, f64), b: (f64, f64), z: f64| -> bool {
        dormers.iter().any(|g| {
            let (la, lb) = (g.frame.local(a.0, a.1), g.frame.local(b.0, b.1));
            let hw = g.width / 2.0;
            let z_ok = |u: f64, v: f64| z >= g.frame.main_top(v) - g.main_thickness * 2.0 && z <= g.under(u, v) + g.roof_vertical();
            // Stirn (v = 0) oder Wange (|u| = hw) gekreuzt.
            let front = (la[1] > 0.0) != (lb[1] > 0.0) && la[0].abs() <= hw && z_ok(la[0], 0.0);
            let cheek = (la[0].abs() < hw) != (lb[0].abs() < hw) && la[1] >= 0.0 && la[1] <= g.hole_v(la[0]) && z_ok(la[0].clamp(-hw, hw), la[1]);
            front || cheek
        })
    };
    // Verdeckt: der Strahl zum Betrachter (−n im Grundriss) kreuzt die Dachoberfläche von unten nach
    // oben gesehen (erst darunter, näher zum Betrachter darüber) oder eine Gaubenwand.
    let hidden = |x: f64, y: f64, z: f64| -> bool {
        let steps = ((reach / 0.04).ceil() as usize).min(5000);
        let mut under = false;
        let mut prev = (x, y);
        let at = |t: f64| sheets.iter().filter_map(|s| s.above(x - n[0] * t, y - n[1] * t, z)).reduce(f64::max);
        for i in 1..=steps {
            let t = i as f64 * 0.04;
            let q = (x - n[0] * t, y - n[1] * t);
            if dormer_hit(prev, q, z) || sheets.iter().any(|s| s.fascia.iter().any(|f| crosses_fascia(f, prev, q, z))) {
                return true;
            }
            prev = q;
            match at(t) {
                Some(d) if d >= 0.0 => under = true,
                Some(_) if under => return true,
                None if under => {
                    // Aus der Scheibe heraus (Traufkante): Oberkante genau an der Kante unter z?
                    let (mut lo, mut hi) = (t - 0.04, t);
                    for _ in 0..30 {
                        let m = (lo + hi) / 2.0;
                        if at(m).is_some() {
                            lo = m;
                        } else {
                            hi = m;
                        }
                    }
                    if at(lo).is_some_and(|d| d < -1e-6) {
                        return true;
                    }
                    under = false;
                }
                _ => {}
            }
        }
        false
    };
    faces.retain_mut(|f| {
        if f.role != Role::Wall || !affected.contains(f.id.as_str()) || f.pts.len() < 3 {
            return true;
        }
        // Tiefe je Ecke aus der Flächenebene (Normale in Welt x, Höhe, Grundriss-y).
        let k = f.normal[0] * n[0] + f.normal[2] * n[1];
        if k.abs() < 1e-9 {
            return true;
        }
        let m = f.pts.len() as f64;
        let (cu, cv) = (f.pts.iter().map(|q| q[0]).sum::<f64>() / m, f.pts.iter().map(|q| q[1]).sum::<f64>() / m);
        let nu = f.normal[0] * u[0] + f.normal[2] * u[1];
        let world = |q: Pt| -> (f64, f64, f64) {
            let d = f.depth + (nu * (cu - q[0]) + f.normal[1] * (cv - q[1])) / k;
            (o[0] + u[0] * q[0] + n[0] * d, o[1] + u[1] * q[0] + n[1] * d, q[1])
        };
        let hid: Vec<bool> = f.pts.iter().map(|&q| {
            let (x, y, z) = world(q);
            hidden(x, y, z - 1e-6)
        }).collect();
        if hid.iter().all(|h| *h) {
            return false;
        }
        if !hid.iter().any(|h| *h) {
            return true;
        }
        // Verdeckte Ecke mit sichtbarer Ecke senkrecht darunter: auf die Verdeckungsgrenze senken.
        let pts = f.pts.clone();
        for i in 0..pts.len() {
            if !hid[i] {
                continue;
            }
            let Some(j) = (0..pts.len()).find(|&j| !hid[j] && (pts[j][0] - pts[i][0]).abs() < 1e-6 && pts[j][1] < pts[i][1]) else { continue };
            let (x, y, _) = world(pts[i]);
            let (mut lo, mut hi) = (pts[j][1], pts[i][1]);
            for _ in 0..40 {
                let mid = (lo + hi) / 2.0;
                if hidden(x, y, mid) {
                    hi = mid;
                } else {
                    lo = mid;
                }
            }
            f.pts[i][1] = lo;
        }
        true
    });
}

/// `elevationFrame` flach: `[P, N, U]`.
fn frame_of(plane: &super::section::Plane) -> [f64; 9] {
    let [nx, ny, nz] = plane.normal;
    let l = hypot(&[nx, ny, nz]);
    let n_len = if l == 0.0 || l.is_nan() { 1.0 } else { l };
    let ux = nz / n_len;
    let uz = -nx / n_len;
    let l = hypot2(ux, uz);
    let u_len = if l == 0.0 || l.is_nan() { 1.0 } else { l };
    let p = plane.point;
    [p[0], p[1], p[2], nx / n_len, ny / n_len, nz / n_len, ux / u_len, 0.0, uz / u_len]
}

struct RoofIn {
    id: String,
    fill: [f64; 3],
    planes: Vec<Vec<[f64; 3]>>,
    gables: Vec<Vec<[f64; 3]>>,
}

/// `projectFaces`.
fn project_faces(frame: &[f64; 9], walls: &[RWall], slabs: &[RSlab], roofs: &[RoofIn]) -> Vec<Face> {
    let mut w = vec![walls.len() as f64];
    // Mit Schnittlinien (Bogen-Teilkörper, [T2]): die Ecken liegen auf der Gehrung statt rechtwinklig.
    let planes = walls.iter().any(|x| x.top_plane.is_some());
    let cut = planes || walls.iter().any(|x| x.start_cut.is_some() || x.end_cut.is_some() || x.joint != [false; 2]);
    for x in walls {
        w.extend([x.start[0], x.start[1], x.end[0], x.end[1], x.thickness, x.height, x.base_elevation]);
        if cut {
            w.extend(corner_shifts(x));
            w.extend([if x.joint[0] { 1.0 } else { 0.0 }, if x.joint[1] { 1.0 } else { 0.0 }]);
        }
        // Ebene Oberkante unter einem Dach ([G2]).
        if planes {
            match x.top_plane {
                Some(c) => w.extend([1.0, c[0], c[1], c[2]]),
                None => w.extend([0.0; 4]),
            }
        }
    }
    let mut sl = vec![slabs.len() as f64];
    for x in slabs {
        sl.extend([x.z_bottom, x.z_top, x.outline.len() as f64]);
        for q in &x.outline {
            sl.extend(q);
        }
    }
    let mut r = vec![roofs.len() as f64];
    for roof in roofs {
        r.extend([roof.planes.len() as f64, roof.gables.len() as f64]);
        for poly in roof.planes.iter().chain(&roof.gables) {
            r.push(poly.len() as f64);
            for q in poly {
                r.extend(q);
            }
        }
    }
    let f = crate::plan_elevation::faces(frame, &w, &sl, &r);
    let mut out = Vec::new();
    let n = f.first().copied().unwrap_or(0.0) as usize;
    let mut i = 1;
    for _ in 0..n {
        let role = match f[i] as i64 {
            0 => Role::Wall,
            1 => Role::Slab,
            _ => Role::Roof,
        };
        let src = f[i + 1] as usize;
        let count = f[i + 8] as usize;
        let pts = (0..count).map(|j| [f[i + 9 + 2 * j], f[i + 10 + 2 * j]]).collect();
        let (id, fill) = match role {
            Role::Wall => (walls[src].wall_id.clone(), walls[src].color),
            Role::Slab => (slabs[src].ceiling_id.clone(), slabs[src].color),
            Role::Roof => (roofs[src].id.clone(), roofs[src].fill),
        };
        out.push(Face { pts, depth: f[i + 2], depth_min: f[i + 3], depth_max: f[i + 4], role, id, fill, normal: [f[i + 5], f[i + 6], f[i + 7]] });
        i += 9 + 2 * count;
    }
    out
}

/// Verschiebung der vier Wandecken längs der Achse bis auf die Schnittlinien (Anfang +n, Anfang −n,
/// Ende +n, Ende −n; +n = rechte Normale wie in `plan_elevation::wall_faces`).
pub(crate) fn corner_shifts(x: &RWall) -> [f64; 4] {
    let (dx, dy) = (x.end[0] - x.start[0], x.end[1] - x.start[1]);
    let l = hypot2(dx, dy);
    if l < 1e-9 {
        return [0.0; 4];
    }
    let (ax, ay) = (dx / l, dy / l);
    let (nx, ny) = (ay, -ax);
    let ht = x.thickness / 2.0;
    let shift = |base: [f64; 2], t: f64, cut: Option<[f64; 4]>| -> f64 {
        let Some([cx, cy, ux, uy]) = cut else { return 0.0 };
        let (qx, qy) = (base[0] + nx * t, base[1] + ny * t);
        let den = ax * uy - ay * ux;
        if den.abs() < 1e-12 {
            return 0.0;
        }
        let lam = ((cx - qx) * uy - (cy - qy) * ux) / den;
        if lam.is_finite() && lam.abs() < l {
            lam
        } else {
            0.0
        }
    };
    [shift(x.start, ht, x.start_cut), shift(x.start, -ht, x.start_cut), shift(x.end, ht, x.end_cut), shift(x.end, -ht, x.end_cut)]
}

/// `collectRoofFaces`.
fn collect_roof_faces(p: &Project, frame: &[f64; 9], walls: &[RWall]) -> Result<Vec<Face>, String> {
    // Giebeldreiecke nur ohne Wand darunter ([G2]): sonst zeigt die Ansicht die Giebelwand selbst.
    let reached: std::collections::HashSet<&str> = walls.iter().filter(|w| w.top_plane.is_some()).map(|w| w.wall_id.as_str()).collect();
    let floors: std::collections::HashSet<&str> = p.walls.iter().filter(|w| reached.contains(w.id.as_str())).map(|w| w.floor_id.as_str()).collect();
    let mut roofs = Vec::new();
    for (ri, roof) in p.roofs.as_deref().unwrap_or(&[]).iter().enumerate() {
        let g = crate::roof::roof_geometry(&roof.params(), p.roof_base_elevation(roof));
        let layers = p.roof_layers(roof);
        let outer = layers.first();
        let fill = match roof.color.as_deref().filter(|c| !c.is_empty()) {
            Some(c) => hex_to_rgb(c, ROOF_RGB_FALLBACK),
            None => match outer.filter(|l| !l.component_id.is_empty()) {
                // Hängendes Bauteil (Datei/Import): Dach-Vorgabefarbe.
                Some(l) => p.component(&l.component_id).map_or(ROOF_RGB_FALLBACK, |c| hex_to_rgb(&c.color, ROOF_RGB_FALLBACK)),
                None => ROOF_RGB_FALLBACK,
            },
        };
        // Verschnittene Dächer und Gauben ([G5]): sichtbare Dreiecke der Aussenhaut, Gaubenwände in
        // ihrer Bauteilfarbe.
        if let Some(solids) = crate::roof_assembly::roof_solids(p, ri) {
            let fn_ = [frame[3], frame[4], frame[5]];
            // Zugewandte Dreiecke (Ansichtswelt x, Höhe, y wie `surface_openings`).
            let front = |m: &crate::solid_bool::Mesh| -> Vec<usize> {
                (0..m.indices.len() / 3)
                    .filter(|&ti| {
                        let q = |i: u32| {
                            let j = i as usize * 3;
                            [m.positions[j], m.positions[j + 1], m.positions[j + 2]]
                        };
                        let t = &m.indices[ti * 3..ti * 3 + 3];
                        let tri = [q(t[0]), q(t[1]), q(t[2])];
                        let n = crate::opening_shape::cross([tri[1][0] - tri[0][0], tri[1][1] - tri[0][1], tri[1][2] - tri[0][2]], [tri[2][0] - tri[0][0], tri[2][1] - tri[0][1], tri[2][2] - tri[0][2]]);
                        fn_[0] * n[0] + fn_[1] * n[2] + fn_[2] * n[1] < -1e-12
                    })
                    .collect()
            };
            // Wie die übrigen Dächer: Oberfläche der Eindeckung (Dach + Gaubendächer), dazu die Gaubenwände.
            // Wände reichen ans Dach ([G2]): Stirnflächen der Ränder, die nicht in einem anderen Dach stecken.
            let gables = if floors.contains(roof.floor_id.as_str()) {
                let total: f64 = p.roof_layers(roof).iter().map(|l| l.thickness.max(0.0)).sum();
                let others: Vec<Vec<[f64; 3]>> = p
                    .roofs
                    .as_deref()
                    .unwrap_or(&[])
                    .iter()
                    .filter(|o| o.id != roof.id && o.floor_id == roof.floor_id)
                    .flat_map(|o| crate::roof::roof_geometry(&o.params(), p.roof_base_elevation(o)).planes)
                    .collect();
                fascia_quads(&g.planes, total)
                    .into_iter()
                    .filter(|q| {
                        let (mx, my) = ((q[0][0] + q[1][0]) / 2.0, (q[0][1] + q[1][1]) / 2.0);
                        !others.iter().any(|o| crate::dormer::point_in_xy(mx, my, o))
                    })
                    .map(|q| q.to_vec())
                    .collect()
            } else {
                g.gables.clone()
            };
            roofs.push(RoofIn { id: roof.id.clone(), fill, planes: crate::roof_assembly::planar_faces(&solids.top, &front(&solids.top)), gables });
            let wall_comp = solids.parts.iter().find(|pt| pt.role == crate::roof_assembly::Role::DormerWall && pt.layer == 0).and_then(|pt| p.component(&pt.component_id));
            let wf = wall_comp.map_or([0.85, 0.83, 0.8], |c| hex_to_rgb(&c.color, [0.85, 0.83, 0.8]));
            let wall_faces = crate::roof_assembly::planar_faces(&solids.walls, &front(&solids.walls));
            if !wall_faces.is_empty() {
                roofs.push(RoofIn { id: roof.id.clone(), fill: wf, planes: wall_faces, gables: Vec::new() });
            }
            continue;
        }
        // Wände reichen ans Dach: statt der Giebeldreiecke die Stirnflächen der Dachscheibe (Traufe, Ortgang).
        let gables = if floors.contains(roof.floor_id.as_str()) {
            let total: f64 = p.roof_layers(roof).iter().map(|l| l.thickness.max(0.0)).sum();
            fascia_quads(&g.planes, total).into_iter().map(|q| q.to_vec()).collect()
        } else {
            g.gables.clone()
        };
        roofs.push(RoofIn { id: roof.id.clone(), fill, planes: g.planes.clone(), gables });
    }
    Ok(project_faces(frame, &[], &[], &roofs))
}

/// `extendWallCornersForElevation`.
fn extend_wall_corners(p: &Project, rwalls: &mut [RWall], u: (f64, f64)) {
    let mut floors: HashMap<&str, usize> = HashMap::new();
    let mut b = vec![p.walls.len() as f64];
    for w in &p.walls {
        let n = floors.len();
        let k = *floors.entry(w.floor_id.as_str()).or_insert(n);
        let thickness = p.wall_type(w).map_or(0.2, |t| t.layers.iter().fold(0.0, |s, l| s + l.thickness));
        b.extend([k as f64, w.start.x, w.start.y, w.end.x, w.end.y, thickness / 2.0]);
    }
    let ext = crate::plan_elevation::wall_extensions(&b);
    if ext.is_empty() {
        return;
    }
    let mut by_wall: HashMap<&str, Vec<usize>> = HashMap::new();
    let ids: Vec<String> = rwalls.iter().map(|r| r.wall_id.clone()).collect();
    for (i, id) in ids.iter().enumerate() {
        by_wall.entry(id.as_str()).or_default().push(i);
    }
    let close = |a: [f64; 2], v: Vec2| (a[0] - v.x).abs() < 1e-6 && (a[1] - v.y).abs() < 1e-6;
    for (k, w) in p.walls.iter().enumerate() {
        let e_start = ext[1 + 2 * k];
        let e_end = ext[2 + 2 * k];
        if e_start <= EPS && e_end <= EPS {
            continue;
        }
        let Some(pieces) = by_wall.get(w.id.as_str()) else { continue };
        let (dx, dz) = (w.end.x - w.start.x, w.end.y - w.start.y);
        let len = hypot2(dx, dz);
        if len < 1e-9 {
            continue;
        }
        let (ux, uz) = (dx / len, dz / len);
        if (ux * u.0 + uz * u.1).abs() < 0.35 {
            continue;
        }
        if e_start > EPS {
            if let Some(&i) = pieces.iter().find(|&&i| close(rwalls[i].start, w.start)) {
                let s = rwalls[i].start;
                rwalls[i].start = [s[0] - ux * e_start, s[1] - uz * e_start];
                // Ebene Oberkante bezieht sich auf den Anfang ([G2]).
                if let Some(c) = rwalls[i].top_plane.as_mut() {
                    c[0] -= (c[1] * ux + c[2] * uz) * e_start;
                }
            }
        }
        if e_end > EPS {
            if let Some(&i) = pieces.iter().find(|&&i| close(rwalls[i].end, w.end)) {
                let e = rwalls[i].end;
                rwalls[i].end = [e[0] + ux * e_end, e[1] + uz * e_end];
            }
        }
    }
}

struct ProjOpening {
    pts: [Pt; 4],
    depth: f64,
    glass: Vec<[Pt; 4]>,
    door_leaf: Vec<[Pt; 4]>,
    divisions: Vec<(Pt, Pt)>,
    sash_rects: Vec<[Pt; 4]>,
    sill: Vec<[Pt; 4]>,
    symbol: Vec<(Pt, Pt)>,
    id: String,
    /// Formöffnung ([G3]): Rahmen-Umriss und Glas entlang des Umrisses statt der Rechtecke.
    shape: Option<(Vec<Pt>, Vec<Pt>, Vec<Vec<Pt>>, String)>,
    /// [105] Rahmen-Umriss, wenn er über die Rohbauöffnung hinausgeht (Zargenspiegel, Bekleidung).
    frame: Option<[Pt; 4]>,
}

/// Türzarge in der Ansicht ([105]) von der sichtbaren Seite: `outer` = über die Rohbaukante hinaus
/// (Spiegel, Bekleidung, Blendrahmen), `clear` = lichte Kante der Zarge, `leaf` = Blatt-Einzug.
struct DoorBand {
    outer: f64,
    clear: f64,
    leaf: f64,
}

/// Sichtbare Wandseite: +1 = rechts der Achse (Aussenseite, `layers[0]`), −1 = innen.
fn view_side(frame: &[f64; 9], wall: &Wall) -> f64 {
    let (ax, az) = (wall.end.x - wall.start.x, wall.end.y - wall.start.y);
    let len = hypot2(ax, az).max(1e-12);
    if frame[3] * az / len - frame[5] * ax / len < 0.0 { 1.0 } else { -1.0 }
}

fn door_band(df: &crate::opening_detail::DoorFrame, total: f64, o: &Opening, side: f64) -> DoorBand {
    use crate::opening_detail as od;
    let innen = od::aufschlag_innen(o);
    let prof = od::door_frame_profile(df, total, innen);
    // Aufschlagfläche sichtbar? (Aufschlag innen ⇔ Innenseite −1).
    let aufschlag = (side < 0.0) == innen;
    let touches = |poly: &[[f64; 2]]| poly.iter().any(|q| if aufschlag { q[1] <= 1e-6 } else { q[1] >= total - 1e-6 });
    let outer = prof.iter().filter(|(_, p)| touches(p)).flat_map(|(_, p)| p.iter().map(|q| -q[0])).fold(0.0, f64::max);
    let clear = od::profile_clear_x(&prof);
    // Von der Aufschlagseite liegt das Blatt vor dem Falz.
    let leaf = if aufschlag { (clear - df.falz_width).max(0.0) } else { clear };
    DoorBand { outer, clear, leaf }
}

/// Umriss einer Formöffnung in Anteilen (0…1) und das um die Rahmenbreite eingerückte Glas.
type ShapeNorm = (Vec<[f64; 2]>, Vec<[f64; 2]>, Vec<[[f64; 2]; 4]>, String);

fn map_quad(q: &[Pt; 4], s: f64, t: f64) -> Pt {
    let lerp = |a: Pt, b: Pt, k: f64| -> Pt { [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k] };
    lerp(lerp(q[0], q[1], s), lerp(q[3], q[2], s), t)
}

fn sash_kind(k: OpeningKind) -> f64 {
    match k {
        OpeningKind::Dreh => 1.0,
        OpeningKind::Kipp => 2.0,
        OpeningKind::Drehkipp => 3.0,
        OpeningKind::Schiebe => 4.0,
        _ => 0.0,
    }
}

/// `collectOpenings`.
fn collect_openings(p: &Project, frame: &[f64; 9]) -> Vec<ProjOpening> {
    let mut b = vec![0.0];
    let mut ids: Vec<&str> = Vec::new();
    let mut shapes: Vec<Option<ShapeNorm>> = Vec::new();
    let mut bands: Vec<Option<DoorBand>> = Vec::new();
    let by_wall = p.openings_by_wall();
    for wall in &p.walls {
        let thickness = p.wall_type(wall).map_or(0.2, |t| t.layers.iter().fold(0.0, |s, l| s + l.thickness));
        for &op in by_wall.get(wall.id.as_str()).map_or(&[][..], |v| v.as_slice()) {
            let arc = crate::wall_arc::WallArc::of_wall(wall);
            let axis = arc.map_or_else(|| hypot2(wall.end.x - wall.start.x, wall.end.y - wall.start.y), |a| a.length());
            let from = max(0.0, min(op.position, axis));
            let to = max(from, min(op.position + op.width, axis));
            if to - from < 1e-4 {
                continue;
            }
            // [T2] Bogenwand: Öffnung als Sehne zwischen den Laibungen (Ersatzwand je Öffnung).
            let (ws, we, from, to) = match arc {
                Some(a) => {
                    let (ps, pe) = (a.point(from, 0.0), a.point(to, 0.0));
                    (Vec2 { x: ps.x, y: ps.y }, Vec2 { x: pe.x, y: pe.y }, 0.0, hypot2(pe.x - ps.x, pe.y - ps.y))
                }
                None => (wall.start, wall.end, from, to),
            };
            let (zb, zt) = p.wall_vertical_extent(wall);
            let ob = zb + max(0.0, op.sill_height);
            let ot = min(zt, ob + op.height);
            let door = op.kind == ElementKind::Door;
            let dt = if door { p.door_type(op) } else { None };
            let wt = if door { None } else { p.window_type(op) };
            b.extend([
                ws.x,
                ws.y,
                we.x,
                we.y,
                thickness,
                from,
                to,
                ob,
                ot,
                if door { 1.0 } else { 0.0 },
                if dt.is_some_and(|d| d.leaf_style == DoorTypeLeafStyle::Glas) { 1.0 } else { 0.0 },
                dt.and_then(|d| d.glazing_ratio).unwrap_or(f64::NAN),
                wt.and_then(|t| t.frame_width).unwrap_or(0.06),
                if door { dt.and_then(|t| t.transom_height) } else { wt.and_then(|t| t.transom_height) }.unwrap_or(0.0),
                wt.and_then(|t| t.mullion_rows).unwrap_or(f64::NAN),
                wt.and_then(|t| t.mullion_cols).unwrap_or(f64::NAN),
                if matches!(wt.and_then(|t| t.sill_board), Some(WindowTypeSillBoard::Keine | WindowTypeSillBoard::Innen)) { 0.0 } else { 1.0 },
                wt.map_or(0.0, |t| sash_kind(t.kind)),
                // Anschlag nur mit Leibung (Einzug > 0 oder mittig), sonst gibt es keine Wandnase.
                match (dt, wt) {
                    (Some(t), _) if t.inset_face == Some(DoorTypeInsetFace::Mitte) || t.inset_from_face.unwrap_or(0.0) > 1e-4 => t.rebate_depth.unwrap_or(0.0),
                    (_, Some(t)) if t.inset_face == Some(WindowTypeInsetFace::Mitte) || t.inset_from_face.unwrap_or(0.0) > 1e-4 => t.rebate_depth.unwrap_or(0.0),
                    _ => 0.0,
                },
                if (door && dt.and_then(|t| t.inset_face) == Some(DoorTypeInsetFace::Innen)) || (!door && wt.and_then(|t| t.inset_face) == Some(WindowTypeInsetFace::Innen)) { -1.0 } else { 1.0 },
                match dt.map(|t| t.kind) {
                    Some(DoorTypeKind::Schiebe) => 1.0,
                    Some(DoorTypeKind::Hebeschiebe) => 2.0,
                    Some(DoorTypeKind::Pendel) => 3.0,
                    _ => 0.0,
                },
            ]);
            // [105] Rahmen-Detail je Seite, Anschlag je Seite, Profile, Türblatt-Einzug der Zarge.
            let det = crate::opening_detail::frame_of(p, op).filter(|f| f.detailed);
            let dframe = crate::opening_detail::door_frame_of(p, op);
            let side = view_side(frame, wall);
            let band = dframe.as_ref().map(|df| door_band(df, thickness, op, side));
            let nan = f64::NAN;
            match det.as_ref() {
                Some(f) if !door => b.extend([f.sides.left, f.sides.right, f.sides.top, f.sides.bottom]),
                _ => b.extend([nan; 4]),
            }
            match det.as_ref() {
                Some(f) => b.extend([f.rebate.left, f.rebate.right, f.rebate.top]),
                None => b.extend([nan; 3]),
            }
            match det.as_ref() {
                Some(f) if !door => b.extend([f.ext.left, f.ext.right, f.sill_profile, f.shading_profile]),
                _ => b.extend([nan; 4]),
            }
            match &band {
                Some(bd) => b.extend([bd.leaf, bd.leaf]),
                None => b.extend([nan; 2]),
            }
            if band.is_some() {
                // Zargen ohne Wandnase: der Anschlag gehört zur Zarge.
                let k = b.len() - 13 - 3;
                b[k] = 0.0;
            }
            let mullion = det.as_ref().map_or(f64::NAN, |f| f.mullion_width);
            // Flügel: (pfosten, postWidth, autoWidth, width, opening, hingeLeft).
            let mut sashes: Vec<[f64; 6]> = Vec::new();
            if !door {
                match wt {
                    Some(t) => match t.sashes.as_deref().filter(|s| !s.is_empty()) {
                        Some(list) => {
                            for s in list {
                                sashes.push([
                                    if s.kind == SashDefKind::Pfosten { 1.0 } else { 0.0 },
                                    s.post_width.unwrap_or(mullion),
                                    if s.auto_width == Some(false) { 0.0 } else { 1.0 },
                                    s.width.unwrap_or(f64::NAN),
                                    s.opening.map_or(-1.0, sash_kind),
                                    if s.hinge_side.unwrap_or(SashDefHingeSide::Left) == SashDefHingeSide::Left { 1.0 } else { 0.0 },
                                ]);
                            }
                        }
                        None => {
                            let wc = if t.wing_count == 0.0 || t.wing_count.is_nan() { 1.0 } else { t.wing_count };
                            let n = max(1.0, round(wc)) as usize;
                            for i in 0..n {
                                // [105] Pfostenbreite gesetzt: Pfosten zwischen den Flügeln.
                                if i > 0 && mullion.is_finite() && mullion > 1e-4 {
                                    sashes.push([1.0, mullion, 1.0, f64::NAN, 0.0, 1.0]);
                                }
                                sashes.push([0.0, f64::NAN, 1.0, f64::NAN, sash_kind(t.kind), if i % 2 == 0 { 1.0 } else { 0.0 }]);
                            }
                        }
                    },
                    None => sashes.push([0.0, f64::NAN, 1.0, f64::NAN, -1.0, 1.0]),
                }
            }
            b.push(sashes.len() as f64);
            for s in &sashes {
                b.extend(s);
            }
            // Oberlicht-Einteilung (Pfosten/Riegel, [95]).
            let transom = if door { &[][..] } else { wt.and_then(|t| t.transom_sashes.as_deref()).unwrap_or(&[]) };
            b.push(transom.len() as f64);
            for s in transom {
                b.extend([
                    if s.kind == SashDefKind::Pfosten { 1.0 } else { 0.0 },
                    s.post_width.unwrap_or(f64::NAN),
                    if s.auto_width == Some(false) { 0.0 } else { 1.0 },
                    s.width.unwrap_or(f64::NAN),
                    s.opening.map_or(0.0, sash_kind),
                    if s.hinge_side.unwrap_or(SashDefHingeSide::Left) == SashDefHingeSide::Left { 1.0 } else { 0.0 },
                ]);
            }
            ids.push(&op.id);
            bands.push(band);
            shapes.push(crate::opening_shape::opening_outline(op, to - from, ot - ob).map(|poly| {
                let (w, h) = (to - from, ot - ob);
                let fw = if door { dt.and_then(|t| t.frame_width) } else { wt.and_then(|t| t.frame_width) }.unwrap_or(0.06).min(w.min(h) / 3.0);
                let norm = |q: &[f64; 2]| [q[0] / w, q[1] / h];
                let fills = crate::opening_shape::fill_quads(&poly, w, h).iter().map(|q| q.map(|c| norm(&c))).collect();
                (poly.iter().map(norm).collect(), crate::opening_shape::inset(&poly, fw).iter().map(norm).collect(), fills, wall.id.clone())
            }));
            b[0] += 1.0;
        }
    }
    let f = crate::plan_elevation::openings(frame, &b);
    let mut out = Vec::new();
    if f.is_empty() {
        return out;
    }
    let mut i = 1;
    let quads = |i: &mut usize| -> Vec<[Pt; 4]> {
        let n = f[*i] as usize;
        *i += 1;
        let mut list = Vec::with_capacity(n);
        for _ in 0..n {
            list.push([[f[*i], f[*i + 1]], [f[*i + 2], f[*i + 3]], [f[*i + 4], f[*i + 5]], [f[*i + 6], f[*i + 7]]]);
            *i += 8;
        }
        list
    };
    let lines = |i: &mut usize| -> Vec<(Pt, Pt)> {
        let n = f[*i] as usize;
        *i += 1;
        let mut list = Vec::with_capacity(n);
        for _ in 0..n {
            list.push(([f[*i], f[*i + 1]], [f[*i + 2], f[*i + 3]]));
            *i += 4;
        }
        list
    };
    for k in 0..f[0] as usize {
        let vis = f[i];
        i += 1;
        if vis == 0.0 {
            continue;
        }
        let depth = f[i];
        let pts = [[f[i + 2], f[i + 3]], [f[i + 4], f[i + 5]], [f[i + 6], f[i + 7]], [f[i + 8], f[i + 9]]];
        i += 10;
        let glass = quads(&mut i);
        let door_leaf = quads(&mut i);
        let divisions = lines(&mut i);
        let sash_rects = quads(&mut i);
        let sill = quads(&mut i);
        let symbol = lines(&mut i);
        let m = |q: &[f64; 2]| map_quad(&pts, q[0], q[1]);
        let shape = shapes[k].as_ref().map(|(o, g, fl, wid)| (o.iter().map(m).collect(), g.iter().map(m).collect(), fl.iter().map(|q| q.iter().map(m).collect()).collect(), wid.clone()));
        if shape.is_some() {
            // Formöffnung ([G3]): ohne Flügel-/Sprossenteilung, Türblatt und Symbole (Rechteck-Raster).
            let round = p.openings.as_deref().unwrap_or(&[]).iter().any(|o| o.id == ids[k] && !crate::opening_shape::has_flat_bottom(o));
            out.push(ProjOpening { pts, depth, glass: Vec::new(), door_leaf: Vec::new(), divisions: Vec::new(), sash_rects: Vec::new(), sill: if round { Vec::new() } else { sill }, symbol: Vec::new(), id: ids[k].to_string(), shape, frame: None });
            continue;
        }
        let mut sash_rects = sash_rects;
        let mut pts_frame = None;
        if let Some(bd) = &bands[k] {
            // Zarge von dieser Seite: Spiegel/Bekleidung über die Rohbaukante hinaus, lichte Kante.
            let (w, h) = (hypot2(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]).max(1e-6), hypot2(pts[3][0] - pts[0][0], pts[3][1] - pts[0][1]).max(1e-6));
            let r = |a0: f64, a1: f64, z1: f64| [map_quad(&pts, a0, 0.0), map_quad(&pts, a1, 0.0), map_quad(&pts, a1, z1), map_quad(&pts, a0, z1)];
            if bd.outer > 1e-4 {
                pts_frame = Some(r(-bd.outer / w, 1.0 + bd.outer / w, 1.0 + bd.outer / h));
                // Rohbaukante unter dem Spiegel/der Bekleidung.
                sash_rects.push(r(0.0, 1.0, 1.0));
            }
            if bd.clear > 1e-4 && bd.clear < bd.leaf - 1e-4 {
                sash_rects.push(r(bd.clear / w, 1.0 - bd.clear / w, 1.0 - bd.clear / h));
            }
        }
        out.push(ProjOpening { pts, depth, glass, door_leaf, divisions, sash_rects, sill, symbol, id: ids[k].to_string(), shape, frame: pts_frame });
    }
    surface_openings(p, frame, &mut out);
    out
}

/// Dach-/Deckenfenster ([103]) in der Ansicht: Rahmen-Rechteck in der Dachfläche (6 cm über der
/// Eindeckung) und Glas, nur wenn die Fläche zum Betrachter zeigt.
fn surface_openings(p: &Project, frame: &[f64; 9], out: &mut Vec<ProjOpening>) {
    let (fp, fnrm, fu) = ([frame[0], frame[1], frame[2]], [frame[3], frame[4], frame[5]], [frame[6], frame[7], frame[8]]);
    let proj = |q: [f64; 3]| -> (Pt, f64) {
        // Modell (x, y, z) → Ansichtswelt (x, Höhe, y).
        let w = [q[0] - fp[0], q[2] - fp[1], q[1] - fp[2]];
        ([w[0] * fu[0] + w[1] * fu[1] + w[2] * fu[2], q[2]], w[0] * fnrm[0] + w[1] * fnrm[1] + w[2] * fnrm[2])
    };
    for o in p.openings.as_deref().unwrap_or(&[]) {
        let Some(f) = crate::opening_shape::host_frame(p, o) else { continue };
        if (f.plane.is_none() && !f.dormer) || fnrm[0] * f.n[0] + fnrm[1] * f.n[2] + fnrm[2] * f.n[1] >= -1e-4 {
            continue;
        }
        let (w, h) = (o.width, o.height);
        let fw = crate::opening_shape::surface_frame_width(p, o);
        let quad = |inset: f64| -> ([Pt; 4], f64) {
            let c = [f.at(-w / 2.0 + inset, -h / 2.0 + inset, -0.06), f.at(w / 2.0 - inset, -h / 2.0 + inset, -0.06), f.at(w / 2.0 - inset, h / 2.0 - inset, -0.06), f.at(-w / 2.0 + inset, h / 2.0 - inset, -0.06)];
            let pr = c.map(proj);
            ([pr[0].0, pr[1].0, pr[2].0, pr[3].0], (pr[0].1 + pr[1].1 + pr[2].1 + pr[3].1) / 4.0)
        };
        let (pts, own) = quad(0.0);
        if own <= 1e-6 {
            continue;
        }
        // Painter: knapp vor der eigenen Dachfläche (deren Tiefe = Mittel ihrer Ecken wie `project_face`).
        let plane_depth = p.roofs.as_deref().and_then(|r| r.get(f.host)).and_then(|roof| {
            let g = crate::roof::roof_geometry(&roof.params(), p.roof_base_elevation(roof));
            let pl = g.planes.get(f.plane?)?.clone();
            Some(pl.iter().map(|q| proj(*q).1).sum::<f64>() / pl.len() as f64)
        });
        let depth = plane_depth.map_or(own, |d| d.min(own));
        let glass = if o.kind == ElementKind::Window { vec![quad(fw).0] } else { Vec::new() };
        out.push(ProjOpening { pts, depth, glass, door_leaf: Vec::new(), divisions: Vec::new(), sash_rects: Vec::new(), sill: Vec::new(), symbol: Vec::new(), id: o.id.clone(), shape: None, frame: None });
    }
}

fn encode_shadow_faces(faces: &[&Face]) -> Vec<f64> {
    let mut b = vec![faces.len() as f64];
    for f in faces {
        b.extend([f.depth, f.depth_min, f.pts.len() as f64]);
        for q in &f.pts {
            b.extend(q);
        }
    }
    b
}

/// Eintrag des Painter-Stroms.
struct Item {
    depth: f64,
    seq: usize,
    rank: Option<f64>,
    prim: Primitive,
}

enum Pending {
    /// `style`: Index in die Ansichtsschraffur-Stile (Strichstärke, Farbe); ohne = Kante.
    /// `paint`: Tiefe für die Maler-Reihenfolge, wenn sie von der Verdeckungstiefe abweicht (Muster-
    /// linien liegen knapp vor IHRER Fläche, auch wo sie tiefer liegen als deren Mittel).
    Line { a: Pt, b: Pt, depth: f64, style: Option<usize>, paint: Option<f64> },
    Item { depth: f64, rank: Option<f64>, prim: Primitive },
}

fn outline_line(a: Pt, b: Pt) -> Primitive {
    line(v2(a[0], a[1]), v2(b[0], b[1]), "elevation-outline", EDGE_MM, EDGE_INK)
}

/// Schlüssel einer Kante wie `edgeKey` (gerundet auf 0,1 mm, Endpunkte sortiert als Text).
fn edge_key(a: Pt, b: Pt) -> String {
    let r = |v: f64| js_number(round(v * 1e4));
    let ka = format!("{},{}", r(a[0]), r(a[1]));
    let kb = format!("{},{}", r(b[0]), r(b[1]));
    if ka < kb {
        format!("{ka}|{kb}")
    } else {
        format!("{kb}|{ka}")
    }
}

/// Schlüssel einer `Map<number, …>` (SameValueZero).
fn num_key(x: f64) -> u64 {
    if x == 0.0 {
        0
    } else if x.is_nan() {
        u64::MAX
    } else {
        x.to_bits()
    }
}

fn poly_prim(pts: Vec<Vec2>, fill: &str, stroke: &str, w: f64, opening: Option<&str>) -> Primitive {
    let mut pr = polygon(pts, fill, stroke, w, no_hatch());
    if let (Primitive::Polygon { opening_id, .. }, Some(id)) = (&mut pr, opening) {
        *opening_id = Some(id.into());
    }
    pr
}

/// `generateElevationPlan`: Primitive und Ausmass; `None` ohne Ansichtslinie.
pub fn elevation_primitives(p: &Project, level: &LevelSpec, shadows: bool, mono: bool, vis: &Visibility, scale: f64) -> Result<Option<(Vec<Primitive>, [f64; 4])>, String> {
    let Some(plane) = level.plane() else { return Ok(None) };
    let frame = frame_of(&plane);
    let mut walls = model3d::emit_walls(p, false)?;
    let mut slabs = model3d::emit_slabs(p);
    slabs.extend(model3d::emit_stairs(p, false));
    extend_wall_corners(p, &mut walls, (frame[6], frame[8]));
    let mut faces = project_faces(&frame, &walls, &slabs, &[]);
    cull_under_roofs(p, &frame, &walls, &mut faces);
    faces.extend(collect_roof_faces(p, &frame, &walls)?);

    // Kategorie einer Fläche (erstes Element mit der id, wie `find`).
    let mut wall_cat: HashMap<&str, &str> = HashMap::new();
    for w in &p.walls {
        wall_cat.entry(w.id.as_str()).or_insert(w.category_code.as_str());
    }
    let mut ceil_cat: HashMap<&str, &str> = HashMap::new();
    for c in p.ceilings.as_deref().unwrap_or(&[]) {
        ceil_cat.entry(c.id.as_str()).or_insert(c.category_code.as_str());
    }
    let mut roof_cat: HashMap<&str, &str> = HashMap::new();
    for r in p.roofs.as_deref().unwrap_or(&[]) {
        roof_cat.entry(r.id.as_str()).or_insert(r.category_code.as_str());
    }
    let category = |f: &Face| -> Option<&str> {
        if f.id.is_empty() {
            return None;
        }
        match f.role {
            Role::Wall => wall_cat.get(f.id.as_str()).copied(),
            Role::Slab => ceil_cat.get(f.id.as_str()).copied(),
            Role::Roof => roof_cat.get(f.id.as_str()).copied(),
        }
    };
    if vis.has_vis && vis.has_display {
        faces.retain(|f| category(f).is_none_or(|c| vis.visible(c) && vis.render(c)));
    }
    let greyed = |f: &Face| vis.has_display && category(f).is_some_and(|c| vis.greyed(c));

    // Ansichtsfarbe und -schraffur ([100]) der sichtbaren Bauteilseite.
    let (pattern_lines, pattern_styles) = surface_patterns(p, &mut faces, &frame, scale, mono);
    let openings = collect_openings(p, &frame);
    let mut occ = vec![(faces.len() + openings.len()) as f64];
    for f in &faces {
        occ.extend([f.depth_max, f.pts.len() as f64]);
        for q in &f.pts {
            occ.extend(q);
        }
    }
    for op in &openings {
        occ.extend([op.depth, 4.0]);
        for q in &op.pts {
            occ.extend(q);
        }
    }
    let occluded = {
        let mut b = vec![openings.len() as f64];
        for op in &openings {
            let q = &op.pts;
            b.extend([(q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4.0, (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4.0, op.depth]);
        }
        crate::plan_elevation::occluded_points(&occ, &b)
    };

    let mut acc = Acc::new();
    // Jede Fläche trägt ihre Bauteilfarbe (Wand/Decke aus dem 3D-Modell, Dach aus der Eindeckung).
    let fill_for = |fill: [f64; 3]| -> String { if mono { "#ffffff".into() } else { rgb_to_hex(fill) } };
    let mut items: Vec<Item> = Vec::new();
    let mut seq = 0usize;
    let mut pending: Vec<Pending> = Vec::new();

    let assembled: std::collections::HashSet<&str> = p.roofs.as_deref().unwrap_or(&[]).iter().enumerate().filter(|(i, _)| crate::roof_assembly::is_assembled(p, *i)).map(|(_, r)| r.id.as_str()).collect();
    let mut roof_edges: HashMap<String, Vec<usize>> = HashMap::new();
    for (fi, f) in faces.iter().enumerate() {
        if f.role != Role::Roof || f.id.is_empty() {
            continue;
        }
        for i in 0..f.pts.len() {
            roof_edges.entry(edge_key(f.pts[i], f.pts[(i + 1) % f.pts.len()])).or_default().push(fi);
        }
    }
    let coplanar_seam = |fi: usize, a: Pt, b: Pt| -> bool {
        let f = &faces[fi];
        if f.role != Role::Roof || f.id.is_empty() {
            return false;
        }
        let same = |oi: usize| {
            let o = &faces[oi];
            oi != fi && o.id == f.id && f.normal[0] * o.normal[0] + f.normal[1] * o.normal[1] + f.normal[2] * o.normal[2] > 1.0 - 1e-7
        };
        if roof_edges.get(&edge_key(a, b)).is_some_and(|list| list.iter().any(|&oi| same(oi))) {
            return true;
        }
        // Verschnittene Dächer ([G5]): Fugen zwischen Streifen derselben Fläche mit T-Stoss — die Kante
        // liegt (an Stichproben) auf Kanten koplanarer Nachbarflächen.
        if !assembled.contains(f.id.as_str()) {
            return false;
        }
        let near = |s: Pt| {
            faces.iter().enumerate().filter(|(oi, _)| same(*oi)).any(|(_, o)| {
                (0..o.pts.len()).any(|k| {
                    let (c, d) = (o.pts[k], o.pts[(k + 1) % o.pts.len()]);
                    let (dx, dy) = (d[0] - c[0], d[1] - c[1]);
                    let l2 = dx * dx + dy * dy;
                    if l2 < 1e-18 {
                        return false;
                    }
                    let t = ((s[0] - c[0]) * dx + (s[1] - c[1]) * dy) / l2;
                    let (qx, qy) = (c[0] + dx * t, c[1] + dy * t);
                    (-1e-9..=1.0 + 1e-9).contains(&t) && (s[0] - qx).powi(2) + (s[1] - qy).powi(2) < 1e-12
                })
            })
        };
        [0.1, 0.3, 0.5, 0.7, 0.9].iter().all(|&t| near([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]))
    };
    // [T2] Bogenwände: Stossfugen der Sehnen-Teilkörper nicht als Kante zeichnen (die Fläche wirkt
    // gekrümmt statt facettiert). Eine senkrechte Kante gilt als Fuge, wenn eine andere Fläche derselben
    // Wand mit fast gleicher Normale, gleicher Blickseite (nicht die Silhouette) dort ebenfalls eine
    // senkrechte Kante hat (Toleranz 2 cm: die Teilquader enden rechtwinklig, nicht auf der Gehrung).
    let arc_ids: std::collections::HashSet<&str> = p.walls.iter().filter(|w| crate::wall_arc::WallArc::of_wall(w).is_some()).map(|w| w.id.as_str()).collect();
    let view_n = [frame[3], frame[4], frame[5]];
    let facing = |f: &Face| f.normal[0] * view_n[0] + f.normal[1] * view_n[1] + f.normal[2] * view_n[2];
    let mut arc_faces: HashMap<&str, Vec<usize>> = HashMap::new();
    for (fi, f) in faces.iter().enumerate() {
        if f.role == Role::Wall && arc_ids.contains(f.id.as_str()) {
            arc_faces.entry(f.id.as_str()).or_default().push(fi);
        }
    }
    let smooth_seam = |fi: usize, a: Pt, b: Pt| -> bool {
        let f = &faces[fi];
        if f.role != Role::Wall || (a[0] - b[0]).abs() > 1e-6 {
            return false;
        }
        let Some(list) = arc_faces.get(f.id.as_str()) else { return false };
        let (lo, hi) = (a[1].min(b[1]), a[1].max(b[1]));
        let side = facing(f);
        list.iter().any(|&oi| {
            let o = &faces[oi];
            if oi == fi || f.normal[0] * o.normal[0] + f.normal[1] * o.normal[1] + f.normal[2] * o.normal[2] < 0.98 || facing(o) * side <= 0.0 {
                return false;
            }
            (0..o.pts.len()).any(|i| {
                let (c, d) = (o.pts[i], o.pts[(i + 1) % o.pts.len()]);
                (c[0] - d[0]).abs() < 1e-6 && (c[0] - a[0]).abs() < 0.02 && c[1].min(d[1]) < hi - 1e-6 && c[1].max(d[1]) > lo + 1e-6
            })
        })
    };
    let mut group_order: Vec<u64> = Vec::new();
    let mut groups: HashMap<u64, (Vec<usize>, f64)> = HashMap::new();
    for (fi, f) in faces.iter().enumerate() {
        let pts: Vec<Vec2> = f
            .pts
            .iter()
            .map(|q| {
                acc.add(q[0], q[1]);
                v2(q[0], q[1])
            })
            .collect();
        let is_roof = f.role == Role::Roof;
        let frontal = !is_roof && f.depth_max - f.depth_min < 1e-4;
        if frontal {
            let gk = num_key(round(f.depth * 1e4));
            groups
                .entry(gk)
                .or_insert_with(|| {
                    group_order.push(gk);
                    (Vec::new(), f.depth)
                })
                .0
                .push(fi);
        } else {
            for i in 0..f.pts.len() {
                let a = f.pts[i];
                let b = f.pts[(i + 1) % f.pts.len()];
                if coplanar_seam(fi, a, b) || smooth_seam(fi, a, b) {
                    continue;
                }
                pending.push(Pending::Line { a, b, depth: f.depth_min - EPS * 5.0, style: None, paint: None });
            }
        }
        // Verschnittene Dächer ([G5]) kommen teils als Dreiecke: ein Hauch Kontur in der Füllfarbe deckt
        // die Haarfugen zwischen ihnen.
        let fill = fill_for(f.fill);
        let seam = is_roof && assembled.contains(f.id.as_str());
        let mut prim = if seam { polygon(pts, &fill, &fill, 0.15, no_hatch()) } else { polygon(pts, &fill, "none", 0.0, no_hatch()) };
        if let Primitive::Polygon { greyed: g, wall_id, ceiling_id, roof_id, .. } = &mut prim {
            *g = Some(greyed(f));
            if !f.id.is_empty() {
                match f.role {
                    Role::Wall => *wall_id = Some(f.id.clone()),
                    Role::Slab => *ceiling_id = Some(f.id.clone()),
                    Role::Roof => *roof_id = Some(f.id.clone()),
                }
            }
        }
        let rank = match f.role {
            Role::Slab => 0.0,
            Role::Wall => 1.0,
            Role::Roof => 2.0,
        };
        pending.push(Pending::Item { depth: f.depth, rank: Some(rank), prim });
    }
    for gk in &group_order {
        let (list, depth) = &groups[gk];
        let mut b = vec![list.len() as f64];
        for &fi in list {
            b.push(faces[fi].pts.len() as f64);
            for q in &faces[fi].pts {
                b.extend(q);
            }
        }
        let e = crate::plan_elevation::xor_outline(&b);
        for k in 0..e.first().copied().unwrap_or(0.0) as usize {
            let i = 1 + 4 * k;
            pending.push(Pending::Line { a: [e[i], e[i + 1]], b: [e[i + 2], e[i + 3]], depth: depth - EPS * 5.0, style: None, paint: None });
        }
    }
    for (a, b, depth, paint, k) in pattern_lines {
        pending.push(Pending::Line { a, b, depth, style: Some(k), paint: Some(paint) });
    }
    // Linien gebündelt gegen die Verdecker clippen (`flushPending`).
    {
        let mut q = vec![0.0];
        for pd in &pending {
            if let Pending::Line { a, b, depth, .. } = pd {
                q.extend([a[0], a[1], b[0], b[1], *depth]);
                q[0] += 1.0;
            }
        }
        let r = crate::plan_elevation::clip_segments(&occ, &q);
        let mut i = 1;
        for pd in pending {
            match pd {
                Pending::Item { depth, rank, prim } => {
                    items.push(Item { depth, seq, rank, prim });
                    seq += 1;
                }
                Pending::Line { a, b, depth, style, paint } => {
                    let c = if r.is_empty() {
                        1
                    } else {
                        i += 1;
                        r[i - 1] as usize
                    };
                    for _ in 0..c {
                        let (sa, sb) = if r.is_empty() {
                            (a, b)
                        } else {
                            let s = ([r[i], r[i + 1]], [r[i + 2], r[i + 3]]);
                            i += 4;
                            s
                        };
                        acc.add(sa[0], sa[1]);
                        acc.add(sb[0], sb[1]);
                        let prim = match style.and_then(|k| pattern_styles.get(k)) {
                            Some((w, c)) => line(v2(sa[0], sa[1]), v2(sb[0], sb[1]), "elevation-surface-pattern", *w, c),
                            None => outline_line(sa, sb),
                        };
                        items.push(Item { depth: paint.unwrap_or(depth), seq, rank: None, prim });
                        seq += 1;
                    }
                }
            }
        }
    }

    if shadows {
        let wall_faces: Vec<&Face> = faces.iter().filter(|f| f.role == Role::Wall).collect();
        let mut casters: Vec<&Face> = faces.iter().filter(|f| f.role == Role::Slab).collect();
        casters.extend(faces.iter().filter(|f| f.role == Role::Roof));
        let f = crate::plan_elevation::shadows(&encode_shadow_faces(&wall_faces), &encode_shadow_faces(&casters));
        let mut i = 1;
        for _ in 0..f.first().copied().unwrap_or(0.0) as usize {
            let depth = f[i];
            let count = f[i + 1] as usize;
            i += 2;
            let pts: Vec<Vec2> = (0..count)
                .map(|j| {
                    let (x, y) = (f[i + 2 * j], f[i + 2 * j + 1]);
                    acc.add(x, y);
                    v2(x, y)
                })
                .collect();
            i += 2 * count;
            items.push(Item { depth: depth - EPS * 10.0, seq, rank: None, prim: polygon(pts, SHADOW_FILL, "none", 0.0, no_hatch()) });
            seq += 1;
        }
    }

    for (k, op) in openings.iter().enumerate() {
        if occluded.get(1 + k) == Some(&1.0) {
            continue;
        }
        let mut to_vec = |q: &[Pt]| -> Vec<Vec2> {
            q.iter()
                .map(|p| {
                    acc.add(p[0], p[1]);
                    v2(p[0], p[1])
                })
                .collect()
        };
        let d = op.depth - EPS * 100.0;
        let id = Some(op.id.as_str());
        // Formöffnung: das Rechteck-Loch der Wand ausserhalb des Umrisses in Wandfarbe schliessen.
        if let Some((_, _, fills, wid)) = &op.shape {
            let wall_fill = faces.iter().find(|f| f.role == Role::Wall && f.id == *wid).map_or("#ffffff".to_string(), |f| fill_for(f.fill));
            for q in fills {
                let pts = to_vec(q);
                items.push(Item { depth: d + EPS * 10.0, seq, rank: None, prim: polygon(pts, &wall_fill, "none", 0.0, no_hatch()) });
                seq += 1;
            }
        }
        let mut push = |prim: Primitive| {
            items.push(Item { depth: d, seq, rank: None, prim });
            seq += 1;
        };
        let frame_pts = op.shape.as_ref().map_or(op.frame.as_ref().map_or(&op.pts[..], |f| &f[..]), |(o, _, _, _)| &o[..]);
        push(poly_prim(to_vec(frame_pts), if mono { "#ffffff" } else { FRAME_FILL_COLOR }, EDGE_INK, FRAME_MM, id));
        if let Some((_, g, _, _)) = &op.shape {
            push(poly_prim(to_vec(g), if mono { GLASS_FILL_MONO } else { GLASS_FILL_COLOR }, EDGE_INK, EDGE_MM, id));
        }
        for r in &op.sill {
            push(poly_prim(to_vec(r), if mono { "#ffffff" } else { SILL_FILL_COLOR }, EDGE_INK, EDGE_MM, id));
        }
        for r in &op.sash_rects {
            push(poly_prim(to_vec(r), "none", EDGE_INK, EDGE_MM, id));
        }
        for r in &op.glass {
            push(poly_prim(to_vec(r), if mono { GLASS_FILL_MONO } else { GLASS_FILL_COLOR }, EDGE_INK, EDGE_MM, id));
        }
        for r in &op.door_leaf {
            push(poly_prim(to_vec(r), if mono { "#ffffff" } else { DOOR_LEAF_FILL_COLOR }, EDGE_INK, EDGE_MM, id));
        }
        if shadows && op.shape.is_none() {
            let q = &op.pts;
            let lerp = |a: Pt, b: Pt, t: f64| -> Pt { [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t] };
            let quad_at = |fa: f64, fz: f64| lerp(lerp(q[0], q[1], fa), lerp(q[3], q[2], fa), fz);
            let w_u = hypot2(q[1][0] - q[0][0], q[1][1] - q[0][1]);
            let h_v = hypot2(q[3][0] - q[0][0], q[3][1] - q[0][1]);
            let f_u = min(0.3, 0.08 / max(w_u, 1e-6));
            let f_v = min(0.3, 0.08 / max(h_v, 1e-6));
            for (fa0, fa1, fz0, fz1) in [(0.0, 1.0, 1.0 - f_v, 1.0), (0.0, f_u, 0.0, 1.0 - f_v)] {
                let r = [quad_at(fa0, fz0), quad_at(fa1, fz0), quad_at(fa1, fz1), quad_at(fa0, fz1)];
                push(polygon(to_vec(&r), OPENING_SHADOW_FILL, "none", 0.0, no_hatch()));
            }
        }
        for (a, b) in &op.divisions {
            push(line(v2(a[0], a[1]), v2(b[0], b[1]), "elevation-division", EDGE_MM, EDGE_INK));
        }
        for (a, b) in &op.symbol {
            let mut l = line(v2(a[0], a[1]), v2(b[0], b[1]), "elevation-opening-symbol", 0.1, SYMBOL_INK);
            if let Primitive::Line { dash, .. } = &mut l {
                *dash = Some(Some(vec![2.2, 1.8]));
            }
            push(l);
        }
    }

    // Painter: fern zuerst; Gleichstand nach Rang (Decke < Wand < Dach < Rest), dann Reihenfolge.
    let nz = |d: f64| if d.is_nan() { 0.0 } else { d };
    items.sort_by(|a, b| {
        let d = nz(b.depth - a.depth);
        if d != 0.0 {
            return super::section::cmp_num(d);
        }
        let r = nz(a.rank.unwrap_or(3.0) - b.rank.unwrap_or(3.0));
        if r != 0.0 {
            return super::section::cmp_num(r);
        }
        a.seq.cmp(&b.seq)
    });
    let mut prims: Vec<Primitive> = items.into_iter().map(|it| it.prim).collect();
    if acc.min_x.is_finite() && acc.min_y.is_finite() {
        prims.push(line(v2(acc.min_x, acc.min_y), v2(acc.max_x, acc.min_y), "elevation-ground", GROUND_MM, GROUND_INK));
    }
    Ok(Some((prims, acc.bounds())))
}

/// Bauteil der sichtbaren Wandseite: rechts der Achse (Anfang → Ende) liegt die äusserste Schicht
/// (`layers[0]`), links die innerste; Stirnseiten haben keine.
fn wall_side_component<'a>(p: &'a Project, wall: &Wall, normal: [f64; 3]) -> Option<&'a Component> {
    let (dx, dy) = (wall.end.x - wall.start.x, wall.end.y - wall.start.y);
    let len = hypot2(dx, dy);
    if !(len > 1e-9) {
        return None;
    }
    // Plan (x, y) → Welt (x, Höhe, y); rechte Normale (dy, −dx).
    let side = (dy * normal[0] - dx * normal[2]) / len;
    let layers = &p.wall_type(wall)?.layers;
    let l = if side > 0.7 {
        layers.first()
    } else if side < -0.7 {
        layers.last()
    } else {
        None
    }?;
    p.component(&l.component_id)
}

/// Strichstärke und Farbe einer Ansichtsschraffur.
fn pattern_style(sp: &SurfacePattern, comp: &Component) -> (f64, String) {
    let w = sp.weight_mm.filter(|w| w.is_finite() && *w > 0.0).unwrap_or(0.1);
    let c = sp.color.clone().or_else(|| comp.foreground.clone()).filter(|c| !c.trim().is_empty()).unwrap_or_else(|| PATTERN_INK.into());
    (w, c)
}

const PATTERN_INK: &str = "#3a3f47";

/// Linie der Ansichtsschraffur: Endpunkte, Verdeckungstiefe, Maler-Tiefe, Stil-Index.
type PatternLine = (Pt, Pt, f64, f64, usize);

/// Ansichtsfarbe (`Component.elevationColor`) der sichtbaren Seite auf die Flächen legen und die
/// Ansichtsschraffur ([100]) als Linien liefern: Wände in Wand-Koordinaten (x ab Wandanfang, y ab UK),
/// Dachflächen traufparallel/in Falllinie (`surface_pattern::segments_3d`). Tiefe je Linie = nächster
/// Endpunkt (knapp vor der Fläche), damit die Verdeckung wie bei den Kanten greift.
fn surface_patterns(p: &Project, faces: &mut [Face], frame: &[f64; 9], scale: f64, mono: bool) -> (Vec<PatternLine>, Vec<(f64, String)>) {
    use crate::surface_pattern as sp;
    let mut lines: Vec<PatternLine> = Vec::new();
    let mut styles: Vec<(f64, String)> = Vec::new();
    let (pp, nn, uu) = ([frame[0], frame[1], frame[2]], [frame[3], frame[4], frame[5]], [frame[6], frame[7], frame[8]]);
    let proj = |w: [f64; 3]| -> (f64, f64, f64) {
        let r = [w[0] - pp[0], w[1] - pp[1], w[2] - pp[2]];
        (r[0] * uu[0] + r[1] * uu[1] + r[2] * uu[2], w[1], r[0] * nn[0] + r[1] * nn[1] + r[2] * nn[2])
    };
    let mut walls: HashMap<&str, &Wall> = HashMap::new();
    for w in &p.walls {
        walls.entry(w.id.as_str()).or_insert(w);
    }
    for f in faces.iter_mut() {
        if f.role != Role::Wall || f.id.is_empty() || f.pts.len() < 3 {
            continue;
        }
        let Some(wall) = walls.get(f.id.as_str()).copied() else { continue };
        let Some(comp) = wall_side_component(p, wall, f.normal) else { continue };
        if !mono {
            if let Some(c) = comp.elevation_color.as_deref().filter(|c| !c.trim().is_empty()) {
                f.fill = hex_to_rgb(c, f.fill);
            }
        }
        let Some(pat) = comp.surface_pattern.as_ref() else { continue };
        let Some(spec) = sp::spec_of(pat, wall.surface_pattern_angle.unwrap_or(0.0)) else { continue };
        let (dx, dy) = (wall.end.x - wall.start.x, wall.end.y - wall.start.y);
        let len = hypot2(dx, dy);
        let t = [dx / len, 0.0, dy / len];
        let k = t[0] * uu[0] + t[2] * uu[2];
        if k.abs() < 0.05 {
            continue; // fast von der Seite gesehen
        }
        let kd = (t[0] * nn[0] + t[2] * nn[2]) / k; // Tiefe je u entlang der Fläche
        let mean_u = f.pts.iter().map(|q| q[0]).sum::<f64>() / f.pts.len() as f64;
        let depth_at = |u: f64| f.depth + (u - mean_u) * kd;
        let z0 = p.wall_vertical_extent(wall).0;
        let (u0, _, _) = proj([wall.start.x, 0.0, wall.start.y]);
        let local: Vec<sp::P> = f.pts.iter().map(|q| [(q[0] - u0) / k, q[1] - z0]).collect();
        let off = wall.surface_pattern_offset.as_ref().map_or([0.0, 0.0], |o| [o.x, o.y]);
        let segs = sp::segments(&local, &spec, off, scale);
        if segs.is_empty() {
            continue;
        }
        styles.push(pattern_style(pat, comp));
        let si = styles.len() - 1;
        for (s0, s1) in segs {
            let (qa, qb) = ([u0 + k * s0[0], s0[1] + z0], [u0 + k * s1[0], s1[1] + z0]);
            let d = min(depth_at(qa[0]), depth_at(qb[0])) - EPS * 5.0;
            lines.push((qa, qb, d, f.depth - EPS * 5.0, si));
        }
    }
    // Dachflächen: äusserste Schicht (Eindeckung).
    for roof in p.roofs.as_deref().unwrap_or(&[]) {
        let Some(comp) = p.roof_layers(roof).first().filter(|l| !l.component_id.is_empty()).and_then(|l| p.component(&l.component_id)) else { continue };
        if !mono && roof.color.as_deref().is_none_or(|c| c.is_empty()) {
            if let Some(c) = comp.elevation_color.as_deref().filter(|c| !c.trim().is_empty()) {
                for f in faces.iter_mut().filter(|f| f.role == Role::Roof && f.id == roof.id) {
                    f.fill = hex_to_rgb(c, f.fill);
                }
            }
        }
        let Some(pat) = comp.surface_pattern.as_ref() else { continue };
        let Some(spec) = sp::spec_of(pat, roof.surface_pattern_angle.unwrap_or(0.0)) else { continue };
        let g = crate::roof::roof_geometry(&roof.params(), p.roof_base_elevation(roof));
        let off = roof.surface_pattern_offset.as_ref().map_or([0.0, 0.0], |o| [o.x, o.y]);
        let mut si: Option<usize> = None;
        for plane in &g.planes {
            if plane.len() < 3 {
                continue;
            }
            // Flächennormale (Plan-Koordinaten, aufwärts); sichtbar, wenn sie zum Betrachter zeigt.
            let mut n = [0.0; 3];
            for i in 0..plane.len() {
                let (a, b) = (plane[i], plane[(i + 1) % plane.len()]);
                n[0] += (a[1] - b[1]) * (a[2] + b[2]);
                n[1] += (a[2] - b[2]) * (a[0] + b[0]);
                n[2] += (a[0] - b[0]) * (a[1] + b[1]);
            }
            if n[2] < 0.0 {
                n = [-n[0], -n[1], -n[2]];
            }
            if nn[0] * n[0] + nn[1] * n[2] + nn[2] * n[1] >= -1e-9 {
                continue;
            }
            // Maler-Tiefe der Fläche wie `project_face`: Mittel der Eckentiefen.
            let face_depth = plane.iter().map(|q| proj([q[0], q[2], q[1]]).2).sum::<f64>() / plane.len() as f64;
            for (a, b) in sp::segments_3d(plane, &spec, off, scale) {
                let (ua, va, da) = proj([a[0], a[2], a[1]]);
                let (ub, vb, db) = proj([b[0], b[2], b[1]]);
                if da <= EPS || db <= EPS {
                    continue;
                }
                let k = *si.get_or_insert_with(|| {
                    styles.push(pattern_style(pat, comp));
                    styles.len() - 1
                });
                lines.push(([ua, va], [ub, vb], min(da, db) - EPS * 5.0, face_depth - EPS * 5.0, k));
            }
        }
    }
    if mono {
        for s in &mut styles {
            s.1 = PATTERN_INK.into();
        }
    }
    (lines, styles)
}

/// Abfrage `elevationPlan`: `args` = `[mono, shadows]`, `text` = `{"level": {...}, "hasVis", "invisible",
/// "hasDisplay", "norender", "grey"}`. Puffer mit einer Gruppe und Ausmass; ohne Ansichtslinie ohne Gruppen.
pub fn elevation_plan_buf(p: &Project, args: &[f64], text: &str) -> Result<Vec<u8>, String> {
    let v: serde_json::Value = serde_json::from_str(text).map_err(|e| format!("Ansicht-Argumente: {e}"))?;
    let level = LevelSpec::from_json(v.get("level").unwrap_or(&serde_json::Value::Null));
    let vis = Visibility::from_json(&v);
    let mono = args.first().is_some_and(|&x| x != 0.0);
    let shadows = args.get(1).is_some_and(|&x| x != 0.0);
    // Massstab für die Ausdünnung der Ansichtsschraffur (fehlt er: 1:100).
    let scale = args.get(2).copied().filter(|s| s.is_finite() && *s > 0.0).unwrap_or(100.0);
    let mut w = crate::plan_buf::Writer::new(true);
    if let Some((prims, bounds)) = elevation_primitives(p, &level, shadows, mono, &vis, scale)? {
        w.group(&prims);
        w.bounds = Some(bounds);
    }
    Ok(w.finish())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Project {
        serde_json::from_str(include_str!("../../tests/fixtures/sample_project.json")).unwrap()
    }

    #[test]
    fn farben_wie_ts() {
        assert_eq!(rgb_to_hex([1.0, 0.0, 0.5]), "#ff0080");
        assert_eq!(rgb_to_hex([f64::NAN, 2.0, -1.0]), "#NaNff00");
        assert_eq!(hex_to_rgb(" #ff0000 ", [0.0; 3]), [1.0, 0.0, 0.0]);
        assert_eq!(hex_to_rgb("#abc", [0.5; 3]), [0.5; 3]);
    }

    #[test]
    fn beispiel_ansicht() {
        let p = sample();
        let l = p.drawing_levels.iter().find(|l| l.id == "ansicht-sued").unwrap();
        let level = LevelSpec::from_json(&serde_json::to_value(l).unwrap());
        let (prims, b) = elevation_primitives(&p, &level, true, false, &Visibility::default(), 100.0).unwrap().unwrap();
        let json = serde_json::to_string(&prims).unwrap();
        assert!(json.contains("\"wallId\":\"W1\"") && json.contains("\"openingId\":\"O1\"") && json.contains("elevation-ground"), "{json}");
        assert!(json.contains("#8f959e"), "Schlagschatten fehlt");
        assert!(b[2] > b[0]);
        // Painter: die Bodenlinie zuletzt
        assert!(matches!(prims.last(), Some(Primitive::Line { cls, .. }) if cls == "elevation-ground"));
    }

    fn render(p: &Project, scale: f64) -> String {
        let l = p.drawing_levels.iter().find(|l| l.id == "ansicht-sued").unwrap();
        let level = LevelSpec::from_json(&serde_json::to_value(l).unwrap());
        let (prims, _) = elevation_primitives(p, &level, false, false, &Visibility::default(), scale).unwrap().unwrap();
        serde_json::to_string(&prims).unwrap()
    }

    /// [G2] Wände unter dem Dach: in der Traufansicht verdeckt das Dach Giebel- und Innenwände (keine
    /// Wandfläche über der Traufkante), in der Giebelansicht steht die Giebelwand bis unter das Dach.
    #[test]
    fn waende_unter_dem_dach_in_der_ansicht() {
        let p: Project = serde_json::from_value(serde_json::json!({
            "id": "p", "name": "t", "lineStyles": [], "hatches": [], "components": [], "wallTypes": [], "layers": [], "drawings2d": [], "openings": [],
            "drawingLevels": [
                {"id": "F", "name": "EG", "kind": "floor", "visible": true, "locked": false, "floorHeight": 3.0, "baseElevation": 0},
                {"id": "s", "name": "S", "kind": "elevation", "visible": true, "locked": false, "linePoints": [{"x": -2, "y": -3}, {"x": 12, "y": -3}], "directionSign": 1},
                {"id": "w", "name": "W", "kind": "elevation", "visible": true, "locked": false, "linePoints": [{"x": -3, "y": 10}, {"x": -3, "y": -2}], "directionSign": 1}
            ],
            "walls": [
                {"id": "WS", "type": "wall", "floorId": "F", "categoryCode": "20", "start": {"x": 0, "y": 0}, "end": {"x": 10, "y": 0}, "height": 3.5},
                {"id": "WW", "type": "wall", "floorId": "F", "categoryCode": "20", "start": {"x": 0, "y": 8}, "end": {"x": 0, "y": 0}, "height": 9.0},
                {"id": "WI", "type": "wall", "floorId": "F", "categoryCode": "20", "start": {"x": 5, "y": 0}, "end": {"x": 5, "y": 8}, "height": 9.0}
            ],
            "roofs": [{"id": "R", "type": "roof", "floorId": "F", "categoryCode": "35",
                "outline": [{"x": 0, "y": 0}, {"x": 10, "y": 0}, {"x": 10, "y": 8}, {"x": 0, "y": 8}],
                "shape": "sattel", "pitchDeg": 45, "overhang": 0.5, "overhangGable": 0.3, "ridgeAxis": "x", "thickness": 0.3}]
        }))
        .unwrap();
        let view = |id: &str| {
            let l = p.drawing_levels.iter().find(|l| l.id == id).unwrap();
            let level = LevelSpec::from_json(&serde_json::to_value(l).unwrap());
            elevation_primitives(&p, &level, false, false, &Visibility::default(), 100.0).unwrap().unwrap().0
        };
        let wall_top = |prims: &[Primitive], id: &str| -> f64 {
            prims
                .iter()
                .filter_map(|q| match q {
                    Primitive::Polygon { pts, wall_id: Some(w), .. } if w == id => Some(pts.iter().map(|v| v.y).fold(f64::NEG_INFINITY, f64::max)),
                    _ => None,
                })
                .fold(f64::NEG_INFINITY, f64::max)
        };
        // Traufe: Oberkante der Dachfläche an der Vorderkante (tiefster Punkt der Dachflächen).
        let r = &p.roofs.as_ref().unwrap()[0];
        let eave = crate::roof::roof_geometry(&r.params(), p.roof_base_elevation(r)).planes.iter().flatten().map(|q| q[2]).fold(f64::INFINITY, f64::min);
        let s = view("s");
        // Sichtbar bis unter die Traufstirn (Dicke 0.3 senkrecht zur 45°-Fläche: 0.3·cos 45° tiefer).
        let fascia = eave - 0.3 * 0.5f64.sqrt();
        assert!(wall_top(&s, "WW") <= fascia + 1e-3 && wall_top(&s, "WI") <= fascia + 1e-3, "{} {} {fascia}", wall_top(&s, "WW"), wall_top(&s, "WI"));
        assert!((wall_top(&s, "WS") - fascia).abs() < 1e-3, "Traufwand bis zur Traufstirn sichtbar: {}", wall_top(&s, "WS"));
        // Giebel: First-Unterkante = Traufkante 3.0 + 4.5 (bei 45°) − 0.3·√2.
        let w = view("w");
        let ridge_under = 7.5 - 0.3 * 2f64.sqrt();
        assert!((wall_top(&w, "WW") - ridge_under).abs() < 1e-6, "{}", wall_top(&w, "WW"));
    }

    /// [T2] Bogenwand in der Ansicht: keine Facetten-Fugen der Sehnen-Teilkörper, Umriss bleibt.
    #[test]
    fn bogenwand_ohne_facettenfugen() {
        let mut p = sample();
        p.walls.retain(|w| w.id == "W1");
        p.openings = Some(vec![]);
        p.roofs = Some(vec![]);
        p.ceilings = Some(vec![]);
        p.stairs = Some(vec![]);
        p.walls[0].bulge = Some(-0.5); // Bogen nach Süden, zur Ansicht hin (vor der Ansichtslinie y = −2)
        let l = p.drawing_levels.iter().find(|l| l.id == "ansicht-sued").unwrap();
        let level = LevelSpec::from_json(&serde_json::to_value(l).unwrap());
        let (prims, _) = elevation_primitives(&p, &level, false, false, &Visibility::default(), 100.0).unwrap().unwrap();
        let mut inner = Vec::new();
        let mut all = 0;
        for pr in &prims {
            if let Primitive::Line { a, b, cls, .. } = pr {
                if cls == "elevation-outline" && (a.x - b.x).abs() < 1e-6 {
                    all += 1;
                    // Ansichts-x = Welt-x + 1 (Ansichtslinie ab x = −1); die Wand reicht von 1 bis 6.
                    if a.x > 1.3 && a.x < 5.7 {
                        inner.push(a.x);
                    }
                }
            }
        }
        assert!(all >= 2, "Silhouette fehlt");
        assert!(inner.is_empty(), "Facetten-Fugen: {inner:?}");
    }

    #[test]
    fn ansichtsschraffur_und_ansichtsfarbe_der_aussenschicht() {
        let mut p = sample();
        assert!(!render(&p, 50.0).contains("elevation-surface-pattern"), "ohne Muster keine Linien");
        let outer = p.wall_types.iter().find(|t| t.id == "aw").unwrap().layers[0].component_id.clone();
        let c = p.components.iter_mut().find(|c| c.id == outer).unwrap();
        c.elevation_color = Some("#123456".into());
        c.surface_pattern = Some(SurfacePattern { kind: SurfacePatternKind::Lines, spacing: 0.1, ..Default::default() });
        let fine = render(&p, 50.0);
        let n_fine = fine.matches("elevation-surface-pattern").count();
        assert!(n_fine > 20, "{n_fine}");
        assert!(fine.contains("#123456"), "Ansichtsfarbe der Aussenschicht");
        let n_mid = render(&p, 200.0).matches("elevation-surface-pattern").count();
        assert!(n_mid < n_fine && n_mid > 0, "{n_mid} vs {n_fine}");
        assert_eq!(render(&p, 2000.0).matches("elevation-surface-pattern").count(), 0, "grob: weggelassen");
    }

    /// [G3] Formöffnung: Rahmen als Umriss (viele Ecken), Glas eingerückt; [103] Dachfenster auf der
    /// Südfläche sichtbar.
    #[test]
    fn formoeffnung_und_dachfenster_in_der_ansicht() {
        let mut p = sample();
        for o in p.openings.iter_mut().flatten().filter(|o| o.id == "O1") {
            o.shape = Some(OpeningShape::Rund);
        }
        p.openings.as_mut().unwrap().push(Opening { id: "DF".into(), kind: ElementKind::Window, category_code: "21".into(), width: 0.78, height: 1.18, host_roof_id: Some("RF1".into()), host_point: Some(Vec2 { x: 2.5, y: 1.0 }), ..Default::default() });
        let l = p.drawing_levels.iter().find(|l| l.id == "ansicht-sued").unwrap();
        let level = LevelSpec::from_json(&serde_json::to_value(l).unwrap());
        let (prims, _) = elevation_primitives(&p, &level, false, false, &Visibility::default(), 100.0).unwrap().unwrap();
        let polys = |id: &str| -> Vec<usize> { prims.iter().filter_map(|pr| if let Primitive::Polygon { pts, opening_id: Some(o), .. } = pr { (o == id).then_some(pts.len()) } else { None }).collect() };
        let o1 = polys("O1");
        assert!(o1.len() == 2 && o1.iter().all(|n| *n >= 40), "Rahmen + Glas als Ellipse: {o1:?}");
        assert_eq!(polys("DF"), vec![4, 4], "Dachfenster: Rahmen + Glas");
        let first_df = prims.iter().position(|pr| matches!(pr, Primitive::Polygon { opening_id: Some(o), .. } if o == "DF")).unwrap();
        // Dachflächen, die das Dachfenster überdecken (die Traufstirn [G2] liegt davor, berührt es nicht).
        let bb = |pts: &[Vec2]| pts.iter().fold([f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY], |b, q| [b[0].min(q.x), b[1].min(q.y), b[2].max(q.x), b[3].max(q.y)]);
        let Primitive::Polygon { pts: df_pts, .. } = &prims[first_df] else { unreachable!() };
        let d = bb(df_pts);
        let last_roof = prims
            .iter()
            .rposition(|pr| matches!(pr, Primitive::Polygon { roof_id: Some(_), pts, .. } if { let r = bb(pts); r[0] < d[2] && r[2] > d[0] && r[1] < d[3] && r[3] > d[1] }))
            .unwrap();
        assert!(first_df > last_roof, "Dachfenster vor der Dachfläche gezeichnet");
    }

    /// [105] Umfassungszarge in der Ansicht: Spiegel über die Rohbaukante hinaus (Rahmen breiter als
    /// die Öffnung), Blatt um die Zarge eingerückt.
    #[test]
    fn zargenspiegel_in_der_ansicht() {
        let mut p = sample();
        let o1 = p.openings.iter().flatten().find(|o| o.id == "O1").unwrap().clone();
        let frame_w = |p: &Project| -> f64 {
            let l = p.drawing_levels.iter().find(|l| l.id == "ansicht-sued").unwrap();
            let level = LevelSpec::from_json(&serde_json::to_value(l).unwrap());
            let (prims, _) = elevation_primitives(p, &level, false, false, &Visibility::default(), 100.0).unwrap().unwrap();
            let pr = prims.iter().find(|pr| matches!(pr, Primitive::Polygon { opening_id: Some(o), .. } if o == "O1")).unwrap();
            let Primitive::Polygon { pts, .. } = pr else { unreachable!() };
            pts.iter().map(|q| q.x).fold(f64::NEG_INFINITY, f64::max) - pts.iter().map(|q| q.x).fold(f64::INFINITY, f64::min)
        };
        let door = |kind: Option<DoorTypeFrameKind>| {
            let mut q = p.clone();
            q.door_types = Some(vec![DoorType { id: "dt".into(), frame_kind: kind, ..Default::default() }]);
            for o in q.openings.iter_mut().flatten().filter(|o| o.id == "O1") {
                o.kind = ElementKind::Door;
                o.type_id = Some("dt".into());
                o.sill_height = 0.0;
            }
            q
        };
        let plain = frame_w(&door(None));
        assert!((plain - o1.width).abs() < 1e-6, "{plain}");
        let zarge = frame_w(&door(Some(DoorTypeFrameKind::Umfassungszarge)));
        assert!((zarge - o1.width - 0.1).abs() < 1e-6, "{zarge}");
        p.openings = None;
    }
}
