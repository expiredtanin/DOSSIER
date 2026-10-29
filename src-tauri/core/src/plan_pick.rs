//! Auswahl/Picken im Grundriss ([K3d], früher `segmentIndex.ts`, `ownerIndex.ts` und die
//! Schleifen über `plan.primitives` in `PlanView.tsx`): ein räumlicher Index über einem
//! zusammengesetzten Plan ([`crate::plan_parts`]), den TS nur noch abfragt. Ergebnisse sind
//! Indizes in `plan.primitives`.
//!
//! - 2D-Zeichenlinien (`line` mit nicht-leerer `drawingId`): gleichförmiges Raster wie die frühere
//!   TS-Fassung (gleiche Zellgrösse, gleiche Reihenfolge → gleiche Treffer, auch bei Gleichstand):
//!   nächstes Segment bzw. alle Segmente im Umkreis.
//! - Polygone (Punkt-in-Polygon wie `pointInPolygon`): oberstes bzw. unterstes Polygon unter dem
//!   Punkt, wahlweise nur mit einer bestimmten Pick-Id (Raum, Dach, Treppe, …), oder alle.
//! - Symbol-Linien und -Bögen mit Öffnungs-/Treppen-Id: nächste in Bildschirm-Pixeln (dieselbe
//!   Abbildung Modell → Client wie `toScreen` + `vbToClient` in PlanView).
//! - Kreise/Bögen der 2D-Zeichnung: Abstand zum Ring wie `distToDrawingRing`.
//! - Besitzer: alle Primitive einer Id (wie `ownedBy`).
//!
//! Pick-Arten (Bit `1 << art`): 1 wall · 2 drawing · 3 ceiling · 4 opening · 5 stair · 6 room ·
//! 7 extrudedSolid · 8 contextObject · 9 column · 10 roof · 11 sectionLine. Das Bit einer Art ist
//! gesetzt, wenn ihre Id nicht leer ist (TS: `p.roomId && …`).

use crate::jsmath::hypot;
use crate::jsnum;
use crate::plan_buf::{whole, View, F_IDS, T_ARC, T_CIRCLE, T_DRAWING_ARC, T_DRAWING_TEXT, T_IMAGE, T_LINE, T_POLYGON, T_TEXT_PATH};
use crate::plan_parts::pick_ids;
use std::cell::OnceCell;
use std::collections::HashMap;
use std::rc::Rc;

const TARGET_PER_CELL: f64 = 8.0;
const MAX_CELLS: f64 = 4_000_000.0;
const MAX_CELLS_PER_ITEM: f64 = 1024.0;

/// Gleichförmiges Raster (CSR) über Bounding-Boxen; Einträge sind Index-Werte.
#[derive(Default)]
pub(crate) struct Grid {
    min_x: f64,
    min_y: f64,
    cell: f64,
    cols: f64,
    rows: f64,
    cell_start: Vec<u32>,
    items: Vec<u32>,
    /// Einträge mit zu vielen Zellen — immer geprüft.
    long: Vec<u32>,
}

impl Grid {
    /// Wie `buildSegmentIndex`: `boxes` = (Wert, minX, minY, maxX, maxY) in Einfüge-Reihenfolge.
    fn build(boxes: &[(u32, f64, f64, f64, f64)], n: usize, min_x: f64, min_y: f64, max_x: f64, max_y: f64) -> Grid {
        let w = jsnum::max(max_x - min_x, 1e-6);
        let h = jsnum::max(max_y - min_y, 1e-6);
        let cell_count = jsnum::min(MAX_CELLS, jsnum::max(1.0, (n as f64 / TARGET_PER_CELL).ceil()));
        let mut cell = ((w * h) / cell_count).sqrt();
        if !(cell > 0.0) {
            cell = jsnum::max(w, h);
        }
        let cols = jsnum::max(1.0, (w / cell).ceil());
        let rows = jsnum::max(1.0, (h / cell).ceil());
        let mut g = Grid { min_x, min_y, cell, cols, rows, ..Default::default() };
        let total = cols * rows;
        if !(total.is_finite() && total <= 1e8) {
            // Entartet (NaN/riesig): alles in die immer geprüfte Liste.
            g.cols = 1.0;
            g.rows = 1.0;
            g.cell_start = vec![0, 0];
            g.long = boxes.iter().map(|b| b.0).collect();
            return g;
        }
        let n_cells = total as usize;
        let cx = |x: f64| jsnum::min(cols - 1.0, jsnum::max(0.0, ((x - min_x) / cell).floor()));
        let cy = |y: f64| jsnum::min(rows - 1.0, jsnum::max(0.0, ((y - min_y) / cell).floor()));
        let range = |b: &(u32, f64, f64, f64, f64)| (cx(b.1), cx(b.3), cy(b.2), cy(b.4));
        let mut counts = vec![0u32; n_cells + 1];
        let mut is_long = vec![false; boxes.len()];
        for (k, b) in boxes.iter().enumerate() {
            let (x0, x1, y0, y1) = range(b);
            if (x1 - x0 + 1.0) * (y1 - y0 + 1.0) > MAX_CELLS_PER_ITEM {
                g.long.push(b.0);
                is_long[k] = true;
                continue;
            }
            let mut y = y0;
            while y <= y1 {
                let mut x = x0;
                while x <= x1 {
                    counts[(y * cols + x) as usize + 1] += 1;
                    x += 1.0;
                }
                y += 1.0;
            }
        }
        for c in 1..counts.len() {
            counts[c] += counts[c - 1];
        }
        let mut fill: Vec<u32> = counts[..n_cells].to_vec();
        let mut items = vec![0u32; counts[n_cells] as usize];
        for (k, b) in boxes.iter().enumerate() {
            if is_long[k] {
                continue;
            }
            let (x0, x1, y0, y1) = range(b);
            let mut y = y0;
            while y <= y1 {
                let mut x = x0;
                while x <= x1 {
                    let c = (y * cols + x) as usize;
                    items[fill[c] as usize] = b.0;
                    fill[c] += 1;
                    x += 1.0;
                }
                y += 1.0;
            }
        }
        g.cell_start = counts;
        g.items = items;
        g
    }

