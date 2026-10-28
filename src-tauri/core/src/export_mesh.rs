//! OBJ-/STL-Export des 3D-Gebäudemodells als reines Dreiecks-Netz ([K4] S2, vorher
//! `src/export/exportMesh.ts`). Wände: dieselben Schicht-Bänder wie der 3D-Viewer, gelochte Bänder
//! öffnungsgenau ausgeschnitten (`wall_mesh_cut`); Decken und Extrusionen als Umriss-Prismen
//! (Ear-Clipping-Kappen, Seitenmantel, optional verjüngt). Achsen: Modell (x, y) → Welt (x, Höhe, y),
//! Y-up, rechtshändig, Meter.

use crate::js_fmt::to_fixed;
use crate::model::*;
use crate::model3d;
use crate::wall_mesh_cut::{wall_cut_mesh, CutWall};

struct MeshGroup {
    name: String,
    positions: Vec<f64>,
    indices: Vec<u32>,
}

/// OBJ-Gruppennamen dürfen keine Whitespaces/Sonderzeichen enthalten.
fn sanitize_name(id: &str) -> String {
    let s: String = id.chars().map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' }).collect();
    if s.is_empty() {
        "x".into()
    } else {
        s
    }
}

/// Die 6 Quader-Seiten als Eckpunkt-Quadrupel, nach aussen gewunden.
const BOX_QUADS: [[u32; 4]; 6] = [[4, 6, 7, 5], [1, 3, 2, 0], [2, 3, 7, 6], [4, 5, 1, 0], [1, 5, 7, 3], [2, 6, 4, 0]];

fn push_wall_box(g: &mut MeshGroup, w: &model3d::RWall) {
    let [sx, sy] = w.start;
    let [ex, ey] = w.end;
    let dx = ex - sx;
    let dz = ey - sy;
    let len = crate::jsmath::hypot2(dx, dz);
    if len < 1e-9 || w.height <= 1e-9 || w.thickness <= 1e-9 {
        return;
    }
    let (ax, az) = (dx / len, dz / len);
    let (nx, nz) = (az, -ax);
    let (half_len, half_height, half_thick) = (len / 2.0, w.height / 2.0, w.thickness / 2.0);
    let (cx, cz) = ((sx + ex) / 2.0, (sy + ey) / 2.0);
    let cy = w.base_elevation + w.height / 2.0;
    let base = (g.positions.len() / 3) as u32;
    for i in 0..8u32 {
        let s_l = if i & 1 != 0 { 1.0 } else { -1.0 };
        let s_h = if i & 2 != 0 { 1.0 } else { -1.0 };
        let s_t = if i & 4 != 0 { 1.0 } else { -1.0 };
        g.positions.extend([cx + s_l * half_len * ax + s_t * half_thick * nx, cy + s_h * half_height, cz + s_l * half_len * az + s_t * half_thick * nz]);
    }
    for [a, b, c, d] in BOX_QUADS {
        g.indices.extend([base + a, base + b, base + c, base + a, base + c, base + d]);
    }
}

fn signed_area_xy(pts: &[Vec2]) -> f64 {
    let mut a = 0.0;
    let mut j = pts.len().wrapping_sub(1);
    for i in 0..pts.len() {
        a += pts[j].x * pts[i].y - pts[i].x * pts[j].y;
        j = i;
    }
    a / 2.0
}

