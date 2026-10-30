//! Schnittflaechen-Geometrie fuer den Live-3D-Schnitt: wandelt die analytischen
//! Cut-Polygone aus `section::cut_section` (achsparallele (u,v)-Rechtecke, siehe
//! `section.rs`-Moduldoc) in kamerataugliche Dreiecks-Geometrie fuer die Cap-
//! Pipeline (`gpu::cap_pipeline`, Schraffur in `shaders::CAP_WGSL`).
//!
//! ## Ruecktransformation (u,v) -> Welt
//!
//! `SectionPlane::project(p) = [dot(p - point, u_axis), p.y]` (nur vertikale
//! Ebenen). Die Inverse fuer einen Punkt AUF der Ebene ist damit
//!
//! ```text
//! world = point + u * u_axis   (horizontale Lage),   world.y = v
//! ```
//!
//! `u_axis` ist horizontal (y = 0), also traegt `u * u_axis` nichts zur Hoehe
//! bei — `world.y = v` gilt exakt, und der Punkt liegt auf der Ebene, weil
//! `u_axis` und die Welt-Hoehenachse [0,1,0] beide senkrecht auf der (horizon-
//! talen) Normale stehen. Wir nutzen `SectionPlane::u_axis()` (pub(crate)),
//! damit die Achsdefinition (inkl. Entartungs-Fallback) mit `section.rs`
//! identisch bleibt.
//!
//! ## Ausgabeformat
//!
//! Interleaved `[world_x, world_y, world_z, u, v, pattern, angle_rad, scale]` je
//! Vertex (8 f32, `CAP_FLOATS_PER_VERTEX`), Dreiecksliste. `(u,v)` in Modell-Metern
//! wandern als Attribut mit, damit die Schraffur im Fragment-Shader ein
//! durchgaengiges, blickwinkel-unabhaengiges Muster IN der Schnittebene zeichnet
//! (nicht im Bildschirmraum). `pattern`/`angle_rad`/`scale` kommen aus der
//! Bauteil-Schraffur (`CutPolygon::hatch` -> `types::Hatch`) und waehlen im Shader
//! das MUSTER je geschnittener Schicht (statt eines fixen 45°-Musters). Sie sind je
//! Cut-Polygon konstant, wandern aber als (redundantes) Vertex-Attribut mit — das
//! haelt die Cap-Pipeline ohne zusaetzliche per-Draw-Uniform-Verwaltung (die Caps
//! werden in EINEM `draw` gezeichnet). Ein Cut-Polygon ist stets ein konvexes
//! Rechteck (4 Ecken, siehe `section.rs`) — Fan-Triangulierung genuegt.

use crate::section::{cut_section, CutPolygon, SectionPlane};
use dossier_hatch::hatch::{build_hatch_runs, v2, Hatch as GenHatch, HatchKind, Pattern};
use crate::section_boolean::subtract_dominant_bands;
use crate::types::{RoofLayerInput, SlabInput, WallInput};

/// f32 pro Cap-Vertex: [pos.x, pos.y, pos.z, u, v, pattern, angle_rad, scale,
/// line_weight_mm]. Spiegel des Vertex-Layouts der `cap_pipeline` (gpu.rs) und des
/// `VsIn` in `CAP_WGSL` (shaders.rs). `line_weight_mm` steuert die Musterlinien-
/// Breite (mm-Papier -> Welt) je Schraffur.
pub const CAP_FLOATS_PER_VERTEX: usize = 9;

/// Default-Musterlinien-Staerke (mm-Papier), wenn ein Cut-Polygon keine `hatch`
/// traegt (Fallback-Diagonale) — Haarlinie, wie `HatchRender.lineWeight`-Default.
const FALLBACK_HATCH_LINE_WEIGHT_MM: f32 = 0.13;

/// f32 pro Cut-Linien-Vertex: [pos.x, pos.y, pos.z, r, g, b] — dasselbe Layout wie
/// die Grid-/Highlight-LineList (`GRID_WGSL`), damit die Schnitt-Umrisslinien ohne
/// eigenes Vertex-Format ueber eine (Dreiecks-)Ribbon-Pipeline laufen.
pub const CUT_LINE_FLOATS_PER_VERTEX: usize = 6;

/// Default-Schnittkanten-Farbe (dunkle Tinte), wenn ein Band keinen eigenen
/// `line_color` traegt — passend zur 2D-Schnittkonvention (dunkle Fugenlinie).
const DEFAULT_CUT_LINE_COLOR: [f32; 3] = [0.10, 0.10, 0.10];

/// Default-Strichstaerke der Schnitt-Umrisslinie in mm-Papier (Haarlinie), wenn
/// ein Band keinen eigenen `line_weight` traegt.
const DEFAULT_CUT_LINE_WEIGHT_MM: f32 = 0.35;

