//! Export-Scope „nur Auswahl" ([K4] S3, vorher `filterProjectToSelection` in `src/state/exportScope.ts`):
//! die Listen der acht Elementarten auf die ausgewählten ids kürzen (jede Art ohne Eintrag wird leer);
//! Bibliotheken, Ebenen und Geschosse bleiben, damit id-Verweise weiter auflösen. Liefert die gekürzten
//! Listen als Patch für `{...project, ...patch}`.

use crate::groups::Membership;
use serde_json::{Map, Value};
use std::collections::HashSet;

/// Projekt-Liste → (Mitglieds-ids der Art).
const KINDS: [(&str, &str); 8] = [
    ("walls", "wallIds"),
    ("drawings2d", "drawingIds"),
    ("ceilings", "ceilingIds"),
    ("rooms", "roomIds"),
    ("stairs", "stairIds"),
    ("columns", "columnIds"),
    ("roofs", "roofIds"),
    ("openings", "openingIds"),
];

/// Gekürzte Listen (alle acht Schlüssel, fehlende Listen = leer); Elemente in Listen-Reihenfolge, auch Doppelte.
pub fn filter_patch(root: &Map<String, Value>, members: &Membership) -> Map<String, Value> {
    let mut out = Map::new();
    for (key, kind) in KINDS {
        let ids: HashSet<&str> = members.list(kind).map(|l| l.iter().map(String::as_str).collect()).unwrap_or_default();
        let kept: Vec<Value> = root
            .get(key)
            .and_then(Value::as_array)
            .map(|a| a.iter().filter(|e| e.get("id").and_then(Value::as_str).is_some_and(|id| ids.contains(id))).cloned().collect())
            .unwrap_or_default();
        out.insert(key.to_string(), Value::Array(kept));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn nur_ausgewaehlte_bleiben() {
        let root = json!({
            "walls": [{"id": "a"}, {"id": "b"}, {"id": "a"}],
            "rooms": [{"id": "r"}],
            "drawings2d": [{"id": "d"}],
            "layers": [{"code": "20"}],
        });
        let m = Membership { wall_ids: vec!["a".into()], ..Default::default() };
        let p = filter_patch(root.as_object().unwrap(), &m);
        assert_eq!(p["walls"], json!([{"id": "a"}, {"id": "a"}]));
        assert_eq!(p["rooms"], json!([]));
        assert_eq!(p["drawings2d"], json!([]));
        assert_eq!(p["roofs"], json!([]));
        assert_eq!(p.len(), 8);
        assert!(p.get("layers").is_none());
    }
}
