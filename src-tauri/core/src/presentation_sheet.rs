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
    /// [266] Die Grundrisse zeigen Schnitt- und Ansichtsmarken: der Plakat-Ausschnitt um das Haus wird um ihren Abstand grösser.
    pub marks: bool,
    /// [208] Plakat-Anordnung auf dem Spaltenraster (Situation, Tabellen, 3D-Bild-Platzhalter, mehrere Blätter).
    pub poster: Option<PosterReq>,
}

/// [208] Plakat-Raster und zusätzliche Inhalte.
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct PosterReq {
    pub columns: usize,
    pub gutter_mm: f64,
    /// Platz unter jedem Rahmen für Titel und Massstab (mm).
    pub band_mm: f64,
    pub situation: Option<SituationReq>,
    pub tables: Vec<TableReq>,
    /// Platzhalter (oder vorhandenes Bild) fürs 3D-Bild: nimmt das grösste freie Rechteck.
    pub image: bool,
}

/// Situationsplan: Grundriss der Ebene mit der Vorlage „Situation WBW“, eigener Massstab (1:500).
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct SituationReq {
    pub level_id: String,
    pub scale: f64,
    pub layer_visibility: BTreeMap<String, bool>,
    pub detail: DetailLevel,
    pub template: Option<ViewTemplate>,
}

