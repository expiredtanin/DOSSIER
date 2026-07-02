// Tessellierung: wandelt Szenen-Primitive in GPU-fertige Vertex-/Index-Puffer.
//  - Polygone -> echtes Ear-Clipping (konkav-faehig), Bildschirm-Raum-Dreiecke
//  - Linien   -> Quad mit Normale + Seiten-Flag (Breite spaeter im Shader)
//
// 1:1-Port von `src/plan/glPlan/glPlanCompile.ts`. Koordinaten: alles wird in
// BILDSCHIRM-Raum abgelegt (wie `to_screen`):
//   sx = mx * PX_PER_M,  sy = -my * PX_PER_M.
// Damit ist die Projektion eine reine viewBox-Orthografie (siehe `ortho`).
//
// WARUM Ear-Clipping selbst portiert (statt earcutr/lyon):
//  - Die Plan-Polygone haben wenige Ecken; O(n^2)-Ear-Clipping ist reichlich
//    schnell und exakt der bereits verifizierte Web-Algorithmus (gleiche Tests).
//  - Keine externe Abhaengigkeit -> die Tessellierungs-Bibliothek bleibt
//    serde-only und headless testbar (entscheidend fuer die saubere Trennung
//    vom GPU-Teil). earcutr/lyon zoegen zusaetzliche Crates in genau die
//    Schicht, die ohne Display gruen bleiben muss.
//  - Ergebnis ist byte-fuer-byte-vergleichbar mit dem WebGL-Referenzpfad.

use crate::types::{Arc, FillPolygon, Line, Point, Rgba, Scene};

/// viewBox-Einheiten je Meter (identisch zu PlanView/toScreen im Web-Pfad).
pub const PX_PER_M: f32 = 90.0;

/// Modell-Meter -> Bildschirm-Raum (identisch zu `toScreen`).
#[inline]
pub fn to_screen(p: Point) -> Point {
    [p[0] * PX_PER_M, -p[1] * PX_PER_M]
}

/// Mindest-Sehnenabweichung (Sagitta) in Geraete-px, unter der ein Kreisbogen als
/// glatt gilt. Kleiner -> mehr Segmente bei gleichem Radius/Zoom.
const ARC_SAGITTA_TOL_PX: f32 = 0.3;

/// Kreisbogen (kuerzerer Sweep von `from` nach `to` um `center`, wie die alte
/// JS-`tessellateArc`) zoomabhaengig in eine offene Punktfolge (Modell-Meter)
/// zerlegen. Winkelschritt so klein, dass die Sehnen-Abweichung (Sagitta) bei der
/// aktuellen Bildschirm-Skala `px_per_m` (Geraete-px je Modell-Meter) unter
/// `ARC_SAGITTA_TOL_PX` bleibt: sagitta = r*(1-cos(dtheta/2)) <= tol
/// => dtheta <= 2*acos(1 - tol/r_px), r_px = r*px_per_m. Segmentzahl auf 8..512
/// geklemmt (nie zu grob, nie unnoetig fein). Erster/letzter Punkt werden EXAKT
/// auf `from`/`to` gesetzt (kein Trig-Rundungsfehler an den Enden).
pub(crate) fn tessellate_arc(center: Point, from: Point, to: Point, r: f32, px_per_m: f32) -> Vec<Point> {
    let a0 = (from[1] - center[1]).atan2(from[0] - center[0]);
    let a1_raw = (to[1] - center[1]).atan2(to[0] - center[0]);
    // Kuerzeren Bogen waehlen (die Szene liefert keine largeArc-Info mit) — 1:1
    // die Winkel-Normalisierung der alten JS-`tessellateArc`.
    let mut delta = a1_raw - a0;
    while delta > std::f32::consts::PI {
        delta -= 2.0 * std::f32::consts::PI;
    }
    while delta < -std::f32::consts::PI {
        delta += 2.0 * std::f32::consts::PI;
    }

    let r_px = (r * px_per_m).max(1e-6);
    let ratio = (1.0 - (ARC_SAGITTA_TOL_PX / r_px)).clamp(-1.0, 1.0);
    let max_dtheta = (2.0 * ratio.acos()).max(1e-4);
    let segs = ((delta.abs() / max_dtheta).ceil() as u32).clamp(8, 512);

    let mut pts = Vec::with_capacity(segs as usize + 1);
    pts.push(from);
    for i in 1..segs {
        let t = a0 + delta * (i as f32) / (segs as f32);
        pts.push([center[0] + t.cos() * r, center[1] + t.sin() * r]);
    }
    pts.push(to);
    pts
}

