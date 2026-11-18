//! [266] 3D-Dokument: Vektor-Axonometrie bzw. -Perspektive mit verdeckten Kanten aus dem Kern — eine Linienzeichnung
//! des Modells aus einer beliebigen Kamera (wie das „3D-Dokument“ in Archicad), ohne GPU (CLI, Linux, Plakat, PDF).
//!
//! Rechenweg: dieselben Körper wie die Projektion hinter dem Schnitt (`section::model_view_faces`: Wände samt
//! Gehrung und Löchern, Platten, Treppen, Dächer, freie Körper, auf Wunsch importierte Netze) werden in
//! Ansichtskoordinaten `(u, v, Tiefe)` gebracht und mit der exakten Sichtbarkeit (`hlr.rs`, [G4]: Kanten gegen Flächen,
//! Durchdringungslinien, Rasterteilung) verdeckt; die sichtbaren Teilflächen (`hlr_fill.rs`) werden nach ihrer Lage
//! zum Licht hell grau getönt. Kanten, die an den Hintergrund grenzen, sind Silhouette (stärker).
//!
//! Projektionen ([`Projection`]):
//! - **Parallel** (`u, v, Tiefe` = lineare Abbildung): Isometrie und Kamera-Parallelprojektion (orthonormal) sowie
//!   Militärprojektion 45°/45° und 30°/60° (schiefe Parallelprojektion: Grundriss unverzerrt gedreht, Senkrechte
//!   unverkürzt). Normalen gehen über die inverse Transponierte, damit „zugewandt“ auch schief stimmt.
//! - **Perspektive**: Kamera-Koordinaten, an der Nahebene und am Bildrahmen zugeschnitten, dann projektiv nach
//!   `(x·z₀/z, y·z₀/z, z₀ − z₀²/z)` — eine projektive Abbildung erhält Ebenen, also bleibt die Sichtbarkeit exakt;
//!   `z₀` = Abstand zur Modellmitte, dort ist die Zeichnung massstäblich.
//!
//! Vorgaben (Blick von …): `southeast`, `southwest`, `northeast`, `northwest`, `south` … (Norden = +y), dazu die
//! Blickwinkel der 3D-Ansicht (`iso` = Südost, `isoFrontLeft` = Südwest, `isoBackRight` = Nordost, `isoBackLeft` =
//! Nordwest, `front` = Süd, `back`, `side` = Ost, `left`, `top`); eine Tabelle für alle Wege: `render3d::view_dir` ([270]).
//!
//! Klassen ([180]): jede Linie und Fläche gehört zu einem Bauteil und verschwindet mit dessen Klasse (Bauteile
//! ausgeblendeter Klassen nehmen an der Verdeckung nicht teil).

use super::prim::Primitive;
use super::section::{line, polygon, v2, Kind, OwnerRef, Visibility};
use super::style::no_hatch;
use crate::hlr;
use crate::model::*;
use std::collections::BTreeMap;

type V3 = [f64; 3];

/// Sichtbare Kanten.
const EDGE_MM: f64 = 0.18;
const EDGE_INK: &str = "#2b3039";
/// Silhouette (Kante gegen den Hintergrund).
const OUTLINE_MM: f64 = 0.35;
const OUTLINE_INK: &str = "#1f242c";
const HIDDEN_MM: f64 = 0.13;
const HIDDEN_INK: &str = "#8a929c";
/// Höchstens so viele Flächen rechnen; darüber entfallen zuerst die Kontext-Netze, dann gibt es kein Bild.
pub const FACE_BUDGET: usize = 400_000;
/// Höchstens so viele zugewandte Flächen werden exakt getönt; darüber bleibt es bei den Linien.
pub const FILL_BUDGET: usize = 30_000;

fn dot(a: V3, b: V3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
fn cross(a: V3, b: V3) -> V3 {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}
fn norm(a: V3) -> f64 {
    dot(a, a).sqrt()
}
fn unit(a: V3) -> Option<V3> {
    let l = norm(a);
    (l > 1e-12 && l.is_finite()).then(|| [a[0] / l, a[1] / l, a[2] / l])
}
fn sub(a: V3, b: V3) -> V3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
fn finite3(a: V3) -> bool {
    a.iter().all(|v| v.is_finite())
}

/// Abbildung Modell (x, y, z = Höhe) → Zeichnung.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Projection {
    /// `(u, v, Tiefe) = m · (p − o)`; Tiefe wächst vom Betrachter weg.
    Parallel { m: [V3; 3], o: V3 },
    /// Zentralprojektion: Auge, Basis rechts/oben/vorwärts, Bildebene `zref`, halbe Bildhöhe (Winkel als Tangens), Seitenverhältnis.
    Perspective { eye: V3, r: V3, u: V3, f: V3, zref: f64, tan_half: f64, aspect: f64 },
}

/// Parallelprojektion einer Kamera (Blickrichtung, Up) mit Ursprung `o`.
fn camera_basis(dir: V3, up: V3) -> Option<(V3, V3, V3)> {
    let f = unit(dir)?;
    let r = unit(cross(f, up)).or_else(|| unit(cross(f, [0.0, 1.0, 0.0])))?;
    let u = cross(r, f);
    Some((r, u, f))
}

