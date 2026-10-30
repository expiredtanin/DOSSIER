//! Gauben/Lukarnen ([G5]): Geometrie einer Gaube in einer Dachfläche (`Roof.dormers`).
//!
//! **System** ([`DormerFrame`]): `p` = Mitte der Stirnwand-Aussenseite im Grundriss, `h` = waagrecht
//! nach aussen (das Gefälle hinab), `ew` = Breite (von aussen gesehen nach rechts). Lokal `u` (Breite,
//! ab Mitte), `v` (waagrecht das Gefälle hinauf ab der Stirn-Aussenseite), `z` absolut. Die Dach-
//! Oberkante des Hauptdachs ist dort `z_m0 + v·tan P` (längs `ew` waagrecht).
//!
//! **Teile** (alle als Grundriss-Polygone + Höhenfunktionen, Körper baut `roof_assembly`):
//! - Gaubendach: Oberfläche über einem Rechteck mit Überstand, bis über den Anschluss hinaus
//!   verlängert (`v_end`); `roof_assembly` schneidet alles unter der Hauptdach-Oberkante weg.
//! - Unterkante Gaubendach `under(u, v)`: Flach waagrecht, Schlepp steigt mit `v`, Sattel fällt zu den
//!   Seiten, Walm zusätzlich zur Stirn.
//! - Loch im Hauptdach `hole`: wo die Unterkante über der Hauptdach-Oberkante liegt (|u| ≤ b/2).
//! - Stirnwand (volle Breite, `v` 0 … Wanddicke) und Wangen (bis an den Lochrand), je Wandschicht.

use crate::model::*;
use crate::opening_shape::V3;

pub type P = [f64; 2];

const DEG: f64 = std::f64::consts::PI / 180.0;

/// System der Gaube in ihrer Dachfläche.
#[derive(Clone, Debug, PartialEq)]
pub struct DormerFrame {
    pub p: P,
    pub h: P,
    pub ew: P,
    /// Hauptdach-Oberkante an der Stirn (über `p`).
    pub z_m0: f64,
    /// Steigung des Hauptdachs (tan der Neigung).
    pub tan_main: f64,
    /// Normale der Dachfläche (nach oben) und ihr Index in `roof_geometry().planes`.
    pub n: V3,
    pub plane: usize,
}

impl DormerFrame {
    /// Lokal (u, v) → Grundriss.
    pub fn plan(&self, u: f64, v: f64) -> P {
        [self.p[0] + self.ew[0] * u - self.h[0] * v, self.p[1] + self.ew[1] * u - self.h[1] * v]
    }
    pub fn world(&self, u: f64, v: f64, z: f64) -> V3 {
        let q = self.plan(u, v);
        [q[0], q[1], z]
    }
    /// Grundriss → lokal (u, v).
    pub fn local(&self, x: f64, y: f64) -> P {
        let (dx, dy) = (x - self.p[0], y - self.p[1]);
        [dx * self.ew[0] + dy * self.ew[1], -(dx * self.h[0] + dy * self.h[1])]
    }
    pub fn main_top(&self, v: f64) -> f64 {
        self.z_m0 + v * self.tan_main
    }
}

/// Vollständige Gauben-Geometrie.
#[derive(Clone, Debug)]
pub struct DormerGeom {
    pub frame: DormerFrame,
    pub kind: DormerKind,
    /// Aussenbreite, Stirnhöhe, Überstand.
    pub width: f64,
    pub front_height: f64,
    pub overhang: f64,
    /// tan der Gaubendach-Neigung.
    pub tan_p: f64,
    /// Unterkante Gaubendach an der Stirn-Aussenseite.
    pub z_e: f64,
    /// Dachschichten (Gaubendach) und Wandschichten (aussen zuerst).
    pub roof_layers: Vec<Layer>,
    pub wall_layers: Vec<Layer>,
    pub roof_thickness: f64,
    pub wall_thickness: f64,
    /// Hauptdach-Dicke (senkrecht zur Fläche).
    pub main_thickness: f64,
    /// Ende der Gaubendach-Flächen hinten (lokal v).
    pub v_end: f64,
}

/// Fläche des Gaubendachs: Grundriss-Polygon (lokal, Gegenuhrzeigersinn) und Ebene `z = a + bu·u + bv·v`
/// der Oberkante.
#[derive(Clone, Debug)]
pub struct DormerPlane {
    pub ring: Vec<P>,
    pub a: f64,
    pub bu: f64,
    pub bv: f64,
}

