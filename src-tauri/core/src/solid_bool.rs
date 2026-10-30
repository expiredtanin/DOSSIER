//! Körper-Booleans im Kern ([107] Schritt 2, für [G5]): `manifold-rust` (exakter Modus) für synchrone
//! Ableitungen (Dach-Verschneidung, Gauben, Wand an Dach). Messung und Entscheid: TODO.md [107].
//!
//! **Panik-Schutz.** Auf wasm32-unknown-unknown gibt es kein `catch_unwind`; eine Panik legt den ganzen
//! Kern lahm. Daher geht nur ein vorher geprüftes Netz an Manifold ([`Solid::new`]): Dreier-Gruppen,
//! Indizes im Bereich, endliche Koordinaten mit |x| < 1e7 m, Obergrenze Dreiecke, Ecken verschweisst
//! (Toleranz [`WELD`]), geschlossen und mannigfaltig (jede gerichtete Kante genau einmal, ihre Gegenkante
//! auch), Volumen ≠ 0; innen nach aussen gedrehte Körper (Volumen < 0) werden umgedreht (Manifold nähme
//! sie still an und rechnete falsch). Nach jeder Operation wird `status()` geprüft. Der Fuzz-Test
//! (`tests::fuzz_*`) wirft zufällige und kaputte Netze hinein und verlangt Fehler statt Panik.
//!
//! **Kodierung** (WASM-Grenze, `web/solid_bool.rs`): `[n_verts, x, y, z, …, n_tris, i0, i1, i2, …]`.
//!
//! **Cache** ([`cached`]): Ergebnis je Element (Schlüssel) mit Inhalts-Hash; ändert sich der Hash, wird
//! neu gerechnet und der alte Eintrag ersetzt — der Cache wächst nur mit der Zahl der Elemente.

use std::any::Any;
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use manifold_rust::manifold::Manifold;
use manifold_rust::types::{BooleanEngine, Error, MeshGL64};

/// Obergrenze Dreiecke je Eingabe (Speicher/Zeit im WASM).
pub const MAX_TRIANGLES: usize = 200_000;
/// Koordinaten-Obergrenze (Meter): grösser ist Unsinn (Welt-Koordinaten sind lokal rebasiert).
pub const MAX_COORD: f64 = 1e7;
/// Verschweiss-Toleranz (Meter): Ecken näher als das gelten als gleich.
pub const WELD: f64 = 1e-7;

/// Dreiecksnetz (Modell-Meter, f64).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Mesh {
    pub positions: Vec<f64>,
    pub indices: Vec<u32>,
}

impl Mesh {
    pub fn is_empty(&self) -> bool {
        self.indices.is_empty()
    }

    /// Hängt `other` an (ohne Verschweissen).
    pub fn append(&mut self, other: &Mesh) {
        let base = (self.positions.len() / 3) as u32;
        self.positions.extend_from_slice(&other.positions);
        self.indices.extend(other.indices.iter().map(|i| i + base));
    }

    /// Volumen (Divergenzsatz, relativ zur ersten Ecke).
    pub fn volume(&self) -> f64 {
        let p = &self.positions;
        if p.len() < 3 {
            return 0.0;
        }
        let o = [p[0], p[1], p[2]];
        let v = |i: u32| {
            let j = i as usize * 3;
            [p[j] - o[0], p[j + 1] - o[1], p[j + 2] - o[2]]
        };
        let mut vol = 0.0;
        for t in self.indices.chunks_exact(3) {
            let (a, b, c) = (v(t[0]), v(t[1]), v(t[2]));
            vol += a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
        }
        vol / 6.0
    }

    /// Geschlossen: jede gerichtete Kante (nach Verschweissen) genau einmal mit Gegenkante.
    pub fn is_closed(&self) -> bool {
        weld_and_check(&self.positions, &self.indices).is_ok()
    }

    /// Geschlossen nach Indizes (ohne Verschweissen): für Manifold-Ergebnisse.
    pub fn is_closed_exact(&self) -> bool {
        let mut edges: HashMap<(u32, u32), u32> = HashMap::new();
        for t in self.indices.chunks_exact(3) {
            for k in 0..3 {
                *edges.entry((t[k], t[(k + 1) % 3])).or_default() += 1;
            }
        }
        !edges.is_empty() && edges.iter().all(|(&(a, b), &c)| c == 1 && edges.get(&(b, a)) == Some(&1))
    }

