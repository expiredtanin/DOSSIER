//! [221] Standard-Schnitt und -Ansicht eines neuen Projekts folgen dem Gebäude.
//!
//! Ein leeres Projekt bringt „Schnitt A" und „Ansicht Süd" mit (`DrawingLevel::auto_line`). Ihre Linien lagen
//! früher fest am Nullpunkt (−1…6 m): bei einem Projekt in Landeskoordinaten oder einem Gebäude abseits des
//! Nullpunkts schnitt Schnitt A nichts, und „Einpassen" spannte den Plan vom Nullpunkt bis zum Gebäude auf.
//! Jetzt führt der Kern die Linien im selben Undo-Schritt wie die Benutzer-Änderung nach
//! ([`crate::document::Document::commit`], wie die assoziative Bemassung): Schnitt quer durch die Mitte des
//! Gebäudes, Ansicht davor, beide mit Rand. Ausmass: das Gebaute (Wände, Decken, Dächer, Stützen, Treppen,
//! Körper, Räume), ohne Gebautes die Parzelle des Baurechts; ohne beides (oder schmaler als 1 m, etwa eine einzelne Wand) bleiben
//! die Linien, wo sie sind.
//!
//! Die Richtung der Linie (und damit die Blickrichtung `directionSign`) bleibt, nur die Lage wird nachgeführt.
//! Sobald die Linie bearbeitet wird (Endpunkte, Knicke, Blickrichtung), fällt das Kennzeichen weg — von da an
//! gehört die Linie dem Menschen.

use crate::model::{DrawingLevelKind, Project, Vec2};
use crate::ops::Op;
use serde_json::{Map, Value};

/// Sammlungen, deren Änderung das Ausmass verschieben kann.
const SOURCES: [&str; 8] = ["walls", "ceilings", "roofs", "columns", "stairs", "extrudedSolids", "rooms", "siteRules"];

/// Was eine Benutzer-Änderung für die automatischen Linien bedeutet (vor dem Anwenden ermittelt).
#[derive(Debug, Default)]
pub struct Touch {
    /// Die Änderung betrifft das Gebaute oder die Parzelle.
    pub extent: bool,
    /// Automatische Linien, die der Mensch bearbeitet hat (Kennzeichen löschen).
    pub edited: Vec<String>,
}

impl Touch {
    pub fn any(&self) -> bool {
        self.extent || !self.edited.is_empty()
    }
}

fn is_auto(level: &Value) -> bool {
    level.get("autoLine").and_then(Value::as_bool) == Some(true)
}

/// Prüft die Benutzer-Ops gegen den Stand `root` vor dem Anwenden. Ohne automatische Linie im Projekt leer.
pub fn touch(root: &Map<String, Value>, ops: &[Op]) -> Touch {
    let levels = root.get("drawingLevels").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]);
    if !levels.iter().any(is_auto) {
        return Touch::default();
    }
    let mut t = Touch::default();
    for op in ops {
        let key = op.key();
        if SOURCES.contains(&key) {
            t.extent = true;
        }
        if let Op::Replace { collection, entity } = op {
            if collection != "drawingLevels" {
                continue;
            }
            let Some(id) = entity.get("id").and_then(Value::as_str) else { continue };
            let Some(old) = levels.iter().find(|l| l.get("id").and_then(Value::as_str) == Some(id)) else { continue };
            if !is_auto(old) || !is_auto(entity) {
                continue;
            }
            let changed = ["linePoints", "bendPoints", "directionSign"].iter().any(|k| old.get(*k) != entity.get(*k));
            if changed {
                t.edited.push(id.to_string());
            }
        }
    }
    t
}

/// Kasten um Punkte; `None` ohne endliche Punkte.
fn bbox<'a>(pts: impl IntoIterator<Item = &'a Vec2>) -> Option<[f64; 4]> {
    let mut b = [f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY];
    for q in pts.into_iter().filter(|q| q.x.is_finite() && q.y.is_finite()) {
        b = [b[0].min(q.x), b[1].min(q.y), b[2].max(q.x), b[3].max(q.y)];
    }
    b[0].is_finite().then_some(b)
}

