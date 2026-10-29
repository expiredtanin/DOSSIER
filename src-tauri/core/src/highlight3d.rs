//! Umriss-Linien der 3D-Auswahl (früher `selectionHighlightLines` in `plan/toWalls3d.ts`): je
//! gewähltes Bauteil die Kanten seiner Hülle als Linienliste `[x, y, z, r, g, b] × 2` (Welt-Meter,
//! y = Höhe), die der 3D-Viewport ohne Tiefentest obenauf zeichnet. Wände/Öffnungen als Quader,
//! Decken/Treppen als Prisma, Dächer als Flächen-/Giebel-Umrisse, Kontext-Meshes als Hüllquader.
//! Rechnung und Reihenfolge wie die TS-Fassung (f32 wie `Float32Array`).

use crate::jsmath::hypot2;
use crate::model::{ContextObject, Project};
use crate::model3d::{emit_slabs, emit_walls, pick_openings, pick_stairs};
use std::collections::HashSet;

const EPS: f64 = 1e-4;

type V3 = [f64; 3];

/// Gewählte ids je Art und Linienfarbe.
#[derive(serde::Deserialize, Default)]
#[serde(default)]
pub struct Args {
    pub walls: Vec<String>,
    pub ceilings: Vec<String>,
    pub openings: Vec<String>,
    pub stairs: Vec<String>,
    pub roofs: Vec<String>,
    pub context: Vec<String>,
    pub rgb: [f64; 3],
}

const BOX_EDGES: [(usize, usize); 12] = [(0, 1), (0, 2), (0, 4), (1, 3), (1, 5), (2, 3), (2, 6), (3, 7), (4, 5), (4, 6), (5, 7), (6, 7)];

struct Out {
    v: Vec<f32>,
    rgb: [f64; 3],
}

impl Out {
    fn edge(&mut self, a: V3, b: V3) {
        let c = self.rgb;
        for q in [a, b] {
            self.v.extend([q[0], q[1], q[2], c[0], c[1], c[2]].map(|x| x as f32));
        }
    }

    /// Quader um die Achse `start → end` (Dicke quer, Höhe ab `base`).
    fn box_edges(&mut self, start: [f64; 2], end: [f64; 2], thickness: f64, height: f64, base: f64) {
        let ax = end[0] - start[0];
        let az = end[1] - start[1];
        let len = hypot2(ax, az);
        if len < EPS || height <= EPS || thickness <= EPS {
            return;
        }
        let axis = [ax / len, 0.0, az / len];
        let normal = [az / len, 0.0, -ax / len];
        let half_len = len / 2.0;
        let half_height = height / 2.0;
        let half_thick = thickness / 2.0;
        let center = [(start[0] + end[0]) / 2.0, base + height / 2.0, (start[1] + end[1]) / 2.0];
        let mut corners = [[0.0; 3]; 8];
        for (i, c) in corners.iter_mut().enumerate() {
            let s_l = if i & 1 != 0 { 1.0 } else { -1.0 };
            let s_h = if i & 2 != 0 { 1.0 } else { -1.0 };
            let s_t = if i & 4 != 0 { 1.0 } else { -1.0 };
            *c = [
                center[0] + s_l * half_len * axis[0] + s_t * half_thick * normal[0],
                center[1] + s_h * half_height,
                center[2] + s_l * half_len * axis[2] + s_t * half_thick * normal[2],
            ];
        }
        for (i, j) in BOX_EDGES {
            self.edge(corners[i], corners[j]);
        }
    }

    /// Prisma über dem Grundriss `outline` von `z_bottom` bis `z_top`.
    fn prism_edges(&mut self, outline: &[[f64; 2]], z_bottom: f64, z_top: f64) {
        let n = outline.len();
        if n < 3 || z_top - z_bottom <= EPS {
            return;
        }
        let bottom = |i: usize| [outline[i][0], z_bottom, outline[i][1]];
        let top = |i: usize| [outline[i][0], z_top, outline[i][1]];
        let mut j = n - 1;
        for i in 0..n {
            self.edge(bottom(j), bottom(i));
            self.edge(top(j), top(i));
            j = i;
        }
        for i in 0..n {
            self.edge(bottom(i), top(i));
        }
    }
}

fn set(ids: &[String]) -> HashSet<&str> {
    ids.iter().map(String::as_str).collect()
}

