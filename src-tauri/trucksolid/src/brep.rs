// Echte B-Rep-Volumenkörper über truck (0.6): Extrusion (mit Löchern), Rotation,
// Loft, Grundkörper, Boolesche Operationen auf B-Rep-Ebene (truck-shapeops) sowie
// STEP-Export/-Import (truck-stepio). Ergebnisse werden mit truck-meshalgo zu
// Dreiecks-Meshes tesselliert (kompatibel mit `render3d::MeshInput`).
//
// Koordinaten: Modell-Meter, Z = Höhe (wie `lib.rs`). Alle Eingaben kommen als
// serde-Spezifikation ({@link SolidSpec}), damit TS ganze Bäume (Boolean über
// Extrusionen …) in EINEM Aufruf beschreiben kann.
//
// Boolesche B-Rep-Operationen sind upstream nur bei Körpern in allgemeiner Lage
// robust: bündige/koinzidente Flächen liefern `None` (s. `bool_op`) — dafür bleibt
// die Mesh-Ebenen-CSG (`boolean.rs`, csgrs) der Gebäude-Standardweg.

use serde::{Deserialize, Serialize};
use std::f64::consts::PI;
use truck_meshalgo::prelude::*;
use truck_modeling::*;
use truck_shapeops::{and, or};

use crate::MeshOutput;

/// `truck_modeling::*` bringt ein eigenes (einparametriges) `Result` mit — hier das std-Result.
type Res<T> = std::result::Result<T, String>;

/// Toleranz der B-Rep-Booleans (Meter).
const BOOL_TOL: f64 = 0.005;

/// Ein Loft-Schnitt: Höhe `z` + geschlossener Ring [x0,y0,x1,y1,…] (alle Schnitte
/// eines Lofts mit gleicher Punktanzahl).
#[derive(Deserialize, Clone, Debug)]
pub struct LoftSection {
    pub z: f64,
    pub points: Vec<f64>,
}

#[derive(Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum BoolKind {
    Union,
    Difference,
    Intersection,
}

fn default_angle() -> f64 {
    360.0
}

/// Beschreibung eines Volumenkörpers.
#[derive(Deserialize, Clone, Debug)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SolidSpec {
    /// Prisma: Außenring + beliebig viele Löcher, +Z um `height`.
    Extrude {
        points: Vec<f64>,
        #[serde(default)]
        holes: Vec<Vec<f64>>,
        height: f64,
        #[serde(default)]
        z0: f64,
        /// Eckenradius (Meter) der Aussenkontur: jede Ecke wird durch einen echten
        /// Kreisbogen (exakte Zylinderfläche, auch im STEP) verrundet. 0 = scharf.
        #[serde(default, rename = "cornerRadius")]
        corner_radius: f64,
        /// Fase (Meter) an den Ecken der Aussenkontur: gerade Abschrägung im Abstand `chamfer`
        /// von der Ecke. 0 = scharf. Vor dem Eckenradius angewandt (beides zugleich: Radius
        /// auf der gefasten Kontur).
        #[serde(default)]
        chamfer: f64,
    },
    /// Prisma in einer beliebigen Ebene: Ring/Löcher in (u,v)-Koordinaten, platziert über
    /// `origin` + `uAxis`/`vAxis` (3D-Richtungen), extrudiert um `depth` entlang u×v.
    /// So entstehen Wände mit Fenster-/Türöffnungen OHNE Boolean (Wandansicht als Profil).
    ExtrudePlane {
        points: Vec<f64>,
        #[serde(default)]
        holes: Vec<Vec<f64>>,
        origin: [f64; 3],
        #[serde(rename = "uAxis")]
        u_axis: [f64; 3],
        #[serde(rename = "vAxis")]
        v_axis: [f64; 3],
        depth: f64,
    },
    /// Rotationskörper: Profil = geschlossener Ring aus (r, z)-Paaren in der
    /// Halbebene r ≥ 0, gedreht um die Z-Achse durch (cx, cy).
    Revolve {
        profile: Vec<f64>,
        #[serde(default)]
        cx: f64,
        #[serde(default)]
        cy: f64,
        #[serde(default = "default_angle", rename = "angleDeg")]
        angle_deg: f64,
    },
    /// Loft (Übergang) zwischen ≥ 2 Ringen gleicher Punktanzahl, mit ebenen Deckeln.
    Loft { sections: Vec<LoftSection> },
    Cuboid { min: [f64; 3], max: [f64; 3] },
    Sphere { center: [f64; 3], r: f64 },
    Cylinder { cx: f64, cy: f64, z0: f64, r: f64, height: f64 },
    Cone { cx: f64, cy: f64, z0: f64, r: f64, height: f64 },
    Torus { center: [f64; 3], major: f64, minor: f64 },
    /// Boolesche Operation zweier Körper (B-Rep).
    Boolean {
        op: BoolKind,
        a: Box<SolidSpec>,
        b: Box<SolidSpec>,
    },
    /// Verschiebung eines Körpers.
    Translate { v: [f64; 3], solid: Box<SolidSpec> },
    /// Affine Abbildung (Drehung, gleichmässige Skalierung, Spiegelung): 3×4-Matrix
    /// zeilenweise `[a b c tx, d e f ty, g h i tz]`. Bei negativer Determinante
    /// (Spiegelung) wird die Orientierung der Hülle umgekehrt.
    Transform { m: [f64; 12], solid: Box<SolidSpec> },
}

fn pairs(flat: &[f64]) -> Res<Vec<(f64, f64)>> {
    if flat.len() % 2 != 0 {
        return Err("Punktliste muss x/y-Paare enthalten".into());
    }
    let mut v: Vec<(f64, f64)> = flat.chunks(2).map(|c| (c[0], c[1])).collect();
    if v.len() >= 2 {
        let (f, l) = (v[0], *v.last().unwrap());
        if (f.0 - l.0).abs() < 1e-10 && (f.1 - l.1).abs() < 1e-10 {
            v.pop();
        }
    }
    if v.len() < 3 {
        return Err("mindestens 3 eindeutige Punkte".into());
    }
    Ok(v)
}

fn ring_wire(ring: &[(f64, f64)], z: f64) -> Wire {
    let verts: Vec<Vertex> = ring
        .iter()
        .map(|&(x, y)| builder::vertex(Point3::new(x, y, z)))
        .collect();
    let n = verts.len();
    (0..n)
        .map(|i| builder::line(&verts[i], &verts[(i + 1) % n]))
        .collect()
}

