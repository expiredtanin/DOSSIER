// [212] Pathtracer, GPU-freie Schicht: Parameter-Block (1:1 zum WGSL-`Params`), Himmel- und Sonnenmodell aus dem
// Sonnenstand, Kamera-Basis und die WGSL-Quellen (Compute-Shader der Pfadverfolgung, Anzeige mit Tonemapping).
// Die wgpu-Seite liegt in `gpu_pathtrace.rs` (Feature `render`), der Baum in `bvh.rs`.
//
// Bildmodell (Etappe 1): progressive Akkumulation, je Aufruf ein Sample je Pixel; Pfade mit höchstens
// `MAX_BOUNCES` Abprallern und Russian Roulette ab dem dritten; Next-Event-Estimation zur Sonne (Kegel mit
// `SUN_ANGULAR_RADIUS_DEG`, weiche Schatten); Glas als dünne Scheibe (Fresnel-Spiegelung oder gerader Durchgang,
// für Schattenstrahlen durchsichtig wie im Blender-Leser [211]); analytischer Himmel (Gradient Zenit → Horizont mit
// Aureole, Farbe und Helligkeit nach Sonnenhöhe); ACES-Tonemapping (Narkowicz) und sRGB in der Anzeige.
// Materialien aus der Vertexfarbe (`bvh::classify_material`): diffus (Lambert, Albedo linear ≤ 0.8), glänzend
// (Lambert unter einer GGX-Schicht, F0 0.04), Glas. Formeln: Möller–Trumbore, Binned-SAH (Wald 2007), GGX/Smith
// (Walter et al. 2007), PCG-Hash (Jarzynski & Olano 2020), Basis nach Duff et al. 2017 — nachgerechnet, kein Fremdcode.

use crate::types::{Camera, Projection};

/// Höchstzahl der Abpraller je Pfad.
pub const MAX_BOUNCES: u32 = 5;
/// Scheinbarer Sonnenradius (Grad). Die echte Sonne hat ≈ 0.27°; etwas grösser gibt weichere Schatten.
pub const SUN_ANGULAR_RADIUS_DEG: f32 = 0.5;
/// Bestrahlungsstärke der Sonne senkrecht, ohne Atmosphäre (Bildeinheiten; weisse Fläche bei 60° ≈ 1).
const SUN_IRRADIANCE: f32 = 3.0;
/// Belichtung vor dem Tonemapping.
pub const DEFAULT_EXPOSURE: f32 = 0.85;

/// Parameter-Block, 176 Byte, 1:1 zum WGSL-`Params` (nur `vec4`, std140-sicher).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
#[cfg_attr(feature = "render", derive(bytemuck::Pod, bytemuck::Zeroable))]
pub struct PtParams {
    /// Augpunkt; w = 1 orthografisch.
    pub cam_pos: [f32; 4],
    /// Blickrichtung; w = tan(fov/2) bzw. halbe Sichthöhe (ortho).
    pub cam_fwd: [f32; 4],
    /// Rechts; w = Seitenverhältnis.
    pub cam_right: [f32; 4],
    /// Oben.
    pub cam_up: [f32; 4],
    /// Richtung ZUR Sonne; w = cos(Sonnenradius).
    pub sun_dir: [f32; 4],
    /// Bestrahlungsstärke der Sonne (RGB); w = 1 Sonne an.
    pub sun_irr: [f32; 4],
    pub sky_zenith: [f32; 4],
    pub sky_horizon: [f32; 4],
    /// Boden unter dem Horizont (RGB); w = Belichtung.
    pub ground: [f32; 4],
    /// Breite, Höhe (intern), Sample-Nummer, Abpraller.
    pub dims: [u32; 4],
    /// Dreiecke, Breite, Höhe (Anzeige), 1 = sRGB im Shader kodieren.
    pub info: [u32; 4],
}

/// Himmel und Sonne aus der Richtung ZUR Sonne (world, Y oben).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Sky {
    pub sun_dir: [f32; 3],
    pub sun_irr: [f32; 3],
    pub sun_on: bool,
    pub zenith: [f32; 3],
    pub horizon: [f32; 3],
    pub ground: [f32; 3],
}

