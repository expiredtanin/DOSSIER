//! Inkrementelle 3D-Ableitung ([58]): Cache der Wandkörper und der Öffnungs-Einbauteile je Wand, damit
//! eine Änderung an EINER Wand oder Öffnung nicht das ganze Modell neu rechnet und neu schreibt.
//!
//! Gültigkeit (im Zweifel verwerfen):
//! - Alles verworfen, wenn sich ein anderes Feld als Wände/Öffnungen ändert (Typen, Materialien,
//!   Geschosse, Decken, Dächer …: `Revs::max_except`), bei neuer Epoche (Laden) oder wenn die
//!   Material-Liste der Wände (`wall_material_color_maps`, Index je Schicht) anders ausfällt.
//! - Verschneidung je Geschoss: neu, wenn sich ihre Eingabe (Lage, Referenz, Schichten der Wände des
//!   Geschosses) dem Wert nach ändert.
//! - Je Wand (Schlüssel: Element-Stand der Wand, `Revs::items`): gültig bei gleichen Element-Ständen der
//!   gehosteten Öffnungen und — für die Körper — gleichen Schnittlinien aus der Verschneidung.
//!
//! Ergebnis inhaltlich und als JSON Byte für Byte gleich wie [`model3d::parts`] (Test unten).

use crate::joins::{JoinWall, WallCuts};
use crate::model::{Opening, Project};
use crate::model3d::{self, Parts, RMesh, RWall, WallOpeningMeshes};
use std::collections::HashMap;

/// Felder, die das 3D-Modell nicht lesen oder die der Cache selbst je Element verfolgt.
const NOT_GLOBAL: &[&str] = &["walls", "openings", "drawings2d", "viewSnapshots", "viewSnapshotFolders", "viewTemplates"];

#[derive(Debug)]
struct WallEntry {
    openings: Vec<u64>,
    cuts: WallCuts,
    pieces: Vec<RWall>,
    /// `pieces` als JSON ohne die äusseren Klammern (leer bei keinem Körper).
    json: String,
}

#[derive(Debug)]
struct OpenEntry {
    openings: Vec<u64>,
    meshes: WallOpeningMeshes,
    /// Je Liste (3 Durchgänge, Zargen, Formöffnungen) JSON ohne Klammern.
    json: [String; 5],
}

#[derive(Debug)]
struct JoinEntry {
    input: Vec<JoinWall>,
    finite: bool,
    cuts: Vec<WallCuts>,
}

/// Cache eines Dokuments (`Document::model3d_parts`).
/// Kopie eines Dokuments (`Clone`) beginnt mit leerem Cache.
#[derive(Debug, Default)]
pub struct Model3dCache {
    sig: Option<(u64, u64)>,
    maps: Vec<String>,
    joins: HashMap<String, JoinEntry>,
    /// Je `layered` (0/1): Wand-Stand → Körper.
    walls: [HashMap<u64, WallEntry>; 2],
    /// Je Detailgrad (Bits): Wand-Stand → Einbauteile.
    openings: Vec<(u64, HashMap<u64, OpenEntry>)>,
    /// Statistik (Tests): Wände/Öffnungs-Wände, die im letzten Aufruf neu gerechnet wurden.
    pub last_rebuilt: (usize, usize),
}

/// Ergebnis: die Teile (Wände/Öffnungen nur mit `structs`) und das JSON wie `serde_json::to_string(&parts)`.
pub struct CachedParts {
    pub parts: Parts,
    pub json: String,
}

fn inner_json<T: serde::Serialize>(v: &[T]) -> String {
    let s = serde_json::to_string(v).unwrap_or_else(|_| "[]".into());
    s[1..s.len() - 1].to_owned()
}

fn join_json<'a>(out: &mut String, parts: impl Iterator<Item = &'a str>) {
    let mut first = true;
    for s in parts.filter(|s| !s.is_empty()) {
        if !first {
            out.push(',');
        }
        out.push_str(s);
        first = false;
    }
}

