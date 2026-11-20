//! Entourage 3D ([253], Lücke 10 in `doc/VERGLEICH-1.0.md`): einige Objekte der Bibliothek (`furniture_lib.rs`) haben neben
//! dem 2D-Symbol ein einfaches Low-Poly-Netz, prozedural aus den Parametern (kein Fremd-Asset): Person (stehend, gehend),
//! Velo, Auto, Sitzbank, Stuhl, Tische (mit ihren Stühlen). Der Grundriss zeigt weiter nur das 2D-Symbol.
//!
//! - **Netze** ([`Mesh3`]): lokal in Kastenkoordinaten (wie das 2D-Symbol, x/y in m um den Einfügepunkt, z = Höhe über dem Fuss),
//!   jedes Teil ein geschlossenes, nach aussen gewickeltes Netz (gemeinsame Eckpunkte; Test: jede Kante genau zweimal, Volumen > 0).
//! - **Aufbau** ([`B3`]): Quader, Kegelstümpfe/Lofts aus Ringen, Rohre; mehr braucht der Entourage nicht.
//! - **Platzierung** ([`placed`]): Instanz = `Drawing2DGeom::Libobj` einer Zeichnung; Fuss = Gelände an der Einfügestelle
//!   (wie bei Bäumen, `tree::bases`), sonst Unterkante des Geschosses der Zeichnung. Drehen, Spiegeln, Verschieben wie im 2D.
//!   Die Netze kommen als `RMesh` ins 3D (`model3d::emit_entourage`), in Schnitt/Ansicht/3D-Dokument, Cycles-Szene und
//!   Schattenwurf ([`clouds`]); die Klasse ist die der Zeichnung ([180]).

use crate::jsnum::{cos, sin};
use crate::model::{Drawing2DGeom, Project};
use std::collections::BTreeMap;
use std::f64::consts::TAU;

pub type V3 = [f64; 3];

/// Ein geschlossenes Teilnetz mit Farbe (sRGB 0–1).
#[derive(Clone, Debug, PartialEq)]
pub struct Mesh3 {
    pub positions: Vec<f64>,
    pub indices: Vec<u32>,
    pub color: [f64; 3],
}

impl Mesh3 {
    /// Spiegelung an der y-Achse (x → −x), Wicklung bleibt nach aussen.
    pub fn mirrored(&self) -> Mesh3 {
        let mut m = self.clone();
        m.positions.chunks_exact_mut(3).for_each(|q| q[0] = -q[0]);
        m.indices.chunks_exact_mut(3).for_each(|t| t.swap(1, 2));
        m
    }
}

/// Netz-Sammler in Kastenkoordinaten (x 0..w, y 0..d) mit Versatz zum Einfügepunkt.
pub struct B3 {
    pub ox: f64,
    pub oy: f64,
    pub parts: Vec<Mesh3>,
}

type Ring = Vec<V3>;

/// Ellipsenring (gegen den Uhrzeigersinn von oben) um (cx, cy) auf Höhe z.
fn ellipse_ring(cx: f64, cy: f64, z: f64, rx: f64, ry: f64, n: usize) -> Ring {
    (0..n)
        .map(|i| {
            let t = TAU * i as f64 / n as f64;
            [cx + rx * cos(t), cy + ry * sin(t), z]
        })
        .collect()
}

/// Rechteckring (gegen den Uhrzeigersinn) auf Höhe z.
fn rect_ring(x0: f64, y0: f64, x1: f64, y1: f64, z: f64) -> Ring {
    vec![[x0, y0, z], [x1, y0, z], [x1, y1, z], [x0, y1, z]]
}

impl B3 {
    pub fn new(ox: f64, oy: f64) -> B3 {
        B3 { ox, oy, parts: Vec::new() }
    }

    /// Körper aus Ringen gleicher Punktzahl (gegen den Uhrzeigersinn von oben, von unten nach oben), oben und unten mit
    /// einem Fächer um den Schwerpunkt geschlossen. Entartete Eingaben (< 2 Ringe, < 3 Punkte, NaN) ergeben nichts.
    fn loft(&mut self, rings: Vec<Ring>, color: [f64; 3]) {
        let n = rings.first().map_or(0, |r| r.len());
        if rings.len() < 2 || n < 3 || rings.iter().any(|r| r.len() != n || r.iter().any(|q| q.iter().any(|v| !v.is_finite()))) {
            return;
        }
        let mut positions: Vec<f64> = Vec::with_capacity((rings.len() * n + 2) * 3);
        for r in &rings {
            for q in r {
                positions.extend([q[0] + self.ox, q[1] + self.oy, q[2]]);
            }
        }
        let nn = n as u32;
        let mut indices: Vec<u32> = Vec::new();
        for i in 0..rings.len() as u32 - 1 {
            for j in 0..nn {
                let k = (j + 1) % nn;
                let (a, b, c, d) = (i * nn + j, i * nn + k, (i + 1) * nn + k, (i + 1) * nn + j);
                indices.extend([a, b, c, a, c, d]);
            }
        }
        let top = (rings.len() as u32 - 1) * nn;
        if n == 4 {
            // Rechteckringe: Deckel aus zwei Dreiecken (Quader = 12 Dreiecke).
            indices.extend([0, 2, 1, 0, 3, 2, top, top + 1, top + 2, top, top + 2, top + 3]);
        } else {
            let centre = |r: &Ring| {
                let k = r.len() as f64;
                [r.iter().map(|q| q[0]).sum::<f64>() / k + self.ox, r.iter().map(|q| q[1]).sum::<f64>() / k + self.oy, r[0][2]]
            };
            let (cb, ct) = (centre(&rings[0]), centre(&rings[rings.len() - 1]));
            let (ib, it) = ((rings.len() * n) as u32, (rings.len() * n + 1) as u32);
            positions.extend(cb);
            positions.extend(ct);
            for j in 0..nn {
                let k = (j + 1) % nn;
                indices.extend([ib, k, j]);
                indices.extend([it, top + j, top + k]);
            }
        }
        self.parts.push(Mesh3 { positions, indices, color });
    }

