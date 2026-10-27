//! Plan-Puffer ([K3b]): kompakte Binärkodierung der zeichnungsrelevanten Plan-Primitive als
//! flacher `f64`-Puffer (TS schreibt ihn heute in `src/plan/planBuf.ts`, später erzeugt Rust ihn
//! direkt, [K3a]). Pick-IDs gehören nicht hinein (Picken bleibt vorerst TS); dafür hat jedes
//! Primitiv genau einen Eintrag, damit Indizes und Bereiche (`greyedRanges`, Chunks) gleich bleiben.
//!
//! ```text
//! Kopf        [MAGIC, VERSION, nColors, nHatches, nPrims]
//!             MAGIC = 0x504C4231 ("PLB1"), VERSION = 1 — fremde Werte → Puffer abgelehnt
//! Farben      nColors × [r, g, b, a]           (0..1, aus dem Farbtext in TS geparst)
//! Schraffuren nHatches × Hatch
//! Primitive   nPrims × Prim
//!
//! Hatch  [pattern, kind, flags, scale, angle, colorIdx, lineWeight, originX, originY,
//!         seed, density, lengthMin, lengthMax, nDash, dash…, (Motiv: length, nPts, x,y…)]
//!        pattern 0 none · 1 solid · 2 diagonal · 3 crosshatch · 4 insulation · 5 custom
//!        kind    0 vector · 1 image · 2 gradient   (Bild/Verlauf: GPU fällt auf die Füllung zurück)
//!        flags   1 random · 2 origin · 4 seed · 8 density · 16 lengthMin · 32 lengthMax · 64 Motiv
//!        (Felder ohne Flag stehen auf 0 und gelten als „nicht gesetzt“)
//!
//! Prim   [tag, flags, …]   flags 1 greyed · 2 opacity gesetzt · 4 setzt den Linienzug der
//!                          vorigen Linie fort · 8 Zickzack · 16 Motiv
//!   0 Platzhalter      [0]                                   (Text, Bild … — zeichnet die GPU nicht)
//!   1 polygon          [1, flags, fillIdx, strokeIdx, strokeWidthMm, hatchIdx, opacity,
//!                       nPts, x,y…, nNoStroke, kante…]
//!   2 line             [2, flags, colorIdx, weightMm, opacity, ax, ay, bx, by, nDash, dash…,
//!                       (Zickzack: amplitude, wavelength), (Motiv: length, nPts, x,y…)]
//!   3 arc              [3, flags, colorIdx, weightMm, opacity, cx, cy, fromX, fromY, toX, toY, r,
//!                       nDash, dash…]
//!   4 drawingCircle    [4, flags, fillIdx, strokeIdx, weightMm, opacity, cx, cy, r, nDash, dash…]
//!   5 drawingArc       [5, flags, strokeIdx, weightMm, opacity, cx, cy, r, a0, a1, nDash, dash…]
//! ```
//! Farb-/Schraffur-Index −1 = keine (Farbtext ungültig, "none", fehlende Schraffur). Längen in
//! Metern, Strichstärken/Strichmuster/Zickzack/Motiv in Papier-mm, Winkel von drawingArc in
//! Bogenmass, Schraffur-Winkel in Grad (SVG-Drehsinn). Ohne opacity-Flag steht 1 im Feld.
//! Fehlende Strichstärke (`undefined`) wird NaN (der Verbraucher nimmt dann seinen Standard).
//! Flag 4 (Linienzug): TS prüft gleiches Element (`drawingId`), gleiche Farbe/Stärke/greyed/
//! opacity/Strichmuster und Anfang = Ende der vorigen Linie; der Verbraucher prüft die Lage nach.

use crate::hatch::{Hatch, HatchKind, Motif, Pattern, V2};

pub const MAGIC: f64 = 1_347_174_961.0; // 0x504C4231
pub const VERSION: f64 = 1.0;

pub const FLAG_GREYED: u32 = 1;
pub const FLAG_OPACITY: u32 = 2;
pub const FLAG_CHAIN: u32 = 4;
pub const FLAG_ZIGZAG: u32 = 8;
pub const FLAG_MOTIF: u32 = 16;

