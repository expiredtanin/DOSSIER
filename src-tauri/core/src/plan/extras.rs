//! Grundriss-Zutaten rund um die Domänen ([K3a]/[K4]): Schattenstudie und Baurecht (zuunterst; die
//! Verstösse zuoberst), Abzugskörper (aus Wand-, Stützen- und Decken-Poché), Schwarz-Weiss und
//! Strichstärken nach Massstab sowie das Ausmass des Plans — früher in TS
//! (`generatePlan/{sunShadow,siteRules}.ts`, `voids.ts::subtractVoidsInPlan`, `toMono`,
//! `lineWeightScale.ts`, `computeBounds`). Rechenreihenfolge wie dort.

use super::domains::Bounds;
use super::prim::{HatchRender, Primitive};
use super::style::*;
use crate::jsnum;
use crate::model::*;
use std::collections::HashMap;

/// Füllfarbe der Schattenflächen.
pub const SUN_SHADOW_FILL: &str = "#3a4a66";
const SUN_SHADOW_OPACITY: f64 = 0.28;
/// Linien-Klassen und Füllfarbe des Baurechts.
pub const SITE_PARCEL_CLS: &str = "site-parcel";
pub const SITE_ALLOWED_CLS: &str = "site-allowed";
pub const SITE_VIOLATION_FILL: &str = "#d0342c";
const SITE_VIOLATION_OPACITY: f64 = 0.45;
const PARCEL_COLOR: &str = "#1f6f3f";
const ALLOWED_COLOR: &str = "#2b5fae";
const PARCEL_DASH: [f64; 4] = [6.0, 1.5, 0.5, 1.5];
const ALLOWED_DASH: [f64; 2] = [2.0, 1.0];

/// Geschoss, auf dem Boden-Schatten und Baurecht erscheinen: Basishöhe am nächsten bei 0 (das erste
/// bei Gleichstand).
pub fn ground_floor_id(p: &Project) -> Option<&str> {
    let mut best: Option<(&str, f64)> = None;
    for l in &p.drawing_levels {
        if l.kind != DrawingLevelKind::Floor {
            continue;
        }
        let d = l.base_elevation.unwrap_or(0.0).abs();
        if best.is_none_or(|b| d < b.1) {
            best = Some((&l.id, d));
        }
    }
    best.map(|b| b.0)
}

/// Fläche ohne Strich, mit Deckkraft (Schatten, Baurechts-Verstoss).
fn flat_polygon(pts: Vec<Vec2>, fill: &str, opacity: f64) -> Primitive {
    Primitive::Polygon {
        pts,
        fill: fill.into(),
        stroke: "none".into(),
        stroke_width_mm: 0.0,
        hatch: no_hatch(),
        greyed: None,
        opacity: Some(opacity),
        no_stroke_edges: None,
        wall_id: None,
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
    }
}

fn ring_pts(r: &[[f64; 2]]) -> Vec<Vec2> {
    r.iter().map(|q| Vec2 { x: q[0], y: q[1] }).collect()
}

/// Breite/Länge des Projekts aus `geoAnchor` (LV95), sonst Zürich.
fn project_lat_lon(p: &Project) -> (f64, f64) {
    match &p.geo_anchor {
        Some(a) => crate::geo_rebase::lv95_to_wgs84(a.lv95.e, a.lv95.n),
        None => (47.3769, 8.5417),
    }
}

/// Boden-Schatten zum Zeitpunkt `when_ms` (Unix-ms der Studie, `None`/NaN = ungültig) als
/// halbtransparente Flächen; nur mit sichtbarer Studie und im Geschoss nächst ±0.00.
pub fn sun_shadow(p: &Project, floor: &str, when_ms: Option<f64>, out: &mut Vec<Primitive>) {
    let Some(study) = &p.sun_study else { return };
    if !study.show || ground_floor_id(p) != Some(floor) {
        return;
    }
    let Some(t) = when_ms.filter(|t| !t.is_nan()) else { return };
    let (lat, lon) = project_lat_lon(p);
    let sun = crate::sun::sun_position(lat, lon, t);
    for poly in crate::sun::shadow_polygons_project(p, sun) {
        for r in crate::sun::without_holes(&poly) {
            out.push(flat_polygon(ring_pts(&r), SUN_SHADOW_FILL, SUN_SHADOW_OPACITY));
        }
    }
}

