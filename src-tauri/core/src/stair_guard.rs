//! [155] Absturzsicherung am Deckenloch einer ankommenden Treppe: eine Quelle für Grundriss
//! (`plan/stairs.rs`), 3D (`model3d/stairs.rs`, Körper aus `stairs3d::guard_mesh`) und IFC (`ifc_stairs`).
//!
//! Eine Treppe, deren Oberkante auf der Höhe eines Geschossbodens liegt, kommt durch das Loch der Decke
//! darunter an (`ceiling_hole_rings`). An den freien Lochrändern (nicht unter Wänden, nicht an der
//! Austrittskante der Treppe) steht ein Geländer; die Achse liegt wie der Handlauf der Treppe um
//! [`GUARD_INSET`] vom Lochrand auf der Decke.

use crate::model::*;
use crate::plan::wall_poche::{ceiling_outline_lines, WallFootprint};
use crate::stair_rail::{offset_polyline, P, RAIL_INSET};

/// Achse der Absturzsicherung: so weit vom Lochrand auf die Decke gerückt wie der Handlauf von der
/// Treppenkante (Rohr ganz auf der Decke).
pub const GUARD_INSET: f64 = RAIL_INSET;
/// Lochrand am Austritt: bis zu diesem Abstand von der Austrittskante keine Absturzsicherung.
const ARRIVAL_TOL: f64 = 0.15;

/// Eine auf einem Geschoss ankommende Treppe.
pub struct Arrival {
    /// Index in `Project::stairs`.
    pub stair: usize,
    /// Treppen-Parameter (`Stair::encode`) und Höhe von Unter- bis Oberkante.
    pub params: Vec<f64>,
    pub rise: f64,
    /// Löcher der Decke, in denen die Treppe liegt.
    pub rings: Vec<Vec<P>>,
    /// Achsen der Absturzsicherung (offene Züge, schon nach aussen auf die Decke versetzt).
    pub axes: Vec<Vec<P>>,
    /// Höhe des Geschossbodens (Standhöhe der Sicherung).
    pub z: f64,
}

/// Herkunft eines Deckenlochs ([202]): Aussparung `Ceiling.openings[ring]` der Decke `ceiling` (Index in
/// `Project::ceilings`) oder Deckenöffnungs-Element (Index in `Project::openings`, `hostCeilingId`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum HoleSrc {
    Ring { ceiling: usize, ring: usize },
    Opening(usize),
}

/// Löcher der Decken, deren Oberkante auf dem Geschossboden `base` steht, mit Herkunft (Reihenfolge wie
/// `opening_shape::ceiling_hole_rings`: je Decke erst die Aussparungen, dann die Öffnungs-Elemente).
pub fn floor_hole_sources(p: &Project, base: f64) -> Vec<(HoleSrc, Vec<P>)> {
    let mut out = Vec::new();
    for (ci, ce) in p.ceilings.as_deref().unwrap_or(&[]).iter().enumerate() {
        let top = p.ceiling_vertical_extent(ce).1;
        if !(top >= base - 0.3 && top <= base + 0.05) {
            continue;
        }
        for (ri, h) in ce.hole_rings().iter().enumerate() {
            out.push((HoleSrc::Ring { ceiling: ci, ring: ri }, h.iter().map(|q| [q.x, q.y]).collect::<Vec<P>>()));
        }
        for (oi, o) in p.openings.as_deref().unwrap_or(&[]).iter().enumerate() {
            if o.host_ceiling_id.as_deref() != Some(ce.id.as_str()) {
                continue;
            }
            if let Some(f) = crate::opening_shape::host_frame(p, o) {
                out.push((HoleSrc::Opening(oi), crate::opening_shape::host_rect_plan(&f, o.width, o.height).iter().map(|q| [q[0], q[1]]).collect()));
            }
        }
    }
    out.retain(|(_, h)| h.len() >= 3 && h.iter().all(|q| q[0].is_finite() && q[1].is_finite()));
    out
}

/// Löcher der Decken, deren Oberkante auf dem Geschossboden `base` steht.
fn floor_holes(p: &Project, base: f64) -> Vec<Vec<P>> {
    floor_hole_sources(p, base).into_iter().map(|(_, h)| h).collect()
}