fn signed_area(ring: &[(f64, f64)]) -> f64 {
    let n = ring.len();
    (0..n)
        .map(|i| {
            let (a, b) = (ring[i], ring[(i + 1) % n]);
            a.0 * b.1 - b.0 * a.1
        })
        .sum::<f64>()
        / 2.0
}

/// Prisma aus Ring + Löchern. Außenring wird CCW, Löcher CW ausgerichtet.
/// Aussenring mit verrundeten Ecken als Wire: Linien + Kreisbögen (`circle_arc`). Der
/// Radius wird je Ecke auf die Hälfte der kürzeren Nachbarkante begrenzt; fast gestreckte
/// Ecken bleiben scharf.
fn rounded_ring_wire(ring: &[(f64, f64)], radius: f64, z: f64) -> Wire {
    let n = ring.len();
    let p = |i: usize| Point3::new(ring[i % n].0, ring[i % n].1, z);
    // Je Ecke: (Tangentenpunkt Eingang, Bogenmitte, Tangentenpunkt Ausgang) oder None (scharf).
    let mut corners: Vec<Option<(Point3, Point3, Point3)>> = Vec::with_capacity(n);
    for i in 0..n {
        let v = p(i);
        let (p0, p1) = (p(i + n - 1), p(i + 1));
        let (a, b) = (p0 - v, p1 - v);
        let (la, lb) = (a.magnitude(), b.magnitude());
        if la < 1e-9 || lb < 1e-9 {
            corners.push(None);
            continue;
        }
        let (d0, d1) = (a / la, b / lb);
        let cos_t = d0.dot(d1).clamp(-1.0, 1.0);
        let theta = cos_t.acos(); // Winkel zwischen den Kanten, 0..π
        if theta > PI - 1e-3 || theta < 1e-3 {
            corners.push(None); // gestreckt oder spitzenlos
            continue;
        }
        let tan_half = (theta / 2.0).tan();
        let t = (radius / tan_half).min(la / 2.0).min(lb / 2.0);
        let r = t * tan_half;
        let bis = (d0 + d1).normalize();
        let center = v + bis * (r / (theta / 2.0).sin());
        let mid = center - bis * r;
        corners.push(Some((v + d0 * t, mid, v + d1 * t)));
    }
    let mut wire = Wire::new();
    // Vertex-Kette: Ausgang der Ecke i → Eingang der Ecke i+1.
    let mut starts: Vec<Vertex> = Vec::new(); // Eingangs-Vertex je Ecke
    let mut ends: Vec<Vertex> = Vec::new(); // Ausgangs-Vertex je Ecke
    for (i, c) in corners.iter().enumerate() {
        match c {
            Some((a, _, b)) => {
                starts.push(builder::vertex(*a));
                ends.push(builder::vertex(*b));
            }
            None => {
                let v = builder::vertex(p(i));
                starts.push(v.clone());
                ends.push(v);
            }
        }
    }
    for i in 0..n {
        if let Some((_, m, _)) = corners[i] {
            wire.push_back(builder::circle_arc(&starts[i], &ends[i], m));
        }
        let next = (i + 1) % n;
        if !Vertex::eq(&ends[i], &starts[next]) {
            wire.push_back(builder::line(&ends[i], &starts[next]));
        }
    }
    wire
}

/// Ecken der Kontur im Abstand `d` abschrägen (je Ecke auf die Hälfte der kürzeren Kante begrenzt).
fn chamfer_ring(ring: &[(f64, f64)], d: f64) -> Vec<(f64, f64)> {
    let n = ring.len();
    let mut out = Vec::with_capacity(n * 2);
    for i in 0..n {
        let (p0, v, p1) = (ring[(i + n - 1) % n], ring[i], ring[(i + 1) % n]);
        let (a, b) = ((p0.0 - v.0, p0.1 - v.1), (p1.0 - v.0, p1.1 - v.1));
        let (la, lb) = (a.0.hypot(a.1), b.0.hypot(b.1));
        if la < 1e-9 || lb < 1e-9 {
            out.push(v);
            continue;
        }
        let cos_t = (a.0 * b.0 + a.1 * b.1) / (la * lb);
        if cos_t < -1.0 + 1e-6 {
            out.push(v); // gestreckt: keine Ecke
            continue;
        }
        let t = d.min(la / 2.0).min(lb / 2.0);
        out.push((v.0 + a.0 / la * t, v.1 + a.1 / la * t));
        out.push((v.0 + b.0 / lb * t, v.1 + b.1 / lb * t));
    }
    out
}

fn extrude(
    points: &[f64],
    holes: &[Vec<f64>],
    height: f64,
    z0: f64,
    corner_radius: f64,
    chamfer: f64,
) -> Res<Solid> {
    if height <= 0.0 {
        return Err("height muss > 0 sein".into());
    }
    let mut outer = pairs(points)?;
    if signed_area(&outer) < 0.0 {
        outer.reverse();
    }
    if chamfer > 1e-6 {
        outer = chamfer_ring(&outer, chamfer);
    }
    let mut wires = vec![if corner_radius > 1e-6 {
        rounded_ring_wire(&outer, corner_radius, z0)
    } else {
        ring_wire(&outer, z0)
    }];
    for h in holes {
        let mut hole = pairs(h)?;
        if signed_area(&hole) > 0.0 {
            hole.reverse();
        }
        wires.push(ring_wire(&hole, z0));
    }
    let face = builder::try_attach_plane(&wires).map_err(|e| format!("{e}"))?;
    Ok(builder::tsweep(&face, Vector3::new(0.0, 0.0, height)))
}

/// Prisma in beliebiger Ebene (s. {@link SolidSpec::ExtrudePlane}).
fn extrude_plane(
    points: &[f64],
    holes: &[Vec<f64>],
    origin: [f64; 3],
    u: [f64; 3],
    v: [f64; 3],
    depth: f64,
) -> Res<Solid> {
    if depth == 0.0 {
        return Err("depth darf nicht 0 sein".into());
    }
    let (uu, vv) = (Vector3::new(u[0], u[1], u[2]), Vector3::new(v[0], v[1], v[2]));
    let normal = uu.cross(vv);
    if normal.magnitude() < 1e-9 {
        return Err("uAxis und vAxis dürfen nicht parallel sein".into());
    }
    let o = Point3::new(origin[0], origin[1], origin[2]);
    let place = |r: &[(f64, f64)]| -> Wire {
        let verts: Vec<Vertex> = r
            .iter()
            .map(|&(a, b)| builder::vertex(o + uu * a + vv * b))
            .collect();
        let n = verts.len();
        (0..n).map(|i| builder::line(&verts[i], &verts[(i + 1) % n])).collect()
    };
    let mut outer = pairs(points)?;
    if signed_area(&outer) < 0.0 {
        outer.reverse(); // CCW in (u,v) ⇒ Flächennormale = u×v
    }
    let mut wires = vec![place(&outer)];
    for h in holes {
        let mut hole = pairs(h)?;
        if signed_area(&hole) > 0.0 {
            hole.reverse();
        }
        wires.push(place(&hole));
    }
    let face = builder::try_attach_plane(&wires).map_err(|e| format!("{e}"))?;
    let dir = normal.normalize() * depth;
    Ok(builder::tsweep(&face, dir))
}

