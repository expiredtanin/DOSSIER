//! [178] Deckenauflager an Aussenwänden: Die Geschossdecke endet an der Aussenkante der tragenden Schicht
//! (Kern nach [33] `layer_positions`) einer mehrschichtigen Aussenwand; die Schichten davor (Aussendämmung,
//! Putz, Bekleidung) laufen an der Deckenstirn ohne Unterbruch durch. Der Deckenumriss im Modell bleibt;
//! abgeleitet wird der Platten-Umriss ([`bearing_outlines`]): Umriss minus Aussenschicht-Streifen. Er gilt
//! für die Platte (`emit_slabs`: 3D, Schnitt, Ansicht) und für den Decken-Ausschnitt der 3D-Wandbänder
//! (`floor_context`): die Aussenschicht-Bänder liegen dann ausserhalb und werden nicht mehr ausgeschnitten.
//!
//! Aussenwand heisst hier geometrisch, je Stück der Wandlänge: Ein Punkt knapp vor der Aussenfläche
//! (Schicht 0) liegt ausserhalb des Deckenumrisses. Wo die Decke vor der Wand weiterläuft (Anbau, Balkon),
//! bleibt sie. Innenwände (Decke beidseits), einschalige Wände, Wände ohne Höhen-Überlappung mit der Platte und
//! Decken mit `edgeAtOutline` (Verhalten „wie Deckenumriss") bleiben unverändert. Bogenwände ([191]): der Streifen
//! ist ein Kreisringsektor (Aussenfläche bis Aussenkante Kern, fein geteilt wie `ring_arc`), an den Wandenden an
//! den Stosslinien; er reicht 2 cm über die Aussenfläche hinaus, damit die Sehnen des Deckenumrisses keinen Rest
//! stehen lassen.

use super::*;
use kernel2d::point_in_outline;
use std::collections::HashSet;

/// Abstand (m) des Prüfpunkts vor der Aussenfläche.
const PROBE: f64 = 0.05;
/// Mindestüberlappung (m) Wand ↔ Platte in der Höhe.
const Z_EPS: f64 = 1e-4;
/// Abtastschritt (m) längs der Wand für den Prüfpunkt; Wechsel per Bisektion genau.
const STEP: f64 = 0.1;

/// Aussenschichten einer geraden, mehrschichtigen Wand: Querversatz (linke Normale ab Achse) der
/// Aussenfläche und der Aussenkante des Kerns.
#[derive(Clone, Copy, Debug)]
pub(crate) struct OuterFaces {
    pub o_out: f64,
    pub o_core: f64,
}

pub(crate) fn outer_faces(p: &Project, w: &Wall) -> Option<OuterFaces> {
    if w.is_external == Some(false) {
        return None;
    }
    let layers = &p.wall_type(w)?.layers;
    if layers.len() < 2 || !layers.iter().all(|l| l.thickness.is_finite() && l.thickness >= 0.0) {
        return None;
    }
    let count = crate::plan::overrides::layer_positions(p, layers).iter().take_while(|s| **s == "above").count();
    if count == 0 || count >= layers.len() {
        return None;
    }
    let outer: f64 = layers[..count].iter().map(|l| l.thickness).sum();
    let total = Project::type_thickness(layers);
    if !(outer > 1e-6 && total > outer) {
        return None;
    }
    let o_out = joins::reference_offset(wall_reference(w), total) - total / 2.0;
    Some(OuterFaces { o_out, o_core: o_out + outer })
}

/// Achsrichtung (Einheitsvektor), linke Normale, Länge; `None` bei entarteter Achse.
fn axis(w: &Wall) -> Option<([f64; 2], [f64; 2], f64)> {
    let (dx, dy) = (w.end.x - w.start.x, w.end.y - w.start.y);
    let l = hypot2(dx, dy);
    if !(l > 1e-9) {
        return None;
    }
    let u = [dx / l, dy / l];
    Some((u, [-u[1], u[0]], l))
}

fn overlaps_z(p: &Project, w: &Wall, c: &Ceiling) -> bool {
    let (wb, wt) = p.wall_vertical_extent(w);
    let (cb, ct) = p.ceiling_vertical_extent(c);
    wt.min(ct) - wb.max(cb) > Z_EPS
}

