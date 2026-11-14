//! [258] Robustheit: kein Kern-Panic im Referenz-Ablauf. Ein Panic im WASM-Kern legt das ganze Modul lahm
//! (Wiederanlauf [118] rettet nur den Stand), also muss jede Ableitung auf jedem Eingabestand ohne Panic
//! durchlaufen — auch auf Unsinn. Drei Läufe, alle deterministisch (fester Seed, eigener kleiner PRNG):
//!
//! 1. `beispielprojekte_alle_ableitungen`: jedes Beispielprojekt (`tests/fixtures/robust/*.json`, aus
//!    `dossier-cli :beispiel|:musterhaus-komplex|:wettbewerb|:gross migrate`) durch den Lader, dann alle
//!    Ableitungen (Grundrisse je Geschoss in mehreren Massstäben/Detailstufen samt SVG/Druck-SVG/DXF/Szene,
//!    Schnitt, Ansicht, 3D, Exporte, Kennzahlen, Baurecht, Griffe, Objekt-Info, Befehle).
//! 2. `mutationsrunde`: zufällige, aber gültige Ops (verschieben, löschen, duplizieren, Zahlen auf
//!    Randwerte, Undo/Redo); nach jedem Schritt werden die Ableitungen neu gerechnet.
//! 3. `kaputte_projektdateien`: abgeschnittenes JSON, falsche Typen, fehlende Felder, doppelte ids,
//!    Verweise ins Leere — Fehler oder Reparatur, nie Panic.
//!
//! Jeder Aufruf läuft unter `catch_unwind`; alle Fehlschläge werden gesammelt gemeldet (mit Ort des Panics).
//! `ROBUST_STEPS=n`, `ROBUST_SEED=n`, `ROBUST_ONLY=beispiel|wettbewerb|gross` (Mutationsrunde) ändern den Lauf für die Suche von
//! Hand; `ROBUST_TRACE=1` druckt jeden Schritt, `ROBUST_SLOW=s` Aufrufe über s Sekunden.

use dossier_core::document::Document;
use dossier_core::model::Project;
use dossier_core::ops::Op;
use dossier_core::plan::buf::View;
use dossier_core::plan::domains::{plan_domains_buf, PlanArgs};
use dossier_core::plan::parts::Part;
use serde_json::{json, Map, Value};
use std::cell::RefCell;
use std::collections::BTreeMap;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::Once;

const FIXTURES: [(&str, &str); 4] = [
    ("beispiel", include_str!("fixtures/robust/beispiel.json")),
    ("wettbewerb", include_str!("fixtures/robust/wettbewerb.json")),
    ("gross", include_str!("fixtures/robust/gross.json")),
    ("komplex", include_str!("fixtures/robust/komplex.json")),
];

// ── Panic-Sammler ────────────────────────────────────────────────────────────

thread_local! {
    static LAST: RefCell<String> = const { RefCell::new(String::new()) };
    static IN_RUN: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

fn install_hook() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        let default = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            // Ausserhalb von `Fails::run` (Zusicherungen des Tests selbst) bleibt die Meldung wie gewohnt.
            if !IN_RUN.with(|r| r.get()) {
                default(info);
                return;
            }
            let loc = info.location().map(|l| format!("{}:{}", l.file(), l.line())).unwrap_or_default();
            let msg = if let Some(s) = info.payload().downcast_ref::<&str>() {
                s.to_string()
            } else if let Some(s) = info.payload().downcast_ref::<String>() {
                s.clone()
            } else {
                "?".into()
            };
            LAST.with(|l| *l.borrow_mut() = format!("{msg} @ {loc}"));
        }));
    });
}

/// Gesammelte Fehlschläge: Schlüssel = Panic (Text + Ort), Wert = (Anzahl, erster Zusammenhang).
#[derive(Default)]
struct Fails(BTreeMap<String, (usize, String)>);

impl Fails {
    /// Führt `f` aus; bei Panic wird er mit `ctx` vermerkt und `None` geliefert.
    fn run<T>(&mut self, ctx: impl Fn() -> String, f: impl FnOnce() -> T) -> Option<T> {
        install_hook();
        let t0 = std::time::Instant::now();
        if std::env::var("ROBUST_TRACE").is_ok_and(|v| v == "2") {
            eprintln!("  > {}", ctx());
        }
        IN_RUN.with(|r| r.set(true));
        let r = catch_unwind(AssertUnwindSafe(f));
        IN_RUN.with(|r| r.set(false));
        if std::env::var("ROBUST_SLOW").ok().and_then(|v| v.parse::<f64>().ok()).is_some_and(|lim| t0.elapsed().as_secs_f64() > lim) {
            eprintln!("  langsam ({:.1} s): {}", t0.elapsed().as_secs_f64(), ctx());
        }
        match r {
            Ok(v) => Some(v),
            Err(_) => {
                let what = LAST.with(|l| l.borrow().clone());
                let e = self.0.entry(what).or_insert_with(|| (0, ctx()));
                e.0 += 1;
                None
            }
        }
    }

    fn report(&self, title: &str) -> String {
        let mut s = format!("{title}: {} verschiedene Panics\n", self.0.len());
        for (k, (n, ctx)) in &self.0 {
            s += &format!("  {n}x {k}\n      erstmals bei: {ctx}\n");
        }
        s
    }

    fn assert_empty(&self, title: &str) {
        assert!(self.0.is_empty(), "{}", self.report(title));
    }
}

// ── PRNG (xorshift64*) ───────────────────────────────────────────────────────

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    fn below(&mut self, n: usize) -> usize {
        if n == 0 {
            0
        } else {
            (self.next() % n as u64) as usize
        }
    }
    fn unit(&mut self) -> f64 {
        (self.next() >> 11) as f64 / (1u64 << 53) as f64
    }
}

fn env_num(k: &str, default: u64) -> u64 {
    std::env::var(k).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}

// ── Hilfen ───────────────────────────────────────────────────────────────────

fn open(text: &str) -> Result<Document, String> {
    let mut d = Document::default();
    d.load_file(text, 1.7e12)?;
    Ok(d)
}

/// Ids je Sammlung (nur Listen mit Objekten, die eine `id` tragen).
fn ids_of(root: &Map<String, Value>, key: &str) -> Vec<String> {
    root.get(key).and_then(Value::as_array).map(|a| a.iter().filter_map(|e| e.get("id").and_then(Value::as_str).map(String::from)).collect()).unwrap_or_default()
}

