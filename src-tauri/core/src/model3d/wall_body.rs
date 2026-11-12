//! [216] Wandkörper mit Formöffnungen ([G3]: Rund, Rundbogen, Segmentbogen …) für die 3D-Anzeige.
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
//! Nur gerade Wände (Bogenwände behalten die Füllkörper); schlägt ein Boolean fehl, bleibt die Wand wie vorher
//! (Rechteck-Loch) — nie Panik.

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

/// Überlappung benachbarter Stücke (m): Stücke, die genau an einer Fläche zusammenstossen, vereinigt Manifold nicht
/// zu einem Körper — die innere Fläche bleibt (Stossfuge, im 3D als Linie sichtbar). Jedes Stück um `LAP` grösser
/// (alle Seiten, Ebene der Oberkante hoch) überlappt die Nachbarn; die Aussenflächen aller Stücke liegen weiter
/// in einer Ebene.
const LAP: f64 = 1e-4;

/// Stück um [`LAP`] nach allen Seiten vergrössert.
fn inflated(q: &RWall) -> RWall {
    let mut r = q.clone();
    let (dx, dy) = (q.end[0] - q.start[0], q.end[1] - q.start[1]);
    let l = hypot2(dx, dy);
    if !(l > 1e-9) {
        return r;
    }
    let (ux, uy) = (dx / l, dy / l);
    r.start = [q.start[0] - ux * LAP, q.start[1] - uy * LAP];
    r.end = [q.end[0] + ux * LAP, q.end[1] + uy * LAP];
    r.thickness += 2.0 * LAP;
    r.base_elevation -= LAP;
    r.height += 2.0 * LAP;
    if let Some(t) = r.top_plane.as_mut() {
        t[0] += LAP - (t[1] * ux + t[2] * uy) * LAP;
    }
    r
}

/// Teilung je Kante, damit die Dreiecke etwa [`CELL`] gross werden (mindestens 1, höchstens 10).
fn refine_steps(m: &Mesh) -> i32 {
    let longest = m.bounds().map_or(0.0, |(lo, hi)| (0..3).map(|k| hi[k] - lo[k]).fold(0.0, f64::max));
    ((longest / CELL).ceil() as i32).clamp(1, 10)
}

/// Ziel-Kantenlänge (m) der unterteilten Wandflächen.
const CELL: f64 = 1.2;

/// Körper der Stücke `pieces` eines Bandes minus ihre Rechteck-Löcher; `None`, wenn nichts übrig bleibt.
fn band_solid(pieces: &[&RWall]) -> Option<Solid> {
    let mut acc = Solid::empty();
    for q in pieces {
        let Some(m) = wall_piece_mesh(&inflated(q)) else { continue };
        let Ok(mut s) = Solid::new(&m) else { return None };
        // Kleine, gleichförmige Dreiecke: ein Loch in der grossen Wandfläche soll keine langen Dreiecke bis in die Ecken
        // der Fläche ziehen (deren Normalen sind für die Kantenerkennung zu ungenau).
        s = s.refined(refine_steps(&m));
        if let Some(hs) = q.holes.as_deref().filter(|h| !h.is_empty()) {
            let (dx, dy) = (q.end[0] - q.start[0], q.end[1] - q.start[1]);
            let l = hypot2(dx, dy);
            if !(l > 1e-9) {
                continue;
            }
            let f = Frame { origin: q.start, u: [dx / l, dy / l], n: [-dy / l, dx / l] };
            let top = q.base_elevation + q.height;
            for h in hs {
                // Löcher am Rand des Stücks reichen darüber hinaus (keine zusammenfallenden Flächen).
                let (a, b) = (if h.from <= 1e-6 { h.from - OVER } else { h.from }, if h.to >= l - 1e-6 { h.to + OVER } else { h.to });
                let (z0, z1) = (if h.z_bottom <= q.base_elevation + 1e-6 { h.z_bottom - OVER } else { h.z_bottom }, if h.z_top >= top - 1e-6 { h.z_top + OVER } else { h.z_top });
                let lat = q.thickness / 2.0 + OVER;
                let cutter = Solid::new(&axis_box(&f, a, b, z0, z1, -lat, lat)).ok()?;
                s = s.difference(&cutter).ok()?;
            }
        }
        acc = acc.union(&s).ok()?;
    }
    (!acc.is_empty()).then_some(acc)
}

/// Körper der Bänder an die Stücke `out[first..]` hängen (s. Modulkopf). `plain` = die Stücke derselben Wand ohne
/// die Formöffnungen `shaped`.
pub(crate) fn attach_bodies(p: &Project, wall: &Wall, shaped: &[&Opening], plain: &[RWall], bands: usize, stacked: bool, out: &mut [RWall]) {
    if shaped.is_empty() || plain.is_empty() || out.is_empty() {
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
    if cuts.is_empty() {
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
