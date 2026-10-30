// Mesh-Erzeugung: extrudiert geflachte Waende zu Quader-Meshes. GPU-frei, headless
// per `cargo test` pruefbar (Muster: render2d/tessellate).
//
// Grundlage ist der Wandband-Ansatz aus src/model/geometry.ts (`wallCorners`):
//   u = normalize(end - start)          Achsenrichtung im Grundriss
//   n = leftNormal(u) = (-u.y, u.x)      Links-Normale (90 Grad CCW)
//   Band-Ecken = start/end +/- n * thickness/2   (CCW-Umlauf)
// Diese 2D-Band-Ecken werden nach world abgebildet (XZ-Ebene) und entlang +Y von
// `base_elevation` bis `base_elevation + height` extrudiert — analog zur
// three.js-`ExtrudeGeometry`, die den 2D-`clippedBand` hochzieht (Viewport3D.tsx
// `addLayerPrism`).
//
// ECKEN-VERSCHNEIDUNG (Gehrung): `compute_wall_miters` berechnet — analog zum
// Web-Pendant `src/model/joins.ts::computeJoins` + `geometry.ts::clippedBand` —
// fuer jede Wand die Gehrungslinien an ihren ECHTEN Achsenenden, rein aus der
// Wandkonnektivitaet (Endpunkte, die sich bei genau ZWEI, nicht-parallelen
// Waenden treffen). Anders als der Web-Pfad braucht das HIER keine eigenen
// Eingabefelder: die Berechnung laeuft direkt auf `WallInput` (Start/Ende/
// Dicke), robust auch gegenueber der Teilquader-Zerlegung an Oeffnungen (siehe
// unten) — zwei Teilstuecke DERSELBEN Wand haben stets dieselbe (parallele)
// Achsrichtung, ihre "Gehrung" waere kollinear und wird automatisch verworfen
// (siehe `miter_line`). Mehrgeschossige Modelle mit deckungsgleichem Grundriss
// werden durch einen Hoehen-Ueberlappungstest (`cluster_by_height_overlap`)
// sauber getrennt (kein Verschneiden ueber Geschosse hinweg). T-/X-Stoesse
// (mehr als zwei Enden an einem Knoten) bleiben — wie im Web-Pendant —
// rechtwinklig. Das Schnitt-Modul (`section.rs`) nutzt fuer die WAND-CUT-Polygone
// denselben gehrten Fussabdruck (`wall_mitered_footprints`), damit ein Schnitt an
// einer Wandecke genau EINEN verschnittenen Querschnitt liefert statt zweier
// ueberlappender Rechtecke; seine Verdeckungs-Naeherung bleibt achsparallel
// (siehe dessen Moduldoc).
//
// SCHICHTEN (`WallInput::layers`): mehrschichtige Waende (Putz/Daemmung/
// Mauerwerk/...) werden nicht als ein Vollkoerper, sondern als je EIN Prisma
// pro Schicht extrudiert, quer zur Gesamtdicke gestapelt (gleiche Idee wie
// Viewport3D.tsx `addWallMeshes`: `off` laeuft ueber die Schichtdicken).
// Jede Schicht nutzt DASSELBE gehrte Fussabdruck-Band wie Gap 1 (nur mit ihrem
// eigenen Dicken-Versatz), sodass auch mehrschichtige Waende an Ecken saeuberlich
// stossen. Fehlt `layers` (None/leer), wird ein synthetisches Einzel-Layer aus
// `thickness`/`color` gebildet — bitgenau dasselbe Ergebnis wie zuvor.
//
// OEFFNUNGEN (Tueren/Fenster, `WallInput::openings`): eine Wand mit Oeffnungen
// wird NICHT als ein Vollkoerper-Quader extrudiert, sondern in mehrere
// Teil-Quader zerlegt — volle Hoehe zwischen Oeffnungen (Pfeiler), Bruestung
// unterhalb und Sturz oberhalb jeder Oeffnung (`wall_solid_segments`). Das ist
// exakt dieselbe Bruestungs-/Sturz-Zerlegung wie `section::wall_cut_rectangles`
// fuer die Schnitt-Cut-Polygone (gemeinsame Basis: `crate::openings::
// split_range_by_voids`), nur direkt in Wandachsen-Metern statt in der
// Projektions-u-Achse einer Schnittebene — damit zeigt die 3D-Vollansicht
// (`?engine=wasm`) dieselbe Oeffnung wie der Schnitt. Die Gehrung (siehe oben)
// greift dabei NUR an Teilstuecken, die tatsaechlich an ein echtes Wandende
// grenzen (Achsposition 0 bzw. Wandlaenge) — innere Teilstuecke (Laibungen an
// Oeffnungen) bleiben immer rechtwinklig.
//
// KOORDINATEN: model [x, y] -> world (x, elevation, y). Also Grundriss in der
// XZ-Ebene, Extrusion entlang +Y (Y-up), exakt wie Viewport3D.tsx:
//   "Modell (x,y,z) -> Three (x, z, y)  (Z = Hoehe nach oben)".

use std::collections::HashMap;

use crate::openings::{split_range_by_voids, MIN_SPAN};
use crate::types::{
    Hole, Mesh, MeshInput, MeshKind, Opening, Point2, Rgb, SlabInput, TexturedMesh, WallInput,
    WallLayer, FLOATS_PER_VERTEX, TEXTURED_FLOATS_PER_VERTEX,
};

/// Ein Quader-Mesh besteht aus 6 Seiten (Boden, Deckel, 4 Waende) zu je 2
/// Dreiecken = 12 Dreiecke, mit flachen Normalen also 24 Vertices (je Seite 4,
/// keine geteilten Normalen). Konstanten dokumentieren die Test-Erwartung.
pub const VERTS_PER_BOX: usize = 24;
pub const INDICES_PER_BOX: usize = 36;

/// 2D-Einheits-Links-Normale zur Richtung (end - start), wie `leftNormal` im Web:
/// n = (-u.y, u.x). Liefert (0,0) bei Nulllaenge.
fn left_normal(start: Point2, end: Point2) -> Point2 {
    let dx = end[0] - start[0];
    let dy = end[1] - start[1];
    let len = (dx * dx + dy * dy).sqrt();
    if len < 1e-9 {
        return [0.0, 0.0];
    }
    [-dy / len, dx / len]
}

/// Extrudiert EINE Wand (ohne Kenntnis von Nachbarn, also stets rechtwinklige
/// Enden) zu einem oder mehreren Quader-Meshes. Fuer Szenen mit mehreren
/// Waenden bitte `build_walls_mesh`/`build_model_mesh` nutzen — die berechnen
/// zuerst die Eck-Gehrung ueber alle Waende (siehe `compute_wall_miters`) und
/// wenden sie hier mit an. Diese Funktion bleibt der einfache Einzel-Wand-
/// Einstieg (u. a. fuer bestehende Tests) und entspricht exakt dem Aufruf mit
/// leeren Gehrungen.
pub fn extrude_wall(mesh: &mut Mesh, wall: &WallInput) {
    extrude_wall_with_miters(mesh, wall, WallMiters::default());
}

/// Wie `extrude_wall`, aber mit den (ggf. leeren) Gehrungslinien an den
/// echten Wandenden. Ohne Oeffnungen und ohne `layers` entsteht wie zuvor
/// GENAU ein Quader je Wand (`VERTS_PER_BOX`/`INDICES_PER_BOX`); mit
/// Oeffnungen wird die Wand zuerst in Achsen-Teilstuecke (Pfeiler/Bruestung/
/// Sturz) zerlegt, mit `layers` zusaetzlich in Schicht-Baender quer zur
/// Dicke — siehe Moduldoc.
fn extrude_wall_with_miters(mesh: &mut Mesh, wall: &WallInput, miters: WallMiters) {
    let n = left_normal(wall.start, wall.end);
    // Degenerierte Wand (Start == Ende) ueberspringen.
    if n == [0.0, 0.0] {
        return;
    }
    let dx = wall.end[0] - wall.start[0];
    let dy = wall.end[1] - wall.start[1];
    let length = (dx * dx + dy * dy).sqrt();

    let z0 = wall.base_elevation;
    let z1 = wall.base_elevation + wall.height;
    // Mit echten Loechern (`holes`) wird die Wand NICHT an Oeffnungen segmentiert,
    // sondern als EIN voller Achsen-Abschnitt extrudiert; die Loecher stanzt
    // `extrude_layer_segment_with_holes` in die Langseiten (holes/openings
    // schliessen sich aus, siehe `types::WallInput::holes`).
    let has_holes = !wall.holes.is_empty();
    let segments = if has_holes {
        vec![(0.0, length, z0, z1)]
    } else {
        wall_solid_segments(length, &wall.openings, z0, z1)
    };

    // Schicht-Stapel: ohne `layers` (oder leer) EIN synthetisches Layer aus
    // der Gesamtdicke/-Farbe — bitgenau das bisherige Vollkoerper-Verhalten.
    let synthetic;
    let layers: &[WallLayer] = match &wall.layers {
        Some(ls) if !ls.is_empty() => ls.as_slice(),
        _ => {
            synthetic = [WallLayer {
                thickness: wall.thickness,
                color: wall.color,
            }];
            &synthetic
        }
    };

    // Schichten von der +n-Seite (offA = +Gesamtdicke/2) zur -n-Seite stapeln,
    // damit offA stets > offB gilt — exakt die Konvention, unter der die
    // bisherige Ecken-/Flankennormalen-Herleitung (siehe `extrude_layer_segment`)
    // gilt. Fuer das synthetische Einzel-Layer ergibt sich offA=+h, offB=-h wie
    // zuvor.
    let total: f32 = layers.iter().map(|l| l.thickness).sum();
    let mut off_a = total * 0.5;
    for layer in layers {
        let off_b = off_a - layer.thickness;
        for &(a0, a1, y0, y1) in &segments {
            // Gehrung nur an Teilstuecken, die tatsaechlich an ein echtes
            // Wandende grenzen (innere Laibungs-Teilstuecke bleiben eckig).
            let start_cut = if a0 <= 1e-6 { miters.start } else { None };
            let end_cut = if a1 >= length - 1e-6 { miters.end } else { None };
            if has_holes {
                // Voller Achsen-Abschnitt (a0=0, a1=length) mit echten Loechern
                // in den Langseiten — pro Schicht-Band dieselben Loecher (quer
                // gestapelt bilden ihre Laibungen die volle Loch-Tiefe).
                extrude_layer_segment_with_holes(
                    mesh, wall, n, length, y0, y1, off_a, off_b, start_cut, end_cut, layer.color,
                    &wall.holes,
                );
            } else {
                let drop = if segments.len() == 1 { wall.top_drop } else { [0.0, 0.0] };
                let plane = if segments.len() == 1 { wall.top_plane } else { None };
                extrude_layer_segment(
                    mesh, wall, n, length, a0, a1, y0, y1, drop, plane, off_a, off_b, start_cut, end_cut,
                    layer.color,
                );
            }
        }
        off_a = off_b;
    }
}

