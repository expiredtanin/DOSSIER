//! Ansichtsbereich des Grundrisses ([36], wie Revit/ArchiCAD): Schnitthöhe, Oberkante und Unterkante
//! der Sichtweite und „darunter sichtbar bis“. Ein Bauteil mit Höhenbereich (zb, zt) fällt in genau
//! eine [`Zone`]. Ohne `viewTop`/`viewBottom`/`viewDepth` am Geschoss ist der Bereich unbegrenzt und
//! die Darstellung bleibt wie vor [36] (`custom == false`).

use super::prim::Primitive;
use super::style::no_hatch;
use crate::model::*;

/// Strichmuster „über Schnitt“ (wie die Dach-/Deckenkanten).
pub const ABOVE_DASH: [f64; 2] = super::style::OVERHEAD_DASH;
/// Strichmuster „unter Schnitt“ (gepunktet).
pub const UNDER_DASH: [f64; 2] = [0.04, 0.08];

/// Lage eines Bauteils zum Ansichtsbereich.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Zone {
    /// Durchdringt die Schnittebene.
    Cut,
    /// Ganz unter der Schnittebene, innerhalb der Sichtweite: Aufsicht.
    Below,
    /// Ganz über der Schnittebene, bis zur Oberkante: „über Schnitt“ (gestrichelt).
    Above,
    /// Unter der Unterkante, innerhalb „darunter sichtbar bis“: gepunktet.
    Under,
    /// Ausserhalb des Bereichs: entfällt.
    Hidden,
}

/// Ansichtsbereich in absoluten Höhen (Welt, m).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ViewRange {
    pub cut: f64,
    pub top: Option<f64>,
    pub bottom: Option<f64>,
    pub depth: f64,
    /// Mindestens eine Grenze gesetzt — erst dann ändern `Above`/`Under`/`Hidden` die Darstellung.
    pub custom: bool,
}

impl ViewRange {
    pub fn of(p: &Project, floor: &str) -> ViewRange {
        let l = p.floor(floor);
        let base = l.and_then(|l| l.base_elevation).unwrap_or(0.0);
        let fin = |v: Option<f64>| v.filter(|v| v.is_finite());
        let top = fin(l.and_then(|l| l.view_top)).map(|t| base + t);
        let bottom = fin(l.and_then(|l| l.view_bottom)).map(|b| base + b);
        let depth = fin(l.and_then(|l| l.view_depth)).unwrap_or(0.0).max(0.0);
        ViewRange { cut: base + l.and_then(|l| l.cut_height).unwrap_or(1.0), top, bottom, depth, custom: top.is_some() || bottom.is_some() || depth > 0.0 }
    }

    pub fn classify(&self, zb: f64, zt: f64) -> Zone {
        let (zb, zt) = if zb <= zt { (zb, zt) } else { (zt, zb) };
        if zb <= self.cut && zt >= self.cut {
            return Zone::Cut;
        }
        if zt < self.cut {
            return match self.bottom {
                Some(b) if zt < b => {
                    if self.depth > 0.0 && zt >= b - self.depth {
                        Zone::Under
                    } else {
                        Zone::Hidden
                    }
                }
                _ => Zone::Below,
            };
        }
        match self.top {
            Some(t) if zb > t => Zone::Hidden,
            _ => Zone::Above,
        }
    }

    /// Strichmuster für `Above`/`Under`, nur mit eigenem Bereich; sonst `None` (Darstellung wie bisher).
    pub fn restyle_dash(&self, z: Zone) -> Option<[f64; 2]> {
        match z {
            Zone::Above if self.custom => Some(ABOVE_DASH),
            Zone::Under if self.custom => Some(UNDER_DASH),
            _ => None,
        }
    }
}

