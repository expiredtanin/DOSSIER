//! Öffnungs-Symbol (Tür/Fenster) im Grundriss ([K3a]): Port von `generatePlan/openings.ts`
//! (`addOpeningSymbol`, `addOpeningFrameBand`). Geometrie aus `opening_geom.rs`. Stil löst `plan/walls.rs` aus dem
//! Modell: Strichstärken kommen als Zahlen herein, Farben als Platz (Slot) heraus (0 = keine,
//! 1 Strichfarbe, 2 Rahmen, 3 Rahmen-Aufsicht, 4 Flügel/Sprossen, 5 Fensterbank-/Sims-Linie).
//!
//! Eingabe (`f64`): `[sx, sy, ex, ey, dicke, refOff, position, breite, art (0 Fenster | 1 Tür),
//! detail (0 grob | 1 mittel | 2 fein),
//! Tür: schwenkRechts, ausen, anschlagEnde, schwenkwinkel (NaN = 90), wandoeffnung, fluegel,
//!   sturz (0 keine | 1 aussen | 2 innen | 3 beide),
//! Rahmen: hat, breite, art (0 Zarge | 1 Blockrahmen), einzug, einzugSeite (0 aussen | 1 innen | 2 mitte),
//! Fenster: hatTyp, profilbreite, rahmentiefe (NaN), einzug (NaN), einzugSeite (0 | 1 | 2), altFluegel (NaN = 1),
//!   glasAlt, sims (0 keine | 1 aussen | 2 innen | 3 beide), simsUnter (0|1), kasten (0|1),
//!   kastenBreite, kastenHoehe,
//! Stärken: haar, rahmenHaar, rahmenAufsicht, fluegel, sims,
//! Details ([94]): anschlag (Meter, 0 keiner), bank (0 fehlt | 1 keine | 2 innen | 3 beide | 4 aussen),
//!   kastenSturz (0 vorgesetzt | 1 im Sturz), kastenTiefe, kastenArt (0 Rollladen | 1 Raffstore | 2 Markise),
//! Türart ([95]): 0 Dreh | 1 Schiebe (vor der Wand, Aufschlagseite) | 2 Hebeschiebe | 3 Pendel,
//! nFluegel, (pfosten, auto, breite, pfostenbreite, oeffenbar) × n]`.
//!
//! Ausgabe `[n, Eintrag × n]` in Zeichenreihenfolge:
//! ```text
//! 1 polygon  [1, art (0 Pick-Fläche | 1 Rahmen-Aufsicht | 2 Anschlag, Wandschnitt der Fläche
//!            `einzugSeite`), weightMm, farbSlot, nPts, x, y …]
//! 2 line     [2, cls, weightMm, farbSlot, strich, ax, ay, bx, by]
//! 3 arc      [3, weightMm, cx, cy, fromX, fromY, toX, toY, r]            (cls door-swing)
//! cls        0 door-leaf · 1 door-frame · 2 door-lintel · 3 opening-frame · 4 window-glass ·
//!            5 window-mullion · 6 window-sash · 7 window-stulp · 8 window-sill · 9 window-frame ·
//!            10 window-shading
//! strich     0 keiner (Schlüssel fehlt) · 1 Sturz [0.18, 0.09] · 2 Überkopf · 3 gepunktet [0.04, 0.08]
//! ```

use crate::jsmath::hypot2;
use crate::jsnum::{max, min, round};
use crate::opening_geom::*;
use crate::flat_read::Reader;

struct Out {
    buf: Vec<f64>,
    n: usize,
}

const C_LEAF: f64 = 0.0;
const C_DOOR_FRAME: f64 = 1.0;
const C_LINTEL: f64 = 2.0;
const C_OPENING_FRAME: f64 = 3.0;
const C_GLASS: f64 = 4.0;
const C_MULLION: f64 = 5.0;
const C_SASH: f64 = 6.0;
const C_STULP: f64 = 7.0;
const C_SILL: f64 = 8.0;
const C_WINDOW_FRAME: f64 = 9.0;
const C_SHADING: f64 = 10.0;

impl Out {
    fn polygon(&mut self, art: f64, weight: f64, color: f64, pts: &[V]) {
        self.n += 1;
        self.buf.extend([1.0, art, weight, color, pts.len() as f64]);
        for p in pts {
            self.buf.extend([p.x, p.y]);
        }
    }
    fn line(&mut self, cls: f64, weight: f64, color: f64, dash: f64, a: V, b: V) {
        self.n += 1;
        self.buf.extend([2.0, cls, weight, color, dash, a.x, a.y, b.x, b.y]);
    }
    fn arc(&mut self, weight: f64, c: V, from: V, to: V, r: f64) {
        self.n += 1;
        self.buf.extend([3.0, weight, c.x, c.y, from.x, from.y, to.x, to.y, r]);
    }
    /// Geschlossener Linienzug aus Eckpunkten (Kante i → i+1, zuletzt → 0).
    fn ring(&mut self, cls: f64, weight: f64, color: f64, pts: &[V]) {
        for i in 0..pts.len() {
            self.line(cls, weight, color, 0.0, pts[i], pts[(i + 1) % pts.len()]);
        }
    }
}

