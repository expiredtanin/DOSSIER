//! Schnitt-Dominanz ([125]): die EINE Fassung von `subtractDominantBands` (früher `toSection.ts`) für den
//! 2D-Schnitt (`dossier-core`, `plan/section.rs`) und den 3D-Live-Schnitt (`render3d`,
//! `section_boolean.rs`). Beide Aufrufer reichen ihre Schnittbänder als achsparallele (u,v)-Rechtecke mit
//! Priorität (`Component.joinPriority`) und Komponenten-Nummer herein und bekommen Teilstücke zurück;
//! Stil, Schraffur und Herkunft bleiben beim Aufrufer (Feld `src` = Index des Quellbands).
//!
//! 1. **Subtraktion:** Jedes Band verliert die Überlappung mit ALLEN Bändern STRIKT höherer Priorität
//!    (elementübergreifend, z. B. schneidet Decken-Beton 100 den Wand-Putz 10 weg). Gleiche Priorität
//!    koexistiert. Bänder ohne Priorität oder ohne (endliches) Rechteck nehmen weder als Basis noch als
//!    Schneider teil und bleiben unverändert.
//! 2. **Verschmelzen:** Stücke gleicher Komponente und Priorität, deren Union wieder ein Rechteck ist,
//!    werden zu einem Stück (keine innere Trennlinie durch gleiches Material).
//!
//! Gerechnet wird in f64 mit JS-Zahlsemantik (`jsnum::min/max`), Reihenfolge wie die TS-Vorlage. Keine
//! wasm-Bindungen hier.

use crate::jsnum::{max, min};
use crate::ugrid::Grid1;
use std::collections::HashMap;

/// Toleranz für Überlappungs-/Rest-Rechtecke (Meter): Null-/Negativflächen und Rest-Streifen dünner als
/// `RECT_EPS` werden verworfen.
pub const RECT_EPS: f64 = 1e-6;

/// Achsparalleles Rechteck in (u, v)-Metern.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub u_min: f64,
    pub u_max: f64,
    pub v_min: f64,
    pub v_max: f64,
}

impl Rect {
    fn is_finite(&self) -> bool {
        self.u_min.is_finite() && self.u_max.is_finite() && self.v_min.is_finite() && self.v_max.is_finite()
    }
}

/// Umgebendes Rechteck von Punkten (JS-`Math.min/max`: NaN bleibt NaN), `None` bei weniger als 3 Punkten.
pub fn rect_of_points(pts: impl ExactSizeIterator<Item = (f64, f64)>) -> Option<Rect> {
    if pts.len() < 3 {
        return None;
    }
    let mut r = Rect { u_min: f64::INFINITY, u_max: f64::NEG_INFINITY, v_min: f64::INFINITY, v_max: f64::NEG_INFINITY };
    for (u, v) in pts {
        r.u_min = min(r.u_min, u);
        r.u_max = max(r.u_max, u);
        r.v_min = min(r.v_min, v);
        r.v_max = max(r.v_max, v);
    }
    Some(r)
}

/// Eingabe-Band: Rechteck (`None` = keine Rechteck-Form), Priorität, Komponente (gleiche Nummer = gleiche
/// `componentId`).
#[derive(Debug, Clone, Copy)]
pub struct Band {
    pub rect: Option<Rect>,
    pub prio: Option<f64>,
    pub comp: Option<u32>,
}

/// Ergebnis-Stück: `rect == None` heisst Quellband `src` unverändert übernehmen, sonst neues Rechteck mit
/// dem Stil von `src`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Piece {
    pub src: usize,
    pub rect: Option<Rect>,
}

