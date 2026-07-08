//! Schnitt-Boolean-Dominanz fuer den 3D-Live-Schnitt — die 1:1-Portierung von
//! `src/plan/toSection.ts::subtractDominantBands`/`subtractRect` nach Rust.
//!
//! GRUND: der 2D-Schnitt (`toSection.ts`) ist die Referenz-Implementierung. Er
//! sammelt alle Cut-Baender (Wand- und Deckenschichten) als achsparallele
//! (u,v)-Rechtecke, taggt jedes mit seiner `Component.joinPriority` und laesst
//! dann die STAERKERE Schicht die schwaechere per Rechteck-Subtraktion wegschneiden
//! (elementuebergreifend). Der 3D-Rust-Cut (`section.rs`) produziert bereits genau
//! dasselbe Format — achsparallele (u,v)-Rechteck-`CutPolygon`s — also laesst sich
//! die Dominanz-Zerlegung hier identisch nachbauen, damit der 3D-Live-Schnitt fuer
//! Wand+Decken-Schichten EXAKT wie der 2D-Schnitt aussieht.
//!
//! Die Prioritaet/Identitaet je Band kommt aus `CutPolygon::cut` (`CutBandMeta`,
//! aus der TS-Emission `toWalls3d`). Baender ohne `join_priority` (unaufloesbares
//! Bauteil) nehmen weder als Basis noch als Cutter teil und bleiben unveraendert.

use crate::section::CutPolygon;

/// Toleranz fuer Ueberlappungs-/Rest-Rechtecke (Meter): Null-/Negativflaechen und
/// Rest-Streifen duenner als EPS werden verworfen (Float-Rauschen der (u,v)-Meter).
/// Identisch zu `RECT_EPS` in `toSection.ts`.
const RECT_EPS: f32 = 1e-6;

/// Achsparalleles Rechteck in (u, v)-Metern — das Rust-Gegenstueck zu `Rect` in
/// `toSection.ts`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub u_min: f32,
    pub u_max: f32,
    pub v_min: f32,
    pub v_max: f32,
}

/// Bounding-Box eines (achsparallelen) Cut-Bands als `Rect`, oder `None` bei <3
/// Ecken (analog `rectOfBand`).
pub fn rect_of_poly(poly: &CutPolygon) -> Option<Rect> {
    if poly.pts.len() < 3 {
        return None;
    }
    let mut u_min = f32::INFINITY;
    let mut u_max = f32::NEG_INFINITY;
    let mut v_min = f32::INFINITY;
    let mut v_max = f32::NEG_INFINITY;
    for p in &poly.pts {
        u_min = u_min.min(p[0]);
        u_max = u_max.max(p[0]);
        v_min = v_min.min(p[1]);
        v_max = v_max.max(p[1]);
    }
    Some(Rect {
        u_min,
        u_max,
        v_min,
        v_max,
    })
}

/// Rechteck-minus-Rechteck (beide achsparallel): `base` ohne die Ueberlappung mit
/// `cutter`, zerlegt in 0–4 disjunkte Rest-Rechtecke (links/rechts ueber die volle
/// Hoehe, dann oben/unten im mittleren u-Streifen — ueberlappungsfrei). Kein echter
/// Ueberlapp (Flaeche ≤ EPS in u oder v) ⇒ `base` bleibt ganz. Vollstaendige
/// Ueberdeckung ⇒ leere Liste. Rest-Streifen duenner als EPS werden verworfen.
/// 1:1 aus `toSection.ts::subtractRect`.
pub fn subtract_rect(base: Rect, cutter: Rect) -> Vec<Rect> {
    let o_min_u = base.u_min.max(cutter.u_min);
    let o_max_u = base.u_max.min(cutter.u_max);
    let o_min_v = base.v_min.max(cutter.v_min);
    let o_max_v = base.v_max.min(cutter.v_max);
    // Kein (nennenswerter) Ueberlapp — `base` unveraendert.
    if o_max_u - o_min_u <= RECT_EPS || o_max_v - o_min_v <= RECT_EPS {
        return vec![base];
    }
    let mut out = Vec::new();
    let mut push = |r: Rect| {
        if r.u_max - r.u_min > RECT_EPS && r.v_max - r.v_min > RECT_EPS {
            out.push(r);
        }
    };
    // Links / rechts der Ueberlappung, jeweils ueber die volle Basis-Hoehe.
    push(Rect {
        u_min: base.u_min,
        u_max: o_min_u,
        v_min: base.v_min,
        v_max: base.v_max,
    });
    push(Rect {
        u_min: o_max_u,
        u_max: base.u_max,
        v_min: base.v_min,
        v_max: base.v_max,
    });
    // Unten / oben im mittleren u-Streifen (nur der von der Ueberlappung befreite Rest).
    push(Rect {
        u_min: o_min_u,
        u_max: o_max_u,
        v_min: base.v_min,
        v_max: o_min_v,
    });
    push(Rect {
        u_min: o_min_u,
        u_max: o_max_u,
        v_min: o_max_v,
        v_max: base.v_max,
    });
    out
}

