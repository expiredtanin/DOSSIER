// IFC-Import zu Bauteilen ([B4]): Formerkennung für Dächer, Treppen und Bogenwände aus Dreiecksnetzen
// (Weltkoordinaten, Meter, z = Höhe). Wird von `ifc_semantic.rs` benutzt; hier nur Geometrie, keine
// IFC-Beziehungen.
//
// Eigener Code.
//   - Dach: Dachflächen = nach oben zeigende Dreiecke, nach Ebene gruppiert (je Normale die oberste;
//     Schicht-Körper übereinander zählen einmal). Grundriss = achsparalleles Rechteck, ganz bedeckt;
//     Form nach Zahl und Richtung der Flächen: 1 waagrecht = Flach, 1 geneigt = Pult (steigt nach +x/+y,
//     wie das Dossier-Pultdach), 2 gegenläufig = Sattel, 4 = Walm; alle gleich geneigt. Jeder Punkt
//     der Dachflächen muss auf der Dossier-Dachfläche liegen (±3 cm), sonst kein Dach.
//   - Treppe: gerader Lauf — Trittflächen (waagrechte Oberseiten) in gleichen Höhenschritten, deren
//     Vorderkanten linear entlang der Laufrichtung fortschreiten.
//   - Bogenwand: senkrechtes Prisma, Umriss auf zwei konzentrischen Kreisen (Ringausschnitt).
//
// Unsinn ergibt `Err(Grund)`, nie Panic.

use crate::ifc_import::{Mesh, V2, V3};

/// Grund: Dachform nicht abbildbar.
pub(crate) const R_ROOF_FORM: &str = "roofForm";
/// Grund: Treppe nicht gerade/gleichmässig.
pub(crate) const R_STAIR_FORM: &str = "stairForm";

