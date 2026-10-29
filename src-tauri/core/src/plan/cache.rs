//! Caches der Plan-Erzeugung ([K4], Leistung): unveränderte Teile eines Grundrisses werden nicht
//! neu erzeugt, sondern fertig geschrieben wiederverwendet — inhaltlich dasselbe Ergebnis wie ohne
//! Cache (`plan_domains_buf`: gleiche Primitive, Inhalts-Hashes, Linienzüge, Ausmass).
//!
//! - Übrige Domänen (Decken … Schnittlinien) als Abschnitte ([`Segment`]) mit den behaltenen
//!   String-/Schraffur-Tabellen des Kontexts: gültig, solange sich kein Feld ausser den Zeichnungen
//!   ändert und Sichtbarkeit/Dimmen gleich bleiben.
//! - 2D-Zeichnungen in Stücken (`drawings.rs::plan_drawings_chunked`), je Stück ein eigener Puffer
//!   mit Schlüssel aus den Element-Ständen des Dokuments (`Revs::items`, neu bei jedem
//!   `add`/`replace` eines Elements) samt gedimmt/kompakt. Stücke, die der Aufrufer schon hat,
//!   reisen nicht nochmals; ein geändertes Stück übernimmt seine unveränderten Elemente fertig
//!   geschrieben ([`Kept`]). Gültig, solange sich kein Feld ändert, das Zeichnungen lesen (alles
//!   ausser [`NOT_FOR_DRAWINGS`]).
//!
//! Je Argument-Satz (Geschoss, Detail, Massstab, …) ein eigener Kontext, die zuletzt benutzten
//! [`MAX_CONTEXTS`] bleiben. Laden eines Projekts (neue Epoche) leert alles.

use super::domains::PlanArgs;
use crate::plan_buf::{Kept, Segment, Tables};
use std::collections::HashMap;

/// Felder, die die 2D-Zeichnungen nicht lesen (Bauteile, Studien, Ansichten).
pub const NOT_FOR_DRAWINGS: &[&str] = &[
    "drawings2d",
    "walls",
    "openings",
    "ceilings",
    "roofs",
    "stairs",
    "rooms",
    "columns",
    "extrudedSolids",
    "context",
    "groups",
    "parametricWalls",
    "viewSnapshots",
    "viewSnapshotFolders",
    "roomProgram",
    "roomProgramTolerance",
    "parcelArea",
    "sunStudy",
    "siteRules",
    "geoAnchor",
    "referenceElevationMasl",
];

/// Felder, die die übrigen Domänen nicht lesen.
pub const NOT_FOR_REST: &[&str] = &["drawings2d", "viewSnapshots", "viewSnapshotFolders"];

/// So viele Argument-Sätze bleiben im Cache (aktives Geschoss, Nachbar-Ebenen, Export …).
pub const MAX_CONTEXTS: usize = 8;

/// Ein Stück der 2D-Zeichnungen (`plan/drawings.rs::plan_drawings_chunked`): Elemente fertig
/// geschrieben mit eigenen Tabellen, Ausmass; der Puffer nur bis zur ersten Auslieferung.
#[derive(Debug)]
pub struct Chunk {
    pub tables: Tables,
    pub kept: Kept,
    pub bounds: [f64; 4],
    pub bytes: Option<Vec<u8>>,
    /// Neu in diesem Aufruf (Zuordnung Element → Stück noch nachzuführen).
    pub fresh: bool,
}

/// Cache der 2D-Zeichnungen eines Kontexts: die Stücke des letzten Aufrufs und je Element-Stand
/// das Stück, in dem es steht.
#[derive(Debug, Default)]
pub struct DrawCache {
    /// Stand der Felder, die Zeichnungen lesen (`Revs::max_except(NOT_FOR_DRAWINGS)`).
    pub sig: u64,
    pub chunks: HashMap<u64, Chunk>,
    pub owner: HashMap<u64, u64>,
}

/// Die übrigen Domänen als fertige Abschnitte.
#[derive(Debug)]
pub struct RestEntry {
    /// (Stand aller Felder ausser [`NOT_FOR_REST`], Sichtbarkeit/Dimmen).
    pub sig: (u64, String),
    /// Abschnitte in Puffer-Reihenfolge ohne die Zeichnungen (Zutaten unten, Domänen, Verstösse).
    pub groups: Vec<Segment>,
    pub bounds: [f64; 4],
    /// Ausmass der Zutaten (Schatten, Baurecht, Kontext), s. `extras::extra_bounds`.
    pub extra: [f64; 4],
}

