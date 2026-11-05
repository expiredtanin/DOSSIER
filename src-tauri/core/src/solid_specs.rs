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
    /// Schnittlinien `[px, py, dx, dy]` an Anfang/Ende (`RWall::start_cut`/`end_cut`, [108]).
    pub start_cut: Option<[f64; 4]>,
    pub end_cut: Option<[f64; 4]>,
}

impl<'a> WallIn<'a> {
    pub fn of(w: &'a RWall) -> Self {
        WallIn { start: w.start, end: w.end, thickness: w.thickness, height: w.height, base_elevation: w.base_elevation, holes: w.holes.as_deref().unwrap_or(&[]), start_cut: w.start_cut, end_cut: w.end_cut }
    }
}

/// Achsmass (ab Anfang) der Längskante mit Querversatz `o` auf der Schnittlinie `cut`, gesucht ab dem
/// Achsmass `base` (Anfang 0, Ende `len`) — wie `model3d::wall_footprint` (kein Treffer: `None`).
fn cut_param(start: [f64; 2], u: (f64, f64), len: f64, base: f64, o: f64, cut: [f64; 4]) -> Option<f64> {
    let (ux, uy) = u;
    let q = [start[0] + ux * base - uy * o, start[1] + uy * base + ux * o];
    let [cx, cy, ex, ey] = cut;
    let den = ux * ey - uy * ex;
    if den.abs() < 1e-12 {
        return None;
    }
    let t = ((cx - q[0]) * ey - (cy - q[1]) * ex) / den;
    (t.is_finite() && t.abs() < len).then_some(base + t)
}

/// Wand(schicht) als `extrudePlane`: Profil in der Wandebene, Ursprung auf einer Wandfläche,
/// Tiefe = Dicke. Mit Schnittlinien an den Enden ([108], Gehrung/schräger Stoss): `points` ist der
/// Ring auf der vorderen Fläche (+n), `pointsBack` derselbe Ring auf der hinteren (−n) — nur die
/// Stirn-Ecken liegen anders, das Grundriss-Viereck ist `model3d::wall_footprint`. truck baut daraus
/// einen Körper mit schrägen Stirnflächen, ohne Boolean. Öffnungen in der schrägen Endzone: rechtwinklig
/// wie bisher. `None` bei entarteter Wand.
pub fn wall_spec(w: &WallIn) -> Option<Value> {
    let dx = w.end[0] - w.start[0];
    let dy = w.end[1] - w.start[1];
    let len = hypot2(dx, dy);
    if len < MIN_THICKNESS || w.height < MIN_THICKNESS || w.thickness < MIN_THICKNESS {
        return None;
    }
    let ux = dx / len;
    let uy = dy / len;
    let h = w.thickness / 2.0;
    // Achsmasse der Stirn-Ecken an den Schnittlinien: [vorne (+n), hinten (−n)].
    let end_at = |cut: Option<[f64; 4]>, base: f64| -> [f64; 2] {
        let f = |o: f64| cut.and_then(|c| cut_param(w.start, (ux, uy), len, base, o, c)).unwrap_or(base);
        [f(h), f(-h)]
    };
    let oblique = |e: [f64; 2], base: f64| (e[0] - base).abs() > EPS || (e[1] - base).abs() > EPS;
    let mut a = end_at(w.start_cut, 0.0);
    let mut b = end_at(w.end_cut, len);
    let (mut cut_a, mut cut_b) = (oblique(a, 0.0), oblique(b, len));
    // Öffnung in einer schrägen Endzone: dort rechtwinklig (Profil-Ecken wären sonst verschoben).
    if cut_a && w.holes.iter().any(|q| q.from < max(a[0], a[1]) + EPS) {
        (a, cut_a) = ([0.0; 2], false);
    }
    if cut_b && w.holes.iter().any(|q| q.to > min(b[0], b[1]) - EPS) {
        (b, cut_b) = ([len; 2], false);
    }
    let u0 = if cut_a { min(a[0], a[1]) } else { 0.0 };
    let u1 = if cut_b { max(b[0], b[1]) } else { len };
    if u1 - u0 < MIN_THICKNESS || (cut_a || cut_b) && (b[0] - a[0] < MIN_THICKNESS || b[1] - a[1] < MIN_THICKNESS) {
        return None;
    }
    // u × v (v = +Z) = (uy, −ux, 0): Extrusionsrichtung. Ursprung = eine Wandfläche.
    let nx = uy;
    let ny = -ux;
    let shifted: Vec<RHole>;
    let holes = if u0 != 0.0 {
        shifted = w.holes.iter().map(|q| RHole { from: q.from - u0, to: q.to - u0, ..*q }).collect();
        &shifted[..]
    } else {
        w.holes
    };
    let (outer, holes) = wall_profile(u1 - u0, w.height, holes, w.base_elevation);
    let mut spec = json!({
        "kind": "extrudePlane",
        "points": outer,
        "holes": holes,
        "origin": [w.start[0] + ux * u0 - (nx * w.thickness) / 2.0, w.start[1] + uy * u0 - (ny * w.thickness) / 2.0, w.base_elevation],
        "uAxis": [ux, uy, 0.0],
        "vAxis": [0.0, 0.0, 1.0],
        "depth": w.thickness,
    });
    if cut_a || cut_b {
        // Ring: erstes und letztes Paar = Anfang (Fuss, Kopf), drittletztes und vorletztes = Ende.
        let n = outer.len() / 2;
        let ring = |k: usize| -> Vec<f64> {
            let mut r = outer.clone();
            for i in [0, n - 1] {
                r[2 * i] = a[k] - u0;
            }
            for i in [n - 3, n - 2] {
                r[2 * i] = b[k] - u0;
            }
            r
        };
        spec["points"] = json!(ring(0));
        spec["pointsBack"] = json!(ring(1));
    }
    Some(spec)
}