    /// Alle Einträge der Zellen um `(x, y)` im Umkreis `r` (zuerst `long`), wie `nearestSegment`.
    fn visit(&self, x: f64, y: f64, r: f64, mut f: impl FnMut(u32)) {
        for &i in &self.long {
            f(i);
        }
        if self.items.is_empty() {
            return;
        }
        let x0 = ((x - r - self.min_x) / self.cell).floor();
        let x1 = ((x + r - self.min_x) / self.cell).floor();
        let y0 = ((y - r - self.min_y) / self.cell).floor();
        let y1 = ((y + r - self.min_y) / self.cell).floor();
        if x1 < 0.0 || y1 < 0.0 || x0 >= self.cols || y0 >= self.rows {
            return;
        }
        let mut yy = jsnum::max(0.0, y0);
        let ye = jsnum::min(self.rows - 1.0, y1);
        while yy <= ye {
            let mut xx = jsnum::max(0.0, x0);
            let xe = jsnum::min(self.cols - 1.0, x1);
            while xx <= xe {
                let c = (yy * self.cols + xx) as usize;
                for k in self.cell_start[c]..self.cell_start[c + 1] {
                    f(self.items[k as usize]);
                }
                xx += 1.0;
            }
            yy += 1.0;
        }
    }
}

/// Raster über Bounding-Boxen (Einträge mit nicht endlicher Box werden immer geprüft) — nur
/// Vorauswahl, die genaue Prüfung macht der Aufrufer in Index-Reihenfolge.
#[derive(Default)]
pub(crate) struct BoxIndex {
    grid: Option<Grid>,
    wild: Vec<u32>,
}