/// Zerlegt eine Wandachse (`0..length`, volle Hoehe `[z0,z1]`) an ihren
/// `openings` in Voll-/Bruestungs-/Sturz-Rechtecke `(achse0, achse1, y0, y1)` —
/// direkt in Wandachsen-Metern, keine Schnittebenen-Projektion noetig (anders
/// als `section::wall_cut_rectangles`, das dieselbe Zerlegung fuer eine
/// Cut-Ebenen-u-Achse braucht). Ohne Oeffnungen (oder wenn alle ausserhalb
/// `[0,length]` liegen) liefert das das eine Vollstueck `[0,length]x[z0,z1]`
/// (Regressionsfall, identisch zur bisherigen Vollkoerper-Extrusion).
fn wall_solid_segments(
    length: f32,
    openings: &[Opening],
    z0: f32,
    z1: f32,
) -> Vec<(f32, f32, f32, f32)> {
    if openings.is_empty() {
        return vec![(0.0, length, z0, z1)];
    }
    let mut voids: Vec<(f32, f32, &Opening)> = Vec::new();
    for op in openings {
        let from = op.from.max(0.0);
        let to = op.to.min(length);
        if to - from > MIN_SPAN {
            voids.push((from, to, op));
        }
    }
    split_range_by_voids(0.0, length, z0, z1, voids)
}

/// Punkt entlang der Wandachse bei Achsen-Position `a` (Meter ab `wall.start`),
/// linear zwischen `wall.start` und `wall.end` interpoliert.
fn axis_point(wall: &WallInput, length: f32, a: f32) -> Point2 {
    if length < 1e-9 {
        return wall.start;
    }
    let t = a / length;
    [
        wall.start[0] + (wall.end[0] - wall.start[0]) * t,
        wall.start[1] + (wall.end[1] - wall.start[1]) * t,
    ]
}

/// Extrudiert EIN Schicht-Achsen-Teilstueck (Achse `[a0,a1]`, Hoehe `[y0,y1]`,
/// Dicken-Versatz `[off_a,off_b]` gegen die Achse entlang `n`) einer Wand zu
/// einem Quader-Mesh und haengt ihn an `mesh` an. Fuer `a0=0, a1=length,
/// y0=base_elevation, y1=base_elevation+height, off_a=+thickness/2,
/// off_b=-thickness/2` und ohne Gehrung (`start_cut`/`end_cut` beide `None`)
/// ist das exakt die bisherige Vollkoerper-Extrusion (Regressionsfall).
///
/// GEHRUNG: ist `start_cut`/`end_cut` gesetzt, werden die jeweiligen Band-Ecken
/// NICHT rechtwinklig bei `a0`/`a1` gekappt, sondern mit der Gehrungslinie
/// verschnitten (analog `clippedBand` im Web) — siehe `compute_wall_miters`.
/// Die beiden End-Kappenflaechen bleiben dabei planar (siehe Beweis im
/// Moduldoc von `compute_wall_miters`), ihre Normale wird deshalb geometrisch
/// aus den tatsaechlichen Kantenvektoren hergeleitet (`quad_normal`) statt aus
/// der festen Achsrichtung — das liefert im rechtwinkligen Fall exakt dieselbe
/// Normale wie zuvor UND bleibt bei einer schraegen Gehrung korrekt.
///
/// Aufbau: die vier Grundriss-Ecken des Bandes (CCW) bilden das Deckel-Rechteck.
/// Boden = gleiche XZ auf `y0`, Deckel = auf `y1`. Jede der sechs Seiten bekommt
/// eigene Vertices mit ihrer (nach aussen zeigenden) Flaechen-Normale — daher
/// flaches Shading und korrektes Backface-Culling.
#[allow(clippy::too_many_arguments)]
fn extrude_layer_segment(
    mesh: &mut Mesh,
    wall: &WallInput,
    n: Point2,
    length: f32,
    a0: f32,
    a1: f32,
    y0: f32,
    y1: f32,
    top_drop: [f32; 2],
    top_plane: Option<[f32; 3]>,
    off_a: f32,
    off_b: f32,
    start_cut: Option<MiterLine>,
    end_cut: Option<MiterLine>,
    color: Rgb,
) {
    let p0 = axis_point(wall, length, a0);
    let p1 = axis_point(wall, length, a1);

    // Achsenrichtung der GESAMTEN Wand (fuer Gehrungs-Schnitt und Kappen) —
    // konstant ueber alle Teilstuecke, unabhaengig von `a0`/`a1`.
    let ux = wall.end[0] - wall.start[0];
    let uz = wall.end[1] - wall.start[1];
    let ul = (ux * ux + uz * uz).sqrt().max(1e-9);
    let u: Point2 = [ux / ul, uz / ul];

    // Band-Eckpunkte, ggf. an der Gehrungslinie verschnitten statt rechtwinklig
    // bei a0/a1 gekappt (siehe Moduldoc oben / `clippedBand` im Web).
    let off = |p: Point2, s: f32| -> Point2 { [p[0] + n[0] * s, p[1] + n[1] * s] };
    let clip = |base: Point2, cut: Option<MiterLine>| -> Point2 {
        match cut {
            None => base,
            Some(c) => line_intersect_2(base, u, c.point, c.dir).unwrap_or(base),
        }
    };
    let g0 = clip(off(p0, off_a), start_cut);
    let g1 = clip(off(p1, off_a), end_cut);
    let g2 = clip(off(p1, off_b), end_cut);
    let g3 = clip(off(p0, off_b), start_cut);

    // world-Position aus Grundriss-XZ + Hoehe: (x, y, z=grundriss.y).
    let w = |g: Point2, y: f32| -> [f32; 3] { [g[0], y, g[1]] };

    // Acht Quader-Ecken (b* = Boden auf y0, t* = Deckel auf y1).
    let b0 = w(g0, y0);
    let b1 = w(g1, y0);
    let b2 = w(g2, y0);
    let b3 = w(g3, y0);
    // Schräge Oberkante: Absenkung linear über die ganze Wandachse (`a0`/`a1` sind
    // Positionen auf ihr). Planar, weil g0/g3 und g1/g2 jeweils dieselbe Höhe haben.
    let drop_at = |a: f32| -> f32 {
        let t = if length > 1e-9 { (a / length).clamp(0.0, 1.0) } else { 0.0 };
        top_drop[0] + (top_drop[1] - top_drop[0]) * t
    };
    let (ya, yb) = (y1 - drop_at(a0), y1 - drop_at(a1));
    // Ebene Oberkante ([G2]): jede Ecke auf der Dach-Unterkante (auch quer über die Dicke).
    let top_y = |g: Point2, fallback: f32| -> f32 {
        match top_plane {
            Some(p) => p[0] + p[1] * (g[0] - wall.start[0]) + p[2] * (g[1] - wall.start[1]),
            None => fallback,
        }
    };
    let t0 = w(g0, top_y(g0, ya));
    let t1 = w(g1, top_y(g1, yb));
    let t2 = w(g2, top_y(g2, yb));
    let t3 = w(g3, top_y(g3, ya));

    // Sechs Seiten als Quads (Ecken CCW von aussen gesehen -> Normale zeigt raus).
    // Deckel oben (+Y): t0,t1,t2,t3 von oben CCW.
    let top_normal = if ya == yb && top_plane.is_none() { [0.0, 1.0, 0.0] } else { quad_normal(t0, t1, t3) };
    push_quad(mesh, t0, t1, t2, t3, top_normal, color);
    // Boden unten (-Y): b0,b3,b2,b1 (von unten gesehen CCW).
    push_quad(mesh, b0, b3, b2, b1, [0.0, -1.0, 0.0], color);

    // Zwei Mantelflaechen (+n-/−n-Seite): bleiben bei Gehrung EXAKT planar mit
    // fester Normale, weil sich die Ecken nur entlang `u` verschieben (siehe
    // Moduldoc-Beweis) — der `off_a`/`off_b`-Abstand zur Achse bleibt konstant.
    let np = [n[0], 0.0, n[1]];
    let nn = [-n[0], 0.0, -n[1]];
    push_quad(mesh, b0, b1, t1, t0, np, color);
    push_quad(mesh, b2, b3, t3, t2, nn, color);

    // End-Kappen bei a1/a0: Normale geometrisch hergeleitet (siehe Moduldoc) —
    // liefert im rechtwinkligen Fall exakt +u/-u, bei Gehrung die tatsaechliche
    // (schraege) Kappen-Normale.
    let end_normal = quad_normal(b1, b2, t1);
    let start_normal = quad_normal(b3, b0, t3);
    push_quad(mesh, b1, b2, t2, t1, end_normal, color);
    push_quad(mesh, b3, b0, t0, t3, start_normal, color);
}

/// Haengt ein Quad (vier Ecken als Ring, beliebige Reihenfolge) als zwei
/// orientierte Dreiecke an — Winding via `push_tri_oriented` an `want_normal`
/// ausgerichtet (robust gegen die Eck-Reihenfolge, anders als `push_quad`).
/// Genutzt fuer die Loch-Zerlegung (Langseiten-Teilrechtecke, Deckel-/Boden-
/// Streifen, Laibungen), wo die Ecken aus Gitter-Koordinaten kommen.
fn push_quad_oriented(
    mesh: &mut Mesh,
    a: [f32; 3],
    b: [f32; 3],
    c: [f32; 3],
    d: [f32; 3],
    want_normal: [f32; 3],
    color: Rgb,
) {
    push_tri_oriented(mesh, a, b, c, want_normal, color);
    push_tri_oriented(mesh, a, c, d, want_normal, color);
}

/// Zerlegt das Rechteck `[u_lo,u_hi] x [z_lo,z_hi]` MINUS der `holes`
/// (`(u0,u1,z0,z1)`) in achsparallele, paarweise disjunkte Teilrechtecke (die
/// SOLIDEN Bereiche). Verfahren: Koordinaten-Kompression — alle Loch-Kanten in u
/// und z bilden ein Gitter; jede Gitterzelle, deren Mittelpunkt in KEINEM Loch
/// liegt, ist ein solides Teilrechteck. Dadurch koennen sich Loecher in u
/// ueberlappen und auf unterschiedlicher Hoehe liegen (Kernfall zweier versetzt
/// uebereinanderliegender Fenster), ohne dass degenerierte oder ueberlappende
/// Teilrechtecke entstehen.
fn solid_subrects(
    u_lo: f32,
    u_hi: f32,
    z_lo: f32,
    z_hi: f32,
    holes: &[(f32, f32, f32, f32)],
) -> Vec<(f32, f32, f32, f32)> {
    let sort_dedup = |mut v: Vec<f32>| -> Vec<f32> {
        v.sort_by(|a, b| a.partial_cmp(b).unwrap());
        v.dedup_by(|a, b| (*a - *b).abs() <= MIN_SPAN);
        v
    };
    let mut us = vec![u_lo, u_hi];
    let mut zs = vec![z_lo, z_hi];
    for (a0, a1, hb, ht) in holes {
        us.push(*a0);
        us.push(*a1);
        zs.push(*hb);
        zs.push(*ht);
    }
    let us = sort_dedup(us);
    let zs = sort_dedup(zs);
    let mut out = Vec::new();
    for i in 0..us.len().saturating_sub(1) {
        let (ua, ub) = (us[i], us[i + 1]);
        if ub - ua <= MIN_SPAN {
            continue;
        }
        for j in 0..zs.len().saturating_sub(1) {
            let (za, zb) = (zs[j], zs[j + 1]);
            if zb - za <= MIN_SPAN {
                continue;
            }
            let cu = (ua + ub) * 0.5;
            let cz = (za + zb) * 0.5;
            let in_hole = holes
                .iter()
                .any(|(a0, a1, hb, ht)| cu > *a0 && cu < *a1 && cz > *hb && cz < *ht);
            if !in_hole {
                out.push((ua, ub, za, zb));
            }
        }
    }
    out
}

