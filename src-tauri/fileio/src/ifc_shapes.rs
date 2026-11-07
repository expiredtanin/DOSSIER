// IFC-Import zu Bauteilen ([B4]): Formerkennung für Dächer, Treppen und Bogenwände aus Dreiecksnetzen
// (Weltkoordinaten, Meter, z = Höhe). Wird von `ifc_semantic.rs` benutzt; hier nur Geometrie, keine
// IFC-Beziehungen.
//
// Eigener Code.
//   - Dach: Dachflächen = nach oben zeigende Dreiecke, nach Ebene gruppiert (je Normale die oberste;
//     Schicht-Körper übereinander zählen einmal). Grundriss = kleinstes umschliessendes Rechteck (auch
//     gedreht), ganz bedeckt; alle Flächen gleich geneigt, je Fläche eine Traufkante des Rechtecks.
//     Achsparallel die Dossier-Standardformen (1 waagrecht = Flach, Pult steigend nach +x/+y, Sattel,
//     Walm); Flach und Walm auch gedreht (folgen dem Umriss); sonst (gedreht, Pult fallend nach +x/+y,
//     zwei Flächen über Eck …) Satteldach mit Neigung je Kante (`edgePitchDeg`, Giebel ohne Traufe). Jeder
//     Punkt der Dachflächen muss auf der Dossier-Dachfläche liegen (±3 cm), sonst kein Dach.
//   - Treppe: gerader Lauf — Trittflächen (waagrechte Oberseiten) in gleichen Höhenschritten, deren
//     Vorderkanten linear entlang der Laufrichtung fortschreiten. (6.11.) Wendel — Tritt-Schwerpunkte auf
//     einem Kreis in gleichen Winkelschritten, jeder Tritt über die ganze Breite, Spindel aus senkrechten
//     Flächen ringsum im Auge. L — zwei rechtwinklige Läufe gleicher Breite, quadratisches Podest an der
//     Ecke (wie Dossier). (6.11., [151]) U — Halbpodest (auch mit versetztem Gegenlauf) oder zwei
//     Viertelpodeste mit Mittellauf quer über das Auge; gerade mit Zwischenpodest. Trittflächen ausser Takt
//     (Wangen-/Rahmenstücke zwischen den Steigungen) zählen dort nicht. Andere Podesttreppen → `stairTurn`.
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

/// Erkanntes Dach (Dossier-Parameter, Überstand 0: der Umriss ist schon die Traufe). Grundriss = Rechteck im
/// Rahmen (`d`, links von `d`), auch gedreht; je Rechteckkante Traufe (geneigt) oder Giebel.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct RoofFit {
    /// Richtung der Rechteck-Kante 0 (Einheitsvektor); quer dazu `[-d[1], d[0]]`.
    pub d: V2,
    /// u0, u1, v0, v1 im Rahmen.
    pub rect: [f64; 4],
    /// Traufkanten: 0 = v0 (steigt nach +v), 1 = u1 (nach −u), 2 = v1 (nach −v), 3 = u0 (nach +u).
    pub eaves: [bool; 4],
    /// Dossier-Dachform: "flach", "pult", "sattel", "walm".
    pub shape: &'static str,
    pub pitch_deg: f64,
    pub ridge_axis: &'static str,
    /// Neigung je Umrisskante (`Roof.edgePitchDeg`, `None` = Giebel), wenn die Standardform nicht passt
    /// (gedreht, Pult fallend nach +x/+y …); Form dann "sattel".
    pub edge_pitch: Option<[Option<f64>; 4]>,
    pub eave_z: f64,
    /// Dicke senkrecht zur Dachfläche.
    pub thickness: f64,
}

impl RoofFit {
    /// Umriss (Traufe) gegen den Uhrzeigersinn, Kante i = Punkt i → i+1 wie [`RoofFit::eaves`].
    pub fn outline(&self) -> [V2; 4] {
        let [u0, u1, v0, v1] = self.rect;
        let (d, n) = (self.d, [-self.d[1], self.d[0]]);
        let at = |u: f64, v: f64| [d[0] * u + n[0] * v, d[1] * u + n[1] * v];
        [at(u0, v0), at(u1, v0), at(u1, v1), at(u0, v1)]
    }

    fn local(&self, x: f64, y: f64) -> (f64, f64) {
        (x * self.d[0] + y * self.d[1], -x * self.d[1] + y * self.d[0])
    }

    /// Höhe der Dach-Oberseite im Grundrisspunkt (Dossier-Dachfläche, ohne Grenze auf den Umriss): je
    /// Traufkante steigt eine Ebene, das Dach ist die unterste (konvexer Umriss, gleiche Neigung).
    pub fn top_at(&self, x: f64, y: f64) -> f64 {
        let (u, v) = self.local(x, y);
        let [u0, u1, v0, v1] = self.rect;
        let dist = [v - v0, u1 - u, v1 - v, u - u0];
        let rise = (0..4).filter(|&i| self.eaves[i]).map(|i| dist[i]).fold(f64::INFINITY, f64::min);
        let rise = if rise.is_finite() { rise } else { 0.0 };
        self.eave_z + rise * self.pitch_deg.to_radians().tan()
    }

    /// Dach-Unterkante im Grundrisspunkt; `None` ausserhalb.
    pub fn underside_at(&self, x: f64, y: f64) -> Option<f64> {
        let (u, v) = self.local(x, y);
        let [u0, u1, v0, v1] = self.rect;
        if !(u >= u0 - 1e-6 && u <= u1 + 1e-6 && v >= v0 - 1e-6 && v <= v1 + 1e-6) {
            return None;
        }
        Some(self.top_at(x, y) - self.thickness / self.pitch_deg.to_radians().cos().max(0.05))
    }
}

