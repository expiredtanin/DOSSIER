//! Beweis-Artefakt fuer den analytischen Schnitt/Ansicht-Extraktor (`section.rs`):
//! baut die L-Wand + Bodenplatte-Testszene (Schenkel A bekommt ein FENSTER) plus
//! eine kurze "Spaeh"-Wand hinter dem Fenster, schneidet/betrachtet sie mit einer
//! Ebene, die sowohl Material schneidet ALS AUCH auf dahinterliegende Kanten
//! blickt, und schreibt das Ergebnis als SVG nach
//! `docs/welle-c-hlr-spike/section-engine-proof.svg`.
//!
//! Aufruf: `cargo run --example section_svg` (im Verzeichnis `src-tauri/render3d`).

use render3d::section::{cut_section, ComponentKind, SectionOutput, SectionPlane};
use render3d::types::Opening;
use render3d::{SlabInput, WallInput};

fn l_wall_scene() -> (Vec<WallInput>, Vec<SlabInput>) {
    let color = [0.8, 0.8, 0.8];
    let walls = vec![
        // Schenkel A: Achse (0,0)->(0,3) -- bekommt ein Fenster (u = Modell-Y
        // liegt fuer diese Blickrichtung parallel zur Achse -> Elevations-Fall,
        // siehe section.rs-Moduldoc "Oeffnungen"). Fenster von Y=1.0 bis 2.0,
        // Bruestung 0.8 m, Fensterhoehe 1.0 m (Sturz ab Y-Hoehe 1.8).
        WallInput {
            start: [0.0, 0.0],
            end: [0.0, 3.0],
            thickness: 0.2,
            height: 2.5,
            base_elevation: 0.0,
            color,
            openings: vec![Opening {
                from: 1.0,
                to: 2.0,
                sill: 0.8,
                height: 1.0,
            }],
            layers: None,
            holes: vec![],
            material_index: None,
            hatch: None,
            cut: None,
        },
        WallInput {
            start: [0.0, 3.0],
            end: [3.0, 3.0],
            thickness: 0.2,
            height: 2.5,
            base_elevation: 0.0,
            color,
            openings: vec![],
            layers: None,
            holes: vec![],
            material_index: None,
            hatch: None,
            cut: None,
        },
        // "Spaeh"-Wand: kurzer Stummel HINTER Schenkel A (groesseres Modell-X,
        // also groessere Tiefe von der Betrachter-Ebene aus), genau im
        // Grundriss-Y-Bereich des Fensters (1.2..1.8, sicher innerhalb 1.0..2.0)
        // -- demonstriert den Durchblick: sichtbar im Fensterband (Hoehe
        // 0.8..1.8), verdeckt darueber/darunter.
        WallInput {
            start: [1.5, 1.2],
            end: [1.5, 1.8],
            thickness: 0.2,
            height: 2.5,
            base_elevation: 0.0,
            color,
            openings: vec![],
            layers: None,
            holes: vec![],
            material_index: None,
            hatch: None,
            cut: None,
        },
    ];
    let slabs = vec![SlabInput {
        outline: vec![[-0.5, -0.5], [3.5, -0.5], [3.5, 3.5], [-0.5, 3.5]],
        z_bottom: -0.2,
        z_top: 0.0,
        color: [0.86, 0.86, 0.88],
        hatch: None,
        cut: None,
    }];
    (walls, slabs)
}

