//! Körper, Gelände und Sonderbefehle im Kern ([K4] S3, vorher `commands/cmds/{solid,solidbool,voidbox,
//! terrain,ceilingOpening,roofHole,sectionline}.ts`): Grundkörper (B-Rep-Beschreibung für truck),
//! Boolesche Körper, Aussparungs-Quader, Gelände-TIN aus Höhenlinien, Decken-Aussparung, Dach-Hof und
//! Schnitt-/Ansichtslinie — Ops, Vorschau und Treffer. Dazu die B-Rep-Beschreibung eines Körpers
//! (`extrudedSolidSpec`, auch für 3D, Schnitt und STEP) und das Gelände aus Höhenlinien
//! (`generateTerrainFromContours`, auch für das Lage-Panel). Einstieg über `cmd_create`.

use crate::cmd_create::{add_op, circle_pts, find, n_of, obj, opt_p, p_of, pts_of, pv, pvs, rect_corners, s, s_of, Ctx, Preview, V};
use crate::cmd_transform::{IdGen, Shapes};
use crate::grips::{arr, field, js_num, num_of, num_or, truthy, with, xy};
use crate::jsmath::hypot2;
use crate::jsnum;
use crate::ops::{id_of, Op};
use serde_json::{json, Map, Value};

fn fixed2(x: f64) -> String {
    crate::js_fmt::to_fixed(x, 2)
}

fn level_of(e: &Value) -> Option<&str> {
    field(e, "levelId").and_then(Value::as_str)
}

// ═════════════════════════════════════════════════════════════════════════════
// B-Rep-Beschreibung eines Körpers (`extrudedSolidSpec`)
// ═════════════════════════════════════════════════════════════════════════════

/// B-Rep-Beschreibung (`SolidSpec`) eines Körpers mit UK auf Geschoss-Höhe `floor_z` (+ `baseOffset`);
/// `None`, wenn truck dafür keine Beschreibung hat (Pyramide, entartet).
pub fn extruded_solid_spec(solid: &Value, floor_z: f64) -> Option<Value> {
    let base_z = floor_z + num_or(field(solid, "baseOffset"), 0.0);
    let points = arr(field(solid, "points"));
    if let Some(brep) = field(solid, "brep").filter(|b| truthy(Some(b))) {
        let (dx, dy) = match points.first() {
            Some(p0) => {
                let (o, p) = (xy(field(brep, "origin").unwrap_or(&Value::Null)), xy(p0));
                (p.0 - o.0, p.1 - o.1)
            }
            None => (0.0, 0.0),
        };
        let spec = field(brep, "spec").cloned().unwrap_or(Value::Null);
        return Some(obj(vec![("kind", s("translate")), ("v", json!([js_num(dx), js_num(dy), js_num(base_z)])), ("solid", spec)]));
    }
    let height = num_of(field(solid, "height"));
    if points.len() < 3 || height <= 0.0 {
        return None;
    }
    let taper = jsnum::min(1.0, jsnum::max(0.0, num_or(field(solid, "taper"), 0.0)));
    let circle = field(solid, "circle").filter(|c| truthy(Some(c)));
    if let Some(c) = circle {
        if taper < 1e-6 || taper >= 1.0 - 1e-6 {
            let ctr = xy(field(c, "center").unwrap_or(&Value::Null));
            let kind = if taper < 1e-6 { "cylinder" } else { "cone" };
            return Some(obj(vec![
                ("kind", s(kind)),
                ("cx", js_num(ctr.0)),
                ("cy", js_num(ctr.1)),
                ("z0", js_num(base_z)),
                ("r", js_num(num_of(field(c, "r")))),
                ("height", js_num(height)),
            ]));
        }
    }
    let pts: Vec<V> = points.iter().map(xy).collect();
    let flat = |ps: &[V]| Value::Array(ps.iter().flat_map(|p| [js_num(p.0), js_num(p.1)]).collect());
    if taper < 1e-6 {
        let mut f = vec![("kind", s("extrude")), ("points", flat(&pts)), ("height", js_num(height)), ("z0", js_num(base_z))];
        let cr = num_or(field(solid, "cornerRadius"), 0.0);
        if cr > 0.0 {
            f.push(("cornerRadius", field(solid, "cornerRadius").cloned().unwrap_or(Value::Null)));
        }
        let ch = num_or(field(solid, "chamfer"), 0.0);
        if ch > 0.0 {
            f.push(("chamfer", field(solid, "chamfer").cloned().unwrap_or(Value::Null)));
        }
        return Some(obj(f));
    }
    if taper < 1.0 - 1e-6 {
        let n = pts.len() as f64;
        let cx = pts.iter().fold(0.0, |a, p| a + p.0) / n;
        let cy = pts.iter().fold(0.0, |a, p| a + p.1) / n;
        let top: Vec<V> = pts.iter().map(|p| (cx + (p.0 - cx) * (1.0 - taper), cy + (p.1 - cy) * (1.0 - taper))).collect();
        return Some(obj(vec![
            ("kind", s("loft")),
            (
                "sections",
                Value::Array(vec![
                    obj(vec![("z", js_num(base_z)), ("points", flat(&pts))]),
                    obj(vec![("z", js_num(base_z + height)), ("points", flat(&top))]),
                ]),
            ),
        ]));
    }
    None
}

