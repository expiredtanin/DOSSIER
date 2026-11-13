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
//! Ergebnis inhaltlich und als JSON Byte für Byte gleich wie [`model3d::parts_filtered`] (Test unten).
//!
//! [180] Klassen: Der Cache ist klassenunabhängig (`layers` zählt nicht als globale Änderung), gefiltert
//! wird beim Ausgeben ([`ClassFilter`]): Wände ausgeblendeter Klassen fallen weg; Öffnungs-Einbauteile
//! einer Wand mit teils ausgeblendeten Öffnungen kommen aus einer Variante nur mit den sichtbaren (je
//! Eintrag gemerkt, Umschalten rechnet sie nicht noch einmal).

use crate::joins::{JoinWall, WallCuts};
use crate::model::{Opening, Project};
use crate::model3d::{self, ClassFilter, Parts, RMesh, RWall, WallOpeningMeshes};
use std::collections::HashMap;

/// Felder, die das 3D-Modell nicht lesen oder die der Cache selbst je Element verfolgt.
/// `layers` (Klassen-Baum): nur der Filter beim Ausgeben liest ihn ([180]).
const NOT_GLOBAL: &[&str] = &["walls", "openings", "drawings2d", "viewSnapshots", "viewSnapshotFolders", "viewTemplates", "layers"];

/// Laufnummern der Einträge, über alle Dokumente eindeutig: TS hält die gelieferten Einträge unter
/// dieser Nummer ([`Model3dCache::parts`] mit `delta`).
static SERIALS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn next_serial() -> u64 {
    SERIALS.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1
}

fn current_serial() -> u64 {
    SERIALS.load(std::sync::atomic::Ordering::Relaxed)
}

#[derive(Debug)]
struct WallEntry {
    serial: u64,
    openings: Vec<u64>,
    cuts: WallCuts,
    pieces: Vec<RWall>,
    /// `pieces` als JSON ohne die äusseren Klammern (leer bei keinem Körper).
    json: String,
}

#[derive(Debug)]
struct OpenEntry {
    serial: u64,
    openings: Vec<u64>,
    meshes: WallOpeningMeshes,
    /// Je Liste (3 Durchgänge, Zargen, Formöffnungen) JSON ohne Klammern.
    json: [String; 5],
    /// [180] Varianten nur mit einem Teil der Öffnungen (Maske je gehostete Öffnung, `true` = sichtbar).
    variants: Vec<(Vec<bool>, OpenVariant)>,
}

#[derive(Debug)]
struct OpenVariant {
    serial: u64,
    meshes: WallOpeningMeshes,
    json: [String; 5],
}

/// Höchstens so viele Varianten je Wand (älteste fällt weg).
const MAX_VARIANTS: usize = 4;

fn opening_json(m: &WallOpeningMeshes) -> [String; 5] {
    [&m.passes[0], &m.passes[1], &m.passes[2], &m.zargen, &m.shaped].map(|v| inner_json(v))
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
    /// [178] Decken-Eingabe je Geschoss (je `layered`) beim letzten Aufruf: Der Deckenrand hängt von den Wänden
    /// ab; ändert er sich, werden die Wände des Geschosses neu gerechnet.
    ceilings: [HashMap<String, Vec<crate::wall_bands::CeilingIn>>; 2],
    /// Je `layered` (0/1): Wand-Stand → Körper.
    walls: [HashMap<u64, WallEntry>; 2],
    /// Je Detailgrad (Bits): Wand-Stand → Einbauteile.
    openings: Vec<(u64, HashMap<u64, OpenEntry>)>,
    /// Statistik (Tests): Wände/Öffnungs-Wände, die im letzten Aufruf neu gerechnet wurden.
    pub last_rebuilt: (usize, usize),
    /// [180] Statistik (Tests): im letzten Aufruf neu gerechnete Öffnungs-Varianten (Klassen-Filter).
    pub last_variants: usize,
    /// [214] Übrige Gruppen (Decken, Treppen, Kontext, Körper, Stützen, Dächer) ungefiltert zum letzten Stand: gleich,
    /// solange keine Wand/Öffnung und kein anderes Feld (`sig`) sich ändert — die Geisterschicht fragt im selben
    /// Durchgang mit anderem Klassen-Filter, Ein-/Ausblenden ändert nur den Filter.
    /// Je Schnitt-Variante der Treppen (`for_section`) ein Eintrag.
    rest: [Option<(RestKey, Parts)>; 2],
    /// [214] Statistik (Tests): ob der letzte Aufruf die übrigen Gruppen aus `rest` nahm.
    pub last_rest_hit: bool,
    /// [214] Je übrige Gruppe (Reihenfolge wie [`ClassFilter::rest_masks`]): Laufnummer des ungefilterten Inhalts und
    /// die ausgegebenen Fassungen je Filter-Maske. Überlebt das Verwerfen (`validate`): Neu gerechnete Gruppen werden
    /// dem Wert nach verglichen, gleiche behalten ihre Laufnummer — der Viewer bekommt sie nicht noch einmal.
    groups: [[RestGroup; 8]; 2],
    /// [214] Statistik (Tests): Gruppen, deren Inhalt sich im letzten Aufruf geändert hat (Bit je Gruppe).
    pub last_groups_changed: u8,
    /// [214] Rest der Öffnungs-Einbauteile (Dach-/Deckenfenster, bei Bogenwänden alle) der letzten Antworten: Inhalt,
    /// Laufnummer, JSON ohne Klammern (gleicher Inhalt → gleiche Nummer, der Viewer bekommt ihn nicht noch einmal).
    tails: Vec<(Vec<RMesh>, u64, String)>,
    /// [214] Platten-Umrisse (Deckenauflager) je Decke, gültig bei gleichen Wänden im Höhenbereich der Platte: für die
    /// Geschoss-Kontexte und die Decken — eine Wand-Änderung rechnet nur die Decken neu, die sie berührt.
    bearing: crate::model3d::bearing::BearingMemo,
}

/// [214] Eine übrige Gruppe: Stand des ungefilterten Inhalts und die zuletzt ausgegebenen gefilterten Fassungen.
#[derive(Debug, Default)]
struct RestGroup {
    base: u64,
    outs: Vec<RestOut>,
}

/// [214] Ausgegebene Fassung einer übrigen Gruppe: zum Inhalt `base` mit Filter-Maske `mask` (`None` = alles).
#[derive(Debug)]
struct RestOut {
    base: u64,
    mask: Option<Vec<bool>>,
    serial: u64,
    json: String,
}

/// Höchstens so viele gefilterte Fassungen je übrige Gruppe (Hauptmodell, Geisterschicht, …; älteste fällt weg).
const MAX_REST_OUTS: usize = 4;

