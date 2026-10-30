//! Ansichtsschraffur auf Flächen ausserhalb der Ansicht ([100]): Bodenbeläge (Oberseite der Decken,
//! oberste Schicht) im Grundriss sowie alle Musterflächen im 3D (Wandseiten, Dachflächen, Deckenober-
//! und -untersicht) als Linien für render3d.
//!
//! 3D-Ausdünnung nach Abstand: Je Fläche wird das Muster für eine Leiter von Massstäben
//! ([`LOD_SCALES`], wie die 2D-Ausdünnung in `surface_pattern::segments`) gerechnet; jede Linie trägt
//! eine Bitmaske der Stufen, in denen sie vorkommt. render3d wählt je Linie aus ihrem Bildschirm-
//! Massstab (px je Meter an ihrer Lage) die passende Stufe und zeichnet nur deren Linien — nah alle
//! Fugen, weit weg jede 2./4./8. Linie, noch weiter keine (kein Moiré).
//!
//! Puffer (`f32`, [`PATTERN_STRIDE`] je Linie): `ax, ay, az, bx, by, bz, r, g, b, maske` in Welt-Metern
//! (Plan `(x, y)` + Höhe `z` → Welt `(x, z, y)`, wie `drawing_line_verts`).

use crate::model::{Ceiling, Component, Project, SurfacePattern, Wall};
use crate::surface_pattern::{self as sp, Spec, P};
use std::collections::HashMap;

/// Massstabs-Leiter der 3D-Ausdünnung (Bit i der Maske = Stufe `LOD_SCALES[i]`); render3d kennt dieselbe.
pub const LOD_SCALES: [f64; 7] = [25.0, 50.0, 100.0, 200.0, 400.0, 800.0, 1600.0];
/// Floats je Linie im 3D-Puffer.
pub const PATTERN_STRIDE: usize = 10;
/// Abstand der Musterlinien vor der Fläche (m), gegen Z-Fighting.
const LIFT: f64 = 0.003;
const INK: &str = "#3a3f47";

/// Muster und Bauteil einer Fläche.
fn spec_for<'a>(comp: Option<&'a Component>, angle: f64) -> Option<(&'a SurfacePattern, &'a Component, Spec)> {
    let comp = comp?;
    let pat = comp.surface_pattern.as_ref()?;
    Some((pat, comp, sp::spec_of(pat, angle)?))
}

fn ink_rgb(pat: &SurfacePattern, comp: &Component) -> [f64; 3] {
    let c = pat.color.as_deref().or(comp.foreground.as_deref()).filter(|c| !c.trim().is_empty()).unwrap_or(INK);
    crate::style::hex_to_rgb(c, [0.23, 0.25, 0.28])
}

/// Ring mit Löchern (gerade-ungerade-Regel über Brücken-Kanten) für `surface_pattern::segments`.
fn ring_with_holes(outer: &[P], holes: &[Vec<P>]) -> Vec<P> {
    if holes.is_empty() {
        return outer.to_vec();
    }
    crate::polygon_holes::merge_holes(outer, holes, 1e-4).ring
}

/// Segmente je Massstabs-Stufe zusammengeführt: (a, b, Maske).
fn lod_segments(f: impl Fn(f64) -> Vec<(P, P)>) -> Vec<(P, P, u8)> {
    let mut idx: HashMap<[i64; 4], usize> = HashMap::new();
    let mut out: Vec<(P, P, u8)> = Vec::new();
    let q = |v: f64| (v * 1e5).round() as i64;
    for (i, &s) in LOD_SCALES.iter().enumerate() {
        for (a, b) in f(s) {
            let (a, b) = if (a[0], a[1]) <= (b[0], b[1]) { (a, b) } else { (b, a) };
            let key = [q(a[0]), q(a[1]), q(b[0]), q(b[1])];
            match idx.get(&key) {
                Some(&k) => out[k].2 |= 1 << i,
                None => {
                    idx.insert(key, out.len());
                    out.push((a, b, 1 << i));
                }
            }
        }
    }
    out
}

