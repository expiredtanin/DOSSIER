//! Plan-Puffer v2 ([K3d]): binäre Übergabe der Plan-Primitive zwischen Kern und Verbrauchern —
//! Gegenstück in TS ist `src/plan/planBuf.ts` (dort dieselbe Formatbeschreibung). Der Kern schreibt
//! ihn direkt aus der Plan-Erzeugung (`planDomains`, [`Writer`]); TS liest ihn zu `Primitive[]`
//! (Auswahl, Overlay, SVG/PDF/DXF) und schreibt ihn für GPU-Chunks aus gemischten Listen. Die
//! GPU-Kompilierung (`gpu_compile.rs`) liest beliebige Bereiche direkt ([`View::gpu`]).
//!
//! Ein Puffer sind Bytes (little-endian): erst ein `f64`-Teil, dann die Text-Einheiten (UTF-16).
//! ```text
//! Kopf (16 × f64)  [MAGIC, VERSION, flags, nStrings, nHatches, nHatchWords, nGroups, nPrims,
//!                   nRecWords, nPool, nUnits, 0, minX, minY, maxX, maxY]
//!                  MAGIC = 0x504C4232 ("PLB2"), VERSION = 2 — fremde Werte → Puffer abgelehnt
//!                  flags 1 = Inhalts-Hashes vorhanden · 2 = Ausmass (minX…maxY) gesetzt
//! Strings     nStrings × [unitOff, unitLen]        (Abschnitt der UTF-16-Einheiten am Ende)
//! Schraffuren nHatchWords Wörter, nHatches Einträge: [jsonStr, Hatch]
//!             jsonStr = die volle `HatchRender` als JSON (TS liest sie einmal je Eintrag);
//!             Hatch   = [pattern, kind, flags, scale, angle, colorStr, lineWeight, originX, originY,
//!                        seed, density, lengthMin, lengthMax, nDash, dash…, (Motiv: length, nPts, x,y…)]
//!             pattern 0 none · 1 solid · 2 diagonal (auch unbekannt) · 3 crosshatch · 4 insulation ·
//!             5 custom; kind 0 vector · 1 image · 2 gradient; flags 1 random · 2 origin · 4 seed ·
//!             8 density · 16 lengthMin · 32 lengthMax · 64 Motiv (Felder ohne Flag stehen auf 0).
//!             Dasselbe Hatch-Format (Farbe −1) nehmen die Einzel-Bindungen der Schraffur ([`decode_hatch`]).
//! Gruppen     nGroups × [start, end)               (Primitiv-Bereiche, bei `planDomains` die Domänen
//!                                                   Decken, Dächer, Räume, Wände, Treppen, Stützen,
//!                                                   Körper, Kontext, Schnittlinien)
//! Offsets     nPrims × Wortindex des Eintrags im Primitiv-Abschnitt (wahlfreier Zugriff)
//! Hashes      nPrims × Inhalts-Hash (52 Bit, nur mit flags & 1) — Schlüssel des GPU-Chunk-Caches
//! Primitive   nRecWords Wörter, je Primitiv ein Eintrag (Reihenfolge = Zeichenreihenfolge)
//! Pool        nPool f64 (Punkte x,y…, Strichmuster, Kantenlisten, Motive, weitere Ids)
//! Einheiten   nUnits × u16 (alle Texte hintereinander, UTF-16 wie JS-Strings)
//! ```
//! Eintrag `[tag, flags, pickKind, pickStr, …]`; danach je Typ (Liste = `off, n` im Pool):
//! ```text
//! 1 polygon   fill, stroke, strokeWidthMm, hatch, opacity, pts(off, nPts) [, noStrokeEdges(off, n)]
//! 2 line      cls, color, weightMm, opacity, ax, ay, bx, by [, dash(off, n)] [, zigzag amp, wav]
//!             [, motif length, pts(off, nPts)]
//! 3 arc       cls, color, weightMm, opacity, cx, cy, fromX, fromY, toX, toY, r [, dash(off, n)]
//! 4 drawingCircle  fill, stroke, weightMm, opacity, cx, cy, r [, dash(off, n)]
//! 5 drawingArc     stroke, weightMm, opacity, cx, cy, r, a0, a1 [, dash(off, n)]
//! 6 text · 7 drawingText · 8 drawingTextPath · 9 drawingImage   jsonStr (das ganze Primitiv als JSON,
//!             „Daten wie heute“; die GPU zeichnet sie nicht)
//! 0 Platzhalter (nur GPU-Puffer aus TS, s. `lean`)
//! zuletzt [, ids(off, n)] mit Flag 1024: weitere Pick-Ids als Paare (kind, str) im Pool
//! ```
//! Flags: 1 greyed gesetzt · 2 greyed = true · 4 opacity gesetzt · 8 setzt den Linienzug der
//! vorigen Linie fort · 16 Zickzack · 32 Motiv · 64 dash = null · 128 dash = Liste · 256
//! noStrokeEdges · 512 Farbe gesetzt (line/arc) · 1024 weitere Ids.
//! Pick-Arten: 0 keine · 1 wall · 2 drawing · 3 ceiling · 4 opening · 5 stair · 6 room ·
//! 7 extrudedSolid · 8 contextObject · 9 column · 10 roof · 11 sectionLine (= `<art>Id`).
//! String-/Schraffur-Index −1 = fehlt. Ohne opacity-Flag steht 1 im Feld. Längen in Metern,
//! Strichstärken/Strichmuster/Zickzack/Motiv in Papier-mm, Bögen von drawingArc im Bogenmass,
//! Schraffur-Winkel in Grad (SVG-Drehsinn). Fehlende Zahlen (TS `undefined`) werden NaN.
//! Flag 8 (Linienzug) setzt der Schreiber: gleiches Element (`drawingId`), gleiche Farbe/Stärke/
//! greyed/opacity, gleiches Strichmuster (TS: dieselbe Referenz; Kern: beide fehlend oder beide
//! null) und Anfang = Ende der vorigen Linie. Der Leser ignoriert es am Anfang eines Bereichs.
//! Unbekannte Zusatzfelder von Zickzack/Motiv (Modell-`extra`) reisen nicht mit.
//! Fehler einer Abfrage: `[ERR_MAGIC, nUnits]` + Meldung als UTF-16 ([`encode_error`]).

use crate::hatch::{Hatch, HatchKind, Motif, Pattern, V2};
use crate::model::{HatchPattern, HatchStyleKind, HatchStyleLines, LineStyleMotif, LineStyleZigzag, Vec2};
use crate::plan::overrides::js_trim;
use crate::plan::prim::{Dash, HatchRender, Primitive};
use std::collections::HashMap;
use std::hash::{BuildHasherDefault, Hasher};

/// Schneller Hasher für die Tabellen des Schreibers (FNV-1a über die Bytes; kein Schutz gegen
/// gezielte Kollisionen nötig).
#[derive(Default)]
struct FnvHasher(u64);

impl Hasher for FnvHasher {
    fn finish(&self) -> u64 {
        self.0
    }
    fn write(&mut self, bytes: &[u8]) {
        let mut h = if self.0 == 0 { FNV_OFFSET } else { self.0 };
        for b in bytes {
            h ^= *b as u64;
            h = h.wrapping_mul(FNV_PRIME);
        }
        self.0 = h;
    }
}

type FastMap<K, V> = HashMap<K, V, BuildHasherDefault<FnvHasher>>;

pub const MAGIC: f64 = 1_347_174_962.0; // 0x504C4232 "PLB2"
pub const VERSION: f64 = 2.0;
/// Fehlerpuffer einer Abfrage ("PLBe").
pub const ERR_MAGIC: f64 = 1_347_175_013.0;
const HEAD: usize = 16;

const HEAD_HASHES: u32 = 1;
const HEAD_BOUNDS: u32 = 2;

pub const F_GREYED_SET: u32 = 1;
pub const F_GREYED: u32 = 2;
pub const F_OPACITY: u32 = 4;
pub const F_CHAIN: u32 = 8;
pub const F_ZIGZAG: u32 = 16;
pub const F_MOTIF: u32 = 32;
pub const F_DASH_NULL: u32 = 64;
pub const F_DASH_LIST: u32 = 128;
pub const F_NSE: u32 = 256;
pub const F_COLOR: u32 = 512;
pub const F_IDS: u32 = 1024;

pub const T_PLACEHOLDER: u32 = 0;
pub const T_POLYGON: u32 = 1;
pub const T_LINE: u32 = 2;
pub const T_ARC: u32 = 3;
pub const T_CIRCLE: u32 = 4;
pub const T_DRAWING_ARC: u32 = 5;
pub const T_TEXT: u32 = 6;
pub const T_DRAWING_TEXT: u32 = 7;
pub const T_TEXT_PATH: u32 = 8;
pub const T_IMAGE: u32 = 9;

