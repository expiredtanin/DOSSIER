//! [222] Volumenstudie → Bauteile: ein prismatischer Körper (`ExtrudedSolid`, Grundriss-Polygon × Höhe) wird zu
//! Aussenwänden je Geschoss, Decken zwischen den Geschossen und einem Flachdach. Ein Undo-Schritt (Befehl
//! `solidtoparts` in `commands/cmds/solidToParts.ts`, Anfrage `{cmd: "solidToParts", id, floorName}`).
//!
//! Geschosse: der Körper muss auf einem Geschoss (OK fertig Boden) oder auf der Oberkante des Geschoss-Stapels
//! stehen. Ab dort nimmt der Befehl die bestehenden Geschosse; reicht der Stapel nicht bis zur Körper-OK, legt er
//! neue Geschosse obenauf an (Höhe des obersten Geschosses, gleichmässig auf die Resthöhe verteilt). Ein Rest unter
//! [`MIN_STORY`] verlängert die Wände des obersten Geschosses. Das Flachdach schliesst bündig mit der Körper-OK ab
//! (seine Schichten hängen nach unten wie bei einer Decke), die Hülle der Bauteile deckt sich mit dem Körper.
//!
//! Wände: je Umrisskante eine Wand des aktiven Wandtyps (wie beim Zeichnen), Referenzlinie „left“ = Aussenfläche
//! auf der Körperkante, Achse im Uhrzeigersinn, damit die Wand nach innen wächst. Decken und Dach mit den Vorgaben
//! des Zeichnens (`ceiling_item`, `roof_item`). Der Körper selbst entfällt (sonst zählte das GV doppelt).
//!
//! Abgelehnt (Code in [`check`], Meldung in der Hülle): geneigte/verjüngte Körper, B-Rep-Körper ausser Quader,
//! Zylinder und Extrusion (die sind Prismen über dem Grundriss `points`), verrundete oder
//! gefaste Ecken, Abzugskörper, selbstschneidende oder flächenlose Grundrisse, zu niedrige Körper, Körper-UK
//! zwischen zwei Geschossen. Löcher kennt `ExtrudedSolid` nicht.

use crate::cmd_create::{active_wall_type_id, category_or, ceiling_item, obj, pv, remove_op, roof_item, s, s_of, Ctx, V};
use crate::cmd_transform::IdGen;
use crate::json_util::js_num;
use crate::model::{DrawingLevelKind, ExtrudedSolid, Project};
use crate::ops::Op;
use serde_json::{json, Value};

/// Toleranz für „steht auf dem Geschoss“ (Meter).
const TOL: f64 = 0.02;
/// Kleinste Geschosshöhe, die ein neues Geschoss wert ist; kleinere Reste verlängern das oberste.
pub const MIN_STORY: f64 = 0.5;
/// Vorgabe-Geschosshöhe ohne bestehende Geschosse.
const DEF_STORY: f64 = 3.0;
/// Obergrenze der Geschosse (Unsinn wie 1 km hohe Körper ablehnen statt tausende Wände zu bauen).
const MAX_STORIES: usize = 200;

/// Ein Geschoss des Ergebnisses: bestehend (`new` = None) oder neu (Index in `Plan::new_floors`).
#[derive(Debug, Clone, PartialEq)]
pub struct Story {
    pub floor: String,
    /// Unterkante (OKFF) und Oberkante der Wände in diesem Geschoss.
    pub base: f64,
    pub top: f64,
    /// Oberkante des Geschosses (`baseElevation + floorHeight`): dort liegt die Decke ohne Bindung.
    pub floor_top: f64,
}

/// Neues Geschoss (obenauf).
#[derive(Debug, Clone, PartialEq)]
pub struct NewFloor {
    pub id: String,
    pub name: String,
    pub base: f64,
    pub height: f64,
}