// ═════════════════════════════════════════════════════════════════════════════
// Grundkörper, Boolesche Körper, Aussparung
// ═════════════════════════════════════════════════════════════════════════════

/// Grundkörper aus den Eingaben (`solidFromInputs`): Grundriss-Punkte, Höhe, B-Rep-Beschreibung, Label.
pub fn solid_from_inputs(shape: &str, p0: V, p1: Option<V>, nums: &[f64]) -> Option<(Vec<V>, f64, Value, String)> {
    let num = |i: usize| nums.get(i).copied().unwrap_or(f64::NAN);
    let ok = |x: f64| x > 1e-6;
    match shape {
        "sphere" => {
            let r = num(0);
            ok(r).then(|| {
                (circle_pts(p0, r, 48), 2.0 * r, json!({ "kind": "sphere", "center": [js_num(p0.0), js_num(p0.1), js_num(r)], "r": js_num(r) }), format!("Kugel r={}", fixed2(r)))
            })
        }
        "cylinder" | "cone" => {
            let (r, h) = (num(0), num(1));
            (ok(r) && ok(h)).then(|| {
                let label = format!("{} r={} h={}", if shape == "cone" { "Kegel" } else { "Zylinder" }, fixed2(r), fixed2(h));
                let spec = obj(vec![("kind", s(shape)), ("cx", js_num(p0.0)), ("cy", js_num(p0.1)), ("z0", js_num(0.0)), ("r", js_num(r)), ("height", js_num(h))]);
                (circle_pts(p0, r, 48), h, spec, label)
            })
        }
        "frustum" => {
            let (r, rt, h) = (num(0), num(1), num(2));
            (ok(r) && ok(rt) && ok(h)).then(|| {
                let profile: Vec<Value> = [0.0, 0.0, r, 0.0, rt, h, 0.0, h].iter().map(|x| js_num(*x)).collect();
                let spec = obj(vec![("kind", s("revolve")), ("cx", js_num(p0.0)), ("cy", js_num(p0.1)), ("profile", Value::Array(profile))]);
                (circle_pts(p0, jsnum::max(r, rt), 48), h, spec, format!("Kegelstumpf r={}/{} h={}", fixed2(r), fixed2(rt), fixed2(h)))
            })
        }
        "torus" => {
            let (major, minor) = (num(0), num(1));
            (ok(minor) && major > minor).then(|| {
                let spec = json!({ "kind": "torus", "center": [js_num(p0.0), js_num(p0.1), js_num(minor)], "major": js_num(major), "minor": js_num(minor) });
                (circle_pts(p0, major + minor, 48), 2.0 * minor, spec, format!("Torus R={} r={}", fixed2(major), fixed2(minor)))
            })
        }
        "cuboid" => {
            let h = num(0);
            let p1 = p1?;
            if !ok(h) {
                return None;
            }
            let pts = rect_corners(p0, p1);
            let (w, d) = ((p1.0 - p0.0).abs(), (p1.1 - p0.1).abs());
            if w < 1e-6 || d < 1e-6 {
                return None;
            }
            let spec = json!({ "kind": "cuboid", "min": [js_num(pts[0].0), js_num(pts[0].1), 0], "max": [js_num(pts[2].0), js_num(pts[2].1), js_num(h)] });
            Some((pts.to_vec(), h, spec, format!("Quader {}×{}×{}", fixed2(w), fixed2(d), fixed2(h))))
        }
        _ => None,
    }
}

