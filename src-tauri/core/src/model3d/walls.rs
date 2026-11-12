//! Wände im 3D: Schicht-Bänder je Wandtyp, Wandknoten je Geschoss (`joins.rs`), Wandteile zwischen
//! Öffnungen und Terminierung an Decken und Dächern (`wall_pieces()`), Taschen und Fussabdrücke der
//! Wandkörper. Aufgerufen von `parts()` (`mod.rs`), dem inkrementellen Cache (`model3d_cache.rs`),
//! dem Schnitt (`emit_walls_with()`) und der Ansicht.

use super::*;

/// Absenkung der Oberkante (`topDrop`), Löcher und Metadaten je Wandkörper (`RWall`).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RHole {
    pub from: f64,
    pub to: f64,
    pub z_bottom: f64,
    pub z_top: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RWall {
    pub start: RVec2,
    pub end: RVec2,
    pub thickness: f64,
    pub height: f64,
    pub base_elevation: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub top_drop: Option<[f64; 2]>,
    /// Ebene Oberkante unter einer Dachfläche ([G2]): `[z am Anfang (Mittellinie), dz/dx, dz/dy]`
    /// (Grundriss-Meter). Übersteuert `topDrop`; `height` ist dann der höchste Eckwert über der UK.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub top_plane: Option<[f64; 3]>,
    pub color: Rgb,
    pub layers: Vec<()>,
    pub wall_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub holes: Option<Vec<RHole>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hatch: Option<style::RHatch>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub material_index: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cut: Option<RCutMeta>,
    /// Schnittlinie `[px, py, dx, dy]` (Grundriss) am Anfang/Ende: Gehrung, T-Stoss-Fläche oder schräge
    /// Aussparungs-Seite; die Kanten ±Dicke/2 enden auf ihr ([108]). Fehlt: rechtwinklig bzw. die
    /// Gehrung, die render3d aus den Nachbar-Enden ableitet.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_cut: Option<[f64; 4]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_cut: Option<[f64; 4]>,
    /// Anfang/Ende liegt an einer inneren Stossfuge einer Bogenwand ([T2], Sehnen-Teilkörper): dort
    /// keine sichtbare Stirnfläche (Ansicht).
    #[serde(skip)]
    pub joint: [bool; 2],
    /// [169] Sehnen-Teilkörper einer Bogenwand: Mittelpunkt des Bogens (render3d `arcCenter`, glatt schattiert).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub arc_center: Option<[f64; 2]>,
}

/// Textur-Karten-URLs der Bauteile in der Reihenfolge des ersten Auftretens: Wandtypen, dann
/// Decken, dann Dächer (`wallMaterialColorMaps`).
pub fn wall_material_color_maps(p: &Project) -> Vec<String> {
    material_color_maps(p, None)
}

/// Wie [`wall_material_color_maps`]; `only_roof` beschränkt die Dächer auf eines (IFC-Export).
pub fn material_color_maps(p: &Project, only_roof: Option<&str>) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut list = Vec::new();
    let mut consider = |id: &str| {
        if let Some(url) = p.component(id).and_then(|c| c.material.as_ref()).and_then(|m| m.color.as_deref()).filter(|u| !u.is_empty()) {
            if seen.insert(url.to_owned()) {
                list.push(url.to_owned());
            }
        }
    };
    for w in &p.walls {
        if let Some(t) = p.wall_type(w) {
            for l in &t.layers {
                consider(&l.component_id);
            }
        }
    }
    for c in p.ceilings.as_deref().unwrap_or(&[]) {
        if let Some(layers) = ceiling_layers(p, c) {
            for l in layers {
                consider(&l.component_id);
            }
        }
    }
    for r in p.roofs.as_deref().unwrap_or(&[]).iter().filter(|r| only_roof.is_none_or(|id| r.id == id)) {
        for l in p.roof_layers(r) {
            if !l.component_id.is_empty() {
                consider(&l.component_id);
            }
        }
        for d in r.dormers.as_deref().unwrap_or(&[]) {
            for l in crate::dormer::wall_layers(p, d).iter().chain(crate::dormer::roof_layers(p, r, d).iter()) {
                if !l.component_id.is_empty() {
                    consider(&l.component_id);
                }
            }
        }
    }
    // [115] Freie Körper mit Bauteil (nicht beim Dach-Export).
    if only_roof.is_none() {
        for s in p.extruded_solids.as_deref().unwrap_or(&[]) {
            if let Some(c) = s.component_id.as_deref().filter(|c| !c.is_empty()) {
                consider(c);
            }
        }
    }
    list
}

/// Textur-Ebene (1-basiert) der Farbkarte eines Bauteils (`resolveComponentMaterialLayer`).
pub(super) fn material_layer(p: &Project, maps: &[String], component_id: &str) -> Option<f64> {
    let url = p.component(component_id)?.material.as_ref()?.color.as_deref().filter(|u| !u.is_empty())?;
    maps.iter().position(|m| m == url).map(|i| (i + 1) as f64)
}

pub(super) struct WallBand {
    pub(super) thickness: f64,
    pub(super) color: Rgb,
    hatch: Option<style::RHatch>,
    material_index: Option<f64>,
    priority: Option<f64>,
    component_id: Option<String>,
    cut_line_color: Option<Rgb>,
    cut_line_weight: Option<f64>,
}

const SECTION_WALL_AXIS_ANGLE_DEG: f64 = 90.0;

fn plain_band(thickness: f64) -> WallBand {
    WallBand { thickness, color: WALL_RGB, hatch: None, material_index: None, priority: None, component_id: None, cut_line_color: None, cut_line_weight: None }
}

/// Schichtstapel EINER Wand als Bänder (`resolveWallBands`); `stacked` = Lagen einzeln gestapelt.
pub(super) fn resolve_wall_bands(p: &Project, maps: &[String], wall: &Wall, layered: bool) -> (Vec<WallBand>, bool) {
    let fallback = || (vec![plain_band(0.2)], false);
    let Some(wt) = p.wall_type(wall) else { return fallback() };
    if wt.layers.is_empty() {
        return (vec![plain_band(Project::type_thickness(&wt.layers))], false);
    }
    if !layered {
        let total = Project::type_thickness(&wt.layers);
        let dominant = dominant_layer(&wt.layers).expect("nicht leer");
        return (
            vec![WallBand {
                thickness: total,
                color: dominant_layer_color(p, &wt.layers, WALL_RGB),
                hatch: dominant_layer_hatch(p, &wt.layers, Some(SECTION_WALL_AXIS_ANGLE_DEG)),
                material_index: material_layer(p, maps, &dominant.component_id),
                ..plain_band(0.0)
            }],
            false,
        );
    }
    let mut bands = Vec::with_capacity(wt.layers.len());
    for l in &wt.layers {
        let Some(comp) = p.component(&l.component_id) else { return fallback() };
        let line = resolve_cut_line_style(p, l);
        bands.push(WallBand {
            thickness: l.thickness,
            color: hex_to_rgb(&comp.color, WALL_RGB),
            hatch: resolve_component_hatch(p, &l.component_id, Some(SECTION_WALL_AXIS_ANGLE_DEG)),
            material_index: material_layer(p, maps, &l.component_id),
            priority: Some(comp.join_priority),
            component_id: Some(comp.id.clone()),
            cut_line_color: line.0,
            cut_line_weight: line.1,
        });
    }
    (bands, true)
}

