//! Fenster/Türen: Rahmen-Detail, Anschlag je Seite, Türzargen-Arten ([103]) und Schichteinzug
//! ([104]) — aus Typ und Öffnungs-Übersteuerung aufgelöst, dazu die gemeinsame Geometrie für
//! Grundriss (`plan/walls.rs`, `plan_walls.rs`), Schnitt (`plan/section.rs`) und 3D (`model3d.rs`,
//! `wall_bands.rs`).
//!
//! Koordinaten quer zur Wand: Abstand ab der Aussenfläche (0 = aussen, `total` = innen) — die
//! Wandschichten liegen in Typ-Reihenfolge von aussen nach innen (wie `plan_walls.rs`, Versatz
//! `ref_off − total/2 + …` entlang der linken Normalen). In der Öffnung: `x` = Abstand von der
//! Rohbaukante in die Öffnung hinein (> 0 = in der lichten Öffnung, < 0 = in der Wand).

use crate::model::*;

pub const DEFAULT_FRAME_WIDTH: f64 = 0.06;
pub const DEFAULT_FRAME_DEPTH: f64 = 0.07;
/// Vorgabe für „in die Leibung laufend": höchstens so dick in der Leibung (Leibungsdämmung, Putz).
pub const DEFAULT_REVEAL_LINING: f64 = 0.04;
/// Vorgabe für „Rahmen überdämmt".
pub const DEFAULT_OVERLAP: f64 = 0.03;
const EPS: f64 = 1e-6;

/// Seite einer Öffnung: links = Leibung beim Wandanfang, rechts = beim Wandende.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Side {
    Left,
    Right,
    Top,
    Bottom,
}

#[derive(Clone, Copy, Debug, PartialEq, Default)]
pub struct Sides {
    pub left: f64,
    pub right: f64,
    pub top: f64,
    pub bottom: f64,
}

impl Sides {
    pub fn all(v: f64) -> Sides {
        Sides { left: v, right: v, top: v, bottom: v }
    }
    pub fn get(&self, s: Side) -> f64 {
        match s {
            Side::Left => self.left,
            Side::Right => self.right,
            Side::Top => self.top,
            Side::Bottom => self.bottom,
        }
    }
    fn with(o: Option<&OpeningSides>, d: Sides) -> Sides {
        let Some(o) = o else { return d };
        let f = |v: Option<f64>, d: f64| v.filter(|x| x.is_finite()).map_or(d, |x| x.max(0.0));
        Sides { left: f(o.left, d.left), right: f(o.right, d.right), top: f(o.top, d.top), bottom: f(o.bottom, d.bottom) }
    }
    pub fn uniform(&self) -> bool {
        self.left == self.right && self.left == self.top && self.left == self.bottom
    }
}

/// Bezugsfläche der Rahmenlage.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Face {
    Aussen,
    Innen,
    Mitte,
}

/// Aufgelöstes Rahmen-Detail einer Öffnung (Typ + Übersteuerung).
#[derive(Clone, Debug, PartialEq)]
pub struct Frame {
    /// Blendrahmen-Ansichtsbreite je Seite.
    pub sides: Sides,
    /// Rahmentiefe (NaN = Vorgabe).
    pub depth: f64,
    pub inset: f64,
    pub face: Face,
    /// Flügelrahmen-Breite (NaN = wie Blendrahmen), -Tiefe (NaN), Überschlag.
    pub sash_width: f64,
    pub sash_depth: f64,
    pub sash_overlap: f64,
    /// Pfosten/Kämpfer: Breite und Tiefe (NaN = Vorgabe).
    pub mullion_width: f64,
    pub mullion_depth: f64,
    pub transom_width: f64,
    pub transom_depth: f64,
    /// Verbreiterungsprofile je Seite, Fensterbank- und Storen-Anschlussprofil (0 = keins).
    pub ext: Sides,
    pub sill_profile: f64,
    pub shading_profile: f64,
    /// Anschlag je Seite (0 = keiner).
    pub rebate: Sides,
    /// Ein Detail-Feld ([103]) ist gesetzt (sonst gilt der bisherige Pfad unverändert).
    pub detailed: bool,
}

fn fin(v: Option<f64>) -> Option<f64> {
    v.filter(|x| x.is_finite())
}

/// Rahmen-Detail des Typs, feldweise von der Öffnung übersteuert.
pub fn merged_frame_detail(ty: Option<&FrameDetail>, ov: Option<&FrameDetail>) -> Option<FrameDetail> {
    let (t, o) = match (ty, ov) {
        (None, None) => return None,
        (Some(t), None) => return Some(t.clone()),
        (None, Some(o)) => return Some(o.clone()),
        (Some(t), Some(o)) => (t, o),
    };
    let sides = |a: &Option<OpeningSides>, b: &Option<OpeningSides>| -> Option<OpeningSides> {
        match (a, b) {
            (Some(a), Some(b)) => Some(OpeningSides { left: b.left.or(a.left), right: b.right.or(a.right), top: b.top.or(a.top), bottom: b.bottom.or(a.bottom), extra: Default::default() }),
            (a, b) => b.clone().or_else(|| a.clone()),
        }
    };
    Some(FrameDetail {
        frame_sides: sides(&t.frame_sides, &o.frame_sides),
        frame_depth: o.frame_depth.or(t.frame_depth),
        inset_from_face: o.inset_from_face.or(t.inset_from_face),
        inset_face: o.inset_face.or(t.inset_face),
        sash_width: o.sash_width.or(t.sash_width),
        sash_depth: o.sash_depth.or(t.sash_depth),
        sash_overlap: o.sash_overlap.or(t.sash_overlap),
        mullion_width: o.mullion_width.or(t.mullion_width),
        mullion_depth: o.mullion_depth.or(t.mullion_depth),
        transom_width: o.transom_width.or(t.transom_width),
        transom_depth: o.transom_depth.or(t.transom_depth),
        extension_profiles: sides(&t.extension_profiles, &o.extension_profiles),
        sill_profile: o.sill_profile.or(t.sill_profile),
        shading_profile: o.shading_profile.or(t.shading_profile),
        rebates: sides(&t.rebates, &o.rebates),
        extra: Default::default(),
    })
}

