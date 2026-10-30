//! 2D-Zeichenbefehle und Bemassung im Kern ([K4] S3, vorher `commands/cmds/{line,xline,ray,polyline,rect,
//! circle,arc,ellipse,polygon,spline,bezier,revcloud,wipeout,multiline,text,textbox,textpath,leader,kote,
//! detailref,scalebar,pointmarker,block,dimension,autodim}.ts`): die Geometrie der neuen Zeichnung aus den
//! Klickpunkten (Bögen, Kreise, Vielecke, Rundungen, Revisionswolke …), die Vorschau-Formen je Mausschritt
//! und die Treffer der Befehle (Tangenten-Objekt, Massketten). Einstieg über `cmd_create`.

use crate::cmd_create::{
    add_op, b_of, circle_pts, find, level_of, n_of, normalize, obj, opt_n, opt_p, p_of, pair, point_segment_distance, polyline_edges,
    pts_of, pv, pvs, s, s_of, seg_len, to_p, type_thickness, wall_types, Ctx, Preview, V, EPS,
};
use crate::cmd_transform::{IdGen, Shapes};
use crate::grips::{arr, field, js_num, num_of, num_or, with, xy};
use crate::jsmath::hypot2;
use crate::jsnum;
use crate::ops::{id_of, Op};
use kernel2d::{self as k, TangentTarget, Vec2 as P};
use serde_json::{json, Map, Value};
use std::f64::consts::PI;

const TAU: f64 = PI * 2.0;

fn of(p: P) -> V {
    (p.x, p.y)
}

fn dist(a: V, b: V) -> f64 {
    hypot2(b.0 - a.0, b.1 - a.1)
}

fn mid(a: V, b: V) -> V {
    ((a.0 + b.0) / 2.0, (a.1 + b.1) / 2.0)
}

fn angle(c: V, p: V) -> f64 {
    jsnum::atan2(p.1 - c.1, p.0 - c.0)
}

/// Neue 2D-Zeichnung `{id, type, levelId, categoryCode, geom}` (Farbe/Strich erbt die Ebene).
fn drawing(id: String, ctx: &Ctx, geom: Value) -> Value {
    obj(vec![("id", s(&id)), ("type", s("drawing2d")), ("levelId", s(ctx.level)), ("categoryCode", s(ctx.cat)), ("geom", geom)])
}

/// id der Anfrage (Text-Befehle vergeben sie selbst, um das Element gleich zu fokussieren) oder neu.
fn id_or_new(v: &Value, ids: &mut IdGen) -> String {
    match v.get("id").and_then(Value::as_str) {
        Some(id) => id.into(),
        None => ids.next("dr2d"),
    }
}

fn add_drawing(v: &Value, ctx: &Ctx, ids: &mut IdGen, geom: Value) -> Vec<Op> {
    add_op("drawings2d", vec![drawing(id_or_new(v, ids), ctx, geom)])
}

/// Punkt der Anfrage als JSON-Wert, wie übergeben (Objekte `{x, y}` unverändert, Paare als Punkt).
fn pt_val(v: &Value, k: &str) -> Value {
    match v.get(k) {
        Some(x) if x.is_object() => x.clone(),
        _ => pv(p_of(v, k)),
    }
}

fn pts_val(v: &Value, k: &str) -> Value {
    Value::Array(arr(v.get(k)).iter().map(|x| if x.is_object() { x.clone() } else { pv(pair(x)) }).collect())
}

// ── Bögen (Bulge, Kreis durch Punkte …) ──────────────────────────────────────

struct Arc {
    c: V,
    r: f64,
    a0: f64,
    a1: f64,
}

/// Bogen aus `[cx, cy, r, a0, a1]` (leer = keiner), wie die Bindungen in `crate::bulge` (prüfen auf
/// endliche Eingaben, genau wie die frühere TS-Fassade).
fn arc_of(f: Vec<f64>) -> Option<Arc> {
    (f.len() >= 5).then(|| Arc { c: (f[0], f[1]), r: f[2], a0: f[3], a1: f[4] })
}

fn arc_through(a: V, t: V, b: V) -> Option<Arc> {
    arc_of(crate::bulge::arc_through_points(a.0, a.1, t.0, t.1, b.0, b.1))
}

fn bulge_through(a: V, t: V, b: V) -> f64 {
    crate::bulge::through_point(a.0, a.1, t.0, t.1, b.0, b.1)
}

fn bulge_points(pts: &[V], bulge: &[f64], closed: bool) -> Vec<V> {
    // Ohne echten Bogen die Eingabepunkte selbst (wie `bulgePolylinePoints`).
    if !bulge.iter().any(|b| b.abs() > 1e-9) {
        return pts.to_vec();
    }
    let f: Vec<f64> = pts.iter().flat_map(|p| [p.0, p.1]).collect();
    crate::bulge::polyline_points(&f, bulge, closed).chunks_exact(2).map(|q| (q[0], q[1])).collect()
}

// ═════════════════════════════════════════════════════════════════════════════
// Polylinie (mit Bögen)
// ═════════════════════════════════════════════════════════════════════════════

/// Bulge eines Bogens, der in `a` tangential an `dir` anschliesst und in `b` endet (`tangentBulge`).
fn tangent_bulge(a: V, b: V, dir: Option<V>) -> f64 {
    let Some(dir) = dir else { return 0.0 };
    let (cx, cy) = (b.0 - a.0, b.1 - a.1);
    let len = hypot2(cx, cy);
    let dl = hypot2(dir.0, dir.1);
    if len < EPS || dl < EPS {
        return 0.0;
    }
    let (ux, uy) = (cx / len, cy / len);
    let (dx, dy) = (dir.0 / dl, dir.1 / dl);
    let theta = jsnum::atan2(ux * dy - uy * dx, ux * dx + uy * dy);
    jsnum::tan(theta / 2.0)
}

/// Richtung, in der das zuletzt gelegte Segment endet (`lastDirection`).
fn last_direction(points: &[V], bulges: &[f64]) -> Option<V> {
    let n = points.len();
    if n < 2 {
        return None;
    }
    let (a, b) = (points[n - 2], points[n - 1]);
    let bulge = bulges.get(n - 2).copied().unwrap_or(0.0);
    let chord = (b.0 - a.0, b.1 - a.1);
    if bulge.abs() < EPS {
        return Some(chord);
    }
    let ang = -2.0 * jsnum::atan(bulge);
    let (c, si) = (jsnum::cos(ang), jsnum::sin(ang));
    Some((chord.0 * c - chord.1 * si, chord.0 * si + chord.1 * c))
}

/// Art eines Segments: gerade (`0`), tangential (`1`) oder Bogen durch einen Punkt (`{x, y}`/`[x, y]`).
fn seg_bulge(seg: &Value, prev: V, pt: V, points: &[V], bulges: &[f64]) -> f64 {
    if seg.is_object() || seg.is_array() {
        return bulge_through(prev, pair(seg), pt);
    }
    if num_of(Some(seg)) == 1.0 {
        return tangent_bulge(prev, pt, last_direction(points, bulges));
    }
    0.0
}

/// Bulges der gesetzten Segmente der Reihe nach (jeder Bogen kennt die Richtung seines Vorgängers).
pub(crate) fn poly_bulges(points: &[V], segs: &[Value]) -> Vec<f64> {
    let mut bulges: Vec<f64> = Vec::new();
    for i in 1..points.len() {
        let seg = segs.get(i - 1).unwrap_or(&Value::Null);
        let b = seg_bulge(seg, points[i - 1], points[i], &points[..i], &bulges);
        bulges.push(b);
    }
    bulges
}

/// Polylinie: `pts`, `segs` (je Segment), `closed`, `closing` (Art des Schluss-Segments).
fn polyline_ops(v: &Value, ctx: &Ctx, ids: &mut IdGen) -> Vec<Op> {
    let pts = pts_of(v, "pts");
    let closed = b_of(v, "closed");
    let mut bl = poly_bulges(&pts, arr(v.get("segs")));
    if let Some(c) = v.get("closing").filter(|c| !c.is_null()) {
        // Schluss-Segment zum Start; schloss ein Klick nahe dem Start, endet der Bogen dort (`closingEnd`).
        let (Some(first), Some(last)) = (pts.first(), pts.last()) else { return Vec::new() };
        let end = opt_p(v, "closingEnd").unwrap_or(*first);
        let b = seg_bulge(c, *last, end, &pts, &bl);
        bl.push(b);
    }
    let n = pts.len();
    let has_arc = bl.iter().any(|b| b.abs() > EPS);
    let mut g = vec![("shape", s("polyline")), ("pts", pts_val(v, "pts")), ("closed", Value::Bool(closed))];
    if has_arc {
        let keep = if closed { n } else { n.saturating_sub(1) };
        g.push(("bulge", Value::Array(bl.iter().take(keep).map(|b| js_num(*b)).collect())));
    }
    add_drawing(v, ctx, ids, obj(g))
}

/// Bulges je Segment einer Vorschau (Polylinie, Wand): gesetzte Segmente aus `segs`, dazu das lebende
/// Segment zum Cursor (letzter Punkt in `pts`, falls `cursor`) im Bogen-Modus (`arc`, `tangent`,
/// `through`).
pub(crate) fn preview_bulges(v: &Value, pts: &[V]) -> Vec<f64> {
    let has_cursor = b_of(v, "cursor");
    let points = if has_cursor && !pts.is_empty() { &pts[..pts.len() - 1] } else { pts };
    let bulges = poly_bulges(points, arr(v.get("segs")));
    let mut all_b = bulges.clone();
    if has_cursor {
        let cursor = pts[pts.len() - 1];
        let pb = match points.last() {
            Some(last) if b_of(v, "arc") => match opt_p(v, "through") {
                Some(t) => bulge_through(*last, t, cursor),
                None if b_of(v, "tangent") => tangent_bulge(*last, cursor, last_direction(points, &bulges)),
                None => 0.0,
            },
            _ => 0.0,
        };
        all_b.push(pb);
    }
    all_b
}

