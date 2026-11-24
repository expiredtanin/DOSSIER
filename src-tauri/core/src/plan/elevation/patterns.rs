//! Oberflächenmuster auf Ansichtsflächen: Strichstärke und Farbe (`pattern_style()`), Musterlinien je Fläche
//! (`surface_patterns()`) und die Dreiecke einer Ebene. Gerufen von `elevation_primitives_with()` in
//! `mod.rs`.

use super::*;

/// [269] Ansichtsschraffur in Papiergrösse: Musterlinien liegen nie enger als so viel Papier-mm (sonst dünnt
/// `surface_pattern::thin_factor` aus oder lässt weg) — Ziegel- und Schalungsmuster bleiben bei 1:100 lesbar und
/// verschwinden gegen 1:200 hin, statt die Fläche zu schwärzen.
pub(super) const PATTERN_MIN_PAPER_MM: f64 = 2.5;
/// [269] Strichstärke der Ansichtsschraffur (Papier-mm): fein wie die Bodenbeläge im Grundriss, und nie dominanter
/// als die Fensterkonturen (0.18) — eine eigene Stärke im Muster gilt bis zu dieser Grenze.
pub(super) const PATTERN_WEIGHT_MM: f64 = 0.05;
pub(super) const PATTERN_WEIGHT_MAX_MM: f64 = 0.09;

/// [269] Massstab für `surface_pattern::segments`, der dessen Ausdünnung auf [`PATTERN_MIN_PAPER_MM`] hebt.
pub(super) fn pattern_scale(scale: f64) -> f64 {
    let s = if scale.is_finite() && scale > 0.0 { scale } else { 100.0 };
    s * PATTERN_MIN_PAPER_MM / crate::surface_pattern::MIN_PAPER_MM
}

/// Strichstärke und Farbe einer Ansichtsschraffur.
fn pattern_style(sp: &SurfacePattern, comp: &Component) -> (f64, String) {
    let w = sp.weight_mm.filter(|w| w.is_finite() && *w > 0.0).unwrap_or(PATTERN_WEIGHT_MM).min(PATTERN_WEIGHT_MAX_MM);
    let c = sp.color.clone().or_else(|| comp.foreground.clone()).filter(|c| !c.trim().is_empty()).unwrap_or_else(|| PATTERN_INK.into());
    (w, c)
}

const PATTERN_INK: &str = "#3a3f47";
/// [140] Ansichtsschraffur in Tusche: feines Grau (Materialstruktur tritt hinter die Kanten zurück).
pub(super) const MONO_PATTERN_INK: &str = "#8c8c8c";

/// Linie der Ansichtsschraffur: Endpunkte, Verdeckungstiefe, Maler-Tiefe, Stil-Index und [G4] die Flächen (Index
/// in `faces`), auf denen sie liegt — sie wird auf deren sichtbare Teile beschnitten; ohne: Verdeckung wie bisher.
pub(super) type PatternLine = (Pt, Pt, f64, f64, usize, Option<Rc<[usize]>>);