impl DormerPlane {
    pub fn z(&self, u: f64, v: f64) -> f64 {
        self.a + self.bu * u + self.bv * v
    }
    /// cos der Neigung (senkrechte Dicke → lotrechte).
    pub fn cos(&self) -> f64 {
        1.0 / (1.0 + self.bu * self.bu + self.bv * self.bv).sqrt()
    }
}

fn finite_pos(v: f64) -> bool {
    v.is_finite() && v > 0.0
}

/// System der Gaube: Dachfläche über `position`, Gefälle aus der Flächennormale. `None`, wenn der Punkt
/// in keiner geneigten Fläche liegt.
pub fn frame(p: &Project, roof: &Roof, d: &Dormer) -> Option<DormerFrame> {
    let (x, y) = (d.position.x, d.position.y);
    if !(x.is_finite() && y.is_finite()) {
        return None;
    }
    let g = crate::roof::roof_geometry(&roof.params(), p.roof_base_elevation(roof));
    let (plane, pts) = g.planes.iter().enumerate().find(|(_, pl)| pl.len() >= 3 && point_in_xy(x, y, pl))?;
    let n = crate::model3d::plane_normal_up(pts);
    let hl = (n[0] * n[0] + n[1] * n[1]).sqrt();
    if !(n[2] > 0.05 && hl > 0.05) {
        return None; // flach oder senkrecht: keine Gaube
    }
    let h = [n[0] / hl, n[1] / hl];
    let z_m0 = pts[0][2] - (n[0] * (x - pts[0][0]) + n[1] * (y - pts[0][1])) / n[2];
    Some(DormerFrame { p: [x, y], h, ew: [-h[1], h[0]], z_m0, tan_main: hl / n[2], n, plane })
}

pub(crate) fn point_in_xy(x: f64, y: f64, poly: &[V3]) -> bool {
    let mut inside = false;
    let n = poly.len();
    let mut j = n.wrapping_sub(1);
    for i in 0..n {
        let (a, b) = (poly[i], poly[j]);
        if (a[1] > y) != (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0] {
            inside = !inside;
        }
        j = i;
    }
    inside
}

/// Wandschichten der Gaube (Wandtyp, sonst eine Schicht 15 cm).
pub fn wall_layers(p: &Project, d: &Dormer) -> Vec<Layer> {
    let t = d.wall_type_id.as_deref().and_then(|id| p.wall_types.iter().find(|t| t.id == id));
    let l: Vec<Layer> = t.map(|t| t.layers.iter().filter(|l| l.thickness > 1e-6).cloned().collect()).unwrap_or_default();
    if l.is_empty() {
        vec![Layer { component_id: String::new(), thickness: 0.15, ..Default::default() }]
    } else {
        l
    }
}

/// Dachschichten der Gaube (Dachtyp der Gaube, sonst die des Hauptdachs).
pub fn roof_layers(p: &Project, roof: &Roof, d: &Dormer) -> Vec<Layer> {
    let own = d.roof_type_id.as_deref().and_then(|id| p.roof_types.as_deref()?.iter().find(|t| t.id == id)).filter(|t| !t.layers.is_empty());
    let l: Vec<Layer> = match own {
        Some(t) => t.layers.clone(),
        None => p.roof_layers(roof),
    };
    l.into_iter().filter(|l| l.thickness > 1e-6).collect()
}

