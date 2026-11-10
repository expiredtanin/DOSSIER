//! Schicht-Bänder des Schnitts: Besitzer (Wand, Decke, Platte) der geschnittenen Prismen, Stil je
//! Bauteilschicht (`attach_cut_styles()`, `split_wall_layers()`), Leibungs-Anschläge, Wand-Terminierung
//! und Dominanz (stärkere Schicht schneidet schwächere aus). Aufgerufen von `compute_section()` (`mod.rs`).

use super::*;

// Öffnungs-Lage in der Wand (für die geschnittenen Fenster/Türen).
pub(super) fn opening_extent(p: &Project, w: &Wall, o: &Opening) -> (f64, f64) {
    let (zb, zt) = p.wall_vertical_extent(w);
    let sill = max(0.0, o.sill_height);
    let ob = zb + sill;
    (ob, min(zt, ob + o.height))
}

/// [T2] Öffnung in der Bogenwand als gerade Ersatzwand: Sehne der Achse zwischen den Laibungen,
/// Öffnung ab 0 über die Sehnenlänge. `None` bei gerader Wand.
pub(super) fn arc_chord_opening(wall: &Wall, o: &Opening) -> Option<(Wall, Opening)> {
    let a = crate::wall_arc::WallArc::of_wall(wall)?;
    let axis = a.length();
    let from = max(0.0, min(o.position, axis));
    let to = max(from, min(o.position + o.width, axis));
    let (ps, pe) = (a.point(from, 0.0), a.point(to, 0.0));
    let vw = Wall { start: Vec2 { x: ps.x, y: ps.y }, end: Vec2 { x: pe.x, y: pe.y }, bulge: None, ..wall.clone() };
    let vo = Opening { position: 0.0, width: hypot2(pe.x - ps.x, pe.y - ps.y), ..o.clone() };
    Some((vw, vo))
}

pub(super) fn opening_interval(w: &Wall, o: &Opening) -> Option<(f64, f64)> {
    let axis = hypot2(w.end.x - w.start.x, w.end.y - w.start.y);
    let from = max(0.0, min(o.position, axis));
    let to = max(from, min(o.position + o.width, axis));
    if to - from < 1e-4 {
        return None;
    }
    Some((from, to))
}

/// [T2] Schnitt durch eine Bogenwand: quert die Ebene eine innere Stossfuge der Sehnen-Teilkörper,
/// liegt der Querschnitt in zwei Rechtecken nebeneinander — zu EINEM zusammenfassen, damit die
/// Schichtaufteilung (anteilig über die ganze Dicke) stimmt.
pub(super) fn merge_arc_wall_cuts(cuts: Vec<Cut>, p: &Project, walls_r: &[RWall]) -> Vec<Cut> {
    let arc_ids: HashSet<&str> = p.walls.iter().filter(|w| crate::wall_arc::WallArc::of_wall(w).is_some()).map(|w| w.id.as_str()).collect();
    if arc_ids.is_empty() {
        return cuts;
    }
    let owner = |c: &Cut| -> Option<&str> { (c.kind == Kind::Wall).then(|| walls_r.get(c.index).map(|w| w.wall_id.as_str())).flatten().filter(|id| arc_ids.contains(id)) };
    let (mut arc, mut out): (Vec<Cut>, Vec<Cut>) = cuts.into_iter().partition(|c| owner(c).is_some() && c.pts.len() >= 3);
    arc.sort_by(|a, b| {
        let (ba, bb) = (bbox(&a.pts), bbox(&b.pts));
        owner(a).cmp(&owner(b)).then(cmp_num(ba[2] - bb[2])).then(cmp_num(ba[0] - bb[0]))
    });
    let mut merged: Vec<Cut> = Vec::new();
    for c in arc {
        let b = bbox(&c.pts);
        if let Some(last) = merged.last_mut() {
            let lb = bbox(&last.pts);
            let same = owner(last) == owner(&c) && (lb[2] - b[2]).abs() < 1e-6 && (lb[3] - b[3]).abs() < 1e-6;
            if same && b[0] <= lb[1] + 1e-3 && b[1] >= lb[0] - 1e-3 {
                let (u0, u1) = (lb[0].min(b[0]), lb[1].max(b[1]));
                last.pts = vec![[u0, lb[3]], [u1, lb[3]], [u1, lb[2]], [u0, lb[2]]];
                continue;
            }
        }
        merged.push(c);
    }
    out.extend(merged);
    out
}

/// Je emittiertem Wand-Teilquader die Quellwand (über `RWall::wall_id`).
pub(super) fn wall_owners<'a>(p: &'a Project, walls: &[RWall]) -> Vec<Option<&'a Wall>> {
    let mut by_id: HashMap<&str, &Wall> = HashMap::with_capacity(p.walls.len());
    for w in &p.walls {
        by_id.entry(w.id.as_str()).or_insert(w);
    }
    walls.iter().map(|w| by_id.get(w.wall_id.as_str()).copied()).collect()
}

/// Herkunft eines Platten-Bandes: Decke (mit Schicht des Deckentyps) oder Treppe.
#[derive(Clone, Copy, Debug)]
pub enum SlabOwner<'a> {
    None,
    Ceiling(&'a Ceiling, Option<usize>),
    Stair(&'a Stair),
    Column(&'a Column),
}

/// Je emittierter Platte (Deckenschicht, Treppentritt, Podest) ihre Herkunft (`RSlab::source`).
pub fn slab_owners<'a>(p: &'a Project, slabs: &[RSlab]) -> Vec<SlabOwner<'a>> {
    let ceilings = p.ceilings.as_deref().unwrap_or(&[]);
    let stairs = p.stairs.as_deref().unwrap_or(&[]);
    slabs
        .iter()
        .map(|s| match s.source {
            SlabSource::Ceiling { index, layer } => ceilings.get(index).map_or(SlabOwner::None, |c| SlabOwner::Ceiling(c, layer)),
            SlabSource::Stair { index } => stairs.get(index).map_or(SlabOwner::None, SlabOwner::Stair),
            SlabSource::Column { index } => p.columns.as_deref().and_then(|c| c.get(index)).map_or(SlabOwner::None, SlabOwner::Column),
            SlabSource::None => SlabOwner::None,
        })
        .collect()
}

