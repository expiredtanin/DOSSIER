//! Schnitt-Boolean-Dominanz fuer den 3D-Live-Schnitt: duenner Adapter um
//! `dossier_hatch::section_dominance` ([125]) — dieselbe Rechnung wie der 2D-Schnitt
//! (`dossier-core`, `plan/section.rs`), damit beide nicht auseinanderlaufen.
//!
//! Der 3D-Rust-Cut (`section.rs`) liefert achsparallele (u,v)-Rechteck-`CutPolygon`s; Prioritaet und
//! Komponente je Band kommen aus `CutPolygon::cut` (`CutBandMeta`, aus der TS-Emission `toWalls3d`).
//! Baender ohne `join_priority` (unaufloesbares Bauteil, Dach-Schichten) nehmen weder als Basis noch als
//! Cutter teil und bleiben unveraendert. Gerechnet wird in f64, das Ergebnis zurueck in f32.

use crate::section::CutPolygon;
use dossier_hatch::section_dominance::{dominant_bands, rect_of_points, Band, Rect};
use std::collections::HashMap;

/// Erzeugt aus einem Rest-`Rect` ein Cut-Band, das Stil/Referenz/Metadaten von `src` erbt. Ecken wie in
/// `section.rs` (v_max oben zuerst — fuer die Fan-Triangulierung irrelevant).
fn poly_from_rect(src: &CutPolygon, r: Rect) -> CutPolygon {
    let (u0, u1, v0, v1) = (r.u_min as f32, r.u_max as f32, r.v_min as f32, r.v_max as f32);
    CutPolygon {
        component: src.component,
        color: src.color,
        hatch: src.hatch,
        cut: src.cut.clone(),
        pts: vec![[u0, v1], [u1, v1], [u1, v0], [u0, v0]],
    }
}

/// Globale Schnitt-Dominanz (staerkere `join_priority` schneidet schwaechere weg, gleiche Komponente
/// und Prioritaet verschmilzt) — siehe `dossier_hatch::section_dominance`.
pub fn subtract_dominant_bands(bands: Vec<CutPolygon>) -> Vec<CutPolygon> {
    let mut ids: HashMap<&str, u32> = HashMap::new();
    let inp: Vec<Band> = bands
        .iter()
        .map(|b| {
            let meta = b.cut.as_ref();
            let comp = meta.and_then(|c| c.component_id.as_deref()).map(|id| {
                let n = ids.len() as u32;
                *ids.entry(id).or_insert(n)
            });
            Band {
                rect: rect_of_points(b.pts.iter().map(|p| (p[0] as f64, p[1] as f64))),
                prio: meta.and_then(|c| c.join_priority).map(f64::from),
                comp,
            }
        })
        .collect();
    dominant_bands(&inp)
        .into_iter()
        .map(|piece| match piece.rect {
            Some(r) => poly_from_rect(&bands[piece.src], r),
            None => bands[piece.src].clone(),
        })
        .collect()
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

    /// Umgebendes Rechteck eines Bands (f32, wie die Ecken).
    #[derive(Debug)]
    struct R {
        u_min: f32,
        u_max: f32,
        v_min: f32,
        v_max: f32,
    }

    fn rect_of(p: &CutPolygon) -> R {
        let r = rect_of_points(p.pts.iter().map(|q| (q[0] as f64, q[1] as f64))).unwrap();
        R { u_min: r.u_min as f32, u_max: r.u_max as f32, v_min: r.v_min as f32, v_max: r.v_max as f32 }
    }

    fn component_of(poly: &CutPolygon) -> Option<&str> {
        poly.cut.as_ref().and_then(|c| c.component_id.as_deref())
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

    // --- Adapter Ende-zu-Ende (Rechnung: dossier_hatch::section_dominance) ----

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

    #[test]
    fn dach_ohne_prioritaet_bleibt_polygon() {
        // Dach-Schicht (schiefes Trapez, ohne join_priority) wird unveraendert durchgereicht, auch wenn
        // ein staerkeres Band ueberlappt — keine Ersetzung durch die Bounding-Box.
        let mut dach = band(0.0, 2.0, 0.0, 1.0, 0, Some("dach"));
        dach.cut = None;
        dach.pts = vec![[0.0, 0.0], [2.0, 0.0], [1.5, 1.0], [0.5, 1.0]];
        let pts = dach.pts.clone();
        let beton = band(0.0, 2.0, 0.0, 1.0, 100, Some("beton"));
        let out = subtract_dominant_bands(vec![dach, beton]);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].pts, pts);
    }
}