/// Himmel nach Sonnenstand: Sonnenfarbe über die Luftmasse (Kasten–Young) mit einer einfachen spektralen Dämpfung
/// (rot wenig, blau viel — tiefe Sonne warm), Himmelshelligkeit wächst mit der Sonnenhöhe. Ohne gültige Sonne
/// (None, NaN, unter dem Horizont) ein bedeckter, gleichmässiger Himmel ohne Sonne.
pub fn sky_for_sun(dir_to_sun: Option<[f32; 3]>) -> Sky {
    let dir = dir_to_sun.filter(|d| d.iter().all(|v| v.is_finite())).and_then(|d| {
        let l = (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).sqrt();
        (l > 1e-6 && d[1] / l > 0.0).then(|| [d[0] / l, d[1] / l, d[2] / l])
    });
    let Some(d) = dir else {
        return Sky {
            sun_dir: [0.0, 1.0, 0.0],
            sun_irr: [0.0; 3],
            sun_on: false,
            zenith: [0.55, 0.58, 0.62],
            horizon: [0.62, 0.64, 0.66],
            ground: [0.20, 0.19, 0.18],
        };
    };
    let el_deg = d[1].clamp(-1.0, 1.0).asin().to_degrees();
    // Luftmasse nach Kasten & Young (1989).
    let airmass = 1.0 / (d[1] + 0.50572 * (el_deg + 6.07995).powf(-1.6364));
    let beta = [0.035, 0.075, 0.17];
    let t = beta.map(|b| (-b * airmass).exp());
    let sun_irr = t.map(|c| c * SUN_IRRADIANCE);
    // Himmel: heller und blauer mit steigender Sonne; nahe am Horizont wärmer (Sonnenfarbe einmischen).
    let k = (d[1] * 1.4 + 0.12).clamp(0.12, 1.0);
    let warm = 1.0 - (el_deg / 25.0).clamp(0.0, 1.0);
    let zenith = [0.26 * k, 0.37 * k, 0.58 * k];
    let horizon = [
        (0.66 + 0.20 * warm * t[0]) * k * 0.85,
        (0.70 + 0.05 * warm * t[1]) * k * 0.85,
        (0.76 - 0.20 * warm) * k * 0.85,
    ];
    Sky { sun_dir: d, sun_irr, sun_on: true, zenith, horizon, ground: [0.18 * k, 0.17 * k, 0.15 * k] }
}

