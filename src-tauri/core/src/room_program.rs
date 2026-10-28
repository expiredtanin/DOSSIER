//! Raumprogramm ([61]): Soll/Ist-Vergleich gegen die gezeichneten Räume und Anordnung der
//! Soll-Räume als Blatt („Räume generieren"). Aus `analysis/kennzahlen.ts` (`checkRoomProgram`) hervorgegangen.
//!
//! # Vergleich ([`compare`])
//! * Zuordnung Programmzeile → Räume über den Namen: ohne Gross-/Kleinschreibung, ohne führende Nummer
//!   („1.02 Wohnen", „101 Büro") und ohne Mehrfach-Leerzeichen. Erst genaue Treffer (auch mit angehängter
//!   Nummer: „Wohnen 2" trifft „Wohnen"), dann Präfix („Bad" trifft „Bad/WC"). Jeder Raum gehört höchstens einer
//!   Zeile, in Reihenfolge des Programms. Ist eine Flächenart (`siaCategory`) angegeben, muss der Raum sie haben.
//!   Leerer Name trifft nichts.
//! * Soll = Anzahl × Fläche je Raum; Ist = Summe der zugeordneten Räume; Differenz absolut und relativ zum Soll.
//! * Status je Zeile: fehlt / zu wenige / zu viele (Anzahl), sonst zu klein / zu gross (Summe ausserhalb der
//!   Toleranz), sonst ok.
//! * Ampel: grün innerhalb der Toleranz (`Project.roomProgramTolerance`, Standard 5 %), gelb bis zum
//!   Doppelten, sonst rot; Anzahlfehler und fehlende Räume sind rot. Summen (Gruppe, Flächenart, gesamt)
//!   bewerten nur die Fläche.
//!
//! # Anordnung ([`layout`])
//! Je Raum (Anzahl beachten) ein Rechteck mit genau der Soll-Fläche im Seitenverhältnis Breite : Tiefe = 4 : 3
//! (b = √(A·4/3), t = √(A·3/4)). Gruppen (`group`, sonst Flächenart, sonst ohne Titel) in Reihenfolge des
//! Programms untereinander als Bänder; im Band absteigend nach Fläche in Reihen (Shelf-Packing, Abstand
//! `gap`). Die Reihenbreite wird so gewählt, dass das Gesamtbild möglichst nahe an 4 : 3 liegt.
//! Koordinaten: Meter, y nach oben, die erste Gruppe liegt oben; links unten bei (0, 0).

use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use crate::flat_read::signed_area;
use crate::model::{Project, SiaCategory};

pub const DEFAULT_TOLERANCE: f64 = 0.05;

fn finite(v: f64) -> f64 {
    if v.is_finite() {
        v
    } else {
        0.0
    }
}

fn cat_name(c: SiaCategory) -> &'static str {
    match c {
        SiaCategory::HNF => "HNF",
        SiaCategory::NNF => "NNF",
        SiaCategory::VF => "VF",
        SiaCategory::FF => "FF",
        SiaCategory::KGF => "KGF",
        SiaCategory::AGF => "AGF",
        SiaCategory::Unknown => "",
    }
}

/// Toleranz des Projekts (Anteil), geklemmt auf 0 … 1.
pub fn tolerance(p: &Project) -> f64 {
    match p.room_program_tolerance {
        Some(t) if t.is_finite() => t.clamp(0.0, 1.0),
        _ => DEFAULT_TOLERANCE,
    }
}

// ── Namen ───────────────────────────────────────────────────────────────────

/// Vergleichsform eines Namens: klein, Leerraum zusammengezogen, führende Nummer („1.02 ", „101 ") entfernt.
pub fn norm_name(s: &str) -> String {
    let lower = s.to_lowercase();
    let joined = lower.split_whitespace().collect::<Vec<_>>().join(" ");
    strip_leading_number(&joined).to_string()
}

fn strip_leading_number(s: &str) -> &str {
    let b = s.as_bytes();
    let mut i = 0;
    while i < b.len() && (b[i].is_ascii_digit() || ((b[i] == b'.' || b[i] == b'-' || b[i] == b'/') && i > 0 && b[i - 1].is_ascii_digit())) {
        i += 1;
    }
    // Nur ganze Nummern-Wörter („101 Büro"), nicht „2.5-Zimmer" (kein Leerzeichen danach) und nicht den ganzen Namen.
    if i > 0 && i < b.len() && b[i] == b' ' {
        s[i + 1..].trim_start()
    } else {
        s
    }
}

