// [212] Entrauscher des Pathtracers (Etappe 2): kantenerhaltender À-trous-Filter nach SVGF (Schied et al. 2017), ohne
// Zeit-Reprojektion — die Akkumulation über Bilder ersetzt sie (Kamera steht, solange gesammelt wird).
//
// Eingaben je Pixel (die Pfadverfolgung schreibt sie beim ersten Treffer mit, aufsummiert wie die Farbe):
//   accum  = (Farbe Σ, Zahl n), aux_a = (Albedo Σ, Luminanz² Σ), aux_b = (Normale Σ, Tiefe Σ).
// Himmel: Albedo 1, Normale 0, Tiefe 0 (ein Pixel gilt als Himmel, wenn |Σ Normale| < n/2).
//
// 1. `prep`: Beleuchtung = Farbe / Albedo (Demodulation: Texturfarbe und Kanten der Grundfarbe bleiben scharf, gefiltert
//    wird nur das Licht), dazu die Varianz des Mittels — aus den Samples (n ≥ 4: (E[l²] − E[l]²)/n) oder räumlich
//    (3 × 3) bei wenigen Samples.
// 2. `atrous` × `ITERATIONS` mit Schrittweite 1, 2, 4, 8, 16: 5 × 5-B3-Kern; Gewichte aus Normale (cos^σn), Tiefe
//    (relativ zum Tiefengradienten) und Luminanz (relativ zur Standardabweichung, σl); Varianz mit w² mitgeführt.
// 3. Anzeige: gefiltertes Licht × Albedo, gemischt mit dem rohen Mittel nach `blend_weight` (blendet mit
//    wachsender Sample-Zahl aus; am Ziel aus). Die Akkumulation selbst bleibt unberührt.
//
// Diese Datei ist die GPU-freie Referenz (Tests: Kanten bleiben, flache Fläche wird glatt) und hält die WGSL-Quelle;
// `gpu_pathtrace.rs` führt dieselbe Rechnung als Compute-Pässe aus (Test vergleicht beide mit lavapipe).
// Intel Open Image Denoise (OIDN) für Endbilder bleibt für später ([212], [215]).

/// Zahl der À-trous-Durchgänge (Schrittweiten 1 … 16, Reichweite ≈ 2 · 31 Pixel).
pub const ITERATIONS: u32 = 5;
/// Luminanz-Gewicht: Abstand in Standardabweichungen.
pub const SIGMA_L: f32 = 4.0;
/// Normalen-Gewicht: Exponent auf cos.
pub const SIGMA_N: f32 = 128.0;
/// Tiefen-Gewicht relativ zum Gradienten.
pub const SIGMA_Z: f32 = 1.0;
/// Bis zu so vielen Samples zeigt die Anzeige nur das gefilterte Bild; danach blendet es (log2) bis zum Ziel aus.
pub const FULL_UNTIL: u32 = 32;

/// Mischgewicht des gefilterten Bildes bei `samples` von `target` (1 = nur gefiltert, 0 = roh). Am Ziel 0.
pub fn blend_weight(samples: u32, target: u32) -> f32 {
    if samples == 0 || samples >= target {
        return 0.0;
    }
    let lo = (FULL_UNTIL as f32).log2();
    let hi = (target as f32).log2();
    if hi <= lo {
        return 1.0;
    }
    (1.0 - ((samples as f32).log2() - lo) / (hi - lo)).clamp(0.0, 1.0)
}

fn lum(c: [f32; 3]) -> f32 {
    0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
}

/// Bildpuffer für die Referenz (Zeilen von oben).
pub struct Frame<'a> {
    pub w: usize,
    pub h: usize,
    pub accum: &'a [[f32; 4]],
    pub aux_a: &'a [[f32; 4]],
    pub aux_b: &'a [[f32; 4]],
}

