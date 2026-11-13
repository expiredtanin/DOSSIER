// [212] Hüllkörper-Baum (BVH) für den Pathtracer: auf der CPU aus den Dreiecken der Szene gebaut (dieselben Netze
// wie die schattierte Ansicht, `Scene::chunk_data`), Binned-SAH, als flache Arrays für die GPU (`GpuNode`, `GpuTri`).
// GPU-frei (Standard-Schicht), headless per `cargo test` prüfbar; die Traversierung hier ist dieselbe wie im
// Compute-Shader (`pathtrace_wgsl.rs`) und dient den Tests (Treffer gegen Brute-Force).
//
// Eingaben werden geprüft, nie mit Panic verworfen: nicht endliche Koordinaten, entartete Dreiecke (Fläche 0) und
// Indizes ausserhalb des Puffers fallen weg; leere Eingabe = leerer Baum (`tri_count() == 0`, Shader verfolgt nichts).
// Doppelseitige Netze (Kontext, Glas, Dächer: `mesh.rs` legt jedes Dreieck zweimal mit umgekehrter Windung ab)
// bleiben einmal im Baum: der Pathtracer dreht die Normale ohnehin zur Blickseite.
//
// Etappe 3 (Texturen): je Dreieck die UV seiner drei Ecken in einem Parallel-Puffer (`GpuTriTex`, gleiche Reihenfolge
// wie `GpuTri`, nur beim Treffer gelesen — die Traversierung bleibt schlank). Die UV sind dieselben weltmassstäblichen
// Meter wie in der schattierten Ansicht (`mesh::planar_uv` aus Ecke und Ecken-Normale); der Shader interpoliert sie
// baryzentrisch (`interp_uv`) und skaliert mit 1 / Kachelgrösse.

use std::collections::HashSet;

pub use crate::pt_material::{classify_color, srgb_to_linear, PtMaterialTable, GLASS_RGB, MAT_DIFFUSE, MAT_EMISSIVE, MAT_GLASS, MAT_GLOSSY, STEEL_RGB, TERRAIN_LAYER};

/// Höchstens so viele Dreiecke je Blatt, wenn die SAH nicht weiter teilt.
const MAX_LEAF: usize = 8;
/// Zahl der Fächer je Achse beim Binned-SAH.
const BINS: usize = 12;
/// Grenze der Baumtiefe (Stapel im Shader: 64 Einträge).
const MAX_DEPTH: usize = 48;
/// Kosten einer Knoten-Traversierung relativ zu einem Dreieckstest.
const TRAVERSAL_COST: f32 = 1.0;

/// Ein Dreieck der Eingabe: Ecken (world, Y oben), Grundfarbe (Vertexfarbe, wie im Shader 0..1), Material-Ebene
/// der Szene (`ChunkData::layers`, ≥ 1 = Bildkarte/Baustoff, `TERRAIN_LAYER` = Gelände ohne Material, sonst keine;
/// s. `pt_material.rs`) und die UV der Ecken in Metern (`mesh::planar_uv`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PtTri {
    pub v: [[f32; 3]; 3],
    pub color: [f32; 3],
    pub layer: i32,
    pub uv: [[f32; 2]; 3],
}

/// UV ohne Zuordnung (Tests, Eingaben ohne Normale).
pub const NO_UV: [[f32; 2]; 3] = [[0.0; 2]; 3];

/// Knoten, 32 Byte, 1:1 zum WGSL-`Node`: `count > 0` = Blatt mit Dreiecken `[left_first, left_first + count)`,
/// sonst innen mit Kindern `left_first` und `left_first + 1`.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
#[cfg_attr(feature = "render", derive(bytemuck::Pod, bytemuck::Zeroable))]
pub struct GpuNode {
    pub min: [f32; 3],
    pub left_first: u32,
    pub max: [f32; 3],
    pub count: u32,
}

/// Dreieck, 48 Byte, 1:1 zum WGSL-`Tri`: Ecke `v0`, Kanten `e1 = v1 − v0`, `e2 = v2 − v0` (Möller–Trumbore),
/// `mat` = Grundfarbe linear RGB8 (Bits 0..24) + Art (Bits 24..32), `rough` = GGX-Rauigkeit, `metal` = Metall-Anteil
/// der glänzenden Schicht (0 dielektrisch, 1 Metall; aus der Materialtabelle).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
#[cfg_attr(feature = "render", derive(bytemuck::Pod, bytemuck::Zeroable))]
pub struct GpuTri {
    pub v0: [f32; 3],
    pub mat: u32,
    pub e1: [f32; 3],
    pub rough: f32,
    pub e2: [f32; 3],
    pub metal: f32,
}

/// Texturdaten je Dreieck, 32 Byte, 1:1 zum WGSL-`TriTex`, parallel zu `GpuTri`: UV der Ecken (Meter), `tex` =
/// Textur-Ebene (Bits 0..16, 0 = keine Bildkarte) + prozedurale Textur (Bits 16..24, `pt_material::PROC_*`) + Detail-
/// Ebene lesen (Bit 24, Normalen-/Rauigkeitskarte, Etappe 4), `scale` = 1 / Kachelgrösse.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
#[cfg_attr(feature = "render", derive(bytemuck::Pod, bytemuck::Zeroable))]
pub struct GpuTriTex {
    pub uv0: [f32; 2],
    pub uv1: [f32; 2],
    pub uv2: [f32; 2],
    pub tex: u32,
    pub scale: f32,
}

impl GpuTriTex {
    pub fn layer(&self) -> u32 {
        self.tex & 0xFFFF
    }
    pub fn proc(&self) -> u32 {
        (self.tex >> 16) & 0xFF
    }
    pub fn detail(&self) -> bool {
        (self.tex >> 24) & 1 == 1
    }
}

