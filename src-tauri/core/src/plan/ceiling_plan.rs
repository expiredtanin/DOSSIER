//! Deckenspiegel ([100]): Untersicht eines Geschosses als eigene Zeichnungsebene (`DrawingLevel.kind`
//! "ceiling", Bezug `ceilingOfId`). Von der Schnitthöhe nach oben gesehen und in Grundriss-Lage
//! gespiegelt (Schweizer Praxis: deckt den Grundriss). Inhalt: Wände und Stützen geschnitten wie im
//! Grundriss (ohne Türflügel/-bögen, Fensterflügel, Brüstungen), die Untersichten der Decken darüber
//! (Ansichtsfarbe und Ansichtsmuster der untersten Schicht, Aussparungen wie Treppenlöcher und
//! Deckenöffnungen ausgezogen, mit Diagonalkreuz nach SIA 400 — Treppen darunter entfallen), Dachuntersichten
//! (Traufe, First, Grate, Dachfenster), je Raum die Kote „UK“ der Decke darüber; ist das Dach die Decke,
//! tiefste und höchste Dach-Unterkante über dem Raum („UK +2.10 … +4.80“, am Raumstempel). Keine Böden, Möbel, Treppen, Raumflächen. Eigene 2D-Elemente der Ebene
//! (Leuchten …) zeichnet `drawings.rs` wie bei jeder Ebene.

use super::domains::{ceiling_layers, columns, line, polygon, pv, roof_windows, Bounds, Ctx, DomainPrims, PlanArgs, Pick};
use super::prim::Primitive;
use super::style::*;
use crate::jsnum::max;
use crate::model::*;

/// Wie weit über der Schnitthöhe des nächsten Geschosses keine Untersicht mehr gesucht wird (oberstes
/// Geschoss: über seiner Geschosshöhe).
const TOP_REACH: f64 = 2.0;
/// Strichstärke des Untersicht-Umrisses (Rand der Decke, Aussparungen).
const SOFFIT_OUTLINE_MM: f64 = 0.18;
/// Strichstärke des Diagonalkreuzes in Aussparungen (fein).
const OPENING_CROSS_MM: f64 = 0.13;
/// Raum-Kote im Deckenspiegel (pt).
const LABEL_PT: f64 = 9.0;

/// Geschoss, dessen Deckenspiegel die Ebene `level_id` ist (`None`: keine Deckenspiegel-Ebene oder
/// Bezug fehlt/ist kein Geschoss).
pub fn source_floor<'a>(p: &'a Project, level_id: &str) -> Option<&'a DrawingLevel> {
    let l = p.floor(level_id).filter(|l| l.kind == DrawingLevelKind::Ceiling)?;
    p.floor(l.ceiling_of_id.as_deref()?).filter(|f| f.kind == DrawingLevelKind::Floor)
}

/// Ist `level_id` eine Deckenspiegel-Ebene (auch mit fehlendem Bezug)?
pub fn is_ceiling_level(p: &Project, level_id: &str) -> bool {
    p.floor(level_id).is_some_and(|l| l.kind == DrawingLevelKind::Ceiling)
}

/// Plan-Argumente für das Bezugsgeschoss (gleiche Sichtbarkeit und Darstellung).
fn floor_args(a: &PlanArgs, floor: &str) -> PlanArgs {
    PlanArgs {
        floor: floor.to_string(),
        detail: a.detail,
        show: a.show.clone(),
        grey: a.grey.clone(),
        reference_lines: a.reference_lines,
        global: false,
        scale: a.scale,
        for_print: a.for_print,
        compact: a.compact,
        mono: a.mono,
        sun_when: None,
        auto_coarse: a.auto_coarse,
        rules: a.rules.clone(),
        // [173] Die Modelldarstellung der Deckenspiegel-Ebene gilt auch für das Bezugsgeschoss.
        model_view: a.model_view.clone(),
        trace_of: None,
    }
}

/// Absolute Höhen (Schnitt, Obergrenze der Untersicht-Suche) des Geschosses.
fn heights(p: &Project, f: &DrawingLevel) -> (f64, f64) {
    let base = f.base_elevation.unwrap_or(0.0);
    let cut = base + f.cut_height.unwrap_or(1.0);
    let next = p
        .drawing_levels
        .iter()
        .filter(|l| l.kind == DrawingLevelKind::Floor && l.base_elevation.unwrap_or(0.0) > base + 1e-6)
        .map(|l| l.base_elevation.unwrap_or(0.0) + l.cut_height.unwrap_or(1.0))
        .fold(f64::INFINITY, f64::min);
    let limit = if next.is_finite() { next } else { base + f.floor_height.unwrap_or(2.6) + TOP_REACH };
    (cut, limit)
}

