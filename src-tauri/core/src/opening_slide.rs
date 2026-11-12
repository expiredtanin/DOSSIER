//! Wandöffnungen in ihrer Wand verschieben ([144]): gemeinsamer Weg für den Verschieben-Befehl
//! (`cmd_transform`), den Griff-Zug und das Objekt-Info-Feld „Position" (`grips.rs`).
//!
//! - **Wandachse** gerade oder als Bogen ([T2]): `position` ist bei Bogenwänden die Bogenlänge auf der
//!   Achse ab `start` (wie die abgewickelte Wand im Grundriss), die Wandlänge die Bogenlänge.
//! - **Überlappung**: eine gleitende Öffnung hält vor der Nachbaröffnung derselben Wand an und lässt
//!   einen Steg von [`MIN_WEB`]; schon überlappende Daten (Bestand) bleiben, wie sie sind.
//! - **Dach-/Deckenöffnungen**: Mittelpunkt im Umriss des Wirts halten ([`clamp_inside`]).

use crate::jsnum::ClampSafe;
use crate::json_util::{field, num_of};
use crate::ops::id_of;
use crate::wall_arc::WallArc;
use serde_json::{Map, Value};

type P = (f64, f64);

/// Kleinster Steg zwischen zwei Öffnungen derselben Wand (Meter).
pub const MIN_WEB: f64 = 0.05;
/// Hinweis-Schlüssel (i18n), wenn eine Öffnung an der Nachbaröffnung anhält.
pub const NOTICE_OVERLAP: &str = "opening.overlapClamped";
/// Hinweis-Schlüssel, wenn in der Zielwand kein Platz ist.
pub const NOTICE_NO_ROOM: &str = "opening.noRoom";

const EPS: f64 = 1e-9;

/// Wandachse: Strecke oder Bogen.
pub enum Axis {
    Line { s: P, u: P, len: f64 },
    Arc(WallArc),
}

impl Axis {
    /// Achse der Wand `w` (`start`, `end`, `bulge`); `None` bei entarteter Wand.
    pub fn of(w: &Value) -> Option<Axis> {
        let pt = |k: &str| -> Option<P> {
            let v = field(w, k)?;
            let (x, y) = (field(v, "x")?.as_f64()?, field(v, "y")?.as_f64()?);
            (x.is_finite() && y.is_finite()).then_some((x, y))
        };
        let (s, e) = (pt("start")?, pt("end")?);
        let bulge = field(w, "bulge").and_then(Value::as_f64);
        if crate::wall_arc::is_arc_bulge(bulge) {
            let a = WallArc::of(kernel2d::Vec2::new(s.0, s.1), kernel2d::Vec2::new(e.0, e.1), bulge)?;
            return Some(Axis::Arc(a));
        }
        let len = crate::jsmath::hypot2(e.0 - s.0, e.1 - s.1);
        (len > EPS && len.is_finite()).then(|| Axis::Line { s, u: ((e.0 - s.0) / len, (e.1 - s.1) / len), len })
    }

    /// Länge der Achse (Bogen: Bogenlänge).
    pub fn len(&self) -> f64 {
        match self {
            Axis::Line { len, .. } => *len,
            Axis::Arc(a) => a.length(),
        }
    }

    /// Punkt auf der Achse bei Lauflänge `t`, quer um `n` (linke Normale) versetzt.
    pub fn point(&self, t: f64, n: f64) -> P {
        match self {
            Axis::Line { s, u, .. } => (s.0 + u.0 * t - u.1 * n, s.1 + u.1 * t + u.0 * n),
            Axis::Arc(a) => {
                let q = a.point(t, n);
                (q.x, q.y)
            }
        }
    }

    /// Einheits-Tangente (Laufrichtung) bei `t`.
    pub fn tangent(&self, t: f64) -> P {
        match self {
            Axis::Line { u, .. } => *u,
            Axis::Arc(a) => {
                let v = a.tangent(t);
                (v.x, v.y)
            }
        }
    }