/// UV am Punkt mit den baryzentrischen Koordinaten (u, v) von Möller–Trumbore (Gewicht u auf Ecke 1, v auf Ecke 2),
/// mit `scale` — wie der Shader (`tri_uv`).
pub fn interp_uv(t: &GpuTriTex, u: f32, v: f32) -> [f32; 2] {
    let w = 1.0 - u - v;
    [(t.uv0[0] * w + t.uv1[0] * u + t.uv2[0] * v) * t.scale, (t.uv0[1] * w + t.uv1[1] * u + t.uv2[1] * v) * t.scale]
}

/// Material aus der Vertexfarbe (Etappe 1; Rückgabe Art, Rauigkeit) — s. `pt_material::classify_color`.
pub fn classify_material(color: [f32; 3]) -> (u32, f32) {
    let m = classify_color(color);
    (m.kind, m.rough)
}

/// Höchste Albedo (energieerhaltend, wie der Blender-Leser [211]: ≤ 0.8).
const MAX_ALBEDO: f32 = 0.8;

/// Grundfarbe linear (0..1) aus `GpuTri::mat` (wie `unpack_albedo` im Shader).
pub fn unpack_linear(mat: u32) -> [f32; 3] {
    [(mat & 0xFF) as f32 / 255.0, ((mat >> 8) & 0xFF) as f32 / 255.0, ((mat >> 16) & 0xFF) as f32 / 255.0]
}

fn pack_mat(color: [f32; 3], kind: u32) -> u32 {
    let mut out = kind << 24;
    for (k, c) in color.iter().enumerate() {
        let lin = if c.is_finite() { srgb_to_linear(c.clamp(0.0, 1.0)).min(MAX_ALBEDO) } else { 0.5 };
        out |= ((lin * 255.0).round() as u32 & 0xFF) << (8 * k);
    }
    out
}

/// Liest Dreiecke aus einem `Mesh`-Puffer (`[pos, normal, color]` je Ecke, `FLOATS_PER_VERTEX`) und hängt sie an.
/// Kaputte Indizes fallen weg (nicht endliche Ecken verwirft der Baum). Farbe = Mittel der drei Ecken (Luftbild-
/// Vertexfarben); UV je Ecke wie die schattierte Ansicht (`mesh::planar_uv`).
/// `layers` = Material-Ebene je Vertex (`ChunkData::layers`; leer/zu kurz = keine).
pub fn tris_from_mesh(verts: &[f32], indices: &[u32], layers: &[f32], out: &mut Vec<PtTri>) {
    let stride = crate::types::FLOATS_PER_VERTEX;
    let n = verts.len() / stride;
    for t in indices.chunks_exact(3) {
        if t.iter().any(|&i| i as usize >= n) {
            continue;
        }
        let at = |i: u32, o: usize| {
            let b = i as usize * stride + o;
            [verts[b], verts[b + 1], verts[b + 2]]
        };
        let v = [at(t[0], 0), at(t[1], 0), at(t[2], 0)];
        let n = [at(t[0], 3), at(t[1], 3), at(t[2], 3)];
        let uv = [crate::mesh::planar_uv(v[0], n[0]), crate::mesh::planar_uv(v[1], n[1]), crate::mesh::planar_uv(v[2], n[2])];
        let c = [at(t[0], 6), at(t[1], 6), at(t[2], 6)];
        // Glas/Stahl nur bei gleicher Farbe an allen Ecken (sonst Mittelwert, z. B. Luftbild).
        let color = if c[0] == c[1] && c[1] == c[2] {
            c[0]
        } else {
            [(c[0][0] + c[1][0] + c[2][0]) / 3.0, (c[0][1] + c[1][1] + c[2][1]) / 3.0, (c[0][2] + c[1][2] + c[2][2]) / 3.0]
        };
        let layer = layers
            .get(t[0] as usize)
            .filter(|l| l.is_finite() && ((**l >= 1.0 && **l < 1e6) || **l == TERRAIN_LAYER as f32))
            .map_or(-1, |l| l.round() as i32);
        let uv = if uv.iter().flatten().all(|c| c.is_finite()) { uv } else { NO_UV };
        out.push(PtTri { v, color, layer, uv });
    }
}

/// Der gebaute Baum.
#[derive(Clone, Debug, Default)]
pub struct Bvh {
    pub nodes: Vec<GpuNode>,
    pub tris: Vec<GpuTri>,
    /// Texturdaten je Dreieck (gleiche Reihenfolge wie `tris`).
    pub tex: Vec<GpuTriTex>,
    /// [212] Etappe 5: Lichtliste (Portale, Leuchten, Raumlicht; `pt_lights.rs`).
    pub lights: crate::pt_lights::LightList,
    /// Platz im Baum je Eingabe-Dreieck (`NO_SLOT` = verworfen) — für `refit`.
    slots: Vec<u32>,
    /// SAH-Kosten nach dem Bau (Vergleich nach `refit`).
    sah_built: f32,
}

/// Eingabe-Dreieck ohne Platz im Baum (nicht endlich, entartet oder Doppelseite).
const NO_SLOT: u32 = u32::MAX;
/// Nach einem `refit` darf der Baum höchstens so viel teurer sein (SAH) als frisch gebaut, sonst Neubau.
pub const REFIT_MAX_COST: f32 = 1.3;