fn plan_text(p: &Project, floor: &str, scale: f64, extra: Value) -> String {
    let codes: Vec<String> = p.flat_categories().iter().map(|c| c.code.clone()).chain(p.drawings2d.iter().map(|d| d.category_code.clone())).collect();
    let mut t = json!({ "floor": floor, "show": codes, "grey": [], "global": true, "scale": scale });
    if let (Some(o), Some(e)) = (t.as_object_mut(), extra.as_object()) {
        for (k, v) in e {
            o.insert(k.clone(), v.clone());
        }
    }
    t.to_string()
}

fn parts_of(b: &[u8]) -> Option<Vec<Part<'_>>> {
    let view = View::parse(b)?;
    let n = view.len();
    Some(vec![Part::new(view, 0, n)?])
}

/// Alle Ausgaben eines Plan-Puffers: Szene, SVG (mit/ohne Schraffur), Druck-SVG, DXF.
fn outputs(fails: &mut Fails, tag: &str, p: &Project, b: &[u8], scale: f64, floor: &str) {
    let bounds = View::parse(b).and_then(|v| v.bounds()).filter(|bb| bb.iter().all(|x| x.is_finite())).unwrap_or([0.0, 0.0, 10.0, 10.0]);
    let [x0, y0, x1, y1] = bounds;
    for hatch in [false, true] {
        fails.run(|| format!("{tag} svg hatch={hatch}"), || {
            if let Some(mut parts) = parts_of(b) {
                let o = dossier_core::plan::svg::SvgOptions { scale_denominator: scale, margin_m: 0.5, min_x: x0, min_y: y0, max_x: x1, max_y: y1, hatch, line_ends: Default::default() };
                dossier_core::plan::svg::plan_svg(&mut parts, &o);
            }
        });
    }
    fails.run(|| format!("{tag} druck-svg"), || {
        if let Some(mut parts) = parts_of(b) {
            let o = dossier_core::plan::print_svg::PrintOptions { scale_denominator: scale, page_w: 841.0, page_h: 594.0, bounds };
            dossier_core::plan::print_svg::print_svg_ops(&mut parts, &o);
        }
    });
    fails.run(|| format!("{tag} szene"), || {
        if let Some(mut parts) = parts_of(b) {
            if let Some(s) = dossier_core::plan::scene::build_scene(&mut parts, &[]) {
                dossier_core::plan::scene::encode_scene_bin(&s, &[]);
            }
        }
    });
    fails.run(|| format!("{tag} texte"), || {
        if let Some(mut parts) = parts_of(b) {
            dossier_core::plan::text::scene_texts(&mut parts, &[], scale, None);
        }
    });
    for (hatches, layout) in [(false, false), (true, true)] {
        fails.run(|| format!("{tag} dxf hatch={hatches}"), || {
            if let Some(mut parts) = parts_of(b) {
                let o = dossier_core::plan::dxf::DxfOptions { scale, include_hatches: hatches, dim_cm: false, paper_layout: layout, bounds, default_font: "Arial".into(), floor: floor.into(), table_labels: String::new() };
                if let Some(f) = dossier_core::plan::dxf::collect(&mut parts, p, &o) {
                    dossier_core::plan::dxf::encode(&f);
                }
            }
        });
    }
}

/// Stufe der Ableitungen: `Full` für die Beispielprojekte, `Light` je Mutationsschritt.
#[derive(Clone, Copy, PartialEq)]
enum Depth {
    Full,
    /// Eine Auswahl, ohne die teuren Abfragen (Pick, IFC-Sammler).
    Light,
    /// Wie `Light`, dazu Pick und IFC-Sammler (jeder vierte Mutationsschritt).
    Medium,
}

