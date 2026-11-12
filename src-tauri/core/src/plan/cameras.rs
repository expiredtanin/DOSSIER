//! [213] Kameras im Grundriss: Kamerakörper (Gehäuse mit Objektiv) am Standpunkt, Sichtkegel mit dem
//! horizontalen Öffnungswinkel (Perspektive) bzw. parallele Sichtgrenzen (Axonometrie/Parallel), Ziel als
//! Kreuz mit gestrichelter Blicklinie, Name als Beschriftung. Grösse in fester Papiergrösse (unabhängig vom
//! Massstab). Alles liegt auf der Klasse der Kamera (Vorgabe „92", `standards::CAMERA_CATEGORY`); fehlt die
//! Klasse im Projekt, bleibt das Symbol sichtbar (wie die übrige abgeleitete Darstellung, [180]).
//! Pick: unsichtbare Fläche (Körper + Kegel) mit `contextObjectId = "@camera:<id>"`.

use super::domains::Ctx;
use super::prim::Primitive;
use super::style::MONO_INK;
use super::trees::{line, poly};
use crate::camera::{CameraGeom, CAMERA_PICK_PREFIX};
use crate::jsnum;
use crate::model::*;

const BODY_MM: f64 = 0.25;
const CONE_MM: f64 = 0.18;
const AIM_MM: f64 = 0.13;
const AIM_DASH: [f64; 2] = [1.5, 1.0];
/// Gehäuse: Länge entlang der Blickrichtung und Breite (Papier-mm), Objektiv davor.
const BODY_LEN: f64 = 4.0;
const BODY_WID: f64 = 3.2;
const LENS_LEN: f64 = 1.6;
const LENS_WID: f64 = 2.0;
/// Zielkreuz (Halbarm, Papier-mm).
const CROSS: f64 = 1.6;
/// Grösster Winkel zur Achse für den Kegel (Grad), damit sehr grosse Bildwinkel keine endlosen Kanten geben.
/// Halbe Breite der Pick-Bänder entlang der Linien (Papier-mm).
const PICK_BAND: f64 = 1.2;
const MAX_HALF_DEG: f64 = 75.0;

fn v(x: f64, y: f64) -> Vec2 {
    Vec2 { x, y }
}

/// Pick-Id einer Kamera (Feld `contextObjectId`).
pub fn pick_id(id: &str) -> String {
    format!("{CAMERA_PICK_PREFIX}{id}")
}

/// Halber horizontaler Öffnungswinkel (Radiant) aus dem vertikalen Bildwinkel und dem Bildverhältnis.
pub fn half_h_angle(fov_deg: f64) -> f64 {
    let h = jsnum::atan(jsnum::tan(fov_deg.to_radians() / 2.0) * crate::camera::ASPECT);
    h.min(MAX_HALF_DEG.to_radians())
}

/// Ecken des Sichtkegels (Standpunkt, linke Ecke, rechte Ecke) bzw. des Streifens bei Parallelprojektion.
pub fn view_area(g: &CameraGeom, mm: f64) -> Vec<Vec2> {
    let (px, py) = (g.eye[0], g.eye[1]);
    // Mindestlänge: damit auch ein Ziel unmittelbar am Standpunkt ein sichtbares Symbol gibt.
    let len = g.plan_dist.max(8.0 * mm);
    let (u, n) = ((jsnum::cos(g.yaw), jsnum::sin(g.yaw)), (-jsnum::sin(g.yaw), jsnum::cos(g.yaw)));
    if g.perspective {
        let h = half_h_angle(g.fov_deg);
        let edge = len / jsnum::cos(h);
        let at = |s: f64| v(px + edge * jsnum::cos(g.yaw + s * h), py + edge * jsnum::sin(g.yaw + s * h));
        vec![v(px, py), at(-1.0), at(1.0)]
    } else {
        // Breite = Sichthöhe × Bildverhältnis.
        let w = g.ortho_height * crate::camera::ASPECT / 2.0;
        let q = |a: f64, b: f64| v(px + u.0 * a + n.0 * b, py + u.1 * a + n.1 * b);
        vec![q(0.0, -w), q(len, -w), q(len, w), q(0.0, w)]
    }
}