/// Bodenbelag im Grundriss: Muster der obersten Deckenschicht auf dem Deckenumriss (ohne Aussparungen),
/// in Plan-Koordinaten; Ausrichtung am Plan (x), Ursprung am ersten Umrisspunkt.
pub fn floor_finish_segments(p: &Project, ce: &Ceiling, scale: f64) -> Option<(Vec<(P, P)>, f64, String)> {
    let layers = crate::model3d::ceiling_type_ref(p, ce).map(|t| t.2)?;
    let (pat, comp, spec) = spec_for(layers.first().and_then(|l| p.component(&l.component_id)), 0.0)?;
    let (outer, holes) = ceiling_rings(ce)?;
    let segs = sp::segments(&ring_with_holes(&outer, &holes), &spec, outer[0], scale);
    let w = pat.weight_mm.filter(|w| w.is_finite() && *w > 0.0).unwrap_or(0.1);
    let ink = pat.color.as_deref().or(comp.foreground.as_deref()).filter(|c| !c.trim().is_empty()).unwrap_or(INK).to_string();
    Some((segs, w, ink))
}

fn ceiling_rings(ce: &Ceiling) -> Option<(Vec<P>, Vec<Vec<P>>)> {
    let outer: Vec<P> = ce.outline.iter().map(|v| [v.x, v.y]).collect();
    if outer.len() < 3 || outer.iter().any(|q| !q[0].is_finite() || !q[1].is_finite()) {
        return None;
    }
    let holes = ce.openings.as_deref().unwrap_or(&[]).iter().filter(|h| h.len() >= 3).map(|h| h.iter().map(|v| [v.x, v.y]).collect()).collect();
    Some((outer, holes))
}

struct Sink {
    out: Vec<f32>,
}

impl Sink {
    fn push(&mut self, a: [f64; 3], b: [f64; 3], rgb: [f64; 3], mask: u8) {
        // Plan (x, y, z) → Welt (x, z, y).
        for v in [a[0], a[2], a[1], b[0], b[2], b[1], rgb[0], rgb[1], rgb[2], mask as f64] {
            self.out.push(v as f32);
        }
    }
}

/// Alle Musterlinien des Projekts für render3d (s. Modulkopf).
pub fn pattern_lines_3d(p: &Project) -> Vec<f32> {
    let mut s = Sink { out: Vec::new() };
    for w in &p.walls {
        wall_lines(p, w, &mut s);
    }
    for ce in p.ceilings.as_deref().unwrap_or(&[]) {
        ceiling_lines(p, ce, &mut s);
    }
    for roof in p.roofs.as_deref().unwrap_or(&[]) {
        let Some((pat, comp, spec)) = spec_for(p.roof_layers(roof).first().and_then(|l| p.component(&l.component_id)), roof.surface_pattern_angle.unwrap_or(0.0)) else { continue };
        let rgb = ink_rgb(pat, comp);
        let off = roof.surface_pattern_offset.as_ref().map_or([0.0, 0.0], |o| [o.x, o.y]);
        let g = crate::roof::roof_geometry(&roof.params(), p.roof_base_elevation(roof));
        for plane in &g.planes {
            let n = newell(plane);
            let n = if n[2] < 0.0 { [-n[0], -n[1], -n[2]] } else { n };
            let lift = |q: [f64; 3]| [q[0] + n[0] * LIFT, q[1] + n[1] * LIFT, q[2] + n[2] * LIFT];
            let mut idx: HashMap<[i64; 6], usize> = HashMap::new();
            let mut segs: Vec<([f64; 3], [f64; 3], u8)> = Vec::new();
            let q = |v: f64| (v * 1e5).round() as i64;
            for (i, &sc) in LOD_SCALES.iter().enumerate() {
                for (a, b) in sp::segments_3d(plane, &spec, off, sc) {
                    let key = [q(a[0]), q(a[1]), q(a[2]), q(b[0]), q(b[1]), q(b[2])];
                    match idx.get(&key) {
                        Some(&k) => segs[k].2 |= 1 << i,
                        None => {
                            idx.insert(key, segs.len());
                            segs.push((a, b, 1 << i));
                        }
                    }
                }
            }
            for (a, b, m) in segs {
                s.push(lift(a), lift(b), rgb, m);
            }
        }
    }
    s.out
}

