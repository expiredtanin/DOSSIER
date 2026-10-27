//! Rechenteile der Kennzahlen ([41]/[61]/[62]/[70]); aus `analysis/kennzahlen.ts`.
//!
//!  • [`solid_volume`]: Volumen eines Extrusionskörpers — exakt für Prismen, Kegel(stümpfe)
//!    über `taper` und Kreise.
//!  • [`area_sums`]: Raumflächen je Geschoss und SIA-416-Kategorie (Blattkategorien), das
//!    Gebäudevolumen (Abzugskörper abgezogen, nie negativ) und die Parzellenfläche. Die
//!    Zusammenfassung zu NF/NGF/GF (SIA-416-Bilanz) liefert `room_area::balance`.

use crate::flat_read::signed_area;

/// Anzahl der SIA-416-Blattkategorien (Reihenfolge: `room_area::CATEGORIES`).
pub const CATEGORIES: usize = crate::room_area::CATEGORIES.len();

fn finite(v: f64) -> f64 {
    if v.is_finite() {
        v
    } else {
        0.0
    }
}

/// Volumen (m³): Grundfläche (Polygon `points` oder Kreis mit Radius `circle_r`, NaN = kein
/// Kreis), Höhe, Verjüngung `taper` (0 = Prisma, 1 = Spitze; ausserhalb geklemmt, NaN = 0).
pub fn solid_volume(points: &[[f64; 2]], circle_r: f64, height: f64, taper: f64) -> f64 {
    let area = if circle_r.is_finite() { std::f64::consts::PI * circle_r * circle_r } else { signed_area(points).abs() };
    let t = if taper.is_nan() { 0.0 } else { taper.clamp(0.0, 1.0) };
    let k = 1.0 - t; // Massstab der Deckfläche
    area * height * (1.0 + k + k * k) / 3.0
}

/// Raum: Geschoss-Index, Kategorie-Index (0..CATEGORIES), Grundriss.
pub struct RoomIn {
    pub level: usize,
    pub category: usize,
    pub boundary: Vec<[f64; 2]>,
}

/// Körper für das Gebäudevolumen.
pub struct SolidIn {
    pub subtract: bool,
    pub points: Vec<[f64; 2]>,
    pub circle_r: f64,
    pub height: f64,
    pub taper: f64,
}

/// Ergebnis von [`area_sums`].
#[derive(Debug, PartialEq)]
pub struct AreaSums {
    /// Je Geschoss `CATEGORIES` Flächensummen (m²).
    pub by_level: Vec<[f64; CATEGORIES]>,
    /// Gebäudevolumen (m³), ≥ 0.
    pub gv: f64,
    /// Parzellenfläche: eingegebene Zahl (> 0), sonst aus dem Parzellenring; `None` ohne beides.
    pub parcel: Option<f64>,
}

/// Raum- und Volumensummen. Räume mit ungültigem Geschoss oder ungültiger Kategorie zählen nicht.
pub fn area_sums(n_levels: usize, rooms: &[RoomIn], solids: &[SolidIn], parcel_area: f64, parcel_ring: &[[f64; 2]]) -> AreaSums {
    let mut by_level = vec![[0.0; CATEGORIES]; n_levels];
    for r in rooms {
        if let Some(l) = by_level.get_mut(r.level) {
            if r.category < CATEGORIES {
                l[r.category] += finite(signed_area(&r.boundary).abs());
            }
        }
    }
    let mut gv = 0.0;
    for s in solids {
        let v = finite(solid_volume(&s.points, s.circle_r, s.height, s.taper));
        gv += if s.subtract { -v } else { v };
    }
    // Parzellenfläche: eingegebene Zahl, sonst aus der Parzellengrenze des Baurechts.
    let from_ring = if parcel_ring.len() >= 3 { finite(signed_area(parcel_ring).abs()) } else { 0.0 };
    let parcel = if parcel_area > 0.0 && parcel_area.is_finite() {
        Some(parcel_area)
    } else if from_ring > 0.0 {
        Some(from_ring)
    } else {
        None
    };
    AreaSums { by_level, gv: gv.max(0.0), parcel }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sq(x: f64, y: f64, s: f64) -> Vec<[f64; 2]> {
        vec![[x, y], [x + s, y], [x + s, y + s], [x, y + s]]
    }
    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-9
    }

    #[test]
    fn volumen_prisma_pyramide_kreis() {
        assert!(close(solid_volume(&sq(0.0, 0.0, 2.0), f64::NAN, 3.0, 0.0), 12.0));
        assert!(close(solid_volume(&sq(0.0, 0.0, 2.0), f64::NAN, 3.0, 1.0), 4.0));
        assert!(close(solid_volume(&sq(0.0, 0.0, 2.0), f64::NAN, 3.0, 7.0), 4.0));
        assert!(close(solid_volume(&[], 1.0, 3.0, f64::NAN), std::f64::consts::PI * 3.0));
    }

    #[test]
    fn summen_je_geschoss_und_kategorie() {
        let rooms = vec![
            RoomIn { level: 0, category: 0, boundary: sq(0.0, 0.0, 5.0) },
            RoomIn { level: 0, category: 0, boundary: sq(0.0, 0.0, 1.0) },
            RoomIn { level: 1, category: 4, boundary: sq(0.0, 0.0, 2.0) },
            RoomIn { level: 9, category: 0, boundary: sq(0.0, 0.0, 2.0) },
            RoomIn { level: 0, category: 99, boundary: sq(0.0, 0.0, 2.0) },
        ];
        let solids = vec![
            SolidIn { subtract: false, points: sq(0.0, 0.0, 10.0), circle_r: f64::NAN, height: 3.0, taper: 0.0 },
            SolidIn { subtract: true, points: sq(0.0, 0.0, 1.0), circle_r: f64::NAN, height: 3.0, taper: 0.0 },
        ];
        let s = area_sums(2, &rooms, &solids, f64::NAN, &sq(0.0, 0.0, 20.0));
        assert_eq!(s.by_level[0], [26.0, 0.0, 0.0, 0.0, 0.0, 0.0]);
        assert_eq!(s.by_level[1], [0.0, 0.0, 0.0, 0.0, 4.0, 0.0]);
        assert!(close(s.gv, 297.0));
        assert_eq!(s.parcel, Some(400.0));
        assert_eq!(area_sums(0, &[], &[], 1000.0, &[]).parcel, Some(1000.0));
    }

    #[test]
    fn unsinn_ohne_panik() {
        let rooms = vec![RoomIn { level: 0, category: 0, boundary: vec![[f64::NAN, 0.0], [1.0, 0.0], [0.0, 1.0]] }];
        let solids = vec![SolidIn { subtract: true, points: vec![], circle_r: f64::INFINITY, height: f64::NAN, taper: 0.0 }];
        let s = area_sums(1, &rooms, &solids, -5.0, &[[0.0, 0.0]]);
        assert_eq!(s.by_level[0][0], 0.0);
        assert_eq!(s.gv, 0.0);
        assert_eq!(s.parcel, None);
        assert_eq!(area_sums(0, &[], &[], f64::NAN, &[]), AreaSums { by_level: vec![], gv: 0.0, parcel: None });
    }
}
