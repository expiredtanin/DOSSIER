//! [149] Baum als eigenes Objekt (`Project.trees`): Abmessungen mit Vorgaben, Kronenprofil nach Form
//! (rund, oval, säulenförmig, kegelförmig), Fusshöhe auf dem Gelände, 3D-Netz (Stamm-Zylinder + Krone als
//! Rotationskörper mit wenigen Polygonen), Schattenwerfer (Stamm-Prisma + Kronen-Punktwolke) und die
//! Silhouette für Schnitt/Ansicht. Das Grundriss-Symbol entsteht in `plan/trees.rs`.
//!
//! Lage: Fuss an `position` auf dem sichtbaren Gelände (inkl. Baugruben, wie der Schattenwurf [142]),
//! sonst auf der UK des Geschosses; dazu `baseOffset`. Höhen über dem Fuss: Kronenansatz `crownBase`,
//! Spitze `height`.

use crate::jsnum;
use crate::model::*;

/// Vorgaben (m), wenn ein Wert fehlt oder unsinnig ist.
pub const DEFAULT_TRUNK_DIAMETER: f64 = 0.3;
pub const DEFAULT_CROWN_DIAMETER: f64 = 5.0;
pub const DEFAULT_HEIGHT: f64 = 10.0;
pub const DEFAULT_CROWN_BASE: f64 = 2.5;
/// Ebene der Bäume (SIA-Ebenenliste).
pub const TREE_CATEGORY: &str = "13";
/// Präfix der Pick-Id im Feld `contextObjectId` der Plan-Primitive (`@` = keine Kontext-Element-Id).
pub const TREE_PICK_PREFIX: &str = "@tree:";

/// Stamm- und Kronenfarbe im 3D (sRGB 0–1).
pub const TRUNK_RGB: [f64; 3] = [0.42, 0.32, 0.22];
pub const CROWN_RGB: [f64; 3] = [0.45, 0.58, 0.33];
pub const CONIFER_RGB: [f64; 3] = [0.29, 0.45, 0.30];

/// Aufgelöste Abmessungen eines Baums in absoluten Höhen.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TreeGeom {
    /// Stammmitte.
    pub c: [f64; 2],
    /// Fuss (absolute Höhe).
    pub base: f64,
    pub trunk_r: f64,
    pub crown_r: f64,
    /// Kronenansatz und Spitze (absolute Höhen), `crown_bottom < top`.
    pub crown_bottom: f64,
    pub top: f64,
    pub shape: TreeShape,
}

fn pos(v: f64, d: f64) -> f64 {
    if v > 0.0 && v.is_finite() {
        v
    } else {
        d
    }
}

impl TreeGeom {
    /// Abmessungen des Baums mit Fuss `base`; `None` bei unbrauchbarer Lage.
    pub fn of(t: &Tree, base: f64) -> Option<TreeGeom> {
        if !(t.position.x.is_finite() && t.position.y.is_finite() && base.is_finite()) {
            return None;
        }
        let h = pos(t.height, DEFAULT_HEIGHT);
        let crown_r = pos(t.crown_diameter, DEFAULT_CROWN_DIAMETER) / 2.0;
        // Stamm nie dicker als die Krone.
        let trunk_r = jsnum::min(pos(t.trunk_diameter, DEFAULT_TRUNK_DIAMETER) / 2.0, crown_r * 0.8);
        // Kronenansatz zwischen 0 und 90 % der Höhe.
        let cb = if t.crown_base.is_finite() { t.crown_base.clamp(0.0, 0.9 * h) } else { jsnum::min(DEFAULT_CROWN_BASE, 0.5 * h) };
        Some(TreeGeom { c: [t.position.x, t.position.y], base, trunk_r, crown_r, crown_bottom: base + cb, top: base + h, shape: t.shape })
    }

