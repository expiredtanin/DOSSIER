//! [151] Handlauf-Achse einer Treppe (alle Formen mit Geländer: gerade, L, U, gerade mit Podest, Wendel)
//! — eine Quelle für 3D/IFC (`stairs3d::railings`, Rohr-Sweep) und Grundriss (`plan/stair_symbol.rs`,
//! Linie bzw. Doppellinie). Je Gehseite ein Polygonzug mit Höhe über der Treppen-UK:
//!
//! - **Lage:** Treppenkante der Gehseite, um [`RAIL_INSET`] nach innen versetzt (Gehrungen an den Ecken);
//!   Läufe entlang der Seitenkante, Podeste entlang ihres Randes (aussen über die Ecken, innen um das
//!   Treppenauge), Wendel auf dem Innen- bzw. Aussenbogen.
//! - **Höhe:** [`RAIL_HEIGHT`] über der Linie Antritt → Austrittskante je Lauf, über Podesten eben.
//! - **Kropfstück:** An der Podestkante läge die Podesthöhe eine Steighöhe über dem Laufende. Statt
//!   dieses Sprungs steigt der Handlauf über einen Auftritt des Laufs weiter (bei kurzem Podestrand,
//!   z. B. um ein schmales Auge, bis in den Folgelauf, entsprechend steiler) — stetig. Die Knicke der
//!   Höhenlinie sind auf [`KROPF_ROUND`] ausgerundet (Krümmling, Mittelwert über ein kurzes Fenster:
//!   gerade Stücke bleiben exakt).
//! - **Pfosten:** Lauf-Anfang, Trittende je Tritt, Ecken des Podestrandes (Fusspunkt, Fusshöhe).

use crate::jsmath::hypot2;
use kernel2d::{StairGeometry, StairParams};

pub type P = [f64; 2];
pub type V3 = [f64; 3];

/// Handlaufhöhe über der Trittvorderkante (Meter) und Durchmesser von Handlauf/Pfosten.
pub const RAIL_HEIGHT: f64 = 0.9;
pub const RAIL_THICK: f64 = 0.04;
/// Abstand der Handlauf-Achse von der Treppenkante nach innen (Rohr ganz über der Treppe).
pub const RAIL_INSET: f64 = 0.04;
/// Kreisbogenstücke je Tritt (Wendel: Fläche und Handlauf).
pub const HELIX_SEGMENTS: usize = 6;
/// Fensterbreite der Ausrundung der Höhenlinie an Knicken (Meter entlang des Handlaufs).
pub const KROPF_ROUND: f64 = 0.12;

const NEAR: f64 = 1e-6;

/// Handlauf einer Gehseite: Achse (z über der Treppen-UK) und Pfosten (Fusspunkt, Fusshöhe über der UK).
#[derive(Clone, Debug)]
pub struct Rail {
    pub path: Vec<V3>,
    pub posts: Vec<(P, f64)>,
}

pub fn pt(p: &kernel2d::Vec2) -> P {
    [p.x, p.y]
}

fn near(a: P, b: P) -> bool {
    (a[0] - b[0]).abs() < NEAR && (a[1] - b[1]).abs() < NEAR
}

/// Läufe einer Treppe aus geraden Läufen: Tritt-Bereiche zwischen den Podesten (Sprung im Tritt-Index).
pub fn run_ranges(geo: &StairGeometry) -> Vec<std::ops::Range<usize>> {
    let tr = &geo.treads;
    let mut out = Vec::new();
    let mut a = 0;
    for k in 1..tr.len() {
        if tr[k].index != tr[k - 1].index + 1 {
            out.push(a..k);
            a = k;
        }
    }
    if a < tr.len() {
        out.push(a..tr.len());
    }
    out
}