/// Linienliste der Hervorhebung (leer, wenn nichts gewählt ist).
pub fn selection_highlight_lines(p: &Project, a: &Args) -> Result<Vec<f32>, String> {
    let mut out = Out { v: Vec::new(), rgb: a.rgb };
    let (walls, ceilings, openings, stairs, roofs, context) = (set(&a.walls), set(&a.ceilings), set(&a.openings), set(&a.stairs), set(&a.roofs), set(&a.context));
    if !walls.is_empty() {
        for w in emit_walls(p, true)? {
            if walls.contains(w.wall_id.as_str()) {
                out.box_edges(w.start, w.end, w.thickness, w.height, w.base_elevation);
            }
        }
    }
    if !openings.is_empty() {
        for o in pick_openings(p) {
            if openings.contains(o.opening_id.as_str()) {
                out.box_edges(o.start, o.end, o.thickness, o.height, o.base_elevation);
            }
        }
    }
    if !ceilings.is_empty() {
        for s in emit_slabs(p) {
            if ceilings.contains(s.ceiling_id.as_str()) {
                out.prism_edges(&s.outline, s.z_bottom, s.z_top);
            }
        }
    }
    if !stairs.is_empty() {
        for st in pick_stairs(p) {
            if stairs.contains(st.stair_id.as_str()) {
                out.prism_edges(&st.outline, st.z_bottom, st.z_top);
            }
        }
    }
    if !roofs.is_empty() {
        for roof in p.roofs.as_deref().unwrap_or(&[]) {
            if !roofs.contains(roof.id.as_str()) {
                continue;
            }
            let g = crate::roof::roof_geometry(&roof.params(), p.roof_base_elevation(roof));
            for pts in g.planes.iter().chain(g.gables.iter()) {
                let m = pts.len();
                if m == 0 {
                    continue;
                }
                let mut j = m - 1;
                for i in 0..m {
                    let (q, r) = (pts[j], pts[i]);
                    out.edge([q[0], q[2], q[1]], [r[0], r[2], r[1]]);
                    j = i;
                }
            }
        }
    }
    if !context.is_empty() {
        for obj in p.context.as_deref().unwrap_or(&[]) {
            let (pos, id) = match obj {
                ContextObject::TerrainMesh(m) => (&m.positions, &m.id),
                ContextObject::ImportedMesh(m) => (&m.positions, &m.id),
                _ => continue,
            };
            if !context.contains(id.as_str()) {
                continue;
            }
            let (mut min_x, mut max_x, mut min_y, mut max_y, mut min_h, mut max_h) = (f64::INFINITY, f64::NEG_INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::INFINITY, f64::NEG_INFINITY);
            for c in pos.chunks_exact(3) {
                let (x, y, h) = (c[0], c[1], c[2]);
                if x < min_x {
                    min_x = x;
                }
                if x > max_x {
                    max_x = x;
                }
                if y < min_y {
                    min_y = y;
                }
                if y > max_y {
                    max_y = y;
                }
                if h < min_h {
                    min_h = h;
                }
                if h > max_h {
                    max_h = h;
                }
            }
            if !min_x.is_finite() {
                continue;
            }
            let mut corners = [[0.0; 3]; 8];
            for (i, c) in corners.iter_mut().enumerate() {
                *c = [if i & 1 != 0 { max_x } else { min_x }, if i & 2 != 0 { max_h } else { min_h }, if i & 4 != 0 { max_y } else { min_y }];
            }
            for (i, j) in BOX_EDGES {
                out.edge(corners[i], corners[j]);
            }
        }
    }
    Ok(out.v)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Project {
        serde_json::from_str(include_str!("../tests/fixtures/sample_project.json")).unwrap()
    }

    fn lines(p: &Project, a: serde_json::Value) -> Vec<f32> {
        selection_highlight_lines(p, &serde_json::from_value(a).unwrap()).unwrap()
    }

    #[test]
    fn leer_ohne_auswahl() {
        let p = sample();
        assert!(lines(&p, serde_json::json!({})).is_empty());
        assert!(lines(&p, serde_json::json!({"walls": ["gibt-es-nicht"]})).is_empty());
    }

    #[test]
    fn wand_zwoelf_kanten_decke_prisma() {
        let p = sample();
        let w = emit_walls(&p, true).unwrap();
        let id = &w[0].wall_id;
        let n = w.iter().filter(|x| &x.wall_id == id).count();
        let l = lines(&p, serde_json::json!({"walls": [id], "rgb": [1.0, 0.5, 0.0]}));
        assert_eq!(l.len(), n * 12 * 12);
        assert_eq!(&l[3..6], &[1.0, 0.5, 0.0]);
        let s = &emit_slabs(&p)[0];
        let l = lines(&p, serde_json::json!({"ceilings": [s.ceiling_id]}));
        assert_eq!(l.len() % (3 * 12) , 0);
        assert!(!l.is_empty());
    }
}