/// Rechteck minus Rechteck: `base` ohne die Überlappung mit `cutter`, als 0–4 disjunkte Reste (links/rechts
/// über die volle Höhe, dann unten/oben im mittleren u-Streifen). Kein echter Überlapp (≤ EPS) ⇒ `base`.
pub fn subtract_rect(base: Rect, cutter: Rect) -> Vec<Rect> {
    let o_min_u = max(base.u_min, cutter.u_min);
    let o_max_u = min(base.u_max, cutter.u_max);
    let o_min_v = max(base.v_min, cutter.v_min);
    let o_max_v = min(base.v_max, cutter.v_max);
    if o_max_u - o_min_u <= RECT_EPS || o_max_v - o_min_v <= RECT_EPS {
        return vec![base];
    }
    let mut out = Vec::new();
    let mut push = |r: Rect| {
        if r.u_max - r.u_min > RECT_EPS && r.v_max - r.v_min > RECT_EPS {
            out.push(r);
        }
    };
    push(Rect { u_min: base.u_min, u_max: o_min_u, v_min: base.v_min, v_max: base.v_max });
    push(Rect { u_min: o_max_u, u_max: base.u_max, v_min: base.v_min, v_max: base.v_max });
    push(Rect { u_min: o_min_u, u_max: o_max_u, v_min: base.v_min, v_max: o_min_v });
    push(Rect { u_min: o_min_u, u_max: o_max_u, v_min: o_max_v, v_max: base.v_max });
    out
}

/// Union zweier Rechtecke, nur wenn sie wieder EXAKT ein Rechteck ist (Enthaltensein oder Achs-Deckung +
/// Berührung), sonst `None` (L-Form, Spalt).
pub fn rect_union_if_rect(a: Rect, b: Rect) -> Option<Rect> {
    let e = RECT_EPS;
    let a_in_b = b.u_min - a.u_min <= e && a.u_max - b.u_max <= e && b.v_min - a.v_min <= e && a.v_max - b.v_max <= e;
    if a_in_b {
        return Some(b);
    }
    let b_in_a = a.u_min - b.u_min <= e && b.u_max - a.u_max <= e && a.v_min - b.v_min <= e && b.v_max - a.v_max <= e;
    if b_in_a {
        return Some(a);
    }
    let u_aligned = (a.u_min - b.u_min).abs() <= e && (a.u_max - b.u_max).abs() <= e;
    let v_aligned = (a.v_min - b.v_min).abs() <= e && (a.v_max - b.v_max).abs() <= e;
    let v_touch = a.v_max >= b.v_min - e && b.v_max >= a.v_min - e;
    let u_touch = a.u_max >= b.u_min - e && b.u_max >= a.u_min - e;
    if (u_aligned && v_touch) || (v_aligned && u_touch) {
        return Some(Rect {
            u_min: min(a.u_min, b.u_min),
            u_max: max(a.u_max, b.u_max),
            v_min: min(a.v_min, b.v_min),
            v_max: max(a.v_max, b.v_max),
        });
    }
    None
}

/// Teilnehmendes Band (endliches Rechteck + Priorität)?
fn active(b: &Band) -> Option<(Rect, f64)> {
    match (b.rect, b.prio) {
        (Some(r), Some(p)) if r.is_finite() && !p.is_nan() => Some((r, p)),
        _ => None,
    }
}

/// Schnitt-Dominanz: Subtraktion, dann Verschmelzen (siehe Modulkopf).
pub fn dominant_bands(bands: &[Band]) -> Vec<Piece> {
    let n = bands.len();
    let mut out: Vec<Piece> = Vec::new();
    // Vorauswahl der Schneider über u (aufsteigend wie die volle Schleife): ein Schneider, der das
    // Grundrechteck nicht trifft, lässt alle Teilstücke unverändert (`subtract_rect`).
    let cutters: Vec<usize> = (0..n).filter(|&j| active(&bands[j]).is_some()).collect();
    let grid = Grid1::new(&cutters.iter().map(|&j| active(&bands[j]).map_or((0.0, 0.0), |(r, _)| (r.u_min, r.u_max))).collect::<Vec<_>>());
    let mut cand = Vec::new();
    for i in 0..n {
        let Some((base, prio)) = active(&bands[i]) else {
            out.push(Piece { src: i, rect: None });
            continue;
        };
        let mut pieces = vec![base];
        grid.query(base.u_min, base.u_max, &mut cand);
        for &c in &cand {
            let j = cutters[c as usize];
            if pieces.is_empty() {
                break;
            }
            if j == i {
                continue;
            }
            let Some((cutter, other)) = active(&bands[j]) else { continue };
            if other <= prio {
                continue;
            }
            let mut next = Vec::new();
            for p in pieces {
                next.extend(subtract_rect(p, cutter));
            }
            pieces = next;
        }
        for p in pieces {
            out.push(Piece { src: i, rect: Some(p) });
        }
    }
    merge_same_component(bands, out)
}

