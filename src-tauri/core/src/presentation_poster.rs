//! [208] Plakat-Anordnung des Präsentationsplans: Inhalte (Situation 1:500, Grundrisse, Schnitte/Ansichten, Tabellen,
//! 3D-Bild) auf dem Spaltenraster der Plakat-Vorlage (`layout_poster.rs`), wie eine Architektin ein Wettbewerbsplakat setzt.
//!
//! Strenge Zeilen nach Gruppen: zuerst die Situation (das 3D-Bild daneben), dann die Grundrisse nebeneinander, dann Schnitte
//! und Ansichten, zuletzt die Tabellen. Jede Gruppe beginnt eine neue Zeile; reicht eine Zeile nicht, bricht die Gruppe in
//! ausgeglichene Zeilen um (4 Grundrisse auf 2 Zeilen ⇒ 2 + 2, nicht 3 + 1). Ein Rahmen beginnt an einer Spaltenkante und ist so
//! breit wie sein Inhalt (nicht zwingend volle Spalten); der nächste Rahmen beginnt an der nächsten freien Spaltenkante.
//! Passt eine Gruppe nicht mehr auf das angefangene Blatt, aber auf ein leeres, beginnt sie dort (Gruppen nicht zerreissen); der
//! Massstab bleibt fest — mehr Inhalt ⇒ weiteres Blatt (Plan 2/2), nie ein kleinerer Massstab. Tabellen stehen rechts neben der
//! letzten Zeile, wenn dort Spalten frei sind, sonst in einer eigenen Zeile darunter.

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
    /// Höhe des Satzspiegels.
    pub fn height(&self) -> f64 {
        self.bottom - self.top
    }
}

/// Ein Viewport-Inhalt: belegte Spalten, Rahmenbreite (≤ Spaltenbreite × `span`) und Rahmenhöhe (ohne Titelband).
#[derive(Clone, Copy, Debug)]
pub struct Cell {
    pub span: usize,
    pub w: f64,
    pub h: f64,
}

impl Cell {
    /// Rahmen der Breite `w` (mm) und Höhe `h`: Spalten nach Breite, Breite höchstens die ganze Satzspiegelbreite.
    pub fn sized(g: &Grid, w: f64, h: f64) -> Cell {
        let w = if w.is_finite() { w } else { 1.0 };
        let span = g.span_for(w);
        Cell { span, w: w.min(g.span_w(span)).max(1.0), h: if h.is_finite() { h.max(1.0) } else { 1.0 } }
    }
}

/// Eine Gruppe (eine Zeile oder mehrere umgebrochene): Situation, Grundrisse, Schnitte + Ansichten.
#[derive(Clone, Debug, Default)]
pub struct Group {
    pub cells: Vec<Cell>,
    /// Das 3D-Bild steht rechts neben der ersten Zeile dieser Gruppe (Situation), sofern dort mindestens 2 Spalten frei sind.
    pub image_beside: bool,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Placed {
    pub page: usize,
    pub rect: Rect,
    /// Wurde nicht ordentlich untergebracht (grösser als ein leeres Blatt): `fits = false`.
    pub forced: bool,
    /// Laufende Zeile (über alle Blätter); Tabellen und Bild neben einer Zeile tragen deren Nummer.
    pub line: usize,
}

#[derive(Clone, Debug, Default)]
pub struct Result {
    pub pages: usize,
    /// Rahmen in der Reihenfolge der Gruppen und ihrer Zellen.
    pub items: Vec<Placed>,
    /// Pro Tabelle: Rahmen samt Titelband oben (`h` = Band + Tabellenhöhe).
    pub tables: Vec<Placed>,
    pub image: Option<Placed>,
}

/// Zeilen einer Gruppe: so wenige wie nötig, gleichmässig gefüllt (Anzahl je Zeile ausgeglichen).
fn split_lines(cells: &[Cell], cols: usize) -> Vec<std::ops::Range<usize>> {
    let greedy = |cap: usize| {
        let mut out = Vec::new();
        let (mut a, mut used) = (0, 0);
        for (i, c) in cells.iter().enumerate() {
            let s = c.span.clamp(1, cols);
            if i > a && (used + s > cols || i - a >= cap) {
                out.push(a..i);
                a = i;
                used = 0;
            }
            used += s;
        }
        if a < cells.len() {
            out.push(a..cells.len());
        }
        out
    };
    let first = greedy(usize::MAX);
    if first.len() > 1 {
        let even = greedy(cells.len().div_ceil(first.len()));
        if even.len() == first.len() {
            return even;
        }
    }
    first
}

/// Platz rechts neben der zuletzt gesetzten Zeile (für Tabellen und das Bild).
#[derive(Clone, Copy)]
struct Side {
    line: usize,
    /// Erste freie Spalte.
    col: usize,
    /// Oberkante des nächsten Elements daneben.
    y: f64,
}

struct State<'a> {
    g: &'a Grid,
    page: usize,
    /// Oberkante der nächsten Zeile.
    y: f64,
    line: usize,
    side: Option<Side>,
}

