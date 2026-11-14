//! [258] Robustheit der Eingänge von render2d (`web.rs`: `set_scene_bin`, `add_font`, Textzeilen): die GPU-freien
//! Leser und die Tessellierung dürfen auf kaputten Bytes nie paniken — ein Panic legt im Browser das ganze WASM-Modul
//! lahm. Native (Standard-Features, ohne GPU): `decode_scene` auf abgeschnittenen/verdorbenen/zufälligen Szenen
//! (Ausgangspunkt: `tests/fixtures/scene_v1.bin`), bei Erfolg `compile_scene`; `text_lines`, `woff2::to_sfnt`,
//! Zerlegung und Strichphase mit NaN/∞/Zufall. Fester Seed, eigener PRNG, jeder Aufruf unter `catch_unwind`.
//! `ROBUST_N` (Aufrufe je Fall, Standard 400), `ROBUST_SEED`.

use render2d::scene_bin::decode_scene;
use render2d::tessellate::{arc_screen_params, compile_scene, dash_phase, prepare_arc_dash, triangulate};
use render2d::text_lines::{lines_from_bytes, lines_from_f64};
use render2d::types::Point;
use render2d::woff2::to_sfnt;
use std::collections::BTreeMap;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::{Arc, Mutex};

const FIXTURE: &[u8] = include_bytes!("fixtures/scene_v1.bin");

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
    fn f64(&mut self) -> f64 {
        const POOL: [f64; 12] = [0.0, -0.0, 1.0, -1.0, 1e-9, 1e9, 1e300, -1e300, f64::NAN, f64::INFINITY, f64::NEG_INFINITY, 3.0];
        match self.below(4) {
            0 => POOL[self.below(POOL.len())],
            1 => f64::from_bits(self.next()),
            2 => self.below(10) as f64,
            _ => (self.next() >> 11) as f64 / (1u64 << 53) as f64 * 100.0 - 50.0,
        }
    }
    fn f32(&mut self) -> f32 {
        self.f64() as f32
    }
    fn point(&mut self) -> Point {
        [self.f32(), self.f32()]
    }
    fn bytes(&mut self, max: usize) -> Vec<u8> {
        let n = self.below(max + 1);
        (0..n).map(|_| self.next() as u8).collect()
    }
    /// Gültige Szene, dann: abschneiden, Bytes verdorben, Zähler-Felder auf Randwerte, Anhang.
    fn scene_bytes(&mut self) -> Vec<u8> {
        let mut v = FIXTURE.to_vec();
        match self.below(6) {
            0 => v.truncate(self.below(v.len() + 1)),
            1 => {
                for _ in 0..1 + self.below(4) {
                    let i = self.below(v.len());
                    v[i] = self.next() as u8;
                }
            }
            2 => {
                // 4-Byte-Wort (Zähler/Länge/Gleitkommazahl) auf Randwert.
                let words: [[u8; 4]; 7] = [[0xff; 4], [0; 4], [0xff, 0xff, 0xff, 0x7f], [0, 0, 0, 0x80], [0, 0, 0xc0, 0x7f], [0, 0, 0x80, 0x7f], [1, 0, 0, 0]];
                for _ in 0..1 + self.below(3) {
                    let i = self.below(v.len().saturating_sub(3));
                    let w = words[self.below(words.len())];
                    v[i..i + 4].copy_from_slice(&w);
                }
            }
            3 => {
                let extra = self.bytes(40);
                v.extend(extra);
            }
            4 => v = self.bytes(200),
            _ => {
                // Kopf behalten, Rest zufällig.
                let keep = self.below(v.len().min(48) + 1);
                v.truncate(keep);
                let tail = self.bytes(120);
                v.extend(tail);
            }
        }
        v
    }
}

#[derive(Default)]
struct Fails(BTreeMap<String, (usize, String)>);

