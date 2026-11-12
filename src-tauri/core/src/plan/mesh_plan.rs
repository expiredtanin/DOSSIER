//! [152] Importierte Netze (`ImportedMesh`) im Grundriss eines Geschosses, nach dem Ansichtsbereich ([36]):
//!
//! - **Schnitt** (Netz durchdringt die Schnitthöhe): waagrechter Ebenenschnitt als Schnittfläche (Füllung/
//!   Schraffur wie geschnittene Körper, ab 1:100 schwarz, `style::solid_cut`), offene Züge als Schnittlinien;
//!   der Teil darunter als Aufsicht.
//! - **Darunter** (im Geschoss, unter der Schnitthöhe): Aufsicht — sichtbare Kanten von oben (exakte
//!   Sichtbarkeit `hlr`, Facetten innerhalb des Knickwinkels geglättet), verdeckt durch Netze und Schnittflächen
//!   darüber; unter der Unterkante (`viewBottom`, „darunter sichtbar bis") gepunktet.
//! - **Darüber** (über der Schnitthöhe, unter der Geschoss-Oberkante bzw. `viewTop`): Überkopf-Linien
//!   (gestrichelt wie Dachüberstände/Decken darüber), Kanten von unten gesehen — z. B. Pfetten, Träger.
//!
//! Netze anderer Geschosse (ganz darunter/darüber) entfallen. Ohne Geschoss (freie Zeichnungsebene) bleibt
//! der frühere Sockel-Fussabdruck (`context.rs`).

use super::domains::Ctx;
use super::prim::Primitive;
use super::style::*;
use super::view_range::{ViewRange, Zone, ABOVE_DASH, UNDER_DASH};
use crate::mesh_view::{self, MeshRef};
use crate::model::*;

/// Tinte und Stärke der Aufsichts- und Überkopf-Linien.
const MESH_INK: &str = "#3a3f47";
const MESH_VIEW_MM: f64 = 0.13;
/// Toleranz (m) der Geschossgrenzen.
const LEVEL_TOL: f64 = 0.05;

/// Höhenband eines Geschosses: (Boden, Oberkante); Oberkante aus `viewTop`, sonst Geschosshöhe, sonst der
/// nächste Boden darüber, sonst offen.
fn floor_band(p: &Project, l: &DrawingLevel, range: &ViewRange) -> (f64, f64) {
    let base = l.base_elevation.unwrap_or(0.0);
    let next = p.drawing_levels.iter().filter(|o| o.kind == DrawingLevelKind::Floor).filter_map(|o| o.base_elevation).filter(|b| *b > base + 1e-6).fold(f64::INFINITY, f64::min);
    let top = range.top.or_else(|| l.floor_height.filter(|h| *h > 0.0).map(|h| base + h)).unwrap_or(next);
    (base, top)
}

/// Lage eines Netzes zum Grundriss: `None` = nicht in diesem Geschoss.
fn zone_of(range: &ViewRange, (base, top): (f64, f64), zb: f64, zt: f64) -> Option<Zone> {
    let z = range.classify(zb, zt);
    match z {
        Zone::Hidden => None,
        // Darunter: ragt über den Boden oder liegt darauf (Teppich); was am Boden endet (Stütze des Geschosses
        // darunter, Gelände unter dem Haus), gehört nicht dazu.
        Zone::Below if range.bottom.is_none() && zt <= base + LEVEL_TOL && zb < base - LEVEL_TOL => None,
        // Darüber: beginnt unter der Oberkante (was dort beginnt, gehört zum Geschoss darüber).
        Zone::Above if range.top.is_none() && zb >= top - LEVEL_TOL => None,
        _ => Some(z),
    }
}

/// [33] Regeln eines Netzes im Grundriss (Bauteilart „mesh", Ebene, Name): Fläche und Linien.
struct MeshOv {
    fill: Option<String>,
    hatch: Option<Option<super::prim::HatchRender>>,
    color: Option<String>,
    weight: Option<f64>,
    dash: Option<Option<Vec<f64>>>,
}

