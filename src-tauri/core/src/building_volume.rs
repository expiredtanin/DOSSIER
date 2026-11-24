//! Gebäudevolumen GV nach SIA 416 mit Dachraum ([266] Befund 1).
//!
//! # Abgrenzung (SIA 416, „Flächen und Volumen von Gebäuden")
//!
//! GV = Volumen des Gebäudes innerhalb seiner äusseren Begrenzungsflächen: unten die Unterseite der
//! untersten Bodenkonstruktion, seitlich die Aussenflächen der Aussenwände, oben die Oberfläche der
//! Dachkonstruktion (Oberkante Dach). Nicht dazu gehören Vordächer, Dachvorsprünge über die Fassade
//! hinaus, Balkone und andere nicht allseitig umschlossene Teile; Brüstungen/Attiken von Flachdächern
//! zählen nicht. Aussparungen (Innenhöfe, Lichthöfe) liegen ausserhalb der Begrenzungsflächen; kleinere
//! Durchbrüche (Treppenlöcher, Schächte) bleiben im Volumen.
//!
//! # Rechnung
//!
//! Bisher: GV je Geschoss = GF × Geschosshöhe (OK–OK). Der Raum unter einem Steildach über der obersten
//! Decke fehlte, ein Kniestock-Geschoss zählte dagegen bis zu seiner vollen Höhe, auch wo die Dachfläche
//! tiefer liegt. Hier kommt je Geschoss die Korrektur dazu (Körper-Booleans, exakt, [`crate::solid_bool`]):
//!
//!  • `F_l` = Grundriss des Geschosses l: Vereinigung der Wand- und Raumgrundrisse (ohne AGF), Löcher
//!    gefüllt (ein Wandring ohne Räume ist ein ganzes Geschoss); `Box_l` = `F_l` × [Kote, Kote + Höhe].
//!  • `A_r` = Umriss des Dachs r (ohne Überstand, seine Höfe abgezogen) ∩ `F` seines Geschosses (fehlen
//!    dort Wände/Räume: das nächste Geschoss darunter). So zählen Überstände und Dächer über offenen
//!    Flächen (Carport, Vordach) nicht.
//!  • `U_r` = Raum unter der Dach-Oberkante über `A_r`, ab der Kote des Dachgeschosses; Gauben erweitern
//!    ihn über ihrem Loch im Hauptdach bis unter die Oberkante des Gaubendachs (ohne Gauben-Überstand).
//!  • Obere Hülle aller Dächer = Vereinigung der Räume unter allen Dachflächen. Was von `Box_l` innerhalb
//!    eines Dachumrisses, dessen Dach auf l steht, ÜBER dieser Hülle liegt, fällt weg (Kniestock).
//!  • `E_l` = (`Box_l` − Schnitt) ∪ `U_r` der Dächer auf l; Hülle = ∪ `E_l`.
//!  • Korrektur Δ_l = Zuwachs der Hülle durch `E_l` − Zuwachs der Geschoss-Quader durch `Box_l` (von unten
//!    nach oben). Σ Δ_l = Vol(Hülle) − Vol(∪ `Box_l`): die Flächenzahlen (GF aus den Teilen, nicht aus dem
//!    Umriss) bleiben, nur der Dachraum kommt dazu. Ohne Dach (oder mit Flachdach auf der Geschossoberkante)
//!    ist Δ = 0, GV = Σ GF × Höhe wie bisher.
//!
//! Die Dachfläche ist die Oberkante (`roof::roof_geometry`, Schichten liegen darunter): ein Flachdach auf
//! der Oberkante des obersten Geschosses fügt nichts hinzu, die Geschosshöhe OK–OK enthält die Decke. Die
//! Bodenplatte unter dem untersten Geschoss und Studienkörper neben dem Haus kommen in `flaechen.rs` dazu
//! (`base_slab_volume`, `study_solid_volumes`, [266]).
//!
//! Ergebnis je Inhalt gecacht (Schlüssel `gv-roof-space`); scheitert ein Boolean, ist die Korrektur 0 und
//! `failed` > 0 (Hinweis in der Flächentabelle), nie Panik.

use crate::flat::Polygon;
use crate::jsnum::or_zero as finite;
use crate::model::{DrawingLevel, Project};
use crate::polygon_bool;
use crate::solid_bool::{cached, ContentHash, Mesh, Solid};

