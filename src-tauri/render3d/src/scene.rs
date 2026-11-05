// Szene aus Teilen ([58] inkrementelle Ableitung, Viewer-Seite): das 3D-Modell kommt als benannte Teile
// (je Wand-Eintrag des Kern-Caches, je Öffnungs-Eintrag, Rest-Gruppen wie Decken/Dächer/Kontext). Ein
// Teil-Update (`PartsUpdate`: hinzufügen/ersetzen/entfernen) baut nur die betroffenen Teile neu auf:
//
// - Dreiecke, Textur-Ebenen und Wand-Kappen je Teil, abhängig von den Gehrungen/freien Enden seiner
//   Wände. Gehrung und freie Enden werden über ALLE Wände neu bestimmt (billig, Punkt-Hash); ein Teil
//   wird nur neu vernetzt, wenn seine Eingabe neu ist oder sich diese Werte für eine seiner Wände
//   geändert haben (z. B. der Nachbar einer verschobenen Wand).
// - Kanten (Feature-Edges) über einen globalen Kanten-Index: je Kante die Normalen aller Dreiecke aus
//   allen Teilen; Rand/Knick wird nur für berührte Kanten neu entschieden. Teil-übergreifende Kanten
//   (koplanare Fortsetzung über zwei Wände) bleiben so unterdrückt wie im Vollaufbau.
// - Die GPU bekommt die Teile in Klumpen (Chunks, höchstens `MAX_SHARED_CHUNKS` geteilte plus eigene
//   für sehr grosse Teile): neu hochgeladen werden nur Klumpen mit geänderten Teilen bzw. Kanten —
//   wenige Draw-Calls je Frame, kleine Uploads je Änderung.
//
// GPU-frei (nur `Vec<f32>`/`Mesh`), per `cargo test` prüfbar: ein Teil-Update muss dieselben
// Zeichendaten (Dreiecke, Kanten, Kappen als Mengen) liefern wie ein Vollaufbau derselben Teile.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use serde::Deserialize;

use crate::edges::{draws_crease, for_each_tri_edge, push_edge, representatives, EdgeAdj, EdgeKey};
use crate::math::{merge_bounds, Bounds3};
use crate::mesh::{
    append_context_mesh, compute_free_wall_ends, compute_wall_miters, extrude_slab, extrude_wall_with_miters,
    push_wall_caps, textured_from_mesh, WallMiters,
};
use crate::types::{Mesh, MeshInput, MeshKind, RoofLayerInput, SlabInput, TexturedMesh, WallInput};

/// Höchstzahl geteilter Klumpen (Draw-Calls je Pipeline); grosse Teile bekommen eigene.
pub const MAX_SHARED_CHUNKS: usize = 96;
/// Ab so vielen Vertices bekommt ein Teil einen eigenen Klumpen (z. B. Gelände, ganzes Modell).
const OWN_CHUNK_VERTS: usize = 150_000;

/// Inhalt eines Teils (Format wie `RModel3d`).
#[derive(Debug, Clone, Default, Deserialize)]
pub struct PartInput {
    #[serde(default)]
    pub walls: Vec<WallInput>,
    #[serde(default)]
    pub slabs: Vec<SlabInput>,
    #[serde(default)]
    pub meshes: Vec<MeshInput>,
    #[serde(default, rename = "roofLayers")]
    pub roof_layers: Vec<RoofLayerInput>,
}

/// Ein Teil mit id (JSON `{ id, walls?, slabs?, meshes?, roofLayers? }`).
#[derive(Debug, Clone, Deserialize)]
pub struct PartEntry {
    pub id: String,
    #[serde(default)]
    pub walls: Vec<WallInput>,
    #[serde(default)]
    pub slabs: Vec<SlabInput>,
    #[serde(default)]
    pub meshes: Vec<MeshInput>,
    #[serde(default, rename = "roofLayers")]
    pub roof_layers: Vec<RoofLayerInput>,
}

impl PartEntry {
    pub fn new(id: &str, part: PartInput) -> Self {
        PartEntry { id: id.to_string(), walls: part.walls, slabs: part.slabs, meshes: part.meshes, roof_layers: part.roof_layers }
    }
}

/// Änderung der Szene (JSON `{ reset?, remove?: [id], upsert?: [PartEntry] }`). `reset` leert zuerst.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct PartsUpdate {
    #[serde(default)]
    pub reset: bool,
    #[serde(default)]
    pub remove: Vec<String>,
    #[serde(default)]
    pub upsert: Vec<PartEntry>,
}

