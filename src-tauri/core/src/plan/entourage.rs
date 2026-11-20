//! [253] Entourage (Person, Auto, Velo, Bank, Tische mit Stühlen; Netze aus `furniture_3d.rs`) in Schnitt und Ansicht.
//!
//! Wie die Bäume ([149], `trees.rs`): je Bibliotheksobjekt und Teilnetz der Umriss (konvexe Hülle der Eckpunkte in der
//! Ebene) als Silhouette, in der Tiefe des Objekts. Ansicht: Teile gefüllt (Farbe des Netzteils, Tusche: weiss), sie
//! zeichnen in der Maler-Reihenfolge der Ansicht; Schnitt: nur Umriss (die Verdecker der Projektion kürzen ihn wie den der
//! Baumkrone, `trees::occlude_in_section`). Klasse, Ausblenden und Pick (`drawing_id`) sind die der Zeichnung ([180]).
//! Objekte, deren Mitte vor der Schnittebene liegt, entfallen im Schnitt (nicht geschnitten, sondern ganz weggelassen).

use super::prim::Primitive;
use super::section::{LevelSpec, Visibility};
use crate::model::*;

const VIEW_INK: &str = "#2b3039";
const VIEW_MM: f64 = 0.13;

fn hex(c: [f64; 3]) -> String {
    let b = |x: f64| (x.clamp(0.0, 1.0) * 255.0).round() as u8;
    format!("#{:02x}{:02x}{:02x}", b(c[0]), b(c[1]), b(c[2]))
}

/// Entourage in Schnitt/Ansicht: je Objekt (Tiefe der Mitte, Silhouetten seiner Teile, weit entfernte zuerst).
/// `filled`: Ansicht (gefüllte Teile; `mono` = weiss) statt Schnitt (nur Umriss, Objekte vor der Ebene entfallen).
pub fn view_entourage(p: &Project, level: &LevelSpec, vis: &Visibility, filled: bool, mono: bool) -> Vec<(f64, Vec<Primitive>)> {
    let Some(plane) = level.plane() else { return vec![] };
    let [nx, _, nz] = plane.normal;
    let nl = nx.hypot(nz);
    if !(nl > 0.0) {
        return vec![];
    }
    // Wie `trees::view_trees_in_front`: Ebene durch (p0.x, ·, p0.y), u = Blick-Rechts.
    let (nx, nz) = (nx / nl, nz / nl);
    let (ux, uz) = (nz, -nx);
    let (px, pz) = (plane.point[0], plane.point[2]);
    let mut out = Vec::new();
    for (i, parts) in crate::furniture_3d::placed(p) {
        let d = &p.drawings2d[i];
        if vis.has_vis && !vis.visible(&d.category_code) || vis.has_display && !vis.render(&d.category_code) {
            continue;
        }
        let greyed = Some(vis.has_display && vis.greyed(&d.category_code));
        // [312] Schnitt mit Netzkanten (`vis.entourage_meshes`): Möbel nur als Pick-Fläche (Kanten kommen aus der Projektion),
        // Personen als eine Silhouette (Vereinigung der Teile, keine inneren Kanten).
        let person = matches!(&d.geom, Drawing2DGeom::Libobj { lib_id, .. } if crate::furniture_3d::is_person(lib_id));
        let edges = !filled && vis.entourage_meshes && !person;
        let mut shapes: Vec<(f64, Vec<Vec2>, String)> = Vec::new();
        let (mut dsum, mut dn) = (0.0, 0usize);
        let (mut dmin, mut dmax) = (f64::INFINITY, f64::NEG_INFINITY);
        for m in &parts {
            let pts: Vec<[f64; 2]> = m.positions.chunks_exact(3).map(|q| [(q[0] - px) * ux + (q[1] - pz) * uz, q[2]]).collect();
            let depths: Vec<f64> = m.positions.chunks_exact(3).map(|q| (q[0] - px) * nx + (q[1] - pz) * nz).collect();
            let hull = crate::sun::hull(&pts);
            if hull.len() < 3 || depths.is_empty() {
                continue;
            }
            let mean = depths.iter().sum::<f64>() / depths.len() as f64;
            dsum += depths.iter().sum::<f64>();
            dn += depths.len();
            dmin = depths.iter().fold(dmin, |a, &b| a.min(b));
            dmax = depths.iter().fold(dmax, |a, &b| a.max(b));
            let fill = if !filled { "none".to_string() } else if mono { "#ffffff".to_string() } else { hex(m.color) };
            shapes.push((mean, hull.iter().map(|q| Vec2 { x: q[0], y: q[1] }).collect(), fill));
        }
        if dn == 0 || !(dsum / dn as f64).is_finite() {
            continue;
        }
        let depth = dsum / dn as f64;
        // Schnitt: nur, was hinter der Ebene liegt; Ansichtstiefe wie bei Bäumen.
        if !filled && depth < 0.0 || dmax < 0.0 || level.depth.is_some_and(|l| l > 0.0 && dmin > l) {
            continue;
        }
        // Ferne Teile zuerst (Maler-Reihenfolge innerhalb des Objekts).
        shapes.sort_by(|a, b| b.0.total_cmp(&a.0));
        if person && !filled {
            let polys: Vec<crate::flat::Polygon> = shapes.iter().map(|s| vec![s.1.iter().map(|q| [q.x, q.y]).collect()]).collect();
            let mean = shapes.iter().map(|s| s.0).sum::<f64>() / shapes.len().max(1) as f64;
            let merged = crate::polygon_bool::union(&polys);
            if !merged.is_empty() {
                shapes = merged.into_iter().filter_map(|pg| pg.into_iter().next()).map(|r| (mean, r.iter().map(|q| Vec2 { x: q[0], y: q[1] }).collect(), "none".to_string())).collect();
            }
        }
        let prims = shapes
            .into_iter()
            .map(|(_, pts, fill)| {
                let mut q = super::trees::poly(pts, &fill, if edges { "none" } else { VIEW_INK }, if edges { 0.0 } else { VIEW_MM }, None, greyed);
                if let Primitive::Polygon { drawing_id, .. } = &mut q {
                    *drawing_id = Some(d.id.clone());
                }
                q
            })
            .collect();
        out.push((depth, prims));
    }
    out
}
