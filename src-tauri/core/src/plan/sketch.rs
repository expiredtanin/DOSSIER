//! Skizzenstil ([67]): Nachbearbeitung der Plan-Striche zu einer sorgfältigen Handskizze — Striche
//! leicht gebogen und gewellt, an Enden und Ecken überzogen, kräftige Umrisse zweimal gezogen.
//! Wirkt beim Schreiben des Plan-Puffers (`plan::buf::Writer`, über `extras::Post::sketch`), also
//! gleich für Bildschirm (render2d) und Exporte (SVG/PDF), die denselben Puffer lesen.
//!
//! Alle Masse in Papier-mm (`k` = Meter Modell je Papier-mm, also Massstab/1000): die Skizze sieht
//! in jedem Massstab gleich aus. Deterministisch: der Zufall hängt nur an Kennung, Strich-Index und
//! Lage des Strichs — kein Flackern beim Neuzeichnen, Goldens bleiben stabil. Flächen, Schraffuren,
//! Bögen und Text bleiben, wie sie sind.

use crate::jsnum;
use crate::model::Vec2;

/// Länge eines Teilstücks (Papier-mm), in das lange Kanten für die Wellung zerlegt werden.
const SEG_MM: f64 = 2.5;
/// Höchstens so viele Teilstücke je Kante.
const MAX_SEG: usize = 40;
/// Kürzere Striche (Papier-mm) bleiben exakt.
const MIN_MM: f64 = 0.6;
/// Überzug an Strich-Enden: Grundwert + Zufallsanteil (Papier-mm), höchstens `OVER_FRAC` der Länge.
const OVER_MM: f64 = 0.45;
const OVER_RAND_MM: f64 = 1.0;
const OVER_FRAC: f64 = 0.3;
/// Bogen über die ganze Strichlänge (Papier-mm), voll ab `BOW_FULL_MM` Länge.
const BOW_MM: f64 = 0.2;
const BOW_FULL_MM: f64 = 40.0;
/// Feine Wellung (Papier-mm) und ihre Wellenlänge.
const WAVE_MM: f64 = 0.05;
const WAVE_LEN_MM: f64 = 14.0;
/// Versatz der Strich-Enden quer zum Strich (Papier-mm).
const END_MM: f64 = 0.08;
/// Ab diesem Knick (Grad) beginnt am Umriss ein neuer Strich (mit Überzug an der Ecke).
const CORNER_DEG: f64 = 28.0;
/// Zweiter Zug: ab dieser Strichstärke (Papier-mm) und Länge, mit diesem Stärke-Anteil.
pub const DOUBLE_MIN_WEIGHT_MM: f64 = 0.35;
const DOUBLE_MIN_MM: f64 = 5.0;
pub const DOUBLE_WEIGHT: f64 = 0.55;

/// Deterministischer Zufall (splitmix64).
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> f64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^= z >> 31;
        (z >> 11) as f64 / (1u64 << 53) as f64
    }

    /// Gleichverteilt in [−1, 1].
    fn sym(&mut self) -> f64 {
        self.next() * 2.0 - 1.0
    }
}

/// Startwert aus Kennung (Element-Id oder Linienklasse), Strich-Index und Anfang/Ende des Strichs
/// (auf 1 mm Modell gerundet).
pub fn seed(tag: &str, index: u64, a: Vec2, b: Vec2) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    let mut mix = |v: u64| {
        for byte in v.to_le_bytes() {
            h = (h ^ byte as u64).wrapping_mul(0x0000_0100_0000_01b3);
        }
    };
    for byte in tag.bytes() {
        mix(byte as u64);
    }
    mix(index);
    for v in [a.x, a.y, b.x, b.y] {
        mix((v * 1000.0).round() as i64 as u64);
    }
    h
}

fn sub(a: Vec2, b: Vec2) -> Vec2 {
    Vec2 { x: a.x - b.x, y: a.y - b.y }
}

fn len(v: Vec2) -> f64 {
    (v.x * v.x + v.y * v.y).sqrt()
}

/// Einheitsrichtung (oder `None` bei Länge 0).
fn unit(v: Vec2) -> Option<Vec2> {
    let l = len(v);
    (l > 1e-12 && l.is_finite()).then(|| Vec2 { x: v.x / l, y: v.y / l })
}

/// Anteil des Überzugs für eine Strichstärke: feine Linien (Schraffur-, Musterlinien ≤ 0.1 mm) ohne,
/// voll ab 0.25 mm — sonst stehen an jedem Rand eines Musters Härchen über.
pub fn overshoot_for(weight_mm: f64) -> f64 {
    ((weight_mm - 0.1) / 0.15).clamp(0.0, 1.0)
}

