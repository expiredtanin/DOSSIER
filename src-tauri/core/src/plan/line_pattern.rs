//! Linientypen der Planableitung ([153]): alle Strichmuster in **Papier-mm**, abwechselnd Strich/Lücke
//! (`[an, aus, …]`, ein Strich der Länge 0 ist ein Punkt mit runder Kappe, [96]). Jede Ausgabe rechnet
//! sie mit ihrem Massstab um — Bildschirm (render2d, Plot-Massstab), Plan-SVG (`svg.rs`, Modell-Meter =
//! mm · N/1000), Druck-SVG (`print_svg.rs`, mm), DXF/DWG (Linientyp in Modell-Metern, `dxf.rs`) und
//! Blätter (Viewport-Massstab) —, auf dem Papier ist ein Strich daher überall gleich lang. Vorher
//! standen einige Muster in Modell-Metern (Treppe, verdeckt, Überkopf `[0.12, 0.08]` …) und wurden
//! überall als mm gelesen (Haarpunkte), die Achsen waren mit dem Massstab vorskaliert.
//!
//! Längen (eigene Wahl, gängige Praxis im Architekturplan): verdeckt/gestrichelt 2 mm Strich, 1 mm Lücke;
//! Überkopf strichpunktiert 6 mm Strich mit Punkt; Achsen lang strichpunktiert 12 mm mit kurzem Strich;
//! punktiert = Punkte im Abstand 1 mm. Der Strichmuster-Massstab einer Zeichnung (`dashScale`) wirkt
//! multiplikativ ([`scaled`]).
//!
//! Musterphase ([`phase`]): Ein gestrichelter Zug soll an beiden Enden möglichst mit einem Strich
//! beginnen/enden; kurze Stücke dürfen nicht nur aus Lücke bestehen. Die Phase gilt für den ganzen
//! Zug (Polylinien laufen über die Ecken durch). Spiegel: `render2d::tessellate::dash_phase` und
//! `dash_phase` im Strich-Shader (`DASH_LINE_WGSL`), gleiche Rechenschritte.

/// Verdeckte Kanten, Bauteile über dem Schnitt (Treppenstufen, Dachbruch), gestrichelte Öffnungslinien.
pub const HIDDEN: [f64; 2] = [2.0, 1.0];
/// Überkopf (Decken-/Dachränder über der Schnittebene): Strich, Lücke, Punkt, Lücke.
pub const OVERHEAD: [f64; 4] = [6.0, 1.5, 0.0, 1.5];
/// Achsen (Achsraster im Grundriss, Schnitt, Ansicht): langer Strich, kurzer Strich.
pub const AXIS: [f64; 4] = [12.0, 2.5, 1.5, 2.5];
/// Punktiert (Bauteile unter der Sichtweite): Punkte im Abstand 1 mm.
pub const DOTTED: [f64; 2] = [0.0, 1.0];
/// Gewachsenes Terrain im Schnitt: länger gestrichelt.
pub const DASHED_LONG: [f64; 2] = [4.0, 2.0];
/// Konstruktionslinie/Strahl: Strich, Lücke, kurzer Strich, Lücke.
pub const CONSTRUCTION: [f64; 4] = [3.0, 1.0, 0.3, 1.0];
/// Schnittführung im Grundriss (Hauptlinie).
pub const SECTION_LINE: [f64; 4] = [6.0, 1.5, 0.4, 1.5];

/// Modell-Meter je Papier-mm bei 1:`scale_n`.
pub fn mm_to_m(scale_n: f64) -> f64 {
    scale_n / 1000.0
}

/// Muster mit dem Strichmuster-Massstab `k` (Faktor, `dashScale`) gestreckt; ohne gültigen Faktor unverändert.
pub fn scaled(mm: &[f64], k: f64) -> Vec<f64> {
    let k = if k.is_finite() && k > 0.0 { k } else { 1.0 };
    mm.iter().map(|v| v * k).collect()
}