fn band_cut_meta(b: &WallBand) -> Option<RCutMeta> {
    if b.priority.is_none() && b.component_id.is_none() && b.cut_line_color.is_none() && b.cut_line_weight.is_none() {
        return None;
    }
    Some(RCutMeta { join_priority: b.priority, component_id: b.component_id.clone(), line_color: b.cut_line_color, line_weight: b.cut_line_weight })
}

fn with_top_angle(mut h: style::RHatch, dx: f64, dy: f64) -> style::RHatch {
    let wall_angle = (atan2(dy, dx) * 180.0) / std::f64::consts::PI;
    let svg_angle = if h.relative_to_wall { h.base_angle - wall_angle } else { h.base_angle };
    let quarter = if h.pattern == 2.0 || h.pattern == 3.0 { 90.0 } else { 0.0 };
    h.top_angle = Some(-svg_angle + quarter);
    h
}

fn kv(v: Vec2) -> KVec {
    KVec::new(v.x, v.y)
}

pub(crate) fn wall_reference(w: &Wall) -> Reference {
    match (w.reference_offset, w.reference_line) {
        (Some(v), _) => Reference::Offset(v),
        (None, Some(WallReferenceLine::Left)) => Reference::Left,
        (None, Some(WallReferenceLine::Right)) => Reference::Right,
        _ => Reference::Center,
    }
}

pub(super) fn wall_ref(p: &Project, w: &Wall) -> WallRef {
    let total = p.wall_thickness(w, 0.2);
    // Bogenwand ([T2]): abgewickelt (Achsmass = Bogenlänge).
    if let Some((_, v)) = crate::wall_arc::unrolled_wall(w) {
        return WallRef { start: opening_geom::v(v.start.x, v.start.y), end: opening_geom::v(v.end.x, v.end.y), total, ref_off: joins::reference_offset(wall_reference(w), total) };
    }
    WallRef { start: opening_geom::v(w.start.x, w.start.y), end: opening_geom::v(w.end.x, w.end.y), total, ref_off: joins::reference_offset(wall_reference(w), total) }
}

/// Öffnungs-Intervall und vertikale Lage aller Öffnungen einer Wand.
fn wall_openings(p: &Project, w: &Wall, openings: &[&Opening], with_recess: bool) -> Vec<OpeningIn> {
    let wr = wall_ref(p, w);
    let (zb, zt) = p.wall_vertical_extent(w);
    let mut out = Vec::new();
    for &o in openings {
        let Some((from, to)) = opening_geom::opening_interval(&wr, o.position, o.width) else { continue };
        let o_bottom = zb + o.sill_height.max(0.0);
        let o_top = zt.min(o_bottom + o.height);
        let recess = with_recess && o.kind == ElementKind::Window && p.window_type(o).and_then(|t| t.inner_layer_recess) == Some(true);
        out.push(OpeningIn { from, to, z_bottom: o_bottom, z_top: o_top, recess_inner_layer: recess });
    }
    out
}

/// Schichteinzug der Öffnungen einer Wand für die Schichtbänder ([106]); Intervall und Höhe wie
/// [`wall_openings`], damit `wall_bands` sie zuordnet.
fn wall_reveals(p: &Project, w: &Wall, openings: &[&Opening], n_bands: usize) -> Vec<wall_bands::RevealIn> {
    let (zb, zt) = p.wall_vertical_extent(w);
    let mut out = Vec::new();
    for &o in openings {
        let Some(r) = crate::opening_detail::opening_reveal(p, w, o) else { continue };
        if r.thick.len() != n_bands {
            continue;
        }
        let o_bottom = zb + o.sill_height.max(0.0);
        let o_top = zt.min(o_bottom + o.height);
        let mut shifts = vec![[0.0; 4]; n_bands];
        let mut pieces = Vec::new();
        for (k, side) in r.sides.iter().enumerate() {
            for a in side {
                shifts[a.layer][k] = a.shift;
                // Formöffnung ([G3]): Zusatzstücke laufen dem Umriss entlang (`shaped_wall_fill`).
                for pc in a.pieces.iter().filter(|_| !crate::opening_shape::is_shaped(o)) {
                    pieces.push((a.layer, k, *pc));
                }
            }
        }
        out.push(wall_bands::RevealIn { from: r.from, to: r.to, z_bottom: o_bottom, z_top: o_top, shifts, pieces });
    }
    out
}

/// Verschneidung je Geschoss (`computeJoinsByFloor`); Fehler = unbekannter Wandtyp/Bauteil.
fn compute_joins_by_floor(p: &Project) -> Result<HashMap<String, WallCuts>, String> {
    let mut merged = HashMap::new();
    for (_, idx) in floor_groups(p) {
        let (jw, finite) = floor_join_input(p, &idx);
        let mut cuts = floor_join_cuts(&jw, finite);
        trim_at_columns(p, &idx, &mut cuts);
        for (&i, c) in idx.iter().zip(cuts) {
            merged.insert(p.walls[i].id.clone(), c);
        }
    }
    Ok(merged)
}

