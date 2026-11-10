//! Griff-Ziehen ([128]): die reine Rechnung je Mausschritt eines 2D-Griff-Zugs (vorher in
//! `src/state/useGripEditing.ts`). Die Hülle hält nur Zustand (Locks, ausstehende Züge, Vorschau) und
//! fragt hier, wohin ein Griff fällt:
//!
//! - Länge/Winkel-Eingabe (Tab-Felder): Punkt aus Anker + gelockten Werten ([`polar_point`]), Anzeige-
//!   Werte ([`polar`]);
//! - Shift-Achsen-Lock eines Eckpunkts: Welt-H/V am Nachbar-Griff plus die Flucht der beiden fixen
//!   Nachbarkanten ([`axis_lock`]);
//! - Kanten-Griff: geführte Kante (nur entlang der Aussennormale, Raster/Geometrie-Snap) bzw. freie Kante
//!   (Ortho, Raster), mit oder ohne gelockte Felder ([`edge_target`]);
//! - Höhen-Griffe im Schnitt (Wand-Oberkante, Fenster Ober-/Unterkante, [`sheet_height`]);
//! - Öffnung entlang der Wirtswand ([`opening_slide_sheet`]; der Griff-Zug selbst: `crate::opening_slide`), Griff-Lagen von
//!   Öffnung, Treppe, Bogenwand und Baugrube;
//! - koinzidente Ecken anderer gewählter Elemente beim Körper-Verschieben ([`coincident`]).
//!
//! Zahlen wie in JS (`jsnum`: min/max/round, Trigonometrie über libm); NaN steht für „fehlt".

use crate::jsmath::hypot2;
use crate::jsnum;
use std::f64::consts::PI;

pub type P = (f64, f64);

fn sub(a: P, b: P) -> P {
    (a.0 - b.0, a.1 - b.1)
}

fn add(a: P, b: P) -> P {
    (a.0 + b.0, a.1 + b.1)
}

fn scale(a: P, s: f64) -> P {
    (a.0 * s, a.1 * s)
}

fn dot(a: P, b: P) -> f64 {
    a.0 * b.0 + a.1 * b.1
}

/// `normalize` aus `model/geometry.ts`: Nullvektor bleibt null (Länge 0 → 1).
fn normalize(a: P) -> P {
    let l = hypot2(a.0, a.1);
    let l = if l == 0.0 || l.is_nan() { 1.0 } else { l };
    (a.0 / l, a.1 / l)
}

/// Winkel in Grad (−180, 180] wie `Math.atan2(dy, dx) * 180 / Math.PI`.
fn deg(dx: f64, dy: f64) -> f64 {
    (jsnum::atan2(dy, dx) * 180.0) / PI
}

/// Länge, Winkel (Grad, [0, 360)) und Abstand entlang `normal` von `anchor` nach `p` (Felder, Cursor-HUD).
pub fn polar(anchor: P, p: P, normal: P) -> (f64, f64, f64) {
    let (dx, dy) = sub(p, anchor);
    let ang = ((deg(dx, dy) % 360.0) + 360.0) % 360.0;
    (hypot2(dx, dy), ang, dx * normal.0 + dy * normal.1)
}

/// Punkt aus Anker + Länge/Winkel (Grad); ungelockte Werte (`None`) folgen dem rohen Cursor `raw`.
pub fn polar_point(anchor: P, length: Option<f64>, angle: Option<f64>, raw: P) -> P {
    let (dx, dy) = sub(raw, anchor);
    let length = length.unwrap_or_else(|| hypot2(dx, dy));
    let a = angle.unwrap_or_else(|| deg(dx, dy)) * (PI / 180.0);
    (anchor.0 + jsnum::cos(a) * length, anchor.1 + jsnum::sin(a) * length)
}

/// Die fixen Polygon-Nachbarn des Punkts `i` eines Rings (`closed`) bzw. einer Kette: (vorher, nachher).
pub fn ring_neighbors(n: usize, i: usize, closed: bool) -> (Option<usize>, Option<usize>) {
    let prev = if i > 0 { Some(i - 1) } else if closed && n > 0 { Some(n - 1) } else { None };
    let next = if i + 1 < n { Some(i + 1) } else if closed { Some(0) } else { None };
    let prev = prev.filter(|&p| p != i);
    let next = next.filter(|&q| q != i && Some(q) != prev);
    (prev, next)
}

/// `raw` auf die nächstliegende Achse (Stützpunkt, Richtung) projizieren; entartete Richtungen zählen nicht.
fn closest_axis_point(raw: P, candidates: &[(P, P)]) -> Option<P> {
    let mut best = None;
    let mut best_dist = f64::INFINITY;
    for &(point, dir) in candidates {
        let len = hypot2(dir.0, dir.1);
        if len < 1e-9 {
            continue;
        }
        let u = (dir.0 / len, dir.1 / len);
        let rel = sub(raw, point);
        let t = rel.0 * u.0 + rel.1 * u.1;
        let proj = add(point, scale(u, t));
        let dist = hypot2(raw.0 - proj.0, raw.1 - proj.1);
        if dist < best_dist {
            best_dist = dist;
            best = Some(proj);
        }
    }
    best
}

/// Shift-Achsen-Lock eines gezogenen Punkt-Griffs: Welt-H/V durch den Nachbar-Griff `anchor` und — bei einem
/// Vielecks-Eckpunkt (`ring` = Punkte des Elements, `index` = gezogener Punkt, `origin` = Lage vor dem Zug) —
/// die Flucht der beiden fixen Nachbarkanten in ihrer ursprünglichen Richtung. Die nächstliegende Achse gewinnt.
pub fn axis_lock(raw: P, anchor: P, origin: Option<P>, ring: &[P], index: usize, closed: bool) -> P {
    let mut c = vec![(anchor, (1.0, 0.0)), (anchor, (0.0, 1.0))];
    if let Some(o) = origin {
        if index < ring.len() {
            let (prev, next) = ring_neighbors(ring.len(), index, closed);
            if let Some(p) = prev.map(|k| ring[k]) {
                c.push((p, sub(o, p)));
            }
            if let Some(q) = next.map(|k| ring[k]) {
                c.push((q, sub(q, o)));
            }
        }
    }
    // H/V sind nie entartet: es gibt immer einen Treffer.
    closest_axis_point(raw, &c).unwrap_or(raw)
}

/// Kanten-Griff (Mitte `mid` beim Grab, Aussennormale `normal`; `free` = offene Kette).
#[derive(Clone, Copy, Debug)]
pub struct Edge {
    pub mid: P,
    pub normal: P,
    pub free: bool,
}

/// Wie die Maus/Tastatur einen Kanten-Griff führt.
#[derive(Clone, Copy, Debug, Default)]
pub struct EdgeDrive {
    /// Feld-Controller offen: Ziel aus Anker + Locks (fehlende Werte folgen dem Cursor), ohne Raster/Ortho.
    pub locked: bool,
    pub length: Option<f64>,
    pub angle: Option<f64>,
    pub shift: bool,
    /// Rasterweite (0 = kein Raster).
    pub grid: f64,
    /// Gefangener Geometrie-Snap (nur geführte Kanten).
    pub snapped: Option<P>,
}