/// Zieht die (ggf. ueberlappenden) `gaps` vom Intervall `[lo,hi]` ab und liefert
/// die verbleibenden Teilintervalle (sortiert, disjunkt). Fuer die Deckel-/
/// Boden-/Kappen-Flaechen, in denen ein randstaendiges Loch eine Luecke reisst.
fn subtract_intervals(lo: f32, hi: f32, gaps: &[(f32, f32)]) -> Vec<(f32, f32)> {
    let mut gs: Vec<(f32, f32)> = gaps
        .iter()
        .map(|(a, b)| (a.max(lo), b.min(hi)))
        .filter(|(a, b)| b - a > MIN_SPAN)
        .collect();
    gs.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
    let mut out = Vec::new();
    let mut cursor = lo;
    for (a, b) in gs {
        if a > cursor + MIN_SPAN {
            out.push((cursor, a));
        }
        cursor = cursor.max(b);
    }
    if hi > cursor + MIN_SPAN {
        out.push((cursor, hi));
    }
    out
}

/// Extrudiert EIN Schicht-Band (volle Achse `0..length`, Hoehe `[y0,y1]`,
/// Dicken-Versatz `[off_a,off_b]`) mit ECHTEN rechteckigen LOECHERN (`holes`,
/// siehe `types::Hole`) statt der Oeffnungs-Segmentierung. Aufbau:
///  • Langseiten (+n bei `off_a`, −n bei `off_b`): das Flaechen-Rechteck MINUS
///    der Loecher, per `solid_subrects` in Teilrechtecke zerlegt (je 2 Dreiecke).
///  • Deckel (`y1`) / Boden (`y0`): voller Streifen minus der u-Intervalle der
///    Loecher, die die jeweilige Kante beruehren (z. B. eine Tuer am Boden).
///  • End-Kappen (`a=0`/`a=length`, gemitert): volle Hoehe minus der z-Intervalle
///    randstaendiger Loecher (Loecher liegen normalerweise im Inneren → volle
///    Kappe, unveraendert gegenueber der Gehrung).
///  • Laibungen je Loch: vier Quads (links/rechts/unten/oben) — aber nur fuer die
///    Seiten, die im Wand-INNEREN liegen (die randstaendige Seite hat stattdessen
///    die Luecke in Deckel/Boden/Kappe, keine Laibung).
/// Winding/Normalen konsistent ueber `push_quad_oriented`/`push_tri_oriented`
/// (Backface-Culling + Beleuchtung korrekt).
#[allow(clippy::too_many_arguments)]
fn extrude_layer_segment_with_holes(
    mesh: &mut Mesh,
    wall: &WallInput,
    n: Point2,
    length: f32,
    y0: f32,
    y1: f32,
    off_a: f32,
    off_b: f32,
    start_cut: Option<MiterLine>,
    end_cut: Option<MiterLine>,
    color: Rgb,
    holes: &[Hole],
) {
    let ux = wall.end[0] - wall.start[0];
    let uz = wall.end[1] - wall.start[1];
    let ul = (ux * ux + uz * uz).sqrt().max(1e-9);
    let u: Point2 = [ux / ul, uz / ul];

    let off = |p: Point2, s: f32| -> Point2 { [p[0] + n[0] * s, p[1] + n[1] * s] };
    let clip = |base: Point2, cut: Option<MiterLine>| -> Point2 {
        match cut {
            None => base,
            Some(c) => line_intersect_2(base, u, c.point, c.dir).unwrap_or(base),
        }
    };
    // Plan-Punkt bei Achsen-Position `a`, Dicken-Versatz `offv`; NUR an den echten
    // Wandenden (a≈0 / a≈length) gegen die Gehrungslinie verschnitten — innere
    // Loch-Kanten bleiben rechtwinklig (unabhaengig von der Gehrung).
    let g_at = |a: f32, offv: f32| -> Point2 {
        let base = off(axis_point(wall, length, a), offv);
        if a <= 1e-6 {
            clip(base, start_cut)
        } else if a >= length - 1e-6 {
            clip(base, end_cut)
        } else {
            base
        }
    };
    let w = |g: Point2, y: f32| -> [f32; 3] { [g[0], y, g[1]] };

    // Loecher auf [0,length] x [y0,y1] klemmen, entartete verwerfen.
    let mut hs: Vec<(f32, f32, f32, f32)> = Vec::new();
    for h in holes {
        let a0 = h.from.max(0.0);
        let a1 = h.to.min(length);
        let zb = h.z_bottom.max(y0);
        let zt = h.z_top.min(y1);
        if a1 - a0 > MIN_SPAN && zt - zb > MIN_SPAN {
            hs.push((a0, a1, zb, zt));
        }
    }

    // ── Langseiten (+n / −n): Rechteck-Gitter minus Loecher. ──────────────────
    let np = [n[0], 0.0, n[1]];
    let nn = [-n[0], 0.0, -n[1]];
    for (ua, ub, za, zb) in solid_subrects(0.0, length, y0, y1, &hs) {
        push_quad_oriented(
            mesh,
            w(g_at(ua, off_a), za),
            w(g_at(ub, off_a), za),
            w(g_at(ub, off_a), zb),
            w(g_at(ua, off_a), zb),
            np,
            color,
        );
        push_quad_oriented(
            mesh,
            w(g_at(ua, off_b), za),
            w(g_at(ub, off_b), za),
            w(g_at(ub, off_b), zb),
            w(g_at(ua, off_b), zb),
            nn,
            color,
        );
    }

    // ── Deckel (y1) und Boden (y0): voller Streifen minus randstaendiger Loecher.
    let top_gaps: Vec<(f32, f32)> = hs
        .iter()
        .filter(|(_, _, _, zt)| *zt >= y1 - MIN_SPAN)
        .map(|(a0, a1, _, _)| (*a0, *a1))
        .collect();
    for (ua, ub) in subtract_intervals(0.0, length, &top_gaps) {
        push_quad_oriented(
            mesh,
            w(g_at(ua, off_a), y1),
            w(g_at(ub, off_a), y1),
            w(g_at(ub, off_b), y1),
            w(g_at(ua, off_b), y1),
            [0.0, 1.0, 0.0],
            color,
        );
    }
    let bot_gaps: Vec<(f32, f32)> = hs
        .iter()
        .filter(|(_, _, zb, _)| *zb <= y0 + MIN_SPAN)
        .map(|(a0, a1, _, _)| (*a0, *a1))
        .collect();
    for (ua, ub) in subtract_intervals(0.0, length, &bot_gaps) {
        push_quad_oriented(
            mesh,
            w(g_at(ua, off_a), y0),
            w(g_at(ub, off_a), y0),
            w(g_at(ub, off_b), y0),
            w(g_at(ua, off_b), y0),
            [0.0, -1.0, 0.0],
            color,
        );
    }

    // ── End-Kappen (a=0 / a=length): volle Hoehe minus randstaendiger Loecher. ─
    // Aussen-Normale je Kappe geometrisch aus den vollen Kappen-Ecken (wie im
    // rechtwinkligen/gehrten Fall in `extrude_layer_segment`).
    let start_normal = quad_normal(
        w(g_at(0.0, off_b), y0),
        w(g_at(0.0, off_a), y0),
        w(g_at(0.0, off_b), y1),
    );
    let start_gaps: Vec<(f32, f32)> = hs
        .iter()
        .filter(|(a0, _, _, _)| *a0 <= MIN_SPAN)
        .map(|(_, _, zb, zt)| (*zb, *zt))
        .collect();
    for (za, zb) in subtract_intervals(y0, y1, &start_gaps) {
        push_quad_oriented(
            mesh,
            w(g_at(0.0, off_b), za),
            w(g_at(0.0, off_a), za),
            w(g_at(0.0, off_a), zb),
            w(g_at(0.0, off_b), zb),
            start_normal,
            color,
        );
    }
    let end_normal = quad_normal(
        w(g_at(length, off_a), y0),
        w(g_at(length, off_b), y0),
        w(g_at(length, off_a), y1),
    );
    let end_gaps: Vec<(f32, f32)> = hs
        .iter()
        .filter(|(_, a1, _, _)| *a1 >= length - MIN_SPAN)
        .map(|(_, _, zb, zt)| (*zb, *zt))
        .collect();
    for (za, zb) in subtract_intervals(y0, y1, &end_gaps) {
        push_quad_oriented(
            mesh,
            w(g_at(length, off_a), za),
            w(g_at(length, off_b), za),
            w(g_at(length, off_b), zb),
            w(g_at(length, off_a), zb),
            end_normal,
            color,
        );
    }

    // ── Laibungen je Loch: nur die im Wand-Inneren liegenden Seiten. ──────────
    for &(a0, a1, zb, zt) in &hs {
        // Linke Laibung (bei a0), Normale +u (in die Oeffnung).
        if a0 > MIN_SPAN {
            push_quad_oriented(
                mesh,
                w(g_at(a0, off_a), zb),
                w(g_at(a0, off_b), zb),
                w(g_at(a0, off_b), zt),
                w(g_at(a0, off_a), zt),
                [u[0], 0.0, u[1]],
                color,
            );
        }
        // Rechte Laibung (bei a1), Normale −u.
        if a1 < length - MIN_SPAN {
            push_quad_oriented(
                mesh,
                w(g_at(a1, off_a), zb),
                w(g_at(a1, off_b), zb),
                w(g_at(a1, off_b), zt),
                w(g_at(a1, off_a), zt),
                [-u[0], 0.0, -u[1]],
                color,
            );
        }
        // Untere Laibung (bei zb = Bruestungsoberkante), Normale +Y.
        if zb > y0 + MIN_SPAN {
            push_quad_oriented(
                mesh,
                w(g_at(a0, off_a), zb),
                w(g_at(a1, off_a), zb),
                w(g_at(a1, off_b), zb),
                w(g_at(a0, off_b), zb),
                [0.0, 1.0, 0.0],
                color,
            );
        }
        // Obere Laibung (bei zt = Sturzunterkante), Normale −Y.
        if zt < y1 - MIN_SPAN {
            push_quad_oriented(
                mesh,
                w(g_at(a0, off_a), zt),
                w(g_at(a1, off_a), zt),
                w(g_at(a1, off_b), zt),
                w(g_at(a0, off_b), zt),
                [0.0, -1.0, 0.0],
                color,
            );
        }
    }
}

/// Aussen-Normale eines planaren, CCW-von-aussen georderten Quads `(a,b,_,d)`
/// (nur die drei ersten Ecken werden gebraucht: `d` ist die vierte, ueber `a`
/// benachbarte Ecke). `cross(b-a, d-a)` — Herleitung/Verifikation siehe
/// Moduldoc von `compute_wall_miters`. Degenerierte (nulllange) Flaechen liefern
/// den Nullvektor statt NaN (Winkel spielt dort keine Rolle, siehe Aufrufer).
fn quad_normal(a: [f32; 3], b: [f32; 3], d: [f32; 3]) -> [f32; 3] {
    let ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    let ad = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
    let c = [
        ab[1] * ad[2] - ab[2] * ad[1],
        ab[2] * ad[0] - ab[0] * ad[2],
        ab[0] * ad[1] - ab[1] * ad[0],
    ];
    let len = (c[0] * c[0] + c[1] * c[1] + c[2] * c[2]).sqrt().max(1e-9);
    [c[0] / len, c[1] / len, c[2] / len]
}

// ─────────────────────────────────────────────────────────────────────────────
// Ecken-Verschneidung (Gehrung): Wandkonnektivitaet -> Gehrungslinien je Wandende
// ─────────────────────────────────────────────────────────────────────────────

/// Eine Gehrungslinie (Punkt + Richtung, Modell-Meter) an einem Wandende.
#[derive(Debug, Clone, Copy)]
struct MiterLine {
    point: Point2,
    dir: Point2,
}

/// Die (ggf. fehlenden) Gehrungslinien EINER Wand an Start/Ende.
#[derive(Debug, Clone, Copy, Default)]
struct WallMiters {
    start: Option<MiterLine>,
    end: Option<MiterLine>,
}