    /// Quader x0..x1, y0..y1, z0..z1.
    pub fn cuboid(&mut self, x0: f64, y0: f64, z0: f64, x1: f64, y1: f64, z1: f64, color: [f64; 3]) {
        self.loft(vec![rect_ring(x0, y0, x1, y1, z0), rect_ring(x0, y0, x1, y1, z1)], color);
    }

    /// Um (cx, cy) um `rot` verdrehter Quader; lokal lx0..lx1 × ly0..ly1 (relativ zu (cx, cy)), Höhe z0..z1.
    #[allow(clippy::too_many_arguments)]
    pub fn cuboid_rot(&mut self, cx: f64, cy: f64, rot: f64, l: [f64; 4], z0: f64, z1: f64, color: [f64; 3]) {
        let (c, s) = (cos(rot), sin(rot));
        let ring = |z: f64| -> Ring { rect_ring(l[0], l[1], l[2], l[3], z).into_iter().map(|q| [cx + q[0] * c - q[1] * s, cy + q[0] * s + q[1] * c, z]).collect() };
        self.loft(vec![ring(z0), ring(z1)], color);
    }

    /// Rechteck-Stapel `(z, x0, y0, x1, y1)` von unten nach oben (Karosserie, Kabine).
    pub fn stack(&mut self, rings: &[(f64, f64, f64, f64, f64)], color: [f64; 3]) {
        self.loft(rings.iter().map(|r| rect_ring(r.1, r.2, r.3, r.4, r.0)).collect(), color);
    }

    /// Körper aus Ellipsen `(z, cx, cy, rx, ry)` mit `n` Seiten (Rumpf, Beine, Kopf, runde Tischplatte).
    pub fn body(&mut self, rings: &[(f64, f64, f64, f64, f64)], n: usize, color: [f64; 3]) {
        self.loft(rings.iter().map(|r| ellipse_ring(r.1, r.2, r.0, r.3, r.4, n.max(3))).collect(), color);
    }

    /// Rohr (Zylinder) von `a` nach `b` mit Radius `r` und `n` Seiten, beide Enden geschlossen.
    pub fn tube(&mut self, a: V3, b: V3, r: f64, n: usize, color: [f64; 3]) {
        let ax = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        let len = (ax[0] * ax[0] + ax[1] * ax[1] + ax[2] * ax[2]).sqrt();
        if !(len > 1e-9 && r > 0.0) {
            return;
        }
        let u = [ax[0] / len, ax[1] / len, ax[2] / len];
        // u1 ⟂ u (aus der Lotrechten), u2 = u × u1, damit u1 × u2 = u: Ring gegen den Uhrzeigersinn, von `a` aus gesehen nach `b`.
        let up = if u[2].abs() < 0.9 { [0.0, 0.0, 1.0] } else { [1.0, 0.0, 0.0] };
        let cr = |p: V3, q: V3| [p[1] * q[2] - p[2] * q[1], p[2] * q[0] - p[0] * q[2], p[0] * q[1] - p[1] * q[0]];
        let u1 = cr(up, u);
        let l1 = (u1[0] * u1[0] + u1[1] * u1[1] + u1[2] * u1[2]).sqrt();
        let u1 = [u1[0] / l1, u1[1] / l1, u1[2] / l1];
        let u2 = cr(u, u1);
        let n = n.max(3);
        let ring = |c: V3| -> Ring {
            (0..n)
                .map(|i| {
                    let t = TAU * i as f64 / n as f64;
                    let (ct, st) = (cos(t) * r, sin(t) * r);
                    [c[0] + u1[0] * ct + u2[0] * st, c[1] + u1[1] * ct + u2[1] * st, c[2] + u1[2] * ct + u2[2] * st]
                })
                .collect()
        };
        self.loft(vec![ring(a), ring(b)], color);
    }
}

// ── Objekte ──────────────────────────────────────────────────────────────────

const SKIN: [f64; 3] = [0.80, 0.68, 0.58];
const SHIRT: [f64; 3] = [0.74, 0.72, 0.68];
const TROUSERS: [f64; 3] = [0.34, 0.36, 0.42];
const WOOD: [f64; 3] = [0.66, 0.52, 0.36];
const STEEL: [f64; 3] = [0.30, 0.31, 0.33];
const CAR_BODY: [f64; 3] = [0.68, 0.70, 0.74];
const TYRE: [f64; 3] = [0.11, 0.11, 0.12];
/// Stuhl.
pub const CHAIR_RGB: [f64; 3] = [0.36, 0.36, 0.39];
/// Normhöhe der Person (m): Höhe 1.75 = Massstab 1.
pub const PERSON_H: f64 = 1.75;