    /// Kronenprofil als (z, r) von unten nach oben, `n` Abschnitte (≥ 2); an den Enden r = 0 (Pole).
    pub fn profile(&self, n: usize) -> Vec<(f64, f64)> {
        let n = n.max(2);
        let (zb, zt, r) = (self.crown_bottom, self.top, self.crown_r);
        let h = zt - zb;
        let at = |u: f64| zb + u * h;
        let half = |s: f64| -> f64 { (1.0 - s * s).max(0.0).sqrt() };
        match self.shape {
            TreeShape::Conical => {
                // Kegel: flache Unterseite (5 % der Kronenhöhe), dann gerade zur Spitze.
                vec![(zb, 0.0), (at(0.05), r), (at(0.5), r * 0.5 / 0.95), (zt, 0.0)]
            }
            _ => (0..=n)
                .map(|i| {
                    let u = i as f64 / n as f64;
                    let rr = match self.shape {
                        TreeShape::Oval => {
                            // Eiform: breiteste Stelle bei 40 % der Kronenhöhe.
                            let w = 0.4;
                            let s = if u < w { (u - w) / w } else { (u - w) / (1.0 - w) };
                            r * half(s)
                        }
                        TreeShape::Columnar => {
                            // Superellipse (Exponent 4): fast senkrechte Flanken, gerundete Enden.
                            let s = 2.0 * u - 1.0;
                            r * (1.0 - s.powi(4)).max(0.0).powf(0.25)
                        }
                        _ => r * half(2.0 * u - 1.0),
                    };
                    (at(u), if i == 0 || i == n { 0.0 } else { rr })
                })
                .collect(),
        }
    }

    /// Oberkante des Stamms: ein Stück in die Krone hinein (keine Lücke unter der Krone).
    pub fn trunk_top(&self) -> f64 {
        self.crown_bottom + 0.25 * (self.top - self.crown_bottom)
    }

    /// Stamm-Querschnitt als Ring (`n` Ecken, gegen den Uhrzeigersinn).
    pub fn trunk_ring(&self, n: usize) -> Vec<[f64; 2]> {
        circle(self.c, self.trunk_r, n)
    }

    /// Krone als Rotationskörper: Positionen (x, y, z) und Dreiecke (aussen gegen den Uhrzeigersinn).
    pub fn crown_mesh(&self, rings: usize, seg: usize) -> (Vec<f64>, Vec<u32>) {
        lathe(self.c, &self.profile(rings), seg)
    }

    /// Stamm als Prisma: Positionen und Dreiecke.
    pub fn trunk_mesh(&self, seg: usize) -> (Vec<f64>, Vec<u32>) {
        crate::columns3d::prism(&self.trunk_ring(seg), self.base, self.trunk_top())
    }

    /// Punkte der Krone (für den Schatten als konvexe Hülle der projizierten Punkte).
    pub fn crown_points(&self) -> Vec<[f64; 3]> {
        let (pos, _) = self.crown_mesh(8, 16);
        pos.chunks_exact(3).map(|q| [q[0], q[1], q[2]]).collect()
    }

    /// Silhouette in einer lotrechten Ebene: Umriss der Krone und des Stamms als (s, z), wobei `s` die
    /// Lage der Stammmitte entlang der Ebene ist.
    pub fn silhouette(&self, s: f64, n: usize) -> (Vec<[f64; 2]>, Vec<[f64; 2]>) {
        let prof = self.profile(n);
        let mut crown: Vec<[f64; 2]> = prof.iter().map(|&(z, r)| [s + r, z]).collect();
        crown.extend(prof.iter().rev().skip(1).take(prof.len().saturating_sub(2)).map(|&(z, r)| [s - r, z]));
        crown.dedup();
        let tr = self.trunk_r;
        let trunk = vec![[s - tr, self.base], [s + tr, self.base], [s + tr, self.crown_bottom], [s - tr, self.crown_bottom]];
        (crown, trunk)
    }
}

/// Kreis als Ring mit `n` Ecken (gegen den Uhrzeigersinn).
pub fn circle(c: [f64; 2], r: f64, n: usize) -> Vec<[f64; 2]> {
    (0..n)
        .map(|i| {
            let t = i as f64 / n as f64 * std::f64::consts::TAU;
            [c[0] + r * jsnum::cos(t), c[1] + r * jsnum::sin(t)]
        })
        .collect()
}

