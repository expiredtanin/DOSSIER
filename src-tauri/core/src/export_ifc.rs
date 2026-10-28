//! IFC4-Export (STEP Physical File, ISO-10303-21) des Modells ([K4] S2, vorher
//! `src/export/exportIfc.ts`): Project → Site → Building → Storeys; Wände als öffnungsgenaue
//! Dreiecks-Netze (gleicher Loch-Ausschnitt wie STL/OBJ), Decken/Treppen/Körper/Stützen/Räume als
//! Profil-Extrusionen, Dächer als Schicht-Netze, Wand-/Deckentypen mit Materialschichten.
//! GUIDs deterministisch aus der Element-ID (zwei FNV-1a-64-Läufe, IFC-Base64-Kompression).
//! Geometrie in realen Weltkoordinaten (LV95), wenn `geoAnchor` gesetzt ist. Einheit: Meter.
//! Byte-genau wie die TS-Fassung (Zahlenformat über [`crate::js_fmt::to_fixed`]).

use crate::geo_rebase::project_to_world_coords;
use crate::js_fmt::to_fixed;
use crate::model::*;
use crate::model3d;
use crate::wall_mesh_cut::{is_watertight, wall_cut_mesh, CutWall};
use std::collections::HashMap;

// ── IFC-GUID ────────────────────────────────────────────────────────────────

const IFC_GUID_CHARS: &[u8] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$";

fn guid_b64(v: u64, len: usize) -> String {
    (0..len).rev().map(|i| IFC_GUID_CHARS[((v / 64u64.pow(i as u32)) % 64) as usize] as char).collect()
}

fn compress_guid(bytes: [u8; 16]) -> String {
    let mut out = guid_b64(bytes[0] as u64, 2);
    let mut i = 1;
    while i < 16 {
        let v = ((bytes[i] as u64) << 16) + ((bytes[i + 1] as u64) << 8) + bytes[i + 2] as u64;
        out.push_str(&guid_b64(v, 4));
        i += 3;
    }
    out
}

