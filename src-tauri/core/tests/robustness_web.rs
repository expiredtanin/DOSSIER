//! [258] Robustheit der WASM-Bindungen (`src/web/*.rs`, Feature "web"): jede `#[wasm_bindgen]`-Funktion wird
//! nativ mit kaputten Eingaben aufgerufen (leere/abgeschnittene Flat-Puffer, falsche Zähler, NaN/Inf/±1e300,
//! Zufallsbits, ungültiges JSON, falsche ids/Handles). Erwartung: leeres Ergebnis oder Fehler, nie Panic —
//! ein Panic legt im Browser das ganze WASM-Modul lahm. Deterministisch (fester Seed, eigener PRNG),
//! jeder Aufruf unter `catch_unwind`, alle Panics gesammelt gemeldet.
//!
//! Lauf: `cargo test --release --features web --test robustness_web`.
//! `ROBUST_WEB_N` (Aufrufe je Funktion, Standard 60), `ROBUST_WEB_SEED`, `ROBUST_WEB_ONLY=<Teilname>`,
//! `ROBUST_WEB_TRACE=1` (jeden Aufruf melden). Die Liste `CALLS` bildet jede Bindung ab;
//! `jede_bindung_ist_abgedeckt` prüft sie gegen die Quellen.
#![cfg(feature = "web")]

use dossier_core::web;
use std::cell::Cell;
use std::collections::BTreeMap;
use std::panic::{catch_unwind, AssertUnwindSafe};

const FIXTURE: &str = include_str!("fixtures/robust/beispiel.json");

thread_local! {
    static HANDLE: Cell<u32> = const { Cell::new(0) };
    /// Von Hand (`ROBUST_WEB_DUMP=<Teilname>#<Aufruf>`): die erzeugten Puffer/Texte des Aufrufs vor dem Aufruf ausgeben.
    static DUMP: Cell<bool> = const { Cell::new(false) };
    static LAST: std::cell::RefCell<String> = const { std::cell::RefCell::new(String::new()) };
}

pub struct Rng(u64);

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
    fn unit(&mut self) -> f64 {
        (self.next() >> 11) as f64 / (1u64 << 53) as f64
    }

    /// Einzelne Zahl: Randwerte, kleine Werte, Zufallsbits.
    fn f64(&mut self) -> f64 {
        let v = self.f64_inner();
        if DUMP.with(|d| d.get()) {
            eprintln!("ARG f64 {v:?}");
        }
        v
    }

    fn f64_inner(&mut self) -> f64 {
        const POOL: [f64; 18] = [0.0, -0.0, 1.0, -1.0, 0.5, 1e-9, -1e-9, 1e9, -1e9, 1e300, -1e300, f64::NAN, f64::INFINITY, f64::NEG_INFINITY, f64::MAX, f64::MIN_POSITIVE, 3.0, 2.0];
        match self.below(4) {
            0 => POOL[self.below(POOL.len())],
            1 => f64::from_bits(self.next()),
            2 => self.below(10) as f64,
            _ => (self.unit() - 0.5) * 100.0,
        }
    }

    pub fn id(&mut self) -> u32 {
        match self.below(6) {
            0 => 0,
            1 => u32::MAX,
            2 => self.below(5) as u32,
            _ => HANDLE.with(|h| h.get()),
        }
    }

    fn u32s(&mut self) -> Vec<u32> {
        (0..self.below(12)).map(|_| if self.below(3) == 0 { u32::MAX } else { self.below(40) as u32 }).collect()
    }

    fn bytes(&mut self) -> Vec<u8> {
        let n = if self.below(4) == 0 { 0 } else { self.below(300) };
        let mut v: Vec<u8> = (0..n).map(|_| self.next() as u8).collect();
        // Manchmal ein Kopf, der echten Formaten ähnelt (PNG/ZIP/gzip/PDF/DXF/JSON).
        if !v.is_empty() && self.below(3) == 0 {
            let heads: [&[u8]; 6] = [b"\x89PNG\r\n\x1a\n", b"PK\x03\x04", b"\x1f\x8b\x08", b"%PDF-1.", b"  0\nSECTION\n", b"{\"a\":"];
            let h = heads[self.below(heads.len())];
            for (i, b) in h.iter().enumerate() {
                if i < v.len() {
                    v[i] = *b;
                }
            }
        }
        v
    }

    fn opt_text(&mut self) -> Option<String> {
        if self.below(2) == 0 { None } else { Some(self.text()) }
    }

    /// Text: leer, kaputtes/fremdes JSON, Zufallsbytes, das Beispielprojekt (ganz/abgeschnitten/verdorben).
    fn text(&mut self) -> String {
        let t = self.text_inner();
        if DUMP.with(|d| d.get()) {
            eprintln!("ARG text {:?}", &t[..t.len().min(300)]);
        }
        t
    }

    fn text_inner(&mut self) -> String {
        const POOL: [&str; 26] = [
            "", " ", "{", "}", "[", "null", "[]", "{}", "0", "-1", "1e999", "NaN", "\"", "\u{0}", "\u{feff}{}",
            "{\"id\":\"x\"}", "{\"id\":\"\",\"type\":\"wall\"}", "[{\"id\":\"a\"},{\"id\":\"a\"}]", "{\"floors\":[],\"walls\":[]}",
            "{\"floors\":null}", "[1,2,3]", "{\"ops\":[{\"op\":\"remove\",\"id\":\"nix\"}]}", "[{\"op\":\"set\",\"id\":\"w1\",\"patch\":{\"thickness\":1e300}}]",
            "{\"kind\":\"wall\",\"points\":[[0,0],[1e300,1e300]]}", "{\"x\":null,\"y\":\"a\"}", "[[0,0],[1,1],[null,2]]",
        ];
        match self.below(8) {
            0 => String::new(),
            1..=3 => POOL[self.below(POOL.len())].to_string(),
            4 => {
                let n = self.below(80);
                let b: Vec<u8> = (0..n).map(|_| self.next() as u8).collect();
                String::from_utf8_lossy(&b).into_owned()
            }
            5 => FIXTURE.to_string(),
            6 => {
                let mut c = self.below(FIXTURE.len());
                while !FIXTURE.is_char_boundary(c) {
                    c -= 1;
                }
                FIXTURE[..c].to_string()
            }
            _ => {
                // Beispielprojekt, an Zufallsstellen durch Unsinn ersetzt.
                let mut s = FIXTURE.to_string();
                for _ in 0..1 + self.below(4) {
                    let mut p = self.below(s.len());
                    while !s.is_char_boundary(p) {
                        p -= 1;
                    }
                    let mut e = (p + 1 + self.below(6)).min(s.len());
                    while !s.is_char_boundary(e) {
                        e += 1;
                    }
                    s.replace_range(p..e, ["null", "-1", "1e300", "\"x\"", "[]", "{}", "NaN"][self.below(7)]);
                }
                s
            }
        }
    }

    /// Flat-Puffer: leer, gültig kodierte Polygone (dann verdorben), falsche Zähler, NaN/Inf, Zufallsbits, Zufallszahlen.
    fn buf(&mut self) -> Vec<f64> {
        let v = self.buf_inner();
        if DUMP.with(|d| d.get()) {
            eprintln!("ARG buf {v:?}");
        }
        v
    }

    fn buf_inner(&mut self) -> Vec<f64> {
        match self.below(8) {
            0 => vec![],
            1 => (0..self.below(40)).map(|_| self.f64()).collect(),
            2 => (0..self.below(40)).map(|_| f64::from_bits(self.next())).collect(),
            // Kleine ganze Zahlen treffen Zählerfelder oft plausibel.
            3 => (0..self.below(60)).map(|_| self.below(6) as f64).collect(),
            _ => {
                let mut v = self.valid_flat();
                match self.below(6) {
                    0 => {
                        let keep = self.below(v.len() + 1);
                        v.truncate(keep);
                    }
                    1 => {
                        if !v.is_empty() {
                            let i = self.below(v.len().min(4));
                            v[i] = [-1.0, 1e9, 1e18, f64::NAN, f64::INFINITY, 0.5, 4294967296.0][self.below(7)];
                        }
                    }
                    2 => {
                        for _ in 0..1 + self.below(3) {
                            if !v.is_empty() {
                                let i = self.below(v.len());
                                v[i] = self.f64();
                            }
                        }
                    }
                    3 => {
                        let extra: Vec<f64> = (0..self.below(10)).map(|_| self.f64()).collect();
                        v.extend(extra);
                    }
                    4 => {
                        if !v.is_empty() {
                            let i = self.below(v.len());
                            v[i] = f64::from_bits(self.next());
                        }
                    }
                    _ => {}
                }
                v
            }
        }
    }

    /// Gültige Kodierung `[n_polys, (n_rings, (n_pts, x, y …))]` mit zufälligen Ringen.
    fn valid_flat(&mut self) -> Vec<f64> {
        let mut v = vec![];
        let np = self.below(3);
        v.push(np as f64);
        for _ in 0..np {
            let nr = 1 + self.below(2);
            v.push(nr as f64);
            for _ in 0..nr {
                let n = self.below(8);
                v.push(n as f64);
                for _ in 0..n {
                    v.push(self.unit() * 10.0);
                    v.push(self.unit() * 10.0);
                }
            }
        }
        v
    }
}

