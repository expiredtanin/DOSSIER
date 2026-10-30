//! Kontext-Meshes aus Importen ([K4] S4, vorher `io/ifcImport.ts::ifcToImportedMeshes`,
//! `io/meshImport.ts::meshObjectsToImportedMeshes`, `model/contextCategories.ts::ensureContextCategories`
//! und die Op-Bauer im CLI/`siteSlice`): IFC-Bauteile ([B3]) und Objekte aus OBJ/STL/glTF/PLY ([C11]) werden
//! zu `ImportedMesh` der Kontext-Schicht, fehlende Kontext-Kategorien werden im Ebenen-Baum ergänzt.
//!
//! Eingaben sind die flachen Puffer des Format-Moduls (`fileio/src/ifc_import.rs`: Bericht als JSON +
//! Positionen/Indizes; `fileio/src/mesh_import.rs`: Zahlenpuffer + Strings). Zahlen wie in der TS-Fassung
//! (`Math.hypot`, `Math.round`), ids aus Zeit (Basis 36) + Zähler.

use crate::grips::js_num;
use crate::import_drawing::{next_seq, GENERIC_IMPORT_CODE};
use crate::jsmath;
use crate::jsnum;
use crate::ops::Op;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};

// ── Kontext-Kategorien ───────────────────────────────────────────────────────

struct Def {
    code: &'static str,
    name: &'static str,
    color: &'static str,
    lw: f64,
}

/// „05 Kontext" — Elternkategorie der Kontext-Kategorien.
const CONTEXT_PARENT: Def = Def { code: "05", name: "Kontext", color: "#707078", lw: 0.13 };
/// „31 Dächer" bleibt oberste Ebene.
const IMPORTED_ROOF: Def = Def { code: "31", name: "Dächer", color: "#7a4a3a", lw: 0.35 };
/// Kinder von „05 Kontext", in dieser Reihenfolge (`NESTED_CONTEXT_CATEGORIES`).
const NESTED: [Def; 10] = [
    Def { code: "02", name: "Gelände", color: "#8a9478", lw: 0.13 },
    Def { code: "03", name: "Luftbild", color: "#707078", lw: 0.13 },
    Def { code: "10", name: "Situation", color: "#909090", lw: 0.18 },
    Def { code: "12", name: "Gebäude", color: "#888888", lw: 0.25 },
    Def { code: "11", name: "Strasse", color: "#a89070", lw: 0.18 },
    Def { code: "04", name: "Wald", color: "#3a7a3a", lw: 0.13 },
    Def { code: "15", name: "Parkplätze", color: "#a0a0a0", lw: 0.13 },
    Def { code: "16", name: "Bahn", color: "#606060", lw: 0.18 },
    Def { code: "17", name: "Gewässer", color: "#5a90b0", lw: 0.13 },
    Def { code: "18", name: "Grünflächen", color: "#70b070", lw: 0.13 },
];

fn category(d: &Def) -> Value {
    json!({"code": d.code, "name": d.name, "color": d.color, "lw": d.lw, "visible": true, "locked": false})
}

