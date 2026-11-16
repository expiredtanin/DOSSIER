//! [267] Ansichten aller Seiten in einem Schritt: um das Gebaute (Wände, Decken, Dächer, Stützen, Treppen,
//! Räume, Körper — nicht Kontext und Gelände) werden vier Ansichtslinien gelegt, je eine vor jeder Fassade.
//!
//! **Hauptrichtung:** das minimal umschliessende Rechteck der konvexen Hülle (über die Hüllkanten); bei gleicher
//! Fläche gewinnt die Lage nächst der Achsparallelen. Die Richtung wird auf [−45°, 45°) gefaltet, weil das
//! Rechteck und seine Drehung um 90° dieselben vier Fassadenrichtungen ergeben; unter 0.5° Abweichung gilt das
//! Haus als achsparallel (kein Schiefstand durch Zeichenungenauigkeit).
//!
//! **Namen:** Der Kern kennt keinen Nordwinkel (Plan oben = Norden, wie „Ansicht Süd" der Vorlage: Linie südlich
//! des Hauses, Blick nach +y). Eine Fassade heisst nach der nächsten der vier Himmelsrichtungen ihrer
//! Aussennormalen. Weil die vier Normalen 90° auseinander liegen, ist die Zuordnung eindeutig; „Nordost" u. ä.
//! entstehen nie (bei schräger Lage heisst die Fassade nach der nächsten Hauptrichtung).
//!
//! **Vorhandene Ansichten:** eine Ansicht (Art „elevation" mit Linie), deren Blickrichtung weniger als 45° von der
//! neuen abweicht, zählt als diese Seite und wird nicht doppelt angelegt.
//!
//! **Linie:** parallel zur Fassade, aus Sicht des Betrachters von links nach rechts (wie „Ansicht Süd"), um den
//! Rand (mind. 2 m, sonst 10 % der grösseren Ausdehnung) vor der Fassade und über deren Enden hinaus.

use crate::auto_lines::built_points;
use crate::cmd_create::{add_op, obj, pv, s};
use crate::cmd_transform::IdGen;
use crate::json_util::{arr, field, js_num};
use crate::model::Project;
use crate::ops::Op;
use serde_json::{json, Map, Value};

type V = (f64, f64);

/// Seiten nach Index der Aussennormalen `u` gedreht um k·90°: 0 = Ost, 1 = Nord, 2 = West, 3 = Süd.
const SIDES: [&str; 4] = ["east", "north", "west", "south"];
/// Anlege-Reihenfolge (Nord, Ost, Süd, West).
const ORDER: [usize; 4] = [1, 0, 3, 2];
/// Kleinste Ausdehnung des Gebäudes (m) je Richtung.
const MIN_SIZE: f64 = 1.0;

/// Hauptrichtung `u` (Einheitsvektor im Bereich [−45°, 45°)) und Ausdehnung `[u0, u1, v0, v1]` des umschliessenden
/// Rechtecks (v = u um 90° gedreht).
fn main_frame(pts: &[V]) -> Option<(V, [f64; 4])> {
    let flat: Vec<[f64; 2]> = pts.iter().map(|q| [q.0, q.1]).filter(|q| q[0].is_finite() && q[1].is_finite()).collect();
    let hull = crate::sun::hull(&flat);
    if hull.len() < 3 {
        return None;
    }
    let frame = |u: V| -> [f64; 4] {
        let v = (-u.1, u.0);
        let mut r = [f64::INFINITY, f64::NEG_INFINITY, f64::INFINITY, f64::NEG_INFINITY];
        for q in &hull {
            let (a, b) = (q[0] * u.0 + q[1] * u.1, q[0] * v.0 + q[1] * v.1);
            r = [r[0].min(a), r[1].max(a), r[2].min(b), r[3].max(b)];
        }
        r
    };
    // Auf [−45°, 45°) falten: u um 90° drehen, bis −x ≤ y < x gilt; fast achsparallel → exakt (1, 0).
    let fold = |mut u: V| -> V {
        for _ in 0..4 {
            if u.1 < u.0 - 1e-12 && u.1 >= -u.0 - 1e-12 {
                break;
            }
            u = (-u.1, u.0);
        }
        if u.1.abs() < 0.008_726_6 {
            return (1.0, 0.0);
        }
        u
    };
    let mut best: Option<(f64, V, [f64; 4])> = None;
    for i in 0..hull.len() {
        let (a, b) = (hull[i], hull[(i + 1) % hull.len()]);
        let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
        let len = dx.hypot(dy);
        if !(len > 1e-9) {
            continue;
        }
        let u = fold((dx / len, dy / len));
        let r = frame(u);
        let area = (r[1] - r[0]) * (r[3] - r[2]);
        let tol = 1e-9 * area.max(1.0);
        // Gleiche Fläche (mehrere Kanten umschliessen gleich gut): die achsnähere Lage gewinnt.
        let better = match &best {
            None => true,
            Some((ba, bu, _)) => area < ba - tol || (area <= ba + tol && u.1.abs() < bu.1.abs() - 1e-9),
        };
        if better {
            best = Some((area, u, r));
        }
    }
    let (_, u, r) = best?;
    ((r[1] - r[0] >= MIN_SIZE) && (r[3] - r[2] >= MIN_SIZE)).then_some((u, r))
}