    /// Achsparallele Hülle `[min, max]`; leer ⇒ `None`.
    pub fn bounds(&self) -> Option<([f64; 3], [f64; 3])> {
        let mut lo = [f64::INFINITY; 3];
        let mut hi = [f64::NEG_INFINITY; 3];
        for q in self.positions.chunks_exact(3) {
            for k in 0..3 {
                lo[k] = lo[k].min(q[k]);
                hi[k] = hi[k].max(q[k]);
            }
        }
        (lo[0] <= hi[0]).then_some((lo, hi))
    }

    /// Geschlossener Quader aus 8 Ecken (Reihenfolge wie `opening_shape::quad_box`: 4 unten, 4 oben,
    /// je im selben Drehsinn); Orientierung egal (wird beim Prüfen gerichtet).
    pub fn hexahedron(c: &[[f64; 3]; 8]) -> Mesh {
        let mut positions = Vec::with_capacity(24);
        for q in c {
            positions.extend_from_slice(q);
        }
        let indices = vec![0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7];
        Mesh { positions, indices }
    }

    /// Senkrechtes Prisma über einem einfachen Polygon (Grundriss, beliebiger Drehsinn) von `z0` bis
    /// `z1`; Deckel über Ohrenschnitt. Entartet ⇒ leer.
    pub fn prism(ring: &[[f64; 2]], z0: f64, z1: f64) -> Mesh {
        Self::prism_between(ring, &|_, _| z0, &|_, _| z1)
    }

    /// Prisma über `ring` mit Boden `bottom(x, y)` und Deckel `top(x, y)` (je Ecke; ebene Funktionen
    /// ergeben ebene Flächen).
    pub fn prism_between(ring: &[[f64; 2]], bottom: &dyn Fn(f64, f64) -> f64, top: &dyn Fn(f64, f64) -> f64) -> Mesh {
        let n = ring.len();
        if n < 3 {
            return Mesh::default();
        }
        let area: f64 = (0..n).map(|i| ring[i][0] * ring[(i + 1) % n][1] - ring[(i + 1) % n][0] * ring[i][1]).sum::<f64>() / 2.0;
        if !(area.abs() > 1e-12) {
            return Mesh::default();
        }
        let ccw: Vec<[f64; 2]> = if area > 0.0 { ring.to_vec() } else { ring.iter().rev().copied().collect() };
        let tris = ear_clip(&ccw);
        if tris.is_empty() {
            return Mesh::default();
        }
        let mut positions = Vec::with_capacity(n * 6);
        for q in &ccw {
            positions.extend([q[0], q[1], bottom(q[0], q[1])]);
        }
        for q in &ccw {
            positions.extend([q[0], q[1], top(q[0], q[1])]);
        }
        let nn = n as u32;
        let mut indices = Vec::new();
        for t in &tris {
            indices.extend([t[0] as u32, t[2] as u32, t[1] as u32]);
            indices.extend([t[0] as u32 + nn, t[1] as u32 + nn, t[2] as u32 + nn]);
        }
        for i in 0..nn {
            let j = (i + 1) % nn;
            indices.extend([i, j, j + nn, i, j + nn, i + nn]);
        }
        Mesh { positions, indices }
    }
}