/// Ergänzt `layers` um jede fehlende Kontext-Kategorie aus `codes` (vorhandene Codes, auch umbenannte, bleiben).
/// Fehlende Kinder landen unter „05 Kontext" (bei Bedarf angelegt), „31 Dächer" oben. `true` = geändert.
pub fn ensure_context_categories<'a>(layers: &mut Vec<Value>, codes: impl IntoIterator<Item = &'a str>) -> bool {
    let existing: HashSet<String> =
        crate::layers::flatten(layers).into_iter().filter_map(|c| c.get("code").and_then(Value::as_str).map(str::to_string)).collect();
    let missing: HashSet<&str> = codes.into_iter().filter(|c| !existing.contains(*c)).collect();
    if missing.is_empty() {
        return false;
    }
    let nested: Vec<Value> = NESTED.iter().filter(|d| missing.contains(d.code)).map(category).collect();
    let added_nested = !nested.is_empty();
    if added_nested {
        match layers.iter().position(|l| l.get("code").and_then(Value::as_str) == Some(CONTEXT_PARENT.code)) {
            Some(i) => {
                let mut l = layers[i].as_object().cloned().unwrap_or_default();
                let mut kids = l.get("children").and_then(Value::as_array).cloned().unwrap_or_default();
                kids.extend(nested);
                l.insert("children".into(), Value::Array(kids));
                layers[i] = Value::Object(l);
            }
            None => {
                let mut p = category(&CONTEXT_PARENT);
                p.as_object_mut().unwrap().insert("children".into(), Value::Array(nested));
                layers.push(p);
            }
        }
    }
    let roof = missing.contains(IMPORTED_ROOF.code);
    if roof {
        layers.push(category(&IMPORTED_ROOF));
    }
    added_nested || roof
}

/// Ops: Kontext-Objekte anhängen (fehlt die Liste, wird sie gesetzt) und fehlende Kontext-Kategorien ergänzen.
pub fn context_ops(root: &Map<String, Value>, meshes: Vec<Value>) -> Vec<Op> {
    let codes: Vec<String> = meshes.iter().filter_map(|m| m.get("categoryCode").and_then(Value::as_str).filter(|c| !c.is_empty()).map(str::to_string)).collect();
    let mut ops = Vec::new();
    if root.get("context").is_some_and(|c| !c.is_null()) {
        if !meshes.is_empty() {
            ops.push(Op::Add { collection: "context".into(), items: meshes, at: None });
        }
    } else {
        ops.push(Op::SetField { key: "context".into(), value: Some(Value::Array(meshes)), at: None });
    }
    let mut layers = root.get("layers").and_then(Value::as_array).cloned().unwrap_or_default();
    if ensure_context_categories(&mut layers, codes.iter().map(String::as_str)) {
        ops.push(Op::SetField { key: "layers".into(), value: Some(Value::Array(layers)), at: None });
    }
    ops
}

// ── Gemeinsames ──────────────────────────────────────────────────────────────

/// `Date.now().toString(36)`.
pub fn stamp36(now: f64) -> String {
    let mut n = if now.is_finite() && now > 0.0 { now.trunc() as u64 } else { 0 };
    if n == 0 {
        return "0".into();
    }
    let mut d = Vec::new();
    while n > 0 {
        d.push(std::char::from_digit((n % 36) as u32, 36).unwrap());
        n /= 36;
    }
    d.iter().rev().collect()
}

/// Dateiname ohne letzte Endung (`name.replace(/\.[^.]+$/, "")`), leer → `fallback`.
pub fn base_name(file: &str, fallback: &str) -> String {
    let b = match file.rfind('.') {
        Some(i) if i + 1 < file.len() => &file[..i],
        _ => file,
    };
    if b.is_empty() { fallback.to_string() } else { b.to_string() }
}

/// RGBA 0..1 → `#rrggbb` (`rgbToHex`, Alpha entfällt); `None` ohne gültige Farbe.
pub fn color_hex(c: Option<&[f64]>) -> Option<String> {
    let c = c?;
    if c.len() < 3 || !c[..3].iter().all(|v| v.is_finite()) {
        return None;
    }
    let h = |v: f64| jsnum::max(0.0, jsnum::min(255.0, jsnum::round(v * 255.0))) as u32;
    Some(format!("#{:02x}{:02x}{:02x}", h(c[0]), h(c[1]), h(c[2])))
}

/// Farbe eines JSON-Werts (`[r, g, b, a]` oder `null`).
pub fn color_of(v: Option<&Value>) -> Option<Vec<f64>> {
    v?.as_array().map(|a| a.iter().map(|x| x.as_f64().unwrap_or(f64::NAN)).collect())
}