impl State<'_> {
    fn empty(&self) -> bool {
        self.y <= self.g.top + 1e-9
    }
    fn new_page(&mut self) {
        self.page += 1;
        self.y = self.g.top;
        self.side = None;
    }
    fn fits(&self, h: f64) -> bool {
        self.y + h <= self.g.bottom + 1e-9
    }
}

/// Inhalte anordnen. `groups` in Lesereihenfolge; `tables`: (bevorzugte Spalten, Höhe der Tabelle ohne Titelband);
/// `image`: Rahmen fürs 3D-Bild (neben der Situation, sonst die grösste freie Fläche, mindestens 2 Spalten × `min_image_h`).
///
/// [285] Zwei Anläufe: das Bild neben der Situation (Standard) und das Bild zuletzt in die grösste freie Fläche (die Tabellen
/// bekommen dann den Platz neben der Situation); genommen wird, was weniger Blätter braucht, sonst was dem Bild mehr Fläche lässt.
pub fn layout(g: &Grid, groups: &[Group], tables: &[(usize, f64)], image: bool, min_image_h: f64) -> Result {
    let a = layout_variant(g, groups, tables, image, min_image_h, true);
    if !image || !groups.iter().any(|gr| gr.image_beside) {
        return a;
    }
    let b = layout_variant(g, groups, tables, image, min_image_h, false);
    let forced = |r: &Result| r.items.iter().chain(&r.tables).any(|p| p.forced);
    let area = |r: &Result| r.image.map_or(0.0, |p| p.rect.width_mm * p.rect.height_mm);
    // Weniger Blätter zuerst; bei gleichen Blättern das Bild neben der Situation, ausser das Bild wird anderswo deutlich grösser.
    let better = (b.pages, forced(&b)) < (a.pages, forced(&a)) || ((b.pages, forced(&b)) == (a.pages, forced(&a)) && area(&b) > 1.25 * area(&a));
    if better { b } else { a }
}

/// Belegte Rechtecke je Blatt (Papier-mm, Rahmen samt Titelband), für die freie Platzsuche.
type Busy = Vec<(usize, Rect)>;

fn clash(a: &Rect, b: &Rect, pad: f64) -> bool {
    a.x_mm - pad < b.x_mm + b.width_mm - 1e-6 && b.x_mm < a.x_mm + a.width_mm + pad - 1e-6 && a.y_mm - pad < b.y_mm + b.height_mm - 1e-6 && b.y_mm < a.y_mm + a.height_mm + pad - 1e-6
}

/// Oberkanten der Zeilen je Blatt: `(Blatt, y, Zeilennummer)`; ordnet freie Elemente der Zeile zu, in deren Höhe sie beginnen
/// (so rücken sie beim Verteilen des Weissraums mit, ohne die Reihenfolge zu verändern).
fn line_at(tops: &[(usize, f64, usize)], page: usize, y: f64) -> usize {
    tops.iter().filter(|t| t.0 == page && t.1 <= y + 1e-6).map(|t| t.2).max().or_else(|| tops.iter().filter(|t| t.0 == page).map(|t| t.2).min()).unwrap_or(0)
}

/// Y-Kandidaten eines Blatts: Oberkante des Satzspiegels und unter jedem belegten Rechteck (plus Abstand), aufsteigend.
fn ys_of(g: &Grid, busy: &Busy, page: usize) -> Vec<f64> {
    let mut ys: Vec<f64> = std::iter::once(g.top).chain(busy.iter().filter(|b| b.0 == page).map(|b| b.1.y_mm + b.1.height_mm + g.gutter)).filter(|y| *y < g.bottom).collect();
    ys.sort_by(f64::total_cmp);
    ys.dedup_by(|a, b| (*a - *b).abs() < 1e-6);
    ys
}