const HF_RANDOM: u32 = 1;
const HF_ORIGIN: u32 = 2;
const HF_SEED: u32 = 4;
const HF_DENSITY: u32 = 8;
const HF_LEN_MIN: u32 = 16;
const HF_LEN_MAX: u32 = 32;
const HF_MOTIF: u32 = 64;

/// Gemeinsame Darstellungs-Attribute.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Style {
    pub greyed: bool,
    /// `None` = nicht gesetzt (deckend).
    pub opacity: Option<f64>,
}

/// Schraffur samt Farbindex.
#[derive(Clone, Debug, PartialEq)]
pub struct HatchEntry {
    pub hatch: Hatch,
    pub color: i32,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Prim {
    Placeholder,
    Polygon {
        style: Style,
        fill: i32,
        stroke: i32,
        stroke_width_mm: f64,
        hatch: i32,
        pts: Vec<V2>,
        no_stroke_edges: Vec<f64>,
    },
    Line {
        style: Style,
        color: i32,
        weight_mm: f64,
        a: V2,
        b: V2,
        dash: Vec<f64>,
        /// Setzt den Linienzug der vorigen Linie fort (gleiches Element und gleicher Stil).
        chain: bool,
        zigzag: Option<(f64, f64)>,
        motif: Option<Motif>,
    },
    Arc {
        style: Style,
        color: i32,
        weight_mm: f64,
        center: V2,
        from: V2,
        to: V2,
        r: f64,
        dash: Vec<f64>,
    },
    Circle {
        style: Style,
        fill: i32,
        stroke: i32,
        weight_mm: f64,
        center: V2,
        r: f64,
        dash: Vec<f64>,
    },
    DrawingArc {
        style: Style,
        stroke: i32,
        weight_mm: f64,
        center: V2,
        r: f64,
        a0: f64,
        a1: f64,
        dash: Vec<f64>,
    },
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct PlanBuf {
    pub colors: Vec<[f64; 4]>,
    pub hatches: Vec<HatchEntry>,
    pub prims: Vec<Prim>,
}

impl PlanBuf {
    pub fn color(&self, idx: i32) -> Option<[f64; 4]> {
        if idx < 0 {
            None
        } else {
            self.colors.get(idx as usize).copied()
        }
    }
}

// ── Lesen ───────────────────────────────────────────────────────────────────

struct Reader<'a> {
    buf: &'a [f64],
    pos: usize,
}

impl<'a> Reader<'a> {
    fn f(&mut self) -> Option<f64> {
        let v = *self.buf.get(self.pos)?;
        self.pos += 1;
        Some(v)
    }
    /// Nicht-negative ganze Anzahl, höchstens so gross wie der Rest des Puffers × `per`.
    fn count(&mut self, per: usize) -> Option<usize> {
        let v = self.f()?;
        if !(v >= 0.0) || v.fract() != 0.0 {
            return None;
        }
        let n = v as usize;
        if n.checked_mul(per)? > self.buf.len() - self.pos {
            return None;
        }
        Some(n)
    }
    fn idx(&mut self) -> Option<i32> {
        let v = self.f()?;
        if v.fract() != 0.0 || !(v >= -1.0) || v > i32::MAX as f64 {
            return None;
        }
        Some(v as i32)
    }
    fn flags(&mut self) -> Option<u32> {
        let v = self.f()?;
        if !(v >= 0.0) || v.fract() != 0.0 || v > u32::MAX as f64 {
            return None;
        }
        Some(v as u32)
    }
    fn v2(&mut self) -> Option<V2> {
        Some(V2 { x: self.f()?, y: self.f()? })
    }
    fn list(&mut self) -> Option<Vec<f64>> {
        let n = self.count(1)?;
        let s = self.buf[self.pos..self.pos + n].to_vec();
        self.pos += n;
        Some(s)
    }
    fn pts(&mut self) -> Option<Vec<V2>> {
        let n = self.count(2)?;
        let mut out = Vec::with_capacity(n);
        for _ in 0..n {
            out.push(self.v2()?);
        }
        Some(out)
    }
    fn motif(&mut self) -> Option<Motif> {
        let length = self.f()?;
        Some(Motif { length, points: self.pts()? })
    }
    fn style(flags: u32, opacity: f64) -> Style {
        Style { greyed: flags & FLAG_GREYED != 0, opacity: if flags & FLAG_OPACITY != 0 { Some(opacity) } else { None } }
    }
}

fn opt(flags: u32, bit: u32, v: f64) -> Option<f64> {
    if flags & bit != 0 {
        Some(v)
    } else {
        None
    }
}

/// Einen Schraffur-Eintrag lesen (auch für die Einzel-Bindungen der Schraffur-Fassade).
fn read_hatch(r: &mut Reader) -> Option<HatchEntry> {
    let pattern = Pattern::from_code(r.f()?);
    let kind = HatchKind::from_code(r.f()?);
    let flags = r.flags()?;
    let scale = r.f()?;
    let angle = r.f()?;
    let color = r.idx()?;
    let line_weight = r.f()?;
    let origin = r.v2()?;
    let seed = r.f()?;
    let density = r.f()?;
    let length_min = r.f()?;
    let length_max = r.f()?;
    let dash = r.list()?;
    let motif = if flags & HF_MOTIF != 0 { Some(r.motif()?) } else { None };
    Some(HatchEntry {
        hatch: Hatch {
            pattern,
            kind,
            random: flags & HF_RANDOM != 0,
            scale,
            angle,
            line_weight,
            origin: if flags & HF_ORIGIN != 0 { Some(origin) } else { None },
            seed: opt(flags, HF_SEED, seed),
            density: opt(flags, HF_DENSITY, density),
            length_min: opt(flags, HF_LEN_MIN, length_min),
            length_max: opt(flags, HF_LEN_MAX, length_max),
            dash,
            motif,
        },
        color,
    })
}

/// Einzelne Schraffur (Format wie ein Hatch-Eintrag des Plan-Puffers) ab `buf[0]`.
pub fn decode_hatch(buf: &[f64]) -> Option<(Hatch, usize)> {
    let mut r = Reader { buf, pos: 0 };
    let h = read_hatch(&mut r)?;
    Some((h.hatch, r.pos))
}

fn read_prim(r: &mut Reader) -> Option<Prim> {
    let tag = r.f()?;
    if tag == 0.0 {
        return Some(Prim::Placeholder);
    }
    let flags = r.flags()?;
    Some(match tag as i64 {
        1 => {
            let fill = r.idx()?;
            let stroke = r.idx()?;
            let stroke_width_mm = r.f()?;
            let hatch = r.idx()?;
            let opacity = r.f()?;
            let pts = r.pts()?;
            let no_stroke_edges = r.list()?;
            Prim::Polygon { style: Reader::style(flags, opacity), fill, stroke, stroke_width_mm, hatch, pts, no_stroke_edges }
        }
        2 => {
            let color = r.idx()?;
            let weight_mm = r.f()?;
            let opacity = r.f()?;
            let a = r.v2()?;
            let b = r.v2()?;
            let dash = r.list()?;
            let zigzag = if flags & FLAG_ZIGZAG != 0 { Some((r.f()?, r.f()?)) } else { None };
            let motif = if flags & FLAG_MOTIF != 0 { Some(r.motif()?) } else { None };
            Prim::Line { style: Reader::style(flags, opacity), color, weight_mm, a, b, dash, chain: flags & FLAG_CHAIN != 0, zigzag, motif }
        }
        3 => {
            let color = r.idx()?;
            let weight_mm = r.f()?;
            let opacity = r.f()?;
            let center = r.v2()?;
            let from = r.v2()?;
            let to = r.v2()?;
            let rad = r.f()?;
            let dash = r.list()?;
            Prim::Arc { style: Reader::style(flags, opacity), color, weight_mm, center, from, to, r: rad, dash }
        }
        4 => {
            let fill = r.idx()?;
            let stroke = r.idx()?;
            let weight_mm = r.f()?;
            let opacity = r.f()?;
            let center = r.v2()?;
            let rad = r.f()?;
            let dash = r.list()?;
            Prim::Circle { style: Reader::style(flags, opacity), fill, stroke, weight_mm, center, r: rad, dash }
        }
        5 => {
            let stroke = r.idx()?;
            let weight_mm = r.f()?;
            let opacity = r.f()?;
            let center = r.v2()?;
            let rad = r.f()?;
            let a0 = r.f()?;
            let a1 = r.f()?;
            let dash = r.list()?;
            Prim::DrawingArc { style: Reader::style(flags, opacity), stroke, weight_mm, center, r: rad, a0, a1, dash }
        }
        _ => return None,
    })
}

/// Puffer lesen; `None` bei fremder Magie/Version oder kaputtem Puffer (nie ein Panic).
pub fn decode(buf: &[f64]) -> Option<PlanBuf> {
    let mut r = Reader { buf, pos: 0 };
    if r.f()? != MAGIC || r.f()? != VERSION {
        return None;
    }
    let n_colors = r.count(4)?;
    let n_hatches = r.count(1)?;
    let n_prims = r.count(1)?;
    let mut colors = Vec::with_capacity(n_colors);
    for _ in 0..n_colors {
        colors.push([r.f()?, r.f()?, r.f()?, r.f()?]);
    }
    let mut hatches = Vec::with_capacity(n_hatches);
    for _ in 0..n_hatches {
        hatches.push(read_hatch(&mut r)?);
    }
    let mut prims = Vec::with_capacity(n_prims);
    for _ in 0..n_prims {
        prims.push(read_prim(&mut r)?);
    }
    if r.pos != buf.len() {
        return None;
    }
    Some(PlanBuf { colors, hatches, prims })
}

// ── Schreiben (Rust-Erzeuger ab [K3a]; heute für Hin-und-zurück-Tests) ──────

fn put_list(out: &mut Vec<f64>, l: &[f64]) {
    out.push(l.len() as f64);
    out.extend_from_slice(l);
}

fn put_pts(out: &mut Vec<f64>, pts: &[V2]) {
    out.push(pts.len() as f64);
    for p in pts {
        out.push(p.x);
        out.push(p.y);
    }
}

fn style_flags(s: &Style) -> u32 {
    (if s.greyed { FLAG_GREYED } else { 0 }) | (if s.opacity.is_some() { FLAG_OPACITY } else { 0 })
}

fn write_hatch(out: &mut Vec<f64>, e: &HatchEntry) {
    let h = &e.hatch;
    let mut flags = 0;
    if h.random {
        flags |= HF_RANDOM;
    }
    if h.origin.is_some() {
        flags |= HF_ORIGIN;
    }
    if h.seed.is_some() {
        flags |= HF_SEED;
    }
    if h.density.is_some() {
        flags |= HF_DENSITY;
    }
    if h.length_min.is_some() {
        flags |= HF_LEN_MIN;
    }
    if h.length_max.is_some() {
        flags |= HF_LEN_MAX;
    }
    if h.motif.is_some() {
        flags |= HF_MOTIF;
    }
    let o = h.origin.unwrap_or(V2 { x: 0.0, y: 0.0 });
    out.extend_from_slice(&[
        h.pattern as u8 as f64,
        h.kind as u8 as f64,
        flags as f64,
        h.scale,
        h.angle,
        e.color as f64,
        h.line_weight,
        o.x,
        o.y,
        h.seed.unwrap_or(0.0),
        h.density.unwrap_or(0.0),
        h.length_min.unwrap_or(0.0),
        h.length_max.unwrap_or(0.0),
    ]);
    put_list(out, &h.dash);
    if let Some(m) = &h.motif {
        out.push(m.length);
        put_pts(out, &m.points);
    }
}

pub fn encode(p: &PlanBuf) -> Vec<f64> {
    let mut out = vec![MAGIC, VERSION, p.colors.len() as f64, p.hatches.len() as f64, p.prims.len() as f64];
    for c in &p.colors {
        out.extend_from_slice(c);
    }
    for h in &p.hatches {
        write_hatch(&mut out, h);
    }
    for prim in &p.prims {
        match prim {
            Prim::Placeholder => out.push(0.0),
            Prim::Polygon { style, fill, stroke, stroke_width_mm, hatch, pts, no_stroke_edges } => {
                out.extend_from_slice(&[
                    1.0,
                    style_flags(style) as f64,
                    *fill as f64,
                    *stroke as f64,
                    *stroke_width_mm,
                    *hatch as f64,
                    style.opacity.unwrap_or(1.0),
                ]);
                put_pts(&mut out, pts);
                put_list(&mut out, no_stroke_edges);
            }
            Prim::Line { style, color, weight_mm, a, b, dash, chain, zigzag, motif } => {
                let mut flags = style_flags(style);
                if *chain {
                    flags |= FLAG_CHAIN;
                }
                if zigzag.is_some() {
                    flags |= FLAG_ZIGZAG;
                }
                if motif.is_some() {
                    flags |= FLAG_MOTIF;
                }
                out.extend_from_slice(&[2.0, flags as f64, *color as f64, *weight_mm, style.opacity.unwrap_or(1.0), a.x, a.y, b.x, b.y]);
                put_list(&mut out, dash);
                if let Some((amp, wav)) = zigzag {
                    out.push(*amp);
                    out.push(*wav);
                }
                if let Some(m) = motif {
                    out.push(m.length);
                    put_pts(&mut out, &m.points);
                }
            }
            Prim::Arc { style, color, weight_mm, center, from, to, r, dash } => {
                out.extend_from_slice(&[
                    3.0,
                    style_flags(style) as f64,
                    *color as f64,
                    *weight_mm,
                    style.opacity.unwrap_or(1.0),
                    center.x,
                    center.y,
                    from.x,
                    from.y,
                    to.x,
                    to.y,
                    *r,
                ]);
                put_list(&mut out, dash);
            }
            Prim::Circle { style, fill, stroke, weight_mm, center, r, dash } => {
                out.extend_from_slice(&[
                    4.0,
                    style_flags(style) as f64,
                    *fill as f64,
                    *stroke as f64,
                    *weight_mm,
                    style.opacity.unwrap_or(1.0),
                    center.x,
                    center.y,
                    *r,
                ]);
                put_list(&mut out, dash);
            }
            Prim::DrawingArc { style, stroke, weight_mm, center, r, a0, a1, dash } => {
                out.extend_from_slice(&[
                    5.0,
                    style_flags(style) as f64,
                    *stroke as f64,
                    *weight_mm,
                    style.opacity.unwrap_or(1.0),
                    center.x,
                    center.y,
                    *r,
                    *a0,
                    *a1,
                ]);
                put_list(&mut out, dash);
            }
        }
    }
    out
}

/// Lesen und neu schreiben (Hin-und-zurück-Prüfung der TS-Kodierung); leer bei kaputtem Puffer.
pub fn recode(buf: &[f64]) -> Vec<f64> {
    decode(buf).map(|p| encode(&p)).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hatch::v2;

    fn style() -> Style {
        Style { greyed: true, opacity: Some(0.5) }
    }

    fn sample() -> PlanBuf {
        PlanBuf {
            colors: vec![[0.1, 0.2, 0.3, 1.0], [1.0, 1.0, 1.0, 0.25]],
            hatches: vec![
                HatchEntry {
                    hatch: Hatch {
                        pattern: Pattern::Custom,
                        kind: HatchKind::Vector,
                        random: true,
                        scale: 2.0,
                        angle: 30.0,
                        line_weight: 0.13,
                        origin: Some(v2(1.0, 2.0)),
                        seed: Some(7.0),
                        density: Some(1.5),
                        length_min: Some(0.5),
                        length_max: Some(2.0),
                        dash: vec![1.0, 0.5],
                        motif: Some(Motif { points: vec![v2(0.0, 0.0), v2(1.0, 1.0)], length: 2.0 }),
                    },
                    color: 0,
                },
                HatchEntry {
                    hatch: Hatch {
                        pattern: Pattern::Insulation,
                        kind: HatchKind::Gradient,
                        random: false,
                        scale: 1.0,
                        angle: 0.0,
                        line_weight: 0.0,
                        origin: None,
                        seed: None,
                        density: None,
                        length_min: None,
                        length_max: None,
                        dash: vec![],
                        motif: None,
                    },
                    color: -1,
                },
            ],
            prims: vec![
                Prim::Placeholder,
                Prim::Polygon {
                    style: style(),
                    fill: 1,
                    stroke: 0,
                    stroke_width_mm: 0.35,
                    hatch: 0,
                    pts: vec![v2(0.0, 0.0), v2(1.0, 0.0), v2(0.0, 1.0)],
                    no_stroke_edges: vec![1.0, 2.0],
                },
                Prim::Line {
                    style: Style { greyed: false, opacity: None },
                    color: -1,
                    weight_mm: f64::NAN,
                    a: v2(0.0, 0.0),
                    b: v2(3.0, 4.0),
                    dash: vec![2.0],
                    chain: true,
                    zigzag: Some((1.0, 4.0)),
                    motif: Some(Motif { points: vec![v2(0.0, 0.0), v2(2.0, 1.0)], length: 4.0 }),
                },
                Prim::Arc {
                    style: style(),
                    color: 0,
                    weight_mm: 0.25,
                    center: v2(0.0, 0.0),
                    from: v2(1.0, 0.0),
                    to: v2(0.0, 1.0),
                    r: 1.0,
                    dash: vec![],
                },
                Prim::Circle { style: style(), fill: -1, stroke: 1, weight_mm: 0.18, center: v2(5.0, 5.0), r: 2.0, dash: vec![] },
                Prim::DrawingArc {
                    style: style(),
                    stroke: 0,
                    weight_mm: 0.18,
                    center: v2(5.0, 5.0),
                    r: 2.0,
                    a0: 0.0,
                    a1: 3.0,
                    dash: vec![0.5, 0.5],
                },
            ],
        }
    }

    /// NaN-feste Gleichheit über die Bits der Kodierung.
    fn bits(v: &[f64]) -> Vec<u64> {
        v.iter().map(|x| x.to_bits()).collect()
    }

    #[test]
    fn hin_und_zurueck_je_typ() {
        let p = sample();
        let enc = encode(&p);
        let back = decode(&enc).expect("lesbar");
        assert_eq!(bits(&encode(&back)), bits(&enc));
        assert_eq!(back.prims.len(), 6);
        assert_eq!(back.colors, p.colors);
        assert_eq!(back.hatches, p.hatches);
        // Je Typ einzeln (NaN-Stärke der Linie über die Bits).
        for (i, prim) in p.prims.iter().enumerate() {
            if i == 2 {
                continue;
            }
            assert_eq!(&back.prims[i], prim);
        }
        if let Prim::Line { weight_mm, chain, zigzag, .. } = &back.prims[2] {
            assert!(weight_mm.is_nan());
            assert!(*chain);
            assert_eq!(*zigzag, Some((1.0, 4.0)));
        } else {
            panic!("Linie erwartet");
        }
    }

    #[test]
    fn fremde_version_und_kaputte_puffer() {
        let mut enc = encode(&sample());
        assert!(decode(&enc[..enc.len() - 1]).is_none());
        let mut extra = enc.clone();
        extra.push(0.0);
        assert!(decode(&extra).is_none());
        enc[1] = 2.0;
        assert!(decode(&enc).is_none());
        enc[1] = VERSION;
        enc[0] = 0.0;
        assert!(decode(&enc).is_none());
        assert!(decode(&[]).is_none());
        // Riesige Anzahl ohne Daten: kein Speicher-Absturz.
        assert!(decode(&[MAGIC, VERSION, 1e15, 0.0, 0.0]).is_none());
        assert!(decode(&[MAGIC, VERSION, 0.0, 0.0, 1.0, 9.0, 0.0]).is_none());
        assert!(decode(&[MAGIC, VERSION, 0.0, 0.0, f64::NAN]).is_none());
        assert_eq!(recode(&[1.0, 2.0]), Vec::<f64>::new());
    }
}