/// Primitive ab `from` als „über/unter Schnitt“ umzeichnen: Flächen verlieren Füllung, Schraffur und
/// Strich (bleiben als unsichtbare Pick-Fläche), ihre Kanten werden Linien im Strichmuster `dash`;
/// Linien und Bögen bekommen das Muster.
pub fn restyle(prims: &mut Vec<Primitive>, from: usize, dash: [f64; 2]) {
    let tail: Vec<Primitive> = prims.drain(from..).collect();
    for mut q in tail {
        match &mut q {
            Primitive::Polygon { pts, fill, stroke, stroke_width_mm, hatch, no_stroke_edges, greyed, .. } => {
                let n = pts.len();
                if n >= 2 && stroke.as_str() != "none" && *stroke_width_mm > 0.0 {
                    let skip: std::collections::HashSet<usize> = no_stroke_edges.iter().flatten().map(|k| *k as usize).collect();
                    for i in 0..n {
                        if !skip.contains(&i) {
                            prims.push(Primitive::Line {
                                a: pts[i],
                                b: pts[(i + 1) % n],
                                cls: "view-range".into(),
                                weight_mm: *stroke_width_mm,
                                dash: Some(Some(dash.to_vec())),
                                zigzag: None,
                                motif: None,
                                color: Some(stroke.clone()),
                                drawing_id: None,
                                opening_id: None,
                                stair_id: None,
                                greyed: *greyed,
                                opacity: None,
                            });
                        }
                    }
                }
                *fill = "none".into();
                *stroke = "none".into();
                *stroke_width_mm = 0.0;
                *hatch = no_hatch();
                prims.push(q);
            }
            Primitive::Line { dash: d, .. } | Primitive::Arc { dash: d, .. } => {
                *d = Some(Some(dash.to_vec()));
                prims.push(q);
            }
            _ => prims.push(q),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(top: Option<f64>, bottom: Option<f64>, depth: f64) -> ViewRange {
        ViewRange { cut: 1.0, top, bottom, depth, custom: top.is_some() || bottom.is_some() || depth > 0.0 }
    }

    #[test]
    fn ohne_grenzen_wie_bisher() {
        let v = r(None, None, 0.0);
        assert_eq!(v.classify(0.0, 2.6), Zone::Cut);
        assert_eq!(v.classify(0.0, 0.5), Zone::Below);
        assert_eq!(v.classify(1.4, 2.0), Zone::Above);
        assert_eq!(v.classify(5.0, 6.0), Zone::Above);
        assert_eq!(v.classify(-3.0, -2.0), Zone::Below);
        assert_eq!(v.restyle_dash(Zone::Above), None);
    }

    #[test]
    fn oberkante_blendet_aus() {
        let v = r(Some(2.0), None, 0.0);
        assert_eq!(v.classify(1.4, 2.5), Zone::Above);
        assert_eq!(v.classify(2.1, 2.5), Zone::Hidden);
        assert_eq!(v.restyle_dash(Zone::Above), Some(ABOVE_DASH));
    }

    #[test]
    fn unterkante_und_tiefe() {
        let v = r(None, Some(0.0), 0.0);
        assert_eq!(v.classify(-1.0, -0.2), Zone::Hidden);
        assert_eq!(v.classify(-0.5, 0.5), Zone::Below);
        let v = r(None, Some(0.0), 0.5);
        assert_eq!(v.classify(-0.6, -0.2), Zone::Under);
        assert_eq!(v.classify(-1.0, -0.6), Zone::Hidden);
        assert_eq!(v.restyle_dash(Zone::Under), Some(UNDER_DASH));
    }

    #[test]
    fn schnitt_gewinnt_immer() {
        let v = r(Some(1.2), Some(0.9), 0.3);
        assert_eq!(v.classify(-5.0, 5.0), Zone::Cut);
        assert_eq!(v.classify(1.0, 1.0), Zone::Cut);
    }

    #[test]
    fn aus_dem_geschoss() {
        let mut p = Project::default();
        p.drawing_levels.push(DrawingLevel { id: "og".into(), base_elevation: Some(2.6), cut_height: Some(1.1), view_top: Some(2.0), view_bottom: Some(-0.5), view_depth: Some(0.4), ..Default::default() });
        let v = ViewRange::of(&p, "og");
        assert!((v.cut - 3.7).abs() < 1e-12 && v.top == Some(4.6) && (v.bottom.unwrap() - 2.1).abs() < 1e-12 && v.depth == 0.4 && v.custom);
        assert!(!ViewRange::of(&p, "fehlt").custom);
    }

    #[test]
    fn restyle_macht_linien_und_pick_flaeche() {
        let sq = vec![Vec2 { x: 0.0, y: 0.0 }, Vec2 { x: 1.0, y: 0.0 }, Vec2 { x: 1.0, y: 1.0 }, Vec2 { x: 0.0, y: 1.0 }];
        let mut v = vec![Primitive::Polygon {
            pts: sq,
            fill: "#fff".into(),
            stroke: "#000".into(),
            stroke_width_mm: 0.2,
            hatch: no_hatch(),
            greyed: None,
            opacity: None,
            no_stroke_edges: Some(vec![3.0]),
            wall_id: Some("w".into()),
            drawing_id: None,
            ceiling_id: None,
            opening_id: None,
            stair_id: None,
            room_id: None,
            extruded_solid_id: None,
            context_object_id: None,
            column_id: None,
            roof_id: None,
            section_line_id: None,
        }];
        restyle(&mut v, 0, ABOVE_DASH);
        assert_eq!(v.iter().filter(|q| matches!(q, Primitive::Line { dash: Some(Some(_)), .. })).count(), 3);
        assert!(matches!(v.last(), Some(Primitive::Polygon { stroke, wall_id: Some(_), .. }) if stroke == "none"));
    }
}