/// Domänen des Deckenspiegels der Ebene `c.a.floor`; `false`, wenn es keine Deckenspiegel-Ebene ist.
pub fn domains(c: &Ctx, out: &mut DomainPrims, bounds: &mut Bounds) -> Result<bool, String> {
    if !is_ceiling_level(c.p, &c.a.floor) {
        return Ok(false);
    }
    let Some(f) = source_floor(c.p, &c.a.floor) else { return Ok(true) };
    let fa = floor_args(c.a, &f.id);
    let fc = Ctx::new(c.p, &fa);
    let (cut, limit) = heights(c.p, f);
    let soffits = soffits(&fc, cut, limit, &mut out.ceilings, bounds)?;
    let roofs = roof_soffits(&fc, cut, limit, &soffits, &mut out.roofs, bounds);
    let mut walls = Vec::new();
    super::walls::plan_walls(&fc, c.a.reference_lines, &mut walls, bounds)?;
    out.walls = walls.into_iter().filter(|q| !below_ceiling_only(q)).collect();
    columns(&fc, &mut out.columns);
    room_labels(&fc, &soffits, &roofs, &mut out.rooms);
    Ok(true)
}

/// Öffnungs-Teile, die man von unten nicht sieht (Türflügel und -bögen, Fensterflügel, Brüstung,
/// Sonnenschutz) — Rahmen, Glas und Sturz bleiben.
fn below_ceiling_only(q: &Primitive) -> bool {
    match q {
        Primitive::Arc { opening_id, .. } => opening_id.is_some(),
        Primitive::Line { cls, .. } => matches!(cls.as_str(), "door-swing" | "door-leaf" | "window-sash" | "window-sill" | "window-stulp" | "window-shading"),
        _ => false,
    }
}

/// Eine sichtbare Untersicht: Ring mit Brücken (für Punkt-im-Polygon) und UK-Höhe.
struct Soffit {
    ring: Vec<f64>,
    z: f64,
}

/// Decken, deren Unterkante über der Schnitthöhe und unter `limit` liegt: Fläche in der
/// Ansichtsfarbe der untersten Schicht mit deren Ansichtsmuster (sonst Ansichtsschraffur), Rand und
/// Aussparungen ausgezogen (ohne die Stücke unter geschnittenen Wänden).
fn soffits(c: &Ctx, cut: f64, limit: f64, out: &mut Vec<Primitive>, bounds: &mut Bounds) -> Result<Vec<Soffit>, String> {
    let p = c.p;
    let mut list: Vec<(&Ceiling, f64)> = p
        .ceilings
        .as_deref()
        .unwrap_or(&[])
        .iter()
        .filter(|x| c.vis(&x.category_code, &x.id) && x.outline.len() >= 3)
        .map(|x| (x, p.ceiling_vertical_extent(x).0))
        .filter(|(_, zb)| *zb > cut + 1e-6 && *zb < limit)
        .collect();
    // Höhere Decken zuerst, die tiefere (näher am Betrachter) deckt sie.
    list.sort_by(|a, b| b.1.total_cmp(&a.1));
    let fps = super::domains::wall_footprints(c);
    let mut res = Vec::new();
    for (ce, zb) in list {
        let pts: Vec<[f64; 2]> = ce.ring_xy();
        for q in &pts {
            bounds.acc(q[0], q[1]);
        }
        let greyed = Some(c.greyed(&ce.category_code));
        let holes: Vec<Vec<[f64; 2]>> = crate::opening_shape::ceiling_hole_rings(p, ce).iter().filter(|h| h.len() >= 3).map(|h| h.iter().map(|v| [v.x, v.y]).collect()).collect();
        let merged = crate::polygon_holes::merge_holes(&pts, &holes, 1e-4);
        let layers = ceiling_layers(p, ce)?;
        let comp = layers.last().and_then(|l| p.component(&l.component_id));
        let pattern = crate::surface_pattern3d::soffit_segments(p, ce, &holes, c.a.scale);
        // Ohne Ansichtsmuster: Ansichtsschraffur der untersten Schicht (nicht grob).
        let hatch = match (pattern.is_none() && c.a.detail != Detail::Grob, comp.and_then(|k| k.view_hatch_id.as_deref()).filter(|s| !s.is_empty())) {
            (true, Some(id)) => super::domains::resolve_hatch_or_none(p, id, None, comp.and_then(|k| k.foreground.as_deref())),
            _ => no_hatch(),
        };
        let fill = ce.color.as_deref().or(comp.and_then(|k| k.elevation_color.as_deref())).filter(|s| !s.trim().is_empty()).unwrap_or("#ffffff");
        // [33] Schicht-Override der untersten (von unten sichtbaren) Schicht: Füllung, Schraffur, Umriss.
        let lov = super::domains::ceiling_view_override(c, ce, false);
        let (hatch, no_pattern) = super::domains::view_hatch_override(p, lov.as_ref(), hatch);
        let fill = lov.as_ref().and_then(|o| o.fill_color.as_deref()).unwrap_or(fill);
        let outline = lov.as_ref().and_then(|o| o.outline) != Some(false);
        let ring: Vec<Vec2> = merged.ring.iter().map(|q| pv(*q)).collect();
        let bridges = (!merged.bridge_edges.is_empty()).then(|| merged.bridge_edges.iter().map(|&k| k as f64).collect());
        out.push(polygon(ring, fill, "none", 0.0, hatch, greyed, bridges, Pick::Ceiling(&ce.id)));
        if let Some((segs, w, ink)) = pattern.filter(|_| !no_pattern) {
            for (a, b) in segs {
                out.push(line(pv(a), pv(b), "ceiling-soffit-pattern", w, None, &ink, greyed));
            }
        }
        let stroke = ce.color.as_deref().unwrap_or(POCHE_STROKE);
        for [a, b] in crate::plan::wall_poche::ceiling_outline_lines(&merged.ring, &merged.bridge_edges, &fps).into_iter().filter(|_| outline) {
            out.push(line(pv(a), pv(b), "ceiling-soffit-outline", SOFFIT_OUTLINE_MM, None, stroke, greyed));
        }
        // Aussparungen (Treppenloch, Deckenöffnung) mit Diagonalkreuz (SIA 400); die Treppe darunter
        // sieht man im Deckenspiegel nicht.
        for h in &holes {
            for (a, b) in opening_cross(h) {
                out.push(line(pv(a), pv(b), "ceiling-opening-cross", OPENING_CROSS_MM, None, stroke, greyed));
            }
        }
        res.push(Soffit { ring: merged.ring.iter().flat_map(|q| [q[0], q[1]]).collect(), z: zb });
    }
    Ok(res)
}

