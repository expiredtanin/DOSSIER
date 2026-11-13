// [212] Etappe 5: Belichtungsautomatik des Pathtracers für den Wechsel Aussen ↔ Innen. GPU-frei: Referenz auf der CPU
// (Tests) und die WGSL-Quelle des Compute-Passes, den `gpu_pathtrace.rs` vor jeder Anzeige rechnet.
//
// Messung: 64 × 64 gleichmässig verteilte Pixel des Mittelbildes (Akkumulation / Zahl), Luminanz in ein Histogramm von
// 64 Fächern über log2 ∈ [−14, 6]; gemittelt wird log2 zwischen dem 40. und 95. Perzentil (die dunkelsten Ecken und die
// hellsten Spitzen — Sonnenflecken, Himmel im Fenster — bestimmen die Belichtung nicht allein, wie das Histogramm-
// Verfahren gängiger Engines). Ziel: `KEY / 2^Mittel`, begrenzt auf [¼, 32] (Nacht [¼, 4]) × Belichtung des Himmels.
// Nachgeführt wird im log-Raum: neu = 2^mix(log2 alt, log2 Ziel, Rate) je Bild (Viewport sanft, Export/headless sofort).
// Der Belichtungsregler (EV) multipliziert danach.

/// Fächer des Histogramms, Bereich in log2(Luminanz).
pub const HIST_BINS: usize = 64;
pub const LOG_MIN: f32 = -14.0;
pub const LOG_MAX: f32 = 6.0;
/// Messraster (GRID × GRID Pixel).
pub const GRID: u32 = 64;
/// Perzentile des gemittelten Bereichs.
pub const PCT_LO: f32 = 0.4;
pub const PCT_HI: f32 = 0.95;
/// Ziel-Helligkeit: so gewählt, dass die Aussenansicht des Musterhauses am Tag etwa die feste Belichtung
/// (`pathtrace::DEFAULT_EXPOSURE`) bekommt.
pub const KEY: f32 = 0.12;

/// Fach einer Luminanz (≤ 0 und NaN ins unterste).
pub fn bin_of(lum: f32) -> usize {
    if !(lum > 0.0) {
        return 0;
    }
    let x = (lum.log2() - LOG_MIN) / (LOG_MAX - LOG_MIN) * HIST_BINS as f32;
    (x.floor().max(0.0) as usize).min(HIST_BINS - 1)
}

/// log2 der Fach-Mitte.
pub fn bin_center(b: usize) -> f32 {
    LOG_MIN + (b as f32 + 0.5) * (LOG_MAX - LOG_MIN) / HIST_BINS as f32
}

/// Index des Messpixels Nr. s (0 ≤ s < GRID²) im Bild w × h (wie der Shader).
pub fn grid_pixel(s: u32, w: u32, h: u32) -> usize {
    let (w, h) = (w.max(1), h.max(1));
    let (gx, gy) = (s % GRID, s / GRID);
    let x = (((gx as f32 + 0.5) * w as f32 / GRID as f32) as u32).min(w - 1);
    let y = (((gy as f32 + 0.5) * h as f32 / GRID as f32) as u32).min(h - 1);
    (y * w + x) as usize
}

/// Mittel von log2 zwischen den Perzentilen `PCT_LO`…`PCT_HI` (Fach-Mitten).
pub fn mean_log2(hist: &[u32; HIST_BINS]) -> f32 {
    let total: f32 = hist.iter().map(|&n| n as f32).sum();
    let (lo, hi) = (PCT_LO * total, PCT_HI * total);
    let (mut acc, mut sum, mut cnt) = (0.0f32, 0.0f32, 0.0f32);
    for (b, &n) in hist.iter().enumerate() {
        let (a0, a1) = (acc, acc + n as f32);
        let take = (a1.min(hi) - a0.max(lo)).max(0.0);
        sum += take * bin_center(b);
        cnt += take;
        acc = a1;
    }
    sum / cnt.max(1.0)
}

/// Ziel-Belichtung zum gemittelten log2, begrenzt auf [lo, hi].
pub fn target(mean_log2: f32, lo: f32, hi: f32) -> f32 {
    (KEY * (-mean_log2).exp2()).clamp(lo.min(hi), hi.max(lo))
}