/// Gaubengeometrie; `None` bei unsinnigen Parametern (zu schmal, zu niedrig, Gaubendach steiler als das
/// Hauptdach bei der Schleppgaube, Punkt nicht in einer geneigten Fläche).
pub fn geometry(p: &Project, roof: &Roof, d: &Dormer) -> Option<DormerGeom> {
    let frame = frame(p, roof, d)?;
    if !(finite_pos(d.width) && d.width >= 0.4 && d.width <= 30.0 && finite_pos(d.front_height) && d.front_height <= 10.0) {
        return None;
    }
    let overhang = d.overhang.filter(|o| o.is_finite()).unwrap_or(0.15).clamp(0.0, 2.0);
    let main_thickness: f64 = p.roof_layers(roof).iter().map(|l| l.thickness.max(0.0)).sum();
    let roof_layers = roof_layers(p, roof, d);
    let roof_thickness: f64 = roof_layers.iter().map(|l| l.thickness).sum();
    let wall_layers = wall_layers(p, d);
    let wall_thickness: f64 = wall_layers.iter().map(|l| l.thickness).sum();
    if !(roof_thickness > 1e-3 && wall_thickness > 1e-3 && wall_thickness < d.width / 2.0 - 0.05) {
        return None;
    }
    let tm = frame.tan_main;
    let pitch = d.pitch_deg.filter(|v| v.is_finite());
    let tan_p = match d.kind {
        DormerKind::Flach => 0.0,
        DormerKind::Schlepp => match d.depth.filter(|v| v.is_finite() && *v > 0.1) {
            Some(depth) => (tm - d.front_height / depth).max(0.0),
            None => (pitch.unwrap_or(15.0).clamp(0.0, 80.0) * DEG).tan(),
        },
        _ => (pitch.unwrap_or(40.0).clamp(5.0, 75.0) * DEG).tan(),
    };
    if d.kind == DormerKind::Schlepp && tan_p >= tm - 0.02 {
        return None;
    }
    let z_e = frame.z_m0 + d.front_height;
    let mut g = DormerGeom { frame, kind: d.kind, width: d.width, front_height: d.front_height, overhang, tan_p, z_e, roof_layers, wall_layers, roof_thickness, wall_thickness, main_thickness, v_end: 0.0 };
    // Hinten weit genug, dass die ganze Gaubendach-Unterkante unter der Hauptdach-Unterkante endet.
    let main_v = main_thickness * (1.0 + tm * tm).sqrt();
    let top_extra = roof_thickness * (1.0 + tan_p * tan_p).sqrt();
    let v_end = match d.kind {
        DormerKind::Schlepp => (d.front_height + top_extra + main_v) / (tm - tan_p),
        DormerKind::Flach => (d.front_height + top_extra + main_v) / tm,
        _ => (d.front_height + d.width / 2.0 * tan_p + top_extra + main_v) / tm,
    };
    if !(v_end.is_finite() && v_end > 0.0 && v_end < 60.0) {
        return None;
    }
    g.v_end = v_end + 0.05;
    Some(g)
}

impl DormerGeom {
    /// Unterkante Gaubendach (lokal).
    pub fn under(&self, u: f64, v: f64) -> f64 {
        let hw = self.width / 2.0;
        match self.kind {
            DormerKind::Flach => self.z_e,
            DormerKind::Schlepp => self.z_e + v * self.tan_p,
            DormerKind::Sattel | DormerKind::Unknown => self.z_e + (hw - u.abs()) * self.tan_p,
            DormerKind::Walm => self.z_e + (hw - u.abs()).min(v) * self.tan_p,
        }
    }

    /// Lotrechter Abstand Oberkante − Unterkante (Gaubendach).
    pub fn roof_vertical(&self) -> f64 {
        self.roof_thickness * (1.0 + self.tan_p * self.tan_p).sqrt()
    }

    /// Flächen der Oberkante (lokal) mit Überstand, bis `v_end`.
    pub fn planes(&self) -> Vec<DormerPlane> {
        let (hw, o, ve, t) = (self.width / 2.0, self.overhang, self.v_end, self.tan_p);
        let top0 = self.z_e + self.roof_vertical();
        let rect = |u0: f64, u1: f64| vec![[u0, -o], [u1, -o], [u1, ve], [u0, ve]];
        match self.kind {
            DormerKind::Flach => vec![DormerPlane { ring: rect(-hw - o, hw + o), a: top0, bu: 0.0, bv: 0.0 }],
            DormerKind::Schlepp => vec![DormerPlane { ring: rect(-hw - o, hw + o), a: top0, bu: 0.0, bv: t }],
            DormerKind::Sattel | DormerKind::Unknown => vec![
                DormerPlane { ring: rect(-hw - o, 0.0), a: top0 + hw * t, bu: t, bv: 0.0 },
                DormerPlane { ring: rect(0.0, hw + o), a: top0 + hw * t, bu: -t, bv: 0.0 },
            ],
            DormerKind::Walm => vec![
                DormerPlane { ring: vec![[-hw - o, -o], [hw + o, -o], [0.0, hw]], a: top0, bu: 0.0, bv: t },
                DormerPlane { ring: vec![[0.0, hw], [hw + o, -o], [hw + o, ve], [0.0, ve]], a: top0 + hw * t, bu: -t, bv: 0.0 },
                DormerPlane { ring: vec![[-hw - o, -o], [0.0, hw], [0.0, ve], [-hw - o, ve]], a: top0 + hw * t, bu: t, bv: 0.0 },
            ],
        }
    }

    /// Höchster Punkt der Gaube (Oberkante Dach).
    pub fn z_max(&self) -> f64 {
        self.planes().iter().flat_map(|pl| pl.ring.iter().map(|q| pl.z(q[0], q[1])).collect::<Vec<_>>()).fold(f64::NEG_INFINITY, f64::max)
    }

