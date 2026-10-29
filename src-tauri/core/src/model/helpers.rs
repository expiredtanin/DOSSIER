//! Abfragen auf dem typisierten Projekt ([K4] S2): Rust-Gegenstück zu den Nachschlage- und
//! Auflösungsfunktionen aus `src/model/types.ts` und `src/model/wall.ts` (`getWallType`,
//! `wallVerticalExtent`, `roofBaseElevation` …). Wo TS wirft und der Aufrufer einen Rückfall
//! einsetzt (try/catch), liefern die Funktionen hier `Option` und der Aufrufer setzt denselben
//! Rückfall ein.

use super::*;
use std::collections::HashMap;
use crate::roof::{MansardType, RoofParams, Shape};
use crate::roof_skeleton::Axis;

/// Rückfall-Bauteil für hängende Verweise (Datei/Import nennt ein Bauteil, das fehlt): neutrales
/// Grau, keine Schraffur, Verschneidungs-Priorität 0.
static FALLBACK_COMPONENT: std::sync::LazyLock<Component> =
    std::sync::LazyLock::new(|| Component { name: "?".into(), color: "#bfbfbf".into(), ..Default::default() });

/// Rückfall-Wandtyp für hängende Verweise: eine Schicht 0.2 m (wie der Dicken-Rückfall in TS) aus
/// dem [`FALLBACK_COMPONENT`].
static FALLBACK_WALL_TYPE: std::sync::LazyLock<WallType> = std::sync::LazyLock::new(|| WallType {
    name: "?".into(),
    layers: vec![Layer { thickness: 0.2, ..Default::default() }],
    ..Default::default()
});

impl Project {
    /// Wandtyp oder — bei hängendem Verweis — der Rückfall-Typ (eine Schicht 0.2 m). Für alle
    /// Ableitungen, die nicht an fehlenden Daten scheitern dürfen (Plan, Schnitt, 3D, Exporte).
    pub fn wall_type_or_fallback(&self, w: &Wall) -> &WallType {
        self.wall_type(w).unwrap_or(&FALLBACK_WALL_TYPE)
    }

    /// Bauteil oder — bei hängendem Verweis — das neutrale Rückfall-Bauteil.
    pub fn component_or_fallback(&self, id: &str) -> &Component {
        self.component(id).unwrap_or(&FALLBACK_COMPONENT)
    }

