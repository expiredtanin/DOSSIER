//! Netze und Gelände im Schnitt: Ebenenschnitt beliebiger Netze (freie Körper, importierte Netze),
//! Ringe zu Polygonen mit Schlüsselloch, Geländelinie aus Netzen bzw. Höhenlinien und das Erdreich-Band.
//! Aufgerufen von `compute_section()` (`mod.rs`); `rings_to_polygons()` und `keyhole()` auch von der Ansicht.

use super::*;

/// `cutMeshWithPlane` (senkrecht): (Ringe, Linienzüge).
pub(super) fn cut_mesh(positions: &[f64], indices: &[f64], base: (f64, f64), u: (f64, f64)) -> (Vec<Vec<[f64; 2]>>, Vec<Vec<[f64; 2]>>) {
    let f = crate::mesh_section::cut(positions, indices, &[0.0, base.0, base.1, u.0, u.1]);
    if f.is_empty() {
        return (Vec::new(), Vec::new());
    }
    let mut i = 0;
    let rings = read_rings(&f, &mut i);
    let lines = read_rings(&f, &mut i);
    (rings, lines)
}

/// `ringsToPolygons`.
pub(crate) fn rings_to_polygons(rings: &[Vec<[f64; 2]>]) -> Vec<Vec<Vec<[f64; 2]>>> {
    let refs: Vec<&[[f64; 2]]> = rings.iter().map(|r| r.as_slice()).collect();
    let f = crate::mesh_section::rings_to_polygons(&encode_rings(&refs));
    if f.is_empty() {
        return Vec::new();
    }
    let mut out = Vec::new();
    let mut i = 1;
    for _ in 0..f[0] as usize {
        let nr = f[i] as usize;
        i += 1;
        let mut set = Vec::with_capacity(nr);
        for _ in 0..nr {
            let count = f[i] as usize;
            i += 1;
            set.push((0..count).map(|j| [f[i + 2 * j], f[i + 2 * j + 1]]).collect());
            i += 2 * count;
        }
        out.push(set);
    }
    out
}

/// `keyhole` (Rechnung: `voids::keyhole_flat`).
pub(crate) fn keyhole(poly: &[Vec<[f64; 2]>]) -> (Vec<[f64; 2]>, Vec<f64>) {
    let refs: Vec<&[[f64; 2]]> = poly.iter().map(|r| r.as_slice()).collect();
    let f = crate::voids::keyhole_flat(&encode_rings(&refs));
    let n = f.first().copied().unwrap_or(0.0) as usize;
    let pts = (0..n).map(|i| [f[1 + 2 * i], f[2 + 2 * i]]).collect();
    let nb = f.get(1 + 2 * n).copied().unwrap_or(0.0) as usize;
    let bridges = (0..nb).map(|i| f[2 + 2 * n + i]).collect();
    (pts, bridges)
}

/// `appendBodySections` + `attachBodyOwners`: geschnittene freie Körper.
pub(super) fn append_body_sections(cuts: &mut Vec<Cut>, p: &Project, bodies: &[&BodyMesh], base: (f64, f64), u: (f64, f64)) {
    let solids = p.extruded_solids.as_deref().unwrap_or(&[]);
    for b in bodies {
        // [G1] Bauteil des Körpers: Füllung und SIA-Schraffur wie im Grundriss.
        let style = solids.get(b.index).and_then(|s| crate::plan::style::body_component_style(p, s).map(|st| (st, s.component_id.clone())));
        let (rings, _) = cut_mesh(&b.positions, &b.indices, base, u);
        for poly in rings_to_polygons(&rings) {
            let (pts, nse) = if poly.len() > 1 {
                let (pts, bridges) = keyhole(&poly);
                let n = pts.len() as f64;
                (pts, Some(bridges.into_iter().filter(|&i| i < n).collect()))
            } else {
                (poly[0].clone(), None)
            };
            let mut c = Cut::new(Kind::Body, b.index, pts);
            c.fill = Some(BODY_FILL.into());
            if let Some(((fill, hatch), comp)) = &style {
                c.fill = Some(fill.clone());
                c.hatch = Some(hatch.clone());
                c.component_id = comp.clone();
            }
            c.nse = nse;
            c.source_id = solids.get(b.index).map(|s| s.id.clone());
            // [180] Klasse des Körpers (Sichtbarkeit, Darstellungsmodus).
            c.category = solids.get(b.index).map(|s| s.category_code.clone());
            cuts.push(c);
        }
    }
}

