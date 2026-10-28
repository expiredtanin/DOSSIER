// Reine Geometrie der Oberfläche (GPU-frei, per `cargo test` geprüft): Abbildung Modell ↔
// Fensterpixel für den Grundriss (deckungsgleich zu render2d), Treffertest für Bauteile und die
// Hilfen des Werkzeugs „Wand zeichnen".

use render2d::{ViewBox, PX_PER_M};

use crate::bundle::{Bounds2, Element, Shape};

/// Kamera des Grundrisses: ein viewBox im render2d-Bildschirmraum (Modell-Meter × `PX_PER_M`,
/// y nach unten). Die App hält ihn stets im Seitenverhältnis des Ansichtsrechtecks; dann ist die
/// Abbildung auf Fensterpixel eine reine Skalierung (render2d `corrected_view_box` ist dann neutral).
#[derive(Debug, Clone, Copy)]
pub struct PlanCamera {
    pub vb: ViewBox,
}

impl PlanCamera {
    /// Passt die Hülle `b` (Modell-Meter) mit Rand in ein Rechteck der Grösse `size` (Punkte) ein.
    pub fn fit(b: Bounds2, size: [f32; 2]) -> Self {
        let (min, max) = if b.is_valid() { (b.min, b.max) } else { ([-5.0, -5.0], [5.0, 5.0]) };
        let w = ((max[0] - min[0]) * PX_PER_M).max(PX_PER_M);
        let h = ((max[1] - min[1]) * PX_PER_M).max(PX_PER_M);
        let cx = (min[0] + max[0]) * 0.5 * PX_PER_M;
        let cy = -(min[1] + max[1]) * 0.5 * PX_PER_M;
        let mut cam = Self { vb: ViewBox::new(cx - w * 0.5, cy - h * 0.5, w, h) };
        cam.vb = scale_about_center(cam.vb, 1.12);
        cam.match_aspect(size);
        cam
    }

    /// Dehnt den viewBox (zentriert) auf das Seitenverhältnis von `size`.
    pub fn match_aspect(&mut self, size: [f32; 2]) {
        if size[0] <= 0.0 || size[1] <= 0.0 {
            return;
        }
        self.vb = render2d::ortho::corrected_view_box(self.vb, size[0], size[1]);
    }

    /// Punkte je Bildschirmraum-Einheit.
    pub fn scale(&self, size: [f32; 2]) -> f32 {
        render2d::meet_scale(self.vb, size[0], size[1])
    }

    /// Modell-Meter → Punkte relativ zur linken oberen Ecke der Ansicht.
    pub fn to_px(&self, p: [f32; 2], size: [f32; 2]) -> [f32; 2] {
        let s = self.scale(size);
        [(p[0] * PX_PER_M - self.vb.x) * s, (-p[1] * PX_PER_M - self.vb.y) * s]
    }

    /// Punkte (relativ zur Ansicht) → Modell-Meter.
    pub fn to_model(&self, px: [f32; 2], size: [f32; 2]) -> [f32; 2] {
        let s = self.scale(size);
        [(px[0] / s + self.vb.x) / PX_PER_M, -((px[1] / s + self.vb.y) / PX_PER_M)]
    }

    /// Länge in Metern → Punkte.
    pub fn m_to_px(&self, m: f32, size: [f32; 2]) -> f32 {
        m * PX_PER_M * self.scale(size)
    }

    /// Verschiebt um `d` Punkte (Bildinhalt folgt der Maus).
    pub fn pan_px(&mut self, d: [f32; 2], size: [f32; 2]) {
        let s = self.scale(size);
        if s > 0.0 {
            self.vb.x -= d[0] / s;
            self.vb.y -= d[1] / s;
        }
    }

    /// Zoomt um `factor` (> 1 = näher), der Punkt unter `px` bleibt stehen.
    pub fn zoom_at(&mut self, factor: f32, px: [f32; 2], size: [f32; 2]) {
        if !(factor.is_finite() && factor > 0.0) {
            return;
        }
        let anchor = self.to_model(px, size);
        let nw = (self.vb.w / factor).clamp(0.05 * PX_PER_M, 20_000.0 * PX_PER_M);
        let k = nw / self.vb.w;
        self.vb.w = nw;
        self.vb.h *= k;
        // Anker wieder unter den Cursor legen.
        let now = self.to_px(anchor, size);
        self.pan_px([px[0] - now[0], px[1] - now[1]], size);
    }

    /// Angezeigter Massstab 1:N bei `ppp` Pixeln je Punkt und `dpi` (für die Statuszeile).
    pub fn paper_scale(&self, size: [f32; 2], points_per_mm: f32) -> f32 {
        // 1 m Modell = PX_PER_M * s Punkte = (PX_PER_M * s / points_per_mm) mm Bildschirm.
        let mm_per_m = PX_PER_M * self.scale(size) / points_per_mm;
        if mm_per_m > 0.0 {
            1000.0 / mm_per_m
        } else {
            0.0
        }
    }
}