    /// Schichten des Rückfall-Wandtyps (auch für Decken mit hängendem Typ).
    pub fn fallback_layers() -> &'static [Layer] {
        &FALLBACK_WALL_TYPE.layers
    }

    pub fn floor(&self, id: &str) -> Option<&DrawingLevel> {
        self.drawing_levels.iter().find(|l| l.id == id)
    }

    pub fn wall_type(&self, w: &Wall) -> Option<&WallType> {
        self.wall_types.iter().find(|t| t.id == w.wall_type_id)
    }

    pub fn component(&self, id: &str) -> Option<&Component> {
        self.components.iter().find(|c| c.id == id)
    }

    pub fn hatch(&self, id: &str) -> Option<&HatchStyle> {
        self.hatches.iter().find(|h| h.id == id)
    }

    pub fn line_style(&self, id: &str) -> Option<&LineStyle> {
        self.line_styles.iter().find(|l| l.id == id)
    }

    pub fn door_type(&self, o: &Opening) -> Option<&DoorType> {
        let id = o.type_id.as_deref()?;
        self.door_types.as_deref()?.iter().find(|t| t.id == id)
    }

    pub fn window_type(&self, o: &Opening) -> Option<&WindowType> {
        let id = o.type_id.as_deref()?;
        self.window_types.as_deref()?.iter().find(|t| t.id == id)
    }

    pub fn stair_type(&self, s: &Stair) -> Option<&StairType> {
        let id = s.type_id.as_deref()?;
        self.stair_types.as_deref()?.iter().find(|t| t.id == id)
    }

    pub fn openings_of_wall<'a>(&'a self, wall_id: &'a str) -> impl Iterator<Item = &'a Opening> + 'a {
        self.openings.as_deref().unwrap_or(&[]).iter().filter(move |o| o.host_wall_id == wall_id)
    }

    /// Öffnungen je Wand-id in Projekt-Reihenfolge (wie [`Self::openings_of_wall`], aber einmal für
    /// alle Wände statt je Wand über alle Öffnungen).
    pub fn openings_by_wall(&self) -> HashMap<&str, Vec<&Opening>> {
        let mut m: HashMap<&str, Vec<&Opening>> = HashMap::new();
        for o in self.openings.as_deref().unwrap_or(&[]) {
            m.entry(o.host_wall_id.as_str()).or_default().push(o);
        }
        m
    }

    /// Alle Kategorien flach (Reihenfolge wie `flattenCategories`).
    pub fn flat_categories(&self) -> Vec<&LayerCategory> {
        fn walk<'a>(list: &'a [LayerCategory], out: &mut Vec<&'a LayerCategory>) {
            for c in list {
                out.push(c);
                if let Some(ch) = &c.children {
                    walk(ch, out);
                }
            }
        }
        let mut out = Vec::new();
        walk(&self.layers, &mut out);
        out
    }

    pub fn layer_category(&self, code: &str) -> Option<&LayerCategory> {
        self.flat_categories().into_iter().find(|c| c.code == code)
    }

    /// Dicke eines Wandtyps (Summe der Schichten).
    pub fn type_thickness(layers: &[Layer]) -> f64 {
        layers.iter().map(|l| l.thickness).sum()
    }

    /// Wanddicke; nicht auflösbarer Typ → `fallback` (TS: try/catch mit 0.2).
    pub fn wall_thickness(&self, w: &Wall, fallback: f64) -> f64 {
        self.wall_type(w).map_or(fallback, |t| Self::type_thickness(&t.layers))
    }

    /// Deckendicke: `thickness` > 0, sonst Typ-Dicke, sonst 0.2.
    pub fn ceiling_thickness(&self, c: &Ceiling) -> f64 {
        if let Some(t) = c.thickness.filter(|t| *t > 0.0) {
            return t;
        }
        let layers = c
            .ceiling_type_id
            .as_deref()
            .and_then(|id| self.ceiling_types.as_deref()?.iter().find(|t| t.id == id).map(|t| &t.layers))
            .or_else(|| self.wall_types.iter().find(|t| t.id == c.wall_type_id).map(|t| &t.layers));
        layers.map_or(0.2, |l| Self::type_thickness(l))
    }

    /// Schichten eines Dachs; ohne Typ/Schichten eine Schicht mit der Dachdicke.
    pub fn roof_layers(&self, r: &Roof) -> Vec<Layer> {
        if let Some(id) = r.roof_type_id.as_deref() {
            if let Some(rt) = self.roof_types.as_deref().and_then(|v| v.iter().find(|t| t.id == id)) {
                if !rt.layers.is_empty() {
                    return rt.layers.clone();
                }
            }
        }
        vec![Layer { component_id: String::new(), thickness: r.thickness.max(0.0), ..Default::default() }]
    }

    fn resolve_anchor(&self, a: Option<&VerticalAnchor>) -> Option<f64> {
        match a? {
            VerticalAnchor::Custom { z } => Some(*z),
            VerticalAnchor::Floor { floor_id, offset } => {
                let f = self.floor(floor_id)?;
                Some(f.base_elevation.unwrap_or(0.0) + offset.unwrap_or(0.0))
            }
        }
    }

    /// (UK, OK) einer Wand in Metern (`wallVerticalExtent`).
    pub fn wall_vertical_extent(&self, w: &Wall) -> (f64, f64) {
        let floor_base = self.floor(&w.floor_id).map_or(0.0, |f| f.base_elevation.unwrap_or(0.0));
        let bottom = self.resolve_anchor(w.bottom.as_ref()).unwrap_or(floor_base);
        let top = self.resolve_anchor(w.top.as_ref()).unwrap_or(bottom + w.height);
        (bottom, top)
    }

    pub fn ceiling_vertical_extent(&self, c: &Ceiling) -> (f64, f64) {
        let floor_top = self.floor(&c.floor_id).map_or(0.0, |f| f.base_elevation.unwrap_or(0.0) + f.floor_height.unwrap_or(0.0));
        let top = self.resolve_anchor(c.top.as_ref()).unwrap_or(floor_top);
        let bottom = self.resolve_anchor(c.bottom.as_ref()).unwrap_or(top - self.ceiling_thickness(c));
        (bottom, top)
    }

    pub fn stair_vertical_extent(&self, s: &Stair) -> (f64, f64) {
        let (base, floor_height) = self.floor(&s.floor_id).map_or((0.0, 0.0), |f| (f.base_elevation.unwrap_or(0.0), f.floor_height.unwrap_or(0.0)));
        let rise = match s.total_rise {
            Some(r) if r > 0.0 => r,
            _ if floor_height > 0.0 => floor_height,
            _ => 2.6,
        };
        (base, base + rise)
    }

    pub fn column_vertical_extent(&self, c: &Column) -> (f64, f64) {
        let floor_base = self.floor(&c.floor_id).map_or(0.0, |f| f.base_elevation.unwrap_or(0.0));
        let bottom = self.resolve_anchor(c.bottom.as_ref()).unwrap_or(floor_base);
        let top = self.resolve_anchor(c.top.as_ref()).unwrap_or(bottom + c.height);
        (bottom, top)
    }

    /// Traufhöhe (absolutes Z): `baseElevation`, sonst Oberkante des Geschosses (`roofBaseElevation`).
    pub fn roof_base_elevation(&self, r: &Roof) -> f64 {
        if let Some(b) = r.base_elevation {
            return b;
        }
        self.floor(&r.floor_id).map_or(0.0, |f| f.base_elevation.unwrap_or(0.0) + f.floor_height.unwrap_or(0.0))
    }
}