/// Rotationskörper um die lotrechte Achse durch `c` aus dem Profil (z, r); r = 0 an einem Ende = Pol.
pub fn lathe(c: [f64; 2], prof: &[(f64, f64)], seg: usize) -> (Vec<f64>, Vec<u32>) {
    let seg = seg.max(3);
    let mut pos: Vec<f64> = Vec::new();
    // Je Profilpunkt: Index des ersten Eckpunkts und ob Pol (ein Punkt).
    let mut rows: Vec<(u32, bool)> = Vec::new();
    for &(z, r) in prof {
        let start = (pos.len() / 3) as u32;
        if r <= 1e-9 {
            pos.extend([c[0], c[1], z]);
            rows.push((start, true));
        } else {
            for q in circle(c, r, seg) {
                pos.extend([q[0], q[1], z]);
            }
            rows.push((start, false));
        }
    }
    let mut idx: Vec<u32> = Vec::new();
    let s = seg as u32;
    for w in rows.windows(2) {
        let ((a0, pa), (b0, pb)) = (w[0], w[1]);
        for j in 0..s {
            let k = (j + 1) % s;
            let (a, b) = if pa { (a0, a0) } else { (a0 + j, a0 + k) };
            let (cc, d) = if pb { (b0, b0) } else { (b0 + k, b0 + j) };
            if a != b && b != cc {
                idx.extend([a, b, cc]);
            }
            if cc != d && a != d {
                idx.extend([a, cc, d]);
            }
        }
    }
    (pos, idx)
}

/// Fusshöhen aller Bäume (`Project.trees`, gleiche Reihenfolge): Gelände an der Stammmitte (sichtbares
/// Geländenetz inkl. Baugruben), sonst UK des Geschosses; plus `baseOffset`.
pub fn bases(p: &Project) -> Vec<f64> {
    let trees = p.trees.as_deref().unwrap_or(&[]);
    if trees.is_empty() {
        return Vec::new();
    }
    let site = crate::excavation::terrains(p).into_iter().find(|t| t.hidden != Some(true)).map(|t| crate::excavation::site_terrain(p, t)).filter(|st| !st.current().tris.is_empty());
    let idx = site.as_ref().map(|st| (crate::terrain::TinIndex::new(st.current()), st.datum));
    trees
        .iter()
        .map(|t| {
            let floor = p.floor(&t.floor_id).map_or(0.0, |f| f.base_elevation.unwrap_or(0.0));
            let ground = idx.as_ref().and_then(|(i, datum)| i.z_at(t.position.x, t.position.y).map(|z| z - datum)).filter(|z| z.is_finite());
            ground.unwrap_or(floor) + t.base_offset.filter(|o| o.is_finite()).unwrap_or(0.0)
        })
        .collect()
}

/// Abmessungen aller darstellbaren Bäume mit ihrem Index in `Project.trees`.
pub fn geoms(p: &Project) -> Vec<(usize, TreeGeom)> {
    let b = bases(p);
    p.trees.as_deref().unwrap_or(&[]).iter().zip(b).enumerate().filter_map(|(i, (t, base))| TreeGeom::of(t, base).map(|g| (i, g))).collect()
}

/// Stamm- und Kronenfarbe eines Baums im 3D.
pub fn colors(t: &Tree) -> ([f64; 3], [f64; 3]) {
    (TRUNK_RGB, if t.foliage == TreeFoliage::Conifer { CONIFER_RGB } else { CROWN_RGB })
}