    /// Lochrand hinten bei Breite `u`: Unterkante = Hauptdach-Oberkante.
    pub fn hole_v(&self, u: f64) -> f64 {
        let (tm, t, hf) = (self.frame.tan_main, self.tan_p, self.front_height);
        let hw = self.width / 2.0;
        match self.kind {
            DormerKind::Flach => hf / tm,
            DormerKind::Schlepp => hf / (tm - t),
            _ => (hf + (hw - u.abs()).max(0.0) * t) / tm,
        }
    }

    /// Loch im Hauptdach (lokal, Gegenuhrzeigersinn): Aussenkontur der Gaube bis zum Anschluss.
    pub fn hole(&self) -> Vec<P> {
        let hw = self.width / 2.0;
        match self.kind {
            DormerKind::Flach | DormerKind::Schlepp => vec![[-hw, 0.0], [hw, 0.0], [hw, self.hole_v(hw)], [-hw, self.hole_v(-hw)]],
            _ => vec![[-hw, 0.0], [hw, 0.0], [hw, self.hole_v(hw)], [0.0, self.hole_v(0.0)], [-hw, self.hole_v(-hw)]],
        }
    }

    /// Wandschichten: (Schicht-Index, Grundriss-Ring lokal). Stirn über die volle Breite, Wangen ab der
    /// Stirn-Innenseite bis an den Lochrand.
    pub fn wall_pieces(&self) -> Vec<(usize, Vec<P>)> {
        let hw = self.width / 2.0;
        let tw = self.wall_thickness;
        let mut out = Vec::new();
        let mut d = 0.0;
        for (k, l) in self.wall_layers.iter().enumerate() {
            let (a, b) = (d, d + l.thickness);
            d = b;
            // Stirn: Schicht k von v = a bis b.
            out.push((k, vec![[-hw, a], [hw, a], [hw, b], [-hw, b]]));
            // Wangen: Schicht k von |u| = hw − a bis hw − b.
            for s in [-1.0, 1.0] {
                let (u0, u1) = (s * (hw - b), s * (hw - a));
                let (v0, v1) = (self.hole_v(u0), self.hole_v(u1));
                if v0 <= tw + 1e-3 || v1 <= tw + 1e-3 {
                    continue;
                }
                let ring = vec![[u0, tw], [u1, tw], [u1, v1], [u0, v0]];
                out.push((k, if s < 0.0 { ring } else { vec![ring[1], ring[0], ring[3], ring[2]] }));
            }
        }
        out
    }

    /// Fenster-System in der Stirn: Mitte der Öffnung auf der Aussenseite, `ew` Breite, `eh` = oben,
    /// `n` = nach aussen.
    pub fn window_frame(&self, o: &Opening) -> Option<crate::opening_shape::HostFrame> {
        let (w, h) = (o.width, o.height);
        let hw = self.width / 2.0 - self.wall_thickness;
        let off = if o.position.is_finite() { o.position } else { 0.0 };
        let sill = if o.sill_height.is_finite() { o.sill_height.max(0.0) } else { 0.0 };
        if !(finite_pos(w) && finite_pos(h)) || off.abs() + w / 2.0 > hw + 1e-9 {
            return None;
        }
        let zc = self.frame.z_m0 + sill + h / 2.0;
        if zc + h / 2.0 > self.under(off - w / 2.0, 0.0).min(self.under(off + w / 2.0, 0.0)) + 1e-9 {
            return None;
        }
        let c = self.frame.world(off, 0.0, zc);
        let f = &self.frame;
        Some(crate::opening_shape::HostFrame {
            c,
            ew: [f.ew[0], f.ew[1], 0.0],
            eh: [0.0, 0.0, 1.0],
            n: [f.h[0], f.h[1], 0.0],
            thickness: self.wall_thickness,
            plane: None,
            host: 0,
            dormer: true,
        })
    }
}

/// Gaube `dormer_id` im Dach `roof_id` (Index des Dachs, Gaube).
pub fn find<'a>(p: &'a Project, roof_id: &str, dormer_id: &str) -> Option<(usize, &'a Roof, &'a Dormer)> {
    let (ri, roof) = p.roofs.as_deref()?.iter().enumerate().find(|(_, r)| r.id == roof_id)?;
    let d = roof.dormers.as_deref()?.iter().find(|d| d.id == dormer_id)?;
    Some((ri, roof, d))
}