const HF_RANDOM: u32 = 1;
const HF_ORIGIN: u32 = 2;
const HF_SEED: u32 = 4;
const HF_DENSITY: u32 = 8;
const HF_LEN_MIN: u32 = 16;
const HF_LEN_MAX: u32 = 32;
const HF_MOTIF: u32 = 64;

// ── GPU-Sicht: was die Kompilierung braucht (Farben geparst, Indizes in `colors`) ──────────────

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
    },
    Circle {
        style: Style,
        fill: i32,
        stroke: i32,
        weight_mm: f64,
        center: V2,
        r: f64,
    },
    DrawingArc {
        style: Style,
        stroke: i32,
        weight_mm: f64,
        center: V2,
        r: f64,
        a0: f64,
        a1: f64,
    },
}

/// Ein Bereich des Puffers in der GPU-Sicht.
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

// ── Farben (früher `parseColor` in TS) ───────────────────────────────────────────────────────────

/// JS `parseInt(s, 16)` (Leerraum, Vorzeichen, `0x`, längster Ziffern-Präfix; NaN ohne Ziffer).
pub(crate) fn js_parse_hex(units: &[u16]) -> f64 {
    let s = String::from_utf16_lossy(units);
    let t = s.trim_start_matches(crate::plan::overrides::js_space);
    let (neg, t) = match t.as_bytes().first() {
        Some(b'-') => (true, &t[1..]),
        Some(b'+') => (false, &t[1..]),
        _ => (false, t),
    };
    let t = if t.len() >= 2 && (t.starts_with("0x") || t.starts_with("0X")) { &t[2..] } else { t };
    let mut v = 0.0;
    let mut any = false;
    for c in t.chars() {
        let Some(d) = c.to_digit(16) else { break };
        v = v * 16.0 + d as f64;
        any = true;
    }
    if !any {
        return f64::NAN;
    }
    if neg {
        -v
    } else {
        v
    }
}

/// JS `parseFloat` auf einer Folge aus Ziffern und Punkten (längster gültiger Präfix).
fn js_parse_float_digits(s: &str) -> f64 {
    let b = s.as_bytes();
    let mut i = 0;
    while i < b.len() && b[i].is_ascii_digit() {
        i += 1;
    }
    let int_end = i;
    if i < b.len() && b[i] == b'.' {
        let mut j = i + 1;
        while j < b.len() && b[j].is_ascii_digit() {
            j += 1;
        }
        if j > i + 1 || int_end > 0 {
            i = j;
        }
    }
    let p = &s[..i];
    if p.is_empty() || p == "." {
        return f64::NAN;
    }
    p.parse::<f64>().unwrap_or(f64::NAN)
}

/// JS `Number(s)` auf einer Folge aus Ziffern und Punkten.
fn js_number_digits(s: &str) -> f64 {
    s.parse::<f64>().unwrap_or(f64::NAN)
}

/// Farbtext → RGBA in [0, 1]; ungültig/"none"/"transparent" → `None`. Bitgleich zur früheren
/// TS-Fassung (`parseColor`): "#rgb", "#rrggbb", "#rrggbbaa", "rgb()/rgba()".
pub fn parse_color(text: &str) -> Option<[f64; 4]> {
    if text.is_empty() {
        return None;
    }
    let s = js_trim(text).to_lowercase();
    if s == "none" || s == "transparent" {
        return None;
    }
    if s.starts_with("rgb") {
        let mut m: Vec<&str> = Vec::new();
        let b = s.as_bytes();
        let mut i = 0;
        while i < b.len() {
            if b[i].is_ascii_digit() || b[i] == b'.' {
                let st = i;
                while i < b.len() && (b[i].is_ascii_digit() || b[i] == b'.') {
                    i += 1;
                }
                m.push(&s[st..i]);
            } else {
                i += 1;
            }
        }
        if m.len() < 3 {
            return None;
        }
        let a = if m.len() >= 4 { js_parse_float_digits(m[3]) } else { 1.0 };
        return Some([js_number_digits(m[0]) / 255.0, js_number_digits(m[1]) / 255.0, js_number_digits(m[2]) / 255.0, if a > 1.0 { a / 255.0 } else { a }]);
    }
    let u: Vec<u16> = s.encode_utf16().collect();
    let mut h: Vec<u16> = if u.first() == Some(&(b'#' as u16)) { u[1..].to_vec() } else { u };
    if h.len() == 3 {
        h = vec![h[0], h[0], h[1], h[1], h[2], h[2]];
    }
    if h.len() != 6 && h.len() != 8 {
        return None;
    }
    let r = js_parse_hex(&h[0..2]);
    let g = js_parse_hex(&h[2..4]);
    let bl = js_parse_hex(&h[4..6]);
    let a = if h.len() == 8 { js_parse_hex(&h[6..8]) / 255.0 } else { 1.0 };
    if r.is_nan() || g.is_nan() || bl.is_nan() {
        return None;
    }
    Some([r / 255.0, g / 255.0, bl / 255.0, a])
}

// ── Lesen ────────────────────────────────────────────────────────────────────────────────────────

/// Wort-Leser über einem `f64`-Ausschnitt (Bytes, little-endian) — ohne Kopie.
#[derive(Clone, Copy)]
struct Words<'a> {
    bytes: &'a [u8],
}

impl<'a> Words<'a> {
    fn get(&self, i: usize) -> Option<f64> {
        let b = self.bytes.get(i.checked_mul(8)?..i.checked_mul(8)?.checked_add(8)?)?;
        Some(f64::from_le_bytes(b.try_into().ok()?))
    }
}

struct Reader<'a> {
    w: Words<'a>,
    pos: usize,
    end: usize,
}

impl<'a> Reader<'a> {
    fn f(&mut self) -> Option<f64> {
        if self.pos >= self.end {
            return None;
        }
        let v = self.w.get(self.pos)?;
        self.pos += 1;
        Some(v)
    }
    /// Nicht-negative ganze Anzahl, höchstens so gross wie der Rest × `per`.
    fn count(&mut self, per: usize) -> Option<usize> {
        let v = self.f()?;
        let n = whole(v)?;
        if n.checked_mul(per)? > self.end - self.pos {
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
        let mut out = Vec::with_capacity(n);
        for _ in 0..n {
            out.push(self.f()?);
        }
        Some(out)
    }
    fn pts(&mut self) -> Option<Vec<V2>> {
        let n = self.count(2)?;
        let mut out = Vec::with_capacity(n);
        for _ in 0..n {
            out.push(self.v2()?);
        }
        Some(out)
    }
}

/// Nicht-negative ganze Zahl als Index/Anzahl.
pub(crate) fn whole(v: f64) -> Option<usize> {
    if !(v >= 0.0) || v.fract() != 0.0 || v > (u32::MAX as f64) {
        return None;
    }
    Some(v as usize)
}

fn opt(flags: u32, bit: u32, v: f64) -> Option<f64> {
    (flags & bit != 0).then_some(v)
}

/// Einen Hatch-Datensatz lesen; `color` ist der Farb-Eintrag (−1 = keine, sonst String-Index).
fn read_hatch(r: &mut Reader) -> Option<(Hatch, i32)> {
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
    let motif = if flags & HF_MOTIF != 0 {
        let length = r.f()?;
        Some(Motif { length, points: r.pts()? })
    } else {
        None
    };
    Some((
        Hatch {
            pattern,
            kind,
            random: flags & HF_RANDOM != 0,
            scale,
            angle,
            line_weight,
            origin: (flags & HF_ORIGIN != 0).then_some(origin),
            seed: opt(flags, HF_SEED, seed),
            density: opt(flags, HF_DENSITY, density),
            length_min: opt(flags, HF_LEN_MIN, length_min),
            length_max: opt(flags, HF_LEN_MAX, length_max),
            dash,
            motif,
        },
        color,
    ))
}

/// Einzelne Schraffur (Hatch-Format, s. Kopf) ab `buf[0]` — Eingabe der Schraffur-Bindungen.
pub fn decode_hatch(buf: &[f64]) -> Option<(Hatch, usize)> {
    let bytes: Vec<u8> = buf.iter().flat_map(|v| v.to_le_bytes()).collect();
    let mut r = Reader { w: Words { bytes: &bytes }, pos: 0, end: buf.len() };
    let (h, _) = read_hatch(&mut r)?;
    Some((h, r.pos))
}

/// Gelesener Kopf und Abschnitte eines Puffers (ohne Kopie).
pub struct View<'a> {
    w: Words<'a>,
    units: &'a [u8],
    n_strings: usize,
    n_hatches: usize,
    n_groups: usize,
    n_prims: usize,
    n_pool: usize,
    strings_at: usize,
    hatches_at: usize,
    hatches_end: usize,
    groups_at: usize,
    offsets_at: usize,
    hashes_at: Option<usize>,
    recs_at: usize,
    recs_end: usize,
    pool_at: usize,
    bounds: Option<[f64; 4]>,
}