/// Diagonalkreuz einer Aussparung: bei Vierecken die Eckdiagonalen, sonst die Diagonalen des
/// umschreibenden Rechtecks — jeweils auf die Aussparung geschnitten.
fn opening_cross(h: &[[f64; 2]]) -> Vec<([f64; 2], [f64; 2])> {
    let mut out = Vec::new();
    if h.len() < 3 || h.iter().any(|q| !q[0].is_finite() || !q[1].is_finite()) {
        return out;
    }
    let diagonals = if h.len() == 4 {
        [(h[0], h[2]), (h[1], h[3])]
    } else {
        let (x0, y0, x1, y1) = h.iter().fold((f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY), |(a, b, c, d), q| (a.min(q[0]), b.min(q[1]), c.max(q[0]), d.max(q[1])));
        [([x0, y0], [x1, y1]), ([x0, y1], [x1, y0])]
    };
    for (a, b) in diagonals {
        crate::surface_pattern::clip_to_poly(a, b, h, &mut out);
    }
    out
}

/// Dach-Untersicht für die UK-Kote: Dachflächen (absolute Höhen der Oberkante) und Schichtdicke.
struct RoofUnder {
    planes: Vec<Vec<[f64; 3]>>,
    thickness: f64,
    lines: Vec<[[f64; 2]; 2]>,
}

impl RoofUnder {
    /// Unterkante an (x, y): Oberkante der Fläche, die den Punkt enthält, minus die Dicke lotrecht
    /// gemessen (Schichtdicke senkrecht zur Fläche / cos Neigung). Punkte auf Kanten (First, Grat)
    /// werden leicht versetzt nochmals geprüft.
    fn z_at(&self, x: f64, y: f64) -> Option<f64> {
        const E: f64 = 1e-6;
        [(0.0, 0.0), (E, 0.0), (-E, 0.0), (0.0, E), (0.0, -E)].iter().find_map(|(dx, dy)| self.z_exact(x + dx, y + dy))
    }

    fn z_exact(&self, x: f64, y: f64) -> Option<f64> {
        for pts in &self.planes {
            let ring: Vec<f64> = pts.iter().flat_map(|q| [q[0], q[1]]).collect();
            if pts.len() < 3 || !super::pick::point_in_polygon(x, y, &ring) {
                continue;
            }
            let (mut a, mut b, mut c) = (0.0, 0.0, 0.0);
            for i in 0..pts.len() {
                let (p, q) = (pts[i], pts[(i + 1) % pts.len()]);
                a += (p[1] - q[1]) * (p[2] + q[2]);
                b += (p[2] - q[2]) * (p[0] + q[0]);
                c += (p[0] - q[0]) * (p[1] + q[1]);
            }
            if c.abs() < 1e-9 {
                continue;
            }
            let top = pts[0][2] - (a * (x - pts[0][0]) + b * (y - pts[0][1])) / c;
            let k = crate::jsmath::hypot(&[a, b, c]) / c.abs();
            return Some(top - self.thickness * k);
        }
        None
    }
}