/// Vorgabe nach Name (`view`) und Projektionsart (`kind`: `iso`, `military` = 45°/45°, `military30` = 30°/60°).
/// [270] Richtungen aus der gemeinsamen Tabelle `render3d::view_dir` (wie 3D-Fenster, Cycles, Blender): „Südost“ =
/// Betrachter im Südosten; `iso` = Südost, `front` = von Süden; leerer Name = Südost.
pub fn preset(view: &str, kind: &str) -> Option<Projection> {
    let d = render3d::view_dir::view_dir(if view.is_empty() { "southeast" } else { view })?;
    let t = d.to_viewer;
    let hl = t[0].hypot(t[1]);
    // Diagonale Blicke (Ecke) als Iso/Militär; senkrechte Ansichten und Draufsicht als Parallelprojektion.
    let corner = (hl > 1e-9 && t[0].abs() > 1e-9 && t[1].abs() > 1e-9).then(|| [t[0] / hl, t[1] / hl]);
    let Some(h) = corner else {
        let (r, u, f) = camera_basis([-t[0], -t[1], -t[2]], render3d::view_dir::up_of(&d))?;
        return Some(Projection::Parallel { m: [r, u, f], o: [0.0; 3] });
    };
    // Rechts (vom Betrachter aus) und vorwärts in der Ebene.
    let fwd = [-h[0], -h[1]];
    let right = [fwd[1], -fwd[0]];
    match kind {
        "military" | "military45" | "military30" => {
            let (mut r2, mut f2) = (right, fwd);
            if kind == "military30" {
                // 30°/60°: so drehen, dass die x-Fassaden (Süd/Nord) flach (30°) liegen.
                let rot = |a: [f64; 2], t: f64| [a[0] * t.cos() - a[1] * t.sin(), a[0] * t.sin() + a[1] * t.cos()];
                let t = 15f64.to_radians();
                let (ra, rb) = (rot(right, t), rot(right, -t));
                let k = if ra[0].abs() >= rb[0].abs() { t } else { -t };
                r2 = rot(right, k);
                f2 = rot(fwd, k);
            }
            let row_u = [r2[0], r2[1], 0.0];
            let row_v = [f2[0], f2[1], 1.0];
            let c = cross(row_u, row_v);
            let d = unit([-c[0], -c[1], -c[2]])?;
            Some(Projection::Parallel { m: [row_u, row_v, d], o: [0.0; 3] })
        }
        _ => {
            // Isometrie: Höhenwinkel asin(1/√3) ≈ 35.26° (wie `view_dir`).
            let s = std::f64::consts::FRAC_1_SQRT_2;
            let e = [h[0], h[1], s];
            let (r, u, f) = camera_basis([-e[0], -e[1], -e[2]], [0.0, 0.0, 1.0])?;
            Some(Projection::Parallel { m: [r, u, f], o: [0.0; 3] })
        }
    }
}

/// Kamera in Modell-Koordinaten wie `ViewCamera` der 3D-Ansicht (`viewport/cameraBridge.ts`): `kind`
/// („perspective“/„orthogonal“), `position`, `direction`, `up`, `fovDeg`; `aspect` = Breite/Höhe des Bildrahmens.
/// `center`: Modellmitte (Abstand der massstäblichen Bildebene der Perspektive).
pub fn camera(kind: &str, position: V3, direction: V3, up: V3, fov_deg: f64, aspect: f64, center: V3) -> Option<Projection> {
    if !(finite3(position) && finite3(direction) && finite3(up)) {
        return None;
    }
    let (r, u, f) = camera_basis(direction, up)?;
    if kind != "perspective" {
        return Some(Projection::Parallel { m: [r, u, f], o: position });
    }
    let fov = if fov_deg.is_finite() && fov_deg > 0.0 { fov_deg.clamp(5.0, 150.0) } else { 50.0 };
    let aspect = if aspect.is_finite() && aspect > 0.0 { aspect.clamp(0.2, 5.0) } else { 1.5 };
    let zref = dot(sub(center, position), f);
    let zref = if zref.is_finite() && zref > 1.0 { zref } else { 10.0 };
    Some(Projection::Perspective { eye: position, r, u, f, zref, tan_half: (fov.to_radians() / 2.0).tan(), aspect })
}

/// Kamera-Element des Projekts ([213]) wie `renderCameraOf` (`export/blenderRender.ts`): Standpunkt = Fussboden des
/// Geschosses + Augenhöhe, Blick zum Ziel, Up aus der Senkrechten.
pub fn project_camera(p: &Project, id: &str, aspect: f64, center: V3) -> Option<Projection> {
    let cam = p.cameras.as_deref()?.iter().find(|c| c.id == id)?;
    let base = p.drawing_levels.iter().find(|l| l.id == cam.floor_id).and_then(|l| l.base_elevation).filter(|b| b.is_finite()).unwrap_or(0.0);
    let eye = [cam.position.x, cam.position.y, base + if cam.eye_height.is_finite() { cam.eye_height } else { 1.6 }];
    let tgt = [cam.target.x, cam.target.y, cam.target_height];
    let d = unit(sub(tgt, eye))?;
    let up = if d[2].abs() > 0.9999 { [0.0, 1.0, 0.0] } else { [0.0, 0.0, 1.0] };
    let kind = if cam.projection == CameraProjection::Perspective { "perspective" } else { "orthogonal" };
    camera(kind, eye, d, up, cam.fov_deg, aspect, center)
}

