//! [143] Höhenlinien im DXF/DWG-Import erkennen: Aus den gelesenen Konturen werden Gelände-Höhenlinien
//! (`contourSet` der Kontext-Schicht, Grundlage für „Gelände erzeugen" und „Baugrube erstellen") statt einer
//! 2D-Zeichnung.
//!
//! Erkannt wird in drei Stufen (reine Funktionen auf [`DrawingImport`], keine Ops):
//! 1. **Layer-Name** als Hinweis (`Höhenlinie`, `HL`, `Contour`, `Kote` …): Konturen mit Höhe ≠ 0 zählen dazu.
//! 2. **Layer ohne Hinweis**, aber mit eindeutigem Muster: mindestens drei offene/geschlossene Linienzüge,
//!    alle mit konstanter Höhe ≠ 0 und mindestens zwei verschiedenen Höhen.
//! 3. **Höhentexte** als Ersatz, wenn die Höhe fehlt (Hinweis-Layer, Höhe 0): eine Zahl als Text nahe der Linie
//!    („432.50", „432,5 m") gibt der Linie ihre Höhe; der Text wird dann nicht mehr als Zeichnung übernommen.
//!
//! Nie Höhenlinien sind Kreise/Bögen, Schraffuren und 3D-Polylinien mit wechselnder Höhe (`z_varies`).

use crate::import_drawing::{Contour, DrawingImport};
use std::collections::{HashMap, HashSet};

/// Ergebnis der Erkennung: Index der Kontur in `DrawingImport::contours` und ihre Höhe, dazu die Texte,
/// die als Höhe verbraucht wurden.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct TerrainDetection {
    pub lines: Vec<(usize, f64)>,
    /// Indizes in `DrawingImport::texts`, die als Höhenangabe gedient haben.
    pub used_texts: Vec<usize>,
    /// Davon Linien, deren Höhe aus einem Text stammt.
    pub from_texts: usize,
}

/// Höhenwerte ausserhalb dieser Spanne (m) sind keine Höhenangaben.
const MIN_Z: f64 = -500.0;
const MAX_Z: f64 = 9000.0;

/// Hinweis aus dem Layer-Namen: ganze Wörter (`HL`, `Kote`, `Iso`) oder Wortteile (`Höhenlinien_5m`, `Contours`).
pub fn is_contour_layer_name(name: &str) -> bool {
    let low = name.to_lowercase().replace('ö', "oe").replace('ü', "ue").replace('ä', "ae").replace('ß', "ss");
    const PARTS: [&str; 9] = ["hoehenlinie", "hoehenkurve", "hoehenkote", "contour", "isohypse", "isolinie", "hoehenschicht", "niveaulinie", "elevation"];
    if PARTS.iter().any(|p| low.contains(p)) {
        return true;
    }
    const WORDS: [&str; 8] = ["hl", "kote", "koten", "iso", "kurve", "kurven", "gelaendelinie", "terrain"];
    low.split(|c: char| !c.is_alphanumeric()).any(|w| WORDS.contains(&w))
}

fn is_candidate(c: &Contour) -> bool {
    c.curve.is_none() && !c.filled && !c.z_varies && c.pts.len() >= 2 && c.z.is_finite() && c.z > MIN_Z && c.z < MAX_Z
}

/// Zahl in einem Text („432.50", „+432,5", „432.5 m", „432.5 m ü. M.") oder `None`.
pub fn parse_height(text: &str) -> Option<f64> {
    let t = text.trim();
    let t = t.strip_suffix("m ü. M.").or_else(|| t.strip_suffix("m ü.M.")).or_else(|| t.strip_suffix("müM")).or_else(|| t.strip_suffix("m.ü.M.")).unwrap_or(t);
    let t = t.trim().strip_suffix('m').unwrap_or(t).trim();
    let t = t.strip_prefix('+').unwrap_or(t);
    if t.is_empty() || !t.chars().all(|c| c.is_ascii_digit() || matches!(c, '.' | ',' | '-')) || !t.chars().any(|c| c.is_ascii_digit()) {
        return None;
    }
    let v: f64 = t.replace(',', ".").parse().ok()?;
    (v.is_finite() && v > MIN_Z && v < MAX_Z).then_some(v)
}