/// Rahmen einer typisierten Öffnung; `None` ohne Typ.
pub fn frame_of(p: &Project, o: &Opening) -> Option<Frame> {
    let (width, depth, inset, face, rebate, detail) = if o.kind == ElementKind::Door {
        let t = p.door_type(o)?;
        let face = match t.inset_face {
            Some(DoorTypeInsetFace::Innen) => Face::Innen,
            Some(DoorTypeInsetFace::Mitte) => Face::Mitte,
            _ => Face::Aussen,
        };
        (t.frame_width, t.frame_depth, t.inset_from_face, face, t.rebate_depth, t.frame_detail.as_ref())
    } else {
        let t = p.window_type(o)?;
        let face = match t.inset_face {
            Some(WindowTypeInsetFace::Innen) => Face::Innen,
            Some(WindowTypeInsetFace::Mitte) => Face::Mitte,
            _ => Face::Aussen,
        };
        (t.frame_width, t.frame_depth, t.inset_from_face, face, t.rebate_depth, t.frame_detail.as_ref())
    };
    let d = merged_frame_detail(detail, o.frame_detail.as_ref());
    let d = d.as_ref();
    let width = fin(width).unwrap_or(DEFAULT_FRAME_WIDTH).max(0.0);
    let face = match d.and_then(|d| d.inset_face) {
        Some(WindowTypeInsetFace::Innen) => Face::Innen,
        Some(WindowTypeInsetFace::Mitte) => Face::Mitte,
        Some(WindowTypeInsetFace::Aussen) => Face::Aussen,
        _ => face,
    };
    let nan = f64::NAN;
    let num = |f: fn(&FrameDetail) -> Option<f64>| d.and_then(f).filter(|x| x.is_finite()).map_or(nan, |x| x.max(0.0));
    Some(Frame {
        sides: Sides::with(d.and_then(|d| d.frame_sides.as_ref()), Sides::all(width)),
        depth: fin(d.and_then(|d| d.frame_depth)).or(fin(depth)).unwrap_or(nan),
        inset: fin(d.and_then(|d| d.inset_from_face)).or(fin(inset)).unwrap_or(0.0).max(0.0),
        face,
        sash_width: num(|d| d.sash_width),
        sash_depth: num(|d| d.sash_depth),
        sash_overlap: num(|d| d.sash_overlap),
        mullion_width: num(|d| d.mullion_width),
        mullion_depth: num(|d| d.mullion_depth),
        transom_width: num(|d| d.transom_width),
        transom_depth: num(|d| d.transom_depth),
        ext: Sides::with(d.and_then(|d| d.extension_profiles.as_ref()), Sides::all(0.0)),
        sill_profile: fin(d.and_then(|d| d.sill_profile)).unwrap_or(0.0).max(0.0),
        shading_profile: fin(d.and_then(|d| d.shading_profile)).unwrap_or(0.0).max(0.0),
        rebate: Sides::with(d.and_then(|d| d.rebates.as_ref()), Sides::all(fin(rebate).unwrap_or(0.0).max(0.0))),
        detailed: d.is_some(),
    })
}

impl Frame {
    /// Rahmenlage quer zur Wand `(lo, hi)` ab der Aussenfläche (wie `opening_geom::window_symbol`).
    pub fn range(&self, total: f64) -> (f64, f64) {
        let depth = total.min(if self.depth > 1e-9 { self.depth } else { DEFAULT_FRAME_DEPTH }).max(0.0);
        let c = |v: f64| v.max(0.0).min(total);
        match self.face {
            Face::Mitte => (c((total - depth) / 2.0), c((total + depth) / 2.0)),
            Face::Aussen => (c(self.inset), c(self.inset + depth)),
            Face::Innen => (c(total - self.inset - depth), c(total - self.inset)),
        }
    }
    /// Anschlag-Zone (zwischen gewählter Fläche und Rahmen) — nur mit Leibung (Einzug > 0 oder mittig).
    pub fn rebate_zone(&self, total: f64) -> Option<(f64, f64)> {
        let (lo, hi) = self.range(total);
        match self.face {
            Face::Innen if self.inset > 1e-4 => Some((hi, total)),
            Face::Aussen if self.inset > 1e-4 => Some((0.0, lo)),
            Face::Mitte => Some((0.0, lo)),
            _ => None,
        }
    }
}

// ── Schichteinzug ([104]) ───────────────────────────────────────────────────

/// Schichteinzug-Regeln einer Öffnung: Öffnung > Typ > veraltetes `innerLayerRecess`.
pub fn reveal_rules(p: &Project, o: &Opening) -> Vec<LayerReveal> {
    if let Some(r) = o.layer_reveals.as_ref() {
        return r.clone();
    }
    if o.kind == ElementKind::Door {
        return p.door_type(o).and_then(|t| t.layer_reveals.clone()).unwrap_or_default();
    }
    let Some(t) = p.window_type(o) else { return Vec::new() };
    if let Some(r) = t.layer_reveals.as_ref() {
        return r.clone();
    }
    if t.inner_layer_recess == Some(true) {
        return vec![LayerReveal { layer: -1.0, mode: RevealMode::Zurueck, ..Default::default() }];
    }
    Vec::new()
}