fn solid_ops(v: &Value, ctx: &Ctx, ids: &mut IdGen) -> Vec<Op> {
    let nums: Vec<f64> = arr(v.get("nums")).iter().map(|x| num_of(Some(x))).collect();
    let Some((pts, height, spec, label)) = solid_from_inputs(s_of(v, "shape"), p_of(v, "p0"), opt_p(v, "p1"), &nums) else {
        return Vec::new();
    };
    let solid = obj(vec![
        ("id", s(&ids.next("body"))),
        ("type", s("extrudedSolid")),
        ("levelId", s(ctx.level)),
        ("points", pvs(&pts)),
        ("height", js_num(height)),
        ("brep", obj(vec![("spec", spec), ("origin", pv(pts[0])), ("label", s(&label))])),
    ]);
    add_op("extrudedSolids", vec![solid])
}

/// Grundkörper-Vorschau: `pts = [p0, p1?, Cursor?]` (`p1`/`cursor` Flags), `step`, `nums`.
fn solid_preview(v: &Value, pts: &[V], out: &mut Shapes) {
    let Some(p0) = pts.first().copied() else { return };
    let mut rest = pts[1..].iter().copied();
    let p1 = if truthy(v.get("p1")) { rest.next() } else { None };
    let cur = if truthy(v.get("cursor")) { rest.next().unwrap_or(p0) } else { p0 };
    let nums: Vec<f64> = arr(v.get("nums")).iter().map(|x| num_of(Some(x))).collect();
    let num = |i: usize, d: f64| nums.get(i).copied().unwrap_or(d);
    let dist = hypot2(cur.0 - p0.0, cur.1 - p0.1);
    let step = s_of(v, "step");
    let shape = s_of(v, "shape");
    if shape == "cuboid" {
        out.poly(&rect_corners(p0, p1.unwrap_or(cur)));
        return;
    }
    let r = if step == "radius" || step == "major" { dist } else { num(0, dist) };
    if shape == "frustum" && step != "radius" {
        out.poly(&circle_pts(p0, jsnum::max(if step == "topRadius" { dist } else { num(1, dist) }, 0.01), 48));
    }
    out.poly(&circle_pts(p0, jsnum::max(r, 0.01), 48));
    if shape == "torus" && step == "minor" {
        out.poly(&circle_pts(p0, num(0, 0.0) + dist, 48));
    }
}

/// Punkt im Polygon (Strahl-Test, `|| 1e-12` gegen waagrechte Kanten).
fn point_in_polygon(p: V, poly: &[V]) -> bool {
    let mut inside = false;
    let n = poly.len();
    let mut j = n.wrapping_sub(1);
    for i in 0..n {
        let (a, b) = (poly[i], poly[j]);
        let dy = b.1 - a.1;
        let dy = if dy == 0.0 || dy.is_nan() { 1e-12 } else { dy };
        if (a.1 > p.1) != (b.1 > p.1) && p.0 < ((b.0 - a.0) * (p.1 - a.1)) / dy + a.0 {
            inside = !inside;
        }
        j = i;
    }
    inside
}

struct BBox {
    x0: f64,
    y0: f64,
    x1: f64,
    y1: f64,
}

fn bbox(pts: &[V]) -> BBox {
    let (mut x0, mut y0, mut x1, mut y1) = (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
    for p in pts {
        x0 = jsnum::min(x0, p.0);
        y0 = jsnum::min(y0, p.1);
        x1 = jsnum::max(x1, p.0);
        y1 = jsnum::max(y1, p.1);
    }
    BBox { x0, y0, x1, y1 }
}

fn solid_pts(s: &Value) -> Vec<V> {
    arr(field(s, "points")).iter().map(xy).collect()
}

/// Kleinster Körper der Ebene, dessen Grundriss den Punkt enthält.
fn pick_solid<'a>(root: &'a Map<String, Value>, level: &str, at: V) -> Option<&'a Value> {
    let mut best = None;
    let mut best_area = f64::INFINITY;
    for sd in arr(root.get("extrudedSolids")) {
        let pts = solid_pts(sd);
        if level_of(sd) != Some(level) || !point_in_polygon(at, &pts) {
            continue;
        }
        let b = bbox(&pts);
        let area = (b.x1 - b.x0) * (b.y1 - b.y0);
        if area < best_area {
            best = Some(sd);
            best_area = area;
        }
    }
    best
}