/// Eine Ansicht einer Seite: Schlüssel (`east` …), Linie und Blickrichtung (Einheitsvektor, `directionSign` = 1).
#[derive(Debug, Clone, PartialEq)]
pub struct Side {
    pub key: &'static str,
    pub line: [V; 2],
    pub look: V,
}

/// Die vier Ansichten um die Punkte `pts` des Gebauten; `None` ohne Fläche (unter 1 m Ausdehnung).
pub fn sides(pts: &[V]) -> Option<Vec<Side>> {
    let (u, r) = main_frame(pts)?;
    let margin = 2.0f64.max(0.1 * (r[1] - r[0]).max(r[3] - r[2]));
    let corners: Vec<V> = [(r[0], r[2]), (r[1], r[2]), (r[1], r[3]), (r[0], r[3])]
        .iter()
        .map(|&(a, b)| (a * u.0 - b * u.1, a * u.1 + b * u.0))
        .collect();
    let proj = |q: &V, a: V| q.0 * a.0 + q.1 * a.1;
    let mut out = Vec::new();
    let mut n = u;
    for key in SIDES {
        // Blick nach innen; Linienrichtung d so, dass die Links-Normale (−dy, dx) die Blickrichtung ist.
        let look = (-n.0, -n.1);
        let d = (look.1, -look.0);
        let (s0, s1) = corners.iter().map(|q| proj(q, d)).fold((f64::INFINITY, f64::NEG_INFINITY), |(a, z), v| (a.min(v), z.max(v)));
        let t = corners.iter().map(|q| proj(q, look)).fold(f64::INFINITY, f64::min) - margin;
        let at = |sv: f64| {
            let r3 = |v: f64| (v * 1000.0).round() / 1000.0;
            (r3(d.0 * sv + look.0 * t), r3(d.1 * sv + look.1 * t))
        };
        out.push(Side { key, line: [at(s0 - margin), at(s1 + margin)], look });
        n = (-n.1, n.0);
    }
    Some(out)
}

/// Blickrichtung einer vorhandenen Ansichtsebene (Einheitsvektor), `None` ohne gültige Linie.
fn look_of(level: &Value) -> Option<V> {
    let pts = field(level, "linePoints").and_then(Value::as_array)?;
    let q = |i: usize| Some((pts.get(i)?.get("x")?.as_f64()?, pts.get(i)?.get("y")?.as_f64()?));
    let (a, b) = (q(0)?, q(1)?);
    let (dx, dy) = (b.0 - a.0, b.1 - a.1);
    let len = dx.hypot(dy);
    if !(len > 1e-9) {
        return None;
    }
    let sign = if field(level, "directionSign").and_then(Value::as_f64).is_some_and(|x| x < 0.0) { -1.0 } else { 1.0 };
    Some((-dy / len * sign, dx / len * sign))
}

