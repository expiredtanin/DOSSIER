//! Fenster- und Türliste ([97]): eine Zeile je Öffnung mit Nummer, Typ, Geschoss, angrenzenden Räumen
//! (aus den Raum-Umrissen), Rohbau- und lichtem Mass, Brüstung, Aufschlag, Brandschutz, Schallschutz,
//! U-Wert, Einbruchhemmung, aussen/innen und Bemerkung. Die Tabelle wird im Kern gerechnet; CSV, SVG und
//! PDF formatiert die TS-Seite über das allgemeine Berichtsmodell (`export/openingSchedule.ts`).

use crate::jsmath::hypot2;
use crate::model::*;
use serde::Serialize;
use std::collections::HashMap;

/// Eine Zeile der Fenster-/Türliste (JSON-Form: `OpeningScheduleRow` in TS).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpeningScheduleRow {
    /// "door" oder "window".
    pub kind: &'static str,
    pub id: String,
    /// Wirt: Wand, bzw. Dach/Decke bei Dach-/Deckenfenstern ([103], dann `host_kind`).
    pub wall_id: String,
    /// "wall", "roof" oder "ceiling".
    pub host_kind: &'static str,
    /// Nummer: eingetragene oder automatische.
    pub mark: String,
    pub mark_auto: bool,
    pub type_name: String,
    pub floor: String,
    pub floor_id: String,
    /// Räume beidseits der Wand (links/rechts der Wandrichtung), `None` = kein Raum.
    pub room_left: Option<String>,
    pub room_right: Option<String>,
    /// Rohbaumass (Öffnung in der Wand), Meter.
    pub width: f64,
    pub height: f64,
    /// Lichtes Mass (Tür: abzüglich Rahmen), Meter.
    pub clear_width: f64,
    pub clear_height: f64,
    pub sill: f64,
    /// Nur Türen: "start"/"end" (Band), "left"/"right" (Aufschlag), "in"/"out".
    pub hinge: Option<&'static str>,
    pub swing: Option<&'static str>,
    pub dir: Option<&'static str>,
    pub fire_rating: String,
    pub sound_class: String,
    pub u_value: Option<f64>,
    pub burglary_class: String,
    /// Aussen (true) / innen (false); `None` = nicht bestimmbar.
    pub external: Option<bool>,
    pub notes: String,
}