/// Anschluss EINER Schicht an EINER Seite: Rücksprung (`shift` ≥ 0, die Schicht endet um so viel
/// hinter der Rohbaukante) und Zusatzstücke `[x0, x1, o0, o1]` in der Öffnung (x ab Rohbaukante,
/// o quer ab Aussenfläche) im Material der Schicht.
#[derive(Clone, Debug, PartialEq)]
pub struct LayerAdjust {
    pub layer: usize,
    pub shift: f64,
    pub pieces: Vec<[f64; 4]>,
}

fn side_rule(r: &LayerReveal, side: Side) -> (RevealMode, Option<f64>) {
    let s = match side {
        Side::Left => r.left.as_ref(),
        Side::Right => r.right.as_ref(),
        Side::Top => r.top.as_ref(),
        Side::Bottom => r.bottom.as_ref(),
    };
    match s {
        Some(s) => (s.mode, fin(s.amount)),
        None => (r.mode, fin(r.amount)),
    }
}

/// Index einer Regel-Schicht (ab aussen; negativ ab innen), `None` ausserhalb.
pub fn layer_index(layer: f64, n: usize) -> Option<usize> {
    if !layer.is_finite() {
        return None;
    }
    let k = layer.round() as i64;
    let i = if k < 0 { n as i64 + k } else { k };
    (i >= 0 && (i as usize) < n).then_some(i as usize)
}

/// Schichtanschlüsse an einer Seite für die Schichtdicken `thick` (aussen → innen) und die
/// Rahmenlage `frame` (ab Aussenfläche). Nur Schichten mit Wirkung erscheinen.
pub fn reveal_adjust(thick: &[f64], rules: &[LayerReveal], side: Side, frame: (f64, f64)) -> Vec<LayerAdjust> {
    let n = thick.len();
    if n == 0 || rules.is_empty() || thick.iter().any(|t| !t.is_finite()) {
        return Vec::new();
    }
    let mut mode: Vec<Option<(RevealMode, Option<f64>)>> = vec![None; n];
    for r in rules {
        if let Some(i) = layer_index(r.layer, n) {
            mode[i] = Some(side_rule(r, side));
        }
    }
    let mut bounds = Vec::with_capacity(n);
    let mut acc = 0.0;
    for &t in thick {
        bounds.push((acc, acc + t.max(0.0)));
        acc += t.max(0.0);
    }
    let (flo, fhi) = (frame.0.min(frame.1), frame.0.max(frame.1));
    let mut out: Vec<LayerAdjust> = Vec::new();
    let push = |out: &mut Vec<LayerAdjust>, layer: usize, shift: f64, piece: Option<[f64; 4]>| {
        let e = match out.iter().position(|a| a.layer == layer) {
            Some(k) => &mut out[k],
            None => {
                out.push(LayerAdjust { layer, shift: 0.0, pieces: Vec::new() });
                out.last_mut().expect("eben eingefügt")
            }
        };
        e.shift = e.shift.max(shift);
        if let Some(pc) = piece {
            if pc[1] - pc[0] > EPS && pc[3] - pc[2] > EPS {
                e.pieces.push(pc);
            }
        }
    };
    // Zurück, überdämmt.
    for i in 0..n {
        let Some((m, amount)) = mode[i] else { continue };
        let (l0, l1) = bounds[i];
        match m {
            RevealMode::Zurueck => push(&mut out, i, amount.unwrap_or(l1 - l0).max(0.0), None),
            RevealMode::Ueberdaemmt => {
                let a = amount.unwrap_or(DEFAULT_OVERLAP).max(0.0);
                // Nur der Teil der Schicht vor bzw. hinter dem Rahmen.
                for (s0, s1) in [(l0, l1.min(flo)), (l0.max(fhi), l1)] {
                    if s1 - s0 > EPS {
                        push(&mut out, i, 0.0, Some([0.0, a, s0, s1]));
                    }
                }
            }
            _ => {}
        }
    }
    // In die Leibung: je Seite des Rahmens vom Rahmen weg gestapelt (die rahmennächste Schicht
    // liegt auf dem Rohbau, die äussere legt sich darüber).
    for outer in [true, false] {
        let mut order: Vec<usize> = (0..n).filter(|&i| if outer { bounds[i].1 <= flo + EPS } else { bounds[i].0 >= fhi - EPS }).collect();
        if outer {
            order.reverse();
        }
        let mut acc = 0.0f64;
        for i in order {
            let Some((m, amount)) = mode[i] else { continue };
            let (l0, l1) = bounds[i];
            match m {
                RevealMode::Leibung => {
                    let a = amount.unwrap_or((l1 - l0).min(DEFAULT_REVEAL_LINING)).max(0.0);
                    push(&mut out, i, 0.0, Some([0.0, acc + a, l0, l1]));
                    let strip = if outer { [acc, acc + a, l1, flo] } else { [acc, acc + a, fhi, l0] };
                    push(&mut out, i, 0.0, Some(strip));
                    acc += a;
                }
                RevealMode::Ueberdaemmt => acc = acc.max(amount.unwrap_or(DEFAULT_OVERLAP).max(0.0)),
                _ => {}
            }
        }
    }
    out.retain(|a| a.shift > EPS || !a.pieces.is_empty());
    out.sort_by_key(|a| a.layer);
    out
}

/// Rahmen ohne Typ (Schichteinzug nur über die Öffnung): Vorgabe aussen bündig.
fn default_frame() -> Frame {
    Frame {
        sides: Sides::all(DEFAULT_FRAME_WIDTH),
        depth: f64::NAN,
        inset: 0.0,
        face: Face::Aussen,
        sash_width: f64::NAN,
        sash_depth: f64::NAN,
        sash_overlap: f64::NAN,
        mullion_width: f64::NAN,
        mullion_depth: f64::NAN,
        transom_width: f64::NAN,
        transom_depth: f64::NAN,
        ext: Sides::default(),
        sill_profile: 0.0,
        shading_profile: 0.0,
        rebate: Sides::default(),
        detailed: false,
    }
}