/// Rechnet alle Ableitungen des Dokuments; Panics gehen in `fails`.
fn derive_all(d: &mut Document, tag: &str, depth: Depth, fails: &mut Fails) {
    let full = depth == Depth::Full;
    let heavy = depth != Depth::Light;
    let Some(p) = fails.run(|| format!("{tag} project()"), || d.project().ok().cloned()).flatten() else { return };
    let root = d.root().clone();

    // Grundrisse je Geschoss.
    let floors: Vec<&str> = p.drawing_levels.iter().filter(|l| l.kind == dossier_core::model::DrawingLevelKind::Floor).map(|l| l.id.as_str()).collect();
    let combos: &[(f64, f64)] = if full { &[(100.0, 1.0), (50.0, 2.0), (200.0, 1.0), (500.0, 0.0), (20.0, 2.0)] } else { &[(100.0, 1.0)] };
    for fl in &floors {
        for (i, &(scale, detail)) in combos.iter().enumerate() {
            let t = plan_text(&p, fl, scale, if full && i == 0 { json!({"sunWhen": 1.782e12, "referenceLines": true}) } else { json!({}) });
            let ctx = || format!("{tag} Grundriss {fl} 1:{scale} detail {detail}");
            // Über das Dokument (mit Plan-Caches) …
            fails.run(ctx, || dossier_core::queries::run_bin_doc(d, "planDomains", &[detail], &t));
            // … und direkt, die Ausgaben aus dem Puffer.
            let buf = fails.run(ctx, || PlanArgs::parse(detail, &t).and_then(|a| plan_domains_buf(&p, &a)));
            if let Some(Ok(b)) = buf {
                if full || i == 0 {
                    outputs(fails, &ctx(), &p, &b, scale, fl);
                }
            }
        }
        if full {
            let t = plan_text(&p, fl, 100.0, json!({"mono": true, "forPrint": true, "compact": true}));
            fails.run(|| format!("{tag} Grundriss {fl} mono/Druck"), || dossier_core::queries::run_bin_doc(d, "planDomains", &[1.0], &t));
        }
    }

    // Schnitte, Ansichten, Deckenspiegel, Zeichnungsebenen.
    for lv in &p.drawing_levels {
        let kind = format!("{:?}", lv.kind);
        let level = serde_json::to_value(lv).unwrap_or(Value::Null);
        match lv.kind {
            dossier_core::model::DrawingLevelKind::Section | dossier_core::model::DrawingLevelKind::Elevation => {
                let section = lv.kind == dossier_core::model::DrawingLevelKind::Section;
                // Je Art nur die ersten zwei Ebenen und im Grossen Beispiel wenige Kombinationen (Ansichten kosten dort ~2 s).
                let nth = p.drawing_levels.iter().filter(|o| o.kind == lv.kind).position(|o| o.id == lv.id).unwrap_or(0);
                if full && nth >= 2 {
                    continue;
                }
                let calls: Vec<(f64, f64, f64)> = if full { vec![(100.0, 0.0, 0.0), (100.0, 1.0, 1.0), (200.0, 0.0, 2.0)] } else { vec![(100.0, 0.0, 0.0)] };
                for (scale, mono, third) in calls {
                    // Schnitt: `third` = Öffnungen mitschneiden; Ansicht: Schatten (2 = nach Modelldarstellung).
                    let (name, args, t) = if section {
                        ("sectionPlan", vec![mono, third, 0.0], json!({"level": level, "scale": scale, "hiddenLines": true, "detail": "mittel"}))
                    } else {
                        ("elevationPlan", vec![mono, third, scale], json!({"level": level, "hiddenLines": true}))
                    };
                    let t = t.to_string();
                    let ctx = || format!("{tag} {kind} {} 1:{scale} mono {mono} dritter Wert {third}", lv.id);
                    if let Some(Ok(b)) = fails.run(ctx, || dossier_core::queries::run_bin_doc(d, name, &args, &t)) {
                        if full && mono == 0.0 && scale == 100.0 {
                            outputs(fails, &ctx(), &p, &b, scale, &lv.id);
                        }
                    }
                }
            }
            dossier_core::model::DrawingLevelKind::Ceiling | dossier_core::model::DrawingLevelKind::Drawing if full => {
                let t = plan_text(&p, &lv.id, 100.0, json!({}));
                fails.run(|| format!("{tag} Ebene {kind} {}", lv.id), || dossier_core::queries::run_bin_doc(d, "planDomains", &[1.0], &t));
            }
            _ => {}
        }
    }

    // 3D-Modell (Cache des Dokuments, direkter Weg, Explosion, Delta).
    let model_args: Vec<Vec<f64>> = if full {
        vec![
            vec![0.0, 1.0, 0.0, 1.0],
            vec![1.0, 2.0, 0.0, 1.0],
            vec![0.0, 0.0, 1.0, 0.0],
            vec![1.0, 1.0, 0.0, 1.0, 2.0],
            vec![0.0, 1.0, 0.0, 1.0, 0.0, 0.0],
        ]
    } else {
        vec![vec![0.0, 1.0, 0.0, 1.0]]
    };
    for a in &model_args {
        fails.run(|| format!("{tag} model3dParts {a:?}"), || dossier_core::queries::run_doc(d, "model3dParts", a, ""));
    }
    if full {
        fails.run(|| format!("{tag} model3dPartsDelta"), || {
            let _ = dossier_core::queries::run_doc(d, "model3dPartsDelta", &[0.0, 1.0, 0.0, 1.0, 0.0, 0.0], "");
            dossier_core::queries::run_doc(d, "model3dPartsDelta", &[0.0, 1.0, 0.0, 1.0, 0.0, 1.0], "")
        });
    }

    // Abfragen auf dem Projekt: Kennzahlen, Baurecht, Tabellen, Teil-Netze, Pick …
    let mut q: Vec<(&str, Vec<f64>, &str)> = vec![
        ("kennzahlen", vec![], ""),
        ("areaTable", vec![], ""),
        ("costEstimate", vec![], ""),
        ("ivhb", vec![], ""),
        ("siteProof", vec![], ""),
        ("siteCheck", vec![], ""),
        ("buildingFootprint", vec![], ""),
        ("modelTop", vec![], ""),
        ("roomBook", vec![], ""),
        ("scheduleRows", vec![], ""),
        ("openingSchedule", vec![], ""),
        ("elementSchedule", vec![], ""),
        ("shadows", vec![180.0, 45.0, 2.5], ""),
    ];
    if heavy {
        q.push(("pickGeometry", vec![0.0], ""));
    }
    if full {
        q.extend([
            ("costDefaults", vec![], "gf"),
            ("costDefaults", vec![], "gv"),
            ("programCompare", vec![], ""),
            ("programLayout", vec![], ""),
            ("dormerStatus", vec![], ""),
            ("excavationQuantities", vec![], ""),
            ("materialMaps", vec![], ""),
            ("slabs", vec![], ""),
            ("columnMeshes", vec![], ""),
            ("walls", vec![0.0], ""),
            ("walls", vec![1.0], ""),
            ("openingMeshes", vec![0.0], ""),
            ("openingMeshes", vec![1.0], ""),
            ("openingMeshes", vec![2.0], ""),
            ("stairSlabs", vec![0.0], ""),
            ("stairSlabs", vec![1.0], ""),
            ("stairMeshes", vec![], ""),
            ("stairRailings", vec![], ""),
            ("roofMeshes", vec![], ""),
            ("roofCutLayers", vec![], ""),
            ("uValue", vec![], ""),
            ("componentLayerFunctions", vec![], ""),
            ("scheduleCsv", vec![0.0], "walls"),
            ("scheduleCsv", vec![1.0], "openings"),
            ("explodeOffsets", vec![3.0], ""),
            ("pickGeometry", vec![2.0], ""),
            ("projectSolidSpecs", vec![], ""),
            ("hiddenElements", vec![100.0], "plan"),
            ("hiddenElements", vec![50.0], "section"),
            ("hiddenElements", vec![f64::NAN], "elevation"),
            ("modelJson", vec![], ""),
            ("sheetTables", vec![], "{}"),
            ("sheetTableCatalog", vec![], ""),
            ("presentationSheet", vec![], "{}"),
            ("shadows", vec![0.0, 0.5], ""),
            ("shadows", vec![90.0, 89.9, 0.0], ""),
            ("shadows", vec![f64::NAN, 10.0], ""),
        ]);
    }
    for (name, args, text) in &q {
        fails.run(|| format!("{tag} Abfrage {name} {args:?} {text}"), || dossier_core::queries::run_doc(d, name, args, text));
    }

    // Binäre Export-Sammler (IFC, Netze, Pausfolie).
    let bins: Vec<(&str, Vec<f64>, &str)> = if full {
        vec![
            ("ifcExportData", vec![1.7e9, 0.0, 1.0, 1.0], "2026-11-14T10:00:00"),
            ("ifcExportData", vec![1.7e9, 1.0, 0.0, 0.0], "2026-11-14T10:00:00"),
            ("meshExportData", vec![1.0, 1.0, 1.0, 0.0], ""),
            ("meshExportData", vec![0.0, 0.0, 0.0, 1.0], ""),
        ]
    } else if heavy {
        vec![("ifcExportData", vec![1.7e9, 0.0, 1.0, 1.0], "2026-11-14T10:00:00")]
    } else {
        vec![]
    };
    for (name, args, text) in &bins {
        fails.run(|| format!("{tag} Export {name} {args:?}"), || dossier_core::queries::run_bin_doc(d, name, args, text));
    }
    if full {
        // Freie Körper: Kennwerte aus dem Kern-Netz.
        for id in ids_of(&root, "extrudedSolids") {
            fails.run(|| format!("{tag} solidProps {id}"), || dossier_core::queries::run_doc(d, "solidProps", &[], &id));
        }
    }

    // Wurzel-Abfragen, Objekt-Info, Griffe, Befehle.
    for name in ["penRebakeOps", "standardsMergeOps", "standardsUpdatePlan"] {
        fails.run(|| format!("{tag} Wurzel {name}"), || dossier_core::queries::run_root_doc(d, name, ""));
    }
    let kinds: [(&str, &str, &str); 9] = [
        ("walls", "wallIds", "wall"),
        ("drawings2d", "drawingId", "drawing"),
        ("ceilings", "ceilingId", "ceiling"),
        ("openings", "openingId", "opening"),
        ("stairs", "stairId", "stair"),
        ("rooms", "roomId", "room"),
        ("extrudedSolids", "extrudedSolidId", "solid"),
        ("columns", "columnId", "column"),
        ("roofs", "roofId", "roof"),
    ];
    let max_each = if full { 40 } else { 6 };
    for (coll, arg, _) in kinds {
        for id in ids_of(&root, coll).into_iter().take(max_each) {
            let sel = if arg == "wallIds" { json!({ arg: [id] }) } else { json!({ arg: id }) };
            fails.run(|| format!("{tag} selectionInfo {coll} {id}"), || dossier_core::queries::run_root_doc(d, "selectionInfo", &sel.to_string()));
        }
    }
    let drawing_ids = ids_of(&root, "drawings2d");
    fails.run(|| format!("{tag} drawingBBoxes"), || dossier_core::queries::run_root_doc(d, "drawingBBoxes", &json!(drawing_ids).to_string()));
    let wall_ids: Vec<String> = ids_of(&root, "walls").into_iter().take(max_each).collect();
    let vecs: [(f64, f64); 4] = [(0.5, -0.25), (0.0, 0.0), (1e9, -1e9), (-3.0, 7.0)];
    for id in &wall_ids {
        for (dx, dy) in vecs {
            for (op, extra) in [("moveBy", json!({})), ("moveGrip", json!({"index": 0, "pt": [dx, dy], "scale": 100.0})), ("moveGrip", json!({"index": 1, "pt": [dx, dy], "scale": 100.0, "free": true})), ("resize", json!({"kind": "wall", "w": dx, "h": dy, "fx": 0.0, "fy": 0.0})), ("wallThickness", json!({"thickness": dx}))] {
                let mut req = json!({"op": op, "wallId": id, "id": id, "delta": [dx, dy]});
                if let (Some(o), Some(e)) = (req.as_object_mut(), extra.as_object()) {
                    o.extend(e.clone());
                }
                fails.run(|| format!("{tag} Griff {req}"), || dossier_core::queries::run_root_doc(d, "gripOps", &req.to_string()));
                if !full {
                    break;
                }
            }
            if !full {
                break;
            }
        }
    }
    for id in drawing_ids.iter().take(max_each) {
        for (op, idx) in [("moveBy", 0.0), ("moveGrip", 0.0), ("moveGrip", 1.0), ("moveGrip", 3.0), ("moveGrip", 99.0), ("deletePoint", 1.0), ("insertPoint", 0.0)] {
            let req = json!({"op": op, "drawingId": id, "index": idx, "pt": [1.0, 2.0], "delta": [0.3, 0.3], "scale": 100.0});
            fails.run(|| format!("{tag} Griff {req}"), || dossier_core::queries::run_root_doc(d, "gripOps", &req.to_string()));
            if !full {
                break;
            }
        }
    }
    let stamp = "robust";
    let all_ids = |c: &str| ids_of(&root, c);
    let cmds = vec![
        json!({"cmd": "transform", "mode": "move", "ids": {"walls": wall_ids}, "delta": [1.0, 1.0]}),
        json!({"cmd": "align", "ids": drawing_ids, "mode": "left"}),
        json!({"cmd": "distribute", "ids": drawing_ids, "axis": "x"}),
        json!({"cmd": "split", "ids": wall_ids, "stamp": stamp}),
        json!({"cmd": "cutSegment", "id": wall_ids.first().cloned().unwrap_or_default(), "at": {"x": 1.0, "y": 0.0}, "stamp": stamp}),
        json!({"cmd": "join", "ids": wall_ids}),
        json!({"cmd": "delete", "ids": all_ids("rooms")}),
    ];
    for c in cmds {
        fails.run(|| format!("{tag} Befehl {c}"), || dossier_core::queries::run_root_doc(d, "cmdOps", &c.to_string()));
        if !full {
            break;
        }
    }
}