/// Ordnung eines JS-Vergleichs `(a, b) => d` (NaN/0 = gleich).
pub fn cmp_num(d: f64) -> std::cmp::Ordering {
    if d < 0.0 {
        std::cmp::Ordering::Less
    } else if d > 0.0 {
        std::cmp::Ordering::Greater
    } else {
        std::cmp::Ordering::Equal
    }
}

// ── Stil-Auflösung ────────────────────────────────────────────────────────────

pub(super) fn sum_thickness(layers: &[Layer]) -> f64 {
    layers.iter().fold(0.0, |s, l| s + l.thickness)
}

fn ceiling_layers<'a>(p: &'a Project, c: &Ceiling) -> Option<&'a [Layer]> {
    model3d::ceiling_type_ref(p, c).map(|t| t.2)
}

/// `resolveWallSectionStyle`.
fn wall_section_style(p: &Project, wall: &Wall) -> Option<(String, HatchRender)> {
    let wt = p.wall_type(wall)?;
    let mut best: Option<&Component> = None;
    for layer in &wt.layers {
        let comp = p.component(&layer.component_id)?;
        if best.is_none_or(|b| comp.join_priority > b.join_priority) {
            best = Some(comp);
        }
    }
    let best = best?;
    let category = p.layer_category(&wall.category_code);
    // Im Schnitt steht die geschnittene Wand senkrecht — wandbezogene Muster wie bei den Schicht-Bändern
    // (`split_wall_layers`), nicht nach dem Grundriss-Winkel der Wand ([109]).
    let angle = SECTION_WALL_AXIS_ANGLE_DEG;
    let hatch_id = resolve_hatch_id(wall.hatch_id.as_deref(), wall.hatch_source, category, Some(&best.hatch_id)).unwrap_or(&best.hatch_id);
    let hatch = resolve_hatch(p, hatch_id, Some(angle), resolve_foreground(best, wall.foreground.as_deref(), category, wall.foreground_source), None)?;
    Some((poche_fill(hatch.pattern).to_string(), hatch))
}

/// `resolveCeilingSectionStyle`.
fn ceiling_section_style(p: &Project, c: &Ceiling) -> Option<(String, HatchRender)> {
    let layers = ceiling_layers(p, c)?;
    let first = layers.first()?;
    let comp = p.component(&first.component_id)?;
    let category = p.layer_category(&c.category_code);
    let hatch_id = resolve_hatch_id(c.hatch_id.as_deref(), c.hatch_source, category, Some(&comp.hatch_id)).unwrap_or(&comp.hatch_id);
    let hatch = resolve_hatch(p, hatch_id, None, resolve_foreground(comp, c.foreground.as_deref(), category, c.foreground_source), None)?;
    Some((poche_fill(hatch.pattern).to_string(), hatch))
}

fn wall_representative_priority(p: &Project, wall: &Wall) -> Option<f64> {
    let wt = p.wall_type(wall)?;
    let mut best: Option<f64> = None;
    for layer in &wt.layers {
        let jp = p.component(&layer.component_id)?.join_priority;
        if best.is_none_or(|b| jp > b) {
            best = Some(jp);
        }
    }
    best
}

fn wall_representative_component_id(p: &Project, wall: &Wall) -> Option<String> {
    let wt = p.wall_type(wall)?;
    let mut best: Option<&str> = None;
    let mut best_prio = f64::NEG_INFINITY;
    for layer in &wt.layers {
        let jp = p.component(&layer.component_id)?.join_priority;
        if best.is_none() || jp > best_prio {
            best = Some(&layer.component_id);
            best_prio = jp;
        }
    }
    best.map(String::from)
}

fn ceiling_representative_component_id(p: &Project, c: &Ceiling) -> Option<String> {
    ceiling_layers(p, c)?.first().map(|l| l.component_id.clone())
}

fn ceiling_representative_priority(p: &Project, c: &Ceiling) -> Option<f64> {
    let first = ceiling_layers(p, c)?.first()?;
    Some(p.component(&first.component_id)?.join_priority)
}

/// Bounding-Box `[uMin, uMax, vMin, vMax]` über `Math.min(...)`/`Math.max(...)`.
pub(super) fn bbox(pts: &[[f64; 2]]) -> [f64; 4] {
    let mut b = [f64::INFINITY, f64::NEG_INFINITY, f64::INFINITY, f64::NEG_INFINITY];
    for q in pts {
        b[0] = min(b[0], q[0]);
        b[1] = max(b[1], q[0]);
        b[2] = min(b[2], q[1]);
        b[3] = max(b[3], q[1]);
    }
    b
}

pub(super) fn rect_of_band(c: &Cut) -> Option<[f64; 4]> {
    (c.pts.len() >= 3 && is_axis_rect(&c.pts)).then(|| bbox(&c.pts))
}

/// [G6] Liegt der Umriss genau auf seinem umgebenden Rechteck (achsparallel, Fläche = Rechteckfläche)?
/// Schräge Bänder (Dachschichten, schräge Wandoberkanten) gehen sonst als Rechteck in die Dominanz ein
/// und schneiden zu viel weg bzw. verlieren beim Beschneiden ihre Schräge.
pub(super) fn is_axis_rect(pts: &[[f64; 2]]) -> bool {
    const E: f64 = 1e-6;
    let b = bbox(pts);
    if !(b[1] - b[0] > E && b[3] - b[2] > E) {
        return false;
    }
    let on_edge = pts.iter().all(|q| ((q[0] - b[0]).abs() < E || (q[0] - b[1]).abs() < E) || ((q[1] - b[2]).abs() < E || (q[1] - b[3]).abs() < E));
    let area = pts.iter().enumerate().map(|(i, a)| { let c = pts[(i + 1) % pts.len()]; a[0] * c[1] - c[0] * a[1] }).sum::<f64>().abs() / 2.0;
    on_edge && (area - (b[1] - b[0]) * (b[3] - b[2])).abs() < E * (b[1] - b[0] + b[3] - b[2])
}