/// Gleicher Inhalt der übrigen Gruppe `i` (Reihenfolge wie [`ClassFilter::rest_masks`]).
fn group_eq(i: usize, a: &Parts, b: &Parts) -> bool {
    match i {
        0 => a.slabs == b.slabs,
        1 => a.context_meshes == b.context_meshes,
        2 => a.column_meshes == b.column_meshes,
        3 => a.stair_meshes == b.stair_meshes,
        4 => a.stair_railings == b.stair_railings,
        5 => a.roof_meshes == b.roof_meshes,
        6 => a.roof_layers == b.roof_layers,
        _ => a.solid_meshes == b.solid_meshes,
    }
}

/// JSON der übrigen Gruppe `i`, nur die Einträge der Maske (wie `retain_rest` + `serde_json::to_string`).
fn group_json(i: usize, p: &Parts, mask: Option<&[bool]>) -> Result<String, String> {
    fn masked<T: serde::Serialize>(v: &[T], mask: Option<&[bool]>) -> Result<String, String> {
        match mask {
            None => js(&v),
            Some(m) => js(&v.iter().zip(m).filter(|(_, &k)| k).map(|(x, _)| x).collect::<Vec<&T>>()),
        }
    }
    match i {
        0 => masked(&p.slabs, mask),
        1 => masked(&p.context_meshes, mask),
        2 => masked(&p.column_meshes, mask),
        3 => masked(&p.stair_meshes, mask),
        4 => masked(&p.stair_railings, mask),
        5 => masked(&p.roof_meshes, mask),
        6 => masked(&p.roof_layers, mask),
        _ => masked(&p.solid_meshes, mask),
    }
}

