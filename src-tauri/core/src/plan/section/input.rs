//! Eingabe des analytischen Prismen-Schnitts: Wände und Platten aus `model3d` in die Eingabe-Typen von
//! `render3d::section` umsetzen, mit der Zahl-Rundung der früheren JSON-Reise (f32 ↔ f64), damit die
//! Ausgabe bitgleich bleibt. Aufgerufen von `compute_section()` (`mod.rs`) und der Projektion.

use super::*;

/// f32 aus render3d wie über JSON gereist: kürzeste Dezimaldarstellung, als f64 gelesen.
pub(super) fn js_f32(x: f32) -> f64 {
    if !x.is_finite() {
        return 0.0; // JSON `null` → 0 in der Arithmetik
    }
    // serde_json schrieb f32 mit der kürzesten Darstellung (Gleichstand → gerade Ziffer), JS las sie.
    zmij::Buffer::new().format_finite(x).parse::<f64>().unwrap_or(0.0)
}

pub(super) fn kind_of(k: render3d::ComponentKind) -> Kind {
    match k {
        render3d::ComponentKind::Wall => Kind::Wall,
        render3d::ComponentKind::Slab => Kind::Slab,
        render3d::ComponentKind::Roof => Kind::Roof,
    }
}

/// Zehnerpotenzen wie `POW10` in serde_json (Literale `1e0` … `1e308`).
fn pow10(k: usize) -> f64 {
    use std::sync::OnceLock;
    static T: OnceLock<Vec<f64>> = OnceLock::new();
    T.get_or_init(|| (0..=308).map(|i| format!("1e{i}").parse::<f64>().unwrap_or(f64::INFINITY)).collect())[k]
}

/// Zahl, wie sie früher über JSON in den render3d-Schnitt reiste: JS schreibt die kürzeste
/// Dezimaldarstellung, serde_json (dort ohne `float_roundtrip`) liest sie als Ganzzahl-Mantisse
/// mal Zehnerpotenz und rundet dann auf f32. Bitgleich zur alten Eingabe (auch wo die Lesung
/// um eine Stelle daneben liegt).
pub(super) fn json_f32(x: f64) -> f32 {
    if x == 0.0 || !x.is_finite() {
        return 0.0;
    }
    if x.fract() == 0.0 && x.abs() < 1e21 {
        return x as f32; // JS schreibt eine Ganzzahl, serde liest u64/i64
    }
    // Schnellweg: im Bereich 1e-6..1e14 liegt die Lesung (≤ 17 Ziffern, Zehnerpotenz exakt) höchstens
    // wenige f64-Stellen neben `x`. Liegt `x` weit genug von jeder f32-Rundungsgrenze, rundet sie
    // genau wie `x` selbst.
    let ax = x.abs();
    let y = x as f32;
    if y.is_finite() && (1e-6..1e14).contains(&ax) {
        let yf = y as f64;
        let room = if x >= yf { (y.next_up() as f64 - yf) / 2.0 - (x - yf) } else { (yf - y.next_down() as f64) / 2.0 - (yf - x) };
        if room > 1e-13 * ax {
            return y;
        }
    }
    json_f32_read(x)
}

/// Die eigentliche Lesung (ohne Schnellweg).
pub(super) fn json_f32_read(x: f64) -> f32 {
    // Ziffern und Exponent der kürzesten Darstellung (wie JS: Gleichstand → gerade Ziffer; zmij wie
    // in serde_json).
    let mut buf = zmij::Buffer::new();
    let s = buf.format_finite(x.abs());
    let (mant, exp) = s.split_once(['e', 'E']).unwrap_or((s, "0"));
    let (int_part, frac_part) = mant.split_once('.').unwrap_or((mant, ""));
    let digits = format!("{int_part}{frac_part}");
    let mut exponent: i32 = exp.parse::<i32>().unwrap_or(0) - frac_part.len() as i32;
    let sig: u64 = digits.parse().unwrap_or(0);
    let mut f = sig as f64;
    loop {
        let k = exponent.unsigned_abs() as usize;
        if k <= 308 {
            if exponent >= 0 {
                f *= pow10(k);
            } else {
                f /= pow10(k);
            }
            break;
        }
        if f == 0.0 || exponent >= 0 {
            break;
        }
        f /= 1e308;
        exponent += 308;
    }
    (if x < 0.0 { -f } else { f }) as f32
}

fn f32s2(v: [f64; 2]) -> [f32; 2] {
    [json_f32(v[0]), json_f32(v[1])]
}

fn f32s3(v: [f64; 3]) -> [f32; 3] {
    [json_f32(v[0]), json_f32(v[1]), json_f32(v[2])]
}

pub(super) fn wall_input(w: &RWall) -> render3d::WallInput {
    render3d::WallInput {
        start: f32s2(w.start),
        end: f32s2(w.end),
        thickness: json_f32(w.thickness),
        height: json_f32(w.height),
        base_elevation: json_f32(w.base_elevation),
        top_drop: w.top_drop.map_or([0.0, 0.0], f32s2),
        top_plane: w.top_plane.map(f32s3),
        color: f32s3(w.color),
        openings: Vec::new(),
        layers: Some(Vec::new()),
        holes: w
            .holes
            .as_deref()
            .unwrap_or(&[])
            .iter()
            .map(|h| render3d::types::Hole { from: json_f32(h.from), to: json_f32(h.to), z_bottom: json_f32(h.z_bottom), z_top: json_f32(h.z_top) })
            .collect(),
        material_index: None,
        hatch: None,
        cut: None,
        start_cut: w.start_cut.map(f32s4),
        end_cut: w.end_cut.map(f32s4),
        arc_center: None,
    }
}

fn f32s4(v: [f64; 4]) -> [f32; 4] {
    [json_f32(v[0]), json_f32(v[1]), json_f32(v[2]), json_f32(v[3])]
}

pub(super) fn slab_input(s: &RSlab) -> render3d::SlabInput {
    render3d::SlabInput {
        outline: s.outline.iter().map(|q| f32s2(*q)).collect(),
        z_bottom: json_f32(s.z_bottom),
        z_top: json_f32(s.z_top),
        color: f32s3(s.color),
        hatch: None,
        cut: None,
        monolith: s.monolith.clone(),
    }
}
