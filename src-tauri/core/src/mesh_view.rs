//! [152] Importierte Netze (`ImportedMesh`, IFC/OBJ/glTF …) für Schnitt, Ansicht und Grundriss.
//!
//! Gemeinsam für alle drei Ableitungen: die sichtbaren Netze des Projekts mit ihrer Hüllbox (für das
//! Vorfiltern gegen Schnittebene und Ansichtsbereich), der Topologie (geschlossen und einheitlich
//! orientiert → einseitige Flächen mit Aussennormale, sonst beidseitig) und den Dreiecken als
//! `hlr`-Flächen. Die Netz-Kennwerte hängen nur an den Zahlen des Netzes und werden je Netz gemerkt
//! (Schlüssel = Hash über id, Ecken und Indizes; grosse Modelle rechnen beim Neuzeichnen nur Schnitt und
//! Sichtbarkeit neu, nicht die Topologie).
//!
//! Ebenenschnitt: `mesh_section::cut` (Ringe und Linienzüge); Linienzüge eines nicht einheitlich
//! orientierten Netzes, die sich ungerichtet schliessen, werden zu Ringen ([`close_chains`]), der Rest
//! bleibt offen (offene/nicht-mannigfaltige Netze: Linien statt Flächen).

use crate::model::{ContextObject, ImportedMesh, Project};
use std::collections::HashMap;
use std::rc::Rc;

/// Kennwerte eines Netzes (nur aus seinen Zahlen).
#[derive(Debug)]
pub struct MeshInfo {
    /// Gültige Dreiecke (Indizes im Bereich, ganzzahlig, Ecken endlich, nicht entartet).
    pub tris: Vec<[u32; 3]>,
    /// [xmin, ymin, zmin, xmax, ymax, zmax] (Modell, z = Höhe).
    pub bbox: [f64; 6],
    /// Geschlossen und einheitlich orientiert (jede Kante genau zweimal, gegenläufig).
    pub closed: bool,
    /// Geschlossen, aber nach innen orientiert (Volumen negativ): Normalen umkehren.
    pub flip: bool,
    /// Indizes als Zahlen für `mesh_section::cut` (nur die gültigen Dreiecke).
    pub flat_indices: Vec<f64>,
}

/// Ein sichtbares Netz des Projekts.
pub struct MeshRef<'a> {
    /// Lage in `Project::context`.
    pub index: usize,
    pub mesh: &'a ImportedMesh,
    pub info: Rc<MeshInfo>,
}

const QUANT: f64 = 1e6;

fn qkey(x: f64, y: f64, z: f64) -> (i64, i64, i64) {
    ((x * QUANT).round() as i64, (y * QUANT).round() as i64, (z * QUANT).round() as i64)
}