fn sub(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
fn cross(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}
fn norm(v: [f32; 3]) -> Option<[f32; 3]> {
    let l = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
    (l.is_finite() && l > 1e-12).then(|| [v[0] / l, v[1] / l, v[2] / l])
}

/// Kamera-Teil der Parameter wie `math::look_at` (rechts = Blick × oben). None bei unbrauchbarer Kamera.
pub fn camera_basis(cam: &Camera, aspect: f32) -> Option<([f32; 4], [f32; 4], [f32; 4], [f32; 4])> {
    if !(aspect.is_finite() && aspect > 0.0) {
        return None;
    }
    let f = norm(sub(cam.target, cam.eye))?;
    let r = norm(cross(f, cam.up))?;
    let u = cross(r, f);
    let (ortho, w) = match cam.projection {
        Projection::Perspective => (0.0, (cam.fov_y * 0.5).tan()),
        Projection::Orthographic => (1.0, cam.ortho_half_height),
    };
    if !(w.is_finite() && w > 0.0) || !cam.eye.iter().all(|v| v.is_finite()) {
        return None;
    }
    Some((
        [cam.eye[0], cam.eye[1], cam.eye[2], ortho],
        [f[0], f[1], f[2], w],
        [r[0], r[1], r[2], aspect],
        [u[0], u[1], u[2], 0.0],
    ))
}

/// Füllt den Parameter-Block. None bei unbrauchbarer Kamera (dann zeichnet der Pathtracer nicht).
pub fn build_params(cam: &Camera, sky: &Sky, internal: (u32, u32), display: (u32, u32), frame: u32, tri_count: u32, srgb_encode: bool) -> Option<PtParams> {
    let aspect = display.0 as f32 / display.1.max(1) as f32;
    let (cam_pos, cam_fwd, cam_right, cam_up) = camera_basis(cam, aspect)?;
    let cos_r = SUN_ANGULAR_RADIUS_DEG.to_radians().cos();
    let v4 = |c: [f32; 3], w: f32| [c[0], c[1], c[2], w];
    Some(PtParams {
        cam_pos,
        cam_fwd,
        cam_right,
        cam_up,
        sun_dir: v4(sky.sun_dir, cos_r),
        sun_irr: v4(sky.sun_irr, if sky.sun_on { 1.0 } else { 0.0 }),
        sky_zenith: v4(sky.zenith, 0.0),
        sky_horizon: v4(sky.horizon, 0.0),
        ground: v4(sky.ground, DEFAULT_EXPOSURE),
        dims: [internal.0, internal.1, frame, MAX_BOUNCES],
        info: [tri_count, display.0, display.1, srgb_encode as u32],
    })
}

/// Höchstzahl Pixel, die je Sample verfolgt werden (grössere Ansichten rechnen verkleinert und werden in der
/// Anzeige bilinear hochgezogen — Retina-Ansichten wären sonst zu langsam für die Vorschau).
pub const MAX_PIXELS: u64 = 1_200_000;

/// Interne Auflösung für eine Anzeige `w × h` bei höchstens `max_pixels` (und mindestens 1 × 1).
pub fn internal_size(w: u32, h: u32, max_pixels: u64) -> (u32, u32) {
    let (w, h) = (w.max(1), h.max(1));
    let px = w as u64 * h as u64;
    if px <= max_pixels.max(1) {
        return (w, h);
    }
    let s = (max_pixels.max(1) as f64 / px as f64).sqrt();
    (((w as f64 * s).floor() as u32).max(1), ((h as f64 * s).floor() as u32).max(1))
}

/// Compute-Shader der Pfadverfolgung: ein Sample je Pixel, aufaddiert in `accum` (rgb Summe, w Zahl).
pub const PT_WGSL: &str = r#"
struct Params {
    cam_pos: vec4<f32>,
    cam_fwd: vec4<f32>,
    cam_right: vec4<f32>,
    cam_up: vec4<f32>,
    sun_dir: vec4<f32>,
    sun_irr: vec4<f32>,
    sky_zenith: vec4<f32>,
    sky_horizon: vec4<f32>,
    ground: vec4<f32>,
    dims: vec4<u32>,
    info: vec4<u32>,
};
struct Node { bmin: vec3<f32>, left_first: u32, bmax: vec3<f32>, count: u32 };
struct Tri { v0: vec3<f32>, mat: u32, e1: vec3<f32>, rough: f32, e2: vec3<f32>, pad: u32 };

@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> nodes: array<Node>;
@group(0) @binding(2) var<storage, read> tris: array<Tri>;
@group(0) @binding(3) var<storage, read_write> accum: array<vec4<f32>>;

const NONE: u32 = 0xffffffffu;
const MISS: f32 = 1e30;
const PI: f32 = 3.14159265;
const MAT_GLOSSY: u32 = 1u;
const MAT_GLASS: u32 = 2u;

var<private> rng: u32;

fn pcg(v: u32) -> u32 {
    let s = v * 747796405u + 2891336453u;
    let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
    return (w >> 22u) ^ w;
}
fn rnd() -> f32 {
    rng = pcg(rng);
    return f32(rng >> 8u) * (1.0 / 16777216.0);
}

struct Hit { t: f32, tri: u32 };

fn box_hit(bmin: vec3<f32>, bmax: vec3<f32>, o: vec3<f32>, inv: vec3<f32>, tmax: f32) -> f32 {
    let a = (bmin - o) * inv;
    let b = (bmax - o) * inv;
    let lo = min(a, b);
    let hi = max(a, b);
    let t0 = max(max(lo.x, lo.y), max(lo.z, 0.0));
    let t1 = min(min(hi.x, hi.y), min(hi.z, tmax));
    if (t0 <= t1) { return t0; }
    return MISS;
}

fn tri_hit(tr: Tri, o: vec3<f32>, d: vec3<f32>, tmax: f32) -> f32 {
    let p = cross(d, tr.e2);
    let det = dot(tr.e1, p);
    if (abs(det) < 1e-12) { return -1.0; }
    let inv = 1.0 / det;
    let s = o - tr.v0;
    let u = dot(s, p) * inv;
    if (u < 0.0 || u > 1.0) { return -1.0; }
    let q = cross(s, tr.e1);
    let v = dot(d, q) * inv;
    if (v < 0.0 || u + v > 1.0) { return -1.0; }
    let t = dot(tr.e2, q) * inv;
    if (t > 1e-6 && t < tmax) { return t; }
    return -1.0;
}

// Nächster Treffer; `shadow` = beliebiger Treffer (Glas durchsichtig), Abbruch beim ersten.
fn trace(o: vec3<f32>, d: vec3<f32>, shadow: bool) -> Hit {
    var h: Hit;
    h.t = MISS;
    h.tri = NONE;
    if (P.info.x == 0u) { return h; }
    let inv = vec3<f32>(
        select(1e30 * sign(d.x), 1.0 / d.x, abs(d.x) > 1e-20),
        select(1e30 * sign(d.y), 1.0 / d.y, abs(d.y) > 1e-20),
        select(1e30 * sign(d.z), 1.0 / d.z, abs(d.z) > 1e-20));
    let root = nodes[0];
    if (box_hit(root.bmin, root.bmax, o, inv, h.t) >= MISS) { return h; }
    var stack: array<u32, 64>;
    var sp: u32 = 0u;
    var ni: u32 = 0u;
    loop {
        let n = nodes[ni];
        if (n.count > 0u) {
            for (var i = n.left_first; i < n.left_first + n.count; i = i + 1u) {
                let tr = tris[i];
                if (shadow && (tr.mat >> 24u) == MAT_GLASS) { continue; }
                let t = tri_hit(tr, o, d, h.t);
                if (t > 0.0) {
                    h.t = t;
                    h.tri = i;
                    if (shadow) { return h; }
                }
            }
            if (sp == 0u) { break; }
            sp = sp - 1u;
            ni = stack[sp];
            continue;
        }
        var c0 = n.left_first;
        var c1 = c0 + 1u;
        let n0 = nodes[c0];
        let n1 = nodes[c1];
        var t0 = box_hit(n0.bmin, n0.bmax, o, inv, h.t);
        var t1 = box_hit(n1.bmin, n1.bmax, o, inv, h.t);
        if (t1 < t0) {
            let tt = t0; t0 = t1; t1 = tt;
            let cc = c0; c0 = c1; c1 = cc;
        }
        if (t0 >= MISS) {
            if (sp == 0u) { break; }
            sp = sp - 1u;
            ni = stack[sp];
            continue;
        }
        ni = c0;
        if (t1 < MISS && sp < 64u) {
            stack[sp] = c1;
            sp = sp + 1u;
        }
    }
    return h;
}

// Orthonormalbasis um n (Duff et al. 2017).
fn basis(n: vec3<f32>) -> mat3x3<f32> {
    let s = select(-1.0, 1.0, n.z >= 0.0);
    let a = -1.0 / (s + n.z);
    let b = n.x * n.y * a;
    let t = vec3<f32>(1.0 + s * n.x * n.x * a, s * b, -s * n.x);
    let bt = vec3<f32>(b, s + n.y * n.y * a, -n.y);
    return mat3x3<f32>(t, bt, n);
}

fn cosine_dir(n: vec3<f32>) -> vec3<f32> {
    let r1 = rnd();
    let r2 = rnd();
    let phi = 2.0 * PI * r1;
    let r = sqrt(r2);
    let l = vec3<f32>(r * cos(phi), r * sin(phi), sqrt(max(0.0, 1.0 - r2)));
    return normalize(basis(n) * l);
}

fn cone_dir(axis: vec3<f32>, cos_max: f32) -> vec3<f32> {
    let r1 = rnd();
    let r2 = rnd();
    let c = 1.0 - r1 * (1.0 - cos_max);
    let s = sqrt(max(0.0, 1.0 - c * c));
    let phi = 2.0 * PI * r2;
    return normalize(basis(axis) * vec3<f32>(s * cos(phi), s * sin(phi), c));
}

fn unpack_albedo(m: u32) -> vec3<f32> {
    return vec3<f32>(f32(m & 255u), f32((m >> 8u) & 255u), f32((m >> 16u) & 255u)) * (1.0 / 255.0);
}

fn fresnel(f0: vec3<f32>, c: f32) -> vec3<f32> {
    return f0 + (vec3<f32>(1.0) - f0) * pow(clamp(1.0 - c, 0.0, 1.0), 5.0);
}

fn ggx_d(noh: f32, a: f32) -> f32 {
    let a2 = a * a;
    let k = noh * noh * (a2 - 1.0) + 1.0;
    return a2 / max(PI * k * k, 1e-8);
}

fn smith_g(nov: f32, nol: f32, a: f32) -> f32 {
    let k = a * 0.5;
    return (nov / (nov * (1.0 - k) + k)) * (nol / (nol * (1.0 - k) + k));
}

// BRDF (für NEE): diffus Lambert; glänzend = Lambert mit dielektrischer GGX-Schicht (F0 0.04, Rauigkeit je
// Dreieck) — lackierte/beschichtete Oberflächen wie Fensterrahmen.
fn brdf(kind: u32, albedo: vec3<f32>, rough: f32, n: vec3<f32>, wo: vec3<f32>, wi: vec3<f32>) -> vec3<f32> {
    let diffuse = albedo * (1.0 / PI);
    if (kind == MAT_GLOSSY) {
        let a = max(rough * rough, 0.002);
        let h = normalize(wo + wi);
        let nov = max(dot(n, wo), 1e-4);
        let nol = max(dot(n, wi), 1e-4);
        let noh = max(dot(n, h), 0.0);
        let f = fresnel(vec3<f32>(0.04), max(dot(wo, h), 0.0));
        return diffuse * (1.0 - 0.04) + f * ggx_d(noh, a) * smith_g(nov, nol, a) / (4.0 * nov * nol);
    }
    return diffuse;
}

// Himmel; `primary` = Blickstrahl: unter dem Horizont Dunst statt Boden (heller Hintergrund wie die übrigen Stile).
fn sky(d: vec3<f32>, with_sun: bool, primary: bool) -> vec3<f32> {
    let s = P.sun_dir.xyz;
    let up = clamp(d.y, -1.0, 1.0);
    let hz = pow(1.0 - max(up, 0.0), 4.0);
    var c = mix(P.sky_zenith.rgb, P.sky_horizon.rgb, hz);
    let cs = max(dot(d, s), 0.0);
    c = c + P.sun_irr.rgb * P.sun_irr.w * (0.03 * pow(cs, 8.0) + 0.25 * pow(cs, 300.0));
    if (up < 0.0 && !primary) {
        c = mix(c, P.ground.rgb, smoothstep(0.0, 0.06, -up));
    }
    if (with_sun && P.sun_irr.w > 0.5 && dot(d, s) >= P.sun_dir.w) {
        c = c + P.sun_irr.rgb / (2.0 * PI * max(1.0 - P.sun_dir.w, 1e-6));
    }
    return c;
}

fn radiance(o_in: vec3<f32>, d_in: vec3<f32>) -> vec3<f32> {
    var o = o_in;
    var d = d_in;
    var tp = vec3<f32>(1.0);
    var l = vec3<f32>(0.0);
    var specular = true;
    for (var b = 0u; b < P.dims.w; b = b + 1u) {
        let h = trace(o, d, false);
        if (h.tri == NONE) {
            l = l + tp * sky(d, specular, b == 0u);
            break;
        }
        let tr = tris[h.tri];
        let kind = tr.mat >> 24u;
        let albedo = unpack_albedo(tr.mat);
        var n = normalize(cross(tr.e1, tr.e2));
        if (dot(n, d) > 0.0) { n = -n; }
        let p = o + d * h.t;
        let eps = 1e-4 * max(1.0, max(abs(p.x), max(abs(p.y), abs(p.z))));
        if (kind == MAT_GLASS) {
            // Dünne Scheibe: Spiegelung mit Fresnel (beide Grenzflächen), sonst gerader Durchgang, leicht getönt.
            let f = fresnel(vec3<f32>(0.04), abs(dot(d, n))).x;
            let rt = 2.0 * f / (1.0 + f);
            if (rnd() < rt) {
                d = reflect(d, n);
                o = p + n * eps;
            } else {
                o = p - n * eps;
                let tint = albedo / max(max(albedo.x, max(albedo.y, albedo.z)), 1e-3);
                tp = tp * mix(vec3<f32>(1.0), tint, 0.15);
            }
            continue;
        }
        let wo = -d;
        // Next-Event-Estimation zur Sonne (Kegel → weiche Schatten).
        if (P.sun_irr.w > 0.5) {
            let ls = cone_dir(P.sun_dir.xyz, P.sun_dir.w);
            let ndl = dot(n, ls);
            if (ndl > 0.0) {
                let sh = trace(p + n * eps, ls, true);
                if (sh.tri == NONE) {
                    l = l + tp * brdf(kind, albedo, tr.rough, n, wo, ls) * P.sun_irr.rgb * ndl;
                }
            }
        }
        // Nächste Richtung.
        // Glänzend: Spiegel-Lobe mit Wahrscheinlichkeit nach Fresnel wählen, sonst diffus (Gewicht / Wahl).
        let nov0 = max(dot(n, wo), 1e-4);
        let p_spec = select(0.0, clamp(fresnel(vec3<f32>(0.04), nov0).x * 4.0, 0.1, 0.9), kind == MAT_GLOSSY);
        if (kind == MAT_GLOSSY && rnd() < p_spec) {
            let a = max(tr.rough * tr.rough, 0.002);
            let r1 = rnd();
            let r2 = rnd();
            let ct = sqrt((1.0 - r1) / (1.0 + (a * a - 1.0) * r1));
            let st = sqrt(max(0.0, 1.0 - ct * ct));
            let phi = 2.0 * PI * r2;
            let hv = normalize(basis(n) * vec3<f32>(st * cos(phi), st * sin(phi), ct));
            let wi = reflect(-wo, hv);
            let nol = dot(n, wi);
            if (nol <= 0.0) { break; }
            let nov = max(dot(n, wo), 1e-4);
            let voh = max(dot(wo, hv), 1e-4);
            let noh = max(dot(n, hv), 1e-4);
            tp = tp * fresnel(vec3<f32>(0.04), voh) * smith_g(nov, nol, a) * voh / (noh * nov) / p_spec;
            d = wi;
        } else {
            d = cosine_dir(n);
            tp = tp * albedo / (1.0 - p_spec);
            if (kind == MAT_GLOSSY) { tp = tp * (1.0 - 0.04); }
        }
        o = p + n * eps;
        specular = false;
        if (b >= 2u) {
            let q = clamp(max(tp.x, max(tp.y, tp.z)), 0.05, 0.95);
            if (rnd() > q) { break; }
            tp = tp / q;
        }
    }
    return l;
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let w = P.dims.x;
    let h = P.dims.y;
    if (gid.x >= w || gid.y >= h) { return; }
    let idx = gid.y * w + gid.x;
    rng = pcg(idx ^ pcg(P.dims.z * 2654435769u + 0x68e31da4u));
    let sx = ((f32(gid.x) + rnd()) / f32(w)) * 2.0 - 1.0;
    let sy = 1.0 - ((f32(gid.y) + rnd()) / f32(h)) * 2.0;
    var o = P.cam_pos.xyz;
    var d = P.cam_fwd.xyz;
    if (P.cam_pos.w > 0.5) {
        let hh = P.cam_fwd.w;
        o = o + P.cam_right.xyz * (sx * hh * P.cam_right.w) + P.cam_up.xyz * (sy * hh);
    } else {
        let th = P.cam_fwd.w;
        d = normalize(P.cam_fwd.xyz + P.cam_right.xyz * (sx * th * P.cam_right.w) + P.cam_up.xyz * (sy * th));
    }
    var c = radiance(o, d);
    // Ausreisser (Sonnenspiegelungen über mehrere Abpraller) begrenzen; NaN verwerfen.
    c = clamp(c, vec3<f32>(0.0), vec3<f32>(64.0));
    if (!(c.x == c.x && c.y == c.y && c.z == c.z)) { c = vec3<f32>(0.0); }
    var prev = vec4<f32>(0.0);
    if (P.dims.z > 0u) { prev = accum[idx]; }
    accum[idx] = prev + vec4<f32>(c, 1.0);
}
"#;

/// Anzeige: Vollbild-Dreieck, liest die Akkumulation (bilinear auf die Anzeigegrösse), Mittel, Belichtung,
/// ACES (Narkowicz 2015) und — bei Ziel ohne sRGB-Format (WebGPU-Canvas) — sRGB-Kodierung.
pub const PT_DISPLAY_WGSL: &str = r#"
struct Params {
    cam_pos: vec4<f32>,
    cam_fwd: vec4<f32>,
    cam_right: vec4<f32>,
    cam_up: vec4<f32>,
    sun_dir: vec4<f32>,
    sun_irr: vec4<f32>,
    sky_zenith: vec4<f32>,
    sky_horizon: vec4<f32>,
    ground: vec4<f32>,
    dims: vec4<u32>,
    info: vec4<u32>,
};
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> accum: array<vec4<f32>>;

@vertex
fn vs_main(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
    let x = f32((i << 1u) & 2u) * 2.0 - 1.0;
    let y = f32(i & 2u) * 2.0 - 1.0;
    return vec4<f32>(x, y, 0.0, 1.0);
}

fn texel(x: i32, y: i32) -> vec3<f32> {
    let w = i32(P.dims.x);
    let h = i32(P.dims.y);
    let cx = clamp(x, 0, w - 1);
    let cy = clamp(y, 0, h - 1);
    let a = accum[u32(cy * w + cx)];
    return a.rgb / max(a.w, 1.0);
}

fn aces(x: vec3<f32>) -> vec3<f32> {
    return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), vec3<f32>(0.0), vec3<f32>(1.0));
}

