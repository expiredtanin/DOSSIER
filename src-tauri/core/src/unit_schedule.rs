//! [278] Wohnungsspiegel: Nutzungseinheiten (`Project.units`, Räume verweisen mit `Room.unitId` darauf) mit
//! Geschoss, Typ, Zimmerzahl und Flächen nach SIA 416, dazu Summen je Typ und je Geschoss.
//!
//! # Annahmen (Schweizer Praxis, vor Abgabe gegen die Vorgaben des Wettbewerbs prüfen)
//!
//!  • **Flächen:** je Raum die Raumfläche nach `Room::area()` (lichter Umriss, wie [`crate::flaechen`]), gruppiert nach
//!    Flächenart `siaCategory`: HNF, NNF, VF, FF; `AGF` (Aussengeschossfläche) gilt als **Aussenraum** (Balkon, Loggia,
//!    gedeckter Sitzplatz) und steht in eigener Spalte, nicht in der NF. NF = HNF + NNF (SIA 416). Konstruktionsflächen
//!    (KGF-Räume) zählen nicht. Die Wände zwischen den Räumen sind nicht Teil der Einheit (wie in der Flächentabelle: KF).
//!  • **Zimmerzahl** nur bei Wohnnutzung (Fehlt `usage` an der Einheit ⇒ Wohnen): Summe der Beiträge der Räume.
//!    Beitrag je Raum: `Room.roomCount` (einstellbar, z. B. 0.5 für eine Wohnküche oder ein kleines Zimmer), sonst die
//!    Vorgabe aus der Raumnutzung ([`default_room_count`]): Wohnen, Schlafen, Essen, Büro/Arbeiten = 1, alles andere
//!    (Küche, Bad, WC, Diele/Verkehr, Abstellraum, Technik, ohne Nutzung) = 0 — und nur bei Räumen der Flächenart HNF. Eine
//!    Wohnküche ist von Hand zu setzen (Küche 0.5 oder Wohnen/Essen 1.5); es wird nichts aus dem Raumnamen erraten.
//!  • **Typ:** `Unit.unitType`, sonst bei Wohnungen mit Zimmern „n-Zi-Whg“ (n = Zimmerzahl, 3.5 → „3.5-Zi-Whg“).
//!  • **Geschoss:** Namen der Geschosse, in denen die Einheit Räume hat (von unten nach oben, „EG, 1. OG“ bei Maisonette).
//!  • **Summen je Geschoss:** eine Einheit zählt in jedem Geschoss, in dem sie Räume hat (mit den dort liegenden Flächen).
//!  • **Räume ohne (gültige) Einheit:** Gemeinschaftsflächen (Treppenhaus, Keller …), in `unassigned` ausgewiesen.
//!  • Einheiten ohne Räume stehen mit Nullen in der Liste.
//!
//! Gerechnet wird aus dem Dokument; Tabelle im Panel, CSV/PDF und Blatt-Tabelle formatieren dieselben Zeilen.

use crate::flaechen::floors_sorted;
use crate::jsnum::or_zero as finite;
use crate::model::*;
use serde::Serialize;
use std::collections::HashMap;

/// Vorgabe des Zimmerzahl-Beitrags eines Raums aus seiner Nutzung (siehe Moduldoku).
pub fn default_room_count(r: &Room) -> f64 {
    if r.sia_category != SiaCategory::HNF {
        return 0.0;
    }
    match r.usage {
        Some(RoomUsage::Living | RoomUsage::Sleeping | RoomUsage::Dining | RoomUsage::Office) => 1.0,
        _ => 0.0,
    }
}

/// Zimmerzahl-Beitrag eines Raums: eingestellte Zahl (≥ 0, auf Halbe gerundet), sonst die Vorgabe.
pub fn room_count(r: &Room) -> f64 {
    match r.room_count {
        Some(c) if c.is_finite() => (c.max(0.0) * 2.0).round() / 2.0,
        _ => default_room_count(r),
    }
}