// GENERIERT aus den `#[wasm_bindgen]`-Einstiegen in `src/web/*.rs`: je Zeile Modul::Name, Argumente nach Typ.
// Neue Einstiege von Hand ergänzen; `jede_bindung_ist_abgedeckt` schlägt sonst fehl.
type Call = (&'static str, fn(&mut Rng));
const CALLS: &[Call] = &[
    ("area_report::area_report_csv", |r: &mut Rng| { let a0 = r.text(); let a1 = r.text(); let _ = web::area_report::area_report_csv(&a0, &a1); }),
    ("area_report::area_report_parse_csv", |r: &mut Rng| { let a0 = r.text(); let a1 = r.text(); let _ = web::area_report::area_report_parse_csv(&a0, &a1); }),
    ("area_report::area_report_layout", |r: &mut Rng| { let a0 = r.text(); let a1 = r.text(); let _ = web::area_report::area_report_layout(&a0, &a1); }),
    ("area_report::area_report_svg", |r: &mut Rng| { let a0 = r.text(); let a1 = r.id(); let a2 = r.text(); let _ = web::area_report::area_report_svg(&a0, a1, &a2); }),
    ("bulge::bulge_arc", |r: &mut Rng| { let a0 = r.f64(); let a1 = r.f64(); let a2 = r.f64(); let a3 = r.f64(); let a4 = r.f64(); let _ = web::bulge::bulge_arc(a0, a1, a2, a3, a4); }),
    ("bulge::bulge_arc_points", |r: &mut Rng| { let a0 = r.f64(); let a1 = r.f64(); let a2 = r.f64(); let a3 = r.f64(); let a4 = r.f64(); let _ = web::bulge::bulge_arc_points(a0, a1, a2, a3, a4); }),
    ("bulge::bulge_polyline_points", |r: &mut Rng| { let a0 = r.buf(); let a1 = r.buf(); let a2 = r.below(2) == 1; let _ = web::bulge::bulge_polyline_points(&a0, &a1, a2); }),
    ("bulge::bulge_from_sagitta_point", |r: &mut Rng| { let a0 = r.f64(); let a1 = r.f64(); let a2 = r.f64(); let a3 = r.f64(); let a4 = r.f64(); let a5 = r.f64(); let _ = web::bulge::bulge_from_sagitta_point(a0, a1, a2, a3, a4, a5); }),
    ("bulge::bulge_point_at", |r: &mut Rng| { let a0 = r.f64(); let a1 = r.f64(); let a2 = r.f64(); let a3 = r.f64(); let a4 = r.f64(); let a5 = r.f64(); let _ = web::bulge::bulge_point_at(a0, a1, a2, a3, a4, a5); }),
    ("bulge::wall_arc_band", |r: &mut Rng| { let a0 = r.f64(); let a1 = r.f64(); let a2 = r.f64(); let a3 = r.f64(); let a4 = r.f64(); let a5 = r.f64(); let _ = web::bulge::wall_arc_band(a0, a1, a2, a3, a4, a5); }),
    ("clash_broad::clash_candidate_pairs", |r: &mut Rng| { let a0 = r.buf(); let _ = web::clash_broad::clash_candidate_pairs(&a0); }),
    ("cmd_create::doc_create_preview", |r: &mut Rng| { let a0 = r.id(); let a1 = r.text(); let a2 = r.buf(); let _ = web::cmd_create::doc_create_preview(a0, &a1, &a2); }),
    ("cmd_create::doc_create_preview_again", |r: &mut Rng| { let a0 = r.id(); let a1 = r.buf(); let _ = web::cmd_create::doc_create_preview_again(a0, &a1); }),
    ("cmd_create::doc_create_query", |r: &mut Rng| { let a0 = r.id(); let a1 = r.text(); let _ = web::cmd_create::doc_create_query(a0, &a1); }),
    ("cmd_create::extruded_solid_spec_json", |r: &mut Rng| { let a0 = r.text(); let a1 = r.f64(); let _ = web::cmd_create::extruded_solid_spec_json(&a0, a1); }),
    ("cmd_create::terrain_from_contours_json", |r: &mut Rng| { let a0 = r.text(); let a1 = r.text(); let _ = web::cmd_create::terrain_from_contours_json(&a0, &a1); }),
    ("cmd_create::terrain_from_contours_opts_json", |r: &mut Rng| { let a0 = r.text(); let a1 = r.text(); let a2 = r.f64(); let a3 = r.f64(); let a4 = r.f64(); let _ = web::cmd_create::terrain_from_contours_opts_json(&a0, &a1, a2, a3, a4); }),
    ("cmd_create::terrain_resmooth_grid", |r: &mut Rng| { let a0 = r.buf(); let a1 = r.f64(); let _ = web::cmd_create::terrain_resmooth_grid(&a0, a1); }),
    ("cmd_create::terrain_smooth_grid", |r: &mut Rng| { let a0 = r.buf(); let a1 = r.f64(); let a2 = r.f64(); let a3 = r.f64(); let _ = web::cmd_create::terrain_smooth_grid(&a0, a1, a2, a3); }),
    ("commands::doc_cmd_commit", |r: &mut Rng| { let a0 = r.id(); let a1 = r.text(); let a2 = r.text(); let a3 = r.f64(); let _ = web::commands::doc_cmd_commit(a0, &a1, &a2, a3); }),
    ("commands::doc_cmd_preview", |r: &mut Rng| { let a0 = r.id(); let a1 = r.text(); let _ = web::commands::doc_cmd_preview(a0, &a1); }),
    ("commands::doc_cmd_query", |r: &mut Rng| { let a0 = r.id(); let a1 = r.text(); let _ = web::commands::doc_cmd_query(a0, &a1); }),
    ("curves::curves_bezier_chain_flat", |r: &mut Rng| { let a0 = r.buf(); let a1 = r.f64(); let _ = web::curves::curves_bezier_chain_flat(&a0, a1); }),
    ("curves::curves_catmull_rom_flat", |r: &mut Rng| { let a0 = r.buf(); let a1 = r.below(2) == 1; let a2 = r.f64(); let _ = web::curves::curves_catmull_rom_flat(&a0, a1, a2); }),
    ("curves::curves_uniform_bspline_flat", |r: &mut Rng| { let a0 = r.buf(); let a1 = r.below(2) == 1; let a2 = r.f64(); let _ = web::curves::curves_uniform_bspline_flat(&a0, a1, a2); }),
    ("delaunay::delaunay_flat", |r: &mut Rng| { let a0 = r.buf(); let _ = web::delaunay::delaunay_flat(&a0); }),
    ("document::doc_open", |r: &mut Rng| { let a0 = r.text(); let _ = web::document::doc_open(&a0); }),
    ("document::doc_load_file", |r: &mut Rng| { let a0 = r.id(); let a1 = r.text(); let a2 = r.f64(); let _ = web::document::doc_load_file(a0, &a1, a2); }),
    ("document::doc_load_json", |r: &mut Rng| { let a0 = r.id(); let a1 = r.text(); let _ = web::document::doc_load_json(a0, &a1); }),
    ("document::doc_close", |r: &mut Rng| { let a0 = r.id(); let _ = web::document::doc_close(a0); }),
    ("document::doc_apply", |r: &mut Rng| { let a0 = r.id(); let a1 = r.text(); let _ = web::document::doc_apply(a0, &a1); }),
    ("document::doc_commit", |r: &mut Rng| { let a0 = r.id(); let a1 = r.text(); let a2 = r.text(); let a3 = r.f64(); let _ = web::document::doc_commit(a0, &a1, &a2, a3); }),
    ("document::doc_undo", |r: &mut Rng| { let a0 = r.id(); let _ = web::document::doc_undo(a0); }),
    ("document::doc_redo", |r: &mut Rng| { let a0 = r.id(); let _ = web::document::doc_redo(a0); }),
    ("document::doc_jump_quiet", |r: &mut Rng| { let a0 = r.id(); let a1 = r.below(2) == 1; let _ = web::document::doc_jump_quiet(a0, a1); }),
    ("document::doc_history_seq", |r: &mut Rng| { let a0 = r.id(); let _ = web::document::doc_history_seq(a0); }),
    ("document::doc_history_state", |r: &mut Rng| { let a0 = r.id(); let _ = web::document::doc_history_state(a0); }),
    ("document::doc_history_label", |r: &mut Rng| { let a0 = r.id(); let a1 = r.text(); let _ = web::document::doc_history_label(a0, &a1); }),
    ("document::doc_history_labels", |r: &mut Rng| { let a0 = r.id(); let _ = web::document::doc_history_labels(a0); }),
    ("document::doc_history_jump", |r: &mut Rng| { let a0 = r.id(); let a1 = r.id(); let _ = web::document::doc_history_jump(a0, a1); }),
    ("document::doc_history_clear", |r: &mut Rng| { let a0 = r.id(); let _ = web::document::doc_history_clear(a0); }),
    ("document::doc_history_limits", |r: &mut Rng| { let a0 = r.id(); let a1 = r.f64(); let a2 = r.f64(); let _ = web::document::doc_history_limits(a0, a1, a2); }),
    ("document::doc_history_index", |r: &mut Rng| { let a0 = r.id(); let _ = web::document::doc_history_index(a0); }),
    ("document::doc_history_step", |r: &mut Rng| { let a0 = r.id(); let a1 = r.f64(); let a2 = r.f64(); let _ = web::document::doc_history_step(a0, a1, a2); }),
    ("document::doc_history_import", |r: &mut Rng| { let a0 = r.id(); let a1 = r.text(); let _ = web::document::doc_history_import(a0, &a1); }),
    ("document::doc_group_begin", |r: &mut Rng| { let a0 = r.id(); let _ = web::document::doc_group_begin(a0); }),
    ("document::doc_group_begin_keyed", |r: &mut Rng| { let a0 = r.id(); let a1 = r.text(); let a2 = r.f64(); let _ = web::document::doc_group_begin_keyed(a0, &a1, a2); }),
    ("document::doc_group_end", |r: &mut Rng| { let a0 = r.id(); let _ = web::document::doc_group_end(a0); }),
    ("document::doc_json", |r: &mut Rng| { let a0 = r.id(); let _ = web::document::doc_json(a0); }),
    ("document::doc_query_args", |r: &mut Rng| { let a0 = r.id(); let a1 = r.text(); let a2 = r.buf(); let a3 = r.text(); let _ = web::document::doc_query_args(a0, &a1, &a2, &a3); }),
    ("document::doc_query_root", |r: &mut Rng| { let a0 = r.id(); let a1 = r.text(); let a2 = r.text(); let _ = web::document::doc_query_root(a0, &a1, &a2); }),
    ("document::doc_drawing_line_verts", |r: &mut Rng| { let a0 = r.id(); let a1 = r.f64(); let a2 = r.text(); let _ = web::document::doc_drawing_line_verts(a0, a1, &a2); }),
    ("document::doc_surface_pattern_lines", |r: &mut Rng| { let a0 = r.id(); let a1 = r.f64(); let a2 = r.text(); let _ = web::document::doc_surface_pattern_lines(a0, a1, &a2); }),
    ("document::doc_serialize", |r: &mut Rng| { let a0 = r.id(); let _ = web::document::doc_serialize(a0); }),
    ("document::doc_serialize_with_ui", |r: &mut Rng| { let a0 = r.id(); let a1 = r.text(); let _ = web::document::doc_serialize_with_ui(a0, &a1); }),
    ("document::doc_query_bin", |r: &mut Rng| { let a0 = r.id(); let a1 = r.text(); let a2 = r.buf(); let a3 = r.text(); let _ = web::document::doc_query_bin(a0, &a1, &a2, &a3); }),
    ("document::doc_last_extra", |r: &mut Rng| { let a0 = r.id(); let _ = web::document::doc_last_extra(a0); }),
    ("document::doc_last_hits", |r: &mut Rng| { let a0 = r.id(); let _ = web::document::doc_last_hits(a0); }),
    ("document::__debug_panic", |r: &mut Rng| { let a0 = r.id(); let _ = web::document::__debug_panic(a0); }),
    ("fonts::woff2_to_sfnt", |r: &mut Rng| { let a0 = r.bytes(); let _ = web::fonts::woff2_to_sfnt(&a0); }),
    ("competition::anonymity_findings", |r: &mut Rng| { let a0 = r.text(); let a1 = r.text(); let _ = web::competition::anonymity_findings(&a0, &a1); }),
    ("furniture_lib::furniture_lib_catalog_json", |_r: &mut Rng| { let _ = web::furniture_lib::furniture_lib_catalog_json(); }),
    ("furniture_lib::furniture_lib_geometry_json", |r: &mut Rng| { let a0 = r.text(); let a1 = r.text(); let a2 = r.text(); let a3 = r.id(); let _ = web::furniture_lib::furniture_lib_geometry_json(&a0, &a1, &a2, a3); }),
    ("geo_mesh::geo_mesh_clip", |r: &mut Rng| { let a0 = r.buf(); let a1 = r.buf(); let a2 = r.buf(); let _ = web::geo_mesh::geo_mesh_clip(&a0, &a1, &a2); }),
    ("geo_mesh::geo_mesh_strip_soffits", |r: &mut Rng| { let a0 = r.buf(); let a1 = r.buf(); let _ = web::geo_mesh::geo_mesh_strip_soffits(&a0, &a1); }),
    ("geo_mesh::geo_mesh_split", |r: &mut Rng| { let a0 = r.buf(); let a1 = r.buf(); let a2 = r.f64(); let _ = web::geo_mesh::geo_mesh_split(&a0, &a1, a2); }),
    ("geo_mesh::geo_extrude_footprints", |r: &mut Rng| { let a0 = r.buf(); let _ = web::geo_mesh::geo_extrude_footprints(&a0); }),
    ("gpu_compile::gpu_compile_flat", |r: &mut Rng| { let a0 = r.bytes(); let a1 = r.id(); let a2 = r.id(); let a3 = r.f64(); let a4 = r.below(2) == 1; let a5 = r.id(); let _ = web::gpu_compile::gpu_compile_flat(&a0, a1, a2, a3, a4, a5); }),
    ("gpu_compile::gpu_compile_held", |r: &mut Rng| { let a0 = r.id(); let a1 = r.id(); let a2 = r.id(); let a3 = r.f64(); let a4 = r.below(2) == 1; let a5 = r.id(); let _ = web::gpu_compile::gpu_compile_held(a0, a1, a2, a3, a4, a5); }),
    ("gpu_compile::triangulate_flat", |r: &mut Rng| { let a0 = r.buf(); let _ = web::gpu_compile::triangulate_flat(&a0); }),
    ("grip_drag::grip_polar", |r: &mut Rng| { let a0 = r.f64(); let a1 = r.f64(); let a2 = r.f64(); let a3 = r.f64(); let a4 = r.f64(); let a5 = r.f64(); let _ = web::grip_drag::grip_polar(a0, a1, a2, a3, a4, a5); }),
    ("grip_drag::grip_polar_point", |r: &mut Rng| { let a0 = r.f64(); let a1 = r.f64(); let a2 = r.f64(); let a3 = r.f64(); let a4 = r.f64(); let a5 = r.f64(); let _ = web::grip_drag::grip_polar_point(a0, a1, a2, a3, a4, a5); }),
    ("grip_drag::grip_arc_wall_target", |r: &mut Rng| { let a0 = r.f64(); let a1 = r.f64(); let a2 = r.f64(); let a3 = r.f64(); let a4 = r.f64(); let a5 = r.f64(); let a6 = r.f64(); let a7 = r.f64(); let a8 = r.f64(); let _ = web::grip_drag::grip_arc_wall_target(a0, a1, a2, a3, a4, a5, a6, a7, a8); }),
    ("grip_drag::grip_arc_wall_resize", |r: &mut Rng| { let a0 = r.f64(); let a1 = r.f64(); let a2 = r.f64(); let a3 = r.f64(); let a4 = r.f64(); let a5 = r.f64(); let a6 = r.f64(); let a7 = r.f64(); let a8 = r.f64(); let _ = web::grip_drag::grip_arc_wall_resize(a0, a1, a2, a3, a4, a5, a6, a7, a8); }),
    ("grip_drag::grip_arc_wall_radius", |r: &mut Rng| { let a0 = r.f64(); let a1 = r.f64(); let a2 = r.f64(); let a3 = r.f64(); let a4 = r.f64(); let a5 = r.below(2) == 1; let a6 = r.f64(); let a7 = r.f64(); let a8 = r.f64(); let _ = web::grip_drag::grip_arc_wall_radius(a0, a1, a2, a3, a4, a5, a6, a7, a8); }),
    ("grip_drag::grip_axis_lock", |r: &mut Rng| { let a0 = r.f64(); let a1 = r.f64(); let a2 = r.f64(); let a3 = r.f64(); let a4 = r.f64(); let a5 = r.f64(); let a6 = r.buf(); let a7 = r.f64(); let a8 = r.below(2) == 1; let _ = web::grip_drag::grip_axis_lock(a0, a1, a2, a3, a4, a5, &a6, a7, a8); }),
    ("grip_drag::grip_edge_target", |r: &mut Rng| { let a0 = r.f64(); let a1 = r.f64(); let a2 = r.f64(); let a3 = r.f64(); let a4 = r.below(2) == 1; let a5 = r.f64(); let a6 = r.f64(); let a7 = r.below(2) == 1; let a8 = r.f64(); let a9 = r.f64(); let a10 = r.below(2) == 1; let a11 = r.f64(); let a12 = r.f64(); let a13 = r.f64(); let _ = web::grip_drag::grip_edge_target(a0, a1, a2, a3, a4, a5, a6, a7, a8, a9, a10, a11, a12, a13); }),
    ("grip_drag::grip_sheet_height", |r: &mut Rng| { let a0 = r.id(); let a1 = r.f64(); let a2 = r.f64(); let a3 = r.f64(); let a4 = r.f64(); let a5 = r.below(2) == 1; let _ = web::grip_drag::grip_sheet_height(a0, a1, a2, a3, a4, a5); }),
    ("grip_drag::grip_contour_marks", |r: &mut Rng| { let a0 = r.buf(); let _ = web::grip_drag::grip_contour_marks(&a0); }),
    ("grip_drag::grip_snap_height", |r: &mut Rng| { let a0 = r.f64(); let a1 = r.buf(); let a2 = r.f64(); let _ = web::grip_drag::grip_snap_height(a0, &a1, a2); }),
    ("grip_drag::grip_opening_point", |r: &mut Rng| { let a0 = r.f64(); let a1 = r.f64(); let a2 = r.f64(); let a3 = r.f64(); let a4 = r.f64(); let a5 = r.f64(); let a6 = r.f64(); let _ = web::grip_drag::grip_opening_point(a0, a1, a2, a3, a4, a5, a6); }),
    ("grip_drag::grip_opening_slide_sheet", |r: &mut Rng| { let a0 = r.f64(); let a1 = r.f64(); let a2 = r.f64(); let a3 = r.f64(); let a4 = r.f64(); let a5 = r.f64(); let a6 = r.f64(); let a7 = r.f64(); let a8 = r.f64(); let a9 = r.f64(); let _ = web::grip_drag::grip_opening_slide_sheet(a0, a1, a2, a3, a4, a5, a6, a7, a8, a9); }),
    ("grip_drag::grip_clamp_inside", |r: &mut Rng| { let a0 = r.f64(); let a1 = r.f64(); let a2 = r.buf(); let _ = web::grip_drag::grip_clamp_inside(a0, a1, &a2); }),
    ("grip_drag::grip_stair_handle", |r: &mut Rng| { let a0 = r.below(2) == 1; let a1 = r.f64(); let a2 = r.f64(); let a3 = r.f64(); let a4 = r.f64(); let a5 = r.f64(); let a6 = r.f64(); let a7 = r.f64(); let _ = web::grip_drag::grip_stair_handle(a0, a1, a2, a3, a4, a5, a6, a7); }),
    ("grip_drag::grip_stair_param_points", |r: &mut Rng| { let a0 = r.buf(); let _ = web::grip_drag::grip_stair_param_points(&a0); }),
    ("grip_drag::grip_wall_points", |r: &mut Rng| { let a0 = r.f64(); let a1 = r.f64(); let a2 = r.f64(); let a3 = r.f64(); let a4 = r.f64(); let _ = web::grip_drag::grip_wall_points(a0, a1, a2, a3, a4); }),
    ("grip_drag::grip_excavation_points", |r: &mut Rng| { let a0 = r.buf(); let a1 = r.f64(); let _ = web::grip_drag::grip_excavation_points(&a0, a1); }),
    ("grip_drag::grip_coincident", |r: &mut Rng| { let a0 = r.buf(); let a1 = r.buf(); let _ = web::grip_drag::grip_coincident(&a0, &a1); }),
    ("grips::doc_grip_commit", |r: &mut Rng| { let a0 = r.id(); let a1 = r.text(); let a2 = r.text(); let a3 = r.f64(); let _ = web::grips::doc_grip_commit(a0, &a1, &a2, a3); }),
    ("grips::grip_vertices", |r: &mut Rng| { let a0 = r.text(); let a1 = r.f64(); let _ = web::grips::grip_vertices(&a0, a1); }),
    ("grips::camera_grip_points", |r: &mut Rng| { let a0 = r.text(); let a1 = r.f64(); let _ = web::grips::camera_grip_points(&a0, a1); }),
    ("grips::grip_vertices_polyline", |r: &mut Rng| { let a0 = r.buf(); let a1 = r.buf(); let a2 = r.below(2) == 1; let _ = web::grips::grip_vertices_polyline(&a0, &a1, a2); }),
    ("grips::edge_grips", |r: &mut Rng| { let a0 = r.buf(); let a1 = r.below(2) == 1; let a2 = r.buf(); let a3 = r.below(2) == 1; let _ = web::grips::edge_grips(&a0, a1, &a2, a3); }),
    ("grips::polyline_vertex_info", |r: &mut Rng| { let a0 = r.buf(); let a1 = r.buf(); let a2 = r.below(2) == 1; let a3 = r.f64(); let _ = web::grips::polyline_vertex_info(&a0, &a1, a2, a3); }),
    ("hatch::hatch_runs_flat", |r: &mut Rng| { let a0 = r.buf(); let a1 = r.buf(); let _ = web::hatch::hatch_runs_flat(&a0, &a1); }),
    ("hatch::random_hatch_runs_flat", |r: &mut Rng| { let a0 = r.buf(); let a1 = r.buf(); let a2 = r.f64(); let _ = web::hatch::random_hatch_runs_flat(&a0, &a1, a2); }),
    ("hatch::dash_runs_flat", |r: &mut Rng| { let a0 = r.buf(); let a1 = r.buf(); let _ = web::hatch::dash_runs_flat(&a0, &a1); }),
    ("hatch::zigzag_points_flat", |r: &mut Rng| { let a0 = r.f64(); let a1 = r.f64(); let a2 = r.f64(); let a3 = r.f64(); let a4 = r.f64(); let a5 = r.f64(); let _ = web::hatch::zigzag_points_flat(a0, a1, a2, a3, a4, a5); }),
    ("hatch::motif_points_flat", |r: &mut Rng| { let a0 = r.f64(); let a1 = r.f64(); let a2 = r.f64(); let a3 = r.f64(); let a4 = r.buf(); let a5 = r.f64(); let a6 = r.f64(); let _ = web::hatch::motif_points_flat(a0, a1, a2, a3, &a4, a5, a6); }),
    ("hatch::clip_line_to_polygon_flat", |r: &mut Rng| { let a0 = r.f64(); let a1 = r.f64(); let a2 = r.f64(); let a3 = r.f64(); let a4 = r.buf(); let _ = web::hatch::clip_line_to_polygon_flat(a0, a1, a2, a3, &a4); }),
    ("hatch::clip_segment_to_polygon_flat", |r: &mut Rng| { let a0 = r.f64(); let a1 = r.f64(); let a2 = r.f64(); let a3 = r.f64(); let a4 = r.buf(); let _ = web::hatch::clip_segment_to_polygon_flat(a0, a1, a2, a3, &a4); }),
    ("hatch::clip_polyline_to_polygon_flat", |r: &mut Rng| { let a0 = r.buf(); let a1 = r.buf(); let _ = web::hatch::clip_polyline_to_polygon_flat(&a0, &a1); }),
    ("hatch::hatch_line_family_flat", |r: &mut Rng| { let a0 = r.buf(); let a1 = r.f64(); let a2 = r.f64(); let a3 = r.f64(); let a4 = r.f64(); let a5 = r.f64(); let _ = web::hatch::hatch_line_family_flat(&a0, a1, a2, a3, a4, a5); }),
    ("import::import_drawing_summary", |r: &mut Rng| { let a0 = r.buf(); let a1 = r.text(); let a2 = r.text(); let _ = web::import::import_drawing_summary(&a0, &a1, &a2); }),
    ("import::import_drawing_view", |r: &mut Rng| { let a0 = r.buf(); let a1 = r.text(); let a2 = r.text(); let a3 = r.f64(); let _ = web::import::import_drawing_view(&a0, &a1, &a2, a3); }),
    ("import::import_drawing_meshes", |r: &mut Rng| { let a0 = r.buf(); let a1 = r.text(); let a2 = r.text(); let a3 = r.f64(); let _ = web::import::import_drawing_meshes(&a0, &a1, &a2, a3); }),
    ("import::doc_import_drawing", |r: &mut Rng| { let a0 = r.id(); let a1 = r.buf(); let a2 = r.text(); let a3 = r.text(); let a4 = r.text(); let a5 = r.text(); let a6 = r.f64(); let _ = web::import::doc_import_drawing(a0, &a1, &a2, &a3, &a4, &a5, a6); }),
    ("import::doc_import_ifc", |r: &mut Rng| { let a0 = r.id(); let a1 = r.text(); let a2 = r.buf(); let a3 = r.u32s(); let a4 = r.buf(); let a5 = r.text(); let a6 = r.text(); let a7 = r.f64(); let _ = web::import::doc_import_ifc(a0, &a1, &a2, &a3, &a4, &a5, &a6, a7); }),
    ("import::mesh_import_report", |r: &mut Rng| { let a0 = r.buf(); let a1 = r.text(); let _ = web::import::mesh_import_report(&a0, &a1); }),
    ("import::doc_import_mesh", |r: &mut Rng| { let a0 = r.id(); let a1 = r.buf(); let a2 = r.text(); let a3 = r.text(); let a4 = r.text(); let a5 = r.f64(); let _ = web::import::doc_import_mesh(a0, &a1, &a2, &a3, &a4, a5); }),
    ("import::doc_import_step", |r: &mut Rng| { let a0 = r.id(); let a1 = r.buf(); let a2 = r.text(); let a3 = r.text(); let a4 = r.f64(); let _ = web::import::doc_import_step(a0, &a1, &a2, &a3, a4); }),
    ("import::pdf_page_info", |r: &mut Rng| { let a0 = r.buf(); let a1 = r.text(); let _ = web::import::pdf_page_info(&a0, &a1); }),
    ("kennzahlen::kz_solid_volume", |r: &mut Rng| { let a0 = r.buf(); let a1 = r.f64(); let a2 = r.f64(); let a3 = r.f64(); let _ = web::kennzahlen::kz_solid_volume(&a0, a1, a2, a3); }),
    ("kernel2d::k2_circle_circle_intersect", |r: &mut Rng| { let a0 = r.f64(); let a1 = r.f64(); let a2 = r.f64(); let a3 = r.f64(); let a4 = r.f64(); let a5 = r.f64(); let _ = web::kernel2d::k2_circle_circle_intersect(a0, a1, a2, a3, a4, a5); }),
    ("layers::layers_call", |r: &mut Rng| { let a0 = r.text(); let a1 = r.text(); let a2 = r.text(); let a3 = r.f64(); let _ = web::layers::layers_call(&a0, &a1, &a2, a3); }),
    ("layers::levels_recompute_elevations", |r: &mut Rng| { let a0 = r.text(); let _ = web::layers::levels_recompute_elevations(&a0); }),
    ("layout_model::layout_call", |r: &mut Rng| { let a0 = r.text(); let a1 = r.text(); let _ = web::layout_model::layout_call(&a0, &a1); }),
    ("line_pattern::line_dash_phase", |r: &mut Rng| { let a0 = r.f64(); let a1 = r.buf(); let _ = web::line_pattern::line_dash_phase(a0, &a1); }),
    ("line_pattern::line_dash_fit_closed", |r: &mut Rng| { let a0 = r.f64(); let a1 = r.buf(); let _ = web::line_pattern::line_dash_fit_closed(a0, &a1); }),
    ("line_pattern::plan_arc_path_d", |r: &mut Rng| { let a0 = r.buf(); let a1 = r.below(2) == 1; let a2 = r.f64(); let _ = web::line_pattern::plan_arc_path_d(&a0, a1, a2); }),
    ("opening_presets::opening_type_presets_json", |_r: &mut Rng| { let _ = web::opening_presets::opening_type_presets_json(); }),
    ("ops::ops_validate", |r: &mut Rng| { let a0 = r.text(); let a1 = r.text(); let a2 = r.text(); let _ = web::ops::ops_validate(&a0, &a1, &a2); }),
    ("ops::project_validate", |r: &mut Rng| { let a0 = r.text(); let _ = web::ops::project_validate(&a0); }),
    ("parametric_walls::parametric_call", |r: &mut Rng| { let a0 = r.text(); let a1 = r.text(); let _ = web::parametric_walls::parametric_call(&a0, &a1); }),
    ("pens::pens_call", |r: &mut Rng| { let a0 = r.text(); let a1 = r.text(); let _ = web::pens::pens_call(&a0, &a1); }),
    ("plan_buf::plan_buf_round_begin", |_r: &mut Rng| { let _ = web::plan_buf::plan_buf_round_begin(); }),
    ("plan_buf::plan_buf_round_end", |_r: &mut Rng| { let _ = web::plan_buf::plan_buf_round_end(); }),
    ("plan_buf::plan_buf_touch", |r: &mut Rng| { let a0 = r.id(); let _ = web::plan_buf::plan_buf_touch(a0); }),
    ("plan_buf::plan_buf_recode", |r: &mut Rng| { let a0 = r.bytes(); let _ = web::plan_buf::plan_buf_recode(&a0); }),
    ("plan_buf::plan_buf_hold", |r: &mut Rng| { let a0 = r.bytes(); let _ = web::plan_buf::plan_buf_hold(&a0); }),
    ("plan_buf::plan_buf_release", |r: &mut Rng| { let a0 = r.id(); let _ = web::plan_buf::plan_buf_release(a0); }),
    ("plan_buf::plan_buf_is_held", |r: &mut Rng| { let a0 = r.id(); let _ = web::plan_buf::plan_buf_is_held(a0); }),
    ("plan_dxf::plan_dxf_flat", |r: &mut Rng| { let a0 = r.id(); let a1 = r.buf(); let a2 = r.buf(); let a3 = r.text(); let a4 = r.text(); let _ = web::plan_dxf::plan_dxf_flat(a0, &a1, &a2, &a3, &a4); }),
    ("plan_pick::pick_index_build", |r: &mut Rng| { let a0 = r.buf(); let _ = web::plan_pick::pick_index_build(&a0); }),
    ("plan_pick::pick_index_release", |r: &mut Rng| { let a0 = r.id(); let _ = web::plan_pick::pick_index_release(a0); }),
    ("plan_pick::pick_nearest_segment", |r: &mut Rng| { let a0 = r.id(); let a1 = r.f64(); let a2 = r.f64(); let a3 = r.f64(); let _ = web::plan_pick::pick_nearest_segment(a0, a1, a2, a3); }),
    ("plan_pick::pick_segments_near", |r: &mut Rng| { let a0 = r.id(); let a1 = r.f64(); let a2 = r.f64(); let a3 = r.f64(); let _ = web::plan_pick::pick_segments_near(a0, a1, a2, a3); }),
    ("plan_pick::pick_polygons_at", |r: &mut Rng| { let a0 = r.id(); let a1 = r.f64(); let a2 = r.f64(); let a3 = r.id(); let _ = web::plan_pick::pick_polygons_at(a0, a1, a2, a3); }),
    ("plan_pick::pick_nearest_symbol_px", |r: &mut Rng| { let a0 = r.id(); let a1 = r.id(); let a2 = r.id(); let a3 = r.f64(); let a4 = r.f64(); let a5 = r.f64(); let a6 = r.f64(); let a7 = r.f64(); let a8 = r.f64(); let a9 = r.f64(); let a10 = r.f64(); let _ = web::plan_pick::pick_nearest_symbol_px(a0, a1, a2, a3, a4, a5, a6, a7, a8, a9, a10); }),
    ("plan_pick::pick_rings_near", |r: &mut Rng| { let a0 = r.id(); let a1 = r.f64(); let a2 = r.f64(); let a3 = r.f64(); let a4 = r.f64(); let _ = web::plan_pick::pick_rings_near(a0, a1, a2, a3, a4); }),
    ("plan_pick::pick_owned_by", |r: &mut Rng| { let a0 = r.id(); let a1 = r.id(); let a2 = r.text(); let _ = web::plan_pick::pick_owned_by(a0, a1, &a2); }),
    ("plan_pick::pick_drawing_text", |r: &mut Rng| { let a0 = r.id(); let a1 = r.f64(); let a2 = r.f64(); let _ = web::plan_pick::pick_drawing_text(a0, a1, a2); }),
    ("plan_pick::pick_drawing_image", |r: &mut Rng| { let a0 = r.id(); let a1 = r.f64(); let a2 = r.f64(); let _ = web::plan_pick::pick_drawing_image(a0, a1, a2); }),
    ("plan_pick::pick_drawing_kind", |r: &mut Rng| { let a0 = r.id(); let a1 = r.text(); let _ = web::plan_pick::pick_drawing_kind(a0, &a1); }),
    ("plan_pick::pick_marquee_polygons", |r: &mut Rng| { let a0 = r.id(); let a1 = r.id(); let a2 = r.buf(); let a3 = r.below(2) == 1; let _ = web::plan_pick::pick_marquee_polygons(a0, a1, &a2, a3); }),
    ("plan_pick::pick_marquee_drawings", |r: &mut Rng| { let a0 = r.id(); let a1 = r.buf(); let a2 = r.below(2) == 1; let a3 = r.text(); let _ = web::plan_pick::pick_marquee_drawings(a0, &a1, a2, &a3); }),
    ("plan_print_svg::plan_print_svg_ops", |r: &mut Rng| { let a0 = r.buf(); let a1 = r.buf(); let _ = web::plan_print_svg::plan_print_svg_ops(&a0, &a1); }),
    ("plan_scene::plan_scene_bin", |r: &mut Rng| { let a0 = r.buf(); let a1 = r.buf(); let a2 = r.f64(); let a3 = r.id(); let _ = web::plan_scene::plan_scene_bin(&a0, &a1, a2, a3); }),
    ("plan_scene::plan_scene_texts", |r: &mut Rng| { let a0 = r.buf(); let a1 = r.buf(); let a2 = r.f64(); let _ = web::plan_scene::plan_scene_texts(&a0, &a1, a2); }),
    ("plan_scene::plan_screen_texts", |r: &mut Rng| { let a0 = r.buf(); let a1 = r.buf(); let a2 = r.f64(); let a3 = r.f64(); let _ = web::plan_scene::plan_screen_texts(&a0, &a1, a2, a3); }),
    ("plan_scene::plan_scene_f64", |r: &mut Rng| { let a0 = r.buf(); let a1 = r.buf(); let _ = web::plan_scene::plan_scene_f64(&a0, &a1); }),
    ("plan_svg::plan_svg_string", |r: &mut Rng| { let a0 = r.buf(); let a1 = r.buf(); let _ = web::plan_svg::plan_svg_string(&a0, &a1); }),
    ("polygon::poly_union", |r: &mut Rng| { let a0 = r.buf(); let _ = web::polygon::poly_union(&a0); }),
    ("polygon::poly_difference", |r: &mut Rng| { let a0 = r.buf(); let a1 = r.buf(); let _ = web::polygon::poly_difference(&a0, &a1); }),
    ("polygon::poly_intersection", |r: &mut Rng| { let a0 = r.buf(); let a1 = r.buf(); let _ = web::polygon::poly_intersection(&a0, &a1); }),
    ("polygon_holes::polygon_merge_holes", |r: &mut Rng| { let a0 = r.buf(); let a1 = r.buf(); let a2 = r.f64(); let _ = web::polygon_holes::polygon_merge_holes(&a0, &a1, a2); }),
    ("project_format::project_format_version", |_r: &mut Rng| { let _ = web::project_format::project_format_version(); }),
    ("project_refs::project_warnings", |r: &mut Rng| { let a0 = r.text(); let _ = web::project_refs::project_warnings(&a0); }),
    ("reorder::reorder_call", |r: &mut Rng| { let a0 = r.text(); let a1 = r.text(); let a2 = r.text(); let _ = web::reorder::reorder_call(&a0, &a1, &a2); }),
    ("rich_text::rich_normalize", |r: &mut Rng| { let a0 = r.text(); let _ = web::rich_text::rich_normalize(&a0); }),
    ("rich_text::rich_apply_mark", |r: &mut Rng| { let a0 = r.text(); let a1 = r.f64(); let a2 = r.f64(); let a3 = r.text(); let a4 = r.text(); let _ = web::rich_text::rich_apply_mark(&a0, a1, a2, &a3, &a4); }),
    ("rich_text::rich_toggle_mark", |r: &mut Rng| { let a0 = r.text(); let a1 = r.f64(); let a2 = r.f64(); let a3 = r.text(); let _ = web::rich_text::rich_toggle_mark(&a0, a1, a2, &a3); }),
    ("rich_text::rich_is_mark_active", |r: &mut Rng| { let a0 = r.text(); let a1 = r.f64(); let a2 = r.f64(); let a3 = r.text(); let _ = web::rich_text::rich_is_mark_active(&a0, a1, a2, &a3); }),
    ("rich_text::rich_common_mark_value", |r: &mut Rng| { let a0 = r.text(); let a1 = r.f64(); let a2 = r.f64(); let a3 = r.text(); let _ = web::rich_text::rich_common_mark_value(&a0, a1, a2, &a3); }),
    ("rich_text::rich_serialize", |r: &mut Rng| { let a0 = r.text(); let _ = web::rich_text::rich_serialize(&a0); }),
    ("rich_text::rich_apply_preset", |r: &mut Rng| { let a0 = r.text(); let a1 = r.f64(); let a2 = r.f64(); let a3 = r.text(); let _ = web::rich_text::rich_apply_preset(&a0, a1, a2, &a3); }),
    ("roof::roof_geometry_flat", |r: &mut Rng| { let a0 = r.buf(); let a1 = r.f64(); let _ = web::roof::roof_geometry_flat(&a0, a1); }),
    ("roof::roof_underside_at", |r: &mut Rng| { let a0 = r.buf(); let a1 = r.f64(); let a2 = r.f64(); let a3 = r.f64(); let _ = web::roof::roof_underside_at(&a0, a1, a2, a3); }),
    ("room_area::room_evaluate", |r: &mut Rng| { let a0 = r.buf(); let a1 = r.f64(); let a2 = r.buf(); let _ = web::room_area::room_evaluate(&a0, a1, &a2); }),
    ("room_area::room_polygon_area", |r: &mut Rng| { let a0 = r.buf(); let _ = web::room_area::room_polygon_area(&a0); }),
    ("room_area::room_centroid", |r: &mut Rng| { let a0 = r.buf(); let _ = web::room_area::room_centroid(&a0); }),
    ("room_area::room_label_point", |r: &mut Rng| { let a0 = r.buf(); let _ = web::room_area::room_label_point(&a0); }),
    ("room_area::room_balance", |r: &mut Rng| { let a0 = r.buf(); let a1 = r.buf(); let _ = web::room_area::room_balance(&a0, &a1); }),
    ("room_area::room_sia_categories", |_r: &mut Rng| { let _ = web::room_area::room_sia_categories(); }),
    ("room_boundary::rooms_detect", |r: &mut Rng| { let a0 = r.buf(); let a1 = r.f64(); let a2 = r.f64(); let a3 = r.below(2) == 1; let _ = web::room_boundary::rooms_detect(&a0, a1, a2, a3); }),
    ("site_rules::site_multi_polygon_area", |r: &mut Rng| { let a0 = r.buf(); let _ = web::site_rules::site_multi_polygon_area(&a0); }),
    ("site_rules::site_allowed_area", |r: &mut Rng| { let a0 = r.buf(); let _ = web::site_rules::site_allowed_area(&a0); }),
    ("site_rules::doc_site_envelope", |r: &mut Rng| { let a0 = r.id(); let _ = web::site_rules::doc_site_envelope(a0); }),
    ("skeleton::straight_skeleton", |r: &mut Rng| { let a0 = r.buf(); let a1 = r.buf(); let a2 = r.f64(); let _ = web::skeleton::straight_skeleton(&a0, &a1, a2); }),
    ("snap::doc_snap_hold", |r: &mut Rng| { let a0 = r.id(); let a1 = r.text(); let a2 = r.text(); let a3 = r.text(); let a4 = r.f64(); let _ = web::snap::doc_snap_hold(a0, &a1, &a2, &a3, a4); }),
    ("snap::snap_query", |r: &mut Rng| { let a0 = r.id(); let a1 = r.buf(); let a2 = r.buf(); let a3 = r.f64(); let a4 = r.f64(); let a5 = r.f64(); let a6 = r.f64(); let a7 = r.id(); let a8 = r.f64(); let a9 = r.f64(); let _ = web::snap::snap_query(a0, &a1, &a2, a3, a4, a5, a6, a7, a8, a9); }),
    ("solid_bool::solid_boolean", |r: &mut Rng| { let a0 = r.f64(); let a1 = r.buf(); let a2 = r.buf(); let _ = web::solid_bool::solid_boolean(a0, &a1, &a2); }),
    ("stair::stair_outline_flat", |r: &mut Rng| { let a0 = r.buf(); let _ = web::stair::stair_outline_flat(&a0); }),
    ("sun::sun_position", |r: &mut Rng| { let a0 = r.f64(); let a1 = r.f64(); let a2 = r.f64(); let _ = web::sun::sun_position(a0, a1, a2); }),
    ("sun::sun_shadow_of_prism", |r: &mut Rng| { let a0 = r.buf(); let a1 = r.f64(); let a2 = r.f64(); let a3 = r.f64(); let a4 = r.f64(); let _ = web::sun::sun_shadow_of_prism(&a0, a1, a2, a3, a4); }),
    ("sun::sun_without_holes", |r: &mut Rng| { let a0 = r.buf(); let _ = web::sun::sun_without_holes(&a0); }),
    ("text_layout::text_lines", |r: &mut Rng| { let a0 = r.text(); let a1 = r.buf(); let a2 = r.opt_text(); let _ = web::text_layout::text_lines(&a0, &a1, a2); }),
    ("text_layout::text_frame", |r: &mut Rng| { let a0 = r.text(); let a1 = r.buf(); let _ = web::text_layout::text_frame(&a0, &a1); }),
    ("text_layout::text_stamp_block", |r: &mut Rng| { let a0 = r.text(); let a1 = r.f64(); let a2 = r.f64(); let a3 = r.f64(); let _ = web::text_layout::text_stamp_block(&a0, a1, a2, a3); }),
    ("text_layout::text_wrap_plain", |r: &mut Rng| { let a0 = r.text(); let a1 = r.f64(); let a2 = r.f64(); let _ = web::text_layout::text_wrap_plain(&a0, a1, a2); }),
    ("voids::voids_subtract_rings_flat", |r: &mut Rng| { let a0 = r.buf(); let a1 = r.buf(); let a2 = r.buf(); let _ = web::voids::voids_subtract_rings_flat(&a0, &a1, &a2); }),
    ("voids::wall_spec_flat", |r: &mut Rng| { let a0 = r.buf(); let _ = web::voids::wall_spec_flat(&a0); }),
];

// ── Lauf ─────────────────────────────────────────────────────────────────────

fn env_num(k: &str, default: u64) -> u64 {
    std::env::var(k).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}

/// Alle offenen Dokumente schliessen (der Fuzz öffnet laufend neue, `doc_open` mit dem Beispielprojekt) und das
/// Beispielprojekt frisch öffnen: Speicher bleibt klein, und die Aufrufe sehen wieder ein gültiges Handle.
fn reset_docs() {
    for h in 1..=64u32 {
        web::document::doc_close(h);
    }
    let h = web::document::doc_open(FIXTURE);
    assert!(h != 0, "Beispielprojekt muss sich öffnen lassen");
    HANDLE.with(|c| c.set(h));
}

#[test]
fn bindungen_kaputte_eingaben() {
    let n = env_num("ROBUST_WEB_N", 60);
    let seed = env_num("ROBUST_WEB_SEED", 0x5eed_258) | 1;
    let only = std::env::var("ROBUST_WEB_ONLY").ok();
    let trace = std::env::var("ROBUST_WEB_TRACE").is_ok();
    // Von Hand: `ROBUST_WEB_SKIP=a,b` überspringt Bindungen (Teilname), um nach einem Hang weiterzusuchen.
    let dump: Option<(String, u64)> = std::env::var("ROBUST_WEB_DUMP").ok().and_then(|v| v.split_once('#').and_then(|(a, b)| Some((a.to_string(), b.parse().ok()?))));
    let skip: Vec<String> = std::env::var("ROBUST_WEB_SKIP").map(|v| v.split(',').filter(|x| !x.is_empty()).map(String::from).collect()).unwrap_or_default();
    // Wächter: ein Aufruf über 30 s (Endlosschleife / Speicherflut) wird gemeldet und beendet den Lauf.
    let progress = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
    let label = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
    {
        let (progress, label) = (progress.clone(), label.clone());
        std::thread::spawn(move || {
            let mut seen = u64::MAX;
            let mut since = std::time::Instant::now();
            loop {
                std::thread::sleep(std::time::Duration::from_millis(250));
                let now = progress.load(std::sync::atomic::Ordering::Relaxed);
                if now != seen {
                    seen = now;
                    since = std::time::Instant::now();
                } else if now != 0 && since.elapsed().as_secs() >= 30 {
                    eprintln!("HANG (über 30 s): {}", label.lock().unwrap());
                    std::process::exit(3);
                }
            }
        });
    }
    let mut counter = 0u64;
    reset_docs();

    let default = std::panic::take_hook();
    let cur = std::sync::Arc::new(std::sync::Mutex::new(false));
    let cur2 = cur.clone();
    std::panic::set_hook(Box::new(move |info| {
        if !*cur2.lock().unwrap() {
            default(info);
            return;
        }
        let loc = info.location().map(|l| format!("{}:{}", l.file(), l.line())).unwrap_or_default();
        let msg = info.payload().downcast_ref::<&str>().map(|s| s.to_string()).or_else(|| info.payload().downcast_ref::<String>().cloned()).unwrap_or_else(|| "?".into());
        LAST.with(|l| *l.borrow_mut() = format!("{msg} @ {loc}"));
    }));

    // Panic-Text → (Anzahl, erste Bindung)
    let mut fails: BTreeMap<String, (usize, String)> = BTreeMap::new();
    for (idx, (name, call)) in CALLS.iter().enumerate() {
        // Löst absichtlich einen Panic aus (Test-Haken für den Wiederanlauf [118]) und lässt die Dokumenttabelle geborgt.
        if *name == "document::__debug_panic" {
            continue;
        }
        if only.as_ref().is_some_and(|o| !name.contains(o.as_str())) || skip.iter().any(|x| name.contains(x.as_str())) {
            continue;
        }
        let mut rng = Rng(seed ^ ((idx as u64 + 1).wrapping_mul(0x9E37_79B9_7F4A_7C15)));
        reset_docs();
        for i in 0..n {
            if i % 100 == 99 {
                reset_docs();
            }
            if trace {
                eprintln!("{name} #{i}");
            }
            DUMP.with(|d| d.set(dump.as_ref().is_some_and(|(nm, k)| name.contains(nm.as_str()) && *k == i)));
            counter += 1;
            *label.lock().unwrap() = format!("{name} (Aufruf {i}, Seed {seed})");
            progress.store(counter, std::sync::atomic::Ordering::Relaxed);
            *cur.lock().unwrap() = true;
            let r = catch_unwind(AssertUnwindSafe(|| call(&mut rng)));
            *cur.lock().unwrap() = false;
            progress.store(0, std::sync::atomic::Ordering::Relaxed);
            if r.is_err() {
                let what = LAST.with(|l| l.borrow().clone());
                let e = fails.entry(what).or_insert_with(|| (0, format!("{name} (Aufruf {i}, Seed {seed})")));
                e.0 += 1;
            }
        }
    }
    let _ = std::panic::take_hook();
    if !fails.is_empty() {
        let mut s = format!("{} verschiedene Panics in den Bindungen:\n", fails.len());
        for (k, (c, ctx)) in &fails {
            s += &format!("  {c}x {k}\n      erstmals bei: {ctx}\n");
        }
        panic!("{s}");
    }
}

/// Jede `#[wasm_bindgen]`-Funktion in `src/web/*.rs` muss in `CALLS` stehen.
#[test]
fn jede_bindung_ist_abgedeckt() {
    let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/src/web");
    let mut missing = vec![];
    let mut total = 0;
    for e in std::fs::read_dir(dir).unwrap() {
        let p = e.unwrap().path();
        let module = p.file_stem().unwrap().to_string_lossy().to_string();
        if module == "mod" || p.extension().is_none_or(|x| x != "rs") {
            continue;
        }
        let text = std::fs::read_to_string(&p).unwrap();
        let mut pending = false;
        for line in text.lines() {
            let t = line.trim();
            if t.starts_with("#[wasm_bindgen") && !t.starts_with("#[wasm_bindgen(start") {
                pending = true;
            } else if pending && t.starts_with("pub fn ") {
                pending = false;
                let name: String = t["pub fn ".len()..].chars().take_while(|c| c.is_alphanumeric() || *c == '_').collect();
                total += 1;
                let key = format!("{module}::{name}");
                if !CALLS.iter().any(|(n, _)| *n == key) {
                    missing.push(key);
                }
            }
        }
    }
    assert!(total > 100, "zu wenige Bindungen gefunden ({total})");
    assert!(missing.is_empty(), "Bindungen ohne Robustheits-Aufruf in CALLS: {missing:?}");
}

/// [258] Dachparameter aus dem Fuzzlauf, bei denen die Wellenfront des Skeletts in einen Rundungszyklus lief
/// (Ecken wuchsen unbegrenzt, Aufruf hing > 30 s): jetzt Obergrenze für Ecken -> Degeneration -> Rückfall.
#[test]
fn regression_roof_skeleton_rundungszyklus() {
    let params = [
        5.0, 1.0, 3.0, 3.0, 4.0, 3.0, 1.0, 5.0, 5.0, 2.0, 1.0, 1.0, 5.0, 1.0, 1.0, 1.0, 3.0, 2.0, 1.0, 2.0, 2.0, 3.0, 4.0, 1.0, 4.0, 2.0, 2.0, 3.0, 2.0, 1.0, 4.0, 1.0, 1.0, 2.0, 2.0, 1.0, 2.0,
        2.0, 2.0, 4.0, 3.0, 3.0,
    ];
    let t = std::time::Instant::now();
    let _ = web::roof::roof_geometry_flat(&params, -2.9986637881230873e-22);
    assert!(t.elapsed().as_secs() < 10, "Dachgeometrie hängt");
}