/// Bauteil-Stil einer Schicht (Füllung, Schraffur) mit dem Override des Elements (`split*Layers`).
#[allow(clippy::too_many_arguments)]
pub(super) fn layer_style(
    p: &Project,
    comp: &Component,
    hatch_id: Option<&str>,
    hatch_source: Option<AttributeSource>,
    fg: Option<&str>,
    fg_source: Option<AttributeSource>,
    bg: Option<&str>,
    bg_source: Option<AttributeSource>,
    category: Option<&LayerCategory>,
    angle: f64,
) -> Result<(String, HatchRender), String> {
    let hid = resolve_hatch_id(hatch_id, hatch_source, category, Some(&comp.hatch_id)).unwrap_or(&comp.hatch_id);
    // Hängende Schraffur (Datei/Import): ohne Muster statt Abbruch.
    let hatch = resolve_hatch(p, hid, Some(angle), resolve_foreground(comp, fg, category, fg_source), None).unwrap_or_else(no_hatch);
    let bg = resolve_background(comp, bg, category, bg_source);
    let fill = bg.map(String::from).unwrap_or_else(|| poche_fill(hatch.pattern).to_string());
    Ok((fill, hatch))
}

/// Stil einer geschnittenen Deckenschicht (Füllung, Schraffur, Verschneidung) mit dem Override der Decke.
/// Jede Schicht ist im Schnitt-Modell eine eigene Platte; ihr Band trägt so genau ihr Bauteil.
fn style_slab_layer(cp: &mut Cut, p: &Project, layer: &Layer, owner: &Ceiling) -> Result<(), String> {
    let category = p.layer_category(&owner.category_code);
    let comp = p.component_or_fallback(&layer.component_id);
    let (fill, hatch) = layer_style(p, comp, owner.hatch_id.as_deref(), owner.hatch_source, owner.foreground.as_deref(), owner.foreground_source, owner.background.as_deref(), owner.background_source, category, SECTION_SLAB_AXIS_ANGLE_DEG)?;
    cp.fill = Some(fill);
    cp.hatch = Some(hatch);
    cp.join_priority = Some(comp.join_priority);
    cp.component_id = Some(comp.id.clone());
    Ok(())
}

/// `wallLayersReversedInU`.
fn wall_layers_reversed_in_u(w: &Wall, u: (f64, f64)) -> bool {
    let (ax, ay) = (w.end.x - w.start.x, w.end.y - w.start.y);
    if hypot2(ax, ay) < 1e-9 {
        return false;
    }
    let l = hypot2(ax, ay);
    let l = if l == 0.0 || l.is_nan() { 1.0 } else { l };
    let (nx, ny) = (ax / l, ay / l);
    let (bx, by) = (-ny, nx);
    bx * u.0 + by * u.1 < 0.0
}

/// [141] Schnitt (fast) längs einer Wand: die Schnittfläche quert die Dicke nicht ganz (Länge statt
/// Dicke in u). Die Schichten liegen dann dort, wo die Schnittlinie ihre Bänder trifft — Querversatz der
/// Schnittlinie `off(u) = off0 + k·u` gegen die Schichtgrenzen, je Schicht der Streifen `[u_a, u_b]` der
/// Schnittfläche (genau in der Wandachse: die ganze Fläche in der getroffenen Schicht). `None`: die Fläche
/// quert die ganze Dicke (übliche Verteilung). Anschlag-Nasen/Schichteinzug entfallen in diesem Fall.
fn split_layers_along(cp: &Cut, p: &Project, layers: &[Layer], owner: &Wall, u_world: (f64, f64), plane: &Plane, total: f64) -> Result<Option<Vec<Cut>>, String> {
    let [u_min, u_max, v_min, v_max] = bbox(&cp.pts);
    let (ax, ay) = (owner.end.x - owner.start.x, owner.end.y - owner.start.y);
    let l = hypot2(ax, ay);
    if !(l > 1e-9) {
        return Ok(None);
    }
    let n = (-ay / l, ax / l);
    let k = u_world.0 * n.0 + u_world.1 * n.1;
    if k.abs() > 1e-12 && (total / k.abs() - (u_max - u_min)).abs() < 1e-6 {
        return Ok(None);
    }
    if k.abs() > 1e-12 && (u_max - u_min) >= total / k.abs() {
        return Ok(None);
    }
    let base = plane.base();
    let off0 = (base.0 - owner.start.x) * n.0 + (base.1 - owner.start.y) * n.1;
    let mut lo = crate::joins::reference_offset(crate::model3d::wall_reference(owner), total) - total / 2.0;
    let category = p.layer_category(&owner.category_code);
    let ring = vec![cp.pts.clone()];
    let mut out = Vec::new();
    for (li, layer) in layers.iter().enumerate() {
        let hi = lo + layer.thickness;
        let (ua, ub) = if k.abs() <= 1e-12 {
            // Genau parallel: ganze Fläche, wenn die Linie in dieser Schicht liegt (Grenze: die erste).
            if off0 >= lo - 1e-9 && (off0 < hi - 1e-9 || li + 1 == layers.len()) { (u_min - 1.0, u_max + 1.0) } else { (0.0, 0.0) }
        } else {
            let (a, b) = ((lo - off0) / k, (hi - off0) / k);
            (a.min(b), a.max(b))
        };
        lo = hi;
        let (ua, ub) = (ua.max(u_min - 1.0), ub.min(u_max + 1.0));
        if ub - ua <= 1e-9 {
            continue;
        }
        // Streifen knapp über das Ausmass (i_overlay rechnet auf einem Raster relativ zur Ausdehnung).
        let whole = ua <= u_min && ub >= u_max;
        let strip = vec![vec![[ua, v_min - 1.0], [ub, v_min - 1.0], [ub, v_max + 1.0], [ua, v_max + 1.0]]];
        let comp = p.component_or_fallback(&layer.component_id);
        let (fill, hatch) = layer_style(p, comp, owner.hatch_id.as_deref(), owner.hatch_source, owner.foreground.as_deref(), owner.foreground_source, owner.background.as_deref(), owner.background_source, category, SECTION_WALL_AXIS_ANGLE_DEG)?;
        let parts = if whole { vec![ring.clone()] } else { crate::polygon_bool::intersection(&[ring.clone()], &[strip]) };
        for pl in parts {
            let Some(pts) = pl.into_iter().next() else { continue };
            let mut c = Cut::new(cp.kind, cp.index, pts);
            c.fill = Some(fill.clone());
            c.hatch = Some(hatch.clone());
            c.join_priority = Some(comp.join_priority);
            c.component_id = Some(comp.id.clone());
            c.source_id = cp.source_id.clone();
            c.category = cp.category.clone();
            c.layer_index = Some(li);
            out.push(c);
        }
    }
    Ok((!out.is_empty()).then_some(out))
}