impl UnitUsage {
    /// Kennung wie im JSON.
    pub fn key(self) -> &'static str {
        match self {
            UnitUsage::Living | UnitUsage::Unknown => "living",
            UnitUsage::Commercial => "commercial",
            UnitUsage::Office => "office",
            UnitUsage::Other => "other",
        }
    }
}

/// Flächen einer Einheit (m²).
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize)]
pub struct UnitAreas {
    pub hnf: f64,
    pub nnf: f64,
    /// NF = HNF + NNF.
    pub nf: f64,
    pub vf: f64,
    pub ff: f64,
    /// Aussenraum (Balkon, Loggia): Flächenart AGF.
    pub agf: f64,
}

impl UnitAreas {
    fn add_room(&mut self, cat: SiaCategory, a: f64) {
        match cat {
            SiaCategory::HNF => self.hnf += a,
            SiaCategory::NNF => self.nnf += a,
            SiaCategory::VF => self.vf += a,
            SiaCategory::FF => self.ff += a,
            SiaCategory::AGF => self.agf += a,
            SiaCategory::KGF | SiaCategory::Unknown => {}
        }
        self.nf = self.hnf + self.nnf;
    }
    fn add(&mut self, o: &UnitAreas) {
        self.hnf += o.hnf;
        self.nnf += o.nnf;
        self.nf += o.nf;
        self.vf += o.vf;
        self.ff += o.ff;
        self.agf += o.agf;
    }
}

/// Eine Zeile des Spiegels: eine Nutzungseinheit.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnitRow {
    pub id: String,
    pub name: String,
    /// Typ (eingegeben oder aus der Zimmerzahl abgeleitet; leer, wenn keins von beidem).
    pub type_label: String,
    /// `living`, `commercial`, `office`, `other`.
    pub usage: String,
    /// Namen der Geschosse (unten → oben).
    pub floors: Vec<String>,
    pub floor_ids: Vec<String>,
    pub rooms: usize,
    /// Zimmerzahl (nur Wohnnutzung, sonst 0).
    pub room_count: f64,
    #[serde(flatten)]
    pub areas: UnitAreas,
    pub color: Option<String>,
    pub note: String,
}

/// Summe je Typ.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnitTypeSum {
    pub type_label: String,
    pub count: usize,
    /// Summe der Zimmer aller Einheiten dieses Typs.
    pub room_count: f64,
    #[serde(flatten)]
    pub areas: UnitAreas,
    /// Mittlere HNF je Einheit.
    pub avg_hnf: f64,
}

/// Summe je Geschoss.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnitLevelSum {
    pub level_id: String,
    pub name: String,
    /// Einheiten mit Räumen in diesem Geschoss.
    pub count: usize,
    #[serde(flatten)]
    pub areas: UnitAreas,
}

/// Räume ohne gültige Einheit.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnitUnassigned {
    pub rooms: usize,
    #[serde(flatten)]
    pub areas: UnitAreas,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnitSchedule {
    pub units: Vec<UnitRow>,
    pub by_type: Vec<UnitTypeSum>,
    pub by_level: Vec<UnitLevelSum>,
    /// Summe über alle Einheiten (`count` = Zahl der Einheiten, `room_count` = Summe der Zimmer).
    pub total: UnitTypeSum,
    pub unassigned: UnitUnassigned,
}

fn auto_type(rooms: f64) -> String {
    format!("{}-Zi-Whg", rooms)
}