/// Kommt die Treppe auf dem Geschoss `floor` an (Oberkante auf dessen Boden, Unterkante tiefer, anderes
/// Geschoss)? Dann deren Höhen `(zb, zt)`.
fn arrives_on(p: &Project, s: &Stair, floor: &DrawingLevel) -> Option<(f64, f64)> {
    if floor.kind != DrawingLevelKind::Floor || s.floor_id == floor.id {
        return None;
    }
    let base = floor.base_elevation.unwrap_or(0.0);
    let (zb, zt) = p.stair_vertical_extent(s);
    ((zt - base).abs() <= 0.05 && zb < base - 1e-6 && (zt - zb).is_finite()).then_some((zb, zt))
}

/// Schwerpunkte der Tritte (Grundriss) einer Treppe mit Höhe `rise`.
fn tread_centroids(s: &Stair, rise: f64) -> Vec<P> {
    let Some(sp) = crate::stair::decode_params(&s.encode()) else { return Vec::new() };
    kernel2d::stair_geometry(&sp, rise)
        .treads
        .iter()
        .map(|t| {
            let n = t.pts.len().max(1) as f64;
            [t.pts.iter().map(|q| q.x).sum::<f64>() / n, t.pts.iter().map(|q| q.y).sum::<f64>() / n]
        })
        .collect()
}

/// [202] Deckenlöcher, die mit den Treppen `moved` (ids) mitwandern: Löcher der Decken, auf denen die Treppe
/// ankommt (wie [`arrivals`]), mit mindestens einem Tritt-Schwerpunkt der Treppe darin. Es bleiben stehen:
/// - Löcher, in denen zugleich eine nicht mitbewegte Treppe ankommt (sie verlöre sonst ihr Loch);
/// - Löcher gesperrter Decken bzw. gesperrte Öffnungs-Elemente: die Sperre schützt das Bauteil vor jeder
///   Formänderung, auch der mittelbaren über die Treppe (die Treppe ist dann oben unbeschnitten zu sehen);
/// - Aussparungen von Decken in `skip_ceilings` und Elemente in `skip_openings`: sie bewegt der Aufrufer
///   schon selbst (mitgewählte Decke bzw. Öffnung) — so wandert kein Loch doppelt.
///
/// Jedes Loch erscheint höchstens einmal (Rückgabe sortiert).
pub fn carried_holes(p: &Project, moved: &dyn Fn(&str) -> bool, skip_ceilings: &dyn Fn(&str) -> bool, skip_openings: &dyn Fn(&str) -> bool) -> Vec<HoleSrc> {
    let stairs = p.stairs.as_deref().unwrap_or(&[]);
    let mut out: Vec<HoleSrc> = Vec::new();
    for floor in p.drawing_levels.iter() {
        let arriving: Vec<(&Stair, Vec<P>)> = stairs.iter().filter_map(|s| arrives_on(p, s, floor).map(|(zb, zt)| (s, tread_centroids(s, zt - zb)))).collect();
        if !arriving.iter().any(|(s, _)| moved(&s.id)) {
            continue;
        }
        let ceilings = p.ceilings.as_deref().unwrap_or(&[]);
        let openings = p.openings.as_deref().unwrap_or(&[]);
        for (src, ring) in floor_hole_sources(p, floor.base_elevation.unwrap_or(0.0)) {
            let inside = |c: &[P]| c.iter().any(|q| crate::surface_pattern::point_in(*q, &ring));
            let (mut mine, mut other) = (false, false);
            for (s, c) in &arriving {
                if inside(c) {
                    if moved(&s.id) {
                        mine = true;
                    } else {
                        other = true;
                    }
                }
            }
            if !mine || other {
                continue;
            }
            let free = match src {
                HoleSrc::Ring { ceiling, .. } => ceilings.get(ceiling).is_some_and(|c| c.locked != Some(true) && !skip_ceilings(&c.id)),
                HoleSrc::Opening(i) => openings.get(i).is_some_and(|o| {
                    let host = o.host_ceiling_id.as_deref().and_then(|h| ceilings.iter().find(|c| c.id == h));
                    o.locked != Some(true) && !skip_openings(&o.id) && host.is_some_and(|c| c.locked != Some(true) && !skip_ceilings(&c.id))
                }),
            };
            if free {
                out.push(src);
            }
        }
    }
    out.sort();
    out.dedup();
    out
}

