//! [158] Raumbuch: Oberflächen je Raum (Boden, Wand, Decke), Nutzung und die Mengen daraus.
//!
//! Je Raum eine Zeile mit Geschoss, Nummer, Name, Fläche, Nutzung (Nassraum abgeleitet), Bodenbelag,
//! Wand- und Deckenoberfläche (Bauteil-Material über seine Kennung oder Freitext) und Bodenaufbau.
//! Mengen: Bodenfläche = Deckenfläche = Raumfläche (netto); Wandfläche netto = Umfang × lichte Höhe −
//! Öffnungen in den Wänden am Raum. Lichte Höhe aus den Decken über/unter dem Raum (Oberkante der Decke
//! am Boden bis Unterkante der Decke darüber), sonst Geschosshöhe.
//! Die Tabelle wird im Kern gerechnet; CSV/PDF und Blatt-Tabelle formatieren dieselben Zeilen.

use crate::model::*;
use serde::Serialize;

impl RoomUsage {
    /// Kennung wie im JSON (`living`, `bath` …); leer für unbekannte Werte.
    pub fn key(self) -> &'static str {
        match self {
            RoomUsage::Living => "living",
            RoomUsage::Sleeping => "sleeping",
            RoomUsage::Kitchen => "kitchen",
            RoomUsage::Dining => "dining",
            RoomUsage::Bath => "bath",
            RoomUsage::Wc => "wc",
            RoomUsage::Shower => "shower",
            RoomUsage::Laundry => "laundry",
            RoomUsage::Circulation => "circulation",
            RoomUsage::Technical => "technical",
            RoomUsage::Storage => "storage",
            RoomUsage::Office => "office",
            RoomUsage::Other => "other",
            RoomUsage::Unknown => "",
        }
    }

    /// Alle wählbaren Nutzungen (Reihenfolge der Auswahl).
    pub const ALL: [RoomUsage; 13] = [
        RoomUsage::Living,
        RoomUsage::Sleeping,
        RoomUsage::Kitchen,
        RoomUsage::Dining,
        RoomUsage::Bath,
        RoomUsage::Wc,
        RoomUsage::Shower,
        RoomUsage::Laundry,
        RoomUsage::Circulation,
        RoomUsage::Technical,
        RoomUsage::Storage,
        RoomUsage::Office,
        RoomUsage::Other,
    ];

    pub fn from_key(k: &str) -> Option<RoomUsage> {
        let k = k.trim().to_lowercase();
        Self::ALL.into_iter().find(|u| u.key() == k)
    }

    /// Nassraum: Bad, WC, Dusche, Waschküche.
    pub fn is_wet(self) -> bool {
        matches!(self, RoomUsage::Bath | RoomUsage::Wc | RoomUsage::Shower | RoomUsage::Laundry)
    }
}

/// Bauteil-Material, auf das eine Oberflächen-Angabe verweist (Kennung, sonst gleicher Name).
pub fn finish_component<'a>(p: &'a Project, v: Option<&str>) -> Option<&'a Component> {
    let v = v.map(str::trim).filter(|s| !s.is_empty())?;
    p.component(v).or_else(|| p.components.iter().find(|c| c.name.trim() == v))
}

/// Anzeigetext einer Oberflächen-Angabe: Name des Materials, sonst der Freitext.
pub fn finish_label(p: &Project, v: Option<&str>) -> String {
    let t = v.map(str::trim).unwrap_or("");
    match p.component(t) {
        Some(c) if !t.is_empty() => c.name.clone(),
        _ => t.to_string(),
    }
}

fn level_of<'a>(p: &'a Project, id: &str) -> Option<&'a DrawingLevel> {
    p.drawing_levels.iter().find(|l| l.id == id)
}

fn in_ceiling(ce: &Ceiling, x: f64, y: f64) -> bool {
    use crate::opening_schedule::in_ring;
    ce.outline.len() >= 3 && in_ring(x, y, &ce.outline) && !ce.openings.as_deref().unwrap_or(&[]).iter().any(|h| h.len() >= 3 && in_ring(x, y, h))
}