fn sub(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
fn cross(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}
fn dot(a: [f32; 3], b: [f32; 3]) -> f32 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

#[derive(Clone, Copy)]
struct Aabb {
    min: [f32; 3],
    max: [f32; 3],
}

impl Aabb {
    const EMPTY: Aabb = Aabb { min: [f32::INFINITY; 3], max: [f32::NEG_INFINITY; 3] };
    fn grow_p(&mut self, p: [f32; 3]) {
        for k in 0..3 {
            self.min[k] = self.min[k].min(p[k]);
            self.max[k] = self.max[k].max(p[k]);
        }
    }
    fn grow(&mut self, b: &Aabb) {
        for k in 0..3 {
            self.min[k] = self.min[k].min(b.min[k]);
            self.max[k] = self.max[k].max(b.max[k]);
        }
    }
    fn area(&self) -> f32 {
        let e = sub(self.max, self.min);
        if e.iter().any(|v| *v < 0.0) {
            return 0.0;
        }
        2.0 * (e[0] * e[1] + e[1] * e[2] + e[2] * e[0])
    }
}

/// Schlüssel eines Dreiecks unabhängig von Eckenfolge und Windung (Doppelseiten erkennen): gerundete Ecken, sortiert.
fn tri_key(v: &[[f32; 3]; 3]) -> [[i64; 3]; 3] {
    let q = |p: [f32; 3]| [(p[0] as f64 * 1e5).round() as i64, (p[1] as f64 * 1e5).round() as i64, (p[2] as f64 * 1e5).round() as i64];
    let mut k = [q(v[0]), q(v[1]), q(v[2])];
    k.sort();
    k
}

/// Welche Eingabe-Dreiecke in den Baum kommen: endlich, nicht entartet, je Doppelseite das erste.
fn kept_inputs(input: &[PtTri]) -> Vec<bool> {
    let mut seen: HashSet<[[i64; 3]; 3]> = HashSet::with_capacity(input.len());
    input
        .iter()
        .map(|t| {
            if !t.v.iter().flatten().all(|c| c.is_finite() && c.abs() < 1e7) {
                return false;
            }
            let n = cross(sub(t.v[1], t.v[0]), sub(t.v[2], t.v[0]));
            dot(n, n) > 1e-18 && seen.insert(tri_key(&t.v))
        })
        .collect()
}

/// GPU-Dreieck und Texturdaten eines Eingabe-Dreiecks (Material aus Tabelle und Vertexfarbe).
fn gpu_tri(t: &PtTri, table: &PtMaterialTable) -> (GpuTri, GpuTriTex) {
    let (m, color) = table.resolve(t.layer, t.color);
    let tx = table.tex_for(t.layer, &m);
    (
        GpuTri { v0: t.v[0], mat: pack_mat(color, m.kind), e1: sub(t.v[1], t.v[0]), rough: m.rough, e2: sub(t.v[2], t.v[0]), metal: m.metal },
        GpuTriTex { uv0: t.uv[0], uv1: t.uv[1], uv2: t.uv[2], tex: (tx.layer & 0xFFFF) | ((tx.proc & 0xFF) << 16) | ((tx.detail as u32) << 24), scale: tx.scale },
    )
}

impl Bvh {
    pub fn tri_count(&self) -> usize {
        self.tris.len()
    }

    /// Baut den Baum (Binned-SAH) ohne Materialtabelle (Material aus der Vertexfarbe).
    pub fn build(input: &[PtTri]) -> Bvh {
        Self::build_with(input, &PtMaterialTable::default())
    }

    /// Baut den Baum (Binned-SAH). Ungültige Dreiecke fallen weg (s. Moduldoc); leer → leerer Baum. Material je
    /// Dreieck aus `table` (Ebene) und Vertexfarbe aufgelöst.
    pub fn build_with(input: &[PtTri], table: &PtMaterialTable) -> Bvh {
        let keep = kept_inputs(input);
        let tris: Vec<PtTri> = input.iter().zip(&keep).filter(|(_, k)| **k).map(|(t, _)| *t).collect();
        if tris.is_empty() {
            return Bvh { slots: vec![NO_SLOT; input.len()], ..Bvh::default() };
        }
        let bounds: Vec<Aabb> = tris
            .iter()
            .map(|t| {
                let mut b = Aabb::EMPTY;
                t.v.iter().for_each(|p| b.grow_p(*p));
                b
            })
            .collect();
        let cent: Vec<[f32; 3]> = bounds.iter().map(|b| [(b.min[0] + b.max[0]) * 0.5, (b.min[1] + b.max[1]) * 0.5, (b.min[2] + b.max[2]) * 0.5]).collect();
        let mut order: Vec<u32> = (0..tris.len() as u32).collect();
        let mut nodes: Vec<GpuNode> = Vec::with_capacity(tris.len() * 2 / MAX_LEAF.max(1) + 2);
        nodes.push(GpuNode::default());
        // Stapel: (Knoten, erster, Anzahl, Tiefe)
        let mut stack: Vec<(usize, usize, usize, usize)> = vec![(0, 0, tris.len(), 0)];
        while let Some((ni, first, count, depth)) = stack.pop() {
            let idx = &mut order[first..first + count];
            let mut nb = Aabb::EMPTY;
            let mut cb = Aabb::EMPTY;
            for &i in idx.iter() {
                nb.grow(&bounds[i as usize]);
                cb.grow_p(cent[i as usize]);
            }
            nodes[ni].min = nb.min;
            nodes[ni].max = nb.max;
            let leaf = |nodes: &mut Vec<GpuNode>| {
                nodes[ni].left_first = first as u32;
                nodes[ni].count = count as u32;
            };
            if count <= 2 || depth >= MAX_DEPTH {
                leaf(&mut nodes);
                continue;
            }
            // Binned-SAH über alle drei Achsen.
            let mut best: Option<(usize, usize, f32)> = None; // (Achse, Grenz-Fach, Kosten)
            for axis in 0..3 {
                let lo = cb.min[axis];
                let ext = cb.max[axis] - lo;
                if !(ext > 1e-9) {
                    continue;
                }
                let scale = BINS as f32 / ext;
                let mut bin_b = [Aabb::EMPTY; BINS];
                let mut bin_n = [0usize; BINS];
                for &i in idx.iter() {
                    let b = (((cent[i as usize][axis] - lo) * scale) as usize).min(BINS - 1);
                    bin_n[b] += 1;
                    bin_b[b].grow(&bounds[i as usize]);
                }
                // Präfix von links, Suffix von rechts.
                let mut left_area = [0.0f32; BINS];
                let mut left_n = [0usize; BINS];
                let (mut acc, mut n) = (Aabb::EMPTY, 0usize);
                for b in 0..BINS - 1 {
                    acc.grow(&bin_b[b]);
                    n += bin_n[b];
                    left_area[b] = acc.area();
                    left_n[b] = n;
                }
                let (mut acc, mut n) = (Aabb::EMPTY, 0usize);
                for b in (1..BINS).rev() {
                    acc.grow(&bin_b[b]);
                    n += bin_n[b];
                    let l = b - 1;
                    if left_n[l] == 0 || n == 0 {
                        continue;
                    }
                    let cost = left_area[l] * left_n[l] as f32 + acc.area() * n as f32;
                    if best.map_or(true, |(_, _, c)| cost < c) {
                        best = Some((axis, b, cost));
                    }
                }
            }
            let parent_area = nb.area().max(1e-12);
            let split = best.filter(|&(_, _, c)| {
                let split_cost = TRAVERSAL_COST + c / parent_area;
                split_cost < count as f32 || count > MAX_LEAF
            });
            let Some((axis, bin, _)) = split else {
                // Kein sinnvoller Schnitt (alle Mitten gleich): bei vielen Dreiecken halbieren, sonst Blatt.
                if count > MAX_LEAF * 4 && depth < MAX_DEPTH {
                    let half = count / 2;
                    let c = nodes.len();
                    nodes.push(GpuNode::default());
                    nodes.push(GpuNode::default());
                    nodes[ni].left_first = c as u32;
                    nodes[ni].count = 0;
                    stack.push((c, first, half, depth + 1));
                    stack.push((c + 1, first + half, count - half, depth + 1));
                } else {
                    leaf(&mut nodes);
                }
                continue;
            };
            let lo = cb.min[axis];
            let scale = BINS as f32 / (cb.max[axis] - lo);
            // Partition: Fach < bin links.
            let mut i = 0usize;
            let mut j = count;
            while i < j {
                let b = (((cent[idx[i] as usize][axis] - lo) * scale) as usize).min(BINS - 1);
                if b < bin {
                    i += 1;
                } else {
                    j -= 1;
                    idx.swap(i, j);
                }
            }
            if i == 0 || i == count {
                leaf(&mut nodes);
                continue;
            }
            let c = nodes.len();
            nodes.push(GpuNode::default());
            nodes.push(GpuNode::default());
            nodes[ni].left_first = c as u32;
            nodes[ni].count = 0;
            stack.push((c, first, i, depth + 1));
            stack.push((c + 1, first + i, count - i, depth + 1));
        }
        let mut gpu_tris = Vec::with_capacity(order.len());
        let mut gpu_tex = Vec::with_capacity(order.len());
        for &i in &order {
            let (g, x) = gpu_tri(&tris[i as usize], table);
            gpu_tris.push(g);
            gpu_tex.push(x);
        }
        // Platz je Eingabe: k-tes behaltene Dreieck liegt an der Stelle, an der `order` es nennt.
        let mut slot_of_kept = vec![0u32; tris.len()];
        for (slot, &k) in order.iter().enumerate() {
            slot_of_kept[k as usize] = slot as u32;
        }
        let mut slots = Vec::with_capacity(input.len());
        let mut k = 0usize;
        for &kept in &keep {
            if kept {
                slots.push(slot_of_kept[k]);
                k += 1;
            } else {
                slots.push(NO_SLOT);
            }
        }
        let mut bvh = Bvh { nodes, tris: gpu_tris, tex: gpu_tex, lights: Default::default(), slots, sah_built: 0.0 };
        bvh.sah_built = bvh.sah_cost();
        bvh.lights = crate::pt_lights::build_lights(&mut bvh);
        bvh
    }

    /// [212] Etappe 5, Teil-Update: dieselben Eingabe-Dreiecke an neuer Lage (gleiche Zahl, gleiche verworfene — z. B. ein
    /// verschobenes Objekt) bekommen die alte Baumstruktur mit neu gerechneten Hüllen (Refit, von den Blättern zur
    /// Wurzel), Material und UV neu aufgelöst, Lichtliste neu. `false` (Baum unverändert) = Neubau nötig: andere Topologie
    /// oder der Baum wäre um mehr als `REFIT_MAX_COST` teurer als frisch gebaut.
    pub fn refit(&mut self, input: &[PtTri], table: &PtMaterialTable) -> bool {
        if input.len() != self.slots.len() || self.tris.is_empty() {
            return false;
        }
        let keep = kept_inputs(input);
        if keep.iter().zip(&self.slots).any(|(k, s)| *k != (*s != NO_SLOT)) {
            return false;
        }
        let (old_nodes, old_tris, old_tex) = (self.nodes.clone(), self.tris.clone(), self.tex.clone());
        for (t, &s) in input.iter().zip(&self.slots) {
            if s != NO_SLOT {
                let (g, x) = gpu_tri(t, table);
                self.tris[s as usize] = g;
                self.tex[s as usize] = x;
            }
        }
        // Kinder liegen immer hinter dem Elternknoten (Bau-Reihenfolge): rückwärts sind sie fertig, bevor er dran ist.
        for ni in (0..self.nodes.len()).rev() {
            let n = self.nodes[ni];
            let mut b = Aabb::EMPTY;
            if n.count > 0 {
                for t in &self.tris[n.left_first as usize..(n.left_first + n.count) as usize] {
                    b.grow_p(t.v0);
                    b.grow_p([t.v0[0] + t.e1[0], t.v0[1] + t.e1[1], t.v0[2] + t.e1[2]]);
                    b.grow_p([t.v0[0] + t.e2[0], t.v0[1] + t.e2[1], t.v0[2] + t.e2[2]]);
                }
            } else {
                for c in [n.left_first as usize, n.left_first as usize + 1] {
                    b.grow(&Aabb { min: self.nodes[c].min, max: self.nodes[c].max });
                }
            }
            self.nodes[ni].min = b.min;
            self.nodes[ni].max = b.max;
        }
        if self.sah_cost() > self.sah_built * REFIT_MAX_COST {
            self.nodes = old_nodes;
            self.tris = old_tris;
            self.tex = old_tex;
            return false;
        }
        self.lights = crate::pt_lights::build_lights(self);
        true
    }

    /// SAH-Kosten des Baums relativ zur Wurzel (Knoten 1, Dreieckstest 1): Σ Fläche(Knoten)/Fläche(Wurzel) · (innen:
    /// `TRAVERSAL_COST`, Blatt: Zahl der Dreiecke). Mass der Baumgüte (Refit-Grenze, Tests).
    pub fn sah_cost(&self) -> f32 {
        let Some(root) = self.nodes.first() else { return 0.0 };
        let ra = Aabb { min: root.min, max: root.max }.area().max(1e-12);
        self.nodes
            .iter()
            .map(|n| Aabb { min: n.min, max: n.max }.area() / ra * if n.count > 0 { n.count as f32 } else { TRAVERSAL_COST })
            .sum()
    }

    /// Strahl gegen ein Dreieck (Möller–Trumbore); `t` im offenen Intervall (`tmin`, `tmax`).
    fn hit_tri(t: &GpuTri, o: [f32; 3], d: [f32; 3], tmin: f32, tmax: f32) -> Option<f32> {
        let p = cross(d, t.e2);
        let det = dot(t.e1, p);
        if det.abs() < 1e-12 {
            return None;
        }
        let inv = 1.0 / det;
        let s = sub(o, t.v0);
        let u = dot(s, p) * inv;
        if !(0.0..=1.0).contains(&u) {
            return None;
        }
        let q = cross(s, t.e1);
        let v = dot(d, q) * inv;
        if v < 0.0 || u + v > 1.0 {
            return None;
        }
        let tt = dot(t.e2, q) * inv;
        (tt > tmin && tt < tmax).then_some(tt)
    }

    fn hit_box(n: &GpuNode, o: [f32; 3], inv: [f32; 3], tmax: f32) -> Option<f32> {
        let (mut t0, mut t1) = (0.0f32, tmax);
        for k in 0..3 {
            let a = (n.min[k] - o[k]) * inv[k];
            let b = (n.max[k] - o[k]) * inv[k];
            let (lo, hi) = if a < b { (a, b) } else { (b, a) };
            // NaN (0 · ∞ bei Strahl in der Ebene der Box) lässt die Grenze stehen.
            if lo > t0 {
                t0 = lo;
            }
            if hi < t1 {
                t1 = hi;
            }
        }
        (t0 <= t1).then_some(t0)
    }

    /// Nächster Treffer (t, Dreiecks-Index) — dieselbe Traversierung wie der Shader.
    pub fn intersect(&self, o: [f32; 3], d: [f32; 3], tmax: f32) -> Option<(f32, usize)> {
        if self.tris.is_empty() || self.nodes.is_empty() {
            return None;
        }
        let inv = d.map(|c| if c.abs() > 1e-20 { 1.0 / c } else { 1e30f32.copysign(c) });
        let mut best: Option<(f32, usize)> = None;
        let mut tbest = tmax;
        Self::hit_box(&self.nodes[0], o, inv, tbest)?;
        let mut stack: Vec<u32> = vec![0];
        while let Some(ni) = stack.pop() {
            let n = &self.nodes[ni as usize];
            if Self::hit_box(n, o, inv, tbest).is_none() {
                continue;
            }
            if n.count > 0 {
                for ti in n.left_first..n.left_first + n.count {
                    if let Some(t) = Self::hit_tri(&self.tris[ti as usize], o, d, 1e-6, tbest) {
                        tbest = t;
                        best = Some((t, ti as usize));
                    }
                }
            } else {
                stack.push(n.left_first);
                stack.push(n.left_first + 1);
            }
        }
        best
    }

    /// Brute-Force-Treffer über alle Dreiecke (Referenz der Tests).
    pub fn intersect_brute(&self, o: [f32; 3], d: [f32; 3], tmax: f32) -> Option<(f32, usize)> {
        let mut best: Option<(f32, usize)> = None;
        let mut tbest = tmax;
        for (i, t) in self.tris.iter().enumerate() {
            if let Some(tt) = Self::hit_tri(t, o, d, 1e-6, tbest) {
                tbest = tt;
                best = Some((tt, i));
            }
        }
        best
    }

    /// Größte Baumtiefe (Test: Stapel im Shader reicht).
    pub fn depth(&self) -> usize {
        if self.nodes.is_empty() {
            return 0;
        }
        let mut max = 0;
        let mut stack = vec![(0u32, 1usize)];
        while let Some((ni, d)) = stack.pop() {
            max = max.max(d);
            let n = &self.nodes[ni as usize];
            if n.count == 0 {
                stack.push((n.left_first, d + 1));
                stack.push((n.left_first + 1, d + 1));
            }
        }
        max
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Deterministischer Zufall (xorshift) für reproduzierbare Tests.
    struct Rng(u64);
    impl Rng {
        fn f(&mut self) -> f32 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            (self.0 >> 40) as f32 / (1u64 << 24) as f32
        }
        fn v(&mut self, s: f32) -> [f32; 3] {
            [(self.f() - 0.5) * s, (self.f() - 0.5) * s, (self.f() - 0.5) * s]
        }
    }

    fn soup(n: usize, seed: u64) -> Vec<PtTri> {
        let mut r = Rng(seed);
        (0..n)
            .map(|_| {
                let c = r.v(20.0);
                let a = r.v(1.5);
                let b = r.v(1.5);
                let d = r.v(1.5);
                PtTri { v: [[c[0] + a[0], c[1] + a[1], c[2] + a[2]], [c[0] + b[0], c[1] + b[1], c[2] + b[2]], [c[0] + d[0], c[1] + d[1], c[2] + d[2]]], color: [0.5, 0.5, 0.5], layer: -1, uv: NO_UV }
            })
            .collect()
    }

    #[test]
    fn treffer_wie_brute_force() {
        let bvh = Bvh::build(&soup(3000, 7));
        assert_eq!(bvh.tri_count(), 3000);
        assert!(bvh.depth() <= MAX_DEPTH + 1, "Tiefe {}", bvh.depth());
        let mut r = Rng(99);
        let mut hits = 0;
        for _ in 0..2000 {
            let o = r.v(40.0);
            let mut d = r.v(2.0);
            let l = dot(d, d).sqrt().max(1e-6);
            d = d.map(|c| c / l);
            let a = bvh.intersect(o, d, f32::INFINITY);
            let b = bvh.intersect_brute(o, d, f32::INFINITY);
            match (a, b) {
                (Some((ta, _)), Some((tb, _))) => {
                    assert!((ta - tb).abs() < 1e-4, "{ta} vs {tb}");
                    hits += 1;
                }
                (None, None) => {}
                _ => panic!("BVH {a:?} ≠ Brute-Force {b:?}"),
            }
        }
        assert!(hits > 100, "zu wenige Treffer im Test ({hits})");
    }

    #[test]
    fn achsparallele_strahlen_und_wuerfel() {
        // Würfel aus 12 Dreiecken plus Boden: Strahlen genau entlang der Achsen (inv = ±∞ in zwei Komponenten).
        let p = |x: f32, y: f32, z: f32| [x, y, z];
        let q = |a, b, c, d| [PtTri { v: [a, b, c], color: [0.8; 3], layer: -1, uv: NO_UV }, PtTri { v: [a, c, d], color: [0.8; 3], layer: -1, uv: NO_UV }];
        let mut tris = Vec::new();
        tris.extend(q(p(0., 0., 0.), p(1., 0., 0.), p(1., 1., 0.), p(0., 1., 0.)));
        tris.extend(q(p(0., 0., 1.), p(1., 0., 1.), p(1., 1., 1.), p(0., 1., 1.)));
        tris.extend(q(p(0., 0., 0.), p(0., 1., 0.), p(0., 1., 1.), p(0., 0., 1.)));
        tris.extend(q(p(1., 0., 0.), p(1., 1., 0.), p(1., 1., 1.), p(1., 0., 1.)));
        tris.extend(q(p(0., 0., 0.), p(1., 0., 0.), p(1., 0., 1.), p(0., 0., 1.)));
        tris.extend(q(p(0., 1., 0.), p(1., 1., 0.), p(1., 1., 1.), p(0., 1., 1.)));
        tris.extend(q(p(-5., -1., -5.), p(5., -1., -5.), p(5., -1., 5.), p(-5., -1., 5.)));
        let bvh = Bvh::build(&tris);
        let (t, _) = bvh.intersect([0.5, 5.0, 0.5], [0.0, -1.0, 0.0], f32::INFINITY).expect("Würfel von oben");
        assert!((t - 4.0).abs() < 1e-5);
        // Unter dem Würfel durch, parallel zum Boden: kein Treffer.
        assert!(bvh.intersect([3.0, -0.5, 0.5], [-1.0, 0.0, 0.0], f32::INFINITY).is_none());
        assert!(bvh.intersect_brute([3.0, -0.5, 0.5], [-1.0, 0.0, 0.0], f32::INFINITY).is_none());
        let (t, _) = bvh.intersect([0.5, 0.5, -3.0], [0.0, 0.0, 1.0], f32::INFINITY).expect("Würfel von vorn");
        assert!((t - 3.0).abs() < 1e-5);
        assert!(bvh.intersect([0.5, 0.5, -3.0], [0.0, 0.0, 1.0], 2.0).is_none(), "tmax begrenzt");
        let (t, _) = bvh.intersect([0.5, -0.5, 0.5], [0.0, -1.0, 0.0], f32::INFINITY).expect("Boden");
        assert!((t - 0.5).abs() < 1e-5, "{t}");
    }

    #[test]
    fn leere_und_kaputte_eingaben_ohne_panic() {
        let empty = Bvh::build(&[]);
        assert_eq!(empty.tri_count(), 0);
        assert!(empty.intersect([0.0; 3], [0.0, 0.0, 1.0], f32::INFINITY).is_none());
        let bad = [
            PtTri { v: [[f32::NAN, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]], color: [0.5; 3], layer: -1, uv: NO_UV },
            PtTri { v: [[0.0; 3], [0.0; 3], [0.0; 3]], color: [0.5; 3], layer: -1, uv: NO_UV },
            PtTri { v: [[0.0; 3], [1.0, 1.0, 1.0], [2.0, 2.0, 2.0]], color: [0.5; 3], layer: -1, uv: NO_UV },
            PtTri { v: [[f32::INFINITY, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]], color: [f32::NAN; 3], layer: -1, uv: NO_UV },
        ];
        let b = Bvh::build(&bad);
        assert_eq!(b.tri_count(), 0, "alle verworfen");
        assert!(b.intersect([0.0; 3], [f32::NAN, 0.0, 1.0], 1.0).is_none());
        // Kaputte Indizes / zu kurze Puffer im Netz-Leser.
        let mut out = Vec::new();
        tris_from_mesh(&[0.0; 10], &[0, 1, 2, 5, 9, 99], &[], &mut out);
        assert!(out.is_empty());
        tris_from_mesh(&[], &[0, 0, 0], &[f32::NAN], &mut out);
        assert!(out.is_empty());
        // Gleiche Mitte bei vielen Dreiecken (alle Mitten gleich) → kein endloses Teilen.
        let same: Vec<PtTri> = (0..500)
            .map(|i| {
                let s = 1.0 + i as f32 * 0.01;
                PtTri { v: [[-s, 0.0, 0.0], [s, 0.0, 0.1 * s], [0.0, 0.0, -0.1 * s]], color: [0.5; 3], layer: -1, uv: NO_UV }
            })
            .collect();
        let b = Bvh::build(&same);
        assert_eq!(b.tri_count(), 500);
        assert!(b.depth() <= MAX_DEPTH + 1);
        let t = b.intersect([0.0, 3.0, 0.0], [0.0, -1.0, 0.0], f32::INFINITY).expect("Treffer").0;
        assert!((t - 3.0).abs() < 1e-5, "{t}");
    }

    #[test]
    fn doppelseiten_einmal_und_material() {
        let a = PtTri { v: [[0.0; 3], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]], color: GLASS_RGB, layer: -1, uv: NO_UV };
        let b = PtTri { v: [[0.0; 3], [0.0, 1.0, 0.0], [1.0, 0.0, 0.0]], color: GLASS_RGB, layer: -1, uv: NO_UV };
        let bvh = Bvh::build(&[a, b]);
        assert_eq!(bvh.tri_count(), 1);
        assert_eq!(bvh.tris[0].mat >> 24, MAT_GLASS);
        assert_eq!(classify_material(STEEL_RGB).0, MAT_GLOSSY);
        assert_eq!(classify_material([0.85, 0.85, 0.83]).0, MAT_DIFFUSE);
        // Albedo linear und gekappt.
        let w = pack_mat([1.0, 1.0, 1.0], MAT_DIFFUSE);
        assert_eq!(w & 0xFF, (MAX_ALBEDO * 255.0).round() as u32);
    }

    #[test]
    fn netz_leser_nimmt_vertexfarben() {
        // Ein Dreieck im Mesh-Format [pos, normal, color].
        let mut v = Vec::new();
        for p in [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 0.0, 1.0]] {
            v.extend_from_slice(&p);
            v.extend_from_slice(&[0.0, 1.0, 0.0]);
            v.extend_from_slice(&STEEL_RGB);
        }
        let mut out = Vec::new();
        tris_from_mesh(&v, &[0, 1, 2], &[], &mut out);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].color, STEEL_RGB);
        assert_eq!(out[0].layer, -1);
        // Material-Ebene je Vertex (Ebene des ersten Ecks); 0, NaN und negative = keine.
        for (layers, want) in [(vec![2.0, 2.0, 2.0], 2), (vec![0.0; 3], -1), (vec![f32::NAN; 3], -1), (vec![-1.0; 3], -1)] {
            out.clear();
            tris_from_mesh(&v, &[0, 1, 2], &layers, &mut out);
            assert_eq!(out[0].layer, want, "{layers:?}");
        }
    }

    /// [212] Etappe 2: Material je Dreieck aus der Tabelle (Ebene), aufgelöst ins GPU-Dreieck.
    #[test]
    fn materialtabelle_im_baum() {
        let tri = |x: f32, layer: i32| PtTri { v: [[x, 0.0, 0.0], [x + 1.0, 0.0, 0.0], [x, 1.0, 0.0]], color: [1.0; 3], layer, uv: NO_UV };
        let table = PtMaterialTable::from_entries(&[
            crate::pt_material::PtMaterialEntry { name: "Trapezblech".into(), map: String::new(), size: None, ..Default::default() },
            crate::pt_material::PtMaterialEntry { name: "Backstein".into(), map: String::new(), size: None, ..Default::default() },
        ]);
        let bvh = Bvh::build_with(&[tri(0.0, 1), tri(5.0, 2), tri(10.0, -1)], &table);
        let at = |x: f32| bvh.tris.iter().find(|t| t.v0[0] == x).unwrap();
        assert_eq!(at(0.0).mat >> 24, MAT_GLOSSY);
        assert_eq!(at(0.0).metal, 1.0);
        assert!((at(0.0).rough - 0.35).abs() < 1e-6);
        // Backstein: diffus, Farbe aus der Tabelle (linear gepackt), nicht weiss.
        let b = at(5.0);
        assert_eq!(b.mat >> 24, MAT_DIFFUSE);
        assert_eq!(b.mat & 0xFF, (srgb_to_linear(0.60) * 255.0).round() as u32);
        assert!((b.mat >> 8) & 0xFF < b.mat & 0xFF, "rötlich");
        // Ohne Ebene: weiss diffus wie bisher.
        assert_eq!(at(10.0).mat, pack_mat([1.0; 3], MAT_DIFFUSE));
        assert_eq!(at(10.0).metal, 0.0);
        // Ohne Tabelle (Etappe 1): alles aus der Vertexfarbe.
        let plain = Bvh::build(&[tri(0.0, 1)]);
        assert_eq!(plain.tris[0].mat >> 24, MAT_DIFFUSE);
    }

    /// [212] Etappe 3: UV je Dreieck wie die schattierte Ansicht, im Parallel-Puffer in der Reihenfolge des Baums,
    /// baryzentrisch interpoliert gleich der UV des Trefferpunkts; Gelände-Ebene bleibt erhalten und wird Wiese.
    #[test]
    fn uv_je_dreieck_und_interpolation() {
        // Senkrechte Wand in der Ebene z = 2 (Normale +z) und ein Bodenstück (Normale +y), Mesh-Format.
        let mut v = Vec::new();
        let mut push = |p: [f32; 3], n: [f32; 3]| {
            v.extend_from_slice(&p);
            v.extend_from_slice(&n);
            v.extend_from_slice(&[1.0, 1.0, 1.0]);
        };
        for p in [[1.0, 0.0, 2.0], [4.0, 0.0, 2.0], [4.0, 3.0, 2.0]] {
            push(p, [0.0, 0.0, 1.0]);
        }
        for p in [[0.0, -1.0, 0.0], [5.0, -1.0, 0.0], [0.0, -1.0, 5.0]] {
            push(p, [0.0, 1.0, 0.0]);
        }
        let mut tris = Vec::new();
        tris_from_mesh(&v, &[0, 1, 2, 3, 4, 5], &[3.0, 3.0, 3.0, -2.0, -2.0, -2.0], &mut tris);
        assert_eq!(tris.len(), 2);
        // Wand: u längs der Tangente (-n.z, 0, n.x) = (-1, 0, 0) → u = -x, v = Höhe.
        assert_eq!(tris[0].uv, [[-1.0, 0.0], [-4.0, 0.0], [-4.0, 3.0]]);
        assert_eq!(tris[0].layer, 3);
        // Boden: Grundriss (x, z); Gelände-Ebene erhalten.
        assert_eq!(tris[1].uv, [[0.0, 0.0], [5.0, 0.0], [0.0, 5.0]]);
        assert_eq!(tris[1].layer, TERRAIN_LAYER);
        let table = PtMaterialTable::from_entries(&[
            crate::pt_material::PtMaterialEntry::default(),
            crate::pt_material::PtMaterialEntry::default(),
            crate::pt_material::PtMaterialEntry { name: "Backstein".into(), map: String::new(), size: Some(0.5), ..Default::default() },
        ]);
        let bvh = Bvh::build_with(&tris, &table);
        assert_eq!(bvh.tex.len(), bvh.tris.len());
        // Parallel-Puffer in Baum-Reihenfolge: UV von Ecke 0 gehört zu `v0` desselben Dreiecks.
        for (t, x) in bvh.tris.iter().zip(&bvh.tex) {
            let n = if t.e1[1] == 0.0 && t.e2[1] == 0.0 { [0.0, 1.0, 0.0] } else { [0.0, 0.0, 1.0] };
            assert_eq!(x.uv0, crate::mesh::planar_uv(t.v0, n));
        }
        let wall = bvh.tex.iter().position(|x| x.uv0 == [-1.0, 0.0]).unwrap();
        // Backstein ohne geladene Karte: keine Bildkarte, keine Prozedur, Massstab 1 / 0.5 m.
        assert_eq!((bvh.tex[wall].layer(), bvh.tex[wall].proc(), bvh.tex[wall].scale), (0, 0, 2.0));
        let ground = 1 - wall;
        assert_eq!(bvh.tex[ground].proc(), crate::pt_material::PROC_GRASS);
        assert_eq!(bvh.tris[ground].mat >> 24, MAT_DIFFUSE);
        // Interpolation: Strahl auf die Wand trifft (x, y) = (3, 1) → UV (-3, 1) · 2.
        let (t, i) = bvh.intersect([3.0, 1.0, 10.0], [0.0, 0.0, -1.0], f32::INFINITY).expect("Wand");
        assert!((t - 8.0).abs() < 1e-5);
        let tr = &bvh.tris[i];
        let (u, w) = bary(tr, [3.0, 1.0, 10.0], [0.0, 0.0, -1.0]);
        let uv = interp_uv(&bvh.tex[i], u, w);
        assert!((uv[0] - -6.0).abs() < 1e-5 && (uv[1] - 2.0).abs() < 1e-5, "{uv:?}");
        // Ecken: Gewichte (0,0), (1,0), (0,1) liefern die Ecken-UV.
        let x = &bvh.tex[i];
        assert_eq!(interp_uv(x, 0.0, 0.0), x.uv0.map(|c| c * x.scale));
        assert_eq!(interp_uv(x, 1.0, 0.0), x.uv1.map(|c| c * x.scale));
        assert_eq!(interp_uv(x, 0.0, 1.0), x.uv2.map(|c| c * x.scale));
        // Nicht endliche Normale: UV verworfen statt NaN.
        let mut bad = v.clone();
        bad[3] = f32::NAN;
        bad[4] = f32::NAN;
        let mut out = Vec::new();
        tris_from_mesh(&bad, &[0, 1, 2], &[], &mut out);
        assert_eq!(out[0].uv, NO_UV);
    }

    /// Baryzentrische Koordinaten wie der Shader (`tri_bary`).
    fn bary(t: &GpuTri, o: [f32; 3], d: [f32; 3]) -> (f32, f32) {
        let p = cross(d, t.e2);
        let inv = 1.0 / dot(t.e1, p);
        let s = sub(o, t.v0);
        let q = cross(s, t.e1);
        (dot(s, p) * inv, dot(d, q) * inv)
    }
}
