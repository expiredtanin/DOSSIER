//! Objektbibliothek 2D ([253]): Standard-Symbole (Sanitär, Küche, Tische, Sitzen, Schlafen, Schränke, Aussenraum),
//! die der Kern zur Plan-Zeit aus Massen erzeugt — nach Detailgrad (grob/mittel/fein) und mit Parametern.
//!
//! Aufbau (so, dass später eigene parametrische Objekte [254] ohne Umbau dazukommen):
//! - **Definition** ([`ObjectDef`]): Id (`lib:wc-wand`), Gruppe, Klasse, Einfügepunkt, Parameterliste ([`ParamDef`]:
//!   Schlüssel, Art, Vorgabe, Min, Max, Schritt) — nur Daten, daraus baut die Objekt-Info ihre Felder.
//! - **Erzeugung** ([`LibObject::geometry`]): `(Parameter, Detailgrad, Seed) → Vec<Drawing2DGeom>`; ausgegeben werden nur
//!   allgemeine Primitive (Linie, Rechteck, Polylinie, Kreis, Bogen, Ellipse), nie objektspezifische Typen. Platz für eine
//!   spätere 3D-Erzeugung: weitere Methode am Trait (`geometry3d`), heute nicht umgesetzt.
//! - **Register** ([`find`], [`all`]): die eingebauten Objekte sind die ersten Einträge; eine Benutzerdefinition
//!   käme als weiterer `LibObject`-Implementierer.
//! - **Instanz im Modell**: `Drawing2DGeom::Libobj { libId, at, rotation, params, seed }` — Parameter als offene Map
//!   (Zahl/Bool/Text), keine objektspezifischen Felder. Unbekannte Id ⇒ Platzhalter-Rahmen ([`placeholder`]), kein Fehler.
//!
//! Lokale Geometrie in Metern, +y = Blickrichtung des Objekts (Rückseite/Wand bei y = 0 bei Einfügepunkt „Wandseite
//! Mitte“, sonst Mittelpunkt). Spiegeln (Parameter `mirror`) spiegelt an der y-Achse.

use crate::model::{Drawing2DGeom as G, Vec2};
use crate::plan::style::Detail;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::f64::consts::{FRAC_PI_2, PI, TAU};
use std::sync::OnceLock;

use crate::jsnum::{atan2, cos, sin};

/// Küchenraster (Schweizer Küchennorm): Modulbreite in m.
pub const KITCHEN_MODULE: f64 = 0.55;

// ── Definition ───────────────────────────────────────────────────────────────

/// Art eines Parameters (allgemein gehalten: Zahl mit Einheit, Ganzzahl, Bool, Auswahl).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ParamKind {
    /// Länge in Metern.
    Length,
    /// Ganzzahl.
    Count,
    /// Ja/Nein (0/1).
    Flag,
    /// Zahl 0..1 ohne Einheit.
    Fraction,
    /// Auswahl aus ganzzahligen Werten `min..=max` (Beschriftung je Wert übersetzt die Oberfläche).
    Choice,
}

impl ParamKind {
    pub fn name(self) -> &'static str {
        match self {
            ParamKind::Length => "length",
            ParamKind::Count => "count",
            ParamKind::Flag => "flag",
            ParamKind::Fraction => "fraction",
            ParamKind::Choice => "choice",
        }
    }
}

/// Ein Parameter eines Objekts.
#[derive(Clone, Debug)]
pub struct ParamDef {
    pub key: &'static str,
    pub kind: ParamKind,
    pub default: f64,
    pub min: f64,
    pub max: f64,
    pub step: f64,
}

/// Einfügepunkt (lokaler Ursprung).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Anchor {
    /// Wandseite, Mitte (Sanitär, Küche, Schränke, Betten, Sofa): an die Wand setzen.
    Wall,
    /// Mittelpunkt (Tische, Stühle, Fahrzeuge).
    Center,
}

/// Klasse (Grafik-Kategorie) eines Objekts: Möbel, Sanitär, Fahrzeuge & Freiflächen.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Cat {
    Furniture,
    Sanitary,
    Outdoor,
}

/// Klassen der Bibliothek: Schlüssel, Code, Name, Farbe, Strichstärke (Papier-mm; fein).
pub const CATEGORIES: [(Cat, &str, &str, &str, f64); 3] = [
    (Cat::Furniture, "22", "Möbel", "#4a4a4a", 0.13),
    (Cat::Sanitary, "23", "Sanitär", "#4a4a4a", 0.13),
    (Cat::Outdoor, "24", "Fahrzeuge & Freiflächen", "#4a4a4a", 0.13),
];

impl Cat {
    pub fn code(self) -> &'static str {
        CATEGORIES.iter().find(|c| c.0 == self).map(|c| c.1).unwrap_or("22")
    }
    pub fn name(self) -> &'static str {
        CATEGORIES.iter().find(|c| c.0 == self).map(|c| c.2).unwrap_or("Möbel")
    }
    pub fn key(self) -> &'static str {
        match self {
            Cat::Furniture => "furniture",
            Cat::Sanitary => "sanitary",
            Cat::Outdoor => "outdoor",
        }
    }
}

/// Definition eines Objekts (nur Daten).
#[derive(Clone, Debug)]
pub struct ObjectDef {
    pub id: &'static str,
    pub group: &'static str,
    pub cat: Cat,
    pub anchor: Anchor,
    pub params: Vec<ParamDef>,
    /// Das Objekt nutzt den Seed (Unordnung der Stühle).
    pub seeded: bool,
    /// Rund: Tiefe = Breite (Durchmesser).
    pub round: bool,
    /// Breite = `n` × Küchenmodul (55 cm).
    pub modular: bool,
}

/// Parameter eines Objekts, aufgelöst (Vorgabe, Grenzen), dazu die abgeleiteten Masse `w`/`d`.
#[derive(Clone, Debug)]
pub struct Params {
    vals: BTreeMap<String, f64>,
    pub w: f64,
    pub d: f64,
}

impl Params {
    /// Wert von `key` (0 für unbekannte Schlüssel).
    pub fn get(&self, key: &str) -> f64 {
        self.vals.get(key).copied().unwrap_or(0.0)
    }
    pub fn flag(&self, key: &str) -> bool {
        self.get(key) >= 0.5
    }
    pub fn count(&self, key: &str) -> usize {
        jsround(self.get(key)).max(0.0) as usize
    }
}

fn jsround(x: f64) -> f64 {
    (x + 0.5).floor()
}

/// Ein Objekt der Bibliothek: Definition + Erzeugung. Eigene Objekte [254] implementieren dasselbe.
pub trait LibObject: Send + Sync {
    fn def(&self) -> &ObjectDef;
    /// 2D-Geometrie in lokalen Koordinaten (Einfügepunkt = Ursprung), ohne Spiegelung.
    fn geometry(&self, p: &Params, detail: Detail, seed: u32) -> Vec<G>;
    // Später (3D nach 1.0): `fn geometry3d(&self, p: &Params) -> Option<Solid3D>`.
}

struct Builtin {
    def: ObjectDef,
    gen: fn(&Params, Detail, u32, &mut Sh),
}