/// Polylinien-Vorschau: gesetzte Punkte + Cursor (letzter Punkt in `pts`, falls `cursor`), Bogen-Modus.
fn polyline_preview(v: &Value, pts: &[V], out: &mut Shapes) {
    let all_b = preview_bulges(v, pts);
    let shown = bulge_points(pts, &all_b, false);
    if b_of(v, "closed") && pts.len() >= 3 {
        out.poly(&shown);
    } else {
        out.poly_open(&shown);
    }
}

// ═════════════════════════════════════════════════════════════════════════════
// Rechteck (2-Punkt, 3-Punkt gedreht, Zentrum; Eck-Radius)
// ═════════════════════════════════════════════════════════════════════════════

fn rect_geom(a: V, b: V) -> (V, V) {
    ((jsnum::min(a.0, b.0), jsnum::min(a.1, b.1)), (jsnum::max(a.0, b.0), jsnum::max(a.1, b.1)))
}

fn center_geom(c: V, corner: V) -> (V, V) {
    let (hx, hy) = ((corner.0 - c.0).abs(), (corner.1 - c.1).abs());
    ((c.0 - hx, c.1 - hy), (c.0 + hx, c.1 + hy))
}

fn corners_of(mn: V, mx: V) -> [V; 4] {
    [mn, (mx.0, mn.1), mx, (mn.0, mx.1)]
}

/// Vier Ecken des gedrehten Rechtecks aus Basiskante a→b und Höhenpunkt p (`rotatedCorners`).
fn rotated_corners(a: V, b: V, p: V) -> [V; 4] {
    let (dx, dy) = (b.0 - a.0, b.1 - a.1);
    let len = hypot2(dx, dy);
    if len < EPS {
        return [a, b, b, a];
    }
    let (nx, ny) = (-dy / len, dx / len);
    let h = (p.0 - a.0) * nx + (p.1 - a.1) * ny;
    [a, b, (b.0 + nx * h, b.1 + ny * h), (a.0 + nx * h, a.1 + ny * h)]
}

fn rise_from(a: V, b: V, p: V) -> f64 {
    let (dx, dy) = (b.0 - a.0, b.1 - a.1);
    let len = hypot2(dx, dy);
    if len < EPS {
        return 0.0;
    }
    (p.0 - a.0) * (-dy / len) + (p.1 - a.1) * (dx / len)
}

/// Ecken mit Radius `r` runden (`roundedRectPts`): Tangentenpunkte + Bulge je Ecke, `None` = scharf.
fn rounded_rect(corners: &[V], r: f64) -> Option<(Vec<V>, Vec<f64>)> {
    if r < EPS {
        return None;
    }
    let n = corners.len();
    let mut max_r = f64::INFINITY;
    for i in 0..n {
        max_r = jsnum::min(max_r, seg_len(corners[i], corners[(i + 1) % n]) / 2.0);
    }
    let rr = jsnum::min(r, max_r - EPS);
    if rr < EPS {
        return None;
    }
    let mut pts = Vec::new();
    let mut bulge = Vec::new();
    for i in 0..n {
        let (prev, cur, next) = (corners[(i + n - 1) % n], corners[i], corners[(i + 1) % n]);
        let f = k::fillet_corner(to_p(cur), to_p(prev), to_p(next), rr)?;
        let (dx, dy) = (cur.0 - f.center.x, cur.1 - f.center.y);
        let dl = hypot2(dx, dy);
        let dl = if dl == 0.0 || dl.is_nan() { 1.0 } else { dl };
        let m = (f.center.x + (dx / dl) * rr, f.center.y + (dy / dl) * rr);
        let (ta, tb) = (of(f.tangent_a), of(f.tangent_b));
        pts.push(ta);
        pts.push(tb);
        bulge.push(bulge_through(ta, m, tb));
        bulge.push(0.0);
    }
    Some((pts, bulge))
}

fn rounded_geom(corners: &[V], r: f64) -> Option<Value> {
    let (pts, bulge) = rounded_rect(corners, r)?;
    Some(obj(vec![
        ("shape", s("polyline")),
        ("pts", pvs(&pts)),
        ("closed", Value::Bool(true)),
        ("bulge", Value::Array(bulge.iter().map(|b| js_num(*b)).collect())),
    ]))
}

/// Rechteck: `method` (corner/three/center), `a`, `b`, `c` (3-Punkt), `radius`.
fn rect_ops(v: &Value, ctx: &Ctx, ids: &mut IdGen) -> Vec<Op> {
    let (a, b) = (p_of(v, "a"), p_of(v, "b"));
    let r = n_of(v, "radius");
    let geom = match s_of(v, "method") {
        "three" => {
            let c = rotated_corners(a, b, p_of(v, "c"));
            if r >= EPS {
                rounded_geom(&c, r)
            } else if seg_len(c[0], c[1]) < EPS || seg_len(c[1], c[2]) < EPS {
                None
            } else {
                // Basis-Ecken sind die Klickpunkte selbst.
                let pts = vec![pt_val(v, "a"), pt_val(v, "b"), pv(c[2]), pv(c[3])];
                Some(obj(vec![("shape", s("polyline")), ("pts", Value::Array(pts)), ("closed", Value::Bool(true))]))
            }
        }
        m => {
            let (mn, mx) = if m == "center" { center_geom(a, b) } else { rect_geom(a, b) };
            if r >= EPS {
                rounded_geom(&corners_of(mn, mx), r)
            } else if mx.0 - mn.0 < EPS || mx.1 - mn.1 < EPS {
                None
            } else {
                Some(obj(vec![("shape", s("rect")), ("min", pv(mn)), ("max", pv(mx))]))
            }
        }
    };
    geom.map_or_else(Vec::new, |g| add_drawing(v, ctx, ids, g))
}

/// Rechteck-Vorschau (`pts` = a, [b], Cursor): Ecken (gerundet tesselliert); `info = [v0x, v0y, höhe]`.
fn rect_preview(v: &Value, pts: &[V], out: &mut Shapes, info: &mut Vec<f64>) {
    let r = n_of(v, "radius");
    let corners = match (s_of(v, "method"), pts) {
        ("three", [a, b, c]) => {
            info.extend([a.0, a.1, rise_from(*a, *b, *c).abs()]);
            rotated_corners(*a, *b, *c)
        }
        ("center", [a, c]) => {
            let (mn, mx) = center_geom(*a, *c);
            info.extend([mn.0, mn.1, 0.0]);
            corners_of(mn, mx)
        }
        (_, [a, c]) => {
            let (mn, mx) = rect_geom(*a, *c);
            info.extend([mn.0, mn.1, 0.0]);
            corners_of(mn, mx)
        }
        _ => return,
    };
    match rounded_rect(&corners, r) {
        Some((p, b)) => out.poly(&bulge_points(&p, &b, true)),
        None => out.poly(&corners),
    }
}

// ═════════════════════════════════════════════════════════════════════════════
// Kreis (Mittelpunkt, 2-Punkt, 3-Punkt, Tangente-Tangente-Radius)
// ═════════════════════════════════════════════════════════════════════════════

/// Pick-Toleranz des Tangenten-Objekts.
const TTR_HIT_TOL: f64 = 0.3;

fn in_arc_span(a0: f64, a1: f64, ang: f64) -> bool {
    let norm = |x: f64| ((x % TAU) + TAU) % TAU;
    let sw = norm(a1 - a0);
    let sweep = if sw == 0.0 || sw.is_nan() { TAU } else { sw };
    norm(ang - a0) <= sweep + 1e-6
}

/// Gerade Kanten einer Form für die Tangenten-Wahl (Bogen-Segmente ausgenommen).
fn straight_edges(g: &Value) -> Vec<(V, V)> {
    let p = |k: &str| xy(field(g, k).unwrap_or(&Value::Null));
    match field(g, "shape").and_then(Value::as_str) {
        Some("line") => vec![(p("a"), p("b"))],
        Some("rect") => {
            let (mn, mx) = (p("min"), p("max"));
            polyline_edges(&corners_of(mn, mx), true)
        }
        Some("polyline") => {
            let pts: Vec<V> = arr(field(g, "pts")).iter().map(xy).collect();
            let bulge = arr(field(g, "bulge"));
            polyline_edges(&pts, crate::grips::truthy(field(g, "closed")))
                .into_iter()
                .enumerate()
                .filter(|(i, _)| num_or(bulge.get(*i), 0.0).abs() <= EPS)
                .map(|(_, e)| e)
                .collect()
        }
        _ => Vec::new(),
    }
}

fn target_json(t: &TangentTarget) -> Value {
    match t {
        TangentTarget::Line { a, b } => json!({ "kind": "line", "a": pv(of(*a)), "b": pv(of(*b)) }),
        TangentTarget::Circle { center, r } => json!({ "kind": "circle", "center": pv(of(*center)), "r": js_num(*r) }),
    }
}

fn target_of(v: &Value) -> Option<TangentTarget> {
    let p = |k: &str| to_p(xy(field(v, k).unwrap_or(&Value::Null)));
    match field(v, "kind").and_then(Value::as_str)? {
        "line" => Some(TangentTarget::Line { a: p("a"), b: p("b") }),
        "circle" => Some(TangentTarget::Circle { center: p("center"), r: num_of(field(v, "r")) }),
        _ => None,
    }
}