// ── 1. Beispielprojekte ──────────────────────────────────────────────────────

/// Schutz gegen einen leeren Lauf: die Beispiele müssen Ergebnisse liefern, nicht nur ohne Panic scheitern.
fn sanity(name: &str, d: &mut Document) {
    let p = d.project().unwrap().clone();
    let floor = p.drawing_levels.iter().find(|l| l.kind == dossier_core::model::DrawingLevelKind::Floor).expect("Geschoss").id.clone();
    let t = plan_text(&p, &floor, 100.0, json!({}));
    let b = dossier_core::queries::run_bin_doc(d, "planDomains", &[1.0], &t).unwrap_or_else(|e| panic!("{name}: Grundriss: {e}"));
    assert!(b.len() > 1000, "{name}: Grundriss-Puffer zu klein ({})", b.len());
    let k = dossier_core::queries::run_doc(d, "kennzahlen", &[], "").unwrap_or_else(|e| panic!("{name}: Kennzahlen: {e}"));
    assert!(k.len() > 20, "{name}: Kennzahlen leer");
    let m = dossier_core::queries::run_doc(d, "model3dParts", &[0.0, 1.0, 0.0, 1.0], "").unwrap_or_else(|e| panic!("{name}: 3D: {e}"));
    assert!(m.len() > 1000, "{name}: 3D-Modell leer");
    let ifc = dossier_core::queries::run_bin_doc(d, "ifcExportData", &[1.7e9, 0.0, 1.0, 1.0], "2026-11-14T10:00:00").unwrap_or_else(|e| panic!("{name}: IFC: {e}"));
    assert!(ifc.len() > 100, "{name}: IFC-Sammler leer");
}