/// Ein Primitiv-Eintrag, roh gelesen (Indizes noch nicht aufgelöst).
pub(crate) struct Rec {
    pub(crate) tag: u32,
    pub(crate) flags: u32,
    pub(crate) pick: (u32, i32),
    /// Feste Felder nach dem Kopf (je Typ, s. Format).
    pub(crate) f: Vec<f64>,
    pub(crate) dash: Option<(usize, usize)>,
    pub(crate) nse: Option<(usize, usize)>,
    pub(crate) zigzag: Option<(f64, f64)>,
    pub(crate) motif: Option<(f64, usize, usize)>,
    pub(crate) ids: Option<(usize, usize)>,
}

fn fixed_len(tag: u32) -> Option<usize> {
    Some(match tag {
        T_PLACEHOLDER => 0,
        T_POLYGON => 7,
        T_LINE => 8,
        T_ARC => 11,
        T_CIRCLE => 7,
        T_DRAWING_ARC => 8,
        T_TEXT | T_DRAWING_TEXT | T_TEXT_PATH | T_IMAGE => 1,
        _ => return None,
    })
}

impl<'a> View<'a> {
    /// Kopf und Abschnittsgrenzen prüfen; `None` bei fremder Magie/Version oder kaputtem Puffer.
    pub fn parse(bytes: &'a [u8]) -> Option<View<'a>> {
        if bytes.len() < HEAD * 8 {
            return None;
        }
        let head = Words { bytes: &bytes[..HEAD * 8] };
        let h = |i: usize| head.get(i).unwrap_or(f64::NAN);
        if h(0) != MAGIC || h(1) != VERSION {
            return None;
        }
        let flags = whole(h(2))? as u32;
        let n_strings = whole(h(3))?;
        let n_hatches = whole(h(4))?;
        let n_hatch_words = whole(h(5))?;
        let n_groups = whole(h(6))?;
        let n_prims = whole(h(7))?;
        let n_rec = whole(h(8))?;
        let n_pool = whole(h(9))?;
        let n_units = whole(h(10))?;
        let hashes = flags & HEAD_HASHES != 0;
        let strings_at = HEAD;
        let hatches_at = strings_at.checked_add(n_strings.checked_mul(2)?)?;
        let groups_at = hatches_at.checked_add(n_hatch_words)?;
        let offsets_at = groups_at.checked_add(n_groups.checked_mul(2)?)?;
        let hashes_end = offsets_at.checked_add(n_prims.checked_mul(if hashes { 2 } else { 1 })?)?;
        let recs_at = hashes_end;
        let pool_at = recs_at.checked_add(n_rec)?;
        let n_f64 = pool_at.checked_add(n_pool)?;
        if bytes.len() != n_f64.checked_mul(8)?.checked_add(n_units.checked_mul(2)?)? {
            return None;
        }
        let bounds = (flags & HEAD_BOUNDS != 0).then(|| [h(12), h(13), h(14), h(15)]);
        Some(View {
            w: Words { bytes: &bytes[..n_f64 * 8] },
            units: &bytes[n_f64 * 8..],
            n_strings,
            n_hatches,
            n_groups,
            n_prims,
            n_pool,
            strings_at,
            hatches_at,
            hatches_end: groups_at,
            groups_at,
            offsets_at,
            hashes_at: hashes.then_some(offsets_at + n_prims),
            recs_at,
            recs_end: pool_at,
            pool_at,
            bounds,
        })
    }

    pub fn len(&self) -> usize {
        self.n_prims
    }

    pub fn is_empty(&self) -> bool {
        self.n_prims == 0
    }

    /// Anzahl Einträge der String-Tabelle.
    pub(crate) fn n_strings(&self) -> usize {
        self.n_strings
    }

    pub fn bounds(&self) -> Option<[f64; 4]> {
        self.bounds
    }

    /// Gruppen `[start, end)`; `None` bei ungültigen Bereichen.
    pub fn groups(&self) -> Option<Vec<(usize, usize)>> {
        let mut out = Vec::with_capacity(self.n_groups);
        for g in 0..self.n_groups {
            let a = whole(self.w.get(self.groups_at + 2 * g)?)?;
            let b = whole(self.w.get(self.groups_at + 2 * g + 1)?)?;
            if a > b || b > self.n_prims {
                return None;
            }
            out.push((a, b));
        }
        Some(out)
    }

    /// Inhalts-Hash des Primitivs `i` (nur, wenn der Schreiber Hashes abgelegt hat).
    pub fn hash(&self, i: usize) -> Option<f64> {
        if i >= self.n_prims {
            return None;
        }
        self.w.get(self.hashes_at? + i)
    }

    fn units_of(&self, idx: usize) -> Option<Vec<u16>> {
        if idx >= self.n_strings {
            return None;
        }
        let off = whole(self.w.get(self.strings_at + 2 * idx)?)?;
        let len = whole(self.w.get(self.strings_at + 2 * idx + 1)?)?;
        let b = self.units.get(off.checked_mul(2)?..off.checked_add(len)?.checked_mul(2)?)?;
        Some(b.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect())
    }

    /// String `idx` (ungültiges UTF-16 wird ersetzt).
    pub fn string(&self, idx: usize) -> Option<String> {
        Some(String::from_utf16_lossy(&self.units_of(idx)?))
    }

    fn opt_string(&self, idx: f64) -> Option<Option<String>> {
        if idx == -1.0 {
            return Some(None);
        }
        Some(Some(self.string(whole(idx)?)?))
    }

    pub(crate) fn pool(&self, off: usize, n: usize) -> Option<Vec<f64>> {
        if off.checked_add(n)? > self.n_pool {
            return None;
        }
        let mut out = Vec::with_capacity(n);
        for k in 0..n {
            out.push(self.w.get(self.pool_at + off + k)?);
        }
        Some(out)
    }

    pub(crate) fn pool_pts(&self, off: usize, n: usize) -> Option<Vec<V2>> {
        let l = self.pool(off, n.checked_mul(2)?)?;
        Some(l.chunks_exact(2).map(|c| V2 { x: c[0], y: c[1] }).collect())
    }

    /// Hatch-Einträge: (JSON-String-Index, Hatch, Farb-String-Index).
    pub(crate) fn hatch_table(&self) -> Option<Vec<(i32, Hatch, i32)>> {
        let mut r = Reader { w: self.w, pos: self.hatches_at, end: self.hatches_end };
        let mut out = Vec::with_capacity(self.n_hatches);
        for _ in 0..self.n_hatches {
            let json = r.idx()?;
            let (h, color) = read_hatch(&mut r)?;
            if json >= self.n_strings as i32 || color >= self.n_strings as i32 {
                return None;
            }
            out.push((json, h, color));
        }
        if r.pos != self.hatches_end {
            return None;
        }
        Some(out)
    }

    pub(crate) fn rec(&self, i: usize) -> Option<Rec> {
        if i >= self.n_prims {
            return None;
        }
        let off = whole(self.w.get(self.offsets_at + i)?)?;
        let mut r = Reader { w: self.w, pos: self.recs_at.checked_add(off)?, end: self.recs_end };
        let tag = whole(r.f()?)? as u32;
        let flags = r.flags()?;
        let pk = whole(r.f()?)? as u32;
        let ps = r.idx()?;
        if pk > 11 || ps >= self.n_strings as i32 {
            return None;
        }
        let n = fixed_len(tag)?;
        let mut f = Vec::with_capacity(n);
        for _ in 0..n {
            f.push(r.f()?);
        }
        let list = |r: &mut Reader| -> Option<(usize, usize)> { Some((whole(r.f()?)?, whole(r.f()?)?)) };
        let mut rec = Rec { tag, flags, pick: (pk, ps), f, dash: None, nse: None, zigzag: None, motif: None, ids: None };
        match tag {
            T_POLYGON => {
                if flags & F_NSE != 0 {
                    rec.nse = Some(list(&mut r)?);
                }
            }
            T_LINE | T_ARC | T_CIRCLE | T_DRAWING_ARC => {
                if flags & F_DASH_LIST != 0 {
                    rec.dash = Some(list(&mut r)?);
                }
                if tag == T_LINE {
                    if flags & F_ZIGZAG != 0 {
                        rec.zigzag = Some((r.f()?, r.f()?));
                    }
                    if flags & F_MOTIF != 0 {
                        let len = r.f()?;
                        let (o, n) = list(&mut r)?;
                        rec.motif = Some((len, o, n));
                    }
                }
            }
            _ => {}
        }
        if flags & F_IDS != 0 {
            rec.ids = Some(list(&mut r)?);
        }
        Some(rec)
    }

    /// Bereich `[from, to)` in der GPU-Sicht (Farben geparst). Flag „Linienzug“ des ersten
    /// Primitivs gilt nicht (er setzt nichts innerhalb des Bereichs fort).
    pub fn gpu(&self, from: usize, to: usize) -> Option<PlanBuf> {
        if from > to || to > self.n_prims {
            return None;
        }
        let mut out = PlanBuf::default();
        let mut color_of: HashMap<i32, i32> = HashMap::new();
        let mut color = |out: &mut PlanBuf, s: f64| -> Option<i32> {
            if s == -1.0 {
                return Some(-1);
            }
            let k = whole(s)? as i32;
            if let Some(&c) = color_of.get(&k) {
                return Some(c);
            }
            let c = match parse_color(&self.string(k as usize)?) {
                Some(rgba) => {
                    out.colors.push(rgba);
                    out.colors.len() as i32 - 1
                }
                None => -1,
            };
            color_of.insert(k, c);
            Some(c)
        };
        // Schraffuren nur lesen, wenn ein Polygon sie braucht.
        let mut hatches: Option<Vec<(i32, Hatch, i32)>> = None;
        let mut hatch_map: HashMap<usize, i32> = HashMap::new();
        for i in from..to {
            let rec = self.rec(i)?;
            let greyed = rec.flags & F_GREYED != 0;
            let f = &rec.f;
            let p = match rec.tag {
                T_POLYGON => {
                    let style = Style { greyed, opacity: opt(rec.flags, F_OPACITY, f[4]) };
                    let fill = color(&mut out, f[0])?;
                    let stroke = color(&mut out, f[1])?;
                    let hatch = if f[3] == -1.0 {
                        -1
                    } else {
                        let k = whole(f[3])?;
                        if let Some(&h) = hatch_map.get(&k) {
                            h
                        } else {
                            if hatches.is_none() {
                                hatches = Some(self.hatch_table()?);
                            }
                            let (_, h, c) = hatches.as_ref()?.get(k)?.clone();
                            let hc = color(&mut out, c as f64)?;
                            out.hatches.push(HatchEntry { hatch: h, color: hc });
                            let idx = out.hatches.len() as i32 - 1;
                            hatch_map.insert(k, idx);
                            idx
                        }
                    };
                    let pts = self.pool_pts(whole(f[5])?, whole(f[6])?)?;
                    let no_stroke_edges = match rec.nse {
                        Some((o, n)) => self.pool(o, n)?,
                        None => Vec::new(),
                    };
                    Prim::Polygon { style, fill, stroke, stroke_width_mm: f[2], hatch, pts, no_stroke_edges }
                }
                T_LINE => {
                    let style = Style { greyed, opacity: opt(rec.flags, F_OPACITY, f[3]) };
                    let c = color(&mut out, f[1])?;
                    let motif = match rec.motif {
                        Some((length, o, n)) => Some(Motif { length, points: self.pool_pts(o, n)? }),
                        None => None,
                    };
                    Prim::Line {
                        style,
                        color: c,
                        weight_mm: f[2],
                        a: V2 { x: f[4], y: f[5] },
                        b: V2 { x: f[6], y: f[7] },
                        chain: i > from && rec.flags & F_CHAIN != 0,
                        zigzag: rec.zigzag,
                        motif,
                    }
                }
                T_ARC => {
                    let style = Style { greyed, opacity: opt(rec.flags, F_OPACITY, f[3]) };
                    let c = color(&mut out, f[1])?;
                    Prim::Arc { style, color: c, weight_mm: f[2], center: V2 { x: f[4], y: f[5] }, from: V2 { x: f[6], y: f[7] }, to: V2 { x: f[8], y: f[9] }, r: f[10] }
                }
                T_CIRCLE => {
                    let style = Style { greyed, opacity: opt(rec.flags, F_OPACITY, f[3]) };
                    let fill = color(&mut out, f[0])?;
                    let stroke = color(&mut out, f[1])?;
                    Prim::Circle { style, fill, stroke, weight_mm: f[2], center: V2 { x: f[4], y: f[5] }, r: f[6] }
                }
                T_DRAWING_ARC => {
                    let style = Style { greyed, opacity: opt(rec.flags, F_OPACITY, f[2]) };
                    let stroke = color(&mut out, f[0])?;
                    Prim::DrawingArc { style, stroke, weight_mm: f[1], center: V2 { x: f[3], y: f[4] }, r: f[5], a0: f[6], a1: f[7] }
                }
                _ => Prim::Placeholder,
            };
            out.prims.push(p);
        }
        Some(out)
    }

    /// Alle Primitive voll gelesen (Hin-und-zurück, künftige Rust-Verbraucher). Platzhalter (tag 0)
    /// haben keinen Inhalt → `None`.
    pub fn prims(&self) -> Option<Vec<Primitive>> {
        let hatches: Vec<HatchRender> = {
            let t = self.hatch_table()?;
            let mut v = Vec::with_capacity(t.len());
            for (json, _, _) in t {
                v.push(serde_json::from_str(&self.string(whole(json as f64)?)?).ok()?);
            }
            v
        };
        let mut out = Vec::with_capacity(self.n_prims);
        for i in 0..self.n_prims {
            out.push(self.prim(i, &hatches)?);
        }
        Some(out)
    }

    fn prim(&self, i: usize, hatches: &[HatchRender]) -> Option<Primitive> {
        let rec = self.rec(i)?;
        let f = &rec.f;
        let fl = rec.flags;
        let greyed = (fl & F_GREYED_SET != 0).then_some(fl & F_GREYED != 0);
        let v = |x: f64, y: f64| Vec2 { x, y };
        let dash: Dash = if fl & F_DASH_NULL != 0 {
            Some(None)
        } else if let Some((o, n)) = rec.dash {
            Some(Some(self.pool(o, n)?))
        } else {
            None
        };
        let to_vec2 = |p: Vec<V2>| p.into_iter().map(|q| Vec2 { x: q.x, y: q.y }).collect::<Vec<_>>();
        // Pick-Ids: erste im Eintrag, weitere im Pool.
        let mut ids: [Option<String>; 12] = Default::default();
        if rec.pick.0 > 0 {
            ids[rec.pick.0 as usize] = Some(self.string(whole(rec.pick.1 as f64)?)?);
        }
        if let Some((o, n)) = rec.ids {
            let l = self.pool(o, n.checked_mul(2)?)?;
            for c in l.chunks_exact(2) {
                let k = whole(c[0])?;
                if k == 0 || k > 11 {
                    return None;
                }
                ids[k] = Some(self.string(whole(c[1])?)?);
            }
        }
        let [_, wall_id, drawing_id, ceiling_id, opening_id, stair_id, room_id, extruded_solid_id, context_object_id, column_id, roof_id, section_line_id] = ids;
        Some(match rec.tag {
            T_POLYGON => Primitive::Polygon {
                pts: to_vec2(self.pool_pts(whole(f[5])?, whole(f[6])?)?),
                fill: self.opt_string(f[0])?.unwrap_or_default(),
                stroke: self.opt_string(f[1])?.unwrap_or_default(),
                stroke_width_mm: f[2],
                hatch: if f[3] == -1.0 { crate::plan::style::no_hatch() } else { hatches.get(whole(f[3])?)?.clone() },
                greyed,
                opacity: opt(fl, F_OPACITY, f[4]),
                no_stroke_edges: match rec.nse {
                    Some((o, n)) => Some(self.pool(o, n)?),
                    None => None,
                },
                wall_id,
                drawing_id,
                ceiling_id,
                opening_id,
                stair_id,
                room_id,
                extruded_solid_id,
                context_object_id,
                column_id,
                roof_id,
                section_line_id,
            },
            T_LINE => Primitive::Line {
                a: v(f[4], f[5]),
                b: v(f[6], f[7]),
                cls: self.opt_string(f[0])?.unwrap_or_default(),
                weight_mm: f[2],
                dash,
                zigzag: rec.zigzag.map(|(amplitude, wavelength)| LineStyleZigzag { amplitude, wavelength, ..Default::default() }),
                motif: match rec.motif {
                    Some((length, o, n)) => Some(LineStyleMotif { points: to_vec2(self.pool_pts(o, n)?), length, ..Default::default() }),
                    None => None,
                },
                color: if fl & F_COLOR != 0 { self.opt_string(f[1])? } else { None },
                drawing_id,
                opening_id,
                stair_id,
                greyed,
                opacity: opt(fl, F_OPACITY, f[3]),
            },
            T_ARC => Primitive::Arc {
                center: v(f[4], f[5]),
                from: v(f[6], f[7]),
                to: v(f[8], f[9]),
                r: f[10],
                cls: self.opt_string(f[0])?.unwrap_or_default(),
                weight_mm: f[2],
                dash,
                opening_id,
                stair_id,
                greyed,
                opacity: opt(fl, F_OPACITY, f[3]),
            },
            T_CIRCLE => Primitive::DrawingCircle {
                center: v(f[4], f[5]),
                r: f[6],
                fill: self.opt_string(f[0])?.unwrap_or_default(),
                stroke: self.opt_string(f[1])?.unwrap_or_default(),
                weight_mm: f[2],
                dash,
                drawing_id,
                greyed,
                opacity: opt(fl, F_OPACITY, f[3]),
            },
            T_DRAWING_ARC => Primitive::DrawingArc {
                center: v(f[3], f[4]),
                r: f[5],
                a0: f[6],
                a1: f[7],
                stroke: self.opt_string(f[0])?.unwrap_or_default(),
                weight_mm: f[1],
                dash,
                drawing_id,
                greyed,
                opacity: opt(fl, F_OPACITY, f[2]),
            },
            T_TEXT | T_DRAWING_TEXT | T_TEXT_PATH | T_IMAGE => serde_json::from_str(&self.string(whole(f[0])?)?).ok()?,
            _ => return None,
        })
    }
}

/// Puffer → Primitive, Gruppen und Ausmass (`None` bei kaputtem Puffer).
pub fn decode(bytes: &[u8]) -> Option<(Vec<Primitive>, Vec<(usize, usize)>, Option<[f64; 4]>)> {
    let v = View::parse(bytes)?;
    Some((v.prims()?, v.groups()?, v.bounds()))
}

/// Lesen und neu schreiben (Hin-und-zurück-Prüfung der TS-Kodierung); leer bei kaputtem Puffer.
pub fn recode(bytes: &[u8]) -> Vec<u8> {
    let Some((prims, groups, bounds)) = decode(bytes) else { return Vec::new() };
    let mut w = Writer::new(false);
    for p in &prims {
        w.push(p);
    }
    for (a, b) in groups {
        w.groups.push((a, b));
    }
    w.bounds = bounds;
    w.finish()
}

// ── Schreiben ────────────────────────────────────────────────────────────────────────────────────

const FNV_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;

/// Mischt ein Wort in den Inhalts-Hash (wortweise statt byteweise: ein Multiplizieren je Zahl; die
/// Güte reicht für Cache-Schlüssel, die der Cache zusätzlich Wort für Wort vergleicht).
#[inline]
fn fnv(h: u64, v: u64) -> u64 {
    let x = (h ^ v).wrapping_mul(0x9E37_79B9_7F4A_7C15);
    x ^ (x >> 29)
}

/// Schlüssel der Linienzug-Prüfung (vorige einfache Linie).
struct ChainKey {
    drawing: Option<usize>,
    color: Option<usize>,
    weight: f64,
    greyed: Option<bool>,
    opacity: Option<f64>,
    /// 0 fehlt, 1 null, 2 Liste (Listen sind im Kern nie „dieselbe Referenz“).
    dash: u8,
    b: Vec2,
}

fn dash_state(d: &Dash) -> u8 {
    match d {
        None => 0,
        Some(None) => 1,
        Some(Some(_)) => 2,
    }
}

/// Schreiber des Plan-Puffers aus Kern-Primitiven.
pub struct Writer {
    units: Vec<u16>,
    strings: Vec<(usize, usize)>,
    str_map: FastMap<String, usize>,
    str_hash: Vec<u64>,
    hatch_words: Vec<f64>,
    hatch_map: FastMap<String, (usize, u64)>,
    /// Schnellweg vor dem JSON-Vergleich: Bit-Schlüssel → (Schraffur, Index, Hash).
    hatch_fast: FastMap<u64, Vec<(HatchRender, usize, u64)>>,
    n_hatches: usize,
    pub groups: Vec<(usize, usize)>,
    offsets: Vec<f64>,
    hashes: Option<Vec<f64>>,
    recs: Vec<f64>,
    pool: Vec<f64>,
    prev: Option<ChainKey>,
    h: u64,
    pub bounds: Option<[f64; 4]>,
}

impl Writer {
    /// `hashes`: Inhalts-Hash je Primitiv ablegen (Schlüssel des GPU-Chunk-Caches).
    pub fn new(hashes: bool) -> Writer {
        Writer {
            units: Vec::new(),
            strings: Vec::new(),
            str_map: FastMap::default(),
            str_hash: Vec::new(),
            hatch_words: Vec::new(),
            hatch_map: FastMap::default(),
            hatch_fast: FastMap::default(),
            n_hatches: 0,
            groups: Vec::new(),
            offsets: Vec::new(),
            hashes: hashes.then(Vec::new),
            recs: Vec::new(),
            pool: Vec::new(),
            prev: None,
            h: FNV_OFFSET,
            bounds: None,
        }
    }