/// Name ohne angehängte Nummer („wohnen 2" → „wohnen", „wohnen 2.1" → „wohnen").
fn strip_trailing_number(s: &str) -> &str {
    match s.rsplit_once(' ') {
        Some((head, tail)) if !head.is_empty() && !tail.is_empty() && tail.chars().all(|c| c.is_ascii_digit() || c == '.' || c == '-') => head.trim_end(),
        _ => s,
    }
}

// ── Vergleich ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CompareRow {
    pub index: usize,
    pub name: String,
    pub group: Option<String>,
    pub kind: Option<String>,
    pub target_count: u32,
    /// Soll-Fläche je Raum.
    pub target_area: f64,
    /// Soll gesamt (Anzahl × Fläche).
    pub soll: f64,
    pub count: usize,
    /// Ist gesamt (Summe der zugeordneten Räume).
    pub ist: f64,
    pub diff: f64,
    /// Differenz relativ zum Soll; `None` bei Soll 0.
    pub diff_pct: Option<f64>,
    pub status: String,
    pub light: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CompareSum {
    /// Gruppen- bzw. Flächenart-Name; leer = ohne Angabe.
    pub key: String,
    pub rows: usize,
    pub soll: f64,
    pub ist: f64,
    pub diff: f64,
    pub diff_pct: Option<f64>,
    pub light: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExtraRoom {
    pub id: String,
    pub name: String,
    pub area: f64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Compare {
    pub tolerance: f64,
    pub rows: Vec<CompareRow>,
    pub groups: Vec<CompareSum>,
    pub kinds: Vec<CompareSum>,
    pub total: CompareSum,
    /// Räume im Modell ohne Programmzeile.
    pub extra: Vec<ExtraRoom>,
    pub extra_area: f64,
}

struct RoomRef {
    id: String,
    name: String,
    norm: String,
    base: String,
    cat: SiaCategory,
    area: f64,
}

fn light_of_pct(soll: f64, ist: f64, pct: Option<f64>, tol: f64) -> &'static str {
    match pct {
        Some(p) if p.abs() <= tol + 1e-12 => "green",
        Some(p) if p.abs() <= 2.0 * tol + 1e-12 => "yellow",
        Some(_) => "red",
        None => {
            if soll == 0.0 && ist == 0.0 {
                "grey"
            } else {
                "red"
            }
        }
    }
}

fn sum_of(key: &str, rows: &[&CompareRow], tol: f64) -> CompareSum {
    let soll = rows.iter().fold(0.0, |a, r| a + r.soll);
    let ist = rows.iter().fold(0.0, |a, r| a + r.ist);
    let diff = ist - soll;
    let diff_pct = if soll > 0.0 { Some(diff / soll) } else { None };
    CompareSum { key: key.to_string(), rows: rows.len(), soll, ist, diff, diff_pct, light: light_of_pct(soll, ist, diff_pct, tol).to_string() }
}

/// Soll/Ist-Vergleich des Raumprogramms mit den Räumen des Projekts.
pub fn compare(p: &Project) -> Compare {
    let tol = tolerance(p);
    let rooms: Vec<RoomRef> = p
        .rooms
        .as_deref()
        .unwrap_or(&[])
        .iter()
        .map(|r| {
            let pts: Vec<[f64; 2]> = r.boundary.iter().map(|v| [v.x, v.y]).collect();
            let norm = norm_name(&r.name);
            let base = strip_trailing_number(&norm).to_string();
            RoomRef { id: r.id.clone(), name: r.name.clone(), norm, base, cat: r.sia_category, area: finite(signed_area(&pts).abs()) }
        })
        .collect();
    let program = p.room_program.as_deref().unwrap_or(&[]);
    let mut used: HashSet<usize> = HashSet::new();
    let mut hits: Vec<Vec<usize>> = vec![Vec::new(); program.len()];
    let wanted: Vec<String> = program.iter().map(|r| norm_name(&r.name)).collect();
    let fits = |ri: usize, ro: usize| -> bool { program[ri].sia_category.is_none_or(|c| c == rooms[ro].cat) };
    // Durchgang 1: genauer Name (mit/ohne angehängte Nummer), Durchgang 2: Präfix.
    for pass in 0..2 {
        for (ri, n) in wanted.iter().enumerate() {
            if n.is_empty() {
                continue;
            }
            for (ro, room) in rooms.iter().enumerate() {
                if used.contains(&ro) || !fits(ri, ro) {
                    continue;
                }
                let hit = if pass == 0 { room.norm == *n || room.base == *n } else { room.norm.starts_with(n.as_str()) };
                if hit {
                    used.insert(ro);
                    hits[ri].push(ro);
                }
            }
        }
    }
    let rows: Vec<CompareRow> = program
        .iter()
        .enumerate()
        .map(|(i, row)| {
            let target_count = row.count.filter(|c| c.is_finite()).map_or(1.0, |c| c.round()).max(1.0) as u32;
            let target_area = finite(row.area).max(0.0);
            let soll = target_area * target_count as f64;
            let count = hits[i].len();
            let ist = hits[i].iter().fold(0.0, |a, &k| a + rooms[k].area);
            let diff = ist - soll;
            let diff_pct = if soll > 0.0 { Some(diff / soll) } else { None };
            let tc = target_count as usize;
            let status = if count == 0 {
                "fehlt"
            } else if count < tc {
                "zu wenige"
            } else if count > tc {
                "zu viele"
            } else if ist < soll * (1.0 - tol) {
                "zu klein"
            } else if ist > soll * (1.0 + tol) {
                "zu gross"
            } else {
                "ok"
            };
            let light = match status {
                "ok" => "green",
                "zu klein" | "zu gross" => light_of_pct(soll, ist, diff_pct, tol).max_yellow(),
                _ => "red",
            };
            CompareRow {
                index: i,
                name: row.name.clone(),
                group: row.group.as_ref().map(|g| g.trim().to_string()).filter(|g| !g.is_empty()),
                kind: row.sia_category.map(cat_name).filter(|c| !c.is_empty()).map(str::to_string),
                target_count,
                target_area,
                soll,
                count,
                ist,
                diff,
                diff_pct,
                status: status.to_string(),
                light: light.to_string(),
            }
        })
        .collect();

    let sums_by = |key_of: &dyn Fn(&CompareRow) -> String| -> Vec<CompareSum> {
        let mut keys: Vec<String> = Vec::new();
        for r in &rows {
            let k = key_of(r);
            if !keys.contains(&k) {
                keys.push(k);
            }
        }
        keys.iter().map(|k| sum_of(k, &rows.iter().filter(|r| key_of(r) == *k).collect::<Vec<_>>(), tol)).collect()
    };
    let groups = sums_by(&|r| r.group.clone().unwrap_or_default());
    let kinds = sums_by(&|r| r.kind.clone().unwrap_or_default());
    let total = sum_of("", &rows.iter().collect::<Vec<_>>(), tol);
    let extra: Vec<ExtraRoom> =
        rooms.iter().enumerate().filter(|(i, _)| !used.contains(i)).map(|(_, r)| ExtraRoom { id: r.id.clone(), name: r.name.clone(), area: r.area }).collect();
    let extra_area = extra.iter().fold(0.0, |a, e| a + e.area);
    Compare { tolerance: tol, rows, groups, kinds, total, extra, extra_area }
}

trait MaxYellow {
    fn max_yellow(self) -> &'static str;
}
impl MaxYellow for &'static str {
    /// Eine Flächenabweichung ausserhalb der Toleranz ist nie grün (Rundungsgrenze).
    fn max_yellow(self) -> &'static str {
        if self == "green" {
            "yellow"
        } else {
            self
        }
    }
}