/// `splitWallLayers`: stehende Teil-Rechtecke je Schicht quer zur Dicke (u).
pub(super) fn split_wall_layers(cp: &Cut, p: &Project, layers: &[Layer], owner: &Wall, u_world: (f64, f64), plane: &Plane) -> Result<Vec<Cut>, String> {
    let total = sum_thickness(layers);
    let [u_min, u_max, v_min, v_max] = bbox(&cp.pts);
    let u_span = u_max - u_min;
    if total <= 1e-9 || u_span <= 1e-9 {
        return Ok(vec![cp.clone()]);
    }
    if let Some(out) = split_layers_along(cp, p, layers, owner, u_world, plane, total)? {
        return Ok(out);
    }
    let scale = u_span / total;
    let reversed = wall_layers_reversed_in_u(owner, u_world);
    let ordered: Vec<&Layer> = if reversed { layers.iter().rev().collect() } else { layers.iter().collect() };
    let category = p.layer_category(&owner.category_code);
    let mut out = Vec::with_capacity(layers.len());
    // [106] Schichteinzug am Sturz (Stück liegt über der Öffnung) bzw. an der Brüstung (darunter),
    // [94] Anschlag: die Schichten vor dem Rahmen reichen um die Anschlagtiefe in die Öffnung.
    let (top, bottom) = section_reveal(p, owner, plane, v_min, v_max);
    let n = layers.len();
    let offsets: Vec<f64> = layers.iter().scan(0.0, |acc, l| { let o = *acc; *acc += l.thickness; Some(o) }).collect();
    let mut acc = 0.0;
    for (k, layer) in ordered.into_iter().enumerate() {
        let li = if reversed { n - 1 - k } else { k };
        let comp = p.component_or_fallback(&layer.component_id);
        let (fill, hatch) = layer_style(p, comp, owner.hatch_id.as_deref(), owner.hatch_source, owner.foreground.as_deref(), owner.foreground_source, owner.background.as_deref(), owner.background_source, category, SECTION_WALL_AXIS_ANGLE_DEG)?;
        let u_left = u_min + acc * scale;
        acc += layer.thickness;
        let u_right = u_min + acc * scale;
        let mk = |pts: Vec<[f64; 2]>| {
            let mut c = Cut::new(cp.kind, cp.index, pts);
            c.fill = Some(fill.clone());
            c.hatch = Some(hatch.clone());
            c.join_priority = Some(comp.join_priority);
            c.component_id = Some(comp.id.clone());
            c.source_id = cp.source_id.clone();
            c.category = cp.category.clone();
            c.layer_index = Some(li);
            c
        };
        let shift = |s: &Option<EdgeJoin>| s.as_ref().map_or(0.0, |e| e.shift(li));
        let (mut vb, mut vt) = (v_min + shift(&top), v_max - shift(&bottom));
        // Formöffnung ([G3]): Rücksprung senkrecht zum (versetzten) Umriss.
        if let Some(v) = top.as_ref().and_then(|e| e.shape.as_ref()).and_then(|s| s.layer_edge(li, true)) {
            vb = v;
        }
        if let Some(v) = bottom.as_ref().and_then(|e| e.shape.as_ref()).and_then(|s| s.layer_edge(li, false)) {
            vt = v;
        }
        let u_of = |o: f64| if reversed { u_max - o * scale } else { u_min + o * scale };
        let nibs = rebate_nibs(&top, &bottom, (offsets[li], offsets[li] + layer.thickness), (v_min, v_max), &u_of);
        // Zusatzstücke dieser Schicht in der Öffnung `[u0, u1, v0, v1]` (an der Kante des Wandstücks).
        let mut pieces: Vec<[f64; 4]> = Vec::new();
        for (side, below) in [(&top, true), (&bottom, false)] {
            let Some(e) = side else { continue };
            if let Some(sj) = &e.shape {
                for [o0, o1, z0, z1] in sj.pieces(li, below) {
                    let (ua, ub) = (min(u_of(o0), u_of(o1)), max(u_of(o0), u_of(o1)));
                    pieces.push([ua, ub, z0, z1]);
                }
                continue;
            }
            for a in e.adj.iter().filter(|a| a.layer == li) {
                for pc in &a.pieces {
                    // In der Anschlag-Zone deckt die Nase das Stück bis zur Anschlagtiefe schon ab.
                    let mut pc = *pc;
                    if let Some((d, _, _)) = e.rebate.filter(|r| pc[2] >= r.1 - 1e-6 && pc[3] <= r.2 + 1e-6) {
                        pc[0] = pc[0].max(d);
                        if pc[1] - pc[0] <= 1e-6 {
                            continue;
                        }
                    }
                    let (z0, z1) = if below { (v_min - pc[1], v_min - pc[0]) } else { (v_max + pc[0], v_max + pc[1]) };
                    let (ua, ub) = (min(u_of(pc[2]), u_of(pc[3])), max(u_of(pc[2]), u_of(pc[3])));
                    pieces.push([ua, ub, z0, z1]);
                }
            }
        }
        let rect_pts = |r: [f64; 4]| vec![[r[0], r[3]], [r[1], r[3]], [r[1], r[2]], [r[0], r[2]]];
        if nibs.is_empty() && pieces.is_empty() {
            if vt - vb > 1e-6 {
                out.push(mk(rect_pts([u_left, u_right, vb, vt])));
            }
        } else {
            // Band, Nase(n) und Zusatzstücke der Schicht als EIN Umriss (keine Fuge an der Nase, [168]
            // auch ohne Nase keine am Schichteinzug).
            let mut rects = nibs;
            if vt - vb > 1e-6 {
                rects.push([u_left, u_right, vb, vt]);
            }
            rects.extend(pieces);
            out.extend(union_rect_outlines(&rects).into_iter().map(mk));
        }
    }
    Ok(out)
}

