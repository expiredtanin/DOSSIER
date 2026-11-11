//! Decken als Platten (`RSlab`) für 3D, Schnitt und Ansicht: Deckentyp und Schichten auflösen, Geometrie
//! aus `ceilings3d`, Farbe und Schraffur je Schicht (`emit_slabs()`). Aufgerufen von `parts()` (`mod.rs`),
//! dem Schnitt (`plan/section/`) und der Ansicht.

use super::*;

/// Deckentyp (id, Name, Schichten): Deckentyp, sonst Wandtyp (`getCeilingType`).
pub fn ceiling_type_ref<'a>(p: &'a Project, c: &Ceiling) -> Option<(&'a str, &'a str, &'a [Layer])> {
    if let Some(id) = c.ceiling_type_id.as_deref() {
        if let Some(t) = p.ceiling_types.as_deref().and_then(|v| v.iter().find(|t| t.id == id)) {
            return Some((&t.id, &t.name, &t.layers));
        }
    }
    p.wall_types.iter().find(|t| t.id == c.wall_type_id).map(|t| (t.id.as_str(), t.name.as_str(), t.layers.as_slice()))
}

pub(super) fn ceiling_layers<'a>(p: &'a Project, c: &Ceiling) -> Option<&'a [Layer]> {
    if let Some(id) = c.ceiling_type_id.as_deref() {
        if let Some(t) = p.ceiling_types.as_deref().and_then(|v| v.iter().find(|t| t.id == id)) {
            return Some(&t.layers);
        }
    }
    p.wall_types.iter().find(|t| t.id == c.wall_type_id).map(|t| t.layers.as_slice())
}

/// Deckenplatten (`emitSlabs`): eine Platte je Materiallage, oben→unten gestapelt.
pub fn emit_slabs(p: &Project) -> Vec<RSlab> {
    let mut ceilings: Vec<(usize, &Ceiling)> = Vec::new();
    let mut layers_of: Vec<Option<&[Layer]>> = Vec::new();
    let mut w = FlatWriter::new();
    let count = w.slot();
    // [178] Auflager an Aussenwänden: Platte bis Aussenkante Kern (abgeleiteter Umriss, Modell unverändert).
    let bearing = super::bearing::ceiling_bearing_outlines(p);
    let v2 = |r: &[[f64; 2]]| -> Vec<Vec2> { r.iter().map(|q| Vec2 { x: q[0], y: q[1] }).collect() };
    for (ci, c) in p.ceilings.as_deref().unwrap_or(&[]).iter().enumerate() {
        if c.outline.len() < 3 {
            continue;
        }
        let (z_bottom, z_top) = p.ceiling_vertical_extent(c);
        let layers = ceiling_layers(p, c);
        // Aussparungen inkl. der Deckenöffnungen ([103]).
        let openings = crate::opening_shape::ceiling_hole_rings(p, c);
        let parts: Vec<(Vec<Vec2>, Vec<Vec<Vec2>>)> = match bearing.get(ci).cloned().flatten() {
            Some(polys) => polys.iter().map(|poly| (v2(&poly[0]), poly[1..].iter().map(|h| v2(h)).chain(openings.iter().cloned()).collect())).collect(),
            None => vec![(c.outline.clone(), openings)],
        };
        for (outline, holes) in parts {
            w.ring(&outline);
            w.num(holes.len() as f64);
            for o in &holes {
                w.ring(o);
            }
            w.num(z_bottom).num(z_top).num(layers.map_or(0, |l| l.len()) as f64);
            for l in layers.unwrap_or(&[]) {
                w.num(l.thickness);
            }
            ceilings.push((ci, c));
            layers_of.push(layers);
        }
    }
    if ceilings.is_empty() {
        return vec![];
    }
    w.set(count, ceilings.len() as f64);
    let mut out = Vec::new();
    for d in crate::ceilings3d::ceilings(&w.done()) {
        let (ci, c) = ceilings[d.ceiling];
        let layers = layers_of[d.ceiling];
        let outline: Vec<RVec2> = d.ring.clone();
        for (layer_idx, z_bottom, z_top) in d.slabs {
            let Some(layers) = layers.filter(|_| layer_idx >= 0) else {
                out.push(RSlab { outline: outline.clone(), z_bottom, z_top, color: SLAB_RGB, ceiling_id: c.id.clone(), hatch: None, cut: None, monolith: None, source: SlabSource::Ceiling { index: ci, layer: None } });
                continue;
            };
            let l = &layers[layer_idx as usize];
            let (color, cut) = match p.component(&l.component_id) {
                Some(comp) => {
                    let line = resolve_cut_line_style(p, l);
                    (
                        hex_to_rgb(&comp.color, style::WALL_RGB),
                        Some(RCutMeta {
                            join_priority: Some(comp.join_priority),
                            component_id: Some(comp.id.clone()),
                            line_color: line.0,
                            line_weight: line.1,
                        }),
                    )
                }
                None => (SLAB_RGB, None),
            };
            out.push(RSlab {
                outline: outline.clone(),
                z_bottom,
                z_top,
                color,
                ceiling_id: c.id.clone(),
                hatch: resolve_component_hatch(p, &l.component_id, None),
                cut,
                monolith: None,
                source: SlabSource::Ceiling { index: ci, layer: Some(layer_idx as usize) },
            });
        }
    }
    out
}
