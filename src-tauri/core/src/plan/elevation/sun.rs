//! [316] Schlagschatten der Ansicht aus dem Sonnenstand: Schatten = Projektion der Werfer (alle Flächen der Wand-,
//! Decken-, Dach-, Stützen- und Geländerkörper, auch abgewandte) in Lichtrichtung auf die Ebene jeder sichtbaren
//! Fläche, nur der Teil vor ihr (zur Sonne hin), beschnitten auf ihren sichtbaren Teil. Von der Sonne abgewandte
//! Flächen liegen ganz im Eigenschatten. Licht: Vorgabe ist die Zeichenregel 45° von links vorn oben, für jede
//! Ansicht gleich relativ zur Blickrichtung (Licht (1, −1, 1)/√3; eine zur Ansicht parallele Fassade ist immer
//! beleuchtet). Nur mit der Modelldarstellung „Schattenlicht: Sonnenstand“ (`elevation.shadowLight = sun`) die Sonne
//! der Schattenstudie (`sunStudy.when`, Ort aus dem Geo-Anker); ohne Studie oder bei Nacht auch dann die Zeichenregel.
//! Gerufen von `elevation_primitives_ren` in `mod.rs`.

use super::*;
use crate::flat::{Polygon, Ring};

/// Werfer-Teile näher als so viel (m, längs des Lichts) an der Empfängerebene werfen nichts: bündige und
/// eigene Flächen (Wandfront, Deckenstirn in der Fassade, Facetten-Nähte) gäben sonst Haarstreifen.
const T_MIN: f64 = 0.02;
/// Fläche gilt als besonnt, wenn das Licht steiler als so einfällt (Kosinus-Anteil gegen die Flächennormale).
const LIT_MIN: f64 = 0.02;
/// Sonne tiefer als so (Grad): Zeichenregel statt Sonnenstand.
const SUN_MIN_DEG: f64 = 2.0;

/// Zeichenregel: Licht von links vorn oben unter 45° (Versatz = Tiefe nach rechts und nach unten).
fn conventional() -> [f64; 3] {
    let k = 1.0 / 3f64.sqrt();
    [k, -k, k]
}

