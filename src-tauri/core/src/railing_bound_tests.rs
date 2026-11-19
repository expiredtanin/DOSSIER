//! [291] Geländer-Aufbau je Feld (Pfosten, Handlauf, Zwischenholme, Füllung je Feld) und gebundene Geländer (Treppe,
//! Deckenkante): Pfostenverteilung, Ecken, Treppe bzw. Decke ändern ⇒ Geländer folgt, Treppen-Handlauf nicht doppelt,
//! Rundreise Projektdatei.

use super::*;
use serde_json::{json, Value};

fn project(rails: Value) -> Project {
    serde_json::from_value(json!({
        "id": "p", "name": "P", "lineStyles": [], "hatches": [], "components": [], "wallTypes": [],
        "layers": [{"code": "41", "name": "Geländer", "color": "#102030", "lw": 0.25, "visible": true, "locked": false}],
        "drawingLevels": [{"id": "eg", "name": "EG", "kind": "floor", "visible": true, "locked": false, "floorHeight": 2.8, "cutHeight": 1.0, "baseElevation": 0.0},
                          {"id": "og", "name": "OG", "kind": "floor", "visible": true, "locked": false, "floorHeight": 2.8, "cutHeight": 1.0, "baseElevation": 3.0}],
        "walls": [], "openings": [], "drawings2d": [],
        "stairTypes": [{"id": "st", "name": "Beton", "structure": "beton", "closedRisers": true, "treadThickness": 0.04, "railing": "beide", "defaultWidth": 1.2}],
        "stairs": [{"id": "t1", "type": "stair", "floorId": "eg", "categoryCode": "40", "shape": "straight", "start": {"x": 0, "y": 0}, "dir": {"x": 1, "y": 0}, "runLength": 4.2, "width": 1.2, "stepCount": 16, "typeId": "st"}],
        "ceilings": [{"id": "b1", "type": "ceiling", "floorId": "eg", "categoryCode": "30", "outline": [{"x": 10, "y": 0}, {"x": 14, "y": 0}, {"x": 14, "y": 2}, {"x": 10, "y": 2}], "thickness": 0.2}],
        "railings": rails
    }))
    .unwrap()
}

fn rail(extra: Value) -> Value {
    let mut r = json!({"id": "g", "type": "railing", "floorId": "eg", "categoryCode": "41", "points": [{"x": 0, "y": 0}, {"x": 4, "y": 0}], "height": 1.0, "kind": "bars"});
    for (k, v) in extra.as_object().unwrap() {
        r[k] = v.clone();
    }
    r
}

fn n(pcs: &[Piece], part: Part) -> usize {
    pcs.iter().filter(|q| q.part == part).count()
}

fn center(q: &Piece) -> P {
    let k = q.outline.len() as f64;
    [q.outline.iter().map(|v| v[0]).sum::<f64>() / k, q.outline.iter().map(|v| v[1]).sum::<f64>() / k]
}

#[test]
fn pfosten_verteilung_abstand_und_querschnitt() {
    // 4 m mit Abstand höchstens 1.0 → 4 Felder, 5 Pfosten; mit 1.5 → 3 Felder, 4 Pfosten.
    let p = project(json!([rail(json!({"postSpacing": 1.0, "postSize": 0.05}))]));
    let r = &p.railings.as_ref().unwrap()[0];
    let pcs = pieces(&p, r);
    assert_eq!(n(&pcs, Part::Post), 5);
    let post = pcs.iter().find(|q| q.part == Part::Post).unwrap();
    assert!((area(&post.outline) - 0.0025).abs() < 1e-9);
    let p = project(json!([rail(json!({"postSpacing": 1.5}))]));
    assert_eq!(n(&pieces(&p, &p.railings.as_ref().unwrap()[0]), Part::Post), 4);
    // Glas ohne Angabe: keine Pfosten; mit `posts` ja (4 m, Vorgabe 1.20 → 4 Felder, 5 Pfosten).
    let p = project(json!([rail(json!({"kind": "glass"})), rail(json!({"id": "h", "kind": "glass", "posts": true}))]));
    let rs = p.railings.as_ref().unwrap();
    assert_eq!(n(&pieces(&p, &rs[0]), Part::Post), 0);
    assert_eq!(n(&pieces(&p, &rs[1]), Part::Post), 5);
    assert_eq!(info(&p, "h").unwrap()["fields"], json!(4));
}