fn newell(poly: &[[f64; 3]]) -> [f64; 3] {
    let mut n = [0.0; 3];
    for i in 0..poly.len() {
        let (a, b) = (poly[i], poly[(i + 1) % poly.len()]);
        n[0] += (a[1] - b[1]) * (a[2] + b[2]);
        n[1] += (a[2] - b[2]) * (a[0] + b[0]);
        n[2] += (a[0] - b[0]) * (a[1] + b[1]);
    }
    let l = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
    if l > 1e-12 && l.is_finite() {
        [n[0] / l, n[1] / l, n[2] / l]
    } else {
        [0.0, 0.0, 1.0]
    }
}

/// Beide Wandseiten: rechts der Achse die äusserste Schicht (`layers[0]`), links die innerste — wie
/// die Ansicht. Wand-Koordinaten: x ab Wandanfang, y ab UK; Öffnungen ausgespart.
fn wall_lines(p: &Project, w: &Wall, s: &mut Sink) {
    // Bogenwände ([T2]): Muster auf der abgewickelten Fläche, entlang des Bogens gebogen.
    if let Some(arc) = crate::wall_arc::WallArc::of_wall(w) {
        return arc_wall_lines(p, w, &arc, s);
    }
    let (dx, dy) = (w.end.x - w.start.x, w.end.y - w.start.y);
    let len = crate::jsmath::hypot2(dx, dy);
    if !(len > 1e-6) || !len.is_finite() {
        return;
    }
    let Some(wt) = p.wall_type(w) else { return };
    let (z0, z1) = p.wall_vertical_extent(w);
    if !(z1 - z0 > 1e-6) {
        return;
    }
    let total = crate::model::Project::type_thickness(&wt.layers);
    let ref_off = crate::joins::reference_offset(crate::model3d::wall_reference(w), total);
    let (ux, uy) = (dx / len, dy / len);
    let (nx, ny) = (-uy, ux); // linke Normale
    let holes: Vec<Vec<P>> = p
        .openings
        .as_deref()
        .unwrap_or(&[])
        .iter()
        .filter(|o| o.host_wall_id == w.id)
        .filter_map(|o| {
            let from = o.position.max(0.0).min(len);
            let to = (o.position + o.width).max(from).min(len);
            let b = o.sill_height.max(0.0);
            let t = (b + o.height).min(z1 - z0);
            (to - from > 1e-4 && t - b > 1e-4).then(|| vec![[from, b], [to, b], [to, t], [from, t]])
        })
        .collect();
    let face = ring_with_holes(&[[0.0, 0.0], [len, 0.0], [len, z1 - z0], [0.0, z1 - z0]], &holes);
    let off = w.surface_pattern_offset.as_ref().map_or([0.0, 0.0], |o| [o.x, o.y]);
    for (layer, side) in [(wt.layers.first(), -1.0), (wt.layers.last(), 1.0)] {
        let Some((pat, comp, spec)) = spec_for(layer.and_then(|l| p.component(&l.component_id)), w.surface_pattern_angle.unwrap_or(0.0)) else { continue };
        let rgb = ink_rgb(pat, comp);
        // Wandmitte = Achse − n·ref_off; Seite ± halbe Dicke (+ Abstand gegen Z-Fighting).
        let d = -ref_off + side * (total / 2.0 + LIFT);
        let (ox, oy) = (w.start.x + nx * d, w.start.y + ny * d);
        for (a, b, m) in lod_segments(|sc| sp::segments(&face, &spec, off, sc)) {
            let at = |q: P| [ox + ux * q[0], oy + uy * q[0], z0 + q[1]];
            s.push(at(a), at(b), rgb, m);
        }
    }
}

