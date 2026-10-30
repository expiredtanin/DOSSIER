//! Wand-Schichtbänder für 3D/STL/OBJ/IFC: zerlegt EINE Wand in quer zur Dicke gestapelte
//! Materialbänder und schneidet daraus achsparallele Körper — mit Gehrungs-/Anschluss-Cuts
//! (aus [`crate::joins`]), Nah-Putz-Aussparungen der Durchgangswand, Decken-Dominanz pro Schicht,
//! Öffnungs-Löchern und schräger Oberkante unter Dachflächen (`top_drop`). Portiert aus
//! `src/plan/toWalls3d/bands.ts`; dort bleiben das Sammeln aus dem `Project` (Wandtyp, Öffnungen,
//! Decken-/Dachaufbau, Höhen) und die Darstellungs-Metadaten (Farbe, Schraffur, Material).
//!
//! Zwei Pfade wie in TS: `layered` (3D-Viewer: ein Körper je Band über die volle Achse, Öffnungen
//! als Löcher) und Schnitt-Eingabe (Pfeiler/Brüstung/Sturz-Segmente ohne Löcher).

use crate::joins::{js_hypot, reference_offset, Line, Reference, WallCuts};
use kernel2d::{add, dot, left_normal, line_intersect, point_in_outline, scale, sub, Vec2};

/// Toleranz der Wand-Ableitung (`EPS` in `toWalls3d/shared.ts`).
pub const EPS: f64 = 1e-4;
/// Schrittweite (Meter) der Dach-Unterkanten-Abtastung (Wechsel der Dachfläche suchen; die Grenzen
/// selbst sind exakt).
const ROOF_SAMPLE: f64 = 0.05;

/// Ein Schicht-Band: Dicke und Verschneidungs-Rang (`None`: keine Decken-Subtraktion).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BandIn {
    pub thickness: f64,
    pub priority: Option<f64>,
}

/// Eine Öffnung der Wand: Achsen-Intervall (Meter ab Wandstart), absolute z-Ausdehnung und ob
/// die innerste Schicht an der Laibung zurückspringt (`WindowType.innerLayerRecess`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct OpeningIn {
    pub from: f64,
    pub to: f64,
    pub z_bottom: f64,
    pub z_top: f64,
    pub recess_inner_layer: bool,
}

/// Schichteinzug einer Öffnung ([106], nur gestapelte Schichten): erkannt am gleichen Intervall/
/// Höhe wie ihr [`OpeningIn`]; je Band Rücksprung links/rechts/oben/unten und Zusatzstücke
/// `(band, seite 0 L | 1 R | 2 oben | 3 unten, [x0, x1, o0, o1])` mit x ab Rohbaukante in die
/// Öffnung, o quer ab der Aussenfläche (Band 0 = aussen).
#[derive(Clone, Debug, PartialEq, Default)]
pub struct RevealIn {
    pub from: f64,
    pub to: f64,
    pub z_bottom: f64,
    pub z_top: f64,
    pub shifts: Vec<[f64; 4]>,
    pub pieces: Vec<(usize, usize, [f64; 4])>,
}

impl RevealIn {
    fn of(&self, h: &OpeningIn) -> bool {
        self.from == h.from && self.to == h.to && self.z_bottom == h.z_bottom && self.z_top == h.z_top
    }
}

/// Eine Decke desselben Geschosses: z-Ausdehnung, Umriss, Schichten (Dicke, Rang; `None` =
/// Bauteil unbekannt). `layers = None`: Deckentyp unbekannt.
#[derive(Clone, Debug, PartialEq)]
pub struct CeilingIn {
    pub z_bottom: f64,
    pub z_top: f64,
    pub outline: Vec<Vec2>,
    pub layers: Option<Vec<(f64, Option<f64>)>>,
}

/// Ein Dach desselben Geschosses: Traufhöhe, Summe der Schichtdicken, Traufe-Umriss, Flächen und
/// die Unterkanten-Facetten ([G2]), an denen Wände enden.
#[derive(Clone, Debug, PartialEq)]
pub struct RoofIn {
    pub eaves_z: f64,
    pub total_thickness: f64,
    pub eaves: Vec<[f64; 2]>,
    pub planes: Vec<Vec<[f64; 3]>>,
    pub facets: Vec<RoofFacet>,
}

impl RoofIn {
    /// Facetten aus den Dachflächen (Schichten senkrecht zur Fläche, Summe `total`).
    pub fn new(eaves_z: f64, total: f64, eaves: Vec<[f64; 2]>, planes: Vec<Vec<[f64; 3]>>) -> Self {
        let facets = plane_facets(&planes, total);
        RoofIn { eaves_z, total_thickness: total, eaves, planes, facets }
    }
}

/// Ebene Unterkante eines Dachteils über dem Grundriss-Bereich `ring`: `z = c + gx·x + gy·y`. Wo sich
/// Facetten überdecken (Kehlen verschnittener Dächer, Gaube über dem Hauptdach), gilt die obere Hülle.
#[derive(Clone, Debug, PartialEq)]
pub struct RoofFacet {
    pub ring: Vec<[f64; 2]>,
    pub plane: [f64; 3],
    bounds: [f64; 4],
}

impl RoofFacet {
    /// `None` bei weniger als drei Ecken oder nicht endlichen Werten.
    pub fn new(ring: Vec<[f64; 2]>, plane: [f64; 3]) -> Option<Self> {
        if ring.len() < 3 || !plane.iter().all(|v| v.is_finite()) || !ring.iter().all(|q| q[0].is_finite() && q[1].is_finite()) {
            return None;
        }
        let b = outline_bounds(ring.iter().map(|q| (q[0], q[1])));
        Some(RoofFacet { ring, plane, bounds: [b.min_x, b.min_y, b.max_x, b.max_y] })
    }
    pub(crate) fn z(&self, x: f64, y: f64) -> f64 {
        self.plane[0] + self.plane[1] * x + self.plane[2] * y
    }
    pub(crate) fn contains(&self, x: f64, y: f64) -> bool {
        let b = self.bounds;
        if x < b[0] || x > b[2] || y < b[1] || y > b[3] {
            return false;
        }
        let mut inside = false;
        let n = self.ring.len();
        let mut j = n - 1;
        for i in 0..n {
            let (a, c) = (self.ring[i], self.ring[j]);
            if (a[1] > y) != (c[1] > y) && x < (c[0] - a[0]) * (y - a[1]) / (c[1] - a[1]) + a[0] {
                inside = !inside;
            }
            j = i;
        }
        inside
    }
    /// Höchster Wert über den Ecken.
    fn z_max(&self) -> f64 {
        self.ring.iter().map(|q| self.z(q[0], q[1])).fold(f64::NEG_INFINITY, f64::max)
    }
}

/// Unterkanten-Facetten der Dachflächen: Oberfläche um `total` senkrecht zur Fläche gesenkt (wie die
/// 3D-Schichten); senkrechte Flächen entfallen.
pub fn plane_facets(planes: &[Vec<[f64; 3]>], total: f64) -> Vec<RoofFacet> {
    let t = if total.is_finite() { total.max(0.0) } else { 0.0 };
    let mut out = Vec::new();
    for pts in planes {
        if pts.len() < 3 {
            continue;
        }
        let (mut a, mut b, mut c) = (0.0, 0.0, 0.0);
        for i in 0..pts.len() {
            let (p, q) = (pts[i], pts[(i + 1) % pts.len()]);
            a += (p[1] - q[1]) * (p[2] + q[2]);
            b += (p[2] - q[2]) * (p[0] + q[0]);
            c += (p[0] - q[0]) * (p[1] + q[1]);
        }
        let len = (a * a + b * b + c * c).sqrt();
        if !(len > 1e-12) || c.abs() < 1e-6 * len {
            continue; // senkrecht oder entartet
        }
        let (gx, gy) = (-a / c, -b / c);
        let c0 = pts[0][2] - gx * pts[0][0] - gy * pts[0][1] - t * len / c.abs();
        if let Some(f) = RoofFacet::new(pts.iter().map(|q| [q[0], q[1]]).collect(), [c0, gx, gy]) {
            out.push(f);
        }
    }
    out
}

/// Terminierung am Deckenanschluss (`Wall.sliceTermination`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Termination {
    Both,
    Below,
    Above,
}

/// Eine Wand mit allem, was die Bänder brauchen.
#[derive(Clone, Debug, PartialEq)]
pub struct WallIn {
    pub start: Vec2,
    pub end: Vec2,
    pub z_bottom: f64,
    pub z_top: f64,
    pub layered: bool,
    /// `true`: Bänder sind die Wandschichten (Versätze gestapelt); `false`: EIN Band über die
    /// ganze Dicke, Versatz = Referenzversatz.
    pub stacked: bool,
    pub reference: Reference,
    /// Wanddicke für die grobe Grundriss-Hülle (Decken-Vorfilter).
    pub thickness_safe: f64,
    pub termination: Termination,
    pub bands: Vec<BandIn>,
    pub openings: Vec<OpeningIn>,
    pub cuts: WallCuts,
    /// Schichteinzug ([106]); leer = alle Schichten bündig.
    pub reveals: Vec<RevealIn>,
    /// An Dach anschliessen ([G2], `Wall.roofAttach`): `None` = automatisch (Wand endet an der
    /// Dach-Unterkante, wo ihre Krone darüber liegt), `Some(true)` = zusätzlich bis unter das Dach
    /// verlängert, `Some(false)` = Dächer schneiden die Wand nicht.
    pub roof_attach: Option<bool>,
}

/// Decken und Dächer eines Geschosses — einmal je Geschoss gelesen, für alle seine Wände; die
/// Grundriss-Hüllen werden dabei vorab bestimmt.
#[derive(Clone, Debug, Default)]
pub struct FloorContext {
    ceilings: Vec<(CeilingIn, Bounds)>,
    roofs: Vec<(RoofIn, Bounds)>,
}

impl FloorContext {
    pub fn new(ceilings: Vec<CeilingIn>, roofs: Vec<RoofIn>) -> Self {
        FloorContext {
            ceilings: ceilings
                .into_iter()
                .map(|c| {
                    let b = outline_bounds(c.outline.iter().map(|p| (p.x, p.y)));
                    (c, b)
                })
                .collect(),
            roofs: roofs
                .into_iter()
                .map(|r| {
                    let b = outline_bounds(r.eaves.iter().map(|p| (p[0], p[1])).chain(r.facets.iter().flat_map(|f| f.ring.iter().map(|q| (q[0], q[1])))));
                    (r, b)
                })
                .collect(),
        }
    }
}

