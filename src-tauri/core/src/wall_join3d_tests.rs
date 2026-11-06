//! [141] Wandknoten im 3D, im Schnitt-Pfad und im IFC: dieselben Testprojekte wie der Grundriss
//! (`plan/wall_join_tests.rs`). Geprüft auf den Wandkörpern (`emit_walls`) und Stützen (`emit_columns`):
//! Summe der Körpervolumen = Volumen der Vereinigung (Manifold, keine Überlappung), Schnitt der Körper
//! verschiedener Bauteile leer, Vereinigung = Grundrissfläche × Höhe (keine Lücke, gleiche Form wie der
//! Grundriss); IFC-Mengen (`wall_quantities`) und -Datensätze.

use crate::ifc_quantities as qty;
use crate::model::*;
use crate::model3d::{self, RWall};
use crate::plan::wall_join_tests::{add_column, add_wall, base, filled, overlap, polar, prims, ring_area};
use crate::solid_bool::{Mesh, Solid};

const H: f64 = 2.6;

/// Körper je Bauteil (Wand-id bzw. Stützen-id): Wand-Bänder ohne Löcher, Stützen-Prismen.
fn bodies(p: &Project, layered: bool) -> Vec<(String, Mesh)> {
    let mut out: Vec<(String, Mesh)> = model3d::emit_walls(p, layered).unwrap().iter().filter_map(|w| model3d::wall_piece_mesh(w).map(|m| (w.wall_id.clone(), m))).collect();
    // Stützen-Körper aus den Abschnitten (`emit_columns` baut dieselben Prismen, Deckel ohne Ausrichtung).
    for col in p.columns.as_deref().unwrap_or(&[]) {
        for (foot, z0, z1) in model3d::column_pieces(p, col) {
            out.push((col.id.clone(), Mesh::prism(&foot.iter().map(|v| [v.x, v.y]).collect::<Vec<_>>(), z0, z1)));
        }
    }
    out
}

/// Fläche der Grundriss-Vereinigung (Schichtbänder + Stützen).
fn plan_area(p: &Project) -> f64 {
    let (_, u) = overlap(&filled(&prims(p)));
    u.iter().map(|pl| ring_area(&pl[0]) - pl[1..].iter().map(|h| ring_area(h)).sum::<f64>()).sum()
}

/// Keine Überlappung (Summe = Vereinigung, Schnitt je Bauteilpaar leer); mit `plan`: Vereinigung =
/// Grundrissfläche × Höhe. Liefert das Volumen der Vereinigung.
fn assert_tight(p: &Project, layered: bool, plan: bool, what: &str) -> f64 {
    let bs = bodies(p, layered);
    let sum: f64 = bs.iter().map(|(_, m)| m.volume().abs()).sum();
    let (u, bad) = Solid::union_all(&bs.iter().map(|(_, m)| m.clone()).collect::<Vec<_>>());
    assert_eq!(bad, 0, "{what}: Körper nicht mannigfaltig");
    let uv = u.volume();
    assert!((sum - uv).abs() < 1e-6, "{what}: Überlappung {} (Summe {sum}, Vereinigung {uv})", sum - uv);
    // Je Bauteil vereinigt, paarweise geschnitten: leer.
    let mut ids: Vec<&str> = bs.iter().map(|(id, _)| id.as_str()).collect();
    ids.sort();
    ids.dedup();
    let per: Vec<Solid> = ids.iter().map(|id| Solid::union_all(&bs.iter().filter(|(k, _)| k == id).map(|(_, m)| m.clone()).collect::<Vec<_>>()).0).collect();
    for i in 0..per.len() {
        for j in i + 1..per.len() {
            let v = per[i].intersection(&per[j]).unwrap().volume();
            assert!(v.abs() < 1e-9, "{what}: {} ∩ {} = {v}", ids[i], ids[j]);
        }
    }
    if plan {
        let want = plan_area(p) * H;
        assert!((uv - want).abs() < 1e-4, "{what}: 3D {uv} ≠ Grundriss {want}");
    }
    uv
}

