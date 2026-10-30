//! Exakte Sichtbarkeit (Hidden-Line-Removal, [G4]) für Ansicht und Projektionsteil des Schnitts.
//!
//! Eingabe sind ebene Flächen (Polygone oder Dreiecke) in Ansichtskoordinaten `(u, v, d)`: `(u, v)`
//! ist die Zeichenebene, `d` die Tiefe längs der Blickrichtung (grösser = weiter weg). Ausgabe sind
//! die Kanten, die eine Zeichnung zeigt, zerlegt in sichtbare und verdeckte Teilstücke.
//!
//! 1. **Kanten einordnen.** Jede Polygonkante wird an den Endpunkten kollinearer, überlappender Kanten
//!    anderer Flächen zerlegt (T-Stösse). Für jedes Teilstück zählen die anliegenden Flächen:
//!    - deckungsgleiche Gegenflächen auf derselben Seite (Stoss zweier Körper, Schicht an Schicht)
//!      heben sich auf;
//!    - eine zugewandte Fläche ist „fortgesetzt“, wenn auf der anderen Seite eine zugewandte Fläche
//!      in derselben Ebene liegt (Fuge, Triangulations-Diagonale) oder — innerhalb derselben
//!      Glättungsgruppe (`smooth`) — um weniger als den Knickwinkel abknickt (Facetten eines Bogens,
//!      eines Geländes, eines importierten Netzes);
//!    - gezeichnet wird, wenn mindestens eine zugewandte Fläche nicht fortgesetzt ist: Umriss, Rand,
//!      Silhouette (Nachbar abgewandt) oder Knick über dem Winkel.
//! 2. **Sichtbarkeit.** Jedes Teilstück wird gegen die zugewandten Verdecker geprüft (2D-Raster als
//!    Vorauswahl, je Zelle nach kleinster Tiefe sortiert). Je Verdecker: Parameterbereiche, in denen
//!    die Projektion der Kante im Polygon liegt, Rand eingeschlossen (Schnittpunkte mit den
//!    Polygonkanten, Mittelpunkttest mit Randtoleranz); darin ist die Tiefendifferenz Kante − Ebene des
//!    Verdeckers linear, verdeckt ist genau der Teil mit Differenz > `depth_eps`. Gemeinsame Kanten,
//!    koplanare und anstossende Flächen verdecken sich so nicht gegenseitig (gleiche Tiefe: kein
//!    Flackern, keine falschen verdeckten Stücke); eine Kante genau hinter dem Rand oder einer Fuge
//!    näherer Flächen ist verdeckt (sie fiele mit deren Kante zusammen bzw. schiene durch die Fuge).
//!
//! Nicht gezeichnet werden Durchdringungslinien sich schneidender Körper (keine Polygonkante).

use std::collections::HashMap;
use std::hash::{BuildHasherDefault, Hasher};

/// Schneller Hasher für Ganzzahl-Schlüssel (Raster, Geraden).
#[derive(Default)]
struct Fx(u64);

impl Hasher for Fx {
    fn finish(&self) -> u64 {
        self.0
    }
    fn write(&mut self, bytes: &[u8]) {
        for &b in bytes {
            self.write_u64(b as u64);
        }
    }
    fn write_u64(&mut self, i: u64) {
        self.0 = (self.0.rotate_left(5) ^ i).wrapping_mul(0x517c_c1b7_2722_0a95);
    }
    fn write_i64(&mut self, i: i64) {
        self.write_u64(i as u64);
    }
    fn write_u8(&mut self, i: u8) {
        self.write_u64(i as u64);
    }
}

type FxMap<K, V> = HashMap<K, V, BuildHasherDefault<Fx>>;

pub type V3 = [f64; 3];

/// Eine ebene Fläche in Ansichtskoordinaten.
#[derive(Clone, Debug)]
pub struct Face {
    pub pts: Vec<V3>,
    /// Aussennormale in Ansichtskoordinaten; zugewandt, wenn `normal[2] < 0`.
    pub normal: V3,
    /// Glättungsgruppe (0 = keine): Knicke unter dem Winkel zwischen Flächen derselben Gruppe fallen weg.
    pub smooth: u32,
    /// Besitzer (vom Aufrufer vergeben), wird an die Kanten weitergereicht.
    pub owner: u32,
    /// Liefert Kanten (sonst nur Verdecker, z. B. Öffnungen, Schnittflächen).
    pub edges: bool,
    /// Verdeckt (nur zugewandt).
    pub occludes: bool,
    /// Beidseitig (offene Fläche, z. B. Dachhaut ohne Dicke): immer zugewandt, verdeckt von beiden Seiten.
    pub two_sided: bool,
    /// Kanten `i → i+1`, die nie gezeichnet werden (z. B. vom Abschneiden an der Schnittebene); leer = keine.
    pub no_edge: Vec<bool>,
}