/// Ein Strich (Linienzug, mind. 2 Punkte) als Skizzen-Linienzug. `k` = Meter je Papier-mm,
/// `over` = Anteil des Überzugs an den Enden (0…1, s. [`overshoot_for`]).
/// Zu kurze oder unbrauchbare Striche kommen unverändert zurück.
pub fn stroke(pts: &[Vec2], k: f64, seed: u64, over: f64) -> Vec<Vec2> {
    if pts.len() < 2 || !(k > 0.0) || !k.is_finite() || pts.iter().any(|p| !p.x.is_finite() || !p.y.is_finite()) {
        return pts.to_vec();
    }
    // Kanten ohne Länge entfallen.
    let mut q: Vec<Vec2> = Vec::with_capacity(pts.len());
    for &p in pts {
        if q.last().is_none_or(|l: &Vec2| len(sub(p, *l)) > 1e-9) {
            q.push(p);
        }
    }
    if q.len() < 2 {
        return pts.to_vec();
    }
    let total: f64 = q.windows(2).map(|w| len(sub(w[1], w[0]))).sum();
    let total_mm = total / k;
    if total_mm < MIN_MM {
        return pts.to_vec();
    }
    let mut r = Rng(seed);
    let over_max = OVER_FRAC * total_mm;
    let over = if over.is_finite() { over.clamp(0.0, 1.0) } else { 0.0 };
    let ov0 = (OVER_MM + OVER_RAND_MM * r.next()).min(over_max) * over;
    let ov1 = (OVER_MM + OVER_RAND_MM * r.next()).min(over_max) * over;
    let bow = BOW_MM * r.sym() * (total_mm / BOW_FULL_MM).min(1.0);
    let wave = WAVE_MM * (0.5 + 0.5 * r.next());
    let wave_len = WAVE_LEN_MM * (0.7 + 0.6 * r.next());
    let phase = r.next() * core::f64::consts::TAU;
    let e0 = END_MM * r.sym();
    let e1 = END_MM * r.sym();
    // Querversatz (Papier-mm) an der Bogenlänge `s` (Papier-mm).
    let offset = |s: f64| {
        let t = s / total_mm;
        e0 * (1.0 - t) + e1 * t + bow * jsnum::sin(core::f64::consts::PI * t) + wave * jsnum::sin(core::f64::consts::TAU * s / wave_len + phase) * jsnum::sin(core::f64::consts::PI * t)
    };
    let dirs: Vec<Vec2> = q.windows(2).map(|w| unit(sub(w[1], w[0])).unwrap_or(Vec2 { x: 1.0, y: 0.0 })).collect();
    let normal = |d: Vec2| Vec2 { x: -d.y, y: d.x };
    let shifted = |p: Vec2, n: Vec2, mm: f64| Vec2 { x: p.x + n.x * mm * k, y: p.y + n.y * mm * k };
    let mut out = Vec::with_capacity(q.len() + 8);
    // Überzug am Anfang: rückwärts entlang der ersten Kante.
    let d0 = dirs[0];
    let n0 = normal(d0);
    out.push(shifted(Vec2 { x: q[0].x - d0.x * ov0 * k, y: q[0].y - d0.y * ov0 * k }, n0, offset(0.0)));
    let mut s = 0.0;
    for (i, w) in q.windows(2).enumerate() {
        let d = dirs[i];
        let n = normal(d);
        // Normale an der Anfangsecke: Mittel der Nachbarkanten (glatte Übergänge an flachen Knicken).
        let n_start = if i == 0 { n } else { unit(Vec2 { x: n.x + normal(dirs[i - 1]).x, y: n.y + normal(dirs[i - 1]).y }).unwrap_or(n) };
        let l_mm = len(sub(w[1], w[0])) / k;
        if i > 0 {
            out.push(shifted(w[0], n_start, offset(s)));
        }
        let m = ((l_mm / SEG_MM).ceil() as usize).clamp(1, MAX_SEG);
        for j in 1..m {
            let f = j as f64 / m as f64;
            let p = Vec2 { x: w[0].x + (w[1].x - w[0].x) * f, y: w[0].y + (w[1].y - w[0].y) * f };
            out.push(shifted(p, n, offset(s + l_mm * f)));
        }
        s += l_mm;
    }
    let dn = dirs[dirs.len() - 1];
    let nn = normal(dn);
    let last = q[q.len() - 1];
    out.push(shifted(Vec2 { x: last.x + dn.x * ov1 * k, y: last.y + dn.y * ov1 * k }, nn, offset(total_mm)));
    out
}