/// Ein Wandkörper: Band-Index, Achse (versetzt), z-Bereich, Absenkung der Oberkante am
/// Anfang/Ende (`None` = flach), Löcher `[from, to, zBottom, zTop]` relativ zum Körper-Start.
#[derive(Clone, Debug, PartialEq)]
pub struct Piece {
    pub band: usize,
    pub start: Vec2,
    pub end: Vec2,
    pub z_bottom: f64,
    pub z_top: f64,
    pub top_drop: Option<[f64; 2]>,
    pub holes: Vec<[f64; 4]>,
    /// Schnittlinie (Welt) am Körper-Anfang/-Ende: Gehrung, T-Stoss-Fläche oder schräge Seite einer
    /// Nah-Putz-Aussparung. Die Band-Kanten (±Dicke/2) enden auf ihr statt rechtwinklig; der Körper
    /// beginnt/endet dort, wo die Band-Mittellinie sie trifft. `None`: rechtwinklig.
    pub start_cut: Option<Line>,
    pub end_cut: Option<Line>,
    /// Eigene Dicke (Schichteinzug-Stück, [106]; seitlich geteiltes Band unter einem Dach, [G2]);
    /// `None` = Banddicke.
    pub thickness: Option<f64>,
    /// Ebene Oberkante unter einer Dachfläche ([G2]): `z = c + gx·x + gy·y` (Welt); `None` = waagrecht
    /// auf `z_top`. `z_top` ist dann der höchste Eckwert, `top_drop` die Absenkung auf der Mittellinie.
    pub top_plane: Option<[f64; 3]>,
    /// Anfang/Ende liegt an einer inneren Stossfuge (Teilung an Dachkanten oder Öffnungen unter einem
    /// Dach): dort keine sichtbare Stirnfläche (Ansicht).
    pub joint: [bool; 2],
}

#[derive(Clone, Copy, Debug)]
struct Bounds {
    min_x: f64,
    max_x: f64,
    min_y: f64,
    max_y: f64,
}

fn wall_bounds(w: &WallIn, half: f64) -> Bounds {
    Bounds {
        min_x: w.start.x.min(w.end.x) - half,
        max_x: w.start.x.max(w.end.x) + half,
        min_y: w.start.y.min(w.end.y) - half,
        max_y: w.start.y.max(w.end.y) + half,
    }
}

fn outline_bounds(pts: impl Iterator<Item = (f64, f64)>) -> Bounds {
    let mut b = Bounds { min_x: f64::INFINITY, max_x: f64::NEG_INFINITY, min_y: f64::INFINITY, max_y: f64::NEG_INFINITY };
    for (x, y) in pts {
        if x < b.min_x {
            b.min_x = x;
        }
        if x > b.max_x {
            b.max_x = x;
        }
        if y < b.min_y {
            b.min_y = y;
        }
        if y > b.max_y {
            b.max_y = y;
        }
    }
    b
}

fn bounds_overlap(a: Bounds, b: Bounds) -> bool {
    a.min_x <= b.max_x + EPS && a.max_x >= b.min_x - EPS && a.min_y <= b.max_y + EPS && a.max_y >= b.min_y - EPS
}

/// Decken-„Cutter": z-Band einer Deckenschicht, ihr Rang und der Decken-Umriss.
struct Cutter<'a> {
    z_bottom: f64,
    z_top: f64,
    priority: f64,
    outline: &'a [Vec2],
}

/// Decken, die die Wand pro Schicht einschneiden: dasselbe Geschoss (Aufrufer), vertikale
/// Überlappung, grober Grundriss-Überlapp; je Deckenschicht ein eigener Cutter (proportional auf
/// die Decken-z-Spanne verteilt, oben → unten), sonst einer über die volle Höhe mit dem höchsten
/// Rang.
fn ceiling_cutters<'a>(w: &WallIn, ctx: &'a FloorContext) -> Vec<Cutter<'a>> {
    let wb = wall_bounds(w, w.thickness_safe / 2.0);
    let mut out = Vec::new();
    for (c, cb) in &ctx.ceilings {
        if c.outline.len() < 3 {
            continue;
        }
        if c.z_bottom >= w.z_top - EPS || c.z_top <= w.z_bottom + EPS {
            continue;
        }
        if !bounds_overlap(wb, *cb) {
            continue;
        }
        let total = c.layers.as_ref().map_or(0.0, |ls| ls.iter().fold(0.0, |s, l| s + l.0));
        match &c.layers {
            Some(ls) if !ls.is_empty() && total > EPS => {
                let span = c.z_top - c.z_bottom;
                let mut prefix_top = 0.0;
                for &(th, prio) in ls {
                    let t = (th / total) * span;
                    let layer_top = c.z_top - prefix_top;
                    let layer_bottom = layer_top - t;
                    prefix_top += t;
                    if let Some(p) = prio {
                        out.push(Cutter { z_bottom: layer_bottom, z_top: layer_top, priority: p, outline: &c.outline });
                    }
                }
            }
            _ => {
                // Höchster Rang aller Schichten; ein unbekanntes Bauteil (oder Typ) → kein Cutter.
                let Some(ls) = &c.layers else { continue };
                let mut best: Option<f64> = None;
                let mut known = true;
                for &(_, p) in ls {
                    match p {
                        Some(p) => {
                            if best.map_or(true, |b| p > b) {
                                best = Some(p);
                            }
                        }
                        None => known = false,
                    }
                }
                if let (true, Some(p)) = (known, best) {
                    out.push(Cutter { z_bottom: c.z_bottom, z_top: c.z_top, priority: p, outline: &c.outline });
                }
            }
        }
    }
    out
}

/// Achsen-Teilintervalle in `[lo, hi]`, auf denen die Mittellinie eines Bands (Querversatz
/// `offset`) im Umriss liegt: Raster ~5 cm (min. 32 Schritte), Übergänge per Bisektion.
fn band_coverage(w: &WallIn, u: Vec2, n: Vec2, offset: f64, outline: &[Vec2], lo: f64, hi: f64) -> Vec<[f64; 2]> {
    if hi - lo <= EPS {
        return vec![];
    }
    let base = add(w.start, scale(n, offset));
    let inside = |t: f64| point_in_outline(add(base, scale(u, t)), outline);
    let steps = 32f64.max(((hi - lo) / 0.05).ceil()) as usize;
    let dt = (hi - lo) / steps as f64;
    let mut out = Vec::new();
    let mut prev_inside = inside(lo);
    let mut start = if prev_inside { Some(lo) } else { None };
    let mut prev_t = lo;
    for i in 1..=steps {
        let t = if i == steps { hi } else { lo + i as f64 * dt };
        let now = inside(t);
        if now != prev_inside {
            let cross = bisect(&inside, prev_t, t);
            if now {
                start = Some(cross);
            } else if let Some(s) = start.take() {
                out.push([s, cross]);
            }
        }
        prev_inside = now;
        prev_t = t;
    }
    if let Some(s) = start {
        out.push([s, hi]);
    }
    out
}

fn bisect(inside: &impl Fn(f64) -> bool, a: f64, b: f64) -> f64 {
    let a_inside = inside(a);
    let (mut lo, mut hi) = (a, b);
    let mut i = 0;
    while i < 40 && hi - lo > EPS * 0.01 {
        let mid = (lo + hi) / 2.0;
        if inside(mid) == a_inside {
            lo = mid;
        } else {
            hi = mid;
        }
        i += 1;
    }
    (lo + hi) / 2.0
}

/// `[lo, hi]` minus die (geklemmten, vereinigten) Intervalle `holes`.
fn subtract_spans(lo: f64, hi: f64, holes: &[[f64; 2]]) -> Vec<[f64; 2]> {
    let mut clipped: Vec<[f64; 2]> = holes
        .iter()
        .map(|&[a, b]| [lo.max(a.min(b)), hi.min(a.max(b))])
        .filter(|&[a, b]| b > a + EPS)
        .collect();
    clipped.sort_by(|p, q| p[0].partial_cmp(&q[0]).unwrap_or(std::cmp::Ordering::Equal));
    let mut parts = Vec::new();
    let mut cursor = lo;
    for [a, b] in clipped {
        if a > cursor + EPS {
            parts.push([cursor, a]);
        }
        if b > cursor {
            cursor = b;
        }
    }
    if cursor < hi - EPS {
        parts.push([cursor, hi]);
    }
    parts
}

/// Loch einer Nah-Putz-Aussparung in einem Band: Achsmass `[a, b]` auf der Band-Mittellinie, die
/// schrägen Seiten (Welt) und deren Achsmass-Spanne `(min, max)` über die Banddicke.
#[derive(Clone, Copy, Debug)]
struct BandHole {
    a: f64,
    b: f64,
    la: Line,
    lb: Line,
    la_rng: (f64, f64),
    lb_rng: (f64, f64),
}

/// Wie [`subtract_spans`], jedes Teilstück mit den Schnittlinien an seinen Enden: am Rand `lo`/`hi`
/// `lo_cut`/`hi_cut`, an einem Loch dessen (schräge) Seite. Ragt die schräge Seite eines Lochs
/// jenseits eines rechtwinkligen Wandendes ins Band (Knoten-T: das Loch liegt auf der Nachbarhälfte),
/// endet das Band an dieser Seite statt am Wandende; ein Teilstück, dessen Enden sich über die
/// Banddicke kreuzen (`valid` = falsch), entfällt — die Nachbarhälfte deckt es.
fn subtract_spans_cut(
    lo: f64,
    hi: f64,
    holes: &[BandHole],
    lo_cut: Option<Line>,
    hi_cut: Option<Line>,
    valid: impl Fn(f64, f64, Option<Line>, Option<Line>) -> bool,
) -> Vec<([f64; 2], Option<Line>, Option<Line>)> {
    let (mut lo, mut hi, mut lo_cut, mut hi_cut) = (lo, hi, lo_cut, hi_cut);
    {
        if let Some(h) = holes.iter().filter(|h| h.a >= hi - EPS && h.la_rng.0 < hi - EPS).min_by(|p, q| p.a.total_cmp(&q.a)) {
            hi = h.a;
            hi_cut = Some(h.la);
        }
    }
    {
        if let Some(h) = holes.iter().filter(|h| h.b <= lo + EPS && h.lb_rng.1 > lo + EPS).max_by(|p, q| p.b.total_cmp(&q.b)) {
            lo = h.b;
            lo_cut = Some(h.lb);
        }
    }
    let mut clipped: Vec<BandHole> = holes.iter().map(|h| BandHole { a: lo.max(h.a), b: hi.min(h.b), ..*h }).filter(|h| h.b > h.a + EPS).collect();
    clipped.sort_by(|p, q| p.a.partial_cmp(&q.a).unwrap_or(std::cmp::Ordering::Equal));
    let mut parts = Vec::new();
    let (mut cursor, mut cursor_cut) = (lo, lo_cut);
    for h in clipped {
        if h.a > cursor + EPS {
            parts.push(([cursor, h.a], cursor_cut, Some(h.la)));
        }
        if h.b > cursor {
            cursor = h.b;
            cursor_cut = Some(h.lb);
        }
    }
    if cursor < hi - EPS {
        parts.push(([cursor, hi], cursor_cut, hi_cut));
    }
    parts.retain(|&([a, b], sc, ec)| valid(a, b, sc, ec));
    parts
}

