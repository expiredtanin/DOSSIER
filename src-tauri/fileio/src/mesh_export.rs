// Mesh-Schreiber: OBJ, STL (ASCII) und glTF 2.0 / GLB aus einer flachen Szene ([C4], 28.10.).
// TS (`src/export/exportMesh.ts`) sammelt aus dem Projekt die Dreiecke der Bauteile (Wand-Bänder,
// Decken, Extrusionen, optional Verglasung/Rahmen) und gibt sie fertig gerechnet hierher; Rust schreibt
// nur die Datei. OBJ/STL sind Zeichen für Zeichen die Ausgabe der früheren TS-Fassung.
//
// Flache Kodierung (Muster `ifc_export/mod.rs`): Zahlen als `f64`-Puffer, Zeichenketten getrennt als EINE
// Zeichenkette, Teile durch `\0` getrennt; im Zahlenpuffer steht ihr Index (−1 = keine).
//
//   [FLAT_VERSION, flags, MATERIALS, LEVELS, GROUPS]
//   flags     = Bit 0: glTF nach Geschossen gliedern (Geschoss-Knoten als Eltern der Bauteil-Knoten)
//   MATERIALS = n, (name, r, g, b, a, metallic, roughness) × n        (Farben sRGB 0..1, a < 1 = transparent)
//   LEVELS    = n, (id, name) × n
//   GROUPS    = n, GROUP × n
//   GROUP     = name (Knoten-/Objektname), kind (Text, z. B. "wall"), id (Bauteil-id), level (Index oder −1),
//               n_prims, (material (Index oder −1), n_verts, x, y, z, …, n_tris, i0, i1, i2, …) × n_prims
//
// Koordinaten: Welt, Meter, Y-up, wie `selectionHighlightLines` (Modell (x, y, z) → (x, z, y); eine Spiegelung). Alle Formate
// (OBJ, STL, glTF; OBJ/STL seit 28.10. — vorher ungespiegelt) verlangen ein rechtshändiges Y-up-System:
// der Schreiber spiegelt Z (v → (x, y, −z)) und vertauscht die Dreiecks-Wicklung; Gesamtabbildung vom Modell:
// (x, y, z-hoch) → (x, z, −y), Norden liegt bei −Z (glTF-„vorne“), Ost bei +X.
//
// glTF: ein Knoten je Bauteil (Name = Gruppenname, `extras` = Typ und id), je Material eine Primitive,
// PBR (`baseColorFactor` linear, aus sRGB umgerechnet), transparente Materialien mit `alphaMode: BLEND`,
// Positionen als FLOAT mit `min`/`max`, Indizes als UNSIGNED_INT, NORMAL als FLOAT VEC3 ([201]): geteilte
// Ecken-Normalen nach Knickwinkel (`CREASE_DEG`), dieselbe Funktion wie die 3D-Anzeige
// (`dossier_hatch::mesh_normals::smooth_corner_normals`); Ecken mit verschiedener Normale werden getrennte Eckpunkte,
// scharfe Kanten (über dem Knickwinkel) bleiben also kantig. OBJ: `vn` je Fläche/Ecke, `usemtl` je Teil-Netz und
// optional `mtllib` auf eine MTL mit den Farben (`export_mtl`). GLB = JSON-Chunk + BIN-Chunk; `.gltf` bettet den Puffer als Base64-Data-URI ein.
// Keine Abhängigkeit: JSON und Base64 sind hier von Hand geschrieben.

use crate::ifc_export::fmt_real;
use dossier_hatch::mesh_normals::smooth_corner_normals;
use std::collections::HashMap;

/// Knickwinkel, bis zu dem Ecken-Normalen geteilt werden (wie `DEFAULT_CREASE_DEG` der 3D-Anzeige für glatte Netze).
const CREASE_DEG: f32 = 30.0;

const FLAT_VERSION: f64 = 1.0;

/// Ein Teil-Mesh mit einem Material.
struct Prim {
    material: i64,
    positions: Vec<f64>,
    indices: Vec<u32>,
}

struct Group {
    name: String,
    kind: String,
    id: String,
    level: i64,
    prims: Vec<Prim>,
}

struct Material {
    name: String,
    rgba: [f64; 4],
    metallic: f64,
    roughness: f64,
}

struct Scene {
    by_level: bool,
    materials: Vec<Material>,
    levels: Vec<(String, String)>,
    groups: Vec<Group>,
}

struct Reader<'a> {
    flat: &'a [f64],
    at: usize,
    strings: Vec<&'a str>,
}

impl<'a> Reader<'a> {
    fn num(&mut self) -> Result<f64, String> {
        let v = *self.flat.get(self.at).ok_or("Puffer zu kurz")?;
        self.at += 1;
        Ok(v)
    }
    fn int(&mut self) -> Result<i64, String> {
        let v = self.num()?;
        if !v.is_finite() || v.fract() != 0.0 || v.abs() > 4e9 {
            return Err(format!("keine Ganzzahl: {v}"));
        }
        Ok(v as i64)
    }
    /// Anzahl, die höchstens so gross sein darf wie der Rest des Puffers (je `per` Zahlen).
    fn count(&mut self, per: usize) -> Result<usize, String> {
        let n = self.int()?;
        if n < 0 {
            return Err("negative Anzahl".into());
        }
        let n = n as usize;
        if n.saturating_mul(per) > self.flat.len() - self.at.min(self.flat.len()) {
            return Err("Anzahl grösser als der Puffer".into());
        }
        Ok(n)
    }
    fn finite(&mut self) -> Result<f64, String> {
        let v = self.num()?;
        if v.is_finite() {
            Ok(v)
        } else {
            Err("NaN/unendlich".into())
        }
    }
    fn string(&mut self) -> Result<String, String> {
        let i = self.int()?;
        if i < 0 {
            return Ok(String::new());
        }
        self.strings.get(i as usize).map(|s| (*s).to_string()).ok_or_else(|| "Zeichenketten-Index ausserhalb".to_string())
    }
}