fn push_prism(g: &mut MeshGroup, outline: &[Vec2], z_bottom: f64, z_top: f64, taper: f64) {
    if outline.len() < 3 || z_top - z_bottom <= 1e-9 {
        return;
    }
    let ccw: Vec<Vec2> = if signed_area_xy(outline) >= 0.0 { outline.to_vec() } else { outline.iter().rev().copied().collect() };
    let n = ccw.len() as u32;
    let (mut cx, mut cy_model) = (0.0, 0.0);
    for p in &ccw {
        cx += p.x;
        cy_model += p.y;
    }
    cx /= n as f64;
    cy_model /= n as f64;
    let t = taper.clamp(0.0, 1.0);
    let base = (g.positions.len() / 3) as u32;
    for p in &ccw {
        g.positions.extend([p.x, z_bottom, p.y]);
    }
    for p in &ccw {
        let tx = cx + (p.x - cx) * (1.0 - t);
        let ty = cy_model + (p.y - cy_model) * (1.0 - t);
        g.positions.extend([tx, z_top, ty]);
    }
    let pts: Vec<crate::hatch::V2> = ccw.iter().map(|p| crate::hatch::V2 { x: p.x, y: p.y }).collect();
    let cap = crate::gpu_compile::triangulate(&pts);
    for tri in cap.chunks_exact(3) {
        let (a, b, c) = (tri[0], tri[1], tri[2]);
        g.indices.extend([base + a, base + b, base + c]);
        g.indices.extend([base + n + a, base + n + c, base + n + b]);
    }
    for i in 0..n {
        let j = (i + 1) % n;
        let (bi, bj, ti, tj) = (base + i, base + j, base + n + i, base + n + j);
        g.indices.extend([bi, ti, tj]);
        g.indices.extend([bi, tj, bj]);
    }
}

fn build_groups(p: &Project) -> Result<Vec<MeshGroup>, String> {
    let mut groups: Vec<MeshGroup> = Vec::new();
    let walls = model3d::emit_walls(p, true)?;
    let mut by_id: Vec<(String, usize)> = Vec::new();
    for w in &walls {
        let gi = match by_id.iter().find(|(id, _)| *id == w.wall_id) {
            Some((_, gi)) => *gi,
            None => {
                groups.push(MeshGroup { name: format!("Wand_{}", sanitize_name(&w.wall_id)), positions: vec![], indices: vec![] });
                by_id.push((w.wall_id.clone(), groups.len() - 1));
                groups.len() - 1
            }
        };
        let g = &mut groups[gi];
        if w.holes.as_ref().is_some_and(|h| !h.is_empty()) {
            let cw = CutWall {
                start: w.start,
                end: w.end,
                thickness: w.thickness,
                base_elevation: w.base_elevation,
                height: w.height,
                holes: w.holes.as_ref().map_or(vec![], |hs| hs.iter().map(|h| [h.from, h.to, h.z_bottom, h.z_top]).collect()),
            };
            let finite = cw.start.iter().chain(&cw.end).all(|v| v.is_finite()) && [cw.thickness, cw.base_elevation, cw.height].iter().all(|v| v.is_finite()) && cw.holes.iter().flatten().all(|v| v.is_finite());
            let cut = if finite { wall_cut_mesh(&cw) } else { Vec::new() };
            let base = (g.positions.len() / 3) as u32;
            g.positions.extend_from_slice(&cut);
            g.indices.extend((0..(cut.len() / 3) as u32).map(|i| base + i));
        } else {
            push_wall_box(g, w);
        }
    }
    for s in model3d::emit_slabs(p) {
        let mut g = MeshGroup { name: format!("Decke_{}", sanitize_name(&s.ceiling_id)), positions: vec![], indices: vec![] };
        let outline: Vec<Vec2> = s.outline.iter().map(|&[x, y]| Vec2 { x, y }).collect();
        push_prism(&mut g, &outline, s.z_bottom, s.z_top, 0.0);
        groups.push(g);
    }
    for solid in p.extruded_solids.as_deref().unwrap_or(&[]) {
        if solid.points.len() < 3 || solid.height <= 0.0 {
            continue;
        }
        let base_z = p.floor(&solid.level_id).map_or(0.0, |f| f.base_elevation.unwrap_or(0.0));
        let mut g = MeshGroup { name: format!("Extrusion_{}", sanitize_name(&solid.id)), positions: vec![], indices: vec![] };
        push_prism(&mut g, &solid.points, base_z, base_z + solid.height, solid.taper.unwrap_or(0.0));
        groups.push(g);
    }
    Ok(groups.into_iter().filter(|g| !g.indices.is_empty()).collect())
}

