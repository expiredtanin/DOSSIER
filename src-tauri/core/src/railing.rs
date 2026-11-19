//! [279] Geländer als eigenes Bauteil (`Project.railings`): Absturzsicherung für Balkon, Galerie, Treppenauge und
//! Terrasse. **Eine Quelle** für die Körper: [`pieces`] zerlegt ein Geländer in Prismen `(Querschnitt, z_unten, z_oben,
//! Teil)` wie `model3d::column_pieces` bei den Stützen — lotrecht, auf einer Treppe ([291]) längs einer Teilstrecke
//! geschert (`slope`, dieselbe Neigungsebene wie die geneigten Decken [281]). Daraus entstehen das 3D-Netz
//! (`model3d/railings.rs`), die Platten für Schnitt, Ansicht und 3D-Dokument (`model3d::railing_slabs`), die
//! IFC-Mengen (`ifc_data.rs`) und die Netze der Auswahl. Der Grundriss (`plan/railings.rs`) zeichnet die Achse und
//! die Streifen ([`strips`]) selbst. Teile, Masse und Obergrenzen:
//!
//! - **Achse ([`path`]):** frei die Polylinie `points` (offen; mit `closed` oder letzter = erster Punkt geschlossen);
//!   [291] gebunden an eine Treppe (`stairId` + `stairSide`) die Handlauf-Achse der Wange aus [`crate::stair_rail::rails`]
//!   mit Fusshöhe = Handlaufhöhe − [`crate::stair_rail::RAIL_HEIGHT`] (also lotrecht über der Stufenkante), oder an eine
//!   Deckenkante (`ceilingId` + `edgeIndex`/`edgeCount`, um `edgeInset` nach innen), Fuss auf der Deckenoberkante.
//!   Die Achse ist eine Ableitung: ändert sich Treppe oder Decke, folgt das Geländer. Gehrungen an den Ecken über
//!   [`crate::stair_rail::offset_polyline`] — dieselbe Hilfe wie die Treppen-Handläufe und die Absturzsicherung am
//!   Deckenloch ([`crate::stair_guard`], [`crate::stairs3d::guard_mesh`]).
//! - **Aufbau je Feld ([291], Leitbild Archicad):** Pfosten an Ecken und Enden und höchstens `postSpacing` (Vorgabe
//!   [`POST_GAP`]) auseinander, Querschnitt `postSize`; Feld = Abschnitt zwischen zwei Pfosten (auch ohne sichtbare
//!   Pfosten). Füllung je Feld (`fields`, sonst `kind`): Stäbe im Achsabstand `barSpacing` (lichtes Mass höchstens
//!   [`MAX_CLEAR_GAP`] = 12 cm nach SIA 358) mit Fussschiene, oder eine Tafel (Glas, Lochblech, Brüstung) der Dicke
//!   `thickness`. Zwischenholme (`midRails`) gleich verteilt zwischen Fuss und Handlauf. Handlauf rechteckig oder rund
//!   (Achteck-Stufen), Oberkante `handrailHeight` (Vorgabe = `height`); ohne Handlauf bei Stäben ein Obergurt.
//! - **Höhe:** Fuss = Geschoss-UK + `baseOffset` (gebunden: Treppe bzw. Decke + `baseOffset`), Oberkante = Fuss +
//!   `height` (Vorgabe [`DEFAULT_HEIGHT`] = 1.00 m).
//! - **Treppen-Handläufe:** Hat eine Treppe ein gebundenes Geländer auf einer Seite, entfällt dort ihr eigener Handlauf
//!   ([`stair_code`]); sonst bleibt die Absturzsicherung der Treppe wie bisher.

use crate::model::*;
use crate::stair_rail::{is_closed, offset_polyline, P};

/// Vorgabehöhe (m) nach SIA 358 (Absturzsicherung bis 12 m Fallhöhe: 1.00 m).
pub const DEFAULT_HEIGHT: f64 = 1.0;
/// Kategorie (Ebene) neuer Geländer.
pub const CATEGORY: &str = "41";
/// Pick-Id im Grundriss/Schnitt (`contextObjectId = "@railing:<id>"`), wie bei den Bäumen.
pub const PICK_PREFIX: &str = "@railing:";
/// Pfostenabstand (m, Vorgabe von `postSpacing`) und höchstes lichtes Mass zwischen Stäben (m, SIA 358).
pub const POST_GAP: f64 = 1.2;
pub const MAX_CLEAR_GAP: f64 = 0.12;
/// [291] Abstand der Achse von einer gebundenen Deckenkante (m, Vorgabe von `edgeInset`).
pub const EDGE_INSET: f64 = 0.05;
/// Obergrenzen gegen Eingabefehler (ein Geländer von 100 km Länge): Pfosten und Stäbe je Geländer.
const MAX_POSTS: f64 = 5_000.0;
const MAX_BARS: f64 = 20_000.0;
/// Pfosten: Kantenlänge (m, Vorgabe von `postSize`); Fussschiene: Breite, Höhe und Lage über dem Fuss (m); Obergurt ohne
/// Handlauf (m); Zwischenholm (Kantenlänge, m); höchstens so viele Zwischenholme.
const POST_SIZE: f64 = 0.03;
const FOOT_W: f64 = 0.03;
const FOOT_Z: (f64, f64) = (0.05, 0.08);
const TOP_BAR: (f64, f64) = (0.04, 0.03);
const MID_RAIL: f64 = 0.02;
const MAX_MID_RAILS: u32 = 20;
/// [291] Knick (Grad), ab dem eine Treppen-Achse eine Ecke mit Pfosten hat (Wendel, Kropfstück: feine Teilung ohne Pfosten).
const STAIR_CORNER_DEG: f64 = 10.0;

/// Teil eines Geländers (für Farbe, Schnittfüllung und Menge).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Part {
    Post,
    Bar,
    /// Handlauf bzw. Obergurt.
    Rail,
    /// Fussschiene.
    Foot,
    /// [291] Zwischenholm.
    Mid,
    /// Tafel: Glas, Lochblech oder massive Brüstung.
    Fill,
}