/// Boolesche Verknüpfung zweier Körper (`combineSolids`): Grundriss als Hüllrechteck (Vereinigung,
/// Durchschnitt) bzw. der des ersten (Differenz), B-Rep `boolean` aus beiden Beschreibungen.
pub fn combine_solids(a: &Value, b: &Value, op: &str, id: String) -> Option<Value> {
    let sa = extruded_solid_spec(a, 0.0)?;
    let sb = extruded_solid_spec(b, 0.0)?;
    let (pa, pb) = (solid_pts(a), solid_pts(b));
    let (ba, bb) = (bbox(&pa), bbox(&pb));
    let (ha, hb) = (num_of(field(a, "height")), num_of(field(b, "height")));
    let rect = |x0: f64, y0: f64, x1: f64, y1: f64| vec![pv((x0, y0)), pv((x1, y0)), pv((x1, y1)), pv((x0, y1))];
    let (points, height, label) = match op {
        "union" => (rect(jsnum::min(ba.x0, bb.x0), jsnum::min(ba.y0, bb.y0), jsnum::max(ba.x1, bb.x1), jsnum::max(ba.y1, bb.y1)), jsnum::max(ha, hb), "Vereinigung"),
        "difference" => (arr(field(a, "points")).to_vec(), ha, "Differenz"),
        _ => {
            let (x0, y0) = (jsnum::max(ba.x0, bb.x0), jsnum::max(ba.y0, bb.y0));
            let (x1, y1) = (jsnum::min(ba.x1, bb.x1), jsnum::min(ba.y1, bb.y1));
            if x1 - x0 < 1e-6 || y1 - y0 < 1e-6 {
                return None;
            }
            (rect(x0, y0, x1, y1), jsnum::min(ha, hb), "Durchschnitt")
        }
    };
    let origin = points.first().cloned().unwrap_or(Value::Null);
    Some(obj(vec![
        ("id", s(&id)),
        ("type", s("extrudedSolid")),
        ("levelId", field(a, "levelId").cloned().unwrap_or(Value::Null)),
        ("points", Value::Array(points)),
        ("height", js_num(height)),
        (
            "brep",
            obj(vec![
                ("spec", obj(vec![("kind", s("boolean")), ("op", s(op)), ("a", sa), ("b", sb)])),
                ("origin", origin),
                ("label", s(label)),
            ]),
        ),
    ]))
}

fn solidbool_ops(root: &Map<String, Value>, v: &Value, ids: &mut IdGen) -> Vec<Op> {
    let (Some(a), Some(b)) = (find(root, "extrudedSolids", s_of(v, "a")), find(root, "extrudedSolids", s_of(v, "b"))) else {
        return Vec::new();
    };
    let Some(merged) = combine_solids(a, b, s_of(v, "op"), ids.next("body")) else { return Vec::new() };
    let ids_ab: Vec<&str> = [id_of(a), id_of(b)].into_iter().flatten().collect();
    let mut ops = crate::cmd_create::remove_op(root, "extrudedSolids", &ids_ab);
    ops.extend(add_op("extrudedSolids", vec![merged]));
    ops
}

/// Aussparungs-Quader (`voidFromInputs`): Grundriss-Rechteck, Höhe, Versatz über der UK.
fn voidbox_ops(v: &Value, ctx: &Ctx, ids: &mut IdGen) -> Vec<Op> {
    let (a, b) = (p_of(v, "a"), p_of(v, "b"));
    let (height, offset) = (n_of(v, "height"), n_of(v, "offset"));
    if (b.0 - a.0).abs() < 1e-6 || (b.1 - a.1).abs() < 1e-6 || !(height > 1e-6) {
        return Vec::new();
    }
    let mut f = vec![
        ("id", s(&ids.next("void"))),
        ("type", s("extrudedSolid")),
        ("levelId", s(ctx.level)),
        ("points", pvs(&rect_corners(a, b))),
        ("height", js_num(height)),
        ("operation", s("subtract")),
    ];
    if offset.abs() > 1e-9 {
        f.push(("baseOffset", js_num(offset)));
    }
    add_op("extrudedSolids", vec![obj(f)])
}

