//! Ansichtsschraffur ([100]): Oberflächenmuster eines Bauteils (Lattung, Läuferverband, Schindeln,
//! Boden-Deckel-Schalung, Trapezblech, Naturstein polygonal, Plattenteilung) als Liniensegmente auf
//! einer ebenen Fläche. Rechnet in Flächen-Koordinaten (x entlang des Elements, y aufwärts bzw. in
//! Falllinie, Meter am Bau, Ursprung an der Elementkante) und schneidet an der Fläche zu.
//!
//! Massstab: Liegen die Linien auf dem Papier enger als [`MIN_PAPER_MM`], wird ausgedünnt (jede 2., 4.,
//! 8. Linie); noch enger fällt die Linienschar weg — so wird eine Fassade in 1:500 nicht schwarz.
//! Die Aufrufer (Ansicht `plan/elevation.rs`, Dachaufsicht `plan/domains.rs`) bilden die Segmente in
//! ihre Zeichenebene ab.

use crate::model::{SurfacePattern, SurfacePatternDirection, SurfacePatternKind};

pub type P = [f64; 2];

/// Kleinster Linienabstand auf dem Papier (mm), ab dem ausgedünnt wird.
pub const MIN_PAPER_MM: f64 = 0.7;
/// Höchster Ausdünnungsfaktor; darüber fällt die Linienschar weg.
const MAX_THIN: u32 = 8;
/// Obergrenze Segmente je Fläche (Schutz gegen Unsinn wie 1 mm Abstand auf 100 m).
const MAX_SEGMENTS: usize = 60_000;

/// Geprüfte Musterwerte (alle endlich und positiv).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Spec {
    pub kind: SurfacePatternKind,
    pub spacing: f64,
    pub height: f64,
    pub width: f64,
    /// Gesamtdrehung (Grad) der Musterlinien gegenüber der Fläche.
    pub angle: f64,
}

fn pos(v: Option<f64>) -> Option<f64> {
    v.filter(|x| x.is_finite() && *x > 0.0)
}

/// Muster eines Bauteils + Element-Drehung → [`Spec`]; `None` bei unbekannter Art oder unbrauchbaren Massen.
pub fn spec_of(sp: &SurfacePattern, element_angle_deg: f64) -> Option<Spec> {
    let spacing = pos(Some(sp.spacing))?;
    let natural_vertical = matches!(sp.kind, SurfacePatternKind::Lines | SurfacePatternKind::BoardBatten | SurfacePatternKind::Trapezoid);
    if sp.kind == SurfacePatternKind::Unknown {
        return None;
    }
    // Kanonisch: Linien-Arten senkrecht, Verbände/Raster mit waagrechten Lagen; die andere Richtung
    // ist um 90° gedreht.
    let turned = match sp.direction {
        Some(SurfacePatternDirection::Vertical) => !natural_vertical,
        Some(SurfacePatternDirection::Horizontal) => natural_vertical,
        _ => false,
    };
    let base = sp.angle.filter(|a| a.is_finite()).unwrap_or(0.0);
    let el = if element_angle_deg.is_finite() { element_angle_deg } else { 0.0 };
    Some(Spec {
        kind: sp.kind,
        spacing,
        height: pos(sp.height).unwrap_or(spacing),
        width: pos(sp.width).unwrap_or(spacing * 0.25).min(spacing),
        angle: base + el + if turned { 90.0 } else { 0.0 },
    })
}

/// Ausdünnungsfaktor (1, 2, 4, 8) für einen Linienabstand `period_m` bei 1:`scale`; `None` = weglassen.
pub fn thin_factor(period_m: f64, scale: f64) -> Option<u32> {
    let s = if scale.is_finite() && scale > 0.0 { scale } else { 100.0 };
    let mm = period_m * 1000.0 / s;
    let mut m = 1u32;
    while mm * m as f64 + 1e-12 < MIN_PAPER_MM {
        m *= 2;
        if m > MAX_THIN {
            return None;
        }
    }
    Some(m)
}

