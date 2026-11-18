//! [279] Geländer im 3D: Netze (`emit_railings`, im 3D bei den Stützen eingereiht), Platten für Schnitt, Ansicht und
//! 3D-Dokument (`railing_slabs`, Herkunft `SlabSource::Railing`) und die Pick-Geometrie. Die Körper liefert
//! `crate::railing::pieces` (lotrechte Prismen), eine Quelle für alle Ableitungen.

use super::*;
use crate::railing::{self, Part, Piece};

/// Prismen der Teile `pieces` als ein Netz (Modell x, y, z).
fn merge<'a>(pieces: impl Iterator<Item = &'a Piece>) -> Option<(Vec<f64>, Vec<u32>)> {
    let (mut positions, mut indices) = (Vec::new(), Vec::new());
    for q in pieces {
        if q.outline.len() < 3 || !(q.z1 - q.z0 > 1e-6) || !q.outline.iter().all(|v| v[0].is_finite() && v[1].is_finite()) {
            continue;
        }
        let (pp, ii) = crate::columns3d::prism(&q.outline, q.z0, q.z1);
        let base = (positions.len() / 3) as u32;
        positions.extend(pp);
        indices.extend(ii.into_iter().map(|i| i + base));
    }
    (!indices.is_empty()).then_some((positions, indices))
}

/// Geländer als Netze: je Geländer die Tafel (Glas, Lochblech, Brüstung) und das Gestänge (Pfosten, Stäbe, Schienen,
/// Handlauf) als eigene Netze mit eigener Farbe.
pub fn emit_railings(p: &Project) -> Vec<RMesh> {
    let mut out = Vec::new();
    for (ri, r) in p.railings.as_deref().unwrap_or(&[]).iter().enumerate() {
        let pcs = railing::pieces(p, r);
        for fill in [true, false] {
            let Some((positions, indices)) = merge(pcs.iter().filter(|q| (q.part == Part::Fill) == fill)) else { continue };
            let color = railing::color(p, r, if fill { Part::Fill } else { Part::Rail });
            out.push(RMesh { crease_angle: None, positions, indices, kind: "extrusion", color, vertex_colors: None, material_index: None, owner: Owner::Railing(ri) });
        }
    }
    out
}

/// Geländer als lotrechte Prismen-Platten (Schnitt, Ansicht, 3D-Dokument), Herkunft `SlabSource::Railing`.
pub fn railing_slabs(p: &Project) -> Vec<RSlab> {
    let mut out = Vec::new();
    for (index, r) in p.railings.as_deref().unwrap_or(&[]).iter().enumerate() {
        for q in railing::pieces(p, r) {
            if q.z1 - q.z0 > 1e-6 && q.outline.len() >= 3 {
                let color = railing::color(p, r, q.part);
                let fill = q.part == Part::Fill;
                out.push(RSlab { outline: q.outline, z_bottom: q.z0, z_top: q.z1, color, ceiling_id: r.id.clone(), hatch: None, cut: None, monolith: None, source: SlabSource::Railing { index, fill } });
            }
        }
    }
    out
}

/// Geländer als Welt-Dreiecke für den 3D-Pick (wie [`emit_railings`]).
pub fn pick_railings(p: &Project) -> Vec<PickRailing> {
    let mut out = Vec::new();
    for r in p.railings.as_deref().unwrap_or(&[]) {
        let pcs = railing::pieces(p, r);
        if let Some((pos, idx)) = merge(pcs.iter()) {
            let tris = extrusion_tris(&pos, &idx);
            if !tris.is_empty() {
                out.push(PickRailing { tris, railing_id: r.id.clone() });
            }
        }
    }
    out
}
