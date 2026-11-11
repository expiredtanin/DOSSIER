//! Treppen im IFC-Export ([B5], [K4]; Port von `src/export/ifcStairs.ts`): statt eines
//! Fussabdruck-Quaders die Teile der Treppe wie im 3D — Läufe (IfcStairFlight), Podest (IfcSlab
//! LANDING) und Handlauf/Pfosten (IfcRailing), zusammengefasst von der IfcStair. Quelle sind
//! dieselben Ableitungen wie im 3D (`emit_stairs` Tritt-Prismen und Podest, `emit_stair_meshes`
//! glatte Ortbeton-Laufplatte, `emit_stair_railings`), je Treppe mit einem Projekt aufgerufen, das
//! nur diese Treppe enthält (die Ableitungen liefern keine ids). Hier: Zuordnung und Basismengen;
//! die Entitäten schreibt `fileio` (`ifc_export/mod.rs`, STAIR).
//!
//! Zuordnung der Tritt-Prismen: bei Podesttreppen (L, U, gerade mit Podest; [151]) ist ein Podest das
//! Prisma mit dem Umriss eines Podest-Polygons der Treppengeometrie; die Tritte zwischen zwei
//! Podest-Oberkanten bilden einen Lauf. Ortbeton-Läufe kommen je Lauf als Netz. Gerade und
//! Wendeltreppen haben einen Lauf (die Wendel-Mitte bleibt Teil davon).
//! Die Mittelsäule (Spindel, `Stair.centerColumn`) einer Wendel ist kein Tritt: eigener Teil
//! (IfcColumn) mit Stützen-Basismengen. Ortbeton-Läufe (Netz) tragen zusätzlich die Untersicht
//! (Schalfläche, bei der Wendel die Wendelfläche) in `Dossier_Qto_StairFlight`.

use crate::export_flat::{js_key, mesh_volume, orient_outward};
use crate::ifc_quantities::{column_quantities, flight_quantities, railing_quantities, ring_area, slab_quantities, Qty};
use crate::jsmath::hypot2;
use crate::jsnum::round;
use crate::model::*;
use crate::model3d::{self, RMesh, RSlab};

/// Ein Prisma (Profil in Welt-XY, Unterkante relativ zum Geschoss, Tiefe).
#[derive(Debug, Clone, PartialEq)]
pub struct StairSolid {
    pub pts: Vec<Vec2>,
    pub z_rel: f64,
    pub depth: f64,
}