pub fn plan_opening(buf: &[f64]) -> Vec<f64> {
    plan_opening_inner(buf).unwrap_or_default()
}

fn plan_opening_inner(buf: &[f64]) -> Option<Vec<f64>> {
    let mut r = Reader::new(buf);
    let (sx, sy, ex, ey, total, ref_off) = (r.num()?, r.num()?, r.num()?, r.num()?, r.num()?, r.num()?);
    let (position, width) = (r.num()?, r.num()?);
    let is_door = r.num()? != 0.0;
    let detail = match r.num()? as i64 {
        0 => Detail::Grob,
        1 => Detail::Mittel,
        _ => Detail::Fein,
    };
    let door = DoorParams { swing_right: r.num()? != 0.0, open_out: r.num()? != 0.0, hinge_end: r.num()? != 0.0, swing_angle: 0.0 };
    let swing_angle = r.num()?;
    let door = DoorParams { swing_angle: if swing_angle.is_nan() { 90.0 } else { swing_angle }, ..door };
    let wandoeffnung = r.num()? != 0.0;
    let leaf_count = r.num()?;
    let lintel = r.num()? as i64;
    let has_frame = r.num()? != 0.0;
    let frame_width = r.num()?;
    let frame_block = r.num()? != 0.0;
    let frame_inset = r.num()?;
    let frame_inset_side = r.num()?;
    let has_type = r.num()? != 0.0;
    let win_frame_width = r.num()?;
    let win_frame_depth = r.num()?;
    let win_inset = r.num()?;
    let win_inset_side = r.num()?;
    let wing_count = r.num()?;
    let glass_alt = r.num()?;
    let sill_faces = r.num()? as i64;
    let sill_under = r.num()? != 0.0;
    let shading = r.num()? != 0.0;
    let shading_width = r.num()?;
    let shading_height = r.num()?;
    let (hair, frame_hair, frame_view_w, sash_w, sill_w) = (r.num()?, r.num()?, r.num()?, r.num()?, r.num()?);
    let rebate = r.num()?;
    let sill_board = r.num()? as i64;
    let shading_sturz = r.num()? != 0.0;
    let shading_depth = r.num()?;
    let shading_kind = r.num()? as i64;
    let door_kind = r.num()? as i64;
    let n_sash = r.count()?;
    let mut sashes = Vec::with_capacity(n_sash);
    for _ in 0..n_sash {
        sashes.push(Sash {
            post: r.num()? != 0.0,
            auto_width: r.num()? != 0.0,
            width: r.num()?,
            post_width: r.num()?,
            operable: r.num()? != 0.0,
        });
    }
    if ![sx, sy, ex, ey, total, ref_off, position, width].iter().all(|x| x.is_finite()) {
        return None;
    }
    let w = WallRef { start: v(sx, sy), end: v(ex, ey), total, ref_off };
    let (_, wn) = w.frame();
    let mut o = Out { buf: Vec::new(), n: 0 };

    if is_door {
        let (jamb_start, jamb_end) = opening_jambs(&w, position, width)?;
        if let Some(gap) = opening_gap_quad(&w, position, width) {
            o.polygon(0.0, 0.0, 0.0, &gap);
        }
        let count = max(1.0, round(if leaf_count.is_nan() { 1.0 } else { leaf_count }));
        if wandoeffnung {
            // Reine Wandöffnung: nur Lücke (und Sturzlinien).
        } else if door_kind == 1 {
            sliding_leaves(&mut o, &w, jamb_start, jamb_end, &door, count, hair);
        } else if door_kind == 2 {
            // Gleise im Rahmen: hinter der Anschlag-Zone (bzw. mittig ohne Rahmentyp).
            let half = total / 2.0;
            let depth = max(0.12, if frame_width.is_nan() { 0.0 } else { frame_width });
            let (lo, hi) = if !has_frame {
                (ref_off - depth / 2.0, ref_off + depth / 2.0)
            } else if frame_inset_side == 1.0 {
                let e = ref_off + half - max(0.0, min(frame_inset, total));
                (max(ref_off - half, e - depth), e)
            } else if frame_inset_side == 2.0 {
                (ref_off - depth / 2.0, ref_off + depth / 2.0)
            } else {
                let e = ref_off - half + max(0.0, min(frame_inset, total));
                (e, min(ref_off + half, e + depth))
            };
            lift_slide(&mut o, jamb_start, jamb_end, wn, lo, hi, door.hinge_end, hair);
        } else {
            for leaf in door_leaves(&w, position, width, &door, count) {
                o.line(C_LEAF, hair, 0.0, 0.0, leaf.hinge, leaf.open_end);
                if detail != Detail::Grob {
                    o.arc(hair, leaf.hinge, leaf.closed_end, leaf.open_end, leaf.radius);
                }
            }
            if door_kind == 3 {
                // Pendeltür: schlägt auch zur Gegenseite auf (Blatt gepunktet, Bogen).
                let other = DoorParams { swing_right: !door.swing_right, ..door };
                for leaf in door_leaves(&w, position, width, &other, count) {
                    o.line(C_LEAF, hair, 0.0, 3.0, leaf.hinge, leaf.open_end);
                    if detail != Detail::Grob {
                        // Bögen laufen gegen den Uhrzeigersinn von `from` nach `to`: kurzen Bogen wählen.
                        let (a, b) = (sub(leaf.closed_end, leaf.hinge), sub(leaf.open_end, leaf.hinge));
                        let (from, to) = if a.x * b.y - a.y * b.x >= 0.0 { (leaf.closed_end, leaf.open_end) } else { (leaf.open_end, leaf.closed_end) };
                        o.arc(hair, leaf.hinge, from, to, leaf.radius);
                    }
                }
            }
        }
        if detail == Detail::Fein {
            let reveal = 0.06;
            for jamb in [jamb_start, jamb_end] {
                o.line(C_DOOR_FRAME, hair, 0.0, 0.0, add(jamb, scale(wn, reveal)), add(jamb, scale(wn, -reveal)));
            }
        }
        if has_frame {
            let zone = frame_band(&mut o, &w, position, width, frame_width, frame_block, frame_inset, frame_inset_side, hair);
            rebate_nibs(&mut o, &w, position, width, rebate, zone);
        }
        if lintel != 0 {
            let half_d = total / 2.0;
            let outer_off = ref_off - half_d;
            let inner_off = ref_off + half_d;
            let line = |off: f64| (add(jamb_start, scale(wn, off)), add(jamb_end, scale(wn, off)));
            if lintel == 1 || lintel == 3 {
                let (a, b) = line(outer_off);
                o.line(C_LINTEL, hair, 1.0, 1.0, a, b);
            }
            if lintel == 2 || lintel == 3 {
                let (a, b) = line(inner_off);
                o.line(C_LINTEL, hair, 1.0, 1.0, a, b);
            }
        }
        return Some(finish(o));
    }

    // Fenster
    let spec = if has_type {
        Some(WindowSpec {
            sashes,
            frame_width: win_frame_width,
            frame_depth: win_frame_depth,
            inset_from_face: win_inset,
            inset_inner: win_inset_side == 1.0,
            inset_mid: win_inset_side == 2.0,
        })
    } else {
        None
    };
    let sym = window_symbol(&w, position, width, glass_alt, spec.as_ref(), wing_count, detail)?;
    if let Some(gap) = opening_gap_quad(&w, position, width) {
        o.polygon(0.0, 0.0, 0.0, &gap);
    }
    // Rahmenlage quer zur Wand (absolut entlang der linken Normalen).
    let (f_lo, f_hi) = match opening_jambs(&w, position, width) {
        Some((js, _)) => {
            let a = dot(sub(sym.frame[0], js), wn);
            let b = dot(sub(sym.frame[2], js), wn);
            (min(a, b), max(a, b))
        }
        None => (ref_off - total / 2.0, ref_off + total / 2.0),
    };
    if has_type {
        let zone = if win_inset_side == 1.0 { (f_hi, ref_off + total / 2.0) } else { (ref_off - total / 2.0, f_lo) };
        rebate_nibs(&mut o, &w, position, width, rebate, Some(zone));
    }
    if detail == Detail::Grob {
        let idx = sym.glass_lines.len() / 2;
        if let Some(g) = sym.glass_lines.get(idx).or_else(|| sym.glass_lines.first()) {
            o.line(C_GLASS, sash_w, 4.0, 0.0, g.0, g.1);
        }
    } else {
        o.polygon(1.0, frame_view_w, 3.0, &sym.frame);
        for (a, b) in &sym.mullion_lines {
            o.line(C_MULLION, sash_w, 4.0, 0.0, *a, *b);
        }
        if detail == Detail::Fein {
            for pts in &sym.sash_frames {
                o.ring(C_SASH, sash_w, 4.0, pts);
            }
        }
        for mark in &sym.jamb_marks {
            o.ring(C_STULP, frame_hair, 2.0, mark);
        }
        for mark in &sym.meeting_marks {
            o.ring(C_STULP, sash_w, 4.0, mark);
        }
        for (a, b) in &sym.glass_lines {
            o.line(C_GLASS, hair, 0.0, 0.0, *a, *b);
        }
        if detail == Detail::Fein {
            if let Some((js, je)) = opening_jambs(&w, position, width) {
                let outer_n = f_lo;
                let (ov, proj) = (0.03, 0.04);
                let s0 = along(js, je, -ov);
                let s1 = along(je, js, -ov);
                // Fensterbank aussen (fehlt/aussen/beide): von der Rahmen-Vorderkante bis vor die Aussenfläche.
                if sill_board == 0 || sill_board == 3 || sill_board == 4 {
                    let far = min(outer_n, ref_off - total / 2.0) - proj;
                    let b0 = add(s0, scale(wn, outer_n));
                    let b1 = add(s1, scale(wn, outer_n));
                    let b2 = add(s1, scale(wn, far));
                    let b3 = add(s0, scale(wn, far));
                    for (a, b) in [(b0, b1), (b1, b2), (b2, b3), (b3, b0)] {
                        o.line(C_SILL, hair, 1.0, 0.0, a, b);
                    }
                }
                // Fensterbank innen (innen/beide): von der Rahmen-Hinterkante bis vor die Innenfläche.
                if sill_board == 2 || sill_board == 3 {
                    let far = max(f_hi, ref_off + total / 2.0) + 0.02;
                    let b0 = add(s0, scale(wn, f_hi));
                    let b1 = add(s1, scale(wn, f_hi));
                    let b2 = add(s1, scale(wn, far));
                    let b3 = add(s0, scale(wn, far));
                    for (a, b) in [(b0, b1), (b1, b2), (b2, b3), (b3, b0)] {
                        o.line(C_SILL, hair, 1.0, 0.0, a, b);
                    }
                }
                let reveal = 0.06;
                for jamb in [js, je] {
                    o.line(C_WINDOW_FRAME, hair, 1.0, 0.0, add(jamb, scale(wn, reveal)), add(jamb, scale(wn, -reveal)));
                }
            }
        }
    }
    if detail != Detail::Grob && sill_faces != 0 {
        let dash = if sill_under { 2.0 } else { 3.0 };
        let pair01_is_outer = dot(sym.frame[0], wn) <= dot(sym.frame[3], wn);
        let (outer_pair, inner_pair) = if pair01_is_outer {
            ((sym.frame[0], sym.frame[1]), (sym.frame[3], sym.frame[2]))
        } else {
            ((sym.frame[3], sym.frame[2]), (sym.frame[0], sym.frame[1]))
        };
        if sill_faces == 1 || sill_faces == 3 {
            o.line(C_SILL, sill_w, 5.0, dash, outer_pair.0, outer_pair.1);
        }
        if sill_faces == 2 || sill_faces == 3 {
            o.line(C_SILL, sill_w, 5.0, dash, inner_pair.0, inner_pair.1);
        }
    }
    if shading {
        if let Some((js, je)) = opening_jambs(&w, position, width) {
            let (u, nrm) = w.frame();
            let outer_face = ref_off - total / 2.0;
            let axis_width = hypot2(je.x - js.x, je.y - js.y);
            let box_width = if shading_width > 0.0 { shading_width } else { axis_width };
            // Im Sturz: Kasten verdeckt in der Wand, Tiefe quer zur Wand ab der Aussenfläche.
            let box_height = max(0.0, if shading_sturz { shading_depth } else { shading_height });
            let center = add(js, scale(u, axis_width / 2.0));
            let half = box_width / 2.0;
            let c1 = add(center, scale(u, -half));
            let c2 = add(center, scale(u, half));
            let p1 = add(c1, scale(nrm, outer_face));
            let p2 = add(c2, scale(nrm, outer_face));
            let p3 = add(c2, scale(nrm, outer_face + box_height));
            let p4 = add(c1, scale(nrm, outer_face + box_height));
            for (a, b) in [(p1, p2), (p2, p3), (p3, p4), (p4, p1)] {
                o.line(C_SHADING, hair, 1.0, 2.0, a, b);
            }
            // Führungsschienen der Storen (fein, Kasten im Sturz, nicht bei Markise) vor dem Rahmen.
            if shading_sturz && detail == Detail::Fein && shading_kind != 2 {
                let (rail_u, rail_n) = (0.03, 0.04);
                let front = if win_inset_side == 1.0 { f_hi } else { f_lo };
                let dir = if win_inset_side == 1.0 { 1.0 } else { -1.0 };
                // Neben dem Anschlag (Wandnase) in der Leibung.
                let rd = if has_type && rebate > 1e-4 { min(rebate, axis_width / 2.0 - 0.01) } else { 0.0 };
                for (u0, u1) in [(rd, rd + rail_u), (axis_width - rd - rail_u, axis_width - rd)] {
                    let a = along(js, je, u0);
                    let b = along(js, je, u1);
                    let n0 = front + dir * 0.005;
                    let n1 = front + dir * (0.005 + rail_n);
                    o.ring(C_SHADING, hair, 1.0, &[add(a, scale(nrm, n0)), add(b, scale(nrm, n0)), add(b, scale(nrm, n1)), add(a, scale(nrm, n1))]);
                }
            }
        }
    }
    Some(finish(o))
}