/// Baurecht im Geschoss nächst ±0.00 (ohne `show: false`): Prüfung des Modells, `None` ohne
/// gültiges Baurecht.
fn site_check(p: &Project, floor: &str) -> Option<crate::site_rules::SiteCheckOut> {
    let rules = p.site_rules.as_ref()?;
    if rules.show == Some(false) || ground_floor_id(p) != Some(floor) {
        return None;
    }
    crate::site_rules::check_project(p)
}

/// Linien eines geschlossenen Rings (ein Strichmuster je Ring: Linienzug über die Ecken).
fn ring_lines(out: &mut Vec<(Primitive, u32)>, pts: &[Vec2], cls: &str, color: &str, w: f64, dash: &[f64], dash_ref: u32) {
    let n = pts.len();
    for i in 0..n {
        let line = Primitive::Line {
            a: pts[i],
            b: pts[(i + 1) % n],
            cls: cls.into(),
            weight_mm: w,
            dash: Some(Some(dash.to_vec())),
            zigzag: None,
            motif: None,
            color: Some(color.into()),
            drawing_id: None,
            opening_id: None,
            stair_id: None,
            greyed: None,
            opacity: None,
        };
        out.push((line, dash_ref));
    }
}

/// Unterste Gruppe: Schatten, dann Parzellengrenze (Strich-Punkt) und zulässige Fläche
/// (gestrichelt); mit Strichmuster-Kennung je Primitiv. Dazu die Verstösse (Gebäude-Grundfläche
/// ausserhalb der zulässigen Fläche) für die oberste Gruppe.
pub fn site_and_shadow(p: &Project, floor: &str, when_ms: Option<f64>) -> (Vec<(Primitive, u32)>, Vec<Primitive>) {
    let mut shadow = Vec::new();
    sun_shadow(p, floor, when_ms, &mut shadow);
    let mut under: Vec<(Primitive, u32)> = shadow.into_iter().map(|q| (q, 0)).collect();
    let mut violations = Vec::new();
    if let (Some(check), Some(rules)) = (site_check(p, floor), p.site_rules.as_ref()) {
        let mut r = 1;
        ring_lines(&mut under, &rules.parcel, SITE_PARCEL_CLS, PARCEL_COLOR, 0.35, &PARCEL_DASH, r);
        for poly in &check.allowed {
            for ring in poly {
                r += 1;
                ring_lines(&mut under, ring, SITE_ALLOWED_CLS, ALLOWED_COLOR, 0.25, &ALLOWED_DASH, r);
            }
        }
        for poly in &check.violations {
            let rings: Vec<Vec<[f64; 2]>> = poly.iter().map(|r| r.iter().map(|q| [q.x, q.y]).collect()).collect();
            for ring in crate::sun::without_holes(&rings) {
                violations.push(flat_polygon(ring_pts(&ring), SITE_VIOLATION_FILL, SITE_VIOLATION_OPACITY));
            }
        }
    }
    (under, violations)
}

// ── Abzugskörper ────────────────────────────────────────────────────────────────────────────────

const EPS: f64 = 1e-7;

/// Ein Abzugskörper als Prisma (Welt-Höhen).
pub(crate) struct VoidPrism {
    pub(crate) pts: Vec<Vec2>,
    pub(crate) z0: f64,
    pub(crate) z1: f64,
}