/// Wohnungsspiegel des Projekts.
pub fn unit_schedule(p: &Project) -> UnitSchedule {
    let floors = floors_sorted(p);
    let floor_idx: HashMap<&str, usize> = floors.iter().enumerate().map(|(i, l)| (l.id.as_str(), i)).collect();
    let units: &[Unit] = p.units.as_deref().unwrap_or(&[]);
    let mut by_id: HashMap<&str, usize> = HashMap::new();
    for (i, u) in units.iter().enumerate() {
        by_id.entry(u.id.as_str()).or_insert(i);
    }
    // Je Einheit und Geschoss die Flächen.
    let mut per: Vec<HashMap<usize, UnitAreas>> = vec![HashMap::new(); units.len()];
    let mut counts = vec![0.0_f64; units.len()];
    let mut n_rooms = vec![0usize; units.len()];
    let mut unassigned = UnitUnassigned::default();
    for r in p.rooms.as_deref().unwrap_or(&[]) {
        let Some(&fi) = floor_idx.get(r.floor_id.as_str()) else { continue };
        let a = finite(r.area());
        match r.unit_id.as_deref().and_then(|id| by_id.get(id)) {
            Some(&ui) => {
                per[ui].entry(fi).or_default().add_room(r.sia_category, a);
                counts[ui] += room_count(r);
                n_rooms[ui] += 1;
            }
            None => {
                unassigned.areas.add_room(r.sia_category, a);
                unassigned.rooms += 1;
            }
        }
    }
    let mut rows: Vec<UnitRow> = Vec::with_capacity(units.len());
    for (ui, u) in units.iter().enumerate() {
        let usage = u.usage.unwrap_or_default();
        let living = usage.key() == "living";
        let mut areas = UnitAreas::default();
        let mut fl: Vec<usize> = per[ui].keys().copied().collect();
        fl.sort_unstable();
        for a in per[ui].values() {
            areas.add(a);
        }
        let rc = if living { counts[ui] } else { 0.0 };
        let explicit = u.unit_type.as_deref().map(str::trim).filter(|s| !s.is_empty());
        let type_label = match explicit {
            Some(s) => s.to_string(),
            None if living && rc > 0.0 => auto_type(rc),
            None => String::new(),
        };
        rows.push(UnitRow {
            id: u.id.clone(),
            name: u.name.clone(),
            type_label,
            usage: usage.key().to_string(),
            floors: fl.iter().map(|&i| floors[i].name.clone()).collect(),
            floor_ids: fl.iter().map(|&i| floors[i].id.clone()).collect(),
            rooms: n_rooms[ui],
            room_count: rc,
            areas,
            color: u.color.clone(),
            note: u.note.clone().unwrap_or_default(),
        });
    }
    // Natürliche Reihenfolge nach Nummer („1.2“ vor „1.10“).
    rows.sort_by(|a, b| crate::room_book::natural_cmp(&a.name, &b.name).then_with(|| a.id.cmp(&b.id)));

    // Summen je Typ (Reihenfolge: erstes Auftreten in der sortierten Liste).
    let mut by_type: Vec<UnitTypeSum> = Vec::new();
    for r in &rows {
        let i = match by_type.iter().position(|t| t.type_label == r.type_label) {
            Some(i) => i,
            None => {
                by_type.push(UnitTypeSum { type_label: r.type_label.clone(), ..Default::default() });
                by_type.len() - 1
            }
        };
        let t = &mut by_type[i];
        t.count += 1;
        t.room_count += r.room_count;
        t.areas.add(&r.areas);
    }
    for t in &mut by_type {
        t.avg_hnf = if t.count > 0 { t.areas.hnf / t.count as f64 } else { 0.0 };
    }
    let mut total = UnitTypeSum::default();
    for t in &by_type {
        total.count += t.count;
        total.room_count += t.room_count;
        total.areas.add(&t.areas);
    }
    total.avg_hnf = if total.count > 0 { total.areas.hnf / total.count as f64 } else { 0.0 };

    // Summen je Geschoss (nur Geschosse mit Einheiten).
    let mut by_level: Vec<UnitLevelSum> = Vec::new();
    for (fi, l) in floors.iter().enumerate() {
        let mut s = UnitLevelSum { level_id: l.id.clone(), name: l.name.clone(), ..Default::default() };
        for m in &per {
            if let Some(a) = m.get(&fi) {
                s.count += 1;
                s.areas.add(a);
            }
        }
        if s.count > 0 {
            by_level.push(s);
        }
    }
    UnitSchedule { units: rows, by_type, by_level, total, unassigned }
}