/// Pfeil von `a` nach `b` (Schaft + zwei Widerhaken) in Richtung der Schiebebewegung.
fn arrow(o: &mut Out, a: V, b: V, side: V, hair: f64) {
    let d = normalize(sub(b, a));
    let l = hypot2(b.x - a.x, b.y - a.y);
    let barb = min(0.12, l * 0.35);
    o.line(C_LEAF, hair, 0.0, 0.0, a, b);
    for k in [-1.0, 1.0] {
        o.line(C_LEAF, hair, 0.0, 0.0, b, add(sub(b, scale(d, barb)), scale(side, k * barb * 0.45)));
    }
}

/// Schiebetür vor der Wand (SIA): Blatt als schmales Rechteck in Schliessstellung auf der
/// Aufschlagseite vor der Wandfläche, je Blatt ein Pfeil zur Parkseite (Bandseite bzw. aussen).
fn sliding_leaves(o: &mut Out, w: &WallRef, js: V, je: V, p: &DoorParams, count: f64, hair: f64) {
    let n = w.frame().1;
    let side = (if p.swing_right { -1.0 } else { 1.0 }) * (if p.open_out { -1.0 } else { 1.0 });
    let face = w.ref_off + side * w.total / 2.0;
    let (n0, n1) = (face + side * 0.01, face + side * 0.05);
    let wd = hypot2(je.x - js.x, je.y - js.y);
    let ov = 0.05;
    let leaf = |o: &mut Out, u0: f64, u1: f64| {
        let a = along(js, je, u0);
        let b = along(js, je, u1);
        o.ring(C_LEAF, hair, 0.0, &[add(a, scale(n, n0)), add(b, scale(n, n0)), add(b, scale(n, n1)), add(a, scale(n, n1))]);
    };
    let mid_n = face + side * 0.12;
    let at = |u: f64| add(along(js, je, u), scale(n, mid_n));
    if count >= 2.0 {
        leaf(o, -ov, wd / 2.0);
        leaf(o, wd / 2.0, wd + ov);
        arrow(o, at(wd * 0.4), at(wd * 0.1), n, hair);
        arrow(o, at(wd * 0.6), at(wd * 0.9), n, hair);
    } else {
        leaf(o, -ov, wd + ov);
        let (from, to) = if p.hinge_end { (wd * 0.25, wd * 0.75) } else { (wd * 0.75, wd * 0.25) };
        arrow(o, at(from), at(to), n, hair);
    }
}

