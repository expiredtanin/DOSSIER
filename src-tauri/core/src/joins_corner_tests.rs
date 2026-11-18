//! [286] Schichtweise L-Ecke sanierter Wände (`layered_corner`): die dominante Schicht läuft durch, Abbruch/Neu enden
//! rechtwinklig; die Schichten beider Wände füllen die Ecke lückenlos und ohne Überlappung.

use super::*;

fn layer(t: f64, c: u32, p: f64) -> JoinLayer {
    JoinLayer { thickness: t, component: Some(c), priority: p }
}
fn wall(s: (f64, f64), e: (f64, f64), layers: Vec<JoinLayer>, renewed: bool) -> JoinWall {
    JoinWall { start: Vec2::new(s.0, s.1), end: Vec2::new(e.0, e.1), reference: Reference::Center, layers: Some(layers), bulge: None, core: None, renewed }
}
/// Bestand saniert (aussen → innen): Putz 2, Dämmung 10, Beton 20.
fn alt() -> Vec<JoinLayer> {
    vec![layer(0.02, 0, 10.0), layer(0.10, 1, 20.0), layer(0.20, 2, 100.0)]
}
/// Nachbar (aussen → innen): Putz 2, Dämmung 16, Backstein 15, Innenputz 1.5.
fn aw() -> Vec<JoinLayer> {
    vec![layer(0.02, 0, 10.0), layer(0.16, 1, 20.0), layer(0.15, 3, 50.0), layer(0.015, 4, 10.0)]
}

/// Liegt `p` auf der Wandseite der Schnittlinie `l` (gemessen am Punkt `m` mitten in der Wand)?
fn same_side(l: &Line, p: Vec2, m: Vec2) -> bool {
    let s = |q: Vec2| kernel2d::cross(l.dir, sub(q, l.point));
    s(p) * s(m) > 0.0
}

/// Schicht `li` (oder mit `None` die ganze Wand) der Wand `w` mit den Schnitten `c` deckt `p`?
fn covers(w: &JoinWall, c: &WallCuts, li: Option<usize>, p: Vec2) -> bool {
    let l = w.layers.as_deref().unwrap();
    let t: f64 = l.iter().map(|x| x.thickness).sum();
    let lo0 = reference_offset(w.reference, t) - t / 2.0;
    let (lo, hi) = match li {
        Some(i) => {
            let lo = lo0 + l[..i].iter().map(|x| x.thickness).sum::<f64>();
            (lo, lo + l[i].thickness)
        }
        None => (lo0, lo0 + t),
    };
    let (u, n) = (dir_of(w), left_normal(dir_of(w)));
    let o = dot(sub(p, w.start), n);
    let a = dot(sub(p, w.start), u);
    let total = len(sub(w.end, w.start));
    if o <= lo || o >= hi || a <= -1.0 || a >= total + 1.0 {
        return false;
    }
    let m = add(add(w.start, scale(u, total / 2.0)), scale(n, o));
    let pick = |v: Option<&Vec<Option<Line>>>, whole: Option<Line>| match (li, v) {
        (Some(i), Some(v)) => v[i].or(whole),
        _ => whole,
    };
    let lc = c.layer_cuts.as_ref();
    let sc = pick(lc.map(|x| &x.start), c.start_cut);
    let ec = pick(lc.map(|x| &x.end), c.end_cut);
    sc.is_none_or(|l| same_side(&l, p, m)) && ec.is_none_or(|l| same_side(&l, p, m)) && (sc.is_some() || a > 0.0) && (ec.is_some() || a < total)
}

/// Jeder Punkt der Ecke (Vereinigung beider Wände) liegt in genau einer Schicht.
fn assert_partition(w: &[JoinWall], c: &[WallCuts], at: Vec2) {
    let mut checked = 0;
    for ix in -50..=50 {
        for iy in -50..=50 {
            let p = Vec2::new(at.x + 0.000731 + ix as f64 * 0.01237, at.y + 0.000419 + iy as f64 * 0.01237);
            let union = (0..w.len()).any(|k| covers(&w[k], &c[k], None, p));
            let n: usize = (0..w.len()).map(|k| (0..w[k].layers.as_ref().unwrap().len()).filter(|&i| covers(&w[k], &c[k], Some(i), p)).count()).sum();
            assert_eq!(n, usize::from(union), "Punkt {p:?}: {n} Schichten, Vereinigung {union}");
            checked += usize::from(union);
        }
    }
    assert!(checked > 100);
}

