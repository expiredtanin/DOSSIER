//! Zeichnungsebenen ([K4] S3, vorher `model/types.ts`): Geschosshöhen stapeln.
//! Rechnung auf `serde_json::Value` (verlustfrei: unbekannte Felder bleiben).

use serde_json::Value;

fn is_floor(level: &Value) -> bool {
    level.get("kind").and_then(Value::as_str) == Some("floor")
}

fn is_zero(level: &Value) -> bool {
    level.get("zeroLevel").and_then(Value::as_bool) == Some(true)
}

fn floor_height(level: &Value) -> f64 {
    level.get("floorHeight").and_then(Value::as_f64).unwrap_or(0.0)
}

/// `recomputeFloorElevations`: Geschosse stapeln in Dokumentreihenfolge, jedes auf `baseElevation +
/// floorHeight` des vorigen (fehlende Höhe = 0). Der Stapel ist so verschoben, dass das Bezugsgeschoss
/// (`zeroLevel`, [131]; fehlt es: das erste Geschoss) auf ±0.00 liegt — Geschosse darunter erhalten
/// negative Höhen. Nur das erste Kennzeichen gilt, weitere entfallen. Nicht-Geschoss-Ebenen verlieren
/// `baseElevation` und `zeroLevel`.
pub fn recompute_floor_elevations(levels: &[Value]) -> Vec<Value> {
    // Stapelreihenfolge nach der bisherigen Höhe (stabil; Geschosse ohne Höhe obenauf), nicht nach der
    // Listen-Reihenfolge: die bestimmt nur die Überlagerung im Grundriss (`reorderDrawingLevels`).
    let floors: Vec<usize> = levels.iter().enumerate().filter(|(_, l)| is_floor(l)).map(|(i, _)| i).collect();
    let mut order = floors.clone();
    let key = |i: usize| levels[i].get("baseElevation").and_then(Value::as_f64).filter(|v| v.is_finite()).unwrap_or(f64::INFINITY);
    order.sort_by(|&a, &b| key(a).partial_cmp(&key(b)).unwrap_or(std::cmp::Ordering::Equal));
    let zero_pos = order.iter().position(|&i| is_zero(&levels[i])).unwrap_or(0);
    // Stapelhöhe des Bezugsgeschosses ab dem untersten Geschoss = Verschiebung des ganzen Stapels.
    let offset: f64 = order.iter().take(zero_pos).map(|&i| floor_height(&levels[i])).sum();
    let mut base_of = vec![0.0; levels.len()];
    let mut next_base = -offset;
    for &i in &order {
        // −0 vermeiden (Datei und Koten zeigen sonst „-0").
        let base = if next_base.abs() < 1e-12 { 0.0 } else { next_base };
        base_of[i] = base;
        next_base = base + floor_height(&levels[i]);
    }
    let zero_idx = order.get(zero_pos).copied();
    levels
        .iter()
        .enumerate()
        .map(|(i, level)| {
            let mut m = level.as_object().cloned().unwrap_or_default();
            if !is_floor(level) {
                m.shift_remove("baseElevation");
                m.shift_remove("zeroLevel");
                return Value::Object(m);
            }
            if Some(i) == zero_idx && is_zero(level) {
                m.insert("zeroLevel".into(), Value::Bool(true));
            } else {
                m.shift_remove("zeroLevel");
            }
            m.insert("baseElevation".into(), serde_json::Number::from_f64(base_of[i]).map_or(Value::Null, Value::Number));
            Value::Object(m)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// [131] Umordnen der Liste (Überlagerung) ändert die Höhen nicht.
    #[test]
    fn umordnen_aendert_hoehen_nicht() {
        let l = vec![
            json!({"id": "og", "kind": "floor", "floorHeight": 3.0, "baseElevation": 2.7}),
            json!({"id": "ug", "kind": "floor", "floorHeight": 2.7, "baseElevation": -2.7}),
            json!({"id": "eg", "kind": "floor", "floorHeight": 2.7, "baseElevation": 0.0, "zeroLevel": true}),
        ];
        let r = recompute_floor_elevations(&l);
        let z: Vec<f64> = r.iter().map(|v| v["baseElevation"].as_f64().unwrap()).collect();
        assert_eq!(z, vec![2.7, -2.7, 0.0]);
        assert_eq!(r[2]["zeroLevel"], json!(true));
    }

    #[test]
    fn stapelt_geschosse() {
        let l = vec![
            json!({"id": "a", "kind": "floor", "floorHeight": 2.6, "baseElevation": 9.0}),
            json!({"id": "s", "kind": "section", "baseElevation": 1.0}),
            json!({"id": "b", "kind": "floor"}),
            json!({"id": "c", "kind": "floor", "floorHeight": 3.0}),
        ];
        let r = recompute_floor_elevations(&l);
        assert_eq!(r[0]["baseElevation"], 0.0);
        assert!(r[1].get("baseElevation").is_none());
        assert_eq!(r[2]["baseElevation"], 2.6);
        assert_eq!(r[3]["baseElevation"], 2.6);
        assert_eq!(l[0]["baseElevation"], 9.0); // Eingabe unverändert
    }

    #[test]
    fn bezugsgeschoss_liegt_auf_null_untergeschosse_negativ() {
        let l = vec![
            json!({"id": "ug2", "kind": "floor", "floorHeight": 2.5}),
            json!({"id": "ug", "kind": "floor", "floorHeight": 2.8}),
            json!({"id": "s", "kind": "section", "zeroLevel": true}),
            json!({"id": "eg", "kind": "floor", "floorHeight": 3.0, "zeroLevel": true}),
            json!({"id": "og", "kind": "floor", "floorHeight": 2.9, "zeroLevel": true}),
        ];
        let r = recompute_floor_elevations(&l);
        let z = |i: usize| r[i]["baseElevation"].as_f64().unwrap();
        assert!((z(0) + 5.3).abs() < 1e-9);
        assert!((z(1) + 2.8).abs() < 1e-9);
        assert_eq!(z(3), 0.0);
        assert!((z(4) - 3.0).abs() < 1e-9);
        assert!(r[2].get("zeroLevel").is_none());
        assert_eq!(r[3]["zeroLevel"], true);
        assert!(r[4].get("zeroLevel").is_none(), "nur ein Bezugsgeschoss");
        // UG höher: der Bezug bleibt auf ±0.00, das UG wandert nach unten.
        let mut l2 = r.clone();
        l2[1]["floorHeight"] = json!(3.1);
        let r2 = recompute_floor_elevations(&l2);
        assert_eq!(r2[3]["baseElevation"], 0.0);
        assert!((r2[1]["baseElevation"].as_f64().unwrap() + 3.1).abs() < 1e-9);
    }

    #[test]
    fn zero_level_false_zaehlt_nicht() {
        let l = vec![json!({"id": "a", "kind": "floor", "floorHeight": 2.0}), json!({"id": "b", "kind": "floor", "zeroLevel": false})];
        let r = recompute_floor_elevations(&l);
        assert_eq!(r[0]["baseElevation"], 0.0);
        assert_eq!(r[1]["baseElevation"], 2.0);
        assert!(r[1].get("zeroLevel").is_none());
    }
}