#[derive(Debug)]
pub struct Plan {
    /// Grundriss im Gegenuhrzeigersinn (Decken, Dach); die Wände laufen umgekehrt.
    pub outline: Vec<V>,
    pub stories: Vec<Story>,
    pub new_floors: Vec<NewFloor>,
}

/// Auf Mikrometer gerundet: Höhen aus Differenzen ohne Gleitkomma-Rest (2.5999999999999996 → 2.6).
fn um(x: f64) -> f64 {
    (x * 1e6).round() / 1e6
}

fn cross(o: V, a: V, b: V) -> f64 {
    (a.0 - o.0) * (b.1 - o.1) - (a.1 - o.1) * (b.0 - o.0)
}

/// Grundriss bereinigen: doppelte Punkte, Schlusspunkt und kollineare Zwischenpunkte weg, CCW. `None`, wenn er
/// entartet oder selbstschneidend ist.
pub fn clean_outline(pts: &[V]) -> Option<Vec<V>> {
    if pts.iter().any(|q| !q.0.is_finite() || !q.1.is_finite()) {
        return None;
    }
    let near = |a: V, b: V| (a.0 - b.0).abs() < 1e-6 && (a.1 - b.1).abs() < 1e-6;
    let mut r: Vec<V> = Vec::new();
    for q in pts {
        if r.last().is_none_or(|l| !near(*l, *q)) {
            r.push(*q);
        }
    }
    while r.len() > 1 && near(r[0], r[r.len() - 1]) {
        r.pop();
    }
    // Kollineare Punkte (auch Spitzen, die zurücklaufen) entfernen, bis nichts mehr wegfällt.
    loop {
        let n = r.len();
        if n < 3 {
            return None;
        }
        let drop = (0..n).find(|&i| {
            let (a, b, c) = (r[(i + n - 1) % n], r[i], r[(i + 1) % n]);
            let len = crate::jsmath::hypot2(c.0 - a.0, c.1 - a.1).max(1e-9);
            cross(a, b, c).abs() / len < 1e-6
        });
        match drop {
            Some(i) => {
                r.remove(i);
            }
            None => break,
        }
    }
    let ring: Vec<[f64; 2]> = r.iter().map(|q| [q.0, q.1]).collect();
    if !crate::roof_skeleton::is_simple_ring(&ring) {
        return None;
    }
    if crate::roof_skeleton::signed_area(&ring) < 0.0 {
        r.reverse();
    }
    Some(r)
}

/// Grund, warum der Körper nicht prismatisch-einfach ist (Code für die Meldung), sonst `None`.
fn shape_problem(sd: &ExtrudedSolid) -> Option<&'static str> {
    if sd.operation.as_deref() == Some("subtract") {
        return Some("subtract");
    }
    if let Some(b) = &sd.brep {
        if !prismatic_brep(&b.spec, sd.height) {
            return Some("brep");
        }
    }
    if sd.taper.is_some_and(|t| t.abs() > 1e-9) {
        return Some("tapered");
    }
    if sd.corner_radius.is_some_and(|r| r > 1e-9) || sd.chamfer.is_some_and(|c| c > 1e-9) {
        return Some("rounded");
    }
    if !(sd.height.is_finite() && sd.height >= MIN_STORY) {
        return Some("height");
    }
    None
}

/// B-Rep-Körper, die doch ein senkrechtes Prisma über `points` sind: Quader (Befehl „Körper“, Form Quader),
/// Zylinder und Extrusion, je ab der Körper-UK und so hoch wie der Körper. Kugel, Kegel, Torus, Rotation,
/// Loft und Verschneidungen nicht.
fn prismatic_brep(spec: &std::collections::BTreeMap<String, Value>, height: f64) -> bool {
    let num = |k: &str| spec.get(k).and_then(Value::as_f64);
    let z = |k: &str, i: usize| spec.get(k).and_then(|v| v.get(i)).and_then(Value::as_f64);
    let near = |a: Option<f64>, b: f64| a.is_some_and(|a| (a - b).abs() < 1e-6);
    let z0_ok = num("z0").is_none_or(|z0| z0.abs() < 1e-6);
    match spec.get("kind").and_then(Value::as_str) {
        Some("cuboid") => near(z("min", 2), 0.0) && near(z("max", 2), height),
        Some("cylinder") => z0_ok && near(num("height"), height),
        Some("extrude") => z0_ok && near(num("height"), height) && !num("cornerRadius").is_some_and(|r| r > 0.0) && !num("chamfer").is_some_and(|c| c > 0.0),
        _ => false,
    }
}

