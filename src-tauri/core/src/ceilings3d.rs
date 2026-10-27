//! Decken im 3D (aus `src/plan/toWalls3d/ceilings.ts`): Aussparungen (Treppenauge/Schacht) über
//! den Brücken-Trick in EINEN einfachen Umriss einfügen (derselbe Ring für alle Schichten) und
//! die z-Spanne proportional auf die Schichten des Deckentyps verteilen, von OK nach UK.
//! TS liefert Umriss, Öffnungen, z-Spanne (`ceilingVerticalExtent`) und die Schichtdicken des
//! Deckentyps; Farbe, Schraffur und Schnitt-Metadaten je Schicht ordnet TS zu.
//!
//! Eingabe: `[n, (nPkt, x, y …, nÖffnungen, (nPkt, x, y …)…, zUnten, zOben, nSchichten, dicke…)…]`.
//! Ausgabe: `[n, (decke, nPkt, x, y …, nSlabs, (schicht, zUnten, zOben)…)…]`; `schicht` ist der
//! Index in `dicke…` oder −1 (ein Vollkörper ohne Schichten). Decken mit < 3 Punkten oder
//! Höhe ≤ 1e-4 entfallen einzeln; Unsinn ergibt ein leeres Ergebnis.

use crate::flat_read::Reader;
use crate::polygon_holes::merge_holes;

const EPS: f64 = 1e-4;
/// Brückenabstand wie der Vorgabewert von `mergeHoles` in TS.
const BRIDGE_GAP: f64 = 1e-4;

pub struct CeilingSlabs {
    pub ceiling: usize,
    pub ring: Vec<[f64; 2]>,
    /// `(schicht (−1 = keine), zUnten, zOben)`
    pub slabs: Vec<(i64, f64, f64)>,
}

/// Verteilt `[z_bottom, z_top]` auf die Schichten (OK zuerst), `None` ohne verwertbare Schichten.
pub fn layer_spans(z_bottom: f64, z_top: f64, thicknesses: &[f64]) -> Option<Vec<(i64, f64, f64)>> {
    let total: f64 = thicknesses.iter().fold(0.0, |s, t| s + t);
    if thicknesses.is_empty() || !(total > EPS) {
        return None;
    }
    let span = z_top - z_bottom;
    let mut prefix_top = 0.0;
    let mut out = Vec::with_capacity(thicknesses.len());
    for (i, l) in thicknesses.iter().enumerate() {
        let t = (l / total) * span;
        let layer_top = z_top - prefix_top;
        let layer_bottom = layer_top - t;
        prefix_top += t;
        out.push((i as i64, layer_bottom, layer_top));
    }
    Some(out)
}

pub fn ceilings(buf: &[f64]) -> Vec<CeilingSlabs> {
    let mut out = Vec::new();
    let mut r = Reader::new(buf);
    let Some(n) = r.count() else { return out };
    for i in 0..n {
        let Some(outline) = r.ring() else { return Vec::new() };
        let Some(n_open) = r.count() else { return Vec::new() };
        let mut openings = Vec::with_capacity(n_open.min(1 << 16));
        for _ in 0..n_open {
            let Some(o) = r.ring() else { return Vec::new() };
            openings.push(o);
        }
        let Some(z_bottom) = r.num() else { return Vec::new() };
        let Some(z_top) = r.num() else { return Vec::new() };
        let Some(n_layers) = r.count() else { return Vec::new() };
        let mut thick = Vec::with_capacity(n_layers.min(1 << 16));
        for _ in 0..n_layers {
            let Some(t) = r.num() else { return Vec::new() };
            thick.push(t);
        }
        let finite = z_bottom.is_finite()
            && z_top.is_finite()
            && thick.iter().all(|t| t.is_finite())
            && outline.iter().chain(openings.iter().flatten()).all(|p| p[0].is_finite() && p[1].is_finite());
        if !finite || outline.len() < 3 || z_top - z_bottom <= EPS {
            continue;
        }
        let ring = if openings.is_empty() { outline } else { merge_holes(&outline, &openings, BRIDGE_GAP).ring };
        let slabs = layer_spans(z_bottom, z_top, &thick).unwrap_or_else(|| vec![(-1, z_bottom, z_top)]);
        out.push(CeilingSlabs { ceiling: i, ring, slabs });
    }
    out
}