/// Hebeschiebetür (SIA wie Schiebefenster): zwei Flügel auf versetzten Gleisen im Rahmen
/// (`lo..hi` quer zur Wand), das feste Feld an der Bandseite, das Schiebefeld mit Pfeil dorthin.
#[allow(clippy::too_many_arguments)]
fn lift_slide(o: &mut Out, js: V, je: V, n: V, lo: f64, hi: f64, hinge_end: bool, hair: f64) {
    let wd = hypot2(je.x - js.x, je.y - js.y);
    let span = hi - lo;
    if span <= 1e-3 || wd <= 1e-3 {
        return;
    }
    let ts = min(0.05, span / 2.5);
    let gap = (span - 2.0 * ts) / 3.0;
    let outer = (lo + gap, lo + gap + ts);
    let inner = (hi - gap - ts, hi - gap);
    let ov = 0.03;
    let (fixed_u, slide_u) = if hinge_end { ((wd / 2.0 - ov, wd), (0.0, wd / 2.0 + ov)) } else { ((0.0, wd / 2.0 + ov), (wd / 2.0 - ov, wd)) };
    for ((u0, u1), (n0, n1)) in [(fixed_u, outer), (slide_u, inner)] {
        let a = along(js, je, u0);
        let b = along(js, je, u1);
        o.ring(C_LEAF, hair, 0.0, &[add(a, scale(n, n0)), add(b, scale(n, n0)), add(b, scale(n, n1)), add(a, scale(n, n1))]);
        let g = (n0 + n1) / 2.0;
        o.line(C_GLASS, hair, 0.0, 0.0, add(a, scale(n, g)), add(b, scale(n, g)));
    }
    // Pfeil auf der Innenseite des Schiebefelds, zur Bandseite (über das feste Feld).
    let an = inner.1 + gap.max(0.04);
    let (from, to) = if hinge_end { (wd * 0.15, wd * 0.6) } else { (wd * 0.85, wd * 0.4) };
    arrow(o, add(along(js, je, from), scale(n, an)), add(along(js, je, to), scale(n, an)), n, hair);
}