fn in_ring(x: f64, y: f64, ring: &[Vec2]) -> bool {
    let mut inside = false;
    let mut j = ring.len().wrapping_sub(1);
    for i in 0..ring.len() {
        let (a, b) = (&ring[i], &ring[j]);
        if (a.y > y) != (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x {
            inside = !inside;
        }
        j = i;
    }
    inside
}

fn room_label(r: &Room) -> String {
    match r.stamp.as_ref().and_then(|s| s.number.as_deref()).filter(|n| !n.is_empty()) {
        Some(n) => format!("{n} {}", r.name),
        None => r.name.clone(),
    }
}

fn room_at(p: &Project, floor_id: &str, x: f64, y: f64) -> Option<String> {
    p.rooms.as_deref().unwrap_or(&[]).iter().find(|r| r.floor_id == floor_id && in_ring(x, y, &r.boundary)).map(room_label)
}

/// Räume links/rechts der Wand an der Achsposition `at` (Meter ab Wandanfang).
fn rooms_beside(p: &Project, w: &Wall, at: f64) -> (Option<String>, Option<String>) {
    let (dx, dy) = (w.end.x - w.start.x, w.end.y - w.start.y);
    let len = hypot2(dx, dy);
    if !(len > 1e-9) {
        return (None, None);
    }
    let (ux, uy) = (dx / len, dy / len);
    let (px, py) = (w.start.x + ux * at, w.start.y + uy * at);
    let (nx, ny) = (-uy, ux);
    let d = Project::type_thickness(&p.wall_type_or_fallback(w).layers) + 0.1;
    (room_at(p, &w.floor_id, px + nx * d, py + ny * d), room_at(p, &w.floor_id, px - nx * d, py - ny * d))
}

fn has_rooms(p: &Project, floor_id: &str) -> bool {
    p.rooms.as_deref().unwrap_or(&[]).iter().any(|r| r.floor_id == floor_id)
}

/// Aussen/innen einer Öffnung: eigene Angabe, sonst die der Wand, sonst aus den Räumen (Raum auf nur
/// einer Seite = Aussenwand; kein Raum auf beiden Seiten oder keine Räume im Geschoss = unbekannt).
fn external_of(p: &Project, o: &Opening, w: &Wall, rooms: &(Option<String>, Option<String>)) -> Option<bool> {
    if let Some(e) = o.is_external.or(w.is_external) {
        return Some(e);
    }
    if !has_rooms(p, &w.floor_id) {
        return None;
    }
    match (rooms.0.is_some(), rooms.1.is_some()) {
        (false, false) => None,
        (a, b) => Some(a != b),
    }
}

/// Aussen/innen für das IFC-Pset (gleiche Regel wie die Liste).
pub fn opening_external(p: &Project, o: &Opening) -> Option<bool> {
    let w = p.walls.iter().find(|w| w.id == o.host_wall_id)?;
    external_of(p, o, w, &rooms_beside(p, w, o.position + o.width / 2.0))
}

fn nz(s: &Option<String>) -> String {
    s.as_deref().map(str::trim).unwrap_or("").to_string()
}

/// Dach-/Deckenfenster ([103]): Geschoss und Raum vom Wirt (Raum unter dem Mittelpunkt), Dach = aussen.
fn surface_row(p: &Project, o: &Opening) -> Option<OpeningScheduleRow> {
    if !crate::opening_shape::is_surface_hosted(o) {
        return None;
    }
    let hp = o.host_point?;
    let (host_kind, host_id, floor_id, external) = if let Some(id) = o.host_roof_id.as_deref().filter(|s| !s.is_empty()) {
        let r = p.roofs.as_deref()?.iter().find(|r| r.id == id)?;
        ("roof", r.id.clone(), r.floor_id.clone(), Some(true))
    } else {
        let id = o.host_ceiling_id.as_deref()?;
        let c = p.ceilings.as_deref()?.iter().find(|c| c.id == id)?;
        ("ceiling", c.id.clone(), c.floor_id.clone(), c.is_external)
    };
    let is_door = o.kind != ElementKind::Window;
    let type_name = if is_door { p.door_type(o).map(|t| t.name.clone()) } else { p.window_type(o).map(|t| t.name.clone()) }.unwrap_or_default();
    Some(OpeningScheduleRow {
        kind: if is_door { "door" } else { "window" },
        id: o.id.clone(),
        wall_id: host_id,
        host_kind,
        mark: nz(&o.mark),
        mark_auto: false,
        type_name,
        floor: p.floor(&floor_id).map_or(floor_id.clone(), |f| f.name.clone()),
        room_left: room_at(p, &floor_id, hp.x, hp.y),
        room_right: None,
        floor_id,
        width: o.width,
        height: o.height,
        clear_width: o.width,
        clear_height: o.height,
        sill: 0.0,
        hinge: None,
        swing: None,
        dir: None,
        fire_rating: nz(&o.fire_rating),
        sound_class: nz(&o.sound_class),
        u_value: o.u_value.filter(|u| *u > 0.0),
        burglary_class: nz(&o.burglary_class),
        external: o.is_external.or(external),
        notes: nz(&o.notes),
    })
}

/// Alle Fenster und Türen als Tabelle: je Geschoss (Reihenfolge der Ebenen), Fenster vor Türen, dann
/// Dokumentreihenfolge. Öffnungen ohne Wirtswand fehlen.
pub fn opening_schedule(p: &Project) -> Vec<OpeningScheduleRow> {
    let mut rows = Vec::new();
    for o in p.openings.as_deref().unwrap_or(&[]) {
        if let Some(r) = surface_row(p, o) {
            rows.push(r);
            continue;
        }
        let Some(w) = p.walls.iter().find(|w| w.id == o.host_wall_id) else { continue };
        let is_door = o.kind != ElementKind::Window;
        let rooms = rooms_beside(p, w, o.position + o.width / 2.0);
        let (type_name, frame) = if is_door {
            match p.door_type(o) {
                Some(t) => (t.name.clone(), o.frame_thickness.unwrap_or(t.frame_thickness)),
                None => (String::new(), o.frame_thickness.unwrap_or(0.0)),
            }
        } else {
            (p.window_type(o).map(|t| t.name.clone()).unwrap_or_default(), 0.0)
        };
        let (hinge, swing, dir) = if is_door && o.door_type != Some(OpeningDoorType::Wandoeffnung) {
            (
                Some(if o.hinge == Some(OpeningHinge::End) { "end" } else { "start" }),
                Some(if o.swing == Some(SwingSide::Right) { "right" } else { "left" }),
                Some(if o.opening_dir == Some(OpeningOpeningDir::Out) { "out" } else { "in" }),
            )
        } else {
            (None, None, None)
        };
        rows.push(OpeningScheduleRow {
            kind: if is_door { "door" } else { "window" },
            id: o.id.clone(),
            wall_id: w.id.clone(),
            host_kind: "wall",
            mark: nz(&o.mark),
            mark_auto: false,
            type_name,
            floor: p.floor(&w.floor_id).map_or(w.floor_id.clone(), |f| f.name.clone()),
            floor_id: w.floor_id.clone(),
            external: external_of(p, o, w, &rooms),
            room_left: rooms.0,
            room_right: rooms.1,
            width: o.width,
            height: o.height,
            clear_width: if is_door { (o.width - 2.0 * frame).max(0.0) } else { o.width },
            clear_height: if is_door { (o.height - frame).max(0.0) } else { o.height },
            sill: o.sill_height,
            hinge,
            swing,
            dir,
            fire_rating: nz(&o.fire_rating),
            sound_class: nz(&o.sound_class),
            u_value: o.u_value.filter(|u| *u > 0.0),
            burglary_class: nz(&o.burglary_class),
            notes: nz(&o.notes),
        });
    }
    // Reihenfolge: Geschoss (Ebenen-Reihenfolge, unbekannte zuletzt), Fenster vor Türen, Dokument.
    let level_index = |id: &str| p.drawing_levels.iter().position(|l| l.id == id).unwrap_or(usize::MAX);
    rows.sort_by_key(|r| (level_index(&r.floor_id), r.kind == "door"));
    // Automatische Nummern: Präfix F/T + Geschoss-Nummer + laufende Zahl je Geschoss und Art.
    let mut count: HashMap<(String, &str), usize> = HashMap::new();
    for r in rows.iter_mut() {
        let n = count.entry((r.floor_id.clone(), r.kind)).or_insert(0);
        *n += 1;
        if r.mark.is_empty() {
            // Geschoss-Nummer unter den Geschossen (Schnitte/Ansichten zählen nicht).
            let lv = p.drawing_levels.iter().filter(|l| l.kind == DrawingLevelKind::Floor).position(|l| l.id == r.floor_id).map_or(0, |i| i + 1);
            r.mark = format!("{}{}.{:02}", if r.kind == "door" { "T" } else { "F" }, lv, n);
            r.mark_auto = true;
        }
    }
    rows
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(x: f64, y: f64) -> Vec2 {
        Vec2 { x, y }
    }

    fn sample() -> Project {
        let wall = |id: &str, a: Vec2, b: Vec2| Wall { id: id.into(), floor_id: "eg".into(), start: a, end: b, wall_type_id: "wt".into(), height: 2.6, ..Default::default() };
        let op = |id: &str, host: &str, kind: ElementKind, pos: f64| Opening { id: id.into(), host_wall_id: host.into(), kind, position: pos, width: 1.0, height: 2.1, ..Default::default() };
        let room = |id: &str, name: &str, pts: Vec<Vec2>| Room { id: id.into(), floor_id: "eg".into(), name: name.into(), boundary: pts, ..Default::default() };
        Project {
            drawing_levels: vec![DrawingLevel { id: "eg".into(), name: "EG".into(), ..Default::default() }, DrawingLevel { id: "og".into(), name: "OG".into(), ..Default::default() }],
            wall_types: vec![WallType { id: "wt".into(), name: "W".into(), layers: vec![Layer { thickness: 0.3, ..Default::default() }], ..Default::default() }],
            // Haus 0..6 × 0..4, Innenwand bei x = 3; Raum links "Wohnen", Raum rechts "Küche".
            walls: vec![wall("s", v(0.0, 0.0), v(6.0, 0.0)), wall("m", v(3.0, 0.0), v(3.0, 4.0))],
            rooms: Some(vec![
                room("r1", "Wohnen", vec![v(0.15, 0.15), v(2.85, 0.15), v(2.85, 3.85), v(0.15, 3.85)]),
                room("r2", "Küche", vec![v(3.15, 0.15), v(5.85, 0.15), v(5.85, 3.85), v(3.15, 3.85)]),
            ]),
            openings: Some(vec![
                op("t1", "m", ElementKind::Door, 1.0),
                op("f1", "s", ElementKind::Window, 1.0),
                Opening { mark: Some("T-Eingang".into()), fire_rating: Some(" EI30 ".into()), u_value: Some(1.3), ..op("t2", "s", ElementKind::Door, 4.0) },
            ]),
            ..Default::default()
        }
    }

    #[test]
    fn nummern_je_geschoss_fenster_vor_tueren() {
        let r = opening_schedule(&sample());
        let marks: Vec<_> = r.iter().map(|x| (x.id.as_str(), x.mark.as_str(), x.mark_auto)).collect();
        assert_eq!(marks, vec![("f1", "F1.01", true), ("t1", "T1.01", true), ("t2", "T-Eingang", false)]);
    }

    #[test]
    fn raeume_und_aussen_innen() {
        let r = opening_schedule(&sample());
        let t1 = r.iter().find(|x| x.id == "t1").unwrap();
        // Innenwand x = 3, Richtung +y: links (−x) = Wohnen, rechts = Küche.
        assert_eq!((t1.room_left.as_deref(), t1.room_right.as_deref()), (Some("Wohnen"), Some("Küche")));
        assert_eq!(t1.external, Some(false));
        // Südwand y = 0, Richtung +x: links (+y) liegt der Raum, rechts nichts → aussen.
        let f1 = r.iter().find(|x| x.id == "f1").unwrap();
        assert_eq!((f1.room_left.as_deref(), f1.room_right.as_deref()), (Some("Wohnen"), None));
        assert_eq!(f1.external, Some(true));
    }

    #[test]
    fn eigene_angaben_und_lichtes_mass() {
        let mut p = sample();
        p.openings.as_mut().unwrap()[0].is_external = Some(true);
        p.walls[0].is_external = Some(false);
        let r = opening_schedule(&p);
        assert_eq!(r.iter().find(|x| x.id == "t1").unwrap().external, Some(true));
        assert_eq!(r.iter().find(|x| x.id == "f1").unwrap().external, Some(false), "Wandangabe gilt");
        let t2 = r.iter().find(|x| x.id == "t2").unwrap();
        assert_eq!((t2.fire_rating.as_str(), t2.u_value), ("EI30", Some(1.3)));
        assert_eq!((t2.hinge, t2.swing, t2.dir), (Some("start"), Some("left"), Some("in")));
        // Ohne Räume im Geschoss: unbekannt.
        p.rooms = None;
        p.walls[0].is_external = None;
        assert_eq!(opening_schedule(&p).iter().find(|x| x.id == "f1").unwrap().external, None);
    }

    #[test]
    fn leeres_projekt() {
        assert!(opening_schedule(&Project::default()).is_empty());
    }

    /// [103] Dachfenster in der Liste: Wirt Dach, Geschoss des Dachs, aussen.
    #[test]
    fn dachfenster_in_der_liste() {
        let mut p = Project::default();
        p.drawing_levels.push(DrawingLevel { id: "dg".into(), name: "DG".into(), kind: DrawingLevelKind::Floor, ..Default::default() });
        p.roofs = Some(vec![Roof { id: "r".into(), floor_id: "dg".into(), ..Default::default() }]);
        p.openings = Some(vec![Opening { id: "df".into(), kind: ElementKind::Window, width: 0.78, height: 1.18, host_roof_id: Some("r".into()), host_point: Some(v(1.0, 1.0)), ..Default::default() }]);
        let rows = opening_schedule(&p);
        assert_eq!(rows.len(), 1);
        let r = &rows[0];
        assert_eq!((r.host_kind, r.wall_id.as_str(), r.floor.as_str(), r.external, r.mark.as_str()), ("roof", "r", "DG", Some(true), "F1.01"));
    }
}