/// Bogenwand ([T2]): Muster je Seite auf der abgewickelten Wandfläche (x = Bogenlänge DIESER Fläche, damit
/// Abstände auf der Fläche stimmen), Punkte mit dem Bogen gebogen; Linien längs der Wand folgen der
/// Krümmung (geteilt wie die Sehnen-Zerlegung), senkrechte bleiben gerade.
fn arc_wall_lines(p: &Project, w: &Wall, arc: &crate::wall_arc::WallArc, s: &mut Sink) {
    let len = arc.length();
    let Some(wt) = p.wall_type(w) else { return };
    let (z0, z1) = p.wall_vertical_extent(w);
    if !(z1 - z0 > 1e-6) || !(len > 1e-6) {
        return;
    }
    let total = crate::model::Project::type_thickness(&wt.layers);
    let ref_off = crate::joins::reference_offset(crate::model3d::wall_reference(w), total);
    let off = w.surface_pattern_offset.as_ref().map_or([0.0, 0.0], |o| [o.x, o.y]);
    for (layer, side) in [(wt.layers.first(), -1.0), (wt.layers.last(), 1.0)] {
        let Some((pat, comp, spec)) = spec_for(layer.and_then(|l| p.component(&l.component_id)), w.surface_pattern_angle.unwrap_or(0.0)) else { continue };
        let rgb = ink_rgb(pat, comp);
        let d = -ref_off + side * (total / 2.0 + LIFT);
        let k = arc.radius_at(d) / arc.r;
        if !(k > 1e-9) {
            continue;
        }
        let holes: Vec<Vec<P>> = p
            .openings
            .as_deref()
            .unwrap_or(&[])
            .iter()
            .filter(|o| o.host_wall_id == w.id)
            .filter_map(|o| {
                let from = o.position.max(0.0).min(len) * k;
                let to = (o.position + o.width).min(len) * k;
                let b = o.sill_height.max(0.0);
                let t = (b + o.height).min(z1 - z0);
                (to - from > 1e-4 && t - b > 1e-4).then(|| vec![[from, b], [to, b], [to, t], [from, t]])
            })
            .collect();
        let face = ring_with_holes(&[[0.0, 0.0], [len * k, 0.0], [len * k, z1 - z0], [0.0, z1 - z0]], &holes);
        let step = len / arc.segments(arc.radius_at(d)) as f64;
        let at = |q: P| {
            let pt = arc.point(q[0] / k, d);
            [pt.x, pt.y, z0 + q[1]]
        };
        for (a, b, m) in lod_segments(|sc| sp::segments(&face, &spec, off, sc)) {
            let n = (((b[0] - a[0]).abs() / k / step).ceil() as usize).clamp(1, 512);
            let mut prev = at(a);
            for i in 1..=n {
                let t = i as f64 / n as f64;
                let q = at([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
                s.push(prev, q, rgb, m);
                prev = q;
            }
        }
    }
}

/// Deckenoberseite (Bodenbelag, oberste Schicht) und -untersicht (unterste Schicht).
fn ceiling_lines(p: &Project, ce: &Ceiling, s: &mut Sink) {
    let Some(layers) = crate::model3d::ceiling_type_ref(p, ce).map(|t| t.2) else { return };
    let Some((outer, holes)) = ceiling_rings(ce) else { return };
    let ring = ring_with_holes(&outer, &holes);
    let (z0, z1) = p.ceiling_vertical_extent(ce);
    for (layer, z) in [(layers.first(), z1 + LIFT), (layers.last(), z0 - LIFT)] {
        let Some((pat, comp, spec)) = spec_for(layer.and_then(|l| p.component(&l.component_id)), 0.0) else { continue };
        let rgb = ink_rgb(pat, comp);
        for (a, b, m) in lod_segments(|sc| sp::segments(&ring, &spec, outer[0], sc)) {
            s.push([a[0], a[1], z], [b[0], b[1], z], rgb, m);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{SurfacePatternDirection, SurfacePatternKind};

    fn sample() -> Project {
        serde_json::from_str(include_str!("../tests/fixtures/sample_project.json")).unwrap()
    }

    fn with_pattern(p: &mut Project, comp_id: &str, spacing: f64) {
        let c = p.components.iter_mut().find(|c| c.id == comp_id).unwrap();
        c.surface_pattern = Some(SurfacePattern { kind: SurfacePatternKind::Lines, direction: Some(SurfacePatternDirection::Vertical), spacing, ..Default::default() });
    }

    #[test]
    fn wand_decke_dach_linien_mit_stufen() {
        let mut p = sample();
        assert!(pattern_lines_3d(&p).is_empty());
        let outer = p.wall_type(&p.walls[0]).unwrap().layers[0].component_id.clone();
        with_pattern(&mut p, &outer, 0.1);
        let v = pattern_lines_3d(&p);
        assert_eq!(v.len() % PATTERN_STRIDE, 0);
        let n = v.len() / PATTERN_STRIDE;
        assert!(n > 50, "{n}");
        // Feinste Stufe enthält alle Linien einer 10-cm-Lattung, die gröbste (1:1600) keine.
        let masks: Vec<u8> = v.chunks(PATTERN_STRIDE).map(|c| c[9] as u8).collect();
        assert!(masks.iter().all(|m| m & 1 == 1));
        assert!(masks.iter().all(|m| m & (1 << 6) == 0));
        // Weiter weg nur ein Teil (jede 2./4./8. Linie).
        let mid = masks.iter().filter(|m| *m & (1 << 3) != 0).count();
        assert!(mid > 0 && mid < n, "{mid} von {n}");
        // Welt-Höhe (y) innerhalb der Wandhöhen 0…5.2 m.
        assert!(v.chunks(PATTERN_STRIDE).all(|c| c[1] >= -0.01 && c[1] <= 5.21));
    }

    /// [T2]/[100] Bogenwand: waagrechte Lattung folgt dem Bogen (alle Punkte auf dem Flächenradius).
    #[test]
    fn bogenwand_muster_folgt_dem_bogen() {
        let mut p = sample();
        p.walls.retain(|w| w.id == "W1");
        p.openings = Some(vec![]);
        p.ceilings = Some(vec![]);
        p.roofs = Some(vec![]);
        p.walls[0].bulge = Some(1.0); // Halbkreis (0,0)→(5,0), Mitte (2.5,0), r 2.5
        let outer = p.wall_type(&p.walls[0]).unwrap().layers[0].component_id.clone();
        let c = p.components.iter_mut().find(|c| c.id == outer).unwrap();
        c.surface_pattern = Some(SurfacePattern { kind: SurfacePatternKind::Lines, direction: Some(SurfacePatternDirection::Horizontal), spacing: 0.2, ..Default::default() });
        let v = pattern_lines_3d(&p);
        let n = v.len() / PATTERN_STRIDE;
        assert!(n > 100, "{n}");
        // Welt (x, Höhe, y): Abstand zur Bogenmitte = Radius der Aussenfläche (Achse mittig, 0.345 dick).
        // Uhrzeigersinn: rechts der Laufrichtung (äusserste Schicht) liegt zur Bogenmitte hin.
        let r_face = 2.5 - 0.345 / 2.0 - LIFT;
        for c in v.chunks(PATTERN_STRIDE) {
            for (x, y) in [(c[0], c[2]), (c[3], c[5])] {
                let r = ((x as f64 - 2.5).powi(2) + (y as f64).powi(2)).sqrt();
                assert!((r - r_face).abs() < 1e-4, "{r} ≠ {r_face}");
            }
        }
    }

    #[test]
    fn bodenbelag_im_grundriss() {
        let mut p = sample();
        let ce = p.ceilings.as_ref().unwrap()[0].clone();
        let top = crate::model3d::ceiling_type_ref(&p, &ce).unwrap().2[0].component_id.clone();
        assert!(floor_finish_segments(&p, &ce, 50.0).is_none());
        with_pattern(&mut p, &top, 0.12);
        let (segs, w, _) = floor_finish_segments(&p, &ce, 50.0).unwrap();
        assert!(segs.len() > 20, "{}", segs.len());
        assert!(w > 0.0);
        // 3D: Oberseite der Decke auf OK Decke.
        let v = pattern_lines_3d(&p);
        let (_, z1) = p.ceiling_vertical_extent(&ce);
        assert!(v.chunks(PATTERN_STRIDE).any(|c| (c[1] as f64 - z1).abs() < 0.01));
    }
}
