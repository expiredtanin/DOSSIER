//! [279] Geländer als eigenes Bauteil (`Project.railings`): Absturzsicherung für Balkon, Galerie, Treppenauge und
//! Terrasse. **Eine Quelle** für die Körper: [`pieces`] zerlegt ein Geländer in lotrechte Prismen
//! `(Querschnitt, z_unten, z_oben, Teil)` wie `model3d::column_pieces` bei den Stützen. Daraus entstehen das 3D-Netz
//! (`model3d/railings.rs`), die Platten für Schnitt, Ansicht und 3D-Dokument (`model3d::railing_slabs`), die
//! IFC-Mengen (`ifc_data.rs`) und die Netze der Auswahl. Der Grundriss (`plan/railings.rs`) zeichnet die Achse und
//! die Streifen ([`strips`]) selbst. Teile, Masse und Obergrenzen:
//!
//! - **Achse:** Polylinie `points` (offen; mit `closed` oder letzter = erster Punkt geschlossen), Gehrungen an den
//!   Ecken über [`crate::stair_rail::offset_polyline`] — dieselbe Hilfe wie die Treppen-Handläufe und die
//!   Absturzsicherung am Deckenloch ([`crate::stair_guard`], [`crate::stairs3d::guard_mesh`]).
//! - **Stäbe:** Pfosten an den Ecken und höchstens [`POST_GAP`] auseinander, Stäbe im Achsabstand `barSpacing`
//!   (lichtes Mass höchstens [`MAX_CLEAR_GAP`] = 12 cm nach SIA 358: der Abstand wird bei Bedarf verkleinert),
//!   Fussschiene und Handlauf bzw. Obergurt.
//! - **Glas, Lochblech, massive Brüstung:** durchgehende Tafel der Dicke `thickness` (mit Gehrung); Handlauf obenauf.
//! - **Höhe:** Fuss = Geschoss-UK + `baseOffset`, Oberkante = Fuss + `height` (Vorgabe [`DEFAULT_HEIGHT`] = 1.00 m).

use crate::model::*;
use crate::stair_rail::{is_closed, offset_polyline, P};

/// Vorgabehöhe (m) nach SIA 358 (Absturzsicherung bis 12 m Fallhöhe: 1.00 m).
pub const DEFAULT_HEIGHT: f64 = 1.0;
/// Kategorie (Ebene) neuer Geländer.
pub const CATEGORY: &str = "41";
/// Pick-Id im Grundriss/Schnitt (`contextObjectId = "@railing:<id>"`), wie bei den Bäumen.
pub const PICK_PREFIX: &str = "@railing:";
/// Pfostenabstand (m) und höchstes lichtes Mass zwischen Stäben (m, SIA 358).
pub const POST_GAP: f64 = 1.2;
pub const MAX_CLEAR_GAP: f64 = 0.12;
/// Obergrenzen gegen Eingabefehler (ein Geländer von 100 km Länge): Pfosten und Stäbe je Geländer.
const MAX_POSTS: f64 = 5_000.0;
const MAX_BARS: f64 = 20_000.0;
/// Pfosten: Kantenlänge (m); Fussschiene: Breite, Höhe und Lage über dem Fuss (m); Obergurt ohne Handlauf (m).
const POST_SIZE: f64 = 0.03;
const FOOT_W: f64 = 0.03;
const FOOT_Z: (f64, f64) = (0.05, 0.08);
const TOP_BAR: (f64, f64) = (0.04, 0.03);

/// Teil eines Geländers (für Farbe, Schnittfüllung und Menge).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Part {
    Post,
    Bar,
    /// Handlauf bzw. Obergurt.
    Rail,
    /// Fussschiene.
    Foot,
    /// Tafel: Glas, Lochblech oder massive Brüstung.
    Fill,
}

/// Ein lotrechtes Prisma des Geländers.
#[derive(Clone, Debug)]
pub struct Piece {
    /// Querschnitt im Grundriss (Gegenuhrzeigersinn).
    pub outline: Vec<P>,
    pub z0: f64,
    pub z1: f64,
    pub part: Part,
}

