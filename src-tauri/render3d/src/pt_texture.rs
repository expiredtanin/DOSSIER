// [212] Etappe 4: Bildkarten-Hilfen des Pathtracers, GPU-frei und headless prüfbar — Mip-Ketten der Textur-Arrays,
// Detail-Ebenen aus Normalen- und Rauigkeitskarten, LOD-Wahl nach Strahlkegel und der Tangentenrahmen der planaren
// Projektion. Der Compute-Shader (`pathtrace.rs`, `PT_WGSL`) rechnet dieselben Formeln; die Funktionen hier sind die
// Referenz der Tests (und packen die Daten vor dem Hochladen, `gpu.rs`).
//
// Detail-Ebene (RGBA8 linear, parallel zum Farb-Array, gleiche Ebenen-Nummer): R, G = Normale x, y der Karte
// (OpenGL-Konvention, ambientCG `…_NormalGL` bzw. `normal.jpg`: Grün zeigt zum oberen Bildrand), B = Rauigkeit,
// A = Normale z. z mitzuführen kostet nichts und gibt in den Mip-Stufen die Länge der gemittelten Normale: je kürzer,
// desto unruhiger die Fläche darunter — der Shader macht sie rauer statt zu flimmern (Toksvig 2005).
//
// LOD (Strahlkegel nach Amanatides 1984 / Akenine-Möller et al. 2019, vereinfacht): Breite des Kegels am Treffer in
// Metern, geteilt durch die Wurzel des Einfallswinkel-Kosinus (geometrisches Mittel der verzerrten Fussabdruck-Achsen —
// mit dem vollen 1/cos würden flach gesehene Böden zu unscharf), mal Texel je Meter; Stufe = log2 davon.
//
// Tangentenrahmen: die UV der Ecken sind eine planare Projektion (`mesh::planar_uv`), also linear im Dreieck — die
// Ableitungen dP/du und dP/dv folgen eindeutig aus zwei Kanten und ihren UV-Differenzen. Das Bild liegt mit Zeile 0
// bei v = 0, der obere Bildrand zeigt also nach −dP/dv; Normale der Karte = T · x + B↑ · y + N · z mit
// B↑ = −dP/dv und N = T × B↑ (rechtshändig wie die OpenGL-Karten). Trifft der Strahl die Rückseite, kippt die ganze
// gestörte Normale mit (eine Erhebung ist von hinten eine Vertiefung).

/// Kantenlänge einer Textur-Ebene (wie `gpu::TEXTURE_SIZE`, `materialTextures.ts`, `render_png`).
pub const TEX_SIZE: u32 = 256;

/// Zahl der Mip-Stufen einer quadratischen Textur der Kantenlänge `size` (256 → 9: 256 … 1).
pub fn mip_count(size: u32) -> u32 {
    32 - size.max(1).leading_zeros()
}

fn srgb_lut() -> [f32; 256] {
    let mut t = [0.0f32; 256];
    for (i, v) in t.iter_mut().enumerate() {
        *v = crate::pt_material::srgb_to_linear(i as f32 / 255.0);
    }
    t
}

/// Mip-Kette ab Stufe 1 einer quadratischen RGBA8-Ebene `size × size` (2 × 2-Kastenfilter, Kantenlänge halbiert bis 1).
/// `srgb`: Farbkanäle in linearem Licht mitteln (sonst würden ferne Ziegel dunkler); Alpha und Datenkarten linear.
/// Zu kurzer Puffer oder Grösse 0: leer.
pub fn mip_chain(level0: &[u8], size: usize, srgb: bool) -> Vec<Vec<u8>> {
    if size == 0 || level0.len() < size * size * 4 {
        return Vec::new();
    }
    let lut = srgb_lut();
    let to_lin = |v: u8, k: usize| if srgb && k < 3 { lut[v as usize] } else { v as f32 / 255.0 };
    let from_lin = |v: f32, k: usize| {
        let c = if srgb && k < 3 { crate::pt_material::linear_to_srgb(v) } else { v.clamp(0.0, 1.0) };
        (c * 255.0).round() as u8
    };
    let mut out: Vec<Vec<u8>> = Vec::new();
    let mut cur: Vec<u8> = level0[..size * size * 4].to_vec();
    let mut s = size;
    while s > 1 {
        let n = (s / 2).max(1);
        let mut next = vec![0u8; n * n * 4];
        for y in 0..n {
            for x in 0..n {
                for k in 0..4 {
                    let mut acc = 0.0;
                    for (dx, dy) in [(0, 0), (1, 0), (0, 1), (1, 1)] {
                        let sx = (2 * x + dx).min(s - 1);
                        let sy = (2 * y + dy).min(s - 1);
                        acc += to_lin(cur[(sy * s + sx) * 4 + k], k);
                    }
                    next[(y * n + x) * 4 + k] = from_lin(acc * 0.25, k);
                }
            }
        }
        out.push(next.clone());
        cur = next;
        s = n;
    }
    out
}

