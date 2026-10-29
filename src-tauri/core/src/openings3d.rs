//! Öffnungen in 3D: Glasscheibe(n)/Türblatt, Rahmen-/Sprossen-Riegel (Zarge/Blendrahmen/Kämpfer/
//! Mittelpfosten/Flügelrahmen + SIA-Symbole), Fensterbänke, Zargen-Umgriff, Schwellenprofil und
//! Rollladen-/Sonnenschutzkasten typisierter Tür-/Fensteröffnungen — das 3D-Pendant zu
//! `generatePlan/openings.ts`. Portiert aus `src/plan/toWalls3d/openings.ts`; dort bleiben das
//! Sammeln aus dem `Project` (Typ-Auflösung, Flügeltabelle, Öffnungs-Intervall/-Höhe) und die
//! Farbzuordnung je Bauteil-Klasse ([`Part`]).
//!
//! Die Wand-Löcher selbst (Laibung, Sturz, Brüstung) schneidet [`crate::wall_bands`] aus den
//! Wandbändern; hier entstehen nur die Einbauteile IN der Öffnung.
//!
//! Jedes Teil ist ein geschlossener Quader (8 Ecken, Topologie `OPENING_BOX_TRIS` in TS) in
//! Modell-Metern (x, y, z = Höhe). Rechnung bitgleich zur früheren TS-Fassung (gleiche
//! Operationsreihenfolge, `Math.hypot`/`Math.round`/`Math.max`/`Math.min` nachgebildet).

use crate::flat_read::Reader;
use crate::joins::{js_hypot, js_round};
use crate::wall_bands::EPS;

/// Halbe Dicke EINER Fensterscheibe (8 mm je Scheibe).
const GLASS_HALF_THICK: f64 = 0.004;
/// Luftraum zwischen zwei Scheiben einer Mehrfachverglasung.
const GLASS_PANE_GAP: f64 = 0.006;
/// Halbe Breite der Symbol-Diagonalen (~5 mm Gesamtbreite).
const SYMBOL_HALF_WIDTH: f64 = 0.0025;
/// Türblatt-Dicke quer zur Wand.
const DOOR_LEAF_THICK: f64 = 0.04;
/// Default-Ansichtsbreite des Rahmenprofils, wenn der Typ keine nennt.
const DEFAULT_FRAME_WIDTH: f64 = 0.06;
/// Default-Rahmentiefe (deckt sich mit `geometry/opening.ts::DEFAULT_FRAME_DEPTH`, 2D = 3D).
const DEFAULT_FRAME_DEPTH: f64 = 0.07;
/// Stegbreite der Kassetten-Füllstäbe.
const PANEL_STILE_WIDTH: f64 = 0.06;
/// Vertiefung der Kassetten-Füllung gegenüber den Stegen (je Seite).
const PANEL_RECESS: f64 = 0.012;
/// Obergrenze für Zählwerte (Flügel, Sprossen, Kassetten, Scheiben) gegen Unsinn-Eingaben.
const MAX_COUNT: f64 = 4096.0;

/// Bauteil-Klasse eines Quaders (TS ordnet die Farbe zu).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Part {
    Glass = 0,
    Frame = 1,
    Shading = 2,
    Sill = 3,
    Symbol = 4,
    DoorLeaf = 5,
    /// Maueranschlag (Wandnase in der Leibung, [94]).
    Rebate = 6,
}

/// Ein Quader: Bauteil-Klasse und 8 Ecken (x, y, z), Ecken-Bits wie `OPENING_BOX_TRIS`.
#[derive(Clone, Debug, PartialEq)]
pub struct BoxMesh {
    pub part: Part,
    pub positions: [f64; 24],
}

/// Rahmen-Querschnitt in der Öffnungsebene (u, h): (from,UK), (to,UK), (from,OK), (to,OK).
pub type Quad = [[f64; 2]; 4];

/// Eckverbindung von Blend- und Flügelrahmen (`FrameCornerJoin`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CornerJoin {
    Vertical,
    Horizontal,
    Mitre,
}

/// Detailgrad (`DetailLevel`); `Other` = unbekannter Wert (weder fein noch mittel, aber Rahmen).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Detail {
    Coarse,
    Medium,
    Fine,
    Other,
}

/// Öffnungsart eines Flügels (`SashDef.opening`); `None` = fehlt/leer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SashOpening {
    None,
    Turn,
    Tilt,
    TurnTilt,
    Fixed,
    Slide,
    Other,
}

/// Art eines Eintrags der Flügeltabelle (`SashDef.kind`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SashKind {
    Sash,
    Post,
    Other,
}

/// Ein Eintrag der Flügeltabelle. `width`/`post_width`: NaN = fehlt.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SashIn {
    pub kind: SashKind,
    /// `autoWidth === false` (feste Breite).
    pub fixed_width: bool,
    pub width: f64,
    pub post_width: f64,
    pub opening: SashOpening,
    pub hinge_left: bool,
}

/// Blatt-Ausführung einer Tür (`DoorType.leafStyle`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LeafStyle {
    Plain,
    Glass,
    Panelled,
}

/// Fensterbank-Wahl (`WindowType.sillBoard`); `Outer` = "aussen" oder fehlt.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SillBoard {
    Outer,
    None,
    Inner,
    Both,
}

/// Tür-spezifische Typwerte (NaN = fehlt).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DoorTypeIn {
    pub threshold: bool,
    pub leaf_count: f64,
    pub leaf_style: LeafStyle,
    pub glazing_ratio: f64,
    /// `(frameKind ?? "zarge") === "zarge"`.
    pub zarge: bool,
    pub panel_cols: f64,
    pub panel_rows: f64,
    /// Türart ([95]): 0 Dreh, 1 Schiebe (vor der Wand), 2 Hebeschiebe, 3 Pendel.
    pub kind: f64,
    /// Schiebetür: Seite des Blatts (+1 = +n, aussen; −1 innen).
    pub slide_side: f64,
    /// Bandseite am Ende (Hebeschiebe: festes Feld dort).
    pub hinge_end: bool,
}

/// Fenster-spezifische Typwerte (NaN = fehlt).
#[derive(Clone, Debug, PartialEq)]
pub struct WindowTypeIn {
    /// `glazingPanesOf(wt)`.
    pub glazing_panes: f64,
    pub mullion_rows: f64,
    pub mullion_cols: f64,
    pub sill_board: SillBoard,
    /// Explizite Flügeltabelle (leer ⇒ gleichmässig aus `default_wing_count`).
    pub sashes: Vec<SashIn>,
    /// `op.wingCount ?? wt.wingCount ?? 1`.
    pub default_wing_count: f64,
    /// `wt.kind` (Öffnungsart der gleichmässigen Flügel).
    pub default_opening: SashOpening,
    /// Rollladenkasten (Breite, Höhe, Tiefe), nur bei `shading.create`.
    pub shading: Option<[f64; 3]>,
    /// Einteilung des Oberlichts (Pfosten/Riegel, [95]); leer ⇒ ein festes Feld.
    pub transom_sashes: Vec<SashIn>,
    /// Kasten im Sturz (verdeckt, kein Quader) statt vorgesetzt.
    pub shading_sturz: bool,
    /// Führungsschienen in der Leibung (Kasten im Sturz, nicht Markise).
    pub shading_rails: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub enum KindIn {
    Door(DoorTypeIn),
    Window(WindowTypeIn),
}

/// Aufgelöster Tür-/Fenstertyp einer Öffnung (gemeinsame Werte, NaN = fehlt).
#[derive(Clone, Debug, PartialEq)]
pub struct TypeIn {
    pub frame_depth: f64,
    pub inset_from_face: f64,
    /// `(insetFace ?? "aussen") === "innen"`.
    pub inset_inner: bool,
    /// `insetFace === "mitte"`: Rahmen symmetrisch um die Wandmitte.
    pub inset_mid: bool,
    /// Maueranschlag je Seite und oben (Meter), NaN/0 = keiner.
    pub rebate_depth: f64,
    pub corner_join: CornerJoin,
    pub frame_width: f64,
    pub transom_height: f64,
    pub kind: KindIn,
    /// Rahmen-Detail ([102]), aus dem Anhang der Kodierung; `None` = bisher.
    pub detail: Option<Box<FrameDetailIn>>,
}

/// Rahmen-Detail einer Öffnung ([102]); Seiten in der Reihenfolge links, rechts, oben, unten,
/// NaN = Vorgabe.
#[derive(Clone, Debug, PartialEq)]
pub struct FrameDetailIn {
    pub sides: [f64; 4],
    pub ext: [f64; 4],
    pub rebate: [f64; 4],
    pub sash_width: f64,
    pub sash_depth: f64,
    pub sash_overlap: f64,
    pub mullion_width: f64,
    pub transom_width: f64,
    pub sill_profile: f64,
    pub shading_profile: f64,
    /// Türzarge mit eigener Zeichnung: Blendrahmen-Ring und Zargen-Umgriff entfallen.
    pub skip_frame: bool,
}

/// Anzahl Zahlen eines Anhang-Eintrags nach (Wand, Öffnung).
pub const DETAIL_LEN: usize = 20;

impl FrameDetailIn {
    fn read(r: &mut Reader) -> Option<FrameDetailIn> {
        let mut v = [0.0; DETAIL_LEN];
        for x in v.iter_mut() {
            *x = r.num()?;
        }
        Some(FrameDetailIn {
            sides: [v[0], v[1], v[2], v[3]],
            ext: [v[4], v[5], v[6], v[7]],
            rebate: [v[8], v[9], v[10], v[11]],
            sash_width: v[12],
            sash_depth: v[13],
            sash_overlap: v[14],
            mullion_width: v[15],
            transom_width: v[16],
            sill_profile: v[17],
            shading_profile: v[18],
            skip_frame: v[19] != 0.0,
        })
    }
}

/// Wert oder Vorgabe (NaN/negativ ⇒ Vorgabe).
fn dv(v: f64, d: f64) -> f64 {
    if v.is_finite() && v >= 0.0 {
        v
    } else {
        d
    }
}

/// Eine Öffnung: Achs-Intervall (ab Wandstart), absolute Höhen, Tür/Fenster, Wanddicke und Typ.
#[derive(Clone, Debug, PartialEq)]
pub struct OpeningIn {
    pub from: f64,
    pub to: f64,
    pub z_bottom: f64,
    pub z_top: f64,
    pub door: bool,
    pub wall_thickness: f64,
    pub ty: Option<TypeIn>,
}

/// Eine Wand mit ihren Öffnungen (in Projekt-Reihenfolge).
#[derive(Clone, Debug, PartialEq)]
pub struct WallIn {
    pub start: [f64; 2],
    pub end: [f64; 2],
    pub openings: Vec<OpeningIn>,
}

/// `Math.max(a, b)` (NaN gewinnt, +0 vor −0).
pub(crate) fn jmax(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a > b {
        a
    } else if b > a {
        b
    } else if a.is_sign_positive() {
        a
    } else {
        b
    }
}

/// `Math.min(a, b)` (NaN gewinnt, −0 vor +0).
pub(crate) fn jmin(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a < b {
        a
    } else if b < a {
        b
    } else if a.is_sign_negative() {
        a
    } else {
        b
    }
}

/// `v ?? d` (fehlend = NaN).
fn or(v: f64, d: f64) -> f64 {
    if v.is_nan() {
        d
    } else {
        v
    }
}

/// Klemmt `v` auf `[lo, hi]` wie `clampRange` (`Math.max(lo, Math.min(hi, v))`).
fn clamp_range(v: f64, lo: f64, hi: f64) -> f64 {
    jmax(lo, jmin(hi, v))
}

/// Wandachse: Start, Richtung u und rechte Normale (uy, −ux) — die Dicken-Achse der Öffnungs-
/// Quader (bewusst NICHT die linke Normale; zusammen mit dem Vorzeichen in
/// [`frame_normal_range`] liegt "aussen" physisch richtig).
#[derive(Clone, Copy)]
struct Axis {
    sx: f64,
    sy: f64,
    ux: f64,
    uy: f64,
    nx: f64,
    ny: f64,
}

impl Axis {
    fn of(start: [f64; 2], end: [f64; 2]) -> Option<Axis> {
        let dx = end[0] - start[0];
        let dy = end[1] - start[1];
        let len = js_hypot(dx, dy);
        if len < 1e-9 {
            return None;
        }
        let ux = dx / len;
        let uy = dy / len;
        Some(Axis { sx: start[0], sy: start[1], ux, uy, nx: uy, ny: -ux })
    }

