//! [180] Klassen im 3D: jedes 3D-Teil gehört zum Element, aus dem es stammt, und verschwindet mit dessen
//! Klasse (`categoryCode`). Ausgeblendet ist eine Klasse, wenn sie selbst oder eine Elternklasse im
//! Ebenen-Baum aus ist (`LayerCategory.visible`; Ebenen-Kombinationen und Vorlagen setzen dieselben
//! Schalter) oder der Aufrufer sie nicht zeichnet (`norender` des Darstellungsmodus, `text` =
//! `{"hide": [codes]}`). Gefiltert wird beim Ausgeben, nicht beim Rechnen: Der 3D-Cache bleibt
//! klassenunabhängig (`model3d_cache.rs`), Umschalten rechnet keine Wand neu.
//!
//! [196] Geschosse mit ausgeschaltetem Auge (`{"hideFloors": [ids]}`, Zeichnungsebenen-Panel) blenden alle Elemente ihres
//! Geschosses aus (wie eine ausgeblendete Klasse, auch im Pick); Öffnungen folgen ihrem Wirt (Wand, Dach, Decke).
//!
//! [180] Graue Geschosse (`{"greyFloors": [ids]}`, Zeichnungsebenen-Modus „grau"): die Elemente des Geschosses verhalten sich
//! wie die grauer Klassen (Geisterschicht); Geschoss-Auge aus (`hideFloors`) geht vor.
//!
//! [180] Darstellungsmodus „grau" (`{"grey": [codes]}`): die Elemente grauer Klassen fehlen im Hauptmodell und
//! erscheinen in einer eigenen, gedämpften Geisterschicht (`{"grey": [codes], "ghost": true}` liefert NUR sie, der
//! Viewer zeichnet sie durchscheinend, render3d `set_ghost_model`). Anwählbar bleiben sie wie im Grundriss, ausser
//! ihre Klasse ist zusätzlich gesperrt (`{"lock": [codes]}`, Modi „grau + gesperrt"/„gesperrt"). Öffnungen sind grau,
//! wenn ihre eigene Klasse oder ihr Wirt grau ist; Ausblenden geht vor Grau.
//!
//! Öffnungs-Einbauteile werden je Wand gemeinsam gerechnet (ohne Zuordnung zur Öffnung): dort wirkt der
//! Filter auf die Eingabe (nur sichtbare Öffnungen, [`ClassFilter::keep_opening`]); das Loch in der Wand
//! bleibt. Eine Öffnung verschwindet auch mit ihrem Wirt (Wand, Dach, Decke), wie in der Ansicht.

use super::*;
use std::collections::HashSet;

/// Herkunft eines `RMesh`/`RRoofLayer` (nur im Kern, nicht serialisiert): Index in der Element-Liste.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Owner {
    #[default]
    None,
    Roof(usize),
    Column(usize),
    Tree(usize),
    Stair(usize),
    Context(usize),
    /// [115] Index in `Project::extruded_solids`.
    Solid(usize),
}

impl Owner {
    /// Element-id der Herkunft.
    pub fn id<'a>(&self, p: &'a Project) -> Option<&'a str> {
        fn at<T>(v: &Option<Vec<T>>, i: usize) -> Option<&T> {
            v.as_deref().and_then(|v| v.get(i))
        }
        match *self {
            Owner::None => None,
            Owner::Roof(i) => at(&p.roofs, i).map(|e| e.id.as_str()),
            Owner::Column(i) => at(&p.columns, i).map(|e| e.id.as_str()),
            Owner::Tree(i) => at(&p.trees, i).map(|e| e.id.as_str()),
            Owner::Stair(i) => at(&p.stairs, i).map(|e| e.id.as_str()),
            Owner::Context(i) => at(&p.context, i).map(|e| e.id()),
            Owner::Solid(i) => at(&p.extruded_solids, i).map(|e| e.id.as_str()),
        }
    }
}

/// [185] Element-Auswahl im 3D (rein UI, nicht im Projekt): „Auswahl in 3D zeigen" (`only`, `None` = alle) und
/// temporär ausgeblendete Elemente (`hide`). Wirkt wie eine ausgeblendete Klasse: fehlt in Teilen und Pick.
#[derive(Debug, Clone, Default)]
pub struct ElementSelection {
    pub only: Option<HashSet<String>>,
    pub hide: HashSet<String>,
    /// [196] Geschosse (Zeichnungsebenen-Ids) mit ausgeschaltetem Auge: ihre Elemente fehlen im 3D.
    pub hide_floors: HashSet<String>,
    /// [180] Klassen im Darstellungsmodus „grau": fehlen im Hauptmodell, erscheinen in der Geisterschicht.
    pub grey: HashSet<String>,
    /// [180] Geschosse (Zeichnungsebenen-Ids) im Darstellungsmodus „grau": ihre Elemente verhalten sich wie die grauer Klassen.
    pub grey_floors: HashSet<String>,
    /// [180] Gesperrte Klassen des Darstellungsmodus: sichtbar (bzw. grau), aber nicht anwählbar.
    pub lock: HashSet<String>,
    /// [180] Geisterschicht: NUR die grauen (nicht ausgeblendeten) Elemente liefern.
    pub ghost: bool,
}