fn sub3(a: V3, b: V3) -> V3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
fn cross3(a: V3, b: V3) -> V3 {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}
fn dot3(a: V3, b: V3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

/// Dreiecke eines Netzes: (Eckpunkte, Einheitsnormale, Fläche); entartete ausgelassen.
pub(crate) fn triangles(m: &Mesh) -> Vec<([V3; 3], V3, f64)> {
    let p = |i: u32| -> Option<V3> {
        let k = i as usize * 3;
        m.positions.get(k..k + 3).map(|s| [s[0], s[1], s[2]])
    };
    let mut out = Vec::with_capacity(m.indices.len() / 3);
    for t in m.indices.chunks_exact(3) {
        let (Some(a), Some(b), Some(c)) = (p(t[0]), p(t[1]), p(t[2])) else { continue };
        let n = cross3(sub3(b, a), sub3(c, a));
        let l = dot3(n, n).sqrt();
        if !(l.is_finite() && l > 1e-12) || !a.iter().chain(&b).chain(&c).all(|x| x.is_finite()) {
            continue;
        }
        out.push(([a, b, c], [n[0] / l, n[1] / l, n[2] / l], l / 2.0));
    }
    out
}

/// Ebene aus gleich orientierten Dreiecken.
struct Plane {
    n: V3,
    d: f64,
    area: f64,
    pts: Vec<V3>,
}

/// Gruppiert Dreiecke nach Ebene (Normale ±0.8°, Abstand ±5 mm).
fn planes(tris: &[&([V3; 3], V3, f64)]) -> Vec<Plane> {
    let mut out: Vec<Plane> = Vec::new();
    for (pts, n, a) in tris.iter().map(|t| (&t.0, t.1, t.2)) {
        let c = [(pts[0][0] + pts[1][0] + pts[2][0]) / 3.0, (pts[0][1] + pts[1][1] + pts[2][1]) / 3.0, (pts[0][2] + pts[1][2] + pts[2][2]) / 3.0];
        let d = dot3(n, c);
        match out.iter_mut().find(|p| dot3(p.n, n) > 0.9999 && (p.d - d).abs() <= 0.005) {
            Some(p) => {
                p.area += a;
                p.pts.extend_from_slice(pts);
            }
            None => out.push(Plane { n, d, area: a, pts: pts.to_vec() }),
        }
        if out.len() > 4000 {
            break;
        }
    }
    out
}

/// Erkanntes Dach (Dossier-Parameter, Überstand 0: der Umriss ist schon die Traufe).
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct RoofFit {
    /// x0, y0, x1, y1.
    pub bbox: [f64; 4],
    pub shape: &'static str,
    pub pitch_deg: f64,
    pub ridge_axis: &'static str,
    pub eave_z: f64,
    /// Dicke senkrecht zur Dachfläche.
    pub thickness: f64,
}

impl RoofFit {
    /// Höhe der Dach-Oberseite im Grundrisspunkt (Dossier-Dachfläche, ohne Grenze auf den Umriss).
    pub fn top_at(&self, x: f64, y: f64) -> f64 {
        let [x0, y0, x1, y1] = self.bbox;
        // Im Kanon läuft der First entlang u; v quer dazu.
        let (u, v, u0, u1, v0, v1) = if self.ridge_axis == "x" { (x, y, x0, x1, y0, y1) } else { (y, x, y0, y1, x0, x1) };
        let tan = (self.pitch_deg.to_radians()).tan();
        let rise = match self.shape {
            "pult" => v - v0,
            "sattel" => (v - v0).min(v1 - v),
            "walm" => (v - v0).min(v1 - v).min(u - u0).min(u1 - u),
            _ => 0.0,
        };
        self.eave_z + rise * tan
    }

    /// Dach-Unterkante im Grundrisspunkt; `None` ausserhalb.
    pub fn underside_at(&self, x: f64, y: f64) -> Option<f64> {
        let [x0, y0, x1, y1] = self.bbox;
        if !(x >= x0 - 1e-6 && x <= x1 + 1e-6 && y >= y0 - 1e-6 && y <= y1 + 1e-6) {
            return None;
        }
        Some(self.top_at(x, y) - self.thickness / self.pitch_deg.to_radians().cos().max(0.05))
    }
}

/// Dach aus den Körpern seiner Teile.
pub(crate) fn fit_roof(meshes: &[Mesh]) -> Result<RoofFit, &'static str> {
    let tris: Vec<_> = meshes.iter().flat_map(triangles).collect();
    let up: Vec<_> = tris.iter().filter(|t| t.1[2] > 0.08).collect();
    let down: Vec<_> = tris.iter().filter(|t| t.1[2] < -0.08).collect();
    if up.is_empty() || down.is_empty() {
        return Err(R_ROOF_FORM);
    }
    let top_all = planes(&up);
    let bottom = planes(&down);
    let largest = top_all.iter().map(|p| p.area).fold(0.0, f64::max);
    // Je Richtung nur die oberste Ebene (Schicht-Körper übereinander), kleine Flächen (Firstabdeckung,
    // rechtwinklige Stirnschnitte der Platten) nicht.
    let mut top: Vec<&Plane> = Vec::new();
    for p in top_all.iter().filter(|p| p.area >= 0.1 * largest) {
        match top.iter_mut().find(|q| dot3(q.n, p.n) > 0.9999) {
            Some(q) => {
                if p.d > q.d {
                    *q = p;
                }
            }
            None => top.push(p),
        }
    }
    #[cfg(test)]
    if std::env::var("DOSSIER_IFC_DEBUG").is_ok() {
        let pr: f64 = top.iter().map(|p| p.area * p.n[2]).sum();
        let (mut b0, mut b1) = ([f64::INFINITY; 3], [f64::NEG_INFINITY; 3]);
        for q in top.iter().flat_map(|p| p.pts.iter()) {
            for k in 0..3 {
                b0[k] = b0[k].min(q[k]);
                b1[k] = b1[k].max(q[k]);
            }
        }
        eprintln!(
            "Dach: {} Flächen oben (alle {}), proj {pr:.2} bbox {:.2}×{:.2} z {:.2}..{:.2}, Normalen {:?}",
            top.len(),
            top_all.len(),
            b1[0] - b0[0],
            b1[1] - b0[1],
            b0[2],
            b1[2],
            top.iter().map(|p| ([p.n[0] as f32, p.n[1] as f32, p.n[2] as f32], p.area as f32)).collect::<Vec<_>>()
        );
    }
    if top.is_empty() || top.len() > 4 {
        return Err(R_ROOF_FORM);
    }
    let pts: Vec<V3> = top.iter().flat_map(|p| p.pts.iter().copied()).collect();
    let (mut x0, mut y0, mut x1, mut y1) = (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
    let mut eave_z = f64::INFINITY;
    for q in &pts {
        x0 = x0.min(q[0]);
        y0 = y0.min(q[1]);
        x1 = x1.max(q[0]);
        y1 = y1.max(q[1]);
        eave_z = eave_z.min(q[2]);
    }
    let box_area = (x1 - x0) * (y1 - y0);
    // Projizierte Fläche der Dachflächen = Rechteck (achsparallel, ganz bedeckt, keine Doppelung).
    let projected: f64 = top.iter().map(|p| p.area * p.n[2]).sum();
    if !(box_area > 0.01 && (projected - box_area).abs() <= 0.03 * box_area) {
        return Err(R_ROOF_FORM);
    }
    let pitch = |p: &Plane| p.n[2].clamp(-1.0, 1.0).acos().to_degrees();
    let pitch_deg = pitch(top[0]);
    if top.iter().any(|p| (pitch(p) - pitch_deg).abs() > 0.3) {
        return Err(R_ROOF_FORM);
    }
    // Steigrichtung je Fläche (gegen die waagrechte Normale): 0 = +x, 1 = −x, 2 = +y, 3 = −y.
    let flat = pitch_deg < 0.3;
    let mut dirs = Vec::new();
    if !flat {
        for p in &top {
            let (hx, hy) = (-p.n[0], -p.n[1]);
            let l = hx.hypot(hy);
            let (hx, hy) = (hx / l, hy / l);
            let k = if hx > 0.9995 {
                0
            } else if hx < -0.9995 {
                1
            } else if hy > 0.9995 {
                2
            } else if hy < -0.9995 {
                3
            } else {
                return Err(R_ROOF_FORM);
            };
            if dirs.contains(&k) {
                return Err(R_ROOF_FORM);
            }
            dirs.push(k);
        }
        dirs.sort_unstable();
    }
    let longer_x = x1 - x0 >= y1 - y0;
    let (shape, ridge_axis, pitch_deg) = match (flat, dirs.as_slice()) {
        (true, _) if top.len() == 1 => ("flach", if longer_x { "x" } else { "y" }, 0.0),
        (false, [2]) => ("pult", "x", pitch_deg),
        (false, [0]) => ("pult", "y", pitch_deg),
        (false, [2, 3]) => ("sattel", "x", pitch_deg),
        (false, [0, 1]) => ("sattel", "y", pitch_deg),
        (false, [0, 1, 2, 3]) => ("walm", if longer_x { "x" } else { "y" }, pitch_deg),
        _ => return Err(R_ROOF_FORM),
    };
    // Dicke: Abstand zur untersten Gegenfläche der grössten Dachfläche.
    let main = top.iter().max_by(|a, b| a.area.total_cmp(&b.area)).ok_or(R_ROOF_FORM)?;
    let thickness = bottom.iter().filter(|b| dot3(b.n, main.n) < -0.9999).map(|b| main.d + b.d).fold(f64::NAN, f64::max);
    if !(thickness > 0.01 && thickness <= 2.0) {
        return Err(R_ROOF_FORM);
    }
    let fit = RoofFit { bbox: [x0, y0, x1, y1], shape, pitch_deg, ridge_axis, eave_z, thickness };
    if pts.iter().any(|q| (q[2] - fit.top_at(q[0], q[1])).abs() > 0.03) {
        return Err(R_ROOF_FORM);
    }
    Ok(fit)
}

/// Volumen eines senkrechten Quaders über dem Rechteck (Ursprung `o`, Richtung `d`, Länge `len`, Dicke
/// `t` symmetrisch zur Achse), unten `z0`, oben `z1`, von den Dächern auf ihre Unterkante gekappt
/// (numerisch, 64 × 4 Stützstellen). So schneidet Dossier eine Wand mit Dachanschluss.
pub(crate) fn capped_volume(o: V2, d: V2, len: f64, t: f64, z0: f64, z1: f64, roofs: &[RoofFit]) -> f64 {
    let (nu, nv) = (64, 4);
    let n = [-d[1], d[0]];
    let mut sum = 0.0;
    for i in 0..nu {
        let u = (i as f64 + 0.5) / nu as f64 * len;
        for j in 0..nv {
            let v = ((j as f64 + 0.5) / nv as f64 - 0.5) * t;
            let (x, y) = (o[0] + d[0] * u + n[0] * v, o[1] + d[1] * u + n[1] * v);
            let cap = roofs.iter().filter_map(|r| r.underside_at(x, y)).fold(z1, f64::min);
            sum += (cap - z0).max(0.0);
        }
    }
    sum / (nu * nv) as f64 * len * t
}

/// Erkannte gerade Treppe.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct StairFit {
    /// Mitte der ersten Setzstufe (Antritt).
    pub start: V2,
    pub dir: V2,
    pub width: f64,
    /// Auftritt (Abstand der Vorderkanten).
    pub going: f64,
    /// Steigung (Höhe je Stufe).
    pub riser: f64,
    /// Anzahl Trittflächen im Körper.
    pub treads: usize,
    /// Antrittshöhe (erster Tritt − Steigung).
    pub z0: f64,
    /// Der oberste Tritt ist die höchste Stelle des Körpers (Austritt aufs Podest/Geschoss).
    pub top_is_exit: bool,
}