fn revolve(profile: &[f64], cx: f64, cy: f64, angle_deg: f64) -> Res<Solid> {
    let ring = pairs(profile)?;
    if ring.iter().any(|&(r, _)| r < -1e-9) {
        return Err("Profil muss in der Halbebene r >= 0 liegen".into());
    }
    let angle = angle_deg.to_radians().clamp(1e-3, 2.0 * PI);
    let n = ring.len();
    // Volle Drehung eines Profils mit Kante AUF der Achse (Kegel, Kugel, Zylinder …): die
    // Achskante entfällt, `cone` dreht den offenen Rest und lässt keine entarteten Flächen
    // zurück (sonst gilt der STEP-Körper in anderen CAD-Systemen als ungültig).
    let on_axis = |i: usize| ring[i].0.abs() < 1e-9 && ring[(i + 1) % n].0.abs() < 1e-9;
    if angle >= 2.0 * PI - 1e-6 {
        let axis_edges: Vec<usize> = (0..n).filter(|&i| on_axis(i)).collect();
        if axis_edges.len() == 1 {
            let k = axis_edges[0];
            // Pfad von ring[k+1] über … bis ring[k] (zyklisch), ohne die Achskante.
            let path: Vec<(f64, f64)> = (0..n).map(|j| ring[(k + 1 + j) % n]).collect();
            let verts: Vec<Vertex> = path
                .iter()
                .map(|&(r, z)| builder::vertex(Point3::new(r, 0.0, z)))
                .collect();
            let wire: Wire = (0..verts.len() - 1)
                .map(|i| builder::line(&verts[i], &verts[i + 1]))
                .collect();
            let shell = builder::cone(&wire, Vector3::unit_z(), Rad(2.0 * PI));
            let s = Solid::new(vec![shell]);
            return Ok(builder::translated(&s, Vector3::new(cx, cy, 0.0)));
        }
    }
    let verts: Vec<Vertex> = ring
        .iter()
        .map(|&(r, z)| builder::vertex(Point3::new(r, 0.0, z)))
        .collect();
    let wire: Wire = (0..n)
        .map(|i| builder::line(&verts[i], &verts[(i + 1) % n]))
        .collect();
    let face = builder::try_attach_plane(&[wire]).map_err(|e| format!("{e}"))?;
    let s = builder::rsweep(&face, Point3::origin(), Vector3::unit_z(), Rad(angle));
    Ok(builder::translated(&s, Vector3::new(cx, cy, 0.0)))
}

fn loft(sections: &[LoftSection]) -> Res<Solid> {
    if sections.len() < 2 {
        return Err("Loft braucht mindestens 2 Schnitte".into());
    }
    let mut rings: Vec<(f64, Vec<(f64, f64)>)> = Vec::new();
    for s in sections {
        let mut r = pairs(&s.points)?;
        if signed_area(&r) < 0.0 {
            r.reverse();
        }
        rings.push((s.z, r));
    }
    let n = rings[0].1.len();
    if rings.iter().any(|(_, r)| r.len() != n) {
        return Err("alle Loft-Schnitte brauchen dieselbe Punktanzahl".into());
    }
    let wires: Vec<Wire> = rings.iter().map(|(z, r)| ring_wire(r, *z)).collect();
    let mut shell = Shell::new();
    for w in wires.windows(2) {
        let part = builder::try_wire_homotopy(&w[0], &w[1]).map_err(|e| format!("{e}"))?;
        shell.extend(part);
    }
    let bottom = builder::try_attach_plane(&[wires[0].clone()]).map_err(|e| format!("{e}"))?;
    let top = builder::try_attach_plane(&[wires[wires.len() - 1].clone()])
        .map_err(|e| format!("{e}"))?;
    // Orientierung probieren: eine der vier Kappen-Kombinationen ergibt einen
    // geschlossenen, orientierbaren Rand.
    for (inv_b, inv_t) in [(true, false), (false, true), (false, false), (true, true)] {
        let mut sh = shell.clone();
        let mut b = bottom.clone();
        let mut t = top.clone();
        if inv_b {
            b.invert();
        }
        if inv_t {
            t.invert();
        }
        sh.push(b);
        sh.push(t);
        if let Ok(s) = Solid::try_new(vec![sh]) {
            return Ok(s);
        }
    }
    Err("Loft ergibt keinen geschlossenen Körper".into())
}

fn sphere(center: [f64; 3], r: f64) -> Res<Solid> {
    if r <= 0.0 {
        return Err("r muss > 0 sein".into());
    }
    // Wie in der truck-Doku: Halbkreis um X (Pole auf der Y-Achse), dann um Y gedreht.
    let v = builder::vertex(Point3::new(0.0, r, 0.0));
    let half: Wire = builder::rsweep(&v, Point3::origin(), Vector3::unit_x(), Rad(PI));
    // `cone` entfernt die entarteten Pol-Kanten (rsweep würde sie als Kanten behalten).
    let shell: Shell = builder::cone(&half, Vector3::unit_y(), Rad(2.0 * PI));
    // Pole sind entartete Kanten: `try_new` lehnt solche Schalen ab, `new` (wie in der truck-Doku) nicht.
    let s = Solid::new(vec![shell]);
    Ok(builder::translated(&s, Vector3::new(center[0], center[1], center[2])))
}

fn cylinder(cx: f64, cy: f64, z0: f64, r: f64, height: f64) -> Res<Solid> {
    if r <= 0.0 || height <= 0.0 {
        return Err("r und height müssen > 0 sein".into());
    }
    let v = builder::vertex(Point3::new(r, 0.0, 0.0));
    let circle: Wire = builder::rsweep(&v, Point3::origin(), Vector3::unit_z(), Rad(2.0 * PI));
    let face = builder::try_attach_plane(&[circle]).map_err(|e| format!("{e}"))?;
    let s = builder::tsweep(&face, Vector3::new(0.0, 0.0, height));
    Ok(builder::translated(&s, Vector3::new(cx, cy, z0)))
}