/// Zeitpunkt „JJJJ-MM-TTTHH:MM[:SS[.fff]][Z|±HH:MM]“ in Unix-Millisekunden (ohne Zone: UTC).
pub(super) fn iso_ms(s: &str) -> Option<f64> {
    let s = s.trim();
    let num = |a: usize, b: usize| -> Option<i64> { s.get(a..b).filter(|t| t.bytes().all(|c| c.is_ascii_digit())).and_then(|t| t.parse().ok()) };
    let (y, mo, d) = (num(0, 4)?, num(5, 7)?, num(8, 10)?);
    if s.as_bytes().get(4) != Some(&b'-') || s.as_bytes().get(7) != Some(&b'-') || !(1..=12).contains(&mo) || !(1..=31).contains(&d) {
        return None;
    }
    let (mut h, mut mi, mut sec, mut rest) = (0i64, 0i64, 0f64, "");
    if s.len() > 10 {
        if !matches!(s.as_bytes()[10], b'T' | b' ') {
            return None;
        }
        h = num(11, 13)?;
        mi = num(14, 16)?;
        rest = &s[16..];
        if let Some(r) = rest.strip_prefix(':') {
            let end = r.find(|c: char| !(c.is_ascii_digit() || c == '.')).unwrap_or(r.len());
            sec = r[..end].parse().ok()?;
            rest = &r[end..];
        }
    }
    let off_min = match rest {
        "" | "Z" | "z" => 0i64,
        r if r.len() == 6 && (r.starts_with('+') || r.starts_with('-')) && &r[3..4] == ":" => {
            let v = r[1..3].parse::<i64>().ok()? * 60 + r[4..6].parse::<i64>().ok()?;
            if r.starts_with('-') { -v } else { v }
        }
        _ => return None,
    };
    // Tage seit 1970 (Howard Hinnant, `days_from_civil`).
    let yy = if mo <= 2 { y - 1 } else { y };
    let era = yy.div_euclid(400);
    let yoe = yy - era * 400;
    let mp = (mo + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    let secs = days * 86_400 + h * 3600 + mi * 60 - off_min * 60;
    Some(secs as f64 * 1000.0 + sec * 1000.0)
}

/// Lichtrichtung (Ausbreitung, Länge 1) in Ansichtskoordinaten (u rechts, v oben, Tiefe vom Betrachter weg);
/// `sun` = Sonnenstand der Schattenstudie statt der Zeichenregel.
pub(super) fn light_dir(p: &Project, frame: &[f64; 9], sun: bool) -> [f64; 3] {
    if !sun {
        return conventional();
    }
    let Some(ms) = p.sun_study.as_ref().and_then(|s| iso_ms(&s.when)) else { return conventional() };
    let (lat, lon) = crate::plan::extras::project_lat_lon(p);
    let sun = crate::sun::sun_position(lat, lon, ms);
    if !(sun.elevation > SUN_MIN_DEG) || !sun.azimuth.is_finite() {
        return conventional();
    }
    let (az, el) = (sun.azimuth.to_radians(), sun.elevation.to_radians());
    // Welt [x = Ost, Höhe, y = Nord]; zur Sonne hin.
    let s = [az.sin() * el.cos(), el.sin(), az.cos() * el.cos()];
    let dot = |a: [f64; 3], b: &[f64]| a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    [-dot(s, &frame[6..9]), -s[1], -dot(s, &frame[3..6])]
}

/// Empfänger: sichtbarer Teil einer Fläche und ihre Ebene `Tiefe = a + b·u + c·v`.
pub(super) struct Receiver {
    pub(super) plane: [f64; 3],
    pub(super) region: Vec<Polygon>,
}

fn bbox_of(polys: &[Polygon]) -> [f64; 4] {
    polys.iter().flatten().flatten().fold([f64::INFINITY, f64::NEG_INFINITY, f64::INFINITY, f64::NEG_INFINITY], |b, q| [b[0].min(q[0]), b[1].max(q[0]), b[2].min(q[1]), b[3].max(q[1])])
}

fn area(r: &Ring) -> f64 {
    let n = r.len();
    (0..n).map(|i| r[i][0] * r[(i + 1) % n][1] - r[(i + 1) % n][0] * r[i][1]).sum::<f64>() / 2.0
}

/// Schatten je Empfänger (Index wie `receivers`): abgewandt der ganze sichtbare Teil, sonst die Vereinigung der
/// in Lichtrichtung `l` projizierten Werfer-Teile davor, geschnitten mit dem sichtbaren Teil. Werfer: ebene
/// Polygone in Ansichtskoordinaten (u, v, Tiefe).
pub(super) fn cast(receivers: &[Receiver], casters: &[Vec<[f64; 3]>], l: [f64; 3]) -> Vec<Vec<Polygon>> {
    if !l.iter().all(|x| x.is_finite()) {
        return vec![Vec::new(); receivers.len()];
    }
    // Hüllquader je Werfer: u, v, Tiefe (min, max).
    let boxes: Vec<[f64; 6]> = casters
        .iter()
        .map(|c| c.iter().fold([f64::INFINITY, f64::NEG_INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::INFINITY, f64::NEG_INFINITY], |b, q| [b[0].min(q[0]), b[1].max(q[0]), b[2].min(q[1]), b[3].max(q[1]), b[4].min(q[2]), b[5].max(q[2])]))
        .collect();
    receivers
        .iter()
        .map(|r| {
            let [a, b, c] = r.plane;
            if r.region.is_empty() || ![a, b, c].iter().all(|x| x.is_finite()) {
                return Vec::new();
            }
            // Vorderseite (dem Betrachter zu) mit Normale (b, c, −1): besonnt, wenn das Licht gegen sie läuft.
            let den = l[2] - b * l[0] - c * l[1];
            if den <= LIT_MIN * (1.0 + b * b + c * c).sqrt() {
                return r.region.clone();
            }
            let rb = bbox_of(&r.region);
            let mut pieces: Vec<Polygon> = Vec::new();
            for (k, poly) in casters.iter().enumerate() {
                let bx = boxes[k];
                if poly.len() < 3 || !bx.iter().all(|x| x.is_finite()) {
                    continue;
                }
                // Grobprüfung: Lichtweg t der Ecken bis zur Ebene, Schattenbox gegen die Fläche.
                let corners = [(bx[0], bx[2]), (bx[1], bx[2]), (bx[0], bx[3]), (bx[1], bx[3])];
                let (pmin, pmax) = corners.iter().map(|&(u, v)| a + b * u + c * v).fold((f64::INFINITY, f64::NEG_INFINITY), |(lo, hi), x| (lo.min(x), hi.max(x)));
                let tmax = (pmax - bx[4]) / den;
                if !(tmax > T_MIN) {
                    continue;
                }
                let tmin = ((pmin - bx[5]) / den).max(T_MIN);
                let (du0, du1) = (tmin * l[0], tmax * l[0]);
                let (dv0, dv1) = (tmin * l[1], tmax * l[1]);
                if bx[0] + du0.min(du1) > rb[1] || bx[1] + du0.max(du1) < rb[0] || bx[2] + dv0.min(dv1) > rb[3] || bx[3] + dv0.max(dv1) < rb[2] {
                    continue;
                }
                // Werfer auf t ≥ T_MIN beschneiden (t affin in u, v, Tiefe) und in Lichtrichtung auf die Ebene legen.
                let t: Vec<f64> = poly.iter().map(|q| (a + b * q[0] + c * q[1] - q[2]) / den).collect();
                let proj = |q: [f64; 3], t: f64| [q[0] + t * l[0], q[1] + t * l[1]];
                let mut ring: Ring = Vec::with_capacity(poly.len() + 2);
                for i in 0..poly.len() {
                    let j = (i + 1) % poly.len();
                    let (ti, tj) = (t[i], t[j]);
                    if ti >= T_MIN {
                        ring.push(proj(poly[i], ti));
                    }
                    if (ti >= T_MIN) != (tj >= T_MIN) {
                        let s = (T_MIN - ti) / (tj - ti);
                        let (qi, qj) = (poly[i], poly[j]);
                        ring.push(proj([qi[0] + (qj[0] - qi[0]) * s, qi[1] + (qj[1] - qi[1]) * s, qi[2] + (qj[2] - qi[2]) * s], T_MIN));
                    }
                }
                if ring.len() >= 3 && area(&ring).abs() > 1e-8 {
                    pieces.push(vec![ring]);
                }
            }
            if pieces.is_empty() {
                return Vec::new();
            }
            crate::polygon_bool::intersection(&crate::polygon_bool::union(&pieces), &r.region)
        })
        .collect()
}

/// Leibungsschatten einer Öffnung (Anteile der Breite bzw. Höhe, 0 = keiner): oben und auf der Seite, von der das
/// Licht kommt (`links` = Licht läuft nach rechts), aus der Leibungstiefe `reveal` (m) und der Lichtrichtung.
pub(super) fn reveal_fractions(l: [f64; 3], reveal: f64, width: f64, height: f64) -> Option<(f64, f64, bool)> {
    if !(l[2] > 0.05) {
        return None;
    }
    let top = (reveal * -l[1] / l[2]).max(0.0);
    let side = reveal * l[0].abs() / l[2];
    Some(((side / width.max(1e-6)).min(0.3), (top / height.max(1e-6)).min(0.3), l[0] > 0.0))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(u0: f64, u1: f64, v0: f64, v1: f64) -> Polygon {
        vec![vec![[u0, v0], [u1, v0], [u1, v1], [u0, v1]]]
    }

    fn total_area(polys: &[Polygon]) -> f64 {
        polys.iter().map(|p| p.iter().map(|r| area(r)).sum::<f64>().abs()).sum()
    }

    fn bounds(polys: &[Polygon]) -> [f64; 4] {
        bbox_of(polys)
    }

    #[test]
    fn iso_zeit() {
        assert_eq!(iso_ms("1970-01-01T00:00:00Z"), Some(0.0));
        assert_eq!(iso_ms("2026-06-21T10:00:00Z"), Some(1_782_036_000_000.0));
        assert_eq!(iso_ms("2026-06-21T12:00:00+02:00"), Some(1_782_036_000_000.0));
        assert_eq!(iso_ms("2026-06-21T10:00Z"), Some(1_782_036_000_000.0));
        assert_eq!(iso_ms("2026-06-21"), Some(1_782_000_000_000.0));
        assert_eq!(iso_ms("Mittag"), None);
        assert_eq!(iso_ms(""), None);
    }

    /// Wand in der Ebene Tiefe 2 (u 0..6, v 0..3); Vordach 1 m tief (Tiefe 1..2), u 1..5, Unterkante 2.5, oben 2.7.
    fn canopy() -> Vec<Vec<[f64; 3]>> {
        let (u0, u1, d0, d1, v0, v1) = (1.0, 5.0, 1.0, 2.0, 2.5, 2.7);
        vec![
            vec![[u0, v0, d0], [u1, v0, d0], [u1, v1, d0], [u0, v1, d0]], // Stirn
            vec![[u0, v0, d0], [u1, v0, d0], [u1, v0, d1], [u0, v0, d1]], // Unterseite
            vec![[u0, v1, d0], [u1, v1, d0], [u1, v1, d1], [u0, v1, d1]], // Oberseite
            vec![[u0, v0, d0], [u0, v1, d0], [u0, v1, d1], [u0, v0, d1]], // Seiten
            vec![[u1, v0, d0], [u1, v1, d0], [u1, v1, d1], [u1, v0, d1]],
        ]
    }

    fn wall() -> Receiver {
        Receiver { plane: [2.0, 0.0, 0.0], region: vec![rect(0.0, 6.0, 0.0, 3.0)] }
    }

    #[test]
    fn vordach_wirft_schatten_nach_unten_bei_sonne_von_vorn_oben() {
        // Sonne genau von vorn unter 45°: Licht (0, −1, 1)/√2 ⇒ Schatten 1 m unter der Unterkante, gleich breit.
        let k = 0.5f64.sqrt();
        let s = cast(&[wall()], &canopy(), [0.0, -k, k]);
        let b = bounds(&s[0]);
        assert!((b[0] - 1.0).abs() < 1e-6 && (b[1] - 5.0).abs() < 1e-6, "{b:?}");
        // Unten 1 m unter der Unterkante; oben bis knapp an den Anschluss (die letzten `T_MIN` liegen hinter dem Dach).
        assert!((b[2] - 1.5).abs() < 1e-6 && b[3] > 2.65 && b[3] <= 2.7 + 1e-9, "{b:?}");
        // Unter dem Vordach (v 1.5 … 2.5) ganz im Schatten.
        let under = rect(1.0, 5.0, 1.5, 2.5);
        assert!((total_area(&crate::polygon_bool::intersection(&s[0], &[under])) - 4.0).abs() < 1e-6);
    }

    #[test]
    fn abgewandte_flaeche_ganz_im_schatten() {
        // Sonne hinter dem Haus (Licht läuft zum Betrachter): die ganze sichtbare Fläche, auch ohne Werfer.
        let k = 0.5f64.sqrt();
        let s = cast(&[wall()], &[], [0.0, -k, -k]);
        assert!((total_area(&s[0]) - 18.0).abs() < 1e-9);
        // Streiflicht genau in der Ebene: ebenfalls Eigenschatten.
        let s = cast(&[wall()], &canopy(), [1.0, 0.0, 0.0]);
        assert!((total_area(&s[0]) - 18.0).abs() < 1e-9);
    }

    #[test]
    fn balkon_schatten_in_sonnenrichtung_versetzt() {
        // Licht (1, −1, 1)/√3 (Zeichenregel): Schatten des 1 m tiefen Balkons um 1 m nach rechts und unten versetzt;
        // die Schattenfläche reicht rechts bis u 6 (Wandrand), unten bis 1.5.
        let s = cast(&[wall()], &canopy(), conventional());
        let b = bounds(&s[0]);
        assert!((b[0] - 1.0).abs() < 0.02 && (b[1] - 6.0).abs() < 1e-6, "{b:?}");
        assert!((b[2] - 1.5).abs() < 1e-6, "{b:?}");
        // Unter dem Balkon, um 1 m nach rechts versetzt (u 2 … 5, v 1.5 … 2.5): ganz im Schatten.
        let shifted = rect(2.0, 5.0, 1.5, 2.5);
        assert!((total_area(&crate::polygon_bool::intersection(&s[0], &[shifted])) - 3.0).abs() < 1e-6);
        // Links unten unter dem Balkon (Dreieck unter der Diagonale vom Anschluss) ist der Schatten noch nicht: hell.
        let lit = rect(1.05, 1.3, 1.55, 1.8);
        assert!(total_area(&crate::polygon_bool::intersection(&s[0], &[lit])) < 1e-6);
        // Sonne von rechts: Schatten nach links.
        let k = 1.0 / 3f64.sqrt();
        let b = bounds(&cast(&[wall()], &canopy(), [-k, -k, k])[0]);
        assert!((b[0] - 0.0).abs() < 1e-6 && (b[1] - 5.0).abs() < 0.02, "{b:?}");
    }

    #[test]
    fn werfer_hinter_der_flaeche_und_buendige_werfen_nichts() {
        // Körper hinter der Wand (Tiefe 3..4) und bündig in ihrer Ebene: kein Schatten.
        let behind = vec![vec![[1.0, 1.0, 3.0], [2.0, 1.0, 3.0], [2.0, 2.0, 3.0], [1.0, 2.0, 3.0]], vec![[1.0, 2.0, 2.0], [2.0, 2.0, 2.0], [2.0, 2.0, 4.0], [1.0, 2.0, 4.0]]];
        assert!(cast(&[wall()], &behind, conventional())[0].is_empty());
        // Schatten ausserhalb der sichtbaren Fläche (in der Luft) entfällt.
        let far = vec![vec![[10.0, 1.0, 1.0], [11.0, 1.0, 1.0], [11.0, 2.0, 1.0], [10.0, 2.0, 1.0]]];
        assert!(cast(&[wall()], &far, conventional())[0].is_empty());
        // Unsinn: leer statt Panic.
        assert!(cast(&[wall()], &canopy(), [f64::NAN, 0.0, 1.0])[0].is_empty());
    }

    #[test]
    fn leibung_nach_licht() {
        let (fs, ft, left) = reveal_fractions(conventional(), 0.08, 1.0, 1.0).unwrap();
        assert!((fs - 0.08).abs() < 1e-9 && (ft - 0.08).abs() < 1e-9 && left);
        let k = 0.5f64.sqrt();
        assert!(reveal_fractions([0.0, -k, -k], 0.08, 1.0, 1.0).is_none());
        let (fs, _, left) = reveal_fractions([-0.5, -0.5, 0.7], 0.08, 1.0, 1.0).unwrap();
        assert!(fs > 0.0 && !left);
    }
}