/// Podeste (Umriss, Oberkante über der Treppen-UK): Podest k liegt auf der Antrittshöhe des
/// Laufs k + 1 (jedes Podest belegt eine Steigung). Ohne Folgelauf: halbe Steighöhe.
pub fn landings_of(geo: &StairGeometry) -> Vec<(Vec<P>, f64)> {
    let runs = run_ranges(geo);
    geo.landing
        .iter()
        .chain(geo.landing2.iter())
        .enumerate()
        .filter(|(_, l)| l.len() >= 3)
        .map(|(k, l)| {
            let top = runs.get(k + 1).map_or(geo.total_rise * 0.5, |r| geo.treads[r.start].base_rise);
            (l.iter().map(pt).collect(), top)
        })
        .collect()
}

/// Wendel-Masse: Zentrum, Winkelbereich, Radien (wie `spiral_geometry` in `kernel2d`).
pub struct Helix {
    pub center: P,
    pub a0: f64,
    pub sweep: f64,
    pub r_in: f64,
    pub r_out: f64,
}

pub fn helix_of(p: &StairParams) -> Option<Helix> {
    let half_w = 0.05_f64.max(p.width / 2.0);
    let center = p.center.unwrap_or(p.start);
    let radius = (half_w + 0.1).max(p.radius.unwrap_or(p.width));
    let a0 = crate::jsnum::atan2(p.start.y - center.y, p.start.x - center.x);
    let sweep = p.sweep.unwrap_or(270.0).to_radians();
    if !(sweep.abs() > 1e-6 && a0.is_finite()) {
        return None;
    }
    Some(Helix { center: [center.x, center.y], a0, sweep, r_in: (radius - half_w).max(0.02), r_out: radius + half_w })
}

impl Helix {
    pub fn at(&self, r: f64, ang: f64) -> P {
        [self.center[0] + r * crate::jsnum::cos(ang), self.center[1] + r * crate::jsnum::sin(ang)]
    }
}

/// Gehseiten nach Geländer-Code (1 links, 2 rechts, 3 beide; in Laufrichtung): `true` = links.
fn sides(railing: u8) -> &'static [bool] {
    match railing {
        3 => &[true, false],
        1 => &[true],
        2 => &[false],
        _ => &[],
    }
}

/// Handläufe einer Treppe je Gehseite (s. Modulkopf). Leer ohne Geländer oder bei unbrauchbarer Geometrie.
pub fn rails(p: &StairParams, geo: &StairGeometry, railing: u8) -> Vec<Rail> {
    match p.shape.as_str() {
        "spiral" => spiral_rails(p, geo, railing),
        "straight" | "L" | "U" | "straightLanding" => flight_rails(geo, railing),
        _ => Vec::new(),
    }
}

fn spiral_rails(p: &StairParams, geo: &StairGeometry, railing: u8) -> Vec<Rail> {
    let n = geo.treads.len();
    let Some(h) = helix_of(p) else { return Vec::new() };
    if n == 0 || !(geo.total_rise > 0.0) {
        return Vec::new();
    }
    // Laufrichtung = Drehsinn: links der Laufrichtung liegt bei CCW der Innenrand.
    let ccw = h.sweep > 0.0;
    sides(railing)
        .iter()
        .map(|&left| {
            let r = if left == ccw { h.r_in + RAIL_INSET } else { h.r_out - RAIL_INSET };
            let total_seg = n * HELIX_SEGMENTS;
            let path = (0..=total_seg)
                .map(|k| {
                    let f = k as f64 / total_seg as f64;
                    let q = h.at(r, h.a0 + f * h.sweep);
                    [q[0], q[1], f * geo.total_rise + RAIL_HEIGHT]
                })
                .collect();
            let posts = geo
                .treads
                .iter()
                .enumerate()
                .map(|(i, tr)| (h.at(r, h.a0 + (i as f64 + 0.5) / n as f64 * h.sweep), tr.top_rise))
                .collect();
            Rail { path, posts }
        })
        .collect()
}