/// Zielpunkt eines Kanten-Zugs relativ zum Anker `edge.mid`. Geführt: nur die Komponente entlang der
/// Normale (Geometrie-Snap vor Raster); frei: voller Cursor, Shift = Ortho zum Anker, Raster auf das Delta.
pub fn edge_target(edge: Edge, raw: P, d: EdgeDrive) -> P {
    let anchor = edge.mid;
    if d.locked {
        if edge.free {
            return polar_point(anchor, d.length, d.angle, raw);
        }
        let len = d.length.unwrap_or_else(|| dot(sub(raw, anchor), edge.normal));
        return add(anchor, scale(edge.normal, len));
    }
    let gs = d.grid;
    if edge.free {
        let mut pt = raw;
        if d.shift {
            let (dx, dy) = sub(raw, anchor);
            pt = if dx.abs() >= dy.abs() { (raw.0, anchor.1) } else { (anchor.0, raw.1) };
        }
        if gs > 0.0 {
            let dx = jsnum::round((pt.0 - anchor.0) / gs) * gs;
            let dy = jsnum::round((pt.1 - anchor.1) / gs) * gs;
            pt = (anchor.0 + dx, anchor.1 + dy);
        }
        return pt;
    }
    let cursor = d.snapped.unwrap_or(raw);
    let rel = sub(cursor, anchor);
    let mut offset = rel.0 * edge.normal.0 + rel.1 * edge.normal.1;
    if d.snapped.is_none() && gs > 0.0 {
        offset = jsnum::round(offset / gs) * gs;
    }
    add(anchor, scale(edge.normal, offset))
}

/// Art eines Höhen-Griffs im Schnitt/in der Ansicht.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum HeightGrip {
    WallTop,
    OpeningTop,
    OpeningBottom,
}

/// Ergebnis eines Höhen-Griff-Zugs: neue Ober-/Unterkante im Blatt und die Werte fürs Bauteil
/// (Wand/Öffnung `height`; Fenster-Unterkante zusätzlich `sill_height`), auf mm gerundet.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct HeightDrag {
    pub top: f64,
    pub bottom: f64,
    pub height: f64,
    pub sill_height: Option<f64>,
}

/// Höhen-Griff auf die Blatt-Höhe `y` ziehen (1-cm-Raster, `free` = Strg ohne Raster). `base` = Geschoss-
/// Höhe, `top`/`bottom` = heutige Ober-/Unterkante im Blatt. Mindestmasse: Wand 0.30 m, Öffnung 0.20 m.
pub fn sheet_height(kind: HeightGrip, base: f64, top: f64, bottom: f64, y: f64, free: bool) -> HeightDrag {
    let v = if free { y } else { jsnum::round(y * 100.0) / 100.0 };
    let mm = |x: f64| jsnum::round(x * 1000.0) / 1000.0;
    match kind {
        HeightGrip::WallTop => {
            let t = jsnum::max(base + 0.3, v);
            HeightDrag { top: t, bottom, height: mm(t - base), sill_height: None }
        }
        HeightGrip::OpeningTop => {
            let t = jsnum::max(bottom + 0.2, v);
            HeightDrag { top: t, bottom, height: mm(t - bottom), sill_height: None }
        }
        HeightGrip::OpeningBottom => {
            let b = jsnum::min(top - 0.2, jsnum::max(base, v));
            HeightDrag { top, bottom: b, height: mm(top - b), sill_height: Some(mm(b - base)) }
        }
    }
}

/// Mittelpunkt-Griff einer Öffnung (Breite `width`, `position` = Abstand des ersten Pfostens) auf der Wandachse.
pub fn opening_wall_grip(ws: P, we: P, bulge: f64, position: f64, width: f64) -> P {
    // Bogenwand ([T2], [144]): Punkt auf dem Bogen bei der Bogenlänge der Öffnungsmitte.
    if let Some(a) = crate::wall_arc::WallArc::of(kernel2d::Vec2::new(ws.0, ws.1), kernel2d::Vec2::new(we.0, we.1), Some(bulge)) {
        let q = a.point(position + width / 2.0, 0.0);
        return (q.x, q.y);
    }
    add(ws, scale(normalize(sub(we, ws)), position + width / 2.0))
}

/// [T2] Endpunkt einer Bogenwand entlang des Kreises ziehen: Mittelpunkt und Achsradius bleiben, das
/// andere Ende bleibt stehen. `index` 0 = Start, 1 = Ende; `target` wird auf den Kreis projiziert, der
/// Öffnungswinkel zwischen den zwei möglichen Bögen so gewählt, dass er dem bisherigen am nächsten
/// liegt (stetig beim Ziehen). Ergebnis `(neuer Start, neues Ende, neuer Bulge)`; `None` bei Unsinn,
/// Ziel im Mittelpunkt oder ohne Bogen.
pub fn arc_wall_endpoint(s: P, e: P, bulge: f64, index: usize, target: P) -> Option<(P, P, f64)> {
    let a = crate::wall_arc::WallArc::of(kernel2d::Vec2::new(s.0, s.1), kernel2d::Vec2::new(e.0, e.1), Some(bulge))?;
    let (c, r) = ((a.center.x, a.center.y), a.r);
    let th = arc_angle_of(c, target)?;
    let (a1, tau) = (a.a0 + a.sweep, 2.0 * PI);
    // Fester Winkel F und Richtung: Start bewegt → Sweep läuft von th nach a1; Ende bewegt → von a0 nach th.
    let sweep = if index == 0 { nearest_sweep(a1 - th, a.sweep, tau) } else { nearest_sweep(th - a.a0, a.sweep, tau) };
    if sweep.abs() < 1e-6 || sweep.abs() > tau - 1e-6 {
        return None;
    }
    let at = |ang: f64| (c.0 + r * jsnum::cos(ang), c.1 + r * jsnum::sin(ang));
    let (ns, ne) = if index == 0 { (at(th), e) } else { (s, at(th)) };
    let nb = -jsnum::tan(sweep / 4.0);
    (nb.is_finite()).then_some((ns, ne, nb))
}

fn arc_angle_of(c: P, p: P) -> Option<f64> {
    let (dx, dy) = (p.0 - c.0, p.1 - c.1);
    (dx.is_finite() && dy.is_finite() && hypot2(dx, dy) > 1e-9).then(|| jsnum::atan2(dy, dx))
}

/// Von den zwei Bögen mit Winkel `d` (mod 2π) — `d` in (0, 2π) CCW bzw. `d − 2π` CW — der dem `old` nächste.
fn nearest_sweep(d: f64, old: f64, tau: f64) -> f64 {
    let m = ((d % tau) + tau) % tau;
    let (ccw, cw) = (m, m - tau);
    if (ccw - old).abs() <= (cw - old).abs() { ccw } else { cw }
}