impl ElementSelection {
    /// Keine Einschränkung.
    pub fn is_empty(&self) -> bool {
        self.only.is_none() && self.hide.is_empty() && self.hide_floors.is_empty() && self.grey.is_empty() && self.grey_floors.is_empty() && self.lock.is_empty() && !self.ghost
    }
}

/// Wirte einer Öffnung (Wand, Dach, Decke; leere ids zählen nicht). Dachfenster und Deckenöffnungen haben keine Wand.
fn opening_hosts(o: &Opening) -> impl Iterator<Item = &str> {
    [Some(o.host_wall_id.as_str()), o.host_roof_id.as_deref(), o.host_ceiling_id.as_deref()].into_iter().flatten().filter(|s| !s.is_empty())
}

/// Ausgeblendete Klassen und die ids der Elemente darauf.
#[derive(Debug, Clone, Default)]
pub struct ClassFilter {
    codes: HashSet<String>,
    /// Elemente, die in den Teilen fehlen (ausgeblendet; dazu grau im Hauptmodell bzw. nicht grau in der Geisterschicht).
    ids: HashSet<String>,
    /// [180] Elemente, die nicht anwählbar sind (ausgeblendet oder gesperrt; graue bleiben anwählbar).
    pick: HashSet<String>,
}

impl ClassFilter {
    /// Nichts ausgeblendet.
    pub fn none() -> ClassFilter {
        ClassFilter::default()
    }

    /// Ebenen-Baum des Projekts plus die Codes `extra` (Darstellungsmodus des Aufrufers).
    pub fn new(p: &Project, extra: &[String]) -> ClassFilter {
        ClassFilter::with_elements(p, extra, &ElementSelection::default())
    }

    /// Wie [`Self::new`], dazu die Element-Auswahl `sel` ([185]): nur `only` zeigen, `hide` ausblenden.
    pub fn with_elements(p: &Project, extra: &[String], sel: &ElementSelection) -> ClassFilter {
        let mut codes: HashSet<String> = hidden_category_codes(&p.layers).into_iter().map(String::from).collect();
        codes.extend(extra.iter().cloned());
        let mut ids = HashSet::new();
        if codes.is_empty() && sel.is_empty() {
            return ClassFilter { codes, ids, pick: HashSet::new() };
        }
        // Gewählte Öffnungen bringen ihren Wirt mit (eine Öffnung ohne Wand gibt es im 3D nicht).
        let only: Option<HashSet<&str>> = sel.only.as_ref().map(|o| {
            let mut s: HashSet<&str> = o.iter().map(String::as_str).collect();
            for op in p.openings.as_deref().unwrap_or(&[]) {
                if o.contains(&op.id) {
                    s.extend(opening_hosts(op));
                }
            }
            s
        });
        // Ausgeblendet, grau (nicht ausgeblendet), gesperrt — je Element.
        let mut hidden = HashSet::new();
        let mut grey = HashSet::new();
        let mut locked = HashSet::new();
        let mut add = |code: &str, id: &str, floor: &str| {
            if codes.contains(code) || sel.hide.contains(id) || sel.hide_floors.contains(floor) || only.as_ref().is_some_and(|o| !o.contains(id)) {
                hidden.insert(id.to_owned());
            } else if sel.grey.contains(code) || sel.grey_floors.contains(floor) {
                grey.insert(id.to_owned());
            }
            if sel.lock.contains(code) {
                locked.insert(id.to_owned());
            }
        };
        for w in &p.walls {
            add(&w.category_code, &w.id, &w.floor_id);
        }
        for c in p.ceilings.as_deref().unwrap_or(&[]) {
            add(&c.category_code, &c.id, &c.floor_id);
        }
        for r in p.roofs.as_deref().unwrap_or(&[]) {
            add(&r.category_code, &r.id, &r.floor_id);
        }
        for s in p.stairs.as_deref().unwrap_or(&[]) {
            add(&s.category_code, &s.id, &s.floor_id);
        }
        for c in p.columns.as_deref().unwrap_or(&[]) {
            add(&c.category_code, &c.id, &c.floor_id);
        }
        for t in p.trees.as_deref().unwrap_or(&[]) {
            add(&t.category_code, &t.id, &t.floor_id);
        }
        for s in p.extruded_solids.as_deref().unwrap_or(&[]) {
            add(&s.category_code, &s.id, "");
        }
        for c in p.context.as_deref().unwrap_or(&[]) {
            add(c.category_code(), c.id(), "");
        }
        for d in &p.drawings2d {
            add(&d.category_code, &d.id, &d.level_id);
        }
        // Öffnungen nach den Wirten (Wand, Dach, Decke), die jetzt schon eingeordnet sind; mit `only` zeigt
        // ein gewählter Wirt seine Öffnungen. Grau ist eine Öffnung mit grauer Klasse oder grauem Wirt.
        for o in p.openings.as_deref().unwrap_or(&[]) {
            if codes.contains(&o.category_code) || sel.hide.contains(&o.id) || opening_hosts(o).any(|h| hidden.contains(h)) {
                hidden.insert(o.id.clone());
            } else if sel.grey.contains(&o.category_code) || opening_hosts(o).any(|h| grey.contains(h)) {
                grey.insert(o.id.clone());
            }
            if sel.lock.contains(&o.category_code) {
                locked.insert(o.id.clone());
            }
        }
        let pick: HashSet<String> = hidden.iter().chain(&locked).cloned().collect();
        if sel.ghost {
            // Geisterschicht: alles ausser den grauen Elementen fehlt.
            let all = p.walls.iter().map(|w| &w.id)
                .chain(p.ceilings.iter().flatten().map(|c| &c.id))
                .chain(p.roofs.iter().flatten().map(|r| &r.id))
                .chain(p.stairs.iter().flatten().map(|s| &s.id))
                .chain(p.columns.iter().flatten().map(|c| &c.id))
                .chain(p.trees.iter().flatten().map(|t| &t.id))
                .chain(p.extruded_solids.iter().flatten().map(|s| &s.id))
                .chain(p.drawings2d.iter().map(|d| &d.id))
                .chain(p.openings.iter().flatten().map(|o| &o.id));
            ids.extend(all.filter(|id| !grey.contains(*id)).cloned());
            ids.extend(p.context.iter().flatten().map(|c| c.id()).filter(|id| !grey.contains(*id)).map(String::from));
        } else {
            ids = hidden;
            ids.extend(grey);
        }
        ClassFilter { codes, ids, pick }
    }