fn to_srgb(c: vec3<f32>) -> vec3<f32> {
    let lo = c * 12.92;
    let hi = 1.055 * pow(c, vec3<f32>(1.0 / 2.4)) - 0.055;
    return select(hi, lo, c <= vec3<f32>(0.0031308));
}

@fragment
fn fs_main(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
    let sx = f32(P.dims.x) / f32(max(P.info.y, 1u));
    let sy = f32(P.dims.y) / f32(max(P.info.z, 1u));
    let fx = pos.x * sx - 0.5;
    let fy = pos.y * sy - 0.5;
    let x0 = i32(floor(fx));
    let y0 = i32(floor(fy));
    let tx = fx - floor(fx);
    let ty = fy - floor(fy);
    let c = mix(mix(texel(x0, y0), texel(x0 + 1, y0), tx), mix(texel(x0, y0 + 1), texel(x0 + 1, y0 + 1), tx), ty);
    var m = aces(c * P.ground.w);
    if (P.info.w == 1u) { m = to_srgb(m); }
    return vec4<f32>(m, 1.0);
}
"#;

#[cfg(test)]
mod tests {
    use super::*;

    fn validate(src: &str, name: &str) -> naga::Module {
        use naga::valid::{Capabilities, ValidationFlags, Validator};
        let module = naga::front::wgsl::parse_str(src).unwrap_or_else(|e| panic!("{name}: WGSL-Parse-Fehler: {}", e.emit_to_string(src)));
        Validator::new(ValidationFlags::all(), Capabilities::empty())
            .validate(&module)
            .unwrap_or_else(|e| panic!("{name}: WGSL-Validierung fehlgeschlagen: {e:?}"));
        module
    }