#[test]
fn pfosten_an_ecken_und_enden() {
    // L-Zug 2 m + 1 m: Ecke und beide Enden tragen einen Pfosten; 2 m → 2 Felder, 1 m → 1 Feld: 4 Pfosten.
    let p = project(json!([rail(json!({"points": [{"x": 0, "y": 0}, {"x": 2, "y": 0}, {"x": 2, "y": 1}]}))]));
    let pcs = pieces(&p, &p.railings.as_ref().unwrap()[0]);
    let centers: Vec<P> = pcs.iter().filter(|q| q.part == Part::Post).map(center).collect();
    assert_eq!(centers.len(), 4);
    for want in [[0.0, 0.0], [2.0, 0.0], [2.0, 1.0]] {
        assert!(centers.iter().any(|c| (c[0] - want[0]).abs() < 1e-9 && (c[1] - want[1]).abs() < 1e-9), "{want:?} {centers:?}");
    }
}

#[test]
fn handlauf_rund_hoehe_und_zwischenholme() {
    let p = project(json!([rail(json!({"kind": "glass", "handrailProfile": "round", "handrailHeight": 1.1, "midRails": 2}))]));
    let pcs = pieces(&p, &p.railings.as_ref().unwrap()[0]);
    // Rund: drei Stufen; Oberkante 1.1, Glas bis 1.06 (unter dem Handlauf obenauf).
    assert_eq!(n(&pcs, Part::Rail), 3);
    let top = pcs.iter().map(|q| q.z1).fold(f64::MIN, f64::max);
    assert!((top - 1.1).abs() < 1e-9, "{top}");
    let fill = pcs.iter().find(|q| q.part == Part::Fill).unwrap();
    assert!((fill.z1 - 1.06).abs() < 1e-9, "{}", fill.z1);
    assert_eq!(n(&pcs, Part::Mid), 2);
    // Handlauf tiefer als die Füllung: Füllung bis `height`.
    let p = project(json!([rail(json!({"kind": "solid", "handrail": true, "handrailHeight": 0.9}))]));
    let pcs = pieces(&p, &p.railings.as_ref().unwrap()[0]);
    assert!((pcs.iter().find(|q| q.part == Part::Fill).unwrap().z1 - 1.0).abs() < 1e-9);
    assert!((pcs.iter().find(|q| q.part == Part::Rail).unwrap().z1 - 0.9).abs() < 1e-9);
}

#[test]
fn fuellung_je_feld() {
    // Stabgeländer 4 m (4 Felder à 1 m), Feld 1 Glas, Feld 3 Brüstung: Stäbe nur in den Feldern 0 und 2.
    let p = project(json!([rail(json!({"postSpacing": 1.0, "fields": [{"index": 1, "kind": "glass"}, {"index": 3, "kind": "solid"}]}))]));
    let pcs = pieces(&p, &p.railings.as_ref().unwrap()[0]);
    let fills: Vec<&Piece> = pcs.iter().filter(|q| q.part == Part::Fill).collect();
    assert_eq!(fills.len(), 2);
    let xr = |q: &Piece| q.outline.iter().fold((f64::MAX, f64::MIN), |(a, b), v| (a.min(v[0]), b.max(v[0])));
    let g = fills.iter().find(|q| q.kind == RailingKind::Glass).unwrap();
    assert!((xr(g).0 - 1.0).abs() < 1e-9 && (xr(g).1 - 2.0).abs() < 1e-9, "{:?}", xr(g));
    let s = fills.iter().find(|q| q.kind == RailingKind::Solid).unwrap();
    assert!((xr(s).0 - 3.0).abs() < 1e-9);
    assert!(n(&pcs, Part::Bar) > 10);
    for b in pcs.iter().filter(|q| q.part == Part::Bar) {
        let x = center(b)[0];
        assert!(x < 1.0 || (2.0..3.0).contains(&x), "{x}");
    }
    // Fussschiene nur unter Stäben.
    assert!(pcs.iter().filter(|q| q.part == Part::Foot).all(|q| xr(q).1 <= 1.0 + 1e-9 || (xr(q).0 >= 2.0 - 1e-9 && xr(q).1 <= 3.0 + 1e-9)));
    // Ohne Abweichung je Feld: dieselben Teile wie vor [291] (ein Streifen je Teilstrecke).
    let p = project(json!([rail(json!({}))]));
    let pcs = pieces(&p, &p.railings.as_ref().unwrap()[0]);
    assert_eq!((n(&pcs, Part::Foot), n(&pcs, Part::Rail), n(&pcs, Part::Fill), n(&pcs, Part::Mid)), (1, 1, 0, 0));
}

fn stair_rail(side: &str) -> Value {
    rail(json!({"id": "gt", "stairId": "t1", "stairSide": side, "points": [{"x": 0, "y": 0}, {"x": 1, "y": 0}]}))
}

