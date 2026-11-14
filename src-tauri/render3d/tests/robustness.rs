//! [258] Robustheit der Eingänge von render3d (`web.rs`: `set_model`, `set_parts`, `cut_section_json`, Ghost-Teile):
//! das GPU-freie Rückgrat (JSON-Modell → `Scene::apply` → `chunk_data`, Schnitt `cut_section`) darf auf Unsinn nie
//! paniken — ein Panic legt im Browser das ganze WASM-Modul lahm. Ausgangspunkt ist ein gültiges Teile-Update
//! (Wand mit Öffnung/Loch/Schichten, Decke, Mesh, Dachschicht), dessen Zahlen/Typen/Felder zufällig verdorben werden
//! (0, ±1, 1e-30, 1e30, 1e300, falscher Typ, null, gelöscht, Array verkürzt/verdoppelt); dazu Zufallstext.
//! Fester Seed, eigener PRNG, jeder Aufruf unter `catch_unwind`. `ROBUST_N` (Standard 1500), `ROBUST_SEED`.

use render3d::scene::{PartsUpdate, Scene};
use render3d::section::{cut_section, SectionPlane};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::{Arc, Mutex};

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    fn below(&mut self, n: usize) -> usize {
        if n == 0 { 0 } else { (self.next() % n as u64) as usize }
    }
    fn f32(&mut self) -> f32 {
        const POOL: [f32; 10] = [0.0, -0.0, 1.0, -1.0, 1e-30, 1e30, f32::NAN, f32::INFINITY, f32::NEG_INFINITY, f32::MAX];
        match self.below(3) {
            0 => POOL[self.below(POOL.len())],
            1 => f32::from_bits(self.next() as u32),
            _ => (self.next() >> 40) as f32 / (1u64 << 24) as f32 * 20.0 - 10.0,
        }
    }
}

fn seed_update() -> Value {
    json!({
        "reset": true,
        "upsert": [{
            "id": "a",
            "walls": [{
                "start": [0.0, 0.0], "end": [6.0, 0.0], "thickness": 0.3, "height": 2.8, "baseElevation": 0.0,
                "openings": [{"from": 1.0, "to": 2.0, "sill": 0.8, "height": 1.2}],
                "holes": [{"from": 3.0, "to": 4.0, "zBottom": 0.0, "zTop": 2.1}],
                "layers": [{"thickness": 0.1, "color": [0.9, 0.9, 0.9]}, {"thickness": 0.2, "color": [0.5, 0.4, 0.3]}]
            }, {
                "start": [6.0, 0.0], "end": [6.0, 4.0], "thickness": 0.3, "height": 2.8, "topDrop": [0.2, 0.0]
            }],
            "slabs": [{"outline": [[0.0, 0.0], [6.0, 0.0], [6.0, 4.0], [0.0, 4.0]], "zBottom": -0.2, "zTop": 0.0}],
            "meshes": [{"positions": [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0], "indices": [0, 1, 2]}],
            "roofLayers": [{"polygon": [[0.0, 2.8, 0.0], [6.0, 2.8, 0.0], [6.0, 3.6, 4.0], [0.0, 3.6, 4.0]], "normal": [0.0, 0.9, -0.4], "thickness": 0.2, "color": [0.6, 0.2, 0.2]}]
        }]
    })
}

/// Zahlen verdorben, Typen vertauscht, Felder gelöscht, Arrays verändert.
fn mutate(v: &mut Value, rng: &mut Rng, budget: &mut u32) {
    match v {
        Value::Number(_) => {
            if *budget > 0 && rng.below(6) == 0 {
                *budget -= 1;
                *v = match rng.below(9) {
                    0 => json!(0),
                    1 => json!(-1),
                    2 => json!(1e-30),
                    3 => json!(1e30),
                    4 => json!(1e300),
                    5 => json!(4294967296u64),
                    6 => json!(-4294967295i64),
                    7 => json!(0.5),
                    _ => Value::Null,
                };
            }
        }
        Value::Array(a) => {
            if *budget > 0 && rng.below(10) == 0 {
                *budget -= 1;
                match rng.below(4) {
                    0 => a.clear(),
                    1 => {
                        a.pop();
                    }
                    2 => {
                        if let Some(x) = a.first().cloned() {
                            a.push(x);
                        }
                    }
                    _ => a.push(json!("x")),
                }
            }
            for x in a.iter_mut() {
                mutate(x, rng, budget);
            }
        }
        Value::Object(m) => {
            if *budget > 0 && rng.below(14) == 0 {
                *budget -= 1;
                if let Some(k) = m.keys().nth(rng.below(m.len())).cloned() {
                    m.remove(&k);
                }
            }
            for (_, x) in m.iter_mut() {
                mutate(x, rng, budget);
            }
        }
        Value::String(_) => {
            if *budget > 0 && rng.below(4) == 0 {
                *budget -= 1;
                *v = json!(rng.below(100));
            }
        }
        _ => {}
    }
}