impl BoxIndex {
    pub(crate) fn build(boxes: Vec<(u32, f64, f64, f64, f64)>) -> BoxIndex {
        let mut wild = Vec::new();
        let mut fin = Vec::with_capacity(boxes.len());
        let (mut a, mut b, mut c, mut d) = (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
        for e in boxes {
            if e.1.is_finite() && e.2.is_finite() && e.3.is_finite() && e.4.is_finite() {
                a = a.min(e.1);
                b = b.min(e.2);
                c = c.max(e.3);
                d = d.max(e.4);
                fin.push(e);
            } else if !(e.3 < e.1 || e.4 < e.2) {
                // NaN/unendlich (nicht leer): immer prüfen.
                wild.push(e.0);
            }
        }
        let grid = (!fin.is_empty()).then(|| Grid::build(&fin, fin.len(), a, b, c, d));
        BoxIndex { grid, wild }
    }

    /// Einträge, deren Box den Kreis `(x, y, r)` berühren kann — aufsteigend, ohne Doppel.
    pub(crate) fn candidates(&self, x: f64, y: f64, r: f64) -> Vec<u32> {
        let mut out = self.wild.clone();
        if let Some(g) = &self.grid {
            g.visit(x, y, r, |k| out.push(k));
        }
        out.sort_unstable();
        out.dedup();
        out
    }
}

/// Rand für Rundung bei Box-Tests: relativ zur Koordinatengrösse.
pub(crate) fn pad(v: &[f64]) -> f64 {
    1e-9 * (1.0 + v.iter().fold(0.0f64, |m, x| m.max(x.abs())))
}

/// `pointSegDist` (Modell-Meter).
pub fn point_seg_dist(px: f64, py: f64, ax: f64, ay: f64, bx: f64, by: f64) -> f64 {
    let dx = bx - ax;
    let dy = by - ay;
    let len2 = dx * dx + dy * dy;
    let mut t = if len2 > 0.0 { ((px - ax) * dx + (py - ay) * dy) / len2 } else { 0.0 };
    t = jsnum::max(0.0, jsnum::min(1.0, t));
    hypot(&[px - (ax + t * dx), py - (ay + t * dy)])
}

/// `pointSegDistPx` (Client-Pixel).
pub fn point_seg_dist_px(px: f64, py: f64, ax: f64, ay: f64, bx: f64, by: f64) -> f64 {
    let dx = bx - ax;
    let dy = by - ay;
    let len2 = dx * dx + dy * dy;
    if len2 < 1e-9 {
        return hypot(&[px - ax, py - ay]);
    }
    let mut t = ((px - ax) * dx + (py - ay) * dy) / len2;
    t = jsnum::max(0.0, jsnum::min(1.0, t));
    hypot(&[px - (ax + dx * t), py - (ay + dy * t)])
}

/// `pointInPolygon` (gerade/ungerade, wie `planView/geometry.ts`).
pub fn point_in_polygon(x: f64, y: f64, poly: &[f64]) -> bool {
    let n = poly.len() / 2;
    let mut inside = false;
    let mut j = n.wrapping_sub(1);
    for i in 0..n {
        let (xi, yi, xj, yj) = (poly[2 * i], poly[2 * i + 1], poly[2 * j], poly[2 * j + 1]);
        if (yi > y) != (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi {
            inside = !inside;
        }
        j = i;
    }
    inside
}

/// Abbildung Modell → Client-Pixel: `toScreen` (·90, Y gespiegelt), dann `vbToClient`.
#[derive(Clone, Copy)]
pub struct ClientMap {
    /// `left + offX`
    pub left: f64,
    /// `top + offY`
    pub top: f64,
    pub view_x: f64,
    pub view_y: f64,
    pub scale: f64,
}

impl ClientMap {
    #[inline]
    fn at(&self, x: f64, y: f64) -> (f64, f64) {
        let vx = x * 90.0;
        let vy = -y * 90.0;
        (self.left + (vx - self.view_x) * self.scale, self.top + (vy - self.view_y) * self.scale)
    }
}

struct Sym {
    gi: u32,
    mask: u16,
    arc: bool,
    seg: [f64; 4],
}

struct Ring {
    gi: u32,
    arc: bool,
    cx: f64,
    cy: f64,
    r: f64,
    a0: f64,
    a1: f64,
    filled: bool,
}

struct PolyEntry {
    gi: u32,
    mask: u16,
}

/// Index über einen zusammengesetzten Plan (besitzt seine Puffer).
pub struct PickIndex {
    bufs: Vec<Rc<[u8]>>,
    /// Abschnitte: (Puffer, von, erster Index im Plan).
    parts: Vec<(usize, usize, usize)>,
    count: usize,
    segs: Option<Grid>,
    polys: Vec<PolyEntry>,
    poly_grid: Option<Grid>,
    /// Polygone mit nicht endlichem Ausmass (immer geprüft).
    poly_wild: Vec<u32>,
    /// Symbol-Linien/-Bögen mit Pick-Id (Bogen: Sehne `from → to`).
    sym: Vec<Sym>,
    sym_ix: BoxIndex,
    /// Kreise/Bögen der 2D-Zeichnung (nicht-leere `drawingId`).
    rings: Vec<Ring>,
    ring_ix: BoxIndex,
    /// (Art, Id) → Indizes aufsteigend.
    owners: HashMap<(u32, u32), Vec<u32>>,
    interned: HashMap<String, u32>,
    /// Einträge mit nicht-leerer `drawingId` (Linie, Polygon, Kreis, Bogen, Text, Textpfad, Bild):
    /// (Index, Typ, Id-Nummer) in Plan-Reihenfolge — Rahmen-Auswahl und Text-/Bild-Treffer.
    draw_items: Vec<(u32, u32, u32)>,
    /// Rahmen von `drawingText`/`drawingImage` mit `drawingId` (aus dem Text-JSON, bei Bedarf).
    text_boxes: OnceCell<Vec<TextBox>>,
}

/// Rahmen eines Einzeltexts (wie die Einzelklick-Box in PlanView) bzw. eines Bilds.
#[derive(Clone, Copy)]
struct TextBox {
    gi: u32,
    image: bool,
    min_x: f64,
    min_y: f64,
    max_x: f64,
    max_y: f64,
}

/// Achsenparalleles Rechteck (Modell-Meter) der Rahmen-Auswahl.
#[derive(Clone, Copy)]
pub struct Rect {
    pub min_x: f64,
    pub min_y: f64,
    pub max_x: f64,
    pub max_y: f64,
}

/// Bounding-Box, NaN ausgelassen (wie `f64::min`).
fn bbox(pts: &[f64]) -> (f64, f64, f64, f64) {
    let (mut a, mut b, mut c, mut d) = (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
    for q in pts.chunks_exact(2) {
        a = a.min(q[0]);
        b = b.min(q[1]);
        c = c.max(q[0]);
        d = d.max(q[1]);
    }
    (a, b, c, d)
}

impl PickIndex {
    /// Index bauen; `segs` = `[Puffer-Nr, von, bis, …]`, `bufs` = (Nr, Bytes). `None` bei Unsinn.
    pub fn build(segs: &[f64], bufs: Vec<(u32, Rc<[u8]>)>) -> Option<PickIndex> {
        if segs.len() % 3 != 0 {
            return None;
        }
        let mut ix = PickIndex {
            bufs: bufs.iter().map(|b| b.1.clone()).collect(),
            parts: Vec::new(),
            count: 0,
            segs: None,
            polys: Vec::new(),
            poly_grid: None,
            poly_wild: Vec::new(),
            sym: Vec::new(),
            sym_ix: BoxIndex::default(),
            rings: Vec::new(),
            ring_ix: BoxIndex::default(),
            owners: HashMap::new(),
            interned: HashMap::new(),
            draw_items: Vec::new(),
            text_boxes: OnceCell::new(),
        };
        // Segment-Raster wie `buildSegmentIndex` (Ausmass mit Math.min/max, NaN steckt an).
        let mut seg_boxes: Vec<(u32, f64, f64, f64, f64)> = Vec::new();
        let (mut sminx, mut sminy, mut smaxx, mut smaxy) = (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
        let mut poly_boxes: Vec<(u32, f64, f64, f64, f64)> = Vec::new();
        let (mut pminx, mut pminy, mut pmaxx, mut pmaxy) = (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
        let mut gi = 0usize;
        for s in segs.chunks_exact(3) {
            let nr = whole(s[0])? as u32;
            let bi = bufs.iter().position(|b| b.0 == nr)?;
            let (from, to) = (whole(s[1])?, whole(s[2])?);
            let view = View::parse(&bufs[bi].1)?;
            if from > to || to > view.len() {
                return None;
            }
            ix.parts.push((bi, from, gi));
            // String-Index → (Id-Nummer, nicht leer); einmal je Abschnitt.
            let mut strs: HashMap<i64, (u32, bool)> = HashMap::new();
            for i in from..to {
                let g = gi as u32;
                gi += 1;
                let at = view.rec_at(i)?;
                let tag = whole(view.word(at)?)? as u32;
                let flags = whole(view.word(at + 1)?)? as u32;
                let pk = whole(view.word(at + 2)?)? as u32;
                // Pick-Ids: (Art, String-Index).
                let ids: Vec<(u32, f64)> = if flags & F_IDS != 0 {
                    pick_ids(&view, &view.rec(i)?)?
                } else if pk > 0 {
                    vec![(pk, view.word(at + 3)?)]
                } else {
                    Vec::new()
                };
                let mut mask: u16 = 0;
                let mut drawing: Option<u32> = None;
                let mut owned: Vec<(u32, u32)> = Vec::with_capacity(ids.len());
                for &(kind, si) in &ids {
                    let key = si as i64;
                    let (id, non_empty) = match strs.get(&key) {
                        Some(&v) => v,
                        None => {
                            let text = view.string(whole(si)?)?;
                            let ne = !text.is_empty();
                            let n = ix.interned.len() as u32;
                            let id = *ix.interned.entry(text).or_insert(n);
                            strs.insert(key, (id, ne));
                            (id, ne)
                        }
                    };
                    if non_empty {
                        mask |= 1 << kind;
                    }
                    if kind == 2 {
                        drawing = Some(id);
                    }
                    owned.push((kind, id));
                }
                // Besitzer (wie `buildOwnerIndex`: mit drawingId nur diese).
                match drawing {
                    Some(id) => ix.owners.entry((2, id)).or_default().push(g),
                    None => {
                        for (kind, id) in owned {
                            ix.owners.entry((kind, id)).or_default().push(g);
                        }
                    }
                }
                if let Some(id) = drawing {
                    if mask & (1 << 2) != 0 && matches!(tag, T_LINE | T_POLYGON | T_CIRCLE | T_DRAWING_ARC | T_DRAWING_TEXT | T_TEXT_PATH | T_IMAGE) {
                        ix.draw_items.push((g, tag, id));
                    }
                }
                let f = |k: usize| view.word(at + 4 + k);
                match tag {
                    T_LINE => {
                        if mask & (1 << 2) != 0 {
                            let (ax, ay, bx, by) = (f(4)?, f(5)?, f(6)?, f(7)?);
                            sminx = jsnum::min(sminx, jsnum::min(ax, bx));
                            smaxx = jsnum::max(smaxx, jsnum::max(ax, bx));
                            sminy = jsnum::min(sminy, jsnum::min(ay, by));
                            smaxy = jsnum::max(smaxy, jsnum::max(ay, by));
                            seg_boxes.push((g, jsnum::min(ax, bx), jsnum::min(ay, by), jsnum::max(ax, bx), jsnum::max(ay, by)));
                        }
                        let m = mask & ((1 << 4) | (1 << 5));
                        if m != 0 {
                            ix.sym.push(Sym { gi: g, mask: m, arc: false, seg: [f(4)?, f(5)?, f(6)?, f(7)?] });
                        }
                    }
                    T_ARC => {
                        let m = mask & ((1 << 4) | (1 << 5));
                        if m != 0 {
                            ix.sym.push(Sym { gi: g, mask: m, arc: true, seg: [f(6)?, f(7)?, f(8)?, f(9)?] });
                        }
                    }
                    T_CIRCLE => {
                        if mask & (1 << 2) != 0 {
                            // `fill !== "none"` (fehlende Füllung zählt als gefüllt, wie in TS).
                            let fi = f(0)?;
                            let filled = !(fi >= 0.0 && view.string(whole(fi)?)? == "none");
                            ix.rings.push(Ring { gi: g, arc: false, cx: f(4)?, cy: f(5)?, r: f(6)?, a0: 0.0, a1: 0.0, filled });
                        }
                    }
                    T_DRAWING_ARC => {
                        if mask & (1 << 2) != 0 {
                            ix.rings.push(Ring { gi: g, arc: true, cx: f(3)?, cy: f(4)?, r: f(5)?, a0: f(6)?, a1: f(7)?, filled: false });
                        }
                    }
                    T_POLYGON => {
                        let pts = view.pool(whole(f(5)?)?, whole(f(6)?)?.checked_mul(2)?)?;
                        let (a, b, c, d) = bbox(&pts);
                        ix.polys.push(PolyEntry { gi: g, mask });
                        let k = (ix.polys.len() - 1) as u32;
                        if a.is_finite() && b.is_finite() && c.is_finite() && d.is_finite() {
                            pminx = pminx.min(a);
                            pminy = pminy.min(b);
                            pmaxx = pmaxx.max(c);
                            pmaxy = pmaxy.max(d);
                            // Etwas Rand: Punkt-in-Polygon rechnet mit Rundung.
                            let e = 1e-9 * (1.0 + a.abs().max(b.abs()).max(c.abs()).max(d.abs()));
                            poly_boxes.push((k, a - e, b - e, c + e, d + e));
                        } else if c >= a && d >= b {
                            ix.poly_wild.push(k);
                        }
                    }
                    _ => {}
                }
            }
        }
        ix.count = gi;
        if !seg_boxes.is_empty() {
            ix.segs = Some(Grid::build(&seg_boxes, seg_boxes.len(), sminx, sminy, smaxx, smaxy));
        }
        if !poly_boxes.is_empty() {
            ix.poly_grid = Some(Grid::build(&poly_boxes, poly_boxes.len(), pminx, pminy, pmaxx, pmaxy));
        }
        ix.sym_ix = BoxIndex::build(
            ix.sym
                .iter()
                .enumerate()
                .map(|(k, s)| {
                    let [ax, ay, bx, by] = s.seg;
                    let e = pad(&s.seg);
                    (k as u32, ax.min(bx) - e, ay.min(by) - e, ax.max(bx) + e, ay.max(by) + e)
                })
                .collect(),
        );
        ix.ring_ix = BoxIndex::build(
            ix.rings
                .iter()
                .enumerate()
                .map(|(k, g)| {
                    let r = g.r.abs();
                    let e = pad(&[g.cx, g.cy, r]);
                    (k as u32, g.cx - r - e, g.cy - r - e, g.cx + r + e, g.cy + r + e)
                })
                .collect(),
        );
        Some(ix)
    }

    pub fn len(&self) -> usize {
        self.count
    }

    pub fn is_empty(&self) -> bool {
        self.count == 0
    }

    /// Puffer und Eintrag zu einem Plan-Index.
    fn locate(&self, gi: u32) -> Option<(View<'_>, usize)> {
        let gi = gi as usize;
        let p = match self.parts.binary_search_by(|e| e.2.cmp(&gi)) {
            Ok(k) => {
                // Leere Abschnitte überspringen: der letzte mit diesem Start.
                let mut k = k;
                while k + 1 < self.parts.len() && self.parts[k + 1].2 == gi {
                    k += 1;
                }
                k
            }
            Err(k) => k.checked_sub(1)?,
        };
        let (bi, from, start) = self.parts[p];
        Some((View::parse(&self.bufs[bi])?, from + gi - start))
    }

    /// Feste Felder ab `k` eines Eintrags.
    fn fields<const N: usize>(&self, gi: u32, k: usize) -> Option<[f64; N]> {
        let (v, i) = self.locate(gi)?;
        let at = v.rec_at(i)? + 4 + k;
        let mut out = [0.0; N];
        for (j, o) in out.iter_mut().enumerate() {
            *o = v.word(at + j)?;
        }
        Some(out)
    }

    fn line(&self, gi: u32) -> Option<[f64; 4]> {
        self.fields::<4>(gi, 4)
    }

    fn polygon_pts(&self, gi: u32) -> Option<Vec<f64>> {
        let (v, i) = self.locate(gi)?;
        let at = v.rec_at(i)? + 4;
        v.pool(whole(v.word(at + 5)?)?, whole(v.word(at + 6)?)?.checked_mul(2)?)
    }

    /// Nächstes Segment einer 2D-Zeichnung zu `(x, y)` mit Abstand < `max_dist` (wie `nearestSegment`).
    pub fn nearest_segment(&self, x: f64, y: f64, max_dist: f64) -> Option<(u32, f64)> {
        let g = self.segs.as_ref()?;
        let mut best = None;
        let mut best_d = max_dist;
        g.visit(x, y, max_dist, |i| {
            if let Some([ax, ay, bx, by]) = self.line(i) {
                let d = point_seg_dist(x, y, ax, ay, bx, by);
                if d < best_d {
                    best_d = d;
                    best = Some(i);
                }
            }
        });
        best.map(|i| (i, best_d))
    }

    /// Alle Segmente mit Abstand < `max_dist`, nächste zuerst (wie `segmentsNear`).
    pub fn segments_near(&self, x: f64, y: f64, max_dist: f64) -> Vec<(u32, f64)> {
        let Some(g) = self.segs.as_ref() else { return Vec::new() };
        let mut found: Vec<(u32, f64)> = Vec::new();
        let mut pos: HashMap<u32, usize> = HashMap::new();
        g.visit(x, y, max_dist, |i| {
            if let Some([ax, ay, bx, by]) = self.line(i) {
                let d = point_seg_dist(x, y, ax, ay, bx, by);
                if d < max_dist {
                    match pos.get(&i) {
                        Some(&k) => found[k].1 = d,
                        None => {
                            pos.insert(i, found.len());
                            found.push((i, d));
                        }
                    }
                }
            }
        });
        // Stabil nach Abstand (Gleichstand: Einfüge-Reihenfolge, wie `Array.sort`).
        found.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));
        found
    }

    /// Polygone, die `(x, y)` enthalten, mit Pick-Maske (0 = alle Polygone), absteigend nach Index.
    pub fn polygons_at(&self, x: f64, y: f64, mask: u16) -> Vec<u32> {
        let mut cand: Vec<u32> = self.poly_wild.clone();
        if let Some(g) = &self.poly_grid {
            g.visit(x, y, 0.0, |k| cand.push(k));
        }
        cand.sort_unstable();
        cand.dedup();
        let mut out: Vec<u32> = Vec::new();
        for k in cand {
            let p = &self.polys[k as usize];
            if mask != 0 && p.mask & mask == 0 {
                continue;
            }
            if let Some(pts) = self.polygon_pts(p.gi) {
                if point_in_polygon(x, y, &pts) {
                    out.push(p.gi);
                }
            }
        }
        out.sort_unstable_by(|a, b| b.cmp(a));
        out
    }

    /// Nächste Symbol-Linie (bzw. Bogen über die Sehne `from → to`) mit einer Pick-Id aus
    /// `line_mask` bzw. `arc_mask`, in Client-Pixeln < `max_px` (erster bei Gleichstand).
    pub fn nearest_symbol_px(&self, line_mask: u16, arc_mask: u16, map: ClientMap, cx: f64, cy: f64, max_px: f64) -> Option<u32> {
        let mut best = None;
        let mut best_d = max_px;
        // Vorauswahl im Modell: `max_px` Pixel = `max_px / (90·scale)` Meter (grosszügig).
        let cand: Vec<u32> = {
            let (mx, my) = ((cx - map.left) / map.scale / 90.0 + map.view_x / 90.0, -((cy - map.top) / map.scale + map.view_y) / 90.0);
            let r = max_px / (90.0 * map.scale.abs());
            if mx.is_finite() && my.is_finite() && r.is_finite() {
                self.sym_ix.candidates(mx, my, r * (1.0 + 1e-6) + pad(&[mx, my]))
            } else {
                (0..self.sym.len() as u32).collect()
            }
        };
        for k in cand {
            let s = &self.sym[k as usize];
            if s.mask & (if s.arc { arc_mask } else { line_mask }) == 0 {
                continue;
            }
            let gi = s.gi;
            let [ax, ay, bx, by] = s.seg;
            let (a0, a1) = map.at(ax, ay);
            let (b0, b1) = map.at(bx, by);
            let d = point_seg_dist_px(cx, cy, a0, a1, b0, b1);
            if d < best_d {
                best_d = d;
                best = Some(gi);
            }
        }
        best
    }

    /// Kreise/Bögen der 2D-Zeichnung mit Ring-Abstand < `tol_px` (Pixel), in Plan-Reihenfolge:
    /// (Index, Abstand in Pixeln) — wie `distToDrawingRing`.
    pub fn rings_near(&self, x: f64, y: f64, px_per_m: f64, tol_px: f64) -> Vec<(u32, f64)> {
        let tau = std::f64::consts::PI * 2.0;
        let mut out = Vec::new();
        // Vorauswahl: Ring-Abstand < `tol_px` Pixel liegt innerhalb der Kreis-Box + `tol_px/px_per_m`.
        let rq = tol_px / px_per_m;
        let cand: Vec<u32> = if rq.is_finite() && rq >= 0.0 && x.is_finite() && y.is_finite() {
            self.ring_ix.candidates(x, y, rq * (1.0 + 1e-6) + pad(&[x, y]))
        } else {
            (0..self.rings.len() as u32).collect()
        };
        for k in cand {
            let g = &self.rings[k as usize];
            let dist_c = hypot(&[x - g.cx, y - g.cy]);
            if g.arc {
                let mut sweep = (((g.a1 - g.a0) % tau) + tau) % tau;
                if sweep == 0.0 || sweep.is_nan() {
                    sweep = tau;
                }
                let ang = jsnum::atan2(y - g.cy, x - g.cx);
                let rel = (((ang - g.a0) % tau) + tau) % tau;
                let ang_tol = if dist_c > 1e-6 { tol_px / (px_per_m * jsnum::max(dist_c, 0.05)) } else { f64::INFINITY };
                if rel > sweep + ang_tol && tau - rel > ang_tol {
                    continue;
                }
            }
            let dm = if g.filled { jsnum::max(0.0, dist_c - g.r) } else { (dist_c - g.r).abs() };
            let d = dm * px_per_m;
            if d < tol_px {
                out.push((g.gi, d));
            }
        }
        out
    }

    /// Alle Primitive, deren Id der Art `kind` in `ids` liegt, aufsteigend (wie `ownedBy`).
    pub fn owned_by(&self, kind: u32, ids: &[&str]) -> Vec<u32> {
        let mut hits: Vec<u32> = Vec::new();
        for id in ids {
            if let Some(n) = self.interned.get(*id) {
                if let Some(l) = self.owners.get(&(kind, *n)) {
                    hits.extend_from_slice(l);
                }
            }
        }
        hits.sort_unstable();
        hits
    }

    /// Text-JSON eines Eintrags (Texte, Textpfade, Bilder); `None` ohne JSON oder kaputt.
    fn json(&self, gi: u32) -> Option<serde_json::Value> {
        let (v, i) = self.locate(gi)?;
        let si = v.word(v.rec_at(i)? + 4)?;
        serde_json::from_str(&v.string(whole(si)?)?).ok()
    }

    /// Text-/Bild-Rahmen (einmal je Index, beim ersten Gebrauch aus dem JSON gelesen).
    fn boxes(&self) -> &[TextBox] {
        self.text_boxes.get_or_init(|| {
            let mut out = Vec::new();
            for &(gi, tag, _) in &self.draw_items {
                if tag != T_DRAWING_TEXT && tag != T_IMAGE {
                    continue;
                }
                let Some(j) = self.json(gi) else { continue };
                let num = |o: &serde_json::Value, k: &str| o.get(k).and_then(|x| x.as_f64()).unwrap_or(f64::NAN);
                let pt = |k: &str| j.get(k).map_or((f64::NAN, f64::NAN), |o| (num(o, "x"), num(o, "y")));
                if tag == T_IMAGE {
                    let (a, b) = pt("min");
                    let (c, d) = pt("max");
                    out.push(TextBox { gi, image: true, min_x: a, min_y: b, max_x: c, max_y: d });
                } else {
                    let (ax, ay) = pt("at");
                    let h = num(&j, "heightM");
                    let len = j.get("text").and_then(|t| t.as_str()).map_or(0, |t| t.encode_utf16().count()) as f64;
                    // `p.wrapWidth && p.wrapWidth > 0` (fehlend/0/NaN → keine Spalte).
                    let wrap = j.get("wrapWidth").and_then(|x| x.as_f64()).filter(|w| *w > 0.0);
                    let single_w = jsnum::max(1.0, len) * h * 0.6;
                    let w = wrap.unwrap_or(single_w);
                    let lines = match wrap {
                        Some(ww) => jsnum::max(1.0, (single_w / ww).ceil()),
                        None => 1.0,
                    };
                    let pad = h * 0.6;
                    out.push(TextBox {
                        gi,
                        image: false,
                        min_x: ax - pad,
                        min_y: ay - lines * h * 1.25 - pad,
                        max_x: ax + w + pad,
                        max_y: ay + h * 0.4 + pad,
                    });
                }
            }
            out
        })
    }

    /// Erster `drawingText` (mit `drawingId`) in Plan-Reihenfolge, dessen Rahmen `(x, y)` enthält
    /// (wie `pickDrawingText` in PlanView).
    pub fn drawing_text_at(&self, x: f64, y: f64) -> Option<u32> {
        self.boxes().iter().find(|b| !b.image && x >= b.min_x && x <= b.max_x && y >= b.min_y && y <= b.max_y).map(|b| b.gi)
    }

    /// Oberstes (zuletzt gezeichnetes) Bild mit `drawingId`, das `(x, y)` enthält.
    pub fn drawing_image_at(&self, x: f64, y: f64) -> Option<u32> {
        self.boxes().iter().rev().find(|b| b.image && x >= b.min_x && x <= b.max_x && y >= b.min_y && y <= b.max_y).map(|b| b.gi)
    }

    /// Typ des ersten Eintrags einer Zeichnung, der eine Form benennt (Linie, Polygon, Text,
    /// Textpfad, Kreis, Bogen, Bild — wie `drawingLabel`); `None` ohne solchen.
    pub fn drawing_kind(&self, id: &str) -> Option<u32> {
        let n = self.interned.get(id)?;
        for &gi in self.owners.get(&(2, *n))? {
            let (v, i) = self.locate(gi)?;
            let tag = whole(v.word(v.rec_at(i)?)?)? as u32;
            if matches!(tag, T_LINE | T_POLYGON | T_DRAWING_TEXT | T_TEXT_PATH | T_CIRCLE | T_DRAWING_ARC | T_IMAGE) {
                return Some(tag);
            }
        }
        None
    }

    /// Rahmen-Auswahl über Polygone mit einer Id der Pick-Art `kind` (wie `marqueeHitByField`):
    /// `crossing` = ein Band berührt das Rechteck, sonst alle Bänder ganz darin. Ids in der
    /// Reihenfolge ihres ersten Auftretens.
    pub fn marquee_polygons(&self, kind: u32, rect: Rect, crossing: bool) -> Vec<String> {
        let mut order: Vec<(String, bool)> = Vec::new();
        let mut at: HashMap<String, usize> = HashMap::new();
        for p in &self.polys {
            let Some((v, i)) = self.locate(p.gi) else { continue };
            let Some(rec) = v.rec(i) else { continue };
            let Some(ids) = pick_ids(&v, &rec) else { continue };
            let Some(&(_, si)) = ids.iter().find(|e| e.0 == kind) else { continue };
            let Some(id) = whole(si).and_then(|k| v.string(k)) else { continue };
            let Some(pts) = self.polygon_pts(p.gi) else { continue };
            let hit = if crossing { poly_touches_rect(&pts, rect) } else { poly_enclosed_by_rect(&pts, rect) };
            match at.get(&id) {
                // crossing: irgendein Band; Fenster: alle Bänder.
                Some(&k) => order[k].1 = if crossing { order[k].1 || hit } else { order[k].1 && hit },
                None => {
                    at.insert(id.clone(), order.len());
                    order.push((id, hit));
                }
            }
        }
        order.into_iter().filter(|e| e.1).map(|e| e.0).collect()
    }

    /// Rahmen-Auswahl über 2D-Zeichnungen (wie `marqueeHitDrawings`): je Zeichnung alle Punkte
    /// (Linien-Enden, Polygon-Ecken, abgetastete Kreise/Bögen, Text-/Bild-Rahmen); `skip` =
    /// Zeichnungen, die der Aufrufer selbst prüft. Ids in der Reihenfolge ihres ersten Auftretens.
    pub fn marquee_drawings(&self, rect: Rect, crossing: bool, skip: &[&str]) -> Vec<String> {
        let skip_n: Vec<u32> = skip.iter().filter_map(|s| self.interned.get(*s).copied()).collect();
        let names: HashMap<u32, &str> = self.interned.iter().map(|(k, v)| (*v, k.as_str())).collect();
        let boxes: HashMap<u32, TextBox> = if self.draw_items.iter().any(|e| e.1 == T_DRAWING_TEXT || e.1 == T_IMAGE) {
            self.boxes().iter().map(|b| (b.gi, *b)).collect()
        } else {
            HashMap::new()
        };
        let mut order: Vec<(u32, Vec<f64>)> = Vec::new();
        let mut at: HashMap<u32, usize> = HashMap::new();
        for &(gi, tag, id) in &self.draw_items {
            if skip_n.contains(&id) {
                continue;
            }
            let pts: Vec<f64> = match tag {
                T_LINE => match self.line(gi) {
                    Some(l) => l.to_vec(),
                    None => continue,
                },
                T_POLYGON => match self.polygon_pts(gi) {
                    Some(p) => p,
                    None => continue,
                },
                T_CIRCLE => match self.fields::<3>(gi, 4) {
                    Some([cx, cy, r]) => ring_sample_points(cx, cy, r, None),
                    None => continue,
                },
                T_DRAWING_ARC => match self.fields::<5>(gi, 3) {
                    Some([cx, cy, r, a0, a1]) => ring_sample_points(cx, cy, r, Some((a0, a1))),
                    None => continue,
                },
                // Bild: min, (max.x, min.y), max, (min.x, max.y) — Text: dieselbe Umlaufrichtung.
                T_DRAWING_TEXT | T_IMAGE => match boxes.get(&gi) {
                    Some(b) => vec![b.min_x, b.min_y, b.max_x, b.min_y, b.max_x, b.max_y, b.min_x, b.max_y],
                    None => continue,
                },
                _ => continue,
            };
            match at.get(&id) {
                Some(&k) => order[k].1.extend_from_slice(&pts),
                None => {
                    at.insert(id, order.len());
                    order.push((id, pts));
                }
            }
        }
        order
            .into_iter()
            .filter(|(_, pts)| if crossing { poly_touches_rect(pts, rect) } else { poly_enclosed_by_rect(pts, rect) })
            .filter_map(|(id, _)| names.get(&id).map(|s| s.to_string()))
            .collect()
    }
}

/// Punkte auf einem Kreis-/Bogen-Ring (wie `ringSamplePoints`): Vollkreis 32 Schritte, Bogen
/// anteilig (mindestens 4), Endpunkt inklusive.
fn ring_sample_points(cx: f64, cy: f64, r: f64, arc: Option<(f64, f64)>) -> Vec<f64> {
    let tau = std::f64::consts::PI * 2.0;
    let (start, sweep, steps) = match arc {
        None => (0.0, tau, 32.0),
        Some((a0, a1)) => {
            let mut sw = (((a1 - a0) % tau) + tau) % tau;
            if sw == 0.0 || sw.is_nan() {
                sw = tau;
            }
            (a0, sw, jsnum::max(4.0, jsnum::round((sw / tau) * 32.0)))
        }
    };
    let mut out = Vec::new();
    let mut i = 0.0;
    while i <= steps {
        let a = start + (sweep * i) / steps;
        out.push(cx + r * jsnum::cos(a));
        out.push(cy + r * jsnum::sin(a));
        i += 1.0;
    }
    out
}

/// Alle Ecken im Rechteck (`polyEnclosedByRect`); leer → nein.
fn poly_enclosed_by_rect(poly: &[f64], r: Rect) -> bool {
    if poly.len() < 2 {
        return false;
    }
    poly.chunks_exact(2).all(|p| p[0] >= r.min_x && p[0] <= r.max_x && p[1] >= r.min_y && p[1] <= r.max_y)
}

/// Orientierung (b − a) × (c − a) (`cross3`).
fn cross3(a: (f64, f64), b: (f64, f64), c: (f64, f64)) -> f64 {
    (b.0 - a.0) * (c.1 - a.1) - (b.1 - a.1) * (c.0 - a.0)
}

/// `onSegment` bei kollinearen Punkten.
fn on_segment(a: (f64, f64), b: (f64, f64), p: (f64, f64)) -> bool {
    jsnum::min(a.0, b.0) <= p.0 && p.0 <= jsnum::max(a.0, b.0) && jsnum::min(a.1, b.1) <= p.1 && p.1 <= jsnum::max(a.1, b.1)
}

/// `segmentsIntersect` (inkl. Berührung).
fn segments_intersect(a: (f64, f64), b: (f64, f64), c: (f64, f64), d: (f64, f64)) -> bool {
    let d1 = cross3(c, d, a);
    let d2 = cross3(c, d, b);
    let d3 = cross3(a, b, c);
    let d4 = cross3(a, b, d);
    if ((d1 > 0.0 && d2 < 0.0) || (d1 < 0.0 && d2 > 0.0)) && ((d3 > 0.0 && d4 < 0.0) || (d3 < 0.0 && d4 > 0.0)) {
        return true;
    }
    (d1 == 0.0 && on_segment(c, d, a)) || (d2 == 0.0 && on_segment(c, d, b)) || (d3 == 0.0 && on_segment(a, b, c)) || (d4 == 0.0 && on_segment(a, b, d))
}

/// Polygon und Rechteck berühren sich (`polyTouchesRect`): Ecke im Rechteck, Rechteck-Ecke im
/// Polygon oder Kantenschnitt.
fn poly_touches_rect(poly: &[f64], r: Rect) -> bool {
    for p in poly.chunks_exact(2) {
        if p[0] >= r.min_x && p[0] <= r.max_x && p[1] >= r.min_y && p[1] <= r.max_y {
            return true;
        }
    }
    let corners = [(r.min_x, r.min_y), (r.max_x, r.min_y), (r.max_x, r.max_y), (r.min_x, r.max_y)];
    for c in corners {
        if point_in_polygon(c.0, c.1, poly) {
            return true;
        }
    }
    let n = poly.len() / 2;
    if n == 0 {
        return false;
    }
    let mut j = n - 1;
    for i in 0..n {
        let a = (poly[2 * j], poly[2 * j + 1]);
        let b = (poly[2 * i], poly[2 * i + 1]);
        for k in 0..4 {
            if segments_intersect(a, b, corners[k], corners[(k + 1) % 4]) {
                return true;
            }
        }
        j = i;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn punkt_in_polygon_und_abstand() {
        let sq = [0.0, 0.0, 1.0, 0.0, 1.0, 1.0, 0.0, 1.0];
        assert!(point_in_polygon(0.5, 0.5, &sq));
        assert!(!point_in_polygon(1.5, 0.5, &sq));
        assert_eq!(point_seg_dist(0.5, 1.0, 0.0, 0.0, 1.0, 0.0), 1.0);
        assert_eq!(point_seg_dist_px(3.0, 4.0, 0.0, 0.0, 0.0, 0.0), 5.0);
    }

    #[test]
    fn rechteck_beruehrt_und_umschliesst() {
        let r = Rect { min_x: 0.0, min_y: 0.0, max_x: 2.0, max_y: 2.0 };
        let inner = [0.5, 0.5, 1.5, 0.5, 1.5, 1.5];
        let around = [-1.0, -1.0, 3.0, -1.0, 3.0, 3.0, -1.0, 3.0];
        let crossing = [-1.0, 1.0, 3.0, 1.0];
        assert!(poly_enclosed_by_rect(&inner, r) && poly_touches_rect(&inner, r));
        // Rechteck ganz im Polygon: Ecke im Polygon.
        assert!(!poly_enclosed_by_rect(&around, r) && poly_touches_rect(&around, r));
        // Strecke quer durch: nur Kantenschnitt.
        assert!(poly_touches_rect(&crossing, r));
        assert!(!poly_touches_rect(&[5.0, 5.0, 6.0, 6.0], r));
        assert!(!poly_enclosed_by_rect(&[], r));
    }

    #[test]
    fn ring_abtastung_vollkreis_und_bogen() {
        assert_eq!(ring_sample_points(0.0, 0.0, 1.0, None).len(), 2 * 33);
        // Viertelbogen: 8 Schritte, Endpunkt inklusive.
        let q = ring_sample_points(0.0, 0.0, 2.0, Some((0.0, std::f64::consts::FRAC_PI_2)));
        assert_eq!(q.len(), 2 * 9);
        assert!(q.chunks_exact(2).all(|p| p[0] >= -1e-12 && p[1] >= -1e-12));
    }
}
