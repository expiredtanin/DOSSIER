//! Früher `toSection.roof.test.ts` (mehrschichtiges Dach, Nähte deckungsgleicher Teilflächen).

use super::*;

fn project(roof: serde_json::Value, extra: serde_json::Value) -> Project {
    let mut v = serde_json::json!({
        "id": "t", "name": "T", "lineStyles": [], "hatches": [], "components": [], "wallTypes": [],
        "drawingLevels": [], "layers": [], "walls": [], "roofs": [roof]
    });
    for (k, x) in extra.as_object().unwrap() {
        v[k] = x.clone();
    }
    serde_json::from_value(v).unwrap()
}

fn roof(over: serde_json::Value) -> serde_json::Value {
    let mut r = serde_json::json!({
        "id": "R1", "type": "roof", "floorId": "eg", "categoryCode": "35",
        "outline": [{"x": -3, "y": 0}, {"x": 3, "y": 0}, {"x": 3, "y": 4}, {"x": -3, "y": 4}],
        "shape": "sattel", "pitchDeg": 30, "overhang": 0, "ridgeAxis": "x", "baseElevation": 5, "thickness": 0.3
    });
    for (k, x) in over.as_object().unwrap() {
        r[k] = x.clone();
    }
    r
}

fn plane(point: [f64; 3], normal: [f64; 3]) -> Plane {
    Plane { point, normal }
}

#[test]
fn mehrschichtiges_dach_je_schicht_ein_band_aussen_oben() {
    let p = project(
        roof(serde_json::json!({ "shape": "flach", "pitchDeg": 0, "roofTypeId": "rt1" })),
        serde_json::json!({
            "hatches": [{ "id": "h1", "name": "H", "pattern": "diagonal", "scale": 1, "angle": 45, "color": "#111111" }],
            "components": [
                { "id": "tile", "name": "Ziegel", "color": "#a03a2a", "hatchId": "h1", "joinPriority": 1 },
                { "id": "ins", "name": "Dämmung", "color": "#ffffff", "hatchId": "h1", "joinPriority": 2 }
            ],
            "roofTypes": [{ "id": "rt1", "name": "Aufbau", "layers": [{ "componentId": "tile", "thickness": 0.05 }, { "componentId": "ins", "thickness": 0.25 }] }]
        }),
    );
    let mut cuts = Vec::new();
    append_roof_sections(&mut cuts, &p, &plane([0.0, 0.0, 0.0], [1.0, 0.0, 0.0]));
    assert_eq!(cuts.len(), 2);
    let tops: Vec<f64> = cuts.iter().map(|c| bbox(&c.pts)[3]).collect();
    assert!((tops[0] - 5.0).abs() < 1e-6 && (tops[1] - 4.95).abs() < 1e-6, "{tops:?}");
    assert!(cuts.iter().all(|c| c.hatch.as_ref().is_some_and(|h| h.pattern == HatchPattern::Diagonal)));
}

#[test]
fn l_walmdach_deckungsgleiche_teilflaechen_ein_band() {
    let l = serde_json::json!([{"x": 0, "y": 0}, {"x": 11, "y": 0}, {"x": 11, "y": 4}, {"x": 8, "y": 4}, {"x": 8, "y": 6}, {"x": 0, "y": 6}]);
    for y in [1.0, 2.0] {
        let p = project(roof(serde_json::json!({ "outline": l, "shape": "walm" })), serde_json::json!({}));
        let mut cuts = Vec::new();
        append_roof_sections(&mut cuts, &p, &plane([0.0, 0.0, y], [0.0, 0.0, 1.0]));
        assert_eq!(cuts.len(), 3, "Schnitt bei y = {y}");
    }
}