/// Nächstes tangentenfähiges Element (Gerade oder Kreis/Bogen) zum Klickpunkt.
fn pick_tangent<'a>(root: &'a Map<String, Value>, level: &str, at: V) -> Option<(TangentTarget, &'a Value)> {
    let mut best: Option<(TangentTarget, &Value)> = None;
    let mut best_d = TTR_HIT_TOL;
    for d in arr(root.get("drawings2d")) {
        if level_of(d) != Some(level) {
            continue;
        }
        let Some(g) = field(d, "geom") else { continue };
        let shape = field(g, "shape").and_then(Value::as_str);
        if shape == Some("circle") || shape == Some("arc") {
            let c = xy(field(g, "center").unwrap_or(&Value::Null));
            let r = num_of(field(g, "r"));
            let dd = (dist(at, c) - r).abs();
            let span = shape == Some("circle") || in_arc_span(num_of(field(g, "a0")), num_of(field(g, "a1")), angle(c, at));
            if dd < best_d && span {
                best_d = dd;
                best = Some((TangentTarget::Circle { center: to_p(c), r }, d));
            }
        } else {
            for (a, b) in straight_edges(g) {
                let dd = point_segment_distance(at, a, b);
                if dd < best_d {
                    best_d = dd;
                    best = Some((TangentTarget::Line { a: to_p(a), b: to_p(b) }, d));
                }
            }
        }
    }
    best
}

fn nearest_candidate(cands: &[P], n1: V, n2: V) -> Option<V> {
    let mut best = None;
    let mut best_d = f64::INFINITY;
    for c in cands {
        let c = of(*c);
        let dd = dist(c, n1) + dist(c, n2);
        if dd < best_d {
            best_d = dd;
            best = Some(c);
        }
    }
    best
}

/// Kreis der Anfrage (`method`, `pts`, `r`; TTR: `t1`, `t2`, `near1`, `near2`): Mitte + Radius.
fn circle_of(v: &Value, pts: &[V]) -> Option<(V, f64)> {
    let typed = opt_n(v, "r");
    match s_of(v, "method") {
        "center" => {
            let c = *pts.first()?;
            Some((c, typed.unwrap_or_else(|| pts.get(1).map_or(0.0, |p| dist(c, *p)))))
        }
        "twoPoint" => match pts {
            [a, b] => Some((mid(*a, *b), dist(*a, *b) / 2.0)),
            _ => None,
        },
        "threePoint" => match pts {
            [a, b, c] => arc_through(*a, *b, *c).map(|a| (a.c, a.r)),
            _ => None,
        },
        "ttr" => {
            let (n1, n2) = (p_of(v, "near1"), p_of(v, "near2"));
            let r = typed.unwrap_or_else(|| pts.first().map_or(0.0, |p| dist(n1, *p)));
            let (t1, t2) = (target_of(v.get("t1")?)?, target_of(v.get("t2")?)?);
            if !(r > EPS) {
                return None;
            }
            nearest_candidate(&k::tangent_circle_centers(t1, t2, r), n1, n2).map(|c| (c, r))
        }
        _ => None,
    }
}

fn circle_ops(v: &Value, ctx: &Ctx, ids: &mut IdGen) -> Vec<Op> {
    let pts = pts_of(v, "pts");
    match circle_of(v, &pts) {
        Some((c, r)) if !(r < EPS) => add_drawing(v, ctx, ids, obj(vec![("shape", s("circle")), ("center", pv(c)), ("r", js_num(r))])),
        _ => Vec::new(),
    }
}

/// Kreis-Vorschau: `ok` = Kreis bestimmt; `info = [cx, cy, r]`; Formen nur ab r ≥ EPS (48-Eck).
fn circle_preview(v: &Value, pts: &[V], p: &mut Preview) {
    match circle_of(v, pts) {
        Some((c, r)) => {
            p.info.extend([c.0, c.1, r]);
            if !(r < EPS) {
                p.shapes.poly(&circle_pts(c, r, 48));
            }
        }
        None => {
            p.ok = false;
            // TTR ohne Kandidat: der Radius für den Zustand.
            let r = match (s_of(v, "method"), pts.first()) {
                ("ttr", Some(q)) => dist(p_of(v, "near1"), *q),
                _ => f64::NAN,
            };
            p.info.extend([f64::NAN, f64::NAN, r]);
        }
    }
}

// ═════════════════════════════════════════════════════════════════════════════
// Bogen (Mittelpunkt, 3-Punkt, Start-Ende-Radius, Start-Ende-Richtung)
// ═════════════════════════════════════════════════════════════════════════════

fn sweep_of(a0: f64, a1: f64) -> f64 {
    let s = ((a1 - a0) % TAU + TAU) % TAU;
    if s < EPS {
        TAU
    } else {
        s
    }
}

fn arc_pts(c: V, r: f64, a0: f64, a1: f64) -> Vec<V> {
    let sweep = sweep_of(a0, a1);
    let n = jsnum::max(2.0, (sweep / (PI / 32.0)).ceil());
    if !(n <= 100_000.0) {
        return Vec::new();
    }
    let n = n as usize;
    (0..=n)
        .map(|i| {
            let t = a0 + (sweep * i as f64) / n as f64;
            (c.0 + r * jsnum::cos(t), c.1 + r * jsnum::sin(t))
        })
        .collect()
}

/// Bogen der Anfrage (`method`, `pts`; „ser“ mit getipptem `r`).
fn arc_req(v: &Value, pts: &[V]) -> Option<Arc> {
    match (s_of(v, "method"), pts) {
        ("center", [c, st, en]) => Some(Arc { c: *c, r: dist(*c, *st), a0: angle(*c, *st), a1: angle(*c, *en) }),
        ("three", [a, t, b]) => arc_through(*a, *t, *b),
        ("ser", [a, b, p]) => {
            let r = opt_n(v, "r").unwrap_or_else(|| dist(mid(*a, *b), *p));
            arc_of(crate::bulge::arc_from_start_end_radius(a.0, a.1, b.0, b.1, r, p.0, p.1))
        }
        ("sed", [a, b, d]) => arc_of(crate::bulge::arc_from_start_end_direction(a.0, a.1, b.0, b.1, d.0, d.1)),
        _ => None,
    }
}

fn arc_ops(v: &Value, ctx: &Ctx, ids: &mut IdGen) -> Vec<Op> {
    match arc_req(v, &pts_of(v, "pts")) {
        Some(a) if !(a.r < EPS) => add_drawing(
            v,
            ctx,
            ids,
            obj(vec![("shape", s("arc")), ("center", pv(a.c)), ("r", js_num(a.r)), ("a0", js_num(a.a0)), ("a1", js_num(a.a1))]),
        ),
        _ => Vec::new(),
    }
}

/// Bogen-Vorschau: `ok` = Bogen bestimmt; `info = [cx, cy, r, Spanne°]`. `full` (Mittelpunkt-Methode
/// vor dem Startpunkt): voller Kreis um `pts[0]` durch den Cursor.
fn arc_preview(v: &Value, pts: &[V], p: &mut Preview) {
    if b_of(v, "full") {
        if let [c, q] = pts {
            let r = dist(*c, *q);
            p.info.extend([c.0, c.1, r, 0.0]);
            p.shapes.poly(&circle_pts(*c, r, 48));
        }
        return;
    }
    match arc_req(v, pts) {
        Some(a) => {
            p.info.extend([a.c.0, a.c.1, a.r, (sweep_of(a.a0, a.a1) * 180.0) / PI]);
            if !(a.r < EPS) {
                p.shapes.poly_open(&arc_pts(a.c, a.r, a.a0, a.a1));
            }
        }
        None => p.ok = false,
    }
}

// ═════════════════════════════════════════════════════════════════════════════
// Ellipse, Vieleck, Spline, Bezier, Revisionswolke
// ═════════════════════════════════════════════════════════════════════════════

fn perp_dist(a: V, b: V, p: V) -> f64 {
    let len = dist(a, b);
    if len < EPS {
        return 0.0;
    }
    let (dx, dy) = ((b.0 - a.0) / len, (b.1 - a.1) / len);
    (p.0 - a.0) * -dy + (p.1 - a.1) * dx
}

/// Ellipse der Anfrage: box (`[p0, p1]`) oder axis (`[Mitte, Hauptachse, Nebenachsen-Punkt]`).
fn ellipse_of(v: &Value, pts: &[V]) -> Option<(V, f64, f64, f64)> {
    match (s_of(v, "method"), pts) {
        ("box", [a, b]) => Some((mid(*a, *b), (b.0 - a.0).abs() / 2.0, (b.1 - a.1).abs() / 2.0, 0.0)),
        ("axis", [c, m]) => Some((*c, dist(*c, *m), 0.0, angle(*c, *m))),
        ("axis", [c, m, p]) => Some((*c, dist(*c, *m), perp_dist(*c, *m, *p).abs(), angle(*c, *m))),
        _ => None,
    }
}

fn ellipse_ops(v: &Value, ctx: &Ctx, ids: &mut IdGen) -> Vec<Op> {
    match ellipse_of(v, &pts_of(v, "pts")) {
        Some((c, rx, ry, rot)) if !(rx < EPS || ry < EPS) => add_drawing(
            v,
            ctx,
            ids,
            obj(vec![("shape", s("ellipse")), ("center", pv(c)), ("rx", js_num(rx)), ("ry", js_num(ry)), ("rotation", js_num(rot))]),
        ),
        _ => Vec::new(),
    }
}

