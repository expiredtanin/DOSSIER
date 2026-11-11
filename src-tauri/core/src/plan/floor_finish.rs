//! [156] Bodenbelag-Muster im Grundriss massstabsgerecht: Parkett, Platten … erst ab 1:50 bzw. Detail
//! „fein"; im 1:100 und gröber keine Belagsmuster — ausser die Ebene/Ansichtsvorlage verlangt es
//! (`DrawingLevel.floorFinish`: „aus", „Nassräume" = gröber nur Plattenbeläge in Bad/WC/Dusche, „alle").
//! Override-Regeln mit Bauteilart „floor_finish" blenden aus (`hide`), erzwingen (`hide: false`) oder
//! färben/verstärken. Sichtbares Muster: feine Tusche-graue Linie (0.02–0.05 mm), Teilung auf dem Papier
//! nicht dichter als [`MIN_PAPER_MM`] (sonst gröber, s. `surface_pattern::thin_factor`), ausgespart unter
//! Treppen, Möbeln/Einbauten (Blöcke, geschlossene Möbel-Formen, Körper) und Raumstempeln. Bildschirm und Druck gleich (kein
//! Unterschied nach `forPrint`/`compact`).

use super::domains::Ctx;
use super::style::Detail;
use super::prim::Primitive;
use crate::model::{Component, FloorFinishDisplay, Room};

type P = [f64; 2];

/// Massstab (1:N), bis zu dem Belagsmuster automatisch gezeichnet werden.
pub const FINE_FROM: f64 = 50.0;
/// Kleinste Musterteilung auf dem Papier (mm); enger wird ausgedünnt (jede 2./4./8. Linie) oder entfällt.
pub const MIN_PAPER_MM: f64 = 1.5;
/// Strichstärke des Belagsmusters (Papier-mm): Spanne und Vorgabe.
pub const WEIGHT_MIN_MM: f64 = 0.02;
pub const WEIGHT_MAX_MM: f64 = 0.05;
pub const WEIGHT_MM: f64 = 0.035;
/// Tusche-Grau des Belagsmusters (wie die Ansichtsschraffur, [140]).
pub const INK: &str = "#8c8c8c";
/// Luft um den Raumstempel (Papier-mm), in der kein Belag liegt.
const STAMP_MARGIN_MM: f64 = 1.0;

/// Welche Beläge ein Grundriss zeigt.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Show {
    Off,
    /// Nur Plattenbeläge in Nassräumen.
    Wet,
    All,
}

/// Feiner Plan: ab 1:50 (Detail nicht ausdrücklich „grob") oder Detail „fein".
pub fn fine(detail: Detail, scale: f64) -> bool {
    detail == Detail::Fein || (detail != Detail::Grob && scale.is_finite() && scale > 0.0 && scale <= FINE_FROM + 1e-9)
}

/// Belags-Darstellung für die Einstellung der Ebene `setting`, Detail und Massstab.
pub fn show(setting: Option<FloorFinishDisplay>, detail: Detail, scale: f64) -> Show {
    let fine = fine(detail, scale);
    match setting {
        Some(FloorFinishDisplay::Off) => Show::Off,
        Some(FloorFinishDisplay::All) => Show::All,
        Some(FloorFinishDisplay::Wet) if !fine => Show::Wet,
        _ if fine => Show::All,
        _ => Show::Off,
    }
}

fn has_any(text: &str, words: &[&str]) -> bool {
    let t = text.to_lowercase();
    words.iter().any(|w| t.contains(w))
}

/// Nassraum: [158] aus der Nutzung (`Room.usage`), ohne Nutzung nach dem Namen ([`is_wet_name`]).
pub fn is_wet_room(r: &Room) -> bool {
    crate::room_book::is_wet(r)
}

/// Nassraum nach Name (auch Stempel-Name): Bad, WC, Dusche, Nasszelle, Toilette, Sanitär …
pub fn is_wet_name(r: &Room) -> bool {
    const WET: [&str; 12] = ["bad", "wc", "dusche", "nasszelle", "toilette", "sanitär", "sanitaer", "waschraum", "bath", "shower", "toilet", "lavabo"];
    let names = [Some(r.name.as_str()), r.stamp.as_ref().map(|s| s.name.as_str()), r.stamp.as_ref().and_then(|s| s.name_line2.as_deref())];
    names.into_iter().flatten().any(|n| has_any(n, &WET))
}

