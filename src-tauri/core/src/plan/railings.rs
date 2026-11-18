//! [279] Geländer im Grundriss (`Project.railings`). Geometrie aus `crate::railing`, die Zonen zur Schnitthöhe wie bei
//! den Stützen (`view_range`): geschnitten oder darunter ausgezogen, darüber gestrichelt (Strich-Punkt, SIA 400),
//! darunter sichtbar gepunktet.
//!
//! Zeichen je Art (Strichstärke der Klasse, Farbe der Klasse bzw. des Geländers):
//! - **Stäbe:** eine Linie in der Achse (Handlauf über den Stäben) und kleine gefüllte Pfosten (bis 1:200).
//! - **Glas:** Doppellinie im Abstand der Glasdicke (mindestens 0.7 mm Papier, damit die Linien nicht ineinanderlaufen),
//!   an offenen Enden geschlossen.
//! - **Lochblech:** wie Glas, dazu eine gestrichelte Mittellinie.
//! - **Brüstung (massiv):** geschnittene Fläche mit Bauteil-Schraffur (Poché wie die Stützen), Umriss ohne Gehrungsfugen.
//!
//! Pick: unsichtbare Fläche um die Achse (mindestens 4 mm Papier breit) mit `contextObjectId = "@railing:<id>"`.

use super::domains::Ctx;
use super::prim::Primitive;
use super::style::*;
use super::view_range::{ViewRange, Zone};
use crate::model::*;
use crate::railing::{self, PICK_PREFIX};

fn v(q: [f64; 2]) -> Vec2 {
    Vec2 { x: q[0], y: q[1] }
}

/// Pick-Id eines Geländers (Feld `contextObjectId`).
pub fn pick_id(id: &str) -> String {
    format!("{PICK_PREFIX}{id}")
}

/// Ist `q` ein Planzeichen eines Geländers (Linien, Pick-Fläche)?
pub fn is_symbol_part(q: &Primitive) -> bool {
    match q {
        Primitive::Line { cls, .. } => cls.starts_with("railing-"),
        Primitive::Polygon { context_object_id: Some(id), .. } => id.starts_with(PICK_PREFIX),
        _ => false,
    }
}

/// Linie mit Strichstärke und Farbe.
fn seg(a: [f64; 2], b: [f64; 2], cls: &str, w: f64, color: &str, dash: Option<&[f64]>, greyed: Option<bool>) -> Primitive {
    super::trees::line(v(a), v(b), cls, w, color, dash, greyed)
}

/// Streckenzug als Linien.
fn polyline(out: &mut Vec<Primitive>, pts: &[[f64; 2]], cls: &str, w: f64, color: &str, dash: Option<&[f64]>, greyed: Option<bool>) {
    for s in pts.windows(2) {
        out.push(seg(s[0], s[1], cls, w, color, dash, greyed));
    }
}