/// [214] Schlüssel der übrigen Gruppen: Schnitt-Variante der Treppen und Element-Stände der Wände/Öffnungen.
#[derive(Debug, PartialEq)]
struct RestKey {
    for_section: bool,
    walls: Vec<u64>,
    openings: Vec<u64>,
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
            // [214] Übrige Gruppen behalten (zum Vergleich), aber nicht als Treffer: `RestKey` ohne Stände.
            let rest = std::mem::take(&mut self.rest).map(|r| r.map(|(k, r)| (RestKey { for_section: k.for_section, walls: Vec::new(), openings: vec![u64::MAX] }, r)));
            let groups = std::mem::take(&mut self.groups);
            let tails = std::mem::take(&mut self.tails);
            *self = Model3dCache {
                sig: Some(sig),
                maps,
                rest,
                groups,
                tails,
                ..Default::default()
            };
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
            let mut cuts = e.cuts.clone();
            model3d::trim_at_columns(p, &idx, &mut cuts);
            for (&i, c) in idx.iter().zip(cuts) {
                merged.insert(p.walls[i].id.clone(), c);
            }
            keep.insert(floor.to_owned(), e);
        }
        self.joins = keep;
        merged
    }

    /// Wie [`model3d::parts`] (ohne Explosion), Wände und Öffnungs-Einbauteile je Wand aus dem Cache.
    /// `structs`: auch die Wände/Öffnungs-Meshes als Werte liefern (Abzugskörper); sonst leer, nur im JSON.
    /// `delta = Some(mark)`: JSON als Änderung gegenüber einem Aufrufer, der die Einträge bis zur Laufnummer
    /// `mark` aus seiner letzten Antwort (gleiche Argumente) noch hat, s. [`write_delta`].
    #[allow(clippy::too_many_arguments)]
    pub fn parts(
        &mut self,
        p: &Project,
        revs: &crate::document::Revs,
        wall_stamps: &[u64],
        opening_stamps: &[u64],
        layered: bool,
        detail: f64,
        for_section: bool,
        structs: bool,
        delta: Option<u64>,
        filter: &ClassFilter,
    ) -> Result<CachedParts, String> {
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
        let joins = self.joins(p);
        let mut contexts: HashMap<&str, crate::wall_bands::FloorContext> = HashMap::new();
        // [178] Geschoss-Kontexte vorab (Deckenrand aus den Wänden): geänderte Decken-Eingabe → Geschoss neu.
        let mut ctx_changed: std::collections::HashSet<&str> = std::collections::HashSet::new();
        let mut bearing = layered.then(|| crate::model3d::bearing::bearing_outlines_memo(p, &joins, wall_stamps, &mut self.bearing));
        if let Some(bearing) = &bearing {
            let mut prev = std::mem::take(&mut self.ceilings[1]);
            for wall in &p.walls {
                if contexts.contains_key(wall.floor_id.as_str()) {
                    continue;
                }
                let ctx = model3d::floor_context_from(p, &wall.floor_id, true, bearing);
                let inputs = ctx.ceiling_inputs();
                if prev.remove(&wall.floor_id).as_ref() != Some(&inputs) {
                    ctx_changed.insert(wall.floor_id.as_str());
                }
                self.ceilings[1].insert(wall.floor_id.clone(), inputs);
                contexts.insert(wall.floor_id.as_str(), ctx);
            }
        }
        let mut old = std::mem::take(&mut self.walls[layered as usize]);
        let mut fresh: HashMap<u64, WallEntry> = HashMap::with_capacity(p.walls.len());
        let mut rebuilt = (0, 0);
        for (wi, wall) in p.walls.iter().enumerate() {
            let stamp = wall_stamps[wi];
            let os: Vec<u64> = hosted(&wall.id).iter().map(|&i| opening_stamps[i]).collect();
            let cuts = joins.get(&wall.id).map_or_else(WallCuts::default, |c| if layered { c.clone() } else { model3d::section_cuts(c) });
            let e = match old.remove(&stamp) {
                Some(e) if e.openings == os && e.cuts == cuts && !ctx_changed.contains(wall.floor_id.as_str()) => e,
                _ => {
                    rebuilt.0 += 1;
                    let ctx = contexts.entry(wall.floor_id.as_str()).or_insert_with(|| model3d::floor_context_with(p, &wall.floor_id, layered, Some(&joins)));
                    let refs: Vec<&Opening> = hosted(&wall.id).iter().map(|&i| &openings[i]).collect();
                    let mut pieces = Vec::new();
                    model3d::wall_pieces(p, &self.maps, wall, ctx, &refs, cuts.clone(), layered, true, &mut pieces);
                    let json = inner_json(&pieces);
                    WallEntry {
                        serial: next_serial(),
                        openings: os,
                        cuts,
                        pieces,
                        json,
                    }
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
        let mut arc_meshes: Option<Vec<RMesh>> = None;
        if arcs {
            self.openings[slot].1.clear();
            arc_meshes = Some(model3d::emit_opening_meshes_with(p, detail, &|o| filter.keep_opening(o)));
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
                        let json = opening_json(&meshes);
                        OpenEntry {
                            serial: next_serial(),
                            openings: os,
                            meshes,
                            json,
                            variants: Vec::new(),
                        }
                    }
                };
                open_fresh.insert(stamp, e);
            }
        }
        self.last_rebuilt = rebuilt;
        // [180] Öffnungs-Varianten der Wände mit teils ausgeblendeten Öffnungen (Maske je gehostete Öffnung).
        let masks: Vec<Vec<bool>> = if arcs {
            Vec::new()
        } else {
            p.walls.iter().map(|w| hosted(&w.id).iter().map(|&i| filter.keep_opening(&openings[i])).collect()).collect()
        };
        let mut variants_built = 0;
        for (wi, wall) in p.walls.iter().enumerate() {
            let Some(mask) = masks.get(wi) else { break };
            if mask.iter().all(|&b| b) || !mask.iter().any(|&b| b) {
                continue;
            }
            let Some(e) = open_fresh.get_mut(&wall_stamps[wi]) else { continue };
            if e.variants.iter().any(|(m, _)| m == mask) {
                continue;
            }
            variants_built += 1;
            let refs: Vec<&Opening> = hosted(&wall.id).iter().zip(mask).filter(|(_, &k)| k).map(|(&i, _)| &openings[i]).collect();
            let meshes = model3d::wall_opening_meshes(p, wall, &refs, detail);
            let json = opening_json(&meshes);
            if e.variants.len() >= MAX_VARIANTS {
                e.variants.remove(0);
            }
            e.variants.push((mask.clone(), OpenVariant { serial: next_serial(), meshes, json }));
        }
        self.last_variants = variants_built;

        // [214] Übrige Gruppen: aus `rest`, solange Stände und Variante gleich sind (sonst neu, mit den schon
        // bekannten Schnittlinien fürs Deckenauflager).
        let key = RestKey { for_section, walls: wall_stamps.to_vec(), openings: opening_stamps.to_vec() };
        let var = for_section as usize;
        self.last_rest_hit = matches!(&self.rest[var], Some((k, _)) if *k == key);
        self.last_groups_changed = 0;
        if !self.last_rest_hit {
            let bearing = bearing.get_or_insert_with(|| crate::model3d::bearing::bearing_outlines_memo(p, &joins, wall_stamps, &mut self.bearing));
            let mut slabs = model3d::emit_slabs_from(p, bearing);
            slabs.extend(model3d::emit_stairs(p, for_section));
            let all = Parts {
                walls: Vec::new(),
                slabs,
                context_meshes: model3d::emit_context_meshes(p),
                solid_meshes: model3d::emit_solids(p),
                column_meshes: { let mut m = model3d::emit_columns(p); m.extend(model3d::emit_trees(p)); m },
                opening_meshes: Vec::new(),
                stair_meshes: model3d::emit_stair_meshes(p),
                stair_railings: model3d::emit_stair_railings(p),
                roof_meshes: model3d::emit_roofs(p, None)?,
                roof_layers: model3d::emit_roof_cut_layers(p)?,
            };
            // [214] Je Gruppe dem Wert nach vergleichen: Gleiches behält Laufnummer und ausgegebenes JSON.
            let old = self.rest[var].take();
            for (i, g) in self.groups[var].iter_mut().enumerate() {
                if g.base == 0 || !old.as_ref().is_some_and(|(_, o)| group_eq(i, o, &all)) {
                    *g = RestGroup { base: next_serial(), outs: Vec::new() };
                    self.last_groups_changed |= 1 << i;
                }
            }
            self.rest[var] = Some((key, all));
        }
        let all = &self.rest[var].as_ref().expect("gerade gesetzt").1;
        // [214] Gefilterte Fassung je Gruppe: aus dem Cache, wenn Inhalt und Maske gleich sind (sonst einmal schreiben).
        let group_masks = filter.rest_masks(p, all);
        let mut rest_out: Vec<(u64, &str)> = Vec::with_capacity(8);
        for (i, (g, mask)) in self.groups[var].iter_mut().zip(group_masks).enumerate() {
            let at = match g.outs.iter().position(|o| o.base == g.base && o.mask == mask) {
                Some(at) => at,
                None => {
                    let json = group_json(i, all, mask.as_deref())?;
                    // Gefiltert gleich wie eine frühere Fassung (etwa die Geisterschicht, wenn sich nur Gezeigtes
                    // geändert hat): deren Laufnummer, der Viewer hat sie schon.
                    let serial = match g.outs.iter().position(|o| o.json == json) {
                        Some(at) => g.outs[at].serial,
                        None => next_serial(),
                    };
                    if g.outs.len() >= MAX_REST_OUTS {
                        g.outs.remove(0);
                    }
                    g.outs.push(RestOut { base: g.base, mask, serial, json });
                    g.outs.len() - 1
                }
            };
            let o = &g.outs[at];
            rest_out.push((o.serial, o.json.as_str()));
        }
        let mut parts = Parts::default();
        if structs {
            parts = all.clone();
            filter.retain_rest(p, &mut parts);
        }
        // JSON in einem Zug (wie `serde_json::to_string(&parts)`): Bruchstücke sammeln, dann einmal kopieren.
        // [180] Ausgeblendete Einträge bleiben beim Aufrufer (`keep`), damit Einblenden nichts neu schickt.
        let mut wall_entries: Vec<&WallEntry> = Vec::with_capacity(p.walls.len());
        let mut wall_keep: Vec<&WallEntry> = Vec::new();
        for (wi, s) in wall_stamps.iter().enumerate() {
            if filter.hides(&p.walls[wi].id) {
                wall_keep.push(&fresh[s]);
            } else {
                wall_entries.push(&fresh[s]);
            }
        }
        let mut open_entries: Vec<OpenOut> = Vec::new();
        let mut open_keep: Vec<OpenOut> = Vec::new();
        if !arcs {
            for (wi, s) in wall_stamps.iter().enumerate() {
                let e = &open_fresh[s];
                let base = OpenOut { serial: e.serial, json: &e.json, meshes: &e.meshes };
                let mask = &masks[wi];
                let shown = mask.iter().filter(|&&b| b).count();
                if shown == mask.len() {
                    open_entries.push(base);
                } else {
                    open_keep.push(base);
                }
                for (m, v) in &e.variants {
                    let out = OpenOut { serial: v.serial, json: &v.json, meshes: &v.meshes };
                    if m == mask && shown > 0 {
                        open_entries.push(out);
                    } else {
                        open_keep.push(out);
                    }
                }
            }
        }
        let surface = if arcs { Vec::new() } else { model3d::surface_window_meshes_with(p, &|o| filter.keep_opening(o)) };
        // [214] Gleicher Inhalt wie eine der letzten Antworten: dieselbe Laufnummer (der Viewer hat ihn schon).
        let tail: &[RMesh] = arc_meshes.as_deref().unwrap_or(&surface);
        let (tail_serial, opening_tail) = match self.tails.iter().position(|t| t.0 == tail) {
            Some(i) => {
                let t = self.tails.remove(i);
                let out = (t.1, t.2.clone());
                self.tails.push(t);
                out
            }
            None => {
                let t = (tail.to_vec(), next_serial(), inner_json(tail));
                let out = (t.1, t.2.clone());
                if self.tails.len() >= MAX_REST_OUTS {
                    self.tails.remove(0);
                }
                self.tails.push(t);
                out
            }
        };
        let rest: [&str; 8] = std::array::from_fn(|i| rest_out[i].1);
        let mut json = String::new();
        if let Some(mark) = delta {
            fn w<'a>(v: &[&'a WallEntry]) -> Vec<(u64, &'a str)> {
                v.iter().map(|e| (e.serial, e.json.as_str())).collect()
            }
            fn o<'a>(v: &[OpenOut<'a>]) -> Vec<(u64, &'a [String; 5])> {
                v.iter().map(|e| (e.serial, e.json)).collect()
            }
            let rest_d: [(u64, &str); 8] = std::array::from_fn(|i| rest_out[i]);
            json = write_delta(mark, [&w(&wall_entries), &w(&wall_keep)], [&o(&open_entries), &o(&open_keep)], (tail_serial, &opening_tail), &rest_d);
        } else {
            let walls_frag = wall_entries.iter().map(|e| e.json.as_str());
            let opening_frags = (0..5).flat_map(|k| open_entries.iter().map(move |e| e.json[k].as_str())).chain([opening_tail.as_str()]);
            let cap = walls_frag.clone().chain(opening_frags.clone()).map(|s| s.len() + 1).sum::<usize>() + rest.iter().map(|r| r.len()).sum::<usize>() + 256;
            json.reserve(cap);
            json.push_str("{\"walls\":[");
            join_json(&mut json, walls_frag);
            json.push_str("],\"slabs\":");
            json.push_str(rest[0]);
            json.push_str(",\"contextMeshes\":");
            json.push_str(rest[1]);
            json.push_str(",\"columnMeshes\":");
            json.push_str(rest[2]);
            json.push_str(",\"openingMeshes\":[");
            join_json(&mut json, opening_frags);
            json.push_str("],\"stairMeshes\":");
            json.push_str(rest[3]);
            json.push_str(",\"stairRailings\":");
            json.push_str(rest[4]);
            json.push_str(",\"roofMeshes\":");
            json.push_str(rest[5]);
            json.push_str(",\"roofLayers\":");
            json.push_str(rest[6]);
            json.push_str(",\"solidMeshes\":");
            json.push_str(rest[7]);
            json.push('}');
        }
        if structs {
            parts.walls = wall_entries.iter().flat_map(|e| e.pieces.iter().cloned()).collect();
            parts.opening_meshes = match arc_meshes {
                Some(m) => m,
                None => {
                    let mut v = model3d::assemble_opening_meshes(open_entries.iter().map(|e| WallOpeningMeshes::clone(e.meshes)).collect());
                    v.extend(surface);
                    v
                }
            };
        }
        drop((wall_entries, wall_keep, open_entries, open_keep));
        self.walls[layered as usize] = fresh;
        if !arcs {
            self.openings[slot].1 = open_fresh;
        }
        Ok(CachedParts { parts, json })
    }
}