/// Loch einer Nah-Putz-Aussparung im Band `[band_lo, band_hi]` (Mittellinie `off`).
fn cutout_hole(w: &WallIn, u: Vec2, n: Vec2, c: &crate::joins::SpanCutout, off: f64, band_lo: f64, band_hi: f64) -> BandHole {
    let pt = |d: f64, o: f64| add(add(w.start, scale(u, d)), scale(n, o));
    let side = |p: f64, q: f64| {
        let (a, b) = (pt(p, c.off_a), pt(q, c.off_b));
        let dir = sub(b, a);
        Line { point: a, dir: if js_hypot(dir.x, dir.y) < 1e-12 { n } else { dir } }
    };
    let (x0, x1) = c.at(off);
    let ((p0, q0), (p1, q1)) = (c.at(band_lo), c.at(band_hi));
    let (rp, rq) = ((p0.min(p1), p0.max(p1)), (q0.min(q1), q0.max(q1)));
    let (l0, l1) = (side(c.from, c.from_b), side(c.to, c.to_b));
    if x0 <= x1 {
        BandHole { a: x0, b: x1, la: l0, lb: l1, la_rng: rp, lb_rng: rq }
    } else {
        BandHole { a: x1, b: x0, la: l1, lb: l0, la_rng: rq, lb_rng: rp }
    }
}

/// Decken-z-Cutter auf `[lo, hi]` je Terminierung: ausstanzen (beide), unter der Decke enden,
/// über der Decke beginnen.
fn terminate_or_subtract(lo: f64, hi: f64, cutters: &[[f64; 2]], term: Termination) -> Vec<[f64; 2]> {
    if cutters.is_empty() {
        return vec![[lo, hi]];
    }
    match term {
        Termination::Below => {
            let clip_top = cutters.iter().fold(f64::INFINITY, |m, c| m.min(c[0]));
            let top = clip_top.min(hi);
            if top > lo + EPS {
                vec![[lo, top]]
            } else {
                vec![]
            }
        }
        Termination::Above => {
            let clip_bottom = cutters.iter().fold(f64::NEG_INFINITY, |m, c| m.max(c[1]));
            let bottom = clip_bottom.max(lo);
            if bottom < hi - EPS {
                vec![[bottom, hi]]
            } else {
                vec![]
            }
        }
        Termination::Both => subtract_spans(lo, hi, cutters),
    }
}

/// Achsen-Distanz, an der die Band-Mittellinie die Schnittlinie trifft (`None`: parallel).
fn band_cut_distance(w: &WallIn, u: Vec2, n: Vec2, offset: f64, cut: &Line) -> Option<f64> {
    let base = add(w.start, scale(n, offset));
    let hit = line_intersect(base, u, cut.point, cut.dir)?;
    Some(dot(sub(hit, w.start), u))
}

/// Sammelt die Körper; `emit_piece` des layered-Pfads je Band.
struct Emitter<'a> {
    w: &'a WallIn,
    out: Vec<Piece>,
}

impl Emitter<'_> {
    /// `pushSegment`: Achsenstück [from, to] × [zb, zt], quer um `offset` versetzt.
    fn push(&mut self, band: usize, from: f64, to: f64, zb: f64, zt: f64, offset: f64, holes: Vec<[f64; 4]>, drop: [f64; 2]) {
        if to - from <= EPS || zt - zb <= EPS {
            return;
        }
        let (dx, dy) = (self.w.end.x - self.w.start.x, self.w.end.y - self.w.start.y);
        let len = js_hypot(dx, dy);
        if len < 1e-9 {
            return;
        }
        let (ux, uy) = (dx / len, dy / len);
        let (ox, oy) = (-uy * offset, ux * offset);
        let s = self.w.start;
        self.out.push(Piece {
            band,
            start: Vec2::new(s.x + ux * from + ox, s.y + uy * from + oy),
            end: Vec2::new(s.x + ux * to + ox, s.y + uy * to + oy),
            z_bottom: zb,
            z_top: zt,
            top_drop: (drop[0] > EPS || drop[1] > EPS).then_some(drop),
            holes,
            start_cut: None,
            end_cut: None,
            thickness: None,
            top_plane: None,
            joint: [false; 2],
        });
    }
}

// ── Wand an Dach ([G2]) ───────────────────────────────────────────────────────
//
// Die Oberkante eines Bands ist `clamp(U, zb, zt)` mit U = obere Hülle der Dach-Unterkanten-Facetten
// über dem Punkt (stückweise eben). Das Band wird an den Grenzen der Bereiche geteilt — längs der
// Achse mit der exakten Grenzlinie als Schnittlinie (First, Grat, Kehle, Höhenlinie U = zt bzw. zb),
// quer über die Dicke (seitlich), wo eine Grenze längs durch das Band läuft (Traufwand, deren Krone die
// Dachfläche schneidet). Jedes Stück bekommt eine ebene Oberkante: exakt je Schicht, an jeder Ecke.

/// Bereich der Oberkante an einem Punkt.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Fac {
    /// Kein Dach darüber: Wandkrone.
    Free,
    /// Unter dem Dach, Unterkante über der (verlängerten) Krone: waagrecht auf der Krone.
    Cap,
    /// Unterkante unter dem Fuss: kein Körper.
    Floor,
    /// Unterkante der Facette `k`.
    Roof(usize),
}

struct Tops<'a> {
    facets: Vec<&'a RoofFacet>,
    zb: f64,
    zt_free: f64,
    zt_cap: f64,
}

impl Tops<'_> {
    fn at(&self, p: Vec2) -> Fac {
        let mut best: Option<(f64, usize)> = None;
        for (k, f) in self.facets.iter().enumerate() {
            if f.contains(p.x, p.y) {
                let z = f.z(p.x, p.y);
                if best.is_none_or(|b| z > b.0) {
                    best = Some((z, k));
                }
            }
        }
        match best {
            None => Fac::Free,
            Some((z, _)) if z >= self.zt_cap - 1e-9 => {
                if self.zt_cap == self.zt_free {
                    Fac::Free
                } else {
                    Fac::Cap
                }
            }
            Some((z, _)) if z <= self.zb + 1e-9 => Fac::Floor,
            Some((_, k)) => Fac::Roof(k),
        }
    }
    fn coef(&self, f: Fac) -> [f64; 3] {
        match f {
            Fac::Free => [self.zt_free, 0.0, 0.0],
            Fac::Cap => [self.zt_cap, 0.0, 0.0],
            Fac::Floor => [self.zb, 0.0, 0.0],
            Fac::Roof(k) => self.facets[k].plane,
        }
    }
}

/// Ein Stück der Band-Oberkante: Achsmass `[a, b]` auf seiner Mittellinie (Versatz `off`, Dicke `th`),
/// Schnittlinien, Höhe (`top` = höchster Eckwert) und Ebene.
#[derive(Clone, Debug)]
struct TopPiece {
    a: f64,
    b: f64,
    cut_a: Option<Line>,
    cut_b: Option<Line>,
    off: f64,
    th: f64,
    top: f64,
    plane: Option<[f64; 3]>,
    joint: [bool; 2],
}

/// Dächer, die eine Wand im Höhenbereich `[zb, zt]` betreffen; `None` = keine (unverändert).
fn roof_tops_ctx<'a>(w: &WallIn, ctx: &'a FloorContext, zb: f64, zt: f64) -> Option<Tops<'a>> {
    if w.roof_attach == Some(false) || ctx.roofs.is_empty() {
        return None;
    }
    let wb = wall_bounds(w, w.thickness_safe.max(0.0) + 0.01);
    let facets: Vec<&RoofFacet> = ctx
        .roofs
        .iter()
        .filter(|(r, rb)| r.eaves_z + 50.0 >= zb && bounds_overlap(wb, *rb))
        .flat_map(|(r, _)| r.facets.iter())
        .filter(|f| bounds_overlap(wb, Bounds { min_x: f.bounds[0], min_y: f.bounds[1], max_x: f.bounds[2], max_y: f.bounds[3] }))
        .collect();
    if facets.is_empty() {
        return None;
    }
    // Verlängern nur, wo der Höhenbereich bis zur Wandkrone reicht (nicht unter einer Decke).
    let zt_cap = if w.roof_attach == Some(true) && (zt - w.z_top).abs() < EPS { facets.iter().map(|f| f.z_max()).fold(zt, f64::max) } else { zt };
    Some(Tops { facets, zb, zt_free: zt, zt_cap })
}

/// Ecken der Grundfläche eines Bandstücks (aussen +n, innen −n) an den Schnittlinien.
#[allow(clippy::too_many_arguments)]
fn strip_corners(w: &WallIn, u: Vec2, n: Vec2, off: f64, th: f64, a: f64, b: f64, cut_a: Option<Line>, cut_b: Option<Line>) -> [Vec2; 4] {
    let base = add(w.start, scale(n, off));
    let at = |s: f64, o: f64, cut: Option<Line>| {
        let q = add(add(base, scale(u, s)), scale(n, o));
        cut.and_then(|c| line_intersect(q, u, c.point, c.dir)).filter(|r| r.x.is_finite() && r.y.is_finite()).unwrap_or(q)
    };
    let h = th / 2.0;
    [at(a, h, cut_a), at(b, h, cut_b), at(b, -h, cut_b), at(a, -h, cut_a)]
}