/// `info = [cx, cy, rx, ry]`; Formen ab rx, ry ≥ EPS (64 Punkte).
fn ellipse_preview(v: &Value, pts: &[V], p: &mut Preview) {
    let Some((c, rx, ry, rot)) = ellipse_of(v, pts) else {
        p.ok = false;
        return;
    };
    p.info.extend([c.0, c.1, rx, ry]);
    if !(rx < EPS || ry < EPS) {
        let f = crate::curves::ellipse(c.0, c.1, rx, ry, rot, 64.0);
        p.shapes.poly(&f.chunks_exact(2).map(|q| (q[0], q[1])).collect::<Vec<_>>());
    }
}

fn polygon_pts(c: V, r: f64, sides: f64, circumscribed: bool, dir: Option<V>) -> Vec<V> {
    let rv = if circumscribed { r / jsnum::cos(PI / sides) } else { r };
    let t0 = match dir {
        Some(d) if dist(c, d) > EPS => jsnum::atan2(d.1 - c.1, d.0 - c.0),
        _ => 0.0,
    };
    let n = if sides.is_finite() && sides > 0.0 { sides as usize } else { 0 };
    (0..n.min(10_000))
        .map(|i| {
            let t = t0 + (i as f64 / sides) * PI * 2.0;
            (c.0 + rv * jsnum::cos(t), c.1 + rv * jsnum::sin(t))
        })
        .collect()
}

fn polygon_from_edge(a: V, b: V, sides: f64) -> Vec<V> {
    let edge = dist(a, b);
    let ext = (2.0 * PI) / sides;
    let mut pts = vec![a, b];
    let mut cur = b;
    let mut dir = jsnum::atan2(b.1 - a.1, b.0 - a.0);
    let mut i = 2.0;
    while i < sides && pts.len() < 10_000 {
        dir += ext;
        let next = (cur.0 + edge * jsnum::cos(dir), cur.1 + edge * jsnum::sin(dir));
        pts.push(next);
        cur = next;
        i += 1.0;
    }
    pts
}

/// Vieleck: `method` center (`center`, `r`, `dir`) oder edge (`a`, `b`), `sides`, `mode`.
fn polygon_ops(v: &Value, ctx: &Ctx, ids: &mut IdGen) -> Vec<Op> {
    let sides = n_of(v, "sides");
    let pts = if s_of(v, "method") == "edge" {
        let (a, b) = (p_of(v, "a"), p_of(v, "b"));
        if dist(a, b) < EPS {
            return Vec::new();
        }
        let mut p = polygon_from_edge(a, b, sides);
        // Die Kanten-Endpunkte sind die Klickpunkte selbst.
        let mut out = vec![pt_val(v, "a"), pt_val(v, "b")];
        out.extend(p.drain(2..).map(pv));
        Value::Array(out)
    } else {
        let (c, dir) = (p_of(v, "center"), opt_p(v, "dir"));
        // Radius getippt oder Abstand zum Klickpunkt (`dir`).
        let r = opt_n(v, "r").unwrap_or_else(|| dir.map_or(f64::NAN, |d| dist(c, d)));
        if r < EPS {
            return Vec::new();
        }
        pvs(&polygon_pts(c, r, sides, s_of(v, "mode") == "circumscribed", dir))
    };
    add_drawing(v, ctx, ids, obj(vec![("shape", s("polyline")), ("pts", pts), ("closed", Value::Bool(true))]))
}

/// Vieleck-Vorschau: center `pts = [Mitte, Cursor?]` (`info = [r]`), edge `pts = [a, Cursor]`.
fn polygon_preview(v: &Value, pts: &[V], p: &mut Preview) {
    let sides = n_of(v, "sides");
    if s_of(v, "method") == "edge" {
        if let [a, b] = pts {
            p.shapes.poly(&polygon_from_edge(*a, *b, sides));
        }
        return;
    }
    let Some(c) = pts.first() else { return };
    let dir = pts.get(1).copied();
    let r = dir.map_or(0.0, |d| dist(*c, d));
    p.info.push(r);
    if !(r < EPS) {
        p.shapes.poly(&polygon_pts(*c, r, sides, s_of(v, "mode") == "circumscribed", dir));
    }
}

fn spline_curve(pts: &[V], closed: bool, control: bool) -> Vec<V> {
    if pts.len() < 3 {
        return pts.to_vec();
    }
    let f: Vec<f64> = pts.iter().flat_map(|p| [p.0, p.1]).collect();
    let out = if control { crate::curves::uniform_bspline(&f, closed, 16.0) } else { crate::curves::catmull_rom(&f, closed, 16.0) };
    out.chunks_exact(2).map(|q| (q[0], q[1])).collect()
}

/// Spline-Vorschau (`pts` = Punkte + Cursor): geschlossen ab 3 Punkten.
fn spline_preview(v: &Value, pts: &[V], out: &mut Shapes) {
    let closed = b_of(v, "closed") && pts.len() >= 3;
    let c = spline_curve(pts, closed, s_of(v, "mode") == "control");
    if closed {
        out.poly(&c);
    } else {
        out.poly_open(&c);
    }
}

/// Bezier-Vorschau: Kette ab 4 Punkten (24 Schritte je Kurve).
fn bezier_preview(pts: &[V], out: &mut Shapes) {
    if pts.len() >= 4 {
        let f: Vec<f64> = pts.iter().flat_map(|p| [p.0, p.1]).collect();
        let c = crate::curves::bezier_chain(&f, 24.0);
        out.poly_open(&c.chunks_exact(2).map(|q| (q[0], q[1])).collect::<Vec<_>>());
    }
}

/// `bulge` einer Beule der Revisionswolke (`tan(Δ/4)`, Δ ≈ 100°).
const REVCLOUD_BULGE: f64 = 0.42;
/// Höchstzahl Beulen je Segment.
const MAX_BUMPS_PER_SEGMENT: f64 = 2000.0;

/// Revisionswolke: jedes Segment in gleich lange Beulen (Ziel-Bogenlänge `target`) zerlegen.
pub fn revision_cloud(points: &[V], closed: bool, target: f64) -> Option<(Vec<V>, Vec<f64>)> {
    if points.len() < 2 || !target.is_finite() || target <= 0.0 {
        return None;
    }
    let seg_count = if closed { points.len() } else { points.len() - 1 };
    let mut out = vec![points[0]];
    let mut bulge = Vec::new();
    for sgi in 0..seg_count {
        let (a, b) = (points[sgi], points[(sgi + 1) % points.len()]);
        let len = dist(a, b);
        if !len.is_finite() || len < 1e-9 {
            continue;
        }
        let n = jsnum::min(MAX_BUMPS_PER_SEGMENT, jsnum::max(1.0, jsnum::round(len / jsnum::max(target, 1e-9))));
        let n = n as usize;
        for i in 1..=n {
            let t = i as f64 / n as f64;
            out.push((a.0 + (b.0 - a.0) * t, a.1 + (b.1 - a.1) * t));
            bulge.push(REVCLOUD_BULGE);
        }
    }
    if closed {
        out.pop();
    }
    if out.len() < 2 {
        return None;
    }
    Some((out, bulge))
}

// ═════════════════════════════════════════════════════════════════════════════
// Mehrfachlinie, Symbole, Block
// ═════════════════════════════════════════════════════════════════════════════

fn side_sign(a: V, b: V, p: V) -> f64 {
    let m = mid(a, b);
    let u = normalize((b.0 - a.0, b.1 - a.1));
    let n = (-u.1, u.0);
    if (p.0 - m.0) * n.0 + (p.1 - m.1) * n.1 >= 0.0 {
        1.0
    } else {
        -1.0
    }
}

fn multiline_pairs(a: V, b: V, spacing: f64, sign: f64, count: f64) -> Vec<(V, V)> {
    let mut out = vec![(a, b)];
    let mut kk = 1.0;
    while kk < count && out.len() < 1000 {
        let (pa, pb) = k::offset_segment(to_p(a), to_p(b), sign * spacing * kk);
        out.push((of(pa), of(pb)));
        kk += 1.0;
    }
    out
}

/// Mehrfachlinie: `a`, `b`, `spacing`, `count`, `sign` (oder `side` = Punkt, dessen Seite zählt).
fn multiline_ops(v: &Value, ctx: &Ctx, ids: &mut IdGen) -> Vec<Op> {
    let (a, b) = (p_of(v, "a"), p_of(v, "b"));
    if seg_len(a, b) < EPS {
        return Vec::new();
    }
    let sign = match opt_p(v, "side") {
        Some(p) => side_sign(a, b, p),
        None => n_of(v, "sign"),
    };
    let pairs = multiline_pairs(a, b, n_of(v, "spacing"), sign, n_of(v, "count"));
    let items = pairs
        .into_iter()
        .enumerate()
        .map(|(i, (pa, pb))| {
            let (ga, gb) = if i == 0 { (pt_val(v, "a"), pt_val(v, "b")) } else { (pv(pa), pv(pb)) };
            drawing(ids.next("dr2d"), ctx, obj(vec![("shape", s("line")), ("a", ga), ("b", gb)]))
        })
        .collect();
    add_op("drawings2d", items)
}

/// `pts = [a, b, Cursor?]`: Original + Kopien auf der Seite `sign` (fehlt sie: Seite des Cursors);
/// `info = [Seite des Cursors]`.
fn multiline_preview(v: &Value, pts: &[V], p: &mut Preview) {
    let (a, b) = match pts {
        [a, b, ..] => (*a, *b),
        _ => return,
    };
    let side = pts.get(2).map(|c| side_sign(a, b, *c));
    let sign = opt_n(v, "sign").or(side).unwrap_or(f64::NAN);
    p.info.push(side.unwrap_or(f64::NAN));
    for (pa, pb) in multiline_pairs(a, b, n_of(v, "spacing"), sign, n_of(v, "count")) {
        p.shapes.line(pa, pb);
    }
}