/// Signierte Flaeche (Shoelace); >0 = CCW (Modell-Y nach oben).
fn signed_area(pts: &[Point]) -> f32 {
    let mut a = 0.0f32;
    let n = pts.len();
    let mut j = n - 1;
    for i in 0..n {
        a += pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
        j = i;
    }
    a / 2.0
}

/// Kreuzprodukt (b-a) x (c-a).
#[inline]
fn cross(a: Point, b: Point, c: Point) -> f32 {
    (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
}

/// Maximaler Miter-Laengenfaktor; darueber wird geklemmt (kein Spike an spitzen Ecken).
const MITER_LIMIT: f32 = 8.0;

/// Einheits-Links-Normale von `from` nach `to` (Bildschirm-Raum); None bei Nulllaenge.
#[inline]
fn left_normal(from: Point, to: Point) -> Option<Point> {
    let dx = to[0] - from[0];
    let dy = to[1] - from[1];
    let len = (dx * dx + dy * dy).sqrt();
    if len < 1e-6 {
        None
    } else {
        Some([-dy / len, dx / len])
    }
}

/// Liegt p im (a,b,c)-Dreieck? (CCW-orientiert).
fn point_in_tri(a: Point, b: Point, c: Point, p: Point) -> bool {
    let d1 = cross(a, b, p);
    let d2 = cross(b, c, p);
    let d3 = cross(c, a, p);
    let has_neg = d1 < 0.0 || d2 < 0.0 || d3 < 0.0;
    let has_pos = d1 > 0.0 || d2 > 0.0 || d3 > 0.0;
    !(has_neg && has_pos)
}

/// Ear-Clipping-Triangulierung eines einfachen (lochfreien) Polygons. Robust fuer
/// konvexe UND konkave Ringe. O(n^2) — fuer Plan-Polygone (wenige Ecken) voellig
/// ausreichend. Gibt Dreiecks-Indizes (0-basiert auf `pts`) zurueck; leer bei <3
/// Ecken oder Degeneration.
pub fn triangulate(pts: &[Point]) -> Vec<u32> {
    let n = pts.len();
    if n < 3 {
        return Vec::new();
    }

    // Ohr-Test unten nutzt cross>0 = konvex, was CCW voraussetzt. Bei CW-Polygonen
    // die Index-Reihenfolge umdrehen (Triangulierung ist raum-affin-invariant, die
    // Indizes gelten danach auch fuer die Bildschirm-Raum-Vertices).
    let mut idx: Vec<usize> = (0..n).collect();
    if signed_area(pts) < 0.0 {
        idx.reverse(); // <0 = CW -> auf CCW drehen
    }

    let mut tris: Vec<u32> = Vec::new();
    let mut guard = 0usize;
    let max_guard = n * n + 16;

    while idx.len() > 3 && guard < max_guard {
        guard += 1;
        let mut clipped = false;
        let m = idx.len();
        for i in 0..m {
            let i_prev = idx[(i + m - 1) % m];
            let i_cur = idx[i];
            let i_next = idx[(i + 1) % m];
            let a = pts[i_prev];
            let b = pts[i_cur];
            let c = pts[i_next];

            // Konvexe Ecke? (bei CCW: cross > 0)
            if cross(a, b, c) <= 0.0 {
                continue;
            }

            // Kein anderer Vertex im Ohr?
            let mut contains = false;
            for &vi in &idx {
                if vi == i_prev || vi == i_cur || vi == i_next {
                    continue;
                }
                if point_in_tri(a, b, c, pts[vi]) {
                    contains = true;
                    break;
                }
            }
            if contains {
                continue;
            }

            // Ohr abschneiden.
            tris.push(i_prev as u32);
            tris.push(i_cur as u32);
            tris.push(i_next as u32);
            idx.remove(i);
            clipped = true;
            break;
        }
        if !clipped {
            break; // Degeneriert -> abbrechen (kein Absturz).
        }
    }
    if idx.len() == 3 {
        tris.push(idx[0] as u32);
        tris.push(idx[1] as u32);
        tris.push(idx[2] as u32);
    }
    tris
}

/// Ein zusammenhaengender Zeichen-Batch (Index-Bereich) mit einer Farbe.
#[derive(Debug, Clone)]
pub struct FillBatch {
    pub start_index: u32,
    pub index_count: u32,
    pub color: Rgba,
}

/// Ein Linien-Batch: Index-Bereich mit Farbe + echter Papier-Strichbreite.
#[derive(Debug, Clone)]
pub struct LineBatch {
    pub start_index: u32,
    pub index_count: u32,
    pub color: Rgba,
    /// ECHTE Strichbreite in Papier-Millimeter.
    pub stroke_mm: f32,
}

/// GPU-fertige Geometrie: getrennte Puffer fuer Flaechen (Poche) und Striche.
/// Einmal je Szene tessellieren; danach treibt nur die Projektionsmatrix Pan/Zoom.
#[derive(Debug, Clone, Default)]
pub struct GpuGeometry {
    /// Fuell-Positionen, interleaved [x,y, x,y, ...] in Bildschirm-Raum.
    pub fill_pos: Vec<f32>,
    pub fill_idx: Vec<u32>,
    pub fill_batches: Vec<FillBatch>,
    /// Linien-Vertices, interleaved [x,y, bx,by, side, miter] in Bildschirm-Raum
    /// (bx,by = Miter-Bisektor, miter = 1/cos(theta/2)-Laengenfaktor).
    pub line_verts: Vec<f32>,
    pub line_idx: Vec<u32>,
    pub line_batches: Vec<LineBatch>,
    /// Modell-Bounds (Meter) fuer Debug/Einpassen; nicht render-kritisch.
    pub bounds: [f32; 4], // [min_x, min_y, max_x, max_y]
}

#[inline]
fn same_rgba(a: Rgba, b: Rgba) -> bool {
    a[0] == b[0] && a[1] == b[1] && a[2] == b[2] && a[3] == b[3]
}

impl GpuGeometry {
    /// Ordnungserhaltendes Batch-Merging fuer Fuellungen: aufeinanderfolgende
    /// Indizes gleicher Farbe werden zu EINEM Draw-Call zusammengefasst.
    fn add_fill_batch(&mut self, count: u32, color: Rgba) {
        if let Some(last) = self.fill_batches.last_mut() {
            if same_rgba(last.color, color) {
                last.index_count += count;
                return;
            }
        }
        self.fill_batches.push(FillBatch {
            start_index: self.fill_idx.len() as u32 - count,
            index_count: count,
            color,
        });
    }

    fn add_line_batch(&mut self, count: u32, color: Rgba, stroke_mm: f32) {
        if let Some(last) = self.line_batches.last_mut() {
            if last.stroke_mm == stroke_mm && same_rgba(last.color, color) {
                last.index_count += count;
                return;
            }
        }
        self.line_batches.push(LineBatch {
            start_index: self.line_idx.len() as u32 - count,
            index_count: count,
            color,
            stroke_mm,
        });
    }

    /// Zeichnet einen zusammenhaengenden Linienzug (Modell-Meter) als EINEN
    /// gehrten Streifen: an jedem Stuetzpunkt wird der Versatz entlang des Miter-
    /// Bisektors verlaengert (1/cos(theta/2)), sodass benachbarte Segmente buendig
    /// verschmelzen -> gehrte Ecke statt Butt-Cap-Stufe. `closed` schliesst den Ring
    /// (letzter<->erster Punkt). Vertex-Layout: [x,y, bx,by, side, miter] (6 floats).
    ///
    /// 1:1-Port von `strokePolyline` in `src/plan/glPlan/glPlanCompile.ts`.
    fn stroke_polyline(
        &mut self,
        pts_m: &[Point],
        closed: bool,
        color: Rgba,
        stroke_mm: f32,
        bounds: &mut Bounds,
    ) {
        // Auf Bildschirm-Raum abbilden + aufeinanderfolgende Duplikate entfernen.
        let mut s: Vec<Point> = Vec::with_capacity(pts_m.len());
        for &p in pts_m {
            let sp = to_screen(p);
            if let Some(last) = s.last() {
                if (last[0] - sp[0]).abs() < 1e-6 && (last[1] - sp[1]).abs() < 1e-6 {
                    continue;
                }
            }
            s.push(sp);
            bounds.track(p);
        }
        if closed && s.len() > 1 {
            let f = s[0];
            let l = s[s.len() - 1];
            if (f[0] - l[0]).abs() < 1e-6 && (f[1] - l[1]).abs() < 1e-6 {
                s.pop();
            }
        }
        let k = s.len();
        if k < 2 {
            return;
        }

        let base = (self.line_verts.len() / 6) as u32;
        for i in 0..k {
            let has_in = closed || i > 0;
            let has_out = closed || i < k - 1;
            let n_in = if has_in {
                left_normal(s[(i + k - 1) % k], s[i])
            } else {
                None
            };
            let n_out = if has_out {
                left_normal(s[i], s[(i + 1) % k])
            } else {
                None
            };

            let (bx, by, miter): (f32, f32, f32);
            match (n_in, n_out) {
                (Some(a), Some(b)) => {
                    let sx = a[0] + b[0];
                    let sy = a[1] + b[1];
                    let slen = (sx * sx + sy * sy).sqrt();
                    if slen < 1e-3 {
                        // ~180-Grad-Umkehr -> kein sinnvoller Bisektor, gerade weiter.
                        bx = b[0];
                        by = b[1];
                        miter = 1.0;
                    } else {
                        bx = sx / slen;
                        by = sy / slen;
                        let denom = bx * b[0] + by * b[1]; // cos(theta/2)
                        miter = if denom > 1e-3 {
                            (1.0 / denom).min(MITER_LIMIT)
                        } else {
                            1.0
                        };
                    }
                }
                (Some(n), None) | (None, Some(n)) => {
                    bx = n[0];
                    by = n[1];
                    miter = 1.0;
                }
                (None, None) => {
                    // Bei k>=2 unerreichbar; sicherheitshalber gerade lassen.
                    bx = 0.0;
                    by = 0.0;
                    miter = 1.0;
                }
            }
            self.line_verts
                .extend_from_slice(&[s[i][0], s[i][1], bx, by, 1.0, miter]);
            self.line_verts
                .extend_from_slice(&[s[i][0], s[i][1], bx, by, -1.0, miter]);
        }

        let segs = if closed { k } else { k - 1 };
        for i in 0..segs {
            let a = base + 2 * i as u32;
            let b = base + 2 * (((i + 1) % k) as u32);
            self.line_idx
                .extend_from_slice(&[a, a + 1, b, a + 1, b + 1, b]);
        }
        self.add_line_batch((segs * 6) as u32, color, stroke_mm);
    }
}

/// Hilfsstruct zum Verfolgen der Modell-Bounds.
struct Bounds {
    min_x: f32,
    min_y: f32,
    max_x: f32,
    max_y: f32,
}

impl Bounds {
    fn new() -> Self {
        Self {
            min_x: f32::INFINITY,
            min_y: f32::INFINITY,
            max_x: f32::NEG_INFINITY,
            max_y: f32::NEG_INFINITY,
        }
    }
    #[inline]
    fn track(&mut self, p: Point) {
        if p[0] < self.min_x {
            self.min_x = p[0];
        }
        if p[1] < self.min_y {
            self.min_y = p[1];
        }
        if p[0] > self.max_x {
            self.max_x = p[0];
        }
        if p[1] > self.max_y {
            self.max_y = p[1];
        }
    }
    fn finish(self) -> [f32; 4] {
        [
            if self.min_x.is_finite() { self.min_x } else { 0.0 },
            if self.min_y.is_finite() { self.min_y } else { 0.0 },
            if self.max_x.is_finite() { self.max_x } else { 1.0 },
            if self.max_y.is_finite() { self.max_y } else { 1.0 },
        ]
    }
}

/// Tessellliert eine ganze Szene zu GPU-Geometrie beim Standard-Massstab
/// (`PX_PER_M`, kein Zoom beruecksichtigt) — Kompatibilitaets-Wrapper fuer
/// bestehende Aufrufer (Tests, Demo, Fenster-Spike), die keinen aktuellen
/// Geraete-px-je-Meter-Wert kennen. Der eigentliche (zoomabhaengige) Renderpfad
/// nutzt `compile_scene_scaled` direkt (siehe `gpu::Renderer::upload_scene`).
pub fn compile_scene(scene: &Scene) -> GpuGeometry {
    compile_scene_scaled(scene, PX_PER_M)
}

/// Tessellliert eine ganze Szene zu GPU-Geometrie (gefuellte Polygone +
/// Papier-mm-Striche). Reihenfolge: Fuellungen -> Umrisse -> offene Polylinien
/// -> Boegen -> freie Linien (siehe `Scene`-Doc-Kommentar). `px_per_m` sind die
/// aktuellen Geraete-px je Modell-Meter (aus der laufenden Zoom-Stufe) — treibt
/// NUR die Bogen-Adaptivitaet (`tessellate_arc`); alles andere ist Zoom-invariant
/// (Papier-mm-Striche werden erst im Shader auf Geraete-px abgebildet).
pub fn compile_scene_scaled(scene: &Scene, px_per_m: f32) -> GpuGeometry {
    let mut geo = GpuGeometry::default();
    let mut bounds = Bounds::new();

    // 1) Gefuellte Polygone.
    for poly in &scene.fills {
        compile_fill(&mut geo, poly, &mut bounds);
    }
    // 2) Umrisse (geschlossene Ringe als EIN gehrter Streifen, inkl. Schluss-Kante).
    //    `dash` existiert bereits im Typ (siehe `types::Outline`), wird aber erst
    //    mit der Dash-Zerlegung (Welle 2) beruecksichtigt.
    for o in &scene.outlines {
        if o.width_mm > 0.0 && o.pts.len() >= 2 {
            geo.stroke_polyline(&o.pts, true, o.color, o.width_mm, &mut bounds);
        }
    }
    // 3) Offene Polylinien (verbundene Umrisskanten / 2D-Zeichnungszuege) als EIN
    //    gehrter Streifen — die inneren Ecken bekommen so eine Gehrung statt
    //    Stumpfkappen (closed=false).
    for pl in &scene.polylines {
        if pl.width_mm > 0.0 && pl.pts.len() >= 2 {
            geo.stroke_polyline(&pl.pts, false, pl.color, pl.width_mm, &mut bounds);
        }
    }
    // 4) Kreisboegen: zoomabhaengig in eine Punktfolge zerlegt (`tessellate_arc`),
    //    dann wie eine offene Polylinie gestrichen. `dash` wird (noch) ignoriert
    //    (durchgezogen gezeichnet) — die Zerlegung in Teilstriche folgt in Welle 2.
    for a in &scene.arcs {
        compile_arc(&mut geo, a, px_per_m, &mut bounds);
    }
    // 5) Freie Einzel-Linien (Tuerblaetter, Referenzlinien).
    for l in &scene.lines {
        compile_line(&mut geo, l, &mut bounds);
    }

    geo.bounds = bounds.finish();
    geo
}

fn compile_fill(geo: &mut GpuGeometry, poly: &FillPolygon, bounds: &mut Bounds) {
    let tris = triangulate(&poly.pts);
    if tris.is_empty() {
        return;
    }
    let base = (geo.fill_pos.len() / 2) as u32;
    for &pt in &poly.pts {
        let s = to_screen(pt);
        geo.fill_pos.push(s[0]);
        geo.fill_pos.push(s[1]);
        bounds.track(pt);
    }
    let count = tris.len() as u32;
    for t in tris {
        geo.fill_idx.push(base + t);
    }
    geo.add_fill_batch(count, poly.color);
}

fn compile_arc(geo: &mut GpuGeometry, a: &Arc, px_per_m: f32, bounds: &mut Bounds) {
    if a.width_mm <= 0.0 {
        return;
    }
    let pts = tessellate_arc(a.center, a.from, a.to, a.r, px_per_m);
    geo.stroke_polyline(&pts, false, a.color, a.width_mm, bounds);
}

fn compile_line(geo: &mut GpuGeometry, l: &Line, bounds: &mut Bounds) {
    let w = if l.width_mm > 0.0 { l.width_mm } else { 0.18 };
    geo.stroke_polyline(&[l.a, l.b], false, l.color, w, bounds);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::Arc;

    // --- tessellate_arc: adaptive Bogen-Zerlegung ----------------------------

    #[test]
    fn arc_endpunkte_exakt() {
        let center = [1.0, 1.0];
        let from = [2.0, 1.0]; // r=1, Winkel 0
        let to = [1.0, 2.0]; // Winkel 90 Grad
        let pts = tessellate_arc(center, from, to, 1.0, 100.0);
        assert_eq!(*pts.first().unwrap(), from, "erster Punkt exakt = from");
        assert_eq!(*pts.last().unwrap(), to, "letzter Punkt exakt = to");
    }

    #[test]
    fn arc_segmentzahl_waechst_mit_px_per_m() {
        let center = [0.0, 0.0];
        let from = [1.0, 0.0];
        let to = [0.0, 1.0]; // Viertelkreis, r=1
        let low = tessellate_arc(center, from, to, 1.0, 10.0);
        let high = tessellate_arc(center, from, to, 1.0, 1000.0);
        let segs_low = low.len() - 1;
        let segs_high = high.len() - 1;
        assert!(
            segs_high > segs_low,
            "mehr Segmente bei hoeherem Zoom erwartet: {segs_low} vs {segs_high}"
        );
    }

    #[test]
    fn arc_segmentzahl_geklemmt_min_max() {
        let center = [0.0, 0.0];
        let from = [1.0, 0.0];
        let to = [0.0, 1.0];
        // Sehr grober Fall (winziger Radius/Zoom) -> trotzdem mindestens 8 Segmente.
        let coarse = tessellate_arc(center, from, to, 0.001, 1.0);
        assert!(coarse.len() - 1 >= 8, "min. 8 Segmente erwartet");
        // Extremer Zoom -> nie mehr als 512 Segmente.
        let fine = tessellate_arc(center, from, to, 1.0, 1.0e9);
        assert!(fine.len() - 1 <= 512, "max. 512 Segmente erwartet");
    }

    // --- compile_scene_scaled: End-zu-End-Verdrahtung -------------------------

    #[test]
    fn compile_scene_mit_bogen_erzeugt_liniengeometrie() {
        let scene = Scene {
            arcs: vec![Arc {
                center: [0.0, 0.0],
                from: [1.0, 0.0],
                to: [0.0, 1.0],
                r: 1.0,
                color: [0.1, 0.1, 0.1, 1.0],
                width_mm: 0.25,
                dash: None,
            }],
            ..Default::default()
        };
        let geo = compile_scene_scaled(&scene, PX_PER_M);
        assert!(!geo.line_verts.is_empty(), "Bogen sollte Linien-Vertices erzeugen");
        assert!(!geo.line_idx.is_empty(), "Bogen sollte Linien-Indizes erzeugen");
    }
}