/// Anschlag-Nasen eines einschaligen Wandbands (ganze Dicke als eine Schicht).
fn single_layer_nibs(p: &Project, owner: &Wall, cp: &Cut, u_world: (f64, f64), plane: &Plane) -> Vec<[f64; 4]> {
    let total = sum_thickness(&p.wall_type_or_fallback(owner).layers);
    let [u_min, u_max, v_min, v_max] = bbox(&cp.pts);
    if !(total > 1e-9 && u_max - u_min > 1e-9) {
        return Vec::new();
    }
    let (top, bottom) = section_reveal(p, owner, plane, v_min, v_max);
    if top.is_none() && bottom.is_none() {
        return Vec::new();
    }
    let scale = (u_max - u_min) / total;
    let reversed = wall_layers_reversed_in_u(owner, u_world);
    let u_of = |o: f64| if reversed { u_max - o * scale } else { u_min + o * scale };
    rebate_nibs(&top, &bottom, (0.0, total), (v_min, v_max), &u_of)
}

/// Anschluss eines Wandstücks an die Öffnung, deren Sturz (Stück darüber) bzw. Brüstung (darunter) es ist.
struct EdgeJoin {
    /// Schichteinzug [106].
    adj: Vec<crate::opening_detail::LayerAdjust>,
    /// Anschlag [94]/[105]: Tiefe in die Öffnung und Zone quer ab Aussenfläche (zwischen Fläche und Rahmen).
    rebate: Option<(f64, f64, f64)>,
    /// Formöffnung ([G3]): der Schichteinzug folgt dem Umriss statt Sturz/Brüstung.
    shape: Option<ShapeJoin>,
}

/// Schichteinzug [106] einer Formöffnung an der Schnittstelle `u` (Öffnungskoordinaten): Umriss,
/// Brüstungshöhe `zb` und die Anschlüsse aller vier Seiten (die Bogenkante gehört nach ihrer Normalen
/// zu einer Seite, `opening_shape::edge_side`).
struct ShapeJoin {
    poly: Vec<crate::opening_shape::P>,
    u: f64,
    zb: f64,
    sides: [Vec<crate::opening_detail::LayerAdjust>; 4],
}

impl ShapeJoin {
    /// Kante der Schicht `layer` an der Schnittstelle: oben (`top`) bzw. unten, um den Rücksprung je Seite
    /// versetzt (wie im 3D, `opening_shape::layer_fill_quads`).
    fn layer_edge(&self, layer: usize, top: bool) -> Option<f64> {
        let s: [f64; 4] = std::array::from_fn(|k| self.sides[k].iter().find(|a| a.layer == layer).map_or(0.0, |a| a.shift));
        let r = crate::opening_shape::v_range(&crate::opening_shape::outset_sides(&self.poly, s), self.u)?;
        Some(self.zb + if top { r.1 } else { r.0 })
    }

    /// Zusatzstücke der Schicht an der Schnittstelle `[o0, o1, z0, z1]`: senkrecht zum Umriss gemessen.
    fn pieces(&self, layer: usize, top: bool) -> Vec<[f64; 4]> {
        use crate::opening_shape as os;
        let n = self.poly.len();
        // Kante des Umrisses über bzw. unter der Schnittstelle.
        let Some(edge) = (0..n).filter(|&i| {
            let (a, b) = (self.poly[i], self.poly[(i + 1) % n]);
            (a[0].min(b[0]) <= self.u && self.u <= a[0].max(b[0])) && (b[0] - a[0]).abs() > 1e-9 && ((b[0] < a[0]) == top)
        }).next() else { return Vec::new() };
        let side = os::edge_side(&self.poly, edge);
        let at = |d: f64| os::v_range(&os::inset(&self.poly, d), self.u).map(|r| self.zb + if top { r.1 } else { r.0 });
        let mut out = Vec::new();
        for a in self.sides[side].iter().filter(|a| a.layer == layer) {
            for &[x0, x1, o0, o1] in &a.pieces {
                if let (Some(z0), Some(z1)) = (at(x0), at(x1)) {
                    out.push([o0, o1, min(z0, z1), max(z0, z1)]);
                }
            }
        }
        out
    }
}

impl EdgeJoin {
    fn shift(&self, layer: usize) -> f64 {
        self.adj.iter().find(|a| a.layer == layer).map_or(0.0, |a| a.shift)
    }
}

/// Anschlag-Nasen `[u0, u1, v0, v1]` einer Schicht (quer `l0..l1` ab Aussenfläche) am Sturz (unter
/// `v_min`) und an der Brüstung (über `v_max`); `u_of` bildet die Lage ab Aussenfläche auf u ab.
fn rebate_nibs(top: &Option<EdgeJoin>, bottom: &Option<EdgeJoin>, (l0, l1): (f64, f64), (v_min, v_max): (f64, f64), u_of: &dyn Fn(f64) -> f64) -> Vec<[f64; 4]> {
    let mut out = Vec::new();
    for (side, below) in [(top, true), (bottom, false)] {
        let Some((d, z0, z1)) = side.as_ref().and_then(|e| e.rebate) else { continue };
        let (a, b) = (z0.max(l0), z1.min(l1));
        if b - a <= 1e-6 {
            continue;
        }
        let (ua, ub) = (min(u_of(a), u_of(b)), max(u_of(a), u_of(b)));
        out.push(if below { [ua, ub, v_min - d, v_min] } else { [ua, ub, v_max, v_max + d] });
    }
    out
}