/// Schnittpunkt der Geraden `a + t*da` mit `b + s*db` (2D). `None` bei
/// (nahezu) parallelen Richtungen — 2D-Pendant zu `math::cross`/`lineIntersect`
/// im Web (`src/model/geometry.ts`).
fn line_intersect_2(a: Point2, da: Point2, b: Point2, db: Point2) -> Option<Point2> {
    let denom = da[0] * db[1] - da[1] * db[0];
    if denom.abs() < 1e-9 {
        return None;
    }
    let bx = b[0] - a[0];
    let by = b[1] - a[1];
    let t = (bx * db[1] - by * db[0]) / denom;
    Some([a[0] + t * da[0], a[1] + t * da[1]])
}

/// Rundungsschluessel eines 2D-Punkts (0.1 mm), zur robusten Gruppierung von
/// Wandenden am selben Knoten — 1:1 das Muster von `joins.ts::roundKey`.
fn round_key(p: Point2) -> (i64, i64) {
    (
        (p[0] * 1e4).round() as i64,
        (p[1] * 1e4).round() as i64,
    )
}

/// Ein Wandende, wie es fuer die Knoten-Gruppierung gebraucht wird.
struct EndRef {
    wall: usize,
    is_start: bool,
    point: Point2,
    /// Normalisierte Achsenrichtung Start->Ende der GESAMTEN Wand (konstant,
    /// unabhaengig davon, ob es sich um das Start- oder Endende handelt).
    dir: Point2,
    z0: f32,
    z1: f32,
}

/// Gruppiert `members` (Indizes in `ends`) nach echt ueberlappendem
/// Hoehenbereich (Union-Find) — trennt uebereinanderliegende Geschosse mit
/// deckungsgleichem Grundriss (deren Hoehenbereiche sich hoechstens BERUEHREN,
/// nicht ueberlappen) von echten Knoten INNERHALB eines Geschosses (deren
/// Hoehenbereiche sich ueberschneiden, auch wenn Oeffnungen ein Teilstueck auf
/// Bruestung/Sturz reduzieren).
fn cluster_by_height_overlap(ends: &[EndRef], members: &[usize]) -> Vec<Vec<usize>> {
    let n = members.len();
    let mut parent: Vec<usize> = (0..n).collect();
    fn find(parent: &mut [usize], x: usize) -> usize {
        if parent[x] != x {
            let root = find(parent, parent[x]);
            parent[x] = root;
        }
        parent[x]
    }
    const OVERLAP_EPS: f32 = 1e-4;
    for i in 0..n {
        for j in (i + 1)..n {
            let a = &ends[members[i]];
            let b = &ends[members[j]];
            let lo = a.z0.max(b.z0);
            let hi = a.z1.min(b.z1);
            if hi - lo > OVERLAP_EPS {
                let ri = find(&mut parent, i);
                let rj = find(&mut parent, j);
                if ri != rj {
                    parent[ri] = rj;
                }
            }
        }
    }
    let mut clusters: HashMap<usize, Vec<usize>> = HashMap::new();
    for i in 0..n {
        let r = find(&mut parent, i);
        clusters.entry(r).or_default().push(members[i]);
    }
    clusters.into_values().collect()
}

/// Gemeinsame Gehrungslinie zweier Wandenden `a`, `b`, die sich im selben
/// Knoten treffen — 1:1-Port von `joins.ts::miterLine` (Referenzlinie "center",
/// da `WallInput` keine `referenceLine`-Information mitfuehrt): `a`s linke
/// Flaeche wird mit der naeher gelegenen Flaeche von `b` verschnitten, `a`s
/// rechte mit der jeweils anderen. Liefert `None` bei (nahezu) kollinearen
/// Richtungen — das deckt insbesondere zwei Teilstuecke DERSELBEN Wand ab
/// (identische Richtung, siehe Moduldoc).
fn miter_line(walls: &[WallInput], a: &EndRef, b: &EndRef) -> Option<MiterLine> {
    let j = a.point;
    let t_a = walls[a.wall].thickness;
    let t_b = walls[b.wall].thickness;
    let n_a: Point2 = [-a.dir[1], a.dir[0]];
    let n_b: Point2 = [-b.dir[1], b.dir[0]];

    let add_scaled = |p: Point2, v: Point2, s: f32| -> Point2 { [p[0] + v[0] * s, p[1] + v[1] * s] };
    let p_la = add_scaled(j, n_a, t_a * 0.5);
    let p_ra = add_scaled(j, n_a, -t_a * 0.5);
    let p_lb = add_scaled(j, n_b, t_b * 0.5);
    let p_rb = add_scaled(j, n_b, -t_b * 0.5);

    let dist2 = |p: Point2, q: Point2| {
        let dx = p[0] - q[0];
        let dy = p[1] - q[1];
        dx * dx + dy * dy
    };
    let lb_closer = dist2(p_la, p_lb) <= dist2(p_la, p_rb);
    let b_for_left = if lb_closer { p_lb } else { p_rb };
    let b_for_right = if lb_closer { p_rb } else { p_lb };

    let c1 = line_intersect_2(p_la, a.dir, b_for_left, b.dir)?;
    let c2 = line_intersect_2(p_ra, a.dir, b_for_right, b.dir)?;
    let dir = [c2[0] - c1[0], c2[1] - c1[1]];
    if (dir[0] * dir[0] + dir[1] * dir[1]).sqrt() < 1e-9 {
        return None; // kollinear -> kein Schnitt
    }
    Some(MiterLine { point: c1, dir })
}

fn apply_cut(out: &mut [WallMiters], e: &EndRef, cut: MiterLine) {
    if e.is_start {
        out[e.wall].start = Some(cut);
    } else {
        out[e.wall].end = Some(cut);
    }
}

/// Berechnet fuer JEDE Wand in `walls` die Gehrungslinien an ihren echten
/// Achsenenden — reine Funktion der Wandkonnektivitaet (Endpunkte + Dicke +
/// Hoehenbereich), siehe Moduldoc "Ecken-Verschneidung". Nur Knoten, an denen
/// sich (innerhalb desselben Hoehenbereichs) GENAU zwei, nicht-kollineare
/// Wandenden treffen, werden gehrt; freie Enden, T-/X-Stoesse und mehrdeutige
/// Knoten (z. B. eine Oeffnung direkt an einer echten Ecke, die das Ende in
/// mehrere Hoehen-Teilstuecke zerlegt) bleiben konservativ rechtwinklig.
fn compute_wall_miters(walls: &[WallInput]) -> Vec<WallMiters> {
    let mut out = vec![WallMiters::default(); walls.len()];

    let mut ends: Vec<EndRef> = Vec::with_capacity(walls.len() * 2);
    for (i, w) in walls.iter().enumerate() {
        let n = left_normal(w.start, w.end);
        if n == [0.0, 0.0] {
            continue; // entartete Wand, siehe extrude_wall
        }
        // Achsenrichtung aus der Links-Normale zurueckgedreht (90 Grad):
        // n = (-dir.y, dir.x)  =>  dir = (n.y, -n.x). Siehe section.rs::wall_prism.
        let dir: Point2 = [n[1], -n[0]];
        let z0 = w.base_elevation;
        let z1 = w.base_elevation + w.height;
        ends.push(EndRef { wall: i, is_start: true, point: w.start, dir, z0, z1 });
        ends.push(EndRef { wall: i, is_start: false, point: w.end, dir, z0, z1 });
    }

    let mut groups: HashMap<(i64, i64), Vec<usize>> = HashMap::new();
    for (idx, e) in ends.iter().enumerate() {
        groups.entry(round_key(e.point)).or_default().push(idx);
    }

    for members in groups.into_values() {
        if members.len() < 2 {
            continue; // freies Ende
        }
        for cluster in cluster_by_height_overlap(&ends, &members) {
            if cluster.len() != 2 {
                continue; // T-/X-Stoss oder mehrdeutig -> rechtwinklig
            }
            let (ia, ib) = (cluster[0], cluster[1]);
            let (a, b) = (&ends[ia], &ends[ib]);
            if a.wall == b.wall {
                continue; // eine Wand kann sich nicht selbst verschneiden
            }
            let Some(cut) = miter_line(walls, a, b) else {
                continue;
            };
            apply_cut(&mut out, a, cut);
            apply_cut(&mut out, b, cut);
        }
    }
    // Explizite Schnittlinien aus dem Kern (Gehrung, T-Stoss-Fläche, schräge Aussparungs-Seite)
    // übersteuern die abgeleitete Gehrung — sie kennen auch Stösse ohne gemeinsamen Endpunkt.
    let line = |c: [f32; 4]| MiterLine { point: [c[0], c[1]], dir: [c[2], c[3]] };
    for (i, w) in walls.iter().enumerate() {
        if let Some(c) = w.start_cut {
            out[i].start = Some(line(c));
        }
        if let Some(c) = w.end_cut {
            out[i].end = Some(line(c));
        }
    }
    out
}

/// Ermittelt je Wand, ob ihr Start-/Endpunkt ein FREIES Ende ist — d. h. KEIN
/// anderes Wandende (auch kein T-/X-Stoss) trifft sich dort im selben
/// Hoehenbereich. Dieselbe Punkt-Rundung + Hoehen-Ueberlappungs-Clustering wie
/// `compute_wall_miters`, aber OHNE dessen Zwei-Wandenden-Einschraenkung: jeder
/// Cluster der Groesse ≥ 2 (Gehrung ODER T-/X-Stoss) gilt als "beruehrt", nur
/// ein isolierter Cluster der Groesse 1 (nur die Wand selbst) bleibt frei.
/// Grundlage der Schraffur-Kappen an unverbundenen Wandenden
/// (`build_free_wall_end_caps`) — ein Wandende "ohne Anschluss" (Nutzer-Begriff)
/// zeigt dort die Bauteil-Schraffur statt der Flaechenfarbe, wie ein echter
/// Schnitt.
fn compute_free_wall_ends(walls: &[WallInput]) -> Vec<(bool, bool)> {
    let mut out = vec![(true, true); walls.len()];

    let mut ends: Vec<EndRef> = Vec::with_capacity(walls.len() * 2);
    for (i, w) in walls.iter().enumerate() {
        let n = left_normal(w.start, w.end);
        if n == [0.0, 0.0] {
            continue; // entartete Wand: weder Ende gilt als "frei" (irrelevant)
        }
        let dir: Point2 = [n[1], -n[0]];
        let z0 = w.base_elevation;
        let z1 = w.base_elevation + w.height;
        ends.push(EndRef { wall: i, is_start: true, point: w.start, dir, z0, z1 });
        ends.push(EndRef { wall: i, is_start: false, point: w.end, dir, z0, z1 });
    }

    let mut groups: HashMap<(i64, i64), Vec<usize>> = HashMap::new();
    for (idx, e) in ends.iter().enumerate() {
        groups.entry(round_key(e.point)).or_default().push(idx);
    }

    for members in groups.into_values() {
        if members.len() < 2 {
            continue; // einziges Ende an diesem Punkt -> bleibt frei (Default)
        }
        for cluster in cluster_by_height_overlap(&ends, &members) {
            if cluster.len() < 2 {
                continue; // eigener, hoehenmaessig isolierter Cluster -> frei
            }
            for &idx in &cluster {
                let e = &ends[idx];
                if e.is_start {
                    out[e.wall].0 = false;
                } else {
                    out[e.wall].1 = false;
                }
            }
        }
    }
    // Explizite Schnittlinie (Kern-Verschneidung): das Ende ist angeschlossen, nicht frei.
    for (i, w) in walls.iter().enumerate() {
        if w.start_cut.is_some() {
            out[i].0 = false;
        }
        if w.end_cut.is_some() {
            out[i].1 = false;
        }
    }
    out
}

