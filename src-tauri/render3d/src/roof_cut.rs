//! Schnitt einer GENEIGTEN Dach-Schicht (`RoofLayerInput`) mit einer vertikalen
//! `SectionPlane` — der Dach-Ergänzungspfad zum Prisma-Ansatz in `section.rs`.
//!
//! ## Warum ein eigener Pfad (nicht `Prism`)
//!
//! `section.rs`s gesamte Herleitung ("jedes Bauteil ist ein 2D-Grundriss,
//! VERTIKAL extrudiert über `[z0,z1]`, daher ist der Schnitt mit einer
//! vertikalen Ebene immer ein Rechteck") gilt für Wand und Decke, aber NICHT
//! für ein Dach: eine Dachfläche ist ein Polygon, extrudiert entlang ihrer
//! EIGENEN (i. A. schrägen) Flächennormalen. Da die Extrusionsrichtung nicht
//! mehr parallel zur Höhenachse ist, ist der Schnitt mit einer vertikalen
//! Ebene kein Rechteck mehr, sondern ein allgemeineres Polygon (i. d. R. ein
//! Parallelogramm/Trapez) — der Rechteck-Kurzschluss aus `section.rs` trägt
//! hier nicht.
//!
//! ## Herleitung
//!
//! Die Schicht ist die Menge `{ p + s*d : p ∈ Polygon, s ∈ [0,1] }` für die
//! Extrusionsrichtung `d = -thickness * normal` (Schicht wächst nach INNEN,
//! weg von `normal`, s. `RoofLayerInput::normal`). Ein Punkt liegt GENAU DANN
//! auf der Schnittebene (Punkt `plane.point`, Normale `N`), wenn
//!
//! ```text
//! dot(p + s*d - plane.point, N) = 0
//! <=> s(p) = -dot(p - plane.point, N) / dot(d, N)                     (*)
//! ```
//!
//! `dot(p - plane.point, N)` ist LINEAR in `p` (das Polygon liegt in einer
//! Ebene), `dot(d, N)` eine Konstante — also ist `s(p)` eine AFFINE Funktion
//! von `p`. Der Schnitt-Querschnitt ist damit exakt die Teilmenge
//! `{ p ∈ Polygon : s(p) ∈ [0,1] }` — eine Poly-Clip-Aufgabe des Polygons
//! gegen ZWEI Halbebenen im eigenen Parameterraum (klassisches Sutherland-
//! Hodgman, hier direkt auf den 3D-Punkten mit dem Skalarfeld `s`). Jeder
//! resultierende Clip-Punkt `p_i` liefert über (*) sein `s(p_i)`, und
//! `p_i + s(p_i)*d` ist der tatsächliche 3D-Schnittpunkt (liegt exakt auf der
//! Ebene, keine weitere „Kappung" nötig — Clip und Schnitt fallen zusammen).
//!
//! Degeneriert, wenn `dot(d, N) ≈ 0` (Extrusionsrichtung [nahezu] parallel
//! zur Schnittebene — die Dachfläche wird „auf Kante" geschnitten): `s(p)`
//! ist dann nicht sinnvoll bestimmbar, `cut_roof_layer` liefert konservativ
//! `None` (kein Cut-Polygon), analog zur Wand-Sonderbehandlung „hinreichend
//! parallel" in `section.rs`.
//!
//! ANNAHME: die Eingabe-Polygone (Dachflächen aus `roofGeometry`) sind
//! EINFACH und (praktisch immer) KONVEX — bei einem nicht-konvexen Polygon
//! könnte der Schnitt in mehrere getrennte Stücke zerfallen, was ein
//! einzelner Sutherland-Hodgman-Durchlauf nicht korrekt abbildet. Für die in
//! dieser App erzeugten Dachformen (flach/pult/sattel/walm/mansarde/zelt,
//! stets Rechtecke/Trapeze) ist das gegeben.

use crate::math;
use crate::section::{ComponentKind, ComponentRef, CutPolygon, SectionPlane};
use crate::types::RoofLayerInput;

/// Sutherland-Hodgman-Clip eines (räumlichen) Polygons gegen EINE Halbebene im
/// Sinne eines Skalarfelds `f`: behält die Punkte mit `f(p) >= threshold`.
/// Kanten, die die Grenze `f(p) = threshold` queren, werden per LINEARER
/// Interpolation geschnitten — exakt, weil `f` laut Konstruktion AFFIN
/// entlang jeder Kante ist (s. Moduldoc).
fn clip_half_plane(pts: &[[f32; 3]], f: impl Fn([f32; 3]) -> f32, threshold: f32) -> Vec<[f32; 3]> {
    let n = pts.len();
    if n == 0 {
        return Vec::new();
    }
    let inside = |p: [f32; 3]| f(p) - threshold >= -1e-6;
    let intersect = |a: [f32; 3], b: [f32; 3]| -> [f32; 3] {
        let fa = f(a) - threshold;
        let fb = f(b) - threshold;
        let denom = fa - fb;
        let t = if denom.abs() > 1e-9 { fa / denom } else { 0.0 };
        [
            a[0] + (b[0] - a[0]) * t,
            a[1] + (b[1] - a[1]) * t,
            a[2] + (b[2] - a[2]) * t,
        ]
    };
    let mut out = Vec::with_capacity(n + 2);
    for i in 0..n {
        let prev = pts[(i + n - 1) % n];
        let cur = pts[i];
        let prev_in = inside(prev);
        let cur_in = inside(cur);
        if prev_in && cur_in {
            out.push(cur);
        } else if prev_in && !cur_in {
            out.push(intersect(prev, cur));
        } else if !prev_in && cur_in {
            out.push(intersect(prev, cur));
            out.push(cur);
        }
    }
    out
}

