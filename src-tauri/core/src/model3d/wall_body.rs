//! [216] Wandkörper mit Formöffnungen ([G3]: Rund, Rundbogen, Segmentbogen …) und [231] Öffnungen unter dem Dach für
//! die 3D-Anzeige.
//!
//! Die Wand-Stücke (`wall_pieces`) tragen für eine Formöffnung ein Rechteck-Loch; der Rest zwischen Rechteck
//! und Umriss kam bisher als Füllkörper dazu — viele schmale Quader, deren Kanten im 3D als Streifen und als
//! quadratisches Loch um das runde Fenster sichtbar waren, dazu Stossfugen zwischen den Stücken (Giebelwand:
//! senkrechtes Band vom Fenster bis zum First). Hier entsteht je Wandband EIN Körper: die Stücke derselben
//! Wand ohne die Formöffnungen (die Wand ist dort massiv; die Stücke unter dem Dach behalten ihre ebene
//! Oberkante), vereinigt (Manifold, keine Stossfugen), minus ein Prisma mit dem Umriss der Öffnung (je Schicht
//! um den Schichteinzug [106] versetzt) und minus die Rechteck-Löcher der übrigen Öffnungen. Das Netz hängt
//! als `body` am ersten Stück des Bandes, alle Stücke dieser Bänder sind `no_mesh`: die TS-Fassade (`splitWallBodies`) gibt
//! render3d statt der Stücke das Netz als Mesh.
//! Schnitt, Ansicht, Exporte und Auswahl rechnen mit den unveränderten Stücken weiter.
//!
//! [231] Ebenso jede gerade Wand mit Öffnungen, deren Stücke unter einer Dachfläche liegen (Giebel, Kniestock): dort
//! zerfiel die Wand um jede Öffnung in Pfeiler, Brüstung und Sturz mit je eigener schräger Oberkante (Fugen von der
//! Öffnung bis zum Dach). Für den Körper rechnet `wall_pieces` die Stücke ein zweites Mal mit `keep_holes` (Stücke
//! unter dem Dach behalten ihre Rechteck-Löcher), [`band_solid`] schneidet die Löcher aus und vereinigt.
//!
//! Nur gerade Wände (Bogenwände behalten die Füllkörper bzw. die Streifen unter dem Dach); schlägt ein Boolean fehl,
//! bleibt die Wand wie vorher (Rechteck-Loch) — nie Panik.

use super::*;
use crate::opening_shape as os;
use crate::solid_bool::{Mesh, Solid};

/// Überstand der Schneidkörper über die Wand hinaus (m), damit keine Flächen zusammenfallen.
const OVER: f64 = 0.05;

/// Formöffnungen der Wand, die einen Körper bekommen (gerade Wand, gültiger Umriss).
pub(crate) fn body_openings<'a>(wall: &Wall, openings: &[&'a Opening]) -> Vec<&'a Opening> {
    if crate::wall_arc::WallArc::of_wall(wall).is_some() {
        return Vec::new();
    }
    openings.iter().copied().filter(|o| os::is_shaped(o) && os::opening_outline(o, o.width, o.height).is_some()).collect()
}

/// Weltpunkt einer Öffnungs-Koordinate `(u, v)` mit Querlage `n` zur Wandachse.
struct Frame {
    origin: [f64; 2],
    u: [f64; 2],
    n: [f64; 2],
}

impl Frame {
    fn at(&self, s: f64, nn: f64, z: f64) -> [f64; 3] {
        [self.origin[0] + self.u[0] * s + self.n[0] * nn, self.origin[1] + self.u[1] * s + self.n[1] * nn, z]
    }
}

/// Prisma über dem Umriss `ring` (Koordinaten `u` ab `s0` entlang der Achse, `v` ab `z0`) quer von `n0` bis `n1`.
fn outline_prism(f: &Frame, ring: &[[f64; 2]], s0: f64, z0: f64, n0: f64, n1: f64) -> Mesh {
    let m = Mesh::prism(ring, n0, n1);
    // Prisma-Koordinaten: (x, y) = (u, v), z = Querlage.
    let positions = m.positions.chunks_exact(3).flat_map(|c| f.at(s0 + c[0], c[2], z0 + c[1])).collect();
    Mesh { positions, indices: m.indices }
}