    #[test]
    fn wgsl_pathtracer_valide() {
        let m = validate(PT_WGSL, "pathtrace");
        assert!(m.entry_points.iter().any(|e| e.name == "main"));
        let m = validate(PT_DISPLAY_WGSL, "pathtrace.display");
        assert_eq!(m.entry_points.len(), 2);
    }

    /// Metal ist auf dem Linux-Container nicht prüfbar; die Übersetzung nach MSL (wie wgpu sie auf dem Mac macht)
    /// zeigt aber, dass die Shader für das Metal-Backend taugen.
    #[test]
    fn wgsl_pathtracer_nach_msl() {
        use naga::back::msl;
        use naga::valid::{Capabilities, ValidationFlags, Validator};
        for (src, name) in [(PT_WGSL, "pathtrace"), (PT_DISPLAY_WGSL, "display")] {
            let module = naga::front::wgsl::parse_str(src).unwrap();
            let info = Validator::new(ValidationFlags::all(), Capabilities::empty()).validate(&module).unwrap();
            let opts = msl::Options { lang_version: (2, 1), ..Default::default() };
            let pipe = msl::PipelineOptions::default();
            let (out, _) = msl::write_string(&module, &info, &opts, &pipe).unwrap_or_else(|e| panic!("{name}: MSL: {e:?}"));
            assert!(out.contains("kernel") || out.contains("fragment"), "{name}");
        }
    }

