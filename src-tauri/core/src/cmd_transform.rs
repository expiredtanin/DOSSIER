//! Transformation der Auswahl ([K4] S3, vorher `tools/transform.ts` und `geometry/geomTransform.ts`):
//! Verschieben/Drehen/Spiegeln/Skalieren mit den Vervielfältigungs-Modi (Original bewegen, Kopie,
//! Reihe, Verteilen) als Ops, die Live-Vorschau dazu, Ausrichten/Verteilen der 2D-Auswahl und
//! „Block definieren“.
//!
//! Die Abbildung reist als Beschreibung einer affinen Abbildung ([`Xf`]: Verschiebung, Drehung um
//! einen Punkt, Skalierung um einen Punkt, Spiegelung an einer Achse) statt als JS-Funktion. Bewusst
//! keine allgemeine 2×3-Matrix: je Art ist die Rechenreihenfolge die der früheren TS-Funktion
//! (`transformFn`), damit die Koordinaten bitgleich bleiben (`c.x + dx·cos − dy·sin` ist nicht
//! dasselbe wie `a·x + b·y + e`).
//!
//! Rechnung auf der rohen Projekt-Wurzel (verlustfrei, Schlüsselreihenfolge wie das Objekt-Spreizen in
//! TS); Zahlen wie in JS (`jsnum`, `jsmath`), nicht endliche Ergebnisse als Marken (`json_util::js_num`).

use crate::json_util::{arr, field, js_num, num_of, num_or, pt, truthy, with, with_all, with_opt, xy, N};
use crate::jsmath::hypot2;
use crate::jsnum;
use crate::model::Project;
use crate::ops::{id_of, Op};
use serde::Deserialize;
use serde_json::{Map, Value};

// ── Abbildung ────────────────────────────────────────────────────────────────

/// Affine Abbildung der Ebene (s. Modul-Doku).
#[derive(Clone, Copy, Debug)]
pub enum Xf {
    Move { vx: f64, vy: f64 },
    Rotate { cx: f64, cy: f64, cos: f64, sin: f64 },
    Scale { cx: f64, cy: f64, f: f64 },
    Mirror { ax: f64, ay: f64, dx: f64, dy: f64, len2: f64 },
}

/// Punkt `i` der Klickpunkte (fehlend = NaN).
fn p_at(pts: &[(f64, f64)], i: usize) -> (f64, f64) {
    pts.get(i).copied().unwrap_or((f64::NAN, f64::NAN))
}

/// `a || 1` für Zahlen (0 und NaN → 1).
fn or1(v: f64) -> f64 {
    if v == 0.0 || v.is_nan() {
        1.0
    } else {
        v
    }
}

/// Skalierungsfaktor eines `scale`-Punkte-Tripels (Basis, Referenz, Ziel) beim Anteil `t`.
pub fn scale_factor(pts: &[(f64, f64)], t: f64) -> f64 {
    let (c, a, b) = (p_at(pts, 0), p_at(pts, 1), p_at(pts, 2));
    let r = or1(hypot2(a.0 - c.0, a.1 - c.1));
    let tgt = hypot2(b.0 - c.0, b.1 - c.1);
    1.0 + (tgt / r - 1.0) * t
}

impl Xf {
    /// Abbildung der Operation `op` beim Anteil `t` (`transformFn`): move = Verschiebung um t·(p1 − p0),
    /// rotate = Drehung um p0 um t·(Winkel p2 − Winkel p1), scale = um p0 mit dem interpolierten Faktor,
    /// sonst Spiegelung an der Achse p0→p1 (t ohne Wirkung).
    pub fn of(op: &str, pts: &[(f64, f64)], t: f64) -> Xf {
        let (p0, p1) = (p_at(pts, 0), p_at(pts, 1));
        match op {
            "move" => Xf::Move { vx: (p1.0 - p0.0) * t, vy: (p1.1 - p0.1) * t },
            "rotate" => {
                let p2 = p_at(pts, 2);
                let a0 = jsnum::atan2(p1.1 - p0.1, p1.0 - p0.0);
                let a1 = jsnum::atan2(p2.1 - p0.1, p2.0 - p0.0);
                let ang = (a1 - a0) * t;
                Xf::Rotate { cx: p0.0, cy: p0.1, cos: jsnum::cos(ang), sin: jsnum::sin(ang) }
            }
            "scale" => Xf::Scale { cx: p0.0, cy: p0.1, f: scale_factor(pts, t) },
            _ => {
                let (dx, dy) = (p1.0 - p0.0, p1.1 - p0.1);
                Xf::Mirror { ax: p0.0, ay: p0.1, dx, dy, len2: or1(dx * dx + dy * dy) }
            }
        }
    }

    /// Längenfaktor der Abbildung (nur Skalieren ≠ 1).
    pub fn scale_k(&self) -> f64 {
        match *self {
            Xf::Scale { f, .. } => f,
            _ => 1.0,
        }
    }

    /// Verschiebung um `(dx, dy)` (wie `p => ({x: p.x + dx, y: p.y + dy})`).
    pub fn translate(dx: f64, dy: f64) -> Xf {
        Xf::Move { vx: dx, vy: dy }
    }

    pub fn apply(&self, x: f64, y: f64) -> (f64, f64) {
        match *self {
            Xf::Move { vx, vy } => (x + vx, y + vy),
            Xf::Rotate { cx, cy, cos, sin } => {
                let (dx, dy) = (x - cx, y - cy);
                (cx + dx * cos - dy * sin, cy + dx * sin + dy * cos)
            }
            Xf::Scale { cx, cy, f } => (cx + (x - cx) * f, cy + (y - cy) * f),
            Xf::Mirror { ax, ay, dx, dy, len2 } => {
                let tt = ((x - ax) * dx + (y - ay) * dy) / len2;
                let (fx, fy) = (ax + dx * tt, ay + dy * tt);
                (2.0 * fx - x, 2.0 * fy - y)
            }
        }
    }

    /// Kehrt die Abbildung den Umlaufsinn um (Spiegelung)? Über das Flächenvorzeichen eines
    /// Test-Dreiecks (`reversesOrientation`).
    pub fn reverses(&self) -> bool {
        let (p0, p1, p2) = (self.apply(0.0, 0.0), self.apply(1.0, 0.0), self.apply(0.0, 1.0));
        (p1.0 - p0.0) * (p2.1 - p0.1) - (p2.0 - p0.0) * (p1.1 - p0.1) < 0.0
    }

    /// Punkt-Wert abbilden (neues `{x, y}`).
    fn pt(&self, v: &Value) -> Value {
        let (x, y) = xy(v);
        let (a, b) = self.apply(x, y);
        pt(a, b)
    }

    fn pt_of(&self, v: Option<&Value>) -> Value {
        self.pt(v.unwrap_or(&Value::Null))
    }

    fn pts(&self, v: Option<&Value>) -> Value {
        Value::Array(arr(v).iter().map(|q| self.pt(q)).collect())
    }
}

// ── Zeichengeometrie ─────────────────────────────────────────────────────────

fn shape(g: &Value) -> &str {
    field(g, "shape").and_then(Value::as_str).unwrap_or("")
}

/// `mvGeom`: jeden Punkt einer 2D-Zeichengeometrie unter `xf` abbilden. `None` bei unbekannter Form
/// (TS lieferte dort `undefined`, das Feld fiel weg).
pub fn mv_geom(g: &Value, xf: &Xf) -> Option<Value> {
    let p = |k: &str| xf.pt_of(field(g, k));
    let ps = |k: &str| xf.pts(field(g, k));
    Some(match shape(g) {
        "line" | "xline" | "ray" => with_all(g, vec![("a", p("a")), ("b", p("b"))]),
        "polyline" => {
            let pts = ps("pts");
            // Inseln ([77]) wandern mit.
            let g = &if truthy(field(g, "holes")) { with(g, "holes", Value::Array(arr(field(g, "holes")).iter().map(|h| xf.pts(Some(h))).collect())) } else { g.clone() };
            if !truthy(field(g, "bulge")) {
                return Some(with(g, "pts", pts));
            }
            // Das Bogen-Vorzeichen hängt an der Zeichenrichtung: eine Spiegelung kehrt jeden Bogen um.
            let bulge = if xf.reverses() {
                Value::Array(arr(field(g, "bulge")).iter().map(|b| js_num(-num_of(Some(b)))).collect())
            } else {
                g["bulge"].clone()
            };
            with_all(g, vec![("pts", pts), ("bulge", bulge)])
        }
        "rect" => {
            // Achsparallel nur bei reiner Verschiebung erhaltbar; sonst eine geschlossene Polylinie.
            let (min, max) = (xy(field(g, "min").unwrap_or(&Value::Null)), xy(field(g, "max").unwrap_or(&Value::Null)));
            let c = [min, (max.0, min.1), max, (min.0, max.1)].map(|q| xf.apply(q.0, q.1));
            let aligned = (c[0].1 - c[1].1).abs() < 1e-6 && (c[1].0 - c[2].0).abs() < 1e-6 && (c[2].1 - c[3].1).abs() < 1e-6;
            let mut m = Map::new();
            if aligned {
                let fold = |k: fn(f64, f64) -> f64, s: fn(&(f64, f64)) -> f64| c.iter().map(s).reduce(k).unwrap_or(f64::NAN);
                m.insert("shape".into(), "rect".into());
                m.insert("min".into(), pt(fold(jsnum::min, |q| q.0), fold(jsnum::min, |q| q.1)));
                m.insert("max".into(), pt(fold(jsnum::max, |q| q.0), fold(jsnum::max, |q| q.1)));
            } else {
                m.insert("shape".into(), "polyline".into());
                m.insert("pts".into(), Value::Array(c.iter().map(|q| pt(q.0, q.1)).collect()));
                m.insert("closed".into(), Value::Bool(true));
            }
            Value::Object(m)
        }
        "circle" | "arc" | "ellipse" => with(g, "center", p("center")),
        "bezier" | "spline" | "dimension" => with(g, "pts", ps("pts")),
        "kote" | "detailref" | "scalebar" | "pointmarker" => with(g, "at", p("at")),
        "grid" => {
            // Ursprung und Richtung über einen mit abgebildeten Richtungspunkt; eine Spiegelung kehrt die
            // Querachsen um (rechtwinklig: Y-Lagen, radial: Strahlwinkel).
            let (ox, oy) = xy(field(g, "origin").unwrap_or(&Value::Null));
            let ang = num_of(field(g, "angle"));
            let no = xf.apply(ox, oy);
            let nt = xf.apply(ox + jsnum::cos(ang), oy + jsnum::sin(ang));
            let mut f = vec![("origin", pt(no.0, no.1)), ("angle", js_num(jsnum::atan2(nt.1 - no.1, nt.0 - no.0)))];
            if xf.reverses() {
                let key = if field(g, "radial").and_then(Value::as_bool) == Some(true) { "a" } else { "b" };
                let neg = Value::Array(arr(field(g, key)).iter().map(|x| with(x, "pos", js_num(-num_of(field(x, "pos"))))).collect());
                f.push((key, neg));
            }
            with_all(g, f)
        }
        "text" => {
            // Hinweis-Ziel, Knicke und Pfadpunkte wandern mit.
            let mut f = vec![("at", Some(p("at")))];
            for k in ["leaderTarget", "leaderBendPoints", "pathPts"] {
                if truthy(field(g, k)) {
                    f.push((k, Some(if k == "leaderTarget" { p(k) } else { ps(k) })));
                }
            }
            with_opt(g, f)
        }
        "block" => {
            // Winkel aus einem mit abgebildeten Richtungspunkt: Drehen/Spiegeln nehmen die Ausrichtung mit.
            let (ax, ay) = xy(field(g, "at").unwrap_or(&Value::Null));
            let rot = num_of(field(g, "rotation"));
            let nb = xf.apply(ax, ay);
            let nt = xf.apply(ax + jsnum::cos(rot), ay + jsnum::sin(rot));
            with_all(g, vec![("at", pt(nb.0, nb.1)), ("rotation", js_num(jsnum::atan2(nt.1 - nb.1, nt.0 - nb.0)))])
        }
        "image" => {
            // Nur die Lage folgt (die Box bleibt achsparallel und unverzerrt).
            let (min, max) = (xy(field(g, "min").unwrap_or(&Value::Null)), xy(field(g, "max").unwrap_or(&Value::Null)));
            let old = ((min.0 + max.0) / 2.0, (min.1 + max.1) / 2.0);
            let new = xf.apply(old.0, old.1);
            let (dx, dy) = (new.0 - old.0, new.1 - old.1);
            with_all(g, vec![("min", pt(min.0 + dx, min.1 + dy)), ("max", pt(max.0 + dx, max.1 + dy))])
        }
        _ => return None,
    })
}

/// `scaleGeom`: wie [`mv_geom`], dazu die Grössenfelder (Radien, Schrift, Masslinien-Abstand,
/// Massstabsbalken, Block-Faktor) um `k`. Papier-mm-Felder und `bulge` bleiben.
pub fn scale_geom(g: &Value, xf: &Xf, k: f64) -> Option<Value> {
    let g = mv_geom(g, xf)?;
    let times = |key: &str| js_num(num_of(field(&g, key)) * k);
    Some(match shape(&g) {
        "circle" | "arc" => with(&g, "r", times("r")),
        "ellipse" => with_all(&g, vec![("rx", times("rx")), ("ry", times("ry"))]),
        "dimension" => with(&g, "offset", times("offset")),
        "grid" => {
            let scaled = |key: &str| Value::Array(arr(field(&g, key)).iter().map(|x| with(x, "pos", js_num(num_of(field(x, "pos")) * k))).collect());
            let radial = field(&g, "radial").and_then(Value::as_bool) == Some(true);
            let mut f = vec![("b", scaled("b"))];
            if !radial {
                f.push(("a", scaled("a")));
            }
            if field(&g, "extend").is_some() {
                f.push(("extend", times("extend")));
            }
            with_all(&g, f)
        }
        "text" => {
            let mut f = vec![("height", times("height"))];
            if field(&g, "width").is_some() {
                f.push(("width", times("width")));
            }
            with_all(&g, f)
        }
        "scalebar" => with(&g, "segmentLength", times("segmentLength")),
        "block" => with(&g, "scale", js_num(num_or(field(&g, "scale"), 1.0) * k)),
        _ => g,
    })
}

