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

// ── Stempel-Ankerpunkt ──────────────────────────────────────────────────────

fn ring_inside(x: f64, y: f64, r: &[[f64; 2]]) -> bool {
    let n = r.len();
    let mut inside = false;
    let mut j = n.wrapping_sub(1);
    for i in 0..n {
        let ([xi, yi], [xj, yj]) = (r[i], r[j]);
        if (yi > y) != (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi {
            inside = !inside;
        }
        j = i;
    }
    inside
}

fn seg_dist2(x: f64, y: f64, a: [f64; 2], b: [f64; 2]) -> f64 {
    let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
    let l2 = dx * dx + dy * dy;
    let t = if l2 > 0.0 { (((x - a[0]) * dx + (y - a[1]) * dy) / l2).clamp(0.0, 1.0) } else { 0.0 };
    let (px, py) = (a[0] + t * dx - x, a[1] + t * dy - y);
    px * px + py * py
}

/// Vorzeichenbehafteter Abstand zum Rand (innen positiv).
fn signed_dist(x: f64, y: f64, r: &[[f64; 2]]) -> f64 {
    let n = r.len();
    let d2 = (0..n).map(|i| seg_dist2(x, y, r[i], r[(i + 1) % n])).fold(f64::INFINITY, f64::min);
    let d = d2.sqrt();
    if ring_inside(x, y, r) { d } else { -d }
}

/// [140] Ankerpunkt des Raumstempels: Pol der Unzugänglichkeit (der innere Punkt mit dem grössten Abstand
/// zum Rand; Verfahren „polylabel" von Mapbox, Agafonkin 2016, hier eigens umgesetzt): liegt auch in
/// L-förmigen und konkaven Räumen sicher im Raum, wo der Schwerpunkt ausserhalb fallen kann. Ist der
/// Schwerpunkt innen und fast so gut (≥ 90 % des Abstands, z. B. Rechteck, Korridor), bleibt er (ruhige
/// Mitte statt eines beliebigen Punkts auf der Mittelachse). Entartete Ringe → Schwerpunkt.
pub fn label_point(polygon: &[[f64; 2]]) -> [f64; 2] {
    let c = evaluate(polygon, 0.0).centroid;
    let r: Vec<[f64; 2]> = polygon.iter().copied().filter(|p| p[0].is_finite() && p[1].is_finite()).collect();
    if r.len() < 3 || r.len() != polygon.len() {
        return c;
    }
    let (mut x0, mut y0, mut x1, mut y1) = (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
    for p in &r {
        x0 = x0.min(p[0]);
        y0 = y0.min(p[1]);
        x1 = x1.max(p[0]);
        y1 = y1.max(p[1]);
    }
    let (w, h) = (x1 - x0, y1 - y0);
    // [258] Absurde Ausdehnung (Rechenbereich der Doubles: `x += size` käme nicht mehr voran) → Schwerpunkt.
    if !(x0.abs() < 1e9 && y0.abs() < 1e9 && x1.abs() < 1e9 && y1.abs() < 1e9) {
        return c;
    }
    // [258] Höchstens 256 Startzellen je Richtung: ein sehr langer, schmaler Raum (1e12 m × 1 mm) ergab sonst Milliarden.
    if !(w.min(h) > 0.0) {
        return c;
    }
    let size = w.min(h).max(w.max(h) / 256.0);
    let precision = (w.max(h) * 1e-3).max(1e-4);
    // Zelle: Mitte, halbe Kantenlänge, Abstand der Mitte, obere Schranke innerhalb der Zelle.
    #[derive(PartialEq)]
    struct Cell(f64, f64, f64, f64, f64);
    impl Eq for Cell {}
    impl PartialOrd for Cell {
        fn partial_cmp(&self, o: &Self) -> Option<std::cmp::Ordering> {
            Some(self.cmp(o))
        }
    }
    impl Ord for Cell {
        fn cmp(&self, o: &Self) -> std::cmp::Ordering {
            self.4.total_cmp(&o.4)
        }
    }
    let cell = |x: f64, y: f64, h: f64| {
        let d = signed_dist(x, y, &r);
        Cell(x, y, h, d, d + h * std::f64::consts::SQRT_2)
    };
    let dc = if c[0].is_finite() && c[1].is_finite() { signed_dist(c[0], c[1], &r) } else { f64::NEG_INFINITY };
    let dist2 = |x: f64, y: f64| (x - c[0]) * (x - c[0]) + (y - c[1]) * (y - c[1]);
    // Bester Punkt: grösserer Abstand; innerhalb der Genauigkeit näher am Schwerpunkt.
    let better = |a: &Cell, b: &(f64, f64, f64)| {
        if a.3 > b.2 + precision {
            return true;
        }
        a.3 > b.2 - precision && dist2(a.0, a.1) < dist2(b.0, b.1)
    };
    let mut best = (c[0], c[1], dc);
    let mid = cell(x0 + w / 2.0, y0 + h / 2.0, 0.0);
    if better(&mid, &best) {
        best = (mid.0, mid.1, mid.3);
    }
    let mut heap = std::collections::BinaryHeap::new();
    let half = size / 2.0;
    let mut x = x0;
    while x < x1 {
        let mut y = y0;
        while y < y1 {
            heap.push(cell(x + half, y + half, half));
            y += size;
        }
        x += size;
    }
    let mut budget = 20_000;
    while let Some(q) = heap.pop() {
        if better(&q, &best) {
            best = (q.0, q.1, q.3);
        }
        budget -= 1;
        if budget == 0 {
            break;
        }
        if q.4 - best.2 <= precision {
            continue;
        }
        let h2 = q.2 / 2.0;
        for (dx, dy) in [(-1.0, -1.0), (1.0, -1.0), (-1.0, 1.0), (1.0, 1.0)] {
            heap.push(cell(q.0 + dx * h2, q.1 + dy * h2, h2));
        }
    }
    if !(best.2 > 0.0) {
        return c;
    }
    // Schwerpunkt innen und fast so gut: Mitte behalten.
    if dc >= 0.9 * best.2 {
        return c;
    }
    [best.0, best.1]
}

/// [140] Liegt das achsparallele Rechteck mit Mitte `(cx, cy)` und halber Breite/Höhe `hw`/`hh` ganz im
/// Ring (Mitte innen, keine Kante schneidet das Innere des Rechtecks)? Berührung des Rands zählt als innen.
pub fn rect_in_ring(ring: &[[f64; 2]], cx: f64, cy: f64, hw: f64, hh: f64) -> bool {
    if ring.len() < 3 || !ring_inside(cx, cy, ring) {
        return false;
    }
    let e = 1e-9;
    let (rx0, rx1, ry0, ry1) = (cx - hw + e, cx + hw - e, cy - hh + e, cy + hh - e);
    if !(rx0 < rx1 && ry0 < ry1) {
        return true;
    }
    let n = ring.len();
    (0..n).all(|i| {
        // Liang–Barsky: schneidet die Kante das offene Rechteck?
        let (a, b) = (ring[i], ring[(i + 1) % n]);
        let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
        let (mut t0, mut t1) = (0.0f64, 1.0f64);
        for (p, q) in [(-dx, a[0] - rx0), (dx, rx1 - a[0]), (-dy, a[1] - ry0), (dy, ry1 - a[1])] {
            if p == 0.0 {
                if q <= 0.0 {
                    return true;
                }
            } else {
                let t = q / p;
                if p < 0.0 {
                    t0 = t0.max(t);
                } else {
                    t1 = t1.min(t);
                }
            }
        }
        t0 >= t1
    })
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
    /// [140] Stempel-Anker: Rechteck → Mitte; schmales L → im Raum (der Schwerpunkt liegt dort ausserhalb).
    #[test]
    fn stempel_anker_pol_der_unzugaenglichkeit() {
        assert_eq!(label_point(&[[0.0, 0.0], [4.0, 0.0], [4.0, 2.0], [0.0, 2.0]]), [2.0, 1.0]);
        let l = [[0.0, 0.0], [6.0, 0.0], [6.0, 1.0], [1.0, 1.0], [1.0, 6.0], [0.0, 6.0]];
        let c = evaluate(&l, 0.0).centroid;
        assert!(!ring_inside(c[0], c[1], &l), "Schwerpunkt ausserhalb: {c:?}");
        let q = label_point(&l);
        assert!(ring_inside(q[0], q[1], &l) && signed_dist(q[0], q[1], &l) > 0.45, "{q:?}");
        // Breites L (zwei Flügel 4 × 3 m): Pol im grösseren Teil, mit Abstand zur Innenecke.
        let l2 = [[0.0, 0.0], [8.0, 0.0], [8.0, 3.0], [3.0, 3.0], [3.0, 7.0], [0.0, 7.0]];
        let q = label_point(&l2);
        assert!(signed_dist(q[0], q[1], &l2) > 1.45, "{q:?}");
        assert_eq!(label_point(&[]), [0.0, 0.0]);
        assert_eq!(label_point(&[[0.0, 0.0], [1.0, 1.0], [2.0, 2.0]]), evaluate(&[[0.0, 0.0], [1.0, 1.0], [2.0, 2.0]], 0.0).centroid);
        let nan = label_point(&[[0.0, 0.0], [f64::NAN, 1.0], [2.0, 2.0]]);
        assert!(nan.len() == 2);
    }

    #[test]
    fn rechteck_im_ring() {
        let l = [[0.0, 0.0], [6.0, 0.0], [6.0, 1.0], [1.0, 1.0], [1.0, 6.0], [0.0, 6.0]];
        assert!(rect_in_ring(&l, 3.0, 0.5, 2.0, 0.4));
        assert!(!rect_in_ring(&l, 1.2, 0.5, 1.0, 0.8), "ragt oben aus dem Flügel");
        assert!(!rect_in_ring(&l, 3.0, 3.0, 0.1, 0.1), "Mitte ausserhalb");
        assert!(rect_in_ring(&l, 3.0, 0.5, 3.0, 0.5), "berührt den Rand");
        // U mit Schlitz: alle Ecken innen, aber der Schlitz quert das Rechteck.
        let u = [[0.0, 0.0], [5.0, 0.0], [5.0, 4.0], [2.6, 4.0], [2.6, 1.0], [2.4, 1.0], [2.4, 4.0], [0.0, 4.0]];
        assert!(!rect_in_ring(&u, 2.5, 2.5, 2.0, 0.5));
    }

    /// [258] Sehr lang gestreckte oder riesige Räume: die Startzellen von `label_point` waren min(Breite, Höhe) breit
    /// (1e12 m × 1 mm: Milliarden Zellen, Speicher-Abbruch) und ab 1e300 m kam `x += size` nicht mehr voran.
    #[test]
    fn label_punkt_extreme_raeume() {
        let t0 = std::time::Instant::now();
        let long = [[0.0, 0.0], [1e8, 0.0], [1e8, 1e-3], [0.0, 1e-3]];
        let p = label_point(&long);
        assert!(p[0].is_finite() && p[1].is_finite(), "{p:?}");
        let huge = [[0.0, 0.0], [1e300, 0.0], [1e300, 1.0], [0.0, 1.0]];
        let _ = label_point(&huge);
        let _ = label_point(&[[1e300, 1e300], [1e300 + 1e290, 1e300], [1e300, 1e300 + 1e290]]);
        assert!(t0.elapsed().as_secs_f64() < 5.0, "zu langsam: {:?}", t0.elapsed());
    }
}