/// Ein Prisma des Geländers (lotrecht; mit `slope` geschert).
#[derive(Clone, Debug)]
pub struct Piece {
    /// Querschnitt im Grundriss (Gegenuhrzeigersinn).
    pub outline: Vec<P>,
    /// Unter- und Oberkante (absolut; mit `slope` am Ursprung der Neigungsebene).
    pub z0: f64,
    pub z1: f64,
    pub part: Part,
    /// [291] Füllung (Art der Tafel bzw. Stäbe) des Feldes, zu dem das Teil gehört.
    pub kind: RailingKind,
    /// [291] Neigungsebene `[ox, oy, gx, gy]` wie `RSlab::slope` (Treppe, geneigte Decke); `None` = waagrecht.
    pub slope: Option<[f64; 4]>,
}

impl Piece {
    /// Höhenversatz der Neigungsebene am Grundrisspunkt `q`.
    pub fn dz(&self, q: P) -> f64 {
        self.slope.as_ref().map_or(0.0, |g| crate::model::helpers::slope_dz(g, q[0], q[1]))
    }

    /// Prisma als Netz (Modell x, y, z), geschert nach `slope`.
    pub fn mesh(&self) -> (Vec<f64>, Vec<u32>) {
        let (mut pos, idx) = crate::columns3d::prism(&self.outline, self.z0, self.z1);
        if self.slope.is_some() {
            for c in pos.chunks_exact_mut(3) {
                c[2] += self.dz([c[0], c[1]]);
            }
        }
        (pos, idx)
    }

    /// Tiefste Unter- und höchste Oberkante über den Querschnitt (Hüllprisma, z. B. für den Schatten).
    pub fn z_span(&self) -> (f64, f64) {
        let (lo, hi) = self.outline.iter().fold((f64::INFINITY, f64::NEG_INFINITY), |(a, b), q| (a.min(self.dz(*q)), b.max(self.dz(*q))));
        if lo.is_finite() {
            (self.z0 + lo, self.z1 + hi)
        } else {
            (self.z0, self.z1)
        }
    }
}

/// Aufgelöste Masse eines Geländers (Vorgaben eingesetzt, Unsinn begrenzt).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Spec {
    pub kind: RailingKind,
    pub height: f64,
    /// Absolute Höhe des Fusses (gebunden an eine Treppe: tiefster Punkt).
    pub z0: f64,
    /// [291] Höchster Fusspunkt (waagrecht = `z0`).
    pub z0_max: f64,
    pub thickness: f64,
    /// Achsabstand der Stäbe (nach der 12-cm-Regel begrenzt).
    pub bar_spacing: f64,
    pub bar_size: f64,
    pub handrail: bool,
    pub handrail_size: f64,
    /// [291] Oberkante des Handlaufs über dem Fuss (Vorgabe `height`).
    pub handrail_top: f64,
    pub round: bool,
    /// [291] Pfosten sichtbar, grösster Abstand, Querschnitt.
    pub posts: bool,
    pub post_gap: f64,
    pub post_size: f64,
    pub mid_rails: u32,
}

impl Spec {
    /// Oberkante (absolut, höchster Punkt).
    pub fn top(&self) -> f64 {
        self.z0_max + self.top_rel()
    }

    /// Oberkante über dem Fuss (Füllung bzw. Handlauf, was höher liegt).
    pub fn top_rel(&self) -> f64 {
        if self.handrail {
            self.height.max(self.handrail_top)
        } else {
            self.height
        }
    }

    /// Oberkante des Handlaufs bzw. Obergurts über dem Fuss.
    pub fn rail_top(&self) -> f64 {
        if self.handrail {
            self.handrail_top
        } else {
            self.height
        }
    }

    /// Oberkante der Füllung über dem Fuss: unter einem Handlauf obenauf, sonst `height`.
    pub fn fill_top(&self) -> f64 {
        if self.has_rail() && self.rail_top() >= self.height - 1e-9 {
            self.rail_top() - self.rail_h()
        } else {
            self.height
        }
    }

    /// Höhe des Handlaufs bzw. Obergurts (die Füllung endet darunter).
    pub fn rail_h(&self) -> f64 {
        if self.handrail {
            self.handrail_size
        } else if self.kind == RailingKind::Bars {
            TOP_BAR.1
        } else {
            0.0
        }
    }

    /// Breite des Handlaufs bzw. Obergurts.
    pub fn rail_w(&self) -> f64 {
        if self.handrail {
            self.handrail_size
        } else {
            TOP_BAR.0
        }
    }

    /// Hat das Geländer einen Handlauf als eigenes Teil (Stäbe immer: Handlauf oder Obergurt)?
    pub fn has_rail(&self) -> bool {
        self.handrail || self.kind == RailingKind::Bars
    }
}

/// Vorgabe der Dicke je Art.
pub fn default_thickness(kind: RailingKind) -> f64 {
    match kind {
        RailingKind::Glass => 0.02,
        RailingKind::Solid => 0.15,
        RailingKind::Perforated => 0.004,
        _ => 0.02,
    }
}

/// Handlauf vorhanden? Fehlt die Angabe: bei Stäben und Glas ja, sonst nein.
pub fn has_handrail(r: &Railing) -> bool {
    r.handrail.unwrap_or(matches!(r.kind, RailingKind::Bars | RailingKind::Glass))
}

/// [291] Pfosten sichtbar? Fehlt die Angabe: bei Stäben ja, sonst nein.
pub fn has_posts(r: &Railing) -> bool {
    r.posts.unwrap_or(matches!(r.kind, RailingKind::Bars | RailingKind::Unknown))
}

/// Fusshöhe (absolut) eines freien Geländers: Geschoss-UK + `baseOffset`.
pub fn base_z(p: &Project, r: &Railing) -> f64 {
    p.floor(&r.floor_id).map_or(0.0, |f| f.base_elevation.unwrap_or(0.0)) + base_offset(r)
}

fn base_offset(r: &Railing) -> f64 {
    r.base_offset.filter(|v| v.is_finite()).unwrap_or(0.0)
}

/// [291] Woran das Geländer gebunden ist (aufgelöst; fehlt der Träger, gilt die Polylinie `points`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Bound {
    Free,
    Stair,
    Edge,
}