/// Abzugskörper des Projekts (`voidPrisms`): `operation: "subtract"`, ohne B-Rep, ohne Verjüngung,
/// gültiges Profil und Höhe.
pub(crate) fn void_prisms(p: &Project) -> Vec<VoidPrism> {
    let mut out = Vec::new();
    for s in p.extruded_solids.as_deref().unwrap_or(&[]) {
        let is_void = s.operation.as_deref() == Some("subtract") && s.brep.is_none() && s.taper.unwrap_or(0.0) < 1e-6 && s.points.len() >= 3 && s.height > 0.0;
        if !is_void {
            continue;
        }
        let z0 = p.floor(&s.level_id).map_or(0.0, |f| f.base_elevation.unwrap_or(0.0)) + s.base_offset.unwrap_or(0.0);
        out.push(VoidPrism { pts: s.points.clone(), z0, z1: z0 + s.height });
    }
    out
}

/// Ringe flach wie `encodeRings` in TS: `[n, (k, x, y …) × n]`.
fn encode_rings(rings: &[&[Vec2]]) -> Vec<f64> {
    let mut b = vec![rings.len() as f64];
    for r in rings {
        b.push(r.len() as f64);
        for q in r.iter() {
            b.push(q.x);
            b.push(q.y);
        }
    }
    b
}

/// Linien-Klassen der Wand-Poché, die ein Abzugskörper auf Schnitthöhe unterbricht.
const WALL_LINE_CLS: [&str; 3] = ["wall-outline", "layer-joint", "layer-joint-l"];

