//! Zeichnungsebenen ([K4] S3, vorher `model/types.ts`): Geschosshöhen stapeln.
//! Rechnung auf `serde_json::Value` (verlustfrei: unbekannte Felder bleiben).

use serde_json::Value;

/// `recomputeFloorElevations`: Das erste Geschoss beginnt bei 0, jedes weitere bei `baseElevation +
/// floorHeight` des vorigen (fehlende Höhe = 0). Nicht-Geschoss-Ebenen verlieren `baseElevation`.
pub fn recompute_floor_elevations(levels: &[Value]) -> Vec<Value> {
    let mut next_base = 0.0_f64;
    levels
        .iter()
        .map(|level| {
            let mut m = level.as_object().cloned().unwrap_or_default();
            if level.get("kind").and_then(Value::as_str) != Some("floor") {
                m.shift_remove("baseElevation");
                return Value::Object(m);
            }
            let base = next_base;
            next_base = base + level.get("floorHeight").and_then(Value::as_f64).unwrap_or(0.0);
            m.insert("baseElevation".into(), serde_json::Number::from_f64(base).map_or(Value::Null, Value::Number));
            Value::Object(m)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

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
}