/// Was der Befehl täte: Seiten, die entstehen, und Seiten mit vorhandener Ansicht.
#[derive(Debug, Default, PartialEq)]
pub struct Plan {
    pub create: Vec<Side>,
    pub existing: Vec<&'static str>,
    /// Kein Gebäude (nichts zu tun).
    pub empty: bool,
}

pub fn plan(p: &Project, root: &Map<String, Value>) -> Plan {
    let pts: Vec<V> = built_points(p).iter().map(|q| (q.x, q.y)).collect();
    let Some(all) = sides(&pts) else {
        return Plan { empty: true, ..Plan::default() };
    };
    let looks: Vec<V> = arr(root.get("drawingLevels"))
        .iter()
        .filter(|l| field(l, "kind").and_then(Value::as_str) == Some("elevation"))
        .filter_map(look_of)
        .collect();
    let mut out = Plan::default();
    for i in ORDER {
        let side = &all[i];
        if looks.iter().any(|e| e.0 * side.look.0 + e.1 * side.look.1 > std::f64::consts::FRAC_1_SQRT_2) {
            out.existing.push(side.key);
        } else {
            out.create.push(side.clone());
        }
    }
    out
}

/// Ops: je fehlende Seite eine neue Ansichtsebene; `names` = `{east, north, south, west}` (Hülle, t()).
pub fn ops(p: &Project, root: &Map<String, Value>, v: &Value, ids: &mut IdGen) -> Vec<Op> {
    let names = v.get("names");
    let items: Vec<Value> = plan(p, root)
        .create
        .iter()
        .map(|side| {
            let name = names.and_then(|n| n.get(side.key)).and_then(Value::as_str).unwrap_or(side.key);
            obj(vec![
                ("id", s(&ids.next("elevation"))),
                ("name", s(name)),
                ("kind", s("elevation")),
                ("visible", Value::Bool(true)),
                ("locked", Value::Bool(false)),
                ("linePoints", Value::Array(vec![pv(side.line[0]), pv(side.line[1])])),
                ("directionSign", js_num(1.0)),
            ])
        })
        .collect();
    add_op("drawingLevels", items)
}

