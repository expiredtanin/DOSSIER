//! B-Rep-Spezifikationen der Bauteile für truck (früher `plan/wallSpec.ts`, `plan/voids.ts` 3D-Teil,
//! `plan/toWalls3d/voids3d.ts`): Wandprofil mit Öffnungen, Wand als `extrudePlane`, und die
//! Abzugskörper im 3D — jede Wand und Decke, die ein Abzugskörper trifft, als verkettete Differenz.
//! Die Spezifikationen gehen als JSON an truck (`SolidSpec` in `engine/truckSolid.ts`); Rechnung und
//! Reihenfolge wie in TS (bitgleich, `jsnum`/`jsmath`).

use crate::jsmath::hypot2;
use crate::jsnum::{max, min};
use crate::model::Vec2;
use crate::model3d::{RHole, RSlab, RWall};
use crate::plan::extras::{void_prisms, VoidPrism};
use crate::model::Project;
use serde_json::{json, Value};

const EPS: f64 = 1e-6;
/// Schicht/Öffnung so dünn, dass sie als nicht vorhanden gilt.
const MIN_THICKNESS: f64 = 1e-4;

/// Wandprofil (u = Achse, v = Höhe über Wandfuss) mit Öffnungen: Löcher, die ganz im Profil liegen;
/// Öffnungen am Wandfuss (Türen) als Kerben im Aussenring. Öffnungen am Wandkopf werden um 1 mm
/// gekappt (ein Loch darf den Rand nicht berühren). Ergebnis: (Aussenring, Löcher), flach u,v.
pub fn wall_profile(length: f64, height: f64, holes: &[RHole], base_elevation: f64) -> (Vec<f64>, Vec<Vec<f64>>) {
    let mut inner: Vec<Vec<f64>> = Vec::new();
    let mut notches: Vec<[f64; 3]> = Vec::new();
    let cut = 1e-3;
    for h in holes {
        let u0 = max(0.0, min(length, h.from));
        let u1 = max(0.0, min(length, h.to));
        if u1 - u0 < MIN_THICKNESS {
            continue;
        }
        let v0 = h.z_bottom - base_elevation;
        let v1 = min(height - cut, h.z_top - base_elevation);
        if v1 - max(v0, 0.0) < MIN_THICKNESS {
            continue;
        }
        if v0 <= cut {
            notches.push([u0, u1, v1]);
        } else {
            inner.push(vec![u0, v0, u1, v0, u1, v1, u0, v1]);
        }
    }
    // Kerben sortieren (stabil, wie `Array.sort`) und überlappende zusammenfassen.
    notches.sort_by(|a, b| (a[0] - b[0]).partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal));
    let mut merged: Vec<[f64; 3]> = Vec::new();
    for n in notches {
        match merged.last_mut() {
            Some(last) if n[0] <= last[1] + EPS => {
                last[1] = max(last[1], n[1]);
                last[2] = max(last[2], n[2]);
            }
            _ => merged.push(n),
        }
    }
    // Aussenring CCW in (u,v): Wandfuss links→rechts mit Kerben, dann Kopf rechts→links.
    let mut outer = vec![0.0, 0.0];
    for [a, b, top] in merged {
        outer.extend_from_slice(&[a, 0.0, a, top, b, top, b, 0.0]);
    }
    outer.extend_from_slice(&[length, 0.0, length, height, 0.0, height]);
    (outer, inner)
}

/// Eingabe von [`wall_spec`]: Achse, Dicke, Höhe, UK, Öffnungen (Teil von `RWall`).
pub struct WallIn<'a> {
    pub start: [f64; 2],
    pub end: [f64; 2],
    pub thickness: f64,
    pub height: f64,
    pub base_elevation: f64,
    pub holes: &'a [RHole],
}

impl<'a> WallIn<'a> {
    pub fn of(w: &'a RWall) -> Self {
        WallIn { start: w.start, end: w.end, thickness: w.thickness, height: w.height, base_elevation: w.base_elevation, holes: w.holes.as_deref().unwrap_or(&[]) }
    }
}