use crate::furniture_lib::Params;

/// Person, stehend oder gehend (Schritt: Fuss ±0.2 m vor/zurück, Arme gegengleich). Alles mit `k = h / 1.75` skaliert.
pub fn person(p: &Params, walking: bool, b: &mut B3) {
    let k = (p.get("h") / PERSON_H).max(0.1);
    let (cx, cy) = (p.w / 2.0, p.d / 2.0);
    for s in [-1.0_f64, 1.0] {
        let swing = if walking { 0.2 * s * k } else { 0.0 };
        let x = cx + s * 0.095 * k;
        // Bein: Fuss (Zehen vor), Knöchel, Knie, Hüfte; die Mitte wandert mit der Höhe von `swing` nach 0.
        let leg: [(f64, f64, f64, f64); 4] = [(0.0, 0.052, 0.11, 1.0), (0.07, 0.048, 0.055, 1.0), (0.46, 0.068, 0.075, 0.5), (0.90, 0.09, 0.105, 0.0)];
        let rings: Vec<_> = leg.iter().map(|&(z, rx, ry, w)| (z * k, x, cy + swing * w + if z == 0.0 { 0.045 * k } else { 0.0 }, rx * k, ry * k)).collect();
        b.body(&rings, 10, TROUSERS);
        // Arm: Schulter → Hand, gegen das gleichseitige Bein.
        let (sh, hand) = ([cx + s * 0.235 * k, cy, 1.43 * k], [cx + s * 0.27 * k, cy - swing * 1.1, 0.80 * k]);
        b.tube(sh, hand, 0.04 * k, 8, SHIRT);
    }
    let torso: [(f64, f64, f64); 7] = [(0.84, 0.16, 0.10), (0.95, 0.165, 0.105), (1.10, 0.15, 0.10), (1.30, 0.19, 0.115), (1.45, 0.215, 0.10), (1.50, 0.17, 0.085), (1.54, 0.055, 0.055)];
    b.body(&torso.iter().map(|&(z, rx, ry)| (z * k, cx, cy, rx * k, ry * k)).collect::<Vec<_>>(), 12, SHIRT);
    let head: [(f64, f64, f64); 5] = [(1.54, 0.05, 0.05), (1.60, 0.08, 0.09), (1.67, 0.095, 0.10), (1.73, 0.07, 0.08), (PERSON_H, 0.03, 0.035)];
    b.body(&head.iter().map(|&(z, rx, ry)| (z * k, cx, cy + 0.01 * k, rx * k, ry * k)).collect::<Vec<_>>(), 10, SKIN);
}

pub fn person_standing(p: &Params, _chairs: &[(f64, f64, f64)], b: &mut B3) {
    person(p, false, b);
}

pub fn person_walking(p: &Params, _chairs: &[(f64, f64, f64)], b: &mut B3) {
    person(p, true, b);
}

/// Stuhl mit Sitzfläche `w × d` um (cx, cy), Rückenlehne bei lokal −y (wie das 2D-Symbol), gedreht um `rot`.
pub fn chair(b: &mut B3, cx: f64, cy: f64, rot: f64, w: f64, d: f64) {
    let (hw, hd) = (w / 2.0, d / 2.0);
    let seat = 0.45;
    b.cuboid_rot(cx, cy, rot, [-hw, -hd, hw, hd], seat - 0.04, seat, CHAIR_RGB);
    for (lx, ly) in [(-hw + 0.02, -hd + 0.02), (hw - 0.05, -hd + 0.02), (-hw + 0.02, hd - 0.05), (hw - 0.05, hd - 0.05)] {
        b.cuboid_rot(cx, cy, rot, [lx, ly, lx + 0.03, ly + 0.03], 0.0, seat - 0.04, CHAIR_RGB);
    }
    b.cuboid_rot(cx, cy, rot, [-hw, -hd, hw, -hd + 0.04], seat, 0.90, CHAIR_RGB);
}

/// Einzelner Stuhl (Objekt `lib:stuhl`).
pub fn single_chair(p: &Params, _chairs: &[(f64, f64, f64)], b: &mut B3) {
    chair(b, p.w / 2.0, p.d / 2.0, 0.0, p.w, p.d);
}

/// Rechteckiger Tisch (Platte 4 cm, vier Beine) mit den Stühlen aus dem 2D-Symbol.
pub fn rect_table(p: &Params, chairs: &[(f64, f64, f64)], b: &mut B3) {
    let (w, d, h) = (p.w, p.d, p.get("h"));
    b.cuboid(0.0, 0.0, h - 0.04, w, d, h, WOOD);
    let l = 0.06_f64.min(w / 4.0).min(d / 4.0);
    for (x, y) in [(l, l), (w - l - 0.05, l), (l, d - l - 0.05), (w - l - 0.05, d - l - 0.05)] {
        b.cuboid(x, y, 0.0, x + 0.05, y + 0.05, h - 0.04, WOOD);
    }
    for &(cx, cy, rot) in chairs {
        chair(b, cx, cy, rot, 0.45, 0.50);
    }
}