/// Abfrage `elevationsPlan`: Seiten (Schlüssel), die entstehen bzw. schon vorhanden sind.
pub fn query(p: &Project, root: &Map<String, Value>) -> Value {
    let pl = plan(p, root);
    json!({ "empty": pl.empty, "create": pl.create.iter().map(|x| x.key).collect::<Vec<_>>(), "existing": pl.existing })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x0: f64, y0: f64, x1: f64, y1: f64) -> Vec<V> {
        vec![(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
    }
    fn side<'a>(s: &'a [Side], key: &str) -> &'a Side {
        s.iter().find(|x| x.key == key).unwrap()
    }
    fn near(a: V, b: V) {
        assert!((a.0 - b.0).abs() < 2e-3 && (a.1 - b.1).abs() < 2e-3, "{a:?} != {b:?}");
    }

    /// Rechtwinkliges Haus 10 × 6: vier Linien im Abstand 2 m, Süd wie die Vorlage (von links nach rechts, Blick +y).
    #[test]
    fn rechtwinkliges_haus() {
        let s = sides(&rect(0.0, 0.0, 10.0, 6.0)).unwrap();
        assert_eq!(s.len(), 4);
        let sued = side(&s, "south");
        near(sued.line[0], (-2.0, -2.0));
        near(sued.line[1], (12.0, -2.0));
        near(sued.look, (0.0, 1.0));
        let nord = side(&s, "north");
        near(nord.line[0], (12.0, 8.0));
        near(nord.line[1], (-2.0, 8.0));
        near(nord.look, (0.0, -1.0));
        let ost = side(&s, "east");
        near(ost.line[0], (12.0, -2.0));
        near(ost.line[1], (12.0, 8.0));
        near(ost.look, (-1.0, 0.0));
        let west = side(&s, "west");
        near(west.line[0], (-2.0, 8.0));
        near(west.line[1], (-2.0, -2.0));
    }

    /// Grosses Haus: Rand wächst mit 10 % der Ausdehnung.
    #[test]
    fn rand_waechst_mit_dem_haus() {
        let s = sides(&rect(0.0, 0.0, 40.0, 10.0)).unwrap();
        near(side(&s, "south").line[0], (-4.0, -4.0));
    }

    /// Um 30° gedrehtes Haus: die Linien folgen der Hauptrichtung, die Namen der nächsten Himmelsrichtung.
    #[test]
    fn gedrehtes_haus() {
        let (c, sn) = (30f64.to_radians().cos(), 30f64.to_radians().sin());
        let pts: Vec<V> = rect(0.0, 0.0, 12.0, 6.0).iter().map(|&(x, y)| (x * c - y * sn + 100.0, x * sn + y * c + 200.0)).collect();
        let s = sides(&pts).unwrap();
        // Südfassade (Normale −v = (sn, −c)) liegt auf der Unterkante des gedrehten Rechtecks; Blick (−sn, c).
        let sued = side(&s, "south");
        near(sued.look, (-sn, c));
        let d = (sued.line[1].0 - sued.line[0].0, sued.line[1].1 - sued.line[0].1);
        assert!((d.0 / d.0.hypot(d.1) - c).abs() < 1e-3 && (d.1 / d.0.hypot(d.1) - sn).abs() < 1e-3);
        // Ostfassade = kurze Seite, Blick gegen die Hauptrichtung.
        near(side(&s, "east").look, (-c, -sn));
        assert_eq!(s.iter().map(|x| x.key).collect::<Vec<_>>(), vec!["east", "north", "west", "south"]);
    }

    /// 60° gedreht = um −30° gedreht gedacht, nur mit vertauschten Seiten: Namen folgen der nächsten Himmelsrichtung.
    #[test]
    fn stark_gedrehtes_haus_benennt_nach_naechster_richtung() {
        let (c, sn) = (60f64.to_radians().cos(), 60f64.to_radians().sin());
        let pts: Vec<V> = rect(0.0, 0.0, 12.0, 6.0).iter().map(|&(x, y)| (x * c - y * sn, x * sn + y * c)).collect();
        let s = sides(&pts).unwrap();
        // Lange Achse zeigt bei 60°: nächste Himmelsrichtung ist Nord (90°), Normale der Nordfassade bei 60°+... = −30°+90°.
        // Die Nordfassade ist die Fassade, deren Aussennormale am nächsten bei +y liegt.
        let nord = side(&s, "north");
        assert!(-nord.look.1 > 0.8, "{:?}", nord.look);
        let sued = side(&s, "south");
        assert!(sued.look.1 > 0.8);
        let ost = side(&s, "east");
        assert!(-ost.look.0 > 0.8);
    }

    /// L-Form: das umschliessende Rechteck bestimmt Richtung und Lage, die Linien liegen vor den äusseren Kanten.
    #[test]
    fn l_form() {
        let l = vec![(0.0, 0.0), (12.0, 0.0), (12.0, 5.0), (5.0, 5.0), (5.0, 10.0), (0.0, 10.0)];
        let s = sides(&l).unwrap();
        near(side(&s, "south").line[0], (-2.0, -2.0));
        near(side(&s, "south").line[1], (14.0, -2.0));
        near(side(&s, "east").line[0], (14.0, -2.0));
        near(side(&s, "east").line[1], (14.0, 12.0));
    }

    /// Ohne Fläche (eine einzelne Wand, leer) nichts.
    #[test]
    fn ohne_gebaeude_nichts() {
        assert!(sides(&[]).is_none());
        assert!(sides(&[(0.0, 0.0), (8.0, 0.0)]).is_none());
        assert!(sides(&rect(0.0, 0.0, 8.0, 0.5)).is_none());
    }

    /// Fast achsparallel (0.2°) gilt als achsparallel.
    #[test]
    fn leichter_schiefstand_wird_gerade() {
        let pts = vec![(0.0, 0.0), (10.0, 0.035), (10.0, 6.035), (0.0, 6.0)];
        let (u, _) = main_frame(&pts).unwrap();
        assert_eq!(u, (1.0, 0.0));
    }

    fn project(level_lines: Value) -> (Project, Map<String, Value>) {
        let wall = |id: &str, a: V, b: V| {
            json!({"id": id, "type": "wall", "floorId": "eg", "categoryCode": "20", "start": {"x": a.0, "y": a.1}, "end": {"x": b.0, "y": b.1}, "wallTypeId": "aw", "height": 2.6})
        };
        let mut levels = vec![json!({"id": "eg", "name": "EG", "kind": "floor", "visible": true, "locked": false, "floorHeight": 2.6, "baseElevation": 0})];
        levels.extend(level_lines.as_array().unwrap().iter().cloned());
        let v = json!({
            "drawingLevels": levels,
            "walls": [wall("w1", (0.0, 0.0), (10.0, 0.0)), wall("w2", (10.0, 0.0), (10.0, 6.0)), wall("w3", (10.0, 6.0), (0.0, 6.0)), wall("w4", (0.0, 6.0), (0.0, 0.0))]
        });
        project_of(&v)
    }

    fn project_of(v: &Value) -> (Project, Map<String, Value>) {
        let mut d = crate::document::Document::from_json(&v.to_string()).unwrap();
        let root = d.root().clone();
        (d.project().unwrap().clone(), root)
    }

    /// Vorhandene Südansicht (auch in schräger Lage < 45°) wird nicht doppelt angelegt.
    #[test]
    fn vorhandene_suedansicht_bleibt() {
        let sued = json!({"id": "as", "name": "Ansicht Süd", "kind": "elevation", "visible": true, "locked": false,
            "linePoints": [{"x": -1, "y": -2}, {"x": 6, "y": -2}], "directionSign": 1});
        let (p, root) = project(json!([sued]));
        let pl = plan(&p, &root);
        assert_eq!(pl.existing, vec!["south"]);
        assert_eq!(pl.create.iter().map(|x| x.key).collect::<Vec<_>>(), vec!["north", "east", "west"]);
        let mut ids = IdGen::new("t");
        let o = ops(&p, &root, &json!({"names": {"north": "Ansicht Nord"}}), &mut ids);
        let Op::Add { collection, items, .. } = &o[0] else { panic!() };
        assert_eq!(collection, "drawingLevels");
        assert_eq!(items.len(), 3);
        assert_eq!(items[0]["name"], "Ansicht Nord");
        assert_eq!(items[0]["kind"], "elevation");
        assert_eq!(items[0]["directionSign"], json!(1));
        // Zweiter Lauf auf dem Ergebnis: alle vier vorhanden.
        let mut levels = root["drawingLevels"].as_array().unwrap().clone();
        levels.extend(items.iter().cloned());
        let mut root2 = root.clone();
        root2.insert("drawingLevels".into(), Value::Array(levels));
        let (p2, root2) = project_of(&Value::Object(root2));
        let pl2 = plan(&p2, &root2);
        assert!(pl2.create.is_empty());
        assert_eq!(pl2.existing.len(), 4);
    }

    /// Eine Ansicht mit umgekehrter Blickrichtung (`directionSign` −1) zählt für die Gegenseite.
    #[test]
    fn blickrichtung_zaehlt() {
        let nord = json!({"id": "an", "name": "x", "kind": "elevation", "visible": true, "locked": false,
            "linePoints": [{"x": -1, "y": -2}, {"x": 6, "y": -2}], "directionSign": -1});
        let (p, root) = project(json!([nord]));
        assert_eq!(plan(&p, &root).existing, vec!["north"]);
    }

    /// Ohne Gebäude: leer, keine Ops.
    #[test]
    fn leeres_projekt() {
        let v = json!({"drawingLevels": [], "walls": []});
        let (p, root) = project_of(&v);
        assert!(plan(&p, &root).empty);
        assert!(ops(&p, &root, &json!({}), &mut IdGen::new("t")).is_empty());
    }
}