#[test]
fn beispielprojekte_alle_ableitungen() {
    let mut fails = Fails::default();
    for (name, text) in FIXTURES {
        let mut d = match open(text) {
            Ok(d) => d,
            Err(e) => panic!("{name}: Lader lehnt das Beispielprojekt ab: {e}"),
        };
        let t0 = std::time::Instant::now();
        sanity(name, &mut d);
        derive_all(&mut d, name, Depth::Full, &mut fails);
        eprintln!("{name}: alle Ableitungen in {:.1} s", t0.elapsed().as_secs_f64());
        // Speichern → neu laden → noch einmal (Rundreise des Formats).
        let again = d.serialize();
        match open(&again) {
            Ok(mut d2) => {
                if name != "komplex" {
                    derive_all(&mut d2, &format!("{name} (Rundreise)"), Depth::Light, &mut fails)
                }
            }
            Err(e) => panic!("{name}: eigene Datei lässt sich nicht laden: {e}"),
        }
    }
    fails.assert_empty("Beispielprojekte");
}

// ── 2. Mutationsrunde ────────────────────────────────────────────────────────

const EDGE_NUMBERS: [f64; 10] = [0.0, 1e-9, -1e-9, -1.0, 1e6, 1e12, -1e12, 1e300, 0.5, 359.99999];

fn collect_numbers(v: &Value, path: &mut Vec<String>, out: &mut Vec<Vec<String>>) {
    match v {
        Value::Number(_) => out.push(path.clone()),
        Value::Array(a) => {
            for (i, x) in a.iter().enumerate() {
                path.push(i.to_string());
                collect_numbers(x, path, out);
                path.pop();
            }
        }
        Value::Object(o) => {
            for (k, x) in o {
                path.push(k.clone());
                collect_numbers(x, path, out);
                path.pop();
            }
        }
        _ => {}
    }
}

fn set_path(v: &mut Value, path: &[String], new: Value) {
    let Some((first, rest)) = path.split_first() else {
        *v = new;
        return;
    };
    let next = match v {
        Value::Array(a) => first.parse::<usize>().ok().and_then(|i| a.get_mut(i)),
        Value::Object(o) => o.get_mut(first),
        _ => None,
    };
    if let Some(n) = next {
        set_path(n, rest, new);
    }
}

fn edge_value(rng: &mut Rng) -> (Value, bool) {
    match rng.below(14) {
        0..=7 => (json!(EDGE_NUMBERS[rng.below(EDGE_NUMBERS.len())]), false),
        8 => (json!("\u{1}NaN"), true),
        9 => (json!("\u{1}Infinity"), true),
        10 => (Value::Null, false),
        11 => (json!("kein-Zahl"), false),
        12 => (json!(true), false),
        _ => (json!(rng.unit() * 200.0 - 100.0), false),
    }
}

const MUTABLE: [&str; 25] = [
    "walls", "ceilings", "roofs", "openings", "stairs", "rooms", "columns", "drawings2d", "extrudedSolids", "trees", "cameras", "parametricWalls", "drawingLevels",
    // Typen und Vorlagen (Schichtdicken, Flügelzahlen, Schraffurmassstäbe …).
    "wallTypes", "ceilingTypes", "roofTypes", "windowTypes", "doorTypes", "stairTypes", "components", "hatches", "viewTemplates", "layouts", "overrideRules", "blockDefs",
];