impl Model3dCache {
    fn validate(&mut self, p: &Project, revs: &crate::document::Revs) {
        let sig = (revs.epoch(), revs.max_except(NOT_GLOBAL));
        let maps = model3d::wall_material_color_maps(p);
        if self.sig != Some(sig) || self.maps != maps {
            *self = Model3dCache { sig: Some(sig), maps, ..Default::default() };
        }
    }

    /// Schnittlinien je Wand (wie `compute_joins_by_floor`), Geschosse mit unveränderter Eingabe aus dem Cache.
    fn joins(&mut self, p: &Project) -> HashMap<String, WallCuts> {
        let mut merged = HashMap::new();
        let mut keep: HashMap<String, JoinEntry> = HashMap::new();
        for (floor, idx) in model3d::floor_groups(p) {
            let (input, finite) = model3d::floor_join_input(p, &idx);
            let e = match self.joins.remove(floor) {
                Some(e) if e.finite == finite && e.input == input => e,
                _ => {
                    let cuts = model3d::floor_join_cuts(&input, finite);
                    JoinEntry { input, finite, cuts }
                }
            };
            for (&i, c) in idx.iter().zip(&e.cuts) {
                merged.insert(p.walls[i].id.clone(), c.clone());
            }
            keep.insert(floor.to_owned(), e);
        }
        self.joins = keep;
        merged
    }