impl Face {
    pub fn new(pts: Vec<V3>, normal: V3, owner: u32) -> Face {
        Face { pts, normal, smooth: 0, owner, edges: true, occludes: true, two_sided: false, no_edge: Vec::new() }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Opts {
    /// Knickwinkel (Grad) innerhalb einer Glättungsgruppe.
    pub crease_deg: f64,
    /// Lage-Toleranz (m): gleiche Kante, Punkt auf dem Rand.
    pub tol: f64,
    /// Tiefen-Toleranz (m): erst so weit hinter einer Fläche gilt eine Kante als verdeckt.
    pub depth_eps: f64,
    /// Verdeckte Teilstücke mit ausgeben.
    pub hidden: bool,
}

impl Default for Opts {
    fn default() -> Opts {
        Opts { crease_deg: 20.0, tol: 1e-5, depth_eps: 1e-5, hidden: false }
    }
}

/// Ein ausgegebenes Teilstück (Zeichenebene).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Seg {
    pub a: [f64; 2],
    pub b: [f64; 2],
    pub owner: u32,
    pub hidden: bool,
}

fn sub(a: V3, b: V3) -> V3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
fn dot(a: V3, b: V3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
fn cross(a: V3, b: V3) -> V3 {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}
fn norm(a: V3) -> f64 {
    dot(a, a).sqrt()
}
fn unit(a: V3) -> V3 {
    let l = norm(a);
    if l > 0.0 && l.is_finite() {
        [a[0] / l, a[1] / l, a[2] / l]
    } else {
        [0.0; 3]
    }
}
fn lerp(a: V3, b: V3, t: f64) -> V3 {
    [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}

/// Newell-Normale (Umlaufsinn des Polygons), normiert.
fn newell(pts: &[V3]) -> V3 {
    let mut n = [0.0; 3];
    for i in 0..pts.len() {
        let a = pts[i];
        let b = pts[(i + 1) % pts.len()];
        n[0] += (a[1] - b[1]) * (a[2] + b[2]);
        n[1] += (a[2] - b[2]) * (a[0] + b[0]);
        n[2] += (a[0] - b[0]) * (a[1] + b[1]);
    }
    unit(n)
}

/// Vorbereitete Fläche.
struct Prep {
    /// Normale (Aussen, normiert; beidseitig: zum Betrachter gedreht).
    n: V3,
    /// Umlauf-Normale (für die Innenseite einer Kante).
    nw: V3,
    front: bool,
    /// Verdecker: Ebene `d = c0 + cu·u + cv·v`, 2D-Umriss, Ausdehnung.
    occ: Option<Occ>,
}

struct Occ {
    c0: f64,
    cu: f64,
    cv: f64,
    poly: Vec<[f64; 2]>,
    bb: [f64; 4],
    dmin: f64,
    convex: bool,
}

/// Konvex (alle Umlauf-Kreuzprodukte mit gleichem Vorzeichen)?
fn is_convex(poly: &[[f64; 2]]) -> bool {
    let n = poly.len();
    let (mut pos, mut neg) = (false, false);
    for i in 0..n {
        let (a, b, c) = (poly[i], poly[(i + 1) % n], poly[(i + 2) % n]);
        let z = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
        pos |= z > 1e-12;
        neg |= z < -1e-12;
    }
    !(pos && neg)
}

const FRONT_EPS: f64 = 1e-4;

fn prepare(f: &Face) -> Option<Prep> {
    if f.pts.len() < 3 || f.pts.iter().any(|p| p.iter().any(|v| !v.is_finite())) {
        return None;
    }
    let nw = newell(&f.pts);
    if nw == [0.0; 3] {
        return None;
    }
    let mut n = unit(f.normal);
    if n == [0.0; 3] {
        n = nw;
    }
    if f.two_sided && n[2] > 0.0 {
        n = [-n[0], -n[1], -n[2]];
    }
    let front = n[2] < -FRONT_EPS;
    let occ = if f.occludes && front && nw[2].abs() > 1e-9 {
        let p0 = f.pts[0];
        let cu = -nw[0] / nw[2];
        let cv = -nw[1] / nw[2];
        let c0 = p0[2] - cu * p0[0] - cv * p0[1];
        let poly: Vec<[f64; 2]> = f.pts.iter().map(|p| [p[0], p[1]]).collect();
        let mut bb = [f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY];
        let mut dmin = f64::INFINITY;
        for p in &f.pts {
            bb[0] = bb[0].min(p[0]);
            bb[1] = bb[1].min(p[1]);
            bb[2] = bb[2].max(p[0]);
            bb[3] = bb[3].max(p[1]);
            dmin = dmin.min(p[2]);
        }
        let convex = is_convex(&poly);
        Some(Occ { c0, cu, cv, poly, bb, dmin, convex })
    } else {
        None
    };
    Some(Prep { n, nw, front, occ })
}

struct Edge {
    a: V3,
    b: V3,
    face: u32,
}

/// Kanten, die die Zeichnung zeigt (3D-Teilstücke mit Flächen-Index).
fn feature_edges(faces: &[Face], prep: &[Option<Prep>], covered: &[bool], opts: &Opts) -> Vec<(V3, V3, u32)> {
    let tol = opts.tol;
    let cos_crease = opts.crease_deg.to_radians().cos();
    let mut edges: Vec<Edge> = Vec::new();
    for (fi, f) in faces.iter().enumerate() {
        if !f.edges || prep[fi].is_none() {
            continue;
        }
        let n = f.pts.len();
        for i in 0..n {
            if f.no_edge.get(i).copied().unwrap_or(false) {
                continue;
            }
            let (a, b) = (f.pts[i], f.pts[(i + 1) % n]);
            if norm(sub(b, a)) > tol {
                edges.push(Edge { a, b, face: fi as u32 });
            }
        }
    }
    if edges.is_empty() {
        return Vec::new();
    }
    // Kandidaten kollinearer Kanten: achsparallele Kanten über einen Geraden-Schlüssel (Achse und
    // gerasterte Querlage; eingetragen in alle Fächer im Toleranzband, gesucht im eigenen Fach), die
    // übrigen über ein 3D-Raster (Zellen, die das Segment samt Toleranz berühren).
    let bin = 64.0 * tol;
    let axis_of = |e: &Edge| -> Option<usize> {
        let d = sub(e.b, e.a);
        (0..3).find(|&k| (0..3).all(|j| j == k || d[j].abs() <= tol))
    };
    let across = |e: &Edge, k: usize| [(e.a[(k + 1) % 3] + e.b[(k + 1) % 3]) / 2.0, (e.a[(k + 2) % 3] + e.b[(k + 2) % 3]) / 2.0];
    let fbin = |x: f64| (x / bin).floor() as i64;
    let axis: Vec<Option<usize>> = edges.iter().map(axis_of).collect();
    let subject = |e: &Edge| !covered[e.face as usize] && prep[e.face as usize].as_ref().is_some_and(|p| p.front);
    // Nur Geraden, nach denen eine zeichnende Kante fragt, werden gesammelt.
    let wanted: std::collections::HashSet<u64, BuildHasherDefault<Fx>> = edges
        .iter()
        .zip(&axis)
        .filter_map(|(e, k)| {
            let k = (*k)?;
            let c = across(e, k);
            subject(e).then(|| line_key(k, fbin(c[0]), fbin(c[1])))
        })
        .collect();
    let mut entries: Vec<(u64, f64, u32)> = Vec::new();
    let (mut lo, mut hi) = ([f64::INFINITY; 3], [f64::NEG_INFINITY; 3]);
    let (mut total, mut count) = (0.0, 0usize);
    for (ei, e) in edges.iter().enumerate() {
        match axis[ei] {
            Some(k) => {
                let c = across(e, k);
                for bi in fbin(c[0] - 2.0 * tol)..=fbin(c[0] + 2.0 * tol) {
                    for bj in fbin(c[1] - 2.0 * tol)..=fbin(c[1] + 2.0 * tol) {
                        let key = line_key(k, bi, bj);
                        if wanted.contains(&key) {
                            entries.push((key, e.a[k].min(e.b[k]), ei as u32));
                        }
                    }
                }
            }
            None => {
                for k in 0..3 {
                    lo[k] = lo[k].min(e.a[k].min(e.b[k]));
                    hi[k] = hi[k].max(e.a[k].max(e.b[k]));
                }
                total += norm(sub(e.b, e.a));
                count += 1;
            }
        }
    }
    // Nach Gerade und Anfang längs der Achse sortiert, je Gerade mit laufendem Maximum der Enden: eine
    // Abfrage sieht nur Kanten, deren Bereich ihren berühren kann.
    let span = |ei: u32, k: usize| {
        let e = &edges[ei as usize];
        (e.a[k].min(e.b[k]), e.a[k].max(e.b[k]))
    };
    entries.sort_unstable_by(|a, b| a.0.cmp(&b.0).then(a.1.total_cmp(&b.1)));
    let mut ends: Vec<f64> = Vec::with_capacity(entries.len());
    for (i, x) in entries.iter().enumerate() {
        let end = span(x.2, axis[x.2 as usize].unwrap_or(0)).1;
        ends.push(if i > 0 && entries[i - 1].0 == x.0 { ends[i - 1].max(end) } else { end });
    }
    let diag = if count > 0 { norm(sub(hi, lo)).max(tol) } else { 1.0 };
    let h = if count > 0 { (total / count as f64).clamp(diag / 512.0, diag / 2.0).max(tol * 16.0) } else { 1.0 };
    let cell = |x: f64, k: usize| ((x - lo[k]) / h).floor() as i64;
    let range = |e: &Edge, k: usize| (cell(e.a[k].min(e.b[k]) - tol, k), cell(e.a[k].max(e.b[k]) + tol, k));
    let mut grid: FxMap<(i64, i64, i64), Vec<u32>> = FxMap::default();
    for (ei, e) in edges.iter().enumerate().filter(|(ei, _)| axis[*ei].is_none()) {
        let (x, y, z) = (range(e, 0), range(e, 1), range(e, 2));
        let cells = (x.1 - x.0 + 1) * (y.1 - y.0 + 1) * (z.1 - z.0 + 1);
        let d = sub(e.b, e.a);
        let len2 = dot(d, d);
        for i in x.0..=x.1 {
            for j in y.0..=y.1 {
                for k in z.0..=z.1 {
                    if cells > 8 {
                        // Nur Zellen nahe am Segment (Abstand Zellmitte ↔ Segment ≤ halbe Diagonale).
                        let c = [lo[0] + (i as f64 + 0.5) * h, lo[1] + (j as f64 + 0.5) * h, lo[2] + (k as f64 + 0.5) * h];
                        let t = (dot(sub(c, e.a), d) / len2).clamp(0.0, 1.0);
                        if norm(sub(c, lerp(e.a, e.b, t))) > h * 0.8661 + tol {
                            continue;
                        }
                    }
                    grid.entry((i, j, k)).or_default().push(ei as u32);
                }
            }
        }
    }
    let mut stamp = vec![u32::MAX; edges.len()];
    let mut out = Vec::new();
    let mut cover: Vec<(f64, f64, u32, V3)> = Vec::new();
    let mut ts: Vec<f64> = Vec::new();
    let mut cands: Vec<u32> = Vec::new();
    let mut att: Vec<(u32, V3)> = Vec::new();
    let front = |fi: u32| !covered[fi as usize] && prep[fi as usize].as_ref().is_some_and(|p| p.front);
    for (ei, e) in edges.iter().enumerate() {
        // Gezeichnet wird nur von Kanten zugewandter Flächen (abgewandte zählen nur als Nachbarn).
        if !front(e.face) {
            continue;
        }
        let d = sub(e.b, e.a);
        let len = norm(d);
        let dir = [d[0] / len, d[1] / len, d[2] / len];
        cover.clear();
        cands.clear();
        match axis[ei] {
            Some(k) => {
                let c = across(e, k);
                let key = line_key(k, fbin(c[0]), fbin(c[1]));
                let (s0, s1) = span(ei as u32, k);
                let g0 = entries.partition_point(|x| x.0 < key);
                let mut j = g0 + entries[g0..].partition_point(|x| x.0 == key && x.1 < s1 + tol);
                while j > g0 && ends[j - 1] > s0 - tol {
                    j -= 1;
                    cands.push(entries[j].2);
                }
            }
            None => {
                let (x, y, z) = (range(e, 0), range(e, 1), range(e, 2));
                let cells = (x.1 - x.0 + 1) * (y.1 - y.0 + 1) * (z.1 - z.0 + 1);
                let len2 = len * len;
                for i in x.0..=x.1 {
                    for j in y.0..=y.1 {
                        for k in z.0..=z.1 {
                            if cells > 8 {
                                let c = [lo[0] + (i as f64 + 0.5) * h, lo[1] + (j as f64 + 0.5) * h, lo[2] + (k as f64 + 0.5) * h];
                                let t = (dot(sub(c, e.a), d) / len2).clamp(0.0, 1.0);
                                if norm(sub(c, lerp(e.a, e.b, t))) > h * 0.8661 + tol {
                                    continue;
                                }
                            }
                            if let Some(list) = grid.get(&(i, j, k)) {
                                cands.extend(list.iter().copied());
                            }
                        }
                    }
                }
            }
        }
        for &gi in &cands {
            if gi as usize == ei || stamp[gi as usize] == ei as u32 {
                continue;
            }
            stamp[gi as usize] = ei as u32;
            let g = &edges[gi as usize];
            // Kollinear: beide Endpunkte von G auf der Geraden von E.
            let (ra, rb) = (sub(g.a, e.a), sub(g.b, e.a));
            let (ta, tb) = (dot(ra, dir), dot(rb, dir));
            let (s, t) = (ta.min(tb).max(0.0), ta.max(tb).min(len));
            if t - s <= tol {
                continue;
            }
            if norm(sub(ra, [dir[0] * ta, dir[1] * ta, dir[2] * ta])) > tol || norm(sub(rb, [dir[0] * tb, dir[1] * tb, dir[2] * tb])) > tol {
                continue;
            }
            let gw = inward(&prep[g.face as usize], g.a, g.b);
            cover.push((s / len, t / len, gi, gw));
        }
        let ew = inward(&prep[e.face as usize], e.a, e.b);
        ts.clear();
        ts.extend([0.0, 1.0]);
        for c in &cover {
            ts.extend([c.0, c.1]);
        }
        ts.sort_by(f64::total_cmp);
        let mut run: Option<(f64, f64)> = None;
        let flush = |run: &mut Option<(f64, f64)>, out: &mut Vec<(V3, V3, u32)>| {
            if let Some((s, t)) = run.take() {
                out.push((lerp(e.a, e.b, s), lerp(e.a, e.b, t), e.face));
            }
        };
        for w in ts.windows(2) {
            let (s, t) = (w[0], w[1]);
            if (t - s) * len <= tol {
                continue;
            }
            let m = (s + t) / 2.0;
            // Gezeichnet von der Kante (einer zugewandten Fläche) mit dem kleinsten Index, die das Stück trägt.
            let covering = cover.iter().filter(|c| c.0 <= m && m <= c.1);
            att.clear();
            att.push((e.face, ew));
            let mut mine = true;
            for c in covering {
                if (c.2 as usize) < ei && front(edges[c.2 as usize].face) {
                    mine = false;
                    break;
                }
                att.push((edges[c.2 as usize].face, c.3));
            }
            if mine && is_feature(faces, prep, &att, cos_crease) {
                match &mut run {
                    Some((_, end)) if (*end - s).abs() * len <= tol => *end = t,
                    _ => {
                        flush(&mut run, &mut out);
                        run = Some((s, t));
                    }
                }
            } else {
                flush(&mut run, &mut out);
            }
        }
        flush(&mut run, &mut out);
    }
    out
}

/// Schlüssel einer achsparallelen Geraden (Achse, Fächer quer dazu), auf 64 Bit gemischt. Gleiche
/// Schlüssel verschiedener Geraden kosten nur Vergleiche (die Kollinearität prüft der Aufrufer).
fn line_key(k: usize, bi: i64, bj: i64) -> u64 {
    let mut h = Fx(k as u64);
    h.write_i64(bi);
    h.write_i64(bj);
    h.finish()
}

/// Richtung ins Innere der Fläche an der Kante `a → b` (in der Ebene, normiert).
fn inward(p: &Option<Prep>, a: V3, b: V3) -> V3 {
    match p {
        Some(p) => unit(cross(p.nw, sub(b, a))),
        None => [0.0; 3],
    }
}

/// Zeichnet die Zeichnung das Kantenstück mit den anliegenden Flächen `att` (Fläche, Innenrichtung)?
fn is_feature(faces: &[Face], prep: &[Option<Prep>], att: &[(u32, V3)], cos_crease: f64) -> bool {
    let n = |i: u32| prep[i as usize].as_ref().map_or([0.0; 3], |p| p.n);
    let att = &att[..att.len().min(64)];
    let mut gone = 0u64;
    // Deckungsgleiche Gegenflächen auf derselben Seite heben sich auf (innere Stossflächen).
    for i in 0..att.len() {
        if gone & (1 << i) != 0 {
            continue;
        }
        for j in i + 1..att.len() {
            if gone & (1 << j) == 0 && dot(n(att[i].0), n(att[j].0)) < -1.0 + 1e-6 && dot(att[i].1, att[j].1) > 1.0 - 1e-3 {
                gone |= (1 << i) | (1 << j);
                break;
            }
        }
    }
    let front = |i: usize| gone & (1 << i) == 0 && prep[att[i].0 as usize].as_ref().is_some_and(|p| p.front);
    for i in 0..att.len() {
        if !front(i) {
            continue;
        }
        let (fi, wi) = att[i];
        let ni = n(fi);
        let continued = (0..att.len()).any(|j| {
            if j == i || !front(j) || dot(wi, att[j].1) > -0.5 {
                return false;
            }
            let c = dot(ni, n(att[j].0));
            let (si, sj) = (faces[fi as usize].smooth, faces[att[j].0 as usize].smooth);
            c > 1.0 - 1e-6 || (si != 0 && si == sj && c > cos_crease)
        });
        if !continued {
            return true;
        }
    }
    false
}

/// 2D-Raster der Verdecker, je Zelle nach kleinster Tiefe sortiert (flach: Zelle `c` belegt
/// `items[start[c]..start[c + 1]]`).
struct OccGrid {
    lo: [f64; 2],
    inv: [f64; 2],
    n: [usize; 2],
    start: Vec<usize>,
    items: Vec<(f64, u32)>,
}

impl OccGrid {
    fn new(prep: &[Option<Prep>]) -> OccGrid {
        let (mut lo, mut hi) = ([f64::INFINITY; 2], [f64::NEG_INFINITY; 2]);
        let mut count = 0usize;
        for o in prep.iter().flatten().filter_map(|p| p.occ.as_ref()) {
            lo = [lo[0].min(o.bb[0]), lo[1].min(o.bb[1])];
            hi = [hi[0].max(o.bb[2]), hi[1].max(o.bb[3])];
            count += 1;
        }
        let side = (((count as f64).sqrt() / 2.0).ceil() as usize).clamp(1, 256);
        let mut n = [1usize; 2];
        let mut inv = [0.0; 2];
        for k in 0..2 {
            if hi[k] > lo[k] {
                n[k] = side;
                inv[k] = side as f64 / (hi[k] - lo[k]);
            }
        }
        let mut g = OccGrid { lo, inv, n, start: vec![0; n[0] * n[1] + 1], items: Vec::new() };
        let span = |g: &OccGrid, o: &Occ| (g.cell(o.bb[0], 0), g.cell(o.bb[2], 0), g.cell(o.bb[1], 1), g.cell(o.bb[3], 1));
        for o in prep.iter().flatten().filter_map(|p| p.occ.as_ref()) {
            let (x0, x1, y0, y1) = span(&g, o);
            for y in y0..=y1 {
                for x in x0..=x1 {
                    g.start[y * n[0] + x + 1] += 1;
                }
            }
        }
        for c in 1..g.start.len() {
            g.start[c] += g.start[c - 1];
        }
        let mut fill = g.start.clone();
        g.items = vec![(0.0, 0); *g.start.last().unwrap_or(&0)];
        for (i, p) in prep.iter().enumerate() {
            let Some(o) = p.as_ref().and_then(|p| p.occ.as_ref()) else { continue };
            let (x0, x1, y0, y1) = span(&g, o);
            for y in y0..=y1 {
                for x in x0..=x1 {
                    let c = y * n[0] + x;
                    g.items[fill[c]] = (o.dmin, i as u32);
                    fill[c] += 1;
                }
            }
        }
        for c in 0..n[0] * n[1] {
            g.items[g.start[c]..g.start[c + 1]].sort_unstable_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)));
        }
        g
    }