/// Ein Netz (IFC: x, y, z-hoch, Z relativ zum Geschoss).
#[derive(Debug, Clone, PartialEq)]
pub struct IfcMesh {
    pub positions: Vec<f64>,
    pub indices: Vec<u32>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum FlightBody {
    Solids(Vec<StairSolid>),
    Mesh(IfcMesh),
}

#[derive(Debug, Clone, PartialEq)]
pub struct StairFlightParts {
    pub name: String,
    pub risers: f64,
    pub treads: f64,
    pub riser_height: f64,
    pub tread_length: f64,
    /// IfcStairFlightTypeEnum.
    pub predefined: &'static str,
    pub quantities: Vec<Qty>,
    /// Untersicht (m²) eines Ortbeton-Laufs (Netz); `None` bei Tritt-Prismen.
    pub soffit_area: Option<f64>,
    pub body: FlightBody,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Landing {
    pub pts: Vec<Vec2>,
    pub z_rel: f64,
    pub depth: f64,
    pub quantities: Vec<Qty>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Rail {
    pub mesh: IfcMesh,
    pub quantities: Vec<Qty>,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct StairParts {
    pub flights: Vec<StairFlightParts>,
    /// Podeste (IfcSlab LANDING), unteres zuerst; U mit Mittellauf: zwei.
    pub landings: Vec<Landing>,
    pub rail: Option<Rail>,
    /// [155] Absturzsicherung am Deckenloch, in dem die Treppe ankommt (IfcRailing GUARDRAIL).
    pub guard: Option<Rail>,
    /// Mittelsäule (Spindel) einer Wendel: Prisma + Stützen-Basismengen.
    pub column: Option<Landing>,
}

const EPS: f64 = 1e-6;

/// Gleicher Umriss (gleiche Punktmenge, auch bei anderer Reihenfolge/Startpunkt).
fn same_ring(a: &[[f64; 2]], b: &[kernel2d::Vec2]) -> bool {
    a.len() == b.len() && a.iter().all(|p| b.iter().any(|q| (p[0] - q.x).abs() < EPS && (p[1] - q.y).abs() < EPS))
}

fn centroid(pts: &[Vec2]) -> Vec2 {
    let (mut x, mut y) = (0.0, 0.0);
    for p in pts {
        x += p.x;
    }
    for p in pts {
        y += p.y;
    }
    Vec2 { x: x / pts.len() as f64, y: y / pts.len() as f64 }
}

/// Netze aneinanderhängen (Indizes verschoben).
fn concat(meshes: &[RMesh]) -> (Vec<f64>, Vec<u32>) {
    let (mut positions, mut indices) = (Vec::new(), Vec::new());
    for m in meshes {
        let at = (positions.len() / 3) as u32;
        positions.extend_from_slice(&m.positions);
        indices.extend(m.indices.iter().map(|i| at + i));
    }
    (positions, indices)
}

/// Netz (Modell x, y, z-hoch) nach IFC: Z relativ zum Geschoss, Wicklung nach aussen.
fn ifc_mesh(mut positions: Vec<f64>, indices: &[u32], base: f64) -> IfcMesh {
    let mut i = 2;
    while i < positions.len() {
        positions[i] -= base;
        i += 3;
    }
    let indices = orient_outward(&positions, indices);
    IfcMesh { positions, indices }
}

/// Untersicht eines geschlossenen, nach aussen orientierten Netzes: Summe der Dreiecke, deren
/// Normale nach unten zeigt (Schalfläche; bei der Wendel die Wendelfläche samt flachem Anlauf).
pub fn soffit_area(positions: &[f64], indices: &[u32]) -> f64 {
    let p = |i: u32| {
        let k = 3 * i as usize;
        [positions[k], positions[k + 1], positions[k + 2]]
    };
    let mut sum = 0.0;
    for t in indices.chunks_exact(3) {
        if t.iter().any(|&i| 3 * i as usize + 2 >= positions.len()) {
            continue;
        }
        let (a, b, c) = (p(t[0]), p(t[1]), p(t[2]));
        let (u, v) = ([b[0] - a[0], b[1] - a[1], b[2] - a[2]], [c[0] - a[0], c[1] - a[1], c[2] - a[2]]);
        let n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
        let len = crate::jsmath::hypot(&[n[0], n[1], n[2]]);
        if len > 0.0 && n[2] < -1e-9 * len {
            sum += len / 2.0;
        }
    }
    sum
}

/// Ortbeton-Lauf (Netz) einer Treppe: (Betonvolumen m³, Untersicht m²); `None` ohne Netz (keine
/// Beton-Gerade/-Wendel). `one` wie bei [`stair_parts`]. Ohne Mittelsäule.
pub fn concrete_flight_amounts(one: &Project) -> Option<(f64, f64)> {
    let meshes = model3d::emit_stair_meshes(one);
    if meshes.is_empty() {
        return None;
    }
    let (positions, indices) = concat(&meshes);
    let m = ifc_mesh(positions, &indices, 0.0);
    Some((mesh_volume(&m.positions, &m.indices), soffit_area(&m.positions, &m.indices)))
}

/// Untersicht (m²) der Treppe in `one` (Projekt nur mit dieser Treppe): Ortbeton-Netz oder Summe der
/// Trittunterseiten; `None` ohne Untersicht.
pub fn flight_soffit_area(one: &Project) -> Option<f64> {
    if let Some(a) = concrete_flight_amounts(one) {
        return Some(a.1);
    }
    let stair = one.stairs.as_ref()?.first()?;
    let sum: f64 = stair_parts(one, stair, 0.0).flights.iter().filter_map(|f| f.soffit_area).sum();
    (sum > 0.0).then_some(sum)
}

/// [151] Läufe einer Treppe aus geraden Läufen: je Lauf (Tritte, waagrechte Länge Antritt → Hinterkante
/// des letzten Tritts, Höhe) und die Mitten von Antritts- und Austrittskante; getrennt am Podest
/// (Sprung im Tritt-Index).
struct RunInfo {
    treads: usize,
    run: f64,
    lift: f64,
    from: Vec2,
    to: Vec2,
}

fn runs_of(geo: &kernel2d::StairGeometry) -> Vec<RunInfo> {
    let tr = &geo.treads;
    let mut out: Vec<RunInfo> = Vec::new();
    let mut a = 0;
    for k in 1..=tr.len() {
        if k < tr.len() && tr[k].index == tr[k - 1].index + 1 {
            continue;
        }
        let (first, last) = (&tr[a], &tr[k - 1]);
        if first.pts.len() >= 4 && last.pts.len() >= 4 {
            let mid = |p: kernel2d::Vec2, q: kernel2d::Vec2| Vec2 { x: (p.x + q.x) / 2.0, y: (p.y + q.y) / 2.0 };
            let (from, to) = (mid(first.pts[0], first.pts[3]), mid(last.pts[1], last.pts[2]));
            out.push(RunInfo { treads: k - a, run: hypot2(to.x - from.x, to.y - from.y), lift: last.top_rise - first.base_rise, from, to });
        }
        a = k;
    }
    out
}

/// Lauflänge auf der Lauflinie mit Steigung: Wendel = Schraubenlinie im Laufradius; Podesttreppen
/// (L, U, gerade mit Podest) = Läufe geneigt plus der Weg über die Podeste (über deren Mitte); sonst
/// die Lauflänge.
fn walk_length(stair: &Stair, rise: f64) -> f64 {
    if matches!(stair.shape, StairShape::L | StairShape::U | StairShape::StraightLanding) {
        if let Some(g) = crate::stair::decode_geometry(&crate::stair::geometry(&stair.encode(), rise)) {
            let runs = runs_of(&g);
            let lands: Vec<&Vec<kernel2d::Vec2>> = g.landing.iter().chain(g.landing2.iter()).collect();
            if !runs.is_empty() && runs.len() == lands.len() + 1 {
                let mut sum: f64 = runs.iter().map(|r| hypot2(r.run, r.lift)).sum();
                for (k, l) in lands.iter().enumerate() {
                    let c = centroid(&l.iter().map(|p| Vec2 { x: p.x, y: p.y }).collect::<Vec<_>>());
                    let (a, b) = (runs[k].to, runs[k + 1].from);
                    sum += hypot2(c.x - a.x, c.y - a.y) + hypot2(b.x - c.x, b.y - c.y);
                }
                return sum;
            }
        }
    }
    let run = if stair.shape == StairShape::Spiral {
        let half_w = 0.05_f64.max(stair.width / 2.0);
        let radius = (half_w + 0.1).max(stair.radius.unwrap_or(stair.width));
        stair.sweep.unwrap_or(270.0).to_radians().abs() * radius
    } else {
        stair.run_length
    };
    hypot2(run, rise)
}

fn solid_of(s: &RSlab, base: f64) -> StairSolid {
    StairSolid { pts: s.outline.iter().map(|p| Vec2 { x: p[0], y: p[1] }).collect(), z_rel: s.z_bottom - base, depth: s.z_top - s.z_bottom }
}

/// IFC-Typ der Treppe (IfcStairTypeEnum) nach Grundform.
pub fn stair_predefined(stair: &Stair) -> &'static str {
    match stair.shape {
        StairShape::Straight | StairShape::Unknown => "STRAIGHT_RUN_STAIR",
        StairShape::Spiral => "SPIRAL_STAIR",
        StairShape::L => "QUARTER_TURN_STAIR",
        StairShape::U if stair.mid_steps.is_some_and(|m| m >= 0.5) => "TWO_QUARTER_TURN_STAIR",
        StairShape::U => "HALF_TURN_STAIR",
        StairShape::StraightLanding => "TWO_STRAIGHT_RUN_STAIR",
    }
}

/// Teile einer Treppe für den IFC-Export. `one` = Projekt, das NUR diese Treppe enthält (sonst wie
/// das ganze Projekt), `base` = Geschoss-UK, auf die Z-Werte bezogen werden. Leere Teile ergeben
/// `flights: []`, `landings: []`, `rail: None`.
pub fn stair_parts(one: &Project, stair: &Stair, base: f64) -> StairParts {
    let (z_bottom, z_top) = one.stair_vertical_extent(stair);
    let rise = z_top - z_bottom;
    let geo = crate::stair::decode_geometry(&crate::stair::geometry(&stair.encode(), rise));
    let (riser_height, tread_depth, n_treads) = geo.as_ref().map_or((0.0, 0.0, 0), |g| (g.riser_height, g.tread_depth, g.treads.len()));
    let runs = geo.as_ref().map(runs_of).unwrap_or_default();
    let mut slabs = model3d::emit_stairs(one, false);
    // Mittelsäule: `slabs_of` hängt sie bei einer Wendel mit Säule als letzte Platte an.
    let column = (stair.shape == StairShape::Spiral && stair.center.is_some() && stair.center_column.is_some_and(|r| r.is_finite() && r > 0.0))
        .then(|| slabs.pop())
        .flatten()
        .map(|c| {
            let s = solid_of(&c, base);
            let quantities = column_quantities(&s.pts, s.depth);
            Landing { pts: s.pts, z_rel: s.z_rel, depth: s.depth, quantities }
        });
    let meshes = model3d::emit_stair_meshes(one);
    let predefined = if stair.shape == StairShape::Spiral { "SPIRAL" } else { "STRAIGHT" };

    // Podeste der Podesttreppen (bei der Wendel ist das Polygon die Treppenmitte, Teil des Laufs).
    let mut landing_idx: Vec<usize> = Vec::new();
    if matches!(stair.shape, StairShape::L | StairShape::U | StairShape::StraightLanding) {
        if let Some(g) = &geo {
            for l in g.landing.iter().chain(g.landing2.iter()) {
                if let Some(i) = slabs.iter().position(|s| same_ring(&s.outline, l)) {
                    landing_idx.push(i);
                }
            }
        }
    }
    let tread_slabs: Vec<&RSlab> = slabs.iter().enumerate().filter(|(i, _)| !landing_idx.contains(i)).map(|(_, s)| s).collect();

    // Tritte je Lauf: zwischen den Podest-Oberkanten.
    let mut tops: Vec<f64> = landing_idx.iter().map(|&i| slabs[i].z_top + EPS).collect();
    tops.sort_by(f64::total_cmp);
    let mut groups: Vec<Vec<&RSlab>> = vec![Vec::new(); tops.len() + 1];
    for s in &tread_slabs {
        let k = tops.iter().filter(|t| s.z_top > **t).count();
        groups[k].push(s);
    }
    groups.retain(|g| !g.is_empty());

    let mut flights: Vec<StairFlightParts> = Vec::new();
    let n_groups = groups.len().max(if meshes.is_empty() { 0 } else { meshes.len() });
    let name = |k: usize| if n_groups > 1 { format!("Lauf {}", k + 1) } else { "Lauf".to_string() };
    for (k, g) in groups.iter().enumerate() {
        // Tritte = verschiedene Oberkanten (Setzstufen-Platten und Nasen teilen die Höhe ihres Tritts).
        let mut tops: Vec<u64> = Vec::new();
        for s in g {
            let key = js_key(round(s.z_top / 1e-4));
            if !tops.contains(&key) {
                tops.push(key);
            }
        }
        let treads = tops.len() as f64;
        // Lauflänge: Weg zwischen erstem und letztem Tritt (Schwerpunkte) plus eine Trittiefe, mit der Steigung.
        let mut lowest = g[0];
        let mut highest = g[0];
        for s in g {
            if s.z_top < lowest.z_top {
                lowest = s;
            }
            if s.z_top > highest.z_top {
                highest = s;
            }
        }
        let c0 = centroid(&solid_of(lowest, base).pts);
        let c1 = centroid(&solid_of(highest, base).pts);
        let run = hypot2(c1.x - c0.x, c1.y - c0.y) + tread_depth;
        let lift = highest.z_top - lowest.z_top + riser_height;
        let solids: Vec<StairSolid> = g.iter().map(|s| solid_of(s, base)).collect();
        let mut volume = 0.0;
        for x in g {
            let pts: Vec<Vec2> = x.outline.iter().map(|p| Vec2 { x: p[0], y: p[1] }).collect();
            volume += ring_area(&pts) * (x.z_top - x.z_bottom);
        }
        // Untersicht der Einzeltritte (Spindel, Wange): Summe der Trittunterseiten samt Nase; Setzstufen-
        // Platten (andere Dicke als der Tritt) zählen nicht mit.
        let tread_t = one.stair_type(stair).map_or(0.0, |t| t.tread_thickness);
        let soffit_sum: f64 = g
            .iter()
            .filter(|x| (x.z_top - x.z_bottom - tread_t).abs() < 1e-6)
            .map(|x| ring_area(&x.outline.iter().map(|p| Vec2 { x: p[0], y: p[1] }).collect::<Vec<_>>()).abs())
            .sum();
        flights.push(StairFlightParts {
            name: name(k),
            risers: treads,
            treads,
            riser_height,
            tread_length: tread_depth,
            predefined,
            quantities: flight_quantities(if stair.shape == StairShape::Spiral { walk_length(stair, rise) } else { hypot2(run, lift) }, volume),
            soffit_area: (soffit_sum > 0.0).then_some(soffit_sum),
            body: FlightBody::Solids(solids),
        });
    }
    // Glatte Ortbeton-Laufplatten: Wendel ein Netz; Läufe je ein Netz (gerade: eines; Podesttreppen: je Lauf).
    let per_run = meshes.len() > 1 && meshes.len() == runs.len();
    if !meshes.is_empty() {
        let mesh_groups: Vec<Vec<RMesh>> = if per_run { meshes.into_iter().map(|m| vec![m]).collect() } else { vec![meshes] };
        for (k, ms) in mesh_groups.iter().enumerate() {
            let (positions, indices) = concat(ms);
            let mesh = ifc_mesh(positions, &indices, base);
            let volume = mesh_volume(&mesh.positions, &mesh.indices);
            let soffit = soffit_area(&mesh.positions, &mesh.indices);
            let (n, length) = if per_run { (runs[k].treads, hypot2(runs[k].run, runs[k].lift)) } else { (n_treads, walk_length(stair, rise)) };
            flights.push(StairFlightParts {
                name: name(flights.len()),
                risers: n as f64,
                treads: n as f64,
                riser_height,
                tread_length: tread_depth,
                predefined,
                quantities: flight_quantities(length, volume),
                soffit_area: Some(soffit),
                body: FlightBody::Mesh(mesh),
            });
        }
    }

    // Podeste nach Höhe (unteres zuerst).
    let mut landing_idx = landing_idx;
    landing_idx.sort_by(|a, b| slabs[*a].z_top.total_cmp(&slabs[*b].z_top));
    let landings = landing_idx
        .iter()
        .map(|&li| {
            let s = solid_of(&slabs[li], base);
            let quantities = slab_quantities(&s.pts, &[], s.depth);
            Landing { pts: s.pts, z_rel: s.z_rel, depth: s.depth, quantities }
        })
        .collect();

    let rail_meshes = model3d::emit_stair_handrails(one);
    let rail = (!rail_meshes.is_empty()).then(|| {
        let (positions, indices) = concat(&rail_meshes);
        let sides = if one.stair_type(stair).and_then(|t| t.railing) == Some(StairTypeRailing::Beide) { 2.0 } else { 1.0 };
        Rail { mesh: ifc_mesh(positions, &indices, base), quantities: railing_quantities(walk_length(stair, rise) * sides) }
    });
    let guard_meshes = model3d::stair_guard_meshes(one);
    let guard = (!guard_meshes.is_empty()).then(|| {
        let (mut positions, mut indices) = (Vec::new(), Vec::new());
        for (_, m) in &guard_meshes {
            let off = (positions.len() / 3) as u32;
            positions.extend_from_slice(&m.positions);
            indices.extend(m.indices.iter().map(|k| k + off));
        }
        // Länge der Achsen aller Löcher, in denen die Treppe ankommt
        let length: f64 = one.drawing_levels.iter().map(|f| crate::stair_guard::arrivals(one, &f.id, &|_| true, &|| model3d::wall_footprints_of_floor(one, &f.id)).iter().map(|a| crate::stair_guard::axes_length(&a.axes)).sum::<f64>()).sum();
        Rail { mesh: ifc_mesh(positions, &indices, base), quantities: railing_quantities(length) }
    });
    StairParts { flights, landings, rail, guard, column }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project_with(stair: Stair, ty: Option<StairType>) -> Project {
        let mut p: Project = serde_json::from_str(include_str!("../tests/fixtures/sample_project.json")).unwrap();
        if let Some(t) = ty {
            p.stair_types.get_or_insert_with(Vec::new).push(t);
        }
        p.stairs = Some(vec![stair]);
        p
    }

    fn stair(shape: StairShape, type_id: Option<&str>) -> Stair {
        Stair {
            id: "S".into(),
            floor_id: "eg".into(),
            shape,
            start: Vec2 { x: 0.0, y: 0.0 },
            dir: Vec2 { x: 1.0, y: 0.0 },
            run_length: 3.0,
            run2_length: (shape == StairShape::L).then_some(2.0),
            turn: (shape == StairShape::L).then_some(1.0),
            width: 1.0,
            total_rise: Some(2.6),
            step_count: 15.0,
            type_id: type_id.map(String::from),
            ..Default::default()
        }
    }

    #[test]
    fn gerade_massivtreppe_ein_lauf() {
        let st = stair(StairShape::Straight, None);
        let p = project_with(st.clone(), None);
        let parts = stair_parts(&p, &st, 0.0);
        assert_eq!(parts.flights.len(), 1);
        let f = &parts.flights[0];
        assert_eq!(f.name, "Lauf");
        assert!(f.treads > 0.0 && f.riser_height > 0.0);
        assert!(matches!(&f.body, FlightBody::Solids(s) if !s.is_empty()));
        assert!(parts.landings.is_empty() && parts.rail.is_none());
    }

    #[test]
    fn l_treppe_zwei_laeufe_und_podest() {
        let st = stair(StairShape::L, None);
        let p = project_with(st.clone(), None);
        let parts = stair_parts(&p, &st, 0.0);
        assert_eq!(parts.flights.iter().map(|f| f.name.as_str()).collect::<Vec<_>>(), ["Lauf 1", "Lauf 2"]);
        assert_eq!(parts.landings.len(), 1);
        let l = &parts.landings[0];
        assert!(l.depth > 0.0 && l.quantities.iter().any(|q| q.name == "NetArea" && q.value > 0.0));
    }

    #[test]
    fn betontreppe_mit_handlauf_beidseitig() {
        let ty = StairType { id: "beton2".into(), structure: StairTypeStructure::Beton, closed_risers: true, tread_thickness: 0.05, railing: Some(StairTypeRailing::Beide), default_width: 1.0, ..Default::default() };
        let st = stair(StairShape::Straight, Some("beton2"));
        let p = project_with(st.clone(), Some(ty));
        let parts = stair_parts(&p, &st, 0.5);
        let m = parts.flights.iter().find_map(|f| match &f.body {
            FlightBody::Mesh(m) => Some(m),
            _ => None,
        });
        let m = m.expect("Laufplatte als Netz");
        assert!(mesh_volume(&m.positions, &m.indices) > 0.0);
        let rail = parts.rail.expect("Handlauf");
        let len = rail.quantities[0].value;
        assert!((len - 2.0 * hypot2(3.0, 2.6)).abs() < 1e-9);
        // Gerade Laufplatte: Untersicht = schräge Platte + flacher Anlauf ≈ Breite × Lauflänge (geneigt)
        let soffit = parts.flights.iter().find_map(|f| f.soffit_area).unwrap();
        assert!(soffit > 3.0 && soffit < 1.0 * hypot2(3.0, 2.6) + 0.5, "Untersicht {soffit}");
    }

    fn wendel(type_id: &str, column: Option<f64>) -> Stair {
        Stair {
            id: "W".into(),
            floor_id: "eg".into(),
            shape: StairShape::Spiral,
            start: Vec2 { x: 2.0, y: 0.0 },
            dir: Vec2 { x: 0.0, y: 1.0 },
            center: Some(Vec2 { x: 0.0, y: 0.0 }),
            radius: Some(1.5),
            sweep: Some(270.0),
            width: 1.0,
            total_rise: Some(2.8),
            step_count: 14.0,
            type_id: Some(type_id.into()),
            center_column: column,
            ..Default::default()
        }
    }

    fn beton() -> StairType {
        StairType { id: "b".into(), structure: StairTypeStructure::Beton, railing: Some(StairTypeRailing::Rechts), default_width: 1.0, ..Default::default() }
    }

    #[test]
    fn beton_wendel_ein_lauf_als_netz_mit_wendelflaeche() {
        let st = wendel("b", Some(0.12));
        let p = project_with(st.clone(), Some(beton()));
        let parts = stair_parts(&p, &st, 0.0);
        // genau ein Lauf (das Netz) — die Säule ist kein Lauf
        assert_eq!(parts.flights.len(), 1, "{:?}", parts.flights.iter().map(|f| &f.name).collect::<Vec<_>>());
        let f = &parts.flights[0];
        assert_eq!(f.predefined, "SPIRAL");
        let FlightBody::Mesh(m) = &f.body else { panic!("Wendel aus Ortbeton als Netz") };
        let v = mesh_volume(&m.positions, &m.indices);
        let gv = f.quantities.iter().find(|q| q.name == "GrossVolume").unwrap().value;
        assert!(v > 1.5 && (gv - v).abs() < 1e-9, "Volumen {v} / {gv}");
        assert_eq!(concrete_flight_amounts(&p).map(|a| a.0), Some(v));
        // Wendelfläche: Ringsektor 270° r 1…2 = 7.07 m² im Grundriss, geneigt etwas grösser
        let soffit = f.soffit_area.unwrap();
        let plan = 0.75 * std::f64::consts::PI * (4.0 - 1.0);
        assert!(soffit > plan && soffit < 1.3 * plan, "Untersicht {soffit} vs. {plan}");
        // Länge auf der Lauflinie (r 1.5, 270°) mit Steigung
        let len = f.quantities.iter().find(|q| q.name == "Length").unwrap().value;
        assert!((len - hypot2(1.5 * 1.5 * std::f64::consts::PI, 2.8)).abs() < 1e-9, "{len}");
        // Säule: eigener Teil mit Stützenmengen
        let c = parts.column.expect("Spindel");
        assert!((c.depth - 2.8).abs() < 1e-9);
        let cv = c.quantities.iter().find(|q| q.name == "NetVolume").unwrap().value;
        assert!((cv - std::f64::consts::PI * 0.0144 * 2.8).abs() < 0.01, "{cv}");
    }

    #[test]
    fn spindeltreppe_saeule_nicht_im_lauf() {
        let ty = StairType { id: "sp".into(), structure: StairTypeStructure::Spindel, tread_thickness: 0.05, default_width: 1.0, ..Default::default() };
        let mit = wendel("sp", Some(0.1));
        let ohne = wendel("sp", None);
        let a = stair_parts(&project_with(mit.clone(), Some(ty.clone())), &mit, 0.0);
        let b = stair_parts(&project_with(ohne.clone(), Some(ty)), &ohne, 0.0);
        let vol = |p: &StairParts| p.flights[0].quantities.iter().find(|q| q.name == "GrossVolume").unwrap().value;
        assert!((vol(&a) - vol(&b)).abs() < 1e-9, "Säule nicht im Laufvolumen");
        assert!(a.column.is_some() && b.column.is_none());
        // Untersicht = Summe der Trittunterseiten (Ringsektor-Stufen, 14 × ~(270°/14)·(r²−0.5²)/2…) > 0
        let sa = a.flights[0].soffit_area.expect("Untersicht der Tritte");
        assert!(sa > 3.0 && sa < 0.75 * std::f64::consts::PI * (4.0 - 0.0) + 2.0, "Untersicht {sa}");
        assert!((flight_soffit_area(&project_with(ohne.clone(), Some(StairType { id: "sp".into(), structure: StairTypeStructure::Spindel, tread_thickness: 0.05, default_width: 1.0, ..Default::default() }))).unwrap() - b.flights[0].soffit_area.unwrap()).abs() < 1e-9);
    }

    #[test]
    fn untersicht_eines_wuerfels_ist_seine_bodenflaeche() {
        let pos = [0., 0., 0., 1., 0., 0., 1., 1., 0., 0., 1., 0., 0., 0., 1., 1., 0., 1., 1., 1., 1., 0., 1., 1.];
        let idx = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7];
        assert!((soffit_area(&pos, &idx) - 1.0).abs() < 1e-12);
        assert_eq!(soffit_area(&pos, &[0, 1, 99]), 0.0);
    }
}
