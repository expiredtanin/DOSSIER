//! Baurecht der Parzelle ([63]); aus `analysis/siteRules.ts`. Zulässige Grundfläche aus
//! Grenzabständen und Baulinien, Verstösse der Gebäude-Grundfläche, Gesamthöhe.
//!
//!  • Grenzabstand: gesperrt ist alles, was näher als d_i an Kante i liegt — exakter Puffer der
//!    Kante (i_overlay-Stroke mit runden Enden), so stimmen auch konkave Parzellen und
//!    einspringende Ecken. Die Rundung ist durch Sehnen genähert (Winkelschritt [`ARC_STEP`]);
//!    die Sehnen liegen innerhalb des Kreises, Abweichung ≤ d·(1 − cos(ARC_STEP/2)) ≈ 7.5·10⁻⁵·d.
//!  • Baulinie: Halbebene auf der Seite des Parzellen-Schwerpunkts.
//!  • Gebäude-Grundfläche: TS liefert die Teile (Wände, Körper), hier vereinigt.

use crate::flat::{Polygon, Ring};
use crate::flat_read::signed_area;
use crate::polygon_bool;
use i_overlay::mesh::float::stroke::offset::StrokeOffset;
use i_overlay::mesh::float::style::{LineCap, StrokeStyle};

/// Winkelschritt der Rundung an den Kantenenden (Bogenmass).
pub const ARC_STEP: f64 = std::f64::consts::PI / 128.0;

/// Fläche einer Mehrfach-Fläche (Ring 0 aussen, weitere Löcher abgezogen).
pub fn multi_polygon_area(a: &[Polygon]) -> f64 {
    let mut s = 0.0;
    for poly in a {
        for (i, r) in poly.iter().enumerate() {
            let v = signed_area(r).abs();
            s += if i == 0 { v } else { -v };
        }
    }
    s
}

/// Baulinie durch a–b.
#[derive(Clone, Copy, Debug)]
pub struct BuildingLine {
    pub a: [f64; 2],
    pub b: [f64; 2],
}

/// Baurecht: Parzellenring, Grenzabstand je Kante (Rohwert, ungültig/negativ → 0), Baulinien.
pub struct SiteRules {
    pub parcel: Ring,
    pub setbacks: Vec<f64>,
    pub lines: Vec<BuildingLine>,
}

pub fn valid_parcel(parcel: &[[f64; 2]]) -> bool {
    parcel.len() >= 3 && parcel.iter().all(|p| p[0].is_finite() && p[1].is_finite()) && signed_area(parcel).abs() > 1e-9
}

/// Grenzabstand der Kante i (ungültig/negativ → 0).
pub fn setback_of(r: &SiteRules, i: usize) -> f64 {
    let v = r.setbacks.get(i).copied().unwrap_or(0.0);
    if v.is_finite() && v > 0.0 {
        v
    } else {
        0.0
    }
}

fn centroid(pts: &[[f64; 2]]) -> [f64; 2] {
    let (mut a, mut cx, mut cy) = (0.0, 0.0, 0.0);
    for i in 0..pts.len() {
        let p = pts[i];
        let q = pts[(i + 1) % pts.len()];
        let c = p[0] * q[1] - q[0] * p[1];
        a += c;
        cx += (p[0] + q[0]) * c;
        cy += (p[1] + q[1]) * c;
    }
    if a.abs() < 1e-12 {
        return pts[0];
    }
    [cx / (3.0 * a), cy / (3.0 * a)]
}

/// Grosses Rechteck = Halbebene der Baulinie a–b auf der Seite von `inside`.
fn half_plane(a: [f64; 2], b: [f64; 2], inside: [f64; 2], size: f64) -> Option<Polygon> {
    let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
    let len = dx.hypot(dy);
    if !(len > 1e-9) {
        return None;
    }
    let (ux, uy) = (dx / len, dy / len);
    let (mut nx, mut ny) = (-uy, ux);
    if (inside[0] - a[0]) * nx + (inside[1] - a[1]) * ny < 0.0 {
        nx = -nx;
        ny = -ny;
    }
    let p0 = [a[0] - ux * size, a[1] - uy * size];
    let p1 = [a[0] + ux * size, a[1] + uy * size];
    Some(vec![vec![p0, p1, [p1[0] + nx * size, p1[1] + ny * size], [p0[0] + nx * size, p0[1] + ny * size]]])
}

/// Streifen der Halbbreite `d` um die Strecke a–b mit runden Enden (Puffer der Kante).
fn strip(a: [f64; 2], b: [f64; 2], d: f64) -> Vec<Polygon> {
    if a == b {
        return vec![];
    }
    let style = StrokeStyle::new(2.0 * d).start_cap(LineCap::Round(ARC_STEP)).end_cap(LineCap::Round(ARC_STEP));
    [a, b].as_slice().stroke(style, false)
}

/// Zulässige Grundfläche (leer bei ungültiger Parzelle).
pub fn allowed_area(r: &SiteRules) -> Vec<Polygon> {
    if !valid_parcel(&r.parcel) {
        return vec![];
    }
    let n = r.parcel.len();
    let mut mp: Vec<Polygon> = vec![vec![r.parcel.clone()]];
    let mut strips: Vec<Polygon> = vec![];
    for i in 0..n {
        let d = setback_of(r, i);
        if d > 0.0 {
            strips.extend(strip(r.parcel[i], r.parcel[(i + 1) % n], d));
        }
    }
    mp = polygon_bool::difference(&mp, &strips);
    let c = centroid(&r.parcel);
    let fold = |f: fn(f64, f64) -> f64, k: usize, init: f64| r.parcel.iter().map(|p| p[k]).fold(init, f);
    let size = 10.0
        * (fold(f64::max, 0, f64::NEG_INFINITY) - fold(f64::min, 0, f64::INFINITY) + fold(f64::max, 1, f64::NEG_INFINITY)
            - fold(f64::min, 1, f64::INFINITY)
            + 1.0);
    for line in &r.lines {
        if mp.is_empty() {
            break;
        }
        if let Some(h) = half_plane(line.a, line.b, c, size) {
            mp = polygon_bool::intersection(&mp, &[h]);
        }
    }
    mp
}

/// Ergebnis der Prüfung.
#[derive(Debug)]
pub struct SiteCheck {
    pub parcel_area: f64,
    pub allowed: Vec<Polygon>,
    pub allowed_area: f64,
    /// Gebäude-Grundfläche ausserhalb der zulässigen Fläche.
    pub violations: Vec<Polygon>,
    pub violation_area: f64,
    pub height_exceeded: bool,
}

/// Prüft die Gebäude-Grundfläche (`footprint_parts`, werden vereinigt) und die Modellhöhe
/// `max_top` (NaN = keine Bauteile) gegen das Baurecht; `None` bei ungültiger Parzelle.
pub fn check_site_rules(r: &SiteRules, footprint_parts: &[Polygon], max_height: f64, max_top: f64) -> Option<SiteCheck> {
    if !valid_parcel(&r.parcel) {
        return None;
    }
    let allowed = allowed_area(r);
    let fp = if footprint_parts.is_empty() { vec![] } else { polygon_bool::union(footprint_parts) };
    let violations = if fp.is_empty() {
        vec![]
    } else if allowed.is_empty() {
        fp
    } else {
        polygon_bool::difference(&fp, &allowed)
    };
    // Kleinste Splitter (Rundung an gemeinsamen Kanten) nicht als Verstoss melden.
    let real = drop_slivers(violations);
    Some(SiteCheck {
        parcel_area: signed_area(&r.parcel).abs(),
        allowed_area: multi_polygon_area(&allowed),
        allowed,
        violation_area: multi_polygon_area(&real),
        violations: real,
        height_exceeded: max_height.is_finite() && max_top.is_finite() && max_top > max_height + 1e-6,
    })
}

/// Splitter (Rundung an gemeinsamen Kanten) weglassen.
fn drop_slivers(v: Vec<Polygon>) -> Vec<Polygon> {
    v.into_iter().filter(|p| p.first().is_some_and(|o| signed_area(o).abs() > 1e-4)).collect()
}