// ═════════════════════════════════════════════════════════════════════════════
// Gelände aus Höhenlinien
// ═════════════════════════════════════════════════════════════════════════════

/// Gelände-TIN aus Höhenlinien (`generateTerrainFromContours`): alle endlichen Stützpunkte, Delaunay
/// über (x, y), Höhe der Kontur je Punkt; Null-Flächen-Dreiecke verworfen.
pub fn terrain_from_contours(contours: &[Value], id: &str) -> Value {
    let (mut xs, mut ys, mut zs) = (Vec::new(), Vec::new(), Vec::new());
    for c in contours {
        let z = num_of(field(c, "z"));
        let z = if z.is_finite() { z } else { 0.0 };
        for p in arr(field(c, "pts")) {
            let (x, y) = xy(p);
            if !x.is_finite() || !y.is_finite() {
                continue;
            }
            xs.push(x);
            ys.push(y);
            zs.push(z);
        }
    }
    if xs.len() < 3 {
        return json!({ "id": id, "type": "terrainMesh", "name": "Gelände", "categoryCode": "02", "positions": [], "indices": [] });
    }
    let coords: Vec<f64> = xs.iter().zip(&ys).flat_map(|(x, y)| [*x, *y]).collect();
    let tri = crate::delaunay::triangulate(&coords);
    let positions: Vec<Value> = (0..xs.len()).flat_map(|i| [js_num(xs[i]), js_num(ys[i]), js_num(zs[i])]).collect();
    let mut indices = Vec::new();
    for t in tri.chunks_exact(3) {
        let (a, b, c) = (t[0] as usize, t[1] as usize, t[2] as usize);
        let area2 = ((xs[b] - xs[a]) * (ys[c] - ys[a]) - (xs[c] - xs[a]) * (ys[b] - ys[a])).abs();
        if area2 <= 1e-9 {
            continue;
        }
        indices.extend([Value::from(t[0]), Value::from(t[1]), Value::from(t[2])]);
    }
    obj(vec![
        ("id", s(id)),
        ("type", s("terrainMesh")),
        ("name", s("Gelände")),
        ("layer", s("Terrain")),
        ("categoryCode", s("02")),
        ("positions", Value::Array(positions)),
        ("indices", Value::Array(indices)),
    ])
}

fn terrain_ops(root: &Map<String, Value>, ids: &mut IdGen) -> Vec<Op> {
    let Some(set) = arr(root.get("context")).iter().find(|o| field(o, "type").and_then(Value::as_str) == Some("contourSet")) else {
        return Vec::new();
    };
    let t = terrain_from_contours(arr(field(set, "contours")), &ids.next("terrain"));
    if arr(field(&t, "indices")).is_empty() {
        return Vec::new();
    }
    add_op("context", vec![t])
}

// ═════════════════════════════════════════════════════════════════════════════
// Decken-Aussparung, Dach-Hof, Schnitt-/Ansichtslinie
// ═════════════════════════════════════════════════════════════════════════════

fn ring_of(o: &Value) -> Vec<V> {
    arr(field(o, "outline")).iter().map(xy).collect()
}

/// Rechteckige Aussparung in die Decke des Geschosses, die alle vier Ecken enthält.
fn ceiling_opening_ops(root: &Map<String, Value>, v: &Value, ctx: &Ctx) -> Vec<Op> {
    let (a, b) = (p_of(v, "a"), p_of(v, "b"));
    if (b.0 - a.0).abs() < 0.05 || (b.1 - a.1).abs() < 0.05 {
        return Vec::new();
    }
    let corners = rect_corners(a, b);
    let host = arr(root.get("ceilings")).iter().find(|c| {
        let ring = ring_of(c);
        crate::cmd_create::floor_of(c) == Some(ctx.level) && ring.len() >= 3 && corners.iter().all(|p| point_in_polygon(*p, &ring))
    });
    let Some(host) = host else { return Vec::new() };
    let mut openings = arr(field(host, "openings")).to_vec();
    openings.push(pvs(&corners));
    vec![Op::Replace { collection: "ceilings".into(), entity: with(host, "openings", Value::Array(openings)) }]
}