/// [291] Aufgelöste Achse: Grundriss-Zug, Fusshöhe (absolut) je Punkt, Art der Bindung und ob jeder Punkt eine Ecke
/// mit Pfosten ist (frei und an Deckenkanten ja; Treppe nur ab [`STAIR_CORNER_DEG`] Knick).
#[derive(Clone, Debug)]
pub struct Path {
    pub pts: Vec<P>,
    pub foot: Vec<f64>,
    pub bound: Bound,
    pub corner_deg: f64,
}

impl Path {
    /// Geneigt (Fuss nicht überall gleich hoch)?
    pub fn sloped(&self) -> bool {
        let (lo, hi) = self.foot.iter().fold((f64::INFINITY, f64::NEG_INFINITY), |(a, b), z| (a.min(*z), b.max(*z)));
        hi - lo > 1e-9
    }

    /// Fusshöhe bei der Bogenlänge `s` (linear je Teilstrecke).
    pub fn foot_at(&self, s: f64) -> f64 {
        let mut acc = 0.0;
        for (i, w) in self.pts.windows(2).enumerate() {
            let len = seg_len(w[0], w[1]);
            if s <= acc + len || i + 2 == self.pts.len() {
                let t = if len > 1e-12 { ((s - acc) / len).clamp(0.0, 1.0) } else { 0.0 };
                return self.foot[i] + (self.foot[i + 1] - self.foot[i]) * t;
            }
            acc += len;
        }
        self.foot.first().copied().unwrap_or(0.0)
    }
}

fn seg_len(a: P, b: P) -> f64 {
    crate::jsmath::hypot2(b[0] - a[0], b[1] - a[1])
}

/// [291] Treppe eines gebundenen Geländers (Form bekannt).
pub fn bound_stair<'a>(p: &'a Project, r: &Railing) -> Option<&'a Stair> {
    let id = r.stair_id.as_deref().filter(|s| !s.is_empty())?;
    p.stairs.as_deref()?.iter().find(|s| s.id == id && s.shape != StairShape::Unknown)
}

/// [291] Decke eines an eine Kante gebundenen Geländers (Umriss mit mindestens drei Punkten).
pub fn bound_ceiling<'a>(p: &'a Project, r: &Railing) -> Option<&'a Ceiling> {
    let id = r.ceiling_id.as_deref().filter(|s| !s.is_empty())?;
    p.ceilings.as_deref()?.iter().find(|c| c.id == id && c.outline.len() >= 3)
}

/// Geländer-Code der Seite (1 links, 2 rechts in Laufrichtung, wie `stair_rail`).
fn side_code(side: Option<RailingSide>) -> u8 {
    if side == Some(RailingSide::Right) {
        2
    } else {
        1
    }
}

/// [291] Handlauf-Achse einer Treppenwange (Grundriss, Höhe absolut); `None` ohne ableitbare Geometrie.
pub fn stair_side_path(p: &Project, s: &Stair, side: Option<RailingSide>) -> Option<Vec<[f64; 3]>> {
    let params = crate::stair::decode_params(&s.encode())?;
    let (zb, zt) = p.stair_vertical_extent(s);
    if !(zt - zb > 1e-6) {
        return None;
    }
    let geo = kernel2d::stair_geometry(&params, zt - zb);
    let rail = crate::stair_rail::rails(&params, &geo, side_code(side)).into_iter().next()?;
    let mut out: Vec<[f64; 3]> = Vec::with_capacity(rail.path.len());
    for q in rail.path {
        if !(q[0].is_finite() && q[1].is_finite() && q[2].is_finite()) {
            return None;
        }
        if out.last().is_some_and(|l| (l[0] - q[0]).abs() < 1e-6 && (l[1] - q[1]).abs() < 1e-6) {
            continue;
        }
        out.push([q[0], q[1], q[2] + zb]);
    }
    (out.len() >= 2).then_some(out)
}

/// [291] Kantenzug einer Decke: Kanten `edgeIndex` … `edgeIndex + edgeCount − 1` (alle = geschlossen), um `inset` nach
/// innen versetzt.
pub fn ceiling_edge_path(c: &Ceiling, edge_index: u32, edge_count: u32, inset: f64) -> Option<Vec<P>> {
    let n = c.outline.len();
    if n < 3 || c.outline.iter().any(|q| !(q.x.is_finite() && q.y.is_finite())) {
        return None;
    }
    let i0 = edge_index as usize % n;
    let cnt = (edge_count as usize).clamp(1, n);
    let mut pts: Vec<P> = (0..=cnt).map(|k| {
        let q = &c.outline[(i0 + k) % n];
        [q.x, q.y]
    }).collect();
    pts.dedup_by(|a, b| (a[0] - b[0]).abs() < 1e-6 && (a[1] - b[1]).abs() < 1e-6);
    if pts.len() < 2 {
        return None;
    }
    // Innen = links der Kante bei Gegenuhrzeigersinn.
    let area: f64 = (0..n).map(|i| {
        let (a, b) = (&c.outline[i], &c.outline[(i + 1) % n]);
        a.x * b.y - b.x * a.y
    }).sum();
    let d = if area >= 0.0 { inset } else { -inset };
    let out = if d.abs() > 1e-9 { offset_polyline(&pts, d) } else { pts };
    out.iter().all(|q| q[0].is_finite() && q[1].is_finite()).then_some(out)
}

/// [291] Aufgelöste Achse (s. Modulkopf); `None` bei Unsinn.
pub fn path(p: &Project, r: &Railing) -> Option<Path> {
    if let Some(s) = bound_stair(p, r) {
        if let Some(q) = stair_side_path(p, s, r.stair_side) {
            let off = base_offset(r) - crate::stair_rail::RAIL_HEIGHT;
            return Some(Path { pts: q.iter().map(|v| [v[0], v[1]]).collect(), foot: q.iter().map(|v| v[2] + off).collect(), bound: Bound::Stair, corner_deg: STAIR_CORNER_DEG });
        }
    }
    if let Some(c) = bound_ceiling(p, r) {
        let inset = r.edge_inset.filter(|v| v.is_finite()).unwrap_or(EDGE_INSET).clamp(-1.0, 5.0);
        if let Some(pts) = ceiling_edge_path(c, r.edge_index.unwrap_or(0), r.edge_count.unwrap_or(1), inset) {
            let top = p.ceiling_vertical_extent(c).1 + base_offset(r);
            if top.is_finite() {
                let foot = pts.iter().map(|q| top + c.slope_dz(q[0], q[1])).collect();
                return Some(Path { pts, foot, bound: Bound::Edge, corner_deg: 0.0 });
            }
        }
    }
    let pts = axis(r)?;
    let z = base_z(p, r);
    z.is_finite().then(|| Path { foot: vec![z; pts.len()], pts, bound: Bound::Free, corner_deg: 0.0 })
}