/// Neutrales Detail-Texel: Normale (0, 0, 1), Rauigkeit 1 (Faktor über das Kartenmittel ohnehin 1).
pub const NEUTRAL_DETAIL: [u8; 4] = [128, 128, 255, 255];

/// Gilt eine Ebene als geladen? (Nicht geladene Bilder kommen schwarz an, wie bei den Farbkarten.)
fn present(layer: &[u8]) -> bool {
    layer.chunks_exact(4).any(|p| p[0] > 2 || p[1] > 2 || p[2] > 2)
}

/// Ergebnis von [`pack_detail`] für eine Ebene.
#[derive(Clone, Debug, PartialEq)]
pub struct DetailLayer {
    /// `px` Texel RGBA8 (s. Moduldoc).
    pub rgba: Vec<u8>,
    /// Normalen- oder Rauigkeitskarte vorhanden (sonst neutral).
    pub present: bool,
    /// Mittlere Rauigkeit der Karte (0..1), None ohne Rauigkeitskarte.
    pub rough_mean: Option<f32>,
}

/// Packt Normalen- (RGB, OpenGL) und Rauigkeitskarte (Grauwert, Kanal R) einer Ebene mit `px` Texeln zur
/// Detail-Ebene. Fehlende, zu kurze oder schwarze Karten = neutral. Normalen werden auf Länge 1 gebracht (JPEG-
/// Rundung), kaputte (Länge 0) neutral.
pub fn pack_detail(normal: Option<&[u8]>, rough: Option<&[u8]>, px: usize) -> DetailLayer {
    let n = normal.filter(|b| b.len() >= px * 4 && present(&b[..px * 4]));
    let r = rough.filter(|b| b.len() >= px * 4 && present(&b[..px * 4]));
    let mut rgba = NEUTRAL_DETAIL.repeat(px);
    let mut rsum = 0.0f64;
    for i in 0..px {
        if let Some(nb) = n {
            let d = |k: usize| nb[i * 4 + k] as f32 / 127.5 - 1.0;
            let (x, y, z) = (d(0), d(1), d(2).max(0.0));
            let l = (x * x + y * y + z * z).sqrt();
            if l > 1e-3 {
                let e = |v: f32| ((v / l * 0.5 + 0.5) * 255.0).round().clamp(0.0, 255.0) as u8;
                rgba[i * 4] = e(x);
                rgba[i * 4 + 1] = e(y);
                rgba[i * 4 + 3] = e(z);
            }
        }
        if let Some(rb) = r {
            rgba[i * 4 + 2] = rb[i * 4];
            rsum += rb[i * 4] as f64 / 255.0;
        }
    }
    DetailLayer { rgba, present: n.is_some() || r.is_some(), rough_mean: r.map(|_| (rsum / px.max(1) as f64) as f32) }
}

/// Mip-Stufe einer Texturabfrage: Kegelbreite `width` (m) am Treffer, Kosinus des Einfallswinkels, UV-Massstab
/// `scale` (Kacheln je m) und Kantenlänge `tex_size` (Texel je Kachel). ≥ 0; die GPU klemmt nach oben.
pub fn texture_lod(width: f32, cos_theta: f32, scale: f32, tex_size: f32) -> f32 {
    let c = if cos_theta.is_finite() { cos_theta.abs().max(0.05) } else { 1.0 };
    let texels = width * scale * tex_size / c.sqrt();
    if texels.is_finite() && texels > 1.0 {
        texels.log2()
    } else {
        0.0
    }
}

/// Strahlkegel des Blickstrahls: (Breite am Augpunkt in m, Öffnung je m Weg) für ein Bild mit `height` Pixeln
/// (intern). Perspektive: Breite 0, Öffnung = Pixelwinkel 2 · tan(fov/2) / Höhe; orthografisch: Breite = Pixelgrösse,
/// Öffnung 0. `half` = tan(fov/2) bzw. halbe Sichthöhe (`PtParams::cam_fwd.w`).
pub fn primary_cone(ortho: bool, half: f32, height: u32) -> (f32, f32) {
    let px = 2.0 * half / height.max(1) as f32;
    if ortho {
        (px, 0.0)
    } else {
        (0.0, px)
    }
}