/// Schichteinzug einer Öffnung in ihrer Wand: Achs-Intervall, Schichtdicken (aussen → innen)
/// und die Anschlüsse je Seite (links, rechts, oben, unten).
#[derive(Clone, Debug, PartialEq)]
pub struct OpeningReveal {
    pub from: f64,
    pub to: f64,
    pub thick: Vec<f64>,
    pub sides: [Vec<LayerAdjust>; 4],
}

pub const SIDES: [Side; 4] = [Side::Left, Side::Right, Side::Top, Side::Bottom];

/// `None`: keine Regeln, kein Wandtyp oder Öffnung ausserhalb der Wand.
pub fn opening_reveal(p: &Project, w: &Wall, o: &Opening) -> Option<OpeningReveal> {
    let rules = reveal_rules(p, o);
    if rules.is_empty() {
        return None;
    }
    let wt = p.wall_type(w)?;
    let thick: Vec<f64> = wt.layers.iter().map(|l| l.thickness).collect();
    let total: f64 = thick.iter().sum();
    if !(total > 1e-6) {
        return None;
    }
    let frame = frame_of(p, o).unwrap_or_else(default_frame);
    let range = frame.range(total);
    let wr = crate::opening_geom::WallRef {
        start: crate::opening_geom::v(w.start.x, w.start.y),
        end: crate::opening_geom::v(w.end.x, w.end.y),
        total,
        ref_off: crate::joins::reference_offset(crate::model3d::wall_reference(w), total),
    };
    let (from, to) = crate::opening_geom::opening_interval(&wr, o.position, o.width)?;
    let sides = SIDES.map(|s| reveal_adjust(&thick, &rules, s, range));
    if sides.iter().all(|v| v.is_empty()) {
        return None;
    }
    Some(OpeningReveal { from, to, thick, sides })
}

/// Grundriss-Block für `plan_walls::wall_poche` (Leibungen links/rechts aller Öffnungen der Wand):
/// `[n, (jamb, dir, schicht, rücksprung, nStücke, (x0, x1, o0, o1)×)×n]`.
pub fn plan_reveal_block(p: &Project, w: &Wall, openings: &[&Opening]) -> Vec<f64> {
    let mut b = vec![0.0];
    let mut n = 0.0;
    for o in openings {
        let Some(r) = opening_reveal(p, w, o) else { continue };
        for (k, (jamb, dir)) in [(r.from, 1.0), (r.to, -1.0)].into_iter().enumerate() {
            for a in &r.sides[k] {
                b.extend([jamb, dir, a.layer as f64, a.shift, a.pieces.len() as f64]);
                for pc in &a.pieces {
                    b.extend(pc);
                }
                n += 1.0;
            }
        }
    }
    b[0] = n;
    b
}

/// Vorgaben für den Schichteinzug (Dialog): Name und Regeln.
pub fn reveal_presets() -> Vec<(&'static str, Vec<LayerReveal>)> {
    let r = |layer: f64, mode: RevealMode, amount: Option<f64>| LayerReveal { layer, mode, amount, ..Default::default() };
    vec![
        ("buendig", vec![]),
        ("ueberdaemmt3_putzLeibung", vec![r(0.0, RevealMode::Ueberdaemmt, Some(0.03)), r(-1.0, RevealMode::Leibung, None)]),
        ("leibungsdaemmung_putzLeibung", vec![r(0.0, RevealMode::Leibung, Some(0.03)), r(-1.0, RevealMode::Leibung, None)]),
        ("innenZurueck", vec![r(-1.0, RevealMode::Zurueck, None)]),
        ("putzLeibungBeidseitig", vec![r(0.0, RevealMode::Leibung, None), r(-1.0, RevealMode::Leibung, None)]),
    ]
}

// ── Türzargen und -rahmen ([103]) ───────────────────────────────────────────

/// Bauteil eines Zargen-/Rahmenprofils.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FramePart {
    /// Rahmen/Zarge (Holz oder Stahl).
    Frame,
    /// Futterbrett in der Leibung.
    Lining,
    /// Bekleidung auf der Wandfläche.
    Casing,
}

/// Aufgelöste Türzarge einer Öffnung (nur Arten mit eigener Zeichnung).
#[derive(Clone, Debug, PartialEq)]
pub struct DoorFrame {
    pub kind: DoorTypeFrameKind,
    pub frame: Frame,
    pub falz_width: f64,
    pub falz_depth: f64,
    pub spiegel: f64,
    pub sheet: f64,
    pub lining: f64,
    pub casing_width: f64,
    pub casing_thickness: f64,
    pub casing_sides: CasingSides,
    /// Stahl (Umfassungs-/Eckzarge) — in der Zeichnung gefüllt.
    pub steel: bool,
}

/// Zarge der Tür, wenn ihre Art eine eigene Zeichnung hat (Zarge alt bleibt beim bisherigen Pfad).
pub fn door_frame_of(p: &Project, o: &Opening) -> Option<DoorFrame> {
    if o.kind != ElementKind::Door {
        return None;
    }
    let t = p.door_type(o)?;
    if t.kind == DoorTypeKind::Wandoeffnung || o.door_type == Some(OpeningDoorType::Wandoeffnung) {
        return None;
    }
    let kind = o.door_frame_kind.or(t.frame_kind).unwrap_or_default();
    // Zarge und Blockrahmen behalten das bisherige Rahmenband ([94]).
    if matches!(kind, DoorTypeFrameKind::Zarge | DoorTypeFrameKind::Blockrahmen | DoorTypeFrameKind::Unknown) {
        return None;
    }
    let (a, b) = (t.door_frame.as_ref(), o.door_frame.as_ref());
    let g = |f: fn(&DoorFrameDetail) -> Option<f64>, d: f64| fin(b.and_then(f)).or(fin(a.and_then(f))).unwrap_or(d).max(0.0);
    Some(DoorFrame {
        kind,
        frame: frame_of(p, o)?,
        falz_width: g(|d| d.falz_width, 0.015),
        falz_depth: g(|d| d.falz_depth, 0.04),
        spiegel: g(|d| d.spiegel, 0.05),
        sheet: g(|d| d.sheet_thickness, 0.002).max(0.0005),
        lining: g(|d| d.lining_thickness, 0.025),
        casing_width: g(|d| d.casing_width, 0.07),
        casing_thickness: g(|d| d.casing_thickness, 0.012),
        casing_sides: b.and_then(|d| d.casing_sides).or(a.and_then(|d| d.casing_sides)).unwrap_or_default(),
        steel: matches!(kind, DoorTypeFrameKind::Umfassungszarge | DoorTypeFrameKind::Eckzarge),
    })
}