    fn intern(&mut self, s: &str) -> (usize, u64) {
        if let Some(&i) = self.str_map.get(s) {
            return (i, self.str_hash[i]);
        }
        let off = self.units.len();
        let mut h = FNV_OFFSET;
        for u in s.encode_utf16() {
            self.units.push(u);
            h = fnv(h, u as u64);
        }
        let i = self.strings.len();
        self.strings.push((off, self.units.len() - off));
        self.str_hash.push(h);
        self.str_map.insert(s.to_string(), i);
        (i, h)
    }

    #[inline]
    fn num(&mut self, v: f64) {
        self.recs.push(v);
        self.h = fnv(self.h, v.to_bits());
    }

    fn str(&mut self, s: Option<&str>) {
        match s {
            Some(s) => {
                let (i, h) = self.intern(s);
                self.recs.push(i as f64);
                self.h = fnv(self.h, h);
            }
            None => self.num(-1.0),
        }
    }

    /// Liste in den Pool (Hash über den Inhalt, nicht über die Lage).
    fn list(&mut self, l: &[f64]) {
        let off = self.pool.len();
        self.pool.extend_from_slice(l);
        self.recs.push(off as f64);
        self.recs.push(l.len() as f64);
        self.h = fnv(self.h, l.len() as u64);
        for v in l {
            self.h = fnv(self.h, v.to_bits());
        }
    }