/// [152] Tiefenbereich (hinter der Ebene positiv) der Hüllbox eines Netzes zur senkrechten Ebene.
pub(super) fn mesh_depth_range(m: &crate::mesh_view::MeshRef, base: (f64, f64), u: (f64, f64)) -> (f64, f64) {
    let b = &m.info.bbox;
    let (mut lo, mut hi) = (f64::INFINITY, f64::NEG_INFINITY);
    for (x, y) in [(b[0], b[1]), (b[3], b[1]), (b[0], b[4]), (b[3], b[4])] {
        // Abstand wie `mesh_section` (vorn positiv), Tiefe = −Abstand.
        let d = -((x - base.0) * u.1 - (y - base.1) * u.0);
        lo = lo.min(d);
        hi = hi.max(d);
    }
    (lo, hi)
}

/// [152] Importierte Netze, die die Ebene schneiden: Ebenenschnitt (Ringe mit Löchern als Schlüsselloch,
/// Füllung wie freie Körper; ab 1:100 schwarz über die gemeinsamen Regeln), offene Züge als Linien.
pub(super) fn append_mesh_sections(cuts: &mut Vec<Cut>, lines: &mut Vec<(usize, Vec<[f64; 2]>)>, meshes: &[crate::mesh_view::MeshRef], base: (f64, f64), u: (f64, f64)) {
    for (k, m) in meshes.iter().enumerate() {
        let (lo, hi) = mesh_depth_range(m, base, u);
        if !(lo < 0.0 && hi > 0.0) {
            continue;
        }
        let (rings, open) = crate::mesh_view::cut(m, &[0.0, base.0, base.1, u.0, u.1]);
        for poly in rings_to_polygons(&rings) {
            let (pts, nse) = if poly.len() > 1 {
                let (pts, bridges) = keyhole(&poly);
                let n = pts.len() as f64;
                (pts, Some(bridges.into_iter().filter(|&i| i < n).collect()))
            } else {
                (poly[0].clone(), None)
            };
            if pts.len() < 3 || ring_area(&pts).abs() < 1e-10 {
                continue;
            }
            let mut c = Cut::new(Kind::Mesh, k, pts);
            c.fill = Some(BODY_FILL.into());
            c.nse = nse;
            c.source_id = Some(m.mesh.id.clone());
            c.category = Some(m.mesh.category_code.clone());
            cuts.push(c);
        }
        lines.extend(open.into_iter().map(|l| (k, l)));
    }
}

/// [256] Netze auf Umgebungsklassen (Nachbargebäude) nur, wo Gelände ist: Schnittflächen, offene Züge und Kanten
/// enden am Geländeende (u-Bereich der Geländelinie), sonst schweben sie neben dem Gelände. Ohne Geländelinie unverändert.
pub(super) fn clip_context_meshes_to_terrain(out: &mut Output) {
    let (lo, hi) = out.profiles.iter().flat_map(|p| p.pts.iter()).fold((f64::INFINITY, f64::NEG_INFINITY), |(lo, hi), q| (lo.min(q[0]), hi.max(q[0])));
    if !(lo.is_finite() && hi.is_finite() && hi > lo) {
        return;
    }
    let ctx: Vec<bool> = out.meshes.iter().map(|m| m.category.as_deref().is_some_and(crate::import_context::is_context_class)).collect();
    if !ctx.iter().any(|&c| c) {
        return;
    }
    let is_ctx = |k: Kind, i: usize| k == Kind::Mesh && ctx.get(i).copied().unwrap_or(false);
    out.cuts = std::mem::take(&mut out.cuts)
        .into_iter()
        .filter_map(|mut c| {
            if !is_ctx(c.kind, c.index) {
                return Some(c);
            }
            let (pts, nse) = unfold::clip_poly_u(&c.pts, c.nse.as_deref(), lo, hi)?;
            (pts.len() >= 3).then(|| {
                c.pts = pts;
                c.nse = nse;
                c
            })
        })
        .collect();
    out.mesh_lines = std::mem::take(&mut out.mesh_lines)
        .into_iter()
        .flat_map(|(k, pts)| if ctx.get(k).copied().unwrap_or(false) { clip_line_to_u(&pts, lo, hi) } else { vec![pts] }.into_iter().map(move |p| (k, p)))
        .collect();
    let clip_edges = |v: Vec<Edge>| -> Vec<Edge> {
        v.into_iter()
            .filter_map(|mut e| {
                if !is_ctx(e.kind, e.index) {
                    return Some(e);
                }
                let (a, b) = if e.a[0] <= e.b[0] { (e.a, e.b) } else { (e.b, e.a) };
                if b[0] < lo || a[0] > hi {
                    return None;
                }
                let at = |x: f64| if (b[0] - a[0]).abs() < 1e-12 { a } else { [x, a[1] + (b[1] - a[1]) * (x - a[0]) / (b[0] - a[0])] };
                e.a = if a[0] < lo { at(lo) } else { a };
                e.b = if b[0] > hi { at(hi) } else { b };
                Some(e)
            })
            .collect()
    };
    out.visible = clip_edges(std::mem::take(&mut out.visible));
    out.hidden = clip_edges(std::mem::take(&mut out.hidden));
}

