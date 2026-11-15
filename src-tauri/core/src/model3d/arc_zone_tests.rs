//! [216] Erker: Sehnen-Zonen der Bogenwände über die Geschosse vereinigt, Deckenrand auf der Wandflucht, Gehrung ohne Stufe.

use super::*;
use crate::plan::section::{compute_section, Kind, LevelSpec};
use crate::wall_arc::WallArc;

/// Beispielprojekt mit W1 (EG) und W5 (OG) als deckungsgleiche Halbkreise nach aussen (Achse r = 2.5 um (2.5, 0)),
/// Fenster mit Schichteinzug: R1 im EG über dem Scheitel (Bogenlänge 3.3–4.5), R2 im OG versetzt (3.0–4.0). Decke C1
/// (EG) mit Bogenkante bis zur Aussenfläche.
fn erker() -> Project {
    let mut p: Project = serde_json::from_str(include_str!("../../tests/fixtures/sample_project.json")).unwrap();
    for w in p.walls.iter_mut().filter(|w| w.id == "W1" || w.id == "W5") {
        w.bulge = Some(-1.0);
    }
    p.walls.retain(|w| w.id != "W9");
    let win = |id: &str, host: &str, pos: f64, width: f64| -> Opening {
        serde_json::from_value(serde_json::json!({
            "id": id, "type": "opening", "hostWallId": host, "categoryCode": "21", "kind": "window", "typeId": "",
            "position": pos, "width": width, "height": 1.2, "sillHeight": 0.9,
            "layerReveals": [{ "layer": -1, "mode": "zurueck", "amount": 0.05 }, { "layer": 0, "mode": "leibung" }]
        }))
        .unwrap()
    };
    p.openings = Some(vec![win("R1", "W1", 3.3, 1.2), win("R2", "W5", 3.0, 1.0)]);
    let h = 0.345 / 2.0;
    let c = &mut p.ceilings.as_mut().unwrap()[0];
    c.outline = [(-h, 0.0), (5.0 + h, 0.0), (5.0 + h, 4.0 + h), (-h, 4.0 + h)].iter().map(|&(x, y)| Vec2 { x, y }).collect();
    c.outline_bulge = Some(vec![-1.0, 0.0, 0.0, 0.0]);
    p
}

fn wall<'a>(p: &'a Project, id: &str) -> &'a Wall {
    p.walls.iter().find(|w| w.id == id).unwrap()
}

#[test]
fn zonen_der_geschosse_fluchten() {
    let p = erker();
    let (w1, w5) = (wall(&p, "W1"), wall(&p, "W5"));
    let (z1, z5) = (arc_zones(&p, w1), arc_zones(&p, w5));
    assert_eq!(z1.len(), 1, "{z1:?}");
    assert_eq!(z1.len(), z5.len());
    assert!((z1[0].0 - z5[0].0).abs() < 1e-9 && (z1[0].1 - z5[0].1).abs() < 1e-9, "{z1:?} {z5:?}");
    // Vereinigung beider Öffnungsbereiche (samt Rücksprung und Zuschlag).
    assert!(z1[0].0 < 3.0 - crate::wall_arc::REVEAL_MARGIN + 1e-9 && z1[0].1 > 4.5 + crate::wall_arc::REVEAL_MARGIN - 1e-9, "{z1:?}");
    let a = WallArc::of_wall(w1).unwrap();
    let os = p.openings.as_ref().unwrap();
    let place = |w: &Wall, o: &Opening| arc_placement(&p, w, &a, o);
    assert_eq!(place(w1, &os[0]), ArcPlacement::Zone(z1[0].0, z1[0].1));
    assert_eq!(place(w5, &os[1]), ArcPlacement::Zone(z1[0].0, z1[0].1));
    // 3D: die Zonen-Teilwände beider Geschosse liegen auf derselben Sehne (gleiche Achs-Endpunkte).
    let walls = emit_walls(&p, true).unwrap();
    let (pa, pb) = (a.point(z1[0].0, 0.0), a.point(z1[0].1, 0.0));
    let (u, l) = ([(pb.x - pa.x) / (pb.x - pa.x).hypot(pb.y - pa.y), (pb.y - pa.y) / (pb.x - pa.x).hypot(pb.y - pa.y)], (pb.x - pa.x).hypot(pb.y - pa.y));
    for id in ["W1", "W5"] {
        // Ein Stück liegt ganz in der Zone und parallel zur Sehne (Querlage konstant).
        let ok = walls.iter().filter(|q| q.wall_id == id).any(|q| {
            let d = [q.end[0] - q.start[0], q.end[1] - q.start[1]];
            let len = d[0].hypot(d[1]);
            len > 0.9 * l && (d[0] * u[1] - d[1] * u[0]).abs() / len < 1e-9
        });
        assert!(ok, "{id}: kein Stück auf der Zonen-Sehne");
    }
}

