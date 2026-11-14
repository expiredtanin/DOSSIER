//! [208] Plakat-Anordnung des Präsentationsplans: Inhalte (Situation 1:500, Grundrisse/Schnitt/Ansichten, Tabellen,
//! Platzhalter fürs 3D-Bild) auf dem Spaltenraster der Plakat-Vorlage (`layout_poster.rs`).
//!
//! Jeder Viewport belegt ganze Spalten (Rahmenbreite = Spaltenbreite, Inhalt bleibt mittig im Rahmen), der Massstab
//! bleibt fest: passt etwas nicht mehr aufs Blatt, kommt es auf ein weiteres Blatt (Plan 2/2), nie in einen
//! kleineren Massstab. Gepackt wird als „Skyline“: jede Spalte merkt sich, bis wohin sie belegt ist; ein Inhalt
//! geht an die Stelle mit dem kleinsten y (bei Gleichstand links), dadurch entstehen Zeilen gleich hoher Rahmen,
//! und neben einem hohen Rahmen (Situation) stapeln sich die kleinen. Tabellen füllen danach Lücken, das 3D-Bild
//! bekommt das grösste freie Rechteck.


use crate::presentation_sheet::Rect;

/// Raster eines Plakat-Blatts (Papier-mm).
#[derive(Clone, Copy, Debug)]
pub struct Grid {
    pub left: f64,
    pub top: f64,
    pub bottom: f64,
    pub col_w: f64,
    pub gutter: f64,
    pub cols: usize,
    /// Platz unter einem Rahmen für Titel und Massstab.
    pub band: f64,
}

impl Grid {
    pub fn new(w: f64, h: f64, margin: f64, top: f64, cols: usize, gutter: f64, band: f64) -> Grid {
        let cols = cols.clamp(1, 12);
        let col_w = ((w - 2.0 * margin - (cols as f64 - 1.0) * gutter) / cols as f64).max(1.0);
        Grid { left: margin, top, bottom: h - margin, col_w, gutter, cols, band }
    }
    pub fn span_w(&self, k: usize) -> f64 {
        k as f64 * self.col_w + (k as f64 - 1.0) * self.gutter
    }
    pub fn col_x(&self, c: usize) -> f64 {
        self.left + c as f64 * (self.col_w + self.gutter)
    }
    /// Spalten, die ein Inhalt der Breite `w` belegt (mindestens 1, höchstens alle).
    pub fn span_for(&self, w: f64) -> usize {
        let k = ((w + self.gutter) / (self.col_w + self.gutter) - 1e-9).ceil();
        if k.is_finite() { (k.max(1.0) as usize).min(self.cols) } else { 1 }
    }
}

/// Ein Viewport-Inhalt: Spalten und Rahmenhöhe (ohne Titelband).
#[derive(Clone, Copy, Debug)]
pub struct Cell {
    pub span: usize,
    pub h: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Placed {
    pub page: usize,
    pub rect: Rect,
    /// Wurde nicht ordentlich untergebracht (grösser als ein leeres Blatt): `fits = false`.
    pub forced: bool,
}

#[derive(Clone, Debug, Default)]
pub struct Result {
    pub pages: usize,
    pub items: Vec<Placed>,
    /// Pro Tabelle: Rahmen samt Titelband oben (`h` = Band + Tabellenhöhe); `None`, wenn sie auf keinem Blatt Platz hat.
    pub tables: Vec<Placed>,
    pub image: Option<Placed>,
}

struct Pages<'a> {
    g: &'a Grid,
    sky: Vec<Vec<f64>>,
}