/// [141] Wand endet in einer Stütze desselben Geschosses (wie im Grundriss, `plan::wall_columns`):
/// Stütze prioritärer oder gleiches Bauteil → das Wandende folgt der Stützenkontur. Nur wenn die Stütze
/// die ganze Wandhöhe deckt (sonst bliebe über/unter ihr eine Lücke); die prioritärere Wand beschneidet
/// umgekehrt die Stütze ([`column_pieces`]).
pub(crate) fn trim_at_columns(p: &Project, idx: &[usize], cuts: &mut [WallCuts]) {
    let Some(&first) = idx.first() else { return };
    let floor = p.walls[first].floor_id.as_str();
    let cols: Vec<(&Column, Vec<Vec2>, (f64, f64))> = p
        .columns
        .as_deref()
        .unwrap_or(&[])
        .iter()
        .filter(|c| c.floor_id == floor && c.height > 0.0)
        .map(|c| (c, column_footprint(c), p.column_vertical_extent(c)))
        .collect();
    if cols.is_empty() {
        return;
    }
    for (k, &i) in idx.iter().enumerate() {
        let w = &p.walls[i];
        if cuts[k].covered {
            continue;
        }
        let (wb, wt) = p.wall_vertical_extent(w);
        let cover: Vec<(&Column, Vec<Vec2>)> = cols.iter().filter(|c| c.2 .0 <= wb + 1e-6 && c.2 .1 >= wt - 1e-6).map(|c| (c.0, c.1.clone())).collect();
        if !cover.is_empty() {
            crate::plan::wall_columns::trim_walls_at_columns(p, &[w], &cover, &mut cuts[k..k + 1]);
        }
        // [141] Überlappende prioritärere Stützen (auch kürzer als die Wand, rund, Wand hindurch oder breiter):
        // aus den Wandkörpern aussparen ([`carve_at_columns`]).
        let band = wall_band_bbox(p, w);
        cuts[k].column_carves = cols
            .iter()
            .filter(|c| c.2 .1 - c.2 .0 > 1e-6 && c.2 .1.min(wt) - c.2 .0.max(wb) > 1e-6)
            .filter(|c| bbox_overlap(band, bbox_of(c.1.iter().map(|v| [v.x, v.y]))))
            .filter(|c| crate::plan::wall_columns::relation(p, w, c.0) != crate::plan::wall_columns::Rel::Wall)
            .map(|c| (c.1.iter().map(|v| KVec::new(v.x, v.y)).collect(), [c.2 .0, c.2 .1]))
            .collect();
    }
}

type BBox = [f64; 4];

fn bbox_of(pts: impl Iterator<Item = [f64; 2]>) -> BBox {
    pts.fold([f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY], |b, q| [b[0].min(q[0]), b[1].min(q[1]), b[2].max(q[0]), b[3].max(q[1])])
}

fn bbox_overlap(a: BBox, b: BBox) -> bool {
    a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3]
}

/// Ausmass des Wandbands (ganze Dicke, gerade Wand bzw. Sehnen-Teilwände einer Bogenwand).
fn wall_band_bbox(p: &Project, w: &Wall) -> BBox {
    let total = p.wall_thickness(w, 0.2);
    let ro = joins::reference_offset(wall_reference(w), total);
    let polys = crate::plan::wall_columns::band_polys(w, ro - total / 2.0, ro + total / 2.0, true);
    bbox_of(polys.iter().flatten().map(|v| [v.x, v.y]))
}

/// [141] Wandkörper `pieces` um prioritärere Stützen (`WallCuts::column_carves`, konvexe Kontur und
/// Höhenbereich) aussparen. Ein Körper, den die Kontur trifft, wird im Höhenbereich der Stütze (darunter und
/// darüber bleibt er ganz) quer zur Dicke in Streifen geteilt — Grenzen an den Ecken der Kontur, die in der
/// Dicke liegen —, so dass in jedem Streifen genau eine Konturkante ein- und eine austritt; der Streifen endet
/// an ihr (Schnittlinie = Konturkante) bzw. beginnt hinter ihr. Exakt für Rechteck- und runde Stützen (Kontur
/// als 32-Eck wie der Stützenkörper); Löcher (Öffnungen) bleiben am Körper.
pub(crate) fn carve_at_columns(pieces: &mut Vec<RWall>, from: usize, carves: &[(Vec<KVec>, [f64; 2])]) {
    for (outline, [z0, z1]) in carves {
        if outline.len() < 3 {
            continue;
        }
        let tail = pieces.split_off(from);
        for q in tail {
            carve_piece(q, outline, *z0, *z1, pieces);
        }
    }
}

/// Achsmass (ab `origin`) des Schnitts der Geraden `origin + n·m + u·t` mit der Schnittlinie `cut`
/// (`[px, py, dx, dy]`), `None` ohne Schnitt oder weiter als `reach` weg.
fn along_cut(origin: [f64; 2], u: [f64; 2], n: [f64; 2], m: f64, cut: Option<[f64; 4]>, reach: f64) -> Option<f64> {
    let [cx, cy, ex, ey] = cut?;
    let q = [origin[0] + n[0] * m, origin[1] + n[1] * m];
    let den = u[0] * ey - u[1] * ex;
    if den.abs() < 1e-12 {
        return None;
    }
    let t = ((cx - q[0]) * ey - (cy - q[1]) * ex) / den;
    (t.is_finite() && t.abs() < reach).then_some(t)
}

