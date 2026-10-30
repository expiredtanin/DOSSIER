//! Öffnungs-Formen ([G3]) und Öffnungen in Dach/Decke ([103]).
//!
//! **Formen:** Rundbogen, Segmentbogen, Spitzbogen, Rund (Ellipse), Schräg, Giebel als konvexer Umriss
//! in der Öffnungsebene (u = 0 … Breite entlang der Wand, v = 0 … Höhe ab Brüstung, Gegenuhrzeigersinn).
//! Die Wand behält ihr Rechteck-Loch (render3d, Wandbänder, Exporte bleiben unverändert); was zwischen
//! Rechteck und Umriss stehen bleibt, kommt als **Füllkörper** dazu — senkrechte Streifen zwischen den
//! Umriss-Ecken, je ein konvexes Viereck, also gewöhnliche 8-Ecken-Quader wie die Fenster-Einbauteile.
//! Dieselbe Zerlegung liefert Rahmen (Ring Umriss → eingerückter Umriss) und Glas.
//!
//! **Wirte Dach/Decke:** [`host_frame`] legt ein Rechteck `width × height` in die Dachfläche bzw. auf die
//! Deckenoberkante (Mittelpunkt `hostPoint`), Breite längs der Traufe, Höhe das Gefälle hinauf. Die
//! Öffnung schneidet alle Schichten senkrecht zur Fläche (Normale `n`).

use crate::model::*;

pub type P = [f64; 2];
pub type V3 = [f64; 3];

const MIN: f64 = 1e-6;
/// Bogen-Feinheit: höchstens 7,5° je Sehne.
const ARC_STEP: f64 = std::f64::consts::PI / 24.0;

/// Hat die Öffnung eine Form ausser dem Rechteck?
pub fn is_shaped(o: &Opening) -> bool {
    matches!(o.shape, Some(s) if s != OpeningShape::Rechteck && s != OpeningShape::Unknown)
}

/// Gerader (flacher) Boden: Fensterbank/Schwelle möglich (alle Formen ausser Rund).
pub fn has_flat_bottom(o: &Opening) -> bool {
    o.shape != Some(OpeningShape::Rund)
}

fn arc(out: &mut Vec<P>, c: P, r: f64, a0: f64, a1: f64) {
    let n = (((a1 - a0).abs() / ARC_STEP).ceil() as usize).clamp(2, 96);
    for k in 0..=n {
        let a = a0 + (a1 - a0) * k as f64 / n as f64;
        out.push([c[0] + r * a.cos(), c[1] + r * a.sin()]);
    }
}

fn dedup(mut pts: Vec<P>) -> Vec<P> {
    pts.dedup_by(|b, a| (a[0] - b[0]).abs() < MIN && (a[1] - b[1]).abs() < MIN);
    while pts.len() > 1 {
        let (f, l) = (pts[0], pts[pts.len() - 1]);
        if (f[0] - l[0]).abs() < MIN && (f[1] - l[1]).abs() < MIN {
            pts.pop();
        } else {
            break;
        }
    }
    pts
}

/// Umriss der Form in `w × h` (konvex, Gegenuhrzeigersinn); `None` für Rechteck oder Unsinn.
pub fn outline(shape: OpeningShape, rise: Option<f64>, w: f64, h: f64) -> Option<Vec<P>> {
    if !(w > MIN && h > MIN && w.is_finite() && h.is_finite()) {
        return None;
    }
    let rise = rise.filter(|r| r.is_finite());
    let mut pts: Vec<P> = Vec::new();
    match shape {
        OpeningShape::Rundbogen | OpeningShape::Segmentbogen => {
            let r = if shape == OpeningShape::Rundbogen { w / 2.0 } else { rise.unwrap_or(w / 6.0) };
            let r = r.clamp(MIN * 10.0, (w / 2.0).min(h));
            let big = (w * w / 4.0 + r * r) / (2.0 * r);
            let c = [w / 2.0, h - big];
            let a0 = (big - r).atan2(w / 2.0);
            pts.push([0.0, 0.0]);
            pts.push([w, 0.0]);
            arc(&mut pts, c, big, a0, std::f64::consts::PI - a0);
        }
        OpeningShape::Spitzbogen => {
            let r = rise.unwrap_or(w * 3f64.sqrt() / 2.0).clamp(w / 2.0, h.max(w / 2.0)).min(h);
            if r < w / 2.0 - MIN {
                // Zu niedrig für einen Spitzbogen: Rundbogen.
                return outline(OpeningShape::Rundbogen, None, w, h);
            }
            let s = h - r;
            let c = (w * w / 4.0 + r * r) / w;
            pts.push([0.0, 0.0]);
            pts.push([w, 0.0]);
            // Rechter Bogen um (w − c, s) von (w, s) zum Scheitel, linker um (c, s) vom Scheitel nach (0, s).
            let apex_r = r.atan2(w / 2.0 - (w - c));
            arc(&mut pts, [w - c, s], c, 0.0, apex_r);
            let apex_l = r.atan2(w / 2.0 - c);
            arc(&mut pts, [c, s], c, apex_l, std::f64::consts::PI);
        }
        OpeningShape::Rund => {
            let n = 48;
            for k in 0..n {
                let a = -std::f64::consts::FRAC_PI_2 + 2.0 * std::f64::consts::PI * k as f64 / n as f64;
                pts.push([w / 2.0 + w / 2.0 * a.cos(), h / 2.0 + h / 2.0 * a.sin()]);
            }
        }
        OpeningShape::Schraeg => {
            let d = rise.unwrap_or(w / 2.0).clamp(-h, h);
            pts = vec![[0.0, 0.0], [w, 0.0], [w, h - (-d).max(0.0)], [0.0, h - d.max(0.0)]];
        }
        OpeningShape::Giebel => {
            let r = rise.unwrap_or(w / 2.0).clamp(0.0, h);
            pts = vec![[0.0, 0.0], [w, 0.0], [w, h - r], [w / 2.0, h], [0.0, h - r]];
        }
        _ => return None,
    }
    let pts = dedup(pts);
    (pts.len() >= 3).then_some(pts)
}