/// Inverse Transponierte (bis auf einen positiven Faktor) einer 3×3-Matrix aus Zeilen: Normalen der Parallelprojektion.
fn cofactor(m: &[V3; 3]) -> Option<[V3; 3]> {
    let c = [cross(m[1], m[2]), cross(m[2], m[0]), cross(m[0], m[1])];
    let det = dot(m[0], c[0]);
    if !(det.abs() > 1e-12) {
        return None;
    }
    let s = det.signum();
    // Die Spalten von M⁻¹ sind c[j]/det, also die Zeilen von M⁻ᵀ: n'_j = (c[j] · n)/det; der Betrag zählt nicht.
    Some([[c[0][0] * s, c[0][1] * s, c[0][2] * s], [c[1][0] * s, c[1][1] * s, c[1][2] * s], [c[2][0] * s, c[2][1] * s, c[2][2] * s]])
}

/// Welt (x, Höhe, y) → Modell (x, y, Höhe).
fn model_of(w: V3) -> V3 {
    [w[0], w[2], w[1]]
}

/// Sutherland-Hodgman an `g(p) ≥ 0`; `ne[i]`: Kante i → i+1 nie zeichnen (neue Kanten am Schnitt ebenso).
fn clip_by(pts: &[V3], ne: &[bool], g: &dyn Fn(V3) -> f64) -> Option<(Vec<V3>, Vec<bool>)> {
    let n = pts.len();
    let vals: Vec<f64> = pts.iter().map(|&p| g(p)).collect();
    if vals.iter().all(|v| *v >= 0.0) {
        return Some((pts.to_vec(), ne.to_vec()));
    }
    let mut out = Vec::new();
    let mut flags = Vec::new();
    for i in 0..n {
        let j = (i + 1) % n;
        let (p, q, gp, gq) = (pts[i], pts[j], vals[i], vals[j]);
        let e = ne.get(i).copied().unwrap_or(false);
        let (pin, qin) = (gp >= 0.0, gq >= 0.0);
        let x = || {
            let t = gp / (gp - gq);
            [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t]
        };
        match (pin, qin) {
            (true, true) => {
                out.push(p);
                flags.push(e);
            }
            (true, false) => {
                out.push(p);
                flags.push(e);
                out.push(x());
                flags.push(true);
            }
            (false, true) => {
                out.push(x());
                flags.push(e);
            }
            (false, false) => {}
        }
    }
    (out.len() >= 3).then_some((out, flags))
}

fn newell(pts: &[V3]) -> V3 {
    let n = pts.len();
    (0..n).fold([0.0; 3], |m, k| {
        let (a, b) = (pts[k], pts[(k + 1) % n]);
        [m[0] + (a[1] - b[1]) * (a[2] + b[2]), m[1] + (a[2] - b[2]) * (a[0] + b[0]), m[2] + (a[0] - b[0]) * (a[1] + b[1])]
    })
}

/// Ergebnis der Rechnung (Zeichenebene, Meter; v nach oben).
#[derive(Default, Debug)]
pub struct AxoOut {
    /// Sichtbare Kanten: (a, b, Besitzer, Silhouette).
    pub edges: Vec<([f64; 2], [f64; 2], u32, bool)>,
    /// Verdeckte Kanten (nur mit `hidden`).
    pub hidden: Vec<([f64; 2], [f64; 2], u32)>,
    /// Getönte sichtbare Flächen: (Polygone mit Löchern, Grauwert 0–1, Besitzer).
    pub fills: Vec<(Vec<crate::flat::Polygon>, f64, u32)>,
}

/// Optionen der Rechnung.
#[derive(Clone, Copy, Debug)]
pub struct AxoOpts {
    pub hidden: bool,
    pub fills: bool,
}

/// Flächen (Ansichtskoordinaten vor der Perspektive) samt Modell-Normale.
struct Prepared {
    faces: Vec<hlr::Face>,
    model_n: Vec<V3>,
}

/// Perspektive: zuschneiden (Nahebene, Bildrahmen) und projektiv abbilden; Normale aus der neuen Lage, zugewandt wie vorher.
fn perspective_pass(faces: Vec<hlr::Face>, model_n: Vec<V3>, zref: f64, tan_half: f64, aspect: f64) -> Prepared {
    let near = (zref * 1e-3).max(0.05);
    let (tx, ty) = (tan_half * aspect, tan_half);
    let planes: [&dyn Fn(V3) -> f64; 5] = [&|p: V3| p[2] - near, &|p: V3| p[2] * tx - p[0], &|p: V3| p[2] * tx + p[0], &|p: V3| p[2] * ty - p[1], &|p: V3| p[2] * ty + p[1]];
    let mut out = Prepared { faces: Vec::with_capacity(faces.len()), model_n: Vec::with_capacity(faces.len()) };
    for (mut f, mn) in faces.into_iter().zip(model_n) {
        let facing = dot(f.normal, f.pts[0]) < 0.0;
        let mut cur = (f.pts.clone(), if f.no_edge.is_empty() { vec![false; f.pts.len()] } else { f.no_edge.clone() });
        let mut ok = true;
        for g in planes.iter() {
            match clip_by(&cur.0, &cur.1, *g) {
                Some(c) => cur = c,
                None => {
                    ok = false;
                    break;
                }
            }
        }
        if !ok {
            continue;
        }
        let pts: Vec<V3> = cur.0.iter().map(|p| [p[0] * zref / p[2], p[1] * zref / p[2], zref - zref * zref / p[2]]).collect();
        if !pts.iter().all(|p| finite3(*p)) {
            continue;
        }
        let mut n = newell(&pts);
        let l = norm(n);
        n = if l > 1e-14 { [n[0] / l, n[1] / l, n[2] / l] } else { [0.0, 0.0, if facing { -1.0 } else { 1.0 }] };
        if (n[2] < 0.0) != facing {
            n = [-n[0], -n[1], -n[2]];
        }
        f.pts = pts;
        f.normal = n;
        f.no_edge = cur.1;
        out.faces.push(f);
        out.model_n.push(mn);
    }
    out
}