/// G-Puffer eines Pixels: Normale, Tiefe, Himmel?
fn gbuf(f: &Frame, i: usize) -> ([f32; 3], f32, bool) {
    let cnt = f.accum[i][3].max(1.0);
    let b = f.aux_b[i];
    let len = (b[0] * b[0] + b[1] * b[1] + b[2] * b[2]).sqrt();
    let l = len.max(1e-6);
    ([b[0] / l, b[1] / l, b[2] / l], b[3] / l, len < 0.5 * cnt)
}

fn irr_at(f: &Frame, i: usize) -> [f32; 3] {
    let cnt = f.accum[i][3].max(1.0);
    let a = f.accum[i];
    let al = f.aux_a[i];
    [0, 1, 2].map(|k| (a[k] / cnt) / (al[k] / cnt).max(0.02))
}

/// Durchgang 1: demodulierte Beleuchtung und Varianz je Pixel.
pub fn prep(f: &Frame) -> Vec<[f32; 4]> {
    let (w, h) = (f.w as i64, f.h as i64);
    (0..f.w * f.h)
        .map(|i| {
            let cnt = f.accum[i][3].max(1.0);
            let irr = irr_at(f, i);
            let c = [0, 1, 2].map(|k| f.accum[i][k] / cnt);
            let alb = [0, 1, 2].map(|k| (f.aux_a[i][k] / cnt).max(0.02));
            let la = lum(alb).max(0.02);
            let var = if cnt >= 4.0 {
                (f.aux_a[i][3] / cnt - lum(c) * lum(c)).max(0.0) / cnt / (la * la)
            } else {
                let (x, y) = ((i as i64) % w, (i as i64) / w);
                let (mut m1, mut m2) = (0.0f32, 0.0f32);
                for dy in -1..=1 {
                    for dx in -1..=1 {
                        let q = ((y + dy).clamp(0, h - 1) * w + (x + dx).clamp(0, w - 1)) as usize;
                        let l = lum(irr_at(f, q));
                        m1 += l;
                        m2 += l * l;
                    }
                }
                (m2 / 9.0 - (m1 / 9.0) * (m1 / 9.0)).max(0.0)
            };
            [irr[0], irr[1], irr[2], var]
        })
        .collect()
}

const KERNEL: [f32; 3] = [3.0 / 8.0, 1.0 / 4.0, 1.0 / 16.0];

/// Ein À-trous-Durchgang mit Schrittweite `step`.
pub fn atrous(f: &Frame, src: &[[f32; 4]], step: i64) -> Vec<[f32; 4]> {
    let (w, h) = (f.w as i64, f.h as i64);
    let at = |x: i64, y: i64| (y.clamp(0, h - 1) * w + x.clamp(0, w - 1)) as usize;
    (0..f.w * f.h)
        .map(|i| {
            let (x, y) = ((i as i64) % w, (i as i64) / w);
            let sp = src[i];
            let (np, zp, skyp) = gbuf(f, i);
            let lp = lum([sp[0], sp[1], sp[2]]);
            // Varianz 3 × 3 vorgefiltert (Gauss 1-2-1).
            let mut vf = 0.0f32;
            for dy in -1i64..=1 {
                for dx in -1i64..=1 {
                    let k = [0.5f32, 0.25][dx.unsigned_abs() as usize] * [0.5f32, 0.25][dy.unsigned_abs() as usize];
                    vf += k * src[at(x + dx, y + dy)][3];
                }
            }
            let denom_l = SIGMA_L * vf.max(0.0).sqrt() + 1e-4;
            let zx = (gbuf(f, at(x + 1, y)).1 - gbuf(f, at(x - 1, y)).1).abs() * 0.5;
            let zy = (gbuf(f, at(x, y + 1)).1 - gbuf(f, at(x, y - 1)).1).abs() * 0.5;
            let gz = zx.max(zy);
            let (mut sum, mut vs, mut ws) = ([0.0f32; 3], 0.0f32, 0.0f32);
            for dy in -2i64..=2 {
                for dx in -2i64..=2 {
                    let (qx, qy) = (x + dx * step, y + dy * step);
                    if qx < 0 || qy < 0 || qx >= w || qy >= h {
                        continue;
                    }
                    let q = (qy * w + qx) as usize;
                    let sq = src[q];
                    let (nq, zq, skyq) = gbuf(f, q);
                    if skyp != skyq {
                        continue;
                    }
                    let (wn, wz) = if skyp {
                        (1.0, 1.0)
                    } else {
                        let d = (np[0] * nq[0] + np[1] * nq[1] + np[2] * nq[2]).max(0.0);
                        let dist = ((dx * dx + dy * dy) as f32).sqrt() * step as f32;
                        (d.powf(SIGMA_N), (-(zp - zq).abs() / (SIGMA_Z * gz * dist + 1e-3 * zp.abs() + 1e-6)).exp())
                    };
                    let wl = (-(lp - lum([sq[0], sq[1], sq[2]])).abs() / denom_l).exp();
                    let wgt = KERNEL[dx.unsigned_abs() as usize] * KERNEL[dy.unsigned_abs() as usize] * wn * wz * wl;
                    for k in 0..3 {
                        sum[k] += wgt * sq[k];
                    }
                    vs += wgt * wgt * sq[3];
                    ws += wgt;
                }
            }
            let ws = ws.max(1e-8);
            [sum[0] / ws, sum[1] / ws, sum[2] / ws, vs / (ws * ws)]
        })
        .collect()
}

