//! Einfügen der Element-Zwischenablage im Kern ([K4] S3, vorher `pasteElementClipboard` in
//! `editors/elementClipboard.ts`). Die Zwischenablage selbst (tief kopierte Elemente je Bauteil-Art)
//! hält die TS-Hülle; die Anfrage trägt sie mit (`{cmd: "paste", clip, levelId, stamp}`).
//!
//! Einfügen = Klone mit neuen ids (`prefix-stamp-k`, [`IdGen`]) auf dem aktiven Geschoss, an
//! denselben Modell-Koordinaten (kein Versatz, wie das bisherige Verhalten). Verweise: eine Öffnung
//! hängt an ihrer Wirtswand (`hostWallId`) bzw. ihrem Dach/ihrer Decke (`hostRoofId`/`hostCeilingId`,
//! [134]) und wird auf die Kopie des Wirts umgehängt; ohne mitkopierten Wirt fällt sie weg (keine
//! Öffnung ohne Wirt). Gruppen-Mitgliedschaften werden nicht
//! mitkopiert (die Klone sind neue, ungruppierte Elemente).
//!
//! Rechnung auf rohem JSON (`{...e, id, floorId}`: vorhandene Schlüssel behalten ihre Stelle,
//! fehlende kommen ans Ende, unbekannte Felder bleiben).

use crate::cmd_transform::IdGen;
use crate::json_util::{arr, as_copy, field, with_all};
use crate::ops::{id_of, Op};
use serde_json::Value;
use std::collections::HashMap;

/// Listen der Zwischenablage: (Schlüssel in `clip`, Projekt-Liste, id-Präfix, Geschoss-Feld).
/// Reihenfolge = Reihenfolge der ids und der Ops (Wände vor Öffnungen).
const LISTS: [(&str, &str, &str, &str); 10] = [
    ("walls", "walls", "W", "floorId"),
    ("drawings", "drawings2d", "dr2d", "levelId"),
    ("ceilings", "ceilings", "C", "floorId"),
    ("roofs", "roofs", "RF", "floorId"),
    ("openings", "openings", "O", ""),
    ("stairs", "stairs", "ST", "floorId"),
    ("rooms", "rooms", "RM", "floorId"),
    ("extrudedSolids", "extrudedSolids", "extrude", "levelId"),
    ("columns", "columns", "column", "floorId"),
    ("trees", "trees", "tree", "floorId"),
];