/// Flächen des Modells in der Projektion; `None`, wenn die Projektion entartet ist.
fn prepare(p: &Project, proj: &Projection, vis: &Visibility, context: bool) -> Result<Option<(Prepared, Vec<OwnerRef>)>, String> {
    match *proj {
        Projection::Parallel { m, o } => {
            let Some(cof) = cofactor(&m) else { return Ok(None) };
            // Schiefe Projektion: Netz-Normalen (`mesh_view::hlr_faces`) setzen eine längentreue Abbildung voraus.
            let ortho = (0..3).all(|i| (0..3).all(|j| (dot(m[i], m[j]) - if i == j { 1.0 } else { 0.0 }).abs() < 1e-9));
            let view = |w: V3| {
                let q = sub(model_of(w), o);
                [dot(m[0], q), dot(m[1], q), dot(m[2], q)]
            };
            let view_n = |n: V3| {
                let q = model_of(n);
                [dot(cof[0], q), dot(cof[1], q), dot(cof[2], q)]
            };
            let (mut vf, refs) = super::section::model_view_faces(p, vis, &view, &view_n, context && ortho)?;
            if vf.faces.len() > FACE_BUDGET && context {
                (vf, _) = super::section::model_view_faces(p, vis, &view, &view_n, false)?;
            }
            // Modell-Normale = Mᵀ · Normale (die Normale ging über M⁻ᵀ).
            let model_n = vf.faces.iter().map(|f| unit([0, 1, 2].map(|k| m[0][k] * f.normal[0] + m[1][k] * f.normal[1] + m[2][k] * f.normal[2])).unwrap_or([0.0, 0.0, 1.0])).collect();
            Ok(Some((Prepared { faces: vf.faces, model_n }, refs)))
        }
        Projection::Perspective { eye, r, u, f, zref, tan_half, aspect } => {
            let view = |w: V3| {
                let q = sub(model_of(w), eye);
                [dot(r, q), dot(u, q), dot(f, q)]
            };
            let view_n = |n: V3| {
                let q = model_of(n);
                [dot(r, q), dot(u, q), dot(f, q)]
            };
            let (mut vf, refs) = super::section::model_view_faces(p, vis, &view, &view_n, context)?;
            if vf.faces.len() > FACE_BUDGET && context {
                (vf, _) = super::section::model_view_faces(p, vis, &view, &view_n, false)?;
            }
            let model_n: Vec<V3> = vf.faces.iter().map(|q| unit([0, 1, 2].map(|k| r[k] * q.normal[0] + u[k] * q.normal[1] + f[k] * q.normal[2])).unwrap_or([0.0, 0.0, 1.0])).collect();
            Ok(Some((perspective_pass(vf.faces, model_n, zref, tan_half, aspect), refs)))
        }
    }
}

/// Lichtrichtung (Modell): von links oben hinter dem Betrachter, je Projektion aus deren Achsen.
fn light_of(proj: &Projection) -> V3 {
    let (r, u, f) = match *proj {
        Projection::Parallel { m, .. } => {
            let r = unit(m[0]).unwrap_or([1.0, 0.0, 0.0]);
            let f = unit(m[2]).unwrap_or([0.0, 0.0, -1.0]);
            (r, cross(r, f), f)
        }
        Projection::Perspective { r, u, f, .. } => (r, u, f),
    };
    // Licht kommt von links oben vorne: Richtung ZUM Licht.
    let l = [-0.55 * r[0] + 0.8 * u[0] - 0.45 * f[0], -0.55 * r[1] + 0.8 * u[1] - 0.45 * f[1], -0.55 * r[2] + 0.8 * u[2] - 0.45 * f[2]];
    let l = [l[0], l[1], l[2] + 0.6];
    unit(l).unwrap_or([0.0, 0.0, 1.0])
}

/// Grauwert einer Fläche (0 = schwarz, 1 = weiss), gestuft (12 Stufen) für wenige Füllfarben.
fn tone(n: V3, light: V3) -> f64 {
    let lam = dot(n, light).max(0.0);
    let g = 0.78 + 0.19 * lam;
    (g * 48.0).round() / 48.0
}

/// Gitter über den Umrissen der zugewandten Flächen für den Hintergrund-Test der Silhouette.
struct Cover {
    lo: [f64; 2],
    cell: [f64; 2],
    side: usize,
    grid: Vec<Vec<u32>>,
    polys: Vec<Vec<[f64; 2]>>,
}