fn dist_point_seg(p: [f64; 2], a: [f64; 2], b: [f64; 2]) -> f64 {
    let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
    let l2 = dx * dx + dy * dy;
    let t = if l2 > 0.0 { (((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2).clamp(0.0, 1.0) } else { 0.0 };
    (p[0] - (a[0] + t * dx)).hypot(p[1] - (a[1] + t * dy))
}

fn dist_to_line(p: [f64; 2], c: &Contour) -> f64 {
    let mut best = f64::INFINITY;
    for w in c.pts.windows(2) {
        best = best.min(dist_point_seg(p, w[0], w[1]));
    }
    if c.closed && c.pts.len() > 2 {
        best = best.min(dist_point_seg(p, c.pts[c.pts.len() - 1], c.pts[0]));
    }
    best
}

/// Erkennt die Höhenlinien des Imports (s. Moduldoku). Leer, wenn nichts Eindeutiges gefunden wird.
pub fn detect(d: &DrawingImport) -> TerrainDetection {
    let mut out = TerrainDetection::default();
    // Kandidaten je Layer.
    let mut by_layer: HashMap<&str, Vec<usize>> = HashMap::new();
    for (i, c) in d.contours.iter().enumerate() {
        if is_candidate(c) {
            by_layer.entry(c.layer.as_str()).or_default().push(i);
        }
    }
    let mut direct: HashSet<usize> = HashSet::new();
    let mut need_text: Vec<usize> = Vec::new();
    for (layer, idx) in &by_layer {
        if is_contour_layer_name(layer) {
            for &i in idx {
                if d.contours[i].z != 0.0 {
                    direct.insert(i);
                } else {
                    need_text.push(i);
                }
            }
        } else if idx.len() >= 3 && idx.iter().all(|&i| d.contours[i].z != 0.0) {
            let mut zs: Vec<i64> = idx.iter().map(|&i| (d.contours[i].z * 100.0).round() as i64).collect();
            zs.sort_unstable();
            zs.dedup();
            if zs.len() >= 2 {
                direct.extend(idx.iter().copied());
            }
        }
    }
    // Stufe 3: Höhentexte für Linien ohne Höhe.
    let mut from_text: HashMap<usize, (f64, f64, usize)> = HashMap::new(); // Linie → (Abstand, Höhe, Text)
    if !need_text.is_empty() {
        for (ti, t) in d.texts.iter().enumerate() {
            let Some(z) = parse_height(&t.text) else { continue };
            if !(t.x.is_finite() && t.y.is_finite()) {
                continue;
            }
            let tol = (2.5 * t.height.max(0.0)).max(0.25);
            let mut best: Option<(usize, f64)> = None;
            for &ci in &need_text {
                let dist = dist_to_line([t.x, t.y], &d.contours[ci]);
                if dist <= tol && best.map_or(true, |(_, bd)| dist < bd) {
                    best = Some((ci, dist));
                }
            }
            if let Some((ci, dist)) = best {
                let e = from_text.entry(ci).or_insert((f64::INFINITY, z, ti));
                if dist < e.0 {
                    *e = (dist, z, ti);
                }
            }
        }
    }
    let mut used: HashSet<usize> = HashSet::new();
    let mut lines: Vec<(usize, f64)> = direct.into_iter().map(|i| (i, d.contours[i].z)).collect();
    for (ci, (_, z, ti)) in &from_text {
        lines.push((*ci, *z));
        used.insert(*ti);
    }
    lines.sort_by_key(|(i, _)| *i);
    out.from_texts = from_text.len();
    out.lines = lines;
    let mut ut: Vec<usize> = used.into_iter().collect();
    ut.sort_unstable();
    out.used_texts = ut;
    out
}