fn carve_piece(q: RWall, outline: &[KVec], z0: f64, z1: f64, out: &mut Vec<RWall>) {
    const EPS: f64 = 1e-7;
    let (dx, dy) = (q.end[0] - q.start[0], q.end[1] - q.start[1]);
    let l = hypot2(dx, dy);
    let (qb, qt) = (q.base_elevation, q.base_elevation + q.height);
    if !(l > 1e-9) || !(q.thickness > 0.0) || z1 <= qb + EPS || z0 >= qt - EPS {
        out.push(q);
        return;
    }
    let u = [dx / l, dy / l];
    let n = [-u[1], u[0]];
    let h = q.thickness / 2.0;
    // Kontur im Körper-Rahmen (Achsmass s ab Anfang, Querversatz m).
    let loc: Vec<[f64; 2]> = outline.iter().map(|c| {
        let r = [c.x - q.start[0], c.y - q.start[1]];
        [r[0] * u[0] + r[1] * u[1], r[0] * n[0] + r[1] * n[1]]
    }).collect();
    if loc.iter().all(|c| c[1] >= h - EPS) || loc.iter().all(|c| c[1] <= -h + EPS) {
        out.push(q);
        return;
    }
    // Ein- und Austritt der Kontur auf der Querlinie m: (s, Kantenindex).
    let span = |m: f64| -> Option<((f64, usize), (f64, usize))> {
        let k = loc.len();
        let (mut lo, mut hi): (Option<(f64, usize)>, Option<(f64, usize)>) = (None, None);
        for i in 0..k {
            let (a, b) = (loc[i], loc[(i + 1) % k]);
            if (a[1] - m) * (b[1] - m) > 0.0 || (a[1] - b[1]).abs() < 1e-15 {
                continue;
            }
            let s = a[0] + (b[0] - a[0]) * (m - a[1]) / (b[1] - a[1]);
            if lo.is_none_or(|x| s < x.0) {
                lo = Some((s, i));
            }
            if hi.is_none_or(|x| s > x.0) {
                hi = Some((s, i));
            }
        }
        lo.zip(hi).filter(|(a, b)| b.0 - a.0 > EPS)
    };
    let edge = |i: usize| -> [f64; 4] {
        let k = outline.len();
        let (a, b) = (outline[i], outline[(i + 1) % k]);
        [a.x, a.y, b.x - a.x, b.y - a.y]
    };
    let mut ms: Vec<f64> = vec![-h, h];
    ms.extend(loc.iter().map(|c| c[1]).filter(|m| *m > -h + EPS && *m < h - EPS));
    ms.sort_by(f64::total_cmp);
    ms.dedup_by(|a, b| (*a - *b).abs() <= EPS);
    // Querstreifen, von der Kontur getroffen: (m_a, m_b, Eintritt (s, Kante), Austritt (s, Kante)).
    let mut hit: Vec<(f64, f64, Option<((f64, usize), (f64, usize))>)> = Vec::new();
    for w in ms.windows(2) {
        let (ma, mb) = (w[0], w[1]);
        if mb - ma <= EPS {
            continue;
        }
        let mm = (ma + mb) / 2.0;
        let us = along_cut(q.start, u, n, mm, q.start_cut, l).unwrap_or(0.0);
        let ue = l + along_cut(q.end, u, n, mm, q.end_cut, l).unwrap_or(0.0);
        hit.push((ma, mb, span(mm).filter(|((sa, _), (sb, _))| *sb > us + EPS && *sa < ue - EPS)));
    }
    if hit.iter().all(|s| s.2.is_none()) {
        out.push(q);
        return;
    }
    // Entlang nur im Bereich der Kontur teilen: davor und dahinter bleibt der Körper ganz (Teilfuge
    // rechtwinklig, `joint` — in der Ansicht keine Kante), sonst entstünden Nähte über die ganze Wand.
    let perp = |s: f64| Some([q.start[0] + u[0] * s, q.start[1] + u[1] * s, n[0], n[1]]);
    let face_u = |cut: Option<[f64; 4]>, from: [f64; 2], base: f64| [-h, h].map(|m| base + along_cut(from, u, n, m, cut, l).unwrap_or(0.0));
    let (us_f, ue_f) = (face_u(q.start_cut, q.start, 0.0), face_u(q.end_cut, q.end, l));
    // Achsmass der Konturkante `i` auf der Querlinie m (Kante innerhalb des Streifens linear).
    let s_on = |i: usize, m: f64| {
        let (a, b) = (loc[i], loc[(i + 1) % loc.len()]);
        if (b[1] - a[1]).abs() < 1e-15 { a[0].min(b[0]) } else { a[0] + (b[0] - a[0]) * (m - a[1]) / (b[1] - a[1]) }
    };
    let s_lo = hit.iter().filter_map(|s| s.2.map(|e| s_on(e.0 .1, s.0).min(s_on(e.0 .1, s.1)))).fold(f64::INFINITY, f64::min);
    let s_hi = hit.iter().filter_map(|s| s.2.map(|e| s_on(e.1 .1, s.0).max(s_on(e.1 .1, s.1)))).fold(f64::NEG_INFINITY, f64::max);
    let lo = (s_lo > us_f[0].max(us_f[1]) + 1e-4).then_some(s_lo);
    let hi = (s_hi < ue_f[0].min(ue_f[1]) - 1e-4).then_some(s_hi);
    let mut mid = q.clone();
    if let Some(s) = lo {
        let mut a = q.clone();
        a.end_cut = perp(s);
        a.joint[1] = true;
        out.push(a);
        mid.start_cut = perp(s);
        mid.joint[0] = true;
    }
    if let Some(s) = hi {
        let mut c = q.clone();
        c.start_cut = perp(s);
        c.joint[0] = true;
        out.push(c);
        mid.end_cut = perp(s);
        mid.joint[1] = true;
    }
    // Höhenteilung der getroffenen Streifen: unter und über der Stütze bleibt der Streifen ganz.
    let part = |src: &RWall, zb: f64, zt: f64| -> Option<RWall> {
        if zt - zb <= EPS {
            return None;
        }
        let mut r = src.clone();
        r.base_elevation = zb;
        r.height = zt - zb;
        if let Some(d) = r.top_drop {
            // Oberkante am Anfang/Ende `qt − d`: über dem neuen Deckel entfällt die Absenkung.
            let cut = qt - zt;
            let nd = [(d[0] - cut).max(0.0), (d[1] - cut).max(0.0)];
            r.top_drop = (nd[0] > wall_bands::EPS || nd[1] > wall_bands::EPS).then_some(nd);
        }
        let holes: Vec<RHole> = src.holes.as_deref().unwrap_or(&[]).iter().filter_map(|k| {
            let (hb, ht) = (k.z_bottom.max(zb), k.z_top.min(zt));
            (ht - hb > EPS).then(|| RHole { z_bottom: hb, z_top: ht, ..k.clone() })
        }).collect();
        r.holes = (!holes.is_empty()).then_some(holes);
        refit_sloped_top(&mut r);
        (r.height > EPS).then_some(r)
    };
    let strip = |ma: f64, mb: f64, sc: Option<[f64; 4]>, ec: Option<[f64; 4]>, j: [bool; 2]| -> RWall {
        let sh = (ma + mb) / 2.0;
        let mut r = mid.clone();
        r.start = [mid.start[0] + n[0] * sh, mid.start[1] + n[1] * sh];
        r.end = [mid.end[0] + n[0] * sh, mid.end[1] + n[1] * sh];
        r.thickness = mb - ma;
        r.start_cut = sc;
        r.end_cut = ec;
        r.joint = j;
        if let Some(t) = &mut r.top_plane {
            t[0] += t[1] * n[0] * sh + t[2] * n[1] * sh;
        }
        refit_sloped_top(&mut r);
        r
    };
    let (zm0, zm1) = (z0.max(qb), z1.min(qt));
    for (ma, mb, e) in hit {
        let whole = strip(ma, mb, mid.start_cut, mid.end_cut, mid.joint);
        let Some(((sa, ea), (sb, eb))) = e else {
            out.push(whole);
            continue;
        };
        out.extend(part(&whole, qb, zm0));
        let mm = (ma + mb) / 2.0;
        let us = along_cut(mid.start, u, n, mm, mid.start_cut, l).unwrap_or(0.0);
        let ue = l + along_cut(mid.end, u, n, mm, mid.end_cut, l).unwrap_or(0.0);
        if sa > us + EPS {
            out.extend(part(&strip(ma, mb, mid.start_cut, Some(edge(ea)), [mid.joint[0], false]), zm0, zm1));
        }
        if sb < ue - EPS {
            out.extend(part(&strip(ma, mb, Some(edge(eb)), mid.end_cut, [false, mid.joint[1]]), zm0, zm1));
        }
        out.extend(part(&whole, zm1, qt));
    }
}