impl LibObject for Builtin {
    fn def(&self) -> &ObjectDef {
        &self.def
    }
    fn geometry(&self, p: &Params, detail: Detail, seed: u32) -> Vec<G> {
        let (ox, oy) = match self.def.anchor {
            Anchor::Wall => (-p.w / 2.0, 0.0),
            Anchor::Center => (-p.w / 2.0, -p.d / 2.0),
        };
        let mut sh = Sh { out: Vec::new(), ox, oy };
        (self.gen)(p, detail, seed, &mut sh);
        sh.out
    }
}

impl ObjectDef {
    /// Parameter auflösen: fehlende/ungültige Werte (NaN, falscher Typ) ⇒ Vorgabe, sonst in die Grenzen geklemmt.
    pub fn resolve(&self, given: &BTreeMap<String, Value>) -> Params {
        let mut vals = BTreeMap::new();
        for pd in &self.params {
            let raw = match given.get(pd.key) {
                Some(Value::Number(n)) => n.as_f64(),
                Some(Value::Bool(b)) => Some(if *b { 1.0 } else { 0.0 }),
                _ => None,
            };
            let mut v = raw.filter(|x| x.is_finite()).unwrap_or(pd.default).clamp(pd.min, pd.max);
            if matches!(pd.kind, ParamKind::Count | ParamKind::Choice | ParamKind::Flag) {
                v = jsround(v).clamp(pd.min, pd.max);
            }
            vals.insert(pd.key.to_string(), v);
        }
        let mut p = Params { vals, w: 0.0, d: 0.0 };
        p.w = if self.modular { p.get("n") * KITCHEN_MODULE } else { p.get("w") };
        p.d = if self.round { p.w } else { p.get("d") };
        p
    }
}

// ── Register ─────────────────────────────────────────────────────────────────

/// Alle Objekte der Bibliothek, in Palettenreihenfolge.
pub fn all() -> &'static [Box<dyn LibObject>] {
    static REG: OnceLock<Vec<Box<dyn LibObject>>> = OnceLock::new();
    REG.get_or_init(|| build().into_iter().map(|b| Box::new(b) as Box<dyn LibObject>).collect())
}

pub fn find(id: &str) -> Option<&'static dyn LibObject> {
    all().iter().find(|o| o.def().id == id).map(|b| b.as_ref())
}

/// Parameter, die jedes Objekt zusätzlich kennt: Spiegeln.
const MIRROR: &str = "mirror";

/// Platzhalter für eine unbekannte Objekt-Id: Rahmen mit Diagonalen (Breite/Tiefe aus `w`/`d`, sonst 0.5 m).
pub fn placeholder(params: &BTreeMap<String, Value>) -> Vec<G> {
    let num = |k: &str| params.get(k).and_then(Value::as_f64).filter(|x| x.is_finite() && *x > 0.0).unwrap_or(0.5).min(50.0);
    let (w, d) = (num("w"), num("d"));
    let mut sh = Sh { out: Vec::new(), ox: -w / 2.0, oy: -d / 2.0 };
    sh.rect(0.0, 0.0, w, d);
    sh.line(0.0, 0.0, w, d);
    sh.line(0.0, d, w, 0.0);
    sh.out
}

/// Geometrie einer Instanz: Objekt nach Id (sonst Platzhalter), Parameter, Detailgrad, Spiegeln. Nie ein Fehler.
pub fn geometry_for(lib_id: &str, params: &BTreeMap<String, Value>, detail: Detail, seed: u32) -> Vec<G> {
    let Some(o) = find(lib_id) else { return placeholder(params) };
    let p = o.def().resolve(params);
    let mut g = o.geometry(&p, detail, seed);
    if params.get(MIRROR).is_some_and(|v| v.as_bool() == Some(true) || v.as_f64().is_some_and(|x| x >= 0.5)) {
        g = g.iter().map(mirror_x).collect();
    }
    g
}

/// Spiegelung an der y-Achse (x → −x).
fn mirror_x(g: &G) -> G {
    let m = |q: &Vec2| Vec2 { x: -q.x, y: q.y };
    match g {
        G::Line { a, b } => G::Line { a: m(a), b: m(b) },
        G::Rect { min, max } => G::Rect { min: Vec2 { x: -max.x, y: min.y }, max: Vec2 { x: -min.x, y: max.y } },
        G::Polyline { pts, closed, bulge, holes } => G::Polyline {
            pts: pts.iter().map(m).collect(),
            closed: *closed,
            bulge: bulge.as_ref().map(|b| b.iter().map(|x| -x).collect()),
            holes: holes.clone(),
        },
        G::Circle { center, r } => G::Circle { center: m(center), r: *r },
        G::Arc { center, r, a0, a1 } => G::Arc { center: m(center), r: *r, a0: PI - a1, a1: PI - a0 },
        G::Ellipse { center, rx, ry, rotation } => G::Ellipse { center: m(center), rx: *rx, ry: *ry, rotation: -rotation },
        other => other.clone(),
    }
}

/// Katalog als JSON (für die Palette und die Objekt-Info): Objekte mit Parameterliste. Namen und Beschriftungen
/// übersetzt die Oberfläche über `lib.o.<id>`, `lib.g.<gruppe>`, `lib.p.<schlüssel>`.
pub fn catalog_json() -> Value {
    let objs: Vec<Value> = all()
        .iter()
        .map(|o| {
            let d = o.def();
            let mut params: Vec<Value> = d
                .params
                .iter()
                .map(|p| json!({"key": p.key, "kind": p.kind.name(), "default": p.default, "min": p.min, "max": p.max, "step": p.step}))
                .collect();
            params.push(json!({"key": MIRROR, "kind": "flag", "default": 0, "min": 0, "max": 1, "step": 1}));
            json!({
                "id": d.id, "group": d.group, "category": d.cat.key(), "categoryCode": d.cat.code(), "categoryName": d.cat.name(),
                "anchor": if d.anchor == Anchor::Wall { "wall" } else { "center" }, "seeded": d.seeded, "params": params,
            })
        })
        .collect();
    let cats: Vec<Value> = CATEGORIES.iter().map(|c| json!({"key": c.0.key(), "code": c.1, "name": c.2, "color": c.3, "lw": c.4})).collect();
    json!({"objects": objs, "categories": cats})
}

// ── Zeichenhelfer ────────────────────────────────────────────────────────────

/// Sammler: Koordinaten im Kasten (x 0..w, y 0..d), verschoben um den Einfügepunkt.
struct Sh {
    out: Vec<G>,
    ox: f64,
    oy: f64,
}

