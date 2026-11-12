//! Attika ([148]): umlaufende Brüstung am Rand eines Flachdachs. Aus dem Traufumriss der Dachgeometrie
//! (`roof::roof_geometry`) und den Dachfeldern `parapetHeight` / `parapetWidth` / `parapetComponentId`
//! entsteht ein Ringkörper (aussen bündig mit dem Dachrand, nach innen `parapetWidth` breit), den 3D
//! (`model3d::emit_roofs`), Schnitt (Schnittspur), Ansicht (Aussenflächen) und Grundriss (Innenkante) teilen.

use crate::model::Roof;
use crate::model::RoofShape;
use crate::roof::RoofGeometry;
use crate::roof_skeleton::{clean_ring, is_simple_ring, offset_ring, point_in_ring, rings_cross, signed_area, Offset, P2, P3};
use crate::solid_bool::Mesh;

/// Standardbreite der Attika (Meter).
pub const DEFAULT_WIDTH: f64 = 0.2;

/// Ringkörper der Attika: Aussen- und Innenring (beide gegen den Uhrzeigersinn, Ecke i des Innenrings
/// gehört zu Ecke i des Aussenrings), Unterkante `z0` (Dachhaut), Oberkante `z1`.
#[derive(Clone, Debug, PartialEq)]
pub struct Parapet {
    pub outer: Vec<P2>,
    pub inner: Vec<P2>,
    pub z0: f64,
    pub z1: f64,
}

/// Attika des Dachs, falls eine gesetzt ist (Flachdach, Höhe > 0) und der Innenring gültig ausfällt.
/// `z0` ist die Höhe der ersten Dachfläche in `geo` (Dachhaut); ohne Fläche 0.
pub fn parapet(roof: &Roof, geo: &RoofGeometry) -> Option<Parapet> {
    let h = roof.parapet_height.filter(|h| h.is_finite() && *h > 1e-6)?;
    if roof.shape != RoofShape::Flach {
        return None;
    }
    let w = roof.parapet_width.filter(|w| w.is_finite()).unwrap_or(DEFAULT_WIDTH).max(0.02);
    let mut outer = clean_ring(&geo.eaves);
    if outer.len() < 3 || !is_simple_ring(&outer) {
        return None;
    }
    if signed_area(&outer) < 0.0 {
        outer.reverse();
    }
    // Kurze Kanten (Spitzen, Bogenansätze) würden beim Versatz umklappen: sie werden zu einem Punkt
    // zusammengezogen, bis der Innenring gültig ist (Abweichung höchstens die Kantenlänge).
    let (outer, inner) = loop {
        if let Some(inner) = inner_ring(&outer, w) {
            break (outer, inner);
        }
        let n = outer.len();
        let len = |i: usize| (outer[(i + 1) % n][0] - outer[i][0]).hypot(outer[(i + 1) % n][1] - outer[i][1]);
        // [191] Zuerst die Kanten, die beim Versatz umklappen (fein geteilte Bögen haben viele kurze, aber
        // gutartige Kanten); sonst die kürzeste.
        let cw: Vec<P2> = outer.iter().rev().copied().collect();
        let mut raw = offset_ring(&cw, Offset::Const(w));
        raw.reverse();
        let flips = |i: usize| {
            let j = (i + 1) % n;
            raw.len() == n && (raw[j][0] - raw[i][0]) * (outer[j][0] - outer[i][0]) + (raw[j][1] - raw[i][1]) * (outer[j][1] - outer[i][1]) < 0.0
        };
        let k = (0..n).filter(|&i| flips(i)).min_by(|&a, &b| len(a).total_cmp(&len(b))).or_else(|| (0..n).min_by(|&a, &b| len(a).total_cmp(&len(b))))?;
        if n <= 3 || len(k) >= 3.0 * w {
            return None;
        }
        let (a, b) = (outer[k], outer[(k + 1) % n]);
        outer[k] = [(a[0] + b[0]) / 2.0, (a[1] + b[1]) / 2.0];
        outer.remove((k + 1) % n);
        outer = clean_ring(&outer);
        if outer.len() < 3 {
            return None;
        }
    };
    let z0 = geo.planes.first().and_then(|p| p.first()).map_or(0.0, |q| q[2]);
    Some(Parapet { outer, inner, z0, z1: z0 + h })
}

/// Um `w` nach innen versetzter Ring (gegen den Uhrzeigersinn, Ecke i gehört zu Ecke i von `outer`);
/// `None`, wenn das Ergebnis kein einfacher Ring innerhalb von `outer` ist.
fn inner_ring(outer: &[P2], w: f64) -> Option<Vec<P2>> {
    // Nach innen versetzen = nach aussen am umgekehrten (Uhrzeigersinn-)Ring; danach wieder umkehren.
    let cw: Vec<P2> = outer.iter().rev().copied().collect();
    let mut inner = offset_ring(&cw, Offset::Const(w));
    inner.reverse();
    let ok = inner.len() == outer.len()
        && inner.iter().all(|q| q[0].is_finite() && q[1].is_finite() && point_in_ring(*q, outer))
        && is_simple_ring(&inner)
        && signed_area(&inner) > 1e-6
        && !rings_cross(outer, &inner);
    ok.then_some(inner)
}