/// mm-Papier -> Welt-Meter fuer die Ribbon-BREITE der Schnitt-Umrisslinien.
///
/// EHRLICHE EINSCHRAENKUNG: die 2D-Strichstaerke ist in mm-Papier (masstabsabhaengig).
/// Der 3D-Schnitt kennt keinen Papiermasstab; die Linie wird hier als flaches Ribbon
/// mit KONSTANTER Welt-Breite in die Schnittebene gelegt (blickwinkel-unabhaengig,
/// skaliert also mit der Kamera-Distanz wie gemalte Geometrie — NICHT bildschirmfest).
/// Der Faktor ist bewusst grob gewaehlt (0.35 mm -> ~3.5 mm Welt), damit die Fuge
/// ueberhaupt lesbar bleibt; eine bildschirmfeste Strichstaerke braeuchte eine
/// Screen-Space-Expansion in einer eigenen Pipeline (bekannte Luecke, siehe
/// Schlussbericht/Moduldoc).
const CUT_LINE_MM_TO_WORLD: f32 = 0.01;

/// Kleiner Versatz (Meter) der Umrisslinien-Ribbons ZUR KAMERA (entgegen der
/// Ebenennormale), damit sie (a) nicht durch die Schnittebenen-Kappung von
/// `GRID_WGSL` (`depth > 0` = hinter der Ebene) weggeschnitten werden und (b)
/// sichtbar VOR den Cut-Caps liegen (die exakt auf der Ebene sitzen).
const CUT_LINE_LIFT: f32 = 0.002;

/// Ab dieser Muster-Id zeichnet NICHT der Cap-Shader, sondern der Kern-Generator (`dossier_hatch`, derselbe
/// wie in Plan/Schnitt — Dämmschlange, Zickzack, Welle, Holzkreuz, Naturstein, Erdreich, Kies, Punktfeld):
/// die Ids sind die Muster-Codes des Generators (`Pattern::from_code`). Der Shader füllt solche Flächen leer
/// (Papier); die Linien kommen als Ribbons (`build_cut_cap_lines`).
pub const GENERATED_PATTERN_MIN: u32 = 4;

/// Fallback-Muster-Id, wenn ein Cut-Polygon keine `hatch` traegt: 2 = diagonal
/// (45°) — reproduziert mit `angle_rad = 0`, `scale = 1` exakt das fruehere fest
/// verdrahtete 45°-Muster (Rueckwaertskompatibilitaet fuer Waende/Decken ohne
/// aufgeloeste Bauteil-Schraffur).
const FALLBACK_PATTERN: f32 = 2.0;

/// Erzeugt die Schnittflaechen-Geometrie (Cut-Caps) fuer eine vertikale
/// Schnittebene: ruft `cut_section` und trianguliert jedes (u,v)-Rechteck in die
/// Welt zurueck. Rueckgabe = interleaved Vertexpuffer (`CAP_FLOATS_PER_VERTEX`),
/// leer, wenn die Ebene das Modell nicht schneidet.
///
/// WINDING: bewusst nicht garantiert kamerakonsistent — die Cap-Pipeline
/// zeichnet ohne Backface-Culling (`CullMode::None`, siehe gpu.rs), sodass die
/// flache Schnittflaeche aus beiden Richtungen sichtbar ist. Die Schraffur haengt
/// nicht von der Normale ab.
/// Berechnet die (u,v)-Cut-Polygone der Schnittebene MIT angewandter Boolean-
/// Dominanz (`section_boolean::subtract_dominant_bands`): die staerkere Schicht
/// schneidet die schwaechere weg — elementuebergreifend, exakt wie der 2D-Schnitt
/// (`toSection.ts::attachCutStyles` Phase 2). Gemeinsame Basis der Cut-Cap-Flaechen
/// (`build_cut_caps`) UND der Cut-Umrisslinien (`build_cut_cap_lines`), damit beide
/// auf DERSELBEN, ueberlappungsfreien Rechteck-Menge arbeiten.
fn cut_cap_polys(
    plane: &SectionPlane,
    walls: &[WallInput],
    slabs: &[SlabInput],
    roofs: &[RoofLayerInput],
) -> Vec<CutPolygon> {
    let out = cut_section(plane, walls, slabs, roofs);
    subtract_dominant_bands(out.cut_polygons)
}