    /// Wie [`model3d::parts`] (ohne Explosion), Wände und Öffnungs-Einbauteile je Wand aus dem Cache.
    /// `structs`: auch die Wände/Öffnungs-Meshes als Werte liefern (Abzugskörper); sonst leer, nur im JSON.
    pub fn parts(&mut self, p: &Project, revs: &crate::document::Revs, wall_stamps: &[u64], opening_stamps: &[u64], layered: bool, detail: f64, for_section: bool, structs: bool) -> Result<CachedParts, String> {
        self.validate(p, revs);
        let openings = p.openings.as_deref().unwrap_or(&[]);
        if wall_stamps.len() != p.walls.len() || opening_stamps.len() != openings.len() {
            return Err("Element-Stände passen nicht zum Projekt".into());
        }
        // Gehostete Öffnungen je Wand-id in Projekt-Reihenfolge (wie `openings_by_wall`), mit Stand.
        let mut by_wall: HashMap<&str, Vec<usize>> = HashMap::new();
        for (i, o) in openings.iter().enumerate() {
            by_wall.entry(o.host_wall_id.as_str()).or_default().push(i);
        }
        let hosted = |id: &str| by_wall.get(id).map_or(&[][..], |v| v.as_slice());

        // Wandkörper.
        let joins = if layered { Some(self.joins(p)) } else { None };
        let mut contexts: HashMap<&str, crate::wall_bands::FloorContext> = HashMap::new();
        let mut old = std::mem::take(&mut self.walls[layered as usize]);
        let mut fresh: HashMap<u64, WallEntry> = HashMap::with_capacity(p.walls.len());
        let mut rebuilt = (0, 0);
        for (wi, wall) in p.walls.iter().enumerate() {
            let stamp = wall_stamps[wi];
            let os: Vec<u64> = hosted(&wall.id).iter().map(|&i| opening_stamps[i]).collect();
            let cuts = if layered { joins.as_ref().and_then(|j| j.get(&wall.id)).cloned().unwrap_or_default() } else { WallCuts::default() };
            let e = match old.remove(&stamp) {
                Some(e) if e.openings == os && e.cuts == cuts => e,
                _ => {
                    rebuilt.0 += 1;
                    let ctx = contexts.entry(wall.floor_id.as_str()).or_insert_with(|| model3d::floor_context(p, &wall.floor_id, layered));
                    let refs: Vec<&Opening> = hosted(&wall.id).iter().map(|&i| &openings[i]).collect();
                    let mut pieces = Vec::new();
                    model3d::wall_pieces(p, &self.maps, wall, ctx, &refs, cuts.clone(), layered, true, &mut pieces);
                    let json = inner_json(&pieces);
                    WallEntry { openings: os, cuts, pieces, json }
                }
            };
            fresh.insert(stamp, e);
        }
        // Öffnungs-Einbauteile (Bogenwände: ganz ohne Cache, s. `emit_opening_meshes`).
        let arcs = p.walls.iter().any(|w| crate::wall_arc::WallArc::of_wall(w).is_some());
        let dkey = detail.to_bits();
        let slot = match self.openings.iter().position(|(k, _)| *k == dkey) {
            Some(i) => i,
            None => {
                if self.openings.len() >= 3 {
                    self.openings.remove(0);
                }
                self.openings.push((dkey, HashMap::new()));
                self.openings.len() - 1
            }
        };
        let mut open_fresh: HashMap<u64, OpenEntry> = HashMap::new();
        let mut opening_json = String::new();
        let mut opening_structs: Vec<RMesh> = Vec::new();
        if arcs {
            self.openings[slot].1.clear();
            let m = model3d::emit_opening_meshes(p, detail);
            opening_json = inner_json(&m);
            if structs {
                opening_structs = m;
            }
        } else {
            let mut old_open = std::mem::take(&mut self.openings[slot].1);
            for (wi, wall) in p.walls.iter().enumerate() {
                let stamp = wall_stamps[wi];
                let os: Vec<u64> = hosted(&wall.id).iter().map(|&i| opening_stamps[i]).collect();
                let e = match old_open.remove(&stamp) {
                    Some(e) if e.openings == os => e,
                    _ => {
                        rebuilt.1 += 1;
                        let refs: Vec<&Opening> = hosted(&wall.id).iter().map(|&i| &openings[i]).collect();
                        let meshes = model3d::wall_opening_meshes(p, wall, &refs, detail);
                        let json = [&meshes.passes[0], &meshes.passes[1], &meshes.passes[2], &meshes.zargen, &meshes.shaped].map(|v| inner_json(v));
                        OpenEntry { openings: os, meshes, json }
                    }
                };
                open_fresh.insert(stamp, e);
            }
            let surface = model3d::surface_window_meshes(p);
            let order = || wall_stamps.iter().map(|s| &open_fresh[s]);
            let surface_json = inner_json(&surface);
            let lists: Vec<String> = (0..5)
                .map(|k| {
                    let mut s = String::new();
                    join_json(&mut s, order().map(|e| e.json[k].as_str()));
                    s
                })
                .collect();
            join_json(&mut opening_json, lists.iter().map(String::as_str).chain([surface_json.as_str()]));
            if structs {
                opening_structs = model3d::assemble_opening_meshes(order().map(|e| e.meshes.clone()).collect());
                opening_structs.extend(surface);
            }
            self.openings[slot].1 = open_fresh;
        }
        self.last_rebuilt = rebuilt;

        let mut slabs = model3d::emit_slabs(p);
        slabs.extend(model3d::emit_stairs(p, for_section));
        let mut parts = Parts {
            walls: Vec::new(),
            slabs,
            context_meshes: model3d::emit_context_meshes(p),
            column_meshes: model3d::emit_columns(p),
            opening_meshes: opening_structs,
            stair_meshes: model3d::emit_stair_meshes(p),
            stair_railings: model3d::emit_stair_railings(p),
            roof_meshes: model3d::emit_roofs(p, None)?,
            roof_layers: model3d::emit_roof_cut_layers(p)?,
        };
        let mut json = String::with_capacity(fresh.values().map(|e| e.json.len() + 1).sum::<usize>() + opening_json.len() + 4096);
        json.push_str("{\"walls\":[");
        join_json(&mut json, wall_stamps.iter().map(|s| fresh[s].json.as_str()));
        json.push_str("],\"slabs\":");
        json.push_str(&js(&parts.slabs)?);
        json.push_str(",\"contextMeshes\":");
        json.push_str(&js(&parts.context_meshes)?);
        json.push_str(",\"columnMeshes\":");
        json.push_str(&js(&parts.column_meshes)?);
        json.push_str(",\"openingMeshes\":[");
        json.push_str(&opening_json);
        json.push_str("],\"stairMeshes\":");
        json.push_str(&js(&parts.stair_meshes)?);
        json.push_str(",\"stairRailings\":");
        json.push_str(&js(&parts.stair_railings)?);
        json.push_str(",\"roofMeshes\":");
        json.push_str(&js(&parts.roof_meshes)?);
        json.push_str(",\"roofLayers\":");
        json.push_str(&js(&parts.roof_layers)?);
        json.push('}');
        if structs {
            parts.walls = wall_stamps.iter().flat_map(|s| fresh[s].pieces.iter().cloned()).collect();
        }
        self.walls[layered as usize] = fresh;
        Ok(CachedParts { parts, json })
    }
}