/// Schichteinzug und Anschlag der Öffnung, deren Sturz (unten an `v_min`) bzw. Brüstung (oben an `v_max`)
/// dieses Wandstück ist und die die Schnittebene quert.
fn section_reveal(p: &Project, wall: &Wall, plane: &Plane, v_min: f64, v_max: f64) -> (Option<EdgeJoin>, Option<EdgeJoin>) {
    let (mut top, mut bottom) = (None, None);
    let u_raw = plane.u_model();
    let l = hypot2(u_raw.0, u_raw.1);
    if !(l > 1e-12) {
        return (None, None);
    }
    let u = (u_raw.0 / l, u_raw.1 / l);
    // Bogenwand: `wall` ist hier die Sehnen-Teilwand (mit Bulge) — die Öffnung sitzt auf der echten Wand.
    let host = p.walls.iter().find(|w| w.id == wall.id).unwrap_or(wall);
    for o in p.openings_of_wall(&wall.id) {
        // Bogenwand ([T2]): Einzug auf der Sehne zwischen den Laibungen.
        let chord = arc_chord_opening(host, o);
        let (wall, o) = match &chord {
            Some((vw, vo)) => (vw, vo),
            None => (wall, o),
        };
        // Lichte Höhe an der Schnittstelle (Formöffnungen: aus dem Umriss, wie die Wandbänder).
        let Ok(Some(c)) = cross_section(p, wall, o, plane.base(), u) else { continue };
        let at_top = (v_min - c.z_top).abs() < 1e-3;
        let at_bottom = (v_max - c.z_bottom).abs() < 1e-3;
        if !at_top && !at_bottom {
            continue;
        }
        let sides = crate::opening_detail::opening_reveal(p, wall, o).map(|r| r.sides).unwrap_or_default();
        let shaped = c.shape.as_ref().filter(|_| sides.iter().any(|s| !s.is_empty()));
        let shape = || shaped.map(|(poly, u, zb)| ShapeJoin { poly: poly.clone(), u: *u, zb: *zb, sides: sides.clone() });
        let [_, _, t, b] = sides.clone();
        // Anschlag: oben wie an der Leibung (Sturz-Nase), unten nach `rebates.bottom` (Türen: keiner).
        let h = c.z_top - c.z_bottom;
        let frame = crate::opening_detail::frame_of(p, o);
        let zone = frame.as_ref().and_then(|f| f.rebate_zone(c.face_max - c.face_min));
        let rebate = |d: f64| zone.map(|(z0, z1)| (min(d, h / 3.0), z0, z1)).filter(|r| r.0 > 1e-4);
        let (rt, rb) = match &frame {
            Some(f) => (rebate(f.rebate.top), if o.kind == ElementKind::Door { None } else { rebate(f.rebate.bottom) }),
            None => (None, None),
        };
        if at_top && (!t.is_empty() || rt.is_some() || shaped.is_some()) {
            top = Some(EdgeJoin { adj: t, rebate: rt, shape: shape() });
        }
        if at_bottom && (!b.is_empty() || rb.is_some() || shaped.is_some()) {
            bottom = Some(EdgeJoin { adj: b, rebate: rb, shape: shape() });
        }
    }
    (top, bottom)
}

/// `attachCutStyles`: Stil, Herkunft, Schicht-Bänder, Terminierung, Dominanz.
pub(super) fn attach_cut_styles(cuts: Vec<Cut>, p: &Project, plane: &Plane, walls: &[Option<&Wall>], slabs: &[SlabOwner]) -> Result<Vec<Cut>, String> {
    if cuts.is_empty() {
        return Ok(cuts);
    }
    let u_world = plane.u_model();
    let roofs = p.roofs.as_deref().unwrap_or(&[]);
    let mut bands: Vec<Cut> = Vec::with_capacity(cuts.len());
    for mut cp in cuts {
        match cp.kind {
            Kind::Roof => {
                let owner = roofs.get(cp.index);
                cp.source_id = owner.map(|o| o.id.clone());
                cp.category = owner.map(|o| o.category_code.clone());
                bands.push(cp);
            }
            Kind::Wall => {
                let owner = walls.get(cp.index).copied().flatten();
                cp.source_id = owner.map(|o| o.id.clone());
                cp.category = owner.map(|o| o.category_code.clone());
                if let Some(o) = owner {
                    let wt = p.wall_type_or_fallback(o);
                    if wt.layers.len() > 1 {
                        bands.extend(split_wall_layers(&cp, p, &wt.layers, o, u_world, plane)?);
                        continue;
                    }
                }
                if let Some((fill, hatch)) = owner.and_then(|o| wall_section_style(p, o)) {
                    cp.fill = Some(fill);
                    cp.hatch = Some(hatch);
                }
                cp.join_priority = owner.and_then(|o| wall_representative_priority(p, o));
                cp.component_id = owner.and_then(|o| wall_representative_component_id(p, o));
                // [94] Anschlag-Nase der einschaligen Wand: Band und Nase als ein Umriss.
                let nibs = owner.map(|o| single_layer_nibs(p, o, &cp, u_world, plane)).unwrap_or_default();
                if !nibs.is_empty() {
                    let mut polys = vec![vec![cp.pts.clone()]];
                    polys.extend(nibs.iter().map(|r| vec![vec![[r[0], r[3]], [r[1], r[3]], [r[1], r[2]], [r[0], r[2]]]]));
                    for poly in crate::polygon_bool::union(&polys) {
                        if let Some(ring) = poly.into_iter().next().filter(|r| r.len() >= 3) {
                            bands.push(Cut { pts: ring, ..cp.clone() });
                        }
                    }
                    continue;
                }
                bands.push(cp);
            }
            _ => {
                match slabs.get(cp.index).copied().unwrap_or(SlabOwner::None) {
                    SlabOwner::Ceiling(o, layer) => {
                        cp.source_id = Some(o.id.clone());
                        cp.category = Some(o.category_code.clone());
                        let layers = ceiling_layers(p, o).unwrap_or(Project::fallback_layers());
                        if layers.len() > 1 {
                            // Schicht-Platte: Stil genau dieser Schicht; ohne Schicht (Dicke 0) ohne Stil.
                            if let Some(l) = layer.and_then(|i| layers.get(i)) {
                                style_slab_layer(&mut cp, p, l, o)?;
                                cp.layer_index = layer;
                            }
                        } else {
                            if let Some((fill, hatch)) = ceiling_section_style(p, o) {
                                cp.fill = Some(fill);
                                cp.hatch = Some(hatch);
                            }
                            cp.join_priority = ceiling_representative_priority(p, o);
                            cp.component_id = ceiling_representative_component_id(p, o);
                        }
                    }
                    // Treppen-Prismen: Herkunft + Kategorie; Stil = Rückfall-Schraffur (Treppen haben kein Bauteil).
                    SlabOwner::Stair(st) => {
                        cp.stair_id = Some(st.id.clone());
                        cp.category = Some(st.category_code.clone());
                    }
                    // [141] Stütze: Stil und Rang ihres Bauteils (wie im Grundriss); ohne Bauteil dominiert sie.
                    SlabOwner::Column(c) => {
                        cp.source_id = Some(c.id.clone());
                        cp.category = Some(c.category_code.clone());
                        let comp = c.component_id.as_deref().filter(|s| !s.is_empty()).and_then(|id| p.component(id));
                        if let Some(k) = comp {
                            let category = p.layer_category(&c.category_code);
                            let hid = resolve_hatch_id(c.hatch_id.as_deref(), c.hatch_source, category, Some(&k.hatch_id)).unwrap_or(&k.hatch_id);
                            if let Some(h) = resolve_hatch(p, hid, None, resolve_foreground(k, c.foreground.as_deref(), category, c.foreground_source), None) {
                                cp.fill = Some(poche_fill(h.pattern).to_string());
                                cp.hatch = Some(h);
                            }
                            cp.component_id = Some(k.id.clone());
                        }
                        cp.join_priority = Some(comp.map_or(f64::MAX, |k| k.join_priority));
                    }
                    SlabOwner::None => {}
                }
                bands.push(cp);
            }
        }
    }
    let terminated = apply_wall_termination(bands, walls);
    Ok(subtract_dominant_bands(terminated))
}

