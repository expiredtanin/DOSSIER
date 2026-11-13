//! Ansichtsschraffur auf Flächen ausserhalb der Ansicht ([100]): Bodenbeläge (Oberseite der Decken,
//! oberste Schicht) im Grundriss sowie alle Musterflächen im 3D (Wandseiten, Dachflächen, Deckenober-
//! und -untersicht) als Linien für render3d.
//!
//! 3D-Ausdünnung nach Abstand: Je Fläche wird das Muster für eine Leiter von Massstäben
//! ([`LOD_SCALES`], wie die 2D-Ausdünnung in `surface_pattern::segments`) gerechnet; jede Linie trägt
//! eine Bitmaske der Stufen, in denen sie vorkommt. render3d wählt je Linie aus ihrem Bildschirm-
//! Massstab (px je Meter an ihrer Lage) die passende Stufe und zeichnet nur deren Linien — nah alle
//! Fugen, weit weg jede 2./4./8. Linie, noch weiter keine (kein Moiré).
//!
//! Puffer (`f32`, [`PATTERN_STRIDE`] je Linie): `ax, ay, az, bx, by, bz, r, g, b, maske` in Welt-Metern
//! (Plan `(x, y)` + Höhe `z` → Welt `(x, z, y)`, wie `drawing_line_verts`).

use crate::model::{Ceiling, Component, Project, SurfacePattern, Wall};
use crate::surface_pattern::{self as sp, Spec, P};
use std::collections::HashMap;

/// Massstabs-Leiter der 3D-Ausdünnung (Bit i der Maske = Stufe `LOD_SCALES[i]`); render3d kennt dieselbe.
pub const LOD_SCALES: [f64; 7] = [25.0, 50.0, 100.0, 200.0, 400.0, 800.0, 1600.0];
/// Floats je Linie im 3D-Puffer.
pub const PATTERN_STRIDE: usize = 10;
/// Abstand der Musterlinien vor der Fläche (m), gegen Z-Fighting.
const LIFT: f64 = 0.003;
const INK: &str = "#3a3f47";

/// Muster und Bauteil einer Fläche.
fn spec_for<'a>(comp: Option<&'a Component>, angle: f64) -> Option<(&'a SurfacePattern, &'a Component, Spec)> {
    let comp = comp?;
    let pat = comp.surface_pattern.as_ref()?;
    Some((pat, comp, sp::spec_of(pat, angle)?))
}

fn ink_rgb(pat: &SurfacePattern, comp: &Component) -> [f64; 3] {
    let c = pat.color.as_deref().or(comp.foreground.as_deref()).filter(|c| !c.trim().is_empty()).unwrap_or(INK);
    crate::style::hex_to_rgb(c, [0.23, 0.25, 0.28])
}

/// Ring mit Löchern (gerade-ungerade-Regel über Brücken-Kanten) für `surface_pattern::segments`.
fn ring_with_holes(outer: &[P], holes: &[Vec<P>]) -> Vec<P> {
    if holes.is_empty() {
        return outer.to_vec();
    }
    crate::polygon_holes::merge_holes(outer, holes, 1e-4).ring
}

/// Segmente je Massstabs-Stufe zusammengeführt: (a, b, Maske).
fn lod_segments(f: impl Fn(f64) -> Vec<(P, P)>) -> Vec<(P, P, u8)> {
    let mut idx: HashMap<[i64; 4], usize> = HashMap::new();
    let mut out: Vec<(P, P, u8)> = Vec::new();
    let q = |v: f64| (v * 1e5).round() as i64;
    for (i, &s) in LOD_SCALES.iter().enumerate() {
        for (a, b) in f(s) {
            let (a, b) = if (a[0], a[1]) <= (b[0], b[1]) { (a, b) } else { (b, a) };
            let key = [q(a[0]), q(a[1]), q(b[0]), q(b[1])];
            match idx.get(&key) {
                Some(&k) => out[k].2 |= 1 << i,
                None => {
                    idx.insert(key, out.len());
                    out.push((a, b, 1 << i));
                }
            }
        }
    }
    out
}

/// Bodenbelag im Grundriss: Muster der obersten Deckenschicht auf dem Deckenumriss (ohne Aussparungen),
/// in Plan-Koordinaten; Ausrichtung am Plan (x), Ursprung am ersten Umrisspunkt. [156] Teilung auf dem
/// Papier nicht enger als `plan::floor_finish::MIN_PAPER_MM`, Strich als feine Tusche (0.02–0.05 mm, grau).
/// Dazu das Bauteil der Belagsschicht (Name für Regeln, Plattenbelag?).
pub fn floor_finish_segments<'a>(p: &'a Project, ce: &Ceiling, scale: f64) -> Option<(Vec<(P, P)>, f64, String, &'a Component)> {
    let layers = crate::model3d::ceiling_type_ref(p, ce).map(|t| t.2)?;
    let (pat, comp, spec) = spec_for(layers.first().and_then(|l| p.component(&l.component_id)), 0.0)?;
    let (outer, holes) = ceiling_rings(ce)?;
    let segs = sp::segments(&ring_with_holes(&outer, &holes), &spec, outer[0], crate::plan::floor_finish::thinning_scale(scale));
    let w = crate::plan::floor_finish::weight(pat.weight_mm);
    Some((segs, w, crate::plan::floor_finish::INK.to_string(), comp))
}

/// Deckenuntersicht im Deckenspiegel ([100]): Muster der untersten Deckenschicht auf dem Deckenumriss
/// mit den Aussparungen `holes` (auch gehostete Öffnungen), in Plan-Koordinaten wie
/// [`floor_finish_segments`] (der Deckenspiegel deckt den Grundriss).
pub fn soffit_segments(p: &Project, ce: &Ceiling, holes: &[Vec<P>], scale: f64) -> Option<(Vec<(P, P)>, f64, String)> {
    let layers = crate::model3d::ceiling_type_ref(p, ce).map(|t| t.2)?;
    let (pat, comp, spec) = spec_for(layers.last().and_then(|l| p.component(&l.component_id)), 0.0)?;
    let (outer, _) = ceiling_rings(ce)?;
    let segs = sp::segments(&ring_with_holes(&outer, holes), &spec, outer[0], scale);
    let w = pat.weight_mm.filter(|w| w.is_finite() && *w > 0.0).unwrap_or(0.1);
    let ink = pat.color.as_deref().or(comp.foreground.as_deref()).filter(|c| !c.trim().is_empty()).unwrap_or(INK).to_string();
    Some((segs, w, ink))
}

