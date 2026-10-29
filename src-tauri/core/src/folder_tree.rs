//! Ordner-Bäume ([K4] S3, vorher `model/layoutModel.ts` und `state/viewSnapshotFolders.ts` — beide hatten
//! dieselbe Rechnung): flache Ordner-/Blatt-Listen zum Baum, Blätter eines Ordners in Baum-Reihenfolge,
//! Nachfahren-Test (Zyklenschutz beim Verschieben) und die Umhängung beim Löschen eines Ordners.
//! Alles rechnet auf Indizes der Eingabelisten (die TS-Fassade setzt daraus die Objekte zusammen, so
//! bleiben Objekt-Identitäten); Sonderfälle wie in TS: verwaiste Verweise landen auf der Wurzel, doppelte
//! Ordner-ids teilen sich den Knoten des letzten Eintrags.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

/// Ordner (`id`, `parentId`); ein leerer `parentId` gilt wie in JS als „keiner".
#[derive(Deserialize, Default, Clone, Debug)]
#[serde(default)]
pub struct Folder {
    pub id: Option<String>,
    #[serde(rename = "parentId")]
    pub parent_id: Option<String>,
}

/// Blatt (Layout, Master, Ausschnitt): nur der Ordner-Verweis zählt.
#[derive(Deserialize, Default, Clone, Debug)]
#[serde(default)]
pub struct Leaf {
    #[serde(rename = "folderId")]
    pub folder_id: Option<String>,
}

fn truthy(s: &Option<String>) -> Option<&str> {
    s.as_deref().filter(|s| !s.is_empty())
}

/// Knoten je Ordner-Index: Unterordner (Knoten-Indizes) und direkte Blätter (Blatt-Indizes).
#[derive(Serialize, Default, Clone, Debug, PartialEq)]
pub struct Node {
    pub subfolders: Vec<usize>,
    pub leaves: Vec<usize>,
}

#[derive(Serialize, Default, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Tree {
    pub root_leaves: Vec<usize>,
    pub root_folders: Vec<usize>,
    pub nodes: Vec<Node>,
}

/// Baut den Baum (`buildLayoutTree`, `buildMasterTree`, `buildViewSnapshotTree`); Eingabe-Reihenfolge je Ebene bleibt.
pub fn build(folders: &[Folder], leaves: &[Leaf]) -> Tree {
    let ids: HashSet<Option<&str>> = folders.iter().map(|f| f.id.as_deref()).collect();
    let mut by_id: HashMap<Option<&str>, usize> = HashMap::new();
    for (i, f) in folders.iter().enumerate() {
        by_id.insert(f.id.as_deref(), i); // der letzte Eintrag gewinnt (`Map.set`)
    }
    let mut t = Tree { nodes: vec![Node::default(); folders.len()], ..Default::default() };
    for f in folders {
        let node = by_id[&f.id.as_deref()];
        let parent = truthy(&f.parent_id).filter(|p| ids.contains(&Some(*p))).and_then(|p| by_id.get(&Some(p)).copied());
        match parent {
            Some(p) => t.nodes[p].subfolders.push(node),
            None => t.root_folders.push(node),
        }
    }
    for (k, l) in leaves.iter().enumerate() {
        let node = truthy(&l.folder_id).filter(|p| ids.contains(&Some(*p))).and_then(|p| by_id.get(&Some(p)).copied());
        match node {
            Some(n) => t.nodes[n].leaves.push(k),
            None => t.root_leaves.push(k),
        }
    }
    t
}

/// Alle Blätter eines Ordners in Baum-Reihenfolge: direkte zuerst, dann die der Unterordner
/// (`collectFolderLayouts`). Ein Kreis in den `parentId`-Ketten (kaputte Datei) ist hier gekappt, TS lief endlos.
pub fn collect(folders: &[Folder], leaves: &[Leaf], folder_id: &str) -> Vec<usize> {
    let t = build(folders, leaves);
    fn find(t: &Tree, folders: &[Folder], list: &[usize], id: &str, path: &mut Vec<usize>) -> Option<usize> {
        for &n in list {
            if folders[n].id.as_deref() == Some(id) {
                return Some(n);
            }
            if path.contains(&n) {
                continue;
            }
            path.push(n);
            let deep = find(t, folders, &t.nodes[n].subfolders, id, path);
            path.pop();
            if deep.is_some() {
                return deep;
            }
        }
        None
    }
    fn walk(t: &Tree, n: usize, out: &mut Vec<usize>, path: &mut Vec<usize>) {
        out.extend(&t.nodes[n].leaves);
        for &sub in &t.nodes[n].subfolders {
            if path.contains(&sub) {
                continue;
            }
            path.push(sub);
            walk(t, sub, out, path);
            path.pop();
        }
    }
    let Some(node) = find(&t, folders, &t.root_folders, folder_id, &mut Vec::new()) else { return Vec::new() };
    let mut out = Vec::new();
    walk(&t, node, &mut out, &mut vec![node]);
    out
}

