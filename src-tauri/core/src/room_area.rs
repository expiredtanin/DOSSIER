//! Raum-Flächen und SIA-416-Bilanz (aus `src/geometry/roomArea.ts`).
//!
//!  • Flächen, Umfang, Schwerpunkt: aus `kernel2d` (`polygon_area`, `perimeter`, `centroid`),
//!    hier nur zu [`evaluate`] gebündelt.
//!  • SIA-416-Zuordnung: die Blatt-Kategorien ([`CATEGORIES`], Reihenfolge = Index in allen
//!    Puffern) und ihre Zuordnung zu den Summen NF/NGF/GF ([`rollup`]) sind NUR HIER definiert.
//!    TS (`roomArea.ts`) hält die Kategorie-Namen als Typ und die deutschen Beschriftungen.
//!
//! SIA 416: GF = NGF + KGF + AGF; NGF = NF + VF + FF; NF = HNF + NNF. AGF (Aussengeschoss-
//! fläche) zählt nur zur GF, nicht zu NF/NGF.

use kernel2d::Vec2;

/// Blatt-Kategorien, die einem Raum zugewiesen werden (Index = Position hier).
pub const CATEGORIES: [&str; 6] = ["HNF", "NNF", "VF", "FF", "KGF", "AGF"];

/// Summen-Ebenen (Index = Position hier).
pub const AGGREGATES: [&str; 3] = ["NF", "NGF", "GF"];

/// Summen (Indizes in [`AGGREGATES`]), zu denen eine Blatt-Kategorie beiträgt.
pub fn rollup(category: usize) -> &'static [usize] {
    match category {
        0 | 1 => &[0, 1, 2], // HNF, NNF → NF, NGF, GF
        2 | 3 => &[1, 2],    // VF, FF → NGF, GF
        4 | 5 => &[2],       // KGF, AGF → GF
        _ => &[],
    }
}

pub fn to_vec2(pts: &[[f64; 2]]) -> Vec<Vec2> {
    pts.iter().map(|p| Vec2::new(p[0], p[1])).collect()
}

/// Bewertung eines Raum-Polygons.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RoomEval {
    pub gross: f64,
    pub net: f64,
    pub perimeter: f64,
    pub centroid: [f64; 2],
}

/// Brutto-/Nettofläche (`net = max(0, brutto − abzug)`, Abzug < 0 oder NaN zählt als 0), Umfang
/// und Schwerpunkt eines offenen Rings.
pub fn evaluate(polygon: &[[f64; 2]], deduction: f64) -> RoomEval {
    let pts = to_vec2(polygon);
    let gross = kernel2d::polygon_area(&pts);
    let ded = if deduction > 0.0 { deduction } else { 0.0 };
    let c = kernel2d::centroid(&pts);
    RoomEval { gross, net: (gross - ded).max(0.0), perimeter: kernel2d::perimeter(&pts), centroid: [c.x, c.y] }
}

/// Ergebnis der Bilanz: Flächen und Raumzahlen je Blatt-Kategorie und je Summe.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Balance {
    pub leaf_area: [f64; 6],
    pub leaf_count: [usize; 6],
    pub agg_area: [f64; 3],
    pub agg_count: [usize; 3],
}

/// Summiert `(Kategorie-Index, Fläche)` je Kategorie und rollt NF/NGF/GF auf. Nicht endliche
/// Flächen zählen als 0, unbekannte Kategorien werden übergangen.
pub fn balance(rooms: &[(usize, f64)]) -> Balance {
    let mut b = Balance::default();
    for &(cat, area) in rooms {
        if cat >= CATEGORIES.len() {
            continue;
        }
        let a = if area.is_finite() { area } else { 0.0 };
        b.leaf_area[cat] += a;
        b.leaf_count[cat] += 1;
        for &g in rollup(cat) {
            b.agg_area[g] += a;
            b.agg_count[g] += 1;
        }
    }
    b
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-9
    }

    fn rect(w: f64, h: f64) -> Vec<[f64; 2]> {
        vec![[0.0, 0.0], [w, 0.0], [w, h], [0.0, h]]
    }

    #[test]
    fn rechteck_flaeche_umfang_schwerpunkt() {
        let e = evaluate(&rect(4.0, 3.0), 0.0);
        assert!(close(e.gross, 12.0) && close(e.net, 12.0) && close(e.perimeter, 14.0));
        assert!(close(e.centroid[0], 2.0) && close(e.centroid[1], 1.5));
    }

    #[test]
    fn uhrzeigersinn_gibt_positive_flaeche() {
        let mut r = rect(2.0, 2.0);
        r.reverse();
        assert!(close(evaluate(&r, 0.0).gross, 4.0));
    }

    #[test]
    fn abzug_wird_geklemmt() {
        assert!(close(evaluate(&rect(2.0, 2.0), 1.5).net, 2.5));
        assert!(close(evaluate(&rect(2.0, 2.0), 99.0).net, 0.0));
        assert!(close(evaluate(&rect(2.0, 2.0), -5.0).net, 4.0));
        assert!(close(evaluate(&rect(2.0, 2.0), f64::NAN).net, 4.0));
    }

    #[test]
    fn entartete_ringe() {
        let e = evaluate(&[], 0.0);
        assert_eq!((e.gross, e.perimeter, e.centroid), (0.0, 0.0, [0.0, 0.0]));
        let e = evaluate(&[[1.0, 1.0], [3.0, 3.0]], 0.0);
        assert!(close(e.gross, 0.0) && close(e.centroid[0], 2.0));
        // Kollinear: Fläche 0 → Mittel der Punkte
        let e = evaluate(&[[0.0, 0.0], [1.0, 0.0], [2.0, 0.0]], 0.0);
        assert!(close(e.centroid[0], 1.0));
    }

    #[test]
    fn bilanz_rollup_ohne_agf_in_ngf() {
        let b = balance(&[(0, 20.0), (1, 5.0), (2, 8.0), (3, 2.0), (4, 10.0)]);
        assert!(close(b.agg_area[0], 25.0)); // NF
        assert!(close(b.agg_area[1], 35.0)); // NGF
        assert!(close(b.agg_area[2], 45.0)); // GF
        assert_eq!(b.agg_count, [2, 4, 5]);
        let b = balance(&[(0, 20.0), (5, 12.0)]);
        assert!(close(b.agg_area[1], 20.0) && close(b.agg_area[2], 32.0) && close(b.leaf_area[5], 12.0));
        assert_eq!(b.leaf_count[5], 1);
    }

    #[test]
    fn bilanz_unsinn_ohne_panik() {
        let b = balance(&[(0, f64::NAN), (99, 5.0), (1, f64::INFINITY), (2, 3.0)]);
        assert!(close(b.agg_area[2], 3.0));
        assert_eq!(b.leaf_count[0], 1);
        assert_eq!(balance(&[]), Balance::default());
    }

    #[test]
    fn unsinn_flaechen_ohne_panik() {
        let e = evaluate(&[[f64::NAN, 0.0], [1.0, 0.0], [0.0, 1.0]], 0.0);
        assert!(e.gross.is_nan());
        let _ = evaluate(&[[f64::INFINITY, 0.0], [1.0, f64::NEG_INFINITY]], 0.0);
    }

    #[test]
    fn kategorienamen_und_rollup_passen_zusammen() {
        assert_eq!(CATEGORIES.len(), 6);
        assert_eq!(rollup(0), &[0, 1, 2]);
        assert_eq!(rollup(5), &[2]);
        assert!(rollup(6).is_empty());
    }
}