// ── Anordnung ───────────────────────────────────────────────────────────────

/// Seitenverhältnis Breite : Tiefe der Raum-Rechtecke und des Gesamtbilds.
pub const ASPECT: f64 = 4.0 / 3.0;

#[derive(Debug, Clone, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LayoutOptions {
    /// Abstand zwischen Rechtecken und Reihen (m).
    pub gap: f64,
    /// Höhe des Bereichs für den Gruppentitel (m).
    pub title_height: f64,
}

impl Default for LayoutOptions {
    fn default() -> Self {
        LayoutOptions { gap: 1.0, title_height: 1.6 }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LayoutItem {
    /// Index der Programmzeile.
    pub row: usize,
    /// Laufnummer innerhalb der Zeile (0-basiert, bei Anzahl > 1).
    pub copy: u32,
    pub name: String,
    pub group_index: usize,
    pub area: f64,
    /// Linke untere Ecke.
    pub x: f64,
    pub y: f64,
    /// Breite (x) und Tiefe (y).
    pub w: f64,
    pub d: f64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LayoutGroup {
    pub index: usize,
    /// Gruppen-/Flächenart-Name; leer = ohne Titel.
    pub name: String,
    /// Linke untere Ecke des Titelbereichs und dessen Breite.
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub title_height: f64,
    /// Summe der Soll-Flächen der Gruppe.
    pub area: f64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Layout {
    pub items: Vec<LayoutItem>,
    pub groups: Vec<LayoutGroup>,
    pub width: f64,
    pub height: f64,
    /// Zeilen ohne gültige Fläche (≤ 0, NaN) oder ohne Namen sind übersprungen.
    pub skipped: usize,
}

struct Unit {
    row: usize,
    copy: u32,
    name: String,
    area: f64,
    w: f64,
    d: f64,
}

/// Breite und Tiefe eines Raums der Fläche `a` im Verhältnis 4 : 3.
pub fn room_size(a: f64) -> (f64, f64) {
    ((a * 4.0 / 3.0).sqrt(), (a * 3.0 / 4.0).sqrt())
}

/// Ein Durchgang mit fester Reihenbreite `max_w`: Positionen in „y nach unten"-Koordinaten (Ursprung oben links).
fn place(groups: &[Vec<Unit>], titled: &[bool], max_w: f64, opt: &LayoutOptions) -> (Vec<(usize, usize, f64, f64)>, Vec<f64>, f64, f64) {
    let mut placed = Vec::new(); // (Gruppe, Index in Gruppe, x, y_oben)
    let mut group_y = Vec::new();
    let mut y = 0.0;
    let mut width: f64 = 0.0;
    for (gi, units) in groups.iter().enumerate() {
        if gi > 0 {
            y += opt.gap;
        }
        group_y.push(y);
        if titled[gi] {
            y += opt.title_height;
        }
        let (mut x, mut shelf_h) = (0.0, 0.0f64);
        for (ui, u) in units.iter().enumerate() {
            if x > 0.0 && x + u.w > max_w + 1e-9 {
                y += shelf_h + opt.gap;
                x = 0.0;
                shelf_h = 0.0;
            }
            placed.push((gi, ui, x, y));
            shelf_h = shelf_h.max(u.d);
            x += u.w;
            width = width.max(x);
            x += opt.gap;
        }
        y += shelf_h;
    }
    (placed, group_y, width, y)
}

/// Raumprogramm als Rechtecke anordnen (s. Modulkopf).
pub fn layout(p: &Project, opt: &LayoutOptions) -> Layout {
    let opt = LayoutOptions { gap: finite(opt.gap).max(0.0), title_height: finite(opt.title_height).max(0.0) };
    let program = p.room_program.as_deref().unwrap_or(&[]);
    let mut skipped = 0;
    let mut names: Vec<String> = Vec::new(); // Gruppennamen in Reihenfolge des ersten Auftretens
    let mut groups: Vec<Vec<Unit>> = Vec::new();
    for (i, row) in program.iter().enumerate() {
        let area = finite(row.area);
        if area <= 0.0 || row.name.trim().is_empty() {
            skipped += 1;
            continue;
        }
        let key = row
            .group
            .as_deref()
            .map(str::trim)
            .filter(|g| !g.is_empty())
            .map(str::to_string)
            .or_else(|| row.sia_category.map(cat_name).filter(|c| !c.is_empty()).map(str::to_string))
            .unwrap_or_default();
        let gi = match names.iter().position(|n| *n == key) {
            Some(g) => g,
            None => {
                names.push(key);
                groups.push(Vec::new());
                names.len() - 1
            }
        };
        let count = row.count.filter(|c| c.is_finite()).map_or(1.0, |c| c.round()).clamp(1.0, 500.0) as u32;
        let (w, d) = room_size(area);
        for c in 0..count {
            groups[gi].push(Unit { row: i, copy: c, name: row.name.trim().to_string(), area, w, d });
        }
    }
    // Im Band absteigend nach Fläche (stabil: gleiche Fläche behält die Programm-Reihenfolge).
    for g in &mut groups {
        g.sort_by(|a, b| b.area.partial_cmp(&a.area).unwrap_or(std::cmp::Ordering::Equal));
    }
    let titled: Vec<bool> = names.iter().map(|n| !n.is_empty()).collect();
    if groups.is_empty() {
        return Layout { items: vec![], groups: vec![], width: 0.0, height: 0.0, skipped };
    }
    // Reihenbreite wählen: Kandidaten von der breitesten Einzelbreite bis zur Summe aller Breiten (geometrisch).
    let min_w = groups.iter().flatten().map(|u| u.w).fold(0.0, f64::max);
    let max_w = groups.iter().map(|g| g.iter().map(|u| u.w + opt.gap).sum::<f64>()).fold(min_w, f64::max);
    let steps = 120;
    let mut best: Option<(f64, f64, f64)> = None; // (Fehler, Fläche, Reihenbreite)
    for s in 0..=steps {
        let w = if max_w > min_w { min_w * (max_w / min_w).powf(s as f64 / steps as f64) } else { min_w };
        let (_, _, tw, th) = place(&groups, &titled, w, &opt);
        if tw <= 0.0 || th <= 0.0 {
            continue;
        }
        let err = (tw / th / ASPECT).ln().abs();
        let area = tw * th;
        let better = match best {
            None => true,
            Some((e, a, _)) => err < e - 1e-9 || ((err - e).abs() <= 1e-9 && area < a),
        };
        if better {
            best = Some((err, area, w));
        }
    }
    let row_w = best.map_or(min_w, |b| b.2);
    let (placed, group_y, width, height) = place(&groups, &titled, row_w, &opt);
    let items = placed
        .iter()
        .map(|&(gi, ui, x, y_top)| {
            let u = &groups[gi][ui];
            LayoutItem { row: u.row, copy: u.copy, name: u.name.clone(), group_index: gi, area: u.area, x, y: height - y_top - u.d, w: u.w, d: u.d }
        })
        .collect();
    let out_groups = names
        .iter()
        .enumerate()
        .map(|(gi, n)| LayoutGroup {
            index: gi,
            name: n.clone(),
            x: 0.0,
            y: height - group_y[gi] - opt.title_height,
            w: width,
            title_height: if titled[gi] { opt.title_height } else { 0.0 },
            area: groups[gi].iter().fold(0.0, |a, u| a + u.area),
        })
        .collect();
    Layout { items, groups: out_groups, width, height, skipped }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Room, RoomProgramRow, Vec2};

    fn sq(x: f64, y: f64, s: f64) -> Vec<Vec2> {
        vec![Vec2 { x, y }, Vec2 { x: x + s, y }, Vec2 { x: x + s, y: y + s }, Vec2 { x, y: y + s }]
    }

    fn room(id: &str, name: &str, b: Vec<Vec2>) -> Room {
        Room { id: id.into(), name: name.into(), boundary: b, ..Default::default() }
    }

    fn row(name: &str, area: f64, count: Option<f64>, group: Option<&str>) -> RoomProgramRow {
        RoomProgramRow { name: name.into(), area, count, group: group.map(str::to_string), ..Default::default() }
    }

    #[test]
    fn namen_normalisieren() {
        assert_eq!(norm_name("  1.02   Wohnen "), "wohnen");
        assert_eq!(norm_name("101 Büro"), "büro");
        assert_eq!(norm_name("2.5-Zimmer"), "2.5-zimmer");
        assert_eq!(norm_name("12"), "12");
        assert_eq!(strip_trailing_number("wohnen 2"), "wohnen");
        assert_eq!(strip_trailing_number("wohnen"), "wohnen");
    }

    #[test]
    fn vergleich_status_summen_und_ampel() {
        let p = Project {
            rooms: Some(vec![
                room("r1", "Wohnen", sq(0.0, 0.0, 5.0)),            // 25
                room("r2", "bad", sq(10.0, 0.0, 2.0)),               // 4
                room("r3", "Keller", sq(20.0, 0.0, 2.0)),            // extra
                room("r4", "1.02 Zimmer 1", sq(30.0, 0.0, 3.0)),     // 9
                room("r5", "Zimmer 2", sq(40.0, 0.0, 3.0)),          // 9
            ]),
            room_program: Some(vec![
                row("Wohnen", 30.0, None, Some("Tag")),
                row("Bad", 4.0, None, Some("Nacht")),
                row("Büro", 12.0, None, Some("Tag")),
                row("Zimmer", 9.0, Some(3.0), Some("Nacht")),
            ]),
            ..Default::default()
        };
        let c = compare(&p);
        assert_eq!(c.tolerance, 0.05);
        let by = |n: &str| c.rows.iter().find(|r| r.name == n).unwrap();
        assert_eq!(by("Wohnen").status, "zu klein");
        assert_eq!(by("Wohnen").light, "red"); // -16.7 % > 10 %
        assert_eq!(by("Bad").status, "ok");
        assert_eq!(by("Bad").light, "green");
        assert_eq!(by("Büro").status, "fehlt");
        assert!(by("Büro").ist.is_sign_positive(), "Ist ohne Treffer ist +0, nicht -0");
        assert_eq!(by("Zimmer").status, "zu wenige");
        assert_eq!(by("Zimmer").count, 2);
        assert!((by("Zimmer").soll - 27.0).abs() < 1e-9);
        assert!((by("Zimmer").ist - 18.0).abs() < 1e-9);
        assert_eq!(c.extra.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(), vec!["Keller"]);
        let tag = c.groups.iter().find(|g| g.key == "Tag").unwrap();
        assert!((tag.soll - 42.0).abs() < 1e-9 && (tag.ist - 25.0).abs() < 1e-9);
        assert!((tag.diff_pct.unwrap() - (25.0 - 42.0) / 42.0).abs() < 1e-9);
        assert!((c.total.soll - (42.0 + 4.0 + 27.0)).abs() < 1e-9);
        assert_eq!(c.groups.len(), 2);
    }

    #[test]
    fn toleranz_und_gelb() {
        let mk = |tol: Option<f64>, side: f64| Project {
            rooms: Some(vec![room("r", "Küche", sq(0.0, 0.0, side))]),
            room_program: Some(vec![row("Küche", 10.0, None, None)]),
            room_program_tolerance: tol,
            ..Default::default()
        };
        // 10.4 m² statt 10: +4 % → grün (Standard 5 %)
        let c = compare(&mk(None, 10.4f64.sqrt()));
        assert_eq!((c.rows[0].status.as_str(), c.rows[0].light.as_str()), ("ok", "green"));
        // +8 % → zu gross, gelb (≤ 10 %)
        let c = compare(&mk(None, 10.8f64.sqrt()));
        assert_eq!((c.rows[0].status.as_str(), c.rows[0].light.as_str()), ("zu gross", "yellow"));
        // +8 % bei 10 % Toleranz → ok
        let c = compare(&mk(Some(0.1), 10.8f64.sqrt()));
        assert_eq!(c.rows[0].status, "ok");
        // +30 % → rot
        let c = compare(&mk(None, 13.0f64.sqrt()));
        assert_eq!(c.rows[0].light, "red");
    }

    #[test]
    fn genaue_namen_vor_praefix() {
        let p = Project {
            rooms: Some(vec![room("a", "Wohnen/Essen", sq(0.0, 0.0, 4.0)), room("b", "Wohnen", sq(10.0, 0.0, 4.0))]),
            room_program: Some(vec![row("Wohnen", 16.0, None, None), row("Wohnen/Essen", 16.0, None, None)]),
            ..Default::default()
        };
        let c = compare(&p);
        assert!(c.rows.iter().all(|r| r.status == "ok" && r.count == 1));
    }

    #[test]
    fn leerer_name_trifft_nichts() {
        let p = Project { rooms: Some(vec![room("a", "X", sq(0.0, 0.0, 2.0))]), room_program: Some(vec![row("  ", 10.0, None, None)]), ..Default::default() };
        let c = compare(&p);
        assert_eq!(c.rows[0].status, "fehlt");
        assert_eq!(c.extra.len(), 1);
    }

    fn overlap(a: &LayoutItem, b: &LayoutItem) -> bool {
        a.x < b.x + b.w - 1e-9 && b.x < a.x + a.w - 1e-9 && a.y < b.y + b.d - 1e-9 && b.y < a.y + a.d - 1e-9
    }

    fn program() -> Project {
        let mut rows = vec![];
        for (i, a) in [28.0, 12.0, 9.0, 16.5, 4.0, 22.0, 6.0, 35.0, 14.0, 8.0].iter().enumerate() {
            rows.push(row(&format!("Raum {i}"), *a, Some(1.0 + (i % 3) as f64), Some(if i % 2 == 0 { "Wohnen" } else { "Arbeiten" })));
        }
        Project { room_program: Some(rows), ..Default::default() }
    }

    #[test]
    fn anordnung_flaechen_exakt_und_43() {
        let p = program();
        let l = layout(&p, &LayoutOptions::default());
        let expected: usize = p.room_program.as_ref().unwrap().iter().map(|r| r.count.unwrap() as usize).sum();
        assert_eq!(l.items.len(), expected);
        for it in &l.items {
            assert!((it.w * it.d - it.area).abs() < 1e-9, "Fläche {} != {}", it.w * it.d, it.area);
            assert!((it.w / it.d - 4.0 / 3.0).abs() < 1e-9);
        }
        // Gesamtbild nahe 4 : 3
        let aspect = l.width / l.height;
        assert!((aspect / ASPECT).ln().abs() < 0.25, "Seitenverhältnis {aspect}");
        // Alles innerhalb der Hülle, ohne Überlappung
        for it in &l.items {
            assert!(it.x >= -1e-9 && it.y >= -1e-9 && it.x + it.w <= l.width + 1e-9 && it.y + it.d <= l.height + 1e-9);
        }
        for i in 0..l.items.len() {
            for j in i + 1..l.items.len() {
                assert!(!overlap(&l.items[i], &l.items[j]), "{i} und {j} überlappen");
            }
        }
        // Titel liegen über den Räumen ihrer Gruppe und nicht auf ihnen
        for g in &l.groups {
            assert!(!g.name.is_empty());
            for it in l.items.iter().filter(|i| i.group_index == g.index) {
                assert!(it.y + it.d <= g.y + 1e-9, "Raum über Titel");
            }
        }
    }

    #[test]
    fn anordnung_gruppen_und_sortierung() {
        let l = layout(&program(), &LayoutOptions::default());
        assert_eq!(l.groups.iter().map(|g| g.name.as_str()).collect::<Vec<_>>(), vec!["Wohnen", "Arbeiten"]);
        // erste Gruppe oben
        assert!(l.groups[0].y > l.groups[1].y);
        // innerhalb der Gruppe absteigend nach Fläche (Reihenfolge der Items = Packreihenfolge)
        for gi in 0..2 {
            let a: Vec<f64> = l.items.iter().filter(|i| i.group_index == gi).map(|i| i.area).collect();
            assert!(a.windows(2).all(|w| w[0] >= w[1]));
        }
    }

    #[test]
    fn anordnung_ohne_gruppe_flaechenart_und_unsinn() {
        let mut p = Project::default();
        let mut r = row("A", 10.0, None, None);
        r.sia_category = Some(SiaCategory::NNF);
        p.room_program = Some(vec![r, row("B", 0.0, None, None), row("", 5.0, None, None), row("C", f64::NAN, None, None), row("D", 5.0, None, None)]);
        let l = layout(&p, &LayoutOptions::default());
        assert_eq!(l.skipped, 3);
        assert_eq!(l.items.len(), 2);
        assert_eq!(l.groups.iter().map(|g| g.name.as_str()).collect::<Vec<_>>(), vec!["NNF", ""]);
        assert_eq!(l.groups[1].title_height, 0.0);
        assert!(layout(&Project::default(), &LayoutOptions::default()).items.is_empty());
    }
}