/// Dachraum-Korrektur des Gebäudevolumens.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct RoofSpace {
    /// Korrektur je Geschoss (m³, Reihenfolge wie `floors`), Summe = Dachraum.
    pub per_level: Vec<f64>,
    /// Anteil der Korrektur über ±0.00 (Baumasse).
    pub above_ground: f64,
    /// Gescheiterte Körper-Operationen (dann ist die Korrektur 0).
    pub failed: usize,
}

impl RoofSpace {
    pub fn total(&self) -> f64 {
        self.per_level.iter().sum()
    }
}

fn base(l: &DrawingLevel) -> f64 {
    finite(l.base_elevation.unwrap_or(0.0))
}

fn height(l: &DrawingLevel) -> f64 {
    finite(l.floor_height.unwrap_or(0.0)).max(0.0)
}

/// Dachraum-Korrektur. `floors` von unten nach oben, `footprints[i]` = Grundriss von `floors[i]`
/// (Polygone ohne Löcher; leer = Geschoss ohne Wände/Räume).
pub fn roof_space(p: &Project, floors: &[&DrawingLevel], footprints: &[Vec<Polygon>]) -> RoofSpace {
    let zero = RoofSpace { per_level: vec![0.0; floors.len()], above_ground: 0.0, failed: 0 };
    if p.roofs.as_deref().unwrap_or(&[]).is_empty() || footprints.len() != floors.len() {
        return zero;
    }
    let mut h = ContentHash::default();
    for (l, fp) in floors.iter().zip(footprints) {
        h.str(&l.id).f64(base(l)).f64(height(l)).u64(fp.len() as u64);
        for poly in fp {
            for ring in poly {
                h.f64s(&ring.iter().flat_map(|q| [q[0], q[1]]).collect::<Vec<_>>());
            }
        }
    }
    h.json(&p.roofs).json(&p.roof_types).json(&p.wall_types);
    let r = cached("gv-roof-space", h.finish(), || match compute(p, floors, footprints) {
        Ok(r) => r,
        Err(_e) => {
            #[cfg(test)]
            eprintln!("roof_space: {_e}");
            RoofSpace { failed: 1, ..zero.clone() }
        }
    });
    (*r).clone()
}

/// Senkrechtes Prisma über Polygonen (Aussenring, Löcher abgezogen) von `z0` bis `z1`.
fn area_prism(area: &[Polygon], z0: f64, z1: f64) -> Result<Solid, String> {
    let mut acc = Solid::empty();
    if !(z1 - z0 > 1e-9) {
        return Ok(acc);
    }
    for poly in area {
        let Some(outer) = poly.first() else { continue };
        let m = Mesh::prism(outer, z0, z1);
        if m.is_empty() {
            continue;
        }
        let mut s = Solid::new(&m)?;
        for hole in &poly[1..] {
            let hm = Mesh::prism(hole, z0 - 1.0, z1 + 1.0);
            if !hm.is_empty() {
                s = s.difference(&Solid::new(&hm)?)?;
            }
        }
        acc = acc.union(&s)?;
    }
    Ok(acc)
}

/// [327] Vereinigung von Körpern, die meist übereinander liegen (Geschosse): Teile, deren Höhenbereiche sich nicht
/// überlappen, bleiben einzeln — das Volumen der Vereinigung ist ihre Summe, ohne Boolean (zwei Geschoss-Prismen mit
/// je 300 Ecken zu vereinen kostete 40–130 ms, und das je Geschoss doppelt). Nur was sich in der Höhe überlappt
/// (Dachraum in das Geschoss darüber), wird wirklich vereinigt.
#[derive(Default)]
struct Stack {
    /// (Körper, z von, z bis, Volumen)
    parts: Vec<(Solid, f64, f64, f64)>,
}

impl Stack {
    /// Körper dazu; Ergebnis: Zuwachs des Volumens der Vereinigung.
    fn add(&mut self, s: Solid) -> Result<f64, String> {
        let Some((lo, hi)) = s.to_mesh_raw().bounds() else { return Ok(0.0) };
        let (mut merged, mut z, mut old) = (s, (lo[2], hi[2]), 0.0);
        let mut i = 0;
        while i < self.parts.len() {
            let q = &self.parts[i];
            if q.1 < z.1 - 1e-9 && q.2 > z.0 + 1e-9 {
                let q = self.parts.remove(i);
                merged = q.0.union(&merged)?;
                z = (z.0.min(q.1), z.1.max(q.2));
                old += q.3;
                // Der gewachsene Bereich kann frühere Teile neu berühren.
                i = 0;
            } else {
                i += 1;
            }
        }
        let v = merged.volume();
        self.parts.push((merged, z.0, z.1, v));
        Ok(v - old)
    }

