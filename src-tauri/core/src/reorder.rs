//! Z-Anordnen von Listen mit `id` ([K4] S3, vorher `reorderDrawings2D`/`reorderDrawingLevelsArr` in
//! `state/projectSlice.ts`, dort doppelt): „front"/„back" stellen die gewählten Elemente ans Ende bzw.
//! den Anfang (Reihenfolge unter ihnen bleibt), „forward"/„backward" rücken jedes gewählte Element um
//! genau eine Stelle vor bzw. zurück (Iterationsrichtung verhindert, dass gewählte Nachbarn sich überholen;
//! kein Umlauf an den Listengrenzen).

use std::collections::HashSet;

/// Neue Reihenfolge als Indizes der Eingabeliste; `None` = nichts zu tun (keine der gewählten ids kommt vor).
/// Doppelte ids in der Liste gelten alle als gewählt.
pub fn reorder(list_ids: &[Option<String>], selected: &[String], op: &str) -> Option<Vec<usize>> {
    let chosen: HashSet<&str> = selected.iter().map(String::as_str).collect();
    let flag: Vec<bool> = list_ids.iter().map(|id| id.as_deref().is_some_and(|i| chosen.contains(i))).collect();
    if !flag.iter().any(|f| *f) {
        return None;
    }
    let n = list_ids.len();
    let picked = || (0..n).filter(|i| flag[*i]);
    let rest = || (0..n).filter(|i| !flag[*i]);
    Some(match op {
        "front" => rest().chain(picked()).collect(),
        "back" => picked().chain(rest()).collect(),
        "forward" => {
            let mut arr: Vec<usize> = (0..n).collect();
            for i in (0..n.saturating_sub(1)).rev() {
                if flag[arr[i]] && !flag[arr[i + 1]] {
                    arr.swap(i, i + 1);
                }
            }
            arr
        }
        _ => {
            let mut arr: Vec<usize> = (0..n).collect();
            for i in 1..n {
                if flag[arr[i]] && !flag[arr[i - 1]] {
                    arr.swap(i, i - 1);
                }
            }
            arr
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(s: &str) -> Vec<Option<String>> {
        s.chars().map(|c| Some(c.to_string())).collect()
    }
    fn sel(s: &str) -> Vec<String> {
        s.chars().map(|c| c.to_string()).collect()
    }
    fn apply(list: &str, order: Option<Vec<usize>>) -> String {
        let c: Vec<char> = list.chars().collect();
        order.map_or(list.to_string(), |o| o.into_iter().map(|i| c[i]).collect())
    }

    #[test]
    fn vier_arten() {
        assert_eq!(apply("ABCD", reorder(&ids("ABCD"), &sel("BC"), "front")), "ADBC");
        assert_eq!(apply("ABCD", reorder(&ids("ABCD"), &sel("BC"), "back")), "BCAD");
        assert_eq!(apply("ABCD", reorder(&ids("ABCD"), &sel("BC"), "forward")), "ADBC");
        assert_eq!(apply("ABCD", reorder(&ids("ABCD"), &sel("BC"), "backward")), "BCAD");
        assert_eq!(apply("ABCD", reorder(&ids("ABCD"), &sel("B"), "forward")), "ACBD");
        // Grenzen: kein Umlauf
        assert_eq!(apply("ABCD", reorder(&ids("ABCD"), &sel("D"), "forward")), "ABCD");
        assert_eq!(apply("ABCD", reorder(&ids("ABCD"), &sel("A"), "backward")), "ABCD");
        // unbekannte ids: nichts zu tun
        assert!(reorder(&ids("ABCD"), &sel("XY"), "front").is_none());
        assert!(reorder(&[], &sel("A"), "back").is_none());
    }
}
