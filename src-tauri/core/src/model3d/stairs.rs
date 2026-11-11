//! Treppen im 3D: Platten für Schnitt und Ansicht (`emit_stairs()`, `emit_stairs_elevation()`), Netze der
//! Läufe und Geländer (`emit_stair_meshes()`, `emit_stair_railings()`) aus `stairs3d`. Aufgerufen von
//! `parts()` (`mod.rs`), dem Schnitt, der Ansicht und der Pick-Geometrie.

use super::*;

fn stair_rgb() -> Rgb {
    hex_to_rgb("#9aa0a6", SLAB_RGB)
}

fn rail_rgb() -> Rgb {
    hex_to_rgb("#74797f", SLAB_RGB)
}

/// Flache Eingabe der Treppen für `stairs3d` (24 Zahlen je Treppe); `wanted` wählt vor.
pub(super) fn stair_input<'a>(p: &'a Project, wanted: impl Fn(&Stair, Option<&StairType>) -> bool) -> Option<(Vec<(usize, &'a Stair)>, Vec<f64>)> {
    let mut stairs: Vec<(usize, &Stair)> = Vec::new();
    let mut types: Vec<Option<&StairType>> = Vec::new();
    for (si, s) in p.stairs.as_deref().unwrap_or(&[]).iter().enumerate() {
        let st = p.stair_type(s);
        if !wanted(s, st) {
            continue;
        }
        stairs.push((si, s));
        types.push(st);
    }
    if stairs.is_empty() {
        return None;
    }
    let mut buf = vec![stairs.len() as f64];
    for (&(_, s), st) in stairs.iter().zip(&types) {
        let (z_bottom, z_top) = p.stair_vertical_extent(s);
        buf.extend(s.encode());
        buf.push(z_bottom);
        buf.push(z_top);
        buf.push(match st.map(|t| t.structure) {
            None | Some(StairTypeStructure::Massiv) => 0.0,
            Some(StairTypeStructure::Beton) => 1.0,
            _ => 2.0,
        });
        buf.push(st.map_or(0.04, |t| t.tread_thickness));
        buf.push(st.and_then(|t| t.nosing).unwrap_or(0.0));
        buf.push(if st.is_some_and(|t| t.closed_risers) { 1.0 } else { 0.0 });
        buf.push(match st.and_then(|t| t.railing) {
            Some(StairTypeRailing::Links) => 1.0,
            Some(StairTypeRailing::Rechts) => 2.0,
            Some(StairTypeRailing::Beide) => 3.0,
            _ => 0.0,
        });
        buf.push(s.center_column.filter(|r| r.is_finite() && *r > 0.0).unwrap_or(0.0));
    }
    Some((stairs, buf))
}

/// Treppen als extrudierte Platten (`emitStairs`); `for_section`: auch gerade Betontreppen als Tritte.
pub fn emit_stairs(p: &Project, for_section: bool) -> Vec<RSlab> {
    let Some((stairs, buf)) = stair_input(p, |_, _| true) else { return vec![] };
    stair_slabs(&stairs, crate::stairs3d::slabs(&buf, for_section))
}

/// [151] Treppen für die Ansicht: Ortbeton-Läufe (im 3D Netze) als ein Block je Tritt.
pub fn emit_stairs_elevation(p: &Project) -> Vec<RSlab> {
    let Some((stairs, buf)) = stair_input(p, |_, _| true) else { return vec![] };
    stair_slabs(&stairs, crate::stairs3d::slabs_coarse(&buf))
}

fn stair_slabs(stairs: &[(usize, &Stair)], slabs: Vec<crate::stairs3d::Slab>) -> Vec<RSlab> {
    slabs
        .into_iter()
        .map(|s| {
            let (si, stair) = stairs[s.src];
            RSlab {
                outline: s.pts,
                z_bottom: s.z_bottom,
                z_top: s.z_top,
                color: stair_rgb(),
                ceiling_id: stair.id.clone(),
                hatch: None,
                cut: None,
                monolith: s.monolith.then(|| stair.id.clone()),
                source: SlabSource::Stair { index: si },
            }
        })
        .collect()
}

/// `owner`: Treppe (Index in `p.stairs`) eines Netzes aus seinem `src` ([180] Klassen-Filter).
fn meshes_of(meshes: Vec<crate::mesh3d::Mesh>, color: Rgb, owner: impl Fn(usize) -> Option<usize>) -> Vec<RMesh> {
    meshes.into_iter().map(|m| RMesh {
                    owner: owner(m.src).map_or(Owner::None, Owner::Stair),
                    crease_angle: None, positions: m.positions, indices: m.indices, kind: "extrusion", color, vertex_colors: None, material_index: None }).collect()
}

/// Glatte Ortbeton-Laufplatten (je Lauf: gerade, L, U, gerade mit Podest) und Wendelfläche (Schraubenfläche)
/// von Wendeltreppen (`emitStairMeshes`).
pub fn emit_stair_meshes(p: &Project) -> Vec<RMesh> {
    match stair_input(p, |s, st| st.is_some_and(|t| t.structure == StairTypeStructure::Beton) && s.shape != StairShape::Unknown) {
        Some((stairs, buf)) => meshes_of(crate::stairs3d::slab_meshes(&buf), stair_rgb(), |i| stairs.get(i).map(|s| s.0)),
        None => vec![],
    }
}

/// [G1] Laufplatten der Betontreppen aus geraden Läufen (gerade, L, U, gerade mit Podest; [151]) je Treppe
/// (Index in `p.stairs`): Netze mit exakter Untersicht, für den Schnitt (`plan::section`).
pub fn stair_flight_meshes(p: &Project) -> Vec<(usize, crate::mesh3d::Mesh)> {
    match stair_input(p, |s, st| st.is_some_and(|t| t.structure == StairTypeStructure::Beton) && matches!(s.shape, StairShape::Straight | StairShape::L | StairShape::U | StairShape::StraightLanding)) {
        Some((stairs, buf)) => crate::stairs3d::slab_meshes(&buf).into_iter().filter_map(|m| stairs.get(m.src).map(|&(si, _)| (si, m))).collect(),
        None => vec![],
    }
}

/// [157] Rohr-Halbmesser von Handlauf und Pfosten in den Ansichtskanten des Schnitts (eine Linie statt zwei).
const VIEW_RAIL_HALF: f64 = 0.004;

/// [157] Für die Ansichtskanten im Schnitt: Wangen der Wangentreppen aus geraden Läufen und Handlauf/Pfosten
/// aller Treppen mit Geländer, je Treppe (Index in `p.stairs`; [173] `true` = Handlauf/Pfosten). Modell [x, y, Höhe].
pub fn stair_view_meshes(p: &Project) -> Vec<(usize, crate::mesh3d::Mesh, bool)> {
    let mut out = Vec::new();
    let flights = |s: &Stair| matches!(s.shape, StairShape::Straight | StairShape::L | StairShape::U | StairShape::StraightLanding);
    if let Some((stairs, buf)) = stair_input(p, |s, st| st.is_some_and(|t| t.structure == StairTypeStructure::Wange) && flights(s)) {
        out.extend(crate::stairs3d::stringers(&buf).into_iter().filter_map(|m| stairs.get(m.src).map(|&(si, _)| (si, m, false))));
    }
    if let Some((stairs, buf)) = stair_input(p, |s, st| s.shape != StairShape::Unknown && st.and_then(|t| t.railing).is_some_and(|r| r != StairTypeRailing::Keine)) {
        out.extend(crate::stairs3d::railings_with(&buf, VIEW_RAIL_HALF).into_iter().filter_map(|m| stairs.get(m.src).map(|&(si, _)| (si, m, true))));
    }
    out
}

/// Handlauf und Pfosten der Treppen (`emitStairRailings`); bei Wendeltreppen als Schraubensweep, bei
/// Podesttreppen (L, U, gerade mit Podest) über die Podeste ([151]).
pub fn emit_stair_handrails(p: &Project) -> Vec<RMesh> {
    match stair_input(p, |s, st| s.shape != StairShape::Unknown && st.and_then(|t| t.railing).is_some_and(|r| r != StairTypeRailing::Keine)) {
        Some((stairs, buf)) => meshes_of(crate::stairs3d::railings(&buf), rail_rgb(), |i| stairs.get(i).map(|s| s.0)),
        None => vec![],
    }
}

/// Alle Wandumrisse eines Geschosses (Wände stehen der Absturzsicherung im Weg).
pub fn wall_footprints_of_floor(p: &Project, floor: &str) -> Vec<crate::plan::wall_poche::WallFootprint> {
    crate::plan::domains::wall_footprints_of(p, floor, |_| true)
}

/// [155] Absturzsicherung am Deckenloch ankommender Treppen (Lage: [`crate::stair_guard`]) als Körper je Treppe
/// (Index in `p.stairs`), Modell [x, y, Höhe]; alle Wände des Geschosses stehen der Sicherung im Weg.
pub fn stair_guard_meshes(p: &Project) -> Vec<(usize, crate::mesh3d::Mesh)> {
    stair_guard_meshes_by_floor(p).into_iter().map(|(si, _, m)| (si, m)).collect()
}

/// Wie [`stair_guard_meshes`], mit der Geschoss-id der Decke mit dem Loch: dort steht die Sicherung
/// (nicht beim Geschoss der Treppe), darum folgt sie im Explosionsbild diesem Geschoss.
pub fn stair_guard_meshes_by_floor(p: &Project) -> Vec<(usize, String, crate::mesh3d::Mesh)> {
    let mut out: Vec<(usize, String, crate::mesh3d::Mesh)> = Vec::new();
    for f in p.drawing_levels.iter().filter(|f| f.kind == DrawingLevelKind::Floor) {
        for a in crate::stair_guard::arrivals(p, &f.id, &|_| true, &|| wall_footprints_of_floor(p, &f.id)) {
            if let Some(m) = crate::stairs3d::guard_mesh(&a.axes, a.z, a.stair) {
                out.push((a.stair, f.id.clone(), m));
            }
        }
    }
    out
}

/// Absturzsicherungen, die auf dem Geschoss `floor_id` stehen (Körper wie in [`emit_stair_railings`]).
pub fn emit_stair_guards_on(p: &Project, floor_id: &str) -> Vec<RMesh> {
    guard_meshes(stair_guard_meshes_by_floor(p).into_iter().filter(|(_, f, _)| f == floor_id).map(|(si, _, m)| (si, m)).collect())
}

/// Handlauf, Pfosten und Absturzsicherung der Treppen (`emitStairRailings`).
pub fn emit_stair_railings(p: &Project) -> Vec<RMesh> {
    let mut out = emit_stair_handrails(p);
    out.extend(guard_meshes(stair_guard_meshes(p)));
    out
}

/// Absturzsicherungen je Treppe (Index in `p.stairs`) als `RMesh`.
fn guard_meshes(v: Vec<(usize, crate::mesh3d::Mesh)>) -> Vec<RMesh> {
    let owners: Vec<usize> = v.iter().map(|(si, _)| *si).collect();
    let meshes = v.into_iter().enumerate().map(|(k, (_, m))| crate::mesh3d::Mesh { src: k, ..m }).collect();
    meshes_of(meshes, rail_rgb(), |k| owners.get(k).copied())
}