/// Ist `candidate` gleich `root` oder ein Nachfahre von `root`? Robust gegen kaputte Ketten (`isDescendant`).
pub fn is_descendant(folders: &[Folder], candidate: &str, root: &str) -> bool {
    if candidate == root {
        return true;
    }
    let mut by_id: HashMap<Option<&str>, &Folder> = HashMap::new();
    for f in folders {
        by_id.insert(f.id.as_deref(), f);
    }
    let mut seen: HashSet<Option<&str>> = HashSet::new();
    let mut cur = by_id.get(&Some(candidate)).copied();
    while let Some(c) = cur {
        let Some(parent) = truthy(&c.parent_id) else { break };
        if seen.contains(&c.id.as_deref()) {
            break;
        }
        if parent == root {
            return true;
        }
        seen.insert(c.id.as_deref());
        cur = by_id.get(&Some(parent)).copied();
    }
    false
}

#[derive(Serialize, Default, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Deleted {
    /// Behaltene Ordner (Index in der Eingabe) mit Änderung von `parentId`
    /// (`null` = nicht geändert, `{"v": "id"}` = setzen, `{"v": null}` = Schlüssel entfernen).
    pub folders: Vec<(usize, Option<Change>)>,
    /// Je Blatt die Änderung von `folderId` (wie oben).
    pub leaves: Vec<Option<Change>>,
}

/// `v`: neuer Wert oder `None` = entfernen.
#[derive(Serialize, Debug, PartialEq)]
pub struct Change {
    pub v: Option<String>,
}

/// Löscht Ordner `folder_id`: alle Einträge mit dieser id fallen weg, Unterordner und Blätter rücken auf
/// den Elternordner des ersten Treffers (`deleteFolder`, `deleteMasterFolder`).
pub fn delete(folders: &[Folder], leaves: &[Leaf], folder_id: &str) -> Deleted {
    let grand = folders.iter().find(|f| f.id.as_deref() == Some(folder_id)).and_then(|t| truthy(&t.parent_id)).map(str::to_string);
    let change = |at: &Option<String>| -> Option<Change> { (at.as_deref() == Some(folder_id)).then(|| Change { v: grand.clone() }) };
    Deleted {
        folders: folders.iter().enumerate().filter(|(_, f)| f.id.as_deref() != Some(folder_id)).map(|(i, f)| (i, change(&f.parent_id))).collect(),
        leaves: leaves.iter().map(|l| change(&l.folder_id)).collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn f(id: &str, parent: Option<&str>) -> Folder {
        Folder { id: Some(id.into()), parent_id: parent.map(str::to_string) }
    }
    fn l(folder: Option<&str>) -> Leaf {
        Leaf { folder_id: folder.map(str::to_string) }
    }

    #[test]
    fn baum_mit_verwaisten_verweisen() {
        let folders = [f("a", None), f("b", Some("a")), f("c", Some("zz"))];
        let leaves = [l(Some("b")), l(None), l(Some("nix")), l(Some("a"))];
        let t = build(&folders, &leaves);
        assert_eq!(t.root_folders, vec![0, 2]);
        assert_eq!(t.root_leaves, vec![1, 2]);
        assert_eq!(t.nodes[0], Node { subfolders: vec![1], leaves: vec![3] });
        assert_eq!(t.nodes[1].leaves, vec![0]);
    }

    #[test]
    fn doppelte_ids_teilen_den_letzten_knoten() {
        let folders = [f("a", None), f("a", None)];
        let t = build(&folders, &[l(Some("a"))]);
        assert_eq!(t.root_folders, vec![1, 1]);
        assert_eq!(t.nodes[1].leaves, vec![0]);
    }

    #[test]
    fn blaetter_in_baumreihenfolge_und_kreis() {
        let folders = [f("a", None), f("b", Some("a")), f("c", Some("a"))];
        let leaves = [l(Some("c")), l(Some("a")), l(Some("b")), l(Some("a"))];
        assert_eq!(collect(&folders, &leaves, "a"), vec![1, 3, 2, 0]);
        assert_eq!(collect(&folders, &leaves, "b"), vec![2]);
        assert!(collect(&folders, &leaves, "x").is_empty());
        // Selbstverweis: kein Endlos-Lauf
        let cyc = [f("a", Some("a"))];
        assert!(collect(&cyc, &[l(Some("a"))], "a").is_empty());
    }

    #[test]
    fn nachfahren() {
        let folders = [f("a", None), f("b", Some("a")), f("c", Some("b")), f("x", Some("y")), f("y", Some("x"))];
        assert!(is_descendant(&folders, "a", "a"));
        assert!(is_descendant(&folders, "c", "a"));
        assert!(!is_descendant(&folders, "a", "c"));
        assert!(!is_descendant(&folders, "x", "a")); // Kreis bricht ab
        assert!(!is_descendant(&folders, "gibtsnicht", "a"));
    }

    #[test]
    fn loeschen_zieht_hoch() {
        let folders = [f("a", None), f("b", Some("a")), f("c", Some("b"))];
        let leaves = [l(Some("b")), l(Some("a"))];
        let d = delete(&folders, &leaves, "b");
        assert_eq!(d.folders, vec![(0, None), (2, Some(Change { v: Some("a".into()) }))]);
        assert_eq!(d.leaves, vec![Some(Change { v: Some("a".into()) }), None]);
        // Wurzel-Ordner löschen: Unterordner/Blätter auf die Wurzel
        let d = delete(&folders, &leaves, "a");
        assert_eq!(d.folders, vec![(1, Some(Change { v: None })), (2, None)]);
        assert_eq!(d.leaves, vec![None, Some(Change { v: None })]);
    }
}
