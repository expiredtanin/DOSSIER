//! [66] Präsentationsplan mit einem Klick: gemeinsamen Massstab wählen und die Ansichten (Grundrisse,
//! Ansichten, Schnitt) in einem ruhigen Raster auf dem Blatt anordnen.
//!
//! Jede Gruppe (Grundrisse, Ansichten, Schnitte) bekommt gleich grosse Rahmen (grösster Inhalt der Gruppe
//! plus Rand) und füllt Zeilen von links nach rechts; jede Zeile ist waagrecht zentriert, der ganze Block
//! senkrecht, soweit Platz ist. Das Schriftfeld des Masters (unten rechts, wie `TitleBlockSvg`) bleibt frei.
//! Gewählt wird der grösste Massstab aus [`SCALES`], bei dem alles auf das Blatt passt.

use crate::model::{DetailLevel, Project, ViewSnapshot, ViewTemplate};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;

/// Massstäbe in Wahlreihenfolge (grösster zuerst).
pub const SCALES: [f64; 5] = [50.0, 100.0, 200.0, 500.0, 1000.0];
/// Rand zwischen Inhalt und Viewport-Rahmen (mm).
pub const FRAME_PAD_MM: f64 = 4.0;
/// Abstand zwischen Rahmen (mm).
pub const GAP_MM: f64 = 12.0;
/// Platz für den Titel unter jedem Rahmen (mm).
pub const TITLE_MM: f64 = 9.0;
/// Blattrand (mm, innerhalb des Master-Rahmens bei 5 mm).
pub const MARGIN_MM: f64 = 15.0;
/// Schriftfeld des Masters: Breite, Höhe, Abstand zum Blattrand (mm, wie `TitleBlockSvg`).
pub const TITLE_BLOCK_MM: [f64; 3] = [70.0, 30.0, 6.0];

/// Rahmen eines Viewports auf dem Blatt (mm, Ursprung oben links).
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Rect {
    pub x_mm: f64,
    pub y_mm: f64,
    pub width_mm: f64,
    pub height_mm: f64,
}

/// Blatt: Grösse (mm) und das freizuhaltende Schriftfeld `[x, y, w, h]`.
#[derive(Clone, Copy, Debug)]
pub struct Sheet {
    pub w: f64,
    pub h: f64,
    pub title_block: Option<[f64; 4]>,
    /// Rand links/rechts/unten (mm).
    pub margin: f64,
    /// Obere Kante der Inhaltsfläche (mm); bei Plakaten unter der Kopfzeile ([224]).
    pub top: f64,
}

impl Sheet {
    pub fn new(w: f64, h: f64, title_block: bool) -> Sheet {
        let [tw, th, pad] = TITLE_BLOCK_MM;
        Sheet { w, h, title_block: title_block.then(|| [w - tw - pad, h - th - pad, tw, th]), margin: MARGIN_MM, top: MARGIN_MM }
    }

    /// Eigene Ränder (Plakat-Vorlage): `margin` seitlich/unten, `top` oben. Unsinn (NaN, negativ, zu gross) bleibt beim Standard.
    pub fn with_area(mut self, margin: Option<f64>, top: Option<f64>) -> Sheet {
        let ok = |v: f64| v.is_finite() && v >= 0.0 && v < self.w.min(self.h) / 2.0;
        if let Some(m) = margin.filter(|v| ok(*v)) {
            self.margin = m;
        }
        if let Some(t) = top.filter(|v| ok(*v)) {
            self.top = t;
        }
        self
    }
}

/// Zeilen ab `y0` füllen; `strict`: `None`, wenn eine Zeile oder der Block nicht aufs Blatt passt.
fn pack_from(items: &[(u32, f64, f64)], sheet: &Sheet, y0: f64, strict: bool) -> Option<(Vec<Rect>, f64)> {
    let (l, r, b) = (sheet.margin, sheet.w - sheet.margin, sheet.h - sheet.margin);
    let mut out = vec![Rect::default(); items.len()];
    let mut y = y0;
    let mut i = 0;
    while i < items.len() {
        let g = items[i].0;
        let j = i + items[i..].iter().take_while(|it| it.0 == g).count();
        let cw = items[i..j].iter().fold(0.0_f64, |m, it| m.max(it.1)) + 2.0 * FRAME_PAD_MM;
        let ch = items[i..j].iter().fold(0.0_f64, |m, it| m.max(it.2)) + 2.0 * FRAME_PAD_MM;
        let mut k = i;
        while k < j {
            let row_bottom = y + ch + TITLE_MM;
            let right = match sheet.title_block {
                Some([tx, ty, _, th]) if row_bottom > ty - GAP_MM && y < ty + th => tx - GAP_MM,
                _ => r,
            };
            let fit = ((right - l + GAP_MM) / (cw + GAP_MM)).floor();
            let n = if fit.is_finite() && fit >= 1.0 { fit as usize } else if strict { return None } else { 1 };
            let cnt = n.min(j - k);
            let row_w = cnt as f64 * cw + (cnt as f64 - 1.0) * GAP_MM;
            let x0 = l + ((right - l - row_w) / 2.0).max(0.0);
            for c in 0..cnt {
                out[k + c] = Rect { x_mm: x0 + c as f64 * (cw + GAP_MM), y_mm: y, width_mm: cw, height_mm: ch };
            }
            k += cnt;
            y = row_bottom + GAP_MM;
        }
        i = j;
    }
    let bottom = y - GAP_MM;
    if strict && bottom > b + 1e-9 {
        return None;
    }
    Some((out, bottom))
}