/// Umriss einer Öffnung (Form aus dem Modell), sonst `None`.
pub fn opening_outline(o: &Opening, w: f64, h: f64) -> Option<Vec<P>> {
    if !is_shaped(o) {
        return None;
    }
    outline(o.shape.unwrap_or_default(), o.shape_rise, w, h)
}

/// Senkrechte Ausdehnung `[v_lo, v_hi]` eines konvexen Umrisses bei `u`; ausserhalb ⇒ `None`.
pub fn v_range(poly: &[P], u: f64) -> Option<(f64, f64)> {
    let (mut lo, mut hi) = (f64::INFINITY, f64::NEG_INFINITY);
    for i in 0..poly.len() {
        let (a, b) = (poly[i], poly[(i + 1) % poly.len()]);
        let (u0, u1) = (a[0].min(b[0]), a[0].max(b[0]));
        if u < u0 - MIN || u > u1 + MIN {
            continue;
        }
        if (b[0] - a[0]).abs() < MIN {
            lo = lo.min(a[1].min(b[1]));
            hi = hi.max(a[1].max(b[1]));
        } else {
            let t = ((u - a[0]) / (b[0] - a[0])).clamp(0.0, 1.0);
            let v = a[1] + (b[1] - a[1]) * t;
            lo = lo.min(v);
            hi = hi.max(v);
        }
    }
    (lo <= hi).then_some((lo, hi))
}

fn breakpoints(poly: &[P], extra: &[f64]) -> Vec<f64> {
    let mut us: Vec<f64> = poly.iter().map(|q| q[0]).chain(extra.iter().copied()).collect();
    us.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    us.dedup_by(|b, a| (*a - *b).abs() < MIN);
    us
}

/// Füllstreifen zwischen Rechteck `w × h` und Umriss: konvexe Vierecke (Gegenuhrzeigersinn).
pub fn fill_quads(poly: &[P], w: f64, h: f64) -> Vec<[P; 4]> {
    let mut out = Vec::new();
    let us = breakpoints(poly, &[0.0, w]);
    for k in 0..us.len().saturating_sub(1) {
        let (ua, ub) = (us[k], us[k + 1]);
        if ub - ua < MIN {
            continue;
        }
        let ra = v_range(poly, ua).unwrap_or((h, h));
        let rb = v_range(poly, ub).unwrap_or((h, h));
        if h - ra.1 > MIN || h - rb.1 > MIN {
            out.push([[ua, ra.1], [ub, rb.1], [ub, h], [ua, h]]);
        }
        if ra.0 > MIN || rb.0 > MIN {
            out.push([[ua, 0.0], [ub, 0.0], [ub, rb.0], [ua, ra.0]]);
        }
    }
    out
}

/// Konvexes Polygon in senkrechte Streifen zerlegt (Glas).
pub fn strip_quads(poly: &[P]) -> Vec<[P; 4]> {
    let mut out = Vec::new();
    let us = breakpoints(poly, &[]);
    for k in 0..us.len().saturating_sub(1) {
        let (ua, ub) = (us[k], us[k + 1]);
        if ub - ua < MIN {
            continue;
        }
        let (Some(ra), Some(rb)) = (v_range(poly, ua), v_range(poly, ub)) else { continue };
        out.push([[ua, ra.0], [ub, rb.0], [ub, rb.1], [ua, ra.1]]);
    }
    out
}