/// Quader entlang der Achse von `s0` bis `s1`, Höhe `z0`…`z1`, quer `n0`…`n1`.
fn axis_box(f: &Frame, s0: f64, s1: f64, z0: f64, z1: f64, n0: f64, n1: f64) -> Mesh {
    let ring = [[s0, z0], [s1, z0], [s1, z1], [s0, z1]];
    outline_prism(f, &ring, 0.0, 0.0, n0, n1)
}

/// Ziel-Kantenlänge (m) der unterteilten Wandflächen.
const CELL: f64 = 1.2;

/// Überlappung (m) der Leibungsstücke mit ihren Nachbarn (s. [`band_solid`]).
const LAP: f64 = 1e-4;

/// Achslänge eines Stücks.
fn piece_len(q: &RWall) -> f64 {
    hypot2(q.end[0] - q.start[0], q.end[1] - q.start[1])
}

/// Querlage `[von, bis]` (auf mm/1000 gerundet) des Stücks `q` im Rahmen des Stücks `main` (linke Normale).
fn lateral_range(main: &RWall, q: &RWall) -> Option<[i64; 2]> {
    let l = piece_len(main);
    if !(l > 1e-9) {
        return None;
    }
    let n = [-(main.end[1] - main.start[1]) / l, (main.end[0] - main.start[0]) / l];
    let o = (q.start[0] - main.start[0]) * n[0] + (q.start[1] - main.start[1]) * n[1];
    let r = |v: f64| (v * 1e6).round() as i64;
    Some([r(o - q.thickness / 2.0), r(o + q.thickness / 2.0)])
}

/// Stück um [`LAP`] quer, an Enden ohne Schnittlinie längs und nach oben/unten vergrössert (nur ohne Dachebene, s.
/// [`band_solid`]).
fn inflated(q: &RWall) -> RWall {
    let mut r = q.clone();
    let l = piece_len(q);
    if !(l > 1e-9) {
        return r;
    }
    let (ux, uy) = ((q.end[0] - q.start[0]) / l, (q.end[1] - q.start[1]) / l);
    if q.start_cut.is_none() {
        r.start = [q.start[0] - ux * LAP, q.start[1] - uy * LAP];
    }
    if q.end_cut.is_none() {
        r.end = [q.end[0] + ux * LAP, q.end[1] + uy * LAP];
    }
    r.thickness += 2.0 * LAP;
    r.base_elevation -= LAP;
    r.height += 2.0 * LAP;
    r
}