fn mesh_ov(c: &Ctx, m: &ImportedMesh) -> Option<MeshOv> {
    let v = c.rule_view();
    if !super::overrides::has_active(c.p, v) {
        return None;
    }
    let code = Some(m.category_code.as_str());
    let s = super::overrides::Subject { layer_name: code.and_then(|k| c.p.layer_category(k)).map(|k| k.name.as_str()), layer_code: code, object_name: Some(&m.name), element_kind: Some(super::section::MESH_KIND), ..Default::default() };
    let (el, ly, _) = super::overrides::effective_surface(c.p.override_rules.as_deref(), &s, v);
    let hatch = match ly.hatch.as_deref() {
        None | Some("material") => None,
        Some("none") => Some(None),
        Some(id) => Some(resolve_hatch(c.p, id, None, None, None)),
    };
    let o = MeshOv { fill: ly.fill_color, hatch, color: el.color, weight: el.lineweight.filter(|w| w.is_finite() && *w >= 0.0), dash: super::overrides::linetype_dash(c.p, el.linetype_id.as_deref()) };
    (o.fill.is_some() || o.hatch.is_some() || o.color.is_some() || o.weight.is_some() || o.dash.is_some()).then_some(o)
}

fn view_line(a: [f64; 2], b: [f64; 2], dash: Option<&[f64]>, greyed: bool, ov: Option<&MeshOv>) -> Primitive {
    let mut d = dash.map(|d| Some(d.to_vec()));
    let (mut color, mut w) = (MESH_INK.to_string(), MESH_VIEW_MM);
    if let Some(o) = ov {
        color = o.color.clone().unwrap_or(color);
        w = o.weight.unwrap_or(w);
        d = o.dash.clone().or(d);
    }
    Primitive::Line { a: Vec2 { x: a[0], y: a[1] }, b: Vec2 { x: b[0], y: b[1] }, cls: "mesh-view".into(), weight_mm: w, dash: d, zigzag: None, motif: None, color: Some(color.into()), drawing_id: None, opening_id: None, stair_id: None, greyed: Some(greyed), opacity: None }
}

/// Verdecker-Fläche (nur Verdecker, beidseitig) in Ansichtstiefe `depth` (Schnitthöhe − z).
fn occluder(ring: &[[f64; 2]], depth: f64) -> Option<crate::hlr::Face> {
    if ring.len() < 3 || !depth.is_finite() || ring.iter().any(|q| !q[0].is_finite() || !q[1].is_finite()) {
        return None;
    }
    let mut f = crate::hlr::Face::new(ring.iter().map(|q| [q[0], q[1], depth.max(0.0)]).collect(), [0.0, 0.0, -1.0], u32::MAX);
    f.edges = false;
    f.two_sided = true;
    Some(f)
}