    /// `text` der 3D-Abfragen: `{"hide": [codes], "only": [ids], "hideIds": [ids], "grey": [codes], "greyFloors": [ids], "lock": [codes],
    /// "ghost": bool, …}` (fehlt/kein JSON:
    /// nur der Ebenen-Baum; `only` fehlt/`null` = alle Elemente, [185]).
    pub fn from_text(p: &Project, text: &str) -> ClassFilter {
        let t = text.trim();
        let v = if t.starts_with('{') { serde_json::from_str::<serde_json::Value>(t).ok() } else { None };
        let list = |key: &str| -> Option<Vec<String>> {
            v.as_ref()
                .and_then(|v| v.get(key))
                .and_then(|a| a.as_array())
                .map(|a| a.iter().filter_map(|s| s.as_str().map(String::from)).collect())
        };
        let sel = ElementSelection {
            only: list("only").map(|o| o.into_iter().collect()),
            hide: list("hideIds").unwrap_or_default().into_iter().collect(),
            hide_floors: list("hideFloors").unwrap_or_default().into_iter().collect(),
            grey: list("grey").unwrap_or_default().into_iter().collect(),
            grey_floors: list("greyFloors").unwrap_or_default().into_iter().collect(),
            lock: list("lock").unwrap_or_default().into_iter().collect(),
            ghost: v.as_ref().and_then(|v| v.get("ghost")).and_then(|b| b.as_bool()).unwrap_or(false),
        };
        ClassFilter::with_elements(p, &list("hide").unwrap_or_default(), &sel)
    }

    /// Kein Element ausgeblendet.
    pub fn is_empty(&self) -> bool {
        self.ids.is_empty()
    }

    /// Klasse `code` ausgeblendet.
    pub fn hides_code(&self, code: &str) -> bool {
        self.codes.contains(code)
    }

    /// Element `id` ausgeblendet.
    pub fn hides(&self, id: &str) -> bool {
        self.ids.contains(id)
    }

    /// Öffnung sichtbar (eigene Klasse und Wirt).
    pub fn keep_opening(&self, o: &Opening) -> bool {
        !self.ids.contains(&o.id)
    }

    /// Teil mit Herkunft `o` (Index in den Listen von `p`) sichtbar.
    pub fn keep_owner(&self, p: &Project, o: Owner) -> bool {
        o.id(p).is_none_or(|id| !self.ids.contains(id))
    }

    /// Teile ohne die Wand-/Öffnungs-Einbauteile filtern (die filtert der Aufrufer, s. Modulkopf).
    pub fn retain_rest(&self, p: &Project, parts: &mut Parts) {
        if self.is_empty() {
            return;
        }
        parts.slabs.retain(|s| !self.hides(&s.ceiling_id));
        for list in [&mut parts.context_meshes, &mut parts.solid_meshes, &mut parts.column_meshes, &mut parts.stair_meshes, &mut parts.stair_railings, &mut parts.roof_meshes] {
            list.retain(|m| self.keep_owner(p, m.owner));
        }
        parts.roof_layers.retain(|l| self.keep_owner(p, l.owner));
    }