/// Körper der Stücke `pieces` eines Bandes minus ihre Rechteck-Löcher; `None`, wenn nichts übrig bleibt.
///
/// [231] Die Stücke werden genau so vereinigt, wie sie sind: Nachbarn stossen an derselben Fläche zusammen (gleiche
/// Schnittlinie am First, gleiches Achsmass), Manifold verschmilzt sie ohne innere Fläche. Dann wird unterteilt (je Stück
/// unterteilt, lägen die Ecken der gemeinsamen Fläche nicht mehr aufeinander, und sie bliebe als Fuge im Körper), dann
/// kommen die Löcher. Eine frühere Überlappung um 0,1 mm (jedes Stück vergrössert) liess am First Kerben und
/// Splitter-Dreiecke stehen, weil die Ebene des einen Stücks über das andere hinaus steigt — daher bleiben die Stücke
/// eines Bandes mit Dachebene genau; ein Band ganz ohne Dachebene wird wie früher vergrössert. Stücke neben dem Band
/// (Leibungsstücke des Schichteinzugs [106]) berühren ihre Nachbarn bloss auf einem Teil einer Fläche — die verschmilzt
/// Manifold nicht; sie kommen um [`LAP`] vergrössert ([`inflated`]) erst nach den Löchern dazu (die Löcher reichen quer
/// über das Band hinaus und schnitten sie sonst weg).
fn band_solid(pieces: &[&RWall]) -> Option<Solid> {
    let main = pieces.iter().max_by(|a, b| piece_len(a).total_cmp(&piece_len(b)))?;
    let main_range = lateral_range(main, main);
    // Leibungsstücke: ebene Stücke quer neben dem Band oder im (um den Schichteinzug erweiterten) Loch eines anderen.
    let holes: Vec<([f64; 3], [f64; 3])> = pieces.iter().flat_map(|q| hole_boxes(q, 0.0)).filter_map(|m| m.bounds()).collect();
    let inside = |q: &RWall| {
        wall_piece_mesh(q).and_then(|m| m.bounds()).is_some_and(|(a, b)| holes.iter().any(|(c, d)| (0..3).all(|k| a[k] < d[k] - 1e-6 && b[k] > c[k] + 1e-6)))
    };
    let is_side = |q: &RWall| q.top_plane.is_none() && (lateral_range(main, q) != main_range || inside(q));
    let (side, band): (Vec<&RWall>, Vec<&RWall>) = pieces.iter().copied().partition(|q| is_side(q));
    let mut acc = Solid::empty();
    let (mut lo, mut hi) = ([f64::INFINITY; 3], [f64::NEG_INFINITY; 3]);
    // Band ganz ohne Dachebene: wie vor [231] um LAP vergrössert (die Aussenfläche liegt 0,1 mm vor anderen Bauteilen in
    // derselben Ebene, z. B. Kniestock darüber — sonst verwechselt die Kantenerkennung im 3D deren Ecken: gestrichelte
    // Scheinkanten). Mit Dachebene bleiben alle Stücke genau (s. oben).
    let flat = band.iter().all(|q| q.top_plane.is_none());
    for q in &band {
        let Some(m) = (if flat { wall_piece_mesh(&inflated(q)) } else { wall_piece_mesh(q) }) else { continue };
        if let Some((a, b)) = m.bounds() {
            for k in 0..3 {
                lo[k] = lo[k].min(a[k]);
                hi[k] = hi[k].max(b[k]);
            }
        }
        acc = acc.union(&Solid::new(&m).ok()?).ok()?;
    }
    // Kleine, gleichförmige Dreiecke: ein Loch in der grossen Wandfläche soll keine langen Dreiecke bis in die Ecken der
    // Fläche ziehen (deren Normalen sind für die Kantenerkennung zu ungenau: gestrichelte Scheinkanten).
    let longest = (0..3).map(|k| hi[k] - lo[k]).fold(0.0, f64::max);
    if !acc.is_empty() {
        acc = acc.refined(((longest / CELL).ceil() as i32).clamp(1, 10));
    }
    for q in &band {
        for b in hole_boxes(q, EDGE) {
            acc = acc.difference(&Solid::new(&b).ok()?).ok()?;
        }
    }
    for q in &side {
        let Some(m) = wall_piece_mesh(&inflated(q)) else { continue };
        let mut s = Solid::new(&m).ok()?;
        for b in hole_boxes(q, OVER) {
            s = s.difference(&Solid::new(&b).ok()?).ok()?;
        }
        acc = acc.union(&s).ok()?;
    }
    (!acc.is_empty()).then_some(acc)
}

/// Überstand (m) eines Lochs im vereinigten Band, dessen Rand genau auf dem Rand seines Stücks liegt: klein, weil der
/// Nachbar jenseits dieses Randes (Stück unter/neben einer Tasche, an einer Stütze) zum selben Körper gehört.
const EDGE: f64 = 1e-3;

/// Quader der Rechteck-Löcher des Stücks `q`. Ein Lochrand genau auf dem Rand des Stücks reicht um `over` darüber hinaus
/// (keine zusammenfallenden Flächen), einer jenseits davon (Öffnung über den First) bleibt, wo er ist; quer immer
/// [`OVER`] über die Dicke hinaus.
fn hole_boxes(q: &RWall, over: f64) -> Vec<Mesh> {
    let Some(hs) = q.holes.as_deref().filter(|h| !h.is_empty()) else { return Vec::new() };
    let l = piece_len(q);
    if !(l > 1e-9) {
        return Vec::new();
    }
    let (dx, dy) = (q.end[0] - q.start[0], q.end[1] - q.start[1]);
    let f = Frame { origin: q.start, u: [dx / l, dy / l], n: [-dy / l, dx / l] };
    let (base, top) = (q.base_elevation, q.base_elevation + q.height);
    let lo = |v: f64, edge: f64| if (v - edge).abs() <= 1e-6 { edge - over } else { v };
    let hi = |v: f64, edge: f64| if (v - edge).abs() <= 1e-6 { edge + over } else { v };
    let lat = q.thickness / 2.0 + OVER;
    hs.iter().map(|h| axis_box(&f, lo(h.from, 0.0), hi(h.to, l), lo(h.z_bottom, base), hi(h.z_top, top), -lat, lat)).collect()
}