impl Sh {
    fn p(&self, x: f64, y: f64) -> Vec2 {
        Vec2 { x: x + self.ox, y: y + self.oy }
    }
    fn line(&mut self, x0: f64, y0: f64, x1: f64, y1: f64) {
        let (a, b) = (self.p(x0, y0), self.p(x1, y1));
        self.out.push(G::Line { a, b });
    }
    fn rect(&mut self, x0: f64, y0: f64, x1: f64, y1: f64) {
        let (min, max) = (self.p(x0.min(x1), y0.min(y1)), self.p(x0.max(x1), y0.max(y1)));
        self.out.push(G::Rect { min, max });
    }
    fn poly(&mut self, pts: &[(f64, f64)], closed: bool) {
        let pts = pts.iter().map(|q| self.p(q.0, q.1)).collect();
        self.out.push(G::Polyline { pts, closed, bulge: None, holes: None });
    }
    fn circle(&mut self, x: f64, y: f64, r: f64) {
        let center = self.p(x, y);
        self.out.push(G::Circle { center, r });
    }
    fn ellipse(&mut self, x: f64, y: f64, rx: f64, ry: f64) {
        let center = self.p(x, y);
        self.out.push(G::Ellipse { center, rx, ry, rotation: 0.0 });
    }
    /// Rechteck mit gerundeten Ecken (Radius `r`, je 4 Segmente).
    fn rrect(&mut self, x0: f64, y0: f64, x1: f64, y1: f64, r: f64) {
        let r = r.min((x1 - x0) / 2.0).min((y1 - y0) / 2.0).max(0.0);
        if r < 1e-4 {
            return self.rect(x0, y0, x1, y1);
        }
        let mut pts = Vec::new();
        for (cx, cy, a0) in [(x1 - r, y1 - r, 0.0), (x0 + r, y1 - r, FRAC_PI_2), (x0 + r, y0 + r, PI), (x1 - r, y0 + r, PI + FRAC_PI_2)] {
            for i in 0..=4 {
                let a = a0 + FRAC_PI_2 * i as f64 / 4.0;
                pts.push((cx + r * cos(a), cy + r * sin(a)));
            }
        }
        self.poly(&pts, true);
    }
    /// Gestrichelter Kreis aus Bögen (`n` Striche, halb Strich, halb Lücke).
    fn dashed_circle(&mut self, x: f64, y: f64, r: f64, n: usize) {
        let center = self.p(x, y);
        for i in 0..n {
            let a0 = TAU * i as f64 / n as f64;
            self.out.push(G::Arc { center, r, a0, a1: a0 + TAU / n as f64 * 0.55 });
        }
    }
    /// Verdrehtes Rechteck um (cx, cy) um `rot`, Kasten −hw..hw × −hd..hd.
    fn rot_rect(&mut self, cx: f64, cy: f64, hw: f64, hd: f64, rot: f64) {
        let (c, s) = (cos(rot), sin(rot));
        let pts: Vec<(f64, f64)> = [(-hw, -hd), (hw, -hd), (hw, hd), (-hw, hd)].iter().map(|(x, y)| (cx + x * c - y * s, cy + x * s + y * c)).collect();
        self.poly(&pts, true);
    }
    fn rot_line(&mut self, cx: f64, cy: f64, rot: f64, a: (f64, f64), b: (f64, f64)) {
        let (c, s) = (cos(rot), sin(rot));
        let t = |q: (f64, f64)| (cx + q.0 * c - q.1 * s, cy + q.0 * s + q.1 * c);
        let (pa, pb) = (t(a), t(b));
        self.line(pa.0, pa.1, pb.0, pb.1);
    }
}

fn ell_pts(cx: f64, cy: f64, rx: f64, ry: f64, a0: f64, a1: f64, n: usize) -> Vec<(f64, f64)> {
    (0..=n).map(|i| {
        let a = a0 + (a1 - a0) * i as f64 / n as f64;
        (cx + rx * cos(a), cy + ry * sin(a))
    }).collect()
}

// ── Erzeuger ─────────────────────────────────────────────────────────────────

fn mid(d: Detail) -> bool {
    d != Detail::Grob
}
fn fine(d: Detail) -> bool {
    d == Detail::Fein
}

/// WC: Schüssel mit halbrundem Bug; `cistern` = Tiefe des aufgesetzten Spülkastens (0 = wandhängend).
fn wc(p: &Params, dt: Detail, cistern: f64, sh: &mut Sh) {
    let (w, d) = (p.w, p.d);
    let top = cistern;
    if cistern > 0.0 {
        sh.rect(0.0, 0.0, w, cistern);
        if fine(dt) {
            sh.rect(w / 2.0 - 0.04, 0.03, w / 2.0 + 0.04, 0.07);
        }
    }
    let ry = (d - top) * 0.45;
    let mut pts = vec![(0.0, top), (w, top), (w, d - ry)];
    pts.extend(ell_pts(w / 2.0, d - ry, w / 2.0, ry, 0.0, PI, 12));
    sh.poly(&pts, true);
    if mid(dt) {
        sh.ellipse(w / 2.0, d - ry, w / 2.0 - 0.05, ry - 0.05);
    }
    if fine(dt) {
        sh.line(w * 0.15, top + 0.06, w * 0.85, top + 0.06);
    }
}

/// Becken (Lavabo, Handwaschbecken, Spüle): Umriss + Innenkontur (+ Ablauf, Armatur).
fn basin(sh: &mut Sh, dt: Detail, x0: f64, x1: f64, d: f64, round_in: bool) {
    sh.rrect(x0, 0.0, x1, d, 0.06);
    if mid(dt) {
        let (cx, cy) = ((x0 + x1) / 2.0, d * 0.55);
        let (rx, ry) = ((x1 - x0) / 2.0 - 0.05, d * 0.5 - 0.04);
        if round_in {
            sh.ellipse(cx, cy, rx, ry);
        } else {
            sh.rrect(cx - rx, cy - ry, cx + rx, cy + ry, 0.05);
        }
    }
    if fine(dt) {
        let cx = (x0 + x1) / 2.0;
        sh.circle(cx, d * 0.55, 0.02);
        sh.circle(cx, 0.045, 0.012);
    }
}

fn lavabo(p: &Params, dt: Detail, sh: &mut Sh) {
    basin(sh, dt, 0.0, p.w, p.d, true);
}

fn double_basin(p: &Params, dt: Detail, sh: &mut Sh) {
    sh.rrect(0.0, 0.0, p.w, p.d, 0.05);
    for (a, b) in [(0.0, p.w / 2.0), (p.w / 2.0, p.w)] {
        if mid(dt) {
            sh.ellipse((a + b) / 2.0, p.d * 0.55, (b - a) / 2.0 - 0.07, p.d * 0.5 - 0.05);
        }
        if fine(dt) {
            sh.circle((a + b) / 2.0, p.d * 0.55, 0.02);
        }
    }
}

fn shower(p: &Params, dt: Detail, sh: &mut Sh) {
    let (w, d) = (p.w, p.d);
    sh.rect(0.0, 0.0, w, d);
    sh.line(0.0, d, w, 0.0);
    if mid(dt) {
        sh.circle(w / 2.0, d / 2.0, 0.04);
        sh.line(0.0, d - 0.02, w, d - 0.02);
    }
    if fine(dt) {
        sh.rect(0.03, 0.03, w - 0.03, d - 0.03);
    }
}

fn bathtub(p: &Params, dt: Detail, sh: &mut Sh) {
    let (w, d) = (p.w, p.d);
    sh.rrect(0.0, 0.0, w, d, 0.06);
    let m = 0.05;
    sh.rrect(m, m, w - m, d - m, (d - 2.0 * m) * 0.45);
    if mid(dt) {
        sh.circle(0.17, d / 2.0, 0.025);
        sh.line(0.09, d / 2.0 - 0.05, 0.09, d / 2.0 + 0.05);
    }
    if fine(dt) {
        sh.circle(w - 0.35, d / 2.0, 0.02);
        sh.line(w - 0.25, m + 0.04, w - 0.25, d - m - 0.04);
    }
}