fn mesh_value(id: String, name: String, layer: &str, color: Option<String>, extra: Option<(&str, &str)>, positions: Vec<Value>, indices: Vec<Value>) -> Value {
    let mut o = Map::new();
    o.insert("id".into(), id.into());
    o.insert("type".into(), "importedMesh".into());
    o.insert("name".into(), name.into());
    o.insert("layer".into(), layer.into());
    o.insert("categoryCode".into(), GENERIC_IMPORT_CODE.into());
    if let Some(c) = color {
        o.insert("color".into(), c.into());
    }
    if let Some((k, v)) = extra {
        o.insert(k.into(), v.into());
    }
    o.insert("positions".into(), Value::Array(positions));
    o.insert("indices".into(), Value::Array(indices));
    Value::Object(o)
}

/// Positionen (verschoben) und Indizes mehrerer Teile hintereinander.
fn arrays<'a>(parts: impl Iterator<Item = (&'a [f64], &'a [f64])>, d: [f64; 3]) -> (Vec<Value>, Vec<Value>) {
    let mut pos = Vec::new();
    let mut idx = Vec::new();
    for (p, ix) in parts {
        let off = (pos.len() / 3) as f64;
        let mut i = 0;
        while i + 2 < p.len() {
            pos.push(js_num(p[i] + d[0]));
            pos.push(js_num(p[i + 1] + d[1]));
            pos.push(js_num(p[i + 2] + d[2]));
            i += 3;
        }
        for &k in ix {
            idx.push(js_num(k + off));
        }
    }
    (pos, idx)
}

/// Gruppen in Reihenfolge des ersten Auftretens.
fn group_by<T>(items: &[T], key: impl Fn(&T) -> String) -> Vec<Vec<usize>> {
    let mut at: HashMap<String, usize> = HashMap::new();
    let mut groups: Vec<Vec<usize>> = Vec::new();
    for (i, it) in items.iter().enumerate() {
        let k = key(it);
        match at.get(&k) {
            Some(&g) => groups[g].push(i),
            None => {
                at.insert(k, groups.len());
                groups.push(vec![i]);
            }
        }
    }
    groups
}

/// LV95-Ursprung des Projekts (`projectGeoOrigin`: `geoAnchor.lv95 − geoAnchor.model`), ohne Bezug `None`.
pub fn project_geo_origin(root: &Map<String, Value>) -> Option<[f64; 2]> {
    let a = root.get("geoAnchor").filter(|a| crate::grips::truthy(Some(a)))?;
    let n = |p: &str, k: &str| a.get(p).and_then(|o| o.get(k)).and_then(Value::as_f64).unwrap_or(f64::NAN);
    Some([n("lv95", "e") - n("model", "x"), n("lv95", "n") - n("model", "y")])
}

// ── IFC ([B3]) ───────────────────────────────────────────────────────────────

/// Ab so vielen Bauteilen bzw. Objekten wird zusammengelegt.
pub const MAX_SINGLE: usize = 2000;

/// Ein gelesenes IFC-Bauteil (Ansichten in die flachen Puffer).
pub struct IfcProduct<'a> {
    pub global_id: String,
    pub ifc_class: String,
    pub name: Option<String>,
    pub storey: Option<String>,
    pub color: Option<Vec<f64>>,
    pub classifications: Vec<Value>,
    pub positions: &'a [f64],
    pub indices: &'a [f64],
}

fn opt_str(v: Option<&Value>) -> Option<String> {
    v.and_then(Value::as_str).map(str::to_string)
}

