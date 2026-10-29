//! Basismengen (Qto_*BaseQuantities) für den IFC-Export ([B5], [K4]; Port von
//! `src/export/ifcQuantities.ts`): Längen, Flächen und Volumen aus derselben Geometrie, die in die
//! Datei geschrieben wird — für Kostenplanung (eBKP-H/BKP) und Mengenermittlung. Reine Rechnung auf
//! einfachen Eingaben (Bänder, Ringe, Netze); `ifc_data.rs` sammelt, `fileio` schreibt die
//! IfcElementQuantity. Rechenreihenfolge und Zahlsemantik wie in TS (`Math.hypot/min/max`).
//!
//! Netto = abzüglich Öffnungen (Wand, Decke). Fehlt einer Menge die Grundlage (z. B. Höhe bei
//! schräger Wandoberkante: „nur angeben, wenn konstant"), fällt sie weg statt geraten zu werden.

use crate::jsmath::{hypot, hypot2};
use crate::jsnum::{max, min};
use crate::model::Vec2;
use crate::model3d::RWall;

/// Art einer Menge (Code in der flachen Kodierung: 3 Länge, 4 Fläche, 5 Volumen).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QtyKind {
    Length,
    Area,
    Volume,
}

/// Eine Menge: Name nach IFC4-Vorlage, Art und Wert (immer endlich und ≥ 0, ausser nachträglich gesetzt).
#[derive(Debug, Clone, PartialEq)]
pub struct Qty {
    pub name: &'static str,
    pub kind: QtyKind,
    pub value: f64,
}

/// Rundungsfehler und kaputte Eingaben (NaN) auf 0, nie negativ.
fn clean(v: f64) -> f64 {
    if v.is_finite() && v > 0.0 {
        v
    } else {
        0.0
    }
}

fn q(name: &'static str, kind: QtyKind, value: f64) -> Qty {
    Qty { name, kind, value: clean(value) }
}
fn len(name: &'static str, v: f64) -> Qty {
    q(name, QtyKind::Length, v)
}
fn area(name: &'static str, v: f64) -> Qty {
    q(name, QtyKind::Area, v)
}
fn vol(name: &'static str, v: f64) -> Qty {
    q(name, QtyKind::Volume, v)
}

/// Fläche eines Rings (Shoelace, unabhängig vom Umlaufsinn); offener Ring.
pub fn ring_area(pts: &[Vec2]) -> f64 {
    let mut a = 0.0;
    let n = pts.len();
    for i in 0..n {
        let j = if i == 0 { n - 1 } else { i - 1 };
        a += pts[j].x * pts[i].y - pts[i].x * pts[j].y;
    }
    a.abs() / 2.0
}

/// Umfang eines geschlossenen Rings.
pub fn ring_perimeter(pts: &[Vec2]) -> f64 {
    let mut p = 0.0;
    let n = pts.len();
    for i in 0..n {
        let j = if i == 0 { n - 1 } else { i - 1 };
        p += hypot2(pts[i].x - pts[j].x, pts[i].y - pts[j].y);
    }
    p
}

/// Öffnung einer Wand: Achs-Intervall (ab Wandanfang) und absolute Höhen.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Cutout {
    pub from: f64,
    pub to: f64,
    pub z_bottom: f64,
    pub z_top: f64,
}

fn overlap(a0: f64, a1: f64, b0: f64, b1: f64) -> f64 {
    max(0.0, min(a1, b1) - max(a0, b0))
}

fn sloped_band(b: &RWall) -> bool {
    b.top_drop.is_some_and(|d| d[0].abs() > 1e-9 || d[1].abs() > 1e-9)
}