/// Ein ausgegebener Öffnungs-Eintrag (Grundfall oder [180] Variante).
#[derive(Clone, Copy)]
struct OpenOut<'a> {
    serial: u64,
    json: &'a [String; 5],
    meshes: &'a WallOpeningMeshes,
}

/// Änderungs-JSON ([58], TS `ProjectDocument.model3dParts`): statt `walls`/`openingMeshes` die Laufnummern
/// je Wand (`wallKeys`, `openingKeys`, Modell-Reihenfolge) und nur die Einträge mit Laufnummer > `mark`
/// ausgeschrieben (`wallNew`: `[nr, [Körper…]]`, `openingNew`: `[nr, 3 Durchgänge, Zargen, Formöffnungen]`);
/// `openingTail` = Dach-/Deckenfenster (bzw. alles bei Bogenwänden; [214] mit Laufnummer `tailKey`, `null` = schon
/// geschickt), übrige Gruppen mit Laufnummer je Gruppe (`restKeys`, Inhalt `null` = schon geschickt),
/// `mark` = Stand für die nächste Frage.
/// [180] `wallKeep`/`openingKeep` (nur wenn nicht leer): Einträge ausgeblendeter Klassen, die der Aufrufer
/// behält, aber nicht zeigt (je `[gezeigt, behalten]` übergeben). Gültig nur, wenn der Aufrufer die Einträge
/// ≤ `mark` aus seiner letzten Antwort hat (sonst `mark` 0).
fn write_delta(mark: u64, walls: [&[(u64, &str)]; 2], openings: [&[(u64, &[String; 5])]; 2], opening_tail: (u64, &str), rest: &[(u64, &str); 8]) -> String {
    use std::fmt::Write;
    let fresh = |serial: u64| mark == 0 || serial > mark || mark > current_serial();
    let cap = walls.iter().flat_map(|v| v.iter()).filter(|e| fresh(e.0)).map(|e| e.1.len() + 32).sum::<usize>()
        + openings
            .iter()
            .flat_map(|v| v.iter())
            .filter(|e| fresh(e.0))
            .map(|e| e.1.iter().map(|j| j.len() + 4).sum::<usize>() + 32)
            .sum::<usize>()
        + (walls[0].len() + walls[1].len() + openings[0].len() + openings[1].len()) * 12
        + opening_tail.1.len()
        + rest.iter().filter(|r| fresh(r.0)).map(|r| r.1.len()).sum::<usize>()
        + 512;
    let mut out = String::with_capacity(cap);
    let keys = |out: &mut String, name: &str, serials: &mut dyn Iterator<Item = u64>| {
        let _ = write!(out, "\"{name}\":[");
        for (i, s) in serials.enumerate() {
            let _ = write!(out, "{}{}", if i > 0 { "," } else { "" }, s);
        }
        out.push_str("],");
    };
    let _ = write!(out, "{{\"mark\":{},", current_serial());
    keys(&mut out, "wallKeys", &mut walls[0].iter().map(|e| e.0));
    if !walls[1].is_empty() {
        keys(&mut out, "wallKeep", &mut walls[1].iter().map(|e| e.0));
    }
    out.push_str("\"wallNew\":[");
    let mut first = true;
    for e in walls.iter().flat_map(|v| v.iter()).filter(|e| fresh(e.0)) {
        let _ = write!(out, "{}[{},[{}]]", if first { "" } else { "," }, e.0, e.1);
        first = false;
    }
    out.push_str("],");
    keys(&mut out, "openingKeys", &mut openings[0].iter().map(|e| e.0));
    if !openings[1].is_empty() {
        keys(&mut out, "openingKeep", &mut openings[1].iter().map(|e| e.0));
    }
    out.push_str("\"openingNew\":[");
    let mut first = true;
    for e in openings.iter().flat_map(|v| v.iter()).filter(|e| fresh(e.0)) {
        let _ = write!(out, "{}[{}", if first { "" } else { "," }, e.0);
        for j in e.1 {
            let _ = write!(out, ",[{j}]");
        }
        out.push(']');
        first = false;
    }
    // [214] Rest der Öffnungs-Einbauteile wie eine übrige Gruppe: Laufnummer `tailKey`, Inhalt nur wenn neu (sonst `null`).
    if fresh(opening_tail.0) {
        let _ = write!(out, "],\"tailKey\":{},\"openingTail\":[{}],", opening_tail.0, opening_tail.1);
    } else {
        let _ = write!(out, "],\"tailKey\":{},\"openingTail\":null,", opening_tail.0);
    }
    // [214] Übrige Gruppen: Laufnummer je Gruppe (`restKeys`), Inhalt nur, wenn neuer als `mark` (sonst `null`).
    keys(&mut out, "restKeys", &mut rest.iter().map(|r| r.0));
    out.pop();
    for (name, (serial, json)) in REST_NAMES.iter().zip(rest) {
        let _ = write!(out, ",\"{name}\":{}", if fresh(*serial) { json } else { "null" });
    }
    out.push('}');
    out
}

