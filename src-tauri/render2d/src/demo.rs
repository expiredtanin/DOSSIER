// Geteilte Demo-Szene fuer die Fenster-Spikes (standalone winit-Bin UND der
// In-Tauri-Spike). EINE Quelle der Wahrheit, damit beide exakt dasselbe zeichnen
// und der Renderer/die Szene NICHT dupliziert wird.
//
// serde-only + GPU-frei: baut im Standard-Feature mit (kein `render`/`window`
// noetig), damit die Szene auch headless testbar bleibt.

use crate::tessellate::PX_PER_M;
use crate::types::{FillPolygon, Line, Outline, Scene, Text, TextAlign, ViewBox};

/// Demo-Szene in Modell-Metern: ein L-foermiger Wand-Poche (konkav!), ein Raum
/// und ein paar Striche — genug, um Fuellung, Umriss und Papier-mm-Linien zu sehen.
pub fn demo_scene() -> Scene {
    let wall_grey: [f32; 4] = [0.55, 0.55, 0.55, 1.0];
    let room_blue: [f32; 4] = [0.20, 0.45, 0.85, 0.18];
    let ink: [f32; 4] = [0.10, 0.10, 0.10, 1.0];

    // Konkaves L (Wandflaeche).
    let l = vec![
        [0.0, 0.0],
        [4.0, 0.0],
        [4.0, 2.0],
        [2.0, 2.0],
        [2.0, 4.0],
        [0.0, 4.0],
    ];
    // Ein transluzenter Raum daneben.
    let room = vec![[5.0, 0.0], [9.0, 0.0], [9.0, 4.0], [5.0, 4.0]];

    Scene {
        fills: vec![
            FillPolygon {
                pts: l.clone(),
                color: wall_grey,
            },
            FillPolygon {
                pts: room.clone(),
                color: room_blue,
            },
        ],
        outlines: vec![
            Outline {
                pts: l,
                color: ink,
                width_mm: 0.35,
            },
            Outline {
                pts: room,
                color: ink,
                width_mm: 0.18,
            },
        ],
        polylines: vec![],
        lines: vec![Line {
            a: [0.0, -1.0],
            b: [9.0, -1.0],
            color: ink,
            width_mm: 0.25,
        }],
        // Ein Raumstempel-artiger Text (echte Glyphen via Atlas), mittig im Raum.
        texts: vec![Text {
            pos: [7.0, 2.0],
            content: "Raum 16.00 m²".into(),
            size_mm: 3.5,
            color: ink,
            align: TextAlign::Center,
        }],
    }
}

/// viewBox so, dass die Szene mittig einpasst (Bildschirm-Raum = Meter*PX_PER_M).
pub fn initial_view_box() -> ViewBox {
    // Szene ~ x[0..9], y[-1..4] in Meter -> Bildschirm x[0..810], y[-360..90].
    // Etwas Rand drumherum.
    let pad = 90.0;
    ViewBox::new(
        -pad,
        -4.0 * PX_PER_M - pad,
        9.0 * PX_PER_M + 2.0 * pad,
        5.0 * PX_PER_M + 2.0 * pad,
    )
}