/// Wand-Basismengen aus den Schicht-Bändern (dieselben wie im 3D) und den Öffnungen.
///  • Length: Achslänge; Width: Gesamtdicke quer zur Achse; Height: nur bei konstanter Höhe.
///  • GrossSideArea: Achslänge × Wandhöhe (schräge Oberkante: höchste mittlere Bandhöhe);
///    NetSideArea: abzüglich der Öffnungsflächen.
///  • GrossVolume: Summe der Band-Quader; NetVolume: abzüglich der Öffnungen je Band — oder
///    `net_volume`, wenn die Wand als Netz mit schon ausgestanzten Öffnungen geschrieben wird.
pub fn wall_quantities(start: Vec2, end: Vec2, bands: &[&RWall], cutouts: &[Cutout], net_volume: Option<f64>) -> Vec<Qty> {
    if bands.is_empty() {
        return Vec::new();
    }
    let axis_len = hypot2(end.x - start.x, end.y - start.y);
    let ux = if axis_len > 0.0 { (end.x - start.x) / axis_len } else { 1.0 };
    let uy = if axis_len > 0.0 { (end.y - start.y) / axis_len } else { 0.0 };
    let (mut n_lo, mut n_hi) = (f64::INFINITY, f64::NEG_INFINITY);
    let (mut z_min, mut z_max) = (f64::INFINITY, f64::NEG_INFINITY);
    let mut sloped = false;
    let mut gross = 0.0;
    let mut tallest = 0.0;
    for b in bands {
        let l = hypot2(b.end[0] - b.start[0], b.end[1] - b.start[1]);
        let off = -(b.start[0] - start.x) * uy + (b.start[1] - start.y) * ux;
        n_lo = min(n_lo, off - b.thickness / 2.0);
        n_hi = max(n_hi, off + b.thickness / 2.0);
        z_min = min(z_min, b.base_elevation);
        z_max = max(z_max, b.base_elevation + b.height);
        let drop = b.top_drop.map_or(0.0, |d| (d[0] + d[1]) / 2.0);
        if sloped_band(b) {
            sloped = true;
        }
        gross += l * b.thickness * (b.height - drop);
        tallest = max(tallest, b.height - drop);
    }
    let gross_side = axis_len * (if sloped { tallest } else { z_max - z_min });
    let mut cut_side = 0.0;
    let mut cut_volume = 0.0;
    for c in cutouts {
        cut_side += (c.to - c.from) * overlap(c.z_bottom, c.z_top, z_min, z_max);
        for b in bands {
            let a0 = (b.start[0] - start.x) * ux + (b.start[1] - start.y) * uy;
            let a1 = (b.end[0] - start.x) * ux + (b.end[1] - start.y) * uy;
            let ox = overlap(min(a0, a1), max(a0, a1), c.from, c.to);
            cut_volume += ox * overlap(c.z_bottom, c.z_top, b.base_elevation, b.base_elevation + b.height) * b.thickness;
        }
    }
    // Netto aus dem Netz kann den Band-Quader um Rundung/Gehrungsdetails überschreiten: Brutto nie unter Netto.
    let net = net_volume.unwrap_or_else(|| max(0.0, gross - cut_volume));
    gross = max(gross, net);
    let mut out = vec![len("Length", axis_len), len("Width", n_hi - n_lo)];
    if !sloped && z_max - z_min > 0.0 {
        out.push(len("Height", z_max - z_min));
    }
    out.extend([
        area("GrossSideArea", gross_side),
        area("NetSideArea", max(0.0, gross_side - cut_side)),
        vol("GrossVolume", gross),
        vol("NetVolume", net),
    ]);
    out
}

/// Brutto-Volumen der Löcher in den Bändern (für Netz-Wände ohne dichtes Netz).
pub fn hole_volume(bands: &[&RWall]) -> f64 {
    let mut v = 0.0;
    for b in bands {
        for h in b.holes.as_deref().unwrap_or(&[]) {
            v += (h.to - h.from) * overlap(h.z_bottom, h.z_top, b.base_elevation, b.base_elevation + b.height) * b.thickness;
        }
    }
    v
}