/// `join_priority` eines Bands (aus `CutBandMeta`), oder `None`.
fn priority_of(poly: &CutPolygon) -> Option<i32> {
    poly.cut.as_ref().and_then(|c| c.join_priority)
}

/// `component_id` eines Bands (aus `CutBandMeta`), oder `None`.
fn component_of(poly: &CutPolygon) -> Option<&str> {
    poly.cut.as_ref().and_then(|c| c.component_id.as_deref())
}

/// Erzeugt aus einem Rest-`Rect` ein Cut-Band, das Stil/Referenz/Metadaten von
/// `src` erbt (analog `bandFromRect`). Ecken-Reihenfolge wie in `section.rs`
/// (CCW-analog, hier v_max oben zuerst — fuer die Fan-Triangulierung irrelevant).
fn poly_from_rect(src: &CutPolygon, r: Rect) -> CutPolygon {
    CutPolygon {
        component: src.component,
        color: src.color,
        hatch: src.hatch,
        cut: src.cut.clone(),
        pts: vec![
            [r.u_min, r.v_max],
            [r.u_max, r.v_max],
            [r.u_max, r.v_min],
            [r.u_min, r.v_min],
        ],
    }
}

/// Globale Schnitt-Dominanz: fuer jedes Band wird die Rechteck-Ueberlappung ALLER
/// Baender mit STRIKT hoeherer `join_priority` subtrahiert (elementuebergreifend —
/// z. B. schneidet ein Decken-Beton-Band 100 ein ueberlappendes Wand-Putz-Band 10
/// weg). Gleiche Prioritaet schneidet NICHT (koexistiert → durchgehende Flaeche).
/// Baender ohne `join_priority` nehmen weder als Basis noch als Cutter teil und
/// bleiben unveraendert erhalten. 1:1 aus `toSection.ts::subtractDominantBands`
/// (inklusive der abschliessenden MERGE-Phase).
pub fn subtract_dominant_bands(bands: Vec<CutPolygon>) -> Vec<CutPolygon> {
    let rects: Vec<Option<Rect>> = bands.iter().map(rect_of_poly).collect();
    let prios: Vec<Option<i32>> = bands.iter().map(priority_of).collect();
    let mut out: Vec<CutPolygon> = Vec::new();

    for i in 0..bands.len() {
        // Nicht-rechteckig oder ohne Prioritaet: unveraendert durchreichen.
        let (base, prio) = match (rects[i], prios[i]) {
            (Some(b), Some(p)) => (b, p),
            _ => {
                out.push(bands[i].clone());
                continue;
            }
        };
        let mut pieces = vec![base];
        for j in 0..bands.len() {
            if pieces.is_empty() {
                break;
            }
            if j == i {
                continue;
            }
            let cutter = match (rects[j], prios[j]) {
                (Some(c), Some(op)) if op > prio => c,
                _ => continue,
            };
            let mut next = Vec::new();
            for p in &pieces {
                next.extend(subtract_rect(*p, cutter));
            }
            pieces = next;
        }
        for p in pieces {
            out.push(poly_from_rect(&bands[i], p));
        }
    }
    merge_same_component_bands(out)
}