/// Dachfenster / Deckenöffnung mit Oberlicht ([103]): ein Klick setzt die Öffnung (Mitte im Grundriss) in das
/// Dach, dessen Umriss den Punkt enthält (Dächer des aktiven Geschosses zuerst), sonst in die Decke des
/// Geschosses. Masse in der Dachebene (Standard 78 × 118 cm), Fenstertyp wie beim Fenster-Befehl.
fn roof_window_ops(root: &Map<String, Value>, v: &Value, ctx: &Ctx, ids: &mut IdGen) -> Vec<Op> {
    let at = p_of(v, "p");
    if !(at.0.is_finite() && at.1.is_finite()) {
        return Vec::new();
    }
    let contains = |e: &&Value| {
        let ring = ring_of(e);
        ring.len() >= 3 && point_in_polygon(at, &ring)
    };
    let on_level = |e: &&Value| crate::cmd_create::floor_of(e) == Some(ctx.level);
    let roofs = arr(root.get("roofs"));
    let host = roofs
        .iter()
        .filter(contains)
        .find(on_level)
        .or_else(|| roofs.iter().find(contains))
        .map(|r| ("hostRoofId", id_of(r)))
        .or_else(|| arr(root.get("ceilings")).iter().filter(contains).find(on_level).map(|c| ("hostCeilingId", id_of(c))));
    let Some((key, Some(host_id))) = host else { return Vec::new() };
    let width = num_or(field(v, "width"), 0.78).max(0.1);
    let height = num_or(field(v, "height"), 1.18).max(0.1);
    let mut f = vec![
        ("id", s(&ids.next("O"))),
        ("type", s("opening")),
        ("hostWallId", s("")),
        (key, s(host_id)),
        ("hostPoint", pv(at)),
        ("categoryCode", crate::cmd_create::category_or(root, "21", ctx)),
        ("kind", s("window")),
        ("position", js_num(0.0)),
        ("width", js_num(width)),
        ("height", js_num(height)),
        ("sillHeight", js_num(0.0)),
    ];
    if let Some(t) = arr(root.get("windowTypes")).first().and_then(|t| field(t, "id")).filter(|id| truthy(Some(id))) {
        f.push(("typeId", t.clone()));
    }
    add_op("openings", vec![obj(f)])
}

/// Hof-Ring des Dach-Hof-Befehls: ≥ 3 Punkte wie gezeichnet, 2 Punkte als Rechteck.
fn hole_ring(points: &[V]) -> Option<Vec<V>> {
    match points {
        [a, b] => {
            if (a.0 - b.0).abs() < 0.05 || (a.1 - b.1).abs() < 0.05 {
                None
            } else {
                Some(rect_corners(*a, *b).to_vec())
            }
        }
        p if p.len() >= 3 => Some(p.to_vec()),
        _ => None,
    }
}

/// Lässt das Dach-Skelett den Hof zu (eigene Traufe je Hof)?
fn roof_hole_works(roof: &Value, ring: &[V]) -> bool {
    if ring.len() < 3 {
        return false;
    }
    let mut holes = arr(field(roof, "holes")).to_vec();
    holes.push(pvs(ring));
    let n = holes.len();
    let probe = with(roof, "holes", Value::Array(holes));
    match serde_json::from_value::<crate::model::Roof>(probe) {
        Ok(r) => crate::roof::roof_geometry(&r.params(), 0.0).eaves_holes.len() == n,
        Err(_) => false,
    }
}

/// Hof in das Dach des Geschosses, das den Ring enthält und ihn zulässt.
fn roof_hole_ops(root: &Map<String, Value>, v: &Value, ctx: &Ctx) -> Vec<Op> {
    let Some(ring) = hole_ring(&pts_of(v, "pts")) else { return Vec::new() };
    let host = arr(root.get("roofs")).iter().find(|r| {
        let outline = ring_of(r);
        crate::cmd_create::floor_of(r) == Some(ctx.level)
            && outline.len() >= 3
            && ring.iter().all(|p| point_in_polygon(*p, &outline))
            && roof_hole_works(r, &ring)
    });
    let Some(host) = host else { return Vec::new() };
    let mut holes = arr(field(host, "holes")).to_vec();
    holes.push(pvs(&ring));
    vec![Op::Replace { collection: "roofs".into(), entity: with(host, "holes", Value::Array(holes)) }]
}

