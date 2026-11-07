// Zeitprofil Schnitt/Ansicht importierter Netze ([152]); `BIG_OBP=… cargo test --release --test bench152 -- --nocapture --ignored`
// (Projekt mit Ebenen „Schnitt A" und „Ansicht Süd", z. B. ein IFC-Import).
use dossier_core::plan::section::{LevelSpec, Visibility};
use std::time::Instant;

#[test]
#[ignore]
fn profile_meshes_in_views() {
    let path = std::env::var("BIG_OBP").expect("BIG_OBP");
    let text = std::fs::read_to_string(path).unwrap();
    let mut d = dossier_core::document::Document::from_json(&text).unwrap();
    let p = d.project().unwrap().clone();
    let level = |name: &str| {
        let l = p.drawing_levels.iter().find(|l| l.name == name).unwrap();
        LevelSpec::from_json(&serde_json::to_value(l).unwrap())
    };
    let t = |name: &str, f: &dyn Fn()| {
        let t0 = Instant::now();
        f();
        println!("{name:30} {:8.2} ms", t0.elapsed().as_secs_f64() * 1000.0);
    };
    t("meshes (Topologie)", &|| {
        dossier_core::mesh_view::meshes(&p);
    });
    t("meshes (gemerkt)", &|| {
        dossier_core::mesh_view::meshes(&p);
    });
    let s = level("Schnitt A");
    t("compute_section", &|| {
        dossier_core::plan::section::compute_section(&p, &s, &[]).unwrap();
    });
    let e = level("Ansicht Süd");
    t("elevation_primitives", &|| {
        let (prims, _) = dossier_core::plan::elevation::elevation_primitives(&p, &e, false, true, &Visibility::default(), 100.0).unwrap().unwrap();
        println!("  {} Primitive", prims.len());
    });
}
