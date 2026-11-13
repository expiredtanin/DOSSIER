//! [207] Situationsplan / Schwarzplan (Wettbewerb, 1:500): eine Modelldarstellung mit `situation` ersetzt im
//! Grundriss die Bauteile durch Flächen.
//!
//! - **Eigenes Gebäude** (Klasse „83 Situation Gebäude", [`OWN_CATEGORY`]): Umriss über alle Geschosse ab dem
//!   Erdgeschoss (Wände, Decken, freie Körper) und die Dächer (mit Überstand, Dachaufsicht), vereinigt und
//!   gefüllt (Standard schwarz).
//! - **Kontextgebäude** (importierte Netze, [181]; Klasse des Netzes, z. B. „12 Gebäude"): Grundfläche aus der
//!   Aufsicht (Vereinigung der Dreiecke), gefüllt (Standard grau, „Schwarzplan": schwarz).
//! - **Planzeichen** (Klasse „84 Planzeichen", [`SYMBOL_CATEGORY`]): Nordpfeil und Massstabsbalken unter der
//!   Lage, Grösse in Papier-mm.
//!
//! Wände, Treppen, Räume, Stützen, Körper, Bodenbeläge und Schnittmarken entfallen (`domains.rs`); Parzelle,
//! Strassen, Höhenlinien und Beschriftungen sind gewöhnliche Zeichnungen/Kontext auf ihren Klassen und
//! bleiben, solange die Klasse sichtbar ist (Ansichtsvorlage „Situation WBW", `standards.rs`).
//! - **Kataster-Zeichnungen** (2D, aus dem DXF-Import): geschlossene Polylinien/Rechtecke der Klasse „Gebäude"
//!   werden wie Kontextgebäude gefüllt, die der Klasse „Gewässer" hellblau. Liegt ein Ring ganz in einem anderen
//!   derselben Klasse, ist er ein Loch (Innenhof; gerade/ungerade, `polygon_bool::nest_even_odd`).
//! Löcher (Innenhöfe) der Umrisse sind echte Löcher: ein Ring mit Brücken (`polygon_holes`, Brückenkanten ohne
//! Strich), Füllung und Strich bleiben korrekt, nichts liegt weiss darüber.

use super::domains::{Bounds, Ctx};
use super::drawings::mm_to_model;
use super::prim::Primitive;
use super::style::no_hatch;
use crate::flat::{Polygon, Ring};
use crate::model::*;

/// Klasse des eigenen Gebäudes im Situationsplan.
pub const OWN_CATEGORY: &str = crate::standards::SITUATION_CATEGORY;
/// Klasse von Nordpfeil und Massstabsbalken.
pub const SYMBOL_CATEGORY: &str = crate::standards::SYMBOL_CATEGORY;

const BLACK: (&str, &str) = ("#000000", "#000000");
const GREY: (&str, &str) = ("#b8b8b8", "#7c7c7c");
/// Gewässer aus dem Kataster: hellblau gefüllt.
const WATER: (&str, &str) = ("#cfe3f1", "#7fa8c7");
const OUTLINE_MM: f64 = 0.1;
/// Eine Dreiecksfläche unter 1 cm² trägt nichts zur Aufsicht bei (senkrechte Wände, Splitter).
const MIN_TRI_AREA: f64 = 1e-4;

/// Aufgelöste Optionen des Situationsplans.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Opts {
    pub own: SituationFill,
    pub context: SituationFill,
    pub symbols: bool,
}

impl Opts {
    pub fn of(s: &ModelViewSituation) -> Opts {
        let fill = |f: Option<SituationFill>, d: SituationFill| match f {
            Some(SituationFill::Unknown) | None => d,
            Some(f) => f,
        };
        Opts { own: fill(s.own, SituationFill::Black), context: fill(s.context, SituationFill::Grey), symbols: s.symbols.unwrap_or(true) }
    }
}

fn colors(f: SituationFill) -> Option<(&'static str, &'static str)> {
    match f {
        SituationFill::Black => Some(BLACK),
        SituationFill::Grey => Some(GREY),
        _ => None,
    }
}

fn v2(q: [f64; 2]) -> Vec2 {
    Vec2 { x: q[0], y: q[1] }
}