    /// Lauflänge des Lotfusspunkts von `p` (ungeklemmt) und Abstand von `p` zur Achse (Lotfuss auf die
    /// Achse geklemmt).
    pub fn local(&self, p: P) -> (f64, f64) {
        let t = match self {
            Axis::Line { s, u, .. } => (p.0 - s.0) * u.0 + (p.1 - s.1) * u.1,
            Axis::Arc(a) => a.local(kernel2d::Vec2::new(p.0, p.1)).0,
        };
        let q = self.point(t.clamp_safe(0.0, self.len()), 0.0);
        (t, crate::jsmath::hypot2(p.0 - q.0, p.1 - q.1))
    }
}

/// Belegte Abschnitte `[Anfang, Ende]` der übrigen Öffnungen in Wand `host` (ohne `skip`).
fn neighbours(root: &Map<String, Value>, host: &str, skip: &dyn Fn(&str) -> bool) -> Vec<(f64, f64)> {
    root.get("openings")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
        .iter()
        .filter(|o| field(o, "hostWallId").and_then(Value::as_str) == Some(host))
        .filter(|o| !id_of(o).is_some_and(skip))
        .filter_map(|o| {
            let (a, w) = (num_of(field(o, "position")), num_of(field(o, "width")));
            (a.is_finite() && w.is_finite() && w > 0.0).then_some((a, a + w))
        })
        .collect()
}

/// Ergebnis der Überlappungs-Regel: neue `position` und ob eine Nachbaröffnung sie begrenzt hat.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Placed {
    pub position: f64,
    pub clamped: bool,
}

/// `want` (Anfang einer Öffnung der Breite `width` in Wand `host` mit Länge `len`) gegen die Nachbarn
/// prüfen. Gleitet die Öffnung von `from` aus (gleiche Wand), hält sie vor dem ersten Nachbarn in
/// Laufrichtung mit Steg [`MIN_WEB`] an; Nachbarn, mit denen sie schon bei `from` überlappt (Bestand),
/// zählen nicht. Ohne `from` (neue Wand, Kopie) rückt sie an die nächste freie Stelle; `None`, wenn
/// keine passt. `skip`: Öffnungen, die nicht zählen (die Öffnung selbst, mitbewegte).
pub fn place(root: &Map<String, Value>, host: &str, len: f64, width: f64, from: Option<f64>, want: f64, skip: &dyn Fn(&str) -> bool) -> Option<Placed> {
    let max = len - width;
    if !(max > -EPS && want.is_finite()) {
        return None;
    }
    let max = max.max(0.0);
    let want = want.clamp_safe(0.0, max);
    // Gesperrte Anfangslagen je Nachbar: offenes Intervall (lo, hi).
    let blocked: Vec<(f64, f64)> = neighbours(root, host, skip).into_iter().map(|(a, b)| (a - width - MIN_WEB, b + MIN_WEB)).collect();
    let inside = |x: f64, (lo, hi): (f64, f64)| x > lo + EPS && x < hi - EPS;
    if let Some(from) = from.filter(|f| f.is_finite()) {
        let ahead = blocked.iter().filter(|b| !inside(from, **b));
        let pos = if want > from {
            ahead.filter(|(lo, _)| *lo >= from - EPS).map(|(lo, _)| *lo).fold(want, f64::min)
        } else {
            ahead.filter(|(_, hi)| *hi <= from + EPS).map(|(_, hi)| *hi).fold(want, f64::max)
        };
        return Some(Placed { position: pos, clamped: (pos - want).abs() > EPS });
    }
    let free = |x: f64| x >= -EPS && x <= max + EPS && !blocked.iter().any(|b| inside(x, *b));
    std::iter::once(want)
        .chain(blocked.iter().flat_map(|(lo, hi)| [*lo, *hi]))
        .filter(|x| free(*x))
        .min_by(|a, b| (a - want).abs().total_cmp(&(b - want).abs()))
        .map(|x| Placed { position: x.clamp_safe(0.0, max), clamped: (x - want).abs() > EPS })
}

