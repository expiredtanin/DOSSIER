//! Layout-Blätter ([K4] S3, vorher `src/model/layoutModel.ts`): Blattgrössen (ISO 216, freie Grösse
//! übersteuert), Seitenplanung des Ordner-PDF, aufgelöster Titelblock mit Master-Vererbung. Die Ordner-
//! Bäume stehen in `folder_tree.rs`. Rechnung auf der rohen Projekt-Wurzel (`serde_json`), Zahlen und
//! Texte wie in JS (`String(n)`, `trim`).

use crate::folder_tree::{self, Folder, Leaf};
use serde_json::{Map, Value};

/// Blattmasse je Format im Hochformat (mm): A0–A6, B0–B6.
fn page_mm(paper: &str) -> Option<(f64, f64)> {
    Some(match paper {
        "a0" => (841.0, 1189.0),
        "a1" => (594.0, 841.0),
        "a2" => (420.0, 594.0),
        "a3" => (297.0, 420.0),
        "a4" => (210.0, 297.0),
        "a5" => (148.0, 210.0),
        "a6" => (105.0, 148.0),
        "b0" => (1000.0, 1414.0),
        "b1" => (707.0, 1000.0),
        "b2" => (500.0, 707.0),
        "b3" => (353.0, 500.0),
        "b4" => (250.0, 353.0),
        "b5" => (176.0, 250.0),
        "b6" => (125.0, 176.0),
        _ => return None,
    })
}

/// Blattmasse (mm) nach Format und Ausrichtung; sind beide freien Masse gesetzt und positiv, gewinnen sie
/// (`sheetSizeMm`). `None` bei unbekanntem Format.
pub fn sheet_size(paper: &str, landscape: bool, custom_w: Option<f64>, custom_h: Option<f64>) -> Option<(f64, f64)> {
    if let (Some(w), Some(h)) = (custom_w, custom_h) {
        if w > 0.0 && h > 0.0 {
            return Some((w, h));
        }
    }
    let (w, h) = page_mm(paper)?;
    Some(if landscape { (h, w) } else { (w, h) })
}

/// Effektive Blattgrösse eines Layouts/Masters (`effectiveSheetSizeMm`).
pub fn effective_sheet_size(item: &Value) -> Option<(f64, f64)> {
    sheet_size(
        item.get("paper").and_then(Value::as_str).unwrap_or(""),
        item.get("orientation").and_then(Value::as_str) == Some("landscape"),
        item.get("customWidthMm").and_then(Value::as_f64),
        item.get("customHeightMm").and_then(Value::as_f64),
    )
}

fn list<'a>(root: &'a Map<String, Value>, key: &str) -> &'a [Value] {
    root.get(key).and_then(Value::as_array).map_or(&[], Vec::as_slice)
}

fn truthy_str(v: Option<&Value>) -> Option<&str> {
    v.and_then(Value::as_str).filter(|s| !s.is_empty())
}

/// Eine geplante Ordner-PDF-Seite: Index in `layouts` und effektive Blattgrösse (mm).
pub struct PdfPage {
    pub layout: usize,
    pub width_mm: f64,
    pub height_mm: f64,
}

/// Seiten des Ordner→Mehrseiten-PDF in Baum-Reihenfolge; ein gebundener Master erzwingt die Blattgrösse
/// (`folderPdfPages`).
pub fn folder_pdf_pages(root: &Map<String, Value>, folder_id: &str) -> Vec<PdfPage> {
    let folders: Vec<Folder> = list(root, "layoutFolders").iter().map(|v| serde_json::from_value(v.clone()).unwrap_or_default()).collect();
    let layouts = list(root, "layouts");
    let leaves: Vec<Leaf> = layouts.iter().map(|v| serde_json::from_value(v.clone()).unwrap_or_default()).collect();
    let masters = list(root, "masterLayouts");
    folder_tree::collect(&folders, &leaves, folder_id)
        .into_iter()
        .filter_map(|i| {
            let layout = &layouts[i];
            let master = truthy_str(layout.get("masterId")).and_then(|id| masters.iter().find(|m| m.get("id").and_then(Value::as_str) == Some(id)));
            let (w, h) = effective_sheet_size(master.unwrap_or(layout))?;
            Some(PdfPage { layout: i, width_mm: w, height_mm: h })
        })
        .collect()
}

/// JS-`String.prototype.trim`: Leerraum und Zeilenende nach ECMAScript (anders als `str::trim`: U+FEFF ja, U+0085 nein).
pub fn js_trim(s: &str) -> &str {
    s.trim_matches(|c: char| {
        matches!(c, '\u{9}'..='\u{d}' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
    })
}

/// `nonEmpty` des Titelblocks: getrimmter Text oder nichts.
fn non_empty(v: Option<&Value>) -> Option<String> {
    let s = v?.as_str()?;
    let t = js_trim(s);
    (!t.is_empty()).then(|| t.to_string())
}

/// Aufgelöste Titelblock-Werte (alle Felder gefüllt).
#[derive(serde::Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TitleBlock {
    pub project_name: String,
    pub sheet_name: String,
    pub scale: String,
    pub date: String,
    pub author: String,
    pub plan_number: String,
}

