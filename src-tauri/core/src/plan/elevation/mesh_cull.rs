//! Importierte Netze in der Ansicht: Dreiecke zu Flächen vereinigen (`merge_coplanar()`), gekrümmte Decken-
//! Facetten erkennen und verdeckte Netz-Flächen über ein Raster weglassen (`mesh_faces_needed()`). Gerufen
//! von `collect.rs` und `elevation_primitives_with()` in `mod.rs`.

use super::*;

const MERGE_MAX: usize = 64;

/// Haarsplitter in der Ansicht: Fläche klein gegen das Quadrat der längsten Kante (oder winzig).
fn sliver(f: &Face) -> bool {
    let p = &f.pts;
    if p.len() != 3 {
        return false;
    }
    let area2 = ((p[1][0] - p[0][0]) * (p[2][1] - p[0][1]) - (p[2][0] - p[0][0]) * (p[1][1] - p[0][1])).abs();
    let e2 = (0..3).map(|i| (p[(i + 1) % 3][0] - p[i][0]).powi(2) + (p[(i + 1) % 3][1] - p[i][1]).powi(2)).fold(0.0, f64::max);
    area2 < 0.01 * e2 || area2 < 1e-6
}

/// [152] Dreiecke einer Ebene (Ansichtskoordinaten) zu Polygonen vereinigen; Tiefe je Ecke aus der Ebene.
/// Ergibt die Vereinigung Löcher (die `hlr` als Kanten zeigen würde), bleiben es die Dreiecke.
pub(super) fn merge_coplanar(tris: Vec<Face>, out: &mut Vec<Face>) {
    // Grosse Gruppen (Belag aus vielen Platten, überlappende Dreiecke) bleiben Dreiecke: die Vereinigung
    // wird dort teuer und spart in der Ansicht wenig.
    // Streifend gesehene Ebenen (fast auf die Kante) ergeben Haarsplitter, an denen die Vereinigung hängen kann.
    let grazing = tris.iter().any(sliver);
    if tris.len() < 2 || tris.len() > MERGE_MAX || grazing {
        out.extend(tris);
        return;
    }
    let polys: Vec<crate::flat::Polygon> = tris.iter().map(|f| vec![f.pts.clone()]).collect();
    let merged = crate::polygon_bool::union(&polys);
    // Ebene in Ansichtskoordinaten aus dem ersten Dreieck: Tiefe = a·u + b·v + c.
    let f0 = &tris[0];
    let (p, d) = (&f0.pts, &f0.pd);
    let det = (p[1][0] - p[0][0]) * (p[2][1] - p[0][1]) - (p[2][0] - p[0][0]) * (p[1][1] - p[0][1]);
    if merged.is_empty() || merged.iter().any(|poly| poly.len() != 1) || !(det.abs() > 1e-12) {
        out.extend(tris);
        return;
    }
    let a = ((d[1] - d[0]) * (p[2][1] - p[0][1]) - (d[2] - d[0]) * (p[1][1] - p[0][1])) / det;
    let b = ((p[1][0] - p[0][0]) * (d[2] - d[0]) - (p[2][0] - p[0][0]) * (d[1] - d[0])) / det;
    let depth_at = |q: &Pt| d[0] + a * (q[0] - p[0][0]) + b * (q[1] - p[0][1]);
    for poly in merged {
        let pts = poly.into_iter().next().unwrap();
        let pd: Vec<f64> = pts.iter().map(depth_at).collect();
        let depth = pd.iter().sum::<f64>() / pd.len() as f64;
        let (dmin, dmax) = (pd.iter().copied().fold(f64::INFINITY, f64::min), pd.iter().copied().fold(f64::NEG_INFINITY, f64::max));
        out.push(Face { pts, pd, depth, depth_min: dmin, depth_max: dmax, role: f0.role, id: f0.id.clone(), fill: f0.fill, normal: f0.normal, ov: None, two_sided: f0.two_sided, curved_slab: false });
    }
}

/// Gerade/ungerade-Test (Punkt in Polygon).
fn point_in(q: Pt, pts: &[Pt]) -> bool {
    let mut c = false;
    let n = pts.len();
    for i in 0..n {
        let (a, b) = (pts[i], pts[(i + n - 1) % n]);
        if (a[1] > q[1]) != (b[1] > q[1]) && q[0] < (b[0] - a[0]) * (q[1] - a[1]) / (b[1] - a[1]) + a[0] {
            c = !c;
        }
    }
    c
}