/// Ganzer Filter (Referenz): Farbe je Pixel = gefiltertes Licht × Albedo.
pub fn denoise(f: &Frame) -> Vec<[f32; 3]> {
    let mut buf = prep(f);
    for it in 0..ITERATIONS {
        buf = atrous(f, &buf, 1 << it);
    }
    buf.iter()
        .enumerate()
        .map(|(i, v)| {
            let cnt = f.accum[i][3].max(1.0);
            [0, 1, 2].map(|k| v[k] * (f.aux_a[i][k] / cnt).max(0.02))
        })
        .collect()
}

/// WGSL der Entrauscher-Pässe (`prep`, `atrous`); dieselbe Rechnung wie oben.
pub const DN_WGSL: &str = r#"
struct DnParams {
    dims: vec4<u32>,
    k: vec4<f32>,
};
@group(0) @binding(0) var<uniform> D: DnParams;
@group(0) @binding(1) var<storage, read> accum: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> aux_a: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read> aux_b: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read> src: array<vec4<f32>>;
@group(0) @binding(5) var<storage, read_write> dst: array<vec4<f32>>;

fn lum(c: vec3<f32>) -> f32 {
    return dot(c, vec3<f32>(0.2126, 0.7152, 0.0722));
}

fn idx(x: i32, y: i32) -> u32 {
    let w = i32(D.dims.x);
    let h = i32(D.dims.y);
    return u32(clamp(y, 0, h - 1) * w + clamp(x, 0, w - 1));
}

struct G { n: vec3<f32>, z: f32, sky: bool };

fn gbuf(i: u32) -> G {
    let cnt = max(accum[i].w, 1.0);
    let b = aux_b[i];
    let len = length(b.xyz);
    let l = max(len, 1e-6);
    var g: G;
    g.n = b.xyz / l;
    g.z = b.w / l;
    g.sky = len < 0.5 * cnt;
    return g;
}

fn irr_at(i: u32) -> vec3<f32> {
    let cnt = max(accum[i].w, 1.0);
    return (accum[i].rgb / cnt) / max(aux_a[i].rgb / cnt, vec3<f32>(0.02));
}

@compute @workgroup_size(8, 8, 1)
fn prep(@builtin(global_invocation_id) gid: vec3<u32>) {
    if (gid.x >= D.dims.x || gid.y >= D.dims.y) { return; }
    let x = i32(gid.x);
    let y = i32(gid.y);
    let i = gid.y * D.dims.x + gid.x;
    let cnt = max(accum[i].w, 1.0);
    let irr = irr_at(i);
    let c = accum[i].rgb / cnt;
    let la = max(lum(max(aux_a[i].rgb / cnt, vec3<f32>(0.02))), 0.02);
    var v = 0.0;
    if (cnt >= 4.0) {
        v = max(aux_a[i].w / cnt - lum(c) * lum(c), 0.0) / cnt / (la * la);
    } else {
        var m1 = 0.0;
        var m2 = 0.0;
        for (var dy = -1; dy <= 1; dy = dy + 1) {
            for (var dx = -1; dx <= 1; dx = dx + 1) {
                let l = lum(irr_at(idx(x + dx, y + dy)));
                m1 = m1 + l;
                m2 = m2 + l * l;
            }
        }
        v = max(m2 / 9.0 - (m1 / 9.0) * (m1 / 9.0), 0.0);
    }
    dst[i] = vec4<f32>(irr, v);
}