/// Kennwerte aus Ecken und Indizes; `None`, wenn kein gültiges Dreieck bleibt.
pub fn analyze(positions: &[f64], indices: &[f64]) -> Option<MeshInfo> {
    let nv = positions.len() / 3;
    let finite = |i: usize| positions[3 * i..3 * i + 3].iter().all(|v| v.is_finite());
    // Ecken verschweissen (gleiche Lage, 1e-6 m): IFC-Netze kommen oft je Dreieck mit eigenen Ecken.
    let mut weld: HashMap<(i64, i64, i64), u32> = HashMap::new();
    let mut wid = vec![u32::MAX; nv];
    let mut tris = Vec::with_capacity(indices.len() / 3);
    let mut bbox = [f64::INFINITY, f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY];
    for t in indices.chunks_exact(3) {
        if t.iter().any(|&i| !(i >= 0.0) || i.fract() != 0.0 || i as usize >= nv) {
            continue;
        }
        let tri = [t[0] as usize, t[1] as usize, t[2] as usize];
        if tri.iter().any(|&i| !finite(i)) {
            continue;
        }
        for &i in &tri {
            if wid[i] == u32::MAX {
                let n = weld.len() as u32;
                wid[i] = *weld.entry(qkey(positions[3 * i], positions[3 * i + 1], positions[3 * i + 2])).or_insert(n);
            }
        }
        let w = [wid[tri[0]], wid[tri[1]], wid[tri[2]]];
        if w[0] == w[1] || w[1] == w[2] || w[0] == w[2] {
            continue;
        }
        for &i in &tri {
            for k in 0..3 {
                bbox[k] = bbox[k].min(positions[3 * i + k]);
                bbox[k + 3] = bbox[k + 3].max(positions[3 * i + k]);
            }
        }
        tris.push([tri[0] as u32, tri[1] as u32, tri[2] as u32]);
    }
    if tris.is_empty() {
        return None;
    }
    // Kanten: Anzahl und Richtungssumme je ungerichteter Kante (verschweisste Ecken).
    let mut edges: HashMap<(u32, u32), (u32, i32)> = HashMap::with_capacity(tris.len() * 2);
    let mut volume = 0.0;
    for t in &tris {
        let w = [wid[t[0] as usize], wid[t[1] as usize], wid[t[2] as usize]];
        for k in 0..3 {
            let (a, b) = (w[k], w[(k + 1) % 3]);
            let e = edges.entry((a.min(b), a.max(b))).or_insert((0, 0));
            e.0 += 1;
            e.1 += if a < b { 1 } else { -1 };
        }
        let p = |i: u32| {
            let j = 3 * i as usize;
            [positions[j], positions[j + 1], positions[j + 2]]
        };
        let (a, b, c) = (p(t[0]), p(t[1]), p(t[2]));
        volume += a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
    }
    let closed = edges.values().all(|&(n, s)| n == 2 && s == 0);
    let flat_indices = tris.iter().flat_map(|t| t.iter().map(|&i| i as f64)).collect();
    Some(MeshInfo { tris, bbox, closed, flip: closed && volume < 0.0, flat_indices })
}

fn fingerprint(m: &ImportedMesh) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    let mut mix = |v: u64| h = (h ^ v).wrapping_mul(0x0000_0100_0000_01b3).rotate_left(5);
    for b in m.id.bytes() {
        mix(b as u64);
    }
    mix(m.positions.len() as u64);
    mix(m.indices.len() as u64);
    for v in m.positions.iter().chain(&m.indices) {
        mix(v.to_bits());
    }
    h
}

/// So viele Netze bleiben gemerkt; darüber wird der Speicher geleert (grosse Modelle: einige tausend).
const CACHE_MAX: usize = 50_000;

thread_local! {
    static INFO: std::cell::RefCell<HashMap<u64, Option<Rc<MeshInfo>>>> = std::cell::RefCell::new(HashMap::new());
}

/// Kennwerte eines Netzes, gemerkt nach seinem Inhalt.
pub fn info(m: &ImportedMesh) -> Option<Rc<MeshInfo>> {
    let key = fingerprint(m);
    if let Some(i) = INFO.with(|c| c.borrow().get(&key).cloned()) {
        return i;
    }
    let i = analyze(&m.positions, &m.indices).map(Rc::new);
    INFO.with(|c| {
        let mut c = c.borrow_mut();
        if c.len() >= CACHE_MAX {
            c.clear();
        }
        c.insert(key, i.clone());
    });
    i
}

/// Die gezeichneten Netze: nicht einzeln ausgeblendet ([137]), mit mindestens einem gültigen Dreieck.
/// Kategorie-Sichtbarkeit prüft der Aufrufer (UI-Zustand).
pub fn meshes(p: &Project) -> Vec<MeshRef<'_>> {
    let mut out = Vec::new();
    for (index, obj) in p.context.as_deref().unwrap_or(&[]).iter().enumerate() {
        let ContextObject::ImportedMesh(m) = obj else { continue };
        if m.hidden == Some(true) || m.positions.len() < 9 || m.indices.len() < 3 {
            continue;
        }
        if let Some(info) = info(m) {
            out.push(MeshRef { index, mesh: m, info });
        }
    }
    out
}