/// Ops des Einfügens: je Liste ein `add` (leere Listen ohne Op).
pub fn paste_ops(clip: &Value, level_id: &str, stamp: &str) -> Vec<Op> {
    let mut ids = IdGen::new(stamp);
    // Alte → neue ids der Wirte (Wände, Decken, Dächer; ids sind projektweit eindeutig).
    let mut host_ids: HashMap<String, String> = HashMap::new();
    let level = Value::String(level_id.to_owned());
    let mut ops = Vec::new();
    for (key, collection, prefix, level_field) in LISTS {
        let mut items = Vec::new();
        for e in arr(field(clip, key)) {
            if level_field.is_empty() {
                // Öffnung: nur mit mitkopiertem Wirt (Wand, Dach oder Decke), umgehängt.
                let host = ["hostWallId", "hostRoofId", "hostCeilingId"].into_iter().find_map(|k| {
                    let h = field(e, k).and_then(Value::as_str).filter(|h| !h.is_empty())?;
                    Some((k, host_ids.get(h)?))
                });
                let Some((key, host)) = host else { continue };
                let host = Value::String(host.clone());
                items.push(with_all(&as_copy(e), vec![("id", Value::String(ids.next(prefix))), (key, host)]));
                continue;
            }
            let id = ids.next(prefix);
            if matches!(key, "walls" | "ceilings" | "roofs") {
                if let Some(old) = id_of(e) {
                    host_ids.insert(old.to_owned(), id.clone());
                }
            }
            items.push(with_all(&as_copy(e), vec![("id", Value::String(id)), (level_field, level.clone())]));
        }
        if !items.is_empty() {
            ops.push(Op::Add { collection: collection.into(), items, at: None });
        }
    }
    ops
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// [201] Eine Kopie bekommt eine neue id und NICHT die IFC-GlobalId des Originals.
    #[test]
    fn kopie_traegt_keine_ifc_global_id() {
        let clip = json!({
            "walls": [{"id": "w1", "floorId": "eg", "ifcGlobalId": "0AbcDEFghijKLMNOPQRSt1"}],
            "openings": [{"id": "o1", "hostWallId": "w1", "ifcGlobalId": "1AbcDEFghijKLMNOPQRSt2"}],
            "columns": [{"id": "c1", "floorId": "eg", "ifcGlobalId": "2AbcDEFghijKLMNOPQRSt3"}]
        });
        for op in paste_ops(&clip, "og", "s") {
            for item in op.to_json()["items"].as_array().unwrap() {
                assert!(item.get("ifcGlobalId").is_none(), "{item}");
            }
        }
    }

    #[test]
    fn klone_mit_neuen_ids_auf_dem_aktiven_geschoss_oeffnung_umgehaengt() {
        let clip = json!({
            "walls": [
                {"id": "w1", "type": "wall", "floorId": "eg", "start": {"x": 0, "y": 0}, "end": {"x": 5, "y": 0}, "extra": 1},
                {"id": "w2", "type": "wall", "start": {"x": 0, "y": 1}, "end": {"x": 5, "y": 1}}
            ],
            "drawings": [{"id": "d1", "levelId": "eg", "geom": {"shape": "line"}}],
            "openings": [
                {"id": "o1", "hostWallId": "w1", "position": 1.5},
                {"id": "o2", "hostWallId": "w9"}
            ],
            "columns": [{"id": "c1", "floorId": "eg"}],
            "rooms": []
        });
        let ops: Vec<Value> = paste_ops(&clip, "og", "s").iter().map(Op::to_json).collect();
        assert_eq!(ops.len(), 4);
        assert_eq!(ops[0]["collection"], "walls");
        let walls = ops[0]["items"].as_array().unwrap();
        assert_eq!(walls[0], json!({"id": "W-s-1", "type": "wall", "floorId": "og", "start": {"x": 0, "y": 0}, "end": {"x": 5, "y": 0}, "extra": 1}));
        // Fehlendes Geschoss-Feld kommt ans Ende (wie `{...w, id, floorId}`).
        assert_eq!(walls[1].as_object().unwrap().keys().collect::<Vec<_>>(), ["id", "type", "start", "end", "floorId"]);
        assert_eq!(ops[1]["collection"], "drawings2d");
        assert_eq!(ops[1]["items"][0]["id"], "dr2d-s-3");
        assert_eq!(ops[1]["items"][0]["levelId"], "og");
        // Öffnung o1 an die neue Wand, o2 (Wirtswand nicht kopiert) fällt weg.
        assert_eq!(ops[2]["collection"], "openings");
        assert_eq!(ops[2]["items"], json!([{"id": "O-s-4", "hostWallId": "W-s-1", "position": 1.5}]));
        assert_eq!(ops[3]["collection"], "columns");
        assert_eq!(ops[3]["items"][0], json!({"id": "column-s-5", "floorId": "og"}));
    }

    /// [134] Wand mit Tür und Fenster, Dach mit Dachfenster: alle Öffnungen an den neuen Wirten.
    #[test]
    fn oeffnungen_folgen_kopiertem_wirt() {
        let clip = json!({
            "walls": [{"id": "w", "start": {"x": 0, "y": 0}, "end": {"x": 5, "y": 0}}],
            "roofs": [{"id": "r", "outline": []}],
            "openings": [
                {"id": "d", "hostWallId": "w", "kind": "door", "position": 1},
                {"id": "f", "hostWallId": "w", "kind": "window", "position": 3},
                {"id": "o", "hostWallId": "", "hostRoofId": "r", "hostPoint": {"x": 1, "y": 1}},
                {"id": "c", "hostWallId": "", "hostCeilingId": "c9"}
            ]
        });
        let ops: Vec<Value> = paste_ops(&clip, "eg", "s").iter().map(Op::to_json).collect();
        let os = ops.iter().find(|o| o["collection"] == "openings").unwrap()["items"].as_array().unwrap().clone();
        assert_eq!(os.len(), 3, "Deckenöffnung ohne kopierte Decke fällt weg");
        assert_eq!((&os[0]["hostWallId"], &os[1]["hostWallId"]), (&json!("W-s-1"), &json!("W-s-1")));
        assert_eq!((&os[0]["position"], &os[1]["position"]), (&json!(1), &json!(3)));
        assert_eq!((&os[2]["hostRoofId"], &os[2]["hostWallId"]), (&json!("RF-s-2"), &json!("")));
    }

    #[test]
    fn leere_oder_kaputte_zwischenablage_ergibt_nichts() {
        assert!(paste_ops(&json!({}), "og", "s").is_empty());
        assert!(paste_ops(&json!(null), "og", "s").is_empty());
        assert!(paste_ops(&json!({"walls": 3, "openings": [{"id": "o"}]}), "og", "s").is_empty());
    }
}