/// IFC-Mengen je Wand wie im Export (`wall_quantities` über die Bänder).
fn ifc_gross_volume(p: &Project) -> f64 {
    let bands = model3d::emit_walls(p, true).unwrap();
    p.walls
        .iter()
        .map(|w| {
            let bs: Vec<&RWall> = bands.iter().filter(|b| b.wall_id == w.id).collect();
            qty::wall_quantities(w.start, w.end, &bs, &[], None).iter().find(|q| q.name == "GrossVolume").map_or(0.0, |q| q.value)
        })
        .sum()
}

fn ifc_strings(p: &Project) -> Vec<String> {
    let f = crate::ifc_data::ifc_export_data(p, &crate::ifc_data::IfcOptions::default()).unwrap();
    f.strings.clone()
}

#[test]
fn y_knoten_3d_ohne_ueberlappung_und_luecke() {
    for (t, angles) in [("aw", [0.0, 120.0, 240.0]), ("iw", [0.0, 100.0, 225.0]), ("aw", [0.0, 150.0, 260.0]), ("iw", [30.0, 160.0, 75.0])] {
        let mut p = base();
        for a in angles {
            add_wall(&mut p, t, (0.0, 0.0), polar((0.0, 0.0), 3.0, a));
        }
        let what = format!("{t} {angles:?}");
        let v = assert_tight(&p, true, true, &what);
        // IFC: Mengen aus denselben Bändern, Summe = Körper.
        let g = ifc_gross_volume(&p);
        assert!((g - v).abs() < 1e-6, "{what}: IFC GrossVolume {g} ≠ {v}");
        let s = ifc_strings(&p);
        for id in ["W1", "W2", "W3"] {
            assert!(s.iter().any(|x| x == id), "{what}: {id} im IFC");
        }
    }
}

#[test]
fn kollineare_wande_3d_ein_koerper() {
    let cases: [(&str, (f64, f64), (f64, f64), (f64, f64), (f64, f64)); 7] = [
        ("iw", (0.0, 0.0), (3.0, 0.0), (3.0, 0.0), (6.0, 0.0)),
        ("iw", (0.0, 0.0), (4.0, 0.0), (3.0, 0.0), (7.0, 0.0)),
        ("iw", (0.0, 0.0), (6.0, 0.0), (2.0, 0.0), (4.0, 0.0)),
        ("iw", (0.0, 0.0), (3.0, 0.0), (6.0, 0.0), (2.0, 0.0)),
        ("aw", (0.0, 0.0), (3.0, 0.0), (3.0, 0.0), (6.0, 0.0)),
        ("aw", (3.0, 0.0), (6.0, 0.0), (0.0, 0.0), (4.0, 0.0)),
        ("aw", (0.0, 0.0), (4.0, 1.0), (3.0, 0.75), (8.0, 2.0)),
    ];
    for (t, s1, e1, s2, e2) in cases {
        let mut p = base();
        add_wall(&mut p, t, s1, e1);
        add_wall(&mut p, t, s2, e2);
        let what = format!("{t} {s1:?}-{e1:?} / {s2:?}-{e2:?}");
        let v = assert_tight(&p, true, true, &what);
        let g = ifc_gross_volume(&p);
        assert!((g - v).abs() < 1e-6, "{what}: IFC GrossVolume {g} ≠ {v} (doppelt gezählt?)");
        // Schnitt-/Ansichts-Eingabe (ungeschichtet): ebenfalls ohne Doppelung.
        assert_tight(&p, false, true, &format!("{what} (Schnitt-Pfad)"));
    }
    // Ganz enthalten: die innere Wand hat keinen Körper und fehlt im IFC.
    let mut p = base();
    add_wall(&mut p, "iw", (0.0, 0.0), (6.0, 0.0));
    add_wall(&mut p, "iw", (2.0, 0.0), (4.0, 0.0));
    assert!(model3d::emit_walls(&p, true).unwrap().iter().all(|w| w.wall_id == "W1"));
    assert!(model3d::emit_walls(&p, false).unwrap().iter().all(|w| w.wall_id == "W1"));
    let s = ifc_strings(&p);
    assert!(s.iter().any(|x| x == "W1") && !s.iter().any(|x| x == "W2"), "verdeckte Wand nicht im IFC");
    // Stumpfe Stossfuge: an der Fuge keine Stirnfläche (Ansicht), in beiden Pfaden.
    let mut p = base();
    add_wall(&mut p, "iw", (0.0, 0.0), (3.0, 0.0));
    add_wall(&mut p, "iw", (3.0, 0.0), (6.0, 0.0));
    for layered in [true, false] {
        let ws = model3d::emit_walls(&p, layered).unwrap();
        for w in &ws {
            let at_joint = |q: [f64; 2]| (q[0] - 3.0).abs() < 1e-9;
            assert!(!at_joint(w.start) || w.joint[0], "{layered}: Anfang an der Fuge ohne Stirn");
            assert!(!at_joint(w.end) || w.joint[1], "{layered}: Ende an der Fuge ohne Stirn");
        }
    }
}