/// Platten-Basismengen (Decke, Podest): Dicke, Umfang der Aussenkontur, Flächen und Volumen; Netto
/// zieht die Aussparungen ab.
pub fn slab_quantities(outline: &[Vec2], openings: &[&[Vec2]], thickness: f64) -> Vec<Qty> {
    let gross = ring_area(outline);
    let mut holes = 0.0;
    for r in openings {
        holes += ring_area(r);
    }
    let net = max(0.0, gross - holes);
    vec![
        len("Width", thickness),
        len("Perimeter", ring_perimeter(outline)),
        area("GrossArea", gross),
        area("NetArea", net),
        vol("GrossVolume", gross * thickness),
        vol("NetVolume", net * thickness),
    ]
}

/// Dach-Basismengen aus den geneigten Dachflächen (Aussenseite): geneigte Fläche (brutto = netto)
/// und Grundrissprojektion (Newell: Vektorfläche je Polygon).
pub fn roof_quantities(planes: &[Vec<[f64; 3]>]) -> Vec<Qty> {
    let mut sloped = 0.0;
    let mut projected = 0.0;
    for pts in planes {
        let (mut nx, mut ny, mut nz) = (0.0, 0.0, 0.0);
        let n = pts.len();
        for i in 0..n {
            let c = pts[if i == 0 { n - 1 } else { i - 1 }];
            let d = pts[i];
            nx += (c[1] - d[1]) * (c[2] + d[2]);
            ny += (c[2] - d[2]) * (c[0] + d[0]);
            nz += (c[0] - d[0]) * (c[1] + d[1]);
        }
        sloped += hypot(&[nx, ny, nz]) / 2.0;
        projected += nz.abs() / 2.0;
    }
    vec![area("GrossArea", sloped), area("NetArea", sloped), area("ProjectedArea", projected)]
}

/// Stützen-Basismengen: Länge, Querschnitt, Mantel, Oberfläche und Volumen.
pub fn column_quantities(footprint: &[Vec2], length: f64) -> Vec<Qty> {
    let cross = ring_area(footprint);
    let outer = ring_perimeter(footprint) * length;
    vec![
        len("Length", length),
        area("CrossSectionArea", cross),
        area("OuterSurfaceArea", outer),
        area("NetSurfaceArea", outer + 2.0 * cross),
        vol("GrossVolume", cross * length),
        vol("NetVolume", cross * length),
    ]
}

/// Tür-/Fenster-Basismengen (lichte Öffnung): Breite, Höhe, Umfang, Fläche.
pub fn opening_quantities(width: f64, height: f64) -> Vec<Qty> {
    let w = clean(width);
    let h = clean(height);
    vec![len("Width", w), len("Height", h), len("Perimeter", 2.0 * (w + h)), area("Area", w * h)]
}

/// Treppenlauf: Lauflänge entlang der Lauflinie und Volumen.
pub fn flight_quantities(length: f64, volume: f64) -> Vec<Qty> {
    vec![len("Length", length), vol("GrossVolume", volume), vol("NetVolume", volume)]
}

