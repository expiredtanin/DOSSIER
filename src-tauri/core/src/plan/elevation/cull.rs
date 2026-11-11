//! Dachflächen als Verdeckung: Stirnflächen der Dachscheibe (`fascia_quads()`) und das Weglassen von Wand-
//! und Bauteilflächen unter dem Dach (`cull_under_roofs()`, [G2]). Gerufen von `elevation_primitives_with()`
//! in `mod.rs`; `fascia_quads()` auch vom Schnitt.

use super::*;

/// Stirnflächen der Dachscheibe an den freien Rändern der Dachflächen (Traufe, Ortgang): je Rand ein
/// Viereck von der Oberkante senkrecht zur Fläche um die Dicke nach innen (wie die 3D-Schichten).
pub(crate) fn fascia_quads(planes: &[Vec<[f64; 3]>], total: f64) -> Vec<[[f64; 3]; 4]> {
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
    pub(super) top: Vec<crate::wall_bands::RoofFacet>,
    under: Vec<crate::wall_bands::RoofFacet>,
    pub(super) fascia: Vec<[[f64; 3]; 4]>,
    pub(super) bounds: [f64; 4],
}

/// Sichtstrahl ab einem Grundriss-Punkt (unabhängig von der Höhe), s. `cull_under_roofs`.
struct Ray {
    pub(super) x: f64,
    pub(super) y: f64,
    samples: Vec<RaySample>,
    /// (Oberkante, Unterkante) der Facetten, die den Abtastpunkt enthalten.
    vals: Vec<(f64, f64)>,
    /// (Scheibe, Stirn) in Reichweite des Schritts.
    pub(super) fascia: Vec<(usize, usize)>,
    sheets: Vec<usize>,
    dormers: Vec<usize>,
}

struct RaySample {
    pub(super) t: f64,
    prev: (f64, f64),
    pub(super) q: (f64, f64),
    pub(super) fascia: (usize, usize),
    vals: (usize, usize),
    /// Werte an der Traufkante zwischen dem vorigen und diesem Schritt (bei Bedarf).
    edge: std::cell::OnceCell<Vec<(f64, f64)>>,
}