/// Liegt die Aufschlagseite (wohin das Blatt aufgeht) auf der Innenfläche (hohe Versätze)?
/// Gleiche Regel wie der Schnitt einer Schiebetür (`plan/section.rs`).
pub fn aufschlag_innen(o: &Opening) -> bool {
    let swing = if matches!(o.swing, None | Some(SwingSide::Left)) { 1.0 } else { -1.0 };
    let dir = if matches!(o.opening_dir, None | Some(OpeningOpeningDir::In)) { 1.0 } else { -1.0 };
    swing * dir > 0.0
}

/// Einbaufuge zwischen Mauerwerk und Stahlzarge.
const ZARGE_GAP: f64 = 0.01;

/// Orthogonaler Linienzug, nach rechts (in Laufrichtung) um `t` verdickt, als geschlossenes Polygon.
fn thick_path(path: &[[f64; 2]], t: f64) -> Vec<[f64; 2]> {
    let n = path.len();
    if n < 2 {
        return Vec::new();
    }
    let right = |a: [f64; 2], b: [f64; 2]| {
        let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
        let l = (dx * dx + dy * dy).sqrt().max(1e-12);
        [dy / l * t, -dx / l * t]
    };
    let mut off = Vec::with_capacity(n);
    for i in 0..n {
        let ni = if i == 0 { right(path[0], path[1]) } else { right(path[i - 1], path[i]) };
        let nj = if i + 1 < n { right(path[i], path[i + 1]) } else { ni };
        // Orthogonale Ecke: Summe der beiden Versätze (bei gerader Fortsetzung nur einer).
        let same = (ni[0] - nj[0]).abs() < 1e-12 && (ni[1] - nj[1]).abs() < 1e-12;
        let d = if same { ni } else { [ni[0] + nj[0], ni[1] + nj[1]] };
        off.push([path[i][0] + d[0], path[i][1] + d[1]]);
    }
    let mut poly = path.to_vec();
    poly.extend(off.into_iter().rev());
    poly
}

/// Profil der Zarge an der linken Leibung: Polygone in `(x, d)`; `x` in die Öffnung ab Rohbaukante,
/// `d` ab der Aufschlagfläche in die Wand (0 … `total`, < 0 = vor der Fläche). Die rechte Leibung
/// spiegelt `x`, der Sturz nimmt `x` nach unten.
pub fn door_frame_profile(f: &DoorFrame, total: f64, aufschlag_innen: bool) -> Vec<(FramePart, Vec<[f64; 2]>)> {
    let t = total.max(0.0);
    let (fzw, fzd) = (f.falz_width, f.falz_depth.min(t));
    let fw = f.frame.sides.left.max(fzw + 0.01);
    let rect = |x0: f64, x1: f64, d0: f64, d1: f64| vec![[x0, d0], [x1, d0], [x1, d1], [x0, d1]];
    let mut out = Vec::new();
    match f.kind {
        DoorTypeFrameKind::Umfassungszarge => {
            let c = ZARGE_GAP;
            let path = [[-f.spiegel, 0.0], [c, 0.0], [c, fzd], [c + fzw, fzd], [c + fzw, t], [-f.spiegel, t]];
            out.push((FramePart::Frame, thick_path(&path, f.sheet)));
        }
        DoorTypeFrameKind::Eckzarge => {
            let c = ZARGE_GAP;
            let path = [[-f.spiegel, 0.0], [c, 0.0], [c, fzd], [c + fzw, fzd], [c + fzw, (fzd + 0.03).min(t)]];
            out.push((FramePart::Frame, thick_path(&path, f.sheet)));
        }
        DoorTypeFrameKind::Blockzarge => {
            out.push((FramePart::Frame, vec![[0.0, 0.0], [fw - fzw, 0.0], [fw - fzw, fzd], [fw, fzd], [fw, t], [0.0, t]]));
        }
        DoorTypeFrameKind::Blockrahmen => {
            // Lage aus insetFace/insetFromFace (ab Aussenfläche) in Aufschlag-Koordinaten.
            let (lo, hi) = f.frame.range(t);
            let (d0, d1) = if aufschlag_innen { (t - hi, t - lo) } else { (lo, hi) };
            let fzd = fzd.min(d1 - d0);
            out.push((FramePart::Frame, vec![[0.0, d0], [fw - fzw, d0], [fw - fzw, d0 + fzd], [fw, d0 + fzd], [fw, d1], [0.0, d1]]));
        }
        DoorTypeFrameKind::Blendrahmen => {
            let fd = if f.frame.depth > 1e-9 { f.frame.depth } else { DEFAULT_FRAME_DEPTH };
            let ov = fzw;
            out.push((FramePart::Frame, vec![[ov - fw, 0.0], [ov, 0.0], [ov, -fd + fzd.min(fd)], [ov - fzw, -fd + fzd.min(fd)], [ov - fzw, -fd], [ov - fw, -fd]]));
        }
        DoorTypeFrameKind::Futter => {
            let lt = f.lining;
            out.push((FramePart::Lining, rect(0.0, lt, 0.0, t)));
            let (cw, ct) = (f.casing_width, f.casing_thickness);
            if matches!(f.casing_sides, CasingSides::Beide | CasingSides::Aufschlag) {
                out.push((FramePart::Casing, rect(lt + fzw - cw, lt + fzw, -ct, 0.0)));
            }
            if matches!(f.casing_sides, CasingSides::Beide | CasingSides::Gegen) {
                out.push((FramePart::Casing, rect(lt + 0.005 - cw, lt + 0.005, t, t + ct)));
            }
        }
        _ => {}
    }
    out.retain(|(_, p)| p.len() >= 3);
    out
}