/// Ob ein Strich der Stärke `weight_mm` und der Länge `pts` zweimal gezogen wird.
pub fn doubled(pts: &[Vec2], k: f64, weight_mm: f64) -> bool {
    weight_mm >= DOUBLE_MIN_WEIGHT_MM && pts.windows(2).map(|w| len(sub(w[1], w[0]))).sum::<f64>() / k >= DOUBLE_MIN_MM
}

/// Umriss eines Polygons (geschlossen) als Striche: neuer Strich an jeder Ecke über [`CORNER_DEG`]
/// und an Kanten ohne Strich (`no_stroke`: Kanten-Indizes, Kante i = Punkt i → i+1). Ein Umriss ohne
/// Ecke (Kreis) wird ein Strich, der am Anfang wieder ankommt.
pub fn polygon_runs(pts: &[Vec2], no_stroke: Option<&[f64]>) -> Vec<Vec<Vec2>> {
    let n = pts.len();
    if n < 2 {
        return Vec::new();
    }
    let skip = |i: usize| no_stroke.is_some_and(|l| l.iter().any(|&e| e == i as f64));
    // Kanten (ohne Länge 0): Anfang, Ende, gezogen?
    let edges: Vec<(Vec2, Vec2, bool)> = (0..n).map(|i| (pts[i], pts[(i + 1) % n], !skip(i))).filter(|(a, b, _)| len(sub(*b, *a)) > 1e-9).collect();
    let m = edges.len();
    if m == 0 {
        return Vec::new();
    }
    let cos_max = jsnum::cos(CORNER_DEG.to_radians());
    // Bruch vor Kante i: Vorgänger nicht gezogen oder Knick.
    let brk = |i: usize| {
        let (pa, pb, ps) = edges[(i + m - 1) % m];
        let (a, b, _) = edges[i];
        if !ps || len(sub(a, pb)) > 1e-9 {
            return true;
        }
        match (unit(sub(pb, pa)), unit(sub(b, a))) {
            (Some(u), Some(v)) => u.x * v.x + u.y * v.y < cos_max,
            _ => true,
        }
    };
    let breaks: Vec<bool> = (0..m).map(brk).collect();
    let mut runs = Vec::new();
    let Some(start) = (0..m).find(|&i| breaks[i] && edges[i].2) else {
        // Kein Bruch: ein geschlossener Strich (alle Kanten gezogen) oder nichts.
        if edges.iter().all(|e| e.2) {
            let mut run: Vec<Vec2> = edges.iter().map(|e| e.0).collect();
            run.push(edges[0].0);
            runs.push(run);
        }
        return runs;
    };
    let mut cur: Vec<Vec2> = Vec::new();
    for o in 0..m {
        let i = (start + o) % m;
        let (a, b, on) = edges[i];
        if breaks[i] && cur.len() >= 2 {
            runs.push(std::mem::take(&mut cur));
        }
        if !on {
            cur.clear();
            continue;
        }
        if cur.is_empty() {
            cur.push(a);
        }
        cur.push(b);
    }
    if cur.len() >= 2 {
        runs.push(cur);
    }
    runs
}

