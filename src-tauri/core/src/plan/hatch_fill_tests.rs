//! [133] Vollflächen-, Bild-Schraffur und Löcher beim Ausbreiten der Schraffur (CLI-SVG `--hatch`,
//! Druck-SVG der Layout-Blätter). Der Bildschirm (render2d-Szene) zeichnet weder Vollflächen- noch Bildschraffur
//! selbst (die Fläche trägt die Füllung des Erzeugers); die Ausgaben mit Blatt-Treue (CLI, Druck/PDF) füllen mit
//! Schraffurfarbe bzw. kacheln das Bild. Löcher reisen als Ring mit Brücke (`polygon_holes::merge_holes`); die
//! Schraffur darf nicht in das Loch laufen.

use super::buf::{View, Writer};
use super::hatch_dir_tests::{rendered, Seg};
use super::parts::Part;
use super::prim::Primitive;
use crate::hatch::V2;
use crate::model::{HatchPattern, HatchStyleImage, HatchStyleKind, Vec2};

fn poly(pts: Vec<Vec2>, fill: &str, hatch: crate::plan::prim::HatchRender, nse: Option<Vec<f64>>) -> Primitive {
    Primitive::Polygon {
        pts,
        fill: fill.into(),
        stroke: "#000000".into(),
        stroke_width_mm: 0.25,
        hatch: Box::new(hatch),
        greyed: None,
        opacity: None,
        no_stroke_edges: nse,
        wall_id: None,
        drawing_id: None,
        ceiling_id: None,
        opening_id: None,
        stair_id: None,
        room_id: None,
        extruded_solid_id: None,
        context_object_id: None,
        column_id: None,
        roof_id: None,
        section_line_id: None,
    }
}

fn rect(x0: f64, y0: f64, x1: f64, y1: f64) -> Vec<[f64; 2]> {
    vec![[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
}

fn svgs(p: &Primitive, scale: f64, hatch: bool) -> (String, String) {
    let mut w = Writer::new(true);
    w.group(std::slice::from_ref(p));
    let bytes = w.finish();
    let parts = || {
        let view = View::parse(&bytes).unwrap();
        let n = view.len();
        vec![Part::new(view, 0, n).unwrap()]
    };
    let o = super::svg::SvgOptions { scale_denominator: scale, margin_m: 0.0, min_x: 0.0, min_y: 0.0, max_x: 4.0, max_y: 4.0, hatch, line_ends: Default::default() };
    let svg = super::svg::plan_svg(&mut parts(), &o).unwrap();
    let po = super::print_svg::PrintOptions { scale_denominator: scale, page_w: 4.0 * 1000.0 / scale, page_h: 4.0 * 1000.0 / scale, bounds: [0.0, 0.0, 4.0, 4.0] };
    let ops = super::print_svg::print_svg_ops(&mut parts(), &po).unwrap();
    (svg, ops)
}

fn square() -> Vec<Vec2> {
    [[0.0, 0.0], [4.0, 0.0], [4.0, 4.0], [0.0, 4.0]].iter().map(|p| Vec2 { x: p[0], y: p[1] }).collect()
}

#[test]
fn schraffur_laeuft_nicht_ins_loch() {
    let mut h = crate::plan::style::no_hatch();
    h.pattern = HatchPattern::Diagonal;
    h.scale = 1.0;
    h.angle = 45.0;
    let merged = crate::polygon_holes::merge_holes(&rect(0.0, 0.0, 4.0, 4.0), &[rect(1.0, 1.0, 3.0, 3.0)], 1e-4);
    assert!(!merged.bridge_edges.is_empty());
    let ring: Vec<Vec2> = merged.ring.iter().map(|q| Vec2 { x: q[0], y: q[1] }).collect();
    let nse: Vec<f64> = merged.bridge_edges.iter().map(|&k| k as f64).collect();
    let p = poly(ring, "#ffffff", h, Some(nse));
    for (what, segs) in rendered(std::slice::from_ref(&p), 50.0) {
        let n: usize = segs.iter().map(|s| s.len()).sum();
        assert!(n > 20, "{what}: Schraffur fehlt ({n})");
        let hatch_segs: Vec<&Seg> = segs.iter().filter(|s| s.len() >= 2).collect();
        let mut in_ring = 0;
        for s in &hatch_segs {
            for w in s.windows(2) {
                let m = V2 { x: (w[0].x + w[1].x) / 2.0, y: (w[0].y + w[1].y) / 2.0 };
                // Mitte der Teilstrecke strikt im Loch (Umriss und Brücke liegen auf dem Rand: Toleranz).
                let in_hole = m.x > 1.01 && m.x < 2.99 && m.y > 1.01 && m.y < 2.99;
                assert!(!in_hole, "{what}: Schraffurlinie im Loch bei {m:?}");
                in_ring += 1;
            }
        }
        assert!(in_ring > 10, "{what}: zu wenig Linien im Ring");
    }
}

#[test]
fn vollflaeche_als_gefuelltes_polygon() {
    let mut h = crate::plan::style::no_hatch();
    h.pattern = HatchPattern::Solid;
    h.color = "#223344".into();
    let p = poly(square(), "none", h, None);
    let (svg, ops) = svgs(&p, 50.0, true);
    let line = svg.lines().find(|l| l.starts_with("<polygon")).expect("Polygon");
    assert!(line.contains("fill=\"#223344\""), "CLI-Vollfläche in Schraffurfarbe: {line}");
    assert!(!svg.contains("<line"), "keine Schraffurlinien bei Vollfläche");
    assert!(ops.contains("#223344"), "Druck: {ops}");
}

#[test]
fn bildschraffur_als_pattern() {
    let mut h = crate::plan::style::no_hatch();
    h.pattern = HatchPattern::Diagonal;
    h.kind = Some(HatchStyleKind::Image);
    h.image = Some(HatchStyleImage { src: "data:image/png;base64,AAAA".into(), scale_x: 2.0, scale_y: 1.0, rotation: 30.0, ..Default::default() });
    let p = poly(square(), "#eeeeee", h, None);
    let (svg, ops) = svgs(&p, 50.0, true);
    assert!(svg.contains("<defs>") && svg.contains("<pattern id=\"imgpat-"), "{svg}");
    assert!(svg.contains("<image href=\"data:image/png;base64,AAAA\""), "{svg}");
    assert!(svg.contains("patternTransform=\"rotate(30)\""), "{svg}");
    assert!(svg.contains("fill=\"url(#imgpat-"), "{svg}");
    assert!(ops.contains("I\x1f"), "Druck kachelt das Bild: {ops}");
    // Ohne `hatch` bleibt es bei der Grundfüllung.
    let (plain, _) = svgs(&p, 50.0, false);
    assert!(!plain.contains("<pattern"));
}