/// Öffnung `o` in ihrer Wand auf den Anfang `want` setzen (gleitend ab ihrer jetzigen Lage; geklemmt auf
/// die Wand und vor den Nachbarn). `None`: Wirt fehlt oder die Öffnung passt nicht in die Wand.
pub fn slide_to(root: &Map<String, Value>, o: &Value, want: f64) -> Option<Placed> {
    let host = field(o, "hostWallId").and_then(Value::as_str).filter(|h| !h.is_empty())?;
    let w = root.get("walls")?.as_array()?.iter().find(|w| id_of(w) == Some(host))?;
    let axis = Axis::of(w)?;
    let width = num_of(field(o, "width"));
    let from = num_of(field(o, "position"));
    let me = id_of(o).unwrap_or("");
    place(root, host, axis.len(), width, from.is_finite().then_some(from), want, &|id| id == me)
}

/// Neuer Anfang, wenn der Mittelpunkt-Griff von `o` nach `pt` gezogen wird (Lotfuss auf die Achse,
/// Bogenwand: nächster Punkt auf dem Bogen).
pub fn grip_want(root: &Map<String, Value>, o: &Value, pt: P) -> Option<f64> {
    let host = field(o, "hostWallId").and_then(Value::as_str)?;
    let w = root.get("walls")?.as_array()?.iter().find(|w| id_of(w) == Some(host))?;
    let axis = Axis::of(w)?;
    let t = axis.local(pt).0 - num_of(field(o, "width")) / 2.0;
    t.is_finite().then_some(t)
}