/// Dächer über der Schnitthöhe (eigenes Geschoss oder Traufe unter `limit`) von unten, sofern keine
/// tiefere Deckenuntersicht sie verdeckt (Mitte des Traufumrisses unter einer Decke): Traufe, First,
/// Grate/Kehlen und Knicke ausgezogen, Ansichtsmuster der innersten Schicht, Dachfenster.
fn roof_soffits(c: &Ctx, cut: f64, limit: f64, soffits: &[Soffit], out: &mut Vec<Primitive>, bounds: &mut Bounds) -> Vec<RoofUnder> {
    let p = c.p;
    let mut unders = Vec::new();
    for roof in p.roofs.as_deref().unwrap_or(&[]).iter().filter(|r| c.vis(&r.category_code, &r.id)) {
        let rb = p.roof_base_elevation(roof);
        let geo = crate::roof::roof_geometry(&roof.params(), 0.0);
        let top = rb + max(0.0, geo.ridge_height);
        if top <= cut + 1e-6 || !(roof.floor_id == c.a.floor || rb < limit) || geo.eaves.is_empty() {
            continue;
        }
        let n = geo.eaves.len() as f64;
        let (mx, my) = geo.eaves.iter().fold((0.0, 0.0), |(x, y), q| (x + q[0] / n, y + q[1] / n));
        if soffits.iter().any(|s| s.z < rb && super::pick::point_in_polygon(mx, my, &s.ring)) {
            continue;
        }
        let greyed = Some(c.greyed(&roof.category_code));
        let category = c.cat(&roof.category_code);
        let stroke = roof.color.as_deref().or(category.map(|k| k.color.as_str())).unwrap_or(POCHE_STROKE);
        for q in &geo.eaves {
            bounds.acc(q[0], q[1]);
        }
        if geo.eaves.len() >= 3 {
            let merged = crate::polygon_holes::merge_holes(&geo.eaves, &geo.eaves_holes, 1e-4);
            let bridges = (!merged.bridge_edges.is_empty()).then(|| merged.bridge_edges.iter().map(|&k| k as f64).collect());
            out.push(polygon(merged.ring.iter().map(|q| pv(*q)).collect(), "none", "none", 0.0, no_hatch(), greyed, bridges, Pick::Roof(&roof.id)));
        }
        let layers = p.roof_layers(roof);
        let thickness = layers.iter().map(|l| l.thickness).filter(|t| t.is_finite() && *t > 0.0).sum::<f64>();
        unders.push(RoofUnder {
            planes: geo.planes.iter().map(|pl| pl.iter().map(|q| [q[0], q[1], q[2] + rb]).collect()).collect(),
            thickness,
            lines: geo.ridges.iter().chain(geo.hips.iter()).chain(geo.breaks.iter()).copied().collect(),
        });
        if let Some(comp) = layers.last().filter(|l| !l.component_id.is_empty()).and_then(|l| p.component(&l.component_id)) {
            if let Some((pat, spec)) = comp.surface_pattern.as_ref().and_then(|sp| Some((sp, crate::surface_pattern::spec_of(sp, roof.surface_pattern_angle.unwrap_or(0.0))?))) {
                let w = pat.weight_mm.filter(|w| w.is_finite() && *w > 0.0).unwrap_or(0.1);
                let ink = pat.color.as_deref().or(comp.foreground.as_deref()).filter(|c| !c.trim().is_empty()).unwrap_or("#3a3f47");
                for plane in &geo.planes {
                    for (a, b) in crate::surface_pattern::segments_3d(plane, &spec, [0.0, 0.0], c.a.scale) {
                        out.push(line(pv([a[0], a[1]]), pv([b[0], b[1]]), "roof-soffit-pattern", w, None, ink, greyed));
                    }
                }
            }
        }
        for ring in std::iter::once(&geo.eaves).chain(geo.eaves_holes.iter()) {
            let n = ring.len();
            for i in 0..n {
                out.push(line(pv(ring[i]), pv(ring[(i + 1) % n]), "roof-eaves", ROOF_EAVES_MM, None, stroke, greyed));
            }
        }
        for (ls, cls, w) in [(&geo.ridges, "roof-ridge", ROOF_EAVES_MM), (&geo.hips, "roof-hip", ROOF_BREAK_MM), (&geo.breaks, "roof-break", ROOF_BREAK_MM)] {
            for l in ls.iter() {
                out.push(line(pv(l[0]), pv(l[1]), cls, w, None, stroke, greyed));
            }
        }
        // Dachfenster: von unten sichtbar, also ausgezogen statt „über Schnitt“.
        let start = out.len();
        roof_windows(c, out, roof);
        for q in &mut out[start..] {
            if let Primitive::Line { dash, .. } = q {
                *dash = None;
            }
        }
    }
    unders
}

