//! Flächen- und Kennzahl-Nachweise ([70]): Flächentabelle (Flächenarten nach SIA 416) und
//! IVHB-Kennziffern.
//!
//! # Flächenarten (SIA 416, Ausgabe 2003, „Flächen und Volumen von Gebäuden")
//!
//! ```text
//!   GF  Geschossfläche   = NGF + KF          (allseitig umschlossene, überdeckte Grundrissebenen)
//!   NGF Nettogeschossfl. = NF + VF + FF
//!   NF  Nutzfläche       = HNF + NNF
//!   KF  Konstruktionsfläche (Wände, Stützen, Schächte-Wandungen)
//!   AGF Aussengeschossfläche — NICHT Teil der GF, wird separat ausgewiesen
//!   GV  Gebäudevolumen
//! ```
//!
//! Grundlage der Rechnung ist die *Flächenart* eines Raums (Index in `room_area::CATEGORIES`).
//! Wie ein Raum zu seiner Flächenart kommt, steht an genau einer Stelle: [`area_kind`]. Kommen
//! später eigene Raumtypen (Büro, Wohnen, Technik …) dazu, genügt dort eine Zuordnung
//! Typ → Flächenart; die Tabelle selbst bleibt unverändert.
//!
//! Abweichung zur älteren Bilanz in `room_area::rollup`/`kennzahlen::compute`: Dort zählt die AGF
//! zur „GF". Nach SIA 416 gehört sie nicht dazu (AGF = nicht allseitig umschlossene Flächen).
//! Die Tabelle hier folgt der Norm; die alte Bilanz bleibt unverändert.
//!
//! ## Herleitung aus dem Modell
//!
//!  • HNF/NNF/VF/FF/AGF: Summe der Raumflächen je Geschoss und Flächenart.
//!  • KF: Räume der Flächenart KGF (von Hand gezeichnete Konstruktionsfläche) vereinigt mit den
//!    Wandgrundrissen des Geschosses, abzüglich der übrigen Räume (damit eine in einen Raum
//!    hineingezeichnete Wand nicht doppelt zählt). Wandgrundriss = Rechteck um die Wandachse mit
//!    der Wanddicke; Wandenden, die auf einer anderen Wand enden, werden um deren halbe Dicke
//!    verlängert (Eckschluss). Stützen und Schächte fehlen — als KGF-Raum zeichnen.
//!  • GF = NGF + KF (Summe der Teile, nicht aus einem Umriss gemessen).
//!  • GV je Geschoss ≈ GF × `floorHeight` (Rohbau-Geschosshöhe OK–OK, ohne Dachaufbauten). Gibt es
//!    freie Körper (Massenmodell), so ist deren Volumen (Abzugskörper abgezogen) das GV
//!    ([`GvSource::Solids`]). Beides ist eine Näherung der Hüllenvolumenrechnung der Norm.
//!
//! # IVHB (Interkantonale Vereinbarung über die Harmonisierung der Baubegriffe, 22.9.2005)
//!
//! Begriffe und Messweisen im Anhang 1 der IVHB (Höhenmasse, Nutzungsziffern). Die Ziffern sind
//! Verhältnisse zur anrechenbaren Grundstücksfläche (aGSF). Der genaue Wortlaut ist vor einer
//! Eingabe bei der Behörde gegen die kantonale Bauverordnung zu prüfen.
//!
//!  • AZ  = anrechenbare Geschossfläche (aGF) / aGSF. Was als aGF zählt, regeln die Kantone;
//!    deshalb ist die Basis wählbar ([`AgfBasis`]) und die Anrechnung unterirdischer Geschosse
//!    eine Option.
//!  • GFZ = Σ GF (inkl. Konstruktionsflächen) / aGSF — die Geschossflächenziffer dem Namen nach;
//!    die IVHB selbst kennt nur AZ, GFZ steht in einzelnen kantonalen Bauordnungen.
//!  • BMZ = Baumasse / aGSF. Baumasse = oberirdisches Gebäudevolumen über dem massgebenden
//!    Terrain; das Modell hat kein Terrain, als massgebendes Terrain gilt ±0.00.
//!  • ÜZ  = anrechenbare Gebäudefläche (aGbF) / aGSF. aGbF = vereinigte Grundfläche (Wände,
//!    Räume, freie Körper) der oberirdischen Geschosse; Vorsprünge und Dachüberstände fehlen im
//!    Modell.
//!  • GZ  = anrechenbare Grünfläche / aGSF. Grünfläche ist nicht aus dem Modell ableitbar
//!    (kein Terrain-/Bepflanzungsmodell): reines Eingabefeld.
//!  • Gesamthöhe = höchster Punkt über dem massgebenden Terrain (±0.00). Fassadenhöhe hier als
//!    höchste Wandoberkante genähert (die Schnittlinie Fassade/Dach wird nicht ausgewertet).
//!  • aGSF: Eingabe, sonst `Project.parcelArea`, sonst die Fläche der Parzellengrenze des
//!    Baurechts. Abzüge (Strassen, Wald …) macht der Mensch in der Eingabe.
//!
//! Keine Werte werden erfunden: Fehlt die aGSF, sind alle Ziffern `None`.