    fn point(&self, s: f64, t: f64, z: f64, out: &mut [f64; 24], i: usize) {
        out[i * 3] = self.sx + self.ux * s + self.nx * t;
        out[i * 3 + 1] = self.sy + self.uy * s + self.ny * t;
        out[i * 3 + 2] = z;
    }
}

/// Sammelt die Quader einer Wand (Achse fehlt ⇒ nichts).
struct Emitter<'a> {
    axis: Option<Axis>,
    out: &'a mut Vec<BoxMesh>,
}

impl Emitter<'_> {
    /// Achsen-Quader `[from,to] × [z_bottom,z_top] × [n_min,n_max]` (`openingAxisBox`).
    #[allow(clippy::too_many_arguments)]
    fn axis_box(&mut self, from: f64, to: f64, z_bottom: f64, z_top: f64, n_min: f64, n_max: f64, part: Part) {
        if to - from <= EPS || z_top - z_bottom <= EPS || (n_max - n_min).abs() <= EPS {
            return;
        }
        let Some(a) = self.axis else { return };
        let mut p = [0.0; 24];
        for i in 0..8 {
            let s = if i & 1 != 0 { to } else { from };
            let z = if i & 2 != 0 { z_top } else { z_bottom };
            let t = if i & 4 != 0 { n_max } else { n_min };
            a.point(s, t, z, &mut p, i);
        }
        self.out.push(BoxMesh { part, positions: p });
    }

    /// Prisma mit Viereck-Querschnitt `q` in der Öffnungsebene (`openingPlaneQuad`).
    fn plane_quad(&mut self, q: &Quad, n_min: f64, n_max: f64, part: Part) {
        if (n_max - n_min).abs() <= EPS {
            return;
        }
        let Some(a) = self.axis else { return };
        let mut p = [0.0; 24];
        for i in 0..8 {
            let [s, z] = q[i & 3];
            let t = if i & 4 != 0 { n_max } else { n_min };
            a.point(s, t, z, &mut p, i);
        }
        self.out.push(BoxMesh { part, positions: p });
    }

    /// Dünnes Prisma mit schräger Längsachse `(u0,h0)→(u1,h1)` in der Öffnungsebene
    /// (`openingPlaneBox`, SIA-Symbole).
    #[allow(clippy::too_many_arguments)]
    fn plane_box(&mut self, u0: f64, h0: f64, u1: f64, h1: f64, half_width: f64, n_front: f64, n_back: f64, part: Part) {
        let du = u1 - u0;
        let dh = h1 - h0;
        let seg_len = js_hypot(du, dh);
        if seg_len < EPS {
            return;
        }
        let Some(a) = self.axis else { return };
        let pu = -dh / seg_len;
        let ph = du / seg_len;
        let mut p = [0.0; 24];
        for i in 0..8 {
            let ui = if i & 1 != 0 { u1 } else { u0 };
            let hi = if i & 1 != 0 { h1 } else { h0 };
            let s = if i & 2 != 0 { 1.0 } else { -1.0 };
            let t = if i & 4 != 0 { n_front } else { n_back };
            let u = ui + s * half_width * pu;
            let h = hi + s * half_width * ph;
            a.point(u, t, h, &mut p, i);
        }
        self.out.push(BoxMesh { part, positions: p });
    }
}

/// Rahmen-Ring über `[from,to] × [z_b,z_t]` mit Profilbreite `w` ohne überlappende Profile
/// (`frameRingQuads`): `join` bestimmt, welche Glieder an den Ecken durchlaufen.
pub fn frame_ring_quads(from: f64, to: f64, z_b: f64, z_t: f64, w: f64, join: CornerJoin, bottom: bool) -> Vec<Quad> {
    frame_ring_quads_sides(from, to, z_b, z_t, [w, w, w, w], join, bottom)
}

/// Wie [`frame_ring_quads`], Profilbreite je Seite `[links, rechts, oben, unten]` ([102]).
pub fn frame_ring_quads_sides(from: f64, to: f64, z_b: f64, z_t: f64, w: [f64; 4], join: CornerJoin, bottom: bool) -> Vec<Quad> {
    let [wl, wr, wt, wb] = w;
    let bx = |u0: f64, u1: f64, h0: f64, h1: f64| -> Quad { [[u0, h0], [u1, h0], [u0, h1], [u1, h1]] };
    let mut out = Vec::with_capacity(4);
    if to - from <= wl + wr + EPS || z_t - z_b <= (if bottom { wb + wt } else { wt }) + EPS {
        // Zu klein für einen Ring: ein Vollprofil.
        out.push(bx(from, to, z_b, z_t));
        return out;
    }
    let bz = if bottom { z_b + wb } else { z_b };
    match join {
        CornerJoin::Horizontal => {
            out.push(bx(from, to, z_t - wt, z_t));
            if bottom {
                out.push(bx(from, to, z_b, z_b + wb));
            }
            out.push(bx(from, from + wl, bz, z_t - wt));
            out.push(bx(to - wr, to, bz, z_t - wt));
        }
        CornerJoin::Mitre => {
            out.push([[from + wl, z_t - wt], [to - wr, z_t - wt], [from, z_t], [to, z_t]]);
            if bottom {
                out.push([[from, z_b], [to, z_b], [from + wl, z_b + wb], [to - wr, z_b + wb]]);
            }
            out.push([[from, z_b], [from + wl, bz], [from, z_t], [from + wl, z_t - wt]]);
            out.push([[to - wr, bz], [to, z_b], [to - wr, z_t - wt], [to, z_t]]);
        }
        CornerJoin::Vertical => {
            out.push(bx(from, from + wl, z_b, z_t));
            out.push(bx(to - wr, to, z_b, z_t));
            out.push(bx(from + wl, to - wr, z_t - wt, z_t));
            if bottom {
                out.push(bx(from + wl, to - wr, z_b, z_b + wb));
            }
        }
    }
    out
}

/// Aufgelöste Rahmen-/Sprossen-Parameter einer Öffnung (`OpeningFrameParams` in TS).
struct FrameParams<'a> {
    frame_width: f64,
    n_min: f64,
    n_max: f64,
    transom_height: f64,
    has_sill: bool,
    wing_count: f64,
    mullion_rows: f64,
    mullion_cols: f64,
    glazed: bool,
    glazing_panes: f64,
    glazed_fraction: f64,
    sashes: std::borrow::Cow<'a, [SashIn]>,
    transom_sashes: &'a [SashIn],
    half_thickness: f64,
    draw_sill: bool,
    draw_interior_sill: bool,
    zarge_cladding: bool,
    draw_threshold_profile: bool,
    panelled: bool,
    panel_cols: f64,
    panel_rows: f64,
    corner_join: CornerJoin,
    door_kind: f64,
    slide_side: f64,
    hinge_end: bool,
}