fn js<T: serde::Serialize>(v: &T) -> Result<String, String> {
    serde_json::to_string(v).map_err(|e| e.to_string())
}

impl Clone for Model3dCache {
    fn clone(&self) -> Self {
        Model3dCache::default()
    }
}

#[cfg(test)]
mod tests {
    use crate::document::Document;
    use crate::ops::Op;
    use serde_json::{json, Value};

    const ARGS: [[f64; 5]; 4] = [[1.0, 2.0, 0.0, 0.0, 0.0], [1.0, 0.0, 0.0, 1.0, 0.0], [0.0, 1.0, 1.0, 0.0, 0.0], [1.0, 2.0, 0.0, 1.0, 0.0]];

    /// Inkrementell (Cache des Dokuments) = voll (`queries::run` auf einer Kopie), Byte für Byte.
    fn check(d: &mut Document, step: &str) {
        let p = d.project().unwrap().clone();
        for a in ARGS {
            let inc = crate::queries::run_doc(d, "model3dParts", &a, "").unwrap();
            let full = crate::queries::run(&p, "model3dParts", &a, "").unwrap();
            assert!(inc == full, "{step}: model3dParts {a:?} weicht ab ({} / {} Zeichen)", inc.len(), full.len());
        }
    }

    fn list(d: &Document, key: &str) -> Vec<Value> {
        d.root().get(key).and_then(Value::as_array).cloned().unwrap_or_default()
    }

    fn sample() -> Document {
        Document::from_json(include_str!("../tests/fixtures/sample_project.json")).unwrap()
    }