/// Buchstaben der nächsten Linie (A … Z, AA …) aus der Zahl vorhandener Ebenen dieser Art.
fn level_letters(count: usize) -> String {
    let mut n = count as i64;
    let mut letters = String::new();
    loop {
        letters.insert(0, (b'A' + (n % 26) as u8) as char);
        n = n / 26 - 1;
        if n < 0 {
            break;
        }
    }
    letters
}

/// Schnitt-/Ansichtslinie: eine verwaiste Ebene dieser Art bekommt die Linie, sonst eine neue Ebene
/// (`name` = Vorlage der Hülle mit `\u{1}` für die Buchstaben).
fn sectionline_ops(root: &Map<String, Value>, v: &Value, ids: &mut IdGen) -> Vec<Op> {
    let (a, b) = (p_of(v, "a"), p_of(v, "b"));
    if hypot2(b.0 - a.0, b.1 - a.1) < 0.1 {
        return Vec::new();
    }
    let kind = s_of(v, "kind");
    let line = Value::Array(vec![pv(a), pv(b)]);
    let levels = arr(root.get("drawingLevels"));
    let of_kind: Vec<&Value> = levels.iter().filter(|z| field(z, "kind").and_then(Value::as_str) == Some(kind)).collect();
    let orphans: Vec<&&Value> = of_kind.iter().filter(|z| !truthy(field(z, "linePoints"))).collect();
    if orphans.len() == 1 {
        let z = *orphans[0];
        let sign = match field(z, "directionSign") {
            None | Some(Value::Null) => js_num(1.0),
            Some(x) => x.clone(),
        };
        return vec![Op::Replace { collection: "drawingLevels".into(), entity: crate::grips::with_all(z, vec![("linePoints", line), ("directionSign", sign)]) }];
    }
    let name = s_of(v, "name").replace('\u{1}', &level_letters(of_kind.len()));
    add_op(
        "drawingLevels",
        vec![obj(vec![
            ("id", s(&ids.next(kind))),
            ("name", s(&name)),
            ("kind", s(kind)),
            ("visible", Value::Bool(true)),
            ("locked", Value::Bool(false)),
            ("linePoints", line),
            ("directionSign", js_num(1.0)),
        ])],
    )
}

/// Richtungspfeil der Schnittlinie (Mitte → Blickrichtung, zwei Flügel).
fn direction_arrow(a: V, b: V, sign: f64, out: &mut Shapes) {
    let d = (b.0 - a.0, b.1 - a.1);
    let len = hypot2(d.0, d.1);
    if len < 1e-6 {
        return;
    }
    let u = crate::cmd_create::normalize(d);
    let (nx, ny) = (-u.1 * sign, u.0 * sign);
    let m = ((a.0 + b.0) / 2.0, (a.1 + b.1) / 2.0);
    let arrow = jsnum::min(1.0, len / 4.0);
    let tip = (m.0 + nx * arrow, m.1 + ny * arrow);
    let wing = arrow * 0.35;
    let back = (tip.0 - nx * wing * 2.0, tip.1 - ny * wing * 2.0);
    out.line(m, tip);
    out.line(tip, (back.0 + u.0 * wing, back.1 + u.1 * wing));
    out.line(tip, (back.0 - u.0 * wing, back.1 - u.1 * wing));
}

// ═════════════════════════════════════════════════════════════════════════════
// Einstiege (über `cmd_create`)
// ═════════════════════════════════════════════════════════════════════════════

pub fn ops(root: &Map<String, Value>, v: &Value, ctx: &Ctx, ids: &mut IdGen) -> Option<Vec<Op>> {
    Some(match s_of(v, "cmd") {
        "solid" => solid_ops(v, ctx, ids),
        "solidbool" => solidbool_ops(root, v, ids),
        "voidbox" => voidbox_ops(v, ctx, ids),
        "terrain" => terrain_ops(root, ids),
        "ceilingOpening" => ceiling_opening_ops(root, v, ctx),
        "roofHole" => roof_hole_ops(root, v, ctx),
        "roofWindow" => roof_window_ops(root, v, ctx, ids),
        "sectionline" => sectionline_ops(root, v, ids),
        _ => return None,
    })
}