/// Titelblock mit Master-Vererbung (`resolveTitleBlock`): `layout` mit `id`/`name`/`planNumber` und
/// `viewports` (nur der erste zählt), `master` (`titleBlock`) oder `Null`; `today` = Vorgabe-Datum.
/// Projekt (Name, Ausschnitte, Layout-Reihenfolge) aus der Wurzel.
pub fn resolve_title_block(root: &Map<String, Value>, layout: &Value, master: &Value, today: &str) -> TitleBlock {
    let tb = master.get("titleBlock").filter(|v| v.is_object());
    let tb_get = |k: &str| tb.and_then(|t| t.get(k));
    let first_vp = layout.get("viewports").and_then(Value::as_array).and_then(|a| a.first());
    // `findSnapshot` (erster Treffer), `resolveViewportScale(vp, snap, 100)`
    let scale_n: Option<f64> = first_vp.map(|vp| {
        let snap_id = vp.get("snapshotId").and_then(Value::as_str);
        let snap = list(root, "viewSnapshots").iter().find(|s| s.get("id").and_then(Value::as_str) == snap_id && snap_id.is_some());
        vp.get("scaleDenominator")
            .filter(|v| !v.is_null())
            .or_else(|| snap.and_then(|s| s.get("scaleDenominator")).filter(|v| !v.is_null()))
            .and_then(Value::as_f64)
            .unwrap_or(100.0)
    });
    let scale_text = match scale_n {
        Some(n) if n != 0.0 && !n.is_nan() => format!("1:{}", crate::js_fmt::js_number(n)),
        _ => "—".to_string(),
    };
    // Laufende Plannummer: Position des Layouts in `project.layouts` (1-basiert, zweistellig)
    let layout_id = layout.get("id").and_then(Value::as_str);
    let idx = list(root, "layouts").iter().position(|l| l.get("id").and_then(Value::as_str) == layout_id && layout_id.is_some());
    let auto = format!("{:02}", idx.unwrap_or(0) + 1);
    let text = |v: Option<&Value>| v.and_then(Value::as_str).unwrap_or("").to_string();
    TitleBlock {
        project_name: non_empty(tb_get("projectName")).unwrap_or_else(|| text(root.get("name"))),
        sheet_name: non_empty(tb_get("sheetName")).unwrap_or_else(|| text(layout.get("name"))),
        scale: non_empty(tb_get("scale")).unwrap_or(scale_text),
        date: non_empty(tb_get("date")).unwrap_or_else(|| today.to_string()),
        author: non_empty(tb_get("author")).unwrap_or_default(),
        plan_number: non_empty(layout.get("planNumber")).unwrap_or(auto),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn obj(v: Value) -> Map<String, Value> {
        v.as_object().unwrap().clone()
    }

    #[test]
    fn blattgroessen() {
        assert_eq!(sheet_size("a3", false, None, None), Some((297.0, 420.0)));
        assert_eq!(sheet_size("a3", true, None, None), Some((420.0, 297.0)));
        assert_eq!(sheet_size("a3", true, Some(100.0), Some(50.0)), Some((100.0, 50.0)));
        assert_eq!(sheet_size("a3", true, Some(0.0), Some(50.0)), Some((420.0, 297.0)));
        assert_eq!(sheet_size("a3", true, Some(100.0), None), Some((420.0, 297.0)));
        assert_eq!(sheet_size("zz", false, None, None), None);
        assert_eq!(effective_sheet_size(&json!({"paper": "b4", "orientation": "landscape"})), Some((353.0, 250.0)));
    }

    #[test]
    fn js_trim_wie_js() {
        assert_eq!(js_trim("\u{feff} x\u{a0}"), "x");
        assert_eq!(js_trim("\u{85}x"), "\u{85}x");
    }

    #[test]
    fn titelblock_erbt_vom_master() {
        let root = obj(json!({
            "name": "Haus",
            "viewSnapshots": [{"id": "s1", "scaleDenominator": 50}],
            "layouts": [{"id": "l0"}, {"id": "l1"}],
        }));
        let layout = json!({"id": "l1", "name": "EG", "viewports": [{"snapshotId": "s1"}]});
        let master = json!({"titleBlock": {"projectName": "  Neubau ", "author": " ", "scale": ""}});
        let tb = resolve_title_block(&root, &layout, &master, "2026-10-29");
        assert_eq!(
            tb,
            TitleBlock {
                project_name: "Neubau".into(),
                sheet_name: "EG".into(),
                scale: "1:50".into(),
                date: "2026-10-29".into(),
                author: String::new(),
                plan_number: "02".into(),
            }
        );
        let none = resolve_title_block(&root, &json!({"id": "x", "name": "Y", "viewports": [], "planNumber": " A1 "}), &Value::Null, "d");
        assert_eq!((none.scale.as_str(), none.plan_number.as_str(), none.project_name.as_str()), ("—", "A1", "Haus"));
    }

    #[test]
    fn pdf_seiten_nehmen_masterformat() {
        let root = obj(json!({
            "layoutFolders": [{"id": "f"}],
            "layouts": [
                {"id": "a", "folderId": "f", "paper": "a4", "orientation": "portrait", "masterId": "m"},
                {"id": "b", "folderId": "f", "paper": "a4", "orientation": "landscape"},
                {"id": "c", "paper": "a4", "orientation": "portrait"},
            ],
            "masterLayouts": [{"id": "m", "paper": "a3", "orientation": "portrait"}],
        }));
        let pages = folder_pdf_pages(&root, "f");
        let got: Vec<(usize, f64, f64)> = pages.iter().map(|p| (p.layout, p.width_mm, p.height_mm)).collect();
        assert_eq!(got, vec![(0, 297.0, 420.0), (1, 297.0, 210.0)]);
    }
}