#[test]
fn wand_endet_an_stuetze_3d() {
    let rect = |w: f64, d: f64| ColumnProfile::Rect { width: w, depth: d };
    // Stütze dominiert (Beton über Backstein): die Wand endet an der Kontur.
    for (t, prof) in [("iw", rect(0.3, 0.3)), ("aw", rect(0.3, 0.4)), ("iw", rect(0.4, 0.3))] {
        let mut p = base();
        add_wall(&mut p, t, (0.0, 0.0), (3.0, 0.0));
        add_column(&mut p, "C", (3.1, 0.0), prof.clone(), Some("concrete"));
        assert_tight(&p, true, true, &format!("{t} {prof:?}"));
        assert_tight(&p, false, true, &format!("{t} {prof:?} (Schnitt-Pfad)"));
    }
    // Gleiches Bauteil (Beton/Beton): Wand endet an der Kontur.
    let mut p = base();
    add_wall(&mut p, "bw", (0.0, 0.0), (3.0, 0.0));
    add_column(&mut p, "C", (3.1, 0.0), rect(0.3, 0.3), Some("concrete"));
    assert_tight(&p, true, true, "Beton/Beton");
    assert_tight(&p, false, true, "Beton/Beton (Schnitt-Pfad)");
    // Wand dominiert: Backsteinstütze in einer Betonwand — die Stütze wird um das Wandband beschnitten.
    let mut p = base();
    add_wall(&mut p, "bw", (0.0, 0.0), (3.0, 0.0));
    add_column(&mut p, "C", (3.0, 0.0), rect(0.3, 0.3), Some("brick"));
    let v = assert_tight(&p, true, true, "Beton-Wand/Backstein-Stütze");
    // Mengen: Wand voll (3.0 × 0.2), Stütze ohne den Wandanteil (0.3² − 0.15 × 0.2).
    let want = (3.0 * 0.2 + 0.09 - 0.15 * 0.2) * H;
    assert!((v - want).abs() < 1e-6, "{v} ≠ {want}");
    // IFC: Stützen-Querschnitt = beschnittene Kontur (U-Form), Export läuft durch.
    assert!(ifc_strings(&p).iter().any(|x| x == "C"));
    let want = 0.09 - 0.15 * 0.2;
    assert!((column_ifc_area(&p) - want).abs() < 1e-6);
    let f = crate::ifc_data::ifc_export_data(&p, &crate::ifc_data::IfcOptions::default()).unwrap();
    let hit = f.nums.windows(17).any(|w| {
        w[0] == 8.0 && {
            let r: Vec<[f64; 2]> = (0..8).map(|i| [w[1 + 2 * i], w[2 + 2 * i]]).collect();
            (ring_area(&r) - want).abs() < 1e-6 && r.iter().all(|q| q[0] > 2.84 && q[0] < 3.16)
        }
    });
    assert!(hit, "IfcColumn-Querschnitt beschnitten (8 Punkte, Fläche {want})");
}