/// [285] Freier Platz für eine Tabelle von `h` mm (samt Band): tiefstes Blatt zuletzt, oberste Lage zuerst, rechts vor links;
/// grössere Spaltenbreite vor kleinerer (mindestens 2 Spalten, höchstens `pref`).
fn table_slot(g: &Grid, busy: &Busy, pages: usize, pref: usize, h: f64) -> Option<(usize, Rect)> {
    for span in (2.min(pref)..=pref).rev() {
        for page in 0..pages {
            for y in ys_of(g, busy, page) {
                if y + h > g.bottom + 1e-9 {
                    continue;
                }
                for c in (0..=g.cols - span).rev() {
                    let r = Rect { x_mm: g.col_x(c), y_mm: y, width_mm: g.span_w(span), height_mm: h };
                    if !busy.iter().any(|b| b.0 == page && clash(&r, &b.1, g.gutter)) {
                        return Some((page, r));
                    }
                }
            }
        }
    }
    None
}

/// [285] Grösste freie Fläche (nach dem Zuschnitt des Bildes) mit mindestens 2 Spalten und `min_h` Höhe.
fn image_slot(g: &Grid, busy: &Busy, pages: usize, min_h: f64) -> Option<(usize, Rect)> {
    let mut best: Option<(f64, usize, Rect)> = None;
    for page in 0..pages {
        for y1 in ys_of(g, busy, page) {
            for c0 in 0..g.cols {
                for c1 in c0 + 1..g.cols {
                    let (x0, x1) = (g.col_x(c0), g.col_x(c1) + g.col_w);
                    let mut y2 = g.bottom;
                    for b in busy.iter().filter(|b| b.0 == page && b.1.x_mm < x1 - 1e-6 && x0 < b.1.x_mm + b.1.width_mm - 1e-6) {
                        if b.1.y_mm + b.1.height_mm + g.gutter > y1 + 1e-6 {
                            y2 = y2.min(b.1.y_mm - g.gutter);
                        }
                    }
                    if y2 - y1 + 1e-9 < min_h {
                        continue;
                    }
                    let free = Rect { x_mm: x0, y_mm: y1, width_mm: x1 - x0, height_mm: y2 - y1 };
                    let r = cap_image(free, false);
                    if best.as_ref().is_none_or(|b| r.width_mm * r.height_mm > b.0 + 1e-6) {
                        best = Some((r.width_mm * r.height_mm, page, r));
                    }
                }
            }
        }
    }
    best.map(|b| (b.1, b.2))
}