/// Öffnung des Kegels nach einem Abpraller: diffus breit (die Textur zählt dort nur noch als Mittel), glänzend nach
/// der GGX-Breite `a = Rauigkeit²`.
pub fn bounce_spread(spread: f32, diffuse: bool, rough: f32) -> f32 {
    if diffuse {
        spread.max(DIFFUSE_SPREAD)
    } else {
        spread + 2.0 * rough * rough
    }
}

/// Kegelöffnung nach einem diffusen Abpraller (rad).
pub const DIFFUSE_SPREAD: f32 = 0.3;

fn sub(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
fn scale3(a: [f32; 3], s: f32) -> [f32; 3] {
    [a[0] * s, a[1] * s, a[2] * s]
}
fn cross(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}
fn dot(a: [f32; 3], b: [f32; 3]) -> f32 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
fn norm(v: [f32; 3]) -> Option<[f32; 3]> {
    let l = dot(v, v).sqrt();
    (l.is_finite() && l > 1e-12).then(|| scale3(v, 1.0 / l))
}

/// Tangentenrahmen (T, B↑, N) eines Dreiecks mit Kanten `e1`, `e2` und den UV-Differenzen `duv1`, `duv2` der
/// planaren Projektion (s. Moduldoc). None bei entarteten UV (alle gleich, Dreieck in UV zu einer Linie).
pub fn uv_tangent_frame(e1: [f32; 3], e2: [f32; 3], duv1: [f32; 2], duv2: [f32; 2]) -> Option<([f32; 3], [f32; 3], [f32; 3])> {
    let det = duv1[0] * duv2[1] - duv2[0] * duv1[1];
    if !(det.abs() > 1e-12) {
        return None;
    }
    let r = 1.0 / det;
    let dpdu = scale3(sub(scale3(e1, duv2[1]), scale3(e2, duv1[1])), r);
    let dpdv = scale3(sub(scale3(e2, duv1[0]), scale3(e1, duv2[0])), r);
    let n = norm(cross(dpdv, dpdu))?;
    let t = norm(sub(dpdu, scale3(n, dot(n, dpdu))))?;
    Some((t, cross(n, t), n))
}

/// Normale der Karte (Tangentenraum, x/y/z) in Welt-Richtung; `facing` = geometrische Normale zur Blickseite: liegt
/// N dahinter, kippt das Ergebnis mit.
pub fn perturb(frame: ([f32; 3], [f32; 3], [f32; 3]), tn: [f32; 3], facing: [f32; 3]) -> Option<[f32; 3]> {
    let (t, b, n) = frame;
    let w = [t[0] * tn[0] + b[0] * tn[1] + n[0] * tn[2], t[1] * tn[0] + b[1] * tn[1] + n[1] * tn[2], t[2] * tn[0] + b[2] * tn[1] + n[2] * tn[2]];
    let w = norm(w)?;
    Some(if dot(n, facing) < 0.0 { scale3(w, -1.0) } else { w })
}

/// Rauigkeit mit Toksvig-Anteil: `len` = Länge der gemittelten Karten-Normale (1 = glatt, kürzer = unruhig
/// darunter). In der GGX-Breite a = r²: a'² = a² + (1 − len) / len.
pub fn toksvig_rough(rough: f32, len: f32) -> f32 {
    let len = if len.is_finite() { len.clamp(0.05, 1.0) } else { 1.0 };
    let a = rough * rough;
    (a * a + (1.0 - len) / len).sqrt().sqrt().clamp(0.0, 1.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: [f32; 3], b: [f32; 3], eps: f32) -> bool {
        (0..3).all(|k| (a[k] - b[k]).abs() < eps)
    }

    #[test]
    fn mip_kette_mittelt_linear() {
        assert_eq!(mip_count(256), 9);
        assert_eq!(mip_count(1), 1);
        assert_eq!(mip_count(0), 1);
        // 4 × 4 Schachbrett schwarz/weiss: Stufe 1 (2 × 2) und 2 (1 × 1) mittleres Grau, linear gemittelt.
        let mut l0 = Vec::new();
        for y in 0..4 {
            for x in 0..4 {
                let v = if (x + y) % 2 == 0 { 255 } else { 0 };
                l0.extend_from_slice(&[v, v, v, 255]);
            }
        }
        let c = mip_chain(&l0, 4, true);
        assert_eq!(c.len(), 2);
        assert_eq!((c[0].len(), c[1].len()), (16, 4));
        assert!((c[1][0] as i32 - 188).abs() <= 1, "sRGB-Mittel von schwarz/weiss ≈ 188, war {}", c[1][0]);
        assert_eq!(c[1][3], 255, "Alpha linear");
        let d = mip_chain(&l0, 4, false);
        assert!((d[1][0] as i32 - 128).abs() <= 1, "Datenkarte: arithmetisches Mittel");
        // Kaputt: zu kurz, Grösse 0.
        assert!(mip_chain(&l0[..10], 4, true).is_empty());
        assert!(mip_chain(&l0, 0, true).is_empty());
        // 256er-Ebene: 8 Stufen bis 1 × 1.
        let big = vec![77u8; 256 * 256 * 4];
        let c = mip_chain(&big, 256, true);
        assert_eq!(c.len(), 8);
        assert_eq!(c.last().unwrap().len(), 4);
        assert!(c.last().unwrap()[..3].iter().all(|v| (*v as i32 - 77).abs() <= 1), "konstante Farbe bleibt");
    }

    #[test]
    fn detail_ebene_packen() {
        // Normale nach rechts oben geneigt (GL), Rauigkeit 0.5 / 1.0 im Wechsel.
        let normal = [200u8, 160, 230, 255].repeat(4);
        let rough = [128u8, 128, 128, 255, 255, 255, 255, 255].repeat(2);
        let d = pack_detail(Some(&normal), Some(&rough), 4);
        assert!(d.present);
        let m = d.rough_mean.unwrap();
        assert!((m - (128.0 / 255.0 + 1.0) / 2.0).abs() < 1e-3, "{m}");
        let px = &d.rgba[0..4];
        let v = |c: u8| c as f32 / 127.5 - 1.0;
        let l = (v(px[0]).powi(2) + v(px[1]).powi(2) + v(px[3]).powi(2)).sqrt();
        assert!((l - 1.0).abs() < 0.02, "auf Länge 1: {l}");
        assert!(px[0] > 128 && px[1] > 128, "Richtung bleibt");
        assert_eq!(d.rgba[2], 128);
        assert_eq!(d.rgba[6], 255);
        // Ohne Karten / schwarz / zu kurz: neutral, nicht vorhanden.
        for (n, r) in [(None, None), (Some(&[0u8; 16][..]), Some(&[0u8; 16][..])), (Some(&normal[..8]), None)] {
            let d = pack_detail(n, r, 4);
            assert!(!d.present);
            assert_eq!(d.rgba, NEUTRAL_DETAIL.repeat(4));
            assert_eq!(d.rough_mean, None);
        }
        // Nur Normale: Rauigkeit neutral, ohne Mittel.
        let d = pack_detail(Some(&normal), None, 4);
        assert!(d.present && d.rough_mean.is_none() && d.rgba[2] == 255);
    }

    /// LOD: nah (Kegel schmaler als ein Texel) Stufe 0, doppelte Entfernung eine Stufe mehr, flacher Blick etwas
    /// mehr, grössere Kachel weniger; kaputte Werte ohne Panic.
    #[test]
    fn lod_nach_strahlkegel() {
        let (w0, s) = primary_cone(false, (30f32.to_radians()).tan(), 520);
        assert_eq!(w0, 0.0);
        let at = |t: f32| w0 + s * t;
        assert_eq!(texture_lod(at(0.5), 1.0, 1.0, 256.0), 0.0, "nah: volle Auflösung");
        let l20 = texture_lod(at(20.0), 1.0, 1.0, 256.0);
        let l40 = texture_lod(at(40.0), 1.0, 1.0, 256.0);
        assert!((l40 - l20 - 1.0).abs() < 1e-4, "{l20} {l40}");
        assert!(l40 > 3.0, "Ziegel in 40 m: deutlich gröber ({l40})");
        assert!(texture_lod(at(20.0), 0.2, 1.0, 256.0) > l20, "flach gesehen gröber");
        assert!(texture_lod(at(20.0), 1.0, 0.25, 256.0) < l20, "Kachel 4 m: feiner");
        // Ortho: Pixelgrösse fest, Öffnung 0.
        let (ow, os) = primary_cone(true, 10.0, 500);
        assert_eq!((ow, os), (0.04, 0.0));
        assert!((texture_lod(ow, 1.0, 1.0, 256.0) - (0.04f32 * 256.0).log2()).abs() < 1e-4);
        for bad in [f32::NAN, f32::INFINITY, -1.0] {
            assert!(texture_lod(bad, 1.0, 1.0, 256.0).is_finite());
            assert!(texture_lod(1.0, bad, 1.0, 256.0).is_finite());
        }
        // Abpraller: diffus breit, glänzend nach Rauigkeit.
        assert_eq!(bounce_spread(0.001, true, 0.5), DIFFUSE_SPREAD);
        assert!((bounce_spread(0.001, false, 0.1) - 0.021).abs() < 1e-6);
    }

    /// Tangentenrahmen der planaren UV (`mesh::planar_uv`): Wand (Mantel) und Deckel, beide Windungen.
    #[test]
    fn tangenten_aus_planarer_projektion() {
        let frame_of = |v: [[f32; 3]; 3], n: [f32; 3]| {
            let uv = v.map(|p| crate::mesh::planar_uv(p, n));
            let e1 = sub(v[1], v[0]);
            let e2 = sub(v[2], v[0]);
            uv_tangent_frame(e1, e2, [uv[1][0] - uv[0][0], uv[1][1] - uv[0][1]], [uv[2][0] - uv[0][0], uv[2][1] - uv[0][1]]).unwrap()
        };
        // Wand mit Aussennormale +X (Ebene x = 2): T = (−n.z, 0, n.x) = (0, 0, 1), oberer Bildrand = −v = unten.
        let n = [1.0, 0.0, 0.0];
        let wall = [[2.0, 0.0, 0.0], [2.0, 0.0, 3.0], [2.0, 2.5, 0.0]];
        let (t, b, nn) = frame_of(wall, n);
        assert!(close(t, [0.0, 0.0, 1.0], 1e-5) && close(b, [0.0, -1.0, 0.0], 1e-5) && close(nn, n, 1e-5), "{t:?} {b:?} {nn:?}");
        // Andere Windung, gleicher Rahmen (er folgt den UV, nicht der Eckenfolge).
        let (t2, b2, n2) = frame_of([wall[0], wall[2], wall[1]], n);
        assert!(close(t2, t, 1e-5) && close(b2, b, 1e-5) && close(n2, nn, 1e-5));
        // Schräge Wand (Normale in XZ): T bleibt horizontal, Rahmen orthonormal.
        let s = std::f32::consts::FRAC_1_SQRT_2;
        let n = [s, 0.0, s];
        let (t, b, nn) = frame_of([[0.0, 0.0, 0.0], [-1.0, 0.0, 1.0], [0.0, 2.0, 0.0]], n);
        assert!(close(t, [-s, 0.0, s], 1e-5) && close(nn, n, 1e-5) && dot(t, b).abs() < 1e-5, "{t:?} {nn:?}");
        // Deckel (oben): u = x, v = z; T = +X, oberer Bildrand = −Z, N = +Y.
        let (t, b, nn) = frame_of([[0.0, 3.0, 0.0], [4.0, 3.0, 0.0], [0.0, 3.0, 5.0]], [0.0, 1.0, 0.0]);
        assert!(close(t, [1.0, 0.0, 0.0], 1e-5) && close(b, [0.0, 0.0, -1.0], 1e-5) && close(nn, [0.0, 1.0, 0.0], 1e-5));
        // Entartet: alle UV gleich.
        assert!(uv_tangent_frame([1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0; 2], [0.0; 2]).is_none());
    }

    #[test]
    fn gestoerte_normale_und_rueckseite() {
        let frame = ([0.0, 0.0, 1.0], [0.0, -1.0, 0.0], [1.0, 0.0, 0.0]);
        // Karte flach: Normale = N.
        assert!(close(perturb(frame, [0.0, 0.0, 1.0], [1.0, 0.0, 0.0]).unwrap(), [1.0, 0.0, 0.0], 1e-6));
        // Karte zeigt zum oberen Bildrand (+y): Welt-Neigung nach B↑ = unten.
        let p = perturb(frame, [0.0, 0.6, 0.8], [1.0, 0.0, 0.0]).unwrap();
        assert!(close(p, [0.8, -0.6, 0.0], 1e-6), "{p:?}");
        // Von hinten gesehen kippt alles.
        let q = perturb(frame, [0.0, 0.6, 0.8], [-1.0, 0.0, 0.0]).unwrap();
        assert!(close(q, [-0.8, 0.6, 0.0], 1e-6));
        assert!(perturb(frame, [0.0; 3], [1.0, 0.0, 0.0]).is_none());
        // Toksvig: glatt = unverändert, unruhig = rauer, nie über 1.
        assert!((toksvig_rough(0.4, 1.0) - 0.4).abs() < 1e-6);
        assert!(toksvig_rough(0.4, 0.8) > 0.5);
        assert!(toksvig_rough(0.9, 0.05) <= 1.0 && toksvig_rough(0.5, f32::NAN) == 0.5);
    }
}