    fn pts(&mut self, p: &[Vec2]) {
        let off = self.pool.len();
        for q in p {
            self.pool.push(q.x);
            self.pool.push(q.y);
        }
        self.recs.push(off as f64);
        self.recs.push(p.len() as f64);
        self.h = fnv(self.h, p.len() as u64);
        for q in p {
            self.h = fnv(self.h, q.x.to_bits());
            self.h = fnv(self.h, q.y.to_bits());
        }
    }

    fn hatch(&mut self, h: &HatchRender) -> (usize, u64) {
        // Schnellweg: gleiche Schraffur (Bit für Bit) schon geschrieben? Erspart das JSON je Polygon.
        let simple = h.image.is_none() && h.gradient.is_none() && h.motif.is_none();
        let key = if simple { hatch_bits_key(h) } else { 0 };
        if simple {
            if let Some(c) = self.hatch_fast.get(&key) {
                if let Some(e) = c.iter().find(|e| hatch_bits_eq(&e.0, h)) {
                    return (e.1, e.2);
                }
            }
        }
        let json = serde_json::to_string(h).unwrap_or_default();
        if let Some(&e) = self.hatch_map.get(&json) {
            if simple {
                self.hatch_fast.entry(key).or_default().push((h.clone(), e.0, e.1));
            }
            return e;
        }
        let (js, jh) = self.intern(&json);
        let (cs, _) = self.intern(&h.color);
        let idx = self.n_hatches;
        self.n_hatches += 1;
        self.hatch_words.push(js as f64);
        write_hatch_words(&mut self.hatch_words, h, cs as f64);
        self.hatch_map.insert(json, (idx, jh));
        if simple {
            self.hatch_fast.entry(key).or_default().push((h.clone(), idx, jh));
        }
        (idx, jh)
    }

    fn head(&mut self, tag: u32, flags: u32, ids: &[(u32, &Option<String>)]) -> Vec<(u32, String)> {
        self.offsets.push(self.recs.len() as f64);
        self.h = FNV_OFFSET;
        let mut it = ids.iter().filter_map(|(k, s)| s.as_deref().map(|s| (*k, s)));
        let first = it.next();
        // Weitere Ids (selten) erst hier sammeln.
        let rest: Vec<(u32, String)> = it.map(|(k, s)| (k, s.to_string())).collect();
        self.num(tag as f64);
        self.num((flags | if rest.is_empty() { 0 } else { F_IDS }) as f64);
        match first {
            None => {
                self.num(0.0);
                self.num(-1.0);
            }
            Some((k, s)) => {
                self.num(k as f64);
                self.str(Some(s));
            }
        }
        rest
    }

