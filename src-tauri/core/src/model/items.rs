//! Einzelnes Listenelement der typisierten Sicht nachführen ([K4]): nach einem `replace` liest das
//! Dokument nur das ersetzte Element neu ein statt der ganzen Liste (bei 10 000 Zeichnungen
//! ~16 ms je Änderung im WASM).

use super::Project;
use serde::Deserialize;
use serde_json::Value;

/// Element `i` einer Vec-Liste aus `v` setzen; `false`, wenn die Stelle fehlt.
fn put<T: for<'de> Deserialize<'de>>(list: &mut [T], i: usize, v: &Value) -> Result<bool, String> {
    let Some(slot) = list.get_mut(i) else { return Ok(false) };
    *slot = T::deserialize(v).map_err(|e| e.to_string())?;
    Ok(true)
}

fn put_opt<T: for<'de> Deserialize<'de>>(list: &mut Option<Vec<T>>, i: usize, v: &Value) -> Result<bool, String> {
    match list {
        Some(l) => put(l, i, v),
        None => Ok(false),
    }
}

impl Project {
    /// Setzt Element `i` der Liste `key` aus dem JSON-Wert. `Ok(false)`: Liste nicht unterstützt oder
    /// Stelle fehlt (der Aufrufer liest dann das ganze Feld); `Err`: Element passt nicht zum Modell.
    pub fn set_item(&mut self, key: &str, i: usize, v: &Value) -> Result<bool, String> {
        match key {
            "walls" => put(&mut self.walls, i, v),
            "drawings2d" => put(&mut self.drawings2d, i, v),
            "drawingLevels" => put(&mut self.drawing_levels, i, v),
            "ceilings" => put_opt(&mut self.ceilings, i, v),
            "roofs" => put_opt(&mut self.roofs, i, v),
            "openings" => put_opt(&mut self.openings, i, v),
            "stairs" => put_opt(&mut self.stairs, i, v),
            "rooms" => put_opt(&mut self.rooms, i, v),
            "context" => put_opt(&mut self.context, i, v),
            "extrudedSolids" => put_opt(&mut self.extruded_solids, i, v),
            "columns" => put_opt(&mut self.columns, i, v),
            "groups" => put_opt(&mut self.groups, i, v),
            "layouts" => put_opt(&mut self.layouts, i, v),
            _ => Ok(false),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn element_wie_ganze_liste() {
        let text = include_str!("../../tests/fixtures/sample_project.json");
        let raw: Value = serde_json::from_str(text).unwrap();
        let mut p: Project = serde_json::from_value(raw.clone()).unwrap();
        let mut w = raw["walls"][1].clone();
        w["height"] = json!(3.33);
        assert!(p.set_item("walls", 1, &w).unwrap());
        assert_eq!(p.walls[1].height, 3.33);
        let mut whole = raw.clone();
        whole["walls"][1] = w;
        let q: Project = serde_json::from_value(whole).unwrap();
        assert_eq!(serde_json::to_value(&p).unwrap(), serde_json::to_value(&q).unwrap());
        // Stelle fehlt / unbekannte Liste / kaputtes Element.
        assert!(!p.set_item("walls", 999, &raw["walls"][0]).unwrap());
        assert!(!p.set_item("hatches", 0, &raw["hatches"][0]).unwrap());
        assert!(p.set_item("walls", 0, &json!({"id": 3})).is_err());
    }
}