fn kern(a: i32) -> f32 {
    if (a == 0) { return 0.375; }
    if (a == 1) { return 0.25; }
    return 0.0625;
}

@compute @workgroup_size(8, 8, 1)
fn atrous(@builtin(global_invocation_id) gid: vec3<u32>) {
    if (gid.x >= D.dims.x || gid.y >= D.dims.y) { return; }
    let w = i32(D.dims.x);
    let h = i32(D.dims.y);
    let step = i32(D.dims.z);
    let x = i32(gid.x);
    let y = i32(gid.y);
    let i = gid.y * D.dims.x + gid.x;
    let sp = src[i];
    let gp = gbuf(i);
    let lp = lum(sp.rgb);
    var vf = 0.0;
    for (var dy = -1; dy <= 1; dy = dy + 1) {
        for (var dx = -1; dx <= 1; dx = dx + 1) {
            let k = select(0.25, 0.5, dx == 0) * select(0.25, 0.5, dy == 0);
            vf = vf + k * src[idx(x + dx, y + dy)].w;
        }
    }
    let denom_l = D.k.x * sqrt(max(vf, 0.0)) + 1e-4;
    let zx = abs(gbuf(idx(x + 1, y)).z - gbuf(idx(x - 1, y)).z) * 0.5;
    let zy = abs(gbuf(idx(x, y + 1)).z - gbuf(idx(x, y - 1)).z) * 0.5;
    let gz = max(zx, zy);
    var sum = vec3<f32>(0.0);
    var vs = 0.0;
    var ws = 0.0;
    for (var dy = -2; dy <= 2; dy = dy + 1) {
        for (var dx = -2; dx <= 2; dx = dx + 1) {
            let qx = x + dx * step;
            let qy = y + dy * step;
            if (qx < 0 || qy < 0 || qx >= w || qy >= h) { continue; }
            let q = u32(qy * w + qx);
            let sq = src[q];
            let gq = gbuf(q);
            if (gp.sky != gq.sky) { continue; }
            var wn = 1.0;
            var wz = 1.0;
            if (!gp.sky) {
                wn = pow(max(dot(gp.n, gq.n), 0.0), D.k.y);
                let dist = sqrt(f32(dx * dx + dy * dy)) * f32(step);
                wz = exp(-abs(gp.z - gq.z) / (D.k.z * gz * dist + 1e-3 * abs(gp.z) + 1e-6));
            }
            let wl = exp(-abs(lp - lum(sq.rgb)) / denom_l);
            let wgt = kern(abs(dx)) * kern(abs(dy)) * wn * wz * wl;
            sum = sum + wgt * sq.rgb;
            vs = vs + wgt * wgt * sq.w;
            ws = ws + wgt;
        }
    }
    let wsum = max(ws, 1e-8);
    dst[i] = vec4<f32>(sum / wsum, vs / (wsum * wsum));
}
"#;

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// Deterministischer Zufall (xorshift).
    pub(crate) struct Rng(pub u64);
    impl Rng {
        pub fn f(&mut self) -> f32 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            (self.0 >> 40) as f32 / (1u64 << 24) as f32
        }
    }

    /// Testbild: n Samples je Pixel, `light(x, y)` mittlere Beleuchtung, `normal(x, y)`, Albedo, Rauschen ±`noise`
    /// (gleichverteilt, je Sample). Liefert die Puffer wie die Pfadverfolgung sie schreibt.
    pub(crate) fn scene(
        w: usize,
        h: usize,
        n: u32,
        noise: f32,
        light: impl Fn(usize, usize) -> f32,
        normal: impl Fn(usize, usize) -> [f32; 3],
        albedo: impl Fn(usize, usize) -> [f32; 3],
    ) -> (Vec<[f32; 4]>, Vec<[f32; 4]>, Vec<[f32; 4]>) {
        let mut r = Rng(0x9e3779b97f4a7c15);
        let (mut acc, mut aa, mut ab) = (vec![[0.0f32; 4]; w * h], vec![[0.0f32; 4]; w * h], vec![[0.0f32; 4]; w * h]);
        for y in 0..h {
            for x in 0..w {
                let i = y * w + x;
                let (l, nn, al) = (light(x, y), normal(x, y), albedo(x, y));
                for _ in 0..n {
                    let s = (l * (1.0 + noise * (2.0 * r.f() - 1.0))).max(0.0);
                    let c = al.map(|a| a * s);
                    for k in 0..3 {
                        acc[i][k] += c[k];
                        aa[i][k] += al[k];
                        ab[i][k] += nn[k];
                    }
                    acc[i][3] += 1.0;
                    aa[i][3] += lum(c) * lum(c);
                    ab[i][3] += 10.0;
                }
            }
        }
        (acc, aa, ab)
    }

    fn stddev(v: impl Iterator<Item = f32>) -> f32 {
        let v: Vec<f32> = v.collect();
        let m = v.iter().sum::<f32>() / v.len() as f32;
        (v.iter().map(|x| (x - m) * (x - m)).sum::<f32>() / v.len() as f32).sqrt()
    }

    #[test]
    fn flache_flaeche_wird_glatt() {
        let (w, h) = (48, 40);
        for n in [1u32, 8] {
            let (acc, aa, ab) = scene(w, h, n, 0.9, |_, _| 0.5, |_, _| [0.0, 1.0, 0.0], |_, _| [0.7, 0.7, 0.7]);
            let f = Frame { w, h, accum: &acc, aux_a: &aa, aux_b: &ab };
            let raw = stddev((0..w * h).map(|i| acc[i][0] / acc[i][3]));
            let out = denoise(&f);
            let den = stddev(out.iter().map(|c| c[0]));
            assert!(den < raw * 0.25, "n={n}: Rauschen {raw:.4} → {den:.4}");
            let mean = out.iter().map(|c| c[0]).sum::<f32>() / out.len() as f32;
            assert!((mean - 0.35).abs() < 0.03, "Helligkeit bleibt: {mean}");
        }
    }

    #[test]
    fn kanten_bleiben() {
        let (w, h) = (48, 32);
        // (a) Geometrische Kante: zwei Flächen mit verschiedener Normale und Helligkeit, verrauscht.
        let (acc, aa, ab) = scene(
            w,
            h,
            4,
            0.6,
            |x, _| if x < w / 2 { 0.2 } else { 0.9 },
            |x, _| if x < w / 2 { [1.0, 0.0, 0.0] } else { [0.0, 1.0, 0.0] },
            |_, _| [0.7; 3],
        );
        let f = Frame { w, h, accum: &acc, aux_a: &aa, aux_b: &ab };
        let out = denoise(&f);
        for y in 4..h - 4 {
            let l = out[y * w + w / 2 - 1][0];
            let r = out[y * w + w / 2][0];
            assert!((l - 0.14).abs() < 0.05 && (r - 0.63).abs() < 0.1, "Zeile {y}: {l} | {r}");
        }
        // (b) Texturkante (Albedo) auf einer Ebene bei gleichem Licht: Demodulation hält sie pixelgenau.
        let (acc, aa, ab) = scene(w, h, 2, 0.8, |_, _| 0.6, |_, _| [0.0, 1.0, 0.0], |x, _| if x % 8 < 4 { [0.8, 0.2, 0.1] } else { [0.1, 0.2, 0.8] });
        let f = Frame { w, h, accum: &acc, aux_a: &aa, aux_b: &ab };
        let out = denoise(&f);
        for y in 2..h - 2 {
            for x in 2..w - 2 {
                let c = out[y * w + x];
                let want = if x % 8 < 4 { [0.48, 0.12, 0.06] } else { [0.06, 0.12, 0.48] };
                for k in 0..3 {
                    assert!((c[k] - want[k]).abs() < 0.08, "({x},{y}) {c:?} statt {want:?}");
                }
            }
        }
        // (c) Schattenkante auf einer Ebene (gleiche Normale), viele Samples: Luminanz-Gewicht hält sie.
        let (acc, aa, ab) = scene(w, h, 64, 0.3, |x, _| if x < w / 2 { 0.1 } else { 1.0 }, |_, _| [0.0, 1.0, 0.0], |_, _| [0.7; 3]);
        let f = Frame { w, h, accum: &acc, aux_a: &aa, aux_b: &ab };
        let out = denoise(&f);
        for y in 2..h - 2 {
            let l = out[y * w + w / 2 - 1][0];
            let r = out[y * w + w / 2][0];
            assert!(l < 0.12 && r > 0.6, "Zeile {y}: {l} | {r}");
        }
    }

    #[test]
    fn himmel_und_gebaeude_getrennt() {
        let (w, h) = (24, 24);
        // Oben Himmel (Normale 0, Albedo 1), unten Fläche.
        let (mut acc, mut aa, mut ab) = scene(w, h, 4, 0.5, |_, y| if y < h / 2 { 1.5 } else { 0.3 }, |_, _| [0.0, 1.0, 0.0], |_, y| if y < h / 2 { [1.0; 3] } else { [0.6; 3] });
        for i in 0..w * h / 2 {
            ab[i] = [0.0; 4];
        }
        let _ = (&mut acc, &mut aa);
        let f = Frame { w, h, accum: &acc, aux_a: &aa, aux_b: &ab };
        let out = denoise(&f);
        assert!((out[(h / 2 - 1) * w + 5][0] - 1.5).abs() < 0.2, "Himmel bleibt hell: {}", out[(h / 2 - 1) * w + 5][0]);
        assert!((out[(h / 2) * w + 5][0] - 0.18).abs() < 0.06, "Fläche bleibt dunkel: {}", out[(h / 2) * w + 5][0]);
    }

    #[test]
    fn mischgewicht() {
        assert_eq!(blend_weight(0, 1024), 0.0);
        assert_eq!(blend_weight(1, 1024), 1.0);
        assert_eq!(blend_weight(FULL_UNTIL, 1024), 1.0);
        assert_eq!(blend_weight(1024, 1024), 0.0, "am Ziel roh");
        assert_eq!(blend_weight(2000, 1024), 0.0);
        let a = blend_weight(64, 1024);
        let b = blend_weight(256, 1024);
        assert!(a > b && b > 0.0 && a < 1.0, "{a} {b}");
        assert_eq!(blend_weight(4, 8), 1.0, "kleines Ziel: bis dahin voll");
    }

    #[test]
    fn leere_und_kaputte_puffer() {
        let z = [[0.0f32; 4]; 4];
        let f = Frame { w: 2, h: 2, accum: &z, aux_a: &z, aux_b: &z };
        for c in denoise(&f) {
            assert!(c.iter().all(|v| v.is_finite()));
        }
    }

    #[test]
    fn wgsl_valide_und_msl() {
        use naga::valid::{Capabilities, ValidationFlags, Validator};
        let module = naga::front::wgsl::parse_str(DN_WGSL).unwrap_or_else(|e| panic!("{}", e.emit_to_string(DN_WGSL)));
        let info = Validator::new(ValidationFlags::all(), Capabilities::empty()).validate(&module).unwrap();
        assert!(module.entry_points.iter().any(|e| e.name == "prep") && module.entry_points.iter().any(|e| e.name == "atrous"));
        let opts = naga::back::msl::Options { lang_version: (2, 1), ..Default::default() };
        naga::back::msl::write_string(&module, &info, &opts, &naga::back::msl::PipelineOptions::default()).unwrap();
    }
}