/// Rahmentiefe quer zur Wand: `frame_depth` (> EPS) oder Default, auf die Wanddicke geklemmt.
fn across_wall_depth(frame_depth: f64, wall_thickness: f64) -> f64 {
    let depth = if frame_depth > EPS { frame_depth } else { DEFAULT_FRAME_DEPTH };
    jmin(depth, wall_thickness)
}

/// Quer-Versatz `[n_min, n_max]` des Rahmenkörpers: Vorderkante bündig mit der gewählten
/// Wandfläche (minus Schichteinzug), `depth` zur Wandmitte hin, auf die halbe Dicke geklemmt.
fn frame_normal_range(half: f64, depth: f64, inset: f64, inner: bool, mid: bool) -> (f64, f64) {
    let sign = if inner { -1.0 } else { 1.0 };
    let (front, back) = if mid { (depth / 2.0, -depth / 2.0) } else { (sign * (half - inset), sign * (half - inset) - sign * depth) };
    let a = clamp_range(front, -half, half);
    let b = clamp_range(back, -half, half);
    (jmin(a, b), jmax(a, b))
}

fn resolve_frame(o: &OpeningIn) -> Option<FrameParams<'_>> {
    let ty = o.ty.as_ref()?;
    let half = o.wall_thickness / 2.0;
    let depth = across_wall_depth(ty.frame_depth, o.wall_thickness);
    let (n_min, n_max) = frame_normal_range(half, depth, or(ty.inset_from_face, 0.0), ty.inset_inner, ty.inset_mid);
    let frame_width = or(ty.frame_width, DEFAULT_FRAME_WIDTH);
    let transom_height = jmax(0.0, or(ty.transom_height, 0.0));
    Some(match &ty.kind {
        KindIn::Door(d) => FrameParams {
            corner_join: ty.corner_join,
            frame_width,
            n_min,
            n_max,
            transom_height,
            has_sill: d.threshold,
            wing_count: jmax(1.0, js_round(or(d.leaf_count, 1.0))),
            mullion_rows: 1.0,
            mullion_cols: 1.0,
            // Schiebe-/Hebeschiebeflügel zeichnet `door_leaf` selbst (eigene Lage bzw. Glasfelder).
            glazed: d.leaf_style == LeafStyle::Glass && d.kind != 1.0 && d.kind != 2.0,
            glazing_panes: 1.0,
            glazed_fraction: jmax(0.05, jmin(1.0, or(d.glazing_ratio, 1.0))),
            sashes: std::borrow::Cow::Borrowed(&[]),
            transom_sashes: &[],
            half_thickness: half,
            draw_sill: false,
            draw_interior_sill: false,
            zarge_cladding: d.zarge,
            draw_threshold_profile: d.threshold,
            panelled: d.leaf_style == LeafStyle::Panelled,
            panel_cols: jmax(1.0, js_round(or(d.panel_cols, 2.0))),
            panel_rows: jmax(1.0, js_round(or(d.panel_rows, 3.0))),
            door_kind: d.kind,
            slide_side: d.slide_side,
            hinge_end: d.hinge_end,
        },
        KindIn::Window(w) => {
            // Flügeltabelle: explizite gewinnt; sonst gleichmässig aus der effektiven Flügelzahl.
            let sashes: std::borrow::Cow<'_, [SashIn]> = if !w.sashes.is_empty() {
                std::borrow::Cow::Borrowed(&w.sashes)
            } else {
                let n = jmax(1.0, js_round(w.default_wing_count));
                // `Array.from({ length: NaN })` ist leer.
                let n = if n.is_nan() { 0 } else { n.min(MAX_COUNT) as usize };
                std::borrow::Cow::Owned(
                    (0..n)
                        .map(|i| SashIn {
                            kind: SashKind::Sash,
                            fixed_width: false,
                            width: f64::NAN,
                            post_width: f64::NAN,
                            opening: w.default_opening,
                            hinge_left: i % 2 == 0,
                        })
                        .collect(),
                )
            };
            let wings = sashes.iter().filter(|s| s.kind == SashKind::Sash).count() as f64;
            FrameParams {
                corner_join: ty.corner_join,
                frame_width,
                n_min,
                n_max,
                transom_height,
                has_sill: true,
                wing_count: jmax(1.0, wings),
                mullion_rows: jmax(1.0, js_round(or(w.mullion_rows, 1.0))),
                mullion_cols: jmax(1.0, js_round(or(w.mullion_cols, 1.0))),
                glazed: true,
                glazing_panes: w.glazing_panes,
                glazed_fraction: 1.0,
                sashes,
                transom_sashes: &w.transom_sashes,
                half_thickness: half,
                draw_sill: w.sill_board != SillBoard::None && w.sill_board != SillBoard::Inner,
                draw_interior_sill: w.sill_board == SillBoard::Inner || w.sill_board == SillBoard::Both,
                zarge_cladding: false,
                draw_threshold_profile: false,
                panelled: false,
                panel_cols: 1.0,
                panel_rows: 1.0,
                door_kind: 0.0,
                slide_side: 1.0,
                hinge_end: false,
            }
        }
    })
}

/// Maueranschlag: Wandnasen links, rechts und oben in der Zone zwischen der Anschlag-Fläche und
/// der Rahmen-Vorderkante (aussen bzw. bei `insetFace: "innen"` innen; mittig: aussen).
fn rebate_boxes(em: &mut Emitter, o: &OpeningIn, ty: &TypeIn, p: &FrameParams) {
    if let Some(d) = ty.detail.as_deref() {
        rebate_boxes_sides(em, o, ty, p, d);
        return;
    }
    let rd = jmin(or(ty.rebate_depth, 0.0), (o.to - o.from) / 2.0 - 0.01);
    if !(rd > EPS) {
        return;
    }
    let half = p.half_thickness;
    let (n0, n1) = if ty.inset_inner && !ty.inset_mid { (-half, p.n_min) } else { (p.n_max, half) };
    if n1 - n0 <= EPS {
        return;
    }
    em.axis_box(o.from, o.from + rd, o.z_bottom, o.z_top, n0, n1, Part::Rebate);
    em.axis_box(o.to - rd, o.to, o.z_bottom, o.z_top, n0, n1, Part::Rebate);
    em.axis_box(o.from + rd, o.to - rd, o.z_top - rd, o.z_top, n0, n1, Part::Rebate);
}

/// Anschlag je Seite ([102]): links, rechts, oben und (Fenster) unten.
fn rebate_boxes_sides(em: &mut Emitter, o: &OpeningIn, ty: &TypeIn, p: &FrameParams, d: &FrameDetailIn) {
    if !(ty.inset_mid || or(ty.inset_from_face, 0.0) > 1e-4) {
        return;
    }
    let half = p.half_thickness;
    let (n0, n1) = if ty.inset_inner && !ty.inset_mid { (-half, p.n_min) } else { (p.n_max, half) };
    if n1 - n0 <= EPS {
        return;
    }
    let lim = |v: f64, m: f64| jmax(0.0, jmin(dv(v, 0.0), m));
    let wmax = (o.to - o.from) / 2.0 - 0.01;
    let hmax = (o.z_top - o.z_bottom) / 3.0;
    let (rl, rr, rt) = (lim(d.rebate[0], wmax), lim(d.rebate[1], wmax), lim(d.rebate[2], hmax));
    let rb = if o.door { 0.0 } else { lim(d.rebate[3], hmax) };
    em.axis_box(o.from, o.from + rl, o.z_bottom, o.z_top, n0, n1, Part::Rebate);
    em.axis_box(o.to - rr, o.to, o.z_bottom, o.z_top, n0, n1, Part::Rebate);
    em.axis_box(o.from + rl, o.to - rr, o.z_top - rt, o.z_top, n0, n1, Part::Rebate);
    em.axis_box(o.from + rl, o.to - rr, o.z_bottom, o.z_bottom + rb, n0, n1, Part::Rebate);
}

/// Flügeleinteilung auf `[from, to]`: feste Breiten exakt, der Rest gleichmässig.
fn sash_spans(sashes: &[SashIn], from: f64, to: f64) -> Vec<(SashIn, f64, f64)> {
    let width = jmax(0.0, to - from);
    let mut fixed_sum = 0.0;
    let mut auto_count = 0.0;
    let fixed = |s: &SashIn| -> Option<f64> {
        if s.kind == SashKind::Post {
            Some(jmax(0.0, or(s.post_width, 0.06)))
        } else if s.fixed_width {
            Some(jmax(0.0, or(s.width, 0.0)))
        } else {
            None
        }
    };
    for s in sashes {
        match fixed(s) {
            Some(w) => fixed_sum += w,
            None => auto_count += 1.0,
        }
    }
    let auto_w = if auto_count > 0.0 { jmax(0.0, (width - fixed_sum) / auto_count) } else { 0.0 };
    let mut cursor = from;
    sashes
        .iter()
        .map(|s| {
            let w = fixed(s).unwrap_or(auto_w);
            let seg = (*s, cursor, cursor + w);
            cursor += w;
            seg
        })
        .collect()
}