/// Namen der übrigen Gruppen im JSON (Reihenfolge wie [`ClassFilter::rest_masks`]).
const REST_NAMES: [&str; 8] = ["slabs", "contextMeshes", "columnMeshes", "stairMeshes", "stairRailings", "roofMeshes", "roofLayers", "solidMeshes"];

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
    fn check(d: &mut Document, clients: &mut [Client; 4], step: &str) {
        check_with(d, clients, step, "");
    }

    /// Wie [`check`] mit `text` der Abfrage ([180] Klassen-Filter `{"hide": [...]}`).
    fn check_with(d: &mut Document, clients: &mut [Client; 4], step: &str, text: &str) {
        let p = d.project().unwrap().clone();
        for (a, c) in ARGS.iter().zip(clients.iter_mut()) {
            let inc = crate::queries::run_doc(d, "model3dParts", a, text).unwrap();
            let full = crate::queries::run(&p, "model3dParts", a, text).unwrap();
            assert!(inc == full, "{step}: model3dParts {a:?} weicht ab ({} / {} Zeichen)", inc.len(), full.len());
            // Änderungs-Antwort wie in TS (`ProjectDocument.model3dParts`) zusammengesetzt = voll.
            let mut da = a.to_vec();
            da.push(c.mark as f64);
            let delta = crate::queries::run_doc(d, "model3dPartsDelta", &da, text).unwrap();
            let got = c.apply(&delta).unwrap_or_else(|| {
                // Wie TS: Eintrag fehlt → einmal alles neu.
                da[5] = 0.0;
                c.apply(&crate::queries::run_doc(d, "model3dPartsDelta", &da, text).unwrap()).expect("volle Antwort")
            });
            let want: Value = serde_json::from_str(&full).unwrap();
            assert!(got == want, "{step}: model3dPartsDelta {a:?} weicht ab");
        }
    }

    /// Gegenstelle der Änderungs-Antworten (wie TS): hält die Einträge der letzten Antwort.
    #[derive(Default)]
    struct Client {
        mark: u64,
        walls: std::collections::HashMap<u64, Vec<Value>>,
        openings: std::collections::HashMap<u64, Vec<Vec<Value>>>,
        /// [214] Übrige Gruppen der letzten beiden Antworten (Laufnummer → Inhalt), wie TS.
        rest: [std::collections::HashMap<u64, Value>; 2],
    }

    impl Client {
        /// `None`: eine übrige Gruppe fehlt (wie TS: dann alles neu anfordern, `mark` 0).
        fn apply(&mut self, json: &str) -> Option<Value> {
            let r: Value = serde_json::from_str(json).unwrap();
            let key = |v: &Value| v.as_u64().unwrap();
            // [214] Übrige Gruppen: neu geschickt oder aus den letzten Antworten nach Laufnummer.
            let mut rest = std::collections::HashMap::new();
            for (name, k) in super::REST_NAMES.iter().zip(r["restKeys"].as_array().unwrap().iter().map(key)) {
                let v = if r[*name].is_null() { self.rest.iter().find_map(|m| m.get(&k)).cloned()? } else { r[*name].clone() };
                rest.insert(k, v);
            }
            let arr = |v: &Value| v.as_array().unwrap().clone();
            let mut wn: std::collections::HashMap<u64, Vec<Value>> = r["wallNew"].as_array().unwrap().iter().map(|e| (key(&e[0]), arr(&e[1]))).collect();
            let mut on: std::collections::HashMap<u64, Vec<Vec<Value>>> = r["openingNew"].as_array().unwrap().iter().map(|e| (key(&e[0]), (1..6).map(|k| arr(&e[k])).collect())).collect();
            let (mut walls, mut nw) = (Vec::new(), std::collections::HashMap::new());
            for k in r["wallKeys"].as_array().unwrap().iter().map(key) {
                let e = wn.remove(&k).or_else(|| self.walls.remove(&k)).expect("Wand-Eintrag fehlt");
                walls.extend(e.iter().cloned());
                nw.insert(k, e);
            }
            // [180] Ausgeblendete Einträge behalten (wie TS `assembleModel3dDelta`), nicht zeigen.
            for k in r.get("wallKeep").and_then(Value::as_array).into_iter().flatten().map(key) {
                let e = wn.remove(&k).or_else(|| self.walls.remove(&k)).expect("behaltener Wand-Eintrag fehlt");
                nw.insert(k, e);
            }
            let mut no = std::collections::HashMap::new();
            let keys: Vec<u64> = r["openingKeys"].as_array().unwrap().iter().map(key).collect();
            for &k in &keys {
                let e = on.remove(&k).or_else(|| self.openings.remove(&k)).expect("Öffnungs-Eintrag fehlt");
                no.insert(k, e);
            }
            for k in r.get("openingKeep").and_then(Value::as_array).into_iter().flatten().map(key) {
                let e = on.remove(&k).or_else(|| self.openings.remove(&k)).expect("behaltener Öffnungs-Eintrag fehlt");
                no.insert(k, e);
            }
            let mut meshes = Vec::new();
            for l in 0..5 {
                for k in &keys {
                    meshes.extend(no[k][l].iter().cloned());
                }
            }
            let tail = match r["openingTail"].as_array() {
                Some(a) => a.clone(),
                None => self.rest.iter().find_map(|m| m.get(&key(&r["tailKey"]))).and_then(Value::as_array).cloned()?,
            };
            meshes.extend(tail.iter().cloned());
            rest.insert(key(&r["tailKey"]), Value::Array(tail));
            (self.mark, self.walls, self.openings) = (key(&r["mark"]), nw, no);
            let mut out = serde_json::Map::new();
            out.insert("walls".into(), Value::Array(walls));
            let rest_of = |name: &str| rest[&key(&r["restKeys"][super::REST_NAMES.iter().position(|n| *n == name).unwrap()])].clone();
            for k in ["slabs", "contextMeshes", "columnMeshes"] {
                out.insert(k.into(), rest_of(k));
            }
            out.insert("openingMeshes".into(), Value::Array(meshes));
            for k in ["stairMeshes", "stairRailings", "roofMeshes", "roofLayers", "solidMeshes"] {
                out.insert(k.into(), rest_of(k));
            }
            if let Some(v) = r.get("voidMeshes") {
                out.insert("voidMeshes".into(), v.clone());
            }
            let prev = std::mem::take(&mut self.rest[0]);
            self.rest = [rest, prev];
            Some(Value::Object(out))
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
        let mut clients: [Client; 4] = Default::default();
        check(&mut d, &mut clients, "start");
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
                    vec![Op::Replace {
                        collection: "walls".into(),
                        entity: w,
                    }]
                }
                2 => {
                    // Endpunkt verschieben: ändert die Verschneidung der Nachbarn.
                    let mut w = walls[rnd(walls.len())].clone();
                    let x = w["end"]["x"].as_f64().unwrap_or(0.0);
                    w["end"]["x"] = json!(x + 0.05);
                    vec![Op::Replace {
                        collection: "walls".into(),
                        entity: w,
                    }]
                }
                3 if !openings.is_empty() => {
                    let mut o = openings[rnd(openings.len())].clone();
                    let wd = o["width"].as_f64().unwrap_or(1.0);
                    o["width"] = json!(wd * 0.9);
                    vec![Op::Replace {
                        collection: "openings".into(),
                        entity: o,
                    }]
                }
                4 if !openings.is_empty() => {
                    // Öffnung in eine andere Wand umhängen.
                    let mut o = openings[rnd(openings.len())].clone();
                    o["hostWallId"] = walls[rnd(walls.len())]["id"].clone();
                    vec![Op::Replace {
                        collection: "openings".into(),
                        entity: o,
                    }]
                }
                5 => {
                    let mut w = walls[rnd(walls.len())].clone();
                    w["id"] = json!(format!("neu{step}"));
                    w["start"]["y"] = json!(w["start"]["y"].as_f64().unwrap_or(0.0) + 0.3);
                    vec![Op::Add {
                        collection: "walls".into(),
                        items: vec![w],
                        at: Some(rnd(walls.len())),
                    }]
                }
                6 if walls.len() > 3 => vec![Op::Remove {
                    collection: "walls".into(),
                    ids: vec![walls[rnd(walls.len())]["id"].as_str().unwrap().to_owned()],
                }],
                7 => {
                    // Wandtyp ändern (globales Feld): alles neu.
                    let mut ts = list(&d, "wallTypes");
                    let t = rnd(ts.len());
                    if let Some(l) = ts[t]["layers"].get_mut(0) {
                        let th = l["thickness"].as_f64().unwrap_or(0.1);
                        l["thickness"] = json!(th + 0.01);
                    }
                    vec![Op::Replace {
                        collection: "wallTypes".into(),
                        entity: ts.swap_remove(t),
                    }]
                }
                8 => {
                    if d.undo().is_some() {
                        kinds[kind] += 1;
                        check(&mut d, &mut clients, &format!("Schritt {step} (undo)"));
                    }
                    continue;
                }
                9 => {
                    if d.redo().is_some() {
                        kinds[kind] += 1;
                        check(&mut d, &mut clients, &format!("Schritt {step} (redo)"));
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
            check(&mut d, &mut clients, &format!("Schritt {step} (Art {kind})"));
        }
        // Jede Art kam vor (sonst prüft die Folge weniger als gedacht).
        assert!(kinds.iter().all(|&k| k > 0), "{kinds:?}");
    }

    /// [180] Klassen ein-/ausblenden (über `hide` und über den Ebenen-Baum): ausgeblendete Wände, Öffnungen,
    /// Decken, Dächer, Treppen fehlen, inkrementell = voll = Änderungs-Antwort, und keine Wand wird neu
    /// gerechnet; Öffnungs-Varianten (teils ausgeblendete Öffnungen einer Wand) nur beim ersten Mal.
    #[test]
    fn class_filter_without_rebuild() {
        let mut d = sample();
        let mut clients: [Client; 4] = Default::default();
        // Tür D1 auf eigene Klasse: Wand W1 hat dann eine sichtbare (O1) und eine ausgeblendete Öffnung.
        let mut o = list(&d, "openings").into_iter().find(|o| o["id"] == "D1").unwrap();
        o["categoryCode"] = json!("22");
        d.commit(vec![Op::Replace { collection: "openings".into(), entity: o }], None, 0.0, false).unwrap();
        check_with(&mut d, &mut clients, "alles sichtbar", "");
        let parts = |d: &mut Document, text: &str| -> Value { serde_json::from_str(&crate::queries::run_doc(d, "model3dParts", &[1.0, 2.0, 0.0, 0.0, 0.0], text).unwrap()).unwrap() };
        let len = |v: &Value, k: &str| v[k].as_array().map_or(0, Vec::len);
        let all = parts(&mut d, "");
        let (walls, openings, roofs) = (len(&all, "walls"), len(&all, "openingMeshes"), len(&all, "roofMeshes"));
        assert!(walls > 0 && openings > 0 && roofs > 0 && len(&all, "slabs") > 0);
        let doors = r#"{"hide":["22"]}"#;
        for (step, text) in [
            ("Türen aus", doors),
            ("Wände aus", r#"{"hide":["20"]}"#),
            ("Decke, Dach, Treppe aus", r#"{"hide":["30","31","40"]}"#),
            ("alles sichtbar", ""),
            ("Türen wieder aus", doors),
        ] {
            check_with(&mut d, &mut clients, step, text);
            d.model3d_parts_with(true, 2.0, false, false, None, text).unwrap();
            assert_eq!(d.model3d_rebuilt(), (0, 0), "{step}");
            assert_eq!(d.model3d_variants(), 0, "{step}: Variante schon gemerkt");
        }
        let v = parts(&mut d, doors);
        assert_eq!(len(&v, "walls"), walls);
        assert!(len(&v, "openingMeshes") < openings && len(&v, "openingMeshes") > 0, "nur die Tür fehlt");
        let v = parts(&mut d, r#"{"hide":["20"]}"#);
        assert_eq!((len(&v, "walls"), len(&v, "openingMeshes")), (0, 0), "Öffnungen gehen mit der Wand");
        assert_eq!(len(&v, "roofMeshes"), roofs);
        let v = parts(&mut d, r#"{"hide":["30","31","40"]}"#);
        assert_eq!((len(&v, "slabs"), len(&v, "roofMeshes"), len(&v, "roofLayers"), len(&v, "stairMeshes"), len(&v, "stairRailings")), (0, 0, 0, 0, 0));
        assert_eq!(len(&v, "walls"), walls);
        // Ebenen-Baum (Ebenen-Panel, Kombinationen, Vorlagen): Dach aus — ohne Neuberechnung der Wände.
        let mut layers = d.root()["layers"].clone();
        for c in layers.as_array_mut().unwrap() {
            if c["code"] == "31" {
                c["visible"] = json!(false);
            }
        }
        d.commit(vec![Op::SetField { key: "layers".into(), value: Some(layers), at: None }], None, 1.0, false).unwrap();
        check_with(&mut d, &mut clients, "Dach-Klasse aus", "");
        d.model3d_parts(true, 2.0, false, false, None).unwrap();
        assert_eq!(d.model3d_rebuilt(), (0, 0));
        let v = parts(&mut d, "");
        assert_eq!((len(&v, "roofMeshes"), len(&v, "roofLayers")), (0, 0));
        let pick: Value = serde_json::from_str(&crate::queries::run_doc(&mut d, "pickGeometry", &[0.0], "").unwrap()).unwrap();
        assert_eq!(len(&pick, "roofs"), 0, "ausgeblendetes Dach nicht anwählbar");
        assert!(len(&pick, "walls") > 0);
        let pick: Value = serde_json::from_str(&crate::queries::run_doc(&mut d, "pickGeometry", &[0.0], doors).unwrap()).unwrap();
        assert!(pick["openings"].as_array().unwrap().iter().all(|o| o["openingId"] != "D1"));
        assert!(pick["openings"].as_array().unwrap().iter().any(|o| o["openingId"] == "O1"));
    }

    /// [180] Grau: Hauptmodell ohne, Geisterschicht nur mit den grauen Wänden — beide aus dem Cache (keine Wand neu),
    /// Änderungs-Antworten gleich der vollen Abfrage, zusammen wieder alle Wände.
    #[test]
    fn grey_class_ghost_split() {
        let mut d = sample();
        let mut clients: [Client; 4] = Default::default();
        check_with(&mut d, &mut clients, "alles sichtbar", "");
        let parts = |d: &mut Document, text: &str| -> Value { serde_json::from_str(&crate::queries::run_doc(d, "model3dParts", &[1.0, 2.0, 0.0, 0.0, 0.0], text).unwrap()).unwrap() };
        let len = |v: &Value, k: &str| v[k].as_array().map_or(0, Vec::len);
        let all = parts(&mut d, "");
        let main_t = r#"{"grey":["20"]}"#;
        let ghost_t = r#"{"grey":["20"],"ghost":true}"#;
        for (step, text) in [("Wände grau", main_t), ("Geisterschicht", ghost_t), ("Wände grau 2", main_t), ("Geisterschicht 2", ghost_t)] {
            check_with(&mut d, &mut clients, step, text);
            d.model3d_parts_with(true, 2.0, false, false, None, text).unwrap();
            assert_eq!(d.model3d_rebuilt(), (0, 0), "{step}");
        }
        let main = parts(&mut d, main_t);
        let ghost = parts(&mut d, ghost_t);
        assert!(len(&ghost, "walls") > 0 && len(&main, "walls") < len(&all, "walls"));
        assert_eq!(len(&main, "walls") + len(&ghost, "walls"), len(&all, "walls"));
        assert_eq!(len(&ghost, "roofMeshes"), 0);
        assert_eq!(len(&main, "roofMeshes"), len(&all, "roofMeshes"));
        // Graue Wände bleiben anwählbar (Modus „grau"), gesperrt nicht.
        let pick = |d: &mut Document, text: &str| -> Value { serde_json::from_str(&crate::queries::run_doc(d, "pickGeometry", &[0.0], text).unwrap()).unwrap() };
        let n = len(&pick(&mut d, ""), "walls");
        assert_eq!(len(&pick(&mut d, main_t), "walls"), n);
        assert!(len(&pick(&mut d, r#"{"grey":["20"],"lock":["20"]}"#), "walls") < n);
    }

    /// Eine Wandhöhe ändern: nur diese Wand (Körper und Einbauteile) wird neu gerechnet.
    #[test]
    fn one_wall_edit_rebuilds_one_wall() {
        let mut d = sample();
        let n = d.project().unwrap().walls.len();
        d.model3d_parts(true, 2.0, false, false, None).unwrap();
        assert_eq!(d.model3d_rebuilt(), (n, n));
        d.model3d_parts(true, 2.0, false, false, None).unwrap();
        assert_eq!(d.model3d_rebuilt(), (0, 0));
        let mut w = list(&d, "walls")[2].clone();
        w["height"] = json!(w["height"].as_f64().unwrap_or(2.6) + 0.2);
        d.commit(
            vec![Op::Replace {
                collection: "walls".into(),
                entity: w,
            }],
            None,
            0.0,
            false,
        )
        .unwrap();
        d.model3d_parts(true, 2.0, false, false, None).unwrap();
        assert_eq!(d.model3d_rebuilt(), (1, 1));
        // Öffnung ändern: nur ihre Wirtswand.
        let mut o = list(&d, "openings")[0].clone();
        o["width"] = json!(o["width"].as_f64().unwrap_or(1.0) - 0.1);
        d.commit(
            vec![Op::Replace {
                collection: "openings".into(),
                entity: o,
            }],
            None,
            1.0,
            false,
        )
        .unwrap();
        d.model3d_parts(true, 2.0, false, false, None).unwrap();
        assert_eq!(d.model3d_rebuilt(), (1, 1));
        d.undo();
        d.model3d_parts(true, 2.0, false, false, None).unwrap();
        assert_eq!(d.model3d_rebuilt(), (1, 1));
    }

    /// [214] Die übrigen Gruppen (Decken, Dächer …) rechnet ein zweiter Aufruf mit anderem Klassen-Filter (Geisterschicht)
    /// nicht neu; eine Wand-Änderung oder die Schnitt-Variante schon. Ergebnisse gleich voll: `incremental_equals_full_*`.
    #[test]
    fn uebrige_gruppen_aus_dem_cache() {
        let mut d = sample();
        let q = |d: &mut Document, text: &str, for_section: bool| d.model3d_parts_with(true, 2.0, for_section, false, None, text).unwrap().json;
        let all = q(&mut d, "", false);
        assert!(!d.model3d_rest_hit());
        let grey = q(&mut d, r#"{"grey":["30"],"ghost":true}"#, false);
        assert!(d.model3d_rest_hit(), "anderer Filter: aus dem Cache");
        assert_ne!(all, grey);
        assert_eq!(q(&mut d, "", false), all);
        assert!(d.model3d_rest_hit());
        q(&mut d, "", true);
        assert!(!d.model3d_rest_hit(), "Schnitt-Variante der Treppen");
        let mut w = list(&d, "walls")[2].clone();
        w["height"] = json!(w["height"].as_f64().unwrap_or(2.6) + 0.2);
        d.commit(vec![Op::Replace { collection: "walls".into(), entity: w }], None, 0.0, false).unwrap();
        q(&mut d, "", true);
        assert!(!d.model3d_rest_hit(), "Wand geändert");
    }

    /// [214] Übrige Gruppen mit Laufnummer: Eine Wand-Änderung schickt nur Gruppen, deren Inhalt sich geändert hat
    /// (sonst `null`), ein zweiter Filter (Geisterschicht) im Wechsel schickt nichts noch einmal, und eine Änderung an
    /// anderer Stelle (Typen, Geschosse …: Cache verworfen) behält gleiche Gruppen. Zusammengesetzt = voll (`check`).
    #[test]
    fn uebrige_gruppen_mit_laufnummer() {
        let mut d = sample();
        let house = json!({"type": "importedMesh", "id": "nachbar", "name": "Nachbar", "categoryCode": "12",
            "positions": [20.0, 0.0, 0.0, 26.0, 0.0, 0.0, 26.0, 6.0, 0.0, 20.0, 0.0, 5.0], "indices": [0, 1, 2, 0, 2, 3]});
        d.commit(vec![Op::SetField { key: "context".into(), value: Some(json!([house])), at: None }], None, 0.0, false).unwrap();
        let mut clients: [Client; 4] = Default::default();
        let ghost = r#"{"grey":["30"],"ghost":true}"#;
        check(&mut d, &mut clients, "start");
        check_with(&mut d, &mut clients, "Geisterschicht", ghost);
        let delta = |d: &mut Document, c: &Client, text: &str| -> Value {
            let mut a = ARGS[0].to_vec();
            a.push(c.mark as f64);
            serde_json::from_str(&crate::queries::run_doc(d, "model3dPartsDelta", &a, text).unwrap()).unwrap()
        };
        // Im Wechsel ohne Änderung: keine Gruppe neu.
        for text in ["", ghost, ""] {
            let r = delta(&mut d, &clients[0], text);
            for name in super::REST_NAMES {
                assert!(r[name].is_null(), "{name} ohne Änderung neu geschickt ({text})");
            }
            assert!(r["openingTail"].is_null(), "Öffnungs-Rest ohne Änderung neu geschickt ({text})");
            clients[0].apply(&serde_json::to_string(&r).unwrap()).expect("Gruppen da");
        }
        // Wand verschieben: Kontext, Körper usw. bleiben `null`; Ergebnis = voll.
        let mut w = list(&d, "walls")[1].clone();
        w["start"]["x"] = json!(w["start"]["x"].as_f64().unwrap() + 0.05);
        d.commit(vec![Op::Replace { collection: "walls".into(), entity: w }], None, 0.0, false).unwrap();
        let r = delta(&mut d, &clients[0], "");
        assert!(r["contextMeshes"].is_null(), "Kontext neu geschickt");
        assert!(r["solidMeshes"].is_null(), "Körper neu geschickt");
        let changed = d.model3d_groups_changed();
        assert_eq!(changed & 0b10, 0, "Kontext als geändert gemeldet");
        let full: Value = serde_json::from_str(&crate::queries::run(d.project().unwrap(), "model3dParts", &ARGS[0], "").unwrap()).unwrap();
        assert_eq!(full["contextMeshes"].as_array().map(Vec::len), Some(1), "Nachbar im Modell");
        assert!(clients[0].apply(&serde_json::to_string(&r).unwrap()) == Some(full));
        check(&mut d, &mut clients, "Wand verschoben");
        check_with(&mut d, &mut clients, "Wand verschoben, Geisterschicht", ghost);
        // Geschoss-Höhe ändern (Cache verworfen): Kontext bleibt gleich, Ergebnis = voll.
        let mut f = list(&d, "drawingLevels").into_iter().find(|l| l["kind"] == "floor").unwrap();
        f["floorHeight"] = json!(f["floorHeight"].as_f64().unwrap() + 0.1);
        d.commit(vec![Op::Replace { collection: "drawingLevels".into(), entity: f }], None, 0.0, false).unwrap();
        let r = delta(&mut d, &clients[0], "");
        assert!(r["contextMeshes"].is_null(), "Kontext nach Verwerfen neu geschickt");
        assert_ne!(d.model3d_groups_changed(), 0, "Decken sollten sich ändern");
        clients[0].apply(&serde_json::to_string(&r).unwrap()).expect("Gruppen da");
        check(&mut d, &mut clients, "Geschoss geändert");
        check_with(&mut d, &mut clients, "Geschoss geändert, Geisterschicht", ghost);
    }

    /// [214] Messung (von Hand): wo die Zeit einer Teil-Abfrage nach einer Wand-Änderung bleibt.
    /// `BENCH_FILE=gross.obp cargo test --release --lib model3d_cache::tests::bench214 -- --ignored --nocapture`
    /// (`gross.obp` aus `dossier-cli :gross migrate --out gross.obp`).
    #[test]
    #[ignore]
    fn bench214() {
        use std::time::Instant;
        let Ok(path) = std::env::var("BENCH_FILE") else { return };
        let ms = |t: Instant| t.elapsed().as_secs_f64() * 1e3;
        let mut d = Document::default();
        d.load_file(&std::fs::read_to_string(path).unwrap(), 0.0).unwrap();
        let t = Instant::now();
        let n = d.model3d_parts(true, 2.0, false, true, None).unwrap().json.len();
        println!("kalt: {:.1} ms ({n} Zeichen)", ms(t));
        let mut runs = Vec::new();
        for k in 0..5 {
            let walls = list(&d, "walls");
            let mut w = walls[(k * 37) % walls.len()].clone();
            let x = w["end"]["x"].as_f64().unwrap_or(0.0);
            w["end"]["x"] = json!(x + 0.01);
            d.apply(&[Op::Replace { collection: "walls".into(), entity: w }]).unwrap();
            let t = Instant::now();
            d.model3d_parts(true, 2.0, false, false, Some(0)).unwrap();
            runs.push(ms(t));
        }
        println!("nach Wand-Änderung: {runs:.1?} ms, neu: {:?}", d.model3d_rebuilt());
        let p = d.project().unwrap().clone();
        let lap = |name: &str, f: &dyn Fn()| {
            let t = Instant::now();
            for _ in 0..3 {
                f();
            }
            println!("  {name:<28} {:.1} ms", ms(t) / 3.0);
        };
        lap("Fugen-Eingabe je Geschoss", &|| {
            for (_, idx) in crate::model3d::floor_groups(&p) {
                crate::model3d::floor_join_input(&p, &idx);
            }
        });
        lap("Geschoss-Kontexte", &|| {
            let mut seen = std::collections::HashSet::new();
            for w in &p.walls {
                if seen.insert(w.floor_id.clone()) {
                    crate::model3d::floor_context_with(&p, &w.floor_id, true, None);
                }
            }
        });
        lap("emit_slabs", &|| drop(crate::model3d::emit_slabs(&p)));
        lap("  Auflager (ohne Fugen)", &|| drop(crate::model3d::bearing::ceiling_bearing_outlines(&p)));
        let mut c2 = super::Model3dCache::default();
        let joins = c2.joins(&p);
        lap("  Auflager (Fugen bekannt)", &|| drop(crate::model3d::bearing::bearing_outlines(&p, |_| true, Some(&joins))));
        lap("emit_stairs", &|| drop(crate::model3d::emit_stairs(&p, false)));
        lap("emit_context_meshes", &|| drop(crate::model3d::emit_context_meshes(&p)));
        lap("emit_solids", &|| drop(crate::model3d::emit_solids(&p)));
        lap("emit_columns+trees", &|| drop(crate::model3d::emit_columns(&p)));
        lap("emit_stair_meshes", &|| drop(crate::model3d::emit_stair_meshes(&p)));
        lap("emit_stair_railings", &|| drop(crate::model3d::emit_stair_railings(&p)));
        lap("emit_roofs", &|| drop(crate::model3d::emit_roofs(&p, None)));
        lap("emit_roof_cut_layers", &|| drop(crate::model3d::emit_roof_cut_layers(&p)));
    }
}