/// [152] Gelände aus einem IFC-Import (Klasse `IfcSite` im Layer bzw. Namen, oder Name mit „Gelände"/„Terrain",
/// z. B. ein `IfcGeographicElement` „Terrain"): im Schnitt Geländelinie statt Körper.
pub fn is_terrain(m: &ImportedMesh) -> bool {
    let (name, layer) = (m.name.to_lowercase(), m.layer.as_deref().unwrap_or("").to_lowercase());
    layer == "ifcsite" || name.contains("ifcsite") || ["gelände", "gelaende", "terrain"].iter().any(|k| name.contains(k))
}

/// Linienzüge ungerichtet aneinanderhängen (Netze mit wechselnder Orientierung): was sich schliesst,
/// wird Ring, der Rest bleibt offen. Endpunkte gleich auf 1e-6 (wie `mesh_section`).
pub fn close_chains(lines: Vec<Vec<[f64; 2]>>) -> (Vec<Vec<[f64; 2]>>, Vec<Vec<[f64; 2]>>) {
    let key = |p: [f64; 2]| ((p[0] * QUANT).round() as i64, (p[1] * QUANT).round() as i64);
    let mut lines: Vec<Option<Vec<[f64; 2]>>> = lines.into_iter().filter(|l| l.len() >= 2).map(Some).collect();
    let mut ends: HashMap<(i64, i64), Vec<usize>> = HashMap::new();
    for (i, l) in lines.iter().enumerate() {
        let l = l.as_ref().unwrap();
        ends.entry(key(l[0])).or_default().push(i);
        ends.entry(key(l[l.len() - 1])).or_default().push(i);
    }
    let (mut rings, mut open) = (Vec::new(), Vec::new());
    for i in 0..lines.len() {
        let Some(mut cur) = lines[i].take() else { continue };
        // Am Ende weiterhängen, dann am Anfang (umgedreht).
        for _ in 0..2 {
            loop {
                let k = key(cur[cur.len() - 1]);
                if k == key(cur[0]) && cur.len() > 2 {
                    break;
                }
                let next = ends.get(&k).and_then(|v| v.iter().copied().find(|&j| lines[j].is_some()));
                let Some(j) = next else { break };
                let mut l = lines[j].take().unwrap();
                if key(l[0]) != k {
                    l.reverse();
                }
                cur.extend(l.into_iter().skip(1));
            }
            if key(cur[cur.len() - 1]) == key(cur[0]) && cur.len() > 3 {
                break;
            }
            cur.reverse();
        }
        if key(cur[cur.len() - 1]) == key(cur[0]) && cur.len() > 3 {
            cur.pop();
            rings.push(cur);
        } else {
            open.push(cur);
        }
    }
    (rings, open)
}

/// Ebenenschnitt (`mesh_section::cut`, Ebene wie dort: `[0, px, py, dx, dy]` senkrecht, `[1, z]` waagrecht):
/// (Ringe, offene Linienzüge), ungerichtet geschlossene Züge als Ringe.
pub fn cut(m: &MeshRef, plane: &[f64]) -> (Vec<Vec<[f64; 2]>>, Vec<Vec<[f64; 2]>>) {
    let f = crate::mesh_section::cut(&m.mesh.positions, &m.info.flat_indices, plane);
    if f.is_empty() {
        return (Vec::new(), Vec::new());
    }
    let read = |i: &mut usize| -> Vec<Vec<[f64; 2]>> {
        let n = f[*i] as usize;
        *i += 1;
        (0..n)
            .map(|_| {
                let k = f[*i] as usize;
                *i += 1;
                let r = (0..k).map(|j| [f[*i + 2 * j], f[*i + 2 * j + 1]]).collect();
                *i += 2 * k;
                r
            })
            .collect()
    };
    let mut i = 0;
    let mut rings = read(&mut i);
    let lines = read(&mut i);
    let (more, open) = close_chains(lines);
    rings.extend(more);
    (rings, open)
}