use crate::flat::Polygon;
use crate::flat_read::signed_area;
use crate::kennzahlen::{self, RoomIn, SolidIn, CATEGORIES};
use crate::model::{DrawingLevel, DrawingLevelKind, Project, Room};
use crate::polygon_bool;
use crate::site_rules::{multi_polygon_area, wall_corners};
use serde::{Deserialize, Serialize};

// Flächenart-Indizes (Reihenfolge `room_area::CATEGORIES`).
const HNF: usize = 0;
const NNF: usize = 1;
const VF: usize = 2;
const FF: usize = 3;
const KGF: usize = 4;
const AGF: usize = 5;

/// Flächenart eines Raums (Index in `room_area::CATEGORIES`, `CATEGORIES` = zählt nicht).
/// Einzige Stelle der Zuordnung Raum → Flächenart; heute folgt sie dem Feld `siaCategory`.
fn area_kind(r: &Room) -> usize {
    kennzahlen::category_index(r.sia_category)
}

fn finite(v: f64) -> f64 {
    if v.is_finite() {
        v
    } else {
        0.0
    }
}

/// Woher das Gebäudevolumen kommt.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum GvSource {
    /// Summe der freien Körper (Massenmodell).
    Solids,
    /// Σ GF × Geschosshöhe.
    Levels,
}

/// Eine Zeile der Flächentabelle (ein Geschoss oder die Summe).
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AreaRow {
    pub level_id: String,
    pub name: String,
    /// Oberkante ≤ ±0.00 (Untergeschoss); in der Summenzeile `false`.
    pub underground: bool,
    pub hnf: f64,
    pub nnf: f64,
    pub nf: f64,
    pub vf: f64,
    pub ff: f64,
    pub ngf: f64,
    pub kf: f64,
    pub gf: f64,
    pub agf: f64,
    /// Geschosshöhe (m), in der Summenzeile 0.
    pub height: f64,
    /// GF × Geschosshöhe; in der Summenzeile die Summe.
    pub gv: f64,
    pub rooms: usize,
}

impl AreaRow {
    fn add(&mut self, o: &AreaRow) {
        self.hnf += o.hnf;
        self.nnf += o.nnf;
        self.nf += o.nf;
        self.vf += o.vf;
        self.ff += o.ff;
        self.ngf += o.ngf;
        self.kf += o.kf;
        self.gf += o.gf;
        self.agf += o.agf;
        self.gv += o.gv;
        self.rooms += o.rooms;
    }
}

/// Flächentabelle.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AreaTable {
    /// Geschosse von unten nach oben.
    pub levels: Vec<AreaRow>,
    pub total: AreaRow,
    /// Gebäudevolumen (m³) gemäss `gv_source`.
    pub gv: f64,
    pub gv_source: GvSource,
    /// Hinweise (Schlüssel, die die UI übersetzt): Annahmen, die in die Zahlen eingehen.
    pub notes: Vec<String>,
}

/// Geschosse (Art `floor`) von unten nach oben.
fn floors_sorted(p: &Project) -> Vec<&DrawingLevel> {
    let mut f: Vec<&DrawingLevel> = p.drawing_levels.iter().filter(|l| l.kind == DrawingLevelKind::Floor).collect();
    f.sort_by(|a, b| a.base_elevation.unwrap_or(0.0).partial_cmp(&b.base_elevation.unwrap_or(0.0)).unwrap_or(std::cmp::Ordering::Equal));
    f
}

