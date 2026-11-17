//! [271][272] Exporte und Rendering folgen dem Umbaufilter und der Variantenkombination der Ansicht: Cycles-Szene, IFC, Netz-Exporte
//! (Text der Abfrage = `{"renovation", "renovationPhase", "designOptions", …}`), Umbau-Farben im Bild nur auf Wunsch.

use super::*;
use serde_json::{json, Value};

/// Musterhaus mit Umbau-Angaben (W2 Abbruch, W9 Neu Etappe 2) und Satz „Dachform“: W2 in A (Haupt), W9 und Dach RF1 in B.
fn fixture() -> Project {
    let mut v = crate::renovation::tests::umbau_fixture();
    v["designOptionSets"] = json!([{"id": "dach", "name": "Dachform", "options": [{"id": "a", "name": "A"}, {"id": "b", "name": "B"}], "primary": "a"}]);
    for (coll, id, opt) in [("walls", "W2", "a"), ("walls", "W9", "b"), ("roofs", "RF1", "b")] {
        for x in v[coll].as_array_mut().unwrap() {
            if x["id"] == id {
                x["designOption"] = json!({"set": "dach", "option": opt});
            }
        }
    }
    serde_json::from_value(v).unwrap()
}

fn scene(p: &Project, text: &str) -> Value {
    serde_json::from_str(&run(p, "cyclesScene", &[], text).unwrap()).unwrap()
}

fn triangles(p: &Project, extra: Value) -> u64 {
    let mut t = json!({"width": 64, "height": 36, "samples": 1, "context": false});
    for (k, x) in extra.as_object().unwrap() {
        t[k] = x.clone();
    }
    scene(p, &t.to_string())["triangles"].as_u64().unwrap()
}

#[test]
fn cycles_szene_ohne_ausgeblendete_elemente() {
    let p = fixture();
    // Ohne Filter: Hauptvariante A (W2 da, W9 und Dach fehlen).
    let alle = triangles(&p, json!({}));
    // Abbruch-Wand W2 fehlt im Endzustand.
    let end = triangles(&p, json!({"renovation": "endzustand"}));
    assert!(end < alle, "Endzustand {end} < ohne Filter {alle}");
    // Bestand: nur Bestehendes (kein Neues wie W9), W2 steht noch.
    let bestand = triangles(&p, json!({"renovation": "bestand"}));
    assert!(bestand < alle, "Bestand {bestand} < ohne Filter {alle} (Neues fehlt)");
}

#[test]
fn cycles_szene_folgt_der_kombination() {
    let p = fixture();
    let a = triangles(&p, json!({}));
    let b = triangles(&p, json!({"designOptions": {"dach": "b"}}));
    assert_ne!(a, b, "Variante B hat andere Elemente (W9, Dach statt W2)");
    // Text „Satz=Variante“ geht ebenso (Namen).
    assert_eq!(b, triangles(&p, json!({"designOptions": "Dachform=B"})));
    // Umbaufilter und Kombination wirken zusammen: Endzustand in B ohne Abbruch, mit Neuem (W9 Etappe 2).
    let end_b = triangles(&p, json!({"renovation": "endzustand", "designOptions": {"dach": "b"}}));
    assert!(end_b > 0 && end_b <= b);
}

#[test]
fn cycles_umbaufarben_nur_auf_wunsch() {
    let p = fixture();
    let base = json!({"width": 64, "height": 36, "samples": 1, "context": false, "renovation": "umbauplan"});
    let ohne = scene(&p, &base.to_string());
    assert!(!ohne["xml"].as_str().unwrap().contains("Umbau-"), "Vorgabe: Materialfarben");
    let mut mit_opts = base.clone();
    mit_opts["renovationColors"] = json!(true);
    let mit = scene(&p, &mit_opts.to_string());
    let xml = mit["xml"].as_str().unwrap();
    assert!(xml.contains(&format!("Umbau-{}", &crate::renovation::DEMOLISH_FILL[1..])), "Abbruch gelb");
    // Geometrie bleibt gleich.
    assert_eq!(ohne["triangles"], mit["triangles"]);
    // Ohne Filter keine Farben, auch mit dem Schalter.
    let keiner = json!({"width": 64, "height": 36, "samples": 1, "context": false, "renovationColors": true});
    assert!(!scene(&p, &keiner.to_string())["xml"].as_str().unwrap().contains("Umbau-"));
}

fn ifc_len(p: &Project, text: &str) -> usize {
    run_bin(p, "ifcExportData", &[0.0, 0.0, 0.0, 0.0], text).unwrap().len()
}

#[test]
fn ifc_und_netz_folgen_der_ansicht() {
    let p = fixture();
    let alle = ifc_len(&p, "2026-01-01T00:00:00");
    let end = ifc_len(&p, &json!({"iso": "2026-01-01T00:00:00", "renovation": "endzustand"}).to_string());
    assert!(end < alle, "Endzustand ohne Abbruch: {end} < {alle}");
    let a = ifc_len(&p, &json!({"iso": "2026-01-01T00:00:00"}).to_string());
    let b = ifc_len(&p, &json!({"iso": "2026-01-01T00:00:00", "designOptions": {"dach": "b"}}).to_string());
    assert_ne!(a, b, "Kombination wirkt im IFC");
    // Netz-Exporte (glTF/OBJ/STL): gleicher Text.
    let mesh = |t: &str| run_bin(&p, "meshExportData", &[1.0, 0.0, 0.0], t).unwrap().len();
    assert!(mesh(&json!({"renovation": "endzustand"}).to_string()) < mesh(""));
    assert_ne!(mesh(&json!({"designOptions": {"dach": "b"}}).to_string()), mesh(""));
}

fn arr_len(v: &Value, key: &str) -> usize {
    v[key].as_array().map_or(0, |a| a.len())
}

/// 3D-Pick und Explosionsaxonometrie lassen Ausgeblendetes (Umbaufilter, andere Varianten) aus.
#[test]
fn pick_und_explosion_ohne_ausgeblendete() {
    let p = fixture();
    let pick = |t: &str| -> Value { serde_json::from_str(&run(&p, "pickGeometry", &[0.0], t).unwrap()).unwrap() };
    let parts = |t: &str, gap: f64| -> Value { serde_json::from_str(&run(&p, "model3dParts", &[0.0, 1.0, 0.0, 0.0, gap], t).unwrap()).unwrap() };
    let alle = arr_len(&pick(""), "walls");
    assert!(arr_len(&pick(&json!({"renovation": "endzustand"}).to_string()), "walls") < alle, "Pick: abgebrochene Wand nicht anwählbar");
    assert_ne!(arr_len(&pick(&json!({"designOptions": {"dach": "b"}}).to_string()), "walls"), alle, "Pick: Wände anderer Varianten fehlen");
    for gap in [0.0, 3.0] {
        let alle = arr_len(&parts("", gap), "walls");
        assert!(arr_len(&parts(&json!({"renovation": "endzustand"}).to_string(), gap), "walls") < alle, "Teile (Explosion {gap}): Endzustand ohne Abbruchwand");
        assert_ne!(arr_len(&parts(&json!({"designOptions": {"dach": "b"}}).to_string(), gap), "walls"), alle, "Teile (Explosion {gap}): andere Variante");
    }
}