fn cone(cx: f64, cy: f64, z0: f64, r: f64, height: f64) -> Res<Solid> {
    // Profil: (0,0) – (r,0) – (0,h), gedreht um Z.
    let s = revolve(&[0.0, 0.0, r, 0.0, 0.0, height], 0.0, 0.0, 360.0)?;
    Ok(builder::translated(&s, Vector3::new(cx, cy, z0)))
}

fn torus(center: [f64; 3], major: f64, minor: f64) -> Res<Solid> {
    if minor <= 0.0 || major <= minor {
        return Err("Torus: major > minor > 0".into());
    }
    let v = builder::vertex(Point3::new(major + minor, 0.0, 0.0));
    let circle: Wire = builder::rsweep(
        &v,
        Point3::new(major, 0.0, 0.0),
        Vector3::unit_y(),
        Rad(2.0 * PI),
    );
    let face = builder::try_attach_plane(&[circle]).map_err(|e| format!("{e}"))?;
    let s: Solid = builder::rsweep(&face, Point3::origin(), Vector3::unit_z(), Rad(2.0 * PI));
    Ok(builder::translated(&s, Vector3::new(center[0], center[1], center[2])))
}

fn cuboid(min: [f64; 3], max: [f64; 3]) -> Res<Solid> {
    if (0..3).any(|i| max[i] - min[i] <= 0.0) {
        return Err("Quader: max muss > min sein".into());
    }
    let v = builder::vertex(Point3::new(min[0], min[1], min[2]));
    let e = builder::tsweep(&v, Vector3::new(max[0] - min[0], 0.0, 0.0));
    let f = builder::tsweep(&e, Vector3::new(0.0, max[1] - min[1], 0.0));
    Ok(builder::tsweep(&f, Vector3::new(0.0, 0.0, max[2] - min[2])))
}

/// Boolesche Operation auf B-Rep-Ebene (truck-shapeops). `None`-Ergebnis des
/// Upstream (typisch bei koinzidenten Flächen) wird zu einer Fehlermeldung.
pub fn bool_op(a: &Solid, b: &Solid, op: BoolKind) -> Res<Solid> {
    let r = match op {
        BoolKind::Union => or(a, b, BOOL_TOL),
        BoolKind::Intersection => and(a, b, BOOL_TOL),
        BoolKind::Difference => {
            let mut inv = b.clone();
            inv.not();
            and(a, &inv, BOOL_TOL)
        }
    };
    r.ok_or_else(|| {
        "B-Rep-Boolean fehlgeschlagen (koinzidente/entartete Flächen — Schneidkörper überstehen lassen)"
            .to_string()
    })
}

/// Baut den Volumenkörper aus der Spezifikation.
pub fn build_solid(spec: &SolidSpec) -> Res<Solid> {
    match spec {
        SolidSpec::Extrude { points, holes, height, z0, corner_radius, chamfer } => {
            extrude(points, holes, *height, *z0, *corner_radius, *chamfer)
        }
        SolidSpec::ExtrudePlane { points, holes, origin, u_axis, v_axis, depth } => {
            extrude_plane(points, holes, *origin, *u_axis, *v_axis, *depth)
        }
        SolidSpec::Revolve { profile, cx, cy, angle_deg } => revolve(profile, *cx, *cy, *angle_deg),
        SolidSpec::Loft { sections } => loft(sections),
        SolidSpec::Cuboid { min, max } => cuboid(*min, *max),
        SolidSpec::Sphere { center, r } => sphere(*center, *r),
        SolidSpec::Cylinder { cx, cy, z0, r, height } => cylinder(*cx, *cy, *z0, *r, *height),
        SolidSpec::Cone { cx, cy, z0, r, height } => cone(*cx, *cy, *z0, *r, *height),
        SolidSpec::Torus { center, major, minor } => torus(*center, *major, *minor),
        SolidSpec::Boolean { op, a, b } => bool_op(&build_solid(a)?, &build_solid(b)?, *op),
        SolidSpec::Transform { m, solid } => {
            let mat = Matrix4::new(
                m[0], m[4], m[8], 0.0, m[1], m[5], m[9], 0.0, m[2], m[6], m[10], 0.0, m[3], m[7], m[11], 1.0,
            );
            let det = m[0] * (m[5] * m[10] - m[6] * m[9]) - m[1] * (m[4] * m[10] - m[6] * m[8])
                + m[2] * (m[4] * m[9] - m[5] * m[8]);
            let mut out = builder::transformed(&build_solid(solid)?, mat);
            if det < 0.0 {
                out.not();
            }
            Ok(out)
        }
        SolidSpec::Translate { v, solid } => {
            Ok(builder::translated(&build_solid(solid)?, Vector3::new(v[0], v[1], v[2])))
        }
    }
}

/// Tesselliert ein B-Rep-Mesh (Polygon-Mesh → Dreiecke) mit Sehnenabweichung `tol`.
pub fn mesh_of_polygon(poly: &PolygonMesh) -> MeshOutput {
    let positions: Vec<f32> = poly
        .positions()
        .iter()
        .flat_map(|p| [p.x as f32, p.y as f32, p.z as f32])
        .collect();
    let mut indices: Vec<u32> = Vec::new();
    for t in poly.tri_faces() {
        indices.extend_from_slice(&[t[0].pos as u32, t[1].pos as u32, t[2].pos as u32]);
    }
    for q in poly.quad_faces() {
        indices.extend_from_slice(&[q[0].pos as u32, q[1].pos as u32, q[2].pos as u32]);
        indices.extend_from_slice(&[q[0].pos as u32, q[2].pos as u32, q[3].pos as u32]);
    }
    for f in poly.other_faces() {
        for i in 1..f.len().saturating_sub(1) {
            indices.extend_from_slice(&[f[0].pos as u32, f[i].pos as u32, f[i + 1].pos as u32]);
        }
    }
    MeshOutput { positions, indices }
}

pub fn mesh_of_solid(solid: &Solid, tol: f64) -> MeshOutput {
    let poly = solid.triangulation(tol.max(1e-4)).to_polygon();
    mesh_of_polygon(&poly)
}