/// Was ein Update geändert hat (für die GPU-Schicht).
#[derive(Debug, Default)]
pub struct SceneChange {
    /// Alle Klumpen verwerfen (vor den neu aufzubauenden).
    pub reset: bool,
    /// Neu hochzuladende Klumpen (Index).
    pub dirty_chunks: Vec<usize>,
    /// Gelände-Überlagerung (Luftbild) neu aufbauen.
    pub terrain_changed: bool,
    /// Neu vernetzte Teile (Diagnose/Tests).
    pub remeshed: usize,
}

/// Zeichendaten eines Klumpens.
pub struct ChunkData {
    pub mesh: Mesh,
    pub textured: TexturedMesh,
    pub edges: Vec<f32>,
    pub caps: Vec<f32>,
}

struct Part {
    input: PartInput,
    /// Eindeutige Nummer (Einfüge-Reihenfolge): Besitzer einer Kante ist der Teil mit kleinster Nummer.
    slot: u32,
    chunk: usize,
    meshed: bool,
    miters: Vec<WallMiters>,
    free: Vec<(bool, bool)>,
    mesh: Mesh,
    /// Material-Ebene je Vertex (Stil „textured").
    layers: Vec<f32>,
    caps: Vec<f32>,
    edge_keys: Vec<EdgeKey>,
    has_terrain: bool,
    bounds: Option<Bounds3>,
}

/// Eine Kante im Index: Lage (erster Beitrag), Normalen aller angrenzenden Dreiecke, Entscheid.
struct EdgeEntry {
    p0: [f32; 3],
    p1: [f32; 3],
    /// (Teil-Nummer, laufende Nummer im Teil, Flächennormale); nach dem Entscheid in der Reihenfolge des
    /// Vollaufbaus (Teile nach id, darin nach Dreieck) — die Rückseiten-Paarung hängt davon ab.
    normals: Vec<(u32, u32, [f32; 3])>,
    /// Teil, dessen Klumpen die Kante zeichnet (kleinste Teil-Nummer).
    owner: u32,
    draw: bool,
    /// Klumpen, der die Kante zeichnet (`NONE` = keiner).
    drawn_in: u32,
}

const NONE: u32 = u32::MAX;

impl EdgeEntry {
    fn reps(&self) -> Vec<[f32; 3]> {
        let ns: Vec<[f32; 3]> = self.normals.iter().map(|x| x.2).collect();
        representatives(&ns)
    }
}

#[derive(Default)]
struct Chunk {
    parts: BTreeSet<String>,
    verts: usize,
    own: bool,
}

/// Die Szene (s. Moduldoc).
#[derive(Default)]
pub struct Scene {
    parts: BTreeMap<String, Part>,
    chunks: Vec<Chunk>,
    edges: HashMap<EdgeKey, EdgeEntry>,
    next_slot: u32,
    terrain: Mesh,
    bounds: Option<Bounds3>,
}

impl Scene {
    pub fn new() -> Self {
        Self::default()
    }

    /// Zahl der Klumpen (Index-Bereich der `dirty_chunks`).
    pub fn chunk_count(&self) -> usize {
        self.chunks.len()
    }

    pub fn part_count(&self) -> usize {
        self.parts.len()
    }

    pub fn bounds(&self) -> Option<Bounds3> {
        self.bounds
    }

    /// Gelände-Dreiecke aller Teile (Luftbild-Überlagerung).
    pub fn terrain(&self) -> &Mesh {
        &self.terrain
    }

    pub fn has_edges(&self) -> bool {
        !self.edges.is_empty()
    }

