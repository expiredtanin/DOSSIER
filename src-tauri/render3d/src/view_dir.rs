//! [270] Blickrichtungen: EINE Tabelle für alle Wege, das Modell aus einer Richtung zu zeigen — 3D-Fenster
//! (`math::preset_camera`), Vektor-Axonometrie / 3D-Dokument (Kern `plan/axo.rs`), Cycles-Szene (Kern
//! `cycles_scene.rs`, CLI `render --view`) und Blender-Skript (`scripts/blender/render_dossier.py`, Kopie per Test
//! `src/viewport/viewDirections.test.ts` geprüft).
//!
//! **Achsen.** Modell (Plan): x = Ost, y = Nord, z = Höhe, Meter, rechtshändig; im Grundriss ist Norden oben
//! (Nordpfeil = Plan oben). render3d rechnet in der Welt `(x, Höhe, y)` (Bauteile, Gelände, Punktwolken, Sonne
//! `shadow::sun_dir_world`) — ein Tausch zweier Achsen, also eine Spiegelung (Determinante −1). Die Kamera gleicht sie
//! aus: `math::view_matrix` nimmt „rechts im Bild“ = oben × Blick (statt Blick × oben wie `look_at`), damit erscheint
//! das Modell im 3D-Fenster seitenrichtig (wer von Süden blickt, hat Osten rechts). Weil das Bild gegenüber `look_at`
//! gespiegelt ist, zählen aussen zeigende (in der Welt gegen den Uhrzeigersinn gewickelte) Dreiecke im Bild als im
//! Uhrzeigersinn (`FRONT_FACE_CW`).
//!
//! **Namen.** „Südost“ = Betrachter im Südosten, Blick nach Nordwesten. Die Blickwinkel der 3D-Ansicht (`View3d`)
//! sind dieselben Richtungen mit „vorne“ = Süden (Plan unten) und „rechts“ = Osten (Plan rechts):
//! `front` = Süd, `back` = Nord, `side`/`right` = Ost, `left` = West, `iso` = Südost (vorne-rechts),
//! `isoFrontLeft` = Südwest, `isoBackRight` = Nordost, `isoBackLeft` = Nordwest, `perspective` = Südost (perspektivisch,
//! 0.5 rad erhöht), `top` = Draufsicht mit Norden oben.

/// Bild „rechts“ = oben × Blick: Dreiecke, die in der Welt gegen den Uhrzeigersinn gewickelt sind, erscheinen im
/// Bild im Uhrzeigersinn (s. Modulkopf). Die Pipelines mit Rückseiten-Culling setzen deshalb `FrontFace::Cw`.
pub const FRONT_FACE_CW: bool = true;

/// Höhenwinkel der Isometrie asin(1/√3) ≈ 35.26° als (cos, sin) — ohne Winkelfunktionen, plattformgleich.
const ISO_CS: (f64, f64) = (0.816_496_580_927_726, 0.577_350_269_189_625_8);

/// Höhenwinkel der freien Perspektive (rad), wie die Orbit-Startlage der 3D-Ansicht (`VIEW3D_ORBIT`).
pub const PERSPECTIVE_PITCH: f64 = 0.5;
/// (cos, sin) von [`PERSPECTIVE_PITCH`].
const PERSPECTIVE_CS: (f64, f64) = (0.877_582_561_890_372_8, 0.479_425_538_604_203);

/// Aufgelöste Blickrichtung.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ViewDir {
    /// Einheitsvektor vom Modell ZUM Betrachter in Modell-Koordinaten (x Ost, y Nord, z oben).
    pub to_viewer: [f64; 3],
    /// Parallelprojektion (alle ausser `perspective`).
    pub ortho: bool,
    /// Senkrecht von oben (Bild-oben = Norden).
    pub top: bool,
}

/// Horizontale Richtung zum Betrachter (Ost, Nord), Höhenwinkel als (cos, sin) und Parallelprojektion nach Name;
/// `None` für unbekannte Namen.
fn table(name: &str) -> Option<([f64; 2], (f64, f64), bool)> {
    let s = std::f64::consts::FRAC_1_SQRT_2;
    let iso = ISO_CS;
    let flat = (1.0, 0.0);
    Some(match name {
        "south" | "front" => ([0.0, -1.0], flat, true),
        "north" | "back" => ([0.0, 1.0], flat, true),
        "east" | "side" | "right" => ([1.0, 0.0], flat, true),
        "west" | "left" => ([-1.0, 0.0], flat, true),
        "southeast" | "iso" => ([s, -s], iso, true),
        "southwest" | "isoFrontLeft" => ([-s, -s], iso, true),
        "northeast" | "isoBackRight" => ([s, s], iso, true),
        "northwest" | "isoBackLeft" => ([-s, s], iso, true),
        "perspective" => ([s, -s], PERSPECTIVE_CS, false),
        "top" => ([0.0, -1.0], (0.0, 1.0), true),
        _ => return None,
    })
}