/// [291] Grundriss-Achse (aufgelöst, s. [`path`]).
pub fn axis_of(p: &Project, r: &Railing) -> Option<Vec<P>> {
    path(p, r).map(|a| a.pts)
}

/// [291] Geländer-Code einer Treppe (0 keins, 1 links, 2 rechts, 3 beide) nach ihrem Typ, ohne die Seiten, an die ein
/// Geländer gebunden ist (dessen Darstellung gilt dort).
pub fn stair_code(p: &Project, s: &Stair) -> u8 {
    let code = match p.stair_type(s).and_then(|t| t.railing) {
        Some(StairTypeRailing::Links) => 1,
        Some(StairTypeRailing::Rechts) => 2,
        Some(StairTypeRailing::Beide) => 3,
        _ => 0,
    };
    code & !bound_mask(p, &s.id)
}

/// [291] Seiten einer Treppe mit gebundenem Geländer (Bit 1 links, Bit 2 rechts).
pub fn bound_mask(p: &Project, stair_id: &str) -> u8 {
    p.railings.as_deref().unwrap_or(&[]).iter().filter(|r| r.stair_id.as_deref() == Some(stair_id)).fold(0, |m, r| m | side_code(r.stair_side))
}

/// Aufgelöste Masse; `None` bei Unsinn (nicht endliche Höhe, Höhe ≤ 0, weniger als 2 Punkte).
pub fn spec(p: &Project, r: &Railing) -> Option<Spec> {
    spec_on(r, &path(p, r)?)
}

fn spec_on(r: &Railing, path: &Path) -> Option<Spec> {
    let height = r.height;
    if !(height.is_finite() && height > 0.0) || height > 20.0 {
        return None;
    }
    let (z0, z0_max) = path.foot.iter().fold((f64::INFINITY, f64::NEG_INFINITY), |(a, b), z| (a.min(*z), b.max(*z)));
    if !(z0.is_finite() && z0_max.is_finite()) {
        return None;
    }
    let dim = |v: Option<f64>, d: f64, lo: f64, hi: f64| v.filter(|v| v.is_finite() && *v > 0.0).map_or(d, |v| v.clamp(lo, hi));
    let bar_size = dim(r.bar_size, 0.014, 0.004, 0.1);
    // Lichtes Mass ≤ 12 cm: Achsabstand höchstens 12 cm plus Stabbreite.
    let bar_spacing = dim(r.bar_spacing, 0.12, 0.03, 1.0).min(MAX_CLEAR_GAP + bar_size);
    let handrail_size = dim(r.handrail_size, 0.04, 0.02, 0.15).min(height / 2.0);
    Some(Spec {
        kind: if r.kind == RailingKind::Unknown { RailingKind::Bars } else { r.kind },
        height,
        z0,
        z0_max,
        thickness: dim(r.thickness, default_thickness(r.kind), 0.002, 1.0),
        bar_spacing,
        bar_size,
        handrail: has_handrail(r),
        handrail_size,
        handrail_top: dim(r.handrail_height, height, handrail_size.max(0.1), 20.0),
        round: r.handrail_profile == Some(RailingProfile::Round),
        posts: has_posts(r),
        post_gap: dim(r.post_spacing, POST_GAP, 0.2, 20.0),
        post_size: dim(r.post_size, POST_SIZE, 0.01, 0.3),
        mid_rails: r.mid_rails.unwrap_or(0).min(MAX_MID_RAILS),
    })
}

/// Achse aus den Punkten `points` als Zug: aufeinanderfolgende gleiche Punkte entfallen, ein geschlossener Zug endet auf
/// seinem Anfang; `None` bei weniger als zwei verschiedenen Punkten oder nicht endlichen Koordinaten. Gebundene
/// Geländer: [`axis_of`].
pub fn axis(r: &Railing) -> Option<Vec<P>> {
    let mut pts: Vec<P> = Vec::with_capacity(r.points.len() + 1);
    for q in &r.points {
        if !q.x.is_finite() || !q.y.is_finite() {
            return None;
        }
        let q = [q.x, q.y];
        if pts.last().is_none_or(|l| (l[0] - q[0]).abs() > 1e-6 || (l[1] - q[1]).abs() > 1e-6) {
            pts.push(q);
        }
    }
    if pts.len() < 2 {
        return None;
    }
    // Ein Punkt am Ende gleich dem Anfang schliesst den Zug (mit mindestens drei Ecken).
    if r.closed == Some(true) && pts.len() >= 3 && !is_closed(&pts) {
        pts.push(pts[0]);
    }
    Some(pts)
}

/// Länge der Achse (m).
pub fn length(axis: &[P]) -> f64 {
    axis.windows(2).map(|w| seg_len(w[0], w[1])).sum()
}

/// Streifen der Breite `2·half` um die Achse mit Gehrung: ein Viereck je Teilstrecke (gemeinsame Gehrungskanten,
/// Gegenuhrzeigersinn), dazu die Ränder links und rechts der Laufrichtung.
pub fn strips(axis: &[P], half: f64) -> (Vec<Vec<P>>, Vec<P>, Vec<P>) {
    let (quads, l, r) = seg_quads(axis, half);
    (quads.into_iter().flatten().collect(), l, r)
}