fn urinal(p: &Params, dt: Detail, sh: &mut Sh) {
    let (w, d) = (p.w, p.d);
    let ry = d * 0.45;
    let mut pts = vec![(0.0, 0.0), (w, 0.0), (w, d - ry)];
    pts.extend(ell_pts(w / 2.0, d - ry, w / 2.0, ry, 0.0, PI, 10));
    sh.poly(&pts, true);
    if mid(dt) {
        sh.ellipse(w / 2.0, d - ry, w / 2.0 - 0.05, ry - 0.05);
    }
    if fine(dt) {
        sh.circle(w / 2.0, d - ry, 0.02);
    }
}

fn washer(p: &Params, dt: Detail, sh: &mut Sh) {
    let (w, d) = (p.w, p.d);
    sh.rect(0.0, 0.0, w, d);
    let r = (w.min(d) * 0.36).max(0.05);
    sh.circle(w / 2.0, d / 2.0 + 0.02, r);
    if mid(dt) {
        sh.circle(w / 2.0, d / 2.0 + 0.02, r * 0.75);
    }
    if fine(dt) {
        sh.line(0.0, d - 0.05, w, d - 0.05);
    }
}

// Küche ----------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq)]
enum Mod {
    Base,
    Sink,
    Hob,
    Dish,
    Fridge,
    Tall,
}

fn kitchen_module(sh: &mut Sh, dt: Detail, m: Mod, x0: f64, x1: f64, d: f64, outline: bool) {
    if outline {
        sh.rect(x0, 0.0, x1, d);
    }
    let (cx, w) = ((x0 + x1) / 2.0, x1 - x0);
    match m {
        Mod::Base => {
            if mid(dt) {
                sh.line(x0, d - 0.02, x1, d - 0.02);
            }
        }
        Mod::Sink => {
            sh.rect(x0 + 0.06, 0.07, x0 + w * 0.65, d - 0.1);
            if mid(dt) {
                sh.line(x0 + w * 0.65, 0.07, x0 + w * 0.65, d - 0.1);
            }
            if fine(dt) {
                sh.circle(x0 + w * 0.33, (d + 0.07 - 0.1) / 2.0, 0.025);
                sh.line(x0 + w * 0.7, 0.2, x0 + w - 0.04, 0.2);
                sh.line(x0 + w * 0.7, 0.28, x0 + w - 0.04, 0.28);
            }
        }
        Mod::Hob => {
            let r = (w * 0.16).min(0.09);
            for (dx, dy) in [(-0.25, 0.3), (0.25, 0.3), (-0.25, 0.72), (0.25, 0.72)] {
                sh.circle(cx + dx * w, d * dy, r * if dy > 0.5 { 0.85 } else { 1.0 });
            }
            if fine(dt) {
                sh.rect(x0 + 0.04, 0.04, x1 - 0.04, d - 0.04);
            }
        }
        Mod::Dish => {
            sh.line(x0, 0.0, x1, d);
            if mid(dt) {
                sh.line(x0, d - 0.04, x1, d - 0.04);
            }
        }
        Mod::Fridge => {
            sh.line(x0, 0.0, x1, d);
            sh.line(x0, d, x1, 0.0);
            if fine(dt) {
                sh.line(x0, d * 0.7, x1, d * 0.7);
            }
        }
        Mod::Tall => {
            sh.line(x0, 0.0, x1, d);
            if mid(dt) {
                sh.line(x0, d - 0.02, x1, d - 0.02);
            }
        }
    }
}

fn kitchen_single(m: Mod) -> impl Fn(&Params, Detail, u32, &mut Sh) {
    move |p, dt, _, sh| kitchen_module(sh, dt, m, 0.0, p.w, p.d, true)
}

fn kitchen_row(p: &Params, dt: Detail, sh: &mut Sh) {
    let n = p.count("n").max(1);
    sh.rect(0.0, 0.0, p.w, p.d);
    let seq = [Mod::Base, Mod::Sink, Mod::Dish, Mod::Base, Mod::Hob];
    for i in 0..n {
        let m = seq.get(i).copied().unwrap_or(Mod::Base);
        let (x0, x1) = (i as f64 * KITCHEN_MODULE, (i + 1) as f64 * KITCHEN_MODULE);
        if i > 0 && mid(dt) {
            sh.line(x0, 0.0, x0, p.d);
        }
        kitchen_module(sh, dt, m, x0, x1, p.d, false);
    }
}

fn kitchen_island(p: &Params, dt: Detail, sh: &mut Sh) {
    let (w, d) = (p.w, p.d);
    sh.rect(0.0, 0.0, w, d);
    sh.line(0.0, d - 0.3, w, d - 0.3);
    if mid(dt) {
        let r = 0.09;
        for (cx, cy) in [(0.3, 0.15), (0.5, 0.15), (0.3, 0.33), (0.5, 0.33)] {
            sh.circle(cx, cy, r * 0.8);
        }
        sh.rect(w - 0.7, 0.1, w - 0.15, d - 0.4);
    }
    if fine(dt) {
        sh.circle(w - 0.42, (d - 0.3) / 2.0 + 0.1, 0.025);
    }
}

// Tische und Stühle ----------------------------------------------------------

const CHAIR_W: f64 = 0.45;
const CHAIR_D: f64 = 0.50;
const CHAIR_GAP: f64 = 0.03;

/// Stuhl, lokal: Rückenlehne bei y = −d/2, Blick +y.
fn chair_at(sh: &mut Sh, dt: Detail, cx: f64, cy: f64, rot: f64) {
    let (hw, hd) = (CHAIR_W / 2.0, CHAIR_D / 2.0);
    sh.rot_rect(cx, cy, hw, hd, rot);
    if mid(dt) {
        sh.rot_line(cx, cy, rot, (-hw, -hd + 0.07), (hw, -hd + 0.07));
    }
    if fine(dt) {
        sh.rot_line(cx, cy, rot, (-hw + 0.03, -hd + 0.07), (-hw + 0.03, hd - 0.04));
        sh.rot_line(cx, cy, rot, (hw - 0.03, -hd + 0.07), (hw - 0.03, hd - 0.04));
    }
}

fn chair(p: &Params, dt: Detail, sh: &mut Sh) {
    sh.rect(0.0, 0.0, p.w, p.d);
    if mid(dt) {
        sh.line(0.0, 0.07, p.w, 0.07);
    }
    if fine(dt) {
        sh.line(0.03, 0.07, 0.03, p.d - 0.04);
        sh.line(p.w - 0.03, 0.07, p.w - 0.03, p.d - 0.04);
    }
}

/// Zufall 0..1 aus Seed und Zähler (SplitMix32-artig, ganzzahlig ⇒ auf allen Plattformen gleich).
fn rnd(seed: u32, i: u32) -> f64 {
    let mut z = seed.wrapping_add(i.wrapping_mul(0x9E37_79B9)).wrapping_add(0x7F4A_7C15);
    z = (z ^ (z >> 16)).wrapping_mul(0x85EB_CA6B);
    z = (z ^ (z >> 13)).wrapping_mul(0xC2B2_AE35);
    z ^= z >> 16;
    z as f64 / 4_294_967_296.0
}

