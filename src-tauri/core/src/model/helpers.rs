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
                Some(heights::floor_anchor(f.base_elevation.unwrap_or(0.0), offset.unwrap_or(0.0)))
            }
        }
    }

    /// (UK, OK) einer Wand in Metern (`wallVerticalExtent`).
    pub fn wall_vertical_extent(&self, w: &Wall) -> (f64, f64) {
        let floor_base = self.floor(&w.floor_id).map_or(0.0, |f| f.base_elevation.unwrap_or(0.0));
        heights::element(floor_base, self.resolve_anchor(w.bottom.as_ref()), self.resolve_anchor(w.top.as_ref()), w.height)
    }

    /// [234] Sturz einer Öffnung der Wand `w` mit Brüstung `bottom` (absolut) und Sturz `top` (schon an der
    /// Wandoberkante gekappt): zusätzlich an der Unterkante einer Decke gekappt, in die die Öffnung hineinragt
    /// (Decken-UK über der Brüstung und unter dem Sturz, Wand an Anfang, Mitte oder Ende der Öffnung
    /// im Deckenumriss und nicht in einer Aussparung). So enden Leibung, Rahmen, Glas und Wandloch unter der
    /// Decke wie unter der Wandoberkante.
    pub fn opening_top_under_ceilings(&self, w: &Wall, o: &Opening, bottom: f64, top: f64) -> f64 {
        let ceilings = self.ceilings.as_deref().unwrap_or(&[]);
        if ceilings.is_empty() || !(top - bottom > 1e-6) || !o.position.is_finite() || !o.width.is_finite() {
            return top;
        }
        let total = self.wall_thickness(w, 0.2);
        let off = crate::joins::reference_offset(crate::model3d::wall_reference(w), total);
        let arc = crate::wall_arc::WallArc::of_wall(w);
        let (dx, dy) = (w.end.x - w.start.x, w.end.y - w.start.y);
        let len = match &arc {
            Some(a) => a.length(),
            None => dx.hypot(dy),
        };
        if !(len > 1e-9) {
            return top;
        }
        let from = o.position.min(len).max(0.0);
        let to = (o.position + o.width).min(len).max(from);
        let probe = |s: f64, n: f64| -> kernel2d::Vec2 {
            match &arc {
                Some(a) => a.point(s, n),
                None => kernel2d::Vec2::new(w.start.x + (dx * s - dy * n) / len, w.start.y + (dy * s + dx * n) / len),
            }
        };
        // Je Anfang, Mitte, Ende der Öffnung: Wandmitte und knapp innerhalb beider Wandflächen (eine Achse auf dem
        // Deckenrand liegt sonst je nach Rundung drin oder draussen).
        let e = ((to - from) / 2.0).min(0.02);
        let q = (total / 2.0 - (total / 4.0).min(0.01)).max(0.0);
        let probes: Vec<kernel2d::Vec2> = [from + e, (from + to) / 2.0, to - e].into_iter().flat_map(|s| [probe(s, off), probe(s, off - q), probe(s, off + q)]).collect();
        let ring = |r: &[Vec2]| -> Vec<kernel2d::Vec2> { r.iter().map(|q| kernel2d::Vec2::new(q.x, q.y)).collect() };
        let mut cap = top;
        for c in ceilings {
            let (cb, ct) = self.ceiling_vertical_extent(c);
            if !(cb > bottom + 1e-6 && cb < cap - 1e-6 && ct > cb) || c.outline.len() < 3 {
                continue;
            }
            let outline = ring(&c.outline);
            let holes: Vec<Vec<kernel2d::Vec2>> = c.openings.iter().flatten().map(|h| ring(h)).collect();
            let under = probes.iter().any(|&q| kernel2d::point_in_outline(q, &outline) && !holes.iter().any(|h| h.len() >= 3 && kernel2d::point_in_outline(q, h)));
            if under {
                cap = cb;
            }
        }
        cap
    }

    pub fn ceiling_vertical_extent(&self, c: &Ceiling) -> (f64, f64) {
        let floor_top = self.floor(&c.floor_id).map_or(0.0, |f| f.base_elevation.unwrap_or(0.0) + f.floor_height.unwrap_or(0.0));
        heights::ceiling(floor_top, self.resolve_anchor(c.bottom.as_ref()), self.resolve_anchor(c.top.as_ref()), || self.ceiling_thickness(c))
    }

    pub fn stair_vertical_extent(&self, s: &Stair) -> (f64, f64) {
        let (base, floor_height) = self.floor(&s.floor_id).map_or((0.0, 0.0), |f| (f.base_elevation.unwrap_or(0.0), f.floor_height.unwrap_or(0.0)));
        let rise = match s.total_rise {
            Some(r) if r > 0.0 => r,
            _ if floor_height > 0.0 => floor_height,
            _ => 2.6,
        };
        // [187] Antritt über/unter der Geschoss-Basis; der Austritt bleibt bei `base + rise` (Mindeststeigung 5 cm).
        let off = s.base_offset.filter(|o| o.is_finite()).unwrap_or(0.0).min(rise - 0.05);
        (base + off, base + rise)
    }

    pub fn column_vertical_extent(&self, c: &Column) -> (f64, f64) {
        let floor_base = self.floor(&c.floor_id).map_or(0.0, |f| f.base_elevation.unwrap_or(0.0));
        heights::element(floor_base, self.resolve_anchor(c.bottom.as_ref()), self.resolve_anchor(c.top.as_ref()), c.height)
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
    /// Parameter für die Dachgeometrie (`roof::roof_geometry`); [191] Bogenkanten fein geteilt, ihre Teilkanten
    /// erben die Kantenneigung.
    pub fn params(&self) -> RoofParams {
        RoofParams {
            outline: self.ring().iter().map(|v| [v.x, v.y]).collect(),
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
            holes: self.hole_rings().iter().map(|h| h.iter().map(|v| [v.x, v.y]).collect()).collect(),
            edge_pitch_deg: self.dense_edge_pitch(),
        }
    }
}