impl Cover {
    fn new(polys: Vec<Vec<[f64; 2]>>) -> Cover {
        let (mut lo, mut hi) = ([f64::INFINITY; 2], [f64::NEG_INFINITY; 2]);
        for q in polys.iter().flatten() {
            lo = [lo[0].min(q[0]), lo[1].min(q[1])];
            hi = [hi[0].max(q[0]), hi[1].max(q[1])];
        }
        let side = ((polys.len() as f64).sqrt().ceil() as usize).clamp(1, 512);
        let cell = [((hi[0] - lo[0]) / side as f64).max(1e-9), ((hi[1] - lo[1]) / side as f64).max(1e-9)];
        let mut c = Cover { lo, cell, side, grid: vec![Vec::new(); side * side], polys: Vec::new() };
        for (i, pl) in polys.iter().enumerate() {
            let (mut a, mut b) = ([f64::INFINITY; 2], [f64::NEG_INFINITY; 2]);
            for q in pl {
                a = [a[0].min(q[0]), a[1].min(q[1])];
                b = [b[0].max(q[0]), b[1].max(q[1])];
            }
            let (x0, y0, x1, y1) = (c.at(a[0], 0), c.at(a[1], 1), c.at(b[0], 0), c.at(b[1], 1));
            for y in y0..=y1 {
                for x in x0..=x1 {
                    c.grid[y * side + x].push(i as u32);
                }
            }
        }
        c.polys = polys;
        c
    }
    fn at(&self, v: f64, k: usize) -> usize {
        let i = ((v - self.lo[k]) / self.cell[k]).floor();
        if i.is_nan() { 0 } else { i.clamp(0.0, (self.side - 1) as f64) as usize }
    }
    fn covered(&self, p: [f64; 2]) -> bool {
        if !self.lo[0].is_finite() {
            return false;
        }
        let cell = &self.grid[self.at(p[1], 1) * self.side + self.at(p[0], 0)];
        cell.iter().any(|&i| inside(p, &self.polys[i as usize]))
    }
}

fn inside(p: [f64; 2], poly: &[[f64; 2]]) -> bool {
    let n = poly.len();
    let mut c = false;
    for i in 0..n {
        let (a, b) = (poly[i], poly[(i + 1) % n]);
        if (a[1] > p[1]) != (b[1] > p[1]) && p[0] < a[0] + (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) {
            c = !c;
        }
    }
    c
}

/// Zellen des Tiefenrasters über die längere Seite der Zeichnung.
const RASTER: f64 = 1200.0;

/// Tiefenraster (Flächen-Id je Zellmitte, kleinste Tiefe gewinnt) über die zugewandten Flächen: welche Flächen irgendwo
/// vorne liegen. Flächen kleiner als eine Zelle können durchfallen (nur ihre Tönung fehlt dann; die Kanten sind exakt).
fn item_buffer(faces: &[hlr::Face], front: &[usize], lo: [f64; 2], hi: [f64; 2]) -> Vec<bool> {
    let ext = (hi[0] - lo[0]).max(hi[1] - lo[1]);
    let cell = (ext / RASTER).max(1e-6);
    let (w, h) = ((((hi[0] - lo[0]) / cell).ceil() as usize).clamp(1, 4096), (((hi[1] - lo[1]) / cell).ceil() as usize).clamp(1, 4096));
    let mut depth = vec![f64::INFINITY; w * h];
    let mut id = vec![u32::MAX; w * h];
    let mut xs: Vec<f64> = Vec::new();
    for &fi in front {
        let f = &faces[fi];
        let Some(pl) = crate::hlr_fill::plane(&f.pts) else { continue };
        let poly: Vec<[f64; 2]> = f.pts.iter().map(|q| [(q[0] - lo[0]) / cell, (q[1] - lo[1]) / cell]).collect();
        let (y0, y1) = poly.iter().fold((f64::INFINITY, f64::NEG_INFINITY), |(a, b), q| (a.min(q[1]), b.max(q[1])));
        let (ry0, ry1) = ((y0 - 0.5).ceil().max(0.0) as usize, ((y1 - 0.5).floor().min(h as f64 - 1.0)).max(-1.0));
        if ry1 < 0.0 {
            continue;
        }
        for ry in ry0..=(ry1 as usize) {
            let yc = ry as f64 + 0.5;
            xs.clear();
            let n = poly.len();
            for k in 0..n {
                let (a, b) = (poly[k], poly[(k + 1) % n]);
                if (a[1] > yc) != (b[1] > yc) {
                    xs.push(a[0] + (b[0] - a[0]) * (yc - a[1]) / (b[1] - a[1]));
                }
            }
            xs.sort_by(|a, b| a.total_cmp(b));
            for pair in xs.chunks_exact(2) {
                let (rx0, rx1) = ((pair[0] - 0.5).ceil().max(0.0), (pair[1] - 0.5).floor().min(w as f64 - 1.0));
                if rx1 < rx0 {
                    continue;
                }
                let v = lo[1] + yc * cell;
                for rx in rx0 as usize..=rx1 as usize {
                    let u = lo[0] + (rx as f64 + 0.5) * cell;
                    let d = pl[0] + pl[1] * u + pl[2] * v;
                    let k = ry * w + rx;
                    if d < depth[k] {
                        depth[k] = d;
                        id[k] = fi as u32;
                    }
                }
            }
        }
    }
    let mut seen = vec![false; faces.len()];
    for &i in &id {
        if let Some(s) = seen.get_mut(i as usize) {
            *s = true;
        }
    }
    seen
}