// ── Vorsprünge ([63]) ───────────────────────────────────────────────────────
//
// Dachüberstände und als Vorsprung markierte Bauteile (Balkone, Erker) dürfen bis `depth` in den
// Grenzabstand bzw. über die Baulinie ragen; markierte Bauteile zusätzlich höchstens auf `share`
// der Fassadenlänge je Grenze/Baulinie (Ausdehnung längs der Grenze, verglichen mit der
// Ausdehnung der Gebäude-Grundfläche längs derselben Richtung).

/// Vorsprungsregel: Tiefe (m, ≥ 0) und optionaler Höchstanteil der Fassadenlänge.
#[derive(Clone, Copy, Debug)]
pub struct ProjectionRules {
    pub depth: f64,
    pub share: Option<f64>,
}

/// Ein Vorsprung: Grundriss und ob der Fassadenanteil gilt (Balkon/Erker ja, Dachüberstand nein).
pub struct ProjectionPart {
    pub poly: Polygon,
    pub share_limited: bool,
}

/// Zulässige Fläche für Vorsprünge: Grenzabstände um `depth` verringert, Baulinien um `depth`
/// nach aussen geschoben.
pub fn projection_area(r: &SiteRules, depth: f64) -> Vec<Polygon> {
    if !valid_parcel(&r.parcel) {
        return vec![];
    }
    let d = if depth.is_finite() && depth > 0.0 { depth } else { 0.0 };
    let c = centroid(&r.parcel);
    let lines = r
        .lines
        .iter()
        .map(|l| {
            let (dx, dy) = (l.b[0] - l.a[0], l.b[1] - l.a[1]);
            let len = dx.hypot(dy);
            if !(len > 1e-9) {
                return *l;
            }
            let (mut nx, mut ny) = (-dy / len, dx / len);
            if (c[0] - l.a[0]) * nx + (c[1] - l.a[1]) * ny > 0.0 {
                nx = -nx;
                ny = -ny;
            }
            BuildingLine { a: [l.a[0] + nx * d, l.a[1] + ny * d], b: [l.b[0] + nx * d, l.b[1] + ny * d] }
        })
        .collect();
    let setbacks = (0..r.parcel.len()).map(|i| (setback_of(r, i) - d).max(0.0)).collect();
    allowed_area(&SiteRules { parcel: r.parcel.clone(), setbacks, lines })
}

fn seg_dist(p: [f64; 2], a: [f64; 2], b: [f64; 2], infinite: bool) -> f64 {
    let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
    let l2 = dx * dx + dy * dy;
    if !(l2 > 1e-18) {
        return (p[0] - a[0]).hypot(p[1] - a[1]);
    }
    let mut t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2;
    if !infinite {
        t = t.clamp(0.0, 1.0);
    }
    (p[0] - a[0] - t * dx).hypot(p[1] - a[1] - t * dy)
}

/// Ausdehnung [min, max] der Aussenringe längs der Einheitsrichtung `u`.
fn extent(polys: &[Polygon], u: [f64; 2]) -> Option<(f64, f64)> {
    let mut it = polys.iter().filter_map(|p| p.first()).flatten().map(|q| q[0] * u[0] + q[1] * u[1]);
    let first = it.next()?;
    Some(it.fold((first, first), |(lo, hi), v| (lo.min(v), hi.max(v))))
}