/// Kompakte Zahlformatierung (bis 6 Nachkommastellen, ohne Nullen, mindestens `.0`).
fn fmt(v: f64) -> String {
    if !v.is_finite() {
        return "0.0".into();
    }
    let mut s = to_fixed(v, 6);
    let trimmed = s.trim_end_matches('0').len();
    s.truncate(trimmed);
    if s.ends_with('.') {
        s.push('0');
    }
    s
}

/// Wavefront-OBJ des Gebäudemodells.
pub fn export_obj(p: &Project) -> Result<String, String> {
    let groups = build_groups(p)?;
    let mut lines: Vec<String> = vec![
        "# DOSSIER OBJ-Export - Dreiecks-Mesh des 3D-Gebaeudemodells".into(),
        "# Achsen: rechtshaendig, Y-up (Y = Hoehe ueber OKFF), wie der 3D-Viewer.".into(),
        "# Waende: Schicht-Baender mit oeffnungsgenau ausgeschnittenen Loechern (inkl. Laibungen).".into(),
        "# Decken/Extrusionen: Umriss-Prisma (Ear-Clipping-Triangulierung).".into(),
    ];
    let mut offset = 0u32;
    for g in &groups {
        let vert_count = (g.positions.len() / 3) as u32;
        if vert_count == 0 {
            continue;
        }
        lines.push(format!("o {}", g.name));
        for c in g.positions.chunks_exact(3) {
            lines.push(format!("v {} {} {}", fmt(c[0]), fmt(c[1]), fmt(c[2])));
        }
        for t in g.indices.chunks_exact(3) {
            lines.push(format!("f {} {} {}", t[0] + 1 + offset, t[1] + 1 + offset, t[2] + 1 + offset));
        }
        offset += vert_count;
    }
    Ok(lines.join("\n") + "\n")
}

/// ASCII-STL des Gebäudemodells.
pub fn export_stl(p: &Project) -> Result<String, String> {
    let groups = build_groups(p)?;
    let mut lines: Vec<String> = vec!["solid dossier".into()];
    for g in &groups {
        for t in g.indices.chunks_exact(3) {
            let pt = |i: u32| -> [f64; 3] {
                let k = i as usize * 3;
                [g.positions[k], g.positions[k + 1], g.positions[k + 2]]
            };
            let (a, b, c) = (pt(t[0]), pt(t[1]), pt(t[2]));
            let (ux, uy, uz) = (b[0] - a[0], b[1] - a[1], b[2] - a[2]);
            let (vx, vy, vz) = (c[0] - a[0], c[1] - a[1], c[2] - a[2]);
            let (mut nx, mut ny, mut nz) = (uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
            let len = crate::jsmath::hypot(&[nx, ny, nz]);
            if len > 1e-12 {
                nx /= len;
                ny /= len;
                nz /= len;
            } else {
                nx = 0.0;
                ny = 0.0;
                nz = 0.0;
            }
            lines.push(format!("facet normal {} {} {}", fmt(nx), fmt(ny), fmt(nz)));
            lines.push("outer loop".into());
            for v in [a, b, c] {
                lines.push(format!("vertex {} {} {}", fmt(v[0]), fmt(v[1]), fmt(v[2])));
            }
            lines.push("endloop".into());
            lines.push("endfacet".into());
        }
    }
    lines.push("endsolid dossier".into());
    Ok(lines.join("\n") + "\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zahlformat() {
        assert_eq!(fmt(1.0), "1.0");
        assert_eq!(fmt(1.5), "1.5");
        assert_eq!(fmt(0.0), "0.0");
        assert_eq!(fmt(10.0), "10.0");
        assert_eq!(fmt(0.1234567), "0.123457");
        assert_eq!(fmt(f64::NAN), "0.0");
    }

    #[test]
    fn beispielprojekt() {
        let p: Project = serde_json::from_str(include_str!("../tests/fixtures/sample_project.json")).unwrap();
        let obj = export_obj(&p).unwrap();
        assert!(obj.contains("\no Wand_"));
        let stl = export_stl(&p).unwrap();
        assert!(stl.starts_with("solid dossier\n") && stl.ends_with("endsolid dossier\n"));
        assert!(export_obj(&Project::default()).unwrap().lines().count() == 4);
    }
}