impl Stair {
    /// [T3] Handlauf-/Pfosten-Profil als `[profil, breite, höhe, pfostenProfil, pfostenBreite, pfostenTiefe]`
    /// (Profil 0 rund, 1 rechteck, 2 flach; fehlend = NaN = Standard), Eingabe von [`crate::stairs3d::RailSpec::decode`].
    pub fn rail_params(&self) -> [f64; 6] {
        let n = |v: Option<f64>| v.unwrap_or(f64::NAN);
        let k = |p: Option<StairRailProfile>| match p {
            Some(StairRailProfile::Rechteck) => 1.0,
            Some(StairRailProfile::Flach) => 2.0,
            _ => 0.0,
        };
        [k(self.rail_profile), n(self.rail_width), n(self.rail_height), k(self.post_profile), n(self.post_width), n(self.post_depth)]
    }

    /// Treppen-Parameter als [`crate::stair::PARAMS`] Zahlen (Aufbau: `stair.rs`, `encodeStair` in TS);
    /// fehlend = NaN.
    pub fn encode(&self) -> [f64; crate::stair::PARAMS] {
        let n = |v: Option<f64>| v.unwrap_or(f64::NAN);
        [
            match self.shape {
                StairShape::Straight | StairShape::Unknown => 0.0,
                StairShape::L => 1.0,
                StairShape::Spiral => 2.0,
                StairShape::U => 3.0,
                StairShape::StraightLanding => 4.0,
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
            n(self.gap),
            n(self.landing_length),
            n(self.run1_steps),
            n(self.mid_steps),
            n(self.run2_offset),
            n(self.mid_offset),
        ]
    }
}

/// Höhenregeln (UK/OK) — eine Fassung für die typisierte Sicht (oben) und die rohe Projekt-Wurzel
/// (`selection_info.rs`: Objekt-Info, 3D-Griffe); die Aufrufer lösen nur ihre Eingaben auf.
pub mod heights {
    /// Bindung „Geschoss“: Basis des Geschosses + Versatz.
    pub fn floor_anchor(base: f64, offset: f64) -> f64 {
        base + offset
    }

    /// Wand/Stütze: UK aus der Bindung `bottom`, sonst Geschoss-Basis; OK aus `top`, sonst UK + Höhe.
    pub fn element(floor_base: f64, bottom: Option<f64>, top: Option<f64>, height: f64) -> (f64, f64) {
        let zb = bottom.unwrap_or(floor_base);
        (zb, top.unwrap_or(zb + height))
    }

    /// Decke: OK aus `top`, sonst Geschoss-Oberkante; UK aus `bottom`, sonst OK − Dicke (die Decke wächst
    /// nach unten; die Dicke wird nur dann bestimmt).
    pub fn ceiling(floor_top: f64, bottom: Option<f64>, top: Option<f64>, thickness: impl FnOnce() -> f64) -> (f64, f64) {
        let zt = top.unwrap_or(floor_top);
        (bottom.unwrap_or_else(|| zt - thickness()), zt)
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn wand_stuetze_und_decke() {
            // Geschoss-Basis + Höhe; Bindungen übersteuern UK/OK unabhängig.
            assert_eq!(element(0.0, None, None, 3.0), (0.0, 3.0));
            assert_eq!(element(0.0, Some(0.5), Some(floor_anchor(3.0, 0.0)), 3.0), (0.5, 3.0));
            assert_eq!(element(2.8, Some(1.0), None, 2.0), (1.0, 3.0));
            // Decke: OK = Geschoss-Oberkante, UK = OK − Dicke; die Dicke nur ohne UK-Bindung.
            assert_eq!(ceiling(2.6, None, None, || 0.25), (2.35, 2.6));
            assert_eq!(ceiling(2.6, Some(2.2), None, || panic!("Dicke nicht gebraucht")), (2.2, 2.6));
            assert_eq!(ceiling(2.6, None, Some(3.0), || 0.2), (2.8, 3.0));
            assert_eq!(floor_anchor(2.8, 0.1), 2.8 + 0.1);
        }
    }
}