impl<'a> Pages<'a> {
    fn new(g: &'a Grid) -> Pages<'a> {
        Pages { g, sky: vec![vec![g.top; g.cols]] }
    }
    fn empty(&self, page: usize) -> bool {
        self.sky[page].iter().all(|y| *y <= self.g.top + 1e-9)
    }
    /// Stelle mit dem kleinsten y für `span` Spalten und Höhe `h` auf `page`.
    fn find(&self, page: usize, span: usize, h: f64) -> Option<(usize, f64)> {
        let sky = &self.sky[page];
        let mut best: Option<(usize, f64)> = None;
        for a in 0..=(self.g.cols - span) {
            let y = sky[a..a + span].iter().copied().fold(self.g.top, f64::max);
            if y + h > self.g.bottom + 1e-9 {
                continue;
            }
            if best.is_none_or(|(_, by)| y < by - 1e-9) {
                best = Some((a, y));
            }
        }
        best
    }
    fn commit(&mut self, page: usize, a: usize, span: usize, y: f64, h: f64) -> Rect {
        for c in a..a + span {
            self.sky[page][c] = y + h + self.g.gutter;
        }
        Rect { x_mm: self.g.col_x(a), y_mm: y, width_mm: self.g.span_w(span), height_mm: h }
    }
    fn new_page(&mut self) -> usize {
        self.sky.push(vec![self.g.top; self.g.cols]);
        self.sky.len() - 1
    }
    /// Grösstes freies Rechteck (mindestens `min_span` Spalten, `min_h` hoch) über alle Blätter.
    fn largest_free(&self, min_span: usize, min_h: f64) -> Option<(usize, usize, usize, f64)> {
        let mut best: Option<(usize, usize, usize, f64, f64)> = None;
        for (page, sky) in self.sky.iter().enumerate() {
            for a in 0..self.g.cols {
                for b in a + min_span.min(self.g.cols)..=self.g.cols {
                    let y = sky[a..b].iter().copied().fold(self.g.top, f64::max);
                    let h = self.g.bottom - y;
                    if h + 1e-9 < min_h {
                        continue;
                    }
                    let area = self.g.span_w(b - a) * h;
                    if best.is_none_or(|(.., ba)| area > ba + 1e-6) {
                        best = Some((page, a, b - a, y, area));
                    }
                }
            }
        }
        best.map(|(p, a, s, y, _)| (p, a, s, y))
    }
}

/// Inhalte anordnen. `items`: Rahmen in Lesereihenfolge; `tables`: (bevorzugte Spalten, Höhe der Tabelle ohne Titelband);
/// `image`: Platzhalter fürs 3D-Bild gewünscht (Mindestgrösse 2 Spalten × `min_image_h`).
pub fn layout(g: &Grid, items: &[Cell], tables: &[(usize, f64)], image: bool, min_image_h: f64) -> Result {
    let mut pg = Pages::new(g);
    let mut out = Result::default();
    let mut cur = 0;
    for c in items {
        let span = c.span.clamp(1, g.cols);
        let h = c.h + g.band;
        let (page, a, y, forced) = loop {
            if let Some((a, y)) = pg.find(cur, span, h) {
                break (cur, a, y, false);
            }
            if pg.empty(cur) {
                break (cur, 0, g.top, true);
            }
            cur = pg.new_page();
        };
        out.items.push(Placed { page, rect: pg.commit(page, a, span, y, h - g.band), forced });
        // Titelband gehört zur belegten Höhe.
        for col in a..a + span {
            pg.sky[page][col] = y + h + g.gutter;
        }
    }
    // Tabellen: erstes Blatt mit Platz, zuerst in der bevorzugten Breite, dann schmaler (mindestens 2 Spalten); sonst neues Blatt.
    for &(pref, th) in tables {
        let h = g.band + th;
        let widths: Vec<usize> = (2.min(g.cols)..=pref.clamp(1, g.cols)).rev().collect();
        let mut placed = None;
        'search: for &span in &widths {
            for page in 0..pg.sky.len() {
                if let Some((a, y)) = pg.find(page, span, h) {
                    placed = Some(Placed { page, rect: pg.commit(page, a, span, y, h), forced: false });
                    break 'search;
                }
            }
        }
        if placed.is_none() {
            let span = pref.clamp(1, g.cols);
            let page = pg.new_page();
            let (a, y, forced) = match pg.find(page, span, h) {
                Some((a, y)) => (a, y, false),
                None => (0, g.top, true),
            };
            placed = Some(Placed { page, rect: pg.commit(page, a, span, y, h), forced });
        }
        out.tables.push(placed.unwrap());
    }
    if image {
        let free = pg.largest_free(2, min_image_h).or_else(|| {
            let page = pg.new_page();
            pg.largest_free(2, min_image_h).filter(|f| f.0 == page)
        });
        if let Some((page, a, span, y)) = free {
            let rect = Rect { x_mm: g.col_x(a), y_mm: y, width_mm: g.span_w(span), height_mm: g.bottom - y };
            for c in a..a + span {
                pg.sky[page][c] = g.bottom + g.gutter;
            }
            out.image = Some(Placed { page, rect, forced: false });
        }
    }
    // Leere letzte Blätter (nur durch das Suchen nach Platz entstanden) fallen weg.
    while pg.sky.len() > 1 && pg.empty(pg.sky.len() - 1) {
        pg.sky.pop();
    }
    out.pages = pg.sky.len();
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A1 quer, Plakat-Raster (Ränder 20, Kopfzeile bis 58): 6 Spalten.
    fn a1() -> Grid {
        Grid::new(841.0, 594.0, 20.0, 58.0, 6, 10.0, 8.0)
    }

    fn overlap(a: &Rect, b: &Rect, band: f64) -> bool {
        a.x_mm < b.x_mm + b.width_mm - 1e-6 && b.x_mm < a.x_mm + a.width_mm - 1e-6 && a.y_mm < b.y_mm + b.height_mm + band - 1e-6 && b.y_mm < a.y_mm + a.height_mm + band - 1e-6
    }