/// Bauteile aus dem Bericht (`meta.products`) und den Puffern (vorher `decodeIfc`).
pub fn decode_ifc_products<'a>(meta: &Value, positions: &'a [f64], indices: &'a [f64]) -> Result<Vec<IfcProduct<'a>>, String> {
    let list = meta.get("products").and_then(Value::as_array).ok_or("IFC-Bericht ohne Bauteile")?;
    let (mut po, mut io) = (0usize, 0usize);
    let mut out = Vec::with_capacity(list.len());
    for p in list {
        let pc = p.get("positionCount").and_then(Value::as_u64).unwrap_or(0) as usize;
        let ic = p.get("indexCount").and_then(Value::as_u64).unwrap_or(0) as usize;
        let pe = (po + pc).min(positions.len());
        let ie = (io + ic).min(indices.len());
        out.push(IfcProduct {
            global_id: opt_str(p.get("globalId")).unwrap_or_default(),
            ifc_class: opt_str(p.get("ifcClass")).unwrap_or_default(),
            name: opt_str(p.get("name")),
            storey: opt_str(p.get("storey")),
            color: color_of(p.get("color")),
            classifications: p.get("classifications").and_then(Value::as_array).cloned().unwrap_or_default(),
            positions: &positions[po.min(pe)..pe],
            indices: &indices[io.min(ie)..ie],
        });
        po += pc;
        io += ic;
    }
    Ok(out)
}

/// Verschiebung, falls die Datei in Landeskoordinaten liegt und das Projekt einen Bezug hat (`geoShift`);
/// `extra` = weitere Punkte (x, y flach).
pub fn geo_shift(products: &[IfcProduct], origin: Option<[f64; 2]>, extra: &[f64]) -> [f64; 2] {
    let Some(o) = origin else { return [0.0, 0.0] };
    let (mut sx, mut sy, mut n) = (0.0, 0.0, 0.0);
    for p in products {
        let mut i = 0;
        while i + 2 < p.positions.len() {
            sx += p.positions[i];
            sy += p.positions[i + 1];
            n += 1.0;
            i += 3 * 64;
        }
    }
    let mut i = 0;
    while i + 1 < extra.len() {
        sx += extra[i];
        sy += extra[i + 1];
        n += 1.0;
        i += 2;
    }
    if n == 0.0 {
        return [0.0, 0.0];
    }
    let (cx, cy) = (sx / n, sy / n);
    if jsmath::hypot2(cx - o[0], cy - o[1]) < jsmath::hypot2(cx, cy) {
        [-o[0], -o[1]]
    } else {
        [0.0, 0.0]
    }
}

/// Klassifikation als Namenszusatz (` [eBKP-H C]`), nur die erste; ohne leer.
pub fn classification_suffix(list: &[Value]) -> String {
    let Some(c) = list.first() else { return String::new() };
    let parts: Vec<&str> = [c.get("system"), c.get("code")].iter().filter_map(|v| v.and_then(Value::as_str)).filter(|s| !s.is_empty()).collect();
    format!(" [{}]", parts.join(" "))
}

/// Gruppierung: `"product"`, `"class"` oder `"auto"` (nach [`MAX_SINGLE`]).
pub fn ifc_meshes(products: &[IfcProduct], file_name: &str, group: &str, shift: [f64; 2], now: f64) -> Vec<Value> {
    let base = base_name(file_name, "IFC");
    let stamp = stamp36(now);
    let d = [shift[0], shift[1], 0.0];
    let per_product = group == "product" || (group != "class" && products.len() <= MAX_SINGLE);
    if per_product {
        return products
            .iter()
            .map(|p| {
                let label = [p.storey.as_deref(), Some(p.name.as_deref().filter(|n| !n.is_empty()).unwrap_or(&p.ifc_class))]
                    .into_iter()
                    .flatten()
                    .filter(|s| !s.is_empty())
                    .collect::<Vec<_>>()
                    .join(": ");
                let (pos, idx) = arrays(std::iter::once((p.positions, p.indices)), d);
                let gid = (!p.global_id.is_empty()).then_some(("ifcGlobalId", p.global_id.as_str()));
                mesh_value(
                    format!("imported-ifc-{stamp}-{}", next_seq()),
                    label + &classification_suffix(&p.classifications),
                    &p.ifc_class,
                    color_hex(p.color.as_deref()),
                    gid,
                    pos,
                    idx,
                )
            })
            .collect();
    }
    group_by(products, |p| format!("{}\u{0}{}", p.ifc_class, p.storey.as_deref().unwrap_or("")))
        .into_iter()
        .map(|g| {
            let first = &products[g[0]];
            let colors: HashSet<String> = g.iter().map(|&i| color_hex(products[i].color.as_deref()).unwrap_or_default()).collect();
            let color = if colors.len() == 1 { colors.into_iter().next().filter(|c| !c.is_empty()) } else { None };
            let label = [first.storey.as_deref(), Some(first.ifc_class.as_str())].into_iter().flatten().filter(|s| !s.is_empty()).collect::<Vec<_>>().join(" ");
            let (pos, idx) = arrays(g.iter().map(|&i| (products[i].positions, products[i].indices)), d);
            mesh_value(format!("imported-ifc-{stamp}-{}", next_seq()), format!("{base}: {label} ({})", g.len()), &first.ifc_class, color, None, pos, idx)
        })
        .collect()
}

