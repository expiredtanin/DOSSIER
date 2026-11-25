//! [332] Eigene Höhenlinien zeichnen: eine 2D-Linie (Linie, Polylinie samt Bögen, Spline, Bezier, Bogen, Kreis,
//! Ellipse, Rechteck) wird mit einer getippten Höhe zur Gelände-Höhenlinie. Sie kommt in den ersten Höhenlinien-Satz
//! der Kontext-Schicht (den liest „Gelände erzeugen“, `cmd_solid::terrain_ops`), sonst in einen neuen Satz der Klasse
//! „14 Höhenlinien“; die Quell-Zeichnung verschwindet. Ein Undo-Schritt je Linie.

use serde_json::{Map, Value};

use crate::cmd_create::{category_or, find, obj, point_segment_distance, polyline_edges, pvs, remove_op, s, s_of, opt_n, Ctx};
use crate::cmd_transform::IdGen;
use crate::json_util::js_num;
use crate::model::{Drawing2D, Drawing2DGeom, Project, SplineMode, Vec2};
use crate::ops::Op;

/// Fangabstand beim Anklicken einer Linie (Modell-m), wie beim Extrudieren.
const HIT_TOL: f64 = 0.25;
/// Klasse „Höhenlinien“ (wie der Höhenlinien-Import).
const CONTOUR_CATEGORY: &str = "14";

fn pts_of(f: &[f64]) -> Vec<Vec2> {
    f.chunks_exact(2).map(|c| Vec2 { x: c[0], y: c[1] }).collect()
}

fn flat(p: &[Vec2]) -> Vec<f64> {
    p.iter().flat_map(|q| [q.x, q.y]).collect()
}

/// Linienzug einer Zeichnung (Punkte, geschlossen?) — `None` für Texte, Masse, Schraffuren u. ä. oder Unsinn.
pub fn line_of(g: &Drawing2DGeom) -> Option<(Vec<Vec2>, bool)> {
    let (pts, closed) = match g {
        Drawing2DGeom::Line { a, b } => (vec![*a, *b], false),
        Drawing2DGeom::Polyline { pts, closed, bulge, .. } => {
            let real = bulge.as_ref().is_some_and(|b| b.iter().any(|x| x.abs() > 1e-9));
            let q = if real { pts_of(&crate::bulge::polyline_points(&flat(pts), bulge.as_deref().unwrap_or(&[]), *closed)) } else { pts.clone() };
            (q, *closed && pts.len() > 2)
        }
        Drawing2DGeom::Spline { pts, closed, mode } => {
            let closed = *closed && pts.len() > 2;
            let q = if pts.len() < 3 {
                pts.clone()
            } else if *mode == Some(SplineMode::Control) {
                pts_of(&crate::curves::uniform_bspline(&flat(pts), closed, 16.0))
            } else {
                pts_of(&crate::curves::catmull_rom(&flat(pts), closed, 16.0))
            };
            (q, closed)
        }
        Drawing2DGeom::Bezier { pts } => (if pts.len() < 4 { pts.clone() } else { pts_of(&crate::curves::bezier_chain(&flat(pts), 24.0)) }, false),
        Drawing2DGeom::Arc { center, r, a0, a1 } => (crate::plan::text_curve::arc_points(*center, *r, *a0, *a1), false),
        Drawing2DGeom::Circle { center, r } => (crate::cmd_create::circle_pts((center.x, center.y), *r, 48).into_iter().map(|(x, y)| Vec2 { x, y }).collect(), true),
        Drawing2DGeom::Ellipse { center, rx, ry, rotation } => (pts_of(&crate::curves::ellipse(center.x, center.y, *rx, *ry, *rotation, 48.0)), true),
        Drawing2DGeom::Rect { min, max } => (vec![*min, Vec2 { x: max.x, y: min.y }, *max, Vec2 { x: min.x, y: max.y }], true),
        _ => return None,
    };
    // Doppelte Folgepunkte weg (Tessellierung, Schlusspunkt = Anfang bei geschlossenen).
    let mut q: Vec<Vec2> = Vec::with_capacity(pts.len());
    for p in pts {
        if !(p.x.is_finite() && p.y.is_finite()) {
            return None;
        }
        if q.last().is_none_or(|l: &Vec2| (l.x - p.x).abs() > 1e-9 || (l.y - p.y).abs() > 1e-9) {
            q.push(p);
        }
    }
    if closed && q.len() > 1 && (q[0].x - q[q.len() - 1].x).abs() < 1e-9 && (q[0].y - q[q.len() - 1].y).abs() < 1e-9 {
        q.pop();
    }
    (q.len() >= if closed { 3 } else { 2 }).then_some((q, closed))
}