/// Planzeichen einer Kamera: Pick-Fläche, Sichtgrenzen, Gehäuse mit Objektiv, Blicklinie und Zielkreuz.
pub fn camera_symbol(cam: &Camera, g: &CameraGeom, scale: f64, cat: Option<&LayerCategory>, greyed: Option<bool>) -> Vec<Primitive> {
    let mm = scale / 1000.0;
    let color = cat.map(|k| k.color.as_str()).filter(|c| !c.is_empty()).unwrap_or(MONO_INK).to_string();
    let (px, py) = (g.eye[0], g.eye[1]);
    let (cs, sn) = (jsnum::cos(g.yaw), jsnum::sin(g.yaw));
    let at = |a: f64, b: f64| v(px + (cs * a - sn * b) * mm, py + (sn * a + cs * b) * mm);
    // Gehäuse hinter dem Standpunkt, Objektiv davor: der Standpunkt liegt an der Vorderkante des Objektivs.
    let (bw, lw) = (BODY_WID / 2.0, LENS_WID / 2.0);
    let body = vec![at(-BODY_LEN - LENS_LEN, -bw), at(-LENS_LEN, -bw), at(-LENS_LEN, bw), at(-BODY_LEN - LENS_LEN, bw)];
    let lens = vec![at(-LENS_LEN, -lw), at(0.0, -lw * 1.5), at(0.0, lw * 1.5), at(-LENS_LEN, lw)];
    let area = view_area(g, mm);
    // Pick-Flächen (unsichtbar): Gehäuse mit Objektiv, Zielkreuz und schmale Bänder entlang der Sichtgrenzen und der
    // Blicklinie — nicht der ganze Kegel, sonst finge er jeden Klick auf Räume und Wände darin ab.
    let id = pick_id(&cam.id);
    let mut out = Vec::new();
    let mut pick = |pts: Vec<Vec2>| out.push(poly(pts, "none", "none", 0.0, Some(id.clone()), greyed));
    pick(vec![at(-BODY_LEN - LENS_LEN, -bw), at(0.0, -lw * 1.5), at(0.0, lw * 1.5), at(-BODY_LEN - LENS_LEN, bw)]);
    let band = |a: Vec2, b: Vec2| -> Option<Vec<Vec2>> {
        let (dx, dy) = (b.x - a.x, b.y - a.y);
        let l = dx.hypot(dy);
        if !(l > 1e-9) {
            return None;
        }
        let (nx, ny) = (-dy / l * PICK_BAND * mm, dx / l * PICK_BAND * mm);
        Some(vec![v(a.x + nx, a.y + ny), v(b.x + nx, b.y + ny), v(b.x - nx, b.y - ny), v(a.x - nx, a.y - ny)])
    };
    let m = area.len();
    for k in 0..m {
        // Perspektive: Kanten 0–1, 0–2 und 1–2; Streifen: Umriss.
        let (a, b) = if g.perspective { [(0, 1), (0, 2), (1, 2)][k.min(2)] } else { (k, (k + 1) % m) };
        if g.perspective && k > 2 {
            break;
        }
        if let Some(b) = band(area[a], area[b]) {
            pick(b);
        }
    }
    if g.plan_dist > 1e-6 {
        if let Some(b) = band(v(px, py), v(g.target[0], g.target[1])) {
            pick(b);
        }
    }
    let kk = CROSS * mm;
    pick(vec![v(g.target[0] - kk, g.target[1] - kk), v(g.target[0] + kk, g.target[1] - kk), v(g.target[0] + kk, g.target[1] + kk), v(g.target[0] - kk, g.target[1] + kk)]);
    // Sichtgrenzen: Kegel (zwei Kanten und die ferne Linie) bzw. Streifen (Umriss).
    if g.perspective {
        out.push(line(area[0], area[1], "camera-cone", CONE_MM, &color, None, greyed));
        out.push(line(area[0], area[2], "camera-cone", CONE_MM, &color, None, greyed));
        out.push(line(area[1], area[2], "camera-cone", CONE_MM, &color, Some(&AIM_DASH), greyed));
    } else {
        for k in 0..m {
            let dash = (k == 0).then_some(&AIM_DASH[..]);
            out.push(line(area[k], area[(k + 1) % m], "camera-cone", CONE_MM, &color, dash, greyed));
        }
    }
    out.push(poly(body, "#ffffff", &color, BODY_MM, None, greyed));
    out.push(poly(lens, &color, &color, BODY_MM, None, greyed));
    // Blicklinie zum Ziel und Zielkreuz.
    let (tx, ty) = (g.target[0], g.target[1]);
    if g.plan_dist > 1e-6 {
        out.push(line(v(px, py), v(tx, ty), "camera-aim", AIM_MM, &color, Some(&AIM_DASH), greyed));
    }
    let k = CROSS * mm;
    out.push(line(v(tx - k, ty), v(tx + k, ty), "camera-aim", CONE_MM, &color, None, greyed));
    out.push(line(v(tx, ty - k), v(tx, ty + k), "camera-aim", CONE_MM, &color, None, greyed));
    // Name hinter dem Gehäuse (Schrift bleibt waagrecht, der Block rückt so weit ab, dass er das Gehäuse nicht berührt).
    let name = cam.name.trim();
    if !name.is_empty() && scale.is_finite() && scale > 0.0 {
        let doc = super::domains::doc_from_text(name);
        let pt = super::trees::label_pt(scale);
        let (w, h) = crate::text_layout::stamp_block_size(&doc, &[], pt, crate::text_layout::PT_TO_MM * mm);
        let back = (BODY_LEN + LENS_LEN + 1.0) * mm;
        let reach = cs.abs() * w / 2.0 + sn.abs() * h / 2.0 + 0.5 * mm;
        let c = v(px - cs * (back + reach), py - sn * (back + reach));
        out.push(Primitive::Text { at: c, doc, extra_lines: vec![], base_pt: pt, color: color.clone(), room_id: None, greyed, opacity: None });
    }
    out
}