/// Verschmilzt Stücke gleicher Komponente und Priorität. Ergebnis wie die schlichte Fassung
/// ([`merge_same_component_naive`]: immer das lexikographisch kleinste verschmelzbare Paar (i, j), dann
/// von vorn), aber ohne den Neustart über alle Paare: Nach dem Verschmelzen von (p, b) können nur Paare
/// mit dem geänderten Eintrag p neu passen; davor liegende Einträge hatten sonst keinen Partner.
/// Kandidaten nur aus derselben Gruppe (Komponente, Priorität).
fn merge_same_component(bands: &[Band], list: Vec<Piece>) -> Vec<Piece> {
    let n = list.len();
    // Unverändert übernommene Bänder (`rect == None`) nehmen nicht teil: sie haben keine Priorität
    // oder kein endliches Rechteck.
    let mut rects: Vec<Option<Rect>> = list.iter().map(|o| o.rect).collect();
    let mut changed = vec![false; n];
    let mut alive = vec![true; n];
    let mut groups: HashMap<(u32, u64), Vec<usize>> = HashMap::new();
    let mut group_of: Vec<Option<(u32, u64)>> = vec![None; n];
    for (k, o) in list.iter().enumerate() {
        let b = bands[o.src];
        if let (Some(c), Some(pr), Some(_)) = (b.comp, b.prio, rects[k]) {
            let key = (c, if pr == 0.0 { 0 } else { pr.to_bits() });
            groups.entry(key).or_default().push(k);
            group_of[k] = Some(key);
        }
    }
    let ok = |rects: &[Option<Rect>], a: usize, b: usize| -> Option<Rect> { rect_union_if_rect(rects[a]?, rects[b]?) };
    let mut p = 0;
    while p < n {
        let Some(key) = group_of[p].filter(|_| alive[p]) else {
            p += 1;
            continue;
        };
        let members = &groups[&key];
        // kleinster Partner b > p
        let hit = members.iter().copied().filter(|&b| b > p && alive[b]).find_map(|b| ok(&rects, p, b).map(|u| (b, u)));
        let Some((b, u)) = hit else {
            p += 1;
            continue;
        };
        rects[p] = Some(u);
        changed[p] = true;
        alive[b] = false;
        // Rückwärts: kleinster a < p, der jetzt mit dem geänderten Eintrag verschmilzt (Kette).
        let mut cur = p;
        loop {
            let members = &groups[&key];
            let back = members.iter().copied().filter(|&a| a < cur && alive[a]).find_map(|a| ok(&rects, a, cur).map(|u| (a, u)));
            let Some((a, u)) = back else { break };
            rects[a] = Some(u);
            changed[a] = true;
            alive[cur] = false;
            cur = a;
        }
        p = cur;
    }
    list.into_iter()
        .enumerate()
        .filter(|(k, _)| alive[*k])
        .map(|(k, o)| Piece { src: o.src, rect: if changed[k] { rects[k] } else { o.rect } })
        .collect()
}