/// Gestrichelte Linie: nur die Enden leicht versetzt (eine Wellung würde das Muster zerreissen).
pub fn jitter_ends(a: Vec2, b: Vec2, k: f64, seed: u64) -> (Vec2, Vec2) {
    let Some(d) = unit(sub(b, a)) else { return (a, b) };
    if !(k > 0.0) || len(sub(b, a)) / k < MIN_MM {
        return (a, b);
    }
    let mut r = Rng(seed);
    let n = Vec2 { x: -d.y, y: d.x };
    let (o0, o1) = (END_MM * 1.5 * r.sym() * k, END_MM * 1.5 * r.sym() * k);
    (Vec2 { x: a.x + n.x * o0, y: a.y + n.y * o0 }, Vec2 { x: b.x + n.x * o1, y: b.y + n.y * o1 })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(x: f64, y: f64) -> Vec2 {
        Vec2 { x, y }
    }

    /// Abstand von `p` zur Strecke a–b.
    fn dist_seg(p: Vec2, a: Vec2, b: Vec2) -> f64 {
        let d = sub(b, a);
        let t = (((p.x - a.x) * d.x + (p.y - a.y) * d.y) / (d.x * d.x + d.y * d.y)).clamp(0.0, 1.0);
        len(sub(p, v(a.x + d.x * t, a.y + d.y * t)))
    }

    #[test]
    fn deterministisch() {
        let pts = [v(0.0, 0.0), v(5.0, 0.0)];
        let s = seed("w1", 0, pts[0], pts[1]);
        assert_eq!(stroke(&pts, 0.1, s, 1.0), stroke(&pts, 0.1, s, 1.0));
        // Anderer Startwert: andere Wellung.
        assert_ne!(stroke(&pts, 0.1, s, 1.0), stroke(&pts, 0.1, seed("w2", 0, pts[0], pts[1]), 1.0));
    }

    #[test]
    fn enden_und_abweichung_in_toleranz() {
        // 1:100 (k = 0.1 m je Papier-mm), 5 m lange Wand.
        let k = 0.1;
        let (a, b) = (v(0.0, 0.0), v(5.0, 0.0));
        for i in 0..50 {
            let s = stroke(&[a, b], k, seed("x", i, a, b), 1.0);
            assert!(s.len() > 10, "lange Kante wird unterteilt");
            let tol_end = (OVER_MM + OVER_RAND_MM + END_MM) * k + 1e-9;
            assert!(len(sub(s[0], a)) <= tol_end && len(sub(*s.last().unwrap(), b)) <= tol_end);
            // Überzug: Enden liegen ausserhalb der Strecke (in Strichrichtung).
            assert!(s[0].x < a.x && s.last().unwrap().x > b.x);
            let dev = (BOW_MM + WAVE_MM + END_MM) * k + 1e-9;
            assert!(s.iter().all(|p| p.y.abs() <= dev), "Querabweichung ≤ {dev}");
        }
    }

    #[test]
    fn feine_linien_ohne_ueberzug() {
        let (a, b) = (v(0.0, 0.0), v(5.0, 0.0));
        assert_eq!(overshoot_for(0.1), 0.0);
        assert_eq!(overshoot_for(0.5), 1.0);
        let s = stroke(&[a, b], 0.1, 9, overshoot_for(0.1));
        assert!((s[0].x - a.x).abs() < 1e-12 && (s[s.len() - 1].x - b.x).abs() < 1e-12);
        assert!(len(sub(s[0], a)) <= END_MM * 0.1 + 1e-12);
    }

    #[test]
    fn massstab_skaliert_die_abweichung() {
        let (a, b) = (v(0.0, 0.0), v(20.0, 0.0));
        let dev = |k: f64| stroke(&[a, b], k, 7, 1.0).iter().map(|p| p.y.abs()).fold(0.0, f64::max);
        let (d100, d200) = (dev(0.1), dev(0.2));
        assert!(d100 > 0.0 && (d200 / d100 - 2.0).abs() < 0.6, "{d100} {d200}");
    }

    #[test]
    fn kurze_striche_bleiben() {
        let pts = [v(0.0, 0.0), v(0.03, 0.0)];
        assert_eq!(stroke(&pts, 0.1, 1, 1.0), pts.to_vec());
        assert_eq!(stroke(&[v(f64::NAN, 0.0), v(1.0, 0.0)], 0.1, 1, 1.0).len(), 2);
        assert_eq!(stroke(&pts, f64::NAN, 1, 1.0), pts.to_vec());
    }

    #[test]
    fn rechteck_vier_striche_kreis_einer() {
        let r = [v(0.0, 0.0), v(4.0, 0.0), v(4.0, 3.0), v(0.0, 3.0)];
        let runs = polygon_runs(&r, None);
        assert_eq!(runs.len(), 4);
        assert!(runs.iter().all(|r| r.len() == 2));
        // Kante 1 ohne Strich: drei Striche.
        assert_eq!(polygon_runs(&r, Some(&[1.0])).len(), 3);
        assert!(polygon_runs(&r, Some(&[0.0, 1.0, 2.0, 3.0])).is_empty());
        let c: Vec<Vec2> = (0..32).map(|i| {
            let t = i as f64 / 32.0 * core::f64::consts::TAU;
            v(jsnum::cos(t) * 0.15, jsnum::sin(t) * 0.15)
        }).collect();
        let runs = polygon_runs(&c, None);
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].len(), 33);
        // Der skizzierte Kreis bleibt ein Kreis (Punkte nahe am Umriss), nicht ein Vieleck aus langen Sehnen.
        let s = stroke(&runs[0], 0.1, 3, 1.0);
        assert!(s.len() >= 33);
        let mid = &s[1..s.len() - 1];
        assert!(mid.iter().all(|p| (len(*p) - 0.15).abs() < 0.04), "{mid:?}");
    }

    #[test]
    fn strich_folgt_dem_linienzug() {
        let pts = [v(0.0, 0.0), v(3.0, 0.0), v(6.0, 0.3)];
        let s = stroke(&pts, 0.05, 11, 1.0);
        let tol = (BOW_MM + WAVE_MM + END_MM + OVER_MM + OVER_RAND_MM) * 0.05;
        assert!(s.iter().all(|p| dist_seg(*p, pts[0], pts[1]).min(dist_seg(*p, pts[1], pts[2])) <= tol));
    }

    fn sample() -> crate::model::Project {
        serde_json::from_str(include_str!("../../tests/fixtures/sample_project.json")).unwrap()
    }

    fn plan(p: &crate::model::Project, floor: &str) -> Vec<u8> {
        let t = serde_json::json!({ "floor": floor, "show": ["20", "30", "60"], "grey": [], "scale": 100 }).to_string();
        crate::plan::domains::plan_domains_buf(p, &crate::plan::domains::PlanArgs::parse(1.0, &t).unwrap()).unwrap()
    }

    fn lines(buf: &[u8]) -> Vec<(Vec2, Vec2)> {
        let (prims, _, _) = crate::plan::buf::decode(buf).unwrap();
        prims.iter().filter_map(|q| match q {
            crate::plan::prim::Primitive::Line { a, b, .. } => Some((*a, *b)),
            _ => None,
        }).collect()
    }

    #[test]
    fn plan_aus_unveraendert_an_deterministisch() {
        let mut p = sample();
        let off = plan(&p, "eg");
        p.drawing_levels.iter_mut().find(|l| l.id == "eg").unwrap().sketch = Some(false);
        assert_eq!(plan(&p, "eg"), off, "sketch: false = wie ohne");
        p.drawing_levels.iter_mut().find(|l| l.id == "eg").unwrap().sketch = Some(true);
        let on = plan(&p, "eg");
        assert_ne!(on, off);
        assert_eq!(plan(&p, "eg"), on, "deterministisch");
        // Umrisse werden Striche: deutlich mehr Linien, Flächen ohne Umriss.
        assert!(lines(&on).len() > 2 * lines(&off).len().max(1), "{} vs {}", lines(&on).len(), lines(&off).len());
        let (prims, _, _) = crate::plan::buf::decode(&on).unwrap();
        assert!(prims.iter().all(|q| !matches!(q, crate::plan::prim::Primitive::Polygon { stroke, stroke_width_mm, .. } if stroke != "none" && *stroke_width_mm > 0.0)));
    }

    #[test]
    fn schnitt_und_ansicht_lesen_sketch() {
        let l = crate::plan::section::LevelSpec::from_json(&serde_json::json!({ "kind": "section", "sketch": true }));
        assert!(l.sketch);
        assert!(crate::plan::extras::sketch_post(Some(true), 50.0).is_some_and(|q| (q.sketch - 0.05).abs() < 1e-12));
        assert!(crate::plan::extras::sketch_post(None, 50.0).is_none());
    }

    #[test]
    fn writer_linie_verkettet_mit_ueberzug() {
        use crate::plan::buf::{LineRef, Writer};
        let l = LineRef { a: v(0.0, 0.0), b: v(4.0, 0.0), cls: "x", weight_mm: 0.25, dash: None, zigzag: None, motif: None, color: None, drawing_id: None, opening_id: None, stair_id: None, greyed: None, opacity: None };
        let mut plain = Writer::new(false);
        plain.line_ref(&l, 0);
        let mut w = Writer::new(false);
        w.post = crate::plan::extras::sketch_post(Some(true), 100.0);
        w.line_ref(&l, 0);
        let segs = lines(&w.finish());
        assert!(segs.len() > 10);
        assert!(segs.windows(2).all(|s| s[0].1 == s[1].0), "Teilstücke schliessen aneinander an");
        assert!(segs[0].0.x < 0.0 && segs[segs.len() - 1].1.x > 4.0);
        assert_eq!(lines(&plain.finish()), vec![(v(0.0, 0.0), v(4.0, 0.0))]);
    }

    #[test]
    fn gestrichelt_nur_enden() {
        let (a, b) = (v(0.0, 0.0), v(2.0, 0.0));
        let (p, q) = jitter_ends(a, b, 0.1, 5);
        assert_eq!((p.x, q.x), (0.0, 2.0));
        assert!(p.y.abs() <= END_MM * 1.5 * 0.1 && q.y.abs() <= END_MM * 1.5 * 0.1);
    }
}
