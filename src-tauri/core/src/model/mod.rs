//! Typisiertes Projektmodell ([K4] S2): Rust-Gegenstück zu `src/model/types.ts`. `generated.rs`
//! entstand aus den TS-Typen (`scripts/gen-rust-model.py`) und wird ab jetzt von Hand gepflegt;
//! Typen mit Tag stehen in `manual.rs`.

pub mod generated;
pub mod manual;

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
    }

    #[test]
    fn beispielprojekt_hin_und_zurueck() {
        roundtrip("sample_project", include_str!("../../tests/fixtures/sample_project.json"));
    }
}