/// Rahmen-/Sprossen-Riegel, Flügelrahmen, SIA-Symbole, Bänke, Schwelle und Zargen-Umgriff einer
/// Öffnung (`frameMeshesForOpening`).
fn frame_meshes(em: &mut Emitter, o: &OpeningIn, p: &FrameParams, detail: Detail) {
    let fine = detail == Detail::Fine;
    let medium = detail == Detail::Medium;
    let sashes_on = fine || medium;
    let detail_bodies = fine || medium;
    let fw = p.frame_width;
    let (from0, to0, zb0, zt0) = (o.from, o.to, o.z_bottom, o.z_top);
    // [102] Rahmen je Seite, Verbreiterungs-/Anschlussprofile, Flügel, Pfosten, Kämpfer.
    let dd = o.ty.as_ref().and_then(|t| t.detail.as_deref());
    let [fl, fr, ft, fb] = dd.map_or([fw; 4], |d| d.sides.map(|v| dv(v, fw)));
    let (rf0, rt0, rb0, rtop0) = dd.map_or((from0, to0, zb0, zt0), |d| (from0 + dv(d.ext[0], 0.0), to0 - dv(d.ext[1], 0.0), zb0 + dv(d.sill_profile, 0.0), zt0 - dv(d.shading_profile, 0.0)));
    let mw = dd.map_or(fw, |d| dv(d.mullion_width, fw));
    let tw = dd.map_or(fw, |d| dv(d.transom_width, fw));
    if dd.is_some() {
        // Profile in der Rahmenlage: Verbreiterung links/rechts (volle Höhe), Bank- und Storenanschluss.
        em.axis_box(from0, rf0, zb0, zt0, p.n_min, p.n_max, Part::Frame);
        em.axis_box(rt0, to0, zb0, zt0, p.n_min, p.n_max, Part::Frame);
        em.axis_box(rf0, rt0, zb0, rb0, p.n_min, p.n_max, Part::Frame);
        em.axis_box(rf0, rt0, rtop0, zt0, p.n_min, p.n_max, Part::Frame);
    }
    if !dd.is_some_and(|d| d.skip_frame) {
        for q in frame_ring_quads_sides(rf0, rt0, rb0, rtop0, [fl, fr, ft, fb], p.corner_join, p.has_sill) {
            em.plane_quad(&q, p.n_min, p.n_max, Part::Frame);
        }
    }
    // Schwellenprofil über die ganze Wanddicke.
    if detail_bodies && p.draw_threshold_profile {
        let strip_h = 0.02;
        em.axis_box(from0 + fw, to0 - fw, zb0, zb0 + strip_h, -p.half_thickness, p.half_thickness, Part::Sill);
    }
    let sash_from = rf0 + fl;
    let sash_to = rt0 - fr;
    let sash_bottom = rb0 + if p.has_sill { fb } else { 0.0 };
    let mut sash_top = rtop0 - ft;
    // Oberlicht-Band (über dem Riegel) für dessen Einteilung.
    let mut transom_band: Option<(f64, f64)> = None;
    if p.transom_height > EPS {
        let split_z = clamp_range(zt0 - p.transom_height, sash_bottom, sash_top);
        em.axis_box(sash_from, sash_to, split_z - tw / 2.0, split_z + tw / 2.0, p.n_min, p.n_max, Part::Frame);
        transom_band = Some((split_z + tw / 2.0, sash_top));
        sash_top = split_z - tw / 2.0;
    }
    // Pfosten im Oberlicht (mittel/fein).
    if let (true, Some((tb, tt))) = (sashes_on, transom_band) {
        for (s, cf, ct) in sash_spans(p.transom_sashes, sash_from, sash_to) {
            if s.kind == SashKind::Post {
                em.axis_box(cf, ct, tb, tt, p.n_min, p.n_max, Part::Frame);
            }
        }
    }
    if fine {
        // Senkrechte Teiler laufen durch, waagrechte Kämpfer-Zeilen dazwischen unterbrochen.
        let mut posts: Vec<f64> = Vec::new();
        let add_posts = |count: f64, posts: &mut Vec<f64>| {
            if count <= 1.0 || sash_to - sash_from <= EPS {
                return;
            }
            let cell = (sash_to - sash_from) / count;
            let mut i = 1.0;
            while i < count.min(MAX_COUNT) {
                let center = sash_from + i * cell;
                if !posts.iter().any(|c| (c - center).abs() < 1e-4) {
                    posts.push(center);
                }
                i += 1.0;
            }
        };
        add_posts(p.wing_count, &mut posts);
        add_posts(p.mullion_cols, &mut posts);
        posts.sort_by(|x, y| x.partial_cmp(y).unwrap_or(std::cmp::Ordering::Equal));
        for &center in &posts {
            em.axis_box(center - mw / 2.0, center + mw / 2.0, sash_bottom, sash_top, p.n_min, p.n_max, Part::Frame);
        }
        if p.mullion_rows > 1.0 && sash_top - sash_bottom > EPS {
            let cell = (sash_top - sash_bottom) / p.mullion_rows;
            let mut i = 1.0;
            while i < p.mullion_rows.min(MAX_COUNT) {
                let center = sash_bottom + i * cell;
                let mut from = sash_from;
                for post in posts.iter().copied().chain(std::iter::once(sash_to + fw / 2.0)) {
                    let to = jmin(sash_to, post - fw / 2.0);
                    if to - from > EPS {
                        em.axis_box(from, to, center - fw / 2.0, center + fw / 2.0, p.n_min, p.n_max, Part::Frame);
                    }
                    from = post + fw / 2.0;
                }
                i += 1.0;
            }
        }
    }
    // Flügelrahmen je öffenbarem Flügel (zurückgesetztes, flacheres Quer-Band) + SIA-Symbole.
    let mut bands: Vec<(&[SashIn], f64, f64)> = vec![(&p.sashes, sash_bottom, sash_top)];
    if let Some((tb, tt)) = transom_band {
        bands.push((p.transom_sashes, tb, tt));
    }
    for (band_sashes, band_bottom, band_top) in bands {
        if sashes_on && !band_sashes.is_empty() && sash_to - sash_from > EPS && band_top - band_bottom > EPS {
            let segs = sash_spans(band_sashes, sash_from, sash_to);
            let sfw = dd.map_or(fw * 0.7, |d| dv(d.sash_width, fw * 0.7));
            let sash_front_n = p.n_max - 0.005;
            let sash_back_n = jmax(p.n_min, p.n_max - dd.map_or(0.055, |d| dv(d.sash_depth, 0.055)));
            let sov = dd.map_or(0.0, |d| dv(d.sash_overlap, 0.0));
            let glass_front_n = p.n_max - 0.02;
            let sym_back_n = glass_front_n;
            let sym_front_n = glass_front_n + 0.003;
            let symbol = |em: &mut Emitter, u0: f64, h0: f64, u1: f64, h1: f64| {
                em.plane_box(u0, h0, u1, h1, SYMBOL_HALF_WIDTH, sym_front_n, sym_back_n, Part::Symbol);
            };
            for (s, cf, ct) in segs {
                if s.kind != SashKind::Sash || s.opening == SashOpening::None || s.opening == SashOpening::Fixed {
                    continue;
                }
                let bz = band_bottom;
                let tz = band_top;
                if ct - cf <= EPS || tz - bz <= EPS {
                    continue;
                }
                for q in frame_ring_quads(cf - sov, ct + sov, bz - sov, tz + sov, sfw + sov, p.corner_join, true) {
                    em.plane_quad(&q, sash_back_n, sash_front_n, Part::Frame);
                }
                if !fine {
                    continue;
                }
                let g_a = cf + sfw;
                let g_b = ct - sfw;
                let gbz = bz + sfw;
                let gtz = tz - sfw;
                if g_b - g_a <= EPS || gtz - gbz <= EPS {
                    continue;
                }
                let kind = s.opening;
                if kind == SashOpening::Turn || kind == SashOpening::TurnTilt {
                    let apex_u = if s.hinge_left { g_a } else { g_b };
                    let apex_h = (gbz + gtz) / 2.0;
                    let far_u = if s.hinge_left { g_b } else { g_a };
                    symbol(em, far_u, gbz, apex_u, apex_h);
                    symbol(em, far_u, gtz, apex_u, apex_h);
                }
                if kind == SashOpening::Tilt || kind == SashOpening::TurnTilt {
                    let apex_u = (g_a + g_b) / 2.0;
                    symbol(em, g_a, gbz, apex_u, gtz);
                    symbol(em, g_b, gbz, apex_u, gtz);
                }
                if kind == SashOpening::Slide {
                    let zc = (gbz + gtz) / 2.0;
                    let tail = if s.hinge_left { g_a } else { g_b };
                    let head = if s.hinge_left { g_b } else { g_a };
                    let barb = (head - tail) * 0.22;
                    symbol(em, tail, zc, head, zc);
                    symbol(em, head - barb, gbz + (gtz - gbz) * 0.32, head, zc);
                    symbol(em, head - barb, gbz + (gtz - gbz) * 0.68, head, zc);
                }
            }
        }
    }
    // Fensterbank aussen (Bank + Tropfkante).
    if detail_bodies && p.draw_sill {
        let (ov, proj, under, bank_h, drip_h, drip_w) = (0.03, 0.04, 0.02, 0.04, 0.02, 0.02);
        let outer_n = p.half_thickness;
        let bank_top = zb0;
        let bank_bottom = bank_top - bank_h;
        em.axis_box(from0 - ov, to0 + ov, bank_bottom, bank_top, outer_n - under, outer_n + proj, Part::Sill);
        em.axis_box(from0 - ov, to0 + ov, bank_bottom - drip_h, bank_bottom, outer_n + proj - drip_w, outer_n + proj, Part::Sill);
    }
    // Innen-Fensterbank (ohne Tropfkante).
    if detail_bodies && p.draw_interior_sill {
        let (ov, proj, under, bank_h) = (0.03, 0.04, 0.02, 0.04);
        let inner_n = -p.half_thickness;
        let bank_top = zb0;
        let bank_bottom = bank_top - bank_h;
        em.axis_box(from0 - ov, to0 + ov, bank_bottom, bank_top, inner_n - proj, inner_n + under, Part::Sill);
    }
    // Tür-Zarge mit Umgriff vor beiden Wandflächen.
    if detail_bodies && p.zarge_cladding && !dd.is_some_and(|d| d.skip_frame) {
        let (proud, ext, cas_w) = (0.013, 0.02, fw);
        for sign in [1.0, -1.0] {
            let face_n = sign * p.half_thickness;
            let n_a = face_n;
            let n_b = face_n + sign * proud;
            em.axis_box(from0 - ext, from0 + cas_w, zb0, zt0 + ext, n_a, n_b, Part::Frame);
            em.axis_box(to0 - cas_w, to0 + ext, zb0, zt0 + ext, n_a, n_b, Part::Frame);
            em.axis_box(from0 - ext, to0 + ext, zt0 - cas_w, zt0 + ext, n_a, n_b, Part::Frame);
        }
    }
}