pub fn build_cut_caps(
    plane: &SectionPlane,
    walls: &[WallInput],
    slabs: &[SlabInput],
    roofs: &[RoofLayerInput],
) -> Vec<f32> {
    let polys = cut_cap_polys(plane, walls, slabs, roofs);
    let point = plane.point;
    let u_axis = plane.u_axis();
    // (u, v) -> Welt: horizontale Lage aus point + u*u_axis, Hoehe = v.
    let to_world = |uv: [f32; 2]| -> [f32; 3] {
        [
            point[0] + uv[0] * u_axis[0],
            uv[1],
            point[2] + uv[0] * u_axis[2],
        ]
    };

    let mut verts: Vec<f32> = Vec::new();
    for poly in &polys {
        let pts = &poly.pts;
        if pts.len() < 3 {
            continue;
        }
        // Muster/Winkel/Skalierung aus der Bauteil-Schraffur (oder Fallback-
        // Diagonale). Winkel von Grad in Radiant, damit der Shader direkt
        // cos/sin rechnen kann.
        let (pattern, angle_rad, scale, line_weight) = match poly.hatch {
            Some(h) => (
                // Generator-Muster: Shader zeichnet nichts (Id 0), die Linien kommen als Ribbons.
                if h.pattern >= GENERATED_PATTERN_MIN { 0.0 } else { h.pattern as f32 },
                h.angle.to_radians(),
                h.scale.max(0.05),
                h.line_weight.max(0.0),
            ),
            None => (FALLBACK_PATTERN, 0.0, 1.0, FALLBACK_HATCH_LINE_WEIGHT_MM),
        };
        let mut push_vertex = |uv: [f32; 2]| {
            let w = to_world(uv);
            verts.extend_from_slice(&[
                w[0], w[1], w[2], uv[0], uv[1], pattern, angle_rad, scale, line_weight,
            ]);
        };
        // Fan-Triangulierung (konvexe Rechtecke): (0, i, i+1).
        for i in 1..pts.len() - 1 {
            push_vertex(pts[0]);
            push_vertex(pts[i]);
            push_vertex(pts[i + 1]);
        }
    }
    verts
}

/// Erzeugt die Schnitt-UMRISSLINIEN (P2): fuer JEDES ueberlebende Cut-Cap-Polygon
/// seine Kanten als flache Ribbon-Dreiecke auf der Schnittebene, in Welt-
/// Koordinaten (dieselbe (u,v)->Welt-Ruecktransformation wie `build_cut_caps`).
/// Rueckgabe = interleaved `[px,py,pz, r,g,b]` (`CUT_LINE_FLOATS_PER_VERTEX`,
/// TriangleList), leer wenn die Ebene das Modell nicht schneidet.
///
/// STIL je Kante: Farbe/Strichstaerke aus dem `line_color`/`line_weight` des Bandes
/// (aus dem `jointLineStyleId`-LineStyle, TS-seitig aufgeloest), sonst der Default-
/// Schnittkanten-Stil. Die Strichstaerke (mm-Papier) wird ueber `CUT_LINE_MM_TO_WORLD`
/// in eine konstante Welt-Breite umgesetzt (siehe dortige Doku — bewusste
/// Vereinfachung, keine bildschirmfeste Strichstaerke). Jede Kante wird als Quad
/// (2 Dreiecke) um ihre Mittellinie gelegt, mit der Ribbon-Breite senkrecht zur
/// Kante IN der Ebene; alle Ribbons um `CUT_LINE_LIFT` zur Kamera versetzt, damit
/// sie nicht an der Ebene weggeclippt werden und vor den Caps liegen.
///
/// Laeuft ueber `poly.pts` DIREKT (nicht mehr ueber dessen achsparallele
/// Bounding-Box, `rect_of_poly`) — fuer Wand-/Decken-Baender identisch (deren
/// `pts` SIND bereits genau die vier Bbox-Ecken in derselben Reihenfolge, siehe
/// `section.rs`/`poly_from_rect`), aber notwendig fuer NICHT achsparallele
/// Polygone (Dach-Schichten, `roof_cut::cut_roof_layer` — ein Dach wird von einer
/// vertikalen Schnittebene i. A. als schiefes Parallelogramm/Trapez getroffen,
/// dessen Bbox-Rechteck die Kanten falsch wiedergeben wuerde).
pub fn build_cut_cap_lines(
    plane: &SectionPlane,
    walls: &[WallInput],
    slabs: &[SlabInput],
    roofs: &[RoofLayerInput],
) -> Vec<f32> {
    let polys = cut_cap_polys(plane, walls, slabs, roofs);
    let point = plane.point;
    let u_axis = plane.u_axis();
    let normal = plane.normal;
    // Kamera-waertiger Lift entlang -normal (normal zeigt vom Betrachter ins Modell).
    let lift = [
        -normal[0] * CUT_LINE_LIFT,
        -normal[1] * CUT_LINE_LIFT,
        -normal[2] * CUT_LINE_LIFT,
    ];
    let to_world = |uv: [f32; 2]| -> [f32; 3] {
        [
            point[0] + uv[0] * u_axis[0] + lift[0],
            uv[1] + lift[1],
            point[2] + uv[0] * u_axis[2] + lift[2],
        ]
    };

    let mut verts: Vec<f32> = Vec::new();
    for poly in &polys {
        let n = poly.pts.len();
        if n < 2 {
            continue;
        }
        // Stil aus den Band-Metadaten (oder Default).
        let (color, weight_mm) = match &poly.cut {
            Some(meta) => (
                meta.line_color.unwrap_or(DEFAULT_CUT_LINE_COLOR),
                meta.line_weight.unwrap_or(DEFAULT_CUT_LINE_WEIGHT_MM),
            ),
            None => (DEFAULT_CUT_LINE_COLOR, DEFAULT_CUT_LINE_WEIGHT_MM),
        };
        let half_w = (weight_mm.max(0.0) * CUT_LINE_MM_TO_WORLD * 0.5).max(1e-4);

        // Die tatsaechlichen Polygon-Ecken (u,v) im Umlauf; je Kante ein Ribbon.
        for k in 0..n {
            let a = to_world(poly.pts[k]);
            let b = to_world(poly.pts[(k + 1) % n]);
            push_line_ribbon(&mut verts, a, b, normal, half_w, color);
        }
        push_generated_hatch(&mut verts, poly, &to_world, normal);
    }
    verts
}