/// Wie [`wall_spec`], aber rechtwinklig (ohne Schnittlinien): Rückfall, wenn truck am Keil scheitert.
pub fn wall_spec_plain(w: &WallIn) -> Option<Value> {
    wall_spec(&WallIn { start_cut: None, end_cut: None, ..*w })
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

/// Bauteil minus alle Körper (verkettete Differenzen); Körper um `dz` angehoben (Explosion [65]).
fn subtract(base: Value, voids: &[&VoidPrism], dz: f64) -> Value {
    voids.iter().fold(base, |acc, v| {
        let pts: Vec<f64> = v.pts.iter().flat_map(|p| [p.x, p.y]).collect();
        json!({"kind": "boolean", "op": "difference", "a": acc, "b": {"kind": "extrude", "points": pts, "height": v.z1 - v.z0, "z0": v.z0 + dz}})
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
    void_cuts_lifted(p, walls, slabs, &|_| 0.0, &|_| 0.0)
}

/// Wie [`void_cuts`] für ein auseinandergezogenes Modell ([65], `explode3d.rs`): Bauteil `i` liegt um
/// `wall_dz(i)` bzw. `slab_dz(i)` höher als im Modell. Getroffen wird am ursprünglichen Ort, der Körper
/// wandert mit dem Bauteil (ein geschossübergreifender Körper schneidet so jedes Geschoss für sich).
pub fn void_cuts_lifted(p: &Project, walls: &[RWall], slabs: &[RSlab], wall_dz: &dyn Fn(usize) -> f64, slab_dz: &dyn Fn(usize) -> f64) -> VoidCuts {
    let voids = void_prisms(p);
    let mut out = VoidCuts::default();
    if voids.is_empty() {
        return out;
    }
    for (i, w) in walls.iter().enumerate() {
        let dz = wall_dz(i);
        let hits = hitting(&voids, &bbox(wall_corners(w).into_iter()), w.base_elevation - dz, w.base_elevation + w.height - dz);
        if hits.is_empty() {
            continue;
        }
        if let Some(base) = wall_spec(&WallIn::of(w)) {
            out.walls.push((i, subtract(base, &hits, dz)));
        }
    }
    for (i, s) in slabs.iter().enumerate() {
        if s.outline.len() < 3 {
            continue;
        }
        let dz = slab_dz(i);
        let hits = hitting(&voids, &bbox(s.outline.iter().map(|q| (q[0], q[1]))), s.z_bottom - dz, s.z_top - dz);
        if hits.is_empty() {
            continue;
        }
        let pts: Vec<f64> = s.outline.iter().flat_map(|q| [q[0], q[1]]).collect();
        let base = json!({"kind": "extrude", "points": pts, "height": s.z_top - s.z_bottom, "z0": s.z_bottom});
        out.slabs.push((i, subtract(base, &hits, dz)));
    }
    out
}

/// Alle Bauteile des Projekts als B-Rep-Spezifikationen für den STEP-Export (früher `projectSolidSpecs` in
/// `export/exportStep.ts`): Wände (je Materiallage) und Decken samt „Bauteil − Abzugskörper", Dachflächen als
/// Platten der Gesamt-Schichtdicke, Extrusionskörper (ohne Abzugskörper). `fallbacks`: (Index in `specs`,
/// Bauteil ohne Abzug) — scheitert truck am Boolean, exportiert TS das Bauteil ungeschnitten.
#[derive(serde::Serialize, Default, Debug)]
pub struct ProjectSpecs {
    pub specs: Vec<Value>,
    pub fallbacks: Vec<(usize, Value)>,
}

type V3 = [f64; 3];
fn sub3(a: V3, b: V3) -> V3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
fn dot3(a: V3, b: V3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
fn cross3(a: V3, b: V3) -> V3 {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

/// Platte einer ebenen Dachfläche (`pts` ≥ 3 Ecken) der Dicke `total` nach unten; `None` bei entarteter Fläche.
fn roof_plane_spec(p: &[V3], total: f64) -> Option<Value> {
    if p.len() < 3 {
        return None;
    }
    let (e1, e2) = (sub3(p[1], p[0]), sub3(p[2], p[0]));
    let mut n = cross3(e1, e2);
    let nl = crate::jsmath::hypot(&n);
    if nl < EPS {
        return None;
    }
    n = [n[0] / nl, n[1] / nl, n[2] / nl];
    if n[2] < 0.0 {
        n = [-n[0], -n[1], -n[2]]; // Normale nach oben
    }
    let el = crate::jsmath::hypot(&e1);
    let u = [e1[0] / el, e1[1] / el, e1[2] / el];
    let v = cross3(n, u); // u × v = n
    let pts: Vec<f64> = p
        .iter()
        .flat_map(|q| {
            let d = sub3(*q, p[0]);
            [dot3(d, u), dot3(d, v)]
        })
        .collect();
    Some(json!({"kind": "extrudePlane", "points": pts, "origin": p[0], "uAxis": u, "vAxis": v, "depth": -total}))
}

pub fn project_solid_specs(p: &Project) -> Result<ProjectSpecs, String> {
    let mut out = ProjectSpecs::default();
    // Detail „fein", geschichtete Wände.
    let parts = crate::model3d::parts(p, true, 2.0, false)?;
    let cuts = void_cuts(p, &parts.walls, &parts.slabs);
    let wall_cut: std::collections::HashMap<usize, Value> = cuts.walls.into_iter().collect();
    let slab_cut: std::collections::HashMap<usize, Value> = cuts.slabs.into_iter().collect();
    let push = |out: &mut ProjectSpecs, base: Value, cut: Option<&Value>| match cut {
        Some(c) => {
            out.fallbacks.push((out.specs.len(), base));
            out.specs.push(c.clone());
        }
        None => out.specs.push(base),
    };
    for (i, w) in parts.walls.iter().enumerate() {
        let win = WallIn::of(w);
        if let Some(s) = wall_spec(&win) {
            match wall_cut.get(&i) {
                // Abzug ist ein Boolean: Rückfall ohne Abzug und rechtwinklig.
                Some(c) => push(&mut out, wall_spec_plain(&win).unwrap_or(s), Some(c)),
                // Schräge Stirnflächen ([108]): Rückfall rechtwinklig, falls truck sie nicht baut.
                None if s.get("pointsBack").is_some() => {
                    if let Some(plain) = wall_spec_plain(&win) {
                        out.fallbacks.push((out.specs.len(), plain));
                    }
                    out.specs.push(s);
                }
                None => out.specs.push(s),
            }
        }
    }
    for (i, s) in parts.slabs.iter().enumerate() {
        if s.outline.len() < 3 || s.z_top - s.z_bottom < MIN_THICKNESS {
            continue;
        }
        let pts: Vec<f64> = s.outline.iter().flat_map(|q| [q[0], q[1]]).collect();
        push(&mut out, json!({"kind": "extrude", "points": pts, "height": s.z_top - s.z_bottom, "z0": s.z_bottom}), slab_cut.get(&i));
    }
    for roof in p.roofs.as_deref().unwrap_or(&[]) {
        let total: f64 = p.roof_layers(roof).iter().map(|l| max(0.0, l.thickness)).sum();
        if total < MIN_THICKNESS {
            continue;
        }
        let g = crate::roof::roof_geometry(&roof.params(), p.roof_base_elevation(roof));
        out.specs.extend(g.planes.iter().filter_map(|pl| roof_plane_spec(pl, total)));
    }
    for solid in p.extruded_solids.as_deref().unwrap_or(&[]) {
        if solid.operation.as_deref() == Some("subtract") {
            continue; // Abzugskörper sind kein Material
        }
        let base_z = if solid.level_id.is_empty() { 0.0 } else { p.floor(&solid.level_id).map_or(0.0, |f| f.base_elevation.unwrap_or(0.0)) };
        let v = serde_json::to_value(solid).map_err(|e| e.to_string())?;
        if let Some(spec) = crate::cmd_solid::extruded_solid_spec(&v, base_z) {
            out.specs.push(spec);
        }
    }
    Ok(out)
}

/// Flache Wand für die Bindung: `[sx, sy, ex, ey, Dicke, Höhe, UK, hatAnfang, px, py, dx, dy, hatEnde,
/// px, py, dx, dy, (von, bis, UK, OK) × n]` (Schnittlinien [108]; ohne: Flag 0, Werte beliebig).
pub fn wall_spec_flat(f: &[f64]) -> String {
    if f.len() < 17 || (f.len() - 17) % 4 != 0 || f.iter().any(|x| !x.is_finite()) {
        return String::new();
    }
    let cut = |i: usize| (f[i] != 0.0).then(|| [f[i + 1], f[i + 2], f[i + 3], f[i + 4]]);
    let holes: Vec<RHole> = f[17..].chunks_exact(4).map(|c| RHole { from: c[0], to: c[1], z_bottom: c[2], z_top: c[3] }).collect();
    let w = WallIn { start: [f[0], f[1]], end: [f[2], f[3]], thickness: f[4], height: f[5], base_elevation: f[6], holes: &holes, start_cut: cut(7), end_cut: cut(12) };
    wall_spec(&w).map_or_else(String::new, |v| v.to_string())
}

#[cfg(test)]
pub(crate) mod tests {
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
        let none = [0.0; 10];
        assert_eq!(wall_spec_flat(&[&[0.0, 0.0, 0.0, 0.0, 0.2, 2.5, 0.0], &none[..]].concat()), "");
        assert_eq!(wall_spec_flat(&[0.0, 0.0, 1.0]), "");
        assert_eq!(wall_spec_flat(&[&[0.0, 0.0, 4.0, 0.0, 0.2, 2.5, f64::NAN], &none[..]].concat()), "");
        let v: Value = serde_json::from_str(&wall_spec_flat(&[&[0.0, 0.0, 4.0, 0.0, 0.2, 2.5, 1.0], &none[..]].concat())).unwrap();
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

    fn sample() -> Value {
        serde_json::from_str(include_str!("../tests/fixtures/sample_project.json")).unwrap()
    }

    #[test]
    fn projekt_specs_wand_decke_dach_koerper() {
        let mut v = sample();
        v["extrudedSolids"] = json!([
            {"id": "k1", "type": "extrudedSolid", "levelId": "eg", "height": 1.0,
             "points": [{"x": 0.0, "y": 0.0}, {"x": 1.0, "y": 0.0}, {"x": 1.0, "y": 1.0}, {"x": 0.0, "y": 1.0}]},
            {"id": "k2", "type": "extrudedSolid", "levelId": "eg", "operation": "subtract", "height": 1.0,
             "points": [{"x": 0.0, "y": 0.0}, {"x": 1.0, "y": 0.0}, {"x": 1.0, "y": 1.0}, {"x": 0.0, "y": 1.0}]}
        ]);
        let p: Project = serde_json::from_value(v).unwrap();
        let r = project_solid_specs(&p).unwrap();
        let n_plane = r.specs.iter().filter(|s| s["kind"] == "extrudePlane").count();
        let n_extrude = r.specs.iter().filter(|s| s["kind"] == "extrude").count();
        assert!(n_plane > 10, "Wandlagen + Dachflächen: {n_plane}");
        assert!(n_extrude > 1, "Decken + Körper");
        // Rückfall nur dort, wo der Entwurf einen Abzug trifft (Boolean-Spezifikation an dieser Stelle),
        // oder für schräge Stirnflächen ([108]).
        assert!(r.fallbacks.iter().all(|(i, _)| r.specs[*i]["kind"] == "boolean" || r.specs[*i].get("pointsBack").is_some()));
        // Nur der additive Körper (k1) kommt dazu, der Abzugskörper (k2) nicht.
        let base: Project = serde_json::from_value(sample()).unwrap();
        let n0 = project_solid_specs(&base).unwrap().specs.len();
        assert_eq!(r.specs.len(), n0 + 1);
    }

    #[test]
    fn projekt_specs_abzug_gibt_rueckfall_ohne_schnitt() {
        let mut v = sample();
        v["extrudedSolids"] = json!([{"id": "v1", "type": "extrudedSolid", "levelId": "eg", "operation": "subtract", "height": 1.0, "baseOffset": 1.0,
            "points": [{"x": -100.0, "y": -100.0}, {"x": 100.0, "y": -100.0}, {"x": 100.0, "y": 100.0}, {"x": -100.0, "y": 100.0}]}]);
        let p: Project = serde_json::from_value(v).unwrap();
        let r = project_solid_specs(&p).unwrap();
        assert!(!r.fallbacks.is_empty());
        for (i, base) in &r.fallbacks {
            assert!(r.specs[*i]["kind"] == "boolean" || r.specs[*i].get("pointsBack").is_some());
            assert_ne!(base["kind"], "boolean");
            assert!(base.get("pointsBack").is_none());
        }
    }

    #[test]
    fn dachflaeche_entartet_gibt_keine_platte() {
        let line: Vec<V3> = vec![[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [2.0, 0.0, 0.0]];
        assert!(roof_plane_spec(&line, 0.2).is_none());
        assert!(roof_plane_spec(&line[..2], 0.2).is_none());
        let tri: Vec<V3> = vec![[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]];
        let s = roof_plane_spec(&tri, 0.2).unwrap();
        assert_eq!(s["depth"], json!(-0.2));
        assert_eq!(s["vAxis"], json!([0.0, 1.0, 0.0]));
    }

    /// [108] Schräges L (60°) aus zwei Wänden, 0.3 m dick, 2.5 m hoch, Achslängen 4 m und 3 m.
    pub(crate) fn schraeges_l() -> Project {
        serde_json::from_value(json!({
            "id": "p", "name": "t", "lineStyles": [], "hatches": [], "layers": [], "drawings2d": [],
            "wallTypes": [{"id": "aw", "name": "AW", "layers": [{"componentId": "c", "thickness": 0.3}]}], "components": [{"id": "c", "name": "C"}],
            "drawingLevels": [{"id": "F", "name": "EG", "kind": "floor", "visible": true, "locked": false, "floorHeight": 3.0, "baseElevation": 0}],
            "walls": [
                {"id": "A", "type": "wall", "floorId": "F", "categoryCode": "20", "start": {"x": 4, "y": 0}, "end": {"x": 0, "y": 0}, "height": 2.5, "wallTypeId": "aw"},
                {"id": "B", "type": "wall", "floorId": "F", "categoryCode": "20", "start": {"x": 0, "y": 0}, "end": {"x": 1.5, "y": 2.598076211353316}, "height": 2.5, "wallTypeId": "aw"}
            ]
        }))
        .unwrap()
    }

    /// Grundriss eines Wand-Spec (`extrudePlane` mit senkrechter vAxis; mit `pointsBack` schräge Stirn):
    /// Fuss-Ecken vorne Anfang/Ende, hinten Ende/Anfang, plus Höhe.
    fn spec_footprint(s: &Value) -> (Vec<[f64; 2]>, f64) {
        let f = |v: &Value| v.as_f64().unwrap();
        assert_eq!(s["kind"], "extrudePlane");
        let o = [f(&s["origin"][0]), f(&s["origin"][1])];
        let u = [f(&s["uAxis"][0]), f(&s["uAxis"][1])];
        let d = f(&s["depth"]);
        let e = [u[1] * d, -u[0] * d];
        let ends = |k: &str| {
            let r: Vec<f64> = s[k].as_array().unwrap().iter().map(f).collect();
            let n = r.len() / 2;
            assert_eq!(r[2 * (n - 1)], r[0], "Anfang Fuss/Kopf gleich");
            (r[0], r[2 * (n - 3)])
        };
        let (fa, fb) = ends("points");
        let (ba, bb) = if s.get("pointsBack").is_some() { ends("pointsBack") } else { (fa, fb) };
        let pts: Vec<f64> = s["points"].as_array().unwrap().iter().map(f).collect();
        let h = pts.chunks(2).map(|c| c[1]).fold(0.0, f64::max);
        let at = |t: f64, k: f64| [o[0] + u[0] * t + e[0] * k, o[1] + u[1] * t + e[1] * k];
        (vec![at(fa, 0.0), at(fb, 0.0), at(bb, 1.0), at(ba, 1.0)], h)
    }

    fn area(p: &[[f64; 2]]) -> f64 {
        (0..p.len()).map(|i| p[i][0] * p[(i + 1) % p.len()][1] - p[(i + 1) % p.len()][0] * p[i][1]).sum::<f64>().abs() / 2.0
    }

    /// [108] Truck-Körper am schrägen L: Gehrung statt Quader; Volumen = Dicke × Höhe × (L1 + L2).
    #[test]
    fn schraeges_l_gehrung_im_truck_koerper() {
        let p = schraeges_l();
        let walls = crate::model3d::emit_walls(&p, true).unwrap();
        assert_eq!(walls.len(), 2);
        let mut vol = 0.0;
        for w in &walls {
            let s = wall_spec(&WallIn::of(w)).unwrap();
            assert!(s.get("pointsBack").is_some(), "{}: schräge Stirn", w.wall_id);
            let (fp, h) = spec_footprint(&s);
            // Gleiche Ecken wie der Kern-3D-Körper.
            for q in crate::model3d::wall_footprint(w).unwrap() {
                assert!(fp.iter().any(|c| (c[0] - q[0]).abs() < 1e-9 && (c[1] - q[1]).abs() < 1e-9), "{}: Ecke {q:?} fehlt in {fp:?}", w.wall_id);
            }
            assert!((area(&fp) * h - crate::model3d::wall_piece_volume(w)).abs() < 1e-9);
            vol += area(&fp) * h;
        }
        assert!((vol - 0.3 * 2.5 * 7.0).abs() < 1e-9, "{vol}");
        // STEP/Kennwerte: Rückfall rechtwinklig, falls truck am Keil scheitert.
        let specs = project_solid_specs(&p).unwrap();
        assert_eq!(specs.fallbacks.len(), 2);
        assert!(specs.fallbacks[0].1.get("pointsBack").is_none());
        // Flache Bindung: Schnittlinien übertragen.
        let w = &walls[0];
        let c = w.end_cut.unwrap();
        let flat = [w.start[0], w.start[1], w.end[0], w.end[1], w.thickness, w.height, w.base_elevation, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, c[0], c[1], c[2], c[3]];
        assert_eq!(serde_json::from_str::<Value>(&wall_spec_flat(&flat)).unwrap(), wall_spec(&WallIn::of(w)).unwrap());
        assert_eq!(wall_spec_flat(&flat[..7]), "");
    }

    /// [108] Gehrung mit Fenster: Löcher bleiben an ihrer Achslage (Profil verschoben).
    #[test]
    fn gehrung_verschiebt_loecher_mit() {
        let holes = [RHole { from: 1.0, to: 2.0, z_bottom: 0.9, z_top: 2.1 }];
        // Wand entlang +x, Anfang mit Gehrung nach aussen: Kante +n endet bei u = −0.2.
        let w = WallIn { start: [0.0, 0.0], end: [4.0, 0.0], thickness: 0.2, height: 2.5, base_elevation: 0.0, holes: &holes, start_cut: Some([0.0, 0.0, -1.0, 1.0]), end_cut: None };
        let s = wall_spec(&w).unwrap();
        assert_eq!(s["origin"][0], json!(-0.1));
        assert_eq!(s["holes"][0], json!([1.1, 0.9, 2.1, 0.9, 2.1, 2.1, 1.1, 2.1]));
        // Vorne (+n) beginnt die Kante bei u = −0.1, hinten bei +0.1 (Profil ab −0.1).
        assert_eq!(s["points"][0], json!(0.0));
        assert_eq!(s["pointsBack"][0], json!(0.2));
        let (fp, _) = spec_footprint(&s);
        assert!((area(&fp) - 4.0 * 0.2).abs() < 1e-12);
        // Fenster in der Endzone: rechtwinklig wie bisher.
        let near = [RHole { from: 0.05, to: 1.0, z_bottom: 0.9, z_top: 2.1 }];
        let s = wall_spec(&WallIn { holes: &near, ..w }).unwrap();
        assert!(s.get("pointsBack").is_none() && s["origin"][0] == json!(0.0));
    }
}