/// Runder Tisch (Platte, Mittelfuss mit Teller) mit den Stühlen.
pub fn round_table(p: &Params, chairs: &[(f64, f64, f64)], b: &mut B3) {
    let (r, h) = (p.w / 2.0, p.get("h"));
    b.body(&[(h - 0.04, r, r, r, r), (h, r, r, r, r)], 24, WOOD);
    b.body(&[(0.0, r, r, r.min(0.3), r.min(0.3)), (0.03, r, r, r.min(0.3), r.min(0.3))], 16, WOOD);
    b.body(&[(0.03, r, r, 0.05, 0.05), (h - 0.04, r, r, 0.05, 0.05)], 8, WOOD);
    for &(cx, cy, rot) in chairs {
        chair(b, cx, cy, rot, 0.45, 0.50);
    }
}

/// Sitzbank: Sitz (5 cm), Rückenlehne (40 cm hoch bei y = 0), zwei Stahlfüsse. `h` = Sitzhöhe.
pub fn bench(p: &Params, _chairs: &[(f64, f64, f64)], b: &mut B3) {
    let (w, d, h) = (p.w, p.d, p.get("h"));
    b.cuboid(0.0, 0.0, h - 0.05, w, d, h, WOOD);
    b.cuboid(0.0, 0.0, h, w, 0.05_f64.min(d / 2.0), h + 0.40, WOOD);
    let l = 0.08_f64.min(w / 4.0);
    for x in [l, w - l - 0.05] {
        b.cuboid(x, 0.05_f64.min(d / 4.0), 0.0, x + 0.05, d - 0.05_f64.min(d / 4.0), h - 0.05, STEEL);
    }
}

/// Auto (Kleinwagen/Kombi): Unterbau mit Abschrägung, Kabine mit geneigten Scheiben, vier Räder; Front bei +y. `h` = Dachhöhe.
pub fn car(p: &Params, _chairs: &[(f64, f64, f64)], b: &mut B3) {
    let (w, d, h) = (p.w, p.d, p.get("h"));
    let belt = (0.62 * h).max(0.5);
    b.stack(&[(0.18, 0.10, 0.15, w - 0.10, d - 0.15), (0.32, 0.0, 0.0, w, d), (belt - 0.05, 0.0, 0.0, w, d), (belt, 0.03, 0.05, w - 0.03, d - 0.05)], CAR_BODY);
    b.stack(&[(belt - 0.01, 0.06, d * 0.22, w - 0.06, d * 0.72), (h, 0.16, d * 0.30, w - 0.16, d * 0.62)], CAR_BODY);
    let r = 0.31_f64.min(h * 0.25);
    for y in [0.80_f64.min(d * 0.25), (d - 1.0).max(d * 0.75)] {
        for x in [0.02, w - 0.24] {
            b.tube([x, y, r], [x + 0.22, y, r], r, 14, TYRE);
        }
    }
}

/// Velo: zwei Räder (Scheiben), Rahmen aus Rohren, Sattel, Lenker; Front bei +y. `h` = Höhe des Lenkers.
pub fn bike(p: &Params, _chairs: &[(f64, f64, f64)], b: &mut B3) {
    let (w, d, h) = (p.w, p.d, p.get("h"));
    let cx = w / 2.0;
    let wr = 0.33_f64.min(h * 0.45);
    let (yr, yf) = (0.04 + wr, d - 0.04 - wr);
    for y in [yr, yf] {
        b.tube([cx - 0.015, y, wr], [cx + 0.015, y, wr], wr, 16, TYRE);
    }
    let fr = 0.017;
    let bb = [cx, d * 0.43, 0.30_f64.min(h * 0.4)];
    let seat = [cx, d * 0.37, 0.84 * h];
    let head_b = [cx, d - 0.55, h - 0.30_f64.min(h * 0.4)];
    let head_t = [cx, d - 0.51, h - fr];
    let seat_top = [cx, d * 0.37, 0.80 * h];
    for (a, c) in [(bb, seat), (seat_top, [head_b[0], head_b[1], head_b[2] + 0.03]), (bb, head_b), (bb, [cx, yr, wr]), (seat_top, [cx, yr, wr]), (head_b, [cx, yf, wr]), (head_b, head_t)] {
        b.tube(a, c, fr, 6, STEEL);
    }
    b.tube([cx - 0.27, head_t[1], h - fr], [cx + 0.27, head_t[1], h - fr], fr, 8, STEEL);
    b.cuboid(cx - 0.06, seat[1] - 0.12, 0.84 * h, cx + 0.06, seat[1] + 0.08, 0.84 * h + 0.04, TYRE);
}

/// [253] IFC: Personen, Velo und Auto sind Entourage, keine Bauteile (nur mit Option „Entourage mitexportieren").
pub fn is_entourage(lib_id: &str) -> bool {
    matches!(lib_id, "lib:person-stehend" | "lib:person-gehend" | "lib:velo" | "lib:auto")
}