/// Blatt-Tabelle auf dem Plakat (Kennzahlen, Baurecht-Nachweis).
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct TableReq {
    pub id: String,
    pub source: crate::model::LayoutTableSource,
    pub columns: Option<Vec<String>>,
    pub font_pt: f64,
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
    let extents_at = |level: &str, s: f64| crate::sheet_viewports::snapshot_extents(p, &snap(level), s, Some(req.shadows));
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
    if let Some(po) = &req.poster {
        return Ok(poster_plan(p, &req, po, &sheet, &kept, &skipped, &extents_at));
    }
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

/// Gruppe der Situation (nach den Schnitten).
const SITUATION_GROUP: u32 = 3;
/// Mindesthöhe des 3D-Bild-Platzhalters relativ zur Satzspiegelhöhe.
const MIN_IMAGE_SHARE: f64 = 0.14;

/// Höhe (mm, ohne Titelband) jeder Tabelle: eine Probe-Ebene mit den Tabellen im Projekt, gerechnet vom Tabellenkern.
fn table_heights(p: &Project, tables: &[TableReq]) -> Vec<f64> {
    use crate::model::{Layout, LayoutTable};
    let lts: Vec<LayoutTable> = tables
        .iter()
        .enumerate()
        .map(|(i, t)| LayoutTable {
            id: format!("probe{i}"),
            source: t.source,
            width_mm: 100.0,
            columns: t.columns.clone(),
            font_size_pt: (t.font_pt.is_finite() && t.font_pt > 0.0).then_some(t.font_pt),
            ..Default::default()
        })
        .collect();
    let mut q = p.clone();
    q.layouts = Some(vec![Layout { id: "probe".into(), tables: Some(lts), ..Default::default() }]);
    let lay = &q.layouts.as_ref().map(|l| l[0].clone()).unwrap_or_default();
    let out = crate::sheet_table::render(&q, lay, &crate::sheet_table::Labels::default());
    tables.iter().enumerate().map(|(i, _)| out.iter().find(|o| o.id == format!("probe{i}")).map_or(0.0, |o| o.height_mm)).collect()
}

/// [208] Rand um die Bauteile eines Grundrisses (Papier-mm), in dem Bemassung und Beschriftung liegen; was weiter aussen
/// liegt (Umgebung, Gelände, Wege), beschneidet der Rahmen.
pub const PLAN_MARGIN_MM: f64 = 20.0;
/// [266] Rand um die Linien der Schnitte/Ansichten für ihre Marken (Papier-mm): Schenkel, Pfeil und Name.
pub const MARKS_MARGIN_MM: f64 = 12.0;
/// [266] So weit (Papier-mm) darf der Ausschnitt eines Grundrisses wegen der Marken höchstens über die Bauteile hinauswachsen.
pub const MARKS_REACH_MM: f64 = 40.0;
/// [208] Rand um das Haus im Situationsplan (Papier-mm; 1:500 ⇒ 40 m Umgebung).
pub const SITUATION_MARGIN_MM: f64 = 80.0;

/// [208] Ausschnitt eines Inhalts (Modell-Meter): das Ausmass `b`, beschnitten auf die Bauteile `house` ± `margin`;
/// ohne Bauteile (Schnitt/Ansicht) das ganze Ausmass.
pub fn crop(b: [f64; 4], house: Option<[f64; 4]>, margin: f64) -> [f64; 4] {
    let Some(h) = house.filter(|h| h.iter().all(|v| v.is_finite()) && margin.is_finite() && margin >= 0.0) else { return b };
    let c = [b[0].max(h[0] - margin), b[1].max(h[1] - margin), b[2].min(h[2] + margin), b[3].min(h[3] + margin)];
    if c[2] > c[0] && c[3] > c[1] {
        c
    } else {
        b
    }
}

fn union(a: Option<[f64; 4]>, b: [f64; 4]) -> [f64; 4] {
    match a {
        Some(a) => [a[0].min(b[0]), a[1].min(b[1]), a[2].max(b[2]), a[3].max(b[3])],
        None => b,
    }
}

/// Rahmen eines Inhalts: Breite/Höhe (Papier-mm, ohne Rand) und Bildmitte (Modell-Meter).
#[derive(Clone, Copy, Debug)]
struct Frame {
    w: f64,
    h: f64,
    cx: f64,
    cy: f64,
}

impl Frame {
    fn of(r: [f64; 4], scale: f64) -> Frame {
        Frame { w: (r[2] - r[0]) * 1000.0 / scale, h: (r[3] - r[1]) * 1000.0 / scale, cx: (r[0] + r[2]) / 2.0, cy: (r[1] + r[3]) / 2.0 }
    }
}

/// [208] Rahmen je Ebene: Grundrisse (Gruppe 0) alle gleich gross mit gemeinsamer Bildmitte (deckungsgleich), Schnitte und
/// Ansichten (Gruppen 1, 2) gleich hoch mit gemeinsamer Höhenmitte (±0.00 auf einer Linie), je eigene Breite.
fn view_frames(kept: &[(String, u32)], scale_of: &dyn Fn(&str) -> f64, extents_at: &dyn Fn(&str, f64) -> Option<([f64; 4], Option<[f64; 4]>)>, marks: Option<[f64; 4]>) -> Vec<Frame> {
    let crops: Vec<[f64; 4]> = kept
        .iter()
        .map(|(id, grp)| {
            let sc = scale_of(id);
            let (b, house) = extents_at(id, sc).unwrap_or(([0.0, 0.0, 1.0, 1.0], None));
            let c = crop(b, house, PLAN_MARGIN_MM * sc / 1000.0);
            // [266] Grundrisse mit Marken: der Ausschnitt reicht bis zu den Linien der Schnitte/Ansichten samt Marke (begrenzt).
            match (*grp, marks) {
                (0, Some(m)) => {
                    let k = sc / 1000.0;
                    let reach = crop(b, house, MARKS_REACH_MM * k);
                    let w = [(m[0] - MARKS_MARGIN_MM * k).max(reach[0]), (m[1] - MARKS_MARGIN_MM * k).max(reach[1]), (m[2] + MARKS_MARGIN_MM * k).min(reach[2]), (m[3] + MARKS_MARGIN_MM * k).min(reach[3])];
                    if w[2] > w[0] && w[3] > w[1] { union(Some(c), w) } else { c }
                }
                _ => c,
            }
        })
        .collect();
    let mut plans: Option<[f64; 4]> = None;
    let mut heights: Option<[f64; 4]> = None;
    for ((_, grp), c) in kept.iter().zip(&crops) {
        if *grp == 0 {
            plans = Some(union(plans, *c));
        } else {
            heights = Some(union(heights, *c));
        }
    }
    kept.iter()
        .zip(&crops)
        .map(|((id, grp), c)| {
            let sc = scale_of(id);
            match (*grp, plans, heights) {
                (0, Some(u), _) => Frame::of(u, sc),
                (_, _, Some(u)) if *grp > 0 => Frame::of([c[0], u[1], c[2], u[3]], sc),
                _ => Frame::of(*c, sc),
            }
        })
        .collect()
}

/// [266] Ausmass der Linien (samt Knickpunkten) der gewählten Schnitte und Ansichten im Modell (Meter): dort stehen ihre Marken.
fn marks_box(p: &Project, kept: &[(String, u32)]) -> Option<[f64; 4]> {
    let mut b: Option<[f64; 4]> = None;
    for l in p.drawing_levels.iter().filter(|l| kept.iter().any(|(id, g)| *g > 0 && *id == l.id)) {
        let Some([a, c]) = l.line_points else { continue };
        for q in [a, c].into_iter().chain(l.bend_points.iter().flatten().copied()) {
            if q.x.is_finite() && q.y.is_finite() {
                b = Some(union(b, [q.x, q.y, q.x, q.y]));
            }
        }
    }
    b
}

/// [208] Plakat: Inhalte in strengen Zeilen auf dem Spaltenraster, Massstäbe fest; mehr Inhalt als ein Blatt ⇒ weitere Blätter.
fn poster_plan(p: &Project, req: &Request, po: &PosterReq, sheet: &Sheet, kept: &[(String, u32)], skipped: &[String], extents_at: &dyn Fn(&str, f64) -> Option<([f64; 4], Option<[f64; 4]>)>) -> Value {
    use crate::presentation_poster::{layout, Cell, Grid, Group};
    let valid = |v: f64| v.is_finite() && v > 0.0;
    let gutter = if po.gutter_mm.is_finite() && po.gutter_mm >= 0.0 && po.gutter_mm < sheet.w / 4.0 { po.gutter_mm } else { GAP_MM };
    let band = if valid(po.band_mm) { po.band_mm } else { TITLE_MM };
    let g = Grid::new(sheet.w, sheet.h, sheet.margin, sheet.top, po.columns.max(1), gutter, band);
    let own = |id: &str| req.scales.get(id).copied().filter(|v| valid(*v));

    // Situation: eigener Ausschnitt (Vorlage „Situation WBW“, Umgebung sichtbar), eigener Massstab, um das Haus beschnitten.
    let situation = po.situation.as_ref().filter(|s| valid(s.scale) && p.drawing_levels.iter().any(|l| l.id == s.level_id)).and_then(|s| {
        let with_tpl;
        let q = match &s.template {
            Some(t) if !p.view_templates.iter().flatten().any(|v| v.id == t.id) => {
                let mut c = p.clone();
                c.view_templates.get_or_insert_with(Vec::new).push(t.clone());
                with_tpl = c;
                &with_tpl
            }
            _ => p,
        };
        let snap = ViewSnapshot {
            active_level_id: s.level_id.clone(),
            layer_visibility: s.layer_visibility.clone(),
            detail: s.detail,
            scale_denominator: s.scale,
            template_id: s.template.as_ref().map(|t| t.id.clone()),
            template_linked: s.template.as_ref().map(|_| true),
            ..Default::default()
        };
        let (b, house) = crate::sheet_viewports::snapshot_extents(q, &snap, s.scale, Some(false))?;
        if !b.iter().all(|v| v.is_finite()) {
            return None;
        }
        let mut f = Frame::of(crop(b, house, SITUATION_MARGIN_MM * s.scale / 1000.0), s.scale);
        // Höchstens die halbe Breite und knapp die halbe Höhe des Satzspiegels; beschnitten bleibt das Haus in der Mitte.
        let (max_w, max_h) = (g.span_w(g.cols.div_ceil(2)) - 2.0 * FRAME_PAD_MM, (g.height() - g.band) * 0.45 - 2.0 * FRAME_PAD_MM);
        let hc = house.map(|h| ((h[0] + h[2]) / 2.0, (h[1] + h[3]) / 2.0));
        if f.w > max_w {
            f.w = max_w;
            f.cx = hc.map_or(f.cx, |c| c.0);
        }
        if f.h > max_h {
            f.h = max_h;
            f.cy = hc.map_or(f.cy, |c| c.1);
        }
        Some((s, f))
    });

    let heights = table_heights(p, &po.tables);
    let pref = g.cols.div_ceil(2).max(2);
    let tables: Vec<(usize, f64)> = heights.iter().map(|h| (pref, *h)).collect();
    let min_image = ((g.bottom - g.top) * MIN_IMAGE_SHARE).max(60.0);

    // Gruppen: Situation | Grundrisse | Schnitte + Ansichten.
    let marks = req.marks.then(|| marks_box(p, kept)).flatten();
    let frames_at = |s: f64| view_frames(kept, &|id: &str| own(id).unwrap_or(s), extents_at, marks);
    let groups_at = |frames: &[Frame]| -> Vec<Group> {
        let cell = |f: &Frame| Cell::sized(&g, f.w + 2.0 * FRAME_PAD_MM, f.h + 2.0 * FRAME_PAD_MM);
        let mut out = Vec::new();
        if let Some((_, f)) = &situation {
            out.push(Group { cells: vec![cell(f)], image_beside: true });
        }
        out.push(Group { cells: kept.iter().zip(frames).filter(|((_, grp), _)| *grp == 0).map(|(_, f)| cell(f)).collect(), image_beside: false });
        out.push(Group { cells: kept.iter().zip(frames).filter(|((_, grp), _)| *grp > 0).map(|(_, f)| cell(f)).collect(), image_beside: false });
        out
    };
    let scale = match req.scale.filter(|v| valid(*v)) {
        Some(s) => s,
        None => SCALES
            .iter()
            .copied()
            .find(|s| {
                let r = layout(&g, &groups_at(&frames_at(*s)), &tables, false, min_image);
                r.pages == 1 && r.items.iter().all(|i| !i.forced)
            })
            .unwrap_or(SCALES[SCALES.len() - 1]),
    };
    let frames = frames_at(scale);
    // [266] Das 3D-Bild ist höchstens so gross wie der grösste Grundriss (ohne Grundrisse: wie der grösste Schnitt/die grösste Ansicht).
    let grp0 = kept.iter().zip(&frames).filter(|((_, grp), _)| *grp == 0).map(|(_, f)| f).collect::<Vec<_>>();
    let basis: Vec<&Frame> = if grp0.is_empty() { frames.iter().collect() } else { grp0 };
    let g = match basis.iter().fold(None, |m: Option<(f64, f64)>, f| Some((m.map_or(f.w, |m| m.0.max(f.w)), m.map_or(f.h, |m| m.1.max(f.h))))) {
        Some((w, h)) => g.with_image_max(w + 2.0 * FRAME_PAD_MM, h + 2.0 * FRAME_PAD_MM),
        None => g,
    };
    let r = layout(&g, &groups_at(&frames), &tables, po.image, min_image);
    let mut items: Vec<Value> = Vec::new();
    let mut placed = r.items.iter();
    let rect_json = |pl: &crate::presentation_poster::Placed, f: &Frame| {
        json!({"page": pl.page, "line": pl.line, "xMm": pl.rect.x_mm, "yMm": pl.rect.y_mm, "widthMm": pl.rect.width_mm, "heightMm": pl.rect.height_mm, "center": {"x": f.cx, "y": f.cy}})
    };
    let merge = |mut a: Value, b: Value| {
        if let (Some(a), Some(b)) = (a.as_object_mut(), b.as_object()) {
            a.extend(b.clone());
        }
        a
    };
    if let Some((sit, f)) = &situation {
        if let Some(pl) = placed.next() {
            items.push(merge(json!({"levelId": sit.level_id, "kind": "situation", "group": SITUATION_GROUP, "scale": sit.scale}), rect_json(pl, f)));
        }
    }
    // Reihenfolge der Rahmen = Gruppen: Grundrisse, dann Schnitte/Ansichten (wie `kept`, nach Gruppe sortiert).
    for (((id, grp), f), pl) in kept.iter().zip(&frames).zip(placed) {
        items.push(merge(json!({"levelId": id, "kind": "view", "group": grp, "scale": own(id).unwrap_or(scale)}), rect_json(pl, f)));
    }
    let tables_out: Vec<Value> = po
        .tables
        .iter()
        .zip(&r.tables)
        .zip(&heights)
        .map(|((t, pl), h)| json!({"id": t.id, "page": pl.page, "xMm": pl.rect.x_mm, "yMm": pl.rect.y_mm, "widthMm": pl.rect.width_mm, "heightMm": pl.rect.height_mm, "tableHeightMm": h, "bandMm": g.band}))
        .collect();
    let image = r.image.map(|pl| json!({"page": pl.page, "xMm": pl.rect.x_mm, "yMm": pl.rect.y_mm, "widthMm": pl.rect.width_mm, "heightMm": pl.rect.height_mm}));
    let forced = r.items.iter().chain(&r.tables).any(|i| i.forced);
    json!({"scale": scale, "fits": !forced, "pages": r.pages, "items": items, "skipped": skipped, "tables": tables_out, "image": image, "bandMm": g.band, "padMm": FRAME_PAD_MM})
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

    /// [208] Ausschnitt: Kontext weit draussen wird auf Bauteile ± Rand beschnitten, Inhalt näher dran bleibt ganz;
    /// ohne Bauteile (Schnitt/Ansicht) und mit Unsinn das ganze Ausmass.
    #[test]
    fn ausschnitt_um_die_bauteile() {
        let b = [-40.0, -30.0, 60.0, 45.0];
        let house = Some([0.0, 0.0, 20.0, 12.0]);
        assert_eq!(crop(b, house, 4.0), [-4.0, -4.0, 24.0, 16.0]);
        assert_eq!(crop([-1.0, -2.0, 21.0, 13.0], house, 4.0), [-1.0, -2.0, 21.0, 13.0]);
        assert_eq!(crop(b, None, 4.0), b);
        assert_eq!(crop(b, Some([f64::NAN, 0.0, 1.0, 1.0]), 4.0), b);
        assert_eq!(crop(b, house, f64::NAN), b);
    }

    /// [208] Grundrisse gleich gross mit gemeinsamer Mitte; Schnitte/Ansichten gleich hoch mit gemeinsamer Höhenmitte.
    #[test]
    fn rahmen_deckungsgleich_und_gleiche_hoehe() {
        let kept: Vec<(String, u32)> = vec![("eg".into(), 0), ("og".into(), 0), ("a".into(), 1), ("s".into(), 2)];
        let ext = |id: &str, _s: f64| -> Option<([f64; 4], Option<[f64; 4]>)> {
            Some(match id {
                "eg" => ([-50.0, -50.0, 60.0, 50.0], Some([0.0, 0.0, 20.0, 12.0])),
                "og" => ([-3.0, -3.0, 18.0, 15.0], Some([0.0, 0.0, 15.0, 12.0])),
                "a" => ([-2.0, -1.0, 22.0, 9.0], None),
                _ => ([1.0, -4.0, 13.0, 10.0], None),
            })
        };
        let f = view_frames(&kept, &|_| 200.0, &ext, None);
        let m = PLAN_MARGIN_MM * 200.0 / 1000.0;
        // Grundrisse: Vereinigung der Ausschnitte (EG beschnitten auf ± 4 m), beide gleich.
        assert_eq!((f[0].w, f[0].h, f[0].cx, f[0].cy), (f[1].w, f[1].h, f[1].cx, f[1].cy));
        assert!((f[0].w - (20.0 + 2.0 * m) * 5.0).abs() < 1e-9 && (f[0].h - (12.0 + 2.0 * m) * 5.0).abs() < 1e-9);
        // Ansicht und Schnitt: Höhe −4 … 10 gemeinsam, Breite je eigen.
        assert_eq!((f[2].h, f[2].cy), (f[3].h, f[3].cy));
        assert!((f[2].h - 70.0).abs() < 1e-9 && (f[2].w - 120.0).abs() < 1e-9 && (f[3].w - 60.0).abs() < 1e-9);
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