/// [152] Wände, Stützen und Decken des Grundrisses als Verdecker der Netz-Aufsicht: geschnitten in Tiefe 0
/// (die Netz-Linien laufen nicht durch die Poché), ganz unter der Schnitthöhe in Höhe der Oberkante (eine
/// Brüstung, eine Platte über dem Netz). Was über der Schnitthöhe liegt, verdeckt nichts. Wand-Enden, die an
/// eine andere Wand stossen, um die halbe Dicke verlängert (Ecken geschlossen); Öffnungen bleiben unberücksichtigt.
fn component_occluders(c: &Ctx, range: &ViewRange, out: &mut Vec<crate::hlr::Face>) {
    let p = c.p;
    let depth = |zb: f64, zt: f64| match range.classify(zb, zt) {
        Zone::Cut => Some(0.0),
        Zone::Below | Zone::Under => Some(range.cut - zb.max(zt)),
        _ => None,
    };
    let walls: Vec<(&Wall, f64, f64)> = p
        .walls
        .iter()
        .filter(|w| w.floor_id == c.a.floor && c.vis(&w.category_code, &w.id))
        .filter_map(|w| {
            let (zb, zt) = p.wall_vertical_extent(w);
            let t = p.wall_thickness(w, 0.2);
            (t.is_finite() && t > 0.0).then_some(())?;
            Some((w, t, depth(zb, zt)?))
        })
        .collect();
    let fps: Vec<super::wall_poche::WallFootprint> = walls
        .iter()
        .map(|(w, t, _)| super::wall_poche::wall_footprint([w.start.x, w.start.y], [w.end.x, w.end.y], *t, crate::joins::reference_offset(crate::model3d::wall_reference(w), *t)))
        .collect();
    // Punkt in (bzw. 1 cm an) einer anderen Wand.
    let rect = |f: &super::wall_poche::WallFootprint, s0: f64, s1: f64| -> Vec<[f64; 2]> {
        let at = |s: f64, o: f64| [f.a[0] + f.u[0] * s + f.m[0] * o, f.a[1] + f.u[1] * s + f.m[1] * o];
        let (o0, o1) = (f.ref_off - f.half, f.ref_off + f.half);
        vec![at(s0, o0), at(s1, o0), at(s1, o1), at(s0, o1)]
    };
    let touches = |i: usize, q: [f64; 2]| {
        fps.iter().enumerate().any(|(j, f)| {
            if j == i {
                return false;
            }
            let r = [q[0] - f.a[0], q[1] - f.a[1]];
            let (s, o) = (r[0] * f.u[0] + r[1] * f.u[1], r[0] * f.m[0] + r[1] * f.m[1]);
            s > -0.01 && s < f.len + 0.01 && o > f.ref_off - f.half - 0.01 && o < f.ref_off + f.half + 0.01
        })
    };
    for (i, ((w, t, d), f)) in walls.iter().zip(&fps).enumerate() {
        if !(f.len > 1e-9) {
            continue;
        }
        let ring = match crate::wall_arc::arc_footprint(w, *t) {
            Some(r) => r,
            None => {
                let e0 = if touches(i, [w.start.x, w.start.y]) { f.half } else { 0.0 };
                let e1 = if touches(i, [w.end.x, w.end.y]) { f.half } else { 0.0 };
                rect(f, -e0, f.len + e1)
            }
        };
        out.extend(occluder(&ring, *d));
    }
    for col in p.columns.as_deref().unwrap_or(&[]).iter().filter(|k| k.floor_id == c.a.floor && c.vis(&k.category_code, &k.id)) {
        let (zb, zt) = p.column_vertical_extent(col);
        if let Some(d) = depth(zb, zt) {
            let ring: Vec<[f64; 2]> = crate::model3d::column_footprint(col).iter().map(|q| [q.x, q.y]).collect();
            out.extend(occluder(&ring, d));
        }
    }
    for ce in p.ceilings.as_deref().unwrap_or(&[]).iter().filter(|x| c.vis(&x.category_code, &x.id)) {
        let (zb, zt) = p.ceiling_vertical_extent(ce);
        let zone = range.classify(zb, zt);
        if ce.floor_id != c.a.floor && !range.admits_other_floor(zone) {
            continue;
        }
        if let Some(d) = depth(zb, zt) {
            let ring: Vec<[f64; 2]> = ce.ring_xy();
            out.extend(occluder(&ring, d));
        }
    }
}

/// Ein Netz im Grundriss: importiert (Kontext) oder [G1] freier Körper (`extrudedSolids`, Netz aus
/// `solid_mesh.rs`).
struct Item<'a> {
    m: MeshRef<'a>,
    zone: Zone,
    ov: Option<MeshOv>,
    greyed: bool,
    /// Freier Körper: Pick über `extrudedSolidId`, Poché aus seinem Bauteil.
    solid: Option<&'a ExtrudedSolid>,
}

