//! Von Hand geschriebene Teile des Modells: Typen mit Tag (diskriminierte Unions) und `Vec2`.
//! Gegenstück zu den entsprechenden Typen in `src/model/types.ts`.

use super::generated::*;
use serde::{Deserialize, Serialize};

/// Felder, die das Modell (noch) nicht kennt: bleiben beim Hin-und-zurück erhalten, damit Rust
/// nichts verliert, was neuere Programmstände oder Erweiterungen in die Datei geschrieben haben.
/// In Tests meldet ein unbekanntes Feld sich als Panic — so fällt eine Lücke im Modell auf.
#[derive(Debug, Clone, PartialEq, Default, Serialize)]
pub struct Extra(pub serde_json::Map<String, serde_json::Value>);

impl<'de> Deserialize<'de> for Extra {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let m = serde_json::Map::<String, serde_json::Value>::deserialize(d)?;
        #[cfg(test)]
        if !m.is_empty() {
            panic!("Modell kennt Felder nicht: {:?}", m.keys().collect::<Vec<_>>());
        }
        Ok(Extra(m))
    }
}

impl Extra {
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
#[cfg_attr(test, serde(deny_unknown_fields))]
pub struct Vec2 {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "mode")]
pub enum VerticalAnchor {
    #[serde(rename = "floor")]
    Floor {
        #[serde(rename = "floorId")]
        floor_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        offset: Option<f64>,
    },
    #[serde(rename = "custom")]
    Custom { z: f64 },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum ColumnProfile {
    #[serde(rename = "rect")]
    Rect { width: f64, depth: f64 },
    #[serde(rename = "round")]
    Round { radius: f64 },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Offset2 {
    pub along: f64,
    pub perp: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum KoteKind {
    #[serde(rename = "okFertig")]
    OkFertig,
    #[serde(rename = "ukFertig")]
    UkFertig,
    #[serde(rename = "okRoh")]
    OkRoh,
    #[serde(rename = "ukRoh")]
    UkRoh,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SplineMode {
    Fit,
    Control,
}

/// Geometrie eines 2D-Zeichenelements (Tag `shape`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "shape")]
pub enum Drawing2DGeom {
    #[serde(rename = "line")]
    Line { a: Vec2, b: Vec2 },
    #[serde(rename = "xline")]
    Xline { a: Vec2, b: Vec2 },
    #[serde(rename = "ray")]
    Ray { a: Vec2, b: Vec2 },
    #[serde(rename = "polyline")]
    Polyline {
        pts: Vec<Vec2>,
        closed: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        bulge: Option<Vec<f64>>,
    },
    #[serde(rename = "rect")]
    Rect { min: Vec2, max: Vec2 },
    #[serde(rename = "circle")]
    Circle { center: Vec2, r: f64 },
    #[serde(rename = "arc")]
    Arc { center: Vec2, r: f64, a0: f64, a1: f64 },
    #[serde(rename = "ellipse")]
    Ellipse { center: Vec2, rx: f64, ry: f64, rotation: f64 },
    #[serde(rename = "bezier")]
    Bezier { pts: Vec<Vec2> },
    #[serde(rename = "spline")]
    Spline {
        pts: Vec<Vec2>,
        closed: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        mode: Option<SplineMode>,
    },
    #[serde(rename = "dimension")]
    Dimension {
        pts: Vec<Vec2>,
        offset: f64,
        #[serde(rename = "gapMm", default, skip_serializing_if = "Option::is_none")]
        gap_mm: Option<f64>,
        #[serde(rename = "overshootMm", default, skip_serializing_if = "Option::is_none")]
        overshoot_mm: Option<f64>,
        #[serde(rename = "tickLenMm", default, skip_serializing_if = "Option::is_none")]
        tick_len_mm: Option<f64>,
        #[serde(rename = "textHeightMm", default, skip_serializing_if = "Option::is_none")]
        text_height_mm: Option<f64>,
        #[serde(rename = "lineWeightMm", default, skip_serializing_if = "Option::is_none")]
        line_weight_mm: Option<f64>,
        #[serde(rename = "extWeightMm", default, skip_serializing_if = "Option::is_none")]
        ext_weight_mm: Option<f64>,
        #[serde(rename = "tickWeightMm", default, skip_serializing_if = "Option::is_none")]
        tick_weight_mm: Option<f64>,
        #[serde(rename = "textOffsetsMm", default, skip_serializing_if = "Option::is_none")]
        text_offsets_mm: Option<Vec<Offset2>>,
    },
    #[serde(rename = "kote")]
    Kote { at: Vec2, value: f64, kind: KoteKind, rotation: f64 },
    #[serde(rename = "detailref")]
    Detailref {
        at: Vec2,
        label: String,
        #[serde(rename = "sheetLayoutId", default, skip_serializing_if = "Option::is_none")]
        sheet_layout_id: Option<String>,
        #[serde(rename = "sheetLabel", default, skip_serializing_if = "Option::is_none")]
        sheet_label: Option<String>,
    },
    #[serde(rename = "scalebar")]
    Scalebar {
        at: Vec2,
        #[serde(rename = "segmentLength")]
        segment_length: f64,
        segments: f64,
    },
    #[serde(rename = "pointmarker")]
    Pointmarker { at: Vec2 },
    #[serde(rename = "text")]
    Text {
        at: Vec2,
        text: String,
        height: f64,
        angle: f64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        width: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        marks: Option<Marks>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        doc: Option<RichTextDoc>,
        #[serde(rename = "leaderTarget", default, skip_serializing_if = "Option::is_none")]
        leader_target: Option<Vec2>,
        #[serde(rename = "leaderBendPoints", default, skip_serializing_if = "Option::is_none")]
        leader_bend_points: Option<Vec<Vec2>>,
        #[serde(rename = "pathPts", default, skip_serializing_if = "Option::is_none")]
        path_pts: Option<Vec<Vec2>>,
    },
    #[serde(rename = "block")]
    Block {
        #[serde(rename = "blockDefId")]
        block_def_id: String,
        at: Vec2,
        rotation: f64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        scale: Option<f64>,
    },
    #[serde(rename = "image")]
    Image {
        min: Vec2,
        max: Vec2,
        src: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        opacity: Option<f64>,
    },
}

/// Layout-Beschriftung (Tag `kind`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum LayoutAnnotation {
    #[serde(rename = "line")]
    Line {
        id: String,
        #[serde(rename = "x1Mm")]
        x1_mm: f64,
        #[serde(rename = "y1Mm")]
        y1_mm: f64,
        #[serde(rename = "x2Mm")]
        x2_mm: f64,
        #[serde(rename = "y2Mm")]
        y2_mm: f64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        color: Option<String>,
        #[serde(rename = "weightMm", default, skip_serializing_if = "Option::is_none")]
        weight_mm: Option<f64>,
    },
    #[serde(rename = "rect")]
    Rect {
        id: String,
        #[serde(rename = "xMm")]
        x_mm: f64,
        #[serde(rename = "yMm")]
        y_mm: f64,
        #[serde(rename = "widthMm")]
        width_mm: f64,
        #[serde(rename = "heightMm")]
        height_mm: f64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        color: Option<String>,
        #[serde(rename = "weightMm", default, skip_serializing_if = "Option::is_none")]
        weight_mm: Option<f64>,
    },
    #[serde(rename = "text")]
    Text {
        id: String,
        #[serde(rename = "xMm")]
        x_mm: f64,
        #[serde(rename = "yMm")]
        y_mm: f64,
        text: String,
        #[serde(rename = "heightMm")]
        height_mm: f64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        color: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        doc: Option<RichTextDoc>,
        #[serde(rename = "widthMm", default, skip_serializing_if = "Option::is_none")]
        width_mm: Option<f64>,
    },
    #[serde(rename = "image")]
    Image {
        id: String,
        #[serde(rename = "xMm")]
        x_mm: f64,
        #[serde(rename = "yMm")]
        y_mm: f64,
        #[serde(rename = "widthMm")]
        width_mm: f64,
        #[serde(rename = "heightMm")]
        height_mm: f64,
        src: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        opacity: Option<f64>,
    },
}

/// Parametrische Wandregel (Tag `type`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ParametricRule {
    #[serde(rename = "grid")]
    Grid(GridRule),
    #[serde(rename = "module")]
    Module(ModuleRule),
    #[serde(rename = "conditional-thickness")]
    ConditionalThickness(ConditionalThicknessRule),
    #[serde(rename = "reference-line")]
    ReferenceLine(ReferenceLineRule),
    #[serde(rename = "sequence")]
    Sequence(SequenceRule),
}

/// Kontext-Objekt (Tag `type`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ContextObject {
    #[serde(rename = "importedMesh")]
    ImportedMesh(ImportedMesh),
    #[serde(rename = "contourSet")]
    ContourSet(ContourSet),
    #[serde(rename = "terrainMesh")]
    TerrainMesh(TerrainMesh),
    #[serde(rename = "image")]
    Image(ContextImage),
}

impl Default for Drawing2DGeom {
    fn default() -> Self {
        Drawing2DGeom::Pointmarker { at: Vec2::default() }
    }
}

impl Default for ColumnProfile {
    fn default() -> Self {
        ColumnProfile::Rect { width: 0.0, depth: 0.0 }
    }
}