#[test]
fn treppe_bindet_achse_und_steigung() {
    let mut p = project(json!([stair_rail("left")]));
    let r = p.railings.as_ref().unwrap()[0].clone();
    let path = path(&p, &r).unwrap();
    assert_eq!(path.bound, Bound::Stair);
    assert!(path.sloped());
    // Achse längs der linken Wange (y > 0 bei Laufrichtung +x), Fuss steigt von etwa 0 auf etwa 2.8.
    assert!(path.pts.iter().all(|q| q[1] > 0.4), "{:?}", path.pts);
    let (lo, hi) = (path.foot.iter().cloned().fold(f64::MAX, f64::min), path.foot.iter().cloned().fold(f64::MIN, f64::max));
    assert!(lo < 0.4 && hi > 2.4, "{lo} {hi}");
    // Höhe lotrecht über der Stufenkante: Pfosten stehen auf dem Fuss, Oberkante = Fuss + Höhe.
    let pcs = pieces(&p, &r);
    assert!(n(&pcs, Part::Post) >= 4);
    assert!(pcs.iter().filter(|q| q.part == Part::Rail).any(|q| q.slope.is_some()));
    for q in pcs.iter().filter(|q| q.part == Part::Post) {
        let c = center(q);
        let s = path.pts.windows(2).scan(0.0, |acc, w| {
            let l = seg_len(w[0], w[1]);
            let t = ((c[0] - w[0][0]) * (w[1][0] - w[0][0]) + (c[1] - w[0][1]) * (w[1][1] - w[0][1])) / (l * l);
            let here = (0.0..=1.0).contains(&t).then(|| *acc + t * l);
            *acc += l;
            Some(here)
        }).flatten().next().unwrap();
        assert!((q.z0 - path.foot_at(s)).abs() < 1e-9);
    }
    let len0 = length(&path.pts);
    // Treppe ändern (länger, anders gerichtet) ⇒ Geländer folgt.
    {
        let s = &mut p.stairs.as_mut().unwrap()[0];
        s.run_length = 5.0;
        s.dir = Vec2 { x: 0.0, y: 1.0 };
    }
    let path2 = super::path(&p, &r).unwrap();
    assert!(path2.pts.iter().all(|q| q[0] < -0.4), "{:?}", path2.pts);
    assert!(length(&path2.pts) > len0 + 0.5);
    // Rechte Seite: andere Wange.
    let p = project(json!([stair_rail("right")]));
    let path = super::path(&p, &p.railings.as_ref().unwrap()[0]).unwrap();
    assert!(path.pts.iter().all(|q| q[1] < -0.4));
    // Treppe fehlt: Ersatz `points`, waagrecht.
    let p = project(json!([rail(json!({"stairId": "weg"}))]));
    let path = super::path(&p, &p.railings.as_ref().unwrap()[0]).unwrap();
    assert_eq!(path.bound, Bound::Free);
    assert!(!path.sloped());
}

#[test]
fn treppen_handlauf_nicht_doppelt() {
    let p0 = project(json!([]));
    assert_eq!(stair_code(&p0, &p0.stairs.as_ref().unwrap()[0]), 3);
    let p = project(json!([stair_rail("left")]));
    assert_eq!(stair_code(&p, &p.stairs.as_ref().unwrap()[0]), 2);
    let p = project(json!([stair_rail("left"), rail(json!({"id": "g2", "stairId": "t1", "stairSide": "right"}))]));
    assert_eq!(stair_code(&p, &p.stairs.as_ref().unwrap()[0]), 0);
    // 3D: ohne gebundene Geländer Handlauf-Rohre der Treppe, mit beiden Seiten gebunden keine mehr.
    assert!(!crate::model3d::emit_stair_handrails(&p0).is_empty());
    assert!(crate::model3d::emit_stair_handrails(&p).is_empty());
}

#[test]
fn deckenkante_bindet_und_folgt() {
    let mut p = project(json!([rail(json!({"id": "gb", "floorId": "og", "ceilingId": "b1", "edgeIndex": 0, "edgeCount": 3}))]));
    let r = p.railings.as_ref().unwrap()[0].clone();
    let path = path(&p, &r).unwrap();
    assert_eq!(path.bound, Bound::Edge);
    // Kanten 0..2: (10,0)→(14,0)→(14,2)→(10,2), um 5 cm nach innen.
    assert_eq!(path.pts.len(), 4);
    assert!((path.pts[0][1] - 0.05).abs() < 1e-9 && (path.pts[1][0] - 13.95).abs() < 1e-9 && (path.pts[3][1] - 1.95).abs() < 1e-9, "{:?}", path.pts);
    // Fuss auf der Deckenoberkante (EG 0 + 2.8).
    let s = spec(&p, &r).unwrap();
    assert!((s.z0 - 2.8).abs() < 1e-9, "{}", s.z0);
    // Pfosten an allen Ecken und Enden.
    let posts: Vec<P> = pieces(&p, &r).iter().filter(|q| q.part == Part::Post).map(center).collect();
    for c in &path.pts {
        assert!(posts.iter().any(|q| (q[0] - c[0]).abs() < 1e-9 && (q[1] - c[1]).abs() < 1e-9), "{c:?}");
    }
    // Decke ändern ⇒ Geländer folgt.
    p.ceilings.as_mut().unwrap()[0].outline[1].x = 16.0;
    p.ceilings.as_mut().unwrap()[0].outline[2].x = 16.0;
    let path2 = super::path(&p, &r).unwrap();
    assert!((path2.pts[1][0] - 15.95).abs() < 1e-9);
    // Alle Kanten: geschlossen.
    let p = project(json!([rail(json!({"ceilingId": "b1", "edgeIndex": 2, "edgeCount": 4}))]));
    assert!(is_closed(&super::path(&p, &p.railings.as_ref().unwrap()[0]).unwrap().pts));
}