/// Geschosse (OKFF, Höhe, id) nach Höhe sortiert; Geschosse ohne Höhe zählen nicht.
fn floor_stack(p: &Project) -> Vec<(f64, f64, &str)> {
    let mut f: Vec<(f64, f64, &str)> = p
        .drawing_levels
        .iter()
        .filter(|l| l.kind == DrawingLevelKind::Floor)
        .map(|l| (l.base_elevation.filter(|b| b.is_finite()).unwrap_or(0.0), l.floor_height.filter(|h| h.is_finite()).unwrap_or(0.0), l.id.as_str()))
        .filter(|f| f.1 > 1e-6)
        .collect();
    f.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    f
}

/// Plan der Umwandlung oder der Ablehnungs-Code.
pub fn plan(p: &Project, id: &str, floor_name: &str, ids: &mut IdGen) -> Result<Plan, &'static str> {
    let sd = p.extruded_solids.as_deref().unwrap_or(&[]).iter().find(|x| x.id == id).ok_or("none")?;
    if let Some(code) = shape_problem(sd) {
        return Err(code);
    }
    let outline = clean_outline(&sd.points.iter().map(|q| (q.x, q.y)).collect::<Vec<_>>()).ok_or("outline")?;
    let level_base = p.floor(&sd.level_id).and_then(|l| l.base_elevation).filter(|b| b.is_finite()).unwrap_or(0.0);
    let z0 = level_base + sd.base_offset.filter(|o| o.is_finite()).unwrap_or(0.0);
    let z1 = z0 + sd.height;
    let stack = floor_stack(p);
    let stack_top = stack.iter().map(|f| f.0 + f.1).fold(f64::NEG_INFINITY, f64::max);
    let stack_top = if stack_top.is_finite() { stack_top } else { 0.0 };

    // Bestehende Geschosse ab der Körper-UK, lückenlos aufeinander.
    let mut stories: Vec<Story> = Vec::new();
    let mut cur = z0;
    for &(base, h, fid) in &stack {
        if cur >= z1 - TOL {
            break;
        }
        if (base - cur).abs() < TOL {
            stories.push(Story { floor: fid.into(), base: cur, top: (base + h).min(z1), floor_top: base + h });
            cur = base + h;
        }
    }
    if stories.is_empty() && (z0 - stack_top).abs() >= TOL {
        return Err("base");
    }
    let mut new_floors = Vec::new();
    let rest = z1 - cur;
    if rest >= TOL {
        if rest < MIN_STORY && !stories.is_empty() {
            stories.last_mut().unwrap().top = z1;
        } else if (cur - stack_top).abs() >= TOL {
            // Lücke im Stapel (Geschosse überlappen oder fehlen): nichts raten.
            return Err("floors");
        } else {
            let h_def = stack.iter().rev().find(|f| (f.0 + f.1 - stack_top).abs() < TOL).map(|f| f.1).filter(|h| *h >= MIN_STORY).unwrap_or(DEF_STORY);
            let n = (rest / h_def).round().max(1.0);
            if n > MAX_STORIES as f64 {
                return Err("height");
            }
            let n = n as usize;
            let h = um(rest / n as f64);
            let count = p.drawing_levels.iter().filter(|l| l.kind == DrawingLevelKind::Floor).count();
            for k in 0..n {
                let base = um(cur + h * k as f64);
                let fid = ids.next("floor");
                let name = floor_name.replace("{n}", &(count + k + 1).to_string());
                // Das oberste neue Geschoss nimmt den Rundungsrest: der Stapel endet genau auf der Körper-OK.
                let height = if k + 1 == n { um(z1 - base) } else { h };
                stories.push(Story { floor: fid.clone(), base, top: if k + 1 == n { z1 } else { base + h }, floor_top: base + height });
                new_floors.push(NewFloor { id: fid, name, base, height });
            }
        }
    }
    if stories.len() > MAX_STORIES {
        return Err("height");
    }
    Ok(Plan { outline, stories, new_floors })
}