/// Abstand² von `q` zum Rand des Polygons.
fn edge_dist2(q: Pt, pts: &[Pt]) -> f64 {
    let n = pts.len();
    (0..n)
        .map(|i| {
            let (a, b) = (pts[i], pts[(i + 1) % n]);
            let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
            let l2 = dx * dx + dy * dy;
            let t = if l2 > 0.0 { (((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / l2).clamp(0.0, 1.0) } else { 0.0 };
            (q[0] - a[0] - t * dx).powi(2) + (q[1] - a[1] - t * dy).powi(2)
        })
        .fold(f64::INFINITY, f64::min)
}

/// Höchstens so viele Zellen hat das Raster für das Weglassen verdeckter Netz-Flächen.
const CULL_CELLS: f64 = 2_000_000.0;

/// [157] So weit (m) gelten Deckenflächen der Ansicht als hinter einer gleich tiefen Wand (bündige Deckenstirn).
pub(super) const SLAB_BEHIND_WALL: f64 = 0.02;

/// [157] Deckenflächen, die Facetten eines gekrümmten Rands sind: eine Nachbarfläche derselben Decke (gemeinsames
/// u-Ende, überlappende Höhe) knickt um mehr als 0.5° und weniger als 25° ab (frontale Facette: beidseits).
pub(super) fn curved_slab_facets(faces: &[Face]) -> Vec<bool> {
    let mut out = vec![false; faces.len()];
    let mut by_id: HashMap<&str, Vec<usize>> = HashMap::new();
    for (i, f) in faces.iter().enumerate().filter(|(_, f)| f.role == Role::Slab && !f.id.is_empty() && !f.pts.is_empty()) {
        by_id.entry(f.id.as_str()).or_default().push(i);
    }
    let span = |f: &Face| f.pts.iter().fold((f64::INFINITY, f64::NEG_INFINITY, f64::INFINITY, f64::NEG_INFINITY), |(a, b, c, d), q| (a.min(q[0]), b.max(q[0]), c.min(q[1]), d.max(q[1])));
    let unit = |n: [f64; 3]| {
        let l = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
        if l > 0.0 { [n[0] / l, n[1] / l, n[2] / l] } else { n }
    };
    let (lo, hi) = (25f64.to_radians().cos(), 0.5f64.to_radians().cos());
    for idx in by_id.values() {
        let spans: Vec<_> = idx.iter().map(|&i| span(&faces[i])).collect();
        for (a, &i) in idx.iter().enumerate() {
            let (sa, na) = (spans[a], unit(faces[i].normal));
            // Nachbar am linken (0) bzw. rechten (1) Ende, der weich abknickt.
            let soft = |end: usize| {
                idx.iter().enumerate().any(|(b, &j)| {
                    let sb = spans[b];
                    let touch = if end == 0 { (sb.1 - sa.0).abs() < 1e-6 } else { (sa.1 - sb.0).abs() < 1e-6 };
                    let nb = unit(faces[j].normal);
                    let c = na[0] * nb[0] + na[1] * nb[1] + na[2] * nb[2];
                    i != j && touch && sa.2 < sb.3 - 1e-9 && sb.2 < sa.3 - 1e-9 && c > lo && c < hi
                })
            };
            // Schräge Facette mit einem weichen Nachbarn, frontale (Scheitel des Bogens) mit zweien — die ebene
            // Fassade neben einem tangential anschliessenden Bogen bleibt eben.
            let oblique = faces[i].depth_max - faces[i].depth_min > 1e-6;
            out[i] = if oblique { soft(0) || soft(1) } else { soft(0) && soft(1) };
        }
    }
    out
}

/// Maler-Rang einer Fläche bei gleicher Tiefe (Decke < Wand/Stütze/Netz < Dach), wie die Sortierung der Ansicht.
pub(super) fn paint_rank(r: Role) -> f64 {
    match r {
        Role::Slab => 0.0,
        Role::Wall | Role::Column | Role::Mesh | Role::Body => 1.0,
        Role::Roof => 2.0,
    }
}

/// [152] Welche Flächen die Maler-Liste braucht: Netz-Flächen, die im fertigen Bild überall von später gemalten
/// Flächen zugedeckt sind, entfallen (Schependomlaan: die meisten der 10⁵ Dreiecke liegen hinter der Fassade,
/// das SVG schrumpfte von 27 auf < 3 MB). Raster (≤ 2 Mio. Zellen, Schependomlaan ≈ 1.5 cm): je Zelle der
/// späteste Maler-Platz einer Fläche, die die Zellmitte deckt; eine Netz-Fläche bleibt, sobald in einer
/// berührten Zelle nichts Späteres liegt. Das Bild bleibt also gleich bis auf Streifen unter einer halben Zelle
/// am Rand einer deckenden Fläche; die Kanten rechnet `hlr` weiter aus allen Flächen.
pub(super) fn mesh_faces_needed(faces: &[Face]) -> Vec<bool> {
    let mut keep = vec![true; faces.len()];
    if !faces.iter().any(|f| f.role.is_mesh()) {
        return keep;
    }
    let finite = |f: &Face| f.pts.len() >= 3 && f.pts.iter().all(|q| q[0].is_finite() && q[1].is_finite());
    let (mut x0, mut y0, mut x1, mut y1) = (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
    for q in faces.iter().filter(|f| finite(f)).flat_map(|f| f.pts.iter()) {
        (x0, y0, x1, y1) = (x0.min(q[0]), y0.min(q[1]), x1.max(q[0]), y1.max(q[1]));
    }
    if !(x1 > x0 && y1 > y0) {
        return keep;
    }
    // Maler-Platz je Fläche (fern zuerst, dann Rang, dann Reihenfolge — wie `items.sort_by` unten).
    let nz = |d: f64| if d.is_nan() { 0.0 } else { d };
    let mut idx: Vec<usize> = (0..faces.len()).collect();
    idx.sort_by(|&a, &b| {
        let (fa, fb) = (&faces[a], &faces[b]);
        let d = nz(fb.depth - fa.depth);
        if d != 0.0 {
            return super::super::section::cmp_num(d);
        }
        let r = nz(paint_rank(fa.role) - paint_rank(fb.role));
        if r != 0.0 {
            return super::super::section::cmp_num(r);
        }
        a.cmp(&b)
    });
    let mut order = vec![0u32; faces.len()];
    for (k, &i) in idx.iter().enumerate() {
        order[i] = k as u32 + 1;
    }
    // [258] Höchstens 65536 Zellen je Richtung: ein extrem gestreckter Ausschnitt (1e12 m × 1 m) ergäbe sonst
    // Milliarden Zellen in einer Reihe (Speicher/Laufzeit). Normale Seitenverhältnisse (< ~2000:1) bleiben unberührt.
    let cell = ((x1 - x0) * (y1 - y0) / CULL_CELLS).sqrt().max(1e-3).max((x1 - x0) / 65536.0).max((y1 - y0) / 65536.0);
    let (w, h) = (((x1 - x0) / cell).ceil() as usize + 1, ((y1 - y0) / cell).ceil() as usize + 1);
    // Spätester Maler-Platz je Zelle (0 = leer).
    let mut top = vec![0u32; w * h];
    let span = |f: &Face| {
        let (mut a, mut b, mut c, mut d) = (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
        for q in &f.pts {
            (a, b, c, d) = (a.min(q[0]), b.min(q[1]), c.max(q[0]), d.max(q[1]));
        }
        let ix = |x: f64| (((x - x0) / cell).floor().max(0.0) as usize).min(w - 1);
        let iy = |y: f64| (((y - y0) / cell).floor().max(0.0) as usize).min(h - 1);
        (ix(a), iy(b), ix(c), iy(d))
    };
    // Deckung der Zellmitten je Zeile über die Schnittpunkte mit dem Rand (gerade/ungerade).
    let mut xs: Vec<f64> = Vec::new();
    for (k, f) in faces.iter().enumerate() {
        if !finite(f) {
            continue;
        }
        let (_, j0, _, j1) = span(f);
        let n = f.pts.len();
        for j in j0..=j1 {
            let y = y0 + (j as f64 + 0.5) * cell;
            xs.clear();
            for e in 0..n {
                let (p, q) = (f.pts[e], f.pts[(e + 1) % n]);
                if (p[1] > y) != (q[1] > y) {
                    xs.push(p[0] + (y - p[1]) * (q[0] - p[0]) / (q[1] - p[1]));
                }
            }
            xs.sort_by(f64::total_cmp);
            for pair in xs.chunks_exact(2) {
                let lo = ((pair[0] - x0) / cell - 0.5).ceil().max(0.0);
                let hi = ((pair[1] - x0) / cell - 0.5).floor();
                if hi < lo {
                    continue;
                }
                for t in &mut top[j * w + lo as usize..=j * w + (hi as usize).min(w - 1)] {
                    *t = (*t).max(order[k]);
                }
            }
        }
    }
    // Kacheln mit dem frühesten Platz (schneller Ausschluss ganz zugedeckter Flächen).
    const T: usize = 16;
    let (tw, th) = (w.div_ceil(T), h.div_ceil(T));
    let mut tmin = vec![u32::MAX; tw * th];
    for j in 0..h {
        for i in 0..w {
            let t = &mut tmin[(j / T) * tw + i / T];
            *t = (*t).min(top[j * w + i]);
        }
    }
    // Netz-Flächen: gebraucht, sobald eine berührte Zelle nichts Späteres trägt.
    let r2 = cell * cell / 2.0;
    for (k, f) in faces.iter().enumerate() {
        if !f.role.is_mesh() || !finite(f) {
            continue;
        }
        let (i0, j0, i1, j1) = span(f);
        let single = i0 == i1 && j0 == j1;
        let mut seen = false;
        'tiles: for tj in j0 / T..=j1 / T {
            for ti in i0 / T..=i1 / T {
                if tmin[tj * tw + ti] > order[k] {
                    continue;
                }
                for j in (tj * T).max(j0)..=(tj * T + T - 1).min(j1) {
                    for i in (ti * T).max(i0)..=(ti * T + T - 1).min(i1) {
                        if top[j * w + i] > order[k] {
                            continue;
                        }
                        let c = [x0 + (i as f64 + 0.5) * cell, y0 + (j as f64 + 0.5) * cell];
                        if single || point_in(c, &f.pts) || edge_dist2(c, &f.pts) <= r2 {
                            seen = true;
                            break 'tiles;
                        }
                    }
                }
            }
        }
        keep[k] = seen;
    }
    keep
}
