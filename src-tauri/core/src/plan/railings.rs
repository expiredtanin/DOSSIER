//! [279] Geländer im Grundriss (`Project.railings`). Geometrie aus `crate::railing`, die Zonen zur Schnitthöhe wie bei
//! den Stützen (`view_range`): geschnitten oder darunter ausgezogen, darüber gestrichelt (Strich-Punkt, SIA 400),
//! darunter sichtbar gepunktet.
//!
//! Zeichen je Art (Strichstärke der Klasse, Farbe der Klasse bzw. des Geländers):
//! - **Stäbe:** eine Linie in der Achse (Handlauf über den Stäben). [291] Pfosten (aller Arten, sofern gesetzt) als kleine
//!   gefüllte Quadrate ihres Querschnitts (bis 1:200).
//! - **Glas:** Doppellinie im Abstand der Glasdicke (mindestens 0.7 mm Papier, damit die Linien nicht ineinanderlaufen),
//!   an offenen Enden geschlossen.
//! - **Lochblech:** wie Glas, dazu eine gestrichelte Mittellinie.
//! - **Brüstung (massiv):** geschnittene Fläche mit Bauteil-Schraffur (Poché wie die Stützen), Umriss ohne Gehrungsfugen.
//!
//! - **Handlauf über der Schnitthöhe** (Fuss geschnitten, Handlauf darüber): zwei gestrichelte Linien im Abstand der
//!   Handlaufbreite neben der Achse (`railing-handrail`, wie die Treppen-Handläufe über dem Schnitt).
//!
//! - **[291] An einer Treppe** (Fuss steigt): die Achse ist an der Schnitthöhe geteilt, der Teil darüber gestrichelt
//!   (Strich-Punkt) wie Stufen und Handläufe der Treppe darüber.
//!
//! Pick: unsichtbare Fläche um die Achse (mindestens 4 mm Papier breit) mit `contextObjectId = "@railing:<id>"`.

use super::domains::Ctx;
use super::prim::{HatchRender, Primitive};
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

