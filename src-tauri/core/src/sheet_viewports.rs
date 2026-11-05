//! Viewports eines Layout-Blatts im Kern ([93]): die Abbildung Modell → Blatt-Ebene, die auch die
//! Anzeige (`ViewportPlanSvg` → `planToPrintSvg`) benutzt, für den Fang auf Viewport-Inhalt
//! (`snap_model.rs`) und den Papierbereich des DXF/DWG-Exports (`plan_dxf.rs`).
//!
//! Ein Viewport zeigt den Grundriss seines Ausschnitts (Ebene, sichtbare Ebenen-Codes, Detailgrad) im
//! Massstab 1:N, zentriert im Viewport-Rechteck (Mitte des Plan-Ausmasses = Mitte des Rechtecks) und
//! auf das Rechteck geklippt. Die Blatt-Ebene rechnet in Papier-Metern (Ursprung oben links,
//! Papier-y nach unten = −y, s. `sheetMmToModel`).

use crate::model::{DetailLevel, DrawingLevel, DrawingLevelKind, Layout, LayoutViewport, Project, ViewSnapshot};
use crate::plan::domains::{plan_domains_buf, PlanArgs};
use crate::plan::style::Detail;
use std::collections::HashSet;

/// Ein platzierter Viewport mit aufgelöstem Ausschnitt.
pub struct VpMap {
    /// Rechteck auf dem Papier (mm, y nach unten).
    pub x_mm: f64,
    pub y_mm: f64,
    pub w_mm: f64,
    pub h_mm: f64,
    /// Mitte des Plan-Ausmasses (Modell-Meter).
    pub cx: f64,
    pub cy: f64,
    /// Massstabsnenner.
    pub scale: f64,
    /// Ebene des Ausschnitts.
    pub level: String,
    /// Plan-Puffer des Ausschnitts (wie `generatePlan` für den Viewport).
    pub buf: Vec<u8>,
}

impl VpMap {
    /// Papier-mm je Modell-Meter.
    pub fn k(&self) -> f64 {
        1000.0 / self.scale
    }

    /// Modellpunkt → Papier-mm (x nach rechts, y nach unten).
    pub fn to_mm(&self, x: f64, y: f64) -> (f64, f64) {
        let k = self.k();
        (self.x_mm + self.w_mm / 2.0 + (x - self.cx) * k, self.y_mm + self.h_mm / 2.0 - (y - self.cy) * k)
    }

    /// Modellpunkt → Blatt-Ebene (Papier-Meter, y nach oben).
    pub fn to_sheet(&self, x: f64, y: f64) -> (f64, f64) {
        let (xm, ym) = self.to_mm(x, y);
        (xm / 1000.0, -ym / 1000.0)
    }

    /// Klipprechteck auf der Blatt-Ebene `[minX, minY, maxX, maxY]`.
    pub fn sheet_clip(&self) -> [f64; 4] {
        [self.x_mm / 1000.0, -(self.y_mm + self.h_mm) / 1000.0, (self.x_mm + self.w_mm) / 1000.0, -self.y_mm / 1000.0]
    }
}

fn detail_of(d: DetailLevel) -> Detail {
    match d {
        DetailLevel::Grob => Detail::Grob,
        DetailLevel::Fein => Detail::Fein,
        _ => Detail::Mittel,
    }
}

/// Plan-Argumente eines Viewports (wie `ViewportPlanSvg`: projektglobal, nicht für den Druck).
pub fn viewport_args(snap: &ViewSnapshot, scale: f64) -> PlanArgs {
    PlanArgs {
        floor: snap.active_level_id.clone(),
        detail: detail_of(snap.detail),
        show: snap.layer_visibility.iter().filter(|(_, v)| **v).map(|(k, _)| k.clone()).collect::<HashSet<String>>(),
        grey: HashSet::new(),
        reference_lines: false,
        global: true,
        scale,
        for_print: false,
        compact: false,
        mono: false,
        sun_when: None,
    }
}

/// Massstab eines Viewports (`resolveViewportScale`): eigener, sonst der des Ausschnitts, sonst 1:100.
pub fn viewport_scale(vp: &LayoutViewport, snap: Option<&ViewSnapshot>) -> f64 {
    let s = vp.scale_denominator.or(snap.map(|s| s.scale_denominator)).unwrap_or(100.0);
    if s.is_finite() && s > 0.0 {
        s
    } else {
        100.0
    }
}