/// Tiefste und höchste Dach-Unterkante über dem Raum (Umriss `pts`): die Unterkante ist je Fläche
/// eben, also liegen die Extreme an den Raumecken, an Schnittpunkten der Raumkanten mit First/Grat/Knick
/// oder an deren Endpunkten im Raum. Mehrere Dächer: je Punkt das tiefste. `None` ohne Dach darüber.
fn roof_range(pts: &[[f64; 2]], roofs: &[RoofUnder]) -> Option<(f64, f64)> {
    let ring: Vec<f64> = pts.iter().flat_map(|q| [q[0], q[1]]).collect();
    let mut probe: Vec<[f64; 2]> = pts.to_vec();
    let n = pts.len();
    for r in roofs {
        for l in &r.lines {
            for e in l {
                if super::pick::point_in_polygon(e[0], e[1], &ring) {
                    probe.push(*e);
                }
            }
            for i in 0..n {
                if let Some(q) = seg_cross(pts[i], pts[(i + 1) % n], l[0], l[1]) {
                    probe.push(q);
                }
            }
        }
    }
    let mut range: Option<(f64, f64)> = None;
    for q in probe {
        let z = roofs.iter().filter_map(|r| r.z_at(q[0], q[1])).fold(f64::INFINITY, f64::min);
        if z.is_finite() {
            range = Some(range.map_or((z, z), |(a, b)| (a.min(z), b.max(z))));
        }
    }
    range
}

/// Schnittpunkt der Strecken a–b und c–d (ohne parallele).
fn seg_cross(a: [f64; 2], b: [f64; 2], c: [f64; 2], d: [f64; 2]) -> Option<[f64; 2]> {
    let (rx, ry, sx, sy) = (b[0] - a[0], b[1] - a[1], d[0] - c[0], d[1] - c[1]);
    let den = rx * sy - ry * sx;
    if den.abs() < 1e-12 {
        return None;
    }
    let t = ((c[0] - a[0]) * sy - (c[1] - a[1]) * sx) / den;
    let u = ((c[0] - a[0]) * ry - (c[1] - a[1]) * rx) / den;
    ((-1e-9..=1.0 + 1e-9).contains(&t) && (-1e-9..=1.0 + 1e-9).contains(&u)).then(|| [a[0] + rx * t, a[1] + ry * t])
}

/// Je Raum des Geschosses: Name und Kote „UK“ der tiefsten Untersicht über dem Stempelpunkt; liegt
/// dort keine Decke, aber ein Dach (Dach als Decke, oberstes Geschoss), die tiefste und höchste
/// Dach-Unterkante über dem Raum („UK +2.10 … +4.80“, gleich hoch: eine Kote).
fn room_labels(c: &Ctx, soffits: &[Soffit], roofs: &[RoofUnder], out: &mut Vec<Primitive>) {
    if c.a.detail == Detail::Grob {
        return;
    }
    for room in c.p.rooms.as_deref().unwrap_or(&[]).iter().filter(|r| r.floor_id == c.a.floor && c.vis(&r.category_code, &r.id) && r.boundary.len() >= 3) {
        let pts: Vec<[f64; 2]> = room.ring_xy();
        let at = room.stamp_anchor.unwrap_or(pv(crate::room_area::label_point(&pts)));
        let z = soffits.iter().filter(|s| super::pick::point_in_polygon(at.x, at.y, &s.ring)).map(|s| s.z).fold(f64::INFINITY, f64::min);
        let mut lines = Vec::new();
        let kote = super::drawings::kote_label;
        if z.is_finite() {
            lines.push(super::prim::StampLine { text: format!("UK {}", kote(z)), align: Align::Center });
        } else if let Some((lo, hi)) = roof_range(&pts, roofs) {
            let text = if hi - lo < 0.005 { format!("UK {}", kote(lo)) } else { format!("UK {} … {}", kote(lo), kote(hi)) };
            lines.push(super::prim::StampLine { text, align: Align::Center });
        }
        out.push(Primitive::Text { at, doc: super::domains::doc_from_text(&room.name), extra_lines: lines, base_pt: LABEL_PT, color: POCHE_STROKE.into(), room_id: Some(room.id.clone()), greyed: Some(c.greyed(&room.category_code)), opacity: None });
    }
}