fn ceiling_rings(ce: &Ceiling) -> Option<(Vec<P>, Vec<Vec<P>>)> {
    let outer: Vec<P> = ce.ring_xy();
    if outer.len() < 3 || outer.iter().any(|q| !q[0].is_finite() || !q[1].is_finite()) {
        return None;
    }
    let holes = ce.hole_rings().iter().filter(|h| h.len() >= 3).map(|h| h.iter().map(|v| [v.x, v.y]).collect()).collect();
    Some((outer, holes))
}

struct Sink<'a> {
    out: Vec<f32>,
    /// Explosionsversatz ([65]) des aktuellen Bauteils (Höhe, m).
    dz: f64,
    /// Geschoss-Kontexte (Decken, Dächer) für die Wand-Oberkante unter dem Dach, je Geschoss einmal.
    ctx: &'a mut HashMap<String, crate::wall_bands::FloorContext>,
    /// Farb-Karten-Liste der Wände (`wall_material_color_maps`), von `wall_pieces` gebraucht.
    maps: &'a [String],
}

impl Sink<'_> {
    fn push(&mut self, a: [f64; 3], b: [f64; 3], rgb: [f64; 3], mask: u8) {
        // Plan (x, y, z) → Welt (x, z, y).
        for v in [a[0], a[2] + self.dz, a[1], b[0], b[2] + self.dz, b[1], rgb[0], rgb[1], rgb[2], mask as f64] {
            self.out.push(v as f32);
        }
    }
}

/// Alle Musterlinien des Projekts für render3d (s. Modulkopf).
pub fn pattern_lines_3d(p: &Project) -> Vec<f32> {
    pattern_lines_3d_exploded(p, 0.0)
}

/// Wie `pattern_lines_3d`, mit Explosionsabstand `gap` ([65], ≤ 0 = aus): die Linien heben sich mit dem Geschoss ihres Bauteils.
pub fn pattern_lines_3d_exploded(p: &Project, gap: f64) -> Vec<f32> {
    pattern_lines_3d_filtered(p, gap, &crate::model3d::ClassFilter::none())
}

/// Wie [`pattern_lines_3d_exploded`], ohne die Muster der Bauteile ausgeblendeter Klassen ([180]).
/// Ohne Zwischenspeicher (Tests, Vergleich); das Dokument nutzt [`PatternCache`].
pub fn pattern_lines_3d_filtered(p: &Project, gap: f64, filter: &crate::model3d::ClassFilter) -> Vec<f32> {
    let ex = crate::explode3d::Explode::new(p, gap);
    let dz_of = |id: &str| ex.as_ref().map_or(0.0, |e| e.of(id));
    let maps = crate::model3d::wall_material_color_maps(p);
    let mut ctx = HashMap::new();
    let mut s = Sink { out: Vec::new(), dz: 0.0, ctx: &mut ctx, maps: &maps };
    for w in p.walls.iter().filter(|w| !filter.hides(&w.id)) {
        s.dz = dz_of(&w.id);
        wall_lines(p, w, &mut s);
    }
    for ce in p.ceilings.as_deref().unwrap_or(&[]).iter().filter(|c| !filter.hides(&c.id)) {
        s.dz = dz_of(&ce.id);
        ceiling_lines(p, ce, &mut s);
    }
    for roof in p.roofs.as_deref().unwrap_or(&[]).iter().filter(|r| !filter.hides(&r.id)) {
        s.dz = dz_of(&roof.id);
        roof_lines(p, roof, &mut s);
    }
    s.out
}

/// Felder, die das Muster nicht liest oder die der Zwischenspeicher je Element verfolgt (wie `model3d_cache`,
/// dazu Decken und Dächer: ihre Muster hängen nur am eigenen Element, die Wand-Oberkante unter dem Dach am
/// Geschoss-Kontext, s. [`PatternCache`]).
const NOT_GLOBAL: &[&str] = &["walls", "openings", "ceilings", "roofs", "drawings2d", "viewSnapshots", "viewSnapshotFolders", "viewTemplates", "layers"];

#[derive(Clone, Debug)]
struct WallPat {
    dz: u64,
    openings: Vec<u64>,
    /// Stand des Geschoss-Kontexts, soweit die Wand ihn liest (sonst 0).
    ctx_gen: u64,
    lines: Vec<f32>,
}

#[derive(Clone, Debug)]
struct FacePat {
    dz: u64,
    lines: Vec<f32>,
}

/// [214] Zwischenspeicher der Flächenmuster je Wand, Decke und Dach (Schlüssel: Element-Stand, `Revs::items`).
/// Neu gerechnet wird nur, was sich ändert: die Wand selbst (samt gehosteter Öffnungen), eine Wand, deren Geschoss-
/// Kontext (Decken-Eingabe, Dächer) sich ändert, und Decke bzw. Dach selbst. Jede andere Änderung (Typen, Baustoffe,
/// Geschosse …) verwirft alles. Einträge ausgeblendeter Klassen bleiben (die Geisterschicht fragt mit anderem Filter);
/// Einträge verschwundener Elemente fallen weg. Ergebnis gleich [`pattern_lines_3d_filtered`] (Test).
#[derive(Debug, Default)]
pub struct PatternCache {
    sig: Option<(u64, u64)>,
    maps: Vec<String>,
    ctx: HashMap<String, crate::wall_bands::FloorContext>,
    ctx_gen: HashMap<String, u64>,
    counter: u64,
    walls: HashMap<u64, WallPat>,
    ceilings: HashMap<u64, FacePat>,
    roofs: HashMap<u64, FacePat>,
    /// Statistik (Tests): im letzten Aufruf neu gerechnete Wände / Decken / Dächer.
    pub last_rebuilt: (usize, usize, usize),
}

impl Clone for PatternCache {
    fn clone(&self) -> Self {
        PatternCache::default()
    }
}