/// Muster-Tinte der Generator-Schraffur (wie `ink` im Cap-Shader).
const HATCH_INK: [f32; 3] = [0.06, 0.06, 0.06];

/// Musterlinien eines Cut-Polygons mit Generator-Muster (`GENERATED_PATTERN_MIN`) als Ribbons: dieselben
/// Linien wie im 2D-Schnitt (`dossier_hatch::hatch::build_hatch_runs`, Polygon (u,v) in Metern, Winkel und
/// Skala der Bauteil-Schraffur). Breite wie die Shader-Linien (mm-Papier -> Welt über `CUT_LINE_MM_TO_WORLD`).
fn push_generated_hatch(
    out: &mut Vec<f32>,
    poly: &CutPolygon,
    to_world: &dyn Fn([f32; 2]) -> [f32; 3],
    normal: [f32; 3],
) {
    let Some(h) = poly.hatch else { return };
    if h.pattern < GENERATED_PATTERN_MIN || poly.pts.len() < 3 {
        return;
    }
    let gen = GenHatch {
        pattern: Pattern::from_code(h.pattern as f64),
        kind: HatchKind::Vector,
        random: false,
        scale: h.scale.max(0.05) as f64,
        angle: h.angle as f64,
        line_weight: h.line_weight as f64,
        origin: None,
        seed: None,
        density: None,
        length_min: None,
        length_max: None,
        dash: Vec::new(),
        motif: None,
        polar: None,
    };
    let pts: Vec<_> = poly.pts.iter().map(|p| v2(p[0] as f64, p[1] as f64)).collect();
    let half_w = (h.line_weight.max(0.0) * CUT_LINE_MM_TO_WORLD * 0.5).max(1e-4);
    for run in build_hatch_runs(&pts, &gen) {
        for w in run.windows(2) {
            let a = to_world([w[0].x as f32, w[0].y as f32]);
            let b = to_world([w[1].x as f32, w[1].y as f32]);
            push_line_ribbon(out, a, b, normal, half_w, HATCH_INK);
        }
    }
}