/// [152] Oberkante eines Rings (u rechts, Höhe oben): Kanten, über denen aussen liegt — gegen den Uhrzeigersinn die
/// nach links laufenden —, zu Zügen verkettet (von links nach rechts).
fn upper_edge(ring: &[[f64; 2]]) -> Vec<Vec<[f64; 2]>> {
    let n = ring.len();
    if n < 3 {
        return Vec::new();
    }
    let ccw = (0..n).map(|i| ring[i][0] * ring[(i + 1) % n][1] - ring[(i + 1) % n][0] * ring[i][1]).sum::<f64>() > 0.0;
    let r: Vec<[f64; 2]> = if ccw { ring.to_vec() } else { ring.iter().rev().copied().collect() };
    let top = |i: usize| r[(i + 1) % n][0] < r[i][0] - 1e-9;
    // Beginn nach einer Nicht-Oberkante, damit kein Zug über das Ringende zerfällt.
    let Some(start) = (0..n).find(|&i| !top(i)) else { return Vec::new() };
    let mut out: Vec<Vec<[f64; 2]>> = Vec::new();
    let mut cur: Vec<[f64; 2]> = Vec::new();
    for k in 1..=n {
        let i = (start + k) % n;
        if top(i) {
            if cur.is_empty() {
                cur.push(r[i]);
            }
            cur.push(r[(i + 1) % n]);
        } else if cur.len() >= 2 {
            out.push(std::mem::take(&mut cur));
        } else {
            cur.clear();
        }
    }
    if cur.len() >= 2 {
        out.push(cur);
    }
    for l in &mut out {
        l.reverse();
    }
    out
}

/// `clipLineToU`.
pub(super) fn clip_line_to_u(pts: &[[f64; 2]], lo: f64, hi: f64) -> Vec<Vec<[f64; 2]>> {
    let mut out = Vec::new();
    let mut cur: Vec<[f64; 2]> = Vec::new();
    fn flush(cur: &mut Vec<[f64; 2]>, out: &mut Vec<Vec<[f64; 2]>>) {
        if cur.len() >= 2 {
            out.push(std::mem::take(cur));
        }
        cur.clear();
    }
    for i in 0..pts.len().saturating_sub(1) {
        let a = pts[i];
        let b = pts[i + 1];
        let (u0, u1) = (a[0], b[0]);
        if (u0 < lo && u1 < lo) || (u0 > hi && u1 > hi) {
            flush(&mut cur, &mut out);
            continue;
        }
        let at = |u: f64| -> [f64; 2] {
            let t = if u1 == u0 { 0.0 } else { (u - u0) / (u1 - u0) };
            [u, a[1] + (b[1] - a[1]) * t]
        };
        let pa = if u0 < lo { at(lo) } else if u0 > hi { at(hi) } else { a };
        let pb = if u1 < lo { at(lo) } else if u1 > hi { at(hi) } else { b };
        if cur.is_empty() {
            cur.push(pa);
        }
        cur.push(pb);
        if u1 < lo || u1 > hi {
            flush(&mut cur, &mut out);
        }
    }
    flush(&mut cur, &mut out);
    out
}