/// [253] IFC-Name aus der Katalog-Id (`lib:tisch-rund-120` → „Tisch rund 120") und `IfcFurnitureTypeEnum` (IFC4).
pub fn ifc_name_and_type(lib_id: &str) -> (String, &'static str) {
    let raw = lib_id.strip_prefix("lib:").unwrap_or(lib_id).replace('-', " ");
    let mut cs = raw.chars();
    let name = cs.next().map_or(String::new(), |c| c.to_uppercase().chain(cs).collect());
    let kind = if lib_id.starts_with("lib:tisch") {
        "TABLE"
    } else if lib_id.starts_with("lib:stuhl") {
        "CHAIR"
    } else {
        "NOTDEFINED"
    };
    (name, kind)
}

/// Alle Platzierungen einer Instanz in Weltkoordinaten (Modell-x/y, z = absolute Höhe).
fn place(meshes: &[Mesh3], at: [f64; 2], rot: f64, base: f64) -> Vec<Mesh3> {
    let (c, s) = (cos(rot), sin(rot));
    meshes
        .iter()
        .map(|m| Mesh3 {
            positions: m.positions.chunks_exact(3).flat_map(|q| [at[0] + q[0] * c - q[1] * s, at[1] + q[0] * s + q[1] * c, base + q[2]]).collect(),
            indices: m.indices.clone(),
            color: m.color,
        })
        .collect()
}

/// Netze aller Bibliotheks-Instanzen mit 3D-Netz: `(Index in Project::drawings2d, Teile in Weltkoordinaten)`.
/// Unbekannte Ids, Objekte ohne Netz und unbrauchbare Lagen entfallen.
pub fn placed(p: &Project) -> Vec<(usize, Vec<Mesh3>)> {
    let none = BTreeMap::new();
    let mut out = Vec::new();
    // Gelände einmal holen, wenn es Instanzen gibt (wie `tree::bases`: sichtbares Netz inkl. Baugruben).
    let mut site: Option<Option<std::rc::Rc<crate::excavation::SiteTerrain>>> = None;
    for (i, d) in p.drawings2d.iter().enumerate() {
        let Drawing2DGeom::Libobj { lib_id, at, rotation, params, seed } = &d.geom else { continue };
        if !(at.x.is_finite() && at.y.is_finite() && rotation.is_finite()) {
            continue;
        }
        let local = crate::furniture_lib::geometry3d_for(lib_id, params.as_ref().unwrap_or(&none), seed.unwrap_or(0));
        if local.is_empty() {
            continue;
        }
        let floor = p.floor(&d.level_id).map_or(0.0, |f| f.base_elevation.unwrap_or(0.0));
        let st = site.get_or_insert_with(|| crate::excavation::terrains(p).into_iter().next().map(|t| crate::excavation::site_terrain(p, t)).filter(|st| !st.current().tris.is_empty()));
        let ground = st.as_ref().and_then(|st| st.index_current().z_at(at.x, at.y).map(|z| z - st.datum)).filter(|z| z.is_finite());
        out.push((i, place(&local, [at.x, at.y], *rotation, ground.unwrap_or(floor))));
    }
    out
}

/// [311] Die Teilnetze der Entourage als `ImportedMesh` (Klasse und Id der Zeichnung, Farbe des Teils), Weltkoordinaten.
pub fn imported_meshes(p: &Project) -> Vec<crate::model::ImportedMesh> {
    imported_meshes_where(p, &|_| true)
}

/// [312] Personen: im Schnitt nur Silhouette (Umriss der Teile vereinigt), nie Netzkanten.
pub fn is_person(lib_id: &str) -> bool {
    matches!(lib_id, "lib:person-stehend" | "lib:person-gehend")
}

/// Wie [`imported_meshes`], nur für Instanzen mit `keep(lib_id)`.
pub fn imported_meshes_where(p: &Project, keep: &dyn Fn(&str) -> bool) -> Vec<crate::model::ImportedMesh> {
    let hex = |c: [f64; 3]| format!("#{:02x}{:02x}{:02x}", (c[0] * 255.0).round() as u8, (c[1] * 255.0).round() as u8, (c[2] * 255.0).round() as u8);
    let mut out = Vec::new();
    for (i, parts) in placed(p) {
        let d = &p.drawings2d[i];
        if matches!(&d.geom, Drawing2DGeom::Libobj { lib_id, .. } if !keep(lib_id)) {
            continue;
        }
        for m in parts {
            out.push(crate::model::ImportedMesh {
                id: d.id.clone(),
                name: d.id.clone(),
                category_code: d.category_code.clone(),
                color: Some(hex(m.color)),
                positions: m.positions,
                indices: m.indices.iter().map(|&k| k as f64).collect(),
                ..Default::default()
            });
        }
    }
    out
}