/// Breite (Meter, Welt) der Schicht-Trennlinien auf Kappen/Oberseiten.
const LAYER_LINE_WIDTH: f32 = 0.004;

/// Duenner Streifen (Vollton-Tinte, Muster 1) von `a` nach `b`, quer um `perp`
/// (Einheitsvektor, in der Kappen-Ebene) auf `LAYER_LINE_WIDTH` verbreitert — die
/// Schicht-Trennlinie wie im 2D/Schnitt. Gleiches Vertex-Format wie die Kappen.
fn push_line_strip(verts: &mut Vec<f32>, a: [f32; 3], b: [f32; 3], perp: [f32; 3]) {
    let h = LAYER_LINE_WIDTH * 0.5;
    let v = |p: [f32; 3], s: f32| -> [f32; 9] {
        [
            p[0] + perp[0] * h * s, p[1] + perp[1] * h * s, p[2] + perp[2] * h * s,
            0.0, 0.0, 1.0, 0.0, 1.0, 0.0,
        ]
    };
    let (a0, a1, b0, b1) = (v(a, 1.0), v(a, -1.0), v(b, 1.0), v(b, -1.0));
    for q in [a0, a1, b1, a0, b1, b0] {
        verts.extend_from_slice(&q);
    }
}

/// Haengt EINE Schraffur-Kappe (alle Schicht-Baender gestapelt) an einem
/// Wand-Achsenende an `verts` an — Vertex-Format identisch zu
/// `section_fill::build_cut_caps` (`CAP_FLOATS_PER_VERTEX`), damit dieselbe
/// `cap_pipeline`/`CAP_WGSL` sie zeichnen kann. `(u,v)` = (Quer-Versatz `s` zur
/// Wandachse, Welt-Hoehe) — metrisch, an den Schicht-Grenzen stetig.
#[allow(clippy::too_many_arguments)]
fn push_wall_end_cap(
    verts: &mut Vec<f32>,
    point: Point2,
    n: Point2,
    layers: &[WallLayer],
    total: f32,
    y0: f32,
    y1: f32,
    pattern: f32,
    angle_rad: f32,
    scale: f32,
    line_weight: f32,
) {
    let corner = |s: f32, y: f32| -> [f32; 9] {
        let p = [point[0] + n[0] * s, point[1] + n[1] * s];
        [p[0], y, p[1], s, y, pattern, angle_rad, scale, line_weight]
    };
    let mut off_a = total * 0.5;
    for layer in layers {
        let off_b = off_a - layer.thickness;
        let c0 = corner(off_a, y0);
        let c1 = corner(off_b, y0);
        let c2 = corner(off_b, y1);
        let c3 = corner(off_a, y1);
        // Fan-Triangulierung des Quads (Winding egal, cap_pipeline kennt kein
        // Backface-Culling — siehe section_fill.rs-Moduldoc).
        verts.extend_from_slice(&c0);
        verts.extend_from_slice(&c1);
        verts.extend_from_slice(&c2);
        verts.extend_from_slice(&c0);
        verts.extend_from_slice(&c2);
        verts.extend_from_slice(&c3);
        // Schicht-Trennlinie (senkrecht) an der Aussenkante dieser Lage; die letzte Lage
        // schliesst zusaetzlich mit der Gegenseite ab.
        let perp = [n[0], 0.0, n[1]];
        let line = |s_off: f32, verts: &mut Vec<f32>| {
            let p = [point[0] + n[0] * s_off, point[1] + n[1] * s_off];
            push_line_strip(verts, [p[0], y0, p[1]], [p[0], y1, p[1]], perp);
        };
        line(off_a, verts);
        if (off_b + total * 0.5).abs() < 1e-5 {
            line(off_b, verts);
        }
        off_a = off_b;
    }
}

/// Schraffur-Kappen an FREIEN Wandenden (kein Anschluss an eine andere Wand,
/// s. `compute_free_wall_ends`): additive, ZWEITE Geometrie neben der
/// (unveraendert weiterhin flach eingefaerbten) End-Kappe der normalen
/// Extrusion — gezeichnet mit Tiefen-Bias VOR der Flaeche (analog dem
/// Luftbild-Overlay `gpu::aerial_pipeline`), sodass sie diese optisch
/// ueberdeckt, OHNE `extrude_layer_segment` selbst anzufassen (kein
/// Regressionsrisiko fuer bestehende Vollkoerper-Tests). Nur Waende MIT
/// explizit gesetzter `hatch` (Bauteil-Schraffur, `toWalls3d.ts` loest sie je
/// Materialschicht auf) bekommen eine Kappe — ohne `hatch` (z. B. alle
/// bestehenden Test-Fixtures) bleibt das Alt-Verhalten unangetastet. Bildet NUR
/// die echten Achsen-Enden ab (Wandanfang/-ende), keine Oeffnungs-Laibungen —
/// "Wand endet an Decke" (vertikale Terminierung) ist bewusst NICHT Teil dieser
/// Kappen (separates, noch offenes Thema).
pub fn build_free_wall_end_caps(walls: &[WallInput]) -> Vec<f32> {
    let free_ends = compute_free_wall_ends(walls);
    let miters = compute_wall_miters(walls);
    let mut verts: Vec<f32> = Vec::new();

    for (wi, wall) in walls.iter().enumerate() {
        let Some(hatch) = wall.hatch else { continue };
        // Wand-OBERSEITE (Draufsicht): die Bauteil-Schraffur statt der Material-Textur/-Farbe,
        // wie die geschnittene Wand im Grundriss. (u,v) = Weltkoordinaten (x, z) — metrisch,
        // ueber alle Waende hinweg phasengleich.
        if wall.height > 1e-6 {
            if let Some(fp) = wall_mitered_footprint(wall, miters[wi]) {
                let y_top = wall.base_elevation + wall.height;
                // Schräge Oberkante: Höhe je Punkt aus der Lage entlang der Achse.
                let dx = wall.end[0] - wall.start[0];
                let dz = wall.end[1] - wall.start[1];
                let len2 = (dx * dx + dz * dz).max(1e-12);
                let y_at = |p: Point2| -> f32 {
                    if let Some(q) = wall.top_plane {
                        return q[0] + q[1] * (p[0] - wall.start[0]) + q[2] * (p[1] - wall.start[1]);
                    }
                    let t = (((p[0] - wall.start[0]) * dx + (p[1] - wall.start[1]) * dz) / len2).clamp(0.0, 1.0);
                    y_top - (wall.top_drop[0] + (wall.top_drop[1] - wall.top_drop[0]) * t)
                };
                let c = |p: Point2| -> [f32; 9] {
                    let y = y_at(p);
                    [
                        p[0], y, p[1], p[0], p[1],
                        hatch.pattern as f32, hatch.top_angle.unwrap_or(hatch.angle).to_radians(), hatch.scale.max(0.05),
                        hatch.line_weight.max(0.0),
                    ]
                };
                for idx in [0usize, 1, 2, 0, 2, 3] {
                    verts.extend_from_slice(&c(fp[idx]));
                }
                // Schicht-Trennlinien auf der Oberseite: beide Laengskanten (Lagen-Grenzen).
                let n = left_normal(wall.start, wall.end);
                let perp_n = [n[0], 0.0, n[1]];
                for (a, b) in [(0usize, 1usize), (3, 2)] {
                    push_line_strip(
                        &mut verts,
                        [fp[a][0], y_at(fp[a]), fp[a][1]],
                        [fp[b][0], y_at(fp[b]), fp[b][1]],
                        perp_n,
                    );
                }
            }
        }
        let (free_start, free_end) = free_ends[wi];
        if !free_start && !free_end {
            continue;
        }
        let n = left_normal(wall.start, wall.end);
        if n == [0.0, 0.0] || wall.height <= 1e-6 {
            continue;
        }
        let y0 = wall.base_elevation;
        let y1 = wall.base_elevation + wall.height;

        let synthetic;
        let layers: &[WallLayer] = match &wall.layers {
            Some(ls) if !ls.is_empty() => ls.as_slice(),
            _ => {
                synthetic = [WallLayer { thickness: wall.thickness, color: wall.color }];
                &synthetic
            }
        };
        let total: f32 = layers.iter().map(|l| l.thickness).sum();
        let pattern = hatch.pattern as f32;
        let angle_rad = hatch.angle.to_radians();
        let scale = hatch.scale.max(0.05);
        let line_weight = hatch.line_weight.max(0.0);

        if free_start {
            push_wall_end_cap(
                &mut verts, wall.start, n, layers, total, y0, y1 - wall.top_drop[0], pattern, angle_rad, scale,
                line_weight,
            );
        }
        if free_end {
            push_wall_end_cap(
                &mut verts, wall.end, n, layers, total, y0, y1 - wall.top_drop[1], pattern, angle_rad, scale,
                line_weight,
            );
        }
    }
    verts
}

/// Grundriss-Fussabdruck EINER Wand (die vier Band-Eckpunkte g0..g3 in CCW),
/// an ihren echten Achsenenden ggf. gehrt — bitgenau dieselbe Ecken-Konstruktion
/// wie `extrude_layer_segment` fuer das Vollstueck (Einzel-Layer, keine
/// Oeffnung): `off(start/end, +/-thickness/2)`, an Start/Ende gegen die jeweilige
/// Gehrungslinie verschnitten. `None` fuer entartete Waende (Start == Ende, wie
/// `extrude_wall`). Reihenfolge: start+n, end+n, end-n, start-n.
fn wall_mitered_footprint(wall: &WallInput, miters: WallMiters) -> Option<[Point2; 4]> {
    let n = left_normal(wall.start, wall.end);
    if n == [0.0, 0.0] {
        return None;
    }
    let h = wall.thickness * 0.5;
    let ux = wall.end[0] - wall.start[0];
    let uz = wall.end[1] - wall.start[1];
    let ul = (ux * ux + uz * uz).sqrt().max(1e-9);
    let u: Point2 = [ux / ul, uz / ul];
    let off = |p: Point2, s: f32| -> Point2 { [p[0] + n[0] * s * h, p[1] + n[1] * s * h] };
    let clip = |base: Point2, cut: Option<MiterLine>| -> Point2 {
        match cut {
            None => base,
            Some(c) => line_intersect_2(base, u, c.point, c.dir).unwrap_or(base),
        }
    };
    Some([
        clip(off(wall.start, 1.0), miters.start),
        clip(off(wall.end, 1.0), miters.end),
        clip(off(wall.end, -1.0), miters.end),
        clip(off(wall.start, -1.0), miters.start),
    ])
}

/// Grundriss-Fussabdruecke ALLER Waende, an ihren echten Ecken verschnitten
/// (siehe `wall_mitered_footprint`). Berechnet die Gehrung einmalig ueber die
/// gesamte Wandkonnektivitaet (`compute_wall_miters`) und teilt so die
/// Ecken-Verschneidungs-Wahrheit mit `section::cut_section` — damit der Schnitt
/// an Wandecken denselben verschnittenen Wand-Querschnitt liefert wie die
/// 3D-Extrusion, ohne die Gehrungslogik zu duplizieren. Reihenfolge/Anzahl
/// deckungsgleich mit `walls` (`None` bei entarteter Wand).
pub(crate) fn wall_mitered_footprints(walls: &[WallInput]) -> Vec<Option<[Point2; 4]>> {
    let miters = compute_wall_miters(walls);
    walls
        .iter()
        .zip(miters)
        .map(|(w, m)| wall_mitered_footprint(w, m))
        .collect()
}