/// Konvexes Polygon (Gegenuhrzeigersinn) um `d` nach innen versetzt (Gehrung je Ecke).
pub fn inset(poly: &[P], d: f64) -> Vec<P> {
    let n = poly.len();
    let line = |i: usize| -> (P, P) {
        let (a, b) = (poly[i], poly[(i + 1) % n]);
        let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
        let l = (dx * dx + dy * dy).sqrt().max(1e-12);
        let nl = [-dy / l, dx / l];
        ([a[0] + nl[0] * d, a[1] + nl[1] * d], [dx / l, dy / l])
    };
    (0..n)
        .map(|i| {
            let (p0, d0) = line((i + n - 1) % n);
            let (p1, d1) = line(i);
            let den = d0[0] * d1[1] - d0[1] * d1[0];
            if den.abs() < 1e-9 {
                return p1;
            }
            let t = ((p1[0] - p0[0]) * d1[1] - (p1[1] - p0[1]) * d1[0]) / den;
            [p0[0] + d0[0] * t, p0[1] + d0[1] * t]
        })
        .collect()
}

/// Rahmen-Ring: je Umriss-Kante ein Viereck zwischen Aussen- und Innenumriss.
pub fn ring_quads(outer: &[P], inner: &[P]) -> Vec<[P; 4]> {
    let n = outer.len().min(inner.len());
    (0..n).map(|i| [outer[i], outer[(i + 1) % n], inner[(i + 1) % n], inner[i]]).collect()
}

/// Quader-Ecken (Bit 0 = u, Bit 1 = v, Bit 2 = n wie `OPENING_BOX_TRIS`) eines Vierecks `q`
/// (Gegenuhrzeigersinn) zwischen `n0` und `n1`; `map(u, v, n)` → Modellpunkt (x, y, z).
pub fn quad_box(q: &[P; 4], n0: f64, n1: f64, map: &impl Fn(f64, f64, f64) -> V3) -> [f64; 24] {
    let order = [q[0], q[1], q[3], q[2]];
    let mut out = [0.0; 24];
    for i in 0..8 {
        let [u, v] = order[i & 3];
        let p = map(u, v, if i & 4 != 0 { n1 } else { n0 });
        out[i * 3..i * 3 + 3].copy_from_slice(&p);
    }
    out
}

// ── Wirte Dach und Decke ([103]) ─────────────────────────────────────────────

/// Öffnungs-System in einer Dach- oder Deckenfläche: Mittelpunkt `c` auf der Oberfläche, `ew` Breite
/// (waagrecht), `eh` Höhe (das Gefälle hinauf), `n` Flächennormale nach oben; `thickness` = alle Schichten.
#[derive(Clone, Debug, PartialEq)]
pub struct HostFrame {
    pub c: V3,
    pub ew: V3,
    pub eh: V3,
    pub n: V3,
    pub thickness: f64,
    /// Dachfläche (Index in `roof_geometry().planes`), bei Decken `None`.
    pub plane: Option<usize>,
    /// Index des Wirts in `Project::roofs` bzw. `Project::ceilings`.
    pub host: usize,
}

impl HostFrame {
    /// Punkt in Breite `u`, Höhe `v` (ab Mitte) und `d` unter der Oberfläche.
    pub fn at(&self, u: f64, v: f64, d: f64) -> V3 {
        let mut p = self.c;
        for k in 0..3 {
            p[k] += self.ew[k] * u + self.eh[k] * v - self.n[k] * d;
        }
        p
    }
}