/// Achslage (m ab Wandstart), an der die Schnittlinie `cut` den Querversatz `o` trifft.
fn cut_param(w: &Wall, u: [f64; 2], n: [f64; 2], o: f64, cut: &joins::Line) -> Option<f64> {
    let q = [w.start.x + n[0] * o, w.start.y + n[1] * o];
    let den = u[0] * cut.dir.y - u[1] * cut.dir.x;
    let s = ((cut.point.x - q[0]) * cut.dir.y - (cut.point.y - q[1]) * cut.dir.x) / den;
    (den.abs() > 1e-12 && s.is_finite()).then_some(s)
}

/// Achsbereich des Wandkörpers zwischen den Stosslinien (T-Stoss: ab der Fläche der Durchgangswand).
fn body_range(w: &Wall, f: &OuterFaces, cuts: &WallCuts) -> Option<[f64; 2]> {
    let (u, n, l) = axis(w)?;
    let ends = |cut: Option<joins::Line>, default: f64, start: bool| -> f64 {
        let Some(c) = cut else { return default };
        let ps: Vec<f64> = [f.o_out, f.o_core].iter().filter_map(|&o| cut_param(w, u, n, o, &c)).filter(|s| s.abs() < 2.0 * l).collect();
        if ps.is_empty() { return default }
        if start { ps.iter().copied().fold(f64::INFINITY, f64::min).max(0.0) } else { ps.iter().copied().fold(f64::NEG_INFINITY, f64::max).min(l) }
    };
    let r = [ends(cuts.start_cut, 0.0, true), ends(cuts.end_cut, l, false)];
    (r[1] - r[0] > 1e-6).then_some(r)
}

/// Achs-Intervalle `[a, b]` (m ab Wandstart, innerhalb `range`), auf denen der Punkt vor der Aussenfläche
/// ausserhalb des Umrisses liegt.
fn exterior_spans(w: &Wall, f: &OuterFaces, outline: &[KVec], range: [f64; 2]) -> Vec<[f64; 2]> {
    let Some((u, n, _)) = axis(w) else { return Vec::new() };
    let o = f.o_out - PROBE;
    spans_outside(&|t: f64| KVec::new(w.start.x + u[0] * t + n[0] * o, w.start.y + u[1] * t + n[1] * o), outline, range)
}

/// Teilbereiche von `[t0, t1]`, auf denen der Prüfpunkt `probe(t)` ausserhalb des Umrisses liegt.
fn spans_outside(probe: &dyn Fn(f64) -> KVec, outline: &[KVec], [t0, t1]: [f64; 2]) -> Vec<[f64; 2]> {
    let l = t1 - t0;
    let outside = |t: f64| !point_in_outline(probe(t0 + t), outline);
    let steps = ((l / STEP).ceil() as usize).clamp(8, 4096);
    let edge = |mut a: f64, mut b: f64, a_out: bool| {
        for _ in 0..40 {
            let m = (a + b) / 2.0;
            if outside(m) == a_out { a = m } else { b = m }
        }
        (a + b) / 2.0
    };
    let mut spans = Vec::new();
    let (mut prev_t, mut prev) = (0.0, outside(0.0));
    let mut from = prev.then_some(0.0);
    for i in 1..=steps {
        let t = l * i as f64 / steps as f64;
        let cur = outside(t);
        if cur != prev {
            let x = edge(prev_t, t, prev);
            match from.take() {
                Some(a) => spans.push([a, x]),
                None => from = Some(x),
            }
        }
        (prev_t, prev) = (t, cur);
    }
    if let Some(a) = from {
        spans.push([a, l]);
    }
    spans.retain(|s| s[1] - s[0] > 1e-6);
    spans.iter().map(|s| [s[0] + t0, s[1] + t0]).collect()
}

