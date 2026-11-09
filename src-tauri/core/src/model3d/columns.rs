//! Stützen und Bäume im 3D: Fussabdruck und Teilstücke der Stützen (`column_pieces()`), Netze für 3D,
//! Platten für den Schnitt (`column_slabs()`), Baum-Netze und ihre Pick-Geometrie. Aufgerufen von
//! `parts()` (`mod.rs`), dem Schnitt, der Ansicht und dem Grundriss.

use super::*;

const COLUMN_ROUND_SEGMENTS: usize = 32;
pub(crate) const COLUMN_RGB: Rgb = [0.7, 0.7, 0.72];

/// Grundriss-Querschnitt einer Stütze (`columnFootprint`).
pub fn column_footprint(col: &Column) -> Vec<Vec2> {
    let (cx, cy) = (col.position.x, col.position.y);
    match &col.profile {
        ColumnProfile::Round { radius } => (0..COLUMN_ROUND_SEGMENTS)
            .map(|i| {
                let t = (i as f64 / COLUMN_ROUND_SEGMENTS as f64) * std::f64::consts::PI * 2.0;
                Vec2 { x: cx + radius * cos(t), y: cy + radius * sin(t) }
            })
            .collect(),
        ColumnProfile::Rect { width, depth } => {
            let (hw, hd) = (width / 2.0, depth / 2.0);
            let rot = col.rotation;
            let (c, s) = (cos(rot), sin(rot));
            [(-hw, -hd), (hw, -hd), (hw, hd), (-hw, hd)]
                .iter()
                .map(|&(x, y)| Vec2 { x: cx + x * c - y * s, y: cy + x * s + y * c })
                .collect()
        }
    }
}

/// [141] Körper einer Stütze als Prismen `(Querschnitt, z_unten, z_oben)`: in der Regel der volle
/// Querschnitt; endet eine prioritärere Wand in der Stütze (`plan::wall_columns::Rel::Wall`, wie im
/// Grundriss), ist das Wandband über deren Höhe ausgespart (Höhe in Abschnitte geteilt). Löcher im
/// Rest (Wand endet ganz innen) bleiben unbeschnitten.
pub fn column_pieces(p: &Project, col: &Column) -> Vec<(Vec<Vec2>, f64, f64)> {
    use crate::plan::wall_columns::{band_polys, end_in_column, relation, Rel};
    let fp = column_footprint(col);
    let (zb, zt) = p.column_vertical_extent(col);
    let full = vec![(fp.clone(), zb, zt)];
    if fp.len() < 3 || !(zt > zb) {
        return full;
    }
    let mut clips: Vec<(Vec<Vec2>, f64, f64)> = Vec::new();
    for w in p.walls.iter().filter(|w| w.floor_id == col.floor_id) {
        if end_in_column(w, &fp).is_none() || relation(p, w, col) != Rel::Wall {
            continue;
        }
        let (wb, wt) = p.wall_vertical_extent(w);
        let (z0, z1) = (wb.max(zb), wt.min(zt));
        if z1 - z0 <= 1e-6 {
            continue;
        }
        let total = p.wall_thickness(w, 0.2);
        let ro = joins::reference_offset(wall_reference(w), total);
        clips.extend(band_polys(w, ro - total / 2.0, ro + total / 2.0, true).into_iter().map(|q| (q, z0, z1)));
    }
    if clips.is_empty() {
        return full;
    }
    let mut zs: Vec<f64> = vec![zb, zt];
    for c in &clips {
        zs.extend([c.1, c.2]);
    }
    zs.sort_by(f64::total_cmp);
    zs.dedup_by(|a, b| (*a - *b).abs() <= 1e-6);
    let ring = |q: &[Vec2]| vec![q.iter().map(|v| [v.x, v.y]).collect::<Vec<[f64; 2]>>()];
    let mut out = Vec::new();
    for z in zs.windows(2) {
        let mid = (z[0] + z[1]) / 2.0;
        let active: Vec<crate::flat::Polygon> = clips.iter().filter(|c| c.1 <= mid && c.2 >= mid).map(|c| ring(&c.0)).collect();
        if active.is_empty() {
            out.push((fp.clone(), z[0], z[1]));
            continue;
        }
        for pl in crate::polygon_bool::difference(&[ring(&fp)], &active) {
            if pl.len() > 1 {
                return full;
            }
            out.push((pl[0].iter().map(|v| Vec2 { x: v[0], y: v[1] }).collect(), z[0], z[1]));
        }
    }
    out
}