/// Punkt im Umriss lassen: ausserhalb → nächster Randpunkt, 5 cm nach innen gerückt (zum Schwerpunkt der
/// Ecken). Wie `clampInside` (`src/plan/surfaceOpening.ts`, Griff-Zug der Dach-/Deckenöffnung).
pub fn clamp_inside(p: P, ring: &[P]) -> P {
    if ring.len() < 3 {
        return p;
    }
    let mut inside = false;
    let mut j = ring.len() - 1;
    for i in 0..ring.len() {
        let (a, b) = (ring[i], ring[j]);
        if (a.1 > p.1) != (b.1 > p.1) && p.0 < (b.0 - a.0) * (p.1 - a.1) / (b.1 - a.1) + a.0 {
            inside = !inside;
        }
        j = i;
    }
    if inside {
        return p;
    }
    let mut best = ring[0];
    let mut best_d = f64::INFINITY;
    for i in 0..ring.len() {
        let (a, b) = (ring[i], ring[(i + 1) % ring.len()]);
        let (dx, dy) = (b.0 - a.0, b.1 - a.1);
        let l2 = dx * dx + dy * dy;
        let t = if l2 > 0.0 { (((p.0 - a.0) * dx + (p.1 - a.1) * dy) / l2).clamp(0.0, 1.0) } else { 0.0 };
        let q = (a.0 + dx * t, a.1 + dy * t);
        let dd = (q.0 - p.0).powi(2) + (q.1 - p.1).powi(2);
        if dd < best_d {
            best_d = dd;
            best = q;
        }
    }
    let n = ring.len() as f64;
    let (cx, cy) = (ring.iter().map(|q| q.0).sum::<f64>() / n, ring.iter().map(|q| q.1).sum::<f64>() / n);
    let l = crate::jsmath::hypot2(cx - best.0, cy - best.1);
    if l > 0.05 {
        (best.0 + (cx - best.0) / l * 0.05, best.1 + (cy - best.1) / l * 0.05)
    } else {
        best
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn root(v: Value) -> Map<String, Value> {
        v.as_object().unwrap().clone()
    }

    fn near(a: f64, b: f64) {
        assert!((a - b).abs() < 1e-9, "{a} != {b}");
    }

    /// Nachbar bei 2..3 in einer 10-m-Wand, Breite 1: gleitend hält die Öffnung mit 5 cm Steg an.
    #[test]
    fn haelt_vor_dem_nachbarn() {
        let r = root(json!({"walls":[{"id":"w","start":{"x":0,"y":0},"end":{"x":10,"y":0}}],
            "openings":[{"id":"a","hostWallId":"w","position":0,"width":1},{"id":"n","hostWallId":"w","position":2,"width":1},
                        {"id":"x","hostWallId":"w","position":2.5,"width":1}]}));
        let skip_a = |id: &str| id == "a" || id == "x";
        let p = place(&r, "w", 10.0, 1.0, Some(0.0), 5.0, &skip_a).unwrap();
        near(p.position, 0.95);
        assert!(p.clamped);
        // Frei davor: kein Anschlag.
        let p = place(&r, "w", 10.0, 1.0, Some(0.0), 0.5, &skip_a).unwrap();
        assert_eq!(p, Placed { position: 0.5, clamped: false });
        // Von rechts kommend: hält bei 3.05.
        let p = place(&r, "w", 10.0, 1.0, Some(6.0), 0.0, &skip_a).unwrap();
        near(p.position, 3.05);
        // Bestand: „x" überlappt „n" schon — beim Wegziehen kein Anschlag an „n".
        let p = place(&r, "w", 10.0, 1.0, Some(2.5), 6.0, &|id| id == "x").unwrap();
        assert_eq!(p, Placed { position: 6.0, clamped: false });
        // Ohne Ausgang (Wandwechsel): nächste freie Stelle.
        let p = place(&r, "w", 10.0, 1.0, None, 2.2, &skip_a).unwrap();
        near(p.position, 3.05);
        let p = place(&r, "w", 10.0, 1.0, None, 1.5, &skip_a).unwrap();
        near(p.position, 0.95);
        // Kein Platz: 3.2-m-Wand, Breite 2.5, Nachbar bei 2..3.
        assert!(place(&r, "w", 3.2, 2.5, None, 0.0, &skip_a).is_none());
    }

    /// Bogenwand: Lauflänge = Bogenlänge, Griff-Punkt auf dem Bogen, Klemmen am Bogenende.
    #[test]
    fn bogenwand_bogenlaenge() {
        // Halbkreis von (0,0) nach (4,0), bulge 1 → Radius 2, Länge 2π.
        let r = root(json!({"walls":[{"id":"b","start":{"x":0,"y":0},"end":{"x":4,"y":0},"bulge":1}],
            "openings":[{"id":"o","hostWallId":"b","position":1,"width":1}]}));
        let w = &r["walls"][0];
        let ax = Axis::of(w).unwrap();
        near(ax.len(), 2.0 * std::f64::consts::PI);
        let o = &r["openings"][0];
        // Scheitel (2, 2), Griff ausserhalb gezogen: Lotfuss auf dem Bogen.
        let m = ax.point(std::f64::consts::PI, 0.0);
        near(m.0, 2.0);
        near(m.1.abs(), 2.0);
        let want = grip_want(&r, o, (m.0, m.1 * 1.15)).unwrap();
        near(want, std::f64::consts::PI - 0.5);
        let p = slide_to(&r, o, 99.0).unwrap();
        near(p.position, 2.0 * std::f64::consts::PI - 1.0);
        assert_eq!(slide_to(&r, o, -3.0).unwrap().position, 0.0);
    }

    #[test]
    fn im_umriss_halten() {
        let ring = [(0.0, 0.0), (4.0, 0.0), (4.0, 4.0), (0.0, 4.0)];
        assert_eq!(clamp_inside((1.0, 1.0), &ring), (1.0, 1.0));
        let q = clamp_inside((6.0, 2.0), &ring);
        near(q.0, 3.95);
        near(q.1, 2.0);
    }
}
