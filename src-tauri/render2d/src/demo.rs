// Geteilte Demo-Szene fuer die Fenster-Spikes (standalone winit-Bin UND der
// In-Tauri-Spike). EINE Quelle der Wahrheit, damit beide exakt dasselbe zeichnen
// und der Renderer/die Szene NICHT dupliziert wird.
//
// serde-only + GPU-frei: baut im Standard-Feature mit (kein `render`/`window`
// noetig), damit die Szene auch headless testbar bleibt.

use crate::tessellate::PX_PER_M;
use crate::types::{Arc, FillPolygon, Line, Outline, Polyline, Scene, Text, TextAlign, ViewBox};

/// Demo-Szene in Modell-Metern: ein L-foermiger Wand-Poche (konkav!), ein Raum
/// mit 45-Grad-Schraffur, ein Tuerschwenk-Bogen und ein paar Striche — genug, um
/// ALLE Render-Pfade zu sehen (Fuellung, Umriss, Schraffur/widthScreen,
/// analytischer Bogen, Papier-mm-Linien, Text).
pub fn demo_scene() -> Scene {
    let wall_grey: [f32; 4] = [0.55, 0.55, 0.55, 1.0];
    let room_blue: [f32; 4] = [0.20, 0.45, 0.85, 0.18];
    let hatch_blue: [f32; 4] = [0.20, 0.45, 0.85, 0.55];
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

    // 45-Grad-Schraffur im Raum (wie ein SVG-<pattern>): Strichbreite in
    // BILDSCHIRM-Einheiten (`width_screen`), skaliert also mit dem Zoom wie die
    // Musterkachel — genau der Pfad, den echte Material-Schraffuren nehmen.
    // Linien y = x + c, auf das Raum-Rechteck geklippt.
    let (hx0, hx1, hy0, hy1) = (5.0f32, 9.0f32, 0.0f32, 4.0f32);
    let hatch_step = 0.5f32;
    let mut hatch: Vec<Polyline> = Vec::new();
    let mut c = hy0 - hx1 + hatch_step;
    while c < hy1 - hx0 {
        let xa = hx0.max(hy0 - c);
        let xb = hx1.min(hy1 - c);
        if xb > xa {
            hatch.push(Polyline {
                pts: vec![[xa, xa + c], [xb, xb + c]],
                color: hatch_blue,
                // Breite in Bildschirm-Einheiten (viewBox-px), NICHT Papier-mm.
                width_mm: 1.2,
                width_screen: true,
                dash: None,
                // Ueber der Raum-Fuellung (gleiches z=2, Kategorie Polyline kommt
                // in der stabilen Sortierung NACH den Fills), unter dem
                // Raum-Umriss (z=3).
                z: 2,
            });
        }
        c += hatch_step;
    }

    Scene {
        fills: vec![
            FillPolygon {
                pts: l.clone(),
                color: wall_grey,
                z: 0,
            },
            FillPolygon {
                pts: room.clone(),
                color: room_blue,
                z: 2,
            },
        ],
        outlines: vec![
            Outline {
                pts: l,
                color: ink,
                width_mm: 0.35,
                dash: None,
                z: 1,
            },
            Outline {
                pts: room,
                color: ink,
                width_mm: 0.18,
                dash: None,
                z: 3,
            },
        ],
        polylines: hatch,
        // Tuerschwenk in der linken Raumwand: analytischer Bogen (SDF-Pipeline),
        // Angel bei (5,1), Blatt offen nach (6,1), Schwenk bis (5,2).
        arcs: vec![Arc {
            center: [5.0, 1.0],
            from: [6.0, 1.0],
            to: [5.0, 2.0],
            r: 1.0,
            color: ink,
            width_mm: 0.18,
            dash: None,
        }],
        lines: vec![
            Line {
                a: [0.0, -1.0],
                b: [9.0, -1.0],
                color: ink,
                width_mm: 0.25,
                dash: None,
                z: 4,
            },
            // Tuerblatt zum Schwenkbogen (die Boegen zeichnen NACH den Linien,
            // der Bogen liegt also wie im echten Plan ueber dem Blatt).
            Line {
                a: [5.0, 1.0],
                b: [6.0, 1.0],
                color: ink,
                width_mm: 0.25,
                dash: None,
                z: 5,
            },
        ],
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