/// Mindestgrösse eines Textrahmens als Vielfaches der Schrifthöhe (0.2 m bei 0.25 m Schrift).
const TEXTBOX_MIN_PER_HEIGHT: f64 = 0.8;

fn text_geom(ctx: &Ctx, at: Value, extra: Vec<(&str, Value)>) -> Value {
    let mut f = vec![("shape", s("text")), ("at", at), ("text", s("")), ("height", js_num(ctx.text_height)), ("angle", js_num(0.0))];
    f.extend(extra);
    obj(f)
}

/// Textrahmen aus zwei Ecken: Anker oben links (eine Zeile tief), Breite, Mindesthöhe.
fn textbox_frame(a: V, b: V, text_height: f64) -> (V, f64, f64) {
    let (mn, mx) = rect_geom(a, b);
    let min = TEXTBOX_MIN_PER_HEIGHT * text_height;
    let width = jsnum::max(min, mx.0 - mn.0);
    let height = jsnum::max(min, mx.1 - mn.1);
    ((mn.0, mx.1 - text_height), width, height)
}

fn kote_tri(at: V, kind: &str, f: f64) -> [V; 3] {
    let up = if kind == "okFertig" || kind == "okRoh" { 1.0 } else { -1.0 };
    let (size, half) = (0.15 * f, 0.15 * 0.6 * f);
    [at, (at.0 - half, at.1 + up * size), (at.0 + half, at.1 + up * size)]
}

fn block_ops(v: &Value, ctx: &Ctx, ids: &mut IdGen) -> Vec<Op> {
    let (at, p) = (p_of(v, "at"), p_of(v, "pt"));
    let d = hypot2(p.0 - at.0, p.1 - at.1);
    let (rot, scale) = if d < EPS { (0.0, 1.0) } else { (jsnum::atan2(p.1 - at.1, p.0 - at.0), d) };
    let def = v.get("def").cloned().unwrap_or(Value::Null);
    add_drawing(
        v,
        ctx,
        ids,
        obj(vec![("shape", s("block")), ("blockDefId", def), ("at", pt_val(v, "at")), ("rotation", js_num(rot)), ("scale", js_num(scale))]),
    )
}

// ═════════════════════════════════════════════════════════════════════════════
// Bemassung
// ═════════════════════════════════════════════════════════════════════════════

fn signed_offset(a: V, b: V, p: V) -> f64 {
    let (dx, dy) = (b.0 - a.0, b.1 - a.1);
    let len = hypot2(dx, dy);
    if len < EPS {
        return 0.0;
    }
    let (nx, ny) = (-dy / len, dx / len);
    (p.0 - a.0) * nx + (p.1 - a.1) * ny
}

fn project_on_line(p0: V, p1: V, p: V) -> V {
    let (dx, dy) = (p1.0 - p0.0, p1.1 - p0.1);
    let len2 = dx * dx + dy * dy;
    if len2 < EPS {
        return p;
    }
    let t = ((p.0 - p0.0) * dx + (p.1 - p0.1) * dy) / len2;
    (p0.0 + dx * t, p0.1 + dy * t)
}

fn offset_points(a: V, b: V, offset: f64) -> (V, V) {
    let (dx, dy) = (b.0 - a.0, b.1 - a.1);
    let l = hypot2(dx, dy);
    let len = if l == 0.0 || l.is_nan() { 1.0 } else { l };
    let (nx, ny) = ((-dy / len) * offset, (dx / len) * offset);
    ((a.0 + nx, a.1 + ny), (b.0 + nx, b.1 + ny))
}

/// Neuen Punkt in die Kette einsortieren (auf die Masslinie p0→p1 projiziert, nach Parameter).
fn insert_into_chain(pts: &[Value], raw: V) -> Vec<Value> {
    if pts.len() < 2 {
        let mut out = pts.to_vec();
        out.push(pv(raw));
        return out;
    }
    let (p0, p1) = (xy(&pts[0]), xy(&pts[1]));
    let (dx, dy) = (p1.0 - p0.0, p1.1 - p0.1);
    let l2 = dx * dx + dy * dy;
    let len2 = if l2 == 0.0 || l2.is_nan() { 1.0 } else { l2 };
    let t_of = |p: V| ((p.0 - p0.0) * dx + (p.1 - p0.1) * dy) / len2;
    let placed = project_on_line(p0, p1, raw);
    let nt = t_of(placed);
    let idx = pts.iter().position(|p| nt < t_of(xy(p))).unwrap_or(pts.len());
    let mut out = pts.to_vec();
    out.insert(idx, pv(placed));
    out
}

/// Bemassung: `pts`, `offset` (oder `side` = Punkt), `editId` (bestehende Kette ändern).
fn dimension_ops(root: &Map<String, Value>, v: &Value, ctx: &Ctx, ids: &mut IdGen) -> Vec<Op> {
    let raw = arr(v.get("pts"));
    let pts: Vec<V> = raw.iter().map(pair).collect();
    let offset = match opt_p(v, "side") {
        Some(p) if pts.len() >= 2 => signed_offset(pts[0], pts[1], p),
        Some(_) => f64::NAN,
        None => n_of(v, "offset"),
    };
    let cleaned: Vec<Value> = raw
        .iter()
        .enumerate()
        .filter(|(i, _)| *i == 0 || dist(pts[*i - 1], pts[*i]) >= EPS)
        .map(|(_, p)| if p.is_object() { p.clone() } else { pv(pair(p)) })
        .collect();
    if cleaned.len() < 2 {
        return Vec::new();
    }
    // Assoziativ ([38]): Punkte, die auf einem gefangenen Merkmal liegen, hängen daran; beim Ergänzen
    // behalten die alten Punkte ihre Bezüge.
    let chain: Vec<V> = cleaned.iter().map(pair).collect();
    let snaps: Vec<V> = arr(v.get("snaps")).iter().map(pair).collect();
    let old = v.get("editId").and_then(Value::as_str).and_then(|id| find(root, "drawings2d", id)).and_then(|d| field(d, "geom"));
    let old_pts: Vec<V> = old.map(|g| arr(field(g, "pts")).iter().map(pair).collect()).unwrap_or_default();
    let old_refs: Vec<Option<crate::model::DimRef>> = old.and_then(|g| field(g, "refs")).and_then(|r| serde_json::from_value(r.clone()).ok()).unwrap_or_default();
    let keep = |q: V| old_pts.iter().position(|o| dist(*o, q) < 1e-9).and_then(|i| old_refs.get(i).cloned().flatten());
    let refs = crate::dim_assoc::refs_for_chain(&crate::document::Lookup::plain(root), ctx.level, &chain, &snaps, &keep);
    let mut fields = vec![("shape", s("dimension")), ("pts", Value::Array(cleaned)), ("offset", js_num(offset))];
    if let Some(r) = refs {
        fields.push(("refs", serde_json::to_value(r).unwrap_or(Value::Null)));
    }
    let geom = obj(fields);
    match v.get("editId").and_then(Value::as_str) {
        Some(id) => match find(root, "drawings2d", id) {
            Some(d) => vec![Op::Replace { collection: "drawings2d".into(), entity: with(d, "geom", geom) }],
            None => Vec::new(),
        },
        None => add_drawing(v, ctx, ids, geom),
    }
}

// ── Achsraster ([112]) und Radius-/Bogenmass ([38]) ─────────────────────────

/// Geometrie des neuen Rasters: `at` (Ursprung), `xs`/`ys` (Feldweiten als Text), `radial`, `angle`
/// (Bogenmass), optional `extend`, `bubbles`, `levels`. `None` bei unlesbaren Feldweiten.
fn grid_geom(v: &Value) -> Option<Value> {
    let radial = b_of(v, "radial");
    let xs = crate::grid::parse_bays(s_of(v, "xs"))?;
    let ys = crate::grid::parse_bays(s_of(v, "ys")).or_else(|| (!radial).then(Vec::new).filter(|_| s_of(v, "ys").trim().is_empty()))?;
    let (a, b) = crate::grid::axes_from_bays(radial, &xs, &ys);
    let list = |l: &[crate::model::GridAxis]| Value::Array(l.iter().map(|x| obj(vec![("label", s(&x.label)), ("pos", js_num(x.pos))])).collect());
    let mut f = vec![("shape", s("grid")), ("origin", pt_val(v, "at")), ("angle", js_num(opt_n(v, "angle").unwrap_or(0.0))), ("a", list(&a)), ("b", list(&b))];
    if radial {
        f.push(("radial", Value::Bool(true)));
    }
    for k in ["extend", "bubbleMm"] {
        if let Some(x) = opt_n(v, k) {
            f.push((k, js_num(x)));
        }
    }
    if matches!(s_of(v, "bubbles"), "start" | "end" | "both") {
        f.push(("bubbles", s(s_of(v, "bubbles"))));
    }
    if let Some(l) = v.get("levels").filter(|l| l.as_array().is_some_and(|a| !a.is_empty())) {
        f.push(("levels", l.clone()));
    }
    Some(obj(f))
}

