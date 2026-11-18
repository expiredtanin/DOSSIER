//! [286] Ecken sanierter Wände: die bleibende Tragschicht (Beton) läuft durch, Abbruch und Neu enden rechtwinklig an
//! ihr — in jedem Umbaufilter, im Grundriss wie in der Verschneidung für 3D/Schnitt.

use super::build_up::*;
use super::tests::project;
use super::*;
use serde_json::{json, Value};

fn l(c: &str, t: f64) -> Layer {
    Layer { component_id: c.into(), thickness: t, ..Default::default() }
}

/// Beispielhaus: Südwand W1 = Bestand Putz 2 + Dämmung 10 + Beton 20 (saniert: Dämmung 20), Ostwand W2 bleibt („aw“).
fn fixture(renovated: bool) -> Value {
    let mut v: Value = serde_json::from_str(include_str!("../tests/fixtures/sample_project.json")).unwrap();
    let lay = |ls: Vec<Layer>| serde_json::to_value(ls).unwrap();
    let alt = vec![l("render-ext", 0.02), l("insulation", 0.10), l("concrete", 0.20)];
    let neu = vec![l("render-ext", 0.02), l("insulation", 0.20), l("concrete", 0.20)];
    v["wallTypes"].as_array_mut().unwrap().push(json!({"id": "alt", "name": "AW Bestand", "layers": lay(alt), "renovationTarget": "neu"}));
    v["wallTypes"].as_array_mut().unwrap().push(json!({"id": "neu", "name": "AW saniert", "layers": lay(neu)}));
    for w in v["walls"].as_array_mut().unwrap() {
        if w["id"] == "W1" {
            w["wallTypeId"] = json!("alt");
            if renovated {
                w["renovation"] = json!({"status": "existing", "renovated": true});
            }
        }
    }
    v
}

/// Schnitte von W1 in der Darstellung `filter` (Verschneidung wie 3D/Schnitt).
fn w1_cuts(p: &Project, filter: &str) -> crate::joins::WallCuts {
    let q = with_build_ups(p, if filter.is_empty() { None } else { View::new(p, Some(filter), None) });
    let idx: Vec<usize> = (0..q.walls.len()).filter(|&i| q.walls[i].floor_id == "eg").collect();
    let (jw, finite) = crate::model3d::floor_join_input(&q, &idx);
    let cuts = crate::model3d::floor_join_cuts(&jw, finite);
    cuts[idx.iter().position(|&i| q.walls[i].id == "W1").unwrap()].clone()
}

#[test]
fn ecke_saniert_abbruch_endet_rechtwinklig_am_beton() {
    let p = project(&fixture(true));
    for f in ["", "bestand", "abbruch", "neubau", "umbauplan", "endzustand"] {
        let c = w1_cuts(&p, f);
        let lc = c.layer_cuts.as_ref().unwrap_or_else(|| panic!("{f}: Schicht-Schnitte"));
        // W1 endet bei x = 5 an W2 (Backstein aussen bei x = 4.9925): jede Schicht senkrecht, bündig mit dem Beton.
        for (i, cut) in lc.end.iter().enumerate() {
            let cut = cut.unwrap_or_else(|| panic!("{f}: Schicht {i}"));
            assert!(cut.dir.x.abs() < 1e-9 && (cut.point.x - 4.9925).abs() < 1e-9, "{f} Schicht {i}: {cut:?}");
        }
    }
    // Ohne Sanierung: Gehrung wie bisher.
    let c = w1_cuts(&project(&fixture(false)), "");
    assert!(c.layer_cuts.is_none());
    let m = c.end_cut.unwrap();
    assert!(m.dir.x.abs() > 1e-6 && m.dir.y.abs() > 1e-6);
}

fn plan(p: &Project, filter: &str) -> Vec<Primitive> {
    let codes: Vec<String> = (0..100).map(|k| format!("{k:02}")).collect();
    let t = json!({"floor": "eg", "show": codes, "scale": 50, "renovation": filter}).to_string();
    crate::plan::domains::plan_domains(p, &crate::plan::domains::PlanArgs::parse_in(p, 1.0, &t).unwrap()).unwrap().walls
}

/// Kanten der Flächen mit Füllung `fill` an der Ecke W1/W2 (x > 4.5, y < 0.3), die weder waagrecht noch senkrecht sind.
fn slanted(prims: &[Primitive], fill: &str) -> Vec<(Vec2, Vec2)> {
    let mut out = Vec::new();
    for q in prims {
        if let Primitive::Polygon { pts, fill: f, .. } = q {
            if f != fill {
                continue;
            }
            for i in 0..pts.len() {
                let (a, b) = (pts[i], pts[(i + 1) % pts.len()]);
                let near = |v: Vec2| v.x > 4.5 && v.y < 0.3;
                if near(a) && near(b) && (a.x - b.x).abs() > 1e-6 && (a.y - b.y).abs() > 1e-6 {
                    out.push((a, b));
                }
            }
        }
    }
    out
}

#[test]
fn grundriss_ohne_schraegen_abbruch_an_der_ecke() {
    let yellow = default_style(RenovationStatus::Demolish).fill;
    let red = default_style(RenovationStatus::New).fill;
    let p = project(&fixture(true));
    let a = plan(&p, "abbruch");
    assert!(a.iter().any(|q| matches!(q, Primitive::Polygon { fill, .. } if *fill == yellow)), "Abbruch gelb");
    assert_eq!(slanted(&a, &yellow), vec![], "Abbruch-Schichten an der Ecke rechtwinklig");
    let n = plan(&p, "neubau");
    assert_eq!(slanted(&n, &red), vec![], "neue Schichten an der Ecke rechtwinklig");
    // Stirnlinie der Abbruch-Dämmung an der Ecke gestrichelt (senkrecht bei x = 4.9925).
    let dashed_end = a.iter().any(|q| matches!(q, Primitive::Line { a, b, dash: Some(Some(_)), .. } if (a.x - 4.9925).abs() < 1e-6 && (b.x - 4.9925).abs() < 1e-6 && a.y.min(b.y) < -0.05));
    assert!(dashed_end, "gestrichelte Stirnlinie des Abbruchs");
}

#[test]
fn dominante_schicht_im_typ_paar() {
    let mut v = fixture(true);
    let q = |p: &Project| pair_json(p, &json!({"type": "alt"}).to_string());
    let p = project(&v);
    assert_eq!((q(&p)["core"].clone(), q(&p)["coreAuto"].clone(), q(&p)["coreSet"].clone()), (json!(2), json!(2), Value::Null));
    // Eine abgebrochene Schicht kann nicht dominant sein: Vorgabe bleibt.
    v["wallTypes"].as_array_mut().unwrap().iter_mut().find(|t| t["id"] == "alt").unwrap()["renovationCore"] = json!(1);
    let p = project(&v);
    assert_eq!(q(&p)["core"], json!(2));
    let w1 = p.walls.iter().find(|w| w.id == "W1").unwrap();
    assert_eq!(corner_core(&p, w1), Some(Some(2)));
    // Manuell „bleibt“ für die Dämmung: dann ist sie wählbar und die Ecke richtet sich nach ihr.
    let t = v["wallTypes"].as_array_mut().unwrap().iter_mut().find(|t| t["id"] == "alt").unwrap();
    t["renovationOld"] = json!(["auto", "existing", "auto"]);
    let p = project(&v);
    assert_eq!((q(&p)["core"].clone(), q(&p)["coreSet"].clone()), (json!(1), json!(1)));
    let w1 = p.walls.iter().find(|w| w.id == "W1").unwrap();
    assert_eq!(corner_core(&p, w1), Some(Some(1)));
}