fn point_in(pt: P, poly: &[P]) -> bool {
    let mut inside = false;
    let n = poly.len();
    let mut j = n - 1;
    for i in 0..n {
        let (a, b) = (poly[i], poly[j]);
        if (a[1] > pt[1]) != (b[1] > pt[1]) && pt[0] < (b[0] - a[0]) * (pt[1] - a[1]) / (b[1] - a[1]) + a[0] {
            inside = !inside;
        }
        j = i;
    }
    inside
}

/// Teilstücke der Strecke a–b innerhalb des Polygons (gerade-ungerade-Regel).
pub fn clip_to_poly(a: P, b: P, poly: &[P], out: &mut Vec<(P, P)>) {
    let n = poly.len();
    if n < 3 {
        return;
    }
    let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
    let mut ts = vec![0.0, 1.0];
    for i in 0..n {
        let (c, d) = (poly[i], poly[(i + 1) % n]);
        let (ex, ey) = (d[0] - c[0], d[1] - c[1]);
        let den = dx * ey - dy * ex;
        if den.abs() < 1e-15 {
            continue;
        }
        let t = ((c[0] - a[0]) * ey - (c[1] - a[1]) * ex) / den;
        let u = ((c[0] - a[0]) * dy - (c[1] - a[1]) * dx) / den;
        if (0.0..=1.0).contains(&t) && (-1e-12..=1.0 + 1e-12).contains(&u) {
            ts.push(t);
        }
    }
    ts.sort_by(|x, y| x.total_cmp(y));
    let at = |t: f64| [a[0] + dx * t, a[1] + dy * t];
    let mut run: Option<(f64, f64)> = None;
    for w in ts.windows(2) {
        if w[1] - w[0] < 1e-12 {
            continue;
        }
        if point_in(at((w[0] + w[1]) / 2.0), poly) {
            run = Some(match run {
                Some((s, e)) if (e - w[0]).abs() < 1e-12 => (s, w[1]),
                Some((s, e)) => {
                    out.push((at(s), at(e)));
                    (w[0], w[1])
                }
                None => (w[0], w[1]),
            });
        }
    }
    if let Some((s, e)) = run {
        if (e - s) * (dx * dx + dy * dy).sqrt() > 1e-9 {
            out.push((at(s), at(e)));
        }
    }
}

/// Deterministisches Rauschen in [0, 1) je Gitterpunkt (für „polygonal").
fn hash01(i: i64, j: i64, salt: u64) -> f64 {
    let mut h = (i as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15) ^ (j as u64).wrapping_mul(0xC2B2_AE3D_27D4_EB4F) ^ salt;
    h ^= h >> 33;
    h = h.wrapping_mul(0xFF51_AFD7_ED55_8CCD);
    h ^= h >> 33;
    (h >> 11) as f64 / (1u64 << 53) as f64
}