/// Tonnendach aus ebenen Streifen: mindestens vier verschieden geneigte obere Flächen, alle parallel zu
/// einer waagrechten Achse (Zylinder-Facetten).
pub(crate) fn is_barrel(meshes: &[Mesh]) -> bool {
    let tris: Vec<_> = meshes.iter().flat_map(triangles).collect();
    let mut normals: Vec<(V3, f64)> = Vec::new();
    for (_, n, a) in tris.iter().filter(|t| t.1[2] > 0.08) {
        match normals.iter_mut().find(|q| dot3(q.0, *n) > 0.9999) {
            Some(q) => q.1 += a,
            None => normals.push((*n, *a)),
        }
        if normals.len() > 200 {
            return false;
        }
    }
    let total: f64 = normals.iter().map(|q| q.1).sum();
    normals.retain(|q| q.1 >= 0.01 * total);
    if normals.len() < 4 {
        return false;
    }
    let n1 = normals.iter().max_by(|a, b| a.1.total_cmp(&b.1)).map(|q| q.0).unwrap_or([0.0, 0.0, 1.0]);
    let Some(n2) = normals.iter().map(|q| q.0).find(|n| dot3(*n, n1) < 0.9999) else { return false };
    let c = cross3(n1, n2);
    let l = c[0].hypot(c[1]);
    if !(l > 1e-6 && c[2].abs() < 0.01 * l) {
        return false;
    }
    let a = [c[0] / l, c[1] / l, 0.0];
    normals.iter().all(|q| dot3(q.0, a).abs() < 0.01)
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
        eprintln!(
            "Dach: {} Flächen oben (alle {}), proj {pr:.2}, Normalen {:?}",
            top.len(),
            top_all.len(),
            top.iter().map(|p| ([p.n[0] as f32, p.n[1] as f32, p.n[2] as f32], p.area as f32)).collect::<Vec<_>>()
        );
    }
    if top.is_empty() || top.len() > 4 {
        return Err(R_ROOF_FORM);
    }
    let pts: Vec<V3> = top.iter().flat_map(|p| p.pts.iter().copied()).collect();
    let plan: Vec<V2> = pts.iter().map(|q| [q[0], q[1]]).collect();
    // Kleinstes umschliessendes Rechteck (auch gedreht); achsparallel bleibt achsparallel.
    let (d, u0, u1, v0, v1) = crate::ifc_semantic::min_area_rect(&plan).ok_or(R_ROOF_FORM)?;
    let n = [-d[1], d[0]];
    let eave_z = pts.iter().map(|q| q[2]).fold(f64::INFINITY, f64::min);
    let box_area = (u1 - u0) * (v1 - v0);
    // Projizierte Fläche der Dachflächen = Rechteck (ganz bedeckt, keine Doppelung).
    let projected: f64 = top.iter().map(|p| p.area * p.n[2]).sum();
    if !(box_area > 0.01 && (projected - box_area).abs() <= 0.03 * box_area) {
        return Err(R_ROOF_FORM);
    }
    let pitch = |p: &Plane| p.n[2].clamp(-1.0, 1.0).acos().to_degrees();
    let pitch_deg = pitch(top[0]);
    if top.iter().any(|p| (pitch(p) - pitch_deg).abs() > 0.3) {
        return Err(R_ROOF_FORM);
    }
    // Traufkante je Fläche aus der Steigrichtung (gegen die waagrechte Normale) im Rahmen.
    let flat = pitch_deg < 0.3;
    let mut eaves = [false; 4];
    if flat {
        if top.len() != 1 {
            return Err(R_ROOF_FORM);
        }
    } else {
        for p in &top {
            let (hx, hy) = (-p.n[0], -p.n[1]);
            let l = hx.hypot(hy);
            let (hu, hv) = ((hx * d[0] + hy * d[1]) / l, (hx * n[0] + hy * n[1]) / l);
            let k = if hv > 0.9995 {
                0
            } else if hu < -0.9995 {
                1
            } else if hv < -0.9995 {
                2
            } else if hu > 0.9995 {
                3
            } else {
                return Err(R_ROOF_FORM);
            };
            if eaves[k] {
                return Err(R_ROOF_FORM);
            }
            eaves[k] = true;
        }
    }
    // Dossier-Form: achsparallel die Standardformen (Pult steigt nur nach +x/+y), Walm und Flach auch
    // gedreht (folgen dem Umriss); sonst Satteldach mit Neigung je Kante (Giebel, wo keine Traufe ist).
    let aligned = d[0].abs() > 1.0 - 1e-9 || d[1].abs() > 1.0 - 1e-9;
    // Welt-Steigrichtung der Kante k: 0 = +n, 1 = −d, 2 = −n, 3 = +d; als „+x“/„+y“ …
    let world = |k: usize| -> V2 {
        match k {
            0 => n,
            1 => [-d[0], -d[1]],
            2 => [-n[0], -n[1]],
            _ => d,
        }
    };
    let rises: Vec<V2> = (0..4).filter(|&k| eaves[k]).map(world).collect();
    let is = |v: &V2, x: f64, y: f64| (v[0] - x).abs() < 1e-6 && (v[1] - y).abs() < 1e-6;
    let has = |x: f64, y: f64| rises.iter().any(|v| is(v, x, y));
    let longer_x = (d[0].abs() > 0.5) == (u1 - u0 >= v1 - v0);
    let count = rises.len();
    let standard: Option<(&'static str, &'static str)> = if flat {
        Some(("flach", if aligned && longer_x { "x" } else { "y" }))
    } else if count == 4 {
        Some(("walm", if !aligned || longer_x { "x" } else { "y" }))
    } else if !aligned {
        None
    } else if count == 1 && has(0.0, 1.0) {
        Some(("pult", "x"))
    } else if count == 1 && has(1.0, 0.0) {
        Some(("pult", "y"))
    } else if count == 2 && has(0.0, 1.0) && has(0.0, -1.0) {
        Some(("sattel", "x"))
    } else if count == 2 && has(1.0, 0.0) && has(-1.0, 0.0) {
        Some(("sattel", "y"))
    } else {
        None
    };
    let (shape, ridge_axis, edge_pitch) = match standard {
        Some((s, a)) => (s, a, None),
        None => {
            let axis = if (d[0].abs() >= d[1].abs()) == (u1 - u0 >= v1 - v0) { "x" } else { "y" };
            ("sattel", axis, Some([0, 1, 2, 3].map(|k| eaves[k].then_some(pitch_deg))))
        }
    };
    // Dicke: Abstand zur untersten Gegenfläche der grössten Dachfläche.
    let main = top.iter().max_by(|a, b| a.area.total_cmp(&b.area)).ok_or(R_ROOF_FORM)?;
    let thickness = bottom.iter().filter(|b| dot3(b.n, main.n) < -0.9999).map(|b| main.d + b.d).fold(f64::NAN, f64::max);
    if !(thickness > 0.01 && thickness <= 2.0) {
        return Err(R_ROOF_FORM);
    }
    let fit = RoofFit { d, rect: [u0, u1, v0, v1], eaves, shape, pitch_deg: if flat { 0.0 } else { pitch_deg }, ridge_axis, edge_pitch, eave_z, thickness };
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

/// Trittfläche einer Höhe: waagrechte Oberseiten (Belag über Rohbau zusammengefasst, die obere zählt).
#[derive(Clone, Debug)]
struct Level {
    z: f64,
    area: f64,
    /// Flächengewichteter Schwerpunkt im Grundriss.
    c: V2,
    pts: Vec<V2>,
}

