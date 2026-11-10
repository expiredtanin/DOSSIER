//! Ansicht auf dem Dokument ([K3c]): Rust-Gegenstück zu `src/plan/toElevation.ts` (Orchestrierung,
//! Stil, Painter-Reihenfolge). Die Geometrie (Flächen, Eck-Verlängerung, Öffnungen, Verdeckung,
//! Schatten, XOR-Umriss) rechnet `elevation_geom.rs`; hier werden sie aus dem Dokument gespeist,
//! gestylt, mit Pick-Ids versehen und fern → nah sortiert. Zahlsemantik wie in TS.
//!
//! [165] Aus einer Datei aufgeteilt (Reihenfolge = Rechenweg): `face` (Flächen, Stil-Übersteuerung),
//! `cull` (Dach verdeckt Wände), `collect` (Flächen aus dem Modell), `mesh_cull` (importierte Netze),
//! `openings` (Fenster/Türen), `silhouette` (Umrisse, Kanten, Gelände), `patterns` (Oberflächenmuster).
//! Hier bleiben die gemeinsamen Konstanten, die Orchestrierung (`elevation_primitives_with()`) und die
//! Abfrage `elevation_plan_buf()`.

use super::prim::Primitive;
use super::section::{line, polygon, v2, Acc, LevelSpec, Visibility};
use super::style::no_hatch;
use crate::jsmath::{hypot, hypot2};
use crate::jsnum::{max, min, round};
use crate::model::*;
use crate::model3d::{self, RSlab, RWall};
use crate::plan::overrides::{js_trim, RuleView, Subject};
use std::collections::{HashMap, HashSet};
use std::rc::Rc;

mod face;
mod cull;
mod collect;
mod mesh_cull;
mod openings;
mod silhouette;
mod patterns;

use face::*;
use cull::*;
use collect::*;
use mesh_cull::*;
use openings::*;
use silhouette::*;
use patterns::*;
pub(crate) use cull::fascia_quads;

const EDGE_INK: &str = "#2b3039";
const EDGE_MM: f64 = 0.13;
/// [140] Silhouette (Umriss aller Bauteile zusammen) mittelstark: hebt den Baukörper von Details (0.13) ab;
/// Terrainlinie 0.25 (grösste Standard-Stärke bei 1:100).
const SILHOUETTE_MM: f64 = 0.18;
/// [140] Abstand (m), bis zu dem eine Kante als Teil der Silhouette gilt.
const SILHOUETTE_TOL: f64 = 2e-3;
const FRAME_MM: f64 = 0.13;
/// [140] Tusche (Schwarz-Weiss, Standard): Glas hellgrau, Schatten neutral grau und hell.
const GLASS_FILL_MONO: &str = "#dcdcdc";
const SHADOW_FILL_MONO: &str = "#c4c4c4";
const OPENING_SHADOW_FILL_MONO: &str = "#d2d2d2";
/// [140] Glas hellgrau statt blau (Farbe nur, wo der Nutzer sie setzt).
const GLASS_FILL_COLOR: &str = "#d3d8dd";
const SHADOW_FILL: &str = "#8f959e";
/// [157] Teil 4: Schattenkanten-Absätze unter so viel Papier-mm entfallen.
const SHADOW_SMOOTH_MM: f64 = 0.2;
const OPENING_SHADOW_FILL: &str = "#a7adb5";
const GROUND_INK: &str = "#1f242c";
const GROUND_MM: f64 = 0.25;
const FRAME_FILL_COLOR: &str = "#dcdcdc";
const SILL_FILL_COLOR: &str = "#cccccb";
const DOOR_LEAF_FILL_COLOR: &str = "#ececec";
const SYMBOL_INK: &str = "#7d858f";
const ROOF_RGB_FALLBACK: [f64; 3] = [0.72, 0.45, 0.36];
/// [152] Kontext-Grau importierter Netze ohne eigene Farbe (wie `model3d::IMPORTED_RGB`).
const IMPORTED_RGB: [f64; 3] = [159.0 / 255.0, 166.0 / 255.0, 174.0 / 255.0];
const EPS: f64 = 1e-6;
const HIDDEN_INK: &str = "#8a929c";
const HIDDEN_MM: f64 = 0.13;
const HIDDEN_DASH: [f64; 2] = super::line_pattern::HIDDEN;

type Pt = [f64; 2];

/// `hexToRgb` der Ansicht (mit JS-`trim`).
fn hex_to_rgb(hex: &str, fallback: [f64; 3]) -> [f64; 3] {
    let t = js_trim(hex);
    let h = t.strip_prefix('#').unwrap_or(t);
    if h.len() != 6 || !h.bytes().all(|b| b.is_ascii_hexdigit()) {
        return fallback;
    }
    let p = |i: usize| u32::from_str_radix(&h[i..i + 2], 16).unwrap_or(0) as f64 / 255.0;
    [p(0), p(2), p(4)]
}

/// `rgbToHex`.
fn rgb_to_hex(c: [f64; 3]) -> String {
    let b = |v: f64| -> String {
        let x = max(0.0, min(255.0, round(v * 255.0)));
        if x.is_nan() {
            return "NaN".into();
        }
        format!("{:02x}", x as u32)
    };
    format!("#{}{}{}", b(c[0]), b(c[1]), b(c[2]))
}


