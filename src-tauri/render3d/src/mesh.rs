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
    Mesh, MeshInput, Opening, Point2, Rgb, SlabInput, WallInput, WallLayer, FLOATS_PER_VERTEX,
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
    let segments = wall_solid_segments(length, &wall.openings, z0, z1);

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
            extrude_layer_segment(
                mesh, wall, n, length, a0, a1, y0, y1, off_a, off_b, start_cut, end_cut,
                layer.color,
            );
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
    let t0 = w(g0, y1);
    let t1 = w(g1, y1);
    let t2 = w(g2, y1);
    let t3 = w(g3, y1);

    // Sechs Seiten als Quads (Ecken CCW von aussen gesehen -> Normale zeigt raus).
    // Deckel oben (+Y): t0,t1,t2,t3 von oben CCW.
    push_quad(mesh, t0, t1, t2, t3, [0.0, 1.0, 0.0], color);
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
    out
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

// ── Rohe Kontext-Meshes (Terrain / importierte Volumen) ──────────────────────

/// Haengt EIN rohes Dreiecks-Mesh (Terrain-TIN oder importiertes Volumen, siehe
/// `MeshInput`) an `mesh` an. `positions` ist ein flaches (x,y,z)-Array in
/// MODELL-Metern (z = Hoehe), `indices` sind Dreiecks-Indizes. Jede Dreiecks-
/// flaeche bekommt eigene Vertices mit ihrer Flaechen-Normale (Flat Shading, wie
/// Wand/Slab) — so ist das Ergebnis unabhaengig von geteilten Vertices im
/// Quell-Mesh.
///
/// Koordinaten: model `(x, y, z)` -> world `(x, z, y)` (Hoehe entlang +Y), exakt
/// wie `extrude_layer_segment`/`extrude_slab` und `Viewport3D.tsx`.
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
    // world-Position aus Modell (x, y, z=Hoehe): (x, hoehe, y).
    let vworld = |i: usize| -> [f32; 3] {
        let b = i * 3;
        [pos[b], pos[b + 2], pos[b + 1]]
    };
    for t in input.indices.chunks_exact(3) {
        let (ia, ib, ic) = (t[0] as usize, t[1] as usize, t[2] as usize);
        // Fehlerhafte Indizes robust ueberspringen (kein Panic bei kaputter Eingabe).
        if ia >= vcount || ib >= vcount || ic >= vcount {
            continue;
        }
        let a = vworld(ia);
        let b = vworld(ib);
        let c = vworld(ic);
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
        // Vorderseite + Rueckseite (siehe Moduldoc: doppelseitig).
        push_ctx_tri(mesh, a, b, c, n, color);
        push_ctx_tri(mesh, a, c, b, [-n[0], -n[1], -n[2]], color);
    }
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
    color: Rgb,
) {
    let base = (mesh.verts.len() / FLOATS_PER_VERTEX) as u32;
    for p in [a, b, c] {
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