/// Vorschau des Rasters am Cursor: Achsen als Linien, Ringe als Polygonzug.
fn grid_preview(v: &Value, pts: &[V], p: &mut Preview) {
    let Some(at) = pts.first() else { return };
    let mut v2 = v.clone();
    v2["at"] = pv(*at);
    let Some(g) = grid_geom(&v2).and_then(|g| serde_json::from_value::<crate::model::Drawing2DGeom>(g).ok()) else { return };
    let Some(spec) = crate::grid::Spec::of(&g) else { return };
    p.ok = true;
    for ax in spec.axes() {
        match ax.shape {
            crate::grid::Shape::Line { a, b } => p.shapes.line(a, b),
            crate::grid::Shape::Arc { c, r, a0, a1 } => {
                let n = (((a1 - a0).abs() / (PI / 24.0)).ceil() as usize).clamp(2, 400);
                let q: Vec<V> = (0..=n).map(|i| a0 + (a1 - a0) * i as f64 / n as f64).map(|t| (c.0 + r * jsnum::cos(t), c.1 + r * jsnum::sin(t))).collect();
                p.shapes.poly_open(&q);
            }
        }
    }
}

fn dim_kind(v: &Value) -> Option<crate::model::DimKind> {
    use crate::model::DimKind;
    match s_of(v, "kind") {
        "radius" => Some(DimKind::Radius),
        "diameter" => Some(DimKind::Diameter),
        "arc" => Some(DimKind::Arc),
        _ => None,
    }
}

/// Toleranz beim Treffen eines Kreises/Bogens (Modell-Meter, `tol` der Anfrage).
fn round_tol(v: &Value) -> f64 {
    opt_n(v, "tol").filter(|t| *t > 0.0).unwrap_or(0.15)
}

/// Radius-/Durchmesser-/Bogenlängen-Mass: Klicks auf dem Rand eines Kreises, Bogens oder einer
/// Bogenwand; Mittelpunkt und Randpunkte hängen daran (`refs`). Bogenlänge: `side` (Punkt der
/// Masslinie) oder `offset` bestimmt den Abstand vom Bogen.
fn dimround_ops(root: &Map<String, Value>, v: &Value, ctx: &Ctx, ids: &mut IdGen) -> Vec<Op> {
    use crate::model::DimKind;
    let Some(kind) = dim_kind(v) else { return Vec::new() };
    let clicks: Vec<V> = arr(v.get("pts")).iter().map(pair).collect();
    let lk = crate::document::Lookup::plain(root);
    let Some((pts, refs)) = crate::dim_assoc::round_dimension(&lk, ctx.level, kind, &clicks, round_tol(v)) else { return Vec::new() };
    let offset = match (kind, opt_p(v, "side")) {
        (DimKind::Arc, Some(side)) => hypot2(side.0 - pts[0].0, side.1 - pts[0].1) - hypot2(pts[1].0 - pts[0].0, pts[1].1 - pts[0].1),
        (DimKind::Arc, None) => opt_n(v, "offset").unwrap_or(0.5),
        _ => 0.0,
    };
    let kind_s = match kind {
        DimKind::Radius => "radius",
        DimKind::Diameter => "diameter",
        DimKind::Arc => "arc",
    };
    let geom = obj(vec![
        ("shape", s("dimension")),
        ("pts", pvs(&pts)),
        ("offset", js_num(offset)),
        ("kind", s(kind_s)),
        ("refs", serde_json::to_value(refs).unwrap_or(Value::Null)),
    ]);
    add_drawing(v, ctx, ids, geom)
}

/// Vorschau: Radius-/Durchmesserlinie bzw. Bogen zwischen den Klicks (Cursor = letzter Punkt).
fn dimround_preview(root: &Map<String, Value>, v: &Value, ctx: &Ctx, pts: &[V], p: &mut Preview) {
    use crate::model::DimKind;
    let Some(kind) = dim_kind(v) else { return };
    let lk = crate::document::Lookup::plain(root);
    let tol = round_tol(v);
    let arc_phase = kind == DimKind::Arc;
    // Klickpunkte: bei der Bogenlänge die ersten zwei (Cursor als zweiter, solange er läuft).
    let clicks: Vec<V> = if arc_phase { pts.iter().take(2).copied().collect() } else { pts.iter().take(1).copied().collect() };
    let Some((q, _)) = crate::dim_assoc::round_dimension(&lk, ctx.level, kind, &clicks, tol).or_else(|| crate::dim_assoc::round_dimension(&lk, ctx.level, kind, &clicks[..1], tol).filter(|_| arc_phase)) else { return };
    p.ok = true;
    let c = q[0];
    match kind {
        DimKind::Radius => p.shapes.line(c, q[1]),
        DimKind::Diameter => p.shapes.line((2.0 * c.0 - q[1].0, 2.0 * c.1 - q[1].1), q[1]),
        DimKind::Arc => {
            let r = hypot2(q[1].0 - c.0, q[1].1 - c.1);
            let a0 = angle(c, q[1]);
            let a1 = if q.len() > 2 { angle(c, q[2]) } else { a0 };
            let sweep = (a1 - a0).rem_euclid(TAU);
            let off = pts.get(2).map_or(0.0, |s| hypot2(s.0 - c.0, s.1 - c.1) - r);
            let n = ((sweep / (PI / 24.0)).ceil() as usize).clamp(1, 400);
            let poly: Vec<V> = (0..=n).map(|i| a0 + sweep * i as f64 / n as f64).map(|t| (c.0 + (r + off) * jsnum::cos(t), c.1 + (r + off) * jsnum::sin(t))).collect();
            p.shapes.poly_open(&poly);
            p.info.push(r * sweep);
        }
    }
}

/// Bemassungs-Vorschau. `phase` next: `pts` = Kette + roher Cursor → Kette bis zum (auf die Masslinie
/// projizierten) Cursor, `info = [cx, cy]`; offset: `pts` = Kette + Cursor (oder ohne → Abstand 0),
/// Hilfs- und Masslinien, `info = [Abstand, Summe]`.
fn dimension_preview(v: &Value, pts: &[V], p: &mut Preview) {
    if pts.is_empty() {
        return;
    }
    let has_cursor = b_of(v, "cursor");
    let chain = if has_cursor { &pts[..pts.len() - 1] } else { pts };
    if s_of(v, "phase") == "next" {
        let raw = pts[pts.len() - 1];
        let c = if chain.len() >= 2 { project_on_line(chain[0], chain[1], raw) } else { raw };
        p.info.extend([c.0, c.1]);
        let mut shown = chain.to_vec();
        shown.push(c);
        p.shapes.poly_open(&shown);
        return;
    }
    if chain.len() < 2 {
        return;
    }
    let off = if has_cursor { signed_offset(chain[0], chain[1], pts[pts.len() - 1]) } else { 0.0 };
    let mut total = 0.0;
    for (i, w) in chain.windows(2).enumerate() {
        let (a, b) = (w[0], w[1]);
        if off.abs() > EPS {
            let (oa, ob) = offset_points(a, b, off);
            p.shapes.line(a, oa);
            p.shapes.line(b, ob);
            p.shapes.line(oa, ob);
        } else {
            p.shapes.line(a, b);
        }
        total = if i == 0 { dist(a, b) } else { total + dist(a, b) };
    }
    p.info.extend([off, total]);
}

// ── Aussenbemassung ──────────────────────────────────────────────────────────

/// Aussenbemassung des Geschosses `level` (Ketten aus `auto_dimensions`), ids `prefix-Geschoss-Seite-Kette`.
fn auto_dims(root: &Map<String, Value>, ctx: &Ctx, prefix: &str, scale: f64) -> Vec<Value> {
    use crate::auto_dimensions::{auto_exterior_dimensions, OpeningIn, WallIn};
    let types = wall_types(root);
    let walls: Vec<&Value> = arr(root.get("walls")).iter().filter(|w| crate::cmd_create::floor_of(w) == Some(ctx.level)).collect();
    if walls.is_empty() {
        return Vec::new();
    }
    let p = |w: &Value, k: &str| xy(field(w, k).unwrap_or(&Value::Null));
    let win: Vec<WallIn> = walls
        .iter()
        .map(|w| {
            let tid = field(w, "wallTypeId").and_then(Value::as_str);
            let th = types.iter().find(|t| id_of(t) == tid).map_or(0.3, type_thickness);
            let (a, b) = (p(w, "start"), p(w, "end"));
            // Wandmitte gegenüber der Achse (Referenzlinie links/rechts bzw. -versatz, wie `dim_assoc`).
            let half = th / 2.0;
            let shift = match (field(w, "referenceOffset").and_then(Value::as_f64), field(w, "referenceLine").and_then(Value::as_str)) {
                (Some(v), _) => v.clamp(-half, half),
                (None, Some("left")) => half,
                (None, Some("right")) => -half,
                _ => 0.0,
            };
            WallIn { start: [a.0, a.1], end: [b.0, b.1], thickness: th, shift }
        })
        .collect();
    let mut oin = Vec::new();
    for o in arr(root.get("openings")) {
        let host = field(o, "hostWallId").and_then(Value::as_str);
        let Some(i) = walls.iter().position(|w| id_of(w) == host) else { continue };
        let (a, b) = (p(walls[i], "start"), p(walls[i], "end"));
        let axis = dist(a, b);
        let (pos, width) = (num_of(field(o, "position")), num_of(field(o, "width")));
        let from = jsnum::max(0.0, jsnum::min(pos, axis));
        let to = jsnum::max(from, jsnum::min(pos + width, axis));
        if to - from < 1e-4 {
            continue;
        }
        let u = normalize((b.0 - a.0, b.1 - a.1));
        let at = |d: f64| [a.0 + u.0 * d, a.1 + u.1 * d];
        oin.push(OpeningIn { wall: i, jamb_start: at(from), jamb_end: at(to) });
    }
    const SIDES: [&str; 4] = ["south", "east", "north", "west"];
    const CHAINS: [&str; 3] = ["openings", "steps", "total"];
    let lk = crate::document::Lookup::plain(root);
    auto_exterior_dimensions(&win, &oin, scale)
        .into_iter()
        .map(|c| {
            let id = format!("{prefix}-{}-{}-{}", ctx.level, SIDES[c.side as usize], CHAINS[c.chain as usize]);
            let pts = Value::Array(c.pts.iter().map(|q| crate::grips::pt(q[0], q[1])).collect());
            let mut fields = vec![("shape", s("dimension")), ("pts", pts), ("offset", js_num(c.offset))];
            // Assoziativ ([38]): je Punkt das Merkmal (Ecke, Leibung), aus dem er stammt.
            let chain: Vec<V> = c.pts.iter().map(|q| (q[0], q[1])).collect();
            let src: Vec<V> = c.src.iter().map(|q| (q[0], q[1])).collect();
            if let Some(r) = crate::dim_assoc::refs_for_chain(&lk, ctx.level, &chain, &src, &|_| None) {
                fields.push(("refs", serde_json::to_value(r).unwrap_or(Value::Null)));
            }
            drawing(id, ctx, obj(fields))
        })
        .collect()
}