/// Oberkante eines Bandstreifens `[a, b]` (Mittellinie `off`, Dicke `th`) unter den Dächern `t`.
#[allow(clippy::too_many_arguments)]
fn strip_tops(w: &WallIn, t: &Tops, u: Vec2, n: Vec2, off: f64, th: f64, a: f64, b: f64, cut_a: Option<Line>, cut_b: Option<Line>, joint: [bool; 2], depth: u32, out: &mut Vec<TopPiece>) {
    if !(b - a > EPS) || !(th > 0.0) {
        return;
    }
    let base = add(w.start, scale(n, off));
    let pt = |s: f64| add(base, scale(u, s));
    let steps = 8usize.max(((b - a) / ROOF_SAMPLE).ceil() as usize).min(20_000);
    let ts: Vec<f64> = (0..=steps).map(|i| if i == steps { b } else { a + (b - a) * i as f64 / steps as f64 }).collect();
    let inner = |s: f64| s.clamp(a + 1e-6, b - 1e-6);
    let fac: Vec<Fac> = ts.iter().map(|&s| t.at(pt(inner(s)))).collect();
    // Läufe gleicher Bereiche und die Grenzen dazwischen (Achsmass, Schnittlinie).
    let mut runs: Vec<(Fac, f64, Option<Line>)> = vec![(fac[0], a, cut_a)];
    for i in 1..=steps {
        let last = runs.last().map_or(fac[0], |r| r.0);
        if fac[i] == last {
            continue;
        }
        let (fa, fb) = (fac[i - 1], fac[i]);
        // Wechselstelle auf der Mittellinie (Bisektion), dann die exakte Grenzlinie beider Ebenen.
        let (mut lo, mut hi) = (ts[i - 1], ts[i]);
        for _ in 0..50 {
            let mid = (lo + hi) / 2.0;
            if t.at(pt(inner(mid))) == fa {
                lo = mid;
            } else {
                hi = mid;
            }
        }
        let sm = (lo + hi) / 2.0;
        let p = pt(sm);
        let (ca, cb) = (t.coef(fa), t.coef(fb));
        let d = [ca[0] - cb[0], ca[1] - cb[1], ca[2] - cb[2]];
        let g = js_hypot(d[1], d[2]);
        let mut line = None;
        if g > 1e-9 {
            let dist = (d[0] + d[1] * p.x + d[2] * p.y) / g;
            let dir = Vec2::new(-d[2] / g, d[1] / g);
            // Nur, wenn die Grenze wirklich hier liegt (sonst Sprung, z. B. Traufe) und quer genug steht.
            if dist.abs() < 0.02 && (dir.x * u.y - dir.y * u.x).abs() > 0.17 {
                line = Some(Line { point: Vec2::new(p.x - d[1] / g * dist, p.y - d[2] / g * dist), dir });
            }
        }
        let prev = runs.last().map_or(a, |r| r.1);
        let s_cut = line.and_then(|l| band_cut_distance(w, u, n, off, &l)).filter(|x| x.is_finite()).unwrap_or(sm).clamp(prev, b);
        runs.push((fb, s_cut, line));
    }
    let k_last = runs.len() - 1;
    for k in 0..runs.len() {
        let (f, s0, c0) = runs[k];
        let (s1, c1) = if k < k_last { (runs[k + 1].1, runs[k + 1].2) } else { (b, cut_b) };
        if !(s1 - s0 > EPS) {
            continue;
        }
        let jt = [if k == 0 { joint[0] } else { true }, if k == k_last { joint[1] } else { true }];
        // Seitlich: läuft eine Grenze längs durchs Band (Kanten sehen einen anderen Bereich)?
        if depth < 3 && th > 0.004 {
            let mut other = None;
            'edges: for side in [1.0, -1.0] {
                let eo = side * (th / 2.0 - 1e-4);
                let e_lo = c0.and_then(|l| band_cut_distance(w, u, n, off + eo, &l)).unwrap_or(s0);
                let e_hi = c1.and_then(|l| band_cut_distance(w, u, n, off + eo, &l)).unwrap_or(s1);
                if !(e_hi - e_lo > 4.0 * EPS) {
                    continue;
                }
                let m = 4usize.max(((e_hi - e_lo) / ROOF_SAMPLE).ceil() as usize).min(20_000);
                for j in 0..m {
                    let s = e_lo + (e_hi - e_lo) * (j as f64 + 0.5) / m as f64;
                    let fe = t.at(add(pt(s), scale(n, eo)));
                    if fe != f {
                        other = Some(fe);
                        break 'edges;
                    }
                }
            }
            if let Some(fo) = other {
                let (ca, cb) = (t.coef(f), t.coef(fo));
                let d = [ca[0] - cb[0], ca[1] - cb[1], ca[2] - cb[2]];
                let mid = pt((s0 + s1) / 2.0);
                let den = d[1] * n.x + d[2] * n.y;
                if den.abs() > 1e-9 {
                    let o = -(d[0] + d[1] * mid.x + d[2] * mid.y) / den;
                    if o.abs() < th / 2.0 - 1e-3 {
                        for (lo_o, hi_o) in [(-th / 2.0, o), (o, th / 2.0)] {
                            let c = off + (lo_o + hi_o) / 2.0;
                            let sa = c0.and_then(|l| band_cut_distance(w, u, n, c, &l)).unwrap_or(s0);
                            let sb = c1.and_then(|l| band_cut_distance(w, u, n, c, &l)).unwrap_or(s1);
                            strip_tops(w, t, u, n, c, hi_o - lo_o, sa, sb, c0, c1, jt, depth + 1, out);
                        }
                        continue;
                    }
                }
            }
        }
        let (plane, top) = match f {
            Fac::Floor => continue,
            Fac::Free => (None, t.zt_free),
            Fac::Cap => (None, t.zt_cap),
            Fac::Roof(_) => {
                let c = t.coef(f);
                let zmax = strip_corners(w, u, n, off, th, s0, s1, c0, c1).iter().map(|q| c[0] + c[1] * q.x + c[2] * q.y).fold(f64::NEG_INFINITY, f64::max);
                (Some(c), zmax.min(t.zt_cap).max(t.zb))
            }
        };
        out.push(TopPiece { a: s0, b: s1, cut_a: c0, cut_b: c1, off, th, top, plane, joint: jt });
    }
}

/// Oberkante eines Bandstücks unter den Dächern; `None`, wenn kein Dach die Wand betrifft (dann
/// unverändert ein Körper auf der Krone).
#[allow(clippy::too_many_arguments)]
fn roof_tops(w: &WallIn, ctx: &FloorContext, u: Vec2, n: Vec2, off: f64, th: f64, a: f64, b: f64, cut_a: Option<Line>, cut_b: Option<Line>, zb: f64, zt: f64) -> Option<Vec<TopPiece>> {
    if zt - zb <= EPS || b - a <= EPS {
        return None;
    }
    let t = roof_tops_ctx(w, ctx, zb, zt)?;
    let mut out = Vec::new();
    strip_tops(w, &t, u, n, off, th, a, b, cut_a, cut_b, [false; 2], 0, &mut out);
    // Nichts geteilt, nichts geneigt: wie ohne Dach.
    if out.len() == 1 && out[0].plane.is_none() && out[0].top == zt && out[0].th == th && out[0].a == a && out[0].b == b {
        return None;
    }
    Some(out)
}

/// Löcher eines Bandkörpers ab `a` (Achsmass) im Höhenbereich `[zb, zt]`, mit Schichteinzug.
#[allow(clippy::too_many_arguments)]
fn band_holes(w: &WallIn, li: usize, cutouts: &[OpeningIn], innermost: bool, recess: f64, a: f64, zb: f64, zt: f64) -> Vec<[f64; 4]> {
    let reveals = &w.reveals;
    cutouts
        .iter()
        .filter(|h| h.z_top > zb + EPS && h.z_bottom < zt - EPS)
        .map(|h| {
            if let Some(s) = reveals.iter().find(|r| r.of(h)).and_then(|r| r.shifts.get(li)) {
                [h.from - a - s[0], h.to - a + s[1], h.z_bottom - s[3], h.z_top + s[2]]
            } else if innermost && h.recess_inner_layer {
                [h.from - a - recess, h.to - a + recess, h.z_bottom - recess, h.z_top + recess]
            } else {
                [h.from - a, h.to - a, h.z_bottom, h.z_top]
            }
        })
        .collect()
}

/// Ein Körper aus einem Oberkanten-Stück: Achsmass `[x0, x1]` relativ zu `tp.a`, Höhe `[zb, top]`.
#[allow(clippy::too_many_arguments)]
fn push_top_piece(em: &mut Emitter, li: usize, band_th: f64, tp: &TopPiece, x0: f64, x1: f64, zb: f64, top: f64, plane: Option<[f64; 3]>, holes: Vec<[f64; 4]>) {
    let len = tp.b - tp.a;
    let first = x0 <= EPS;
    let last = x1 >= len - EPS;
    let before = em.out.len();
    em.push(li, tp.a + x0, tp.a + x1, zb, top, tp.off, holes, [0.0, 0.0]);
    let Some(pc) = em.out.get_mut(before) else { return };
    pc.start_cut = if first { tp.cut_a } else { None };
    pc.end_cut = if last { tp.cut_b } else { None };
    pc.joint = [if first { tp.joint[0] } else { true }, if last { tp.joint[1] } else { true }];
    if (tp.th - band_th).abs() > 1e-12 {
        pc.thickness = Some(tp.th);
    }
    if let Some(c) = plane {
        pc.top_plane = Some(c);
        let at = |q: Vec2| c[0] + c[1] * q.x + c[2] * q.y;
        let d = [top - at(pc.start), top - at(pc.end)];
        pc.top_drop = (d[0] > EPS || d[1] > EPS).then_some(d);
    }
}

/// Körper eines Oberkanten-Stücks; unter einer Dachfläche ohne Löcher (Pfeiler, Brüstung, Sturz je mit
/// eigener ebener Oberkante statt Treppung).
#[allow(clippy::too_many_arguments)]
fn emit_top_piece(em: &mut Emitter, li: usize, band_th: f64, tp: &TopPiece, u: Vec2, n: Vec2, zb: f64, cutouts: &[OpeningIn], innermost: bool, recess: f64) {
    let w = em.w;
    let holes = if w.layered { band_holes(w, li, cutouts, innermost, recess, tp.a, zb, tp.top) } else { Vec::new() };
    let len = tp.b - tp.a;
    let Some(c) = tp.plane else {
        push_top_piece(em, li, band_th, tp, 0.0, len, zb, tp.top, None, holes);
        return;
    };
    if holes.is_empty() {
        push_top_piece(em, li, band_th, tp, 0.0, len, zb, tp.top, Some(c), holes);
        return;
    }
    let mut xs = vec![0.0, len];
    for h in &holes {
        for x in [h[0], h[1]] {
            if x > EPS && x < len - EPS {
                xs.push(x);
            }
        }
    }
    xs.sort_by(|p, q| p.total_cmp(q));
    xs.dedup_by(|p, q| (*p - *q).abs() <= EPS);
    for i in 0..xs.len() - 1 {
        let (x0, x1) = (xs[i], xs[i + 1]);
        if x1 - x0 <= EPS {
            continue;
        }
        let mid = (x0 + x1) / 2.0;
        let mut zs: Vec<[f64; 2]> = holes.iter().filter(|h| h[0] <= mid && h[1] >= mid).map(|h| [h[2], h[3]]).collect();
        zs.sort_by(|p, q| p[0].total_cmp(&q[0]));
        let mut cur = zb;
        for [h0, h1] in zs {
            if h0 > cur + EPS {
                push_top_piece(em, li, band_th, tp, x0, x1, cur, h0, None, Vec::new());
            }
            cur = cur.max(h1);
        }
        let ca = if x0 <= EPS { tp.cut_a } else { None };
        let cb = if x1 >= len - EPS { tp.cut_b } else { None };
        let zc: Vec<f64> = strip_corners(w, u, n, tp.off, tp.th, tp.a + x0, tp.a + x1, ca, cb).iter().map(|q| c[0] + c[1] * q.x + c[2] * q.y).collect();
        let (zmin, zmax) = (zc.iter().copied().fold(f64::INFINITY, f64::min), zc.iter().copied().fold(f64::NEG_INFINITY, f64::max));
        // Sturz/Pfeiler bis unter die Dachfläche (Fenster, das ins Dach ragt: der Rest entfällt).
        if zmin > cur + EPS {
            push_top_piece(em, li, band_th, tp, x0, x1, cur, zmax.min(tp.top), Some(c), Vec::new());
        }
    }
}