/// Liniensegmente des Musters auf der Fläche `poly` (Flächen-Koordinaten, Meter). `offset` verschiebt
/// den Musterursprung; `scale` ist der Massstabsnenner (Ausdünnung).
pub fn segments(poly: &[P], spec: &Spec, offset: P, scale: f64) -> Vec<(P, P)> {
    let mut out = Vec::new();
    if poly.len() < 3 || poly.iter().any(|p| !p[0].is_finite() || !p[1].is_finite()) {
        return out;
    }
    let off = [if offset[0].is_finite() { offset[0] } else { 0.0 }, if offset[1].is_finite() { offset[1] } else { 0.0 }];
    let rad = spec.angle.to_radians();
    let (c, s) = (rad.cos(), rad.sin());
    // Muster-Raum: q = R(−angle)·(p − off); zurück: p = R(angle)·q + off.
    let to_q = |p: P| -> P {
        let (x, y) = (p[0] - off[0], p[1] - off[1]);
        [c * x + s * y, -s * x + c * y]
    };
    let to_p = |q: P| -> P { [c * q[0] - s * q[1] + off[0], s * q[0] + c * q[1] + off[1]] };
    let qpoly: Vec<P> = poly.iter().map(|p| to_q(*p)).collect();
    let (mut x0, mut y0, mut x1, mut y1) = (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
    for q in &qpoly {
        x0 = x0.min(q[0]);
        y0 = y0.min(q[1]);
        x1 = x1.max(q[0]);
        y1 = y1.max(q[1]);
    }
    let mut raw: Vec<(P, P)> = Vec::new();
    let budget = |n: f64| n.is_finite() && n < MAX_SEGMENTS as f64;
    // Senkrechte Linien x = k·period + d (k Vielfaches von m), über die ganze Höhe.
    let vlines = |raw: &mut Vec<(P, P)>, period: f64, d: f64, m: u32| {
        let k0 = ((x0 - d) / period).floor() as i64;
        let k1 = ((x1 - d) / period).ceil() as i64;
        if !budget((k1 - k0) as f64 / m as f64) {
            return;
        }
        for k in k0..=k1 {
            if k.rem_euclid(m as i64) == 0 {
                let x = k as f64 * period + d;
                raw.push(([x, y0], [x, y1]));
            }
        }
    };
    let hlines = |raw: &mut Vec<(P, P)>, period: f64, m: u32| -> (i64, i64) {
        let k0 = (y0 / period).floor() as i64;
        let k1 = (y1 / period).ceil() as i64;
        if !budget((k1 - k0) as f64 / m as f64) {
            return (0, -1);
        }
        for k in k0..=k1 {
            if k.rem_euclid(m as i64) == 0 {
                let y = k as f64 * period;
                raw.push(([x0, y], [x1, y]));
            }
        }
        (k0, k1)
    };
    match spec.kind {
        SurfacePatternKind::Lines => {
            if let Some(m) = thin_factor(spec.spacing, scale) {
                vlines(&mut raw, spec.spacing, 0.0, m);
            }
        }
        SurfacePatternKind::BoardBatten => {
            if let Some(m) = thin_factor(spec.spacing, scale) {
                vlines(&mut raw, spec.spacing, 0.0, m);
                // Zweite Kante der Deckleiste nur, solange sie auf dem Papier getrennt bleibt.
                if m == 1 && thin_factor(spec.width, scale) == Some(1) {
                    vlines(&mut raw, spec.spacing, spec.width, 1);
                }
            }
        }
        SurfacePatternKind::Trapezoid => {
            if let Some(m) = thin_factor(spec.spacing, scale) {
                let w = spec.width;
                if m == 1 && thin_factor(w / 4.0, scale) == Some(1) {
                    // Untergurt-Kanten und Obergurt-Kanten (Stege schräg dazwischen).
                    for d in [0.0, w / 4.0, w * 0.75, w] {
                        vlines(&mut raw, spec.spacing, d, 1);
                    }
                } else if m == 1 && thin_factor(w, scale) == Some(1) {
                    vlines(&mut raw, spec.spacing, 0.0, 1);
                    vlines(&mut raw, spec.spacing, w, 1);
                } else {
                    vlines(&mut raw, spec.spacing, 0.0, m);
                }
            }
        }
        SurfacePatternKind::Grid => {
            if let Some(m) = thin_factor(spec.height, scale) {
                hlines(&mut raw, spec.height, m);
            }
            if let Some(m) = thin_factor(spec.spacing, scale) {
                vlines(&mut raw, spec.spacing, 0.0, m);
            }
        }
        SurfacePatternKind::RunningBond | SurfacePatternKind::Shingles => {
            let Some(m) = thin_factor(spec.height, scale) else { return out };
            let (k0, k1) = hlines(&mut raw, spec.height, m);
            // Stossfugen nur bei voller Lagenteilung (sonst stimmt der Versatz nicht mehr).
            if m == 1 && thin_factor(spec.spacing, scale) == Some(1) {
                let shift = if spec.kind == SurfacePatternKind::Shingles { 1.0 / 3.0 } else { 0.5 };
                let j0 = (x0 / spec.spacing).floor() as i64 - 1;
                let j1 = (x1 / spec.spacing).ceil() as i64 + 1;
                if budget((k1 - k0 + 1) as f64 * (j1 - j0 + 1) as f64) {
                    for k in k0..k1 {
                        let ya = k as f64 * spec.height;
                        let d = (k.rem_euclid(if shift == 0.5 { 2 } else { 3 }) as f64 * shift).fract() * spec.spacing;
                        for j in j0..=j1 {
                            let x = j as f64 * spec.spacing + d;
                            raw.push(([x, ya], [x, ya + spec.height]));
                        }
                    }
                }
            }
        }
        SurfacePatternKind::Polygonal => {
            // Unregelmässiges Netz: verschobene Gitterpunkte, Kanten nach rechts/oben, je Zelle eine
            // zufällige Diagonale — ergibt Drei-, Vier- und Fünfecke wie ein Polygonalmauerwerk.
            let a = spec.spacing;
            if thin_factor(a * 0.5, scale) != Some(1) {
                return out;
            }
            let b = spec.height;
            let i0 = (x0 / a).floor() as i64 - 1;
            let i1 = (x1 / a).ceil() as i64 + 1;
            let j0 = (y0 / b).floor() as i64 - 1;
            let j1 = (y1 / b).ceil() as i64 + 1;
            if !budget(3.0 * (i1 - i0 + 1) as f64 * (j1 - j0 + 1) as f64) {
                return out;
            }
            let pt = |i: i64, j: i64| -> P {
                let jx = (hash01(i, j, 1) - 0.5) * 0.55 * a;
                let jy = (hash01(i, j, 2) - 0.5) * 0.55 * b;
                [i as f64 * a + jx + if j.rem_euclid(2) == 1 { 0.5 * a } else { 0.0 }, j as f64 * b + jy]
            };
            for i in i0..i1 {
                for j in j0..j1 {
                    let p = pt(i, j);
                    raw.push((p, pt(i + 1, j)));
                    raw.push((p, pt(i, j + 1)));
                    if hash01(i, j, 3) < 0.5 {
                        raw.push((p, pt(i + 1, j + 1)));
                    }
                }
            }
        }
        SurfacePatternKind::Unknown => {}
    }
    let mut clipped = Vec::new();
    for (a, b) in raw {
        clip_to_poly(a, b, &qpoly, &mut clipped);
        if clipped.len() > MAX_SEGMENTS {
            break;
        }
    }
    out.extend(clipped.into_iter().map(|(a, b)| (to_p(a), to_p(b))));
    out
}

// ── Ebene Fläche im Raum ────────────────────────────────────────────────────

pub type V3 = [f64; 3];

fn sub(a: V3, b: V3) -> V3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
fn dot(a: V3, b: V3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
fn cross(a: V3, b: V3) -> V3 {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}
fn norm(a: V3) -> Option<V3> {
    let l = dot(a, a).sqrt();
    (l > 1e-12 && l.is_finite()).then(|| [a[0] / l, a[1] / l, a[2] / l])
}

/// Muster auf einer ebenen Fläche im Raum (Plan-Koordinaten `[x, y, z]`, z aufwärts), z. B. einer
/// Dachfläche: x läuft waagrecht (traufparallel), y in der Falllinie aufwärts, Ursprung am tiefsten
/// Punkt. Liefert Raum-Segmente.
pub fn segments_3d(poly: &[V3], spec: &Spec, offset: P, scale: f64) -> Vec<(V3, V3)> {
    if poly.len() < 3 {
        return Vec::new();
    }
    // Newell-Normale
    let mut n = [0.0; 3];
    for i in 0..poly.len() {
        let (a, b) = (poly[i], poly[(i + 1) % poly.len()]);
        n[0] += (a[1] - b[1]) * (a[2] + b[2]);
        n[1] += (a[2] - b[2]) * (a[0] + b[0]);
        n[2] += (a[0] - b[0]) * (a[1] + b[1]);
    }
    let Some(n) = norm(n) else { return Vec::new() };
    let up = [0.0, 0.0, 1.0];
    let u = norm(cross(up, n)).unwrap_or([1.0, 0.0, 0.0]);
    let mut v = cross(n, u);
    if v[2] < 0.0 || (v[2].abs() < 1e-12 && dot(v, [0.0, 1.0, 0.0]) < 0.0) {
        v = [-v[0], -v[1], -v[2]];
    }
    let o = poly.iter().copied().fold(poly[0], |m, p| if p[2] < m[2] { p } else { m });
    let local: Vec<P> = poly.iter().map(|p| [dot(sub(*p, o), u), dot(sub(*p, o), v)]).collect();
    let back = |q: P| -> V3 { [o[0] + u[0] * q[0] + v[0] * q[1], o[1] + u[1] * q[0] + v[1] * q[1], o[2] + u[2] * q[0] + v[2] * q[1]] };
    segments(&local, spec, offset, scale).into_iter().map(|(a, b)| (back(a), back(b))).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pat(kind: SurfacePatternKind, spacing: f64, height: Option<f64>) -> SurfacePattern {
        SurfacePattern { kind, spacing, height, ..Default::default() }
    }

    fn rect(w: f64, h: f64) -> Vec<P> {
        vec![[0.0, 0.0], [w, 0.0], [w, h], [0.0, h]]
    }

    #[test]
    fn lattung_senkrecht_im_abstand() {
        let s = spec_of(&pat(SurfacePatternKind::Lines, 0.1, None), 0.0).unwrap();
        let segs = segments(&rect(1.0, 2.0), &s, [0.05, 0.0], 50.0);
        // x = 0.05, 0.15 … 0.95 → 10 Linien, jede volle Höhe, senkrecht
        assert_eq!(segs.len(), 10, "{segs:?}");
        for (a, b) in &segs {
            assert!((a[0] - b[0]).abs() < 1e-9);
            assert!(((a[1] - b[1]).abs() - 2.0).abs() < 1e-9);
        }
    }

    #[test]
    fn richtung_waagrecht_und_versatz() {
        let mut p = pat(SurfacePatternKind::Lines, 0.25, None);
        p.direction = Some(SurfacePatternDirection::Horizontal);
        let s = spec_of(&p, 0.0).unwrap();
        let segs = segments(&rect(2.0, 1.0), &s, [0.0, 0.1], 50.0);
        // y = 0.1, 0.35, 0.6, 0.85 (waagrecht, Ursprung um 0.1 versetzt)
        let mut ys: Vec<f64> = segs.iter().map(|(a, _)| (a[1] * 1000.0).round() / 1000.0).collect();
        ys.sort_by(f64::total_cmp);
        ys.dedup();
        assert_eq!(ys, vec![0.1, 0.35, 0.6, 0.85]);
        assert!(segs.iter().all(|(a, b)| (a[1] - b[1]).abs() < 1e-9));
    }

    #[test]
    fn element_drehung_dreht_muster() {
        let s = spec_of(&pat(SurfacePatternKind::Lines, 0.2, None), 90.0).unwrap();
        let segs = segments(&rect(1.0, 1.0), &s, [0.0, 0.0], 50.0);
        assert!(!segs.is_empty());
        assert!(segs.iter().all(|(a, b)| (a[1] - b[1]).abs() < 1e-9), "nach 90° waagrecht");
    }

    #[test]
    fn laeuferverband_versetzte_stossfugen() {
        let s = spec_of(&pat(SurfacePatternKind::RunningBond, 0.26, Some(0.08)), 0.0).unwrap();
        let poly = vec![[-0.01, 0.0], [1.05, 0.0], [1.05, 0.16], [-0.01, 0.16]];
        let segs = segments(&poly, &s, [0.0, 0.0], 20.0);
        let joints: Vec<&(P, P)> = segs.iter().filter(|(a, b)| (a[0] - b[0]).abs() < 1e-9 && (a[1] - b[1]).abs() > 1e-6).collect();
        let lage = |y: f64| -> Vec<f64> {
            let mut v: Vec<f64> = joints.iter().filter(|(a, b)| a[1].min(b[1]) < y && a[1].max(b[1]) > y).map(|(a, _)| (a[0] * 1000.0).round() / 1000.0).collect();
            v.sort_by(f64::total_cmp);
            v
        };
        assert_eq!(lage(0.04), vec![0.0, 0.26, 0.52, 0.78, 1.04]);
        assert_eq!(lage(0.12), vec![0.13, 0.39, 0.65, 0.91]);
    }

    #[test]
    fn grober_massstab_duennt_aus_und_laesst_weg() {
        let s = spec_of(&pat(SurfacePatternKind::Lines, 0.1, None), 0.0).unwrap();
        let fein = segments(&rect(4.0, 1.0), &s, [0.05, 0.0], 100.0).len(); // 1 mm Papier
        let mittel = segments(&rect(4.0, 1.0), &s, [0.05, 0.0], 200.0).len(); // 0.5 mm → jede 2.
        let grob = segments(&rect(4.0, 1.0), &s, [0.05, 0.0], 2000.0).len(); // 0.05 mm → weg
        assert_eq!(fein, 40);
        assert_eq!(mittel, 20);
        assert_eq!(grob, 0);
        assert_eq!(thin_factor(0.1, 100.0), Some(1));
        assert_eq!(thin_factor(0.1, 500.0), Some(4));
        assert_eq!(thin_factor(0.1, 1000.0), Some(8));
        assert_eq!(thin_factor(0.1, 2000.0), None);
    }

    #[test]
    fn zuschnitt_an_schraeger_flaeche() {
        // Giebeldreieck: Linien enden an den Schrägen
        let tri = vec![[0.0, 0.0], [2.0, 0.0], [1.0, 1.0]];
        let s = spec_of(&pat(SurfacePatternKind::Lines, 0.5, None), 0.0).unwrap();
        let segs = segments(&tri, &s, [0.0, 0.0], 50.0);
        let mid = segs.iter().find(|(a, _)| (a[0] - 1.0).abs() < 1e-9).unwrap();
        assert!((mid.0[1].max(mid.1[1]) - 1.0).abs() < 1e-9);
        let side = segs.iter().find(|(a, _)| (a[0] - 0.5).abs() < 1e-9).unwrap();
        assert!((side.0[1].max(side.1[1]) - 0.5).abs() < 1e-9);
    }

    #[test]
    fn alle_arten_liefern_linien_und_bleiben_in_der_flaeche() {
        use SurfacePatternKind::*;
        for kind in [Lines, BoardBatten, RunningBond, Shingles, Trapezoid, Polygonal, Grid] {
            let mut p = pat(kind, 0.3, Some(0.2));
            p.width = Some(0.08);
            let s = spec_of(&p, 15.0).unwrap();
            let segs = segments(&rect(3.0, 2.0), &s, [0.05, 0.0], 20.0);
            assert!(segs.len() > 5, "{kind:?}");
            for (a, b) in segs {
                for q in [a, b] {
                    assert!(q[0] > -1e-6 && q[0] < 3.0 + 1e-6 && q[1] > -1e-6 && q[1] < 2.0 + 1e-6, "{kind:?} {q:?}");
                }
            }
        }
    }

    #[test]
    fn unsinn_ergibt_nichts() {
        assert!(spec_of(&pat(SurfacePatternKind::Lines, 0.0, None), 0.0).is_none());
        assert!(spec_of(&pat(SurfacePatternKind::Lines, f64::NAN, None), 0.0).is_none());
        let s = spec_of(&pat(SurfacePatternKind::Lines, 1e-6, None), 0.0).unwrap();
        assert!(segments(&rect(100.0, 100.0), &s, [0.0, 0.0], 1.0).len() <= MAX_SEGMENTS + 1);
        assert!(segments(&[[0.0, 0.0], [f64::NAN, 1.0], [1.0, 1.0]], &s, [0.0, 0.0], 100.0).is_empty());
    }

    #[test]
    fn dachflaeche_traufparallel() {
        // 30°-Dachfläche, Traufe entlang x auf z = 0
        let h = 0.5f64;
        let poly = vec![[0.0, 0.0, 0.0], [4.0, 0.0, 0.0], [4.0, 3f64.sqrt() * h, h], [0.0, 3f64.sqrt() * h, h]];
        let mut p = pat(SurfacePatternKind::Lines, 0.25, None);
        p.direction = Some(SurfacePatternDirection::Horizontal);
        let s = spec_of(&p, 0.0).unwrap();
        let segs = segments_3d(&poly, &s, [0.0, 0.1], 50.0);
        // Falllinie 1.0 m lang → Lagen bei .1, .35, .6, .85 → 4 traufparallele Linien
        assert_eq!(segs.len(), 4);
        assert!(segs.iter().all(|(a, b)| (a[2] - b[2]).abs() < 1e-9 && (a[1] - b[1]).abs() < 1e-9));
    }
}