/// [279] Lochmuster der Lochblechtafel in Ansicht und 3D-Dokument: Punktschraffur (`HatchPattern::Dots`, die bestehende
/// Schraffur-Bibliothek, Teilung 5 cm), Punkte in der Tintenfarbe `color`.
pub fn perforation_hatch(color: &str) -> HatchRender {
    HatchRender { pattern: HatchPattern::Dots, scale: 1.0, color: color.to_string(), line_weight: 0.18, ..no_hatch() }
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

/// [291] Achse geteilt an der Schnitthöhe (gebunden an eine Treppe steigt der Fuss): Teilzüge mit Bogenlänge (Anfang,
/// Ende) und Fusshöhe (tiefste, höchste); waagrecht ein Teil.
fn split_at_cut(path: &railing::Path, cut: f64) -> Vec<(Vec<[f64; 2]>, f64, f64, f64, f64)> {
    let ax = &path.pts;
    let total = railing::length(ax);
    if !path.sloped() {
        let z = path.foot[0];
        return vec![(ax.clone(), 0.0, total, z, z)];
    }
    let mut out: Vec<(Vec<[f64; 2]>, f64, f64, f64, f64)> = Vec::new();
    let above = |z: f64| z > cut + 1e-9;
    let mut cur: Vec<[f64; 2]> = vec![ax[0]];
    let (mut s0, mut acc, mut lo, mut hi) = (0.0, 0.0, path.foot[0], path.foot[0]);
    let mut state = above(path.foot[0]);
    for i in 0..ax.len() - 1 {
        let (a, b, za, zb) = (ax[i], ax[i + 1], path.foot[i], path.foot[i + 1]);
        let len = crate::jsmath::hypot2(b[0] - a[0], b[1] - a[1]);
        if above(zb) != state && (zb - za).abs() > 1e-12 {
            let t = ((cut - za) / (zb - za)).clamp(0.0, 1.0);
            let m = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
            cur.push(m);
            // Der Teil über der Schnitthöhe beginnt knapp darüber (sonst gälte er als geschnitten).
            let edge = |up: bool| if up { cut + 1e-6 } else { cut };
            out.push((std::mem::replace(&mut cur, vec![m]), s0, acc + t * len, lo.min(edge(state)), hi.max(edge(state))));
            s0 = acc + t * len;
            state = !state;
            lo = edge(state);
            hi = edge(state);
        }
        cur.push(b);
        lo = lo.min(zb);
        hi = hi.max(zb);
        acc += len;
    }
    out.push((cur, s0, acc, lo, hi));
    out.retain(|q| q.0.len() >= 2 && q.2 - q.1 > 1e-9);
    out
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
        let Some(path) = railing::path(p, r) else { continue };
        let Some(s) = railing::spec(p, r) else { continue };
        let ax = &path.pts;
        if range.classify(s.z0, s.top()) == Zone::Hidden {
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

        // Pick: unsichtbare Fläche, mindestens 4 mm Papier breit.
        let pick_half = (s.thickness.max(s.rail_w()) / 2.0).max(2.0 * mm);
        for q in railing::strips(ax, pick_half).0 {
            out.push(super::trees::poly(q.iter().map(|&q| v(q)).collect(), "none", "none", 0.0, Some(pick_id(&r.id)), greyed));
        }
        // [291] Pfosten (aller Arten, sofern gesetzt) längs der ganzen Achse.
        let posts = if s.posts && c.a.scale <= 200.0 { railing::post_stations(&path, &s) } else { Vec::new() };
        let parts = split_at_cut(&path, range.cut);
        let whole = parts.len() == 1;
        for (sub, s_a, s_b, lo, hi) in parts {
            let zone = range.classify(lo, hi + s.top_rel());
            if zone == Zone::Hidden {
                continue;
            }
            let from_part = out.len();
            let closed = whole && crate::stair_rail::is_closed(&sub);
            draw_axis(c, r, &s, &sub, closed, zone, (lw, color, &stroke, greyed, category, mm), out);
            let h = s.post_size / 2.0;
            for st in posts.iter().filter(|st| st.s >= s_a - 1e-9 && st.s <= s_b + 1e-9) {
                let (pt, d) = (st.at, st.dir);
                let n = [-d[1], d[0]];
                let q = |a: f64, b: f64| v([pt[0] + d[0] * a + n[0] * b, pt[1] + d[1] * a + n[1] * b]);
                out.push(super::trees::poly(vec![q(-h, -h), q(h, -h), q(h, h), q(-h, h)], &stroke, &stroke, 0.0, None, greyed));
            }
            // Handlauf ganz über der Schnitthöhe (Fuss geschnitten): gestrichelt neben der Achse, Konvention wie bei den
            // Treppen (Handlauf über dem Schnitt gestrichelt, Strichmuster „verdeckt“, dünne Linie).
            if zone == Zone::Cut && s.has_rail() && range.classify(lo + s.rail_top() - s.rail_h(), lo + s.rail_top()) == Zone::Above {
                let (_, l, rt) = railing::strips(&sub, s.rail_w() / 2.0);
                for side in [&l, &rt] {
                    polyline(out, side, "railing-handrail", lw * 0.6, &stroke, Some(&super::line_pattern::HIDDEN), greyed);
                }
            }
            // Ganz über der Schnitthöhe: Strich-Punkt wie die übrigen Bauteile darüber (auch ohne eigenen Ansichtsbereich, wie
            // die Stufen und Handläufe der Treppen); unter der Schnitthöhe gepunktet nur mit eigenem Bereich.
            let dash = if zone == Zone::Above { Some(&super::view_range::ABOVE_DASH[..]) } else { range.restyle_dash(zone) };
            if let Some(d) = dash {
                super::view_range::restyle(out, from_part, d);
            }
        }
        // [271] Umbaufilter: das Geländer in der Farbe seines Status (Bestand grau, Abbruch gelb gestrichelt, Neu rot).
        if let Some(st) = c.renovation().and_then(|rn| rn.styled.get(&r.id)) {
            crate::renovation::restyle_linework(out, from, st, true);
        }
    }
}

/// Strichstärke, Farbe (Übersteuerung), Strichfarbe, ausgegraut, Klasse, Meter je mm Papier.
type Pen<'a> = (f64, Option<&'a str>, &'a str, Option<bool>, Option<&'a crate::model::LayerCategory>, f64);