/// Flächen für `elevation_geom::shadows`: Kopf Mittel-, Mindesttiefe und [157] die kleinste Tiefe am linken und
/// am rechten Ende (u) — für Werfer (Stirn) wie Empfänger (Bogenwand-Facetten). Ohne Tiefe je Ecke gilt an beiden
/// Enden die Mindest- (`receiver` = false) bzw. die Mitteltiefe.
fn encode_shadow_polys(faces: &[&Face], receiver: bool) -> Vec<f64> {
    let mut b = vec![faces.len() as f64];
    for f in faces {
        let (u0, u1) = f.pts.iter().fold((f64::INFINITY, f64::NEG_INFINITY), |(a, z), q| (a.min(q[0]), z.max(q[0])));
        let tol = 1e-6 * (1.0 + (u1 - u0).abs());
        let at = |u: f64| f.pts.iter().zip(&f.pd).filter(|(q, _)| (q[0] - u).abs() <= tol).map(|(_, d)| *d).fold(f64::INFINITY, f64::min);
        let flat = if receiver { f.depth } else { f.depth_min };
        let (dl, dr) = if f.pd.len() == f.pts.len() { (at(u0), at(u1)) } else { (flat, flat) };
        // Schatten mit der wahren Tiefe der Decken (ohne den Vorrang der Wand, s. `SLAB_BEHIND_WALL`).
        let k = if f.curved_slab { SLAB_BEHIND_WALL } else { 0.0 };
        b.extend([f.depth - k, f.depth_min - k, dl - k, dr - k, f.pts.len() as f64]);
        for q in &f.pts {
            b.extend(q);
        }
    }
    b
}

/// Eintrag des Painter-Stroms.
struct Item {
    depth: f64,
    seq: usize,
    rank: Option<f64>,
    prim: Primitive,
}

enum Pending {
    /// `style`: Index in die Ansichtsschraffur-Stile (Strichstärke, Farbe); ohne = Kante.
    /// `paint`: Tiefe für die Maler-Reihenfolge, wenn sie von der Verdeckungstiefe abweicht (Muster-
    /// linien liegen knapp vor IHRER Fläche, auch wo sie tiefer liegen als deren Mittel).
    Line { a: Pt, b: Pt, depth: f64, style: Option<usize>, paint: Option<f64> },
    Item { depth: f64, rank: Option<f64>, prim: Primitive },
}

/// [171] Reicht das umgebende Rechteck der Fläche bis auf 0.3 m an `c` (die Wandfläche um ein Loch kommt in
/// Stücken, keines muss die Mitte des Lochs umschliessen)?
fn face_contains_bbox(f: &Face, c: Pt) -> bool {
    const NEAR: f64 = 0.3;
    let (lo, hi) = f.pts.iter().fold(([f64::INFINITY; 2], [f64::NEG_INFINITY; 2]), |(l, h), q| ([l[0].min(q[0]), l[1].min(q[1])], [h[0].max(q[0]), h[1].max(q[1])]));
    c[0] >= lo[0] - NEAR && c[0] <= hi[0] + NEAR && c[1] >= lo[1] - NEAR && c[1] <= hi[1] + NEAR
}

/// [171] Kanten des Rechteck-Lochs einer Formöffnung (`b` = Umriss `[x0, y0, x1, y1]` des Rahmens) entfernen: die
/// Seiten auf dem Rand des Umrisses (Quadrat um ein Rundfenster) und Reststücke im Band um den Umriss (das Loch
/// ist um den Einzug der Dämmung ([168]) grösser als die Öffnung; die Füllstücke decken nur bis an den Umriss —
/// dort blieb ein kurzer Strich rechts am Rundfenster stehen).
fn drop_hole_edges(edges: &mut Vec<silhouette::EdgeSeg>, b: [f64; 4]) {
    const TOL: f64 = 1e-3;
    const REVEAL: f64 = 0.12;
    let near = |a: f64, b: f64| (a - b).abs() < TOL;
    let inside = |q: Pt| q[0] > b[0] - REVEAL && q[0] < b[2] + REVEAL && q[1] > b[1] - REVEAL && q[1] < b[3] + REVEAL;
    let rim_u = |x: f64| x <= b[0] + TOL || x >= b[2] - TOL;
    let rim_v = |y: f64| y <= b[1] + TOL || y >= b[3] - TOL;
    edges.retain(|e| {
        let side = (near(e.a[0], e.b[0]) && rim_u(e.a[0])) || (near(e.a[1], e.b[1]) && rim_v(e.a[1]));
        // Ganz im Band ausserhalb einer Seite des Umrisses.
        let band = (e.a[0] >= b[2] - TOL && e.b[0] >= b[2] - TOL)
            || (e.a[0] <= b[0] + TOL && e.b[0] <= b[0] + TOL)
            || (e.a[1] >= b[3] - TOL && e.b[1] >= b[3] - TOL)
            || (e.a[1] <= b[1] + TOL && e.b[1] <= b[1] + TOL);
        !((side || band) && inside(e.a) && inside(e.b))
    });
}

fn outline_line(a: Pt, b: Pt) -> Primitive {
    line(v2(a[0], a[1]), v2(b[0], b[1]), "elevation-outline", EDGE_MM, EDGE_INK)
}


/// `generateElevationPlan`: Primitive und Ausmass; `None` ohne Ansichtslinie.
pub fn elevation_primitives(p: &Project, level: &LevelSpec, shadows: bool, mono: bool, vis: &Visibility, scale: f64) -> Result<Option<(Vec<Primitive>, [f64; 4])>, String> {
    elevation_primitives_with(p, level, shadows, mono, vis, scale, None)
}

