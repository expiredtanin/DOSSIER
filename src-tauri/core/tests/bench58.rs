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

/// Inkrementell über das Dokument: erste Abfrage, ohne Änderung, nach 1 Wand-Änderung; gleich wie voll.
#[test]
#[ignore]
fn incremental_model3d() {
    for f in std::env::var("DUMP_FILES").expect("DUMP_FILES").split(',') {
        for args in [[1.0, 2.0, 0.0, 0.0, 0.0], [1.0, 2.0, 0.0, 1.0, 0.0]] {
            let text = std::fs::read_to_string(f).unwrap();
            let mut d = dossier_core::document::Document::from_json(&text).unwrap();
            let t0 = Instant::now();
            dossier_core::queries::run_doc(&mut d, "model3dParts", &args, "").unwrap();
            let first = t0.elapsed().as_secs_f64() * 1000.0;
            let t0 = Instant::now();
            dossier_core::queries::run_doc(&mut d, "model3dParts", &args, "").unwrap();
            let same = t0.elapsed().as_secs_f64() * 1000.0;
            let mut w = d.root()["walls"][3].clone();
            w["height"] = serde_json::json!(w["height"].as_f64().unwrap_or(2.6) + 0.1);
            d.commit(
                vec![dossier_core::ops::Op::Replace {
                    collection: "walls".into(),
                    entity: w,
                }],
                None,
                0.0,
                false,
            )
            .unwrap();
            let t0 = Instant::now();
            let inc = dossier_core::queries::run_doc(&mut d, "model3dParts", &args, "").unwrap();
            let edit = t0.elapsed().as_secs_f64() * 1000.0;
            let p = d.project().unwrap().clone();
            let t0 = Instant::now();
            let full = dossier_core::queries::run(&p, "model3dParts", &args, "").unwrap();
            let full_ms = t0.elapsed().as_secs_f64() * 1000.0;
            assert!(inc == full, "{f}: inkrementell ≠ voll");
            println!(
                "{args:?} {f}: erste {first:.1} ms, gleich {same:.1} ms, nach 1 Wand {edit:.1} ms (neu {:?}), voll {full_ms:.1} ms",
                d.model3d_rebuilt()
            );
        }
    }
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