/// Union zweier achsparalleler Rechtecke, ABER NUR wenn das Ergebnis EXAKT wieder
/// ein Rechteck ist — sonst `None`. Enthaltensein oder Achs-Deckung + Beruehrung
/// liefern eine rechteckige Union; Teil-/Eck-Ueberlappungen (L-Form) und Baender
/// mit Spalt liefern `None`. 1:1 aus `toSection.ts::rectUnionIfRect`.
fn rect_union_if_rect(a: Rect, b: Rect) -> Option<Rect> {
    const E: f32 = RECT_EPS;
    // Enthaltensein (inkl. Deckungsgleichheit): Union = umschliessendes Rechteck.
    let a_in_b = b.u_min - a.u_min <= E
        && a.u_max - b.u_max <= E
        && b.v_min - a.v_min <= E
        && a.v_max - b.v_max <= E;
    if a_in_b {
        return Some(b);
    }
    let b_in_a = a.u_min - b.u_min <= E
        && b.u_max - a.u_max <= E
        && a.v_min - b.v_min <= E
        && b.v_max - a.v_max <= E;
    if b_in_a {
        return Some(a);
    }
    let u_aligned = (a.u_min - b.u_min).abs() <= E && (a.u_max - b.u_max).abs() <= E;
    let v_aligned = (a.v_min - b.v_min).abs() <= E && (a.v_max - b.v_max).abs() <= E;
    // Beruehrung/Ueberlappung in der jeweils ANDEREN Achse (kein Spalt groesser EPS).
    let v_touch = a.v_max >= b.v_min - E && b.v_max >= a.v_min - E;
    let u_touch = a.u_max >= b.u_min - E && b.u_max >= a.u_min - E;
    if (u_aligned && v_touch) || (v_aligned && u_touch) {
        return Some(Rect {
            u_min: a.u_min.min(b.u_min),
            u_max: a.u_max.max(b.u_max),
            v_min: a.v_min.min(b.v_min),
            v_max: a.v_max.max(b.v_max),
        });
    }
    None
}