fn polygon(pts: Vec<Vec2>, fill: &str, stroke: &str, w: f64, context_id: Option<&str>, greyed: bool) -> Primitive {
    Primitive::Polygon {
        pts,
        fill: fill.into(),
        stroke: stroke.into(),
        stroke_width_mm: w,
        hatch: Box::new(no_hatch()),
        greyed: greyed.then_some(true),
        opacity: None,
        no_stroke_edges: None,
        wall_id: None,
        drawing_id: None,
        ceiling_id: None,
        opening_id: None,
        stair_id: None,
        room_id: None,
        extruded_solid_id: None,
        context_object_id: context_id.map(String::from),
        column_id: None,
        roof_id: None,
        section_line_id: None,
    }
}

fn line(a: Vec2, b: Vec2, w: f64) -> Primitive {
    Primitive::Line { a, b, cls: "situation-symbol".into(), weight_mm: w, dash: None, zigzag: None, motif: None, color: Some("#000000".into()), drawing_id: None, opening_id: None, stair_id: None, greyed: None, opacity: None }
}

fn text(at: Vec2, s: &str, h: f64) -> Primitive {
    Primitive::DrawingText { at, text: s.into(), height_m: h, angle: 0.0, color: "#000000".into(), marks: None, wrap_width: None, doc: None, drawing_id: None, greyed: None, opacity: None }
}

/// Die Situation dieser Plan-Erzeugung (`None` = gewöhnlicher Grundriss).
pub fn opts(c: &Ctx) -> Option<Opts> {
    c.situation().map(Opts::of)
}

/// Ist für diese Plan-Argumente der Situationsplan gewählt (ohne [`Ctx`], für die Zutaten)?
pub fn active(p: &Project, a: &super::domains::PlanArgs) -> bool {
    super::model_view::selected_id(p, &a.floor, a.model_view.as_deref()).and_then(|id| super::model_view::find(p, id)).is_some_and(|m| m.situation.is_some())
}

/// Bodenhöhe des Erdgeschosses (Geschoss nächst ±0.00); `None` ohne Geschosse.
fn ground_base(p: &Project) -> Option<f64> {
    super::extras::ground_floor_id(p).and_then(|id| p.floor(id)).map(|l| l.base_elevation.unwrap_or(0.0))
}

/// Eigenes Gebäude über dem Terrain: Wände, Decken und freie Körper der Geschosse ab dem Erdgeschoss
/// (Untergeschosse zählen nicht) und alle Dächer samt Überstand, vereinigt (Aussenringe mit Löchern).
pub fn own_polygons(p: &Project) -> Vec<Polygon> {
    let base = ground_base(p);
    let above = |floor: &str| match (base, p.floor(floor)) {
        (Some(g), Some(l)) => l.base_elevation.unwrap_or(0.0) >= g - 0.05,
        _ => true,
    };
    let ok = |q: &[f64; 2]| q[0].is_finite() && q[1].is_finite();
    let mut parts: Vec<Polygon> = Vec::new();
    for w in p.walls.iter().filter(|w| above(&w.floor_id)) {
        if let Some(f) = crate::site_rules::wall_footprint(p, w).filter(|f| f.len() >= 3 && f.iter().all(ok)) {
            parts.push(vec![f]);
        }
    }
    for c in p.ceilings.as_deref().unwrap_or(&[]).iter().filter(|c| above(&c.floor_id)) {
        let r = c.ring_xy();
        if r.len() >= 3 && r.iter().all(ok) {
            parts.push(vec![r]);
        }
    }
    for s in p.extruded_solids.as_deref().unwrap_or(&[]).iter().filter(|s| above(&s.level_id) && s.operation.as_deref() != Some("subtract")) {
        let r: Ring = s.points.iter().map(|q| [q.x, q.y]).collect();
        if r.len() >= 3 && r.iter().all(ok) {
            parts.push(vec![r]);
        }
    }
    for r in p.roofs.as_deref().unwrap_or(&[]) {
        let g = crate::roof::roof_geometry(&r.params(), p.roof_base_elevation(r));
        if g.eaves.len() >= 3 && g.eaves.iter().all(ok) {
            let mut poly = vec![g.eaves.clone()];
            poly.extend(g.eaves_holes.iter().filter(|h| h.len() >= 3 && h.iter().all(ok)).cloned());
            parts.push(poly);
        }
    }
    if parts.is_empty() {
        return Vec::new();
    }
    crate::polygon_bool::union(&parts)
}