/// Weg auf dem Rand eines Podests von `a` nach `b` (beide auf dem Rand), auf der Seite, die keinen der
/// Punkte `avoid` berührt (die Gegenseite der Treppe); sonst der kürzere. `a` ≈ `b` ergibt `[a]`.
pub fn boundary_arc(poly: &[P], a: P, b: P, avoid: &[P]) -> Vec<P> {
    if near(a, b) {
        return vec![a];
    }
    let mut ring: Vec<P> = poly.to_vec();
    // Punkt auf den Rand legen: als Ecke vorhanden oder in die Kante einfügen; `None` = nicht auf dem Rand.
    let place = |q: P, ring: &mut Vec<P>| -> Option<usize> {
        if let Some(i) = ring.iter().position(|p| near(*p, q)) {
            return Some(i);
        }
        let n = ring.len();
        for i in 0..n {
            let (p0, p1) = (ring[i], ring[(i + 1) % n]);
            let (dx, dy) = (p1[0] - p0[0], p1[1] - p0[1]);
            let l2 = dx * dx + dy * dy;
            if !(l2 > 1e-18) {
                continue;
            }
            let t = ((q[0] - p0[0]) * dx + (q[1] - p0[1]) * dy) / l2;
            let f = [p0[0] + dx * t, p0[1] + dy * t];
            if (0.0..=1.0).contains(&t) && hypot2(f[0] - q[0], f[1] - q[1]) < NEAR {
                ring.insert(i + 1, q);
                return Some(i + 1);
            }
        }
        None
    };
    for q in avoid {
        let _ = place(*q, &mut ring);
    }
    let (Some(_), Some(_)) = (place(a, &mut ring), place(b, &mut ring)) else { return vec![a, b] };
    let n = ring.len();
    let ia = ring.iter().position(|p| near(*p, a)).unwrap_or(0);
    let ib = ring.iter().position(|p| near(*p, b)).unwrap_or(0);
    let walk = |step: usize| {
        let mut path = vec![ring[ia]];
        let mut k = ia;
        while k != ib {
            k = (k + step) % n;
            path.push(ring[k]);
        }
        path
    };
    let length = |p: &[P]| p.windows(2).map(|w| hypot2(w[1][0] - w[0][0], w[1][1] - w[0][1])).sum::<f64>();
    let touches = |p: &[P]| p[1..p.len() - 1].iter().any(|q| avoid.iter().any(|x| near(*x, *q)));
    let (fwd, bwd) = (walk(1), walk(n - 1));
    match (touches(&fwd), touches(&bwd)) {
        (false, true) => fwd,
        (true, false) => bwd,
        _ if length(&fwd) <= length(&bwd) => fwd,
        _ => bwd,
    }
}

/// Parallele zu einem Polygonzug im Abstand `d` (> 0 links der Laufrichtung), Gehrungen an den Ecken
/// (bei sehr spitzen Ecken auf das Vierfache begrenzt). Aufeinanderfolgende gleiche Punkte sind nicht erlaubt.
pub fn offset_polyline(pts: &[P], d: f64) -> Vec<P> {
    let n = pts.len();
    let normals: Vec<Option<P>> = pts
        .windows(2)
        .map(|w| {
            let (dx, dy) = (w[1][0] - w[0][0], w[1][1] - w[0][1]);
            let l = hypot2(dx, dy);
            (l > 1e-12).then(|| [-dy / l, dx / l])
        })
        .collect();
    (0..n)
        .map(|i| {
            let a = i.checked_sub(1).and_then(|k| normals[k]);
            let b = normals.get(i).copied().flatten();
            let m = match (a, b) {
                (Some(a), Some(b)) => {
                    let s = [a[0] + b[0], a[1] + b[1]];
                    let l = hypot2(s[0], s[1]);
                    if l < 1e-9 {
                        a
                    } else {
                        let u = [s[0] / l, s[1] / l];
                        let c = (u[0] * a[0] + u[1] * a[1]).max(0.25);
                        [u[0] / c, u[1] / c]
                    }
                }
                (Some(a), None) => a,
                (None, Some(b)) => b,
                (None, None) => [0.0, 0.0],
            };
            [pts[i][0] + m[0] * d, pts[i][1] + m[1] * d]
        })
        .collect()
}