/// Muster (Papier-mm) als Längen im Modell (Meter) bei 1:`scale_n`.
pub fn model_m(mm: &[f64], scale_n: f64) -> Vec<f64> {
    let k = mm_to_m(scale_n);
    mm.iter().map(|v| v * k).collect()
}

/// Zyklus eines Musters: negative/ungültige Werte zu 0, ungerade Länge verdoppelt (SVG-Semantik),
/// Punkte (0) bleiben. `None` = durchgezogen (leer oder ohne Länge).
pub fn cycle(dash: &[f64]) -> Option<Vec<f64>> {
    let pat: Vec<f64> = dash.iter().map(|d| if d.is_finite() { d.max(0.0) } else { 0.0 }).collect();
    let total: f64 = pat.iter().sum();
    if pat.is_empty() || total <= 1e-12 {
        return None;
    }
    Some(if pat.len() % 2 == 0 { pat } else { [pat.as_slice(), pat.as_slice()].concat() })
}

/// Sichtbares Strichstück an einem Zugende: `p` = Musterlage am Zuganfang (`at_end` falsch: Strich ab `p`
/// bis Elementende) bzw. am Zugende (`at_end` wahr: Strich vom Elementanfang bis `p`). Positiv = Länge des
/// Strichstücks (höchstens `len`), negativ = Lücke am Ende.
fn end_stub(p: f64, len: f64, total: f64, cyc: &[f64], at_end: bool) -> f64 {
    let mut m = p - (p / total).floor() * total;
    if at_end && m <= 0.0 {
        m = total;
    }
    let mut acc = 0.0;
    let mut r = 0.0;
    for (i, &d) in cyc.iter().enumerate() {
        let hit = if at_end { m > acc && m <= acc + d } else { m >= acc && m < acc + d };
        if hit {
            let v = if at_end { m - acc } else { acc + d - m };
            r = if i % 2 == 0 { v.min(len) } else { -v };
        }
        acc += d;
    }
    r
}

/// Musterphase eines gestrichelten Zugs der Länge `len` (gleiche Einheit wie `dash`): Lage im Muster am
/// Zuganfang (für SVG `stroke-dashoffset`). Kandidaten: 0 (voller Strich am Anfang) und das Muster um
/// die Zugmitte auf jedes Element zentriert (symmetrische Enden); es gewinnt der Kandidat mit dem
/// längeren kürzeren End-Strichstück, bei Gleichstand der frühere.
pub fn phase(len: f64, dash: &[f64]) -> f64 {
    let Some(cyc) = cycle(dash) else { return 0.0 };
    let total: f64 = cyc.iter().sum();
    if !(len > 0.0) || !len.is_finite() {
        return 0.0;
    }
    let score = |p: f64| end_stub(p, len, total, &cyc, false).min(end_stub(p + len, len, total, &cyc, true));
    let mut best_p = 0.0;
    let mut best = score(0.0);
    let mut acc = 0.0;
    for &d in &cyc {
        let q = acc + 0.5 * d - 0.5 * len;
        let p = q - (q / total).floor() * total;
        let s = score(p);
        if s > best + 1e-4 * total {
            best = s;
            best_p = p;
        }
        acc += d;
    }
    best_p
}

/// Muster für einen **geschlossenen** Zug der Länge `len` (gleiche Einheit wie `dash`, Kreis: Umfang): auf
/// ganze Wiederholungen gestreckt, so dass es an der Naht nahtlos schliesst (Strich läuft über den Anfang
/// weiter, keine halbe Lücke). Ungerade Muster werden verdoppelt ([`cycle`]); Wiederholungen = gerundet,
/// mindestens 1. Ohne gültiges Muster oder Länge unverändert.
pub fn fit_closed(dash: &[f64], len: f64) -> Vec<f64> {
    let Some(cyc) = cycle(dash) else { return dash.to_vec() };
    let total: f64 = cyc.iter().sum();
    if !(len > 0.0) || !len.is_finite() {
        return dash.to_vec();
    }
    let n = (len / total).round().max(1.0);
    let k = len / (n * total);
    cyc.iter().map(|v| v * k).collect()
}