    /// Kanten-Adjazenz (Silhouette im Stil „Contour", neu nur bei Kamera-Änderung).
    pub fn edge_adj(&self) -> impl Iterator<Item = EdgeAdj> + '_ {
        self.edges.values().map(|e| EdgeAdj { p0: e.p0, p1: e.p1, reps: e.reps() })
    }

    /// Alle Wände, Decken und Dach-Schichten in Teil-Reihenfolge (Live-Schnitt).
    pub fn collect_inputs(&self) -> (Vec<WallInput>, Vec<SlabInput>, Vec<RoofLayerInput>) {
        let (mut w, mut s, mut r) = (Vec::new(), Vec::new(), Vec::new());
        for p in self.parts.values() {
            w.extend(p.input.walls.iter().cloned());
            s.extend(p.input.slabs.iter().cloned());
            r.extend(p.input.roof_layers.iter().cloned());
        }
        (w, s, r)
    }

    /// Ein ganzes Modell als einziger Teil (voller Pfad `set_model`).
    pub fn set_model(&mut self, part: PartInput) -> SceneChange {
        self.apply(PartsUpdate { reset: true, remove: Vec::new(), upsert: vec![PartEntry::new("", part)] })
    }

    /// Wendet ein Update an (s. Moduldoc).
    pub fn apply(&mut self, upd: PartsUpdate) -> SceneChange {
        let mut ch = SceneChange::default();
        let mut dirty: BTreeSet<usize> = BTreeSet::new();
        let mut touched: HashSet<EdgeKey> = HashSet::new();
        // Vollaufbau: berührte Kanten nicht einzeln merken, am Ende alle entscheiden.
        let bulk = upd.reset;
        if upd.reset {
            *self = Scene { next_slot: self.next_slot, ..Scene::default() };
            ch.reset = true;
            ch.terrain_changed = true;
        }
        // Doppelte ids im selben Update: das letzte gilt.
        let mut upd = upd;
        let mut seen: HashSet<String> = HashSet::new();
        upd.upsert.reverse();
        upd.upsert.retain(|e| seen.insert(e.id.clone()));
        upd.upsert.reverse();
        // 1) Entfernen (auch die zu ersetzenden Teile; ihr Klumpen wird weiterverwendet).
        let mut reuse: HashMap<String, usize> = HashMap::new();
        let replaced: Vec<&str> = upd.upsert.iter().map(|e| e.id.as_str()).collect();
        for id in upd.remove.iter().map(|s| s.as_str()).chain(replaced.iter().copied()) {
            let Some(p) = self.parts.remove(id) else { continue };
            self.unlink_edges(&p, &mut touched);
            let c = &mut self.chunks[p.chunk];
            c.parts.remove(id);
            c.verts -= p.mesh.vertex_count();
            dirty.insert(p.chunk);
            ch.terrain_changed |= p.has_terrain;
            reuse.insert(id.to_string(), p.chunk);
        }
        // 2) Neue Teile (noch ohne Netz).
        for e in upd.upsert {
            let input = PartInput { walls: e.walls, slabs: e.slabs, meshes: e.meshes, roof_layers: e.roof_layers };
            let has_terrain = input.meshes.iter().any(|m| matches!(m.kind, MeshKind::Terrain));
            ch.terrain_changed |= has_terrain;
            let bounds = part_bounds(&input);
            let chunk = reuse.get(&e.id).copied().unwrap_or(usize::MAX);
            if chunk != usize::MAX {
                self.chunks[chunk].parts.insert(e.id.clone());
            }
            let slot = self.next_slot;
            self.next_slot += 1;
            self.parts.insert(
                e.id,
                Part {
                    input,
                    slot,
                    chunk,
                    meshed: false,
                    miters: Vec::new(),
                    free: Vec::new(),
                    mesh: Mesh::default(),
                    layers: Vec::new(),
                    caps: Vec::new(),
                    edge_keys: Vec::new(),
                    has_terrain,
                    bounds,
                },
            );
        }
        // 3) Gehrung + freie Enden über alle Wände.
        let all: Vec<&WallInput> = self.parts.values().flat_map(|p| p.input.walls.iter()).collect();
        let miters = compute_wall_miters(&all);
        let free = compute_free_wall_ends(&all);
        drop(all);
        // 4) Neu vernetzen, wo nötig.
        let mut at = 0usize;
        let ids: Vec<String> = self.parts.keys().cloned().collect();
        for id in ids {
            let n = self.parts[&id].input.walls.len();
            let (m, f) = (&miters[at..at + n], &free[at..at + n]);
            at += n;
            let p = &self.parts[&id];
            if p.meshed && p.miters == m && p.free == f {
                continue;
            }
            let mut p = self.parts.remove(&id).unwrap();
            if p.meshed {
                self.unlink_edges(&p, &mut touched);
                self.chunks[p.chunk].verts -= p.mesh.vertex_count();
            }
            p.miters = m.to_vec();
            p.free = f.to_vec();
            build_part_mesh(&mut p);
            p.meshed = true;
            ch.remeshed += 1;
            self.link_edges(&mut p, (!bulk).then_some(&mut touched));
            if p.chunk == usize::MAX {
                p.chunk = self.pick_chunk(p.mesh.vertex_count());
                self.chunks[p.chunk].parts.insert(id.clone());
            }
            self.chunks[p.chunk].verts += p.mesh.vertex_count();
            dirty.insert(p.chunk);
            self.parts.insert(id, p);
        }
        // 5) Berührte Kanten neu entscheiden.
        // Teil-Nummer -> (Rang in id-Reihenfolge, Klumpen).
        let info: HashMap<u32, (usize, usize)> =
            self.parts.values().enumerate().map(|(i, p)| (p.slot, (i, p.chunk))).collect();
        if bulk {
            for e in self.edges.values_mut() {
                // Klumpen sind nach einem Vollaufbau ohnehin alle neu.
                decide_edge(e, &info);
            }
        } else {
            for key in touched {
                let Some(e) = self.edges.get_mut(&key) else { continue };
                if e.normals.is_empty() {
                    if e.drawn_in != NONE {
                        dirty.insert(e.drawn_in as usize);
                    }
                    self.edges.remove(&key);
                    continue;
                }
                let was = e.drawn_in;
                decide_edge(e, &info);
                if e.drawn_in != was {
                    for c in [was, e.drawn_in] {
                        if c != NONE {
                            dirty.insert(c as usize);
                        }
                    }
                }
            }
        }
        // 6) Gelände und Ausdehnung.
        if ch.terrain_changed {
            let mut t = Mesh::default();
            for p in self.parts.values().filter(|p| p.has_terrain) {
                for m in p.input.meshes.iter().filter(|m| matches!(m.kind, MeshKind::Terrain)) {
                    append_context_mesh(&mut t, m);
                }
            }
            self.terrain = t;
        }
        self.bounds = self.parts.values().fold(None, |acc, p| merge_bounds(acc, p.bounds));
        ch.dirty_chunks = dirty.into_iter().filter(|&c| c < self.chunks.len()).collect();
        ch
    }

    /// Zeichendaten eines Klumpens (Teile in id-Reihenfolge).
    pub fn chunk_data(&self, chunk: usize) -> ChunkData {
        let mut mesh = Mesh::default();
        let mut layers: Vec<f32> = Vec::new();
        let mut edges: Vec<f32> = Vec::new();
        let mut caps: Vec<f32> = Vec::new();
        let Some(c) = self.chunks.get(chunk) else {
            return ChunkData { textured: textured_from_mesh(&mesh), mesh, edges, caps };
        };
        mesh.verts.reserve(c.verts * crate::types::FLOATS_PER_VERTEX);
        for id in &c.parts {
            let p = &self.parts[id];
            let base = mesh.vertex_count() as u32;
            mesh.verts.extend_from_slice(&p.mesh.verts);
            mesh.indices.extend(p.mesh.indices.iter().map(|i| i + base));
            layers.extend_from_slice(&p.layers);
            caps.extend_from_slice(&p.caps);
            for k in &p.edge_keys {
                let e = &self.edges[k];
                if e.draw && e.owner == p.slot {
                    push_edge(&mut edges, e.p0, e.p1);
                }
            }
        }
        let mut textured = textured_from_mesh(&mesh);
        textured.layers = layers;
        ChunkData { mesh, textured, edges, caps }
    }

    fn pick_chunk(&mut self, verts: usize) -> usize {
        if verts >= OWN_CHUNK_VERTS {
            if let Some(i) = self.chunks.iter().position(|c| c.own && c.parts.is_empty()) {
                return i;
            }
            self.chunks.push(Chunk { own: true, ..Chunk::default() });
            return self.chunks.len() - 1;
        }
        let shared = self.chunks.iter().filter(|c| !c.own).count();
        if shared < MAX_SHARED_CHUNKS {
            self.chunks.push(Chunk::default());
            return self.chunks.len() - 1;
        }
        let mut best = usize::MAX;
        for (i, c) in self.chunks.iter().enumerate() {
            if !c.own && (best == usize::MAX || c.verts < self.chunks[best].verts) {
                best = i;
            }
        }
        best
    }

    fn unlink_edges(&mut self, p: &Part, touched: &mut HashSet<EdgeKey>) {
        for k in &p.edge_keys {
            if let Some(e) = self.edges.get_mut(k) {
                e.normals.retain(|x| x.0 != p.slot);
                touched.insert(*k);
            }
        }
    }

    fn link_edges(&mut self, p: &mut Part, mut touched: Option<&mut HashSet<EdgeKey>>) {
        let mut keys: Vec<EdgeKey> = Vec::new();
        let edges = &mut self.edges;
        let slot = p.slot;
        let mut seq = 0u32;
        for_each_tri_edge(&p.mesh, |key, p0, p1, n| {
            let e = edges.entry(key).or_insert_with(|| EdgeEntry {
                p0,
                p1,
                normals: Vec::with_capacity(2),
                owner: slot,
                draw: false,
                drawn_in: NONE,
            });
            if e.normals.is_empty() {
                // Neue (oder verwaiste) Kante: Lage vom ersten Beitrag.
                e.p0 = p0;
                e.p1 = p1;
            }
            e.normals.push((slot, seq, n));
            seq += 1;
            keys.push(key);
            if let Some(t) = touched.as_deref_mut() {
                t.insert(key);
            }
        });
        keys.sort_unstable();
        keys.dedup();
        p.edge_keys = keys;
    }
}