/// Geschlossenes Dreiecksnetz des Ringkörpers (Normalen nach aussen).
pub fn mesh(pp: &Parapet) -> Mesh {
    let n = pp.outer.len();
    let mut positions = Vec::with_capacity(4 * n * 3);
    for (ring, z) in [(&pp.outer, pp.z0), (&pp.outer, pp.z1), (&pp.inner, pp.z0), (&pp.inner, pp.z1)] {
        for q in ring.iter() {
            positions.extend([q[0], q[1], z]);
        }
    }
    let (ob, ot, ib, it) = (0u32, n as u32, 2 * n as u32, 3 * n as u32);
    let mut indices = Vec::with_capacity(n * 24);
    for i in 0..n as u32 {
        let j = (i + 1) % n as u32;
        // Aussenwand, Oberseite, Unterseite, Innenwand.
        indices.extend([ob + i, ob + j, ot + j, ob + i, ot + j, ot + i]);
        indices.extend([ot + i, ot + j, it + j, ot + i, it + j, it + i]);
        indices.extend([ob + i, ib + j, ob + j, ob + i, ib + i, ib + j]);
        indices.extend([ib + i, it + j, ib + j, ib + i, it + i, it + j]);
    }
    Mesh { positions, indices }
}

/// Sichtflächen für die Ansicht (Modellkoordinaten): Aussenwand je Kante und Oberseite je Kante.
pub fn view_faces(pp: &Parapet) -> Vec<Vec<P3>> {
    let n = pp.outer.len();
    let mut out = Vec::with_capacity(2 * n);
    for i in 0..n {
        let j = (i + 1) % n;
        let (a, b, c, d) = (pp.outer[i], pp.outer[j], pp.inner[j], pp.inner[i]);
        out.push(vec![[a[0], a[1], pp.z0], [b[0], b[1], pp.z0], [b[0], b[1], pp.z1], [a[0], a[1], pp.z1]]);
        out.push(vec![[a[0], a[1], pp.z1], [b[0], b[1], pp.z1], [c[0], c[1], pp.z1], [d[0], d[1], pp.z1]]);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Project;

    fn project(extra: &str) -> Project {
        let roof: serde_json::Value = serde_json::from_str(&format!(
            r#"{{"id":"r1","type":"roof","floorId":"eg","categoryCode":"31","outline":[{{"x":0,"y":0}},{{"x":6,"y":0}},{{"x":6,"y":4}},{{"x":0,"y":4}}],
               "shape":"flach","pitchDeg":0,"overhang":0,"ridgeAxis":"x","thickness":0.3,"baseElevation":3 {extra}}}"#
        ))
        .unwrap();
        serde_json::from_value(serde_json::json!({
            "id": "p", "name": "t", "lineStyles": [], "hatches": [], "components": [], "wallTypes": [],
            "drawingLevels": [], "layers": [], "walls": [], "drawings2d": [], "roofs": [roof]
        }))
        .unwrap()
    }

    fn of(p: &Project) -> Option<Parapet> {
        let r = &p.roofs.as_ref().unwrap()[0];
        parapet(r, &crate::roof::roof_geometry(&r.params(), 3.0))
    }

    #[test]
    fn kurze_kante_am_bogenansatz_klappt_nicht_um() {
        // Wie der Erker im Musterhaus: Bogen mit kurzem Ansatzstück (0.137 m) neben der geraden Kante.
        let mut p = project(r#","parapetHeight":0.5,"parapetWidth":0.2"#);
        let r = &mut p.roofs.as_mut().unwrap()[0];
        r.outline = [[0.0, 0.0], [0.016, -0.136], [0.5, -0.04], [1.5, 0.2], [2.0, 1.0], [1.5, 1.8], [0.5, 2.04], [0.016, 2.136], [0.0, 2.0]]
            .iter()
            .map(|q| crate::model::Vec2 { x: q[0], y: q[1] })
            .collect();
        let pp = of(&p).expect("Attika trotz kurzer Kante");
        assert!(pp.inner.len() >= 6 && signed_area(&pp.inner) > 0.5);
    }

    /// [191] Erker-Dach mit echtem Bogen (r = 2.345, fein geteilt): der Innenring folgt dem Kreis r − 0.2, die
    /// Reparatur der kurzen Ansatzkante zerstört den Bogen nicht.
    #[test]
    fn bogen_umriss_innenring_bleibt_kreis() {
        let mut p = project(r#","parapetHeight":0.5,"parapetWidth":0.2"#);
        let r = &mut p.roofs.as_mut().unwrap()[0];
        let (c, rr, a) = ([15.0, 5.0], 2.345, std::f64::consts::FRAC_PI_2 - 0.09);
        r.outline = [[15.195, 2.8], [c[0] + rr * a.cos(), c[1] - rr * a.sin()], [c[0] + rr * a.cos(), c[1] + rr * a.sin()], [15.195, 7.2]]
            .iter()
            .map(|q| crate::model::Vec2 { x: q[0], y: q[1] })
            .collect();
        r.outline_bulge = Some(vec![0.0, -((std::f64::consts::PI - 0.18) / 4.0).tan(), 0.0, 0.0]);
        let pp = of(&p).expect("Attika");
        let on_arc: Vec<&P2> = pp.inner.iter().filter(|q| q[0] > 15.6).collect();
        assert!(on_arc.len() > 30, "{}", on_arc.len());
        for q in on_arc {
            assert!(((q[0] - c[0]).hypot(q[1] - c[1]) - (rr - 0.2)).abs() < 1e-3, "{q:?}");
        }
    }

    #[test]
    fn ohne_hoehe_keine_attika() {
        assert!(of(&project("")).is_none());
        assert!(of(&project(r#","parapetHeight":0"#)).is_none());
    }

    #[test]
    fn rechteck_ring() {
        let pp = of(&project(r#","parapetHeight":0.5,"parapetWidth":0.25"#)).unwrap();
        assert_eq!((pp.z0, pp.z1), (3.0, 3.5));
        let b = |r: &[P2]| r.iter().fold([f64::MAX, f64::MAX, f64::MIN, f64::MIN], |m, q| [m[0].min(q[0]), m[1].min(q[1]), m[2].max(q[0]), m[3].max(q[1])]);
        assert_eq!(b(&pp.outer), [0.0, 0.0, 6.0, 4.0]);
        let i = b(&pp.inner);
        assert!((i[0] - 0.25).abs() < 1e-9 && (i[1] - 0.25).abs() < 1e-9 && (i[2] - 5.75).abs() < 1e-9 && (i[3] - 3.75).abs() < 1e-9, "{i:?}");
        assert!(signed_area(&pp.outer) > 0.0 && signed_area(&pp.inner) > 0.0);
    }

    #[test]
    fn pultdach_hat_keine_attika() {
        let p = project(r#","parapetHeight":0.5"#);
        let mut r = p.roofs.as_ref().unwrap()[0].clone();
        r.shape = RoofShape::Pult;
        assert!(parapet(&r, &crate::roof::roof_geometry(&r.params(), 3.0)).is_none());
    }

    #[test]
    fn zu_breit_gibt_keine_attika() {
        assert!(of(&project(r#","parapetHeight":0.5,"parapetWidth":3"#)).is_none());
    }

    #[test]
    fn netz_ist_geschlossen_mit_richtigem_volumen() {
        let pp = of(&project(r#","parapetHeight":0.5,"parapetWidth":0.25"#)).unwrap();
        let m = mesh(&pp);
        // Volumen über Tetraeder zum Ursprung: (6*4 - 5.5*3.5) * 0.5.
        let v: f64 = m
            .indices
            .chunks(3)
            .map(|t| {
                let q = |i: u32| [m.positions[3 * i as usize], m.positions[3 * i as usize + 1], m.positions[3 * i as usize + 2]];
                let (a, b, c) = (q(t[0]), q(t[1]), q(t[2]));
                (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6.0
            })
            .sum();
        assert!((v - (24.0 - 5.5 * 3.5) * 0.5).abs() < 1e-9, "{v}");
    }

    #[test]
    fn schnitt_durch_die_attika() {
        let pp = of(&project(r#","parapetHeight":0.5,"parapetWidth":0.25"#)).unwrap();
        // Schnitt längs x bei y = 2: zwei Streifen (links, rechts).
        let rings = crate::roof_assembly::section_rings(&mesh(&pp), (0.0, 2.0), (1.0, 0.0));
        assert_eq!(rings.len(), 2, "{rings:?}");
    }

    #[test]
    fn emit_roofs_und_schnitt_enthalten_die_attika() {
        use crate::plan::section::{compute_section, Kind, LevelSpec};
        let mut v = serde_json::to_value(project(r#","parapetHeight":0.5,"parapetWidth":0.25"#)).unwrap();
        v["drawingLevels"] = serde_json::json!([
            {"id": "eg", "name": "EG", "kind": "floor", "visible": true, "locked": false, "floorHeight": 3.0, "baseElevation": 0},
            {"id": "s", "name": "S", "kind": "section", "visible": true, "locked": false, "linePoints": [{"x": -2, "y": 2}, {"x": 8, "y": 2}], "directionSign": 1}
        ]);
        let p: Project = serde_json::from_value(v).unwrap();
        let mut q = p.clone();
        q.roofs.as_mut().unwrap()[0].parapet_height = None;
        assert_eq!(crate::model3d::emit_roofs(&p, None).unwrap().len(), crate::model3d::emit_roofs(&q, None).unwrap().len() + 1);
        let sect = |p: &Project| {
            let l = p.drawing_levels.iter().find(|l| l.id == "s").unwrap();
            compute_section(p, &LevelSpec::from_json(&serde_json::to_value(l).unwrap()), &[]).unwrap().unwrap()
        };
        let n = |p: &Project| sect(p).cuts.iter().filter(|c| c.kind == Kind::Roof).count();
        // Zwei Streifen links und rechts zusätzlich zur Dachscheibe.
        assert_eq!(n(&p), n(&q) + 2);
    }
}