/// Zeichen eines (Teil-)Zugs je Art (s. Modulkopf).
fn draw_axis(c: &Ctx, r: &Railing, s: &railing::Spec, ax: &[[f64; 2]], closed: bool, zone: Zone, pen: Pen, out: &mut Vec<Primitive>) {
    let p = c.p;
    let (lw, color, stroke, greyed, category, mm) = pen;
    match s.kind {
        RailingKind::Solid => {
            let (quads, l, rt) = railing::strips(ax, s.thickness / 2.0);
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
            polyline(out, &l, "railing-solid", lw, stroke, None, greyed);
            polyline(out, &rt, "railing-solid", lw, stroke, None, greyed);
            if !closed {
                out.push(seg(l[0], rt[0], "railing-solid", lw, stroke, None, greyed));
                out.push(seg(l[l.len() - 1], rt[rt.len() - 1], "railing-solid", lw, stroke, None, greyed));
            }
        }
        RailingKind::Glass | RailingKind::Perforated => {
            // Mindestabstand der Doppellinie: 0.7 mm Papier.
            let half = (s.thickness / 2.0).max(0.35 * mm);
            let (_, l, rt) = railing::strips(ax, half);
            polyline(out, &l, "railing-glass", lw, stroke, None, greyed);
            polyline(out, &rt, "railing-glass", lw, stroke, None, greyed);
            if !closed {
                out.push(seg(l[0], rt[0], "railing-glass", lw, stroke, None, greyed));
                out.push(seg(l[l.len() - 1], rt[rt.len() - 1], "railing-glass", lw, stroke, None, greyed));
            }
            if s.kind == RailingKind::Perforated {
                polyline(out, ax, "railing-perforated", lw * 0.6, stroke, Some(&super::line_pattern::HIDDEN), greyed);
            }
        }
        _ => polyline(out, ax, "railing-bars", lw, stroke, None, greyed),
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
    fn handlauf_ueber_schnitthoehe_gestrichelt_neben_der_achse() {
        // Höhe 1.2 über Schnitt 1.0: Fuss geschnitten, Handlauf (1.16–1.20) darüber -> zwei gestrichelte Linien im Abstand der Handlaufbreite.
        let p = project(rail("glass", serde_json::json!({"height": 1.2, "handrail": true, "handrailSize": 0.06})));
        let l = lines(&plan(&p, 50.0), "railing-handrail");
        assert_eq!(l.len(), 2, "{l:?}");
        assert!(l.iter().all(|(a, b)| (a.x - b.x).abs() > 3.9 && (a.y - b.y).abs() < 1e-9));
        assert!(((l[0].0.y - l[1].0.y).abs() - 0.06).abs() < 1e-9);
        let dashed = |prims: &[Primitive]| prims.iter().filter_map(|q| match q { Primitive::Line { cls, dash, .. } if cls == "railing-handrail" => Some(dash.clone()), _ => None }).all(|d| matches!(d, Some(Some(_))));
        assert!(dashed(&plan(&p, 50.0)));
        // Handlauf unter der Schnitthöhe (Höhe 1.0 = Schnitt): ausgezogen wie bisher, keine eigene Linie.
        let p = project(rail("glass", serde_json::json!({"height": 1.0, "handrail": true})));
        assert!(lines(&plan(&p, 50.0), "railing-handrail").is_empty());
        // Ohne Handlauf (Brüstung, keine Angabe) und ganz über dem Schnitt (schon gestrichelt): keine zusätzlichen Linien.
        let p = project(rail("solid", serde_json::json!({"height": 1.2})));
        assert!(lines(&plan(&p, 50.0), "railing-handrail").is_empty());
        let p = project(rail("glass", serde_json::json!({"height": 1.2, "baseOffset": 1.2})));
        assert!(lines(&plan(&p, 50.0), "railing-handrail").is_empty());
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