fn finish(o: Out) -> Vec<f64> {
    let mut out = Vec::with_capacity(o.buf.len() + 1);
    out.push(o.n as f64);
    out.extend(o.buf);
    out
}

/// Rahmenband einer Tür (Zarge/Blockrahmen) aus dem Typ der Tür.
#[allow(clippy::too_many_arguments)]
fn frame_band(o: &mut Out, w: &WallRef, position: f64, width: f64, frame_width: f64, block: bool, inset_from_face: f64, inset_side: f64, hair: f64) -> Option<(f64, f64)> {
    let (js, je) = opening_jambs(w, position, width)?;
    let inset_inner = inset_side == 1.0;
    let mid = inset_side == 2.0;
    let n = w.frame().1;
    let total = w.total;
    let outer_face = w.ref_off - total / 2.0;
    let inner_face = w.ref_off + total / 2.0;
    let clamped_inset = max(0.0, min(inset_from_face, total));
    let near_is_aussen = !inset_inner;
    let mut face_near = if near_is_aussen { outer_face + clamped_inset } else { inner_face - clamped_inset };
    if mid {
        // Mittig: Blockrahmen symmetrisch um die Wandmitte (Anschlag-Zone aussen bis zum Rahmen).
        face_near = w.ref_off - max(0.0, min(frame_width, total)) / 2.0;
    }
    let face_far = if near_is_aussen { inner_face } else { outer_face };
    let lo = min(face_near, face_far);
    let hi = max(face_near, face_far);
    let fw = max(0.0, frame_width);
    let (band_lo, band_hi, j_start, j_end, weight);
    if block {
        let depth = min(fw, hi - lo);
        band_lo = if near_is_aussen { lo } else { hi - depth };
        band_hi = if near_is_aussen { lo + depth } else { hi };
        j_start = js;
        j_end = je;
        weight = hair * 2.2;
    } else {
        let jamb_span = hypot2(je.x - js.x, je.y - js.y);
        let jamb_inset = min(fw, jamb_span / 2.0);
        j_start = along(js, je, jamb_inset);
        j_end = along(je, js, jamb_inset);
        let depth_inset = min(fw, (hi - lo) / 2.0);
        band_lo = lo + depth_inset;
        band_hi = hi - depth_inset;
        weight = hair;
    }
    let p1 = add(j_start, scale(n, band_lo));
    let p2 = add(j_end, scale(n, band_lo));
    let p3 = add(j_end, scale(n, band_hi));
    let p4 = add(j_start, scale(n, band_hi));
    for (a, b) in [(p1, p2), (p2, p3), (p3, p4), (p4, p1)] {
        o.line(C_OPENING_FRAME, weight, 1.0, 0.0, a, b);
    }
    // Anschlag-Zone: zwischen der gewählten Fläche und der Rahmen-Vorderkante.
    Some(if near_is_aussen { (outer_face, lo) } else { (hi, inner_face) })
}