/// `applyWallTermination`: Wände mit `sliceTermination` "below"/"above" enden an der Decke.
pub(super) fn apply_wall_termination(bands: Vec<Cut>, walls: &[Option<&Wall>]) -> Vec<Cut> {
    const EPS_T: f64 = 1e-9;
    const TOUCH: f64 = 0.05;
    let slab_bands: Vec<([f64; 4], f64)> = bands.iter().filter(|b| b.kind == Kind::Slab).filter_map(|b| b.join_priority.map(|jp| (bbox(&b.pts), jp))).collect();
    if slab_bands.is_empty() {
        return bands;
    }
    // [171] Lage aller Platten- und Wandbänder (für Wände ohne `sliceTermination`, s. `end_below_floor_buildup`).
    let bands_meta: Vec<(Kind, [f64; 4], Option<f64>, Option<String>)> = bands.iter().map(|b| (b.kind, bbox(&b.pts), b.join_priority, b.source_id.clone())).collect();
    let mut out = Vec::with_capacity(bands.len());
    for b in bands {
        if b.kind != Kind::Wall {
            out.push(b);
            continue;
        }
        let term = walls.get(b.index).copied().flatten().and_then(|w| w.slice_termination);
        let (Some(term @ (SliceTermination::Below | SliceTermination::Above)), Some(jp)) = (term, b.join_priority) else {
            out.extend(end_below_floor_buildup(b, &bands_meta));
            continue;
        };
        let wb = bbox(&b.pts);
        let cutters: Vec<&([f64; 4], f64)> = slab_bands.iter().filter(|(sb, sjp)| *sjp > jp && sb[1] > wb[0] - TOUCH && sb[0] < wb[1] + TOUCH).collect();
        if cutters.is_empty() {
            out.push(b);
            continue;
        }
        if term == SliceTermination::Below {
            let mut clip_top = f64::INFINITY;
            for c in &cutters {
                clip_top = min(clip_top, c.0[2]);
            }
            let top = min(clip_top, wb[3]);
            if top > wb[2] + EPS_T {
                out.extend(clip_band(b, [wb[0], wb[1], wb[2], top]));
            }
            continue;
        }
        let mut clip_bottom = f64::NEG_INFINITY;
        for c in &cutters {
            clip_bottom = max(clip_bottom, c.0[3]);
        }
        let bottom = max(clip_bottom, wb[2]);
        if bottom < wb[3] - EPS_T {
            out.extend(clip_band(b, [wb[0], wb[1], bottom, wb[3]]));
        }
    }
    out
}

/// [171] Wand von unten ohne Wand darüber (einfaches Musterhaus: Innenwand EG bis OK Fertigboden OG): sie endet
/// unter der tragenden Platte, die sie dominiert, statt mit ihrem Rest durch Trittschalldämmung und Unterlagsboden
/// zu stechen. Nur wenn der Rest über der Platte (< 0.5 m) ganz im Plattenaufbau liegt und keine andere Wand darauf
/// steht (sonst bleibt der Stoss wie bisher: Wand darüber, Aufbau stösst an).
fn end_below_floor_buildup(b: Cut, meta: &[(Kind, [f64; 4], Option<f64>, Option<String>)]) -> Vec<Cut> {
    const EPS: f64 = 1e-6;
    let (Some(jp), true) = (b.join_priority, b.pts.len() >= 3) else { return vec![b] };
    let wb = bbox(&b.pts);
    let covers_u = |r: &[f64; 4]| r[0] <= wb[0] + EPS && r[1] >= wb[1] - EPS;
    // Unterste dominierende Platte, die die Wand ganz quert und knapp unter der Wandkrone endet (bei dünnen
    // Putzschichten dominiert auch der Unterlagsboden; die Wand endet trotzdem unter der Rohdecke).
    let Some(slab) = meta
        .iter()
        .filter(|(k, r, p, _)| *k == Kind::Slab && p.is_some_and(|q| q > jp) && covers_u(r) && r[2] > wb[2] + EPS && r[3] < wb[3] - EPS && wb[3] - r[3] < 0.5)
        .map(|m| m.1)
        .min_by(|a, b| a[2].total_cmp(&b[2]))
    else {
        return vec![b];
    };
    let stack_top = meta.iter().filter(|(k, r, _, _)| *k == Kind::Slab && covers_u(r) && r[2] >= slab[3] - 1e-4 && r[2] < wb[3]).map(|m| m.1[3]).fold(slab[3], f64::max);
    if wb[3] > stack_top + 1e-4 {
        return vec![b];
    }
    let wall_above = meta.iter().any(|(k, r, _, src)| *k == Kind::Wall && *src != b.source_id && r[0] < wb[1] - EPS && r[1] > wb[0] + EPS && r[2] >= slab[3] - 1e-4 && r[2] <= wb[3] + 1e-4);
    if wall_above {
        return vec![b];
    }
    clip_band(b, [wb[0], wb[1], wb[2], slab[2]])
}