/// Plattenbelag: Muster „Raster" oder Baustoff-/Bauteilname mit Platten, Fliesen, Keramik …
pub fn is_tile(comp: &Component) -> bool {
    const TILE: [&str; 6] = ["platte", "fliese", "keramik", "kachel", "feinstein", "tile"];
    comp.surface_pattern.as_ref().is_some_and(|s| s.kind == crate::model::SurfacePatternKind::Grid) || has_any(&comp.name, &TILE) || has_any(&comp.id, &TILE)
}

/// Strichstärke aus dem Muster (oder einer Regel), auf die Spanne der feinen Tusche gebracht.
pub fn weight(w: Option<f64>) -> f64 {
    w.filter(|w| w.is_finite() && *w > 0.0).map_or(WEIGHT_MM, |w| w.clamp(WEIGHT_MIN_MM, WEIGHT_MAX_MM))
}

/// Massstab für `surface_pattern::segments`, der dessen Ausdünnung (ab `MIN_PAPER_MM` dort) auf
/// [`MIN_PAPER_MM`] hebt.
pub fn thinning_scale(scale: f64) -> f64 {
    let s = if scale.is_finite() && scale > 0.0 { scale } else { 100.0 };
    s * MIN_PAPER_MM / crate::surface_pattern::MIN_PAPER_MM
}

/// [158] Räume des Geschosses mit eigenem Bodenbelag aus den Bauteil-Materialien (sichtbar, gültiger
/// Umriss): Raum, Material, Umriss. Freitext-Beläge gelten nicht (kein Muster bekannt).
pub fn own_finish_rooms<'a>(c: &Ctx<'a>) -> Vec<(&'a Room, &'a Component, Vec<P>)> {
    c.p.rooms
        .as_deref()
        .unwrap_or(&[])
        .iter()
        .filter(|r| r.floor_id == c.a.floor && r.boundary.len() >= 3 && c.vis(&r.category_code, &r.id))
        .filter_map(|r| {
            let comp = crate::room_book::finish_component(c.p, r.floor_finish.as_deref())?;
            let ring: Vec<P> = r.boundary.iter().map(|v| [v.x, v.y]).collect();
            ring.iter().all(|q| q[0].is_finite() && q[1].is_finite()).then_some((r, comp, ring))
        })
        .collect()
}

/// [158] Ausrichtung des Belagsmusters: an der längsten Raumkante. Ursprung = Anfang dieser Kante,
/// Drehung = Kantenrichtung auf ±45° gefaltet (achsparallele Räume behalten die Plan-Ausrichtung);
/// entartete Umrisse: erster Punkt, keine Drehung. Räume haben keinen eigenen Bezugspunkt
/// (`stampAnchor` ist nur die Lage des Stempels).
pub fn pattern_frame(ring: &[P]) -> (P, f64) {
    let mut best: Option<(f64, P, f64)> = None;
    for i in 0..ring.len() {
        let (a, b) = (ring[i], ring[(i + 1) % ring.len()]);
        let len = (b[0] - a[0]).hypot(b[1] - a[1]);
        if len.is_finite() && len > 1e-9 && best.map_or(true, |(l, _, _)| len > l + 1e-9) {
            let deg = (b[1] - a[1]).atan2(b[0] - a[0]).to_degrees();
            best = Some((len, a, deg - 90.0 * (deg / 90.0).round()));
        }
    }
    match best {
        Some((_, a, deg)) => (a, deg),
        None => (ring.first().copied().unwrap_or([0.0, 0.0]), 0.0),
    }
}

/// [158] Belagsmuster eines Raums: Muster des Materials auf dem Raumumriss (nach der längsten
/// Raumkante ausgerichtet, [`pattern_frame`]), ausgedünnt wie der Deckenbelag; dazu die Strichstärke.
pub fn room_segments(comp: &Component, ring: &[P], scale: f64) -> Option<(Vec<(P, P)>, f64)> {
    let pat = comp.surface_pattern.as_ref()?;
    let (origin, deg) = pattern_frame(ring);
    let spec = crate::surface_pattern::spec_of(pat, deg)?;
    let segs = crate::surface_pattern::segments(ring, &spec, origin, thinning_scale(scale));
    Some((segs, weight(pat.weight_mm)))
}