/// Schnitt-/Ansichts-Eingabe (ungeschichtet): von der Verschneidung nur, was den Körper ändert, ohne
/// Gehrungen (die vereinigt der Schnitt selbst) — verdeckte Wand, kollineare Stossfuge, Ende an einer
/// Stütze ([141]).
pub(crate) fn section_cuts(c: &WallCuts) -> WallCuts {
    WallCuts {
        covered: c.covered,
        collinear: c.collinear,
        at_column: c.at_column,
        start_cut: c.start_cut.filter(|_| c.collinear[0] || c.at_column[0]),
        end_cut: c.end_cut.filter(|_| c.collinear[1] || c.at_column[1]),
        column_carves: c.column_carves.clone(),
        ..Default::default()
    }
}

/// Wände je Geschoss (Positionen in `p.walls`), Geschosse in der Reihenfolge ihres ersten Auftretens.
pub(crate) fn floor_groups(p: &Project) -> Vec<(&str, Vec<usize>)> {
    let mut groups: Vec<(&str, Vec<usize>)> = Vec::new();
    let mut at: HashMap<&str, usize> = HashMap::new();
    for (i, w) in p.walls.iter().enumerate() {
        match at.get(w.floor_id.as_str()) {
            Some(&g) => groups[g].1.push(i),
            None => {
                at.insert(w.floor_id.as_str(), groups.len());
                groups.push((w.floor_id.as_str(), vec![i]));
            }
        }
    }
    groups
}

/// Eingabe der Verschneidung eines Geschosses (Wände `idx`) und ob sie endlich ist.
pub(crate) fn floor_join_input(p: &Project, idx: &[usize]) -> (Vec<JoinWall>, bool) {
    let mut comp_index: HashMap<&str, u32> = HashMap::new();
    let mut jw: Vec<JoinWall> = Vec::with_capacity(idx.len());
    let mut finite = true;
    for &i in idx {
        let w = &p.walls[i];
        // Hängende Wandtypen/Bauteile (Datei/Import) verschneiden mit den Rückfall-Werten.
        let layers = Some(
            p.wall_type_or_fallback(w)
                .layers
                .iter()
                .map(|l| {
                    let comp = p.component_or_fallback(&l.component_id);
                    let n = comp_index.len() as u32;
                    let idx = *comp_index.entry(comp.id.as_str()).or_insert(n);
                    JoinLayer { thickness: l.thickness, component: Some(idx), priority: comp.join_priority }
                })
                .collect::<Vec<_>>(),
        );
        let reference = wall_reference(w);
        finite &= [w.start.x, w.start.y, w.end.x, w.end.y].iter().all(|v| v.is_finite())
            && !matches!(reference, Reference::Offset(v) if !v.is_finite())
            && layers.as_ref().is_none_or(|l| l.iter().all(|x| x.thickness.is_finite()));
        jw.push(JoinWall { start: kv(w.start), end: kv(w.end), reference, layers, bulge: w.bulge });
    }
    (jw, finite)
}

/// Schnittlinien je Wand eines Geschosses (gleich lang wie `jw`); nicht endlich oder Fehler = ohne.
pub(crate) fn floor_join_cuts(jw: &[JoinWall], finite: bool) -> Vec<WallCuts> {
    if !finite {
        return vec![WallCuts::default(); jw.len()];
    }
    // Mit den Rückfällen oben nicht mehr erwartet: dann eben ohne Verschneidung.
    joins::compute_joins(jw).unwrap_or_else(|_| vec![WallCuts::default(); jw.len()])
}

pub(crate) fn floor_context(p: &Project, floor_id: &str, with_ceilings: bool) -> FloorContext {
    floor_context_with(p, floor_id, with_ceilings, None)
}

/// Wie [`floor_context`]; `joins`: schon gerechnete Schnittlinien je Wand-id (für den Deckenrand [178]).
pub(crate) fn floor_context_with(p: &Project, floor_id: &str, with_ceilings: bool, joins: Option<&HashMap<String, WallCuts>>) -> FloorContext {
    let only = |c: &Ceiling| with_ceilings && c.floor_id == floor_id && c.outline.len() >= 3;
    // [178] Platte bis Aussenkante Kern: die Aussenschicht-Bänder der Aussenwand liegen ausserhalb und laufen durch.
    let bearing = if with_ceilings { super::bearing::bearing_outlines(p, only, joins) } else { Vec::new() };
    let ceilings: Vec<CeilingIn> = p
        .ceilings
        .as_deref()
        .unwrap_or(&[])
        .iter()
        .enumerate()
        .filter(|(_, c)| only(c))
        .flat_map(|(ci, c)| {
            let (z_bottom, z_top) = p.ceiling_vertical_extent(c);
            let layers: Option<Vec<(f64, Option<f64>)>> = ceiling_layers(p, c).map(|ls| ls.iter().map(|l| (l.thickness, p.component(&l.component_id).map(|k| k.join_priority))).collect());
            let outlines: Vec<Vec<KVec>> = match bearing.get(ci).cloned().flatten() {
                Some(polys) => polys.iter().map(|poly| poly[0].iter().map(|q| KVec::new(q[0], q[1])).collect()).collect(),
                None => vec![c.ring().iter().map(|v| kv(*v)).collect()],
            };
            outlines.into_iter().map(move |outline| CeilingIn { z_bottom, z_top, outline, layers: layers.clone() })
        })
        .collect();
    let roofs: Vec<RoofIn> = p
        .roofs
        .as_deref()
        .unwrap_or(&[])
        .iter()
        .filter(|r| r.floor_id == floor_id)
        .map(|r| {
            let eaves_z = p.roof_base_elevation(r);
            let geo = crate::roof::roof_geometry(&r.params(), eaves_z);
            let total: f64 = p.roof_layers(r).iter().fold(0.0, |s, l| s + l.thickness.max(0.0));
            let mut ri = RoofIn::new(eaves_z, total, geo.eaves, geo.planes);
            // Gauben ([G2]): unter dem Gaubeninneren endet die Wand an der Gaubendach-Unterkante.
            for d in r.dormers.as_deref().unwrap_or(&[]) {
                if let Some(g) = crate::dormer::geometry(p, r, d) {
                    ri.facets.extend(g.under_facets());
                }
            }
            ri
        })
        .collect();
    FloorContext::new(ceilings, roofs)
}