/// Aussenringe des eigenen Gebäudes (Höhenlinien enden an ihnen).
pub fn own_rings(p: &Project) -> Vec<Vec<Vec2>> {
    own_polygons(p).iter().filter_map(|poly| poly.first().filter(|r| r.len() >= 3)).map(|r| r.iter().map(|q| v2(*q)).collect()).collect()
}

/// Grundfläche eines Netzes aus der Aufsicht: Vereinigung der Dreiecke in der Projektion (senkrechte Flächen
/// fallen weg). Ein Netz ohne Fläche ⇒ leer.
pub fn mesh_polygons(positions: &[f64], indices: &[f64]) -> Vec<Polygon> {
    let n = positions.len() / 3;
    let mut tris: Vec<Polygon> = Vec::new();
    for t in indices.chunks_exact(3) {
        if t.iter().any(|i| !(*i >= 0.0) || i.fract() != 0.0 || *i as usize >= n) {
            continue;
        }
        let q = |i: f64| [positions[i as usize * 3], positions[i as usize * 3 + 1]];
        let (a, b, c) = (q(t[0]), q(t[1]), q(t[2]));
        if ![a, b, c].iter().all(|p| p[0].is_finite() && p[1].is_finite()) {
            continue;
        }
        let area = ((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2.0;
        if area.abs() < MIN_TRI_AREA {
            continue;
        }
        // Gegen den Uhrzeigersinn (die Vereinigung verlangt einheitlichen Umlaufsinn).
        tris.push(vec![if area > 0.0 { vec![a, b, c] } else { vec![a, c, b] }]);
    }
    if tris.is_empty() {
        return Vec::new();
    }
    crate::polygon_bool::union(&tris)
}

/// Gefüllte Flächen: ein Polygon je Fläche; Löcher sind über Brücken eingebunden (Brückenkanten ohne Strich).
fn fill_polygons(polys: &[Polygon], f: (&str, &str), context_id: Option<&str>, greyed: bool, out: &mut Vec<Primitive>) {
    for poly in polys {
        let Some(outer) = poly.first().filter(|r| r.len() >= 3) else { continue };
        let holes: Vec<Ring> = poly.iter().skip(1).filter(|r| r.len() >= 3).cloned().collect();
        if holes.is_empty() {
            out.push(polygon(outer.iter().map(|q| v2(*q)).collect(), f.0, f.1, OUTLINE_MM, context_id, greyed));
            continue;
        }
        let merged = crate::polygon_holes::merge_holes(outer, &holes, 1e-4);
        let mut prim = polygon(merged.ring.iter().map(|q| v2(*q)).collect(), f.0, f.1, OUTLINE_MM, context_id, greyed);
        if let Primitive::Polygon { no_stroke_edges, .. } = &mut prim {
            *no_stroke_edges = (!merged.bridge_edges.is_empty()).then(|| merged.bridge_edges.iter().map(|&k| k as f64).collect());
        }
        out.push(prim);
    }
}

/// Klasse „Gebäude" des Katasters: Code „12" oder ein Name mit „Gebäude"/„Building" (ohne die abgeleitete Klasse
/// „83 Situation Gebäude").
fn is_building_class(c: &Ctx, code: &str) -> bool {
    code != OWN_CATEGORY && (code == "12" || name_has(c, code, &["gebäude", "gebaeude", "building"]))
}

/// Klasse „Gewässer": Code „17" oder ein Name mit „Gewässer"/„Water".
fn is_water_class(c: &Ctx, code: &str) -> bool {
    code == "17" || name_has(c, code, &["gewässer", "gewaesser", "water"])
}

fn name_has(c: &Ctx, code: &str, words: &[&str]) -> bool {
    c.cat(code).is_some_and(|k| {
        let n = k.name.to_lowercase();
        words.iter().any(|w| n.contains(w))
    })
}

/// Kataster-Flächen aus 2D-Zeichnungen: Gebäude (Kontextfüllung, grau bzw. schwarz) und Gewässer (hellblau), auf
/// der Klasse der Zeichnung (die Klasse bestimmt über [`super::drawings::closed_rings_by_class`], ob sie erscheinen).
/// Innenhöfe sind Löcher. Unterhalb der Zeichnungen; deren Linien bleiben darüber.
pub fn cadastre_prims(c: &Ctx, s: &Opts, out: &mut Vec<Primitive>) {
    let fills = |kind: fn(&Ctx, &str) -> bool| super::drawings::closed_rings_by_class(c, |code| kind(c, code));
    if let Some(f) = colors(s.context) {
        for (code, rings) in fills(is_building_class) {
            fill_polygons(&crate::polygon_bool::nest_even_odd(&rings), f, None, c.greyed(&code), out);
        }
    }
    for (code, rings) in fills(is_water_class) {
        fill_polygons(&crate::polygon_bool::nest_even_odd(&rings), WATER, None, c.greyed(&code), out);
    }
}

fn acc_polys(polys: &[Polygon], bounds: &mut Bounds) {
    for q in polys.iter().filter_map(|p| p.first()).flatten() {
        bounds.acc(q[0], q[1]);
    }
}

/// Eigenes Gebäude als gefüllter Umriss (Gruppe „Dächer", unterhalb der Zeichnungen); Klasse „83".
pub fn own_prims(c: &Ctx, s: &Opts, out: &mut Vec<Primitive>, bounds: &mut Bounds) {
    let Some(f) = colors(s.own) else { return };
    if !c.derived_shown(OWN_CATEGORY) {
        return;
    }
    let polys = own_polygons(c.p);
    acc_polys(&polys, bounds);
    fill_polygons(&polys, f, None, c.greyed(OWN_CATEGORY), out);
}

/// Aussenringe der Kontextgebäude, die diese Ansicht zeigt (Höhenlinien enden an ihnen).
pub fn context_rings(c: &Ctx, s: &Opts) -> Vec<Vec<Vec2>> {
    let mut out = Vec::new();
    if colors(s.context).is_none() {
        return out;
    }
    for m in imported_meshes(c) {
        for poly in mesh_polygons(&m.positions, &m.indices) {
            if let Some(o) = poly.first().filter(|r| r.len() >= 3) {
                out.push(o.iter().map(|q| v2(*q)).collect());
            }
        }
    }
    out
}

/// Die importierten Netze, deren Klasse sichtbar ist.
fn imported_meshes<'a>(c: &'a Ctx) -> impl Iterator<Item = &'a ImportedMesh> {
    c.p.context.as_deref().unwrap_or(&[]).iter().filter_map(move |o| match o {
        ContextObject::ImportedMesh(m) if c.shown(&m.category_code) => Some(m),
        _ => None,
    })
}