/// Glasscheibe(n) einer typisierten Öffnung je Z-Band (Hauptfeld, Oberlicht), nahe der
/// Aussenfläche, Mehrfachverglasung mit Luftraum nach innen (`glassPanesForOpening`).
fn glass_panes(em: &mut Emitter, o: &OpeningIn, p: &FrameParams) {
    let fw = p.frame_width;
    let dd = o.ty.as_ref().and_then(|t| t.detail.as_deref());
    let [fl, fr, ft, fb] = dd.map_or([fw; 4], |d| d.sides.map(|v| dv(v, fw)));
    let (e_l, e_r, e_b, e_t) = dd.map_or((0.0, 0.0, 0.0, 0.0), |d| (dv(d.ext[0], 0.0), dv(d.ext[1], 0.0), dv(d.sill_profile, 0.0), dv(d.shading_profile, 0.0)));
    let sash_from = o.from + e_l + fl;
    let sash_to = o.to - e_r - fr;
    let sash_bottom = o.z_bottom + e_b + if p.has_sill { fb } else { 0.0 };
    let sash_top_full = o.z_top - e_t - ft;
    let glass_thick = GLASS_HALF_THICK * 2.0;
    let panes = jmax(1.0, jmin(3.0, js_round(p.glazing_panes)));
    let push = |em: &mut Emitter, z_bottom: f64, z_top: f64| {
        let mut n1 = p.n_max - 0.02;
        let mut k = 0.0;
        while k < panes {
            let n0 = jmax(p.n_min, n1 - glass_thick);
            if n1 - n0 <= EPS {
                break;
            }
            em.axis_box(sash_from, sash_to, z_bottom, z_top, n0, n1, Part::Glass);
            n1 = n0 - GLASS_PANE_GAP;
            if n1 <= p.n_min {
                break;
            }
            k += 1.0;
        }
    };
    let frac = jmax(0.05, jmin(1.0, p.glazed_fraction));
    let glazed_bottom = |b: f64, t: f64| t - frac * (t - b);
    if p.transom_height > EPS {
        let split_z = clamp_range(o.z_top - p.transom_height, sash_bottom, sash_top_full);
        let main_top = split_z - fw / 2.0;
        if p.glazed {
            push(em, glazed_bottom(sash_bottom, main_top), main_top);
        }
        push(em, split_z + fw / 2.0, sash_top_full);
    } else if p.glazed {
        push(em, glazed_bottom(sash_bottom, sash_top_full), sash_top_full);
    }
}

/// Türblatt im Hauptfeld (Vollblatt bzw. blinder Rest unter der Teilverglasung, `doorLeafPanels`).
fn door_leaf(em: &mut Emitter, o: &OpeningIn, p: &FrameParams) {
    let fw = p.frame_width;
    let leaf_from = o.from + fw;
    let leaf_to = o.to - fw;
    let leaf_bottom = o.z_bottom + if p.has_sill { fw } else { 0.0 };
    let mut field_top = o.z_top - fw;
    if p.transom_height > EPS {
        let split_z = clamp_range(o.z_top - p.transom_height, leaf_bottom, field_top);
        field_top = split_z - fw / 2.0;
    }
    if p.door_kind == 2.0 {
        lift_slide_sashes(em, leaf_from, leaf_to, leaf_bottom, field_top, p);
        return;
    }
    let frac = if p.glazed { jmax(0.05, jmin(1.0, p.glazed_fraction)) } else { 0.0 };
    let leaf_top = field_top - frac * (field_top - leaf_bottom);
    if leaf_top - leaf_bottom <= EPS || leaf_to - leaf_from <= EPS {
        return;
    }
    if p.door_kind == 1.0 {
        // Schiebetür vor der Wand: Blatt in Schliessstellung vor der Fläche, beidseitig 5 cm über die Lichte.
        let side = if p.slide_side < 0.0 { -1.0 } else { 1.0 };
        let (a, b) = (side * (p.half_thickness + 0.01), side * (p.half_thickness + 0.01 + DOOR_LEAF_THICK));
        em.axis_box(o.from - 0.05, o.to + 0.05, o.z_bottom, leaf_top, jmin(a, b), jmax(a, b), Part::DoorLeaf);
        return;
    }
    let n1 = p.n_max - 0.02 + DOOR_LEAF_THICK / 2.0;
    let n0 = jmax(p.n_min, n1 - DOOR_LEAF_THICK);
    if p.panelled {
        kassette(em, leaf_from, leaf_to, leaf_bottom, leaf_top, n0, n1, p);
        return;
    }
    em.axis_box(leaf_from, leaf_to, leaf_bottom, leaf_top, n0, n1, Part::DoorLeaf);
}

/// Hebeschiebetür: festes Feld (Bandseite, aussen) und Schiebefeld (innen) auf versetzten Gleisen,
/// je Flügelrahmen + Glas, in der Mitte überlappend.
fn lift_slide_sashes(em: &mut Emitter, from: f64, to: f64, bottom: f64, top: f64, p: &FrameParams) {
    let span = p.n_max - p.n_min;
    if to - from <= EPS || top - bottom <= EPS || span <= EPS {
        return;
    }
    let ts = jmin(0.05, span / 2.5);
    let gap = (span - 2.0 * ts) / 3.0;
    let outer = (p.n_max - gap - ts, p.n_max - gap);
    let inner = (p.n_min + gap, p.n_min + gap + ts);
    let mid = (from + to) / 2.0;
    let ov = 0.03;
    let (fixed, slide) = if p.hinge_end { ((mid - ov, to), (from, mid + ov)) } else { ((from, mid + ov), (mid - ov, to)) };
    let sfw = jmin(p.frame_width, (to - from) / 6.0);
    for ((u0, u1), (n0, n1)) in [(fixed, outer), (slide, inner)] {
        for q in frame_ring_quads(u0, u1, bottom, top, sfw, p.corner_join, true) {
            em.plane_quad(&q, n0, n1, Part::Frame);
        }
        let c = (n0 + n1) / 2.0;
        em.axis_box(u0 + sfw, u1 - sfw, bottom + sfw, top - sfw, c - GLASS_HALF_THICK, c + GLASS_HALF_THICK, Part::Glass);
    }
}

/// Kassettentür-Blatt: Rahmen + Trennstege in voller Blattdicke, Felder dünner und vertieft.
#[allow(clippy::too_many_arguments)]
fn kassette(em: &mut Emitter, leaf_from: f64, leaf_to: f64, leaf_bottom: f64, leaf_top: f64, n0: f64, n1: f64, p: &FrameParams) {
    let push = |em: &mut Emitter, from: f64, to: f64, zb: f64, zt: f64, a: f64, b: f64| {
        em.axis_box(from, to, zb, zt, a, b, Part::DoorLeaf);
    };
    let cols = p.panel_cols;
    let rows = p.panel_rows;
    let sw = jmin(jmin(PANEL_STILE_WIDTH, (leaf_to - leaf_from) / (2.0 * cols)), (leaf_top - leaf_bottom) / (2.0 * rows));
    if sw <= EPS {
        push(em, leaf_from, leaf_to, leaf_bottom, leaf_top, n0, n1);
        return;
    }
    push(em, leaf_from, leaf_to, leaf_bottom, leaf_bottom + sw, n0, n1);
    push(em, leaf_from, leaf_to, leaf_top - sw, leaf_top, n0, n1);
    push(em, leaf_from, leaf_from + sw, leaf_bottom, leaf_top, n0, n1);
    push(em, leaf_to - sw, leaf_to, leaf_bottom, leaf_top, n0, n1);
    let cell_w = (leaf_to - leaf_from) / cols;
    let cell_h = (leaf_top - leaf_bottom) / rows;
    let n_cols = cols.min(MAX_COUNT);
    let n_rows = rows.min(MAX_COUNT);
    let mut c = 1.0;
    while c < n_cols {
        let x = leaf_from + c * cell_w;
        push(em, x - sw / 2.0, x + sw / 2.0, leaf_bottom, leaf_top, n0, n1);
        c += 1.0;
    }
    let mut r = 1.0;
    while r < n_rows {
        let y = leaf_bottom + r * cell_h;
        push(em, leaf_from, leaf_to, y - sw / 2.0, y + sw / 2.0, n0, n1);
        r += 1.0;
    }
    let n0p = n0 + PANEL_RECESS;
    let n1p = jmax(n0p + 0.004, n1 - PANEL_RECESS);
    let mut r = 0.0;
    while r < n_rows {
        let mut c = 0.0;
        while c < n_cols {
            let fx0 = leaf_from + c * cell_w + sw / 2.0;
            let fx1 = leaf_from + (c + 1.0) * cell_w - sw / 2.0;
            let fy0 = leaf_bottom + r * cell_h + sw / 2.0;
            let fy1 = leaf_bottom + (r + 1.0) * cell_h - sw / 2.0;
            if !(fx1 - fx0 <= EPS || fy1 - fy0 <= EPS) {
                push(em, fx0, fx1, fy0, fy1, n0p, n1p);
            }
            c += 1.0;
        }
        r += 1.0;
    }
}