    #[test]
    fn parameter_block_passt_zum_shader() {
        assert_eq!(std::mem::size_of::<PtParams>(), 176);
        assert_eq!(std::mem::size_of::<crate::bvh::GpuNode>(), 32);
        assert_eq!(std::mem::size_of::<crate::bvh::GpuTri>(), 48);
    }

    #[test]
    fn himmel_nach_sonnenstand() {
        let high = sky_for_sun(crate::shadow::sun_dir_world(180.0, 60.0));
        let low = sky_for_sun(crate::shadow::sun_dir_world(180.0, 5.0));
        assert!(high.sun_on && low.sun_on);
        // Tiefe Sonne: schwächer und wärmer (Verhältnis rot/blau grösser).
        assert!(low.sun_irr[1] < high.sun_irr[1]);
        assert!(low.sun_irr[0] / low.sun_irr[2] > high.sun_irr[0] / high.sun_irr[2]);
        assert!(high.zenith[2] > low.zenith[2]);
        for s in [high, low] {
            for v in s.sun_irr.iter().chain(&s.zenith).chain(&s.horizon).chain(&s.ground) {
                assert!(v.is_finite() && *v >= 0.0);
            }
        }
        // Keine/kaputte Sonne: bedeckt, ohne Sonne.
        for d in [None, Some([f32::NAN, 1.0, 0.0]), Some([0.0, -1.0, 0.0]), Some([0.0; 3])] {
            let s = sky_for_sun(d);
            assert!(!s.sun_on);
            assert_eq!(s.sun_irr, [0.0; 3]);
        }
    }

