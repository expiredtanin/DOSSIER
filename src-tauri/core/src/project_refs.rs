//! Warnungen zu einem Projekt, das trotzdem geladen und gerechnet werden kann (`dossier-cli validate`,
//! TS `projectWarnings`): hängende Verweise (Wandtyp, Bauteil, Geschoss, Schraffur, Linienstil, Stift,
//! Gruppe, Layout …), Gruppen/Ordner, die sich selbst enthalten, und Werte, die nicht zum Modell passen
//! (`model::lenient` setzt dort die Vorgabe ein). Die Ableitungen fallen in all diesen Fällen auf
//! Vorgaben zurück — die Warnung sagt, wo.

use crate::model::{lenient, Drawing2DGeom, Project};
use serde_json::{Map, Value};
use std::collections::{HashMap, HashSet};

/// Warnungen (deutsch, je eine Zeile) für die JSON-Wurzel eines Projekts.
pub fn project_warnings(root: &Map<String, Value>) -> Vec<String> {
    let (p, dropped) = lenient::project_lenient(root);
    let mut out: Vec<String> = dropped.into_iter().map(|d| format!("Wert passt nicht zum Modell, Vorgabe verwendet: {d}")).collect();
    out.extend(dangling_refs(&p));
    out
}

fn ids<'a, T: 'a>(items: impl IntoIterator<Item = &'a T>, id: impl Fn(&'a T) -> &'a str) -> HashSet<&'a str> {
    items.into_iter().map(id).collect()
}