    fn tail_ids(&mut self, rest: Vec<(u32, String)>) {
        if rest.is_empty() {
            return;
        }
        let mut l = Vec::with_capacity(rest.len() * 2);
        let mut hs = Vec::with_capacity(rest.len());
        for (k, s) in &rest {
            let (i, h) = self.intern(s);
            l.push(*k as f64);
            l.push(i as f64);
            hs.push(h);
        }
        let off = self.pool.len();
        self.pool.extend_from_slice(&l);
        self.recs.push(off as f64);
        self.recs.push(rest.len() as f64);
        for (k, h) in rest.iter().map(|r| r.0).zip(hs) {
            self.h = fnv(self.h, k as u64);
            self.h = fnv(self.h, h);
        }
    }

    fn end_prim(&mut self) {
        if let Some(hs) = self.hashes.as_mut() {
            hs.push((self.h >> 12) as f64);
        }
    }

    fn style_flags(greyed: Option<bool>, opacity: Option<f64>) -> u32 {
        (match greyed {
            Some(true) => F_GREYED_SET | F_GREYED,
            Some(false) => F_GREYED_SET,
            None => 0,
        }) | if opacity.is_some() { F_OPACITY } else { 0 }
    }

    fn dash_flags(d: &Dash) -> u32 {
        match d {
            None => 0,
            Some(None) => F_DASH_NULL,
            Some(Some(_)) => F_DASH_LIST,
        }
    }

    fn dash_tail(&mut self, d: &Dash) {
        if let Some(Some(l)) = d {
            self.list(l);
        }
    }

    fn json(&mut self, tag: u32, p: &Primitive, ids: &[(u32, &Option<String>)]) {
        let rest = self.head(tag, 0, ids);
        let json = serde_json::to_string(p).unwrap_or_default();
        self.str(Some(&json));
        self.tail_ids(rest);
    }

    /// Ein Primitiv anhängen.
    pub fn push(&mut self, p: &Primitive) {
        let mut next_prev: Option<ChainKey> = None;
        match p {
            Primitive::Polygon {
                pts,
                fill,
                stroke,
                stroke_width_mm,
                hatch,
                greyed,
                opacity,
                no_stroke_edges,
                wall_id,
                drawing_id,
                ceiling_id,
                opening_id,
                stair_id,
                room_id,
                extruded_solid_id,
                context_object_id,
                column_id,
                roof_id,
                section_line_id,
            } => {
                let flags = Self::style_flags(*greyed, *opacity) | if no_stroke_edges.is_some() { F_NSE } else { 0 };
                let ids = [
                    (1, wall_id),
                    (2, drawing_id),
                    (3, ceiling_id),
                    (4, opening_id),
                    (5, stair_id),
                    (6, room_id),
                    (7, extruded_solid_id),
                    (8, context_object_id),
                    (9, column_id),
                    (10, roof_id),
                    (11, section_line_id),
                ];
                let rest = self.head(T_POLYGON, flags, &ids);
                self.str(Some(fill));
                self.str(Some(stroke));
                self.num(*stroke_width_mm);
                let (hi, hh) = self.hatch(hatch);
                self.recs.push(hi as f64);
                self.h = fnv(self.h, hh);
                self.num(opacity.unwrap_or(1.0));
                self.pts(pts);
                if let Some(l) = no_stroke_edges {
                    self.list(l);
                }
                self.tail_ids(rest);
            }
            Primitive::Line { a, b, cls, weight_mm, dash, zigzag, motif, color, drawing_id, opening_id, stair_id, greyed, opacity } => {
                let plain = zigzag.is_none() && motif.is_none();
                let di = drawing_id.as_deref().map(|s| self.intern(s).0);
                let ci = color.as_deref().map(|s| self.intern(s).0);
                let chain = plain
                    && self.prev.as_ref().is_some_and(|q| {
                        q.drawing == di
                            && q.color == ci
                            && q.weight == *weight_mm
                            && q.greyed == *greyed
                            && q.opacity == *opacity
                            && q.dash == dash_state(dash)
                            && q.dash != 2
                            && a.x == q.b.x
                            && a.y == q.b.y
                    });
                let flags = Self::style_flags(*greyed, *opacity)
                    | Self::dash_flags(dash)
                    | if chain { F_CHAIN } else { 0 }
                    | if zigzag.is_some() { F_ZIGZAG } else { 0 }
                    | if motif.is_some() { F_MOTIF } else { 0 }
                    | if color.is_some() { F_COLOR } else { 0 };
                let rest = self.head(T_LINE, flags, &[(2, drawing_id), (4, opening_id), (5, stair_id)]);
                self.str(Some(cls));
                self.str(color.as_deref());
                self.num(*weight_mm);
                self.num(opacity.unwrap_or(1.0));
                self.num(a.x);
                self.num(a.y);
                self.num(b.x);
                self.num(b.y);
                self.dash_tail(dash);
                if let Some(z) = zigzag {
                    self.num(z.amplitude);
                    self.num(z.wavelength);
                }
                if let Some(m) = motif {
                    self.num(m.length);
                    self.pts(&m.points);
                }
                self.tail_ids(rest);
                if plain {
                    next_prev = Some(ChainKey { drawing: di, color: ci, weight: *weight_mm, greyed: *greyed, opacity: *opacity, dash: dash_state(dash), b: b.clone() });
                }
            }
            Primitive::Arc { center, from, to, r, cls, weight_mm, dash, opening_id, stair_id, greyed, opacity } => {
                let flags = Self::style_flags(*greyed, *opacity) | Self::dash_flags(dash);
                let rest = self.head(T_ARC, flags, &[(4, opening_id), (5, stair_id)]);
                self.str(Some(cls));
                self.str(None);
                self.num(*weight_mm);
                self.num(opacity.unwrap_or(1.0));
                for v in [center.x, center.y, from.x, from.y, to.x, to.y, *r] {
                    self.num(v);
                }
                self.dash_tail(dash);
                self.tail_ids(rest);
            }
            Primitive::DrawingCircle { center, r, fill, stroke, weight_mm, dash, drawing_id, greyed, opacity } => {
                let flags = Self::style_flags(*greyed, *opacity) | Self::dash_flags(dash);
                let rest = self.head(T_CIRCLE, flags, &[(2, drawing_id)]);
                self.str(Some(fill));
                self.str(Some(stroke));
                self.num(*weight_mm);
                self.num(opacity.unwrap_or(1.0));
                for v in [center.x, center.y, *r] {
                    self.num(v);
                }
                self.dash_tail(dash);
                self.tail_ids(rest);
            }
            Primitive::DrawingArc { center, r, a0, a1, stroke, weight_mm, dash, drawing_id, greyed, opacity } => {
                let flags = Self::style_flags(*greyed, *opacity) | Self::dash_flags(dash);
                let rest = self.head(T_DRAWING_ARC, flags, &[(2, drawing_id)]);
                self.str(Some(stroke));
                self.num(*weight_mm);
                self.num(opacity.unwrap_or(1.0));
                for v in [center.x, center.y, *r, *a0, *a1] {
                    self.num(v);
                }
                self.dash_tail(dash);
                self.tail_ids(rest);
            }
            Primitive::Text { room_id, .. } => self.json(T_TEXT, p, &[(6, room_id)]),
            Primitive::DrawingText { drawing_id, .. } => self.json(T_DRAWING_TEXT, p, &[(2, drawing_id)]),
            Primitive::DrawingTextPath { drawing_id, .. } => self.json(T_TEXT_PATH, p, &[(2, drawing_id)]),
            Primitive::DrawingImage { drawing_id, .. } => self.json(T_IMAGE, p, &[(2, drawing_id)]),
        }
        self.end_prim();
        self.prev = next_prev;
    }

    /// Eine Gruppe (Domäne) anhängen.
    pub fn group(&mut self, prims: &[Primitive]) {
        let start = self.offsets.len();
        for p in prims {
            self.push(p);
        }
        self.groups.push((start, self.offsets.len()));
    }