    #[test]
    fn spalten_und_breiten() {
        let g = a1();
        assert!((g.span_w(6) - 801.0).abs() < 1e-9);
        assert_eq!(g.span_for(60.0), 1);
        assert_eq!(g.span_for(g.col_w), 1);
        assert_eq!(g.span_for(g.col_w + 0.5), 2);
        assert_eq!(g.span_for(1e9), 6);
        assert_eq!(g.span_for(f64::NAN), 1);
    }

    /// Situation 3 Spalten hoch, daneben stapeln sich Grundrisse; Tabellen und Bild füllen den Rest, alles im Satzspiegel.
    #[test]
    fn alles_im_satzspiegel_ohne_ueberlappung_und_flaeche_genutzt() {
        let g = a1();
        let mut items = vec![Cell { span: 3, h: 190.0 }];
        items.extend((0..4).map(|_| Cell { span: 1, h: 60.0 }));
        items.extend((0..4).map(|_| Cell { span: 1, h: 50.0 }));
        items.push(Cell { span: 1, h: 50.0 });
        let r = layout(&g, &items, &[(3, 80.0), (3, 70.0)], true, 70.0);
        assert_eq!(r.pages, 1);
        let mut rects: Vec<(Rect, f64)> = r.items.iter().map(|p| (p.rect, g.band)).collect();
        rects.extend(r.tables.iter().map(|p| (p.rect, 0.0)));
        rects.push((r.image.expect("Bild").rect, 0.0));
        for (i, (a, ba)) in rects.iter().enumerate() {
            assert!(a.x_mm >= g.left - 1e-6 && a.x_mm + a.width_mm <= 841.0 - 20.0 + 1e-6, "{a:?} seitlich");
            assert!(a.y_mm >= g.top - 1e-6 && a.y_mm + a.height_mm + ba <= g.bottom + 1e-6, "{a:?} vertikal");
            for (b, bb) in &rects[i + 1..] {
                assert!(!overlap(a, b, ba.max(*bb)), "{a:?} überlappt {b:?}");
            }
        }
        let used: f64 = rects.iter().map(|(r, b)| r.width_mm * (r.height_mm + b)).sum();
        let area = (841.0 - 40.0) * (g.bottom - g.top);
        assert!(used / area >= 0.7, "Flächenanteil {:.2}", used / area);
        // Rahmen liegen an Spalten (Breite = Spaltenbreite oder Vielfache).
        for p in &r.items {
            let k = ((p.rect.width_mm + g.gutter) / (g.col_w + g.gutter)).round();
            assert!((p.rect.width_mm - g.span_w(k as usize)).abs() < 1e-6);
        }
    }

    /// Zu viele Grundrisse für ein Blatt: zweites Blatt, nichts wird kleiner (Rahmen bleiben unverändert).
    #[test]
    fn zweites_blatt_statt_verkleinern() {
        let g = a1();
        let items: Vec<Cell> = (0..30).map(|_| Cell { span: 2, h: 110.0 }).collect();
        let r = layout(&g, &items, &[(3, 60.0)], true, 70.0);
        assert!(r.pages >= 2);
        assert!(r.items.iter().all(|p| (p.rect.height_mm - 110.0).abs() < 1e-9 && !p.forced));
        assert!(r.items.iter().any(|p| p.page == 1));
        let last = r.items.last().unwrap().page;
        assert_eq!(last, r.pages - 1);
    }

    /// Ein Rahmen, der höher ist als das Blatt, wird erzwungen (kein Absturz) und gemeldet.
    #[test]
    fn zu_hoher_rahmen_wird_gemeldet() {
        let g = a1();
        let r = layout(&g, &[Cell { span: 1, h: 900.0 }], &[], false, 70.0);
        assert!(r.items[0].forced);
        assert_eq!(r.pages, 1);
    }

    /// Tabelle, die neben vollen Blättern nirgends Platz hat, bekommt ein eigenes Blatt.
    #[test]
    fn tabelle_ohne_platz_neues_blatt() {
        let g = a1();
        let items = vec![Cell { span: 6, h: 440.0 }];
        let r = layout(&g, &items, &[(3, 80.0)], false, 70.0);
        assert_eq!(r.pages, 2);
        assert_eq!(r.tables[0].page, 1);
    }

    #[test]
    fn kein_bild_ohne_platz_und_nichts_gewaehlt() {
        let g = a1();
        let r = layout(&g, &[], &[], false, 70.0);
        assert_eq!((r.pages, r.items.len(), r.image.is_none()), (1, 0, true));
    }
}