/// Alle Stützpunkte des Gebauten (Wände, Decken, Dächer, Stützen, Treppen, Räume, Körper; ohne Kontext und Gelände).
pub fn built_points(p: &Project) -> Vec<Vec2> {
    let mut pts: Vec<Vec2> = Vec::new();
    for w in &p.walls {
        pts.extend([w.start, w.end]);
    }
    pts.extend(p.ceilings.iter().flatten().flat_map(|c| c.outline.iter().copied()));
    pts.extend(p.roofs.iter().flatten().flat_map(|r| r.outline.iter().copied()));
    pts.extend(p.columns.iter().flatten().map(|c| c.position));
    pts.extend(p.stairs.iter().flatten().map(|s| s.start));
    pts.extend(p.rooms.iter().flatten().flat_map(|r| r.boundary.iter().copied()));
    for s in p.extruded_solids.iter().flatten() {
        match &s.circle {
            Some(c) => pts.extend([Vec2 { x: c.center.x - c.r, y: c.center.y - c.r }, Vec2 { x: c.center.x + c.r, y: c.center.y + c.r }]),
            None => pts.extend(s.points.iter().copied()),
        }
    }
    pts
}

/// Ausmass [x0, y0, x1, y1] des Gebauten, ohne Gebautes der Parzelle; `None` ohne beides.
pub fn extent(p: &Project) -> Option<[f64; 4]> {
    let pts = built_points(p);
    // Erst eine Fläche zählt (≥ 1 m in beiden Richtungen): eine einzelne Wand ergäbe einen Schnitt genau auf ihrer Achse.
    let areal = |b: &[f64; 4]| b[2] - b[0] >= MIN_SIZE && b[3] - b[1] >= MIN_SIZE;
    bbox(&pts).filter(areal).or_else(|| bbox(p.site_rules.iter().flat_map(|r| &r.parcel)).filter(areal))
}

/// [266] Mindestabstand (m) des automatischen Schnitts von einer parallelen Wandachse, Suchschritt (m) und
/// grösster Sinus des Winkels, bis zu dem eine Wand als parallel gilt (≈ 6°).
const AXIS_CLEARANCE: f64 = 0.5;
const AXIS_STEP: f64 = 0.25;
const PARALLEL_SIN: f64 = 0.1;

/// Kleinste Ausdehnung (m) des Ausmasses in beiden Richtungen, ab der die Linien nachgeführt werden.
const MIN_SIZE: f64 = 1.0;

/// Linie einer automatischen Ebene für das Ausmass `b`: Richtung und Blickrichtung wie `line`, Schnitt durch die
/// Mitte, Ansicht vor dem Ausmass (gegen die Blickrichtung), beide mit Rand über das Ausmass hinaus.
///
/// [266] `axes`: Wandachsen des Projekts. Der Schnitt weicht von der Mitte soweit aus, bis er keiner zu ihm
/// (fast) parallelen Wandachse näher als [`AXIS_CLEARANCE`] liegt: sonst schneidet er die Wand der Länge nach (schwarze
/// Fläche im Schnitt). Gibt es keinen freien Platz, bleibt er in der Mitte.
pub fn place(kind: DrawingLevelKind, line: [Vec2; 2], sign: f64, b: [f64; 4], axes: &[[Vec2; 2]]) -> Option<[Vec2; 2]> {
    let (dx, dy) = (line[1].x - line[0].x, line[1].y - line[0].y);
    let len = dx.hypot(dy);
    if !(len > 1e-9) || !b.iter().all(|v| v.is_finite()) {
        return None;
    }
    let d = (dx / len, dy / len);
    // Blickrichtung: Links-Normale, mit `directionSign` gedreht (wie `plan::underlay::section_map`).
    let n = (-d.1 * sign, d.0 * sign);
    let corners = [(b[0], b[1]), (b[2], b[1]), (b[2], b[3]), (b[0], b[3])];
    let along = |c: &(f64, f64)| c.0 * d.0 + c.1 * d.1;
    let across = |c: &(f64, f64)| c.0 * n.0 + c.1 * n.1;
    let (s0, s1) = corners.iter().map(along).fold((f64::INFINITY, f64::NEG_INFINITY), |(a, z), v| (a.min(v), z.max(v)));
    let (t0, t1) = corners.iter().map(across).fold((f64::INFINITY, f64::NEG_INFINITY), |(a, z), v| (a.min(v), z.max(v)));
    let margin = 2.0f64.max(0.1 * (s1 - s0).max(t1 - t0));
    // Quer-Koordinaten (Richtung `n`) der zur Linie parallelen Wandachsen.
    let parallel: Vec<f64> = axes
        .iter()
        .filter_map(|a| {
            let (wx, wy) = (a[1].x - a[0].x, a[1].y - a[0].y);
            let wl = wx.hypot(wy);
            if !(wl > 1e-6) || (wx * d.1 - wy * d.0).abs() / wl > PARALLEL_SIN {
                return None;
            }
            Some(a[0].x * n.0 + a[0].y * n.1)
        })
        .collect();
    let clear = |t: f64| parallel.iter().all(|c| (c - t).abs() >= AXIS_CLEARANCE);
    let mid = (t0 + t1) / 2.0;
    let section_t = || {
        let steps = ((t1 - t0) * 0.45 / AXIS_STEP).floor() as i32;
        (0..=steps).flat_map(|k| [mid + k as f64 * AXIS_STEP, mid - k as f64 * AXIS_STEP]).find(|t| clear(*t)).unwrap_or(mid)
    };
    let t = match kind {
        DrawingLevelKind::Section => section_t(),
        DrawingLevelKind::Elevation => t0 - margin,
        _ => return None,
    };
    let at = |s: f64| {
        let r = |v: f64| (v * 1000.0).round() / 1000.0;
        Vec2 { x: r(d.0 * s + n.0 * t), y: r(d.1 * s + n.1 * t) }
    };
    Some([at(s0 - margin), at(s1 + margin)])
}