/// Ecke des Rohzugs: Lage, Höhe ankommend/abgehend (Sprung an der Podestkante), Auftritt des endenden
/// Laufs (für das Kropfstück), Pfosten-Fusshöhe.
struct Vertex {
    p: P,
    z0: f64,
    z1: f64,
    depth: f64,
    post: Option<f64>,
}

/// Höhenlinie als Stützstellen (s, z); doppelte s = Sprung. Wert rechtsseitig.
fn eval(knots: &[(f64, f64)], s: f64) -> f64 {
    let n = knots.len();
    if n == 0 {
        return 0.0;
    }
    if s <= knots[0].0 {
        return knots[0].1;
    }
    for k in (0..n - 1).rev() {
        let (a, b) = (knots[k], knots[k + 1]);
        if s >= a.0 && s <= b.0 {
            if b.0 - a.0 < 1e-12 {
                return b.1;
            }
            return a.1 + (b.1 - a.1) * (s - a.0) / (b.0 - a.0);
        }
    }
    knots[n - 1].1
}

/// Ausgerundete Höhe: Mittelwert der stetigen Höhenlinie über [s − w/2, s + w/2]; über die Enden hinaus
/// gerade verlängert (gerade Stücke bleiben exakt).
struct Smooth {
    knots: Vec<(f64, f64)>,
    /// Integral der Höhe vom ersten Knoten bis zu Knoten k.
    cum: Vec<f64>,
}

impl Smooth {
    fn new(mut knots: Vec<(f64, f64)>, w: f64) -> Self {
        if knots.len() >= 2 {
            let (a, b) = (knots[0], knots[1]);
            let m0 = if b.0 - a.0 > 1e-12 { (b.1 - a.1) / (b.0 - a.0) } else { 0.0 };
            let (y, z) = (knots[knots.len() - 2], knots[knots.len() - 1]);
            let m1 = if z.0 - y.0 > 1e-12 { (z.1 - y.1) / (z.0 - y.0) } else { 0.0 };
            knots.insert(0, (a.0 - w, a.1 - m0 * w));
            knots.push((z.0 + w, z.1 + m1 * w));
        }
        let mut cum = vec![0.0];
        for k in 1..knots.len() {
            let (a, b) = (knots[k - 1], knots[k]);
            cum.push(cum[k - 1] + (b.0 - a.0) * (a.1 + b.1) / 2.0);
        }
        Smooth { knots, cum }
    }
    fn integral(&self, s: f64) -> f64 {
        let k = &self.knots;
        let i = k.iter().rposition(|q| q.0 <= s).unwrap_or(0).min(k.len().saturating_sub(2));
        let (a, b) = (k[i], k[i + 1]);
        let zs = if b.0 - a.0 > 1e-12 { a.1 + (b.1 - a.1) * (s - a.0) / (b.0 - a.0) } else { a.1 };
        self.cum[i] + (s - a.0) * (a.1 + zs) / 2.0
    }
    fn at(&self, s: f64, w: f64) -> f64 {
        (self.integral(s + w / 2.0) - self.integral(s - w / 2.0)) / w
    }
}