/// Phase in Papier-mm für einen Zug der Modell-Länge `len_m` bei 1:`scale_n` (Muster in Papier-mm).
pub fn phase_mm(len_m: f64, dash_mm: &[f64], scale_n: f64) -> f64 {
    let k = mm_to_m(scale_n);
    if !(k > 0.0) {
        return 0.0;
    }
    phase(len_m / k, dash_mm)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Strichstücke (Anfang, Ende) eines Zugs der Länge `len` mit Phase `ph` (Referenz-Zerlegung).
    fn pieces(len: f64, dash: &[f64], ph: f64) -> Vec<(f64, f64)> {
        let cyc = cycle(dash).unwrap();
        let total: f64 = cyc.iter().sum();
        let mut out = Vec::new();
        let mut base = -ph - total;
        while base < len {
            let mut acc = base;
            for (i, d) in cyc.iter().enumerate() {
                if i % 2 == 0 {
                    let (a, b) = (acc.max(0.0), (acc + d).min(len));
                    if b > a + 1e-9 || (*d == 0.0 && acc >= 0.0 && acc <= len) {
                        out.push((a, b.max(a)));
                    }
                }
                acc += d;
            }
            base += total;
        }
        out
    }

    #[test]
    fn muster_in_papier_mm() {
        assert_eq!(HIDDEN, [2.0, 1.0]);
        assert!(OVERHEAD[0] > HIDDEN[0] && AXIS[0] > OVERHEAD[0], "Überkopf/Achsen länger als verdeckt");
        assert_eq!(OVERHEAD[2], 0.0, "Überkopf mit Punkt");
        // 2 mm Strich bei 1:50 = 0.1 m, bei 1:100 = 0.2 m, bei 1:200 = 0.4 m Modell.
        for (n, m) in [(50.0, 0.1), (100.0, 0.2), (200.0, 0.4)] {
            assert!((model_m(&HIDDEN, n)[0] - m).abs() < 1e-12);
        }
        assert_eq!(scaled(&HIDDEN, 2.0), vec![4.0, 2.0]);
        assert_eq!(scaled(&HIDDEN, f64::NAN), vec![2.0, 1.0]);
        assert_eq!(cycle(&[3.0]), Some(vec![3.0, 3.0]));
        assert_eq!(cycle(&[0.0, 0.0]), None);
        assert_eq!(cycle(&[]), None);
    }

    #[test]
    fn geschlossener_zug_hat_ganze_wiederholungen() {
        // Umfang 31.4 mm, Muster 3 mm: 10 Wiederholungen à 3.14 mm.
        let d = fit_closed(&HIDDEN, 31.4);
        assert_eq!(d.len(), 2);
        assert!((d.iter().sum::<f64>() * 10.0 - 31.4).abs() < 1e-9, "{d:?}");
        assert!((d[0] / d[1] - 2.0).abs() < 1e-9, "Verhältnis bleibt");
        // Kürzer als ein Muster: genau eine Wiederholung.
        let d = fit_closed(&HIDDEN, 1.0);
        assert!((d.iter().sum::<f64>() - 1.0).abs() < 1e-9);
        // Ungerade Länge wird verdoppelt, Punkte bleiben Punkte.
        assert_eq!(fit_closed(&[3.0], 12.0).len(), 2);
        assert_eq!(fit_closed(&DOTTED, 10.0)[0], 0.0);
        // Unsinn: unverändert.
        assert_eq!(fit_closed(&HIDDEN, f64::NAN), HIDDEN.to_vec());
        assert_eq!(fit_closed(&[], 5.0), Vec::<f64>::new());
    }

    #[test]
    fn kurzes_stueck_ist_ein_strich() {
        // kürzer als ein Strich: ganz Strich (Phase 0).
        assert_eq!(phase(1.5, &HIDDEN), 0.0);
        // knapp länger als ein Muster: beide Enden auf einem Strich, nicht in der Lücke.
        for len in [2.2, 2.5, 3.0, 3.4, 4.0, 5.5, 7.3, 10.0, 31.7] {
            let ph = phase(len, &HIDDEN);
            let p = pieces(len, &HIDDEN, ph);
            assert!(p.first().is_some_and(|q| q.0 < 1e-9 && q.1 - q.0 > 0.4), "Anfang mit Strich, L {len}: {p:?}");
            assert!(p.last().is_some_and(|q| (q.1 - len).abs() < 1e-9 && q.1 - q.0 > 0.4), "Ende mit Strich, L {len}: {p:?}");
        }
    }

    #[test]
    fn strichpunkt_endet_mit_strich() {
        for len in [7.0, 9.0, 14.0, 20.0, 47.5] {
            let ph = phase(len, &OVERHEAD);
            let p = pieces(len, &OVERHEAD, ph);
            let first = p.first().unwrap();
            let last = p.last().unwrap();
            assert!(first.0 < 1e-9 && first.1 - first.0 > 1.0, "L {len}: {p:?}");
            assert!((last.1 - len).abs() < 1e-9 && last.1 - last.0 > 1.0, "L {len}: {p:?}");
        }
    }

    /// Plan mit einer gestrichelten Linie (verdeckt) und einem dreiteiligen gestrichelten Zug (Überkopf), in
    /// Modell-Längen, die bei 1:`n` auf dem Papier immer gleich lang sind (40 mm bzw. 3 × 20 mm).
    fn plan_bytes(n: f64) -> Vec<u8> {
        use crate::model::Vec2;
        use crate::plan::buf::Writer;
        use crate::plan::prim::Primitive;
        let m = mm_to_m(n);
        let v = |x: f64, y: f64| Vec2 { x: x * m, y: y * m };
        let line = |a: Vec2, b: Vec2, dash: &[f64]| Primitive::Line { a, b, cls: "draw2d".into(), weight_mm: 0.18, dash: Some(Some(dash.to_vec())), zigzag: None, motif: None, color: Some("#000".into()), drawing_id: None, opening_id: None, stair_id: None, greyed: None, opacity: None };
        let mut w = Writer::new(false);
        let g = w.begin_group();
        w.push(&line(v(0.0, 0.0), v(40.0, 0.0), &HIDDEN));
        w.push(&line(v(0.0, 10.0), v(20.0, 10.0), &OVERHEAD));
        w.push(&line(v(20.0, 10.0), v(20.0, 30.0), &OVERHEAD));
        w.push(&line(v(20.0, 30.0), v(40.0, 30.0), &OVERHEAD));
        w.end_group(g);
        w.finish()
    }

    fn parts(bytes: &[u8]) -> Vec<crate::plan::parts::Part<'_>> {
        let view = crate::plan::buf::View::parse(bytes).unwrap();
        let len = view.len();
        vec![crate::plan::parts::Part::new(view, 0, len).unwrap()]
    }

    fn attr(el: &str, k: &str) -> Option<String> {
        el.split(&format!(" {k}=\"")).nth(1).map(|t| t.split('"').next().unwrap().to_string())
    }

    /// [153] Gleiche Strich-/Lückenlängen auf dem Papier in 1:50, 1:100, 1:200: Plan-SVG (Modell-Meter),
    /// Druck-SVG (mm) und DXF-Linientyp (Modell-Meter). Der Zug ist EIN Element mit Musterphase.
    #[test]
    fn gleiche_musterlaenge_in_allen_ausgaben_und_massstaeben() {
        use crate::plan::line_ends::LineEnds;
        use crate::plan::print_svg::{print_svg_ops, PrintOptions};
        use crate::plan::svg::{plan_svg, SvgOptions};
        let mut offsets = Vec::new();
        for n in [50.0, 100.0, 200.0] {
            let k = mm_to_m(n);
            let bytes = plan_bytes(n);
            // Plan-SVG
            let o = SvgOptions { scale_denominator: n, margin_m: 0.0, min_x: 0.0, min_y: 0.0, max_x: 40.0 * k, max_y: 30.0 * k, hatch: false, line_ends: LineEnds::default() };
            let svg = plan_svg(&mut parts(&bytes), &o).unwrap();
            let els: Vec<&str> = svg.lines().filter(|l| l.contains("stroke-dasharray")).collect();
            assert_eq!(els.len(), 2, "Linie + EIN Zug (1:{n}): {svg}");
            let mm = |el: &str| attr(el, "stroke-dasharray").unwrap().split(' ').map(|x| x.parse::<f64>().unwrap() / k).collect::<Vec<_>>();
            let close = |a: &[f64], b: &[f64]| a.len() == b.len() && a.iter().zip(b).all(|(x, y)| (x - y).abs() < 1e-3);
            assert!(close(&mm(els[0]), &HIDDEN), "1:{n} {:?}", mm(els[0]));
            assert!(els[1].starts_with("<polyline") && close(&mm(els[1]), &OVERHEAD), "1:{n} {}", els[1]);
            let off = |el: &str| attr(el, "stroke-dashoffset").map_or(0.0, |x| x.parse::<f64>().unwrap() / k);
            offsets.push((off(els[0]), off(els[1])));
            // Druck-SVG (Blatt-mm): Muster unverändert in mm.
            let po = PrintOptions { scale_denominator: n, page_w: 100.0, page_h: 100.0, bounds: [0.0, 0.0, 40.0 * k, 30.0 * k] };
            let ops = print_svg_ops(&mut parts(&bytes), &po).unwrap();
            let recs: Vec<Vec<&str>> = ops.split('\u{1e}').map(|r| r.split('\u{1f}').collect()).filter(|f: &Vec<&str>| f.contains(&"stroke-dasharray")).collect();
            assert_eq!(recs.len(), 2, "1:{n}: {ops:?}");
            let val = |f: &Vec<&str>, k: &str| f.iter().position(|x| *x == k).map(|i| f[i + 1].to_string());
            assert_eq!(val(&recs[0], "stroke-dasharray").unwrap(), "2 1");
            assert_eq!(recs[1][2], "polyline");
            assert_eq!(val(&recs[1], "stroke-dasharray").unwrap(), "6 1.5 0 1.5");
            let poff = val(&recs[1], "stroke-dashoffset").map_or(0.0, |x| x.parse::<f64>().unwrap());
            assert!((poff - offsets.last().unwrap().1).abs() < 2e-3, "Phase Druck = Plan-SVG (1:{n})");
            // DXF-Linientyp: Modell-Meter / Massstab = Papier-mm.
            let lt = crate::plan::dxf::dash_to_ltype_meters(&HIDDEN, n).unwrap();
            assert!((lt[0] / k - 2.0).abs() < 1e-9 && (lt[1] / k + 1.0).abs() < 1e-9);
        }
        assert!(offsets.windows(2).all(|w| (w[0].0 - w[1].0).abs() < 1e-3 && (w[0].1 - w[1].1).abs() < 1e-3), "Phase in mm je Massstab gleich: {offsets:?}");
        // Zug 60 mm lang: Phase setzt beide Enden auf einen Strich.
        let p = pieces(60.0, &OVERHEAD, offsets[0].1);
        assert!(p.first().unwrap().0 < 1e-9 && p.last().is_some_and(|q| (q.1 - 60.0).abs() < 1e-9), "{p:?}");
    }

    /// [153] Gestrichelter Vollkreis: Plan-SVG, Druck-SVG und Bildschirm-Szene strecken das Muster auf ganze
    /// Wiederholungen über den Umfang (Naht schliesst), in jedem Massstab.
    #[test]
    fn gestrichelter_kreis_schliesst_an_der_naht() {
        use crate::model::Vec2;
        use crate::plan::buf::Writer;
        use crate::plan::line_ends::LineEnds;
        use crate::plan::print_svg::{print_svg_ops, PrintOptions};
        use crate::plan::prim::Primitive;
        use crate::plan::svg::{plan_svg, SvgOptions};
        for n in [50.0, 100.0, 200.0] {
            let k = mm_to_m(n);
            let r_mm = 7.3; // Umfang 45.87 mm, Muster 3 mm
            let circ_mm = std::f64::consts::TAU * r_mm;
            let mut w = Writer::new(false);
            let g = w.begin_group();
            w.push(&Primitive::DrawingCircle { center: Vec2 { x: 20.0 * k, y: 20.0 * k }, r: r_mm * k, fill: "none".into(), stroke: "#000".into(), weight_mm: 0.18, dash: Some(Some(HIDDEN.to_vec())), drawing_id: None, greyed: None, opacity: None });
            w.end_group(g);
            let bytes = w.finish();
            let whole = |d: &[f64]| {
                let reps = circ_mm / d.iter().sum::<f64>();
                (reps - reps.round()).abs() < 1e-3 && reps.round() >= 1.0
            };
            let o = SvgOptions { scale_denominator: n, margin_m: 0.0, min_x: 0.0, min_y: 0.0, max_x: 40.0 * k, max_y: 40.0 * k, hatch: false, line_ends: LineEnds::default() };
            let svg = plan_svg(&mut parts(&bytes), &o).unwrap();
            let el = svg.lines().find(|l| l.starts_with("<circle")).unwrap();
            let d: Vec<f64> = attr(el, "stroke-dasharray").unwrap().split(' ').map(|x| x.parse::<f64>().unwrap() / k).collect();
            assert!(whole(&d), "Plan-SVG 1:{n}: {d:?}");
            assert!(attr(el, "stroke-dashoffset").is_none(), "Kreis ohne Phase");
            let po = PrintOptions { scale_denominator: n, page_w: 100.0, page_h: 100.0, bounds: [0.0, 0.0, 40.0 * k, 40.0 * k] };
            let ops = print_svg_ops(&mut parts(&bytes), &po).unwrap();
            let rec: Vec<&str> = ops.split('\u{1e}').map(|r| r.split('\u{1f}').collect::<Vec<_>>()).find(|f| f.contains(&"circle")).unwrap();
            let i = rec.iter().position(|x| *x == "stroke-dasharray").unwrap();
            let d: Vec<f64> = rec[i + 1].split(' ').map(|x| x.parse().unwrap()).collect();
            assert!(whole(&d), "Druck-SVG 1:{n}: {d:?}");
        }
        // Bildschirm-Szene (Bezug 1:100, Papier-mm × 0.1 = Meter).
        let r = 0.73; // 7.3 mm × 0.1
        let mut w = Writer::new(false);
        let g = w.begin_group();
        w.push(&Primitive::DrawingCircle { center: Vec2 { x: 2.0, y: 2.0 }, r, fill: "none".into(), stroke: "#000".into(), weight_mm: 0.18, dash: Some(Some(HIDDEN.to_vec())), drawing_id: None, greyed: None, opacity: None });
        w.end_group(g);
        let bytes = w.finish();
        let sc = crate::plan::scene::build_scene(&mut parts(&bytes), &[]).unwrap();
        let pl = &sc.polylines[0];
        let crate::plan::scene::SDash::List(d) = &pl.dash else { panic!("Strichliste erwartet") };
        let len: f64 = pl.pts.windows(2).map(|q| ((q[1].x - q[0].x).powi(2) + (q[1].y - q[0].y).powi(2)).sqrt()).sum::<f64>() / 0.1;
        let reps = len / d.iter().sum::<f64>();
        assert!((reps - reps.round()).abs() < 1e-6 && reps.round() >= 1.0, "Szene: {d:?} {reps}");
    }

    /// [153] Gestricheltes Rechteck aus vier Linien: EIN geschlossener Zug, Muster über den Gesamtumfang auf ganze
    /// Wiederholungen gestreckt (Naht schliesst, keine Phase) in Plan-SVG, Druck-SVG und Bildschirm-Szene.
    #[test]
    fn gestricheltes_rechteck_schliesst_an_der_naht() {
        use crate::model::Vec2;
        use crate::plan::buf::Writer;
        use crate::plan::line_ends::LineEnds;
        use crate::plan::print_svg::{print_svg_ops, PrintOptions};
        use crate::plan::prim::Primitive;
        use crate::plan::svg::{plan_svg, SvgOptions};
        let rect = |w: &mut Writer, k: f64, x: f64, y: f64| {
            let c = [(0.0, 0.0), (13.0, 0.0), (13.0, 9.0), (0.0, 9.0), (0.0, 0.0)];
            for i in 0..4 {
                let (a, b) = (c[i], c[i + 1]);
                w.push(&Primitive::Line { a: Vec2 { x: x + a.0 * k, y: y + a.1 * k }, b: Vec2 { x: x + b.0 * k, y: y + b.1 * k }, cls: "".into(), weight_mm: 0.18, dash: Some(Some(HIDDEN.to_vec())), zigzag: None, motif: None, color: Some("#000".into()), drawing_id: None, opening_id: None, stair_id: None, greyed: None, opacity: None });
            }
        };
        let perim_mm = 44.0;
        let whole = |d: &[f64]| {
            let reps = perim_mm / d.iter().sum::<f64>();
            (reps - reps.round()).abs() < 1e-2 && reps.round() >= 1.0
        };
        for n in [50.0, 100.0, 200.0] {
            let k = mm_to_m(n);
            let mut w = Writer::new(false);
            let g = w.begin_group();
            rect(&mut w, k, 5.0 * k, 5.0 * k);
            w.end_group(g);
            let bytes = w.finish();
            let o = SvgOptions { scale_denominator: n, margin_m: 0.0, min_x: 0.0, min_y: 0.0, max_x: 40.0 * k, max_y: 40.0 * k, hatch: false, line_ends: LineEnds::default() };
            let svg = plan_svg(&mut parts(&bytes), &o).unwrap();
            let els: Vec<&str> = svg.lines().filter(|l| l.contains("stroke-dasharray")).collect();
            assert_eq!(els.len(), 1, "ein Zug: {svg}");
            assert!(els[0].starts_with("<polygon"), "{}", els[0]);
            let d: Vec<f64> = attr(els[0], "stroke-dasharray").unwrap().split(' ').map(|x| x.parse::<f64>().unwrap() / k).collect();
            assert!(whole(&d), "Plan-SVG 1:{n}: {d:?}");
            assert!(attr(els[0], "stroke-dashoffset").is_none());
            let po = PrintOptions { scale_denominator: n, page_w: 100.0, page_h: 100.0, bounds: [0.0, 0.0, 40.0 * k, 40.0 * k] };
            let ops = print_svg_ops(&mut parts(&bytes), &po).unwrap();
            let rec: Vec<&str> = ops.split('\u{1e}').map(|r| r.split('\u{1f}').collect::<Vec<_>>()).find(|f| f.contains(&"polygon")).unwrap();
            let i = rec.iter().position(|x| *x == "stroke-dasharray").unwrap();
            let d: Vec<f64> = rec[i + 1].split(' ').map(|x| x.parse().unwrap()).collect();
            assert!(whole(&d), "Druck-SVG 1:{n}: {d:?}");
            assert!(!rec.contains(&"stroke-dashoffset"));
        }
        // Bildschirm-Szene (Bezug 1:100, Papier-mm × 0.1 = Meter).
        let mut w = Writer::new(false);
        let g = w.begin_group();
        rect(&mut w, 0.1, 1.0, 1.0);
        w.end_group(g);
        let bytes = w.finish();
        let sc = crate::plan::scene::build_scene(&mut parts(&bytes), &[]).unwrap();
        let pl = sc.outlines.iter().find(|o| matches!(o.dash, crate::plan::scene::SDash::List(_))).expect("geschlossener Zug");
        let crate::plan::scene::SDash::List(d) = &pl.dash else { unreachable!() };
        assert!(whole(d), "Szene: {d:?}");
    }

    /// [153] DXF/DWG: gestricheltes Rechteck = EINE geschlossene LWPOLYLINE mit „Muster durchlaufend" (plinegen),
    /// Linientyp auf ganze Wiederholungen über den Umfang gestreckt.
    #[test]
    fn gestricheltes_rechteck_dxf_plinegen() {
        use crate::model::{Project, Vec2};
        use crate::plan::buf::Writer;
        use crate::plan::dxf::{collect, DxfOptions};
        use crate::plan::prim::Primitive;
        let mut w = Writer::new(false);
        let g = w.begin_group();
        let c = [(0.0, 0.0), (6.5, 0.0), (6.5, 4.5), (0.0, 4.5), (0.0, 0.0)];
        for i in 0..4 {
            let (a, b) = (c[i], c[i + 1]);
            w.push(&Primitive::Line { a: Vec2 { x: a.0, y: a.1 }, b: Vec2 { x: b.0, y: b.1 }, cls: "".into(), weight_mm: 0.18, dash: Some(Some(HIDDEN.to_vec())), zigzag: None, motif: None, color: Some("#000".into()), drawing_id: None, opening_id: None, stair_id: None, greyed: None, opacity: None });
        }
        w.end_group(g);
        let bytes = w.finish();
        let o = DxfOptions { scale: 100.0, include_hatches: false, dim_cm: false, paper_layout: false, bounds: [0.0, 0.0, 10.0, 10.0], default_font: "Arial".into(), floor: String::new(), table_labels: String::new() };
        let f = collect(&mut parts(&bytes), &Project::default(), &o).unwrap();
        let i = f.nums.windows(4).position(|v| v[0] == 3.0 && v[2] == 3.0 && v[3] == 4.0).expect("geschlossene LWPOLYLINE mit Flag plinegen");
        assert_eq!(f.model[1], 1, "genau eine LWPOLYLINE: {i}");
        assert_eq!(f.model[0], 0, "keine Einzel-Linien");
    }

    /// Gleiche Werte wie `render2d::tessellate::tests::musterphase_enden_auf_strich` (Shader-Spiegel).
    #[test]
    fn phase_wie_render2d() {
        assert_eq!(phase(1.5, &HIDDEN), 0.0);
        assert!((phase(10.0, &HIDDEN) - 0.5).abs() < 1e-9);
        assert!((phase(4.0, &HIDDEN) - 0.5).abs() < 1e-9);
        assert!((phase(3.0, &HIDDEN) - 1.0).abs() < 1e-9);
        assert!((phase(7.0, &OVERHEAD) - 4.0).abs() < 1e-9);
    }

    #[test]
    fn phase_unabhaengig_vom_massstab_auf_dem_papier() {
        // gleiche Papierlänge (40 mm) in 1:50/1:100/1:200 → gleiche Phase in mm.
        let a = phase_mm(2.0, &HIDDEN, 50.0);
        let b = phase_mm(4.0, &HIDDEN, 100.0);
        let c = phase_mm(8.0, &HIDDEN, 200.0);
        assert!((a - b).abs() < 1e-9 && (b - c).abs() < 1e-9);
        assert_eq!(phase(f64::NAN, &HIDDEN), 0.0);
        assert_eq!(phase(3.0, &[]), 0.0);
    }
}