/// Spezifikation → Mesh. Scheitert eine B-Rep-Boolean (koinzidente Flächen), wird die
/// Operation auf Mesh-Ebene (csgrs, `boolean.rs`) wiederholt — das Ergebnis ist dann ein
/// reines Dreiecks-Mesh (ohne exakte B-Rep-Flächen; der STEP-Export dieses Körpers entfällt).
pub fn solid_mesh_core(spec: &SolidSpec, tol: f64) -> Res<MeshOutput> {
    match spec {
        SolidSpec::Boolean { op, a, b } => {
            if let (Ok(sa), Ok(sb)) = (build_solid(a), build_solid(b)) {
                if let Ok(s) = bool_op(&sa, &sb, *op) {
                    return Ok(mesh_of_solid(&s, tol));
                }
            }
            let (ma, mb) = (solid_mesh_core(a, tol)?, solid_mesh_core(b, tol)?);
            let f64s = |v: &[f32]| v.iter().map(|x| *x as f64).collect::<Vec<f64>>();
            let op_name = match op {
                BoolKind::Union => "union",
                BoolKind::Difference => "difference",
                BoolKind::Intersection => "intersection",
            };
            let r = crate::boolean::boolean_mesh_core(
                &f64s(&ma.positions),
                &ma.indices,
                &f64s(&mb.positions),
                &mb.indices,
                op_name,
            )?;
            Ok(MeshOutput { positions: r.positions, indices: r.indices })
        }
        SolidSpec::Translate { v, solid } if matches!(**solid, SolidSpec::Boolean { .. }) => {
            // Boolean unter einer Verschiebung: Mesh-Ergebnis verschieben (Fallback-sicher).
            let mut m = solid_mesh_core(solid, tol)?;
            for p in m.positions.chunks_mut(3) {
                p[0] += v[0] as f32;
                p[1] += v[1] as f32;
                p[2] += v[2] as f32;
            }
            Ok(m)
        }
        _ => {
            let solid = build_solid(spec)?;
            Ok(mesh_of_solid(&solid, tol))
        }
    }
}

// ── STEP ─────────────────────────────────────────────────────────────────────

/// Kopfdaten der STEP-Datei.
#[derive(Deserialize, Default)]
pub struct StepHeader {
    #[serde(default)]
    pub file_name: String,
    #[serde(default)]
    pub organization_system: String,
}

/// Ersetzt Schnittkurven (`IntersectionCurve`, Ergebnis von B-Rep-Booleans) durch STEP-taugliche
/// Kurven: Ebene∩Ebene → exakte Gerade, sonst der Leitkurven-Spline bzw. ein Polygonzug als
/// B-Spline Grad 1. truck-stepio schreibt Schnittkurven fehlerhaft (falscher Flächenverweis),
/// ausserdem lesen andere CAD-Systeme sie nicht.
pub fn heal_curves(solid: &Solid) -> Solid {
    fn leader_curve(l: &Leader) -> Curve {
        match l {
            Leader::BSpline(b) => Curve::BSplineCurve(b.clone()),
            Leader::Polyline(pl) => {
                let n = pl.len();
                let mut knots = vec![0.0];
                knots.extend((0..n).map(|i| i as f64));
                knots.push((n - 1) as f64);
                let pts: Vec<Point3> = pl.iter().copied().collect();
                Curve::BSplineCurve(BSplineCurve::new(KnotVec::from(knots), pts))
            }
        }
    }
    solid.mapped(
        |p| *p,
        |c| match c {
            Curve::IntersectionCurve(ic) => {
                if let (Surface::Plane(_), Surface::Plane(_)) = (ic.surface0(), ic.surface1()) {
                    let t = ic.leader().range_tuple();
                    let (a, b) = (ic.leader().subs(t.0), ic.leader().subs(t.1));
                    let mut line = Line(a, b);
                    // Parameter 0..1 wie jede Gerade; die Kante übernimmt die Endpunkte.
                    let _ = &mut line;
                    Curve::Line(line)
                } else {
                    leader_curve(ic.leader())
                }
            }
            other => other.clone(),
        },
        |s| s.clone(),
    )
}

/// Exportiert Körper als STEP-Datei (ISO 10303-42 B-Rep).
pub fn export_step_core(specs: &[SolidSpec], header: &StepHeader) -> Res<String> {
    use truck_stepio::out::{CompleteStepDisplay, StepHeaderDescriptor, StepModels};
    let solids: Vec<Solid> = specs
        .iter()
        // Modell in Metern; truck schreibt `SI_UNIT(.MILLI.,.METRE.)` fest in den Kopf → ×1000.
        .map(|sp| {
            build_solid(sp).map(|s| {
                builder::scaled(&heal_curves(&s), Point3::origin(), Vector3::new(1000.0, 1000.0, 1000.0))
            })
        })
        .collect::<std::result::Result<_, String>>()?;
    let compressed: Vec<_> = solids.iter().map(|s| s.compress()).collect();
    let mut models: StepModels<'_, Point3, Curve, Surface> = StepModels::default();
    for c in &compressed {
        models.push_solid(c);
    }
    let display = CompleteStepDisplay::new(
        models,
        StepHeaderDescriptor {
            file_name: header.file_name.clone(),
            organization_system: if header.organization_system.is_empty() {
                "dossier".to_owned()
            } else {
                header.organization_system.clone()
            },
            ..Default::default()
        },
    );
    Ok(display.to_string())
}

/// Ein eingelesener STEP-Körper (Shell) als Mesh.
#[derive(Serialize)]
pub struct StepMesh {
    pub positions: Vec<f32>,
    pub indices: Vec<u32>,
}

/// Längeneinheit einer STEP-Datei in Metern (`LENGTH_UNIT`: SI mit Präfix oder Zoll/Fuss).
pub fn step_length_unit_in_m(text: &str) -> f64 {
    for line in text.lines().chain(text.split(';')) {
        if !line.contains("LENGTH_UNIT") {
            continue;
        }
        let up = line.to_uppercase();
        if up.contains("CONVERSION_BASED_UNIT") {
            if up.contains("'INCH'") || up.contains("'IN'") {
                return 0.0254;
            }
            if up.contains("'FOOT'") || up.contains("'FT'") {
                return 0.3048;
            }
        }
        if up.contains(".MILLI.") {
            return 0.001;
        }
        if up.contains(".CENTI.") {
            return 0.01;
        }
        if up.contains(".KILO.") {
            return 1000.0;
        }
        if up.contains("SI_UNIT") {
            return 1.0;
        }
    }
    1.0
}