fn level_value(f: &NewFloor) -> Value {
    obj(vec![
        ("id", s(&f.id)),
        ("name", s(&f.name)),
        ("kind", s("floor")),
        ("visible", Value::Bool(true)),
        ("locked", Value::Bool(false)),
        ("floorHeight", js_num(f.height)),
        ("cutHeight", js_num(1.0)),
        ("baseElevation", js_num(f.base)),
    ])
}

fn floor_name_of(v: &Value) -> &str {
    match s_of(v, "floorName") {
        "" => "Geschoss {n}",
        n => n,
    }
}

/// Ops der Umwandlung: neue Geschosse, Wände, Decken, Dach, Körper weg. Leer bei Ablehnung.
pub fn ops(root: &serde_json::Map<String, Value>, p: &Project, v: &Value, ctx: &Ctx, ids: &mut IdGen) -> Vec<Op> {
    let id = s_of(v, "id");
    let Ok(plan) = plan(p, id, floor_name_of(v), ids) else { return Vec::new() };
    let wall_type = active_wall_type_id(p, ctx);
    let wall_cat = category_or(p, "20", ctx);
    // Wände im Uhrzeigersinn: die linke Seite (+n, Referenz „left“) ist aussen.
    let cw: Vec<V> = plan.outline.iter().rev().copied().collect();
    let (mut walls, mut ceilings) = (Vec::new(), Vec::new());
    let last = plan.stories.len() - 1;
    for (i, st) in plan.stories.iter().enumerate() {
        for k in 0..cw.len() {
            let (a, b) = (cw[k], cw[(k + 1) % cw.len()]);
            walls.push(obj(vec![
                ("id", s(&ids.next("W"))),
                ("type", s("wall")),
                ("floorId", s(&st.floor)),
                ("categoryCode", wall_cat.clone()),
                ("isExternal", Value::Bool(true)),
                ("start", pv(a)),
                ("end", pv(b)),
                ("wallTypeId", wall_type.clone()),
                ("height", js_num(um(st.top - st.base))),
                ("referenceLine", s("left")),
            ]));
        }
        if i < last {
            let mut c = ceiling_item(p, &st.floor, &plan.outline, ctx, ids);
            if (st.top - st.floor_top).abs() > 1e-3 {
                c["top"] = json!({ "mode": "custom", "z": js_num(st.top) });
            }
            ceilings.push(c);
        }
    }
    let top = &plan.stories[last];
    let mut roof = roof_item(p, &top.floor, &plan.outline, "flach", 0.0, ctx, ids);
    if (top.top - top.floor_top).abs() > 1e-3 {
        roof["baseElevation"] = js_num(top.top);
    }
    let mut out = crate::cmd_create::add_op("drawingLevels", plan.new_floors.iter().map(level_value).collect());
    out.extend(crate::cmd_create::add_op("walls", walls));
    out.extend(crate::cmd_create::add_op("ceilings", ceilings));
    out.extend(crate::cmd_create::add_op("roofs", vec![roof]));
    out.extend(remove_op(root, "extrudedSolids", &[id]));
    out
}