/// Gerade Treppe aus den Körpern ihrer Teile (Läufe, Wangen …).
pub(crate) fn fit_stair(meshes: &[Mesh]) -> Result<StairFit, &'static str> {
    let tris: Vec<_> = meshes.iter().flat_map(triangles).collect();
    let mut plan: Vec<V2> = Vec::new();
    let (mut z0, mut z1) = (f64::INFINITY, f64::NEG_INFINITY);
    for t in &tris {
        for p in &t.0 {
            plan.push([p[0], p[1]]);
            z0 = z0.min(p[2]);
            z1 = z1.max(p[2]);
        }
    }
    let (d, u0, u1, v0, v1) = crate::ifc_semantic::min_area_rect(&plan).ok_or(R_STAIR_FORM)?;
    // Trittflächen: waagrechte Oberseiten, nach Höhe gruppiert (±5 mm), je Höhe die u-Ausdehnung.
    let n = [-d[1], d[0]];
    let mut levels: Vec<(f64, f64, f64, f64)> = Vec::new(); // (z, umin, umax, Fläche)
    for (pts, nrm, a) in tris.iter().filter(|t| t.1[2] > 0.999) {
        let _ = nrm;
        let z = (pts[0][2] + pts[1][2] + pts[2][2]) / 3.0;
        let us = pts.iter().map(|p| p[0] * d[0] + p[1] * d[1]);
        let (lo, hi) = us.fold((f64::INFINITY, f64::NEG_INFINITY), |(l, h), u| (l.min(u), h.max(u)));
        match levels.iter_mut().find(|l| (l.0 - z).abs() <= 0.005) {
            Some(l) => {
                l.1 = l.1.min(lo);
                l.2 = l.2.max(hi);
                l.3 += a;
            }
            None => levels.push((z, lo, hi, *a)),
        }
        if levels.len() > 400 {
            return Err(R_STAIR_FORM);
        }
    }
    let width = v1 - v0;
    // Nur Flächen, die über die Laufbreite reichen (keine Handlauf-Oberseiten, Wangenköpfe).
    #[cfg(test)]
    if std::env::var("DOSSIER_IFC_DEBUG").is_ok() {
        let mut l = levels.clone();
        l.sort_by(|a, b| a.0.total_cmp(&b.0));
        eprintln!("Treppe z0 {z0:.3} z1 {z1:.3} Breite {width:.3} Länge {:.3} Ebenen {:?}", u1 - u0, l.iter().map(|x| ((x.0 - z0) as f32, (x.1 - u0) as f32, (x.2 - u0) as f32, x.3 as f32)).collect::<Vec<_>>());
    }
    levels.retain(|l| l.3 >= 0.06 * width && l.0 > z0 + 0.02);
    levels.sort_by(|a, b| a.0.total_cmp(&b.0));
    // Belag über dem Rohbau (zwei Flächen wenige cm übereinander): die obere zählt.
    let mut merged: Vec<(f64, f64, f64, f64)> = Vec::new();
    for l in levels {
        match merged.last_mut() {
            Some(m) if l.0 - m.0 < 0.08 => *m = l,
            _ => merged.push(l),
        }
    }
    let levels = merged;
    if levels.len() < 2 || !(0.4..=6.0).contains(&width) {
        return Err(R_STAIR_FORM);
    }
    let k = levels.len();
    let mut diffs: Vec<f64> = levels.windows(2).map(|w| w[1].0 - w[0].0).collect();
    diffs.sort_by(f64::total_cmp);
    let riser = diffs[diffs.len() / 2];
    if !(0.1..=0.25).contains(&riser) {
        return Err(R_STAIR_FORM);
    }
    // Gleichmässige Steigung und Vorderkanten linear in der Stufennummer (aufwärts entlang +d oder −d).
    for (i, l) in levels.iter().enumerate() {
        if (l.0 - (levels[0].0 + riser * i as f64)).abs() > 0.01 {
            return Err(R_STAIR_FORM);
        }
    }
    // Genauer als der Median: Mittel über den ganzen Lauf.
    let riser = (levels[k - 1].0 - levels[0].0) / (k - 1) as f64;
    let top_is_exit = (z1 - levels[k - 1].0).abs() <= 0.03;
    let z0 = levels[0].0 - riser;
    let up = levels[k - 1].1 + levels[k - 1].2 > levels[0].1 + levels[0].2;
    // Vorderkante: bei Lauf in +d das untere u-Ende, sonst das obere.
    let front = |l: &(f64, f64, f64, f64)| if up { l.1 } else { -l.2 };
    let going = (front(&levels[k - 1]) - front(&levels[0])) / (k - 1) as f64;
    if !(0.15..=0.45).contains(&going) {
        return Err(R_STAIR_FORM);
    }
    for (i, l) in levels.iter().enumerate() {
        if (front(l) - (front(&levels[0]) + going * i as f64)).abs() > 0.03 {
            return Err(R_STAIR_FORM);
        }
    }
    // Antritt = Vorderkante des ersten Tritts (Dossier: Tritt i über [i·a, (i+1)·a], Oberkante (i+1)·h).
    let dir = if up { d } else { [-d[0], -d[1]] };
    let s_world = if up { front(&levels[0]) } else { -front(&levels[0]) };
    if s_world < u0 - 0.05 || s_world > u1 + 0.05 {
        return Err(R_STAIR_FORM);
    }
    let vc = (v0 + v1) / 2.0;
    let start = [d[0] * s_world + n[0] * vc, d[1] * s_world + n[1] * vc];
    Ok(StairFit { start, dir, width, going, riser, treads: k, z0, top_is_exit })
}