/// `{...d, geom}`; eine unbekannte Form lässt `geom` wegfallen (wie `geom: undefined` in TS).
fn with_geom(d: &Value, g: Option<Value>) -> Value {
    with_opt(d, vec![("geom", g)])
}

// ── Bauteile ─────────────────────────────────────────────────────────────────

fn mv_wall(w: &Value, xf: &Xf) -> Value {
    // Bogenwand ([T2]): eine Spiegelung kehrt den Bogen um (Bulge-Vorzeichen hängt an der Laufrichtung).
    match field(w, "bulge").and_then(Value::as_f64) {
        Some(b) if xf.reverses() => with_all(w, vec![("start", xf.pt_of(field(w, "start"))), ("end", xf.pt_of(field(w, "end"))), ("bulge", js_num(-b))]),
        _ => with_all(w, vec![("start", xf.pt_of(field(w, "start"))), ("end", xf.pt_of(field(w, "end")))]),
    }
}

/// Stütze: Einfügepunkt und Profil-Drehung (über einen mit abgebildeten Richtungspunkt).
fn mv_column(c: &Value, xf: &Xf) -> Value {
    let (bx, by) = xy(field(c, "position").unwrap_or(&Value::Null));
    let rot = num_or(field(c, "rotation"), 0.0);
    let nb = xf.apply(bx, by);
    let nt = xf.apply(bx + jsnum::cos(rot), by + jsnum::sin(rot));
    with_all(c, vec![("position", pt(nb.0, nb.1)), ("rotation", js_num(jsnum::atan2(nt.1 - nb.1, nt.0 - nb.0)))])
}

/// [149] Baum: nur die Stammmitte (die Krone ist rund).
fn mv_tree(t: &Value, xf: &Xf) -> Value {
    let (x, y) = xy(field(t, "position").unwrap_or(&Value::Null));
    let n = xf.apply(x, y);
    with(t, "position", pt(n.0, n.1))
}

/// [193] Gelände-/Umgebungs-Element (`Project.context`): alle x/y abbilden, z bleibt. Netze (`importedMesh`,
/// `terrainMesh`): Positionen (x,y,z flach), bei Spiegelung Dreiecks-Umlauf umkehren; Höhenlinien: Punkte
/// (eine wahre Kurve `curve` fällt weg, ausser bei reiner Verschiebung); Baugrube: Umriss; Luftbild: Rahmen.
fn mv_context(e: &Value, xf: &Xf) -> Value {
    let kind = field(e, "type").and_then(Value::as_str).unwrap_or("");
    match kind {
        "importedMesh" | "terrainMesh" => {
            let src = arr(field(e, "positions"));
            let mut out = Vec::with_capacity(src.len());
            for c in src.chunks(3) {
                if c.len() < 3 {
                    out.extend(c.iter().cloned());
                    continue;
                }
                let (x, y) = xf.apply(num_of(Some(&c[0])), num_of(Some(&c[1])));
                out.extend([js_num(x), js_num(y), c[2].clone()]);
            }
            let mut f = vec![("positions", Value::Array(out))];
            if xf.reverses() {
                let idx: Vec<Value> = arr(field(e, "indices")).chunks(3).flat_map(|t| if t.len() == 3 { vec![t[0].clone(), t[2].clone(), t[1].clone()] } else { t.to_vec() }).collect();
                f.push(("indices", Value::Array(idx)));
            }
            with_all(e, f)
        }
        "contourSet" => {
            let translate = matches!(xf, Xf::Move { .. });
            let cs: Vec<Value> = arr(field(e, "contours"))
                .iter()
                .map(|c| {
                    let c = with(c, "pts", xf.pts(field(c, "pts")));
                    match field(&c, "curve") {
                        Some(cv) if translate => {
                            let n = xf.apply(num_of(field(cv, "cx")), num_of(field(cv, "cy")));
                            with(&c, "curve", with_all(cv, vec![("cx", js_num(n.0)), ("cy", js_num(n.1))]))
                        }
                        Some(_) => with_opt(&c, vec![("curve", None)]),
                        None => c,
                    }
                })
                .collect();
            with(e, "contours", Value::Array(cs))
        }
        "excavation" => with(e, "outline", xf.pts(field(e, "outline"))),
        "image" => {
            let (a, b) = (xy(field(e, "min").unwrap_or(&Value::Null)), xy(field(e, "max").unwrap_or(&Value::Null)));
            let (p, q) = (xf.apply(a.0, a.1), xf.apply(b.0, b.1));
            with_all(e, vec![("min", pt(jsnum::min(p.0, q.0), jsnum::min(p.1, q.1))), ("max", pt(jsnum::max(p.0, q.0), jsnum::max(p.1, q.1)))])
        }
        _ => e.clone(),
    }
}

fn mv_ceiling(c: &Value, xf: &Xf) -> Value {
    let mut f = vec![("outline", xf.pts(field(c, "outline")))];
    if truthy(field(c, "openings")) {
        f.push(("openings", Value::Array(arr(field(c, "openings")).iter().map(|h| xf.pts(Some(h))).collect())));
    }
    with_all(c, f)
}

fn mv_roof(r: &Value, xf: &Xf) -> Value {
    with(r, "outline", xf.pts(field(r, "outline")))
}

/// Dach-/Deckenöffnung ([103]): Mittelpunkt `hostPoint` und (falls gesetzt) Breitenrichtung `hostAngle`
/// mit dem Wirt abbilden; Breite/Höhe bleiben (in der Dachebene gemessen).
fn mv_surface_opening(o: &Value, xf: &Xf) -> Value {
    let (bx, by) = xy(field(o, "hostPoint").unwrap_or(&Value::Null));
    let nb = xf.apply(bx, by);
    let mut f = vec![("hostPoint", pt(nb.0, nb.1))];
    if let Some(a) = field(o, "hostAngle").and_then(Value::as_f64) {
        let nt = xf.apply(bx + jsnum::cos(a), by + jsnum::sin(a));
        f.push(("hostAngle", js_num(jsnum::atan2(nt.1 - nb.1, nt.0 - nb.0))));
    }
    with_all(o, f)
}

/// Wirt (Dach oder Decke) einer Flächenöffnung, sonst `None` (Wandöffnung).
fn surface_host(o: &Value) -> Option<(&'static str, &str)> {
    let s = |k: &str| field(o, k).and_then(Value::as_str).filter(|v| !v.is_empty());
    s("hostRoofId").map(|id| ("hostRoofId", id)).or_else(|| s("hostCeilingId").map(|id| ("hostCeilingId", id)))
}

/// Wandöffnung ([134]): `position` (ab Wand-Start) bleibt gültig, weil die Wand starr mitgeht; eine
/// Spiegelung kehrt den Aufschlag einer Tür (`swing` links ↔ rechts der Wandachse), damit die Tür
/// gespiegelt aufschlägt (Händigkeit wechselt). Das Scharnier bleibt am selben Pfosten (Start ↦ Start).
fn mv_wall_opening(o: &Value, xf: &Xf) -> Value {
    let door = field(o, "kind").and_then(Value::as_str) == Some("door") || field(o, "swing").is_some();
    let mut v = o.clone();
    // Skalieren ([133]): Lage entlang der Wand und Breite wachsen mit dem Faktor mit.
    let k = xf.scale_k();
    if k != 1.0 {
        let mut f = Vec::new();
        for key in ["position", "width"] {
            if let Some(x) = field(o, key).and_then(Value::as_f64) {
                f.push((key, js_num(x * k)));
            }
        }
        v = with_all(&v, f);
    }
    if door && xf.reverses() {
        let right = field(o, "swing").and_then(Value::as_str) == Some("right");
        v = with(&v, "swing", Value::String(if right { "left" } else { "right" }.into()));
    }
    v
}

/// Wirtswand einer Wandöffnung (leer bei Dach-/Deckenöffnungen).
fn wall_host(o: &Value) -> Option<&str> {
    field(o, "hostWallId").and_then(Value::as_str).filter(|v| !v.is_empty())
}

/// Gerade Wand als (Start, Ende); `None` bei Bogenwänden (dort ist `position` keine Sehnenlänge).
fn straight_wall(w: &Value) -> Option<((f64, f64), (f64, f64))> {
    if field(w, "bulge").and_then(Value::as_f64).is_some_and(|b| b.abs() > 1e-12) {
        return None;
    }
    Some((xy(field(w, "start")?), xy(field(w, "end")?)))
}

/// Frei gewählte Wandöffnungen ([144]): gewählt, an einer Wand, nicht gesperrt und ohne mitbewegte
/// Wirtswand (die nimmt ihre Öffnungen starr mit). Nur beim Verschieben — Drehen/Spiegeln/Skalieren
/// einer Öffnung allein ergibt in der Wand keinen Sinn.
fn free_openings<'a>(root: &'a Map<String, Value>, sel: &Sel, op: &str, walls: &std::collections::HashSet<&str>, ignore_lock: bool) -> Vec<&'a Value> {
    let ids = Ids::opt(&sel.opening_ids);
    if op != "move" || ids.is_empty() {
        return vec![];
    }
    list(root, "openings")
        .iter()
        .filter(|o| ids.has(o) && (ignore_lock || !locked(o)))
        .filter(|o| wall_host(o).is_some_and(|h| !walls.contains(h)))
        .collect()
}

/// Wandöffnung um `d` verschieben ([144]): die Öffnungsmitte geht nach `Mitte + d`. Liegt das Ziel in
/// einer anderen Wand desselben Geschosses (innerhalb der halben Dicke + 5 cm) und nicht mehr in der
/// eigenen, wechselt die Öffnung dorthin; sonst gleitet sie entlang der Achse (gerade Wand: um die
/// projizierte Strecke; Bogenwand [T2]: zum Lotfuss auf dem Bogen, `position` = Bogenlänge). Geklemmt auf
/// die Wand und vor Nachbaröffnungen (`opening_slide::place`, Steg 5 cm). `skip`: mitbewegte Öffnungen.
/// `None`: Wirt fehlt, die Öffnung passt nicht in die Wand oder dort ist kein Platz. Das `bool` meldet,
/// dass eine Nachbaröffnung die Lage begrenzt hat.
fn slide_opening(root: &Map<String, Value>, p: &Project, o: &Value, d: (f64, f64), copy: bool, skip: &dyn Fn(&str) -> bool) -> Option<(Value, bool)> {
    use crate::opening_slide::{place, Axis};
    let walls = list(root, "walls");
    let host = walls.iter().find(|w| id_of(w) == wall_host(o))?;
    let width = num_of(field(o, "width"));
    let axis = Axis::of(host)?;
    let pos0 = num_of(field(o, "position"));
    let c = axis.point(pos0 + width / 2.0, 0.0);
    let target = (c.0 + d.0, c.1 + d.1);
    if !(target.0.is_finite() && target.1.is_finite() && width.is_finite()) {
        return None;
    }
    let tol = |w: &Value| wall_thickness(p, w) / 2.0 + 0.05;
    let (t_host, dist_host) = axis.local(target);
    let in_host = dist_host <= tol(host);
    let floor = field(host, "floorId");
    let other = (!in_host)
        .then(|| {
            walls
                .iter()
                .filter(|w| id_of(w) != id_of(host) && field(w, "floorId") == floor)
                .filter_map(|w| {
                    let ax = Axis::of(w)?;
                    let (t, dist) = ax.local(target);
                    (dist <= tol(w)).then_some((w, ax, t, dist))
                })
                .min_by(|a, b| a.3.total_cmp(&b.3))
        })
        .flatten();
    let me = id_of(o).unwrap_or("");
    // Kopie: Originale bleiben stehen und sind Nachbarn wie jede andere (Kopie rückt an die nächste freie Stelle).
    let skip_me = |id: &str| !copy && (id == me || skip(id));
    let from = (!copy && pos0.is_finite()).then_some(pos0);
    // Neue Lage des ersten Pfostens; gerade eigene Wand direkt `position + d·u` (ohne Rundung über die Mitte).
    let (wall, placed) = match other {
        Some((w, ax, t, _)) => (w, place(root, id_of(w)?, ax.len(), width, None, t - width / 2.0, &skip_me)?),
        None => {
            let want = match &axis {
                Axis::Line { u, .. } => pos0 + d.0 * u.0 + d.1 * u.1,
                Axis::Arc(_) => t_host - width / 2.0,
            };
            (host, place(root, id_of(host)?, axis.len(), width, from, want, &skip_me)?)
        }
    };
    let mut v = with(o, "position", js_num(placed.position));
    if id_of(wall) != id_of(host) {
        v = with(&v, "hostWallId", Value::String(id_of(wall)?.to_owned()));
    }
    Some((v, placed.clamped))
}

/// Frei gewählte Dach-/Deckenöffnungen ([144]): gewählt, nicht gesperrt, Wirt nicht mitbewegt; nur
/// beim Verschieben. Sie gleiten in der Wirtsfläche (Mitte im Umriss gehalten).
fn free_surface_openings<'a>(root: &'a Map<String, Value>, sel: &Sel, op: &str, hosts: &std::collections::HashSet<&str>, ignore_lock: bool) -> Vec<&'a Value> {
    let ids = Ids::opt(&sel.opening_ids);
    if op != "move" || ids.is_empty() {
        return vec![];
    }
    list(root, "openings")
        .iter()
        .filter(|o| ids.has(o) && (ignore_lock || !locked(o)))
        .filter(|o| surface_host(o).is_some_and(|(_, h)| !hosts.contains(h)))
        .collect()
}

/// Dach-/Deckenöffnung um `d` verschieben: `hostPoint + d`, im Umriss des Wirts gehalten
/// (`opening_slide::clamp_inside`). `None`: Wirt fehlt.
fn slide_surface_opening(root: &Map<String, Value>, o: &Value, d: (f64, f64)) -> Option<Value> {
    let (key, h) = surface_host(o)?;
    let coll = if key == "hostRoofId" { "roofs" } else { "ceilings" };
    let host = list(root, coll).iter().find(|e| id_of(e) == Some(h))?;
    let ring = pts_of(field(host, "outline"));
    let (bx, by) = xy(field(o, "hostPoint").unwrap_or(&Value::Null));
    let q = crate::opening_slide::clamp_inside((bx + d.0, by + d.1), &ring);
    (q.0.is_finite() && q.1.is_finite()).then(|| with(o, "hostPoint", pt(q.0, q.1)))
}