/// Ohrenschnitt eines einfachen Polygons im Gegenuhrzeigersinn (Indizes).
pub fn ear_clip(ring: &[[f64; 2]]) -> Vec<[usize; 3]> {
    let n = ring.len();
    let mut idx: Vec<usize> = (0..n).collect();
    let mut out = Vec::new();
    let cross = |a: [f64; 2], b: [f64; 2], c: [f64; 2]| (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    let mut guard = 0;
    while idx.len() > 3 && guard < 4 * n * n + 8 {
        guard += 1;
        let m = idx.len();
        let mut found = false;
        for k in 0..m {
            let (ia, ib, ic) = (idx[(k + m - 1) % m], idx[k], idx[(k + 1) % m]);
            let (a, b, c) = (ring[ia], ring[ib], ring[ic]);
            let cr = cross(a, b, c);
            if cr <= 1e-14 {
                // Kollineare Ecke ohne Fläche: entfernen.
                if cr.abs() <= 1e-14 {
                    idx.remove(k);
                    found = true;
                    break;
                }
                continue;
            }
            let inside = idx.iter().any(|&j| {
                if j == ia || j == ib || j == ic {
                    return false;
                }
                let p = ring[j];
                cross(a, b, p) >= -1e-14 && cross(b, c, p) >= -1e-14 && cross(c, a, p) >= -1e-14
            });
            if !inside {
                out.push([ia, ib, ic]);
                idx.remove(k);
                found = true;
                break;
            }
        }
        if !found {
            break;
        }
    }
    if idx.len() == 3 && cross(ring[idx[0]], ring[idx[1]], ring[idx[2]]) > 1e-14 {
        out.push([idx[0], idx[1], idx[2]]);
    }
    out
}

/// Prüft und verschweisst; liefert nach aussen orientierte Ecken/Dreiecke oder einen Fehlertext.
fn weld_and_check(positions: &[f64], indices: &[u32]) -> Result<(Vec<f64>, Vec<u32>), String> {
    weld_and_check_tol(positions, indices, WELD)
}

fn weld_and_check_tol(positions: &[f64], indices: &[u32], tol: f64) -> Result<(Vec<f64>, Vec<u32>), String> {
    if positions.len() % 3 != 0 || indices.len() % 3 != 0 {
        return Err("Positionen/Indizes keine Dreier-Gruppen".into());
    }
    if indices.is_empty() {
        return Err("leeres Netz".into());
    }
    if indices.len() / 3 > MAX_TRIANGLES {
        return Err(format!("zu viele Dreiecke (> {MAX_TRIANGLES})"));
    }
    if positions.iter().any(|x| !x.is_finite() || x.abs() > MAX_COORD) {
        return Err("Koordinaten nicht endlich oder zu gross".into());
    }
    let n_in = positions.len() / 3;
    let weld = tol >= 0.0;
    let tol = tol.max(0.0);
    // Raster ≥ 1e-9 m: |x| ≤ 1e7 ⇒ Zellnummern ≤ 1e16, ±1 läuft nicht über.
    let cell = |v: f64| (v / tol.max(1e-9)).floor() as i64;
    let mut grid: HashMap<(i64, i64, i64), Vec<u32>> = HashMap::new();
    let mut verts: Vec<f64> = Vec::new();
    let mut map: Vec<u32> = Vec::with_capacity(n_in);
    for c in positions.chunks_exact(3) {
        let key = (cell(c[0]), cell(c[1]), cell(c[2]));
        let mut hit = None;
        'search: for dx in if weld { -1..=1 } else { 1..=0 } {
            for dy in -1..=1 {
                for dz in -1..=1 {
                    if let Some(list) = grid.get(&(key.0 + dx, key.1 + dy, key.2 + dz)) {
                        for &id in list {
                            let j = id as usize * 3;
                            if (verts[j] - c[0]).abs() <= tol && (verts[j + 1] - c[1]).abs() <= tol && (verts[j + 2] - c[2]).abs() <= tol {
                                hit = Some(id);
                                break 'search;
                            }
                        }
                    }
                }
            }
        }
        let id = hit.unwrap_or_else(|| {
            let id = (verts.len() / 3) as u32;
            verts.extend_from_slice(&[c[0] + 0.0, c[1] + 0.0, c[2] + 0.0]);
            grid.entry(key).or_default().push(id);
            id
        });
        map.push(id);
    }
    let mut tris: Vec<u32> = Vec::with_capacity(indices.len());
    for t in indices.chunks_exact(3) {
        let mut m = [0u32; 3];
        for k in 0..3 {
            let i = t[k] as usize;
            if i >= n_in {
                return Err(format!("Index {i} ausserhalb"));
            }
            m[k] = map[i];
        }
        if m[0] == m[1] || m[1] == m[2] || m[0] == m[2] {
            continue;
        }
        tris.extend_from_slice(&m);
    }
    if tris.len() < 12 {
        return Err("weniger als vier Dreiecke".into());
    }
    let mut edges: HashMap<(u32, u32), u32> = HashMap::with_capacity(tris.len());
    for t in tris.chunks_exact(3) {
        for k in 0..3 {
            *edges.entry((t[k], t[(k + 1) % 3])).or_default() += 1;
        }
    }
    for (&(a, b), &c) in &edges {
        if c != 1 || edges.get(&(b, a)).copied() != Some(1) {
            return Err("Netz nicht geschlossen/mannigfaltig".into());
        }
    }
    let m = Mesh { positions: verts, indices: tris };
    let vol = m.volume();
    let ext = m.bounds().map_or(0.0, |(lo, hi)| (0..3).map(|k| hi[k] - lo[k]).fold(0.0, f64::max));
    if !vol.is_finite() || vol.abs() <= 1e-15 * ext.powi(3).max(1e-12) {
        return Err("Volumen 0".into());
    }
    let Mesh { positions: verts, indices: mut tris } = m;
    if vol < 0.0 {
        tris.chunks_exact_mut(3).for_each(|t| t.swap(1, 2));
    }
    Ok((verts, tris))
}