/// Band-Versätze (Mitte je Band, entlang der linken Normalen, relativ zur Achse).
fn band_offsets(w: &WallIn) -> Vec<f64> {
    if !w.stacked {
        return w.bands.iter().map(|b| reference_offset(w.reference, b.thickness)).collect();
    }
    let total = w.bands.iter().fold(0.0, |s, b| s + b.thickness);
    let ref_off = reference_offset(w.reference, total);
    let mut prefix = 0.0;
    w.bands
        .iter()
        .map(|b| {
            let o = ref_off - total / 2.0 + prefix + b.thickness / 2.0;
            prefix += b.thickness;
            o
        })
        .collect()
}

/// Alle Körper EINER Wand, in der Reihenfolge der früheren TS-Emission.
pub fn wall_bands(w: &WallIn, ctx: &FloorContext) -> Vec<Piece> {
    let mut em = Emitter { w, out: Vec::new() };
    let axis_len = js_hypot(w.end.x - w.start.x, w.end.y - w.start.y);
    if axis_len < 1e-9 || w.z_top - w.z_bottom <= EPS {
        return em.out;
    }
    let offsets = band_offsets(w);
    let (z_bottom, z_top) = (w.z_bottom, w.z_top);
    let mut cutouts = w.openings.clone();
    cutouts.sort_by(|a, b| a.from.partial_cmp(&b.from).unwrap_or(std::cmp::Ordering::Equal));

    if !w.layered {
        // Schnitt-Pfad: Pfeiler/Brüstung/Sturz, je Segment alle Bänder.
        // Unter Dächern ([G2]) je Segment die exakte Oberkante.
        let u = Vec2::new((w.end.x - w.start.x) / axis_len, (w.end.y - w.start.y) / axis_len);
        let n = left_normal(u);
        let seg = |em: &mut Emitter, from: f64, to: f64, zb: f64, zt: f64| {
            for (i, &off) in offsets.iter().enumerate() {
                let th = w.bands[i].thickness;
                match roof_tops(w, ctx, u, n, off, th, from, to, None, None, zb, zt) {
                    None => em.push(i, from, to, zb, zt, off, vec![], [0.0, 0.0]),
                    Some(tops) => {
                        for tp in &tops {
                            emit_top_piece(em, i, th, tp, u, n, zb, &[], false, 0.0);
                        }
                    }
                }
            }
        };
        if cutouts.is_empty() {
            seg(&mut em, 0.0, axis_len, z_bottom, z_top);
            return em.out;
        }
        let mut cursor = 0.0f64;
        for c in &cutouts {
            let seg_from = cursor.max(c.from);
            if c.from > cursor {
                seg(&mut em, cursor, c.from, z_bottom, z_top);
            }
            if c.to > seg_from {
                if c.z_bottom > z_bottom + EPS {
                    seg(&mut em, seg_from, c.to, z_bottom, c.z_bottom);
                }
                if c.z_top < z_top - EPS {
                    seg(&mut em, seg_from, c.to, c.z_top, z_top);
                }
            }
            cursor = cursor.max(c.to);
        }
        if cursor < axis_len {
            seg(&mut em, cursor, axis_len, z_bottom, z_top);
        }
        return em.out;
    }

    let cuts = &w.cuts;
    let u = Vec2::new((w.end.x - w.start.x) / axis_len, (w.end.y - w.start.y) / axis_len);
    let n = left_normal(u);
    let cutters = ceiling_cutters(w, ctx);
    let n_bands = w.bands.len();

    for (li, b) in w.bands.iter().enumerate() {
        let off = offsets[li];
        // (1) Cuts an den Achsenenden (pro Schicht, falls materialbewusst).
        let (s_cut, e_cut) = match &cuts.layer_cuts {
            Some(lc) => (lc.start.get(li).copied().flatten(), lc.end.get(li).copied().flatten()),
            None => (cuts.start_cut, cuts.end_cut),
        };
        let mut from0 = 0.0;
        let mut to0 = axis_len;
        if let Some(c) = s_cut {
            if let Some(d) = band_cut_distance(w, u, n, off, &c) {
                from0 = d;
            }
        }
        if let Some(c) = e_cut {
            if let Some(d) = band_cut_distance(w, u, n, off, &c) {
                to0 = d;
            }
        }

        // (2) Nah-Putz-Aussparungen, die dieses Band quer treffen.
        let band_lo = off - b.thickness / 2.0;
        let band_hi = off + b.thickness / 2.0;
        let axis_holes: Vec<BandHole> = cuts
            .span_cutouts
            .iter()
            .filter(|c| band_lo < c.off_a.max(c.off_b) - EPS && band_hi > c.off_a.min(c.off_b) + EPS)
            .map(|c| cutout_hole(w, u, n, c, off, band_lo, band_hi))
            .collect();
        // Teilstück gültig, wenn es an beiden Band-Kanten eine positive Länge hat.
        let valid = |a: f64, b: f64, sc: Option<Line>, ec: Option<Line>| {
            [band_lo, band_hi].iter().all(|&e| {
                let ps = sc.and_then(|l| band_cut_distance(w, u, n, e, &l)).unwrap_or(a);
                let pe = ec.and_then(|l| band_cut_distance(w, u, n, e, &l)).unwrap_or(b);
                pe > ps + EPS
            })
        };
        let axis_pieces = if axis_holes.is_empty() {
            vec![([from0, to0], s_cut, e_cut)]
        } else {
            subtract_spans_cut(from0, to0, &axis_holes, s_cut, e_cut, valid)
        };

        // (3) Decken-Subtraktion je Band dort, wo der Decken-Umriss die Band-Mittellinie deckt.
        let mut band_z_cuts: Vec<[f64; 4]> = Vec::new(); // from, to, zBottom, zTop
        if let Some(bp) = b.priority {
            for cc in &cutters {
                if cc.priority <= bp {
                    continue;
                }
                for [ca, cb] in band_coverage(w, u, n, off, cc.outline, from0, to0) {
                    band_z_cuts.push([ca, cb, cc.z_bottom, cc.z_top]);
                }
            }
        }

        let innermost = li == n_bands - 1;
        let recess = b.thickness;
        for ([a, bb], cut_a, cut_b) in axis_pieces {
            let n0 = em.out.len();
            let th = b.thickness;
            let mut emit_piece = |a: f64, bb: f64, ca: Option<Line>, cb: Option<Line>, zb: f64, zt: f64| match roof_tops(w, ctx, u, n, off, th, a, bb, ca, cb, zb, zt) {
                None => emit_band_piece(&mut em, li, off, &cutouts, innermost, recess, a, bb, zb, zt),
                Some(tops) => {
                    for tp in &tops {
                        emit_top_piece(&mut em, li, th, tp, u, n, zb, &cutouts, innermost, recess);
                    }
                }
            };
            let local: Vec<[f64; 4]> = band_z_cuts
                .iter()
                .map(|c| [a.max(c[0]), bb.min(c[1]), c[2], c[3]])
                .filter(|c| c[1] > c[0] + EPS)
                .collect();
            if local.is_empty() {
                emit_piece(a, bb, cut_a, cut_b, z_bottom, z_top);
                set_piece_cuts(&mut em.out[n0..], w, u, a, bb, cut_a, cut_b);
                continue;
            }
            let mut xs = vec![a, bb];
            for c in &local {
                xs.push(c[0]);
                xs.push(c[1]);
            }
            xs.sort_by(|p, q| p.partial_cmp(q).unwrap_or(std::cmp::Ordering::Equal));
            xs.dedup();
            for i in 0..xs.len() - 1 {
                let (xa, xb) = (xs[i], xs[i + 1]);
                if xb - xa <= EPS {
                    continue;
                }
                let mid = (xa + xb) / 2.0;
                let z_cutters: Vec<[f64; 2]> = local.iter().filter(|c| c[0] <= mid && c[1] >= mid).map(|c| [c[2], c[3]]).collect();
                for [zb, zt] in terminate_or_subtract(z_bottom, z_top, &z_cutters, w.termination) {
                    emit_piece(xa, xb, if xa == a { cut_a } else { None }, if xb == bb { cut_b } else { None }, zb, zt);
                }
            }
            set_piece_cuts(&mut em.out[n0..], w, u, a, bb, cut_a, cut_b);
        }
    }
    reveal_pieces(&mut em, &offsets);
    em.out
}

/// Schnittlinien an die Körper eines Achsenstücks `[a, bb]` hängen: nur Körper, die tatsächlich bei
/// `a` beginnen bzw. bei `bb` enden (Decken-/Dach-Teilungen dazwischen bleiben rechtwinklig).
fn set_piece_cuts(pieces: &mut [Piece], w: &WallIn, u: Vec2, a: f64, bb: f64, cut_a: Option<Line>, cut_b: Option<Line>) {
    for p in pieces {
        if (dot(sub(p.start, w.start), u) - a).abs() < EPS {
            p.start_cut = cut_a;
        }
        if (dot(sub(p.end, w.start), u) - bb).abs() < EPS {
            p.end_cut = cut_b;
        }
    }
}