/// Haengt ein Quad (vier Ecken in CCW von aussen) als zwei Dreiecke an, mit fester
/// Flaechen-Normale und Farbe je Vertex. Reihenfolge (0,1,2) + (0,2,3).
fn push_quad(
    mesh: &mut Mesh,
    a: [f32; 3],
    b: [f32; 3],
    c: [f32; 3],
    d: [f32; 3],
    normal: [f32; 3],
    color: Rgb,
) {
    let base = (mesh.verts.len() / FLOATS_PER_VERTEX) as u32;
    for p in [a, b, c, d] {
        mesh.verts.extend_from_slice(&[
            p[0], p[1], p[2], normal[0], normal[1], normal[2], color[0], color[1], color[2],
        ]);
    }
    mesh.indices
        .extend_from_slice(&[base, base + 1, base + 2, base, base + 2, base + 3]);
}

/// Baut ein einzelnes Mesh aus mehreren Waenden (alle in EINEN Puffer). Die
/// Reihenfolge der Vertices ist deterministisch (je Wand ein Quader, bzw. bei
/// `layers`/Oeffnungen mehrere), damit die Tests stabile Zaehlungen erwarten
/// koennen. Berechnet zuerst die Eck-Gehrung ueber ALLE Waende (siehe
/// `compute_wall_miters`) und extrudiert dann jede Wand mit ihren Gehrungen.
pub fn build_walls_mesh(walls: &[WallInput]) -> Mesh {
    let mut mesh = Mesh::default();
    let miters = compute_wall_miters(walls);
    for (w, m) in walls.iter().zip(miters.iter()) {
        extrude_wall_with_miters(&mut mesh, w, *m);
    }
    mesh
}

/// TEXTURIERTER Wand-Pfad (`RenderStyle::Textured`): liefert DIESELBE Geometrie wie
/// `build_walls_mesh` — Positionen und Normalen bitgleich, gleiche Vertex-/Dreiecks-
/// Reihenfolge — aber mit einer planaren, WELTMASSSTAEBLICHEN UV je Vertex statt der
/// Bauteilfarbe. Bewusst ALS ABLEITUNG aus dem fertigen `Mesh` implementiert (nicht
/// als parallele Re-Extrusion): so bleibt die paritaets-/reihenfolgesensible
/// Geometrie (Gehrungen, Oeffnungen, Loecher, Schichten) die EINE Quelle der
/// Wahrheit und der Alt-Pfad `[pos, normal, color]` bleibt bitgleich unangetastet —
/// wir tauschen nur den color-Kanal gegen den aus Position+Normale abgeleiteten
/// UV-Kanal aus.
///
/// UV-PROJEKTION (planar, in Metern, damit das Textur-Raster weltmassstaeblich ist,
/// z. B. 1 Kachel = 1 m; kein Verzug an Gehrungen/Ecken, weil jede Flaeche planar
/// projiziert wird und benachbarte Waende dieselbe Welt-Projektion fortsetzen —
/// die Kacheln stossen im Weltraum sauber aneinander):
///   - Senkrechte Flaechen (Wand-Mantel, Normale ~ horizontal): `u` = Weglaenge
///     entlang der horizontalen Flaechen-Tangente `t = (-n.z, 0, n.x)`
///     (`u = dot(pos.xz, t.xz)`), `v` = Hoehe `pos.y`.
///   - Waagerechte Flaechen (Deckel/Boden, Normale ~ +/-Y): direkt aus dem
///     Grundriss `u = pos.x`, `v = pos.z`.
/// Die Wahl der Achse allein aus der Flaechen-Normale (statt aus der Wand-Achse)
/// haelt die Projektion rein lokal je Vertex — das ist genau der Grund, warum sie
/// sich verlustfrei aus dem fertigen `Mesh` ableiten laesst.
pub fn build_walls_mesh_textured(walls: &[WallInput]) -> TexturedMesh {
    // Ueber den Szenen-Builder (ohne Decken/Kontext) — so traegt der Puffer auch
    // die Material-Ebenen je Wand (`layers`), waehrend Geometrie/UV bitgleich zu
    // `textured_from_mesh(&build_walls_mesh(walls))` bleiben.
    build_scene_mesh_textured(walls, &[], &[])
}

/// Rechnet ein `Mesh` (`[pos, normal, color]`) in einen `TexturedMesh`
/// (`[pos, normal, uv]`) um: Positionen/Normalen/Indizes werden 1:1 uebernommen,
/// die Farbe je Vertex wird durch die planare Welt-UV ersetzt (siehe
/// `build_walls_mesh_textured` fuer die Achswahl). Indizes bleiben unveraendert,
/// weil sich die Vertex-Anzahl/-Reihenfolge nicht aendert. `pub`, damit die
/// GPU-Schicht (`gpu.rs`) das texturierte Pendant AUS DEMSELBEN `Mesh` ableiten
/// kann, das sie ohnehin schon gebaut/hochgeladen hat (eine Geometrie-Quelle).
pub fn textured_from_mesh(mesh: &Mesh) -> TexturedMesh {
    let n = mesh.vertex_count();
    let mut verts: Vec<f32> = Vec::with_capacity(n * TEXTURED_FLOATS_PER_VERTEX);
    for i in 0..n {
        let b = i * FLOATS_PER_VERTEX;
        let px = mesh.verts[b];
        let py = mesh.verts[b + 1];
        let pz = mesh.verts[b + 2];
        let nx = mesh.verts[b + 3];
        let ny = mesh.verts[b + 4];
        let nz = mesh.verts[b + 5];
        // Waagerecht (Deckel/Boden) vs. senkrecht (Mantel) an der Vertikal-
        // Komponente der Normale unterscheiden. Waende sind vertikal extrudiert,
        // ihre Mantelnormale ist streng horizontal (ny == 0) — die Schwelle 0.5
        // trennt sauber Deckel/Boden (|ny| == 1) von Mantelflaechen (ny == 0).
        let (u, v) = if ny.abs() > 0.5 {
            // Grundriss-Projektion: u = x, v = z (Meter).
            (px, pz)
        } else {
            // Horizontale Flaechen-Tangente t = (-n.z, 0, n.x): u = Weglaenge
            // entlang t, v = Hoehe. `t` ist ein Einheitsvektor, weil (n.x, n.z)
            // fuer Mantelflaechen normiert ist.
            let u = px * (-nz) + pz * nx;
            (u, py)
        };
        verts.extend_from_slice(&[px, py, pz, nx, ny, nz, u, v]);
    }
    TexturedMesh {
        verts,
        indices: mesh.indices.clone(),
        // Ohne Material-Zuordnung: leer -> die GPU-Schicht bindet einen konstanten
        // `-1`-Ebenenpuffer (Fallback-Schachbrett fuer alle Vertices).
        layers: Vec::new(),
    }
}

/// TEXTURIERTES Szenen-Mesh MIT Material-Ebenen: baut dieselbe Szene wie
/// `build_scene_mesh` (Waende -> Decken -> Kontext-Meshes, gleiche Reihenfolge/
/// Geometrie) und fuellt zusaetzlich den parallelen `layers`-Puffer (ein Eintrag
/// je Vertex): fuer jede Wand ihre `material_index`-Textur-Ebene (`None` -> `-1`),
/// fuer Decken und Kontext-Meshes `-1` (Fallback-Schachbrett). Die Vertex-Ranges
/// werden waehrend des Baus je Bauteil aus `Mesh::vertex_count()` abgegriffen —
/// dieselben `extrude_*`/`append_*`-Funktionen wie der Shaded-Pfad bleiben die
/// EINE Geometrie-Quelle (Paritaet garantiert), es kommt nur die Ebenen-Zuordnung
/// dazu. Genutzt vom `Textured`-Stil (`gpu::upload_*`).
pub fn build_scene_mesh_textured(
    walls: &[WallInput],
    slabs: &[SlabInput],
    meshes: &[MeshInput],
) -> TexturedMesh {
    let mut mesh = Mesh::default();
    let mut layers: Vec<f32> = Vec::new();
    let fill = |mesh: &Mesh, layers: &mut Vec<f32>, before: usize, layer: f32| {
        let added = mesh.vertex_count().saturating_sub(before);
        layers.extend(std::iter::repeat(layer).take(added));
    };

    let miters = compute_wall_miters(walls);
    for (w, m) in walls.iter().zip(miters.iter()) {
        let before = mesh.vertex_count();
        extrude_wall_with_miters(&mut mesh, w, *m);
        // Material-Ebene der Wand (1-basiert; 0 ist das Fallback-Schachbrett).
        let layer = w.material_index.map(|i| i as f32).unwrap_or(-1.0);
        fill(&mesh, &mut layers, before, layer);
    }
    for s in slabs {
        let before = mesh.vertex_count();
        extrude_slab(&mut mesh, s);
        fill(&mesh, &mut layers, before, -1.0);
    }
    for m in meshes {
        let before = mesh.vertex_count();
        append_context_mesh(&mut mesh, m);
        // Material-Ebene des Kontext-Meshes (aktuell nur Daecher setzen sie,
        // s. `MeshInput::material_index`); ohne -> Fallback-Schachbrett.
        let layer = m.material_index.map(|i| i as f32).unwrap_or(-1.0);
        fill(&mesh, &mut layers, before, layer);
    }

    let mut tex = textured_from_mesh(&mesh);
    debug_assert_eq!(
        layers.len(),
        tex.vertex_count(),
        "ein Ebenen-Eintrag je Vertex"
    );
    tex.layers = layers;
    tex
}

/// Baut das volle Modell-Mesh: erst die Waende (Quader), dann die Deckenplatten
/// (extrudierte Polygone) — alles in EINEN Puffer. Die Wand-Reihenfolge bleibt
/// vorne (deterministische Zaehlung fuer die Wand-Tests).
pub fn build_model_mesh(walls: &[WallInput], slabs: &[SlabInput]) -> Mesh {
    let mut mesh = build_walls_mesh(walls);
    for s in slabs {
        extrude_slab(&mut mesh, s);
    }
    mesh
}

/// Baut die volle Szene: Waende + Deckenplatten (`build_model_mesh`) und haengt
/// danach die rohen Kontext-Meshes (Terrain/importierte Volumen, siehe
/// `MeshInput`) an — alles in EINEN Puffer. Die Wand-/Slab-Reihenfolge bleibt
/// vorne (deterministische Zaehlung fuer die bestehenden Tests); die Kontext-
/// Meshes kommen hinten dran.
pub fn build_scene_mesh(walls: &[WallInput], slabs: &[SlabInput], meshes: &[MeshInput]) -> Mesh {
    let mut mesh = build_model_mesh(walls, slabs);
    for m in meshes {
        append_context_mesh(&mut mesh, m);
    }
    mesh
}

/// Baut NUR die Gelaende-Dreiecke (`MeshKind::Terrain`) zu EINEM Mesh — Grundlage
/// des Luftbild-Overlays (`gpu::aerial_pipeline`): dieselbe Geometrie wie im
/// Hauptpuffer, aber separat, damit sie ein zweites Mal texturiert obenauf
/// gezeichnet werden kann. Leer, wenn kein Terrain vorliegt.
pub fn build_terrain_mesh(meshes: &[MeshInput]) -> Mesh {
    let mut mesh = Mesh::default();
    for m in meshes {
        if matches!(m.kind, crate::types::MeshKind::Terrain) {
            append_context_mesh(&mut mesh, m);
        }
    }
    mesh
}

// ── Rohe Kontext-Meshes (Terrain / importierte Volumen) ──────────────────────