/// Bericht des IFC-Imports: Bericht des Lesers mit `products` = Anzahl, dazu Bauteile je Klasse und Dreiecke.
pub fn ifc_report(meta: &Value, products: &[IfcProduct]) -> Value {
    let mut r = meta.as_object().cloned().unwrap_or_default();
    r.insert("products".into(), products.len().into());
    let mut by_class = Map::new();
    for p in products {
        let n = by_class.get(&p.ifc_class).and_then(Value::as_f64).unwrap_or(0.0) + 1.0;
        by_class.insert(p.ifc_class.clone(), js_num(n));
    }
    let tris: f64 = products.iter().map(|p| p.indices.len() as f64 / 3.0).sum();
    r.insert("byClass".into(), Value::Object(by_class));
    r.insert("triangles".into(), js_num(tris));
    Value::Object(r)
}

// ── Allgemeine Meshes ([C11]) ────────────────────────────────────────────────

pub struct MeshObject {
    pub name: String,
    pub group: String,
    pub color: Option<Vec<f64>>,
    pub positions: Vec<f64>,
    pub indices: Vec<f64>,
}

const MESH_FORMATS: [&str; 4] = ["obj", "stl", "gltf", "ply"];

/// Flache Puffer → Objekte + Bericht (vorher `decodeMesh`, Aufbau: Kopf von `mesh_import.rs`).
pub fn decode_mesh(f: &[f64], strings: &[String]) -> Result<(Vec<MeshObject>, Value), String> {
    const HEAD: usize = 12;
    if f.len() < HEAD || f[0] != 1.0 {
        return Err("Mesh-Import: unbekannte Kodierung".into());
    }
    let s = |k: f64| if k >= 0.0 && k.fract() == 0.0 { strings.get(k as usize).cloned().unwrap_or_default() } else { String::new() };
    let n_warn = f[10];
    let n_obj = f[11];
    let mut at = HEAD;
    let mut warnings = Vec::new();
    let mut k = 0.0;
    while k < n_warn {
        warnings.push(Value::String(s(*f.get(at).ok_or("Mesh-Import: Puffer beschädigt")?)));
        at += 1;
        k += 1.0;
    }
    let mut objects = Vec::new();
    let mut repaired = [0usize; 3];
    let mut k = 0.0;
    while k < n_obj {
        let h = f.get(at..at + 9).ok_or("Mesh-Import: Puffer beschädigt")?;
        let name = s(h[0]);
        let group = if h[1] >= 0.0 { s(h[1]) } else { String::new() };
        let color = (h[2] == 1.0).then(|| vec![h[3], h[4], h[5], h[6]]);
        let (np, ni) = (h[7], h[8]);
        at += 9;
        if !(np.fract() == 0.0 && ni.fract() == 0.0 && np >= 0.0 && ni >= 0.0) || at + np as usize + ni as usize > f.len() {
            return Err("Mesh-Import: Puffer beschädigt".into());
        }
        let positions: Vec<f64> = f[at..at + np as usize].to_vec();
        at += np as usize;
        // Wie `Uint32Array`: ganzzahlig modulo 2³².
        let indices: Vec<f64> = f[at..at + ni as usize].iter().map(|&x| (jsnum::to_int32(x) as u32) as f64).collect();
        at += ni as usize;
        // Reparatur ([T5]): verschweissen, Entartete raus, kleine Löcher zu; Zähler gehen in den Bericht.
        let r = crate::mesh_repair::repair(&positions, &indices);
        repaired[0] += r.welded;
        repaired[1] += r.degenerate;
        repaired[2] += r.holes;
        objects.push(MeshObject { name, group, color, positions: r.pos, indices: r.idx });
        k += 1.0;
    }
    let report = json!({
        "format": MESH_FORMATS.get(f[1] as usize).copied().filter(|_| f[1] >= 0.0 && f[1].fract() == 0.0).unwrap_or("obj"),
        "up": if f[2] == 1.0 { "y" } else { "z" },
        "upAuto": f[3] == 1.0,
        "upCertain": f[4] == 1.0,
        "unitScale": js_num(f[5]),
        "triangles": js_num(f[6]),
        "degenerate": js_num(f[7]),
        "badFaces": js_num(f[8]),
        "truncated": f[9] == 1.0,
        "warnings": warnings,
        "objects": objects.len(),
        "repaired": {"welded": repaired[0], "degenerate": repaired[1], "holes": repaired[2]},
    });
    Ok((objects, report))
}