fn level_height(l: &DrawingLevel) -> f64 {
    finite(l.floor_height.unwrap_or(0.0)).max(0.0)
}

fn is_underground(l: &DrawingLevel) -> bool {
    l.base_elevation.unwrap_or(0.0) + level_height(l) <= 1e-9
}

/// Wandgrundrisse eines Geschosses, Enden auf anderen Wänden um deren halbe Dicke verlängert.
fn wall_polygons(p: &Project, level_id: &str) -> Vec<Polygon> {
    struct W {
        s: [f64; 2],
        e: [f64; 2],
        t: f64,
    }
    let ws: Vec<W> = p
        .walls
        .iter()
        .filter(|w| w.floor_id == level_id)
        .map(|w| W { s: [w.start.x, w.start.y], e: [w.end.x, w.end.y], t: finite(p.wall_thickness(w, 0.2)).max(0.0) })
        .filter(|w| w.s.iter().chain(w.e.iter()).all(|v| v.is_finite()) && (w.e[0] - w.s[0]).hypot(w.e[1] - w.s[1]) > 1e-9)
        .collect();
    // Abstand eines Punktes zur Strecke.
    let dist = |q: [f64; 2], a: [f64; 2], b: [f64; 2]| {
        let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
        let l2 = dx * dx + dy * dy;
        let u = (((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / l2).clamp(0.0, 1.0);
        (q[0] - (a[0] + u * dx)).hypot(q[1] - (a[1] + u * dy))
    };
    const EPS: f64 = 1e-3;
    ws.iter()
        .enumerate()
        .map(|(i, w)| {
            let ext = |q: [f64; 2]| ws.iter().enumerate().filter(|(j, o)| *j != i && dist(q, o.s, o.e) <= EPS).map(|(_, o)| o.t / 2.0).fold(0.0, f64::max);
            let (dx, dy) = (w.e[0] - w.s[0], w.e[1] - w.s[1]);
            let l = dx.hypot(dy);
            let (ux, uy) = (dx / l, dy / l);
            let (a, b) = (ext(w.s), ext(w.e));
            let s = crate::model::Vec2 { x: w.s[0] - ux * a, y: w.s[1] - uy * a };
            let e = crate::model::Vec2 { x: w.e[0] + ux * b, y: w.e[1] + uy * b };
            vec![wall_corners(s, e, w.t)]
        })
        .collect()
}

/// Räume eines Geschosses als Polygone, gefiltert nach Flächenart.
fn room_polygons(p: &Project, level_id: &str, keep: impl Fn(usize) -> bool) -> Vec<Polygon> {
    p.rooms
        .as_deref()
        .unwrap_or(&[])
        .iter()
        .filter(|r| r.floor_id == level_id && r.boundary.len() >= 3 && keep(area_kind(r)))
        .filter(|r| r.boundary.iter().all(|v| v.x.is_finite() && v.y.is_finite()))
        .map(|r| vec![r.boundary.iter().map(|v| [v.x, v.y]).collect()])
        .collect()
}

/// Konstruktionsfläche eines Geschosses (siehe Moduldoku).
fn construction_area(p: &Project, level_id: &str) -> f64 {
    let mut kf_parts = wall_polygons(p, level_id);
    kf_parts.extend(room_polygons(p, level_id, |c| c == KGF));
    if kf_parts.is_empty() {
        return 0.0;
    }
    let rooms = room_polygons(p, level_id, |c| c != KGF && c != AGF);
    finite(multi_polygon_area(&polygon_bool::difference(&kf_parts, &rooms))).max(0.0)
}

fn solids_in(p: &Project) -> Vec<SolidIn> {
    p.extruded_solids
        .as_deref()
        .unwrap_or(&[])
        .iter()
        .map(|s| SolidIn {
            subtract: s.operation.as_deref() == Some("subtract"),
            points: if s.circle.is_some() { vec![] } else { s.points.iter().map(|v| [v.x, v.y]).collect() },
            circle_r: s.circle.as_ref().map_or(f64::NAN, |c| c.r),
            height: s.height,
            taper: s.taper.unwrap_or(0.0),
        })
        .collect()
}

/// Flächentabelle des Projekts.
pub fn area_table(p: &Project) -> AreaTable {
    let floors = floors_sorted(p);
    let mut idx: std::collections::HashMap<&str, usize> = std::collections::HashMap::new();
    for (i, l) in floors.iter().enumerate() {
        idx.entry(l.id.as_str()).or_insert(i);
    }
    let rooms: Vec<RoomIn> = p
        .rooms
        .as_deref()
        .unwrap_or(&[])
        .iter()
        .filter_map(|r| idx.get(r.floor_id.as_str()).map(|&level| RoomIn { level, category: area_kind(r), boundary: r.boundary.iter().map(|v| [v.x, v.y]).collect() }))
        .collect();
    let solids = solids_in(p);
    let sums = kennzahlen::area_sums(floors.len(), &rooms, &solids, f64::NAN, &[]);

    let mut levels = Vec::with_capacity(floors.len());
    let mut any_walls = false;
    for (i, l) in floors.iter().enumerate() {
        let c: [f64; CATEGORIES] = sums.by_level[i];
        let nf = c[HNF] + c[NNF];
        let ngf = nf + c[VF] + c[FF];
        let kf = construction_area(p, &l.id);
        any_walls |= p.walls.iter().any(|w| w.floor_id == l.id);
        let gf = ngf + kf;
        let height = level_height(l);
        levels.push(AreaRow {
            level_id: l.id.clone(),
            name: l.name.clone(),
            underground: is_underground(l),
            hnf: c[HNF],
            nnf: c[NNF],
            nf,
            vf: c[VF],
            ff: c[FF],
            ngf,
            kf,
            gf,
            agf: c[AGF],
            height,
            gv: gf * height,
            rooms: rooms.iter().filter(|r| r.level == i).count(),
        });
    }
    let mut total = AreaRow::default();
    for l in &levels {
        total.add(l);
    }
    let has_solids = solids.iter().any(|s| !s.subtract);
    let (gv, gv_source) = if has_solids { (sums.gv, GvSource::Solids) } else { (total.gv, GvSource::Levels) };
    let mut notes = vec!["agfSeparate".to_string()];
    if any_walls {
        notes.push("kfFromWalls".to_string());
    }
    notes.push(if gv_source == GvSource::Solids { "gvSolids" } else { "gvLevels" }.to_string());
    AreaTable { levels, total, gv, gv_source, notes }
}

// ── IVHB ────────────────────────────────────────────────────────────────────

/// Welche Fläche als „anrechenbare Geschossfläche" der AZ zählt (kantonal verschieden).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AgfBasis {
    /// GF inkl. Konstruktionsflächen (Mauer- und Wandquerschnitte).
    Gf,
    /// NGF = NF + VF + FF (häufig: AZ nach altem Recht).
    #[default]
    Ngf,
    /// Nur NF = HNF + NNF.
    Nf,
}

/// Eingaben und Optionen der IVHB-Rechnung; was das Modell nicht hergibt, kommt hierher.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct IvhbOptions {
    /// Anrechenbare Grundstücksfläche (m²); sonst Parzellenfläche des Projekts.
    pub agsf: Option<f64>,
    /// Anrechenbare Grünfläche (m²).
    pub green_area: Option<f64>,
    /// Basis der aGF für die AZ.
    pub agf_basis: AgfBasis,
    /// Unterirdische Geschosse in aGF/GFZ mitrechnen (Default: nein).
    pub include_underground: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AgsfSource {
    Input,
    ParcelArea,
    ParcelRing,
    None,
}

/// IVHB-Kennziffern.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Ivhb {
    pub agsf: Option<f64>,
    pub agsf_source: AgsfSource,
    pub agf_basis: AgfBasis,
    pub include_underground: bool,
    /// Summe der angerechneten Geschossflächen GF (für die GFZ).
    pub gf_sum: f64,
    /// Anrechenbare Geschossfläche (m²) nach `agf_basis`.
    pub agf: f64,
    pub baumasse: f64,
    /// Anrechenbare Gebäudefläche (m²).
    pub agbf: f64,
    pub green_area: Option<f64>,
    pub az: Option<f64>,
    pub gfz: Option<f64>,
    pub bmz: Option<f64>,
    pub uz: Option<f64>,
    pub gz: Option<f64>,
    /// Höchster Punkt über ±0.00.
    pub total_height: Option<f64>,
    /// Höchste Wandoberkante über ±0.00 (Näherung der Fassadenhöhe).
    pub facade_height: Option<f64>,
    pub notes: Vec<String>,
}