/// [T2] Zielpunkt eines Endpunkt-Griffs der Bogenwand samt Bogenlänge der Wand danach: mit `length` (Tab)
/// der Punkt dieser Bogenlänge vom festen Ende ([`arc_wall_point_at_length`]), sonst der auf den Kreis
/// projizierte Cursor `raw`. `None` bei Unsinn.
pub fn arc_wall_grip_target(s: P, e: P, bulge: f64, index: usize, length: Option<f64>, raw: P) -> Option<(P, f64)> {
    let p = match length {
        Some(l) => arc_wall_point_at_length(s, e, bulge, index, l, raw)?,
        None => raw,
    };
    let (ns, ne, nb) = arc_wall_endpoint(s, e, bulge, index, p)?;
    let a = crate::wall_arc::WallArc::of(kernel2d::Vec2::new(ns.0, ns.1), kernel2d::Vec2::new(ne.0, ne.1), Some(nb))?;
    Some((if index == 0 { ns } else { ne }, a.length()))
}

/// [T2] Bogenlängen-Eingabe (Tab) am Endpunkt einer Bogenwand: der Punkt, der `length` (Bogenlänge,
/// Meter) vom festen Ende entfernt auf dem Kreis liegt, auf der Seite des Cursors `raw` (am Fixpunkt:
/// Laufrichtung des bisherigen Bogens). `None` bei Unsinn oder `length` ≤ 0 bzw. ≥ Vollkreis.
pub fn arc_wall_point_at_length(s: P, e: P, bulge: f64, index: usize, length: f64, raw: P) -> Option<P> {
    let a = crate::wall_arc::WallArc::of(kernel2d::Vec2::new(s.0, s.1), kernel2d::Vec2::new(e.0, e.1), Some(bulge))?;
    let (c, r) = ((a.center.x, a.center.y), a.r);
    let tau = 2.0 * PI;
    if !(length.is_finite() && length > 0.0 && length / r < tau - 1e-6) {
        return None;
    }
    let (fixed_angle, run_dir) = if index == 0 { (a.a0 + a.sweep, -a.sigma()) } else { (a.a0, a.sigma()) };
    let side = match arc_angle_of(c, raw) {
        Some(t) => {
            let mut d = (t - fixed_angle) % tau;
            if d > PI { d -= tau } else if d <= -PI { d += tau }
            if d.abs() < 1e-9 { run_dir } else { d.signum() }
        }
        None => run_dir,
    };
    let ang = fixed_angle + side * length / r;
    Some((c.0 + r * jsnum::cos(ang), c.1 + r * jsnum::sin(ang)))
}

/// [T2] Radius-Griff (Scheitel) einer Bogenwand mit festem Mittelpunkt: der Mittelpunkt und der Öffnungswinkel
/// (Bulge) bleiben, der Radius wird der Abstand `target` – Mittelpunkt; Start und Ende wandern radial mit.
/// Ergebnis `(neuer Start, neues Ende)`; `None` bei Unsinn, Ziel im Mittelpunkt (Radius < 1 mm) oder ohne Bogen.
pub fn arc_wall_radius_fixed_center(s: P, e: P, bulge: f64, target: P) -> Option<(P, P)> {
    let a = crate::wall_arc::WallArc::of(kernel2d::Vec2::new(s.0, s.1), kernel2d::Vec2::new(e.0, e.1), Some(bulge))?;
    let c = (a.center.x, a.center.y);
    let r = hypot2(target.0 - c.0, target.1 - c.1);
    if !(r.is_finite() && r > 1e-3) {
        return None;
    }
    let at = |ang: f64| (c.0 + r * jsnum::cos(ang), c.1 + r * jsnum::sin(ang));
    Some((at(a.a0), at(a.a0 + a.sweep)))
}

/// [T2] Zielpunkt des Scheitel-Griffs einer Bogenwand samt Radius der Wand danach. Mit `fixed_center` (Shift):
/// Punkt auf dem Strahl Mittelpunkt → Cursor `raw` im Abstand `radius` (getippt, sonst der Cursor-Abstand);
/// Ziehen mit [`arc_wall_radius_fixed_center`]. Sonst (Endpunkte fest): ohne `radius` der Cursor selbst, mit
/// `radius` der Scheitel des Bogens dieses Radius über der Sehne, auf der Seite des Cursors (liegt der Cursor
/// weiter als `radius` von der Sehne entfernt, der Grossbogen, sonst der Kleinbogen). `None` bei Unsinn, bei
/// `radius` unter der halben Sehne oder bei gerader Wand.
pub fn arc_wall_radius_target(s: P, e: P, bulge: f64, fixed_center: bool, radius: Option<f64>, raw: P) -> Option<(P, f64)> {
    let a = crate::wall_arc::WallArc::of(kernel2d::Vec2::new(s.0, s.1), kernel2d::Vec2::new(e.0, e.1), Some(bulge))?;
    if !(raw.0.is_finite() && raw.1.is_finite()) || radius.is_some_and(|r| !(r.is_finite() && r > 1e-3)) {
        return None;
    }
    let c = (a.center.x, a.center.y);
    if fixed_center {
        let d = sub(raw, c);
        let l = hypot2(d.0, d.1);
        // Cursor im Mittelpunkt: Richtung des bisherigen Scheitels.
        let dir = if l > 1e-9 { scale(d, 1.0 / l) } else { let am = a.a0 + a.sweep / 2.0; (jsnum::cos(am), jsnum::sin(am)) };
        let r = radius.unwrap_or(l);
        return (r > 1e-3).then(|| (add(c, scale(dir, r)), r));
    }
    let Some(r) = radius else {
        let b = crate::bulge::from_sagitta_point(s.0, s.1, e.0, e.1, raw.0, raw.1);
        let na = crate::wall_arc::WallArc::of(kernel2d::Vec2::new(s.0, s.1), kernel2d::Vec2::new(e.0, e.1), Some(b))?;
        return Some((raw, na.r));
    };
    let (d, mid) = (sub(e, s), scale(add(s, e), 0.5));
    let hc = hypot2(d.0, d.1) / 2.0;
    if r < hc - 1e-9 {
        return None;
    }
    let n = normalize((-d.1, d.0));
    let dist = dot(sub(raw, mid), n);
    let side = if dist.abs() > 1e-9 { dist.signum() } else if bulge >= 0.0 { 1.0 } else { -1.0 };
    let root = (r * r - hc * hc).max(0.0).sqrt();
    let h = if dist.abs() > r { r + root } else { r - root };
    Some((add(mid, scale(n, side * h)), r))
}

/// Öffnung im Schnitt-Blatt waagrecht ziehen: Blatt-Delta `du` (gesamt, entlang der Schnitt-Achse `u_axis`)
/// → neue `position` (geklemmt) und das dazu passende, tatsächlich wirksame Blatt-Delta. `None`, wenn die
/// Wand fast quer zur Schnittlinie steht (|u · Wandrichtung| < 0.15). Bogenwand ([144], `bulge`):
/// `position` = Bogenlänge; die Öffnungsmitte folgt dem Blatt-Delta auf dem Bogen (s. [`arc_slide_sheet`]).
pub fn opening_slide_sheet(ws: P, we: P, bulge: f64, u_axis: P, position: f64, width: f64, du: f64) -> Option<(f64, f64)> {
    if let Some(a) = crate::wall_arc::WallArc::of(kernel2d::Vec2::new(ws.0, ws.1), kernel2d::Vec2::new(we.0, we.1), Some(bulge)) {
        return arc_slide_sheet(&a, u_axis, position, width, du);
    }
    let axis = normalize(sub(we, ws));
    let factor = dot(u_axis, axis);
    if factor.abs() < 0.15 {
        return None;
    }
    let len = hypot2(we.0 - ws.0, we.1 - ws.1);
    let pos = jsnum::max(0.0, jsnum::min(len - width, position + du * factor));
    Some((pos, (pos - position) / factor))
}