/// Bogen einer Bogenwand: Achse (Mitte der Dicke) von `start` nach `end` gegen den Uhrzeigersinn um
/// `center`.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ArcFit {
    pub center: V2,
    pub radius: f64,
    pub thickness: f64,
    /// Winkel (rad) von Start und Ende, `a1 > a0`.
    pub a0: f64,
    pub a1: f64,
}

/// Ringausschnitt: Umriss (aussen) einer senkrechten Prisma-Wand auf zwei konzentrischen Kreisen.
pub(crate) fn fit_arc_ring(ring: &[V2]) -> Option<ArcFit> {
    let n = ring.len();
    if n < 8 {
        return None;
    }
    // Mittelpunkt: häufigster Umkreismittelpunkt dreier aufeinanderfolgender Punkte (Raster 1 mm).
    let mut votes: std::collections::HashMap<(i64, i64), (usize, V2)> = std::collections::HashMap::new();
    for i in 0..n {
        let (a, b, c) = (ring[i], ring[(i + 1) % n], ring[(i + 2) % n]);
        let dd = 2.0 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
        if dd.abs() < 1e-12 {
            continue;
        }
        let (a2, b2, c2) = (a[0] * a[0] + a[1] * a[1], b[0] * b[0] + b[1] * b[1], c[0] * c[0] + c[1] * c[1]);
        let cx = (a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / dd;
        let cy = (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / dd;
        if !(cx.is_finite() && cy.is_finite()) {
            continue;
        }
        let e = votes.entry(((cx * 1000.0).round() as i64, (cy * 1000.0).round() as i64)).or_insert((0, [cx, cy]));
        e.0 += 1;
    }
    let (count, center) = votes.values().max_by(|a, b| a.0.cmp(&b.0).then(b.1[0].total_cmp(&a.1[0])).then(b.1[1].total_cmp(&a.1[1])))?.to_owned();
    if count < n / 3 {
        return None;
    }
    let rs: Vec<f64> = ring.iter().map(|p| (p[0] - center[0]).hypot(p[1] - center[1])).collect();
    let r_in = rs.iter().copied().fold(f64::INFINITY, f64::min);
    let r_out = rs.iter().copied().fold(0.0, f64::max);
    let t = r_out - r_in;
    if !(t >= 0.01 && t <= 2.0 && r_in > 0.05) || rs.iter().any(|r| (r - r_in).abs() > 0.002 && (r - r_out).abs() > 0.002) {
        return None;
    }
    // Winkelbereich: grösste Lücke zwischen den sortierten Winkeln liegt ausserhalb der Wand.
    let mut ang: Vec<f64> = ring.iter().map(|p| (p[1] - center[1]).atan2(p[0] - center[0])).collect();
    ang.sort_by(f64::total_cmp);
    let mut gap = (ang[0] + std::f64::consts::TAU - ang[ang.len() - 1], ang.len() - 1);
    for i in 0..ang.len() - 1 {
        if ang[i + 1] - ang[i] > gap.0 {
            gap = (ang[i + 1] - ang[i], i);
        }
    }
    let a0 = ang[(gap.1 + 1) % ang.len()];
    let mut a1 = ang[gap.1];
    while a1 <= a0 {
        a1 += std::f64::consts::TAU;
    }
    let sweep = a1 - a0;
    if !(sweep > 0.05 && sweep < std::f64::consts::TAU - 0.05) {
        return None;
    }
    Some(ArcFit { center, radius: (r_in + r_out) / 2.0, thickness: t, a0, a1 })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn quad(m: &mut Mesh, p: [V3; 4]) {
        let b = m.positions.len() as u32 / 3;
        for q in p {
            m.positions.extend_from_slice(&q);
        }
        m.indices.extend_from_slice(&[b, b + 1, b + 2, b, b + 2, b + 3]);
    }

    /// Geneigte Platte über [x0,x1] × [ya,yb], Oberseite von za (bei ya) nach zb (bei yb), Dicke
    /// senkrecht `t` (Unterseite parallel), Stirnseiten senkrecht.
    fn plate(x0: f64, x1: f64, ya: f64, yb: f64, za: f64, zb: f64, t: f64) -> Mesh {
        let mut m = Mesh::default();
        let (dy, dz) = (yb - ya, zb - za);
        let l = dy.hypot(dz);
        // Normale der Oberseite (zeigt nach oben): (0, −dz, dy)/l bei dy > 0.
        let (ny, nz) = (-dz / l * dy.signum(), dy.abs() / l);
        let off = |p: V3| [p[0], p[1] - ny * t, p[2] - nz * t];
        let top = [[x0, ya, za], [x1, ya, za], [x1, yb, zb], [x0, yb, zb]];
        let top = if dy > 0.0 { top } else { [top[1], top[0], top[3], top[2]] };
        let bot: Vec<V3> = top.iter().map(|p| off(*p)).collect();
        quad(&mut m, top);
        quad(&mut m, [bot[3], bot[2], bot[1], bot[0]]);
        for i in 0..4 {
            let j = (i + 1) % 4;
            quad(&mut m, [top[j], top[i], bot[i], bot[j]]);
        }
        m
    }

    #[test]
    fn saddle_roof_from_two_plates() {
        // Satteldach 10 × 8, First entlang x in y = 4, Traufe z = 3, 30°.
        let tan = 30f64.to_radians().tan();
        let a = plate(0.0, 10.0, 0.0, 4.0, 3.0, 3.0 + 4.0 * tan, 0.2);
        let b = plate(0.0, 10.0, 8.0, 4.0, 3.0, 3.0 + 4.0 * tan, 0.2);
        let f = fit_roof(&[a.clone(), b]).unwrap();
        assert_eq!((f.shape, f.ridge_axis), ("sattel", "x"));
        assert!((f.pitch_deg - 30.0).abs() < 1e-6 && (f.eave_z - 3.0).abs() < 1e-9 && (f.thickness - 0.2).abs() < 1e-6, "{f:?}");
        assert_eq!(f.bbox, [0.0, 0.0, 10.0, 8.0]);
        assert!((f.top_at(5.0, 4.0) - (3.0 + 4.0 * tan)).abs() < 1e-9);
        // Eine Platte allein: Pultdach steigt nach +y.
        let p = fit_roof(&[a]).unwrap();
        assert_eq!((p.shape, p.ridge_axis), ("pult", "x"));
        // Fallend nach +y kann das Dossier-Pultdach nicht.
        let c = plate(0.0, 10.0, 8.0, 4.0, 3.0, 3.0 + 4.0 * tan, 0.2);
        assert_eq!(fit_roof(&[c]), Err(R_ROOF_FORM));
        // Ungleiche Neigung: kein Satteldach.
        let a = plate(0.0, 10.0, 0.0, 4.0, 3.0, 3.0 + 4.0 * tan, 0.2);
        let b = plate(0.0, 10.0, 8.0, 4.0, 3.0, 3.0 + 3.0 * tan, 0.2);
        assert!(fit_roof(&[a, b]).is_err());
    }

    #[test]
    fn flat_roof_and_capped_wall_volume() {
        let mut m = Mesh::default();
        quad(&mut m, [[0.0, 0.0, 3.3], [4.0, 0.0, 3.3], [4.0, 2.0, 3.3], [0.0, 2.0, 3.3]]);
        quad(&mut m, [[0.0, 2.0, 3.0], [4.0, 2.0, 3.0], [4.0, 0.0, 3.0], [0.0, 0.0, 3.0]]);
        let f = fit_roof(&[m]).unwrap();
        assert_eq!((f.shape, f.ridge_axis, f.pitch_deg), ("flach", "x", 0.0));
        assert!((f.thickness - 0.3).abs() < 1e-9);
        // Giebelwand unter Satteldach (Traufe 3, 45°, Dicke 0.2 → Unterkante 3 − 0.2·√2 an der Traufe).
        let r = RoofFit { bbox: [0.0, 0.0, 10.0, 8.0], shape: "sattel", pitch_deg: 45.0, ridge_axis: "x", eave_z: 3.0, thickness: 0.2 };
        let u = 3.0 - 0.2 * 2f64.sqrt();
        // Wand in x = 0.1 entlang y, 0 … 8, bis 10 hoch: gekappt auf Dreieck + Rechteck.
        let v = capped_volume([0.1, 0.0], [0.0, 1.0], 8.0, 0.2, 0.0, 10.0, &[r]);
        let want = (u * 8.0 + 4.0 * 4.0) * 0.2;
        assert!((v - want).abs() / want < 0.005, "{v} {want}");
    }

    #[test]
    fn straight_stair_from_steps() {
        // 5 Stufen à 0.18 × 0.28, 1.0 breit, Lauf in −y ab y = 3; Klötze von z = 0 bis zur Trittfläche.
        let mut m = Mesh::default();
        for i in 0..5 {
            let (ya, yb) = (3.0 - 0.28 * (i + 1) as f64, 3.0 - 0.28 * i as f64);
            let z = 0.18 * (i + 1) as f64;
            quad(&mut m, [[2.0, ya, z], [3.0, ya, z], [3.0, yb, z], [2.0, yb, z]]);
            quad(&mut m, [[2.0, yb, 0.0], [3.0, yb, 0.0], [3.0, ya, 0.0], [2.0, ya, 0.0]]);
        }
        let s = fit_stair(&[m]).unwrap();
        assert!((s.going - 0.28).abs() < 1e-9 && (s.riser - 0.18).abs() < 1e-9 && s.treads == 5, "{s:?}");
        assert!((s.dir[0]).abs() < 1e-9 && (s.dir[1] + 1.0).abs() < 1e-9);
        // Antritt = Vorderkante des ersten Tritts (Dossier: Tritt i über [i·a, (i+1)·a]).
        assert!((s.start[0] - 2.5).abs() < 1e-9 && (s.start[1] - 3.0).abs() < 1e-9, "{s:?}");
        assert!((s.width - 1.0).abs() < 1e-9);
    }

    #[test]
    fn arc_ring_center_radius_sweep() {
        // Viertelring um (1, 2), Radien 4.9 … 5.1, von 0° bis 90°.
        let mut ring = Vec::new();
        for i in 0..=16 {
            let a = std::f64::consts::FRAC_PI_2 * i as f64 / 16.0;
            ring.push([1.0 + 5.1 * a.cos(), 2.0 + 5.1 * a.sin()]);
        }
        for i in (0..=16).rev() {
            let a = std::f64::consts::FRAC_PI_2 * i as f64 / 16.0;
            ring.push([1.0 + 4.9 * a.cos(), 2.0 + 4.9 * a.sin()]);
        }
        let f = fit_arc_ring(&ring).unwrap();
        assert!((f.center[0] - 1.0).abs() < 1e-6 && (f.center[1] - 2.0).abs() < 1e-6);
        assert!((f.radius - 5.0).abs() < 1e-9 && (f.thickness - 0.2).abs() < 1e-9);
        assert!(f.a0.abs() < 1e-9 && (f.a1 - std::f64::consts::FRAC_PI_2).abs() < 1e-9, "{f:?}");
        // Rechteck ist kein Ring.
        assert!(fit_arc_ring(&[[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]]).is_none());
    }
}