/// Querlage eines Punkts zur Sehne der Zone (linke Normale der Sehne, wie `n` der Wand).
fn chord_n(a: &WallArc, z: (f64, f64), q: [f64; 2]) -> f64 {
    let (pa, u, _) = crate::wall_arc::chord_of(a, z.0, z.1);
    (q[0] - pa.x) * -u.y + (q[1] - pa.y) * u.x
}

#[test]
fn decke_ragt_nicht_ueber_die_wandflucht() {
    let p = erker();
    let w1 = wall(&p, "W1");
    let a = WallArc::of_wall(w1).unwrap();
    let z = arc_zones(&p, w1)[0];
    let f = bearing::outer_faces(&p, w1).unwrap();
    // Aussen = Richtung o_out (vom Kern aus).
    let out = (f.o_out - f.o_core).signum();
    let (j0, j1) = (crate::wall_arc::zone_face_end(&a, z, f.o_core, false), crate::wall_arc::zone_face_end(&a, z, f.o_core, true));
    let (s0, s1) = (a.local(j0).0, a.local(j1).0);
    let in_zone = |q: [f64; 2]| {
        let s = a.local(kernel2d::Vec2::new(q[0], q[1])).0;
        s > s0 + 1e-6 && s < s1 - 1e-6
    };
    // 3D (und damit Schnitt/Ansicht): Platte bis Kern-Aussenkante — in der Zone die Sehnen-Parallele.
    let slabs = emit_slabs(&p);
    let concrete = slabs.iter().find(|s| s.cut.as_ref().and_then(|c| c.component_id.as_deref()) == Some("concrete")).expect("Betonschicht");
    let o = &concrete.outline;
    let pts: Vec<[f64; 2]> = (0..o.len())
        .flat_map(|i| {
            let (p0, p1) = (o[i], o[(i + 1) % o.len()]);
            (0..20).map(move |k| {
                let t = k as f64 / 20.0;
                [p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t]
            })
        })
        .filter(|q| in_zone(*q))
        .collect();
    assert!(!pts.is_empty());
    for q in &pts {
        let over = (chord_n(&a, z, *q) - f.o_core) * out;
        assert!(over < 1e-4, "Platte {q:?} ragt {over} m über die Kern-Aussenkante");
    }
    // Schnitt quer durch den Scheitel (x = 2.5, Zonenmitte): Platte beginnt an der Kern-Aussenkante.
    let l = LevelSpec { kind: "section".into(), line: Some([Vec2 { x: 2.5, y: -4.0 }, Vec2 { x: 2.5, y: 5.0 }]), ..Default::default() };
    let cuts = compute_section(&p, &l, &[]).unwrap().unwrap().cuts;
    let u0 = |kind: Kind, comp: &str, src: Option<&str>| {
        cuts.iter()
            .filter(|c| c.kind == kind && c.component_id.as_deref() == Some(comp) && (src.is_none() || c.source_id.as_deref() == src))
            .flat_map(|c| c.pts.iter().map(|q| q[0]))
            .fold(f64::INFINITY, f64::min)
    };
    let (brick, slab) = (u0(Kind::Wall, "brick", Some("W1")), u0(Kind::Slab, "concrete", None));
    assert!(brick.is_finite() && slab.is_finite());
    assert!((slab - brick).abs() < 1e-3, "Schnitt: Platte ab u = {slab}, Backstein aussen bei {brick}");
    // Grundriss: Deckenrand (Umriss bis Aussenfläche) folgt in der Zone der Aussenfläche auf der Sehne.
    let ring = bearing::plan_ceiling_ring(&p, &p.ceilings.as_ref().unwrap()[0]);
    let (k0, k1) = (crate::wall_arc::zone_face_end(&a, z, f.o_out, false), crate::wall_arc::zone_face_end(&a, z, f.o_out, true));
    let (t0, t1) = (a.local(k0).0, a.local(k1).0);
    let mut n_in = 0;
    for q in &ring {
        let s = a.local(kernel2d::Vec2::new(q[0], q[1])).0;
        if s > t0 - 1e-6 && s < t1 + 1e-6 && q[1] < -0.5 {
            // In der Zone auf der Wandflucht (Sehnen-Parallele der Aussenfläche), nicht davor und nicht auf dem Bogen.
            let d = chord_n(&a, z, *q) - f.o_out;
            assert!(d.abs() < 1e-4, "Deckenrand {q:?} {d} m neben der Wandflucht");
            n_in += 1;
        }
    }
    assert!(n_in >= 2, "Deckenrand mit Zonen-Enden ({n_in})");
}