/// MERGE-Phase der Schnitt-Dominanz: Baender mit GLEICHER `component_id` UND
/// gleicher `join_priority`, deren achsparallele Rechtecke sich beruehren/ueberlappen
/// und eine rechteckige Union bilden (`rect_union_if_rect`), werden zu EINEM Band
/// zusammengefasst — so entsteht an der Beruehrkante keine innere Trennlinie durch
/// gleichartiges Material. Baender ohne `component_id`/`join_priority` oder ohne
/// Rechteck-Form nehmen nicht teil. Iterativ bis zum Fixpunkt. 1:1 aus
/// `toSection.ts::mergeSameComponentBands`.
fn merge_same_component_bands(bands: Vec<CutPolygon>) -> Vec<CutPolygon> {
    let mut out = bands;
    let mut merged = true;
    while merged {
        merged = false;
        'outer: for i in 0..out.len() {
            let (ci, pi) = match (component_of(&out[i]), priority_of(&out[i])) {
                (Some(c), Some(p)) => (c.to_string(), p),
                _ => continue,
            };
            let ri = match rect_of_poly(&out[i]) {
                Some(r) => r,
                None => continue,
            };
            for j in (i + 1)..out.len() {
                if component_of(&out[j]) != Some(ci.as_str()) || priority_of(&out[j]) != Some(pi) {
                    continue;
                }
                let rj = match rect_of_poly(&out[j]) {
                    Some(r) => r,
                    None => continue,
                };
                if let Some(u) = rect_union_if_rect(ri, rj) {
                    out[i] = poly_from_rect(&out[i], u);
                    out.remove(j);
                    merged = true; // Fixpunkt-Neustart
                    break 'outer;
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::section::{ComponentKind, ComponentRef, CutPolygon};
    use crate::types::CutBandMeta;

    /// Achsparalleles Cut-Band mit Prioritaet (und optionaler Komponenten-Id) —
    /// Ecken wie `section.rs` (Rechteck).
    fn band(
        u_min: f32,
        u_max: f32,
        v_min: f32,
        v_max: f32,
        join_priority: i32,
        component_id: Option<&str>,
    ) -> CutPolygon {
        CutPolygon {
            component: ComponentRef {
                kind: ComponentKind::Wall,
                index: 0,
            },
            color: [0.5, 0.5, 0.5],
            hatch: None,
            pts: vec![
                [u_min, v_max],
                [u_max, v_max],
                [u_max, v_min],
                [u_min, v_min],
            ],
            cut: Some(CutBandMeta {
                join_priority: Some(join_priority),
                component_id: component_id.map(|s| s.to_string()),
                line_color: None,
                line_weight: None,
            }),
        }
    }

    fn rect_of(p: &CutPolygon) -> Rect {
        rect_of_poly(p).unwrap()
    }

    fn area(bands: &[CutPolygon]) -> f32 {
        bands
            .iter()
            .map(|b| {
                let r = rect_of(b);
                (r.u_max - r.u_min) * (r.v_max - r.v_min)
            })
            .sum()
    }

    fn approx(a: f32, b: f32) -> bool {
        (a - b).abs() < 1e-5
    }

    // --- subtractRect (Referenz: toSection.boolean.test.ts) ------------------

    #[test]
    fn subtract_rect_kein_overlap_base_unveraendert() {
        let base = Rect { u_min: 0.0, u_max: 1.0, v_min: 0.0, v_max: 1.0 };
        let cut = Rect { u_min: 2.0, u_max: 3.0, v_min: 2.0, v_max: 3.0 };
        assert_eq!(subtract_rect(base, cut), vec![base]);
    }

    #[test]
    fn subtract_rect_kantenberuehrung_base_unveraendert() {
        let base = Rect { u_min: 0.0, u_max: 1.0, v_min: 0.0, v_max: 1.0 };
        let cut = Rect { u_min: 1.0, u_max: 2.0, v_min: 0.0, v_max: 1.0 };
        assert_eq!(subtract_rect(base, cut), vec![base]);
    }

    #[test]
    fn subtract_rect_cutter_enthaelt_base_leer() {
        let base = Rect { u_min: 1.0, u_max: 2.0, v_min: 1.0, v_max: 2.0 };
        let cut = Rect { u_min: 0.0, u_max: 3.0, v_min: 0.0, v_max: 3.0 };
        assert!(subtract_rect(base, cut).is_empty());
    }

    #[test]
    fn subtract_rect_cutter_mittig_vier_reste() {
        let base = Rect { u_min: 0.0, u_max: 3.0, v_min: 0.0, v_max: 3.0 };
        let cut = Rect { u_min: 1.0, u_max: 2.0, v_min: 1.0, v_max: 2.0 };
        let rest = subtract_rect(base, cut);
        assert_eq!(rest.len(), 4);
        let a: f32 = rest
            .iter()
            .map(|r| (r.u_max - r.u_min) * (r.v_max - r.v_min))
            .sum();
        assert!(approx(a, 8.0), "9 (base) - 1 (overlap) = 8, ist {a}");
    }

    #[test]
    fn subtract_rect_eck_ueberlappung_zwei_reste() {
        // cutter deckt die obere-rechte Ecke von base: overlap [1,2]x[1,2].
        let base = Rect { u_min: 0.0, u_max: 2.0, v_min: 0.0, v_max: 2.0 };
        let cut = Rect { u_min: 1.0, u_max: 3.0, v_min: 1.0, v_max: 3.0 };
        let rest = subtract_rect(base, cut);
        let a: f32 = rest
            .iter()
            .map(|r| (r.u_max - r.u_min) * (r.v_max - r.v_min))
            .sum();
        assert!(approx(a, 3.0), "4 - 1 = 3, ist {a}");
    }

    // --- subtractDominantBands: die geometrische Kernaussage ------------------

    #[test]
    fn decke_100_schneidet_wand_50_im_ueberlappungs_z_intervall_weg() {
        // Nutzer-Sample-analog: eine Wandschicht (Backstein, Prio 50, u in [0,0.2],
        // volle Hoehe v in [0,3]) und ein Decken-Beton-Band (Prio 100, u in [0,0.2],
        // v in [2.6,2.8]) ueberlappen in (u,v). Nach der Subtraktion darf die Wand
        // im Decken-z-Intervall KEINE Flaeche mehr haben; Beton bleibt voll.
        let brick = band(0.0, 0.2, 0.0, 3.0, 50, Some("brick"));
        let concrete = band(0.0, 0.2, 2.6, 2.8, 100, Some("concrete"));
        let out = subtract_dominant_bands(vec![brick, concrete]);

        // Beton unveraendert (kein staerkeres Band).
        let concrete_out: Vec<&CutPolygon> = out
            .iter()
            .filter(|b| component_of(b) == Some("concrete"))
            .collect();
        assert_eq!(concrete_out.len(), 1);
        assert!(approx(
            (rect_of(concrete_out[0]).v_max - rect_of(concrete_out[0]).v_min) as f32,
            0.2
        ));

        // Backstein: in v in [2.6,2.8] KEINE Flaeche mehr -> zwei Reste [0,2.6] und
        // [2.8,3.0]. Kein Rest-Rechteck ragt ins Beton-Intervall.
        let brick_out: Vec<&CutPolygon> = out
            .iter()
            .filter(|b| component_of(b) == Some("brick"))
            .collect();
        assert!(!brick_out.is_empty());
        for b in &brick_out {
            let r = rect_of(b);
            // Kein Backstein-Rest ueberlappt (2.6, 2.8) echt.
            let overlaps = r.v_min < 2.8 - 1e-4 && r.v_max > 2.6 + 1e-4;
            assert!(!overlaps, "Backstein-Rest {r:?} ragt ins Beton-z-Intervall");
        }
        // Flaechenbilanz: Backstein 0.2*3 = 0.6, minus Overlap 0.2*0.2 = 0.04 -> 0.56.
        assert!(
            approx(area(&out.iter().filter(|b| component_of(b) == Some("brick")).cloned().collect::<Vec<_>>()), 0.56),
            "Backstein-Restflaeche"
        );
    }

    #[test]
    fn wand_50_schneidet_estrich_30() {
        // Estrich (Decke, Prio 30) verliert die Ueberlappung mit der Wand
        // (Backstein, Prio 50). Referenz-Zahlen wie im 2D-Test.
        let screed = band(0.0, 2.0, 0.0, 3.0, 30, Some("screed"));
        let brick = band(0.0, 2.0, 2.0, 4.0, 50, Some("brick")); // Overlap v in [2,3]
        let out = subtract_dominant_bands(vec![screed, brick]);

        // Brick voll.
        assert!(approx(
            area(&out.iter().filter(|b| component_of(b) == Some("brick")).cloned().collect::<Vec<_>>()),
            4.0
        ));
        // Estrich: [0,3] minus Overlap [2,3] = [0,2] -> Rest genau v in [0,2].
        let screed_out: Vec<&CutPolygon> = out
            .iter()
            .filter(|b| component_of(b) == Some("screed"))
            .collect();
        assert_eq!(screed_out.len(), 1);
        let r = rect_of(screed_out[0]);
        assert!(approx(r.v_min, 0.0) && approx(r.v_max, 2.0), "Estrich-Rest {r:?}");
    }

    /// SAMPLE-ANALOG (Nutzer-Bug): der Schnitt durch Aussenwand + Geschossdecke.
    /// Deckenschichten (u-breit, gestapelt in v nahe OK): Estrich (30, [2.54,2.6]),
    /// Dämmung (20, [2.50,2.54]), Beton (100, [2.30,2.50]). Wandschichten (schmal in
    /// u, an ihrer Dicken-Position): Backstein (50) läuft als ZWEI Boxen [0,2.3] +
    /// [2.5,2.6] durch (Beton kappt das Mittelstück — genau die per-Schicht-Decken-
    /// Dominanz aus emitWall). ERWARTUNG: nach der Verschneidung haben Estrich UND
    /// Dämmung im u-Bereich des Backsteins KEINE Fläche mehr (Backstein 50 > 30, 20);
    /// der Beton bleibt voll und läuft durch. Das ist die Richtung, die der Nutzer als
    /// kaputt meldete ("dämmung und zementboden laufen raus").
    #[test]
    fn sample_analog_backstein_schneidet_estrich_und_daemmung() {
        let brick_u = (0.0075_f32, 0.1575_f32); // Backstein-Dickenposition (W4-analog)
        let ceil_u = (0.0_f32, 5.0_f32); // Deckenschichten über die volle Raumbreite
        let bands = vec![
            band(ceil_u.0, ceil_u.1, 2.54, 2.6, 30, Some("screed")),
            band(ceil_u.0, ceil_u.1, 2.50, 2.54, 20, Some("insulation-ceiling")),
            band(ceil_u.0, ceil_u.1, 2.30, 2.50, 100, Some("concrete")),
            band(brick_u.0, brick_u.1, 0.0, 2.3, 50, Some("brick")),
            band(brick_u.0, brick_u.1, 2.5, 2.6, 50, Some("brick")),
        ];
        let out = subtract_dominant_bands(bands);

        // Kein Estrich-/Dämmung-Rest überlappt den Backstein-u-Bereich ECHT.
        for name in ["screed", "insulation-ceiling"] {
            for b in out.iter().filter(|b| component_of(b) == Some(name)) {
                let r = rect_of(b);
                let u_overlap = r.u_min < brick_u.1 - 1e-4 && r.u_max > brick_u.0 + 1e-4;
                assert!(
                    !u_overlap,
                    "{name}-Rest {r:?} ragt noch in den Backstein-u-Bereich (müsste weg sein)"
                );
            }
        }
        // Beton bleibt voll (kein stärkeres Band): Fläche 5*0.2 = 1.0.
        assert!(approx(
            area(&out.iter().filter(|b| component_of(b) == Some("concrete")).cloned().collect::<Vec<_>>()),
            1.0
        ));
        // Backstein bleibt in beiden Boxen erhalten (nichts Stärkeres überlappt).
        assert!(approx(
            area(&out.iter().filter(|b| component_of(b) == Some("brick")).cloned().collect::<Vec<_>>()),
            0.15 * 2.3 + 0.15 * 0.1
        ));
    }

    #[test]
    fn gleiche_prioritaet_koexistiert() {
        // Beton-Wand + Beton-Decke, gleiche Prio 100, VERSCHIEDENE Komponenten:
        // schneiden sich NICHT und verschmelzen NICHT (bleiben beide voll).
        let wand = band(0.0, 1.0, 0.0, 3.0, 100, Some("beton-wand"));
        let decke = band(0.0, 1.0, 2.0, 4.0, 100, Some("beton-decke")); // Overlap v[2,3]
        let out = subtract_dominant_bands(vec![wand, decke]);
        assert_eq!(out.len(), 2);
        assert!(approx(
            area(&out.iter().filter(|b| component_of(b) == Some("beton-wand")).cloned().collect::<Vec<_>>()),
            3.0
        ));
        assert!(approx(
            area(&out.iter().filter(|b| component_of(b) == Some("beton-decke")).cloned().collect::<Vec<_>>()),
            2.0
        ));
    }

    #[test]
    fn ohne_prioritaet_keine_teilnahme() {
        let stark = band(0.0, 2.0, 0.0, 2.0, 100, None);
        let mut ohne = band(0.0, 2.0, 0.0, 2.0, 0, None);
        ohne.cut = None; // keine Prioritaet
        let out = subtract_dominant_bands(vec![stark, ohne]);
        // Beide unveraendert (4 + 4).
        assert_eq!(out.len(), 2);
        assert!(approx(area(&out), 8.0));
    }

    #[test]
    fn merge_gleiche_komponente_und_prioritaet() {
        // Beton-Wand trifft Beton-Decke (u-deckungsgleich), gleiche componentId +
        // Prio -> verschmelzen zu EINEM Rechteck v in [0,4] (keine innere Kante).
        let wand = band(0.0, 1.0, 0.0, 3.0, 100, Some("beton"));
        let decke = band(0.0, 1.0, 2.0, 4.0, 100, Some("beton"));
        let out = subtract_dominant_bands(vec![wand, decke]);
        assert_eq!(out.len(), 1);
        let r = rect_of(&out[0]);
        assert!(approx(r.v_min, 0.0) && approx(r.v_max, 4.0), "verschmolzen {r:?}");
    }
}