/// Legt ein flaches Ribbon-Quad (2 Dreiecke) der halben Breite `half_w` um die
/// Kante `a`->`b`, verbreitert IN der Schnittebene (senkrecht zur Kante ueber
/// `cross(normal, dir)`), und schreibt es als 6 Vertices `[pos, color]` in `out`.
fn push_line_ribbon(
    out: &mut Vec<f32>,
    a: [f32; 3],
    b: [f32; 3],
    normal: [f32; 3],
    half_w: f32,
    color: [f32; 3],
) {
    let dir = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    let len = (dir[0] * dir[0] + dir[1] * dir[1] + dir[2] * dir[2]).sqrt();
    if len < 1e-9 {
        return;
    }
    let d = [dir[0] / len, dir[1] / len, dir[2] / len];
    // In-Ebene-Senkrechte zur Kante: cross(normal, dir) liegt in der Ebene und
    // steht senkrecht auf der Kante.
    let mut perp = [
        normal[1] * d[2] - normal[2] * d[1],
        normal[2] * d[0] - normal[0] * d[2],
        normal[0] * d[1] - normal[1] * d[0],
    ];
    let plen = (perp[0] * perp[0] + perp[1] * perp[1] + perp[2] * perp[2]).sqrt();
    if plen < 1e-9 {
        return;
    }
    perp = [perp[0] / plen * half_w, perp[1] / plen * half_w, perp[2] / plen * half_w];
    let p0 = [a[0] - perp[0], a[1] - perp[1], a[2] - perp[2]];
    let p1 = [a[0] + perp[0], a[1] + perp[1], a[2] + perp[2]];
    let p2 = [b[0] + perp[0], b[1] + perp[1], b[2] + perp[2]];
    let p3 = [b[0] - perp[0], b[1] - perp[1], b[2] - perp[2]];
    let mut push = |p: [f32; 3]| {
        out.extend_from_slice(&[p[0], p[1], p[2], color[0], color[1], color[2]]);
    };
    // Zwei Dreiecke: p0,p1,p2 und p0,p2,p3.
    push(p0);
    push(p1);
    push(p2);
    push(p0);
    push(p2);
    push(p3);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::Hatch;

    /// Eine Wand entlang der X-Achse, senkrecht von einer +X-Ebene geschnitten:
    /// die Muster-Id/Winkel/Skalierung der Bauteil-Schraffur muessen in JEDEM
    /// Cap-Vertex an den Positionen 5/6/7 landen (Vertex-Stride = 8).
    #[test]
    fn hatch_muster_id_landet_in_den_cap_vertices() {
        let wall = WallInput {
            top_drop: [0.0, 0.0],
            top_plane: None,
            start: [0.0, 0.0],
            end: [3.0, 0.0],
            thickness: 0.3,
            height: 2.5,
            base_elevation: 0.0,
            color: [0.8, 0.8, 0.8],
            openings: vec![],
            layers: None,
            holes: vec![],
            material_index: None,
            hatch: Some(Hatch {
                pattern: 3, // crosshatch
                angle: 90.0,
                scale: 2.0,
                line_weight: 0.5,
                top_angle: None,
            }),
            cut: None,
            start_cut: None,
            end_cut: None,
        };
        let plane = SectionPlane::looking_plus_x(1.5);
        let verts = build_cut_caps(&plane, &[wall], &[], &[]);

        assert!(!verts.is_empty(), "Schnitt liefert Cap-Geometrie");
        assert_eq!(
            verts.len() % CAP_FLOATS_PER_VERTEX,
            0,
            "Vertexpuffer ist ein Vielfaches des Strides ({CAP_FLOATS_PER_VERTEX})"
        );
        let n = verts.len() / CAP_FLOATS_PER_VERTEX;
        for i in 0..n {
            let base = i * CAP_FLOATS_PER_VERTEX;
            assert_eq!(verts[base + 5], 3.0, "pattern-Id je Vertex");
            assert!(
                (verts[base + 6] - 90.0_f32.to_radians()).abs() < 1e-5,
                "angle in Radiant"
            );
            assert_eq!(verts[base + 7], 2.0, "scale je Vertex");
            assert_eq!(verts[base + 8], 0.5, "line_weight (mm) je Vertex");
        }
    }

    /// Generator-Muster (Id >= 4, hier 4 Daemmschlange): der Shader bekommt Id 0 (Papier), die Linien kommen als
    /// Ribbons aus dem Kern-Generator in den Cut-Linien — mehr Dreiecke als ohne Muster, alle in der Schnittebene.
    #[test]
    fn generator_muster_kommt_als_ribbons() {
        let mk = |pattern: u32| WallInput {
            top_drop: [0.0, 0.0],
            top_plane: None,
            start: [0.0, 0.0],
            end: [3.0, 0.0],
            thickness: 0.3,
            height: 2.5,
            base_elevation: 0.0,
            color: [0.8, 0.8, 0.8],
            openings: vec![],
            layers: None,
            holes: vec![],
            material_index: None,
            hatch: Some(Hatch { pattern, angle: -90.0, scale: 1.0, line_weight: 0.13, top_angle: None }),
            cut: None,
            start_cut: None,
            end_cut: None,
        };
        let plane = SectionPlane::looking_plus_x(1.5);
        let caps = build_cut_caps(&plane, &[mk(4)], &[], &[]);
        assert!(!caps.is_empty());
        for i in 0..caps.len() / CAP_FLOATS_PER_VERTEX {
            assert_eq!(caps[i * CAP_FLOATS_PER_VERTEX + 5], 0.0, "Shader zeichnet kein Muster");
        }
        let plain = build_cut_cap_lines(&plane, &[mk(0)], &[], &[]);
        for pat in [4u32, 6, 7, 8, 9, 10, 11, 12] {
            let lines = build_cut_cap_lines(&plane, &[mk(pat)], &[], &[]);
            assert!(lines.len() > plain.len() + 6 * CUT_LINE_FLOATS_PER_VERTEX * 10, "Muster {pat}: Musterlinien fehlen");
            assert_eq!(lines.len() % CUT_LINE_FLOATS_PER_VERTEX, 0);
        }
        // Diagonale/Kreuz bleiben im Shader (keine Ribbons)
        assert_eq!(build_cut_cap_lines(&plane, &[mk(2)], &[], &[]).len(), plain.len());
    }

    /// Ohne `hatch` faellt jedes Cap-Polygon auf das Diagonalmuster (Id 2,
    /// angle 0, scale 1) zurueck — das reproduziert das fruehere fixe 45°-Muster.
    #[test]
    fn ohne_hatch_fallback_auf_diagonale() {
        let wall = WallInput {
            top_drop: [0.0, 0.0],
            top_plane: None,
            start: [0.0, 0.0],
            end: [3.0, 0.0],
            thickness: 0.3,
            height: 2.5,
            base_elevation: 0.0,
            color: [0.8, 0.8, 0.8],
            openings: vec![],
            layers: None,
            holes: vec![],
            material_index: None,
            hatch: None,
            cut: None,
            start_cut: None,
            end_cut: None,
        };
        let plane = SectionPlane::looking_plus_x(1.5);
        let verts = build_cut_caps(&plane, &[wall], &[], &[]);
        assert!(!verts.is_empty());
        assert_eq!(verts[5], FALLBACK_PATTERN, "Fallback = Diagonale (2)");
        assert_eq!(verts[6], 0.0, "Fallback-Winkel 0");
        assert_eq!(verts[7], 1.0, "Fallback-Skalierung 1");
        assert_eq!(verts[8], FALLBACK_HATCH_LINE_WEIGHT_MM, "Fallback-Musterlinienstaerke 0.13 mm");
    }

    use crate::types::CutBandMeta;

    /// Ein Wand-Band (Prio 50, volle Hoehe) und ein u-deckungsgleiches Decken-Band
    /// (Prio 100) ueberlappen in einem z-Intervall. Nach `build_cut_caps` (das die
    /// Boolean-Dominanz anwendet) darf im Ueberlappungs-z-Intervall KEINE Wand-
    /// Cap-Geometrie mehr liegen — die geometrische Kernaussage von P1, direkt auf
    /// den erzeugten Welt-Vertices geprueft (nicht bloss „laeuft").
    #[test]
    fn build_cut_caps_wendet_dominanz_an_wand_verliert_ueberlappung() {
        // Wand entlang +X bei x in [0,3], Dicke 0.4, volle Hoehe [0,2.5]; Prio 50.
        let wall = WallInput {
            top_drop: [0.0, 0.0],
            top_plane: None,
            start: [0.0, 0.0],
            end: [3.0, 0.0],
            thickness: 0.4,
            height: 2.5,
            base_elevation: 0.0,
            color: [0.8, 0.8, 0.8],
            openings: vec![],
            layers: None,
            holes: vec![],
            material_index: None,
            hatch: Some(Hatch { pattern: 2, angle: 0.0, scale: 1.0, line_weight: 0.13, top_angle: None }),
            cut: Some(CutBandMeta {
                join_priority: Some(50),
                component_id: Some("brick".into()),
                line_color: None,
                line_weight: None,
            }),
            start_cut: None,
            end_cut: None,
        };
        // Decken-Slab, deren Umriss die Wand an der Schnittstelle (x=1.5) ueberdeckt,
        // z in [2.0, 2.4]; Prio 100 (Beton laeuft durch, schneidet die Wand).
        let slab = SlabInput {
            monolith: None,
            outline: vec![[-1.0, -1.0], [4.0, -1.0], [4.0, 1.0], [-1.0, 1.0]],
            z_bottom: 2.0,
            z_top: 2.4,
            color: [0.8, 0.8, 0.8],
            hatch: Some(Hatch { pattern: 1, angle: 0.0, scale: 1.0, line_weight: 0.13, top_angle: None }),
            cut: Some(CutBandMeta {
                join_priority: Some(100),
                component_id: Some("concrete".into()),
                line_color: None,
                line_weight: None,
            }),
        };
        let plane = SectionPlane::looking_plus_x(1.5);
        let verts = build_cut_caps(&plane, &[wall], &[slab], &[]);
        assert!(!verts.is_empty());

        // Die Wand-Caps tragen pattern==2 (diagonal), die Beton-Caps pattern==1
        // (solid). Fuer JEDES Wand-Vertex (pattern 2) muss die Hoehe (v = pos.y,
        // Index 1) AUSSERHALB des Beton-Intervalls [2.0,2.4] liegen.
        let n = verts.len() / CAP_FLOATS_PER_VERTEX;
        let mut wall_verts = 0;
        let mut concrete_verts = 0;
        for i in 0..n {
            let base = i * CAP_FLOATS_PER_VERTEX;
            let y = verts[base + 1];
            let pattern = verts[base + 5];
            if (pattern - 2.0).abs() < 0.5 {
                wall_verts += 1;
                assert!(
                    y <= 2.0 + 1e-3 || y >= 2.4 - 1e-3,
                    "Wand-Cap-Vertex bei v={y} liegt im Beton-z-Intervall (muesste weggeschnitten sein)"
                );
            } else if (pattern - 1.0).abs() < 0.5 {
                concrete_verts += 1;
            }
        }
        assert!(wall_verts > 0, "Wand-Caps vorhanden (ober-/unterhalb des Betons)");
        assert!(concrete_verts > 0, "Beton-Caps vorhanden (voll durchlaufend)");
    }

    /// Reziprok zum vorigen Test (Nutzer-Report 2026-07-08): eine Backstein-WAND
    /// (Prio 50) muss die SCHWAECHEREN Decken-Schichten Estrich (30) und Daemmung
    /// (20) in der u/v-Ueberlappung wegschneiden — wie im 2D-Schnitt. Wir bauen die
    /// Wand als EIN Backstein-Band (Prio 50) und den Boden als zwei duenne Slabs
    /// (Estrich oben, Daemmung darunter), deren z-Intervall die Wand ueberlappt.
    /// Nach der Dominanz darf im Wand-u-Intervall KEINE Estrich-/Daemmung-Cap mehr
    /// liegen (die Wand-Cap dagegen bleibt — Backstein ist dort dominant).
    #[test]
    fn wand_schneidet_schwaechere_decken_schichten() {
        // Backstein-Wand entlang +X, x in [0,3], Dicke 0.4 → u (=y) in [-0.2,0.2],
        // volle Hoehe [0,2.5]; Prio 50, Muster 2 (diagonal).
        let wall = WallInput {
            top_drop: [0.0, 0.0],
            top_plane: None,
            start: [0.0, 0.0],
            end: [3.0, 0.0],
            thickness: 0.4,
            height: 2.5,
            base_elevation: 0.0,
            color: [0.8, 0.8, 0.8],
            openings: vec![],
            layers: None,
            holes: vec![],
            material_index: None,
            hatch: Some(Hatch { pattern: 2, angle: 0.0, scale: 1.0, line_weight: 0.13, top_angle: None }),
            cut: Some(CutBandMeta {
                join_priority: Some(50),
                component_id: Some("brick".into()),
                line_color: None,
                line_weight: None,
            }),
            start_cut: None,
            end_cut: None,
        };
        // Estrich-Slab (Prio 30, Muster 3 crosshatch), z in [1.0,1.06], deckt die
        // Wand in u ab (Umriss ueber y in [-1,1]).
        let screed = SlabInput {
            monolith: None,
            outline: vec![[-1.0, -1.0], [4.0, -1.0], [4.0, 1.0], [-1.0, 1.0]],
            z_bottom: 1.0,
            z_top: 1.06,
            color: [0.8, 0.8, 0.8],
            hatch: Some(Hatch { pattern: 3, angle: 0.0, scale: 1.0, line_weight: 0.13, top_angle: None }),
            cut: Some(CutBandMeta {
                join_priority: Some(30),
                component_id: Some("screed".into()),
                line_color: None,
                line_weight: None,
            }),
        };
        // Daemmung-Slab (Prio 20, Muster 4), z in [0.96,1.0], gleiche u-Deckung.
        let insulation = SlabInput {
            monolith: None,
            outline: vec![[-1.0, -1.0], [4.0, -1.0], [4.0, 1.0], [-1.0, 1.0]],
            z_bottom: 0.96,
            z_top: 1.0,
            color: [0.8, 0.8, 0.8],
            hatch: Some(Hatch { pattern: 4, angle: 0.0, scale: 1.0, line_weight: 0.13, top_angle: None }),
            cut: Some(CutBandMeta {
                join_priority: Some(20),
                component_id: Some("insulation".into()),
                line_color: None,
                line_weight: None,
            }),
        };
        let plane = SectionPlane::looking_plus_x(1.5);
        let verts = build_cut_caps(&plane, &[wall], &[screed, insulation], &[]);
        assert!(!verts.is_empty());

        // Wand-u-Intervall (=y) ist [-0.2,0.2]. Fuer JEDES Estrich- (Muster 3) oder
        // Daemmung-Vertex (Muster 4) muss u AUSSERHALB [-0.2,0.2] liegen — sonst hat
        // der Backstein die schwaechere Schicht dort NICHT weggeschnitten.
        let n = verts.len() / CAP_FLOATS_PER_VERTEX;
        let mut weak_verts = 0;
        for i in 0..n {
            let base = i * CAP_FLOATS_PER_VERTEX;
            let u = verts[base]; // pos.x = y-Welt (Schnitt entlang +X)
            let pattern = verts[base + 5];
            if (pattern - 3.0).abs() < 0.5 || (pattern - 4.0).abs() < 0.5 {
                weak_verts += 1;
                assert!(
                    u <= -0.2 + 1e-3 || u >= 0.2 - 1e-3,
                    "Estrich/Daemmung-Vertex bei u={u} liegt im Backstein-u-Intervall \
                     [-0.2,0.2] (muesste weggeschnitten sein)"
                );
            }
        }
        assert!(weak_verts > 0, "Estrich/Daemmung-Caps existieren (ausserhalb der Wand)");
    }

    /// P2: je ueberlebendem Cut-Cap-Rechteck entstehen 4 Umriss-Kanten als Ribbon-
    /// Dreiecke (4 Kanten * 6 Vertices = 24 Vertices je Rechteck), und Farbe +
    /// Strichstaerke kommen aus dem Band-Stil durch (Farbe je Vertex, Staerke ueber
    /// die Ribbon-Breite messbar).
    #[test]
    fn build_cut_cap_lines_kantenzahl_und_stil() {
        let color = [0.2, 0.4, 0.9];
        let wall = WallInput {
            top_drop: [0.0, 0.0],
            top_plane: None,
            start: [0.0, 0.0],
            end: [3.0, 0.0],
            thickness: 0.4,
            height: 2.5,
            base_elevation: 0.0,
            color: [0.8, 0.8, 0.8],
            openings: vec![],
            layers: None,
            holes: vec![],
            material_index: None,
            hatch: None,
            cut: Some(CutBandMeta {
                join_priority: Some(50),
                component_id: Some("brick".into()),
                line_color: Some(color),
                line_weight: Some(2.0),
            }),
            start_cut: None,
            end_cut: None,
        };
        let plane = SectionPlane::looking_plus_x(1.5);
        let verts = build_cut_cap_lines(&plane, &[wall.clone()], &[], &[]);
        assert!(!verts.is_empty());
        assert_eq!(
            verts.len() % CUT_LINE_FLOATS_PER_VERTEX,
            0,
            "Vielfaches des Cut-Linien-Strides"
        );
        // EIN Rechteck (keine Dominanz-Subtraktion, lone band) -> 4 Kanten * 6 = 24 Vertices.
        assert_eq!(
            verts.len() / CUT_LINE_FLOATS_PER_VERTEX,
            24,
            "4 Kanten * 6 Vertices je Ribbon"
        );
        // Farbe je Vertex aus dem Stil (Index 3/4/5).
        let n = verts.len() / CUT_LINE_FLOATS_PER_VERTEX;
        for i in 0..n {
            let base = i * CUT_LINE_FLOATS_PER_VERTEX;
            assert!((verts[base + 3] - color[0]).abs() < 1e-6);
            assert!((verts[base + 4] - color[1]).abs() < 1e-6);
            assert!((verts[base + 5] - color[2]).abs() < 1e-6);
        }

        // Strichstaerke kommt durch: eine DICKERE Linie erzeugt ein breiteres Ribbon.
        // Messbar an der (u,v)-Ausdehnung senkrecht zur Kante — hier ueber die
        // world-Bounding-Box-Hoehe der beiden horizontalen Kanten (v-Ausdehnung der
        // gesamten Geometrie) im Vergleich duenn vs. dick.
        let bbox_y = |vs: &[f32]| -> f32 {
            let n = vs.len() / CUT_LINE_FLOATS_PER_VERTEX;
            let mut lo = f32::INFINITY;
            let mut hi = f32::NEG_INFINITY;
            for i in 0..n {
                let y = vs[i * CUT_LINE_FLOATS_PER_VERTEX + 1];
                lo = lo.min(y);
                hi = hi.max(y);
            }
            hi - lo
        };
        let mut thin = wall.clone();
        thin.cut = Some(CutBandMeta {
            join_priority: Some(50),
            component_id: Some("brick".into()),
            line_color: Some(color),
            line_weight: Some(0.2),
        });
        let thin_verts = build_cut_cap_lines(&plane, &[thin], &[], &[]);
        assert!(
            bbox_y(&verts) > bbox_y(&thin_verts) + 1e-4,
            "dickere Strichstaerke -> groessere v-Ausdehnung der Ribbons"
        );
    }
}