/// Liegt der Achspunkt `p` eines Bogen-Teilkörpers an einer inneren Stossfuge (nicht an Anfang, Ende
/// oder einer Laibung)?
fn inner_joint(a: &crate::wall_arc::WallArc, _w: &Wall, keep: &[f64], p: KVec) -> bool {
    let (s, _) = a.local(p);
    keep.iter().all(|k| (s - k).abs() > 0.01)
}

/// Wandkörper (`projectToWalls3d`): `layered` = ein Körper je Schicht mit Löchern (3D-Viewer),
/// sonst Pfeiler/Brüstung/Sturz-Segmente (Schnitt-Eingabe).
pub fn emit_walls(p: &Project, layered: bool) -> Result<Vec<RWall>, String> {
    emit_walls_with(p, layered, true)
}

/// Wie [`emit_walls`]; `pockets = false` lässt die Taschen der Taschen-Schiebetüren im Körper ([95]) —
/// für Schnitt/Ansicht, die die Wand nach Schichten aufteilen und die Tasche selbst aussparen.
pub fn emit_walls_with(p: &Project, layered: bool, pockets: bool) -> Result<Vec<RWall>, String> {
    let joins = compute_joins_by_floor(p)?;
    let maps = wall_material_color_maps(p);
    let mut contexts: HashMap<&str, FloorContext> = HashMap::new();
    let mut out = Vec::new();
    let by_wall = p.openings_by_wall();
    for wall in &p.walls {
        // Schnitt-Eingabe: nur die Dächer ([G2]); Decken rechnet der Schnitt selbst (Dominanz).
        let ctx = contexts.entry(wall.floor_id.as_str()).or_insert_with(|| floor_context_with(p, &wall.floor_id, layered, Some(&joins)));
        let openings = by_wall.get(wall.id.as_str()).map_or(&[][..], |v| v.as_slice());
        let cuts = joins.get(&wall.id).map_or_else(WallCuts::default, |c| if layered { c.clone() } else { section_cuts(c) });
        wall_pieces(p, &maps, wall, ctx, openings, cuts, layered, pockets, &mut out);
    }
    Ok(out)
}

/// Die Körper EINER Wand (Schleifenrumpf von [`emit_walls_with`], hinten an `out` angehängt): hängt nur
/// von der Wand, ihren Öffnungen, ihren Schnittlinien `cuts` (Verschneidung mit den Nachbarn), dem
/// Geschoss-Kontext und den Typen/Materialien/Geschossen ab — der 3D-Cache ([58], `model3d_cache.rs`)
/// behält das Ergebnis je Wand.
#[allow(clippy::too_many_arguments)]
pub(crate) fn wall_pieces(p: &Project, maps: &[String], wall: &Wall, ctx: &FloorContext, openings: &[&Opening], cuts: WallCuts, layered: bool, pockets: bool, out: &mut Vec<RWall>) {
    // [141] Ganz in einer kollinearen Wand gleichen Typs: deren Körper zeigt sie mit (nicht doppelt).
    if cuts.covered {
        return;
    }
    let carves = cuts.column_carves.clone();
    let carve_from = out.len();
    {
        let (bands, stacked) = resolve_wall_bands(p, maps, wall, layered);
        let (z_bottom, z_top) = p.wall_vertical_extent(wall);
        let win = wall_bands::WallIn {
            start: kv(wall.start),
            end: kv(wall.end),
            z_bottom,
            z_top,
            layered,
            stacked,
            reference: wall_reference(wall),
            thickness_safe: p.wall_thickness(wall, 0.2),
            termination: match wall.slice_termination {
                Some(SliceTermination::Below) => Termination::Below,
                Some(SliceTermination::Above) => Termination::Above,
                _ => Termination::Both,
            },
            bands: bands.iter().map(|b| BandIn { thickness: b.thickness, priority: b.priority }).collect(),
            openings: wall_openings(p, wall, openings, true),
            cuts,
            roof_attach: wall.roof_attach,
            reveals: if layered && stacked { wall_reveals(p, wall, openings, bands.len()) } else { Vec::new() },
        };
        // Bogenwand ([T2]): Sehnen-Teilwände mit radialen Gehrungen.
        let arc = crate::wall_arc::WallArc::of_wall(wall);
        // Echte Enden der Bogenwand: Anfang, Ende, Laibungen.
        let keep: Vec<f64> = match arc {
            Some(a) => [0.0, a.length()].into_iter().chain(win.openings.iter().flat_map(|o| [o.from, o.to])).collect(),
            None => Vec::new(),
        };
        let wins = match arc {
            Some(a) => crate::wall_arc::chord_walls(&win, &a),
            None => vec![win],
        };
        let first_piece = out.len();
        // [95] Taschen (Achsmass; bei Bogenwänden = Bogenlänge, je Sehnen-Teilwand abgebildet).
        let pocket_cuts = if pockets { wall_pocket_cuts(p, wall, openings) } else { Vec::new() };
        for win in &wins {
        let win_first = out.len();
        let (dx, dy) = (win.end.x - win.start.x, win.end.y - win.start.y);
        for mut piece in wall_bands::wall_bands(win, ctx) {
            let Some(b) = bands.get(piece.band) else { continue };
            // Schnitt-Eingabe der Bogen-Teilwände: radiale Gehrungen auch ohne Schichtband-Pfad.
            if arc.is_some() && !layered {
                piece.start_cut = piece.start_cut.or(win.cuts.start_cut);
                piece.end_cut = piece.end_cut.or(win.cuts.end_cut);
            }
            out.push(RWall {
                start: [piece.start.x, piece.start.y],
                end: [piece.end.x, piece.end.y],
                thickness: piece.thickness.unwrap_or(b.thickness),
                height: piece.z_top - piece.z_bottom,
                base_elevation: piece.z_bottom,
                top_drop: piece.top_drop,
                top_plane: piece.top_plane.map(|c| [c[0] + c[1] * piece.start.x + c[2] * piece.start.y, c[1], c[2]]),
                color: b.color,
                layers: vec![],
                wall_id: wall.id.clone(),
                holes: (!piece.holes.is_empty()).then(|| piece.holes.iter().map(|h| RHole { from: h[0], to: h[1], z_bottom: h[2], z_top: h[3] }).collect()),
                hatch: b.hatch.clone().map(|h| with_top_angle(h, dx, dy)),
                material_index: b.material_index,
                cut: band_cut_meta(b),
                start_cut: piece.start_cut.map(|l| [l.point.x, l.point.y, l.dir.x, l.dir.y]),
                end_cut: piece.end_cut.map(|l| [l.point.x, l.point.y, l.dir.x, l.dir.y]),
                joint: {
                    let j = arc.map_or([false; 2], |a| [inner_joint(&a, wall, &keep, piece.start), inner_joint(&a, wall, &keep, piece.end)]);
                    [j[0] || piece.joint[0], j[1] || piece.joint[1]]
                },
                arc_center: arc.map(|a| [a.center.x, a.center.y]),
            });
        }
        if let (Some(a), false) = (arc, pocket_cuts.is_empty()) {
            // Sehne pa→pb über die Bogenlänge [sa, sb]: Achsmass linear auf die Sehne abgebildet.
            let (sa, sb) = (a.local(win.start).0, a.local(win.end).0);
            let chord = hypot2(dx, dy);
            if (sb - sa).abs() > 1e-9 {
                let m = |u: f64| (u - sa) / (sb - sa) * chord;
                let cuts: Vec<[f64; 6]> = pocket_cuts.iter().map(|c| [m(c[0]), m(c[1]), c[2], c[3], c[4], c[5]]).collect();
                cut_wall_pockets([win.start.x, win.start.y], [dx, dy], &cuts, out, win_first);
            }
        }
        }
        if arc.is_none() && !pocket_cuts.is_empty() {
            cut_wall_pockets([wall.start.x, wall.start.y], [wall.end.x - wall.start.x, wall.end.y - wall.start.y], &pocket_cuts, out, first_piece);
        }
    }
    carve_at_columns(out, carve_from, &carves);
}