/// Ansichtsfarbe (`Component.elevationColor`) der sichtbaren Seite auf die Flächen legen und die
/// Ansichtsschraffur ([100]) als Linien liefern: Wände in Wand-Koordinaten (x ab Wandanfang, y ab UK),
/// Dachflächen traufparallel/in Falllinie (`surface_pattern::segments_3d`). Tiefe je Linie = nächster
/// Endpunkt (knapp vor der Fläche), damit die Verdeckung wie bei den Kanten greift.
pub(super) fn surface_patterns(p: &Project, faces: &mut [Face], frame: &[f64; 9], scale: f64, mono: bool) -> (Vec<PatternLine>, Vec<(f64, String)>) {
    use crate::surface_pattern as sp;
    let mut lines: Vec<PatternLine> = Vec::new();
    let mut styles: Vec<(f64, String)> = Vec::new();
    let (pp, nn, uu) = ([frame[0], frame[1], frame[2]], [frame[3], frame[4], frame[5]], [frame[6], frame[7], frame[8]]);
    let proj = |w: [f64; 3]| -> (f64, f64, f64) {
        let r = [w[0] - pp[0], w[1] - pp[1], w[2] - pp[2]];
        (r[0] * uu[0] + r[1] * uu[1] + r[2] * uu[2], w[1], r[0] * nn[0] + r[1] * nn[1] + r[2] * nn[2])
    };
    let mut walls: HashMap<&str, &Wall> = HashMap::new();
    for w in &p.walls {
        walls.entry(w.id.as_str()).or_insert(w);
    }
    for (fi, f) in faces.iter_mut().enumerate() {
        if f.role != Role::Wall || f.id.is_empty() || f.pts.len() < 3 {
            continue;
        }
        let Some(wall) = walls.get(f.id.as_str()).copied() else { continue };
        let Some(comp) = wall_side_component(p, wall, f.normal) else { continue };
        if !mono {
            if let Some(c) = comp.elevation_color.as_deref().filter(|c| !c.trim().is_empty()) {
                f.fill = hex_to_rgb(c, f.fill);
            }
        }
        if f.ov.as_ref().is_some_and(|o| o.no_pattern) {
            continue; // [33] Regel: Schraffur ohne/eigene
        }
        let Some(pat) = comp.surface_pattern.as_ref() else { continue };
        let Some(spec) = sp::spec_of(pat, wall.surface_pattern_angle.unwrap_or(0.0)) else { continue };
        let (dx, dy) = (wall.end.x - wall.start.x, wall.end.y - wall.start.y);
        let len = hypot2(dx, dy);
        let t = [dx / len, 0.0, dy / len];
        let k = t[0] * uu[0] + t[2] * uu[2];
        if k.abs() < 0.05 {
            continue; // fast von der Seite gesehen
        }
        let kd = (t[0] * nn[0] + t[2] * nn[2]) / k; // Tiefe je u entlang der Fläche
        let mean_u = f.pts.iter().map(|q| q[0]).sum::<f64>() / f.pts.len() as f64;
        let depth_at = |u: f64| f.depth + (u - mean_u) * kd;
        let z0 = p.wall_vertical_extent(wall).0;
        let (u0, _, _) = proj([wall.start.x, 0.0, wall.start.y]);
        let local: Vec<sp::P> = f.pts.iter().map(|q| [(q[0] - u0) / k, q[1] - z0]).collect();
        let off = wall.surface_pattern_offset.as_ref().map_or([0.0, 0.0], |o| [o.x, o.y]);
        let segs = sp::segments(&local, &spec, off, pattern_scale(scale));
        if segs.is_empty() {
            continue;
        }
        styles.push(pattern_style(pat, comp));
        let si = styles.len() - 1;
        let own: Rc<[usize]> = Rc::from(vec![fi]);
        for (s0, s1) in segs {
            let (qa, qb) = ([u0 + k * s0[0], s0[1] + z0], [u0 + k * s1[0], s1[1] + z0]);
            let d = min(depth_at(qa[0]), depth_at(qb[0])) - EPS * 5.0;
            lines.push((qa, qb, d, f.depth - EPS * 5.0, si, Some(own.clone())));
        }
    }
    // Dachflächen: äusserste Schicht (Eindeckung).
    for roof in p.roofs.as_deref().unwrap_or(&[]) {
        // [180] Nur Dächer mit sichtbaren Flächen (ausgeblendete Klasse, Regel oder Ansichtsbereich ⇒ ohne Muster).
        if !faces.iter().any(|f| f.role == Role::Roof && f.id == roof.id) {
            continue;
        }
        let Some(comp) = p.roof_layers(roof).first().filter(|l| !l.component_id.is_empty()).and_then(|l| p.component(&l.component_id)) else { continue };
        if !mono && roof.color.as_deref().is_none_or(|c| c.is_empty()) {
            if let Some(c) = comp.elevation_color.as_deref().filter(|c| !c.trim().is_empty()) {
                for f in faces.iter_mut().filter(|f| f.role == Role::Roof && f.id == roof.id) {
                    f.fill = hex_to_rgb(c, f.fill);
                }
            }
        }
        if faces.iter().any(|f| f.role == Role::Roof && f.id == roof.id && f.ov.as_ref().is_some_and(|o| o.no_pattern)) {
            continue; // [33] Regel: Schraffur ohne/eigene
        }
        let Some(pat) = comp.surface_pattern.as_ref() else { continue };
        let Some(spec) = sp::spec_of(pat, roof.surface_pattern_angle.unwrap_or(0.0)) else { continue };
        let g = crate::roof::roof_geometry(&roof.params(), p.roof_base_elevation(roof));
        let off = roof.surface_pattern_offset.as_ref().map_or([0.0, 0.0], |o| [o.x, o.y]);
        let mut si: Option<usize> = None;
        for plane in &g.planes {
            if plane.len() < 3 {
                continue;
            }
            // Flächennormale (Plan-Koordinaten, aufwärts); sichtbar, wenn sie zum Betrachter zeigt.
            let mut n = [0.0; 3];
            for i in 0..plane.len() {
                let (a, b) = (plane[i], plane[(i + 1) % plane.len()]);
                n[0] += (a[1] - b[1]) * (a[2] + b[2]);
                n[1] += (a[2] - b[2]) * (a[0] + b[0]);
                n[2] += (a[0] - b[0]) * (a[1] + b[1]);
            }
            if n[2] < 0.0 {
                n = [-n[0], -n[1], -n[2]];
            }
            if nn[0] * n[0] + nn[1] * n[2] + nn[2] * n[1] >= -1e-9 {
                continue;
            }
            // Maler-Tiefe der Fläche wie `project_face`: Mittel der Eckentiefen.
            let face_depth = plane.iter().map(|q| proj([q[0], q[2], q[1]]).2).sum::<f64>() / plane.len() as f64;
            // [132] Verschnittene Dächer kommen als Dreiecke dieser Ebene. Mit je eigener Maler-Tiefe würden
            // sich die Dreiecke derselben Ebene gegenseitig samt Musterlinien überdecken (Streifen, halbe
            // Schraffur): alle Dreiecke der Ebene bekommen die Tiefe der ganzen Fläche, die Linien liegen darauf.
            let tris = plane_triangles(faces, &roof.id, n, plane, &proj);
            for &ti in &tris {
                faces[ti].depth = face_depth;
            }
            let own: Option<Rc<[usize]>> = (!tris.is_empty()).then(|| Rc::from(tris));
            for (a, b) in sp::segments_3d(plane, &spec, off, pattern_scale(scale)) {
                let (ua, va, da) = proj([a[0], a[2], a[1]]);
                let (ub, vb, db) = proj([b[0], b[2], b[1]]);
                if da <= EPS || db <= EPS {
                    continue;
                }
                let k = *si.get_or_insert_with(|| {
                    styles.push(pattern_style(pat, comp));
                    styles.len() - 1
                });
                lines.push(([ua, va], [ub, vb], min(da, db) - EPS * 5.0, face_depth - EPS * 5.0, k, own.clone()));
            }
        }
    }
    if mono {
        for s in &mut styles {
            s.1 = MONO_PATTERN_INK.into();
        }
    }
    (lines, styles)
}

