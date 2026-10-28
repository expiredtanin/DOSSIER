// GENERIERT von scripts/gen-rust-model.py aus den TS-Typen (Stand 28.10.), danach von Hand gepflegt.
// Rust-Gegenstück zu src/model/types.ts ([K4] S2). Union-Typen mit Tag stehen in model/manual.rs.
#![allow(clippy::large_enum_variant)]
use super::manual::*;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum LineStyleKind {
    #[default]
    #[serde(rename = "dash")]
    Dash,
    #[serde(rename = "zigzag")]
    Zigzag,
    #[serde(rename = "custom")]
    Custom,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct LineStyleZigzag {
    pub amplitude: f64,
    pub wavelength: f64,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct LineStyleMotif {
    pub points: Vec<Vec2>,
    pub length: f64,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct LineStyle {
    pub id: String,
    pub name: String,
    pub weight: f64,
    pub color: String,
    #[serde(default)]
    pub dash: Option<Vec<f64>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<LineStyleKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub zigzag: Option<LineStyleZigzag>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub motif: Option<LineStyleMotif>,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Marks {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bold: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub italic: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub underline: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub strike: Option<bool>,
    #[serde(rename = "super", default, skip_serializing_if = "Option::is_none")]
    pub super_: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sub: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font: Option<String>,
    #[serde(rename = "sizePt", default, skip_serializing_if = "Option::is_none")]
    pub size_pt: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct TextStylePreset {
    pub id: String,
    pub label: String,
    pub marks: Marks,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum HatchStyleKind {
    #[default]
    #[serde(rename = "vector")]
    Vector,
    #[serde(rename = "image")]
    Image,
    #[serde(rename = "gradient")]
    Gradient,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum HatchStyleLines {
    #[default]
    #[serde(rename = "parallel")]
    Parallel,
    #[serde(rename = "random")]
    Random,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct HatchStyleImage {
    pub src: String,
    #[serde(rename = "scaleX")]
    pub scale_x: f64,
    #[serde(rename = "scaleY")]
    pub scale_y: f64,
    pub rotation: f64,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum HatchStyleGradientType {
    #[default]
    #[serde(rename = "linear")]
    Linear,
    #[serde(rename = "radial")]
    Radial,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct HatchStyleGradient {
    pub color1: String,
    pub color2: String,
    pub angle: f64,
    pub r#type: HatchStyleGradientType,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum HatchPattern {
    #[default]
    #[serde(rename = "none")]
    None,
    #[serde(rename = "solid")]
    Solid,
    #[serde(rename = "insulation")]
    Insulation,
    #[serde(rename = "diagonal")]
    Diagonal,
    #[serde(rename = "crosshatch")]
    Crosshatch,
    #[serde(rename = "custom")]
    Custom,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct HatchStyleMotif {
    pub points: Vec<Vec2>,
    pub length: f64,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct HatchStyle {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<HatchStyleKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lines: Option<HatchStyleLines>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image: Option<HatchStyleImage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gradient: Option<HatchStyleGradient>,
    pub pattern: HatchPattern,
    pub scale: f64,
    pub angle: f64,
    #[serde(rename = "relativeToWall", default, skip_serializing_if = "Option::is_none")]
    pub relative_to_wall: Option<bool>,
    pub color: String,
    #[serde(rename = "lineStyleId", default, skip_serializing_if = "Option::is_none")]
    pub line_style_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seed: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub density: Option<f64>,
    #[serde(rename = "lengthMin", default, skip_serializing_if = "Option::is_none")]
    pub length_min: Option<f64>,
    #[serde(rename = "lengthMax", default, skip_serializing_if = "Option::is_none")]
    pub length_max: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub motif: Option<HatchStyleMotif>,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ComponentMaterial {
    #[serde(rename = "libraryId", default, skip_serializing_if = "Option::is_none")]
    pub library_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub normal: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub roughness: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metalness: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub displacement: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ao: Option<String>,
    #[serde(rename = "sizeM", default, skip_serializing_if = "Option::is_none")]
    pub size_m: Option<f64>,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Component {
    pub id: String,
    pub name: String,
    pub color: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub foreground: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub background: Option<String>,
    #[serde(rename = "colorPenId", default, skip_serializing_if = "Option::is_none")]
    pub color_pen_id: Option<String>,
    #[serde(rename = "foregroundPenId", default, skip_serializing_if = "Option::is_none")]
    pub foreground_pen_id: Option<String>,
    #[serde(rename = "backgroundPenId", default, skip_serializing_if = "Option::is_none")]
    pub background_pen_id: Option<String>,
    #[serde(rename = "hatchId")]
    pub hatch_id: String,
    #[serde(rename = "viewHatchId", default, skip_serializing_if = "Option::is_none")]
    pub view_hatch_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub texture3d: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub material: Option<ComponentMaterial>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub abbrev: Option<String>,
    #[serde(rename = "joinPriority")]
    pub join_priority: f64,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Layer {
    #[serde(rename = "componentId")]
    pub component_id: String,
    pub thickness: f64,
    #[serde(rename = "jointLineStyleId", default, skip_serializing_if = "Option::is_none")]
    pub joint_line_style_id: Option<String>,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct WallType {
    pub id: String,
    pub name: String,
    pub layers: Vec<Layer>,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct CeilingType {
    pub id: String,
    pub name: String,
    pub layers: Vec<Layer>,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct RoofType {
    pub id: String,
    pub name: String,
    pub layers: Vec<Layer>,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct BlockDef {
    pub id: String,
    pub name: String,
    pub geom2d: Vec<Drawing2DGeom>,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum DoorTypeKind {
    #[default]
    #[serde(rename = "dreh")]
    Dreh,
    #[serde(rename = "schiebe")]
    Schiebe,
    #[serde(rename = "wandoeffnung")]
    Wandoeffnung,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum DoorTypeLeafStyle {
    #[default]
    #[serde(rename = "glatt")]
    Glatt,
    #[serde(rename = "kassette")]
    Kassette,
    #[serde(rename = "glas")]
    Glas,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum DoorTypeFrameKind {
    #[default]
    #[serde(rename = "zarge")]
    Zarge,
    #[serde(rename = "blockrahmen")]
    Blockrahmen,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum FrameCornerJoin {
    #[default]
    #[serde(rename = "vertikal")]
    Vertikal,
    #[serde(rename = "horizontal")]
    Horizontal,
    #[serde(rename = "gehrung")]
    Gehrung,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum DoorTypeInsetFace {
    #[default]
    #[serde(rename = "aussen")]
    Aussen,
    #[serde(rename = "innen")]
    Innen,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct DoorType {
    pub id: String,
    pub name: String,
    pub kind: DoorTypeKind,
    #[serde(rename = "leafCount")]
    pub leaf_count: f64,
    #[serde(rename = "leafStyle")]
    pub leaf_style: DoorTypeLeafStyle,
    #[serde(rename = "glazingRatio", default, skip_serializing_if = "Option::is_none")]
    pub glazing_ratio: Option<f64>,
    #[serde(rename = "panelCols", default, skip_serializing_if = "Option::is_none")]
    pub panel_cols: Option<f64>,
    #[serde(rename = "panelRows", default, skip_serializing_if = "Option::is_none")]
    pub panel_rows: Option<f64>,
    #[serde(rename = "frameThickness")]
    pub frame_thickness: f64,
    #[serde(rename = "frameDepth", default, skip_serializing_if = "Option::is_none")]
    pub frame_depth: Option<f64>,
    #[serde(rename = "frameKind", default, skip_serializing_if = "Option::is_none")]
    pub frame_kind: Option<DoorTypeFrameKind>,
    #[serde(rename = "frameWidth", default, skip_serializing_if = "Option::is_none")]
    pub frame_width: Option<f64>,
    #[serde(rename = "frameCornerJoin", default, skip_serializing_if = "Option::is_none")]
    pub frame_corner_join: Option<FrameCornerJoin>,
    #[serde(rename = "insetFromFace", default, skip_serializing_if = "Option::is_none")]
    pub inset_from_face: Option<f64>,
    #[serde(rename = "insetFace", default, skip_serializing_if = "Option::is_none")]
    pub inset_face: Option<DoorTypeInsetFace>,
    #[serde(rename = "transomHeight", default, skip_serializing_if = "Option::is_none")]
    pub transom_height: Option<f64>,
    #[serde(rename = "defaultWidth")]
    pub default_width: f64,
    #[serde(rename = "defaultHeight")]
    pub default_height: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub threshold: Option<bool>,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum OpeningKind {
    #[default]
    #[serde(rename = "dreh")]
    Dreh,
    #[serde(rename = "kipp")]
    Kipp,
    #[serde(rename = "drehkipp")]
    Drehkipp,
    #[serde(rename = "fest")]
    Fest,
    #[serde(rename = "schiebe")]
    Schiebe,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum SashDefKind {
    #[default]
    #[serde(rename = "fluegel")]
    Fluegel,
    #[serde(rename = "pfosten")]
    Pfosten,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum SashDefHingeSide {
    #[default]
    #[serde(rename = "left")]
    Left,
    #[serde(rename = "right")]
    Right,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct SashDef {
    pub kind: SashDefKind,
    #[serde(rename = "autoWidth", default, skip_serializing_if = "Option::is_none")]
    pub auto_width: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<f64>,
    #[serde(rename = "postWidth", default, skip_serializing_if = "Option::is_none")]
    pub post_width: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub opening: Option<OpeningKind>,
    #[serde(rename = "hingeSide", default, skip_serializing_if = "Option::is_none")]
    pub hinge_side: Option<SashDefHingeSide>,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum WindowShadingKind {
    #[default]
    #[serde(rename = "rollladen")]
    Rollladen,
    #[serde(rename = "raffstore")]
    Raffstore,
    #[serde(rename = "markise")]
    Markise,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct WindowShadingBox {
    pub width: f64,
    pub height: f64,
    pub depth: f64,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct WindowShading {
    pub create: bool,
    pub kind: WindowShadingKind,
    pub r#box: WindowShadingBox,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum WindowTypeGlazing {
    #[default]
    #[serde(rename = "einfach")]
    Einfach,
    #[serde(rename = "zweifach")]
    Zweifach,
    #[serde(rename = "dreifach")]
    Dreifach,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum WindowTypeInsetFace {
    #[default]
    #[serde(rename = "aussen")]
    Aussen,
    #[serde(rename = "innen")]
    Innen,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum WindowTypeSillLineFaces {
    #[default]
    #[serde(rename = "aussen")]
    Aussen,
    #[serde(rename = "innen")]
    Innen,
    #[serde(rename = "beide")]
    Beide,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum WindowTypeSillLineView {
    #[default]
    #[serde(rename = "auf")]
    Auf,
    #[serde(rename = "unter")]
    Unter,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct WindowTypeSillLine {
    pub faces: WindowTypeSillLineFaces,
    pub view: WindowTypeSillLineView,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum WindowTypeSillBoard {
    #[default]
    #[serde(rename = "keine")]
    Keine,
    #[serde(rename = "innen")]
    Innen,
    #[serde(rename = "aussen")]
    Aussen,
    #[serde(rename = "beide")]
    Beide,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct WindowType {
    pub id: String,
    pub name: String,
    pub kind: OpeningKind,
    #[serde(rename = "wingCount")]
    pub wing_count: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sashes: Option<Vec<SashDef>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shading: Option<WindowShading>,
    #[serde(rename = "glazingPanes", default, skip_serializing_if = "Option::is_none")]
    pub glazing_panes: Option<f64>,
    #[serde(rename = "mullionRows", default, skip_serializing_if = "Option::is_none")]
    pub mullion_rows: Option<f64>,
    #[serde(rename = "mullionCols", default, skip_serializing_if = "Option::is_none")]
    pub mullion_cols: Option<f64>,
    pub glazing: WindowTypeGlazing,
    #[serde(rename = "frameThickness")]
    pub frame_thickness: f64,
    #[serde(rename = "frameDepth", default, skip_serializing_if = "Option::is_none")]
    pub frame_depth: Option<f64>,
    #[serde(rename = "frameWidth", default, skip_serializing_if = "Option::is_none")]
    pub frame_width: Option<f64>,
    #[serde(rename = "frameCornerJoin", default, skip_serializing_if = "Option::is_none")]
    pub frame_corner_join: Option<FrameCornerJoin>,
    #[serde(rename = "insetFromFace", default, skip_serializing_if = "Option::is_none")]
    pub inset_from_face: Option<f64>,
    #[serde(rename = "insetFace", default, skip_serializing_if = "Option::is_none")]
    pub inset_face: Option<WindowTypeInsetFace>,
    #[serde(rename = "innerLayerRecess", default, skip_serializing_if = "Option::is_none")]
    pub inner_layer_recess: Option<bool>,
    #[serde(rename = "transomHeight", default, skip_serializing_if = "Option::is_none")]
    pub transom_height: Option<f64>,
    #[serde(rename = "sillLine", default, skip_serializing_if = "Option::is_none")]
    pub sill_line: Option<WindowTypeSillLine>,
    #[serde(rename = "defaultSillHeight")]
    pub default_sill_height: f64,
    #[serde(rename = "defaultWidth")]
    pub default_width: f64,
    #[serde(rename = "defaultHeight")]
    pub default_height: f64,
    #[serde(rename = "sillBoard", default, skip_serializing_if = "Option::is_none")]
    pub sill_board: Option<WindowTypeSillBoard>,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum StairTypeStructure {
    #[default]
    #[serde(rename = "massiv")]
    Massiv,
    #[serde(rename = "beton")]
    Beton,
    #[serde(rename = "wange")]
    Wange,
    #[serde(rename = "aufgesattelt")]
    Aufgesattelt,
    #[serde(rename = "spindel")]
    Spindel,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum StairTypeRailing {
    #[default]
    #[serde(rename = "keine")]
    Keine,
    #[serde(rename = "links")]
    Links,
    #[serde(rename = "rechts")]
    Rechts,
    #[serde(rename = "beide")]
    Beide,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct StairType {
    pub id: String,
    pub name: String,
    pub structure: StairTypeStructure,
    #[serde(rename = "closedRisers")]
    pub closed_risers: bool,
    #[serde(rename = "treadThickness")]
    pub tread_thickness: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nosing: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub railing: Option<StairTypeRailing>,
    #[serde(rename = "defaultWidth")]
    pub default_width: f64,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ColorPen {
    pub id: String,
    pub name: String,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct PenStyle {
    pub color: String,
    pub weight: f64,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct PenSet {
    pub id: String,
    pub name: String,
    pub pens: std::collections::BTreeMap<String, PenStyle>,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct CustomPalette {
    pub id: String,
    pub name: String,
    pub colors: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub visible: Option<bool>,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct BuiltinPaletteBanks {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub simple: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tango: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub material: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ral: Option<bool>,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum DrawingLevelKind {
    #[default]
    #[serde(rename = "floor")]
    Floor,
    #[serde(rename = "section")]
    Section,
    #[serde(rename = "elevation")]
    Elevation,
    #[serde(rename = "drawing")]
    Drawing,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct DrawingLevel {
    pub id: String,
    pub name: String,
    pub kind: DrawingLevelKind,
    pub visible: bool,
    pub locked: bool,
    #[serde(rename = "floorHeight", default, skip_serializing_if = "Option::is_none")]
    pub floor_height: Option<f64>,
    #[serde(rename = "cutHeight", default, skip_serializing_if = "Option::is_none")]
    pub cut_height: Option<f64>,
    #[serde(rename = "baseElevation", default, skip_serializing_if = "Option::is_none")]
    pub base_elevation: Option<f64>,
    #[serde(rename = "linePoints", default, skip_serializing_if = "Option::is_none")]
    pub line_points: Option<[Vec2; 2]>,
    #[serde(rename = "directionSign", default, skip_serializing_if = "Option::is_none")]
    pub direction_sign: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shadows: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub depth: Option<f64>,
    #[serde(rename = "hiddenLines", default, skip_serializing_if = "Option::is_none")]
    pub hidden_lines: Option<bool>,
    #[serde(rename = "planUnderlayId", default, skip_serializing_if = "Option::is_none")]
    pub plan_underlay_id: Option<String>,
    #[serde(rename = "levelMarks", default, skip_serializing_if = "Option::is_none")]
    pub level_marks: Option<bool>,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum SiaCategory {
    #[default]
    #[serde(rename = "HNF")]
    HNF,
    #[serde(rename = "NNF")]
    NNF,
    #[serde(rename = "VF")]
    VF,
    #[serde(rename = "FF")]
    FF,
    #[serde(rename = "KGF")]
    KGF,
    #[serde(rename = "AGF")]
    AGF,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct RoomProgramRow {
    pub name: String,
    #[serde(rename = "siaCategory", default, skip_serializing_if = "Option::is_none")]
    pub sia_category: Option<SiaCategory>,
    pub area: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub count: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct SunStudy {
    pub when: String,
    pub show: bool,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct SiteRulesBuildingLines {
    pub a: Vec2,
    pub b: Vec2,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct SiteRules {
    pub parcel: Vec<Vec2>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub setbacks: Option<Vec<f64>>,
    #[serde(rename = "defaultSetback")]
    pub default_setback: f64,
    #[serde(rename = "buildingLines", default, skip_serializing_if = "Option::is_none")]
    pub building_lines: Option<Vec<SiteRulesBuildingLines>>,
    #[serde(rename = "maxHeight", default, skip_serializing_if = "Option::is_none")]
    pub max_height: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub show: Option<bool>,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct LayerCategory {
    pub code: String,
    pub name: String,
    pub color: String,
    #[serde(rename = "colorPenId", default, skip_serializing_if = "Option::is_none")]
    pub color_pen_id: Option<String>,
    pub lw: f64,
    pub visible: bool,
    pub locked: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hatch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<LayerCategory>>,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum AttributeSource {
    #[default]
    #[serde(rename = "layer")]
    Layer,
    #[serde(rename = "object")]
    Object,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum WallReferenceLine {
    #[default]
    #[serde(rename = "left")]
    Left,
    #[serde(rename = "center")]
    Center,
    #[serde(rename = "right")]
    Right,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum SliceTermination {
    #[default]
    #[serde(rename = "both")]
    Both,
    #[serde(rename = "below")]
    Below,
    #[serde(rename = "above")]
    Above,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Wall {
    pub id: String,
    pub r#type: String,
    #[serde(rename = "floorId")]
    pub floor_id: String,
    #[serde(rename = "categoryCode")]
    pub category_code: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub locked: Option<bool>,
    pub start: Vec2,
    pub end: Vec2,
    #[serde(rename = "wallTypeId")]
    pub wall_type_id: String,
    pub height: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(rename = "colorPenId", default, skip_serializing_if = "Option::is_none")]
    pub color_pen_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub foreground: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub background: Option<String>,
    #[serde(rename = "foregroundPenId", default, skip_serializing_if = "Option::is_none")]
    pub foreground_pen_id: Option<String>,
    #[serde(rename = "backgroundPenId", default, skip_serializing_if = "Option::is_none")]
    pub background_pen_id: Option<String>,
    #[serde(rename = "strokeWeight", default, skip_serializing_if = "Option::is_none")]
    pub stroke_weight: Option<f64>,
    #[serde(rename = "hatchId", default, skip_serializing_if = "Option::is_none")]
    pub hatch_id: Option<String>,
    #[serde(rename = "foregroundSource", default, skip_serializing_if = "Option::is_none")]
    pub foreground_source: Option<AttributeSource>,
    #[serde(rename = "backgroundSource", default, skip_serializing_if = "Option::is_none")]
    pub background_source: Option<AttributeSource>,
    #[serde(rename = "strokeWeightSource", default, skip_serializing_if = "Option::is_none")]
    pub stroke_weight_source: Option<AttributeSource>,
    #[serde(rename = "hatchSource", default, skip_serializing_if = "Option::is_none")]
    pub hatch_source: Option<AttributeSource>,
    #[serde(rename = "referenceLine", default, skip_serializing_if = "Option::is_none")]
    pub reference_line: Option<WallReferenceLine>,
    #[serde(rename = "referenceOffset", default, skip_serializing_if = "Option::is_none")]
    pub reference_offset: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bottom: Option<VerticalAnchor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub top: Option<VerticalAnchor>,
    #[serde(rename = "sliceTermination", default, skip_serializing_if = "Option::is_none")]
    pub slice_termination: Option<SliceTermination>,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Ceiling {
    pub id: String,
    pub r#type: String,
    #[serde(rename = "floorId")]
    pub floor_id: String,
    #[serde(rename = "categoryCode")]
    pub category_code: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub locked: Option<bool>,
    pub outline: Vec<Vec2>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub openings: Option<Vec<Vec<Vec2>>>,
    #[serde(rename = "wallTypeId")]
    pub wall_type_id: String,
    #[serde(rename = "ceilingTypeId", default, skip_serializing_if = "Option::is_none")]
    pub ceiling_type_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thickness: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(rename = "colorPenId", default, skip_serializing_if = "Option::is_none")]
    pub color_pen_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub foreground: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub background: Option<String>,
    #[serde(rename = "foregroundPenId", default, skip_serializing_if = "Option::is_none")]
    pub foreground_pen_id: Option<String>,
    #[serde(rename = "backgroundPenId", default, skip_serializing_if = "Option::is_none")]
    pub background_pen_id: Option<String>,
    #[serde(rename = "strokeWeight", default, skip_serializing_if = "Option::is_none")]
    pub stroke_weight: Option<f64>,
    #[serde(rename = "hatchId", default, skip_serializing_if = "Option::is_none")]
    pub hatch_id: Option<String>,
    #[serde(rename = "foregroundSource", default, skip_serializing_if = "Option::is_none")]
    pub foreground_source: Option<AttributeSource>,
    #[serde(rename = "backgroundSource", default, skip_serializing_if = "Option::is_none")]
    pub background_source: Option<AttributeSource>,
    #[serde(rename = "strokeWeightSource", default, skip_serializing_if = "Option::is_none")]
    pub stroke_weight_source: Option<AttributeSource>,
    #[serde(rename = "hatchSource", default, skip_serializing_if = "Option::is_none")]
    pub hatch_source: Option<AttributeSource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub top: Option<VerticalAnchor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bottom: Option<VerticalAnchor>,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum RoofShape {
    #[default]
    #[serde(rename = "flach")]
    Flach,
    #[serde(rename = "pult")]
    Pult,
    #[serde(rename = "sattel")]
    Sattel,
    #[serde(rename = "walm")]
    Walm,
    #[serde(rename = "mansarde")]
    Mansarde,
    #[serde(rename = "zelt")]
    Zelt,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum RoofMansardType {
    #[default]
    #[serde(rename = "giebel")]
    Giebel,
    #[serde(rename = "walm")]
    Walm,
    #[serde(rename = "zelt")]
    Zelt,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum RoofRidgeAxis {
    #[default]
    #[serde(rename = "x")]
    X,
    #[serde(rename = "y")]
    Y,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Roof {
    pub id: String,
    pub r#type: String,
    #[serde(rename = "floorId")]
    pub floor_id: String,
    #[serde(rename = "categoryCode")]
    pub category_code: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub locked: Option<bool>,
    pub outline: Vec<Vec2>,
    pub shape: RoofShape,
    #[serde(rename = "pitchDeg")]
    pub pitch_deg: f64,
    #[serde(rename = "pitchUpperDeg", default, skip_serializing_if = "Option::is_none")]
    pub pitch_upper_deg: Option<f64>,
    #[serde(rename = "mansardType", default, skip_serializing_if = "Option::is_none")]
    pub mansard_type: Option<RoofMansardType>,
    #[serde(rename = "mansardKneeRatio", default, skip_serializing_if = "Option::is_none")]
    pub mansard_knee_ratio: Option<f64>,
    #[serde(rename = "halfHipRatio", default, skip_serializing_if = "Option::is_none")]
    pub half_hip_ratio: Option<f64>,
    pub overhang: f64,
    #[serde(rename = "overhangGable", default, skip_serializing_if = "Option::is_none")]
    pub overhang_gable: Option<f64>,
    #[serde(rename = "ridgeAxis")]
    pub ridge_axis: RoofRidgeAxis,
    #[serde(rename = "baseElevation", default, skip_serializing_if = "Option::is_none")]
    pub base_elevation: Option<f64>,
    pub thickness: f64,
    #[serde(rename = "roofTypeId", default, skip_serializing_if = "Option::is_none")]
    pub roof_type_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(rename = "colorPenId", default, skip_serializing_if = "Option::is_none")]
    pub color_pen_id: Option<String>,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum ElementKind {
    #[default]
    #[serde(rename = "window")]
    Window,
    #[serde(rename = "door")]
    Door,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum OpeningDoorType {
    #[default]
    #[serde(rename = "normal")]
    Normal,
    #[serde(rename = "wandoeffnung")]
    Wandoeffnung,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum OpeningHinge {
    #[default]
    #[serde(rename = "start")]
    Start,
    #[serde(rename = "end")]
    End,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum SwingSide {
    #[default]
    #[serde(rename = "left")]
    Left,
    #[serde(rename = "right")]
    Right,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum OpeningOpeningDir {
    #[default]
    #[serde(rename = "in")]
    In,
    #[serde(rename = "out")]
    Out,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum OpeningLintelLines {
    #[default]
    #[serde(rename = "keine")]
    Keine,
    #[serde(rename = "innen")]
    Innen,
    #[serde(rename = "aussen")]
    Aussen,
    #[serde(rename = "beide")]
    Beide,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum DetailLevel {
    #[default]
    #[serde(rename = "grob")]
    Grob,
    #[serde(rename = "mittel")]
    Mittel,
    #[serde(rename = "fein")]
    Fein,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct LineStyleOverride {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub weight: Option<f64>,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Opening {
    pub id: String,
    pub r#type: String,
    #[serde(rename = "hostWallId")]
    pub host_wall_id: String,
    #[serde(rename = "categoryCode")]
    pub category_code: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub locked: Option<bool>,
    pub kind: ElementKind,
    pub position: f64,
    pub width: f64,
    pub height: f64,
    #[serde(rename = "sillHeight")]
    pub sill_height: f64,
    #[serde(rename = "wingCount", default, skip_serializing_if = "Option::is_none")]
    pub wing_count: Option<f64>,
    #[serde(rename = "doorType", default, skip_serializing_if = "Option::is_none")]
    pub door_type: Option<OpeningDoorType>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hinge: Option<OpeningHinge>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub swing: Option<SwingSide>,
    #[serde(rename = "swingAngle", default, skip_serializing_if = "Option::is_none")]
    pub swing_angle: Option<f64>,
    #[serde(rename = "openingDir", default, skip_serializing_if = "Option::is_none")]
    pub opening_dir: Option<OpeningOpeningDir>,
    #[serde(rename = "frameThickness", default, skip_serializing_if = "Option::is_none")]
    pub frame_thickness: Option<f64>,
    #[serde(rename = "lintelLines", default, skip_serializing_if = "Option::is_none")]
    pub lintel_lines: Option<OpeningLintelLines>,
    #[serde(rename = "typeId", default, skip_serializing_if = "Option::is_none")]
    pub type_id: Option<String>,
    #[serde(rename = "detailLevel", default, skip_serializing_if = "Option::is_none")]
    pub detail_level: Option<DetailLevel>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(rename = "colorPenId", default, skip_serializing_if = "Option::is_none")]
    pub color_pen_id: Option<String>,
    #[serde(rename = "frameLine", default, skip_serializing_if = "Option::is_none")]
    pub frame_line: Option<LineStyleOverride>,
    #[serde(rename = "frameViewLine", default, skip_serializing_if = "Option::is_none")]
    pub frame_view_line: Option<LineStyleOverride>,
    #[serde(rename = "sashLine", default, skip_serializing_if = "Option::is_none")]
    pub sash_line: Option<LineStyleOverride>,
    #[serde(rename = "sillLineStyle", default, skip_serializing_if = "Option::is_none")]
    pub sill_line_style: Option<LineStyleOverride>,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum StairShape {
    #[default]
    #[serde(rename = "straight")]
    Straight,
    #[serde(rename = "L")]
    L,
    #[serde(rename = "spiral")]
    Spiral,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum StairReferenz {
    #[default]
    #[serde(rename = "links")]
    Links,
    #[serde(rename = "mitte")]
    Mitte,
    #[serde(rename = "rechts")]
    Rechts,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum StairArrowStyle {
    #[default]
    #[serde(rename = "line")]
    Line,
    #[serde(rename = "filled")]
    Filled,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Stair {
    pub id: String,
    pub r#type: String,
    #[serde(rename = "floorId")]
    pub floor_id: String,
    #[serde(rename = "categoryCode")]
    pub category_code: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub locked: Option<bool>,
    pub shape: StairShape,
    pub start: Vec2,
    pub dir: Vec2,
    #[serde(rename = "runLength")]
    pub run_length: f64,
    #[serde(rename = "run2Length", default, skip_serializing_if = "Option::is_none")]
    pub run2_length: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub center: Option<Vec2>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub radius: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sweep: Option<f64>,
    pub width: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub referenz: Option<StairReferenz>,
    #[serde(rename = "totalRise", default, skip_serializing_if = "Option::is_none")]
    pub total_rise: Option<f64>,
    #[serde(rename = "stepCount")]
    pub step_count: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub up: Option<bool>,
    #[serde(rename = "typeId", default, skip_serializing_if = "Option::is_none")]
    pub type_id: Option<String>,
    #[serde(rename = "detailLevel", default, skip_serializing_if = "Option::is_none")]
    pub detail_level: Option<DetailLevel>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(rename = "colorPenId", default, skip_serializing_if = "Option::is_none")]
    pub color_pen_id: Option<String>,
    #[serde(rename = "arrowStyle", default, skip_serializing_if = "Option::is_none")]
    pub arrow_style: Option<StairArrowStyle>,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct TextRun {
    pub text: String,
    pub marks: Marks,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum Align {
    #[default]
    #[serde(rename = "left")]
    Left,
    #[serde(rename = "center")]
    Center,
    #[serde(rename = "right")]
    Right,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Paragraph {
    pub runs: Vec<TextRun>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub align: Option<Align>,
    #[serde(rename = "lineHeight", default, skip_serializing_if = "Option::is_none")]
    pub line_height: Option<f64>,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct RichTextDoc {
    pub version: f64,
    pub paragraphs: Vec<Paragraph>,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct RoomStamp {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub number: Option<String>,
    pub name: String,
    #[serde(rename = "nameLine2", default, skip_serializing_if = "Option::is_none")]
    pub name_line2: Option<String>,
    #[serde(rename = "showFloorArea")]
    pub show_floor_area: bool,
    #[serde(rename = "floorAreaPrefix", default, skip_serializing_if = "Option::is_none")]
    pub floor_area_prefix: Option<String>,
    #[serde(rename = "showUsage")]
    pub show_usage: bool,
    #[serde(rename = "nameAlign", default, skip_serializing_if = "Option::is_none")]
    pub name_align: Option<Align>,
    #[serde(rename = "line2Align", default, skip_serializing_if = "Option::is_none")]
    pub line2_align: Option<Align>,
    #[serde(rename = "floorAreaAlign", default, skip_serializing_if = "Option::is_none")]
    pub floor_area_align: Option<Align>,
    #[serde(rename = "usageAlign", default, skip_serializing_if = "Option::is_none")]
    pub usage_align: Option<Align>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub occupancy: Option<f64>,
    #[serde(rename = "roundingStep", default, skip_serializing_if = "Option::is_none")]
    pub rounding_step: Option<f64>,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Room {
    pub id: String,
    pub r#type: String,
    #[serde(rename = "floorId")]
    pub floor_id: String,
    #[serde(rename = "categoryCode")]
    pub category_code: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub locked: Option<bool>,
    #[serde(rename = "siaCategory")]
    pub sia_category: SiaCategory,
    pub name: String,
    pub boundary: Vec<Vec2>,
    pub color: String,
    #[serde(rename = "colorPenId", default, skip_serializing_if = "Option::is_none")]
    pub color_pen_id: Option<String>,
    #[serde(rename = "stampAnchor", default, skip_serializing_if = "Option::is_none")]
    pub stamp_anchor: Option<Vec2>,
    #[serde(rename = "stampDoc", default, skip_serializing_if = "Option::is_none")]
    pub stamp_doc: Option<RichTextDoc>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stamp: Option<RoomStamp>,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum EndMark {
    #[default]
    #[serde(rename = "none")]
    None,
    #[serde(rename = "arrow")]
    Arrow,
    #[serde(rename = "arrowOpen")]
    ArrowOpen,
    #[serde(rename = "dot")]
    Dot,
    #[serde(rename = "tick")]
    Tick,
    #[serde(rename = "square")]
    Square,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Drawing2DEndMarks {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start: Option<EndMark>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end: Option<EndMark>,
    #[serde(rename = "sizeMm", default, skip_serializing_if = "Option::is_none")]
    pub size_mm: Option<f64>,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Drawing2D {
    pub id: String,
    pub r#type: String,
    #[serde(rename = "levelId")]
    pub level_id: String,
    #[serde(rename = "categoryCode")]
    pub category_code: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub locked: Option<bool>,
    #[serde(rename = "noPrint", default, skip_serializing_if = "Option::is_none")]
    pub no_print: Option<bool>,
    pub geom: Drawing2DGeom,
    #[serde(rename = "lineStyleId", default, skip_serializing_if = "Option::is_none")]
    pub line_style_id: Option<String>,
    #[serde(rename = "hatchId", default, skip_serializing_if = "Option::is_none")]
    pub hatch_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub foreground: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub background: Option<String>,
    #[serde(rename = "foregroundPenId", default, skip_serializing_if = "Option::is_none")]
    pub foreground_pen_id: Option<String>,
    #[serde(rename = "backgroundPenId", default, skip_serializing_if = "Option::is_none")]
    pub background_pen_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(rename = "colorPenId", default, skip_serializing_if = "Option::is_none")]
    pub color_pen_id: Option<String>,
    #[serde(rename = "dashScale", default, skip_serializing_if = "Option::is_none")]
    pub dash_scale: Option<f64>,
    #[serde(rename = "hatchAngleDeg", default, skip_serializing_if = "Option::is_none")]
    pub hatch_angle_deg: Option<f64>,
    #[serde(rename = "hatchScale", default, skip_serializing_if = "Option::is_none")]
    pub hatch_scale: Option<f64>,
    #[serde(rename = "hatchOrigin", default, skip_serializing_if = "Option::is_none")]
    pub hatch_origin: Option<Vec2>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub opacity: Option<f64>,
    #[serde(rename = "fillOpacity", default, skip_serializing_if = "Option::is_none")]
    pub fill_opacity: Option<f64>,
    #[serde(rename = "endMarks", default, skip_serializing_if = "Option::is_none")]
    pub end_marks: Option<Drawing2DEndMarks>,
    #[serde(rename = "fillColor", default, skip_serializing_if = "Option::is_none")]
    pub fill_color: Option<String>,
    #[serde(rename = "weightMm", default, skip_serializing_if = "Option::is_none")]
    pub weight_mm: Option<f64>,
    #[serde(rename = "foregroundSource", default, skip_serializing_if = "Option::is_none")]
    pub foreground_source: Option<AttributeSource>,
    #[serde(rename = "backgroundSource", default, skip_serializing_if = "Option::is_none")]
    pub background_source: Option<AttributeSource>,
    #[serde(rename = "strokeWeightSource", default, skip_serializing_if = "Option::is_none")]
    pub stroke_weight_source: Option<AttributeSource>,
    #[serde(rename = "hatchSource", default, skip_serializing_if = "Option::is_none")]
    pub hatch_source: Option<AttributeSource>,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ExtrudedSolidCircle {
    pub center: Vec2,
    pub r: f64,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ExtrudedSolidBrep {
    pub spec: std::collections::BTreeMap<String, serde_json::Value>,
    pub origin: Vec2,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ExtrudedSolid {
    pub id: String,
    pub r#type: String,
    #[serde(rename = "levelId")]
    pub level_id: String,
    pub points: Vec<Vec2>,
    pub height: f64,
    #[serde(rename = "baseOffset", default, skip_serializing_if = "Option::is_none")]
    pub base_offset: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operation: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub circle: Option<ExtrudedSolidCircle>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub taper: Option<f64>,
    #[serde(rename = "cornerRadius", default, skip_serializing_if = "Option::is_none")]
    pub corner_radius: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chamfer: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub brep: Option<ExtrudedSolidBrep>,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Column {
    pub id: String,
    pub r#type: String,
    #[serde(rename = "floorId")]
    pub floor_id: String,
    #[serde(rename = "categoryCode")]
    pub category_code: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub locked: Option<bool>,
    pub position: Vec2,
    pub profile: ColumnProfile,
    pub rotation: f64,
    pub height: f64,
    #[serde(rename = "componentId", default, skip_serializing_if = "Option::is_none")]
    pub component_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bottom: Option<VerticalAnchor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub top: Option<VerticalAnchor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(rename = "colorPenId", default, skip_serializing_if = "Option::is_none")]
    pub color_pen_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub foreground: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub background: Option<String>,
    #[serde(rename = "foregroundPenId", default, skip_serializing_if = "Option::is_none")]
    pub foreground_pen_id: Option<String>,
    #[serde(rename = "backgroundPenId", default, skip_serializing_if = "Option::is_none")]
    pub background_pen_id: Option<String>,
    #[serde(rename = "strokeWeight", default, skip_serializing_if = "Option::is_none")]
    pub stroke_weight: Option<f64>,
    #[serde(rename = "hatchId", default, skip_serializing_if = "Option::is_none")]
    pub hatch_id: Option<String>,
    #[serde(rename = "foregroundSource", default, skip_serializing_if = "Option::is_none")]
    pub foreground_source: Option<AttributeSource>,
    #[serde(rename = "backgroundSource", default, skip_serializing_if = "Option::is_none")]
    pub background_source: Option<AttributeSource>,
    #[serde(rename = "strokeWeightSource", default, skip_serializing_if = "Option::is_none")]
    pub stroke_weight_source: Option<AttributeSource>,
    #[serde(rename = "hatchSource", default, skip_serializing_if = "Option::is_none")]
    pub hatch_source: Option<AttributeSource>,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Group {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(rename = "wallIds")]
    pub wall_ids: Vec<String>,
    #[serde(rename = "drawingIds")]
    pub drawing_ids: Vec<String>,
    #[serde(rename = "ceilingIds")]
    pub ceiling_ids: Vec<String>,
    #[serde(rename = "roomIds")]
    pub room_ids: Vec<String>,
    #[serde(rename = "stairIds")]
    pub stair_ids: Vec<String>,
    #[serde(rename = "columnIds")]
    pub column_ids: Vec<String>,
    #[serde(rename = "roofIds")]
    pub roof_ids: Vec<String>,
    #[serde(rename = "openingIds")]
    pub opening_ids: Vec<String>,
    #[serde(rename = "groupIds")]
    pub group_ids: Vec<String>,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ParametricWall {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub rules: Vec<ParametricRule>,
    #[serde(rename = "defaultWallTypeId")]
    pub default_wall_type_id: String,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum OverrideConditionType {
    #[default]
    #[serde(rename = "layer_name")]
    LayerName,
    #[serde(rename = "object_name")]
    ObjectName,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum OverrideOperator {
    #[default]
    #[serde(rename = "equals")]
    Equals,
    #[serde(rename = "contains")]
    Contains,
    #[serde(rename = "starts_with")]
    StartsWith,
    #[serde(rename = "not_equals")]
    NotEquals,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct OverrideCondition {
    pub r#type: OverrideConditionType,
    pub operator: OverrideOperator,
    pub value: String,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct OverrideActions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lineweight: Option<f64>,
    #[serde(rename = "linetypeId", default, skip_serializing_if = "Option::is_none")]
    pub linetype_id: Option<String>,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct OverrideRule {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub condition: OverrideCondition,
    pub actions: OverrideActions,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum ViewType {
    #[default]
    #[serde(rename = "grundriss")]
    Grundriss,
    #[serde(rename = "perspektive")]
    Perspektive,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum View3d {
    #[default]
    #[serde(rename = "front")]
    Front,
    #[serde(rename = "back")]
    Back,
    #[serde(rename = "side")]
    Side,
    #[serde(rename = "left")]
    Left,
    #[serde(rename = "top")]
    Top,
    #[serde(rename = "iso")]
    Iso,
    #[serde(rename = "isoFrontLeft")]
    IsoFrontLeft,
    #[serde(rename = "isoBackRight")]
    IsoBackRight,
    #[serde(rename = "isoBackLeft")]
    IsoBackLeft,
    #[serde(rename = "perspective")]
    Perspective,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ViewSnapshot {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub folder: Option<String>,
    #[serde(rename = "folderId", default, skip_serializing_if = "Option::is_none")]
    pub folder_id: Option<String>,
    #[serde(rename = "viewType")]
    pub view_type: ViewType,
    pub view3d: View3d,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fov: Option<f64>,
    #[serde(rename = "scaleDenominator")]
    pub scale_denominator: f64,
    pub detail: DetailLevel,
    #[serde(rename = "activeLevelId")]
    pub active_level_id: String,
    #[serde(rename = "layerVisibility")]
    pub layer_visibility: std::collections::BTreeMap<String, bool>,
    #[serde(rename = "drawingVisibility")]
    pub drawing_visibility: std::collections::BTreeMap<String, bool>,
    #[serde(rename = "enabledOverrideRuleIds", default, skip_serializing_if = "Option::is_none")]
    pub enabled_override_rule_ids: Option<Vec<String>>,
    #[serde(rename = "cameraCenter", default, skip_serializing_if = "Option::is_none")]
    pub camera_center: Option<Vec2>,
    #[serde(rename = "cameraPxPerMeter", default, skip_serializing_if = "Option::is_none")]
    pub camera_px_per_meter: Option<f64>,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ViewSnapshotFolder {
    pub id: String,
    pub name: String,
    #[serde(rename = "parentId", default, skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum LayoutPaperFormat {
    #[default]
    #[serde(rename = "a0")]
    A0,
    #[serde(rename = "a1")]
    A1,
    #[serde(rename = "a2")]
    A2,
    #[serde(rename = "a3")]
    A3,
    #[serde(rename = "a4")]
    A4,
    #[serde(rename = "a5")]
    A5,
    #[serde(rename = "a6")]
    A6,
    #[serde(rename = "b0")]
    B0,
    #[serde(rename = "b1")]
    B1,
    #[serde(rename = "b2")]
    B2,
    #[serde(rename = "b3")]
    B3,
    #[serde(rename = "b4")]
    B4,
    #[serde(rename = "b5")]
    B5,
    #[serde(rename = "b6")]
    B6,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum LayoutOrientation {
    #[default]
    #[serde(rename = "portrait")]
    Portrait,
    #[serde(rename = "landscape")]
    Landscape,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct LayoutViewport {
    pub id: String,
    #[serde(rename = "snapshotId")]
    pub snapshot_id: String,
    #[serde(rename = "xMm")]
    pub x_mm: f64,
    #[serde(rename = "yMm")]
    pub y_mm: f64,
    #[serde(rename = "widthMm")]
    pub width_mm: f64,
    #[serde(rename = "heightMm")]
    pub height_mm: f64,
    #[serde(rename = "scaleDenominator", default, skip_serializing_if = "Option::is_none")]
    pub scale_denominator: Option<f64>,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Layout {
    pub id: String,
    pub name: String,
    pub paper: LayoutPaperFormat,
    pub orientation: LayoutOrientation,
    #[serde(rename = "planNumber", default, skip_serializing_if = "Option::is_none")]
    pub plan_number: Option<String>,
    #[serde(rename = "masterId", default, skip_serializing_if = "Option::is_none")]
    pub master_id: Option<String>,
    #[serde(rename = "folderId", default, skip_serializing_if = "Option::is_none")]
    pub folder_id: Option<String>,
    #[serde(rename = "customWidthMm", default, skip_serializing_if = "Option::is_none")]
    pub custom_width_mm: Option<f64>,
    #[serde(rename = "customHeightMm", default, skip_serializing_if = "Option::is_none")]
    pub custom_height_mm: Option<f64>,
    pub viewports: Vec<LayoutViewport>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub annotations: Option<Vec<LayoutAnnotation>>,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct LayoutTitleBlock {
    #[serde(rename = "projectName", default, skip_serializing_if = "Option::is_none")]
    pub project_name: Option<String>,
    #[serde(rename = "sheetName", default, skip_serializing_if = "Option::is_none")]
    pub sheet_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scale: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub date: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct MasterLayout {
    pub id: String,
    pub name: String,
    pub paper: LayoutPaperFormat,
    pub orientation: LayoutOrientation,
    #[serde(rename = "titleBlock")]
    pub title_block: LayoutTitleBlock,
    #[serde(rename = "folderId", default, skip_serializing_if = "Option::is_none")]
    pub folder_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub border: Option<bool>,
    #[serde(rename = "customWidthMm", default, skip_serializing_if = "Option::is_none")]
    pub custom_width_mm: Option<f64>,
    #[serde(rename = "customHeightMm", default, skip_serializing_if = "Option::is_none")]
    pub custom_height_mm: Option<f64>,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum LayoutFolderKind {
    #[default]
    #[serde(rename = "layout")]
    Layout,
    #[serde(rename = "master")]
    Master,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct LayoutFolder {
    pub id: String,
    pub name: String,
    #[serde(rename = "parentId", default, skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<LayoutFolderKind>,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ProjectGeoAnchorLv95 {
    pub e: f64,
    pub n: f64,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ProjectGeoAnchor {
    pub lv95: ProjectGeoAnchorLv95,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<f64>,
    pub model: Vec2,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Project {
    #[serde(rename = "formatVersion", default, skip_serializing_if = "Option::is_none")]
    pub format_version: Option<f64>,
    pub id: String,
    pub name: String,
    #[serde(rename = "lineStyles")]
    pub line_styles: Vec<LineStyle>,
    #[serde(rename = "textStyles", default, skip_serializing_if = "Option::is_none")]
    pub text_styles: Option<Vec<TextStylePreset>>,
    pub hatches: Vec<HatchStyle>,
    pub components: Vec<Component>,
    #[serde(rename = "wallTypes")]
    pub wall_types: Vec<WallType>,
    #[serde(rename = "ceilingTypes", default, skip_serializing_if = "Option::is_none")]
    pub ceiling_types: Option<Vec<CeilingType>>,
    #[serde(rename = "roofTypes", default, skip_serializing_if = "Option::is_none")]
    pub roof_types: Option<Vec<RoofType>>,
    #[serde(rename = "blockDefs", default, skip_serializing_if = "Option::is_none")]
    pub block_defs: Option<Vec<BlockDef>>,
    #[serde(rename = "doorTypes", default, skip_serializing_if = "Option::is_none")]
    pub door_types: Option<Vec<DoorType>>,
    #[serde(rename = "windowTypes", default, skip_serializing_if = "Option::is_none")]
    pub window_types: Option<Vec<WindowType>>,
    #[serde(rename = "stairTypes", default, skip_serializing_if = "Option::is_none")]
    pub stair_types: Option<Vec<StairType>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pens: Option<Vec<ColorPen>>,
    #[serde(rename = "penSets", default, skip_serializing_if = "Option::is_none")]
    pub pen_sets: Option<Vec<PenSet>>,
    #[serde(rename = "activePenSetId", default, skip_serializing_if = "Option::is_none")]
    pub active_pen_set_id: Option<String>,
    #[serde(rename = "customPalettes", default, skip_serializing_if = "Option::is_none")]
    pub custom_palettes: Option<Vec<CustomPalette>>,
    #[serde(rename = "builtinPaletteBanks", default, skip_serializing_if = "Option::is_none")]
    pub builtin_palette_banks: Option<BuiltinPaletteBanks>,
    #[serde(rename = "drawingLevels")]
    pub drawing_levels: Vec<DrawingLevel>,
    #[serde(rename = "roomProgram", default, skip_serializing_if = "Option::is_none")]
    pub room_program: Option<Vec<RoomProgramRow>>,
    #[serde(rename = "roomProgramTolerance", default, skip_serializing_if = "Option::is_none")]
    pub room_program_tolerance: Option<f64>,
    #[serde(rename = "parcelArea", default, skip_serializing_if = "Option::is_none")]
    pub parcel_area: Option<f64>,
    #[serde(rename = "sunStudy", default, skip_serializing_if = "Option::is_none")]
    pub sun_study: Option<SunStudy>,
    #[serde(rename = "siteRules", default, skip_serializing_if = "Option::is_none")]
    pub site_rules: Option<SiteRules>,
    #[serde(rename = "scaleLineWeights", default, skip_serializing_if = "Option::is_none")]
    pub scale_line_weights: Option<bool>,
    pub layers: Vec<LayerCategory>,
    pub walls: Vec<Wall>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ceilings: Option<Vec<Ceiling>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub roofs: Option<Vec<Roof>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub openings: Option<Vec<Opening>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stairs: Option<Vec<Stair>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rooms: Option<Vec<Room>>,
    pub drawings2d: Vec<Drawing2D>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<Vec<ContextObject>>,
    #[serde(rename = "extrudedSolids", default, skip_serializing_if = "Option::is_none")]
    pub extruded_solids: Option<Vec<ExtrudedSolid>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub columns: Option<Vec<Column>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub groups: Option<Vec<Group>>,
    #[serde(rename = "parametricWalls", default, skip_serializing_if = "Option::is_none")]
    pub parametric_walls: Option<Vec<ParametricWall>>,
    #[serde(rename = "overrideRules", default, skip_serializing_if = "Option::is_none")]
    pub override_rules: Option<Vec<OverrideRule>>,
    #[serde(rename = "viewSnapshots", default, skip_serializing_if = "Option::is_none")]
    pub view_snapshots: Option<Vec<ViewSnapshot>>,
    #[serde(rename = "viewSnapshotFolders", default, skip_serializing_if = "Option::is_none")]
    pub view_snapshot_folders: Option<Vec<ViewSnapshotFolder>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layouts: Option<Vec<Layout>>,
    #[serde(rename = "masterLayouts", default, skip_serializing_if = "Option::is_none")]
    pub master_layouts: Option<Vec<MasterLayout>>,
    #[serde(rename = "layoutFolders", default, skip_serializing_if = "Option::is_none")]
    pub layout_folders: Option<Vec<LayoutFolder>>,
    #[serde(rename = "referenceElevationMasl", default, skip_serializing_if = "Option::is_none")]
    pub reference_elevation_masl: Option<f64>,
    #[serde(rename = "geoAnchor", default, skip_serializing_if = "Option::is_none")]
    pub geo_anchor: Option<ProjectGeoAnchor>,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum GridRuleDirections {
    #[default]
    #[serde(rename = "x")]
    X,
    #[serde(rename = "y")]
    Y,
    #[serde(rename = "both")]
    Both,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct GridRule {
    #[serde(rename = "gridId", default, skip_serializing_if = "Option::is_none")]
    pub grid_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spacing: Option<f64>,
    pub directions: GridRuleDirections,
    #[serde(rename = "boundaryId", default, skip_serializing_if = "Option::is_none")]
    pub boundary_id: Option<String>,
    #[serde(rename = "wallTypeId", default, skip_serializing_if = "Option::is_none")]
    pub wall_type_id: Option<String>,
    #[serde(rename = "referenceLine", default, skip_serializing_if = "Option::is_none")]
    pub reference_line: Option<WallReferenceLine>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<f64>,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum ModuleRuleDirection {
    #[default]
    #[serde(rename = "x")]
    X,
    #[serde(rename = "y")]
    Y,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ModuleRule {
    #[serde(rename = "moduleSize")]
    pub module_size: f64,
    pub direction: ModuleRuleDirection,
    #[serde(rename = "referenceWallId", default, skip_serializing_if = "Option::is_none")]
    pub reference_wall_id: Option<String>,
    #[serde(rename = "wallTypeId", default, skip_serializing_if = "Option::is_none")]
    pub wall_type_id: Option<String>,
    #[serde(rename = "referenceLine", default, skip_serializing_if = "Option::is_none")]
    pub reference_line: Option<WallReferenceLine>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<f64>,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum ConditionalThicknessRuleLogic {
    #[default]
    #[serde(rename = "and")]
    And,
    #[serde(rename = "or")]
    Or,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ConditionalThicknessRule {
    pub condition: serde_json::Value,
    #[serde(rename = "wallTypeId")]
    pub wall_type_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub logic: Option<ConditionalThicknessRuleLogic>,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ReferenceLineRule {
    #[serde(rename = "referenceLine")]
    pub reference_line: WallReferenceLine,
    pub target: serde_json::Value,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct SequenceRule {
    pub rules: Vec<ParametricRule>,
    #[serde(rename = "stopOnMatch", default, skip_serializing_if = "Option::is_none")]
    pub stop_on_match: Option<bool>,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ImportedMesh {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layer: Option<String>,
    #[serde(rename = "categoryCode", default, skip_serializing_if = "Option::is_none")]
    pub category_code: Option<String>,
    pub positions: Vec<f64>,
    pub indices: Vec<f64>,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum ContourCurveKind {
    #[default]
    #[serde(rename = "circle")]
    Circle,
    #[serde(rename = "arc")]
    Arc,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ContourCurve {
    pub kind: ContourCurveKind,
    pub cx: f64,
    pub cy: f64,
    pub r: f64,
    pub a0: f64,
    pub a1: f64,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Contour {
    pub z: f64,
    pub pts: Vec<Vec2>,
    pub closed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layer: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub curve: Option<ContourCurve>,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ContourSet {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layer: Option<String>,
    #[serde(rename = "categoryCode", default, skip_serializing_if = "Option::is_none")]
    pub category_code: Option<String>,
    pub contours: Vec<Contour>,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct TerrainMesh {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layer: Option<String>,
    #[serde(rename = "categoryCode", default, skip_serializing_if = "Option::is_none")]
    pub category_code: Option<String>,
    pub positions: Vec<f64>,
    pub indices: Vec<f64>,
    #[serde(rename = "vertexColors", default, skip_serializing_if = "Option::is_none")]
    pub vertex_colors: Option<Vec<f64>>,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ContextImageFilters {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub saturation: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub brightness: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub contrast: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub grayscale: Option<f64>,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ContextImage {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layer: Option<String>,
    #[serde(rename = "categoryCode", default, skip_serializing_if = "Option::is_none")]
    pub category_code: Option<String>,
    pub src: String,
    pub min: Vec2,
    pub max: Vec2,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub opacity: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub drape: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filters: Option<ContextImageFilters>,
    #[serde(flatten)]
    pub extra: Extra,
}

impl Project {
    /// Setzt EIN Feld aus dem JSON-Baum (`None` = Feld entfernt → Standardwert); so bleibt die
    /// typisierte Sicht nach einer Op ohne Neu-Parsen des ganzen Projekts aktuell.
    pub fn set_field(&mut self, key: &str, v: Option<&serde_json::Value>) -> Result<(), String> {
        match key {
            "formatVersion" => {
                self.format_version = match v {
                    Some(v) => <Option<f64>>::deserialize(v).map_err(|e| e.to_string())?,
                    None => Default::default(),
                };
            }
            "id" => {
                self.id = match v {
                    Some(v) => <String>::deserialize(v).map_err(|e| e.to_string())?,
                    None => Default::default(),
                };
            }
            "name" => {
                self.name = match v {
                    Some(v) => <String>::deserialize(v).map_err(|e| e.to_string())?,
                    None => Default::default(),
                };
            }
            "lineStyles" => {
                self.line_styles = match v {
                    Some(v) => <Vec<LineStyle>>::deserialize(v).map_err(|e| e.to_string())?,
                    None => Default::default(),
                };
            }
            "textStyles" => {
                self.text_styles = match v {
                    Some(v) => <Option<Vec<TextStylePreset>>>::deserialize(v).map_err(|e| e.to_string())?,
                    None => Default::default(),
                };
            }
            "hatches" => {
                self.hatches = match v {
                    Some(v) => <Vec<HatchStyle>>::deserialize(v).map_err(|e| e.to_string())?,
                    None => Default::default(),
                };
            }
            "components" => {
                self.components = match v {
                    Some(v) => <Vec<Component>>::deserialize(v).map_err(|e| e.to_string())?,
                    None => Default::default(),
                };
            }
            "wallTypes" => {
                self.wall_types = match v {
                    Some(v) => <Vec<WallType>>::deserialize(v).map_err(|e| e.to_string())?,
                    None => Default::default(),
                };
            }
            "ceilingTypes" => {
                self.ceiling_types = match v {
                    Some(v) => <Option<Vec<CeilingType>>>::deserialize(v).map_err(|e| e.to_string())?,
                    None => Default::default(),
                };
            }
            "roofTypes" => {
                self.roof_types = match v {
                    Some(v) => <Option<Vec<RoofType>>>::deserialize(v).map_err(|e| e.to_string())?,
                    None => Default::default(),
                };
            }
            "blockDefs" => {
                self.block_defs = match v {
                    Some(v) => <Option<Vec<BlockDef>>>::deserialize(v).map_err(|e| e.to_string())?,
                    None => Default::default(),
                };
            }
            "doorTypes" => {
                self.door_types = match v {
                    Some(v) => <Option<Vec<DoorType>>>::deserialize(v).map_err(|e| e.to_string())?,
                    None => Default::default(),
                };
            }
            "windowTypes" => {
                self.window_types = match v {
                    Some(v) => <Option<Vec<WindowType>>>::deserialize(v).map_err(|e| e.to_string())?,
                    None => Default::default(),
                };
            }
            "stairTypes" => {
                self.stair_types = match v {
                    Some(v) => <Option<Vec<StairType>>>::deserialize(v).map_err(|e| e.to_string())?,
                    None => Default::default(),
                };
            }
            "pens" => {
                self.pens = match v {
                    Some(v) => <Option<Vec<ColorPen>>>::deserialize(v).map_err(|e| e.to_string())?,
                    None => Default::default(),
                };
            }
            "penSets" => {
                self.pen_sets = match v {
                    Some(v) => <Option<Vec<PenSet>>>::deserialize(v).map_err(|e| e.to_string())?,
                    None => Default::default(),
                };
            }
            "activePenSetId" => {
                self.active_pen_set_id = match v {
                    Some(v) => <Option<String>>::deserialize(v).map_err(|e| e.to_string())?,
                    None => Default::default(),
                };
            }
            "customPalettes" => {
                self.custom_palettes = match v {
                    Some(v) => <Option<Vec<CustomPalette>>>::deserialize(v).map_err(|e| e.to_string())?,
                    None => Default::default(),
                };
            }
            "builtinPaletteBanks" => {
                self.builtin_palette_banks = match v {
                    Some(v) => <Option<BuiltinPaletteBanks>>::deserialize(v).map_err(|e| e.to_string())?,
                    None => Default::default(),
                };
            }
            "drawingLevels" => {
                self.drawing_levels = match v {
                    Some(v) => <Vec<DrawingLevel>>::deserialize(v).map_err(|e| e.to_string())?,
                    None => Default::default(),
                };
            }
            "roomProgram" => {
                self.room_program = match v {
                    Some(v) => <Option<Vec<RoomProgramRow>>>::deserialize(v).map_err(|e| e.to_string())?,
                    None => Default::default(),
                };
            }
            "roomProgramTolerance" => {
                self.room_program_tolerance = match v {
                    Some(v) => <Option<f64>>::deserialize(v).map_err(|e| e.to_string())?,
                    None => Default::default(),
                };
            }
            "parcelArea" => {
                self.parcel_area = match v {
                    Some(v) => <Option<f64>>::deserialize(v).map_err(|e| e.to_string())?,
                    None => Default::default(),
                };
            }
            "sunStudy" => {
                self.sun_study = match v {
                    Some(v) => <Option<SunStudy>>::deserialize(v).map_err(|e| e.to_string())?,
                    None => Default::default(),
                };
            }
            "siteRules" => {
                self.site_rules = match v {
                    Some(v) => <Option<SiteRules>>::deserialize(v).map_err(|e| e.to_string())?,
                    None => Default::default(),
                };
            }
            "scaleLineWeights" => {
                self.scale_line_weights = match v {
                    Some(v) => <Option<bool>>::deserialize(v).map_err(|e| e.to_string())?,
                    None => Default::default(),
                };
            }
            "layers" => {
                self.layers = match v {
                    Some(v) => <Vec<LayerCategory>>::deserialize(v).map_err(|e| e.to_string())?,
                    None => Default::default(),
                };
            }
            "walls" => {
                self.walls = match v {
                    Some(v) => <Vec<Wall>>::deserialize(v).map_err(|e| e.to_string())?,
                    None => Default::default(),
                };
            }
            "ceilings" => {
                self.ceilings = match v {
                    Some(v) => <Option<Vec<Ceiling>>>::deserialize(v).map_err(|e| e.to_string())?,
                    None => Default::default(),
                };
            }
            "roofs" => {
                self.roofs = match v {
                    Some(v) => <Option<Vec<Roof>>>::deserialize(v).map_err(|e| e.to_string())?,
                    None => Default::default(),
                };
            }
            "openings" => {
                self.openings = match v {
                    Some(v) => <Option<Vec<Opening>>>::deserialize(v).map_err(|e| e.to_string())?,
                    None => Default::default(),
                };
            }
            "stairs" => {
                self.stairs = match v {
                    Some(v) => <Option<Vec<Stair>>>::deserialize(v).map_err(|e| e.to_string())?,
                    None => Default::default(),
                };
            }
            "rooms" => {
                self.rooms = match v {
                    Some(v) => <Option<Vec<Room>>>::deserialize(v).map_err(|e| e.to_string())?,
                    None => Default::default(),
                };
            }
            "drawings2d" => {
                self.drawings2d = match v {
                    Some(v) => <Vec<Drawing2D>>::deserialize(v).map_err(|e| e.to_string())?,
                    None => Default::default(),
                };
            }
            "context" => {
                self.context = match v {
                    Some(v) => <Option<Vec<ContextObject>>>::deserialize(v).map_err(|e| e.to_string())?,
                    None => Default::default(),
                };
            }
            "extrudedSolids" => {
                self.extruded_solids = match v {
                    Some(v) => <Option<Vec<ExtrudedSolid>>>::deserialize(v).map_err(|e| e.to_string())?,
                    None => Default::default(),
                };
            }
            "columns" => {
                self.columns = match v {
                    Some(v) => <Option<Vec<Column>>>::deserialize(v).map_err(|e| e.to_string())?,
                    None => Default::default(),
                };
            }
            "groups" => {
                self.groups = match v {
                    Some(v) => <Option<Vec<Group>>>::deserialize(v).map_err(|e| e.to_string())?,
                    None => Default::default(),
                };
            }
            "parametricWalls" => {
                self.parametric_walls = match v {
                    Some(v) => <Option<Vec<ParametricWall>>>::deserialize(v).map_err(|e| e.to_string())?,
                    None => Default::default(),
                };
            }
            "overrideRules" => {
                self.override_rules = match v {
                    Some(v) => <Option<Vec<OverrideRule>>>::deserialize(v).map_err(|e| e.to_string())?,
                    None => Default::default(),
                };
            }
            "viewSnapshots" => {
                self.view_snapshots = match v {
                    Some(v) => <Option<Vec<ViewSnapshot>>>::deserialize(v).map_err(|e| e.to_string())?,
                    None => Default::default(),
                };
            }
            "viewSnapshotFolders" => {
                self.view_snapshot_folders = match v {
                    Some(v) => <Option<Vec<ViewSnapshotFolder>>>::deserialize(v).map_err(|e| e.to_string())?,
                    None => Default::default(),
                };
            }
            "layouts" => {
                self.layouts = match v {
                    Some(v) => <Option<Vec<Layout>>>::deserialize(v).map_err(|e| e.to_string())?,
                    None => Default::default(),
                };
            }
            "masterLayouts" => {
                self.master_layouts = match v {
                    Some(v) => <Option<Vec<MasterLayout>>>::deserialize(v).map_err(|e| e.to_string())?,
                    None => Default::default(),
                };
            }
            "layoutFolders" => {
                self.layout_folders = match v {
                    Some(v) => <Option<Vec<LayoutFolder>>>::deserialize(v).map_err(|e| e.to_string())?,
                    None => Default::default(),
                };
            }
            "referenceElevationMasl" => {
                self.reference_elevation_masl = match v {
                    Some(v) => <Option<f64>>::deserialize(v).map_err(|e| e.to_string())?,
                    None => Default::default(),
                };
            }
            "geoAnchor" => {
                self.geo_anchor = match v {
                    Some(v) => <Option<ProjectGeoAnchor>>::deserialize(v).map_err(|e| e.to_string())?,
                    None => Default::default(),
                };
            }
            other => match v {
                Some(v) => {
                    self.extra.0.insert(other.to_owned(), v.clone());
                }
                None => {
                    self.extra.0.remove(other);
                }
            },
        }
        Ok(())
    }
}