/// Haengt EIN rohes Dreiecks-Mesh (Terrain-TIN oder importiertes Volumen, siehe
/// `MeshInput`) an `mesh` an. `positions` ist ein flaches (x,y,z)-Array in
/// MODELL-Metern (z = Hoehe), `indices` sind Dreiecks-Indizes. Jede Dreiecks-
/// flaeche bekommt eigene Vertices mit ihrer Flaechen-Normale (Flat Shading, wie
/// Wand/Slab) — so ist das Ergebnis unabhaengig von geteilten Vertices im
/// Quell-Mesh.
///
/// Koordinaten: model `(x, y, z)` -> world `(x, z, y)` (Hoehe entlang +Y), exakt
/// wie `extrude_layer_segment`/`extrude_slab` und `Viewport3D.tsx` — GILT NUR
/// fuer `MeshKind::Extrusion` (plan-abgeleitete, orientierungserhaltende
/// Geometrie: Dach/Treppe/Stuetze/truck-Extrusion/2D-Zeichnungs-Bodenspuren,
/// s. u.). `MeshKind::Terrain`/`MeshKind::Imported` (echte, UNABHAENGIGE xyz-
/// Rohdaten aus einem Import) negieren zusaetzlich die Nord-Achse (Modell-y),
/// s. Kommentar an `negate_north` unten.
///
/// DOPPELSEITIG: jedes Dreieck wird ZWEIMAL emittiert (Vorderseite `a,b,c` mit
/// Normale `+n`, Rueckseite `a,c,b` mit `-n`), weil das Quell-Winding von
/// Terrain/Import nicht garantiert ist (three.js rendert sie mit `DoubleSide`).
/// Da der Pfad Rueckseiten cullt (`gpu.rs`), traegt stets das zum Betrachter
/// zeigende Dreieck die korrekte Normale, das andere wird verworfen — keine
/// Z-Fighting (beide liegen deckungsgleich, nur eines ist front-facing).
pub fn append_context_mesh(mesh: &mut Mesh, input: &MeshInput) {
    let pos = &input.positions;
    let vcount = pos.len() / 3;
    let color = input.effective_color();
    // Pro-Vertex-Farben nur nutzen, wenn genau ein RGB je Vertex vorliegt
    // (sonst greift die Einzelfarbe fuers ganze Mesh). Beispiel: Luftbild-Drape.
    let per_vertex = input.vertex_colors.len() >= vcount * 3 && vcount > 0;
    let vcol = |i: usize| -> Rgb {
        if per_vertex {
            let b = i * 3;
            [
                input.vertex_colors[b],
                input.vertex_colors[b + 1],
                input.vertex_colors[b + 2],
            ]
        } else {
            color
        }
    };
    // world-Position aus Modell (x, y, z=Hoehe): (x, hoehe, ±y). Die Nord-Achse
    // (Modell-y) wird NUR fuer `Terrain`/`Imported` NEGIERT — ein reiner
    // Komponenten-Tausch ohne Vorzeichenwechsel ist fuer einen allgemeinen
    // (unabhaengigen) xyz-Punktsatz eine Spiegelung (Determinante -1), das
    // betrifft NUR echte Import-Rohdaten (swisstopo/OSM: Terrain, Gebaeude).
    // `Extrusion` entsteht dagegen IMMER ueber eine orientierungserhaltende
    // Extrusions-/Rotationskonstruktion (Dach/Treppe/Stuetze/truck-Extrusion/
    // 2D-Zeichnungs-Bodenspuren) — dort MUSS die Konvention unveraendert
    // bleiben, exakt wie bei Wand/Slab. Fund 2026-09-24: "swisstopo-Import im
    // 3D komplett gespiegelt" (betraf Kontext-Meshes) — der damalige Fix
    // negierte pauschal ALLE `append_context_mesh`-Aufrufer und brach dabei
    // unbemerkt Dach/Treppe/Stuetze/truck-Extrusion/2D-Zeichnungs-Bodenspuren
    // (Nutzer-Report 2026-09-27: "gewisse Dinge sind noch gespiegelt im 3D",
    // beim Durchgehen ALLER `append_context_mesh`-Aufrufer gefunden — s.
    // PENDENZEN.md fuer die volle Herleitung).
    let negate_north = matches!(input.kind, MeshKind::Terrain | MeshKind::Imported);
    let vworld = |i: usize| -> [f32; 3] {
        let b = i * 3;
        if negate_north {
            [pos[b], pos[b + 2], -pos[b + 1]]
        } else {
            [pos[b], pos[b + 2], pos[b + 1]]
        }
    };
    // [T4] Glatt: Ecken-Normalen je Dreieck (sonst kantig mit der Flaechennormale).
    let smooth = input.crease_angle.filter(|a| a.is_finite() && *a > 0.0).map(|a| smooth_corner_normals(&input.indices, vcount, &vworld, a));
    for (k, t) in input.indices.chunks_exact(3).enumerate() {
        let (ia, ib, ic) = (t[0] as usize, t[1] as usize, t[2] as usize);
        // Fehlerhafte Indizes robust ueberspringen (kein Panic bei kaputter Eingabe).
        if ia >= vcount || ib >= vcount || ic >= vcount {
            continue;
        }
        let a = vworld(ia);
        let b = vworld(ib);
        let c = vworld(ic);
        let (ca, cb, cc) = (vcol(ia), vcol(ib), vcol(ic));
        // Flaechen-Normale (b-a) x (c-a); entartete Dreiecke ueberspringen.
        let ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        let ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        let gn = [
            ab[1] * ac[2] - ab[2] * ac[1],
            ab[2] * ac[0] - ab[0] * ac[2],
            ab[0] * ac[1] - ab[1] * ac[0],
        ];
        let len = (gn[0] * gn[0] + gn[1] * gn[1] + gn[2] * gn[2]).sqrt();
        if len < 1e-12 {
            continue;
        }
        let n = [gn[0] / len, gn[1] / len, gn[2] / len];
        if let Some([na, nb, nc]) = smooth.as_ref().and_then(|s| s.get(k)).copied().flatten() {
            let neg = |v: [f32; 3]| [-v[0], -v[1], -v[2]];
            push_ctx_tri_n(mesh, [a, b, c], [na, nb, nc], [ca, cb, cc]);
            push_ctx_tri_n(mesh, [a, c, b], [neg(na), neg(nc), neg(nb)], [ca, cc, cb]);
            continue;
        }
        // Vorderseite + Rueckseite (siehe Moduldoc: doppelseitig).
        push_ctx_tri(mesh, a, b, c, n, [ca, cb, cc]);
        push_ctx_tri(mesh, a, c, b, [-n[0], -n[1], -n[2]], [ca, cc, cb]);
    }
}

/// [T4] Geteilte Normalen ("split normals") je Dreiecks-Ecke: Summe der flaechengewichteten Normalen
/// aller Dreiecke an derselben Lage (verschweisst ueber die Lage, 0.01 mm Raster), deren Normale um
/// hoechstens `crease_deg` von der des Dreiecks abweicht. Entartete Dreiecke/kaputte Indizes: `None`.
fn smooth_corner_normals(indices: &[u32], vcount: usize, vworld: &dyn Fn(usize) -> [f32; 3], crease_deg: f32) -> Vec<Option<[[f32; 3]; 3]>> {
    use std::collections::HashMap;
    let key = |p: [f32; 3]| [(p[0] as f64 * 1e5).round() as i64, (p[1] as f64 * 1e5).round() as i64, (p[2] as f64 * 1e5).round() as i64];
    let mut weld: HashMap<[i64; 3], usize> = HashMap::new();
    let mut id = vec![usize::MAX; vcount];
    for (i, slot) in id.iter_mut().enumerate() {
        let n = weld.len();
        *slot = *weld.entry(key(vworld(i))).or_insert(n);
    }
    let tris: Vec<Option<([usize; 3], [f32; 3], [f32; 3])>> = indices
        .chunks_exact(3)
        .map(|t| {
            let v = [t[0] as usize, t[1] as usize, t[2] as usize];
            if v.iter().any(|&i| i >= vcount) {
                return None;
            }
            let (a, b, c) = (vworld(v[0]), vworld(v[1]), vworld(v[2]));
            let ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
            let ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
            let g = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
            let l = (g[0] * g[0] + g[1] * g[1] + g[2] * g[2]).sqrt();
            (l >= 1e-12 && l.is_finite()).then(|| ([id[v[0]], id[v[1]], id[v[2]]], g, [g[0] / l, g[1] / l, g[2] / l]))
        })
        .collect();
    let mut around: Vec<Vec<usize>> = vec![Vec::new(); weld.len()];
    for (k, t) in tris.iter().enumerate() {
        if let Some((w, _, _)) = t {
            for &v in w {
                if around[v].last() != Some(&k) {
                    around[v].push(k);
                }
            }
        }
    }
    let cos = crease_deg.min(180.0).to_radians().cos() - 1e-6;
    tris.iter()
        .map(|t| {
            let (w, _, nt) = t.as_ref()?;
            let corner = |v: usize| {
                let mut s = [0.0f32; 3];
                for &f in &around[v] {
                    if let Some((_, g, nf)) = &tris[f] {
                        if nf[0] * nt[0] + nf[1] * nt[1] + nf[2] * nt[2] >= cos {
                            s = [s[0] + g[0], s[1] + g[1], s[2] + g[2]];
                        }
                    }
                }
                let l = (s[0] * s[0] + s[1] * s[1] + s[2] * s[2]).sqrt();
                if l > 1e-20 && l.is_finite() {
                    [s[0] / l, s[1] / l, s[2] / l]
                } else {
                    *nt
                }
            };
            Some([corner(w[0]), corner(w[1]), corner(w[2])])
        })
        .collect()
}

/// Wie [`push_ctx_tri`], mit einer Normale je Ecke ([T4] glatt).
fn push_ctx_tri_n(mesh: &mut Mesh, p: [[f32; 3]; 3], n: [[f32; 3]; 3], colors: [Rgb; 3]) {
    let base = (mesh.verts.len() / FLOATS_PER_VERTEX) as u32;
    for k in 0..3 {
        mesh.verts.extend_from_slice(&[p[k][0], p[k][1], p[k][2], n[k][0], n[k][1], n[k][2], colors[k][0], colors[k][1], colors[k][2]]);
    }
    mesh.indices.extend_from_slice(&[base, base + 1, base + 2]);
}

/// Haengt EIN Dreieck (drei world-Ecken) mit gegebener Normale + Farbe an —
/// Winding wie uebergeben (im Gegensatz zu `push_tri_oriented`, das umsortiert).
/// Wird von `append_context_mesh` fuer beide Seiten genutzt.
fn push_ctx_tri(
    mesh: &mut Mesh,
    a: [f32; 3],
    b: [f32; 3],
    c: [f32; 3],
    normal: [f32; 3],
    colors: [Rgb; 3],
) {
    let base = (mesh.verts.len() / FLOATS_PER_VERTEX) as u32;
    for (p, color) in [a, b, c].iter().zip(colors.iter()) {
        mesh.verts.extend_from_slice(&[
            p[0], p[1], p[2], normal[0], normal[1], normal[2], color[0], color[1], color[2],
        ]);
    }
    mesh.indices.extend_from_slice(&[base, base + 1, base + 2]);
}

// ── Deckenplatten (extrudierte Polygone) ─────────────────────────────────────

/// Signierte Flaeche eines Grundriss-Polygons (Shoelace) in Modell-Koordinaten.
fn signed_area(pts: &[Point2]) -> f32 {
    let mut a = 0.0f32;
    let n = pts.len();
    if n < 3 {
        return 0.0;
    }
    let mut j = n - 1;
    for i in 0..n {
        a += pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
        j = i;
    }
    a * 0.5
}