/// Hängende Verweise und Zyklen im typisierten Projekt.
pub fn dangling_refs(p: &Project) -> Vec<String> {
    let mut out = Vec::new();
    let levels = ids(&p.drawing_levels, |l| l.id.as_str());
    let wall_types = ids(&p.wall_types, |t| t.id.as_str());
    let ceiling_types = ids(p.ceiling_types.as_deref().unwrap_or(&[]), |t| t.id.as_str());
    let roof_types = ids(p.roof_types.as_deref().unwrap_or(&[]), |t| t.id.as_str());
    let door_types = ids(p.door_types.as_deref().unwrap_or(&[]), |t| t.id.as_str());
    let window_types = ids(p.window_types.as_deref().unwrap_or(&[]), |t| t.id.as_str());
    let stair_types = ids(p.stair_types.as_deref().unwrap_or(&[]), |t| t.id.as_str());
    let components = ids(&p.components, |c| c.id.as_str());
    let hatches = ids(&p.hatches, |h| h.id.as_str());
    let line_styles = ids(&p.line_styles, |l| l.id.as_str());
    let pens = ids(p.pens.as_deref().unwrap_or(&[]), |x| x.id.as_str());
    let block_defs = ids(p.block_defs.as_deref().unwrap_or(&[]), |b| b.id.as_str());
    let walls = ids(&p.walls, |w| w.id.as_str());
    let snapshots = ids(p.view_snapshots.as_deref().unwrap_or(&[]), |s| s.id.as_str());
    let masters = ids(p.master_layouts.as_deref().unwrap_or(&[]), |m| m.id.as_str());
    let layout_folders = ids(p.layout_folders.as_deref().unwrap_or(&[]), |f| f.id.as_str());
    let snapshot_folders = ids(p.view_snapshot_folders.as_deref().unwrap_or(&[]), |f| f.id.as_str());

    fn miss(out: &mut Vec<String>, what: &str, owner: &str, kind: &str, id: &str, known: &HashSet<&str>) {
        if !id.is_empty() && !known.contains(id) {
            out.push(format!("{what} „{owner}\": {kind} „{id}\" fehlt."));
        }
    }
    fn check_pens(out: &mut Vec<String>, pens: &HashSet<&str>, what: &str, owner: &str, ps: [&Option<String>; 3]) {
        for x in ps {
            miss(out, what, owner, "Stift", x.as_deref().unwrap_or(""), pens);
        }
    }
    let none: Option<String> = None;

    for w in &p.walls {
        miss(&mut out, "Wand", &w.id, "Geschoss", &w.floor_id, &levels);
        miss(&mut out, "Wand", &w.id, "Wandtyp", &w.wall_type_id, &wall_types);
        miss(&mut out, "Wand", &w.id, "Schraffur", w.hatch_id.as_deref().unwrap_or(""), &hatches);
        check_pens(&mut out, &pens, "Wand", &w.id, [&w.color_pen_id, &w.foreground_pen_id, &w.background_pen_id]);
    }
    for o in p.openings.as_deref().unwrap_or(&[]) {
        miss(&mut out, "Öffnung", &o.id, "Wand", &o.host_wall_id, &walls);
        // Dach-/Deckenwirt ([103]).
        let roof_ids = ids(p.roofs.as_deref().unwrap_or(&[]), |r| r.id.as_str());
        let ceiling_ids = ids(p.ceilings.as_deref().unwrap_or(&[]), |c| c.id.as_str());
        miss(&mut out, "Öffnung", &o.id, "Dach", o.host_roof_id.as_deref().unwrap_or(""), &roof_ids);
        miss(&mut out, "Öffnung", &o.id, "Decke", o.host_ceiling_id.as_deref().unwrap_or(""), &ceiling_ids);
        let types = if door_types.contains(o.type_id.as_deref().unwrap_or("")) { &door_types } else { &window_types };
        miss(&mut out, "Öffnung", &o.id, "Typ", o.type_id.as_deref().unwrap_or(""), types);
        check_pens(&mut out, &pens, "Öffnung", &o.id, [&o.color_pen_id, &none, &none]);
    }
    for c in p.ceilings.as_deref().unwrap_or(&[]) {
        miss(&mut out, "Decke", &c.id, "Geschoss", &c.floor_id, &levels);
        match c.ceiling_type_id.as_deref().filter(|s| !s.is_empty()) {
            Some(t) if ceiling_types.contains(t) => {}
            Some(t) if !c.wall_type_id.is_empty() && wall_types.contains(c.wall_type_id.as_str()) => {
                out.push(format!("Decke „{}\": Deckentyp „{t}\" fehlt (Wandtyp „{}\" verwendet).", c.id, c.wall_type_id))
            }
            Some(t) => out.push(format!("Decke „{}\": Deckentyp „{t}\" fehlt.", c.id)),
            None => miss(&mut out, "Decke", &c.id, "Wandtyp", &c.wall_type_id, &wall_types),
        }
        miss(&mut out, "Decke", &c.id, "Schraffur", c.hatch_id.as_deref().unwrap_or(""), &hatches);
        check_pens(&mut out, &pens, "Decke", &c.id, [&c.color_pen_id, &c.foreground_pen_id, &c.background_pen_id]);
    }
    for r in p.roofs.as_deref().unwrap_or(&[]) {
        miss(&mut out, "Dach", &r.id, "Geschoss", &r.floor_id, &levels);
        miss(&mut out, "Dach", &r.id, "Dachtyp", r.roof_type_id.as_deref().unwrap_or(""), &roof_types);
    }
    for s in p.stairs.as_deref().unwrap_or(&[]) {
        miss(&mut out, "Treppe", &s.id, "Geschoss", &s.floor_id, &levels);
        miss(&mut out, "Treppe", &s.id, "Treppentyp", s.type_id.as_deref().unwrap_or(""), &stair_types);
    }
    for c in p.columns.as_deref().unwrap_or(&[]) {
        miss(&mut out, "Stütze", &c.id, "Geschoss", &c.floor_id, &levels);
        miss(&mut out, "Stütze", &c.id, "Bauteil", c.component_id.as_deref().unwrap_or(""), &components);
        miss(&mut out, "Stütze", &c.id, "Schraffur", c.hatch_id.as_deref().unwrap_or(""), &hatches);
    }
    for r in p.rooms.as_deref().unwrap_or(&[]) {
        miss(&mut out, "Raum", &r.id, "Geschoss", &r.floor_id, &levels);
    }
    for d in &p.drawings2d {
        miss(&mut out, "Zeichnung", &d.id, "Ebene", &d.level_id, &levels);
        miss(&mut out, "Zeichnung", &d.id, "Linienstil", d.line_style_id.as_deref().unwrap_or(""), &line_styles);
        miss(&mut out, "Zeichnung", &d.id, "Schraffur", d.hatch_id.as_deref().unwrap_or(""), &hatches);
        check_pens(&mut out, &pens, "Zeichnung", &d.id, [&d.color_pen_id, &d.foreground_pen_id, &d.background_pen_id]);
        if let Drawing2DGeom::Block { block_def_id, .. } = &d.geom {
            miss(&mut out, "Zeichnung", &d.id, "Block", block_def_id, &block_defs);
        }
    }
    for x in p.extruded_solids.as_deref().unwrap_or(&[]) {
        miss(&mut out, "Körper", &x.id, "Ebene", &x.level_id, &levels);
    }
    let type_layers = p
        .wall_types
        .iter()
        .map(|t| ("Wandtyp", &t.id, &t.layers))
        .chain(p.ceiling_types.as_deref().unwrap_or(&[]).iter().map(|t| ("Deckentyp", &t.id, &t.layers)))
        .chain(p.roof_types.as_deref().unwrap_or(&[]).iter().map(|t| ("Dachtyp", &t.id, &t.layers)));
    for (what, id, layers) in type_layers {
        for l in layers {
            miss(&mut out, what, id, "Bauteil", &l.component_id, &components);
            miss(&mut out, what, id, "Linienstil", l.joint_line_style_id.as_deref().unwrap_or(""), &line_styles);
        }
    }
    for c in &p.components {
        miss(&mut out, "Bauteil", &c.id, "Schraffur", &c.hatch_id, &hatches);
        miss(&mut out, "Bauteil", &c.id, "Schraffur", c.view_hatch_id.as_deref().unwrap_or(""), &hatches);
        check_pens(&mut out, &pens, "Bauteil", &c.id, [&c.color_pen_id, &c.foreground_pen_id, &c.background_pen_id]);
    }
    for h in &p.hatches {
        miss(&mut out, "Schraffur", &h.id, "Linienstil", h.line_style_id.as_deref().unwrap_or(""), &line_styles);
    }
    for c in p.flat_categories() {
        check_pens(&mut out, &pens, "Kategorie", &c.code, [&c.color_pen_id, &none, &none]);
    }
    let pen_sets = ids(p.pen_sets.as_deref().unwrap_or(&[]), |s| s.id.as_str());
    miss(&mut out, "Projekt", &p.id, "Stiftsatz", p.active_pen_set_id.as_deref().unwrap_or(""), &pen_sets);
    for l in p.layouts.as_deref().unwrap_or(&[]) {
        miss(&mut out, "Layout", &l.id, "Master", l.master_id.as_deref().unwrap_or(""), &masters);
        miss(&mut out, "Layout", &l.id, "Ordner", l.folder_id.as_deref().unwrap_or(""), &layout_folders);
        for v in &l.viewports {
            miss(&mut out, "Layout", &l.id, "Ausschnitt", &v.snapshot_id, &snapshots);
        }
    }
    for m in p.master_layouts.as_deref().unwrap_or(&[]) {
        miss(&mut out, "Master-Layout", &m.id, "Ordner", m.folder_id.as_deref().unwrap_or(""), &layout_folders);
    }
    for s in p.view_snapshots.as_deref().unwrap_or(&[]) {
        miss(&mut out, "Ausschnitt", &s.id, "Geschoss", &s.active_level_id, &levels);
        miss(&mut out, "Ausschnitt", &s.id, "Ordner", s.folder_id.as_deref().unwrap_or(""), &snapshot_folders);
    }

    // Gruppen: Mitglieder und Zyklen.
    let groups = p.groups.as_deref().unwrap_or(&[]);
    let group_ids = ids(groups, |g| g.id.as_str());
    let members: [(&str, HashSet<&str>); 7] = [
        ("Zeichnung", ids(&p.drawings2d, |d| d.id.as_str())),
        ("Decke", ids(p.ceilings.as_deref().unwrap_or(&[]), |x| x.id.as_str())),
        ("Raum", ids(p.rooms.as_deref().unwrap_or(&[]), |x| x.id.as_str())),
        ("Treppe", ids(p.stairs.as_deref().unwrap_or(&[]), |x| x.id.as_str())),
        ("Stütze", ids(p.columns.as_deref().unwrap_or(&[]), |x| x.id.as_str())),
        ("Dach", ids(p.roofs.as_deref().unwrap_or(&[]), |x| x.id.as_str())),
        ("Öffnung", ids(p.openings.as_deref().unwrap_or(&[]), |x| x.id.as_str())),
    ];
    for g in groups {
        for w in &g.wall_ids {
            miss(&mut out, "Gruppe", &g.id, "Wand", w, &walls);
        }
        let lists = [&g.drawing_ids, &g.ceiling_ids, &g.room_ids, &g.stair_ids, &g.column_ids, &g.roof_ids, &g.opening_ids];
        for (list, (kind, known)) in lists.into_iter().zip(&members) {
            for id in list {
                miss(&mut out, "Gruppe", &g.id, kind, id, known);
            }
        }
        for id in &g.group_ids {
            miss(&mut out, "Gruppe", &g.id, "Gruppe", id, &group_ids);
        }
    }
    let children: HashMap<&str, Vec<&str>> = groups.iter().map(|g| (g.id.as_str(), g.group_ids.iter().map(String::as_str).collect())).collect();
    for g in groups {
        if reaches(&children, &g.id, &g.id) {
            out.push(format!("Gruppe „{}\" enthält sich selbst (über verschachtelte Gruppen).", g.id));
        }
    }
    // Ordner: Eltern-Ketten ohne Zyklus.
    let folder_cycles = |what: &str, parents: HashMap<&str, &str>, out: &mut Vec<String>| {
        for &start in parents.keys() {
            let mut seen = HashSet::new();
            let mut cur = start;
            while let Some(&next) = parents.get(cur) {
                if next == start {
                    out.push(format!("{what} „{start}\" ist sein eigener Vorfahre."));
                    break;
                }
                if !seen.insert(next) {
                    break;
                }
                cur = next;
            }
        }
    };
    let lf = p.layout_folders.as_deref().unwrap_or(&[]);
    folder_cycles("Layout-Ordner", lf.iter().filter_map(|f| Some((f.id.as_str(), f.parent_id.as_deref()?))).collect(), &mut out);
    let sf = p.view_snapshot_folders.as_deref().unwrap_or(&[]);
    folder_cycles("Ausschnitt-Ordner", sf.iter().filter_map(|f| Some((f.id.as_str(), f.parent_id.as_deref()?))).collect(), &mut out);
    out.sort();
    out.dedup();
    out
}