/// Kopie des Projekts für Ansichten, die nur Netze aus `Project::context` kennen (3D-Dokument, `plan/axo.rs`): die Teilnetze der
/// Entourage als `ImportedMesh` mit Klasse und Id der Zeichnung angehängt; `context = false` lässt die übrigen Netze des Kontexts
/// weg (nur Entourage). [285] Auch die Bäume (`Project.trees`, Stamm + Krone wie im 3D) kommen so hinein. `None`, wenn das
/// Projekt weder Entourage noch Bäume hat.
pub fn with_context_meshes(p: &Project, context: bool) -> Option<Project> {
    let placed = imported_meshes(p);
    let trees = crate::tree::geoms(p);
    if placed.is_empty() && trees.is_empty() {
        return None;
    }
    let mut q = p.clone();
    let mut ctx = q.context.take().unwrap_or_default();
    if !context {
        ctx.retain(|c| !matches!(c, crate::model::ContextObject::ImportedMesh(_)));
    }
    let hex = |c: [f64; 3]| format!("#{:02x}{:02x}{:02x}", (c[0] * 255.0).round() as u8, (c[1] * 255.0).round() as u8, (c[2] * 255.0).round() as u8);
    ctx.extend(placed.into_iter().map(crate::model::ContextObject::ImportedMesh));
    let list = p.trees.as_deref().unwrap_or(&[]);
    for (i, g) in trees {
        let t = &list[i];
        let (trunk, crown) = crate::tree::colors(t);
        for ((positions, indices), rgb) in [(g.trunk_mesh(8), trunk), (g.crown_mesh(8, 12), crown)] {
            ctx.push(crate::model::ContextObject::ImportedMesh(crate::model::ImportedMesh {
                id: t.id.clone(),
                name: t.id.clone(),
                category_code: t.category_code.clone(),
                color: Some(hex(rgb)),
                positions,
                indices: indices.iter().map(|&k| k as f64).collect(),
                ..Default::default()
            }));
        }
    }
    q.context = Some(ctx);
    Some(q)
}