/// Vorsprünge, die die Regel verletzen: Teile ausserhalb der zulässigen Fläche, die tiefer als
/// `depth` hineinragen, und markierte Vorsprünge einer Grenze, deren Länge zusammen den
/// Fassadenanteil übersteigt. `allowed` = zulässige Fläche, `main` = Gebäude-Grundfläche (vereinigt).
pub fn projection_violations(r: &SiteRules, allowed: &[Polygon], main: &[Polygon], parts: &[ProjectionPart], rules: ProjectionRules) -> Vec<Polygon> {
    if !valid_parcel(&r.parcel) || parts.is_empty() {
        return vec![];
    }
    let ext = projection_area(r, rules.depth);
    let mut out: Vec<Polygon> = vec![];
    let mut pieces: Vec<Polygon> = vec![];
    for part in parts {
        if part.poly.first().is_none_or(|o| o.len() < 3 || o.iter().any(|q| !(q[0].is_finite() && q[1].is_finite()))) {
            continue;
        }
        let one = std::slice::from_ref(&part.poly);
        let outside = drop_slivers(if allowed.is_empty() { one.to_vec() } else { polygon_bool::difference(one, allowed) });
        if outside.is_empty() {
            continue;
        }
        out.extend(drop_slivers(if ext.is_empty() { outside.clone() } else { polygon_bool::difference(&outside, &ext) }));
        if part.share_limited && rules.share.is_some() && !ext.is_empty() {
            pieces.extend(drop_slivers(polygon_bool::intersection(&outside, &ext)));
        }
    }
    let Some(share) = rules.share else { return out };
    // Grenzen: Parzellenkanten mit Abstand (Strecke) und Baulinien (Gerade).
    let n = r.parcel.len();
    let mut bounds: Vec<([f64; 2], [f64; 2], bool)> = (0..n).filter(|&i| setback_of(r, i) > 0.0).map(|i| (r.parcel[i], r.parcel[(i + 1) % n], false)).collect();
    bounds.extend(r.lines.iter().map(|l| (l.a, l.b, true)));
    let mut groups: Vec<Vec<Polygon>> = vec![vec![]; bounds.len()];
    for piece in pieces {
        let ring = &piece[0];
        let c = centroid(ring);
        let best = bounds
            .iter()
            .enumerate()
            .map(|(k, &(a, b, inf))| (k, seg_dist(c, a, b, inf)))
            .min_by(|x, y| x.1.total_cmp(&y.1));
        if let Some((k, _)) = best {
            groups[k].push(piece);
        }
    }
    for (k, group) in groups.into_iter().enumerate() {
        if group.is_empty() {
            continue;
        }
        let (a, b, _) = bounds[k];
        let len = (b[0] - a[0]).hypot(b[1] - a[1]);
        if !(len > 1e-9) {
            continue;
        }
        let u = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
        let facade = extent(main, u).map_or(0.0, |(lo, hi)| hi - lo);
        let mut iv: Vec<(f64, f64)> = group.iter().filter_map(|p| extent(std::slice::from_ref(p), u)).collect();
        iv.sort_by(|x, y| x.0.total_cmp(&y.0));
        let mut total = 0.0;
        let mut cur: Option<(f64, f64)> = None;
        for (lo, hi) in iv {
            match cur {
                Some((cl, ch)) if lo <= ch => cur = Some((cl, ch.max(hi))),
                _ => {
                    if let Some((cl, ch)) = cur {
                        total += ch - cl;
                    }
                    cur = Some((lo, hi));
                }
            }
        }
        if let Some((cl, ch)) = cur {
            total += ch - cl;
        }
        if total > share * facade + 1e-6 {
            out.extend(group);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x0: f64, y0: f64, x1: f64, y1: f64) -> Ring {
        vec![[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
    }
    fn rules(parcel: Ring, setbacks: Vec<f64>) -> SiteRules {
        SiteRules { parcel, setbacks, lines: vec![] }
    }
    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-6
    }
    const SB4: [f64; 4] = [4.0; 4];

    #[test]
    fn gleicher_abstand_inneres_rechteck() {
        assert!(close(multi_polygon_area(&allowed_area(&rules(rect(0.0, 0.0, 30.0, 20.0), SB4.to_vec()))), 22.0 * 12.0));
    }

    #[test]
    fn abstand_je_kante_und_baulinie() {
        let mut r = rules(rect(0.0, 0.0, 30.0, 20.0), vec![8.0, 4.0, 4.0, 4.0]);
        assert!(close(multi_polygon_area(&allowed_area(&r)), 22.0 * 8.0));
        r.lines.push(BuildingLine { a: [30.0, 14.0], b: [0.0, 14.0] });
        assert!(close(multi_polygon_area(&allowed_area(&r)), 22.0 * 6.0));
    }

    #[test]
    fn umlaufsinn_egal() {
        let mut p = rect(0.0, 0.0, 30.0, 20.0);
        p.reverse();
        assert!(close(multi_polygon_area(&allowed_area(&rules(p, SB4.to_vec()))), 22.0 * 12.0));
    }

    #[test]
    fn einspringende_ecke_rund() {
        // L-Parzelle: an der einspringenden Ecke (10, 10) entsteht ein Viertelkreis-Rand.
        let p = vec![[0.0, 0.0], [20.0, 0.0], [20.0, 10.0], [10.0, 10.0], [10.0, 20.0], [0.0, 20.0]];
        let a = allowed_area(&rules(p, vec![2.0; 6]));
        // Scharfe Innen-L: 16 × 6 + 6 × 10 = 156; dazu das Quadrat (8..10)² ausserhalb des
        // Kreises (r = 2) um die Ecke: 4 − π.
        let area = multi_polygon_area(&a);
        assert!((area - (160.0 - std::f64::consts::PI)).abs() < 1e-3, "{area}");
        // Jeder Punkt der zulässigen Fläche hält ≈ 2 m von der Ecke (10, 10) ein.
        for poly in &a {
            for ring in poly {
                for q in ring {
                    assert!((q[0] - 10.0).hypot(q[1] - 10.0) > 2.0 - 2.0 * 1e-4, "{q:?}");
                }
            }
        }
    }

    #[test]
    fn ungueltige_eingaben() {
        assert!(allowed_area(&rules(rect(0.0, 0.0, 1.0, 1.0)[..2].to_vec(), vec![1.0])).is_empty());
        assert!(close(multi_polygon_area(&allowed_area(&rules(rect(0.0, 0.0, 30.0, 20.0), vec![f64::NAN; 4]))), 600.0));
        assert!(allowed_area(&rules(vec![[f64::NAN, 0.0], [1.0, 0.0], [0.0, 1.0]], vec![])).is_empty());
        assert!(allowed_area(&rules(vec![], vec![])).is_empty());
        // Riesiger Abstand: nichts zulässig, kein Panic.
        assert!(allowed_area(&rules(rect(0.0, 0.0, 30.0, 20.0), vec![1e3; 4])).is_empty());
        let r = rules(rect(0.0, 0.0, 30.0, 20.0), vec![4.0; 4]);
        assert!(check_site_rules(&rules(vec![], vec![]), &[], f64::NAN, f64::NAN).is_none());
        let c = check_site_rules(&r, &[vec![vec![[f64::NAN, 1.0]]]], f64::NAN, f64::NAN).unwrap();
        assert!(c.violations.is_empty() && !c.height_exceeded);
        assert_eq!(multi_polygon_area(&[]), 0.0);
    }

    fn part(poly: Ring, share_limited: bool) -> ProjectionPart {
        ProjectionPart { poly: vec![poly], share_limited }
    }
    fn area_of(v: &[Polygon]) -> f64 {
        multi_polygon_area(v)
    }

    #[test]
    fn vorsprung_flaeche_verringert_abstand_und_schiebt_baulinie() {
        let mut r = rules(rect(0.0, 0.0, 30.0, 20.0), SB4.to_vec());
        assert!(close(area_of(&projection_area(&r, 1.5)), 25.0 * 15.0));
        assert!(close(area_of(&projection_area(&r, 0.0)), 22.0 * 12.0));
        // Tiefe grösser als der Abstand: bis zur Grenze, nicht darüber.
        assert!(close(area_of(&projection_area(&r, 9.0)), 600.0));
        r.lines.push(BuildingLine { a: [30.0, 14.0], b: [0.0, 14.0] });
        // Baulinie 1 m nach aussen (weg vom Schwerpunkt): y ≤ 15.
        assert!(close(area_of(&projection_area(&r, 1.0)), 24.0 * 12.0));
        assert!(projection_area(&rules(vec![], vec![]), 1.0).is_empty());
    }

    #[test]
    fn vorsprung_tiefe() {
        let r = rules(rect(0.0, 0.0, 30.0, 20.0), SB4.to_vec());
        let allowed = allowed_area(&r);
        let main = vec![vec![rect(6.0, 6.0, 24.0, 16.0)]];
        let pr = ProjectionRules { depth: 1.5, share: None };
        // Balkon 1.5 m tief: erlaubt.
        assert!(projection_violations(&r, &allowed, &main, &[part(rect(10.0, 16.0, 14.0, 17.5), true)], pr).is_empty());
        // Balkon 2 m tief: die letzten 0.5 m verletzen.
        let v = projection_violations(&r, &allowed, &main, &[part(rect(10.0, 16.0, 14.0, 18.0), true)], pr);
        assert!(close(area_of(&v), 2.0), "{}", area_of(&v));
        // Dachüberstand ringsum 1 m: erlaubt; 2 m nach Norden: 0.5 m Streifen verletzt.
        assert!(projection_violations(&r, &allowed, &main, &[part(rect(5.0, 5.0, 25.0, 17.0), false)], pr).is_empty());
        let v = projection_violations(&r, &allowed, &main, &[part(rect(3.0, 3.0, 27.0, 18.0), false)], pr);
        assert!(close(area_of(&v), 24.0 * 0.5), "{}", area_of(&v));
        // Ganz innerhalb: nichts.
        assert!(projection_violations(&r, &allowed, &main, &[part(rect(8.0, 8.0, 9.0, 9.0), true)], pr).is_empty());
        // Unsinn: kein Panic, nichts gemeldet.
        assert!(projection_violations(&r, &allowed, &main, &[part(vec![[f64::NAN, 0.0], [1.0, 0.0], [0.0, 1.0]], true)], pr).is_empty());
        let nan = ProjectionRules { depth: f64::NAN, share: None };
        let v = projection_violations(&r, &allowed, &main, &[part(rect(10.0, 16.0, 14.0, 17.0), true)], nan);
        assert!(close(area_of(&v), 4.0));
    }

    #[test]
    fn vorsprung_fassadenanteil() {
        let r = rules(rect(0.0, 0.0, 30.0, 20.0), SB4.to_vec());
        let allowed = allowed_area(&r);
        // Fassade längs der Nordgrenze: 18 m.
        let main = vec![vec![rect(6.0, 6.0, 24.0, 16.0)]];
        let balkone = [part(rect(7.0, 16.0, 11.0, 17.0), true), part(rect(15.0, 16.0, 19.0, 17.0), true)];
        let mit = |share| projection_violations(&r, &allowed, &main, &balkone, ProjectionRules { depth: 1.5, share: Some(share) });
        // 8 m von 18 m = 0.44.
        assert!(mit(0.5).is_empty());
        assert!(close(area_of(&mit(0.4)), 8.0));
        // Überlappende Vorsprünge zählen ihre Länge nur einmal.
        let ueber = [part(rect(7.0, 16.0, 11.0, 17.0), true), part(rect(9.0, 16.0, 13.0, 17.0), true)];
        let v = projection_violations(&r, &allowed, &main, &ueber, ProjectionRules { depth: 1.5, share: Some(6.0 / 18.0) });
        assert!(v.is_empty());
        // Dachüberstände zählen nicht zum Anteil.
        let dach = [part(rect(5.0, 5.0, 25.0, 17.0), false)];
        assert!(projection_violations(&r, &allowed, &main, &dach, ProjectionRules { depth: 1.5, share: Some(0.1) }).is_empty());
    }

    #[test]
    fn pruefung() {
        let r = rules(rect(0.0, 0.0, 30.0, 20.0), SB4.to_vec());
        let c = check_site_rules(&r, &[vec![rect(1.0, 1.0, 6.0, 6.0)]], f64::NAN, 6.0).unwrap();
        assert!(close(c.violation_area, 25.0 - 4.0));
        assert!(close(c.parcel_area, 600.0) && !c.height_exceeded);
        let c = check_site_rules(&r, &[vec![rect(10.0, 6.0, 16.0, 12.0)]], 10.0, 12.0).unwrap();
        assert!(close(c.violation_area, 0.0) && c.violations.is_empty() && c.height_exceeded);
    }
}

// ── Baurecht aus dem Projekt-Dokument ([K4] S2) ─────────────────────────────

use crate::jsmath::hypot2;
use crate::model::{Project, Vec2};
use serde::Serialize;

/// Mehrfach-Fläche mit `Vec2`-Punkten (JSON-Form wie `Area` in TS).
pub type AreaOut = Vec<Vec<Vec<Vec2>>>;

pub fn area_out(polys: &[Polygon]) -> AreaOut {
    polys.iter().map(|p| p.iter().map(|r| r.iter().map(|q| Vec2 { x: q[0], y: q[1] }).collect()).collect()).collect()
}

pub(crate) fn wall_corners(start: Vec2, end: Vec2, thickness: f64) -> Vec<[f64; 2]> {
    let h = thickness / 2.0;
    let (dx, dy) = (end.x - start.x, end.y - start.y);
    let l = hypot2(dx, dy);
    let l = if l == 0.0 || l.is_nan() { 1.0 } else { l };
    let (ux, uy) = (dx / l, dy / l);
    let (nx, ny) = (-uy, ux);
    vec![
        [start.x + nx * h, start.y + ny * h],
        [end.x + nx * h, end.y + ny * h],
        [end.x + nx * -h, end.y + ny * -h],
        [start.x + nx * -h, start.y + ny * -h],
    ]
}

/// Grundriss einer Wand (Bogenwand [T2]: Kreisringsektor); `None` bei Länge 0.
fn wall_footprint(p: &Project, w: &crate::model::Wall) -> Option<Ring> {
    if hypot2(w.end.x - w.start.x, w.end.y - w.start.y) < 1e-9 {
        return None;
    }
    let t = p.wall_thickness(w, 0.2);
    Some(crate::wall_arc::arc_footprint(w, t).unwrap_or_else(|| wall_corners(w.start, w.end, t)))
}

/// Teile der Gebäude-Grundfläche (Wände aller Geschosse, freie Körper ohne Abzugskörper). Mit
/// `skip_projections` fehlen die als Vorsprung markierten Körper (sie prüft die Vorsprungsregel).
fn footprint_parts(p: &Project) -> Vec<Polygon> {
    footprint_parts_with(p, false)
}

fn footprint_parts_with(p: &Project, skip_projections: bool) -> Vec<Polygon> {
    let mut parts: Vec<Polygon> = Vec::new();
    for w in &p.walls {
        if skip_projections && w.site_projection == Some(true) {
            continue;
        }
        if let Some(f) = wall_footprint(p, w) {
            parts.push(vec![f]);
        }
    }
    for s in p.extruded_solids.as_deref().unwrap_or(&[]) {
        if s.operation.as_deref() == Some("subtract") || s.points.len() < 3 || (skip_projections && s.site_projection == Some(true)) {
            continue;
        }
        parts.push(vec![s.points.iter().map(|v| [v.x, v.y]).collect()]);
    }
    parts
}

/// Vorsprünge ([63]): Dach-Traufumrisse (mit Überstand; ohne Fassadenanteil), als Vorsprung
/// markierte Decken und Körper (mit Fassadenanteil).
fn projection_parts(p: &Project) -> Vec<ProjectionPart> {
    let mut out = Vec::new();
    for r in p.roofs.as_deref().unwrap_or(&[]) {
        let g = crate::roof::roof_geometry(&r.params(), p.roof_base_elevation(r));
        if g.eaves.len() >= 3 {
            let mut poly = vec![g.eaves.clone()];
            poly.extend(g.eaves_holes.iter().cloned());
            out.push(ProjectionPart { poly, share_limited: false });
        }
    }
    for c in p.ceilings.as_deref().unwrap_or(&[]) {
        if c.site_projection == Some(true) && c.outline.len() >= 3 {
            out.push(ProjectionPart { poly: vec![c.outline.iter().map(|v| [v.x, v.y]).collect()], share_limited: true });
        }
    }
    for s in p.extruded_solids.as_deref().unwrap_or(&[]) {
        if s.site_projection == Some(true) && s.operation.as_deref() != Some("subtract") && s.points.len() >= 3 {
            out.push(ProjectionPart { poly: vec![s.points.iter().map(|v| [v.x, v.y]).collect()], share_limited: true });
        }
    }
    // Wände eines Erkers: je Wand ein Teil, der Fassadenanteil vereinigt ihre Ausdehnungen längs der Grenze.
    for w in p.walls.iter().filter(|w| w.site_projection == Some(true)) {
        if let Some(f) = wall_footprint(p, w) {
            out.push(ProjectionPart { poly: vec![f], share_limited: true });
        }
    }
    out
}

/// Vorsprungsregel des Projekts; `None` ohne (gültige) Tiefe = altes Verhalten.
fn projection_rules(r: &crate::model::SiteRules) -> Option<ProjectionRules> {
    let depth = r.projection_depth.filter(|d| d.is_finite())?;
    Some(ProjectionRules { depth: depth.max(0.0), share: r.projection_share.filter(|v| v.is_finite()).map(|v| v.max(0.0)) })
}

/// Grundfläche des Gebäudes (vereinigt).
pub fn building_footprint(p: &Project) -> AreaOut {
    let parts = footprint_parts(p);
    if parts.is_empty() {
        return vec![];
    }
    area_out(&polygon_bool::union(&parts))
}

/// Höchster Punkt des Modells über ±0.00 (Wände, freie Körper, Dächer); `None` ohne Bauteile.
pub fn model_top(p: &Project) -> Option<f64> {
    let mut top = f64::NEG_INFINITY;
    for w in &p.walls {
        top = top.max(p.wall_vertical_extent(w).1);
    }
    for s in p.extruded_solids.as_deref().unwrap_or(&[]) {
        if s.operation.as_deref() == Some("subtract") {
            continue;
        }
        let base = p.floor(&s.level_id).map_or(0.0, |f| f.base_elevation.unwrap_or(0.0));
        top = top.max(base + s.base_offset.unwrap_or(0.0) + s.height);
    }
    for r in p.roofs.as_deref().unwrap_or(&[]) {
        let eaves = p.roof_base_elevation(r);
        top = top.max(eaves + crate::roof::roof_geometry(&r.params(), eaves).ridge_height);
    }
    top.is_finite().then_some(top)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SiteCheckOut {
    pub parcel_area: f64,
    pub allowed: AreaOut,
    pub allowed_area: f64,
    pub violations: AreaOut,
    pub violation_area: f64,
    pub max_top: Option<f64>,
    pub height_exceeded: bool,
    /// [T6] Geländehöhen an der Fassade (Grundfläche, Ecken + alle ≤ 2 m), Modellbezug; leer ohne Gelände.
    pub facade_terrain: Vec<FacadePoint>,
    /// Tiefster Punkt des gewachsenen Terrains an der Fassade (massgebendes Terrain, vereinfacht).
    pub terrain_min: Option<f64>,
    /// Gesamthöhe über dem massgebenden Terrain (`maxTop − terrainMin`); ohne Gelände `None` (dann gilt ±0.00).
    pub height_above_terrain: Option<f64>,
    /// Gebäudeprofil ([63]): ein Bauteil ragt über das Profil (nur mit `profileAngle`).
    pub profile_exceeded: bool,
    /// Grundrisse der Bauteile, deren obere Punkte über dem Profil liegen (Näherung: ganzes Bauteil).
    pub profile_violations: AreaOut,
}

/// Fassadenpunkt mit gewachsenem und gestaltetem Terrain (Modellbezug; `None` ausserhalb des Geländes).
#[derive(Debug, Serialize)]
pub struct FacadePoint {
    pub x: f64,
    pub y: f64,
    pub natural: Option<f64>,
    pub designed: Option<f64>,
}

/// Geländehöhen an der Fassade: Ecken der Aussenringe der Grundfläche und Zwischenpunkte (≤ 2 m).
pub fn facade_terrain(p: &Project) -> Vec<FacadePoint> {
    if crate::excavation::terrains(p).is_empty() {
        return Vec::new();
    }
    let mut pts = Vec::new();
    for poly in building_footprint(p) {
        let Some(ring) = poly.first() else { continue };
        let n = ring.len();
        for i in 0..n {
            let (a, b) = (ring[i], ring[(i + 1) % n]);
            let k = (hypot2(b.x - a.x, b.y - a.y) / 2.0).ceil().max(1.0) as usize;
            for j in 0..k {
                let f = j as f64 / k as f64;
                pts.push([a.x + (b.x - a.x) * f, a.y + (b.y - a.y) * f]);
            }
        }
    }
    // [159] Gelände und Suchindex einmal für alle Punkte (vorher je Punkt neu: ~1.4 s im Musterhaus komplex).
    let z = crate::excavation::terrain_z_many(p, &pts);
    pts.into_iter().zip(z).map(|(q, (natural, designed))| FacadePoint { x: q[0], y: q[1], natural, designed }).collect()
}

fn flat_rules(r: &crate::model::SiteRules) -> SiteRules {
    SiteRules {
        parcel: r.parcel.iter().map(|v| [v.x, v.y]).collect(),
        setbacks: (0..r.parcel.len()).map(|i| r.setbacks.as_ref().and_then(|s| s.get(i)).copied().unwrap_or(r.default_setback)).collect(),
        lines: r.building_lines.as_deref().unwrap_or(&[]).iter().map(|l| BuildingLine { a: [l.a.x, l.a.y], b: [l.b.x, l.b.y] }).collect(),
    }
}

/// Prüft das Modell gegen `siteRules`; `None` ohne (gültiges) Baurecht.
pub fn check_project(p: &Project) -> Option<SiteCheckOut> {
    let r = p.site_rules.as_ref()?;
    let max_top = model_top(p);
    let rules = flat_rules(r);
    let facade = facade_terrain(p);
    let terrain_min = facade.iter().filter_map(|f| f.natural).reduce(f64::min);
    let height_above_terrain = max_top.zip(terrain_min).map(|(t, g)| t - g);
    // Mit Gelände zählt die Höhe über dem massgebenden Terrain, sonst über ±0.00.
    let top_for_check = height_above_terrain.or(max_top);
    let proj = projection_rules(r);
    let parts = footprint_parts_with(p, proj.is_some());
    let mut c = check_site_rules(&rules, &parts, r.max_height.unwrap_or(f64::NAN), top_for_check.unwrap_or(f64::NAN))?;
    if let Some(pr) = proj {
        let main = if parts.is_empty() { vec![] } else { polygon_bool::union(&parts) };
        let pv = projection_violations(&rules, &c.allowed, &main, &projection_parts(p), pr);
        if !pv.is_empty() {
            let mut all = std::mem::take(&mut c.violations);
            all.extend(pv);
            c.violations = drop_slivers(polygon_bool::union(&all));
            c.violation_area = multi_polygon_area(&c.violations);
        }
    }
    let prof = profile_of(r, terrain_min.unwrap_or(0.0));
    let pv: Vec<Polygon> = prof.map_or(vec![], |pf| top_parts(p).into_iter().filter(|t| part_above_profile(&rules, pf, t)).map(|t| t.foot).collect());
    Some(SiteCheckOut {
        profile_exceeded: !pv.is_empty(),
        profile_violations: area_out(&pv),
        parcel_area: c.parcel_area,
        allowed: area_out(&c.allowed),
        allowed_area: c.allowed_area,
        violations: area_out(&c.violations),
        violation_area: c.violation_area,
        max_top,
        height_exceeded: c.height_exceeded,
        facade_terrain: facade,
        terrain_min,
        height_above_terrain,
    })
}

// ── Gebäudeprofil ([63]) ────────────────────────────────────────────────────
//
// Zulässige Höhe am Punkt p: h0 + tan(α)·d(p), d = Abstand zur nächsten Parzellengrenze (Strecke)
// oder Baulinie (Gerade); h0 = Profilhöhe an der Grenze über dem massgebenden Terrain (ohne
// Gelände ±0.00). Geprüft werden die oberen Punkte der Bauteile (Wandkronen, Körper-Deckel,
// Dachflächen und Giebel; Kanten alle ≤ 1 m abgetastet) — nicht das Volumen: ragt ein Punkt
// über das Profil, gilt das ganze Bauteil als Verstoss (Grundriss rot).

/// Profil: Höhe an der Grenze (absolut, Modellbezug) und Steigung tan(α).
#[derive(Clone, Copy, Debug)]
pub struct Profile {
    pub h0: f64,
    pub slope: f64,
}

/// Profil des Baurechts mit Bezugshöhe `base`; `None` ohne gültigen Winkel (0 < α < 90).
fn profile_of(r: &crate::model::SiteRules, base: f64) -> Option<Profile> {
    let a = r.profile_angle.filter(|a| a.is_finite() && *a > 0.0 && *a < 90.0)?;
    let h = r.profile_height.filter(|h| h.is_finite()).unwrap_or(0.0);
    Some(Profile { h0: base + h, slope: crate::jsnum::tan(a.to_radians()) })
}

/// Zulässige Höhe (absolut) des Profils am Punkt p.
pub fn profile_limit(r: &SiteRules, pf: Profile, p: [f64; 2]) -> f64 {
    let n = r.parcel.len();
    let d = (0..n)
        .map(|i| seg_dist(p, r.parcel[i], r.parcel[(i + 1) % n], false))
        .chain(r.lines.iter().map(|l| seg_dist(p, l.a, l.b, true)))
        .fold(f64::INFINITY, f64::min);
    pf.h0 + pf.slope * if d.is_finite() { d } else { 0.0 }
}

/// Bauteil von oben: Grundriss und obere Punkte (x, y, z absolut).
pub struct TopPart {
    pub foot: Polygon,
    pub pts: Vec<[f64; 3]>,
}

/// Ring auf Höhe z mit Zwischenpunkten alle ≤ 1 m.
fn ring_at(ring: &[[f64; 2]], z: f64, out: &mut Vec<[f64; 3]>) {
    let n = ring.len();
    for i in 0..n {
        let (a, b) = (ring[i], ring[(i + 1) % n]);
        let k = ((b[0] - a[0]).hypot(b[1] - a[1])).ceil().clamp(1.0, 1000.0) as usize;
        for j in 0..k {
            let f = j as f64 / k as f64;
            out.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, z]);
        }
    }
}

/// 3D-Polygon mit Zwischenpunkten alle ≤ 1 m.
fn poly3_pts(ring: &[[f64; 3]], out: &mut Vec<[f64; 3]>) {
    let n = ring.len();
    for i in 0..n {
        let (a, b) = (ring[i], ring[(i + 1) % n]);
        let k = ((b[0] - a[0]).hypot(b[1] - a[1])).ceil().clamp(1.0, 1000.0) as usize;
        for j in 0..k {
            let f = j as f64 / k as f64;
            out.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f]);
        }
    }
}