#[derive(Debug)]
pub struct CtxCache {
    key: String,
    epoch: u64,
    used: u64,
    pub drawings: DrawCache,
    pub rest: Option<RestEntry>,
    /// String-/Schraffur-Tabellen, mit denen die Abschnitte geschrieben sind (zwischen zwei
    /// Puffern hier, während des Schreibens im Schreiber).
    pub tables: Tables,
    /// Umfang der Texte nach dem letzten vollständigen Neuaufbau (Mass für den Verschnitt).
    pub base_units: usize,
}

impl CtxCache {
    /// Alles verwerfen (neue Epoche, zu viel Verschnitt in den Tabellen).
    pub fn reset(&mut self) {
        self.drawings = DrawCache::default();
        self.rest = None;
        self.tables = Tables::default();
        self.base_units = 0;
    }

    /// Verschnitt zu gross (geänderte Texte und gelöschte Elemente bleiben in den Tabellen stehen):
    /// dann einmal alles neu.
    pub fn trim(&mut self) {
        if self.tables.units_len() > 2 * self.base_units + (1 << 20) {
            self.reset();
        }
    }
}

/// Alle Kontexte eines Dokuments.
#[derive(Debug, Default)]
pub struct PlanCache {
    ctxs: Vec<CtxCache>,
    tick: u64,
}

/// Eine Kopie des Dokuments beginnt ohne Cache.
impl Clone for PlanCache {
    fn clone(&self) -> Self {
        PlanCache::default()
    }
}

/// Schlüssel eines Argument-Satzes ohne Sichtbarkeit/Dimmen (die wirken je Element).
pub fn ctx_key(a: &PlanArgs) -> String {
    format!("{}\u{1}{:?}\u{1}{}\u{1}{}\u{1}{}\u{1}{}\u{1}{}\u{1}{}", a.floor, a.detail, a.reference_lines, a.global, a.scale.to_bits(), a.for_print, a.compact, a.mono)
}

/// Sichtbarkeit und Dimmen als vergleichbarer Text (Mengen sortiert).
pub fn selection_sig(a: &PlanArgs) -> String {
    let mut show: Vec<&str> = a.show.iter().map(String::as_str).collect();
    let mut grey: Vec<&str> = a.grey.iter().map(String::as_str).collect();
    show.sort_unstable();
    grey.sort_unstable();
    format!("{}\u{2}{}", show.join("\u{1}"), grey.join("\u{1}"))
}

impl PlanCache {
    /// Kontext für `a` (angelegt, wenn neu; aus einer früheren Epoche geleert).
    pub fn context(&mut self, a: &PlanArgs, epoch: u64) -> &mut CtxCache {
        self.tick += 1;
        let key = ctx_key(a);
        let i = match self.ctxs.iter().position(|c| c.key == key) {
            Some(i) => i,
            None => {
                if self.ctxs.len() >= MAX_CONTEXTS {
                    let lru = self.ctxs.iter().enumerate().min_by_key(|(_, c)| c.used).map_or(0, |(i, _)| i);
                    self.ctxs.swap_remove(lru);
                }
                self.ctxs.push(CtxCache { key, epoch, used: 0, drawings: DrawCache::default(), rest: None, tables: Tables::default(), base_units: 0 });
                self.ctxs.len() - 1
            }
        };
        let c = &mut self.ctxs[i];
        if c.epoch != epoch {
            c.epoch = epoch;
            c.reset();
        }
        c.used = self.tick;
        c
    }

    /// Anzahl Kontexte (Tests).
    pub fn len(&self) -> usize {
        self.ctxs.len()
    }