/// Schnitt längs durch Wand und Stütze: die Stütze ist geschnitten (Platte mit Herkunft), Wand und
/// Stütze überlappen nicht und lassen keine Lücke; prioritärere Wand: Stütze nur hinter dem Wandende.
#[test]
fn schnitt_wand_an_stuetze() {
    use crate::plan::section::{compute_section, Kind, LevelSpec};
    let rect = ColumnProfile::Rect { width: 0.3, depth: 0.3 };
    let cuts = |p: &Project| -> Vec<(Kind, Option<String>, Vec<Vec2>)> {
        let l = LevelSpec { kind: "section".into(), line: Some([Vec2 { x: -1.0, y: 0.0 }, Vec2 { x: 4.0, y: 0.0 }]), ..Default::default() };
        let out = compute_section(p, &l, &[]).unwrap().unwrap();
        out.cuts.iter().map(|c| (c.kind, c.source_id.clone(), c.pts.iter().map(|q| Vec2 { x: q[0], y: q[1] }).collect())).collect()
    };
    let area = crate::plan::wall_join_tests::area;
    // Stütze dominiert (Beton über Backstein-Innenwand): Wand bis zur Kontur (x = 2.95), Stütze 0.3 breit.
    let mut p = base();
    add_wall(&mut p, "iw", (0.0, 0.0), (3.0, 0.0));
    add_column(&mut p, "C", (3.1, 0.0), rect.clone(), Some("concrete"));
    let polys = cuts(&p);
    assert!(polys.iter().any(|q| q.1.as_deref() == Some("C") && q.0 == Kind::Slab), "Stütze im Schnitt");
    let all: Vec<Vec<Vec2>> = polys.iter().map(|q| q.2.clone()).collect();
    let (ov, u) = overlap(&all);
    assert!(ov.abs() < 1e-6, "Überlappung {ov}");
    assert_eq!(u.len(), 1, "Wand und Stütze ein Körper");
    let total: f64 = all.iter().map(|q| area(q)).sum();
    assert!((total - 3.25 * H).abs() < 1e-4, "Schnittfläche {total}");
    // Wand dominiert (Backsteinstütze in Betonwand, Schnitt in der Wandachse).
    let mut p = base();
    add_wall(&mut p, "bw", (0.0, 0.0), (3.0, 0.0));
    add_column(&mut p, "C", (3.0, 0.0), rect, Some("brick"));
    let polys = cuts(&p);
    let all: Vec<Vec<Vec2>> = polys.iter().map(|q| q.2.clone()).collect();
    let (ov, _) = overlap(&all);
    assert!(ov.abs() < 1e-6, "Überlappung {ov}");
    let col: f64 = polys.iter().filter(|q| q.1.as_deref() == Some("C")).map(|q| area(&q.2)).sum();
    assert!((col - 0.15 * H).abs() < 1e-4, "Stütze hinter dem Wandende: {col}");
}

/// Ansicht zweier stumpf gestossener kollinearer Wände gleichen Typs: an der Fuge keine Kante (nur die
/// beiden Wandenden); verschiedene Typen behalten die Fuge.
#[test]
fn ansicht_kollineare_stossfuge_ohne_kante() {
    use crate::plan::prim::Primitive;
    use crate::plan::section::{LevelSpec, Visibility};
    let verticals = |t2: &str| {
        let mut p = base();
        add_wall(&mut p, "iw", (0.0, 0.0), (3.0, 0.0));
        add_wall(&mut p, t2, (3.0, 0.0), (6.0, 0.0));
        let level = LevelSpec { kind: "elevation".into(), line: Some([Vec2 { x: -1.0, y: -2.0 }, Vec2 { x: 7.0, y: -2.0 }]), direction_sign: Some(1.0), ..Default::default() };
        let prims = crate::plan::elevation::elevation_primitives(&p, &level, false, true, &Visibility::default(), 50.0).unwrap().unwrap().0;
        let mut xs: Vec<f64> = prims
            .iter()
            .filter_map(|q| match q {
                Primitive::Line { a, b, .. } if (a.x - b.x).abs() < 1e-9 && (a.y - b.y).abs() > 1.0 => Some(a.x),
                _ => None,
            })
            .collect();
        xs.sort_by(f64::total_cmp);
        xs.dedup_by(|a, b| (*a - *b).abs() < 1e-6);
        xs
    };
    let same = verticals("iw");
    assert_eq!(same.len(), 2, "nur die Wandenden: {same:?}");
    assert!(verticals("bw").len() > 2, "Typwechsel: Fuge sichtbar");
}