/// Aufgelöste Masse eines Geländers (Vorgaben eingesetzt, Unsinn begrenzt).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Spec {
    pub kind: RailingKind,
    pub height: f64,
    /// Absolute Höhe des Fusses.
    pub z0: f64,
    pub thickness: f64,
    /// Achsabstand der Stäbe (nach der 12-cm-Regel begrenzt).
    pub bar_spacing: f64,
    pub bar_size: f64,
    pub handrail: bool,
    pub handrail_size: f64,
}

impl Spec {
    /// Oberkante (absolut).
    pub fn top(&self) -> f64 {
        self.z0 + self.height
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

/// Fusshöhe (absolut): Geschoss-UK + `baseOffset`.
pub fn base_z(p: &Project, r: &Railing) -> f64 {
    p.floor(&r.floor_id).map_or(0.0, |f| f.base_elevation.unwrap_or(0.0)) + r.base_offset.filter(|v| v.is_finite()).unwrap_or(0.0)
}

/// Aufgelöste Masse; `None` bei Unsinn (nicht endliche Höhe, Höhe ≤ 0, weniger als 2 Punkte).
pub fn spec(p: &Project, r: &Railing) -> Option<Spec> {
    let height = r.height;
    if !(height.is_finite() && height > 0.0) || height > 20.0 || axis(r).is_none() {
        return None;
    }
    let z0 = base_z(p, r);
    if !z0.is_finite() {
        return None;
    }
    let dim = |v: Option<f64>, d: f64, lo: f64, hi: f64| v.filter(|v| v.is_finite() && *v > 0.0).map_or(d, |v| v.clamp(lo, hi));
    let bar_size = dim(r.bar_size, 0.014, 0.004, 0.1);
    // Lichtes Mass ≤ 12 cm: Achsabstand höchstens 12 cm plus Stabbreite.
    let bar_spacing = dim(r.bar_spacing, 0.12, 0.03, 1.0).min(MAX_CLEAR_GAP + bar_size);
    Some(Spec {
        kind: if r.kind == RailingKind::Unknown { RailingKind::Bars } else { r.kind },
        height,
        z0,
        thickness: dim(r.thickness, default_thickness(r.kind), 0.002, 1.0),
        bar_spacing,
        bar_size,
        handrail: has_handrail(r),
        handrail_size: dim(r.handrail_size, 0.04, 0.02, 0.15).min(height / 2.0),
    })
}

/// Achse als Zug: aufeinanderfolgende gleiche Punkte entfallen, ein geschlossener Zug endet auf seinem Anfang;
/// `None` bei weniger als zwei verschiedenen Punkten oder nicht endlichen Koordinaten.
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
    axis.windows(2).map(|w| crate::jsmath::hypot2(w[1][0] - w[0][0], w[1][1] - w[0][1])).sum()
}

/// Streifen der Breite `2·half` um die Achse mit Gehrung: ein Viereck je Teilstrecke (gemeinsame Gehrungskanten,
/// Gegenuhrzeigersinn), dazu die Ränder links und rechts der Laufrichtung.
pub fn strips(axis: &[P], half: f64) -> (Vec<Vec<P>>, Vec<P>, Vec<P>) {
    let (l, r) = (offset_polyline(axis, half), offset_polyline(axis, -half));
    let quads = (0..axis.len().saturating_sub(1))
        .map(|i| vec![r[i], r[i + 1], l[i + 1], l[i]])
        .filter(|q| area(q).abs() > 1e-10 && q.iter().all(|v| v[0].is_finite() && v[1].is_finite()))
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

/// Pfosten- und Stabstellen längs der Achse: `(Lage, Richtung)`. Pfosten an jedem Eck und höchstens [`POST_GAP`]
/// auseinander, Stäbe gleichmässig dazwischen, nicht nahe an einem Pfosten.
pub fn stations(axis: &[P], spec: &Spec) -> (Vec<(P, P)>, Vec<(P, P)>) {
    let total = length(axis);
    let (mut posts, mut bars) = (Vec::new(), Vec::new());
    if !total.is_finite() || total / POST_GAP > MAX_POSTS {
        return (posts, bars);
    }
    let with_bars = total / spec.bar_spacing.max(1e-3) <= MAX_BARS;
    let closed = is_closed(axis);
    let nseg = axis.len() - 1;
    for (i, w) in axis.windows(2).enumerate() {
        let len = crate::jsmath::hypot2(w[1][0] - w[0][0], w[1][1] - w[0][1]);
        if len < 1e-9 {
            continue;
        }
        let d = [(w[1][0] - w[0][0]) / len, (w[1][1] - w[0][1]) / len];
        let at = |t: f64| [w[0][0] + (w[1][0] - w[0][0]) * t, w[0][1] + (w[1][1] - w[0][1]) * t];
        let n_post = (len / POST_GAP).ceil().max(1.0) as usize;
        // Letzter Eckpfosten nur am offenen Ende (geschlossen: der Anfang steht schon).
        for k in 0..n_post + usize::from(i + 1 == nseg && !closed) {
            posts.push((at(k as f64 / n_post as f64), d));
        }
        if with_bars {
            let n_bar = (len / spec.bar_spacing).round().max(1.0) as usize;
            let gap = len / n_post as f64;
            for k in 1..n_bar {
                let t = k as f64 / n_bar as f64;
                let f = (t * n_post as f64).fract();
                if f.min(1.0 - f) * gap > POST_SIZE / 2.0 + spec.bar_size / 2.0 + 0.01 {
                    bars.push((at(t), d));
                }
            }
        }
    }
    (posts, bars)
}

/// Prismen des Geländers; leer bei Unsinn.
pub fn pieces(p: &Project, r: &Railing) -> Vec<Piece> {
    let (Some(s), Some(ax)) = (spec(p, r), axis(r)) else { return Vec::new() };
    let mut out = Vec::new();
    let top = s.top();
    let under = top - s.rail_h();
    let strip_pieces = |half: f64, z0: f64, z1: f64, part: Part, out: &mut Vec<Piece>| {
        if z1 - z0 > 1e-6 {
            out.extend(strips(&ax, half).0.into_iter().map(|outline| Piece { outline, z0, z1, part }));
        }
    };
    match s.kind {
        RailingKind::Bars | RailingKind::Unknown => {
            let (posts, bars) = stations(&ax, &s);
            for (c, d) in &posts {
                out.push(Piece { outline: square(*c, *d, POST_SIZE), z0: s.z0, z1: under, part: Part::Post });
            }
            for (c, d) in &bars {
                out.push(Piece { outline: square(*c, *d, s.bar_size), z0: s.z0 + FOOT_Z.1, z1: under, part: Part::Bar });
            }
            strip_pieces(FOOT_W / 2.0, s.z0 + FOOT_Z.0, s.z0 + FOOT_Z.1, Part::Foot, &mut out);
        }
        _ => strip_pieces(s.thickness / 2.0, s.z0, under, Part::Fill, &mut out),
    }
    if s.has_rail() {
        strip_pieces(s.rail_w() / 2.0, under, top, Part::Rail, &mut out);
    }
    out
}

/// Anzahl Stäbe und Pfosten (Kennzahl der Objekt-Info).
pub fn counts(p: &Project, r: &Railing) -> (usize, usize) {
    let (Some(s), Some(ax)) = (spec(p, r), axis(r)) else { return (0, 0) };
    if s.kind != RailingKind::Bars {
        return (0, 0);
    }
    let (posts, bars) = stations(&ax, &s);
    (bars.len(), posts.len())
}

/// Kennzahlen für die Objekt-Info: Länge der Achse, absolute Fuss- und Oberkante, Stäbe, Pfosten, Fläche der Ansicht (m²);
/// `None` für ein unbekanntes oder unsinniges Geländer.
pub fn info(p: &Project, id: &str) -> Option<serde_json::Value> {
    let r = p.railings.as_deref()?.iter().find(|r| r.id == id)?;
    let (s, ax) = (spec(p, r)?, axis(r)?);
    let len = length(&ax);
    let (bars, posts) = counts(p, r);
    Some(serde_json::json!({"length": len, "baseZ": s.z0, "topZ": s.top(), "height": s.height, "bars": bars, "posts": posts, "area": len * s.height, "closed": is_closed(&ax)}))
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
    let hex = |h: &str, d: [f64; 3]| crate::style::hex_to_rgb(h, d);
    match (r.kind, part) {
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
