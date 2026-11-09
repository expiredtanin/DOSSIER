//! Messung des Schnitts je Stufe (von Hand, `#[ignore]`).

use super::*;
use std::time::Instant;

/// Messung je Stufe (nativ): `SECTION_BENCH_FILE=projekt.obp cargo test --release --lib section::bench -- --ignored --nocapture`.
#[test]
#[ignore]
fn stufen() {
    let Ok(path) = std::env::var("SECTION_BENCH_FILE") else { return };
    let p: Project = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    for l in p.drawing_levels.iter().filter(|l| l.line_points.is_some()) {
        let level = LevelSpec::from_json(&serde_json::to_value(l).unwrap());
        let t = Instant::now();
        let walls = model3d::emit_walls(&p, false).unwrap();
        let t_walls = t.elapsed();
        let t = Instant::now();
        let mut slabs = model3d::emit_slabs(&p);
        slabs.extend(model3d::emit_stairs(&p, true));
        let t_rest = t.elapsed();
        let t = Instant::now();
        let wi: Vec<render3d::WallInput> = walls.iter().map(wall_input).collect();
        let si: Vec<render3d::SlabInput> = slabs.iter().map(slab_input).collect();
        let t_conv = t.elapsed();
        let pl = level.plane().unwrap();
        let fr = |v: [f64; 3]| [v[0] as f32, v[1] as f32, v[2] as f32];
        let t = Instant::now();
        let raw = render3d::section::cut_polygons(&render3d::SectionPlane::new(fr(pl.point), fr(pl.normal)), &wi, &si, &[]);
        let t_cut = t.elapsed();
        let t = Instant::now();
        let buf = if l.kind == DrawingLevelKind::Section {
            section_plan_buf(&p, &[0.0, 1.0, 0.0, 0.0], &serde_json::json!({ "level": serde_json::to_value(l).unwrap() }).to_string()).unwrap()
        } else {
            crate::plan::elevation::elevation_plan_buf(&p, &[0.0, 0.0], &serde_json::json!({ "level": serde_json::to_value(l).unwrap() }).to_string()).unwrap()
        };
        let t_all = t.elapsed();
        println!(
            "{} {:?}: Wände {:?} Platten/Dach {:?} Umwandlung {:?} cut_polygons {:?} ({} Cut) | gesamt {:?} ({} Bytes)",
            l.id, l.kind, t_walls, t_rest, t_conv, t_cut, raw.len(), t_all, buf.len()
        );
    }
}