/// Band auf das Rechteck `[u0, u1, v0, v1]` beschnitten; ein Band mit Anschlag-Nase ([94], kein
/// Rechteck) behält seine Form.
fn clip_band(b: Cut, r: [f64; 4]) -> Vec<Cut> {
    let rect = vec![[r[0], r[3]], [r[1], r[3]], [r[1], r[2]], [r[0], r[2]]];
    if b.pts.len() <= 4 || is_axis_rect(&b.pts) {
        return vec![Cut { pts: rect, ..b }];
    }
    crate::polygon_bool::intersection(&[vec![b.pts.clone()]], &[vec![rect]])
        .into_iter()
        .filter_map(|poly| poly.into_iter().next().filter(|ring| ring.len() >= 3))
        .map(|ring| Cut { pts: ring, ..b.clone() })
        .collect()
}

/// `subtractDominantBands` (Rechnung: `dossier_hatch::section_dominance`, gemeinsam mit dem 3D-Live-Schnitt).
pub(super) fn subtract_dominant_bands(bands: Vec<Cut>) -> Vec<Cut> {
    use dossier_hatch::section_dominance::{dominant_bands, Band};
    let mut ids: HashMap<&str, u32> = HashMap::new();
    let inp: Vec<Band> = bands
        .iter()
        .map(|band| {
            let comp = band.component_id.as_deref().map(|id| {
                let n = ids.len() as u32;
                *ids.entry(id).or_insert(n)
            });
            let rect = rect_of_band(band).map(|r| dossier_hatch::section_dominance::Rect { u_min: r[0], u_max: r[1], v_min: r[2], v_max: r[3] });
            Band { rect, prio: band.join_priority, comp }
        })
        .collect();
    let rect_out: Vec<Cut> = dominant_bands(&inp)
        .into_iter()
        .map(|piece| {
            let src = &bands[piece.src];
            let Some(r) = piece.rect else { return src.clone() };
            let mut c = Cut::new(src.kind, src.index, vec![[r.u_min, r.v_max], [r.u_max, r.v_max], [r.u_max, r.v_min], [r.u_min, r.v_min]]);
            c.fill = src.fill.clone();
            c.hatch = src.hatch.clone();
            c.join_priority = src.join_priority;
            c.component_id = src.component_id.clone();
            c.source_id = src.source_id.clone();
            // Herkunft bleibt am Stück (Ebenen-Sichtbarkeit, Treppen-Pick).
            c.category = src.category.clone();
            c.stair_id = src.stair_id.clone();
            c.layer_index = src.layer_index;
            c
        })
        .collect();
    subtract_dominant_polygons(rect_out, &bands)
}

/// [G6] Dominanz für Bänder, die keine achsparallelen Rechtecke sind (schräge Dachschichten …): Jedes Stück
/// verliert die Überlappung mit allen Bändern STRIKT höherer Priorität, wenn eines der beiden kein Rechteck ist
/// (Rechteck gegen Rechteck hat `dominant_bands` schon erledigt). Polygon-Booleans über den Kern (i_overlay).
/// Bleibt ein Loch übrig (Band ganz um ein dominantes herum), wird das Stück unverändert übernommen.
fn subtract_dominant_polygons(pieces: Vec<Cut>, bands: &[Cut]) -> Vec<Cut> {
    let cutters: Vec<(&Cut, bool, [f64; 4])> = bands.iter().filter(|b| b.pts.len() >= 3 && b.join_priority.is_some()).map(|b| (b, is_axis_rect(&b.pts), bbox(&b.pts))).collect();
    if cutters.iter().all(|c| c.1) {
        return pieces;
    }
    let mut out = Vec::with_capacity(pieces.len());
    for piece in pieces {
        let Some(jp) = piece.join_priority.filter(|_| piece.pts.len() >= 3) else {
            out.push(piece);
            continue;
        };
        let rect = is_axis_rect(&piece.pts);
        let pb = bbox(&piece.pts);
        let polys: Vec<crate::flat::Polygon> = cutters
            .iter()
            .filter(|(c, c_rect, cb)| c.join_priority.is_some_and(|q| q > jp) && !(rect && *c_rect) && cb[0] < pb[1] - 1e-9 && cb[1] > pb[0] + 1e-9 && cb[2] < pb[3] - 1e-9 && cb[3] > pb[2] + 1e-9)
            .map(|(c, _, _)| vec![c.pts.clone()])
            .collect();
        if polys.is_empty() {
            out.push(piece);
            continue;
        }
        let rest = crate::polygon_bool::difference(&[vec![piece.pts.clone()]], &polys);
        if rest.iter().any(|p| p.len() > 1) {
            out.push(piece);
            continue;
        }
        for poly in rest {
            let Some(ring) = poly.into_iter().next() else { continue };
            let area = ring.iter().enumerate().map(|(i, a)| { let c = ring[(i + 1) % ring.len()]; a[0] * c[1] - c[0] * a[1] }).sum::<f64>().abs() / 2.0;
            if ring.len() >= 3 && area > 1e-8 {
                out.push(Cut { pts: ring, ..piece.clone() });
            }
        }
    }
    out
}