/// Stuhl an einer Tischkante: Mitte der Kante `edge` (Punkt), Aussennormale `nx, ny`, `lat` entlang der Kante,
/// Unordnung `m` (0–1) mit Seed. Rückt so weit hinaus, dass der Stuhl den Tisch nie schneidet.
fn chair_for_edge(sh: &mut Sh, dt: Detail, edge: (f64, f64), n: (f64, f64), tang: (f64, f64), lat: f64, m: f64, seed: u32, idx: u32) {
    let (phi, out, side) = if m > 0.0 {
        ((rnd(seed, idx * 3) * 2.0 - 1.0) * 12.0_f64.to_radians() * m, rnd(seed, idx * 3 + 1) * 0.08 * m, (rnd(seed, idx * 3 + 2) * 2.0 - 1.0) * 0.02 * m)
    } else {
        (0.0, 0.0, 0.0)
    };
    let rot = atan2(n.0, -n.1) + phi;
    // Ausdehnung des verdrehten Stuhls entlang der Normalen.
    let ext = CHAIR_D / 2.0 * cos(phi).abs() + CHAIR_W / 2.0 * sin(phi).abs();
    let dist = CHAIR_GAP + ext + out;
    let (cx, cy) = (edge.0 + n.0 * dist + tang.0 * (lat + side), edge.1 + n.1 * dist + tang.1 * (lat + side));
    chair_at(sh, dt, cx, cy, rot);
}

fn rect_table(p: &Params, dt: Detail, seed: u32, sh: &mut Sh) {
    let (w, d) = (p.w, p.d);
    sh.rect(0.0, 0.0, w, d);
    if fine(dt) {
        sh.rect(0.04, 0.04, w - 0.04, d - 0.04);
    }
    let n = p.count("n");
    if n == 0 {
        return;
    }
    let m = p.get("mess");
    let ends = if n >= 6 { 2 } else { 0 };
    let sides = n - ends;
    let (bottom, top) = (sides.div_ceil(2), sides / 2);
    let mut idx = 0u32;
    for (k, y, ny) in [(bottom, 0.0, -1.0), (top, d, 1.0)] {
        for i in 0..k {
            let x = w * (i as f64 + 0.5) / k as f64;
            chair_for_edge(sh, dt, (x, y), (0.0, ny), (1.0, 0.0), 0.0, m, seed, idx);
            idx += 1;
        }
    }
    if ends == 2 {
        chair_for_edge(sh, dt, (0.0, d / 2.0), (-1.0, 0.0), (0.0, 1.0), 0.0, m, seed, idx);
        chair_for_edge(sh, dt, (w, d / 2.0), (1.0, 0.0), (0.0, 1.0), 0.0, m, seed, idx + 1);
    }
}

fn round_table(p: &Params, dt: Detail, seed: u32, sh: &mut Sh) {
    let r = p.w / 2.0;
    sh.circle(r, r, r);
    if fine(dt) {
        sh.circle(r, r, r - 0.04);
    }
    let n = p.count("n");
    let m = p.get("mess");
    for i in 0..n {
        let a = FRAC_PI_2 + TAU * i as f64 / n as f64;
        let nrm = (cos(a), sin(a));
        chair_for_edge(sh, dt, (r + nrm.0 * r, r + nrm.1 * r), nrm, (-nrm.1, nrm.0), 0.0, m, seed, i as u32);
    }
}

fn office_table(p: &Params, dt: Detail, seed: u32, sh: &mut Sh) {
    rect_table(p, dt, seed, sh);
    if mid(dt) {
        // Kabelkanal-/Plattenlinie
        sh.line(0.0, p.d - 0.04, p.w, p.d - 0.04);
    }
}

fn coffee_table(p: &Params, dt: Detail, sh: &mut Sh) {
    sh.rrect(0.0, 0.0, p.w, p.d, 0.04);
    if fine(dt) {
        sh.rrect(0.04, 0.04, p.w - 0.04, p.d - 0.04, 0.02);
    }
}

// Sitzen ----------------------------------------------------------------------

fn sofa(p: &Params, dt: Detail, sh: &mut Sh) {
    let (w, d) = (p.w, p.d);
    sh.rrect(0.0, 0.0, w, d, 0.05);
    sh.line(0.0, 0.22, w, 0.22);
    if mid(dt) {
        sh.line(0.2, 0.22, 0.2, d);
        sh.line(w - 0.2, 0.22, w - 0.2, d);
    }
    if fine(dt) {
        let seats = if w > 1.9 { 3 } else { 2 };
        for i in 1..seats {
            let x = 0.2 + (w - 0.4) * i as f64 / seats as f64;
            sh.line(x, 0.22, x, d - 0.02);
        }
    }
}

fn armchair(p: &Params, dt: Detail, sh: &mut Sh) {
    let (w, d) = (p.w, p.d);
    sh.rrect(0.0, 0.0, w, d, 0.05);
    sh.line(0.0, 0.2, w, 0.2);
    if mid(dt) {
        sh.line(0.17, 0.2, 0.17, d);
        sh.line(w - 0.17, 0.2, w - 0.17, d);
    }
}

// Schlafen ---------------------------------------------------------------------

fn bed(p: &Params, dt: Detail, sh: &mut Sh) {
    let (w, d) = (p.w, p.d);
    sh.rect(0.0, 0.0, w, d);
    // Deckenkante
    sh.line(0.0, d * 0.28, w, d * 0.28);
    if mid(dt) {
        let double = w >= 1.3;
        let pw = if double { (w - 0.15) / 2.0 - 0.04 } else { w - 0.2 };
        let xs: Vec<f64> = if double { vec![0.075 + 0.02, w / 2.0 + 0.02] } else { vec![0.1] };
        for x in xs {
            sh.rect(x, 0.07, x + pw, d.min(0.45) * 0.8);
        }
    }
    if fine(dt) {
        sh.line(0.0, 0.04, w, 0.04);
    }
}

fn nightstand(p: &Params, dt: Detail, sh: &mut Sh) {
    sh.rect(0.0, 0.0, p.w, p.d);
    if mid(dt) {
        sh.line(0.0, p.d - 0.02, p.w, p.d - 0.02);
    }
    if fine(dt) {
        sh.circle(p.w / 2.0, p.d / 2.0, 0.03);
    }
}

// Schränke ---------------------------------------------------------------------

fn cupboard(p: &Params, dt: Detail, sh: &mut Sh) {
    sh.rect(0.0, 0.0, p.w, p.d);
    sh.line(0.0, 0.0, p.w, p.d);
    if mid(dt) {
        sh.line(0.0, p.d - 0.02, p.w, p.d - 0.02);
    }
    if fine(dt) {
        let doors = (p.w / 0.5).round().max(1.0) as usize;
        for i in 1..doors {
            let x = p.w * i as f64 / doors as f64;
            sh.line(x, p.d - 0.02, x, p.d);
        }
    }
}