/// Handläufe einer Treppe aus geraden Läufen (gerade, L, U, gerade mit Podest).
fn flight_rails(geo: &StairGeometry, railing: u8) -> Vec<Rail> {
    let tr = &geo.treads;
    let runs = run_ranges(geo);
    let landings = landings_of(geo);
    if runs.is_empty() || runs.len() != landings.len() + 1 || tr.iter().any(|t| t.pts.len() < 4) {
        return Vec::new();
    }
    let h = RAIL_HEIGHT;
    let mut out = Vec::new();
    for &left in sides(railing) {
        // Ecken je Tritt: 0 links vorn, 1 links hinten, 2 rechts hinten, 3 rechts vorn.
        let (i_start, i_end) = if left { (0, 1) } else { (3, 2) };
        let (o_start, o_end) = if left { (3, 2) } else { (0, 1) };
        // nach innen: rechts der Gehrichtung für den linken Handlauf, links für den rechten
        let d = if left { -RAIL_INSET } else { RAIL_INSET };
        let mut raw: Vec<Vertex> = Vec::new();
        let mut tread_posts: Vec<(P, f64)> = Vec::new();
        let push = |raw: &mut Vec<Vertex>, v: Vertex| {
            if let Some(last) = raw.last_mut().filter(|l| near(l.p, v.p)) {
                last.z1 = v.z1;
                last.depth = last.depth.max(v.depth);
                last.post = last.post.or(v.post);
            } else {
                raw.push(v);
            }
        };
        for (k, r) in runs.iter().enumerate() {
            let (first, last) = (&tr[r.start], &tr[r.end - 1]);
            let (f0, f1) = (pt(&first.pts[0]), pt(&first.pts[1]));
            let depth = hypot2(f1[0] - f0[0], f1[1] - f0[1]);
            if !(depth > 1e-9) {
                return Vec::new();
            }
            let u = [(f1[0] - f0[0]) / depth, (f1[1] - f0[1]) / depth];
            let inward = [-u[1] * d, u[0] * d];
            let a = pt(&first.pts[i_start]);
            let e = pt(&last.pts[i_end]);
            let za = first.base_rise + h;
            push(&mut raw, Vertex { p: a, z0: za, z1: za, depth: 0.0, post: (k == 0).then_some(first.base_rise) });
            let landing = landings.get(k);
            for (j, t) in tr[r.clone()].iter().enumerate() {
                // Trittende vor einem Podest trägt der Podestrand (Pfosten an der Gehrung).
                if landing.is_some() && j + 1 == r.len() {
                    continue;
                }
                let q = pt(&t.pts[i_end]);
                tread_posts.push(([q[0] + inward[0], q[1] + inward[1]], t.top_rise));
            }
            let ze = last.top_rise + h;
            let Some((poly, top)) = landing else {
                push(&mut raw, Vertex { p: e, z0: ze, z1: ze, depth: 0.0, post: None });
                continue;
            };
            let next = &tr[runs[k + 1].start];
            let b = pt(&next.pts[i_start]);
            let avoid = [pt(&last.pts[o_end]), pt(&next.pts[o_start])];
            let zl = top + h;
            push(&mut raw, Vertex { p: e, z0: ze, z1: zl, depth, post: Some(*top) });
            for p in boundary_arc(poly, e, b, &avoid).into_iter().skip(1) {
                push(&mut raw, Vertex { p, z0: zl, z1: zl, depth: 0.0, post: Some(*top) });
            }
        }
        if raw.len() < 2 {
            continue;
        }
        let xy = offset_polyline(&raw.iter().map(|v| v.p).collect::<Vec<_>>(), d);
        let mut s_at = vec![0.0];
        for w in xy.windows(2) {
            let l = s_at[s_at.len() - 1] + hypot2(w[1][0] - w[0][0], w[1][1] - w[0][1]);
            s_at.push(l);
        }
        let s_end = s_at[s_at.len() - 1];
        // Höhenlinie mit Sprüngen …
        let mut knots: Vec<(f64, f64)> = Vec::new();
        let mut jumps: Vec<(f64, f64, f64)> = Vec::new();
        for (v, &s) in raw.iter().zip(&s_at) {
            knots.push((s, v.z0));
            if (v.z1 - v.z0).abs() > 1e-12 {
                knots.push((s, v.z1));
                jumps.push((s, v.z0, v.depth));
            }
        }
        // … stetig: Kropfstück über einen Auftritt (höchstens bis vor den nächsten Sprung bzw. das Ende)
        for (j, &(sj, z0, depth)) in jumps.iter().enumerate() {
            let limit = jumps.get(j + 1).map_or(s_end, |n| n.0 - 1e-6);
            let len = depth.min(limit - sj);
            if !(len > 1e-9) {
                continue;
            }
            let z_end = eval(&knots, sj + len);
            let mut next: Vec<(f64, f64)> = knots.iter().copied().filter(|q| q.0 < sj - 1e-12).collect();
            next.push((sj, z0));
            next.push((sj + len, z_end));
            next.extend(knots.iter().copied().filter(|q| q.0 > sj + len + 1e-12));
            knots = next;
        }
        // Knicke der Höhenlinie (innere Stützstellen mit Steigungswechsel) ausrunden
        let w = KROPF_ROUND;
        let slope = |a: (f64, f64), b: (f64, f64)| if b.0 - a.0 > 1e-12 { (b.1 - a.1) / (b.0 - a.0) } else { 0.0 };
        let kinks: Vec<f64> = (1..knots.len().saturating_sub(1))
            .filter(|&k| (slope(knots[k - 1], knots[k]) - slope(knots[k], knots[k + 1])).abs() > 1e-9)
            .map(|k| knots[k].0)
            .collect();
        // Stützpunkte: alle Ecken, dazu um jeden Knick dichter (nicht näher als 2 mm an anderen: das Rohr
        // verwirft zu kurze Stücke).
        let mut samples: Vec<f64> = s_at.clone();
        let mut extra: Vec<f64> = kinks.iter().flat_map(|k| (-4..=4).map(move |i| k + i as f64 * w / 4.0)).collect();
        extra.sort_by(f64::total_cmp);
        for s in extra {
            if s > 0.002 && s < s_end - 0.002 && samples.iter().all(|q| (q - s).abs() > 0.002) {
                samples.push(s);
            }
        }
        samples.sort_by(f64::total_cmp);
        let smooth = Smooth::new(knots, w);
        let mut seg = 0;
        let path: Vec<V3> = samples
            .iter()
            .map(|&s| {
                while seg + 2 < s_at.len() && s > s_at[seg + 1] {
                    seg += 1;
                }
                let (a, b) = (xy[seg], xy[seg + 1]);
                let l = s_at[seg + 1] - s_at[seg];
                let t = if l > 1e-12 { ((s - s_at[seg]) / l).clamp(0.0, 1.0) } else { 0.0 };
                let z = if kinks.is_empty() { eval(&smooth.knots, s) } else { smooth.at(s, w) };
                [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, z]
            })
            .collect();
        // Pfosten: Podestrand und Lauf-Anfang (an den versetzten Ecken), dann die Tritte; ohne Doppelungen.
        let mut posts: Vec<(P, f64)> = Vec::new();
        let corner_posts = raw.iter().zip(&xy).filter_map(|(v, q)| v.post.map(|z| (*q, z)));
        for (p, z) in corner_posts.chain(tread_posts) {
            if !posts.iter().any(|(q, _)| near(*q, p)) {
                posts.push((p, z));
            }
        }
        out.push(Rail { path, posts });
    }
    out
}