/// Die eigentliche Rechnung auf vorbereiteten Flächen (auch für Tests mit eigenen Flächen).
fn compute(faces: &[hlr::Face], model_n: &[V3], light: V3, o: AxoOpts) -> AxoOut {
    let mut out = AxoOut::default();
    // Massstab der Toleranzen: Ausdehnung der Zeichnung.
    let (mut lo, mut hi) = ([f64::INFINITY; 2], [f64::NEG_INFINITY; 2]);
    for q in faces.iter().flat_map(|f| f.pts.iter()) {
        lo = [lo[0].min(q[0]), lo[1].min(q[1])];
        hi = [hi[0].max(q[0]), hi[1].max(q[1])];
    }
    if !(lo[0].is_finite() && hi[0].is_finite() && lo[1].is_finite() && hi[1].is_finite()) {
        return out;
    }
    let ext = (hi[0] - lo[0]).max(hi[1] - lo[1]).max(1.0);
    let tol = (ext * 1e-6).max(1e-5);
    let opts = hlr::Opts { tol, depth_eps: tol, hidden: o.hidden, ..hlr::Opts::default() };
    let segs = hlr::hidden_lines(faces, &opts);
    let front: Vec<usize> = (0..faces.len()).filter(|&i| faces[i].two_sided || faces[i].normal[2] < -1e-12).collect();
    let cover = Cover::new(front.iter().map(|&i| faces[i].pts.iter().map(|q| [q[0], q[1]]).collect()).collect());
    let delta = (ext * 2e-5).max(2e-3);
    for s in segs {
        if s.hidden {
            out.hidden.push((s.a, s.b, s.owner));
            continue;
        }
        let (dx, dy) = (s.b[0] - s.a[0], s.b[1] - s.a[1]);
        let l = (dx * dx + dy * dy).sqrt();
        let m = [(s.a[0] + s.b[0]) / 2.0, (s.a[1] + s.b[1]) / 2.0];
        let nrm = if l > 0.0 { [-dy / l * delta, dx / l * delta] } else { [0.0, 0.0] };
        let outline = !cover.covered([m[0] + nrm[0], m[1] + nrm[1]]) || !cover.covered([m[0] - nrm[0], m[1] - nrm[1]]);
        out.edges.push((s.a, s.b, s.owner, outline));
    }
    if o.fills && front.len() <= FILL_BUDGET {
        // Vorauswahl über ein Tiefenraster (Flächen-Ids je Zelle): nur Flächen, die irgendwo vorne liegen, werden exakt
        // beschnitten — und nur sie können verdecken (was eine verdeckte Fläche deckte, deckt ihr Verdecker ebenso).
        let seen = item_buffer(faces, &front, lo, hi);
        let pts: Vec<Vec<V3>> = (0..faces.len()).map(|i| if seen[i] { faces[i].pts.clone() } else { Vec::new() }).collect();
        let regions = crate::hlr_fill::visible_regions(&pts, tol);
        // Je (Besitzer, Grauwert) vereinigt: keine Haarfugen zwischen den Dreiecken einer Wand.
        let mut groups: BTreeMap<(u32, i64), Vec<crate::flat::Polygon>> = BTreeMap::new();
        for (i, f) in faces.iter().enumerate() {
            if pts[i].is_empty() {
                continue;
            }
            let polys: Vec<crate::flat::Polygon> = match &regions[i] {
                None => vec![vec![f.pts.iter().map(|q| [q[0], q[1]]).collect()]],
                Some(ps) => ps.clone(),
            };
            if polys.is_empty() {
                continue;
            }
            // Beidseitige Flächen (Dachhaut ohne Dicke): die dem Betrachter zugewandte Seite tönen.
            let mut n = model_n.get(i).copied().unwrap_or([0.0, 0.0, 1.0]);
            if f.two_sided && f.normal[2] > 0.0 {
                n = [-n[0], -n[1], -n[2]];
            }
            let g = tone(n, light);
            groups.entry((f.owner, (g * 1000.0) as i64)).or_default().extend(polys);
        }
        for ((owner, g), polys) in groups {
            let u = crate::polygon_bool::union(&polys);
            if !u.is_empty() {
                out.fills.push((u, g as f64 / 1000.0, owner));
            }
        }
    }
    out
}

/// Punkte auf einer Geraden zwischen ihren Nachbarn (Stösse der vereinigten Dreiecke) entfallen: sonst läse die
/// Bogenerkennung der Ausgaben (`arc_fit`) lange, fast gerade Züge mit vielen Punkten als flachen Bogen.
fn simplify(ring: &[[f64; 2]]) -> Vec<[f64; 2]> {
    let mut r: Vec<[f64; 2]> = ring.to_vec();
    loop {
        let n = r.len();
        if n <= 3 {
            return r;
        }
        // Erster entbehrlicher Punkt (gleich dem Vorgänger oder auf der Strecke zwischen seinen Nachbarn) fällt weg;
        // einer nach dem anderen, damit nie zwei Punkte mit Bezug aufeinander verschwinden.
        let drop = (0..n).find(|&i| {
            let (a, b, c) = (r[(i + n - 1) % n], r[i], r[(i + 1) % n]);
            if a == b {
                return true;
            }
            let (ux, uy, vx, vy) = (c[0] - a[0], c[1] - a[1], b[0] - a[0], b[1] - a[1]);
            let l2 = ux * ux + uy * uy;
            if !(l2 > 1e-24) {
                return false;
            }
            let t = vx * ux + vy * uy;
            (ux * vy - uy * vx).abs() / l2.sqrt() < 1e-6 && t > 0.0 && t < l2
        });
        match drop {
            Some(i) => {
                r.remove(i);
            }
            None => return r,
        }
    }
}