fn fnv1a64(s: &str, seed: u64) -> u64 {
    let mut hash = seed;
    // Wie TS: über UTF-16-Code-Einheiten (`charCodeAt`).
    for u in s.encode_utf16() {
        hash ^= u as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

/// Deterministische 22-stellige IFC-GUID aus einer beliebigen Element-ID.
pub fn ifc_guid(id: &str) -> String {
    let h1 = fnv1a64(id, 0xcbf29ce484222325);
    // Das Salz beginnt mit U+0001 (so steht es seit jeher in der TS-Fassung); beibehalten, damit
    // GUIDs über Re-Exporte und Versionen stabil bleiben.
    let h2 = fnv1a64(&format!("{id}\u{1}salt"), 0x9e3779b97f4a7c15);
    let mut bytes = [0u8; 16];
    bytes[..8].copy_from_slice(&h1.to_be_bytes());
    bytes[8..].copy_from_slice(&h2.to_be_bytes());
    compress_guid(bytes)
}

// ── STEP-Formatierung ───────────────────────────────────────────────────────

/// STEP-String-Literal: druckbares ASCII bleibt, `\` und `'` werden verdoppelt, alles andere als
/// `\X2\HHHH…\X0\` (BMP) bzw. `\X4\HHHHHHHH…\X0\`.
pub fn ifc_string(s: &str) -> String {
    let mut out = String::new();
    let mut run: Vec<u32> = Vec::new();
    fn flush(out: &mut String, run: &mut Vec<u32>) {
        if run.is_empty() {
            return;
        }
        let wide = run.iter().any(|&c| c > 0xffff);
        let hex: String = run.iter().map(|c| if wide { format!("{c:08X}") } else { format!("{c:04X}") }).collect();
        out.push_str(if wide { "\\X4\\" } else { "\\X2\\" });
        out.push_str(&hex);
        out.push_str("\\X0\\");
        run.clear();
    }
    for ch in s.chars() {
        let c = ch as u32;
        if (0x20..=0x7e).contains(&c) {
            flush(&mut out, &mut run);
            match ch {
                '\\' => out.push_str("\\\\"),
                '\'' => out.push_str("''"),
                _ => out.push(ch),
            }
        } else {
            if !run.is_empty() && (run[0] > 0xffff) != (c > 0xffff) {
                flush(&mut out, &mut run);
            }
            run.push(c);
        }
    }
    flush(&mut out, &mut run);
    format!("'{out}'")
}

fn s(x: &str) -> String {
    ifc_string(x)
}

/// STEP-REAL — immer mit Dezimalpunkt, ohne unnötige Nachkommastellen.
fn r(x: f64) -> String {
    let v = if x == 0.0 { 0.0 } else { x };
    let mut t = to_fixed(v, 6);
    let trimmed = t.trim_end_matches('0').len();
    t.truncate(trimmed);
    if t.ends_with('.') {
        t.push('0');
    }
    if !t.contains('.') {
        t.push_str(".0");
    }
    t
}

fn en(v: &str) -> String {
    format!(".{v}.")
}

fn list(items: &[String]) -> String {
    format!("({})", items.join(","))
}

fn refs(ids: &[usize]) -> String {
    list(&ids.iter().map(|i| format!("#{i}")).collect::<Vec<_>>())
}

struct StepWriter {
    lines: Vec<String>,
    next_id: usize,
}

impl StepWriter {
    fn add(&mut self, ty: &str, params: String) -> usize {
        let id = self.next_id;
        self.next_id += 1;
        self.lines.push(format!("#{id}={ty}({params});"));
        id
    }
}

// ── Geometrie-Helfer ────────────────────────────────────────────────────────

fn normalize(v: Vec2) -> Vec2 {
    let len = crate::jsmath::hypot2(v.x, v.y);
    let len = if len == 0.0 || len.is_nan() { 1.0 } else { len };
    Vec2 { x: v.x / len, y: v.y / len }
}

fn left_normal(u: Vec2) -> Vec2 {
    Vec2 { x: -u.y, y: u.x }
}

fn add_scaled(p: Vec2, d: Vec2, k: f64) -> Vec2 {
    Vec2 { x: p.x + d.x * k, y: p.y + d.y * k }
}

/// Rechteck-Footprint einer Öffnung im Wandloch (volle Wanddicke tief), CCW.
fn opening_footprint(p: &Project, wall: &Wall, o: &Opening) -> Vec<Vec2> {
    let u = normalize(Vec2 { x: wall.end.x - wall.start.x, y: wall.end.y - wall.start.y });
    let n = left_normal(u);
    let t = p.wall_type(wall).map_or(0.0, |wt| Project::type_thickness(&wt.layers));
    let off = crate::joins::reference_offset(model3d_reference(wall), t);
    let inner = -t / 2.0 + off;
    let outer = t / 2.0 + off;
    let a = add_scaled(wall.start, u, o.position);
    let b = add_scaled(wall.start, u, o.position + o.width);
    vec![add_scaled(a, n, inner), add_scaled(b, n, inner), add_scaled(b, n, outer), add_scaled(a, n, outer)]
}

fn model3d_reference(w: &Wall) -> crate::joins::Reference {
    use crate::joins::Reference;
    match (w.reference_offset, w.reference_line) {
        (Some(v), _) => Reference::Offset(v),
        (None, Some(WallReferenceLine::Left)) => Reference::Left,
        (None, Some(WallReferenceLine::Right)) => Reference::Right,
        _ => Reference::Center,
    }
}

/// Vereinfachter Bounding-Footprint einer Treppe (Lauf-Rechteck bzw. Box der Kontrollpunkte).
fn stair_footprint(st: &Stair) -> Vec<Vec2> {
    let half_w = st.width.max(0.0) / 2.0;
    if st.shape == StairShape::Straight {
        let u = normalize(st.dir);
        let n = left_normal(u);
        let end = add_scaled(st.start, u, st.run_length);
        return vec![add_scaled(st.start, n, -half_w), add_scaled(end, n, -half_w), add_scaled(end, n, half_w), add_scaled(st.start, n, half_w)];
    }
    let mut pts = vec![st.start];
    let u = normalize(st.dir);
    let corner = add_scaled(st.start, u, st.run_length);
    pts.push(corner);
    if st.shape == StairShape::L {
        if let (Some(run2), Some(turn)) = (st.run2_length.filter(|v| *v != 0.0), st.turn.filter(|v| *v != 0.0)) {
            let n = left_normal(u);
            let turn_dir = Vec2 { x: n.x * turn, y: n.y * turn };
            pts.push(add_scaled(corner, turn_dir, run2));
        }
    }
    if st.shape == StairShape::Spiral {
        if let Some(c) = st.center {
            let rr = st.radius.unwrap_or(0.0) + half_w;
            return vec![
                Vec2 { x: c.x - rr, y: c.y - rr },
                Vec2 { x: c.x + rr, y: c.y - rr },
                Vec2 { x: c.x + rr, y: c.y + rr },
                Vec2 { x: c.x - rr, y: c.y + rr },
            ];
        }
    }
    let (mut min_x, mut min_y, mut max_x, mut max_y) = (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
    for q in &pts {
        min_x = min_x.min(q.x);
        min_y = min_y.min(q.y);
        max_x = max_x.max(q.x);
        max_y = max_y.max(q.y);
    }
    min_x -= half_w;
    min_y -= half_w;
    max_x += half_w;
    max_y += half_w;
    vec![Vec2 { x: min_x, y: min_y }, Vec2 { x: max_x, y: min_y }, Vec2 { x: max_x, y: max_y }, Vec2 { x: min_x, y: max_y }]
}

fn opening_label(o: &Opening) -> String {
    format!("{} {}×{}", if o.kind == ElementKind::Door { "Tür" } else { "Fenster" }, to_fixed(o.width * 100.0, 0), to_fixed(o.height * 100.0, 0))
}

fn column_label(c: &Column) -> String {
    match &c.profile {
        ColumnProfile::Round { radius } => format!("Stütze Ø{}", to_fixed(radius * 200.0, 0)),
        ColumnProfile::Rect { width, depth } => format!("Stütze {}×{}", to_fixed(width * 100.0, 0), to_fixed(depth * 100.0, 0)),
    }
}

#[derive(Clone, Copy)]
struct Structure {
    entity_id: usize,
    placement_id: usize,
    base_elevation: f64,
}

struct ElementTypeRef {
    type_id: usize,
    occurrences: Vec<usize>,
}

/// Unix-Sekunden/ISO-Zeit aus Millisekunden seit 1970 (UTC), wie `Date.now()` / `toISOString()`.
fn iso_from_ms(ms: f64) -> String {
    let secs = (ms / 1000.0).floor() as i64;
    let days = secs.div_euclid(86_400);
    let tod = secs.rem_euclid(86_400);
    // Zivildatum aus Tagen (Howard Hinnant).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}", tod / 3600, (tod % 3600) / 60, tod % 60)
}

/// Baut aus einem Projekt einen vollständigen IFC4-SPF-String. `now_ms`: Zeitpunkt des Exports
/// (ms seit 1970). Leeres Projekt ⇒ valider Minimal-IFC. `Err`: das Modell lässt sich nicht
/// ableiten (z. B. unbekannter Wandtyp bei der Verschneidung).
pub fn export_ifc_spf(project_in: &Project, now_ms: f64) -> Result<String, String> {
    let project = project_to_world_coords(project_in);
    let p = &project;
    let mut w = StepWriter { lines: Vec::new(), next_id: 1 };

    let origin_point = w.add("IFCCARTESIANPOINT", list(&[r(0.0), r(0.0), r(0.0)]));
    let extrude_dir = w.add("IFCDIRECTION", list(&[r(0.0), r(0.0), r(1.0)]));
    let identity_axis = w.add("IFCAXIS2PLACEMENT3D", format!("#{origin_point},$,$"));

    let org = w.add("IFCORGANIZATION", format!("$,{},$,$,$", s("dossier")));
    let person = w.add("IFCPERSON", format!("{},$,$,$,$,$,$,$", s("dossier")));
    let person_org = w.add("IFCPERSONANDORGANIZATION", format!("#{person},#{org},$"));
    let app = w.add("IFCAPPLICATION", format!("#{org},{},{},{}", s("1.0"), s("dossier"), s("dossier")));
    let now = (now_ms / 1000.0).floor() as i64;
    let owner_history = w.add("IFCOWNERHISTORY", format!("#{person_org},#{app},$,{},{now},$,$,{now}", en("ADDED")));

    let len_unit = w.add("IFCSIUNIT", format!("*,{},$,{}", en("LENGTHUNIT"), en("METRE")));
    let area_unit = w.add("IFCSIUNIT", format!("*,{},$,{}", en("AREAUNIT"), en("SQUARE_METRE")));
    let vol_unit = w.add("IFCSIUNIT", format!("*,{},$,{}", en("VOLUMEUNIT"), en("CUBIC_METRE")));
    let angle_unit = w.add("IFCSIUNIT", format!("*,{},$,{}", en("PLANEANGLEUNIT"), en("RADIAN")));
    let unit_assignment = w.add("IFCUNITASSIGNMENT", refs(&[len_unit, area_unit, vol_unit, angle_unit]));

    let context = w.add("IFCGEOMETRICREPRESENTATIONCONTEXT", format!("$,{},3,{},#{identity_axis},$", s("Model"), r(0.00001)));

    if p.geo_anchor.is_some() {
        let crs = w.add(
            "IFCPROJECTEDCRS",
            format!("{},{},{},$,{},$,#{len_unit}", s("EPSG:2056"), s("CH1903+ / LV95"), s("CH1903+"), s("Swiss Oblique Mercator")),
        );
        w.add("IFCMAPCONVERSION", format!("#{context},#{crs},{},{},{},{},{},{}", r(0.0), r(0.0), r(0.0), r(1.0), r(0.0), r(1.0)));
    }

    let site_axis = w.add("IFCAXIS2PLACEMENT3D", format!("#{origin_point},$,$"));
    let site_placement = w.add("IFCLOCALPLACEMENT", format!("$,#{site_axis}"));
    let building_axis = w.add("IFCAXIS2PLACEMENT3D", format!("#{origin_point},$,$"));
    let building_placement = w.add("IFCLOCALPLACEMENT", format!("#{site_placement},#{building_axis}"));

    let project_id = w.add(
        "IFCPROJECT",
        format!(
            "{},#{owner_history},{},$,$,$,$,{},#{unit_assignment}",
            s(&ifc_guid(&format!("{}:project", p.id))),
            s(if p.name.is_empty() { "Projekt" } else { &p.name }),
            refs(&[context])
        ),
    );
    let site_ref_elev = p.geo_anchor.as_ref().and_then(|a| a.height).map_or("$".to_string(), r);
    let site_id = w.add(
        "IFCSITE",
        format!(
            "{},#{owner_history},{},$,$,#{site_placement},$,$,{},$,$,{site_ref_elev},$,$",
            s(&ifc_guid(&format!("{}:site", p.id))),
            s("Standort"),
            en("ELEMENT")
        ),
    );
    let building_id = w.add(
        "IFCBUILDING",
        format!(
            "{},#{owner_history},{},$,$,#{building_placement},$,$,{},$,$,$",
            s(&ifc_guid(&format!("{}:building", p.id))),
            s(if p.name.is_empty() { "Gebäude" } else { &p.name }),
            en("ELEMENT")
        ),
    );
    w.add("IFCRELAGGREGATES", format!("{},#{owner_history},$,$,#{project_id},{}", s(&ifc_guid(&format!("{}:agg-site", p.id))), refs(&[site_id])));
    w.add("IFCRELAGGREGATES", format!("{},#{owner_history},$,$,#{site_id},{}", s(&ifc_guid(&format!("{}:agg-building", p.id))), refs(&[building_id])));

    let floors: Vec<&DrawingLevel> = p.drawing_levels.iter().filter(|l| l.kind == DrawingLevelKind::Floor).collect();
    let mut storey_by_floor: HashMap<&str, Structure> = HashMap::new();
    let mut storey_ids = Vec::new();
    for floor in &floors {
        let base = floor.base_elevation.unwrap_or(0.0);
        let pt = w.add("IFCCARTESIANPOINT", list(&[r(0.0), r(0.0), r(base)]));
        let axis = w.add("IFCAXIS2PLACEMENT3D", format!("#{pt},$,$"));
        let placement_id = w.add("IFCLOCALPLACEMENT", format!("#{building_placement},#{axis}"));
        let entity_id = w.add(
            "IFCBUILDINGSTOREY",
            format!("{},#{owner_history},{},$,$,#{placement_id},$,$,{},{}", s(&ifc_guid(&format!("{}:storey", floor.id))), s(&floor.name), en("ELEMENT"), r(base)),
        );
        storey_by_floor.entry(floor.id.as_str()).or_insert(Structure { entity_id, placement_id, base_elevation: base });
        storey_ids.push(entity_id);
    }
    if !storey_ids.is_empty() {
        w.add("IFCRELAGGREGATES", format!("{},#{owner_history},$,$,#{building_id},{}", s(&ifc_guid(&format!("{}:agg-storeys", p.id))), refs(&storey_ids)));
    }

    let resolve_structure = |floor_id: &str| -> Structure {
        storey_by_floor.get(floor_id).copied().unwrap_or(Structure { entity_id: building_id, placement_id: building_placement, base_elevation: 0.0 })
    };

    // Räumliche Eingliederung je Trägerstruktur, in Einfüge-Reihenfolge.
    let mut containment: Vec<(usize, Vec<usize>)> = Vec::new();
    let mut add_to_containment = |structure: usize, element: usize| match containment.iter_mut().find(|(k, _)| *k == structure) {
        Some((_, v)) => v.push(element),
        None => containment.push((structure, vec![element])),
    };

    macro_rules! emit_box_product {
        ($footprint:expr, $z_bottom_rel:expr, $depth:expr, $placement_rel_to:expr) => {{
            let footprint: &[Vec2] = $footprint;
            let mut closed: Vec<Vec2> = footprint.to_vec();
            closed.push(footprint[0]);
            let pt_ids: Vec<usize> = closed.iter().map(|q| w.add("IFCCARTESIANPOINT", list(&[r(q.x), r(q.y)]))).collect();
            let polyline = w.add("IFCPOLYLINE", refs(&pt_ids));
            let profile = w.add("IFCARBITRARYCLOSEDPROFILEDEF", format!("{},$,#{polyline}", en("AREA")));
            let solid = w.add("IFCEXTRUDEDAREASOLID", format!("#{profile},#{identity_axis},#{extrude_dir},{}", r(($depth as f64).max(0.001))));
            let shape_rep = w.add("IFCSHAPEREPRESENTATION", format!("#{context},{},{},{}", s("Body"), s("SweptSolid"), refs(&[solid])));
            let shape = w.add("IFCPRODUCTDEFINITIONSHAPE", format!("$,$,{}", refs(&[shape_rep])));
            let elem_origin = w.add("IFCCARTESIANPOINT", list(&[r(0.0), r(0.0), r($z_bottom_rel)]));
            let elem_axis = w.add("IFCAXIS2PLACEMENT3D", format!("#{elem_origin},$,$"));
            let placement = w.add("IFCLOCALPLACEMENT", format!("#{},#{elem_axis}", $placement_rel_to));
            (placement, shape)
        }};
    }

    macro_rules! emit_triangulated_product {
        ($positions:expr, $indices:expr, $placement_rel_to:expr, $closed:expr) => {{
            let positions: &[f64] = $positions;
            let indices: &[u32] = $indices;
            let coords: Vec<String> = positions.chunks_exact(3).map(|c| format!("({},{},{})", r(c[0]), r(c[1]), r(c[2]))).collect();
            let point_list = w.add("IFCCARTESIANPOINTLIST3D", format!("({})", coords.join(",")));
            let tris: Vec<String> = indices.chunks_exact(3).map(|t| format!("({},{},{})", t[0] + 1, t[1] + 1, t[2] + 1)).collect();
            let closed_flag = if $closed { ".T." } else { "$" };
            let face_set = w.add("IFCTRIANGULATEDFACESET", format!("#{point_list},$,{closed_flag},({}),$", tris.join(",")));
            let shape_rep = w.add("IFCSHAPEREPRESENTATION", format!("#{context},{},{},{}", s("Body"), s("Tessellation"), refs(&[face_set])));
            let shape = w.add("IFCPRODUCTDEFINITIONSHAPE", format!("$,$,{}", refs(&[shape_rep])));
            let elem_origin = w.add("IFCCARTESIANPOINT", list(&[r(0.0), r(0.0), r(0.0)]));
            let elem_axis = w.add("IFCAXIS2PLACEMENT3D", format!("#{elem_origin},$,$"));
            let placement = w.add("IFCLOCALPLACEMENT", format!("#{},#{elem_axis}", $placement_rel_to));
            (placement, shape)
        }};
    }

    macro_rules! emit_building_element {
        ($ty:expr, $guid:expr, $name:expr, $placement:expr, $shape:expr, $predefined:expr) => {
            w.add($ty, format!("{},#{owner_history},{},$,$,#{},#{},$,{}", s(&$guid), s(&$name), $placement, $shape, $predefined.unwrap_or_else(|| "$".to_string())))
        };
    }

    // ── Bauteiltypen mit Materialschichten ──
    let mut material_by_component: HashMap<String, usize> = HashMap::new();
    let mut element_types: Vec<(String, ElementTypeRef)> = Vec::new();
    macro_rules! material_of {
        ($component_id:expr) => {{
            let cid: &str = $component_id;
            match material_by_component.get(cid) {
                Some(&id) => id,
                None => {
                    let name = p.component(cid).map_or(cid.to_string(), |c| c.name.clone());
                    let id = w.add("IFCMATERIAL", format!("{},$,$", s(&name)));
                    material_by_component.insert(cid.to_string(), id);
                    id
                }
            }
        }};
    }
    macro_rules! type_for {
        ($ifc_type:expr, $predefined:expr, $t_id:expr, $t_name:expr, $layers:expr) => {{
            let key = format!("{}:{}", $ifc_type, $t_id);
            match element_types.iter().position(|(k, _)| *k == key) {
                Some(i) => i,
                None => {
                    let layers: &[Layer] = $layers;
                    let layer_ids: Vec<usize> = layers
                        .iter()
                        .map(|l| {
                            let mat = material_of!(&l.component_id);
                            let th = if l.thickness.is_finite() { l.thickness } else { 0.0 };
                            w.add("IFCMATERIALLAYER", format!("#{mat},{},$,$,$,$,$", r(th.max(0.0))))
                        })
                        .collect();
                    let type_id = w.add($ifc_type, format!("{},#{owner_history},{},$,$,$,$,$,$,{}", s(&ifc_guid(&key)), s($t_name), en($predefined)));
                    if !layer_ids.is_empty() {
                        let set = w.add("IFCMATERIALLAYERSET", format!("{},{},$", refs(&layer_ids), s($t_name)));
                        w.add("IFCRELASSOCIATESMATERIAL", format!("{},#{owner_history},$,$,{},#{set}", s(&ifc_guid(&format!("{key}:material"))), refs(&[type_id])));
                    }
                    element_types.push((key, ElementTypeRef { type_id, occurrences: vec![] }));
                    element_types.len() - 1
                }
            }
        }};
    }

    // ── Wände (öffnungsgenaues Dreiecks-Mesh) ──
    let bands = model3d::emit_walls(p, true)?;
    let mut bands_by_wall: HashMap<&str, Vec<usize>> = HashMap::new();
    for (i, b) in bands.iter().enumerate() {
        bands_by_wall.entry(b.wall_id.as_str()).or_default().push(i);
    }
    let mut wall_entity_by_id: HashMap<&str, usize> = HashMap::new();
    for wall in &p.walls {
        let Some(idxs) = bands_by_wall.get(wall.id.as_str()).filter(|v| !v.is_empty()) else { continue };
        let structure = resolve_structure(&wall.floor_id);
        let mut positions: Vec<f64> = Vec::new();
        let mut indices: Vec<u32> = Vec::new();
        for &bi in idxs {
            let b = &bands[bi];
            let cw = CutWall {
                start: b.start,
                end: b.end,
                thickness: b.thickness,
                base_elevation: b.base_elevation,
                height: b.height,
                holes: b.holes.as_ref().map_or(vec![], |hs| hs.iter().map(|h| [h.from, h.to, h.z_bottom, h.z_top]).collect()),
            };
            let finite = cw.start.iter().chain(&cw.end).all(|v| v.is_finite()) && [cw.thickness, cw.base_elevation, cw.height].iter().all(|v| v.is_finite()) && cw.holes.iter().flatten().all(|v| v.is_finite());
            let cut = if finite { wall_cut_mesh(&cw) } else { Vec::new() };
            let base = (positions.len() / 3) as u32;
            for c in cut.chunks_exact(3) {
                positions.extend([c[0], c[2], c[1] - structure.base_elevation]);
            }
            // Wicklung umkehren (Reflexions-Ausgleich des Achsentauschs): (a, b, c) → (a, c, b).
            let n_tris = (cut.len() / 3) as u32 / 3;
            for t in 0..n_tris {
                let i = t * 3;
                indices.extend([base + i, base + i + 2, base + i + 1]);
            }
        }
        if indices.is_empty() {
            continue;
        }
        let closed = is_watertight(&positions, &indices, 1e-6);
        let (placement, shape) = emit_triangulated_product!(&positions, &indices, structure.placement_id, closed);
        let mut name = wall.id.clone();
        let mut type_idx = None;
        if let Some(wt) = p.wall_type(wall) {
            name = wt.name.clone();
            type_idx = Some(type_for!("IFCWALLTYPE", "STANDARD", wt.id, &wt.name, &wt.layers));
        }
        let entity = emit_building_element!("IFCWALL", ifc_guid(&wall.id), name, placement, shape, None::<String>);
        if let Some(i) = type_idx {
            element_types[i].1.occurrences.push(entity);
        }
        wall_entity_by_id.insert(wall.id.as_str(), entity);
        add_to_containment(structure.entity_id, entity);
    }

    // ── Decken ──
    for ceiling in p.ceilings.as_deref().unwrap_or(&[]) {
        if ceiling.outline.len() < 3 {
            continue;
        }
        let (z_bottom, z_top) = p.ceiling_vertical_extent(ceiling);
        let structure = resolve_structure(&ceiling.floor_id);
        let (placement, shape) = emit_box_product!(&ceiling.outline, z_bottom - structure.base_elevation, z_top - z_bottom, structure.placement_id);
        let mut name = ceiling.id.clone();
        let mut type_idx = None;
        if let Some((tid, tname, layers)) = ceiling_type_of(p, ceiling) {
            name = tname.to_string();
            type_idx = Some(type_for!("IFCSLABTYPE", "FLOOR", tid, tname, layers));
        }
        let entity = emit_building_element!("IFCSLAB", ifc_guid(&ceiling.id), name, placement, shape, Some(en("FLOOR")));
        if let Some(i) = type_idx {
            element_types[i].1.occurrences.push(entity);
        }
        add_to_containment(structure.entity_id, entity);
    }

    // ── Fenster/Türen als eigene Objekte ──
    for opening in p.openings.as_deref().unwrap_or(&[]) {
        let Some(wall) = p.walls.iter().find(|wl| wl.id == opening.host_wall_id) else { continue };
        if !wall_entity_by_id.contains_key(wall.id.as_str()) {
            continue;
        }
        let (wall_z_bottom, _) = p.wall_vertical_extent(wall);
        let structure = resolve_structure(&wall.floor_id);
        let footprint = opening_footprint(p, wall, opening);
        let z_sill_abs = wall_z_bottom + opening.sill_height;
        let (fill_placement, fill_shape) = emit_box_product!(&footprint, z_sill_abs - structure.base_elevation, opening.height, structure.placement_id);
        let fill_guid = ifc_guid(&format!("{}:fill", opening.id));
        let fill_name = opening_label(opening);
        let entity = if opening.kind == ElementKind::Door {
            w.add(
                "IFCDOOR",
                format!("{},#{owner_history},{},$,$,#{fill_placement},#{fill_shape},$,{},{},{},$,$", s(&fill_guid), s(&fill_name), r(opening.height), r(opening.width), en("DOOR")),
            )
        } else {
            w.add(
                "IFCWINDOW",
                format!("{},#{owner_history},{},$,$,#{fill_placement},#{fill_shape},$,{},{},{},$,$", s(&fill_guid), s(&fill_name), r(opening.height), r(opening.width), en("WINDOW")),
            )
        };
        add_to_containment(structure.entity_id, entity);
    }

    // ── Treppen ──
    for stair in p.stairs.as_deref().unwrap_or(&[]) {
        let footprint = stair_footprint(stair);
        if footprint.len() < 3 {
            continue;
        }
        let (z_bottom, z_top) = p.stair_vertical_extent(stair);
        let structure = resolve_structure(&stair.floor_id);
        let (placement, shape) = emit_box_product!(&footprint, z_bottom - structure.base_elevation, z_top - z_bottom, structure.placement_id);
        let predefined = match stair.shape {
            StairShape::Straight => en("STRAIGHT_RUN_STAIR"),
            StairShape::Spiral => en("SPIRAL_STAIR"),
            StairShape::L => en("QUARTER_TURN_STAIR"),
        };
        let entity = emit_building_element!("IFCSTAIR", ifc_guid(&stair.id), "Treppe".to_string(), placement, shape, Some(predefined));
        add_to_containment(structure.entity_id, entity);
    }

    // ── Extrudierte Körper ──
    for solid in p.extruded_solids.as_deref().unwrap_or(&[]) {
        if solid.points.len() < 3 {
            continue;
        }
        let base = floors.iter().find(|f| f.id == solid.level_id).map_or(0.0, |f| f.base_elevation.unwrap_or(0.0));
        let structure = resolve_structure(&solid.level_id);
        let (placement, shape) = emit_box_product!(&solid.points, base - structure.base_elevation, solid.height, structure.placement_id);
        let entity = emit_building_element!("IFCBUILDINGELEMENTPROXY", ifc_guid(&solid.id), "Extrusion".to_string(), placement, shape, None::<String>);
        add_to_containment(structure.entity_id, entity);
    }

    // ── Räume → IfcSpace ──
    let mut spaces_by_structure: Vec<(usize, Vec<usize>)> = Vec::new();
    for room in p.rooms.as_deref().unwrap_or(&[]) {
        if room.boundary.len() < 3 {
            continue;
        }
        let structure = resolve_structure(&room.floor_id);
        let height = floors.iter().find(|f| f.id == room.floor_id).and_then(|f| f.floor_height).filter(|h| *h > 0.0).unwrap_or(2.5);
        let (placement, shape) = emit_box_product!(&room.boundary, 0.0, height, structure.placement_id);
        let number = room.stamp.as_ref().and_then(|st| st.number.as_deref()).filter(|n| !n.is_empty()).unwrap_or(&room.id);
        let space_id = w.add(
            "IFCSPACE",
            format!("{},#{owner_history},{},$,$,#{placement},#{shape},{},{},{},$", s(&ifc_guid(&room.id)), s(number), s(&room.name), en("ELEMENT"), en("INTERNAL")),
        );
        match spaces_by_structure.iter_mut().find(|(k, _)| *k == structure.entity_id) {
            Some((_, v)) => v.push(space_id),
            None => spaces_by_structure.push((structure.entity_id, vec![space_id])),
        }
        let pts: Vec<[f64; 2]> = room.boundary.iter().map(|v| [v.x, v.y]).collect();
        let area = crate::room_area::evaluate(&pts, 0.0);
        let q_net = w.add("IFCQUANTITYAREA", format!("{},$,$,{},$", s("NetFloorArea"), r(area.net)));
        let q_gross = w.add("IFCQUANTITYAREA", format!("{},$,$,{},$", s("GrossFloorArea"), r(area.gross)));
        let q_height = w.add("IFCQUANTITYLENGTH", format!("{},$,$,{},$", s("Height"), r(height)));
        let qto = w.add(
            "IFCELEMENTQUANTITY",
            format!("{},#{owner_history},{},$,$,{}", s(&ifc_guid(&format!("{}:qto", room.id))), s("Qto_SpaceBaseQuantities"), refs(&[q_net, q_gross, q_height])),
        );
        w.add("IFCRELDEFINESBYPROPERTIES", format!("{},#{owner_history},$,$,{},#{qto}", s(&ifc_guid(&format!("{}:rel-qto", room.id))), refs(&[space_id])));
        let sia_name = serde_json::to_value(room.sia_category).ok().and_then(|v| v.as_str().map(str::to_owned)).unwrap_or_default();
        let sia = w.add("IFCPROPERTYSINGLEVALUE", format!("{},$,IFCLABEL({}),$", s("SIA416"), s(&sia_name)));
        let pset = w.add("IFCPROPERTYSET", format!("{},#{owner_history},{},$,{}", s(&ifc_guid(&format!("{}:pset", room.id))), s("CH_Raum"), refs(&[sia])));
        w.add("IFCRELDEFINESBYPROPERTIES", format!("{},#{owner_history},$,$,{},#{pset}", s(&ifc_guid(&format!("{}:rel-pset", room.id))), refs(&[space_id])));
    }
    for (structure_id, space_ids) in &spaces_by_structure {
        w.add("IFCRELAGGREGATES", format!("{},#{owner_history},$,$,#{structure_id},{}", s(&ifc_guid(&format!("spaces:{structure_id}"))), refs(space_ids)));
    }

    // ── Dächer → IfcRoof ──
    for roof in p.roofs.as_deref().unwrap_or(&[]) {
        let structure = resolve_structure(&roof.floor_id);
        let mut positions: Vec<f64> = Vec::new();
        let mut indices: Vec<u32> = Vec::new();
        for mesh in model3d::emit_roofs(p, Some(&roof.id))? {
            let base = (positions.len() / 3) as u32;
            for c in mesh.positions.chunks_exact(3) {
                positions.extend([c[0], c[1], c[2] - structure.base_elevation]);
            }
            indices.extend(mesh.indices.iter().map(|ix| base + ix));
        }
        if indices.is_empty() {
            continue;
        }
        let mut closed = is_watertight(&positions, &indices, 1e-6);
        if !closed {
            let flipped: Vec<u32> = indices.chunks_exact(3).flat_map(|t| [t[0], t[2], t[1]]).collect();
            if is_watertight(&positions, &flipped, 1e-6) {
                indices = flipped;
                closed = true;
            }
        }
        let (placement, shape) = emit_triangulated_product!(&positions, &indices, structure.placement_id, closed);
        let predefined = match roof.shape {
            RoofShape::Flach => "FLAT_ROOF",
            RoofShape::Pult => "SHED_ROOF",
            RoofShape::Sattel => "GABLE_ROOF",
            RoofShape::Walm => "HIP_ROOF",
            RoofShape::Mansarde => "MANSARD_ROOF",
            RoofShape::Zelt => "HIPPED_GABLE_ROOF",
        };
        let roof_type = roof.roof_type_id.as_deref().and_then(|id| p.roof_types.as_deref()?.iter().find(|t| t.id == id));
        let name = roof_type.map_or("Dach".to_string(), |t| t.name.clone());
        let entity = emit_building_element!("IFCROOF", ifc_guid(&roof.id), name, placement, shape, Some(en(predefined)));
        if let Some(rt) = roof_type {
            let i = type_for!("IFCROOFTYPE", predefined, rt.id, &rt.name, &rt.layers);
            element_types[i].1.occurrences.push(entity);
        }
        add_to_containment(structure.entity_id, entity);
    }

    // ── Stützen → IfcColumn ──
    let mut material_assoc: Vec<(usize, Vec<usize>)> = Vec::new();
    for col in p.columns.as_deref().unwrap_or(&[]) {
        let footprint = model3d::column_footprint(col);
        if footprint.len() < 3 {
            continue;
        }
        let (z_bottom, z_top) = p.column_vertical_extent(col);
        if !(z_top > z_bottom) {
            continue;
        }
        let structure = resolve_structure(&col.floor_id);
        let (placement, shape) = emit_box_product!(&footprint, z_bottom - structure.base_elevation, z_top - z_bottom, structure.placement_id);
        let entity = emit_building_element!("IFCCOLUMN", ifc_guid(&col.id), column_label(col), placement, shape, Some(en("COLUMN")));
        add_to_containment(structure.entity_id, entity);
        if let Some(cid) = col.component_id.as_deref().filter(|c| !c.is_empty()) {
            let mat = material_of!(cid);
            match material_assoc.iter_mut().find(|(k, _)| *k == mat) {
                Some((_, v)) => v.push(entity),
                None => material_assoc.push((mat, vec![entity])),
            }
        }
    }
    for (mat, ids) in &material_assoc {
        w.add("IFCRELASSOCIATESMATERIAL", format!("{},#{owner_history},$,$,{},#{mat}", s(&ifc_guid(&format!("material:{mat}"))), refs(ids)));
    }

    // ── Typ-Zuordnung ──
    for (key, rf) in &element_types {
        if rf.occurrences.is_empty() {
            continue;
        }
        w.add("IFCRELDEFINESBYTYPE", format!("{},#{owner_history},$,$,{},#{}", s(&ifc_guid(&format!("{key}:occurrences"))), refs(&rf.occurrences), rf.type_id));
    }

    // ── Räumliche Eingliederung ──
    for (structure_id, element_ids) in &containment {
        w.add("IFCRELCONTAINEDINSPATIALSTRUCTURE", format!("{},#{owner_history},$,$,{},#{structure_id}", s(&ifc_guid(&format!("contain:{structure_id}"))), refs(element_ids)));
    }

    // ── Kopf + Zusammenbau ──
    let iso = iso_from_ms(now_ms);
    let file_name = format!("{}.ifc", if p.name.is_empty() { "modell" } else { &p.name });
    let mut out = vec![
        "ISO-10303-21;".to_string(),
        "HEADER;".to_string(),
        format!("FILE_DESCRIPTION({},{});", list(&[s("")]), s("2;1")),
        format!("FILE_NAME({},{},{},{},{},{},{});", s(&file_name), s(&iso), list(&[s("dossier")]), list(&[s("dossier")]), s("dossier"), s("dossier"), s("")),
        "FILE_SCHEMA(('IFC4'));".to_string(),
        "ENDSEC;".to_string(),
        String::new(),
        "DATA;".to_string(),
    ];
    out.extend(w.lines);
    out.push("ENDSEC;".to_string());
    out.push("END-ISO-10303-21;".to_string());
    Ok(out.join("\n") + "\n")
}

/// Deckentyp (id, Name, Schichten): Deckentyp, sonst Wandtyp (`getCeilingType`).
fn ceiling_type_of<'a>(p: &'a Project, c: &Ceiling) -> Option<(&'a str, &'a str, &'a [Layer])> {
    if let Some(id) = c.ceiling_type_id.as_deref() {
        if let Some(t) = p.ceiling_types.as_deref().and_then(|v| v.iter().find(|t| t.id == id)) {
            return Some((&t.id, &t.name, &t.layers));
        }
    }
    p.wall_types.iter().find(|t| t.id == c.wall_type_id).map(|t| (t.id.as_str(), t.name.as_str(), t.layers.as_slice()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn guid_ist_stabil_und_22_zeichen_lang() {
        let g = ifc_guid("wall-1");
        assert_eq!(g.len(), 22);
        assert_eq!(g, ifc_guid("wall-1"));
        assert_ne!(g, ifc_guid("wall-2"));
    }

    #[test]
    fn string_und_zahl_literale() {
        assert_eq!(ifc_string("A'b\\ü😀"), "'A''b\\\\\\X2\\00FC\\X0\\\\X4\\0001F600\\X0\\'");
        assert_eq!(r(1.0), "1.0");
        assert_eq!(r(-0.0), "0.0");
        assert_eq!(r(0.1234567), "0.123457");
        assert_eq!(r(2.5), "2.5");
    }

    #[test]
    fn iso_datum() {
        assert_eq!(iso_from_ms(0.0), "1970-01-01T00:00:00");
        assert_eq!(iso_from_ms(1_700_000_000_000.0), "2023-11-14T22:13:20");
    }

    #[test]
    fn beispielprojekt_exportiert() {
        let p: Project = serde_json::from_str(include_str!("../tests/fixtures/sample_project.json")).unwrap();
        let ifc = export_ifc_spf(&p, 1_700_000_000_000.0).unwrap();
        assert!(ifc.starts_with("ISO-10303-21;\nHEADER;"));
        assert!(ifc.contains("IFCWALL("));
        assert!(ifc.ends_with("END-ISO-10303-21;\n"));
    }
}