    pub fn finish(self) -> Vec<u8> {
        let n_prims = self.offsets.len();
        let mut flags = 0;
        if self.hashes.is_some() {
            flags |= HEAD_HASHES;
        }
        let b = self.bounds.unwrap_or([0.0; 4]);
        if self.bounds.is_some() {
            flags |= HEAD_BOUNDS;
        }
        let head = [
            MAGIC,
            VERSION,
            flags as f64,
            self.strings.len() as f64,
            self.n_hatches as f64,
            self.hatch_words.len() as f64,
            self.groups.len() as f64,
            n_prims as f64,
            self.recs.len() as f64,
            self.pool.len() as f64,
            self.units.len() as f64,
            0.0,
            b[0],
            b[1],
            b[2],
            b[3],
        ];
        let n_f64 = HEAD + 2 * self.strings.len() + self.hatch_words.len() + 2 * self.groups.len() + n_prims * if self.hashes.is_some() { 2 } else { 1 } + self.recs.len() + self.pool.len();
        let mut out = Vec::with_capacity(n_f64 * 8 + self.units.len() * 2);
        let mut put = |v: f64| out.extend_from_slice(&v.to_le_bytes());
        for v in head {
            put(v);
        }
        for (o, n) in &self.strings {
            put(*o as f64);
            put(*n as f64);
        }
        for v in &self.hatch_words {
            put(*v);
        }
        for (a, b) in &self.groups {
            put(*a as f64);
            put(*b as f64);
        }
        for v in &self.offsets {
            put(*v);
        }
        if let Some(hs) = &self.hashes {
            for v in hs {
                put(*v);
            }
        }
        for v in &self.recs {
            put(*v);
        }
        for v in &self.pool {
            put(*v);
        }
        for u in &self.units {
            out.extend_from_slice(&u.to_le_bytes());
        }
        out
    }
}

/// Bit-Schlüssel einer Schraffur ohne Bild/Verlauf/Motiv (für den Schnellweg des Schreibers).
fn hatch_bits_key(h: &HatchRender) -> u64 {
    let mut k = FNV_OFFSET;
    for v in [h.scale, h.angle, h.line_weight, h.seed.unwrap_or(f64::NAN), h.density.unwrap_or(f64::NAN), h.length_min.unwrap_or(f64::NAN), h.length_max.unwrap_or(f64::NAN)] {
        k = fnv(k, v.to_bits());
    }
    for b in h.color.bytes() {
        k = fnv(k, b as u64);
    }
    k
}

fn opt_bits_eq(a: Option<f64>, b: Option<f64>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(x), Some(y)) => x.to_bits() == y.to_bits(),
        _ => false,
    }
}

/// Bitgleich (gleiche JSON-Form) — nur für Schraffuren ohne Bild/Verlauf/Motiv.
fn hatch_bits_eq(a: &HatchRender, b: &HatchRender) -> bool {
    let bits = |x: f64, y: f64| x.to_bits() == y.to_bits();
    let vbits = |x: &Option<Vec<f64>>, y: &Option<Vec<f64>>| match (x, y) {
        (None, None) => true,
        (Some(x), Some(y)) => x.len() == y.len() && x.iter().zip(y).all(|(p, q)| p.to_bits() == q.to_bits()),
        _ => false,
    };
    let obits = |x: &Option<Vec2>, y: &Option<Vec2>| match (x, y) {
        (None, None) => true,
        (Some(x), Some(y)) => bits(x.x, y.x) && bits(x.y, y.y),
        _ => false,
    };
    a.pattern == b.pattern
        && bits(a.scale, b.scale)
        && bits(a.angle, b.angle)
        && obits(&a.origin, &b.origin)
        && a.color == b.color
        && bits(a.line_weight, b.line_weight)
        && vbits(&a.dash, &b.dash)
        && a.kind == b.kind
        && a.lines == b.lines
        && a.image.is_none()
        && b.image.is_none()
        && a.gradient.is_none()
        && b.gradient.is_none()
        && a.motif.is_none()
        && b.motif.is_none()
        && opt_bits_eq(a.seed, b.seed)
        && opt_bits_eq(a.density, b.density)
        && opt_bits_eq(a.length_min, b.length_min)
        && opt_bits_eq(a.length_max, b.length_max)
}