/// Grundriss-Streifen der Aussenschichten (Aussenfläche bis Aussenkante Kern) über `[a, b]`; an den
/// Wandenden an den Gehrungs-/Stosslinien (`cuts`) abgeschnitten wie der Wandkörper (`wall_footprint`).
fn outer_strip(w: &Wall, f: &OuterFaces, cuts: &WallCuts, [a, b]: [f64; 2], [t0, t1]: [f64; 2]) -> Option<Vec<[f64; 2]>> {
    let (u, n, l) = axis(w)?;
    let at = |t: f64, o: f64, cut: Option<joins::Line>| -> [f64; 2] {
        let q = [w.start.x + u[0] * t + n[0] * o, w.start.y + u[1] * t + n[1] * o];
        let Some(c) = cut else { return q };
        let den = u[0] * c.dir.y - u[1] * c.dir.x;
        if den.abs() < 1e-12 {
            return q;
        }
        let s = ((c.point.x - q[0]) * c.dir.y - (c.point.y - q[1]) * c.dir.x) / den;
        if s.is_finite() && s.abs() < l { [q[0] + u[0] * s, q[1] + u[1] * s] } else { q }
    };
    let (sc, ec) = ((a <= t0 + 1e-9).then_some(cuts.start_cut).flatten(), (b >= t1 - 1e-9).then_some(cuts.end_cut).flatten());
    let (a, b) = (if sc.is_some() { 0.0 } else { a }, if ec.is_some() { l } else { b });
    Some(vec![at(a, f.o_out, sc), at(b, f.o_out, ec), at(b, f.o_core, ec), at(a, f.o_core, sc)])
}

/// Überstand (m) des Bogen-Streifens über die Aussenfläche hinaus.
const ARC_MARGIN: f64 = 0.02;

/// [191] Abzugs-Streifen einer Bogenwand: Kreisringsektoren von knapp vor der Aussenfläche bis zur Aussenkante
/// des Kerns über die Bogenlänge, wo die Decke vor der Wand endet; an den Wandenden an den Stosslinien.
fn arc_cutters(arc: &crate::wall_arc::WallArc, f: &OuterFaces, cuts: &WallCuts, outline: &[KVec]) -> Vec<Vec<[f64; 2]>> {
    let len = arc.length();
    if !(len > 1e-9) {
        return Vec::new();
    }
    let n_out = f.o_out - ARC_MARGIN;
    // Körperbereich zwischen den Stosslinien (wie `body_range`, Bogenlänge statt Achslage).
    let reach = |cut: Option<joins::Line>, start: bool| -> f64 {
        let default = if start { 0.0 } else { len };
        let Some(c) = cut else { return default };
        let target = default;
        let ps: Vec<f64> = [f.o_out, f.o_core]
            .iter()
            .filter_map(|&o| arc.line_hits(o, &c).into_iter().filter(|s| s.is_finite() && (s - target).abs() < len / 2.0).min_by(|a, b| (a - target).abs().total_cmp(&(b - target).abs())))
            .collect();
        if ps.is_empty() {
            return default;
        }
        if start { ps.iter().copied().fold(f64::INFINITY, f64::min).max(0.0) } else { ps.iter().copied().fold(f64::NEG_INFINITY, f64::max).min(len) }
    };
    let (t0, t1) = (reach(cuts.start_cut, true), reach(cuts.end_cut, false));
    if !(t1 - t0 > 1e-6) {
        return Vec::new();
    }
    let probe_n = f.o_out - PROBE;
    let spans = spans_outside(&|s: f64| arc.point(s, probe_n), outline, [t0, t1]);
    let r_max = arc.r_max(n_out, f.o_core);
    spans
        .into_iter()
        .filter_map(|[a, b]| {
            let (sc, ec) = ((a <= t0 + 1e-9).then_some(cuts.start_cut).flatten(), (b >= t1 - 1e-9).then_some(cuts.end_cut).flatten());
            let (a, b) = (if sc.is_some() { 0.0 } else { a }, if ec.is_some() { len } else { b });
            let sweep = (b - a) / arc.r * arc.sweep.signum();
            let k = crate::ring_arc::segments(r_max, sweep).max(1);
            let at = |s: f64, n: f64| -> [f64; 2] {
                let q = arc.point(s, n);
                let cut = if s <= a + 1e-12 { sc } else if s >= b - 1e-12 { ec } else { None };
                let q = cut.and_then(|c| arc.line_hit_near(n, &c, q)).unwrap_or(q);
                [q.x, q.y]
            };
            let ss: Vec<f64> = (0..=k).map(|i| a + (b - a) * i as f64 / k as f64).collect();
            let mut ring: Vec<[f64; 2]> = ss.iter().map(|&s| at(s, n_out)).collect();
            ring.extend(ss.iter().rev().map(|&s| at(s, f.o_core)));
            (ring_area(&ring) > 1e-9).then_some(ring)
        })
        .collect()
}