/// Zieht die Abzugskörper von den Bauteil-Primitiven eines Grundrisses ab (`subtractVoidsInPlan`):
/// Wände (Poché und ihre Linien), wenn der Körper die Schnitthöhe `cut_z` durchdringt; Stützen
/// ebenso über ihren Höhenbereich; Decken, wenn der Körper die Platte durchdringt. Ohne
/// Abzugskörper unverändert. Gleiche Rechnung wie der frühere Weg über die flachen Bindungen.
pub fn subtract_voids(prims: Vec<Primitive>, p: &Project, cut_z: f64) -> Vec<Primitive> {
    let voids = void_prisms(p);
    if voids.is_empty() {
        return prims;
    }
    // Maps wie in TS: bei doppelter id gewinnt der letzte Eintrag.
    let ceilings: HashMap<&str, &Ceiling> = p.ceilings.as_deref().unwrap_or(&[]).iter().map(|c| (c.id.as_str(), c)).collect();
    let columns: HashMap<&str, &Column> = p.columns.as_deref().unwrap_or(&[]).iter().map(|c| (c.id.as_str(), c)).collect();
    let cutters_for = |z0: f64, z1: f64| -> Vec<&[Vec2]> { voids.iter().filter(|v| v.z0 < z1 - EPS && v.z1 > z0 + EPS).map(|v| v.pts.as_slice()).collect() };
    let wall_cutters = cutters_for(cut_z - 1e-4, cut_z + 1e-4);
    let wall_flat = encode_rings(&wall_cutters);
    let mut out = Vec::with_capacity(prims.len());
    for pr in prims {
        if let Primitive::Line { a, b, cls, .. } = &pr {
            if WALL_LINE_CLS.contains(&cls.as_str()) && !wall_cutters.is_empty() {
                let f = crate::voids::segment_outside_flat(&[a.x, a.y, b.x, b.y], &wall_flat);
                let n = f.first().copied().unwrap_or(0.0) as usize;
                let parts: Vec<(f64, f64)> = (0..n).map(|k| (f[1 + 2 * k], f[2 + 2 * k])).collect();
                if parts.len() == 1 && parts[0].0 == 0.0 && parts[0].1 == 1.0 {
                    out.push(pr);
                } else {
                    let (a, b) = (*a, *b);
                    let at = |t: f64| Vec2 { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
                    for (t0, t1) in parts {
                        let mut q = pr.clone();
                        if let Primitive::Line { a: qa, b: qb, .. } = &mut q {
                            *qa = at(t0);
                            *qb = at(t1);
                        }
                        out.push(q);
                    }
                }
                continue;
            }
        }
        let Primitive::Polygon { pts, no_stroke_edges, wall_id, ceiling_id, column_id, extruded_solid_id, .. } = &pr else {
            out.push(pr);
            continue;
        };
        // Ids zählen wie in JS nur, wenn nicht leer.
        let id = |s: &Option<String>| s.as_deref().filter(|s| !s.is_empty()).map(str::to_owned);
        let (wall_id, ceiling_id, column_id) = (id(wall_id), id(ceiling_id), id(column_id));
        if id(extruded_solid_id).is_some() {
            out.push(pr);
            continue;
        }
        let cutters: Option<Vec<&[Vec2]>> = if wall_id.is_some() {
            Some(wall_cutters.clone())
        } else if let Some(id) = &ceiling_id {
            ceilings.get(id.as_str()).map(|c| {
                let (zb, zt) = p.ceiling_vertical_extent(c);
                cutters_for(zb, zt)
            })
        } else if let Some(id) = &column_id {
            columns.get(id.as_str()).map(|c| {
                let (zb, zt) = p.column_vertical_extent(c);
                if zb <= cut_z && zt >= cut_z {
                    wall_cutters.clone()
                } else {
                    cutters_for(zb, zt)
                }
            })
        } else {
            None
        };
        let Some(cutters) = cutters.filter(|c| !c.is_empty()) else {
            out.push(pr);
            continue;
        };
        if pts.len() < 3 {
            out.push(pr);
            continue;
        }
        let ring = encode_rings(&[pts]);
        let ns = no_stroke_edges.as_deref().unwrap_or(&[]);
        let mut nsf = vec![ns.len() as f64];
        nsf.extend_from_slice(ns);
        let f = crate::voids::subtract_rings_flat(&ring[1..], &encode_rings(&cutters), &nsf);
        if f.is_empty() || f[0] < 0.0 {
            out.push(pr);
            continue;
        }
        let mut i = 1;
        for _ in 0..f[0] as usize {
            let n = f[i] as usize;
            i += 1;
            let rp: Vec<Vec2> = (0..n).map(|j| Vec2 { x: f[i + 2 * j], y: f[i + 2 * j + 1] }).collect();
            i += 2 * n;
            let m = f[i] as usize;
            i += 1;
            let rn: Vec<f64> = f[i..i + m].to_vec();
            i += m;
            let mut q = pr.clone();
            if let Primitive::Polygon { pts, no_stroke_edges, .. } = &mut q {
                *pts = rp;
                *no_stroke_edges = (!rn.is_empty()).then_some(rn);
            }
            out.push(q);
        }
    }
    out
}

/// Schnitthöhe des Geschosses (Welt): Basis + Schnitthöhe (Standard 1 m).
pub fn cut_z(p: &Project, floor: &str) -> f64 {
    let l = p.floor(floor);
    l.and_then(|l| l.base_elevation).unwrap_or(0.0) + l.and_then(|l| l.cut_height).unwrap_or(1.0)
}

// ── Schwarz-Weiss und Strichstärken ─────────────────────────────────────────────────────────────

const REFERENCE_SCALE: f64 = 100.0;
const MIN_FACTOR: f64 = 0.5;
const MAX_FACTOR: f64 = 1.6;

/// Strichstärken-Faktor für 1:`scale` ([32], nur mit `Project.scaleLineWeights`): (100/n)^0.25,
/// begrenzt auf 0,5–1,6; sonst 1.
pub fn line_weight_factor(p: &Project, scale: f64) -> f64 {
    if p.scale_line_weights != Some(true) || !(scale > 0.0) || !scale.is_finite() {
        return 1.0;
    }
    let f = jsnum::pow(REFERENCE_SCALE / scale, 0.25);
    jsnum::min(MAX_FACTOR, jsnum::max(MIN_FACTOR, f))
}

/// Nachbearbeitung beim Schreiben (`plan_buf::Writer::post`): Schwarz-Weiss (alle Farben auf Tinte
/// bzw. Papier; eine Vollpoché bleibt schwarz) und Strichstärken-Faktor — in dieser Reihenfolge wie
/// früher `toMono` und `scalePrimitiveWeights`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Post {
    pub mono: bool,
    pub lw: f64,
}