/// Nächste Linie der Ebene am Punkt (Kantenabstand < [`HIT_TOL`]).
pub fn pick<'a>(p: &'a Project, level: &str, at: (f64, f64)) -> Option<&'a Drawing2D> {
    let mut best = None;
    let mut best_d = HIT_TOL;
    for d in p.drawings2d.iter().filter(|d| d.level_id == level) {
        let Some((pts, closed)) = line_of(&d.geom) else { continue };
        let v: Vec<(f64, f64)> = pts.iter().map(|q| (q.x, q.y)).collect();
        for (a, b) in polyline_edges(&v, closed) {
            let dd = point_segment_distance(at, a, b);
            if dd < best_d {
                best_d = dd;
                best = Some(d);
            }
        }
    }
    best
}

/// Treffer als JSON für die Hülle (Hervorhebung): `{ id, pts, closed }`.
pub fn hit_json(d: &Drawing2D) -> Value {
    match line_of(&d.geom) {
        Some((pts, closed)) => obj(vec![("id", s(&d.id)), ("pts", pvs(&pts.iter().map(|q| (q.x, q.y)).collect::<Vec<_>>())), ("closed", Value::Bool(closed))]),
        None => Value::Null,
    }
}

/// Ops: Quelle `source` (Zeichnung) mit Höhe `z` zur Höhenlinie; ohne gültige Linie/Höhe nichts.
pub fn ops(root: &Map<String, Value>, p: &Project, v: &Value, ctx: &Ctx, ids: &mut IdGen) -> Vec<Op> {
    let src = s_of(v, "source");
    // Höhe Pflicht (fehlt/ungültig: nichts — `n_of` machte daraus 0).
    let z = opt_n(v, "z").unwrap_or(f64::NAN);
    let Some(d) = p.drawings2d.iter().find(|d| d.id == src) else { return Vec::new() };
    let Some((pts, closed)) = line_of(&d.geom).filter(|_| z.is_finite()) else { return Vec::new() };
    if find(root, "drawings2d", src).is_none() {
        return Vec::new();
    }
    let contour = obj(vec![("z", js_num(z)), ("pts", pvs(&pts.iter().map(|q| (q.x, q.y)).collect::<Vec<_>>())), ("closed", Value::Bool(closed))]);
    let context = root.get("context").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]);
    let set = context.iter().find(|o| o.get("type").and_then(Value::as_str) == Some("contourSet"));
    let mut out = match set {
        Some(set) => {
            let mut e = set.clone();
            if let Some(list) = e.get_mut("contours").and_then(Value::as_array_mut) {
                list.push(contour);
            } else if let Some(m) = e.as_object_mut() {
                m.insert("contours".into(), Value::Array(vec![contour]));
            }
            vec![Op::Replace { collection: "context".into(), entity: e }]
        }
        None => vec![Op::Add {
            collection: "context".into(),
            items: vec![obj(vec![
                ("id", s(&ids.next("contours"))),
                ("type", s("contourSet")),
                ("name", s("Höhenlinien (gezeichnet)")),
                ("categoryCode", category_or(p, CONTOUR_CATEGORY, ctx)),
                ("source", s("Gezeichnet")),
                ("contours", Value::Array(vec![contour])),
            ])],
            at: None,
        }],
    };
    out.extend(remove_op(root, "drawings2d", &[src]));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn project(drawings: Value, context: Value) -> (Map<String, Value>, Project) {
        let v = json!({
            "name": "T", "walls": [], "openings": [], "rooms": [],
            "drawingLevels": [{"id": "eg", "name": "EG", "kind": "floor", "visible": true, "locked": false}],
            "layers": [{"code": "14", "name": "Höhenlinien", "color": "#888888", "lw": 0.1, "visible": true, "locked": false}],
            "drawings2d": drawings, "context": context,
        });
        let p: Project = serde_json::from_value(v.clone()).unwrap();
        (v.as_object().unwrap().clone(), p)
    }

    fn run(root: &Map<String, Value>, p: &Project, v: Value) -> Vec<Op> {
        let ctx = crate::cmd_create::ctx_of(&v);
        let mut ids = IdGen::new("t");
        ops(root, p, &v, &ctx, &mut ids)
    }

    #[test]
    fn linienarten_als_linienzug() {
        let l = |g: Value| line_of(&serde_json::from_value::<Drawing2DGeom>(g).unwrap());
        assert_eq!(l(json!({"shape": "line", "a": {"x": 0, "y": 0}, "b": {"x": 3, "y": 0}})).map(|(p, c)| (p.len(), c)), Some((2, false)));
        assert_eq!(l(json!({"shape": "rect", "min": {"x": 0, "y": 0}, "max": {"x": 3, "y": 2}})).map(|(p, c)| (p.len(), c)), Some((4, true)));
        let (c, closed) = l(json!({"shape": "circle", "center": {"x": 1, "y": 1}, "r": 2})).unwrap();
        assert!(closed && c.len() == 48 && c.iter().all(|q| ((q.x - 1.0).hypot(q.y - 1.0) - 2.0).abs() < 1e-9));
        // Spline durch die Punkte: dichter als die Eingabe, Anfang und Ende bleiben.
        let (sp, closed) = l(json!({"shape": "spline", "pts": [{"x": 0, "y": 0}, {"x": 5, "y": 2}, {"x": 10, "y": 0}], "closed": false})).unwrap();
        assert!(!closed && sp.len() > 10 && sp[0].x == 0.0 && (sp[sp.len() - 1].x - 10.0).abs() < 1e-9);
        // Polylinie mit Bogen: tesselliert.
        let (pb, _) = l(json!({"shape": "polyline", "pts": [{"x": 0, "y": 0}, {"x": 4, "y": 0}], "closed": false, "bulge": [1.0, 0.0]})).unwrap();
        assert!(pb.len() > 2);
        // Text, entartet: nichts.
        assert!(l(json!({"shape": "text", "at": {"x": 0, "y": 0}, "text": "x", "height": 0.25, "angle": 0})).is_none());
        assert!(l(json!({"shape": "line", "a": {"x": 1, "y": 1}, "b": {"x": 1, "y": 1}})).is_none());
    }

    #[test]
    fn linie_wird_hoehenlinie_im_neuen_satz() {
        let (root, p) = project(json!([{"id": "d1", "type": "drawing2d", "levelId": "eg", "categoryCode": "00", "geom": {"shape": "polyline", "pts": [{"x": 0, "y": 0}, {"x": 10, "y": 1}, {"x": 20, "y": 0}], "closed": false}}]), json!([]));
        let ops = run(&root, &p, json!({"cmd": "contourLine", "source": "d1", "z": 451.5, "level": "eg"}));
        let j: Vec<Value> = ops.iter().map(|o| o.to_json()).collect();
        assert_eq!(j.len(), 2, "{j:?}");
        let set = &j[0]["items"][0];
        assert_eq!((set["type"].as_str(), set["categoryCode"].as_str()), (Some("contourSet"), Some("14")));
        assert_eq!(set["contours"][0]["z"].as_f64(), Some(451.5));
        assert_eq!(set["contours"][0]["pts"].as_array().map(Vec::len), Some(3));
        assert_eq!(j[1]["kind"].as_str(), Some("remove"));
        // Ohne Höhe oder unbekannte Quelle: nichts.
        assert!(run(&root, &p, json!({"cmd": "contourLine", "source": "d1", "z": null})).is_empty());
        assert!(run(&root, &p, json!({"cmd": "contourLine", "source": "x", "z": 1})).is_empty());
    }

    #[test]
    fn haengt_an_den_ersten_vorhandenen_satz() {
        let (root, p) = project(
            json!([{"id": "d1", "type": "drawing2d", "levelId": "eg", "categoryCode": "00", "geom": {"shape": "line", "a": {"x": 0, "y": 5}, "b": {"x": 20, "y": 5}}}]),
            json!([{"id": "hl", "type": "contourSet", "name": "Import", "categoryCode": "14", "contours": [{"z": 450, "pts": [{"x": 0, "y": 0}, {"x": 20, "y": 0}], "closed": false}]}]),
        );
        let j: Vec<Value> = run(&root, &p, json!({"cmd": "contourLine", "source": "d1", "z": 451})).iter().map(|o| o.to_json()).collect();
        assert_eq!(j[0]["kind"].as_str(), Some("replace"));
        assert_eq!(j[0]["entity"]["id"].as_str(), Some("hl"));
        assert_eq!(j[0]["entity"]["contours"].as_array().map(Vec::len), Some(2));
        // Angeklickt: nächste Linie der Ebene.
        assert_eq!(pick(&p, "eg", (10.0, 5.1)).map(|d| d.id.as_str()), Some("d1"));
        assert!(pick(&p, "eg", (10.0, 6.0)).is_none());
        assert!(pick(&p, "og", (10.0, 5.0)).is_none());
    }
}