    pub fn is_empty(&self) -> bool {
        self.ctxs.is_empty()
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use crate::document::{Document, Op};
    use crate::plan::domains::{plan_domains_buf, plan_domains_cached, PlanArgs, PlanOut};
    use crate::plan::prim::Primitive;
    use crate::plan_buf::View;
    use serde_json::{json, Value};
    use std::collections::{HashMap, HashSet};

    /// Primitive (JSON), Inhalts-Hashes, Linienzug-Flags eines Bereichs.
    fn range(bytes: &[u8], from: usize, to: usize, out: &mut (Vec<Primitive>, Vec<f64>, Vec<bool>)) {
        let v = View::parse(bytes).expect("Puffer lesbar");
        let prims = v.prims().expect("Primitive lesbar");
        for i in from..to {
            out.0.push(prims[i].clone());
            out.1.push(v.hash(i).unwrap_or(-1.0));
            out.2.push(i > from && v.rec(i).is_some_and(|r| r.flags & crate::plan_buf::F_CHAIN != 0));
        }
    }

    /// Inhalt ohne Cache: alle Gruppen hintereinander, Ausmass.
    pub(crate) fn plain(bytes: &[u8]) -> (String, Vec<f64>, Vec<bool>, Option<[f64; 4]>) {
        let v = View::parse(bytes).unwrap();
        let mut o = (vec![], vec![], vec![]);
        range(bytes, 0, v.len(), &mut o);
        (serde_json::to_string(&o.0).unwrap(), o.1, o.2, v.bounds())
    }

    /// Inhalt mit Cache: Haupt-Puffer mit den Stücken (aus der Antwort oder `store`) an Stelle der
    /// Gruppe 6; `store` wird zum Stand dieser Antwort.
    pub(crate) fn assembled(out: &PlanOut, store: &mut HashMap<u64, Vec<u8>>) -> (String, Vec<f64>, Vec<bool>, Option<[f64; 4]>) {
        let v = View::parse(&out.main).unwrap();
        let g = v.groups().unwrap();
        // Gruppe der Zeichnungen (nach Schatten/Baurecht und Decken … Stützen).
        assert_eq!(g.len(), 12);
        let dg = 7;
        assert_eq!(g[dg].0, g[dg].1, "Gruppe der Zeichnungen im Haupt-Puffer leer");
        let mut o = (vec![], vec![], vec![]);
        range(&out.main, 0, g[dg].0, &mut o);
        let mut next = HashMap::new();
        for (k, b) in &out.chunks {
            let bytes = b.clone().unwrap_or_else(|| store.get(k).expect("Stück fehlt beim Aufrufer").clone());
            let n = View::parse(&bytes).unwrap().len();
            range(&bytes, 0, n, &mut o);
            next.insert(*k, bytes);
        }
        range(&out.main, g[dg + 1].0, v.len(), &mut o);
        *store = next;
        (serde_json::to_string(&o.0).unwrap(), o.1, o.2, v.bounds())
    }

    /// Deterministischer Zufall.
    pub(crate) struct Rng(pub u64);
    impl Rng {
        pub fn next(&mut self) -> f64 {
            self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            (self.0 >> 11) as f64 / (1u64 << 53) as f64
        }
        pub fn below(&mut self, n: usize) -> usize {
            ((self.next() * n as f64) as usize).min(n.saturating_sub(1))
        }
        fn pt(&mut self) -> Value {
            json!({"x": (self.next() * 20.0 - 5.0), "y": (self.next() * 12.0 - 3.0)})
        }
    }

    /// Eine zufällige 2D-Zeichnung (alle wichtigen Formen und Stil-Varianten).
    pub(crate) fn random_drawing(r: &mut Rng, id: &str) -> Value {
        let geom = match r.below(12) {
            0 => json!({"shape": "line", "a": r.pt(), "b": r.pt()}),
            1 => {
                let n = 2 + r.below(4);
                let pts: Vec<Value> = (0..n).map(|_| r.pt()).collect();
                let mut g = json!({"shape": "polyline", "pts": pts, "closed": r.next() < 0.5});
                if r.next() < 0.3 {
                    g["bulge"] = json!((0..n).map(|_| if r.next() < 0.5 { 0.0 } else { r.next() - 0.5 }).collect::<Vec<f64>>());
                }
                g
            }
            2 => json!({"shape": "rect", "min": {"x": 0, "y": 0}, "max": r.pt()}),
            3 => json!({"shape": "circle", "center": r.pt(), "r": 0.2 + r.next()}),
            4 => json!({"shape": "arc", "center": r.pt(), "r": 0.5 + r.next(), "a0": r.next(), "a1": 2.0 + r.next()}),
            5 => json!({"shape": "text", "at": r.pt(), "text": format!("T{}", r.below(100)), "height": 0.25, "angle": 0.0}),
            6 => json!({"shape": "dimension", "pts": [r.pt(), r.pt()], "offset": 0.5}),
            7 => json!({"shape": "kote", "at": r.pt(), "value": r.next() * 3.0, "kind": "okFertig", "rotation": 0.0}),
            8 => json!({"shape": "xline", "a": r.pt(), "b": r.pt()}),
            9 => json!({"shape": "block", "blockDefId": "blk", "at": r.pt(), "rotation": r.next()}),
            10 => json!({"shape": "ellipse", "center": r.pt(), "rx": 1.0, "ry": 0.5, "rotation": r.next()}),
            _ => json!({"shape": "pointmarker", "at": r.pt()}),
        };
        let mut d = json!({
            "id": id, "type": "drawing2d",
            "levelId": if r.next() < 0.8 { "eg" } else { "og" },
            "categoryCode": (["20", "30", "60", "99", "21"][r.below(5)]),
            "geom": geom,
        });
        if r.next() < 0.3 {
            d["color"] = json!(["#ff0000", "#00aa00", "#123456"][r.below(3)]);
        }
        if r.next() < 0.3 {
            d["lineStyleId"] = json!(["thin", "hatch-dash", "medium"][r.below(3)]);
        }
        if r.next() < 0.2 {
            d["weightMm"] = json!(0.1 + r.next());
        }
        if r.next() < 0.1 {
            d["opacity"] = json!(r.next());
        }
        if r.next() < 0.1 {
            d["endMarks"] = json!({"start": "arrow", "end": "dot"});
        }
        if r.next() < 0.05 {
            d["noPrint"] = json!(true);
        }
        d
    }

    fn ops(v: Value) -> Vec<Op> {
        v.as_array().unwrap().iter().map(|o| Op::from_json(o).unwrap()).collect()
    }

    pub(crate) fn random_args(r: &mut Rng) -> PlanArgs {
        let codes = ["00", "01", "05", "20", "21", "22", "25", "30", "31", "35", "40", "50", "60", "90", "99"];
        let show: Vec<&str> = codes.iter().copied().filter(|_| r.next() < 0.85).collect();
        let grey: Vec<&str> = show.iter().copied().filter(|_| r.next() < 0.2).collect();
        let t = json!({
            "floor": if r.next() < 0.7 { "eg" } else { "og" },
            "show": show, "grey": grey,
            "referenceLines": r.next() < 0.3, "global": r.next() < 0.7,
            "scale": ([100.0, 50.0, 200.0][r.below(3)]),
            "forPrint": r.next() < 0.2, "compact": r.next() < 0.4,
            "mono": r.next() < 0.25,
            "sunWhen": (if r.next() < 0.7 { json!(1_750_000_000_000.0 + r.next() * 3e10) } else { Value::Null }),
        });
        PlanArgs::parse([0.0, 1.0, 2.0][r.below(3)], &t.to_string()).unwrap()
    }

    /// Projekt-Dokument: Beispielprojekt mit `n` zufälligen Zeichnungen und einem Block.
    pub(crate) fn random_doc(r: &mut Rng, n: usize) -> Document {
        let mut base: Value = serde_json::from_str(include_str!("../../tests/fixtures/sample_project.json")).unwrap();
        base["drawings2d"] = Value::Array((0..n).map(|i| random_drawing(r, &format!("d{i}"))).collect());
        base["blockDefs"] = json!([{"id": "blk", "name": "B", "geom2d": [
            {"shape": "line", "a": {"x": 0, "y": 0}, "b": {"x": 1, "y": 0}},
            {"shape": "circle", "center": {"x": 0, "y": 0}, "r": 0.3}]}]);
        // Abzugskörper durch Wand und Decke, Schattenstudie, Baurecht, Strichstärken nach Massstab.
        base["extrudedSolids"] = json!([
            {"id": "v1", "type": "extrudedSolid", "levelId": "eg", "operation": "subtract", "height": 3,
             "points": [{"x": 1, "y": -0.5}, {"x": 1.4, "y": -0.5}, {"x": 1.4, "y": 0.5}, {"x": 1, "y": 0.5}]},
            {"id": "v2", "type": "extrudedSolid", "levelId": "eg", "operation": "subtract", "height": 0.5, "baseOffset": 2.6,
             "points": [{"x": 3, "y": 1}, {"x": 3.6, "y": 1}, {"x": 3.6, "y": 2}, {"x": 3, "y": 2}]},
            {"id": "s1", "type": "extrudedSolid", "levelId": "eg", "height": 2,
             "points": [{"x": 7, "y": 0}, {"x": 9, "y": 0}, {"x": 9, "y": 2}, {"x": 7, "y": 2}]}]);
        base["sunStudy"] = json!({"when": "2026-06-21T12:00:00Z", "show": true});
        base["siteRules"] = json!({"parcel": [{"x": -3, "y": -3}, {"x": 8, "y": -3}, {"x": 8, "y": 7}, {"x": -3, "y": 7}], "defaultSetback": 2.5});
        base["scaleLineWeights"] = json!(r.next() < 0.5);
        Document::from_json(&base.to_string()).unwrap()
    }

    /// Eine zufällige Änderung (Zeichnungen ersetzen/einfügen/entfernen/umordnen, Linienstile,
    /// Ebenen, Wände, Ansichten); `None` = keine.
    pub(crate) fn random_change(doc: &Document, r: &mut Rng, step: usize) -> Option<Vec<Op>> {
        let n = doc.field("drawings2d").and_then(Value::as_array).map_or(0, Vec::len);
        let id_at = |i: usize| doc.field("drawings2d").unwrap()[i]["id"].as_str().unwrap().to_owned();
        let k = r.below(20);
        let o = if k < 9 && n > 0 {
            let id = id_at(r.below(n));
            let mut d = random_drawing(r, &id);
            if r.next() < 0.5 {
                d = doc.field("drawings2d").unwrap().as_array().unwrap().iter().find(|e| e["id"] == id.as_str()).unwrap().clone();
                d["color"] = json!(format!("#{:06x}", r.below(0xffffff)));
            }
            json!([{"kind": "replace", "collection": "drawings2d", "entity": d}])
        } else if k < 11 {
            json!([{"kind": "add", "collection": "drawings2d", "items": [random_drawing(r, &format!("n{step}"))], "at": r.below(n + 1)}])
        } else if k < 13 && n > 0 {
            json!([{"kind": "remove", "collection": "drawings2d", "ids": [id_at(r.below(n))]}])
        } else if k == 13 && n > 1 {
            json!([{"kind": "reorder", "collection": "drawings2d", "ids": [id_at(r.below(n)), id_at(0)]}])
        } else if k == 14 {
            let mut ls = doc.field("lineStyles").unwrap().clone();
            ls[1]["color"] = json!(format!("#{:06x}", r.below(0xffffff)));
            json!([{"kind": "setField", "key": "lineStyles", "value": ls}])
        } else if k == 15 {
            let mut l = doc.field("layers").unwrap().clone();
            l[3]["color"] = json!(format!("#{:06x}", r.below(0xffffff)));
            json!([{"kind": "setField", "key": "layers", "value": l}])
        } else if k == 16 {
            let mut w = doc.field("walls").unwrap()[0].clone();
            w["height"] = json!(2.0 + r.next());
            w["end"]["x"] = json!(w["end"]["x"].as_f64().unwrap() + r.next() * 0.1);
            json!([{"kind": "replace", "collection": "walls", "entity": w}])
        } else if k == 17 {
            json!([{"kind": "setField", "key": "viewSnapshots", "value": [{"id": format!("v{step}")}]}])
        } else {
            return None;
        };
        Some(ops(o))
    }

    /// Messung (von Hand): `PLAN_BIG=projekt.obp cargo test --release --lib messung_plan_cache -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn messung_plan_cache() {
        let Ok(path) = std::env::var("PLAN_BIG") else { return };
        let mut doc = Document::from_json(&std::fs::read_to_string(path).unwrap()).unwrap();
        let p = doc.project().unwrap().clone();
        let codes: Vec<String> = p.flat_categories().iter().map(|c| c.code.clone()).chain(p.drawings2d.iter().map(|d| d.category_code.clone())).collect();
        let floor = p.drawing_levels.iter().find(|l| l.kind == crate::model::DrawingLevelKind::Floor).unwrap().id.clone();
        let t = json!({ "floor": floor, "show": codes, "grey": [], "global": true }).to_string();
        let a = PlanArgs::parse(1.0, &t).unwrap();
        let time = |name: &str, f: &mut dyn FnMut()| {
            f();
            let t0 = std::time::Instant::now();
            for _ in 0..5 {
                f();
            }
            println!("{name}: {:.2} ms", t0.elapsed().as_secs_f64() * 1000.0 / 5.0);
        };
        time("ohne Cache", &mut || {
            plan_domains_buf(&p, &a).unwrap();
        });
        let mut have: HashSet<u64> = HashSet::new();
        let mut sent = 0;
        let call = |doc: &mut Document, have: &mut HashSet<u64>, sent: &mut usize| {
            let (p, revs, cache) = doc.project_cached().unwrap();
            let o = plan_domains_cached(p, revs, cache, &a, have).unwrap();
            *sent = o.encode().len();
            *have = o.chunks.iter().map(|c| c.0).collect();
        };
        time("mit Cache, unverändert", &mut || call(&mut doc, &mut have, &mut sent));
        println!("  Antwort {} KiB, {} Stücke", sent / 1024, have.len());
        let mut i = 0;
        time("mit Cache, nach einer Änderung", &mut || {
            i += 1;
            let mut d = doc.field("drawings2d").unwrap()[i * 7].clone();
            d["color"] = json!(if i % 2 == 0 { "#ff0000" } else { "#00ff00" });
            doc.commit(ops(json!([{"kind": "replace", "collection": "drawings2d", "entity": d}])), None, i as f64 * 1e4, false).unwrap();
            call(&mut doc, &mut have, &mut sent);
        });
        println!("  Antwort {} KiB", sent / 1024);
        time("mit Cache, ohne gehaltene Stücke", &mut || call(&mut doc, &mut HashSet::new(), &mut sent));
        println!("  Antwort {} KiB", sent / 1024);
    }