/// Planzeichen aller Geländer dieses Geschosses (sichtbare Klasse, im Ansichtsbereich).
pub(super) fn plan_railings(c: &Ctx, out: &mut Vec<Primitive>) {
    let p = c.p;
    let Some(list) = p.railings.as_deref() else { return };
    if list.iter().all(|r| r.floor_id != c.a.floor) {
        return;
    }
    let range = ViewRange::of(p, &c.a.floor);
    for r in list.iter().filter(|r| r.floor_id == c.a.floor && c.vis(&r.category_code, &r.id)) {
        let (Some(s), Some(ax)) = (railing::spec(p, r), railing::axis(r)) else { continue };
        let zone = range.classify(s.z0, s.top());
        if zone == Zone::Hidden {
            continue;
        }
        let from = out.len();
        let greyed = Some(c.greyed(&r.category_code));
        let category = c.cat(&r.category_code);
        let ov = c.overrides(Some("railing"), &r.category_code, Some(&railing::label(r)));
        let lw = ov.lineweight.unwrap_or_else(|| category.map_or(WALL_FALLBACK_MM, |k| k.lw));
        let color = ov.color.as_deref().or(r.color.as_deref());
        let stroke = color.or(category.map(|k| k.color.as_str())).unwrap_or(MONO_INK).to_string();
        let mm = (c.a.scale / 1000.0).max(1e-6);
        let closed = crate::stair_rail::is_closed(&ax);

        // Pick: unsichtbare Fläche, mindestens 4 mm Papier breit.
        let pick_half = (s.thickness.max(s.rail_w()) / 2.0).max(2.0 * mm);
        for q in railing::strips(&ax, pick_half).0 {
            out.push(super::trees::poly(q.iter().map(|&q| v(q)).collect(), "none", "none", 0.0, Some(pick_id(&r.id)), greyed));
        }

        match s.kind {
            RailingKind::Solid => {
                let (quads, l, rt) = railing::strips(&ax, s.thickness / 2.0);
                let (mut fill, mut hatch) = (color.or(category.map(|k| k.color.as_str())).unwrap_or(HATCH_PAPER).to_string(), no_hatch());
                if zone != Zone::Cut {
                    fill = "none".into();
                } else if let Some(k) = r.component_id.as_deref().filter(|s| !s.is_empty()).and_then(|id| p.component(id)) {
                    if let Some(h) = resolve_hatch(p, resolve_hatch_id(None, None, category, Some(&k.hatch_id)).unwrap_or(&k.hatch_id), None, resolve_foreground(k, None, category, None), None) {
                        fill = resolve_background(k, None, category, None).unwrap_or(if h.pattern == HatchPattern::Solid { HATCH_INK } else { HATCH_PAPER }).to_string();
                        hatch = h;
                    }
                } else {
                    fill = HATCH_PAPER.to_string();
                }
                if zone == Zone::Cut && c.solid_cut() && category.is_some() {
                    fill = HATCH_INK.to_string();
                    hatch = no_hatch();
                }
                for q in quads {
                    let mut f = super::trees::poly(q.iter().map(|&q| v(q)).collect(), &fill, "none", 0.0, None, greyed);
                    if let Primitive::Polygon { hatch: h, .. } = &mut f {
                        **h = hatch.clone();
                    }
                    out.push(f);
                }
                polyline(out, &l, "railing-solid", lw, &stroke, None, greyed);
                polyline(out, &rt, "railing-solid", lw, &stroke, None, greyed);
                if !closed {
                    out.push(seg(l[0], rt[0], "railing-solid", lw, &stroke, None, greyed));
                    out.push(seg(l[l.len() - 1], rt[rt.len() - 1], "railing-solid", lw, &stroke, None, greyed));
                }
            }
            RailingKind::Glass | RailingKind::Perforated => {
                // Mindestabstand der Doppellinie: 0.7 mm Papier.
                let half = (s.thickness / 2.0).max(0.35 * mm);
                let (_, l, rt) = railing::strips(&ax, half);
                polyline(out, &l, "railing-glass", lw, &stroke, None, greyed);
                polyline(out, &rt, "railing-glass", lw, &stroke, None, greyed);
                if !closed {
                    out.push(seg(l[0], rt[0], "railing-glass", lw, &stroke, None, greyed));
                    out.push(seg(l[l.len() - 1], rt[rt.len() - 1], "railing-glass", lw, &stroke, None, greyed));
                }
                if s.kind == RailingKind::Perforated {
                    polyline(out, &ax, "railing-perforated", lw * 0.6, &stroke, Some(&super::line_pattern::HIDDEN), greyed);
                }
            }
            _ => {
                polyline(out, &ax, "railing-bars", lw, &stroke, None, greyed);
                // Pfosten als kleine gefüllte Quadrate; bei kleinen Massstäben nicht mehr lesbar.
                if c.a.scale <= 200.0 {
                    for (pt, d) in railing::stations(&ax, &s).0 {
                        let (n, h) = ([-d[1], d[0]], 0.015);
                        let q = |a: f64, b: f64| v([pt[0] + d[0] * a + n[0] * b, pt[1] + d[1] * a + n[1] * b]);
                        out.push(super::trees::poly(vec![q(-h, -h), q(h, -h), q(h, h), q(-h, h)], &stroke, &stroke, 0.0, None, greyed));
                    }
                }
            }
        }
        // Ganz über der Schnitthöhe: Strich-Punkt wie die übrigen Bauteile darüber (auch ohne eigenen Ansichtsbereich, wie die
        // Stufen und Handläufe der Treppen); unter der Schnitthöhe gepunktet nur mit eigenem Bereich.
        let dash = if zone == Zone::Above { Some(&super::view_range::ABOVE_DASH[..]) } else { range.restyle_dash(zone) };
        if let Some(d) = dash {
            super::view_range::restyle(out, from, d);
        }
        // [271] Umbaufilter: das Geländer in der Farbe seines Status (Bestand grau, Abbruch gelb gestrichelt, Neu rot).
        if let Some(st) = c.renovation().and_then(|rn| rn.styled.get(&r.id)) {
            crate::renovation::restyle_linework(out, from, st, true);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plan::domains::{plan_domains, PlanArgs};

    fn project(rail: serde_json::Value) -> Project {
        serde_json::from_value(serde_json::json!({
            "id": "p", "name": "t", "lineStyles": [], "hatches": [], "components": [{"id": "beton", "name": "Beton", "color": "#b0b0b0", "hatchId": "h", "joinPriority": 5}], "wallTypes": [],
            "layers": [{"code": "41", "name": "Geländer", "color": "#102030", "lw": 0.25, "visible": true, "locked": false}],
            "drawingLevels": [{"id": "eg", "name": "EG", "kind": "floor", "visible": true, "locked": false, "baseElevation": 0.0, "floorHeight": 2.6, "cutHeight": 1.0}],
            "walls": [], "openings": [], "drawings2d": [], "railings": [rail]
        }))
        .unwrap()
    }

    fn plan(p: &Project, scale: f64) -> Vec<Primitive> {
        plan_codes(p, scale, &["41"])
    }

    fn plan_codes(p: &Project, scale: f64, codes: &[&str]) -> Vec<Primitive> {
        let text = serde_json::json!({"floor": "eg", "show": codes, "scale": scale, "global": true}).to_string();
        let a = PlanArgs::parse(scale, &text).unwrap();
        plan_domains(p, &a).unwrap().columns
    }

    fn rail(kind: &str, extra: serde_json::Value) -> serde_json::Value {
        let mut r = serde_json::json!({"id": "g1", "type": "railing", "floorId": "eg", "categoryCode": "41", "points": [{"x": 0, "y": 0}, {"x": 4, "y": 0}], "height": 1.0, "kind": kind});
        if let (Some(o), Some(e)) = (r.as_object_mut(), extra.as_object()) {
            o.extend(e.clone());
        }
        r
    }

    fn lines(prims: &[Primitive], cls: &str) -> Vec<(Vec2, Vec2)> {
        prims.iter().filter_map(|q| match q {
            Primitive::Line { a, b, cls: c, .. } if c == cls => Some((*a, *b)),
            _ => None,
        }).collect()
    }

    #[test]
    fn staebe_eine_linie_und_pfosten() {
        let p = project(rail("bars", serde_json::json!({})));
        let prims = plan(&p, 50.0);
        let l = lines(&prims, "railing-bars");
        assert_eq!(l.len(), 1);
        assert!((l[0].0.x - 0.0).abs() < 1e-9 && (l[0].1.x - 4.0).abs() < 1e-9 && l[0].0.y == 0.0);
        // Pick-Fläche mit der Id.
        assert!(prims.iter().any(|q| matches!(q, Primitive::Polygon { context_object_id: Some(id), .. } if id == "@railing:g1")));
        // Pfosten: 5 (4 Felder à 1 m), gefüllt.
        let posts = prims.iter().filter(|q| matches!(q, Primitive::Polygon { fill, stroke_width_mm, context_object_id: None, .. } if fill != "none" && *stroke_width_mm == 0.0)).count();
        assert_eq!(posts, 5);
        // Ab 1:500 keine Pfosten mehr.
        let big = plan(&p, 500.0);
        assert_eq!(big.iter().filter(|q| matches!(q, Primitive::Polygon { fill, context_object_id: None, .. } if fill != "none")).count(), 0);
    }

    #[test]
    fn glas_doppellinie_mit_mindestabstand() {
        let p = project(rail("glass", serde_json::json!({"thickness": 0.02})));
        let prims = plan(&p, 100.0);
        let l = lines(&prims, "railing-glass");
        // Zwei Längslinien und zwei Stirnlinien.
        assert_eq!(l.len(), 4);
        let long: Vec<_> = l.iter().filter(|(a, b)| (a.x - b.x).abs() > 1.0).collect();
        assert_eq!(long.len(), 2);
        // Abstand = 2 × max(0.01, 0.35 mm × 100/1000 = 0.035) = 0.07.
        assert!(((long[0].0.y - long[1].0.y).abs() - 0.07).abs() < 1e-9, "{long:?}");
    }

    #[test]
    fn brustung_flaeche_und_ueber_schnitt_gestrichelt() {
        let p = project(rail("solid", serde_json::json!({"thickness": 0.15})));
        let prims = plan(&p, 50.0);
        // Geschnitten (Höhe 0 bis 1.0, Schnitt bei 1.0): gefüllte Fläche und ausgezogener Umriss.
        assert!(prims.iter().any(|q| matches!(q, Primitive::Polygon { fill, context_object_id: None, .. } if fill != "none")));
        let ls = lines(&prims, "railing-solid");
        assert_eq!(ls.len(), 4);
        assert!(prims.iter().filter_map(|q| match q { Primitive::Line { cls, dash, .. } if cls == "railing-solid" => Some(dash), _ => None }).all(|d| d.is_none()));
        // Fuss über der Schnitthöhe (Geschoss-Offset 1.2): ganz darüber, gestrichelt, ohne Füllung.
        let p = project(rail("solid", serde_json::json!({"thickness": 0.15, "baseOffset": 1.2})));
        let prims = plan(&p, 50.0);
        assert!(!prims.iter().any(|q| matches!(q, Primitive::Polygon { fill, context_object_id: None, .. } if fill != "none")));
        assert!(prims.iter().filter_map(|q| match q { Primitive::Line { cls, dash, .. } if cls == "railing-solid" => Some(dash), _ => None }).all(|d| d.as_ref().is_some_and(|d| d.is_some())));
    }

    #[test]
    fn klasse_aus_blendet_aus_und_unsinn_kein_absturz() {
        let p = project(rail("glass", serde_json::json!({})));
        assert!(plan_codes(&p, 50.0, &[]).iter().all(|q| !is_symbol_part(q)));
        for bad in [serde_json::json!({"points": [{"x": 1, "y": 1}]}), serde_json::json!({"height": 0}), serde_json::json!({"points": [{"x": 0, "y": 0}, {"x": 1e300, "y": 1e300}]})] {
            let p = project(rail("bars", bad));
            let _ = plan(&p, 50.0);
        }
    }
}
