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
    #[cfg(test)]
    let _t = PhaseTimer::new(&CAST_NS);
    if !l.iter().all(|x| x.is_finite()) {
        return vec![Vec::new(); receivers.len()];
    }
    // Hüllquader je Werfer: u, v, Tiefe (min, max).
    let boxes: Vec<[f64; 6]> = casters
        .iter()
        .map(|c| c.iter().fold([f64::INFINITY, f64::NEG_INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::INFINITY, f64::NEG_INFINITY], |b, q| [b[0].min(q[0]), b[1].max(q[0]), b[2].min(q[1]), b[3].max(q[1]), b[4].min(q[2]), b[5].max(q[2])]))
        .collect();
    let strips = Strips::new(&boxes, l);
    let mut near: Vec<u32> = Vec::new();
    receivers
        .iter()
        .map(|r| {
            strips.query(bbox_of(&r.region), &mut near);
            let out = shade(r, casters, &boxes, l, Some(&near));
            #[cfg(test)]
            if COMPARE.load(std::sync::atomic::Ordering::Relaxed) {
                compare_reference(&out, &shade(r, casters, &boxes, l, None));
            }
            out
        })
        .collect()
}

/// [327] Werfer nach ihrer Lage quer zum Licht (w = u·l₁ − v·l₀) in Streifen: der Schatten eines Werfers wandert in der
/// Ansicht nur längs (l₀, l₁), sein w-Bereich ist auf jeder Empfänger-Ebene derselbe. Ein Empfänger prüft so nur die
/// Werfer seiner Streifen statt alle (grosses Projekt: Tausende Flächen gegen Tausende Werfer).
struct Strips {
    l: [f64; 2],
    w0: f64,
    step: f64,
    cells: Vec<Vec<u32>>,
    /// Werfer ohne endlichen Bereich und alle, wenn das Licht genau in Blickrichtung fällt: immer geprüft.
    all: bool,
    n: usize,
    /// Marken je Werfer für [`Self::query`] (danach wieder leer).
    seen: std::cell::RefCell<Vec<bool>>,
}

impl Strips {
    const N: usize = 512;

    fn range(l: [f64; 2], b: [f64; 4]) -> (f64, f64) {
        let w = |u: f64, v: f64| u * l[1] - v * l[0];
        let c = [w(b[0], b[2]), w(b[1], b[2]), w(b[0], b[3]), w(b[1], b[3])];
        (c.iter().copied().fold(f64::INFINITY, f64::min), c.iter().copied().fold(f64::NEG_INFINITY, f64::max))
    }

    fn new(boxes: &[[f64; 6]], l: [f64; 3]) -> Strips {
        let l2 = [l[0], l[1]];
        let ranges: Vec<Option<(f64, f64)>> = boxes.iter().map(|b| b.iter().all(|x| x.is_finite()).then(|| Self::range(l2, [b[0], b[1], b[2], b[3]]))).collect();
        let (lo, hi) = ranges.iter().flatten().fold((f64::INFINITY, f64::NEG_INFINITY), |(lo, hi), r| (lo.min(r.0), hi.max(r.1)));
        let mut s = Strips { l: l2, w0: lo, step: (hi - lo) / Self::N as f64, cells: Vec::new(), all: true, n: boxes.len(), seen: std::cell::RefCell::new(vec![false; boxes.len()]) };
        if !(s.step > 1e-9) || !s.step.is_finite() {
            return s;
        }
        s.all = false;
        s.cells = vec![Vec::new(); Self::N];
        for (k, r) in ranges.iter().enumerate() {
            // Ohne endlichen Quader entfällt der Werfer in `shade` ohnehin.
            let Some(r) = r else { continue };
            let (i0, i1) = (s.cell(r.0), s.cell(r.1));
            for c in &mut s.cells[i0..=i1] {
                c.push(k as u32);
            }
        }
        s
    }

    fn cell(&self, w: f64) -> usize {
        (((w - self.w0) / self.step).floor().max(0.0) as usize).min(Self::N - 1)
    }