/// Wie [`strips`], die Vierecke je Teilstrecke (entartete `None`).
fn seg_quads(axis: &[P], half: f64) -> (Vec<Option<Vec<P>>>, Vec<P>, Vec<P>) {
    let (l, r) = (offset_polyline(axis, half), offset_polyline(axis, -half));
    let quads = (0..axis.len().saturating_sub(1))
        .map(|i| vec![r[i], r[i + 1], l[i + 1], l[i]])
        .map(|q| (area(&q).abs() > 1e-10 && q.iter().all(|v| v[0].is_finite() && v[1].is_finite())).then_some(q))
        .collect();
    (quads, l, r)
}

fn area(q: &[P]) -> f64 {
    let n = q.len();
    (0..n).map(|i| q[i][0] * q[(i + 1) % n][1] - q[(i + 1) % n][0] * q[i][1]).sum::<f64>() / 2.0
}

/// Quadrat der Kantenlänge `s` um `c`, in Richtung `d` (Einheit) gedreht (Gegenuhrzeigersinn).
fn square(c: P, d: P, s: f64) -> Vec<P> {
    let (h, n) = (s / 2.0, [-d[1], d[0]]);
    let at = |a: f64, b: f64| [c[0] + d[0] * a + n[0] * b, c[1] + d[1] * a + n[1] * b];
    vec![at(-h, -h), at(h, -h), at(h, h), at(-h, h)]
}

/// Eine Pfosten- oder Stabstelle: Lage, Richtung der Teilstrecke, Bogenlänge ab dem Anfang der Achse.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Station {
    pub at: P,
    pub dir: P,
    pub s: f64,
}

/// Strecken zwischen zwei Ecken: Bereiche von Teilstrecken-Indizes (frei/Deckenkante: jede Teilstrecke; Treppe: Knick
/// ab `corner_deg`).
fn runs(axis: &[P], corner_deg: f64) -> Vec<std::ops::Range<usize>> {
    let nseg = axis.len().saturating_sub(1);
    let dir = |i: usize| {
        let (a, b) = (axis[i], axis[i + 1]);
        let l = seg_len(a, b);
        (l > 1e-12).then(|| [(b[0] - a[0]) / l, (b[1] - a[1]) / l])
    };
    let cos_tol = (corner_deg.to_radians()).cos();
    let mut out = Vec::new();
    let mut start = 0;
    for i in 1..nseg {
        let corner = corner_deg <= 0.0 || matches!((dir(i - 1), dir(i)), (Some(a), Some(b)) if a[0] * b[0] + a[1] * b[1] < cos_tol);
        if corner {
            out.push(start..i);
            start = i;
        }
    }
    if start < nseg {
        out.push(start..nseg);
    }
    out
}

/// Pfosten- und Stabstellen längs der Achse. Pfosten an jeder Ecke (s. [`runs`]) und höchstens `post_gap` auseinander
/// (gleiche Felder je Strecke), Stäbe gleichmässig dazwischen, nicht nahe an einem Pfosten.
pub fn stations(axis: &[P], spec: &Spec) -> (Vec<Station>, Vec<Station>) {
    stations_with(axis, spec, 0.0)
}

fn stations_with(axis: &[P], spec: &Spec, corner_deg: f64) -> (Vec<Station>, Vec<Station>) {
    let total = length(axis);
    let (mut posts, mut bars) = (Vec::new(), Vec::new());
    if !total.is_finite() || total / spec.post_gap > MAX_POSTS {
        return (posts, bars);
    }
    let with_bars = total / spec.bar_spacing.max(1e-3) <= MAX_BARS;
    let closed = is_closed(axis);
    let nseg = axis.len() - 1;
    let seg: Vec<f64> = axis.windows(2).map(|w| seg_len(w[0], w[1])).collect();
    let mut cum = vec![0.0; nseg + 1];
    for i in 0..nseg {
        cum[i + 1] = cum[i] + seg[i];
    }
    for run in runs(axis, corner_deg) {
        let len = cum[run.end] - cum[run.start];
        if len < 1e-9 {
            continue;
        }
        // Stelle beim Anteil `t` der Strecke (eine Teilstrecke: genau linear in `t`).
        let at = |t: f64| -> Station {
            let i = if run.len() == 1 { run.start } else { (run.start..run.end).find(|&i| cum[i + 1] >= cum[run.start] + t * len - 1e-12 && seg[i] > 1e-12).unwrap_or(run.end - 1) };
            let w = (axis[i], axis[i + 1]);
            let u = if run.len() == 1 { t } else if seg[i] > 1e-12 { ((cum[run.start] + t * len - cum[i]) / seg[i]).clamp(0.0, 1.0) } else { 0.0 };
            let l = seg[i].max(1e-12);
            Station { at: [w.0[0] + (w.1[0] - w.0[0]) * u, w.0[1] + (w.1[1] - w.0[1]) * u], dir: [(w.1[0] - w.0[0]) / l, (w.1[1] - w.0[1]) / l], s: cum[i] + u * seg[i] }
        };
        let n_post = (len / spec.post_gap).ceil().max(1.0) as usize;
        // Letzter Eckpfosten nur am offenen Ende (geschlossen: der Anfang steht schon).
        for k in 0..n_post + usize::from(run.end == nseg && !closed) {
            posts.push(at(k as f64 / n_post as f64));
        }
        if with_bars {
            let n_bar = (len / spec.bar_spacing).round().max(1.0) as usize;
            let gap = len / n_post as f64;
            for k in 1..n_bar {
                let t = k as f64 / n_bar as f64;
                let f = (t * n_post as f64).fract();
                if f.min(1.0 - f) * gap > spec.post_size / 2.0 + spec.bar_size / 2.0 + 0.01 {
                    bars.push(at(t));
                }
            }
        }
    }
    (posts, bars)
}

/// [291] Pfostenstellen einer aufgelösten Achse (Ecken nach ihrer Bindung).
pub fn post_stations(path: &Path, spec: &Spec) -> Vec<Station> {
    stations_with(&path.pts, spec, path.corner_deg).0
}

/// [291] Feld-Nummer an der Bogenlänge `s` (Pfosten-Stellen `posts`, aufsteigend).
fn field_of(posts: &[Station], s: f64) -> usize {
    posts.iter().filter(|q| q.s <= s + 1e-9).count().saturating_sub(1)
}