/// Anschlag (Maueranschlag): Wand-Nasen an beiden Leibungen über die Zone `zone` (absolut quer zur
/// Wand), je `rebate` tief in die Öffnung. Keine bei fehlender Zone/Tiefe.
fn rebate_nibs(o: &mut Out, w: &WallRef, position: f64, width: f64, rebate: f64, zone: Option<(f64, f64)>) {
    let (Some((lo, hi)), Some((js, je))) = (zone, opening_jambs(w, position, width)) else { return };
    let axis_width = hypot2(je.x - js.x, je.y - js.y);
    let rd = min(rebate, axis_width / 2.0 - 0.01);
    if !(rd > 1e-4) || !(hi - lo > 1e-4) {
        return;
    }
    let n = w.frame().1;
    for (u0, u1) in [(0.0, rd), (axis_width - rd, axis_width)] {
        let a = along(js, je, u0);
        let b = along(js, je, u1);
        o.polygon(2.0, 0.0, 1.0, &[add(a, scale(n, lo)), add(b, scale(n, lo)), add(b, scale(n, hi)), add(a, scale(n, hi))]);
    }
}

// ── Fenster-Symbol als Einzelaufruf (für die Fassade `windowSymbol`, z. B. im Schnitt) ──────────


#[cfg(test)]
mod tests {
    use super::*;

    const NAN: f64 = f64::NAN;