/// Kamera-Symbole des Grundrisses (Kameras dieses Geschosses mit sichtbarer Klasse).
pub(super) fn plan_cameras(c: &Ctx, out: &mut Vec<Primitive>) {
    let Some(cams) = c.p.cameras.as_deref() else { return };
    let scale = if c.a.scale.is_finite() && c.a.scale > 0.0 { c.a.scale } else { 100.0 };
    for cam in cams {
        if cam.floor_id != c.a.floor || !c.derived_shown(&cam.category_code) || c.rule_hidden(&cam.id) {
            continue;
        }
        let Some(g) = CameraGeom::of(c.p, cam) else { continue };
        let greyed = Some(c.greyed(&cam.category_code));
        out.extend(camera_symbol(cam, &g, scale, c.cat(&cam.category_code), greyed));
    }
}

/// Ist `q` ein Planzeichen einer Kamera?
pub(super) fn is_symbol_part(q: &Primitive) -> bool {
    match q {
        Primitive::Line { cls, .. } => cls == "camera-cone" || cls == "camera-aim",
        Primitive::Polygon { context_object_id: Some(id), .. } => id.starts_with(CAMERA_PICK_PREFIX),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plan::domains::{plan_domains_buf, PlanArgs};
    use serde_json::{json, Value};

    fn project(extra: Value) -> Project {
        let mut v: Value = serde_json::from_str(include_str!("../../tests/fixtures/sample_project.json")).unwrap();
        v["layers"].as_array_mut().unwrap().push(json!({"code": "92", "name": "Kameras", "color": "#123456", "lw": 0.18, "visible": true, "locked": false}));
        v["cameras"] = json!([{"id": "k1", "type": "camera", "name": "Süd", "floorId": "eg", "categoryCode": "92", "position": {"x": 2, "y": -3},
            "eyeHeight": 1.6, "target": {"x": 2, "y": 3}, "targetHeight": 1.6, "fovDeg": 50, "projection": "perspective"}]);
        if let Some(o) = extra.as_object() {
            for (k, val) in o {
                v["cameras"][0][k] = val.clone();
            }
        }
        serde_json::from_value(v).unwrap()
    }

    fn plan(p: &Project, floor: &str, show: &[String]) -> Vec<Primitive> {
        let a = PlanArgs::parse(1.0, &json!({"floor": floor, "show": show, "global": true, "scale": 100}).to_string()).unwrap();
        let buf = plan_domains_buf(p, &a).unwrap();
        crate::plan::buf::View::parse(&buf).unwrap().prims().unwrap()
    }

    fn all_codes(p: &Project) -> Vec<String> {
        let mut c: Vec<String> = p.flat_categories().iter().map(|c| c.code.clone()).collect();
        c.extend(p.walls.iter().map(|w| w.category_code.clone()));
        c
    }

    fn camera_prims(prims: &[Primitive]) -> Vec<&Primitive> {
        prims.iter().filter(|q| is_symbol_part(q)).collect()
    }

    #[test]
    fn symbol_auf_der_klasse_der_kamera() {
        let p = project(json!({}));
        let all = all_codes(&p);
        let prims = plan(&p, "eg", &all);
        let mine = camera_prims(&prims);
        assert!(mine.iter().any(|q| matches!(q, Primitive::Polygon { context_object_id: Some(id), .. } if id == "@camera:k1")), "Pick-Fläche");
        assert!(mine.iter().any(|q| matches!(q, Primitive::Line { cls, .. } if cls == "camera-cone")), "Sichtkegel");
        assert!(prims.iter().any(|q| matches!(q, Primitive::Text { color, .. } if color == "#123456")), "Name in der Klassenfarbe");
        // Klasse aus: nichts mehr.
        let without: Vec<String> = all.iter().filter(|c| *c != "92").cloned().collect();
        let prims = plan(&p, "eg", &without);
        assert!(camera_prims(&prims).is_empty(), "Klasse 92 aus");
        assert!(!prims.iter().any(|q| matches!(q, Primitive::Text { color, .. } if color == "#123456")), "Name mit der Klasse aus");
        // Anderes Geschoss: nichts.
        if let Some(o) = p.drawing_levels.iter().find(|l| l.id != "eg" && l.kind == DrawingLevelKind::Floor) {
            assert!(camera_prims(&plan(&p, &o.id, &all)).is_empty(), "anderes Geschoss");
        }
    }

    #[test]
    fn kegel_oeffnet_sich_um_den_bildwinkel() {
        let p = project(json!({"fovDeg": 40}));
        let g = CameraGeom::of(&p, &p.cameras.as_ref().unwrap()[0]).unwrap();
        let a = view_area(&g, 0.1);
        // Blick nach +y: die Ecken liegen links/rechts davon, symmetrisch.
        assert!((a[1].x - 2.0 + (a[2].x - 2.0)).abs() < 1e-9);
        let half = ((a[2].x - 2.0) / (a[2].y + 3.0)).atan().abs();
        assert!((half - half_h_angle(40.0)).abs() < 1e-9);
        // Die ferne Kante geht durch das Ziel (Abstand 6 m).
        assert!((a[1].y - 3.0).abs() < 1e-9);
    }

    #[test]
    fn parallelprojektion_zeichnet_streifen() {
        let p = project(json!({"projection": "axonometric", "orthoHeight": 4}));
        let g = CameraGeom::of(&p, &p.cameras.as_ref().unwrap()[0]).unwrap();
        let a = view_area(&g, 0.1);
        assert_eq!(a.len(), 4);
        // Breite = 4 m × 16/9.
        assert!(((a[3].x - a[0].x).abs() - 4.0 * crate::camera::ASPECT).abs() < 1e-9);
    }
}