/// Kreuzprodukt (b-a) x (c-a) im Grundriss.
#[inline]
fn cross2(a: Point2, b: Point2, c: Point2) -> f32 {
    (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
}

/// Liegt p im (a,b,c)-Dreieck? (CCW-orientiert).
fn point_in_tri(a: Point2, b: Point2, c: Point2, p: Point2) -> bool {
    let d1 = cross2(a, b, p);
    let d2 = cross2(b, c, p);
    let d3 = cross2(c, a, p);
    let has_neg = d1 < 0.0 || d2 < 0.0 || d3 < 0.0;
    let has_pos = d1 > 0.0 || d2 > 0.0 || d3 > 0.0;
    !(has_neg && has_pos)
}

/// Ear-Clipping-Triangulierung eines einfachen (lochfreien) Polygons. Robust fuer
/// konvexe UND konkave Ringe. O(n^2) — fuer Decken-Umrisse (wenige Ecken) voellig
/// ausreichend. Liefert Dreiecks-Indizes (0-basiert auf `pts`); leer bei <3 Ecken
/// oder Degeneration. 1:1-Port von `render2d::tessellate::triangulate`.
pub fn triangulate(pts: &[Point2]) -> Vec<u32> {
    let n = pts.len();
    if n < 3 {
        return Vec::new();
    }
    // Ohr-Test unten nutzt cross>0 = konvex (setzt CCW voraus). CW-Polygone drehen.
    let mut idx: Vec<usize> = (0..n).collect();
    if signed_area(pts) < 0.0 {
        idx.reverse();
    }

    let mut tris: Vec<u32> = Vec::new();
    let mut guard = 0usize;
    let max_guard = n * n + 16;

    while idx.len() > 3 && guard < max_guard {
        guard += 1;
        let mut clipped = false;
        let m = idx.len();
        for i in 0..m {
            let i_prev = idx[(i + m - 1) % m];
            let i_cur = idx[i];
            let i_next = idx[(i + 1) % m];
            let a = pts[i_prev];
            let b = pts[i_cur];
            let c = pts[i_next];
            if cross2(a, b, c) <= 0.0 {
                continue; // konkav/kollinear -> kein Ohr
            }
            let mut contains = false;
            for &vi in &idx {
                if vi == i_prev || vi == i_cur || vi == i_next {
                    continue;
                }
                if point_in_tri(a, b, c, pts[vi]) {
                    contains = true;
                    break;
                }
            }
            if contains {
                continue;
            }
            tris.push(i_prev as u32);
            tris.push(i_cur as u32);
            tris.push(i_next as u32);
            idx.remove(i);
            clipped = true;
            break;
        }
        if !clipped {
            break;
        }
    }
    if idx.len() == 3 {
        tris.push(idx[0] as u32);
        tris.push(idx[1] as u32);
        tris.push(idx[2] as u32);
    }
    tris
}

/// Haengt ein Dreieck (drei world-Ecken) mit fester Flaechen-Normale + Farbe an.
/// Die Reihenfolge wird so gedreht, dass die geometrische Normale mit `want_normal`
/// gleich orientiert ist (CCW von aussen -> korrektes Backface-Culling).
fn push_tri_oriented(
    mesh: &mut Mesh,
    a: [f32; 3],
    b: [f32; 3],
    c: [f32; 3],
    want_normal: [f32; 3],
    color: Rgb,
) {
    // Geometrische Normale (b-a) x (c-a).
    let ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    let ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    let gn = [
        ab[1] * ac[2] - ab[2] * ac[1],
        ab[2] * ac[0] - ab[0] * ac[2],
        ab[0] * ac[1] - ab[1] * ac[0],
    ];
    let dot = gn[0] * want_normal[0] + gn[1] * want_normal[1] + gn[2] * want_normal[2];
    let (v0, v1, v2) = if dot < 0.0 { (a, c, b) } else { (a, b, c) };
    let base = (mesh.verts.len() / FLOATS_PER_VERTEX) as u32;
    for p in [v0, v1, v2] {
        mesh.verts.extend_from_slice(&[
            p[0], p[1], p[2], want_normal[0], want_normal[1], want_normal[2], color[0], color[1],
            color[2],
        ]);
    }
    mesh.indices.extend_from_slice(&[base, base + 1, base + 2]);
}

/// Extrudiert EINE Deckenplatte (Slab) und haengt sie an `mesh` an: Deckel (+Y),
/// Boden (−Y) — beide aus der Polygon-Triangulierung — plus die Mantelflaechen
/// (ein Quad je Umriss-Kante). Normalen werden robust nach aussen orientiert
/// (Deckel +Y, Boden −Y, Mantel weg vom Umriss-Schwerpunkt), sodass Culling und
/// Shading unabhaengig von der Umlaufrichtung des Umrisses stimmen.
pub fn extrude_slab(mesh: &mut Mesh, slab: &SlabInput) {
    let pts = &slab.outline;
    let n = pts.len();
    if n < 3 {
        return;
    }
    let y0 = slab.z_bottom.min(slab.z_top);
    let y1 = slab.z_bottom.max(slab.z_top);
    if (y1 - y0) < 1e-6 {
        return;
    }
    let tris = triangulate(pts);
    if tris.is_empty() {
        return;
    }
    let color = slab.color;
    // world-Position: model [x, y] -> (x, hoehe, y).
    let w = |g: Point2, y: f32| -> [f32; 3] { [g[0], y, g[1]] };

    // Deckel (+Y) und Boden (−Y) aus den Triangulierungs-Dreiecken.
    for t in tris.chunks_exact(3) {
        let a = pts[t[0] as usize];
        let b = pts[t[1] as usize];
        let c = pts[t[2] as usize];
        push_tri_oriented(mesh, w(a, y1), w(b, y1), w(c, y1), [0.0, 1.0, 0.0], color);
        push_tri_oriented(mesh, w(a, y0), w(b, y0), w(c, y0), [0.0, -1.0, 0.0], color);
    }

    // Umriss-Schwerpunkt (Grundriss) fuer die Aussenrichtung der Mantel-Normalen.
    let mut cx = 0.0f32;
    let mut cy = 0.0f32;
    for p in pts {
        cx += p[0];
        cy += p[1];
    }
    cx /= n as f32;
    cy /= n as f32;

    // Mantelflaechen: je Kante ein vertikales Quad (unten y0, oben y1).
    for i in 0..n {
        let a = pts[i];
        let b = pts[(i + 1) % n];
        let ex = b[0] - a[0];
        let ez = b[1] - a[1];
        let elen = (ex * ex + ez * ez).sqrt();
        if elen < 1e-9 {
            continue; // entartete Kante
        }
        // Horizontale Kanten-Normale (senkrecht zur Kante), nach aussen orientiert.
        let mx = (a[0] + b[0]) * 0.5;
        let mz = (a[1] + b[1]) * 0.5;
        let out = [mx - cx, mz - cy];
        let mut nx = -ez / elen;
        let mut nz = ex / elen;
        if nx * out[0] + nz * out[1] < 0.0 {
            nx = -nx;
            nz = -nz;
        }
        let normal = [nx, 0.0, nz];
        let ba = w(a, y0);
        let bb = w(b, y0);
        let tb = w(b, y1);
        let ta = w(a, y1);
        // Als zwei orientierte Dreiecke (Winding via push_tri_oriented gesichert).
        push_tri_oriented(mesh, ba, bb, tb, normal, color);
        push_tri_oriented(mesh, ba, tb, ta, normal, color);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::MeshKind;

    /// Regression: Nutzer-Report "swisstopo-Import im 3D komplett gespiegelt"
    /// (2026-09-24). `append_context_mesh` bildete Modell (x,y,z) OHNE
    /// Vorzeichenwechsel auf world (x, z, y) ab — ein reines Achsen-Vertauschen
    /// ohne Negierung ist fuer einen allgemeinen (unabhaengigen) xyz-Punktsatz
    /// immer eine Spiegelung (Determinante -1), anders als bei Wand/Slab, die
    /// ueber eine orientierungserhaltende Extrusion entstehen. Fix: die
    /// Nord-Achse (Modell-y) wird jetzt negiert -> world (x, z, -y).
    #[test]
    fn append_context_mesh_negiert_die_nord_achse() {
        let input = MeshInput {
            // Ein Dreieck; der dritte Punkt (2,3,4) ist der interessante Fall
            // (x=2, y=3=Nord, z=4=Hoehe) -> erwartet world (2, 4, -3).
            positions: vec![0.0, 0.0, 0.0, 2.0, 0.0, 0.0, 2.0, 3.0, 4.0],
            indices: vec![0, 1, 2],
            kind: MeshKind::Imported,
            color: None,
            material_index: None,
            vertex_colors: vec![],
            crease_angle: None,
        };
        let mut mesh = Mesh::default();
        append_context_mesh(&mut mesh, &input);
        // Erstes emittiertes Dreieck (Vorderseite a,b,c) — dritter Vertex (c).
        let base = 2 * FLOATS_PER_VERTEX;
        assert_eq!(&mesh.verts[base..base + 3], &[2.0, 4.0, -3.0]);
    }

    /// [T4] Zwei Dreiecke mit 10°-Knick, Kante NICHT geteilt (eigene Punkte gleicher Lage): glatt mit
    /// 30° bekommen die Kantenpunkte beider Dreiecke dieselbe Normale, mit 5° (oder ohne) die
    /// Flaechennormalen; die Rueckseite traegt die Gegennormale.
    #[test]
    fn glatt_mit_knickwinkel_teilt_normalen() {
        let t = 10f32.to_radians();
        // Dreieck 1 in der Ebene z = 0, Dreieck 2 um die x-Achse (Kante y = 0) um 10° geknickt.
        let positions = vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, -1.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, t.cos(), t.sin()];
        let mk = |crease: Option<f32>| {
            let input = MeshInput { positions: positions.clone(), indices: vec![0, 1, 2, 3, 4, 5], kind: MeshKind::Imported, color: None, material_index: None, vertex_colors: vec![], crease_angle: crease };
            let mut mesh = Mesh::default();
            append_context_mesh(&mut mesh, &input);
            mesh
        };
        let normal = |m: &Mesh, v: usize| -> [f32; 3] {
            let b = v * FLOATS_PER_VERTEX + 3;
            [m.verts[b], m.verts[b + 1], m.verts[b + 2]]
        };
        let close = |a: [f32; 3], b: [f32; 3]| (0..3).all(|i| (a[i] - b[i]).abs() < 1e-5);
        // Vorderseiten: Dreieck 1 = Vertex 0..3, Dreieck 2 = Vertex 6..9 (je 3 Rueckseiten dazwischen).
        let smooth = mk(Some(30.0));
        assert_eq!(smooth.verts.len(), 12 * FLOATS_PER_VERTEX);
        // Kantenpunkt (1,0,0): in Dreieck 1 Ecke 1, in Dreieck 2 Ecke 0.
        assert!(close(normal(&smooth, 1), normal(&smooth, 6)), "{:?} {:?}", normal(&smooth, 1), normal(&smooth, 6));
        // Nicht-Kantenpunkt behaelt einen eigenen Mix: Ecke 2 von Dreieck 1 liegt nur an Dreieck 1.
        assert!(!close(normal(&smooth, 2), normal(&smooth, 1)));
        // Rueckseite = Gegennormale.
        let back = normal(&smooth, 3);
        let front = normal(&smooth, 0);
        assert!(close(back, [-front[0], -front[1], -front[2]]));
        for crease in [Some(5.0), None] {
            let hard = mk(crease);
            assert!(!close(normal(&hard, 1), normal(&hard, 6)));
            assert!(close(normal(&hard, 0), normal(&hard, 1)) && close(normal(&hard, 1), normal(&hard, 2)));
        }
    }
}