/// CSV des Spiegels (Trenner „;“, Punkt als Dezimaltrenner) mit den übergebenen Spaltenköpfen:
/// Nummer, Geschoss, Typ, Nutzung, Zimmer, HNF, NNF, NF, Aussenraum.
pub fn schedule_csv(s: &UnitSchedule, head: &[String]) -> String {
    let q = |x: &str| if x.contains(';') || x.contains('"') || x.contains('\n') { format!("\"{}\"", x.replace('"', "\"\"")) } else { x.to_string() };
    let mut out = head.iter().map(|h| q(h)).collect::<Vec<_>>().join(";");
    out.push('\n');
    for u in &s.units {
        let cells = [q(&u.name), q(&u.floors.join(", ")), q(&u.type_label), q(&u.usage), format!("{}", u.room_count), format!("{:.2}", u.areas.hnf), format!("{:.2}", u.areas.nnf), format!("{:.2}", u.areas.nf), format!("{:.2}", u.areas.agf)];
        out.push_str(&cells.join(";"));
        out.push('\n');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(x: f64, y: f64) -> Vec2 {
        Vec2 { x, y }
    }
    /// Rechteck `w` × `h` m (Fläche w·h) im Geschoss `fl`.
    fn room(id: &str, fl: &str, w: f64, h: f64, cat: SiaCategory, usage: Option<RoomUsage>, unit: Option<&str>) -> Room {
        Room { id: id.into(), floor_id: fl.into(), name: id.into(), sia_category: cat, usage, unit_id: unit.map(String::from), boundary: vec![v(0.0, 0.0), v(w, 0.0), v(w, h), v(0.0, h)], ..Default::default() }
    }
    fn unit(id: &str, name: &str) -> Unit {
        Unit { id: id.into(), name: name.into(), ..Default::default() }
    }
    fn project() -> Project {
        use RoomUsage::*;
        use SiaCategory::*;
        Project {
            drawing_levels: vec![
                DrawingLevel { id: "og".into(), name: "1. OG".into(), base_elevation: Some(3.0), floor_height: Some(3.0), ..Default::default() },
                DrawingLevel { id: "eg".into(), name: "EG".into(), base_elevation: Some(0.0), floor_height: Some(3.0), ..Default::default() },
            ],
            units: Some(vec![unit("u10", "1.10"), unit("u2", "1.2"), unit("g", "G.1"), unit("leer", "9.9")]),
            rooms: Some(vec![
                // 1.2: EG, 2 Zimmer + Küche + Bad + Balkon -> 2-Zi-Whg
                room("w", "eg", 5.0, 4.0, HNF, Some(Living), Some("u2")),
                room("z", "eg", 4.0, 3.0, HNF, Some(Sleeping), Some("u2")),
                room("k", "eg", 3.0, 2.0, HNF, Some(Kitchen), Some("u2")),
                room("b", "eg", 2.0, 2.0, NNF, Some(Bath), Some("u2")),
                room("bal", "eg", 3.0, 1.0, AGF, None, Some("u2")),
                // 1.10: Maisonette EG/OG, Wohnküche 0.5 -> 3.5
                room("w2", "eg", 6.0, 4.0, HNF, Some(Living), Some("u10")),
                Room { room_count: Some(0.5), ..room("k2", "eg", 2.0, 2.0, HNF, Some(Kitchen), Some("u10")) },
                room("s1", "og", 4.0, 3.0, HNF, Some(Sleeping), Some("u10")),
                room("s2", "og", 3.0, 3.0, HNF, Some(Sleeping), Some("u10")),
                room("b2", "og", 2.0, 2.0, NNF, Some(Bath), Some("u10")),
                // Gewerbe
                room("l", "eg", 10.0, 5.0, HNF, Some(Office), Some("g")),
                // Treppenhaus ohne Einheit, Raum mit unbekannter Einheit
                room("th", "eg", 3.0, 3.0, VF, Some(Circulation), None),
                room("x", "og", 2.0, 1.0, HNF, Some(Living), Some("gibtsnicht")),
            ]),
            ..Default::default()
        }
    }

    #[test]
    fn spiegel_zimmer_flaechen_typ() {
        let mut p = project();
        p.units.as_mut().unwrap()[2].usage = Some(UnitUsage::Commercial);
        let s = unit_schedule(&p);
        let names: Vec<&str> = s.units.iter().map(|u| u.name.as_str()).collect();
        assert_eq!(names, ["1.2", "1.10", "9.9", "G.1"], "natürliche Reihenfolge");
        let u2 = &s.units[0];
        assert_eq!(u2.room_count, 2.0);
        assert_eq!(u2.type_label, "2-Zi-Whg");
        assert_eq!(u2.floors, ["EG"]);
        assert!((u2.areas.hnf - (20.0 + 12.0 + 6.0)).abs() < 1e-9, "Küche ist HNF, zählt aber 0 Zimmer");
        assert!((u2.areas.nnf - 4.0).abs() < 1e-9);
        assert!((u2.areas.nf - 42.0).abs() < 1e-9);
        assert!((u2.areas.agf - 3.0).abs() < 1e-9, "Balkon = Aussenraum, nicht in NF");
        let u10 = &s.units[1];
        assert_eq!(u10.room_count, 3.5, "Wohnen 1 + Wohnküche 0.5 + 2 × Schlafen");
        assert_eq!(u10.type_label, "3.5-Zi-Whg");
        assert_eq!(u10.floors, ["EG", "1. OG"], "Maisonette");
        assert_eq!(u10.floor_ids, ["eg", "og"]);
        assert_eq!(u10.rooms, 5);
        let leer = &s.units[2];
        assert_eq!((leer.rooms, leer.type_label.as_str(), leer.areas.nf), (0, "", 0.0));
        let g = &s.units[3];
        assert_eq!(g.usage, "commercial");
        assert_eq!(g.room_count, 0.0, "Gewerbe zählt keine Zimmer");
        assert_eq!(g.type_label, "");
        // Nicht zugeordnet: Treppenhaus (VF 9) und Raum mit unbekannter Einheit (HNF 2)
        assert_eq!(s.unassigned.rooms, 2);
        assert!((s.unassigned.areas.vf - 9.0).abs() < 1e-9);
        assert!((s.unassigned.areas.hnf - 2.0).abs() < 1e-9);
    }

    #[test]
    fn summen_je_typ_und_geschoss() {
        let s = unit_schedule(&project());
        let t: Vec<(&str, usize)> = s.by_type.iter().map(|t| (t.type_label.as_str(), t.count)).collect();
        // „9.9“ (leer) und „G.1“ (hier ohne Nutzung = Wohnen, ein Büro-Raum zählt als Zimmer) kommen als Wohnungen.
        assert_eq!(t[0], ("2-Zi-Whg", 1));
        assert_eq!(t[1], ("3.5-Zi-Whg", 1));
        assert_eq!(s.total.count, 4);
        let hnf: f64 = s.units.iter().map(|u| u.areas.hnf).sum();
        assert!((s.total.areas.hnf - hnf).abs() < 1e-9);
        assert!((s.by_type[0].avg_hnf - s.by_type[0].areas.hnf).abs() < 1e-9);
        // Geschosse unten → oben; die Maisonette zählt in beiden.
        let l: Vec<(&str, usize)> = s.by_level.iter().map(|l| (l.name.as_str(), l.count)).collect();
        assert_eq!(l, [("EG", 3), ("1. OG", 1)]);
        // 1. OG: nur die Einheit 1.10 (12 + 9 HNF, 4 NNF)
        assert!((s.by_level[1].areas.hnf - 21.0).abs() < 1e-9);
        assert!((s.by_level[1].areas.nnf - 4.0).abs() < 1e-9);
        // Summe je Geschoss = Summe der Einheiten.
        let sum: f64 = s.by_level.iter().map(|l| l.areas.hnf).sum();
        assert!((sum - hnf).abs() < 1e-9);
    }

    #[test]
    fn eingegebener_typ_geht_vor_und_zimmerzahl_wird_geklemmt() {
        let mut p = project();
        p.units.as_mut().unwrap()[0].unit_type = Some("  Maisonette  ".into());
        let s = unit_schedule(&p);
        assert_eq!(s.units[1].type_label, "Maisonette");
        assert_eq!(s.units[1].room_count, 3.5, "Zimmerzahl bleibt gerechnet");
        let r = Room { room_count: Some(1.3), ..Default::default() };
        assert_eq!(room_count(&r), 1.5);
        assert_eq!(room_count(&Room { room_count: Some(-2.0), ..Default::default() }), 0.0);
        assert_eq!(room_count(&Room { room_count: Some(f64::NAN), usage: Some(RoomUsage::Living), ..Default::default() }), 1.0, "NaN: Vorgabe");
        // Nur HNF zählt in der Vorgabe: ein Wohnraum als NNF ergibt 0.
        assert_eq!(default_room_count(&Room { sia_category: SiaCategory::NNF, usage: Some(RoomUsage::Living), ..Default::default() }), 0.0);
    }

    #[test]
    fn ohne_einheiten_und_unsinn() {
        let mut p = project();
        p.units = None;
        let s = unit_schedule(&p);
        assert!(s.units.is_empty() && s.by_type.is_empty() && s.by_level.is_empty());
        assert_eq!(s.unassigned.rooms, 13);
        // Raum mit NaN-Umriss und Raum in unbekanntem Geschoss.
        let mut p = project();
        p.rooms.as_mut().unwrap().push(room("n", "eg", f64::NAN, 1.0, SiaCategory::HNF, None, Some("u2")));
        p.rooms.as_mut().unwrap().push(room("f", "weg", 1.0, 1.0, SiaCategory::HNF, None, Some("u2")));
        let s = unit_schedule(&p);
        assert!(s.units[0].areas.hnf.is_finite());
        assert_eq!(s.units[0].rooms, 6, "NaN-Raum zählt als Raum mit Fläche 0, unbekanntes Geschoss gar nicht");
    }

    #[test]
    fn csv_hat_kopf_und_eine_zeile_je_einheit() {
        let s = unit_schedule(&project());
        let csv = schedule_csv(&s, &["Nr".into(), "Geschoss".into(), "Typ".into(), "Nutzung".into(), "Zimmer".into(), "HNF".into(), "NNF".into(), "NF".into(), "Aussen".into()]);
        let lines: Vec<&str> = csv.lines().collect();
        assert_eq!(lines.len(), 5);
        assert_eq!(lines[1], "1.2;EG;2-Zi-Whg;living;2;38.00;4.00;42.00;3.00");
        assert!(lines[2].starts_with("1.10;EG, 1. OG;3.5-Zi-Whg;"), "{}", lines[2]);
    }

    #[test]
    fn json_hat_flache_flaechen() {
        let s = unit_schedule(&project());
        let j = serde_json::to_value(&s).unwrap();
        assert!(j["units"][0]["hnf"].is_number() && j["units"][0]["typeLabel"].is_string());
        assert!(j["byType"][0]["avgHnf"].is_number() && j["total"]["count"] == 4 && j["unassigned"]["rooms"] == 2);
    }
}