/// Alle Öffnungs-Quader der Wände in der Reihenfolge der früheren TS-Fassung: erst Glas/Blätter
/// aller Wände (`emitOpeningGlass`), dann Rahmen (`emitOpeningFrames`, nicht bei grob), dann
/// Rollladenkästen (`emitOpeningShading`, nicht bei grob).
pub fn opening_meshes(walls: &[WallIn], detail: Detail) -> Vec<BoxMesh> {
    let mut out = Vec::new();
    let open = |o: &OpeningIn| !(o.z_top - o.z_bottom <= EPS);
    for w in walls {
        let mut em = Emitter { axis: Axis::of(w.start, w.end), out: &mut out };
        for o in w.openings.iter().filter(|o| open(o)) {
            let params = resolve_frame(o);
            if !o.door {
                match params {
                    // Kein Typ: Alt-Verhalten (eine Vollscheibe mittig in der Wand).
                    None => em.axis_box(o.from, o.to, o.z_bottom, o.z_top, -GLASS_HALF_THICK, GLASS_HALF_THICK, Part::Glass),
                    Some(p) => glass_panes(&mut em, o, &p),
                }
            } else if let Some(p) = params {
                door_leaf(&mut em, o, &p);
                glass_panes(&mut em, o, &p);
            }
            if let (Some(ty), Some(p)) = (&o.ty, resolve_frame(o)) {
                rebate_boxes(&mut em, o, ty, &p);
            }
        }
    }
    if detail == Detail::Coarse {
        return out;
    }
    for w in walls {
        let mut em = Emitter { axis: Axis::of(w.start, w.end), out: &mut out };
        for o in w.openings.iter().filter(|o| open(o)) {
            if let Some(p) = resolve_frame(o) {
                frame_meshes(&mut em, o, &p, detail);
            }
        }
    }
    for w in walls {
        let mut em = Emitter { axis: Axis::of(w.start, w.end), out: &mut out };
        for o in w.openings.iter().filter(|o| open(o)) {
            let Some(TypeIn { kind: KindIn::Window(wt), .. }) = &o.ty else { continue };
            let Some([bw, bh, bd]) = wt.shading else { continue };
            let Some(p) = resolve_frame(o) else { continue };
            if wt.shading_sturz {
                // Storenkasten im Sturz: verdeckt; sichtbar sind nur die Führungsschienen vor dem Rahmen.
                if wt.shading_rails {
                    let (rail_u, rail_n) = (0.03, 0.04);
                    let (n0, n1) = if o.ty.as_ref().is_some_and(|t| t.inset_inner) { (p.n_min - 0.005 - rail_n, p.n_min - 0.005) } else { (p.n_max + 0.005, p.n_max + 0.005 + rail_n) };
                    // Neben dem Anschlag (Wandnase) in der Leibung.
                    let rd = o.ty.as_ref().map_or(0.0, |t| jmax(0.0, jmin(or(t.rebate_depth, 0.0), (o.to - o.from) / 2.0 - 0.01)));
                    em.axis_box(o.from + rd, o.from + rd + rail_u, o.z_bottom, o.z_top, n0, n1, Part::Shading);
                    em.axis_box(o.to - rd - rail_u, o.to - rd, o.z_bottom, o.z_top, n0, n1, Part::Shading);
                }
                continue;
            }
            let h = jmax(0.0, bh);
            let d = jmax(0.0, bd);
            if h <= EPS || d <= EPS {
                continue;
            }
            let span = if bw > 0.0 { bw } else { o.to - o.from };
            let center = (o.from + o.to) / 2.0;
            let from = center - span / 2.0;
            let to = center + span / 2.0;
            let n_outer = p.n_max;
            em.axis_box(from, to, o.z_top, o.z_top + h, n_outer, n_outer + d, Part::Shading);
        }
    }
    out
}

// ── Flache Kodierung ─────────────────────────────────────────────────────────
//
// Eingabe: `[detail (0 grob, 1 mittel, 2 fein, sonst andere), nWände, Wand…]`
//   Wand = `sx, sy, ex, ey, nÖffnungen, Öffnung…`
//   Öffnung = `from, to, zBottom, zTop, istTür, Wanddicke, typisiert (0/1)[, Typ]`
//   Typ = `frameDepth, insetFromFace, einzugSeite (0 aussen, 1 innen, 2 mitte), Eckstoss (0 vertikal,
//          1 horizontal, 2 Gehrung), frameWidth, transomHeight, Anschlag,` dann
//     Tür: `threshold, leafCount, leafStyle (0 glatt, 1 glas, 2 kassette), glazingRatio, zarge,
//           panelCols, panelRows, Türart (0 Dreh, 1 Schiebe, 2 Hebeschiebe, 3 Pendel), Schiebeseite (±1),
//           BandEnde`
//     Fenster: `glazingPanes, mullionRows, mullionCols, sillBoard (0 aussen/fehlt, 1 keine,
//           2 innen, 3 beide), Rollladen (0/1), Breite, Höhe, Tiefe, imSturz, Schienen, Flügelzahl-Default,
//           Öffnungsart-Default, nFlügel, Flügel…, nOberlicht, Flügel… ([95])`
//     Flügel = `Art (0 Flügel, 1 Pfosten, 2 andere), festeBreite, width, postWidth, Öffnungsart,
//           BandLinks`
//   Öffnungsart: 0 fehlt, 1 dreh, 2 kipp, 3 drehkipp, 4 fest, 5 schiebe, 6 andere. NaN = fehlt.
// Ausgabe: `[nQuader, (Bauteil-Klasse, 24 Koordinaten)…]`. Kaputte Eingabe ⇒ `[0]`.

fn opening_kind(v: f64) -> SashOpening {
    match v as i64 {
        0 if v == 0.0 => SashOpening::None,
        1 => SashOpening::Turn,
        2 => SashOpening::Tilt,
        3 => SashOpening::TurnTilt,
        4 => SashOpening::Fixed,
        5 => SashOpening::Slide,
        _ if v.is_nan() => SashOpening::None,
        _ => SashOpening::Other,
    }
}

fn flag(r: &mut Reader) -> Option<bool> {
    Some(r.num()? != 0.0)
}

fn decode_type(r: &mut Reader, door: bool) -> Option<TypeIn> {
    let frame_depth = r.num()?;
    let inset_from_face = r.num()?;
    let inset_side = r.num()?;
    let (inset_inner, inset_mid) = (inset_side == 1.0, inset_side == 2.0);
    let corner_join = match r.num()? as i64 {
        1 => CornerJoin::Horizontal,
        2 => CornerJoin::Mitre,
        _ => CornerJoin::Vertical,
    };
    let frame_width = r.num()?;
    let transom_height = r.num()?;
    let rebate_depth = r.num()?;
    let kind = if door {
        KindIn::Door(DoorTypeIn {
            threshold: flag(r)?,
            leaf_count: r.num()?,
            leaf_style: match r.num()? as i64 {
                1 => LeafStyle::Glass,
                2 => LeafStyle::Panelled,
                _ => LeafStyle::Plain,
            },
            glazing_ratio: r.num()?,
            zarge: flag(r)?,
            panel_cols: r.num()?,
            panel_rows: r.num()?,
            kind: r.num()?,
            slide_side: r.num()?,
            hinge_end: flag(r)?,
        })
    } else {
        let glazing_panes = r.num()?;
        let mullion_rows = r.num()?;
        let mullion_cols = r.num()?;
        let sill_board = match r.num()? as i64 {
            1 => SillBoard::None,
            2 => SillBoard::Inner,
            3 => SillBoard::Both,
            _ => SillBoard::Outer,
        };
        let create = flag(r)?;
        let shading_box = [r.num()?, r.num()?, r.num()?];
        let shading_sturz = flag(r)?;
        let shading_rails = flag(r)?;
        let default_wing_count = r.num()?;
        let default_opening = opening_kind(r.num()?);
        let sashes = decode_sashes(r)?;
        let transom_sashes = decode_sashes(r)?;
        KindIn::Window(WindowTypeIn {
            glazing_panes,
            mullion_rows,
            mullion_cols,
            sill_board,
            sashes,
            transom_sashes,
            default_wing_count,
            default_opening,
            shading: if create { Some(shading_box) } else { None },
            shading_sturz,
            shading_rails,
        })
    };
    Some(TypeIn { frame_depth, inset_from_face, inset_inner, inset_mid, rebate_depth, corner_join, frame_width, transom_height, kind, detail: None })
}

/// Flügelliste `[n, Flügel × n]`.
fn decode_sashes(r: &mut Reader) -> Option<Vec<SashIn>> {
        let n = r.count()?;
        let mut sashes = Vec::with_capacity(n.min(1024));
        for _ in 0..n {
            sashes.push(SashIn {
                kind: match r.num()? as i64 {
                    0 => SashKind::Sash,
                    1 => SashKind::Post,
                    _ => SashKind::Other,
                },
                fixed_width: flag(r)?,
                width: r.num()?,
                post_width: r.num()?,
                opening: opening_kind(r.num()?),
                hinge_left: flag(r)?,
            });
        }
        Some(sashes)
}