fn scale_about_center(vb: ViewBox, k: f32) -> ViewBox {
    let cx = vb.x + vb.w * 0.5;
    let cy = vb.y + vb.h * 0.5;
    ViewBox::new(cx - vb.w * k * 0.5, cy - vb.h * k * 0.5, vb.w * k, vb.h * k)
}

/// Abstand Punkt–Strecke.
pub fn dist_point_segment(p: [f32; 2], a: [f32; 2], b: [f32; 2]) -> f32 {
    let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
    let l2 = dx * dx + dy * dy;
    let t = if l2 > 0.0 { (((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2).clamp(0.0, 1.0) } else { 0.0 };
    let (qx, qy) = (a[0] + t * dx, a[1] + t * dy);
    ((p[0] - qx).powi(2) + (p[1] - qy).powi(2)).sqrt()
}

/// Gerade/Ungerade-Regel (Ring implizit geschlossen).
pub fn point_in_polygon(p: [f32; 2], pts: &[[f32; 2]]) -> bool {
    let n = pts.len();
    if n < 3 {
        return false;
    }
    let mut inside = false;
    let mut j = n - 1;
    for i in 0..n {
        let (a, b) = (pts[i], pts[j]);
        if (a[1] > p[1]) != (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0] {
            inside = !inside;
        }
        j = i;
    }
    inside
}

pub fn polygon_area(pts: &[[f32; 2]]) -> f32 {
    let n = pts.len();
    if n < 3 {
        return 0.0;
    }
    let mut a = 0.0;
    let mut j = n - 1;
    for i in 0..n {
        a += (pts[j][0] + pts[i][0]) * (pts[j][1] - pts[i][1]);
        j = i;
    }
    (a * 0.5).abs()
}

/// Rechteck eines Bands der Breite `width` um die Achse a→b (CCW).
pub fn band_corners(a: [f32; 2], b: [f32; 2], width: f32) -> [[f32; 2]; 4] {
    let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
    let l = (dx * dx + dy * dy).sqrt().max(1e-9);
    let (nx, ny) = (-dy / l * width * 0.5, dx / l * width * 0.5);
    [[a[0] - nx, a[1] - ny], [b[0] - nx, b[1] - ny], [b[0] + nx, b[1] + ny], [a[0] + nx, a[1] + ny]]
}

/// Treffertest: zuerst „dünne" Bauteile (Band, Kreis) innerhalb der Toleranz `tol` (Meter) —
/// das nächstgelegene gewinnt, Öffnungen vor Wänden; sonst das kleinste Polygon, das `p` enthält.
pub fn pick(elements: &[Element], p: [f32; 2], tol: f32) -> Option<usize> {
    let mut best_thin: Option<(usize, f32)> = None;
    for (i, e) in elements.iter().enumerate() {
        let d = match &e.shape {
            Shape::Segment { a, b, width } => dist_point_segment(p, *a, *b) - width * 0.5,
            Shape::Circle { c, r } => ((p[0] - c[0]).powi(2) + (p[1] - c[1]).powi(2)).sqrt() - r,
            Shape::Polygon { .. } => continue,
        };
        if d > tol {
            continue;
        }
        // Öffnungen liegen in der Wand: bei Überlappung bevorzugen.
        let d = d.max(0.0) - if matches!(e.kind.as_str(), "door" | "window") { tol * 2.0 } else { 0.0 };
        if best_thin.is_none_or(|(_, bd)| d < bd) {
            best_thin = Some((i, d));
        }
    }
    if let Some((i, _)) = best_thin {
        return Some(i);
    }
    elements
        .iter()
        .enumerate()
        .filter_map(|(i, e)| match &e.shape {
            Shape::Polygon { pts } if point_in_polygon(p, pts) => Some((i, polygon_area(pts))),
            _ => None,
        })
        .min_by(|a, b| a.1.total_cmp(&b.1))
        .map(|(i, _)| i)
}

/// Fangen für „Wand zeichnen": Raster `grid` (Meter); mit `ortho` wird relativ zu `from`
/// auf die dominante Achse gezwungen.
pub fn snap_point(p: [f32; 2], from: Option<[f32; 2]>, grid: f32, ortho: bool) -> [f32; 2] {
    let r = |v: f32| if grid > 0.0 { (v / grid).round() * grid } else { v };
    let mut q = [r(p[0]), r(p[1])];
    if let (true, Some(f)) = (ortho, from) {
        if (q[0] - f[0]).abs() >= (q[1] - f[1]).abs() {
            q[1] = f[1];
        } else {
            q[0] = f[0];
        }
    }
    q
}

pub fn seg_len(a: [f32; 2], b: [f32; 2]) -> f32 {
    ((b[0] - a[0]).powi(2) + (b[1] - a[1]).powi(2)).sqrt()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bundle::PropValue;

    fn el(kind: &str, shape: Shape) -> Element {
        Element { id: kind.into(), kind: kind.into(), label: String::new(), shape, props: vec![("x".into(), PropValue::Num(1.0))] }
    }

    #[test]
    fn hin_und_zurueck() {
        let size = [800.0, 500.0];
        let b = Bounds2 { min: [0.0, 0.0], max: [10.0, 6.0] };
        let cam = PlanCamera::fit(b, size);
        // Seitenverhältnis passt zur Ansicht
        assert!((cam.vb.w / cam.vb.h - size[0] / size[1]).abs() < 1e-4);
        for p in [[0.0, 0.0], [10.0, 6.0], [3.3, -1.2]] {
            let q = cam.to_model(cam.to_px(p, size), size);
            assert!((q[0] - p[0]).abs() < 1e-3 && (q[1] - p[1]).abs() < 1e-3);
        }
        // Modell-y nach oben = Bild-y nach unten; Mitte in der Mitte
        let c = cam.to_px([5.0, 3.0], size);
        assert!((c[0] - 400.0).abs() < 0.5 && (c[1] - 250.0).abs() < 0.5);
        assert!(cam.to_px([5.0, 4.0], size)[1] < c[1]);
    }

    #[test]
    fn zoom_haelt_punkt_unter_dem_cursor() {
        let size = [640.0, 480.0];
        let mut cam = PlanCamera::fit(Bounds2 { min: [0.0, 0.0], max: [8.0, 6.0] }, size);
        let px = [100.0, 380.0];
        let before = cam.to_model(px, size);
        let s0 = cam.scale(size);
        cam.zoom_at(2.0, px, size);
        let after = cam.to_model(px, size);
        assert!((before[0] - after[0]).abs() < 1e-3 && (before[1] - after[1]).abs() < 1e-3);
        assert!((cam.scale(size) / s0 - 2.0).abs() < 1e-3);
        // Unsinn ändert nichts
        let keep = cam;
        cam.zoom_at(f32::NAN, px, size);
        cam.zoom_at(0.0, px, size);
        assert_eq!((cam.vb.x, cam.vb.y, cam.vb.w, cam.vb.h), (keep.vb.x, keep.vb.y, keep.vb.w, keep.vb.h));
    }

    #[test]
    fn verschieben_folgt_der_maus() {
        let size = [400.0, 400.0];
        let mut cam = PlanCamera::fit(Bounds2 { min: [0.0, 0.0], max: [4.0, 4.0] }, size);
        let p = [1.0, 1.0];
        let a = cam.to_px(p, size);
        cam.pan_px([30.0, -12.0], size);
        let b = cam.to_px(p, size);
        assert!((b[0] - a[0] - 30.0).abs() < 1e-3 && (b[1] - a[1] + 12.0).abs() < 1e-3);
    }

    #[test]
    fn treffer_bevorzugt_oeffnung_und_kleinsten_raum() {
        let els = vec![
            el("room", Shape::Polygon { pts: vec![[0.0, 0.0], [10.0, 0.0], [10.0, 10.0], [0.0, 10.0]] }),
            el("room", Shape::Polygon { pts: vec![[1.0, 1.0], [3.0, 1.0], [3.0, 3.0], [1.0, 3.0]] }),
            el("wall", Shape::Segment { a: [0.0, 0.0], b: [10.0, 0.0], width: 0.3 }),
            el("window", Shape::Segment { a: [4.0, 0.0], b: [5.0, 0.0], width: 0.34 }),
            el("column", Shape::Circle { c: [6.0, 6.0], r: 0.2 }),
        ];
        assert_eq!(pick(&els, [2.0, 2.0], 0.05), Some(1));
        assert_eq!(pick(&els, [8.0, 8.0], 0.05), Some(0));
        assert_eq!(pick(&els, [8.0, 0.1], 0.05), Some(2));
        assert_eq!(pick(&els, [4.5, 0.05], 0.05), Some(3));
        assert_eq!(pick(&els, [6.1, 6.1], 0.05), Some(4));
        assert_eq!(pick(&els, [20.0, 20.0], 0.05), None);
    }

    #[test]
    fn fangen_raster_und_ortho() {
        let near = |a: [f32; 2], b: [f32; 2]| (a[0] - b[0]).abs() < 1e-5 && (a[1] - b[1]).abs() < 1e-5;
        assert!(near(snap_point([1.03, 2.27], None, 0.05, false), [1.05, 2.25]));
        assert!(near(snap_point([4.02, 0.4], Some([0.0, 0.0]), 0.05, true), [4.0, 0.0]));
        let q = snap_point([0.3, 3.0], Some([0.0, 0.0]), 0.05, true);
        assert!((q[0]).abs() < 1e-6 && (q[1] - 3.0).abs() < 1e-6);
    }

    #[test]
    fn band_und_flaeche() {
        let c = band_corners([0.0, 0.0], [4.0, 0.0], 0.2);
        assert!((polygon_area(&c) - 0.8).abs() < 1e-5);
        assert!(point_in_polygon([2.0, 0.05], &c));
        assert!(!point_in_polygon([2.0, 0.2], &c));
        assert!((dist_point_segment([2.0, 1.0], [0.0, 0.0], [4.0, 0.0]) - 1.0).abs() < 1e-6);
        assert!((dist_point_segment([-3.0, 4.0], [0.0, 0.0], [4.0, 0.0]) - 5.0).abs() < 1e-6);
    }
}