/// Ein Kontextgebäude als gefüllte Grundfläche (auf der Klasse des Netzes; Pick-Id = das Netz).
pub fn context_mesh(c: &Ctx, s: &Opts, m: &ImportedMesh, out: &mut Vec<Primitive>) {
    let Some(f) = colors(s.context) else { return };
    let polys = mesh_polygons(&m.positions, &m.indices);
    fill_polygons(&polys, f, Some(&m.id), c.greyed(&m.category_code), out);
}

/// Nordpfeil und Massstabsbalken unter der Lage (Klasse „84"), rechtsbündig zum Ausmass von Gebäude, Parzelle
/// und Kontext. Ohne Gebäude kein Anhaltspunkt ⇒ keine Zeichen.
pub fn symbol_prims(c: &Ctx, s: &Opts, out: &mut Vec<Primitive>, bounds: &mut Bounds) {
    if !s.symbols || !c.derived_shown(SYMBOL_CATEGORY) {
        return;
    }
    let mut bb = Bounds::new();
    acc_polys(&own_polygons(c.p), &mut bb);
    for m in imported_meshes(c) {
        acc_polys(&mesh_polygons(&m.positions, &m.indices), &mut bb);
    }
    for (_, rings) in super::drawings::closed_rings_by_class(c, |code| is_building_class(c, code)) {
        rings.iter().flatten().for_each(|q| bb.acc(q[0], q[1]));
    }
    if let Some(r) = c.p.site_rules.as_ref().map(|r| &r.parcel) {
        for q in r {
            bb.acc(q.x, q.y);
        }
    }
    let Some([_, min_y, max_x, _]) = bb.get() else { return };
    out.extend(symbols(c.a.scale, max_x, min_y));
    for q in out.iter() {
        match q {
            Primitive::Polygon { pts, .. } => pts.iter().for_each(|p| bounds.acc(p.x, p.y)),
            Primitive::Line { a, b, .. } => {
                bounds.acc(a.x, a.y);
                bounds.acc(b.x, b.y);
            }
            Primitive::DrawingText { at, .. } => bounds.acc(at.x, at.y),
            _ => {}
        }
    }
}