/// Treppen anderer Geschosse (`stair_ok` wählt vor), die auf dem Geschoss `floor_id` durch ein Deckenloch
/// ankommen. Nur Geschoss-Grundrisse ([157]: nicht die 2D-Ebene eines Schnitts/einer Ansicht). `footprints`
/// liefert die Wandumrisse des Geschosses (nur bei Bedarf, einmal).
pub fn arrivals(p: &Project, floor_id: &str, stair_ok: &dyn Fn(&Stair) -> bool, footprints: &dyn Fn() -> Vec<WallFootprint>) -> Vec<Arrival> {
    arrivals_with(p, floor_id, stair_ok, footprints, false)
}

/// Wie [`arrivals`], dazu ([202]) ankommende Treppen, die in keinem Loch stehen (`rings` und `axes` leer): der
/// Grundriss zeichnet sie unbeschnitten, damit eine verschobene Treppe nie verschwindet. Die Absturzsicherung
/// (3D, IFC) bleibt an Löcher gebunden und nutzt [`arrivals`].
pub fn arrivals_in_plan(p: &Project, floor_id: &str, stair_ok: &dyn Fn(&Stair) -> bool, footprints: &dyn Fn() -> Vec<WallFootprint>) -> Vec<Arrival> {
    arrivals_with(p, floor_id, stair_ok, footprints, true)
}

fn arrivals_with(p: &Project, floor_id: &str, stair_ok: &dyn Fn(&Stair) -> bool, footprints: &dyn Fn() -> Vec<WallFootprint>, unholed: bool) -> Vec<Arrival> {
    let mut out = Vec::new();
    let Some(floor) = p.floor(floor_id) else { return out };
    if floor.kind != DrawingLevelKind::Floor {
        return out;
    }
    let base = floor.base_elevation.unwrap_or(0.0);
    let holes = floor_holes(p, base);
    if holes.is_empty() && !unholed {
        return out;
    }
    let mut fps: Option<Vec<WallFootprint>> = None;
    for (si, s) in p.stairs.as_deref().unwrap_or(&[]).iter().enumerate().filter(|(_, s)| stair_ok(s)) {
        let Some((zb, zt)) = arrives_on(p, s, floor) else { continue };
        let params = s.encode();
        let Some(sp) = crate::stair::decode_params(&params) else { continue };
        let geo = kernel2d::stair_geometry(&sp, zt - zb);
        let centroid = |t: &kernel2d::TreadRect| {
            let n = t.pts.len().max(1) as f64;
            [t.pts.iter().map(|q| q.x).sum::<f64>() / n, t.pts.iter().map(|q| q.y).sum::<f64>() / n]
        };
        let rings: Vec<Vec<P>> = holes.iter().filter(|h| geo.treads.iter().any(|t| crate::surface_pattern::point_in(centroid(t), h))).cloned().collect();
        if rings.is_empty() {
            if unholed {
                out.push(Arrival { stair: si, params: params.to_vec(), rise: zt - zb, rings, axes: Vec::new(), z: base });
            }
            continue;
        }
        let mut axes = Vec::new();
        // Austrittskante: Hinterkante des obersten Tritts.
        if let Some(last) = geo.treads.iter().filter(|t| t.pts.len() >= 4).max_by(|a, b| a.top_rise.total_cmp(&b.top_rise)) {
            let arrival = if sp.shape == "spiral" { (last.pts[3], last.pts[2]) } else { (last.pts[1], last.pts[2]) };
            let fps = fps.get_or_insert_with(footprints);
            for ring in &rings {
                for pts in guard_chains(ring, fps, ([arrival.0.x, arrival.0.y], [arrival.1.x, arrival.1.y])) {
                    let area: f64 = (0..ring.len()).map(|i| ring[i][0] * ring[(i + 1) % ring.len()][1] - ring[(i + 1) % ring.len()][0] * ring[i][1]).sum();
                    // nach aussen (auf die Decke): rechts der Ringrichtung bei Gegenuhrzeigersinn
                    let d = if area > 0.0 { -GUARD_INSET } else { GUARD_INSET };
                    axes.push(offset_polyline(&pts, d));
                }
            }
        }
        out.push(Arrival { stair: si, params: params.to_vec(), rise: zt - zb, rings, axes, z: base });
    }
    out
}