/// Lichte Höhe eines Raums (m): von der Oberkante der Decke unter dem Raum (bis 0.3 m unter bzw. 0.5 m
/// über dem Geschossboden, sonst der Geschossboden) bis zur Unterkante der nächsten Decke darüber
/// (sonst Geschossoberkante). Ohne Geschosshöhe 2.5 m.
pub fn clear_height(p: &Project, r: &Room) -> f64 {
    let lvl = level_of(p, &r.floor_id);
    let base = lvl.and_then(|l| l.base_elevation).filter(|v| v.is_finite()).unwrap_or(0.0);
    let fh = lvl.and_then(|l| l.floor_height).filter(|h| h.is_finite() && *h > 0.0).unwrap_or(2.5);
    let ring: Vec<[f64; 2]> = r.boundary.iter().map(|v| [v.x, v.y]).collect();
    if ring.len() < 3 {
        return fh;
    }
    let [x, y] = crate::room_area::label_point(&ring);
    let over: Vec<(f64, f64)> = p.ceilings.as_deref().unwrap_or(&[]).iter().filter(|ce| in_ceiling(ce, x, y)).map(|ce| p.ceiling_vertical_extent(ce)).filter(|(a, b)| a.is_finite() && b.is_finite()).collect();
    let floor_z = over.iter().map(|e| e.1).filter(|t| *t >= base - 0.3 && *t <= base + 0.5).fold(f64::NAN, f64::max);
    let floor_z = if floor_z.is_finite() { floor_z } else { base };
    let ceil_z = over.iter().map(|e| e.0).filter(|b| *b > floor_z + 1.0).fold(f64::NAN, f64::min);
    let ceil_z = if ceil_z.is_finite() { ceil_z } else { base + fh };
    let h = ceil_z - floor_z;
    if h.is_finite() && h > 0.5 {
        h
    } else {
        fh
    }
}

/// Fläche der Wand-Öffnungen (Tür, Fenster) am Raum: Öffnungen in Wänden des Geschosses, deren Prüfpunkt
/// neben der Wand (eine Seite) im Raum liegt.
pub fn opening_area(p: &Project, r: &Room) -> f64 {
    use crate::opening_schedule::{in_ring, side_points};
    let mut sum = 0.0;
    for o in p.openings.as_deref().unwrap_or(&[]) {
        if crate::opening_shape::is_surface_hosted(o) {
            continue;
        }
        let Some(w) = p.walls.iter().find(|w| w.id == o.host_wall_id && w.floor_id == r.floor_id) else { continue };
        let Some((a, b)) = side_points(p, w, o.position + o.width / 2.0) else { continue };
        if in_ring(a[0], a[1], &r.boundary) || in_ring(b[0], b[1], &r.boundary) {
            let area = o.width * o.height;
            if area.is_finite() && area > 0.0 {
                sum += area;
            }
        }
    }
    sum
}

/// Nassraum: aus der Nutzung, ohne Nutzung nach dem Namen (`plan::floor_finish::is_wet_name`).
pub fn is_wet(r: &Room) -> bool {
    match r.usage {
        Some(u) if u != RoomUsage::Unknown => u.is_wet(),
        _ => crate::plan::floor_finish::is_wet_name(r),
    }
}

/// Eine Zeile des Raumbuchs (JSON-Form: `RoomBookRow` in TS).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomBookRow {
    pub id: String,
    pub floor: String,
    pub floor_id: String,
    pub number: String,
    pub name: String,
    /// Nettofläche (m²) = Boden- und Deckenfläche.
    pub area: f64,
    pub perimeter: f64,
    pub clear_height: f64,
    /// Nutzungs-Kennung (`living` …), leer ohne Angabe.
    pub usage: String,
    pub wet: bool,
    /// Anzeigetexte (Material-Name oder Freitext), leer ohne Angabe.
    pub floor_finish: String,
    pub wall_finish: String,
    pub ceiling_finish: String,
    pub floor_build_up: String,
    /// Wandfläche netto: Umfang × lichte Höhe − Öffnungen (m²).
    pub wall_area: f64,
    pub opening_area: f64,
}

/// Menge einer Oberfläche: Fläche je Material/Freitext und Lage.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FinishQty {
    /// "floor", "wall" oder "ceiling".
    pub surface: &'static str,
    pub finish: String,
    pub area: f64,
    pub rooms: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomBook {
    pub rows: Vec<RoomBookRow>,
    pub quantities: Vec<FinishQty>,
}