/// Entscheidet eine Kante neu (Reihenfolge der Normalen, Rand/Knick, Besitzer, zeichnender Klumpen).
fn decide_edge(e: &mut EdgeEntry, info: &HashMap<u32, (usize, usize)>) {
    let first = e.normals[0].0;
    if e.normals.iter().all(|x| x.0 == first) {
        // Nur ein Teil: Beiträge liegen schon in Dreiecks-Reihenfolge.
        e.owner = first;
    } else {
        e.normals.sort_by_key(|x| (info.get(&x.0).map_or(usize::MAX, |i| i.0), x.1));
        e.owner = e.normals.iter().map(|x| x.0).min().unwrap();
    }
    e.draw = draws_crease(&e.reps());
    e.drawn_in = match (e.draw, info.get(&e.owner)) {
        (true, Some(&(_, c))) => c as u32,
        _ => NONE,
    };
}

/// Vernetzt einen Teil: Wände (mit Gehrung), Decken, Meshes; Ebenen je Vertex; Wand-Kappen.
fn build_part_mesh(p: &mut Part) {
    let mut mesh = Mesh::default();
    let mut layers: Vec<f32> = Vec::new();
    let fill = |mesh: &Mesh, layers: &mut Vec<f32>, layer: f32| {
        let added = mesh.vertex_count().saturating_sub(layers.len());
        layers.extend(std::iter::repeat(layer).take(added));
    };
    let mut caps = Vec::new();
    for (i, w) in p.input.walls.iter().enumerate() {
        extrude_wall_with_miters(&mut mesh, w, p.miters[i]);
        fill(&mesh, &mut layers, w.material_index.map(|i| i as f32).unwrap_or(-1.0));
        push_wall_caps(&mut caps, w, p.miters[i], p.free[i]);
    }
    for s in &p.input.slabs {
        extrude_slab(&mut mesh, s);
        fill(&mesh, &mut layers, -1.0);
    }
    for m in &p.input.meshes {
        append_context_mesh(&mut mesh, m);
        fill(&mesh, &mut layers, m.material_index.map(|i| i as f32).unwrap_or(-1.0));
    }
    p.mesh = mesh;
    p.layers = layers;
    p.caps = caps;
}