fn wardrobe(p: &Params, dt: Detail, sh: &mut Sh) {
    sh.rect(0.0, 0.0, p.w, p.d);
    sh.line(0.04, p.d / 2.0, p.w - 0.04, p.d / 2.0);
    if mid(dt) {
        sh.line(0.0, p.d - 0.02, p.w, p.d - 0.02);
    }
    if fine(dt) {
        for i in 1..5 {
            let x = 0.04 + (p.w - 0.08) * i as f64 / 5.0;
            sh.line(x, p.d / 2.0 - 0.03, x, p.d / 2.0 + 0.03);
        }
    }
}

fn shelf(p: &Params, dt: Detail, sh: &mut Sh) {
    sh.rect(0.0, 0.0, p.w, p.d);
    sh.line(0.0, 0.0, p.w, p.d);
    sh.line(0.0, p.d, p.w, 0.0);
    if fine(dt) {
        sh.line(0.0, p.d - 0.02, p.w, p.d - 0.02);
    }
}

// Aussenraum -------------------------------------------------------------------

fn car(p: &Params, dt: Detail, sh: &mut Sh) {
    let (w, d) = (p.w, p.d);
    // Parkfeld (Mitte, Auto darin zentriert), nur wenn `field` gesetzt.
    let (fw, fh) = (2.5_f64.max(w), 5.0_f64.max(d));
    if p.flag("field") {
        sh.rect((w - fw) / 2.0, (d - fh) / 2.0, (w + fw) / 2.0, (d + fh) / 2.0);
    }
    sh.rrect(0.0, 0.0, w, d, 0.25);
    // Kabine (Dach) und Frontscheibe als Kennlinien
    sh.line(0.06, d * 0.30, w - 0.06, d * 0.30);
    sh.line(0.06, d * 0.72, w - 0.06, d * 0.72);
    if mid(dt) {
        sh.rrect(0.12, d * 0.30, w - 0.12, d * 0.72, 0.1);
    }
    if fine(dt) {
        for (x, y) in [(0.0, 0.7), (w, 0.7), (0.0, d - 1.1), (w, d - 1.1)] {
            sh.rect(x - 0.03, y, x + 0.03, y + 0.2);
        }
        sh.rect(-0.08, d * 0.62, 0.0, d * 0.62 + 0.12);
        sh.rect(w, d * 0.62, w + 0.08, d * 0.62 + 0.12);
    }
}

fn parking(p: &Params, _dt: Detail, sh: &mut Sh) {
    sh.rect(0.0, 0.0, p.w, p.d);
}

fn bike(p: &Params, dt: Detail, sh: &mut Sh) {
    let (w, d) = (p.w, p.d);
    sh.line(w / 2.0, 0.0, w / 2.0, d);
    sh.rrect(w / 2.0 - 0.03, 0.0, w / 2.0 + 0.03, 0.65, 0.03);
    sh.rrect(w / 2.0 - 0.03, d - 0.65, w / 2.0 + 0.03, d, 0.03);
    sh.line(0.0, d - 0.55, w, d - 0.55);
    if mid(dt) {
        sh.rect(w / 2.0 - 0.05, 0.62, w / 2.0 + 0.05, 0.9);
    }
    if fine(dt) {
        sh.line(w / 2.0 - 0.08, 0.5, w / 2.0 + 0.08, 0.5);
    }
}

fn wheelchair_circle(p: &Params, dt: Detail, sh: &mut Sh) {
    let r = p.w / 2.0;
    sh.dashed_circle(r, r, r, 24);
    if mid(dt) {
        sh.line(r - 0.1, r, r + 0.1, r);
        sh.line(r, r - 0.1, r, r + 0.1);
    }
}

// ── Katalog ──────────────────────────────────────────────────────────────────

fn len(key: &'static str, default: f64, min: f64, max: f64) -> ParamDef {
    ParamDef { key, kind: ParamKind::Length, default, min, max, step: 0.05 }
}
fn count(key: &'static str, default: f64, min: f64, max: f64) -> ParamDef {
    ParamDef { key, kind: ParamKind::Count, default, min, max, step: 1.0 }
}
fn flag(key: &'static str, default: f64) -> ParamDef {
    ParamDef { key, kind: ParamKind::Flag, default, min: 0.0, max: 1.0, step: 1.0 }
}
fn frac(key: &'static str, default: f64) -> ParamDef {
    ParamDef { key, kind: ParamKind::Fraction, default, min: 0.0, max: 1.0, step: 0.05 }
}

fn wd(w: f64, d: f64) -> Vec<ParamDef> {
    vec![len("w", w, 0.1, 6.0), len("d", d, 0.1, 6.0)]
}

fn ent(id: &'static str, group: &'static str, cat: Cat, anchor: Anchor, params: Vec<ParamDef>, gen: fn(&Params, Detail, u32, &mut Sh)) -> Builtin {
    Builtin { def: ObjectDef { id, group, cat, anchor, params, seeded: false, round: false, modular: false }, gen }
}

