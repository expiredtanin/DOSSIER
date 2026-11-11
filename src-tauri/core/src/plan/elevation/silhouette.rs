//! Umrisse der Ansicht: Silhouette der vereinigten Flächen ([140], exakt oder über ein Raster), Kanten mit
//! exakter Verdeckung über `hlr` und die obere Hüllkurve des Geländes ([T6]). Gerufen von
//! `elevation_primitives_with()` in `mod.rs`.

use super::*;

/// [140] Aussenränder der vereinigten Bauteilflächen (Silhouette des Baukörpers in der Ansicht).
/// [152] Bis zu so vielen Flächen ohne importierte Netze exakt (Vereinigung); sonst (Netze: viele, teils haarfeine
/// Dreiecke, deren Vereinigung Minuten dauert oder hängt) über ein Raster.
const SILHOUETTE_EXACT_MAX: usize = 4000;

/// Aussenumriss aller Flächen: exakt als Ringe oder gerastert (Deckung, aussen per Flutfüllung vom Rand).
pub(super) enum Silhouette {
    Rings(Vec<Vec<Pt>>),
    Raster { x0: f64, y0: f64, cell: f64, w: usize, h: usize, px: Vec<u8> },
}

impl Silhouette {
    pub(super) fn of(faces: &[Face]) -> Silhouette {
        if faces.len() <= SILHOUETTE_EXACT_MAX && !faces.iter().any(|f| f.role.is_mesh()) {
            return Silhouette::Rings(silhouette_rings(faces));
        }
        let (mut x0, mut y0, mut x1, mut y1) = (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
        for q in faces.iter().flat_map(|f| f.pts.iter()) {
            (x0, y0, x1, y1) = (x0.min(q[0]), y0.min(q[1]), x1.max(q[0]), y1.max(q[1]));
        }
        if !(x1 > x0 || y1 > y0) {
            return Silhouette::Rings(Vec::new());
        }
        // Zelle so, dass die längere Seite ≤ 2048 Zellen hat, höchstens 4 Mio. Zellen; Rand von zwei Zellen.
        let cell = ((x1 - x0).max(y1 - y0) / 2040.0).max(SILHOUETTE_TOL / 2.0);
        let (w, h) = (((x1 - x0) / cell) as usize + 5, ((y1 - y0) / cell) as usize + 5);
        let (x0, y0) = (x0 - 2.0 * cell, y0 - 2.0 * cell);
        let mut px = vec![0u8; w * h];
        // Deckung je Fläche (Zeilen-Füllung über die Zellmitten, Spannen grosszügig gerundet, Ecken immer).
        for f in faces.iter().filter(|f| f.pts.len() >= 3) {
            let g: Vec<(f64, f64)> = f.pts.iter().map(|q| ((q[0] - x0) / cell, (q[1] - y0) / cell)).collect();
            let (lo, hi) = g.iter().fold((f64::INFINITY, f64::NEG_INFINITY), |(lo, hi), q| (lo.min(q.1), hi.max(q.1)));
            for q in &g {
                px[(q.1 as usize).min(h - 1) * w + (q.0 as usize).min(w - 1)] = 1;
            }
            let mut xs: Vec<f64> = Vec::new();
            for row in (lo.floor().max(0.0) as usize)..=(hi.ceil() as usize).min(h - 1) {
                let yc = row as f64 + 0.5;
                xs.clear();
                for i in 0..g.len() {
                    let (a, b) = (g[i], g[(i + 1) % g.len()]);
                    if (a.1 <= yc) != (b.1 <= yc) {
                        xs.push(a.0 + (yc - a.1) / (b.1 - a.1) * (b.0 - a.0));
                    }
                }
                xs.sort_by(|a, b| a.total_cmp(b));
                for s in xs.chunks_exact(2) {
                    let (c0, c1) = ((s[0].floor().max(0.0)) as usize, (s[1].ceil() as usize).min(w - 1));
                    px[row * w + c0..=row * w + c1.max(c0)].fill(1);
                }
            }
        }
        // Aussen: vom Rand her erreichbare freie Zellen.
        let mut stack: Vec<usize> = (0..w).chain((0..w).map(|x| (h - 1) * w + x)).chain((0..h).map(|y| y * w)).chain((0..h).map(|y| y * w + w - 1)).filter(|&i| px[i] == 0).collect();
        while let Some(i) = stack.pop() {
            if px[i] != 0 {
                continue;
            }
            px[i] = 2;
            let (x, y) = (i % w, i / w);
            if x > 0 { stack.push(i - 1); }
            if x + 1 < w { stack.push(i + 1); }
            if y > 0 { stack.push(i - w); }
            if y + 1 < h { stack.push(i + w); }
        }
        Silhouette::Raster { x0, y0, cell, w, h, px }
    }

    /// Liegt die Kante a–b auf dem Aussenumriss?
    pub(super) fn on(&self, a: Pt, b: Pt) -> bool {
        let m = [(a[0] + b[0]) / 2.0, (a[1] + b[1]) / 2.0];
        match self {
            Silhouette::Rings(r) => on_rings(r, m),
            Silhouette::Raster { x0, y0, cell, w, h, px } => {
                let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
                let l = hypot2(dx, dy);
                if !(l > 0.0) {
                    return false;
                }
                let d = 2.0 * cell;
                let outside = |x: f64, y: f64| {
                    let (c, r) = (((x - x0) / cell).floor(), ((y - y0) / cell).floor());
                    c < 0.0 || r < 0.0 || c as usize >= *w || r as usize >= *h || px[r as usize * w + c as usize] == 2
                };
                outside(m[0] - dy / l * d, m[1] + dx / l * d) || outside(m[0] + dy / l * d, m[1] - dx / l * d)
            }
        }
    }
}

fn silhouette_rings(faces: &[Face]) -> Vec<Vec<Pt>> {
    let polys: Vec<crate::flat::Polygon> = faces.iter().filter(|f| f.pts.len() >= 3).map(|f| vec![f.pts.clone()]).collect();
    // Nur Aussenringe: Löcher der Vereinigung (Gauben-Ausschnitte, Fugen zwischen Dachflächen) sind keine Silhouette.
    crate::polygon_bool::union(&polys).into_iter().filter_map(|poly| poly.into_iter().next()).collect()
}

/// Liegt `q` (bis [`SILHOUETTE_TOL`]) auf einem der Ringe?
fn on_rings(rings: &[Vec<Pt>], q: Pt) -> bool {
    rings.iter().any(|r| {
        (0..r.len()).any(|i| {
            let (a, b) = (r[i], r[(i + 1) % r.len()]);
            let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
            let l2 = dx * dx + dy * dy;
            let t = if l2 > 0.0 { (((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / l2).clamp(0.0, 1.0) } else { 0.0 };
            let (ex, ey) = (a[0] + t * dx - q[0], a[1] + t * dy - q[1]);
            ex * ex + ey * ey <= SILHOUETTE_TOL * SILHOUETTE_TOL
        })
    })
}

pub(super) fn poly_prim(pts: Vec<Vec2>, fill: &str, stroke: &str, w: f64, opening: Option<&str>) -> Primitive {
    let mut pr = polygon(pts, fill, stroke, w, no_hatch());
    if let (Primitive::Polygon { opening_id, .. }, Some(id)) = (&mut pr, opening) {
        *opening_id = Some(id.into());
    }
    pr
}

/// Ein Kantenstück der Ansicht (Zeichenebene).
pub(super) struct EdgeSeg {
    pub(super) a: Pt,
    pub(super) b: Pt,
    pub(super) hidden: bool,
    /// Fläche (Index + 1 in `faces`), 0 = keine.
    pub(super) owner: u32,
}

/// Exakte Sichtbarkeit ([G4]) der Flächenkanten: Flächen in Ansichtskoordinaten (u, Höhe, Tiefe),
/// Öffnungen als ebene Verdecker in ihrer Tiefe (eigene Kanten zeichnen sie selbst).
pub(super) fn elevation_edges(p: &Project, faces: &[Face], openings: &[ProjOpening], frame: &[f64; 9], hidden: bool) -> Vec<EdgeSeg> {
    let arc_ids: HashMap<&str, u32> = p.walls.iter().filter(|w| crate::wall_arc::WallArc::of_wall(w).is_some()).enumerate().map(|(i, w)| (w.id.as_str(), i as u32 + 1)).collect();
    let round_cols: HashMap<&str, u32> = p.columns.as_deref().unwrap_or(&[]).iter().filter(|c| matches!(c.profile, ColumnProfile::Round { .. })).enumerate().map(|(i, c)| (c.id.as_str(), i as u32)).collect();
    let (n, u) = ([frame[3], frame[4], frame[5]], [frame[6], frame[7], frame[8]]);
    let mut hf: Vec<crate::hlr::Face> = Vec::with_capacity(faces.len() + openings.len());
    let mut mesh_groups: HashMap<&str, u32> = HashMap::new();
    // [G4] Körper je Bauteil (Rolle + id): Flächen verschiedener Bauteile liefern Durchdringungslinien. Ohne:
    // Flächen ohne id und die nach hinten gerückten Stirnfacetten gekrümmter Decken (nur numerisch schräg).
    let mut solids: HashMap<(Role, &str), u32> = HashMap::new();
    for (fi, f) in faces.iter().enumerate() {
        let pts = f.pts.iter().zip(&f.pd).map(|(q, &d)| [q[0], q[1], d]).collect();
        let m = f.normal;
        let normal = [m[0] * u[0] + m[1] * u[1] + m[2] * u[2], m[1], m[0] * n[0] + m[1] * n[1] + m[2] * n[2]];
        let mut h = crate::hlr::Face::new(pts, normal, fi as u32 + 1);
        if !f.id.is_empty() && !f.curved_slab {
            let next = solids.len() as u32 + 1;
            h.solid = *solids.entry((f.role, f.id.as_str())).or_insert(next);
        }
        if f.role == Role::Wall {
            h.smooth = arc_ids.get(f.id.as_str()).copied().unwrap_or(0);
        }
        // Runde Stützen ([132]): Mantelfacetten ohne Fugen (eigene Gruppen hinter denen der Bogenwände).
        if f.role == Role::Column {
            h.smooth = round_cols.get(f.id.as_str()).map_or(0, |i| arc_ids.len() as u32 + 1 + i);
        }
        // [157] Decken: Stirnfacetten eines gekrümmten Randes (Erker als Vieleck) ohne Fugen, eine Gruppe je Decke;
        // echte Ecken (über dem Knickwinkel) bleiben Kanten.
        if f.role == Role::Slab && !f.id.is_empty() {
            let next = mesh_groups.len() as u32;
            h.smooth = *mesh_groups.entry(f.id.as_str()).or_insert(arc_ids.len() as u32 + round_cols.len() as u32 + 1 + next);
        }
        // [169] Dächer: senkrechte Stirnflächen eines gekrümmten Rands (Erker-Flachdach als Vieleck) ohne Fugen, eine
        // Gruppe je Dach; Dachflächen bleiben ungeglättet (flache Grate unter dem Knickwinkel bleiben Kanten).
        if f.role == Role::Roof && !f.id.is_empty() && f.normal[1].abs() < 1e-9 {
            let next = mesh_groups.len() as u32;
            h.smooth = *mesh_groups.entry(f.id.as_str()).or_insert(arc_ids.len() as u32 + round_cols.len() as u32 + 1 + next);
        }
        // [152] Importierte Netze: Facetten innerhalb des Knickwinkels glätten (eine Gruppe je Netz), offene beidseitig.
        if f.role.is_mesh() {
            let next = mesh_groups.len() as u32;
            h.smooth = *mesh_groups.entry(f.id.as_str()).or_insert(arc_ids.len() as u32 + round_cols.len() as u32 + 1 + next);
            h.two_sided = f.two_sided;
        }
        hf.push(h);
    }
    for op in openings {
        let mut h = crate::hlr::Face::new(op.pts.iter().map(|q| [q[0], q[1], op.depth]).collect(), [0.0, 0.0, -1.0], 0);
        h.edges = false;
        hf.push(h);
    }
    let opts = crate::hlr::Opts { hidden, ..crate::hlr::Opts::default() };
    crate::hlr::hidden_lines(&hf, &opts).into_iter().map(|s| EdgeSeg { a: s.a, b: s.b, hidden: s.hidden, owner: s.owner }).collect()
}

/// [T6] Obere Hüllkurve des Geländes (samt Baugruben) in der Ansicht: Dreiecke mit Tiefe in [0, `depth_max`]
/// und u im Bereich `range`, abgetastet in ≤ 800 Spalten.
pub(super) fn terrain_silhouette(p: &Project, t: &TerrainMesh, frame: &[f64; 9], range: (f64, f64), depth_max: f64) -> Vec<Vec<[f64; 2]>> {
    let (fp, fnrm, fu) = ([frame[0], frame[1], frame[2]], [frame[3], frame[4], frame[5]], [frame[6], frame[7], frame[8]]);
    let (pos, idx, _) = crate::excavation::terrain_model_mesh(p, t);
    let proj = |i: usize| -> (f64, f64, f64) {
        let q = [pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]];
        let w = [q[0] - fp[0], q[2] - fp[1], q[1] - fp[2]];
        (w[0] * fu[0] + w[1] * fu[1] + w[2] * fu[2], q[2], w[0] * fnrm[0] + w[1] * fnrm[1] + w[2] * fnrm[2])
    };
    let (u0, u1) = range;
    if !(u1 > u0) {
        return Vec::new();
    }
    let n = 800usize;
    let du = (u1 - u0) / n as f64;
    let mut env = vec![f64::NEG_INFINITY; n + 1];
    let nv = pos.len() / 3;
    for tr in idx.chunks_exact(3) {
        if !tr.iter().all(|v| *v >= 0.0 && (*v as usize) < nv) {
            continue;
        }
        let q = [proj(tr[0] as usize), proj(tr[1] as usize), proj(tr[2] as usize)];
        if q.iter().all(|v| v.2 < 0.0) || q.iter().all(|v| v.2 > depth_max) {
            continue;
        }
        let lo = q.iter().map(|v| v.0).fold(f64::INFINITY, f64::min).max(u0);
        let hi = q.iter().map(|v| v.0).fold(f64::NEG_INFINITY, f64::max).min(u1);
        if !(hi >= lo) {
            continue;
        }
        let (k0, k1) = (((lo - u0) / du).ceil() as usize, (((hi - u0) / du).floor() as usize).min(n));
        for (k, e) in env.iter_mut().enumerate().take(k1 + 1).skip(k0) {
            let u = u0 + k as f64 * du;
            for i in 0..3 {
                let (a, b) = (q[i], q[(i + 1) % 3]);
                if (a.0 - u) * (b.0 - u) <= 0.0 && a.0 != b.0 {
                    let z = a.1 + (b.1 - a.1) * (u - a.0) / (b.0 - a.0);
                    *e = e.max(z);
                }
            }
        }
    }
    let mut out: Vec<Vec<[f64; 2]>> = Vec::new();
    let mut cur: Vec<[f64; 2]> = Vec::new();
    for (k, z) in env.iter().enumerate() {
        if z.is_finite() {
            cur.push([u0 + k as f64 * du, *z]);
        } else if cur.len() > 1 {
            out.push(std::mem::take(&mut cur));
        } else {
            cur.clear();
        }
    }
    if cur.len() > 1 {
        out.push(cur);
    }
    // Kollineare Zwischenpunkte weglassen (Raster), Form bleibt.
    for l in &mut out {
        let mut s: Vec<[f64; 2]> = vec![l[0]];
        for i in 1..l.len() - 1 {
            let (a, b, c) = (s[s.len() - 1], l[i], l[i + 1]);
            if ((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])).abs() > 1e-9 {
                s.push(b);
            }
        }
        s.push(l[l.len() - 1]);
        *l = s;
    }
    out
}