fn grey_hex(g: f64) -> String {
    let v = (g.clamp(0.0, 1.0) * 255.0).round() as u32;
    format!("#{v:02x}{v:02x}{v:02x}")
}

/// Argumente der Abfrage `axoPlan`.
#[derive(Clone, Debug)]
pub struct AxoArgs {
    pub proj: Projection,
    pub opts: AxoOpts,
    pub context: bool,
    pub vis: Visibility,
}

/// Modellmitte (Hüllbox der Bauteile) für die Bildebene der Perspektive.
fn model_center(p: &Project) -> V3 {
    let (mut lo, mut hi) = ([f64::INFINITY; 3], [f64::NEG_INFINITY; 3]);
    let mut add = |x: f64, y: f64, z: f64| {
        if x.is_finite() && y.is_finite() && z.is_finite() {
            lo = [lo[0].min(x), lo[1].min(y), lo[2].min(z)];
            hi = [hi[0].max(x), hi[1].max(y), hi[2].max(z)];
        }
    };
    for w in &p.walls {
        let z = p.drawing_levels.iter().find(|l| l.id == w.floor_id).and_then(|l| l.base_elevation).unwrap_or(0.0);
        add(w.start.x, w.start.y, z);
        add(w.end.x, w.end.y, z + w.height);
    }
    if !lo[0].is_finite() {
        return [0.0; 3];
    }
    [(lo[0] + hi[0]) / 2.0, (lo[1] + hi[1]) / 2.0, (lo[2] + hi[2]) / 2.0]
}

impl AxoArgs {
    /// Aus dem JSON der Abfrage: `view` (Vorgabe), `projection` (`iso`/`military`/`military30`), `camera`
    /// (`ViewCamera`), `cameraId` (Kamera-Element), `aspect`, `hidden`, `fills` (Vorgabe an), `context` (Vorgabe aus) und
    /// die Sichtbarkeit wie im Schnitt (`hasVis`, `invisible`, …). Kamera vor Kamera-Element vor Vorgabe.
    pub fn parse(p: &Project, v: &serde_json::Value) -> Option<AxoArgs> {
        let s = |k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or("");
        let b = |k: &str, d: bool| v.get(k).and_then(|x| x.as_bool()).unwrap_or(d);
        let aspect = v.get("aspect").and_then(|x| x.as_f64()).unwrap_or(1.5);
        let center = model_center(p);
        let v3 = |c: &serde_json::Value, k: &str| -> Option<V3> {
            let a = c.get(k)?.as_array()?;
            Some([a.first()?.as_f64()?, a.get(1)?.as_f64()?, a.get(2)?.as_f64()?])
        };
        let proj = match v.get("camera").filter(|c| c.is_object()) {
            Some(c) => camera(c.get("kind").and_then(|k| k.as_str()).unwrap_or("orthogonal"), v3(c, "position")?, v3(c, "direction")?, v3(c, "up").unwrap_or([0.0, 0.0, 1.0]), c.get("fovDeg").and_then(|f| f.as_f64()).unwrap_or(50.0), aspect, center)?,
            None if !s("cameraId").is_empty() => project_camera(p, s("cameraId"), aspect, center)?,
            None => preset(s("view"), if s("projection").is_empty() { "iso" } else { s("projection") })?,
        };
        Some(AxoArgs { proj, opts: AxoOpts { hidden: b("hidden", false) || b("hiddenLines", false), fills: b("fills", true) }, context: b("context", false), vis: Visibility::from_json(v) })
    }
}

/// [266] Abfrage-Text (`axoPlan`) eines 3D-Dokuments: Einstellungen des Ausschnitts (`doc3d`, sonst sein Blickwinkel
/// `view3d`) und die Klassen, die er ausblendet (`invisible`, wie beim Schnitt-Viewport).
pub fn snapshot_text(p: &Project, snap: &ViewSnapshot, invisible: &[String]) -> String {
    let mut v = snap.doc3d.as_ref().and_then(|d| serde_json::to_value(d).ok()).unwrap_or_else(|| serde_json::json!({}));
    if let Some(o) = v.as_object_mut() {
        if !o.contains_key("view") {
            o.insert("view".into(), serde_json::to_value(snap.view3d).unwrap_or_default());
        }
        o.insert("hasVis".into(), serde_json::Value::Bool(true));
        o.insert("invisible".into(), serde_json::to_value(invisible).unwrap_or_default());
        // [272] Variantenkombination des Ausschnitts.
        if let Some(m) = crate::design_options::stored_choice(p, snap.design_option_combination.as_deref(), snap.design_options.as_ref()).filter(|m| !m.is_empty()) {
            o.insert("designOptions".into(), serde_json::to_value(&m).unwrap_or_default());
        }
    }
    v.to_string()
}

