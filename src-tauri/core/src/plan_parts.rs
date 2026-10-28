//! Zusammengesetzter Plan ([K3d]): ein Grundriss besteht aus Abschnitten mehrerer Plan-Puffer
//! (Kern-Puffer aus `planDomains` je Geschoss, dazu ein Puffer mit dem, was TS noch selbst
//! erzeugt: 2D-Zeichnungen, Schatten, Baurecht, zerlegte Polygone). Die Verbraucher im Kern
//! (Render-Szene `plan_scene`, Auswahl `plan_pick`, SVG-Export `plan_svg`) laufen über die
//! Abschnitte in Zeichenreihenfolge; der Index eines Primitivs im zusammengesetzten Plan ist
//! seine Stelle in `Plan.primitives` auf der TS-Seite.
//!
//! Eingabe der Bindungen: Abschnitte als Tripel `[Puffer-Nr, von, bis)` (Nummer = gehaltener
//! Puffer, s. `web/plan_buf.rs`), gedimmte Bereiche als Paare `[von, bis)` im zusammengesetzten
//! Index (wie `Plan.greyedRanges`: dort gilt `greyed = true`).

use crate::plan_buf::{whole, Rec, View, F_GREYED, F_GREYED_SET, F_IDS};

/// Ein Abschnitt `[from, to)` eines Puffers.
pub struct Part<'a> {
    pub view: View<'a>,
    pub from: usize,
    pub to: usize,
    /// Gelesene Strings (Index → Text; `None` = noch nicht gelesen).
    strs: Vec<Option<String>>,
}

impl<'a> Part<'a> {
    pub fn new(view: View<'a>, from: usize, to: usize) -> Option<Part<'a>> {
        if from > to || to > view.len() {
            return None;
        }
        let n = view.n_strings();
        Some(Part { view, from, to, strs: vec![None; n] })
    }

    /// String `idx` (−1 = fehlt → `None`); kaputter Index → `None`.
    pub fn str(&mut self, idx: f64) -> Option<&str> {
        let i = whole(idx)?;
        if i >= self.strs.len() {
            return None;
        }
        if self.strs[i].is_none() {
            self.strs[i] = Some(self.view.string(i)?);
        }
        self.strs[i].as_deref()
    }
}

/// Abschnitte aus `[nr, von, bis, …]` bilden; `buf(nr)` liefert die Bytes des Puffers.
pub fn parts_from<'a>(segs: &[f64], buf: impl Fn(u32) -> Option<&'a [u8]>) -> Option<Vec<Part<'a>>> {
    if segs.len() % 3 != 0 {
        return None;
    }
    let mut out = Vec::with_capacity(segs.len() / 3);
    for s in segs.chunks_exact(3) {
        let nr = whole(s[0])? as u32;
        let view = View::parse(buf(nr)?)?;
        out.push(Part::new(view, whole(s[1])?, whole(s[2])?)?);
    }
    Some(out)
}

/// Gedimmte Bereiche aus `[von, bis, …]` (sortiert, wie `Plan.greyedRanges`).
pub fn ranges_from(flat: &[f64]) -> Option<Vec<(usize, usize)>> {
    if flat.len() % 2 != 0 {
        return None;
    }
    flat.chunks_exact(2).map(|c| Some((whole(c[0])?, whole(c[1])?))).collect()
}

/// Liegt `i` in einem der Bereiche?
pub fn in_ranges(ranges: &[(usize, usize)], i: usize) -> bool {
    ranges.iter().any(|&(a, b)| i >= a && i < b)
}

/// `greyed` eines Eintrags: `Some(true/false)` gesetzt, `None` fehlt; in einem gedimmten Bereich
/// immer `Some(true)` (wie `greyedClone` in `generatePlan.ts`).
pub(crate) fn greyed_of(rec: &Rec, forced: bool) -> Option<bool> {
    if forced {
        return Some(true);
    }
    (rec.flags & F_GREYED_SET != 0).then_some(rec.flags & F_GREYED != 0)
}

/// Alle Pick-Ids eines Eintrags als (Art 1…11, String-Index), erste aus dem Kopf.
pub(crate) fn pick_ids(view: &View, rec: &Rec) -> Option<Vec<(u32, f64)>> {
    let mut out = Vec::new();
    if rec.pick.0 > 0 {
        out.push((rec.pick.0, rec.pick.1 as f64));
    }
    if rec.flags & F_IDS != 0 {
        if let Some((o, n)) = rec.ids {
            let l = view.pool(o, n.checked_mul(2)?)?;
            for c in l.chunks_exact(2) {
                let k = whole(c[0])? as u32;
                if k == 0 || k > 11 {
                    return None;
                }
                out.push((k, c[1]));
            }
        }
    }
    Some(out)
}

/// String-Index der Pick-Id der Art `kind` (1 wall · 2 drawing · …) oder `None`.
pub(crate) fn pick_id(view: &View, rec: &Rec, kind: u32) -> Option<f64> {
    if rec.pick.0 == kind {
        return Some(rec.pick.1 as f64);
    }
    if rec.flags & F_IDS == 0 {
        return None;
    }
    pick_ids(view, rec)?.into_iter().find(|e| e.0 == kind).map(|e| e.1)
}
