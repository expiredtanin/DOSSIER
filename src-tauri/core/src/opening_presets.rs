//! Kleine Typen-Bibliothek für Fenster und Türen ([95]): übliche Schweizer Bauarten als Vorlagen,
//! die das Projekt über `typeId` wiederverwendet. Die ids sind stabil (die UI übersetzt den Namen
//! über `preset.<id>`); der Name hier ist nur der deutsche Rückfall.

use crate::model::{DoorType, WindowType};

const WINDOWS: &str = r#"[
  {"id": "fe-dk-1", "name": "Dreh-Kipp 1-flügelig", "kind": "drehkipp", "wingCount": 1, "glazing": "dreifach",
   "frameThickness": 0.08, "frameDepth": 0.08, "frameWidth": 0.08, "insetFromFace": 0.12, "insetFace": "aussen",
   "rebateDepth": 0.05, "lintelHeight": 0.2, "sillBoard": "beide",
   "shading": {"create": true, "kind": "raffstore", "box": {"width": 0, "height": 0.3, "depth": 0.16}, "mount": "sturz"},
   "defaultSillHeight": 0.9, "defaultWidth": 1.2, "defaultHeight": 1.4},
  {"id": "fe-dk-2", "name": "Dreh-Kipp 2-flügelig (Stulp)", "kind": "drehkipp", "wingCount": 2, "glazing": "dreifach",
   "frameThickness": 0.08, "frameDepth": 0.08, "frameWidth": 0.08, "insetFromFace": 0.12, "insetFace": "aussen",
   "rebateDepth": 0.05, "lintelHeight": 0.2, "sillBoard": "beide",
   "sashes": [{"kind": "fluegel", "autoWidth": true, "opening": "dreh", "hingeSide": "left"},
              {"kind": "fluegel", "autoWidth": true, "opening": "drehkipp", "hingeSide": "right"}],
   "shading": {"create": true, "kind": "raffstore", "box": {"width": 0, "height": 0.3, "depth": 0.16}, "mount": "sturz"},
   "defaultSillHeight": 0.9, "defaultWidth": 1.6, "defaultHeight": 1.5},
  {"id": "fe-fest", "name": "Festverglasung", "kind": "fest", "wingCount": 1, "glazing": "dreifach",
   "frameThickness": 0.07, "frameDepth": 0.08, "frameWidth": 0.06, "insetFromFace": 0.12, "insetFace": "aussen",
   "rebateDepth": 0.05, "sillBoard": "aussen", "defaultSillHeight": 0.9, "defaultWidth": 1.0, "defaultHeight": 1.4},
  {"id": "fe-oberlicht", "name": "Dreh-Kipp mit Kipp-Oberlicht", "kind": "drehkipp", "wingCount": 1, "glazing": "dreifach",
   "frameThickness": 0.08, "frameDepth": 0.08, "frameWidth": 0.08, "insetFromFace": 0.12, "insetFace": "aussen",
   "rebateDepth": 0.05, "lintelHeight": 0.2, "sillBoard": "beide", "transomHeight": 0.5,
   "transomSashes": [{"kind": "fluegel", "autoWidth": true, "opening": "kipp"}],
   "defaultSillHeight": 0.6, "defaultWidth": 1.2, "defaultHeight": 2.0},
  {"id": "fe-pfosten-riegel", "name": "Pfosten-Riegel 3-teilig", "kind": "drehkipp", "wingCount": 3, "glazing": "dreifach",
   "frameThickness": 0.08, "frameDepth": 0.1, "frameWidth": 0.06, "insetFace": "mitte", "rebateDepth": 0.05,
   "lintelHeight": 0.25, "sillBoard": "beide", "transomHeight": 0.6,
   "sashes": [{"kind": "fluegel", "autoWidth": true, "opening": "drehkipp", "hingeSide": "left"},
              {"kind": "pfosten", "postWidth": 0.08},
              {"kind": "fluegel", "autoWidth": true, "opening": "fest"},
              {"kind": "pfosten", "postWidth": 0.08},
              {"kind": "fluegel", "autoWidth": true, "opening": "drehkipp", "hingeSide": "right"}],
   "transomSashes": [{"kind": "fluegel", "autoWidth": true, "opening": "kipp"},
                     {"kind": "pfosten", "postWidth": 0.08},
                     {"kind": "fluegel", "autoWidth": true, "opening": "fest"},
                     {"kind": "pfosten", "postWidth": 0.08},
                     {"kind": "fluegel", "autoWidth": true, "opening": "kipp"}],
   "defaultSillHeight": 0.3, "defaultWidth": 3.0, "defaultHeight": 2.3},
  {"id": "fe-schiebe", "name": "Schiebefenster 2-teilig", "kind": "schiebe", "wingCount": 2, "glazing": "dreifach",
   "frameThickness": 0.1, "frameDepth": 0.12, "frameWidth": 0.08, "insetFromFace": 0.12, "insetFace": "aussen",
   "rebateDepth": 0.05, "sillBoard": "beide",
   "sashes": [{"kind": "fluegel", "autoWidth": true, "opening": "fest"},
              {"kind": "fluegel", "autoWidth": true, "opening": "schiebe", "hingeSide": "right"}],
   "defaultSillHeight": 0.9, "defaultWidth": 2.0, "defaultHeight": 1.4}
]"#;

