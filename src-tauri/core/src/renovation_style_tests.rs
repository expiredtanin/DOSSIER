//! [275] Umbau-Farben: gedämpfte Vorgabe, Stift statt Farbe (aktiver Stiftsatz), eigene Farben je Etappe.

use super::tests::{fills_of, plan_with, project, umbau_fixture};
use super::*;
use serde_json::{json, Value};

/// Fixture mit zwei Stiftsätzen (Farbe und S/W) und Stiften 7 (Füllung) und 8 (Linie).
fn with_pens(mut v: Value, active: &str) -> Value {
    v["pens"] = json!([{"id": "7", "name": "Umbau Neu"}, {"id": "8", "name": "Umbau Linie"}]);
    v["penSets"] = json!([
        {"id": "farbe", "name": "Farbe", "pens": {"7": {"color": "#3366cc", "weight": 0.25}, "8": {"color": "#112244", "weight": 0.35}}},
        {"id": "sw", "name": "Plot S/W", "pens": {"7": {"color": "#bbbbbb", "weight": 0.25}, "8": {"color": "#000000", "weight": 0.35}}}
    ]);
    v["activePenSetId"] = json!(active);
    v
}

#[test]
fn gedaempfte_vorgabe() {
    // Abbruch ruhiges Ocker, Neu gedämpftes Ziegelrot mit dunklerer Linie, Bestand unverändert grau.
    let d = default_style(RenovationStatus::Demolish);
    let n = default_style(RenovationStatus::New);
    assert_eq!((d.fill.as_str(), d.line.as_deref(), d.dashed), (DEMOLISH_FILL, None, true));
    assert_eq!((n.fill.as_str(), n.line.as_deref(), n.dashed), (NEW_FILL, Some(NEW_LINE), false));
    assert_eq!(default_style(RenovationStatus::Existing).fill, "#a6a6a6");
    // Nicht mehr die leuchtenden Werte.
    for c in [&d.fill, &n.fill, n.line.as_ref().unwrap()] {
        assert!(!["#ffd800", "#e3001b", "#c00016"].contains(&c.as_str()), "{c}");
    }
}

#[test]
fn stift_statt_farbe_folgt_dem_aktiven_stiftsatz() {
    let mut v = with_pens(umbau_fixture(), "farbe");
    v["renovation"]["styles"] = json!({"new": {"fill": "#ff00ff", "fillPen": "7", "linePen": "8"}});
    let p = project(&v);
    let s = style(&p, RenovationStatus::New);
    // Stift geht der freien Farbe vor.
    assert_eq!((s.fill.as_str(), s.line.as_deref()), ("#3366cc", Some("#112244")));
    // Anderer Stiftsatz aktiv: die Umbau-Farbe wechselt mit.
    let p = project(&with_pens(v.clone(), "sw"));
    let s = style(&p, RenovationStatus::New);
    assert_eq!((s.fill.as_str(), s.line.as_deref()), ("#bbbbbb", Some("#000000")));
    // Im Plan: W9 (Neu) in der Stift-Farbe.
    let u = plan_with(&p, json!({"renovation": "umbauplan"}));
    assert!(fills_of(&u, "W9").iter().any(|f| f == "#bbbbbb"), "{:?}", fills_of(&u, "W9"));
    // Stift ohne Eintrag im aktiven Satz bzw. ohne aktiven Satz: freie Farbe, sonst Vorgabe.
    let mut w = v.clone();
    w["activePenSetId"] = json!("fehlt");
    let p = project(&w);
    assert_eq!(style(&p, RenovationStatus::New).fill, "#ff00ff");
    assert_eq!(style(&p, RenovationStatus::New).line.as_deref(), Some(NEW_LINE));
    w["renovation"]["styles"]["new"] = json!({"fillPen": "99"});
    w["activePenSetId"] = json!("farbe");
    assert_eq!(style(&project(&w), RenovationStatus::New).fill, NEW_FILL);
}