pub fn preview(root: &Map<String, Value>, v: &Value, pts: &[V], p: &mut Preview) -> bool {
    match s_of(v, "cmd") {
        "solid" => solid_preview(v, pts, &mut p.shapes),
        "solidOutline" => match find(root, "extrudedSolids", s_of(v, "id")) {
            Some(sd) => p.shapes.poly(&solid_pts(sd)),
            None => p.ok = false,
        },
        "voidbox" => {
            if let [a, b] = pts {
                let c = rect_corners(*a, *b);
                p.shapes.poly(&c);
                p.shapes.line(c[0], c[2]);
                p.shapes.line(c[1], c[3]);
            }
        }
        "sectionline" => {
            if let [a, c] = pts {
                p.shapes.line(*a, *c);
                direction_arrow(*a, *c, 1.0, &mut p.shapes);
            }
        }
        _ => return false,
    }
    true
}

pub fn query(root: &Map<String, Value>, v: &Value) -> Option<Value> {
    Some(match s_of(v, "q") {
        "pickSolid" => json!({ "hit": pick_solid(root, s_of(v, "level"), p_of(v, "pt")).and_then(id_of) }),
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn buchstaben_der_ebenen() {
        assert_eq!(level_letters(0), "A");
        assert_eq!(level_letters(25), "Z");
        assert_eq!(level_letters(26), "AA");
        assert_eq!(level_letters(27), "AB");
    }

    #[test]
    fn grundkoerper_und_spezifikation() {
        assert!(solid_from_inputs("torus", (0.0, 0.0), None, &[0.3, 0.5]).is_none());
        let (_, h, spec, label) = solid_from_inputs("frustum", (1.0, 2.0), None, &[2.0, 1.0, 3.0]).unwrap();
        assert_eq!(h, 3.0);
        assert_eq!(spec["kind"], "revolve");
        assert_eq!(label, "Kegelstumpf r=2.00/1.00 h=3.00");
        let solid = json!({"points": [{"x": 0, "y": 0}, {"x": 1, "y": 0}, {"x": 1, "y": 1}], "height": 2, "taper": 0.5});
        assert_eq!(extruded_solid_spec(&solid, 1.0).unwrap()["kind"], "loft");
    }

    /// [103] Dachfenster: Dach mit dem Punkt im Umriss (aktives Geschoss zuerst), sonst Decke, sonst nichts.
    #[test]
    fn dachfenster_befehl() {
        let rect = json!([{"x": 0, "y": 0}, {"x": 5, "y": 0}, {"x": 5, "y": 4}, {"x": 0, "y": 4}]);
        let root = json!({"roofs": [{"id": "R", "floorId": "og", "outline": rect}], "ceilings": [{"id": "C", "floorId": "eg", "outline": rect}], "windowTypes": [{"id": "wt"}]});
        let root = root.as_object().unwrap();
        let run = |level: &str, x: f64| {
            let mut ids = IdGen::new("s");
            let ctx = Ctx { level, floor_height: None, cat: "", wall_type: "", text_height: 0.25, symbol: 1.0 };
            ops(root, &json!({"cmd": "roofWindow", "p": {"x": x, "y": 1.0}}), &ctx, &mut ids).unwrap()
        };
        let item = |o: &[Op]| match &o[0] {
            Op::Add { items, .. } => items[0].clone(),
            _ => panic!(),
        };
        let r = item(&run("og", 2.0));
        assert_eq!((r["hostRoofId"].as_str(), r["hostWallId"].as_str(), r["width"].as_f64(), r["typeId"].as_str()), (Some("R"), Some(""), Some(0.78), Some("wt")));
        assert_eq!(r["hostPoint"]["x"], 2.0);
        // Dach liegt auf einem anderen Geschoss: trotzdem Dach (Dächer überdecken Geschosse).
        assert_eq!(item(&run("eg", 2.0))["hostRoofId"], "R");
        assert!(run("eg", 9.0).is_empty());
    }

    #[test]
    fn gelaende_aus_hoehenlinien() {
        let c = json!([{"z": 1, "pts": [{"x": 0, "y": 0}, {"x": 4, "y": 0}]}, {"z": 2, "pts": [{"x": 0, "y": 3}, {"x": 4, "y": 3}]}]);
        let t = terrain_from_contours(c.as_array().unwrap(), "t");
        assert_eq!(t["indices"].as_array().unwrap().len(), 6);
        assert_eq!(t["positions"][2], 1);
    }
}