/// Wand(schicht) als `extrudePlane`: Profil in der Wandebene, Ursprung auf einer Wandfläche,
/// Tiefe = Dicke. `None` bei entarteter Wand.
pub fn wall_spec(w: &WallIn) -> Option<Value> {
    let dx = w.end[0] - w.start[0];
    let dy = w.end[1] - w.start[1];
    let len = hypot2(dx, dy);
    if len < MIN_THICKNESS || w.height < MIN_THICKNESS || w.thickness < MIN_THICKNESS {
        return None;
    }
    let ux = dx / len;
    let uy = dy / len;
    // u × v (v = +Z) = (uy, −ux, 0): Extrusionsrichtung. Ursprung = eine Wandfläche.
    let nx = uy;
    let ny = -ux;
    let (outer, holes) = wall_profile(len, w.height, w.holes, w.base_elevation);
    Some(json!({
        "kind": "extrudePlane",
        "points": outer,
        "holes": holes,
        "origin": [w.start[0] - (nx * w.thickness) / 2.0, w.start[1] - (ny * w.thickness) / 2.0, w.base_elevation],
        "uAxis": [ux, uy, 0.0],
        "vAxis": [0.0, 0.0, 1.0],
        "depth": w.thickness,
    }))
}

/// Achsparallele Hülle (x0, y0, x1, y1) wie `Math.min(...)`/`Math.max(...)`.
fn bbox(pts: impl Iterator<Item = (f64, f64)>) -> [f64; 4] {
    let mut b = [f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY];
    for (x, y) in pts {
        b[0] = min(b[0], x);
        b[1] = min(b[1], y);
        b[2] = max(b[2], x);
        b[3] = max(b[3], y);
    }
    b
}

fn box_hit(a: &[f64; 4], b: &[f64; 4]) -> bool {
    a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3]
}

/// Grundriss-Ecken einer Wand(schicht).
fn wall_corners(w: &RWall) -> [(f64, f64); 4] {
    let dx = w.end[0] - w.start[0];
    let dy = w.end[1] - w.start[1];
    let h = hypot2(dx, dy);
    // `|| 1`: 0 und NaN gelten als falsch.
    let len = if h == 0.0 || h.is_nan() { 1.0 } else { h };
    let nx = (-dy / len) * (w.thickness / 2.0);
    let ny = (dx / len) * (w.thickness / 2.0);
    [
        (w.start[0] + nx, w.start[1] + ny),
        (w.end[0] + nx, w.end[1] + ny),
        (w.end[0] - nx, w.end[1] - ny),
        (w.start[0] - nx, w.start[1] - ny),
    ]
}

/// Abzugskörper, die ein Prisma (Grundriss-Hülle + Höhenbereich) treffen.
fn hitting<'a>(voids: &'a [VoidPrism], foot: &[f64; 4], z0: f64, z1: f64) -> Vec<&'a VoidPrism> {
    voids
        .iter()
        .filter(|v| v.z0 < z1 - 1e-6 && v.z1 > z0 + 1e-6 && box_hit(&bbox(v.pts.iter().map(|p: &Vec2| (p.x, p.y))), foot))
        .collect()
}

/// Bauteil minus alle Körper (verkettete Differenzen).
fn subtract(base: Value, voids: &[&VoidPrism]) -> Value {
    voids.iter().fold(base, |acc, v| {
        let pts: Vec<f64> = v.pts.iter().flat_map(|p| [p.x, p.y]).collect();
        json!({"kind": "boolean", "op": "difference", "a": acc, "b": {"kind": "extrude", "points": pts, "height": v.z1 - v.z0, "z0": v.z0}})
    })
}

/// Bauteile des 3D-Modells, die ein Abzugskörper trifft: (Index im Modell, Spezifikation Bauteil −
/// Körper). TS tesselliert sie über truck und ersetzt das Bauteil durch das Mesh.
#[derive(serde::Serialize, Default, Debug)]
pub struct VoidCuts {
    pub walls: Vec<(usize, Value)>,
    pub slabs: Vec<(usize, Value)>,
}

/// Abzugskörper auf Wände und Decken des Modells anwenden (früher `applyVoids3d`, Spezifikationsteil).
pub fn void_cuts(p: &Project, walls: &[RWall], slabs: &[RSlab]) -> VoidCuts {
    let voids = void_prisms(p);
    let mut out = VoidCuts::default();
    if voids.is_empty() {
        return out;
    }
    for (i, w) in walls.iter().enumerate() {
        let hits = hitting(&voids, &bbox(wall_corners(w).into_iter()), w.base_elevation, w.base_elevation + w.height);
        if hits.is_empty() {
            continue;
        }
        if let Some(base) = wall_spec(&WallIn::of(w)) {
            out.walls.push((i, subtract(base, &hits)));
        }
    }
    for (i, s) in slabs.iter().enumerate() {
        if s.outline.len() < 3 {
            continue;
        }
        let hits = hitting(&voids, &bbox(s.outline.iter().map(|q| (q[0], q[1]))), s.z_bottom, s.z_top);
        if hits.is_empty() {
            continue;
        }
        let pts: Vec<f64> = s.outline.iter().flat_map(|q| [q[0], q[1]]).collect();
        let base = json!({"kind": "extrude", "points": pts, "height": s.z_top - s.z_bottom, "z0": s.z_bottom});
        out.slabs.push((i, subtract(base, &hits)));
    }
    out
}

