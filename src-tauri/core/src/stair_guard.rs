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

/// Löcher der Decken, deren Oberkante auf dem Geschossboden `base` steht.
fn floor_holes(p: &Project, base: f64) -> Vec<Vec<P>> {
    p.ceilings
        .as_deref()
        .unwrap_or(&[])
        .iter()
        .filter(|ce| {
            let top = p.ceiling_vertical_extent(ce).1;
            top >= base - 0.3 && top <= base + 0.05
        })
        .flat_map(|ce| crate::opening_shape::ceiling_hole_rings(p, ce))
        .map(|h| h.iter().map(|q| [q.x, q.y]).collect::<Vec<P>>())
        .filter(|h| h.len() >= 3 && h.iter().all(|q| q[0].is_finite() && q[1].is_finite()))
        .collect()
}

/// Treppen anderer Geschosse (`stair_ok` wählt vor), die auf dem Geschoss `floor_id` durch ein Deckenloch
/// ankommen. Nur Geschoss-Grundrisse ([157]: nicht die 2D-Ebene eines Schnitts/einer Ansicht). `footprints`
/// liefert die Wandumrisse des Geschosses (nur bei Bedarf, einmal).
pub fn arrivals(p: &Project, floor_id: &str, stair_ok: &dyn Fn(&Stair) -> bool, footprints: &dyn Fn() -> Vec<WallFootprint>) -> Vec<Arrival> {
    let mut out = Vec::new();
    let Some(floor) = p.floor(floor_id) else { return out };
    if floor.kind != DrawingLevelKind::Floor {
        return out;
    }
    let base = floor.base_elevation.unwrap_or(0.0);
    let holes = floor_holes(p, base);
    if holes.is_empty() {
        return out;
    }
    let mut fps: Option<Vec<WallFootprint>> = None;
    for (si, s) in p.stairs.as_deref().unwrap_or(&[]).iter().enumerate().filter(|(_, s)| s.floor_id != floor_id && stair_ok(s)) {
        let (zb, zt) = p.stair_vertical_extent(s);
        if !((zt - base).abs() <= 0.05 && zb < base - 1e-6 && (zt - zb).is_finite()) {
            continue;
        }
        let params = s.encode();
        let Some(sp) = crate::stair::decode_params(&params) else { continue };
        let geo = kernel2d::stair_geometry(&sp, zt - zb);
        let centroid = |t: &kernel2d::TreadRect| {
            let n = t.pts.len().max(1) as f64;
            [t.pts.iter().map(|q| q.x).sum::<f64>() / n, t.pts.iter().map(|q| q.y).sum::<f64>() / n]
        };
        let rings: Vec<Vec<P>> = holes.iter().filter(|h| geo.treads.iter().any(|t| crate::surface_pattern::point_in(centroid(t), h))).cloned().collect();
        if rings.is_empty() {
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
}