/// Nachführung im log-Raum (Rate 0…1; ohne gültigen Vorwert sofort das Ziel).
pub fn adapt(prev: Option<f32>, target: f32, rate: f32) -> f32 {
    match prev.filter(|p| p.is_finite() && *p > 0.0) {
        Some(p) if rate < 1.0 => (p.log2() + (target.log2() - p.log2()) * rate.clamp(0.0, 1.0)).exp2(),
        _ => target,
    }
}

/// Referenz der Messung über die Akkumulation (`[rgb Summe, Zahl]` je Pixel): (Ziel, Mittel log2).
pub fn measure(accum: &[[f32; 4]], w: u32, h: u32, lo: f32, hi: f32) -> (f32, f32) {
    let mut hist = [0u32; HIST_BINS];
    for s in 0..GRID * GRID {
        let a = accum.get(grid_pixel(s, w, h)).copied().unwrap_or([0.0; 4]);
        let n = a[3].max(1.0);
        let lum = (0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2]) / n;
        hist[bin_of(lum)] += 1;
    }
    let m = mean_log2(&hist);
    (target(m, lo, hi), m)
}

/// Compute-Pass der Automatik: eine Arbeitsgruppe, Histogramm im gemeinsamen Speicher, Ergebnis in `expo[0]`
/// (x = Belichtung, y = 1 gültig, z = Ziel, w = Mittel log2). Parameter wie der Pfad (`P.expo`: y = Rate, z/w = Grenzen).
pub const EXPOSE_WGSL: &str = concat!(
    crate::pathtrace::wgsl_params!(),
    r#"
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> accum: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> expo: array<vec4<f32>>;

const BINS: u32 = 64u;
const LOG_MIN: f32 = -14.0;
const LOG_MAX: f32 = 6.0;
const GRID: u32 = 64u;
const PCT_LO: f32 = 0.4;
const PCT_HI: f32 = 0.95;
const KEY: f32 = 0.12;

var<workgroup> hist: array<atomic<u32>, 64>;

fn bin_of(lum: f32) -> u32 {
    if (!(lum > 0.0)) { return 0u; }
    let x = (log2(lum) - LOG_MIN) / (LOG_MAX - LOG_MIN) * f32(BINS);
    return min(u32(max(floor(x), 0.0)), BINS - 1u);
}

@compute @workgroup_size(256, 1, 1)
fn expose(@builtin(local_invocation_index) li: u32) {
    if (li < BINS) { atomicStore(&hist[li], 0u); }
    workgroupBarrier();
    let w = max(P.dims.x, 1u);
    let h = max(P.dims.y, 1u);
    for (var k = 0u; k < GRID * GRID / 256u; k = k + 1u) {
        let s = li + k * 256u;
        let x = min(u32((f32(s % GRID) + 0.5) * f32(w) / f32(GRID)), w - 1u);
        let y = min(u32((f32(s / GRID) + 0.5) * f32(h) / f32(GRID)), h - 1u);
        let a = accum[y * w + x];
        let lum = dot(a.rgb, vec3<f32>(0.2126, 0.7152, 0.0722)) / max(a.w, 1.0);
        atomicAdd(&hist[bin_of(lum)], 1u);
    }
    workgroupBarrier();
    if (li == 0u) {
        let total = f32(GRID * GRID);
        let lo = PCT_LO * total;
        let hi = PCT_HI * total;
        var acc = 0.0;
        var sum = 0.0;
        var cnt = 0.0;
        for (var b = 0u; b < BINS; b = b + 1u) {
            let n = f32(atomicLoad(&hist[b]));
            let a1 = acc + n;
            let take = max(min(a1, hi) - max(acc, lo), 0.0);
            sum = sum + take * (LOG_MIN + (f32(b) + 0.5) * (LOG_MAX - LOG_MIN) / f32(BINS));
            cnt = cnt + take;
            acc = a1;
        }
        let m = sum / max(cnt, 1.0);
        let tgt = clamp(KEY * exp2(-m), min(P.expo.z, P.expo.w), max(P.expo.z, P.expo.w));
        let prev = expo[0];
        var e = tgt;
        if (prev.y > 0.5 && prev.x > 0.0 && P.expo.y < 1.0) {
            e = exp2(mix(log2(prev.x), log2(tgt), clamp(P.expo.y, 0.0, 1.0)));
        }
        expo[0] = vec4<f32>(e, 1.0, tgt, m);
    }
}
"#
);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wgsl_valide_und_metal() {
        let module = naga::front::wgsl::parse_str(EXPOSE_WGSL).unwrap_or_else(|e| panic!("{}", e.emit_to_string(EXPOSE_WGSL)));
        use naga::valid::{Capabilities, ValidationFlags, Validator};
        let info = Validator::new(ValidationFlags::all(), Capabilities::empty()).validate(&module).expect("valide");
        let opts = naga::back::msl::Options { lang_version: (2, 1), ..Default::default() };
        naga::back::msl::write_string(&module, &info, &opts, &naga::back::msl::PipelineOptions::default()).expect("MSL");
        assert!(EXPOSE_WGSL.contains(&format!("const KEY: f32 = {KEY:?};")), "KEY gleich in Rust und WGSL");
    }

    #[test]
    fn faecher_und_perzentile() {
        assert_eq!(bin_of(0.0), 0);
        assert_eq!(bin_of(f32::NAN), 0);
        assert_eq!(bin_of(1e9), HIST_BINS - 1);
        let b = bin_of(1.0);
        assert!(bin_center(b) <= 0.2 && bin_center(b) >= -0.2, "{}", bin_center(b));
        // Alles gleich hell: Mittel = dieses Fach.
        let mut h = [0u32; HIST_BINS];
        h[b] = 100;
        assert!((mean_log2(&h) - bin_center(b)).abs() < 1e-6);
        // Wenige sehr helle Pixel (Sonnenflecken, ≤ 5 %) verschieben die Messung nicht.
        h[HIST_BINS - 1] = 5;
        assert!((mean_log2(&h) - bin_center(b)).abs() < 1e-6);
        // Leer: kein NaN.
        assert!(mean_log2(&[0; HIST_BINS]).is_finite());
    }

    #[test]
    fn innen_heller_als_aussen_und_sanft() {
        let (w, h) = (80u32, 50u32);
        let img = |l: f32| vec![[l, l, l, 1.0]; (w * h) as usize];
        let (out, _) = measure(&img(0.4), w, h, 0.2, 27.0);
        let (inn, _) = measure(&img(0.01), w, h, 0.2, 27.0);
        assert!(inn > out * 20.0, "{inn} vs {out}");
        // Grenzen halten.
        assert_eq!(measure(&img(1e-6), w, h, 0.2, 27.0).0, 27.0);
        assert_eq!(measure(&img(100.0), w, h, 0.2, 27.0).0, 0.2);
        // Mittelbild = Summe / Zahl: 4 Samples mit Summe 1.6 wie 1 Sample mit 0.4.
        let four = vec![[1.6, 1.6, 1.6, 4.0]; (w * h) as usize];
        assert_eq!(measure(&four, w, h, 0.2, 27.0), measure(&img(0.4), w, h, 0.2, 27.0));
        // Nachführung: monoton, im log-Raum, ohne Vorwert sofort.
        assert_eq!(adapt(None, 8.0, 0.15), 8.0);
        assert_eq!(adapt(Some(1.0), 8.0, 1.0), 8.0);
        let mut e = 1.0;
        for _ in 0..40 {
            let n = adapt(Some(e), 8.0, AUTO_RATE_TEST);
            assert!(n > e && n <= 8.0);
            e = n;
        }
        assert!((e - 8.0).abs() < 0.05, "{e}");
        assert!((adapt(Some(1.0), 4.0, 0.5) - 2.0).abs() < 1e-6, "halber Weg im log-Raum");
        // Kaputter Puffer / leeres Bild: endlich.
        assert!(measure(&[], 0, 0, 0.2, 27.0).0.is_finite());
    }

    const AUTO_RATE_TEST: f32 = crate::pathtrace::AUTO_EXPOSURE_RATE;
}