/// Die Viewports des Layouts mit gebundenem Ausschnitt und gültigem Rechteck, je mit Plan.
pub fn viewport_maps(p: &Project, layout: &Layout) -> Vec<VpMap> {
    let snaps = p.view_snapshots.as_deref().unwrap_or(&[]);
    let mut out = Vec::new();
    for vp in &layout.viewports {
        let Some(snap) = snaps.iter().find(|s| s.id == vp.snapshot_id) else { continue };
        if !(vp.width_mm > 0.0 && vp.height_mm > 0.0 && vp.x_mm.is_finite() && vp.y_mm.is_finite()) {
            continue;
        }
        let scale = viewport_scale(vp, Some(snap));
        let Some(buf) = snapshot_buf(p, snap, scale, None) else { continue };
        let Some(b) = crate::plan::buf::View::parse(&buf).and_then(|v| v.bounds()) else { continue };
        out.push(VpMap {
            x_mm: vp.x_mm,
            y_mm: vp.y_mm,
            w_mm: vp.width_mm,
            h_mm: vp.height_mm,
            cx: (b[0] + b[2]) / 2.0,
            cy: (b[1] + b[3]) / 2.0,
            scale,
            level: snap.active_level_id.clone(),
            buf,
        });
    }
    out
}

/// Plan-Puffer des Inhalts eines Ausschnitts beim Massstab 1:`scale` (Grundriss bzw. Schnitt/Ansicht wie
/// im Viewport). `shadows` übersteuert den Schatten der Ansicht (Präsentationsplan [66]: Vorlage vor dem Anwenden).
pub fn snapshot_buf(p: &Project, snap: &ViewSnapshot, scale: f64, shadows: Option<bool>) -> Option<Vec<u8>> {
    match p.drawing_levels.iter().find(|l| l.id == snap.active_level_id) {
        Some(l) if matches!(l.kind, DrawingLevelKind::Section | DrawingLevelKind::Elevation) => match shadows {
            Some(s) => section_view_buf(p, &DrawingLevel { shadows: Some(s), ..l.clone() }, snap, scale),
            None => section_view_buf(p, l, snap, scale),
        },
        _ => plan_domains_buf(p, &viewport_args(snap, scale)).ok(),
    }
}

/// Ausmass (Modell-Meter `[minX, minY, maxX, maxY]`) des Ausschnitt-Inhalts — das Rechteck, dessen Mitte
/// der Viewport zentriert.
pub fn snapshot_bounds(p: &Project, snap: &ViewSnapshot, scale: f64, shadows: Option<bool>) -> Option<[f64; 4]> {
    let buf = snapshot_buf(p, snap, scale, shadows)?;
    crate::plan::buf::View::parse(&buf).and_then(|v| v.bounds())
}

/// Kategorie-Codes, die Schnitt/Ansicht prüfen (`candidateCodes` in `toSection.ts`).
fn candidate_codes(p: &Project) -> HashSet<String> {
    let mut codes: HashSet<String> = p.flat_categories().iter().map(|c| c.code.clone()).collect();
    codes.extend(p.walls.iter().map(|e| e.category_code.clone()));
    codes.extend(p.ceilings.iter().flatten().map(|e| e.category_code.clone()));
    codes.extend(p.roofs.iter().flatten().map(|e| e.category_code.clone()));
    codes.extend(p.stairs.iter().flatten().map(|e| e.category_code.clone()));
    codes.extend(p.openings.iter().flatten().map(|e| e.category_code.clone()));
    for c in p.context.iter().flatten() {
        if let crate::model::ContextObject::TerrainMesh(t) = c {
            codes.extend(t.category_code.clone());
        }
    }
    codes
}