pub fn cross(a: V3, b: V3) -> V3 {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

pub fn dot(a: V3, b: V3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn normalize(a: V3) -> Option<V3> {
    let l = dot(a, a).sqrt();
    (l > 1e-12 && l.is_finite()).then(|| [a[0] / l, a[1] / l, a[2] / l])
}

fn point_in_xy(x: f64, y: f64, poly: &[V3]) -> bool {
    let mut inside = false;
    let n = poly.len();
    let mut j = n.wrapping_sub(1);
    for i in 0..n {
        let (a, b) = (poly[i], poly[j]);
        if (a[1] > y) != (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0] {
            inside = !inside;
        }
        j = i;
    }
    inside
}

fn axes(n: V3, angle_deg: f64) -> (V3, V3) {
    let ew = normalize([-n[1], n[0], 0.0]).unwrap_or_else(|| {
        let a = angle_deg.to_radians();
        [a.cos(), a.sin(), 0.0]
    });
    (ew, cross(n, ew))
}

/// Ist die Öffnung in einem Dach oder einer Decke gehostet?
pub fn is_surface_hosted(o: &Opening) -> bool {
    o.host_roof_id.as_deref().is_some_and(|s| !s.is_empty()) || o.host_ceiling_id.as_deref().is_some_and(|s| !s.is_empty())
}

/// Öffnungs-System eines Dach-/Deckenwirts; `None` ohne Wirt, Lage ausserhalb oder Unsinn.
pub fn host_frame(p: &Project, o: &Opening) -> Option<HostFrame> {
    let hp = o.host_point?;
    if !(hp.x.is_finite() && hp.y.is_finite() && o.width > MIN && o.height > MIN) {
        return None;
    }
    let angle = o.host_angle.filter(|a| a.is_finite()).unwrap_or(0.0);
    if let Some(id) = o.host_roof_id.as_deref().filter(|s| !s.is_empty()) {
        let (host, roof) = p.roofs.as_deref()?.iter().enumerate().find(|(_, r)| r.id == id)?;
        let g = crate::roof::roof_geometry(&roof.params(), p.roof_base_elevation(roof));
        let (plane, pts) = g.planes.iter().enumerate().find(|(_, pl)| pl.len() >= 3 && point_in_xy(hp.x, hp.y, pl))?;
        let n = crate::model3d::plane_normal_up(pts);
        if n[2] < 1e-3 {
            return None;
        }
        let z = pts[0][2] - (n[0] * (hp.x - pts[0][0]) + n[1] * (hp.y - pts[0][1])) / n[2];
        let thickness = p.roof_layers(roof).iter().fold(0.0, |s, l| s + l.thickness.max(0.0));
        let (ew, eh) = axes(n, angle);
        return Some(HostFrame { c: [hp.x, hp.y, z], ew, eh, n, thickness, plane: Some(plane), host });
    }
    let id = o.host_ceiling_id.as_deref().filter(|s| !s.is_empty())?;
    let (host, c) = p.ceilings.as_deref()?.iter().enumerate().find(|(_, c)| c.id == id)?;
    let (zb, zt) = p.ceiling_vertical_extent(c);
    let n = [0.0, 0.0, 1.0];
    let (ew, eh) = axes(n, angle);
    Some(HostFrame { c: [hp.x, hp.y, zt], ew, eh, n, thickness: (zt - zb).max(0.0), plane: None, host })
}

/// Rechteck der Öffnung im Grundriss (Oberfläche, Gegenuhrzeigersinn).
pub fn host_rect_plan(f: &HostFrame, w: f64, h: f64) -> [V3; 4] {
    [f.at(-w / 2.0, -h / 2.0, 0.0), f.at(w / 2.0, -h / 2.0, 0.0), f.at(w / 2.0, h / 2.0, 0.0), f.at(-w / 2.0, h / 2.0, 0.0)]
}

/// Aussparungen einer Decke: gezeichnete (`openings`) und die der gehosteten Öffnungen.
pub fn ceiling_hole_rings(p: &Project, c: &Ceiling) -> Vec<Vec<Vec2>> {
    let mut out: Vec<Vec<Vec2>> = c.openings.clone().unwrap_or_default();
    for o in p.openings.as_deref().unwrap_or(&[]) {
        if o.host_ceiling_id.as_deref() != Some(c.id.as_str()) {
            continue;
        }
        if let Some(f) = host_frame(p, o) {
            out.push(host_rect_plan(&f, o.width, o.height).iter().map(|q| Vec2 { x: q[0], y: q[1] }).collect());
        }
    }
    out
}

/// Dachfenster eines Dachs (Index in `Project::roofs`) mit ihrem System.
pub fn roof_openings(p: &Project, roof_index: usize) -> Vec<(&Opening, HostFrame)> {
    let Some(roof) = p.roofs.as_deref().and_then(|r| r.get(roof_index)) else { return Vec::new() };
    p.openings
        .as_deref()
        .unwrap_or(&[])
        .iter()
        .filter(|o| o.host_roof_id.as_deref() == Some(roof.id.as_str()))
        .filter_map(|o| host_frame(p, o).map(|f| (o, f)))
        .collect()
}

/// Rahmenbreite eines Dach-/Deckenfensters (Fenstertyp, sonst 7 cm).
pub fn surface_frame_width(p: &Project, o: &Opening) -> f64 {
    p.window_type(o).and_then(|t| t.frame_width).filter(|v| *v > 0.0).unwrap_or(0.07).min(o.width.min(o.height) / 3.0)
}

/// Einbauteile eines Dach-/Deckenfensters als Quader `(Bauteil, Ecken)`: Rahmen (Ring in der lichten
/// Öffnung, 6 cm über die Oberfläche hinaus, Tiefe = Rahmentiefe des Typs, sonst 16 cm), Glas oben im
/// Rahmen, Eindeckrahmen (vereinfacht: flacher Ring 6 cm breit, 3 cm hoch rund um die Öffnung).
/// Bauteil-Codes wie `openings3d::Part` (0 Glas, 1 Rahmen, 2 Sonnenschutz/Blech).
pub fn surface_window_boxes(p: &Project, o: &Opening, f: &HostFrame) -> Vec<(u8, [f64; 24])> {
    let (w, h) = (o.width, o.height);
    let fw = surface_frame_width(p, o);
    let depth = p.window_type(o).and_then(|t| t.frame_depth).filter(|v| *v > 0.0).unwrap_or(0.16).min(f.thickness.max(0.05) + 0.06);
    let map = |u: f64, v: f64, n: f64| f.at(u - w / 2.0, v - h / 2.0, -n);
    let outer = vec![[0.0, 0.0], [w, 0.0], [w, h], [0.0, h]];
    let inner = inset(&outer, fw);
    let mut out = Vec::new();
    let top = 0.06;
    for q in ring_quads(&outer, &inner) {
        out.push((1, quad_box(&q, top - depth, top, &map)));
    }
    if o.kind == ElementKind::Window {
        for q in strip_quads(&inner) {
            out.push((0, quad_box(&q, top - 0.03, top - 0.01, &map)));
        }
    }
    if o.host_roof_id.is_some() {
        let flash = [[-0.06, -0.06], [w + 0.06, -0.06], [w + 0.06, h + 0.06], [-0.06, h + 0.06]];
        for q in ring_quads(&flash, &outer) {
            out.push((2, quad_box(&q, 0.0, 0.03, &map)));
        }
    }
    out
}

// ── Schnitt (senkrechte Ebene) ──────────────────────────────────────────────

/// Kanten eines 8-Ecken-Quaders (Ecken unterscheiden sich in genau einem Bit).
const BOX_EDGES: [(usize, usize); 12] = [(0, 1), (2, 3), (4, 5), (6, 7), (0, 2), (1, 3), (4, 6), (5, 7), (0, 4), (1, 5), (2, 6), (3, 7)];

/// Schnitt eines konvexen 8-Ecken-Quaders (`quad_box`-Ecken) mit der senkrechten Schnittebene durch `base`
/// in Richtung `u` (Grundriss): konvexes Polygon in Schnitt-Koordinaten (t entlang `u`, z), Gegenuhrzeigersinn.
pub fn box_section(corners: &[f64; 24], base: (f64, f64), u: (f64, f64)) -> Option<Vec<P>> {
    let c = |i: usize| [corners[i * 3], corners[i * 3 + 1], corners[i * 3 + 2]];
    let side = |q: V3| (q[0] - base.0) * -u.1 + (q[1] - base.1) * u.0;
    let mut pts: Vec<P> = Vec::new();
    for (a, b) in BOX_EDGES {
        let (pa, pb) = (c(a), c(b));
        let (sa, sb) = (side(pa), side(pb));
        if (sa > 0.0) == (sb > 0.0) || (sa - sb).abs() < 1e-15 {
            continue;
        }
        let t = sa / (sa - sb);
        let q = [pa[0] + (pb[0] - pa[0]) * t, pa[1] + (pb[1] - pa[1]) * t, pa[2] + (pb[2] - pa[2]) * t];
        pts.push([(q[0] - base.0) * u.0 + (q[1] - base.1) * u.1, q[2]]);
    }
    if pts.len() < 3 {
        return None;
    }
    let cx = pts.iter().map(|q| q[0]).sum::<f64>() / pts.len() as f64;
    let cy = pts.iter().map(|q| q[1]).sum::<f64>() / pts.len() as f64;
    pts.sort_by(|a, b| (a[1] - cy).atan2(a[0] - cx).partial_cmp(&(b[1] - cy).atan2(b[0] - cx)).unwrap_or(std::cmp::Ordering::Equal));
    let pts = dedup(pts);
    (pts.len() >= 3 && polygon_area(&pts) > 1e-10).then_some(pts)
}

fn polygon_area(p: &[P]) -> f64 {
    (0..p.len()).map(|i| p[i][0] * p[(i + 1) % p.len()][1] - p[(i + 1) % p.len()][0] * p[i][1]).sum::<f64>() / 2.0
}

fn clip_half(pts: &[P], a: P, b: P, keep_left: bool) -> Vec<P> {
    let side = |p: P| {
        let c = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
        if keep_left { c } else { -c }
    };
    let mut out = Vec::new();
    for i in 0..pts.len() {
        let (p, q) = (pts[i], pts[(i + 1) % pts.len()]);
        let (sp, sq) = (side(p), side(q));
        if sp >= 0.0 {
            out.push(p);
        }
        if (sp >= 0.0) != (sq >= 0.0) {
            let t = sp / (sp - sq);
            out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
        }
    }
    out
}

/// Konvexes Polygon minus konvexes Loch: konvexe Reststücke (leer, wenn ganz im Loch).
pub fn subtract_convex(poly: &[P], hole: &[P]) -> Vec<Vec<P>> {
    let mut h = hole.to_vec();
    if polygon_area(&h) < 0.0 {
        h.reverse();
    }
    let mut out = Vec::new();
    let mut rest = poly.to_vec();
    for k in 0..h.len() {
        let (a, b) = (h[k], h[(k + 1) % h.len()]);
        let outside = clip_half(&rest, a, b, false);
        if outside.len() >= 3 && polygon_area(&outside).abs() > 1e-10 {
            out.push(outside);
        }
        rest = clip_half(&rest, a, b, true);
        if rest.len() < 3 {
            return if out.is_empty() { vec![poly.to_vec()] } else { out };
        }
    }
    out
}

/// Lochkörper eines Dach-/Deckenfensters (durch alle Schichten, 0,5 m Zugabe beidseits).
pub fn surface_hole_box(o: &Opening, f: &HostFrame) -> [f64; 24] {
    let (w, h) = (o.width, o.height);
    quad_box(&[[0.0, 0.0], [w, 0.0], [w, h], [0.0, h]], -0.5, f.thickness + 0.5, &|u, v, n| f.at(u - w / 2.0, v - h / 2.0, n))
}

/// Lage einer Dach-/Deckenöffnung für Griffe und Objekt-Info ([103], Abfrage `surfaceOpening`):
/// Mittelpunkt, Achsen (Breite waagrecht, Höhe das Gefälle hinauf), Grundriss-Rechteck, UK/OK der
/// Öffnung in der Fläche und der Wirt (Art, Name, Geschoss). `None` ohne Wirt.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SurfaceOpeningInfo {
    pub host_kind: &'static str,
    pub host_id: String,
    pub host_name: String,
    pub floor_id: String,
    pub center: V3,
    pub ew: V3,
    pub eh: V3,
    pub corners: Vec<[f64; 2]>,
    pub z_bottom: f64,
    pub z_top: f64,
    /// Neigung der Fläche in Grad (0 = waagrecht).
    pub slope_deg: f64,
}

pub fn surface_opening_info(p: &Project, id: &str) -> Option<SurfaceOpeningInfo> {
    let o = p.openings.as_deref()?.iter().find(|o| o.id == id)?;
    let f = host_frame(p, o)?;
    let (host_kind, host_id, floor_id) = match f.plane {
        Some(_) => {
            let r = p.roofs.as_deref()?.get(f.host)?;
            ("roof", r.id.clone(), r.floor_id.clone())
        }
        None => {
            let c = p.ceilings.as_deref()?.get(f.host)?;
            ("ceiling", c.id.clone(), c.floor_id.clone())
        }
    };
    let host_name = p.floor(&floor_id).map_or(floor_id.clone(), |l| l.name.clone());
    let rect = host_rect_plan(&f, o.width, o.height);
    let zs = rect.iter().map(|q| q[2]);
    let (z_bottom, z_top) = zs.fold((f64::INFINITY, f64::NEG_INFINITY), |(a, b), z| (a.min(z), b.max(z)));
    Some(SurfaceOpeningInfo {
        host_kind,
        host_id,
        host_name,
        floor_id,
        center: f.c,
        ew: f.ew,
        eh: f.eh,
        corners: rect.iter().map(|q| [q[0], q[1]]).collect(),
        z_bottom,
        z_top,
        slope_deg: f.n[2].clamp(-1.0, 1.0).acos().to_degrees(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn area(p: &[P]) -> f64 {
        (0..p.len()).map(|i| p[i][0] * p[(i + 1) % p.len()][1] - p[(i + 1) % p.len()][0] * p[i][1]).sum::<f64>() / 2.0
    }

    fn quads_area(q: &[[P; 4]]) -> f64 {
        q.iter().map(|q| area(q)).sum()
    }

    #[test]
    fn schnitt_durch_quader_und_loch() {
        let q = [[0.0, 0.0], [2.0, 0.0], [2.0, 1.0], [0.0, 1.0]];
        let b = quad_box(&q, 0.0, 3.0, &|u, v, n| [u, n, v]);
        // Ebene x = 1 (Blick entlang −x, u = +y): Rechteck n 0..3 × v 0..1.
        let sec = box_section(&b, (1.0, -5.0), (0.0, 1.0)).unwrap();
        assert!((polygon_area(&sec) - 3.0).abs() < 1e-12, "{sec:?}");
        assert!(box_section(&b, (5.0, 0.0), (0.0, 1.0)).is_none());
        let band = vec![[0.0, 0.0], [10.0, 0.0], [10.0, 1.0], [0.0, 1.0]];
        let pieces = subtract_convex(&band, &[[4.0, -1.0], [6.0, -1.0], [6.0, 2.0], [4.0, 2.0]]);
        assert_eq!(pieces.len(), 2);
        assert!((pieces.iter().map(|p| polygon_area(p)).sum::<f64>() - 8.0).abs() < 1e-12);
        assert_eq!(subtract_convex(&band, &[[20.0, 0.0], [21.0, 0.0], [21.0, 1.0]]).len(), 1);
    }

    #[test]
    fn rechteck_hat_keinen_umriss() {
        assert!(outline(OpeningShape::Rechteck, None, 1.0, 2.0).is_none());
        assert!(outline(OpeningShape::Rundbogen, None, f64::NAN, 2.0).is_none());
        assert!(outline(OpeningShape::Rundbogen, None, 0.0, 2.0).is_none());
    }

    #[test]
    fn rundbogen_halbkreis_oben() {
        let p = outline(OpeningShape::Rundbogen, None, 1.0, 2.0).unwrap();
        assert!(area(&p) > 0.0, "Gegenuhrzeigersinn");
        // Fläche: Rechteck 1 × 1.5 + Halbkreis r = 0.5.
        let want = 1.5 + std::f64::consts::PI * 0.25 / 2.0;
        assert!((area(&p) - want).abs() < 5e-3, "{} vs {want}", area(&p));
        assert_eq!(v_range(&p, 0.5).map(|r| (r.1 * 1e6).round() / 1e6), Some(2.0));
        let (lo, hi) = v_range(&p, 0.0).unwrap();
        assert!(lo.abs() < 1e-9 && (hi - 1.5).abs() < 1e-9);
        // Füllung + Umriss = Rechteck.
        assert!((quads_area(&fill_quads(&p, 1.0, 2.0)) + area(&p) - 2.0).abs() < 1e-9);
    }

    #[test]
    fn segment_und_spitzbogen() {
        let s = outline(OpeningShape::Segmentbogen, Some(0.2), 1.2, 1.5).unwrap();
        assert!((v_range(&s, 0.6).unwrap().1 - 1.5).abs() < 1e-3);
        assert!((v_range(&s, 0.0).unwrap().1 - 1.3).abs() < 1e-9);
        let g = outline(OpeningShape::Spitzbogen, None, 1.0, 2.0).unwrap();
        assert!((v_range(&g, 0.5).unwrap().1 - 2.0).abs() < 1e-6, "Scheitel oben");
        let spring = 2.0 - 3f64.sqrt() / 2.0;
        assert!((v_range(&g, 0.0).unwrap().1 - spring).abs() < 1e-9);
        assert!((quads_area(&fill_quads(&g, 1.0, 2.0)) + area(&g) - 2.0).abs() < 1e-9);
        // Spitzbogen niedriger als halbe Breite: Rundbogen.
        assert!(outline(OpeningShape::Spitzbogen, Some(0.1), 1.0, 0.3).is_some());
    }

    #[test]
    fn rund_schraeg_giebel() {
        let r = outline(OpeningShape::Rund, None, 0.8, 0.8).unwrap();
        assert!((area(&r) - std::f64::consts::PI * 0.16).abs() < 0.01);
        assert!((quads_area(&fill_quads(&r, 0.8, 0.8)) + area(&r) - 0.64).abs() < 1e-9);
        let s = outline(OpeningShape::Schraeg, Some(0.4), 1.0, 2.0).unwrap();
        assert_eq!(v_range(&s, 0.0).unwrap().1, 1.6);
        assert_eq!(v_range(&s, 1.0).unwrap().1, 2.0);
        let s = outline(OpeningShape::Schraeg, Some(-0.4), 1.0, 2.0).unwrap();
        assert_eq!(v_range(&s, 1.0).unwrap().1, 1.6);
        let g = outline(OpeningShape::Giebel, Some(0.5), 1.0, 2.0).unwrap();
        assert_eq!(v_range(&g, 0.5).unwrap().1, 2.0);
        assert!((quads_area(&fill_quads(&g, 1.0, 2.0)) - 0.25).abs() < 1e-9);
    }

    #[test]
    fn inset_und_ring() {
        let sq = vec![[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]];
        let i = inset(&sq, 0.1);
        assert!((area(&i) - 0.64).abs() < 1e-12);
        assert!((quads_area(&ring_quads(&sq, &i)) - 0.36).abs() < 1e-12);
        assert!((quads_area(&strip_quads(&i)) - 0.64).abs() < 1e-12);
        let r = outline(OpeningShape::Rundbogen, None, 1.0, 2.0).unwrap();
        let ri = inset(&r, 0.06);
        assert!(v_range(&ri, 0.5).unwrap().1 < 1.95 && v_range(&ri, 0.5).unwrap().1 > 1.93);
    }

    #[test]
    fn quader_ecken_wie_achsquader() {
        let q = [[0.0, 0.0], [1.0, 0.0], [1.0, 2.0], [0.0, 2.0]];
        let b = quad_box(&q, -0.1, 0.1, &|u, v, n| [u, n, v]);
        // Ecke 3 = (u1, v1, n0), Ecke 4 = (u0, v0, n1).
        assert_eq!(&b[9..12], &[1.0, -0.1, 2.0]);
        assert_eq!(&b[12..15], &[0.0, 0.1, 0.0]);
    }

    fn roof_project() -> Project {
        let mut p = Project::default();
        let rect = serde_json::json!([{"x":0,"y":0},{"x":10,"y":0},{"x":10,"y":8},{"x":0,"y":8}]);
        p.roofs = Some(vec![serde_json::from_value(serde_json::json!({"id": "R", "type": "roof", "floorId": "F", "categoryCode": "35",
            "outline": rect, "shape": "sattel", "pitchDeg": 45, "overhang": 0, "ridgeAxis": "x", "baseElevation": 3, "thickness": 0.3})).unwrap()]);
        p.ceilings = Some(vec![serde_json::from_value(serde_json::json!({"id": "C", "type": "ceiling", "floorId": "F", "categoryCode": "30",
            "wallTypeId": "", "outline": rect, "thickness": 0.25})).unwrap()]);
        p.openings = Some(vec![Opening {
            id: "D".into(),
            kind: ElementKind::Window,
            width: 0.8,
            height: 1.2,
            host_roof_id: Some("R".into()),
            host_point: Some(Vec2 { x: 5.0, y: 2.0 }),
            ..Default::default()
        }]);
        p
    }

    /// Abfrage `surfaceOpening`: Wirt, Neigung, Grundriss-Rechteck (Höhe projiziert = cos 45°).
    #[test]
    fn lage_fuer_griffe_und_objekt_info() {
        let p = roof_project();
        let i = surface_opening_info(&p, "D").unwrap();
        assert_eq!((i.host_kind, i.host_id.as_str()), ("roof", "R"));
        assert!((i.slope_deg - 45.0).abs() < 1e-6, "{}", i.slope_deg);
        assert!((i.z_top - i.z_bottom - 1.2 * 45f64.to_radians().sin()).abs() < 1e-9);
        let ys: Vec<f64> = i.corners.iter().map(|c| c[1]).collect();
        let span = ys.iter().cloned().fold(f64::NEG_INFINITY, f64::max) - ys.iter().cloned().fold(f64::INFINITY, f64::min);
        assert!((span - 1.2 * 45f64.to_radians().cos()).abs() < 1e-9);
        assert!(surface_opening_info(&p, "x").is_none());
    }

    #[test]
    fn dachfenster_liegt_in_der_dachflaeche() {
        let p = roof_project();
        let o = &p.openings.as_ref().unwrap()[0];
        let f = host_frame(&p, o).expect("Dachfläche gefunden");
        // Südfläche (y < 4) bei 45°: Oberfläche bei y = 2 liegt 2 m über der Traufe (3 m) — plus Überhöhung
        // durch die Dachdicke nicht, die Ebene ist die Oberkante.
        assert!((f.n[2] - std::f64::consts::FRAC_1_SQRT_2).abs() < 1e-9 && f.n[1] < 0.0, "{:?}", f.n);
        assert!(f.ew[2].abs() < 1e-12 && f.eh[2] > 0.0 && f.eh[1] > 0.0, "Höhe das Gefälle hinauf");
        assert!((f.thickness - 0.3).abs() < 1e-9);
        let corners = host_rect_plan(&f, 0.8, 1.2);
        let dz = corners[3][2] - corners[0][2];
        assert!((dz - 1.2 * std::f64::consts::FRAC_1_SQRT_2).abs() < 1e-9);
        assert_eq!(roof_openings(&p, 0).len(), 1);
        assert!(!surface_window_boxes(&p, o, &f).is_empty());
        // Ausserhalb jeder Dachfläche: kein System.
        let mut far = o.clone();
        far.host_point = Some(Vec2 { x: 50.0, y: 2.0 });
        assert!(host_frame(&p, &far).is_none());
    }

    #[test]
    fn deckenoeffnung_wird_aussparung() {
        let mut p = roof_project();
        let c = p.ceilings.as_ref().unwrap()[0].clone();
        assert!(ceiling_hole_rings(&p, &c).is_empty());
        p.openings = Some(vec![Opening {
            id: "O".into(),
            kind: ElementKind::Window,
            width: 1.0,
            height: 2.0,
            host_ceiling_id: Some("C".into()),
            host_point: Some(Vec2 { x: 3.0, y: 3.0 }),
            host_angle: Some(90.0),
            ..Default::default()
        }]);
        let rings = ceiling_hole_rings(&p, &c);
        assert_eq!(rings.len(), 1);
        let xs: Vec<f64> = rings[0].iter().map(|v| (v.x * 1e9).round() / 1e9).collect();
        assert_eq!(xs.iter().cloned().fold(f64::INFINITY, f64::min), 2.0, "um 90° gedreht: Höhe entlang x");
    }
}