    /// Volumen über ±0.00.
    fn above_zero(&self) -> Result<f64, String> {
        let mut sum = 0.0;
        for (s, z0, z1, v) in &self.parts {
            if *z0 >= 0.0 {
                sum += v;
            } else if *z1 > 0.0 {
                let Some((lo, hi)) = s.to_mesh_raw().bounds() else { continue };
                let ring = [[lo[0] - 1.0, lo[1] - 1.0], [hi[0] + 1.0, lo[1] - 1.0], [hi[0] + 1.0, hi[1] + 1.0], [lo[0] - 1.0, hi[1] + 1.0]];
                sum += s.intersection(&Solid::new(&Mesh::prism(&ring, 0.0, hi[2] + 1.0))?)?.volume();
            }
        }
        Ok(sum)
    }
}

/// Ein Dach: Geschoss-Index, Umriss ∩ Grundriss, Raum unter der Oberkante (bis tief hinunter), Höhen.
struct RoofIn {
    level: usize,
    area: Vec<Polygon>,
    under: Solid,
    z_hi: f64,
}

fn roof_in(p: &Project, roof: &crate::model::Roof, level: usize, footprint: &[Polygon], z_floor: f64) -> Result<Option<RoofIn>, String> {
    let params = roof.params();
    if params.outline.len() < 3 || params.outline.iter().any(|q| !(q[0].is_finite() && q[1].is_finite())) {
        return Ok(None);
    }
    let mut outline: Polygon = vec![params.outline.clone()];
    outline.extend(params.holes.iter().filter(|h| h.len() >= 3).cloned());
    let area = polygon_bool::intersection(footprint, &[outline]);
    if area.is_empty() {
        return Ok(None);
    }
    let g = crate::roof::roof_geometry(&params, p.roof_base_elevation(roof));
    let dormers: Vec<crate::dormer::DormerGeom> = roof.dormers.as_deref().unwrap_or(&[]).iter().filter_map(|d| crate::dormer::geometry(p, roof, d)).collect();
    let (mut z_lo, mut z_hi) = (z_floor, z_floor);
    for q in g.planes.iter().flatten() {
        z_lo = z_lo.min(q[2]);
        z_hi = z_hi.max(q[2]);
    }
    for d in &dormers {
        z_hi = z_hi.max(d.z_max());
    }
    if !(z_lo.is_finite() && z_hi.is_finite()) {
        return Ok(None);
    }
    let (z_lo, z_hi) = (z_lo - 1.0, z_hi + 1.0);
    // Raum unter jeder Dachfläche (lotrechtes Prisma, Deckel = Dachebene).
    let mut meshes = Vec::new();
    for pl in g.planes.iter().filter(|pl| pl.len() >= 3) {
        let n = crate::model3d::plane_normal_up(pl);
        if n[2] < 1e-3 {
            continue; // senkrecht
        }
        let o = pl[0];
        let top = move |x: f64, y: f64| o[2] - (n[0] * (x - o[0]) + n[1] * (y - o[1])) / n[2];
        let ring: Vec<[f64; 2]> = pl.iter().map(|q| [q[0], q[1]]).collect();
        let m = Mesh::prism_between(&ring, &move |_, _| z_lo, &top);
        if !m.is_empty() {
            meshes.push(m);
        }
    }
    let (mut under, bad) = Solid::union_all(&meshes);
    if bad > 0 {
        return Err(format!("Dach {}: {bad} Flächen ohne Körper", roof.id));
    }
    // Gauben: unter dem Gaubendach, nur über dem Loch im Hauptdach (Stirn-Aussenseite bis Anschluss).
    for d in &dormers {
        let f = &d.frame;
        let mut pieces = Vec::new();
        for pl in d.planes() {
            let ring: Vec<[f64; 2]> = pl.ring.iter().map(|q| f.plan(q[0], q[1])).collect();
            let f2 = f.clone();
            let top = move |x: f64, y: f64| {
                let l = f2.local(x, y);
                pl.z(l[0], l[1])
            };
            let m = Mesh::prism_between(&ring, &move |_, _| z_lo, &top);
            if !m.is_empty() {
                pieces.push(m);
            }
        }
        let (s, bad) = Solid::union_all(&pieces);
        let hole: Vec<[f64; 2]> = d.hole().iter().map(|q| f.plan(q[0], q[1])).collect();
        let hm = Mesh::prism(&hole, z_lo, z_hi);
        if bad > 0 || hm.is_empty() {
            return Err(format!("Gaube in Dach {}", roof.id));
        }
        under = under.union(&s.intersection(&Solid::new(&hm)?)?)?;
    }
    Ok(Some(RoofIn { level, area, under, z_hi }))
}