#[cfg(test)]
mod tests {
    use super::super::domains::plan_domains;
    use super::*;

    fn sample() -> Project {
        let mut p: Project = serde_json::from_str(include_str!("../../tests/fixtures/sample_project.json")).unwrap();
        p.drawing_levels.push(DrawingLevel { id: "ds-eg".into(), name: "Deckenspiegel EG".into(), kind: DrawingLevelKind::Ceiling, visible: true, ceiling_of_id: Some("eg".into()), ..Default::default() });
        p.drawing_levels.push(DrawingLevel { id: "ds-og".into(), name: "Deckenspiegel OG".into(), kind: DrawingLevelKind::Ceiling, visible: true, ceiling_of_id: Some("og".into()), ..Default::default() });
        p
    }

    fn args(floor: &str) -> PlanArgs {
        let codes: Vec<String> = (0..100).map(|k| format!("{k:02}")).collect();
        PlanArgs::parse(1.0, &serde_json::json!({ "floor": floor, "show": codes, "grey": [] }).to_string()).unwrap()
    }

    fn json(v: &[Primitive]) -> String {
        serde_json::to_string(v).unwrap()
    }

    /// [33] Nicht geschnittene Decken: Schicht-Overrides auf die sichtbare Schicht — im Grundriss die
    /// oberste (Estrich: Lage „darüber“), im Deckenspiegel die unterste (Beton: tragend). Massstab-Kriterium
    /// nach dem Plan-Massstab; ohne Regel unverändert.
    #[test]
    fn decken_ohne_schnitt_mit_schicht_overrides() {
        let mut p = sample();
        let fills = |p: &Project, floor: &str, scale: f64| {
            let mut a = args(floor);
            a.scale = scale;
            let r = plan_domains(p, &a).unwrap();
            let v = serde_json::to_value(&r.ceilings).unwrap();
            let polys: Vec<(String, String)> = v.as_array().unwrap().iter().filter(|q| q["ceilingId"] == "C1" && q["kind"] == "polygon").map(|q| (q["fill"].as_str().unwrap_or("").to_string(), q["hatch"]["pattern"].as_str().unwrap_or("").to_string())).collect();
            let outlines = v.as_array().unwrap().iter().filter(|q| q["cls"] == "ceiling-outline" || q["cls"] == "ceiling-soffit-outline").count();
            (polys, outlines)
        };
        let (plan0, ol0) = fills(&p, "eg", 100.0);
        let (ds0, dol0) = fills(&p, "ds-eg", 100.0);
        assert!(!plan0.is_empty() && !ds0.is_empty(), "{plan0:?} {ds0:?}");
        let rule = |cond: serde_json::Value, min: Option<f64>| -> OverrideRule {
            let mut r: OverrideRule = serde_json::from_value(serde_json::json!({"id": "w", "name": "W", "enabled": true, "condition": cond, "actions": {"fillColor": "#00ff00", "hatch": "none", "outline": false}})).unwrap();
            r.min_scale = min;
            r
        };
        // Lage „darüber“: nur der Grundriss (oberste Schicht Estrich), nicht der Deckenspiegel (Beton).
        p.override_rules = Some(vec![rule(serde_json::json!({"type": "layer_position", "operator": "equals", "value": "above"}), None)]);
        let (plan, ol) = fills(&p, "eg", 100.0);
        assert!(plan.iter().all(|(f, h)| f == "#00ff00" && h == "none"), "{plan:?}");
        assert_eq!(ol, 0, "Umriss aus (Kanten der Decke liegen hier ohnehin unter Wänden)");
        assert_eq!(fills(&p, "ds-eg", 100.0), (ds0.clone(), dol0), "Deckenspiegel: unterste Schicht ist tragend");
        // Tragende Schicht: Deckenspiegel.
        p.override_rules = Some(vec![rule(serde_json::json!({"type": "layer_function", "operator": "equals", "value": "structure"}), None)]);
        assert!(fills(&p, "ds-eg", 100.0).0.iter().all(|(f, _)| f == "#00ff00"));
        assert_eq!(fills(&p, "eg", 100.0), (plan0.clone(), ol0));
        // Massstab: Regel ab 1:200 wirkt im 1:100 nicht.
        p.override_rules = Some(vec![rule(serde_json::json!({"type": "element_kind", "operator": "contains", "value": "slab"}), Some(200.0))]);
        assert_eq!(fills(&p, "eg", 100.0), (plan0, ol0));
        assert!(fills(&p, "eg", 200.0).0.iter().all(|(f, _)| f == "#00ff00"));
    }