    /// Wand 0..6 m entlang x, Dicke 0.3, Öffnung ab 1.0 m, 0.9 m breit.
    fn input(door: bool, detail: f64, has_type: bool, sashes: &[[f64; 5]]) -> Vec<f64> {
        let mut b = vec![0.0, 0.0, 6.0, 0.0, 0.3, 0.0, 1.0, 0.9, door as u8 as f64, detail];
        b.extend([0.0, 0.0, 0.0, NAN, 0.0, 1.0, 3.0]); // Tür: links, innen, Start, 90°, normal, 1 Blatt, Sturz beide
        b.extend([0.0, 0.06, 0.0, 0.0, 0.0]); // kein Rahmenband
        b.extend([has_type as u8 as f64, 0.06, NAN, NAN, 0.0, NAN, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0]); // Fenster
        b.extend([0.02, 0.02, 0.02, 0.02, 0.02]); // Strichstärken
        b.extend([0.0, 0.0, 0.0, 0.0, 0.0]); // Details: kein Anschlag, Bank fehlt, Kasten vorgesetzt
        b.push(0.0); // Türart Dreh
        b.push(sashes.len() as f64);
        for s in sashes {
            b.extend(s);
        }
        b
    }

    fn tags(buf: &[f64]) -> Vec<f64> {
        let (mut i, mut t) = (1, Vec::new());
        for _ in 0..buf[0] as usize {
            t.push(buf[i]);
            i += match buf[i] as i64 {
                1 => 5 + 2 * buf[i + 4] as usize,
                2 => 9,
                _ => 9,
            };
        }
        assert_eq!(i, buf.len());
        t
    }

    #[test]
    fn tuer_grob_hat_pick_blatt_und_zwei_sturzlinien() {
        let t = tags(&plan_opening(&input(true, 0.0, false, &[])));
        assert_eq!(t, vec![1.0, 2.0, 2.0, 2.0]);
    }

    #[test]
    fn tuer_fein_hat_bogen_und_anschlagstriche() {
        let t = tags(&plan_opening(&input(true, 2.0, false, &[])));
        assert_eq!(t.iter().filter(|x| **x == 3.0).count(), 1);
        assert_eq!(t.len(), 1 + 1 + 1 + 2 + 2);
    }

    #[test]
    fn fenster_grob_hat_eine_glaslinie() {
        let t = tags(&plan_opening(&input(false, 0.0, false, &[])));
        assert_eq!(t, vec![1.0, 2.0]);
    }

    #[test]
    fn entartete_oeffnung_und_unsinn_ergeben_leeres_ergebnis() {
        let mut b = input(false, 1.0, false, &[]);
        b[7] = 0.0;
        assert!(plan_opening(&b).is_empty());
        assert!(plan_opening(&[1.0]).is_empty());
        let mut c = input(true, 1.0, false, &[]);
        c[0] = f64::NAN;
        assert!(plan_opening(&c).is_empty());
    }

    #[test]
    fn typisiertes_fenster_fein_hat_fluegelrahmen() {
        let sashes = [[0.0, 1.0, NAN, NAN, 1.0], [0.0, 1.0, NAN, NAN, 1.0]];
        let a = plan_opening(&input(false, 2.0, true, &sashes));
        let g = plan_opening(&input(false, 1.0, true, &sashes));
        assert!(a[0] > g[0]);
    }

    /// Index des ersten Werts der Detail-Felder ([94]) in `input`.
    const DETAILS: usize = 10 + 7 + 5 + 12 + 5;

    fn polygons(buf: &[f64], art: f64) -> Vec<Vec<(f64, f64)>> {
        let (mut i, mut out) = (1, Vec::new());
        for _ in 0..buf[0] as usize {
            if buf[i] == 1.0 {
                let n = buf[i + 4] as usize;
                if buf[i + 1] == art {
                    out.push((0..n).map(|k| (buf[i + 5 + 2 * k], buf[i + 6 + 2 * k])).collect());
                }
                i += 5 + 2 * n;
            } else {
                i += 9;
            }
        }
        out
    }

    fn count_cls(buf: &[f64], cls: f64) -> usize {
        let (mut i, mut c) = (1, 0);
        for _ in 0..buf[0] as usize {
            match buf[i] as i64 {
                1 => i += 5 + 2 * buf[i + 4] as usize,
                2 => {
                    if buf[i + 1] == cls {
                        c += 1;
                    }
                    i += 9
                }
                _ => i += 9,
            }
        }
        c
    }

    #[test]
    fn fenster_mitte_sitzt_symmetrisch_in_der_wand() {
        let sashes = [[0.0, 1.0, NAN, NAN, 1.0]];
        let mut b = input(false, 1.0, true, &sashes);
        b[24] = 0.08; // Rahmentiefe
        b[26] = 2.0; // einzugSeite mitte
        let f = plan_opening(&b);
        let frame = &polygons(&f, 1.0)[0];
        let ys: Vec<f64> = frame.iter().map(|p| p.1).collect();
        let (lo, hi) = (ys.iter().cloned().fold(f64::INFINITY, f64::min), ys.iter().cloned().fold(f64::NEG_INFINITY, f64::max));
        assert!((lo + 0.04).abs() < 1e-9 && (hi - 0.04).abs() < 1e-9, "{lo} {hi}");
    }