fn compute(p: &Project, floors: &[&DrawingLevel], fps: &[Vec<Polygon>]) -> Result<RoofSpace, String> {
    let n = floors.len();
    let mut out = RoofSpace { per_level: vec![0.0; n], above_ground: 0.0, failed: 0 };
    let mut roofs: Vec<RoofIn> = Vec::new();
    for roof in p.roofs.as_deref().unwrap_or(&[]) {
        let Some(li) = floors.iter().position(|l| l.id == roof.floor_id) else { continue };
        // Geschoss ohne Wände/Räume (z. B. eigene Dachebene): Grundriss des nächsten darunter.
        let Some(fi) = (0..=li).rev().find(|&k| !fps[k].is_empty()) else { continue };
        if let Some(r) = roof_in(p, roof, li, &fps[fi], base(floors[li]))? {
            roofs.push(r);
        }
    }
    if roofs.is_empty() {
        return Ok(out);
    }
    let mut hull = Solid::empty();
    for r in &roofs {
        hull = hull.union(&r.under)?;
    }
    let (mut env, mut boxes) = (Stack::default(), Stack::default());
    for i in 0..n {
        let (z0, z1) = (base(floors[i]), base(floors[i]) + height(floors[i]));
        let bx = area_prism(&fps[i], z0, z1)?;
        let mut e = bx.clone();
        let mine: Vec<&RoofIn> = roofs.iter().filter(|r| r.level == i).collect();
        if !mine.is_empty() {
            // Teile des Geschosses über der Dachhülle (innerhalb der Umrisse seiner Dächer) fallen weg.
            let mut cut = Solid::empty();
            for r in &mine {
                cut = cut.union(&area_prism(&r.area, z0 - 1.0, r.z_hi.max(z1) + 1.0)?)?;
            }
            e = e.difference(&cut.difference(&hull)?)?;
            for r in &mine {
                e = e.union(&r.under.intersection(&area_prism(&r.area, z0, r.z_hi)?)?)?;
            }
        }
        out.per_level[i] = env.add(e)? - boxes.add(bx)?;
    }
    // Anteil über ±0.00.
    out.above_ground = env.above_zero()? - boxes.above_zero()?;
    if out.per_level.iter().any(|v| !v.is_finite()) || !out.above_ground.is_finite() {
        return Err("Volumen nicht endlich".into());
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use crate::flaechen::{area_table, ivhb, tests::house, IvhbOptions};
    use crate::model::Project;

    /// m³: Die Grundrisse laufen über i_overlay (Ganzzahlraster ≈ Ausdehnung/2³⁰), die Volumen daher auf
    /// ≈ 1e-6 genau.
    const TOL: f64 = 1e-4;

    /// [327] `Stack`: Zuwachs je Körper und Anteil über ±0.00 wie bei der vollen Vereinigung — gestapelt (berührend),
    /// überlappend (Dachraum ins Geschoss darüber) und ein Teil, das zwei getrennte verbindet.
    #[test]
    fn stack_wie_volle_vereinigung() {
        use super::Stack;
        use crate::solid_bool::{Mesh, Solid};
        let bx = |x0: f64, x1: f64, z0: f64, z1: f64| Solid::new(&Mesh::prism(&[[x0, 0.0], [x1, 0.0], [x1, 4.0], [x0, 4.0]], z0, z1)).unwrap();
        let parts = [bx(0.0, 5.0, -2.7, 0.0), bx(0.0, 5.0, 0.0, 2.9), bx(1.0, 6.0, 5.0, 8.0), bx(2.0, 4.0, 2.0, 6.0), bx(0.0, 1.0, 8.0, 9.0)];
        let (mut stack, mut full, mut v) = (Stack::default(), Solid::empty(), 0.0);
        for q in &parts {
            full = full.union(q).unwrap();
            let d = stack.add(q.clone()).unwrap();
            assert!((d - (full.volume() - v)).abs() < 1e-9, "Zuwachs {d} statt {}", full.volume() - v);
            v = full.volume();
        }
        // Unten ein Teil für sich, oben alles über die Brücke 2.0..6.0 verbunden, zuoberst wieder eines für sich.
        assert_eq!(stack.parts.len(), 3);
        let above = Solid::new(&Mesh::prism(&[[-1.0, -1.0], [7.0, -1.0], [7.0, 5.0], [-1.0, 5.0]], 0.0, 10.0)).unwrap();
        assert!((stack.above_zero().unwrap() - full.intersection(&above).unwrap().volume()).abs() < 1e-9);
    }

    fn close(a: f64, b: f64, tol: f64) -> bool {
        (a - b).abs() < tol
    }

    /// GV des Testhauses ohne Dach: 3 Geschosse (UG, EG, OG) × 85.49 m² (10.3 × 8.3) × 2.6 m.
    const BOXES: f64 = 3.0 * 85.49 * 2.6;
    const T30: f64 = 0.577_350_269_189_625_8; // tan 30°

    /// Testhaus mit Dächern (JSON) auf dem OG (Oberkante 5.2); Umriss = Aussenflucht der Wände
    /// (Achsen 10 × 8, Dicke 0.3 ⇒ −0.15 … 10.15 × −0.15 … 8.15).
    fn with_roofs(roofs: serde_json::Value) -> Project {
        let mut p = house();
        p.roofs = Some(serde_json::from_value(roofs).unwrap());
        p
    }

    fn roof(shape: &str, pitch: f64, overhang: f64, extra: serde_json::Value) -> serde_json::Value {
        let mut r = serde_json::json!({"id":"d","type":"roof","floorId":"og","categoryCode":"31","shape":shape,"pitchDeg":pitch,
            "overhang":overhang,"ridgeAxis":"x","thickness":0.3,
            "outline":[{"x":-0.15,"y":-0.15},{"x":10.15,"y":-0.15},{"x":10.15,"y":8.15},{"x":-0.15,"y":8.15}]});
        for (k, v) in extra.as_object().unwrap() {
            r[k] = v.clone();
        }
        r
    }

    #[test]
    fn quader_mit_flachdach_ist_grundflaeche_mal_hoehe() {
        let p = with_roofs(serde_json::json!([roof("flach", 0.0, 0.0, serde_json::json!({}))]));
        let t = area_table(&p);
        assert!(close(t.gv, BOXES, TOL), "gv {}", t.gv);
        assert!(close(t.levels[2].gv, 85.49 * 2.6, TOL));
        assert!(close(t.total.gv, t.gv, 1e-9));
    }

    #[test]
    fn satteldach_prisma_von_hand() {
        // First längs x über der Mitte y = 4; Traufe (Überstand 0.5) bei y = −0.65 / 8.65 auf 5.2.
        // Über dem Umriss (Überstand zählt nicht): an der Fassade y = −0.15 Höhe 0.5·tan30, am First
        // 4.65·tan30 über 5.2 ⇒ Querschnitt 2 · 4.15 · (0.5 + 4.65)/2 · tan30, Länge 10.3.
        let p = with_roofs(serde_json::json!([roof("sattel", 30.0, 0.5, serde_json::json!({}))]));
        let dach = 10.3 * 8.3 * (0.5 + 4.65) / 2.0 * T30;
        let t = area_table(&p);
        assert!(close(t.gv, BOXES + dach, TOL), "gv {} statt {}", t.gv, BOXES + dach);
        // Der Dachraum gehört zur Zeile des Geschosses, auf dem das Dach steht; Summe = GV.
        assert!(close(t.levels[2].gv, 85.49 * 2.6 + dach, TOL));
        assert!(close(t.levels[0].gv, 85.49 * 2.6, TOL) && close(t.levels[1].gv, 85.49 * 2.6, TOL));
        assert!(close(t.total.gv, t.gv, 1e-9));
        // Baumasse (BMZ): oberirdisch = EG + OG + Dachraum, das UG (unter ±0.00) nicht.
        let v = ivhb(&p, &IvhbOptions { agsf: Some(400.0), ..Default::default() });
        assert!(close(v.baumasse, 2.0 * 85.49 * 2.6 + dach, TOL), "baumasse {}", v.baumasse);
        assert!(close(v.bmz.unwrap(), v.baumasse / 400.0, 1e-12));
    }

    #[test]
    fn walmdach_von_hand() {
        // Ohne Überstand, 45°: Walm über 10.3 × 8.3, Firsthöhe h = 4.15; Prisma über die Firstlänge
        // L − B = 2 (Querschnitt B·h/2) + Pyramide aus den beiden Walmenden (B²·h/3).
        let p = with_roofs(serde_json::json!([roof("walm", 45.0, 0.0, serde_json::json!({}))]));
        let (l, b, h) = (10.3, 8.3, 4.15);
        let dach = (l - b) * b * h / 2.0 + b * b * h / 3.0;
        let t = area_table(&p);
        assert!(close(t.gv, BOXES + dach, TOL), "gv {} statt {}", t.gv, BOXES + dach);
    }

    #[test]
    fn pultdach_von_hand() {
        // Pult steigt von y = −0.15 (Traufe auf 5.2) bis y = 8.15: Keil 10.3 × 8.3 × 8.3·tan30 / 2.
        let p = with_roofs(serde_json::json!([roof("pult", 30.0, 0.0, serde_json::json!({}))]));
        let dach = 10.3 * 8.3 * 8.3 * T30 / 2.0;
        let t = area_table(&p);
        assert!(close(t.gv, BOXES + dach, TOL), "gv {} statt {}", t.gv, BOXES + dach);
    }

    #[test]
    fn kniestock_schneidet_das_geschoss_unter_der_dachflaeche() {
        // Traufe auf 4.0 (Kniestock 1.4 über OK EG = 2.6), 45°, ohne Überstand: Das OG reicht nur bis
        // zur Dachfläche. OG + Dach = 85.49 × 1.4 + Satteldach 10.3 · 8.3² / 4 (First 4.15 über der Traufe).
        let p = with_roofs(serde_json::json!([roof("sattel", 45.0, 0.0, serde_json::json!({"baseElevation": 4.0}))]));
        let og = 85.49 * 1.4 + 10.3 * 8.3 * 8.3 / 4.0;
        let t = area_table(&p);
        assert!(close(t.levels[2].gv, og, TOL), "og {} statt {og}", t.levels[2].gv);
        assert!(close(t.gv, 2.0 * 85.49 * 2.6 + og, TOL));
    }

    #[test]
    fn untergeschoss_zaehlt_zum_gv_nicht_zur_baumasse() {
        let p = with_roofs(serde_json::json!([roof("sattel", 30.0, 0.0, serde_json::json!({}))]));
        let t = area_table(&p);
        let ug = &t.levels[0];
        assert!(ug.underground && close(ug.gv, 85.49 * 2.6, TOL));
        let v = ivhb(&p, &IvhbOptions::default());
        assert!(close(t.gv - v.baumasse, 85.49 * 2.6, TOL), "gv {} baumasse {}", t.gv, v.baumasse);
    }

    #[test]
    fn ueberstand_und_dach_ueber_offener_flaeche_zaehlen_nicht() {
        // Carport-Dach neben dem Haus (kein Geschoss-Grundriss darunter) und grosser Überstand.
        let mut carport = roof("pult", 5.0, 0.3, serde_json::json!({"id":"cp","floorId":"eg"}));
        carport["outline"] = serde_json::json!([{"x":12,"y":0},{"x":16,"y":0},{"x":16,"y":6},{"x":12,"y":6}]);
        let p = with_roofs(serde_json::json!([roof("flach", 0.0, 2.0, serde_json::json!({})), carport]));
        assert!(close(area_table(&p).gv, BOXES, TOL));
    }

    #[test]
    fn gaube_vergroessert_den_dachraum() {
        let ohne = area_table(&with_roofs(serde_json::json!([roof("sattel", 40.0, 0.5, serde_json::json!({}))]))).gv;
        let gaube = serde_json::json!({"dormers":[{"id":"g","kind":"schlepp","position":{"x":5.0,"y":1.0},"width":2.4,"frontHeight":1.4,"overhang":0.2}]});
        let p = with_roofs(serde_json::json!([roof("sattel", 40.0, 0.5, gaube)]));
        let mit = area_table(&p).gv;
        // Grob: Breite 2.4, Stirn 1.4 m über der Dachfläche, keilförmig bis zum Anschluss ⇒ einige m³,
        // höchstens Breite × Stirnhöhe × halbe Haustiefe.
        assert!(mit - ohne > 1.0 && mit - ohne < 2.4 * 1.6 * 4.15, "Gaube {}", mit - ohne);
    }

    #[test]
    fn mehrere_daecher_ueberlappend_zaehlen_einmal() {
        // Zweimal dasselbe Dach: obere Hülle = ein Dach.
        let a = roof("sattel", 30.0, 0.5, serde_json::json!({}));
        let b = roof("sattel", 30.0, 0.5, serde_json::json!({"id":"d2"}));
        let one = area_table(&with_roofs(serde_json::json!([a.clone()]))).gv;
        let two = area_table(&with_roofs(serde_json::json!([a, b]))).gv;
        assert!(close(one, two, TOL), "{one} / {two}");
    }

    #[test]
    fn unsinn_im_dach_ohne_panik() {
        // (JSON kennt kein NaN: absurde Zahlen stattdessen.)
        let mut r = roof("sattel", 1e300, -1e300, serde_json::json!({}));
        r["outline"][1]["x"] = serde_json::json!(1e200);
        let p = with_roofs(serde_json::json!([r, roof("walm", 89.9, 0.0, serde_json::json!({"id":"x","floorId":"fehlt"}))]));
        let t = area_table(&p);
        assert!(t.gv.is_finite());
    }

    /// [297] O-Grundriss (Aussenwände 20 × 16, Hofwände 6 × 6 in der Mitte, Räume dazwischen) mit EINEM Dach über der
    /// ganzen Aussenflucht, ohne Hof im Dach: der unüberbaute Innenhof (kein Raum, nach oben offen) bekommt keinen
    /// Dachraum. Gleich viel wie ein Dach, dessen Hof ausdrücklich ausgespart ist; und kleiner als der Hof wäre gefüllt.
    fn o_haus(roof_holes: bool, with_rooms: bool) -> Project {
        let json = r#"{"drawingLevels":[{"id":"eg","name":"EG","kind":"floor","visible":true,"locked":false,"baseElevation":0,"floorHeight":2.6}],
          "wallTypes":[{"id":"wt","name":"W","layers":[{"componentId":"c","thickness":0.3}]}],"walls":[],"rooms":[]}"#;
        let mut p: Project = serde_json::from_str(json).unwrap();
        let v = |x: f64, y: f64| serde_json::json!({"x": x, "y": y});
        let mut walls = vec![];
        for (k, (x0, y0, x1, y1)) in [(0.0, 0.0, 20.0, 16.0), (7.0, 5.0, 13.0, 11.0)].into_iter().enumerate() {
            let pts = [(x0, y0), (x1, y0), (x1, y1), (x0, y1)];
            for i in 0..4 {
                let (a, b) = (pts[i], pts[(i + 1) % 4]);
                walls.push(serde_json::json!({"id":format!("w{k}{i}"),"type":"wall","floorId":"eg","categoryCode":"x","start":v(a.0,a.1),"end":v(b.0,b.1),"wallTypeId":"wt","height":2.6}));
            }
        }
        let room = |id: &str, x0: f64, y0: f64, x1: f64, y1: f64| {
            serde_json::json!({"id":id,"type":"room","floorId":"eg","categoryCode":"x","siaCategory":"HNF","name":id,"color":"#fff",
            "boundary":[v(x0,y0),v(x1,y0),v(x1,y1),v(x0,y1)]})
        };
        let rooms = if with_rooms {
            vec![room("l", 0.15, 0.15, 6.85, 15.85), room("r", 13.15, 0.15, 19.85, 15.85), room("u", 6.85, 0.15, 13.15, 4.85), room("o", 6.85, 11.15, 13.15, 15.85)]
        } else {
            vec![]
        };
        p.walls = serde_json::from_value(serde_json::Value::Array(walls)).unwrap();
        p.rooms = Some(serde_json::from_value(serde_json::Value::Array(rooms)).unwrap());
        let mut r = roof("sattel", 30.0, 0.5, serde_json::json!({"floorId":"eg"}));
        r["outline"] = serde_json::json!([{"x":-0.15,"y":-0.15},{"x":20.15,"y":-0.15},{"x":20.15,"y":16.15},{"x":-0.15,"y":16.15}]);
        if roof_holes {
            r["holes"] = serde_json::json!([[{"x":7.15,"y":5.15},{"x":12.85,"y":5.15},{"x":12.85,"y":10.85},{"x":7.15,"y":10.85}]]);
        }
        p.roofs = Some(serde_json::from_value(serde_json::json!([r])).unwrap());
        p
    }

    #[test]
    fn innenhof_ohne_dach_wird_nicht_gefuellt() {
        let t = area_table(&o_haus(false, true));
        assert!(!t.notes.iter().any(|n| n == "gvRoofFailed"), "{:?}", t.notes);
        // Von Hand: Satteldach 30° (Traufe y = −0.65 / 16.65 bei Überstand 0.5, First y = 8) über 20.3 × 16.3 (Aussenflucht)
        // abzüglich Hof 5.7 × 5.7 (y 5.15 … 10.85); Höhe über OK Geschoss = (Abstand von der Traufe) · tan30.
        let ganz = 20.3 * 2.0 * (8.65_f64 * 8.65 - 0.5 * 0.5) / 2.0;
        let hof = 5.7 * 2.0 * (8.65_f64 * 8.65 - 5.8 * 5.8) / 2.0;
        let dach = (ganz - hof) * T30;
        assert!(close(t.levels[0].roof_gv, dach, 1e-2), "Dachraum {} statt {dach} (Hof gefüllt wären {})", t.levels[0].roof_gv, ganz * T30);
        // Geschoss selbst: nur die Fläche GF × Höhe, der Hof kommt nicht dazu.
        assert!(close(t.levels[0].gv - t.levels[0].roof_gv, t.levels[0].gf * 2.6, TOL));
    }

    #[test]
    fn wandring_ohne_raeume_bleibt_ein_ganzes_geschoss() {
        // Ohne Räume ist jeder Ring ein ganzes Geschoss (auch der Hofring): nichts wird ausgespart.
        let t = area_table(&o_haus(false, false));
        let h = area_table(&o_haus(true, false));
        assert!(t.levels[0].roof_gv > h.levels[0].roof_gv + 50.0, "{} / {}", t.levels[0].roof_gv, h.levels[0].roof_gv);
    }

    /// Musterhaus komplex (Auszug von `buildComplexSampleProject`: Geschosse, Wände, Räume, Dächer, Körper).
    /// Von Hand: Geschosse Σ GF × Höhe = 175.52·2.7 + 193.63·2.9 + 193.63·2.8 + 159.90·2.6 ≈ 1993 m³.
    /// Hauptdach auf dem DG (Sattel 38°, Traufe 7.3, Umriss = Aussenflucht 15.39 × 10.39, Überstand 0.6):
    /// Dach-Oberkante an der Fassade 7.3 + 0.6·tan38 = 7.77, am First (y = 5) 7.3 + 5.795·tan38 = 11.83;
    /// mittlere Höhe über dem DG-Boden 5.7: 9.80 − 5.7 = 4.10 ⇒ DG + Dachraum ≈ 159.9 m² × 4.10 ≈ 655 m³
    /// statt DG-Quader 159.9 × 2.6 ≈ 416 m³ ⇒ +240 m³ (der Kniestock-Streifen über der Dachfläche ist darin
    /// schon abgezogen). Anbau auf dem OG (Sattel 38°, First längs y, Traufe 7.3, 5.39 breit, ausserhalb des
    /// Haupthauses 5.0 tief): mittlere Dachhöhe (7.77 + 9.87)/2 = 8.82 über OK OG 5.7 ⇒ 26.95 m² × 3.12
    /// ≈ +84 m³; sein First ragt über dem Haupthaus-Streifen y 7.85…10.2 aus dem Hauptdach (Quergiebel, einige
    /// m³). Gauben (Schlepp 2.8, Sattel 2.2 breit) je einige m³. Erwartet Dachraum ≈ 330–345 m³, GV ≈ 2330 m³
    /// (Kern: 343 m³). Der Carport (Pult über offener Fläche) und das Erker-Flachdach zählen nicht.
    #[test]
    fn musterhaus_komplex_plausibel() {
        let p: Project = serde_json::from_str(include_str!("../tests/fixtures/gv_musterhaus_komplex.json")).unwrap();
        let t = area_table(&p);
        let levels: f64 = t.levels.iter().map(|l| l.gf * l.height).sum();
        assert!(close(levels, 175.52 * 2.7 + 193.63 * 2.9 + 193.63 * 2.8 + 159.90 * 2.6, 0.1), "Geschosse {levels}");
        assert_eq!(t.gv_source, crate::flaechen::GvSource::Levels);
        assert!(t.gv > levels + 300.0 && t.gv < levels + 380.0, "GV {} (Geschosse {levels})", t.gv);
        assert!(close(t.total.gv, t.gv, 1e-9));
        assert!(!t.notes.iter().any(|n| n == "gvRoofFailed"), "{:?}", t.notes);
        // Dachraum beim DG (Hauptdach) und beim OG (Anbau); UG/EG unverändert.
        assert!(close(t.levels[0].gv, t.levels[0].gf * 2.7, TOL) && close(t.levels[1].gv, t.levels[1].gf * 2.9, TOL));
        assert!(t.levels[3].gv - t.levels[3].gf * 2.6 > 150.0, "DG {}", t.levels[3].gv);
        assert!(t.levels[2].gv - t.levels[2].gf * 2.8 > 60.0, "OG {}", t.levels[2].gv);
    }
}