/// Trittflächen aller Höhen (aufsteigend) und die Höhenausdehnung des Körpers.
fn stair_levels(tris: &[([V3; 3], V3, f64)]) -> (Vec<Level>, f64, f64) {
    let (mut z0, mut z1) = (f64::INFINITY, f64::NEG_INFINITY);
    for t in tris {
        for p in &t.0 {
            z0 = z0.min(p[2]);
            z1 = z1.max(p[2]);
        }
    }
    let mut levels: Vec<Level> = Vec::new();
    for (pts, _, a) in tris.iter().filter(|t| t.1[2] > 0.999) {
        let z = (pts[0][2] + pts[1][2] + pts[2][2]) / 3.0;
        let c = [(pts[0][0] + pts[1][0] + pts[2][0]) / 3.0, (pts[0][1] + pts[1][1] + pts[2][1]) / 3.0];
        let l = match levels.iter_mut().find(|l| (l.z - z).abs() <= 0.005) {
            Some(l) => l,
            None => {
                if levels.len() >= 400 {
                    return (Vec::new(), z0, z1);
                }
                levels.push(Level { z, area: 0.0, c: [0.0, 0.0], pts: Vec::new() });
                levels.last_mut().unwrap_or_else(|| unreachable!())
            }
        };
        l.c = [l.c[0] + c[0] * a, l.c[1] + c[1] * a];
        l.area += a;
        l.pts.extend(pts.iter().map(|p| [p[0], p[1]]));
    }
    for l in &mut levels {
        l.c = [l.c[0] / l.area, l.c[1] / l.area];
    }
    levels.retain(|l| l.z > z0 + 0.02 && l.area > 1e-4);
    levels.sort_by(|a, b| a.z.total_cmp(&b.z));
    let mut merged: Vec<Level> = Vec::new();
    for l in levels {
        match merged.last_mut() {
            // Belag: wenige cm über dem Rohbau-Tritt, fast an derselben Stelle.
            Some(m) if l.z - m.z < 0.08 && (l.c[0] - m.c[0]).hypot(l.c[1] - m.c[1]) < 0.08 => *m = l,
            _ => merged.push(l),
        }
    }
    // Kleine Flächen (Handlauf, Wangenkopf, Nasen) zählen nicht als Tritt.
    let mut areas: Vec<f64> = merged.iter().map(|l| l.area).collect();
    areas.sort_by(f64::total_cmp);
    let median = areas.get(areas.len() / 2).copied().unwrap_or(0.0);
    merged.retain(|l| l.area >= 0.3 * median);
    (merged, z0, z1)
}

/// Gleichmässige Steigung über alle Höhen (Podest zählt als Tritt); `None` sonst.
fn uniform_riser(levels: &[Level]) -> Option<f64> {
    let k = levels.len();
    if k < 3 {
        return None;
    }
    let h = (levels[k - 1].z - levels[0].z) / (k - 1) as f64;
    ((0.1..=0.4).contains(&h) && levels.iter().enumerate().all(|(i, l)| (l.z - (levels[0].z + h * i as f64)).abs() <= 0.012)).then_some(h)
}

/// Wendeltreppe: Zentrum, Lauflinie, Drehsinn.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct SpiralFit {
    pub center: V2,
    /// Radius der Lauflinie (Mitte der Laufbreite).
    pub radius: f64,
    pub width: f64,
    /// Winkel (rad) der Antrittskante (Anfang des ersten Tritts).
    pub a0: f64,
    /// Winkel je Stufe (rad), + = gegen den Uhrzeigersinn aufwärts.
    pub step: f64,
    pub riser: f64,
    pub treads: usize,
    pub z0: f64,
    pub top_is_exit: bool,
    /// Spindel (Radius), wenn der Körper eine senkrechte Mittelsäule hat.
    pub column: Option<f64>,
}

/// Kreis durch Punkte (algebraisch, Kåsa): Mittelpunkt und Radius.
fn fit_circle(p: &[V2]) -> Option<(V2, f64)> {
    let n = p.len() as f64;
    if n < 3.0 {
        return None;
    }
    // Schwerpunkt abziehen (Kondition).
    let (mx, my) = p.iter().fold((0.0, 0.0), |a, q| (a.0 + q[0] / n, a.1 + q[1] / n));
    let (mut suu, mut svv, mut suv, mut suuu, mut svvv, mut suvv, mut svuu) = (0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
    for q in p {
        let (u, v) = (q[0] - mx, q[1] - my);
        suu += u * u;
        svv += v * v;
        suv += u * v;
        suuu += u * u * u;
        svvv += v * v * v;
        suvv += u * v * v;
        svuu += v * u * u;
    }
    let det = suu * svv - suv * suv;
    if !(det.abs() > 1e-12) {
        return None;
    }
    let (b1, b2) = ((suuu + suvv) / 2.0, (svvv + svuu) / 2.0);
    let uc = (b1 * svv - b2 * suv) / det;
    let vc = (suu * b2 - suv * b1) / det;
    let r = (uc * uc + vc * vc + (suu + svv) / n).sqrt();
    (r.is_finite() && uc.is_finite() && vc.is_finite()).then_some(([mx + uc, my + vc], r))
}

/// Wendeltreppe aus den Körpern ihrer Teile: keilförmige Tritte um ein Zentrum, gleiche Steigung und
/// gleicher Winkel je Stufe, jeder Tritt über die ganze Laufbreite.
pub(crate) fn fit_spiral(meshes: &[Mesh]) -> Result<SpiralFit, &'static str> {
    let tris: Vec<_> = meshes.iter().flat_map(triangles).collect();
    let (mut levels, z_lo, z_hi) = stair_levels(&tris);
    // Oberste Fläche ausser Takt (Spindelkopf, Austrittspodest): ohne sie versuchen.
    if uniform_riser(&levels).is_none() && levels.len() > 4 {
        levels.pop();
    }
    let riser = uniform_riser(&levels).ok_or(R_STAIR_FORM)?;
    let k = levels.len();
    if k < 4 {
        return Err(R_STAIR_FORM);
    }
    let cs: Vec<V2> = levels.iter().map(|l| l.c).collect();
    let (center, rc) = fit_circle(&cs).ok_or(R_STAIR_FORM)?;
    if !(0.2..=6.0).contains(&rc) || cs.iter().any(|c| ((c[0] - center[0]).hypot(c[1] - center[1]) - rc).abs() > 0.03) {
        return Err(R_STAIR_FORM);
    }
    // Winkel der Schwerpunkte fortlaufend (ohne Sprung bei ±π), linear in der Stufennummer.
    let mut ang: Vec<f64> = Vec::with_capacity(k);
    for c in &cs {
        let a = (c[1] - center[1]).atan2(c[0] - center[0]);
        let a = match ang.last() {
            Some(&p) => p + (a - p + std::f64::consts::PI).rem_euclid(std::f64::consts::TAU) - std::f64::consts::PI,
            None => a,
        };
        ang.push(a);
    }
    let step = (ang[k - 1] - ang[0]) / (k - 1) as f64;
    if !((3f64.to_radians()..=45f64.to_radians()).contains(&step.abs())) || ang.iter().enumerate().any(|(i, a)| (a - (ang[0] + step * i as f64)).abs() > 1.5f64.to_radians()) {
        return Err(R_STAIR_FORM);
    }
    // Laufbreite: jeder Tritt reicht vom Innen- zum Aussenradius.
    let radii = |l: &Level| l.pts.iter().map(|p| (p[0] - center[0]).hypot(p[1] - center[1])).fold((f64::INFINITY, 0.0f64), |(lo, hi), r| (lo.min(r), hi.max(r)));
    let spans: Vec<(f64, f64)> = levels.iter().map(radii).collect();
    let r_in = spans.iter().map(|s| s.0).fold(f64::INFINITY, f64::min);
    let r_out = spans.iter().map(|s| s.1).fold(0.0, f64::max);
    if spans.iter().any(|s| s.0 > r_in + 0.03 || s.1 < r_out - 0.03) || !(r_out - r_in >= 0.4 && r_out <= 6.0) {
        return Err(R_STAIR_FORM);
    }
    // Spindel: senkrechte Flächen innerhalb des Innenradius, ringsum (12 Sektoren) über den grössten
    // Teil der Höhe.
    let mut col_r = 0.0f64;
    let mut bins = [(f64::INFINITY, f64::NEG_INFINITY); 12];
    for (pts, n, _) in &tris {
        if n[2].abs() > 0.05 {
            continue;
        }
        let rmax = pts.iter().map(|p| (p[0] - center[0]).hypot(p[1] - center[1])).fold(0.0f64, f64::max);
        if rmax <= r_in + 0.01 {
            col_r = col_r.max(rmax);
            for p in pts {
                let a = (p[1] - center[1]).atan2(p[0] - center[0]).rem_euclid(std::f64::consts::TAU);
                let b = &mut bins[((a / std::f64::consts::TAU * 12.0) as usize).min(11)];
                *b = (b.0.min(p[2]), b.1.max(p[2]));
            }
        }
    }
    let around = bins.iter().all(|b| b.1 - b.0 >= 0.5 * (z_hi - z_lo));
    let column = (col_r > 0.01 && around).then_some(col_r);
    // Dossier-Wendel: Innenradius ≥ 0.1 (Lauflinie ≥ halbe Breite + 0.1).
    let r_in = r_in.max(column.unwrap_or(0.0)).max(0.1);
    let top_is_exit = (z_hi - levels[k - 1].z).abs() <= 0.03;
    Ok(SpiralFit { center, radius: (r_in + r_out) / 2.0, width: r_out - r_in, a0: ang[0] - step / 2.0, step, riser, treads: k, z0: levels[0].z - riser, top_is_exit, column })
}