fn autodim_ops(root: &Map<String, Value>, ctx: &Ctx) -> Vec<Op> {
    let dims = auto_dims(root, ctx, "autodim", 100.0);
    if dims.is_empty() {
        return Vec::new();
    }
    let own = format!("autodim-{}-", ctx.level);
    let old: Vec<&str> = arr(root.get("drawings2d")).iter().filter_map(id_of).filter(|id| id.starts_with(&own)).collect();
    let mut ops = crate::cmd_create::remove_op(root, "drawings2d", &old);
    ops.extend(add_op("drawings2d", dims));
    ops
}

// ═════════════════════════════════════════════════════════════════════════════
// Einstiege (über `cmd_create`)
// ═════════════════════════════════════════════════════════════════════════════

/// Ops eines 2D-Zeichenbefehls (`None` = keiner dieses Moduls).
pub fn ops(root: &Map<String, Value>, v: &Value, ctx: &Ctx, ids: &mut IdGen) -> Option<Vec<Op>> {
    let geom2 = |shape: &str| obj(vec![("shape", s(shape)), ("a", pt_val(v, "a")), ("b", pt_val(v, "b"))]);
    Some(match s_of(v, "cmd") {
        "line" | "xline" | "ray" => add_drawing(v, ctx, ids, geom2(s_of(v, "cmd"))),
        "polyline" => polyline_ops(v, ctx, ids),
        "rect" => rect_ops(v, ctx, ids),
        "circle" => circle_ops(v, ctx, ids),
        "arc" => arc_ops(v, ctx, ids),
        "ellipse" => ellipse_ops(v, ctx, ids),
        "polygon" => polygon_ops(v, ctx, ids),
        "spline" => add_drawing(
            v,
            ctx,
            ids,
            obj(vec![("shape", s("spline")), ("pts", pts_val(v, "pts")), ("closed", Value::Bool(b_of(v, "closed"))), ("mode", s(s_of(v, "mode")))]),
        ),
        "bezier" => {
            if arr(v.get("pts")).len() < 4 {
                return Some(Vec::new());
            }
            add_drawing(v, ctx, ids, obj(vec![("shape", s("bezier")), ("pts", pts_val(v, "pts"))]))
        }
        "revcloud" => {
            let closed = b_of(v, "closed");
            match revision_cloud(&pts_of(v, "pts"), closed, n_of(v, "arcSize")) {
                Some((p, b)) => add_drawing(
                    v,
                    ctx,
                    ids,
                    obj(vec![
                        ("shape", s("polyline")),
                        ("pts", pvs(&p)),
                        ("closed", Value::Bool(closed)),
                        ("bulge", Value::Array(b.iter().map(|x| js_num(*x)).collect())),
                    ]),
                ),
                None => Vec::new(),
            }
        }
        "wipeout" => {
            let g = obj(vec![("shape", s("polyline")), ("pts", pts_val(v, "pts")), ("closed", Value::Bool(true))]);
            let mut d = drawing(id_or_new(v, ids), ctx, g);
            if let Some(m) = d.as_object_mut() {
                m.insert("background".into(), s("#ffffff"));
                m.insert("color".into(), s("#ffffff"));
            }
            add_op("drawings2d", vec![d])
        }
        "multiline" => multiline_ops(v, ctx, ids),
        "text" => add_drawing(v, ctx, ids, text_geom(ctx, pt_val(v, "at"), vec![])),
        "textbox" => {
            let (at, width, _) = textbox_frame(p_of(v, "a"), p_of(v, "b"), ctx.text_height);
            add_drawing(v, ctx, ids, text_geom(ctx, pv(at), vec![("width", js_num(width))]))
        }
        "textpath" => {
            let pts = pts_val(v, "pts");
            let at = pts.get(0).cloned().unwrap_or(Value::Null);
            add_drawing(v, ctx, ids, text_geom(ctx, at, vec![("pathPts", pts)]))
        }
        "leader" => {
            let mut extra = vec![("leaderTarget", pt_val(v, "target"))];
            let bends = pts_val(v, "bends");
            if bends.as_array().is_some_and(|b| !b.is_empty()) {
                extra.push(("leaderBendPoints", bends));
            }
            add_drawing(v, ctx, ids, text_geom(ctx, pt_val(v, "at"), extra))
        }
        "kote" => add_drawing(
            v,
            ctx,
            ids,
            obj(vec![("shape", s("kote")), ("at", pt_val(v, "at")), ("value", js_num(n_of(v, "value"))), ("kind", s(s_of(v, "kind"))), ("rotation", js_num(0.0))]),
        ),
        "detailref" => add_drawing(v, ctx, ids, obj(vec![("shape", s("detailref")), ("at", pt_val(v, "at")), ("label", s("A"))])),
        "scalebar" => add_drawing(
            v,
            ctx,
            ids,
            obj(vec![("shape", s("scalebar")), ("at", pt_val(v, "at")), ("segmentLength", js_num(n_of(v, "length"))), ("segments", js_num(n_of(v, "segments")))]),
        ),
        "pointmarker" => add_drawing(v, ctx, ids, obj(vec![("shape", s("pointmarker")), ("at", pt_val(v, "at"))])),
        "block" => block_ops(v, ctx, ids),
        "grid" => match grid_geom(v) {
            Some(g) => add_drawing(v, ctx, ids, g),
            None => Vec::new(),
        },
        "dimround" => dimround_ops(root, v, ctx, ids),
        "dimension" => dimension_ops(root, v, ctx, ids),
        "autodim" => autodim_ops(root, ctx),
        _ => return None,
    })
}

/// Vorschau eines 2D-Zeichenbefehls (`false` = keiner dieses Moduls).
pub fn preview(root: &Map<String, Value>, v: &Value, ctx: &Ctx, pts: &[V], p: &mut Preview) -> bool {
    match s_of(v, "cmd") {
        "xline" | "ray" => {
            if let [a, c] = pts {
                let l = seg_len(*a, *c);
                if l >= EPS {
                    let (ux, uy) = ((c.0 - a.0) / seg_len(*a, *c), (c.1 - a.1) / seg_len(*a, *c));
                    let end = (c.0 + ux * 30.0, c.1 + uy * 30.0);
                    let start = if s_of(v, "cmd") == "xline" { (a.0 - ux * 30.0, a.1 - uy * 30.0) } else { *a };
                    p.shapes.line(start, end);
                }
            }
        }
        "polyline" => polyline_preview(v, pts, &mut p.shapes),
        "rect" => rect_preview(v, pts, &mut p.shapes, &mut p.info),
        "circle" => circle_preview(v, pts, p),
        "arc" => arc_preview(v, pts, p),
        "ellipse" => ellipse_preview(v, pts, p),
        "polygon" => polygon_preview(v, pts, p),
        "spline" => spline_preview(v, pts, &mut p.shapes),
        "bezier" => bezier_preview(pts, &mut p.shapes),
        "revcloud" => {
            let shown = revision_cloud(pts, false, n_of(v, "arcSize")).map_or_else(Vec::new, |(q, b)| bulge_points(&q, &b, false));
            p.shapes.poly_open(&shown);
        }
        "multiline" => multiline_preview(v, pts, p),
        "textbox" => {
            if let [a, b] = pts {
                let (mn, mx) = rect_geom(*a, *b);
                let (_, w, h) = textbox_frame(*a, *b, ctx.text_height);
                p.info.extend([w, h]);
                p.shapes.poly(&corners_of(mn, mx));
            }
        }
        "kote" => {
            if let Some(at) = pts.first() {
                p.shapes.poly(&kote_tri(*at, s_of(v, "kind"), ctx.symbol));
            }
        }
        "detailref" => {
            if let Some(at) = pts.first() {
                p.shapes.poly(&circle_pts(*at, 0.3 * ctx.symbol, 32));
            }
        }
        "pointmarker" => {
            if let Some(at) = pts.first() {
                let (r, c) = (0.08 * ctx.symbol, 0.12 * ctx.symbol);
                p.shapes.poly(&circle_pts(*at, r, 32));
                p.shapes.line((at.0 - c, at.1), (at.0 + c, at.1));
                p.shapes.line((at.0, at.1 - c), (at.0, at.1 + c));
            }
        }
        "scalebar" => {
            if let Some(at) = pts.first() {
                let (len, n) = (n_of(v, "length"), n_of(v, "segments"));
                let h = len * 0.06;
                let mut i = 0.0;
                while i < n && i < 1000.0 {
                    let x0 = at.0 + i * len;
                    let x1 = x0 + len;
                    p.shapes.poly(&[(x0, at.1), (x1, at.1), (x1, at.1 + h), (x0, at.1 + h)]);
                    i += 1.0;
                }
            }
        }
        "dimension" => dimension_preview(v, pts, p),
        "grid" => grid_preview(v, pts, p),
        "dimround" => dimround_preview(root, v, ctx, pts, p),
        "autodim" => p.ok = !auto_dims(root, ctx, "autodim", 100.0).is_empty(),
        _ => return false,
    }
    true
}