/// Ausdehnung eines Teils (wie `web::model_bounds`: Wand-Achsen, Decken-Umrisse, Mesh-Punkte).
pub fn part_bounds(p: &PartInput) -> Option<Bounds3> {
    model_bounds(&p.walls, &p.slabs, &p.meshes)
}

/// Bounding-Box (world, Y-oben) aus Wand-Achsenpunkten auf Basis-/Firsthöhe, Decken-Umriss auf
/// Unter-/Oberkante und Mesh-Punkten. `None` bei leerem Modell.
pub fn model_bounds(walls: &[WallInput], slabs: &[SlabInput], meshes: &[MeshInput]) -> Option<Bounds3> {
    let mut min = [f32::INFINITY; 3];
    let mut max = [f32::NEG_INFINITY; 3];
    let mut grow = |x: f32, y: f32, z: f32| {
        for (i, v) in [x, y, z].into_iter().enumerate() {
            if v < min[i] {
                min[i] = v;
            }
            if v > max[i] {
                max[i] = v;
            }
        }
    };
    for w in walls {
        grow(w.start[0], w.base_elevation, w.start[1]);
        grow(w.end[0], w.base_elevation + w.height, w.end[1]);
    }
    for s in slabs {
        for p in &s.outline {
            grow(p[0], s.z_bottom, p[1]);
            grow(p[0], s.z_top, p[1]);
        }
    }
    // Meshes: model (x,y,z=Höhe) -> world (x, z, y).
    for m in meshes {
        let p = &m.positions;
        let mut i = 0;
        while i + 2 < p.len() {
            grow(p[i], p[i + 2], p[i + 1]);
            i += 3;
        }
    }
    if !min[0].is_finite() {
        return None;
    }
    Some((min, max))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::edges::build_mesh_edges;
    use crate::mesh::{build_free_wall_end_caps, build_scene_mesh, build_scene_mesh_textured};
    use crate::types::{Hatch, FLOATS_PER_VERTEX};

    fn wall(a: [f32; 2], b: [f32; 2], z: f32) -> WallInput {
        let mut w: WallInput = serde_json::from_str(r#"{"start":[0,0],"end":[1,0],"thickness":0.2,"height":3}"#).unwrap();
        w.start = a;
        w.end = b;
        w.base_elevation = z;
        w.hatch = Some(serde_json::from_str::<Hatch>(r#"{"pattern":1,"angle":45}"#).unwrap());
        w
    }

    fn slab(z: f32) -> SlabInput {
        serde_json::from_str(&format!(
            r#"{{"outline":[[0,0],[6,0],[6,4],[0,4]],"zBottom":{},"zTop":{}}}"#,
            z - 0.2,
            z
        ))
        .unwrap()
    }

    fn roof() -> MeshInput {
        serde_json::from_str(r#"{"positions":[0,0,6, 6,0,6, 6,4,7, 0,4,7],"indices":[0,1,2, 0,2,3],"kind":"extrusion","materialIndex":2}"#).unwrap()
    }

    /// Kleines Gebäude: je Geschoss ein Rechteck aus 4 Wänden (eine davon geteilt in 2 kollineare
    /// Stücke, `shift` verschiebt deren Knoten im Erdgeschoss) — je Wand ein Teil, Decken und Dach als Rest-Teile.
    fn parts(shift: f32) -> Vec<(String, PartInput)> {
        let mut out = Vec::new();
        for (f, z) in [0.0f32, 3.0].into_iter().enumerate() {
            let sh = if f == 0 { shift } else { 0.0 };
            let pts = [[0.0, 0.0], [3.0 + sh, 0.0], [6.0, 0.0], [6.0, 4.0], [0.0, 4.0]];
            for i in 0..5 {
                let w = wall(pts[i], pts[(i + 1) % 5], z);
                out.push((format!("w{f}-{i}"), PartInput { walls: vec![w], ..Default::default() }));
            }
        }
        out.push(("slabs".into(), PartInput { slabs: vec![slab(3.0), slab(6.0)], ..Default::default() }));
        out.push(("roof".into(), PartInput { meshes: vec![roof()], ..Default::default() }));
        out
    }

    fn q(v: f32) -> i64 {
        (v * 1e4).round() as i64
    }

    /// Dreiecke als sortierte Liste (je Dreieck die 3 Vertices, quantisiert) — reihenfolgefrei.
    fn tris(verts: &[f32], indices: &[u32], fpv: usize) -> Vec<Vec<i64>> {
        let mut out: Vec<Vec<i64>> = indices
            .chunks_exact(3)
            .map(|t| t.iter().flat_map(|&i| verts[i as usize * fpv..(i as usize + 1) * fpv].iter().map(|&v| q(v))).collect())
            .collect();
        out.sort();
        out
    }

    /// Liniensegmente (je 2 Vertices) bzw. Kappen-Dreiecke als sortierte Liste.
    fn groups(verts: &[f32], n: usize) -> Vec<Vec<i64>> {
        let mut out: Vec<Vec<i64>> = verts.chunks_exact(n).map(|s| s.iter().map(|&v| q(v)).collect()).collect();
        for s in out.iter_mut() {
            // Segment-Richtung egal: Endpunkte sortieren (je 6 Werte).
            if n == 12 {
                let (a, b) = s.split_at(6);
                if a > b {
                    *s = [b, a].concat();
                }
            }
        }
        out.sort();
        out
    }

    struct Draw {
        tris: Vec<Vec<i64>>,
        tex: Vec<Vec<i64>>,
        layers: Vec<i64>,
        edges: Vec<Vec<i64>>,
        caps: Vec<Vec<i64>>,
    }

    fn draw(s: &Scene) -> Draw {
        let mut d = Draw { tris: vec![], tex: vec![], layers: vec![], edges: vec![], caps: vec![] };
        for c in 0..s.chunk_count() {
            let cd = s.chunk_data(c);
            assert_eq!(cd.textured.layers.len(), cd.textured.vertex_count(), "Ebene je Vertex");
            d.tris.extend(tris(&cd.mesh.verts, &cd.mesh.indices, FLOATS_PER_VERTEX));
            d.tex.extend(tris(&cd.textured.verts, &cd.textured.indices, crate::types::TEXTURED_FLOATS_PER_VERTEX));
            d.layers.extend(cd.textured.layers.iter().map(|&v| v as i64));
            d.edges.extend(groups(&cd.edges, 12));
            d.caps.extend(groups(&cd.caps, 27));
        }
        d.tris.sort();
        d.tex.sort();
        d.layers.sort();
        d.edges.sort();
        d.caps.sort();
        d
    }

    fn full(ps: &[(String, PartInput)]) -> Scene {
        let mut s = Scene::new();
        s.apply(PartsUpdate {
            reset: true,
            remove: vec![],
            upsert: ps.iter().map(|(id, p)| PartEntry::new(id, p.clone())).collect(),
        });
        s
    }

    fn assert_same(a: &Draw, b: &Draw, what: &str) {
        assert_eq!(a.tris, b.tris, "{what}: Dreiecke");
        assert_eq!(a.tex, b.tex, "{what}: texturierte Dreiecke");
        assert_eq!(a.layers, b.layers, "{what}: Ebenen");
        assert_eq!(a.edges, b.edges, "{what}: Kanten");
        assert_eq!(a.caps, b.caps, "{what}: Kappen");
    }

    #[test]
    fn teile_ergeben_dasselbe_wie_ein_ganzes_modell() {
        let ps = parts(0.0);
        let s = full(&ps);
        // Referenz: alter Vollaufbau über die zusammengehängte Eingabe.
        let mut all = PartInput::default();
        for (_, p) in &ps {
            all.walls.extend(p.walls.clone());
            all.slabs.extend(p.slabs.clone());
            all.meshes.extend(p.meshes.clone());
        }
        let m = build_scene_mesh(&all.walls, &all.slabs, &all.meshes);
        let t = build_scene_mesh_textured(&all.walls, &all.slabs, &all.meshes);
        let mut layers: Vec<i64> = t.layers.iter().map(|&v| v as i64).collect();
        layers.sort();
        let reference = Draw {
            tris: tris(&m.verts, &m.indices, FLOATS_PER_VERTEX),
            tex: tris(&t.verts, &t.indices, crate::types::TEXTURED_FLOATS_PER_VERTEX),
            layers,
            edges: groups(&build_mesh_edges(&m), 12),
            caps: groups(&build_free_wall_end_caps(&all.walls), 27),
        };
        let d = draw(&s);
        assert!(!d.edges.is_empty() && !d.caps.is_empty());
        assert_same(&d, &reference, "Teile vs. Vollaufbau");
        // Als einziger Teil (`set_model`) ebenso.
        let mut one = Scene::new();
        one.set_model(all);
        assert_same(&draw(&one), &reference, "set_model");
        assert_eq!(one.chunk_count(), 1);
    }

    #[test]
    fn teil_update_gleich_vollaufbau_und_nur_betroffene_teile_neu() {
        let mut s = full(&parts(0.0));
        let before = s.chunk_count();
        // Verschiebt den Knoten zwischen zwei kollinearen Stücken: zwei Teile neu, Nachbarn bleiben
        // (kollineare Stösse ohne Gehrung).
        let moved = parts(0.5);
        let ch = s.apply(PartsUpdate {
            reset: false,
            remove: vec![],
            upsert: moved.iter().filter(|(id, _)| id == "w0-0" || id == "w0-1").map(|(id, p)| PartEntry::new(id, p.clone())).collect(),
        });
        assert_eq!(ch.remeshed, 2, "nur die geänderten Teile neu vernetzt");
        // Neu hochgeladen: die beiden Teile und Klumpen, deren Kanten am Stoss (Decken-/Geschoss-Kanten) wechseln.
        assert!(ch.dirty_chunks.len() < before, "nicht alle Klumpen neu: {:?}", ch.dirty_chunks);
        assert_eq!(s.chunk_count(), before);
        assert_same(&draw(&s), &draw(&full(&moved)), "nach Verschieben");

        // Eckwand ersetzen, die Gehrung der Nachbarn ändert sich mit (andere Dicke).
        let mut ps = moved.clone();
        let i = ps.iter().position(|(id, _)| id == "w0-2").unwrap();
        ps[i].1.walls[0].thickness = 0.4;
        let ch = s.apply(PartsUpdate { reset: false, remove: vec![], upsert: vec![PartEntry::new("w0-2", ps[i].1.clone())] });
        assert!(ch.remeshed >= 2 && ch.remeshed <= 3, "Wand + Nachbarn mit geänderter Gehrung: {}", ch.remeshed);
        assert_same(&draw(&s), &draw(&full(&ps)), "nach Dicke");

        // Entfernen (ein freies Ende entsteht: Kappen der Nachbarn neu) und Hinzufügen.
        let ch = s.apply(PartsUpdate { reset: false, remove: vec!["w1-3".into(), "roof".into()], upsert: vec![] });
        assert!(ch.terrain_changed == false && ch.remeshed >= 1);
        let rest: Vec<(String, PartInput)> = ps.iter().filter(|(id, _)| id != "w1-3" && id != "roof").cloned().collect();
        assert_same(&draw(&s), &draw(&full(&rest)), "nach Entfernen");
        s.apply(PartsUpdate { reset: false, remove: vec![], upsert: vec![PartEntry::new("w1-3", ps.iter().find(|(id, _)| id == "w1-3").unwrap().1.clone())] });
        let mut back = rest.clone();
        back.push(ps.iter().find(|(id, _)| id == "w1-3").unwrap().clone());
        assert_same(&draw(&s), &draw(&full(&back)), "nach Hinzufügen");
        assert!(s.bounds().is_some());
        let (w, sl, _) = s.collect_inputs();
        assert_eq!((w.len(), sl.len()), (10, 2));
    }

    #[test]
    fn viele_teile_bleiben_in_wenigen_klumpen() {
        let mut ps = Vec::new();
        for i in 0..500 {
            let x = i as f32 * 2.0;
            ps.push((format!("w{i:04}"), PartInput { walls: vec![wall([x, 0.0], [x + 1.0, 0.0], 0.0)], ..Default::default() }));
        }
        let mut s = full(&ps);
        assert!(s.chunk_count() <= MAX_SHARED_CHUNKS);
        let ch = s.apply(PartsUpdate { reset: false, remove: vec![], upsert: vec![PartEntry::new("w0007", PartInput { walls: vec![wall([14.0, 1.0], [15.0, 1.0], 0.0)], ..Default::default() })] });
        assert_eq!(ch.dirty_chunks.len(), 1);
        assert_eq!(ch.remeshed, 1);
        // Leere Eingabe, Reset.
        let ch = s.apply(PartsUpdate { reset: true, ..Default::default() });
        assert!(ch.reset && s.chunk_count() == 0 && s.bounds().is_none());
    }

    /// Messung am Grossgebäude ([58]): Eingaben aus `model3dPartsSync.bench.test.ts`
    /// (`BENCH_3D=1 BENCH_3D_OUT=<ordner>`), dann `SCENE_BENCH_DIR=<ordner> cargo test --release --lib
    /// scene::tests::bench -- --ignored --nocapture`. Vorher = alter `set_model`-Pfad (Parsen, Szenen-Netz,
    /// texturiertes Netz, Gelände, Kappen, Kanten-Adjazenz zweimal); jetzt = Teil-Update (Parsen, neu
    /// vernetzen, Klumpen-Daten der geänderten Klumpen).
    #[test]
    #[ignore]
    fn bench() {
        use std::time::Instant;
        let Ok(dir) = std::env::var("SCENE_BENCH_DIR") else { return };
        let read = |f: &str| std::fs::read_to_string(format!("{dir}/{f}")).unwrap();
        let (full, parts, delta) = (read("full.json"), read("parts.json"), read("delta.json"));
        let ms = |t: Instant| t.elapsed().as_secs_f64() * 1e3;

        let t = Instant::now();
        let m: PartInput = serde_json::from_str(&full).unwrap();
        let mesh = build_scene_mesh(&m.walls, &m.slabs, &m.meshes);
        let _tex = build_scene_mesh_textured(&m.walls, &m.slabs, &m.meshes);
        let _terrain = crate::mesh::build_terrain_mesh(&m.meshes);
        let _caps = build_free_wall_end_caps(&m.walls);
        let _adj = crate::edges::build_edge_adjacency(&mesh);
        let _edges = build_mesh_edges(&mesh);
        let old = ms(t);

        let t = Instant::now();
        let mut one = Scene::new();
        one.set_model(serde_json::from_str(&full).unwrap());
        let _d: Vec<ChunkData> = (0..one.chunk_count()).map(|c| one.chunk_data(c)).collect();
        let new_full = ms(t);

        let t = Instant::now();
        let mut s = Scene::new();
        let ch = s.apply(serde_json::from_str(&parts).unwrap());
        let _d: Vec<ChunkData> = ch.dirty_chunks.iter().map(|&c| s.chunk_data(c)).collect();
        let cold = ms(t);

        let t = Instant::now();
        let ch = s.apply(serde_json::from_str(&delta).unwrap());
        let d: Vec<ChunkData> = ch.dirty_chunks.iter().map(|&c| s.chunk_data(c)).collect();
        let inc = ms(t);
        let up: usize = d.iter().map(|c| c.mesh.verts.len() + c.textured.verts.len() + c.edges.len() + c.caps.len()).sum();
        let all: usize = (0..s.chunk_count())
            .map(|c| s.chunk_data(c))
            .map(|c| c.mesh.verts.len() + c.textured.verts.len() + c.edges.len() + c.caps.len())
            .sum();
        eprintln!(
            "[58] render3d Grossgebäude: alter set_model {old:.0} ms; set_model als 1 Teil {new_full:.0} ms; \
             Teile kalt {cold:.0} ms ({} Teile, {} Klumpen); Teil-Update {inc:.1} ms ({} Teile neu vernetzt, \
             {} Klumpen, {:.1} von {:.1} MB Vertexdaten hochzuladen)",
            s.part_count(),
            s.chunk_count(),
            ch.remeshed,
            ch.dirty_chunks.len(),
            up as f64 * 4e-6,
            all as f64 * 4e-6,
        );
    }
}

