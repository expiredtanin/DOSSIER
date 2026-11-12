//! Plakat-Vorlagen für Wettbewerbs-Abgaben ([208]): Ränder, Spaltenraster (Hilfslinien), Kopfzeile mit
//! Kennwort-Feld und „Plan x/n". Die Masse folgen der Blattgrösse (A0 gross, A1/kleiner); gezeichnet wird die
//! Kopfzeile am Bildschirm (SVG) und im PDF (jsPDF) aus denselben Elementen (`header_items`).

use serde::Serialize;

/// Masse eines Plakats in Papier-mm.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PosterMetrics {
    pub width_mm: f64,
    pub height_mm: f64,
    pub margin_mm: f64,
    pub header_height_mm: f64,
    pub columns: u32,
    pub gutter_mm: f64,
    /// Obere Kante der Inhaltsfläche (unter der Kopfzeile plus Spaltenabstand).
    pub content_top_mm: f64,
    pub guides: Vec<Guide>,
}

/// Hilfslinie: `axis` "x" (senkrecht, von links) oder "y" (waagrecht, von oben).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Guide {
    pub axis: &'static str,
    pub pos_mm: f64,
}

fn r2(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}

/// Plakat-Masse für ein Blatt `w`×`h` mm. A0-Klasse = lange Kante ab 1000 mm.
pub fn metrics(w: f64, h: f64) -> PosterMetrics {
    let landscape = w > h;
    let big = w.max(h) >= 1000.0;
    let (margin, header, gutter) = if big { (25.0, 40.0, 12.0) } else { (20.0, 28.0, 10.0) };
    let columns: u32 = match (big, landscape) {
        (true, true) => 8,
        (true, false) => 6,
        (false, true) => 6,
        (false, false) => 4,
    };
    let col_w = (w - 2.0 * margin - f64::from(columns - 1) * gutter) / f64::from(columns);
    let mut guides = Vec::new();
    for i in 0..columns {
        let left = margin + f64::from(i) * (col_w + gutter);
        guides.push(Guide { axis: "x", pos_mm: r2(left) });
        guides.push(Guide { axis: "x", pos_mm: r2(left + col_w) });
    }
    let content_top = margin + header + gutter;
    guides.push(Guide { axis: "y", pos_mm: r2(margin) });
    guides.push(Guide { axis: "y", pos_mm: r2(margin + header) });
    guides.push(Guide { axis: "y", pos_mm: r2(content_top) });
    guides.push(Guide { axis: "y", pos_mm: r2(h - margin) });
    PosterMetrics { width_mm: w, height_mm: h, margin_mm: margin, header_height_mm: header, columns, gutter_mm: gutter, content_top_mm: content_top, guides }
}

/// Zeichenelement der Kopfzeile (Papier-mm). Texthöhe `size_mm` ist die Schrifthöhe (Em), `y` die Grundlinie.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum HeaderItem {
    Rect { x: f64, y: f64, w: f64, h: f64, stroke: f64 },
    #[serde(rename_all = "camelCase")]
    Text { x: f64, y: f64, text: String, size_mm: f64, align: &'static str, bold: bool },
}

/// Kopfzeile: Band über die Satzbreite, links das Kennwort-Feld (Beschriftung klein, Kennwort gross), in der Mitte
/// der Titel (leer bei anonymer Abgabe), rechts „Plan x/n".
pub fn header_items(w: f64, h: f64, keyword_label: &str, keyword: &str, title: &str, plan_text: &str) -> Vec<HeaderItem> {
    let m = metrics(w, h);
    let (x0, y0) = (m.margin_mm, m.margin_mm);
    let band_w = w - 2.0 * m.margin_mm;
    let hh = m.header_height_mm;
    let pad = hh * 0.18;
    let kw_w = (band_w * 0.28).min(hh * 7.0);
    let mut out = vec![
        HeaderItem::Rect { x: x0, y: y0, w: band_w, h: hh, stroke: 0.35 },
        HeaderItem::Rect { x: x0, y: y0, w: kw_w, h: hh, stroke: 0.35 },
        HeaderItem::Text { x: x0 + pad, y: y0 + hh * 0.3, text: keyword_label.to_string(), size_mm: hh * 0.2, align: "left", bold: false },
    ];
    if !keyword.is_empty() {
        out.push(HeaderItem::Text { x: x0 + pad, y: y0 + hh * 0.8, text: keyword.to_string(), size_mm: hh * 0.42, align: "left", bold: true });
    }
    if !title.is_empty() {
        out.push(HeaderItem::Text { x: x0 + kw_w + (band_w - kw_w) / 2.0 - hh * 0.9, y: y0 + hh * 0.64, text: title.to_string(), size_mm: hh * 0.4, align: "center", bold: true });
    }
    if !plan_text.is_empty() {
        out.push(HeaderItem::Text { x: x0 + band_w - pad, y: y0 + hh * 0.64, text: plan_text.to_string(), size_mm: hh * 0.4, align: "right", bold: false });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a1_quer_hat_sechs_spalten_im_rand() {
        let m = metrics(841.0, 594.0);
        assert_eq!((m.columns, m.margin_mm, m.header_height_mm), (6, 20.0, 28.0));
        let xs: Vec<f64> = m.guides.iter().filter(|g| g.axis == "x").map(|g| g.pos_mm).collect();
        assert_eq!(xs.len(), 12);
        assert_eq!(xs[0], 20.0);
        assert!((xs[11] - (841.0 - 20.0)).abs() < 0.01);
        // gleich breite Spalten, Abstand = Spaltenabstand
        assert!(((xs[2] - xs[1]) - 10.0).abs() < 0.02);
        assert!(((xs[1] - xs[0]) - (xs[3] - xs[2])).abs() < 0.02);
        let ys: Vec<f64> = m.guides.iter().filter(|g| g.axis == "y").map(|g| g.pos_mm).collect();
        assert_eq!(ys, vec![20.0, 48.0, 58.0, 574.0]);
    }

    #[test]
    fn spaltenzahl_nach_format_und_ausrichtung() {
        assert_eq!(metrics(1189.0, 841.0).columns, 8);
        assert_eq!(metrics(841.0, 1189.0).columns, 6);
        assert_eq!(metrics(594.0, 841.0).columns, 4);
        assert_eq!(metrics(841.0, 594.0).columns, 6);
        assert_eq!(metrics(1189.0, 841.0).margin_mm, 25.0);
    }

    #[test]
    fn kopfzeile_zeigt_kennwort_und_plannummer() {
        let items = header_items(841.0, 594.0, "Kennwort", "FALKE 7", "", "Plan 2/5");
        let texts: Vec<&str> = items
            .iter()
            .filter_map(|i| if let HeaderItem::Text { text, .. } = i { Some(text.as_str()) } else { None })
            .collect();
        assert_eq!(texts, vec!["Kennwort", "FALKE 7", "Plan 2/5"]);
        // alles innerhalb des Blatts
        for i in &items {
            if let HeaderItem::Rect { x, y, w, h, .. } = i {
                assert!(*x >= 0.0 && *y >= 0.0 && x + w <= 841.0 && y + h <= 594.0);
            }
        }
    }

    #[test]
    fn leeres_kennwort_laesst_das_feld_leer() {
        let items = header_items(841.0, 594.0, "Kennwort", "", "Haus", "Plan 1/1");
        assert!(!items.iter().any(|i| matches!(i, HeaderItem::Text { bold: true, text, .. } if text.is_empty())));
        assert!(items.iter().any(|i| matches!(i, HeaderItem::Text { text, .. } if text == "Haus")));
    }
}