fn layout_variant(g: &Grid, groups: &[Group], tables: &[(usize, f64)], image: bool, min_image_h: f64, beside: bool) -> Result {
    let mut st = State { g, page: 0, y: g.top, line: 0, side: None };
    let mut out = Result::default();
    let mut busy: Busy = Vec::new();
    let mut tops: Vec<(usize, f64, usize)> = Vec::new();
    // Freie Fläche neben der Situation (für das Wachsen des Bildes, s. unten).
    let mut beside_free: Option<Rect> = None;
    for grp in groups.iter().filter(|gr| !gr.cells.is_empty()) {
        let lines = split_lines(&grp.cells, g.cols);
        let line_h: Vec<f64> = lines.iter().map(|r| grp.cells[r.clone()].iter().fold(0.0_f64, |m, c| m.max(c.h)) + g.band).collect();
        let total = line_h.iter().sum::<f64>() + g.gutter * (lines.len() as f64 - 1.0);
        // Gruppe nicht zerreissen: passt sie auf ein neues Blatt ganz, beginnt sie dort.
        if !st.empty() && !st.fits(total) && total <= g.height() + 1e-9 {
            st.new_page();
        }
        for (k, (r, lh)) in lines.iter().zip(&line_h).enumerate() {
            if !st.empty() && !st.fits(*lh) {
                st.new_page();
            }
            let forced = !st.fits(*lh);
            let mut col = 0;
            for c in &grp.cells[r.clone()] {
                let span = c.span.clamp(1, g.cols);
                let rect = Rect { x_mm: g.col_x(col), y_mm: st.y, width_mm: c.w.min(g.span_w(span)), height_mm: c.h };
                out.items.push(Placed { page: st.page, rect, forced, line: st.line });
                busy.push((st.page, Rect { height_mm: rect.height_mm + g.band, ..rect }));
                col += span;
            }
            tops.push((st.page, st.y, st.line));
            if beside && grp.image_beside && k == 0 && image && out.image.is_none() && g.cols >= col + 2 {
                let free = Rect { x_mm: g.col_x(col), y_mm: st.y, width_mm: g.span_w(g.cols - col), height_mm: lh - g.band };
                let rect = cap_image(free, true);
                beside_free = Some(free);
                busy.push((st.page, rect));
                out.image = Some(Placed { page: st.page, rect, forced: false, line: st.line });
                col = g.cols;
            }
            st.side = Some(Side { line: st.line, col, y: st.y });
            st.y += lh + g.gutter;
            st.line += 1;
        }
    }
    // Tabellen: rechts neben der letzten Zeile (rechtsbündig, untereinander), sonst in freier Fläche des Blatts, sonst in eigenen Zeilen.
    let mut row: Option<(usize, f64, f64)> = None; // (nächste Spalte, Oberkante, Höhe) der Tabellenzeile
    for &(pref, th) in tables {
        let h = g.band + th;
        let pref = pref.clamp(1, g.cols);
        let mut placed = None;
        // Ohne Bild neben der Situation: Tabellen zuerst in die oberste freie Fläche (neben die Situation), das Bild folgt.
        if !beside && row.is_none() {
            if let Some((page, rect)) = table_slot(g, &busy, st.page + 1, pref, h) {
                placed = Some(Placed { page, rect, forced: false, line: line_at(&tops, page, rect.y_mm) });
            }
        }
        // [296] Liegt die letzte Zeile schon auf einem späteren Blatt, füllen die Tabellen zuerst freie Spalten der früheren Blätter
        // (sonst wandern sie aufs zweite Blatt, obwohl oben Platz ist).
        if placed.is_none() && row.is_none() && st.page > 0 {
            if let Some((page, rect)) = table_slot(g, &busy, st.page, pref, h) {
                placed = Some(Placed { page, rect, forced: false, line: line_at(&tops, page, rect.y_mm) });
            }
        }
        if let Some(sd) = st.side.as_mut().filter(|_| placed.is_none()) {
            let span = pref.min(g.cols - sd.col);
            if span >= 2.min(pref) && sd.y + h <= g.bottom + 1e-9 {
                let rect = Rect { x_mm: g.col_x(g.cols - span), y_mm: sd.y, width_mm: g.span_w(span), height_mm: h };
                placed = Some(Placed { page: st.page, rect, forced: false, line: sd.line });
                sd.y += h + g.gutter;
                st.y = st.y.max(sd.y);
            }
        }
        if placed.is_none() && row.is_none() {
            if let Some((page, rect)) = table_slot(g, &busy, st.page + 1, pref, h) {
                placed = Some(Placed { page, rect, forced: false, line: line_at(&tops, page, rect.y_mm) });
            }
        }
        if placed.is_none() {
            let (mut col, mut y, mut rh) = row.unwrap_or((0, st.y, 0.0));
            if col + pref > g.cols {
                st.y = y + rh + g.gutter;
                (col, y, rh) = (0, st.y, 0.0);
            }
            if y + h > g.bottom + 1e-9 && !(col == 0 && st.empty()) {
                st.new_page();
                (col, y, rh) = (0, st.y, 0.0);
            }
            if col == 0 {
                st.side = None;
            }
            let forced = y + h > g.bottom + 1e-9;
            let rect = Rect { x_mm: g.col_x(col), y_mm: y, width_mm: g.span_w(pref), height_mm: h };
            placed = Some(Placed { page: st.page, rect, forced, line: st.line });
            row = Some((col + pref, y, rh.max(h)));
        }
        let pl = placed.unwrap();
        busy.push((pl.page, pl.rect));
        out.tables.push(pl);
    }
    if let Some((col, y, rh)) = row {
        st.y = st.y.max(y + rh + g.gutter);
        st.side = Some(Side { line: st.line, col, y });
        tops.push((st.page, y, st.line));
        st.line += 1;
    }
    if image && out.image.is_none() && g.cols >= 2 {
        // Grösste freie Fläche des Blatts (zuletzt, damit der Rest an das Bild geht), sonst ein eigenes Blatt.
        out.image = Some(match image_slot(g, &busy, st.page + 1, min_image_h) {
            Some((page, rect)) => Placed { page, rect, forced: false, line: line_at(&tops, page, rect.y_mm) },
            None => {
                st.new_page();
                Placed { page: st.page, rect: Rect { x_mm: g.left, y_mm: g.top, width_mm: g.span_w(g.cols), height_mm: g.height() }, forced: false, line: st.line }
            }
        });
    }
    // [285] Bleibt am Blatt viel Platz übrig, wächst das Bild neben der Situation in die Höhe (die Zeilen darunter rücken nach);
    // zwischen den Zeilen bleibt mindestens ein Abstand, der Rest wird unten gleichmässig verteilt.
    if let (Some(free), Some(img)) = (beside_free, out.image) {
        let page = img.page;
        let lines = out.items.iter().chain(&out.tables).filter(|p| p.page == page).map(|p| p.line).chain(std::iter::once(img.line)).collect::<std::collections::BTreeSet<_>>().len() as f64;
        let bottom = out.items.iter().filter(|p| p.page == page).map(|p| p.rect.y_mm + p.rect.height_mm + g.band).chain(out.tables.iter().filter(|p| p.page == page).map(|p| p.rect.y_mm + p.rect.height_mm)).fold(img.rect.y_mm + img.rect.height_mm, f64::max);
        let pf = out.items.iter().chain(&out.tables).any(|p| p.page == page && p.forced);
        let slack = g.bottom - bottom - (lines + 1.0) * g.gutter;
        let grown = cap_image(Rect { height_mm: free.height_mm + slack.max(0.0), ..free }, true);
        let delta = (grown.height_mm - free.height_mm).max(0.0);
        if !pf && grown.height_mm > img.rect.height_mm + 1e-6 {
            for p in out.items.iter_mut().chain(out.tables.iter_mut()).filter(|p| p.page == page && p.line > img.line) {
                p.rect.y_mm += delta;
            }
            out.image = Some(Placed { rect: grown, ..img });
        }
    }
    out.pages = out.items.iter().chain(&out.tables).chain(&out.image).map(|p| p.page + 1).max().unwrap_or(1);
    spread(g, &mut out);
    out
}