/// Lauf einer Treppe aus seinen Tritten (mindestens zwei): Richtung aufwärts, Auftritt, Breite, Lage.
#[derive(Clone, Debug)]
struct Run {
    dir: V2,
    going: f64,
    width: f64,
    /// Vorderkante des ersten Tritts entlang `dir` (Skalar).
    front: f64,
    /// Mitte quer zur Laufrichtung (Skalar entlang `left(dir)`).
    mid: f64,
}

fn run_of(levels: &[Level]) -> Option<Run> {
    let k = levels.len();
    if k < 2 {
        return None;
    }
    let (a, b) = (levels[0].c, levels[k - 1].c);
    let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
    let l = dx.hypot(dy);
    if !(l > 1e-6) {
        return None;
    }
    let d = [dx / l, dy / l];
    let n = [-d[1], d[0]];
    let going = l / (k - 1) as f64;
    if !(0.15..=0.45).contains(&going) {
        return None;
    }
    let ext = |l: &Level, ax: V2| l.pts.iter().map(|p| p[0] * ax[0] + p[1] * ax[1]).fold((f64::INFINITY, f64::NEG_INFINITY), |(lo, hi), u| (lo.min(u), hi.max(u)));
    let fronts: Vec<f64> = levels.iter().map(|l| ext(l, d).0).collect();
    let (mut v0, mut v1) = (f64::INFINITY, f64::NEG_INFINITY);
    for l in levels {
        let (lo, hi) = ext(l, n);
        // Alle Tritte über dieselbe Breite.
        if v0.is_finite() && ((lo - v0).abs() > 0.03 || (hi - v1).abs() > 0.03) {
            return None;
        }
        v0 = v0.min(lo);
        v1 = v1.max(hi);
    }
    if fronts.iter().enumerate().any(|(i, f)| (f - (fronts[0] + going * i as f64)).abs() > 0.03) || !(0.4..=6.0).contains(&(v1 - v0)) {
        return None;
    }
    Some(Run { dir: d, going, width: v1 - v0, front: fronts[0], mid: (v0 + v1) / 2.0 })
}

/// L-Treppe (Dossier: zwei rechtwinklige Läufe gleicher Breite, quadratisches Podest an der Ecke).
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct LFit {
    /// Mitte der Antrittskante.
    pub start: V2,
    pub dir: V2,
    pub width: f64,
    /// Tritte im ersten bzw. zweiten Lauf (ohne Podest).
    pub n1: usize,
    pub n2: usize,
    pub going1: f64,
    pub going2: f64,
    pub riser: f64,
    /// +1 = zweiter Lauf links, −1 = rechts.
    pub turn: f64,
    pub z0: f64,
    pub top_is_exit: bool,
}

/// Grund: Podesttreppe mit Wende, die Dossier nicht abbildet (U, mehrere Podeste, Podest nicht an der Ecke).
pub(crate) const R_STAIR_TURN: &str = "stairTurn";

/// L-Treppe aus den Körpern ihrer Teile; eine Podesttreppe anderer Form gibt [`R_STAIR_TURN`].
pub(crate) fn fit_l_stair(meshes: &[Mesh]) -> Result<LFit, &'static str> {
    let tris: Vec<_> = meshes.iter().flat_map(triangles).collect();
    let (levels, _, z_hi) = stair_levels(&tris);
    let k = levels.len();
    if k < 4 {
        return Err(R_STAIR_FORM);
    }
    let mut areas: Vec<f64> = levels.iter().map(|l| l.area).collect();
    areas.sort_by(f64::total_cmp);
    let median = areas[k / 2];
    let landings: Vec<usize> = (0..k).filter(|&i| levels[i].area >= 2.0 * median).collect();
    // Podest = grosse Fläche zwischen zwei Läufen (der oberste/unterste Tritt kann ein Austritt sein).
    let inner: Vec<usize> = landings.iter().copied().filter(|&i| i > 0 && i + 1 < k).collect();
    #[cfg(test)]
    if std::env::var("DOSSIER_IFC_DEBUG").is_ok() {
        eprintln!("L-Treppe: Ebenen {:?}, Podeste {landings:?}", levels.iter().map(|l| (l.z as f32, l.area as f32, l.c[0] as f32, l.c[1] as f32)).collect::<Vec<_>>());
    }
    if inner.is_empty() {
        return Err(R_STAIR_FORM);
    }
    if inner.len() > 1 {
        return Err(R_STAIR_TURN);
    }
    let li = inner[0];
    let top = if landings.contains(&(k - 1)) && k - 1 > li + 1 { k - 1 } else { k };
    let riser = uniform_riser(&levels[..top]).ok_or(R_STAIR_TURN)?;
    let (Some(r1), Some(r2)) = (run_of(&levels[..li]), run_of(&levels[li + 1..top])) else { return Err(R_STAIR_TURN) };
    let n1 = [-r1.dir[1], r1.dir[0]];
    let cross = r1.dir[0] * r2.dir[1] - r1.dir[1] * r2.dir[0];
    if (r1.dir[0] * r2.dir[0] + r1.dir[1] * r2.dir[1]).abs() > 0.02 || (r1.width - r2.width).abs() > 0.03 {
        return Err(R_STAIR_TURN);
    }
    let w = (r1.width + r2.width) / 2.0;
    let (g1, g2) = (r1.going, r2.going);
    let n_1 = li;
    let n_2 = top - li - 1;
    // Dossier: Podest = Quadrat w × w am Ende des ersten Laufs (Länge n1·Auftritt), zweiter Lauf mittig daran.
    let start = [r1.dir[0] * r1.front + n1[0] * r1.mid, r1.dir[1] * r1.front + n1[1] * r1.mid];
    let run1 = n_1 as f64 * g1;
    let corner = [start[0] + r1.dir[0] * (run1 + w / 2.0), start[1] + r1.dir[1] * (run1 + w / 2.0)];
    let n2 = [-r2.dir[1], r2.dir[0]];
    let dot = |a: V2, b: V2| a[0] * b[0] + a[1] * b[1];
    if (dot(corner, n2) - r2.mid).abs() > 0.04 || (dot(corner, r2.dir) + w / 2.0 - r2.front).abs() > 0.04 {
        return Err(R_STAIR_TURN);
    }
    let land = &levels[li];
    let (mut u0, mut u1, mut v0, mut v1) = (f64::INFINITY, f64::NEG_INFINITY, f64::INFINITY, f64::NEG_INFINITY);
    for p in &land.pts {
        let (u, v) = (dot(*p, r1.dir), dot(*p, n1));
        u0 = u0.min(u);
        u1 = u1.max(u);
        v0 = v0.min(v);
        v1 = v1.max(v);
    }
    let ue = r1.front + run1;
    if (u0 - ue).abs() > 0.05 || (u1 - ue - w).abs() > 0.05 || (v0 - (r1.mid - w / 2.0)).abs() > 0.05 || (v1 - (r1.mid + w / 2.0)).abs() > 0.05 {
        return Err(R_STAIR_TURN);
    }
    // Ein Austrittspodest oben ist kein Tritt des zweiten Laufs: der Austritt kommt dazu.
    let top_is_exit = top == k && (z_hi - levels[k - 1].z).abs() <= 0.03;
    Ok(LFit { start, dir: r1.dir, width: w, n1: n_1, n2: n_2, going1: g1, going2: g2, riser, turn: cross.signum(), z0: levels[0].z - riser, top_is_exit })
}