/// Ops, die die automatischen Linien nachführen (nach dem Anwenden der Benutzer-Ops auf `p`, Stand `root`).
pub fn sync_ops(p: &Project, root: &Map<String, Value>, t: &Touch) -> Vec<Op> {
    let levels = root.get("drawingLevels").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]);
    let ext = if t.extent { extent(p) } else { None };
    let axes: Vec<[Vec2; 2]> = p.walls.iter().map(|w| [w.start, w.end]).collect();
    let mut out = Vec::new();
    for l in &p.drawing_levels {
        if l.auto_line != Some(true) || !matches!(l.kind, DrawingLevelKind::Section | DrawingLevelKind::Elevation) {
            continue;
        }
        let Some(raw) = levels.iter().find(|v| v.get("id").and_then(Value::as_str) == Some(l.id.as_str())).and_then(Value::as_object) else { continue };
        let mut e = raw.clone();
        if t.edited.contains(&l.id) {
            e.remove("autoLine");
        } else {
            let (Some(b), Some(line)) = (ext, l.line_points) else { continue };
            let Some(next) = place(l.kind, line, l.direction_sign.unwrap_or(1.0), b, &axes) else { continue };
            let same = line.iter().zip(&next).all(|(a, c)| (a.x - c.x).abs() < 1e-6 && (a.y - c.y).abs() < 1e-6);
            if same && l.bend_points.as_ref().is_none_or(Vec::is_empty) {
                continue;
            }
            let v = |q: &Vec2| serde_json::json!({"x": crate::json_util::js_num(q.x), "y": crate::json_util::js_num(q.y)});
            e.insert("linePoints".into(), Value::Array(next.iter().map(v).collect()));
            e.remove("bendPoints");
        }
        out.push(Op::Replace { collection: "drawingLevels".into(), entity: Value::Object(e) });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn root() -> Map<String, Value> {
        json!({
            "drawingLevels": [
                {"id": "eg", "name": "EG", "kind": "floor", "visible": true, "locked": false, "floorHeight": 2.6, "baseElevation": 0},
                {"id": "sa", "name": "Schnitt A", "kind": "section", "visible": true, "locked": false, "linePoints": [{"x": -1, "y": 2}, {"x": 6, "y": 2}], "directionSign": 1, "autoLine": true},
                {"id": "as", "name": "Ansicht Süd", "kind": "elevation", "visible": true, "locked": false, "linePoints": [{"x": -1, "y": -2}, {"x": 6, "y": -2}], "directionSign": 1, "autoLine": true}
            ],
            "walls": []
        })
        .as_object()
        .unwrap()
        .clone()
    }

    fn wall(x0: f64, y0: f64, x1: f64, y1: f64) -> Value {
        json!({"id": format!("w{x0}{y0}"), "type": "wall", "floorId": "eg", "categoryCode": "20", "start": {"x": x0, "y": y0}, "end": {"x": x1, "y": y1}, "wallTypeId": "aw", "height": 2.6})
    }

    #[test]
    fn schnitt_durch_die_mitte_ansicht_davor() {
        let b = [48.0, 46.0, 60.0, 56.0];
        let line = [Vec2 { x: -1.0, y: 2.0 }, Vec2 { x: 6.0, y: 2.0 }];
        let s = place(DrawingLevelKind::Section, line, 1.0, b, &[]).unwrap();
        assert_eq!(s, [Vec2 { x: 46.0, y: 51.0 }, Vec2 { x: 62.0, y: 51.0 }]);
        let e = place(DrawingLevelKind::Elevation, line, 1.0, b, &[]).unwrap();
        // Blick nach +y (Norden): Linie südlich des Gebäudes.
        assert_eq!(e, [Vec2 { x: 46.0, y: 44.0 }, Vec2 { x: 62.0, y: 44.0 }]);
        // Umgekehrte Blickrichtung: Linie auf der anderen Seite.
        let n = place(DrawingLevelKind::Elevation, line, -1.0, b, &[]).unwrap();
        assert_eq!(n[0].y, 58.0);
        assert!(place(DrawingLevelKind::Floor, line, 1.0, b, &[]).is_none());
        assert!(place(DrawingLevelKind::Section, [line[0], line[0]], 1.0, b, &[]).is_none());
        assert!(place(DrawingLevelKind::Section, line, 1.0, [f64::NAN, 0.0, 1.0, 1.0], &[]).is_none());
    }

    /// [266] Liegt die Mitte auf der Achse einer parallelen Innenwand, rückt der Schnitt zur Seite (nicht auf die Achse).
    #[test]
    fn schnitt_meidet_wandachsen() {
        let b = [48.0, 46.0, 60.0, 56.0];
        let line = [Vec2 { x: -1.0, y: 2.0 }, Vec2 { x: 6.0, y: 2.0 }];
        let ax = |y: f64| [Vec2 { x: 48.0, y }, Vec2 { x: 60.0, y }];
        let y_of = |axes: &[[Vec2; 2]]| place(DrawingLevelKind::Section, line, 1.0, b, axes).unwrap()[0].y;
        assert_eq!(y_of(&[]), 51.0);
        let y = y_of(&[ax(51.0)]);
        assert!((y - 51.0).abs() >= 0.5 && (y - 51.0).abs() <= 1.0, "{y}");
        // Senkrechte Wände zählen nicht; zwei Achsen beidseits: weiter ausweichen.
        assert_eq!(y_of(&[[Vec2 { x: 51.0, y: 46.0 }, Vec2 { x: 51.0, y: 56.0 }]]), 51.0);
        let y = y_of(&[ax(51.0), ax(51.25), ax(50.75)]);
        assert!(![51.0, 51.25, 50.75].iter().any(|c| (c - y).abs() < 0.5), "{y}");
        assert!(place(DrawingLevelKind::Elevation, line, 1.0, b, &[ax(44.0)]).unwrap()[0].y == 44.0);
    }

    #[test]
    fn linien_folgen_dem_gebaeude_im_selben_undo_schritt() {
        let mut d = crate::document::Document::from_json(&Value::Object(root()).to_string()).unwrap();
        let walls = vec![wall(48.0, 46.0, 60.0, 46.0), wall(60.0, 46.0, 60.0, 56.0)];
        d.commit(vec![Op::Add { collection: "walls".into(), items: walls, at: None }], None, 0.0, false).unwrap();
        let lv = |d: &crate::document::Document, id: &str| d.root()["drawingLevels"].as_array().unwrap().iter().find(|l| l["id"] == id).unwrap().clone();
        assert_eq!(lv(&d, "sa")["linePoints"], json!([{"x": 46, "y": 51}, {"x": 62, "y": 51}]));
        assert_eq!(lv(&d, "as")["linePoints"], json!([{"x": 46, "y": 44}, {"x": 62, "y": 44}]));
        assert_eq!(d.last_extra().len(), 2);
        // Rückgängig: Wände und Linien in einem Schritt.
        d.undo().unwrap();
        assert_eq!(lv(&d, "sa")["linePoints"], json!([{"x": -1, "y": 2}, {"x": 6, "y": 2}]));
        assert!(d.root()["walls"].as_array().unwrap().is_empty());
    }

    #[test]
    fn bearbeitete_linie_bleibt_stehen() {
        let mut d = crate::document::Document::from_json(&Value::Object(root()).to_string()).unwrap();
        let mut sa = d.root()["drawingLevels"][1].clone();
        sa["linePoints"] = json!([{"x": 0, "y": 0}, {"x": 0, "y": 9}]);
        d.commit(vec![Op::Replace { collection: "drawingLevels".into(), entity: sa }], None, 0.0, false).unwrap();
        let sa = d.root()["drawingLevels"][1].clone();
        assert!(sa.get("autoLine").is_none(), "Kennzeichen weg: {sa}");
        assert_eq!(sa["linePoints"], json!([{"x": 0, "y": 0}, {"x": 0, "y": 9}]));
        d.commit(vec![Op::Add { collection: "walls".into(), items: vec![wall(48.0, 46.0, 60.0, 46.0), wall(60.0, 46.0, 60.0, 56.0)], at: None }], None, 0.0, false).unwrap();
        assert_eq!(d.root()["drawingLevels"][1]["linePoints"], json!([{"x": 0, "y": 0}, {"x": 0, "y": 9}]));
        // Die Ansicht folgt weiter; Umbenennen löscht das Kennzeichen nicht.
        assert_eq!(d.root()["drawingLevels"][2]["linePoints"][0]["y"], json!(44));
        let mut a = d.root()["drawingLevels"][2].clone();
        a["name"] = json!("Ansicht S");
        d.commit(vec![Op::Replace { collection: "drawingLevels".into(), entity: a }], None, 0.0, false).unwrap();
        assert_eq!(d.root()["drawingLevels"][2]["autoLine"], json!(true));
    }

    #[test]
    fn ohne_gebaeude_die_parzelle_ohne_beides_nichts() {
        let mut d = crate::document::Document::from_json(&Value::Object(root()).to_string()).unwrap();
        d.commit(vec![Op::Add { collection: "drawings2d".into(), items: vec![], at: None }], None, 0.0, false).unwrap();
        assert!(d.last_extra().is_empty());
        let parcel = json!({"parcel": [{"x": 38, "y": 38}, {"x": 68, "y": 38}, {"x": 68, "y": 68}, {"x": 38, "y": 68}], "defaultSetback": 4});
        d.commit(vec![Op::SetField { key: "siteRules".into(), value: Some(parcel), at: None }], None, 0.0, false).unwrap();
        assert_eq!(d.root()["drawingLevels"][1]["linePoints"], json!([{"x": 35, "y": 53}, {"x": 71, "y": 53}]));
    }

    #[test]
    fn einzelne_wand_verschiebt_nichts() {
        let mut d = crate::document::Document::from_json(&Value::Object(root()).to_string()).unwrap();
        d.commit(vec![Op::Add { collection: "walls".into(), items: vec![wall(0.0, 0.0, 5.0, 0.0)], at: None }], None, 0.0, false).unwrap();
        assert!(d.last_extra().is_empty());
        assert_eq!(d.root()["drawingLevels"][1]["linePoints"], json!([{"x": -1, "y": 2}, {"x": 6, "y": 2}]));
    }

    #[test]
    fn ohne_automatische_linien_keine_ops() {
        let mut r = root();
        for l in r.get_mut("drawingLevels").unwrap().as_array_mut().unwrap() {
            l.as_object_mut().unwrap().remove("autoLine");
        }
        let t = touch(&r, &[Op::Add { collection: "walls".into(), items: vec![], at: None }]);
        assert!(!t.any());
    }
}
