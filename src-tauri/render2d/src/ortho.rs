// Aspekt-korrekte Orthografie + Papier-mm-Strichbreiten-Formel.
// 1:1-Port von `computeOrthoMatrix` / dem strokeScale-Pfad aus
// `src/plan/glPlan/glPlanRender.ts`.
//
// WICHTIG (Konventionsunterschied WebGL vs. wgpu):
//  - WebGL-Clip-Z liegt in [-1, 1].
//  - wgpu/WebGPU-Clip-Z liegt in [0, 1].
// Fuer den reinen 2D-Fall (z=0) spielt das keine Rolle: wir setzen z konstant auf
// 0.0 im Shader; die XY-Abbildung ist identisch. Die Matrix hier ist daher exakt
// die WebGL-Ortho (Spalten-Major), unveraendert uebernehmbar.

use crate::tessellate::PX_PER_M;
use crate::types::ViewBox;

/// 4x4-Matrix, Spalten-Major (WebGL/wgpu-Konvention: `m[col*4 + row]`).
pub type Mat4 = [f32; 16];

/// Einheitsmatrix.
pub fn identity() -> Mat4 {
    let mut m = [0.0f32; 16];
    m[0] = 1.0;
    m[5] = 1.0;
    m[10] = 1.0;
    m[15] = 1.0;
    m
}

/// Orthografische Projektion [left,right] x [bottom,top] -> Clip. Spalten-Major.
/// Die Z-Zeile bildet z=0 auf 0 ab (fuer wgpu unschaedlich, siehe Modul-Kopf).
fn ortho(left: f32, right: f32, bottom: f32, top: f32) -> Mat4 {
    let mut m = identity();
    let w = right - left;
    let h = top - bottom;
    m[0] = 2.0 / w;
    m[5] = 2.0 / h;
    m[10] = -1.0;
    m[12] = -(right + left) / w;
    m[13] = -(top + bottom) / h;
    m
}

/// Projektionsmatrix fuer einen viewBox, aspekt-korrigiert wie SVG
/// `preserveAspectRatio="xMidYMid meet"`: der viewBox wird auf das
/// Canvas-Seitenverhaeltnis gedehnt (zentriert), damit die Skalierung in X und Y
/// gleich ist (keine Verzerrung, Perpendikel bleiben senkrecht).
///
/// Eingabe-Positionen sind bereits im BILDSCHIRM-Raum (`to_screen`), daher keine
/// zusaetzliche Meter-Skalierung. Bildschirm-Y zeigt nach unten -> top = vb.y,
/// bottom = vb.y + vb.h (kleineres Y oben -> Clip +1).
pub fn compute_ortho_matrix(view_box: ViewBox, canvas_w: f32, canvas_h: f32) -> Mat4 {
    let ViewBox { x, y, w, h } = corrected_view_box(view_box, canvas_w, canvas_h);
    // top = y (Bildschirm-Y oben, kleiner), bottom = y + h.
    ortho(x, x + w, y + h, y)
}

/// Der aufs Canvas-Seitenverhaeltnis gedehnte (zentrierte) viewBox — exakt die
/// Korrektur, die auch in der Ortho-Matrix steckt. Mit ihm laesst sich ein
/// Bildschirm-Raum-Punkt direkt in Fenster-Pixel projizieren:
/// `px = (s - corrected.xy) * meet_scale(corrected, ...)` (der Textpass braucht
/// genau das fuer die Glyphen-Anker).
pub fn corrected_view_box(view_box: ViewBox, canvas_w: f32, canvas_h: f32) -> ViewBox {
    let ViewBox {
        mut x,
        mut y,
        mut w,
        mut h,
    } = view_box;
    if canvas_w > 0.0 && canvas_h > 0.0 && w > 0.0 && h > 0.0 {
        let c_aspect = canvas_w / canvas_h;
        let v_aspect = w / h;
        if c_aspect > v_aspect {
            // Canvas breiter -> viewBox in der Breite dehnen, X zentrieren.
            let nw = h * c_aspect;
            x -= (nw - w) / 2.0;
            w = nw;
        } else {
            // Canvas hoeher -> viewBox in der Hoehe dehnen, Y zentrieren.
            let nh = w / c_aspect;
            y -= (nh - h) / 2.0;
            h = nh;
        }
    }
    ViewBox::new(x, y, w, h)
}

/// meet-Skala: Geraete-px je viewBox-Einheit (SVG `xMidYMid meet`).
pub fn meet_scale(view_box: ViewBox, viewport_w: f32, viewport_h: f32) -> f32 {
    (viewport_w / view_box.w).min(viewport_h / view_box.h)
}

/// Umrechnung Papier-mm -> Geraete-px, EXAKT wie der SVG-`printStrokeVb`-Pfad:
///   Breite_vb = mm * N/1000 * PX_PER_M   (viewBox-Einheiten, skaliert mit Zoom)
///   Breite_px = Breite_vb * meetSkala    (Geraete-px je viewBox-Einheit)
/// -> mm * (N/1000 * PX_PER_M * meet). So gilt: 0.35 mm bei 1:100 = echte 0.35 mm
/// Papier (deckungsgleich zum SVG-Renderer).
pub fn mm_to_device_px(view_box: ViewBox, viewport_w: f32, viewport_h: f32, paper_scale_n: f32) -> f32 {
    let meet = meet_scale(view_box, viewport_w, viewport_h);
    (paper_scale_n / 1000.0) * PX_PER_M * meet
}

/// Faktor auf die bei 1:100 kompilierten Strichmuster (Papier-mm × 0.1 m): Muster gelten in Papier-mm
/// im PLOT-Massstab `dash_scale_n` und liegen damit fest im Modell-Raum — Zoomen ändert den Rhythmus
/// nicht, Bildschirm = Druckansicht. Ohne Plot-Massstab (≤ 0) der Strich-Massstab `paper_scale_n`
/// (Altverhalten, z. B. native Fläche ohne Angabe).
pub fn dash_scale(paper_scale_n: f32, dash_scale_n: f32) -> f32 {
    let n = if dash_scale_n > 0.0 && dash_scale_n.is_finite() { dash_scale_n } else { paper_scale_n };
    if n > 0.0 && n.is_finite() {
        n / 100.0
    } else {
        1.0
    }
}

/// Modell-Länge (m) eines Strichmuster-Eintrags `mm` (Papier-mm) auf dem Bildschirm.
pub fn dash_model_len(mm: f32, paper_scale_n: f32, dash_scale_n: f32) -> f32 {
    mm * (100.0 / 1000.0) * dash_scale(paper_scale_n, dash_scale_n)
}

#[cfg(test)]
mod dash_tests {
    use super::*;

    #[test]
    fn dash_rhythm_fixed_in_model_space_across_zoom() {
        // Anzeige-Modus: der Strich-Massstab folgt dem Zoom (live N 32 bzw. 400), der Plot-Massstab bleibt 1:50.
        let near = dash_model_len(6.0, 32.0, 50.0);
        let far = dash_model_len(6.0, 400.0, 50.0);
        assert!((near - far).abs() < 1e-7);
        // Druck-SVG: 6 mm Papier bei 1:50 = 0.3 m Modell.
        assert!((near - 6.0 * 50.0 / 1000.0).abs() < 1e-6);
        // Ohne Plot-Massstab: Altverhalten (Strich-Massstab).
        assert!((dash_model_len(6.0, 200.0, 0.0) - 1.2).abs() < 1e-6);
        assert_eq!(dash_scale(f32::NAN, f32::NAN), 1.0);
    }
}