pub fn wet_rooms(c: &Ctx) -> Vec<Vec<P>> {
    c.p.rooms.as_deref().unwrap_or(&[]).iter().filter(|r| r.floor_id == c.a.floor && r.boundary.len() >= 3 && is_wet_room(r)).map(|r| r.boundary.iter().map(|v| [v.x, v.y]).collect()).collect()
}

/// Aussparungen: Raumstempel (Rechteck mit Luft) aus den schon gesetzten Raum-Primitiven, Möbel/Symbole
/// (Blöcke der 2D-Zeichnungen, konvexe Hülle; geschlossene 2D-Formen der Kategorie „Möbel“) und Körper des Geschosses (Einbauten, ohne Abzugskörper).
pub fn exclusions(c: &Ctx, rooms: &[Primitive]) -> Vec<Vec<P>> {
    let mut out = Vec::new();
    let margin = STAMP_MARGIN_MM * c.a.scale / 1000.0;
    for q in rooms {
        if let Primitive::Text { at, doc, extra_lines, base_pt, room_id: Some(_), .. } = q {
            let (w, h) = super::domains::stamp_size_m(doc, extra_lines, *base_pt, c.a.scale);
            let (hw, hh) = (w / 2.0 + margin, h / 2.0 + margin);
            if hw.is_finite() && hh.is_finite() && hw > 0.0 && hh > 0.0 {
                out.push(vec![[at.x - hw, at.y - hh], [at.x + hw, at.y - hh], [at.x + hw, at.y + hh], [at.x - hw, at.y + hh]]);
            }
        }
    }
    out.extend(super::drawings::block_footprints(c));
    out.extend(super::drawings::furniture_shape_footprints(c));
    for s in c.p.extruded_solids.as_deref().unwrap_or(&[]) {
        // Nur Körper, die auf dem Boden stehen (Küchenblock, Einbauschrank), nicht Träger darüber.
        let on_floor = s.base_offset.unwrap_or(0.0).abs() <= 0.05 && s.height > 0.0;
        if s.level_id == c.a.floor && on_floor && s.operation.as_deref() != Some("subtract") && s.site_projection != Some(true) && !c.rule_hidden(&s.id) {
            let ring: Vec<P> = match &s.circle {
                Some(k) if s.points.len() < 3 => (0..32).map(|i| {
                    let a = i as f64 * std::f64::consts::TAU / 32.0;
                    [k.center.x + k.r * crate::jsnum::cos(a), k.center.y + k.r * crate::jsnum::sin(a)]
                }).collect(),
                _ => s.points.iter().map(|v| [v.x, v.y]).collect(),
            };
            if ring.len() >= 3 && ring.iter().all(|q| q[0].is_finite() && q[1].is_finite()) {
                out.push(ring);
            }
        }
    }
    out
}

