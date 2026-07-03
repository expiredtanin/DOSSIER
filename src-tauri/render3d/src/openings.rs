//! Gemeinsame Rechteck-Zerlegung fuer Wand-Oeffnungen (Fenster/Tueren).
//!
//! Kern-Idee: ein Achsen-Intervall voller Hoehe (`[z0, z1]`) wird an den darin
//! liegenden Oeffnungen in Voll-/Bruestungs-/Sturz-Rechtecke gesplittet —
//! Bruestung `[z0, sill]` unterhalb, Sturz `[sill+height, z1]` oberhalb der
//! Oeffnung, dazwischen eine Luecke (das Loch). Diese Zerlegung ist
//! koordinatenraum-neutral: sie braucht nur ein 1D-Achsen-Intervall plus die
//! Oeffnungen als bereits geclippte `(v_lo, v_hi, &Opening)`-Teilstuecke in
//! DEMSELBEN Koordinatenraum wie `lo`/`hi`.
//!
//! Zwei Aufrufer, zwei Koordinatenraeume:
//! - `section::wall_cut_rectangles`: Cut-Ebene — die Achsen-Koordinate ist die
//!   Projektions-u-Achse der Schnittebene (`axis_map` rechnet Wandachsen-Meter
//!   dorthin um).
//! - `mesh::wall_solid_segments`: 3D-Solid-Extrusion — die Achsen-Koordinate
//!   ist direkt die Wandachse in Metern (0..Wandlaenge), keine Projektion
//!   noetig.
//!
//! Beide nutzen `split_range_by_voids` fuer die eigentliche Bruestungs-/
//! Sturz-Logik, damit Schnitt-Ansicht und 3D-Solid-Mesh garantiert dasselbe
//! Oeffnungsmodell (siehe `types::Opening`) auswerten statt zweier
//! divergierender Implementierungen.

use crate::types::Opening;

/// Mindestlaenge eines Oeffnungs-/Rest-Teilstuecks, unterhalb derer es als
/// vernachlaessigbar (Rand-/Rundungsfall) ignoriert wird.
pub(crate) const MIN_SPAN: f32 = 1e-4;

/// Zerlegt EIN Achsen-Intervall `[lo, hi]` (volle Hoehe `[z0, z1]`) an den in
/// `voids` uebergebenen, bereits auf `[lo,hi]` geclippten Oeffnungs-
/// Teilstuecken (`(v_lo, v_hi, opening)`, Reihenfolge beliebig) in Rechtecke
/// `(u0, u1, v0, v1)`: volle Hoehe ausserhalb von Oeffnungen, Bruestung
/// darunter, Sturz darueber (siehe `Opening::sill`/`Opening::height`). Ohne
/// Oeffnungen (leeres `voids`) liefert es das eine Vollrechteck `[lo,hi]x[z0,z1]`
/// (Regressionsfall).
pub(crate) fn split_range_by_voids(
    lo: f32,
    hi: f32,
    z0: f32,
    z1: f32,
    mut voids: Vec<(f32, f32, &Opening)>,
) -> Vec<(f32, f32, f32, f32)> {
    if voids.is_empty() {
        return vec![(lo, hi, z0, z1)];
    }
    voids.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());

    let mut rects = Vec::new();
    let mut cursor = lo;
    for (v_lo, v_hi, op) in &voids {
        if *v_lo > cursor + MIN_SPAN {
            rects.push((cursor, *v_lo, z0, z1)); // Pfeiler zwischen Oeffnungen
        }
        let sill_abs = z0 + op.sill.max(0.0);
        let head_abs = (sill_abs + op.height).min(z1);
        if sill_abs - z0 > MIN_SPAN {
            rects.push((*v_lo, *v_hi, z0, sill_abs)); // Bruestung
        }
        if z1 - head_abs > MIN_SPAN {
            rects.push((*v_lo, *v_hi, head_abs, z1)); // Sturz
        }
        cursor = cursor.max(*v_hi);
    }
    if hi > cursor + MIN_SPAN {
        rects.push((cursor, hi, z0, z1)); // Rest-Pfeiler nach der letzten Oeffnung
    }
    rects
}
