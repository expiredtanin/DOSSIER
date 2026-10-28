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

// ── Kennzahlen aus dem Projekt-Dokument ([K4] S2) ───────────────────────────

use crate::model::{DrawingLevelKind, Project, SiaCategory};
use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LevelKennzahlen {
    pub level_id: String,
    pub name: String,
    /// Geschossfläche (SIA 416 GF) aus den Räumen.
    pub gf: f64,
    /// Anrechenbare Fläche ≈ Nettogeschossfläche NGF.
    pub agf: f64,
    pub rooms: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Kennzahlen {
    pub levels: Vec<LevelKennzahlen>,
    pub gf: f64,
    pub agf: f64,
    pub gv: f64,
    pub footprint: f64,
    pub az: Option<f64>,
    pub uez: Option<f64>,
}

fn category_index(c: SiaCategory) -> usize {
    match c {
        SiaCategory::HNF => 0,
        SiaCategory::NNF => 1,
        SiaCategory::VF => 2,
        SiaCategory::FF => 3,
        SiaCategory::KGF => 4,
        SiaCategory::AGF => 5,
    }
}

/// Flächen je Geschoss (SIA 416), Gebäudevolumen, Ausnützungs- und Überbauungsziffer.
pub fn compute(p: &Project) -> Kennzahlen {
    let mut floors: Vec<&crate::model::DrawingLevel> = p.drawing_levels.iter().filter(|l| l.kind == DrawingLevelKind::Floor).collect();
    floors.sort_by(|a, b| a.base_elevation.unwrap_or(0.0).partial_cmp(&b.base_elevation.unwrap_or(0.0)).unwrap_or(std::cmp::Ordering::Equal));
    let mut level_index: std::collections::HashMap<&str, usize> = std::collections::HashMap::new();
    for (i, l) in floors.iter().enumerate() {
        level_index.entry(l.id.as_str()).or_insert(i);
    }
    let all_rooms = p.rooms.as_deref().unwrap_or(&[]);
    let rooms: Vec<&crate::model::Room> = all_rooms.iter().filter(|r| level_index.contains_key(r.floor_id.as_str())).collect();
    let rooms_in: Vec<RoomIn> = rooms
        .iter()
        .map(|r| RoomIn {
            level: level_index[r.floor_id.as_str()],
            category: category_index(r.sia_category),
            boundary: r.boundary.iter().map(|v| [v.x, v.y]).collect(),
        })
        .collect();
    let solids: Vec<SolidIn> = p
        .extruded_solids
        .as_deref()
        .unwrap_or(&[])
        .iter()
        .map(|s| SolidIn {
            subtract: s.operation.as_deref() == Some("subtract"),
            points: if s.circle.is_some() { vec![] } else { s.points.iter().map(|v| [v.x, v.y]).collect() },
            circle_r: s.circle.as_ref().map_or(f64::NAN, |c| c.r),
            height: s.height,
            taper: s.taper.unwrap_or(0.0),
        })
        .collect();
    let parcel_ring: Vec<[f64; 2]> = p.site_rules.as_ref().map(|r| r.parcel.iter().map(|v| [v.x, v.y]).collect()).unwrap_or_default();
    let sums = area_sums(floors.len(), &rooms_in, &solids, p.parcel_area.unwrap_or(f64::NAN), &parcel_ring);
    let levels: Vec<LevelKennzahlen> = floors
        .iter()
        .enumerate()
        .map(|(i, l)| {
            let entries: Vec<(usize, f64)> = (0..CATEGORIES).map(|k| (k, sums.by_level[i][k])).collect();
            let b = crate::room_area::balance(&entries);
            LevelKennzahlen {
                level_id: l.id.clone(),
                name: l.name.clone(),
                gf: b.agg_area[2],
                agf: b.agg_area[1],
                rooms: rooms.iter().filter(|r| r.floor_id == l.id).count(),
            }
        })
        .collect();
    let gf: f64 = levels.iter().map(|l| l.gf).sum();
    let agf: f64 = levels.iter().map(|l| l.agf).sum();
    let footprint = levels.iter().find(|l| l.gf > 0.0).map_or(0.0, |l| l.gf);
    Kennzahlen {
        levels,
        gf,
        agf,
        gv: sums.gv,
        footprint,
        az: sums.parcel.filter(|x| *x != 0.0).map(|x| agf / x),
        uez: sums.parcel.filter(|x| *x != 0.0).map(|x| footprint / x),
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
    }
}