/// Modell `(x, y, z=Höhe)` -> Welt `(x, z, y)` — dieselbe Konvention wie
/// `MeshInput`/`mesh.rs` (s. `types.rs`-Moduldoc). `RoofLayerInput::polygon`/
/// `normal` kommen UNVERÄNDERT aus der TS-seitigen Dachflächen-Berechnung
/// (`toWalls3d/roofs.ts::planeNormalUp`/`g.planes`, dieselben Modell-Punkte,
/// aus denen auch das Render-Mesh gebaut wird) — die TS-Seite rechnet also
/// NICHT selbst nach Welt um (anders als ursprünglich entworfen), sondern
/// reicht die Rohdaten 1:1 durch, konsistent mit `WallInput`/`SlabInput`/
/// `MeshInput`, die den Modell->Welt-Wechsel ebenfalls Rust-seitig machen.
fn to_world(p: [f32; 3]) -> [f32; 3] {
    [p[0], p[2], p[1]]
}

/// Schneidet EINE Dach-Schicht mit einer Schnittebene. `None`, wenn die Ebene
/// die Schicht nicht trifft, das Polygon entartet ist (<3 Punkte, Dicke ≈ 0)
/// oder die Extrusion (fast) parallel zur Ebene liegt (s. Moduldoc).
pub fn cut_roof_layer(layer: &RoofLayerInput, plane: &SectionPlane) -> Option<CutPolygon> {
    if layer.polygon.len() < 3 || layer.thickness.abs() < 1e-6 {
        return None;
    }
    let polygon: Vec<[f32; 3]> = layer.polygon.iter().map(|&p| to_world(p)).collect();
    let normal = to_world(layer.normal);
    let d = [
        -normal[0] * layer.thickness,
        -normal[1] * layer.thickness,
        -normal[2] * layer.thickness,
    ];
    let dn = math::dot(d, plane.normal);
    if dn.abs() < 1e-6 {
        return None;
    }
    let s_of = |p: [f32; 3]| -> f32 { -math::dot(math::sub(p, plane.point), plane.normal) / dn };

    let clipped = clip_half_plane(&polygon, &s_of, 0.0);
    // Zweiter Clip gegen s <= 1: als "-s >= -1", damit dieselbe `inside`-
    // Konvention (>= threshold) wiederverwendet werden kann.
    let clipped = clip_half_plane(&clipped, |p| -s_of(p), -1.0);
    if clipped.len() < 3 {
        return None;
    }

    let pts: Vec<[f32; 2]> = clipped
        .iter()
        .map(|&p| {
            let s = s_of(p).clamp(0.0, 1.0);
            let cut_p = [p[0] + d[0] * s, p[1] + d[1] * s, p[2] + d[2] * s];
            plane.project(cut_p)
        })
        .collect();

    Some(CutPolygon {
        component: ComponentRef {
            kind: ComponentKind::Roof,
            index: 0, // vom Aufrufer (`cut_section`) auf den echten Array-Index gesetzt
        },
        color: layer.color,
        hatch: layer.hatch,
        pts,
        cut: layer.cut.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::CutBandMeta;

    /// Pultdach-artige Fläche, in MODELL-Metern `(x, y, z=Höhe)` — wie
    /// `RoofLayerInput` es erwartet (`cut_roof_layer` macht den Modell->Welt-
    /// Wechsel selbst, s. `to_world`). Traufe bei Modell-X=0/Höhe=0, First bei
    /// Modell-X=4/Höhe=3, First läuft entlang Modell-Y (Grundriss-Tiefe) — nach
    /// dem Wechsel `(x,y,z)->world(x,z,y)` entsteht exakt die Fläche
    /// `P0=(0,0,0), P1=(0,0,5)‥First entlang Welt-Z` aus einer früheren Version
    /// dieses Tests (per Hand nachgerechnet): ein ebenes Rechteck, das eine
    /// vertikale Schnittebene entlang Welt-X (z. B. `looking_plus_x`) ECHT quert
    /// (Welt-X- UND Welt-Y-Komponente der Normalen ungleich null) — anders als
    /// eine Ebene, die nur die Firstrichtung variiert (die wäre parallel zur
    /// Extrusion, s. `extrusion_parallel_zur_ebene_liefert_none_statt_panik`).
    fn sloped_layer(thickness: f32, cut: Option<CutBandMeta>) -> RoofLayerInput {
        RoofLayerInput {
            polygon: vec![
                [0.0, 0.0, 0.0],
                [0.0, 5.0, 0.0],
                [4.0, 5.0, 3.0],
                [4.0, 0.0, 3.0],
            ],
            normal: math::normalize([-15.0, 0.0, 20.0]),
            thickness,
            color: [0.7, 0.4, 0.3],
            hatch: None,
            cut,
        }
    }

    #[test]
    fn schnitt_mittig_liefert_ein_viereck_auf_der_ebene() {
        let layer = sloped_layer(0.1, None);
        // Vertikale Schnittebene bei Grundriss-X = 2 (Blick +X) — schneidet die
        // Dachfläche in der Mitte (X läuft 0..4 über die Flächenbreite).
        let plane = SectionPlane::looking_plus_x(2.0);
        let poly = cut_roof_layer(&layer, &plane).expect("Ebene trifft die Schicht");
        assert_eq!(poly.pts.len(), 4, "Schnitt eines Quaders/Prismas ist ein Viereck");
        // Alle Punkte liegen wirklich AUF der Ebene (u,v -> Welt -> Tiefe 0 pruefen).
        for &[u, v] in &poly.pts {
            let world = [
                plane.point[0] + u * plane.u_axis()[0],
                v,
                plane.point[2] + u * plane.u_axis()[2],
            ];
            assert!(plane.depth(world).abs() < 1e-4, "Punkt muss auf der Ebene liegen");
        }
    }

    #[test]
    fn schnitt_ausserhalb_der_flaeche_liefert_none() {
        let layer = sloped_layer(0.1, None);
        let plane = SectionPlane::looking_plus_x(10.0); // weit ausserhalb X in [0,4]
        assert!(cut_roof_layer(&layer, &plane).is_none());
    }

    #[test]
    fn dickere_schicht_liefert_ein_breiteres_schnitt_viereck() {
        // Dicke wirkt entlang der (schrägen) Normalen -> bei gleicher X-Schnittposition
        // deckt eine dickere Schicht eine groessere (u,v)-Spanne ab.
        let plane = SectionPlane::looking_plus_x(2.0);
        let thin = cut_roof_layer(&sloped_layer(0.05, None), &plane).unwrap();
        let thick = cut_roof_layer(&sloped_layer(0.3, None), &plane).unwrap();
        let spread = |poly: &CutPolygon| -> f32 {
            let vs: Vec<f32> = poly.pts.iter().map(|p| p[1]).collect();
            vs.iter().cloned().fold(f32::MIN, f32::max) - vs.iter().cloned().fold(f32::MAX, f32::min)
        };
        assert!(spread(&thick) > spread(&thin));
    }

    #[test]
    fn schnittstil_und_farbe_wandern_ins_cutpolygon() {
        let cut = CutBandMeta {
            join_priority: None,
            component_id: None,
            line_color: Some([0.1, 0.2, 0.3]),
            line_weight: Some(0.5),
        };
        let layer = sloped_layer(0.1, Some(cut));
        let plane = SectionPlane::looking_plus_x(2.0);
        let poly = cut_roof_layer(&layer, &plane).unwrap();
        assert_eq!(poly.color, [0.7, 0.4, 0.3]);
        let meta = poly.cut.expect("cut-Metadaten muessen erhalten bleiben");
        assert_eq!(meta.line_color, Some([0.1, 0.2, 0.3]));
        assert_eq!(meta.line_weight, Some(0.5));
        // Bewusst KEINE join_priority -> nimmt nicht an subtract_dominant_bands teil.
        assert_eq!(meta.join_priority, None);
    }

    #[test]
    fn extrusion_parallel_zur_ebene_liefert_none_statt_panik() {
        // Degenerierter Fall: die Schnittebene so waehlen, dass ihre Normale
        // senkrecht auf der (WELT-)Extrusionsrichtung `d = -normal*thickness`
        // steht (dot(d, plane.normal) ~ 0) -> `s(p)` waere nicht bestimmbar.
        // `layer.normal` ist Modell-Raum -> erst `to_world`, wie `cut_roof_layer`
        // es intern auch macht.
        let layer = sloped_layer(0.1, None);
        let world_normal = to_world(layer.normal);
        let d = [-world_normal[0], -world_normal[1], -world_normal[2]];
        // `n` per Kreuzprodukt aus `d` und der Weltvertikalen konstruiert: per
        // Definition senkrecht zu `d`, ausserdem vertikal-frei genug fuer eine
        // sinnvolle Schnittebene (Moduldoc: nur vertikale Ebenen).
        let n = math::cross([0.0, 1.0, 0.0], d);
        let plane = SectionPlane::new([2.0, 0.0, 0.0], n);
        assert!(cut_roof_layer(&layer, &plane).is_none());
    }
}