/// Geprüfter Körper (Manifold). Leer ist erlaubt (Ergebnis einer Differenz).
#[derive(Clone)]
pub struct Solid(Manifold);

impl Solid {
    /// Prüft das Netz (s. Modulkopf) und baut den Körper; Fehler statt Panik.
    pub fn new(mesh: &Mesh) -> Result<Solid, String> {
        Self::with_tolerance(mesh, WELD)
    }

    /// Wie [`Solid::new`], ohne Verschweissen (Indizes wie gegeben): für Netze, die schon aus Manifold
    /// kommen (dort können Ecken gleicher Lage getrennt geführt sein).
    pub fn new_exact(mesh: &Mesh) -> Result<Solid, String> {
        Self::with_tolerance(mesh, -1.0)
    }

    fn with_tolerance(mesh: &Mesh, tol: f64) -> Result<Solid, String> {
        let (verts, tris) = weld_and_check_tol(&mesh.positions, &mesh.indices, tol)?;
        let mut g = MeshGL64::default();
        g.num_prop = 3;
        g.vert_properties = verts;
        g.tri_verts = tris.iter().map(|&i| i as u64).collect();
        let m = Manifold::from_mesh_gl64(&g);
        if m.status() != Error::NoError {
            return Err(format!("kein gültiger Körper ({:?})", m.status()));
        }
        Ok(Solid(m))
    }

