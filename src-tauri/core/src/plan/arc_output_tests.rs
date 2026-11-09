//! [169] Runde Formen als echte Kreise und Bögen in den Ausgaben des Grundrisses: runde Stütze (geschnitten
//! und als Ansichtskante unter der Schnitthöhe) und Bogenwand. Plan-SVG und Druck-SVG schreiben `<circle>`
//! bzw. `<path>` mit `A`, DXF CIRCLE bzw. LWPOLYLINE mit Bulges, die render2d-Szene tesselliert fein nach.

use super::buf::View;
use super::domains::{plan_domains_buf, PlanArgs};
use super::parts::Part;
use super::wall_join_tests::{add_arc_deg, add_column, base};
use crate::model::*;

fn project(column_height: f64) -> Project {
    let mut p = base();
    add_arc_deg(&mut p, "bw", (0.0, 0.0), 4.0, 0.0, 90.0);
    add_column(&mut p, "C", (8.0, 1.0), ColumnProfile::Round { radius: 0.15 }, Some("concrete"));
    p.columns.as_mut().unwrap()[0].height = column_height;
    p
}

fn buf(p: &Project, scale: f64) -> Vec<u8> {
    let t = serde_json::json!({ "floor": "eg", "show": ["20"], "grey": [], "scale": scale }).to_string();
    plan_domains_buf(p, &PlanArgs::parse(2.0, &t).unwrap()).unwrap()
}

fn parts(bytes: &[u8]) -> Vec<Part> {
    let view = View::parse(bytes).unwrap();
    let n = view.len();
    vec![Part::new(view, 0, n).unwrap()]
}

fn svg(bytes: &[u8], scale: f64) -> String {
    let o = super::svg::SvgOptions { scale_denominator: scale, margin_m: 0.5, min_x: -1.0, min_y: -1.0, max_x: 9.0, max_y: 5.0, hatch: true, line_ends: Default::default() };
    super::svg::plan_svg(&mut parts(bytes), &o).unwrap()
}

#[test]
fn runde_stuetze_als_kreis_in_svg_druck_dxf_und_szene() {
    for (h, what) in [(2.6, "geschnitten"), (0.5, "unter der Schnitthöhe")] {
        let p = project(h);
        let b = buf(&p, 20.0);
        // Plan-SVG: Kreis um (8, 1), r = 0.15 (y gespiegelt: top = 5.5 → cy = 4.5).
        let s = svg(&b, 20.0);
        assert!(s.lines().any(|l| l.starts_with("<circle") && l.contains("cx=\"8\" cy=\"4.5\" r=\"0.15\"")), "{what}: {s}");
        // Druck-SVG: `circle` mit Radius in Papier-mm (0.15 m bei 1:20 = 7.5 mm).
        let po = super::print_svg::PrintOptions { scale_denominator: 20.0, page_w: 500.0, page_h: 300.0, bounds: [-1.0, -1.0, 9.0, 5.0] };
        let ops = super::print_svg::print_svg_ops(&mut parts(&b), &po).unwrap();
        assert!(ops.split('\u{1e}').any(|r| r.contains("\u{1f}circle\u{1f}") && r.contains("\u{1f}r\u{1f}7.5\u{1f}")), "{what}: {ops}");
        // DXF: CIRCLE statt 48 Linien bzw. eines 48-Ecks.
        let o = super::dxf::DxfOptions { scale: 20.0, include_hatches: false, dim_cm: false, paper_layout: false, bounds: [-1.0, -1.0, 9.0, 5.0], default_font: "Arial".into(), floor: "eg".into(), table_labels: String::new() };
        let f = super::dxf::collect(&mut parts(&b), &p, &o).unwrap();
        assert!(f.model[3] >= 1, "{what}: CIRCLE {:?}", f.model);
        assert_eq!(f.model[0], 0, "{what}: keine LINE {:?}", f.model);
        // Szene: fein nachtesselliert (≥ 180 Punkte im Umriss der Stütze).
        let sc = super::scene::build_scene(&mut parts(&b), &[]).unwrap();
        let near = |q: &crate::hatch::V2| ((q.x - 8.0).powi(2) + (q.y - 1.0).powi(2)).sqrt();
        let max_pts = sc.outlines.iter().chain(&sc.polylines).filter(|s| s.pts.iter().all(|q| (near(q) - 0.15).abs() < 1e-6)).map(|s| s.pts.len()).max().unwrap_or(0);
        assert!(max_pts >= 180, "{what}: {max_pts}");
    }
}

#[test]
fn bogenwand_kanten_als_boegen() {
    let p = project(2.6);
    let b = buf(&p, 50.0);
    let s = svg(&b, 50.0);
    // Wandfläche (Pfad mit Bögen, kein Vieleck) und Kanten: Radien 3.9 und 4.1 (Beton 0.2 m um die Achse).
    let arcs: Vec<&str> = s.lines().filter(|l| l.starts_with("<path") && (l.contains(" A 3.9 3.9 ") || l.contains(" A 4.1 4.1 "))).collect();
    assert!(arcs.iter().any(|l| l.contains(" A 3.9 3.9 ") && l.contains(" A 4.1 4.1 ") && l.contains(" Z\"")), "{s}");
    let po = super::print_svg::PrintOptions { scale_denominator: 50.0, page_w: 300.0, page_h: 200.0, bounds: [-1.0, -1.0, 9.0, 5.0] };
    let ops = super::print_svg::print_svg_ops(&mut parts(&b), &po).unwrap();
    // 3.9 m bei 1:50 = 78 mm.
    assert!(ops.split('\u{1e}').any(|r| r.contains("\u{1f}path\u{1f}d\u{1f}") && r.contains(" A 78 78 ")), "{ops}");
    let o = super::dxf::DxfOptions { scale: 50.0, include_hatches: false, dim_cm: false, paper_layout: false, bounds: [-1.0, -1.0, 9.0, 5.0], default_font: "Arial".into(), floor: "eg".into(), table_labels: String::new() };
    let f = super::dxf::collect(&mut parts(&b), &p, &o).unwrap();
    // LWPOLYLINE mit Bulges (Datensatz 24): ein Bulge ≠ 0 hat |b| = tan(90°/4) für den Viertelbogen.
    let i = f.nums.iter().position(|v| *v == 24.0).expect("REC_POLYLINE_BULGE");
    let n = f.nums[i + 3] as usize;
    let bulges: Vec<f64> = (0..n).map(|k| f.nums[i + 4 + 3 * k + 2]).collect();
    assert!(bulges.iter().any(|b| (b.abs() - (std::f64::consts::PI / 8.0).tan()).abs() < 1e-6), "{bulges:?}");
}