/// `appendTerrainProfiles`.
/// [152]/[181] Geschlossene Gelände-Netze (z. B. IFC-Gelände als Platte): von ihren Schnittringen nur die Oberkante.
pub(super) fn append_terrain_profiles(out: &mut Output, p: &Project, base: (f64, f64), u: (f64, f64)) {
    let ctx = p.context.as_deref().unwrap_or(&[]);
    let terrains: Vec<&TerrainMesh> = ctx.iter().filter_map(|c| if let ContextObject::TerrainMesh(t) = c { Some(t) } else { None }).collect();
    // [187]/[143] Höhenlinien-Sätze ohne daraus erzeugtes Gelände-Netz (`sourceId`): ihre Schnittpunkte mit der Ebene
    // ergeben die Geländelinie.
    let sets: Vec<&ContourSet> = ctx
        .iter()
        .filter_map(|c| if let ContextObject::ContourSet(s) = c { Some(s) } else { None })
        .filter(|s| !terrains.iter().any(|t| t.source_id.as_deref() == Some(s.id.as_str())))
        .collect();
    if terrains.is_empty() && sets.is_empty() {
        return;
    }
    let (mut lo, mut hi) = (f64::INFINITY, f64::NEG_INFINITY);
    for cp in &out.cuts {
        for q in &cp.pts {
            lo = min(lo, q[0]);
            hi = max(hi, q[0]);
        }
    }
    for e in out.visible.iter().chain(out.hidden.iter()) {
        lo = min(min(lo, e.a[0]), e.b[0]);
        hi = max(max(hi, e.a[0]), e.b[0]);
    }
    let range = lo.is_finite().then_some((lo, hi));
    for t in terrains {
        if t.positions.len() < 9 {
            continue;
        }
        out.terrain_id.get_or_insert_with(|| t.id.clone());
        // [T6] Gelände samt Baugruben, Höhen im Modellbezug; das gewachsene Terrain gestrichelt dazu.
        let st = crate::excavation::site_terrain(p, t);
        let mut meshes: Vec<((Vec<f64>, Vec<f64>), bool)> = vec![(st.current().to_flat(-st.datum), false)];
        if st.modified.is_some() {
            meshes.push((st.orig.to_flat(-st.datum), true));
        }
        // [152]/[181] Geschlossenes Gelände-Netz (z. B. IFC-Gelände als Platte): das rohe Netz schneiden und von den
        // Schnittringen nur die Oberkante nehmen (die Fläche als TIN gelesen hätte Ober- und Unterseite).
        if st.modified.is_none() && is_closed(&t.indices) {
            meshes = vec![((t.positions.chunks(3).flat_map(|q| [q[0], q[1], q[2] - st.datum]).collect(), t.indices.clone()), false)];
        }
        for ((pos, idx), natural) in meshes {
            let (rings, mut lines) = cut_mesh(&pos, &idx, base, u);
            for poly in rings_to_polygons(&rings) {
                lines.extend(upper_edge(&poly[0]));
            }
            for line in lines {
                let parts = match range {
                    Some((lo, hi)) => clip_line_to_u(&line, lo - TERRAIN_MARGIN, hi + TERRAIN_MARGIN),
                    None => vec![line],
                };
                for pts in parts {
                    // [204] Das gewachsene Terrain (gestrichelt) scheint nicht durch die Räume des Gebäudes.
                    let pieces = if natural { outside_building(&pts, &out.cuts) } else { vec![pts] };
                    for pts in pieces {
                        out.profiles.push(Profile { category: Some(t.category_code.clone()), pts, natural });
                    }
                }
            }
        }
    }
    for set in sets {
        let cs = contours_in(set);
        let datum = crate::terrain::datum(p.reference_elevation_masl, &cs.iter().map(|c| c.z).collect::<Vec<_>>());
        let pts: Vec<[f64; 2]> = crate::terrain::contour_crossings(&cs, [base.0, base.1], [u.0, u.1]).into_iter().map(|(s, z, _)| [s, z - datum]).collect();
        if pts.len() < 2 {
            continue;
        }
        out.terrain_id.get_or_insert_with(|| set.id.clone());
        let parts = match range {
            Some((lo, hi)) => clip_line_to_u(&pts, lo - TERRAIN_MARGIN, hi + TERRAIN_MARGIN),
            None => vec![pts],
        };
        for pts in parts {
            out.profiles.push(Profile { category: Some(set.category_code.clone()), pts, natural: false });
        }
    }
    append_shoring(out, p, base, u, range);
    append_earth(out, p, base, u);
}

/// Höhenlinien eines Satzes als Eingabe für `terrain.rs`.
pub(crate) fn contours_in(set: &ContourSet) -> Vec<crate::terrain::ContourIn> {
    set.contours.iter().map(|c| crate::terrain::ContourIn { z: c.z, pts: c.pts.iter().map(|q| [q.x, q.y]).collect(), closed: c.closed }).collect()
}