/// [115] Inhalt eines Schnitt-/Ansicht-Viewports wie `viewportLevelPlan` (`plan/viewportPlan.ts`):
/// abgeleitete Projektion (Schnitt mit geschnittenen Öffnungen bzw. Ansicht), automatische Koten und
/// die eigenen 2D-Elemente der Ebene; Ausmass wie dort. Freie Körper (`extrudedSolids`, truck-Netze aus
/// TS) fehlen im Schnitt — der Kern hat sie hier nicht.
fn section_view_buf(p: &Project, level: &DrawingLevel, snap: &ViewSnapshot, scale: f64) -> Option<Vec<u8>> {
    use crate::plan::prim::Primitive;
    let args = viewport_args(snap, scale);
    let invisible: Vec<String> = candidate_codes(p).into_iter().filter(|c| !args.show.contains(c)).collect();
    let text = serde_json::json!({
        "level": serde_json::to_value(level).ok()?,
        "hiddenLines": level.hidden_lines.unwrap_or(false),
        "scale": scale,
        "hasVis": true,
        "invisible": invisible,
    })
    .to_string();
    let raw = if level.kind == DrawingLevelKind::Section {
        crate::plan::section::section_plan_buf(p, &[0.0, 1.0, 0.0], &text)
    } else {
        crate::plan::elevation::elevation_plan_buf(p, &[0.0, if level.shadows.unwrap_or(false) { 1.0 } else { 0.0 }, scale], &text)
    }
    .ok()?;
    let rv = crate::plan::buf::View::parse(&raw)?;
    let raw_prims = rv.prims()?;
    if raw_prims.is_empty() {
        return None;
    }
    let mut b = rv.bounds().unwrap_or([0.0, 0.0, 1.0, 1.0]);
    let own_buf = plan_domains_buf(p, &PlanArgs { global: false, ..args }).ok()?;
    let ov = crate::plan::buf::View::parse(&own_buf)?;
    let own = ov.prims().unwrap_or_default();
    let marks = if level.level_marks != Some(false) { crate::plan::drawings::level_markers(p, b) } else { Vec::new() };
    let mut grow = |x: f64, y: f64| {
        b = [b[0].min(x), b[1].min(y), b[2].max(x), b[3].max(y)];
    };
    if !own.is_empty() {
        if let Some(ob) = ov.bounds() {
            grow(ob[0], ob[1]);
            grow(ob[2], ob[3]);
        }
    }
    for pr in &marks {
        if let Primitive::Line { a, .. } = pr {
            grow(a.x, a.y);
        }
    }
    let mut w = crate::plan::buf::Writer::new(true);
    w.group(&raw_prims);
    w.group(&marks);
    w.group(&own);
    w.bounds = Some(b);
    Some(w.finish())
}

/// Strecke auf ein Rechteck klippen (Liang–Barsky); `None` = ganz ausserhalb.
pub fn clip_seg(s: [f64; 4], r: [f64; 4]) -> Option<[f64; 4]> {
    let (dx, dy) = (s[2] - s[0], s[3] - s[1]);
    let (mut t0, mut t1) = (0.0_f64, 1.0_f64);
    for (pk, qk) in [(-dx, s[0] - r[0]), (dx, r[2] - s[0]), (-dy, s[1] - r[1]), (dy, r[3] - s[1])] {
        if pk == 0.0 {
            if qk < 0.0 {
                return None;
            }
        } else {
            let t = qk / pk;
            if pk < 0.0 {
                if t > t1 {
                    return None;
                }
                t0 = t0.max(t);
            } else {
                if t < t0 {
                    return None;
                }
                t1 = t1.min(t);
            }
        }
    }
    Some([s[0] + t0 * dx, s[1] + t0 * dy, s[0] + t1 * dx, s[1] + t1 * dy])
}

/// Fangstrecken der Viewport-Inhalte auf der Blatt-Ebene: Polygon-Kanten und Linien jedes
/// Viewport-Plans (wie `snapSegmentsFromPrimitives`), abgebildet und aufs Rechteck geklippt.
pub fn viewport_snap_segments(p: &Project, layout: &Layout) -> Vec<[f64; 4]> {
    use crate::plan::prim::Primitive;
    let mut out = Vec::new();
    for m in viewport_maps(p, layout) {
        let Some(prims) = crate::plan::buf::View::parse(&m.buf).and_then(|v| v.prims()) else { continue };
        let clip = m.sheet_clip();
        let mut push = |a: (f64, f64), b: (f64, f64)| {
            let (a, b) = (m.to_sheet(a.0, a.1), m.to_sheet(b.0, b.1));
            if (a.0 - b.0).abs() < 1e-12 && (a.1 - b.1).abs() < 1e-12 {
                return;
            }
            if let Some(s) = clip_seg([a.0, a.1, b.0, b.1], clip) {
                out.push(s);
            }
        };
        for pr in &prims {
            match pr {
                Primitive::Polygon { pts, .. } => {
                    let n = pts.len();
                    for i in 0..n {
                        let (a, b) = (pts[i], pts[(i + 1) % n]);
                        push((a.x, a.y), (b.x, b.y));
                    }
                }
                Primitive::Line { a, b, .. } => push((a.x, a.y), (b.x, b.y)),
                _ => {}
            }
        }
    }
    out
}