/// Wände (Krone), freie Körper (Deckel) und Dächer (Flächen, Giebel) mit ihren oberen Punkten.
pub fn top_parts(p: &Project) -> Vec<TopPart> {
    let mut out = Vec::new();
    for w in &p.walls {
        let Some(f) = wall_footprint(p, w) else { continue };
        let mut pts = Vec::new();
        ring_at(&f, p.wall_vertical_extent(w).1, &mut pts);
        out.push(TopPart { foot: vec![f], pts });
    }
    for s in p.extruded_solids.as_deref().unwrap_or(&[]) {
        if s.operation.as_deref() == Some("subtract") || s.points.len() < 3 {
            continue;
        }
        let base = p.floor(&s.level_id).map_or(0.0, |f| f.base_elevation.unwrap_or(0.0));
        let f: Ring = s.points.iter().map(|v| [v.x, v.y]).collect();
        let mut pts = Vec::new();
        ring_at(&f, base + s.base_offset.unwrap_or(0.0) + s.height, &mut pts);
        out.push(TopPart { foot: vec![f], pts });
    }
    for r in p.roofs.as_deref().unwrap_or(&[]) {
        let g = crate::roof::roof_geometry(&r.params(), p.roof_base_elevation(r));
        if g.eaves.len() < 3 {
            continue;
        }
        let mut pts = Vec::new();
        for f in g.planes.iter().chain(g.gables.iter()) {
            poly3_pts(f, &mut pts);
        }
        let mut foot = vec![g.eaves.clone()];
        foot.extend(g.eaves_holes.iter().cloned());
        out.push(TopPart { foot, pts });
    }
    out
}