/// Flache Wand für die Bindung: `[sx, sy, ex, ey, Dicke, Höhe, UK, (von, bis, UK, OK) × n]`.
pub fn wall_spec_flat(f: &[f64]) -> String {
    if f.len() < 7 || (f.len() - 7) % 4 != 0 {
        return String::new();
    }
    let holes: Vec<RHole> = f[7..].chunks_exact(4).map(|c| RHole { from: c[0], to: c[1], z_bottom: c[2], z_top: c[3] }).collect();
    let w = WallIn { start: [f[0], f[1]], end: [f[2], f[3]], thickness: f[4], height: f[5], base_elevation: f[6], holes: &holes };
    wall_spec(&w).map_or_else(String::new, |v| v.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hole(from: f64, to: f64, zb: f64, zt: f64) -> RHole {
        RHole { from, to, z_bottom: zb, z_top: zt }
    }

    #[test]
    fn profil_tuer_als_kerbe_fenster_als_loch() {
        let (outer, holes) = wall_profile(5.0, 2.6, &[hole(1.0, 2.0, 0.0, 2.1), hole(3.0, 4.0, 0.9, 2.1)], 0.0);
        assert_eq!(outer, vec![0.0, 0.0, 1.0, 0.0, 1.0, 2.1, 2.0, 2.1, 2.0, 0.0, 5.0, 0.0, 5.0, 2.6, 0.0, 2.6]);
        assert_eq!(holes, vec![vec![3.0, 0.9, 4.0, 0.9, 4.0, 2.1, 3.0, 2.1]]);
    }

    #[test]
    fn profil_kerben_verschmolzen_und_kopf_gekappt() {
        let (outer, _) = wall_profile(4.0, 2.5, &[hole(2.0, 3.0, 0.0, 2.0), hole(0.5, 2.2, 0.0, 2.6)], 0.0);
        assert_eq!(outer, vec![0.0, 0.0, 0.5, 0.0, 0.5, 2.499, 3.0, 2.499, 3.0, 0.0, 4.0, 0.0, 4.0, 2.5, 0.0, 2.5]);
    }

    #[test]
    fn wand_spec_entartet_und_flach() {
        assert_eq!(wall_spec_flat(&[0.0, 0.0, 0.0, 0.0, 0.2, 2.5, 0.0]), "");
        assert_eq!(wall_spec_flat(&[0.0, 0.0, 1.0]), "");
        let v: Value = serde_json::from_str(&wall_spec_flat(&[0.0, 0.0, 4.0, 0.0, 0.2, 2.5, 1.0])).unwrap();
        assert_eq!(v["kind"], "extrudePlane");
        assert_eq!(v["origin"], json!([0.0, 0.1, 1.0]));
        assert_eq!(v["depth"], json!(0.2));
    }

    #[test]
    fn abzug_trifft_nur_ueberlappende_bauteile() {
        let mut v: Value = serde_json::from_str(include_str!("../tests/fixtures/sample_project.json")).unwrap();
        v["extrudedSolids"] = json!([{"id": "v1", "type": "extrudedSolid", "levelId": "eg", "operation": "subtract", "height": 1.0, "baseOffset": 1.0,
            "points": [{"x": -100.0, "y": -100.0}, {"x": 100.0, "y": -100.0}, {"x": 100.0, "y": 100.0}, {"x": -100.0, "y": 100.0}]}]);
        let p: Project = serde_json::from_value(v).unwrap();
        let walls = crate::model3d::emit_walls(&p, true).unwrap();
        let slabs = crate::model3d::emit_slabs(&p);
        let c = void_cuts(&p, &walls, &slabs);
        assert!(!c.walls.is_empty());
        for (i, spec) in &c.walls {
            let w = &walls[*i];
            assert!(w.base_elevation < 2.0 && w.base_elevation + w.height > 1.0);
            assert_eq!(spec["kind"], "boolean");
            assert_eq!(spec["b"]["z0"], json!(p.floor("eg").and_then(|f| f.base_elevation).unwrap_or(0.0) + 1.0));
        }
    }
}
