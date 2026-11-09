//! Oberflächenmuster auf Ansichtsflächen: Strichstärke und Farbe (`pattern_style()`), Musterlinien je Fläche
//! (`surface_patterns()`) und die Dreiecke einer Ebene. Gerufen von `elevation_primitives_with()` in
//! `mod.rs`.

use super::*;

/// Strichstärke und Farbe einer Ansichtsschraffur.
fn pattern_style(sp: &SurfacePattern, comp: &Component) -> (f64, String) {
    let w = sp.weight_mm.filter(|w| w.is_finite() && *w > 0.0).unwrap_or(0.1);
    let c = sp.color.clone().or_else(|| comp.foreground.clone()).filter(|c| !c.trim().is_empty()).unwrap_or_else(|| PATTERN_INK.into());
    (w, c)
}

const PATTERN_INK: &str = "#3a3f47";
/// [140] Ansichtsschraffur in Tusche: feines Grau (Materialstruktur tritt hinter die Kanten zurück).
pub(super) const MONO_PATTERN_INK: &str = "#8c8c8c";

/// Linie der Ansichtsschraffur: Endpunkte, Verdeckungstiefe, Maler-Tiefe, Stil-Index.
type PatternLine = (Pt, Pt, f64, f64, usize);

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
    for f in faces.iter_mut() {
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
        let segs = sp::segments(&local, &spec, off, scale);
        if segs.is_empty() {
            continue;
        }
        styles.push(pattern_style(pat, comp));
        let si = styles.len() - 1;
        for (s0, s1) in segs {
            let (qa, qb) = ([u0 + k * s0[0], s0[1] + z0], [u0 + k * s1[0], s1[1] + z0]);
            let d = min(depth_at(qa[0]), depth_at(qb[0])) - EPS * 5.0;
            lines.push((qa, qb, d, f.depth - EPS * 5.0, si));
        }
    }
    // Dachflächen: äusserste Schicht (Eindeckung).
    for roof in p.roofs.as_deref().unwrap_or(&[]) {
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
            for ti in plane_triangles(faces, &roof.id, n, plane, &proj) {
                faces[ti].depth = face_depth;
            }
            for (a, b) in sp::segments_3d(plane, &spec, off, scale) {
                let (ua, va, da) = proj([a[0], a[2], a[1]]);
                let (ub, vb, db) = proj([b[0], b[2], b[1]]);
                if da <= EPS || db <= EPS {
                    continue;
                }
                let k = *si.get_or_insert_with(|| {
                    styles.push(pattern_style(pat, comp));
                    styles.len() - 1
                });
                lines.push(([ua, va], [ub, vb], min(da, db) - EPS * 5.0, face_depth - EPS * 5.0, k));
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