/// Prüfung vor dem Commit (Abfrage `{q: "solidToParts", id}`): `ok`, Ablehnungs-Code `reason` und die Zähler für
/// die Meldung.
pub fn check(p: &Project, v: &Value) -> Value {
    let mut ids = IdGen::new("check");
    match plan(p, s_of(v, "id"), floor_name_of(v), &mut ids) {
        Ok(pl) => json!({
            "ok": true,
            "reason": null,
            "stories": pl.stories.len(),
            "newFloors": pl.new_floors.len(),
            "walls": pl.stories.len() * pl.outline.len(),
            "ceilings": pl.stories.len() - 1,
        }),
        Err(code) => json!({ "ok": false, "reason": code }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Map;

    const CTX: &str = r#"{"level":"eg","floorHeight":3,"cat":"90","wallType":"aw"}"#;

    fn root(extra: Value) -> Map<String, Value> {
        let mut r = json!({
            "id": "t", "name": "T",
            "layers": [{"code": "20", "name": "Wände", "color": "#000"}, {"code": "30", "name": "Decken", "color": "#000"}, {"code": "31", "name": "Dach", "color": "#000"}],
            "wallTypes": [{"id": "aw", "name": "Aussenwand", "layers": [{"componentId": "c", "thickness": 0.3}]}],
            "ceilingTypes": [{"id": "ct", "name": "Decke", "layers": [{"componentId": "c", "thickness": 0.25}]}],
            "drawingLevels": [
                {"id": "eg", "name": "EG", "kind": "floor", "visible": true, "locked": false, "floorHeight": 3, "cutHeight": 1, "baseElevation": 0},
                {"id": "og", "name": "OG", "kind": "floor", "visible": true, "locked": false, "floorHeight": 3, "cutHeight": 1, "baseElevation": 3}
            ],
            "walls": [], "ceilings": [], "roofs": [], "extrudedSolids": []
        });
        for (k, v) in extra.as_object().unwrap() {
            r[k] = v.clone();
        }
        r.as_object().unwrap().clone()
    }

    fn solid(pts: Value, h: f64) -> Value {
        json!({"id": "K", "type": "extrudedSolid", "levelId": "eg", "categoryCode": "90", "points": pts, "height": h})
    }

    /// Ops anwenden (nur add/remove, wie der Befehl sie liefert).
    fn apply(r: &mut Map<String, Value>, ops: &[Op]) {
        for op in ops {
            match op {
                Op::Add { collection, items, .. } => {
                    let list = r.entry(collection.clone()).or_insert_with(|| json!([]));
                    list.as_array_mut().unwrap().extend(items.iter().cloned());
                }
                Op::Remove { collection, ids } => {
                    let list = r.get_mut(collection).unwrap().as_array_mut().unwrap();
                    list.retain(|e| !ids.iter().any(|i| e["id"] == json!(i)));
                }
                _ => panic!("unerwartete Op"),
            }
        }
    }

    fn run(r: &Map<String, Value>) -> Vec<Op> {
        let p = crate::model::lenient::typed_for_test(r);
        let req = json!({"cmd": "solidToParts", "id": "K", "floorName": "Geschoss {n}", "ctx": serde_json::from_str::<Value>(CTX).unwrap(), "stamp": "s"});
        crate::cmd_create::ops(r, &p, &req).unwrap()
    }

    fn check_of(r: &Map<String, Value>) -> Value {
        let p = crate::model::lenient::typed_for_test(r);
        crate::cmd_create::query(r, &p, &json!({"q": "solidToParts", "id": "K"})).unwrap().unwrap()
    }

    /// Rechteck 12 × 10, 9 m hoch auf EG/OG (je 3 m): ein drittes Geschoss entsteht, 3 × 4 Wände, 2 Decken, Flachdach
    /// bündig mit der Körper-OK; Wände aussen bündig mit dem Körper, Innenseite nach innen; der Körper entfällt.
    #[test]
    fn rechteck_drei_geschosse() {
        let mut r = root(json!({"extrudedSolids": [solid(json!([{"x": 0, "y": 0}, {"x": 12, "y": 0}, {"x": 12, "y": 10}, {"x": 0, "y": 10}]), 9.0)]}));
        let c = check_of(&r);
        assert_eq!(c, json!({"ok": true, "reason": null, "stories": 3, "newFloors": 1, "walls": 12, "ceilings": 2}));
        let o = run(&r);
        apply(&mut r, &o);
        let p = crate::model::lenient::typed_for_test(&r);
        assert!(p.extruded_solids.as_deref().unwrap_or(&[]).is_empty(), "Körper entfällt");
        let new = p.drawing_levels.iter().find(|l| l.id.starts_with("floor-")).unwrap();
        assert_eq!((new.name.as_str(), new.base_elevation, new.floor_height), ("Geschoss 3", Some(6.0), Some(3.0)));
        assert_eq!(p.walls.len(), 12);
        for w in &p.walls {
            assert_eq!(w.wall_type_id, "aw");
            assert_eq!(w.category_code, "20");
            assert_eq!(w.is_external, Some(true));
            assert_eq!(p.wall_vertical_extent(w).1 - p.wall_vertical_extent(w).0, 3.0);
            // Aussenfläche auf der Körperkante: Achse auf dem Umriss, linke Normale zeigt nach aussen.
            let (dx, dy) = (w.end.x - w.start.x, w.end.y - w.start.y);
            let m = ((w.start.x + w.end.x) / 2.0 - dy * 0.01, (w.start.y + w.end.y) / 2.0 + dx * 0.01);
            assert!(m.0 < 0.0 || m.0 > 12.0 || m.1 < 0.0 || m.1 > 10.0, "links = aussen: {w:?}");
        }
        let floors: Vec<&str> = p.walls.iter().map(|w| w.floor_id.as_str()).collect();
        assert_eq!(floors.iter().filter(|f| **f == "eg").count(), 4);
        assert_eq!(floors.iter().filter(|f| **f == "og").count(), 4);
        // Decken: EG und OG (OK = Geschoss-OK), mit Deckentyp; das oberste Geschoss bekommt das Dach.
        assert_eq!(p.ceilings.as_deref().unwrap().len(), 2);
        let ce: Vec<(f64, f64)> = p.ceilings.as_deref().unwrap().iter().map(|c| p.ceiling_vertical_extent(c)).collect();
        assert_eq!(ce, vec![(2.75, 3.0), (5.75, 6.0)]);
        assert_eq!(p.ceilings.as_deref().unwrap()[0].ceiling_type_id.as_deref(), Some("ct"));
        let roofs = p.roofs.as_deref().unwrap();
        assert_eq!(roofs.len(), 1);
        assert_eq!(roofs[0].floor_id, new.id);
        assert_eq!(p.roof_base_elevation(&roofs[0]), 9.0);
        assert_eq!(roofs[0].shape, crate::model::RoofShape::Flach);
        assert_eq!(roofs[0].overhang, 0.0);
        assert!(crate::ops::validate_project(&r).is_empty());
    }

    /// L-förmig (konkav, 6 Ecken, Punkte im Uhrzeigersinn und mit kollinearem Zwischenpunkt): 6 Wände je Geschoss.
    #[test]
    fn l_form_konkav() {
        let pts = json!([{"x": 0, "y": 0}, {"x": 0, "y": 8}, {"x": 4, "y": 8}, {"x": 4, "y": 4}, {"x": 10, "y": 4}, {"x": 10, "y": 0}, {"x": 5, "y": 0}]);
        let mut r = root(json!({"extrudedSolids": [solid(pts, 6.0)]}));
        let o = run(&r);
        apply(&mut r, &o);
        let p = crate::model::lenient::typed_for_test(&r);
        assert_eq!(p.walls.len(), 12, "zwei Geschosse × 6 Kanten, kein neues Geschoss");
        assert_eq!(p.drawing_levels.len(), 2);
        // Jede Wand: linke Seite aussen (Punkt knapp links der Mitte liegt nicht im L).
        let inside = |x: f64, y: f64| (0.0..=10.0).contains(&x) && (0.0..=4.0).contains(&y) || (0.0..=4.0).contains(&x) && (0.0..=8.0).contains(&y);
        for w in &p.walls {
            let (dx, dy) = (w.end.x - w.start.x, w.end.y - w.start.y);
            let l = (dx * dx + dy * dy).sqrt();
            let (mx, my) = ((w.start.x + w.end.x) / 2.0, (w.start.y + w.end.y) / 2.0);
            assert!(!inside(mx - dy / l * 0.05, my + dx / l * 0.05), "links aussen: {w:?}");
            assert!(inside(mx + dy / l * 0.05, my - dx / l * 0.05), "rechts innen: {w:?}");
        }
        assert_eq!(p.ceilings.as_deref().unwrap().len(), 1);
        assert_eq!(p.roof_base_elevation(&p.roofs.as_deref().unwrap()[0]), 6.0);
    }

    /// Körper niedriger als die Geschosse und kleine Reste: Wände bis zur Körper-OK, Dach mit eigener Traufhöhe;
    /// ein Rest unter 0.5 m verlängert das oberste Geschoss statt eines neuen.
    #[test]
    fn hoehen_die_nicht_aufgehen() {
        let rect = json!([{"x": 0, "y": 0}, {"x": 5, "y": 0}, {"x": 5, "y": 5}, {"x": 0, "y": 5}]);
        let mut r = root(json!({"extrudedSolids": [solid(rect.clone(), 4.5)]}));
        let o = run(&r);
        apply(&mut r, &o);
        let p = crate::model::lenient::typed_for_test(&r);
        let og: Vec<_> = p.walls.iter().filter(|w| w.floor_id == "og").collect();
        assert_eq!(og[0].height, 1.5);
        assert_eq!(p.roof_base_elevation(&p.roofs.as_deref().unwrap()[0]), 4.5);
        let mut r = root(json!({"extrudedSolids": [solid(rect.clone(), 6.3)]}));
        let o = run(&r);
        apply(&mut r, &o);
        let p = crate::model::lenient::typed_for_test(&r);
        assert_eq!(p.drawing_levels.len(), 2, "Rest 0.3 m: kein neues Geschoss");
        assert!((p.walls.iter().find(|w| w.floor_id == "og").unwrap().height - 3.3).abs() < 1e-9);
        // 10 m auf 6 m Stapel: Rest 4 m → ein neues Geschoss à 4 m (round(4/3) = 1).
        let r = root(json!({"extrudedSolids": [solid(rect.clone(), 10.0)]}));
        assert_eq!(check_of(&r)["newFloors"], 1);
        // Geschosse à 2.6 m, Körper 7.8 m: das neue Geschoss hat genau 2.6 m (kein Gleitkomma-Rest 2.5999…).
        let mut r = root(json!({"extrudedSolids": [solid(rect, 7.8)]}));
        r["drawingLevels"][0]["floorHeight"] = json!(2.6);
        r["drawingLevels"][1]["floorHeight"] = json!(2.6);
        r["drawingLevels"][1]["baseElevation"] = json!(2.6);
        let o = run(&r);
        apply(&mut r, &o);
        assert_eq!(r["drawingLevels"][2]["floorHeight"], json!(2.6));
        assert_eq!(r["drawingLevels"][2]["baseElevation"], json!(5.2));
    }

    /// Ohne Geschosse: der Stapel beginnt bei ±0, die Höhe wird gleichmässig auf Geschosse à ~3 m verteilt.
    #[test]
    fn ohne_geschosse() {
        let rect = json!([{"x": 0, "y": 0}, {"x": 5, "y": 0}, {"x": 5, "y": 5}, {"x": 0, "y": 5}]);
        let mut r = root(json!({"drawingLevels": [{"id": "z", "name": "Zeichnung", "kind": "drawing", "visible": true, "locked": false}], "extrudedSolids": [solid(rect, 10.0)]}));
        r["extrudedSolids"][0]["levelId"] = json!("z");
        let o = run(&r);
        apply(&mut r, &o);
        let p = crate::model::lenient::typed_for_test(&r);
        let f: Vec<(f64, f64)> = p.drawing_levels.iter().filter(|l| l.kind == DrawingLevelKind::Floor).map(|l| (l.base_elevation.unwrap(), l.floor_height.unwrap())).collect();
        assert_eq!(f.len(), 3);
        assert!((f[2].0 + f[2].1 - 10.0).abs() < 1e-9);
        assert_eq!(p.drawing_levels[1].name, "Geschoss 1");
    }

    /// Abgelehnt: geneigt, B-Rep, verrundet, Abzugskörper, selbstschneidend, UK zwischen Geschossen, zu niedrig,
    /// unbekannte id. Keine Ops.
    #[test]
    fn ablehnen() {
        let rect = json!([{"x": 0, "y": 0}, {"x": 5, "y": 0}, {"x": 5, "y": 5}, {"x": 0, "y": 5}]);
        let cases: Vec<(&str, Value, &str)> = vec![
            ("taper", json!(0.5), "tapered"),
            ("brep", json!({"spec": {"kind": "sphere"}, "origin": {"x": 0, "y": 0}}), "brep"),
            ("cornerRadius", json!(0.5), "rounded"),
            ("operation", json!("subtract"), "subtract"),
            ("baseOffset", json!(1.2), "base"),
            ("height", json!(0.2), "height"),
            ("height", json!(5000.0), "height"),
            ("points", json!([{"x": 0, "y": 0}, {"x": 5, "y": 5}, {"x": 5, "y": 0}, {"x": 0, "y": 5}]), "outline"),
            ("points", json!([{"x": 0, "y": 0}, {"x": 5, "y": 0}, {"x": 10, "y": 0}]), "outline"),
            ("id", json!("anders"), "none"),
        ];
        for (k, v, code) in cases {
            let mut sd = solid(rect.clone(), 6.0);
            sd[k] = v;
            let r = root(json!({"extrudedSolids": [sd]}));
            assert_eq!(check_of(&r), json!({"ok": false, "reason": code}), "{k}");
            assert!(run(&r).is_empty(), "{k}");
        }
        // Quader und Zylinder aus dem Befehl „Körper“ sind Prismen und gelten; Kegel nicht.
        let mut sd = solid(rect.clone(), 6.0);
        sd["brep"] = json!({"spec": {"kind": "cuboid", "min": [0, 0, 0], "max": [5, 5, 6]}, "origin": {"x": 0, "y": 0}, "label": "Quader"});
        assert_eq!(check_of(&root(json!({"extrudedSolids": [sd.clone()]})))["ok"], true);
        sd["brep"]["spec"] = json!({"kind": "cylinder", "cx": 2.5, "cy": 2.5, "z0": 0, "r": 2.5, "height": 6});
        assert_eq!(check_of(&root(json!({"extrudedSolids": [sd.clone()]})))["ok"], true);
        sd["brep"]["spec"]["kind"] = json!("cone");
        assert_eq!(check_of(&root(json!({"extrudedSolids": [sd]})))["reason"], "brep");
        // Körper auf dem OG (UK 3 m) und auf der Stapel-OK (6 m, versetzt): gültig.
        for off in [3.0, 6.0] {
            let mut sd = solid(rect.clone(), 3.0);
            sd["baseOffset"] = json!(off);
            assert_eq!(check_of(&root(json!({"extrudedSolids": [sd]})))["ok"], true, "{off}");
        }
    }
}