/// Zusatzstücke des Schichteinzugs ([106]) als eigene Körper der Schicht: Leibungen über die
/// Öffnungshöhe (ohne die Ecken der Sturz-/Brüstungsstücke derselben Schicht), Sturz/Brüstung
/// über die ganze Öffnungsbreite.
fn reveal_pieces(em: &mut Emitter, offsets: &[f64]) {
    let w = em.w;
    if !w.stacked || w.bands.is_empty() {
        return;
    }
    let face = offsets[0] - w.bands[0].thickness / 2.0;
    for r in &w.reveals {
        let reach = |band: usize, side: usize| r.pieces.iter().filter(|p| p.0 == band && p.1 == side).fold(0.0f64, |m, p| m.max(p.2[1]));
        for &(band, side, [x0, x1, o0, o1]) in &r.pieces {
            if band >= w.bands.len() || !(x1 - x0 > EPS) || !(o1 - o0 > EPS) {
                continue;
            }
            let off = face + (o0 + o1) / 2.0;
            let (a, b, zb, zt) = match side {
                0 => (r.from + x0, r.from + x1, r.z_bottom + reach(band, 3), r.z_top - reach(band, 2)),
                1 => (r.to - x1, r.to - x0, r.z_bottom + reach(band, 3), r.z_top - reach(band, 2)),
                2 => (r.from, r.to, r.z_top - x1, r.z_top - x0),
                _ => (r.from, r.to, r.z_bottom + x0, r.z_bottom + x1),
            };
            let before = em.out.len();
            em.push(band, a, b, zb, zt, off, vec![], [0.0, 0.0]);
            if let Some(pc) = em.out.get_mut(before) {
                pc.thickness = Some(o1 - o0);
            }
        }
    }
}

