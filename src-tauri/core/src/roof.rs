//! Dach-Geometrie: leitet aus Grundriss-Umriss + Dachform + Neigung die Grundriss-Linien
//! (Traufe/First/Grat/Knick) UND die 3D-Dachflächen ab.
//!
//! - Rechteck (und Satteldach auf schiefem Umriss): auf der BOUNDING-BOX des Umrisses, First
//!   entlang einer Hauptachse — deckt alle Standardformen (Flach/Pult/Sattel/Walm/Mansarde/
//!   Zelt, Krüppelwalm) exakt ab.
//! - Rechtwinklig, nicht rechteckig (L/T/U …): Walm/Sattel/Mansarde/Zelt über das Skelett
//!   ([`crate::roof_skeleton`]), Pult als eine Ebene über dem Umriss.
//! - Beliebiger einfacher Umriss: allseitig gleich geneigte Formen über das Skelett.
//!
//! Koordinaten: Grundriss (x, y) in Metern; 3D-Punkte [x, y, z] mit z = Höhe.
//! Portiert aus `src/geometry/roof.ts` (dort bleiben Typen, Memo und `roofBaseElevation`).

use crate::roof_skeleton::{clean_ring, convex_pieces, hip_roof, is_rectilinear_non_rect, is_skeleton_roofable, offset_ring, signed_area, Axis, Knee, Line, Offset, P2, P3};

/// Dachform (`RoofShape` im TS-Modell).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Shape {
    Flach,
    Pult,
    Sattel,
    Walm,
    Mansarde,
    Zelt,
}

/// Untertyp der Mansarde.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MansardType {
    Giebel,
    Walm,
    Zelt,
}

/// Dachparameter (Auszug aus `Roof`); `None` = Feld fehlt (Standardwert wie im Modell).
#[derive(Clone, Debug)]
pub struct RoofParams {
    pub outline: Vec<P2>,
    pub shape: Shape,
    pub pitch_deg: f64,
    pub pitch_upper_deg: Option<f64>,
    pub mansard_type: MansardType,
    pub mansard_knee_ratio: Option<f64>,
    pub half_hip_ratio: Option<f64>,
    pub overhang: f64,
    pub overhang_gable: Option<f64>,
    pub ridge_axis: Axis,
}

/// Vollständige Dach-Geometrie (Grundriss-Linien + 3D-Flächen), wie `RoofGeometry` in TS.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct RoofGeometry {
    /// Traufe-Umriss (inkl. Überstand), offener Ring.
    pub eaves: Vec<P2>,
    pub ridges: Vec<Line>,
    pub hips: Vec<Line>,
    pub breaks: Vec<Line>,
    pub planes: Vec<Vec<P3>>,
    /// Giebelflächen (vertikale Polygone).
    pub gables: Vec<Vec<P3>>,
    /// Firsthöhe über der Traufe (Meter).
    pub ridge_height: f64,
}

const DEG: f64 = std::f64::consts::PI / 180.0;

/// Nicht-negativ; NaN → 0 (fehlerhafte Eingaben ergeben ein flaches statt ein kaputtes Dach).
fn nn(v: f64) -> f64 {
    if v.is_nan() {
        0.0
    } else {
        v.max(0.0)
    }
}

fn knee_ratio(p: &RoofParams) -> f64 {
    p.mansard_knee_ratio.unwrap_or(0.4).clamp(0.05, 0.49)
}

fn upper_tan(p: &RoofParams) -> f64 {
    (nn(p.pitch_upper_deg.unwrap_or(p.pitch_deg / 2.0)) * DEG).tan()
}