/// Freie Lochränder als Züge in Ringrichtung: ohne Stücke unter Wänden und ohne die Austrittskante.
fn guard_chains(ring: &[[f64; 2]], fps: &[WallFootprint], arrival: ([f64; 2], [f64; 2])) -> Vec<Vec<[f64; 2]>> {
    let near = |a: [f64; 2], b: [f64; 2]| (a[0] - b[0]).abs() < 1e-7 && (a[1] - b[1]).abs() < 1e-7;
    let mut pieces: Vec<[[f64; 2]; 2]> = Vec::new();
    for [a, b] in ceiling_outline_lines(ring, &[], fps) {
        // Teil, der an der Austrittskante liegt (beide Enden der Kante nahe der Geraden a–b), entfällt.
        let d = [b[0] - a[0], b[1] - a[1]];
        let l = d[0].hypot(d[1]);
        if !(l > 1e-9) {
            continue;
        }
        let u = [d[0] / l, d[1] / l];
        let off = |q: [f64; 2]| ((q[0] - a[0]) * u[1] - (q[1] - a[1]) * u[0]).abs();
        let t = |q: [f64; 2]| ((q[0] - a[0]) * u[0] + (q[1] - a[1]) * u[1]) / l;
        let mut keep = vec![(0.0, 1.0)];
        if off(arrival.0) < ARRIVAL_TOL && off(arrival.1) < ARRIVAL_TOL {
            let pad = ARRIVAL_TOL / l;
            let (t0, t1) = (t(arrival.0).min(t(arrival.1)) - pad, t(arrival.0).max(t(arrival.1)) + pad);
            keep = [(0.0, t0.min(1.0)), (t1.max(0.0), 1.0)].into_iter().filter(|(x, y)| (y - x) * l > 1e-6).collect();
        }
        for (t0, t1) in keep {
            pieces.push([[a[0] + d[0] * t0, a[1] + d[1] * t0], [a[0] + d[0] * t1, a[1] + d[1] * t1]]);
        }
    }
    // aneinanderhängende Stücke zu Zügen
    let mut chains: Vec<Vec<[f64; 2]>> = Vec::new();
    for [a, b] in pieces {
        match chains.last_mut() {
            Some(ch) if ch.last().is_some_and(|q| near(*q, a)) => ch.push(b),
            _ => chains.push(vec![a, b]),
        }
    }
    // letzter Zug schliesst an den ersten an
    if chains.len() >= 2 && near(*chains.last().unwrap().last().unwrap(), chains[0][0]) {
        let mut last = chains.pop().unwrap();
        last.extend(chains[0].iter().skip(1).copied());
        chains[0] = last;
    }
    // [155] Ein freier Lochring ohne Wand und Austritt ist ein einziger geschlossener Zug: Anfang und Ende
    // fallen genau zusammen, damit die Achse an der Naht eine Gehrung bekommt statt zweier stumpfer Enden.
    if let [ch] = chains.as_mut_slice() {
        if ch.len() >= 4 && near(*ch.last().unwrap(), ch[0]) {
            let first = ch[0];
            *ch.last_mut().unwrap() = first;
        }
    }
    chains
}