    /// Werfer (aufsteigend), deren w-Bereich den des Rechtecks `rb` (`[u0, u1, v0, v1]`, mit Rand) berühren kann.
    fn query(&self, rb: [f64; 4], out: &mut Vec<u32>) {
        out.clear();
        if self.all || !rb.iter().all(|x| x.is_finite()) {
            out.extend(0..self.n as u32);
            return;
        }
        let (lo, hi) = Self::range(self.l, [rb[0], rb[1], rb[2], rb[3]]);
        let pad = 1e-6 * (1.0 + self.l[0].abs() + self.l[1].abs());
        // Lange Werfer liegen in vielen Streifen: erst über die Marken einmalig machen, dann ordnen.
        let mut seen = self.seen.borrow_mut();
        for c in &self.cells[self.cell(lo - pad)..=self.cell(hi + pad)] {
            for &k in c {
                if !std::mem::replace(&mut seen[k as usize], true) {
                    out.push(k);
                }
            }
        }
        for &k in out.iter() {
            seen[k as usize] = false;
        }
        out.sort_unstable();
    }
}

/// Schatten eines Empfängers. `near` = [327] nur diese Werfer (aufsteigend, [`Strips`]); `prefilter` (= `near` gesetzt) = [319] Werfer-Stücke vorab aufs Hüllrechteck beschnitten und EIN Boolean;
/// ohne (nur als Vergleich in Tests) wie in [316]: alle Stücke vereinigt, dann geschnitten.
fn shade(r: &Receiver, casters: &[Vec<[f64; 3]>], boxes: &[[f64; 6]], l: [f64; 3], near: Option<&[u32]>) -> Vec<Polygon> {
    let prefilter = near.is_some();
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
    let rect: Ring = vec![[rb[0], rb[2]], [rb[1], rb[2]], [rb[1], rb[3]], [rb[0], rb[3]]];
    let hull = convex_hull_of(&r.region, rb);
    let hull_area = hull.as_ref().map_or(0.0, |h| area(h).abs());
    let mut pieces: Vec<Polygon> = Vec::new();
    let all: Vec<u32>;
    let which: &[u32] = match near {
        Some(n) => n,
        None => {
            all = (0..casters.len() as u32).collect();
            &all
        }
    };
    for &k in which {
        let k = k as usize;
        let poly = &casters[k];
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
        if ring.len() < 3 || area(&ring).abs() <= 1e-8 {
            continue;
        }
        if !prefilter {
            pieces.push(vec![ring]);
            continue;
        }
        // [319] Vorab aufs Hüllrechteck des Empfängers beschneiden; Stücke neben seinem konvexen Umriss
        // entfallen, die übrigen gehen klein in den EINEN Boolean unten. Deckt eines die konvexe Fläche
        // ganz, genügt es allein.
        let ring = clip_convex(&ring, &rect);
        if ring.len() < 3 || area(&ring).abs() <= CLIP_AREA_MIN {
            continue;
        }
        if let Some(h) = &hull {
            let a = area(&clip_convex(&ring, h)).abs();
            if a <= CLIP_AREA_MIN {
                continue;
            }
            if a >= hull_area * (1.0 - 1e-9) {
                pieces = vec![vec![ring]];
                break;
            }
        }
        pieces.push(vec![ring]);
    }
    if pieces.is_empty() {
        return Vec::new();
    }
    if !prefilter {
        return crate::polygon_bool::intersection(&crate::polygon_bool::union(&pieces), &r.region);
    }
    // Ein Boolean je Empfänger: die Werfer-Stücke vereinigt (Non-Zero) und mit dem sichtbaren Teil geschnitten.
    crate::polygon_bool::intersection(&r.region, &pieces)
}

/// [319] Beschnittene Stücke unter so viel Fläche (m²) entfallen (Rundungssplitter an der Hülle).
const CLIP_AREA_MIN: f64 = 1e-10;

/// [319] Konvexer Umriss eines Empfängers (ein Ring ohne Loch), gegen den Uhrzeigersinn; sonst `None`. Dient nur der
/// Prüfung, ob ein Werfer-Stück die Fläche trifft bzw. ganz deckt — beschnitten wird am Hüllrechteck (achsparallel,
/// exakte Kanten: an schrägen Kanten beschnittene Stücke teilen fast, aber nicht genau gleiche Kanten, daran
/// verrechnet sich i_overlay um Sekunden).
fn convex_hull_of(region: &[Polygon], rb: [f64; 4]) -> Option<Ring> {
    let [poly] = region else { return None };
    let [ring] = poly.as_slice() else { return None };
    let n = ring.len();
    let s = area(ring).signum();
    let tol = 1e-12 * (1.0 + (rb[1] - rb[0]).abs() + (rb[3] - rb[2]).abs()).powi(2);
    let convex = n >= 3
        && s != 0.0
        && (0..n).all(|i| {
            let (p, q, w) = (ring[i], ring[(i + 1) % n], ring[(i + 2) % n]);
            s * ((q[0] - p[0]) * (w[1] - q[1]) - (q[1] - p[1]) * (w[0] - q[0])) >= -tol
        });
    if !convex {
        return None;
    }
    let mut h = ring.clone();
    if s < 0.0 {
        h.reverse();
    }
    Some(h)
}