/// Bezeichnung (Objekt-Info, IFC): Art-Name, sonst „Baum".
pub fn label(t: &Tree) -> String {
    t.species.as_deref().map(str::trim).filter(|s| !s.is_empty()).map_or_else(|| "Baum".to_string(), str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tree(shape: &str) -> Tree {
        serde_json::from_value(serde_json::json!({
            "id": "t", "type": "tree", "floorId": "eg", "categoryCode": "13", "position": {"x": 1, "y": 2},
            "trunkDiameter": 0.4, "crownDiameter": 6, "crownBase": 3, "height": 12, "shape": shape,
            "status": "existing", "foliage": "deciduous"
        }))
        .unwrap()
    }

    /// Volumen eines geschlossenen Netzes (Divergenzsatz), positiv bei Aussennormalen.
    fn volume(pos: &[f64], idx: &[u32]) -> f64 {
        let p = |i: u32| [pos[i as usize * 3], pos[i as usize * 3 + 1], pos[i as usize * 3 + 2]];
        idx.chunks_exact(3)
            .map(|t| {
                let (a, b, c) = (p(t[0]), p(t[1]), p(t[2]));
                (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6.0
            })
            .sum()
    }

    #[test]
    fn modell_mit_vorgaben_und_hin_und_zurueck() {
        let t = tree("oval");
        assert_eq!(t.shape, TreeShape::Oval);
        let back: Tree = serde_json::from_value(serde_json::to_value(&t).unwrap()).unwrap();
        assert_eq!(back, t);
        // Fehlende/unsinnige Werte: Vorgaben.
        let mut u = t.clone();
        u.height = f64::NAN;
        u.crown_diameter = -1.0;
        u.trunk_diameter = 0.0;
        u.crown_base = 99.0;
        let g = TreeGeom::of(&u, 0.0).unwrap();
        assert_eq!(g.top, DEFAULT_HEIGHT);
        assert_eq!(g.crown_r, DEFAULT_CROWN_DIAMETER / 2.0);
        assert_eq!(g.trunk_r, DEFAULT_TRUNK_DIAMETER / 2.0);
        assert!((g.crown_bottom - 0.9 * DEFAULT_HEIGHT).abs() < 1e-12);
        u.position.x = f64::NAN;
        assert!(TreeGeom::of(&u, 0.0).is_none());
        // Unbekannte Form/Bestand lesen sich ohne Fehler.
        let w: Tree = serde_json::from_value(serde_json::json!({"id": "x", "shape": "weide", "status": "?"})).unwrap();
        assert_eq!(w.shape, TreeShape::Unknown);
    }

    #[test]
    fn netz_geschlossen_aussen_und_flach() {
        for shape in ["round", "oval", "columnar", "conical"] {
            let g = TreeGeom::of(&tree(shape), 1.0).unwrap();
            let (pos, idx) = g.crown_mesh(8, 12);
            assert!(crate::wall_mesh_cut::is_watertight(&pos, &idx, 1e-9), "{shape}: Krone nicht dicht");
            let v = volume(&pos, &idx);
            assert!(v > 0.0, "{shape}: Krone innen nach aussen ({v})");
            // Niedrige Polygonzahl.
            assert!(idx.len() / 3 <= 200, "{shape}: {} Dreiecke", idx.len() / 3);
            // Ausdehnung: Kronenradius, Kronenansatz bis Spitze.
            let zs: Vec<f64> = pos.chunks_exact(3).map(|q| q[2]).collect();
            assert!((zs.iter().cloned().fold(f64::INFINITY, f64::min) - 4.0).abs() < 1e-9);
            assert!((zs.iter().cloned().fold(f64::NEG_INFINITY, f64::max) - 13.0).abs() < 1e-9);
            let rmax = pos.chunks_exact(3).map(|q| (q[0] - 1.0).hypot(q[1] - 2.0)).fold(0.0, f64::max);
            assert!(rmax <= 3.0 + 1e-9 && rmax > 2.5, "{shape}: {rmax}");
            let (tp, ti) = g.trunk_mesh(8);
            assert!(volume(&tp, &ti).abs() > 0.0);
        }
        // Kegel: Volumen ≈ π r² h / 3 (unten flach).
        let g = TreeGeom::of(&tree("conical"), 0.0).unwrap();
        let (pos, idx) = g.crown_mesh(8, 48);
        let v = volume(&pos, &idx);
        let cone = std::f64::consts::PI * 9.0 * 9.0 / 3.0;
        assert!((v / cone - 1.0).abs() < 0.1, "{v} vs {cone}");
    }

    #[test]
    fn silhouette_nach_form() {
        let g = TreeGeom::of(&tree("columnar"), 0.0).unwrap();
        let (crown, trunk) = g.silhouette(5.0, 16);
        let xs = |r: &[[f64; 2]]| (r.iter().map(|q| q[0]).fold(f64::INFINITY, f64::min), r.iter().map(|q| q[0]).fold(f64::NEG_INFINITY, f64::max));
        let (a, b) = xs(&crown);
        assert!((a - 2.0).abs() < 1e-6 && (b - 8.0).abs() < 1e-6, "{a} {b}");
        assert!((xs(&trunk).0 - 4.8).abs() < 1e-12);
        // Säule ist auf halber Höhe zwischen Viertel und Dreiviertel fast voll breit, die Kugel nicht.
        let width_at = |g: &TreeGeom, u: f64| {
            let z = g.crown_bottom + u * (g.top - g.crown_bottom);
            let pr = g.profile(64);
            pr.windows(2).find(|w| w[0].0 <= z && z <= w[1].0).map(|w| w[0].1.max(w[1].1)).unwrap()
        };
        let round = TreeGeom::of(&tree("round"), 0.0).unwrap();
        assert!(width_at(&g, 0.25) > 0.95 * 3.0 && width_at(&round, 0.25) < 0.9 * 3.0);
    }
}