/// Länge aller Achsen (m), für die IFC-Basismengen.
pub fn axes_length(axes: &[Vec<P>]) -> f64 {
    axes.iter().map(|a| a.windows(2).map(|w| (w[1][0] - w[0][0]).hypot(w[1][1] - w[0][1])).sum::<f64>()).sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Project {
        serde_json::from_str(include_str!("../tests/fixtures/sample_project.json")).unwrap()
    }

    /// ST1 (EG) steht bei x 3.2 … 4.2, y 0.4 … 3.6; Loch in C1 (OG-Boden) darüber.
    fn with_hole() -> Project {
        let mut p = sample();
        let hole = vec![Vec2 { x: 3.2, y: 1.6 }, Vec2 { x: 4.2, y: 1.6 }, Vec2 { x: 4.2, y: 3.6 }, Vec2 { x: 3.2, y: 3.6 }];
        p.ceilings.as_mut().unwrap()[0].openings = Some(vec![hole]);
        p
    }

    #[test]
    fn ankommende_treppe_hat_achsen_auf_der_decke() {
        let p = with_hole();
        let a = arrivals(&p, "og", &|_| true, &|| vec![]);
        assert_eq!(a.len(), 1);
        assert!(!a[0].axes.is_empty() && axes_length(&a[0].axes) > 1.0);
        // nicht auf dem Loch: jede Achse ausserhalb des Lochrings
        assert!(a[0].axes.iter().flatten().all(|q| !crate::surface_pattern::point_in(*q, &a[0].rings[0])));
        // ohne Loch / im Geschoss der Treppe: nichts
        assert!(arrivals(&sample(), "og", &|_| true, &|| vec![]).is_empty());
        assert!(arrivals(&p, "eg", &|_| true, &|| vec![]).is_empty());
    }

    /// 3D: Körper aus Pfosten, Handlauf und Stäben auf der Decke (Boden des OG), nur mit Loch.
    #[test]
    fn absturzsicherung_als_3d_koerper() {
        let p = with_hole();
        let base = p.floor("og").unwrap().base_elevation.unwrap();
        let g = crate::model3d::stair_guard_meshes(&p);
        assert_eq!(g.len(), 1);
        let m = &g[0].1;
        let zs: Vec<f64> = m.positions.chunks(3).map(|q| q[2]).collect();
        let (lo, hi) = zs.iter().fold((f64::MAX, f64::MIN), |(a, b), &z| (a.min(z), b.max(z)));
        assert!((lo - base).abs() < 1e-6 && (hi - base - crate::stair_rail::RAIL_HEIGHT).abs() < 0.05, "{lo} {hi} {base}");
        assert!(m.indices.len() > 300, "Pfosten, Handlauf und Stäbe");
        assert!(crate::model3d::emit_stair_railings(&p).len() > crate::model3d::emit_stair_handrails(&p).len());
        assert!(crate::model3d::stair_guard_meshes(&sample()).is_empty());
        assert!(!crate::model3d::pick_stair_railings(&p).is_empty());
    }

    /// IFC: eigenes Geländer (GUARDRAIL) an der Treppe, mit Länge als Basismenge.
    #[test]
    fn absturzsicherung_im_ifc_teil() {
        let mut p = with_hole();
        let st = p.stairs.as_ref().unwrap()[0].clone();
        p.stairs = Some(vec![st.clone()]);
        let parts = crate::ifc_stairs::stair_parts(&p, &st, 0.0);
        let g = parts.guard.expect("Absturzsicherung");
        assert!(g.quantities[0].value > 1.0 && !g.mesh.indices.is_empty());
    }

    /// [155] Freier Lochring ohne Wand und Austritt: ein geschlossener Zug mit Gehrung an der Naht.
    #[test]
    fn freier_ring_ist_geschlossen_mit_gehrung() {
        let ring: Vec<[f64; 2]> = vec![[0.0, 0.0], [2.0, 0.0], [2.0, 2.0], [0.0, 2.0]];
        let chains = guard_chains(&ring, &[], ([9.0, 9.0], [9.5, 9.0]));
        assert_eq!(chains.len(), 1);
        assert!(crate::stair_rail::is_closed(&chains[0]), "{:?}", chains[0]);
        let axis = offset_polyline(&chains[0], GUARD_INSET);
        assert!(crate::stair_rail::is_closed(&axis));
        // alle Ecken (auch die Naht) um GUARD_INSET innen, mit Gehrung: Quadrat 0.04 … 1.96
        for q in &axis {
            assert!(((q[0] - 1.0).abs() - (1.0 - GUARD_INSET)).abs() < 1e-9 && ((q[1] - 1.0).abs() - (1.0 - GUARD_INSET)).abs() < 1e-9, "{q:?}");
        }
        // Ring mit Austritt: offener Zug, rechtwinkliger Abschluss
        let open = guard_chains(&ring, &[], ([1.0, 0.0], [1.5, 0.0]));
        assert_eq!(open.len(), 1);
        assert!(!crate::stair_rail::is_closed(&open[0]));
        let a = offset_polyline(&open[0], GUARD_INSET);
        assert!((a[0][0] - open[0][0][0]).abs() < 1e-9, "Anfang senkrecht zur Kante: {:?}", a[0]);
    }

    /// [T3] Profil der Treppe wirkt auf Absturzsicherung (3D) und IFC-Basismengen (Querschnittsfläche); Rundung wie bisher.
    #[test]
    fn handlaufprofil_in_3d_und_ifc() {
        let mut p = with_hole();
        let area = |p: &Project| {
            let st = p.stairs.as_ref().unwrap()[0].clone();
            let g = crate::ifc_stairs::stair_parts(p, &st, 0.0).guard.unwrap();
            g.quantities.iter().find(|q| q.name == "CrossSectionArea").unwrap().value
        };
        let round_mesh = crate::model3d::stair_guard_meshes(&p)[0].1.positions.len();
        assert!((area(&p) - std::f64::consts::PI * 0.02 * 0.02).abs() < 1e-9);
        let st = &mut p.stairs.as_mut().unwrap()[0];
        st.rail_profile = Some(StairRailProfile::Rechteck);
        st.rail_width = Some(0.05);
        st.rail_height = Some(0.03);
        st.post_profile = Some(StairRailProfile::Rechteck);
        assert!((area(&p) - 0.0015).abs() < 1e-9);
        assert!(crate::model3d::stair_guard_meshes(&p)[0].1.positions.len() < round_mesh);
        // JSON-Namen
        let j = serde_json::to_value(&p.stairs.as_ref().unwrap()[0]).unwrap();
        assert_eq!(j["railProfile"], "rechteck");
        assert_eq!(j["railWidth"], 0.05);
        assert!(serde_json::to_value(&sample().stairs.unwrap()[0]).unwrap().get("railProfile").is_none());
    }

    // ── [202] Das Loch wandert mit ──────────────────────────────────────────────

    use crate::document::Document;
    use serde_json::{json, Value};

    fn doc_of(p: &Project) -> Document {
        Document::from_json(&serde_json::to_string(p).unwrap()).unwrap()
    }

    fn ring_of(d: &Document, i: usize) -> Vec<(f64, f64)> {
        d.root()["ceilings"][0]["openings"][i].as_array().unwrap().iter().map(|q| (q["x"].as_f64().unwrap(), q["y"].as_f64().unwrap())).collect()
    }

    fn stair_start(d: &Document, id: &str) -> (f64, f64) {
        let s = d.root()["stairs"].as_array().unwrap().iter().find(|s| s["id"] == id).unwrap();
        (s["start"]["x"].as_f64().unwrap(), s["start"]["y"].as_f64().unwrap())
    }

    fn close(a: &[(f64, f64)], b: &[(f64, f64)]) {
        assert_eq!(a.len(), b.len());
        for (x, y) in a.iter().zip(b) {
            assert!((x.0 - y.0).abs() < 1e-9 && (x.1 - y.1).abs() < 1e-9, "{a:?} != {b:?}");
        }
    }

    fn shifted(r: &[(f64, f64)], d: (f64, f64)) -> Vec<(f64, f64)> {
        r.iter().map(|q| (q.0 + d.0, q.1 + d.1)).collect()
    }

    fn grip(d: &mut Document, req: Value, now: f64) {
        let req: crate::grips::Request = serde_json::from_value(req).unwrap();
        let res = crate::grips::run_doc(d, &req).unwrap();
        d.commit(res.ops, None, now, false).unwrap();
    }

    fn transform(d: &mut Document, stairs: &[&str], op: &str, pts: Value, now: f64) {
        let req = json!({"cmd":"transform","sel":{"wallIds":[],"drawingId":null,"stairIds":stairs},"op":op,"pts":pts,"mode":"move","count":1,"stamp":"s"});
        let res = {
            let (p, lk) = d.project_lookup().unwrap();
            crate::commands::result(lk.root, p, &req.to_string()).unwrap()
        };
        d.commit(res.ops, None, now, false).unwrap();
    }

    /// Griff „Bewegpunkt“ (`stairBy`): Loch um denselben Vektor, ein Undo-Schritt für beides.
    #[test]
    fn treppe_ziehen_nimmt_loch_mit() {
        let mut d = doc_of(&with_hole());
        let (r0, s0) = (ring_of(&d, 0), stair_start(&d, "ST1"));
        let depth = d.history().undo_depth();
        grip(&mut d, json!({"op":"stairBy","id":"ST1","delta":[-1.0, 0.2]}), 1.0);
        close(&ring_of(&d, 0), &shifted(&r0, (-1.0, 0.2)));
        close(&[stair_start(&d, "ST1")], &[(s0.0 - 1.0, s0.1 + 0.2)]);
        assert_eq!(d.history().undo_depth(), depth + 1);
        // Plan des OG: Treppe weiter im Loch (beschnitten, mit Absturzsicherung)
        let p: Project = serde_json::from_value(Value::Object(d.root().clone())).unwrap();
        let a = arrivals(&p, "og", &|_| true, &|| vec![]);
        assert_eq!(a.len(), 1);
        assert!(!a[0].axes.is_empty());
        d.undo();
        close(&ring_of(&d, 0), &r0);
        close(&[stair_start(&d, "ST1")], &[s0]);
    }

    /// Befehl Bewegen: Loch mit, Rückgängig in einem Schritt.
    #[test]
    fn treppe_bewegen_nimmt_loch_mit() {
        let mut d = doc_of(&with_hole());
        let r0 = ring_of(&d, 0);
        transform(&mut d, &["ST1"], "move", json!([[0, 0], [-0.5, 0.25]]), 1.0);
        close(&ring_of(&d, 0), &shifted(&r0, (-0.5, 0.25)));
        d.undo();
        close(&ring_of(&d, 0), &r0);
    }

    /// Drehen: das Loch dreht mit (gleiche Abbildung wie die Treppe).
    #[test]
    fn treppe_drehen_dreht_loch_mit() {
        let mut d = doc_of(&with_hole());
        let r0 = ring_of(&d, 0);
        // 90° um (3.7, 2.0)
        transform(&mut d, &["ST1"], "rotate", json!([[3.7, 2.0], [4.7, 2.0], [3.7, 3.0]]), 1.0);
        let want: Vec<(f64, f64)> = r0.iter().map(|q| (3.7 - (q.1 - 2.0), 2.0 + (q.0 - 3.7))).collect();
        close(&ring_of(&d, 0), &want);
        let p: Project = serde_json::from_value(Value::Object(d.root().clone())).unwrap();
        assert_eq!(arrivals(&p, "og", &|_| true, &|| vec![]).len(), 1, "gedrehte Treppe im gedrehten Loch");
    }

    /// Loch mit einer zweiten (nicht bewegten) Treppe bleibt; beide zusammen bewegt: Loch einmal mit.
    #[test]
    fn loch_mit_zwei_treppen() {
        let mut p = with_hole();
        let wide = vec![Vec2 { x: 2.0, y: 1.6 }, Vec2 { x: 4.2, y: 1.6 }, Vec2 { x: 4.2, y: 3.6 }, Vec2 { x: 2.0, y: 3.6 }];
        p.ceilings.as_mut().unwrap()[0].openings = Some(vec![wide]);
        let mut st2 = p.stairs.as_ref().unwrap()[0].clone();
        st2.id = "ST2".into();
        st2.start.x = 2.6;
        p.stairs.as_mut().unwrap().push(st2);
        let mut d = doc_of(&p);
        let r0 = ring_of(&d, 0);
        grip(&mut d, json!({"op":"stairBy","id":"ST1","delta":[0.3, 0.0]}), 1.0);
        close(&ring_of(&d, 0), &r0);
        transform(&mut d, &["ST1"], "move", json!([[0, 0], [0.1, 0]]), 2.0);
        close(&ring_of(&d, 0), &r0);
        transform(&mut d, &["ST1", "ST2"], "move", json!([[0, 0], [-0.2, 0.1]]), 3.0);
        close(&ring_of(&d, 0), &shifted(&r0, (-0.2, 0.1)));
    }

    /// Gesperrte Decke: Loch bleibt (Sperre schützt die Decke); mitgewählte Decke: nicht doppelt bewegt.
    #[test]
    fn gesperrte_oder_mitgewaehlte_decke() {
        let mut p = with_hole();
        p.ceilings.as_mut().unwrap()[0].locked = Some(true);
        let mut d = doc_of(&p);
        let r0 = ring_of(&d, 0);
        grip(&mut d, json!({"op":"stairBy","id":"ST1","delta":[-1.0, 0.0]}), 1.0);
        close(&ring_of(&d, 0), &r0);
        let mut d = doc_of(&with_hole());
        let req = json!({"cmd":"transform","sel":{"wallIds":[],"drawingId":null,"stairIds":["ST1"],"ceilingIds":["C1"]},"op":"move","pts":[[0,0],[-0.5,0]],"mode":"move","count":1,"stamp":"s"});
        let res = {
            let (p, lk) = d.project_lookup().unwrap();
            crate::commands::result(lk.root, p, &req.to_string()).unwrap()
        };
        assert_eq!(res.ops.iter().filter(|o| matches!(o, crate::ops::Op::Replace { collection, .. } if collection == "ceilings")).count(), 1);
        d.commit(res.ops, None, 1.0, false).unwrap();
        close(&ring_of(&d, 0), &shifted(&r0, (-0.5, 0.0)));
    }

    /// Deckenöffnung als eigenes Element (`hostCeilingId`): Mittelpunkt wandert mit, Drehen dreht die Richtung.
    #[test]
    fn deckenoeffnung_als_element_wandert_mit() {
        let mut p = sample();
        let o: Opening = serde_json::from_value(json!({"id":"DO1","type":"opening","hostWallId":"","categoryCode":"30","kind":"window","position":0,"width":1.0,"height":2.0,"sillHeight":0,
            "hostCeilingId":"C1","hostPoint":{"x":3.7,"y":2.6},"hostAngle":0})).unwrap();
        p.openings.get_or_insert_with(Vec::new).push(o);
        assert_eq!(arrivals(&p, "og", &|_| true, &|| vec![]).len(), 1, "Treppe im Öffnungs-Element");
        let mut d = doc_of(&p);
        let hp = |d: &Document| {
            let o = d.root()["openings"].as_array().unwrap().iter().find(|o| o["id"] == "DO1").unwrap().clone();
            ((o["hostPoint"]["x"].as_f64().unwrap(), o["hostPoint"]["y"].as_f64().unwrap()), o["hostAngle"].as_f64().unwrap())
        };
        grip(&mut d, json!({"op":"stairBy","id":"ST1","delta":[-1.0, 0.1]}), 1.0);
        close(&[hp(&d).0], &[(2.7, 2.7)]);
        transform(&mut d, &["ST1"], "rotate", json!([[2.7, 2.1], [3.7, 2.1], [2.7, 3.1]]), 2.0);
        close(&[hp(&d).0], &[(2.1, 2.1)]);
        assert!((hp(&d).1 - std::f64::consts::FRAC_PI_2).abs() < 1e-9);
    }

    /// Ankommende Treppe ohne Loch: im Grundriss trotzdem (unbeschnitten, ohne Sicherung), 3D/IFC ohne Sicherung.
    #[test]
    fn ankommende_treppe_ohne_loch_im_plan() {
        let p = sample();
        assert!(arrivals(&p, "og", &|_| true, &|| vec![]).is_empty());
        let a = arrivals_in_plan(&p, "og", &|_| true, &|| vec![]);
        assert_eq!(a.len(), 1);
        assert!(a[0].rings.is_empty() && a[0].axes.is_empty());
        assert!(arrivals_in_plan(&p, "eg", &|_| true, &|| vec![]).is_empty());
    }

}