/// [319] Sutherland-Hodgman: `subject` auf den konvexen Ring `hull` (gegen den Uhrzeigersinn) beschnitten.
fn clip_convex(subject: &Ring, hull: &Ring) -> Ring {
    let mut out = subject.clone();
    let n = hull.len();
    for i in 0..n {
        if out.len() < 3 {
            return Vec::new();
        }
        let (a, b) = (hull[i], hull[(i + 1) % n]);
        let side = |q: [f64; 2]| (b[0] - a[0]) * (q[1] - a[1]) - (b[1] - a[1]) * (q[0] - a[0]);
        let input = std::mem::take(&mut out);
        let m = input.len();
        for k in 0..m {
            let (p, q) = (input[k], input[(k + 1) % m]);
            let (sp, sq) = (side(p), side(q));
            if sp >= 0.0 {
                out.push(p);
            }
            if (sp >= 0.0) != (sq >= 0.0) {
                let t = sp / (sp - sq);
                out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
            }
        }
    }
    out
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

/// Zeitmessung je Phase (nur Tests, [319] `bench319`).
#[cfg(test)]
pub(super) static CAST_NS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
/// [319] Vergleich mit der Rechnung aus [316] (nur Tests): Anzahl Empfänger, grösste Fläche der symmetrischen Differenz (m²).
#[cfg(test)]
pub(super) static COMPARE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
#[cfg(test)]
pub(super) static COMPARE_STATS: std::sync::Mutex<(usize, f64)> = std::sync::Mutex::new((0, 0.0));
#[cfg(test)]
fn compare_reference(new: &[Polygon], reference: &[Polygon]) {
    let sym = |a: &[Polygon], b: &[Polygon]| crate::polygon_bool::difference(a, b).iter().map(|p| p.iter().map(|r| area(r)).sum::<f64>().abs()).sum::<f64>();
    let d = sym(new, reference) + sym(reference, new);
    let mut st = COMPARE_STATS.lock().unwrap();
    st.0 += 1;
    st.1 = st.1.max(d);
}
#[cfg(test)]
pub(super) static SHADOW_NS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
#[cfg(test)]
pub(super) struct PhaseTimer(&'static std::sync::atomic::AtomicU64, std::time::Instant);
#[cfg(test)]
impl PhaseTimer {
    pub(super) fn new(c: &'static std::sync::atomic::AtomicU64) -> Self {
        PhaseTimer(c, std::time::Instant::now())
    }
}
#[cfg(test)]
impl Drop for PhaseTimer {
    fn drop(&mut self) {
        self.0.fetch_add(self.1.elapsed().as_nanos() as u64, std::sync::atomic::Ordering::Relaxed);
    }
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

    #[test]
    fn vorab_beschnitt_dreieck_und_volle_deckung() {
        // Dreieckiger Empfänger (Dachfacette), Licht genau von vorn (Schatten = Werfer verschoben um 0): ein Werfer im
        // Hüllrechteck, aber neben dem Dreieck wirft nichts; einer, der es ganz deckt, gibt genau das Dreieck.
        let tri = Receiver { plane: [2.0, 0.0, 0.0], region: vec![vec![vec![[0.0, 0.0], [4.0, 0.0], [0.0, 4.0]]]] };
        let quad = |u0: f64, u1: f64, v0: f64, v1: f64| vec![[u0, v0, 1.0], [u1, v0, 1.0], [u1, v1, 1.0], [u0, v1, 1.0]];
        let l = [0.0, 0.0, 1.0];
        assert!(cast(&[tri], &[quad(3.0, 4.0, 3.0, 4.0)], l)[0].is_empty());
        let tri = Receiver { plane: [2.0, 0.0, 0.0], region: vec![vec![vec![[0.0, 0.0], [4.0, 0.0], [0.0, 4.0]]]] };
        let s = cast(&[tri], &[quad(3.0, 4.0, 3.0, 4.0), quad(-1.0, 5.0, -1.0, 5.0), quad(0.5, 1.0, 0.5, 1.0)], l);
        assert!((total_area(&s[0]) - 8.0).abs() < 1e-6, "{}", total_area(&s[0]));
        // Teildeckung über einer Wand mit Loch (nicht konvex): Schnitt wie vorher.
        let holed = Receiver { plane: [2.0, 0.0, 0.0], region: vec![vec![vec![[0.0, 0.0], [6.0, 0.0], [6.0, 3.0], [0.0, 3.0]], vec![[2.0, 1.0], [2.0, 2.0], [3.0, 2.0], [3.0, 1.0]]]] };
        let s = cast(&[holed], &[quad(1.0, 4.0, 0.5, 2.5), quad(-2.0, 1.5, -1.0, 1.0)], l);
        // 3 × 2 − Loch 1 = 5, dazu (0 … 1.5) × (0 … 1) ohne Überlappung mit dem ersten (u 1 … 1.5, v 0.5 … 1): 1.5 − 0.25.
        assert!((total_area(&s[0]) - 6.25).abs() < 1e-6, "{}", total_area(&s[0]));
    }

    #[test]
    fn viele_werfer_auf_schmaler_schraeger_flaeche_schnell() {
        // [319] Schmale, leicht schräge Fläche (Sockelband) unter vielen gestaffelten Werfern, die einander fast
        // deckungsgleich überlappen: vorher (an der schrägen Kante beschnittene Stücke) Sekunden in i_overlay.
        let band = Receiver { plane: [2.0, 0.0, 0.0], region: vec![vec![vec![[17.0, 0.0], [17.0, -0.7277], [20.195, -0.7123], [20.195, 0.0]]]] };
        let casters: Vec<Vec<[f64; 3]>> = (0..400)
            .map(|i| {
                let u = 17.0 + 0.0077 * i as f64;
                vec![[u, 0.5, 1.0], [u + 0.9, 0.5, 1.0], [u + 0.9, 1.2, 1.0], [u, 1.2, 1.0]]
            })
            .collect();
        let t = std::time::Instant::now();
        let s = cast(&[band], &casters, conventional());
        assert!(t.elapsed().as_secs_f64() < 5.0, "{:?}", t.elapsed());
        assert!(total_area(&s[0]) > 1.0);
    }

    /// [319] Zeit der Ansichten samt Schattenanteil (nativ, von Hand; Mittel über `BENCH_RUNS` nach einem Aufwärm-Lauf):
    /// `BENCH_FILE=mk.obp cargo test --release --lib bench319 -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn bench319() {
        use std::sync::atomic::Ordering::Relaxed;
        let Ok(path) = std::env::var("BENCH_FILE") else { return };
        let runs: usize = std::env::var("BENCH_RUNS").ok().and_then(|s| s.parse().ok()).unwrap_or(3);
        let p: Project = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let time = |text: &str, sh: f64| {
            super::elevation_plan_buf(&p, &[0.0, sh], text).unwrap();
            SHADOW_NS.store(0, Relaxed);
            CAST_NS.store(0, Relaxed);
            let t = std::time::Instant::now();
            for _ in 0..runs {
                super::elevation_plan_buf(&p, &[0.0, sh], text).unwrap();
            }
            let n = runs as f64;
            (t.elapsed().as_secs_f64() * 1e3 / n, SHADOW_NS.load(Relaxed) as f64 / 1e6 / n, CAST_NS.load(Relaxed) as f64 / 1e6 / n)
        };
        let mut sum = [0.0; 3];
        for l in p.drawing_levels.iter().filter(|l| l.kind == crate::model::DrawingLevelKind::Elevation && l.line_points.is_some() && l.layout_id.is_none()) {
            let text = serde_json::json!({ "level": serde_json::to_value(l).unwrap() }).to_string();
            let (t0, _, _) = time(&text, 0.0);
            let (t1, ts, tc) = time(&text, 1.0);
            // Gleiches Ergebnis wie die Rechnung aus [316]?
            *COMPARE_STATS.lock().unwrap() = (0, 0.0);
            COMPARE.store(true, Relaxed);
            super::elevation_plan_buf(&p, &[0.0, 1.0], &text).unwrap();
            COMPARE.store(false, Relaxed);
            let (n, d) = *COMPARE_STATS.lock().unwrap();
            println!("{}: ohne Schatten {t0:.1} ms, mit {t1:.1} ms, Schatten {ts:.1} ms (davon cast {tc:.1} ms); {n} Empfänger, Abweichung zu [316] höchstens {d:.2e} m²", l.id);
            sum = [sum[0] + t1, sum[1] + ts, sum[2] + tc];
        }
        println!("Summe mit Schatten {:.1} ms, Schatten {:.1} ms (davon cast {:.1} ms)", sum[0], sum[1], sum[2]);
    }
}