/// [144] Öffnung in einer Bogenwand im Schnitt-Blatt ziehen: Blatt-Lage der Öffnungsmitte
/// u(p) = (Bogenpunkt bei p + Breite/2) · `u_axis`; gesucht ist die Lage p ∈ [0, Bogenlänge − Breite]
/// mit u(p) = u(position) + `du`, die `position` am nächsten liegt (Abtasten + Halbieren). Ohne Lösung
/// (Ziel jenseits der Blatt-Ausdehnung des Bogens) die Lage mit der kleinsten Abweichung. `None`, wenn
/// der Bogen im Blatt keine Ausdehnung hat oder die Öffnung nicht hineinpasst.
fn arc_slide_sheet(a: &crate::wall_arc::WallArc, u: P, position: f64, width: f64, du: f64) -> Option<(f64, f64)> {
    let hi = a.length() - width;
    if !(hi >= 0.0) || !hi.is_finite() || ![u.0, u.1, position, width, du].iter().all(|v| v.is_finite()) {
        return None;
    }
    let u_at = |p: f64| {
        let q = a.point(p + width / 2.0, 0.0);
        q.x * u.0 + q.y * u.1
    };
    let p0 = position.clamp(0.0, hi);
    if du == 0.0 {
        return Some((p0, 0.0));
    }
    let target = u_at(p0) + du;
    const N: usize = 256;
    let ps: Vec<f64> = (0..=N).map(|i| hi * i as f64 / N as f64).collect();
    let fs: Vec<f64> = ps.iter().map(|&p| u_at(p) - target).collect();
    let (lo_u, hi_u) = fs.iter().fold((f64::INFINITY, f64::NEG_INFINITY), |m, f| (m.0.min(*f), m.1.max(*f)));
    if !(hi_u - lo_u > 1e-6) {
        return None;
    }
    let mut best: Option<f64> = None;
    for i in 0..N {
        let (f0, f1) = (fs[i], fs[i + 1]);
        if f0 == 0.0 || (f0 < 0.0) != (f1 < 0.0) {
            let (mut l, mut r, mut fl) = (ps[i], ps[i + 1], f0);
            for _ in 0..50 {
                let m = 0.5 * (l + r);
                let fm = u_at(m) - target;
                if (fm < 0.0) == (fl < 0.0) && fm != 0.0 {
                    l = m;
                    fl = fm;
                } else {
                    r = m;
                }
            }
            let root = if f0 == 0.0 { ps[i] } else { 0.5 * (l + r) };
            if best.is_none_or(|b| (root - p0).abs() < (b - p0).abs()) {
                best = Some(root);
            }
        }
    }
    if fs[N] == 0.0 && best.is_none_or(|b| (hi - p0).abs() < (b - p0).abs()) {
        best = Some(hi);
    }
    let pos = best.unwrap_or_else(|| {
        // Keine Lösung: kleinste Abweichung, bei Gleichstand die nähere Lage.
        let mut j = 0;
        for i in 1..=N {
            if fs[i].abs() < fs[j].abs() - 1e-12 || ((fs[i].abs() - fs[j].abs()).abs() <= 1e-12 && (ps[i] - p0).abs() < (ps[j] - p0).abs()) {
                j = i;
            }
        }
        ps[j]
    });
    Some((pos, u_at(pos) - u_at(p0)))
}

/// Bewegpunkt einer Treppe: Wendeltreppe im Zentrum (sonst Start), sonst Mitte des ersten Laufs.
pub fn stair_handle(spiral: bool, center: Option<P>, start: P, dir: P, run_length: f64) -> P {
    if spiral {
        return center.unwrap_or(start);
    }
    add(start, scale(normalize(dir), run_length / 2.0))
}

/// [151] Lauf-Achsen einer Podesttreppe (L, U, gerade mit Podest) aus den Treppen-Parametern (`stair.rs`):
/// Antritt-Mitte, Laufrichtung, linke Normale, Geometrie und Index des ersten Tritts im letzten Lauf.
fn flight_frame(params: &[f64]) -> Option<(P, P, P, kernel2d::StairGeometry, usize, String)> {
    let sp = crate::stair::decode_params(params)?;
    if !matches!(sp.shape.as_str(), "L" | "U" | "straightLanding") {
        return None;
    }
    let g = kernel2d::stair_geometry(&sp, 1.0);
    let tr = &g.treads;
    if tr.len() < 2 || tr.iter().any(|t| t.pts.len() < 4) {
        return None;
    }
    let last_run = (1..tr.len()).rev().find(|&k| tr[k].index != tr[k - 1].index + 1)?;
    let p = |v: kernel2d::Vec2| (v.x, v.y);
    let f = &tr[0].pts;
    let b = scale(add(p(f[0]), p(f[3])), 0.5);
    let u = normalize(sub(p(f[1]), p(f[0])));
    Some((b, u, (-u.1, u.0), g, last_run, sp.shape))
}

/// [151] Parameter-Griffe einer Podesttreppe: Ende des ersten Laufs, Ende des letzten Laufs, bei U und
/// gerade mit Podest der Podestrand (Mitte). Andere Formen: keine.
pub fn stair_param_points(params: &[f64]) -> Vec<P> {
    let Some((b, u, n, g, last_run, shape)) = flight_frame(params) else { return Vec::new() };
    let p = |v: kernel2d::Vec2| (v.x, v.y);
    let tr = &g.treads;
    let end_of = |k: usize| scale(add(p(tr[k].pts[1]), p(tr[k].pts[2])), 0.5);
    let run1_last = (1..tr.len()).find(|&k| tr[k].index != tr[k - 1].index + 1).map_or(0, |k| k - 1);
    let mut out = vec![end_of(run1_last), end_of(tr.len() - 1)];
    if shape != "L" {
        let far = g.landing.iter().chain(g.landing2.iter()).flatten().map(|q| dot(sub(p(*q), b), u)).fold(f64::NEG_INFINITY, f64::max);
        let front = scale(add(p(tr[last_run].pts[0]), p(tr[last_run].pts[3])), 0.5);
        let across = dot(sub(front, b), n) / 2.0;
        out.push(add(add(b, scale(u, far)), scale(n, across)));
    }
    out
}