/// Liest eine STEP-Datei und tesselliert alle Shells (relative Toleranz `rel_tol` der
/// Bounding-Box-Diagonale, z. B. 0.001).
pub fn import_step_core(text: &str, rel_tol: f64) -> Res<Vec<StepMesh>> {
    let table = truck_stepio::r#in::Table::from_step(text)
        .ok_or_else(|| "STEP-Datei konnte nicht gelesen werden".to_string())?;
    let unit = step_length_unit_in_m(text);
    let mut out = Vec::new();
    let mut idxs: Vec<&u64> = table.shell.keys().collect();
    idxs.sort();
    for idx in idxs {
        let holder = &table.shell[idx];
        let Ok(shell) = table.to_compressed_shell(holder) else {
            continue; // nicht lesbare Shell überspringen
        };
        let pre = shell.triangulation(0.01).to_polygon();
        let diag = pre.bounding_box().diameter();
        let tol = if diag.is_finite() && diag > 0.0 { diag * rel_tol.max(1e-6) } else { 0.01 };
        let mut poly = shell.triangulation(tol).to_polygon();
        poly.put_together_same_attrs(TOLERANCE * 50.0)
            .remove_degenerate_faces()
            .remove_unused_attrs();
        let mut m = mesh_of_polygon(&poly);
        if !m.indices.is_empty() {
            if (unit - 1.0).abs() > 1e-12 {
                m.positions.iter_mut().for_each(|x| *x = (*x as f64 * unit) as f32);
            }
            out.push(StepMesh { positions: m.positions, indices: m.indices });
        }
    }
    if out.is_empty() {
        return Err("keine Körper in der STEP-Datei gefunden".into());
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn volume(m: &MeshOutput) -> f64 {
        // Gauss: Summe der signierten Tetraeder-Volumen zum Ursprung.
        let p = |i: u32| {
            let k = i as usize * 3;
            (m.positions[k] as f64, m.positions[k + 1] as f64, m.positions[k + 2] as f64)
        };
        m.indices
            .chunks(3)
            .map(|t| {
                let (a, b, c) = (p(t[0]), p(t[1]), p(t[2]));
                (a.0 * (b.1 * c.2 - b.2 * c.1) - a.1 * (b.0 * c.2 - b.2 * c.0)
                    + a.2 * (b.0 * c.1 - b.1 * c.0))
                    / 6.0
            })
            .sum::<f64>()
            .abs()
    }

    fn ring(x0: f64, y0: f64, x1: f64, y1: f64) -> Vec<f64> {
        vec![x0, y0, x1, y0, x1, y1, x0, y1]
    }

    #[test]
    fn extrude_mit_loch_hat_richtiges_volumen() {
        let spec = SolidSpec::Extrude {
            points: ring(0.0, 0.0, 4.0, 3.0),
            holes: vec![ring(1.0, 1.0, 2.0, 2.0)],
            height: 2.0,
            z0: 0.0,
            corner_radius: 0.0, chamfer: 0.0,
        };
        let m = solid_mesh_core(&spec, 0.01).unwrap();
        assert!((volume(&m) - (12.0 - 1.0) * 2.0).abs() < 1e-3, "{}", volume(&m));
    }

    #[test]
    fn verrundete_ecken_haben_das_flaechenmass_des_abgerundeten_rechtecks() {
        let r = 0.5;
        let spec = SolidSpec::Extrude {
            points: ring(0.0, 0.0, 4.0, 3.0),
            holes: vec![],
            height: 2.0,
            z0: 0.0,
            corner_radius: r,
            chamfer: 0.0,
        };
        let m = solid_mesh_core(&spec, 0.001).unwrap();
        let area = 12.0 - (4.0 - PI) * r * r;
        assert!((volume(&m) - area * 2.0).abs() / (area * 2.0) < 0.003, "{}", volume(&m));
    }

    #[test]
    fn fase_schneidet_vier_dreiecke_ab() {
        let spec = SolidSpec::Extrude {
            points: ring(0.0, 0.0, 4.0, 3.0),
            holes: vec![],
            height: 2.0,
            z0: 0.0,
            corner_radius: 0.0,
            chamfer: 0.5,
        };
        let m = solid_mesh_core(&spec, 0.01).unwrap();
        let area = 12.0 - 4.0 * 0.5 * 0.5 * 0.5; // 4 Eckdreiecke à 0,125
        assert!((volume(&m) - area * 2.0).abs() < 1e-3, "{}", volume(&m));
    }

    #[test]
    fn eckenradius_wird_auf_die_halbe_kante_begrenzt() {
        // Radius 10 an einem 1×1-Quadrat → Kreis mit Radius 0,5 (Stadium-Grenzfall), kein Fehler.
        let spec = SolidSpec::Extrude {
            points: ring(0.0, 0.0, 1.0, 1.0),
            holes: vec![],
            height: 1.0,
            z0: 0.0,
            corner_radius: 10.0, chamfer: 0.0,
        };
        let m = solid_mesh_core(&spec, 0.001).unwrap();
        let expect = PI * 0.25;
        assert!((volume(&m) - expect).abs() / expect < 0.01, "{}", volume(&m));
    }

    #[test]
    fn verrundete_extrusion_laesst_sich_nach_step_exportieren_und_zuruecklesen() {
        let spec = SolidSpec::Extrude {
            points: ring(0.0, 0.0, 4.0, 3.0),
            holes: vec![],
            height: 2.0,
            z0: 0.0,
            corner_radius: 0.5, chamfer: 0.0,
        };
        let step = export_step_core(&[spec], &StepHeader::default()).unwrap();
        let back = import_step_core(&step, 0.001).unwrap();
        let m = MeshOutput { positions: back[0].positions.clone(), indices: back[0].indices.clone() };
        let expect = (12.0 - (4.0 - PI) * 0.25) * 2.0;
        assert!((volume(&m) - expect).abs() / expect < 0.01, "{}", volume(&m));
    }

    #[test]
    fn zylinder_und_kugel_volumen() {
        let cyl = solid_mesh_core(
            &SolidSpec::Cylinder { cx: 0.0, cy: 0.0, z0: 0.0, r: 1.0, height: 2.0 },
            0.002,
        )
        .unwrap();
        assert!((volume(&cyl) - PI * 2.0).abs() / (PI * 2.0) < 0.01, "{}", volume(&cyl));
        let sph = solid_mesh_core(&SolidSpec::Sphere { center: [0.0; 3], r: 1.0 }, 0.002).unwrap();
        assert!((volume(&sph) - 4.0 / 3.0 * PI).abs() / (4.0 / 3.0 * PI) < 0.02, "{}", volume(&sph));
    }

    #[test]
    fn rotationskoerper_kegel() {
        let c = solid_mesh_core(
            &SolidSpec::Cone { cx: 0.0, cy: 0.0, z0: 0.0, r: 1.0, height: 3.0 },
            0.002,
        )
        .unwrap();
        let expect = PI * 1.0 * 3.0 / 3.0;
        assert!((volume(&c) - expect).abs() / expect < 0.02, "{}", volume(&c));
    }

    #[test]
    fn torus_volumen() {
        let t = solid_mesh_core(&SolidSpec::Torus { center: [0.0; 3], major: 2.0, minor: 0.5 }, 0.002)
            .unwrap();
        let expect = 2.0 * PI * PI * 2.0 * 0.5 * 0.5;
        assert!((volume(&t) - expect).abs() / expect < 0.02, "{}", volume(&t));
    }

    #[test]
    fn loft_quadrat_zu_quadrat_ist_pyramidenstumpf() {
        let spec = SolidSpec::Loft {
            sections: vec![
                LoftSection { z: 0.0, points: ring(0.0, 0.0, 2.0, 2.0) },
                LoftSection { z: 3.0, points: ring(0.5, 0.5, 1.5, 1.5) },
            ],
        };
        let m = solid_mesh_core(&spec, 0.01).unwrap();
        // Pyramidenstumpf: h/3 (A1 + A2 + sqrt(A1 A2)) = 1 * (4 + 1 + 2)
        assert!((volume(&m) - 7.0).abs() < 1e-3, "{}", volume(&m));
    }

    #[test]
    fn boolean_wand_minus_fenster_ueberstehend() {
        let wall = SolidSpec::Cuboid { min: [0.0, 0.0, 0.0], max: [5.0, 0.3, 2.6] };
        let win = SolidSpec::Cuboid { min: [1.0, -0.1, 0.9], max: [2.2, 0.4, 2.1] };
        let spec = SolidSpec::Boolean { op: BoolKind::Difference, a: Box::new(wall), b: Box::new(win) };
        let m = solid_mesh_core(&spec, 0.01).unwrap();
        let expect = 5.0 * 0.3 * 2.6 - 1.2 * 0.3 * 1.2;
        assert!((volume(&m) - expect).abs() < 1e-3, "{}", volume(&m));
    }

    #[test]
    fn boolean_bei_koinzidenten_flaechen_faellt_auf_mesh_csg_zurueck() {
        let wall = SolidSpec::Cuboid { min: [0.0, 0.0, 0.0], max: [5.0, 0.3, 2.6] };
        let win = SolidSpec::Cuboid { min: [1.0, 0.0, 0.9], max: [2.2, 0.3, 2.1] };
        let spec = SolidSpec::Boolean { op: BoolKind::Difference, a: Box::new(wall), b: Box::new(win) };
        // B-Rep allein scheitert …
        assert!(build_solid(&spec).is_err());
        // … die Mesh-Ebene liefert das richtige Volumen.
        let m = solid_mesh_core(&spec, 0.01).unwrap();
        let expect = 5.0 * 0.3 * 2.6 - 1.2 * 0.3 * 1.2;
        assert!((volume(&m) - expect).abs() < 1e-3, "{}", volume(&m));
        // Verschoben bleibt es korrekt und liegt wirklich dort.
        let moved = SolidSpec::Translate { v: [10.0, 0.0, 1.0], solid: Box::new(spec) };
        let mm = solid_mesh_core(&moved, 0.01).unwrap();
        assert!((volume(&mm) - expect).abs() < 1e-3);
        let min_x = mm.positions.chunks(3).map(|p| p[0]).fold(f32::INFINITY, f32::min);
        assert!((min_x - 10.0).abs() < 1e-3, "{min_x}");
    }

    /// Wand 5 × 2,6 m, 0,3 m dick, mit Fenster 1,2 × 1,2 m als Loch im Wandprofil.
    fn wand_mit_fenster() -> SolidSpec {
        SolidSpec::ExtrudePlane {
            points: vec![0.0, 0.0, 5.0, 0.0, 5.0, 2.6, 0.0, 2.6],
            holes: vec![vec![1.0, 0.9, 2.2, 0.9, 2.2, 2.1, 1.0, 2.1]],
            origin: [0.0, 0.0, 0.0],
            u_axis: [1.0, 0.0, 0.0],
            v_axis: [0.0, 0.0, 1.0],
            depth: -0.3, // u×v = −Y; negativ ⇒ +Y
        }
    }

    #[test]
    fn wand_mit_fensterloch_ohne_boolean_hat_das_richtige_volumen() {
        let m = solid_mesh_core(&wand_mit_fenster(), 0.01).unwrap();
        let expect = (5.0 * 2.6 - 1.2 * 1.2) * 0.3;
        assert!((volume(&m) - expect).abs() < 1e-3, "{}", volume(&m));
    }

    #[test]
    fn step_roundtrip_erhaelt_das_volumen() {
        let step = export_step_core(&[wand_mit_fenster()], &StepHeader::default()).unwrap();
        assert!(step.starts_with("ISO-10303-21;"));
        let back = import_step_core(&step, 0.001).unwrap();
        assert_eq!(back.len(), 1);
        let m = MeshOutput { positions: back[0].positions.clone(), indices: back[0].indices.clone() };
        let expect = (5.0 * 2.6 - 1.2 * 1.2) * 0.3;
        assert!((volume(&m) - expect).abs() < 0.01, "{}", volume(&m));
    }

    #[test]
    fn extrude_json_spezifikation_wird_gelesen() {
        let json = r#"{"kind":"extrude","points":[0,0,1,0,1,1,0,1],"height":2}"#;
        let spec: SolidSpec = serde_json::from_str(json).unwrap();
        assert!(solid_mesh_core(&spec, 0.01).is_ok());
        let rev = r#"{"kind":"revolve","profile":[0,0,1,0,1,1,0,1],"angleDeg":180}"#;
        let spec: SolidSpec = serde_json::from_str(rev).unwrap();
        assert!(solid_mesh_core(&spec, 0.01).is_ok());
    }
}


#[cfg(test)]
mod dbg_step {
    use super::*;
    #[test]
    fn write_step_files_for_external_check() {
        let dir = std::env::var("STEP_OUT_DIR").unwrap_or_default();
        if dir.is_empty() {
            return;
        }
        let ring = |x0: f64, y0: f64, x1: f64, y1: f64| vec![x0, y0, x1, y0, x1, y1, x0, y1];
        let cases: Vec<(&str, SolidSpec)> = vec![
            ("cuboid", SolidSpec::Cuboid { min: [0.0; 3], max: [2.0, 1.0, 1.0] }),
            ("extrude_hole", SolidSpec::Extrude { points: ring(0.0, 0.0, 4.0, 3.0), holes: vec![ring(1.0, 1.0, 2.0, 2.0)], height: 2.0, z0: 0.0, corner_radius: 0.0, chamfer: 0.0 }),
            ("extrude_round", SolidSpec::Extrude { points: ring(0.0, 0.0, 4.0, 3.0), holes: vec![], height: 2.0, z0: 0.0, corner_radius: 0.5, chamfer: 0.0 }),
            ("cylinder", SolidSpec::Cylinder { cx: 0.0, cy: 0.0, z0: 0.0, r: 1.0, height: 2.0 }),
            ("cone", SolidSpec::Cone { cx: 0.0, cy: 0.0, z0: 0.0, r: 1.0, height: 3.0 }),
            ("sphere", SolidSpec::Sphere { center: [0.0; 3], r: 1.0 }),
            ("torus", SolidSpec::Torus { center: [0.0; 3], major: 2.0, minor: 0.5 }),
            ("revolve", SolidSpec::Revolve { profile: vec![0.0, 0.0, 1.0, 0.0, 1.0, 2.0, 0.0, 2.0], cx: 0.0, cy: 0.0, angle_deg: 360.0 }),
            ("loft", SolidSpec::Loft { sections: vec![LoftSection { z: 0.0, points: ring(0.0, 0.0, 2.0, 2.0) }, LoftSection { z: 3.0, points: ring(0.5, 0.5, 1.5, 1.5) }] }),
            ("wall_window", SolidSpec::ExtrudePlane { points: vec![0.0, 0.0, 5.0, 0.0, 5.0, 2.6, 0.0, 2.6], holes: vec![vec![1.0, 0.9, 2.2, 0.9, 2.2, 2.1, 1.0, 2.1]], origin: [0.0; 3], u_axis: [1.0, 0.0, 0.0], v_axis: [0.0, 0.0, 1.0], depth: -0.3 }),
        ];
        for (name, spec) in cases {
            let step = export_step_core(&[spec], &StepHeader::default()).unwrap();
            std::fs::write(format!("{dir}/{name}.stp"), step).unwrap();
        }
    }

    #[test]
    fn transform_rotate_and_mirror_keep_volume() {
        let base = SolidSpec::Cuboid { min: [0.0, 0.0, 0.0], max: [2.0, 1.0, 3.0] };
        let vol = |sp: &SolidSpec| {
            let m = solid_mesh_core(sp, 0.01).unwrap();
            let p: Vec<[f64; 3]> = m.positions.chunks(3).map(|c| [c[0] as f64, c[1] as f64, c[2] as f64]).collect();
            m.indices.chunks(3).map(|t| {
                let (a, b, c) = (p[t[0] as usize], p[t[1] as usize], p[t[2] as usize]);
                (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6.0
            }).sum::<f64>()
        };
        let rot = SolidSpec::Transform { m: [0.0, -1.0, 0.0, 5.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0], solid: Box::new(base.clone()) };
        let mir = SolidSpec::Transform { m: [-1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0], solid: Box::new(base) };
        assert!((vol(&rot) - 6.0).abs() < 1e-6, "rot {}", vol(&rot));
        assert!((vol(&mir) - 6.0).abs() < 1e-6, "mir {}", vol(&mir));
    }

    #[test]
    fn bool_result_step_dump() {
        let dir = std::env::var("STEP_DUMP_DIR").unwrap_or_default();
        if dir.is_empty() {
            return;
        }
        let wall = SolidSpec::Cuboid { min: [0.0, 0.0, 0.0], max: [5.0, 0.3, 3.0] };
        let win = SolidSpec::Cuboid { min: [1.0, -0.1, 1.0], max: [2.5, 0.4, 2.2] };
        let round = SolidSpec::Cylinder { cx: 4.0, cy: -0.5, z0: 1.5, r: 0.5, height: 1.0 };
        let _ = round;
        let hole = SolidSpec::Revolve { profile: vec![0.0, 0.0, 0.5, 0.0, 0.5, 1.0, 0.0, 1.0], cx: 0.0, cy: 0.0, angle_deg: 360.0 };
        let _ = hole;
        let w1 = SolidSpec::Boolean { op: BoolKind::Difference, a: Box::new(wall.clone()), b: Box::new(win) };
        let step = export_step_core(&[w1], &StepHeader::default()).unwrap();
        std::fs::write(format!("{dir}/bool_window.stp"), step).unwrap();
        // Rundes Fenster: stehender Zylinder quer durch die Wand (Achse Y).
        let cyl = SolidSpec::Transform {
            m: [1.0, 0.0, 0.0, 4.0, 0.0, 0.0, 1.0, -0.2, 0.0, -1.0, 0.0, 1.5],
            solid: Box::new(SolidSpec::Cylinder { cx: 0.0, cy: 0.0, z0: 0.0, r: 0.5, height: 0.7 }),
        };
        let w2 = SolidSpec::Boolean { op: BoolKind::Difference, a: Box::new(wall), b: Box::new(cyl) };
        let step = export_step_core(&[w2], &StepHeader::default()).unwrap();
        std::fs::write(format!("{dir}/bool_round.stp"), step).unwrap();
    }

    #[test]
    fn step_unit_detection() {
        assert_eq!(step_length_unit_in_m("#12 = ( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.) );"), 0.001);
        assert_eq!(step_length_unit_in_m("#1 = ( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT($,.METRE.) );"), 1.0);
        assert_eq!(step_length_unit_in_m("#1 = ( CONVERSION_BASED_UNIT('INCH',#2) LENGTH_UNIT() NAMED_UNIT(#3) );"), 0.0254);
        assert_eq!(step_length_unit_in_m("nichts"), 1.0);
    }

    #[test]
    fn export_is_in_millimetres() {
        let spec = SolidSpec::Cuboid { min: [0.0; 3], max: [2.0, 1.0, 3.0] };
        let step = export_step_core(&[spec], &StepHeader::default()).unwrap();
        assert!(step.contains("2000"), "Koordinaten in mm erwartet");
        let back = import_step_core(&step, 0.0005).unwrap();
        let xs: Vec<f32> = back[0].positions.chunks(3).map(|c| c[0]).collect();
        let max = xs.iter().cloned().fold(f32::MIN, f32::max);
        assert!((max - 2.0).abs() < 1e-3, "Import zurück in Meter, war {max}");
    }
}