fn parse(flat: &[f64], strings: &str) -> Result<Scene, String> {
    let mut r = Reader { flat, at: 0, strings: strings.split('\0').collect() };
    if r.num()? != FLAT_VERSION {
        return Err("unbekannte Puffer-Version".into());
    }
    let flags = r.int()?;
    let mut materials = Vec::new();
    for _ in 0..r.count(7)? {
        let name = r.string()?;
        let rgba = [r.finite()?, r.finite()?, r.finite()?, r.finite()?];
        materials.push(Material { name, rgba, metallic: r.finite()?, roughness: r.finite()? });
    }
    let mut levels = Vec::new();
    for _ in 0..r.count(2)? {
        levels.push((r.string()?, r.string()?));
    }
    let mut groups = Vec::new();
    for _ in 0..r.count(5)? {
        let name = r.string()?;
        let kind = r.string()?;
        let id = r.string()?;
        let level = r.int()?;
        if level >= levels.len() as i64 {
            return Err("Geschoss-Index ausserhalb".into());
        }
        let mut prims = Vec::new();
        for _ in 0..r.count(3)? {
            let material = r.int()?;
            if material >= materials.len() as i64 {
                return Err("Material-Index ausserhalb".into());
            }
            let nv = r.count(3)?;
            let mut positions = Vec::with_capacity(nv * 3);
            for _ in 0..nv * 3 {
                positions.push(r.finite()?);
            }
            let nt = r.count(3)?;
            let mut indices = Vec::with_capacity(nt * 3);
            for _ in 0..nt * 3 {
                let i = r.int()?;
                if i < 0 || i as usize >= nv {
                    return Err("Dreiecks-Index ausserhalb".into());
                }
                indices.push(i as u32);
            }
            prims.push(Prim { material, positions, indices });
        }
        groups.push(Group { name, kind, id, level, prims });
    }
    if r.at != flat.len() {
        return Err("Rest im Puffer".into());
    }
    Ok(Scene { by_level: flags & 1 == 1, materials, levels, groups })
}

fn tri_count(g: &Group) -> usize {
    g.prims.iter().map(|p| p.indices.len() / 3).sum()
}

/// Szene-Welt (x, Höhe, y) → rechtshändige Datei (x, Höhe, −y) — Modell (x, y, z-hoch) → (x, z, −y). `0.0 - z`
/// statt `-z`: aus +0 wird so kein „-0.0“ in der Datei.
fn to_file(x: f64, y: f64, z: f64) -> [f64; 3] {
    [x, y, 0.0 - z]
}

// ── Normalen ────────────────────────────────────────────────────────────────

/// Ecken-Normalen je Dreieck eines Teil-Netzes in DATEI-Achsen ((x, y, −z), passend zu `to_file`); entartete Dreiecke
/// bekommen +Y. Rechnung in Szene-Achsen (Wicklung nach aussen), dann gespiegelt: Spiegelung + vertauschte Wicklung
/// lassen die Normale nach aussen zeigen.
fn corner_normals_file(p: &Prim) -> Vec<[[f32; 3]; 3]> {
    let nv = p.positions.len() / 3;
    let world = |i: usize| -> [f32; 3] { [p.positions[i * 3] as f32, p.positions[i * 3 + 1] as f32, p.positions[i * 3 + 2] as f32] };
    smooth_corner_normals(&p.indices, nv, &world, CREASE_DEG)
        .into_iter()
        .map(|t| match t {
            Some(n) => n.map(|v| [v[0], v[1], 0.0 - v[2]]),
            None => [[0.0, 1.0, 0.0]; 3],
        })
        .collect()
}

fn normal_key(n: [f32; 3]) -> [i32; 3] {
    [(n[0] * 1e5).round() as i32, (n[1] * 1e5).round() as i32, (n[2] * 1e5).round() as i32]
}

// ── OBJ / MTL ───────────────────────────────────────────────────────────────

/// Materialnamen für `usemtl`/`newmtl`: ohne Leerraum, eindeutig; Index `materials.len()` = „Standard“ (Teile ohne Material).
fn material_names(s: &Scene) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for (i, m) in s.materials.iter().enumerate() {
        let base: String = m.name.chars().map(|c| if c.is_whitespace() || c.is_control() { '_' } else { c }).collect();
        let base = if base.is_empty() { "Material".to_string() } else { base };
        let name = if out.contains(&base) { format!("{base}_{i}") } else { base };
        out.push(name);
    }
    out.push(if out.iter().any(|n| n == "Standard") { "Standard_0".to_string() } else { "Standard".to_string() });
    out
}

fn mat_index(s: &Scene, m: i64) -> usize {
    if m >= 0 {
        m as usize
    } else {
        s.materials.len()
    }
}

/// Verwendete Materialien (Index in `material_names`) in der Reihenfolge des ersten Auftretens.
fn used_materials(s: &Scene) -> Vec<usize> {
    let mut used: Vec<usize> = Vec::new();
    for g in s.groups.iter().filter(|g| tri_count(g) > 0) {
        for p in g.prims.iter().filter(|p| !p.indices.is_empty()) {
            let k = mat_index(s, p.material);
            if !used.contains(&k) {
                used.push(k);
            }
        }
    }
    used
}

/// Farbe eines (verwendeten) Materials: aus der Szene, „Standard“ grau.
fn rgba_of(s: &Scene, k: usize) -> [f64; 4] {
    s.materials.get(k).map_or([0.8, 0.8, 0.8, 1.0], |m| m.rgba)
}

/// MTL-Datei mit den Farben der verwendeten Materialien (Kd = sRGB-Farbe, d = Deckkraft).
fn write_mtl(s: &Scene) -> String {
    let names = material_names(s);
    let mut out = String::from("# DOSSIER MTL - Materialien des OBJ-Exports (Kd = sRGB-Farbe 0..1, d = Deckkraft)\n");
    for k in used_materials(s) {
        let c = rgba_of(s, k);
        out.push_str(&format!("\nnewmtl {}\nKa 0 0 0\n", names[k]));
        out.push_str(&format!("Kd {} {} {}\n", fmt_real(c[0].clamp(0.0, 1.0)), fmt_real(c[1].clamp(0.0, 1.0)), fmt_real(c[2].clamp(0.0, 1.0))));
        out.push_str(&format!("Ks 0 0 0\nd {}\nillum 2\n", fmt_real(c[3].clamp(0.0, 1.0))));
    }
    out
}