/// Ecken eines Bandstücks am Anfang/Ende (±Dicke/2 auf der Schnittlinie).
fn corners(q: &RWall, at_end: bool) -> [[f64; 2]; 2] {
    let d = [q.end[0] - q.start[0], q.end[1] - q.start[1]];
    let l = d[0].hypot(d[1]);
    let (u, n) = ([d[0] / l, d[1] / l], [-d[1] / l, d[0] / l]);
    let base = if at_end { q.end } else { q.start };
    let cut = if at_end { q.end_cut } else { q.start_cut };
    [-1.0, 1.0].map(|k| {
        let p0 = [base[0] + n[0] * k * q.thickness / 2.0, base[1] + n[1] * k * q.thickness / 2.0];
        match cut {
            Some(c) => {
                let den = u[0] * c[3] - u[1] * c[2];
                let t = ((c[0] - p0[0]) * c[3] - (c[1] - p0[1]) * c[2]) / den;
                [p0[0] + u[0] * t, p0[1] + u[1] * t]
            }
            None => p0,
        }
    })
}

#[test]
fn keine_stufe_an_den_zonenenden() {
    let p = erker();
    for layered in [true, false] {
        let walls = emit_walls(&p, layered).unwrap();
        let pieces: Vec<&RWall> = walls.iter().filter(|q| q.wall_id == "W1").collect();
        // Kein Stück mit gekreuzten Gehrungen (Ende vor Anfang auf einer Seite: verdrehter Körper).
        for q in &pieces {
            let (s, e) = (corners(q, false), corners(q, true));
            let d = [q.end[0] - q.start[0], q.end[1] - q.start[1]];
            for k in 0..2 {
                let along = (e[k][0] - s[k][0]) * d[0] + (e[k][1] - s[k][1]) * d[1];
                assert!(along > 0.0, "layered={layered}: Stück {:?}→{:?} mit gekreuzten Gehrungen", q.start, q.end);
            }
        }
        let mut pairs = 0;
        for a in &pieces {
            for b in &pieces {
                // Nachbarn: dieselbe Gehrungslinie am Ende von a und am Anfang von b.
                let near = match (a.end_cut, b.start_cut) {
                    (Some(c), Some(d)) => {
                        let par = (c[2] * d[3] - c[3] * d[2]).abs() < 1e-9;
                        let on = ((c[0] - d[0]) * d[3] - (c[1] - d[1]) * d[2]).abs() < 1e-9;
                        par && on && (a.end[0] - b.start[0]).hypot(a.end[1] - b.start[1]) < 0.05
                    }
                    _ => false,
                };
                let zo = (a.base_elevation + a.height).min(b.base_elevation + b.height) - a.base_elevation.max(b.base_elevation);
                if std::ptr::eq(*a, *b) || !near || a.band != b.band || zo < 1e-3 || (a.thickness - b.thickness).abs() > 1e-9 {
                    continue;
                }
                let (ea, sb) = (corners(a, true), corners(b, false));
                // Gleiche Seite: die Ecke von b, die der von a am nächsten liegt.
                for e in ea {
                    let d = sb.iter().map(|s| (s[0] - e[0]).hypot(s[1] - e[1])).fold(f64::INFINITY, f64::min);
                    assert!(d < 1e-4, "layered={layered}: Stufe {d} m an {e:?} (Stücke {:?}→{:?} cut {:?} t {} z {}+{} / {:?}→{:?} cut {:?} t {} z {}+{}, band {})", a.start, a.end, a.end_cut, a.thickness, a.base_elevation, a.height, b.start, b.end, b.start_cut, b.thickness, b.base_elevation, b.height, a.band);
                }
                pairs += 1;
            }
        }
        assert!(pairs > 10, "layered={layered}: zu wenige Stösse ({pairs})");
    }
}

#[test]
fn zonenende_auf_bogen_und_sehne() {
    let a = WallArc::of(kernel2d::Vec2::new(0.0, 0.0), kernel2d::Vec2::new(5.0, 0.0), Some(-1.0)).unwrap();
    let z = (3.0, 4.6);
    for n in [-0.17, -0.05, 0.0, 0.12, 0.17] {
        for end in [false, true] {
            let q = crate::wall_arc::zone_face_end(&a, z, n, end);
            let r = (q.x - a.center.x).hypot(q.y - a.center.y);
            assert!((r - a.radius_at(n)).abs() < 1e-9, "auf dem Versatzkreis");
            assert!((chord_n(&a, z, [q.x, q.y]) - n).abs() < 1e-9, "auf der Sehnen-Parallelen");
        }
    }
    // Wirksame Fläche: Punktzug ohne Sprung (grösster Abstand ≤ Teilung).
    let pts = crate::wall_arc::face_polyline(&a, &[z], 0.17, 0.0, a.length());
    let gap = pts.windows(2).map(|w| (w[1].x - w[0].x).hypot(w[1].y - w[0].y)).fold(0.0f64, f64::max);
    assert!(gap < z.1 - z.0 + 1e-6, "{gap}");
}