const DOORS: &str = r#"[
  {"id": "tu-zimmer", "name": "Zimmertür (Zarge)", "kind": "dreh", "leafCount": 1, "leafStyle": "glatt",
   "frameThickness": 0.05, "frameKind": "zarge", "frameWidth": 0.06, "defaultWidth": 0.8, "defaultHeight": 2.0},
  {"id": "tu-zimmer-2", "name": "Zimmertür 2-flügelig", "kind": "dreh", "leafCount": 2, "leafStyle": "glatt",
   "frameThickness": 0.05, "frameKind": "zarge", "frameWidth": 0.06, "defaultWidth": 1.4, "defaultHeight": 2.0},
  {"id": "tu-schiebe", "name": "Schiebetür vor der Wand", "kind": "schiebe", "leafCount": 1, "leafStyle": "glatt",
   "frameThickness": 0.04, "frameWidth": 0.04, "defaultWidth": 0.9, "defaultHeight": 2.1},
  {"id": "tu-hebeschiebe", "name": "Hebeschiebetür", "kind": "hebeschiebe", "leafCount": 2, "leafStyle": "glas",
   "frameThickness": 0.1, "frameDepth": 0.16, "frameKind": "blockrahmen", "frameWidth": 0.1, "insetFromFace": 0.12,
   "insetFace": "aussen", "rebateDepth": 0.05, "lintelHeight": 0.25, "threshold": true,
   "defaultWidth": 2.4, "defaultHeight": 2.2},
  {"id": "tu-pendel", "name": "Pendeltür", "kind": "pendel", "leafCount": 1, "leafStyle": "glatt",
   "frameThickness": 0.05, "frameKind": "zarge", "frameWidth": 0.06, "defaultWidth": 0.9, "defaultHeight": 2.1},
  {"id": "tu-haus", "name": "Haustür mit Oberlicht", "kind": "dreh", "leafCount": 1, "leafStyle": "glas", "glazingRatio": 0.3,
   "frameThickness": 0.08, "frameKind": "blockrahmen", "frameWidth": 0.09, "insetFromFace": 0.12, "insetFace": "aussen",
   "rebateDepth": 0.05, "lintelHeight": 0.25, "transomHeight": 0.4, "threshold": true,
   "defaultWidth": 1.1, "defaultHeight": 2.5},
  {"id": "tu-wand", "name": "Wandöffnung", "kind": "wandoeffnung", "leafCount": 1, "leafStyle": "glatt",
   "frameThickness": 0.0, "defaultWidth": 1.0, "defaultHeight": 2.1}
]"#;

/// Fenstertyp-Vorlagen.
pub fn window_presets() -> Vec<WindowType> {
    serde_json::from_str(WINDOWS).unwrap_or_default()
}

/// Türtyp-Vorlagen.
pub fn door_presets() -> Vec<DoorType> {
    serde_json::from_str(DOORS).unwrap_or_default()
}

/// Beide Listen als JSON `{ windowTypes, doorTypes }` (Bindung `opening_type_presets_json`).
pub fn presets_json() -> String {
    serde_json::json!({ "windowTypes": window_presets(), "doorTypes": door_presets() }).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vorlagen_lesen_sich_vollstaendig_und_ohne_unbekannte_felder() {
        let w = window_presets();
        let d = door_presets();
        assert_eq!(w.len(), 6);
        assert_eq!(d.len(), 7);
        for t in &w {
            assert!(t.extra.0.is_empty(), "{}: {:?}", t.id, t.extra);
            assert!(t.default_width > 0.0 && t.default_height > 0.0);
        }
        for t in &d {
            assert!(t.extra.0.is_empty(), "{}: {:?}", t.id, t.extra);
            assert!(t.kind != crate::model::DoorTypeKind::Unknown, "{}", t.id);
        }
        let mut ids: Vec<&str> = w.iter().map(|t| t.id.as_str()).chain(d.iter().map(|t| t.id.as_str())).collect();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), 13);
    }
}