/// Blatt-Ebene → Layout (`DrawingLevel.layoutId`).
pub fn layout_of_level<'a>(p: &'a Project, level: &str) -> Option<&'a Layout> {
    let id = p.drawing_levels.iter().find(|l| l.id == level)?.layout_id.as_deref()?;
    p.layouts.as_deref()?.iter().find(|l| l.id == id)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub(crate) fn json() -> serde_json::Value {
        serde_json::json!({
            "id": "p", "name": "P", "lineStyles": [], "hatches": [], "components": [],
            "wallTypes": [],
            "drawingLevels": [
                {"id": "eg", "name": "EG", "kind": "floor", "visible": true, "locked": false, "floorHeight": 2.6, "cutHeight": 1.0, "baseElevation": 0},
                {"id": "sh", "name": "Blatt", "kind": "drawing", "visible": true, "locked": false, "layoutId": "L"}
            ],
            "layers": [{"code": "20", "name": "W", "color": "#000", "lw": 0.5, "visible": true, "locked": false}],
            "walls": [], "openings": [], "ceilings": [], "stairs": [], "rooms": [], "context": [],
            "drawings2d": [
                {"id": "d1", "levelId": "eg", "categoryCode": "20", "geom": {"shape": "line", "a": {"x": 0, "y": 0}, "b": {"x": 10, "y": 0}}},
                {"id": "d2", "levelId": "eg", "categoryCode": "20", "geom": {"shape": "line", "a": {"x": 0, "y": 0}, "b": {"x": 0, "y": 4}}}
            ],
            "viewSnapshots": [{"id": "s", "name": "S", "viewType": "grundriss", "view3d": "iso", "scaleDenominator": 100, "detail": "mittel", "activeLevelId": "eg", "layerVisibility": {"20": true}, "drawingVisibility": {}}],
            "layouts": [{"id": "L", "name": "Blatt", "paper": "a3", "orientation": "landscape", "viewports": [{"id": "v", "snapshotId": "s", "xMm": 100, "yMm": 50, "widthMm": 200, "heightMm": 100}]}]
        })
    }

    fn project() -> Project {
        serde_json::from_value(json()).expect("Projekt")
    }

    #[test]
    fn fang_auf_viewport_inhalt_ueber_den_kern() {
        use crate::snap_model::{query, ModelQuery, SnapCache, F_SEGS};
        let mut d = crate::document::Document::from_json(&json().to_string()).unwrap();
        let mut c = SnapCache::default();
        let id = c.hold(1, &mut d, "sh", &["20".to_string()]);
        let p = project();
        let m = &viewport_maps(&p, layout_of_level(&p, "sh").unwrap())[0];
        let (ex, ey) = m.to_sheet(10.0, 0.0);
        let q = ModelQuery { draft: &[], sheet: &[], raw: (ex + 0.0004, ey + 0.0003), tol_m: 0.003, px_per_m: 3000.0, flags: crate::snap::F_ENDPOINT | F_SEGS, last: None };
        let a = query(c.get(id).unwrap(), &q).a.expect("Endpunkt im Viewport");
        assert!((a.x - ex).abs() < 1e-9 && (a.y - ey).abs() < 1e-9);
        // Gleicher Stand → dieselbe Nummer (gecacht).
        assert_eq!(c.hold(1, &mut d, "sh", &["20".to_string()]), id);
    }

    #[test]
    fn abbildung_zentriert_im_rechteck() {
        let p = project();
        let l = layout_of_level(&p, "sh").expect("Layout");
        let maps = viewport_maps(&p, l);
        assert_eq!(maps.len(), 1);
        let m = &maps[0];
        // Mitte des Plans (≈ 5, 2) liegt in der Mitte des Rechtecks (200, 100) mm.
        let (x, y) = m.to_mm(m.cx, m.cy);
        assert!((x - 200.0).abs() < 1e-9 && (y - 100.0).abs() < 1e-9);
        // 1 m bei 1:100 = 10 mm; Modell-y nach oben = Papier-y nach unten.
        let (x1, y1) = m.to_mm(m.cx + 1.0, m.cy + 1.0);
        assert!((x1 - 210.0).abs() < 1e-9 && (y1 - 90.0).abs() < 1e-9);
    }

    #[test]
    fn fangstrecken_in_blatt_koordinaten() {
        let p = project();
        let l = layout_of_level(&p, "sh").expect("Layout");
        let segs = viewport_snap_segments(&p, l);
        assert!(!segs.is_empty());
        let m = &viewport_maps(&p, l)[0];
        // Die Linie (0,0)–(10,0) erscheint auf dem Blatt (Papier-Meter).
        let (ax, ay) = m.to_sheet(0.0, 0.0);
        let (bx, by) = m.to_sheet(10.0, 0.0);
        assert!(segs.iter().any(|s| (s[0] - ax).abs() < 1e-9 && (s[1] - ay).abs() < 1e-9 && (s[2] - bx).abs() < 1e-9 && (s[3] - by).abs() < 1e-9));
        // Alles im Rechteck.
        let c = m.sheet_clip();
        assert!(segs.iter().all(|s| s[0] >= c[0] - 1e-12 && s[2] <= c[2] + 1e-12 && s[1] >= c[1] - 1e-12 && s[3] <= c[3] + 1e-12));
    }

    /// [115] Schnitt- und Ansicht-Viewports liefern Fangstrecken ihrer Projektion (vorher nur Grundrisse).
    #[test]
    fn fang_auf_schnitt_und_ansicht_viewport() {
        let mut v = json();
        v["drawingLevels"].as_array_mut().unwrap().extend([
            serde_json::json!({"id": "q", "name": "Q", "kind": "section", "visible": true, "locked": false, "linePoints": [{"x": 2, "y": -2}, {"x": 2, "y": 10}], "directionSign": 1, "levelMarks": false}),
            serde_json::json!({"id": "a", "name": "A", "kind": "elevation", "visible": true, "locked": false, "linePoints": [{"x": -1, "y": -3}, {"x": 11, "y": -3}], "directionSign": 1}),
        ]);
        v["walls"] = serde_json::json!([{"id": "W", "type": "wall", "floorId": "eg", "categoryCode": "20", "start": {"x": 0, "y": 0}, "end": {"x": 10, "y": 0}, "height": 3.0}]);
        v["viewSnapshots"].as_array_mut().unwrap().extend([
            serde_json::json!({"id": "sq", "name": "Q", "viewType": "grundriss", "view3d": "iso", "scaleDenominator": 100, "detail": "mittel", "activeLevelId": "q", "layerVisibility": {"20": true}, "drawingVisibility": {}}),
            serde_json::json!({"id": "sa", "name": "A", "viewType": "grundriss", "view3d": "iso", "scaleDenominator": 100, "detail": "mittel", "activeLevelId": "a", "layerVisibility": {"20": true}, "drawingVisibility": {}}),
        ]);
        v["layouts"][0]["viewports"] = serde_json::json!([
            {"id": "vq", "snapshotId": "sq", "xMm": 20, "yMm": 20, "widthMm": 150, "heightMm": 100},
            {"id": "va", "snapshotId": "sa", "xMm": 200, "yMm": 20, "widthMm": 150, "heightMm": 100}
        ]);
        let p: Project = serde_json::from_value(v).unwrap();
        let l = layout_of_level(&p, "sh").unwrap();
        let maps = viewport_maps(&p, l);
        assert_eq!(maps.len(), 2, "beide Viewports abgebildet");
        assert_eq!((maps[0].level.as_str(), maps[1].level.as_str()), ("q", "a"));
        // Schnitt: Wand geschnitten bei u ≈ 2 (Abstand zum Linienanfang), 0 … 3 m hoch.
        let b = crate::plan::buf::View::parse(&maps[0].buf).unwrap().bounds().unwrap();
        assert!(b[1].abs() < 1e-6 && (b[3] - 3.0).abs() < 1e-6, "{b:?}");
        let segs = viewport_snap_segments(&p, l);
        let (c0, c1) = (maps[0].sheet_clip(), maps[1].sheet_clip());
        let inside = |s: &[f64; 4], c: [f64; 4]| s[0] >= c[0] - 1e-12 && s[2] <= c[2] + 1e-12 && s[0].min(s[2]) >= c[0] - 1e-12 && s[1].min(s[3]) >= c[1] - 1e-12 && s[1].max(s[3]) <= c[3] + 1e-12;
        // Senkrechte Schnittkante der Wand: 3 m bei 1:100 = 0.03 Papier-Meter.
        let vertical = |s: &&[f64; 4]| (s[0] - s[2]).abs() < 1e-9 && ((s[1] - s[3]).abs() - 0.03).abs() < 1e-6;
        assert!(segs.iter().filter(|s| inside(s, c0)).any(|s| vertical(&s)), "Schnittkante im Schnitt-Viewport");
        assert!(segs.iter().filter(|s| inside(s, c1)).any(|s| vertical(&s)), "Wandkante im Ansicht-Viewport");
        // Abbildung wie im Grundriss: Modell-Punkt (u, z) → Blatt.
        let (x, y) = maps[0].to_mm(maps[0].cx, maps[0].cy);
        assert!((x - 95.0).abs() < 1e-9 && (y - 70.0).abs() < 1e-9);
    }

    /// [100] Deckenspiegel-Viewport: derselbe Inhalt wie die Deckenspiegel-Ebene (Wände, Untersicht).
    #[test]
    fn deckenspiegel_viewport() {
        let mut v = json();
        v["drawingLevels"].as_array_mut().unwrap().push(serde_json::json!({"id": "ds", "name": "DS", "kind": "ceiling", "visible": true, "locked": false, "ceilingOfId": "eg"}));
        v["layers"].as_array_mut().unwrap().push(serde_json::json!({"code": "30", "name": "D", "color": "#000", "lw": 0.35, "visible": true, "locked": false}));
        v["walls"] = serde_json::json!([{"id": "W", "type": "wall", "floorId": "eg", "categoryCode": "20", "start": {"x": 0, "y": 0}, "end": {"x": 10, "y": 0}, "height": 2.6}]);
        v["ceilings"] = serde_json::json!([{"id": "C", "type": "ceiling", "floorId": "eg", "categoryCode": "30", "thickness": 0.2, "outline": [{"x": 0, "y": 0}, {"x": 10, "y": 0}, {"x": 10, "y": 6}, {"x": 0, "y": 6}]}]);
        v["viewSnapshots"].as_array_mut().unwrap().push(serde_json::json!({"id": "sd", "name": "DS", "viewType": "grundriss", "view3d": "iso", "scaleDenominator": 50, "detail": "mittel", "activeLevelId": "ds", "layerVisibility": {"20": true, "30": true}, "drawingVisibility": {}}));
        v["layouts"][0]["viewports"] = serde_json::json!([{"id": "vd", "snapshotId": "sd", "xMm": 20, "yMm": 20, "widthMm": 300, "heightMm": 200}]);
        let p: Project = serde_json::from_value(v).unwrap();
        let maps = viewport_maps(&p, layout_of_level(&p, "sh").unwrap());
        assert_eq!(maps.len(), 1);
        assert_eq!(maps[0].scale, 50.0);
        let snap = &p.view_snapshots.as_ref().unwrap()[1];
        let direct = crate::plan::domains::plan_domains(&p, &viewport_args(snap, 50.0)).unwrap();
        assert!(!direct.walls.is_empty() && !direct.ceilings.is_empty(), "Wände und Untersicht im Viewport");
        let b = crate::plan::buf::View::parse(&maps[0].buf).unwrap().bounds().unwrap();
        assert!(b[2] - b[0] > 9.9 && b[3] - b[1] > 5.9, "Ausmass der Decke: {b:?}");
    }

    #[test]
    fn klippen() {
        let r = [0.0, 0.0, 1.0, 1.0];
        assert_eq!(clip_seg([-1.0, 0.5, 2.0, 0.5], r), Some([0.0, 0.5, 1.0, 0.5]));
        assert_eq!(clip_seg([2.0, 2.0, 3.0, 3.0], r), None);
    }
}