/// Grundriss-Achse eines Handlaufs als Polygonzug (ohne doppelte und ohne gerade Zwischenpunkte). Die
/// Teilung in ausgezogen/gestrichelt an der Bruchlinie macht `plan/stair_symbol.rs` ([155]).
pub fn plan_path(rail: &Rail) -> Vec<P> {
    let mut v: Vec<P> = Vec::with_capacity(rail.path.len());
    for q in &rail.path {
        let p = [q[0], q[1]];
        if v.last().is_some_and(|l| near(*l, p)) {
            continue;
        }
        if v.len() >= 2 {
            let (a, b) = (v[v.len() - 2], v[v.len() - 1]);
            let cr = (b[0] - a[0]) * (p[1] - b[1]) - (b[1] - a[1]) * (p[0] - b[0]);
            let dot = (b[0] - a[0]) * (p[0] - b[0]) + (b[1] - a[1]) * (p[1] - b[1]);
            if cr.abs() < 1e-9 && dot > 0.0 {
                v.pop();
            }
        }
        v.push(p);
    }
    v
}

#[cfg(test)]
mod tests {
    use super::*;
    use kernel2d::{stair_geometry, Vec2};

    fn params(shape: &str) -> StairParams {
        StairParams {
            shape: shape.to_string(),
            start: Vec2::new(0.0, 0.0),
            dir: Vec2::new(1.0, 0.0),
            run_length: 2.5,
            run2_length: Some(2.5),
            turn: Some(1),
            center: None,
            radius: None,
            sweep: None,
            width: 1.0,
            step_count: 17,
            up: None,
            referenz: None,
            gap: Some(0.2),
            landing_length: None,
            run1_steps: None,
            mid_steps: None,
            run2_offset: None,
            mid_offset: None,
        }
    }