    #[test]
    fn deckenspiegel_waende_und_untersicht() {
        let p = sample();
        let r = plan_domains(&p, &args("ds-eg")).unwrap();
        let walls = json(&r.walls);
        assert!(walls.contains("\"wallId\":\"W1\""), "Wände geschnitten wie im Grundriss");
        assert!(!walls.contains("door-swing") && !walls.contains("door-leaf") && !walls.contains("\"kind\":\"arc\""), "keine Türflügel/-bögen");
        let ce = json(&r.ceilings);
        assert!(ce.contains("\"ceilingId\":\"C1\""), "Untersicht der Decke über dem EG: {ce}");
        assert!(!ce.contains("floor-finish-pattern"));
        assert!(r.stairs.is_empty());
        assert!(!json(&r.roofs).contains("roof-eaves"));
        // Ein Dach des EG über der Decke C1 (wie ein Anbau-Dach mit tieferem Geschoss) ist verdeckt.
        let mut q = p.clone();
        q.roofs.as_mut().unwrap()[0].floor_id = "eg".into();
        let rq = plan_domains(&q, &args("ds-eg")).unwrap();
        assert!(!json(&rq.roofs).contains("roof-eaves"), "verdecktes Dach");
        // Räume nur als Beschriftung mit UK-Kote (keine Raumfläche).
        let rooms = serde_json::to_value(&r.rooms).unwrap();
        assert!(rooms.as_array().unwrap().iter().all(|q| q["kind"] == "text"), "{rooms}");
        let uk = 2.6 - p.ceiling_thickness(&p.ceilings.as_ref().unwrap()[0]);
        assert_eq!(rooms[0]["extraLines"][0]["text"], format!("UK +{}", crate::js_fmt::to_fixed(uk, 2)));
        // Der Grundriss bleibt unverändert (eigene Ebene).
        let g = plan_domains(&p, &args("eg")).unwrap();
        assert!(json(&g.rooms).contains("\"kind\":\"polygon\""));
    }

    #[test]
    fn deckenspiegel_muster_und_aussparung() {
        let mut p = sample();
        let concrete = p.components.iter_mut().find(|k| k.id == "concrete").unwrap();
        concrete.surface_pattern = Some(SurfacePattern { kind: SurfacePatternKind::Lines, direction: Some(SurfacePatternDirection::Vertical), spacing: 0.5, ..Default::default() });
        let ce = &mut p.ceilings.as_mut().unwrap()[0];
        let o = ce.outline[0];
        ce.openings = Some(vec![vec![Vec2 { x: o.x + 1.0, y: o.y + 1.0 }, Vec2 { x: o.x + 2.0, y: o.y + 1.0 }, Vec2 { x: o.x + 2.0, y: o.y + 3.0 }, Vec2 { x: o.x + 1.0, y: o.y + 3.0 }]]);
        let r = plan_domains(&p, &args("ds-eg")).unwrap();
        let v = serde_json::to_value(&r.ceilings).unwrap();
        let lines = |cls: &str| v.as_array().unwrap().iter().filter(|q| q["cls"] == cls).cloned().collect::<Vec<_>>();
        assert!(!lines("ceiling-soffit-pattern").is_empty(), "Ansichtsmuster der untersten Schicht");
        let outline = lines("ceiling-soffit-outline");
        // Aussparung (Treppenloch) ausgezogen umrandet: eine Kante bei x = o.x + 1 von y+1 bis y+3.
        assert!(outline.iter().any(|q| (q["a"]["x"].as_f64().unwrap() - (o.x + 1.0)).abs() < 1e-3 && (q["b"]["x"].as_f64().unwrap() - (o.x + 1.0)).abs() < 1e-3 && q.get("dash").is_none_or(|d| d.is_null())), "{outline:?}");
        // Kein Muster in der Aussparung.
        for q in lines("ceiling-soffit-pattern") {
            let mx = (q["a"]["x"].as_f64().unwrap() + q["b"]["x"].as_f64().unwrap()) / 2.0;
            let my = (q["a"]["y"].as_f64().unwrap() + q["b"]["y"].as_f64().unwrap()) / 2.0;
            assert!(!(mx > o.x + 1.0 + 1e-6 && mx < o.x + 2.0 - 1e-6 && my > o.y + 1.0 + 1e-6 && my < o.y + 3.0 - 1e-6), "Muster im Loch: {mx} {my}");
        }
        // Aussparung mit Diagonalkreuz (SIA 400): die beiden Eckdiagonalen, fein, ausgezogen.
        let cross = lines("ceiling-opening-cross");
        assert_eq!(cross.len(), 2, "{cross:?}");
        for q in &cross {
            let (ax, ay, bx, by) = (q["a"]["x"].as_f64().unwrap() - o.x, q["a"]["y"].as_f64().unwrap() - o.y, q["b"]["x"].as_f64().unwrap() - o.x, q["b"]["y"].as_f64().unwrap() - o.y);
            assert!(((ax - bx).abs() - 1.0).abs() < 1e-9 && ((ay - by).abs() - 2.0).abs() < 1e-9, "Diagonale: {q}");
            assert!(q.get("dash").is_none_or(|d| d.is_null()));
        }
    }