fn check(fails: &mut Fails, cur: &Arc<Mutex<bool>>, last: &Arc<Mutex<String>>, ctx: &str, f: impl FnOnce()) {
    *cur.lock().unwrap() = true;
    let r = catch_unwind(AssertUnwindSafe(f));
    *cur.lock().unwrap() = false;
    if r.is_err() {
        let what = last.lock().unwrap().clone();
        let e = fails.0.entry(what).or_insert_with(|| (0, ctx.to_string()));
        e.0 += 1;
    }
}

#[test]
fn render2d_eingaenge_kaputte_daten() {
    let n: u64 = std::env::var("ROBUST_N").ok().and_then(|v| v.parse().ok()).unwrap_or(400);
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

    let mut fails = Fails::default();
    let mut rng = Rng(seed);
    let mut decoded_ok = 0usize;
    for i in 0..n {
        // 1. Szene lesen (und bei Erfolg tessellieren).
        let bytes = rng.scene_bytes();
        let mut ok = false;
        check(&mut fails, &cur, &last, &format!("decode_scene/compile_scene (Aufruf {i}, Seed {seed})"), || {
            if let Ok(scene) = decode_scene(&bytes) {
                ok = true;
                let _ = compile_scene(&scene);
            }
        });
        decoded_ok += ok as usize;

        // 2. Textzeilen (f64-Puffer der Kern-Bindung und Bytes).
        let nf = rng.below(60);
        let f: Vec<f64> = (0..nf).map(|_| if rng.below(3) == 0 { rng.below(5) as f64 } else { rng.f64() }).collect();
        check(&mut fails, &cur, &last, &format!("lines_from_f64 (Aufruf {i})"), || {
            let _ = lines_from_f64(&f);
        });
        let tb = rng.bytes(300);
        check(&mut fails, &cur, &last, &format!("lines_from_bytes (Aufruf {i})"), || {
            let _ = lines_from_bytes(&tb);
        });

        // 3. Schriftdateien: WOFF2-/SFNT-Köpfe mit Zufall.
        let mut font = rng.bytes(400);
        let head: &[u8] = match rng.below(4) {
            0 => b"wOF2",
            1 => &[0, 1, 0, 0],
            _ => &[],
        };
        font.splice(0..0, head.iter().copied());
        check(&mut fails, &cur, &last, &format!("woff2::to_sfnt (Aufruf {i})"), || {
            let _ = to_sfnt(&font);
        });

        // 4. Zerlegung, Bögen, Strichmuster mit Unsinn.
        let pts: Vec<Point> = (0..rng.below(14)).map(|_| rng.point()).collect();
        check(&mut fails, &cur, &last, &format!("triangulate (Aufruf {i})"), || {
            let _ = triangulate(&pts);
        });
        let (c, a, b, r) = (rng.point(), rng.point(), rng.point(), rng.f32());
        check(&mut fails, &cur, &last, &format!("arc_screen_params (Aufruf {i})"), || {
            let _ = arc_screen_params(c, a, b, r);
        });
        let cyc: Vec<f32> = (0..rng.below(8)).map(|_| rng.f32()).collect();
        // (`dash_coverage` ist ein CPU-Spiegel des Shaders nur für Tests, mit `clamp` auf dem Segment: nicht Teil der Eingänge.)
        let len = rng.f32();
        check(&mut fails, &cur, &last, &format!("Strichmuster (Aufruf {i})"), || {
            let _ = dash_phase(len, &cyc);
            let _ = prepare_arc_dash(Some(&cyc));
            let _ = prepare_arc_dash(None);
        });
    }
    let _ = std::panic::take_hook();
    assert!(decoded_ok > 0, "der Fuzz erreicht nie eine lesbare Szene — Ausgangspunkt prüfen");
    if !fails.0.is_empty() {
        let mut s = format!("{} verschiedene Panics in render2d:\n", fails.0.len());
        for (k, (c, ctx)) in &fails.0 {
            s += &format!("  {c}x {k}\n      erstmals bei: {ctx}\n");
        }
        panic!("{s}");
    }
}
