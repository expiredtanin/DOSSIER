//! Treppen im IFC-Export ([B5], [K4]; Port von `src/export/ifcStairs.ts`): statt eines
//! Fussabdruck-Quaders die Teile der Treppe wie im 3D — Läufe (IfcStairFlight), Podest (IfcSlab
//! LANDING) und Handlauf/Pfosten (IfcRailing), zusammengefasst von der IfcStair. Quelle sind
//! dieselben Ableitungen wie im 3D (`emit_stairs` Tritt-Prismen und Podest, `emit_stair_meshes`
//! glatte Ortbeton-Laufplatte, `emit_stair_railings`), je Treppe mit einem Projekt aufgerufen, das
//! nur diese Treppe enthält (die Ableitungen liefern keine ids). Hier: Zuordnung und Basismengen;
//! die Entitäten schreibt `fileio` (`ifc_export.rs`, STAIR).
//!
//! Zuordnung der Tritt-Prismen: bei "L" ist das Podest das Prisma mit dem Umriss des Podest-Polygons
//! der Treppengeometrie; Tritte bis zur Podest-Oberkante gehören zum ersten, die darüber zum
//! zweiten Lauf. Gerade und Wendeltreppen haben einen Lauf (die Wendel-Mitte bleibt Teil davon).

use crate::export_flat::{js_key, mesh_volume, orient_outward};
use crate::ifc_quantities::{flight_quantities, railing_quantities, ring_area, slab_quantities, Qty};
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
    pub landing: Option<Landing>,
    pub rail: Option<Rail>,
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

fn solid_of(s: &RSlab, base: f64) -> StairSolid {
    StairSolid { pts: s.outline.iter().map(|p| Vec2 { x: p[0], y: p[1] }).collect(), z_rel: s.z_bottom - base, depth: s.z_top - s.z_bottom }
}

/// Teile einer Treppe für den IFC-Export. `one` = Projekt, das NUR diese Treppe enthält (sonst wie
/// das ganze Projekt), `base` = Geschoss-UK, auf die Z-Werte bezogen werden. Leere Teile ergeben
/// `flights: []`, `landing: None`, `rail: None`.
pub fn stair_parts(one: &Project, stair: &Stair, base: f64) -> StairParts {
    let (z_bottom, z_top) = one.stair_vertical_extent(stair);
    let rise = z_top - z_bottom;
    let geo = crate::stair::decode_geometry(&crate::stair::geometry(&stair.encode(), rise));
    let (riser_height, tread_depth, n_treads) = geo.as_ref().map_or((0.0, 0.0, 0), |g| (g.riser_height, g.tread_depth, g.treads.len()));
    let geo_landing = geo.as_ref().and_then(|g| g.landing.as_ref());
    let slabs = model3d::emit_stairs(one, false);
    let meshes = model3d::emit_stair_meshes(one);
    let predefined = if stair.shape == StairShape::Spiral { "SPIRAL" } else { "STRAIGHT" };

    // Podest nur bei "L" (bei der Wendel ist das Polygon die Treppenmitte, Teil des Laufs).
    let landing_idx = match (stair.shape, geo_landing) {
        (StairShape::L, Some(l)) => slabs.iter().position(|s| same_ring(&s.outline, l)),
        _ => None,
    };
    let tread_slabs: Vec<&RSlab> = slabs.iter().enumerate().filter(|(i, _)| Some(*i) != landing_idx).map(|(_, s)| s).collect();

    let mut groups: Vec<Vec<&RSlab>> = Vec::new();
    if let Some(li) = landing_idx {
        let top = slabs[li].z_top + EPS;
        let lower: Vec<&RSlab> = tread_slabs.iter().copied().filter(|s| s.z_top <= top).collect();
        let upper: Vec<&RSlab> = tread_slabs.iter().copied().filter(|s| s.z_top > top).collect();
        for g in [lower, upper] {
            if !g.is_empty() {
                groups.push(g);
            }
        }
    } else if !tread_slabs.is_empty() {
        groups.push(tread_slabs);
    }

    let mut flights: Vec<StairFlightParts> = Vec::new();
    let n_groups = groups.len();
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
        flights.push(StairFlightParts {
            name: if n_groups > 1 { format!("Lauf {}", k + 1) } else { "Lauf".to_string() },
            risers: treads,
            treads,
            riser_height,
            tread_length: tread_depth,
            predefined,
            quantities: flight_quantities(hypot2(run, lift), volume),
            body: FlightBody::Solids(solids),
        });
    }
    // Glatte Ortbeton-Laufplatte (gerade Betontreppe): ein Lauf als Netz.
    if !meshes.is_empty() {
        let (positions, indices) = concat(&meshes);
        let mesh = ifc_mesh(positions, &indices, base);
        let volume = mesh_volume(&mesh.positions, &mesh.indices);
        flights.push(StairFlightParts {
            name: if flights.is_empty() { "Lauf".to_string() } else { format!("Lauf {}", flights.len() + 1) },
            risers: n_treads as f64,
            treads: n_treads as f64,
            riser_height,
            tread_length: tread_depth,
            predefined,
            quantities: flight_quantities(hypot2(stair.run_length, rise), volume),
            body: FlightBody::Mesh(mesh),
        });
    }

    let landing = landing_idx.map(|li| {
        let s = solid_of(&slabs[li], base);
        let quantities = slab_quantities(&s.pts, &[], s.depth);
        Landing { pts: s.pts, z_rel: s.z_rel, depth: s.depth, quantities }
    });

    let rail_meshes = model3d::emit_stair_railings(one);
    let rail = (!rail_meshes.is_empty()).then(|| {
        let (positions, indices) = concat(&rail_meshes);
        let sides = if one.stair_type(stair).and_then(|t| t.railing) == Some(StairTypeRailing::Beide) { 2.0 } else { 1.0 };
        Rail { mesh: ifc_mesh(positions, &indices, base), quantities: railing_quantities(hypot2(stair.run_length, rise) * sides) }
    });
    StairParts { flights, landing, rail }
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
        assert!(parts.landing.is_none() && parts.rail.is_none());
    }

    #[test]
    fn l_treppe_zwei_laeufe_und_podest() {
        let st = stair(StairShape::L, None);
        let p = project_with(st.clone(), None);
        let parts = stair_parts(&p, &st, 0.0);
        assert_eq!(parts.flights.iter().map(|f| f.name.as_str()).collect::<Vec<_>>(), ["Lauf 1", "Lauf 2"]);
        let l = parts.landing.expect("Podest");
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
    }
}
