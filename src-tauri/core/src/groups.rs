//! Gruppen (Vectorworks-artig, [K4] S3, vorher `src/state/groupActions.ts`): Mitgliedschaft über
//! verschachtelte Gruppen, die im Isolations-Kontext sichtbare Gruppe eines Elements und das
//! Erweitern einer Treffer-Auswahl um ganze Gruppen. Reihenfolgen und Doppelungen wie in der
//! TS-Fassung (Vereinigung = `[...new Set([...a, ...b])]`, eigene Listen ohne Untergruppen bleiben roh).

use crate::model::{Group, Project};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

/// Mitglieds-IDs je Elementart (Form wie `Group` ohne `id`/`name`/`groupIds`).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Membership {
    pub wall_ids: Vec<String>,
    pub drawing_ids: Vec<String>,
    pub ceiling_ids: Vec<String>,
    pub room_ids: Vec<String>,
    pub stair_ids: Vec<String>,
    pub column_ids: Vec<String>,
    pub roof_ids: Vec<String>,
    pub opening_ids: Vec<String>,
}

/// Elementart (`MemberKind` in TS: `"wallIds"` …).
pub const KINDS: [&str; 8] = ["wallIds", "drawingIds", "ceilingIds", "roomIds", "stairIds", "columnIds", "roofIds", "openingIds"];

impl Membership {
    pub fn list(&self, kind: &str) -> Option<&Vec<String>> {
        Some(match kind {
            "wallIds" => &self.wall_ids,
            "drawingIds" => &self.drawing_ids,
            "ceilingIds" => &self.ceiling_ids,
            "roomIds" => &self.room_ids,
            "stairIds" => &self.stair_ids,
            "columnIds" => &self.column_ids,
            "roofIds" => &self.roof_ids,
            "openingIds" => &self.opening_ids,
            _ => return None,
        })
    }

    fn list_mut(&mut self, kind: &str) -> Option<&mut Vec<String>> {
        Some(match kind {
            "wallIds" => &mut self.wall_ids,
            "drawingIds" => &mut self.drawing_ids,
            "ceilingIds" => &mut self.ceiling_ids,
            "roomIds" => &mut self.room_ids,
            "stairIds" => &mut self.stair_ids,
            "columnIds" => &mut self.column_ids,
            "roofIds" => &mut self.roof_ids,
            "openingIds" => &mut self.opening_ids,
            _ => return None,
        })
    }

    fn of_group(g: &Group) -> Membership {
        Membership {
            wall_ids: g.wall_ids.clone(),
            drawing_ids: g.drawing_ids.clone(),
            ceiling_ids: g.ceiling_ids.clone(),
            room_ids: g.room_ids.clone(),
            stair_ids: g.stair_ids.clone(),
            column_ids: g.column_ids.clone(),
            roof_ids: g.roof_ids.clone(),
            opening_ids: g.opening_ids.clone(),
        }
    }

    /// Vereinigung je Art, erste Vorkommen in Reihenfolge (`mergeMembership`).
    pub fn merge(&mut self, other: &Membership) {
        for k in KINDS {
            let a = self.list_mut(k).expect("Art");
            let mut seen: HashSet<String> = HashSet::with_capacity(a.len());
            let mut out: Vec<String> = Vec::with_capacity(a.len());
            for id in a.drain(..).chain(other.list(k).expect("Art").iter().cloned()) {
                if seen.insert(id.clone()) {
                    out.push(id);
                }
            }
            *a = out;
        }
    }
}

fn groups(p: &Project) -> &[Group] {
    p.groups.as_deref().unwrap_or(&[])
}

fn find<'a>(p: &'a Project, id: &str) -> Option<&'a Group> {
    groups(p).iter().find(|g| g.id == id)
}

/// Transitive Mitgliedschaft einer Gruppe (Untergruppen rekursiv); Zyklenschutz über `seen`
/// (gemeinsam für alle Zweige, wie in TS).
pub fn transitive_membership(p: &Project, group_id: &str) -> Membership {
    transitive(p, group_id, &mut HashSet::new())
}

fn transitive(p: &Project, group_id: &str, seen: &mut HashSet<String>) -> Membership {
    if !seen.insert(group_id.to_string()) {
        return Membership::default();
    }
    let Some(g) = find(p, group_id) else { return Membership::default() };
    let mut out = Membership::of_group(g);
    for sub in &g.group_ids {
        let m = transitive(p, sub, seen);
        out.merge(&m);
    }
    out
}