impl PatternCache {
    /// Wie [`pattern_lines_3d_filtered`], mit Element-Ständen der Wände, Öffnungen, Decken und Dächer.
    #[allow(clippy::too_many_arguments)]
    pub fn lines(&mut self, p: &Project, revs: &crate::document::Revs, wall_stamps: &[u64], opening_stamps: &[u64], ceiling_stamps: &[u64], roof_stamps: &[u64], gap: f64, filter: &crate::model3d::ClassFilter) -> Vec<f32> {
        let openings = p.openings.as_deref().unwrap_or(&[]);
        let ceilings = p.ceilings.as_deref().unwrap_or(&[]);
        let roofs = p.roofs.as_deref().unwrap_or(&[]);
        if wall_stamps.len() != p.walls.len() || opening_stamps.len() != openings.len() || ceiling_stamps.len() != ceilings.len() || roof_stamps.len() != roofs.len() {
            return pattern_lines_3d_filtered(p, gap, filter);
        }
        // Ohne ein einziges Muster im Projekt gibt es nichts zu rechnen oder zu merken.
        if !p.components.iter().any(|c| c.surface_pattern.is_some()) {
            self.last_rebuilt = (0, 0, 0);
            return Vec::new();
        }
        let sig = (revs.epoch(), revs.max_except(NOT_GLOBAL));
        let maps = crate::model3d::wall_material_color_maps(p);
        if self.sig != Some(sig) || self.maps != maps {
            *self = PatternCache { sig: Some(sig), maps, ..Default::default() };
        }
        let ex = crate::explode3d::Explode::new(p, gap);
        let dz_of = |id: &str| ex.as_ref().map_or(0.0, |e| e.of(id));
        let mut by_wall: HashMap<&str, Vec<usize>> = HashMap::new();
        for (i, o) in openings.iter().enumerate() {
            by_wall.entry(o.host_wall_id.as_str()).or_default().push(i);
        }
        // Geschoss-Kontexte (nur mit Dächern gelesen): ändert sich die Eingabe, neuer Stand → Wände des Geschosses neu.
        if !roofs.is_empty() {
            let mut floors: Vec<&str> = Vec::new();
            for w in p.walls.iter().filter(|w| !filter.hides(&w.id) && w.roof_attach != Some(false) && wall_patterned(p, w)) {
                if !floors.contains(&w.floor_id.as_str()) {
                    floors.push(w.floor_id.as_str());
                }
            }
            for f in floors {
                let fresh = crate::model3d::floor_context_with(p, f, true, None);
                if self.ctx.get(f).is_none_or(|old| !old.same_input(&fresh)) {
                    self.counter += 1;
                    self.ctx_gen.insert(f.to_owned(), self.counter);
                    self.ctx.insert(f.to_owned(), fresh);
                }
            }
        }
        let mut rebuilt = (0, 0, 0);
        let mut out: Vec<f32> = Vec::new();
        let mut old_walls = std::mem::take(&mut self.walls);
        let mut fresh_walls: HashMap<u64, WallPat> = HashMap::with_capacity(p.walls.len());
        for (wi, w) in p.walls.iter().enumerate() {
            let stamp = wall_stamps[wi];
            let hidden = filter.hides(&w.id);
            let entry = old_walls.remove(&stamp);
            let dz = dz_of(&w.id);
            let os: Vec<u64> = by_wall.get(w.id.as_str()).map_or(&[][..], |v| v.as_slice()).iter().map(|&i| opening_stamps[i]).collect();
            // Liest die Wand den Geschoss-Kontext? (wie `wall_top_profile`; Bogenwände nie)
            let reads_ctx = !roofs.is_empty() && w.roof_attach != Some(false) && crate::wall_arc::WallArc::of_wall(w).is_none();
            let gen = if reads_ctx { self.ctx_gen.get(&w.floor_id).copied().unwrap_or(0) } else { 0 };
            let e = match entry {
                Some(e) if hidden || (e.dz == dz.to_bits() && e.openings == os && e.ctx_gen == gen) => e,
                _ if hidden => continue,
                _ => {
                    rebuilt.0 += 1;
                    let mut s = Sink { out: Vec::new(), dz, ctx: &mut self.ctx, maps: &self.maps };
                    wall_lines(p, w, &mut s);
                    WallPat { dz: dz.to_bits(), openings: os, ctx_gen: gen, lines: s.out }
                }
            };
            if !hidden {
                out.extend_from_slice(&e.lines);
            }
            fresh_walls.insert(stamp, e);
        }
        self.walls = fresh_walls;
        // Decken, dann Dächer (Reihenfolge wie im ungepufferten Pfad).
        for kind in 0..2 {
            let (stamps, old_map) = if kind == 0 { (ceiling_stamps, &mut self.ceilings) } else { (roof_stamps, &mut self.roofs) };
            let mut old = std::mem::take(old_map);
            let mut fresh: HashMap<u64, FacePat> = HashMap::with_capacity(stamps.len());
            for (i, &stamp) in stamps.iter().enumerate() {
                let id = if kind == 0 { ceilings[i].id.as_str() } else { roofs[i].id.as_str() };
                let hidden = filter.hides(id);
                let dz = dz_of(id);
                let e = match old.remove(&stamp) {
                    Some(e) if hidden || e.dz == dz.to_bits() => e,
                    _ if hidden => continue,
                    _ => {
                        let mut s = Sink { out: Vec::new(), dz, ctx: &mut self.ctx, maps: &self.maps };
                        if kind == 0 {
                            rebuilt.1 += 1;
                            ceiling_lines(p, &ceilings[i], &mut s);
                        } else {
                            rebuilt.2 += 1;
                            roof_lines(p, &roofs[i], &mut s);
                        }
                        FacePat { dz: dz.to_bits(), lines: s.out }
                    }
                };
                if !hidden {
                    out.extend_from_slice(&e.lines);
                }
                fresh.insert(stamp, e);
            }
            *(if kind == 0 { &mut self.ceilings } else { &mut self.roofs }) = fresh;
        }
        self.last_rebuilt = rebuilt;
        out
    }
}

/// Hat eine Seite der Wand ein Flächenmuster? (Nur dann liest `wall_lines` den Geschoss-Kontext.)
fn wall_patterned(p: &Project, w: &Wall) -> bool {
    let Some(wt) = p.wall_type(w) else { return false };
    [wt.layers.first(), wt.layers.last()].into_iter().flatten().any(|l| spec_for(p.component(&l.component_id), w.surface_pattern_angle.unwrap_or(0.0)).is_some())
}

