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

use crate::jsnum::or_zero as finite;

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
    /// [191] Fläche exakt (Bögen im Umriss); `None` = aus `boundary`.
    pub area: Option<f64>,
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
                l[r.category] += finite(r.area.unwrap_or_else(|| signed_area(&r.boundary).abs()));
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
            RoomIn { level: 0, category: 0, boundary: sq(0.0, 0.0, 5.0), area: None },
            RoomIn { level: 0, category: 0, boundary: sq(0.0, 0.0, 1.0), area: None },
            RoomIn { level: 1, category: 4, boundary: sq(0.0, 0.0, 2.0), area: None },
            RoomIn { level: 9, category: 0, boundary: sq(0.0, 0.0, 2.0), area: None },
            RoomIn { level: 0, category: 99, boundary: sq(0.0, 0.0, 2.0), area: None },
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
        let rooms = vec![RoomIn { level: 0, category: 0, boundary: vec![[f64::NAN, 0.0], [1.0, 0.0], [0.0, 1.0]], area: None }];
        let solids = vec![SolidIn { subtract: true, points: vec![], circle_r: f64::INFINITY, height: f64::NAN, taper: 0.0 }];
        let s = area_sums(1, &rooms, &solids, -5.0, &[[0.0, 0.0]]);
        assert_eq!(s.by_level[0][0], 0.0);
        assert_eq!(s.gv, 0.0);
        assert_eq!(s.parcel, None);
        assert_eq!(area_sums(0, &[], &[], f64::NAN, &[]), AreaSums { by_level: vec![], gv: 0.0, parcel: None });
    }
}

// ── Kennzahlen aus dem Projekt-Dokument ([K4] S2) ───────────────────────────
//
// [225] Eine Quelle der Wahrheit: die Kennzahlenleiste liest dieselben Zahlen wie die Flächentabelle
// und die IVHB-Ziffern (`flaechen::area_table`, `flaechen::ivhb` mit den Vorgaben der Tabelle: aGF = NGF,
// ohne Untergeschosse, aGSF aus `parcelArea` bzw. der Parzellengrenze). Vorher rechnete die Leiste GF aus
// den Räumen allein (= NGF, ohne Konstruktionsfläche) und die ÜZ aus der GF des untersten Geschosses.

