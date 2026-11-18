//! [256] Kontext weit neben dem Haus in Schnitt und Ansicht weglassen: Netze auf Umgebungsklassen („05 Kontext" und
//! Kinder, z. B. Nachbargebäude), deren nächste Kante in Blickrichtung horizontal mehr als [`MAX_GAP_PAPER_MM`]
//! Papier-mm vom Ausmass des Gebäudes entfernt liegt, entfallen (nicht beschnitten). Bei 1:N sind das 0.15·N m.
//! Vorgabe Koordinator (kein Entscheid des Maintainers), der Wert ist hier eine Konstante.

use super::section::{Edge, Kind, Output};

/// Grösster Abstand (Papier-mm) zwischen Gebäude und Kontext, bis zu dem der Kontext bleibt.
pub const MAX_GAP_PAPER_MM: f64 = 150.0;

/// Grösster Abstand in Modell-Metern bei Massstab 1:`scale`; `None` ohne gültigen Massstab (nichts weglassen).
pub fn max_gap(scale: f64) -> Option<f64> {
    (scale.is_finite() && scale > 0.0).then(|| MAX_GAP_PAPER_MM / 1000.0 * scale)
}

/// Bereich [min, max] erweitern.
pub fn grow(r: &mut Option<(f64, f64)>, x: f64) {
    if x.is_finite() {
        *r = Some(r.map_or((x, x), |(a, b)| (a.min(x), b.max(x))));
    }
}

/// Abstand zweier Bereiche (0 bei Überlappung).
pub fn gap(a: (f64, f64), b: (f64, f64)) -> f64 {
    (b.0 - a.1).max(a.0 - b.1).max(0.0)
}

fn edge_range(r: &mut Option<(f64, f64)>, e: &Edge) {
    grow(r, e.a[0]);
    grow(r, e.b[0]);
}

/// Schnitt: Netze (Index in `Output::meshes`) auf Umgebungsklassen weit vom Gebäude weglassen (Schnittflächen,
/// offene Schnittlinien und Projektionskanten). Ohne etwas Wegzulassendes `None` (Ausgabe unverändert).
pub fn prune_section(out: &Output, scale: f64) -> Option<Output> {
    let max = max_gap(scale)?;
    let ctx = |i: usize| out.meshes.get(i).and_then(|m| m.category.as_deref()).is_some_and(crate::import_context::is_context_class);
    let mut bld: Option<(f64, f64)> = None;
    for c in out.cuts.iter().filter(|c| c.kind != Kind::Mesh || !ctx(c.index)) {
        c.pts.iter().for_each(|p| grow(&mut bld, p[0]));
    }
    for e in out.visible.iter().filter(|e| e.kind != Kind::Mesh || !ctx(e.index)) {
        edge_range(&mut bld, e);
    }
    let bld = bld?;
    let mut ranges: Vec<Option<(f64, f64)>> = vec![None; out.meshes.len()];
    for c in out.cuts.iter().filter(|c| c.kind == Kind::Mesh) {
        if let Some(r) = ranges.get_mut(c.index) {
            c.pts.iter().for_each(|p| grow(r, p[0]));
        }
    }
    for (i, l) in &out.mesh_lines {
        if let Some(r) = ranges.get_mut(*i) {
            l.iter().for_each(|p| grow(r, p[0]));
        }
    }
    for e in out.visible.iter().chain(&out.hidden).filter(|e| e.kind == Kind::Mesh) {
        if let Some(r) = ranges.get_mut(e.index) {
            grow(r, e.a[0]);
            grow(r, e.b[0]);
        }
    }
    let far: Vec<bool> = (0..out.meshes.len()).map(|i| ctx(i) && ranges[i].is_some_and(|r| gap(bld, r) > max)).collect();
    if !far.iter().any(|&f| f) {
        return None;
    }
    let is_far = |i: usize| far.get(i).copied().unwrap_or(false);
    let mut o = out.clone();
    o.cuts.retain(|c| c.kind != Kind::Mesh || !is_far(c.index));
    o.mesh_lines.retain(|(i, _)| !is_far(*i));
    o.visible.retain(|e| e.kind != Kind::Mesh || !is_far(e.index));
    o.hidden.retain(|e| e.kind != Kind::Mesh || !is_far(e.index));
    Some(o)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plan::section::{Cut, MeshMeta};

    fn cut(kind: Kind, index: usize, x0: f64, x1: f64) -> Cut {
        Cut::new(kind, index, vec![[x0, 0.0], [x1, 0.0], [x1, 3.0], [x0, 3.0]])
    }

    #[test]
    fn abstand_und_grenze() {
        assert_eq!(max_gap(100.0), Some(15.0));
        assert_eq!(max_gap(200.0), Some(30.0));
        assert_eq!(max_gap(0.0), None);
        assert_eq!(gap((0.0, 10.0), (12.0, 20.0)), 2.0);
        assert_eq!(gap((0.0, 10.0), (5.0, 20.0)), 0.0);
    }

    /// Haus u 0…10; Nachbar „nah" bei 20…25 (Abstand 10 m), „fern" bei 40…45 (30 m); ein Netz auf Klasse „01" (zählt zum Gebäude) bleibt.
    #[test]
    fn nachbar_weit_weg_entfaellt() {
        let meta = |c: &str| MeshMeta { id: c.into(), name: c.into(), category: Some(c.into()) };
        let mut o = Output { meshes: vec![meta("12"), meta("12"), meta("01")], ..Output::default() };
        o.cuts = vec![cut(Kind::Wall, 0, 0.0, 10.0), cut(Kind::Mesh, 0, 20.0, 25.0), cut(Kind::Mesh, 1, 40.0, 45.0), cut(Kind::Mesh, 2, 11.0, 12.0)];
        o.mesh_lines = vec![(1, vec![[41.0, 0.0], [44.0, 1.0]])];
        o.visible = vec![Edge { kind: Kind::Mesh, index: 1, a: [40.0, 0.0], b: [40.0, 3.0], stair: crate::plan::section::StairPart::None }];
        let p = prune_section(&o, 100.0).expect("fern entfällt bei 1:100 (15 m)");
        let idx: Vec<usize> = p.cuts.iter().filter(|c| c.kind == Kind::Mesh).map(|c| c.index).collect();
        assert_eq!(idx, [0, 2], "Nachbar nah und Netz ohne Umgebungsklasse bleiben");
        assert!(p.mesh_lines.is_empty() && p.visible.is_empty());
        // 1:300: bis 45 m, alles bleibt (das Netz „01" ist keine Umgebungsklasse).
        assert!(prune_section(&o, 300.0).is_none());
        assert!(prune_section(&o, 0.0).is_none(), "ohne Massstab nichts weglassen");
    }
}
