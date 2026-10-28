//! Typisiertes Projektmodell ([K4] S2/S4) — die QUELLE der Projekt-Datentypen. `generated.rs`
//! (Strukturen/Enums; der Name stammt aus der einmaligen Übersetzung TS → Rust) und `manual.rs`
//! (Typen mit Tag, `Vec2`, `Extra`) werden von Hand gepflegt; die TS-Typen
//! (`src/model/types.generated.ts`) erzeugt `ts_export.rs` daraus (`npm run gen:types`).
//! Neue Modellfelder nur hier eintragen (serde + ts-rs-Attribute, Regeln in `ts_export.rs`).

pub mod generated;
pub mod helpers;
pub mod manual;
#[cfg(test)]
pub(crate) mod ts_export;

pub use generated::*;
pub use manual::*;

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    /// Zahlen als f64 vergleichbar machen (JS kennt keinen Unterschied zwischen 3 und 3.0).
    fn norm(v: &Value) -> Value {
        match v {
            Value::Number(n) => serde_json::Number::from_f64(n.as_f64().unwrap()).map_or(Value::Null, Value::Number),
            Value::Array(a) => Value::Array(a.iter().map(norm).collect()),
            Value::Object(o) => Value::Object(o.iter().map(|(k, v)| (k.clone(), norm(v))).collect()),
            other => other.clone(),
        }
    }

    fn roundtrip(name: &str, text: &str) {
        let raw: Value = serde_json::from_str(text).unwrap();
        // `deny_unknown_fields` (nur im Test) meldet jedes Feld, das dem Modell fehlt.
        let p: Project = serde_json::from_value(raw.clone()).unwrap_or_else(|e| panic!("{name}: {e}"));
        let back = serde_json::to_value(&p).unwrap();
        assert_eq!(norm(&back), norm(&raw), "{name}: Hin-und-zurück weicht ab");
        // Ohne Extra-Felder gleich: das typisierte Modell deckt alles ab.
        let typed = to_value_typed_only(&p).unwrap();
        assert_eq!(norm(&typed), norm(&raw), "{name}: typisiertes Modell unvollständig");
    }

    #[test]
    fn importiertes_netz_mit_farbe_und_ifc_id() {
        let raw: Value = serde_json::from_str(
            r##"{"type":"importedMesh","id":"m","name":"Wand","color":"#aabbcc","ifcGlobalId":"2O2Fr$t4X7Zf8NOew3FLOH",
                 "positions":[0,0,0],"indices":[0,0,0]}"##,
        )
        .unwrap();
        let o: ContextObject = serde_json::from_value(raw.clone()).unwrap();
        assert_eq!(norm(&serde_json::to_value(&o).unwrap()), norm(&raw));
    }

    #[test]
    fn beispielprojekt_hin_und_zurueck() {
        roundtrip("sample_project", include_str!("../../tests/fixtures/sample_project.json"));
    }
}