/// Plan-Primitive der Axonometrie und ihr Ausmass; `None` ohne sichtbares Bauteil.
pub fn axo_primitives(p: &Project, a: &AxoArgs, mono: bool) -> Result<Option<(Vec<Primitive>, [f64; 4])>, String> {
    let Some((prep, refs)) = prepare(p, &a.proj, &a.vis, a.context)? else { return Ok(None) };
    if prep.faces.is_empty() || prep.faces.len() > FACE_BUDGET {
        return Ok(None);
    }
    let out = compute(&prep.faces, &prep.model_n, light_of(&a.proj), a.opts);
    let _ = mono; // Tusche wie Farbe: die Axonometrie ist grau.
    let mut prims = Vec::new();
    let mut acc = super::section::Acc::new();
    let owner = |o: u32| refs.get(o as usize);
    for (polys, g, o) in &out.fills {
        let fill = grey_hex(*g);
        for poly in polys {
            let ring = simplify(&if poly.len() > 1 { crate::voids::keyhole(poly).0 } else { poly[0].clone() });
            if ring.len() < 3 {
                continue;
            }
            for q in &ring {
                acc.add(q[0], q[1]);
            }
            // Ein Hauch Kontur in der Füllfarbe deckt die Haarfugen zwischen Nachbarflächen.
            let mut prim = polygon(ring.iter().map(|q| v2(q[0], q[1])).collect(), &fill, &fill, 0.1, no_hatch());
            if let (Primitive::Polygon { wall_id, ceiling_id, roof_id, stair_id, column_id, extruded_solid_id, context_object_id, .. }, Some(r)) = (&mut prim, owner(*o)) {
                let id = r.id.clone();
                match r.kind {
                    Kind::Wall => *wall_id = id,
                    Kind::Roof => *roof_id = id,
                    Kind::Body => *extruded_solid_id = id,
                    Kind::Mesh => *context_object_id = id,
                    Kind::Slab if r.stair => *stair_id = id,
                    Kind::Slab if r.column => *column_id = id,
                    Kind::Slab if r.railing => *context_object_id = id.map(|i| crate::plan::railings::pick_id(&i)),
                    Kind::Slab => *ceiling_id = id,
                }
            }
            prims.push(prim);
        }
    }
    for (a, b, _) in &out.hidden {
        let mut l = line(v2(a[0], a[1]), v2(b[0], b[1]), "axo-hidden", HIDDEN_MM, HIDDEN_INK);
        if let Primitive::Line { dash, .. } = &mut l {
            *dash = Some(Some(super::line_pattern::HIDDEN.to_vec()));
        }
        prims.push(l);
    }
    for pass in [false, true] {
        for (a, b, _, outline) in out.edges.iter().filter(|e| e.3 == pass) {
            acc.add(a[0], a[1]);
            acc.add(b[0], b[1]);
            prims.push(if *outline { line(v2(a[0], a[1]), v2(b[0], b[1]), "axo-outline", OUTLINE_MM, OUTLINE_INK) } else { line(v2(a[0], a[1]), v2(b[0], b[1]), "axo-edge", EDGE_MM, EDGE_INK) });
        }
    }
    if prims.is_empty() || !(acc.max_x >= acc.min_x) {
        return Ok(None);
    }
    Ok(Some((prims, [acc.min_x, acc.min_y, acc.max_x, acc.max_y])))
}

/// Abfrage `axoPlan`: `args` = `[mono, Massstab]`, `text` = JSON ([`AxoArgs::parse`]). Plan-Puffer mit einer Gruppe
/// (Strichstärken nach Massstab wie im Schnitt); ohne Bild (leeres Projekt, unbrauchbare Kamera) ohne Gruppen.
pub fn axo_plan_buf(p: &Project, args: &[f64], text: &str) -> Result<Vec<u8>, String> {
    let v: serde_json::Value = serde_json::from_str(text).map_err(|e| format!("Axonometrie-Argumente: {e}"))?;
    let mono = args.first().is_some_and(|&x| x != 0.0);
    let scale = args.get(1).copied().filter(|s| s.is_finite() && *s > 0.0).unwrap_or(100.0);
    let mut w = crate::plan::buf::Writer::new(true);
    // [271] Umbaufilter (`renovation`, `renovationPhase`): Ausgeblendetes fehlt, Flächen in der Umbau-Farbe.
    // [272] Variantenkombination (`designOptions`, sonst die Hauptvarianten): andere Varianten fehlen.
    let opts = crate::design_options::parse_request(v.get("designOptions"));
    let ren = crate::renovation::View::with(p, v.get("renovation").and_then(|x| x.as_str()), v.get("renovationPhase").and_then(|x| x.as_str()), &[], &opts);
    // [272] Bearbeitungsvariante der Bildschirm-Ansicht (`designOptionEdit`).
    let ren = crate::renovation::View::editing(ren, p, crate::design_options::parse_edit(p, v.get("designOptionEdit"))).map(|r| r.resolve(p));
    let filtered = ren.as_ref().and_then(|r| r.project(p));
    let p = filtered.as_ref().unwrap_or(p);
    let Some(a) = AxoArgs::parse(p, &v) else { return Ok(w.finish()) };
    if let Some((mut prims, bounds)) = axo_primitives(p, &a, mono)? {
        if let Some(r) = ren.as_ref().filter(|r| !r.styled.is_empty() || !r.faces.is_empty()) {
            for q in prims.iter_mut() {
                let Some(st) = crate::renovation::prim_element(q).and_then(|id| r.surface(id)) else { continue };
                if let Primitive::Polygon { fill, stroke, .. } = q {
                    *fill = st.fill.clone();
                    *stroke = st.fill.clone();
                }
            }
        }
        super::extras::scale_line_weights(p, scale, &mut prims);
        w.group(&prims);
        w.bounds = Some(bounds);
    }
    Ok(w.finish())
}

#[cfg(test)]
#[path = "axo_tests.rs"]
mod tests;