/// Muster der Dachflächen (Schicht 1 des Dachaufbaus).
fn roof_lines(p: &Project, roof: &crate::model::Roof, s: &mut Sink) {
    let Some((pat, comp, spec)) = spec_for(p.roof_layers(roof).first().and_then(|l| p.component(&l.component_id)), roof.surface_pattern_angle.unwrap_or(0.0)) else { return };
    let rgb = ink_rgb(pat, comp);
    let off = roof.surface_pattern_offset.as_ref().map_or([0.0, 0.0], |o| [o.x, o.y]);
    let g = crate::roof::roof_geometry(&roof.params(), p.roof_base_elevation(roof));
    for plane in &g.planes {
        let n = newell(plane);
        let n = if n[2] < 0.0 { [-n[0], -n[1], -n[2]] } else { n };
        let lift = |q: [f64; 3]| [q[0] + n[0] * LIFT, q[1] + n[1] * LIFT, q[2] + n[2] * LIFT];
        let mut idx: HashMap<[i64; 6], usize> = HashMap::new();
        let mut segs: Vec<([f64; 3], [f64; 3], u8)> = Vec::new();
        let q = |v: f64| (v * 1e5).round() as i64;
        for (i, &sc) in LOD_SCALES.iter().enumerate() {
            for (a, b) in sp::segments_3d(plane, &spec, off, sc) {
                let key = [q(a[0]), q(a[1]), q(a[2]), q(b[0]), q(b[1]), q(b[2])];
                match idx.get(&key) {
                    Some(&k) => segs[k].2 |= 1 << i,
                    None => {
                        idx.insert(key, segs.len());
                        segs.push((a, b, 1 << i));
                    }
                }
            }
        }
        for (a, b, m) in segs {
            s.push(lift(a), lift(b), rgb, m);
        }
    }
}

fn newell(poly: &[[f64; 3]]) -> [f64; 3] {
    let mut n = [0.0; 3];
    for i in 0..poly.len() {
        let (a, b) = (poly[i], poly[(i + 1) % poly.len()]);
        n[0] += (a[1] - b[1]) * (a[2] + b[2]);
        n[1] += (a[2] - b[2]) * (a[0] + b[0]);
        n[2] += (a[0] - b[0]) * (a[1] + b[1]);
    }
    let l = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
    if l > 1e-12 && l.is_finite() {
        [n[0] / l, n[1] / l, n[2] / l]
    } else {
        [0.0, 0.0, 1.0]
    }
}

/// Beide Wandseiten: rechts der Achse die äusserste Schicht (`layers[0]`), links die innerste — wie
/// die Ansicht. Wand-Koordinaten: x ab Wandanfang, y ab UK; Öffnungen ausgespart.
fn wall_lines(p: &Project, w: &Wall, s: &mut Sink) {
    // Bogenwände ([T2]): Muster auf der abgewickelten Fläche, entlang des Bogens gebogen.
    if let Some(arc) = crate::wall_arc::WallArc::of_wall(w) {
        return arc_wall_lines(p, w, &arc, s);
    }
    let (dx, dy) = (w.end.x - w.start.x, w.end.y - w.start.y);
    let len = crate::jsmath::hypot2(dx, dy);
    if !(len > 1e-6) || !len.is_finite() {
        return;
    }
    let Some(wt) = p.wall_type(w) else { return };
    let (z0, z1) = p.wall_vertical_extent(w);
    if !(z1 - z0 > 1e-6) {
        return;
    }
    let total = crate::model::Project::type_thickness(&wt.layers);
    let ref_off = crate::joins::reference_offset(crate::model3d::wall_reference(w), total);
    let (ux, uy) = (dx / len, dy / len);
    let (nx, ny) = (-uy, ux); // linke Normale
    let off = w.surface_pattern_offset.as_ref().map_or([0.0, 0.0], |o| [o.x, o.y]);
    for (layer, side) in [(wt.layers.first(), -1.0), (wt.layers.last(), 1.0)] {
        let Some((pat, comp, spec)) = spec_for(layer.and_then(|l| p.component(&l.component_id)), w.surface_pattern_angle.unwrap_or(0.0)) else { continue };
        let rgb = ink_rgb(pat, comp);
        // Wandmitte = Achse − n·ref_off; Seite ± halbe Dicke (+ Abstand gegen Z-Fighting).
        let d = -ref_off + side * (total / 2.0 + LIFT);
        // Wandfläche in Wand-Koordinaten (x ab Wandanfang, y ab UK): Oberkante wie der Körper (Giebel, Pultwand unter dem
        // Dach) und zwar AN DIESER SEITE: die Dachfläche schneidet die Wand quer zur Achse in unterschiedlicher Höhe
        // ([233]: auf der Achse gemessen ragten die Striche auf der Traufseite bis 15 cm über den Körper hinaus).
        let top = wall_top_profile(p, w, s, len, d).unwrap_or_else(|| vec![[0.0, z1 - z0], [len, z1 - z0]]);
        let top_at = |x: f64| profile_at(&top, x);
        let mut holes: Vec<Vec<P>> = Vec::new();
        for o in p.openings.as_deref().unwrap_or(&[]).iter().filter(|o| o.host_wall_id == w.id) {
            let from = o.position.max(0.0).min(len);
            let to = (o.position + o.width).max(from).min(len);
            let b = o.sill_height.max(0.0);
            let t = (b + o.height).min(z1 - z0);
            if !(to - from > 1e-4 && t - b > 1e-4) {
                continue;
            }
            // Öffnung, die in die Dachschräge ragt: ihre Lage am Rand der Fläche lässt sich nicht als Loch im Ring
            // führen, die Musterlinien laufen dort bis zum Rand (wie vor der Dachkante).
            if top_at(from).min(top_at(to)) <= t + 1e-4 {
                continue;
            }
            match crate::opening_shape::opening_outline(o, to - from, t - b) {
                Some(poly) => holes.push(poly.iter().map(|q| [from + q[0], b + q[1]]).collect()),
                None => holes.push(vec![[from, b], [to, b], [to, t], [from, t]]),
            }
        }
        let mut outer: Vec<P> = vec![[0.0, 0.0], [len, 0.0]];
        outer.extend(top.iter().rev().map(|q| [q[0], q[1].max(1e-6)]));
        let face = ring_with_holes(&outer, &holes);
        let (ox, oy) = (w.start.x + nx * d, w.start.y + ny * d);
        for (a, b, m) in lod_segments(|sc| sp::segments(&face, &spec, off, sc)) {
            let at = |q: P| [ox + ux * q[0], oy + uy * q[0], z0 + q[1]];
            s.push(at(a), at(b), rgb, m);
        }
    }
}