/// Rahmen für Inhalte `(Gruppe, Breite, Höhe)` (Papier-mm, Gruppen aufsteigend sortiert) in Eingabe-
/// reihenfolge; `None`, wenn sie nicht aufs Blatt passen. Der Block wird senkrecht zentriert, wenn das
/// die Zeilen nicht verändert.
pub fn pack(items: &[(u32, f64, f64)], sheet: &Sheet) -> Option<Vec<Rect>> {
    let (top, b) = (sheet.top, sheet.h - sheet.margin);
    let (first, bottom) = pack_from(items, sheet, top, true)?;
    let off = (b - bottom) / 2.0;
    if off > 0.0 {
        if let Some((centered, _)) = pack_from(items, sheet, top + off, true) {
            return Some(centered);
        }
    }
    Some(first)
}

/// Ergebnis der Wahl: Massstab, ob alles passt, Rahmen je Inhalt.
#[derive(Debug, Clone, PartialEq)]
pub struct Choice {
    pub scale: f64,
    pub fits: bool,
    pub rects: Vec<Rect>,
}

/// Grösster Massstab aus [`SCALES`], bei dem alles passt (`sizes_at(scale)` = Inhalte beim Massstab);
/// passt nichts, der kleinste Massstab mit überlaufenden Zeilen (`fits = false`).
pub fn choose(mut sizes_at: impl FnMut(f64) -> Vec<(u32, f64, f64)>, sheet: &Sheet) -> Choice {
    for s in SCALES {
        if let Some(rects) = pack(&sizes_at(s), sheet) {
            return Choice { scale: s, fits: true, rects };
        }
    }
    let s = SCALES[SCALES.len() - 1];
    let rects = pack_from(&sizes_at(s), sheet, sheet.top, false).map(|r| r.0).unwrap_or_default();
    Choice { scale: s, fits: false, rects }
}

/// Fester Massstab `s` ([224]): passt es, `fits = true`, sonst überlaufende Zeilen (`fits = false`).
pub fn choose_fixed(mut sizes_at: impl FnMut(f64) -> Vec<(u32, f64, f64)>, sheet: &Sheet, s: f64) -> Choice {
    let sizes = sizes_at(s);
    if let Some(rects) = pack(&sizes, sheet) {
        return Choice { scale: s, fits: true, rects };
    }
    let rects = pack_from(&sizes, sheet, sheet.top, false).map(|r| r.0).unwrap_or_default();
    Choice { scale: s, fits: false, rects }
}

/// Anfrage der Abfrage `presentationSheet`.
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Request {
    /// Ebenen (Geschosse, Ansichten, Schnitte) in Blattreihenfolge.
    pub levels: Vec<String>,
    /// Gruppe je Ebene (0 Grundrisse, 1 Ansichten, 2 Schnitte), aufsteigend.
    pub groups: Vec<u32>,
    pub layer_visibility: BTreeMap<String, bool>,
    pub detail: DetailLevel,
    pub sheet_w: f64,
    pub sheet_h: f64,
    pub title_block: bool,
    /// Schatten der Ansichten (Vorlage „Präsentation").
    pub shadows: bool,
    /// [224] Fester gemeinsamer Massstab (1:N); fehlt er, wählt der Kern den grössten, der passt.
    pub scale: Option<f64>,
    /// [224] Massstab je Ebene (übersteuert den gemeinsamen).
    pub scales: BTreeMap<String, f64>,
    /// [224] Eigener Rand/obere Kante (Plakat-Vorlage, unter der Kopfzeile).
    pub margin_mm: Option<f64>,
    pub top_mm: Option<f64>,
    /// Ansichtsvorlage, mit der die Viewports verknüpft werden: die Ausmasse müssen mit ihr gerechnet werden (sie setzt z. B.
    /// Schatten), sonst sitzt der Inhalt neben dem Rahmen und wird beschnitten. Fehlt sie im Projekt, wird sie eingesetzt.
    pub template: Option<ViewTemplate>,
}