/// Gruppen, die nicht Untergruppe einer Gruppe sind.
fn top_level(p: &Project) -> Vec<&Group> {
    let nested: HashSet<&str> = groups(p).iter().flat_map(|g| g.group_ids.iter().map(String::as_str)).collect();
    groups(p).iter().filter(|g| !nested.contains(g.id.as_str())).collect()
}

/// Die im Isolations-Kontext `path` (leer = nicht isoliert) sichtbare Gruppe, die das Element
/// enthält: ohne Isolation unter den obersten Gruppen, isoliert nur unter den direkten
/// Untergruppen der aktiven Gruppe. `None` = keine.
pub fn containing_group_id(p: &Project, kind: &str, id: &str, path: &[String]) -> Option<String> {
    let candidates: Vec<&Group> = match path.last() {
        None => top_level(p),
        Some(active) => find(p, active)?.group_ids.iter().filter_map(|gid| find(p, gid)).collect(),
    };
    candidates
        .into_iter()
        .find(|g| transitive_membership(p, &g.id).list(kind).is_some_and(|l| l.iter().any(|x| x == id)))
        .map(|g| g.id.clone())
}

/// Erweitert eine Treffer-Auswahl um die im Kontext sichtbaren Gruppen (deren transitive
/// Mitgliedschaft ersetzt die getroffene id); dazu die getroffenen Gruppen-ids in Reihenfolge.
pub fn expand_to_groups(p: &Project, raw: &Membership, path: &[String]) -> (Membership, Vec<String>) {
    let mut expanded = Membership::default();
    let mut group_ids: Vec<String> = Vec::new();
    for k in KINDS {
        for id in raw.list(k).expect("Art") {
            match containing_group_id(p, k, id, path) {
                Some(gid) => {
                    let m = transitive_membership(p, &gid);
                    if !group_ids.contains(&gid) {
                        group_ids.push(gid);
                    }
                    expanded.merge(&m);
                }
                None => {
                    let mut one = Membership::default();
                    one.list_mut(k).expect("Art").push(id.clone());
                    expanded.merge(&one);
                }
            }
        }
    }
    (expanded, group_ids)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn project(groups: serde_json::Value) -> Project {
        serde_json::from_value(json!({"id":"p","name":"","lineStyles":[],"hatches":[],"components":[],"wallTypes":[],"drawingLevels":[],"layers":[],"walls":[],"drawings2d":[],"groups":groups})).unwrap()
    }
    fn g(id: &str, walls: &[&str], subs: &[&str]) -> serde_json::Value {
        json!({"id":id,"wallIds":walls,"drawingIds":[],"ceilingIds":[],"roomIds":[],"stairIds":[],"columnIds":[],"roofIds":[],"openingIds":[],"groupIds":subs})
    }

    #[test]
    fn transitiv_mit_zyklus_und_doppelungen() {
        let p = project(json!([g("a", &["w1", "w1"], &[]), g("b", &["w2", "w1"], &["a", "c"]), g("c", &["w3"], &["b"])]));
        // Ohne Untergruppen bleiben Doppelungen (wie TS: Kopie ohne Vereinigung).
        assert_eq!(transitive_membership(&p, "a").wall_ids, ["w1", "w1"]);
        // Mit Untergruppen vereinigt; Zyklus b → c → b endet.
        assert_eq!(transitive_membership(&p, "b").wall_ids, ["w2", "w1", "w3"]);
        assert_eq!(transitive_membership(&p, "x"), Membership::default());
    }

    #[test]
    fn sichtbare_gruppe_und_erweitern() {
        let p = project(json!([g("inner", &["w1"], &[]), g("outer", &["w2"], &["inner"]), g("solo", &["w9"], &[])]));
        assert_eq!(containing_group_id(&p, "wallIds", "w1", &[]), Some("outer".into()));
        assert_eq!(containing_group_id(&p, "wallIds", "w1", &["outer".into()]), Some("inner".into()));
        assert_eq!(containing_group_id(&p, "wallIds", "w2", &["outer".into()]), None);
        assert_eq!(containing_group_id(&p, "wallIds", "w5", &[]), None);
        assert_eq!(containing_group_id(&p, "nope", "w1", &[]), None);
        let raw = Membership { wall_ids: vec!["w5".into(), "w1".into(), "w2".into()], ..Default::default() };
        let (e, ids) = expand_to_groups(&p, &raw, &[]);
        assert_eq!(e.wall_ids, ["w5", "w2", "w1"]);
        assert_eq!(ids, ["outer"]);
    }
}