/// Verschiebung der Klickpunkte zum Anteil `t` (Bewegen).
fn move_delta(pts: &[(f64, f64)], t: f64) -> (f64, f64) {
    let (a, b) = (p_at(pts, 0), p_at(pts, 1));
    ((b.0 - a.0) * t, (b.1 - a.1) * t)
}

fn mv_room(r: &Value, xf: &Xf) -> Value {
    let mut f = vec![("boundary", xf.pts(field(r, "boundary")))];
    if truthy(field(r, "stampAnchor")) {
        f.push(("stampAnchor", xf.pt_of(field(r, "stampAnchor"))));
    }
    with_all(r, f)
}

/// Treppe (Skalierungsfaktor `k`): Antritt und Wendel-Zentrum wandern mit, die Laufrichtung über einen
/// mit abgebildeten Richtungspunkt; `turn`/`sweep` kippen unter einer Spiegelung; Längen mal `k`.
fn mv_stair(s: &Value, xf: &Xf, k: f64) -> Value {
    let (sx, sy) = xy(field(s, "start").unwrap_or(&Value::Null));
    let (dx0, dy0) = xy(field(s, "dir").unwrap_or(&Value::Null));
    let start = xf.apply(sx, sy);
    let tip = xf.apply(sx + dx0, sy + dy0);
    let (dx, dy) = (tip.0 - start.0, tip.1 - start.1);
    let len = or1(hypot2(dx, dy));
    let flips = xf.reverses();
    let times = |key: &str| js_num(num_of(field(s, key)) * k);
    let flip = |key: &str| if flips { js_num(-num_of(field(s, key))) } else { s[key].clone() };
    let mut f = vec![
        ("start", Some(pt(start.0, start.1))),
        ("dir", Some(pt(dx / len, dy / len))),
        ("runLength", Some(times("runLength"))),
        ("width", Some(times("width"))),
    ];
    if field(s, "run2Length").is_some() {
        f.push(("run2Length", Some(times("run2Length"))));
    }
    if field(s, "turn").is_some() {
        f.push(("turn", Some(flip("turn"))));
    }
    // [151] U / gerade mit Podest: Auge, Podesttiefe, Versatz skalieren mit.
    for key in ["gap", "landingLength", "run2Offset", "midOffset"] {
        if field(s, key).is_some() {
            f.push((key, Some(times(key))));
        }
    }
    if truthy(field(s, "center")) {
        f.push(("center", Some(xf.pt_of(field(s, "center")))));
    }
    if field(s, "radius").is_some() {
        f.push(("radius", Some(times("radius"))));
    }
    if field(s, "sweep").is_some() {
        f.push(("sweep", Some(flip("sweep"))));
    }
    with_opt(s, f)
}

/// Extrudierter Körper (`transformSolid`): Umriss und Kreis-Profil (Radius mal `k`); ein B-Rep-Körper
/// bekommt seine Spezifikation als `transform` um die bisherige Verschiebung gewickelt (Z bleibt), der
/// Ursprung wandert auf den neuen ersten Umrisspunkt.
fn mv_solid(s: &Value, xf: &Xf, k: f64) -> Value {
    let points = xf.pts(field(s, "points"));
    let circle = field(s, "circle").filter(|c| truthy(Some(c))).map(|c| {
        with_all(c, vec![("center", xf.pt_of(field(c, "center"))), ("r", js_num(num_of(field(c, "r")) * k))])
    });
    let first = points.get(0).cloned();
    let base = with_opt(s, vec![("points", Some(points)), ("circle", circle)]);
    let Some(brep) = field(s, "brep").filter(|b| truthy(Some(b))) else { return base };
    let o = xf.apply(0.0, 0.0);
    let ex = xf.apply(1.0, 0.0);
    let ey = xf.apply(0.0, 1.0);
    let (ox, oy) = xy(field(brep, "origin").unwrap_or(&Value::Null));
    let d = match arr(field(s, "points")).first().filter(|p0| truthy(Some(p0))) {
        Some(p0) => {
            let (x, y) = xy(p0);
            [x - ox, y - oy, 0.0]
        }
        None => [0.0, 0.0, 0.0],
    };
    let mut inner = Map::new();
    inner.insert("kind".into(), "translate".into());
    inner.insert("v".into(), Value::Array(d.iter().map(|x| js_num(*x)).collect()));
    if let Some(spec) = field(brep, "spec") {
        inner.insert("solid".into(), spec.clone());
    }
    let m = [ex.0 - o.0, ey.0 - o.0, 0.0, o.0, ex.1 - o.1, ey.1 - o.1, 0.0, o.1, 0.0, 0.0, k, 0.0];
    let mut spec = Map::new();
    spec.insert("kind".into(), "transform".into());
    spec.insert("m".into(), Value::Array(m.iter().map(|x| js_num(*x)).collect()));
    spec.insert("solid".into(), Value::Object(inner));
    let origin = first.or_else(|| field(brep, "origin").cloned());
    let brep = with_opt(brep, vec![("spec", Some(Value::Object(spec))), ("origin", origin)]);
    with_all(&base, vec![("height", js_num(num_of(field(s, "height")) * k)), ("brep", brep)])
}

// ── Auswahl ──────────────────────────────────────────────────────────────────

/// Auswahl einer Transformation (`TransformSelection` in TS).
#[derive(Deserialize, Default, Debug, Clone)]
#[serde(default, rename_all = "camelCase")]
pub struct Sel {
    pub wall_ids: Vec<String>,
    pub drawing_id: Option<String>,
    pub drawing_ids: Option<Vec<String>>,
    pub extruded_solid_id: Option<String>,
    pub column_id: Option<String>,
    pub ceiling_ids: Option<Vec<String>>,
    pub roof_ids: Option<Vec<String>>,
    pub stair_ids: Option<Vec<String>>,
    pub room_ids: Option<Vec<String>>,
    /// Gewählte Öffnungen ([144]): Wandöffnungen gleiten beim Verschieben entlang ihrer Wand.
    pub opening_ids: Option<Vec<String>>,
    /// [149] Gewählte Bäume.
    pub tree_ids: Option<Vec<String>>,
    /// [193] Gewählte Gelände-/Umgebungs-Elemente (`Project.context`).
    pub context_ids: Option<Vec<String>>,
}

fn nonempty(s: &Option<String>) -> Option<&str> {
    s.as_deref().filter(|s| !s.is_empty())
}

impl Sel {
    /// `drawingIds` ∪ `drawingId`.
    fn drawings(&self) -> Vec<&str> {
        let mut v: Vec<&str> = self.drawing_ids.iter().flatten().map(String::as_str).collect();
        if let Some(d) = nonempty(&self.drawing_id) {
            v.push(d);
        }
        v
    }
}

/// id-Menge der Auswahl (schneller Hash, s. `commands::Fnv`).
struct Ids<'a>(crate::commands::FastSet<&'a str>);

impl<'a> Ids<'a> {
    fn of<I: IntoIterator<Item = &'a str>>(it: I) -> Self {
        Ids(it.into_iter().collect())
    }
    fn opt(v: &'a Option<Vec<String>>) -> Self {
        Ids::of(v.iter().flatten().map(String::as_str))
    }
    fn has(&self, v: &Value) -> bool {
        !self.0.is_empty() && id_of(v).is_some_and(|id| self.0.contains(id))
    }
    fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

fn locked(v: &Value) -> bool {
    truthy(field(v, "locked"))
}

fn list<'a>(root: &'a Map<String, Value>, key: &str) -> &'a [Value] {
    arr(root.get(key))
}

/// Ein gewähltes Element mit seiner Liste.
#[derive(Clone, Copy)]
enum Kind {
    Wall,
    Drawing,
    Solid,
    Column,
    Ceiling,
    Roof,
    Stair,
    Room,
    Tree,
    Context,
}

/// Dächer nur bei Verschieben/Skalieren (der Umriss ist an die Weltachsen gebunden, der First folgt
/// `ridgeAxis`; Drehen/Spiegeln würden diese Invariante brechen).
fn roof_allowed(op: &str) -> bool {
    op != "rotate" && op != "mirror"
}

/// `gatherItems`: gewählte, nicht gesperrte Elemente in Listen-Reihenfolge (Körper und Stütze: das
/// erste mit der id).
fn gather<'a>(root: &'a Map<String, Value>, sel: &Sel, op: &str, ignore_lock: bool) -> Vec<(Kind, &'a Value)> {
    let free = |v: &Value| ignore_lock || !locked(v);
    let mut out = Vec::new();
    let walls = Ids::of(sel.wall_ids.iter().map(String::as_str));
    out.extend(list(root, "walls").iter().filter(|w| walls.has(w) && free(w)).map(|w| (Kind::Wall, w)));
    let draw = Ids::of(sel.drawings());
    out.extend(list(root, "drawings2d").iter().filter(|d| draw.has(d) && free(d)).map(|d| (Kind::Drawing, d)));
    if let Some(id) = nonempty(&sel.extruded_solid_id) {
        if let Some(s) = list(root, "extrudedSolids").iter().find(|s| id_of(s) == Some(id)) {
            out.push((Kind::Solid, s));
        }
    }
    if let Some(id) = nonempty(&sel.column_id) {
        if let Some(c) = list(root, "columns").iter().find(|c| id_of(c) == Some(id)).filter(|c| free(c)) {
            out.push((Kind::Column, c));
        }
    }
    let mut each = |key: &str, set: Ids, kind: Kind| out.extend(list(root, key).iter().filter(|e| set.has(e) && free(e)).map(|e| (kind, e)));
    each("ceilings", Ids::opt(&sel.ceiling_ids), Kind::Ceiling);
    if roof_allowed(op) {
        each("roofs", Ids::opt(&sel.roof_ids), Kind::Roof);
    }
    each("stairs", Ids::opt(&sel.stair_ids), Kind::Stair);
    each("rooms", Ids::opt(&sel.room_ids), Kind::Room);
    each("trees", Ids::opt(&sel.tree_ids), Kind::Tree);
    each("context", Ids::opt(&sel.context_ids), Kind::Context);
    out
}

/// `copyTs`: die Anteile t der Kopien (ohne Original) je Modus. Spiegeln ergibt immer genau eine Kopie.
pub fn copy_ts(op: &str, mode: &str, count: f64) -> Vec<f64> {
    if mode == "move" {
        return vec![];
    }
    if op == "mirror" || mode == "copy" {
        return vec![1.0];
    }
    let n = jsnum::max(1.0, count.floor());
    // `Array.from({length: n})` (NaN → 0); begrenzt, damit Unsinn nicht endlos läuft.
    let n = if n.is_nan() { 0 } else { n.min(100_000.0) as usize };
    if mode == "array" {
        (0..n).map(|k| (k + 1) as f64).collect()
    } else {
        (0..n).map(|k| (k + 1) as f64 / n as f64).collect()
    }
}

// ── Ops ──────────────────────────────────────────────────────────────────────

/// Neue ids `prefix-stamp-k` (der Stempel kommt aus der Hülle, `uniqueStamp`: Zeit + Zähler).
pub struct IdGen<'a> {
    stamp: &'a str,
    k: u32,
}

impl<'a> IdGen<'a> {
    pub fn new(stamp: &'a str) -> Self {
        IdGen { stamp, k: 0 }
    }
    pub fn next(&mut self, prefix: &str) -> String {
        self.k += 1;
        format!("{prefix}-{}-{}", self.stamp, self.k)
    }
}

/// Anfrage einer Transformation (s. `transformOps` in `tools/transform.ts`).
#[derive(Deserialize, Default, Debug)]
#[serde(default, rename_all = "camelCase")]
pub struct TransformReq {
    pub sel: Sel,
    pub op: String,
    pub pts: Vec<[N; 2]>,
    pub mode: String,
    pub count: N,
    pub stamp: String,
    /// Vorschau: Sperre nicht beachten (Griff-Vorschau eines einzelnen Elements).
    pub ignore_lock: bool,
    /// Vorschau: Massstab der Zeichnungs-Primitive und Grundlinie→Oberkante der Schrift (Hülle).
    pub scale: N,
    pub top: N,
}

impl TransformReq {
    fn points(&self) -> Vec<(f64, f64)> {
        self.pts.iter().map(|[x, y]| (x.0, y.0)).collect()
    }
}

fn replace(collection: &str, entity: Value) -> Op {
    Op::Replace { collection: collection.into(), entity }
}

fn add(collection: &str, items: Vec<Value>) -> Option<Op> {
    (!items.is_empty()).then(|| Op::Add { collection: collection.into(), items, at: None })
}

/// Die Transformation als Ops: `replace` je bewegtem Original (Modus „move“), dann `add` der Kopien je
/// Liste (Wände, 2D, Körper, Stützen, Decken, Dächer, Treppen, Räume).
pub fn transform_ops(root: &Map<String, Value>, p: &Project, req: &TransformReq) -> Vec<Op> {
    transform_result(root, p, req).ops
}