/// [95] Taschen der Taschen-Schiebetüren einer Wand: je Tasche `[u0, u1, n0, n1, z0, z1]` im Wandrahmen
/// (Achsmass ab Wandstart, Querversatz zur Achse, absolute Höhen der Öffnung) — Hohlraum samt Blattbahn
/// durch die Öffnung (`Pocket::cut`).
pub(crate) fn wall_pocket_cuts(p: &Project, w: &Wall, openings: &[&Opening]) -> Vec<[f64; 6]> {
    let wr = wall_ref(p, w);
    let (zb, zt) = p.wall_vertical_extent(w);
    let mut out = Vec::new();
    for &o in openings {
        let Some(dt) = p.door_type(o).filter(|t| o.kind == ElementKind::Door && t.kind == DoorTypeKind::Tasche) else { continue };
        let count = crate::jsnum::max(1.0, crate::jsnum::round(dt.leaf_count));
        let hinge_end = o.hinge.is_some_and(|s| s != OpeningHinge::Start);
        let z0 = zb + o.sill_height.max(0.0);
        let z1 = zt.min(z0 + o.height);
        if z1 - z0 <= 1e-6 {
            continue;
        }
        for k in opening_geom::pocket_cavities(&wr, o.position, o.width, hinge_end, count) {
            let (u0, u1, n0, n1) = k.cut();
            out.push([u0, u1, n0, n1, z0, z1]);
        }
    }
    out
}

/// [95] Taschen `cuts` (`[u0, u1, n0, n1, z0, z1]` im Rahmen `origin` + Achsrichtung `dir`: gerade Wand
/// oder Sehnen-Teilwand einer Bogenwand) aus den Wandkörpern `pieces[from..]` ausschneiden: ein Körper,
/// der quer in die Tasche reicht, wird quer geteilt (aussen unverändert); der mittlere Teil entlang der
/// Achse um die Tasche geteilt, über ihr (und unter ihr bei Brüstung) bleibt Wand. Schräge Oberkante
/// (`top_plane`/`top_drop`): die Teile behalten die Dachebene, Höhe und Absenkung neu je Teil.
fn cut_wall_pockets(origin: [f64; 2], dir: [f64; 2], cuts: &[[f64; 6]], pieces: &mut Vec<RWall>, from: usize) {
    if cuts.is_empty() {
        return;
    }
    let l = hypot2(dir[0], dir[1]);
    if !(l > 1e-9) {
        return;
    }
    let (ux, uy) = (dir[0] / l, dir[1] / l);
    let (nx, ny) = (-uy, ux);
    let eps = 1e-6;
    for &c in cuts {
        let [cu0, cu1, cn0, cn1, cz0, cz1] = c;
        let tail = pieces.split_off(from);
        for w in tail {
            let (pdx, pdy) = (w.end[0] - w.start[0], w.end[1] - w.start[1]);
            let len = hypot2(pdx, pdy);
            let rel = [w.start[0] - origin[0], w.start[1] - origin[1]];
            let (ps, pn) = (rel[0] * ux + rel[1] * uy, rel[0] * nx + rel[1] * ny);
            // Nur zur Wand parallele Körper (Laufrichtung wie die Wand).
            let parallel = len > 1e-9 && (pdx * ux + pdy * uy) > len * (1.0 - 1e-9);
            let (a, b) = (pn - w.thickness / 2.0, pn + w.thickness / 2.0);
            let (h0, h1) = (cu0 - ps, cu1 - ps);
            let zt = w.base_elevation + w.height;
            let hit = parallel && a < cn1 - eps && b > cn0 + eps && h0 < len - eps && h1 > eps && w.base_elevation < cz1 - eps && zt > cz0 + eps;
            if !hit {
                pieces.push(w);
                continue;
            }
            // Quer: [a, m0] aussen, [m0, m1] Tasche, [m1, b] aussen.
            let (m0, m1) = (a.max(cn0), b.min(cn1));
            let across = |w: &RWall, lo: f64, hi: f64| -> RWall {
                let sh = (lo + hi) / 2.0 - pn;
                let mut q = w.clone();
                q.start = [w.start[0] + nx * sh, w.start[1] + ny * sh];
                q.end = [w.end[0] + nx * sh, w.end[1] + ny * sh];
                q.thickness = hi - lo;
                if let Some(t) = &mut q.top_plane {
                    t[0] += t[1] * nx * sh + t[2] * ny * sh;
                }
                q
            };
            for (lo, hi) in [(a, m0), (m1, b)] {
                if hi - lo > eps {
                    pieces.push(across(&w, lo, hi));
                }
            }
            let mid = across(&w, m0, m1);
            // Entlang: [0, h0] und [h1, len] voll, [h0, h1] nur über/unter der Tasche.
            let (k0, k1) = (h0.max(0.0), h1.min(len));
            let part = |s: f64, e: f64, z0: f64, z1: f64| -> Option<RWall> {
                if e - s <= eps || z1 - z0 <= eps {
                    return None;
                }
                let mut q = mid.clone();
                q.start = [mid.start[0] + ux * s, mid.start[1] + uy * s];
                q.end = [mid.start[0] + ux * e, mid.start[1] + uy * e];
                q.base_elevation = z0;
                q.height = z1 - z0;
                if s > eps {
                    q.start_cut = None;
                    q.joint[0] = false;
                }
                if e < len - eps {
                    q.end_cut = None;
                    q.joint[1] = false;
                }
                if let Some(t) = &mut q.top_plane {
                    t[0] += t[1] * ux * s + t[2] * uy * s;
                }
                let holes: Vec<RHole> = mid
                    .holes
                    .as_deref()
                    .unwrap_or(&[])
                    .iter()
                    .filter_map(|h| {
                        let (f, t) = (h.from.max(s), h.to.min(e));
                        let (hb, ht) = (h.z_bottom.max(z0), h.z_top.min(z1));
                        (t - f > eps && ht - hb > eps).then(|| RHole { from: f - s, to: t - s, z_bottom: hb, z_top: ht })
                    })
                    .collect();
                q.holes = (!holes.is_empty()).then_some(holes);
                Some(q)
            };
            let z_b = w.base_elevation;
            let below = part(k0, k1, z_b, cz0).map(|mut q| {
                // Unter der Tasche (Brüstung): waagrecht auf Taschen-UK.
                q.top_plane = None;
                q.top_drop = None;
                q
            });
            for mut q in [part(0.0, k0, z_b, zt), part(k0, k1, cz1, zt), below, part(k1, len, z_b, zt)].into_iter().flatten() {
                refit_sloped_top(&mut q);
                if q.height > eps {
                    pieces.push(q);
                }
            }
        }
    }
}