    /// Alle Podesttreppen (L beide Wendungen, U Halbpodest/Mittellauf/versetzt, gerade mit Podest).
    fn cases() -> Vec<StairParams> {
        let mut v = Vec::new();
        for turn in [1, -1] {
            let mut l = params("L");
            l.turn = Some(turn);
            l.run2_length = Some(1.5);
            v.push(l);
            let mut u = params("U");
            u.turn = Some(turn);
            v.push(u.clone());
            u.mid_steps = Some(2);
            v.push(u.clone());
            u.mid_offset = Some(0.03);
            v.push(u.clone());
            u.mid_steps = None;
            u.mid_offset = None;
            u.run2_offset = Some(0.3);
            v.push(u);
        }
        let mut g = params("straightLanding");
        g.run2_length = Some(2.0);
        g.landing_length = Some(1.2);
        v.push(g);
        v
    }

    #[test]
    fn kropf_hoehe_stetig_entlang_des_handlaufs() {
        for p in cases() {
            let geo = stair_geometry(&p, 2.89);
            let rails = rails(&p, &geo, 3);
            assert_eq!(rails.len(), 2, "{}", p.shape);
            let r = geo.riser_height;
            // steilster Lauf (Mittellauf über ein schmales Auge hat kurze Auftritte), Kropf höchstens 2.5-mal so steil
            let td_min = geo.treads.iter().map(|t| hypot2(t.pts[1].x - t.pts[0].x, t.pts[1].y - t.pts[0].y)).fold(f64::INFINITY, f64::min);
            let max_slope = 2.5 * r / td_min;
            for rail in &rails {
                let path = &rail.path;
                assert!((path[0][2] - RAIL_HEIGHT).abs() < 1e-9);
                assert!((path[path.len() - 1][2] - (2.89 + RAIL_HEIGHT)).abs() < 1e-9);
                for w in path.windows(2) {
                    let dxy = hypot2(w[1][0] - w[0][0], w[1][1] - w[0][1]);
                    let dz = w[1][2] - w[0][2];
                    // kein senkrechter Sprung: jede Strecke hat Grundrisslänge, Steigung begrenzt
                    assert!(dxy > 1e-7, "{} {:?}: senkrechtes Stück", p.shape, w);
                    assert!(dz > -1e-9, "{}: fällt {dz}", p.shape);
                    assert!(dz <= max_slope * dxy + 1e-9, "{} turn {:?} mid {:?}: zu steil {dz}/{dxy}", p.shape, p.turn, p.mid_steps);
                }
                // Höhe über jeder Podestfläche wird erreicht: höchstens eine Steigung unter Podest + 0.9
                for (_, top) in landings_of(&geo) {
                    assert!(path.iter().any(|q| (q[2] - (top + RAIL_HEIGHT)).abs() < r + 1e-9));
                }
            }
        }
    }