/// Netz einer Stütze (Modell x, y, z): ein Prisma über dem Querschnitt; beschnittene Stützen
/// ([`column_pieces`]) je Abschnitt mit Ohrenschnitt-Deckel (Querschnitt nicht mehr konvex).
pub(super) fn column_mesh(p: &Project, col: &Column) -> Option<(Vec<f64>, Vec<u32>)> {
    let pieces = column_pieces(p, col);
    let ok = |foot: &[[f64; 2]], z0: f64, z1: f64| z0.is_finite() && z1.is_finite() && foot.iter().all(|q| q[0].is_finite() && q[1].is_finite()) && foot.len() >= 3 && z1 - z0 > 1e-4;
    let fr = |q: &[Vec2]| q.iter().map(|v| [v.x, v.y]).collect::<Vec<[f64; 2]>>();
    if let [(foot, z0, z1)] = pieces.as_slice() {
        if foot.len() == column_footprint(col).len() {
            let foot = fr(foot);
            return ok(&foot, *z0, *z1).then(|| crate::columns3d::prism(&foot, *z0, *z1));
        }
    }
    let mut m = crate::solid_bool::Mesh::default();
    for (foot, z0, z1) in &pieces {
        let foot = fr(foot);
        if ok(&foot, *z0, *z1) {
            m.append(&crate::solid_bool::Mesh::prism(&foot, *z0, *z1));
        }
    }
    (!m.is_empty()).then_some((m.positions, m.indices))
}

/// [141] Stützen als lotrechte Prismen-Platten (Schnitt, Ansicht): je Höhenabschnitt der Querschnitt aus
/// [`column_pieces`], Herkunft `SlabSource::Column`.
pub fn column_slabs(p: &Project) -> Vec<RSlab> {
    let mut out = Vec::new();
    for (index, c) in p.columns.as_deref().unwrap_or(&[]).iter().enumerate() {
        if !(c.height > 0.0) {
            continue;
        }
        let color = c.component_id.as_deref().and_then(|id| p.component(id)).map_or(COLUMN_RGB, |k| hex_to_rgb(&k.color, COLUMN_RGB));
        for (foot, z_bottom, z_top) in column_pieces(p, c) {
            let outline: Vec<RVec2> = foot.iter().map(|q| [q.x, q.y]).collect();
            if z_top - z_bottom > 1e-6 && outline.iter().flatten().all(|v| v.is_finite()) {
                out.push(RSlab { outline, z_bottom, z_top, color, ceiling_id: c.id.clone(), hatch: None, cut: None, monolith: None, source: SlabSource::Column { index } });
            }
        }
    }
    out
}

/// Stützen als Prisma-Meshes (`emitColumns`).
pub fn emit_columns(p: &Project) -> Vec<RMesh> {
    let mut out = Vec::new();
    for col in p.columns.as_deref().unwrap_or(&[]) {
        if col.height <= 0.0 {
            continue;
        }
        let Some((positions, indices)) = column_mesh(p, col) else { continue };
        let color = col
            .component_id
            .as_deref()
            .and_then(|id| p.component(id))
            .map_or(COLUMN_RGB, |c| hex_to_rgb(&c.color, COLUMN_RGB));
        out.push(RMesh { crease_angle: None, positions, indices, kind: "extrusion", color, vertex_colors: None, material_index: None });
    }
    out
}

/// [149] Bäume als Meshes: je Baum Stamm (Zylinder, 8 Seiten) und Krone (Rotationskörper, 8 Ringe × 12
/// Seiten; Form nach `shape`), Fuss auf dem Gelände (`tree::bases`). Im 3D bei den Stützen eingereiht.
pub fn emit_trees(p: &Project) -> Vec<RMesh> {
    let mut out = Vec::new();
    let trees = p.trees.as_deref().unwrap_or(&[]);
    for (i, g) in crate::tree::geoms(p) {
        let (trunk_rgb, crown_rgb) = crate::tree::colors(&trees[i]);
        let (positions, indices) = g.trunk_mesh(8);
        out.push(RMesh { crease_angle: None, positions, indices, kind: "extrusion", color: trunk_rgb, vertex_colors: None, material_index: None });
        let (positions, indices) = g.crown_mesh(8, 12);
        out.push(RMesh { crease_angle: None, positions, indices, kind: "extrusion", color: crown_rgb, vertex_colors: None, material_index: None });
    }
    out
}

/// [149] Bäume als Welt-Dreiecke (Stamm + Krone, wie [`emit_trees`]) für den 3D-Pick.
pub fn pick_trees(p: &Project) -> Vec<PickTree> {
    let trees = p.trees.as_deref().unwrap_or(&[]);
    crate::tree::geoms(p)
        .into_iter()
        .map(|(i, g)| {
            let (tp, ti) = g.trunk_mesh(8);
            let (cp, ci) = g.crown_mesh(8, 12);
            let mut tris = extrusion_tris(&tp, &ti);
            tris.extend(extrusion_tris(&cp, &ci));
            PickTree { tris, tree_id: trees[i].id.clone() }
        })
        .collect()
}