    /// Wandkörper filtern.
    pub fn retain_walls(&self, parts: &mut Parts) {
        if !self.is_empty() {
            parts.walls.retain(|w| !self.hides(&w.wall_id));
        }
    }

    /// Pick-Geometrie: ausgeblendete und gesperrte Elemente sind nicht anwählbar (graue schon, wie im Grundriss).
    pub fn retain_pick(&self, g: &mut PickGeometry) {
        if self.pick.is_empty() {
            return;
        }
        let k = |id: &str| !self.pick.contains(id);
        g.walls.retain(|w| k(&w.wall_id));
        g.slabs.retain(|s| k(&s.ceiling_id));
        g.openings.retain(|o| k(&o.opening_id));
        g.stairs.retain(|s| k(&s.stair_id));
        g.roofs.retain(|r| k(&r.roof_id));
        g.context_meshes.retain(|c| k(&c.context_object_id));
        g.columns.retain(|c| k(&c.column_id));
        g.solids.retain(|s| k(&s.solid_id));
        g.opening_meshes.retain(|o| k(&o.opening_id));
        g.drawings.retain(|d| k(&d.drawing_id));
        g.stair_meshes.retain(|s| k(&s.stair_id));
        g.drawing_meshes.retain(|d| k(&d.drawing_id));
        g.trees.retain(|t| k(&t.tree_id));
    }
}

