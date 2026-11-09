//! Früher `voids.test.ts` (Schnitt): Abzugskörper = Grundfläche × Höhenbereich, aus den Cut-Bändern
//! abgezogen.

use super::*;

#[test]
fn abzugskoerper_wird_aus_dem_schnittband_gezogen() {
    let mut p: Project = serde_json::from_str(include_str!("../../../tests/fixtures/sample_project.json")).unwrap();
    let (mx, my) = (2.5, 0.0);
    let solid: ExtrudedSolid = serde_json::from_value(serde_json::json!({
        "id": "void1", "type": "extrudedSolid", "levelId": "eg", "operation": "subtract", "height": 1.0, "baseOffset": 0.5,
        "points": [{"x": mx - 0.3, "y": my - 1.0}, {"x": mx + 0.3, "y": my - 1.0}, {"x": mx + 0.3, "y": my + 1.0}, {"x": mx - 0.3, "y": my + 1.0}]
    }))
    .unwrap();
    p.extruded_solids = Some(vec![solid]);
    let band = Cut::new(Kind::Wall, 0, vec![[mx - 2.0, 0.0], [mx + 2.0, 0.0], [mx + 2.0, 2.5], [mx - 2.0, 2.5]]);
    let out = subtract_voids_in_section(vec![band], &p, (0.0, my), (1.0, 0.0));
    assert_eq!(out.len(), 1);
    let pts: Vec<(f64, f64)> = out[0].pts.iter().map(|q| (q[0], q[1])).collect();
    let area = (0..pts.len()).map(|i| { let (a, b) = (pts[i], pts[(i + 1) % pts.len()]); a.0 * b.1 - b.0 * a.1 }).sum::<f64>().abs() / 2.0;
    assert!((area - (4.0 * 2.5 - 0.6 * 1.0)).abs() < 1e-6, "{area}");
    assert_eq!(out[0].nse.as_ref().map(|n| n.len()), Some(2), "Schlüsselloch-Stege ungestrichen");
}