/// Prismen des Geländers; leer bei Unsinn.
pub fn pieces(p: &Project, r: &Railing) -> Vec<Piece> {
    let Some(path) = path(p, r) else { return Vec::new() };
    let Some(s) = spec_on(r, &path) else { return Vec::new() };
    let ax = &path.pts;
    let sloped = path.sloped();
    let (posts, bars) = stations_with(ax, &s, path.corner_deg);
    let overrides: Vec<(usize, RailingKind)> = r.fields.iter().flatten().filter(|f| f.kind != RailingKind::Unknown).map(|f| (f.index as usize, f.kind)).collect();
    let kind_at = |sv: f64| -> RailingKind {
        if overrides.is_empty() {
            return s.kind;
        }
        let k = field_of(&posts, sv);
        overrides.iter().rev().find(|(i, _)| *i == k).map_or(s.kind, |(_, kind)| *kind)
    };
    let nseg = ax.len() - 1;
    let mut cum = vec![0.0; nseg + 1];
    for i in 0..nseg {
        cum[i + 1] = cum[i] + seg_len(ax[i], ax[i + 1]);
    }
    // Teilstrecke i: Neigungsebene und Fusshöhe an ihrem Anfang.
    let seg_base = |i: usize| -> (f64, Option<[f64; 4]>) {
        if !sloped {
            return (s.z0, None);
        }
        let (a, b) = (ax[i], ax[i + 1]);
        let (za, zb) = (path.foot[i], path.foot[i + 1]);
        let l2 = (b[0] - a[0]).powi(2) + (b[1] - a[1]).powi(2);
        if (zb - za).abs() < 1e-12 || l2 < 1e-18 {
            return (za, None);
        }
        let k = (zb - za) / l2;
        (za, Some([a[0], a[1], k * (b[0] - a[0]), k * (b[1] - a[1])]))
    };
    // Teilbereiche [ta, tb] je Teilstrecke mit gleicher Füllung (ohne Abweichungen je Feld: die ganze Teilstrecke).
    let spans: Vec<Vec<(f64, f64, RailingKind)>> = (0..nseg)
        .map(|i| {
            let (s0, s1) = (cum[i], cum[i + 1]);
            if overrides.is_empty() || s1 - s0 < 1e-12 {
                return vec![(0.0, 1.0, s.kind)];
            }
            let mut cuts: Vec<f64> = vec![s0];
            cuts.extend(posts.iter().map(|q| q.s).filter(|&v| v > s0 + 1e-9 && v < s1 - 1e-9));
            cuts.push(s1);
            let mut out: Vec<(f64, f64, RailingKind)> = Vec::new();
            for w in cuts.windows(2) {
                let k = kind_at((w[0] + w[1]) / 2.0);
                let (ta, tb) = ((w[0] - s0) / (s1 - s0), (w[1] - s0) / (s1 - s0));
                match out.last_mut() {
                    Some(l) if l.2 == k => l.1 = tb,
                    _ => out.push((ta, tb, k)),
                }
            }
            if let Some(l) = out.last_mut() {
                l.1 = 1.0;
            }
            out
        })
        .collect();
    let lerp = |a: P, b: P, t: f64| [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    let sub = |q: &[P], ta: f64, tb: f64| -> Vec<P> {
        if ta <= 0.0 && tb >= 1.0 {
            q.to_vec()
        } else {
            vec![lerp(q[0], q[1], ta), lerp(q[0], q[1], tb), lerp(q[3], q[2], tb), lerp(q[3], q[2], ta)]
        }
    };
    // Streifen der Breite 2·half von rel0 bis rel1 über dem Fuss, nur in Teilbereichen, deren Füllung `want` erfüllt.
    let strip_pieces = |half: f64, rel0: f64, rel1: f64, part: Part, want: &dyn Fn(RailingKind) -> bool, out: &mut Vec<Piece>| {
        if rel1 - rel0 <= 1e-6 {
            return;
        }
        let quads = seg_quads(ax, half).0;
        for (i, q) in quads.iter().enumerate() {
            let Some(q) = q else { continue };
            let (base, slope) = seg_base(i);
            for &(ta, tb, kind) in &spans[i] {
                if want(kind) && tb - ta > 1e-9 {
                    out.push(Piece { outline: sub(q, ta, tb), z0: base + rel0, z1: base + rel1, part, kind, slope });
                }
            }
        }
    };
    let is_bars = |k: RailingKind| matches!(k, RailingKind::Bars | RailingKind::Unknown);
    let mut out = Vec::new();
    let fill_top = s.fill_top();
    let post_top = if s.has_rail() { fill_top.max(s.rail_top() - s.rail_h()) } else { fill_top };
    let foot = |st: &Station| if sloped { path.foot_at(st.s) } else { s.z0 };
    if s.posts {
        for st in &posts {
            let z = foot(st);
            out.push(Piece { outline: square(st.at, st.dir, s.post_size), z0: z, z1: z + post_top, part: Part::Post, kind: kind_at(st.s), slope: None });
        }
    }
    for st in bars.iter().filter(|st| is_bars(kind_at(st.s))) {
        let z = foot(st);
        out.push(Piece { outline: square(st.at, st.dir, s.bar_size), z0: z + FOOT_Z.1, z1: z + fill_top, part: Part::Bar, kind: RailingKind::Bars, slope: None });
    }
    strip_pieces(FOOT_W / 2.0, FOOT_Z.0, FOOT_Z.1, Part::Foot, &is_bars, &mut out);
    // Tafeln je Füllung (eigene Dicke, wenn die Füllung des Feldes von `kind` abweicht).
    for k in [RailingKind::Glass, RailingKind::Solid, RailingKind::Perforated] {
        let th = if k == s.kind { s.thickness } else { default_thickness(k) };
        strip_pieces(th / 2.0, 0.0, fill_top, Part::Fill, &|x| x == k, &mut out);
    }
    if s.mid_rails > 0 {
        let lo = if is_bars(s.kind) { FOOT_Z.1 } else { 0.0 };
        let n = s.mid_rails;
        for k in 1..=n {
            let zc = lo + (fill_top - lo) * k as f64 / (n + 1) as f64;
            strip_pieces(MID_RAIL / 2.0, zc - MID_RAIL / 2.0, zc + MID_RAIL / 2.0, Part::Mid, &|_| true, &mut out);
        }
    }
    if s.has_rail() {
        let (top, h, w) = (s.rail_top(), s.rail_h(), s.rail_w());
        if s.round && s.handrail {
            // Rund: drei Stufen (Achteck angenähert), damit die Körper Prismen bleiben.
            for (a, b, f) in [(0.0, 0.25, 0.7), (0.25, 0.75, 1.0), (0.75, 1.0, 0.7)] {
                strip_pieces(w * f / 2.0, top - h + a * h, top - h + b * h, Part::Rail, &|_| true, &mut out);
            }
        } else {
            strip_pieces(w / 2.0, top - h, top, Part::Rail, &|_| true, &mut out);
        }
    }
    out
}

/// [291] Hülle für die Auswahl: je Teilstrecke ein Streifen der halben Breite `half` von Fuss bis Oberkante
/// `(Umriss, z_unten, z_oben, Neigungsebene)`.
pub fn hull(p: &Project, r: &Railing, half: f64) -> Vec<(Vec<P>, f64, f64, Option<[f64; 4]>)> {
    let Some(path) = path(p, r) else { return Vec::new() };
    let Some(s) = spec_on(r, &path) else { return Vec::new() };
    let ax = &path.pts;
    seg_quads(ax, half)
        .0
        .into_iter()
        .enumerate()
        .filter_map(|(i, q)| {
            let q = q?;
            let (a, b, za, zb) = (ax[i], ax[i + 1], path.foot[i], path.foot[i + 1]);
            let l2 = (b[0] - a[0]).powi(2) + (b[1] - a[1]).powi(2);
            let slope = ((zb - za).abs() > 1e-12 && l2 > 1e-18).then(|| {
                let k = (zb - za) / l2;
                [a[0], a[1], k * (b[0] - a[0]), k * (b[1] - a[1])]
            });
            Some((q, za, za + s.top_rel(), slope))
        })
        .collect()
}

/// Anzahl Stäbe und Pfosten (Kennzahl der Objekt-Info).
pub fn counts(p: &Project, r: &Railing) -> (usize, usize) {
    let pcs = pieces(p, r);
    (pcs.iter().filter(|q| q.part == Part::Bar).count(), pcs.iter().filter(|q| q.part == Part::Post).count())
}

/// Kennzahlen für die Objekt-Info: Länge der Achse, absolute Fuss- und Oberkante, Stäbe, Pfosten, Fläche der Ansicht (m²),
/// [291] Felder, Bindung (`"stair"`, `"edge"` oder `null`) und aufgelöste Achse `axis` (`[[x, y], …]`); `None` für ein unbekanntes oder unsinniges Geländer.
pub fn info(p: &Project, id: &str) -> Option<serde_json::Value> {
    let r = p.railings.as_deref()?.iter().find(|r| r.id == id)?;
    let path = path(p, r)?;
    let s = spec_on(r, &path)?;
    let len = length(&path.pts);
    let (bars, posts) = counts(p, r);
    let fields = stations_with(&path.pts, &s, path.corner_deg).0.len().saturating_sub(usize::from(!is_closed(&path.pts)));
    let bound = match path.bound {
        Bound::Stair => serde_json::json!("stair"),
        Bound::Edge => serde_json::json!("edge"),
        Bound::Free => serde_json::Value::Null,
    };
    Some(serde_json::json!({"length": len, "baseZ": s.z0, "topZ": s.top(), "height": s.height, "bars": bars, "posts": posts, "fields": fields, "area": len * s.height, "closed": is_closed(&path.pts), "bound": bound, "axis": path.pts}))
}

/// Anzeigename für Regeln und Listen (`railing_label`): Art und Länge.
pub fn label(r: &Railing) -> String {
    let kind = match r.kind {
        RailingKind::Glass => "Glasgeländer",
        RailingKind::Solid => "Brüstung",
        RailingKind::Perforated => "Lochblechgeländer",
        _ => "Stabgeländer",
    };
    let len = axis(r).map_or(0.0, |a| length(&a));
    format!("{kind} {} m", crate::js_fmt::js_number((len * 100.0).round() / 100.0))
}

/// Farbe eines Teils im 3D und in der Ansicht (Bauteil-Farbe der massiven Brüstung, sonst nach Art).
pub fn color(p: &Project, r: &Railing, part: Part) -> [f64; 3] {
    color_of(p, r, part, r.kind)
}

/// [291] Farbe eines Teils mit der Füllung `kind` seines Feldes.
pub fn color_of(p: &Project, r: &Railing, part: Part, kind: RailingKind) -> [f64; 3] {
    let hex = |h: &str, d: [f64; 3]| crate::style::hex_to_rgb(h, d);
    match (kind, part) {
        (RailingKind::Glass, Part::Fill) => hex("#b7d3e0", [0.72, 0.83, 0.88]),
        (RailingKind::Perforated, Part::Fill) => hex("#9aa3ab", [0.6, 0.64, 0.67]),
        (RailingKind::Solid, Part::Fill) => {
            let d = [0.72, 0.71, 0.68];
            r.component_id.as_deref().and_then(|id| p.component(id)).map_or(d, |k| hex(&k.color, d))
        }
        _ => hex("#74797f", [0.45, 0.47, 0.5]),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rail(kind: RailingKind, pts: &[(f64, f64)]) -> Railing {
        Railing { id: "g".into(), r#type: "railing".into(), floor_id: "eg".into(), category_code: CATEGORY.into(), points: pts.iter().map(|&(x, y)| Vec2 { x, y }).collect(), height: 1.0, kind, ..Default::default() }
    }

    fn proj() -> Project {
        let mut p = Project::default();
        p.drawing_levels.push(DrawingLevel { id: "eg".into(), kind: DrawingLevelKind::Floor, base_elevation: Some(3.0), ..Default::default() });
        p
    }

    #[test]
    fn spec_vorgaben_und_unsinn() {
        let p = proj();
        let s = spec(&p, &rail(RailingKind::Bars, &[(0.0, 0.0), (3.0, 0.0)])).unwrap();
        assert_eq!((s.height, s.z0, s.top()), (1.0, 3.0, 4.0));
        assert!(s.handrail && s.has_rail());
        // Lichtes Mass höchstens 12 cm: Achsabstand ≤ 0.12 + Stabbreite.
        let mut g = rail(RailingKind::Bars, &[(0.0, 0.0), (3.0, 0.0)]);
        g.bar_spacing = Some(0.5);
        let s = spec(&p, &g).unwrap();
        assert!(s.bar_spacing - s.bar_size <= MAX_CLEAR_GAP + 1e-12);
        // Basis relativ zum Geschoss.
        g.base_offset = Some(0.18);
        assert!((spec(&p, &g).unwrap().z0 - 3.18).abs() < 1e-12);
        // Unsinn.
        for bad in [rail(RailingKind::Bars, &[(0.0, 0.0)]), rail(RailingKind::Bars, &[(1.0, 1.0), (1.0, 1.0)]), rail(RailingKind::Bars, &[(0.0, 0.0), (f64::NAN, 1.0)]), Railing { height: 0.0, ..rail(RailingKind::Glass, &[(0.0, 0.0), (1.0, 0.0)]) }, Railing { height: f64::INFINITY, ..rail(RailingKind::Glass, &[(0.0, 0.0), (1.0, 0.0)]) }] {
            assert!(spec(&p, &bad).is_none() && pieces(&p, &bad).is_empty());
        }
        // Handlauf: Vorgabe je Art, ausdrückliche Angabe gewinnt.
        assert!(!has_handrail(&rail(RailingKind::Solid, &[(0.0, 0.0), (1.0, 0.0)])));
        assert!(has_handrail(&Railing { handrail: Some(true), ..rail(RailingKind::Solid, &[(0.0, 0.0), (1.0, 0.0)]) }));
        assert!(!has_handrail(&Railing { handrail: Some(false), ..rail(RailingKind::Bars, &[(0.0, 0.0), (1.0, 0.0)]) }));
    }

    #[test]
    fn staebe_pfosten_und_masse() {
        let p = proj();
        let r = rail(RailingKind::Bars, &[(0.0, 0.0), (3.0, 0.0)]);
        let pcs = pieces(&p, &r);
        let n = |part| pcs.iter().filter(|q| q.part == part).count();
        // 3 m: 3 Felder à 1 m → 4 Pfosten, 1 Fussschiene, 1 Handlauf.
        assert_eq!((n(Part::Post), n(Part::Foot), n(Part::Rail)), (4, 1, 1));
        // Stäbe: gleichmässig, lichtes Mass ≤ 12 cm (Achsabstand ≈ 0.12: ≥ 24 Stäbe).
        assert!(n(Part::Bar) >= 24, "{}", n(Part::Bar));
        assert_eq!(counts(&p, &r), (n(Part::Bar), 4));
        // Oberkante = Fuss + Höhe; alle Teile im Höhenbereich.
        let z1 = pcs.iter().map(|q| q.z1).fold(f64::MIN, f64::max);
        let z0 = pcs.iter().map(|q| q.z0).fold(f64::MAX, f64::min);
        assert!((z1 - 4.0).abs() < 1e-12 && (z0 - 3.0).abs() < 1e-12);
        // Querschnitte im Gegenuhrzeigersinn.
        assert!(pcs.iter().all(|q| area(&q.outline) > 0.0));
        // Der Abstand zweier Stäbe ist (lichtes Mass) höchstens 12 cm.
        let mut xs: Vec<f64> = pcs.iter().filter(|q| q.part == Part::Bar).map(|q| q.outline.iter().map(|v| v[0]).sum::<f64>() / 4.0).collect();
        xs.sort_by(f64::total_cmp);
        assert!(xs.windows(2).all(|w| w[1] - w[0] - 0.014 <= 0.1201), "{xs:?}");
    }

    #[test]
    fn tafel_mit_gehrung_und_geschlossen() {
        let p = proj();
        let r = rail(RailingKind::Glass, &[(0.0, 0.0), (2.0, 0.0), (2.0, 2.0)]);
        let pcs = pieces(&p, &r);
        // Zwei Tafel-Streifen (je Teilstrecke) und ein Handlauf-Streifen je Teilstrecke.
        assert_eq!(pcs.iter().filter(|q| q.part == Part::Fill).count(), 2);
        assert_eq!(pcs.iter().filter(|q| q.part == Part::Rail).count(), 2);
        // Gehrung: die beiden Streifen teilen die Gehrungskante, die Summe der Flächen = Länge × Dicke ohne Überlappung.
        let a: f64 = pcs.iter().filter(|q| q.part == Part::Fill).map(|q| area(&q.outline)).sum();
        assert!((a - 4.0 * 0.02).abs() < 1e-3, "{a}");
        // Glas bis unter den Handlauf.
        let fill = pcs.iter().find(|q| q.part == Part::Fill).unwrap();
        assert!((fill.z1 - (4.0 - 0.04)).abs() < 1e-12);
        // Geschlossen: ein Zug mit Anfang = Ende, vier Streifen.
        let mut sq = rail(RailingKind::Solid, &[(0.0, 0.0), (2.0, 0.0), (2.0, 2.0), (0.0, 2.0)]);
        sq.closed = Some(true);
        assert_eq!(pieces(&p, &sq).iter().filter(|q| q.part == Part::Fill).count(), 4);
        // Brüstung ohne Handlauf: Tafel bis zur Oberkante.
        let top = pieces(&p, &sq).iter().map(|q| q.z1).fold(f64::MIN, f64::max);
        assert!((top - 4.0).abs() < 1e-12);
    }

    #[test]
    fn riesig_gibt_keine_millionen_stuecke() {
        let p = proj();
        let r = rail(RailingKind::Bars, &[(0.0, 0.0), (1.0e6, 0.0)]);
        assert!(pieces(&p, &r).len() < 10);
        let r = rail(RailingKind::Bars, &[(0.0, 0.0), (3000.0, 0.0)]);
        let n = pieces(&p, &r).len();
        assert!(n > 2000 && n < 30_000, "{n}");
    }
}

#[cfg(test)]
#[path = "railing_tests.rs"]
mod view_tests;

#[cfg(test)]
#[path = "railing_bound_tests.rs"]
mod bound_tests;