/// Abfrage `presentationSheet`: Massstab und Rahmen für die Ebenen; Ebenen ohne Inhalt stehen unter
/// `skipped`.
pub fn query(p: &Project, text: &str) -> Result<Value, String> {
    let req: Request = serde_json::from_str(text).map_err(|e| format!("presentationSheet: {e}"))?;
    if !(req.sheet_w > 0.0 && req.sheet_h > 0.0 && req.sheet_w.is_finite() && req.sheet_h.is_finite()) {
        return Err("presentationSheet: Blattgrösse ungültig".into());
    }
    let snap = |level: &str| ViewSnapshot {
        active_level_id: level.to_string(),
        layer_visibility: req.layer_visibility.clone(),
        detail: req.detail,
        scale_denominator: 100.0,
        template_id: req.template.as_ref().map(|t| t.id.clone()),
        template_linked: req.template.as_ref().map(|_| true),
        ..Default::default()
    };
    let with_tpl;
    let p = match &req.template {
        Some(t) if !p.view_templates.iter().flatten().any(|v| v.id == t.id) => {
            let mut q = p.clone();
            q.view_templates.get_or_insert_with(Vec::new).push(t.clone());
            with_tpl = q;
            &with_tpl
        }
        _ => p,
    };
    let bounds_at = |level: &str, s: f64| crate::sheet_viewports::snapshot_bounds(p, &snap(level), s, Some(req.shadows));
    // Ebenen ohne Inhalt fallen weg (geprüft beim mittleren Massstab).
    let mut kept: Vec<(String, u32)> = Vec::new();
    let mut skipped: Vec<String> = Vec::new();
    for (i, id) in req.levels.iter().enumerate() {
        let ok = p.drawing_levels.iter().any(|l| &l.id == id) && bounds_at(id, 100.0).is_some_and(|b| b.iter().all(|v| v.is_finite()) && b[2] > b[0] && b[3] > b[1]);
        if ok {
            kept.push((id.clone(), req.groups.get(i).copied().unwrap_or(0)));
        } else {
            skipped.push(id.clone());
        }
    }
    kept.sort_by_key(|k| k.1);
    let sheet = Sheet::new(req.sheet_w, req.sheet_h, req.title_block).with_area(req.margin_mm, req.top_mm);
    let valid = |v: f64| v.is_finite() && v > 0.0;
    let own = |id: &str| req.scales.get(id).copied().filter(|v| valid(*v));
    let sizes_at = |s: f64| -> Vec<(u32, f64, f64)> {
        kept.iter()
            .map(|(id, g)| {
                let sc = own(id).unwrap_or(s);
                let b = bounds_at(id, sc).unwrap_or([0.0, 0.0, 1.0, 1.0]);
                (*g, (b[2] - b[0]) * 1000.0 / sc, (b[3] - b[1]) * 1000.0 / sc)
            })
            .collect()
    };
    let all_own = !kept.is_empty() && kept.iter().all(|(id, _)| own(id).is_some());
    let choice = match req.scale.filter(|v| valid(*v)) {
        Some(s) => choose_fixed(sizes_at, &sheet, s),
        None if all_own => choose_fixed(sizes_at, &sheet, 100.0),
        None => choose(sizes_at, &sheet),
    };
    let items: Vec<Value> = kept
        .iter()
        .zip(&choice.rects)
        .map(|((id, g), r)| json!({"levelId": id, "group": g, "scale": own(id).unwrap_or(choice.scale), "xMm": r.x_mm, "yMm": r.y_mm, "widthMm": r.width_mm, "heightMm": r.height_mm}))
        .collect();
    Ok(json!({"scale": choice.scale, "fits": choice.fits, "items": items, "skipped": skipped}))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn inside(r: &Rect, s: &Sheet) -> bool {
        r.x_mm >= MARGIN_MM - 1e-9
            && r.y_mm >= MARGIN_MM - 1e-9
            && r.x_mm + r.width_mm <= s.w - MARGIN_MM + 1e-9
            && r.y_mm + r.height_mm + TITLE_MM <= s.h - MARGIN_MM + 1e-9
    }
    fn overlap(a: &Rect, b: &Rect) -> bool {
        a.x_mm < b.x_mm + b.width_mm && b.x_mm < a.x_mm + a.width_mm && a.y_mm < b.y_mm + b.height_mm + TITLE_MM && b.y_mm < a.y_mm + a.height_mm + TITLE_MM
    }
    fn check(rects: &[Rect], s: &Sheet) {
        for (i, a) in rects.iter().enumerate() {
            assert!(inside(a, s), "{a:?} ausserhalb");
            if let Some([tx, ty, tw, th]) = s.title_block {
                let tb = Rect { x_mm: tx, y_mm: ty, width_mm: tw, height_mm: th - TITLE_MM };
                assert!(!overlap(a, &tb), "{a:?} über dem Schriftfeld");
            }
            for b in &rects[i + 1..] {
                assert!(!overlap(a, b), "{a:?} überlappt {b:?}");
            }
        }
    }

    /// Haus 12 × 10 m (4 Geschosse), Ansichten 12 × 9 m: A1 quer (841 × 594): 1:50 passt nicht,
    /// 1:100 schon.
    #[test]
    fn a1_waehlt_1_100_und_alles_liegt_auf_dem_blatt() {
        let s = Sheet::new(841.0, 594.0, true);
        let sizes = |sc: f64| {
            let mut v: Vec<(u32, f64, f64)> = (0..4).map(|_| (0, 12000.0 / sc, 10000.0 / sc)).collect();
            v.extend((0..4).map(|_| (1, 12000.0 / sc, 9000.0 / sc)));
            v.push((2, 12000.0 / sc, 9000.0 / sc));
            v
        };
        let c = choose(sizes, &s);
        assert!(c.fits);
        assert_eq!(c.scale, 100.0);
        assert_eq!(c.rects.len(), 9);
        check(&c.rects, &s);
        // Gleiche Rahmen je Gruppe, Grundrisse oben.
        assert!(c.rects[..4].iter().all(|r| r.width_mm == c.rects[0].width_mm && r.height_mm == c.rects[0].height_mm));
        assert!(c.rects[4].y_mm > c.rects[0].y_mm);
    }

    /// Grosser Bau auf A3: 1:100 passt nicht, 1:200 auch nicht, 1:500 schon.
    #[test]
    fn kleines_blatt_waehlt_kleineren_massstab() {
        let s = Sheet::new(420.0, 297.0, true);
        let c = choose(|sc| (0..3).map(|g| (g, 60000.0 / sc, 30000.0 / sc)).collect(), &s);
        assert!(c.fits);
        assert_eq!(c.scale, 500.0);
        check(&c.rects, &s);
    }

    #[test]
    fn passt_nichts_dann_kleinster_massstab_ohne_passt() {
        let s = Sheet::new(210.0, 297.0, false);
        let c = choose(|sc| vec![(0, 900_000.0 / sc, 900_000.0 / sc)], &s);
        assert!(!c.fits);
        assert_eq!(c.scale, 1000.0);
        assert_eq!(c.rects.len(), 1);
    }

    #[test]
    fn schriftfeld_bleibt_frei_und_leere_liste() {
        let s = Sheet::new(594.0, 420.0, true);
        let items: Vec<(u32, f64, f64)> = (0..12).map(|i| (i / 6, 70.0, 50.0)).collect();
        let r = pack(&items, &s).expect("passt");
        check(&r, &s);
        assert_eq!(pack(&[], &s), Some(vec![]));
    }

    /// [224] Fester Massstab 1:200 (Wettbewerb) wird eingehalten, passt es; sonst `fits = false`. Plakat-Rand und
    /// obere Kante begrenzen die Fläche.
    #[test]
    fn fester_massstab_und_plakatflaeche() {
        let s = Sheet::new(841.0, 594.0, false);
        let sizes = |sc: f64| (0..3).map(|_| (0, 12000.0 / sc, 10000.0 / sc)).collect::<Vec<_>>();
        let c = choose_fixed(sizes, &s, 200.0);
        assert!(c.fits && c.scale == 200.0 && c.rects.len() == 3);
        let tiny = choose_fixed(sizes, &s, 10.0);
        assert!(!tiny.fits && tiny.scale == 10.0);
        let poster = Sheet::new(841.0, 594.0, false).with_area(Some(20.0), Some(78.0));
        let r = pack(&sizes(200.0), &poster).expect("passt");
        assert!(r.iter().all(|f| f.y_mm >= 78.0 - 1e-9 && f.x_mm >= 20.0 - 1e-9 && f.x_mm + f.width_mm <= 841.0 - 20.0 + 1e-9));
        // Unsinn bleibt beim Standard.
        let bad = Sheet::new(841.0, 594.0, false).with_area(Some(f64::NAN), Some(-3.0));
        assert_eq!((bad.margin, bad.top), (MARGIN_MM, MARGIN_MM));
    }

    #[test]
    fn unsinn_wird_abgelehnt() {
        let p = Project::default();
        assert!(query(&p, "kein json").is_err());
        assert!(query(&p, r#"{"sheetW": -1, "sheetH": 5}"#).is_err());
        let v = query(&p, r#"{"levels": ["fehlt"], "groups": [0], "sheetW": 841, "sheetH": 594}"#).unwrap();
        assert_eq!(v["skipped"][0], "fehlt");
        assert_eq!(v["items"].as_array().map(|a| a.len()), Some(0));
    }
}
