//! [159] Leistungsmessung des Grundrisses (nativ, von Hand): Zeit je Domäne, je Geschoss und Massstab,
//! Schnitt, Ansicht, 3D-Modell, Schatten und eine kleine Änderung (Wand verschieben → Plan neu, mit den
//! Caches des Dokuments).
//!
//! `BENCH_FILE=mk.obp cargo test --release --lib bench159 -- --ignored --nocapture`
//! (`mk.obp` aus `dossier-cli :musterhaus-komplex migrate --out mk.obp`).

use super::*;
use std::time::Instant;

fn ms(t: Instant) -> f64 {
    t.elapsed().as_secs_f64() * 1e3
}

/// Mittel über `n` Läufe nach einem Aufwärm-Lauf.
fn avg(n: usize, mut f: impl FnMut()) -> f64 {
    f();
    let t = Instant::now();
    for _ in 0..n {
        f();
    }
    ms(t) / n as f64
}

fn plan_args(p: &Project, floor: &str, scale: f64, sun: Option<f64>) -> PlanArgs {
    let codes: Vec<String> = p.flat_categories().iter().map(|c| c.code.clone()).chain(p.drawings2d.iter().map(|d| d.category_code.clone())).collect();
    let mut t = serde_json::json!({ "floor": floor, "show": codes, "grey": [], "global": true, "scale": scale });
    if let Some(s) = sun {
        t["sunWhen"] = serde_json::json!(s);
    }
    PlanArgs::parse(1.0, &t.to_string()).unwrap()
}

/// Zeit je Schritt von [`plan_domains_buf`] (gleiche Reihenfolge), aufsummiert über `n` Läufe.
fn domain_profile(p: &Project, a: &PlanArgs, n: usize) -> Vec<(&'static str, f64)> {
    let mut rows: Vec<(&'static str, f64)> = Vec::new();
    let mut add = |name: &'static str, v: f64| match rows.iter_mut().find(|r| r.0 == name) {
        Some(r) => r.1 += v / n as f64,
        None => rows.push((name, v / n as f64)),
    };
    for _ in 0..n {
        let t = Instant::now();
        let c = Ctx::new(p, a);
        add("Ctx::new", ms(t));
        let mut d = DomainPrims::default();
        let mut b = Bounds::new();
        let t = Instant::now();
        ceilings(&c, &mut d.ceilings, &mut b).unwrap();
        add("Decken", ms(t));
        let t = Instant::now();
        roofs(&c, &mut d.roofs, &mut b);
        add("Dächer", ms(t));
        let t = Instant::now();
        super::super::walls::plan_walls(&c, c.a.reference_lines, &mut d.walls, &mut b).unwrap();
        add("Wände", ms(t));
        let t = Instant::now();
        super::super::stairs::plan_stairs(&c, &mut d.stairs, &mut b);
        add("Treppen", ms(t));
        let t = Instant::now();
        columns(&c, &mut d.columns);
        super::super::trees::plan_trees(&c, &mut d.columns);
        add("Stützen/Bäume", ms(t));
        let t = Instant::now();
        solids(&c, &mut d.solids);
        add("Körper", ms(t));
        let t = Instant::now();
        let drawn = drawing_obstacles(&c);
        add("Hindernisse Zeichnungen", ms(t));
        let t = Instant::now();
        super::super::context::plan_section_lines(&c, &mut d.sections);
        add("Schnittlinien", ms(t));
        let t = Instant::now();
        let mut o = drawn.clone();
        for q in d.sections.iter().filter(|q| matches!(q, Primitive::DrawingText { .. })) {
            o.add_prim(q);
        }
        super::super::context::plan_context_with(&c, &mut d.context, &o);
        add("Kontext/Gelände", ms(t));
        let t = Instant::now();
        let obstacles = stamp_obstacles_with(&d, drawn);
        rooms(&c, &mut d.rooms, &mut b, &obstacles);
        add("Räume/Stempel", ms(t));
        let t = Instant::now();
        let mut finish = Vec::new();
        floor_finishes(&c, &d.rooms, &mut finish);
        add("Bodenbelag", ms(t));
        let t = Instant::now();
        let _ = extras_of(p, a);
        add("Schatten/Baurecht", ms(t));
        if std::env::var("BENCH_VOIDS").is_ok() {
            let z = super::super::extras::cut_z(p, &a.floor);
            for (n, g) in [("decken", &d.ceilings), ("dächer", &d.roofs), ("räume", &d.rooms), ("wände", &d.walls), ("treppen", &d.stairs), ("stützen", &d.columns), ("körper", &d.solids), ("kontext", &d.context), ("schnitte", &d.sections)] {
                let t = Instant::now();
                let r = super::super::extras::subtract_voids(g.clone(), p, z);
                println!("    voids {n}: {} → {} in {:.2} ms", g.len(), r.len(), ms(t));
            }
        }
        let t = Instant::now();
        apply_voids(p, a, &mut d);
        add("Abzugskörper", ms(t));
        let t = Instant::now();
        let mut w = crate::plan::buf::Writer::new(true);
        w.post = super::super::extras::post_for(p, a);
        let start = w.begin_group();
        super::super::drawings::plan_drawings(&c, &mut super::super::drawings::Sink::new(super::super::drawings::Target::Buf(&mut w), super::super::drawings::Keep::All), &mut b).unwrap();
        w.end_group(start);
        add("Zeichnungen", ms(t));
        let t = Instant::now();
        for g in [&d.ceilings, &d.roofs, &d.rooms, &d.walls, &d.stairs, &d.columns, &d.solids, &d.context, &d.sections] {
            w.group(g);
        }
        w.finish();
        add("Puffer schreiben", ms(t));
    }
    rows
}