pub fn encode(c: &[CeilingSlabs]) -> Vec<f64> {
    let mut out = vec![c.len() as f64];
    for d in c {
        out.push(d.ceiling as f64);
        out.push(d.ring.len() as f64);
        for p in &d.ring {
            out.extend(*p);
        }
        out.push(d.slabs.len() as f64);
        for (l, zb, zt) in &d.slabs {
            out.extend([*l as f64, *zb, *zt]);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const SQUARE: [f64; 9] = [4.0, 0.0, 0.0, 4.0, 0.0, 4.0, 4.0, 0.0, 4.0];

    fn one(openings: &[f64], z0: f64, z1: f64, layers: &[f64]) -> Vec<f64> {
        let mut b = vec![1.0];
        b.extend(SQUARE);
        b.extend(openings);
        b.extend([z0, z1, layers.len() as f64]);
        b.extend(layers);
        b
    }

    #[test]
    fn ohne_schichten_ein_vollkoerper() {
        let c = ceilings(&one(&[0.0], 2.5, 2.8, &[]));
        assert_eq!(c.len(), 1);
        assert_eq!(c[0].ring.len(), 4);
        assert_eq!(c[0].slabs, vec![(-1, 2.5, 2.8)]);
    }

    #[test]
    fn schichten_von_oben_nach_unten() {
        let c = ceilings(&one(&[0.0], 2.0, 2.4, &[0.1, 0.3]));
        let s = &c[0].slabs;
        assert_eq!(s.len(), 2);
        assert_eq!(s[0].0, 0);
        assert!((s[0].2 - 2.4).abs() < 1e-12 && (s[0].1 - 2.3).abs() < 1e-12);
        assert!((s[1].2 - 2.3).abs() < 1e-12 && (s[1].1 - 2.0).abs() < 1e-12);
        // Schichtdicken ohne Summe → Vollkörper
        assert_eq!(ceilings(&one(&[0.0], 0.0, 1.0, &[0.0, 0.0]))[0].slabs, vec![(-1, 0.0, 1.0)]);
    }

    #[test]
    fn aussparung_wird_zu_einem_ring() {
        let hole = [1.0, 4.0, 1.0, 1.0, 2.0, 1.0, 2.0, 2.0, 1.0, 2.0];
        let c = ceilings(&one(&hole, 0.0, 0.3, &[]));
        assert!(c[0].ring.len() > 4);
        assert!(crate::flat_read::signed_area(&c[0].ring).abs() < 16.0);
    }

    #[test]
    fn zu_duenn_oder_zu_wenig_punkte_entfaellt() {
        assert!(ceilings(&one(&[0.0], 1.0, 1.00005, &[])).is_empty());
        assert!(ceilings(&[1.0, 2.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 1.0, 0.0]).is_empty());
    }

    #[test]
    fn unsinn_ohne_panic() {
        assert!(ceilings(&[]).is_empty());
        assert!(ceilings(&[f64::NAN]).is_empty());
        assert!(ceilings(&[1.0, 1e300]).is_empty());
        assert!(ceilings(&[3.0, 4.0, 0.0]).is_empty());
        assert!(ceilings(&one(&[0.0], f64::NAN, 1.0, &[])).is_empty());
        assert!(ceilings(&one(&[0.0], 0.0, 1.0, &[f64::INFINITY])).is_empty());
        let mut b = one(&[0.0], 0.0, 1.0, &[]);
        b[1] = 1e18;
        assert!(ceilings(&b).is_empty());
    }
}