/// Geländer: Länge.
pub fn railing_quantities(length: f64) -> Vec<Qty> {
    vec![len("Length", length)]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model3d::RHole;

    fn v(x: f64, y: f64) -> Vec2 {
        Vec2 { x, y }
    }

    fn band(start: [f64; 2], end: [f64; 2], thickness: f64, base: f64, height: f64) -> RWall {
        RWall {
            start,
            end,
            thickness,
            height,
            base_elevation: base,
            top_drop: None,
            color: [0.5, 0.5, 0.5],
            layers: vec![],
            wall_id: "w".into(),
            holes: None,
            hatch: None,
            material_index: None,
            cut: None,
        }
    }

    fn get(q: &[Qty], name: &str) -> Option<f64> {
        q.iter().find(|x| x.name == name).map(|x| x.value)
    }

    fn close(a: Option<f64>, b: f64) -> bool {
        a.is_some_and(|a| (a - b).abs() < 1e-9)
    }

    #[test]
    fn ringe() {
        let r = [v(0.0, 0.0), v(4.0, 0.0), v(4.0, 3.0), v(0.0, 3.0)];
        assert_eq!(ring_area(&r), 12.0);
        assert_eq!(ring_perimeter(&r), 14.0);
        let mut rev = r.to_vec();
        rev.reverse();
        assert_eq!(ring_area(&rev), 12.0);
        assert_eq!(ring_area(&[]), 0.0);
    }

    #[test]
    fn wand_sonderfaelle() {
        let (s, e) = (v(0.0, 0.0), v(5.0, 0.0));
        // Innere Schicht endet unter der Decke: Seitenfläche mit voller Wandhöhe, Volumen je Schicht.
        let outer = band([0.0, 0.0], [5.0, 0.0], 0.2, 0.0, 2.6);
        let inner = band([0.1, 0.0], [4.9, 0.0], 0.1, 0.0, 2.3);
        let q = wall_quantities(s, e, &[&outer, &inner], &[], None);
        assert!(close(get(&q, "Height"), 2.6) && close(get(&q, "GrossSideArea"), 13.0));
        assert!(close(get(&q, "GrossVolume"), 5.0 * 0.2 * 2.6 + 4.8 * 0.1 * 2.3));
        // Gehrung/Anschluss: kürzeres Band ändert das Volumen, nicht die Wandlänge.
        let q = wall_quantities(s, e, &[&inner], &[], None);
        assert_eq!(get(&q, "Length"), Some(5.0));
        assert_eq!(get(&q, "NetVolume"), get(&q, "GrossVolume"));
        // Öffnung grösser als die Wand: netto nie negativ; Öffnung ausserhalb zieht nichts ab.
        let big = [Cutout { from: -1.0, to: 6.0, z_bottom: -1.0, z_top: 5.0 }, Cutout { from: 8.0, to: 9.0, z_bottom: 0.0, z_top: 2.0 }];
        let q = wall_quantities(s, e, &[&outer], &big, None);
        assert_eq!(get(&q, "NetSideArea"), Some(0.0));
        assert!(close(get(&q, "NetVolume"), 0.0));
        // Netz-Wand: Netto aus dem Netz, Brutto bleibt der Quader.
        let q = wall_quantities(s, e, &[&outer], &[], Some(1.5));
        assert_eq!(get(&q, "NetVolume"), Some(1.5));
        assert!(close(get(&q, "GrossVolume"), 13.0 * 0.2));
        assert!(wall_quantities(s, e, &[], &[], None).is_empty());
    }

    #[test]
    fn satteldach_30_grad() {
        let h = (std::f64::consts::PI / 6.0).tan() * 2.0;
        let planes = vec![vec![[0.0, 0.0, 0.0], [5.0, 0.0, 0.0], [5.0, 2.0, h], [0.0, 2.0, h]], vec![[0.0, 4.0, 0.0], [0.0, 2.0, h], [5.0, 2.0, h], [5.0, 4.0, 0.0]]];
        let q = roof_quantities(&planes);
        assert!((get(&q, "ProjectedArea").unwrap() - 20.0).abs() < 1e-9);
        assert!((get(&q, "GrossArea").unwrap() - 20.0 / (std::f64::consts::PI / 6.0).cos()).abs() < 1e-9);
        assert_eq!(get(&q, "NetArea"), get(&q, "GrossArea"));
    }

    #[test]
    fn wand_brutto_netto() {
        // Wand 5 m, zwei Schichten (0.2 + 0.1) übereinander-bündig, 2.6 m hoch, eine Öffnung 1×1.2 m.
        let b1 = band([0.0, -0.05], [5.0, -0.05], 0.2, 0.0, 2.6);
        let b2 = band([0.0, 0.1], [5.0, 0.1], 0.1, 0.0, 2.5);
        let cut = Cutout { from: 1.0, to: 2.0, z_bottom: 0.9, z_top: 2.1 };
        let q = wall_quantities(v(0.0, 0.0), v(5.0, 0.0), &[&b1, &b2], &[cut], None);
        assert!(close(get(&q, "Length"), 5.0));
        assert!(close(get(&q, "Width"), 0.3));
        assert!(close(get(&q, "Height"), 2.6));
        assert!(close(get(&q, "GrossSideArea"), 13.0));
        assert!(close(get(&q, "NetSideArea"), 13.0 - 1.2));
        let gross = 5.0 * 0.2 * 2.6 + 5.0 * 0.1 * 2.5;
        assert!(close(get(&q, "GrossVolume"), gross));
        assert!(close(get(&q, "NetVolume"), gross - 1.2 * 0.3));
        // Netz-Volumen übersteuert, Brutto nie darunter.
        let q = wall_quantities(v(0.0, 0.0), v(5.0, 0.0), &[&b1], &[], Some(99.0));
        assert!(close(get(&q, "NetVolume"), 99.0) && close(get(&q, "GrossVolume"), 99.0));
    }

    #[test]
    fn schraege_wand_ohne_hoehe() {
        let mut b = band([0.0, 0.0], [4.0, 0.0], 0.3, 0.0, 3.0);
        b.top_drop = Some([0.0, 1.0]);
        let q = wall_quantities(v(0.0, 0.0), v(4.0, 0.0), &[&b], &[], None);
        assert!(get(&q, "Height").is_none());
        assert!(close(get(&q, "GrossSideArea"), 4.0 * 2.5));
        assert!(close(get(&q, "GrossVolume"), 4.0 * 0.3 * 2.5));
    }

    #[test]
    fn loch_volumen() {
        let mut b = band([0.0, 0.0], [4.0, 0.0], 0.3, 0.0, 2.5);
        b.holes = Some(vec![RHole { from: 1.0, to: 2.0, z_bottom: 2.0, z_top: 3.0 }]);
        assert!((hole_volume(&[&b]) - 0.5 * 0.3).abs() < 1e-12);
    }

    #[test]
    fn platte_dach_stuetze_oeffnung() {
        let outline = [v(0.0, 0.0), v(10.0, 0.0), v(10.0, 5.0), v(0.0, 5.0)];
        let hole = [v(1.0, 1.0), v(2.0, 1.0), v(2.0, 2.0), v(1.0, 2.0)];
        let q = slab_quantities(&outline, &[&hole], 0.2);
        assert!(close(get(&q, "NetArea"), 49.0) && close(get(&q, "Perimeter"), 30.0) && close(get(&q, "GrossVolume"), 10.0));
        // Satteldach-Hälfte: 10 × 5 m Grundriss, 3 m hoch.
        let plane = vec![[0.0, 0.0, 0.0], [10.0, 0.0, 0.0], [10.0, 5.0, 3.0], [0.0, 5.0, 3.0]];
        let q = roof_quantities(&[plane]);
        assert!(close(get(&q, "ProjectedArea"), 50.0));
        assert!(close(get(&q, "GrossArea"), 10.0 * 34f64.sqrt()));
        let q = column_quantities(&[v(0.0, 0.0), v(0.3, 0.0), v(0.3, 0.3), v(0.0, 0.3)], 2.5);
        assert!(close(get(&q, "NetVolume"), 0.225));
        let q = opening_quantities(f64::NAN, 2.0);
        assert_eq!(get(&q, "Width"), Some(0.0));
        assert!(close(get(&q, "Perimeter"), 4.0));
        assert_eq!(flight_quantities(-1.0, 2.0)[0].value, 0.0);
        assert_eq!(railing_quantities(3.0)[0].value, 3.0);
    }
}