/// [68] Verbauwände der Baugruben im Schnitt: das Wandband jeder verbauten Sohlkante (Dicke nach aussen) wird mit
/// der Schnittebene geschnitten; oben das gewachsene Gelände, unten Sohle minus Einbindetiefe. Bänder ausserhalb
/// der Schnittweite fallen weg.
fn append_shoring(out: &mut Output, p: &Project, base: (f64, f64), u: (f64, f64), range: Option<(f64, f64)>) {
    let mut done: Vec<String> = Vec::new();
    for t in crate::excavation::terrains(p) {
        if t.positions.len() < 9 {
            continue;
        }
        let st = crate::excavation::site_terrain(p, t);
        let idx = st.index_orig();
        for (id, spec, _) in &st.items {
            if done.contains(id) {
                continue;
            }
            let Some(e) = crate::excavation::excavations(p).into_iter().find(|e| e.id == *id) else { continue };
            let bands = spec.shoring_bands();
            if bands.is_empty() {
                continue;
            }
            done.push(id.clone());
            let hatch_id = crate::excavation::shoring_hatch_id(spec.shore_kind);
            let hatch = crate::plan::style::resolve_hatch(p, hatch_id, None, None, None)
                .unwrap_or(HatchRender { pattern: HatchPattern::Diagonal, scale: 1.0, angle: 45.0, color: HATCH_INK.into(), line_weight: 0.1, ..no_hatch_base() });
            let z_bottom = e.bottom - crate::excavation::shoring_embed(e);
            // [191] Schnitt der Geraden base + s·u mit dem Band-Umriss (gekrümmt bei Bogenkanten): Durchgänge sortiert,
            // je Ein-/Austritt ein Stück.
            let crossings = |poly: &[[f64; 2]], ss: &mut Vec<f64>| {
                for i in 0..poly.len() {
                    let (a, b) = (poly[i], poly[(i + 1) % poly.len()]);
                    let (ex, ey) = (b[0] - a[0], b[1] - a[1]);
                    let den = u.0 * ey - u.1 * ex;
                    if den.abs() < 1e-12 {
                        continue;
                    }
                    let (wx, wy) = (a[0] - base.0, a[1] - base.1);
                    let t_ = (wx * u.1 - wy * u.0) / den;
                    if (0.0..1.0).contains(&t_) {
                        ss.push((wx * ey - wy * ex) / den);
                    }
                }
            };
            let mut spans: Vec<(f64, f64)> = Vec::new();
            for band in &bands {
                let mut ss: Vec<f64> = Vec::new();
                crossings(&band.polygon(), &mut ss);
                if band.closed {
                    // Ringsum verbaut: Aussenkante und Sohlkante begrenzen das Band.
                    crossings(&band.inner, &mut ss);
                }
                ss.sort_by(|a, b| a.total_cmp(b));
                spans.extend(ss.chunks_exact(2).map(|w| (w[0], w[1])));
            }
            for (s0, s1) in spans {
                if s1 - s0 < 1e-6 {
                    continue;
                }
                if let Some((lo, hi)) = range {
                    if s1 < lo - TERRAIN_MARGIN || s0 > hi + TERRAIN_MARGIN {
                        continue;
                    }
                }
                let top = |s: f64| idx.z_at(base.0 + u.0 * s, base.1 + u.1 * s).map(|z| z - st.datum);
                let (Some(z0), Some(z1)) = (top(s0), top(s1)) else { continue };
                if z0.max(z1) <= e.bottom + 1e-3 {
                    continue;
                }
                out.shoring.push(ShoringCut {
                    ring: vec![[s0, z_bottom], [s1, z_bottom], [s1, z1.max(e.bottom)], [s0, z0.max(e.bottom)]],
                    hatch: hatch.clone(),
                    category: e.category_code.clone(),
                    excavation_id: e.id.clone(),
                });
            }
        }
    }
}

/// Geschlossenes Dreiecksnetz: jede Kante gehört zu genau zwei Dreiecken.
fn is_closed(indices: &[f64]) -> bool {
    if indices.len() < 12 {
        return false;
    }
    let mut edges: std::collections::HashMap<(u32, u32), u32> = std::collections::HashMap::new();
    for t in indices.chunks_exact(3) {
        let v = [t[0] as u32, t[1] as u32, t[2] as u32];
        for k in 0..3 {
            let (a, b) = (v[k], v[(k + 1) % 3]);
            *edges.entry((a.min(b), a.max(b))).or_default() += 1;
        }
    }
    edges.values().all(|&n| n == 2)
}