/// Höhe der Oberkante-Linie `top` (Punkte `[x, höhe]`, nach x sortiert) bei `x`, linear dazwischen.
fn profile_at(top: &[P], x: f64) -> f64 {
    let Some(first) = top.first() else { return 0.0 };
    if x <= first[0] {
        return first[1];
    }
    for pair in top.windows(2) {
        if x <= pair[1][0] {
            let span = pair[1][0] - pair[0][0];
            return if span > 1e-12 { pair[0][1] + (pair[1][1] - pair[0][1]) * (x - pair[0][0]) / span } else { pair[1][1] };
        }
    }
    top.last().map_or(0.0, |q| q[1])
}

/// Oberkante der Wand entlang der Linie im Abstand `d` links der Achse (Wandseite) als Linie `[x ab Wandanfang, Höhe ab UK]`: die Körper der Wand unter
/// den Dächern (Giebel, Pultwand, Kniestock) zeigen ihre Oberkante an der Dach-Unterkante; die Musterlinien
/// einer Wandseite dürfen nicht darüber hinausragen. `None` ohne Körper (die Wand zeigt dann das Rechteck).
fn wall_top_profile(p: &Project, w: &Wall, s: &mut Sink<'_>, len: f64, d: f64) -> Option<Vec<P>> {
    let (z0, z1) = p.wall_vertical_extent(w);
    if !p.roofs.as_deref().is_some_and(|r| !r.is_empty()) || w.roof_attach == Some(false) {
        return Some(vec![[0.0, z1 - z0], [len, z1 - z0]]);
    }
    let ctx = s.ctx.entry(w.floor_id.clone()).or_insert_with(|| crate::model3d::floor_context_with(p, &w.floor_id, true, None));
    let mut pieces = Vec::new();
    crate::model3d::wall_pieces(p, s.maps, w, ctx, &[], crate::joins::WallCuts::default(), true, false, &mut pieces);
    if pieces.is_empty() {
        return None;
    }
    let (dx, dy) = (w.end.x - w.start.x, w.end.y - w.start.y);
    let (ux, uy) = (dx / len, dy / len);
    let along = |q: [f64; 2]| (q[0] - w.start.x) * ux + (q[1] - w.start.y) * uy;
    let mut xs: Vec<f64> = vec![0.0, len];
    for pc in &pieces {
        xs.extend([along(pc.start), along(pc.end)].map(|x| x.clamp(0.0, len)));
    }
    xs.sort_by(f64::total_cmp);
    xs.dedup_by(|a, b| (*a - *b).abs() < 1e-6);
    // Höhe an Stelle x: höchste Oberkante der Körper, die x überdecken (auf der Linie im Abstand `d` links der Achse, also an der Wandseite).
    let height_at = |x: f64| -> Option<f64> {
        let mut best: Option<f64> = None;
        for pc in &pieces {
            let (a, b) = (along(pc.start), along(pc.end));
            let (lo, hi) = (a.min(b), a.max(b));
            if x < lo - 1e-6 || x > hi + 1e-6 {
                continue;
            }
            let q = [w.start.x + ux * x - uy * d, w.start.y + uy * x + ux * d];
            let mut z = crate::model3d::wall_top_at(pc, q);
            if pc.top_plane.is_none() {
                if let Some(d) = pc.top_drop {
                    let t = if hi - lo > 1e-9 { ((x - lo) / (hi - lo)).clamp(0.0, 1.0) } else { 0.0 };
                    let (d0, d1) = if a <= b { (d[0], d[1]) } else { (d[1], d[0]) };
                    z -= d0 + (d1 - d0) * t;
                }
            }
            best = Some(best.map_or(z, |b: f64| b.max(z)));
        }
        best
    };
    let mut out: Vec<P> = Vec::new();
    for x in xs {
        // Fehlt ein Körper (Lücke), zählt die Wandhöhe nicht: die Fläche reicht dort nur bis zur UK.
        let z = height_at(x).map_or(0.0, |z| z - z0);
        out.push([x, z.clamp(0.0, z1 - z0)]);
    }
    (out.len() >= 2).then_some(out)
}