/// Ein Schritt: Beschreibung, Ops (JSON), Marken enthalten?
fn random_step(rng: &mut Rng, root: &Map<String, Value>) -> Option<(String, Vec<Value>, bool)> {
    let live: Vec<&str> = MUTABLE.iter().copied().filter(|k| root.get(*k).and_then(Value::as_array).is_some_and(|a| !a.is_empty())).collect();
    let pick = |rng: &mut Rng| -> Option<(&str, Value)> {
        let c = *live.get(rng.below(live.len().max(1)))?;
        let a = root.get(c)?.as_array()?;
        Some((c, a.get(rng.below(a.len()))?.clone()))
    };
    match rng.below(10) {
        // Zahl im Element auf Randwert.
        0..=4 => {
            let (c, mut e) = pick(rng)?;
            let mut paths = Vec::new();
            collect_numbers(&e, &mut Vec::new(), &mut paths);
            let path = paths.get(rng.below(paths.len().max(1)))?.clone();
            let (val, mark) = edge_value(rng);
            set_path(&mut e, &path, val.clone());
            let id = e.get("id").and_then(Value::as_str).unwrap_or("?").to_string();
            Some((format!("{c}/{id} .{} = {val}", path.join(".")), vec![json!({"kind": "replace", "collection": c, "entity": e})], mark))
        }
        // Verschieben (alle Koordinaten um dx/dy, auch gross).
        5 => {
            let (c, mut e) = pick(rng)?;
            let (dx, dy) = ((rng.unit() - 0.5) * 2000.0, (rng.unit() - 0.5) * 2000.0);
            fn shift(v: &mut Value, dx: f64, dy: f64) {
                match v {
                    Value::Object(o) => {
                        if let (Some(x), Some(y)) = (o.get("x").and_then(Value::as_f64), o.get("y").and_then(Value::as_f64)) {
                            o.insert("x".into(), json!(x + dx));
                            o.insert("y".into(), json!(y + dy));
                        }
                        for (_, x) in o.iter_mut() {
                            shift(x, dx, dy);
                        }
                    }
                    Value::Array(a) => a.iter_mut().for_each(|x| shift(x, dx, dy)),
                    _ => {}
                }
            }
            shift(&mut e, dx, dy);
            let id = e.get("id").and_then(Value::as_str).unwrap_or("?").to_string();
            Some((format!("{c}/{id} verschoben um ({dx:.1}, {dy:.1})"), vec![json!({"kind": "replace", "collection": c, "entity": e})], false))
        }
        // Löschen.
        6 => {
            let (c, e) = pick(rng)?;
            let id = e.get("id")?.as_str()?.to_string();
            Some((format!("{c}/{id} gelöscht"), vec![json!({"kind": "remove", "collection": c, "ids": [id]})], false))
        }
        // Duplizieren (neue id) und ein zweites Mal mit gleicher id (muss abgelehnt werden).
        7 => {
            let (c, mut e) = pick(rng)?;
            let id = e.get("id")?.as_str()?.to_string();
            if rng.below(3) > 0 {
                e["id"] = json!(format!("{id}-kopie{}", rng.below(1000)));
            }
            Some((format!("{c}/{id} dupliziert"), vec![json!({"kind": "add", "collection": c, "items": [e]})], false))
        }
        // Feld der Wurzel: Zahl auf Randwert oder Feld entfernen/leeren.
        8 => {
            let keys: Vec<&String> = root.keys().filter(|k| !matches!(k.as_str(), "id" | "formatVersion")).collect();
            let k = (*keys.get(rng.below(keys.len().max(1)))?).clone();
            let cur = root.get(&k)?;
            let (val, mark) = match cur {
                Value::Number(_) => edge_value(rng),
                Value::Array(_) => (json!([]), false),
                // Verschachtelte Objekte (Kontext, Baurecht, Wettbewerb …): eine Zahl darin auf einen Randwert.
                Value::Object(_) if rng.below(3) > 0 => {
                    let mut o = cur.clone();
                    let mut paths = Vec::new();
                    collect_numbers(&o, &mut Vec::new(), &mut paths);
                    let Some(path) = paths.get(rng.below(paths.len().max(1))).cloned() else { return None };
                    let (v, mark) = edge_value(rng);
                    set_path(&mut o, &path, v.clone());
                    return Some((format!("Feld {k} .{} = {v}", path.join(".")), vec![json!({"kind": "setField", "key": k, "value": o})], mark));
                }
                Value::Object(_) => (json!({}), false),
                _ => {
                    return Some((format!("Feld {k} entfernt"), vec![json!({"kind": "setField", "key": k})], false));
                }
            };
            Some((format!("Feld {k} = {val}"), vec![json!({"kind": "setField", "key": k, "value": val})], mark))
        }
        // Reihenfolge einer Sammlung umkehren.
        _ => {
            let c = *live.get(rng.below(live.len().max(1)))?;
            let mut ids = ids_of(root, c);
            ids.reverse();
            Some((format!("{c} umgekehrt"), vec![json!({"kind": "reorder", "collection": c, "ids": ids})], false))
        }
    }
}

fn mutate(name: &str, text: &str, steps: usize, seed: u64, fails: &mut Fails) -> (usize, usize) {
    let mut d = open(text).expect("Beispiel lädt");
    let mut rng = Rng(seed | 1);
    let (mut accepted, mut rejected) = (0, 0);
    let mut now = 1.0e12;
    for i in 0..steps {
        // Alle 40 Schritte frisch vom Beispiel: sonst leeren die „Feld = []“-Schritte das Projekt bald ganz.
        if i > 0 && i % 40 == 0 {
            d = open(text).expect("Beispiel lädt");
        }
        let before = d.to_json();
        let root = d.root().clone();
        let tag = format!("{name} seed {seed} Schritt {i}");
        let desc;
        if rng.below(6) == 0 {
            // Undo/Redo dazwischen (auch mehrfach, auch ins Leere).
            let n = 1 + rng.below(3);
            let redo = rng.below(2) == 0;
            desc = format!("{} x{n}", if redo { "Redo" } else { "Undo" });
            fails.run(|| format!("{tag}: {desc}"), || {
                for _ in 0..n {
                    if redo {
                        d.redo();
                    } else {
                        d.undo();
                    }
                }
            });
        } else {
            let Some((dsc, ops, marks)) = random_step(&mut rng, &root) else { continue };
            desc = dsc;
            let parsed: Result<Vec<Op>, String> = ops.iter().map(Op::from_json).collect();
            let Ok(ops) = parsed else { continue };
            now += 1000.0;
            let key = (rng.below(3) == 0).then_some("robust-regler");
            let r = fails.run(|| format!("{tag}: {desc}"), || d.commit(ops, key, now, marks));
            match r {
                Some(Ok(())) => accepted += 1,
                Some(Err(_)) => rejected += 1,
                None => {}
            }
        }
        if std::env::var("ROBUST_TRACE").is_ok() {
            eprintln!("{tag}: {desc}");
        }
        let n0 = fails.0.values().map(|v| v.0).sum::<usize>();
        derive_all(&mut d, &format!("{tag}: {desc}"), if i % 4 == 0 { Depth::Medium } else { Depth::Light }, fails);
        // Nach einem Panic mit dem Stand davor weitermachen (das Dokument ist dann evtl. halb geändert).
        if fails.0.values().map(|v| v.0).sum::<usize>() > n0 {
            if let Ok(d2) = Document::from_json(&before) {
                d = d2;
            }
        }
    }
    (accepted, rejected)
}

#[test]
fn mutationsrunde() {
    let steps = env_num("ROBUST_STEPS", 200) as usize;
    let seed = env_num("ROBUST_SEED", 0x00D0_551E);
    let mut fails = Fails::default();
    for (name, text) in FIXTURES.iter().filter(|f| f.0 != "komplex") {
        // (Das Komplexe braucht je Schritt Sekunden — Ansichten —, es läuft nur in Lauf 1.)
        if std::env::var("ROBUST_ONLY").is_ok_and(|o| o != *name) {
            continue;
        }
        // Die grossen Beispiele wenig, das kleine mehr.
        let n = if *name == "beispiel" { steps } else { steps / 5 };
        let t0 = std::time::Instant::now();
        let (ok, rej) = mutate(name, text, n, seed, &mut fails);
        eprintln!("Mutationsrunde {name}: {n} Schritte, {ok} angenommen, {rej} abgelehnt, {:.1} s", t0.elapsed().as_secs_f64());
    }
    fails.assert_empty("Mutationsrunde");
}

// ── 3. Kaputte Projektdateien ────────────────────────────────────────────────