/// [285] Bild-Rahmen in der freien Fläche: sie darf ganz gefüllt werden, nur das Seitenverhältnis bleibt in 1 : 1.5 … 2 : 1 (sonst
/// schrumpft die lange Seite); `right`: rechtsbündig, sonst waagrecht zentriert; oben bündig.
fn cap_image(free: Rect, right: bool) -> Rect {
    let h = free.height_mm.min(free.width_mm * 1.5);
    let w = free.width_mm.min(h * 2.0);
    let x = if right { free.x_mm + free.width_mm - w } else { free.x_mm + (free.width_mm - w) / 2.0 };
    Rect { x_mm: x, y_mm: free.y_mm, width_mm: w, height_mm: h }
}

/// [266] Freien Platz am Fuss jedes Blatts gleichmässig verteilen: vor der ersten, zwischen allen Zeilen und nach der letzten
/// entsteht gleich viel Weissraum (je Lücke höchstens 12 % der Satzspiegelhöhe; der Rest bleibt unten). Elemente derselben Zeile
/// (Tabellen und Bild neben einem Rahmen) rücken gemeinsam.
fn spread(g: &Grid, out: &mut Result) {
    for page in 0..out.pages {
        let on = |p: &&mut Placed| p.page == page && !p.forced;
        let mut lines: Vec<usize> = out.items.iter().chain(&out.tables).chain(out.image.iter()).filter(|p| p.page == page).map(|p| p.line).collect();
        lines.sort_unstable();
        lines.dedup();
        let bottom = out.items.iter().filter(|p| p.page == page).map(|p| p.rect.y_mm + p.rect.height_mm + g.band).chain(out.tables.iter().chain(out.image.iter()).filter(|p| p.page == page).map(|p| p.rect.y_mm + p.rect.height_mm)).fold(g.top, f64::max);
        let left = g.bottom - bottom;
        let pf = out.items.iter().chain(&out.tables).chain(out.image.iter()).any(|p| p.page == page && p.forced);
        if lines.is_empty() || left <= 1e-6 || pf {
            continue;
        }
        let gap = (left / (lines.len() as f64 + 1.0)).min(0.12 * g.height());
        let shift = |line: usize| gap * (lines.iter().position(|l| *l == line).unwrap_or(0) as f64 + 1.0);
        for p in out.items.iter_mut().chain(out.tables.iter_mut()).chain(out.image.iter_mut()).filter(|p| on(p)) {
            p.rect.y_mm += shift(p.line);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A1 quer, Plakat-Raster (Ränder 20, Kopfzeile bis 58): 6 Spalten.
    fn a1() -> Grid {
        Grid::new(841.0, 594.0, 20.0, 58.0, 6, 10.0, 8.0)
    }

    fn overlap(a: &Rect, b: &Rect) -> bool {
        a.x_mm < b.x_mm + b.width_mm - 1e-6 && b.x_mm < a.x_mm + a.width_mm - 1e-6 && a.y_mm < b.y_mm + b.height_mm - 1e-6 && b.y_mm < a.y_mm + a.height_mm - 1e-6
    }

    /// Alle belegten Rechtecke (Rahmen samt Titelband) je Blatt: im Satzspiegel, ohne Überlappung.
    fn check(g: &Grid, r: &Result) {
        let mut rects: Vec<(usize, Rect)> = r.items.iter().map(|p| (p.page, Rect { height_mm: p.rect.height_mm + g.band, ..p.rect })).collect();
        rects.extend(r.tables.iter().chain(&r.image).map(|p| (p.page, p.rect)));
        for (i, (pa, a)) in rects.iter().enumerate() {
            assert!(a.x_mm >= g.left - 1e-6 && a.x_mm + a.width_mm <= g.col_x(g.cols - 1) + g.col_w + 1e-6, "{a:?} seitlich");
            assert!(a.y_mm >= g.top - 1e-6 && a.y_mm + a.height_mm <= g.bottom + 1e-6, "{a:?} vertikal");
            for (pb, b) in &rects[i + 1..] {
                assert!(pa != pb || !overlap(a, b), "{a:?} überlappt {b:?}");
            }
        }
    }

    fn cells(n: usize, span: usize, w: f64, h: f64) -> Vec<Cell> {
        (0..n).map(|_| Cell { span, w, h }).collect()
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
        let c = Cell::sized(&g, 160.0, 120.0);
        assert_eq!((c.span, c.w), (2, 160.0));
        assert_eq!(Cell::sized(&g, 5000.0, 1.0).w, 801.0);
    }

    /// Strenge Zeilen: Situation (Bild daneben), darunter die Grundrisse, darunter Schnitte + Ansichten; Rahmen so breit wie der
    /// Inhalt, links an Spaltenkanten; jede Gruppe unter der vorigen; Tabellen rechts neben der letzten Zeile.
    #[test]
    fn strenge_zeilen_nach_gruppen() {
        let g = a1();
        let groups = vec![
            Group { cells: vec![Cell { span: 2, w: 200.0, h: 150.0 }], image_beside: true },
            Group { cells: cells(3, 2, 150.0, 100.0), image_beside: false },
            Group { cells: vec![Cell { span: 2, w: 140.0, h: 60.0 }, Cell { span: 2, w: 140.0, h: 60.0 }, Cell { span: 2, w: 140.0, h: 60.0 }, Cell { span: 2, w: 140.0, h: 60.0 }, Cell { span: 1, w: 90.0, h: 60.0 }], image_beside: false },
        ];
        let r = layout(&g, &groups, &[(3, 50.0), (3, 60.0)], true, 70.0);
        assert_eq!(r.pages, 1);
        check(&g, &r);
        let it = &r.items;
        // Bild neben der Situation, gleiche Oberkante, rechtsbündig im Rest der Breite.
        let img = r.image.expect("Bild");
        assert_eq!(img.rect.y_mm, it[0].rect.y_mm);
        assert!(img.rect.x_mm >= g.col_x(2) - 1e-9 && (img.rect.x_mm + img.rect.width_mm - (g.left + g.span_w(g.cols))).abs() < 1e-9);
        // Grundrisse: eine Zeile, gleiche Oberkante, unter der Situation, an Spaltenkanten, so breit wie der Inhalt.
        assert!(it[1..4].iter().all(|p| p.rect.y_mm == it[1].rect.y_mm && p.rect.width_mm == 150.0));
        assert_eq!(it[1..4].iter().map(|p| p.rect.x_mm).collect::<Vec<_>>(), vec![g.col_x(0), g.col_x(2), g.col_x(4)]);
        assert!(it[1].rect.y_mm >= it[0].rect.y_mm + 150.0 + g.band + g.gutter - 1e-9);
        // Schnitte/Ansichten: ausgeglichen 3 + 2, unter den Grundrissen.
        let ys: Vec<f64> = it[4..].iter().map(|p| p.rect.y_mm).collect();
        assert!(ys[0] == ys[1] && ys[1] == ys[2] && ys[3] == ys[4] && ys[3] > ys[0]);
        assert!(ys[0] >= it[1].rect.y_mm + 100.0 + g.band + g.gutter - 1e-9);
        // Tabellen rechts neben der letzten Zeile (3 Spalten frei), untereinander.
        assert_eq!(r.tables[0].rect.x_mm, g.col_x(3));
        assert_eq!(r.tables[0].rect.y_mm, ys[3]);
        assert!(r.tables[1].rect.y_mm > r.tables[0].rect.y_mm);
    }

    /// Vier Grundrisse à 2 Spalten auf 6 Spalten: 2 + 2 statt 3 + 1.
    #[test]
    fn ausgeglichene_zeilen() {
        let g = a1();
        let r = layout(&g, &[Group { cells: cells(4, 2, 160.0, 100.0), image_beside: false }], &[], false, 70.0);
        let lines: Vec<usize> = r.items.iter().map(|p| p.line).collect();
        assert_eq!(lines, vec![0, 0, 1, 1]);
        check(&g, &r);
    }

    /// Eine Gruppe, die auf dem angefangenen Blatt keinen Platz mehr hat, beginnt ganz auf dem nächsten (nicht zerrissen);
    /// Rahmen behalten ihre Grösse (kein kleinerer Massstab).
    #[test]
    fn gruppe_nicht_zerreissen() {
        let g = a1();
        let groups = vec![Group { cells: vec![Cell { span: 3, w: 380.0, h: 300.0 }], image_beside: false }, Group { cells: cells(6, 2, 200.0, 110.0), image_beside: false }];
        let r = layout(&g, &groups, &[(3, 60.0)], false, 70.0);
        assert_eq!(r.pages, 2);
        assert!(r.items[1..].iter().all(|p| p.page == 1 && p.rect.height_mm == 110.0 && !p.forced));
        check(&g, &r);
    }

    /// Mehr als ein Blatt einer Gruppe: sie bricht auf das nächste Blatt um.
    #[test]
    fn zweites_blatt_statt_verkleinern() {
        let g = a1();
        let r = layout(&g, &[Group { cells: cells(30, 2, 250.0, 110.0), image_beside: false }], &[(3, 60.0)], true, 70.0);
        assert!(r.pages >= 2);
        assert!(r.items.iter().all(|p| (p.rect.height_mm - 110.0).abs() < 1e-9 && !p.forced));
        check(&g, &r);
    }

    /// Ein Rahmen, der höher ist als das Blatt, wird erzwungen (kein Absturz) und gemeldet.
    #[test]
    fn zu_hoher_rahmen_wird_gemeldet() {
        let g = a1();
        let r = layout(&g, &[Group { cells: vec![Cell { span: 1, w: 100.0, h: 900.0 }], image_beside: false }], &[], false, 70.0);
        assert!(r.items[0].forced);
        assert_eq!(r.pages, 1);
    }

    /// Tabelle ohne Platz neben vollen Zeilen: eigenes Blatt.
    #[test]
    fn tabelle_ohne_platz_neues_blatt() {
        let g = a1();
        let r = layout(&g, &[Group { cells: vec![Cell { span: 6, w: 801.0, h: 440.0 }], image_beside: false }], &[(3, 80.0)], false, 70.0);
        assert_eq!(r.pages, 2);
        assert_eq!(r.tables[0].page, 1);
        check(&g, &r);
    }

    /// Ohne Situation: das Bild nimmt die grösste freie Fläche; nichts gewählt ⇒ ein leeres Blatt.
    #[test]
    fn bild_ohne_situation_und_leer() {
        let g = a1();
        let r = layout(&g, &[Group { cells: cells(2, 2, 200.0, 100.0), image_beside: false }], &[], true, 70.0);
        let img = r.image.expect("Bild");
        assert!(img.rect.width_mm >= g.span_w(2) - 1e-9 && img.rect.height_mm >= 70.0);
        check(&g, &r);
        let r = layout(&g, &[], &[], false, 70.0);
        assert_eq!((r.pages, r.items.len(), r.image.is_none()), (1, 0, true));
    }

    /// [285] Das Bild füllt die freie Fläche neben der Situation (nicht mehr auf die Planbreite gedeckelt), nur das Seitenverhältnis
    /// bleibt höchstens 2 : 1; es steht rechtsbündig.
    #[test]
    fn bild_fuellt_die_freie_flaeche() {
        let g = a1();
        let groups = vec![
            Group { cells: vec![Cell { span: 2, w: 200.0, h: 300.0 }], image_beside: true },
            Group { cells: cells(2, 1, 110.0, 100.0), image_beside: false },
        ];
        let r = layout(&g, &groups, &[], true, 70.0);
        let img = r.image.expect("Bild");
        assert!(img.rect.height_mm > 250.0 && img.rect.width_mm <= img.rect.height_mm * 2.0 + 1e-9 && img.rect.width_mm > 400.0, "{:?}", img.rect);
        assert!((img.rect.x_mm + img.rect.width_mm - (g.left + g.span_w(g.cols))).abs() < 1e-9, "rechtsbündig");
        check(&g, &r);
    }

    /// [285] Passen die Tabellen nicht neben die letzte Zeile, nehmen sie freien Platz neben der Situation (das Bild folgt danach)
    /// statt ein zweites Blatt zu füllen.
    #[test]
    fn tabellen_in_freier_flaeche_statt_zweites_blatt() {
        let g = a1();
        let groups = vec![
            Group { cells: vec![Cell { span: 2, w: 200.0, h: 150.0 }], image_beside: true },
            Group { cells: cells(3, 2, 220.0, 150.0), image_beside: false },
            Group { cells: cells(4, 2, 180.0, 60.0), image_beside: false },
        ];
        let r = layout(&g, &groups, &[(3, 40.0), (3, 70.0)], true, 70.0);
        assert_eq!(r.pages, 1, "{r:?}");
        check(&g, &r);
        assert!(r.items.iter().chain(&r.tables).chain(&r.image).all(|p| !p.forced));
    }

    /// [296] Die letzte Zeile liegt auf dem zweiten Blatt, oben sind Spalten frei: die Tabellen füllen zuerst diese freien Spalten.
    #[test]
    fn tabellen_fuellen_freie_spalten_frueherer_blaetter() {
        let g = a1();
        let groups = vec![Group { cells: vec![Cell { span: 2, w: 200.0, h: 150.0 }], image_beside: false }, Group { cells: vec![Cell { span: 4, w: 500.0, h: 400.0 }], image_beside: false }];
        let r = layout(&g, &groups, &[(3, 60.0), (3, 60.0)], false, 70.0);
        assert_eq!(r.items[1].page, 1, "{r:?}");
        assert!(r.tables.iter().all(|t| t.page == 0), "{r:?}");
        check(&g, &r);
    }

    /// [266] Freier Platz am Fuss wird gleichmässig auf die Zeilen verteilt (oben, zwischen, unten gleiche Lücke); Elemente
    /// derselben Zeile rücken gemeinsam, nichts verlässt den Satzspiegel, volle Blätter bleiben unverändert.
    #[test]
    fn leerer_fuss_wird_gleichmaessig_verteilt() {
        let g = a1();
        let groups = vec![Group { cells: cells(2, 2, 160.0, 100.0), image_beside: true }, Group { cells: cells(2, 2, 160.0, 80.0), image_beside: false }];
        let r = layout(&g, &groups, &[(2, 40.0)], false, 70.0);
        check(&g, &r);
        let lines: Vec<(f64, f64)> = [0usize, 1].iter().map(|l| {
            let top = r.items.iter().filter(|p| p.line == *l).map(|p| p.rect.y_mm).fold(f64::MAX, f64::min);
            let bot = r.items.iter().filter(|p| p.line == *l).map(|p| p.rect.y_mm + p.rect.height_mm + g.band).fold(0.0, f64::max);
            (top, bot)
        }).collect();
        let (gap_top, gap_mid) = (lines[0].0 - g.top, lines[1].0 - lines[0].1);
        assert!(gap_top > g.gutter && gap_mid >= gap_top - 1e-9, "oben {gap_top}, Mitte {gap_mid}");
        // Der Inhalt liegt weiter unten als ohne Verteilung (vorher Oberkante der zweiten Zeile bei 58 + 108 + 10) und im Satzspiegel.
        assert!(lines[1].0 > g.top + 108.0 + g.gutter + 1.0 && lines[1].1 <= g.bottom + 1e-9, "{lines:?}");
        // Tabelle neben der letzten Zeile rückt mit ihr.
        assert!((r.tables[0].rect.y_mm - lines[1].0).abs() < 1e-9);
        // Ein volles Blatt ändert sich nicht.
        let full = layout(&g, &[Group { cells: vec![Cell { span: 6, w: 801.0, h: g.height() - g.band }], image_beside: false }], &[], false, 70.0);
        assert_eq!(full.items[0].rect.y_mm, g.top);
    }
}