/// Lage des Türblatts quer zur Wand `(d0, d1)` ab der Aufschlagfläche: im Falz der Zarge.
pub fn leaf_band(f: &DoorFrame, total: f64, aufschlag_innen: bool) -> (f64, f64) {
    let leaf = f.falz_depth.clamp(0.02, 0.08);
    match f.kind {
        DoorTypeFrameKind::Blockrahmen => {
            let (lo, hi) = f.frame.range(total);
            let d0 = if aufschlag_innen { total - hi } else { lo };
            (d0, d0 + leaf)
        }
        DoorTypeFrameKind::Blendrahmen => {
            let fd = if f.frame.depth > 1e-9 { f.frame.depth } else { DEFAULT_FRAME_DEPTH };
            (-fd, -fd + leaf)
        }
        _ => (0.0, leaf),
    }
}

/// Lichte Kante der Zarge (grösstes `x` des Profils in der Öffnung).
pub fn profile_clear_x(profile: &[(FramePart, Vec<[f64; 2]>)]) -> f64 {
    profile.iter().flat_map(|(_, p)| p.iter().map(|q| q[0])).fold(0.0, f64::max)
}

/// Zerlegt ein orthogonales Polygon in Rechtecke `[x0, x1, d0, d1]` (für 3D-Quader).
pub fn ortho_rects(poly: &[[f64; 2]]) -> Vec<[f64; 4]> {
    let mut xs: Vec<f64> = poly.iter().map(|p| p[0]).collect();
    let mut ds: Vec<f64> = poly.iter().map(|p| p[1]).collect();
    let srt = |v: &mut Vec<f64>| {
        v.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        v.dedup_by(|a, b| (*a - *b).abs() < 1e-9);
    };
    srt(&mut xs);
    srt(&mut ds);
    let inside = |x: f64, y: f64| {
        let mut c = false;
        let n = poly.len();
        for i in 0..n {
            let (a, b) = (poly[i], poly[(i + 1) % n]);
            if (a[1] > y) != (b[1] > y) && x < a[0] + (y - a[1]) / (b[1] - a[1]) * (b[0] - a[0]) {
                c = !c;
            }
        }
        c
    };
    let mut out: Vec<[f64; 4]> = Vec::new();
    for i in 0..xs.len().saturating_sub(1) {
        let xm = (xs[i] + xs[i + 1]) / 2.0;
        let mut run: Option<f64> = None;
        for j in 0..ds.len().saturating_sub(1) {
            let inn = inside(xm, (ds[j] + ds[j + 1]) / 2.0);
            match (inn, run) {
                (true, None) => run = Some(ds[j]),
                (false, Some(d0)) => {
                    out.push([xs[i], xs[i + 1], d0, ds[j]]);
                    run = None;
                }
                _ => {}
            }
        }
        if let Some(d0) = run {
            out.push([xs[i], xs[i + 1], d0, *ds.last().expect("nicht leer")]);
        }
    }
    out
}