    pub fn empty() -> Solid {
        Solid(Manifold::empty())
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    pub fn volume(&self) -> f64 {
        self.0.volume()
    }

    fn checked(m: Manifold) -> Result<Solid, String> {
        if m.status() != Error::NoError {
            return Err(format!("Boolean fehlgeschlagen ({:?})", m.status()));
        }
        Ok(Solid(m))
    }

    pub fn union(&self, o: &Solid) -> Result<Solid, String> {
        if o.is_empty() {
            return Ok(self.clone());
        }
        if self.is_empty() {
            return Ok(o.clone());
        }
        Self::checked(self.0.union_with_engine(&o.0, BooleanEngine::Exact))
    }

    pub fn difference(&self, o: &Solid) -> Result<Solid, String> {
        if o.is_empty() || self.is_empty() {
            return Ok(self.clone());
        }
        Self::checked(self.0.difference_with_engine(&o.0, BooleanEngine::Exact))
    }

    pub fn intersection(&self, o: &Solid) -> Result<Solid, String> {
        if o.is_empty() || self.is_empty() {
            return Ok(Solid::empty());
        }
        Self::checked(self.0.intersection_with_engine(&o.0, BooleanEngine::Exact))
    }

    /// Vereinigung vieler Körper (ungültige Teile werden übergangen und gezählt).
    pub fn union_all(meshes: &[Mesh]) -> (Solid, usize) {
        let mut acc = Solid::empty();
        let mut bad = 0;
        for m in meshes {
            match Solid::new(m).and_then(|s| acc.union(&s)) {
                Ok(s) => acc = s,
                Err(_e) => {
                    #[cfg(test)]
                    eprintln!("union_all: {_e} {:?}", m.bounds());
                    bad += 1
                }
            }
        }
        (acc, bad)
    }

    /// Netz mit zusammengefassten koplanaren Dreiecken (`simplify`).
    pub fn to_mesh(&self) -> Mesh {
        self.mesh_of(true)
    }

    /// Netz ohne `simplify` (alle Dreiecke wie berechnet; `simplify` kann Kanten so zusammenlegen, dass
    /// einzelne Dreiecke leicht aus ihrer Ebene kippen — für die Aufsicht/Ansicht unerwünscht).
    pub fn to_mesh_raw(&self) -> Mesh {
        self.mesh_of(false)
    }

    fn mesh_of(&self, simplify: bool) -> Mesh {
        if self.is_empty() {
            return Mesh::default();
        }
        let g = if simplify { self.0.simplify(0.0).get_mesh_gl64(-1) } else { self.0.get_mesh_gl64(-1) };
        let np = (g.num_prop as usize).max(3);
        let positions: Vec<f64> = g.vert_properties.chunks_exact(np).flat_map(|v| [v[0], v[1], v[2]]).collect();
        // Manifold führt Ecken an Grenzen zwischen Eingabe-Körpern doppelt (`merge_*_vert`): zusammenführen,
        // damit das Netz auch nach Indizes geschlossen ist.
        let nv = positions.len() / 3;
        let mut map: Vec<u32> = (0..nv as u32).collect();
        for (f, t) in g.merge_from_vert.iter().zip(g.merge_to_vert.iter()) {
            let (f, t) = (*f as usize, *t as usize);
            if f < nv && t < nv {
                map[f] = t as u32;
            }
        }
        let indices: Vec<u32> = g.tri_verts.iter().map(|&i| map.get(i as usize).copied().unwrap_or(0)).collect();
        Mesh { positions, indices }
    }
}

/// Zwei Netze verknüpfen ("union" | "difference" | "intersection").
pub fn boolean(a: &Mesh, b: &Mesh, op: &str) -> Result<Mesh, String> {
    let (sa, sb) = (Solid::new(a)?, Solid::new(b)?);
    let r = match op {
        "union" => sa.union(&sb)?,
        "difference" => sa.difference(&sb)?,
        "intersection" => sa.intersection(&sb)?,
        _ => return Err(format!("unbekannte Operation {op}")),
    };
    Ok(r.to_mesh())
}

// ── Flache Kodierung ────────────────────────────────────────────────────────

/// `[n_verts, x, y, z, …, n_tris, i0, i1, i2, …]` → Netz; kaputt ⇒ `None`.
pub fn decode_mesh(buf: &[f64]) -> Option<Mesh> {
    let count = |v: f64| (v.is_finite() && v >= 0.0 && v.fract() == 0.0 && v < 1e8).then_some(v as usize);
    let nv = count(*buf.first()?)?;
    let pend = 1usize.checked_add(nv.checked_mul(3)?)?;
    let positions = buf.get(1..pend)?.to_vec();
    let nt = count(*buf.get(pend)?)?;
    let iend = (pend + 1).checked_add(nt.checked_mul(3)?)?;
    let raw = buf.get(pend + 1..iend)?;
    if iend != buf.len() {
        return None;
    }
    let mut indices = Vec::with_capacity(raw.len());
    for &v in raw {
        let i = count(v)?;
        if i >= nv {
            return None;
        }
        indices.push(i as u32);
    }
    Some(Mesh { positions, indices })
}

pub fn encode_mesh(m: &Mesh) -> Vec<f64> {
    let mut out = Vec::with_capacity(2 + m.positions.len() + m.indices.len());
    out.push((m.positions.len() / 3) as f64);
    out.extend_from_slice(&m.positions);
    out.push((m.indices.len() / 3) as f64);
    out.extend(m.indices.iter().map(|&i| i as f64));
    out
}

/// Flache Eingabe: `[op, …mesh a, …mesh b]` mit op 0 = Vereinigung, 1 = Differenz, 2 = Schnitt.
/// Kaputte Eingaben oder Fehler ⇒ leerer Puffer (nie Panik).
pub fn boolean_flat(op: f64, a: &[f64], b: &[f64]) -> Vec<f64> {
    let name = match op as i64 {
        0 if op == 0.0 => "union",
        1 if op == 1.0 => "difference",
        2 if op == 2.0 => "intersection",
        _ => return Vec::new(),
    };
    let (Some(a), Some(b)) = (decode_mesh(a), decode_mesh(b)) else { return Vec::new() };
    boolean(&a, &b, name).map(|m| encode_mesh(&m)).unwrap_or_default()
}

// ── Inhalts-Hash und Cache je Element ───────────────────────────────────────

/// FNV-1a über Zahlen/Texte (stabil, ohne Zufalls-Seed).
#[derive(Clone, Copy)]
pub struct ContentHash(u64);

impl Default for ContentHash {
    fn default() -> Self {
        ContentHash(0xcbf2_9ce4_8422_2325)
    }
}

impl ContentHash {
    fn byte(&mut self, b: u8) {
        self.0 ^= b as u64;
        self.0 = self.0.wrapping_mul(0x0100_0000_01b3);
    }
    pub fn u64(&mut self, v: u64) -> &mut Self {
        for b in v.to_le_bytes() {
            self.byte(b);
        }
        self
    }
    pub fn f64(&mut self, v: f64) -> &mut Self {
        self.u64((v + 0.0).to_bits())
    }
    pub fn f64s(&mut self, v: &[f64]) -> &mut Self {
        self.u64(v.len() as u64);
        for &x in v {
            self.f64(x);
        }
        self
    }
    pub fn str(&mut self, s: &str) -> &mut Self {
        self.u64(s.len() as u64);
        for b in s.bytes() {
            self.byte(b);
        }
        self
    }
    /// Beliebiges serialisierbares Element (JSON-Text; für Modell-Elemente).
    pub fn json<T: serde::Serialize>(&mut self, v: &T) -> &mut Self {
        let s = serde_json::to_string(v).unwrap_or_default();
        self.str(&s)
    }
    pub fn finish(&self) -> u64 {
        self.0
    }
}

const CACHE_MAX: usize = 4096;

thread_local! {
    static CACHE: RefCell<HashMap<String, (u64, Rc<dyn Any>)>> = RefCell::new(HashMap::new());
}

/// Ergebnis je Element `key` mit Inhalts-Hash `hash`: gleicher Hash ⇒ gespeichertes Ergebnis, sonst
/// `f()` rechnen und den Eintrag des Elements ersetzen.
pub fn cached<T: 'static>(key: &str, hash: u64, f: impl FnOnce() -> T) -> Rc<T> {
    let hit = CACHE.with(|c| c.borrow().get(key).filter(|(h, _)| *h == hash).and_then(|(_, v)| v.clone().downcast::<T>().ok()));
    if let Some(v) = hit {
        return v;
    }
    let v = Rc::new(f());
    CACHE.with(|c| {
        let mut c = c.borrow_mut();
        if c.len() >= CACHE_MAX && !c.contains_key(key) {
            c.clear();
        }
        c.insert(key.to_string(), (hash, v.clone() as Rc<dyn Any>));
    });
    v
}