fn positive(v: Option<f64>) -> Option<f64> {
    v.filter(|x| x.is_finite() && *x > 0.0)
}

/// Oberirdisches Volumen eines Körpers von `base` bis `base + height` (Prisma/Kegelstumpf).
fn solid_volume_above(s: &SolidIn, base: f64) -> f64 {
    let h = finite(s.height);
    if h <= 0.0 || base + h <= 0.0 {
        return 0.0;
    }
    let full = kennzahlen::solid_volume(&s.points, s.circle_r, s.height, s.taper);
    if base >= 0.0 {
        return finite(full);
    }
    // Schnitt bei Bruchteil f der Höhe: Massstab k(f) = 1 − t·f, Teilstumpf von f bis 1.
    let f = -base / h;
    let t = if s.taper.is_nan() { 0.0 } else { s.taper.clamp(0.0, 1.0) };
    let area = if s.circle_r.is_finite() { std::f64::consts::PI * s.circle_r * s.circle_r } else { signed_area(&s.points).abs() };
    let (k0, k1) = (1.0 - t * f, 1.0 - t);
    finite(area * (h + base) * (k0 * k0 + k0 * k1 + k1 * k1) / 3.0)
}

/// Vereinigte Grundfläche der oberirdischen Bauteile (Wände, Räume, positive Körper).
fn above_ground_footprint(p: &Project) -> f64 {
    let mut parts: Vec<Polygon> = Vec::new();
    for l in p.drawing_levels.iter().filter(|l| l.kind == DrawingLevelKind::Floor && !is_underground(l)) {
        parts.extend(wall_polygons(p, &l.id));
        parts.extend(room_polygons(p, &l.id, |c| c < CATEGORIES));
    }
    for s in p.extruded_solids.as_deref().unwrap_or(&[]) {
        if s.operation.as_deref() == Some("subtract") || s.points.len() < 3 {
            continue;
        }
        let base = p.floor(&s.level_id).map_or(0.0, |f| f.base_elevation.unwrap_or(0.0)) + s.base_offset.unwrap_or(0.0);
        if base + s.height > 0.0 {
            parts.push(vec![s.points.iter().map(|v| [v.x, v.y]).collect()]);
        }
    }
    if parts.is_empty() {
        return 0.0;
    }
    finite(multi_polygon_area(&polygon_bool::union(&parts))).max(0.0)
}