/// Abzugs-Streifen einer Wand für eine Decke (leer: Wand trägt die Decke nicht als Aussenwand).
pub(crate) fn wall_cutters(p: &Project, w: &Wall, cuts: &WallCuts, c: &Ceiling) -> Vec<Vec<[f64; 2]>> {
    let Some(f) = outer_faces(p, w) else { return Vec::new() };
    if cuts.covered || c.edge_at_outline == Some(true) || c.outline.len() < 3 || !overlaps_z(p, w, c) {
        return Vec::new();
    }
    let k: Vec<KVec> = c.ring().iter().map(|v| KVec::new(v.x, v.y)).collect();
    if let Some(arc) = crate::wall_arc::WallArc::of_wall(w) {
        return arc_cutters(&arc, &f, cuts, &k);
    }
    let Some(range) = body_range(w, &f, cuts) else { return Vec::new() };
    exterior_spans(w, &f, &k, range).into_iter().filter_map(|s| outer_strip(w, &f, cuts, s, range)).collect()
}

fn ring_area(r: &[[f64; 2]]) -> f64 {
    (0..r.len()).map(|i| { let (a, b) = (r[i], r[(i + 1) % r.len()]); a[0] * b[1] - b[0] * a[1] }).sum::<f64>().abs() / 2.0
}

fn bbox_of(pts: impl Iterator<Item = [f64; 2]>) -> [f64; 4] {
    pts.fold([f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY], |b, q| [b[0].min(q[0]), b[1].min(q[1]), b[2].max(q[0]), b[3].max(q[1])])
}

/// Platten-Umrisse aller Decken (Index wie `Project::ceilings`), s. [`bearing_outlines`].
pub(crate) fn ceiling_bearing_outlines(p: &Project) -> Vec<Option<Vec<crate::flat::Polygon>>> {
    bearing_outlines(p, |_| true, None)
}