fn decode(buf: &[f64]) -> Option<(Vec<WallIn>, Detail)> {
    let mut r = Reader::new(buf);
    let detail = match r.num()? {
        d if d == 0.0 => Detail::Coarse,
        d if d == 1.0 => Detail::Medium,
        d if d == 2.0 => Detail::Fine,
        _ => Detail::Other,
    };
    let n = r.count()?;
    let mut walls = Vec::with_capacity(n.min(1 << 16));
    // (Wand, Öffnung) im Puffer → Lage in `walls` (für den Anhang [102]).
    let mut slots: Vec<((usize, usize), (usize, usize))> = Vec::new();
    for wi in 0..n {
        let start = [r.num()?, r.num()?];
        let end = [r.num()?, r.num()?];
        let n_ops = r.count()?;
        let mut openings = Vec::with_capacity(n_ops.min(1024));
        for oi in 0..n_ops {
            let (from, to, z_bottom, z_top) = (r.num()?, r.num()?, r.num()?, r.num()?);
            let door = flag(&mut r)?;
            let wall_thickness = r.num()?;
            let ty = if flag(&mut r)? { Some(decode_type(&mut r, door)?) } else { None };
            // Unsinn (NaN/∞ in Lage oder Wanddicke): Öffnung auslassen.
            if [from, to, z_bottom, z_top, wall_thickness].iter().all(|v| v.is_finite()) {
                slots.push(((wi, oi), (walls.len(), openings.len())));
                openings.push(OpeningIn { from, to, z_bottom, z_top, door, wall_thickness, ty });
            }
        }
        if [start[0], start[1], end[0], end[1]].iter().all(|v| v.is_finite()) {
            walls.push(WallIn { start, end, openings });
        } else {
            slots.retain(|s| s.0 .0 != wi);
        }
    }
    // Anhang ([102], optional): `[n, (Wand, Öffnung, Detail × DETAIL_LEN) × n]`.
    if let Some(nd) = r.count() {
        for _ in 0..nd {
            let (wi, oi) = (r.num()?, r.num()?);
            let d = FrameDetailIn::read(&mut r)?;
            let key = (wi as usize, oi as usize);
            if let Some(&(_, (a, b))) = slots.iter().find(|s| s.0 == key) {
                if let Some(ty) = walls.get_mut(a).and_then(|w| w.openings.get_mut(b)).and_then(|o| o.ty.as_mut()) {
                    ty.detail = Some(Box::new(d));
                }
            }
        }
    }
    Some((walls, detail))
}

/// Flache Bindung (Kodierung s. oben); nie ein Panic.
pub fn opening_meshes_flat(buf: &[f64]) -> Vec<f64> {
    let Some((walls, detail)) = decode(buf) else { return vec![0.0] };
    let meshes = opening_meshes(&walls, detail);
    let mut out = Vec::with_capacity(1 + meshes.len() * 25);
    out.push(meshes.len() as f64);
    for m in &meshes {
        out.push(m.part as i32 as f64);
        out.extend_from_slice(&m.positions);
    }
    out
}