/// Kanonische Berechnung mit First entlang der X-Achse auf dem Rechteck [x0,x1]×[y0,y1]
/// (Traufe, inkl. Überstand) auf Traufhöhe `e`. „First entlang Y“ entsteht im Aufrufer durch
/// Transponieren (x↔y).
fn compute_canonical(x0: f64, y0: f64, x1: f64, y1: f64, e: f64, p: &RoofParams) -> RoofGeometry {
    let xc = (x0 + x1) / 2.0;
    let yc = (y0 + y1) / 2.0;
    let half_w = (x1 - x0) / 2.0;
    let half_d = (y1 - y0) / 2.0;
    let a = nn(p.pitch_deg) * DEG;
    let tan = a.tan();
    let h = half_d * tan; // Firsthöhe (Sattel/Walm/Mansarde)
    let eaves = vec![[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
    let geo = |ridges, hips, breaks, planes, gables, ridge_height| RoofGeometry { eaves: eaves.clone(), ridges, hips, breaks, planes, gables, ridge_height };

    match p.shape {
        Shape::Flach => geo(vec![], vec![], vec![], vec![vec![[x0, y0, e], [x1, y0, e], [x1, y1, e], [x0, y1, e]]], vec![], 0.0),

        Shape::Pult => {
            // Eine Fläche: tiefe Seite y0 auf Traufe, hohe Seite y1 auf e+H.
            let hh = (y1 - y0) * tan;
            geo(
                vec![[[x0, y1], [x1, y1]]], // hohe Kante (First-Ersatz)
                vec![],
                vec![],
                vec![vec![[x0, y0, e], [x1, y0, e], [x1, y1, e + hh], [x0, y1, e + hh]]],
                vec![vec![[x0, y0, e], [x0, y1, e + hh], [x0, y1, e]], vec![[x1, y0, e], [x1, y1, e + hh], [x1, y1, e]]],
                hh,
            )
        }

        Shape::Sattel => {
            let rz = e + h;
            let hh = p.half_hip_ratio.unwrap_or(0.0).clamp(0.0, 0.9);
            if hh > 1e-6 && half_w > half_d * hh + 1e-6 {
                // Krüppelwalm: oberer Giebelteil (Anteil `hh` der Firsthöhe) als kleine
                // Walmflächen gleicher Neigung — Walmlauf = halbe Tiefe · hh, First verkürzt.
                let kz = e + h * (1.0 - hh);
                let yk0 = y0 + half_d * (1.0 - hh);
                let yk1 = y1 - half_d * (1.0 - hh);
                let d = half_d * hh;
                return geo(
                    vec![[[x0 + d, yc], [x1 - d, yc]]],
                    vec![[[x0, yk0], [x0 + d, yc]], [[x0, yk1], [x0 + d, yc]], [[x1, yk0], [x1 - d, yc]], [[x1, yk1], [x1 - d, yc]]],
                    vec![],
                    vec![
                        vec![[x0, y0, e], [x1, y0, e], [x1, yk0, kz], [x1 - d, yc, rz], [x0 + d, yc, rz], [x0, yk0, kz]],
                        vec![[x0, y1, e], [x1, y1, e], [x1, yk1, kz], [x1 - d, yc, rz], [x0 + d, yc, rz], [x0, yk1, kz]],
                        vec![[x0, yk0, kz], [x0, yk1, kz], [x0 + d, yc, rz]],
                        vec![[x1, yk0, kz], [x1, yk1, kz], [x1 - d, yc, rz]],
                    ],
                    vec![vec![[x0, y0, e], [x0, y1, e], [x0, yk1, kz], [x0, yk0, kz]], vec![[x1, y0, e], [x1, y1, e], [x1, yk1, kz], [x1, yk0, kz]]],
                    h,
                );
            }
            geo(
                vec![[[x0, yc], [x1, yc]]],
                vec![],
                vec![],
                vec![vec![[x0, y0, e], [x1, y0, e], [x1, yc, rz], [x0, yc, rz]], vec![[x0, y1, e], [x1, y1, e], [x1, yc, rz], [x0, yc, rz]]],
                vec![vec![[x0, y0, e], [x0, y1, e], [x0, yc, rz]], vec![[x1, y0, e], [x1, y1, e], [x1, yc, rz]]],
                h,
            )
        }

        Shape::Walm => {
            let rz = e + h;
            // First um die halbe Tiefe an beiden Enden verkürzt (45°-Grate bei gleicher
            // Neigung). Bei schmalem Baukörper (half_w < half_d) degeneriert er zum Punkt.
            let (mut ra, mut rb) = (x0 + half_d, x1 - half_d);
            if ra > rb {
                ra = xc;
                rb = xc;
            }
            geo(
                vec![[[ra, yc], [rb, yc]]],
                vec![[[x0, y0], [ra, yc]], [[x0, y1], [ra, yc]], [[x1, y0], [rb, yc]], [[x1, y1], [rb, yc]]],
                vec![],
                vec![
                    vec![[x0, y0, e], [x1, y0, e], [rb, yc, rz], [ra, yc, rz]],
                    vec![[x0, y1, e], [x1, y1, e], [rb, yc, rz], [ra, yc, rz]],
                    vec![[x0, y0, e], [x0, y1, e], [ra, yc, rz]],
                    vec![[x1, y0, e], [x1, y1, e], [rb, yc, rz]],
                ],
                vec![],
                h,
            )
        }

        Shape::Mansarde => {
            // Steile untere Neigung (pitch_deg) bis zur Knicklinie, dann flache obere
            // (pitch_upper_deg, sonst halbe Hauptneigung). Untertyp: Knick an ZWEI Seiten
            // (Giebel) oder RINGSUM (Walm/Zelt).
            let tan_low = tan;
            let tan_up = upper_tan(p);
            let ratio = knee_ratio(p);
            if p.mansard_type == MansardType::Giebel {
                let d1 = half_d * ratio;
                let z1 = e + d1 * tan_low;
                let z2 = z1 + (half_d - d1) * tan_up;
                let yf = y0 + d1;
                let yb = y1 - d1;
                return geo(
                    vec![[[x0, yc], [x1, yc]]],
                    vec![],
                    vec![[[x0, yf], [x1, yf]], [[x0, yb], [x1, yb]]],
                    vec![
                        vec![[x0, y0, e], [x1, y0, e], [x1, yf, z1], [x0, yf, z1]],
                        vec![[x0, yf, z1], [x1, yf, z1], [x1, yc, z2], [x0, yc, z2]],
                        vec![[x0, y1, e], [x1, y1, e], [x1, yb, z1], [x0, yb, z1]],
                        vec![[x0, yb, z1], [x1, yb, z1], [x1, yc, z2], [x0, yc, z2]],
                    ],
                    vec![
                        vec![[x0, y0, e], [x0, yf, z1], [x0, yc, z2], [x0, yb, z1], [x0, y1, e]],
                        vec![[x1, y0, e], [x1, yf, z1], [x1, yc, z2], [x1, yb, z1], [x1, y1, e]],
                    ],
                    z2 - e,
                );
            }
            // Allseitige Mansarde: steiler Sockel ringsum bis zur Knicklinie (inneres
            // Rechteck), darüber flacher Walm bzw. flache Spitze.
            let d_low = half_w.min(half_d) * ratio;
            let z1 = e + d_low * tan_low;
            let (ix0, iy0, ix1, iy1) = (x0 + d_low, y0 + d_low, x1 - d_low, y1 - d_low);
            let ihalf_d = (iy1 - iy0) / 2.0;
            let ihalf_w = (ix1 - ix0) / 2.0;
            let mut planes = vec![
                vec![[x0, y0, e], [x1, y0, e], [ix1, iy0, z1], [ix0, iy0, z1]],
                vec![[x1, y1, e], [x0, y1, e], [ix0, iy1, z1], [ix1, iy1, z1]],
                vec![[x0, y1, e], [x0, y0, e], [ix0, iy0, z1], [ix0, iy1, z1]],
                vec![[x1, y0, e], [x1, y1, e], [ix1, iy1, z1], [ix1, iy0, z1]],
            ];
            let mut hips: Vec<Line> = vec![[[x0, y0], [ix0, iy0]], [[x1, y0], [ix1, iy0]], [[x1, y1], [ix1, iy1]], [[x0, y1], [ix0, iy1]]];
            let breaks: Vec<Line> = vec![[[ix0, iy0], [ix1, iy0]], [[ix1, iy0], [ix1, iy1]], [[ix1, iy1], [ix0, iy1]], [[ix0, iy1], [ix0, iy0]]];
            if p.mansard_type == MansardType::Walm {
                // Oberer Walm auf dem inneren Rechteck (First entlang X).
                let z2 = z1 + ihalf_d * tan_up;
                let (mut ra, mut rb) = (ix0 + ihalf_d, ix1 - ihalf_d);
                if ra > rb {
                    ra = xc;
                    rb = xc;
                }
                hips.extend([[[ix0, iy0], [ra, yc]], [[ix1, iy0], [rb, yc]], [[ix1, iy1], [rb, yc]], [[ix0, iy1], [ra, yc]]]);
                planes.extend([
                    vec![[ix0, iy0, z1], [ix1, iy0, z1], [rb, yc, z2], [ra, yc, z2]],
                    vec![[ix1, iy1, z1], [ix0, iy1, z1], [ra, yc, z2], [rb, yc, z2]],
                    vec![[ix0, iy1, z1], [ix0, iy0, z1], [ra, yc, z2]],
                    vec![[ix1, iy0, z1], [ix1, iy1, z1], [rb, yc, z2]],
                ]);
                return geo(vec![[[ra, yc], [rb, yc]]], hips, breaks, planes, vec![], z2 - e);
            }
            // Zelt: flache Spitze über der Mitte des inneren Rechtecks.
            let z2 = z1 + ihalf_w.min(ihalf_d) * tan_up;
            hips.extend([[[ix0, iy0], [xc, yc]], [[ix1, iy0], [xc, yc]], [[ix1, iy1], [xc, yc]], [[ix0, iy1], [xc, yc]]]);
            planes.extend([
                vec![[ix0, iy0, z1], [ix1, iy0, z1], [xc, yc, z2]],
                vec![[ix1, iy0, z1], [ix1, iy1, z1], [xc, yc, z2]],
                vec![[ix1, iy1, z1], [ix0, iy1, z1], [xc, yc, z2]],
                vec![[ix0, iy1, z1], [ix0, iy0, z1], [xc, yc, z2]],
            ]);
            geo(vec![], hips, breaks, planes, vec![], z2 - e)
        }

        Shape::Zelt => {
            // Allseitig zur Spitze über der Mitte.
            let hz = half_w.min(half_d) * tan;
            let az = e + hz;
            geo(
                vec![],
                vec![[[x0, y0], [xc, yc]], [[x1, y0], [xc, yc]], [[x1, y1], [xc, yc]], [[x0, y1], [xc, yc]]],
                vec![],
                vec![
                    vec![[x0, y0, e], [x1, y0, e], [xc, yc, az]],
                    vec![[x1, y0, e], [x1, y1, e], [xc, yc, az]],
                    vec![[x1, y1, e], [x0, y1, e], [xc, yc, az]],
                    vec![[x0, y1, e], [x0, y0, e], [xc, yc, az]],
                ],
                vec![],
                hz,
            )
        }
    }
}

fn swap_line(l: &Line) -> Line {
    [[l[0][1], l[0][0]], [l[1][1], l[1][0]]]
}

fn swap3(v: &P3) -> P3 {
    [v[1], v[0], v[2]]
}

/// Dach-Geometrie aus Form/Neigung/Überstand + Traufhöhe `eaves_z`. Kaputte Eingaben
/// (kein endlicher Umrisspunkt) ergeben eine leere Geometrie, nie einen Panic.
pub fn roof_geometry(p: &RoofParams, eaves_z: f64) -> RoofGeometry {
    let outline: Vec<P2> = p.outline.iter().copied().filter(|q| q[0].is_finite() && q[1].is_finite()).collect();
    if outline.is_empty() {
        return RoofGeometry::default();
    }
    let e = if eaves_z.is_finite() { eaves_z } else { 0.0 };
    let p = &RoofParams { outline, ..p.clone() };
    // Walm/Sattel/Mansarde/Zelt über einem rechtwinkligen, nicht-rechteckigen Grundriss
    // (L/T/U …): echte Flächen mit Graten und Kehlen statt Bounding-Box. Zelt/Mansard-Zelt:
    // eine einzelne Spitze gibt es dort nicht — Gegenstück ist das allseitig geneigte Skelett.
    if matches!(p.shape, Shape::Walm | Shape::Sattel | Shape::Mansarde | Shape::Zelt) && is_rectilinear_non_rect(&p.outline) {
        return skeleton_roof(p, e);
    }
    // Beliebiger einfacher Umriss: nur allseitig gleich geneigte Formen — Giebel brauchen
    // achsparallele Kanten und bleiben bei der Bounding-Box.
    let allround = matches!(p.shape, Shape::Walm | Shape::Zelt) || (p.shape == Shape::Mansarde && p.mansard_type != MansardType::Giebel);
    if allround && is_skeleton_roofable(&p.outline) {
        return skeleton_roof(p, e);
    }
    if p.shape == Shape::Pult && is_rectilinear_non_rect(&p.outline) {
        return rectilinear_pult(p, e);
    }
    let (mut x0, mut y0, mut x1, mut y1) = bbox(&p.outline);
    let oe = nn(p.overhang); // Traufüberstand (senkrecht zum First)
    let og = nn(p.overhang_gable.unwrap_or(p.overhang)); // Ortgang (entlang First)
    // Entlang der Firstachse wirkt der Ortgang-, quer dazu der Traufüberstand.
    let (ox, oy) = if p.ridge_axis == Axis::X { (og, oe) } else { (oe, og) };
    x0 -= ox;
    y0 -= oy;
    x1 += ox;
    y1 += oy;
    if p.ridge_axis == Axis::X {
        return compute_canonical(x0, y0, x1, y1, e, p);
    }
    let g = compute_canonical(y0, x0, y1, x1, e, p);
    RoofGeometry {
        eaves: g.eaves.iter().map(|q| [q[1], q[0]]).collect(),
        ridges: g.ridges.iter().map(swap_line).collect(),
        hips: g.hips.iter().map(swap_line).collect(),
        breaks: g.breaks.iter().map(swap_line).collect(),
        planes: g.planes.iter().map(|pl| pl.iter().map(swap3).collect()).collect(),
        gables: g.gables.iter().map(|pl| pl.iter().map(swap3).collect()).collect(),
        ridge_height: g.ridge_height,
    }
}

fn bbox(pts: &[P2]) -> (f64, f64, f64, f64) {
    let mut b = (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
    for q in pts {
        b.0 = b.0.min(q[0]);
        b.1 = b.1.min(q[1]);
        b.2 = b.2.max(q[0]);
        b.3 = b.3.max(q[1]);
    }
    b
}

/// Umriss gesäubert und gegen den Uhrzeigersinn.
fn ccw_ring(outline: &[P2]) -> Vec<P2> {
    let mut ring = clean_ring(outline);
    if signed_area(&ring) < 0.0 {
        ring.reverse();
    }
    ring
}

/// Ob die Kante a→b entlang der Firstachse läuft (dort Traufe, quer dazu Ortgang).
fn along_ridge(a: P2, b: P2, axis: Axis) -> bool {
    let along_x = (b[0] - a[0]).abs() > (b[1] - a[1]).abs();
    along_x == (axis == Axis::X)
}

/// Skelett-Dach (Walm/Sattel/Mansarde/Zelt) auf beliebigem einfachem Umriss: Traufe = Umriss um
/// den Überstand nach aussen versetzt, Flächen/Linien aus [`hip_roof`].
fn skeleton_roof(p: &RoofParams, e: f64) -> RoofGeometry {
    let ring = ccw_ring(&p.outline);
    let oe = nn(p.overhang);
    let og = nn(p.overhang_gable.unwrap_or(p.overhang));
    // Satteldach: Kanten quer zum First sind Ortgang (eigener Überstand), sonst Traufe.
    let per_edge = |a: P2, b: P2| if along_ridge(a, b, p.ridge_axis) { oe } else { og };
    let eaves = offset_ring(&ring, if p.shape == Shape::Sattel { Offset::PerEdge(&per_edge) } else { Offset::Const(oe) });
    let tan = (nn(p.pitch_deg) * DEG).tan();
    let gabled = p.shape == Shape::Sattel || (p.shape == Shape::Mansarde && p.mansard_type == MansardType::Giebel);
    let axis = if gabled { Some(p.ridge_axis) } else { None };
    let knee = if p.shape == Shape::Mansarde {
        // Knick bei `mansard_knee_ratio` der maximalen Dachtiefe (Abstand First–Traufe).
        let depth = hip_roof(&eaves, 1.0, 0.0, axis, None).ridge_height;
        Some(Knee { d: depth * knee_ratio(p), tan_up: upper_tan(p) })
    } else {
        None
    };
    let sk = hip_roof(&eaves, tan, e, axis, knee);
    RoofGeometry { eaves, ridges: sk.ridges, hips: sk.hips, breaks: sk.breaks, planes: sk.planes, gables: sk.gables, ridge_height: sk.ridge_height }
}

/// Pultdach auf rechtwinkligem Grundriss: EINE Ebene über dem (um Traufe/Ortgang geweiteten)
/// Umriss. Tief bei kleinstem y (First entlang x) bzw. x (First entlang y); Kanten quer zum
/// First bekommen senkrechte Giebel.
fn rectilinear_pult(p: &RoofParams, e: f64) -> RoofGeometry {
    let ring = ccw_ring(&p.outline);
    let oe = nn(p.overhang);
    let og = nn(p.overhang_gable.unwrap_or(p.overhang));
    let per_edge = |a: P2, b: P2| if along_ridge(a, b, p.ridge_axis) { oe } else { og };
    let eaves = offset_ring(&ring, Offset::PerEdge(&per_edge));
    let tan = (nn(p.pitch_deg) * DEG).tan();
    let s = |q: P2| if p.ridge_axis == Axis::X { q[1] } else { q[0] };
    let smin = eaves.iter().map(|&q| s(q)).fold(f64::INFINITY, f64::min);
    let smax = eaves.iter().map(|&q| s(q)).fold(f64::NEG_INFINITY, f64::max);
    let up = |q: P2| -> P3 { [q[0], q[1], e + tan * (s(q) - smin)] };
    let n = eaves.len();
    let gables = (0..n)
        .filter_map(|i| {
            let (a, b) = (eaves[i], eaves[(i + 1) % n]);
            (!along_ridge(a, b, p.ridge_axis)).then(|| vec![[a[0], a[1], e], [b[0], b[1], e], up(b), up(a)])
        })
        .collect();
    let planes = convex_pieces(&eaves).into_iter().map(|pc| pc.into_iter().map(up).collect()).collect();
    RoofGeometry { eaves, ridges: vec![], hips: vec![], breaks: vec![], planes, gables, ridge_height: (smax - smin) * tan }
}

/// Punkt-in-Polygon (Ray-Casting), 2D-Aufsicht.
fn point_in_polygon(x: f64, y: f64, poly: &[P3]) -> bool {
    let n = poly.len();
    let mut inside = false;
    let mut j = n.wrapping_sub(1);
    for i in 0..n {
        let (a, b) = (poly[i], poly[j]);
        let dy = b[1] - a[1];
        let dy = if dy == 0.0 { 1e-12 } else { dy };
        if (a[1] > y) != (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / dy + a[0] {
            inside = !inside;
        }
        j = i;
    }
    inside
}

/// Dach-UNTERKANTE an einem Grundriss-Punkt (x, y): Oberkante der ersten Dachfläche, die den
/// Punkt in der Aufsicht enthält (Ebene über die Newell-Normale), minus die Schichtdicke
/// `total_layer_thickness`; `None` ausserhalb aller Flächen. Dient dem Wand-Zuschnitt unter
/// geneigten Dächern (`toWalls3d/bands.ts`).
pub fn roof_underside_at(planes: &[Vec<P3>], total_layer_thickness: f64, x: f64, y: f64) -> Option<f64> {
    for pts in planes {
        if pts.len() < 3 || !point_in_polygon(x, y, pts) {
            continue;
        }
        let (mut a, mut b, mut c) = (0.0, 0.0, 0.0);
        for i in 0..pts.len() {
            let p = pts[i];
            let q = pts[(i + 1) % pts.len()];
            a += (p[1] - q[1]) * (p[2] + q[2]);
            b += (p[2] - q[2]) * (p[0] + q[0]);
            c += (p[0] - q[0]) * (p[1] + q[1]);
        }
        if c.abs() < 1e-9 {
            continue; // (nahezu) senkrechte Fläche
        }
        let top = pts[0][2] - (a * (x - pts[0][0]) + b * (y - pts[0][1])) / c;
        return Some(top - nn(total_layer_thickness));
    }
    None
}

// ── Flache Kodierung für die WASM-Grenze ─────────────────────────────────────
//
// Eingabe: [shape, pitchDeg, pitchUpperDeg, mansardType, mansardKneeRatio, halfHipRatio,
//           overhang, overhangGable, ridgeAxis, nPts, x0, y0, …]
//   shape: 0 flach, 1 pult, 2 sattel, 3 walm, 4 mansarde, 5 zelt;
//   mansardType: 0 giebel, 1 walm, 2 zelt; ridgeAxis: 0 x, 1 y; NaN = Feld fehlt.
// Ausgabe: [ridgeHeight, nEaves, (x, y)…, nRidges, (x, y, x, y)…, nHips, …, nBreaks, …,
//           nPlanes, (n, (x, y, z)…)…, nGables, (n, (x, y, z)…)…]

fn opt(v: f64) -> Option<f64> {
    v.is_finite().then_some(v)
}

/// Liest die Dachparameter; `None` bei zu kurzen/kaputten Daten.
pub fn decode_params(buf: &[f64]) -> Option<RoofParams> {
    let head = buf.get(..10)?;
    let shape = match head[0] as i64 {
        1 => Shape::Pult,
        2 => Shape::Sattel,
        3 => Shape::Walm,
        4 => Shape::Mansarde,
        5 => Shape::Zelt,
        _ => Shape::Flach,
    };
    let mansard_type = match head[3] as i64 {
        1 => MansardType::Walm,
        2 => MansardType::Zelt,
        _ => MansardType::Giebel,
    };
    let n = head[9];
    if !(n.is_finite() && n >= 0.0 && n.fract() == 0.0) {
        return None;
    }
    let pts = buf.get(10..10 + 2 * n as usize)?;
    Some(RoofParams {
        outline: pts.chunks_exact(2).map(|c| [c[0], c[1]]).collect(),
        shape,
        pitch_deg: head[1],
        pitch_upper_deg: opt(head[2]),
        mansard_type,
        mansard_knee_ratio: opt(head[4]),
        half_hip_ratio: opt(head[5]),
        overhang: head[6],
        overhang_gable: opt(head[7]),
        ridge_axis: if head[8] == 1.0 { Axis::Y } else { Axis::X },
    })
}

fn push_lines(out: &mut Vec<f64>, lines: &[Line]) {
    out.push(lines.len() as f64);
    for l in lines {
        out.extend_from_slice(&[l[0][0], l[0][1], l[1][0], l[1][1]]);
    }
}

/// Flächenliste `[n, (m, (x, y, z)…)…]` anhängen.
pub fn push_polys3(out: &mut Vec<f64>, polys: &[Vec<P3>]) {
    out.push(polys.len() as f64);
    for pl in polys {
        out.push(pl.len() as f64);
        for v in pl {
            out.extend_from_slice(v);
        }
    }
}

/// Liest eine Flächenliste `[n, (m, (x, y, z)…)…]`; `None` bei kaputten Daten.
pub fn decode_polys3(buf: &[f64]) -> Option<Vec<Vec<P3>>> {
    let count = |v: f64| (v.is_finite() && v >= 0.0 && v.fract() == 0.0 && v < 1e9).then_some(v as usize);
    let n = count(*buf.first()?)?;
    let mut i = 1;
    let mut out = Vec::with_capacity(n.min(1 << 16));
    for _ in 0..n {
        let m = count(*buf.get(i)?)?;
        i += 1;
        let pts = buf.get(i..i + 3 * m)?;
        i += 3 * m;
        out.push(pts.chunks_exact(3).map(|c| [c[0], c[1], c[2]]).collect());
    }
    Some(out)
}

pub fn encode_geometry(g: &RoofGeometry) -> Vec<f64> {
    let mut out = vec![g.ridge_height, g.eaves.len() as f64];
    for p in &g.eaves {
        out.extend_from_slice(p);
    }
    push_lines(&mut out, &g.ridges);
    push_lines(&mut out, &g.hips);
    push_lines(&mut out, &g.breaks);
    push_polys3(&mut out, &g.planes);
    push_polys3(&mut out, &g.gables);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const RECT: [P2; 4] = [[0.0, 0.0], [6.0, 0.0], [6.0, 4.0], [0.0, 4.0]];
    const L: [P2; 6] = [[0.0, 0.0], [11.0, 0.0], [11.0, 4.0], [8.0, 4.0], [8.0, 6.0], [0.0, 6.0]];

    fn params(outline: &[P2], shape: Shape) -> RoofParams {
        RoofParams {
            outline: outline.to_vec(),
            shape,
            pitch_deg: 45.0,
            pitch_upper_deg: None,
            mansard_type: MansardType::Giebel,
            mansard_knee_ratio: None,
            half_hip_ratio: None,
            overhang: 0.0,
            overhang_gable: None,
            ridge_axis: Axis::X,
        }
    }

    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-9
    }

    fn plan_area(g: &RoofGeometry) -> f64 {
        g.planes.iter().map(|p| signed_area(&p.iter().map(|v| [v[0], v[1]]).collect::<Vec<_>>()).abs()).sum()
    }

    #[test]
    fn flach() {
        let g = roof_geometry(&params(&RECT, Shape::Flach), 3.0);
        assert_eq!(g.planes.len(), 1);
        assert!(g.planes[0].iter().all(|v| v[2] == 3.0));
        assert!(g.ridges.is_empty() && g.ridge_height == 0.0);
    }

    #[test]
    fn pult() {
        let g = roof_geometry(&params(&RECT, Shape::Pult), 0.0);
        assert_eq!(g.planes.len(), 1);
        assert!(close(g.ridge_height, 4.0));
        assert_eq!(g.gables.len(), 2);
    }

    #[test]
    fn sattel_und_kruppelwalm() {
        let g = roof_geometry(&params(&RECT, Shape::Sattel), 0.0);
        assert_eq!((g.planes.len(), g.gables.len()), (2, 2));
        assert!(close(g.ridge_height, 2.0));
        assert_eq!(g.ridges, vec![[[0.0, 2.0], [6.0, 2.0]]]);
        let k = roof_geometry(&RoofParams { half_hip_ratio: Some(0.3), ..params(&RECT, Shape::Sattel) }, 0.0);
        assert_eq!(k.planes.len(), 4);
        assert!(close(k.ridges[0][0][0], 0.6) && close(k.ridges[0][1][0], 5.4));
        assert!(close(plan_area(&k), 24.0));
    }

    #[test]
    fn walm() {
        let g = roof_geometry(&params(&RECT, Shape::Walm), 0.0);
        assert_eq!((g.planes.len(), g.hips.len(), g.gables.len()), (4, 4, 0));
        assert!(close(g.ridges[0][0][0], 2.0) && close(g.ridges[0][1][0], 4.0));
    }

    #[test]
    fn zelt() {
        let g = roof_geometry(&params(&RECT, Shape::Zelt), 0.0);
        assert_eq!((g.planes.len(), g.hips.len()), (4, 4));
        assert!(close(g.ridge_height, 2.0));
    }

    #[test]
    fn mansarde_alle_untertypen() {
        let g = roof_geometry(&params(&RECT, Shape::Mansarde), 0.0);
        assert_eq!((g.planes.len(), g.breaks.len(), g.gables.len()), (4, 2, 2));
        assert!(g.ridge_height > 0.8 && g.ridge_height < 2.0);
        let w = roof_geometry(&RoofParams { mansard_type: MansardType::Walm, ..params(&RECT, Shape::Mansarde) }, 0.0);
        assert_eq!((w.planes.len(), w.breaks.len(), w.hips.len()), (8, 4, 8));
        let z = roof_geometry(&RoofParams { mansard_type: MansardType::Zelt, ..params(&RECT, Shape::Mansarde) }, 0.0);
        assert_eq!((z.planes.len(), z.ridges.len(), z.hips.len()), (8, 0, 8));
    }

    #[test]
    fn first_entlang_y_und_ueberstand() {
        let g = roof_geometry(&RoofParams { ridge_axis: Axis::Y, overhang: 0.5, overhang_gable: Some(1.0), ..params(&RECT, Shape::Sattel) }, 0.0);
        // Ortgang (1.0) entlang y, Traufe (0.5) entlang x.
        assert_eq!(g.eaves[0], [-0.5, -1.0]);
        assert_eq!(g.eaves[2], [6.5, 5.0]);
        assert!(close(g.ridges[0][0][0], 3.0));
    }

    #[test]
    fn skelett_formen_auf_l() {
        for shape in [Shape::Walm, Shape::Sattel, Shape::Mansarde, Shape::Zelt, Shape::Pult] {
            let g = roof_geometry(&params(&L, shape), 0.0);
            assert!(close(plan_area(&g), 60.0), "{shape:?}: {}", plan_area(&g));
        }
        let pult = roof_geometry(&params(&L, Shape::Pult), 0.0);
        assert!(close(pult.ridge_height, 6.0));
        assert_eq!(pult.gables.len(), 3);
    }

    #[test]
    fn unterkante() {
        let g = roof_geometry(&params(&RECT, Shape::Sattel), 10.0);
        assert!(close(roof_underside_at(&g.planes, 0.3, 3.0, 1.0).unwrap(), 10.7));
        assert!(roof_underside_at(&g.planes, 0.3, 30.0, 1.0).is_none());
        assert!((roof_underside_at(&g.planes, -1.0, 3.0, 2.0 - 1e-9).unwrap() - 12.0).abs() < 1e-6);
    }

    #[test]
    fn kodierung_hin_und_zurueck() {
        let buf = [3.0, 30.0, f64::NAN, 1.0, 0.3, f64::NAN, 0.5, f64::NAN, 1.0, 3.0, 0.0, 0.0, 1.0, 0.0, 1.0, 1.0];
        let p = decode_params(&buf).unwrap();
        assert_eq!((p.shape, p.mansard_type, p.ridge_axis, p.outline.len()), (Shape::Walm, MansardType::Walm, Axis::Y, 3));
        assert_eq!((p.pitch_upper_deg, p.mansard_knee_ratio), (None, Some(0.3)));
        let g = roof_geometry(&params(&RECT, Shape::Walm), 0.0);
        let enc = encode_geometry(&g);
        // Flächen stehen hinter Kopf, Traufe und drei Linienlisten.
        let off = 2 + 2 * 4 + 1 + 4 * g.ridges.len() + 1 + 4 * g.hips.len() + 1;
        assert_eq!(decode_polys3(&enc[off..]).unwrap(), g.planes);
    }

    #[test]
    fn unsinn_ohne_panic() {
        assert!(decode_params(&[]).is_none());
        assert!(decode_params(&[0.0; 9]).is_none());
        assert!(decode_params(&[0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 5.0, 1.0]).is_none());
        assert!(decode_params(&[0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, f64::NAN]).is_none());
        assert!(decode_polys3(&[2.0, 1.0]).is_none());
        // Leerer Umriss → leere Geometrie.
        assert_eq!(roof_geometry(&params(&[], Shape::Walm), 0.0), RoofGeometry::default());
        assert_eq!(roof_geometry(&params(&[[f64::NAN, 1.0]], Shape::Sattel), 0.0), RoofGeometry::default());
        // NaN in Parametern und Höhe: kein Panic, endliche Werte.
        for shape in [Shape::Flach, Shape::Pult, Shape::Sattel, Shape::Walm, Shape::Mansarde, Shape::Zelt] {
            for outline in [&RECT[..], &L[..], &[[0.0, 0.0], [1.0, 1.0]][..], &[[2.0, 2.0]][..]] {
                let p = RoofParams {
                    pitch_deg: f64::NAN,
                    overhang: f64::NAN,
                    half_hip_ratio: Some(f64::NAN),
                    mansard_knee_ratio: Some(f64::INFINITY),
                    ..params(outline, shape)
                };
                let g = roof_geometry(&p, f64::NAN);
                assert!(g.planes.iter().flatten().all(|v| v.iter().all(|c| c.is_finite())), "{shape:?}");
            }
        }
        let _ = roof_underside_at(&[vec![[0.0, 0.0, 0.0]], vec![]], f64::NAN, f64::NAN, 0.0);
    }
}