#[test]
fn render3d_eingaenge_kaputte_daten() {
    let n: u64 = std::env::var("ROBUST_N").ok().and_then(|v| v.parse().ok()).unwrap_or(1500);
    let seed: u64 = std::env::var("ROBUST_SEED").ok().and_then(|v| v.parse().ok()).unwrap_or(0x5eed_258) | 1;

    let default = std::panic::take_hook();
    let cur = Arc::new(Mutex::new(false));
    let last = Arc::new(Mutex::new(String::new()));
    {
        let (cur, last) = (cur.clone(), last.clone());
        std::panic::set_hook(Box::new(move |info| {
            if !*cur.lock().unwrap() {
                default(info);
                return;
            }
            let loc = info.location().map(|l| format!("{}:{}", l.file(), l.line())).unwrap_or_default();
            let msg = info.payload().downcast_ref::<&str>().map(|s| s.to_string()).or_else(|| info.payload().downcast_ref::<String>().cloned()).unwrap_or_else(|| "?".into());
            *last.lock().unwrap() = format!("{msg} @ {loc}");
        }));
    }

    let mut fails: BTreeMap<String, (usize, String)> = BTreeMap::new();
    let mut run = |ctx: String, f: &mut dyn FnMut()| {
        *cur.lock().unwrap() = true;
        let r = catch_unwind(AssertUnwindSafe(|| f()));
        *cur.lock().unwrap() = false;
        if r.is_err() {
            let what = last.lock().unwrap().clone();
            fails.entry(what).or_insert_with(|| (0, ctx)).0 += 1;
        }
    };

    let mut rng = Rng(seed);
    let mut parsed_ok = 0usize;
    let mut scene = Scene::new();
    for i in 0..n {
        // Teile-Update: gültig verdorben, ab und zu reiner Zufallstext.
        let text = if rng.below(12) == 0 {
            let junk: Vec<u8> = (0..rng.below(60)).map(|_| rng.next() as u8).collect();
            String::from_utf8_lossy(&junk).into_owned()
        } else {
            let mut v = seed_update();
            let mut budget = 1 + rng.below(4) as u32;
            mutate(&mut v, &mut rng, &mut budget);
            v.to_string()
        };
        let plane_pt = [rng.f32(), rng.f32(), rng.f32()];
        let plane_n = [rng.f32(), rng.f32(), rng.f32()];
        let fresh = rng.below(3) == 0;
        run(format!("Teile-Update/Ketten (Aufruf {i}, Seed {seed}): {text}"), &mut || {
            let Ok(upd) = serde_json::from_str::<PartsUpdate>(&text) else { return };
            parsed_ok += 1;
            if fresh {
                scene = Scene::new();
            }
            let change = scene.apply(upd);
            let _ = scene.bounds();
            let _ = scene.shadow_bounds();
            let _ = scene.terrain();
            let _ = scene.has_edges();
            let _ = scene.edge_adj().count();
            for c in 0..scene.chunk_count() {
                let _ = scene.chunk_data(c);
            }
            let _ = change.dirty_chunks.len();
            let (walls, slabs, roofs) = scene.collect_inputs();
            let plane = SectionPlane::new(plane_pt, plane_n);
            let _ = cut_section(&plane, &walls, &slabs, &roofs);
        });
    }
    let _ = std::panic::take_hook();
    assert!(parsed_ok > (n / 4) as usize, "zu wenige lesbare Updates ({parsed_ok}) — Ausgangspunkt prüfen");
    if !fails.is_empty() {
        let mut s = format!("{} verschiedene Panics in render3d:\n", fails.len());
        for (k, (c, ctx)) in &fails {
            s += &format!("  {c}x {k}\n      erstmals bei: {}\n", &ctx[..ctx.len().min(1500)]);
        }
        panic!("{s}");
    }
}