/// Hatch-Datensatz aus einer `HatchRender` (Farbe = String-Index).
fn write_hatch_words(out: &mut Vec<f64>, h: &HatchRender, color: f64) {
    let mut flags = 0;
    if h.lines == Some(HatchStyleLines::Random) {
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
    let pattern = match h.pattern {
        HatchPattern::None => 0.0,
        HatchPattern::Solid => 1.0,
        HatchPattern::Crosshatch => 3.0,
        HatchPattern::Insulation => 4.0,
        HatchPattern::Custom => 5.0,
        _ => 2.0,
    };
    let kind = match h.kind {
        Some(HatchStyleKind::Image) => 1.0,
        Some(HatchStyleKind::Gradient) => 2.0,
        _ => 0.0,
    };
    let o = h.origin.clone().unwrap_or(Vec2 { x: 0.0, y: 0.0 });
    out.extend_from_slice(&[
        pattern,
        kind,
        flags as f64,
        h.scale,
        h.angle,
        color,
        h.line_weight,
        o.x,
        o.y,
        h.seed.unwrap_or(0.0),
        h.density.unwrap_or(0.0),
        h.length_min.unwrap_or(0.0),
        h.length_max.unwrap_or(0.0),
    ]);
    let dash = h.dash.as_deref().unwrap_or(&[]);
    out.push(dash.len() as f64);
    out.extend_from_slice(dash);
    if let Some(m) = &h.motif {
        out.push(m.length);
        out.push(m.points.len() as f64);
        for p in &m.points {
            out.push(p.x);
            out.push(p.y);
        }
    }
}

/// Fehlerpuffer einer Abfrage (TS wirft die Meldung).
pub fn encode_error(msg: &str) -> Vec<u8> {
    let units: Vec<u16> = msg.encode_utf16().collect();
    let mut out = Vec::with_capacity(16 + units.len() * 2);
    out.extend_from_slice(&ERR_MAGIC.to_le_bytes());
    out.extend_from_slice(&(units.len() as f64).to_le_bytes());
    for u in units {
        out.extend_from_slice(&u.to_le_bytes());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Marks, RichTextDoc};
    use crate::plan::prim::StampLine;
    use crate::plan::style::no_hatch;

    fn v(x: f64, y: f64) -> Vec2 {
        Vec2 { x, y }
    }

    fn hatch() -> HatchRender {
        HatchRender {
            pattern: HatchPattern::Custom,
            scale: 2.0,
            angle: 30.0,
            origin: Some(v(1.0, 2.0)),
            color: "#123456".into(),
            line_weight: 0.13,
            dash: Some(vec![1.0, 0.5]),
            kind: Some(HatchStyleKind::Vector),
            lines: Some(HatchStyleLines::Random),
            image: None,
            gradient: None,
            seed: Some(7.0),
            density: Some(1.5),
            length_min: Some(0.5),
            length_max: Some(2.0),
            motif: None,
        }
    }

    fn line(ax: f64, bx: f64, dash: Dash) -> Primitive {
        Primitive::Line {
            a: v(ax, 0.0),
            b: v(bx, 0.0),
            cls: "wall".into(),
            weight_mm: 0.18,
            dash,
            zigzag: None,
            motif: None,
            color: Some("#000".into()),
            drawing_id: None,
            opening_id: None,
            stair_id: None,
            greyed: None,
            opacity: None,
        }
    }

    fn sample() -> Vec<Primitive> {
        vec![
            Primitive::Polygon {
                pts: vec![v(0.0, 0.0), v(1.0, 0.0), v(0.0, 1.0)],
                fill: "#fff".into(),
                stroke: "none".into(),
                stroke_width_mm: 0.35,
                hatch: hatch(),
                greyed: Some(true),
                opacity: Some(0.5),
                no_stroke_edges: Some(vec![1.0, 2.0]),
                wall_id: Some("W1".into()),
                drawing_id: None,
                ceiling_id: None,
                opening_id: Some("D1".into()),
                stair_id: None,
                room_id: None,
                extruded_solid_id: None,
                context_object_id: None,
                column_id: None,
                roof_id: None,
                section_line_id: Some("S".into()),
            },
            Primitive::Polygon {
                pts: vec![],
                fill: "#fff".into(),
                stroke: "#000".into(),
                stroke_width_mm: f64::NAN,
                hatch: no_hatch(),
                greyed: Some(false),
                opacity: None,
                no_stroke_edges: None,
                wall_id: None,
                drawing_id: None,
                ceiling_id: Some("C1".into()),
                opening_id: None,
                stair_id: None,
                room_id: None,
                extruded_solid_id: None,
                context_object_id: None,
                column_id: None,
                roof_id: None,
                section_line_id: None,
            },
            line(0.0, 1.0, None),
            line(1.0, 2.0, None),
            line(2.0, 3.0, Some(None)),
            line(3.0, 4.0, Some(Some(vec![0.4, 0.2]))),
            Primitive::Line {
                a: v(0.0, 0.0),
                b: v(3.0, 4.0),
                cls: "c".into(),
                weight_mm: 0.25,
                dash: Some(Some(vec![2.0])),
                zigzag: Some(LineStyleZigzag { amplitude: 1.0, wavelength: 4.0, ..Default::default() }),
                motif: Some(LineStyleMotif { points: vec![v(0.0, 0.0), v(2.0, 1.0)], length: 4.0, ..Default::default() }),
                color: None,
                drawing_id: Some("d".into()),
                opening_id: None,
                stair_id: Some("st".into()),
                greyed: Some(true),
                opacity: Some(0.3),
            },
            Primitive::Arc {
                center: v(0.0, 0.0),
                from: v(1.0, 0.0),
                to: v(0.0, 1.0),
                r: 1.0,
                cls: "door-swing".into(),
                weight_mm: 0.13,
                dash: Some(Some(vec![0.5])),
                opening_id: Some("D1".into()),
                stair_id: None,
                greyed: None,
                opacity: None,
            },
            Primitive::Text {
                at: v(2.0, 2.0),
                doc: RichTextDoc::default(),
                extra_lines: vec![StampLine { text: "17.01 m²".into(), align: Default::default() }],
                base_pt: 10.0,
                color: "#6b7280".into(),
                room_id: Some("R1".into()),
                greyed: None,
                opacity: None,
            },
            Primitive::DrawingText {
                at: v(1.0, 1.0),
                text: "Hallo 𝄞".into(),
                height_m: 0.25,
                angle: 0.5,
                color: "#000".into(),
                marks: Some(Marks::default()),
                wrap_width: None,
                doc: None,
                drawing_id: Some("t".into()),
                greyed: None,
                opacity: Some(0.5),
            },
            Primitive::DrawingTextPath { path_pts: vec![v(0.0, 0.0), v(1.0, 1.0)], text: "Pfad".into(), height_m: 0.2, color: "#f00".into(), drawing_id: None, greyed: Some(true), opacity: None },
            Primitive::DrawingImage { min: v(0.0, 0.0), max: v(1.0, 1.0), src: "data:image/png;base64,AAAA".into(), opacity: 0.8, drawing_id: Some("img".into()), greyed: None },
            Primitive::DrawingCircle { center: v(5.0, 5.0), r: 2.0, fill: "none".into(), stroke: "#0f0".into(), weight_mm: 0.18, dash: Some(None), drawing_id: Some("c".into()), greyed: None, opacity: None },
            Primitive::DrawingArc { center: v(5.0, 5.0), r: 2.0, a0: 0.0, a1: 3.0, stroke: "#0f0".into(), weight_mm: 0.18, dash: Some(Some(vec![0.5, 0.5])), drawing_id: None, greyed: None, opacity: Some(1.0) },
        ]
    }

    fn encode(prims: &[Primitive], hashes: bool) -> Vec<u8> {
        let mut w = Writer::new(hashes);
        w.group(&prims[..2]);
        w.group(&prims[2..]);
        w.bounds = Some([0.0, -1.0, 5.0, 7.0]);
        w.finish()
    }

    /// JSON-Form (NaN wird `null` wie in JS).
    fn json(p: &[Primitive]) -> String {
        serde_json::to_string(p).unwrap()
    }

    #[test]
    fn hin_und_zurueck_je_typ() {
        let p = sample();
        let enc = encode(&p, true);
        let (back, groups, bounds) = decode(&enc).expect("lesbar");
        assert_eq!(json(&back), json(&p));
        assert_eq!(groups, vec![(0, 2), (2, p.len())]);
        assert_eq!(bounds, Some([0.0, -1.0, 5.0, 7.0]));
        // Neu schreiben ergibt dieselben Bytes (ohne Hashes).
        let plain = encode(&p, false);
        assert_eq!(recode(&plain), plain);
        assert_eq!(recode(&enc), plain);
    }

    #[test]
    fn linienzug_flag_nach_js_referenz_semantik() {
        let p = sample();
        let enc = encode(&p, false);
        let v = View::parse(&enc).unwrap();
        let chain = |i: usize| v.rec(i).unwrap().flags & F_CHAIN != 0;
        // 2 → 3: beide ohne Muster → Zug; 3 → 4: fehlend vs. null → nein; 4 → 5: Liste nie.
        assert!(!chain(2));
        assert!(chain(3));
        assert!(!chain(4));
        assert!(!chain(5));
        // GPU-Sicht: am Bereichsanfang gilt das Flag nicht.
        let g = v.gpu(3, 5).unwrap();
        assert!(matches!(g.prims[0], Prim::Line { chain: false, .. }));
        let g = v.gpu(2, 5).unwrap();
        assert!(matches!(g.prims[1], Prim::Line { chain: true, .. }));
    }

    #[test]
    fn gpu_sicht_farben_und_schraffur() {
        let p = sample();
        let enc = encode(&p, false);
        let g = View::parse(&enc).unwrap().gpu(0, p.len()).unwrap();
        let Prim::Polygon { fill, stroke, hatch, style, pts, no_stroke_edges, .. } = &g.prims[0] else { panic!() };
        assert_eq!(g.color(*fill), Some([1.0, 1.0, 1.0, 1.0]));
        assert_eq!(*stroke, -1, "none = keine Farbe");
        assert_eq!(style.opacity, Some(0.5));
        assert!(style.greyed);
        assert_eq!(pts.len(), 3);
        assert_eq!(no_stroke_edges, &vec![1.0, 2.0]);
        let h = &g.hatches[*hatch as usize];
        assert!(h.hatch.random && h.hatch.pattern == Pattern::Custom && h.hatch.dash == vec![1.0, 0.5]);
        assert_eq!(g.color(h.color), Some([0x12 as f64 / 255.0, 0x34 as f64 / 255.0, 0x56 as f64 / 255.0, 1.0]));
        assert!(matches!(g.prims[1], Prim::Polygon { hatch: 1, .. }), "no_hatch wird ein eigener Eintrag");
        assert!(matches!(g.prims[8], Prim::Placeholder));
        assert!(matches!(g.prims[13], Prim::DrawingArc { .. }));
    }

    #[test]
    fn hashes_folgen_dem_inhalt() {
        let p = sample();
        let a = encode(&p, true);
        let mut q = p.clone();
        // Ein weiteres Primitiv vorn verschiebt Indizes/Pool, die Hashes der übrigen bleiben.
        q.insert(0, line(9.0, 10.0, None));
        let mut w = Writer::new(true);
        for x in &q {
            w.push(x);
        }
        let b = w.finish();
        let (va, vb) = (View::parse(&a).unwrap(), View::parse(&b).unwrap());
        for i in 0..p.len() {
            if i == 2 {
                continue; // Linienzug-Flag hängt vom Vorgänger ab
            }
            assert_eq!(va.hash(i), vb.hash(i + 1), "Primitiv {i}");
        }
        assert_ne!(va.hash(0), va.hash(1));
        let h = va.hash(0).unwrap();
        assert!(h >= 0.0 && h < 2f64.powi(52) && h.fract() == 0.0);
    }

    #[test]
    fn kaputte_puffer_werden_abgelehnt() {
        let enc = encode(&sample(), true);
        assert!(View::parse(&enc[..enc.len() - 1]).is_none());
        let mut extra = enc.clone();
        extra.push(0);
        assert!(View::parse(&extra).is_none());
        let mut wrong = enc.clone();
        wrong[8..16].copy_from_slice(&3.0f64.to_le_bytes());
        assert!(View::parse(&wrong).is_none());
        assert!(View::parse(&[]).is_none());
        assert!(View::parse(&encode_error("x")).is_none());
        // Jede einzelne verfälschte Zahl: nie ein Panic.
        for i in 0..enc.len() / 8 {
            for bad in [f64::NAN, -2.0, 1e12, 3.5] {
                let mut b = enc.clone();
                b[i * 8..i * 8 + 8].copy_from_slice(&bad.to_le_bytes());
                if let Some(v) = View::parse(&b) {
                    let _ = v.prims();
                    let _ = v.gpu(0, v.len());
                    let _ = v.groups();
                }
            }
        }
        assert!(recode(&[1, 2, 3]).is_empty());
    }

    #[test]
    fn farben_wie_js() {
        let c = |s: &str| parse_color(s);
        assert_eq!(c("#ff0000"), Some([1.0, 0.0, 0.0, 1.0]));
        assert_eq!(c(" #F00 "), Some([1.0, 0.0, 0.0, 1.0]));
        assert_eq!(c("#00000080"), Some([0.0, 0.0, 0.0, 128.0 / 255.0]));
        assert_eq!(c("rgba(255, 0, 0, 0.5)"), Some([1.0, 0.0, 0.0, 0.5]));
        assert_eq!(c("rgb(255,128,0,128)"), Some([1.0, 128.0 / 255.0, 0.0, 128.0 / 255.0]));
        assert_eq!(c("none"), None);
        assert_eq!(c("transparent"), None);
        assert_eq!(c(""), None);
        assert_eq!(c("#ggg"), None);
        assert_eq!(c("rgb(1,2)"), None);
        // parseInt-Eigenheiten: Präfix, Vorzeichen; Alpha darf NaN sein.
        assert_eq!(c("#1g2h3i"), Some([1.0 / 255.0, 2.0 / 255.0, 3.0 / 255.0, 1.0]));
        assert_eq!(c("-1ffff"), Some([-1.0 / 255.0, 1.0, 1.0, 1.0]));
        assert!(c("#000000zz").unwrap()[3].is_nan());
        let r = c("rgb(1.2.3, 4, 5, 1.5.5)").unwrap();
        assert!(r[0].is_nan());
        assert_eq!(r[3], 1.5 / 255.0);
    }
}