#[test]
fn eigene_farbe_je_etappe() {
    let mut v = umbau_fixture();
    // W9 ist Neu in Etappe 2; Etappe 2 bekommt Blau (nur Füllung), Etappe 1 nichts Eigenes.
    v["renovation"]["phases"][1]["styles"] = json!({"new": {"fill": "#2f6db5"}, "demolish": {"dashed": false}});
    // Eine zweite neue Wand ohne Etappe behält die Projektfarbe.
    for w in v["walls"].as_array_mut().unwrap() {
        if w["id"] == "W3" {
            w["renovation"] = json!({"status": "new"});
        }
    }
    let p = project(&v);
    let view = View::new(&p, Some("umbauplan"), None).unwrap();
    let r = view.resolve(&p);
    assert_eq!(r.styled["W9"].fill, "#2f6db5");
    // Fehlende Felder der Etappe: Linie aus dem Projekt bzw. der Vorgabe.
    assert_eq!(r.styled["W9"].line.as_deref(), Some(NEW_LINE));
    assert_eq!(r.styled["W3"].fill, NEW_FILL);
    // Abbruch ohne Etappe bleibt gestrichelt.
    assert!(r.styled["W2"].dashed);
    // Farben, die in Schwarz-Weiss erhalten bleiben, enthalten die der Etappe.
    assert!(view.colors().contains(&"#2f6db5".to_string()));
    // Cache-Schlüssel ändert sich mit der Etappen-Farbe.
    let mut v2 = v.clone();
    v2["renovation"]["phases"][1]["styles"]["new"]["fill"] = json!("#000080");
    assert_ne!(view.key(), View::new(&project(&v2), Some("umbauplan"), None).unwrap().key());
    // Im Grundriss.
    let u = plan_with(&p, json!({"renovation": "umbauplan"}));
    assert!(fills_of(&u, "W9").iter().any(|f| f == "#2f6db5"), "{:?}", fills_of(&u, "W9"));
    // Filter bis Etappe 2 zeigt W9 als Neu der Etappe (eigene Farbe); im Stand einer späteren Etappe ist es Bestand.
    let r = View::new(&p, Some("umbauplan"), Some("e2")).unwrap().resolve(&p);
    assert_eq!(r.styled["W9"].fill, "#2f6db5");
    let mut v3 = v.clone();
    v3["renovation"]["phases"].as_array_mut().unwrap().push(json!({"id": "e3", "name": "Etappe 3"}));
    let p3 = project(&v3);
    let r = View::new(&p3, Some("umbauplan"), Some("e3")).unwrap().resolve(&p3);
    assert_eq!(r.styled["W9"], style(&p3, RenovationStatus::Existing));
}

#[test]
fn etappe_mit_stift_und_ersatzstueck() {
    let mut v = with_pens(umbau_fixture(), "farbe");
    // O1 (neue Öffnung in Bestandswand W1) in Etappe 2: ihr Abbruch-Stück nimmt die Abbruch-Farbe der Etappe.
    for o in v["openings"].as_array_mut().unwrap() {
        if o["id"] == "O1" {
            o["renovation"] = json!({"status": "new", "phase": "e2"});
        }
    }
    v["renovation"]["phases"][1]["styles"] = json!({"demolish": {"fillPen": "7"}});
    let p = project(&v);
    let r = View::new(&p, Some("umbauplan"), None).unwrap().resolve(&p);
    let o1 = r.patches.iter().find(|x| x.opening_id == "O1").unwrap();
    assert_eq!(o1.style.fill, "#3366cc");
    // O2 (ohne Etappe) behält die Projekt-Vorgabe.
    let o2 = r.patches.iter().find(|x| x.opening_id == "O2").unwrap();
    assert_eq!(o2.style.fill, NEW_FILL);
}

#[test]
fn unsinn_robust() {
    let mut v = umbau_fixture();
    v["renovation"]["styles"] = json!({"new": {"fill": "  ", "fillPen": "", "linePen": "   "}, "demolish": {"fillPen": null}});
    v["renovation"]["phases"][0]["styles"] = json!({"new": {"fillPen": "x", "fill": ""}});
    v["penSets"] = json!([{"id": "a", "name": "A", "pens": {"x": {"color": "", "weight": 0.1}}}]);
    v["activePenSetId"] = json!("a");
    let p = project(&v);
    assert_eq!(style(&p, RenovationStatus::New).fill, NEW_FILL);
    assert_eq!(style(&p, RenovationStatus::Demolish).fill, DEMOLISH_FILL);
    let view = View::new(&p, Some("umbauplan"), None).unwrap();
    let _ = view.resolve(&p);
    let _ = plan_with(&p, json!({"renovation": "umbauplan"}));
}

#[test]
fn abfrage_renovation_styles() {
    let mut v = with_pens(umbau_fixture(), "farbe");
    v["renovation"]["phases"][1]["styles"] = json!({"new": {"fillPen": "7"}});
    let p = project(&v);
    let out: Value = serde_json::from_str(&crate::queries::run(&p, "renovationStyles", &[], "").unwrap()).unwrap();
    assert_eq!(out["defaults"]["demolish"]["fill"], DEMOLISH_FILL);
    assert_eq!(out["project"]["new"]["fill"], NEW_FILL);
    assert_eq!(out["project"]["demolish"]["dashed"], true);
    assert_eq!(out["phases"]["e2"]["new"]["fill"], "#3366cc");
    assert!(out["phases"].get("e1").is_none());
}