/// Tiefe des Erdreich-Bands unter der Geländelinie (m), wenn das Gelände keine `earthDepth` trägt.
const EARTH_BAND: f64 = 1.5;

/// Tiefe des Erdreich-Bands: `earthDepth` des ersten Geländes, das eine positive Tiefe setzt.
fn earth_band(p: &Project) -> f64 {
    crate::excavation::terrains(p).iter().find_map(|t| t.earth_depth.filter(|d| d.is_finite() && *d > 0.0)).unwrap_or(EARTH_BAND)
}

/// [T6]/[109] Erdreich: Band unter dem gestalteten Terrain mit SIA-Erdreich-Schraffur, ohne das
/// Gebäude-Innere (Grundfläche im Schnitt, von der tiefsten Schnittfläche aufwärts); die geschnittenen
/// Bauteile selbst liegen ohnehin darüber.
fn append_earth(out: &mut Output, p: &Project, base: (f64, f64), u: (f64, f64)) {
    let depth = earth_band(p);
    let mut band: Vec<crate::flat::Polygon> = Vec::new();
    for pr in out.profiles.iter().filter(|pr| !pr.natural && pr.pts.len() >= 2) {
        let mut ring = pr.pts.clone();
        ring.extend(pr.pts.iter().rev().map(|q| [q[0], q[1] - depth]));
        band.push(vec![ring]);
    }
    if band.is_empty() {
        return;
    }
    let mut band = crate::polygon_bool::union(&band);
    // [68] Die Verbauwände lässt erst `section_primitives` aus, und nur die sichtbaren (ausgeblendete Klasse = kein Loch).
    // Gebäude-Inneres: Abschnitte der Schnittlinie in der Grundfläche.
    let mut holes: Vec<crate::flat::Polygon> = Vec::new();
    for poly in crate::site_rules::building_footprint(p) {
        let mut ts: Vec<f64> = Vec::new();
        for ring in &poly {
            let n = ring.len();
            for i in 0..n {
                let (a, b) = (ring[i], ring[(i + 1) % n]);
                // Schnitt der Geraden base + s·u mit der Kante a–b.
                let (ex, ey) = (b.x - a.x, b.y - a.y);
                let den = u.0 * ey - u.1 * ex;
                if den.abs() < 1e-12 {
                    continue;
                }
                let (wx, wy) = (a.x - base.0, a.y - base.1);
                let s_ = (wx * ey - wy * ex) / den;
                let t_ = (wx * u.1 - wy * u.0) / den;
                if (0.0..1.0).contains(&t_) {
                    ts.push(s_);
                }
            }
        }
        ts.sort_by(|a, b| a.total_cmp(b));
        for w in ts.chunks_exact(2) {
            let (u0, u1) = (w[0], w[1]);
            let low = out.cuts.iter().flat_map(|c| c.pts.iter()).filter(|q| q[0] >= u0 - 1e-6 && q[0] <= u1 + 1e-6).map(|q| q[1]).fold(f64::INFINITY, f64::min);
            if low.is_finite() {
                holes.push(vec![vec![[u0, low], [u1, low], [u1, 1e4], [u0, 1e4]]]);
            }
        }
    }
    if !holes.is_empty() {
        band = crate::polygon_bool::difference(&band, &holes);
    }
    let hatch = crate::plan::style::resolve_hatch(p, "std-h-erdreich", None, None, None)
        .unwrap_or(HatchRender { pattern: HatchPattern::Earth, scale: 1.0, angle: 45.0, color: HATCH_INK.into(), line_weight: 0.1, ..no_hatch_base() });
    for poly in band {
        if let Some(outer) = poly.into_iter().next() {
            if outer.len() >= 3 {
                out.earth.push((outer, hatch.clone()));
            }
        }
    }
}

/// Höhenband (m) um einen Punkt, in dem Schnitte der Gebäudegruppe seine Spanne bestimmen ([`outside_building`]).
const BUILDING_BAND: f64 = 2.5;