/// Platten-Umrisse je Decke (Index wie `Project::ceilings`; nur Decken mit `only`): `None` = Umriss
/// unverändert, sonst die Polygone (Ring 0 aussen, weitere Löcher) nach Abzug der Aussenschicht-Streifen
/// der Aussenwände, die die Platte in der Höhe überlappen. `known`: schon gerechnete Schnittlinien je Wand-id
/// (sonst je betroffenes Geschoss neu).
pub(crate) fn bearing_outlines(p: &Project, only: impl Fn(&Ceiling) -> bool, known: Option<&HashMap<String, WallCuts>>) -> Vec<Option<Vec<crate::flat::Polygon>>> {
    let ceilings = p.ceilings.as_deref().unwrap_or(&[]);
    let mut out = vec![None; ceilings.len()];
    let todo: Vec<usize> = (0..ceilings.len()).filter(|&i| only(&ceilings[i]) && ceilings[i].edge_at_outline != Some(true) && ceilings[i].outline.len() >= 3).collect();
    if todo.is_empty() {
        return out;
    }
    let walls: Vec<&Wall> = p.walls.iter().filter(|w| outer_faces(p, w).is_some() && todo.iter().any(|&i| overlaps_z(p, w, &ceilings[i]))).collect();
    if walls.is_empty() {
        return out;
    }
    // Verschneidung nur der Geschosse mit solchen Wänden (wie `compute_joins_by_floor`).
    let floors: HashSet<&str> = walls.iter().map(|w| w.floor_id.as_str()).collect();
    let mut joins: HashMap<&str, WallCuts> = HashMap::new();
    for (floor, idx) in floor_groups(p) {
        if !floors.contains(floor) || known.is_some() {
            continue;
        }
        let (jw, finite) = floor_join_input(p, &idx);
        let mut cuts = floor_join_cuts(&jw, finite);
        trim_at_columns(p, &idx, &mut cuts);
        for (&i, c) in idx.iter().zip(cuts) {
            joins.insert(p.walls[i].id.as_str(), c);
        }
    }
    let none = WallCuts::default();
    for ci in todo {
        let c = &ceilings[ci];
        let ring: Vec<[f64; 2]> = c.ring_xy();
        let cb = bbox_of(ring.iter().copied());
        let cutters: Vec<crate::flat::Polygon> = walls
            .iter()
            .flat_map(|w| wall_cutters(p, w, known.and_then(|k| k.get(&w.id)).or_else(|| joins.get(w.id.as_str())).unwrap_or(&none), c))
            .filter(|s| {
                let b = bbox_of(s.iter().copied());
                b[0] < cb[2] && b[2] > cb[0] && b[1] < cb[3] && b[3] > cb[1]
            })
            .map(|s| vec![s])
            .collect();
        if cutters.is_empty() {
            continue;
        }
        let rest = crate::polygon_bool::difference(&[vec![ring.clone()]], &cutters);
        let rest: Vec<crate::flat::Polygon> = rest.into_iter().filter(|poly| poly.first().is_some_and(|r| r.len() >= 3)).collect();
        // Streifen nur berührt (Umriss endet schon am Kern): Umriss exakt behalten (kein Raster-Runden).
        let area = |poly: &crate::flat::Polygon| poly.iter().enumerate().map(|(i, r)| if i == 0 { ring_area(r) } else { -ring_area(r) }).sum::<f64>();
        if (rest.iter().map(area).sum::<f64>() - ring_area(&ring)).abs() < 1e-6 {
            continue;
        }
        out[ci] = Some(rest);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plan::section::{compute_section, Cut, Kind, LevelSpec};

    /// Beispielprojekt (Aussenwand Putz 2 / EPS 16 / Backstein 15 / Innenputz 1.5 cm, Achse mittig), Decke C1
    /// bis an die Aussenfläche der Wände gezogen (bisher: Platte über Dämmung und Putz).
    fn sample(edge_at_outline: Option<bool>) -> Project {
        let mut p: Project = serde_json::from_str(include_str!("../../tests/fixtures/sample_project.json")).unwrap();
        let h = 0.345 / 2.0;
        let c = &mut p.ceilings.as_mut().unwrap()[0];
        c.outline = [(-h, -h), (5.0 + h, -h), (5.0 + h, 4.0 + h), (-h, 4.0 + h)].iter().map(|&(x, y)| Vec2 { x, y }).collect();
        c.edge_at_outline = edge_at_outline;
        p
    }

    /// Schnitt quer durch W1 (y = 0, aussen bei y < 0) und W3, bei x = 1 (abseits der Innenwand W9).
    fn section(p: &Project) -> Vec<Cut> {
        let l = LevelSpec { kind: "section".into(), line: Some([Vec2 { x: 1.0, y: -1.0 }, Vec2 { x: 1.0, y: 5.0 }]), ..Default::default() };
        compute_section(p, &l, &[]).unwrap().unwrap().cuts
    }

    fn bb(c: &Cut) -> [f64; 4] {
        c.pts.iter().fold([f64::INFINITY, f64::NEG_INFINITY, f64::INFINITY, f64::NEG_INFINITY], |b, q| [b[0].min(q[0]), b[1].max(q[0]), b[2].min(q[1]), b[3].max(q[1])])
    }

    /// Bänder von W1 eines Bauteils: u-Bereich und senkrecht vereinigte v-Spannen.
    fn w1_band(cuts: &[Cut], comp: &str) -> ([f64; 2], Vec<[f64; 2]>) {
        let mut u = [f64::INFINITY, f64::NEG_INFINITY];
        let mut spans: Vec<[f64; 2]> = Vec::new();
        for c in cuts.iter().filter(|c| c.kind == Kind::Wall && c.source_id.as_deref() == Some("W1") && c.component_id.as_deref() == Some(comp)) {
            let b = bb(c);
            u = [u[0].min(b[0]), u[1].max(b[1])];
            spans.push([b[2], b[3]]);
        }
        spans.sort_by(|a, b| a[0].total_cmp(&b[0]));
        let mut merged: Vec<[f64; 2]> = Vec::new();
        for s in spans {
            match merged.last_mut() {
                Some(m) if s[0] <= m[1] + 1e-6 => m[1] = m[1].max(s[1]),
                _ => merged.push(s),
            }
        }
        (u, merged)
    }

    fn slab_range(cuts: &[Cut], comp: &str) -> [f64; 4] {
        cuts.iter().filter(|c| c.kind == Kind::Slab && c.component_id.as_deref() == Some(comp)).map(bb).fold([f64::INFINITY, f64::NEG_INFINITY, f64::INFINITY, f64::NEG_INFINITY], |a, b| [a[0].min(b[0]), a[1].max(b[1]), a[2].min(b[2]), a[3].max(b[3])])
    }

    #[test]
    fn schnitt_decke_endet_an_aussenkante_backstein_daemmung_durchgehend() {
        let p = sample(None);
        let cuts = section(&p);
        let (brick_u, _) = w1_band(&cuts, "brick");
        let (eps_u, eps_z) = w1_band(&cuts, "insulation");
        let (ext_u, ext_z) = w1_band(&cuts, "render-ext");
        // Aussenfläche bei u = 1 − 0.1725, Kern 0.18 dahinter.
        assert!((ext_u[0] - (1.0 - 0.1725)).abs() < 1e-6 && (brick_u[0] - (1.0 - 0.1725 + 0.18)).abs() < 1e-6, "{ext_u:?} {brick_u:?}");
        let concrete = slab_range(&cuts, "concrete");
        assert!(concrete[0].is_finite());
        assert!((concrete[0] - brick_u[0]).abs() < 1e-6, "Platte ab u = {}, Backstein aussen bei {}", concrete[0], brick_u[0]);
        // Keine Deckenschicht vor der Aussenkante Kern.
        let any_slab_u0 = cuts.iter().filter(|c| c.kind == Kind::Slab && c.stair_id.is_none()).map(|c| bb(c)[0]).fold(f64::INFINITY, f64::min);
        assert!(any_slab_u0 >= brick_u[0] - 1e-6, "Deckenschicht ab {any_slab_u0}");
        // EPS und Aussenputz laufen an der Deckenstirn ohne Unterbruch über die ganze Wandhöhe.
        assert!((eps_u[1] - brick_u[0]).abs() < 1e-6, "{eps_u:?}");
        for (name, z) in [("EPS", &eps_z), ("Aussenputz", &ext_z)] {
            assert_eq!(z.len(), 1, "{name}: {z:?}");
            assert!(z[0][0] <= concrete[2] + 1e-6 && z[0][1] >= concrete[3] - 1e-6, "{name} {z:?} gegen Platte {concrete:?}");
        }
    }

    #[test]
    fn wie_deckenumriss_bleibt_beim_alten() {
        let p = sample(Some(true));
        let cuts = section(&p);
        assert!((slab_range(&cuts, "concrete")[0] - (1.0 - 0.1725)).abs() < 1e-6);
        let (_, eps_z) = w1_band(&cuts, "insulation");
        assert!(eps_z.len() > 1, "EPS von der Platte unterbrochen: {eps_z:?}");
    }

    #[test]
    fn einschalige_wand_und_innenwand_unveraendert() {
        // Einschalig: nur der Backstein bleibt im Aussenwandtyp.
        let mut p = sample(None);
        for t in p.wall_types.iter_mut().filter(|t| t.id == "aw") {
            t.layers.retain(|l| l.component_id == "brick");
        }
        assert!(ceiling_bearing_outlines(&p).iter().all(|o| o.is_none()));
        // Innenwand W9 (Decke beidseits): kein Abzug.
        let p = sample(None);
        let w9 = p.walls.iter().find(|w| w.id == "W9").unwrap();
        assert!(wall_cutters(&p, w9, &WallCuts::default(), &p.ceilings.as_ref().unwrap()[0]).is_empty());
        // Umriss schon bis Kern (Beispiel: Achse liegt in der Dämmung, Kern 7.5 mm dahinter): nur der
        // Streifen ausserhalb des Kerns fällt weg.
        let mut q: Project = serde_json::from_str(include_str!("../../tests/fixtures/sample_project.json")).unwrap();
        let c = &mut q.ceilings.as_mut().unwrap()[0];
        c.outline = [(0.0075, 0.0075), (5.0 - 0.0075, 0.0075), (5.0 - 0.0075, 4.0 - 0.0075), (0.0075, 4.0 - 0.0075)].iter().map(|&(x, y)| Vec2 { x, y }).collect();
        assert!(ceiling_bearing_outlines(&q).iter().all(|o| o.is_none()), "Umriss am Kern bleibt exakt");
    }

    /// Decke läuft vor einem Teil der Wand weiter (Anbau/Balkon): dort bleibt sie, sonst endet sie am Kern.
    #[test]
    fn decke_vor_der_wand_bleibt_nur_dort() {
        let mut p = sample(None);
        let h = 0.345 / 2.0;
        let c = &mut p.ceilings.as_mut().unwrap()[0];
        // Auskragung vor W1 zwischen x = 3 und 4 (bis y = −1.5).
        c.outline = [(-h, -h), (3.0, -h), (3.0, -1.5), (4.0, -1.5), (4.0, -h), (5.0 + h, -h), (5.0 + h, 4.0 + h), (-h, 4.0 + h)].iter().map(|&(x, y)| Vec2 { x, y }).collect();
        let polys = ceiling_bearing_outlines(&p)[0].clone().expect("beschnitten");
        let inside = |x: f64, y: f64| polys.iter().any(|poly| point_in_outline(KVec::new(x, y), &poly[0].iter().map(|q| KVec::new(q[0], q[1])).collect::<Vec<_>>()));
        assert!(!inside(1.0, -0.1), "vor dem Kern abgezogen");
        assert!(inside(1.0, 0.05), "über dem Kern bleibt");
        assert!(inside(3.5, -0.1) && inside(3.5, -1.0), "Auskragung bleibt");
    }

    /// [191] W1 als Halbkreis nach aussen (Achse r = 2.5 um (2.5, 0)), Decke mit Bogenkante bis zur Aussenfläche.
    fn sample_arc(edge_at_outline: Option<bool>) -> Project {
        let mut p: Project = serde_json::from_str(include_str!("../../tests/fixtures/sample_project.json")).unwrap();
        let h = 0.345 / 2.0;
        p.walls.iter_mut().find(|w| w.id == "W1").unwrap().bulge = Some(-1.0);
        p.walls.retain(|w| w.id != "W9");
        // Ohne das Fenster in W1 (der Schnitt läuft durch den Scheitel).
        if let Some(o) = p.openings.as_mut() {
            o.retain(|o| o.host_wall_id != "W1");
        }
        let c = &mut p.ceilings.as_mut().unwrap()[0];
        c.outline = [(-h, 0.0), (5.0 + h, 0.0), (5.0 + h, 4.0 + h), (-h, 4.0 + h)].iter().map(|&(x, y)| Vec2 { x, y }).collect();
        c.outline_bulge = Some(vec![-1.0, 0.0, 0.0, 0.0]);
        c.edge_at_outline = edge_at_outline;
        p
    }

    #[test]
    fn bogenwand_platte_endet_an_kern_aussenkante() {
        let p = sample_arc(None);
        let h = 0.345 / 2.0;
        let r_core = 2.5 + h - 0.18;
        let slabs = emit_slabs(&p);
        let concrete = slabs.iter().find(|s| s.cut.as_ref().and_then(|c| c.component_id.as_deref()) == Some("concrete")).expect("Betonschicht");
        let d = |q: &[f64; 2]| ((q[0] - 2.5).powi(2) + q[1].powi(2)).sqrt();
        let arc_pts: Vec<f64> = concrete.outline.iter().filter(|q| q[1] < -0.3).map(d).collect();
        assert!(arc_pts.len() >= 40, "Bogen fein: {} Punkte", arc_pts.len());
        let (lo, hi) = arc_pts.iter().fold((f64::INFINITY, 0.0f64), |(a, b), &x| (a.min(x), b.max(x)));
        assert!(hi <= r_core + 1e-6 && lo >= r_core - 1e-3, "Platte endet am Kern r = {r_core}: {lo}..{hi}");
        // Wie Deckenumriss: bis zur Aussenfläche.
        let p2 = sample_arc(Some(true));
        let s2 = emit_slabs(&p2);
        let c2 = s2.iter().find(|s| s.cut.as_ref().and_then(|c| c.component_id.as_deref()) == Some("concrete")).unwrap();
        let far = c2.outline.iter().filter(|q| q[1] < -0.3).map(d).fold(0.0f64, f64::max);
        assert!((far - (2.5 + h)).abs() < 1e-6, "{far}");
    }

    #[test]
    fn bogenwand_schnitt_daemmung_durchgehend() {
        let p = sample_arc(None);
        let h = 0.345 / 2.0;
        // Schnitt durch den Scheitel (x = 2.5): Aussenfläche bei y = −(2.5 + h), Kern 0.18 dahinter.
        let l = LevelSpec { kind: "section".into(), line: Some([Vec2 { x: 2.5, y: -4.0 }, Vec2 { x: 2.5, y: 5.0 }]), ..Default::default() };
        let cuts = compute_section(&p, &l, &[]).unwrap().unwrap().cuts;
        let (eps_u, eps_z) = w1_band(&cuts, "insulation");
        let (brick_u, _) = w1_band(&cuts, "brick");
        assert!(eps_u[0].is_finite() && brick_u[0].is_finite(), "{eps_u:?} {brick_u:?}");
        let concrete = slab_range(&cuts, "concrete");
        assert!((concrete[0] - brick_u[0]).abs() < 2e-3, "Platte ab u = {}, Backstein aussen bei {}", concrete[0], brick_u[0]);
        assert_eq!(eps_z.len(), 1, "EPS durchgehend: {eps_z:?}");
        assert!(eps_z[0][0] <= concrete[2] + 1e-6 && eps_z[0][1] >= concrete[3] - 1e-6);
        // Aussenfläche am Scheitel: u = 4 − (2.5 + h).
        assert!((eps_u[0] - (4.0 - 2.5 - h + 0.02)).abs() < 2e-3, "{eps_u:?}");
        // 3D: die Dämmung von W1 läuft an der Platte ohne Ausschnitt durch.
        let (_, zt) = p.ceiling_vertical_extent(&p.ceilings.as_ref().unwrap()[0]);
        let walls = emit_walls(&p, true).unwrap();
        let eps: Vec<&RWall> = walls.iter().filter(|w| w.wall_id == "W1" && w.cut.as_ref().and_then(|c| c.component_id.as_deref()) == Some("insulation")).collect();
        assert!(!eps.is_empty() && eps.iter().all(|w| w.base_elevation + w.height >= zt - 1e-6), "EPS bis {zt}");
    }

    #[test]
    fn dreid_platte_bis_kern_und_aussenschichten_ungeschnitten() {
        let p = sample(None);
        let slabs = emit_slabs(&p);
        let concrete = slabs.iter().find(|s| s.cut.as_ref().and_then(|c| c.component_id.as_deref()) == Some("concrete")).unwrap();
        let min_y = concrete.outline.iter().map(|q| q[1]).fold(f64::INFINITY, f64::min);
        assert!((min_y - (-0.1725 + 0.18)).abs() < 1e-6, "{min_y}");
        let (zb, zt) = p.ceiling_vertical_extent(&p.ceilings.as_ref().unwrap()[0]);
        let walls = emit_walls(&p, true).unwrap();
        let top = |comp: &str| walls.iter().filter(|w| w.wall_id == "W1" && w.cut.as_ref().and_then(|c| c.component_id.as_deref()) == Some(comp)).map(|w| w.base_elevation + w.height).fold(f64::NEG_INFINITY, f64::max);
        assert!(top("insulation") >= zt - 1e-6 && top("render-ext") >= zt - 1e-6, "Aussenschichten bis {} / {}, Platte bis {zt}", top("insulation"), top("render-ext"));
        // Der Kern wird von der stärkeren Betonschicht weiterhin ausgeschnitten (wie bisher).
        let z = zb + 0.1;
        assert!(!walls.iter().any(|w| w.wall_id == "W1" && w.cut.as_ref().and_then(|c| c.component_id.as_deref()) == Some("brick") && w.base_elevation < z && w.base_elevation + w.height > z));
        assert!(walls.iter().any(|w| w.wall_id == "W1" && w.cut.as_ref().and_then(|c| c.component_id.as_deref()) == Some("insulation") && w.base_elevation < z && w.base_elevation + w.height > z));
    }
}