fn part_above_profile(r: &SiteRules, pf: Profile, t: &TopPart) -> bool {
    t.pts.iter().any(|q| q[2].is_finite() && q[2] > profile_limit(r, pf, [q[0], q[1]]) + 1e-6)
}

// ── Zulässige Hülle im 3D ([63]) ───────────────────────────────────────────

/// Farbe der Hülle (RGBA, durchscheinend), ihrer Kanten und der Verstösse.
pub const ENVELOPE_RGBA: [f32; 4] = [0.25, 0.55, 0.95, 0.16];
pub const ENVELOPE_EDGE: [f32; 3] = [0.15, 0.4, 0.8];
pub const VIOLATION_RGBA: [f32; 4] = [0.9, 0.12, 0.08, 0.4];

/// Durchscheinende Körper für render3d (`set_ghost`): Dreiecke `[x y z r g b a]` und Kanten
/// `[x y z r g b]` (LineList), Welt = (x, Höhe, y) wie `drawing_line_verts`.
#[derive(Debug, Default)]
pub struct Envelope3d {
    pub tris: Vec<f32>,
    pub lines: Vec<f32>,
}

fn polys_in(a: &AreaOut) -> Vec<Polygon> {
    a.iter().map(|p| p.iter().map(|r| r.iter().map(|q| [q.x, q.y]).collect()).collect()).collect()
}