/// [151] Parameter-Griff `index` (s. [`stair_param_points`]) nach `pt` ziehen: neue Feldwerte. Ende Lauf 1 →
/// `runLength`; Ende letzter Lauf → `run2Length` (U: zusätzlich quer `gap` und `turn`); Podestrand →
/// `landingLength`. Längen mindestens 0.3 m.
pub fn stair_param_drag(params: &[f64], index: usize, pt: P) -> Vec<(&'static str, f64)> {
    let Some((b, u, n, g, last_run, shape)) = flight_frame(params) else { return Vec::new() };
    if !(pt.0.is_finite() && pt.1.is_finite()) {
        return Vec::new();
    }
    let p = |v: kernel2d::Vec2| (v.x, v.y);
    let tr = &g.treads;
    let run1 = params.get(5).copied().unwrap_or(0.0);
    match index {
        0 => vec![("runLength", jsnum::max(0.3, dot(sub(pt, b), u)))],
        1 => {
            let f = &tr[last_run].pts;
            let s2 = scale(add(p(f[0]), p(f[3])), 0.5);
            let u2 = normalize(sub(p(f[1]), p(f[0])));
            let mut out = vec![("run2Length", jsnum::max(0.3, dot(sub(pt, s2), u2)))];
            if shape == "U" {
                let v = dot(sub(pt, b), n);
                let w = params.get(12).copied().unwrap_or(1.0);
                out.push(("turn", if v < 0.0 { -1.0 } else { 1.0 }));
                out.push(("gap", jsnum::max(0.0, v.abs() - w)));
            }
            out
        }
        2 if shape != "L" => vec![("landingLength", jsnum::max(0.3, dot(sub(pt, b), u) - run1))],
        _ => Vec::new(),
    }
}

/// Griffe einer Wand: Start, Ende und bei einer Bogenwand ([T2]) der Bogenscheitel (Pfeilhöhe = halbe
/// Sehne · bulge, links der Sehne).
pub fn wall_grips(s: P, e: P, bulge: f64) -> Vec<P> {
    if bulge == 0.0 || bulge.is_nan() {
        return vec![s, e];
    }
    let h = hypot2(e.0 - s.0, e.1 - s.1) / 2.0;
    let d = sub(e, s);
    let apex = add(scale(add(s, e), 0.5), scale(normalize((-d.1, d.0)), h * bulge));
    vec![s, e, apex]
}

/// [68] Griffe einer Baugrube: Umriss-Ecken, dann der Sohlen-Griff (Eckpunkt-Mittel, y + Sohlenhöhe).
pub fn excavation_grips(outline: &[P], bottom: f64) -> Vec<P> {
    let n = outline.len().max(1) as f64;
    let cx = outline.iter().fold(0.0, |a, q| a + q.0) / n;
    let cy = outline.iter().fold(0.0, |a, q| a + q.1) / n;
    let mut out = outline.to_vec();
    out.push((cx, cy + bottom));
    out
}

/// Toleranz für gemeinsame Ecken beim Körper-Verschieben (m, wie beim 3D-Zug).
pub const COINCIDENT_TOL: f64 = 0.05;