/// Bogenwand ([T2]): Muster je Seite auf der abgewickelten Wandfläche (x = Bogenlänge DIESER Fläche, damit
/// Abstände auf der Fläche stimmen), Punkte mit dem Bogen gebogen; Linien längs der Wand folgen der
/// Krümmung (geteilt wie die Sehnen-Zerlegung), senkrechte bleiben gerade.
fn arc_wall_lines(p: &Project, w: &Wall, arc: &crate::wall_arc::WallArc, s: &mut Sink) {
    let len = arc.length();
    let Some(wt) = p.wall_type(w) else { return };
    let (z0, z1) = p.wall_vertical_extent(w);
    if !(z1 - z0 > 1e-6) || !(len > 1e-6) {
        return;
    }
    let total = crate::model::Project::type_thickness(&wt.layers);
    let ref_off = crate::joins::reference_offset(crate::model3d::wall_reference(w), total);
    let off = w.surface_pattern_offset.as_ref().map_or([0.0, 0.0], |o| [o.x, o.y]);
    for (layer, side) in [(wt.layers.first(), -1.0), (wt.layers.last(), 1.0)] {
        let Some((pat, comp, spec)) = spec_for(layer.and_then(|l| p.component(&l.component_id)), w.surface_pattern_angle.unwrap_or(0.0)) else { continue };
        let rgb = ink_rgb(pat, comp);
        let d = -ref_off + side * (total / 2.0 + LIFT);
        let k = arc.radius_at(d) / arc.r;
        if !(k > 1e-9) {
            continue;
        }
        let holes: Vec<Vec<P>> = p
            .openings
            .as_deref()
            .unwrap_or(&[])
            .iter()
            .filter(|o| o.host_wall_id == w.id)
            .filter_map(|o| {
                let from = o.position.max(0.0).min(len) * k;
                let to = (o.position + o.width).min(len) * k;
                let b = o.sill_height.max(0.0);
                let t = (b + o.height).min(z1 - z0);
                (to - from > 1e-4 && t - b > 1e-4).then(|| vec![[from, b], [to, b], [to, t], [from, t]])
            })
            .collect();
        let face = ring_with_holes(&[[0.0, 0.0], [len * k, 0.0], [len * k, z1 - z0], [0.0, z1 - z0]], &holes);
        let step = len / arc.segments(arc.radius_at(d)) as f64;
        let at = |q: P| {
            let pt = arc.point(q[0] / k, d);
            [pt.x, pt.y, z0 + q[1]]
        };
        for (a, b, m) in lod_segments(|sc| sp::segments(&face, &spec, off, sc)) {
            let n = (((b[0] - a[0]).abs() / k / step).ceil() as usize).clamp(1, 512);
            let mut prev = at(a);
            for i in 1..=n {
                let t = i as f64 / n as f64;
                let q = at([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
                s.push(prev, q, rgb, m);
                prev = q;
            }
        }
    }
}

/// Deckenoberseite (Bodenbelag, oberste Schicht) und -untersicht (unterste Schicht).
fn ceiling_lines(p: &Project, ce: &Ceiling, s: &mut Sink) {
    let Some(layers) = crate::model3d::ceiling_type_ref(p, ce).map(|t| t.2) else { return };
    let Some((outer, holes)) = ceiling_rings(ce) else { return };
    let ring = ring_with_holes(&outer, &holes);
    let (z0, z1) = p.ceiling_vertical_extent(ce);
    for (layer, z) in [(layers.first(), z1 + LIFT), (layers.last(), z0 - LIFT)] {
        let Some((pat, comp, spec)) = spec_for(layer.and_then(|l| p.component(&l.component_id)), 0.0) else { continue };
        let rgb = ink_rgb(pat, comp);
        for (a, b, m) in lod_segments(|sc| sp::segments(&ring, &spec, outer[0], sc)) {
            s.push([a[0], a[1], z], [b[0], b[1], z], rgb, m);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{SurfacePatternDirection, SurfacePatternKind};

    fn sample() -> Project {
        serde_json::from_str(include_str!("../tests/fixtures/sample_project.json")).unwrap()
    }

    fn with_pattern(p: &mut Project, comp_id: &str, spacing: f64) {
        let c = p.components.iter_mut().find(|c| c.id == comp_id).unwrap();
        c.surface_pattern = Some(SurfacePattern { kind: SurfacePatternKind::Lines, direction: Some(SurfacePatternDirection::Vertical), spacing, ..Default::default() });
    }

    /// [65] Mit Explosionsabstand heben sich die Linien mit dem Geschoss ihres Bauteils (EG bleibt, OG +gap).
    #[test]
    fn muster_folgt_dem_explosionsversatz() {
        let mut p = sample();
        let ids: Vec<String> = p.components.iter().map(|c| c.id.clone()).collect();
        for id in &ids {
            with_pattern(&mut p, id, 0.2);
        }
        let a = pattern_lines_3d(&p);
        assert_eq!(a, pattern_lines_3d_exploded(&p, 0.0));
        let b = pattern_lines_3d_exploded(&p, 2.0);
        assert_eq!(a.len(), b.len());
        let (mut lifted, mut kept) = (0, 0);
        for (x, y) in a.chunks_exact(PATTERN_STRIDE).zip(b.chunks_exact(PATTERN_STRIDE)) {
            assert_eq!((x[0], x[2], x[3], x[5]), (y[0], y[2], y[3], y[5]));
            let (d0, d1) = (y[1] - x[1], y[4] - x[4]);
            assert!((d0 - d1).abs() < 1e-5);
            if d0.abs() < 1e-5 {
                kept += 1;
            } else {
                assert!((d0 - 2.0).abs() < 1e-5, "{d0}");
                lifted += 1;
            }
        }
        assert!(lifted > 0 && kept > 0, "{lifted} {kept}");
    }

    #[test]
    fn wand_decke_dach_linien_mit_stufen() {
        let mut p = sample();
        assert!(pattern_lines_3d(&p).is_empty());
        let outer = p.wall_type(&p.walls[0]).unwrap().layers[0].component_id.clone();
        with_pattern(&mut p, &outer, 0.1);
        let v = pattern_lines_3d(&p);
        assert_eq!(v.len() % PATTERN_STRIDE, 0);
        let n = v.len() / PATTERN_STRIDE;
        assert!(n > 50, "{n}");
        // Feinste Stufe enthält alle Linien einer 10-cm-Lattung, die gröbste (1:1600) keine.
        let masks: Vec<u8> = v.chunks(PATTERN_STRIDE).map(|c| c[9] as u8).collect();
        assert!(masks.iter().all(|m| m & 1 == 1));
        assert!(masks.iter().all(|m| m & (1 << 6) == 0));
        // Weiter weg nur ein Teil (jede 2./4./8. Linie).
        let mid = masks.iter().filter(|m| *m & (1 << 3) != 0).count();
        assert!(mid > 0 && mid < n, "{mid} von {n}");
        // Welt-Höhe (y) innerhalb der Wandhöhen 0…5.2 m.
        assert!(v.chunks(PATTERN_STRIDE).all(|c| c[1] >= -0.01 && c[1] <= 5.21));
    }

    /// [T2]/[100] Bogenwand: waagrechte Lattung folgt dem Bogen (alle Punkte auf dem Flächenradius).
    #[test]
    fn bogenwand_muster_folgt_dem_bogen() {
        let mut p = sample();
        p.walls.retain(|w| w.id == "W1");
        p.openings = Some(vec![]);
        p.ceilings = Some(vec![]);
        p.roofs = Some(vec![]);
        p.walls[0].bulge = Some(1.0); // Halbkreis (0,0)→(5,0), Mitte (2.5,0), r 2.5
        let outer = p.wall_type(&p.walls[0]).unwrap().layers[0].component_id.clone();
        let c = p.components.iter_mut().find(|c| c.id == outer).unwrap();
        c.surface_pattern = Some(SurfacePattern { kind: SurfacePatternKind::Lines, direction: Some(SurfacePatternDirection::Horizontal), spacing: 0.2, ..Default::default() });
        let v = pattern_lines_3d(&p);
        let n = v.len() / PATTERN_STRIDE;
        assert!(n > 100, "{n}");
        // Welt (x, Höhe, y): Abstand zur Bogenmitte = Radius der Aussenfläche (Achse mittig, 0.345 dick).
        // Uhrzeigersinn: rechts der Laufrichtung (äusserste Schicht) liegt zur Bogenmitte hin.
        let r_face = 2.5 - 0.345 / 2.0 - LIFT;
        for c in v.chunks(PATTERN_STRIDE) {
            for (x, y) in [(c[0], c[2]), (c[3], c[5])] {
                let r = ((x as f64 - 2.5).powi(2) + (y as f64).powi(2)).sqrt();
                assert!((r - r_face).abs() < 1e-4, "{r} ≠ {r_face}");
            }
        }
    }

    /// [216] Giebelwand: die Musterlinien enden an der Dach-Unterkante (Dreieck), nicht am Wandrechteck.
    #[test]
    fn giebelwand_muster_endet_am_dach() {
        let mut p = sample();
        p.openings = Some(vec![]);
        p.ceilings = Some(vec![]);
        p.walls.retain(|w| w.id == "W6");
        p.walls[0].height = 6.0;
        p.walls[0].roof_attach = Some(true);
        let outer = p.wall_type(&p.walls[0]).unwrap().layers[0].component_id.clone();
        with_pattern(&mut p, &outer, 0.1);
        let v = pattern_lines_3d(&p);
        assert!(!v.is_empty());
        let (z0, _) = p.wall_vertical_extent(&p.walls[0]);
        // Welt (x, Höhe, y): Höhe am Dachrand (y ≈ 0) deutlich unter der Höhe am First (y ≈ 2).
        let top_at = |lo: f32, hi: f32| v.chunks(PATTERN_STRIDE).flat_map(|c| [(c[2], c[1]), (c[5], c[4])]).filter(|(y, _)| *y >= lo && *y <= hi).map(|(_, h)| h).fold(f32::MIN, f32::max);
        let (eave, ridge) = (top_at(0.0, 0.25), top_at(1.8, 2.2));
        assert!(ridge - eave > 0.6, "Traufe {eave}, First {ridge}");
        // Keine Linie über dem First der Dachfläche (Wandhöhe 6 m wäre z0 + 6).
        assert!(ridge < z0 as f32 + 5.0, "{ridge}");
    }

    /// [233] Die Musterlinien einer Wandseite enden an der Oberkante des Wandkörpers AN DIESER SEITE: unter einer geneigten
    /// Dachfläche liegt sie auf der Aussen- und der Innenseite verschieden hoch (auf der Achse gemessen ragten die Striche
    /// der Traufseite über den Körper hinaus, „senkrechte Striche über der Dachkante").
    #[test]
    fn wandmuster_endet_an_der_wandseite_unter_dem_dach() {
        let mut p = sample();
        p.openings = Some(vec![]);
        p.ceilings = Some(vec![]);
        // Traufwände (parallel zum First, W5/W7) bis ins Dach hochgezogen: die Dachfläche schneidet sie quer zur Achse.
        p.walls.retain(|w| w.id == "W5" || w.id == "W7");
        for w in &mut p.walls {
            w.height = 6.0;
            w.roof_attach = Some(true);
        }
        let ids: Vec<String> = p.components.iter().map(|c| c.id.clone()).collect();
        for id in &ids {
            with_pattern(&mut p, id, 0.1);
        }
        let mut checked = 0;
        for w in &p.walls {
            let (mut ctx, maps) = (HashMap::new(), crate::model3d::wall_material_color_maps(&p));
            let mut s = Sink { out: Vec::new(), dz: 0.0, ctx: &mut ctx, maps: &maps };
            wall_lines(&p, w, &mut s);
            if s.out.is_empty() {
                continue;
            }
            let ctx = s.ctx.entry(w.floor_id.clone()).or_insert_with(|| crate::model3d::floor_context_with(&p, &w.floor_id, true, None)).clone();
            let mut pieces = Vec::new();
            crate::model3d::wall_pieces(&p, &s.maps, w, &ctx, &[], crate::joins::WallCuts::default(), true, false, &mut pieces);
            let mut worst = 0.0f64;
            let mut at = [0.0; 3];
            for c in s.out.chunks_exact(PATTERN_STRIDE) {
                for (x, h, y) in [(c[0], c[1], c[2]), (c[3], c[4], c[5])] {
                    let q = [x as f64, y as f64];
                    let mut top: Option<f64> = None;
                    for pc in &pieces {
                        let (dx, dy) = (pc.end[0] - pc.start[0], pc.end[1] - pc.start[1]);
                        let l2 = dx * dx + dy * dy;
                        let t = if l2 > 1e-12 { ((q[0] - pc.start[0]) * dx + (q[1] - pc.start[1]) * dy) / l2 } else { 0.0 };
                        if t < -1e-6 || t > 1.0 + 1e-6 {
                            continue;
                        }
                        let z = crate::model3d::wall_top_at(pc, q);
                        top = Some(top.map_or(z, |b: f64| b.max(z)));
                    }
                    if let Some(top) = top {
                        if h as f64 - top > worst {
                            worst = h as f64 - top;
                            at = [x as f64, h as f64, y as f64];
                        }
                    }
                }
            }
            checked += pieces.iter().filter(|pc| pc.top_plane.is_some()).count();
            assert!(worst < 0.01, "Wand {}: Muster {worst:.3} m über dem Wandkörper bei {at:?}", w.id);
        }
        assert!(checked > 0, "kein Wandstück mit geneigter Oberkante im Beispiel");
    }

    #[test]
    fn bodenbelag_im_grundriss() {
        let mut p = sample();
        let ce = p.ceilings.as_ref().unwrap()[0].clone();
        let top = crate::model3d::ceiling_type_ref(&p, &ce).unwrap().2[0].component_id.clone();
        assert!(floor_finish_segments(&p, &ce, 50.0).is_none());
        with_pattern(&mut p, &top, 0.12);
        let (segs, w, _, _) = floor_finish_segments(&p, &ce, 50.0).unwrap();
        assert!(segs.len() > 20, "{}", segs.len());
        assert!(w > 0.0);
        // 3D: Oberseite der Decke auf OK Decke.
        let v = pattern_lines_3d(&p);
        let (_, z1) = p.ceiling_vertical_extent(&ce);
        assert!(v.chunks(PATTERN_STRIDE).any(|c| (c[1] as f64 - z1).abs() < 0.01));
    }

    /// [214] Zwischenspeicher: nach jeder Änderung (Wand, Öffnung, Decke, Dach, Typ, Hinzufügen/Entfernen, Undo/Redo, Klassen-Filter,
    /// Explosion) gleich dem Neubau ohne Zwischenspeicher; eine Wandänderung rechnet nur diese Wand neu.
    #[test]
    fn zwischenspeicher_gleich_neubau() {
        use crate::document::Document;
        use crate::ops::Op;
        use serde_json::{json, Value};
        let mut v: Value = serde_json::from_str(include_str!("../tests/fixtures/sample_project.json")).unwrap();
        for c in v["components"].as_array_mut().unwrap() {
            c["surfacePattern"] = json!({"kind": "lines", "direction": "vertical", "spacing": 0.2});
        }
        let mut d = Document::from_json(&v.to_string()).unwrap();
        let list = |d: &Document, key: &str| d.root().get(key).and_then(Value::as_array).cloned().unwrap_or_default();
        let filters = ["", r#"{"hide":["20"]}"#, r#"{"hide":["30","31"]}"#];
        let check = |d: &mut Document, step: &str| {
            for (i, text) in filters.iter().enumerate() {
                for gap in [0.0, 1.5] {
                    let inc = d.surface_pattern_lines(gap, text).unwrap();
                    let p = d.project().unwrap().clone();
                    let full = pattern_lines_3d_filtered(&p, gap, &crate::model3d::ClassFilter::from_text(&p, text));
                    assert!(inc == full, "{step}: Filter {i}, Abstand {gap}: {} / {} Werte", inc.len(), full.len());
                }
            }
        };
        check(&mut d, "start");
        let all = d.surface_pattern_lines(0.0, "").unwrap();
        assert!(all.len() > 1000);
        // Eine Wand ändern: nur sie wird neu gerechnet.
        let mut w = list(&d, "walls")[1].clone();
        w["surfacePatternOffset"] = json!({"x": 0.05, "y": 0.0});
        d.commit(vec![Op::Replace { collection: "walls".into(), entity: w }], None, 0.0, false).unwrap();
        d.surface_pattern_lines(0.0, "").unwrap();
        assert_eq!(d.pattern_rebuilt(), (1, 0, 0), "nur die geänderte Wand");
        d.surface_pattern_lines(0.0, "").unwrap();
        assert_eq!(d.pattern_rebuilt(), (0, 0, 0), "unverändert: nichts neu");
        d.surface_pattern_lines(0.0, filters[1]).unwrap();
        assert_eq!(d.pattern_rebuilt(), (0, 0, 0), "anderer Klassen-Filter: nichts neu");
        check(&mut d, "Wand-Versatz");
        let mut seed: u64 = 0x214;
        let mut rnd = |n: usize| {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            ((seed >> 33) as usize) % n.max(1)
        };
        let mut kinds = [0usize; 11];
        for step in 0..60 {
            let walls = list(&d, "walls");
            let openings = list(&d, "openings");
            let kind = rnd(11);
            let ops: Vec<Op> = match kind {
                0 => {
                    let mut w = walls[rnd(walls.len())].clone();
                    w["height"] = json!(w["height"].as_f64().unwrap_or(2.6) + 0.1);
                    vec![Op::Replace { collection: "walls".into(), entity: w }]
                }
                1 => {
                    let mut w = walls[rnd(walls.len())].clone();
                    w["end"]["x"] = json!(w["end"]["x"].as_f64().unwrap_or(0.0) + 0.05);
                    vec![Op::Replace { collection: "walls".into(), entity: w }]
                }
                2 if !openings.is_empty() => {
                    let mut o = openings[rnd(openings.len())].clone();
                    o["width"] = json!(o["width"].as_f64().unwrap_or(1.0) * 0.9);
                    vec![Op::Replace { collection: "openings".into(), entity: o }]
                }
                3 if !openings.is_empty() => {
                    let mut o = openings[rnd(openings.len())].clone();
                    o["hostWallId"] = walls[rnd(walls.len())]["id"].clone();
                    vec![Op::Replace { collection: "openings".into(), entity: o }]
                }
                4 => {
                    let mut w = walls[rnd(walls.len())].clone();
                    w["id"] = json!(format!("neu{step}"));
                    w["start"]["y"] = json!(w["start"]["y"].as_f64().unwrap_or(0.0) + 0.3);
                    vec![Op::Add { collection: "walls".into(), items: vec![w], at: Some(rnd(walls.len())) }]
                }
                5 if walls.len() > 3 => vec![Op::Remove { collection: "walls".into(), ids: vec![walls[rnd(walls.len())]["id"].as_str().unwrap().to_owned()] }],
                6 => {
                    // Decke: Umriss verschieben (ändert Geschoss-Kontext und damit die Wände unter dem Dach).
                    let mut c = list(&d, "ceilings")[0].clone();
                    let x = c["outline"][2]["x"].as_f64().unwrap();
                    c["outline"][2]["x"] = json!(x + 0.1);
                    vec![Op::Replace { collection: "ceilings".into(), entity: c }]
                }
                7 => {
                    let mut r = list(&d, "roofs")[0].clone();
                    r["surfacePatternAngle"] = json!(0.1 * step as f64);
                    vec![Op::Replace { collection: "roofs".into(), entity: r }]
                }
                8 => {
                    if d.undo().is_some() {
                        kinds[kind] += 1;
                        check(&mut d, &format!("Schritt {step} (undo)"));
                    }
                    continue;
                }
                9 => {
                    if d.redo().is_some() {
                        kinds[kind] += 1;
                        check(&mut d, &format!("Schritt {step} (redo)"));
                    }
                    continue;
                }
                _ => {
                    let mut ts = list(&d, "wallTypes");
                    let t = rnd(ts.len());
                    if let Some(l) = ts[t]["layers"].get_mut(0) {
                        l["thickness"] = json!(l["thickness"].as_f64().unwrap_or(0.1) + 0.01);
                    }
                    vec![Op::Replace { collection: "wallTypes".into(), entity: ts.swap_remove(t) }]
                }
            };
            kinds[kind] += 1;
            d.commit(ops, None, step as f64, false).unwrap_or_else(|e| panic!("Schritt {step}: {e:?}"));
            check(&mut d, &format!("Schritt {step} (Art {kind})"));
        }
        assert!([0, 1, 4, 5, 6, 7, 8, 10].iter().all(|&k| kinds[k] > 0), "{kinds:?}");
    }
}