/// Erreicht `from` über `children` (ohne sich selbst als Start zu zählen) den Knoten `target`?
fn reaches(children: &HashMap<&str, Vec<&str>>, from: &str, target: &str) -> bool {
    let mut stack: Vec<&str> = children.get(from).cloned().unwrap_or_default();
    let mut seen: HashSet<&str> = HashSet::new();
    while let Some(n) = stack.pop() {
        if n == target {
            return true;
        }
        if seen.insert(n) {
            stack.extend(children.get(n).into_iter().flatten().copied());
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn root(v: Value) -> Map<String, Value> {
        match v {
            Value::Object(m) => m,
            _ => unreachable!(),
        }
    }

    #[test]
    fn haengende_verweise_und_zyklen() {
        let r = root(json!({
            "id": "p",
            "drawingLevels": [{"id": "eg", "kind": "floor"}],
            "wallTypes": [{"id": "aw", "layers": [{"componentId": "beton", "thickness": 0.2}]}],
            "components": [],
            "walls": [{"id": "w1", "floorId": "eg", "wallTypeId": "nope"}, {"id": "w2", "floorId": "og", "wallTypeId": "aw", "height": null}],
            "openings": [{"id": "o1", "hostWallId": "w9"}],
            "groups": [
                {"id": "g1", "groupIds": ["g2"], "wallIds": ["w1"]},
                {"id": "g2", "groupIds": ["g1", "g3"]}
            ],
            "layoutFolders": [{"id": "a", "parentId": "b"}, {"id": "b", "parentId": "a"}, {"id": "c", "parentId": "c"}]
        }));
        let w = project_warnings(&r);
        let has = |s: &str| w.iter().any(|x| x.contains(s));
        assert!(has("Wand „w1\": Wandtyp „nope\" fehlt."), "{w:#?}");
        assert!(has("Wand „w2\": Geschoss „og\" fehlt."));
        assert!(has("Wandtyp „aw\": Bauteil „beton\" fehlt."));
        assert!(has("Öffnung „o1\": Wand „w9\" fehlt."));
        assert!(has("Gruppe „g2\": Gruppe „g3\" fehlt."));
        assert!(has("Gruppe „g1\" enthält sich selbst"));
        assert!(has("Layout-Ordner „a\" ist sein eigener Vorfahre.") && has("Layout-Ordner „c\""));
        assert!(has("Vorgabe verwendet: walls[1].height"));
    }

    #[test]
    fn stimmiges_projekt_ohne_warnung() {
        let r = root(json!({
            "id": "p",
            "drawingLevels": [{"id": "eg"}],
            "wallTypes": [{"id": "aw", "layers": [{"componentId": "beton", "thickness": 0.2}]}],
            "components": [{"id": "beton", "hatchId": ""}],
            "walls": [{"id": "w1", "floorId": "eg", "wallTypeId": "aw"}]
        }));
        assert_eq!(project_warnings(&r), Vec::<String>::new());
    }
}