#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-9
    }

    fn window_type(sill: SillBoard) -> TypeIn {
        TypeIn {
            frame_depth: f64::NAN,
            inset_from_face: f64::NAN,
            inset_inner: false,
            inset_mid: false,
            rebate_depth: f64::NAN,
            corner_join: CornerJoin::Vertical,
            frame_width: f64::NAN,
            transom_height: f64::NAN,
            kind: KindIn::Window(WindowTypeIn {
                glazing_panes: 1.0,
                mullion_rows: f64::NAN,
                mullion_cols: f64::NAN,
                sill_board: sill,
                sashes: vec![],
                transom_sashes: vec![],
                default_wing_count: 1.0,
                default_opening: SashOpening::TurnTilt,
                shading: None,
                shading_sturz: false,
                shading_rails: false,
            }),
            detail: None,
        }
    }

    fn door_type(style: LeafStyle) -> TypeIn {
        TypeIn {
            frame_depth: f64::NAN,
            inset_from_face: f64::NAN,
            inset_inner: false,
            inset_mid: false,
            rebate_depth: f64::NAN,
            corner_join: CornerJoin::Vertical,
            frame_width: f64::NAN,
            transom_height: f64::NAN,
            kind: KindIn::Door(DoorTypeIn {
                threshold: false,
                leaf_count: 1.0,
                leaf_style: style,
                glazing_ratio: f64::NAN,
                zarge: true,
                panel_cols: f64::NAN,
                panel_rows: f64::NAN,
                kind: 0.0,
                slide_side: 1.0,
                hinge_end: false,
            }),
            detail: None,
        }
    }

    fn wall(op: OpeningIn) -> WallIn {
        WallIn { start: [0.0, 0.0], end: [5.0, 0.0], openings: vec![op] }
    }

    fn op(door: bool, ty: Option<TypeIn>) -> OpeningIn {
        OpeningIn { from: 1.0, to: 2.2, z_bottom: if door { 0.0 } else { 0.9 }, z_top: 2.1, door, wall_thickness: 0.3, ty }
    }

    fn count(ms: &[BoxMesh], part: Part) -> usize {
        ms.iter().filter(|m| m.part == part).count()
    }

    fn bbox(m: &BoxMesh) -> [f64; 6] {
        let mut b = [f64::INFINITY, f64::INFINITY, f64::INFINITY, -f64::INFINITY, -f64::INFINITY, -f64::INFINITY];
        for i in 0..8 {
            for k in 0..3 {
                b[k] = b[k].min(m.positions[i * 3 + k]);
                b[k + 3] = b[k + 3].max(m.positions[i * 3 + k]);
            }
        }
        b
    }

    #[test]
    fn rahmenring_je_eckstoss_ohne_ueberlappung() {
        let area = |q: &Quad| {
            let r = [q[0], q[1], q[3], q[2]];
            let mut a = 0.0;
            for i in 0..4 {
                a += r[i][0] * r[(i + 1) % 4][1] - r[(i + 1) % 4][0] * r[i][1];
            }
            a.abs() / 2.0
        };
        for join in [CornerJoin::Vertical, CornerJoin::Horizontal, CornerJoin::Mitre] {
            let qs = frame_ring_quads(0.0, 1.2, 0.9, 2.1, 0.06, join, true);
            assert_eq!(qs.len(), 4);
            let total: f64 = qs.iter().map(area).sum();
            assert!(close(total, 1.2 * 1.2 - 1.08 * 1.08));
            assert_eq!(frame_ring_quads(0.0, 1.0, 0.0, 2.1, 0.06, join, false).len(), 3);
        }
        // Zu klein: ein Vollprofil.
        assert_eq!(frame_ring_quads(0.0, 0.1, 0.0, 1.0, 0.06, CornerJoin::Vertical, true).len(), 1);
    }

    #[test]
    fn untypisiertes_fenster_eine_scheibe_mittig() {
        let ms = opening_meshes(&[wall(op(false, None))], Detail::Fine);
        assert_eq!(ms.len(), 1);
        assert_eq!(ms[0].part, Part::Glass);
        let b = bbox(&ms[0]);
        assert!(close(b[0], 1.0) && close(b[3], 2.2));
        assert!(close(b[1], -0.004) && close(b[4], 0.004));
        assert!(close(b[2], 0.9) && close(b[5], 2.1));
        // Untypisierte Tür: offenes Loch.
        assert!(opening_meshes(&[wall(op(true, None))], Detail::Fine).is_empty());
    }

    #[test]
    fn typisiertes_fenster_je_detailgrad() {
        let w = [wall(op(false, Some(window_type(SillBoard::Outer))))];
        let grob = opening_meshes(&w, Detail::Coarse);
        assert_eq!(grob.len(), 1);
        assert_eq!(count(&grob, Part::Glass), 1);
        let mittel = opening_meshes(&w, Detail::Medium);
        // Glas + 4 Blendrahmen + 4 Flügelrahmen + Bank + Tropfkante.
        assert_eq!(count(&mittel, Part::Frame), 8);
        assert_eq!(count(&mittel, Part::Sill), 2);
        assert_eq!(count(&mittel, Part::Symbol), 0);
        let fein = opening_meshes(&w, Detail::Fine);
        // Dreh-Kipp: 2 + 2 Symbol-Diagonalen.
        assert_eq!(count(&fein, Part::Symbol), 4);
        // Scheibe nahe der Aussenfläche: Rahmen n ∈ [0.08, 0.15], Glas n ∈ [0.122, 0.13];
        // rechte Normale (0, −1) ⇒ y = −n.
        let g = bbox(&fein[0]);
        assert!(close(g[1], -0.13) && close(g[4], -0.122));
    }

    #[test]
    fn mehrfachverglasung_und_innenbank() {
        let mut t = window_type(SillBoard::Both);
        if let KindIn::Window(w) = &mut t.kind {
            w.glazing_panes = 3.0;
            w.shading = Some([0.0, 0.25, 0.2]);
        }
        let ms = opening_meshes(&[wall(op(false, Some(t)))], Detail::Fine);
        assert_eq!(count(&ms, Part::Glass), 3);
        assert_eq!(count(&ms, Part::Sill), 3);
        assert_eq!(count(&ms, Part::Shading), 1);
        let s = bbox(ms.iter().find(|m| m.part == Part::Shading).unwrap());
        assert!(close(s[0], 1.0) && close(s[3], 2.2) && close(s[2], 2.1) && close(s[5], 2.35));
        // Rollladen nie bei grob.
        let mut t2 = window_type(SillBoard::Outer);
        if let KindIn::Window(w) = &mut t2.kind {
            w.shading = Some([0.0, 0.25, 0.2]);
        }
        assert_eq!(count(&opening_meshes(&[wall(op(false, Some(t2)))], Detail::Coarse), Part::Shading), 0);
    }

    #[test]
    fn tueren_blatt_kassette_und_zarge() {
        let glatt = opening_meshes(&[wall(op(true, Some(door_type(LeafStyle::Plain))))], Detail::Fine);
        assert_eq!(count(&glatt, Part::DoorLeaf), 1);
        assert_eq!(count(&glatt, Part::Glass), 0);
        // Zarge: 3 Ringglieder + 6 Bekleidungen.
        assert_eq!(count(&glatt, Part::Frame), 9);
        let kas = opening_meshes(&[wall(op(true, Some(door_type(LeafStyle::Panelled))))], Detail::Fine);
        // 4 Rahmen + 1 Steg senkrecht + 2 waagrecht + 2×3 Felder.
        assert_eq!(count(&kas, Part::DoorLeaf), 13);
        let glas = opening_meshes(&[wall(op(true, Some(door_type(LeafStyle::Glass))))], Detail::Fine);
        assert_eq!(count(&glas, Part::Glass), 1);
        assert_eq!(count(&glas, Part::DoorLeaf), 0);
    }

    #[test]
    fn fluegeltabelle_mit_pfosten_und_schiebe() {
        let mut t = window_type(SillBoard::None);
        if let KindIn::Window(w) = &mut t.kind {
            let s = |kind, opening, hinge_left| SashIn { kind, fixed_width: false, width: f64::NAN, post_width: f64::NAN, opening, hinge_left };
            w.sashes = vec![s(SashKind::Sash, SashOpening::Slide, false), s(SashKind::Post, SashOpening::None, true), s(SashKind::Sash, SashOpening::Fixed, true)];
        }
        let ms = opening_meshes(&[wall(op(false, Some(t)))], Detail::Fine);
        // Schiebe-Pfeil: 3 Striche; fester Flügel ohne Flügelrahmen.
        assert_eq!(count(&ms, Part::Symbol), 3);
        assert_eq!(count(&ms, Part::Sill), 0);
        let spans = sash_spans(&[SashIn { kind: SashKind::Post, fixed_width: false, width: f64::NAN, post_width: f64::NAN, opening: SashOpening::None, hinge_left: true }], 0.0, 1.0);
        assert!(close(spans[0].2 - spans[0].1, 0.06));
    }

    #[test]
    fn bitgleiche_hilfen() {
        assert!(jmax(-0.0, 0.0).is_sign_positive());
        assert!(jmin(0.0, -0.0).is_sign_negative());
        assert!(jmax(1.0, f64::NAN).is_nan());
        assert_eq!(clamp_range(5.0, 0.0, 1.0), 1.0);
        let (a, b) = frame_normal_range(0.15, 0.07, 0.0, false, false);
        assert!(close(a, 0.08) && close(b, 0.15));
        let (a, b) = frame_normal_range(0.15, 0.07, 0.0, true, false);
        assert!(close(a, -0.15) && close(b, -0.08));
        let (a, b) = frame_normal_range(0.15, 0.08, 0.1, true, true);
        assert!(close(a, -0.04) && close(b, 0.04));
        let (a, b) = frame_normal_range(0.15, 0.07, 0.0, true, false);
        assert!(close(a, -0.15) && close(b, -0.08));
    }

    #[test]
    fn flach_hin_und_zurueck() {
        // Fenster ohne Typ in Wand (0,0)→(5,0), fein.
        let buf = [2.0, 1.0, 0.0, 0.0, 5.0, 0.0, 1.0, 1.0, 2.2, 0.9, 2.1, 0.0, 0.3, 0.0];
        let out = opening_meshes_flat(&buf);
        assert_eq!(out.len(), 1 + 25);
        assert_eq!(out[0], 1.0);
        assert_eq!(out[1], Part::Glass as i32 as f64);
        let ring = frame_ring_quads(0.0, 1.0, 0.0, 1.0, 0.1, CornerJoin::Vertical, true);
        assert_eq!(ring.len(), 4);
        assert_eq!(ring[0], [[0.0, 0.0], [0.1, 0.0], [0.0, 1.0], [0.1, 1.0]]);
    }

    #[test]
    fn unsinn_ohne_panic() {
        assert_eq!(opening_meshes_flat(&[]), vec![0.0]);
        assert_eq!(opening_meshes_flat(&[f64::NAN]), vec![0.0]);
        assert_eq!(opening_meshes_flat(&[2.0, 1e300]), vec![0.0]);
        assert_eq!(opening_meshes_flat(&[2.0, 1.0, 0.0, 0.0, 5.0]), vec![0.0]);
        // Nullwand, NaN-Lagen, riesige Zählwerte, negative Masse.
        let mut buf = vec![2.0, 2.0, 0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 2.0, 0.0, 2.0, 0.0, 0.3, 0.0];
        buf.extend([f64::NAN, 0.0, 0.0, 0.0, 1.0, 1.0, 2.0, 0.0, 2.0, 0.0, 0.3, 1.0]);
        // Fenster-Typ mit Unsinn: riesige Sprossen-/Flügelzahlen, negative Rahmenbreite.
        buf.extend([1e9, -5.0, 0.0, 7.0, -0.5, f64::INFINITY, 1e12, 1e12, 1e12, 9.0, 1.0, f64::NAN, -1.0, 1.0, 1e15, 3.0, 0.0]);
        let out = opening_meshes_flat(&buf);
        assert!(out[0] >= 0.0);
        let mut big = vec![2.0, 1.0, 0.0, 0.0, 5.0, 0.0, 1.0, 1.0, 4.0, 0.0, 2.0, 1.0, 0.3, 1.0];
        big.extend([0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 1e12, 2.0, f64::NAN, 1.0, 1e12, 1e12]);
        assert!(opening_meshes_flat(&big)[0] >= 0.0);
        let _ = frame_ring_quads(f64::NAN, f64::INFINITY, -1.0, 1.0, -3.0, CornerJoin::Mitre, false);
    }

    #[test]
    fn anschlag_und_storenschienen() {
        let mut ty = window_type(SillBoard::None);
        ty.inset_from_face = 0.12;
        ty.frame_depth = 0.08;
        ty.rebate_depth = 0.05;
        let parts = |ty: &TypeIn, d: Detail| -> Vec<Part> { opening_meshes(&[wall(op(false, Some(ty.clone())))], d).into_iter().map(|m| m.part).collect() };
        let n = |v: &[Part], p: Part| v.iter().filter(|x| **x == p).count();
        assert_eq!(n(&parts(&ty, Detail::Coarse), Part::Rebate), 3);
        // Mittig: Anschlag-Zone aussen bis zur Rahmen-Vorderkante.
        ty.inset_mid = true;
        assert_eq!(n(&parts(&ty, Detail::Fine), Part::Rebate), 3);
        ty.inset_mid = false;
        ty.rebate_depth = f64::NAN;
        assert_eq!(n(&parts(&ty, Detail::Fine), Part::Rebate), 0);
        if let KindIn::Window(w) = &mut ty.kind {
            w.shading = Some([0.0, 0.25, 0.2]);
        }
        assert_eq!(n(&parts(&ty, Detail::Fine), Part::Shading), 1);
        if let KindIn::Window(w) = &mut ty.kind {
            w.shading_sturz = true;
            w.shading_rails = true;
        }
        assert_eq!(n(&parts(&ty, Detail::Fine), Part::Shading), 2, "im Sturz: nur zwei Führungsschienen");
    }

    /// [95] Oberlicht-Einteilung (Pfosten + Kippflügel) und Türarten in 3D.
    #[test]
    fn oberlicht_einteilung_und_tuerarten() {
        let count = |ty: &TypeIn, door: bool, part: Part| opening_meshes(&[wall(op(door, Some(ty.clone())))], Detail::Fine).iter().filter(|m| m.part == part).count();
        let mut ty = window_type(SillBoard::None);
        ty.transom_height = 0.4;
        let base = count(&ty, false, Part::Frame);
        let sash = |kind: SashKind, opening: SashOpening| SashIn { kind, fixed_width: false, width: f64::NAN, post_width: f64::NAN, opening, hinge_left: true };
        if let KindIn::Window(w) = &mut ty.kind {
            w.transom_sashes = vec![sash(SashKind::Sash, SashOpening::Tilt), sash(SashKind::Post, SashOpening::None), sash(SashKind::Sash, SashOpening::Fixed)];
        }
        // + Pfosten + Flügelrahmen (4 Profile) des Kippflügels.
        assert_eq!(count(&ty, false, Part::Frame), base + 1 + 4);
        assert!(count(&ty, false, Part::Symbol) >= 2 + 2);

        let mut d = door_type(LeafStyle::Glass);
        if let KindIn::Door(k) = &mut d.kind {
            k.kind = 2.0;
        }
        assert_eq!(count(&d, true, Part::DoorLeaf), 0);
        assert_eq!(count(&d, true, Part::Glass), 2, "Hebeschiebe: zwei Glasfelder");
        if let KindIn::Door(k) = &mut d.kind {
            k.kind = 1.0;
            k.slide_side = -1.0;
        }
        let m = opening_meshes(&[wall(op(true, Some(d.clone())))], Detail::Fine);
        let leaf = m.iter().find(|m| m.part == Part::DoorLeaf).expect("Schiebeblatt");
        // Vor der Innenfläche (y > 0.15 bei Wand entlang +x, rechte Normale −y) und breiter als die Lichte.
        let ys: Vec<f64> = (0..8).map(|i| leaf.positions[i * 3 + 1]).collect();
        assert!(ys.iter().all(|y| *y > 0.15), "{ys:?}");
        let xs: Vec<f64> = (0..8).map(|i| leaf.positions[i * 3]).collect();
        assert!(xs.iter().cloned().fold(f64::INFINITY, f64::min) < 1.0 && xs.iter().cloned().fold(f64::NEG_INFINITY, f64::max) > 2.2);
    }
}
