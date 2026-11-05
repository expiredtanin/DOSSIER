// Zeitprofil projectToModel3d am Grossgebäude ([58]); `BIG_OBP=… cargo test --release --test bench58 -- --nocapture --ignored`.
use dossier_core::model3d as m;
use std::time::Instant;

#[test]
#[ignore]
fn profile_model3d() {
    let path = std::env::var("BIG_OBP").expect("BIG_OBP");
    let text = std::fs::read_to_string(path).unwrap();
    let mut d = dossier_core::document::Document::from_json(&text).unwrap();
    let p = d.project().unwrap().clone();
    let t = |name: &str, f: &dyn Fn()| {
        f();
        let t0 = Instant::now();
        for _ in 0..3 {
            f();
        }
        println!("{name:30} {:8.2} ms", t0.elapsed().as_secs_f64() * 1000.0 / 3.0);
    };
    t("parts", &|| {
        m::parts(&p, true, 2.0, false).unwrap();
    });
    t("json(parts)", &|| {
        let x = m::parts(&p, true, 2.0, false).unwrap();
        serde_json::to_string(&x).unwrap();
    });
    t("emit_slabs", &|| {
        m::emit_slabs(&p);
    });
    t("emit_stairs", &|| {
        m::emit_stairs(&p, false);
    });
    t("emit_walls", &|| {
        m::emit_walls(&p, true).unwrap();
    });
    t("emit_context_meshes", &|| {
        m::emit_context_meshes(&p);
    });
    t("emit_columns", &|| {
        m::emit_columns(&p);
    });
    t("emit_opening_meshes", &|| {
        m::emit_opening_meshes(&p, 2.0);
    });
    t("emit_stair_meshes", &|| {
        m::emit_stair_meshes(&p);
    });
    t("emit_stair_railings", &|| {
        m::emit_stair_railings(&p);
    });
    t("emit_roofs", &|| {
        m::emit_roofs(&p, None).unwrap();
    });
    t("emit_roof_cut_layers", &|| {
        m::emit_roof_cut_layers(&p).unwrap();
    });
}

#[test]
#[ignore]
fn dump_parts() {
    let out = std::env::var("DUMP_OUT").expect("DUMP_OUT");
    for f in std::env::var("DUMP_FILES").expect("DUMP_FILES").split(',') {
        let text = std::fs::read_to_string(f).unwrap();
        let mut d = dossier_core::document::Document::from_json(&text).unwrap();
        let p = d.project().unwrap().clone();
        let name = std::path::Path::new(f).file_stem().unwrap().to_string_lossy().to_string();
        for (layered, detail) in [(true, 2.0), (true, 0.0), (false, 1.0)] {
            let x = m::parts(&p, layered, detail, false).unwrap();
            std::fs::write(format!("{out}/{name}.{layered}.{detail}.json"), serde_json::to_string(&x).unwrap()).unwrap();
        }
    }
}