/// Prismen der Mehrfach-Fläche von `z0` bis `z1`; `edge` = Kantenfarbe (None: keine Kanten).
fn push_prisms(out: &mut Envelope3d, polys: &[Polygon], z0: f64, z1: f64, rgba: [f32; 4], edge: Option<[f32; 3]>) {
    if !(z0.is_finite() && z1.is_finite() && z1 > z0) {
        return;
    }
    let (b, t) = (z0 as f32, z1 as f32);
    let tris = &mut out.tris;
    let mut tri = |p: [f64; 2], z: f32| tris.extend([p[0] as f32, z, p[1] as f32, rgba[0], rgba[1], rgba[2], rgba[3]]);
    for poly in polys {
        let Some(outer) = poly.first() else { continue };
        if outer.len() < 3 {
            continue;
        }
        let ring = crate::polygon_holes::merge_holes(outer, &poly[1..], 1e-4).ring;
        let pts: Vec<_> = ring.iter().map(|q| crate::hatch::v2(q[0], q[1])).collect();
        for k in crate::gpu_compile::triangulate(&pts).chunks_exact(3) {
            for z in [b, t] {
                for &i in k {
                    tri(ring[i as usize], z);
                }
            }
        }
        for r in poly {
            let n = r.len();
            if n < 3 {
                continue;
            }
            for i in 0..n {
                let (p, q) = (r[i], r[(i + 1) % n]);
                for (v, z) in [(p, b), (q, b), (q, t), (p, b), (q, t), (p, t)] {
                    tri(v, z);
                }
            }
        }
    }
    let Some(e) = edge else { return };
    let mut line = |p: [f64; 2], z: f32| out.lines.extend([p[0] as f32, z, p[1] as f32, e[0], e[1], e[2]]);
    for poly in polys {
        for ring in poly {
            let n = ring.len();
            if n < 3 {
                continue;
            }
            for i in 0..n {
                let (o, p, q) = (ring[(i + n - 1) % n], ring[i], ring[(i + 1) % n]);
                for z in [b, t] {
                    line(p, z);
                    line(q, z);
                }
                // Senkrechte Kante nur an echten Ecken (nicht in gerundeten Bögen).
                let (ax, ay, bx, by) = (p[0] - o[0], p[1] - o[1], q[0] - p[0], q[1] - p[1]);
                let turn = crate::jsnum::atan2(ax * by - ay * bx, ax * bx + ay * by).abs();
                if turn > 0.2 {
                    line(p, b);
                    line(p, t);
                }
            }
        }
    }
}

/// Kantenlänge, bis zu der die Profil-Oberseite mindestens verfeinert wird, und Abbruch der Verfeinerung.
const PROFILE_COARSE: f64 = 3.0;
const PROFILE_FINE: f64 = 0.25;
const PROFILE_TOL: f64 = 0.01;

/// Körper über der Mehrfach-Fläche von `z0` bis zur Oberseite `ztop(p)` (Gebäudeprofil, gedeckelt):
/// Boden flach, Oberseite aus der Triangulierung verfeinert (bis Kanten ≤ 3 m, dann wo die Höhe von
/// der linearen Näherung um > 1 cm abweicht, höchstens bis 0.25 m — Knicke im Profil sind so
/// genähert), Seiten alle ≤ 0.5 m abgetastet.
fn push_profile_body(out: &mut Envelope3d, polys: &[Polygon], z0: f64, ztop: impl Fn([f64; 2]) -> f64) {
    if !z0.is_finite() {
        return;
    }
    let rgba = ENVELOPE_RGBA;
    let tris = &mut out.tris;
    let mut put = |q: [f64; 3]| tris.extend([q[0] as f32, q[2] as f32, q[1] as f32, rgba[0], rgba[1], rgba[2], rgba[3]]);
    let at = |q: [f64; 2]| {
        let z = ztop(q);
        [q[0], q[1], if z.is_finite() { z } else { z0 }]
    };
    fn refine(a: [f64; 3], b: [f64; 3], c: [f64; 3], at: &dyn Fn([f64; 2]) -> [f64; 3], put: &mut dyn FnMut([f64; 3]), depth: u32) {
        let mid = |p: [f64; 3], q: [f64; 3]| at([(p[0] + q[0]) / 2.0, (p[1] + q[1]) / 2.0]);
        let (ab, bc, ca) = (mid(a, b), mid(b, c), mid(c, a));
        let len = |p: [f64; 3], q: [f64; 3]| (p[0] - q[0]).hypot(p[1] - q[1]);
        let longest = len(a, b).max(len(b, c)).max(len(c, a));
        let g = at([(a[0] + b[0] + c[0]) / 3.0, (a[1] + b[1] + c[1]) / 3.0]);
        let err = [(ab, a, b), (bc, b, c), (ca, c, a)]
            .iter()
            .map(|(m, p, q)| (m[2] - (p[2] + q[2]) / 2.0).abs())
            .fold((g[2] - (a[2] + b[2] + c[2]) / 3.0).abs(), f64::max);
        let split = depth < 14 && (longest > PROFILE_COARSE || (err > PROFILE_TOL && longest > PROFILE_FINE));
        if !split {
            for v in [a, b, c] {
                put(v);
            }
            return;
        }
        for (p, q, r) in [(a, ab, ca), (ab, b, bc), (ca, bc, c), (ab, bc, ca)] {
            refine(p, q, r, at, put, depth + 1);
        }
    }
    for poly in polys {
        let Some(outer) = poly.first() else { continue };
        if outer.len() < 3 {
            continue;
        }
        let ring = crate::polygon_holes::merge_holes(outer, &poly[1..], 1e-4).ring;
        let pts: Vec<_> = ring.iter().map(|q| crate::hatch::v2(q[0], q[1])).collect();
        for k in crate::gpu_compile::triangulate(&pts).chunks_exact(3) {
            let [i, j, l] = [k[0] as usize, k[1] as usize, k[2] as usize];
            for &m in &[i, j, l] {
                put([ring[m][0], ring[m][1], z0]);
            }
            refine(at(ring[i]), at(ring[j]), at(ring[l]), &at, &mut put, 0);
        }
        for r in poly {
            let n = r.len();
            if n < 3 {
                continue;
            }
            for i in 0..n {
                let (p, q) = (r[i], r[(i + 1) % n]);
                let k = ((q[0] - p[0]).hypot(q[1] - p[1]) / 0.5).ceil().clamp(1.0, 2000.0) as usize;
                for j in 0..k {
                    let (f0, f1) = (j as f64 / k as f64, (j + 1) as f64 / k as f64);
                    let u = at([p[0] + (q[0] - p[0]) * f0, p[1] + (q[1] - p[1]) * f0]);
                    let v = at([p[0] + (q[0] - p[0]) * f1, p[1] + (q[1] - p[1]) * f1]);
                    let (ub, vb) = ([u[0], u[1], z0], [v[0], v[1], z0]);
                    for w in [ub, vb, v, ub, v, u] {
                        put(w);
                    }
                }
            }
        }
    }
    // Kanten: Boden- und Oberkante der Ringe, Senkrechte an echten Ecken.
    let e = ENVELOPE_EDGE;
    let mut line = |q: [f64; 3]| out.lines.extend([q[0] as f32, q[2] as f32, q[1] as f32, e[0], e[1], e[2]]);
    for poly in polys {
        for r in poly {
            let n = r.len();
            if n < 3 {
                continue;
            }
            for i in 0..n {
                let (o, p, q) = (r[(i + n - 1) % n], r[i], r[(i + 1) % n]);
                line([p[0], p[1], z0]);
                line([q[0], q[1], z0]);
                let k = ((q[0] - p[0]).hypot(q[1] - p[1]) / 0.5).ceil().clamp(1.0, 2000.0) as usize;
                for j in 0..k {
                    let (f0, f1) = (j as f64 / k as f64, (j + 1) as f64 / k as f64);
                    line(at([p[0] + (q[0] - p[0]) * f0, p[1] + (q[1] - p[1]) * f0]));
                    line(at([p[0] + (q[0] - p[0]) * f1, p[1] + (q[1] - p[1]) * f1]));
                }
                let (ax, ay, bx, by) = (p[0] - o[0], p[1] - o[1], q[0] - p[0], q[1] - p[1]);
                if crate::jsnum::atan2(ax * by - ay * bx, ax * bx + ay * by).abs() > 0.2 {
                    line([p[0], p[1], z0]);
                    line(at(p));
                }
            }
        }
    }
}