/// Koinzidente Punkte anderer gewählter Elemente (`groups`, je Element seine Griff-Punkte) an jeder Ecke
/// (`corners`) des verschobenen Elements: (Element, Punkt) in der Reihenfolge Ecke → Element → Punkt,
/// jeder Punkt höchstens einmal.
pub fn coincident(corners: &[P], groups: &[Vec<P>]) -> Vec<(usize, usize)> {
    let mut out: Vec<(usize, usize)> = Vec::new();
    for c in corners {
        for (g, pts) in groups.iter().enumerate() {
            for (i, q) in pts.iter().enumerate() {
                if hypot2(c.0 - q.0, c.1 - q.1) <= COINCIDENT_TOL && !out.contains(&(g, i)) {
                    out.push((g, i));
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn treppen_parameter_griffe() {
        // U: Start (0,0) +x, Läufe 3 m, Linkswendung, Breite 1, Auge 0.2, 17 Steigungen
        let nan = f64::NAN;
        let u = [3.0, 0.0, 0.0, 1.0, 0.0, 3.0, 3.0, 1.0, nan, nan, nan, nan, 1.0, 17.0, nan, 0.0, 0.2, nan, nan, nan, nan];
        let g = stair_param_points(&u);
        assert_eq!(g.len(), 3);
        assert!((g[0].0 - 3.0).abs() < 1e-9 && g[0].1.abs() < 1e-9, "{g:?}");
        assert!(g[1].0.abs() < 1e-9 && (g[1].1 - 1.2).abs() < 1e-9, "{g:?}");
        assert!((g[2].0 - 4.0).abs() < 1e-9 && (g[2].1 - 0.6).abs() < 1e-9, "{g:?}");
        assert_eq!(stair_param_drag(&u, 0, (3.5, 0.3)), vec![("runLength", 3.5)]);
        let d = stair_param_drag(&u, 1, (0.5, -1.5));
        assert!((d[0].1 - 2.5).abs() < 1e-9 && d[1] == ("turn", -1.0) && (d[2].1 - 0.5).abs() < 1e-9, "{d:?}");
        assert_eq!(stair_param_drag(&u, 2, (4.5, 0.0)), vec![("landingLength", 1.5)]);
        // Gerade Treppe: keine Parameter-Griffe; Unsinn: nichts
        let mut s = u;
        s[0] = 0.0;
        assert!(stair_param_points(&s).is_empty() && stair_param_drag(&s, 0, (1.0, 1.0)).is_empty());
        assert!(stair_param_drag(&u, 0, (nan, 0.0)).is_empty() && stair_param_drag(&u, 7, (1.0, 1.0)).is_empty());
        assert!(stair_param_points(&[1.0]).is_empty());
        // L: zwei Griffe (kein Podestrand)
        let mut l = u;
        l[0] = 1.0;
        assert_eq!(stair_param_points(&l).len(), 2);
    }

    fn close(a: P, b: P) -> bool {
        (a.0 - b.0).abs() < 1e-12 && (a.1 - b.1).abs() < 1e-12
    }

    #[test]
    fn polar_werte() {
        let (l, a, o) = polar((1.0, 1.0), (1.0, 3.0), (0.0, 1.0));
        assert_eq!((l, a, o), (2.0, 90.0, 2.0));
        // Winkel immer in [0, 360).
        assert_eq!(polar((0.0, 0.0), (0.0, -1.0), (1.0, 0.0)).1, 270.0);
        assert_eq!(polar((0.0, 0.0), (-1.0, -0.0), (1.0, 0.0)).1, 180.0);
    }

    #[test]
    fn polar_punkt_mit_und_ohne_lock() {
        // Beide gelockt: Cursor zählt nicht.
        assert!(close(polar_point((1.0, 0.0), Some(2.0), Some(90.0), (9.0, 9.0)), (1.0, 2.0)));
        // Nur Länge gelockt: Richtung vom Cursor.
        assert!(close(polar_point((0.0, 0.0), Some(5.0), None, (3.0, 0.0)), (5.0, 0.0)));
        // Nur Winkel gelockt: Länge vom Cursor.
        assert!(close(polar_point((0.0, 0.0), None, Some(180.0), (0.0, 2.0)), (-2.0, 0.0)));
        // Nichts gelockt: der Cursor selbst.
        assert!(close(polar_point((0.0, 0.0), None, None, (0.3, -0.4)), (0.3, -0.4)));
    }

    #[test]
    fn nachbarn_ring_und_kette() {
        assert_eq!(ring_neighbors(4, 0, true), (Some(3), Some(1)));
        assert_eq!(ring_neighbors(4, 3, true), (Some(2), Some(0)));
        assert_eq!(ring_neighbors(4, 0, false), (None, Some(1)));
        assert_eq!(ring_neighbors(4, 3, false), (Some(2), None));
        // Zweipunkt-Ring: der zweite Nachbar wäre derselbe Punkt.
        assert_eq!(ring_neighbors(2, 0, true), (Some(1), None));
        assert_eq!(ring_neighbors(1, 0, true), (None, None));
    }

    #[test]
    fn achsen_lock_welt_und_flucht() {
        // Ohne Ring: Welt-H/V durch den Anker.
        assert!(close(axis_lock((3.0, 0.4), (0.0, 0.0), None, &[], 0, false), (3.0, 0.0)));
        assert!(close(axis_lock((0.2, 3.0), (0.0, 0.0), None, &[], 0, false), (0.0, 3.0)));
        // Schräge Nachbarkante (0,0)→(1,1), Eckpunkt 1 vorher bei (1,1): Flucht der Kante gewinnt.
        let ring = [(0.0, 0.0), (1.0, 1.0), (1.0, 3.0)];
        let p = axis_lock((2.1, 1.9), (0.0, 0.0), Some((1.0, 1.0)), &ring, 1, false);
        assert!(close(p, (2.0, 2.0)), "{p:?}");
        // Koinzidenter Nachbar (Richtung null) wird übersprungen.
        let ring = [(1.0, 1.0), (1.0, 1.0)];
        assert!(close(axis_lock((3.0, 0.4), (0.0, 0.0), Some((1.0, 1.0)), &ring, 1, false), (3.0, 0.0)));
    }

    #[test]
    fn kante_gefuehrt_raster_und_snap() {
        let e = Edge { mid: (0.0, 0.0), normal: (0.0, 1.0), free: false };
        // Nur die Normalen-Komponente zählt, Raster 0.5.
        let p = edge_target(e, (7.0, 1.3), EdgeDrive { grid: 0.5, ..Default::default() });
        assert!(close(p, (0.0, 1.5)));
        // Geometrie-Snap gewinnt vor dem Raster.
        let p = edge_target(e, (7.0, 1.3), EdgeDrive { grid: 0.5, snapped: Some((2.0, 1.27)), ..Default::default() });
        assert!(close(p, (0.0, 1.27)));
        // Gelockt: der Feldwert, ohne Raster.
        let p = edge_target(e, (7.0, 1.3), EdgeDrive { locked: true, length: Some(0.25), grid: 0.5, ..Default::default() });
        assert!(close(p, (0.0, 0.25)));
        // Gelockt ohne Wert: live entlang der Normale.
        let p = edge_target(e, (7.0, 1.3), EdgeDrive { locked: true, ..Default::default() });
        assert!(close(p, (0.0, 1.3)));
    }

    #[test]
    fn kante_frei_ortho_und_raster() {
        let e = Edge { mid: (1.0, 1.0), normal: (0.0, 1.0), free: true };
        let p = edge_target(e, (3.2, 1.4), EdgeDrive { shift: true, ..Default::default() });
        assert!(close(p, (3.2, 1.0)));
        let p = edge_target(e, (3.2, 1.4), EdgeDrive { grid: 1.0, ..Default::default() });
        assert!(close(p, (3.0, 1.0)));
        let p = edge_target(e, (3.2, 1.4), EdgeDrive { locked: true, length: Some(2.0), angle: Some(0.0), ..Default::default() });
        assert!(close(p, (3.0, 1.0)));
    }

    #[test]
    fn hoehen_griffe() {
        // Wand: 1-cm-Raster, Mindesthöhe 0.30 über dem Geschoss.
        let r = sheet_height(HeightGrip::WallTop, 3.0, 5.6, 3.0, 5.7349, false);
        assert_eq!((r.top, r.height, r.sill_height), (5.73, 2.73, None));
        let r = sheet_height(HeightGrip::WallTop, 3.0, 5.6, 3.0, 2.0, false);
        assert_eq!(r.height, 0.3);
        // Strg: ohne Raster.
        assert_eq!(sheet_height(HeightGrip::WallTop, 0.0, 2.0, 0.0, 2.3456, true).height, 2.346);
        // Fenster oben: Mindesthöhe 0.20 über der Unterkante.
        let r = sheet_height(HeightGrip::OpeningTop, 0.0, 2.1, 0.9, 0.5, false);
        assert_eq!((r.top, r.height), (1.1, 0.2));
        // Fenster unten: zwischen Geschoss und Oberkante − 0.20, Oberkante bleibt.
        let r = sheet_height(HeightGrip::OpeningBottom, 0.0, 2.1, 0.9, 0.6, false);
        assert_eq!((r.bottom, r.top, r.sill_height, r.height), (0.6, 2.1, Some(0.6), 1.5));
        let r = sheet_height(HeightGrip::OpeningBottom, 0.0, 2.1, 0.9, -1.0, false);
        assert_eq!(r.sill_height, Some(0.0));
        let r = sheet_height(HeightGrip::OpeningBottom, 0.0, 2.1, 0.9, 3.0, false);
        assert_eq!(r.height, 0.2);
    }

    #[test]
    fn oeffnung_entlang_der_wand() {
        let (s, e) = ((0.0, 0.0), (5.0, 0.0));
        assert!(close(opening_wall_grip(s, e, 0.0, 1.0, 1.2), (1.6, 0.0)));
        // Bogenwand (Halbkreis, Radius 2.5): Mitte bei Bogenlänge 2.5·π/2 = Scheitel.
        let q = opening_wall_grip(s, e, 1.0, 2.5 * std::f64::consts::FRAC_PI_2 - 0.6, 1.2);
        assert!(close((q.0, q.1.abs()), (2.5, 2.5)), "{q:?}");
    }

    #[test]
    fn oeffnung_im_schnitt() {
        let (s, e) = ((0.0, 0.0), (5.0, 0.0));
        // Schnitt-Achse gegen die Wand: Faktor −1.
        assert_eq!(opening_slide_sheet(s, e, 0.0, (-1.0, 0.0), 1.0, 1.2, 0.5), Some((0.5, 0.5)));
        // Geklemmt: wirksames Delta passt zur Klemmung.
        assert_eq!(opening_slide_sheet(s, e, 0.0, (1.0, 0.0), 1.0, 1.2, 10.0), Some((3.8, 2.8)));
        // Quer geschnittene Wand: keine Bewegung.
        assert_eq!(opening_slide_sheet(s, e, 0.0, (0.1, 0.995), 1.0, 1.2, 1.0), None);
    }

    /// [144] Bogenwand im Schnitt-Blatt: Öffnungsmitte folgt dem Blatt-Delta auf dem Bogen (Bogenlänge),
    /// nicht der Sehne; jenseits des Bogens am Ende angehalten, wirksames Delta passend.
    #[test]
    fn oeffnung_im_schnitt_bogenwand() {
        // Halbkreis r = 2.5 über (0,0)–(5,0) (bulge 1), Bogenlänge 2.5·π; Schnitt-Achse +x.
        let (s, e) = ((0.0, 0.0), (5.0, 0.0));
        let a = crate::wall_arc::WallArc::of(kernel2d::Vec2::new(0.0, 0.0), kernel2d::Vec2::new(5.0, 0.0), Some(1.0)).unwrap();
        let (w, p0) = (1.0, 3.0);
        let mid_u = |p: f64| a.point(p + w / 2.0, 0.0).x;
        let (pos, du) = opening_slide_sheet(s, e, 1.0, (1.0, 0.0), p0, w, 0.4).unwrap();
        assert!((mid_u(pos) - mid_u(p0) - 0.4).abs() < 1e-6 && (du - 0.4).abs() < 1e-6, "{pos} {du}");
        // Bogenlänge statt Sehne: der Weg auf dem Bogen ist länger als die 0.4 m im Blatt.
        assert!((pos - p0).abs() > 0.4 + 1e-3, "{pos}");
        assert_eq!(opening_slide_sheet(s, e, 1.0, (1.0, 0.0), p0, w, 0.0).map(|r| r.0), Some(p0));
        // Weit über das Bogenende hinaus: an einem Ende angehalten, wirksames Delta = erreichte Strecke.
        let (pos, du) = opening_slide_sheet(s, e, 1.0, (1.0, 0.0), p0, w, 50.0).unwrap();
        let hi = a.length() - w;
        assert!(pos < 1e-9 || (pos - hi).abs() < 1e-9, "{pos}");
        assert!((du - (mid_u(pos) - mid_u(p0))).abs() < 1e-9 && du > 0.0);
        // Unsinn: keine Bewegung, kein Panic.
        assert_eq!(opening_slide_sheet(s, e, 1.0, (f64::NAN, 0.0), p0, w, 1.0), None);
        assert_eq!(opening_slide_sheet(s, e, 1.0, (1.0, 0.0), p0, 100.0, 1.0), None);
    }

    /// [T2] Endpunkt einer Bogenwand folgt dem Kreis (Mittelpunkt/Radius bleiben), Bogenlänge per Eingabe.
    #[test]
    fn bogenwand_endpunkt_auf_dem_kreis() {
        // Halbkreis über (0,0)–(4,0), bulge 1: Mitte (2,0), r = 2, Scheitel (2,2).
        let (s, e) = ((0.0, 0.0), (4.0, 0.0));
        let (ns, ne, nb) = arc_wall_endpoint(s, e, 1.0, 1, (2.0, 5.0)).unwrap();
        assert!(close(ns, s) && close(ne, (2.0, 2.0)), "{ne:?}");
        // Viertelkreis (Scheitel links der Sehne = Uhrzeigersinn): tan(π/8).
        assert!((nb - (std::f64::consts::FRAC_PI_8).tan()).abs() < 1e-9, "{nb}");
        let a = crate::wall_arc::WallArc::of(kernel2d::Vec2::new(ns.0, ns.1), kernel2d::Vec2::new(ne.0, ne.1), Some(nb)).unwrap();
        assert!((a.center.x - 2.0).abs() < 1e-9 && a.center.y.abs() < 1e-9 && (a.r - 2.0).abs() < 1e-9);
        // Start bewegt: Ende bleibt, Kreis bleibt.
        let (ns, ne, nb) = arc_wall_endpoint(s, e, 1.0, 0, (2.0, 9.0)).unwrap();
        assert!(close(ne, e) && close(ns, (2.0, 2.0)), "{ns:?}");
        let a = crate::wall_arc::WallArc::of(kernel2d::Vec2::new(ns.0, ns.1), kernel2d::Vec2::new(ne.0, ne.1), Some(nb)).unwrap();
        assert!((a.center.x - 2.0).abs() < 1e-9 && (a.r - 2.0).abs() < 1e-9);
        // Unsinn: Mittelpunkt, NaN, Fixpunkt (Sweep 0).
        assert!(arc_wall_endpoint(s, e, 1.0, 1, (2.0, 0.0)).is_none());
        assert!(arc_wall_endpoint(s, e, 1.0, 1, (f64::NAN, 0.0)).is_none());
        assert!(arc_wall_endpoint(s, e, 1.0, 1, (-2.0, 0.0)).is_none());
        assert!(arc_wall_endpoint(s, e, 0.0, 1, (1.0, 1.0)).is_none());
    }

    #[test]
    fn bogenwand_bogenlaenge_eingabe() {
        let (s, e) = ((0.0, 0.0), (4.0, 0.0));
        // Ende: Bogenlänge π (Viertelkreis r = 2) ab dem Start, Cursor oben rechts → Scheitel (2, 2).
        let p = arc_wall_point_at_length(s, e, 1.0, 1, std::f64::consts::PI, (3.0, 3.0)).unwrap();
        assert!(close(p, (2.0, 2.0)), "{p:?}");
        // Nach dem Anwenden hat die Wand genau diese Bogenlänge.
        let (ns, ne, nb) = arc_wall_endpoint(s, e, 1.0, 1, p).unwrap();
        let a = crate::wall_arc::WallArc::of(kernel2d::Vec2::new(ns.0, ns.1), kernel2d::Vec2::new(ne.0, ne.1), Some(nb)).unwrap();
        assert!((a.length() - std::f64::consts::PI).abs() < 1e-9);
        // Start bewegt: Länge 1 vom Ende aus.
        let p = arc_wall_point_at_length(s, e, 1.0, 0, 1.0, (1.0, 1.0)).unwrap();
        assert!(((p.0 - 2.0).hypot(p.1) - 2.0).abs() < 1e-9 && p.1 > 0.0);
        let (ns, ne, nb) = arc_wall_endpoint(s, e, 1.0, 0, p).unwrap();
        let a = crate::wall_arc::WallArc::of(kernel2d::Vec2::new(ns.0, ns.1), kernel2d::Vec2::new(ne.0, ne.1), Some(nb)).unwrap();
        assert!((a.length() - 1.0).abs() < 1e-9, "{}", a.length());
        assert!(arc_wall_point_at_length(s, e, 1.0, 1, -1.0, (0.0, 0.0)).is_none());
        assert!(arc_wall_point_at_length(s, e, 1.0, 1, 100.0, (0.0, 0.0)).is_none());
    }

    #[test]
    fn bogenwand_griff_ziel() {
        let (s, e) = ((0.0, 0.0), (4.0, 0.0));
        let (p, l) = arc_wall_grip_target(s, e, 1.0, 1, Some(std::f64::consts::PI), (3.0, 3.0)).unwrap();
        assert!(close(p, (2.0, 2.0)) && (l - std::f64::consts::PI).abs() < 1e-9);
        let (p, l) = arc_wall_grip_target(s, e, 1.0, 1, None, (2.0, 7.0)).unwrap();
        assert!(close(p, (2.0, 2.0)) && (l - std::f64::consts::PI).abs() < 1e-9);
        assert!(arc_wall_grip_target(s, e, 1.0, 1, Some(f64::NAN), (2.0, 7.0)).is_none());
    }

    /// [T2] Radius-Griff mit festem Mittelpunkt: Mittelpunkt und Öffnungswinkel bleiben, Enden wandern radial.
    #[test]
    fn bogenwand_radius_fester_mittelpunkt() {
        let (s, e) = ((0.0, 0.0), (4.0, 0.0)); // Halbkreis, Mitte (2, 0), r = 2
        let (ns, ne) = arc_wall_radius_fixed_center(s, e, 1.0, (2.0, 6.0)).unwrap();
        assert!(close(ns, (-4.0, 0.0)) && close(ne, (8.0, 0.0)), "{ns:?} {ne:?}");
        let a = crate::wall_arc::WallArc::of(kernel2d::Vec2::new(ns.0, ns.1), kernel2d::Vec2::new(ne.0, ne.1), Some(1.0)).unwrap();
        assert!((a.center.x - 2.0).abs() < 1e-9 && a.center.y.abs() < 1e-9 && (a.r - 6.0).abs() < 1e-9);
        // Viertelkreis (bulge tan(π/8)): Enden bleiben auf ihren Winkeln.
        let b = std::f64::consts::FRAC_PI_8.tan();
        let c = crate::wall_arc::WallArc::of(kernel2d::Vec2::new(0.0, 0.0), kernel2d::Vec2::new(2.0, 2.0), Some(b)).unwrap();
        let (ns, ne) = arc_wall_radius_fixed_center((0.0, 0.0), (2.0, 2.0), b, (c.center.x + 3.0, c.center.y)).unwrap();
        let a = crate::wall_arc::WallArc::of(kernel2d::Vec2::new(ns.0, ns.1), kernel2d::Vec2::new(ne.0, ne.1), Some(b)).unwrap();
        assert!((a.center.x - c.center.x).abs() < 1e-9 && (a.center.y - c.center.y).abs() < 1e-9 && (a.r - 3.0).abs() < 1e-9 && (a.a0 - c.a0).abs() < 1e-9);
        assert!(arc_wall_radius_fixed_center(s, e, 1.0, (2.0, 0.0)).is_none());
        assert!(arc_wall_radius_fixed_center(s, e, 1.0, (f64::NAN, 0.0)).is_none());
        assert!(arc_wall_radius_fixed_center(s, e, 0.0, (2.0, 3.0)).is_none());
    }

    #[test]
    fn bogenwand_radius_ziel() {
        let (s, e) = ((0.0, 0.0), (4.0, 0.0));
        // Fester Mittelpunkt, Radius getippt: Punkt auf dem Strahl Mitte → Cursor.
        let (p, r) = arc_wall_radius_target(s, e, 1.0, true, Some(5.0), (2.0, 1.0)).unwrap();
        assert!(close(p, (2.0, 5.0)) && (r - 5.0).abs() < 1e-12);
        let (p, r) = arc_wall_radius_target(s, e, 1.0, true, None, (2.0, 3.0)).unwrap();
        assert!(close(p, (2.0, 3.0)) && (r - 3.0).abs() < 1e-12);
        // Cursor im Mittelpunkt: Richtung des bisherigen Scheitels (hier -y, bulge > 0 = links der Sehne → +y? Scheitel (2, 2)).
        let (p, _) = arc_wall_radius_target(s, e, 1.0, true, Some(1.0), (2.0, 0.0)).unwrap();
        assert!(close(p, (2.0, 1.0)), "{p:?}");
        // Feste Endpunkte, Radius 5 über der Sehne 4: Kleinbogen, Pfeilhöhe 5 − √21; Seite folgt dem Cursor.
        let h = 5.0 - 21f64.sqrt();
        let (p, r) = arc_wall_radius_target(s, e, 1.0, false, Some(5.0), (2.0, 1.0)).unwrap();
        assert!(close(p, (2.0, h)) && (r - 5.0).abs() < 1e-12, "{p:?}");
        let (p, _) = arc_wall_radius_target(s, e, 1.0, false, Some(5.0), (2.0, -1.0)).unwrap();
        assert!(close(p, (2.0, -h)), "{p:?}");
        // Cursor weiter als der Radius von der Sehne: Grossbogen.
        let (p, _) = arc_wall_radius_target(s, e, 1.0, false, Some(5.0), (2.0, 7.0)).unwrap();
        assert!(close(p, (2.0, 5.0 + 21f64.sqrt())), "{p:?}");
        // Das Ergebnis ergibt zurückgerechnet genau diesen Radius.
        let b = crate::bulge::from_sagitta_point(0.0, 0.0, 4.0, 0.0, 2.0, h);
        let a = crate::wall_arc::WallArc::of(kernel2d::Vec2::new(0.0, 0.0), kernel2d::Vec2::new(4.0, 0.0), Some(b)).unwrap();
        assert!((a.r - 5.0).abs() < 1e-9);
        // Radius kleiner als die halbe Sehne: unmöglich.
        assert!(arc_wall_radius_target(s, e, 1.0, false, Some(1.5), (2.0, 1.0)).is_none());
        // Ohne Radius: der Cursor selbst, Radius der Wand danach.
        let (p, r) = arc_wall_radius_target(s, e, 1.0, false, None, (2.0, 1.0)).unwrap();
        assert!(close(p, (2.0, 1.0)) && (r - 2.5).abs() < 1e-9, "{r}");
        assert!(arc_wall_radius_target(s, e, 1.0, true, Some(f64::NAN), (2.0, 1.0)).is_none());
        assert!(arc_wall_radius_target(s, e, 0.0, true, Some(2.0), (2.0, 1.0)).is_none());
    }

    #[test]
    fn treppe_wand_baugrube() {
        assert!(close(stair_handle(false, None, (1.0, 1.0), (0.0, 2.0), 4.0), (1.0, 3.0)));
        assert!(close(stair_handle(true, Some((5.0, 5.0)), (1.0, 1.0), (0.0, 2.0), 4.0), (5.0, 5.0)));
        assert!(close(stair_handle(true, None, (1.0, 1.0), (0.0, 2.0), 4.0), (1.0, 1.0)));
        assert_eq!(wall_grips((0.0, 0.0), (4.0, 0.0), 0.0).len(), 2);
        let g = wall_grips((0.0, 0.0), (4.0, 0.0), 0.5);
        assert!(close(g[2], (2.0, 1.0)), "{g:?}");
        let pit = [(0.0, 0.0), (4.0, 0.0), (4.0, 4.0), (0.0, 4.0)];
        let g = excavation_grips(&pit, -2.0);
        assert_eq!(g.len(), 5);
        assert!(close(g[4], (2.0, 0.0)));
        assert!(close(excavation_grips(&[], 1.0)[0], (0.0, 1.0)));
    }

    #[test]
    fn koinzidente_ecken() {
        let corners = [(0.0, 0.0), (4.0, 0.0)];
        let groups = vec![vec![(4.03, 0.0), (4.0, 3.0)], vec![(9.0, 9.0)], vec![(0.0, 0.04), (0.0, 0.02), (4.0, 0.0)]];
        assert_eq!(coincident(&corners, &groups), vec![(2, 0), (2, 1), (0, 0), (2, 2)]);
    }
}