/// (Oberkante, Unterkante) der Facetten über dem Punkt, wie `RoofSheet::above` (je Scheibe nur innerhalb
/// ihrer Ausdehnung); leer: kein Dach.
fn sheet_vals(sheets: &[RoofSheet], cand: &[usize], x: f64, y: f64, out: &mut Vec<(f64, f64)>) {
    for &si in cand {
        let s = &sheets[si];
        let b = s.bounds;
        if x < b[0] || x > b[2] || y < b[1] || y > b[3] {
            continue;
        }
        for (t, u) in s.top.iter().zip(&s.under) {
            if t.contains(x, y) {
                out.push((t.z(x, y), u.z(x, y)));
            }
        }
    }
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

/// Wandflächen unter Dächern ([G2]) gegen die Dachscheiben vor ihnen: Ecken, deren Sichtstrahl (zum
/// Betrachter) durch ein Dach läuft, sind verdeckt. Ganz verdeckte Flächen entfallen (Oberseiten,
/// Laibungen und Stirnen innen unter dem Dach); bei senkrechten Kanten wird die Fläche auf die Höhe
/// gekappt, ab der das Dach sie verdeckt (Traufe vor der Wand). Ersetzt keine HLR ([G4]).
/// `shown`: Klasse sichtbar ([180]: Dächer ausgeblendeter Klassen verdecken nichts).
pub(super) fn cull_under_roofs(p: &Project, frame: &[f64; 9], walls: &[RWall], faces: &mut Vec<Face>, shown: &dyn Fn(&str) -> bool) {
    let affected: std::collections::HashSet<&str> = walls.iter().filter(|w| w.top_plane.is_some() || w.joint != [false; 2]).map(|w| w.wall_id.as_str()).collect();
    if affected.is_empty() {
        return;
    }
    // Dachgeometrie je Dach einmal (früher je Dach für alle anderen erneut: quadratisch).
    let roofs: Vec<&Roof> = p.roofs.as_deref().unwrap_or(&[]).iter().filter(|r| shown(&r.category_code)).collect();
    let geos: Vec<crate::roof::RoofGeometry> = roofs.iter().map(|r| crate::roof::roof_geometry(&r.params(), p.roof_base_elevation(r))).collect();
    let xy_bounds = |planes: &[Vec<[f64; 3]>]| {
        let mut b = [f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY];
        for q in planes.iter().flatten() {
            b = [b[0].min(q[0]), b[1].min(q[1]), b[2].max(q[0]), b[3].max(q[1])];
        }
        b
    };
    let plane_bounds: Vec<Vec<[f64; 4]>> = geos.iter().map(|g| g.planes.iter().map(|pl| xy_bounds(std::slice::from_ref(pl))).collect()).collect();
    let sheets: Vec<RoofSheet> = roofs
        .iter()
        .zip(&geos)
        .map(|(r, g)| {
            let total: f64 = p.roof_layers(r).iter().map(|l| l.thickness.max(0.0)).sum();
            let top = crate::wall_bands::plane_facets(&g.planes, 0.0);
            let under = crate::wall_bands::plane_facets(&g.planes, total);
            let b = xy_bounds(&g.planes);
            // Stirnflächen, die in einem anderen Dach stecken (Kehlen verschnittener Dächer), verdecken nicht.
            // Vorauswahl über die Ausdehnung je Fläche (ausserhalb liegt kein Punkt in ihr).
            let inside_other = |mx: f64, my: f64| {
                roofs.iter().enumerate().filter(|(_, o)| o.id != r.id && o.floor_id == r.floor_id).any(|(j, _)| {
                    geos[j].planes.iter().zip(&plane_bounds[j]).any(|(o, ob)| mx >= ob[0] && mx <= ob[2] && my >= ob[1] && my <= ob[3] && crate::dormer::point_in_xy(mx, my, o))
                })
            };
            let fascia = fascia_quads(&g.planes, total).into_iter().filter(|q| !inside_other((q[0][0] + q[1][0]) / 2.0, (q[0][1] + q[1][1]) / 2.0)).collect();
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
    let dormers: Vec<crate::dormer::DormerGeom> = roofs.iter().flat_map(|r| r.dormers.as_deref().unwrap_or(&[]).iter().filter_map(move |d| crate::dormer::geometry(p, r, d))).collect();
    let dormer_hit = |g: &crate::dormer::DormerGeom, a: (f64, f64), b: (f64, f64), z: f64| -> bool {
        let (la, lb) = (g.frame.local(a.0, a.1), g.frame.local(b.0, b.1));
        let hw = g.width / 2.0;
        let z_ok = |u: f64, v: f64| z >= g.frame.main_top(v) - g.main_thickness * 2.0 && z <= g.under(u, v) + g.roof_vertical();
        // Stirn (v = 0) oder Wange (|u| = hw) gekreuzt.
        let front = (la[1] > 0.0) != (lb[1] > 0.0) && la[0].abs() <= hw && z_ok(la[0], 0.0);
        let cheek = (la[0].abs() < hw) != (lb[0].abs() < hw) && la[1] >= 0.0 && la[1] <= g.hole_v(la[0]) && z_ok(la[0].clamp(-hw, hw), la[1]);
        front || cheek
    };
    // Vorauswahl ([G2], Leistung): Grundriss-Ausdehnung je Verdecker (Scheibe samt Stirnen; Gaube als
    // Bereich ihrer Stirn und Wangen, lokal |u| ≤ hw, 0 ≤ v ≤ max hole_v, mit Rand für den Schritt).
    // Ein Sichtstrahl läuft entlang −n, liegt also auf der Ansichtsachse u an einer Stelle: Raster über
    // die u-Intervalle, dann Ausdehnung längs n. Treffer bleiben in aufsteigender Reihenfolge (bitgleich).
    let sheet_box: Vec<[f64; 4]> = sheets
        .iter()
        .map(|s| {
            let mut b = s.bounds;
            for q in s.fascia.iter().flatten() {
                b = [b[0].min(q[0]), b[1].min(q[1]), b[2].max(q[0]), b[3].max(q[1])];
            }
            b
        })
        .collect();
    let fascia_box: Vec<Vec<[f64; 4]>> = sheets
        .iter()
        .map(|s| {
            s.fascia
                .iter()
                .map(|q| {
                    let (xs, ys) = (q.map(|c| c[0]), q.map(|c| c[1]));
                    let lo = |v: [f64; 4]| v.iter().copied().fold(f64::INFINITY, f64::min);
                    let hi = |v: [f64; 4]| v.iter().copied().fold(f64::NEG_INFINITY, f64::max);
                    let b = [lo(xs), lo(ys), hi(xs), hi(ys)];
                    if b.iter().all(|v| v.is_finite()) { b } else { [f64::NEG_INFINITY, f64::NEG_INFINITY, f64::INFINITY, f64::INFINITY] }
                })
                .collect()
        })
        .collect();
    let dormer_box: Vec<[f64; 4]> = dormers
        .iter()
        .map(|g| {
            let hw = g.width / 2.0;
            let v_max = g.hole_v(0.0).max(g.hole_v(hw));
            let m = 0.5;
            let fr = &g.frame;
            let mut b = [f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY];
            for (lu, lv) in [(-hw - m, -m), (hw + m, -m), (hw + m, v_max + m), (-hw - m, v_max + m)] {
                // Umkehrung von `DormerFrame::local` (ew, h orthonormal): d = u·ew − v·h.
                let (x, y) = (fr.p[0] + lu * fr.ew[0] - lv * fr.h[0], fr.p[1] + lu * fr.ew[1] - lv * fr.h[1]);
                b = [b[0].min(x), b[1].min(y), b[2].max(x), b[3].max(y)];
            }
            if b.iter().all(|v| v.is_finite()) { b } else { [f64::NEG_INFINITY, f64::NEG_INFINITY, f64::INFINITY, f64::INFINITY] }
        })
        .collect();
    let along_u = |b: &[f64; 4]| -> (f64, f64) {
        let c = [b[0] * u[0] + b[1] * u[1], b[2] * u[0] + b[1] * u[1], b[0] * u[0] + b[3] * u[1], b[2] * u[0] + b[3] * u[1]];
        (c.iter().copied().fold(f64::INFINITY, f64::min), c.iter().copied().fold(f64::NEG_INFINITY, f64::max))
    };
    let sheet_grid = crate::ugrid::Grid1::new(&sheet_box.iter().map(along_u).collect::<Vec<_>>());
    let dormer_grid = crate::ugrid::Grid1::new(&dormer_box.iter().map(along_u).collect::<Vec<_>>());
    let steps = ((reach / 0.04).ceil() as usize).min(5000);
    // Verdeckt: der Strahl zum Betrachter (−n im Grundriss) kreuzt die Dachoberfläche von unten nach
    // oben gesehen (erst darunter, näher zum Betrachter darüber) oder eine Gaubenwand.
    // Der Strahl hängt nur vom Grundriss-Punkt ab: Abtastpunkte, Werte der enthaltenden Facetten (Ober- und
    // Unterkante) und die Stirnen in Reichweite je Schritt einmal sammeln, dann je Höhe z nur noch
    // vergleichen (die Halbierung der Verdeckungsgrenze fragt denselben Strahl 40-mal).
    let ray_uncached = |x: f64, y: f64| -> Option<Ray> {
        // Kandidaten: Ausdehnung schneidet die Strahl-Ausdehnung (t ∈ [0, steps · 0.04]).
        let t_end = steps as f64 * 0.04;
        let (ex, ey) = (x - n[0] * t_end, y - n[1] * t_end);
        let rb = [x.min(ex) - 1e-6, y.min(ey) - 1e-6, x.max(ex) + 1e-6, y.max(ey) + 1e-6];
        let hit = |b: &[f64; 4]| !(b[2] < rb[0] || b[0] > rb[2] || b[3] < rb[1] || b[1] > rb[3]);
        let pu = x * u[0] + y * u[1];
        let (ua, ub) = (rb[0] * u[0] + rb[1] * u[1], rb[2] * u[0] + rb[3] * u[1]);
        let (ulo, uhi) = (pu.min(ua).min(ub) - 1e-6, pu.max(ua).max(ub) + 1e-6);
        let mut idx = Vec::new();
        sheet_grid.query(ulo, uhi, &mut idx);
        let cand: Vec<usize> = idx.iter().map(|&i| i as usize).filter(|&i| hit(&sheet_box[i])).collect();
        dormer_grid.query(ulo, uhi, &mut idx);
        let cand_d: Vec<usize> = idx.iter().map(|&i| i as usize).filter(|&i| hit(&dormer_box[i])).collect();
        // Strahlabschnitt in den Ausdehnungen der Kandidaten: davor und dahinter ändert kein Schritt etwas
        // (kein Verdecker, keine Scheibe; Schritte nach dem Austritt für die Traufkante weiter).
        let (mut t_lo, mut t_hi) = (f64::INFINITY, f64::NEG_INFINITY);
        for b in cand.iter().map(|&i| &sheet_box[i]).chain(cand_d.iter().map(|&i| &dormer_box[i])) {
            let (mut a, mut c) = (f64::NEG_INFINITY, f64::INFINITY);
            for (p0, d, lo, hi) in [(x, -n[0], b[0] - 1e-6, b[2] + 1e-6), (y, -n[1], b[1] - 1e-6, b[3] + 1e-6)] {
                if d.abs() < 1e-12 {
                    if p0 < lo || p0 > hi {
                        (a, c) = (1.0, 0.0);
                    }
                } else {
                    let (t0, t1) = ((lo - p0) / d, (hi - p0) / d);
                    (a, c) = (a.max(t0.min(t1)), c.min(t0.max(t1)));
                }
            }
            if a <= c {
                (t_lo, t_hi) = (t_lo.min(a), t_hi.max(c));
            }
        }
        if !(t_lo <= t_hi) {
            return None;
        }
        let i0 = ((t_lo / 0.04).floor() - 1.0).max(1.0);
        let i1 = (t_hi / 0.04).floor() + 3.0;
        let (i0, i1) = (if i0.is_finite() { (i0 as usize).min(steps + 1) } else { 1 }, if i1.is_finite() { (i1.max(0.0) as usize).min(steps) } else { steps });
        let mut r = Ray { x, y, samples: Vec::new(), vals: Vec::new(), fascia: Vec::new(), dormers: cand_d, sheets: cand };
        let mut prev = if i0 > 1 { let t = (i0 - 1) as f64 * 0.04; (x - n[0] * t, y - n[1] * t) } else { (x, y) };
        for i in i0..=i1 {
            let t = i as f64 * 0.04;
            let q = (x - n[0] * t, y - n[1] * t);
            // Stirnen, deren Grundriss-Ausdehnung der Schritt berührt (nur dort kann er sie kreuzen).
            let sb = [prev.0.min(q.0) - 1e-7, prev.1.min(q.1) - 1e-7, prev.0.max(q.0) + 1e-7, prev.1.max(q.1) + 1e-7];
            let f0 = r.fascia.len();
            for &si in &r.sheets {
                for (k, fb) in fascia_box[si].iter().enumerate() {
                    if !(fb[2] < sb[0] || fb[0] > sb[2] || fb[3] < sb[1] || fb[1] > sb[3]) {
                        r.fascia.push((si, k));
                    }
                }
            }
            let v0 = r.vals.len();
            sheet_vals(&sheets, &r.sheets, q.0, q.1, &mut r.vals);
            r.samples.push(RaySample { t, prev, q, fascia: (f0, r.fascia.len()), vals: (v0, r.vals.len()), edge: std::cell::OnceCell::new() });
            prev = q;
        }
        Some(r)
    };
    // Senkrechte Kanten teilen ihren Grundriss-Punkt (Ober- und Unterecke, Nachbarflächen): je Punkt einmal.
    let ray_cache: std::cell::RefCell<HashMap<(u64, u64), Option<std::rc::Rc<Ray>>>> = Default::default();
    let ray = |x: f64, y: f64| -> Option<std::rc::Rc<Ray>> {
        let key = (x.to_bits(), y.to_bits());
        if let Some(r) = ray_cache.borrow().get(&key) {
            return r.clone();
        }
        let r = ray_uncached(x, y).map(std::rc::Rc::new);
        ray_cache.borrow_mut().insert(key, r.clone());
        r
    };
    let hidden = |r: &Ray, z: f64| -> bool {
        let (x, y) = (r.x, r.y);
        let mut under = false;
        for smp in &r.samples {
            let (prev, q) = (smp.prev, smp.q);
            if r.dormers.iter().any(|&g| dormer_hit(&dormers[g], prev, q, z)) || r.fascia[smp.fascia.0..smp.fascia.1].iter().any(|&(si, k)| crosses_fascia(&sheets[si].fascia[k], prev, q, z)) {
                return true;
            }
            let vals = &r.vals[smp.vals.0..smp.vals.1];
            let here = vals.iter().map(|&(tz, uz)| if uz < z - 1e-4 { tz - z } else { -1.0 }).reduce(f64::max);
            match here {
                Some(d) if d >= 0.0 => under = true,
                Some(_) if under => return true,
                None if under => {
                    // Aus der Scheibe heraus (Traufkante): Oberkante genau an der Kante unter z? Die Kante
                    // selbst hängt nicht von z ab (ob eine Facette den Punkt enthält): je Schritt einmal.
                    let edge = smp.edge.get_or_init(|| {
                        let mut buf = Vec::new();
                        let mut inside = |t: f64| {
                            buf.clear();
                            sheet_vals(&sheets, &r.sheets, x - n[0] * t, y - n[1] * t, &mut buf);
                            !buf.is_empty()
                        };
                        let t = smp.t;
                        let (mut lo, mut hi) = (t - 0.04, t);
                        for _ in 0..30 {
                            let m = (lo + hi) / 2.0;
                            if inside(m) {
                                lo = m;
                            } else {
                                hi = m;
                            }
                        }
                        inside(lo);
                        buf
                    });
                    if edge.iter().map(|&(tz, uz)| if uz < z - 1e-4 { tz - z } else { -1.0 }).reduce(f64::max).is_some_and(|d| d < -1e-6) {
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
            ray(x, y).is_some_and(|r| hidden(&r, z - 1e-6))
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
            let r = ray(x, y);
            let (mut lo, mut hi) = (pts[j][1], pts[i][1]);
            for _ in 0..40 {
                let mid = (lo + hi) / 2.0;
                if r.as_ref().is_some_and(|r| hidden(r, mid)) {
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