/// Zulässige Hülle (zulässige Fläche vom massgebenden Terrain bzw. ±0.00 bis zur Gesamthöhe;
/// ohne Gesamthöhe bis zur Modellhöhe, mind. 3 m) und rote Verstösse (Grundfläche ausserhalb bis
/// zur Modellhöhe, Teil über der Gesamthöhe). Leer ohne Baurecht oder mit `show3d` ≠ true.
pub fn envelope3d(p: &Project) -> Envelope3d {
    let mut out = Envelope3d::default();
    let Some(r) = p.site_rules.as_ref().filter(|r| r.show3d == Some(true)) else { return out };
    let Some(c) = check_project(p) else { return out };
    let base = c.terrain_min.unwrap_or(0.0);
    let top = match r.max_height {
        Some(h) if h.is_finite() && h > 0.0 => base + h,
        _ => c.max_top.map_or(base + 10.0, |t| t.max(base + 3.0)),
    };
    let rules = flat_rules(r);
    let model_top = c.max_top.unwrap_or(top);
    match profile_of(r, base) {
        Some(pf) => {
            push_profile_body(&mut out, &polys_in(&c.allowed), base, |q| profile_limit(&rules, pf, q).min(top).max(base + 0.01));
            // Bauteile über dem Profil: Grundriss rot vom tiefsten Profilpunkt darüber bis zur Oberkante (Näherung).
            for t in top_parts(p).iter().filter(|t| part_above_profile(&rules, pf, t)) {
                let lo = t.pts.iter().map(|q| profile_limit(&rules, pf, [q[0], q[1]])).fold(f64::INFINITY, f64::min).max(base);
                let hi = t.pts.iter().map(|q| q[2]).fold(f64::NEG_INFINITY, f64::max);
                push_prisms(&mut out, std::slice::from_ref(&t.foot), lo, hi, VIOLATION_RGBA, None);
            }
        }
        None => push_prisms(&mut out, &polys_in(&c.allowed), base, top, ENVELOPE_RGBA, Some(ENVELOPE_EDGE)),
    }
    push_prisms(&mut out, &polys_in(&c.violations), base, model_top.max(base + 0.1), VIOLATION_RGBA, None);
    if c.height_exceeded {
        // Teil über der Hülle (die Hülle steht auf `base`, die Höhe ist gegen das Terrain geprüft).
        push_prisms(&mut out, &polys_in(&building_footprint(p)), top, model_top, VIOLATION_RGBA, None);
    }
    out
}

#[cfg(test)]
mod project_tests {
    use super::*;
    use serde_json::json;

    fn project(extra: serde_json::Value) -> Project {
        let mut v = json!({
            "id": "p", "name": "P", "lineStyles": [], "hatches": [], "components": [], "wallTypes": [],
            "drawingLevels": [{"id": "eg", "name": "EG", "kind": "floor", "visible": true, "locked": false, "floorHeight": 3.0, "cutHeight": 1.0, "baseElevation": 0}],
            "layers": [], "walls": [], "openings": [], "ceilings": [], "stairs": [], "rooms": [], "drawings2d": [], "context": [],
            "siteRules": {"parcel": [{"x": 0, "y": 0}, {"x": 30, "y": 0}, {"x": 30, "y": 20}, {"x": 0, "y": 20}], "defaultSetback": 4.0}
        });
        for (k, val) in extra.as_object().unwrap() {
            if k == "siteRules" {
                for (k2, v2) in val.as_object().unwrap() {
                    v["siteRules"][k2] = v2.clone();
                }
            } else {
                v[k] = val.clone();
            }
        }
        serde_json::from_value(v).unwrap()
    }
    fn rect(x0: f64, y0: f64, x1: f64, y1: f64) -> serde_json::Value {
        json!([{"x": x0, "y": y0}, {"x": x1, "y": y0}, {"x": x1, "y": y1}, {"x": x0, "y": y1}])
    }
    fn solid(id: &str, pts: serde_json::Value, projection: bool) -> serde_json::Value {
        let mut s = json!({"id": id, "type": "extrudedSolid", "levelId": "eg", "points": pts, "height": 3.0});
        if projection {
            s["siteProjection"] = json!(true);
        }
        s
    }
    fn roof(overhang: f64) -> serde_json::Value {
        json!({"id": "r", "type": "roof", "floorId": "eg", "categoryCode": "35", "outline": rect(6.0, 6.0, 24.0, 16.0), "shape": "flach",
               "pitchDeg": 0, "overhang": overhang, "ridgeAxis": "x", "thickness": 0.3})
    }

    #[test]
    fn ohne_vorsprungsregel_wie_bisher() {
        // Markierter Körper und Dachüberstand im Abstand: ohne Regel zählt der Körper als Grundfläche, das Dach nicht.
        let p = project(json!({"extrudedSolids": [solid("h", rect(6.0, 6.0, 24.0, 16.0), false), solid("b", rect(10.0, 16.0, 14.0, 17.0), true)], "roofs": [roof(2.0)]}));
        let c = check_project(&p).unwrap();
        assert!((c.violation_area - 4.0).abs() < 1e-6, "{}", c.violation_area);
    }

    #[test]
    fn vorsprungsregel_im_projekt() {
        let solids = json!([solid("h", rect(6.0, 6.0, 24.0, 16.0), false), solid("b", rect(10.0, 16.0, 14.0, 17.0), true)]);
        // Balkon 1 m und Dachüberstand 1 m bei zulässigen 1.5 m: keine Verstösse.
        let p = project(json!({"extrudedSolids": solids, "roofs": [roof(1.0)], "siteRules": {"projectionDepth": 1.5}}));
        let c = check_project(&p).unwrap();
        assert!(c.violations.is_empty(), "{}", c.violation_area);
        // Dachüberstand 2 m: nur nach Norden (Gebäude 6 m vor der Grenze, Abstand 4 m) ragt er
        // 2 m in den Abstand, 0.5 m davon zu tief, auf 18 + 2·2 = 22 m Länge.
        let p = project(json!({"extrudedSolids": solids, "roofs": [roof(2.0)], "siteRules": {"projectionDepth": 1.5}}));
        let c = check_project(&p).unwrap();
        assert!((c.violation_area - 22.0 * 0.5).abs() < 1e-3, "{}", c.violation_area);
        // Anteil 0.2 der 18 m langen Fassade: Balkon 4 m ist zu lang.
        let p = project(json!({"extrudedSolids": solids, "siteRules": {"projectionDepth": 1.5, "projectionShare": 0.2}}));
        let c = check_project(&p).unwrap();
        assert!((c.violation_area - 4.0).abs() < 1e-6, "{}", c.violation_area);
    }

    fn wall(id: &str, a: [f64; 2], b: [f64; 2], projection: bool) -> serde_json::Value {
        let mut w = json!({"id": id, "type": "wall", "floorId": "eg", "categoryCode": "20", "start": {"x": a[0], "y": a[1]},
                           "end": {"x": b[0], "y": b[1]}, "wallTypeId": "", "height": 3.0});
        if projection {
            w["siteProjection"] = json!(true);
        }
        w
    }