/// Gemeinsame Mengen von Ops und Vorschau: (bewegte Wände, Wirte von Dach-/Deckenöffnungen) → frei
/// gewählte Wand- und Flächenöffnungen ([144]).
fn free_sets<'a>(root: &'a Map<String, Value>, sel: &Sel, op: &str, items: &[(Kind, &'a Value)], ignore_lock: bool) -> (Vec<&'a Value>, Vec<&'a Value>) {
    let ids_of = |f: &dyn Fn(&Kind) -> bool| -> std::collections::HashSet<&'a str> { items.iter().filter(|(k, _)| f(k)).filter_map(|(_, e)| id_of(e)).collect() };
    let walls = ids_of(&|k| matches!(k, Kind::Wall));
    let hosts = ids_of(&|k| matches!(k, Kind::Roof | Kind::Ceiling));
    (free_openings(root, sel, op, &walls, ignore_lock), free_surface_openings(root, sel, op, &hosts, ignore_lock))
}

/// Wie [`transform_ops`], mit Hinweis ([144]: eine Öffnung hielt an der Nachbaröffnung an bzw. fand in
/// der Zielwand keinen Platz).
pub fn transform_result(root: &Map<String, Value>, p: &Project, req: &TransformReq) -> crate::grips::GripResult {
    let (sel, op) = (&req.sel, req.op.as_str());
    let items = gather(root, sel, op, false);
    let (free, free_surf) = free_sets(root, sel, op, &items, false);
    if items.is_empty() && free.is_empty() && free_surf.is_empty() {
        return Default::default();
    }
    let notice: std::cell::Cell<Option<&'static str>> = Default::default();
    let free_ids: std::collections::HashSet<&str> = free.iter().filter_map(|o| id_of(o)).collect();
    let skip = |id: &str| free_ids.contains(id);
    // Gleiten mit Hinweis: Anschlag an der Nachbaröffnung bzw. kein Platz.
    let slide = |o: &Value, d: (f64, f64), copy: bool| -> Option<Value> {
        match slide_opening(root, p, o, d, copy, &skip) {
            Some((v, clamped)) => {
                if clamped {
                    notice.set(Some(crate::opening_slide::NOTICE_OVERLAP));
                }
                Some(v)
            }
            None => {
                if d != (0.0, 0.0) && wall_host(o).is_some() {
                    notice.set(notice.get().or(Some(crate::opening_slide::NOTICE_NO_ROOM)));
                }
                None
            }
        }
    };
    let pts = req.points();
    let scaling = op == "scale";
    let k_at = |t: f64| if scaling { scale_factor(&pts, t) } else { 1.0 };
    let geom_at = |g: &Value, xf: &Xf, t: f64| if scaling { scale_geom(g, xf, scale_factor(&pts, t)) } else { mv_geom(g, xf) };
    let mut ops = Vec::new();
    // Assoziative Bemassung ([38]): Bezüge bleiben nur bei starren Bewegungen (Verschieben, Drehen)
    // und nur auf Elemente, die mittransformiert werden (Öffnungen mit ihrer Wand).
    let rigid = op == "move" || op == "rotate";
    let moved: std::collections::HashSet<&str> = items.iter().filter_map(|(_, e)| id_of(e)).collect();
    let moved_openings: std::collections::HashSet<&str> =
        p.openings.iter().flatten().filter(|o| moved.contains(o.host_wall_id.as_str())).map(|o| o.id.as_str()).collect();
    let fix_refs = |d: Value, map: &dyn Fn(&str) -> Option<String>| -> Value {
        let Some(g) = field(&d, "geom") else { return d };
        let keep = |id: &str| if rigid { map(id) } else { None };
        match crate::dim_assoc::transformed_refs(g, &keep) {
            Some(Some(r)) => with(&d, "geom", with(g, "refs", r)),
            Some(None) => with(&d, "geom", crate::dim_assoc::without_ref(g, None)),
            None => d,
        }
    };

    if req.mode == "move" {
        let xf = Xf::of(op, &pts, 1.0);
        let mut patch = |key: &str, hit: &dyn Fn(&Value) -> bool, f: &dyn Fn(&Value) -> Value| {
            ops.extend(list(root, key).iter().filter(|e| hit(e)).map(|e| replace(key, f(e))));
        };
        let walls = Ids::of(sel.wall_ids.iter().map(String::as_str));
        patch("walls", &|w| walls.has(w) && !locked(w), &|w| mv_wall(w, &xf));
        // Gespiegelte Wände ([134]): Türen ihrer Öffnungen schlagen gespiegelt auf.
        if xf.reverses() || xf.scale_k() != 1.0 {
            let mirrored: std::collections::HashSet<&str> =
                list(root, "walls").iter().filter(|w| walls.has(w) && !locked(w)).filter_map(|w| id_of(w)).collect();
            if !mirrored.is_empty() {
                patch("openings", &|o| wall_host(o).is_some_and(|h| mirrored.contains(h)) && mv_wall_opening(o, &xf) != *o, &|o| mv_wall_opening(o, &xf));
            }
        }
        let draw = Ids::of(sel.drawings());
        if !draw.is_empty() {
            let same = |id: &str| (moved.contains(id) || moved_openings.contains(id)).then(|| id.to_owned());
            patch("drawings2d", &|d| draw.has(d) && !locked(d), &|d| fix_refs(with_geom(d, geom_at(field(d, "geom").unwrap_or(&Value::Null), &xf, 1.0)), &same));
        }
        if let Some(id) = nonempty(&sel.extruded_solid_id) {
            patch("extrudedSolids", &|s| id_of(s) == Some(id), &|s| mv_solid(s, &xf, k_at(1.0)));
        }
        if let Some(id) = nonempty(&sel.column_id) {
            patch("columns", &|c| id_of(c) == Some(id) && !locked(c), &|c| mv_column(c, &xf));
        }
        let (ceil, roofs, stairs, rooms) = (Ids::opt(&sel.ceiling_ids), Ids::opt(&sel.roof_ids), Ids::opt(&sel.stair_ids), Ids::opt(&sel.room_ids));
        if !ceil.is_empty() {
            patch("ceilings", &|c| ceil.has(c) && !locked(c), &|c| mv_ceiling(c, &xf));
        }
        if !roofs.is_empty() && roof_allowed(op) {
            patch("roofs", &|r| roofs.has(r) && !locked(r), &|r| mv_roof(r, &xf));
        }
        if !stairs.is_empty() {
            patch("stairs", &|s| stairs.has(s) && !locked(s), &|s| mv_stair(s, &xf, k_at(1.0)));
        }
        if !rooms.is_empty() {
            patch("rooms", &|r| rooms.has(r) && !locked(r), &|r| mv_room(r, &xf));
        }
        let trees = Ids::opt(&sel.tree_ids);
        if !trees.is_empty() {
            patch("trees", &|t| trees.has(t) && !locked(t), &|t| mv_tree(t, &xf));
        }
        let ctx = Ids::opt(&sel.context_ids);
        if !ctx.is_empty() {
            patch("context", &|c| ctx.has(c), &|c| mv_context(c, &xf));
        }
        // Öffnungen in bewegten Dächern/Decken ([103]) folgen ihrem Wirt.
        let hosts: std::collections::HashSet<&str> =
            items.iter().filter(|(k, _)| matches!(k, Kind::Roof | Kind::Ceiling)).filter_map(|(_, e)| id_of(e)).collect();
        if !hosts.is_empty() {
            patch("openings", &|o| surface_host(o).is_some_and(|(_, h)| hosts.contains(h)), &|o| mv_surface_opening(o, &xf));
        }
        // Frei gewählte Wandöffnungen ([144]) gleiten entlang ihrer Wand (bzw. wechseln die Wand).
        let d = move_delta(&pts, 1.0);
        ops.extend(free.iter().filter_map(|o| slide(o, d, false).filter(|v| v != *o)).map(|v| replace("openings", v)));
        // Frei gewählte Dach-/Deckenöffnungen ([144]) gleiten in ihrer Fläche.
        ops.extend(free_surf.iter().filter_map(|o| slide_surface_opening(root, o, d).filter(|v| v != *o)).map(|v| replace("openings", v)));
    }

    // Kopien (Kopie/Reihe/Verteilen bzw. gespiegelte Kopie).
    let mut ids = IdGen::new(&req.stamp);
    let mut new: [Vec<Value>; 10] = Default::default();
    let mut new_openings = Vec::new();
    for t in copy_ts(op, &req.mode, req.count.0) {
        let xf = Xf::of(op, &pts, t);
        let prefixes: Vec<&str> = items
            .iter()
            .map(|(k, _)| match k {
                Kind::Wall => "W",
                Kind::Drawing => "dr2d",
                Kind::Solid => "extrude",
                Kind::Column => "column",
                Kind::Ceiling => "C",
                Kind::Roof => "RF",
                Kind::Stair => "ST",
                Kind::Room => "RM",
                Kind::Tree => "tree",
                Kind::Context => "ctx",
            })
            .collect();
        let new_ids: Vec<String> = prefixes.iter().map(|p| ids.next(p)).collect();
        let mut copied: std::collections::HashMap<&str, String> = items.iter().zip(&new_ids).filter_map(|((_, e), n)| Some((id_of(e)?, n.clone()))).collect();
        // Öffnungen kopierter Wände ([134]) mit neuer id an der neuen Wand — vor den Zeichnungen, damit
        // Bemassungs-Bezüge auf diese Öffnungen auf die Kopie umgeschrieben werden. Öffnungen sind keine
        // eigenen Transformations-Elemente; mitmarkierte entstehen so nur einmal.
        for o in list(root, "openings") {
            let (Some(oid), Some(nh)) = (id_of(o), wall_host(o).and_then(|h| copied.get(h)).cloned()) else { continue };
            let nid = ids.next("O");
            new_openings.push(with_all(&mv_wall_opening(o, &xf), vec![("id", Value::String(nid.clone())), ("hostWallId", Value::String(nh))]));
            copied.insert(oid, nid);
        }
        let to_copy = |id: &str| copied.get(id).cloned();
        for ((kind, e), new_id) in items.iter().zip(&new_ids) {
            let (slot, v) = match kind {
                Kind::Wall => (0, mv_wall(e, &xf)),
                Kind::Drawing => (1, fix_refs(with_geom(e, geom_at(field(e, "geom").unwrap_or(&Value::Null), &xf, t)), &to_copy)),
                Kind::Solid => (2, mv_solid(e, &xf, k_at(t))),
                Kind::Column => (3, mv_column(e, &xf)),
                Kind::Ceiling => (4, mv_ceiling(e, &xf)),
                Kind::Roof => (5, mv_roof(e, &xf)),
                Kind::Stair => (6, mv_stair(e, &xf, k_at(t))),
                Kind::Room => (7, mv_room(e, &xf)),
                Kind::Tree => (8, mv_tree(e, &xf)),
                Kind::Context => (9, mv_context(e, &xf)),
            };
            new[slot].push(with(&v, "id", Value::String(new_id.clone())));
        }
        // Öffnungen kopierter Dächer/Decken ([103]) mit neuem Wirt mitkopieren.
        for o in list(root, "openings") {
            let Some((key, nh)) = surface_host(o).and_then(|(k, h)| Some((k, to_copy(h)?))) else { continue };
            let v = with(&mv_surface_opening(o, &xf), key, Value::String(nh));
            new_openings.push(with(&v, "id", Value::String(ids.next("O"))));
        }
        // Kopien frei gewählter Wandöffnungen ([144]) in der Wand versetzt.
        for o in &free {
            if let Some(v) = slide(o, move_delta(&pts, t), true) {
                new_openings.push(with(&v, "id", Value::String(ids.next("O"))));
            }
        }
        for o in &free_surf {
            if let Some(v) = slide_surface_opening(root, o, move_delta(&pts, t)) {
                new_openings.push(with(&v, "id", Value::String(ids.next("O"))));
            }
        }
    }
    let keys = ["walls", "drawings2d", "extrudedSolids", "columns", "ceilings", "roofs", "stairs", "rooms", "trees", "context"];
    for (key, items) in keys.iter().zip(new) {
        ops.extend(add(key, items));
    }
    ops.extend(add("openings", new_openings));
    crate::grips::GripResult { ops, notice: notice.get(), ..Default::default() }
}

// ── Ausrichten/Verteilen, Block definieren ───────────────────────────────────

/// Verschiebt die Zeichnungen um je einen eigenen Vektor (in Listen-Reihenfolge; Vektor 0 = keine Op).
fn move_drawings(root: &Map<String, Value>, deltas: &std::collections::HashMap<String, (f64, f64)>) -> Vec<Op> {
    if deltas.is_empty() {
        return vec![];
    }
    let mut ops = Vec::new();
    for d in list(root, "drawings2d") {
        let Some(&(dx, dy)) = id_of(d).and_then(|id| deltas.get(id)) else { continue };
        if dx == 0.0 && dy == 0.0 {
            continue;
        }
        ops.push(replace("drawings2d", with_geom(d, mv_geom(field(d, "geom").unwrap_or(&Value::Null), &Xf::translate(dx, dy)))));
    }
    ops
}

/// Rahmen der gewählten Zeichnungen in Listen-Reihenfolge: (id, [minX, minY, maxX, maxY]) über
/// `selection_info::geom_bbox` (wie die Objekt-Info).
fn boxes(root: &Map<String, Value>, ids: &[String]) -> Vec<(String, [f64; 4])> {
    let wanted: std::collections::HashSet<&str> = ids.iter().map(String::as_str).collect();
    list(root, "drawings2d")
        .iter()
        .filter_map(|d| id_of(d).filter(|i| wanted.contains(i)).map(|i| (i.to_string(), crate::selection_info::geom_bbox(field(d, "geom").unwrap_or(&Value::Null)))))
        .collect()
}

/// Ausrichten an der gemeinsamen Kante/Mitte der Hülle aller gewählten Zeichnungen (ab zwei).
pub fn align_ops(root: &Map<String, Value>, ids: &[String], mode: &str) -> Vec<Op> {
    let bx = boxes(root, ids);
    if bx.len() < 2 {
        return vec![];
    }
    let fold = |k: fn(f64, f64) -> f64, i: usize, init: f64| bx.iter().fold(init, |m, b| k(m, b.1[i]));
    let (min_x, max_x) = (fold(jsnum::min, 0, f64::INFINITY), fold(jsnum::max, 2, f64::NEG_INFINITY));
    let (min_y, max_y) = (fold(jsnum::min, 1, f64::INFINITY), fold(jsnum::max, 3, f64::NEG_INFINITY));
    let (cx, cy) = ((min_x + max_x) / 2.0, (min_y + max_y) / 2.0);
    let mut deltas = std::collections::HashMap::new();
    for (id, b) in &bx {
        let [x0, y0, x1, y1] = *b;
        let d = match mode {
            "left" => (min_x - x0, 0.0),
            "right" => (max_x - x1, 0.0),
            "centerX" => (cx - (x0 + x1) / 2.0, 0.0),
            "top" => (0.0, max_y - y1),
            "bottom" => (0.0, min_y - y0),
            "centerY" => (0.0, cy - (y0 + y1) / 2.0),
            _ => (0.0, 0.0),
        };
        deltas.insert(id.clone(), d);
    }
    move_drawings(root, &deltas)
}

/// Verteilen mit gleichen Mittenabständen entlang `axis` (ab drei; die äussersten bleiben stehen).
pub fn distribute_ops(root: &Map<String, Value>, ids: &[String], axis: &str) -> Vec<Op> {
    let bx = boxes(root, ids);
    if bx.len() < 3 {
        return vec![];
    }
    let center = |b: &[f64; 4]| if axis == "x" { (b[0] + b[2]) / 2.0 } else { (b[1] + b[3]) / 2.0 };
    let mut sorted: Vec<&(String, [f64; 4])> = bx.iter().collect();
    // Wie `Array.prototype.sort` mit `a − b` (stabil; NaN gilt als gleich).
    sorted.sort_by(|a, b| {
        let d = center(&a.1) - center(&b.1);
        if d < 0.0 {
            std::cmp::Ordering::Less
        } else if d > 0.0 {
            std::cmp::Ordering::Greater
        } else {
            std::cmp::Ordering::Equal
        }
    });
    let first = center(&sorted[0].1);
    let last = center(&sorted[sorted.len() - 1].1);
    let step = (last - first) / (sorted.len() - 1) as f64;
    let mut deltas = std::collections::HashMap::new();
    for (i, b) in sorted.iter().enumerate() {
        if i == 0 || i == sorted.len() - 1 {
            continue;
        }
        let shift = first + step * i as f64 - center(&b.1);
        deltas.insert(b.0.clone(), if axis == "x" { (shift, 0.0) } else { (0.0, shift) });
    }
    move_drawings(root, &deltas)
}

/// Anfrage „Block definieren“.
#[derive(Deserialize, Default, Debug)]
#[serde(default, rename_all = "camelCase")]
pub struct DefBlockReq {
    pub ids: Vec<String>,
    pub at: [N; 2],
    pub level_id: String,
    pub category_code: String,
    pub stamp: String,
}

/// Macht aus den gewählten Zeichnungen (ohne Block-Instanzen) eine Block-Definition mit Ursprung `at`
/// und ersetzt sie durch eine Instanz an `at`.
pub fn defblock_ops(root: &Map<String, Value>, r: &DefBlockReq) -> Vec<Op> {
    let wanted: std::collections::HashSet<&str> = r.ids.iter().map(String::as_str).collect();
    let srcs: Vec<&Value> = list(root, "drawings2d")
        .iter()
        .filter(|d| id_of(d).is_some_and(|i| wanted.contains(i)) && shape(field(d, "geom").unwrap_or(&Value::Null)) != "block")
        .collect();
    if srcs.is_empty() {
        return vec![];
    }
    let (ax, ay) = (r.at[0].0, r.at[1].0);
    let to_local = Xf::translate(-ax, -ay);
    let mut ids = IdGen::new(&r.stamp);
    let def_id = ids.next("blk");
    let mut def = Map::new();
    def.insert("id".into(), def_id.clone().into());
    def.insert("name".into(), format!("Block {}", list(root, "blockDefs").len() + 1).into());
    def.insert("geom2d".into(), Value::Array(srcs.iter().map(|d| mv_geom(field(d, "geom").unwrap_or(&Value::Null), &to_local).unwrap_or(Value::Null)).collect()));
    let mut geom = Map::new();
    geom.insert("shape".into(), "block".into());
    geom.insert("blockDefId".into(), def_id.into());
    geom.insert("at".into(), pt(ax, ay));
    geom.insert("rotation".into(), 0.into());
    let mut inst = Map::new();
    inst.insert("id".into(), ids.next("dr2d").into());
    inst.insert("type".into(), "drawing2d".into());
    inst.insert("levelId".into(), r.level_id.clone().into());
    inst.insert("categoryCode".into(), r.category_code.clone().into());
    inst.insert("geom".into(), Value::Object(geom));
    let mut seen = std::collections::HashSet::new();
    let drop: Vec<String> = srcs.iter().filter_map(|d| id_of(d)).filter(|i| seen.insert(*i)).map(str::to_owned).collect();
    vec![
        Op::Add { collection: "blockDefs".into(), items: vec![Value::Object(def)], at: None },
        Op::Remove { collection: "drawings2d".into(), ids: drop },
        Op::Add { collection: "drawings2d".into(), items: vec![Value::Object(inst)], at: None },
    ]
}

// ── Vorschau ─────────────────────────────────────────────────────────────────

/// Vorschau-Formen als flacher Puffer: je Form `[art, n, x0, y0, …]` (art 0 = Linie mit n = 2,
/// 1 = geschlossenes Polygon, 2 = offener Linienzug).
#[derive(Default)]
pub struct Shapes {
    pub buf: Vec<f64>,
    pub count: usize,
}

impl Shapes {
    pub fn line(&mut self, a: (f64, f64), b: (f64, f64)) {
        self.count += 1;
        self.buf.extend([0.0, 2.0, a.0, a.1, b.0, b.1]);
    }
    pub fn poly(&mut self, pts: &[(f64, f64)]) {
        self.poly_as(1.0, pts);
    }
    /// Offener Linienzug (art 2).
    pub fn poly_open(&mut self, pts: &[(f64, f64)]) {
        self.poly_as(2.0, pts);
    }
    fn poly_as(&mut self, kind: f64, pts: &[(f64, f64)]) {
        self.count += 1;
        self.buf.extend([kind, pts.len() as f64]);
        for p in pts {
            self.buf.extend([p.0, p.1]);
        }
    }
}

/// Obergrenze je Element (Schraffur-Muster u. Ä. erzeugen sehr viele Linien).
const MAX_SHAPES_PER_ITEM: usize = 4000;

fn ring_lines(c: (f64, f64), r: f64, a0: f64, a1: f64, out: &mut Shapes) {
    let sweep = a1 - a0;
    let n = jsnum::max(8.0, ((sweep.abs() / (std::f64::consts::PI * 2.0)) * 48.0).ceil());
    let at = |a: f64| (c.0 + r * jsnum::cos(a), c.1 + r * jsnum::sin(a));
    let mut prev = at(a0);
    let mut i = 1.0;
    while i <= n {
        let p = at(a0 + (sweep * i) / n);
        out.line(prev, p);
        prev = p;
        i += 1.0;
    }
}

/// Plan-Primitive → Vorschau-Formen (`primitivesToDraftShapes`); `top` = Grundlinie→Oberkante der Schrift.
fn prims_to_shapes(prims: &[crate::plan::prim::Primitive], top: f64, out: &mut Shapes) {
    use crate::plan::prim::Primitive as P;
    let start = out.count;
    let v = |q: &crate::model::Vec2| (q.x, q.y);
    for p in prims {
        if out.count - start >= MAX_SHAPES_PER_ITEM {
            break;
        }
        match p {
            P::Line { a, b, .. } => out.line(v(a), v(b)),
            P::Polygon { pts, .. } => {
                if pts.len() >= 2 {
                    out.poly(&pts.iter().map(v).collect::<Vec<_>>());
                }
            }
            P::DrawingCircle { center, r, .. } => ring_lines(v(center), *r, 0.0, std::f64::consts::PI * 2.0, out),
            P::DrawingArc { center, r, a0, a1, .. } => {
                let tau = std::f64::consts::PI * 2.0;
                let s = (((a1 - a0) % tau) + tau) % tau;
                let sweep = if s == 0.0 || s.is_nan() { tau } else { s };
                ring_lines(v(center), *r, *a0, a0 + sweep, out);
            }
            P::Arc { center, from, to, .. } => {
                let a0 = jsnum::atan2(from.y - center.y, from.x - center.x);
                let a1 = jsnum::atan2(to.y - center.y, to.x - center.x);
                let mut d = a1 - a0;
                while d <= -std::f64::consts::PI {
                    d += 2.0 * std::f64::consts::PI;
                }
                while d > std::f64::consts::PI {
                    d -= 2.0 * std::f64::consts::PI;
                }
                let r = hypot2(from.x - center.x, from.y - center.y);
                ring_lines(v(center), r, a0, a0 + d, out);
            }
            P::DrawingText { at, text, height_m, angle, marks, wrap_width, doc, .. } => {
                let doc = doc.clone().unwrap_or_else(|| crate::text_layout::doc_from_text(text, &marks.clone().unwrap_or_default()));
                let c = crate::text_layout::text_frame_corners(&doc, (at.x, at.y), *height_m, *angle, Some(wrap_width.unwrap_or(f64::NAN)), top);
                out.poly(&c);
            }
            P::DrawingTextPath { path_pts, .. } => {
                for w in path_pts.windows(2) {
                    out.line(v(&w[0]), v(&w[1]));
                }
            }
            P::DrawingImage { min, max, .. } => out.poly(&[(min.x, min.y), (max.x, min.y), (max.x, max.y), (min.x, max.y)]),
            _ => {}
        }
    }
}

/// Vorschau, bevor die typisierte Sicht gelesen wird (getrennte Ausleihen des Dokuments): die Formen der
/// Bauteile in einem Puffer, die abgebildeten Zeichnungen mit ihrer Einfügestelle (Primitive erst danach).
#[derive(Default)]
pub struct Pending {
    shapes: Shapes,
    /// (Stelle im Puffer, abgebildete Zeichnung) in Reihenfolge.
    drawings: Vec<(usize, Value)>,
}

impl Pending {
    pub fn has_drawings(&self) -> bool {
        !self.drawings.is_empty()
    }
}

fn pts_of(v: Option<&Value>) -> Vec<(f64, f64)> {
    arr(v).iter().map(xy).collect()
}

fn mapped(pts: &[(f64, f64)], xf: &Xf) -> Vec<(f64, f64)> {
    pts.iter().map(|p| xf.apply(p.0, p.1)).collect()
}

/// Wand-Dicke über den Wandtyp (`wallTypeThickness`), ohne Typ 0.2 m.
fn wall_thickness(p: &Project, w: &Value) -> f64 {
    let tid = field(w, "wallTypeId").and_then(Value::as_str);
    match p.wall_types.iter().find(|t| tid == Some(t.id.as_str())) {
        Some(t) => t.layers.iter().fold(0.0, |s, l| s + l.thickness),
        None => 0.2,
    }
}

fn item_preview(p: &Project, kind: Kind, e: &Value, xf: &Xf, out: &mut Pending) {
    let s = &mut out.shapes;
    let pt = |k: &str| xy(field(e, k).unwrap_or(&Value::Null));
    match kind {
        Kind::Wall => {
            let th = wall_thickness(p, e);
            let (sx, sy) = pt("start");
            let (ex, ey) = pt("end");
            let (a, b) = (xf.apply(sx, sy), xf.apply(ex, ey));
            let bulge = field(e, "bulge").and_then(Value::as_f64).map(|b| if xf.reverses() { -b } else { b });
            if let Some((band, axis)) = crate::wall_arc::band_preview(a, b, bulge, th) {
                s.poly(&band);
                s.poly_open(&axis);
                return;
            }
            let v = |p: (f64, f64)| crate::model::Vec2 { x: p.0, y: p.1 };
            let c = crate::site_rules::wall_corners(v(a), v(b), th);
            s.poly(&[(c[0][0], c[0][1]), (c[1][0], c[1][1]), (c[2][0], c[2][1]), (c[3][0], c[3][1])]);
            s.line(a, b);
        }
        Kind::Solid => s.poly(&mapped(&pts_of(field(e, "points")), xf)),
        Kind::Column => {
            if let Ok(c) = serde_json::from_value::<crate::model::Column>(e.clone()) {
                let fp: Vec<(f64, f64)> = crate::model3d::column_footprint(&c).iter().map(|q| (q.x, q.y)).collect();
                s.poly(&mapped(&fp, xf));
            }
        }
        Kind::Ceiling | Kind::Roof => s.poly(&mapped(&pts_of(field(e, "outline")), xf)),
        Kind::Room => s.poly(&mapped(&pts_of(field(e, "boundary")), xf)),
        Kind::Stair => stair_preview(e, xf, s),
        Kind::Tree => {
            // [149] Kronenkreis um die verschobene Stammmitte.
            let (x, y) = pt("position");
            let c = xf.apply(x, y);
            let d = field(e, "crownDiameter").and_then(Value::as_f64).filter(|d| *d > 0.0 && d.is_finite()).unwrap_or(crate::tree::DEFAULT_CROWN_DIAMETER);
            let ring: Vec<(f64, f64)> = crate::tree::circle([c.0, c.1], d / 2.0, 24).into_iter().map(|q| (q[0], q[1])).collect();
            s.poly(&ring);
        }
        Kind::Context => {
            // [193] Baugrube: Umriss; Netze, Höhenlinien, Bild: Rahmen der abgebildeten Punkte.
            let pts: Vec<(f64, f64)> = match field(e, "type").and_then(Value::as_str) {
                Some("excavation") => pts_of(field(e, "outline")),
                Some("importedMesh" | "terrainMesh") => arr(field(e, "positions")).chunks(3).filter(|c| c.len() == 3).map(|c| (num_of(Some(&c[0])), num_of(Some(&c[1])))).collect(),
                Some("contourSet") => arr(field(e, "contours")).iter().flat_map(|c| pts_of(field(c, "pts"))).collect(),
                Some("image") => {
                    let (a, b) = (xy(field(e, "min").unwrap_or(&Value::Null)), xy(field(e, "max").unwrap_or(&Value::Null)));
                    vec![a, (b.0, a.1), b, (a.0, b.1)]
                }
                _ => vec![],
            };
            let mapped_pts = mapped(&pts, xf);
            if field(e, "type").and_then(Value::as_str) == Some("excavation") {
                s.poly(&mapped_pts);
            } else if !mapped_pts.is_empty() {
                let (x0, x1) = mapped_pts.iter().fold((f64::INFINITY, f64::NEG_INFINITY), |a, p| (a.0.min(p.0), a.1.max(p.0)));
                let (y0, y1) = mapped_pts.iter().fold((f64::INFINITY, f64::NEG_INFINITY), |a, p| (a.0.min(p.1), a.1.max(p.1)));
                s.poly(&[(x0, y0), (x1, y0), (x1, y1), (x0, y1)]);
            }
        }
        Kind::Drawing => {
            let at = s.buf.len();
            out.drawings.push((at, with_geom(e, mv_geom(field(e, "geom").unwrap_or(&Value::Null), xf))));
        }
    }
}

/// Treppe: gerade/L über den echten Umriss; Wendel als grob abgetasteter Innen-/Aussenring.
fn stair_preview(e: &Value, xf: &Xf, out: &mut Shapes) {
    let Ok(st) = serde_json::from_value::<crate::model::Stair>(e.clone()) else { return };
    if st.shape != crate::model::StairShape::Spiral {
        let o = crate::stair::decode_params(&st.encode()).map(|p| kernel2d::stair_outline(&p));
        if let Some(poly) = o.and_then(|o| o.polygon) {
            out.poly(&poly.iter().map(|q| xf.apply(q.x, q.y)).collect::<Vec<_>>());
        }
        return;
    }
    let c = st.center.unwrap_or(st.start);
    let r_in = jsnum::max(0.0, st.radius.unwrap_or(0.0));
    let r_out = r_in + st.width;
    let sweep = st.sweep.unwrap_or(360.0);
    let a0 = jsnum::atan2(st.start.y - c.y, st.start.x - c.x);
    let steps = jsnum::max(4.0, jsnum::round(sweep.abs() / 15.0));
    let (mut outer, mut inner) = (Vec::new(), Vec::new());
    let mut i = 0.0;
    while i <= steps {
        let a = a0 + ((sweep * std::f64::consts::PI) / 180.0) * (i / steps);
        let (co, si) = (jsnum::cos(a), jsnum::sin(a));
        outer.push(xf.apply(c.x + co * r_out, c.y + si * r_out));
        inner.push(xf.apply(c.x + co * r_in, c.y + si * r_in));
        i += 1.0;
    }
    inner.reverse();
    outer.extend(inner);
    out.poly(&outer);
}

/// Vorschau aller Instanzen (Kopien, dann das bewegte Original im Modus „move“) — Teil 1 auf der Wurzel.
pub fn preview_pending(root: &Map<String, Value>, p: &Project, req: &TransformReq) -> Pending {
    let op = req.op.as_str();
    let items = gather(root, &req.sel, op, req.ignore_lock);
    let pts = req.points();
    let mut ts = copy_ts(op, &req.mode, req.count.0);
    if req.mode == "move" {
        ts.push(1.0);
    }
    let (free, free_surf) = free_sets(root, &req.sel, op, &items, req.ignore_lock);
    let free_ids: std::collections::HashSet<&str> = free.iter().filter_map(|o| id_of(o)).collect();
    let skip = |id: &str| free_ids.contains(id);
    let mut out = Pending::default();
    for t in ts {
        let xf = Xf::of(op, &pts, t);
        for (kind, e) in &items {
            item_preview(p, *kind, e, &xf, &mut out);
        }
        for o in &free {
            if let Some(q) = slide_opening(root, p, o, move_delta(&pts, t), req.mode != "move", &skip).and_then(|(v, _)| opening_quad(root, p, &v)) {
                out.shapes.poly(&q);
            }
        }
        for o in &free_surf {
            if let Some(q) = slide_surface_opening(root, o, move_delta(&pts, t)).map(|v| surface_quad(&v)) {
                out.shapes.poly(&q);
            }
        }
    }
    out
}

/// Dach-/Deckenöffnung als Rechteck um `hostPoint` (Vorschau, [144]; Breite quer, Höhe im Grundriss
/// ungekürzt, gedreht um `hostAngle`).
fn surface_quad(o: &Value) -> Vec<(f64, f64)> {
    let (cx, cy) = xy(field(o, "hostPoint").unwrap_or(&Value::Null));
    let (w, h) = (num_or(field(o, "width"), 1.0) / 2.0, num_or(field(o, "height"), 1.0) / 2.0);
    let a = field(o, "hostAngle").and_then(Value::as_f64).unwrap_or(0.0);
    let (c, s) = (jsnum::cos(a), jsnum::sin(a));
    [(-w, -h), (w, -h), (w, h), (-w, h)].iter().map(|(x, y)| (cx + x * c - y * s, cy + x * s + y * c)).collect()
}

/// Lücke einer Wandöffnung (Vorschau, [144]): Rechteck über die volle Wanddicke um die Achse; in einer
/// Bogenwand der Ringsektor-Abschnitt (Sehnen).
fn opening_quad(root: &Map<String, Value>, p: &Project, o: &Value) -> Option<Vec<(f64, f64)>> {
    use crate::opening_geom::{opening_gap_quad, v, WallRef};
    let w = list(root, "walls").iter().find(|w| id_of(w) == wall_host(o))?;
    if let Some(ax @ crate::opening_slide::Axis::Arc(_)) = crate::opening_slide::Axis::of(w) {
        let (a, b) = (num_of(field(o, "position")), num_of(field(o, "width")));
        let half = wall_thickness(p, w) / 2.0;
        let n = 8;
        let ts: Vec<f64> = (0..=n).map(|i| a + b * i as f64 / n as f64).collect();
        let mut q: Vec<(f64, f64)> = ts.iter().map(|t| ax.point(*t, half)).collect();
        q.extend(ts.iter().rev().map(|t| ax.point(*t, -half)));
        return q.iter().all(|c| c.0.is_finite() && c.1.is_finite()).then_some(q);
    }
    let (s, e) = straight_wall(w)?;
    let wr = WallRef { start: v(s.0, s.1), end: v(e.0, e.1), total: wall_thickness(p, w), ref_off: 0.0 };
    let q = opening_gap_quad(&wr, num_of(field(o, "position")), num_of(field(o, "width")))?;
    Some(q.iter().map(|c| (c.x, c.y)).collect())
}

/// Teil 2: Zeichnungen über dieselbe Primitiv-Erzeugung wie der Plan (ohne Override-Regeln), Rückfall
/// auf einfache Formen, wenn daraus nichts entsteht.
pub fn preview_finish(p: Option<&crate::model::Project>, pending: Pending, scale: f64, top: f64) -> Vec<f64> {
    use crate::plan::{domains, drawings};
    if pending.drawings.is_empty() {
        return pending.shapes.buf;
    }
    let args = domains::PlanArgs::parse(1.0, "{}").ok();
    let ctx = p.zip(args.as_ref()).map(|(p, a)| domains::Ctx::new(p, a));
    let src = pending.shapes.buf;
    let mut out = Shapes::default();
    let mut from = 0;
    for (at, v) in pending.drawings {
        out.buf.extend_from_slice(&src[from..at]);
        from = at;
        let before = out.count;
        if let (Some(c), Ok(d)) = (&ctx, serde_json::from_value::<crate::model::Drawing2D>(v.clone())) {
            let mut prims = drawings::Out::default();
            let ok = drawings::emit(c, &d, drawings::Attrs::of(c, &d), &d.geom, false, scale, &mut drawings::Sink::new(drawings::Target::Vec(&mut prims), drawings::Keep::All), 0);
            if ok.is_ok() {
                prims_to_shapes(&prims.prims, top, &mut out);
            }
        }
        if out.count == before {
            fallback_shapes(field(&v, "geom").unwrap_or(&Value::Null), &mut out);
        }
    }
    out.buf.extend_from_slice(&src[from..]);
    out.buf
}

fn fallback_shapes(g: &Value, out: &mut Shapes) {
    let p = |k: &str| xy(field(g, k).unwrap_or(&Value::Null));
    match shape(g) {
        "line" => out.line(p("a"), p("b")),
        "polyline" => {
            let pts = pts_of(field(g, "pts"));
            for w in pts.windows(2) {
                out.line(w[0], w[1]);
            }
            if truthy(field(g, "closed")) && pts.len() > 2 {
                out.line(pts[pts.len() - 1], pts[0]);
            }
        }
        "rect" | "image" => {
            let (min, max) = (p("min"), p("max"));
            out.poly(&[min, (max.0, min.1), max, (min.0, max.1)]);
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn root(v: Value) -> Map<String, Value> {
        v.as_object().unwrap().clone()
    }

    /// [149] Bäume: Verschieben (gesperrte bleiben), Kopieren mit neuer id.
    #[test]
    fn baeume_verschieben_und_kopieren() {
        let r = root(json!({"trees":[{"id":"t","position":{"x":1,"y":2},"crownDiameter":5},{"id":"z","position":{"x":0,"y":0},"locked":true}]}));
        let run = |mode: &str| {
            let req: TransformReq = serde_json::from_value(json!({"sel":{"wallIds":[],"treeIds":["t","z"]},"op":"move","pts":[[0, 0], [3, 1]],"mode":mode,"count":1,"stamp":"s"})).unwrap();
            transform_ops(&r, &Project::default(), &req).iter().map(|o| o.to_json()).collect::<Vec<_>>()
        };
        let ops = run("move");
        assert_eq!(ops.len(), 1);
        assert_eq!(ops[0]["entity"]["position"], json!({"x":4,"y":3}));
        assert_eq!(ops[0]["entity"]["crownDiameter"], json!(5));
        let ops = run("copy");
        assert_eq!(ops.len(), 1);
        assert_eq!(ops[0]["collection"], "trees");
        assert_eq!(ops[0]["items"][0]["id"], "tree-s-1");
        assert_eq!(ops[0]["items"][0]["position"], json!({"x":4,"y":3}));
    }

    /// [193] Gelände-/Umgebungs-Elemente verschieben: Baugrube (Umriss), Höhenlinien, Gelände-Netz (z bleibt), Spiegeln kehrt den Netz-Umlauf um.
    #[test]
    fn kontext_verschieben() {
        let r = root(json!({"context":[
            {"id":"bg","type":"excavation","bottom":-2,"outline":[{"x":0,"y":0},{"x":4,"y":0},{"x":4,"y":4}]},
            {"id":"hl","type":"contourSet","contours":[{"z":5,"pts":[{"x":1,"y":1},{"x":2,"y":1}],"closed":false}]},
            {"id":"tm","type":"terrainMesh","positions":[0,0,7, 1,0,8, 0,1,9],"indices":[0,1,2]},
            {"id":"x","type":"excavation","outline":[{"x":0,"y":0}]}]}));
        let run = |op: &str, pts: Value| {
            let req: TransformReq = serde_json::from_value(json!({"sel":{"wallIds":[],"contextIds":["bg","hl","tm"]},"op":op,"pts":pts,"mode":"move","count":1,"stamp":"s"})).unwrap();
            transform_ops(&r, &Project::default(), &req).iter().map(|o| o.to_json()).collect::<Vec<_>>()
        };
        let ops = run("move", json!([[0, 0], [3, 1]]));
        assert_eq!(ops.len(), 3, "{ops:?}");
        assert!(ops.iter().all(|o| o["collection"] == "context"));
        assert_eq!(ops[0]["entity"]["outline"][1], json!({"x":7,"y":1}));
        assert_eq!(ops[0]["entity"]["bottom"], json!(-2));
        assert_eq!(ops[1]["entity"]["contours"][0]["pts"][0], json!({"x":4,"y":2}));
        assert_eq!(ops[2]["entity"]["positions"], json!([3, 1, 7, 4, 1, 8, 3, 2, 9]));
        assert_eq!(ops[2]["entity"]["indices"], json!([0, 1, 2]));
        // Spiegeln an der x-Achse: y wechselt das Vorzeichen, Dreiecke laufen rückwärts.
        let ops = run("mirror", json!([[0, 0], [1, 0]]));
        assert_eq!(ops[2]["entity"]["positions"], json!([0, 0, 7, 1, 0, 8, 0, -1, 9]));
        assert_eq!(ops[2]["entity"]["indices"], json!([0, 2, 1]));
    }

    /// [T2] Bogenwand: Verschieben/Drehen behalten den Bulge, Spiegeln kehrt ihn um.
    #[test]
    fn bogenwand_spiegeln_kehrt_bulge() {
        let r = root(json!({"walls":[{"id":"a","start":{"x":0,"y":0},"end":{"x":4,"y":0},"bulge":0.5}]}));
        let run = |op: &str, pts: Value| {
            let req: TransformReq = serde_json::from_value(json!({"sel":{"wallIds":["a"]},"op":op,"pts":pts,"mode":"move","count":1,"stamp":"s"})).unwrap();
            transform_ops(&r, &Project::default(), &req)[0].to_json()["entity"].clone()
        };
        assert_eq!(run("move", json!([[0, 0], [1, 1]]))["bulge"], json!(0.5));
        assert_eq!(run("rotate", json!([[0, 0], [1, 0], [0, 1]]))["bulge"], json!(0.5));
        assert_eq!(run("mirror", json!([[0, 0], [0, 1]]))["bulge"], json!(-0.5));
    }

    /// [103] Dach-/Deckenöffnungen folgen ihrem Wirt: Verschieben/Drehen bildet `hostPoint` (und
    /// `hostAngle`) mit ab, Kopieren kopiert sie mit neuem Wirt; gesperrter Wirt bleibt stehen.
    #[test]
    fn dach_und_deckenoeffnungen_folgen_dem_wirt() {
        let r = root(json!({
            "roofs":[{"id":"r","outline":[{"x":0,"y":0},{"x":4,"y":0},{"x":4,"y":4},{"x":0,"y":4}]}],
            "ceilings":[{"id":"c","outline":[{"x":0,"y":0},{"x":4,"y":0},{"x":4,"y":4}]},{"id":"c2","outline":[],"locked":true}],
            "openings":[
                {"id":"o1","hostWallId":"","hostRoofId":"r","hostPoint":{"x":1,"y":2}},
                {"id":"o2","hostWallId":"","hostCeilingId":"c","hostPoint":{"x":1,"y":1},"hostAngle":0},
                {"id":"o3","hostWallId":"w","position":1},
                {"id":"o4","hostWallId":"","hostCeilingId":"c2","hostPoint":{"x":1,"y":1}}
            ]}));
        let run = |op: &str, pts: Value, mode: &str| {
            let req: TransformReq = serde_json::from_value(json!({"sel":{"roofIds":["r"],"ceilingIds":["c","c2"]},"op":op,"pts":pts,"mode":mode,"count":1,"stamp":"s"})).unwrap();
            transform_ops(&r, &Project::default(), &req).iter().map(|o| o.to_json()).collect::<Vec<_>>()
        };
        let ops = run("move", json!([[0, 0], [2, 3]]), "move");
        let op_of = |ops: &[Value], id: &str| ops.iter().find(|o| o["collection"] == "openings" && o["entity"]["id"] == id).cloned();
        assert_eq!(op_of(&ops, "o1").unwrap()["entity"]["hostPoint"], json!({"x":3,"y":5}));
        assert_eq!(op_of(&ops, "o2").unwrap()["entity"]["hostPoint"], json!({"x":3,"y":4}));
        assert!(op_of(&ops, "o4").is_none(), "gesperrte Decke bewegt ihre Öffnung nicht");
        assert!(op_of(&ops, "o3").is_none());
        // Drehen um 90° um den Ursprung (Dächer drehen nicht): Decke (1,1) → (−1,1), hostAngle 0 → π/2.
        let ops = run("rotate", json!([[0, 0], [1, 0], [0, 1]]), "move");
        assert!(op_of(&ops, "o1").is_none());
        let e = op_of(&ops, "o2").unwrap()["entity"].clone();
        assert!((e["hostPoint"]["x"].as_f64().unwrap() + 1.0).abs() < 1e-9 && (e["hostPoint"]["y"].as_f64().unwrap() - 1.0).abs() < 1e-9);
        assert!((e["hostAngle"].as_f64().unwrap() - std::f64::consts::FRAC_PI_2).abs() < 1e-9);
        // Kopie: neue Öffnung am neuen Dach.
        let ops = run("move", json!([[0, 0], [10, 0]]), "copy");
        let roof_add = ops.iter().find(|o| o["collection"] == "roofs").unwrap();
        let new_roof = roof_add["items"][0]["id"].as_str().unwrap().to_owned();
        let op_add = ops.iter().find(|o| o["collection"] == "openings").expect("Öffnung mitkopiert");
        let items = op_add["items"].as_array().unwrap();
        assert_eq!(items.len(), 2, "Dach- und Deckenöffnung, nicht die der gesperrten Decke");
        assert_eq!(items[0]["hostRoofId"], json!(new_roof));
        assert_ne!(items[0]["id"], json!("o1"));
        assert_eq!(items[0]["hostPoint"], json!({"x":11,"y":2}));
    }

    /// [133] Skalieren (Kopie und Original) skaliert Lage und Breite der Wandöffnungen mit.
    #[test]
    fn skalieren_skaliert_oeffnungen() {
        let r = root(json!({
            "walls":[{"id":"w","start":{"x":1,"y":0},"end":{"x":6,"y":0}}],
            "openings":[{"id":"d","hostWallId":"w","kind":"door","position":1,"width":0.9}]}));
        let run = |mode: &str| {
            let req: TransformReq = serde_json::from_value(json!({"sel":{"wallIds":["w"]},"op":"scale","pts":[[0,0],[1,0],[2,0]],"mode":mode,"count":1,"stamp":"s"})).unwrap();
            transform_ops(&r, &Project::default(), &req).iter().map(|o| o.to_json()).collect::<Vec<_>>()
        };
        let ops = run("copy");
        let o = ops.iter().find(|o| o["kind"] == "add" && o["collection"] == "openings").unwrap()["items"][0].clone();
        assert_eq!((o["position"].as_f64(), o["width"].as_f64()), (Some(2.0), Some(1.8)));
        let ops = run("move");
        let o = ops.iter().find(|o| o["kind"] == "replace" && o["collection"] == "openings").unwrap()["entity"].clone();
        assert_eq!((o["position"].as_f64(), o["width"].as_f64()), (Some(2.0), Some(1.8)));
    }

    /// [134] Wandöffnungen werden mit ihrer Wand kopiert (Kopie, Reihe, gespiegelte Kopie): neue ids,
    /// neue Wirtswand, gleiche Lage entlang der Wand; Spiegeln kehrt den Türaufschlag wie beim
    /// Verschieben-Spiegeln; mitmarkierte Öffnungen entstehen nur einmal; Bemassungs-Bezüge folgen.
    #[test]
    fn wandoeffnungen_werden_mitkopiert() {
        let r = root(json!({
            "walls":[{"id":"w","start":{"x":0,"y":0},"end":{"x":5,"y":0}},{"id":"w2","start":{"x":0,"y":3},"end":{"x":5,"y":3}}],
            "openings":[
                {"id":"d","hostWallId":"w","kind":"door","position":1,"width":0.9,"swing":"left","hinge":"start"},
                {"id":"f","hostWallId":"w","kind":"window","position":3,"width":1.2},
                {"id":"x","hostWallId":"w2","kind":"door","position":1,"width":0.9},
                {"id":"r","hostWallId":"","hostRoofId":"rf","hostPoint":{"x":1,"y":1}}
            ],
            "drawings2d":[{"id":"m","geom":{"shape":"dimension","pts":[{"x":1,"y":0},{"x":1.9,"y":0}],"refs":[{"id":"d","feature":"opening","index":0},{"id":"d","feature":"opening","index":1}]}}]}));
        let run = |op: &str, pts: Value, mode: &str, sel: Value, count: f64| {
            let req: TransformReq = serde_json::from_value(json!({"sel":sel,"op":op,"pts":pts,"mode":mode,"count":count,"stamp":"s"})).unwrap();
            transform_ops(&r, &Project::default(), &req).iter().map(|o| o.to_json()).collect::<Vec<_>>()
        };
        let added = |ops: &[Value], c: &str| ops.iter().find(|o| o["kind"] == "add" && o["collection"] == c).map(|o| o["items"].as_array().unwrap().clone()).unwrap_or_default();
        // Kopie (Tür + Fenster mitmarkiert): 2 neue Öffnungen an der neuen Wand, nicht doppelt.
        let ops = run("move", json!([[0, 0], [0, 10]]), "copy", json!({"wallIds":["w"],"openingIds":["d","f"]}), 1.0);
        let nw = added(&ops, "walls")[0]["id"].as_str().unwrap().to_owned();
        let os = added(&ops, "openings");
        assert_eq!(os.len(), 2);
        for (o, (old, pos)) in os.iter().zip([("d", 1), ("f", 3)]) {
            assert_eq!(o["hostWallId"], json!(nw));
            assert_ne!(o["id"], json!(old));
            assert_eq!(o["position"], json!(pos));
        }
        assert_eq!(os[0]["swing"], "left", "Verschieben-Kopie behält den Aufschlag");
        // Reihe ×3: je Wand Tür + Fenster.
        let ops = run("move", json!([[0, 0], [0, 10]]), "array", json!({"wallIds":["w"]}), 3.0);
        let (ws, os) = (added(&ops, "walls"), added(&ops, "openings"));
        assert_eq!((ws.len(), os.len()), (3, 6));
        for w in &ws {
            assert_eq!(os.iter().filter(|o| o["hostWallId"] == w["id"]).count(), 2);
        }
        let mut ids: Vec<&str> = os.iter().map(|o| o["id"].as_str().unwrap()).collect();
        ids.dedup();
        assert_eq!(ids.len(), 6, "eindeutige ids");
        // Gespiegelte Kopie: Tür schlägt gespiegelt auf (links → rechts), Scharnier/Lage bleiben.
        let ops = run("mirror", json!([[0, 1], [5, 1]]), "copy", json!({"wallIds":["w","w2"]}), 1.0);
        let os = added(&ops, "openings");
        assert_eq!(os.len(), 3);
        assert_eq!((&os[0]["swing"], &os[0]["hinge"], &os[0]["position"]), (&json!("right"), &json!("start"), &json!(1)));
        assert!(os[1].get("swing").is_none(), "Fenster ohne Aufschlag");
        assert_eq!(os[2]["swing"], "right", "fehlender Aufschlag gilt als links");
        // Verschieben-Spiegeln kehrt denselben Aufschlag (gleiches Ergebnis wie die gespiegelte Kopie).
        let ops = run("mirror", json!([[0, 1], [5, 1]]), "move", json!({"wallIds":["w"]}), 1.0);
        let rep: Vec<&Value> = ops.iter().filter(|o| o["kind"] == "replace" && o["collection"] == "openings").collect();
        assert_eq!(rep.len(), 1, "nur die Tür ändert sich");
        assert_eq!((&rep[0]["entity"]["id"], &rep[0]["entity"]["swing"]), (&json!("d"), &json!("right")));
        // Bemassung auf die Tür, mit der Wand kopiert: Bezug zeigt auf die kopierte Tür.
        let ops = run("move", json!([[0, 0], [0, 10]]), "copy", json!({"wallIds":["w"],"drawingIds":["m"]}), 1.0);
        let nd = added(&ops, "openings")[0]["id"].clone();
        let dim = &added(&ops, "drawings2d")[0];
        assert_eq!(dim["geom"]["refs"][0]["id"], nd);
        assert_eq!(dim["geom"]["refs"][1]["id"], nd);
    }

    /// [144] Gewählte Wandöffnung allein verschieben: gleitet um die projizierte Strecke entlang der Wand
    /// (geklemmt), wechselt in eine getroffene andere Wand, Kopie in derselben Wand; mit der Wand: starr.
    #[test]
    fn oeffnung_gleitet_entlang_der_wand() {
        let r = root(json!({
            "walls":[
                {"id":"w","floorId":"eg","start":{"x":0,"y":0},"end":{"x":5,"y":0}},
                {"id":"v","floorId":"eg","start":{"x":5,"y":0},"end":{"x":5,"y":4}},
                {"id":"og","floorId":"og","start":{"x":0,"y":3},"end":{"x":5,"y":3}},
                {"id":"b","floorId":"eg","start":{"x":0,"y":6},"end":{"x":4,"y":6},"bulge":0.3}
            ],
            "openings":[
                {"id":"d","hostWallId":"w","kind":"door","position":1,"width":0.9},
                {"id":"z","hostWallId":"w","kind":"door","position":1,"width":0.9,"locked":true},
                {"id":"a","hostWallId":"b","kind":"window","position":1,"width":1}
            ]}));
        let run = |pts: Value, mode: &str, sel: Value| {
            let req: TransformReq = serde_json::from_value(json!({"sel":sel,"op":"move","pts":pts,"mode":mode,"count":2,"stamp":"s"})).unwrap();
            transform_ops(&r, &Project::default(), &req).iter().map(|o| o.to_json()).collect::<Vec<_>>()
        };
        let one = |ops: &[Value]| {
            assert_eq!(ops.len(), 1, "{ops:?}");
            ops[0]["entity"].clone()
        };
        let sel = json!({"wallIds":[],"openingIds":["d"]});
        // Getippt „@0.5,0": 0.5 m entlang der Wand.
        let o = one(&run(json!([[0, 0], [0.5, 0]]), "move", sel.clone()));
        assert_eq!((&o["id"], &o["position"], &o["hostWallId"]), (&json!("d"), &json!(1.5), &json!("w")));
        // Schräg: nur der Anteil längs der Wand zählt (quer bleibt in der Wanddicke).
        assert_eq!(one(&run(json!([[0, 0], [-0.5, 0.08]]), "move", sel.clone()))["position"], json!(0.5));
        // Geklemmt an Wandanfang/-ende.
        assert_eq!(one(&run(json!([[0, 0], [-9, 0]]), "move", sel.clone()))["position"], json!(0));
        assert_eq!(one(&run(json!([[0, 0], [9, 0]]), "move", sel.clone()))["position"], json!(4.1));
        // Ziel in der Querwand v (Mitte 1.45 → (5, 2)): Wirt wechselt, position = 2 − 0.45.
        let o = one(&run(json!([[1.45, 0], [5, 2]]), "move", sel.clone()));
        assert_eq!((&o["hostWallId"], &o["position"]), (&json!("v"), &json!(1.55)));
        // Wand im anderen Geschoss zählt nicht: ausserhalb jeder Wand → nur Gleiten (projiziert).
        assert_eq!(one(&run(json!([[1.45, 0], [2.45, 3]]), "move", sel.clone()))["hostWallId"], json!("w"));
        // Gesperrte Öffnung bleibt.
        assert!(run(json!([[0, 0], [1, 0]]), "move", json!({"wallIds":[],"openingIds":["z"]})).is_empty());
        // Bogenwand ([T2]): Ziel = Lotfuss auf dem Bogen, `position` = Bogenlänge; geklemmt an den Bogenenden.
        let arc = crate::opening_slide::Axis::of(&r["walls"][3]).unwrap();
        let (c, tg) = (arc.point(1.5, 0.0), arc.tangent(1.5));
        let mv = |k: f64| json!([[c.0, c.1], [c.0 + tg.0 * k, c.1 + tg.1 * k]]);
        let pos = one(&run(mv(0.3), "move", json!({"wallIds":[],"openingIds":["a"]})))["position"].as_f64().unwrap();
        assert!((pos - 1.3).abs() < 0.01, "{pos}");
        let o = one(&run(mv(20.0), "move", json!({"wallIds":[],"openingIds":["a"]})));
        assert!((o["position"].as_f64().unwrap() - (arc.len() - 1.0)).abs() < 1e-9 && o["hostWallId"] == "b");
        assert_eq!(one(&run(mv(-20.0), "move", json!({"wallIds":[],"openingIds":["a"]})))["position"], json!(0));
        // Drehen einer Öffnung allein: nichts.
        let req: TransformReq = serde_json::from_value(json!({"sel":sel,"op":"rotate","pts":[[0,0],[1,0],[0,1]],"mode":"move","count":1,"stamp":"s"})).unwrap();
        assert!(transform_ops(&r, &Project::default(), &req).is_empty());
        // Reihe ×2 um 1.2: zwei neue Türen in derselben Wand bei 2.2 und 3.4.
        let ops = run(json!([[0, 0], [1.2, 0]]), "array", sel.clone());
        let items = ops.iter().find(|o| o["kind"] == "add" && o["collection"] == "openings").unwrap()["items"].as_array().unwrap().clone();
        let pos: Vec<f64> = items.iter().map(|o| o["position"].as_f64().unwrap()).collect();
        assert!((pos[0] - 2.2).abs() < 1e-9 && (pos[1] - 3.4).abs() < 1e-9, "{pos:?}");
        assert!(items.iter().all(|o| o["hostWallId"] == "w" && o["id"] != "d"));
        // Mit der Wand gewählt: die Wand geht, die Öffnung bleibt bei position 1 (starr mit).
        let ops = run(json!([[0, 0], [0.5, 0]]), "move", json!({"wallIds":["w"],"openingIds":["d"]}));
        assert!(ops.iter().all(|o| o["collection"] != "openings"), "{ops:?}");
        // Vorschau: eine Lücke je Öffnung.
        let req: TransformReq = serde_json::from_value(json!({"sel":sel,"op":"move","pts":[[0,0],[0.5,0]],"mode":"move","count":1,"stamp":"s"})).unwrap();
        assert!(!preview_pending(&r, &Project::default(), &req).shapes.buf.is_empty());
    }

    /// [144] Überlappung: gleitend hält die Öffnung 5 cm vor der Nachbaröffnung an (mit Hinweis), Kopie
    /// rückt an die nächste freie Stelle; Bestand bleibt; mitbewegte Öffnungen zählen nicht.
    #[test]
    fn oeffnung_haelt_vor_der_nachbaroeffnung() {
        let r = root(json!({
            "walls":[{"id":"w","floorId":"eg","start":{"x":0,"y":0},"end":{"x":10,"y":0}}],
            "openings":[
                {"id":"d","hostWallId":"w","kind":"door","position":1,"width":1},
                {"id":"f","hostWallId":"w","kind":"window","position":4,"width":1}
            ]}));
        let run = |pts: Value, mode: &str, ids: Value| {
            let req: TransformReq = serde_json::from_value(json!({"sel":{"wallIds":[],"openingIds":ids},"op":"move","pts":pts,"mode":mode,"count":1,"stamp":"s"})).unwrap();
            transform_result(&r, &Project::default(), &req)
        };
        let res = run(json!([[0, 0], [5, 0]]), "move", json!(["d"]));
        assert_eq!(res.notice, Some(crate::opening_slide::NOTICE_OVERLAP));
        assert_eq!(res.ops[0].to_json()["entity"]["position"], json!(2.95));
        // Frei: kein Hinweis.
        let res = run(json!([[0, 0], [1, 0]]), "move", json!(["d"]));
        assert_eq!((res.notice, res.ops[0].to_json()["entity"]["position"].clone()), (None, json!(2)));
        // Beide gewählt: gleiten zusammen, ohne Anschlag aneinander.
        let res = run(json!([[0, 0], [2.5, 0]]), "move", json!(["d", "f"]));
        assert_eq!(res.notice, None);
        let pos: Vec<Value> = res.ops.iter().map(|o| o.to_json()["entity"]["position"].clone()).collect();
        assert_eq!(pos, vec![json!(3.5), json!(6.5)]);
        // Kopie um 0.5 überlappte das Original: rückt an die nächste freie Stelle (2.05).
        let res = run(json!([[0, 0], [0.5, 0]]), "copy", json!(["d"]));
        let items = res.ops[0].to_json()["items"].clone();
        assert_eq!(items[0]["position"], json!(2.05));
        assert_eq!(res.notice, Some(crate::opening_slide::NOTICE_OVERLAP));
    }

    /// [144] Bemassungs-Bezüge auf eine gleitende Öffnung (Leibung, gerade und Bogenwand) folgen über das
    /// Nachführen im Dokument — beim Verschieben-Befehl, beim Griff-Zug und bei der Objekt-Info-Position.
    #[test]
    fn bemassung_folgt_der_gleitenden_oeffnung() {
        use crate::document::Document;
        let r = json!({
            "walls":[{"id":"w","floorId":"eg","start":{"x":0,"y":0},"end":{"x":10,"y":0}},
                     {"id":"b","floorId":"eg","start":{"x":0,"y":5},"end":{"x":4,"y":5},"bulge":1}],
            "openings":[{"id":"d","hostWallId":"w","kind":"door","position":1,"width":1},
                        {"id":"a","hostWallId":"b","kind":"window","position":1,"width":1}],
            "drawings2d":[
                {"id":"m","levelId":"eg","geom":{"shape":"dimension","pts":[{"x":0,"y":-1},{"x":1,"y":-1},{"x":2,"y":-1}],"offset":0,
                 "refs":[{"id":"w","feature":"wall","t":0,"d":1},{"id":"d","feature":"opening","index":0,"d":1},{"id":"d","feature":"opening","index":1,"d":1}]}},
                {"id":"k","levelId":"eg","geom":{"shape":"dimension","pts":[{"x":0,"y":5},{"x":1,"y":6}],"offset":0,
                 "refs":[{"id":"a","feature":"opening","index":0},{"id":"a","feature":"opening","index":1}]}}
            ]});
        let mut doc = Document::from_json(&r.to_string()).unwrap();
        let pts = |doc: &Document, id: &str| -> Vec<(f64, f64)> {
            let d = doc.root()["drawings2d"].as_array().unwrap().iter().find(|d| d["id"] == id).unwrap().clone();
            d["geom"]["pts"].as_array().unwrap().iter().map(|p| (p["x"].as_f64().unwrap(), p["y"].as_f64().unwrap())).collect()
        };
        let close = |a: (f64, f64), b: (f64, f64)| assert!((a.0 - b.0).abs() < 1e-9 && (a.1 - b.1).abs() < 1e-9, "{a:?} != {b:?}");
        // Bogen-Leibungen: erst einmal nachführen (Bogenpunkte statt Sehne).
        let arc = crate::opening_slide::Axis::of(&r["walls"][1]).unwrap();
        doc.commit(crate::dim_assoc::sync_ops(&doc.lookup()), None, 0.0, false).unwrap();
        close(pts(&doc, "k")[0], arc.point(1.0, 0.0));
        close(pts(&doc, "k")[1], arc.point(2.0, 0.0));
        // Verschieben-Befehl: Tür um 2 m → Kette folgt (Wandende bleibt).
        let req = json!({"cmd":"transform","sel":{"wallIds":[],"drawingId":null,"openingIds":["d"]},"op":"move","pts":[[0,0],[2,0]],"mode":"move","count":1,"stamp":"s"});
        let res = { let (p, lk) = doc.project_lookup().unwrap(); crate::commands::result(lk.root, p, &req.to_string()).unwrap() };
        doc.commit(res.ops, None, 1.0, false).unwrap();
        let q = pts(&doc, "m");
        close(q[0], (0.0, -1.0));
        close(q[1], (3.0, -1.0));
        close(q[2], (4.0, -1.0));
        // Griff-Zug und Objekt-Info-Position (grips.rs): gleicher Weg.
        let grip = |doc: &mut Document, req: Value| {
            let req: crate::grips::Request = serde_json::from_value(req).unwrap();
            let res = crate::grips::run(&doc.lookup(), &req).unwrap();
            doc.commit(res.ops, None, 2.0, false).unwrap();
        };
        grip(&mut doc, json!({"op":"openingSlide","id":"d","pt":[6.5,0.3]}));
        close(pts(&doc, "m")[1], (6.0, -1.0));
        grip(&mut doc, json!({"op":"openingPosition","id":"d","a":5}));
        close(pts(&doc, "m")[2], (6.0, -1.0));
        // Bogenwand: Fenster entlang des Bogens → Leibungen auf dem Bogen.
        grip(&mut doc, json!({"op":"openingPosition","id":"a","a":2.5}));
        close(pts(&doc, "k")[0], arc.point(2.5, 0.0));
        close(pts(&doc, "k")[1], arc.point(3.5, 0.0));
        // Rückgängig: Kette wieder bei der alten Lage.
        doc.undo();
        close(pts(&doc, "k")[0], arc.point(1.0, 0.0));
    }

    /// [144] Dach-/Deckenöffnung allein verschieben: `hostPoint` wandert, im Umriss des Wirts gehalten.
    #[test]
    fn dachoeffnung_allein_verschieben() {
        let r = root(json!({
            "roofs":[{"id":"rf","outline":[{"x":0,"y":0},{"x":6,"y":0},{"x":6,"y":4},{"x":0,"y":4}]}],
            "openings":[{"id":"o","hostWallId":"","hostRoofId":"rf","hostPoint":{"x":1,"y":1},"width":0.8,"height":1.2}]}));
        let run = |pts: Value, mode: &str| {
            let req: TransformReq = serde_json::from_value(json!({"sel":{"wallIds":[],"openingIds":["o"]},"op":"move","pts":pts,"mode":mode,"count":1,"stamp":"s"})).unwrap();
            transform_ops(&r, &Project::default(), &req).iter().map(|o| o.to_json()).collect::<Vec<_>>()
        };
        let ops = run(json!([[0, 0], [2, 1]]), "move");
        assert_eq!(ops[0]["entity"]["hostPoint"], json!({"x":3,"y":2}));
        // Ausserhalb: an den Rand, 5 cm nach innen.
        let hp = run(json!([[0, 0], [20, 0]]), "move")[0]["entity"]["hostPoint"].clone();
        assert!((hp["x"].as_f64().unwrap() - 5.95).abs() < 0.02 && (hp["y"].as_f64().unwrap() - 1.0).abs() < 0.05, "{hp}");
        // Kopie: neue Öffnung im selben Dach.
        let ops = run(json!([[0, 0], [2, 0]]), "copy");
        assert_eq!((&ops[0]["items"][0]["hostRoofId"], &ops[0]["items"][0]["hostPoint"]), (&json!("rf"), &json!({"x":3,"y":1})));
        // Vorschau zeigt sie.
        let req: TransformReq = serde_json::from_value(json!({"sel":{"wallIds":[],"openingIds":["o"]},"op":"move","pts":[[0,0],[1,0]],"mode":"move","count":1,"stamp":"s"})).unwrap();
        assert!(!preview_pending(&r, &Project::default(), &req).shapes.buf.is_empty());
    }

    #[test]
    fn verschieben_und_kopieren() {
        let r = root(json!({"walls":[{"id":"a","start":{"x":0,"y":0},"end":{"x":1,"y":0},"locked":false},{"id":"b","start":{"x":0,"y":0},"end":{"x":1,"y":0},"locked":true}]}));
        let req: TransformReq = serde_json::from_value(json!({"sel":{"wallIds":["a","b"]},"op":"move","pts":[[0,0],[2,3]],"mode":"move","count":1,"stamp":"s"})).unwrap();
        let ops = transform_ops(&r, &Project::default(), &req);
        assert_eq!(ops.len(), 1);
        assert_eq!(ops[0].to_json()["entity"]["start"], json!({"x":2,"y":3}));
        let req: TransformReq = serde_json::from_value(json!({"sel":{"wallIds":["a"]},"op":"move","pts":[[0,0],[1,0]],"mode":"array","count":3,"stamp":"s"})).unwrap();
        let ops = transform_ops(&r, &Project::default(), &req);
        let items = &ops[0].to_json()["items"];
        assert_eq!(items.as_array().unwrap().len(), 3);
        assert_eq!(items[2]["id"], "W-s-3");
        assert_eq!(items[2]["end"], json!({"x":4,"y":0}));
    }

    #[test]
    fn spiegeln_kehrt_bogen_und_rechteck() {
        let g = json!({"shape":"polyline","pts":[{"x":0,"y":0},{"x":1,"y":0}],"bulge":[0.5]});
        let xf = Xf::of("mirror", &[(0.0, 0.0), (1.0, 0.0)], 1.0);
        assert_eq!(mv_geom(&g, &xf).unwrap()["bulge"], json!([-0.5]));
        let rect = json!({"shape":"rect","min":{"x":0,"y":0},"max":{"x":2,"y":1},"extra":1});
        let rot = Xf::of("rotate", &[(0.0, 0.0), (1.0, 0.0), (1.0, 1.0)], 1.0);
        assert_eq!(mv_geom(&rect, &rot).unwrap()["shape"], "polyline");
        assert_eq!(mv_geom(&rect, &Xf::translate(1.0, 1.0)).unwrap(), json!({"shape":"rect","min":{"x":1,"y":1},"max":{"x":3,"y":2}}));
        assert!(mv_geom(&json!({"shape":"?"}), &xf).is_none());
    }

    /// [77] Inseln einer Polylinie wandern mit (Verschieben, Skalieren).
    #[test]
    fn inseln_wandern_mit() {
        let g = json!({"shape":"polyline","closed":true,"pts":[{"x":0,"y":0},{"x":4,"y":0},{"x":4,"y":4}],"holes":[[{"x":1,"y":1},{"x":2,"y":1},{"x":2,"y":2}]]});
        let m = mv_geom(&g, &Xf::translate(1.0, 0.0)).unwrap();
        assert_eq!(m["holes"], json!([[{"x":2,"y":1},{"x":3,"y":1},{"x":3,"y":2}]]));
        let s = scale_geom(&g, &Xf::of("scale", &[(0.0, 0.0), (1.0, 0.0), (2.0, 0.0)], 1.0), 2.0).unwrap();
        assert_eq!(s["holes"][0][2], json!({"x":4,"y":4}), "{s}");
    }

    #[test]
    fn skalieren_zieht_groessen_nach() {
        let g = json!({"shape":"circle","center":{"x":1,"y":0},"r":1});
        let pts = [(0.0, 0.0), (1.0, 0.0), (2.0, 0.0)];
        let xf = Xf::of("scale", &pts, 1.0);
        assert_eq!(scale_geom(&g, &xf, scale_factor(&pts, 1.0)).unwrap(), json!({"shape":"circle","center":{"x":2,"y":0},"r":2}));
    }

    #[test]
    fn ausrichten_links() {
        let d = |id: &str, x: f64| json!({"id":id,"geom":{"shape":"line","a":{"x":x,"y":0},"b":{"x":x+1.0,"y":1}}});
        let r = root(json!({"drawings2d":[d("a", 0.0), d("b", 5.0)]}));
        let ops = align_ops(&r, &["a".into(), "b".into()], "left");
        assert_eq!(ops.len(), 1);
        assert_eq!(ops[0].to_json()["entity"]["geom"]["a"], json!({"x":0,"y":0}));
    }
}