/// Wie [`parts`], ohne die Teile ausgeblendeter Klassen.
pub fn parts_filtered(p: &Project, layered: bool, detail: f64, for_section: bool, f: &ClassFilter) -> Result<Parts, String> {
    let mut slabs = emit_slabs(p);
    slabs.extend(emit_stairs(p, for_section));
    let mut out = Parts {
        walls: emit_walls(p, layered)?,
        slabs,
        context_meshes: emit_context_meshes(p),
        solid_meshes: emit_solids(p),
        column_meshes: {
            let mut m = emit_columns(p);
            m.extend(emit_trees(p));
            m
        },
        opening_meshes: emit_opening_meshes_with(p, detail, &|o| f.keep_opening(o)),
        stair_meshes: emit_stair_meshes(p),
        stair_railings: emit_stair_railings(p),
        roof_meshes: emit_roofs(p, None)?,
        roof_layers: emit_roof_cut_layers(p)?,
    };
    f.retain_walls(&mut out);
    f.retain_rest(p, &mut out);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Stütze (25), Baum (13), Treppe mit Geländer (35) und eine Linie (60) auf zwei Geschossen.
    fn project(hidden: &[&str]) -> Project {
        let layers: Vec<serde_json::Value> = ["25", "13", "35", "60"].iter().map(|c| serde_json::json!({"code": c, "name": c, "color": "#000000", "visible": !hidden.contains(c)})).collect();
        serde_json::from_value(serde_json::json!({
            "id": "p", "name": "t", "lineStyles": [], "hatches": [], "components": [], "wallTypes": [], "layers": layers, "openings": [], "walls": [],
            "drawingLevels": [
                {"id": "EG", "name": "EG", "kind": "floor", "visible": true, "locked": false, "floorHeight": 3.0, "baseElevation": 0.0},
                {"id": "OG", "name": "OG", "kind": "floor", "visible": true, "locked": false, "floorHeight": 3.0, "baseElevation": 3.0}],
            "columns": [{"id": "k1", "type": "column", "floorId": "OG", "categoryCode": "25", "position": {"x": 2, "y": 3}, "profile": {"kind": "rect", "width": 0.3, "depth": 0.3}, "rotation": 0, "height": 2.5}],
            "trees": [{"id": "T1", "type": "tree", "floorId": "EG", "categoryCode": "13", "position": {"x": 20, "y": 5}, "trunkDiameter": 0.4, "crownDiameter": 6.0, "crownBase": 3.0, "height": 12.0}],
            "stairTypes": [{"id": "t", "name": "T", "structure": "massiv", "closedRisers": false, "treadThickness": 0.04, "railing": "beide", "defaultWidth": 1.0}],
            "stairs": [{"id": "s1", "type": "stair", "floorId": "EG", "categoryCode": "35", "shape": "straight", "start": {"x": 0, "y": 0}, "dir": {"x": 1, "y": 0},
                "runLength": 3.0, "width": 1.0, "stepCount": 16, "totalRise": 2.8, "typeId": "t"}],
            "drawings2d": [{"id": "L", "type": "drawing2d", "levelId": "EG", "categoryCode": "60", "geom": {"shape": "line", "a": {"x": 0, "y": 0}, "b": {"x": 5, "y": 0}}}]
        }))
        .unwrap()
    }

    /// Teile je Klasse: Stütze, Baum, Treppe (Tritte + Geländer), Linie.
    fn counts(p: &Project, f: &ClassFilter, gap: f64) -> [usize; 4] {
        let parts = crate::explode3d::parts_filtered(p, true, 2.0, false, gap, f).unwrap();
        let col = parts.column_meshes.iter().filter(|m| matches!(m.owner, Owner::Column(_))).count();
        let tree = parts.column_meshes.iter().filter(|m| matches!(m.owner, Owner::Tree(_))).count();
        let stair = parts.slabs.iter().filter(|s| s.ceiling_id == "s1").count() + parts.stair_railings.len();
        let lines = crate::explode3d::drawing_line_verts_filtered(p, gap, f).len();
        [col, tree, stair, lines]
    }

    /// [185] Element-Auswahl: `only` zeigt nur die genannten Elemente, `hideIds` blendet sie aus — in Teilen und Pick.
    #[test]
    fn element_auswahl_only_und_hide_ids() {
        let p = project(&[]);
        let ids = ["k1", "T1", "s1", "L"];
        for gap in [0.0, 2.0] {
            for (k, id) in ids.into_iter().enumerate() {
                for (text, shown) in [(format!(r#"{{"only":["{id}"]}}"#), true), (format!(r#"{{"hideIds":["{id}"]}}"#), false)] {
                    let f = ClassFilter::from_text(&p, &text);
                    let got = counts(&p, &f, gap);
                    for (i, n) in got.iter().enumerate() {
                        // `only`: nur das genannte Element da; `hideIds`: nur das genannte fehlt.
                        assert_eq!(*n > 0, (i == k) == shown, "{text}, Abstand {gap}: {got:?}");
                    }
                    let mut g = crate::explode3d::pick_geometry(&p, gap).unwrap();
                    f.retain_pick(&mut g);
                    let picks = [g.columns.len(), g.trees.len(), g.stairs.len() + g.stair_meshes.len(), g.drawings.len()];
                    for (i, n) in picks.iter().enumerate() {
                        assert_eq!(*n > 0, (i == k) == shown, "Pick {text}, Abstand {gap}: {picks:?}");
                    }
                }
            }
        }
        // Leere Auswahl `only: []` zeigt nichts, `only: null` alles.
        assert!(counts(&p, &ClassFilter::from_text(&p, r#"{"only":[]}"#), 0.0).iter().all(|&n| n == 0));
        assert!(counts(&p, &ClassFilter::from_text(&p, r#"{"only":null}"#), 0.0).iter().all(|&n| n > 0));
    }

    /// [185] Gewählte Wand zeigt ihre Öffnungen; gewählte Öffnung bringt ihren Wirt mit; ausgeblendete Wand nimmt sie mit.
    #[test]
    fn element_auswahl_oeffnungen_folgen_dem_wirt() {
        let mut p = project(&[]);
        let mut v = serde_json::to_value(&p).unwrap();
        v["walls"] = serde_json::json!([
            {"id": "w1", "type": "wall", "floorId": "EG", "categoryCode": "20", "start": {"x": 0, "y": 0}, "end": {"x": 5, "y": 0}, "wallTypeId": "aw", "height": 2.8},
            {"id": "w2", "type": "wall", "floorId": "EG", "categoryCode": "20", "start": {"x": 0, "y": 4}, "end": {"x": 5, "y": 4}, "wallTypeId": "aw", "height": 2.8}]);
        v["wallTypes"] = serde_json::json!([{"id": "aw", "name": "AW", "layers": [{"componentId": "c", "thickness": 0.2}]}]);
        v["openings"] = serde_json::json!([{"id": "o1", "type": "opening", "kind": "window", "hostWallId": "w1", "categoryCode": "40", "position": 2.0, "width": 1.0, "height": 1.2, "sillHeight": 0.9}]);
        p = match serde_json::from_value(v) {
            Ok(p) => p,
            Err(e) => panic!("Projekt: {e}"),
        };
        let f = ClassFilter::from_text(&p, r#"{"only":["w1"]}"#);
        assert!(!f.hides("w1") && !f.hides("o1") && f.hides("w2") && f.hides("k1"));
        let f = ClassFilter::from_text(&p, r#"{"only":["o1"]}"#);
        assert!(!f.hides("w1") && !f.hides("o1") && f.hides("w2"));
        let f = ClassFilter::from_text(&p, r#"{"hideIds":["w1"]}"#);
        assert!(f.hides("w1") && f.hides("o1") && !f.hides("w2"));
        let f = ClassFilter::from_text(&p, r#"{"hideIds":["o1"]}"#);
        assert!(!f.hides("w1") && f.hides("o1"));
        let mut g = crate::explode3d::pick_geometry(&p, 0.0).unwrap();
        ClassFilter::from_text(&p, r#"{"only":["w2"]}"#).retain_pick(&mut g);
        assert!(g.walls.iter().all(|w| w.wall_id == "w2") && !g.walls.is_empty());
        assert!(g.openings.is_empty() && g.columns.is_empty());
    }

    /// [197]/[196] Öffnungen ohne Wand (Dachfenster, Deckenöffnung) folgen ihrem Wirt: nur Wand gewählt → weg;
    /// Wirt Dach ausgeblendet → weg; Geschoss-Auge aus → Elemente des Geschosses samt Öffnungen weg.
    #[test]
    fn dachfenster_folgen_dem_wirt_und_geschoss_auge() {
        let mut v = serde_json::to_value(project(&[])).unwrap();
        v["walls"] = serde_json::json!([
            {"id": "w1", "type": "wall", "floorId": "EG", "categoryCode": "20", "start": {"x": 0, "y": 0}, "end": {"x": 5, "y": 0}, "wallTypeId": "aw", "height": 2.8},
            {"id": "w2", "type": "wall", "floorId": "OG", "categoryCode": "20", "start": {"x": 0, "y": 4}, "end": {"x": 5, "y": 4}, "wallTypeId": "aw", "height": 2.8}]);
        v["wallTypes"] = serde_json::json!([{"id": "aw", "name": "AW", "layers": [{"componentId": "c", "thickness": 0.2}]}]);
        v["roofs"] = serde_json::json!([{"id": "r1", "type": "roof", "floorId": "OG", "categoryCode": "31", "outline": [{"x": 0, "y": 0}, {"x": 6, "y": 0}, {"x": 6, "y": 5}, {"x": 0, "y": 5}],
            "shape": "sattel", "pitchDeg": 35, "overhang": 0.3, "ridgeAxis": "x", "baseElevation": 5.8, "thickness": 0.3}]);
        v["openings"] = serde_json::json!([
            {"id": "o1", "type": "opening", "kind": "window", "hostWallId": "w1", "categoryCode": "40", "position": 2.0, "width": 1.0, "height": 1.2, "sillHeight": 0.9},
            {"id": "o2", "type": "opening", "kind": "window", "hostWallId": "", "hostRoofId": "r1", "hostPoint": {"x": 3, "y": 1}, "categoryCode": "21", "position": 0, "width": 0.8, "height": 1.2, "sillHeight": 0}]);
        let p: Project = serde_json::from_value(v).unwrap_or_else(|e| panic!("Projekt: {e}"));
        let f = ClassFilter::from_text(&p, r#"{"only":["w1"]}"#);
        assert!(!f.hides("w1") && !f.hides("o1") && f.hides("o2") && f.hides("r1") && f.hides("w2"));
        let f = ClassFilter::from_text(&p, r#"{"only":["o2"]}"#);
        assert!(!f.hides("o2") && !f.hides("r1") && f.hides("o1") && f.hides("w1"));
        let f = ClassFilter::from_text(&p, r#"{"hideIds":["r1"]}"#);
        assert!(f.hides("o2") && !f.hides("o1"));
        let f = ClassFilter::from_text(&p, r#"{"hideFloors":["OG"]}"#);
        assert!(f.hides("w2") && f.hides("r1") && f.hides("o2") && f.hides("k1") && !f.hides("w1") && !f.hides("o1") && !f.hides("T1") && !f.hides("s1"));
        assert!(f.hides("L") == false);
        let f = ClassFilter::from_text(&p, r#"{"hideFloors":["EG"]}"#);
        assert!(f.hides("w1") && f.hides("o1") && f.hides("T1") && f.hides("s1") && f.hides("L") && !f.hides("w2") && !f.hides("o2"));
        // Teile und Pick ohne die Teile des ausgeblendeten Geschosses.
        let mut g = crate::explode3d::pick_geometry(&p, 0.0).unwrap();
        ClassFilter::from_text(&p, r#"{"hideFloors":["OG"]}"#).retain_pick(&mut g);
        assert!(g.walls.iter().all(|w| w.wall_id == "w1") && !g.walls.is_empty() && g.roofs.is_empty() && g.columns.is_empty());
        let parts = crate::explode3d::parts_filtered(&p, true, 2.0, false, 0.0, &ClassFilter::from_text(&p, r#"{"hideFloors":["OG"]}"#)).unwrap();
        assert!(parts.walls.iter().all(|w| w.wall_id == "w1") && parts.roof_meshes.is_empty() && parts.column_meshes.iter().all(|m| !matches!(m.owner, Owner::Column(_))));
    }

    /// [180] Darstellungsmodus „grau": die graue Klasse fehlt im Hauptmodell, die Geisterschicht (`ghost`) liefert nur
    /// sie; anwählbar bleibt sie, ausser sie ist gesperrt (`lock`); ausgeblendet geht vor grau.
    #[test]
    fn grau_klasse_in_der_geisterschicht() {
        let p = project(&[]);
        for gap in [0.0, 2.0] {
            for (k, code) in ["25", "13", "35", "60"].into_iter().enumerate() {
                let main = counts(&p, &ClassFilter::from_text(&p, &format!(r#"{{"grey":["{code}"]}}"#)), gap);
                let ghost = counts(&p, &ClassFilter::from_text(&p, &format!(r#"{{"grey":["{code}"],"ghost":true}}"#)), gap);
                for i in 0..4 {
                    assert_eq!(main[i] == 0, i == k, "Hauptmodell, {code} grau, Abstand {gap}: {main:?}");
                    assert_eq!(ghost[i] > 0, i == k, "Geisterschicht, {code} grau, Abstand {gap}: {ghost:?}");
                }
                // Grau bleibt anwählbar; grau + gesperrt nicht.
                let picks = |text: &str| {
                    let mut g = crate::explode3d::pick_geometry(&p, gap).unwrap();
                    ClassFilter::from_text(&p, text).retain_pick(&mut g);
                    [g.columns.len(), g.trees.len(), g.stairs.len() + g.stair_meshes.len(), g.drawings.len()]
                };
                assert!(picks(&format!(r#"{{"grey":["{code}"]}}"#)).iter().all(|&n| n > 0));
                let locked = picks(&format!(r#"{{"grey":["{code}"],"lock":["{code}"]}}"#));
                for (i, n) in locked.iter().enumerate() {
                    assert_eq!(*n == 0, i == k, "gesperrt {code}: {locked:?}");
                }
            }
        }
        // Ausgeblendet (Ebenen-Baum) geht vor grau: auch in der Geisterschicht weg.
        let q = project(&["25"]);
        assert!(counts(&q, &ClassFilter::from_text(&q, r#"{"grey":["25"],"ghost":true}"#), 0.0).iter().all(|&n| n == 0));
        // Ohne graue Klasse ist die Geisterschicht leer.
        assert!(counts(&p, &ClassFilter::from_text(&p, r#"{"ghost":true}"#), 0.0).iter().all(|&n| n == 0));
    }

    /// [180] Öffnungen sind grau mit ihrer Klasse oder ihrem Wirt: graue Wand nimmt ihr Fenster in die Geisterschicht mit;
    /// graues Fenster in normaler Wand steht allein in der Geisterschicht.
    #[test]
    fn grau_oeffnungen_folgen_klasse_und_wirt() {
        let mut v = serde_json::to_value(project(&[])).unwrap();
        v["walls"] = serde_json::json!([
            {"id": "w1", "type": "wall", "floorId": "EG", "categoryCode": "20", "start": {"x": 0, "y": 0}, "end": {"x": 5, "y": 0}, "wallTypeId": "aw", "height": 2.8}]);
        v["wallTypes"] = serde_json::json!([{"id": "aw", "name": "AW", "layers": [{"componentId": "c", "thickness": 0.2}]}]);
        v["openings"] = serde_json::json!([{"id": "o1", "type": "opening", "kind": "window", "hostWallId": "w1", "categoryCode": "40", "position": 2.0, "width": 1.0, "height": 1.2, "sillHeight": 0.9}]);
        let p: Project = serde_json::from_value(v).unwrap_or_else(|e| panic!("Projekt: {e}"));
        let f = ClassFilter::from_text(&p, r#"{"grey":["20"]}"#);
        assert!(f.hides("w1") && f.hides("o1") && !f.hides("k1"));
        let f = ClassFilter::from_text(&p, r#"{"grey":["20"],"ghost":true}"#);
        assert!(!f.hides("w1") && !f.hides("o1") && f.hides("k1") && f.hides("T1"));
        let f = ClassFilter::from_text(&p, r#"{"grey":["40"]}"#);
        assert!(!f.hides("w1") && f.hides("o1"));
        let f = ClassFilter::from_text(&p, r#"{"grey":["40"],"ghost":true}"#);
        assert!(f.hides("w1") && !f.hides("o1"));
        // Wand ausgeblendet, Fenster grau: weg (ausgeblendeter Wirt geht vor).
        let f = ClassFilter::from_text(&p, r#"{"hide":["20"],"grey":["40"],"ghost":true}"#);
        assert!(f.hides("w1") && f.hides("o1"));
        let parts = parts_filtered(&p, true, 2.0, false, &ClassFilter::from_text(&p, r#"{"grey":["20"],"ghost":true}"#)).unwrap();
        assert!(!parts.walls.is_empty() && parts.walls.iter().all(|w| w.wall_id == "w1") && !parts.opening_meshes.is_empty());
        assert!(parts.column_meshes.is_empty() && parts.stair_railings.is_empty());
    }

    /// [180] Graues Geschoss (`greyFloors`, Zeichnungsebenen-Modus „grau"): seine Elemente samt Öffnungen fehlen im
    /// Hauptmodell und stehen in der Geisterschicht; Geschoss-Auge aus (`hideFloors`) und ausgeblendete Klassen gehen vor.
    #[test]
    fn graues_geschoss_in_der_geisterschicht() {
        let mut v = serde_json::to_value(project(&[])).unwrap();
        v["walls"] = serde_json::json!([
            {"id": "w1", "type": "wall", "floorId": "EG", "categoryCode": "20", "start": {"x": 0, "y": 0}, "end": {"x": 5, "y": 0}, "wallTypeId": "aw", "height": 2.8},
            {"id": "w2", "type": "wall", "floorId": "OG", "categoryCode": "20", "start": {"x": 0, "y": 4}, "end": {"x": 5, "y": 4}, "wallTypeId": "aw", "height": 2.8}]);
        v["wallTypes"] = serde_json::json!([{"id": "aw", "name": "AW", "layers": [{"componentId": "c", "thickness": 0.2}]}]);
        v["openings"] = serde_json::json!([{"id": "o2", "type": "opening", "kind": "window", "hostWallId": "w2", "categoryCode": "40", "position": 2.0, "width": 1.0, "height": 1.2, "sillHeight": 0.9}]);
        let p: Project = serde_json::from_value(v).unwrap_or_else(|e| panic!("Projekt: {e}"));
        // Hauptmodell: OG-Elemente (Wand, Fenster, Stütze k1) fehlen, EG bleibt.
        let f = ClassFilter::from_text(&p, r#"{"greyFloors":["OG"]}"#);
        assert!(f.hides("w2") && f.hides("o2") && f.hides("k1") && !f.hides("w1") && !f.hides("T1") && !f.hides("s1") && !f.hides("L"));
        // Geisterschicht: nur das OG.
        let g = ClassFilter::from_text(&p, r#"{"greyFloors":["OG"],"ghost":true}"#);
        assert!(!g.hides("w2") && !g.hides("o2") && !g.hides("k1") && g.hides("w1") && g.hides("T1") && g.hides("s1") && g.hides("L"));
        let parts = parts_filtered(&p, true, 2.0, false, &g).unwrap();
        assert!(!parts.walls.is_empty() && parts.walls.iter().all(|w| w.wall_id == "w2") && !parts.opening_meshes.is_empty());
        assert!(parts.column_meshes.iter().all(|m| matches!(m.owner, Owner::Column(_))) && !parts.column_meshes.is_empty());
        // Das graue Geschoss bleibt anwählbar, gesperrt (Klasse im Sperr-Modus) nicht.
        let mut pg = crate::explode3d::pick_geometry(&p, 0.0).unwrap();
        ClassFilter::from_text(&p, r#"{"greyFloors":["OG"]}"#).retain_pick(&mut pg);
        assert!(pg.walls.iter().any(|w| w.wall_id == "w2") && !pg.columns.is_empty());
        // Auge aus geht vor grau; ausgeblendete Klasse ebenso.
        let g = ClassFilter::from_text(&p, r#"{"greyFloors":["OG"],"hideFloors":["OG"],"ghost":true}"#);
        assert!(g.hides("w2") && g.hides("o2") && g.hides("k1") && g.hides("w1"));
        let g = ClassFilter::from_text(&p, r#"{"greyFloors":["OG"],"hide":["20"],"ghost":true}"#);
        assert!(g.hides("w2") && g.hides("o2") && !g.hides("k1"));
        // 2D-Spuren und Flächenmuster der Geisterschicht: nur die des grauen Geschosses.
        let line = |f: &ClassFilter| crate::explode3d::drawing_line_verts_filtered(&p, 0.0, f).len();
        assert_eq!(line(&ClassFilter::from_text(&p, r#"{"greyFloors":["EG"],"ghost":true}"#)), line(&ClassFilter::none()));
        assert_eq!(line(&ClassFilter::from_text(&p, r#"{"greyFloors":["OG"],"ghost":true}"#)), 0);
        assert_eq!(line(&ClassFilter::from_text(&p, r#"{"greyFloors":["EG"]}"#)), 0);
    }

    /// Jede Klasse einzeln aus (Ebenen-Baum bzw. `hide`): nur ihr Teil fehlt im 3D (auch in der Explosion) und im Pick.
    #[test]
    fn klasse_aus_teil_fehlt_in_parts_und_pick() {
        let p = project(&[]);
        for gap in [0.0, 2.0] {
            let all = counts(&p, &ClassFilter::from_text(&p, ""), gap);
            assert!(all.iter().all(|&n| n > 0), "{all:?}");
            for (k, code) in ["25", "13", "35", "60"].into_iter().enumerate() {
                for (q, text) in [(project(&[code]), String::new()), (p.clone(), format!(r#"{{"hide":["{code}"]}}"#))] {
                    let f = ClassFilter::from_text(&q, &text);
                    let got = counts(&q, &f, gap);
                    for (i, n) in got.iter().enumerate() {
                        assert_eq!(*n == 0, i == k, "Klasse {code} aus, Abstand {gap}: {got:?}");
                    }
                    let mut g = crate::explode3d::pick_geometry(&q, gap).unwrap();
                    f.retain_pick(&mut g);
                    let picks = [g.columns.len(), g.trees.len(), g.stairs.len() + g.stair_meshes.len(), g.drawings.len()];
                    for (i, n) in picks.iter().enumerate() {
                        assert_eq!(*n == 0, i == k, "Pick, Klasse {code} aus, Abstand {gap}: {picks:?}");
                    }
                }
            }
        }
    }
}
