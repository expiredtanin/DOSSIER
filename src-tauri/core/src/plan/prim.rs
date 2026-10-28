//! Plan-Primitive ([K3d]/[K4]): das Austauschformat zwischen Plan-Erzeugung und allen Verbrauchern
//! (Gegenstück zu `Primitive` in `src/plan/generatePlan/shared.ts`). Die JSON-Form ist
//! Zeichen für Zeichen die der TS-Objekte (camelCase, fehlende Felder fehlen).

use crate::model::*;
use serde::Serialize;

/// Aufgelöste Schraffur eines Polygons (`HatchRender`).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HatchRender {
    pub pattern: HatchPattern,
    pub scale: f64,
    pub angle: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin: Option<Vec2>,
    pub color: String,
    pub line_weight: f64,
    pub dash: Option<Vec<f64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<HatchStyleKind>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lines: Option<HatchStyleLines>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image: Option<HatchStyleImage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gradient: Option<HatchStyleGradient>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seed: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub density: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub length_min: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub length_max: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub motif: Option<HatchStyleMotif>,
}

/// Zeile unter dem Raum-Stempel.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct StampLine {
    pub text: String,
    pub align: Align,
}

/// `dash?: number[] | null`: fehlt (`None`), `null` (`Some(None)`) oder Muster.
pub type Dash = Option<Option<Vec<f64>>>;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind")]
pub enum Primitive {
    #[serde(rename = "polygon", rename_all = "camelCase")]
    Polygon {
        pts: Vec<Vec2>,
        fill: String,
        stroke: String,
        stroke_width_mm: f64,
        hatch: HatchRender,
        #[serde(skip_serializing_if = "Option::is_none")]
        greyed: Option<bool>,
        #[serde(skip_serializing_if = "Option::is_none")]
        opacity: Option<f64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        no_stroke_edges: Option<Vec<f64>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        wall_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        drawing_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        ceiling_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        opening_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        stair_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        room_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        extruded_solid_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        context_object_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        column_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        roof_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        section_line_id: Option<String>,
    },
    #[serde(rename = "line", rename_all = "camelCase")]
    Line {
        a: Vec2,
        b: Vec2,
        cls: String,
        weight_mm: f64,
        #[serde(skip_serializing_if = "Option::is_none")]
        dash: Dash,
        #[serde(skip_serializing_if = "Option::is_none")]
        zigzag: Option<LineStyleZigzag>,
        #[serde(skip_serializing_if = "Option::is_none")]
        motif: Option<LineStyleMotif>,
        #[serde(skip_serializing_if = "Option::is_none")]
        color: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        drawing_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        opening_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        stair_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        greyed: Option<bool>,
        #[serde(skip_serializing_if = "Option::is_none")]
        opacity: Option<f64>,
    },
    #[serde(rename = "arc", rename_all = "camelCase")]
    Arc {
        center: Vec2,
        from: Vec2,
        to: Vec2,
        r: f64,
        cls: String,
        weight_mm: f64,
        #[serde(skip_serializing_if = "Option::is_none")]
        dash: Dash,
        #[serde(skip_serializing_if = "Option::is_none")]
        opening_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        stair_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        greyed: Option<bool>,
        #[serde(skip_serializing_if = "Option::is_none")]
        opacity: Option<f64>,
    },
    #[serde(rename = "text", rename_all = "camelCase")]
    Text {
        at: Vec2,
        doc: RichTextDoc,
        extra_lines: Vec<StampLine>,
        base_pt: f64,
        color: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        room_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        greyed: Option<bool>,
        #[serde(skip_serializing_if = "Option::is_none")]
        opacity: Option<f64>,
    },
    #[serde(rename = "drawingText", rename_all = "camelCase")]
    DrawingText {
        at: Vec2,
        text: String,
        height_m: f64,
        angle: f64,
        color: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        marks: Option<Marks>,
        #[serde(skip_serializing_if = "Option::is_none")]
        wrap_width: Option<f64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        doc: Option<RichTextDoc>,
        #[serde(skip_serializing_if = "Option::is_none")]
        drawing_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        greyed: Option<bool>,
        #[serde(skip_serializing_if = "Option::is_none")]
        opacity: Option<f64>,
    },
}

impl Primitive {
    /// Setzt `greyed` (für Gruppen, deren Darstellungsmodus gedimmt ist).
    pub fn with_greyed(mut self, g: bool) -> Self {
        match &mut self {
            Primitive::Polygon { greyed, .. } | Primitive::Line { greyed, .. } | Primitive::Arc { greyed, .. } | Primitive::Text { greyed, .. } | Primitive::DrawingText { greyed, .. } => *greyed = Some(g),
        }
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plan::style::no_hatch;

    #[test]
    fn line_dash_null_und_fehlend_unterscheiden_sich() {
        let mk = |dash: Dash| Primitive::Line { a: Vec2 { x: 0.0, y: 0.0 }, b: Vec2 { x: 1.0, y: 0.0 }, cls: "c".into(), weight_mm: 0.1, dash, zigzag: None, motif: None, color: None, drawing_id: None, opening_id: None, stair_id: None, greyed: None, opacity: None };
        assert!(!serde_json::to_string(&mk(None)).unwrap().contains("dash"));
        assert!(serde_json::to_string(&mk(Some(None))).unwrap().contains("\"dash\":null"));
        assert!(serde_json::to_string(&mk(Some(Some(vec![0.4])))).unwrap().contains("\"dash\":[0.4]"));
    }

    #[test]
    fn polygon_tragt_kind_und_camel_case() {
        let p = Primitive::Polygon { pts: vec![], fill: "#fff".into(), stroke: "#000".into(), stroke_width_mm: 0.2, hatch: no_hatch(), greyed: None, opacity: None, no_stroke_edges: None, wall_id: Some("w".into()), drawing_id: None, ceiling_id: None, opening_id: None, stair_id: None, room_id: None, extruded_solid_id: None, context_object_id: None, column_id: None, roof_id: None, section_line_id: None };
        let s = serde_json::to_string(&p).unwrap();
        assert!(s.contains("\"kind\":\"polygon\"") && s.contains("strokeWidthMm") && s.contains("\"wallId\":\"w\""));
    }
}