/// Rendert `out` als SVG: Cut-Polygone gefuellt + Kontur, sichtbare Kanten
/// durchgezogen, verdeckte Kanten gestrichelt. Achse v wird fuer den Bildraum
/// gespiegelt (SVG: y waechst nach unten; Schnittkoordinaten: v waechst nach oben).
fn render_svg(out: &SectionOutput) -> String {
    const MARGIN: f32 = 0.4;
    const SCALE: f32 = 120.0; // Pixel je Meter

    let mut min_u = f32::INFINITY;
    let mut max_u = f32::NEG_INFINITY;
    let mut min_v = f32::INFINITY;
    let mut max_v = f32::NEG_INFINITY;
    let mut visit = |u: f32, v: f32| {
        min_u = min_u.min(u);
        max_u = max_u.max(u);
        min_v = min_v.min(v);
        max_v = max_v.max(v);
    };
    for c in &out.cut_polygons {
        for p in &c.pts {
            visit(p[0], p[1]);
        }
    }
    for e in out.visible_edges.iter().chain(out.hidden_edges.iter()) {
        visit(e.a[0], e.a[1]);
        visit(e.b[0], e.b[1]);
    }
    assert!(min_u.is_finite() && max_u.is_finite(), "leere Szene?");

    min_u -= MARGIN;
    max_u += MARGIN;
    min_v -= MARGIN;
    max_v += MARGIN;
    let width = (max_u - min_u) * SCALE;
    let height = (max_v - min_v) * SCALE;

    let sx = |u: f32| (u - min_u) * SCALE;
    let sy = |v: f32| height - (v - min_v) * SCALE; // v-Achse spiegeln

    let mut svg = String::new();
    svg.push_str(&format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"{width:.0}\" height=\"{height:.0}\" viewBox=\"0 0 {width:.1} {height:.1}\">\n"
    ));
    svg.push_str(&format!(
        "<rect x=\"0\" y=\"0\" width=\"{width:.1}\" height=\"{height:.1}\" fill=\"#ffffff\"/>\n"
    ));

    // Cut-Polygone: gefuellt (grau) + Kontur.
    for c in &out.cut_polygons {
        let pts = c
            .pts
            .iter()
            .map(|p| format!("{:.2},{:.2}", sx(p[0]), sy(p[1])))
            .collect::<Vec<_>>()
            .join(" ");
        let fill = if c.component.kind == ComponentKind::Wall {
            "#b9b3ab"
        } else {
            "#c9d2d6"
        };
        svg.push_str(&format!(
            "<polygon points=\"{pts}\" fill=\"{fill}\" stroke=\"#2b2b2b\" stroke-width=\"1.2\"/>\n"
        ));
    }

    // Sichtbare Kanten: durchgezogen.
    for e in &out.visible_edges {
        svg.push_str(&format!(
            "<line x1=\"{:.2}\" y1=\"{:.2}\" x2=\"{:.2}\" y2=\"{:.2}\" stroke=\"#111111\" stroke-width=\"1.6\"/>\n",
            sx(e.a[0]), sy(e.a[1]), sx(e.b[0]), sy(e.b[1])
        ));
    }
    // Verdeckte Kanten: gestrichelt.
    for e in &out.hidden_edges {
        svg.push_str(&format!(
            "<line x1=\"{:.2}\" y1=\"{:.2}\" x2=\"{:.2}\" y2=\"{:.2}\" stroke=\"#888888\" stroke-width=\"1.0\" stroke-dasharray=\"5,4\"/>\n",
            sx(e.a[0]), sy(e.a[1]), sx(e.b[0]), sy(e.b[1])
        ));
    }

    svg.push_str("</svg>\n");
    svg
}

fn main() {
    let (walls, slabs) = l_wall_scene();
    // Ebene bei Grundriss-X = -0.3: schneidet NUR die Bodenplatte (Umriss x in
    // [-0.5,3.5]) -- liefert deren Poche als Cut-Polygon -- waehrend ALLE DREI
    // Waende (Schenkel A samt Fenster, Schenkel B, die Spaeh-Wand) vollstaendig
    // HINTER der Ebene liegen und daher als Draht-Silhouette projiziert werden
    // (inkl. der in den Tests verifizierten Eck-Ueberlappungs-Verdeckung UND
    // des Fensterrahmens + Durchblicks auf die Spaeh-Wand, siehe
    // section.rs-Tests). Zeigt also geschnittenes Material UND eine gemischte
    // sichtbar/verdeckt-Ansicht MIT Oeffnung in einem Bild.
    let plane = SectionPlane::looking_plus_x(-0.3);
    let out = cut_section(&plane, &walls, &slabs, &[]);

    println!(
        "cut_polygons={}, visible_edges={}, hidden_edges={}",
        out.cut_polygons.len(),
        out.visible_edges.len(),
        out.hidden_edges.len()
    );
    for c in &out.cut_polygons {
        println!(
            "  cut {:?}#{}: pts={:?}",
            c.component.kind, c.component.index, c.pts
        );
    }

    let svg = render_svg(&out);

    let out_path = format!(
        "{}/../../docs/welle-c-hlr-spike/section-engine-proof.svg",
        env!("CARGO_MANIFEST_DIR")
    );
    std::fs::write(&out_path, svg).expect("SVG schreiben fehlgeschlagen");
    println!("geschrieben: {out_path}");
}