/// [132] Flächen (Dreiecke oder Polygone) des Dachs `id`, die in der Dachebene `plane` liegen (Normale `n` in
/// Plan-Koordinaten, Schwerpunkt im Ebenen-Umriss).
fn plane_triangles(faces: &[Face], id: &str, n: [f64; 3], plane: &[[f64; 3]], proj: &dyn Fn([f64; 3]) -> (f64, f64, f64)) -> Vec<usize> {
    let l = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
    if !(l > 0.0) {
        return Vec::new();
    }
    // Plan (x, y, Höhe) → Welt (x, Höhe, y), wie `Face::normal`.
    let nw = [n[0] / l, n[2] / l, n[1] / l];
    let outline: Vec<[f64; 2]> = plane.iter().map(|q| { let (u, v, _) = proj([q[0], q[2], q[1]]); [u, v] }).collect();
    let inside = |p: [f64; 2]| {
        let mut c = false;
        let m = outline.len();
        for i in 0..m {
            let (a, b) = (outline[i], outline[(i + 1) % m]);
            if (a[1] > p[1]) != (b[1] > p[1]) && p[0] < a[0] + (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) {
                c = !c;
            }
        }
        c
    };
    let mut out = Vec::new();
    for (i, f) in faces.iter().enumerate() {
        if f.role != Role::Roof || f.id != id || f.pts.len() < 3 {
            continue;
        }
        let fl = (f.normal[0] * f.normal[0] + f.normal[1] * f.normal[1] + f.normal[2] * f.normal[2]).sqrt();
        if !(fl > 0.0) || (f.normal[0] * nw[0] + f.normal[1] * nw[1] + f.normal[2] * nw[2]) / fl < 1.0 - 1e-6 {
            continue;
        }
        let m = f.pts.len() as f64;
        let c = [f.pts.iter().map(|q| q[0]).sum::<f64>() / m, f.pts.iter().map(|q| q[1]).sum::<f64>() / m];
        if !inside(c) {
            continue;
        }
        out.push(i);
    }
    out
}