/// Importierte Netze des Geschosses in `out`; `false`, wenn die Ebene kein Geschoss ist (dann zeichnet
/// `context.rs` den Fussabdruck wie bisher).
pub fn plan_meshes(c: &Ctx, out: &mut Vec<Primitive>) -> bool {
    let Some(l) = c.p.floor(&c.a.floor).filter(|l| l.kind == DrawingLevelKind::Floor) else { return false };
    let range = ViewRange::of(c.p, &c.a.floor);
    let band = floor_band(c.p, l, &range);
    let items: Vec<Item> = mesh_view::meshes(c.p)
        .into_iter()
        .filter(|m| c.shown(&m.mesh.category_code) && !c.rule_hidden(&m.mesh.id))
        .filter_map(|m| {
            let zone = zone_of(&range, band, m.info.bbox[2], m.info.bbox[5])?;
            let (ov, greyed) = (mesh_ov(c, m.mesh), c.greyed(&m.mesh.category_code));
            Some(Item { m, zone, ov, greyed, solid: None })
        })
        .collect();
    if items.is_empty() {
        return true;
    }
    draw_items(c, &range, &items, out);
    // Pick-Flächen (Hüllbox) zuletzt: Klick wählt das Netz.
    for it in &items {
        let b = &it.m.info.bbox;
        let pts = vec![Vec2 { x: b[0], y: b[1] }, Vec2 { x: b[3], y: b[1] }, Vec2 { x: b[3], y: b[4] }, Vec2 { x: b[0], y: b[4] }];
        out.push(super::context::pick_band(pts, Some(&it.m.mesh.id), None));
    }
    true
}

/// [G1] Freie Körper des Geschosses über ihr Kern-Netz (`solid_mesh::body_mesh`), wie importierte Netze:
/// geschnitten ⇒ Ebenenschnitt als Poché (mit Eckenradius/Fase, Löchern, Verjüngung, B-Rep-Grundkörpern;
/// Füllung/SIA-Schraffur aus `componentId`, ab 1:100 schwarz) und der Teil darunter als Aufsicht; ganz
/// darunter Aufsicht, darüber Überkopf-Linien (gestrichelt). Liefert die Körper ohne baubares Netz zurück
/// (der Aufrufer zeichnet sie wie bisher über ihr Profil).
pub fn plan_bodies<'a>(c: &Ctx, solids: &[&'a ExtrudedSolid], out: &mut Vec<Primitive>) -> Vec<&'a ExtrudedSolid> {
    let range = ViewRange::of(c.p, &c.a.floor);
    let mut rest = Vec::new();
    let mut owned: Vec<(&ExtrudedSolid, ImportedMesh)> = Vec::new();
    for s in solids {
        match crate::solid_mesh::body_mesh(c.p, s).and_then(|m| (*m).clone()) {
            Some(m) => {
                let indices = m.indices.iter().map(|&i| i as f64).collect();
                owned.push((s, ImportedMesh { id: s.id.clone(), name: s.id.clone(), category_code: s.category_code.clone(), positions: m.positions, indices, ..Default::default() }));
            }
            None => rest.push(*s),
        }
    }
    let mut items: Vec<Item> = Vec::new();
    for (k, (s, im)) in owned.iter().enumerate() {
        let Some(info) = mesh_view::info(im) else {
            rest.push(*s);
            continue;
        };
        let zone = range.classify(info.bbox[2], info.bbox[5]);
        if zone == Zone::Hidden {
            continue;
        }
        items.push(Item { m: MeshRef { index: k, mesh: im, info }, zone, ov: None, greyed: c.greyed(&s.category_code), solid: Some(s) });
    }
    // Pick-Fläche (Grundriss-Profil, sonst Hüllbox) zuerst, darüber Linien und Poché.
    for it in &items {
        let Some(s) = it.solid else { continue };
        let pts = if s.points.len() >= 3 {
            s.points.clone()
        } else {
            let b = &it.m.info.bbox;
            vec![Vec2 { x: b[0], y: b[1] }, Vec2 { x: b[3], y: b[1] }, Vec2 { x: b[3], y: b[4] }, Vec2 { x: b[0], y: b[4] }]
        };
        out.push(super::domains::polygon(pts, "none", "none", 0.0, no_hatch(), Some(it.greyed), None, super::domains::Pick::Solid(&s.id)));
    }
    if !items.is_empty() {
        draw_items(c, &range, &items, out);
    }
    rest
}