/// Ausdehnung aller Objekte (Meter, Modell-Achsen; Anzeige im Dialog); `None` ohne Punkte.
pub fn mesh_extent(objects: &[MeshObject]) -> Option<[f64; 3]> {
    let mut lo = [f64::INFINITY; 3];
    let mut hi = [f64::NEG_INFINITY; 3];
    for o in objects {
        for p in o.positions.chunks_exact(3) {
            for a in 0..3 {
                if p[a] < lo[a] {
                    lo[a] = p[a];
                }
                if p[a] > hi[a] {
                    hi[a] = p[a];
                }
            }
        }
    }
    lo[0].is_finite().then(|| [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]])
}

/// Verschiebung (x, y, z) je nach Platzierung (`meshShift`): `"center"` = Grundriss-Mitte auf den
/// Nullpunkt, Unterkante auf 0; `"original"` = Datei-Koordinaten, Landeskoordinaten auf den Modell-Nullpunkt.
pub fn mesh_shift(objects: &[MeshObject], placement: &str, origin: Option<[f64; 2]>) -> [f64; 3] {
    let (mut min_x, mut max_x, mut min_y, mut max_y, mut min_z) = (f64::INFINITY, f64::NEG_INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::INFINITY);
    for o in objects {
        let p = &o.positions;
        let mut i = 0;
        while i + 2 < p.len() {
            if p[i] < min_x {
                min_x = p[i];
            }
            if p[i] > max_x {
                max_x = p[i];
            }
            if p[i + 1] < min_y {
                min_y = p[i + 1];
            }
            if p[i + 1] > max_y {
                max_y = p[i + 1];
            }
            if p[i + 2] < min_z {
                min_z = p[i + 2];
            }
            i += 3;
        }
    }
    if !min_x.is_finite() {
        return [0.0, 0.0, 0.0];
    }
    let cx = (min_x + max_x) / 2.0;
    let cy = (min_y + max_y) / 2.0;
    if placement != "original" {
        return [-cx, -cy, -min_z];
    }
    match origin {
        Some(o) if jsmath::hypot2(cx - o[0], cy - o[1]) < jsmath::hypot2(cx, cy) => [-o[0], -o[1], 0.0],
        _ => [0.0, 0.0, 0.0],
    }
}