impl Post {
    /// Wirkt sie auf etwas?
    pub fn active(&self) -> bool {
        self.mono || self.lw != 1.0
    }

    fn hatch(&self, h: &mut HatchRender) {
        if self.mono && h.pattern != HatchPattern::None {
            h.color = (if h.pattern == HatchPattern::Solid { HATCH_INK } else { MONO_INK }).into();
        }
        if self.lw != 1.0 {
            h.line_weight *= self.lw;
        }
    }

    /// Ein Primitiv (ohne Linien, die nimmt [`Post::line`]).
    pub fn apply(&self, p: &mut Primitive) {
        match p {
            Primitive::Polygon { fill, stroke, stroke_width_mm, hatch, .. } => {
                if self.mono {
                    let solid = hatch.pattern == HatchPattern::Solid;
                    if *fill != "none" {
                        *fill = (if solid { HATCH_INK } else { "#ffffff" }).into();
                    }
                    *stroke = MONO_INK.into();
                }
                self.hatch(hatch);
                if self.lw != 1.0 {
                    *stroke_width_mm *= self.lw;
                }
            }
            Primitive::Text { color, .. } => {
                if self.mono {
                    *color = MONO_INK.into();
                }
            }
            Primitive::Line { weight_mm, color, .. } => {
                if self.mono {
                    *color = Some(MONO_INK.into());
                }
                if self.lw != 1.0 {
                    *weight_mm *= self.lw;
                }
            }
            Primitive::Arc { weight_mm, .. } | Primitive::DrawingCircle { weight_mm, .. } | Primitive::DrawingArc { weight_mm, .. } => {
                if self.lw != 1.0 {
                    *weight_mm *= self.lw;
                }
            }
            Primitive::DrawingText { .. } | Primitive::DrawingTextPath { .. } | Primitive::DrawingImage { .. } => {}
        }
    }

    /// Farbe und Stärke einer Linie.
    pub fn line<'a>(&self, color: Option<&'a str>, w: f64) -> (Option<&'a str>, f64) {
        (if self.mono { Some(MONO_INK) } else { color }, if self.lw != 1.0 { w * self.lw } else { w })
    }
}

/// Nachbearbeitung eines Plans: Schwarz-Weiss und Strichstärken-Faktor; `None`, wenn sie nichts tut.
pub fn post_for(p: &Project, a: &super::domains::PlanArgs) -> Option<Post> {
    Some(Post { mono: a.mono, lw: line_weight_factor(p, a.scale) }).filter(Post::active)
}

// ── Ausmass ─────────────────────────────────────────────────────────────────────────────────────

/// Ausmass der Zutaten, die „Einpassen" und Druck ganz zeigen sollen: Schatten und Baurechts-Linien
/// (`extra`) und die ganze Kontext-Schicht (Konturen, Netze, Luftbilder) — Rohwerte für
/// [`plan_bounds`].
pub fn extra_bounds(p: &Project, extra: &[(Primitive, u32)]) -> Bounds {
    let mut b = Bounds::new();
    for (e, _) in extra {
        match e {
            Primitive::Polygon { pts, .. } => {
                for q in pts {
                    b.acc(q.x, q.y);
                }
            }
            Primitive::Line { a, b: e, .. } => {
                b.acc(a.x, a.y);
                b.acc(e.x, e.y);
            }
            _ => {}
        }
    }
    for obj in p.context.as_deref().unwrap_or(&[]) {
        match obj {
            ContextObject::ContourSet(cs) => {
                for c in &cs.contours {
                    for q in &c.pts {
                        b.acc(q.x, q.y);
                    }
                }
            }
            ContextObject::Image(im) => {
                b.acc(im.min.x, im.min.y);
                b.acc(im.max.x, im.max.y);
            }
            ContextObject::ImportedMesh(m) => mesh_bounds(&m.positions, &mut b),
            ContextObject::TerrainMesh(m) => mesh_bounds(&m.positions, &mut b),
        }
    }
    b
}