/// [151] Podesttreppe ohne Ecke: U (Wende um 180°, Halbpodest oder zwei Viertelpodeste mit Mittellauf
/// quer über das Auge) oder gerade mit Zwischenpodest. Masse im System des ersten Laufs.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct TurnFit {
    /// "U" oder "straightLanding".
    pub shape: &'static str,
    /// Mitte der Antrittskante.
    pub start: V2,
    pub dir: V2,
    pub width: f64,
    /// Tritte im ersten Lauf, im Mittellauf (0 = Halbpodest) und im letzten Lauf (ohne Podeste).
    pub n1: usize,
    pub n_mid: usize,
    pub n2: usize,
    pub going1: f64,
    pub going2: f64,
    pub riser: f64,
    /// U: +1 = letzter Lauf links, −1 = rechts.
    pub turn: f64,
    /// U: lichte Weite des Treppenauges.
    pub gap: f64,
    /// Podesttiefe in Laufrichtung (Lauf 1).
    pub landing: f64,
    /// U: Versatz des letzten Laufs ins Podest hinein (entlang Lauf 1).
    pub offset: f64,
    pub z0: f64,
    pub top_is_exit: bool,
}

/// U-Treppe bzw. gerade Treppe mit Zwischenpodest aus den Körpern ihrer Teile. Trittflächen ausser
/// Takt (Wangen-, Rahmen-, Belagstücke zwischen den Steigungen) zählen nicht; jedes Podest belegt eine
/// Steigung. Andere Podesttreppen (Ecke ausserhalb L, drei und mehr Podeste) ergeben [`R_STAIR_TURN`].
pub(crate) fn fit_turn_stair(meshes: &[Mesh]) -> Result<TurnFit, &'static str> {
    let tris: Vec<_> = meshes.iter().flat_map(triangles).collect();
    let (levels, _, z_hi) = stair_levels(&tris);
    if levels.len() < 5 {
        return Err(R_STAIR_FORM);
    }
    // Steigung: Median der Höhenschritte über 6 cm; dann nur Flächen im Takt der Steigung.
    let mut diffs: Vec<f64> = levels.windows(2).map(|w| w[1].z - w[0].z).filter(|d| *d > 0.06).collect();
    if diffs.len() < 3 {
        return Err(R_STAIR_FORM);
    }
    diffs.sort_by(f64::total_cmp);
    let h0 = diffs[diffs.len() / 2];
    let z_first = levels[0].z;
    let levels: Vec<Level> = levels
        .into_iter()
        .filter(|l| {
            let q = (l.z - z_first) / h0;
            (q - q.round()).abs() <= 0.05
        })
        .collect();
    let k = levels.len();
    if k < 5 {
        return Err(R_STAIR_FORM);
    }
    let mut areas: Vec<f64> = levels.iter().map(|l| l.area).collect();
    areas.sort_by(f64::total_cmp);
    let median = areas[k / 2];
    let landings: Vec<usize> = (0..k).filter(|&i| levels[i].area >= 2.0 * median).collect();
    let inner: Vec<usize> = landings.iter().copied().filter(|&i| i > 0 && i + 1 < k).collect();
    let Some(&li_last) = inner.last() else { return Err(R_STAIR_FORM) };
    // Austrittspodest oben (grosse Fläche nach dem letzten Lauf) ist kein Tritt.
    let top = if landings.contains(&(k - 1)) && k - 1 > li_last + 1 { k - 1 } else { k };
    let inner: Vec<usize> = inner.into_iter().filter(|&i| i + 1 < top).collect();
    if inner.is_empty() || inner.len() > 2 {
        return Err(R_STAIR_TURN);
    }
    let riser = uniform_riser(&levels[..top]).ok_or(R_STAIR_TURN)?;
    // Läufe zwischen den Podesten (je mindestens zwei Tritte).
    let mut bounds = vec![0];
    for &i in &inner {
        bounds.push(i);
        bounds.push(i + 1);
    }
    bounds.push(top);
    let runs: Vec<Run> = bounds.chunks(2).map(|b| run_of(&levels[b[0]..b[1]])).collect::<Option<_>>().ok_or(R_STAIR_TURN)?;
    let dot = |a: V2, b: V2| a[0] * b[0] + a[1] * b[1];
    let (r1, rl) = (&runs[0], &runs[runs.len() - 1]);
    let u = r1.dir;
    let n = [-u[1], u[0]];
    if (r1.width - rl.width).abs() > 0.03 {
        return Err(R_STAIR_TURN);
    }
    let w = (r1.width + rl.width) / 2.0;
    let hw = w / 2.0;
    let n1 = inner[0];
    let n2 = top - inner[inner.len() - 1] - 1;
    let start = [u[0] * r1.front + n[0] * r1.mid, u[1] * r1.front + n[1] * r1.mid];
    let e1 = r1.front + n1 as f64 * r1.going;
    // Ausdehnung eines Podests im System von Lauf 1 (u längs, v quer).
    let extent = |l: &Level| {
        l.pts.iter().fold((f64::INFINITY, f64::NEG_INFINITY, f64::INFINITY, f64::NEG_INFINITY), |(a, b, c, d), p| {
            let (pu, pv) = (dot(*p, u), dot(*p, n));
            (a.min(pu), b.max(pu), c.min(pv), d.max(pv))
        })
    };
    let (u0, u1, v0, v1) = extent(&levels[inner[0]]);
    if (u0 - e1).abs() > 0.05 {
        return Err(R_STAIR_TURN);
    }
    let z0 = levels[0].z - riser;
    let top_is_exit = top == k && (z_hi - levels[k - 1].z).abs() <= 0.03;
    let fit = |shape, turn, gap, landing, offset, n_mid| TurnFit {
        shape,
        start,
        dir: u,
        width: w,
        n1,
        n_mid,
        n2,
        going1: r1.going,
        going2: rl.going,
        riser,
        turn,
        gap,
        landing,
        offset,
        z0,
        top_is_exit,
    };
    let same_dir = dot(u, rl.dir);
    if inner.len() == 1 && same_dir > 0.98 {
        // Gerade mit Zwischenpodest: gleiche Achse, Podest zwischen den Läufen über die Laufbreite.
        let landing = rl.front - e1;
        let ok = (rl.mid - r1.mid).abs() <= 0.03 && landing >= 0.1 && (u1 - rl.front).abs() <= 0.05 && (v0 - (r1.mid - hw)).abs() <= 0.05 && (v1 - (r1.mid + hw)).abs() <= 0.05;
        return if ok { Ok(fit("straightLanding", 0.0, 0.0, landing, 0.0, 0)) } else { Err(R_STAIR_TURN) };
    }
    if same_dir > -0.98 {
        return Err(R_STAIR_TURN);
    }
    // U: letzter Lauf gegenläufig daneben (Mitte im System von Lauf 1: −rl.mid, da links(−u) = −n).
    let side = -rl.mid - r1.mid;
    let turn = side.signum();
    let off = side.abs();
    let gap = (off - w).max(0.0);
    if off - w < -0.02 {
        return Err(R_STAIR_TURN);
    }
    // Lage im System „Wendeseite“: v' = (v − Mitte Lauf 1)·turn.
    let vs = |a: f64, b: f64| {
        let (p, q) = ((a - r1.mid) * turn, (b - r1.mid) * turn);
        (p.min(q), p.max(q))
    };
    // Antritt des letzten Laufs entlang u (Vorderkante liegt bei −front, da er in −u läuft).
    let offset = -rl.front - e1;
    if inner.len() == 1 {
        let landing = u1 - e1;
        let (a, b) = vs(v0, v1);
        let ok = landing >= 0.3 && offset >= -(n1 as f64) * r1.going - 0.05 && offset <= landing + 0.05 && (a + hw).abs() <= 0.05 && (b - (off + hw)).abs() <= 0.05;
        return if ok { Ok(fit("U", turn, gap, landing, offset, 0)) } else { Err(R_STAIR_TURN) };
    }
    // Zwei Viertelpodeste, Mittellauf quer über das Auge zur Wendeseite.
    let rm = &runs[1];
    let n_mid = inner[1] - inner[0] - 1;
    let (_, u1b, _, _) = extent(&levels[inner[1]]);
    let landing = u1.max(u1b) - e1;
    let td_mid = r1.going.min(gap / n_mid as f64);
    let ext = (gap - n_mid as f64 * td_mid).max(0.0) / 2.0;
    let mid_u = e1 + landing.max(w) - hw;
    let side_dir = [n[0] * turn, n[1] * turn];
    // Mittellauf: Richtung zur Wendeseite, Auftritt wie Dossier, mittig auf der Wende-Lauflinie, Antritt am Auge.
    let rm_center_u = -rm.mid * turn; // links(side) = −u·turn … Mitte quer zum Mittellauf = Lage entlang u
    let ok = dot(rm.dir, side_dir) > 0.98
        && (rm.width - w).abs() <= 0.03
        && (rm.going - td_mid).abs() <= 0.03
        && (rm_center_u - mid_u).abs() <= 0.06
        && ((rm.front - dot(start, side_dir)) - (hw + ext)).abs() <= 0.12
        && landing >= w - 0.05
        && offset.abs() <= 0.05;
    if ok {
        Ok(fit("U", turn, gap, landing, 0.0, n_mid))
    } else {
        Err(R_STAIR_TURN)
    }
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
        assert_eq!(f.outline(), [[0.0, 0.0], [10.0, 0.0], [10.0, 8.0], [0.0, 8.0]]);
        assert_eq!(f.edge_pitch, None);
        assert!((f.top_at(5.0, 4.0) - (3.0 + 4.0 * tan)).abs() < 1e-9);
        // Eine Platte allein: Pultdach steigt nach +y.
        let p = fit_roof(&[a.clone()]).unwrap();
        assert_eq!((p.shape, p.ridge_axis, p.edge_pitch), ("pult", "x", None));
        // Fallend nach +y (Dossier-Pult steigt nur nach +x/+y): Satteldach mit Traufe an y = 8, sonst Giebel.
        let c = plate(0.0, 10.0, 8.0, 4.0, 3.0, 3.0 + 4.0 * tan, 0.2);
        let f = fit_roof(&[c]).unwrap();
        assert_eq!(f.shape, "sattel");
        let ep = f.edge_pitch.unwrap();
        let o = f.outline();
        let eave = (0..4).find(|&i| ep[i].is_some()).unwrap();
        assert_eq!(ep.iter().filter(|e| e.is_some()).count(), 1);
        assert!((ep[eave].unwrap() - 30.0).abs() < 1e-6 && (o[eave][1] - 8.0).abs() < 1e-9 && (o[(eave + 1) % 4][1] - 8.0).abs() < 1e-9, "{f:?}");
        // Ungleiche Neigung: kein Satteldach.
        let b = plate(0.0, 10.0, 8.0, 4.0, 3.0, 3.0 + 3.0 * tan, 0.2);
        assert!(fit_roof(&[a, b]).is_err());
    }

    /// Netz um den Ursprung gedreht (Grundriss, Winkel in Grad).
    fn rotated(mut m: Mesh, deg: f64) -> Mesh {
        let (s, c) = deg.to_radians().sin_cos();
        for p in m.positions.chunks_exact_mut(3) {
            let (x, y) = (p[0], p[1]);
            p[0] = c * x - s * y;
            p[1] = s * x + c * y;
        }
        m
    }

    #[test]
    fn rotated_saddle_and_hip_roof() {
        // Satteldach wie oben, um 30° gedreht: Satteldach mit Neigung je Kante (Giebel an den Stirnseiten).
        let tan = 30f64.to_radians().tan();
        let a = rotated(plate(0.0, 10.0, 0.0, 4.0, 3.0, 3.0 + 4.0 * tan, 0.2), 30.0);
        let b = rotated(plate(0.0, 10.0, 8.0, 4.0, 3.0, 3.0 + 4.0 * tan, 0.2), 30.0);
        let f = fit_roof(&[a, b]).unwrap();
        assert_eq!(f.shape, "sattel");
        let ep = f.edge_pitch.unwrap();
        let o = f.outline();
        for i in 0..4 {
            let (p, q) = (o[i], o[(i + 1) % 4]);
            let long = ((q[0] - p[0]).hypot(q[1] - p[1]) - 10.0).abs() < 1e-6;
            assert_eq!(ep[i].is_some(), long, "Kante {i}: {f:?}");
        }
        let (s, c) = 30f64.to_radians().sin_cos();
        let ridge_mid = [5.0 * c - 4.0 * s, 5.0 * s + 4.0 * c];
        assert!((f.top_at(ridge_mid[0], ridge_mid[1]) - (3.0 + 4.0 * tan)).abs() < 1e-6);
        let area: f64 = (0..4).map(|i| o[i][0] * o[(i + 1) % 4][1] - o[(i + 1) % 4][0] * o[i][1]).sum::<f64>() / 2.0;
        assert!((area - 80.0).abs() < 1e-6, "{area}");
        // Gedrehtes Pultdach (eine Platte): Traufe an einer langen Kante, drei Giebel.
        let p = fit_roof(&[rotated(plate(0.0, 10.0, 0.0, 4.0, 3.0, 3.0 + 4.0 * tan, 0.2), 30.0)]).unwrap();
        assert_eq!((p.shape, p.edge_pitch.unwrap().iter().filter(|e| e.is_some()).count()), ("sattel", 1));
        // Flachdach gedreht: bleibt Flachdach mit gedrehtem Umriss.
        let mut m = Mesh::default();
        quad(&mut m, [[0.0, 0.0, 3.3], [4.0, 0.0, 3.3], [4.0, 2.0, 3.3], [0.0, 2.0, 3.3]]);
        quad(&mut m, [[0.0, 2.0, 3.0], [4.0, 2.0, 3.0], [4.0, 0.0, 3.0], [0.0, 0.0, 3.0]]);
        let f = fit_roof(&[rotated(m, 20.0)]).unwrap();
        assert_eq!((f.shape, f.edge_pitch), ("flach", None));
        assert!((f.d[1] / f.d[0] - 20f64.to_radians().tan()).abs() < 1e-9, "{f:?}");
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
        let r = RoofFit {
            d: [1.0, 0.0],
            rect: [0.0, 10.0, 0.0, 8.0],
            eaves: [true, false, true, false],
            shape: "sattel",
            pitch_deg: 45.0,
            ridge_axis: "x",
            edge_pitch: None,
            eave_z: 3.0,
            thickness: 0.2,
        };
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

    /// Senkrechtes Prisma über dem konvexen Ring (gegen den Uhrzeigersinn) von z0 bis z1.
    fn block(m: &mut Mesh, ring: &[V2], z0: f64, z1: f64) {
        let b = m.positions.len() as u32 / 3;
        let n = ring.len() as u32;
        for z in [z0, z1] {
            for p in ring {
                m.positions.extend_from_slice(&[p[0], p[1], z]);
            }
        }
        for i in 1..n - 1 {
            m.indices.extend_from_slice(&[b, b + i + 1, b + i]);
            m.indices.extend_from_slice(&[b + n, b + n + i, b + n + i + 1]);
        }
        for i in 0..n {
            let j = (i + 1) % n;
            m.indices.extend_from_slice(&[b + i, b + j, b + n + j, b + i, b + n + j, b + n + i]);
        }
    }

    fn wedge(c: V2, r0: f64, r1: f64, a: f64, b: f64) -> Vec<V2> {
        let mut ring = vec![[c[0] + r0 * a.cos(), c[1] + r0 * a.sin()]];
        for k in 0..=4 {
            let t = a + (b - a) * k as f64 / 4.0;
            ring.push([c[0] + r1 * t.cos(), c[1] + r1 * t.sin()]);
        }
        ring.push([c[0] + r0 * b.cos(), c[1] + r0 * b.sin()]);
        ring
    }

    #[test]
    fn spiral_stair_with_center_column() {
        // 12 Keile à 25° gegen den Uhrzeigersinn ab 10°, Radien 0.3 … 1.3 um (2, 3), Steigung 0.18; Spindel
        // r = 0.3 bis 2.4 hoch. Der oberste Tritt (2.16) ist nicht die höchste Stelle → Austritt kommt dazu.
        let c = [2.0, 3.0];
        let mut m = Mesh::default();
        for i in 0..12 {
            let (a, b) = ((10.0 + 25.0 * i as f64).to_radians(), (10.0 + 25.0 * (i + 1) as f64).to_radians());
            block(&mut m, &wedge(c, 0.3, 1.3, a, b), 0.18 * i as f64, 0.18 * (i + 1) as f64);
        }
        let col: Vec<V2> = (0..16).map(|k| std::f64::consts::TAU * k as f64 / 16.0).map(|t| [c[0] + 0.3 * t.cos(), c[1] + 0.3 * t.sin()]).collect();
        block(&mut m, &col, 0.0, 2.4);
        assert!(fit_stair(&[m.clone()]).is_err());
        let s = fit_spiral(&[m]).unwrap();
        assert!((s.center[0] - 2.0).abs() < 1e-3 && (s.center[1] - 3.0).abs() < 1e-3, "{s:?}");
        assert!((s.step.to_degrees() - 25.0).abs() < 0.01 && (s.a0.to_degrees() - 10.0).abs() < 0.05, "{s:?}");
        assert!((s.riser - 0.18).abs() < 1e-9 && s.treads == 12 && s.z0.abs() < 1e-9 && !s.top_is_exit);
        assert!((s.radius - 0.8).abs() < 1e-3 && (s.width - 1.0).abs() < 1e-3, "{s:?}");
        assert!((s.column.unwrap() - 0.3).abs() < 1e-3);
        // Im Uhrzeigersinn, ohne Spindel.
        let mut m = Mesh::default();
        for i in 0..8 {
            let (a, b) = ((-30.0 * i as f64).to_radians(), (-30.0 * (i + 1) as f64).to_radians());
            block(&mut m, &wedge([0.0, 0.0], 0.15, 1.1, b, a), 0.0, 0.17 * (i + 1) as f64);
        }
        let s = fit_spiral(&[m]).unwrap();
        assert!((s.step.to_degrees() + 30.0).abs() < 0.01 && s.a0.abs() < 1e-3 && s.column.is_none() && s.top_is_exit, "{s:?}");
    }

    #[test]
    fn l_stair_and_u_stair() {
        // L: 4 Tritte (0.28 × 1.0, Steigung 0.17) in +x ab x = 1, Mitte y = 2; Podest 1 × 1 auf 5·0.17;
        // 4 Tritte links herum (+y) ab y = 2.5, Mitte x = 2.62.
        let mut m = Mesh::default();
        let h = 0.17;
        for i in 0..4 {
            let (x0, x1) = (1.0 + 0.28 * i as f64, 1.0 + 0.28 * (i + 1) as f64);
            block(&mut m, &[[x0, 1.5], [x1, 1.5], [x1, 2.5], [x0, 2.5]], 0.0, h * (i + 1) as f64);
        }
        block(&mut m, &[[2.12, 1.5], [3.12, 1.5], [3.12, 2.5], [2.12, 2.5]], 0.0, 5.0 * h);
        for i in 0..4 {
            let (y0, y1) = (2.5 + 0.28 * i as f64, 2.5 + 0.28 * (i + 1) as f64);
            block(&mut m, &[[2.12, y0], [3.12, y0], [3.12, y1], [2.12, y1]], 0.0, h * (6 + i) as f64);
        }
        assert!(fit_stair(&[m.clone()]).is_err() && fit_spiral(&[m.clone()]).is_err());
        let l = fit_l_stair(&[m]).unwrap();
        assert!((l.start[0] - 1.0).abs() < 1e-9 && (l.start[1] - 2.0).abs() < 1e-9 && (l.dir[0] - 1.0).abs() < 1e-9, "{l:?}");
        assert!((l.width - 1.0).abs() < 1e-9 && (l.going1 - 0.28).abs() < 1e-9 && (l.going2 - 0.28).abs() < 1e-9);
        assert_eq!((l.n1, l.n2, l.turn, l.top_is_exit), (4, 4, 1.0, true));
        assert!((l.riser - h).abs() < 1e-9 && l.z0.abs() < 1e-9);
        // U (Wende um 180°, Läufe nebeneinander): Podesttreppe, die Dossier nicht abbildet.
        let mut m = Mesh::default();
        for i in 0..4 {
            let (x0, x1) = (1.0 + 0.28 * i as f64, 1.0 + 0.28 * (i + 1) as f64);
            block(&mut m, &[[x0, 1.5], [x1, 1.5], [x1, 2.5], [x0, 2.5]], 0.0, h * (i + 1) as f64);
        }
        block(&mut m, &[[2.12, 1.5], [3.12, 1.5], [3.12, 3.5], [2.12, 3.5]], 0.0, 5.0 * h);
        for i in 0..4 {
            let (x1, x0) = (2.12 - 0.28 * i as f64, 2.12 - 0.28 * (i + 1) as f64);
            block(&mut m, &[[x0, 2.5], [x1, 2.5], [x1, 3.5], [x0, 3.5]], 0.0, h * (6 + i) as f64);
        }
        assert_eq!(fit_l_stair(&[m.clone()]), Err(R_STAIR_TURN));
        // [151] … als Dossier-U: Halbpodest 1 m tief über beide Läufe (Auge 0), Gegenlauf links.
        let u = fit_turn_stair(&[m]).unwrap();
        assert_eq!((u.shape, u.n1, u.n_mid, u.n2, u.turn, u.top_is_exit), ("U", 4, 0, 4, 1.0, true));
        assert!((u.start[0] - 1.0).abs() < 1e-9 && (u.start[1] - 2.0).abs() < 1e-9 && (u.width - 1.0).abs() < 1e-9, "{u:?}");
        assert!(u.gap.abs() < 1e-9 && (u.landing - 1.0).abs() < 1e-9 && u.offset.abs() < 1e-9 && (u.riser - h).abs() < 1e-9);
    }

    /// [151] Treppe aus Tritt-Blöcken: Läufe als (Antritt, Richtung, Tritte), Podeste als Rechtecke; jede
    /// Fläche eine Steigung höher; dazu Flächen ausser Takt (Wangenstücke).
    fn flight_blocks(runs: &[(V2, V2, usize, f64)], landings: &[[V2; 2]], width: f64, h: f64) -> Mesh {
        let mut m = Mesh::default();
        let mut z = 0.0;
        for (k, (s, d, n, g)) in runs.iter().enumerate() {
            let nl = [-d[1], d[0]];
            for i in 0..*n {
                let at = |a: f64, b: f64| [s[0] + d[0] * a + nl[0] * b, s[1] + d[1] * a + nl[1] * b];
                let (a0, a1) = (g * i as f64, g * (i + 1) as f64);
                z += h;
                block(&mut m, &[at(a0, -width / 2.0), at(a1, -width / 2.0), at(a1, width / 2.0), at(a0, width / 2.0)], 0.0, z);
            }
            if let Some([p, q]) = landings.get(k) {
                z += h;
                block(&mut m, &[[p[0], p[1]], [q[0], p[1]], [q[0], q[1]], [p[0], q[1]]], z - 0.2, z);
                // Wangenstück ausser Takt (0.4 Steigungen über dem Podest)
                block(&mut m, &[[p[0], p[1]], [p[0] + 0.3, p[1]], [p[0] + 0.3, p[1] + 0.3], [p[0], p[1] + 0.3]], 0.0, z + 0.4 * h);
            }
        }
        m
    }

    #[test]
    fn u_stair_half_landing_offset_and_two_quarter_landings() {
        let h = 0.17;
        // Halbpodest, Gegenlauf um einen Auftritt ins Podest versetzt (Smiley-West-Art), Rechtswendung:
        // Lauf 1 in +y ab (5, 0), 6 × 0.28; Podest y 1.68 … 3.0, x 4.4 … 6.9 (Auge 0.1); Lauf 2 in −y bei
        // x = 6.3, Antritt bei y = 1.96 (ein Auftritt im Podest).
        let m = flight_blocks(
            &[([5.0, 0.0], [0.0, 1.0], 6, 0.28), ([6.3, 1.96], [0.0, -1.0], 6, 0.28)],
            &[[[4.4, 1.68], [6.9, 3.0]]],
            1.2,
            h,
        );
        // Podest mit ausgeklinkter Ecke (Gegenlauf-Antritt): Fläche als Rechteck stört die Kanten nicht.
        let u = fit_turn_stair(&[m]).unwrap();
        assert_eq!((u.shape, u.n1, u.n_mid, u.n2, u.turn), ("U", 6, 0, 6, -1.0), "{u:?}");
        assert!((u.start[0] - 5.0).abs() < 1e-9 && u.start[1].abs() < 1e-9 && (u.width - 1.2).abs() < 1e-9);
        assert!((u.gap - 0.1).abs() < 1e-9 && (u.landing - 1.32).abs() < 1e-9 && (u.offset - 0.28).abs() < 1e-9, "{u:?}");
        // Zwei Viertelpodeste (Institute-Art): Lauf 1 +y bei x = 0 (7 Tritte), Podest 1, Mittellauf +x
        // (4 Tritte, mittig im Auge 1.6), Podest 2, Lauf 3 −y bei x = 2.8 (5 Tritte).
        let g = 0.3;
        let m = flight_blocks(
            &[([0.0, 0.0], [0.0, 1.0], 7, g), ([0.6 + 0.2, 2.7], [1.0, 0.0], 4, g), ([2.8, 2.1], [0.0, -1.0], 5, g)],
            &[[[-0.6, 2.1], [0.8, 3.3]], [[2.0, 2.1], [3.4, 3.3]]],
            1.2,
            h,
        );
        let u = fit_turn_stair(&[m]).unwrap();
        assert_eq!((u.shape, u.n1, u.n_mid, u.n2, u.turn), ("U", 7, 4, 5, -1.0), "{u:?}");
        assert!((u.gap - 1.6).abs() < 1e-9 && (u.landing - 1.2).abs() < 1e-9 && u.offset.abs() < 1e-9, "{u:?}");
        // gerade mit Zwischenpodest
        let m = flight_blocks(&[([0.0, 0.0], [1.0, 0.0], 5, 0.3), ([2.5, 0.0], [1.0, 0.0], 6, 0.3)], &[[[1.5, -0.5], [2.5, 0.5]]], 1.0, h);
        let s = fit_turn_stair(&[m]).unwrap();
        assert_eq!((s.shape, s.n1, s.n2), ("straightLanding", 5, 6), "{s:?}");
        assert!((s.landing - 1.0).abs() < 1e-9);
        // rechtwinklig, Podest nicht an der Ecke (kein L): keine Dossier-Form
        let m = flight_blocks(&[([0.0, 0.0], [0.0, 1.0], 6, 0.28), ([1.5, 2.5], [1.0, 0.0], 6, 0.28)], &[[[-0.6, 1.68], [1.5, 3.0]]], 1.2, h);
        assert_eq!(fit_turn_stair(&[m]), Err(R_STAIR_TURN));
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