/// Treffer-Abfragen der 2D-Befehle (`None` = keine dieses Moduls).
pub fn query(root: &Map<String, Value>, v: &Value) -> Option<Value> {
    let at = p_of(v, "pt");
    Some(match s_of(v, "q") {
        "pickTangent" => match pick_tangent(root, s_of(v, "level"), at) {
            Some((t, d)) => json!({ "hit": { "target": target_json(&t), "id": id_of(d) } }),
            None => json!({ "hit": null }),
        },
        "dimChain" => {
            let d = find(root, "drawings2d", s_of(v, "id")).filter(|d| {
                field(d, "geom").and_then(|g| field(g, "shape")).and_then(Value::as_str) == Some("dimension")
            });
            match d {
                Some(d) => {
                    let g = field(d, "geom").unwrap_or(&Value::Null);
                    json!({ "hit": { "id": id_of(d), "pts": field(g, "pts").cloned().unwrap_or(Value::Null), "offset": field(g, "offset").cloned().unwrap_or(Value::Null) } })
                }
                None => json!({ "hit": null }),
            }
        }
        "dimInsert" => json!({ "pts": insert_into_chain(arr(v.get("pts")), at) }),
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx() -> Ctx<'static> {
        Ctx { level: "L", floor_height: None, cat: "20", wall_type: "", text_height: crate::cmd_create::DEFAULT_TEXT_HEIGHT, symbol: 1.0 }
    }

    #[test]
    fn schrifthoehe_aus_dem_kontext() {
        // Grundriss: Vorgabe 0.25 m; Layout-Blatt (Papier 1:1): die Papierhöhe aus `textHeight`.
        let v = json!({"cmd": "text", "at": {"x": 0.1, "y": -0.1}, "ctx": {"level": "blatt", "cat": "20", "textHeight": 0.0035}});
        let c = crate::cmd_create::ctx_of(&v);
        assert_eq!(c.text_height, 0.0035);
        let o = ops(&Map::new(), &v, &c, &mut IdGen::new("s")).unwrap();
        assert_eq!(o[0].to_json()["items"][0]["geom"]["height"], 0.0035);
        let plain = json!({"ctx": {"level": "eg", "textHeight": -1}});
        assert_eq!(crate::cmd_create::ctx_of(&plain).text_height, crate::cmd_create::DEFAULT_TEXT_HEIGHT);
        // Textrahmen: Mindestgrösse folgt der Schrifthöhe, Anker eine Zeile unter der Oberkante.
        let (at, w, h) = textbox_frame((0.0, 0.0), (0.0001, -0.0001), 0.0035);
        assert!((w - 0.0028).abs() < 1e-12 && (h - 0.0028).abs() < 1e-12);
        assert!((at.1 - (0.0 - 0.0035)).abs() < 1e-12);
    }

    /// [112] Befehl „Achsraster": Feldweiten als Text → Achsen 1, 2, 3 / A, B …; unlesbar → nichts.
    #[test]
    fn achsraster_befehl() {
        let v = json!({"cmd": "grid", "at": {"x": 1, "y": 2}, "xs": "5 3x6", "ys": "4,5 4", "angle": 0, "bubbles": "end", "levels": ["L"]});
        let o = ops(&Map::new(), &v, &ctx(), &mut IdGen::new("s")).unwrap();
        let g = &o[0].to_json()["items"][0]["geom"];
        assert_eq!(g["shape"], "grid");
        assert_eq!(g["a"].as_array().unwrap().len(), 5);
        assert_eq!(g["a"][4]["pos"], 23);
        assert_eq!(g["b"][2]["label"], "C");
        assert_eq!(g["b"][2]["pos"], 8.5);
        assert_eq!(g["bubbles"], "end");
        assert_eq!(g["origin"]["x"], 1);
        assert!(serde_json::from_value::<crate::model::Drawing2DGeom>(g.clone()).is_ok());
        // Ohne `angle` (Befehl aus der Hülle) gilt 0; leere Querachsen sind erlaubt.
        let bare = json!({"cmd": "grid", "at": [0, 0], "xs": "5", "ys": ""});
        let o2 = ops(&Map::new(), &bare, &ctx(), &mut IdGen::new("s")).unwrap();
        assert_eq!(o2[0].to_json()["items"][0]["geom"]["angle"], 0);
        let bad = json!({"cmd": "grid", "at": {"x": 0, "y": 0}, "xs": "x", "ys": ""});
        assert!(ops(&Map::new(), &bad, &ctx(), &mut IdGen::new("s")).unwrap().is_empty());
        // Vorschau am Cursor.
        let mut p = Preview { shapes: Shapes::default(), ok: false, info: vec![] };
        grid_preview(&v, &[(0.0, 0.0)], &mut p);
        assert!(p.ok && !p.shapes.buf.is_empty());
    }

    /// [38] Befehl Radius/Bogenmass: trifft den Kreis, hängt Mittelpunkt und Rand an.
    #[test]
    fn rundmass_befehl() {
        let root = json!({"drawings2d": [{"id": "K", "levelId": "L", "categoryCode": "20", "geom": {"shape": "circle", "center": {"x": 1, "y": 1}, "r": 2}}]});
        let root = root.as_object().unwrap().clone();
        let v = json!({"cmd": "dimround", "kind": "diameter", "pts": [[3.01, 1.0]]});
        let o = ops(&root, &v, &ctx(), &mut IdGen::new("s")).unwrap();
        let g = &o[0].to_json()["items"][0]["geom"];
        assert_eq!(g["kind"], "diameter");
        assert_eq!(g["refs"][0]["feature"], "center");
        assert_eq!(g["refs"][1]["feature"], "rim");
        let v = json!({"cmd": "dimround", "kind": "arc", "pts": [[3.0, 1.0], [1.0, 3.0]], "side": [1.0, 4.0]});
        let g = &ops(&root, &v, &ctx(), &mut IdGen::new("s")).unwrap()[0].to_json()["items"][0]["geom"];
        assert_eq!(g["pts"].as_array().unwrap().len(), 3);
        assert!((g["offset"].as_f64().unwrap() - 1.0).abs() < 1e-9);
        // Kein Kreis in der Nähe → nichts.
        let far = json!({"cmd": "dimround", "kind": "radius", "pts": [[50.0, 50.0]]});
        assert!(ops(&root, &far, &ctx(), &mut IdGen::new("s")).unwrap().is_empty());
    }

    #[test]
    fn revisionswolke_beulen() {
        assert!(revision_cloud(&[(0.0, 0.0)], false, 0.3).is_none());
        let (p, b) = revision_cloud(&[(0.0, 0.0), (2.0, 0.0)], false, 0.5).unwrap();
        assert_eq!(p.len(), 5);
        assert!(b.iter().all(|x| *x == REVCLOUD_BULGE));
        let (p, _) = revision_cloud(&[(0.0, 0.0), (1.0, 0.0), (1.0, 1.0)], true, 1.0).unwrap();
        assert_eq!(p.len(), 3);
    }

    #[test]
    fn polylinie_tangential_und_schluss() {
        let v = json!({"cmd": "polyline", "pts": [[0, 0], [2, 0], [2, 2]], "segs": [0, 1], "closed": true, "closing": 0});
        let o = ops(&Map::new(), &v, &ctx(), &mut IdGen::new("s")).unwrap();
        let g = &o[0].to_json()["items"][0]["geom"];
        assert_eq!(g["bulge"].as_array().unwrap().len(), 3);
        assert!(g["bulge"][1].as_f64().unwrap().abs() > 0.1);
        assert_eq!(g["bulge"][2], 0);
    }

    #[test]
    fn rechteck_gerundet_und_kreis_durch_drei_punkte() {
        let v = json!({"cmd": "rect", "method": "corner", "a": [0, 0], "b": [2, 1], "radius": 0.1});
        let o = ops(&Map::new(), &v, &ctx(), &mut IdGen::new("s")).unwrap();
        assert_eq!(o[0].to_json()["items"][0]["geom"]["pts"].as_array().unwrap().len(), 8);
        let v = json!({"cmd": "circle", "method": "threePoint", "pts": [[1, 0], [0, 1], [-1, 0]]});
        let o = ops(&Map::new(), &v, &ctx(), &mut IdGen::new("s")).unwrap();
        assert_eq!(o[0].to_json()["items"][0]["geom"]["r"], 1);
    }

    #[test]
    fn bemassung_einsortieren_und_kette_aendern() {
        let pts = vec![pv((0.0, 0.0)), pv((4.0, 0.0))];
        let out = insert_into_chain(&pts, (2.0, 1.0));
        assert_eq!(out[1], json!({"x": 2, "y": 0}));
        let root = json!({"drawings2d": [{"id": "d", "levelId": "L", "geom": {"shape": "dimension", "pts": [], "offset": 0}}]});
        let v = json!({"cmd": "dimension", "pts": [[0, 0], [4, 0]], "side": [1, 1], "editId": "d"});
        let o = ops(root.as_object().unwrap(), &v, &ctx(), &mut IdGen::new("s")).unwrap();
        assert_eq!(o[0].to_json()["entity"]["geom"]["offset"], 1);
    }
}