/// Raumnummern natürlich vergleichen („1.2" vor „1.10").
fn natural_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    let split = |s: &str| -> Vec<(bool, String)> {
        let mut out: Vec<(bool, String)> = Vec::new();
        for ch in s.chars() {
            let d = ch.is_ascii_digit();
            match out.last_mut() {
                Some((k, t)) if *k == d => t.push(ch),
                _ => out.push((d, ch.to_string())),
            }
        }
        out
    };
    let (x, y) = (split(a), split(b));
    for (p, q) in x.iter().zip(y.iter()) {
        let o = match (p.0, q.0) {
            (true, true) => p.1.trim_start_matches('0').len().cmp(&q.1.trim_start_matches('0').len()).then_with(|| p.1.trim_start_matches('0').cmp(q.1.trim_start_matches('0'))),
            _ => p.1.cmp(&q.1),
        };
        if o != std::cmp::Ordering::Equal {
            return o;
        }
    }
    x.len().cmp(&y.len())
}

/// Raumbuch des Projekts: Zeilen je Geschoss (Ebenen-Reihenfolge), dann nach Raumnummer (natürlich,
/// Räume ohne Nummer in Dokumentreihenfolge danach); dazu die Mengen je Oberfläche und Material.
pub fn room_book(p: &Project) -> RoomBook {
    let mut rows = Vec::new();
    for r in p.rooms.as_deref().unwrap_or(&[]) {
        if r.boundary.len() < 3 {
            continue;
        }
        let ring: Vec<[f64; 2]> = r.boundary.iter().map(|v| [v.x, v.y]).collect();
        let ev = crate::room_area::evaluate(&ring, 0.0);
        let area = if ev.net.is_finite() { ev.net } else { 0.0 };
        let perimeter = if ev.perimeter.is_finite() { ev.perimeter } else { 0.0 };
        let h = clear_height(p, r);
        let open = opening_area(p, r);
        let number = r.stamp.as_ref().and_then(|s| s.number.as_deref()).map(str::trim).unwrap_or("").to_string();
        rows.push(RoomBookRow {
            id: r.id.clone(),
            floor: level_of(p, &r.floor_id).map_or(r.floor_id.clone(), |l| l.name.clone()),
            floor_id: r.floor_id.clone(),
            number,
            name: r.name.clone(),
            area,
            perimeter,
            clear_height: h,
            usage: r.usage.map(|u| u.key().to_string()).unwrap_or_default(),
            wet: is_wet(r),
            floor_finish: finish_label(p, r.floor_finish.as_deref()),
            wall_finish: finish_label(p, r.wall_finish.as_deref()),
            ceiling_finish: finish_label(p, r.ceiling_finish.as_deref()),
            floor_build_up: r.floor_build_up.as_deref().map(str::trim).unwrap_or("").to_string(),
            wall_area: (perimeter * h - open).max(0.0),
            opening_area: open,
        });
    }
    let level_index = |id: &str| p.drawing_levels.iter().position(|l| l.id == id).unwrap_or(usize::MAX);
    rows.sort_by(|a, b| {
        level_index(&a.floor_id).cmp(&level_index(&b.floor_id)).then_with(|| match (a.number.is_empty(), b.number.is_empty()) {
            (false, false) => natural_cmp(&a.number, &b.number),
            (true, false) => std::cmp::Ordering::Greater,
            (false, true) => std::cmp::Ordering::Less,
            (true, true) => std::cmp::Ordering::Equal,
        })
    });
    let mut quantities: Vec<FinishQty> = Vec::new();
    for surface in ["floor", "wall", "ceiling"] {
        for r in &rows {
            let (finish, area) = match surface {
                "floor" => (&r.floor_finish, r.area),
                "wall" => (&r.wall_finish, r.wall_area),
                _ => (&r.ceiling_finish, r.area),
            };
            if finish.is_empty() {
                continue;
            }
            match quantities.iter_mut().find(|q| q.surface == surface && &q.finish == finish) {
                Some(q) => {
                    q.area += area;
                    q.rooms += 1;
                }
                None => quantities.push(FinishQty { surface, finish: finish.clone(), area, rooms: 1 }),
            }
        }
    }
    RoomBook { rows, quantities }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(x: f64, y: f64) -> Vec2 {
        Vec2 { x, y }
    }

    /// Wohnen 0.15..2.85 × 0.15..3.85 (2.7 × 3.7), Bad 3.15..5.85 × 0.15..2.15 (2.7 × 2.0), Innenwand x = 3
    /// mit Tür 0.9 × 2.1 zwischen beiden; Südwand mit Fenster 1.2 × 1.4 am Wohnen. Geschoss 2.8 m.
    fn sample() -> Project {
        let wall = |id: &str, a: Vec2, b: Vec2| Wall { id: id.into(), floor_id: "eg".into(), start: a, end: b, wall_type_id: "wt".into(), height: 2.8, ..Default::default() };
        let room = |id: &str, name: &str, pts: Vec<Vec2>| Room { id: id.into(), floor_id: "eg".into(), name: name.into(), boundary: pts, ..Default::default() };
        Project {
            drawing_levels: vec![DrawingLevel { id: "eg".into(), name: "EG".into(), floor_height: Some(2.8), ..Default::default() }],
            wall_types: vec![WallType { id: "wt".into(), name: "W".into(), layers: vec![Layer { thickness: 0.3, ..Default::default() }], ..Default::default() }],
            components: vec![Component { id: "parkett".into(), name: "Parkett Eiche".into(), ..Default::default() }, Component { id: "fliese".into(), name: "Feinsteinzeug".into(), ..Default::default() }],
            walls: vec![wall("s", v(0.0, 0.0), v(6.0, 0.0)), wall("m", v(3.0, 0.0), v(3.0, 4.0))],
            rooms: Some(vec![
                Room { floor_finish: Some("parkett".into()), wall_finish: Some("Abrieb 1 mm, weiss".into()), ceiling_finish: Some("Weissputz".into()), usage: Some(RoomUsage::Living), stamp: Some(RoomStamp { number: Some("1.10".into()), name: "Wohnen".into(), ..Default::default() }), ..room("r1", "Wohnen", vec![v(0.15, 0.15), v(2.85, 0.15), v(2.85, 3.85), v(0.15, 3.85)]) },
                Room { floor_finish: Some("fliese".into()), wall_finish: Some("fliese".into()), ceiling_finish: Some("Weissputz".into()), usage: Some(RoomUsage::Bath), stamp: Some(RoomStamp { number: Some("1.2".into()), name: "Nasszelle".into(), ..Default::default() }), ..room("r2", "Nasszelle", vec![v(3.15, 0.15), v(5.85, 0.15), v(5.85, 2.15), v(3.15, 2.15)]) },
            ]),
            openings: Some(vec![
                Opening { id: "t1".into(), host_wall_id: "m".into(), kind: ElementKind::Door, position: 1.0, width: 0.9, height: 2.1, ..Default::default() },
                Opening { id: "f1".into(), host_wall_id: "s".into(), kind: ElementKind::Window, position: 1.0, width: 1.2, height: 1.4, sill_height: 0.9, ..Default::default() },
            ]),
            ..Default::default()
        }
    }

    #[test]
    fn modell_rundreise_und_alte_daten() {
        let p = sample();
        let j = serde_json::to_value(&p.rooms.as_ref().unwrap()[1]).unwrap();
        assert_eq!(j["usage"], "bath");
        assert_eq!(j["floorFinish"], "fliese");
        let back: Room = serde_json::from_value(j).unwrap();
        assert_eq!(back, p.rooms.as_ref().unwrap()[1]);
        // Ohne Felder: nichts geschrieben (Alt-Daten unverändert).
        let plain = serde_json::to_value(Room { id: "x".into(), ..Default::default() }).unwrap();
        for k in ["usage", "floorFinish", "wallFinish", "ceilingFinish", "floorBuildUp"] {
            assert!(plain.get(k).is_none(), "{k}");
        }
        // Unbekannte Nutzung bricht das Laden nicht.
        let r: Room = serde_json::from_value(serde_json::json!({"id": "y", "usage": "sauna"})).unwrap();
        assert_eq!(r.usage, Some(RoomUsage::Unknown));
    }

    #[test]
    fn nassraum_aus_nutzung_sonst_name() {
        let mut r = Room { name: "Nasszelle".into(), usage: Some(RoomUsage::Storage), ..Default::default() };
        assert!(!is_wet(&r), "Nutzung geht vor dem Namen");
        r.usage = Some(RoomUsage::Shower);
        r.name = "Raum 3".into();
        assert!(is_wet(&r));
        r.usage = None;
        assert!(!is_wet(&r));
        r.name = "Bad/WC".into();
        assert!(is_wet(&r), "Rückfall Name");
        for u in RoomUsage::ALL {
            assert_eq!(RoomUsage::from_key(u.key()), Some(u));
        }
    }

    #[test]
    fn zeilen_und_reihenfolge() {
        let b = room_book(&sample());
        let ids: Vec<&str> = b.rows.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids, vec!["r2", "r1"], "1.2 vor 1.10");
        let w = b.rows.iter().find(|r| r.id == "r1").unwrap();
        assert_eq!((w.floor.as_str(), w.number.as_str(), w.usage.as_str(), w.wet), ("EG", "1.10", "living", false));
        assert_eq!((w.floor_finish.as_str(), w.wall_finish.as_str(), w.ceiling_finish.as_str()), ("Parkett Eiche", "Abrieb 1 mm, weiss", "Weissputz"));
        let bad = b.rows.iter().find(|r| r.id == "r2").unwrap();
        assert!(bad.wet);
        assert_eq!(bad.floor_finish, "Feinsteinzeug");
    }

    #[test]
    fn mengen_boden_wand_decke() {
        let b = room_book(&sample());
        let w = b.rows.iter().find(|r| r.id == "r1").unwrap();
        assert!((w.area - 2.7 * 3.7).abs() < 1e-9);
        assert!((w.clear_height - 2.8).abs() < 1e-9);
        // Wohnen: Tür 0.9 × 2.1 und Fenster 1.2 × 1.4.
        assert!((w.opening_area - (0.9 * 2.1 + 1.2 * 1.4)).abs() < 1e-9, "{}", w.opening_area);
        assert!((w.wall_area - (2.0 * (2.7 + 3.7) * 2.8 - 0.9 * 2.1 - 1.2 * 1.4)).abs() < 1e-9);
        let bad = b.rows.iter().find(|r| r.id == "r2").unwrap();
        assert!((bad.wall_area - (2.0 * (2.7 + 2.0) * 2.8 - 0.9 * 2.1)).abs() < 1e-9, "{}", bad.wall_area);
        let q = |s: &str, f: &str| b.quantities.iter().find(|q| q.surface == s && q.finish == f).map(|q| (q.area, q.rooms));
        let (a, n) = q("floor", "Parkett Eiche").unwrap();
        assert!((a - 2.7 * 3.7).abs() < 1e-9 && n == 1);
        let (a, n) = q("ceiling", "Weissputz").unwrap();
        assert!((a - (2.7 * 3.7 + 2.7 * 2.0)).abs() < 1e-9 && n == 2);
        let (a, _) = q("wall", "Feinsteinzeug").unwrap();
        assert!((a - bad.wall_area).abs() < 1e-9);
        assert!(q("floor", "").is_none());
    }

    #[test]
    fn lichte_hoehe_aus_decken() {
        let mut p = sample();
        // Decke unter dem Raum (OK 0.0 + Belag 0.1 über Boden) und darüber (UK 2.6).
        let ce = |id: &str, bottom: f64, top: f64| -> Ceiling {
            serde_json::from_value(serde_json::json!({ "id": id, "type": "ceiling", "floorId": "eg", "categoryCode": "50",
                "outline": [{"x": 0, "y": 0}, {"x": 6, "y": 0}, {"x": 6, "y": 4}, {"x": 0, "y": 4}],
                "bottom": {"mode": "custom", "z": bottom}, "top": {"mode": "custom", "z": top} })).unwrap()
        };
        p.ceilings = Some(vec![ce("unten", -0.25, 0.1), ce("oben", 2.6, 2.8)]);
        let r = &p.rooms.as_ref().unwrap()[0];
        assert_eq!(p.ceiling_vertical_extent(&p.ceilings.as_ref().unwrap()[0]), (-0.25, 0.1));
        assert!((clear_height(&p, r) - 2.5).abs() < 1e-9, "{}", clear_height(&p, r));
        assert!(clear_height(&Project::default(), &Room::default()) > 0.0);
    }

    #[test]
    fn leeres_projekt_und_unsinn() {
        assert!(room_book(&Project::default()).rows.is_empty());
        let mut p = sample();
        p.rooms.as_mut().unwrap()[0].boundary = vec![v(f64::NAN, 0.0), v(1.0, f64::INFINITY), v(0.0, 1.0)];
        let b = room_book(&p);
        assert!(b.rows.iter().all(|r| r.area.is_finite() && r.wall_area.is_finite()));
    }

    #[test]
    fn natuerliche_nummern() {
        use std::cmp::Ordering::*;
        assert_eq!(natural_cmp("1.2", "1.10"), Less);
        assert_eq!(natural_cmp("E01", "E1"), Equal);
        assert_eq!(natural_cmp("2.01", "10.01"), Less);
    }
}