/// Schattenwerfer: je Teilnetz die Eckpunkte als Wolke (konvexe Hülle ihres Schattens), wie die Baumkrone.
pub fn clouds(p: &Project) -> Vec<Vec<[f64; 3]>> {
    placed(p).into_iter().flat_map(|(_, parts)| parts).map(|m| m.positions.chunks_exact(3).map(|q| [q[0], q[1], q[2]]).collect()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::furniture_lib::{self, all};
    use serde_json::json;
    use std::collections::HashMap;

    fn params(kv: &[(&str, f64)]) -> BTreeMap<String, serde_json::Value> {
        kv.iter().map(|(k, v)| (k.to_string(), json!(v))).collect()
    }

    /// Jede Kante kommt genau einmal je Richtung vor (geschlossen, orientiert) und das Volumen ist positiv (Wicklung nach aussen).
    fn assert_closed(m: &Mesh3, what: &str) {
        let mut edges: HashMap<(u32, u32), i32> = HashMap::new();
        for t in m.indices.chunks_exact(3) {
            for (a, b) in [(t[0], t[1]), (t[1], t[2]), (t[2], t[0])] {
                *edges.entry((a, b)).or_default() += 1;
            }
        }
        for (&(a, b), &n) in &edges {
            assert_eq!(n, 1, "{what}: Kante {a}->{b} {n}x");
            assert_eq!(edges.get(&(b, a)), Some(&1), "{what}: Kante {a}->{b} ohne Gegenkante");
        }
        let q = |i: u32| {
            let i = i as usize * 3;
            [m.positions[i], m.positions[i + 1], m.positions[i + 2]]
        };
        let vol: f64 = m
            .indices
            .chunks_exact(3)
            .map(|t| {
                let (a, b, c) = (q(t[0]), q(t[1]), q(t[2]));
                (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6.0
            })
            .sum();
        assert!(vol > 1e-7, "{what}: Volumen {vol}");
        assert!(m.positions.iter().all(|v| v.is_finite()));
    }

    fn zrange(parts: &[Mesh3]) -> (f64, f64) {
        let z: Vec<f64> = parts.iter().flat_map(|m| m.positions.chunks_exact(3).map(|q| q[2])).collect();
        (z.iter().cloned().fold(f64::INFINITY, f64::min), z.iter().cloned().fold(f64::NEG_INFINITY, f64::max))
    }

    fn tris(parts: &[Mesh3]) -> usize {
        parts.iter().map(|m| m.indices.len() / 3).sum()
    }

    fn with_3d() -> Vec<&'static str> {
        all().iter().filter(|o| o.has_3d()).map(|o| o.def().id).collect()
    }

    #[test]
    fn objects_with_3d_are_the_entourage_set() {
        let ids = with_3d();
        for want in ["lib:person-stehend", "lib:person-gehend", "lib:velo", "lib:auto", "lib:sitzbank", "lib:stuhl", "lib:tisch-80x140", "lib:tisch-rund-120"] {
            assert!(ids.contains(&want), "{want}");
        }
        // Sanitär, Küche, Betten … bleiben 2D.
        assert!(!ids.contains(&"lib:wc-wand") && !ids.contains(&"lib:bett-90"));
    }

    #[test]
    fn every_3d_part_is_closed_with_outward_winding() {
        for id in with_3d() {
            for seed in [0, 5] {
                let g = furniture_lib::geometry3d_for(id, &params(&[("mess", 1.0)]), seed);
                assert!(!g.is_empty(), "{id}");
                for (i, m) in g.iter().enumerate() {
                    assert_closed(m, &format!("{id}[{i}]"));
                    assert_closed(&m.mirrored(), &format!("{id}[{i}] gespiegelt"));
                }
                let (lo, _) = zrange(&g);
                assert!(lo > -1e-9, "{id}: unter dem Fuss {lo}");
            }
        }
    }

    #[test]
    fn height_follows_the_parameter() {
        let top = |id: &str, h: Option<f64>| {
            let m = h.map_or_else(BTreeMap::new, |h| params(&[("h", h)]));
            zrange(&furniture_lib::geometry3d_for(id, &m, 0)).1
        };
        // Person: Vorgabe 1.75 m, einstellbar.
        assert!((top("lib:person-stehend", None) - 1.75).abs() < 1e-9);
        assert!((top("lib:person-gehend", None) - 1.75).abs() < 1e-9);
        assert!((top("lib:person-stehend", Some(1.5)) - 1.5).abs() < 1e-9);
        assert!((top("lib:person-stehend", Some(9.0)) - 2.2).abs() < 1e-9, "auf die Grenze geklemmt");
        // Auto: Dachhöhe, Velo: Lenker, Bank: Rückenlehne = Sitzhöhe + 0.40, Tisch: Plattenhöhe.
        assert!((top("lib:auto", None) - 1.45).abs() < 1e-9);
        assert!((top("lib:velo", None) - 1.05).abs() < 1e-9, "{}", top("lib:velo", None));
        assert!((top("lib:sitzbank", None) - 0.85).abs() < 1e-9);
        assert!((top("lib:sitzbank", Some(0.5)) - 0.90).abs() < 1e-9);
        assert!((top("lib:tisch-80x140-leer", None) - 0.75).abs() < 1e-9);
        assert!((top("lib:tisch-rund-100-leer", Some(0.9)) - 0.9).abs() < 1e-9);
        // Mit Stühlen bleibt die Lehne (0.90) der höchste Punkt eines niedrigen Tischs.
        assert!((top("lib:tisch-80x140", None) - 0.90).abs() < 1e-9);
    }

    #[test]
    fn part_counts_and_triangle_budget() {
        let n = |id: &str, kv: &[(&str, f64)]| furniture_lib::geometry3d_for(id, &params(kv), 0).len();
        // Tisch: Platte + 4 Beine; je Stuhl Sitz + 4 Beine + Lehne = 6 Teile.
        assert_eq!(n("lib:tisch-80x140-leer", &[]), 5);
        assert_eq!(n("lib:tisch-80x140", &[]), 5 + 6 * 6);
        assert_eq!(n("lib:tisch-90x180", &[]), 5 + 8 * 6);
        assert_eq!(n("lib:tisch-80x140", &[("n", 2.0)]), 5 + 2 * 6);
        assert_eq!(n("lib:tisch-rund-100", &[]), 3 + 4 * 6);
        assert_eq!(n("lib:stuhl", &[]), 6);
        // Person: 2 Beine, 2 Arme, Rumpf, Kopf.
        assert_eq!(n("lib:person-stehend", &[]), 6);
        assert_eq!(n("lib:auto", &[]), 2 + 4);
        assert_eq!(n("lib:sitzbank", &[]), 4);
        // Wenige Dreiecke je Objekt (Low-Poly).
        for (id, max) in [("lib:person-stehend", 500), ("lib:person-gehend", 500), ("lib:auto", 300), ("lib:velo", 400), ("lib:sitzbank", 80), ("lib:tisch-90x180", 700)] {
            let t = tris(&furniture_lib::geometry3d_for(id, &BTreeMap::new(), 0));
            assert!(t > 0 && t <= max, "{id}: {t} Dreiecke");
        }
    }

    #[test]
    fn walking_has_a_stride_standing_has_not() {
        let ext = |id: &str| {
            let g = furniture_lib::geometry3d_for(id, &BTreeMap::new(), 0);
            let ys: Vec<f64> = g.iter().flat_map(|m| m.positions.chunks_exact(3).map(|q| q[1])).collect();
            ys.iter().cloned().fold(f64::NEG_INFINITY, f64::max) - ys.iter().cloned().fold(f64::INFINITY, f64::min)
        };
        assert!(ext("lib:person-gehend") > ext("lib:person-stehend") + 0.3);
    }

    #[test]
    fn chairs_follow_the_2d_layout_and_the_seed() {
        let xs = |seed: u32| -> Vec<f64> { furniture_lib::geometry3d_for("lib:tisch-80x140", &params(&[("mess", 1.0)]), seed).iter().flat_map(|m| m.positions.clone()).collect() };
        assert_eq!(xs(3), xs(3));
        assert_ne!(xs(3), xs(4));
        // Regelmässig: symmetrisch zum Einfügepunkt (Mitte), wie das 2D-Symbol.
        let g = furniture_lib::geometry3d_for("lib:tisch-80x140", &BTreeMap::new(), 0);
        let (mut x0, mut x1) = (f64::MAX, f64::MIN);
        for m in &g {
            for q in m.positions.chunks_exact(3) {
                x0 = x0.min(q[0]);
                x1 = x1.max(q[0]);
            }
        }
        assert!((x0 + x1).abs() < 1e-9);
    }

    #[test]
    fn mirror_flips_x_and_unknown_or_2d_objects_have_no_mesh() {
        let bx = |m: &BTreeMap<String, serde_json::Value>| {
            let g = furniture_lib::geometry3d_for("lib:person-gehend", m, 0);
            let xs: Vec<f64> = g.iter().flat_map(|m| m.positions.chunks_exact(3).map(|q| q[0])).collect();
            (xs.iter().cloned().fold(f64::INFINITY, f64::min), xs.iter().cloned().fold(f64::NEG_INFINITY, f64::max))
        };
        let (a, b) = (bx(&BTreeMap::new()), bx(&params(&[("mirror", 1.0)])));
        assert!((a.0 + b.1).abs() < 1e-9 && (a.1 + b.0).abs() < 1e-9);
        assert!(furniture_lib::geometry3d_for("lib:gibt-es-nicht", &BTreeMap::new(), 0).is_empty());
        assert!(furniture_lib::geometry3d_for("lib:wc-wand", &BTreeMap::new(), 0).is_empty());
    }

    fn project(drawings: serde_json::Value) -> Project {
        serde_json::from_value(json!({
            "id": "p", "name": "t", "lineStyles": [], "hatches": [], "components": [], "wallTypes": [], "layers": [], "openings": [], "walls": [],
            "drawingLevels": [{"id": "F", "name": "EG", "kind": "floor", "visible": true, "locked": false, "floorHeight": 3.0, "baseElevation": 2.0}],
            "drawings2d": drawings
        }))
        .unwrap()
    }

    fn lib(id: &str, lib_id: &str, x: f64, y: f64, rot: f64) -> serde_json::Value {
        json!({"id": id, "type": "drawing2d", "levelId": "F", "categoryCode": "24", "geom": {"shape": "libobj", "libId": lib_id, "at": {"x": x, "y": y}, "rotation": rot}})
    }

    #[test]
    fn placement_uses_floor_height_position_and_rotation() {
        let p = project(json!([lib("a", "lib:person-stehend", 10.0, 20.0, 0.0), lib("b", "lib:person-stehend", 10.0, 20.0, std::f64::consts::FRAC_PI_2), lib("c", "lib:wc-wand", 0.0, 0.0, 0.0), lib("d", "lib:unbekannt", 0.0, 0.0, 0.0)]));
        let r = placed(&p);
        assert_eq!(r.iter().map(|x| x.0).collect::<Vec<_>>(), vec![0, 1], "nur Objekte mit Netz, Index in drawings2d");
        let (lo, hi) = zrange(&r[0].1);
        assert!((lo - 2.0).abs() < 1e-9 && (hi - 3.75).abs() < 1e-9, "{lo} {hi}");
        let bb = |parts: &[Mesh3]| {
            let (mut x0, mut x1, mut y0, mut y1) = (f64::MAX, f64::MIN, f64::MAX, f64::MIN);
            for m in parts {
                for q in m.positions.chunks_exact(3) {
                    x0 = x0.min(q[0]);
                    x1 = x1.max(q[0]);
                    y0 = y0.min(q[1]);
                    y1 = y1.max(q[1]);
                }
            }
            (x0, x1, y0, y1)
        };
        let (a, b) = (bb(&r[0].1), bb(&r[1].1));
        assert!(((a.0 + a.1) / 2.0 - 10.0).abs() < 0.05 && ((a.2 + a.3) / 2.0 - 20.0).abs() < 0.05, "um den Einfügepunkt");
        // 90° gedreht: Breite und Tiefe tauschen.
        assert!(((a.1 - a.0) - (b.3 - b.2)).abs() < 1e-9 && ((a.3 - a.2) - (b.1 - b.0)).abs() < 1e-9);
        // Schatten: je Teilnetz eine Wolke.
        assert_eq!(clouds(&p).len(), 12);
    }

    #[test]
    fn entourage_casts_a_shadow() {
        let p = project(json!([lib("a", "lib:person-stehend", 0.0, 0.0, 0.0)]));
        let sh = crate::sun::shadow_polygons_project(&p, crate::sun::SunPosition { azimuth: 180.0, elevation: 30.0 }, None);
        let ys: Vec<f64> = sh.iter().flatten().flatten().map(|q| q[1]).collect();
        let (lo, hi) = (ys.iter().cloned().fold(f64::INFINITY, f64::min), ys.iter().cloned().fold(f64::NEG_INFINITY, f64::max));
        // Sonne im Süden, 30°: 1.75 m / tan 30° ≈ 3.03 m nach Norden (+y).
        // Der Fuss steht bei +2.0 m (Geschoss-UK): Schatten auf z = 0 beginnt 2 / tan 30° ≈ 3.46 m nördlich.
        assert!((lo - 3.46).abs() < 0.3 && (hi - lo - 3.03).abs() < 0.4, "{lo} {hi}");
        assert!(crate::sun::shadow_polygons_project(&project(json!([])), crate::sun::SunPosition { azimuth: 180.0, elevation: 30.0 }, None).is_empty());
    }

    #[test]
    fn nonsense_position_gives_nothing() {
        let p = project(json!([lib("a", "lib:auto", 1.0, 2.0, 0.0)]));
        let mut q = p.clone();
        if let Drawing2DGeom::Libobj { rotation, .. } = &mut q.drawings2d[0].geom {
            *rotation = f64::NAN;
        }
        assert!(placed(&q).is_empty());
        assert_eq!(placed(&p).len(), 1);
    }
}