#[test]
fn grundriss_treppe_ueber_schnitt_gestrichelt() {
    use crate::plan::domains::{plan_domains, PlanArgs};
    use crate::plan::prim::Primitive;
    let p = project(json!([stair_rail("left")]));
    let text = json!({"floor": "eg", "show": ["41"], "scale": 50, "global": true}).to_string();
    let prims = plan_domains(&p, &PlanArgs::parse(50.0, &text).unwrap()).unwrap().columns;
    let lines: Vec<bool> = prims.iter().filter_map(|q| match q {
        Primitive::Line { cls, dash, .. } if cls == "railing-bars" => Some(matches!(dash, Some(Some(_)))),
        _ => None,
    }).collect();
    // Unter der Schnitthöhe (Fuss < 1.0) ausgezogen, darüber gestrichelt.
    assert!(lines.iter().any(|d| !d) && lines.iter().any(|d| *d), "{lines:?}");
    assert!(prims.iter().any(|q| matches!(q, Primitive::Polygon { context_object_id: Some(id), .. } if id == "@railing:gt")));
}

#[test]
fn befehl_an_treppe_und_kante() {
    let p = project(json!([]));
    let root: serde_json::Map<String, Value> = serde_json::from_value(serde_json::to_value(&p).unwrap()).unwrap();
    let ops = |pt: [f64; 2]| crate::cmd_create::ops(&root, &p, &json!({"cmd": "railing", "bind": true, "pts": [pt], "kind": "glass", "ctx": {"level": "eg", "floorHeight": 2.8, "cat": "20", "wallType": "t"}, "stamp": "s"})).unwrap();
    let item = |o: Vec<crate::ops::Op>| match o.into_iter().next() {
        Some(crate::ops::Op::Add { items, .. }) => items[0].clone(),
        other => panic!("erwartet Add, war {other:?}"),
    };
    // Klick nahe der rechten Wange (y ≈ −0.6): rechte Seite der Treppe t1.
    let it = item(ops([2.0, -0.5]));
    assert_eq!((it["stairId"].as_str(), it["stairSide"].as_str(), it["floorId"].as_str()), (Some("t1"), Some("right"), Some("eg")));
    assert!(it["points"].as_array().unwrap().len() >= 2);
    // Klick auf die obere Deckenkante (y = 2, Kante 2).
    let it = item(ops([12.0, 2.1]));
    assert_eq!((it["ceilingId"].as_str(), it["edgeIndex"].as_f64()), (Some("b1"), Some(2.0)));
    // Nichts in Reichweite: keine Op.
    assert!(ops([30.0, 30.0]).is_empty());
}

#[test]
fn rundreise_projektdatei() {
    let p = project(json!([
        stair_rail("right"),
        rail(json!({"id": "gb", "ceilingId": "b1", "edgeIndex": 1, "edgeCount": 2, "edgeInset": 0.1, "posts": true, "postSpacing": 1.1, "postSize": 0.04, "midRails": 3, "handrailProfile": "round", "handrailHeight": 0.95, "fields": [{"index": 0, "kind": "glass"}]}))
    ]));
    let text = serde_json::to_string(&p).unwrap();
    let back: Project = serde_json::from_str(&text).unwrap();
    assert_eq!(back.railings, p.railings);
    let v: Value = serde_json::from_str(&text).unwrap();
    let r = &v["railings"][1];
    assert_eq!((r["ceilingId"].as_str(), r["edgeCount"].as_u64(), r["handrailProfile"].as_str(), r["fields"][0]["kind"].as_str()), (Some("b1"), Some(2), Some("round"), Some("glass")));
    assert_eq!(v["railings"][0]["stairSide"], json!("right"));
    // Über das Projektformat des Kerns (Laden, Migration, Prüfung).
    let crate::project_format::Parsed::Ok { project, .. } = crate::project_format::parse_project_file(&text, 0.0) else { panic!("nicht geladen") };
    assert_eq!(project.get("railings"), v.get("railings"));
}