/// Konvexe Hülle (Monotone Chain), gegen den Uhrzeigersinn, ohne doppelte Punkte.
pub fn convex_hull(mut pts: Vec<P>) -> Vec<P> {
    pts.retain(|q| q[0].is_finite() && q[1].is_finite());
    pts.sort_by(|a, b| a[0].total_cmp(&b[0]).then(a[1].total_cmp(&b[1])));
    pts.dedup_by(|a, b| (a[0] - b[0]).abs() < 1e-12 && (a[1] - b[1]).abs() < 1e-12);
    if pts.len() < 3 {
        return pts;
    }
    let cross = |o: P, a: P, b: P| (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    let mut lower: Vec<P> = Vec::new();
    for &q in &pts {
        while lower.len() >= 2 && cross(lower[lower.len() - 2], lower[lower.len() - 1], q) <= 0.0 {
            lower.pop();
        }
        lower.push(q);
    }
    let mut upper: Vec<P> = Vec::new();
    for &q in pts.iter().rev() {
        while upper.len() >= 2 && cross(upper[upper.len() - 2], upper[upper.len() - 1], q) <= 0.0 {
            upper.pop();
        }
        upper.push(q);
    }
    lower.pop();
    upper.pop();
    lower.extend(upper);
    lower
}

/// Stücke ausserhalb aller `polys`.
pub fn clip_outside_all(mut segs: Vec<(P, P)>, polys: &[Vec<P>]) -> Vec<(P, P)> {
    for poly in polys {
        let mut rest = Vec::with_capacity(segs.len());
        for (a, b) in segs {
            crate::surface_pattern::clip_outside_poly(a, b, poly, &mut rest);
        }
        segs = rest;
    }
    segs
}

/// Stücke innerhalb eines der `polys`.
pub fn clip_inside_any(segs: &[(P, P)], polys: &[Vec<P>]) -> Vec<(P, P)> {
    let mut out = Vec::new();
    for poly in polys.iter().filter(|q| q.len() >= 3) {
        for &(a, b) in segs {
            crate::surface_pattern::clip_to_poly(a, b, poly, &mut out);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{SurfacePattern, SurfacePatternDirection, SurfacePatternKind};

    #[test]
    fn darstellung_je_massstab_und_einstellung() {
        use FloorFinishDisplay as F;
        assert_eq!(show(None, Detail::Mittel, 50.0), Show::All);
        assert_eq!(show(None, Detail::Mittel, 100.0), Show::Off);
        assert_eq!(show(None, Detail::Fein, 100.0), Show::All);
        assert_eq!(show(None, Detail::Grob, 50.0), Show::Off);
        assert_eq!(show(Some(F::Wet), Detail::Mittel, 100.0), Show::Wet);
        assert_eq!(show(Some(F::Wet), Detail::Mittel, 50.0), Show::All);
        assert_eq!(show(Some(F::Off), Detail::Fein, 20.0), Show::Off);
        assert_eq!(show(Some(F::All), Detail::Grob, 200.0), Show::All);
    }

    #[test]
    fn strichstaerke_feine_tusche() {
        assert_eq!(weight(None), WEIGHT_MM);
        assert_eq!(weight(Some(0.25)), WEIGHT_MAX_MM);
        assert_eq!(weight(Some(0.005)), WEIGHT_MIN_MM);
        assert_eq!(weight(Some(f64::NAN)), WEIGHT_MM);
    }

    #[test]
    fn huelle_konvex() {
        let h = convex_hull(vec![[0.0, 0.0], [1.0, 0.0], [0.5, 0.2], [1.0, 1.0], [0.0, 1.0], [0.5, 0.5]]);
        assert_eq!(h.len(), 4);
    }

    #[test]
    fn muster_an_laengster_raumkante() {
        // Achsparalleler Raum: keine Drehung, Ursprung am Anfang der längsten Kante (zweite: 5 m).
        let r = [[0.0, 0.0], [2.0, 0.0], [2.0, 5.0], [0.0, 5.0]];
        assert_eq!(pattern_frame(&r), ([2.0, 0.0], 0.0));
        // Um 30° gedrehter Raum 6 × 3: Drehung = 30°, Ursprung = Anfang der Längskante.
        let (c, s) = (30f64.to_radians().cos(), 30f64.to_radians().sin());
        let rot = |x: f64, y: f64| [x * c - y * s + 1.0, x * s + y * c + 2.0];
        let ring = [rot(0.0, 0.0), rot(6.0, 0.0), rot(6.0, 3.0), rot(0.0, 3.0)];
        let (o, deg) = pattern_frame(&ring);
        assert!((deg - 30.0).abs() < 1e-9 && o == ring[0], "{o:?} {deg}");
        // Längskante rückwärts (180°): auf achsparallel gefaltet.
        assert_eq!(pattern_frame(&[[6.0, 0.0], [0.0, 0.0], [0.0, 3.0], [6.0, 3.0]]).1, 0.0);
        assert_eq!(pattern_frame(&[]), ([0.0, 0.0], 0.0));
        // Dielen („horizontal") laufen in der gedrehten Stube parallel zur Längskante.
        let comp = Component { surface_pattern: Some(SurfacePattern { kind: SurfacePatternKind::Lines, direction: Some(SurfacePatternDirection::Horizontal), spacing: 0.5, ..Default::default() }), ..Default::default() };
        let (segs, _) = room_segments(&comp, &ring, 50.0).unwrap();
        assert!(!segs.is_empty());
        for (a, b) in segs {
            let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
            let cross = (dx * s - dy * c).abs() / dx.hypot(dy);
            assert!(cross < 1e-6, "{cross}");
        }
    }
}