fn probe(fails: &mut Fails, tag: &str, text: &str, derive: bool) -> bool {
    if std::env::var("ROBUST_TRACE").is_ok() {
        eprintln!("probe: {tag}");
    }
    // Beide Wege: Datei laden (migrieren + prüfen) und rohes `doc_open` (`Document::from_json`).
    let loaded = fails.run(|| format!("{tag} (load_file)"), || open(text));
    let mut ok = false;
    if let Some(Ok(mut d)) = loaded {
        ok = true;
        if derive {
            derive_all(&mut d, &format!("{tag} (load_file)"), Depth::Light, fails);
            fails.run(|| format!("{tag} serialize"), || d.serialize());
        }
    }
    let raw = fails.run(|| format!("{tag} (from_json)"), || Document::from_json(text));
    if let (true, Some(Ok(mut d))) = (derive, raw) {
        derive_all(&mut d, &format!("{tag} (from_json)"), Depth::Light, fails);
    }
    ok
}

fn base() -> Map<String, Value> {
    serde_json::from_str::<Value>(FIXTURES[0].1).unwrap().as_object().unwrap().clone()
}

fn with(m: &Map<String, Value>) -> String {
    Value::Object(m.clone()).to_string()
}

#[test]
fn kaputte_projektdateien() {
    let mut fails = Fails::default();
    let text = FIXTURES[0].1;
    let b = base();

    // Abgeschnitten: an vielen Stellen (auch mitten in Zeichen/Zahlen/Schlüsseln).
    let chars: Vec<usize> = text.char_indices().map(|c| c.0).collect();
    for k in 0..40 {
        let cut = chars[chars.len() * k / 40];
        let ok = probe(&mut fails, &format!("abgeschnitten bei {cut}"), &text[..cut], false);
        assert!(!ok, "abgeschnittene Datei ({cut}) wurde angenommen");
    }
    // Kein Objekt, leer, Müll.
    for junk in ["", " ", "{", "}", "[]", "null", "42", "\"x\"", "true", "{}", "{\"id\":1}", "{\"walls\":{}}", "\u{feff}{}", "{\"formatVersion\":null}", "{\"a\":1e999}", "[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[["] {
        probe(&mut fails, &format!("Müll {junk:?}"), junk, true);
    }
    // Formatversion.
    for v in [json!(0), json!(-1), json!(999), json!(1.5), json!("x"), json!(null), json!(1e18), json!([5])] {
        let mut m = b.clone();
        m.insert("formatVersion".into(), v.clone());
        probe(&mut fails, &format!("formatVersion {v}"), &with(&m), true);
    }
    // Jedes Wurzelfeld: fehlt / falscher Typ / leer.
    let wrong = [json!(null), json!(0), json!(-1), json!(1e300), json!("x"), json!(true), json!({}), json!([]), json!([null]), json!([1, 2, 3]), json!([{}]), json!([{"id": "a"}, {"id": "a"}]), json!({"id": "x"})];
    for (k, orig) in &b {
        let mut m = b.clone();
        m.shift_remove(k);
        probe(&mut fails, &format!("Feld {k} fehlt"), &with(&m), true);
        for w in &wrong {
            let mut m = b.clone();
            m.insert(k.clone(), w.clone());
            probe(&mut fails, &format!("Feld {k} = {w}"), &with(&m), true);
        }
        if orig.is_object() && k != "uiState" {
            for (name, to) in [("0", 0.0), ("negativ", -1.0), ("1e300", 1e300), ("1e-300", 1e-300)] {
                let mut m = b.clone();
                m.insert(k.clone(), zero_numbers(orig, to));
                probe(&mut fails, &format!("{k}: alle Zahlen {name}"), &with(&m), true);
            }
        }
        // Listen: Elemente leeren, ohne id, nicht-Objekte, doppelte ids, Elemente mit lauter falschen Typen.
        if let Some(a) = orig.as_array().filter(|a| a.first().is_some_and(Value::is_object)) {
            let variants: Vec<(&str, Value)> = vec![
                ("ohne id", Value::Array(a.iter().map(|e| e.as_object().map_or(e.clone(), |o| Value::Object(o.iter().filter(|(k, _)| *k != "id").map(|(k, v)| (k.clone(), v.clone())).collect()))).collect())),
                ("Elemente leer {}", Value::Array(a.iter().map(|_| json!({})).collect())),
                ("Elemente leer {id}", Value::Array(a.iter().enumerate().map(|(i, _)| json!({"id": format!("e{i}")})).collect())),
                ("Elemente null", Value::Array(a.iter().map(|_| Value::Null).collect())),
                ("doppelt", Value::Array(a.iter().chain(a.iter()).cloned().collect())),
                ("alle Felder null", Value::Array(a.iter().map(|e| e.as_object().map_or(Value::Null, |o| Value::Object(o.iter().map(|(k, v)| (k.clone(), if k == "id" { v.clone() } else { Value::Null })).collect()))).collect())),
                ("alle Felder Text", Value::Array(a.iter().map(|e| e.as_object().map_or(Value::Null, |o| Value::Object(o.iter().map(|(k, v)| (k.clone(), if k == "id" { v.clone() } else { json!("x") })).collect()))).collect())),
                ("alle Zahlen 0", Value::Array(a.iter().map(|e| zero_numbers(e, 0.0)).collect())),
                ("alle Zahlen negativ", Value::Array(a.iter().map(|e| zero_numbers(e, -1.0)).collect())),
                ("alle Zahlen 1e300", Value::Array(a.iter().map(|e| zero_numbers(e, 1e300)).collect())),
                ("alle Zahlen 1e-300", Value::Array(a.iter().map(|e| zero_numbers(e, 1e-300)).collect())),
                ("unbekannte Felder", Value::Array(a.iter().map(|e| with_extra(e)).collect())),
            ];
            for (name, v) in variants {
                let mut m = b.clone();
                m.insert(k.clone(), v);
                probe(&mut fails, &format!("{k}: {name}"), &with(&m), true);
            }
        }
    }
    // Verweise ins Leere: alle `…Id`-Felder (und `…Type`) auf eine nicht vorhandene id, je Sammlung und überall.
    let dangling = |m: &mut Map<String, Value>, only: Option<&str>| {
        for (k, v) in m.iter_mut() {
            if only.is_some_and(|o| o != k) {
                continue;
            }
            if let Value::Array(a) = v {
                for e in a {
                    dangle(e);
                }
            }
        }
    };
    for k in b.keys() {
        let mut m = b.clone();
        dangling(&mut m, Some(k));
        probe(&mut fails, &format!("Verweise ins Leere in {k}"), &with(&m), true);
    }
    let mut m = b.clone();
    dangling(&mut m, None);
    probe(&mut fails, "Verweise ins Leere überall", &with(&m), true);
    // Alle Listen leer; alle Listen entfernt.
    let mut m = b.clone();
    for v in m.values_mut() {
        if v.is_array() {
            *v = json!([]);
        }
    }
    probe(&mut fails, "alle Listen leer", &with(&m), true);
    let mut m = b.clone();
    m.retain(|_, v| !v.is_array());
    probe(&mut fails, "keine Listen", &with(&m), true);
    // Nur Geschosse ohne Bauteile, Bauteile ohne Geschosse.
    let mut m = b.clone();
    m.insert("drawingLevels".into(), json!([]));
    probe(&mut fails, "ohne Geschosse", &with(&m), true);
    // Unbekannte Wurzelfelder.
    let mut m = b.clone();
    for (i, k) in ["zukunft", "walls2", "__proto__", "", "a.b", "ü"].iter().enumerate() {
        m.insert((*k).into(), json!({"x": i}));
    }
    probe(&mut fails, "unbekannte Wurzelfelder", &with(&m), true);

    fails.assert_empty("kaputte Projektdateien");
}