/// Länge des Massstabsbalkens (m): die grösste runde Länge, die auf dem Papier höchstens 50 mm misst.
pub fn scalebar_total(scale: f64) -> f64 {
    const TOTALS: [f64; 10] = [1.0, 2.0, 5.0, 10.0, 20.0, 50.0, 100.0, 200.0, 500.0, 1000.0];
    TOTALS.iter().rev().copied().find(|m| m * 1000.0 / scale <= 50.0).unwrap_or(TOTALS[0])
}

/// Nordpfeil und Massstabsbalken; `right`/`below` = rechter Rand und Oberkante der Lage (Modell-Meter), die
/// Zeichen stehen darunter (Papierabstand 12 mm). Norden = +y.
pub fn symbols(scale: f64, right: f64, below: f64) -> Vec<Primitive> {
    let mm = |v: f64| mm_to_model(v, scale);
    let mut out = Vec::new();
    // Massstabsbalken: vier Felder, abwechselnd gefüllt; Beschriftung 0 / halbe Länge / Länge.
    let total = scalebar_total(scale);
    let len = total;
    let (y1, h) = (below - mm(12.0), mm(1.6));
    let x0 = right - len;
    for i in 0..4 {
        let (a, b) = (x0 + len * i as f64 / 4.0, x0 + len * (i + 1) as f64 / 4.0);
        let fill = if i % 2 == 0 { "#000000" } else { "#ffffff" };
        out.push(polygon(vec![Vec2 { x: a, y: y1 - h }, Vec2 { x: b, y: y1 - h }, Vec2 { x: b, y: y1 }, Vec2 { x: a, y: y1 }], fill, "#000000", 0.18, None, false));
    }
    let th = mm(2.5);
    let label = |v: f64| if v.fract() == 0.0 { format!("{v:.0}") } else { format!("{v}") };
    out.push(text(Vec2 { x: x0 - mm(0.6), y: y1 - h - th * 1.4 }, "0", th));
    out.push(text(Vec2 { x: x0 + len / 2.0 - mm(1.0), y: y1 - h - th * 1.4 }, &label(total / 2.0), th));
    out.push(text(Vec2 { x: right - mm(1.0) * (label(total).len() as f64 + 2.0), y: y1 - h - th * 1.4 }, &format!("{} m", label(total)), th));
    // Nordpfeil links vom Balken: halb gefüllte Spitze, „N" darüber.
    let (cx, cy, r) = (x0 - mm(14.0), y1 - h / 2.0 - mm(3.0), mm(6.0));
    let top = Vec2 { x: cx, y: cy + r };
    let mid = Vec2 { x: cx, y: cy - r * 0.35 };
    out.push(polygon(vec![top, Vec2 { x: cx + r * 0.45, y: cy - r * 0.75 }, mid], "#000000", "#000000", 0.18, None, false));
    out.push(polygon(vec![top, mid, Vec2 { x: cx - r * 0.45, y: cy - r * 0.75 }], "#ffffff", "#000000", 0.18, None, false));
    out.push(line(top, Vec2 { x: cx, y: cy - r }, 0.18));
    out.push(text(Vec2 { x: cx - mm(1.0), y: cy + r + mm(1.2) }, "N", mm(3.5)));
    out
}

#[cfg(test)]
#[path = "situation_tests.rs"]
mod tests;