/// Anzahl Cache-Einträge (Tests).
pub fn cache_len() -> usize {
    CACHE.with(|c| c.borrow().len())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cuboid(x: f64, y: f64, z: f64, w: f64, l: f64, h: f64) -> Mesh {
        Mesh::prism(&[[x, y], [x + w, y], [x + w, y + l], [x, y + l]], z, z + h)
    }

    #[test]
    fn prism_is_closed_with_volume() {
        let m = cuboid(0.0, 0.0, 0.0, 2.0, 3.0, 4.0);
        assert!(m.is_closed());
        assert!((m.volume() - 24.0).abs() < 1e-12);
        // L-Grundriss (nicht konvex)
        let l = Mesh::prism(&[[0.0, 0.0], [4.0, 0.0], [4.0, 1.0], [1.0, 1.0], [1.0, 3.0], [0.0, 3.0]], 0.0, 1.0);
        assert!(l.is_closed());
        assert!((l.volume() - 6.0).abs() < 1e-12);
    }

    #[test]
    fn flush_difference_and_union_exact() {
        let a = cuboid(0.0, 0.0, 0.0, 2.0, 2.0, 2.0);
        let b = cuboid(1.0, 0.0, 0.0, 1.0, 2.0, 2.0);
        let d = boolean(&a, &b, "difference").unwrap();
        assert!(d.is_closed());
        assert!((d.volume() - 4.0).abs() < 1e-9);
        let u = boolean(&a, &cuboid(2.0, 0.0, 0.0, 1.0, 2.0, 2.0), "union").unwrap();
        assert!((u.volume() - 12.0).abs() < 1e-9);
        assert!(u.indices.len() / 3 <= 24, "simplify fasst koplanare Dreiecke zusammen: {}", u.indices.len() / 3);
        let i = boolean(&a, &b, "intersection").unwrap();
        assert!((i.volume() - 4.0).abs() < 1e-9);
    }

    #[test]
    fn inside_out_input_is_flipped() {
        let mut a = cuboid(0.0, 0.0, 0.0, 2.0, 2.0, 2.0);
        a.indices.chunks_exact_mut(3).for_each(|t| t.swap(1, 2));
        assert!(a.volume() < 0.0);
        let d = boolean(&a, &cuboid(1.0, 0.0, 0.0, 1.0, 2.0, 2.0), "difference").unwrap();
        assert!((d.volume() - 4.0).abs() < 1e-9);
    }

    #[test]
    fn nearly_equal_vertices_are_welded() {
        // Zwei Hälften mit um 1e-9 versetzten gemeinsamen Ecken (wie Gehrungs-Ecken der Dachflächen).
        let mut m = cuboid(0.0, 0.0, 0.0, 1.0, 1.0, 1.0);
        for v in m.positions.iter_mut().step_by(5) {
            *v += 1e-9;
        }
        assert!(Solid::new(&m).is_ok());
    }

    #[test]
    fn rejects_broken_inputs() {
        let good = cuboid(0.0, 0.0, 0.0, 1.0, 1.0, 1.0);
        let mut open = good.clone();
        open.indices.truncate(open.indices.len() - 3);
        assert!(Solid::new(&open).is_err());
        let mut nan = good.clone();
        nan.positions[4] = f64::NAN;
        assert!(Solid::new(&nan).is_err());
        let mut far = good.clone();
        far.positions[0] = 1e9;
        assert!(Solid::new(&far).is_err());
        let mut idx = good.clone();
        idx.indices[0] = 999;
        assert!(Solid::new(&idx).is_err());
        assert!(Solid::new(&Mesh::default()).is_err());
        let flat = Mesh::prism(&[[0.0, 0.0], [1.0, 0.0], [1.0, 1.0]], 0.0, 0.0);
        assert!(Solid::new(&flat).is_err(), "Volumen 0");
        // doppelte Fläche: nicht mannigfaltig
        let mut dbl = good.clone();
        let extra: Vec<u32> = dbl.indices[0..3].to_vec();
        dbl.indices.extend(extra);
        assert!(Solid::new(&dbl).is_err());
    }

    #[test]
    fn flat_codec_roundtrip_and_garbage() {
        let a = cuboid(0.0, 0.0, 0.0, 2.0, 2.0, 2.0);
        let b = cuboid(1.0, 1.0, 1.0, 2.0, 2.0, 2.0);
        assert_eq!(decode_mesh(&encode_mesh(&a)), Some(a.clone()));
        let r = boolean_flat(1.0, &encode_mesh(&a), &encode_mesh(&b));
        let m = decode_mesh(&r).unwrap();
        assert!((m.volume() - 7.0).abs() < 1e-9);
        for bad in [vec![], vec![f64::NAN], vec![1.0, 0.0], vec![-1.0], vec![1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 5.0], vec![1e300]] {
            assert!(decode_mesh(&bad).is_none(), "{bad:?}");
            assert!(boolean_flat(0.0, &bad, &encode_mesh(&a)).is_empty());
        }
        assert!(boolean_flat(7.0, &encode_mesh(&a), &encode_mesh(&b)).is_empty());
        assert!(boolean_flat(f64::NAN, &encode_mesh(&a), &encode_mesh(&b)).is_empty());
        assert!(boolean_flat(0.5, &encode_mesh(&a), &encode_mesh(&b)).is_empty());
    }

    #[test]
    fn cache_per_element() {
        let n0 = cache_len();
        let mut calls = 0;
        let a = cached("test/e1", 1, || {
            calls += 1;
            5
        });
        let b = cached("test/e1", 1, || {
            calls += 1;
            6
        });
        assert_eq!((*a, *b, calls), (5, 5, 1));
        let c = cached("test/e1", 2, || 7);
        assert_eq!(*c, 7);
        assert_eq!(cache_len(), n0 + 1, "Eintrag ersetzt, nicht angehängt");
        let mut h1 = ContentHash::default();
        h1.f64s(&[1.0, 2.0]).str("x");
        let mut h2 = ContentHash::default();
        h2.f64s(&[1.0, 2.0]).str("y");
        assert_ne!(h1.finish(), h2.finish());
    }

    /// Kleiner deterministischer Zufallsgenerator (xorshift).
    struct Rng(u64);
    impl Rng {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            self.0
        }
        fn f(&mut self) -> f64 {
            (self.next() >> 11) as f64 / (1u64 << 53) as f64
        }
        fn pick<T: Copy>(&mut self, v: &[T]) -> T {
            v[(self.next() % v.len() as u64) as usize]
        }
    }

    /// Fuzz: zufällige und kaputte Netze ⇒ Ergebnis oder Fehler, nie Panik; gültige Ergebnisse
    /// sind geschlossen und haben plausible Volumen.
    #[test]
    fn fuzz_random_and_corrupt_meshes_never_panic() {
        let mut rng = Rng(0x9e37_79b9_7f4a_7c15);
        let specials = [0.0, -0.0, 1e-12, 1e-7, 1e-6, 1.0, 1e6, 1e8, f64::NAN, f64::INFINITY, f64::NEG_INFINITY, f64::MIN_POSITIVE, -1e-300];
        let mut ok = 0;
        for round in 0..400 {
            let mut a = cuboid(rng.f() * 2.0, rng.f() * 2.0, rng.f() * 2.0, 0.1 + rng.f() * 3.0, 0.1 + rng.f() * 3.0, 0.1 + rng.f() * 3.0);
            let mut b = if round % 3 == 0 {
                // bündig zu a
                let (lo, hi) = a.bounds().unwrap();
                cuboid(lo[0] + (hi[0] - lo[0]) * 0.5, lo[1], lo[2], hi[0] - lo[0], hi[1] - lo[1], (hi[2] - lo[2]) * rng.f())
            } else {
                Mesh::prism(&[[rng.f() * 3.0, rng.f()], [3.0 + rng.f(), rng.f() * 3.0], [rng.f() * 3.0, 3.0 + rng.f()], [-rng.f(), 1.0 + rng.f()]], rng.f(), 1.0 + rng.f() * 2.0)
            };
            // Korruption: Koordinaten, Indizes, Abschneiden, Duplikate, Entartung.
            let target = if rng.next() % 2 == 0 { &mut a } else { &mut b };
            match rng.next() % 9 {
                0 => {
                    let i = (rng.next() as usize) % target.positions.len().max(1);
                    if let Some(v) = target.positions.get_mut(i) {
                        *v = rng.pick(&specials);
                    }
                }
                1 => {
                    let i = (rng.next() as usize) % target.indices.len().max(1);
                    if let Some(v) = target.indices.get_mut(i) {
                        *v = (rng.next() % 64) as u32;
                    }
                }
                2 => {
                    let k = (rng.next() as usize) % (target.indices.len() + 1);
                    target.indices.truncate(k);
                }
                3 => {
                    let k = (rng.next() as usize) % (target.positions.len() + 1);
                    target.positions.truncate(k);
                }
                4 => {
                    let t: Vec<u32> = target.indices.iter().take(6).copied().collect();
                    target.indices.extend(t);
                }
                5 => {
                    // alles auf eine Ebene drücken
                    for v in target.positions.iter_mut().skip(2).step_by(3) {
                        *v = 0.0;
                    }
                }
                6 => {
                    // Ecke minimal verschieben (Splitter)
                    let s = rng.pick(&[1e-10, 1e-8, 1e-6, 1e-3]);
                    for v in target.positions.iter_mut().take(3) {
                        *v += s;
                    }
                }
                7 => target.indices.chunks_exact_mut(3).for_each(|t| t.swap(1, 2)),
                _ => {}
            }
            let op = rng.pick(&["union", "difference", "intersection"]);
            let r = std::panic::catch_unwind(|| boolean(&a, &b, op));
            let r = r.unwrap_or_else(|_| panic!("Panik in Runde {round} ({op})"));
            if let Ok(m) = r {
                ok += 1;
                if !m.is_empty() {
                    assert!(m.is_closed_exact(), "Runde {round}: Ergebnis offen");
                    assert!(m.volume() > -1e-9 && m.volume().is_finite());
                }
            }
        }
        assert!(ok > 100, "genug gültige Fälle: {ok}");
    }

    /// Fuzz über die flache Kodierung (Bytes wie aus TS): zufällige Puffer.
    #[test]
    fn fuzz_flat_buffers_never_panic() {
        let mut rng = Rng(12345);
        let a = encode_mesh(&cuboid(0.0, 0.0, 0.0, 1.0, 1.0, 1.0));
        for _ in 0..2000 {
            let mut buf = a.clone();
            for _ in 0..(rng.next() % 4) {
                let i = (rng.next() as usize) % buf.len();
                buf[i] = match rng.next() % 5 {
                    0 => f64::NAN,
                    1 => -(rng.f() * 10.0),
                    2 => (rng.next() % 40) as f64,
                    3 => rng.f() * 1e12,
                    _ => rng.f(),
                };
            }
            if rng.next() % 4 == 0 {
                let k = (rng.next() as usize) % (buf.len() + 1);
                buf.truncate(k);
            }
            let op = (rng.next() % 4) as f64;
            let r = std::panic::catch_unwind(|| boolean_flat(op, &buf, &a));
            assert!(r.is_ok(), "Panik bei {buf:?}");
        }
    }
}