#[test]
fn saniert_abbruch_endet_rechtwinklig_am_kern() {
    let w = vec![wall((0.0, 0.0), (5.0, 0.0), alt(), true), wall((5.0, 0.0), (5.0, 4.0), aw(), false)];
    let c = compute_joins(&w).unwrap();
    // Die Wand-Gehrung bleibt (Umriss); je Schicht rechtwinklig.
    assert_eq!(c[0].end_cut, c[1].start_cut);
    let lc = c[0].layer_cuts.as_ref().expect("Schicht-Schnitte am Ende");
    // Alle Schichten der sanierten Wand (Putz und Dämmung = Abbruch, Beton bleibt) enden senkrecht zu ihr, bündig an der
    // äusseren Kernfläche des Nachbarn (Backstein aussen x = 5 + 0.1725 − 0.18): Beton läuft durch (100 > 50).
    for (i, l) in lc.end.iter().enumerate() {
        let l = l.unwrap();
        assert!(l.dir.x.abs() < 1e-9 && (l.point.x - 4.9925).abs() < 1e-9, "Schicht {i}: {l:?}");
        assert_eq!(lc.end_side[i], Some(l), "rechtwinkliges Ende mit Stirnlinie");
    }
    // Ohne Schicht-Schnitt am freien Anfang: der Endschnitt der Wand (keiner).
    assert!(lc.start.iter().all(|l| l.is_none()));
    // Nachbar: Putz und Dämmung (bleibend) laufen bis zur Aussenfläche der sanierten Wand (y = −0.16), Backstein und
    // Innenputz enden an der inneren Kernfläche (y = 0.16).
    let nb = c[1].layer_cuts.as_ref().unwrap();
    let ys: Vec<f64> = nb.start.iter().map(|l| l.unwrap().point.y).collect();
    assert!(nb.start.iter().all(|l| l.unwrap().dir.y.abs() < 1e-9), "{nb:?}");
    assert!((ys[0] + 0.16).abs() < 1e-9 && (ys[1] + 0.16).abs() < 1e-9 && (ys[2] - 0.16).abs() < 1e-9 && (ys[3] - 0.16).abs() < 1e-9, "{ys:?}");
    // Am anderen Ende folgt jede Schicht dem Endschnitt der Wand (hier keiner).
    assert!(nb.end.iter().all(|l| *l == c[1].end_cut));
    assert_partition(&w, &c, Vec2::new(5.0, 0.0));
}

#[test]
fn ohne_sanierung_bleibt_die_gehrung() {
    let w = vec![wall((0.0, 0.0), (5.0, 0.0), alt(), false), wall((5.0, 0.0), (5.0, 4.0), aw(), false)];
    let c = compute_joins(&w).unwrap();
    assert!(c[0].layer_cuts.is_none() && c[1].layer_cuts.is_none());
    let m = c[0].end_cut.unwrap();
    assert!(m.dir.x.abs() > 1e-6 && m.dir.y.abs() > 1e-6, "schräg: {m:?}");
}

#[test]
fn ecke_lueckenlos_in_allen_lagen() {
    // Laufrichtungen (Schichtfolge links/rechts), Winkel 90°/60°/120°, wer saniert ist, gewählter Kern.
    let ends = [(5.0, 4.0), (7.0, 3.4641), (3.0, 3.4641)];
    for (k, e) in ends.iter().enumerate() {
        for (ra, rb) in [(true, false), (false, true), (true, true)] {
            for flip in [false, true] {
                let a = wall((0.0, 0.0), (5.0, 0.0), alt(), ra);
                let b = if flip { wall(*e, (5.0, 0.0), aw(), rb) } else { wall((5.0, 0.0), *e, aw(), rb) };
                for core in [None, Some(1)] {
                    let w = vec![JoinWall { core, ..a.clone() }, b.clone()];
                    let c = compute_joins(&w).unwrap();
                    assert!(c[0].layer_cuts.is_some(), "Fall {k} {ra} {rb} {flip}");
                    assert_partition(&w, &c, Vec2::new(5.0, 0.0));
                }
            }
        }
    }
}

#[test]
fn bogen_und_unsinn_bleiben_bei_der_gehrung() {
    let mut b = wall((5.0, 0.0), (5.0, 4.0), aw(), false);
    b.bulge = Some(0.3);
    let c = compute_joins(&[wall((0.0, 0.0), (5.0, 0.0), alt(), true), b]).unwrap();
    assert!(c[0].layer_cuts.is_none());
    // Kern ausserhalb, leere Schichtliste, kollinear: kein Panic.
    let w = vec![JoinWall { core: Some(99), ..wall((0.0, 0.0), (5.0, 0.0), alt(), true) }, wall((5.0, 0.0), (5.0, 4.0), vec![], false)];
    let _ = compute_joins(&w);
    let _ = compute_joins(&[wall((0.0, 0.0), (5.0, 0.0), alt(), true), wall((5.0, 0.0), (9.0, 0.0), aw(), false)]);
}