    fn at(&self, x: usize, y: usize) -> &[(f64, u32)] {
        let c = y * self.n[0] + x;
        &self.items[self.start[c]..self.start[c + 1]]
    }

    fn cell(&self, x: f64, k: usize) -> usize {
        if self.inv[k] == 0.0 {
            return 0;
        }
        let c = ((x - self.lo[k]) * self.inv[k]).floor();
        if c.is_nan() {
            0
        } else {
            c.clamp(0.0, (self.n[k] - 1) as f64) as usize
        }
    }
}

/// Liegt `p` im Polygon oder auf dessen Rand (Abstand ≤ `tol`)?
fn inside_closed(p: [f64; 2], poly: &[[f64; 2]], tol: f64) -> bool {
    let mut inside = false;
    let n = poly.len();
    let mut j = n - 1;
    for i in 0..n {
        let (a, b) = (poly[j], poly[i]);
        let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
        let l2 = dx * dx + dy * dy;
        let t = if l2 > 0.0 { (((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2).clamp(0.0, 1.0) } else { 0.0 };
        let (qx, qy) = (a[0] + dx * t - p[0], a[1] + dy * t - p[1]);
        if qx * qx + qy * qy <= tol * tol {
            return true;
        }
        if (b[1] > p[1]) != (a[1] > p[1]) && p[0] < (a[0] - b[0]) * (p[1] - b[1]) / (a[1] - b[1]) + b[0] {
            inside = !inside;
        }
        j = i;
    }
    inside
}

/// Verdeckte Parameterbereiche des Segments `a → b` (3D, Ansicht) durch den Verdecker `o`.
fn occluded_by(a: V3, b: V3, o: &Occ, opts: &Opts, out: &mut Vec<(f64, f64)>) {
    let (du, dv) = (b[0] - a[0], b[1] - a[1]);
    let mut ts = vec![0.0, 1.0];
    let n = o.poly.len();
    for i in 0..n {
        let (p, q) = (o.poly[i], o.poly[(i + 1) % n]);
        let (ex, ey) = (q[0] - p[0], q[1] - p[1]);
        let den = du * ey - dv * ex;
        if den.abs() < 1e-18 {
            continue;
        }
        let (wx, wy) = (p[0] - a[0], p[1] - a[1]);
        let t = (wx * ey - wy * ex) / den;
        let s = (wx * dv - wy * du) / den;
        if t > 0.0 && t < 1.0 && (-1e-9..=1.0 + 1e-9).contains(&s) {
            ts.push(t);
        }
    }
    ts.sort_by(f64::total_cmp);
    let depth = |t: f64| {
        let p = lerp(a, b, t);
        p[2] - (o.c0 + o.cu * p[0] + o.cv * p[1])
    };
    for w in ts.windows(2) {
        let (t0, t1) = (w[0], w[1]);
        if t1 - t0 <= 1e-12 {
            continue;
        }
        let m = lerp(a, b, (t0 + t1) / 2.0);
        if !inside_closed([m[0], m[1]], &o.poly, opts.tol) {
            continue;
        }
        // Linear: Kante hinter der Ebene um mehr als depth_eps.
        let (g0, g1) = (depth(t0) - opts.depth_eps, depth(t1) - opts.depth_eps);
        if g0 > 0.0 && g1 > 0.0 {
            out.push((t0, t1));
        } else if g0 > 0.0 || g1 > 0.0 {
            let tz = t0 + (t1 - t0) * g0 / (g0 - g1);
            out.push(if g0 > 0.0 { (t0, tz) } else { (tz, t1) });
        }
    }
}

/// Liegt die Fläche ganz hinter einem einzigen konvexen Verdecker (alle Ecken darin und dahinter)?
fn fully_covered(f: &Face, prep: &[Option<Prep>], grid: &OccGrid, opts: &Opts) -> bool {
    let (mut bb, mut dmax) = ([f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY], f64::NEG_INFINITY);
    for p in &f.pts {
        bb = [bb[0].min(p[0]), bb[1].min(p[1]), bb[2].max(p[0]), bb[3].max(p[1])];
        dmax = dmax.max(p[2]);
    }
    // Eine Zelle unter der Mitte genügt: ein Verdecker, der alles deckt, liegt auch dort. Nur die
    // nächsten Verdecker (Vorauswahl; was hier nicht gedeckt gilt, prüft die Kantenrechnung genau).
    let (x, y) = (grid.cell((bb[0] + bb[2]) / 2.0, 0), grid.cell((bb[1] + bb[3]) / 2.0, 1));
    for &(dmin, oi) in grid.at(x, y).iter().take(48) {
        if dmin >= dmax - opts.depth_eps {
            break;
        }
        let Some(o) = prep[oi as usize].as_ref().and_then(|p| p.occ.as_ref()) else { continue };
        if !o.convex || o.bb[0] > bb[0] + opts.tol || o.bb[1] > bb[1] + opts.tol || o.bb[2] < bb[2] - opts.tol || o.bb[3] < bb[3] - opts.tol {
            continue;
        }
        if f.pts.iter().all(|p| p[2] - (o.c0 + o.cu * p[0] + o.cv * p[1]) > opts.depth_eps && inside_closed([p[0], p[1]], &o.poly, opts.tol)) {
            return true;
        }
    }
    false
}

/// Sichtbare (und auf Wunsch verdeckte) Kanten der Flächen.
pub fn hidden_lines(faces: &[Face], opts: &Opts) -> Vec<Seg> {
    let prep: Vec<Option<Prep>> = faces.iter().map(prepare).collect();
    let grid = OccGrid::new(&prep);
    // Ohne verdeckte Kanten: Flächen, die ein konvexer Verdecker ganz deckt, zeichnen keine Kanten.
    let covered: Vec<bool> = if opts.hidden { vec![false; faces.len()] } else { faces.iter().zip(&prep).map(|(f, p)| p.as_ref().is_some_and(|p| p.front) && fully_covered(f, &prep, &grid, opts)).collect() };
    let feats = feature_edges(faces, &prep, &covered, opts);
    if feats.is_empty() {
        return Vec::new();
    }
    let mut stamp = vec![u32::MAX; faces.len()];
    let mut out = Vec::new();
    let mut ivs: Vec<(f64, f64)> = Vec::new();
    for (k, &(a, b, fi)) in feats.iter().enumerate() {
        let (du, dv) = (b[0] - a[0], b[1] - a[1]);
        if (du * du + dv * dv).sqrt() <= opts.tol {
            continue; // in Blickrichtung: ein Punkt
        }
        let owner = faces[fi as usize].owner;
        let dmax = a[2].max(b[2]) - opts.depth_eps;
        let (umin, umax, vmin, vmax) = (a[0].min(b[0]), a[0].max(b[0]), a[1].min(b[1]), a[1].max(b[1]));
        ivs.clear();
        let mut full = false;
        let (x0, x1) = (grid.cell(umin - opts.tol, 0), grid.cell(umax + opts.tol, 0));
        let (y0, y1) = (grid.cell(vmin - opts.tol, 1), grid.cell(vmax + opts.tol, 1));
        'cells: for y in y0..=y1 {
            for x in x0..=x1 {
                if x1 > x0 && y1 > y0 && !seg_hits_cell(&grid, a, b, x, y) {
                    continue;
                }
                for &(dmin, oi) in grid.at(x, y) {
                    if dmin >= dmax {
                        break;
                    }
                    if stamp[oi as usize] == k as u32 {
                        continue;
                    }
                    stamp[oi as usize] = k as u32;
                    let o = prep[oi as usize].as_ref().and_then(|p| p.occ.as_ref()).expect("Verdecker");
                    if o.bb[2] < umin - opts.tol || o.bb[0] > umax + opts.tol || o.bb[3] < vmin - opts.tol || o.bb[1] > vmax + opts.tol {
                        continue;
                    }
                    let before = ivs.len();
                    occluded_by(a, b, o, opts, &mut ivs);
                    if ivs[before..].iter().any(|iv| iv.0 <= 0.0 && iv.1 >= 1.0) {
                        full = true;
                        break 'cells;
                    }
                }
            }
        }
        let hidden = if full { vec![(0.0, 1.0)] } else { merge(&mut ivs) };
        let at = |t: f64| {
            let p = lerp(a, b, t);
            [p[0], p[1]]
        };
        let mut cursor = 0.0;
        let min_t = opts.tol / (du * du + dv * dv).sqrt();
        for &(s, e) in &hidden {
            if s - cursor > min_t {
                out.push(Seg { a: at(cursor), b: at(s), owner, hidden: false });
            }
            if opts.hidden && e - s > min_t {
                out.push(Seg { a: at(s), b: at(e), owner, hidden: true });
            }
            cursor = cursor.max(e);
        }
        if 1.0 - cursor > min_t {
            out.push(Seg { a: at(cursor), b: at(1.0), owner, hidden: false });
        }
    }
    out
}

fn seg_hits_cell(g: &OccGrid, a: V3, b: V3, x: usize, y: usize) -> bool {
    let cx0 = g.lo[0] + x as f64 / g.inv[0];
    let cy0 = g.lo[1] + y as f64 / g.inv[1];
    let (cx1, cy1) = (cx0 + 1.0 / g.inv[0], cy0 + 1.0 / g.inv[1]);
    let pad = 1e-9 * (1.0 + cx1.abs() + cy1.abs());
    // Liang-Barsky gegen das (leicht vergrösserte) Zellrechteck.
    let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
    let (mut t0, mut t1) = (0.0f64, 1.0f64);
    for (p, q) in [(-dx, a[0] - (cx0 - pad)), (dx, (cx1 + pad) - a[0]), (-dy, a[1] - (cy0 - pad)), (dy, (cy1 + pad) - a[1])] {
        if p == 0.0 {
            if q < 0.0 {
                return false;
            }
        } else {
            let r = q / p;
            if p < 0.0 {
                t0 = t0.max(r);
            } else {
                t1 = t1.min(r);
            }
            if t0 > t1 {
                return false;
            }
        }
    }
    true
}

/// Vereinigt Intervalle (sortiert).
fn merge(ivs: &mut [(f64, f64)]) -> Vec<(f64, f64)> {
    ivs.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut out: Vec<(f64, f64)> = Vec::new();
    for &(s, e) in ivs.iter() {
        match out.last_mut() {
            Some(last) if s <= last.1 + 1e-12 => last.1 = last.1.max(e),
            _ => out.push((s.max(0.0), e.min(1.0))),
        }
    }
    out
}

/// Schneidet ein Polygon auf `d ≥ 0` zu (Sutherland-Hodgman); markiert die neuen Kanten auf der Ebene.
pub fn clip_front(pts: &[V3]) -> Option<(Vec<V3>, Vec<bool>)> {
    if pts.iter().all(|p| p[2] >= 0.0) {
        return Some((pts.to_vec(), Vec::new()));
    }
    let n = pts.len();
    let mut out: Vec<V3> = Vec::new();
    let mut on_plane: Vec<bool> = Vec::new();
    for i in 0..n {
        let (p, q) = (pts[i], pts[(i + 1) % n]);
        let (pin, qin) = (p[2] >= 0.0, q[2] >= 0.0);
        if pin {
            out.push(p);
            on_plane.push(false);
        }
        if pin != qin {
            let t = p[2] / (p[2] - q[2]);
            let mut x = lerp(p, q, t);
            x[2] = 0.0;
            out.push(x);
            on_plane.push(!qin); // Austritt: die folgende Kante läuft auf der Ebene
        }
    }
    if out.len() < 3 {
        return None;
    }
    // Kante i → i+1 liegt auf der Ebene, wenn beide Enden darauf liegen.
    let m = out.len();
    let no_edge = (0..m).map(|i| out[i][2] == 0.0 && out[(i + 1) % m][2] == 0.0 && (on_plane[i] || on_plane[(i + 1) % m])).collect();
    Some((out, no_edge))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Quader [x0,x1]×[y0,y1]×[d0,d1] (u, v, Tiefe) als sechs Flächen mit Aussennormalen.
    fn boxf(x0: f64, x1: f64, y0: f64, y1: f64, d0: f64, d1: f64, owner: u32) -> Vec<Face> {
        let c = |x: f64, y: f64, d: f64| [x, y, d];
        vec![
            Face::new(vec![c(x0, y0, d0), c(x0, y1, d0), c(x1, y1, d0), c(x1, y0, d0)], [0.0, 0.0, -1.0], owner),
            Face::new(vec![c(x0, y0, d1), c(x1, y0, d1), c(x1, y1, d1), c(x0, y1, d1)], [0.0, 0.0, 1.0], owner),
            Face::new(vec![c(x0, y0, d0), c(x1, y0, d0), c(x1, y0, d1), c(x0, y0, d1)], [0.0, -1.0, 0.0], owner),
            Face::new(vec![c(x0, y1, d0), c(x0, y1, d1), c(x1, y1, d1), c(x1, y1, d0)], [0.0, 1.0, 0.0], owner),
            Face::new(vec![c(x0, y0, d0), c(x0, y0, d1), c(x0, y1, d1), c(x0, y1, d0)], [-1.0, 0.0, 0.0], owner),
            Face::new(vec![c(x1, y0, d0), c(x1, y1, d0), c(x1, y1, d1), c(x1, y0, d1)], [1.0, 0.0, 0.0], owner),
        ]
    }

    fn total(segs: &[Seg], hidden: bool) -> f64 {
        segs.iter().filter(|s| s.hidden == hidden).map(|s| ((s.b[0] - s.a[0]).powi(2) + (s.b[1] - s.a[1]).powi(2)).sqrt()).sum()
    }

    fn opts(hidden: bool) -> Opts {
        Opts { hidden, ..Opts::default() }
    }

    #[test]
    fn quader_frontal_nur_umriss() {
        let s = hidden_lines(&boxf(0.0, 2.0, 0.0, 1.0, 1.0, 2.0, 7), &opts(true));
        assert!((total(&s, false) - 6.0).abs() < 1e-9, "{s:?}");
        assert_eq!(total(&s, true), 0.0, "Rückseite verdeckt, aber keine Kanten (abgewandt)");
        assert!(s.iter().all(|x| x.owner == 7));
    }

    #[test]
    fn hinterer_quader_teilweise_verdeckt() {
        let mut f = boxf(0.0, 2.0, 0.0, 2.0, 1.0, 2.0, 0);
        f.extend(boxf(1.0, 3.0, 1.0, 3.0, 5.0, 6.0, 1));
        let s = hidden_lines(&f, &opts(true));
        let vis1 = total(&s.iter().filter(|x| x.owner == 1).copied().collect::<Vec<_>>(), false);
        let hid1 = total(&s.iter().filter(|x| x.owner == 1).copied().collect::<Vec<_>>(), true);
        // Umriss 8, davon die beiden Stücke im vorderen Quader (je 1) verdeckt.
        assert!((vis1 - 6.0).abs() < 1e-9 && (hid1 - 2.0).abs() < 1e-9, "{vis1} {hid1}");
        assert!((total(&s.iter().filter(|x| x.owner == 0).copied().collect::<Vec<_>>(), false) - 8.0).abs() < 1e-9);
    }

    #[test]
    fn anstossende_quader_ohne_fuge_und_ohne_falsch_verdeckt() {
        // Zwei bündige Quader nebeneinander: die gemeinsame senkrechte Fuge entfällt (koplanar),
        // die inneren Stirnflächen heben sich auf; nichts verdeckt.
        let mut f = boxf(0.0, 1.0, 0.0, 1.0, 1.0, 2.0, 0);
        f.extend(boxf(1.0, 3.0, 0.0, 1.0, 1.0, 2.0, 1));
        let s = hidden_lines(&f, &opts(true));
        assert!((total(&s, false) - 8.0).abs() < 1e-9, "{s:?}");
        assert_eq!(total(&s, true), 0.0);
        // T-Stoss: oben nur ein Teil gemeinsam (zweiter Quader niedriger) → Fuge nur dort, wo er fehlt.
        let mut f = boxf(0.0, 1.0, 0.0, 2.0, 1.0, 2.0, 0);
        f.extend(boxf(1.0, 3.0, 0.0, 1.0, 1.0, 2.0, 1));
        let s = hidden_lines(&f, &opts(true));
        // Umriss: 1+2+2+1+1+1+... = links 2, oben 1, rechts oberer Teil 1, Stufe 2, rechts 1, unten 3 = 10
        assert!((total(&s, false) - 10.0).abs() < 1e-9, "{}", total(&s, false));
    }

    #[test]
    fn kante_hinter_fuge_und_rand_bleibt_verdeckt() {
        // Zwei bündige Scheiben (Fuge bei u = 1); dahinter ein Quader, dessen Kante genau hinter der
        // Fuge liegt und dessen Oberkante genau hinter dem oberen Rand: beides verdeckt, nicht doppelt.
        let mut f = vec![
            Face::new(vec![[0.0, 0.0, 1.0], [1.0, 0.0, 1.0], [1.0, 2.0, 1.0], [0.0, 2.0, 1.0]], [0.0, 0.0, -1.0], 0),
            Face::new(vec![[1.0, 0.0, 1.0], [2.0, 0.0, 1.0], [2.0, 2.0, 1.0], [1.0, 2.0, 1.0]], [0.0, 0.0, -1.0], 0),
        ];
        f.extend(boxf(1.0, 3.0, 0.5, 2.0, 3.0, 4.0, 1));
        let s = hidden_lines(&f, &opts(true));
        let far: Vec<Seg> = s.iter().filter(|x| x.owner == 1).copied().collect();
        // Umriss des hinteren Quaders 7: sichtbar rechts davon 1 + 1.5 + 1 = 3.5, verdeckt 1 + 1.5 + 1 = 3.5.
        assert!((total(&far, false) - 3.5).abs() < 1e-9 && (total(&far, true) - 3.5).abs() < 1e-9, "{far:?}");
    }

    #[test]
    fn schraeger_verdecker_exakt() {
        // Schräge Scheibe (Tiefe 1 bei u=0, 3 bei u=2) vor einer senkrechten Linie bei Tiefe 2 → nur die
        // Hälfte u<1 der Scheibe liegt vor der Linie: die Linie bei u=0.5 ist verdeckt, bei u=1.5 nicht.
        let plate = Face::new(vec![[0.0, 0.0, 1.0], [2.0, 0.0, 3.0], [2.0, 2.0, 3.0], [0.0, 2.0, 1.0]], [1.0, 0.0, -1.0], 0);
        for (u, hid) in [(0.5, true), (1.5, false)] {
            let line = Face::new(vec![[u, -1.0, 2.0], [u + 0.01, -1.0, 2.0], [u + 0.01, 3.0, 2.0], [u, 3.0, 2.0]], [0.0, 0.0, -1.0], 1);
            let s = hidden_lines(&[plate.clone(), line], &opts(true));
            let left: Vec<Seg> = s.iter().filter(|x| x.owner == 1 && (x.a[0] - u).abs() < 1e-9 && (x.b[0] - u).abs() < 1e-9).copied().collect();
            assert!((total(&left, true) - if hid { 2.0 } else { 0.0 }).abs() < 1e-9, "{u}: {left:?}");
        }
    }

    #[test]
    fn durchstossende_kante_wird_am_tiefen_schnitt_geteilt() {
        // Kante von Tiefe 0 bis 4 hinter einer Scheibe bei Tiefe 2: vordere Hälfte sichtbar.
        let plate = Face::new(vec![[0.0, 0.0, 2.0], [4.0, 0.0, 2.0], [4.0, 2.0, 2.0], [0.0, 2.0, 2.0]], [0.0, 0.0, -1.0], 0);
        let mut f = vec![plate];
        // Schräge Fläche, deren Unterkante von (1, 1, 0) nach (3, 1, 4) läuft.
        f.push(Face::new(vec![[1.0, 1.0, 0.0], [3.0, 1.0, 4.0], [3.0, 1.5, 4.0], [1.0, 1.5, 0.0]], [2.0, 0.0, -1.0], 1));
        let s = hidden_lines(&f, &opts(true));
        let low: Vec<Seg> = s.iter().filter(|x| x.owner == 1 && (x.a[1] - 1.0).abs() < 1e-9 && (x.b[1] - 1.0).abs() < 1e-9).copied().collect();
        assert!((total(&low, false) - 1.0).abs() < 1e-4 && (total(&low, true) - 1.0).abs() < 1e-4, "{low:?}");
    }

    /// Zylinder (Facetten, eine Glättungsgruppe): nur die zwei Silhouetten und die Deckelkanten, keine
    /// Facettenfugen; ohne Gruppe erscheinen die Fugen.
    #[test]
    fn facetten_ohne_fugen() {
        let cyl = |smooth: u32| {
            let n = 48;
            let (r, h) = (1.0, 2.0);
            let p = |i: usize, y: f64| {
                let a = std::f64::consts::TAU * i as f64 / n as f64;
                [r * a.cos(), y, 5.0 + r * a.sin()]
            };
            let mut f = Vec::new();
            for i in 0..n {
                let a = std::f64::consts::TAU * (i as f64 + 0.5) / n as f64;
                let mut x = Face::new(vec![p(i, 0.0), p(i + 1, 0.0), p(i + 1, h), p(i, h)], [a.cos(), 0.0, a.sin()], 0);
                x.smooth = smooth;
                f.push(x);
            }
            f.push(Face::new((0..n).map(|i| p(i, h)).collect(), [0.0, 1.0, 0.0], 0));
            f.push(Face::new((0..n).rev().map(|i| p(i, 0.0)).collect(), [0.0, -1.0, 0.0], 0));
            f
        };
        let s = hidden_lines(&cyl(1), &opts(false));
        let vertical = s.iter().filter(|x| (x.a[0] - x.b[0]).abs() < 1e-9).count();
        assert_eq!(vertical, 2, "nur die Silhouetten: {s:?}");
        let s = hidden_lines(&cyl(0), &opts(false));
        assert!(s.iter().filter(|x| (x.a[0] - x.b[0]).abs() < 1e-9).count() > 2);
    }

    #[test]
    fn dreiecke_einer_ebene_ohne_diagonalen() {
        let f = vec![
            Face::new(vec![[0.0, 0.0, 1.0], [1.0, 0.0, 1.0], [1.0, 1.0, 1.0]], [0.0, 0.0, -1.0], 0),
            Face::new(vec![[0.0, 0.0, 1.0], [1.0, 1.0, 1.0], [0.0, 1.0, 1.0]], [0.0, 0.0, -1.0], 0),
        ];
        let s = hidden_lines(&f, &opts(false));
        assert!((total(&s, false) - 4.0).abs() < 1e-9, "{s:?}");
    }

    #[test]
    fn unsinn_ohne_panik() {
        let f = vec![
            Face::new(vec![[f64::NAN, 0.0, 1.0], [1.0, 0.0, 1.0], [1.0, 1.0, 1.0]], [0.0, 0.0, -1.0], 0),
            Face::new(vec![[0.0, 0.0, 1.0], [0.0, 0.0, 1.0]], [0.0, 0.0, -1.0], 0),
            Face::new(vec![[0.0, 0.0, 1.0], [1.0, 0.0, 1.0], [2.0, 0.0, 1.0]], [0.0, 0.0, -1.0], 0),
        ];
        let _ = hidden_lines(&f, &opts(true));
        assert!(hidden_lines(&[], &opts(true)).is_empty());
    }

    #[test]
    fn abschneiden_an_der_ebene() {
        let (p, ne) = clip_front(&[[0.0, 0.0, -1.0], [2.0, 0.0, 1.0], [2.0, 1.0, 1.0], [0.0, 1.0, -1.0]]).unwrap();
        assert_eq!(p.len(), 4);
        assert_eq!(ne.iter().filter(|&&x| x).count(), 1);
        assert!(clip_front(&[[0.0, 0.0, -1.0], [1.0, 0.0, -1.0], [0.0, 1.0, -1.0]]).is_none());
    }
}