/// Schlichte Fassung (TS-Vorlage `mergeSameComponentBands`): Referenz für die Tests.
#[cfg(test)]
fn merge_same_component_naive(bands: &[Band], list: Vec<Piece>) -> Vec<Piece> {
    let mut out = list;
    let mut merged = true;
    while merged {
        merged = false;
        let mut i = 0;
        while i < out.len() && !merged {
            let bi = bands[out[i].src];
            let (Some(_), Some(_), Some(ri)) = (bi.comp, bi.prio, out[i].rect) else {
                i += 1;
                continue;
            };
            for j in i + 1..out.len() {
                let bj = bands[out[j].src];
                if bj.comp != bi.comp || bj.prio != bi.prio {
                    continue;
                }
                let Some(rj) = out[j].rect else { continue };
                if let Some(u) = rect_union_if_rect(ri, rj) {
                    out[i].rect = Some(u);
                    out.remove(j);
                    merged = true;
                    break;
                }
            }
            i += 1;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(u0: f64, u1: f64, v0: f64, v1: f64) -> Rect {
        Rect { u_min: u0, u_max: u1, v_min: v0, v_max: v1 }
    }

    fn band(u0: f64, u1: f64, v0: f64, v1: f64, prio: f64, comp: u32) -> Band {
        Band { rect: Some(r(u0, u1, v0, v1)), prio: Some(prio), comp: Some(comp) }
    }

    fn area_of(out: &[Piece], bands: &[Band], comp: u32) -> f64 {
        out.iter()
            .filter(|p| bands[p.src].comp == Some(comp))
            .map(|p| p.rect.or(bands[p.src].rect).map_or(0.0, |x| (x.u_max - x.u_min) * (x.v_max - x.v_min)))
            .sum()
    }

    fn approx(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-9
    }

    // --- subtract_rect ----------------------------------------------------------

    #[test]
    fn rechteck_subtraktion() {
        // Kein Überlapp, nur Berührung, volle Überdeckung, mittig, Ecke, Randstreifen.
        assert_eq!(subtract_rect(r(0.0, 1.0, 0.0, 1.0), r(2.0, 3.0, 2.0, 3.0)), vec![r(0.0, 1.0, 0.0, 1.0)]);
        assert_eq!(subtract_rect(r(0.0, 1.0, 0.0, 1.0), r(1.0, 2.0, 0.0, 1.0)), vec![r(0.0, 1.0, 0.0, 1.0)]);
        assert!(subtract_rect(r(1.0, 2.0, 1.0, 2.0), r(0.0, 3.0, 0.0, 3.0)).is_empty());
        let mitte = subtract_rect(r(0.0, 3.0, 0.0, 3.0), r(1.0, 2.0, 1.0, 2.0));
        let flaeche: f64 = mitte.iter().map(|x| (x.u_max - x.u_min) * (x.v_max - x.v_min)).sum();
        assert_eq!((mitte.len(), flaeche), (4, 8.0));
        let ecke = subtract_rect(r(0.0, 2.0, 0.0, 2.0), r(1.0, 3.0, 1.0, 3.0));
        let flaeche: f64 = ecke.iter().map(|x| (x.u_max - x.u_min) * (x.v_max - x.v_min)).sum();
        assert_eq!((ecke.len(), flaeche), (2, 3.0));
        let rand = subtract_rect(r(0.0, 2.0, 0.0, 2.0), r(-1.0, 3.0, 1.0, 3.0));
        assert_eq!(rand, vec![r(0.0, 2.0, 0.0, 1.0)]);
    }

    // --- dominant_bands -----------------------------------------------------------

    #[test]
    fn hoehere_prioritaet_schneidet_weg() {
        let bands = [band(0.0, 1.0, 0.0, 1.0, 10.0, 0), band(0.0, 1.0, 0.5, 1.0, 100.0, 1)];
        let out = dominant_bands(&bands);
        // Basis behält die untere Hälfte, Schneider bleibt ganz.
        assert_eq!(out, vec![Piece { src: 0, rect: Some(r(0.0, 1.0, 0.0, 0.5)) }, Piece { src: 1, rect: Some(r(0.0, 1.0, 0.5, 1.0)) }]);
    }

    #[test]
    fn decke_100_schneidet_wand_50_im_ueberlappungs_intervall_weg() {
        // Backstein (50, volle Höhe) und Decken-Beton (100, v in [2.6, 2.8]) am selben u.
        let bands = [band(0.0, 0.2, 0.0, 3.0, 50.0, 0), band(0.0, 0.2, 2.6, 2.8, 100.0, 1)];
        let out = dominant_bands(&bands);
        assert!(approx(area_of(&out, &bands, 1), 0.2 * 0.2));
        for p in out.iter().filter(|p| p.src == 0) {
            let x = p.rect.unwrap();
            assert!(!(x.v_min < 2.8 - 1e-4 && x.v_max > 2.6 + 1e-4), "Backstein-Rest {x:?} ragt ins Beton-Intervall");
        }
        assert!(approx(area_of(&out, &bands, 0), 0.56));
    }

    #[test]
    fn wand_50_schneidet_estrich_30() {
        let bands = [band(0.0, 2.0, 0.0, 3.0, 30.0, 0), band(0.0, 2.0, 2.0, 4.0, 50.0, 1)];
        let out = dominant_bands(&bands);
        assert_eq!(out[0], Piece { src: 0, rect: Some(r(0.0, 2.0, 0.0, 2.0)) });
        assert!(approx(area_of(&out, &bands, 1), 4.0));
    }

    /// Schnitt durch Aussenwand + Geschossdecke: Estrich (30) und Dämmung (20) verlieren den u-Bereich
    /// des Backsteins (50, zwei Boxen um den Beton herum); Beton (100) bleibt voll.
    #[test]
    fn backstein_schneidet_estrich_und_daemmung() {
        let bu = (0.0075, 0.1575);
        let bands = [
            band(0.0, 5.0, 2.54, 2.6, 30.0, 0),
            band(0.0, 5.0, 2.50, 2.54, 20.0, 1),
            band(0.0, 5.0, 2.30, 2.50, 100.0, 2),
            band(bu.0, bu.1, 0.0, 2.3, 50.0, 3),
            band(bu.0, bu.1, 2.5, 2.6, 50.0, 3),
        ];
        let out = dominant_bands(&bands);
        for p in out.iter().filter(|p| p.src < 2) {
            let x = p.rect.unwrap();
            assert!(!(x.u_min < bu.1 - 1e-4 && x.u_max > bu.0 + 1e-4), "Rest {x:?} ragt in den Backstein");
        }
        assert!(approx(area_of(&out, &bands, 2), 1.0));
        assert!(approx(area_of(&out, &bands, 3), 0.15 * 2.3 + 0.15 * 0.1));
    }

    #[test]
    fn gleiche_prioritaet_koexistiert() {
        // Gleiche Priorität, verschiedene Komponenten: kein Schnitt, kein Verschmelzen.
        let bands = [band(0.0, 1.0, 0.0, 3.0, 100.0, 0), band(0.0, 1.0, 2.0, 4.0, 100.0, 1)];
        let out = dominant_bands(&bands);
        assert_eq!(out.len(), 2);
        assert!(approx(area_of(&out, &bands, 0), 3.0) && approx(area_of(&out, &bands, 1), 2.0));
    }

    #[test]
    fn ohne_prioritaet_keine_teilnahme() {
        let bands = [band(0.0, 2.0, 0.0, 2.0, 100.0, 0), Band { rect: Some(r(0.0, 2.0, 0.0, 2.0)), prio: None, comp: None }];
        let out = dominant_bands(&bands);
        assert_eq!(out, vec![Piece { src: 0, rect: Some(r(0.0, 2.0, 0.0, 2.0)) }, Piece { src: 1, rect: None }]);
    }

    #[test]
    fn gleiche_komponente_verschmilzt() {
        // Nebeneinander (v-deckungsgleich) und übereinander mit Überlapp (u-deckungsgleich).
        let bands = [band(0.0, 1.0, 0.0, 1.0, 10.0, 3), band(1.0, 2.0, 0.0, 1.0, 10.0, 3)];
        assert_eq!(dominant_bands(&bands), vec![Piece { src: 0, rect: Some(r(0.0, 2.0, 0.0, 1.0)) }]);
        let bands = [band(0.0, 1.0, 0.0, 3.0, 100.0, 0), band(0.0, 1.0, 2.0, 4.0, 100.0, 0)];
        assert_eq!(dominant_bands(&bands), vec![Piece { src: 0, rect: Some(r(0.0, 1.0, 0.0, 4.0)) }]);
    }

    /// [125] Abweichung der früheren Fassungen: Ein Band mit nicht endlichem Rechteck (NaN-Ecke) liess im
    /// 2D-Schnitt (JS-`Math.min/max`) als Schneider JEDES schwächere Band verschwinden (alle Vergleiche
    /// mit NaN falsch ⇒ kein Rest), im 3D-Schnitt (f32 `min/max` ignorieren NaN) zählte nur die endliche
    /// Hülle. Jetzt nimmt es wie ein Band ohne Rechteck nicht teil.
    #[test]
    fn nicht_endliches_rechteck_nimmt_nicht_teil() {
        let kaputt = Band { rect: Some(r(f64::NAN, 1.0, 0.0, 1.0)), prio: Some(100.0), comp: Some(1) };
        let bands = [band(0.0, 1.0, 0.0, 1.0, 10.0, 0), kaputt];
        let out = dominant_bands(&bands);
        assert_eq!(out, vec![Piece { src: 0, rect: Some(r(0.0, 1.0, 0.0, 1.0)) }, Piece { src: 1, rect: None }]);
        let pts = [(0.0, 0.0), (f64::NAN, 1.0), (1.0, 1.0)];
        assert!(rect_of_points(pts.iter().copied()).is_some_and(|x| !x.is_finite()));
        assert!(rect_of_points([(0.0, 0.0), (1.0, 1.0)].into_iter()).is_none());
    }

    /// [125] Abweichung der früheren 3D-Fassung: sie rechnete in f32 — bei Koordinaten um 100 m (ulp ≈ 8e-6)
    /// verschwand ein Überlapp von 2e-6 (> EPS) beim Runden; das Stück blieb im 3D-Schnitt stehen, im
    /// 2D-Schnitt nicht. Beide rechnen jetzt in f64.
    #[test]
    fn kleiner_ueberlapp_bei_grossen_koordinaten() {
        let bands = [band(0.0, 100.0, 0.0, 1.0, 10.0, 0), band(99.999998, 200.0, 0.0, 1.0, 100.0, 1)];
        let out = dominant_bands(&bands);
        assert_eq!(out[0], Piece { src: 0, rect: Some(r(0.0, 99.999998, 0.0, 1.0)) });
        // f32 sah hier keinen Überlapp:
        assert_eq!(99.999998_f32, 100.0_f32);
    }

    #[test]
    fn leere_eingabe() {
        assert!(dominant_bands(&[]).is_empty());
    }

    /// Die schnelle Verschmelzung und die Vorauswahl der Schneider liefern dasselbe wie die schlichte
    /// Fassung (Zufalls-Rechtecke auf einem groben Raster, viele Berührungen und gleiche Komponenten).
    #[test]
    fn schnell_gleich_schlicht() {
        let mut x: u64 = 12345;
        let mut rnd = |m: u64| {
            x = x.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            (x >> 33) % m
        };
        for _ in 0..300 {
            let n = 1 + rnd(40) as usize;
            let bands: Vec<Band> = (0..n)
                .map(|_| {
                    let (u0, v0) = (rnd(10) as f64 * 0.5, rnd(10) as f64 * 0.5);
                    let (w, h) = (0.5 * (1 + rnd(4)) as f64, 0.5 * (1 + rnd(4)) as f64);
                    let prio = [Some(10.0), Some(50.0), Some(100.0), None][rnd(4) as usize];
                    let comp = rnd(4).checked_sub(1).map(|c| c as u32);
                    let rect = (rnd(10) != 0).then_some(r(u0, u0 + w, v0, v0 + h));
                    Band { rect, prio, comp }
                })
                .collect();
            let fast = dominant_bands(&bands);
            // schlicht: alle Schneider der Reihe nach, schlichte Verschmelzung
            let mut out = Vec::new();
            for i in 0..n {
                let (Some(base), Some(prio)) = (bands[i].rect, bands[i].prio) else {
                    out.push(Piece { src: i, rect: None });
                    continue;
                };
                let mut pieces = vec![base];
                for j in 0..n {
                    let (Some(c), Some(o)) = (bands[j].rect, bands[j].prio) else { continue };
                    if j == i || o <= prio {
                        continue;
                    }
                    pieces = pieces.into_iter().flat_map(|p| subtract_rect(p, c)).collect();
                }
                out.extend(pieces.into_iter().map(|p| Piece { src: i, rect: Some(p) }));
            }
            assert_eq!(fast, merge_same_component_naive(&bands, out));
        }
    }
}