/// OBJ mit `vn` und `usemtl`. `mtl_name` = Dateiname der MTL (`mtllib`); leer ⇒ keine MTL daneben, die Farben stehen dann
/// als Kommentar im Kopf (jedes Material bleibt eine eigene `usemtl`-Gruppe).
fn write_obj(s: &Scene, mtl_name: &str) -> String {
    let names = material_names(s);
    let mut out = String::new();
    out.push_str("# DOSSIER OBJ-Export - Dreiecks-Mesh des 3D-Gebaeudemodells\n");
    out.push_str("# Achsen: rechtshaendig, Y-up (Y = Hoehe ueber OKFF), Modell (x,y,z) -> (x,z,-y), Norden = -Z.\n");
    out.push_str("# Waende: Schicht-Baender mit oeffnungsgenau ausgeschnittenen Loechern (inkl. Laibungen).\n");
    out.push_str("# Decken/Extrusionen: Umriss-Prisma (Ear-Clipping-Triangulierung).\n");
    out.push_str("# Daecher, Treppen, Stuetzen, Fenster/Tueren (je Oeffnung ein Objekt), Gelaende und Kontext-Meshes wie im 3D.\n");
    out.push_str(&format!("# Normalen: je Ecke geteilt bis {CREASE_DEG} Grad Knickwinkel (wie die 3D-Anzeige), scharfe Kanten bleiben kantig.\n"));
    let mtl_name = mtl_name.trim();
    if mtl_name.is_empty() {
        out.push_str("# Farben (ohne MTL-Datei; Gruppen je Material mit usemtl):\n");
        for k in used_materials(s) {
            let c = rgba_of(s, k);
            out.push_str(&format!("# {}: Kd {} {} {} d {}\n", names[k], fmt_real(c[0]), fmt_real(c[1]), fmt_real(c[2]), fmt_real(c[3])));
        }
    } else {
        out.push_str(&format!("mtllib {mtl_name}\n"));
    }
    let mut offset = 0usize;
    let mut n_off = 0usize;
    for g in s.groups.iter().filter(|g| tri_count(g) > 0) {
        out.push_str("o ");
        out.push_str(&g.name);
        out.push('\n');
        let mut local = 0usize;
        for p in &g.prims {
            for v in p.positions.chunks_exact(3) {
                let f = to_file(v[0], v[1], v[2]);
                out.push_str(&format!("v {} {} {}\n", fmt_real(f[0]), fmt_real(f[1]), fmt_real(f[2])));
            }
        }
        // Normalen des Objekts (je verschiedene Richtung einmal), Flächen verweisen darauf.
        let mut normals: HashMap<[i32; 3], usize> = HashMap::new();
        let mut per_prim: Vec<Vec<[usize; 3]>> = Vec::new();
        let mut vn = String::new();
        for p in &g.prims {
            let mut tris = Vec::new();
            for t in corner_normals_file(p) {
                let mut ids = [0usize; 3];
                for (c, n) in t.iter().enumerate() {
                    let next = normals.len();
                    ids[c] = *normals.entry(normal_key(*n)).or_insert_with(|| {
                        vn.push_str(&format!("vn {} {} {}\n", fmt_real(f64::from(n[0])), fmt_real(f64::from(n[1])), fmt_real(f64::from(n[2]))));
                        next
                    });
                }
                tris.push(ids);
            }
            per_prim.push(tris);
        }
        out.push_str(&vn);
        for (p, tris) in g.prims.iter().zip(&per_prim) {
            if p.indices.is_empty() {
                continue;
            }
            out.push_str(&format!("usemtl {}\n", names[mat_index(s, p.material)]));
            for (t, nrm) in p.indices.chunks_exact(3).zip(tris) {
                let (a, b, c) = (t[0] as usize + 1 + offset + local, t[2] as usize + 1 + offset + local, t[1] as usize + 1 + offset + local);
                // Z gespiegelt ⇒ Wicklung vertauschen (Normalen zeigen weiter nach aussen).
                let (na, nb, nc) = (nrm[0] + 1 + n_off, nrm[2] + 1 + n_off, nrm[1] + 1 + n_off);
                out.push_str(&format!("f {a}//{na} {b}//{nb} {c}//{nc}\n"));
            }
            local += p.positions.len() / 3;
        }
        offset += local;
        n_off += normals.len();
    }
    out
}

// ── STL ─────────────────────────────────────────────────────────────────────

fn write_stl(s: &Scene) -> String {
    let mut out = String::from("solid dossier\n");
    for g in &s.groups {
        for p in &g.prims {
            let v = |i: u32| {
                let k = i as usize * 3;
                to_file(p.positions[k], p.positions[k + 1], p.positions[k + 2])
            };
            for t in p.indices.chunks_exact(3) {
                let (a, b, c) = (v(t[0]), v(t[2]), v(t[1]));
                let u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
                let w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
                let mut n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
                let len = js_hypot3(n[0], n[1], n[2]);
                if len > 1e-12 {
                    n = [n[0] / len, n[1] / len, n[2] / len];
                } else {
                    n = [0.0; 3];
                }
                out.push_str(&format!("facet normal {} {} {}\nouter loop\n", fmt_real(n[0]), fmt_real(n[1]), fmt_real(n[2])));
                for q in [a, b, c] {
                    out.push_str(&format!("vertex {} {} {}\n", fmt_real(q[0]), fmt_real(q[1]), fmt_real(q[2])));
                }
                out.push_str("endloop\nendfacet\n");
            }
        }
    }
    out.push_str("endsolid dossier\n");
    out
}