/// [316] Materialfugen: gemeinsame Kanten bündiger Wandflächen (gleiche Ebene) mit verschiedenem Fassadenmaterial
/// (Baustoff der sichtbaren Wandseite, ohne Baustoff die Ansichtsfarbe) — z. B. Holz über Putz an der
/// Geschossgrenze. Die Kantenberechnung ([G4]) lässt bündige Fugen weg; gleiches Material über die Geschossgrenze
/// bleibt ohne Linie. Ergebnis: Endpunkte, Tiefe (vorderste der beiden Flächen) und die beiden Flächen (Index in
/// `faces`), auf deren sichtbare Teile die Linie beschnitten wird.
pub(super) fn material_seams(p: &Project, faces: &[Face]) -> Vec<(Pt, Pt, f64, [usize; 2])> {
    const TOL: f64 = 1e-4;
    let walls: HashMap<&str, &Wall> = p.walls.iter().rev().map(|w| (w.id.as_str(), w)).collect();
    // Je Wandfläche: Material, Ebene (Tiefe = a + b·u + c·v) und Hüllrechteck.
    let mut cand: Vec<(usize, String, [f64; 3], [f64; 4])> = Vec::new();
    for (fi, f) in faces.iter().enumerate() {
        if f.role != Role::Wall || f.id.is_empty() || f.pts.len() < 3 || f.pd.len() != f.pts.len() {
            continue;
        }
        let key = walls.get(f.id.as_str()).and_then(|w| wall_side_component(p, w, f.normal)).map_or_else(|| rgb_to_hex(f.fill), |c| format!("c:{}", c.id));
        let pts3: Vec<[f64; 3]> = f.pts.iter().zip(&f.pd).map(|(q, d)| [q[0], q[1], *d]).collect();
        let Some(pl) = crate::hlr_fill::plane(&pts3) else { continue };
        let b = f.pts.iter().fold([f64::INFINITY, f64::NEG_INFINITY, f64::INFINITY, f64::NEG_INFINITY], |b, q| [b[0].min(q[0]), b[1].max(q[0]), b[2].min(q[1]), b[3].max(q[1])]);
        cand.push((fi, key, pl, b));
    }
    // [327] Paare mit überlappendem Hüllrechteck über eine Sortierung nach u (statt jede Fläche gegen jede), in
    // der Reihenfolge der vollen Doppelschleife; Material als Nummer statt Textvergleich.
    let mut ids: HashMap<&str, u32> = HashMap::new();
    let mat: Vec<u32> = cand.iter().map(|c| { let n = ids.len() as u32; *ids.entry(c.1.as_str()).or_insert(n) }).collect();
    let mut order: Vec<usize> = (0..cand.len()).collect();
    order.sort_by(|a, b| cand[*a].3[0].total_cmp(&cand[*b].3[0]));
    let mut pairs: Vec<(usize, usize)> = Vec::new();
    for (n, &i) in order.iter().enumerate() {
        for &j in &order[n + 1..] {
            if cand[j].3[0] > cand[i].3[1] + TOL {
                break;
            }
            if mat[i] != mat[j] {
                pairs.push((i.min(j), i.max(j)));
            }
        }
    }
    pairs.sort_unstable();
    let mut out = Vec::new();
    {
        for (i, j) in pairs {
            let ((fi, _, pi, bi), (fj, _, pj, bj)) = (&cand[i], &cand[j]);
            if bi[0] > bj[1] + TOL || bj[0] > bi[1] + TOL || bi[2] > bj[3] + TOL || bj[2] > bi[3] + TOL {
                continue;
            }
            // Bündig: gleiche Neigung und Tiefe.
            if (pi[1] - pj[1]).abs() > 1e-3 || (pi[2] - pj[2]).abs() > 1e-3 {
                continue;
            }
            let (a, b) = (&faces[*fi].pts, &faces[*fj].pts);
            for k in 0..a.len() {
                let (p0, p1) = (a[k], a[(k + 1) % a.len()]);
                let (dx, dy) = (p1[0] - p0[0], p1[1] - p0[1]);
                let len = hypot2(dx, dy);
                if len < TOL {
                    continue;
                }
                let (ex, ey) = (dx / len, dy / len);
                for m in 0..b.len() {
                    let (q0, q1) = (b[m], b[(m + 1) % b.len()]);
                    // Beide Enden auf der Geraden von p0 → p1.
                    let off = |q: Pt| ((q[0] - p0[0]) * -ey + (q[1] - p0[1]) * ex).abs();
                    if off(q0) > TOL || off(q1) > TOL {
                        continue;
                    }
                    let s = |q: Pt| (q[0] - p0[0]) * ex + (q[1] - p0[1]) * ey;
                    let (s0, s1) = (s(q0).min(s(q1)).max(0.0), s(q0).max(s(q1)).min(len));
                    if s1 - s0 < 10.0 * TOL {
                        continue;
                    }
                    let at = |t: f64| [p0[0] + ex * t, p0[1] + ey * t];
                    let mid = at((s0 + s1) / 2.0);
                    // Tiefe der Fuge auf beiden Ebenen gleich (bündig).
                    let (di, dj) = (pi[0] + pi[1] * mid[0] + pi[2] * mid[1], pj[0] + pj[1] * mid[0] + pj[2] * mid[1]);
                    if (di - dj).abs() > 1e-3 {
                        continue;
                    }
                    out.push((at(s0), at(s1), di.min(dj), [*fi, *fj]));
                }
            }
        }
    }
    out
}