    #[test]
    fn kropf_auf_dem_podest_ein_auftritt_weit() {
        // Gerade mit Podest, rechts: Lauf 1 endet bei x = 2.5; der Handlauf steigt bis x = 2.5 + Auftritt
        // weiter und liegt danach eben auf Podesthöhe + 0.9.
        let mut p = params("straightLanding");
        p.run2_length = Some(2.5);
        p.landing_length = Some(1.2);
        p.run1_steps = Some(8);
        p.step_count = 17;
        let geo = stair_geometry(&p, 2.89);
        let rail = &rails(&p, &geo, 2)[0];
        let td = 2.5 / 8.0;
        let top = landings_of(&geo)[0].1 + RAIL_HEIGHT;
        let z_at = |x: f64| {
            let w = rail.path.windows(2).find(|w| w[0][0] <= x && w[1][0] >= x).unwrap();
            w[0][2] + (w[1][2] - w[0][2]) * (x - w[0][0]) / (w[1][0] - w[0][0])
        };
        // Lauf 1 unverändert (bis vor die Ausrundung), Podest eben ab Auftritt + halbes Rundungsfenster
        let slope = geo.riser_height / td;
        assert!((z_at(1.0) - (RAIL_HEIGHT + 1.0 * slope)).abs() < 1e-9);
        assert!((z_at(2.5 + td + KROPF_ROUND) - top).abs() < 1e-9);
        assert!((z_at(3.6) - top).abs() < 1e-9);
        // an der Podestkante kein Sprung: Höhe nahe der Lauflinie, nicht eine Steigung höher
        assert!((z_at(2.5) - (RAIL_HEIGHT + 2.5 * slope)).abs() < 0.02, "{}", z_at(2.5));
        // ganz innerhalb der Treppe, um RAIL_INSET von der rechten Kante (y = −0.5)
        assert!(rail.path.iter().all(|q| (q[1] + 0.5 - RAIL_INSET).abs() < 1e-9));
    }

    #[test]
    fn gerade_und_wendel() {
        let mut p = params("straight");
        p.run_length = 3.0;
        p.step_count = 10;
        let geo = stair_geometry(&p, 2.8);
        let r = rails(&p, &geo, 1);
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].path.len(), 2);
        assert!((r[0].path[0][1] - (0.5 - RAIL_INSET)).abs() < 1e-12);
        assert_eq!(r[0].posts.len(), 11);
        assert!(rails(&p, &geo, 0).is_empty());
        let mut w = params("spiral");
        w.center = Some(Vec2::new(0.0, 0.0));
        w.start = Vec2::new(1.5, 0.0);
        w.radius = Some(1.5);
        w.sweep = Some(270.0);
        w.step_count = 12;
        let geo = stair_geometry(&w, 2.8);
        let r = rails(&w, &geo, 3);
        assert_eq!(r.len(), 2);
        // links (CCW) innen: r = 1.0 + Abstand; rechts aussen: 2.0 − Abstand
        assert!(r[0].path.iter().all(|q| (q[0].hypot(q[1]) - 1.0 - RAIL_INSET).abs() < 1e-9));
        assert!(r[1].path.iter().all(|q| (q[0].hypot(q[1]) - 2.0 + RAIL_INSET).abs() < 1e-9));
    }

    #[test]
    fn grundriss_achse_zusammengefasst() {
        let mut p = params("straight");
        p.run_length = 3.0;
        p.step_count = 10;
        let geo = stair_geometry(&p, 2.8);
        let rail = &rails(&p, &geo, 1)[0];
        // gerade Treppe: eine Strecke (Zwischenpunkte der Pfosten/Tritte zusammengefasst)
        assert_eq!(plan_path(rail).len(), 2);
        // U mit Kropf: Zwischenpunkte auf Geraden zusammengefasst (Ecken bleiben)
        let u = params("U");
        let geo = stair_geometry(&u, 2.89);
        for rail in rails(&u, &geo, 3) {
            let path = plan_path(&rail);
            assert!(path.len() >= 3 && path.len() <= 6, "{path:?}");
        }
    }

    #[test]
    fn unsinn_ohne_panic() {
        let mut p = params("U");
        p.width = f64::NAN;
        let geo = stair_geometry(&p, 2.89);
        let _ = rails(&p, &geo, 3);
        let geo = stair_geometry(&params("U"), 0.0);
        let _ = rails(&params("U"), &geo, 3);
        assert!(offset_polyline(&[[0.0, 0.0]], 0.1).len() == 1);
    }
}