/// Querschnittsfläche der Stütze, wie der IFC-Export sie schreibt.
fn column_ifc_area(p: &Project) -> f64 {
    let col = &p.columns.as_ref().unwrap()[0];
    model3d::column_pieces(p, col).iter().map(|q| {
        let r: Vec<[f64; 2]> = q.0.iter().map(|v| [v.x, v.y]).collect();
        ring_area(&r)
    }).sum()
}

// ── [141] Teil 4: Bogenwände an Wandknoten ──────────────────────────────────

/// Wie [`assert_tight`] mit Toleranz `tol` (m³) für Überlappung und Schnitte; Bogenwände sind im 3D
/// Sehnen-Teilwände, im Grundriss feinere Sehnenzüge — die Vereinigung wird gegen Grundriss × Höhe nur
/// grob verglichen (`plan_tol`, relativ). Liefert das Volumen der Vereinigung.
fn assert_tight_tol(p: &Project, layered: bool, tol: f64, plan_tol: Option<f64>, what: &str) -> f64 {
    let bs = bodies(p, layered);
    let sum: f64 = bs.iter().map(|(_, m)| m.volume().abs()).sum();
    let mut ids: Vec<&str> = bs.iter().map(|(id, _)| id.as_str()).collect();
    ids.sort();
    ids.dedup();
    // Je Bauteil vereinigt, dann gesamt: die Teilkörper aller Wände in Eingabereihenfolge einzeln
    // vereinigt verlor Manifold (exakt) am Y-Knick mit Bogen-Ast Volumen, obwohl jeder Schnitt leer war
    // (reihenfolgeabhängig; je Wand oder rückwärts stimmt die Summe).
    let mut per: Vec<Solid> = Vec::new();
    for id in &ids {
        let (s, bad) = Solid::union_all(&bs.iter().filter(|(k, _)| k == id).map(|(_, m)| m.clone()).collect::<Vec<_>>());
        assert_eq!(bad, 0, "{what}: Körper nicht mannigfaltig");
        per.push(s);
    }
    let u = per.iter().fold(Solid::empty(), |a, s| a.union(s).unwrap());
    let uv = u.volume();
    eprintln!("{what}: Summe {sum} Vereinigung {uv} Überlappung {:e}", sum - uv);
    assert!((sum - uv).abs() < tol, "{what}: Überlappung {} (Summe {sum}, Vereinigung {uv})", sum - uv);
    for i in 0..per.len() {
        for j in i + 1..per.len() {
            let v = per[i].intersection(&per[j]).unwrap().volume();
            assert!(v.abs() < tol, "{what}: {} ∩ {} = {v}", ids[i], ids[j]);
        }
    }
    if let Some(rel) = plan_tol {
        let want = plan_area(p) * H;
        eprintln!("{what}: Grundriss × Höhe {want} (Abweichung {:e})", (uv - want) / want);
        assert!(((uv - want) / want).abs() < rel, "{what}: 3D {uv} ≠ Grundriss {want}");
    }
    uv
}

/// Y-Knoten mit Bogenwand (Testprojekte wie im Grundriss): gerade Eckwände und Bogen-Ast exakt dicht;
/// Bogen-Eckwand mit Sehne am Ast (Überlappung ≤ Sehnenpfeil × Astbreite × Höhe).
#[test]
fn y_knoten_bogenwand_3d() {
    use crate::plan::wall_join_tests::y_bogen_projekt;
    for (t, case, tol) in [("aw", 0, 1e-6), ("iw", 1, 1e-6), ("aw", 2, 2e-3), ("iw", 3, 2e-3)] {
        let p = y_bogen_projekt(t, case);
        let what = format!("{t} Fall {case}");
        // Nur der geschichtete Pfad: der Schnitt-Pfad trägt keine Gehrungen/Knicke (vereinigt im Schnitt).
        assert_tight_tol(&p, true, tol, Some(2e-3), &what);
        let s = ifc_strings(&p);
        for id in ["W1", "W2", "W3"] {
            assert!(s.iter().any(|x| x == id), "{what}: {id} im IFC");
        }
    }
}