/// Blickrichtung nach Name (Himmelsrichtung oder `View3d`-Blickwinkel, s. Modulkopf).
pub fn view_dir(name: &str) -> Option<ViewDir> {
    let (h, (c, s), ortho) = table(name)?;
    let top = name == "top";
    let to_viewer = if top { [0.0, 0.0, 1.0] } else { [h[0] * c, h[1] * c, s] };
    Some(ViewDir { to_viewer, ortho, top })
}

/// Hoch-Vektor der Kamera in Modell-Koordinaten: senkrecht, bei der Draufsicht Norden.
pub fn up_of(d: &ViewDir) -> [f64; 3] {
    if d.top {
        [0.0, 1.0, 0.0]
    } else {
        [0.0, 0.0, 1.0]
    }
}

/// Modell (x, y, Höhe) → render3d-Welt (x, Höhe, y); derselbe Tausch ist die eigene Umkehrung.
pub fn model_to_world(p: [f64; 3]) -> [f64; 3] {
    [p[0], p[2], p[1]]
}

/// Bild-Rechts einer Kamera in MODELL-Koordinaten (rechtshändig): Blick × oben, normiert.
pub fn model_right(forward: [f64; 3], up: [f64; 3]) -> Option<[f64; 3]> {
    let r = [forward[1] * up[2] - forward[2] * up[1], forward[2] * up[0] - forward[0] * up[2], forward[0] * up[1] - forward[1] * up[0]];
    let l = (r[0] * r[0] + r[1] * r[1] + r[2] * r[2]).sqrt();
    (l > 1e-12 && l.is_finite()).then(|| [r[0] / l, r[1] / l, r[2] / l])
}

/// Bild-Rechts einer Kamera in render3d-WELT-Koordinaten (x, Höhe, y): oben × Blick, normiert — dieselbe Richtung
/// wie [`model_right`] nach dem Achsentausch (der Tausch kehrt das Kreuzprodukt um).
pub fn world_right(forward: [f32; 3], up: [f32; 3]) -> Option<[f32; 3]> {
    let r = [up[1] * forward[2] - up[2] * forward[1], up[2] * forward[0] - up[0] * forward[2], up[0] * forward[1] - up[1] * forward[0]];
    let l = (r[0] * r[0] + r[1] * r[1] + r[2] * r[2]).sqrt();
    (l > 1e-12 && l.is_finite()).then(|| [r[0] / l, r[1] / l, r[2] / l])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn winkel_konstanten_stimmen() {
        let iso = (1.0f64 / 3.0f64.sqrt()).asin();
        assert!((ISO_CS.0 - iso.cos()).abs() < 1e-15 && (ISO_CS.1 - iso.sin()).abs() < 1e-15);
        assert!((PERSPECTIVE_CS.0 - PERSPECTIVE_PITCH.cos()).abs() < 1e-15 && (PERSPECTIVE_CS.1 - PERSPECTIVE_PITCH.sin()).abs() < 1e-15);
    }

    #[test]
    fn suedost_heisst_betrachter_im_suedosten() {
        let d = view_dir("southeast").unwrap();
        assert!(d.to_viewer[0] > 0.0 && d.to_viewer[1] < 0.0 && d.to_viewer[2] > 0.0);
        assert_eq!(view_dir("iso"), view_dir("southeast"));
        assert_eq!(view_dir("front").unwrap().to_viewer, [0.0, -1.0, 0.0]);
        assert_eq!(view_dir("side").unwrap().to_viewer, [1.0, 0.0, 0.0]);
        assert!(view_dir("x").is_none());
        for n in ["south", "north", "east", "west", "southeast", "southwest", "northeast", "northwest", "top", "perspective", "isoFrontLeft", "isoBackRight", "isoBackLeft", "left", "back", "right"] {
            let v = view_dir(n).unwrap().to_viewer;
            assert!((v[0] * v[0] + v[1] * v[1] + v[2] * v[2] - 1.0).abs() < 1e-12, "{n}");
        }
    }

    #[test]
    fn rechts_in_modell_und_welt_stimmen_ueberein() {
        // Blick nach Norden: Osten rechts.
        let r = model_right([0.0, 1.0, 0.0], [0.0, 0.0, 1.0]).unwrap();
        assert!((r[0] - 1.0).abs() < 1e-12);
        let fw = model_to_world([0.0, 1.0, 0.0]);
        let uw = model_to_world([0.0, 0.0, 1.0]);
        let rw = world_right([fw[0] as f32, fw[1] as f32, fw[2] as f32], [uw[0] as f32, uw[1] as f32, uw[2] as f32]).unwrap();
        let back = model_to_world([rw[0] as f64, rw[1] as f64, rw[2] as f64]);
        assert!((back[0] - 1.0).abs() < 1e-6 && back[1].abs() < 1e-6 && back[2].abs() < 1e-6, "{back:?}");
    }
}