fn build() -> Vec<Builtin> {
    use Anchor::{Center, Wall};
    use Cat::{Furniture as F, Outdoor as O, Sanitary as S};
    let mut v: Vec<Builtin> = Vec::new();
    let tbl = |id: &'static str, w: f64, d: f64, n: f64, gen: fn(&Params, Detail, u32, &mut Sh), round: bool| {
        let mut params = if round { vec![len("w", w, 0.4, 3.0)] } else { wd(w, d) };
        params.push(count("n", n, 0.0, 12.0));
        params.push(frac("mess", 0.0));
        let mut b = ent(id, "tables", F, Center, params, gen);
        b.def.seeded = true;
        b.def.round = round;
        b
    };
    let tables = vec![
        tbl("lib:tisch-80x140", 1.4, 0.8, 6.0, rect_table, false),
        tbl("lib:tisch-80x140-leer", 1.4, 0.8, 0.0, rect_table, false),
        tbl("lib:tisch-90x180", 1.8, 0.9, 8.0, rect_table, false),
        tbl("lib:tisch-90x180-leer", 1.8, 0.9, 0.0, rect_table, false),
        tbl("lib:tisch-rund-100", 1.0, 1.0, 4.0, round_table, true),
        tbl("lib:tisch-rund-100-leer", 1.0, 1.0, 0.0, round_table, true),
        tbl("lib:tisch-rund-120", 1.2, 1.2, 5.0, round_table, true),
        tbl("lib:tisch-rund-120-leer", 1.2, 1.2, 0.0, round_table, true),
        tbl("lib:tisch-buero", 1.6, 0.8, 1.0, office_table, false),
    ];

    // Sanitär
    v.push(ent("lib:wc-wand", "sanitary", S, Wall, wd(0.38, 0.55), |p, dt, _, sh| wc(p, dt, 0.0, sh)));
    v.push(ent("lib:wc-kasten", "sanitary", S, Wall, wd(0.40, 0.70), |p, dt, _, sh| wc(p, dt, 0.2, sh)));
    v.push(ent("lib:lavabo", "sanitary", S, Wall, wd(0.60, 0.45), |p, dt, _, sh| lavabo(p, dt, sh)));
    v.push(ent("lib:handwaschbecken", "sanitary", S, Wall, wd(0.45, 0.32), |p, dt, _, sh| lavabo(p, dt, sh)));
    v.push(ent("lib:doppellavabo", "sanitary", S, Wall, wd(1.20, 0.50), |p, dt, _, sh| double_basin(p, dt, sh)));
    v.push(ent("lib:dusche-90", "sanitary", S, Wall, wd(0.90, 0.90), |p, dt, _, sh| shower(p, dt, sh)));
    v.push(ent("lib:dusche-80x120", "sanitary", S, Wall, wd(1.20, 0.80), |p, dt, _, sh| shower(p, dt, sh)));
    v.push(ent("lib:wanne-170", "sanitary", S, Wall, wd(1.70, 0.75), |p, dt, _, sh| bathtub(p, dt, sh)));
    v.push(ent("lib:wanne-180", "sanitary", S, Wall, wd(1.80, 0.80), |p, dt, _, sh| bathtub(p, dt, sh)));
    v.push(ent("lib:urinal", "sanitary", S, Wall, wd(0.35, 0.35), |p, dt, _, sh| urinal(p, dt, sh)));
    v.push(ent("lib:waschmaschine", "sanitary", S, Wall, wd(0.60, 0.60), |p, dt, _, sh| washer(p, dt, sh)));

    // Küche (55er-Raster, Tiefe 60)
    v.push(ent("lib:kueche-unterbau", "kitchen", F, Wall, wd(0.55, 0.60), |p, dt, s, sh| kitchen_single(Mod::Base)(p, dt, s, sh)));
    v.push(ent("lib:kueche-spuele", "kitchen", F, Wall, wd(0.55, 0.60), |p, dt, s, sh| kitchen_single(Mod::Sink)(p, dt, s, sh)));
    v.push(ent("lib:kueche-kochfeld", "kitchen", F, Wall, wd(0.55, 0.60), |p, dt, s, sh| kitchen_single(Mod::Hob)(p, dt, s, sh)));
    v.push(ent("lib:kueche-geschirrspueler", "kitchen", F, Wall, wd(0.55, 0.60), |p, dt, s, sh| kitchen_single(Mod::Dish)(p, dt, s, sh)));
    v.push(ent("lib:kueche-kuehlschrank", "kitchen", F, Wall, wd(0.55, 0.60), |p, dt, s, sh| kitchen_single(Mod::Fridge)(p, dt, s, sh)));
    v.push(ent("lib:kueche-hochschrank", "kitchen", F, Wall, wd(0.55, 0.60), |p, dt, s, sh| kitchen_single(Mod::Tall)(p, dt, s, sh)));
    let mut row = ent("lib:kueche-zeile", "kitchen", F, Wall, vec![count("n", 5.0, 1.0, 12.0), len("d", 0.60, 0.3, 1.2)], |p, dt, _, sh| kitchen_row(p, dt, sh));
    row.def.modular = true;
    v.push(row);
    v.push(ent("lib:kueche-insel", "kitchen", F, Center, wd(1.65, 0.90), |p, dt, _, sh| kitchen_island(p, dt, sh)));

    // Tische
    v.extend(tables);

    // Sitzen
    v.push(ent("lib:stuhl", "seating", F, Center, wd(0.45, 0.50), |p, dt, _, sh| chair(p, dt, sh)));
    v.push(ent("lib:sofa-2", "seating", F, Wall, wd(1.60, 0.90), |p, dt, _, sh| sofa(p, dt, sh)));
    v.push(ent("lib:sofa-3", "seating", F, Wall, wd(2.10, 0.90), |p, dt, _, sh| sofa(p, dt, sh)));
    v.push(ent("lib:sessel", "seating", F, Wall, wd(0.80, 0.80), |p, dt, _, sh| armchair(p, dt, sh)));
    v.push(ent("lib:salontisch", "seating", F, Center, wd(1.00, 0.60), |p, dt, _, sh| coffee_table(p, dt, sh)));

    // Schlafen
    for (id, w, d) in [("lib:bett-90", 0.9, 2.0), ("lib:bett-140", 1.4, 2.0), ("lib:bett-160", 1.6, 2.0), ("lib:bett-180", 1.8, 2.0), ("lib:kinderbett", 0.7, 1.4)] {
        v.push(ent(id, "sleeping", F, Wall, wd(w, d), |p, dt, _, sh| bed(p, dt, sh)));
    }
    v.push(ent("lib:nachttisch", "sleeping", F, Wall, wd(0.40, 0.40), |p, dt, _, sh| nightstand(p, dt, sh)));

    // Schränke
    for (id, w) in [("lib:schrank-50", 0.5), ("lib:schrank-60", 0.6), ("lib:schrank-100", 1.0)] {
        v.push(ent(id, "cupboards", F, Wall, wd(w, 0.60), |p, dt, _, sh| cupboard(p, dt, sh)));
    }
    v.push(ent("lib:garderobe", "cupboards", F, Wall, wd(1.00, 0.35), |p, dt, _, sh| wardrobe(p, dt, sh)));
    v.push(ent("lib:regal", "cupboards", F, Wall, wd(1.00, 0.35), |p, dt, _, sh| shelf(p, dt, sh)));

    // Aussenraum
    let mut car_params = wd(1.80, 4.70);
    car_params.push(flag("field", 1.0));
    v.push(ent("lib:auto", "outdoor", O, Center, car_params, |p, dt, _, sh| car(p, dt, sh)));
    v.push(ent("lib:parkfeld", "outdoor", O, Center, wd(2.50, 5.00), |p, dt, _, sh| parking(p, dt, sh)));
    v.push(ent("lib:velo", "outdoor", O, Center, wd(0.60, 1.80), |p, dt, _, sh| bike(p, dt, sh)));
    let mut wc_circle = ent("lib:wendekreis", "outdoor", O, Center, vec![len("w", 1.5, 0.5, 3.0)], |p, dt, _, sh| wheelchair_circle(p, dt, sh));
    wc_circle.def.round = true;
    v.push(wc_circle);
    v
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn bbox(g: &[G]) -> (f64, f64, f64, f64) {
        let (mut x0, mut y0, mut x1, mut y1) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
        let mut acc = |q: &Vec2| {
            x0 = x0.min(q.x);
            y0 = y0.min(q.y);
            x1 = x1.max(q.x);
            y1 = y1.max(q.y);
        };
        for s in g {
            match s {
                G::Line { a, b } => {
                    acc(a);
                    acc(b);
                }
                G::Rect { min, max } => {
                    acc(min);
                    acc(max);
                }
                G::Polyline { pts, .. } => pts.iter().for_each(&mut acc),
                G::Circle { center, r } => {
                    acc(&Vec2 { x: center.x - r, y: center.y - r });
                    acc(&Vec2 { x: center.x + r, y: center.y + r });
                }
                G::Arc { center, r, .. } => {
                    acc(&Vec2 { x: center.x - r, y: center.y - r });
                    acc(&Vec2 { x: center.x + r, y: center.y + r });
                }
                G::Ellipse { center, rx, ry, .. } => {
                    acc(&Vec2 { x: center.x - rx, y: center.y - ry });
                    acc(&Vec2 { x: center.x + rx, y: center.y + ry });
                }
                _ => panic!("unerwartete Form"),
            }
        }
        (x0, y0, x1, y1)
    }

    fn finite(g: &[G]) -> bool {
        bbox(g).0.is_finite() && bbox(g).3.is_finite()
    }

    const DETAILS: [Detail; 3] = [Detail::Grob, Detail::Mittel, Detail::Fein];

    #[test]
    fn every_object_has_geometry_at_every_detail() {
        assert!(all().len() >= 48, "{}", all().len());
        let mut ids = std::collections::HashSet::new();
        for o in all() {
            let d = o.def();
            assert!(d.id.starts_with("lib:") && ids.insert(d.id), "{}", d.id);
            for dt in DETAILS {
                let g = geometry_for(d.id, &BTreeMap::new(), dt, 1);
                assert!(!g.is_empty() && finite(&g), "{} {dt:?}", d.id);
            }
        }
    }

    #[test]
    fn detail_adds_lines_never_removes() {
        for o in all() {
            let c = |dt| geometry_for(o.def().id, &BTreeMap::new(), dt, 1).len();
            assert!(c(Detail::Grob) <= c(Detail::Mittel) && c(Detail::Mittel) <= c(Detail::Fein), "{}", o.def().id);
        }
    }

    #[test]
    fn dimensions_match_bounding_box() {
        for o in all() {
            let d = o.def();
            // Objekte ohne Zusatzgeometrie über das Mass hinaus (Stühle, Parkfeld, Spiegel, Scheinwerfer).
            if d.id.contains("tisch-") && !d.id.ends_with("-leer") && d.id != "lib:tisch-buero" || d.id == "lib:tisch-buero" {
                continue;
            }
            let g = geometry_for(d.id, &BTreeMap::new(), Detail::Mittel, 1);
            let p = d.resolve(&BTreeMap::new());
            let (x0, y0, x1, y1) = bbox(&g);
            let (ox, oy) = if d.anchor == Anchor::Wall { (-p.w / 2.0, 0.0) } else { (-p.w / 2.0, -p.d / 2.0) };
            let eps = 1e-9;
            // Auto: das Parkfeld 2.50 × 5.00 umschliesst das Fahrzeug 1.80 × 4.70.
            if d.id == "lib:auto" {
                assert!((x1 - x0 - 2.5).abs() < eps && (y1 - y0 - 5.0).abs() < eps);
                continue;
            }
            assert!((x0 - ox).abs() < eps && (x1 - (ox + p.w)).abs() < eps, "{} x {x0} {x1}", d.id);
            assert!((y0 - oy).abs() < eps && (y1 - (oy + p.d)).abs() < eps, "{} y {y0} {y1}", d.id);
        }
    }

    #[test]
    fn catalog_sizes_from_the_brief() {
        let size = |id: &str| {
            let p = find(id).unwrap().def().resolve(&BTreeMap::new());
            (p.w, p.d)
        };
        assert_eq!(size("lib:wc-wand"), (0.38, 0.55));
        assert_eq!(size("lib:kueche-zeile"), (2.75, 0.60));
        assert_eq!(size("lib:kueche-insel"), (1.65, 0.90));
        assert_eq!(size("lib:wendekreis"), (1.5, 1.5));
        assert_eq!(size("lib:tisch-rund-120"), (1.2, 1.2));
        assert_eq!(size("lib:auto"), (1.8, 4.7));
    }

    #[test]
    fn params_clamp_and_ignore_garbage() {
        let o = find("lib:lavabo").unwrap();
        let mut m = BTreeMap::new();
        m.insert("w".to_string(), json!(99.0));
        m.insert("d".to_string(), json!("x"));
        let p = o.def().resolve(&m);
        assert_eq!((p.w, p.d), (6.0, 0.45));
        m.insert("w".to_string(), json!(f64::NAN));
        assert_eq!(o.def().resolve(&m).w, 0.6);
    }

    #[test]
    fn unknown_id_draws_placeholder() {
        let g = geometry_for("lib:gibt-es-nicht", &BTreeMap::new(), Detail::Mittel, 0);
        assert_eq!(g.len(), 3);
        assert!(finite(&g));
    }

    #[test]
    fn mirror_flips_x() {
        let mut m = BTreeMap::new();
        let a = bbox(&geometry_for("lib:sofa-2", &m, Detail::Grob, 0));
        m.insert("mirror".to_string(), json!(true));
        let b = bbox(&geometry_for("lib:sofa-2", &m, Detail::Grob, 0));
        assert!((a.0 + b.2).abs() < 1e-9 && (a.2 + b.0).abs() < 1e-9 && (a.1 - b.1).abs() < 1e-9);
    }

    fn table_params(id: &str, mess: f64) -> BTreeMap<String, Value> {
        let _ = id;
        let mut m = BTreeMap::new();
        m.insert("mess".to_string(), json!(mess));
        m
    }

    #[test]
    fn mess_zero_is_regular_and_seed_is_deterministic() {
        for id in ["lib:tisch-80x140", "lib:tisch-rund-100"] {
            let a = geometry_for(id, &table_params(id, 0.0), Detail::Mittel, 1);
            let b = geometry_for(id, &table_params(id, 0.0), Detail::Mittel, 99);
            assert_eq!(a, b, "{id}: Unordnung 0 hängt nicht vom Seed ab");
            let c = geometry_for(id, &table_params(id, 1.0), Detail::Mittel, 7);
            assert_eq!(c, geometry_for(id, &table_params(id, 1.0), Detail::Mittel, 7));
            assert_ne!(c, geometry_for(id, &table_params(id, 1.0), Detail::Mittel, 8));
            assert_ne!(a, c);
        }
    }

    #[test]
    fn regular_chairs_are_symmetric_about_the_table() {
        let g = geometry_for("lib:tisch-80x140", &table_params("", 0.0), Detail::Grob, 0);
        let (x0, y0, x1, y1) = bbox(&g);
        assert!((x0 + x1).abs() < 1e-9 && (y0 + y1).abs() < 1e-9);
    }

    /// Stühle schneiden den Tisch nie: der Abstand jedes Stuhl-Eckpunkts zum Tisch bleibt > 0.
    #[test]
    fn messy_chairs_never_cut_the_table() {
        for seed in 0..60u32 {
            let g = geometry_for("lib:tisch-80x140", &table_params("", 1.0), Detail::Grob, seed);
            for s in &g {
                if let G::Polyline { pts, .. } = s {
                    for q in pts {
                        let inside = q.x > -0.7 && q.x < 0.7 && q.y > -0.4 && q.y < 0.4;
                        assert!(!inside, "seed {seed}: {q:?}");
                    }
                }
            }
            let g = geometry_for("lib:tisch-rund-120", &table_params("", 1.0), Detail::Grob, seed);
            for s in &g {
                if let G::Polyline { pts, .. } = s {
                    for q in pts {
                        assert!((q.x * q.x + q.y * q.y).sqrt() > 0.6, "seed {seed}: {q:?}");
                    }
                }
            }
        }
    }

    #[test]
    fn catalog_json_lists_all() {
        let c = catalog_json();
        assert_eq!(c["objects"].as_array().unwrap().len(), all().len());
        assert_eq!(c["categories"].as_array().unwrap().len(), 3);
    }
}