/// Ein Körper eines Bands im layered-Pfad: Öffnungs-Löcher auf den Körper-Start umrechnen (an der
/// innersten Schicht mit Laibungs-Rücksprung geweitet); schräge Oberkante mit Löchern geht in
/// render3d nicht → gestuft annähern.
/// Körper eines Bandstücks ohne Dach darüber (waagrechte Krone, Öffnungen als Löcher).
#[allow(clippy::too_many_arguments)]
fn emit_band_piece(em: &mut Emitter, li: usize, off: f64, cutouts: &[OpeningIn], innermost: bool, recess: f64, a: f64, bb: f64, zb: f64, zt: f64) {
    let holes = band_holes(em.w, li, cutouts, innermost, recess, a, zb, zt);
    em.push(li, a, bb, zb, zt, off, holes, [0.0, 0.0]);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::joins::{compute_joins, JoinLayer, JoinWall, Line, SpanCutout};

    fn base(start: (f64, f64), end: (f64, f64), bands: Vec<BandIn>) -> WallIn {
        WallIn {
            start: Vec2::new(start.0, start.1),
            end: Vec2::new(end.0, end.1),
            z_bottom: 0.0,
            z_top: 2.6,
            layered: true,
            stacked: true,
            reference: Reference::Center,
            thickness_safe: bands.iter().map(|b| b.thickness).sum(),
            termination: Termination::Both,
            bands,
            openings: vec![],
            cuts: WallCuts::default(),
            reveals: vec![],
            roof_attach: None,
        }
    }
    fn band(t: f64, p: f64) -> BandIn {
        BandIn { thickness: t, priority: Some(p) }
    }
    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-9
    }
    fn bands_of(w: &WallIn) -> Vec<Piece> {
        wall_bands(w, &FloorContext::default())
    }
    /// Achsen-Länge eines Körpers.

    #[test]
    fn schichten_gestapelt_und_referenzversetzt() {
        let mut w = base((0.0, 0.0), (4.0, 0.0), vec![band(0.1, 10.0), band(0.2, 50.0)]);
        let p = bands_of(&w);
        assert_eq!(p.len(), 2);
        assert!(close(p[0].start.y, -0.1) && close(p[1].start.y, 0.05));
        w.reference = Reference::Left; // Stapel um die halbe Dicke nach +n verschoben
        let p = bands_of(&w);
        assert!(close(p[0].start.y, 0.05) && close(p[1].start.y, 0.2));
    }

    #[test]
    fn l_ecke_kuerzt_und_verlaengert_je_band() {
        let jw = |s: (f64, f64), e: (f64, f64)| JoinWall {
            start: Vec2::new(s.0, s.1),
            end: Vec2::new(e.0, e.1),
            reference: Reference::Center,
            layers: Some(vec![JoinLayer { thickness: 0.1, component: Some(0), priority: 10.0 }, JoinLayer { thickness: 0.2, component: Some(1), priority: 50.0 }]),
            bulge: None,
        };
        let cuts = compute_joins(&[jw((0.0, 0.0), (4.0, 0.0)), jw((4.0, 0.0), (4.0, 3.0))]).unwrap();
        let mut w = base((0.0, 0.0), (4.0, 0.0), vec![band(0.1, 10.0), band(0.2, 50.0)]);
        w.cuts = cuts[0].clone();
        let p = bands_of(&w);
        // Gehrung: das aussen liegende Band (−n, unten) ist länger als das innere.
        assert!(close(p[0].end.x, 4.0 + 0.1) && close(p[1].end.x, 4.0 - 0.05), "{p:?}");
        assert!(close(p[0].start.x, 0.0));
    }

    // ── Lückenlose Verschneidung (schräge T-, L-, X-Stösse) ──────────────────

    /// Vorzeichenbehafteter Abstand zum Rand eines konvexen Vierecks (innen positiv).
    fn quad_margin(q: &[Vec2; 4], p: Vec2) -> f64 {
        let area: f64 = (0..4).map(|i| kernel2d::cross(q[i], q[(i + 1) % 4])).sum();
        let s = area.signum();
        (0..4)
            .map(|i| {
                let (a, b) = (q[i], q[(i + 1) % 4]);
                let d = sub(b, a);
                s * kernel2d::cross(d, sub(p, a)) / js_hypot(d.x, d.y)
            })
            .fold(f64::INFINITY, f64::min)
    }

    /// Grundriss eines Körpers: Band-Kanten ±Dicke/2, an den Schnittlinien verschnitten (wie
    /// `extrude_layer_segment` in render3d).
    fn footprint(w: &WallIn, p: &Piece) -> [Vec2; 4] {
        let u = sub(w.end, w.start);
        let u = scale(u, 1.0 / js_hypot(u.x, u.y));
        let n = left_normal(u);
        let h = w.bands[p.band].thickness / 2.0;
        let clip = |base: Vec2, c: Option<Line>| c.and_then(|c| line_intersect(base, u, c.point, c.dir)).unwrap_or(base);
        [clip(add(p.start, scale(n, h)), p.start_cut), clip(add(p.end, scale(n, h)), p.end_cut), clip(add(p.end, scale(n, -h)), p.end_cut), clip(add(p.start, scale(n, -h)), p.start_cut)]
    }

    /// Prüft im Kasten `bb` auf einem Raster: jeder Punkt der Soll-Fläche (Vereinigung `region`) ist
    /// von genau einem Körper gedeckt (keine Lücke, keine Doppelung), kein Körper ragt hinaus.
    fn assert_watertight(label: &str, walls: &[WallIn], region: &[[Vec2; 4]], bb: [f64; 4]) {
        let fps: Vec<[Vec2; 4]> = walls.iter().flat_map(|w| bands_of(w).into_iter().map(move |p| footprint(w, &p))).collect();
        let tol = 1e-6;
        let steps = 150;
        for i in 0..=steps {
            for j in 0..=steps {
                let p = Vec2::new(bb[0] + (bb[2] - bb[0]) * i as f64 / steps as f64 + 1.3e-5, bb[1] + (bb[3] - bb[1]) * j as f64 / steps as f64 + 0.7e-5);
                let m = region.iter().map(|q| quad_margin(q, p)).fold(f64::NEG_INFINITY, f64::max);
                let ms: Vec<f64> = fps.iter().map(|q| quad_margin(q, p)).collect();
                let covered = ms.iter().filter(|&&x| x > tol).count();
                let touched = ms.iter().filter(|&&x| x > -tol).count();
                if m > tol {
                    assert!(touched >= 1, "{label}: Lücke bei {p:?}");
                    assert!(covered <= 1, "{label}: Doppelung bei {p:?}");
                } else if m < -tol {
                    assert_eq!(covered, 0, "{label}: Körper ragt hinaus bei {p:?}");
                }
            }
        }
    }

    fn layered(lay: &[JoinLayer]) -> Vec<BandIn> {
        lay.iter().map(|l| band(l.thickness, l.priority)).collect()
    }

    fn walls_with_cuts(jw: &[JoinWall]) -> Vec<WallIn> {
        let cuts = compute_joins(jw).unwrap();
        jw.iter()
            .zip(cuts)
            .map(|(j, c)| {
                let mut w = base((j.start.x, j.start.y), (j.end.x, j.end.y), layered(j.layers.as_ref().unwrap()));
                w.cuts = c;
                w
            })
            .collect()
    }

    fn strip(a: Vec2, b: Vec2, h: f64) -> [Vec2; 4] {
        let u = sub(b, a);
        let n = scale(left_normal(u), h / js_hypot(u.x, u.y));
        [add(a, n), add(b, n), sub(b, n), sub(a, n)]
    }

    fn lay_sets() -> Vec<(&'static str, Vec<JoinLayer>)> {
        let l = |t: f64, c: u32, p: f64| JoinLayer { thickness: t, component: Some(c), priority: p };
        vec![
            ("einschichtig", vec![l(0.25, 0, 100.0)]),
            ("aussenwand", vec![l(0.02, 0, 10.0), l(0.16, 1, 20.0), l(0.15, 2, 50.0), l(0.015, 3, 10.0)]),
            ("innenwand", vec![l(0.015, 3, 10.0), l(0.12, 2, 50.0), l(0.015, 3, 10.0)]),
        ]
    }

    #[test]
    fn schraeger_t_stoss_3d_lueckenlos_15_bis_165_grad() {
        for (name, lay) in lay_sets() {
            let h: f64 = lay.iter().map(|l| l.thickness).sum::<f64>() / 2.0;
            for deg in (15..=165).step_by(15) {
                let th = (deg as f64).to_radians();
                let b0 = Vec2::new(5.0, 0.0);
                let b1 = Vec2::new(5.0 + 3.0 * th.cos(), 3.0 * th.sin());
                let jw = |s: Vec2, e: Vec2| JoinWall { start: s, end: e, reference: Reference::Center, layers: Some(lay.clone()), bulge: None };
                // Soll: Durchgangswand + Abzweig ab ihrer Fläche (y = h) bis zum freien Ende.
                let ub = scale(sub(b1, b0), 1.0 / 3.0);
                let nb = left_normal(ub);
                let at_face = |o: f64| {
                    let e = add(b0, scale(nb, o));
                    line_intersect(e, ub, Vec2::new(0.0, h), Vec2::new(1.0, 0.0)).unwrap()
                };
                let branch = [at_face(h), add(b1, scale(nb, h)), add(b1, scale(nb, -h)), at_face(-h)];
                let region = [strip(Vec2::new(0.0, 0.0), Vec2::new(10.0, 0.0), h), branch];
                let bb = [2.0, -0.4, 8.0, 1.2];
                let mid = vec![jw(Vec2::new(0.0, 0.0), Vec2::new(10.0, 0.0)), jw(b0, b1)];
                assert_watertight(&format!("{name} T {deg}°"), &walls_with_cuts(&mid), &region, bb);
                let node = vec![jw(Vec2::new(0.0, 0.0), b0), jw(b0, Vec2::new(10.0, 0.0)), jw(b0, b1)];
                assert_watertight(&format!("{name} Knoten-T {deg}°"), &walls_with_cuts(&node), &region, bb);
            }
        }
    }

    #[test]
    fn schraege_l_ecke_und_kreuzung_3d_lueckenlos() {
        for (name, lay) in lay_sets() {
            let h: f64 = lay.iter().map(|l| l.thickness).sum::<f64>() / 2.0;
            let jw = |s: Vec2, e: Vec2| JoinWall { start: s, end: e, reference: Reference::Center, layers: Some(lay.clone()), bulge: None };
            for deg in [30.0f64, 60.0, 120.0, 150.0] {
                // L: A (0,0)→(4,0), dann B mit Richtungswinkel `deg`.
                let th = deg.to_radians();
                let (a0, j) = (Vec2::new(0.0, 0.0), Vec2::new(4.0, 0.0));
                let b1 = add(j, Vec2::new(3.0 * th.cos(), 3.0 * th.sin()));
                let (ua, ub) = (Vec2::new(1.0, 0.0), scale(sub(b1, j), 1.0 / 3.0));
                let (na, nb) = (left_normal(ua), left_normal(ub));
                let apex = |o: f64| line_intersect(add(a0, scale(na, o)), ua, add(j, scale(nb, o)), ub).unwrap();
                let (pl, pr) = (apex(h), apex(-h));
                let ra = [add(a0, scale(na, h)), pl, pr, add(a0, scale(na, -h))];
                let rb = [pl, add(b1, scale(nb, h)), add(b1, scale(nb, -h)), pr];
                let walls = walls_with_cuts(&[jw(a0, j), jw(j, b1)]);
                assert_watertight(&format!("{name} L {deg}°"), &walls, &[ra, rb], [2.5, -1.5, 5.5, 1.5]);
            }
            for deg in [30.0f64, 45.0, 135.0] {
                // X: Durchgangswand und zwei Hälften einer schrägen Wand, Knoten auf der Achse.
                let th = deg.to_radians();
                let c = Vec2::new(5.0, 0.0);
                let d = Vec2::new(2.0 * th.cos(), 2.0 * th.sin());
                let walls = walls_with_cuts(&[jw(Vec2::new(0.0, 0.0), Vec2::new(10.0, 0.0)), jw(sub(c, d), c), jw(c, add(c, d))]);
                let region = [strip(Vec2::new(0.0, 0.0), Vec2::new(10.0, 0.0), h), strip(sub(c, d), add(c, d), h)];
                assert_watertight(&format!("{name} X {deg}°"), &walls, &region, [3.0, -1.0, 7.0, 1.0]);
            }
        }
    }

    #[test]
    fn t_stoss_aussparung_bricht_band_auf() {
        let mut w = base((0.0, 0.0), (6.0, 0.0), vec![band(0.02, 10.0), band(0.15, 50.0), band(0.015, 10.0)]);
        w.cuts.span_cutouts.push(SpanCutout { from: 2.0, to: 2.15, off_a: 0.0925, off_b: 0.0775, from_b: 2.0, to_b: 2.15 });
        let p = bands_of(&w);
        // Aussenputz und Kern durchgehend, Innenputz (Band 2) in zwei Stücken.
        assert_eq!(p.iter().filter(|q| q.band == 2).count(), 2);
        assert_eq!(p.iter().filter(|q| q.band == 1).count(), 1);
    }

    #[test]
    fn oeffnung_am_rand_und_ruecksprung() {
        let mut w = base((0.0, 0.0), (3.0, 0.0), vec![band(0.15, 50.0), band(0.02, 10.0)]);
        w.openings.push(OpeningIn { from: 0.0, to: 0.9, z_bottom: 0.0, z_top: 2.1, recess_inner_layer: false });
        w.openings.push(OpeningIn { from: 2.0, to: 3.0, z_bottom: 0.9, z_top: 2.1, recess_inner_layer: true });
        let p = bands_of(&w);
        assert_eq!(p.len(), 2);
        assert_eq!(p[0].holes.len(), 2);
        assert_eq!(p[0].holes[1], [2.0, 3.0, 0.9, 2.1]);
        let r = p[1].holes[1];
        assert!(close(r[0], 1.98) && close(r[1], 3.02) && close(r[2], 0.88) && close(r[3], 2.12));
        // Schnitt-Pfad: Pfeiler/Brüstung/Sturz ohne Löcher.
        w.layered = false;
        w.stacked = false;
        w.bands = vec![BandIn { thickness: 0.17, priority: None }];
        let s = bands_of(&w);
        // Sturz Tür, Pfeiler, Brüstung + Sturz Fenster (Tür bis zum Rand: kein Pfeiler davor).
        assert_eq!(s.len(), 4, "{s:?}");
        assert!(s.iter().all(|q| q.holes.is_empty() && q.top_drop.is_none()));
    }

    #[test]
    fn schichteinzug_weitet_loch_und_setzt_stuecke() {
        let mut w = base((0.0, 0.0), (4.0, 0.0), vec![band(0.16, 1.0), band(0.15, 2.0), band(0.01, 1.0)]);
        let o = OpeningIn { from: 1.0, to: 2.0, z_bottom: 0.9, z_top: 2.1, recess_inner_layer: false };
        w.openings.push(o);
        w.reveals.push(RevealIn {
            from: 1.0,
            to: 2.0,
            z_bottom: 0.9,
            z_top: 2.1,
            shifts: vec![[0.0; 4], [0.0; 4], [0.02, 0.02, 0.0, 0.0]],
            pieces: vec![(0, 2, [0.0, 0.03, 0.0, 0.16])],
        });
        let ps = bands_of(&w);
        let inner = ps.iter().find(|p| p.band == 2 && p.thickness.is_none()).unwrap();
        assert!(close(inner.holes[0][0], 0.98) && close(inner.holes[0][1], 2.02));
        let outer = ps.iter().find(|p| p.band == 0 && p.thickness.is_none()).unwrap();
        assert!(close(outer.holes[0][0], 1.0));
        let st = ps.iter().find(|p| p.thickness.is_some()).unwrap();
        assert!(close(st.thickness.unwrap(), 0.16) && close(st.z_bottom, 2.07) && close(st.z_top, 2.1));
        // Stück liegt in der Aussendämmung (Mitte −0.16 + 0.08 bei Gesamtdicke 0.32 zentriert).
        assert!(close(st.start.y, -0.08));
    }

    #[test]
    fn decke_hoeherer_prioritaet_schneidet_nur_schwache_baender() {
        let mut w = base((0.0, 0.0), (4.0, 0.0), vec![band(0.15, 50.0), band(0.02, 10.0)]);
        w.z_top = 3.0;
        let outline = vec![Vec2::new(-1.0, -1.0), Vec2::new(5.0, -1.0), Vec2::new(5.0, 5.0), Vec2::new(-1.0, 5.0)];
        let ctx = FloorContext::new(vec![CeilingIn { z_bottom: 2.6, z_top: 2.8, outline, layers: Some(vec![(0.2, Some(30.0))]) }], vec![]);
        let p = wall_bands(&w, &ctx);
        assert_eq!(p.iter().filter(|q| q.band == 0).count(), 1); // Kern (50) läuft durch
        let weak: Vec<_> = p.iter().filter(|q| q.band == 1).collect();
        assert_eq!(weak.len(), 2);
        assert!(close(weak[0].z_top, 2.6) && close(weak[1].z_bottom, 2.8));
        // Terminierung „below": endet an der Deckenunterkante, kein Rest darüber.
        w.termination = Termination::Below;
        let p = wall_bands(&w, &ctx);
        assert_eq!(p.iter().filter(|q| q.band == 1).count(), 1);
    }

    #[test]
    fn wand_unter_pultdach_bekommt_schraege_oberkante() {
        let mut w = base((0.0, 0.0), (4.0, 0.0), vec![band(0.2, 50.0)]);
        w.z_top = 5.0;
        // Ebene z = 2 + 0.5·x über [−1, 5]².
        let plane = vec![[-1.0, -1.0, 1.5], [5.0, -1.0, 4.5], [5.0, 5.0, 4.5], [-1.0, 5.0, 1.5]];
        let roof = RoofIn::new(1.5, 0.0, plane.iter().map(|p| [p[0], p[1]]).collect(), vec![plane]);
        let ctx = FloorContext::new(vec![], vec![roof]);
        let p = wall_bands(&w, &ctx);
        assert_eq!(p.len(), 1, "{p:?}");
        let d = p[0].top_drop.unwrap();
        // Abtastung 1 mm innerhalb der Enden (wie TS) → Toleranz 1e-3.
        let near = |a: f64, b: f64| (a - b).abs() < 1e-3;
        assert!(near(p[0].z_top, 4.0) && near(d[0], 2.0) && d[1] == 0.0, "{p:?}");
        // Mit Öffnung ([G2]): Pfeiler und Sturz mit schräger Oberkante statt Treppung.
        w.openings.push(OpeningIn { from: 1.0, to: 2.0, z_bottom: 0.0, z_top: 2.0, recess_inner_layer: false });
        let p = wall_bands(&w, &ctx);
        assert!(p.len() == 3 && p.iter().all(|q| q.holes.is_empty() && q.top_plane.is_some()), "{p:?}");
        let vol: f64 = p.iter().map(|q| volume(&w, q)).sum();
        assert!((vol - 2.0).abs() < 1e-9, "{vol}");
    }

    // ── [G2] Wand an Dach: exakte Oberkante je Schicht ──────────────────────────

    /// Satteldach über [-1, 9] × [-1, 7], First bei y = 3 (längs x), Traufe z = 3, Neigung 45°.
    fn gable(total: f64) -> RoofIn {
        let s = vec![[-1.0, -1.0, 3.0], [9.0, -1.0, 3.0], [9.0, 3.0, 7.0], [-1.0, 3.0, 7.0]];
        let n = vec![[-1.0, 3.0, 7.0], [9.0, 3.0, 7.0], [9.0, 7.0, 3.0], [-1.0, 7.0, 3.0]];
        RoofIn::new(3.0, total, vec![[-1.0, -1.0], [9.0, -1.0], [9.0, 7.0], [-1.0, 7.0]], vec![s, n])
    }

    /// Unterkante des Satteldachs (Dicke `t` senkrecht zur Fläche, 45° ⇒ lotrecht t·√2).
    fn gable_under(t: f64, y: f64) -> f64 {
        7.0 - (y - 3.0).abs() - t * 2f64.sqrt()
    }

    /// Ecken einer Band-Grundfläche (mit Schnittlinien, Eigendicke).
    fn corners(w: &WallIn, p: &Piece) -> [Vec2; 4] {
        let u = sub(w.end, w.start);
        let u = scale(u, 1.0 / js_hypot(u.x, u.y));
        let n = left_normal(u);
        let h = p.thickness.unwrap_or(w.bands[p.band].thickness) / 2.0;
        let clip = |base: Vec2, c: Option<Line>| c.and_then(|c| line_intersect(base, u, c.point, c.dir)).unwrap_or(base);
        [clip(add(p.start, scale(n, h)), p.start_cut), clip(add(p.end, scale(n, h)), p.end_cut), clip(add(p.end, scale(n, -h)), p.end_cut), clip(add(p.start, scale(n, -h)), p.start_cut)]
    }

    fn top_at(p: &Piece, q: Vec2) -> f64 {
        p.top_plane.map_or(p.z_top, |c| c[0] + c[1] * q.x + c[2] * q.y)
    }

    /// Volumen eines Körpers: Grundfläche × Höhe im Schwerpunkt (exakt bei ebener Oberkante), ohne Löcher.
    fn volume(w: &WallIn, p: &Piece) -> f64 {
        let q = corners(w, p);
        let mut a = 0.0;
        let (mut cx, mut cy) = (0.0, 0.0);
        for i in 0..4 {
            let (p0, p1) = (q[i], q[(i + 1) % 4]);
            let c = p0.x * p1.y - p1.x * p0.y;
            a += c;
            cx += (p0.x + p1.x) * c;
            cy += (p0.y + p1.y) * c;
        }
        if a.abs() < 1e-15 {
            return 0.0;
        }
        let c = Vec2::new(cx / (3.0 * a), cy / (3.0 * a));
        let holes: f64 = p.holes.iter().map(|h| (h[1] - h[0]) * (h[3] - h[2])).sum::<f64>() * p.thickness.unwrap_or(w.bands[p.band].thickness);
        (a / 2.0).abs() * (top_at(p, c) - p.z_bottom) - holes
    }

    #[test]
    fn giebelwand_folgt_beiden_dachflaechen_je_schicht() {
        // Giebelwand quer zum First (x = 0, y 0 → 6), zwei Schichten, Oberkante weit über dem Dach.
        let mut w = base((0.0, 0.0), (0.0, 6.0), vec![band(0.1, 10.0), band(0.2, 50.0)]);
        w.z_top = 9.0;
        let ctx = FloorContext::new(vec![], vec![gable(0.2)]);
        let p = wall_bands(&w, &ctx);
        // Je Schicht zwei Körper (links/rechts vom First), beide mit ebener Oberkante.
        assert_eq!(p.len(), 4, "{p:?}");
        for q in &p {
            assert!(q.top_plane.is_some() && q.holes.is_empty(), "{q:?}");
            for c in corners(&w, q) {
                assert!((top_at(q, c) - gable_under(0.2, c.y)).abs() < 1e-9, "Ecke {c:?} {q:?}");
            }
        }
        // Volumen = Fläche unter der Unterkante × Dicke (Fünfeck), exakt.
        let vol: f64 = p.iter().map(|q| volume(&w, q)).sum();
        let h0 = gable_under(0.2, 0.0);
        let h1 = gable_under(0.2, 3.0);
        let expect = 0.3 * (6.0 * h0 + 3.0 * (h1 - h0));
        assert!((vol - expect).abs() < 1e-9, "{vol} vs {expect}");
        // Innere Stossfuge am First: keine sichtbare Stirn.
        assert!(p.iter().filter(|q| q.joint[0] || q.joint[1]).count() == 4);
    }

    #[test]
    fn traufwand_schraeg_ueber_die_dicke_und_seitlich_geteilt() {
        // Traufwand längs x bei y = 0.5 (Dicke 0.3: y 0.35 … 0.65), Dach steigt quer zur Wand.
        let mut w = base((0.0, 0.5), (8.0, 0.5), vec![band(0.3, 50.0)]);
        w.z_top = 9.0;
        let ctx = FloorContext::new(vec![], vec![gable(0.0)]);
        let p = wall_bands(&w, &ctx);
        assert_eq!(p.len(), 1, "{p:?}");
        let c = p[0].top_plane.unwrap();
        assert!(c[1].abs() < 1e-12 && (c[2] - 1.0).abs() < 1e-12, "Oberkante steigt mit y: {c:?}");
        for k in corners(&w, &p[0]) {
            assert!((top_at(&p[0], k) - gable_under(0.0, k.y)).abs() < 1e-9);
        }
        // Wandkrone 4.5 schneidet die Unterkante in der Dicke (y = 0.5): zwei Streifen nebeneinander.
        w.z_top = 4.5;
        let p = wall_bands(&w, &ctx);
        assert_eq!(p.len(), 2, "{p:?}");
        let vol: f64 = p.iter().map(|q| volume(&w, q)).sum();
        // Aussen (y 0.35 … 0.5) schräg 4.35 … 4.5, innen flach 4.5.
        let expect = 8.0 * (0.15 * (4.35 + 4.5) / 2.0 + 0.15 * 4.5);
        assert!((vol - expect).abs() < 1e-9, "{vol} vs {expect}");
        assert!(p.iter().all(|q| q.thickness.is_some_and(|t| (t - 0.15).abs() < 1e-9)));
    }

    #[test]
    fn wand_mit_fenster_unter_dachschraege_ohne_treppung() {
        let mut w = base((0.0, 0.0), (0.0, 6.0), vec![band(0.2, 50.0)]);
        w.z_top = 9.0;
        w.openings.push(OpeningIn { from: 1.0, to: 2.0, z_bottom: 1.0, z_top: 2.5, recess_inner_layer: false });
        let ctx = FloorContext::new(vec![], vec![gable(0.0)]);
        let p = wall_bands(&w, &ctx);
        // Pfeiler, Brüstung, Sturz, Pfeiler bis zum First, Pfeiler danach: keine Treppen, keine Löcher.
        assert!(p.len() <= 6 && p.iter().all(|q| q.holes.is_empty()), "{p:?}");
        let vol: f64 = p.iter().map(|q| volume(&w, q)).sum();
        let gross = 0.2 * (6.0 * 4.0 + 3.0 * 3.0);
        assert!((vol - (gross - 0.2 * 1.5)).abs() < 1e-9, "{vol}");
        for q in &p {
            for c in corners(&w, q) {
                assert!(top_at(q, c) <= gable_under(0.0, c.y) + 1e-9);
            }
        }
    }

    #[test]
    fn an_dach_anschliessen_verlaengert_oder_ignoriert() {
        // Wandkrone 2.5 unter der Traufe: automatisch unverändert.
        let mut w = base((0.0, 0.0), (0.0, 6.0), vec![band(0.2, 50.0)]);
        w.z_top = 2.5;
        let ctx = FloorContext::new(vec![], vec![gable(0.0)]);
        let p = wall_bands(&w, &ctx);
        assert!(p.len() == 1 && p[0].top_plane.is_none() && close(p[0].z_top, 2.5));
        // An Dach anschliessen: bis unter die Dachfläche verlängert.
        w.roof_attach = Some(true);
        let p = wall_bands(&w, &ctx);
        let vol: f64 = p.iter().map(|q| volume(&w, q)).sum();
        assert!((vol - 0.2 * (6.0 * 4.0 + 9.0)).abs() < 1e-9, "{vol} {p:?}");
        // Nie: Wand bleibt durchgehend, auch wenn sie über das Dach ragt.
        w.roof_attach = Some(false);
        w.z_top = 9.0;
        let p = wall_bands(&w, &ctx);
        assert!(p.len() == 1 && close(p[0].z_top, 9.0));
    }

    #[test]
    fn kehle_zweier_daecher_nimmt_die_obere_huelle() {
        // Zwei Pultdächer überdecken sich: Unterkante = obere Hülle (Maximum) der beiden.
        let a = RoofIn::new(0.0, 0.0, vec![], vec![vec![[0.0, -1.0, 2.0], [6.0, -1.0, 5.0], [6.0, 1.0, 5.0], [0.0, 1.0, 2.0]]]);
        let b = RoofIn::new(0.0, 0.0, vec![], vec![vec![[0.0, -1.0, 5.0], [6.0, -1.0, 2.0], [6.0, 1.0, 2.0], [0.0, 1.0, 5.0]]]);
        let mut w = base((0.0, 0.0), (6.0, 0.0), vec![band(0.2, 50.0)]);
        w.z_top = 9.0;
        let p = wall_bands(&w, &FloorContext::new(vec![], vec![a, b]));
        assert_eq!(p.len(), 2, "{p:?}");
        let vol: f64 = p.iter().map(|q| volume(&w, q)).sum();
        assert!((vol - 0.2 * 25.5).abs() < 1e-9, "{vol}");
    }

    #[test]
    fn schnitt_pfad_schneidet_ebenfalls_am_dach() {
        let mut w = base((0.0, 0.0), (0.0, 6.0), vec![band(0.3, 50.0)]);
        w.z_top = 9.0;
        w.layered = false;
        w.openings.push(OpeningIn { from: 1.0, to: 2.0, z_bottom: 1.0, z_top: 2.5, recess_inner_layer: false });
        let p = wall_bands(&w, &FloorContext::new(vec![], vec![gable(0.0)]));
        let vol: f64 = p.iter().map(|q| volume(&w, q)).sum();
        assert!((vol - 0.3 * (6.0 * 4.0 + 9.0 - 1.5)).abs() < 1e-9, "{vol}");
    }

    #[test]
    fn unsinn_ohne_panic() {
        // Nulllänge, umgekehrte Höhen, Öffnung ausserhalb, Bänder ohne Dicke, entartete Decke/Dach.
        let mut w = base((1.0, 1.0), (1.0, 1.0), vec![band(0.2, 50.0)]);
        assert!(bands_of(&w).is_empty());
        w.end = Vec2::new(2.0, 1.0);
        w.z_top = -1.0;
        assert!(bands_of(&w).is_empty());
        w.z_top = 2.0;
        w.openings.push(OpeningIn { from: 5.0, to: -3.0, z_bottom: 9.0, z_top: -9.0, recess_inner_layer: true });
        w.bands.push(band(0.0, 1.0));
        let ctx = FloorContext::new(
            vec![CeilingIn { z_bottom: 0.5, z_top: 0.5, outline: vec![Vec2::new(0.0, 0.0); 3], layers: Some(vec![]) }],
            vec![RoofIn::new(0.0, 0.0, vec![], vec![vec![]]), RoofIn::new(0.0, f64::NAN, vec![], vec![vec![[0.0, 0.0, f64::NAN], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]], vec![[0.0, 0.0, 0.0], [0.0, 0.0, 1.0], [0.0, 0.0, 2.0]]])],
        );
        let _ = wall_bands(&w, &ctx);

    }
}