fn zero_numbers(v: &Value, to: f64) -> Value {
    match v {
        Value::Number(_) => json!(to),
        Value::Array(a) => Value::Array(a.iter().map(|x| zero_numbers(x, to)).collect()),
        Value::Object(o) => Value::Object(o.iter().map(|(k, x)| (k.clone(), if k == "id" { x.clone() } else { zero_numbers(x, to) })).collect()),
        _ => v.clone(),
    }
}

fn with_extra(v: &Value) -> Value {
    let mut v = v.clone();
    if let Some(o) = v.as_object_mut() {
        o.insert("unbekannt".into(), json!({"x": [1, 2, 3]}));
        o.insert("kind".into(), json!("zukunft"));
    }
    v
}

fn dangle(v: &mut Value) {
    match v {
        Value::Object(o) => {
            for (k, x) in o.iter_mut() {
                if x.is_string() && k != "id" && (k.ends_with("Id") || k.ends_with("TypeId") || k == "typeId" || k.ends_with("Code") || k == "category" || k == "layer") {
                    *x = json!("__fehlt__");
                } else if let Value::Array(a) = x {
                    if k.ends_with("Ids") {
                        *x = json!(["__fehlt__"]);
                    } else {
                        a.iter_mut().for_each(dangle);
                    }
                } else {
                    dangle(x);
                }
            }
        }
        Value::Array(a) => a.iter_mut().for_each(dangle),
        _ => {}
    }
}

// ── Gezielte Regressionen (je gefundener Panic/Abbruch ein Fall) ─────────────

/// Beispiel mit einer Änderung laden, alle Ableitungen (inkl. Pick) rechnen; ein Panic schlägt fehl. Ein Speicher-
/// Abbruch (`handle_alloc_error`) würde den ganzen Testlauf beenden — auch das ist ein Fehlschlag.
fn regression(label: &str, edit: impl FnOnce(&mut Map<String, Value>)) {
    let mut m = base();
    edit(&mut m);
    let mut d = open(&with(&m)).unwrap_or_else(|e| panic!("{label}: lädt nicht: {e}"));
    let mut fails = Fails::default();
    let t0 = std::time::Instant::now();
    derive_all(&mut d, label, Depth::Medium, &mut fails);
    fails.assert_empty(label);
    assert!(t0.elapsed().as_secs_f64() < 20.0, "{label}: zu langsam ({:?})", t0.elapsed());
}

fn item<'a>(m: &'a mut Map<String, Value>, list: &str, i: usize) -> &'a mut Value {
    &mut m.get_mut(list).and_then(Value::as_array_mut).unwrap_or_else(|| panic!("{list} fehlt"))[i]
}

#[test]
fn regression_fluegelzahl_riesig() {
    // `wingCount` 1e300: Schleife über Milliarden Flügel in Ansicht, Schnitt und Plan (Speicher-Abbruch).
    regression("wingCount 1e300", |m| {
        for t in m.get_mut("windowTypes").and_then(Value::as_array_mut).unwrap() {
            t["wingCount"] = json!(1e300);
        }
    });
}

#[test]
fn regression_koordinaten_ausserhalb_rechenbereich() {
    // Aufbau-Schichten 1e300 m dick: Wandpolygone jenseits von 2^500 → i_overlay-Panic.
    regression("Schichtdicke 1e300", |m| {
        for t in m.get_mut("wallTypes").and_then(Value::as_array_mut).unwrap() {
            for l in t["layers"].as_array_mut().unwrap() {
                l["thickness"] = json!(1e300);
            }
        }
    });
}

#[test]
fn regression_decke_nan_im_schnitt() {
    // Deckenpunkt 1e300: f32-Überlauf → NaN in der Schnitt-Sortierung (`partial_cmp().unwrap()`).
    regression("Decke 1e300", |m| item(m, "ceilings", 0)["outline"][2]["y"] = json!(1e300));
}

#[test]
fn regression_raum_riesig_und_gestreckt() {
    // Raum 1e300 bzw. 1e12 m lang: Gitter des Raumbuchs (Höhenbereiche) und Beschriftungspunkt.
    for v in [1e300, 1e12] {
        regression(&format!("Raum {v}"), |m| item(m, "rooms", 0)["boundary"][1]["x"] = json!(v));
    }
}

#[test]
fn regression_wand_riesig_lang() {
    // Wand 1e12 m lang: Bänder-Raster mit Billionen Schritten (Hänger) und Ansichts-Zellraster.
    regression("Wand 1e12", |m| item(m, "walls", 0)["start"]["x"] = json!(-1e12));
}

#[test]
fn regression_treppe_riesige_steigung() {
    // Ortbetontreppe mit Steigung 1e12 m: Untersicht-Scheiben je Tritt (Billionen Platten im Schnitt).
    regression("Treppe 1e12", |m| item(m, "stairs", 0)["totalRise"] = json!(1e12));
}