/// IVHB-Kennziffern des Projekts.
pub fn ivhb(p: &Project, opt: &IvhbOptions) -> Ivhb {
    let t = area_table(p);
    let floors = floors_sorted(p);
    let counted = |row: &&AreaRow| opt.include_underground || !row.underground;

    let gf_sum: f64 = t.levels.iter().filter(counted).map(|r| r.gf).sum();
    let agf: f64 = t
        .levels
        .iter()
        .filter(counted)
        .map(|r| match opt.agf_basis {
            AgfBasis::Gf => r.gf,
            AgfBasis::Ngf => r.ngf,
            AgfBasis::Nf => r.nf,
        })
        .sum();

    // Baumasse: oberirdisches Volumen.
    let baumasse = if t.gv_source == GvSource::Solids {
        p.extruded_solids
            .as_deref()
            .unwrap_or(&[])
            .iter()
            .zip(solids_in(p))
            .map(|(s, si)| {
                let base = p.floor(&s.level_id).map_or(0.0, |f| f.base_elevation.unwrap_or(0.0)) + s.base_offset.unwrap_or(0.0);
                let v = solid_volume_above(&si, base);
                if si.subtract {
                    -v
                } else {
                    v
                }
            })
            .sum::<f64>()
            .max(0.0)
    } else {
        floors
            .iter()
            .zip(&t.levels)
            .map(|(l, r)| {
                let (base, h) = (l.base_elevation.unwrap_or(0.0), r.height);
                let frac = if h <= 0.0 || base >= 0.0 { 1.0 } else { ((base + h) / h).clamp(0.0, 1.0) };
                r.gv * frac
            })
            .sum()
    };

    let agbf = above_ground_footprint(p);

    let ring: Vec<[f64; 2]> = p.site_rules.as_ref().map(|r| r.parcel.iter().map(|v| [v.x, v.y]).collect()).unwrap_or_default();
    let ring_area = if ring.len() >= 3 { finite(signed_area(&ring).abs()) } else { 0.0 };
    let (agsf, agsf_source) = if let Some(a) = positive(opt.agsf) {
        (Some(a), AgsfSource::Input)
    } else if let Some(a) = positive(p.parcel_area) {
        (Some(a), AgsfSource::ParcelArea)
    } else if ring_area > 0.0 {
        (Some(ring_area), AgsfSource::ParcelRing)
    } else {
        (None, AgsfSource::None)
    };
    let ratio = |x: f64| agsf.map(|a| x / a);
    let green_area = opt.green_area.filter(|g| g.is_finite() && *g >= 0.0);

    let total_height = crate::site_rules::model_top(p);
    let facade_height = p
        .walls
        .iter()
        .map(|w| p.wall_vertical_extent(w).1)
        .filter(|v| v.is_finite())
        .fold(None, |m: Option<f64>, v| Some(m.map_or(v, |x| x.max(v))));

    let mut notes = vec!["terrainZero".to_string()];
    if agsf_source == AgsfSource::None {
        notes.push("agsfMissing".to_string());
    }
    if green_area.is_none() {
        notes.push("greenInput".to_string());
    }
    if !opt.include_underground {
        notes.push("aboveGroundOnly".to_string());
    }
    Ivhb {
        agsf,
        agsf_source,
        agf_basis: opt.agf_basis,
        include_underground: opt.include_underground,
        gf_sum,
        agf,
        baumasse,
        agbf,
        green_area,
        az: ratio(agf),
        gfz: ratio(gf_sum),
        bmz: ratio(baumasse),
        uz: ratio(agbf),
        gz: green_area.and_then(ratio),
        total_height,
        facade_height,
        notes,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-4
    }

    /// Einfaches Haus: Achsen 10 × 8 m, Wände 0.3 m, Räume innen 9.7 × 7.7 m.
    /// EG (HNF 9.7×4 = 38.8, NNF 9.7×1.7 = 16.49, VF 9.7×2 = 19.4), OG (HNF 74.69),
    /// UG (FF 74.69) unter ±0.00. Geschosshöhe 2.6 m.
    fn house() -> Project {
        let json = r#"{
          "drawingLevels":[
            {"id":"ug","name":"UG","kind":"floor","visible":true,"locked":false,"baseElevation":-2.6,"floorHeight":2.6},
            {"id":"eg","name":"EG","kind":"floor","visible":true,"locked":false,"baseElevation":0,"floorHeight":2.6},
            {"id":"og","name":"OG","kind":"floor","visible":true,"locked":false,"baseElevation":2.6,"floorHeight":2.6}],
          "wallTypes":[{"id":"wt","name":"W","layers":[{"componentId":"c","thickness":0.3}]}],
          "walls":[],"rooms":[]
        }"#;
        let mut p: Project = serde_json::from_str(json).unwrap();
        let v = |x: f64, y: f64| serde_json::json!({"x": x, "y": y});
        let mut walls = vec![];
        let mut rooms = vec![];
        for lvl in ["ug", "eg", "og"] {
            let pts = [(0.0, 0.0), (10.0, 0.0), (10.0, 8.0), (0.0, 8.0)];
            for i in 0..4 {
                let (a, b) = (pts[i], pts[(i + 1) % 4]);
                walls.push(serde_json::json!({"id":format!("w-{lvl}-{i}"),"type":"wall","floorId":lvl,"categoryCode":"x","start":v(a.0,a.1),"end":v(b.0,b.1),"wallTypeId":"wt","height":2.6}));
            }
            let room = |id: &str, cat: &str, y0: f64, y1: f64| {
                serde_json::json!({"id":format!("{id}-{lvl}"),"type":"room","floorId":lvl,"categoryCode":"x","siaCategory":cat,"name":id,"color":"#fff",
                "boundary":[v(0.15,y0),v(9.85,y0),v(9.85,y1),v(0.15,y1)]})
            };
            match lvl {
                "eg" => {
                    rooms.push(room("a", "HNF", 0.15, 4.15));
                    rooms.push(room("b", "NNF", 4.15, 5.85));
                    rooms.push(room("c", "VF", 5.85, 7.85));
                }
                "og" => rooms.push(room("a", "HNF", 0.15, 7.85)),
                _ => rooms.push(room("a", "FF", 0.15, 7.85)),
            }
        }
        p.walls = serde_json::from_value(serde_json::Value::Array(walls)).unwrap();
        p.rooms = Some(serde_json::from_value(serde_json::Value::Array(rooms)).unwrap());
        p
    }

    #[test]
    fn flaechentabelle_einfaches_haus() {
        let t = area_table(&house());
        assert_eq!(t.levels.len(), 3);
        let eg = &t.levels[1];
        assert_eq!(eg.name, "EG");
        assert!(close(eg.hnf, 38.8) && close(eg.nnf, 16.49) && close(eg.vf, 19.4) && close(eg.ff, 0.0));
        assert!(close(eg.nf, 55.29) && close(eg.ngf, 74.69));
        // KF = 10.3·8.3 − 9.7·7.7 = 85.49 − 74.69
        assert!(close(eg.kf, 10.8), "kf {}", eg.kf);
        assert!(close(eg.gf, 85.49));
        assert!(close(eg.gf, eg.ngf + eg.kf));
        assert!(close(eg.gv, 85.49 * 2.6));
        assert!(t.levels[0].underground && !t.levels[1].underground);
        assert!(close(t.levels[0].ff, 74.69) && close(t.levels[0].ngf, 74.69));
        assert!(close(t.total.gf, 3.0 * 85.49));
        assert!(close(t.total.ngf, 3.0 * 74.69));
        assert!(close(t.total.kf, 3.0 * 10.8));
        assert!(close(t.total.hnf, 38.8 + 74.69));
        assert!(close(t.gv, 3.0 * 85.49 * 2.6));
        assert_eq!(t.gv_source, GvSource::Levels);
    }

    #[test]
    fn agf_zaehlt_nicht_zur_gf() {
        let mut p = house();
        let mut rooms = p.rooms.take().unwrap();
        let mut balkon = rooms[0].clone();
        balkon.id = "balkon".into();
        balkon.floor_id = "eg".into();
        balkon.sia_category = crate::model::SiaCategory::AGF;
        balkon.boundary = vec![crate::model::Vec2 { x: 0.0, y: -2.0 }, crate::model::Vec2 { x: 3.0, y: -2.0 }, crate::model::Vec2 { x: 3.0, y: -0.15 }, crate::model::Vec2 { x: 0.0, y: -0.15 }];
        rooms.push(balkon);
        p.rooms = Some(rooms);
        let t = area_table(&p);
        assert!(close(t.levels[1].agf, 3.0 * 1.85));
        assert!(close(t.levels[1].gf, 85.49));
    }

    #[test]
    fn konstruktionsraum_zaehlt_zur_kf() {
        let mut p = house();
        let mut rooms = p.rooms.take().unwrap();
        let mut schacht = rooms[0].clone();
        schacht.id = "schacht".into();
        schacht.sia_category = crate::model::SiaCategory::KGF;
        schacht.floor_id = "eg".into();
        schacht.boundary = vec![crate::model::Vec2 { x: 20.0, y: 0.0 }, crate::model::Vec2 { x: 21.0, y: 0.0 }, crate::model::Vec2 { x: 21.0, y: 1.0 }, crate::model::Vec2 { x: 20.0, y: 1.0 }];
        rooms.push(schacht);
        p.rooms = Some(rooms);
        assert!(close(area_table(&p).levels[1].kf, 11.8));
    }

    #[test]
    fn volumen_aus_koerpern() {
        let mut p = house();
        p.extruded_solids = Some(
            serde_json::from_value(serde_json::json!([{"id":"s","type":"extrudedSolid","levelId":"eg","points":[{"x":0,"y":0},{"x":10,"y":0},{"x":10,"y":8},{"x":0,"y":8}],"height":8.0}])).unwrap(),
        );
        let t = area_table(&p);
        assert_eq!(t.gv_source, GvSource::Solids);
        assert!(close(t.gv, 640.0));
    }

    #[test]
    fn ivhb_ziffern_von_hand() {
        let p = house();
        // aGSF = 400 m²; oberirdisch = EG + OG.
        let o = IvhbOptions { agsf: Some(400.0), green_area: Some(160.0), agf_basis: AgfBasis::Ngf, include_underground: false };
        let r = ivhb(&p, &o);
        assert_eq!(r.agsf_source, AgsfSource::Input);
        assert!(close(r.gf_sum, 2.0 * 85.49));
        assert!(close(r.gfz.unwrap(), 2.0 * 85.49 / 400.0));
        assert!(close(r.agf, 2.0 * 74.69));
        assert!(close(r.az.unwrap(), 2.0 * 74.69 / 400.0));
        // Baumasse = oberirdisches GV = 2 Geschosse × 85.49 × 2.6 (UG liegt unter ±0.00).
        assert!(close(r.baumasse, 2.0 * 85.49 * 2.6));
        assert!(close(r.bmz.unwrap(), 2.0 * 85.49 * 2.6 / 400.0));
        assert!(close(r.agbf, 85.49), "agbf {}", r.agbf);
        assert!(close(r.uz.unwrap(), 85.49 / 400.0));
        assert!(close(r.gz.unwrap(), 0.4));
        // Wände 2.6 m hoch → OK OG = 2.6 + 2.6.
        assert!(close(r.total_height.unwrap(), 5.2) && close(r.facade_height.unwrap(), 5.2));
        let r2 = ivhb(&p, &IvhbOptions { include_underground: true, agf_basis: AgfBasis::Gf, ..o.clone() });
        assert!(close(r2.agf, 3.0 * 85.49) && close(r2.gfz.unwrap(), 3.0 * 85.49 / 400.0));
        assert!(close(r2.baumasse, 2.0 * 85.49 * 2.6));
    }

    #[test]
    fn ivhb_agsf_quellen_und_fehlende_eingaben() {
        let mut p = house();
        let r = ivhb(&p, &IvhbOptions::default());
        assert_eq!(r.agsf_source, AgsfSource::None);
        assert!(r.az.is_none() && r.gfz.is_none() && r.bmz.is_none() && r.uz.is_none() && r.gz.is_none());
        assert!(r.notes.contains(&"agsfMissing".to_string()));
        p.parcel_area = Some(500.0);
        let r = ivhb(&p, &IvhbOptions::default());
        assert_eq!(r.agsf_source, AgsfSource::ParcelArea);
        assert!(r.gz.is_none() && r.uz.is_some());
        let r = ivhb(&p, &IvhbOptions { agsf: Some(250.0), ..Default::default() });
        assert_eq!(r.agsf, Some(250.0));
    }

    #[test]
    fn baumasse_koerper_ueber_terrain() {
        let s = SolidIn { subtract: false, points: vec![[0.0, 0.0], [10.0, 0.0], [10.0, 8.0], [0.0, 8.0]], circle_r: f64::NAN, height: 6.0, taper: 0.0 };
        assert!(close(solid_volume_above(&s, -2.0), 320.0));
        assert!(close(solid_volume_above(&s, 1.0), 480.0));
        assert!(close(solid_volume_above(&s, -6.0), 0.0));
        // Pyramide, Höhe 6: ganz oberirdisch = Vollvolumen; halb versenkt: obere Hälfte = 1/8.
        let py = SolidIn { taper: 1.0, ..s };
        assert!(close(solid_volume_above(&py, 0.0), 160.0));
        assert!(close(solid_volume_above(&py, -3.0), 160.0 / 8.0));
    }

    #[test]
    fn unsinn_ohne_panik() {
        let mut p = house();
        p.walls[0].start.x = f64::NAN;
        p.parcel_area = Some(f64::NAN);
        let t = area_table(&p);
        assert!(t.total.gf.is_finite());
        let r = ivhb(&p, &IvhbOptions { agsf: Some(-1.0), green_area: Some(f64::NAN), ..Default::default() });
        assert!(r.az.is_none() && r.gz.is_none());
        let empty = Project::default();
        assert_eq!(area_table(&empty).levels.len(), 0);
        assert!(ivhb(&empty, &IvhbOptions::default()).total_height.is_none());
    }
}