/// `Math.hypot(x, y, z)` wie V8: durch das Maximum teilen, Quadrate (Kahan) summieren, Wurzel, zurückskalieren.
fn js_hypot3(x: f64, y: f64, z: f64) -> f64 {
    let m = x.abs().max(y.abs()).max(z.abs());
    if m == 0.0 {
        return 0.0;
    }
    let mut sum = 0.0;
    let mut comp = 0.0;
    for v in [x, y, z] {
        let r = v / m;
        let summand = r * r - comp;
        let prelim = sum + summand;
        comp = (prelim - sum) - summand;
        sum = prelim;
    }
    sum.sqrt() * m
}

// ── glTF 2.0 / GLB ──────────────────────────────────────────────────────────

fn json_str(s: &str, out: &mut String) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

fn srgb_to_linear(c: f64) -> f64 {
    let c = c.clamp(0.0, 1.0);
    if c <= 0.04045 {
        c / 12.92
    } else {
        ((c + 0.055) / 1.055).powf(2.4)
    }
}

fn base64(bytes: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for c in bytes.chunks(3) {
        let n = (u32::from(c[0]) << 16) | (u32::from(*c.get(1).unwrap_or(&0)) << 8) | u32::from(*c.get(2).unwrap_or(&0));
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if c.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if c.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    out
}

fn push_sep(s: &mut String, n: usize) {
    if n > 0 {
        s.push(',');
    }
}

fn push_material(mats: &mut String, name: &str, rgba: [f64; 4], metallic: f64, roughness: f64) {
    let n = mats.len();
    push_sep(mats, n);
    mats.push_str("{\"name\":");
    json_str(name, mats);
    let a = rgba[3].clamp(0.0, 1.0);
    mats.push_str(&format!(
        ",\"pbrMetallicRoughness\":{{\"baseColorFactor\":[{},{},{},{}],\"metallicFactor\":{},\"roughnessFactor\":{}}},\"doubleSided\":true",
        srgb_to_linear(rgba[0]),
        srgb_to_linear(rgba[1]),
        srgb_to_linear(rgba[2]),
        a,
        metallic.clamp(0.0, 1.0),
        roughness.clamp(0.0, 1.0)
    ));
    if a < 1.0 {
        mats.push_str(",\"alphaMode\":\"BLEND\"");
    }
    mats.push('}');
}

/// JSON des glTF und der Binärpuffer (`uri_for_buffer`: Puffer als Data-URI einbetten, sonst GLB).
fn build_gltf(s: &Scene, uri_for_buffer: bool) -> (String, Vec<u8>) {
    let mut bin: Vec<u8> = Vec::new();
    let mut views = String::new();
    let mut accessors = String::new();
    let mut meshes = String::new();
    let mut nodes = String::new();
    let (mut n_views, mut n_acc, mut n_mesh) = (0usize, 0usize, 0usize);
    let default_material = s.materials.len();
    let mut need_default = false;
    let mut node_levels: Vec<i64> = Vec::new();
    // Gruppen mit Dreiecken → Knoten 0..n_mesh (Knoten i = Mesh i).
    for g in s.groups.iter().filter(|g| tri_count(g) > 0) {
        // Je Material eine Primitive (gleiches Material zusammenfassen, Reihenfolge des ersten Auftretens).
        let mut merged: Vec<(i64, Vec<f32>, Vec<f32>, Vec<u32>)> = Vec::new();
        for p in &g.prims {
            if p.indices.is_empty() {
                continue;
            }
            let at = match merged.iter().position(|m| m.0 == p.material) {
                Some(i) => i,
                None => {
                    merged.push((p.material, Vec::new(), Vec::new(), Vec::new()));
                    merged.len() - 1
                }
            };
            let m = &mut merged[at];
            // Eckpunkte je (Index, Normale): Ecken mit gleicher Normale teilen sich einen Punkt, scharfe Kanten
            // bekommen getrennte. Z spiegeln (Modell-Welt → rechtshändiges glTF) und Wicklung vertauschen.
            let normals = corner_normals_file(p);
            let mut local: HashMap<(u32, [i32; 3]), u32> = HashMap::new();
            for (t, nrm) in p.indices.chunks_exact(3).zip(&normals) {
                for c in [0usize, 2, 1] {
                    let key = (t[c], normal_key(nrm[c]));
                    let next = (m.1.len() / 3) as u32;
                    let id = *local.entry(key).or_insert_with(|| {
                        let v = &p.positions[t[c] as usize * 3..t[c] as usize * 3 + 3];
                        m.1.extend_from_slice(&[v[0] as f32, v[1] as f32, 0.0 - v[2] as f32]);
                        m.2.extend_from_slice(&nrm[c]);
                        next
                    });
                    m.3.push(id);
                }
            }
        }
        push_sep(&mut meshes, n_mesh);
        push_sep(&mut nodes, n_mesh);
        meshes.push_str("{\"name\":");
        json_str(&g.name, &mut meshes);
        meshes.push_str(",\"primitives\":[");
        for (k, (mat, pos, nrm, idx)) in merged.iter().enumerate() {
            let (mut lo, mut hi) = ([f32::MAX; 3], [f32::MIN; 3]);
            for v in pos.chunks_exact(3) {
                for a in 0..3 {
                    lo[a] = lo[a].min(v[a]);
                    hi[a] = hi[a].max(v[a]);
                }
            }
            let pos_off = bin.len();
            for f in pos {
                bin.extend_from_slice(&f.to_le_bytes());
            }
            let idx_off = bin.len();
            for i in idx {
                bin.extend_from_slice(&i.to_le_bytes());
            }
            let nrm_off = bin.len();
            for f in nrm {
                bin.extend_from_slice(&f.to_le_bytes());
            }
            push_sep(&mut views, n_views);
            views.push_str(&format!("{{\"buffer\":0,\"byteOffset\":{pos_off},\"byteLength\":{},\"target\":34962}}", pos.len() * 4));
            views.push_str(&format!(",{{\"buffer\":0,\"byteOffset\":{idx_off},\"byteLength\":{},\"target\":34963}}", idx.len() * 4));
            views.push_str(&format!(",{{\"buffer\":0,\"byteOffset\":{nrm_off},\"byteLength\":{},\"target\":34962}}", nrm.len() * 4));
            push_sep(&mut accessors, n_acc);
            // min/max als exakter Wert des f32 (der Prüfer vergleicht mit den Daten).
            accessors.push_str(&format!(
                "{{\"bufferView\":{n_views},\"componentType\":5126,\"count\":{},\"type\":\"VEC3\",\"min\":[{},{},{}],\"max\":[{},{},{}]}}",
                pos.len() / 3,
                f64::from(lo[0]),
                f64::from(lo[1]),
                f64::from(lo[2]),
                f64::from(hi[0]),
                f64::from(hi[1]),
                f64::from(hi[2])
            ));
            accessors.push_str(&format!(
                ",{{\"bufferView\":{},\"componentType\":5125,\"count\":{},\"type\":\"SCALAR\"}}",
                n_views + 1,
                idx.len()
            ));
            accessors.push_str(&format!(",{{\"bufferView\":{},\"componentType\":5126,\"count\":{},\"type\":\"VEC3\"}}", n_views + 2, nrm.len() / 3));
            let material = if *mat >= 0 {
                *mat as usize
            } else {
                need_default = true;
                default_material
            };
            push_sep(&mut meshes, k);
            meshes.push_str(&format!(
                "{{\"attributes\":{{\"POSITION\":{n_acc},\"NORMAL\":{}}},\"indices\":{},\"material\":{material},\"mode\":4}}",
                n_acc + 2,
                n_acc + 1
            ));
            n_views += 3;
            n_acc += 3;
        }
        meshes.push_str("]}");
        nodes.push_str("{\"name\":");
        json_str(&g.name, &mut nodes);
        nodes.push_str(&format!(",\"mesh\":{n_mesh},\"extras\":{{\"type\":"));
        json_str(&g.kind, &mut nodes);
        nodes.push_str(",\"id\":");
        json_str(&g.id, &mut nodes);
        nodes.push_str("}}");
        node_levels.push(g.level);
        n_mesh += 1;
    }

    // Geschoss-Knoten als Eltern (nur die mit Kindern).
    let mut scene_nodes: Vec<usize> = Vec::new();
    let mut n_nodes = n_mesh;
    if s.by_level {
        for (li, (id, name)) in s.levels.iter().enumerate() {
            let kids: Vec<usize> = (0..n_mesh).filter(|i| node_levels[*i] == li as i64).collect();
            if kids.is_empty() {
                continue;
            }
            push_sep(&mut nodes, n_nodes);
            nodes.push_str("{\"name\":");
            json_str(name, &mut nodes);
            nodes.push_str(",\"children\":[");
            nodes.push_str(&kids.iter().map(usize::to_string).collect::<Vec<_>>().join(","));
            nodes.push_str("],\"extras\":{\"type\":\"level\",\"id\":");
            json_str(id, &mut nodes);
            nodes.push_str("}}");
            scene_nodes.push(n_nodes);
            n_nodes += 1;
        }
        for (i, l) in node_levels.iter().enumerate() {
            if *l < 0 {
                scene_nodes.push(i);
            }
        }
    } else {
        scene_nodes.extend(0..n_mesh);
    }

    // Materialien (PBR, Farbe linear).
    let mut mats = String::new();
    for m in &s.materials {
        push_material(&mut mats, &m.name, m.rgba, m.metallic, m.roughness);
    }
    if need_default {
        push_material(&mut mats, "Standard", [0.8, 0.8, 0.8, 1.0], 0.0, 0.8);
    }

    let mut j = String::from(
        "{\"asset\":{\"version\":\"2.0\",\"generator\":\"Dossier\",\"extras\":{\"units\":\"m\",\"upAxis\":\"Y\",\"note\":\"Modell (x,y,z-hoch) -> glTF (x,z,-y); Norden = -Z\"}},\"scene\":0,\"scenes\":[{",
    );
    // Leere Szene ohne `nodes` (glTF verlangt ≥ 1 Eintrag, wenn die Liste da ist; Validator EMPTY_ENTITY).
    if !scene_nodes.is_empty() {
        j.push_str("\"nodes\":[");
        j.push_str(&scene_nodes.iter().map(usize::to_string).collect::<Vec<_>>().join(","));
        j.push(']');
    }
    j.push_str("}]");
    if n_nodes > 0 {
        j.push_str(",\"nodes\":[");
        j.push_str(&nodes);
        j.push(']');
    }
    if !mats.is_empty() {
        j.push_str(",\"materials\":[");
        j.push_str(&mats);
        j.push(']');
    }
    if n_mesh > 0 {
        j.push_str(",\"meshes\":[");
        j.push_str(&meshes);
        j.push_str("],\"accessors\":[");
        j.push_str(&accessors);
        j.push_str("],\"bufferViews\":[");
        j.push_str(&views);
        j.push_str("],\"buffers\":[{");
        if uri_for_buffer {
            j.push_str(&format!("\"uri\":\"data:application/octet-stream;base64,{}\",", base64(&bin)));
        }
        j.push_str(&format!("\"byteLength\":{}}}]", bin.len()));
    }
    j.push('}');
    (j, bin)
}

// ── Öffentliche Schreiber ───────────────────────────────────────────────────

/// OBJ-Text aus der flachen Szene.
pub fn export_obj(flat: &[f64], strings: &str, mtl_name: &str) -> Result<String, String> {
    Ok(write_obj(&parse(flat, strings)?, mtl_name))
}

/// MTL-Datei (Farben) zum OBJ aus derselben Szene.
pub fn export_mtl(flat: &[f64], strings: &str) -> Result<String, String> {
    Ok(write_mtl(&parse(flat, strings)?))
}

/// ASCII-STL aus der flachen Szene.
pub fn export_stl(flat: &[f64], strings: &str) -> Result<String, String> {
    Ok(write_stl(&parse(flat, strings)?))
}

/// glTF 2.0 als JSON-Text (Puffer als Base64-Data-URI eingebettet).
pub fn export_gltf(flat: &[f64], strings: &str) -> Result<String, String> {
    Ok(build_gltf(&parse(flat, strings)?, true).0)
}

/// glTF 2.0 binär (GLB: JSON-Chunk + BIN-Chunk).
pub fn export_glb(flat: &[f64], strings: &str) -> Result<Vec<u8>, String> {
    let (json, bin) = build_gltf(&parse(flat, strings)?, false);
    let mut json = json.into_bytes();
    while json.len() % 4 != 0 {
        json.push(b' ');
    }
    let mut bin = bin;
    while bin.len() % 4 != 0 {
        bin.push(0);
    }
    let total = 12 + 8 + json.len() + if bin.is_empty() { 0 } else { 8 + bin.len() };
    if total > u32::MAX as usize {
        return Err("GLB zu gross (> 4 GiB)".into());
    }
    let mut out = Vec::with_capacity(total);
    out.extend_from_slice(&0x4654_6C67u32.to_le_bytes());
    out.extend_from_slice(&2u32.to_le_bytes());
    out.extend_from_slice(&(total as u32).to_le_bytes());
    out.extend_from_slice(&(json.len() as u32).to_le_bytes());
    out.extend_from_slice(&0x4E4F_534Au32.to_le_bytes());
    out.extend_from_slice(&json);
    if !bin.is_empty() {
        out.extend_from_slice(&(bin.len() as u32).to_le_bytes());
        out.extend_from_slice(&0x004E_4942u32.to_le_bytes());
        out.extend_from_slice(&bin);
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// WASM-Fassade (nur bei Feature "web"): bei kaputtem Puffer leeres Ergebnis, nie ein Panic; den Grund
// liefert `export_mesh_check_flat`.
// ---------------------------------------------------------------------------

#[cfg(feature = "web")]
mod wasm {
    use wasm_bindgen::prelude::*;

    /// Flache Szene → OBJ-Text; leer bei kaputtem Puffer. `mtl_name` = Dateiname der MTL (`mtllib`), leer = keine.
    #[wasm_bindgen]
    pub fn export_mesh_obj_flat(flat: &[f64], strings: &str, mtl_name: &str) -> String {
        super::export_obj(flat, strings, mtl_name).unwrap_or_default()
    }

    /// Flache Szene → MTL-Text (Farben zum OBJ); leer bei kaputtem Puffer.
    #[wasm_bindgen]
    pub fn export_mesh_mtl_flat(flat: &[f64], strings: &str) -> String {
        super::export_mtl(flat, strings).unwrap_or_default()
    }

    /// Flache Szene → ASCII-STL; leer bei kaputtem Puffer.
    #[wasm_bindgen]
    pub fn export_mesh_stl_flat(flat: &[f64], strings: &str) -> String {
        super::export_stl(flat, strings).unwrap_or_default()
    }

    /// Flache Szene → glTF-JSON (Puffer eingebettet); leer bei kaputtem Puffer.
    #[wasm_bindgen]
    pub fn export_mesh_gltf_flat(flat: &[f64], strings: &str) -> String {
        super::export_gltf(flat, strings).unwrap_or_default()
    }

    /// Flache Szene → GLB-Bytes; leer bei kaputtem Puffer.
    #[wasm_bindgen]
    pub fn export_mesh_glb_flat(flat: &[f64], strings: &str) -> Vec<u8> {
        super::export_glb(flat, strings).unwrap_or_default()
    }

    /// Fehlertext zur Eingabe (leer = in Ordnung) — für Meldungen auf der TS-Seite.
    #[wasm_bindgen]
    pub fn export_mesh_check_flat(flat: &[f64], strings: &str) -> String {
        match super::export_stl(flat, strings) {
            Ok(_) => String::new(),
            Err(e) => e,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Baut einen flachen Puffer wie die TS-Seite.
    #[derive(Default)]
    struct Flat {
        nums: Vec<f64>,
        strings: Vec<String>,
    }
    impl Flat {
        fn s(&mut self, s: &str) -> f64 {
            self.strings.push(s.to_string());
            (self.strings.len() - 1) as f64
        }
        fn args(&self) -> (Vec<f64>, String) {
            (self.nums.clone(), self.strings.join("\0"))
        }
    }

    /// Zwei Gruppen: ein Quader (Material 0, Geschoss 0) und ein Dreieck ohne Material (ohne Geschoss).
    fn scene(by_level: bool) -> (Vec<f64>, String) {
        let mut f = Flat::default();
        let mn = f.s("Beton");
        let ln = f.s("EG");
        let lid = f.s("eg");
        let g1 = f.s("Wand_W1");
        let k1 = f.s("wall");
        let i1 = f.s("W1");
        let g2 = f.s("Decke_D\"1");
        let k2 = f.s("slab");
        let i2 = f.s("D1");
        f.nums = vec![FLAT_VERSION, if by_level { 1.0 } else { 0.0 }];
        f.nums.extend([1.0, mn, 0.8, 0.8, 0.8, 1.0, 0.0, 0.9]);
        f.nums.extend([1.0, lid, ln]);
        f.nums.push(2.0);
        // Quader 0..1 (12 Dreiecke, Wicklung wie `BOX_QUADS` in exportMesh.ts)
        let mut pos = Vec::new();
        for i in 0..8 {
            pos.extend([f64::from(i & 1), f64::from((i >> 1) & 1), f64::from((i >> 2) & 1)]);
        }
        let quads: [[u32; 4]; 6] = [[4, 6, 7, 5], [1, 3, 2, 0], [2, 3, 7, 6], [4, 5, 1, 0], [1, 5, 7, 3], [2, 6, 4, 0]];
        let mut idx = Vec::new();
        for q in quads {
            idx.extend([q[0], q[1], q[2], q[0], q[2], q[3]]);
        }
        f.nums.extend([g1, k1, i1, 0.0, 1.0, 0.0, 8.0]);
        f.nums.extend(pos);
        f.nums.push(12.0);
        f.nums.extend(idx.iter().map(|i| f64::from(*i)));
        f.nums.extend([g2, k2, i2, -1.0, 1.0, -1.0, 3.0, 0.0, 2.5, 0.0, 1.0, 2.5, 0.0, 0.0, 2.5, 1.0, 1.0, 0.0, 1.0, 2.0]);
        f.args()
    }

    #[test]
    fn obj_aufbau() {
        let (n, s) = scene(true);
        let obj = export_obj(&n, &s, "").unwrap();
        assert!(obj.starts_with("# DOSSIER OBJ-Export"));
        assert!(obj.contains("o Wand_W1\nv 0.0 0.0 0.0\nv 1.0 0.0 0.0\n"));
        // Zweite Gruppe: Indizes global (8 Vertices davor, 1-basiert). Rechtshändig: Z gespiegelt, Wicklung vertauscht.
        // Normale der Decke (Dreiecks-Normale in Szene-Achsen (0,-1,0), Spiegelung von z ändert sie nicht); davor 6 Würfel-Normalen (flach, 90° > Knickwinkel), daher Index 7.
        assert!(obj.contains("o Decke_D\"1\nv 0.0 2.5 0.0\nv 1.0 2.5 0.0\nv 0.0 2.5 -1.0\nvn 0.0 -1.0 0.0\nusemtl Standard\nf 9//7 11//7 10//7\n"), "{obj}");
        assert_eq!(obj.matches("\nf ").count(), 13);
        // Ohne MTL-Datei: Farben als Kommentar, Gruppen je Material.
        assert!(obj.contains("# Beton: Kd 0.8 0.8 0.8 d 1.0\n") && obj.contains("usemtl Beton\n") && !obj.contains("mtllib"), "{obj}");
        // Jede Fläche trägt Normale; Würfel: genau 6 verschiedene `vn`.
        assert_eq!(obj.split("o Decke").next().unwrap().matches("\nvn ").count(), 6);
    }

    #[test]
    fn obj_mit_mtl() {
        let (n, s) = scene(true);
        let obj = export_obj(&n, &s, "haus.mtl").unwrap();
        assert!(obj.contains("\nmtllib haus.mtl\n") && !obj.contains("# Beton: Kd"), "{obj}");
        let mtl = export_mtl(&n, &s).unwrap();
        assert!(mtl.contains("\nnewmtl Beton\nKa 0 0 0\nKd 0.8 0.8 0.8\nKs 0 0 0\nd 1.0\nillum 2\n"), "{mtl}");
        assert!(mtl.contains("\nnewmtl Standard\n"), "{mtl}");
    }

    #[test]
    fn normalen_im_gltf_flach_und_geteilt() {
        // Würfel: scharfe Kanten (90°) ⇒ 24 Eckpunkte, Normalen = Einheitsachsen, passend zur geschriebenen Wicklung.
        let (n, s) = scene(false);
        let (json, bin) = build_gltf(&parse(&n, &s).unwrap(), false);
        assert!(json.contains(r#""NORMAL":2"#), "{json}");
        let f = |o: usize| f32::from_le_bytes(bin[o..o + 4].try_into().unwrap());
        let idx = |o: usize| u32::from_le_bytes(bin[o..o + 4].try_into().unwrap()) as usize;
        // Gruppe 1: 24 Positionen (288 B), 36 Indizes (144 B), dann 24 Normalen.
        let (pos0, idx0, nrm0) = (0, 24 * 12, 24 * 12 + 36 * 4);
        let at = |base: usize, v: usize| [f(base + v * 12), f(base + v * 12 + 4), f(base + v * 12 + 8)];
        for v in 0..24 {
            let n = at(nrm0, v);
            assert!((n.iter().map(|x| x * x).sum::<f32>() - 1.0).abs() < 1e-5 && n.iter().filter(|x| x.abs() > 0.99).count() == 1, "{n:?}");
        }
        for t in 0..12 {
            let (a, b, c) = (idx(idx0 + t * 12), idx(idx0 + t * 12 + 4), idx(idx0 + t * 12 + 8));
            let (pa, pb, pc) = (at(pos0, a), at(pos0, b), at(pos0, c));
            let (u, w) = ([pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]], [pc[0] - pa[0], pc[1] - pa[1], pc[2] - pa[2]]);
            let cross = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
            for v in [a, b, c] {
                let n = at(nrm0, v);
                assert!(cross[0] * n[0] + cross[1] * n[1] + cross[2] * n[2] > 0.0, "Dreieck {t}: Normale gegen die Wicklung");
            }
        }
        // Leicht geknickte Fläche (zwei Dreiecke, ~6° Knick < Knickwinkel) ⇒ geteilte Normalen: 4 statt 6 Eckpunkte.
        let mut f2 = Flat::default();
        let (g, k, i) = (f2.s("Wand_X"), f2.s("wall"), f2.s("X"));
        f2.nums = vec![FLAT_VERSION, 0.0, 0.0, 0.0, 1.0, g, k, i, -1.0, 1.0, -1.0, 4.0];
        f2.nums.extend([0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 1.0, 1.0, 0.1]);
        f2.nums.extend([2.0, 0.0, 1.0, 2.0, 1.0, 3.0, 2.0]);
        let (n2, s2) = f2.args();
        let (json2, _) = build_gltf(&parse(&n2, &s2).unwrap(), false);
        assert!(json2.contains(r#""count":4,"type":"VEC3","min""#), "{json2}");
        assert!(json2.contains(r#""count":4,"type":"VEC3"}"#), "{json2}");
    }

    #[test]
    fn stl_aufbau() {
        let (n, s) = scene(true);
        let stl = export_stl(&n, &s).unwrap();
        assert!(stl.starts_with("solid dossier\nfacet normal "));
        assert!(stl.ends_with("endloop\nendfacet\nendsolid dossier\n"));
        assert_eq!(stl.matches("facet normal").count(), 13);
        assert_eq!(stl.matches("vertex ").count(), 39);
        // Welt-Dreieck (0,2.5,0)(1,2.5,0)(0,2.5,1) ⇒ Datei (x, y, −z) mit vertauschter Wicklung: Normale (0, -1, 0)
        // bleibt (Wicklung und Spiegelung heben sich in der Normale auf), Ecken (0,2.5,0)(0,2.5,-1)(1,2.5,0).
        assert!(stl.contains("facet normal 0.0 -1.0 0.0\nouter loop\nvertex 0.0 2.5 0.0\nvertex 0.0 2.5 -1.0\nvertex 1.0 2.5 0.0\n"), "{stl}");
    }

    fn json_of_glb(glb: &[u8]) -> (String, usize) {
        assert_eq!(&glb[0..4], b"glTF");
        assert_eq!(u32::from_le_bytes(glb[4..8].try_into().unwrap()), 2);
        assert_eq!(u32::from_le_bytes(glb[8..12].try_into().unwrap()) as usize, glb.len());
        let jl = u32::from_le_bytes(glb[12..16].try_into().unwrap()) as usize;
        assert_eq!(&glb[16..20], b"JSON");
        assert_eq!(jl % 4, 0);
        let json = String::from_utf8(glb[20..20 + jl].to_vec()).unwrap();
        let rest = &glb[20 + jl..];
        let bl = if rest.is_empty() {
            0
        } else {
            assert_eq!(&rest[4..8], b"BIN\0");
            let bl = u32::from_le_bytes(rest[0..4].try_into().unwrap()) as usize;
            assert_eq!(bl % 4, 0);
            assert_eq!(rest.len(), 8 + bl);
            bl
        };
        (json, bl)
    }

    #[test]
    fn glb_aufbau() {
        let (n, s) = scene(true);
        let glb = export_glb(&n, &s).unwrap();
        let (json, bl) = json_of_glb(&glb);
        // Puffer: Würfel mit scharfen Kanten = 24 Eckpunkte + 3 des Dreiecks, je Position + Normale 24 B; (36 + 3) Indizes je 4 B.
        assert_eq!(bl, (24 + 3) * 24 + (36 + 3) * 4);
        assert!(json.contains(&format!("\"byteLength\":{bl}")));
        // Knoten 0/1 = Bauteile, Knoten 2 = Geschoss mit Kind 0; Decke (ohne Geschoss) bleibt an der Wurzel.
        assert!(json.contains("\"scenes\":[{\"nodes\":[2,1]}]"), "{json}");
        assert!(json.contains("\"name\":\"EG\",\"children\":[0]"));
        assert!(json.contains("\"name\":\"Decke_D\\\"1\""));
        assert!(json.contains("\"name\":\"Standard\""));
        assert!(!json.contains("alphaMode"));
        // Z gespiegelt: Quader-Ecke z=1 wird -1.
        assert!(json.contains("\"min\":[0,0,-1],\"max\":[1,1,0]"), "{json}");
    }

    #[test]
    fn gltf_ohne_geschossgliederung_und_base64() {
        let (n, s) = scene(false);
        let g = export_gltf(&n, &s).unwrap();
        assert!(g.contains("\"scenes\":[{\"nodes\":[0,1]}]"));
        assert!(g.contains("data:application/octet-stream;base64,"));
        assert!(!g.contains("\"children\""));
        assert_eq!(base64(b"Ma"), "TWE=");
        assert_eq!(base64(b"M"), "TQ==");
        assert_eq!(base64(b"Man"), "TWFu");
    }

    #[test]
    fn leere_szene_gueltig() {
        let n = vec![FLAT_VERSION, 0.0, 0.0, 0.0, 0.0];
        let glb = export_glb(&n, "").unwrap();
        let (json, bl) = json_of_glb(&glb);
        assert_eq!(bl, 0);
        assert!(json.trim_end().ends_with("\"scene\":0,\"scenes\":[{}]}"), "{json}");
        assert_eq!(export_obj(&n, "", "").unwrap().lines().count(), 7);
        assert_eq!(export_stl(&n, "").unwrap(), "solid dossier\nendsolid dossier\n");
    }

    #[test]
    fn transparentes_material() {
        let mut f = Flat::default();
        let g = f.s("Glas");
        let nm = f.s("Verglasung");
        let nk = f.s("glazing");
        let ni = f.s("");
        f.nums = vec![FLAT_VERSION, 0.0, 1.0, g, 0.62, 0.76, 0.85, 0.3, 0.0, 0.05, 0.0, 1.0, nm, nk, ni, -1.0, 1.0, 0.0, 3.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 1.0, 0.0, 1.0, 2.0];
        let (n, s) = f.args();
        let (json, _) = build_gltf(&parse(&n, &s).unwrap(), false);
        assert!(json.contains("\"alphaMode\":\"BLEND\""));
        assert!(json.contains("\"roughnessFactor\":0.05"));
    }

    #[test]
    fn kaputte_puffer_ohne_panic() {
        let (n, s) = scene(true);
        for len in 0..n.len() {
            assert!(export_glb(&n[..len], &s).is_err(), "len {len}");
        }
        for pos in [0usize, 1, 2, 4, 5, 8, 12, 20, 30, 40, n.len() - 1] {
            for bad in [f64::NAN, f64::INFINITY, -1.0, 1e12, 0.5] {
                let mut m = n.clone();
                m[pos] = bad;
                let _ = export_obj(&m, &s, "");
                let _ = export_stl(&m, &s);
                let _ = export_glb(&m, &s);
                let _ = export_gltf(&m, &s);
            }
        }
        assert!(export_obj(&n, "", "").is_err());
        assert!(export_obj(&[], "", "").is_err());
    }

    #[test]
    fn hypot_wie_math_hypot() {
        assert_eq!(js_hypot3(3.0, 4.0, 0.0), 5.0);
        assert_eq!(js_hypot3(0.0, 0.0, 0.0), 0.0);
    }
}