    #[test]
    fn deckenspiegel_dachuntersicht_im_obersten_geschoss() {
        let p = sample();
        let r = plan_domains(&p, &args("ds-og")).unwrap();
        let roofs = serde_json::to_value(&r.roofs).unwrap();
        let eaves: Vec<_> = roofs.as_array().unwrap().iter().filter(|q| q["cls"] == "roof-eaves").collect();
        assert!(!eaves.is_empty(), "Dach RF1 als Untersicht");
        assert!(eaves.iter().all(|q| q.get("dash").is_none_or(|d| d.is_null())), "von unten gesehen ausgezogen");
        // Decke unter dem OG (C1) liegt unter dem Schnitt: keine Untersicht.
        assert!(!json(&r.ceilings).contains("\"ceilingId\":\"C1\""));
    }

    #[test]
    fn deckenspiegel_uk_unter_dach_tiefste_und_hoechste() {
        let mut p = sample();
        p.rooms.as_mut().unwrap().push(Room { id: "R-og".into(), name: "Estrich".into(), floor_id: "og".into(), category_code: "60".into(), boundary: vec![Vec2 { x: 0.2, y: 0.2 }, Vec2 { x: 4.8, y: 0.2 }, Vec2 { x: 4.8, y: 2.8 }, Vec2 { x: 0.2, y: 2.8 }], ..Default::default() });
        let r = plan_domains(&p, &args("ds-og")).unwrap();
        let rooms = serde_json::to_value(&r.rooms).unwrap();
        let t = rooms.as_array().unwrap().iter().find(|q| q["roomId"] == "R-og").expect("Raum-Kote")["extraLines"][0]["text"].as_str().unwrap().to_string();
        let parts: Vec<f64> = t.trim_start_matches("UK ").split(" … ").map(|s| s.trim_start_matches('+').parse().unwrap()).collect();
        assert_eq!(parts.len(), 2, "tiefste und höchste: {t}");
        assert!(parts[1] > parts[0] + 0.3, "{t}");
        // Unterkante tiefer als die Oberkante: unter der Traufhöhe des Dachs plus Firsthöhe.
        let roof = &p.roofs.as_ref().unwrap()[0];
        let rb = p.roof_base_elevation(roof);
        let g = crate::roof::roof_geometry(&roof.params(), 0.0);
        assert!(parts[1] < rb + g.ridge_height - 0.05 && parts[0] > rb - 2.0, "{t} rb {rb}");
        // Flachdach gleicher Höhe: eine Kote.
        p.roofs.as_mut().unwrap()[0].shape = RoofShape::Flach;
        let r = plan_domains(&p, &args("ds-og")).unwrap();
        let rooms = serde_json::to_value(&r.rooms).unwrap();
        let t = rooms.as_array().unwrap().iter().find(|q| q["roomId"] == "R-og").unwrap()["extraLines"][0]["text"].as_str().unwrap().to_string();
        assert!(t.starts_with("UK +") && !t.contains('…'), "{t}");
    }

    #[test]
    fn aussparung_kreuz_nicht_viereck() {
        let l = [[0.0, 0.0], [4.0, 0.0], [4.0, 1.0], [1.0, 1.0], [1.0, 3.0], [0.0, 3.0]];
        let segs = opening_cross(&l);
        assert!(!segs.is_empty());
        for (a, b) in segs {
            let m = [(a[0] + b[0]) / 2.0, (a[1] + b[1]) / 2.0];
            assert!(crate::surface_pattern::point_in(m, &l), "Stück innen: {a:?} {b:?}");
        }
        assert!(opening_cross(&[[0.0, 0.0], [f64::NAN, 1.0], [1.0, 1.0]]).is_empty());
    }

    #[test]
    fn deckenspiegel_ohne_bezug_leer() {
        let mut p = sample();
        p.drawing_levels.iter_mut().find(|l| l.id == "ds-eg").unwrap().ceiling_of_id = Some("gibt-es-nicht".into());
        let r = plan_domains(&p, &args("ds-eg")).unwrap();
        assert!(r.walls.is_empty() && r.ceilings.is_empty() && r.rooms.is_empty());
        p.drawing_levels.iter_mut().find(|l| l.id == "ds-eg").unwrap().ceiling_of_id = None;
        assert!(plan_domains(&p, &args("ds-eg")).unwrap().walls.is_empty());
    }
}