use crate::model::{Project, SiaCategory};
use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LevelKennzahlen {
    pub level_id: String,
    pub name: String,
    /// Geschossfläche SIA 416 (GF = NGF + KF), gleich der Zeile der Flächentabelle.
    pub gf: f64,
    /// Anrechenbare Geschossfläche dieses Geschosses (Basis wie die IVHB-Vorgabe: NGF; Untergeschosse 0).
    pub agf: f64,
    /// Nettogeschossfläche (NF + VF + FF).
    pub ngf: f64,
    /// Hauptnutzfläche.
    pub hnf: f64,
    pub rooms: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Kennzahlen {
    pub levels: Vec<LevelKennzahlen>,
    /// Σ GF (SIA 416) aller Geschosse = Summenzeile der Flächentabelle.
    pub gf: f64,
    /// Anrechenbare Geschossfläche (IVHB, Vorgabe NGF, oberirdisch) = Zähler der AZ.
    pub agf: f64,
    pub ngf: f64,
    pub hnf: f64,
    /// Konstruktionsfläche (Σ).
    pub kf: f64,
    pub gv: f64,
    /// Anrechenbare Gebäudefläche (IVHB aGbF) = Zähler der ÜZ.
    pub footprint: f64,
    pub az: Option<f64>,
    pub uez: Option<f64>,
}

pub(crate) fn category_index(c: SiaCategory) -> usize {
    match c {
        SiaCategory::HNF => 0,
        SiaCategory::NNF => 1,
        SiaCategory::VF => 2,
        SiaCategory::FF => 3,
        SiaCategory::KGF => 4,
        SiaCategory::AGF => 5,
        SiaCategory::Unknown => CATEGORIES, // zählt nicht
    }
}

/// Flächen je Geschoss (SIA 416), Gebäudevolumen, Ausnützungs- und Überbauungsziffer — aus der
/// Flächentabelle und den IVHB-Ziffern mit ihren Vorgaben ([225]).
pub fn compute(p: &Project) -> Kennzahlen {
    let opt = crate::flaechen::IvhbOptions::default();
    let t = crate::flaechen::area_table(p);
    let v = crate::flaechen::ivhb(p, &opt);
    let levels: Vec<LevelKennzahlen> = t
        .levels
        .iter()
        .map(|r| LevelKennzahlen {
            level_id: r.level_id.clone(),
            name: r.name.clone(),
            gf: r.gf,
            agf: if r.underground && !opt.include_underground { 0.0 } else { r.ngf },
            ngf: r.ngf,
            hnf: r.hnf,
            rooms: r.rooms,
        })
        .collect();
    Kennzahlen {
        levels,
        gf: t.total.gf,
        agf: v.agf,
        ngf: t.total.ngf,
        hnf: t.total.hnf,
        kf: t.total.kf,
        gv: t.gv,
        footprint: v.agbf,
        az: v.az,
        uez: v.uz,
    }
}

#[cfg(test)]
mod doc_tests {
    use super::*;

    #[test]
    fn kennzahlen_des_beispielprojekts() {
        let p: Project = serde_json::from_str(include_str!("../tests/fixtures/sample_project.json")).unwrap();
        let k = compute(&p);
        assert!(!k.levels.is_empty());
        let sum: f64 = k.levels.iter().map(|l| l.gf).sum();
        assert!((k.gf - sum).abs() < 1e-9);
        assert!(k.az.is_none() && k.uez.is_none());
        let with_parcel = Project { parcel_area: Some(1000.0), ..p };
        let k2 = compute(&with_parcel);
        assert!((k2.az.unwrap() - k2.agf / 1000.0).abs() < 1e-12);
        assert!((k2.uez.unwrap() - k2.footprint / 1000.0).abs() < 1e-12);
    }

    /// [225] Leiste und Flächentabelle/IVHB zeigen dieselben Zahlen (GF = NGF + KF, nicht nur die Räume).
    #[test]
    fn leiste_gleich_flaechentabelle() {
        let fixtures = [include_str!("../tests/fixtures/sample_project.json")];
        for json in fixtures {
            let mut p: Project = serde_json::from_str(json).unwrap();
            p.parcel_area = Some(900.0);
            let k = compute(&p);
            let t = crate::flaechen::area_table(&p);
            let v = crate::flaechen::ivhb(&p, &Default::default());
            assert!(t.total.kf > 0.0, "Testprojekt ohne Wände");
            assert!((k.gf - t.total.gf).abs() < 1e-9, "GF {} statt {}", k.gf, t.total.gf);
            assert!((k.gf - (t.total.ngf + t.total.kf)).abs() < 1e-9);
            assert!((k.ngf - t.total.ngf).abs() < 1e-9 && (k.hnf - t.total.hnf).abs() < 1e-9);
            assert!((k.gv - t.gv).abs() < 1e-9);
            assert_eq!(k.az, v.az);
            assert_eq!(k.uez, v.uz);
            for (l, r) in k.levels.iter().zip(&t.levels) {
                assert_eq!(l.level_id, r.level_id);
                assert!((l.gf - r.gf).abs() < 1e-9);
            }
        }
    }

    /// [206] Ohne freie Körper (Modell aus Wänden/Decken) war das GV in der Kennzahlenleiste 0 m³,
    /// die Flächentabelle daneben zeigte GF × Geschosshöhe: jetzt dieselbe Regel wie `flaechen`.
    #[test]
    fn gv_ohne_koerper_wie_flaechentabelle() {
        let p: Project = serde_json::from_str(include_str!("../tests/fixtures/sample_project.json")).unwrap();
        assert!(p.extruded_solids.as_deref().unwrap_or(&[]).is_empty());
        let k = compute(&p);
        let t = crate::flaechen::area_table(&p);
        assert!(t.gv > 0.0);
        assert!((k.gv - t.gv).abs() < 1e-9, "GV {} statt {}", k.gv, t.gv);
    }
}