    #[test]
    fn erkerwaende_als_vorsprung() {
        let solids = json!([solid("h", rect(6.0, 6.0, 24.0, 16.0), false)]);
        let erker = |m: bool| json!([wall("a", [10.0, 16.0], [10.0, 17.0], m), wall("b", [10.0, 17.0], [14.0, 17.0], m), wall("c", [14.0, 17.0], [14.0, 16.0], m)]);
        // Nicht markiert: die Wände zählen zur Grundfläche und liegen im Abstand.
        let c = check_project(&project(json!({"extrudedSolids": solids, "walls": erker(false), "siteRules": {"projectionDepth": 1.5}}))).unwrap();
        assert!(c.violation_area > 0.5, "{}", c.violation_area);
        // Markiert, Tiefe 1.5 m (Erker bis 17.1): keine Verstösse.
        let c = check_project(&project(json!({"extrudedSolids": solids, "walls": erker(true), "siteRules": {"projectionDepth": 1.5}}))).unwrap();
        assert!(c.violations.is_empty(), "{}", c.violation_area);
        // Anteil 0.2 von 18 m = 3.6 m < 4.2 m Erkerbreite: alle Erkerwände im Abstand rot.
        let c = check_project(&project(json!({"extrudedSolids": solids, "walls": erker(true), "siteRules": {"projectionDepth": 1.5, "projectionShare": 0.2}}))).unwrap();
        assert!(c.violation_area > 0.5, "{}", c.violation_area);
        // Anteil 0.3 = 5.4 m: erlaubt.
        let c = check_project(&project(json!({"extrudedSolids": solids, "walls": erker(true), "siteRules": {"projectionDepth": 1.5, "projectionShare": 0.3}}))).unwrap();
        assert!(c.violations.is_empty(), "{}", c.violation_area);
    }

    #[test]
    fn gebaeudeprofil_pruefung() {
        let tall = |h: f64| {
            let mut s = solid("h", rect(6.0, 6.0, 24.0, 16.0), false);
            s["height"] = json!(h);
            json!([s])
        };
        // Ohne Profil: nichts.
        let c = check_project(&project(json!({"extrudedSolids": tall(10.0)}))).unwrap();
        assert!(!c.profile_exceeded && c.profile_violations.is_empty());
        // 45° ab 2 m an der Grenze: Nordkante 4 m von der Grenze ⇒ 6 m zulässig.
        let rules = json!({"profileAngle": 45.0, "profileHeight": 2.0});
        let c = check_project(&project(json!({"extrudedSolids": tall(5.9), "siteRules": rules}))).unwrap();
        assert!(!c.profile_exceeded);
        let c = check_project(&project(json!({"extrudedSolids": tall(6.1), "siteRules": rules}))).unwrap();
        assert!(c.profile_exceeded);
        assert!((multi_polygon_area(&polys_in(&c.profile_violations)) - 180.0).abs() < 1e-6);
        // Baulinie bei y = 18: Profil ab der Baulinie, Nordkante 2 m dahinter ⇒ 4 m.
        let r2 = json!({"profileAngle": 45.0, "profileHeight": 2.0, "buildingLines": [{"a": {"x": 0, "y": 18}, "b": {"x": 30, "y": 18}}]});
        let c = check_project(&project(json!({"extrudedSolids": tall(4.5), "siteRules": r2}))).unwrap();
        assert!(c.profile_exceeded);
        // Ungültiger Winkel: kein Profil.
        let c = check_project(&project(json!({"extrudedSolids": tall(50.0), "siteRules": {"profileAngle": 90.0}}))).unwrap();
        assert!(!c.profile_exceeded);
    }

    #[test]
    fn gebaeudeprofil_dach() {
        // Satteldach 45° über 10 m (Traufe 3 m, First 8 m, Giebel bei x = 6 und 24, 6 m von der Grenze).
        let mut r = roof(0.0);
        r["shape"] = json!("sattel");
        r["pitchDeg"] = json!(45.0);
        let solids = json!([solid("h", rect(6.0, 6.0, 24.0, 16.0), false)]);
        let check = |h0: f64| check_project(&project(json!({"extrudedSolids": solids, "roofs": [r], "siteRules": {"profileAngle": 45.0, "profileHeight": h0}}))).unwrap();
        let c = check(4.0);
        assert!((c.max_top.unwrap() - 8.0).abs() < 1e-6, "{:?}", c.max_top);
        // Firstende (6, 11) zulässig 4 + 6 = 10 m, Traufe (y = 16) 4 + 4 = 8 m: ok.
        assert!(!c.profile_exceeded);
        // 1.5 m: Firstende 7.5 m < 8 m ⇒ Dach rot, Körper (3 m, Traufe 5.5 m zulässig) nicht.
        let c = check(1.5);
        assert!(c.profile_exceeded);
        assert_eq!(c.profile_violations.len(), 1);
    }

    #[test]
    fn gebaeudeprofil_huelle_3d() {
        let solids = json!([solid("h", rect(6.0, 6.0, 24.0, 16.0), false)]);
        let p = project(json!({"extrudedSolids": solids, "siteRules": {"maxHeight": 12.0, "show3d": true, "profileAngle": 45.0, "profileHeight": 4.0}}));
        let e = envelope3d(&p);
        let rules = flat_rules(p.site_rules.as_ref().unwrap());
        let pf = Profile { h0: 4.0, slope: 1.0 };
        assert!(!e.tris.is_empty() && e.tris.iter().all(|v| v.is_finite()));
        let mut ys: Vec<f32> = vec![];
        for v in e.tris.chunks_exact(7) {
            assert!((v[6] - ENVELOPE_RGBA[3]).abs() < 1e-6, "keine Verstösse erwartet");
            let lim = profile_limit(&rules, pf, [v[0] as f64, v[2] as f64]).min(12.0);
            assert!(v[1] as f64 <= lim + 1e-3, "{v:?} über {lim}");
            ys.push(v[1]);
        }
        // Rand der zulässigen Fläche (4 m von der Grenze): 8 m; Mitte gedeckelt auf 12 m; Boden 0.
        assert!(ys.iter().any(|&y| (y - 8.0).abs() < 1e-4));
        assert!(ys.iter().any(|&y| (y - 12.0).abs() < 1e-4));
        assert!(ys.iter().any(|&y| y == 0.0));
        // Körper 11 m: an der Nordkante (4 m von der Grenze) gelten 8 m ⇒ rot.
        let mut s = solid("h", rect(6.0, 6.0, 24.0, 16.0), false);
        s["height"] = json!(11.0);
        let p = project(json!({"extrudedSolids": [s], "siteRules": {"maxHeight": 12.0, "show3d": true, "profileAngle": 45.0, "profileHeight": 4.0}}));
        let e = envelope3d(&p);
        assert!(e.tris.chunks_exact(7).any(|v| (v[6] - VIOLATION_RGBA[3]).abs() < 1e-6 && (v[1] - 11.0).abs() < 1e-4));
    }

    #[test]
    fn huelle_3d() {
        let solids = json!([solid("h", rect(6.0, 6.0, 24.0, 16.0), false)]);
        // Ohne show3d: leer.
        let p = project(json!({"extrudedSolids": solids, "siteRules": {"maxHeight": 12.0}}));
        assert!(envelope3d(&p).tris.is_empty());
        let p = project(json!({"extrudedSolids": solids, "siteRules": {"maxHeight": 12.0, "show3d": true}}));
        let e = envelope3d(&p);
        // Quader 22 × 12: 2 Deckel à 2 Dreiecke + 4 Seiten à 2 Dreiecke = 12 Dreiecke à 3 Ecken à 7 Werte.
        assert_eq!(e.tris.len(), 12 * 3 * 7);
        assert!(e.tris.chunks_exact(7).all(|v| v[1] == 0.0 || v[1] == 12.0));
        assert!((e.tris[6] - ENVELOPE_RGBA[3]).abs() < 1e-6);
        // Kanten: 4 Kanten × 2 Höhen + 4 Senkrechte = 12 Linien à 2 Ecken à 6 Werte.
        assert_eq!(e.lines.len(), 12 * 2 * 6);
        // Höhe überschritten und Grundfläche ausserhalb: rote Körper kommen dazu.
        let solids = json!([solid("h", rect(2.0, 6.0, 24.0, 16.0), false)]);
        let p = project(json!({"extrudedSolids": solids, "siteRules": {"maxHeight": 2.0, "show3d": true}}));
        let e = envelope3d(&p);
        assert!(e.tris.chunks_exact(7).any(|v| (v[6] - VIOLATION_RGBA[3]).abs() < 1e-6 && v[1] == 3.0));
        assert!(e.tris.iter().all(|v| v.is_finite()));
    }
}