/// Bogenwände gleichen Kreises und Typs: ein Körper ohne Doppelung (beide Pfade), an der Stossfuge
/// keine Stirnfläche; die verdeckte fehlt in 3D und IFC.
#[test]
fn bogenwande_gleichen_kreises_3d() {
    use crate::plan::wall_join_tests::{add_arc_deg, BOGEN_KOLLINEAR};
    for (t, a, b) in BOGEN_KOLLINEAR {
        let mut p = base();
        add_arc_deg(&mut p, t, (0.0, 0.0), 4.0, a.0, a.1);
        add_arc_deg(&mut p, t, (0.0, 0.0), 4.0, b.0, b.1);
        let what = format!("{t} {a:?} / {b:?}");
        assert_tight_tol(&p, true, 1e-6, Some(2e-3), &what);
        assert_tight_tol(&p, false, 1e-6, Some(2e-3), &format!("{what} (Schnitt-Pfad)"));
    }
    // Ganz enthalten: die innere Wand hat keinen Körper und fehlt im IFC.
    let mut p = base();
    add_arc_deg(&mut p, "iw", (0.0, 0.0), 4.0, 0.0, 120.0);
    add_arc_deg(&mut p, "iw", (0.0, 0.0), 4.0, 30.0, 60.0);
    assert!(model3d::emit_walls(&p, true).unwrap().iter().all(|w| w.wall_id == "W1"));
    assert!(model3d::emit_walls(&p, false).unwrap().iter().all(|w| w.wall_id == "W1"));
    let s = ifc_strings(&p);
    assert!(s.iter().any(|x| x == "W1") && !s.iter().any(|x| x == "W2"), "verdeckte Bogenwand nicht im IFC");
    // Stumpfe Stossfuge bei 60°: Teilkörper dort ohne Stirn (beide Pfade).
    let mut p = base();
    add_arc_deg(&mut p, "iw", (0.0, 0.0), 4.0, 0.0, 60.0);
    add_arc_deg(&mut p, "iw", (0.0, 0.0), 4.0, 60.0, 120.0);
    let at_joint = |q: [f64; 2]| (q[1].atan2(q[0]).to_degrees() - 60.0).abs() < 1e-6;
    for layered in [true, false] {
        let ws = model3d::emit_walls(&p, layered).unwrap();
        assert!(ws.iter().any(|w| at_joint(w.start) || at_joint(w.end)), "{layered}: Teilkörper an der Fuge");
        for w in &ws {
            assert!(!at_joint(w.start) || w.joint[0], "{layered}: Anfang an der Fuge ohne Stirn");
            assert!(!at_joint(w.end) || w.joint[1], "{layered}: Ende an der Fuge ohne Stirn");
        }
    }
}

/// Bogenwand endet an einer Stütze: Stütze dominiert bzw. gleiches Bauteil → Wand endet an der Kontur;
/// Wand dominiert → Stütze um die Sehnen-Teilwände beschnitten. Dicht ohne Überlappung, auch im
/// Schnitt-Pfad; IFC enthält Wand und Stütze.
#[test]
fn bogenwand_endet_an_stuetze_3d() {
    use crate::plan::wall_join_tests::bogen_stuetze_projekt;
    let rect = |w: f64, d: f64| ColumnProfile::Rect { width: w, depth: d };
    for (t, prof, rev, comp) in [("iw", rect(0.3, 0.4), false, "concrete"), ("aw", rect(0.3, 0.5), false, "concrete"), ("iw", rect(0.3, 0.4), true, "concrete"), ("bw", rect(0.3, 0.4), false, "concrete"), ("bw", rect(0.3, 0.3), false, "brick")] {
        let p = bogen_stuetze_projekt(t, prof.clone(), rev, comp);
        let what = format!("{t} {prof:?} {rev} {comp}");
        assert_tight_tol(&p, true, 1e-6, Some(2e-3), &what);
        assert_tight_tol(&p, false, 1e-6, None, &format!("{what} (Schnitt-Pfad)"));
        let s = ifc_strings(&p);
        assert!(s.iter().any(|x| x == "W1") && s.iter().any(|x| x == "C"), "{what}: IFC");
    }
}