/// Wie [`elevation_primitives`], mit den eingeschalteten Override-Regeln eines Blatt-Viewports (`rules`: ids;
/// `None` = Schalter im Projekt). [33] Regeln wirken auf Flächen (Füllung, Schraffur, ausblenden), Kanten
/// (Farbe, Stärke, Umriss aus) und Öffnungen (Linien, Glasfüllung).
pub fn elevation_primitives_with(p: &Project, level: &LevelSpec, shadows: bool, mono: bool, vis: &Visibility, scale: f64, rules: Option<&HashSet<String>>) -> Result<Option<(Vec<Primitive>, [f64; 4])>, String> {
    let Some(plane) = level.plane() else { return Ok(None) };
    let frame = frame_of(&plane);
    let mut walls = model3d::emit_walls_with(p, false, false)?;
    let mut slabs = model3d::emit_slabs(p);
    // Ortbeton-Läufe kommen im 3D als Netz; in der Ansicht als ein Block je Tritt ([151]).
    slabs.extend(model3d::emit_stairs_elevation(p));
    extend_wall_corners(p, &mut walls, (frame[6], frame[8]));
    let mut faces = project_faces(&frame, &walls, &slabs, &[]);
    // [157] Gekrümmte Deckenstirnen (Facetten eines Bogenrands) bündig mit der Fassade liegen hinter der Wand:
    // Bogenwand und Deckenrand sind verschieden fein facettiert, die Sehnen beider Netze schneiden einander um
    // Millimeter — ohne Vorrang schauten an jeder Ecke des Deckenrands Stücke der Schichtbänder (und Schatten von
    // ihnen) durch die Erkerwand. Ebene Stirnen bleiben, wie sie waren (Geschosslinie der Fassade).
    let curved = curved_slab_facets(&faces);
    for (f, _) in faces.iter_mut().zip(&curved).filter(|(_, c)| **c) {
        f.curved_slab = true;
        f.depth += SLAB_BEHIND_WALL;
        f.depth_min += SLAB_BEHIND_WALL;
        f.depth_max += SLAB_BEHIND_WALL;
        f.pd.iter_mut().for_each(|d| *d += SLAB_BEHIND_WALL);
    }
    cull_under_roofs(p, &frame, &walls, &mut faces);
    faces.extend(collect_roof_faces(p, &frame, &walls)?);
    faces.extend(collect_column_faces(p, &frame));
    faces.extend(collect_mesh_faces(p, &frame));
    // Ansichtsbereich ([36]): Bauteile, deren nächster Punkt weiter als `depth` hinter der Ansichtsebene
    // liegt, entfallen ganz (samt ihren Öffnungen, s. unten).
    let far = level.depth.filter(|d| *d > 0.0).map(|d| (d, drop_far_faces(&mut faces, d)));

    // Kategorie einer Fläche (erstes Element mit der id, wie `find`).
    let mut wall_cat: HashMap<&str, &str> = HashMap::new();
    for w in &p.walls {
        wall_cat.entry(w.id.as_str()).or_insert(w.category_code.as_str());
    }
    let mut ceil_cat: HashMap<&str, &str> = HashMap::new();
    for c in p.ceilings.as_deref().unwrap_or(&[]) {
        ceil_cat.entry(c.id.as_str()).or_insert(c.category_code.as_str());
    }
    let mut roof_cat: HashMap<&str, &str> = HashMap::new();
    for r in p.roofs.as_deref().unwrap_or(&[]) {
        roof_cat.entry(r.id.as_str()).or_insert(r.category_code.as_str());
    }
    let mut col_cat: HashMap<&str, &str> = HashMap::new();
    for c in p.columns.as_deref().unwrap_or(&[]) {
        col_cat.entry(c.id.as_str()).or_insert(c.category_code.as_str());
    }
    let mut mesh_cat: HashMap<&str, &str> = HashMap::new();
    for c in p.context.as_deref().unwrap_or(&[]) {
        if let ContextObject::ImportedMesh(m) = c {
            if let Some(code) = m.category_code.as_deref() {
                mesh_cat.entry(m.id.as_str()).or_insert(code);
            }
        }
    }
    let category = |f: &Face| -> Option<&str> {
        if f.id.is_empty() {
            return None;
        }
        match f.role {
            Role::Wall => wall_cat.get(f.id.as_str()).copied(),
            Role::Slab => ceil_cat.get(f.id.as_str()).copied(),
            Role::Roof => roof_cat.get(f.id.as_str()).copied(),
            Role::Column => col_cat.get(f.id.as_str()).copied(),
            Role::Mesh => mesh_cat.get(f.id.as_str()).copied(),
        }
    };
    if vis.has_vis && vis.has_display {
        faces.retain(|f| category(f).is_none_or(|c| vis.visible(c) && vis.render(c)));
    }
    let greyed = |f: &Face| vis.has_display && category(f).is_some_and(|c| vis.greyed(c));
    // [33] Override-Regeln: ausgeblendete Bauteile entfallen wie ausgeblendete Kategorien (verdecken nichts),
    // Wände samt ihren Öffnungen.
    let rv = RuleView::at(scale, rules).view("elevation");
    face_overrides(p, &mut faces, rv);
    let hidden_walls: HashSet<String> = faces.iter().filter(|f| f.role == Role::Wall && f.ov.as_ref().is_some_and(|o| o.hide)).map(|f| f.id.clone()).collect();
    faces.retain(|f| !f.ov.as_ref().is_some_and(|o| o.hide));

    // Ansichtsfarbe und -schraffur ([100]) der sichtbaren Bauteilseite.
    let (mut pattern_lines, mut pattern_styles) = surface_patterns(p, &mut faces, &frame, scale, mono);
    // [173] Öffnungslinien der Fenster nach der Modelldarstellung der Ebene (Element und Typ gehen vor).
    let mv = level.model_view.as_deref().and_then(|id| crate::plan::model_view::find(p, id));
    let win = crate::plan::model_view::resolve(mv, crate::plan::style::Detail::Mittel, scale).window;
    let mut openings = collect_openings(p, &frame, &win);
    // [171] Formöffnung: Fassaden-Schraffur auch auf den Füllstücken zwischen Umriss und Rechteck-Loch der Wand
    // (sonst bleibt um ein Rundfenster ein ungemustertes Quadrat).
    {
        let mut extra: Vec<Face> = Vec::new();
        for op in &openings {
            let Some((_, _, fills, wid)) = &op.shape else { continue };
            let host = faces.iter().filter(|f| f.role == Role::Wall && f.id == *wid && !f.ov.as_ref().is_some_and(|o| o.hide)).filter(|f| op.pts.iter().any(|q| face_contains_bbox(f, *q))).min_by(|a, b| a.depth_min.total_cmp(&b.depth_min));
            let Some(host) = host else { continue };
            // Dazu ein Band um die Öffnung: das Loch ist um den Einzug der Dämmung ([168]) grösser als der Umriss.
            const BAND: f64 = 0.06;
            let b = op.pts.iter().fold([f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY], |b, q| [b[0].min(q[0]), b[1].min(q[1]), b[2].max(q[0]), b[3].max(q[1])]);
            let rect = |x0: f64, y0: f64, x1: f64, y1: f64| vec![[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
            let band = [rect(b[0] - BAND, b[1] - BAND, b[2] + BAND, b[1]), rect(b[0] - BAND, b[3], b[2] + BAND, b[3] + BAND), rect(b[0] - BAND, b[1], b[0], b[3]), rect(b[2], b[1], b[2] + BAND, b[3])];
            for q in fills.iter().filter(|q| q.len() >= 3).chain(band.iter()) {
                extra.push(Face { pts: q.clone(), pd: vec![host.depth; q.len()], depth: host.depth, depth_min: host.depth_min, depth_max: host.depth_max, role: Role::Wall, id: host.id.clone(), fill: host.fill, normal: host.normal, ov: host.ov.clone(), two_sided: false, curved_slab: false });
            }
        }
        if !extra.is_empty() {
            let (lines, styles) = surface_patterns(p, &mut extra, &frame, scale, mono);
            let k0 = pattern_styles.len();
            pattern_styles.extend(styles);
            pattern_lines.extend(lines.into_iter().map(|(a, b, d, paint, k)| (a, b, d, paint, k + k0)));
        }
    }
    if !hidden_walls.is_empty() {
        let host = |id: &str| p.openings.as_deref().unwrap_or(&[]).iter().find(|o| o.id == id).map(|o| o.host_wall_id.as_str());
        openings.retain(|op| !host(&op.id).is_some_and(|w| hidden_walls.contains(w)));
    }
    if let Some((d, dropped)) = &far {
        let host = |id: &str| p.openings.as_deref().unwrap_or(&[]).iter().find(|o| o.id == id).map(|o| o.host_wall_id.as_str());
        openings.retain(|op| match host(&op.id) {
            Some(w) if !w.is_empty() => !dropped.contains(&(Role::Wall, w.to_string())),
            _ => op.depth <= d + 1e-6,
        });
    }
    let mut occ = vec![(faces.len() + openings.len()) as f64];
    for f in &faces {
        occ.extend([f.depth_max, f.pts.len() as f64]);
        for q in &f.pts {
            occ.extend(q);
        }
    }
    for op in &openings {
        // [171] Formöffnung verdeckt nur in ihrem Umriss (Fassaden-Schraffur bis an den Rahmen des Rundfensters).
        let pts: &[Pt] = op.shape.as_ref().map_or(&op.pts[..], |(o, _, _, _)| &o[..]);
        occ.extend([op.depth, pts.len() as f64]);
        for q in pts {
            occ.extend(q);
        }
    }
    let occluded = {
        let mut b = vec![openings.len() as f64];
        for op in &openings {
            let q = &op.pts;
            b.extend([(q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4.0, (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4.0, op.depth]);
        }
        crate::plan::elevation_geom::occluded_points(&occ, &b)
    };

    let mut acc = Acc::new();
    // Jede Fläche trägt ihre Bauteilfarbe (Wand/Decke aus dem 3D-Modell, Dach aus der Eindeckung).
    let fill_for = |fill: [f64; 3]| -> String { if mono { "#ffffff".into() } else { rgb_to_hex(fill) } };
    // [33] Füllung aus einer Regel hat Vorrang (auch in Tusche).
    let face_fill = |f: &Face| -> String { f.ov.as_ref().and_then(|o| o.fill.clone()).unwrap_or_else(|| fill_for(f.fill)) };
    let mut items: Vec<Item> = Vec::new();
    let mut seq = 0usize;
    let mut pending: Vec<Pending> = Vec::new();

    let nb = crate::roof_assembly::neighbors_rc(p);
    let assembled: std::collections::HashSet<&str> = p.roofs.as_deref().unwrap_or(&[]).iter().enumerate().filter(|(i, _)| crate::roof_assembly::is_assembled_with(p, *i, &nb)).map(|(_, r)| r.id.as_str()).collect();
    let needed = mesh_faces_needed(&faces);
    for (f, _) in faces.iter().zip(&needed).filter(|(_, n)| **n) {
        let pts: Vec<Vec2> = f
            .pts
            .iter()
            .map(|q| {
                acc.add(q[0], q[1]);
                v2(q[0], q[1])
            })
            .collect();
        let is_roof = f.role == Role::Roof;
        // Verschnittene Dächer ([G5]) kommen teils als Dreiecke: ein Hauch Kontur in der Füllfarbe deckt
        // die Haarfugen zwischen ihnen.
        let fill = face_fill(f);
        // [152] Importierte Netze ebenso (Dreiecke).
        let seam = (is_roof && assembled.contains(f.id.as_str())) || f.role == Role::Mesh;
        let hatch = f.ov.as_ref().and_then(|o| o.hatch.clone()).unwrap_or_else(no_hatch);
        let mut prim = if seam { polygon(pts, &fill, &fill, 0.15, hatch) } else { polygon(pts, &fill, "none", 0.0, hatch) };
        if let Primitive::Polygon { greyed: g, wall_id, ceiling_id, roof_id, column_id, context_object_id, .. } = &mut prim {
            *g = Some(greyed(f));
            if !f.id.is_empty() {
                match f.role {
                    Role::Wall => *wall_id = Some(f.id.clone()),
                    Role::Slab => *ceiling_id = Some(f.id.clone()),
                    Role::Roof => *roof_id = Some(f.id.clone()),
                    Role::Column => *column_id = Some(f.id.clone()),
                    Role::Mesh => *context_object_id = Some(f.id.clone()),
                }
            }
        }
        pending.push(Pending::Item { depth: f.depth, rank: Some(paint_rank(f.role)), prim });
    }
    // [149] Bäume: Silhouette (Krone gefüllt, Stamm) in der Maler-Reihenfolge; Bauteile davor verdecken sie.
    for (depth, tree) in super::trees::view_trees(p, level, vis, Some(super::trees::view_crown_fill(mono))) {
        for prim in tree {
            if let Primitive::Polygon { pts, .. } = &prim {
                for q in pts {
                    acc.add(q.x, q.y);
                }
            }
            pending.push(Pending::Item { depth, rank: None, prim });
        }
    }
    // Kanten exakt ([G4]): Umriss, Knicke und Silhouetten der Flächen, verdeckt durch Flächen und
    // Öffnungen davor; Facetten-Fugen der Bogenwände ([T2]) fallen über die Glättungsgruppe weg.
    let mut edges = elevation_edges(p, &faces, &openings, &frame, level.hidden_lines);
    // [171] Formöffnung: die Wand trägt im Modell das Rechteck-Loch; seine Kanten (Quadrat um ein Rundfenster)
    // entfallen, den Umriss zeichnet der Rahmen (wie `section::shaped_projection` im Schnitt).
    for op in openings.iter().filter(|op| op.shape.is_some()) {
        let b = op.pts.iter().fold([f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY], |b, q| [b[0].min(q[0]), b[1].min(q[1]), b[2].max(q[0]), b[3].max(q[1])]);
        drop_hole_edges(&mut edges, b);
    }
    for (a, b, depth, paint, k) in pattern_lines {
        pending.push(Pending::Line { a, b, depth, style: Some(k), paint: Some(paint) });
    }
    // Linien gebündelt gegen die Verdecker clippen (`flushPending`).
    {
        let mut q = vec![0.0];
        for pd in &pending {
            if let Pending::Line { a, b, depth, .. } = pd {
                q.extend([a[0], a[1], b[0], b[1], *depth]);
                q[0] += 1.0;
            }
        }
        let r = crate::plan::elevation_geom::clip_segments(&occ, &q);
        let mut i = 1;
        for pd in pending {
            match pd {
                Pending::Item { depth, rank, prim } => {
                    items.push(Item { depth, seq, rank, prim });
                    seq += 1;
                }
                Pending::Line { a, b, depth, style, paint } => {
                    let c = if r.is_empty() {
                        1
                    } else {
                        i += 1;
                        r[i - 1] as usize
                    };
                    for _ in 0..c {
                        let (sa, sb) = if r.is_empty() {
                            (a, b)
                        } else {
                            let s = ([r[i], r[i + 1]], [r[i + 2], r[i + 3]]);
                            i += 4;
                            s
                        };
                        acc.add(sa[0], sa[1]);
                        acc.add(sb[0], sb[1]);
                        let prim = match style.and_then(|k| pattern_styles.get(k)) {
                            Some((w, c)) => line(v2(sa[0], sa[1]), v2(sb[0], sb[1]), "elevation-surface-pattern", *w, c),
                            None => outline_line(sa, sb),
                        };
                        items.push(Item { depth: paint.unwrap_or(depth), seq, rank: None, prim });
                        seq += 1;
                    }
                }
            }
        }
    }

    // [33] Schlagschatten über Regeln (Bauteilart „Schatten“): Ausblenden, Füllung, Linie (Umriss).
    let sov = if shadows { super::overrides::shadow_override(p, rv) } else { None };
    let shadows = shadows && !sov.as_ref().is_some_and(|(a, _)| a.hidden());
    let shadow_style = |mut q: Primitive| -> Primitive {
        if let (Some((a, l)), Primitive::Polygon { fill, stroke, stroke_width_mm, .. }) = (&sov, &mut q) {
            if let Some(f) = &l.fill_color {
                *fill = f.clone();
            }
            if a.color.is_some() || a.lineweight.is_some() {
                *stroke = a.color.clone().unwrap_or_else(|| EDGE_INK.into());
                *stroke_width_mm = a.lineweight.unwrap_or(EDGE_MM);
            }
        }
        q
    };
    if shadows {
        let wall_faces: Vec<&Face> = faces.iter().filter(|f| f.role == Role::Wall).collect();
        let mut casters: Vec<&Face> = faces.iter().filter(|f| f.role == Role::Slab).collect();
        casters.extend(faces.iter().filter(|f| f.role == Role::Roof));
        // [157] Teil 4: Absätze unter 0.2 mm Papier glätten.
        let tol = SHADOW_SMOOTH_MM * 1e-3 * if scale.is_finite() && scale > 0.0 { scale } else { 100.0 };
        let f = crate::plan::elevation_geom::shadows(&encode_shadow_polys(&wall_faces, true), &encode_shadow_polys(&casters, false), tol);
        let mut i = 1;
        for _ in 0..f.first().copied().unwrap_or(0.0) as usize {
            let depth = f[i];
            let count = f[i + 1] as usize;
            i += 2;
            let pts: Vec<Vec2> = (0..count)
                .map(|j| {
                    let (x, y) = (f[i + 2 * j], f[i + 2 * j + 1]);
                    acc.add(x, y);
                    v2(x, y)
                })
                .collect();
            i += 2 * count;
            let mut prim = polygon(pts, if mono { SHADOW_FILL_MONO } else { SHADOW_FILL }, "none", 0.0, no_hatch());
            // [137] Klick auf den Schlagschatten wählt die Schatten-Einstellung der Ansicht (keine Element-Id).
            if let Primitive::Polygon { context_object_id, .. } = &mut prim {
                *context_object_id = Some(crate::plan::extras::SITE_PICK_VIEW_SHADOWS.into());
            }
            items.push(Item { depth: depth - EPS * 10.0, seq, rank: None, prim: shadow_style(prim) });
            seq += 1;
        }
    }

    let op_rules = super::overrides::has_active(p, rv);
    for (k, op) in openings.iter().enumerate() {
        if occluded.get(1 + k) == Some(&1.0) {
            continue;
        }
        let mut to_vec = |q: &[Pt]| -> Vec<Vec2> {
            q.iter()
                .map(|p| {
                    acc.add(p[0], p[1]);
                    v2(p[0], p[1])
                })
                .collect()
        };
        let d = op.depth - EPS * 100.0;
        let id = Some(op.id.as_str());
        // Formöffnung: das Rechteck-Loch der Wand ausserhalb des Umrisses in Wandfarbe schliessen.
        if let Some((_, _, fills, wid)) = &op.shape {
            let wall_fill = faces.iter().find(|f| f.role == Role::Wall && f.id == *wid).map_or("#ffffff".to_string(), face_fill);
            // [171] Knapp hinter der Wandfläche: die Fassaden-Schraffur der Wand (Musterlinien knapp vor ihr) läuft
            // über die Füllung bis an den Rahmen, statt im Rechteck des Lochs auszusetzen.
            let face_depth = faces
                .iter()
                .filter(|f| f.role == Role::Wall && f.id == *wid)
                .filter(|f| op.pts.iter().any(|q| face_contains_bbox(f, *q)))
                .map(|f| f.depth_min)
                .fold(f64::INFINITY, f64::min);
            let fill_depth = if face_depth.is_finite() { (face_depth + EPS * 10.0).min(d + EPS * 10.0).max(face_depth + EPS) } else { d + EPS * 10.0 };
            for q in fills {
                let pts = to_vec(q);
                items.push(Item { depth: fill_depth, seq, rank: None, prim: polygon(pts, &wall_fill, "none", 0.0, no_hatch()) });
                seq += 1;
            }
        }
        let mut push = |prim: Primitive| {
            items.push(Item { depth: d, seq, rank: None, prim });
            seq += 1;
        };
        // [33] Regeln der Öffnung: Linienfarbe/-stärke, Füllung für Glas und Türblatt.
        let ov = if op_rules { opening_override(p, rv, &op.id) } else { None };
        let ink = ov.as_ref().and_then(|o| o.color.as_deref()).unwrap_or(EDGE_INK);
        let (frame_mm, edge_mm) = ov.as_ref().and_then(|o| o.lineweight).map_or((FRAME_MM, EDGE_MM), |w| (w, w));
        let glass_fill = ov.as_ref().and_then(|o| o.fill.as_deref()).unwrap_or(if mono { GLASS_FILL_MONO } else { GLASS_FILL_COLOR });
        let leaf_fill = ov.as_ref().and_then(|o| o.fill.as_deref()).unwrap_or(if mono { "#ffffff" } else { DOOR_LEAF_FILL_COLOR });
        let frame_pts = op.shape.as_ref().map_or(op.frame.as_ref().map_or(&op.pts[..], |f| &f[..]), |(o, _, _, _)| &o[..]);
        push(poly_prim(to_vec(frame_pts), if mono { "#ffffff" } else { FRAME_FILL_COLOR }, ink, frame_mm, id));
        if let Some((_, g, _, _)) = &op.shape {
            push(poly_prim(to_vec(g), glass_fill, ink, edge_mm, id));
        }
        for r in &op.sill {
            push(poly_prim(to_vec(r), if mono { "#ffffff" } else { SILL_FILL_COLOR }, ink, edge_mm, id));
        }
        for r in &op.sash_rects {
            push(poly_prim(to_vec(r), "none", ink, edge_mm, id));
        }
        for r in &op.glass {
            push(poly_prim(to_vec(r), glass_fill, ink, edge_mm, id));
        }
        for r in &op.door_leaf {
            push(poly_prim(to_vec(r), leaf_fill, ink, edge_mm, id));
        }
        if shadows && op.shape.is_none() {
            let q = &op.pts;
            let lerp = |a: Pt, b: Pt, t: f64| -> Pt { [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t] };
            let quad_at = |fa: f64, fz: f64| lerp(lerp(q[0], q[1], fa), lerp(q[3], q[2], fa), fz);
            let w_u = hypot2(q[1][0] - q[0][0], q[1][1] - q[0][1]);
            let h_v = hypot2(q[3][0] - q[0][0], q[3][1] - q[0][1]);
            let f_u = min(0.3, 0.08 / max(w_u, 1e-6));
            let f_v = min(0.3, 0.08 / max(h_v, 1e-6));
            for (fa0, fa1, fz0, fz1) in [(0.0, 1.0, 1.0 - f_v, 1.0), (0.0, f_u, 0.0, 1.0 - f_v)] {
                let r = [quad_at(fa0, fz0), quad_at(fa1, fz0), quad_at(fa1, fz1), quad_at(fa0, fz1)];
                push(shadow_style(polygon(to_vec(&r), if mono { OPENING_SHADOW_FILL_MONO } else { OPENING_SHADOW_FILL }, "none", 0.0, no_hatch())));
            }
        }
        for (a, b) in &op.divisions {
            let l = line(v2(a[0], a[1]), v2(b[0], b[1]), "elevation-division", edge_mm, ink);
            push(match &ov { Some(o) => o.restyle(l), None => l });
        }
        for (a, b) in &op.symbol {
            let mut l = line(v2(a[0], a[1]), v2(b[0], b[1]), "elevation-opening-symbol", 0.1, SYMBOL_INK);
            if let Primitive::Line { dash, .. } = &mut l {
                *dash = Some(Some(vec![2.2, 1.8]));
            }
            push(l);
        }
    }

    // Painter: fern zuerst; Gleichstand nach Rang (Decke < Wand < Dach < Rest), dann Reihenfolge.
    let nz = |d: f64| if d.is_nan() { 0.0 } else { d };
    items.sort_by(|a, b| {
        let d = nz(b.depth - a.depth);
        if d != 0.0 {
            return super::section::cmp_num(d);
        }
        let r = nz(a.rank.unwrap_or(3.0) - b.rank.unwrap_or(3.0));
        if r != 0.0 {
            return super::section::cmp_num(r);
        }
        a.seq.cmp(&b.seq)
    });
    let mut prims: Vec<Primitive> = items.into_iter().map(|it| it.prim).collect();
    // Exakt sichtbare Kanten liegen über allen Füllungen (die Füllungen bleiben Maler-Ordnung).
    let silhouette = Silhouette::of(&faces);
    for e in &edges {
        acc.add(e.a[0], e.a[1]);
        acc.add(e.b[0], e.b[1]);
        // [33] Regeln der Fläche: Umriss aus, Linienfarbe/-stärke.
        let ov = (e.owner > 0).then(|| faces.get(e.owner as usize - 1)).flatten().and_then(|f| f.ov.as_deref());
        if ov.is_some_and(|o| o.outline == Some(false)) {
            continue;
        }
        if e.hidden {
            let mut l = line(v2(e.a[0], e.a[1]), v2(e.b[0], e.b[1]), "elevation-hidden", HIDDEN_MM, HIDDEN_INK);
            if let Primitive::Line { dash, .. } = &mut l {
                *dash = Some(Some(HIDDEN_DASH.to_vec()));
            }
            prims.push(l);
        } else if silhouette.on(e.a, e.b) {
            let l = line(v2(e.a[0], e.a[1]), v2(e.b[0], e.b[1]), "elevation-outline", SILHOUETTE_MM, EDGE_INK);
            prims.push(match ov { Some(o) => o.restyle(l), None => l });
        } else {
            let l = outline_line(e.a, e.b);
            prims.push(match ov { Some(o) => o.restyle(l), None => l });
        }
    }
    // [T6] Gelände-Silhouette (gestaltetes Terrain) zwischen Ansichtsebene und vorderster Gebäudefläche; was
    // darunter liegt, verdeckt das Gelände (Papierfläche über dem Gebäude).
    let depth_max = faces.iter().map(|f| f.depth_min).fold(f64::INFINITY, f64::min) + 0.3;
    let mut has_terrain = false;
    if acc.min_x.is_finite() && depth_max.is_finite() && !crate::excavation::terrains(p).is_empty() {
        let terrain_shown = |c: Option<&str>| c.is_none_or(|c| vis.visible(c) && vis.render(c));
        for t in crate::excavation::terrains(p) {
            if !terrain_shown(t.category_code.as_deref()) || t.hidden == Some(true) {
                continue;
            }
            // [33] Gelände über Regeln (Bauteilart „Gelände“): Ausblenden, Füllung der Geländefläche, Linie.
            let tov = super::overrides::terrain_override(p, rv, t.category_code.as_deref(), &t.name);
            if tov.as_ref().is_some_and(|(a, _)| a.hidden()) {
                continue;
            }
            let tfill = tov.as_ref().and_then(|(_, l)| l.fill_color.clone()).unwrap_or_else(|| "#ffffff".into());
            for l in terrain_silhouette(p, t, &frame, (acc.min_x - 6.0, acc.max_x + 6.0), depth_max) {
                has_terrain = true;
                let low = l.iter().map(|q| q[1]).fold(acc.min_y, f64::min) - 1.0;
                let mut ring: Vec<Vec2> = l.iter().map(|q| v2(q[0], q[1])).collect();
                ring.push(v2(l[l.len() - 1][0], low));
                ring.push(v2(l[0][0], low));
                // [137] Die Geländefläche wählt das Gelände (Pick-Id).
                let mut mask = polygon(ring, &tfill, "none", 0.0, no_hatch());
                if let Primitive::Polygon { context_object_id, .. } = &mut mask {
                    *context_object_id = Some(t.id.clone());
                }
                prims.push(mask);
                for w in l.windows(2) {
                    acc.add(w[0][0], w[0][1]);
                    acc.add(w[1][0], w[1][1]);
                    let mut tl = [line(v2(w[0][0], w[0][1]), v2(w[1][0], w[1][1]), "elevation-terrain", GROUND_MM, GROUND_INK)];
                    if let Some((a, _)) = &tov {
                        super::context::restyle_lines(p, a, &mut tl);
                    }
                    prims.extend(tl);
                }
            }
        }
    }
    // Mit Gelände ersetzt die Silhouette die Grundlinie ([T6]).
    if acc.min_x.is_finite() && acc.min_y.is_finite() && !has_terrain {
        prims.push(line(v2(acc.min_x, acc.min_y), v2(acc.max_x, acc.min_y), "elevation-ground", GROUND_MM, GROUND_INK));
    }
    Ok(Some((prims, acc.bounds())))
}

/// Bauteil der sichtbaren Wandseite: rechts der Achse (Anfang → Ende) liegt die äusserste Schicht
/// (`layers[0]`), links die innerste; Stirnseiten haben keine.
/// Ansichtsbereich ([36]): Flächen der Bauteile (Rolle + id) weglassen, deren nächster Punkt weiter als
/// `depth` hinter der Ansichtsebene liegt; ein Bauteil zählt als Ganzes. Flächen ohne id zählen einzeln.
/// Liefert die weggelassenen Bauteile.
fn drop_far_faces(faces: &mut Vec<Face>, depth: f64) -> std::collections::HashSet<(Role, String)> {
    let mut near: HashMap<(Role, &str), f64> = HashMap::new();
    for f in faces.iter().filter(|f| !f.id.is_empty()) {
        let m = near.entry((f.role, f.id.as_str())).or_insert(f64::INFINITY);
        *m = m.min(f.depth_min);
    }
    let dropped: std::collections::HashSet<(Role, String)> = near.into_iter().filter(|(_, m)| *m > depth + 1e-6).map(|((r, id), _)| (r, id.to_string())).collect();
    faces.retain(|f| if f.id.is_empty() { f.depth_min <= depth + 1e-6 } else { !dropped.contains(&(f.role, f.id.clone())) });
    dropped
}

fn wall_side_component<'a>(p: &'a Project, wall: &Wall, normal: [f64; 3]) -> Option<&'a Component> {
    let outer = wall_side(wall, normal)?;
    let layers = &p.wall_type(wall)?.layers;
    let l = if outer { layers.first() } else { layers.last() }?;
    p.component(&l.component_id)
}

/// Sichtbare Wandseite einer Fläche: `Some(true)` = rechts der Achse (äusserste Schicht), `Some(false)` =
/// links (innerste), `None` = Stirnseite.
fn wall_side(wall: &Wall, normal: [f64; 3]) -> Option<bool> {
    let (dx, dy) = (wall.end.x - wall.start.x, wall.end.y - wall.start.y);
    let len = hypot2(dx, dy);
    if !(len > 1e-9) {
        return None;
    }
    // Plan (x, y) → Welt (x, Höhe, y); rechte Normale (dy, −dx).
    let side = (dy * normal[0] - dx * normal[2]) / len;
    if side > 0.7 {
        Some(true)
    } else if side < -0.7 {
        Some(false)
    } else {
        None
    }
}

/// Abfrage `elevationPlan`: `args` = `[mono, shadows]`, `text` = `{"level": {...}, "hasVis", "invisible",
/// "hasDisplay", "norender", "grey"}`. Puffer mit einer Gruppe und Ausmass; ohne Ansichtslinie ohne Gruppen.
pub fn elevation_plan_buf(p: &Project, args: &[f64], text: &str) -> Result<Vec<u8>, String> {
    let v: serde_json::Value = serde_json::from_str(text).map_err(|e| format!("Ansicht-Argumente: {e}"))?;
    let level = LevelSpec::from_json(v.get("level").unwrap_or(&serde_json::Value::Null));
    let vis = Visibility::from_json(&v);
    let mono = args.first().is_some_and(|&x| x != 0.0);
    let shadows = args.get(1).is_some_and(|&x| x != 0.0);
    // Massstab für die Ausdünnung der Ansichtsschraffur (fehlt er: 1:100).
    let scale = args.get(2).copied().filter(|s| s.is_finite() && *s > 0.0).unwrap_or(100.0);
    let mut w = crate::plan::buf::Writer::new(true);
    w.post = super::extras::sketch_post(Some(level.sketch), scale);
    // [33] Eingeschaltete Override-Regeln eines Blatt-Viewports (`rules`: ids; fehlt = Schalter im Projekt).
    let on: Option<HashSet<String>> = v.get("rules").and_then(|a| a.as_array()).map(|a| a.iter().filter_map(|s| s.as_str().map(String::from)).collect());
    if let Some((mut prims, bounds)) = elevation_primitives_with(p, &level, shadows, mono, &vis, scale, on.as_ref())? {
        super::extras::scale_line_weights(p, scale, &mut prims);
        w.group(&prims);
        // Achsraster ([112]): Achsen quer zur Blickebene.
        let grid = super::grid_view::grid_prims(p, &level, bounds, scale);
        if !grid.is_empty() {
            w.group(&grid);
        }
        w.bounds = Some(super::grid_view::union_bounds(bounds, &grid));
    }
    Ok(w.finish())
}

#[cfg(test)]
mod tests;