    #[test]
    fn kamera_und_groesse() {
        let cam = Camera::default();
        let (pos, fwd, right, up) = camera_basis(&cam, 1.5).unwrap();
        assert_eq!(pos[3], 0.0);
        let d = |a: [f32; 4], b: [f32; 4]| a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
        assert!(d(fwd, right).abs() < 1e-6 && d(fwd, up).abs() < 1e-6 && d(right, up).abs() < 1e-6);
        assert!(up[1] > 0.0, "oben zeigt nach oben");
        // Unbrauchbar: Blick entlang up, NaN, Seitenverhältnis 0.
        let mut bad = cam;
        bad.target = [8.0, 0.0, 8.0];
        bad.up = [0.0, 1.0, 0.0];
        assert!(camera_basis(&bad, 1.0).is_none());
        assert!(camera_basis(&cam, 0.0).is_none());
        let mut nan = cam;
        nan.eye[0] = f32::NAN;
        assert!(camera_basis(&nan, 1.0).is_none());
        assert_eq!(internal_size(800, 600, MAX_PIXELS), (800, 600));
        let (w, h) = internal_size(3000, 2000, MAX_PIXELS);
        assert!((w as u64 * h as u64) <= MAX_PIXELS && w > h);
        assert_eq!(internal_size(0, 0, 0), (1, 1));
    }
}