#[test]
#[ignore]
fn bench159() {
    let Ok(path) = std::env::var("BENCH_FILE") else { return };
    let runs: usize = std::env::var("BENCH_RUNS").ok().and_then(|s| s.parse().ok()).unwrap_or(5);
    let json = std::fs::read_to_string(path).unwrap();
    let p: Project = serde_json::from_str(&json).unwrap();
    // 21. Juni, 10 Uhr UTC (Sonnenstudie, [142]).
    let sun = Some(1_782_036_000_000.0);
    let floors: Vec<String> = p.drawing_levels.iter().filter(|l| l.kind == crate::model::DrawingLevelKind::Floor && l.layout_id.is_none()).map(|l| l.id.clone()).collect();
    println!("== Grundriss (plan_domains_buf, ohne Cache), Mittel über {runs} ==");
    for f in &floors {
        for scale in [100.0, 50.0] {
            let a = plan_args(&p, f, scale, None);
            let t = avg(runs, || {
                plan_domains_buf(&p, &a).unwrap();
            });
            println!("{f} 1:{scale}: {t:.1} ms");
        }
    }
    let a = plan_args(&p, "eg", 100.0, sun);
    let t = avg(runs, || {
        plan_domains_buf(&p, &a).unwrap();
    });
    println!("eg 1:100 mit Schatten: {t:.1} ms");
    for (scale, sun) in [(100.0, None), (50.0, None), (100.0, sun)] {
        println!("== Domänen eg 1:{scale}{} ==", if sun.is_some() { " mit Schatten" } else { "" });
        let a = plan_args(&p, "eg", scale, sun);
        let mut rows = domain_profile(&p, &a, runs);
        let total: f64 = rows.iter().map(|r| r.1).sum();
        rows.sort_by(|x, y| y.1.total_cmp(&x.1));
        for (n, v) in rows {
            println!("  {n:<26} {v:8.2} ms");
        }
        println!("  {:<26} {total:8.2} ms", "Summe");
    }
    println!("== Schnitt / Ansicht ==");
    for l in p.drawing_levels.iter().filter(|l| l.line_points.is_some() && l.layout_id.is_none()) {
        let text = serde_json::json!({ "level": serde_json::to_value(l).unwrap() }).to_string();
        let t = if l.kind == crate::model::DrawingLevelKind::Section {
            avg(runs.min(3), || {
                super::super::section::section_plan_buf(&p, &[0.0, 1.0, 0.0, 0.0], &text).unwrap();
            })
        } else {
            avg(runs.min(3), || {
                super::super::elevation::elevation_plan_buf(&p, &[0.0, 0.0], &text).unwrap();
            })
        };
        println!("{} ({:?}): {t:.1} ms", l.id, l.kind);
    }
    println!("== 3D ==");
    let t = avg(runs.min(3), || {
        crate::queries::run(&p, "model3dParts", &[1.0, 2.0, 0.0, 0.0, 0.0], "").unwrap();
    });
    println!("model3dParts voll: {t:.1} ms");
    println!("== Kleine Änderung (Dokument mit Caches) ==");
    let mut doc = crate::document::Document::from_json(&json).unwrap();
    for (scale, sun) in [(100.0, None), (50.0, None), (100.0, sun)] {
        let a = plan_args(&p, "eg", scale, sun);
        let call = |doc: &mut crate::document::Document| {
            let (p, revs, cache) = doc.project_cached().unwrap();
            plan_domains_cached(p, revs, cache, &a, &Default::default()).unwrap();
        };
        call(&mut doc);
        let t = avg(runs, || call(&mut doc));
        let mut line = format!("eg 1:{scale}{}: unverändert {t:.1} ms", if sun.is_some() { " mit Schatten" } else { "" });
        // Aussenwand (Fussabdruck ändert) und, falls vorhanden, eine Innenwand.
        let walls: Vec<String> = p.walls.iter().filter(|w| w.floor_id == "eg").map(|w| w.id.clone()).take(1).chain(p.walls.iter().filter(|w| w.id == "eg-iw-y5").map(|w| w.id.clone())).collect();
        for wall in walls {
            let mut i = 0;
            let t2 = avg(runs, || {
                i += 1;
                let mut w = serde_json::to_value(doc.project().unwrap().walls.iter().find(|w| w.id == wall).unwrap()).unwrap();
                // Immer weiter (kein Hin und Her, das Zwischenspeicher treffen würde).
                let dx = 0.01;
                w["start"]["x"] = serde_json::json!(w["start"]["x"].as_f64().unwrap() + dx);
                w["end"]["x"] = serde_json::json!(w["end"]["x"].as_f64().unwrap() + dx);
                let o = crate::ops::ops_from_json(&serde_json::json!([{ "kind": "replace", "collection": "walls", "entity": w }])).unwrap();
                doc.commit(o, None, i as f64 * 1e4, false).unwrap();
                call(&mut doc);
            });
            line += &format!(", nach {wall} verschieben {t2:.1} ms");
        }
        println!("{line}");
    }
}