/// Körper der Bänder an die Stücke `out[first..]` hängen (s. Modulkopf). `plain` = die Stücke derselben Wand ohne
/// die Formöffnungen `shaped`.
pub(crate) fn attach_bodies(p: &Project, wall: &Wall, shaped: &[&Opening], plain: &[RWall], bands: usize, stacked: bool, out: &mut [RWall]) {
    if plain.is_empty() || out.is_empty() {
        return;
    }
    let wr = wall_ref(p, wall);
    let (zb, zt) = p.wall_vertical_extent(wall);
    let (dx, dy) = (wall.end.x - wall.start.x, wall.end.y - wall.start.y);
    let len = hypot2(dx, dy);
    if !(len > 1e-9) {
        return;
    }
    let f = Frame { origin: [wall.start.x, wall.start.y], u: [dx / len, dy / len], n: [-dy / len, dx / len] };
    let lat = wr.total + 0.4;
    // Je Band: Umrisse der Formöffnungen mit Schichteinzug.
    struct Cut {
        from: f64,
        bottom: f64,
        poly: Vec<[f64; 2]>,
        shift: Vec<[f64; 4]>,
    }
    let mut cuts: Vec<Cut> = Vec::new();
    for o in shaped {
        let Some((from, to)) = opening_geom::opening_interval(&wr, o.position, o.width) else { continue };
        let bottom = zb + o.sill_height.max(0.0);
        let top = zt.min(bottom + o.height);
        let (w, h) = (to - from, top - bottom);
        let Some(poly) = os::opening_outline(o, w, h) else { continue };
        let mut shift = vec![[0.0; 4]; bands];
        if stacked {
            if let Some(r) = crate::opening_detail::opening_reveal(p, wall, o).filter(|r| r.thick.len() == bands) {
                for (k, side) in r.sides.iter().enumerate() {
                    for a in side {
                        if let Some(s) = shift.get_mut(a.layer) {
                            s[k] = a.shift;
                        }
                    }
                }
            }
        }
        cuts.push(Cut { from, bottom, poly, shift });
    }
    if cuts.len() < shaped.len() {
        return;
    }
    let mut done = vec![false; bands];
    let mut bodies: Vec<(usize, WallBody)> = Vec::new();
    for band in 0..bands {
        let pieces: Vec<&RWall> = plain.iter().filter(|q| q.band == band).collect();
        if pieces.is_empty() {
            continue;
        }
        let Some(mut solid) = band_solid(&pieces) else { continue };
        let mut ok = true;
        for c in &cuts {
            let s = c.shift[band];
            let ring = if s.iter().any(|v| *v > 1e-9) { os::outset_sides(&c.poly, s) } else { c.poly.clone() };
            match Solid::new(&outline_prism(&f, &ring, c.from, c.bottom, -lat, lat)).and_then(|cut| solid.difference(&cut)) {
                Ok(r) => solid = r,
                Err(_) => {
                    ok = false;
                    break;
                }
            }
        }
        if !ok || solid.is_empty() {
            continue;
        }
        let m = solid.to_mesh_raw();
        if m.is_empty() {
            continue;
        }
        done[band] = true;
        bodies.push((band, WallBody { positions: m.positions, indices: m.indices }));
    }
    // Stücke der Bänder mit Körper nicht extrudieren; den Körper ans erste Stück des Bandes hängen.
    for q in out.iter_mut() {
        if done.get(q.band).copied().unwrap_or(false) {
            q.no_mesh = true;
        }
    }
    for (band, body) in bodies {
        if let Some(q) = out.iter_mut().find(|q| q.band == band) {
            q.body = Some(body);
        }
    }
}