/// Dreiecke als `hlr`-Flächen. `view`: Modellpunkt [x, y, z] → Ansicht (u, v, Tiefe), affin und
/// längentreu (auch gespiegelt); `clip`: auf die Seite hinter der Ebene (Tiefe ≥ 0) zuschneiden.
/// Geschlossene Netze einseitig mit Aussennormale, offene beidseitig.
pub fn hlr_faces(m: &MeshRef, view: &dyn Fn([f64; 3]) -> [f64; 3], owner: u32, smooth: u32, clip: bool, out: &mut Vec<crate::hlr::Face>) {
    let pos = &m.mesh.positions;
    let p = |i: u32| {
        let j = 3 * i as usize;
        [pos[j], pos[j + 1], pos[j + 2]]
    };
    let two_sided = !m.info.closed;
    for t in &m.info.tris {
        let (a, b, c) = (p(t[0]), p(t[1]), p(t[2]));
        let pts = [view(a), view(b), view(c)];
        if clip && pts.iter().all(|q| q[2] <= 0.0) {
            continue;
        }
        let (u, w) = ([b[0] - a[0], b[1] - a[1], b[2] - a[2]], [c[0] - a[0], c[1] - a[1], c[2] - a[2]]);
        let mut n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
        let l = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
        if !(l > 1e-15) {
            continue;
        }
        if m.info.flip {
            n = [-n[0], -n[1], -n[2]];
        }
        let n = [n[0] / l, n[1] / l, n[2] / l];
        // Normale in Ansichtskoordinaten: längentreue Abbildung, also Bild von a + n minus Bild von a.
        let (va, vn) = (pts[0], view([a[0] + n[0], a[1] + n[1], a[2] + n[2]]));
        let normal = [vn[0] - va[0], vn[1] - va[1], vn[2] - va[2]];
        let (pts, no_edge) = if clip {
            match crate::hlr::clip_front(&pts) {
                Some(x) => x,
                None => continue,
            }
        } else {
            (pts.to_vec(), Vec::new())
        };
        let mut f = crate::hlr::Face::new(pts, normal, owner);
        f.smooth = smooth;
        f.two_sided = two_sided;
        f.no_edge = no_edge;
        out.push(f);
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// Quader [x0,x1]×[y0,y1]×[z0,z1], Aussennormalen (12 Dreiecke, geteilte Ecken).
    pub(crate) fn cube(x0: f64, x1: f64, y0: f64, y1: f64, z0: f64, z1: f64) -> (Vec<f64>, Vec<f64>) {
        let mut pos = Vec::new();
        for k in 0..8 {
            pos.extend([if k & 1 == 0 { x0 } else { x1 }, if k & 2 == 0 { y0 } else { y1 }, if k & 4 == 0 { z0 } else { z1 }]);
        }
        let quads = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]];
        let mut idx = Vec::new();
        for q in quads {
            idx.extend([q[0], q[1], q[2], q[0], q[2], q[3]].map(|i| i as f64));
        }
        (pos, idx)
    }

    /// Prisma aus einem Profil in der (x, z)-Ebene (gegen den Uhrzeigersinn, x rechts, z oben), längs y von
    /// `y0` bis `y1`; Deckel aus den konvexen Vierecken `caps` (Profil-Indizes). Aussennormalen.
    pub(crate) fn prism(profile: &[[f64; 2]], caps: &[[usize; 4]], y0: f64, y1: f64) -> (Vec<f64>, Vec<f64>) {
        let mut pos = Vec::new();
        let n = profile.len();
        for y in [y0, y1] {
            for q in profile {
                pos.extend([q[0], y, q[1]]);
            }
        }
        let mut idx: Vec<usize> = Vec::new();
        let mut quad = |a: usize, b: usize, c: usize, d: usize| idx.extend([a, b, c, a, c, d]);
        for c in caps {
            quad(c[0], c[1], c[2], c[3]);
            quad(n + c[3], n + c[2], n + c[1], n + c[0]);
        }
        for k in 0..n {
            let (a, b) = (k, (k + 1) % n);
            quad(a, n + a, n + b, b);
        }
        (pos, idx.into_iter().map(|i| i as f64).collect())
    }

    /// Tonne: Halbring (Radien `r`, `big`) um (0, `zc`) mit `segs` Teilen, längs y von `y0` bis `y1`.
    pub(crate) fn barrel(r: f64, big: f64, zc: f64, segs: usize, y0: f64, y1: f64) -> (Vec<f64>, Vec<f64>) {
        let at = |rad: f64, k: usize| {
            let t = std::f64::consts::PI * k as f64 / segs as f64;
            [rad * t.cos(), zc + rad * t.sin()]
        };
        // Aussen 0 … segs (Winkel 0 → π), innen segs … 0.
        let mut profile: Vec<[f64; 2]> = (0..=segs).map(|k| at(big, k)).collect();
        profile.extend((0..=segs).rev().map(|k| at(r, k)));
        let inner = |k: usize| 2 * segs + 1 - k;
        let caps: Vec<[usize; 4]> = (0..segs).map(|k| [k, k + 1, inner(k + 1), inner(k)]).collect();
        prism(&profile, &caps, y0, y1)
    }

    #[test]
    fn prisma_und_tonne_geschlossen() {
        let (pos, idx) = prism(&[[0.0, 0.0], [2.0, 0.0], [2.0, 1.0], [0.0, 1.0]], &[[0, 1, 2, 3]], 0.0, 3.0);
        let i = analyze(&pos, &idx).unwrap();
        assert!(i.closed && !i.flip, "{i:?}");
        let (pos, idx) = barrel(2.7, 3.0, 5.0, 24, -2.0, 2.0);
        let i = analyze(&pos, &idx).unwrap();
        assert!(i.closed && !i.flip);
    }

    #[test]
    fn wuerfel_geschlossen_aussen_orientiert() {
        let (pos, idx) = cube(0.0, 1.0, 0.0, 2.0, 0.0, 3.0);
        let i = analyze(&pos, &idx).unwrap();
        assert!(i.closed && !i.flip, "{i:?}");
        assert_eq!(i.bbox, [0.0, 0.0, 0.0, 1.0, 2.0, 3.0]);
        // Umgekehrt orientiert: geschlossen, Normalen umkehren.
        let rev: Vec<f64> = idx.chunks(3).flat_map(|t| [t[0], t[2], t[1]]).collect();
        let i = analyze(&pos, &rev).unwrap();
        assert!(i.closed && i.flip);
        // Je Dreieck eigene Ecken (IFC): nach dem Verschweissen ebenfalls geschlossen.
        let soup: Vec<f64> = idx.iter().flat_map(|&k| pos[3 * k as usize..3 * k as usize + 3].to_vec()).collect();
        let sidx: Vec<f64> = (0..idx.len()).map(|k| k as f64).collect();
        assert!(analyze(&soup, &sidx).unwrap().closed);
    }

    #[test]
    fn offenes_und_kaputtes_netz() {
        let (pos, idx) = cube(0.0, 1.0, 0.0, 1.0, 0.0, 1.0);
        // Deckel weg: offen.
        let open: Vec<f64> = idx[6..].to_vec();
        let i = analyze(&pos, &open).unwrap();
        assert!(!i.closed && !i.flip);
        // Unsinn: NaN, Index ausserhalb, entartet → nur gültige Dreiecke; nichts Gültiges → None.
        let mut bad = pos.clone();
        bad[0] = f64::NAN;
        assert_eq!(analyze(&bad, &idx).unwrap().tris.len(), 6);
        assert!(analyze(&pos, &[0.0, 0.0, 1.0, 1.0, 2.0, 99.0, 0.5, 1.0, 2.0]).is_none());
    }

    #[test]
    fn zuege_ungerichtet_schliessen() {
        // Quadrat aus zwei gegenläufigen Hälften.
        let a = vec![[0.0, 0.0], [1.0, 0.0], [1.0, 1.0]];
        let b = vec![[0.0, 0.0], [0.0, 1.0], [1.0, 1.0]];
        let (rings, open) = close_chains(vec![a, b, vec![[5.0, 5.0], [6.0, 5.0]]]);
        assert_eq!(rings.len(), 1);
        assert_eq!(rings[0].len(), 4);
        assert_eq!(open.len(), 1);
    }
}