/// Teilkörper mit Dachebene (`top_plane`): Höhe = höchster Eckwert (höchstens die bisherige), Absenkung
/// der Mittellinie an Anfang/Ende (`top_drop`) neu.
fn refit_sloped_top(q: &mut RWall) {
    let Some(c) = q.top_plane else { return };
    let Some(fp) = wall_footprint(q) else { return };
    let at = |x: f64, y: f64| c[0] + c[1] * (x - q.start[0]) + c[2] * (y - q.start[1]);
    let zt = q.base_elevation + q.height;
    let top = fp.iter().map(|p| at(p[0], p[1])).fold(f64::NEG_INFINITY, f64::max).min(zt);
    q.height = top - q.base_elevation;
    let d = [top - at(q.start[0], q.start[1]), top - at(q.end[0], q.end[1])];
    q.top_drop = (d[0] > wall_bands::EPS || d[1] > wall_bands::EPS).then_some(d);
}

/// Grundriss-Ecken eines Wandkörpers an seinen Schnittlinien: Anfang +n, Ende +n, Ende −n, Anfang −n
/// (+n = linke Normale). `None` bei entarteter Achse.
pub(crate) fn wall_footprint(w: &RWall) -> Option<[[f64; 2]; 4]> {
    let (dx, dy) = (w.end[0] - w.start[0], w.end[1] - w.start[1]);
    let l = hypot2(dx, dy);
    if !(l > 1e-9) || !(w.thickness > 0.0) {
        return None;
    }
    let (ux, uy) = (dx / l, dy / l);
    let (nx, ny) = (-uy, ux);
    let h = w.thickness / 2.0;
    let at = |p: [f64; 2], o: f64, cut: Option<[f64; 4]>| -> [f64; 2] {
        let q = [p[0] + nx * o, p[1] + ny * o];
        let Some([cx, cy, ex, ey]) = cut else { return q };
        let den = ux * ey - uy * ex;
        if den.abs() < 1e-12 {
            return q;
        }
        let t = ((cx - q[0]) * ey - (cy - q[1]) * ex) / den;
        if t.is_finite() && t.abs() < l {
            [q[0] + ux * t, q[1] + uy * t]
        } else {
            q
        }
    };
    Some([at(w.start, h, w.start_cut), at(w.end, h, w.end_cut), at(w.end, -h, w.end_cut), at(w.start, -h, w.start_cut)])
}

/// Oberkante eines Wandkörpers an einem Grundriss-Punkt (ebene Oberkante unter einem Dach, [G2]).
pub(crate) fn wall_top_at(w: &RWall, q: [f64; 2]) -> f64 {
    let zt = w.base_elevation + w.height;
    match w.top_plane {
        // Negative Höhe oder NaN: Grenzen vertauscht bzw. ungültig -> ebene Oberkante, kein Panic.
        Some(c) => {
            let z = crate::jsnum::clamp_safe(c[0] + c[1] * (q[0] - w.start[0]) + c[2] * (q[1] - w.start[1]), w.base_elevation, zt);
            if z.is_finite() { z } else { zt }
        }
        None => zt,
    }
}

/// Wandkörper mit ebener Oberkante als geschlossenes Netz (Modell x, y, z), ohne Löcher.
pub(crate) fn wall_piece_mesh(w: &RWall) -> Option<crate::solid_bool::Mesh> {
    let fp = wall_footprint(w)?;
    let zb = w.base_elevation;
    let m = crate::solid_bool::Mesh::prism_between(&fp, &|_, _| zb, &|x, y| wall_top_at(w, [x, y]));
    (!m.is_empty()).then_some(m)
}

/// Volumen eines Wandkörpers ohne Löcher: Grundfläche × Höhe im Schwerpunkt (exakt bei ebener Oberkante).
pub(crate) fn wall_piece_volume(w: &RWall) -> f64 {
    let Some(q) = wall_footprint(w) else { return 0.0 };
    let (mut a, mut cx, mut cy) = (0.0, 0.0, 0.0);
    for i in 0..4 {
        let (p0, p1) = (q[i], q[(i + 1) % 4]);
        let c = p0[0] * p1[1] - p1[0] * p0[1];
        a += c;
        cx += (p0[0] + p1[0]) * c;
        cy += (p0[1] + p1[1]) * c;
    }
    if a.abs() < 1e-15 {
        return 0.0;
    }
    (a / 2.0).abs() * (wall_top_at(w, [cx / (3.0 * a), cy / (3.0 * a)]) - w.base_elevation)
}