/// Fenster in den Gauben eines Dachs (Index): (Öffnung, Gaube, System).
pub fn dormer_openings(p: &Project, roof_index: usize) -> Vec<(&Opening, &Dormer, crate::opening_shape::HostFrame)> {
    let Some(roof) = p.roofs.as_deref().and_then(|r| r.get(roof_index)) else { return Vec::new() };
    let mut out = Vec::new();
    for o in p.openings.as_deref().unwrap_or(&[]) {
        if o.host_roof_id.as_deref() != Some(roof.id.as_str()) {
            continue;
        }
        let Some(did) = o.host_dormer_id.as_deref() else { continue };
        let Some(d) = roof.dormers.as_deref().and_then(|v| v.iter().find(|d| d.id == did)) else { continue };
        if let Some(mut f) = geometry(p, roof, d).and_then(|g| g.window_frame(o)) {
            f.host = roof_index;
            out.push((o, d, f));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    pub(crate) fn gable_project() -> Project {
        serde_json::from_value(serde_json::json!({
            "id": "p", "name": "t", "lineStyles": [], "hatches": [], "components": [], "wallTypes": [],
            "drawingLevels": [], "layers": [], "walls": [], "drawings2d": [],
            "roofs": [{
                "id": "R1", "type": "roof", "floorId": "F", "categoryCode": "35",
                "outline": [{"x": 0, "y": 0}, {"x": 10, "y": 0}, {"x": 10, "y": 8}, {"x": 0, "y": 8}],
                "shape": "sattel", "pitchDeg": 45, "overhang": 0.5, "ridgeAxis": "x", "baseElevation": 3.0, "thickness": 0.3,
                "dormers": [{"id": "D1", "kind": "sattel", "position": {"x": 3, "y": 1.0}, "width": 2.4, "frontHeight": 1.6}]
            }]
        }))
        .unwrap()
    }

    #[test]
    fn frame_and_hole_on_gable_roof() {
        let p = gable_project();
        let roof = &p.roofs.as_ref().unwrap()[0];
        let d = &roof.dormers.as_ref().unwrap()[0];
        let g = geometry(&p, roof, d).expect("Gaube");
        // Südseite (y klein) fällt nach −y: h = (0, −1)
        assert!((g.frame.h[1] + 1.0).abs() < 1e-9 && g.frame.h[0].abs() < 1e-9);
        assert!((g.frame.tan_main - 1.0).abs() < 1e-9);
        // Hauptdach-Oberkante an der Stirn: Traufe 3.0 bei y = 0 (Überstand 0.5 ⇒ Rand bei −0.5).
        let zm = g.frame.z_m0;
        assert!(zm > 3.9 && zm < 4.6, "{zm}");
        // Lochrand an den Wangen = Stirnhöhe / tan P, am First weiter hinten.
        assert!((g.hole_v(1.2) - 1.6).abs() < 1e-9);
        assert!(g.hole_v(0.0) > g.hole_v(1.2));
        assert_eq!(g.hole().len(), 5);
        assert!(g.wall_pieces().len() == 3, "Stirn + zwei Wangen");
        assert_eq!(g.planes().len(), 2);
        // lokal ↔ Grundriss
        let q = g.frame.plan(0.5, 1.0);
        let l = g.frame.local(q[0], q[1]);
        assert!((l[0] - 0.5).abs() < 1e-12 && (l[1] - 1.0).abs() < 1e-12);
    }

    #[test]
    fn rejects_bad_parameters() {
        let mut p = gable_project();
        let set = |p: &mut Project, f: &dyn Fn(&mut Dormer)| f(&mut p.roofs.as_mut().unwrap()[0].dormers.as_mut().unwrap()[0]);
        set(&mut p, &|d| d.width = f64::NAN);
        let ok = |p: &Project| {
            let r = &p.roofs.as_ref().unwrap()[0];
            geometry(p, r, &r.dormers.as_ref().unwrap()[0]).is_some()
        };
        assert!(!ok(&p));
        set(&mut p, &|d| {
            d.width = 2.0;
            d.kind = DormerKind::Schlepp;
            d.pitch_deg = Some(50.0);
        });
        assert!(!ok(&p), "Schleppgaube steiler als das Hauptdach");
        set(&mut p, &|d| d.pitch_deg = Some(15.0));
        assert!(ok(&p));
        set(&mut p, &|d| d.position = Vec2 { x: 50.0, y: 50.0 });
        assert!(!ok(&p), "ausserhalb");
    }
}