fn mesh_bounds(pos: &[f64], b: &mut Bounds) {
    let mut i = 0;
    while i + 1 < pos.len() {
        b.acc(pos[i], pos[i + 1]);
        i += 3;
    }
}

/// Ausmass des Plans (`computeBounds`): Ausmass der Domänen (falls vorhanden, als zwei Ecken), dann
/// die Zutaten; ohne Punkte `[0, 0, 1, 1]`.
pub fn plan_bounds(domains: &Bounds, extra: &Bounds) -> [f64; 4] {
    let mut b = Bounds::new();
    if let Some(d) = domains.get() {
        b.acc(d[0], d[1]);
        b.acc(d[2], d[3]);
    }
    b.merge(extra.raw());
    b.get().unwrap_or([0.0, 0.0, 1.0, 1.0])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Project {
        serde_json::from_str(include_str!("../../tests/fixtures/sample_project.json")).unwrap()
    }

    #[test]
    fn strichstaerken_faktor() {
        let mut on = sample();
        on.scale_line_weights = Some(true);
        assert_eq!(line_weight_factor(&on, 100.0), 1.0);
        assert!((line_weight_factor(&on, 200.0) - 0.5f64.powf(0.25)).abs() < 1e-12);
        assert!((line_weight_factor(&on, 50.0) - 2f64.powf(0.25)).abs() < 1e-12);
        assert_eq!(line_weight_factor(&on, 100000.0), 0.5);
        assert_eq!(line_weight_factor(&sample(), 200.0), 1.0);
        assert_eq!(line_weight_factor(&on, f64::NAN), 1.0);
    }

    #[test]
    fn abzugskoerper_spart_wand_aus() {
        let mut v: serde_json::Value = serde_json::from_str(include_str!("../../tests/fixtures/sample_project.json")).unwrap();
        let walls = |v: &serde_json::Value| {
            let p: Project = serde_json::from_value(v.clone()).unwrap();
            let codes: Vec<String> = p.flat_categories().iter().map(|c| c.code.clone()).collect();
            let a = super::super::domains::PlanArgs::parse(1.0, &serde_json::json!({"floor": "eg", "show": codes}).to_string()).unwrap();
            let (prims, _, _) = crate::plan_buf::decode(&super::super::domains::plan_domains_buf(&p, &a).unwrap()).unwrap();
            prims.into_iter().filter(|q| matches!(q, Primitive::Polygon { wall_id: Some(_), .. })).collect::<Vec<_>>()
        };
        let before = walls(&v);
        v["extrudedSolids"] = serde_json::json!([{"id": "void1", "type": "extrudedSolid", "levelId": "eg", "operation": "subtract", "height": 3,
            "points": [{"x": 1.95, "y": -0.5}, {"x": 2.15, "y": -0.5}, {"x": 2.15, "y": 0.5}, {"x": 1.95, "y": 0.5}]}]);
        let after = walls(&v);
        assert_ne!(before, after);
        assert!(after.len() > before.len(), "{} → {}", before.len(), after.len());
    }

    #[test]
    fn erdgeschoss_naechst_null() {
        let p = sample();
        assert_eq!(ground_floor_id(&p), Some("eg"));
    }

    #[test]
    fn mono_poche_bleibt_schwarz() {
        let post = Post { mono: true, lw: 1.0 };
        let mut solid = HatchRender { pattern: HatchPattern::Solid, ..no_hatch() };
        solid.color = "#123456".into();
        let mut p = flat_polygon(vec![], "#abcdef", 1.0);
        if let Primitive::Polygon { hatch, stroke, .. } = &mut p {
            *hatch = solid;
            *stroke = "#ff0000".into();
        }
        post.apply(&mut p);
        match &p {
            Primitive::Polygon { fill, stroke, hatch, .. } => {
                assert_eq!(fill, HATCH_INK);
                assert_eq!(stroke, MONO_INK);
                assert_eq!(hatch.color, HATCH_INK);
            }
            _ => unreachable!(),
        }
        assert_eq!(post.line(None, 0.25), (Some(MONO_INK), 0.25));
    }
}