/// [204] Teile einer Geländelinie, die NICHT im Gebäude liegen. Die Bauteilschnitte werden zu zusammenhängenden Gruppen
/// (Gebäude, Carport …) vereint; „im Gebäude" heisst: auf der Höhe des Punkts (± [`BUILDING_BAND`], damit Fensterlücken
/// in der Aussenwand nicht aufreissen) liegt links und rechts davon ein Schnitt derselben Gruppe. Die Räume dazwischen sind
/// keine Flächen, das gewachsene Terrain schiene sonst durch sie hindurch. Übergänge werden per Bisektion genau gesetzt.
fn outside_building(line: &[[f64; 2]], cuts: &[super::Cut]) -> Vec<Vec<[f64; 2]>> {
    // Rahmen (x0, z0, x1, z1) je Schnittfläche.
    let boxes: Vec<[f64; 4]> = cuts
        .iter()
        .filter(|c| c.pts.len() >= 3)
        .map(|c| c.pts.iter().fold([f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY], |b, q| [b[0].min(q[0]), b[1].min(q[1]), b[2].max(q[0]), b[3].max(q[1])]))
        .collect();
    if boxes.is_empty() {
        return vec![line.to_vec()];
    }
    // Gruppen: Rahmen, die sich berühren (1 cm), gehören zusammen (Union-Find).
    let mut parent: Vec<usize> = (0..boxes.len()).collect();
    fn root(parent: &mut [usize], mut i: usize) -> usize {
        while parent[i] != i {
            parent[i] = parent[parent[i]];
            i = parent[i];
        }
        i
    }
    const TOUCH: f64 = 0.01;
    for i in 0..boxes.len() {
        for j in 0..i {
            let (a, b) = (boxes[i], boxes[j]);
            if a[0] <= b[2] + TOUCH && b[0] <= a[2] + TOUCH && a[1] <= b[3] + TOUCH && b[1] <= a[3] + TOUCH {
                let (ri, rj) = (root(&mut parent, i), root(&mut parent, j));
                parent[ri] = rj;
            }
        }
    }
    let groups: Vec<usize> = (0..boxes.len()).map(|i| root(&mut parent, i)).collect();
    let mut ids: Vec<usize> = groups.clone();
    ids.sort_unstable();
    ids.dedup();
    let inside = |q: [f64; 2]| {
        ids.iter().any(|&g| {
            let (mut lo, mut hi) = (f64::INFINITY, f64::NEG_INFINITY);
            for (b, _) in boxes.iter().zip(&groups).filter(|(b, &gi)| gi == g && b[1] <= q[1] + BUILDING_BAND && b[3] >= q[1] - BUILDING_BAND) {
                lo = lo.min(b[0]);
                hi = hi.max(b[2]);
            }
            q[0] > lo + 1e-6 && q[0] < hi - 1e-6
        })
    };
    let mut out: Vec<Vec<[f64; 2]>> = Vec::new();
    let mut cur: Vec<[f64; 2]> = Vec::new();
    let flush = |cur: &mut Vec<[f64; 2]>, out: &mut Vec<Vec<[f64; 2]>>| {
        if cur.len() >= 2 {
            out.push(std::mem::take(cur));
        }
        cur.clear();
    };
    for w in line.windows(2) {
        let (a, b) = (w[0], w[1]);
        let len = ((b[0] - a[0]).powi(2) + (b[1] - a[1]).powi(2)).sqrt();
        let n = ((len / 0.1).ceil() as usize).clamp(1, 400);
        let at = |t: f64| [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
        let mut prev_t = 0.0;
        let mut prev_in = inside(a);
        if !prev_in && cur.is_empty() {
            cur.push(a);
        }
        for k in 1..=n {
            let t = k as f64 / n as f64;
            let now_in = inside(at(t));
            if now_in != prev_in {
                let (mut lo_t, mut hi_t) = (prev_t, t);
                for _ in 0..30 {
                    let mid = 0.5 * (lo_t + hi_t);
                    if inside(at(mid)) == prev_in {
                        lo_t = mid;
                    } else {
                        hi_t = mid;
                    }
                }
                if prev_in {
                    // Eintritt in die Aussenseite: neues Stück ab der Grenze.
                    cur.push(at(hi_t));
                } else {
                    cur.push(at(lo_t));
                    flush(&mut cur, &mut out);
                }
            }
            prev_t = t;
            prev_in = now_in;
        }
        if !prev_in {
            cur.push(b);
        } else {
            flush(&mut cur, &mut out);
        }
    }
    flush(&mut cur, &mut out);
    out
}