/// Schnittflächen, Aufsicht und Überkopf-Linien einer Netz-Gruppe (gegenseitig und durch die Bauteile verdeckt).
fn draw_items(c: &Ctx, range: &ViewRange, items: &[Item], out: &mut Vec<Primitive>) {
    let cut = range.cut;
    let (solid_fill, solid_hatch) = if c.solid_cut() { (HATCH_INK.to_string(), no_hatch()) } else { (super::section::BODY_FILL.to_string(), super::section::section_hatch()) };
    // Schnittflächen (und Verdecker der Aufsicht in Tiefe 0).
    let mut below: Vec<crate::hlr::Face> = Vec::new();
    let mut cut_prims: Vec<Primitive> = Vec::new();
    for it in items.iter().filter(|it| it.zone == Zone::Cut) {
        let (m, ov) = (&it.m, it.ov.as_ref());
        // [G1] Körper mit Bauteil: dessen Füllung und Schraffur (ausser schwarz ab 1:100).
        let comp = it.solid.filter(|_| !c.solid_cut()).and_then(|s| super::style::body_component_style(c.p, s));
        let (rings, open) = mesh_view::cut(m, &[1.0, cut]);
        for poly in super::section::rings_to_polygons(&rings) {
            let mut f = crate::hlr::Face::new(poly[0].iter().map(|q| [q[0], q[1], 0.0]).collect(), [0.0, 0.0, -1.0], u32::MAX);
            f.edges = false;
            f.two_sided = true;
            below.push(f);
            let (pts, nse) = if poly.len() > 1 {
                let (pts, bridges) = super::section::keyhole(&poly);
                let n = pts.len() as f64;
                (pts, Some(bridges.into_iter().filter(|&i| i < n).collect()))
            } else {
                (poly[0].clone(), None)
            };
            if pts.len() < 3 {
                continue;
            }
            let (fill, hatch) = match &comp {
                Some((f, h)) => (f.clone(), h.clone()),
                None => (ov.and_then(|o| o.fill.clone()).unwrap_or_else(|| solid_fill.clone()), ov.and_then(|o| o.hatch.clone()).map_or_else(|| solid_hatch.clone(), |h| h.unwrap_or_else(no_hatch))),
            };
            let mut q = super::section::polygon(pts.iter().map(|q| Vec2 { x: q[0], y: q[1] }).collect(), &fill, POCHE_STROKE, WALL_FALLBACK_MM, hatch);
            if let Primitive::Polygon { context_object_id, extruded_solid_id, no_stroke_edges, greyed: g, .. } = &mut q {
                match it.solid {
                    Some(s) => *extruded_solid_id = Some(s.id.clone()),
                    None => *context_object_id = Some(m.mesh.id.clone()),
                }
                *no_stroke_edges = nse;
                *g = Some(it.greyed);
            }
            cut_prims.push(q);
        }
        for l in open {
            for w in l.windows(2) {
                let mut q = view_line(w[0], w[1], None, it.greyed, ov);
                if let Primitive::Line { cls, weight_mm, .. } = &mut q {
                    *cls = if it.solid.is_some() { "solid-cut" } else { "mesh-cut" }.into();
                    if ov.and_then(|o| o.weight).is_none() {
                        *weight_mm = WALL_FALLBACK_MM;
                    }
                }
                cut_prims.push(q);
            }
        }
    }
    // Bauteile verdecken die Aufsicht: geschnitten in Tiefe 0 (Poché), darunter in Höhe ihrer Oberkante.
    component_occluders(c, range, &mut below);
    // Aufsicht von oben (Tiefe = Schnitthöhe − z, nur unter der Schnittebene) und Überkopf von unten.
    let mut above: Vec<crate::hlr::Face> = Vec::new();
    for (k, it) in items.iter().enumerate() {
        match it.zone {
            Zone::Above => mesh_view::hlr_faces(&it.m, &|q| [q[0], q[1], q[2] - cut], k as u32, k as u32 + 1, false, &mut above),
            _ => mesh_view::hlr_faces(&it.m, &|q| [q[0], q[1], cut - q[2]], k as u32, k as u32 + 1, true, &mut below),
        }
    }
    let opts = crate::hlr::Opts { tol: 1e-4, depth_eps: 1e-4, hidden: false, ..crate::hlr::Opts::default() };
    let mut lines: Vec<Primitive> = Vec::new();
    for faces in [&below, &above] {
        if faces.is_empty() {
            continue;
        }
        for s in crate::hlr::hidden_lines(faces, &opts) {
            let Some(it) = items.get(s.owner as usize) else { continue };
            if s.hidden {
                continue;
            }
            let dash: Option<&[f64]> = match it.zone {
                Zone::Above => Some(&ABOVE_DASH),
                Zone::Under => Some(&UNDER_DASH),
                _ => None,
            };
            let mut q = view_line(s.a, s.b, dash, it.greyed, it.ov.as_ref());
            if let (Primitive::Line { cls, .. }, Some(_)) = (&mut q, it.solid) {
                *cls = "solid-view".into();
            }
            lines.push(q);
        }
    }
    out.extend(lines);
    out.extend(cut_prims);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mesh_view::tests::cube;
    use crate::plan::domains::PlanArgs;

    fn mesh(id: &str, (positions, indices): (Vec<f64>, Vec<f64>)) -> ContextObject {
        ContextObject::ImportedMesh(ImportedMesh { id: id.into(), name: id.into(), category_code: "10".into(), positions, indices, ..Default::default() })
    }

    /// Zwei Geschosse: EG (0, Höhe 2.7, Schnitt 1.0), OG (2.7).
    fn project(ctx: Vec<ContextObject>) -> Project {
        let floor = |id: &str, base: f64| DrawingLevel { id: id.into(), name: id.into(), kind: DrawingLevelKind::Floor, base_elevation: Some(base), floor_height: Some(2.7), cut_height: Some(1.0), visible: true, ..Default::default() };
        Project { drawing_levels: vec![floor("eg", 0.0), floor("og", 2.7)], context: Some(ctx), ..Default::default() }
    }

    fn run(p: &Project, floor: &str, scale: f64) -> Vec<Primitive> {
        let a = PlanArgs::parse(1.0, &serde_json::json!({"floor": floor, "show": ["10", "20", "30"], "global": true, "scale": scale}).to_string()).unwrap();
        let c = Ctx::new(p, &a);
        let mut out = Vec::new();
        assert!(plan_meshes(&c, &mut out));
        out
    }

    fn lines(prims: &[Primitive], dashed: bool) -> Vec<([f64; 2], [f64; 2])> {
        prims.iter().filter_map(|q| match q {
            Primitive::Line { a, b, dash, cls, .. } if cls == "mesh-view" && dash.is_some() == dashed => Some(([a.x, a.y], [b.x, b.y])),
            _ => None,
        }).collect()
    }

    fn cut_area(prims: &[Primitive], id: &str) -> f64 {
        prims.iter().filter_map(|q| match q {
            Primitive::Polygon { pts, context_object_id: Some(i), fill, .. } if i == id && fill != "none" => {
                let n = pts.len();
                Some(((0..n).map(|k| pts[k].x * pts[(k + 1) % n].y - pts[(k + 1) % n].x * pts[k].y).sum::<f64>() / 2.0).abs())
            }
            _ => None,
        }).sum()
    }

    #[test]
    fn stuetze_geschnitten_mit_poche() {
        let p = project(vec![mesh("s", cube(0.0, 0.3, 0.0, 0.4, 0.0, 2.7))]);
        let prims = run(&p, "eg", 100.0);
        assert!((cut_area(&prims, "s") - 0.12).abs() < 1e-9);
        assert!(prims.iter().any(|q| matches!(q, Primitive::Polygon { fill, context_object_id: Some(i), .. } if i == "s" && fill == HATCH_INK)), "1:100 schwarz");
        let prims = run(&p, "eg", 50.0);
        assert!(prims.iter().any(|q| matches!(q, Primitive::Polygon { fill, context_object_id: Some(i), .. } if i == "s" && fill == super::super::section::BODY_FILL)), "1:50 Körper-Füllung");
        // Nicht im OG (endet unter dessen Boden).
        assert!(run(&p, "og", 100.0).is_empty());
    }

    #[test]
    fn traeger_ueber_schnitt_gestrichelt_aufsicht_darunter() {
        // Träger 2.2–2.5 (über der Schnitthöhe 1.0, unter OK EG 2.7), Tisch 0–0.75 (darunter).
        // Wand des OG (beginnt auf dessen Boden 2.7): nicht im EG.
        let p = project(vec![mesh("t", cube(0.0, 4.0, 1.0, 1.2, 2.2, 2.5)), mesh("b", cube(5.0, 7.0, 0.0, 1.0, 0.0, 0.75)), mesh("og", cube(-3.0, -2.0, 0.0, 3.0, 2.7, 5.4))]);
        let prims = run(&p, "eg", 100.0);
        let dashed = lines(&prims, true);
        assert_eq!(dashed.len(), 4, "Träger als Überkopf-Rechteck: {dashed:?}");
        assert!(dashed.iter().all(|(a, b)| a[0].max(b[0]) <= 4.0 + 1e-9));
        let solid = lines(&prims, false);
        assert_eq!(solid.len(), 4, "Tisch als Aufsicht (Umriss ohne Diagonale): {solid:?}");
        assert!(solid.iter().all(|(a, b)| a[0].min(b[0]) >= 5.0 - 1e-9));
        assert_eq!(cut_area(&prims, "t") + cut_area(&prims, "b"), 0.0);
        // Im OG weder Träger noch Tisch, nur die OG-Wand (geschnitten).
        let og = run(&p, "og", 100.0);
        assert!(lines(&og, true).is_empty() && lines(&og, false).is_empty(), "{og:?}");
        assert!((cut_area(&og, "og") - 3.0).abs() < 1e-9);
    }

    #[test]
    fn aufsicht_verdeckt_unter_hoeherem_netz() {
        // Kleiner Klotz unter einer Platte (0.6–0.7): nur die Platte ist von oben sichtbar.
        let p = project(vec![mesh("klotz", cube(1.0, 2.0, 1.0, 2.0, 0.0, 0.5)), mesh("platte", cube(0.0, 3.0, 0.0, 3.0, 0.6, 0.7))]);
        let solid = lines(&run(&p, "eg", 100.0), false);
        assert_eq!(solid.len(), 4, "{solid:?}");
        assert!(solid.iter().all(|(a, b)| [a[0], b[0], a[1], b[1]].iter().all(|v| v.abs() < 1e-9 || (v - 3.0).abs() < 1e-9)));
    }

    #[test]
    fn geschnittenes_netz_zeigt_nur_den_schnitt_von_oben() {
        // Quader durch die Schnittebene: Schnittfläche, keine Aufsichtskante innerhalb.
        let p = project(vec![mesh("w", cube(0.0, 2.0, 0.0, 0.3, 0.0, 2.7))]);
        let prims = run(&p, "eg", 100.0);
        assert!((cut_area(&prims, "w") - 0.6).abs() < 1e-9);
        let solid = lines(&prims, false);
        assert!(solid.iter().all(|(a, b)| {
            let m = [(a[0] + b[0]) / 2.0, (a[1] + b[1]) / 2.0];
            !(m[0] > 1e-6 && m[0] < 2.0 - 1e-6 && m[1] > 1e-6 && m[1] < 0.3 - 1e-6)
        }), "{solid:?}");
    }

    #[test]
    fn offenes_netz_im_schnitt_als_linie() {
        // Senkrechte Fläche ohne Dicke durch die Schnitthöhe.
        let pos = vec![0.0, 0.0, 0.0, 2.0, 0.0, 0.0, 2.0, 0.0, 2.0, 0.0, 0.0, 2.0];
        let p = project(vec![mesh("f", (pos, vec![0.0, 1.0, 2.0, 0.0, 2.0, 3.0]))]);
        let prims = run(&p, "eg", 100.0);
        let cutl: Vec<_> = prims.iter().filter(|q| matches!(q, Primitive::Line { cls, .. } if cls == "mesh-cut")).collect();
        let len: f64 = cutl.iter().map(|q| match q { Primitive::Line { a, b, .. } => crate::jsmath::hypot2(b.x - a.x, b.y - a.y), _ => 0.0 }).sum();
        assert!((len - 2.0).abs() < 1e-9, "{prims:?}");
    }

    fn wall(id: &str, a: (f64, f64), b: (f64, f64), height: f64) -> Wall {
        Wall { id: id.into(), floor_id: "eg".into(), category_code: "20".into(), start: Vec2 { x: a.0, y: a.1 }, end: Vec2 { x: b.0, y: b.1 }, height, ..Default::default() }
    }

    /// Kein Mittelpunkt einer gezeichneten Aufsichtskante liegt (echt) im Rechteck.
    fn none_inside(l: &[([f64; 2], [f64; 2])], r: [f64; 4]) -> bool {
        l.iter().all(|(a, b)| {
            let m = [(a[0] + b[0]) / 2.0, (a[1] + b[1]) / 2.0];
            !(m[0] > r[0] + 1e-6 && m[0] < r[2] - 1e-6 && m[1] > r[1] + 1e-6 && m[1] < r[3] - 1e-6)
        })
    }

    #[test]
    fn bauteile_verdecken_die_aufsicht() {
        // Tisch 0–0.75 (x 0–4, y 0–2) unter einer geschnittenen Wand (Achse y = 1, 0.2 dick, x −1…5):
        // die Tischkanten unter der Poché (y 0.9–1.1) fehlen, der Rest bleibt.
        let mut p = project(vec![mesh("b", cube(0.0, 4.0, 0.0, 2.0, 0.0, 0.75))]);
        p.walls.push(wall("w", (-1.0, 1.0), (5.0, 1.0), 2.7));
        let solid = lines(&run(&p, "eg", 100.0), false);
        assert!(none_inside(&solid, [-1.0, 0.9, 5.0, 1.1]), "{solid:?}");
        let len: f64 = solid.iter().map(|(a, b)| (b[0] - a[0]).hypot(b[1] - a[1])).sum();
        assert!((len - (8.0 + 4.0 - 0.4)).abs() < 1e-6, "Umriss ohne 2 × 0.2 m unter der Wand: {len} {solid:?}");
        // Niedrige Mauer 0–0.9 (unter der Schnitthöhe) über dem Tisch verdeckt ebenso; unter dem Tisch (0–0.5) nicht.
        p.walls[0].height = 0.9;
        assert!(none_inside(&lines(&run(&p, "eg", 100.0), false), [-1.0, 0.9, 5.0, 1.1]));
        p.walls[0].height = 0.5;
        let solid = lines(&run(&p, "eg", 100.0), false);
        let len: f64 = solid.iter().map(|(a, b)| (b[0] - a[0]).hypot(b[1] - a[1])).sum();
        assert!((len - 12.0).abs() < 1e-6, "{len}");
        // Stütze (geschnitten) über einer Tischecke.
        p.walls.clear();
        p.columns = Some(vec![Column { id: "c".into(), floor_id: "eg".into(), category_code: "20".into(), position: Vec2 { x: 4.0, y: 2.0 }, profile: ColumnProfile::Rect { width: 0.4, depth: 0.4 }, height: 2.7, ..Default::default() }]);
        let solid = lines(&run(&p, "eg", 100.0), false);
        let len: f64 = solid.iter().map(|(a, b)| (b[0] - a[0]).hypot(b[1] - a[1])).sum();
        assert!((len - 11.6).abs() < 1e-6, "Ecke unter der Stütze fehlt: {len} {solid:?}");
        // Decke (OK 0.9, unter dem Schnitt) über dem halben Tisch.
        p.columns = None;
        let mut ce = Ceiling { id: "d".into(), floor_id: "eg".into(), category_code: "30".into(), outline: vec![Vec2 { x: 2.0, y: -1.0 }, Vec2 { x: 6.0, y: -1.0 }, Vec2 { x: 6.0, y: 3.0 }, Vec2 { x: 2.0, y: 3.0 }], thickness: Some(0.1), ..Default::default() };
        ce.top = Some(VerticalAnchor::Custom { z: 0.9 });
        ce.bottom = Some(VerticalAnchor::Custom { z: 0.8 });
        p.ceilings = Some(vec![ce]);
        let solid = lines(&run(&p, "eg", 100.0), false);
        assert!(none_inside(&solid, [2.0, -1.0, 6.0, 3.0]), "{solid:?}");
        assert!(!solid.is_empty());
    }
}
