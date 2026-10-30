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
    let real: Vec<Polygon> = violations.into_iter().filter(|p| p.first().is_some_and(|o| signed_area(o).abs() > 1e-4)).collect();
    Some(SiteCheck {
        parcel_area: signed_area(&r.parcel).abs(),
        allowed_area: multi_polygon_area(&allowed),
        allowed,
        violation_area: multi_polygon_area(&real),
        violations: real,
        height_exceeded: max_height.is_finite() && max_top.is_finite() && max_top > max_height + 1e-6,
    })
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

/// Teile der Gebäude-Grundfläche (Wände aller Geschosse, freie Körper ohne Abzugskörper).
fn footprint_parts(p: &Project) -> Vec<Polygon> {
    let mut parts: Vec<Polygon> = Vec::new();
    for w in &p.walls {
        if hypot2(w.end.x - w.start.x, w.end.y - w.start.y) < 1e-9 {
            continue;
        }
        // Bogenwand ([T2]): Kreisringsektor.
        match crate::wall_arc::arc_footprint(w, p.wall_thickness(w, 0.2)) {
            Some(f) => parts.push(vec![f]),
            None => parts.push(vec![wall_corners(w.start, w.end, p.wall_thickness(w, 0.2))]),
        }
    }
    for s in p.extruded_solids.as_deref().unwrap_or(&[]) {
        if s.operation.as_deref() == Some("subtract") || s.points.len() < 3 {
            continue;
        }
        parts.push(vec![s.points.iter().map(|v| [v.x, v.y]).collect()]);
    }
    parts
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
}

/// Prüft das Modell gegen `siteRules`; `None` ohne (gültiges) Baurecht.
pub fn check_project(p: &Project) -> Option<SiteCheckOut> {
    let r = p.site_rules.as_ref()?;
    let max_top = model_top(p);
    let rules = SiteRules {
        parcel: r.parcel.iter().map(|v| [v.x, v.y]).collect(),
        setbacks: (0..r.parcel.len()).map(|i| r.setbacks.as_ref().and_then(|s| s.get(i)).copied().unwrap_or(r.default_setback)).collect(),
        lines: r.building_lines.as_deref().unwrap_or(&[]).iter().map(|l| BuildingLine { a: [l.a.x, l.a.y], b: [l.b.x, l.b.y] }).collect(),
    };
    let c = check_site_rules(&rules, &footprint_parts(p), r.max_height.unwrap_or(f64::NAN), max_top.unwrap_or(f64::NAN))?;
    Some(SiteCheckOut {
        parcel_area: c.parcel_area,
        allowed: area_out(&c.allowed),
        allowed_area: c.allowed_area,
        violations: area_out(&c.violations),
        violation_area: c.violation_area,
        max_top,
        height_exceeded: c.height_exceeded,
    })
}