/// Objekte → Kontext-Meshes (`layer` = Gruppe, sonst Dateiname); `group`: `"object"`, `"merge"`, `"auto"`.
pub fn mesh_objects_to_meshes(objects: &[MeshObject], file_name: &str, placement: &str, origin: Option<[f64; 2]>, group: &str, now: f64) -> Vec<Value> {
    let base = base_name(file_name, "Mesh");
    let d = mesh_shift(objects, placement, origin);
    let stamp = stamp36(now);
    let merge = group == "merge" || (group != "object" && objects.len() > MAX_SINGLE);
    if !merge {
        return objects
            .iter()
            .enumerate()
            .map(|(i, o)| {
                let (pos, idx) = arrays(std::iter::once((o.positions.as_slice(), o.indices.as_slice())), d);
                let name = if o.name.is_empty() { format!("{base} {}", i + 1) } else { o.name.clone() };
                let layer = if o.group.is_empty() { base.as_str() } else { o.group.as_str() };
                mesh_value(format!("imported-mesh-{stamp}-{}", next_seq()), name, layer, color_hex(o.color.as_deref()), None, pos, idx)
            })
            .collect();
    }
    group_by(objects, |o| format!("{}\u{0}{}", o.group, color_hex(o.color.as_deref()).unwrap_or_default()))
        .into_iter()
        .map(|g| {
            let first = &objects[g[0]];
            let (pos, idx) = arrays(g.iter().map(|&i| (objects[i].positions.as_slice(), objects[i].indices.as_slice())), d);
            let gname = &first.group;
            let name = format!("{base}{} ({})", if gname.is_empty() { String::new() } else { format!(": {gname}") }, g.len());
            let layer = if gname.is_empty() { base.as_str() } else { gname.as_str() };
            mesh_value(format!("imported-mesh-{stamp}-{}", next_seq()), name, layer, color_hex(first.color.as_deref()), None, pos, idx)
        })
        .collect()
}

// ── STEP ([K4] S4, vorher `io/stepImport.ts`) ────────────────────────────────

/// Körper aus dem flachen Puffer von truck (`trucksolid::brep::step_meshes_flat`):
/// `[1, n, (np, ni, Positionen…, Indizes…) je Körper]`, Positionen f32 in f64 geweitet.
pub fn decode_step(f: &[f64]) -> Result<Vec<(Vec<f32>, Vec<f64>)>, String> {
    let bad = || "STEP-Import: Puffer beschädigt".to_string();
    if f.len() < 2 || f[0] != 1.0 || !(f[1] >= 0.0 && f[1].fract() == 0.0) {
        return Err("STEP-Import: unbekannte Kodierung".into());
    }
    let mut at = 2;
    let mut out = Vec::new();
    let mut k = 0.0;
    while k < f[1] {
        let h = f.get(at..at + 2).ok_or_else(bad)?;
        let (np, ni) = (h[0], h[1]);
        at += 2;
        if !(np.fract() == 0.0 && ni.fract() == 0.0 && np >= 0.0 && ni >= 0.0) || at + np as usize + ni as usize > f.len() {
            return Err(bad());
        }
        let positions = f[at..at + np as usize].iter().map(|&x| x as f32).collect();
        at += np as usize;
        let indices = f[at..at + ni as usize].to_vec();
        at += ni as usize;
        out.push((positions, indices));
        k += 1.0;
    }
    Ok(out)
}

/// STEP-Körper → Kontext-Meshes der Kategorie „Import“, Koordinaten unverändert (Meter, Z = Höhe), ohne
/// `layer`. Zahlen wie vorher über JSON: die f32-Positionen mit ihrer kürzesten Dezimaldarstellung.
pub fn step_meshes(bodies: &[(Vec<f32>, Vec<f64>)], file_name: &str, now: f64) -> Vec<Value> {
    let base = base_name(file_name, "STEP");
    let stamp = stamp36(now);
    let n = bodies.len();
    bodies
        .iter()
        .enumerate()
        .map(|(i, (pos, idx))| {
            let mut o = Map::new();
            o.insert("id".into(), format!("imported-step-{stamp}-{}", next_seq()).into());
            o.insert("type".into(), "importedMesh".into());
            o.insert("name".into(), if n > 1 { format!("{base} ({}/{n})", i + 1) } else { base.clone() }.into());
            o.insert("categoryCode".into(), GENERIC_IMPORT_CODE.into());
            o.insert("positions".into(), Value::Array(pos.iter().map(|&x| js_num(x.to_string().parse().unwrap_or(f64::from(x)))).collect()));
            o.insert("indices".into(), Value::Array(idx.iter().map(|&k| js_num(k)).collect()));
            Value::Object(o)
        })
        .collect()
}