    #[test]
    fn anschlag_ergibt_zwei_wandnasen_vor_dem_rahmen() {
        let sashes = [[0.0, 1.0, NAN, NAN, 1.0]];
        let mut b = input(false, 1.0, true, &sashes);
        assert!(polygons(&plan_opening(&b), 2.0).is_empty());
        b[24] = 0.08;
        b[25] = 0.12; // Einzug 12 cm von aussen
        b[DETAILS] = 0.05;
        let nibs = polygons(&plan_opening(&b), 2.0);
        assert_eq!(nibs.len(), 2);
        // Wand 0.3 dick um die Achse: Aussenfläche bei y = -0.15, Rahmen-Vorderkante bei -0.03.
        let ys: Vec<f64> = nibs[0].iter().map(|p| p.1).collect();
        assert!(ys.iter().any(|y| (y + 0.15).abs() < 1e-9) && ys.iter().any(|y| (y + 0.03).abs() < 1e-9), "{ys:?}");
        let xs: Vec<f64> = nibs[0].iter().map(|p| p.0).collect();
        assert!(xs.iter().all(|x| *x >= 1.0 - 1e-9 && *x <= 1.05 + 1e-9), "{xs:?}");
        // Bündig (ohne Einzug): keine Anschlag-Zone.
        b[25] = NAN;
        assert!(polygons(&plan_opening(&b), 2.0).is_empty());
    }

    #[test]
    fn fensterbank_folgt_der_wahl() {
        let sashes = [[0.0, 1.0, NAN, NAN, 1.0]];
        let mut b = input(false, 2.0, true, &sashes);
        let base = count_cls(&plan_opening(&b), C_SILL);
        assert_eq!(base, 4, "fehlt: Bank aussen wie bisher");
        b[DETAILS + 1] = 1.0;
        assert_eq!(count_cls(&plan_opening(&b), C_SILL), 0);
        b[DETAILS + 1] = 3.0;
        assert_eq!(count_cls(&plan_opening(&b), C_SILL), 8);
    }

    #[test]
    fn storenkasten_im_sturz_mit_fuehrungsschienen() {
        let sashes = [[0.0, 1.0, NAN, NAN, 1.0]];
        let mut b = input(false, 2.0, true, &sashes);
        b[31] = 1.0; // Kasten
        b[33] = 0.25; // Höhe
        let vorgesetzt = count_cls(&plan_opening(&b), C_SHADING);
        assert_eq!(vorgesetzt, 4);
        b[DETAILS + 2] = 1.0;
        b[DETAILS + 3] = 0.18;
        b[DETAILS + 4] = 1.0; // Raffstore
        assert_eq!(count_cls(&plan_opening(&b), C_SHADING), 4 + 8);
    }

    #[test]
    fn tuer_blockrahmen_mit_anschlag() {
        let mut b = input(true, 1.0, false, &[]);
        b[17] = 1.0; // Rahmen
        b[18] = 0.06;
        b[19] = 1.0; // Blockrahmen
        b[20] = 0.1; // Einzug aussen
        b[DETAILS] = 0.04;
        assert_eq!(polygons(&plan_opening(&b), 2.0).len(), 2);
    }

    /// [95] Türarten im Grundriss: Schiebetür (Blatt-Rechteck + Pfeil, kein Bogen), Hebeschiebe
    /// (zwei Flügel auf versetzten Gleisen + Glaslinien + Pfeil), Pendel (Bögen beidseitig).
    #[test]
    fn tuerarten_nach_sia() {
        const KIND: usize = DETAILS + 5;
        let mut b = input(true, 1.0, false, &[]);
        let arcs = |f: &[f64]| tags(f).iter().filter(|t| **t == 3.0).count();
        assert_eq!(arcs(&plan_opening(&b)), 1);
        b[KIND] = 1.0;
        let f = plan_opening(&b);
        assert_eq!(arcs(&f), 0);
        assert_eq!(count_cls(&f, C_LEAF), 4 + 3);
        b[15] = 2.0; // zwei Blätter
        assert_eq!(count_cls(&plan_opening(&b), C_LEAF), 8 + 6);
        b[15] = 1.0;
        b[KIND] = 2.0;
        let f = plan_opening(&b);
        assert_eq!(count_cls(&f, C_LEAF), 8 + 3);
        assert_eq!(count_cls(&f, C_GLASS), 2);
        b[KIND] = 3.0;
        assert_eq!(arcs(&plan_opening(&b)), 2);
        // Grob: keine Bögen, aber beide Blätter.
        b[9] = 0.0;
        let f = plan_opening(&b);
        assert_eq!(arcs(&f), 0);
        assert_eq!(count_cls(&f, C_LEAF), 2);
    }
}