    /// Mit Cache = ohne Cache (Primitive, Inhalts-Hashes, Linienzüge, Ausmass) über zufällige
    /// Änderungen samt Undo und Laden, wechselnde Argumente (Geschoss, Sichtbarkeit, Dimmen, kompakt,
    /// Massstab, Detail) und einen Aufrufer, der Stücke behält, verliert oder nie hatte. Dazu: die
    /// elementweise nachgeführte typisierte Sicht = neu gelesen.
    #[test]
    fn mit_cache_wie_ohne() {
        let mut r = Rng(11);
        let mut doc = random_doc(&mut r, 400);
        let mut sets: Vec<PlanArgs> = (0..3).map(|_| random_args(&mut r)).collect();
        let mut stores: Vec<HashMap<u64, Vec<u8>>> = vec![HashMap::new(); 3];
        let (mut reused, mut total) = (0usize, 0usize);
        for step in 0..90 {
            if let Some(o) = random_change(&doc, &mut r, step) {
                doc.commit(o, None, step as f64 * 1000.0, false).unwrap();
            }
            if step % 13 == 7 {
                let k = r.below(3);
                sets[k] = random_args(&mut r);
                stores[k].clear();
            }
            if step % 37 == 5 {
                doc.undo();
            }
            if step == 50 {
                let text = doc.to_json();
                doc.load(serde_json::from_str(&text).unwrap());
            }
            if step % 3 == 0 {
                let whole: crate::model::Project = serde_json::from_str(&doc.to_json()).unwrap();
                assert_eq!(serde_json::to_value(doc.project().unwrap()).unwrap(), serde_json::to_value(&whole).unwrap(), "Schritt {step}: typisierte Sicht");
            }
            for (a, store) in sets.iter().zip(stores.iter_mut()) {
                let fresh = plain(&plan_domains_buf(doc.project().unwrap(), a).unwrap());
                // Der Aufrufer verliert manchmal Stücke.
                let have: HashSet<u64> = store.keys().copied().filter(|_| r.next() < 0.9).collect();
                store.retain(|k, _| have.contains(k));
                let (p, revs, cache) = doc.project_cached().unwrap();
                let out = plan_domains_cached(p, revs, cache, a, &have).unwrap();
                reused += out.chunks.iter().filter(|c| c.1.is_none()).count();
                total += out.chunks.len();
                assert_eq!(assembled(&out, store), fresh, "Schritt {step}: mit Cache anders als ohne");
            }
        }
        assert!(reused * 2 > total && total > 200, "Stücke kaum wiederverwendet: {reused}/{total}");
    }
}