    /// Eine Folge gemischter Änderungen (Wände, Öffnungen, Typen, Struktur, Undo/Redo): nach jedem Schritt gleich.
    #[test]
    fn incremental_equals_full_after_edits() {
        let mut d = sample();
        check(&mut d, "start");
        let mut seed: u64 = 0x5eed;
        let mut rnd = |n: usize| {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            ((seed >> 33) as usize) % n.max(1)
        };
        let mut kinds = [0usize; 11];
        for step in 0..80 {
            let walls = list(&d, "walls");
            let openings = list(&d, "openings");
            let kind = rnd(11);
            let ops: Vec<Op> = match kind {
                0 | 1 => {
                    let mut w = walls[rnd(walls.len())].clone();
                    let h = w["height"].as_f64().unwrap_or(2.6);
                    w["height"] = json!(h + 0.1);
                    vec![Op::Replace { collection: "walls".into(), entity: w }]
                }
                2 => {
                    // Endpunkt verschieben: ändert die Verschneidung der Nachbarn.
                    let mut w = walls[rnd(walls.len())].clone();
                    let x = w["end"]["x"].as_f64().unwrap_or(0.0);
                    w["end"]["x"] = json!(x + 0.05);
                    vec![Op::Replace { collection: "walls".into(), entity: w }]
                }
                3 if !openings.is_empty() => {
                    let mut o = openings[rnd(openings.len())].clone();
                    let wd = o["width"].as_f64().unwrap_or(1.0);
                    o["width"] = json!(wd * 0.9);
                    vec![Op::Replace { collection: "openings".into(), entity: o }]
                }
                4 if !openings.is_empty() => {
                    // Öffnung in eine andere Wand umhängen.
                    let mut o = openings[rnd(openings.len())].clone();
                    o["hostWallId"] = walls[rnd(walls.len())]["id"].clone();
                    vec![Op::Replace { collection: "openings".into(), entity: o }]
                }
                5 => {
                    let mut w = walls[rnd(walls.len())].clone();
                    w["id"] = json!(format!("neu{step}"));
                    w["start"]["y"] = json!(w["start"]["y"].as_f64().unwrap_or(0.0) + 0.3);
                    vec![Op::Add { collection: "walls".into(), items: vec![w], at: Some(rnd(walls.len())) }]
                }
                6 if walls.len() > 3 => vec![Op::Remove { collection: "walls".into(), ids: vec![walls[rnd(walls.len())]["id"].as_str().unwrap().to_owned()] }],
                7 => {
                    // Wandtyp ändern (globales Feld): alles neu.
                    let mut ts = list(&d, "wallTypes");
                    let t = rnd(ts.len());
                    if let Some(l) = ts[t]["layers"].get_mut(0) {
                        let th = l["thickness"].as_f64().unwrap_or(0.1);
                        l["thickness"] = json!(th + 0.01);
                    }
                    vec![Op::Replace { collection: "wallTypes".into(), entity: ts.swap_remove(t) }]
                }
                8 => {
                    if d.undo().is_some() {
                        kinds[kind] += 1;
                        check(&mut d, &format!("Schritt {step} (undo)"));
                    }
                    continue;
                }
                9 => {
                    if d.redo().is_some() {
                        kinds[kind] += 1;
                        check(&mut d, &format!("Schritt {step} (redo)"));
                    }
                    continue;
                }
                _ => {
                    let ids: Vec<String> = walls.iter().rev().map(|w| w["id"].as_str().unwrap().to_owned()).collect();
                    vec![Op::Reorder { collection: "walls".into(), ids }]
                }
            };
            kinds[kind] += 1;
            d.commit(ops, None, step as f64, false).unwrap_or_else(|e| panic!("Schritt {step}: {e:?}"));
            check(&mut d, &format!("Schritt {step} (Art {kind})"));
        }
        // Jede Art kam vor (sonst prüft die Folge weniger als gedacht).
        assert!(kinds.iter().all(|&k| k > 0), "{kinds:?}");
    }

    /// Eine Wandhöhe ändern: nur diese Wand (Körper und Einbauteile) wird neu gerechnet.
    #[test]
    fn one_wall_edit_rebuilds_one_wall() {
        let mut d = sample();
        let n = d.project().unwrap().walls.len();
        d.model3d_parts(true, 2.0, false, false).unwrap();
        assert_eq!(d.model3d_rebuilt(), (n, n));
        d.model3d_parts(true, 2.0, false, false).unwrap();
        assert_eq!(d.model3d_rebuilt(), (0, 0));
        let mut w = list(&d, "walls")[2].clone();
        w["height"] = json!(w["height"].as_f64().unwrap_or(2.6) + 0.2);
        d.commit(vec![Op::Replace { collection: "walls".into(), entity: w }], None, 0.0, false).unwrap();
        d.model3d_parts(true, 2.0, false, false).unwrap();
        assert_eq!(d.model3d_rebuilt(), (1, 1));
        // Öffnung ändern: nur ihre Wirtswand.
        let mut o = list(&d, "openings")[0].clone();
        o["width"] = json!(o["width"].as_f64().unwrap_or(1.0) - 0.1);
        d.commit(vec![Op::Replace { collection: "openings".into(), entity: o }], None, 1.0, false).unwrap();
        d.model3d_parts(true, 2.0, false, false).unwrap();
        assert_eq!(d.model3d_rebuilt(), (1, 1));
        d.undo();
        d.model3d_parts(true, 2.0, false, false).unwrap();
        assert_eq!(d.model3d_rebuilt(), (1, 1));
    }
}