impl Roof {
    /// Parameter für die Dachgeometrie (`roof::roof_geometry`).
    pub fn params(&self) -> RoofParams {
        RoofParams {
            outline: self.outline.iter().map(|v| [v.x, v.y]).collect(),
            shape: match self.shape {
                RoofShape::Flach | RoofShape::Unknown => Shape::Flach,
                RoofShape::Pult => Shape::Pult,
                RoofShape::Sattel => Shape::Sattel,
                RoofShape::Walm => Shape::Walm,
                RoofShape::Mansarde => Shape::Mansarde,
                RoofShape::Zelt => Shape::Zelt,
            },
            pitch_deg: self.pitch_deg,
            pitch_upper_deg: self.pitch_upper_deg,
            mansard_type: match self.mansard_type {
                Some(RoofMansardType::Walm) => MansardType::Walm,
                Some(RoofMansardType::Zelt) => MansardType::Zelt,
                _ => MansardType::Giebel,
            },
            mansard_knee_ratio: self.mansard_knee_ratio,
            half_hip_ratio: self.half_hip_ratio,
            overhang: self.overhang,
            overhang_gable: self.overhang_gable,
            ridge_axis: if self.ridge_axis == RoofRidgeAxis::Y { Axis::Y } else { Axis::X },
            holes: self.holes.as_deref().unwrap_or(&[]).iter().map(|h| h.iter().map(|v| [v.x, v.y]).collect()).collect(),
            edge_pitch_deg: self.edge_pitch_deg.clone(),
        }
    }
}

impl Stair {
    /// Treppen-Parameter als 16 Zahlen (Aufbau: `stair.rs`, `encodeStair` in TS); fehlend = NaN.
    pub fn encode(&self) -> [f64; 16] {
        let n = |v: Option<f64>| v.unwrap_or(f64::NAN);
        [
            match self.shape {
                StairShape::Straight | StairShape::Unknown => 0.0,
                StairShape::L => 1.0,
                StairShape::Spiral => 2.0,
            },
            self.start.x,
            self.start.y,
            self.dir.x,
            self.dir.y,
            self.run_length,
            n(self.run2_length),
            n(self.turn),
            n(self.center.map(|c| c.x)),
            n(self.center.map(|c| c.y)),
            n(self.radius),
            n(self.sweep),
            self.width,
            self.step_count,
            self.up.map_or(f64::NAN, |u| if u { 1.0 } else { 0.0 }),
            match self.referenz {
                Some(StairReferenz::Links) => 1.0,
                Some(StairReferenz::Rechts) => 2.0,
                _ => 0.0,
            },
        ]
    }
}