#[cfg(test)]
mod step_tests {
    use super::*;

    fn flat() -> Vec<f64> {
        // zwei Körper: Dreieck mit 0.1f32 (nicht exakt in f64), Dreieck mit ganzen Zahlen
        let mut f = vec![1.0, 2.0, 9.0, 3.0];
        f.extend([0.1f32, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, -0.0].iter().map(|&x| x as f64));
        f.extend([0.0, 1.0, 2.0, 9.0, 3.0]);
        f.extend([5.0, 0.0, 0.0, 6.0, 0.0, 0.0, 5.0, 1.0, 0.0]);
        f.extend([0.0, 1.0, 2.0]);
        f
    }

    #[test]
    fn koerper_werden_kontext_meshes() {
        let bodies = decode_step(&flat()).unwrap();
        let m = step_meshes(&bodies, "haus.stp", 1.0e12);
        assert_eq!(m.len(), 2);
        assert_eq!(m[0]["name"], "haus (1/2)");
        assert_eq!(m[1]["name"], "haus (2/2)");
        assert_eq!(m[0]["categoryCode"], "10");
        assert!(m[0].get("layer").is_none());
        assert_eq!(m[0]["positions"][0], json!(0.1));
        assert_eq!(m[1]["indices"], json!([0, 1, 2]));
        assert!(m[0]["id"].as_str().unwrap().starts_with("imported-step-"));
    }

    #[test]
    fn ein_koerper_traegt_den_dateinamen_ohne_nummer() {
        let f = vec![1.0, 1.0, 3.0, 3.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0];
        let m = step_meshes(&decode_step(&f).unwrap(), ".step", 1.0);
        assert_eq!(m[0]["name"], "STEP");
    }

    #[test]
    fn kaputte_puffer_werden_verworfen() {
        assert!(decode_step(&[]).is_err());
        assert!(decode_step(&[2.0, 0.0]).is_err());
        assert!(decode_step(&[1.0, 1.0, 9.0, 3.0, 0.0]).is_err());
        assert!(decode_step(&[1.0, f64::NAN]).is_err());
    }
}

#[cfg(test)]
mod repair_tests {
    use super::*;

    /// [T5] Der Import verschweisst Ecken und meldet die Reparatur im Bericht.
    #[test]
    fn mesh_import_repariert_und_berichtet() {
        let mut f = vec![1.0, 1.0, 0.0, 0.0, 1.0, 1.0, 2.0, 0.0, 0.0, 0.0, 0.0, 1.0];
        // Objekt: Name 0, Gruppe -1, keine Farbe, 6 Ecken (Quadrat als zwei Dreiecke, STL-artig) + 1 entartetes Dreieck
        f.extend([0.0, -1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 18.0, 9.0]);
        f.extend([0., 0., 0., 1., 0., 0., 1., 1., 0., 0., 0., 0., 1., 1., 0., 0., 1., 0.]);
        f.extend([0., 1., 2., 3., 4., 5., 0., 0., 1.]);
        let (objects, report) = decode_mesh(&f, &["q".to_string()]).unwrap();
        assert_eq!(objects[0].positions.len(), 12); // 4 statt 6 Ecken
        assert_eq!(objects[0].indices.len(), 6);
        assert_eq!(report["repaired"]["welded"], 2);
        assert_eq!(report["repaired"]["degenerate"], 1);
        assert_eq!(report["repaired"]["holes"], 0);
    }
}