/// Achsen-Quader (Ecken-Bits wie `OPENING_BOX_TRIS`: bit0 Achse, bit1 Höhe, bit2 quer) in Weltkoordinaten:
/// Wandstart `s`, Achsrichtung `u`, linke Normale `n`; Achsmass `a0..a1`, Höhe `z0..z1`, Versatz `o0..o1`.
#[allow(clippy::too_many_arguments)]
pub fn axis_box(s: [f64; 2], u: [f64; 2], n: [f64; 2], a0: f64, a1: f64, z0: f64, z1: f64, o0: f64, o1: f64) -> Option<[f64; 24]> {
    if !(a1 - a0 > EPS && z1 - z0 > EPS && (o1 - o0).abs() > EPS) || ![a0, a1, z0, z1, o0, o1].iter().all(|v| v.is_finite()) {
        return None;
    }
    let mut p = [0.0; 24];
    for i in 0..8 {
        let a = if i & 1 != 0 { a1 } else { a0 };
        let z = if i & 2 != 0 { z1 } else { z0 };
        let o = if i & 4 != 0 { o1 } else { o0 };
        p[i * 3] = s[0] + u[0] * a + n[0] * o;
        p[i * 3 + 1] = s[1] + u[1] * a + n[1] * o;
        p[i * 3 + 2] = z;
    }
    Some(p)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(layer: f64, mode: RevealMode, amount: Option<f64>) -> LayerReveal {
        LayerReveal { layer, mode, amount, ..Default::default() }
    }

    /// Aussendämmung 0.16, Backstein 0.15, Innenputz 0.01; Rahmen 0.16..0.23 (auf dem Backstein).
    const WALL: [f64; 3] = [0.16, 0.15, 0.01];
    const FRAME: (f64, f64) = (0.16, 0.23);

    #[test]
    fn buendig_ohne_wirkung() {
        assert!(reveal_adjust(&WALL, &[rule(0.0, RevealMode::Buendig, None)], Side::Left, FRAME).is_empty());
        assert!(reveal_adjust(&WALL, &[], Side::Left, FRAME).is_empty());
    }

    #[test]
    fn zurueck_um_schichtdicke_und_mass() {
        let a = reveal_adjust(&WALL, &[rule(-1.0, RevealMode::Zurueck, None)], Side::Top, FRAME);
        assert_eq!(a.len(), 1);
        assert_eq!(a[0].layer, 2);
        assert!((a[0].shift - 0.01).abs() < 1e-12);
        let a = reveal_adjust(&WALL, &[rule(0.0, RevealMode::Zurueck, Some(0.05))], Side::Left, FRAME);
        assert_eq!((a[0].layer, a[0].shift), (0, 0.05));
    }

    #[test]
    fn ueberdaemmt_nur_vor_dem_rahmen() {
        let a = reveal_adjust(&WALL, &[rule(0.0, RevealMode::Ueberdaemmt, Some(0.03))], Side::Left, FRAME);
        assert_eq!(a[0].pieces, vec![[0.0, 0.03, 0.0, 0.16]]);
        // Rahmen mitten in der Dämmung: nur der Teil davor.
        let a = reveal_adjust(&WALL, &[rule(0.0, RevealMode::Ueberdaemmt, None)], Side::Left, (0.1, 0.17));
        assert_eq!(a[0].pieces, vec![[0.0, 0.03, 0.0, 0.1]]);
    }

    #[test]
    fn innenputz_in_die_leibung_bis_rahmen() {
        let a = reveal_adjust(&WALL, &[rule(-1.0, RevealMode::Leibung, None)], Side::Right, FRAME);
        assert_eq!(a.len(), 1);
        // Ecke im Putz-Band und Streifen über die Backstein-Leibung bis an den Rahmen.
        assert_eq!(a[0].pieces.len(), 2);
        let s = a[0].pieces[1];
        assert!((s[1] - 0.01).abs() < 1e-12 && (s[2] - 0.23).abs() < 1e-12 && (s[3] - 0.31).abs() < 1e-12);
    }

    #[test]
    fn leibung_stapelt_vom_rahmen_weg() {
        // Rahmen innen auf dem Backstein: Dämmung (3 cm) und Aussenputz laufen in die Leibung.
        let wall = [0.02, 0.16, 0.15];
        let rules = [rule(0.0, RevealMode::Leibung, Some(0.01)), rule(1.0, RevealMode::Leibung, Some(0.03))];
        let a = reveal_adjust(&wall, &rules, Side::Left, (0.18, 0.25));
        let putz = a.iter().find(|x| x.layer == 0).unwrap();
        // Putz liegt über der Dämmung: x 0.03 … 0.04.
        assert!(putz.pieces.iter().any(|p| (p[0] - 0.03).abs() < 1e-12 && (p[1] - 0.04).abs() < 1e-12));
    }

    #[test]
    fn veraltetes_inner_layer_recess_wird_regel() {
        let mut p = Project::default();
        p.window_types = Some(vec![WindowType { id: "w".into(), inner_layer_recess: Some(true), ..Default::default() }]);
        let o = Opening { kind: ElementKind::Window, type_id: Some("w".into()), ..Default::default() };
        let r = reveal_rules(&p, &o);
        assert_eq!(r.len(), 1);
        assert_eq!((r[0].layer, r[0].mode), (-1.0, RevealMode::Zurueck));
        // Öffnung übersteuert.
        let o2 = Opening { layer_reveals: Some(vec![]), ..o };
        assert!(reveal_rules(&p, &o2).is_empty());
    }

    #[test]
    fn rahmen_je_seite_und_uebersteuerung() {
        let mut p = Project::default();
        let fd = FrameDetail { frame_sides: Some(OpeningSides { bottom: Some(0.09), ..Default::default() }), rebates: Some(OpeningSides { left: Some(0.0), ..Default::default() }), ..Default::default() };
        p.window_types = Some(vec![WindowType { id: "w".into(), frame_width: Some(0.07), rebate_depth: Some(0.05), frame_detail: Some(fd), ..Default::default() }]);
        let o = Opening { kind: ElementKind::Window, type_id: Some("w".into()), frame_detail: Some(FrameDetail { frame_sides: Some(OpeningSides { top: Some(0.12), ..Default::default() }), ..Default::default() }), ..Default::default() };
        let f = frame_of(&p, &o).unwrap();
        assert_eq!(f.sides, Sides { left: 0.07, right: 0.07, top: 0.12, bottom: 0.09 });
        assert_eq!(f.rebate, Sides { left: 0.0, right: 0.05, top: 0.05, bottom: 0.05 });
        assert!(f.detailed);
        assert_eq!(f.sill_profile, 0.0);
    }

    #[test]
    fn zargen_profile() {
        let mut p = Project::default();
        let mk = |k| DoorType { id: "d".into(), frame_kind: Some(k), frame_width: Some(0.06), ..Default::default() };
        let o = Opening { kind: ElementKind::Door, type_id: Some("d".into()), ..Default::default() };
        for k in [DoorTypeFrameKind::Umfassungszarge, DoorTypeFrameKind::Eckzarge, DoorTypeFrameKind::Blockzarge, DoorTypeFrameKind::Blendrahmen, DoorTypeFrameKind::Futter] {
            p.door_types = Some(vec![mk(k)]);
            let f = door_frame_of(&p, &o).unwrap();
            let prof = door_frame_profile(&f, 0.3, false);
            assert!(!prof.is_empty(), "{k:?}");
            for (_, poly) in &prof {
                let r = ortho_rects(poly);
                assert!(!r.is_empty(), "{k:?}");
            }
        }
        p.door_types = Some(vec![mk(DoorTypeFrameKind::Zarge)]);
        assert!(door_frame_of(&p, &o).is_none());
        // Umfassungszarge: Spiegel beidseitig über die Wandflächen hinaus.
        p.door_types = Some(vec![mk(DoorTypeFrameKind::Umfassungszarge)]);
        let f = door_frame_of(&p, &o).unwrap();
        let prof = door_frame_profile(&f, 0.3, false);
        let ds: Vec<f64> = prof[0].1.iter().map(|q| q[1]).collect();
        assert!(ds.iter().any(|&d| d < 0.0) && ds.iter().any(|&d| d > 0.3));
        // Futter: Bekleidung beidseitig.
        p.door_types = Some(vec![mk(DoorTypeFrameKind::Futter)]);
        let prof = door_frame_profile(&door_frame_of(&p, &o).unwrap(), 0.3, false);
        assert_eq!(prof.iter().filter(|(k, _)| *k == FramePart::Casing).count(), 2);
    }

    /// Projekt: Aussenwand (Putz, Dämmung, Backstein, Putz) mit einer Öffnung des Typs `t`.
    fn wand_mit(win: Option<WindowType>, door: Option<DoorType>) -> Project {
        let mut p = Project::default();
        for (id, _) in [("a", 0), ("b", 1), ("c", 2), ("d", 3)] {
            p.components.push(Component { id: id.into(), ..Default::default() });
        }
        let l = |c: &str, t: f64| Layer { component_id: c.into(), thickness: t, ..Default::default() };
        p.wall_types.push(WallType { id: "aw".into(), layers: vec![l("a", 0.02), l("b", 0.16), l("c", 0.15), l("d", 0.015)], ..Default::default() });
        p.drawing_levels.push(DrawingLevel { id: "eg".into(), kind: DrawingLevelKind::Floor, floor_height: Some(2.6), ..Default::default() });
        p.walls.push(Wall { id: "w".into(), floor_id: "eg".into(), wall_type_id: "aw".into(), start: Vec2 { x: 0.0, y: 0.0 }, end: Vec2 { x: 5.0, y: 0.0 }, height: 2.6, ..Default::default() });
        let kind = if door.is_some() { ElementKind::Door } else { ElementKind::Window };
        p.window_types = win.map(|t| vec![t]);
        p.door_types = door.map(|t| vec![t]);
        p.openings = Some(vec![Opening { id: "o".into(), host_wall_id: "w".into(), kind, type_id: Some("t".into()), position: 1.0, width: 1.2, height: 1.4, sill_height: if kind == ElementKind::Window { 0.9 } else { 0.0 }, ..Default::default() }]);
        p
    }

    #[test]
    fn schichteinzug_im_3d_und_grundriss_block() {
        let reveals = vec![LayerReveal { layer: 1.0, mode: RevealMode::Ueberdaemmt, amount: Some(0.03), ..Default::default() }, LayerReveal { layer: -1.0, mode: RevealMode::Leibung, ..Default::default() }];
        let p = wand_mit(Some(WindowType { id: "t".into(), inset_from_face: Some(0.18), frame_depth: Some(0.08), layer_reveals: Some(reveals), ..Default::default() }), None);
        let walls = crate::model3d::emit_walls(&p, true).unwrap();
        // Zusatzstücke (eigene Dicke): Dämmung 0.16 über dem Rahmen, Putz-Streifen in der Leibung.
        assert!(walls.iter().any(|w| (w.thickness - 0.16).abs() < 1e-9 && w.holes.is_none() && (w.end[0] - w.start[0] - 1.2).abs() < 1e-9));
        assert!(walls.iter().any(|w| (w.thickness - 0.07).abs() < 1e-9));
        let b = plan_reveal_block(&p, &p.walls[0], &[&p.openings.as_ref().unwrap()[0]]);
        assert!(b[0] >= 2.0);
        // Ohne Regeln: kein Block, keine Stücke.
        let p0 = wand_mit(Some(WindowType { id: "t".into(), ..Default::default() }), None);
        assert_eq!(plan_reveal_block(&p0, &p0.walls[0], &[&p0.openings.as_ref().unwrap()[0]]), vec![0.0]);
    }

    #[test]
    fn zarge_und_rahmen_detail_im_3d() {
        let p = wand_mit(None, Some(DoorType { id: "t".into(), frame_kind: Some(DoorTypeFrameKind::Futter), frame_width: Some(0.06), ..Default::default() }));
        let p0 = wand_mit(None, Some(DoorType { id: "t".into(), frame_width: Some(0.06), ..Default::default() }));
        let pos = |p: &Project| crate::model3d::emit_opening_meshes(p, 1.0).into_iter().map(|m| m.positions).collect::<Vec<_>>();
        assert_ne!(pos(&p), pos(&p0));
        // Fensterrahmen je Seite: unten breiter ⇒ andere Quader als gleichmässig.
        let fd = FrameDetail { frame_sides: Some(OpeningSides { bottom: Some(0.12), ..Default::default() }), sill_profile: Some(0.03), ..Default::default() };
        let a = crate::model3d::emit_opening_meshes(&wand_mit(Some(WindowType { id: "t".into(), frame_width: Some(0.06), frame_detail: Some(fd), ..Default::default() }), None), 1.0);
        let b = crate::model3d::emit_opening_meshes(&wand_mit(Some(WindowType { id: "t".into(), frame_width: Some(0.06), ..Default::default() }), None), 1.0);
        assert_ne!(a.iter().map(|m| m.positions.clone()).collect::<Vec<_>>(), b.iter().map(|m| m.positions.clone()).collect::<Vec<_>>());
    }

    #[test]
    fn rechtecke_eines_l_profils() {
        let r = ortho_rects(&[[0.0, 0.0], [2.0, 0.0], [2.0, 1.0], [1.0, 1.0], [1.0, 3.0], [0.0, 3.0]]);
        let area: f64 = r.iter().map(|q| (q[1] - q[0]) * (q[3] - q[2])).sum();
        assert!((area - 4.0).abs() < 1e-12);
    }
}
