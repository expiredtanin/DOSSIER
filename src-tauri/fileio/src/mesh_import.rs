// Allgemeiner Mesh-Import als Kontext-Meshes ([B3]/[C11], 28.10.): OBJ (+ MTL), STL (ASCII/binär, Farbvarianten),
// PLY mit Flächen und glTF 2.0 / GLB (`mesh_import_gltf.rs`). Eigener Code, keine Abhängigkeit ausser earcutr
// (schon im Baum) für Polygone mit mehr als drei Ecken.
//
// Ergebnis: je Objekt (OBJ `o`/`g` und Material, glTF-Knoten und Material, STL-`solid`, PLY-Flächenfarbe)
// ein Mesh mit Name, Gruppe (= Ebene im Kontext-Panel) und Farbe. Koordinaten am Ende der Lesung in
// Modell-Meter, Z = Höhe:
//   * Einheit: `unit_scale` (Meter je Dateieinheit) für OBJ/STL/PLY; glTF ist laut Spezifikation immer Meter.
//   * Achse: glTF ist Y-up und rechtshändig — Umkehr der Abbildung in `mesh_export.rs` (Modell (x, y, z) →
//     Datei (x, z, −y)), also Datei (X, Y, Z) → Modell (X, −Z, Y). Das ist eine Drehung (keine Spiegelung), die
//     Dreiecks-Wicklung bleibt. OBJ/STL/PLY: `Up::Z` unverändert, `Up::Y` wie glTF, `Up::Auto` per Erkennung
//     (Kopfkommentar, dann Ausdehnung, dann Formatvorgabe) — `up_certain` sagt, ob sie belastbar war.
//   * Ungültiges (NaN, Index ausserhalb, entartete Dreiecke) wird verworfen und gezählt, nie ein Panic.
//   * Budget: `max_triangles` (Rest wird abgeschnitten, `truncated`), Eckpunkte höchstens `MAX_VERTICES`.
//
// Flache Ausgabe (`encode`): Zahlen als f64-Puffer, Zeichenketten als Tabelle:
//   [VERSION, format, up_used (0 Z, 1 Y), up_auto, up_certain, unit_scale, triangles, degenerate, bad_faces,
//    truncated, n_warnings, n_objects, warning-Index × n_warnings,
//    (name, group (−1 = keine), has_color, r, g, b, a (sRGB 0..1), n_pos, n_idx, pos…, idx…) × n_objects]

use std::collections::HashMap;

use crate::mesh_import_gltf::read_gltf;

pub const FLAT_VERSION: f64 = 1.0;
/// Höchstzahl Eckpunkte je Datei (Speicherbudget im WASM).
pub const MAX_VERTICES: usize = 24_000_000;
/// Voreinstellung für die Dreiecksgrenze.
pub const DEFAULT_MAX_TRIANGLES: usize = 6_000_000;
/// Fehlertext (Präfix) für PLY ohne Flächen: die TS-Seite verweist dann auf den Punktwolken-Import.
pub const NO_FACES: &str = "[punktwolke]";

/// Welche Achse oben liegt (Dateikoordinaten).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Up {
    Auto,
    Z,
    Y,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Format {
    Obj,
    Stl,
    Gltf,
    Ply,
}

impl Format {
    fn code(self) -> f64 {
        match self {
            Format::Obj => 0.0,
            Format::Stl => 1.0,
            Format::Gltf => 2.0,
            Format::Ply => 3.0,
        }
    }
}

pub struct Options {
    /// Meter je Dateieinheit (OBJ/STL/PLY); nicht endlich oder ≤ 0 gilt als 1.
    pub unit_scale: f64,
    pub up: Up,
    pub max_triangles: usize,
    /// Mitgegebene Nachbardateien (`.bin` zu `.gltf`, `.mtl` zu `.obj`), Name ohne Verzeichnis.
    pub files: Vec<(String, Vec<u8>)>,
}

impl Default for Options {
    fn default() -> Self {
        Options { unit_scale: 1.0, up: Up::Auto, max_triangles: DEFAULT_MAX_TRIANGLES, files: Vec::new() }
    }
}

/// Ein importiertes Objekt in Modell-Koordinaten (Meter, Z oben).
#[derive(Clone, Debug, Default)]
pub struct MeshObject {
    pub name: String,
    /// Übergeordnete Gruppe (OBJ `o` über `g`, glTF-Eltern-Knoten); leer = keine.
    pub group: String,
    /// sRGB 0..1 mit Alpha.
    pub color: Option<[f32; 4]>,
    pub positions: Vec<f64>,
    pub indices: Vec<u32>,
}

#[derive(Debug)]
pub struct MeshImport {
    pub format: Format,
    pub objects: Vec<MeshObject>,
    pub up_used: Up,
    /// Achse wurde erkannt (nicht vorgegeben).
    pub up_auto: bool,
    /// Erkennung belastbar (Kopfkommentar oder eindeutige Ausdehnung).
    pub up_certain: bool,
    pub unit_scale: f64,
    pub triangles: usize,
    pub degenerate: usize,
    pub bad_faces: usize,
    pub truncated: bool,
    pub warnings: Vec<String>,
}

// ── gemeinsame Zwischenform ─────────────────────────────────────────────────

/// Objekt vor dem Verdichten: Dreiecke als Indizes in den gemeinsamen Eckpunkt-Pool.
pub(crate) struct Raw {
    pub name: String,
    pub group: String,
    pub color: Option<[f32; 4]>,
    pub tris: Vec<[u32; 3]>,
}

/// Lesestand: Pool (x, y, z je Eckpunkt, Dateikoordinaten), Objekte, Zähler.
pub(crate) struct Parsed {
    pub pool: Vec<f64>,
    pub objects: Vec<Raw>,
    pub bad_faces: usize,
    pub truncated: bool,
    pub warnings: Vec<String>,
    pub tri_count: usize,
    pub max_triangles: usize,
    /// Hinweis aus dem Dateikopf auf die Achse (`Some(true)` = Y-up).
    pub up_hint: Option<Up>,
    /// Achse ist durch das Format festgelegt (glTF).
    pub up_fixed: Option<Up>,
}

impl Parsed {
    pub fn new(max_triangles: usize) -> Parsed {
        Parsed {
            pool: Vec::new(),
            objects: Vec::new(),
            bad_faces: 0,
            truncated: false,
            warnings: Vec::new(),
            tri_count: 0,
            max_triangles,
            up_hint: None,
            up_fixed: None,
        }
    }
    pub fn vertex_count(&self) -> usize {
        self.pool.len() / 3
    }
    /// Noch Platz für `n` Dreiecke? Sonst wird abgeschnitten.
    pub fn room(&mut self, n: usize) -> bool {
        if self.tri_count.saturating_add(n) > self.max_triangles {
            self.truncated = true;
            return false;
        }
        self.tri_count += n;
        true
    }
    pub fn warn(&mut self, w: String) {
        if self.warnings.len() < 20 && !self.warnings.contains(&w) {
            self.warnings.push(w);
        }
    }
}

// ── Eintritt ────────────────────────────────────────────────────────────────

fn extension(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or(name);
    match base.rsplit_once('.') {
        Some((_, e)) => e.to_ascii_lowercase(),
        None => String::new(),
    }
}

fn stem(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or(name);
    match base.rsplit_once('.') {
        Some((s, _)) if !s.is_empty() => s.to_string(),
        _ => base.to_string(),
    }
}

/// Format am Inhalt erkennen, die Endung nur als Hinweis.
pub fn detect_format(bytes: &[u8], name: &str) -> Option<Format> {
    if bytes.starts_with(b"glTF") {
        return Some(Format::Gltf);
    }
    if bytes.starts_with(b"ply") && bytes.get(3).is_some_and(|c| *c == b'\n' || *c == b'\r') {
        return Some(Format::Ply);
    }
    let head = &bytes[..bytes.len().min(4096)];
    let first = head.iter().copied().find(|c| !c.is_ascii_whitespace() && *c != 0xEF && *c != 0xBB && *c != 0xBF);
    let ext = extension(name);
    if first == Some(b'{') && (ext == "gltf" || ext == "json" || head.windows(5).any(|w| w == b"\"asse")) {
        return Some(Format::Gltf);
    }
    match ext.as_str() {
        "stl" => return Some(Format::Stl),
        "obj" => return Some(Format::Obj),
        "ply" => return Some(Format::Ply),
        "gltf" | "glb" => return Some(Format::Gltf),
        _ => {}
    }
    if is_binary_stl(bytes) || (head.starts_with(b"solid") && head.windows(5).any(|w| w == b"facet")) {
        return Some(Format::Stl);
    }
    let text = String::from_utf8_lossy(head);
    if text.lines().any(|l| l.starts_with("v ") || l.starts_with("f ") || l.starts_with("o ") || l.starts_with("g ")) {
        return Some(Format::Obj);
    }
    None
}

/// Mesh-Datei lesen. `name` = Dateiname (Endung als Hinweis, Stamm als Vorgabename).
pub fn import_mesh(bytes: &[u8], name: &str, opts: &Options) -> Result<MeshImport, String> {
    let format = detect_format(bytes, name).ok_or("Dateiformat nicht erkannt (erwartet: OBJ, STL, glTF/GLB oder PLY)")?;
    if bytes.is_empty() {
        return Err("Datei ist leer".into());
    }
    let max = opts.max_triangles.max(1);
    let mut parsed = Parsed::new(max);
    match format {
        Format::Obj => read_obj(bytes, opts, &mut parsed)?,
        Format::Stl => read_stl(bytes, &mut parsed)?,
        Format::Ply => read_ply_mesh(bytes, &mut parsed)?,
        Format::Gltf => read_gltf(bytes, opts, &mut parsed)?,
    }
    finish(parsed, format, &stem(name), opts)
}

/// Verdichten (nur benutzte Eckpunkte), Achse und Einheit anwenden.
fn finish(parsed: Parsed, format: Format, default_name: &str, opts: &Options) -> Result<MeshImport, String> {
    let Parsed { pool, objects, bad_faces, truncated, mut warnings, up_hint, up_fixed, .. } = parsed;
    let mut bad = bad_faces;
    let mut degenerate = 0usize;
    let mut out: Vec<MeshObject> = Vec::new();
    let nverts = pool.len() / 3;
    for raw in objects {
        let mut remap: HashMap<u32, u32> = HashMap::new();
        let mut positions: Vec<f64> = Vec::new();
        let mut indices: Vec<u32> = Vec::with_capacity(raw.tris.len() * 3);
        for t in &raw.tris {
            let ok = t.iter().all(|&i| {
                let i = i as usize;
                i < nverts && pool[i * 3..i * 3 + 3].iter().all(|v| v.is_finite())
            });
            if !ok {
                bad += 1;
                continue;
            }
            if t[0] == t[1] || t[1] == t[2] || t[0] == t[2] {
                degenerate += 1;
                continue;
            }
            for &i in t {
                let n = remap.len() as u32;
                let k = *remap.entry(i).or_insert_with(|| {
                    let b = i as usize * 3;
                    positions.extend_from_slice(&pool[b..b + 3]);
                    n
                });
                indices.push(k);
            }
        }
        if indices.is_empty() {
            continue;
        }
        let name = if raw.name.is_empty() { default_name.to_string() } else { raw.name };
        out.push(MeshObject { name, group: raw.group, color: raw.color, positions, indices });
    }
    if out.is_empty() {
        return Err(if truncated { "Keine Dreiecke gelesen (Budget erschöpft)".into() } else { "Die Datei enthält keine Dreiecke".into() });
    }

    // Achse.
    let (up_used, up_auto, up_certain) = match (up_fixed, opts.up) {
        (Some(u), _) => (u, false, true),
        (None, Up::Z) => (Up::Z, false, true),
        (None, Up::Y) => (Up::Y, false, true),
        (None, Up::Auto) => {
            let (u, certain) = detect_up(&out, up_hint, format);
            (u, true, certain)
        }
    };
    let scale = if format == Format::Gltf {
        1.0
    } else if opts.unit_scale.is_finite() && opts.unit_scale > 0.0 {
        opts.unit_scale
    } else {
        1.0
    };
    for o in &mut out {
        for v in o.positions.chunks_exact_mut(3) {
            let (x, y, z) = (v[0] * scale, v[1] * scale, v[2] * scale);
            if up_used == Up::Y {
                // Datei (X, Y, Z) → Modell (X, −Z, Y); `0.0 - z` verhindert −0.
                v[0] = x;
                v[1] = 0.0 - z;
                v[2] = y;
            } else {
                v[0] = x;
                v[1] = y;
                v[2] = z;
            }
        }
    }
    let triangles = out.iter().map(|o| o.indices.len() / 3).sum();
    if degenerate > 0 {
        warnings.push(format!("{degenerate} entartete Dreiecke verworfen"));
    }
    if bad > 0 {
        warnings.push(format!("{bad} ungültige Flächen verworfen (Index ausserhalb, NaN oder zu wenige Ecken)"));
    }
    if truncated {
        warnings.push("Dreiecksgrenze erreicht: Rest der Datei nicht gelesen".into());
    }
    Ok(MeshImport {
        format,
        objects: out,
        up_used,
        up_auto,
        up_certain,
        unit_scale: scale,
        triangles,
        degenerate,
        bad_faces: bad,
        truncated,
        warnings,
    })
}

/// Achse erkennen: Kopfkommentar, dann die kleinste Ausdehnung (Gebäude, Möbel und Gelände sind in der
/// Regel niedriger als breit), sonst Formatvorgabe (OBJ Y-up wie Blender/SketchUp-Voreinstellung, STL/PLY Z-up).
fn detect_up(objs: &[MeshObject], hint: Option<Up>, format: Format) -> (Up, bool) {
    if let Some(h) = hint {
        return (h, true);
    }
    let (mut lo, mut hi) = ([f64::MAX; 3], [f64::MIN; 3]);
    for o in objs {
        for v in o.positions.chunks_exact(3) {
            for a in 0..3 {
                lo[a] = lo[a].min(v[a]);
                hi[a] = hi[a].max(v[a]);
            }
        }
    }
    let e = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
    if e.iter().all(|v| v.is_finite()) {
        if e[2] < 0.8 * e[0].min(e[1]) {
            return (Up::Z, true);
        }
        if e[1] < 0.8 * e[0].min(e[2]) {
            return (Up::Y, true);
        }
    }
    (if format == Format::Obj { Up::Y } else { Up::Z }, false)
}

// ── Polygone triangulieren ──────────────────────────────────────────────────

/// Polygon (Indizes in den Pool) → Dreiecke; Drehsinn bleibt wie im Polygon. Ohne gültige Zerlegung: Fächer.
pub(crate) fn triangulate(pool: &[f64], poly: &[u32], out: &mut Vec<[u32; 3]>) {
    let n = poly.len();
    if n < 3 {
        return;
    }
    if n == 3 {
        out.push([poly[0], poly[1], poly[2]]);
        return;
    }
    let fan = |out: &mut Vec<[u32; 3]>| {
        for k in 1..n - 1 {
            out.push([poly[0], poly[k], poly[k + 1]]);
        }
    };
    let pt = |i: u32| -> Option<[f64; 3]> {
        let b = i as usize * 3;
        let s = pool.get(b..b + 3)?;
        Some([s[0], s[1], s[2]])
    };
    let pts: Option<Vec<[f64; 3]>> = poly.iter().map(|&i| pt(i)).collect();
    let Some(pts) = pts else {
        fan(out);
        return;
    };
    // Newell-Normale.
    let mut nrm = [0.0f64; 3];
    for i in 0..n {
        let (a, b) = (pts[i], pts[(i + 1) % n]);
        nrm[0] += (a[1] - b[1]) * (a[2] + b[2]);
        nrm[1] += (a[2] - b[2]) * (a[0] + b[0]);
        nrm[2] += (a[0] - b[0]) * (a[1] + b[1]);
    }
    if !nrm.iter().all(|v| v.is_finite()) || nrm.iter().all(|v| v.abs() < 1e-300) {
        fan(out);
        return;
    }
    // Eben und konvex ⇒ Fächer reicht (häufigster Fall: Vierecke).
    let drop = if nrm[0].abs() >= nrm[1].abs() && nrm[0].abs() >= nrm[2].abs() {
        0
    } else if nrm[1].abs() >= nrm[2].abs() {
        1
    } else {
        2
    };
    let (ua, va) = match drop {
        0 => (1, 2),
        1 => (2, 0),
        _ => (0, 1),
    };
    let mut flat = Vec::with_capacity(n * 2);
    for p in &pts {
        flat.push(p[ua]);
        flat.push(p[va]);
    }
    let idx = match earcutr::earcut(&flat, &[], 2) {
        Ok(v) if !v.is_empty() => v,
        _ => {
            fan(out);
            return;
        }
    };
    for t in idx.chunks_exact(3) {
        if t.iter().any(|&k| k >= n) {
            continue;
        }
        let (a, b, c) = (pts[t[0]], pts[t[1]], pts[t[2]]);
        let u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        let w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        let cr = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
        let dot = cr[0] * nrm[0] + cr[1] * nrm[1] + cr[2] * nrm[2];
        if dot >= 0.0 {
            out.push([poly[t[0]], poly[t[1]], poly[t[2]]]);
        } else {
            out.push([poly[t[0]], poly[t[2]], poly[t[1]]]);
        }
    }
}

// ── OBJ + MTL ───────────────────────────────────────────────────────────────

/// Zeilen mit Fortsetzung (`\` am Ende) zusammensetzen.
fn logical_lines(text: &str) -> impl Iterator<Item = std::borrow::Cow<'_, str>> {
    let mut it = text.lines();
    std::iter::from_fn(move || {
        let first = it.next()?;
        if !first.trim_end().ends_with('\\') {
            return Some(std::borrow::Cow::Borrowed(first));
        }
        let mut s = first.trim_end().trim_end_matches('\\').to_string();
        for next in it.by_ref() {
            let t = next.trim_end();
            if let Some(stripped) = t.strip_suffix('\\') {
                s.push(' ');
                s.push_str(stripped);
            } else {
                s.push(' ');
                s.push_str(t);
                break;
            }
        }
        Some(std::borrow::Cow::Owned(s))
    })
}

type Materials = HashMap<String, [f32; 4]>;

/// MTL lesen: `newmtl`, `Kd` (Grundfarbe), `d`/`Tr` (Deckkraft).
fn read_mtl(text: &str, into: &mut Materials) {
    let mut cur: Option<String> = None;
    let mut kd: HashMap<String, [f32; 4]> = HashMap::new();
    for line in text.lines() {
        let l = line.trim();
        let mut w = l.split_whitespace();
        match w.next() {
            Some("newmtl") => {
                let n = l["newmtl".len()..].trim().to_string();
                if !n.is_empty() {
                    kd.entry(n.clone()).or_insert([0.8, 0.8, 0.8, 1.0]);
                    cur = Some(n);
                }
            }
            Some("Kd") => {
                let v: Vec<f32> = w.filter_map(|s| s.parse::<f32>().ok()).collect();
                if let (Some(n), true) = (&cur, v.len() >= 3 && v.iter().all(|c| c.is_finite())) {
                    if let Some(c) = kd.get_mut(n) {
                        c[0] = v[0].clamp(0.0, 1.0);
                        c[1] = v[1].clamp(0.0, 1.0);
                        c[2] = v[2].clamp(0.0, 1.0);
                    }
                }
            }
            Some("d") => {
                if let (Some(n), Some(a)) = (&cur, w.next().and_then(|s| s.parse::<f32>().ok())) {
                    if let (Some(c), true) = (kd.get_mut(n), a.is_finite()) {
                        c[3] = a.clamp(0.0, 1.0);
                    }
                }
            }
            Some("Tr") => {
                if let (Some(n), Some(a)) = (&cur, w.next().and_then(|s| s.parse::<f32>().ok())) {
                    if let (Some(c), true) = (kd.get_mut(n), a.is_finite()) {
                        c[3] = (1.0 - a).clamp(0.0, 1.0);
                    }
                }
            }
            _ => {}
        }
    }
    into.extend(kd);
}

fn find_file<'a>(files: &'a [(String, Vec<u8>)], name: &str) -> Option<&'a [u8]> {
    let base = |s: &str| s.rsplit(['/', '\\']).next().unwrap_or(s).to_ascii_lowercase();
    let want = base(name.trim());
    files.iter().find(|(n, _)| base(n) == want).map(|(_, b)| b.as_slice())
}

/// OBJ-Objektschlüssel: (`o`, `g`, Material).
struct ObjSlots {
    index: HashMap<(String, String, String), usize>,
}

fn read_obj(bytes: &[u8], opts: &Options, p: &mut Parsed) -> Result<(), String> {
    let text = String::from_utf8_lossy(bytes);
    let mut materials = Materials::new();
    let (mut o_name, mut g_name, mut mtl) = (String::new(), String::new(), String::new());
    let mut slots = ObjSlots { index: HashMap::new() };
    // Reihenfolge der Objekte je (o, g) für die Namensergänzung bei mehreren Materialien.
    let mut keys: Vec<(String, String, String)> = Vec::new();
    let mut poly: Vec<u32> = Vec::new();
    let mut scratch: Vec<[u32; 3]> = Vec::new();
    let mut seen_header = false;
    let mut face_lines = 0usize;
    for line in logical_lines(&text) {
        let l = line.trim();
        if l.is_empty() {
            continue;
        }
        if let Some(c) = l.strip_prefix('#') {
            if !seen_header {
                let c = c.to_ascii_lowercase();
                if c.contains("dossier") || c.contains("blender") {
                    p.up_hint = Some(Up::Y);
                } else if c.contains("rhinoceros") || c.contains("rhino ") {
                    p.up_hint = Some(Up::Z);
                }
            }
            continue;
        }
        seen_header = true;
        let (cmd, rest) = match l.split_once(char::is_whitespace) {
            Some((c, r)) => (c, r.trim()),
            None => (l, ""),
        };
        match cmd {
            "v" => {
                if p.vertex_count() >= MAX_VERTICES {
                    p.truncated = true;
                    continue;
                }
                let mut it = rest.split_whitespace().map(|s| s.parse::<f64>().unwrap_or(f64::NAN));
                let (x, y, z) = (it.next().unwrap_or(f64::NAN), it.next().unwrap_or(f64::NAN), it.next().unwrap_or(f64::NAN));
                p.pool.extend_from_slice(&[x, y, z]);
            }
            "o" => {
                o_name = rest.to_string();
                g_name.clear();
            }
            "g" => g_name = rest.split_whitespace().next().unwrap_or("").to_string(),
            "usemtl" => mtl = rest.to_string(),
            "mtllib" => {
                for f in rest.split_whitespace() {
                    match find_file(&opts.files, f) {
                        Some(b) => read_mtl(&String::from_utf8_lossy(b), &mut materials),
                        None => p.warn(format!("Materialdatei fehlt: {f} (Farben entfallen; mit der OBJ-Datei zusammen wählen)")),
                    }
                }
            }
            "f" => {
                face_lines += 1;
                poly.clear();
                let n = p.vertex_count() as i64;
                let mut bad = false;
                for tok in rest.split_whitespace() {
                    let first = tok.split('/').next().unwrap_or("");
                    match first.parse::<i64>() {
                        Ok(i) if i > 0 && i <= n => poly.push((i - 1) as u32),
                        Ok(i) if i < 0 && -i <= n => poly.push((n + i) as u32),
                        _ => {
                            bad = true;
                            break;
                        }
                    }
                }
                if bad || poly.len() < 3 {
                    p.bad_faces += 1;
                    continue;
                }
                scratch.clear();
                triangulate(&p.pool, &poly, &mut scratch);
                if scratch.is_empty() || !p.room(scratch.len()) {
                    continue;
                }
                let key = (o_name.clone(), g_name.clone(), mtl.clone());
                let at = match slots.index.get(&key) {
                    Some(&i) => i,
                    None => {
                        let i = p.objects.len();
                        slots.index.insert(key.clone(), i);
                        keys.push(key.clone());
                        p.objects.push(Raw { name: String::new(), group: String::new(), color: materials.get(&mtl).copied(), tris: Vec::new() });
                        i
                    }
                };
                p.objects[at].tris.extend_from_slice(&scratch);
            }
            _ => {}
        }
    }
    if p.vertex_count() == 0 {
        return Err("OBJ ohne Eckpunkte (kein „v“)".into());
    }
    if face_lines == 0 {
        return Err("OBJ ohne Flächen (kein „f“)".into());
    }
    // Namen: g (sonst o) als Objektname, o als Gruppe, Material als Zusatz bei mehreren je (o, g).
    let mut per: HashMap<(String, String), usize> = HashMap::new();
    for k in &keys {
        *per.entry((k.0.clone(), k.1.clone())).or_insert(0) += 1;
    }
    for (i, k) in keys.iter().enumerate() {
        let base = if !k.1.is_empty() { k.1.clone() } else { k.0.clone() };
        let many = per.get(&(k.0.clone(), k.1.clone())).copied().unwrap_or(1) > 1;
        let mut name = base;
        if many && !k.2.is_empty() {
            name = if name.is_empty() { k.2.clone() } else { format!("{name} ({})", k.2) };
        }
        let obj = &mut p.objects[i];
        obj.name = name;
        if !k.0.is_empty() && !k.1.is_empty() && k.0 != k.1 {
            obj.group = k.0.clone();
        }
        // Material ist erst nach `mtllib` bekannt, aber `usemtl` darf davor stehen: nachträglich auflösen.
        if obj.color.is_none() {
            obj.color = materials.get(&k.2).copied();
        }
    }
    Ok(())
}

// ── STL ─────────────────────────────────────────────────────────────────────

fn is_binary_stl(bytes: &[u8]) -> bool {
    if bytes.len() < 84 {
        return false;
    }
    let n = u32::from_le_bytes([bytes[80], bytes[81], bytes[82], bytes[83]]) as usize;
    n.checked_mul(50).and_then(|v| v.checked_add(84)) == Some(bytes.len())
}

/// Eckpunkte je Bitmuster zusammenführen (STL kennt keine gemeinsamen Eckpunkte).
struct Welder {
    map: HashMap<[u32; 3], u32>,
}

impl Welder {
    fn vertex(&mut self, p: &mut Parsed, v: [f32; 3]) -> Option<u32> {
        // −0 und +0 gleich behandeln.
        let key = [(v[0] + 0.0).to_bits(), (v[1] + 0.0).to_bits(), (v[2] + 0.0).to_bits()];
        if let Some(&i) = self.map.get(&key) {
            return Some(i);
        }
        if p.vertex_count() >= MAX_VERTICES {
            p.truncated = true;
            return None;
        }
        let i = p.vertex_count() as u32;
        p.pool.extend_from_slice(&[f64::from(v[0]), f64::from(v[1]), f64::from(v[2])]);
        self.map.insert(key, i);
        Some(i)
    }
}

/// Objekt je Farbe (Schlüssel = RGBA-Bytes); höchstens 256 Farben, danach farblos.
struct ColorSlots {
    index: HashMap<u32, usize>,
    plain: Option<usize>,
}

fn color_slot(p: &mut Parsed, slots: &mut ColorSlots, name: &str, rgba: Option<[u8; 4]>) -> usize {
    match rgba {
        Some(c) if slots.index.len() < 256 || slots.index.contains_key(&u32::from_le_bytes(c)) => {
            let key = u32::from_le_bytes(c);
            if let Some(&i) = slots.index.get(&key) {
                return i;
            }
            let i = p.objects.len();
            let col = [f32::from(c[0]) / 255.0, f32::from(c[1]) / 255.0, f32::from(c[2]) / 255.0, f32::from(c[3]) / 255.0];
            p.objects.push(Raw { name: name.to_string(), group: String::new(), color: Some(col), tris: Vec::new() });
            slots.index.insert(key, i);
            i
        }
        _ => {
            if let Some(i) = slots.plain {
                return i;
            }
            let i = p.objects.len();
            p.objects.push(Raw { name: name.to_string(), group: String::new(), color: None, tris: Vec::new() });
            slots.plain = Some(i);
            i
        }
    }
}

fn read_stl(bytes: &[u8], p: &mut Parsed) -> Result<(), String> {
    if is_binary_stl(bytes) {
        return read_stl_binary(bytes, p);
    }
    let head = &bytes[..bytes.len().min(512)];
    let looks_ascii = head.starts_with(b"solid") || String::from_utf8_lossy(head).contains("facet");
    if looks_ascii {
        return read_stl_ascii(bytes, p);
    }
    // Binär mit falschem Zähler (manche Schreiber): so viele Facetten, wie in die Datei passen.
    if bytes.len() >= 84 + 50 {
        p.warn("STL-Facettenzahl im Kopf passt nicht zur Dateigrösse; nach Dateigrösse gelesen".into());
        return read_stl_binary(bytes, p);
    }
    Err("STL nicht lesbar (weder ASCII noch binär)".into())
}

fn read_stl_binary(bytes: &[u8], p: &mut Parsed) -> Result<(), String> {
    let header = &bytes[..80];
    let htext = String::from_utf8_lossy(header);
    let declared = u32::from_le_bytes([bytes[80], bytes[81], bytes[82], bytes[83]]) as usize;
    let fit = (bytes.len() - 84) / 50;
    let n = declared.min(fit);
    // Farbvarianten: Magics („COLOR=r g b a“ im Kopf, Bit 15 = 0 → Facettenfarbe, R in Bits 0–4) und
    // VisCAM/SolidView (Bit 15 = 1 → Facettenfarbe, B in Bits 0–4). Beide 5 Bit je Kanal.
    let magics = htext.contains("COLOR=");
    let mut default_color: Option<[u8; 4]> = None;
    if let Some(at) = header.windows(6).position(|w| w == b"COLOR=") {
        if let Some(c) = header.get(at + 6..at + 10) {
            default_color = Some([c[0], c[1], c[2], c[3]]);
        }
    }
    let mut slots = ColorSlots { index: HashMap::new(), plain: None };
    let mut weld = Welder { map: HashMap::new() };
    let f32at = |o: usize| f32::from_le_bytes([bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]]);
    for k in 0..n {
        let base = 84 + k * 50;
        let attr = u16::from_le_bytes([bytes[base + 48], bytes[base + 49]]);
        let to8 = |v: u16| ((u32::from(v & 31) * 255 + 15) / 31) as u8;
        let rgba = if magics {
            if attr & 0x8000 == 0 && attr != 0 {
                Some([to8(attr), to8(attr >> 5), to8(attr >> 10), 255])
            } else {
                default_color
            }
        } else if attr & 0x8000 != 0 {
            Some([to8(attr >> 10), to8(attr >> 5), to8(attr), 255])
        } else {
            None
        };
        if !p.room(1) {
            break;
        }
        let mut ids = [0u32; 3];
        let mut ok = true;
        for (c, id) in ids.iter_mut().enumerate() {
            let o = base + 12 + c * 12;
            match weld.vertex(p, [f32at(o), f32at(o + 4), f32at(o + 8)]) {
                Some(i) => *id = i,
                None => ok = false,
            }
        }
        if !ok {
            break;
        }
        let at = color_slot(p, &mut slots, "", rgba);
        p.objects[at].tris.push(ids);
    }
    if n == 0 {
        return Err("STL ohne Facetten".into());
    }
    Ok(())
}

fn read_stl_ascii(bytes: &[u8], p: &mut Parsed) -> Result<(), String> {
    let text = String::from_utf8_lossy(bytes);
    let mut weld = Welder { map: HashMap::new() };
    let mut cur: Option<usize> = None;
    let mut name = String::new();
    let mut tri: Vec<u32> = Vec::with_capacity(3);
    let mut facets = 0usize;
    let mut stopped = false;
    for line in text.lines() {
        let l = line.trim();
        let low_start = l.get(..l.len().min(8)).unwrap_or("").to_ascii_lowercase();
        if low_start.starts_with("solid") && !low_start.starts_with("endsolid") {
            name = l[5.min(l.len())..].trim().to_string();
            cur = None;
        } else if low_start.starts_with("vertex") {
            if stopped {
                continue;
            }
            let v: Vec<f32> = l[6..].split_whitespace().map(|s| s.parse::<f32>().unwrap_or(f32::NAN)).collect();
            if v.len() < 3 {
                tri.push(u32::MAX);
                continue;
            }
            match weld.vertex(p, [v[0], v[1], v[2]]) {
                Some(i) => tri.push(i),
                None => stopped = true,
            }
        } else if low_start.starts_with("endfacet") {
            if tri.len() == 3 && !tri.contains(&u32::MAX) && !stopped {
                if !p.room(1) {
                    stopped = true;
                    continue;
                }
                let at = match cur {
                    Some(i) => i,
                    None => {
                        let i = p.objects.len();
                        p.objects.push(Raw { name: name.clone(), group: String::new(), color: None, tris: Vec::new() });
                        cur = Some(i);
                        i
                    }
                };
                p.objects[at].tris.push([tri[0], tri[1], tri[2]]);
                facets += 1;
            } else {
                p.bad_faces += 1;
            }
            tri.clear();
        }
    }
    if facets == 0 {
        return Err("STL ohne Facetten".into());
    }
    Ok(())
}

// ── PLY (Flächen) ───────────────────────────────────────────────────────────

#[derive(Clone, Copy, PartialEq, Debug)]
enum Ty {
    I8,
    U8,
    I16,
    U16,
    I32,
    U32,
    F32,
    F64,
}

impl Ty {
    fn parse(s: &str) -> Option<Ty> {
        Some(match s {
            "char" | "int8" => Ty::I8,
            "uchar" | "uint8" => Ty::U8,
            "short" | "int16" => Ty::I16,
            "ushort" | "uint16" => Ty::U16,
            "int" | "int32" => Ty::I32,
            "uint" | "uint32" => Ty::U32,
            "float" | "float32" => Ty::F32,
            "double" | "float64" => Ty::F64,
            _ => return None,
        })
    }
    fn size(self) -> usize {
        match self {
            Ty::I8 | Ty::U8 => 1,
            Ty::I16 | Ty::U16 => 2,
            Ty::I32 | Ty::U32 | Ty::F32 => 4,
            Ty::F64 => 8,
        }
    }
    fn is_float(self) -> bool {
        matches!(self, Ty::F32 | Ty::F64)
    }
    /// Wert lesen; `None`, wenn der Puffer zu kurz ist.
    fn read(self, b: &[u8], at: usize, big: bool) -> Option<f64> {
        let s = b.get(at..at.checked_add(self.size())?)?;
        macro_rules! rd {
            ($t:ty, $n:expr) => {{
                let a: [u8; $n] = s.try_into().ok()?;
                (if big { <$t>::from_be_bytes(a) } else { <$t>::from_le_bytes(a) }) as f64
            }};
        }
        Some(match self {
            Ty::I8 => s[0] as i8 as f64,
            Ty::U8 => s[0] as f64,
            Ty::I16 => rd!(i16, 2),
            Ty::U16 => rd!(u16, 2),
            Ty::I32 => rd!(i32, 4),
            Ty::U32 => rd!(u32, 4),
            Ty::F32 => rd!(f32, 4),
            Ty::F64 => rd!(f64, 8),
        })
    }
}

#[derive(Clone)]
struct PlyProp {
    name: String,
    ty: Ty,
    /// Listen: (Zähler-Typ); `ty` ist dann der Elementtyp.
    list: Option<Ty>,
}

struct PlyElement {
    name: String,
    count: usize,
    props: Vec<PlyProp>,
}

fn find_sub(h: &[u8], n: &[u8]) -> Option<usize> {
    h.windows(n.len()).position(|w| w == n)
}

fn read_ply_mesh(bytes: &[u8], p: &mut Parsed) -> Result<(), String> {
    let end = find_sub(bytes, b"end_header").ok_or("PLY ohne end_header")?;
    let mut body = end + b"end_header".len();
    if bytes.get(body) == Some(&b'\r') {
        body += 1;
    }
    if bytes.get(body) == Some(&b'\n') {
        body += 1;
    }
    let header = String::from_utf8_lossy(&bytes[..end]);
    let mut format = String::new();
    let mut elements: Vec<PlyElement> = Vec::new();
    for line in header.lines().skip(1) {
        let w: Vec<&str> = line.split_whitespace().collect();
        match w.as_slice() {
            ["format", f, ..] => format = f.to_string(),
            ["comment", rest @ ..] => {
                let c = rest.join(" ").to_ascii_lowercase();
                if c.contains("dossier") || c.contains("blender") {
                    p.up_hint = Some(Up::Y);
                }
            }
            ["element", name, n] => {
                let count: usize = n.parse().map_err(|_| "PLY: Elementzahl ungültig")?;
                elements.push(PlyElement { name: name.to_string(), count, props: Vec::new() });
            }
            ["property", "list", ct, it, name] => {
                let (Some(ct), Some(it)) = (Ty::parse(ct), Ty::parse(it)) else {
                    return Err("PLY: Datentyp der Liste unbekannt".into());
                };
                elements.last_mut().ok_or("PLY: property vor element")?.props.push(PlyProp { name: name.to_string(), ty: it, list: Some(ct) });
            }
            ["property", ty, name] => {
                let ty = Ty::parse(ty).ok_or_else(|| format!("PLY: Datentyp {ty} unbekannt"))?;
                elements.last_mut().ok_or("PLY: property vor element")?.props.push(PlyProp { name: name.to_string(), ty, list: None });
            }
            _ => {}
        }
    }
    let big = match format.as_str() {
        "ascii" => false,
        "binary_little_endian" => false,
        "binary_big_endian" => true,
        _ => return Err("PLY: Format (ascii/binary_little_endian/binary_big_endian) nicht erkannt".into()),
    };
    let ascii = format == "ascii";
    let vi = elements.iter().position(|e| e.name == "vertex").ok_or("PLY ohne Element vertex")?;
    let face_idx = elements.iter().position(|e| e.name == "face");
    let nfaces = face_idx.map(|i| elements[i].count).unwrap_or(0);
    if nfaces == 0 {
        return Err(format!("{NO_FACES} PLY enthält keine Flächen (Punktwolke): bitte über den Punktwolken-Import öffnen"));
    }
    if elements[vi].count > MAX_VERTICES {
        return Err("PLY: zu viele Eckpunkte".into());
    }
    let vprops = elements[vi].props.clone();
    let pos_of = |n: &str| vprops.iter().position(|q| q.name == n && q.list.is_none());
    let (Some(ix), Some(iy), Some(iz)) = (pos_of("x"), pos_of("y"), pos_of("z")) else {
        return Err("PLY: x/y/z fehlen".into());
    };
    let vcol = [pos_of("red"), pos_of("green"), pos_of("blue")];
    let has_vcol = vcol.iter().all(Option::is_some);

    let data = &bytes[body.min(bytes.len())..];
    let text;
    let mut lines: std::str::Lines = "".lines();
    let mut cursor = 0usize;
    if ascii {
        text = String::from_utf8_lossy(data);
        lines = text.lines();
    }
    // Wert-Quelle: ASCII-Zeile bzw. Binärzeiger.
    let scale_col = |ty: Ty, v: f64| -> f32 {
        if ty.is_float() {
            v.clamp(0.0, 1.0) as f32
        } else if ty == Ty::U16 {
            (v / 65535.0).clamp(0.0, 1.0) as f32
        } else {
            (v / 255.0).clamp(0.0, 1.0) as f32
        }
    };
    let (mut vsum, mut vn) = ([0.0f64; 3], 0usize);
    let mut slots = ColorSlots { index: HashMap::new(), plain: None };
    let mut poly: Vec<u32> = Vec::new();
    let mut scratch: Vec<[u32; 3]> = Vec::new();
    for (ei, el) in elements.iter().enumerate() {
        let is_v = ei == vi;
        let is_f = Some(ei) == face_idx;
        for _ in 0..el.count {
            let mut vals: Vec<f64> = Vec::new();
            let mut list: Vec<f64> = Vec::new();
            let mut ascii_line: Vec<&str> = Vec::new();
            if ascii {
                let Some(l) = lines.next() else { break };
                ascii_line = l.split_whitespace().collect();
            }
            let mut ai = 0usize;
            let mut short = false;
            for pr in &el.props {
                let get = |ty: Ty, cursor: &mut usize, ai: &mut usize| -> Option<f64> {
                    if ascii {
                        let v = ascii_line.get(*ai)?.parse::<f64>().ok();
                        *ai += 1;
                        v
                    } else {
                        let v = ty.read(data, *cursor, big)?;
                        *cursor += ty.size();
                        Some(v)
                    }
                };
                if let Some(ct) = pr.list {
                    let Some(n) = get(ct, &mut cursor, &mut ai) else {
                        short = true;
                        break;
                    };
                    if !(0.0..=1_000_000.0).contains(&n) {
                        return Err("PLY: Listenlänge ungültig".into());
                    }
                    let mut l: Vec<f64> = Vec::with_capacity(n as usize);
                    for _ in 0..n as usize {
                        match get(pr.ty, &mut cursor, &mut ai) {
                            Some(v) => l.push(v),
                            None => {
                                short = true;
                                break;
                            }
                        }
                    }
                    if short {
                        break;
                    }
                    if is_f && (pr.name == "vertex_indices" || pr.name == "vertex_index") {
                        list = l;
                    }
                    vals.push(f64::NAN);
                } else {
                    match get(pr.ty, &mut cursor, &mut ai) {
                        Some(v) => vals.push(v),
                        None => {
                            short = true;
                            break;
                        }
                    }
                }
            }
            if short {
                if is_v || is_f {
                    p.warn("PLY: Datei endet vor der angegebenen Elementzahl".into());
                }
                break;
            }
            if is_v {
                p.pool.extend_from_slice(&[vals[ix], vals[iy], vals[iz]]);
                if has_vcol {
                    for k in 0..3 {
                        let i = vcol[k].unwrap_or(0);
                        vsum[k] += f64::from(scale_col(vprops[i].ty, vals[i]));
                    }
                    vn += 1;
                }
            } else if is_f {
                let nv = p.vertex_count() as f64;
                poly.clear();
                let mut bad = false;
                for &i in &list {
                    if i >= 0.0 && i < nv && i.fract() == 0.0 {
                        poly.push(i as u32);
                    } else {
                        bad = true;
                    }
                }
                if bad || poly.len() < 3 {
                    p.bad_faces += 1;
                    continue;
                }
                // Flächenfarbe, falls als red/green/blue am Element face.
                let fp = |n: &str| el.props.iter().position(|q| q.name == n && q.list.is_none());
                let fc = match (fp("red"), fp("green"), fp("blue")) {
                    (Some(r), Some(g), Some(b)) => {
                        let c = |i: usize| (scale_col(el.props[i].ty, vals[i]) * 255.0).round() as u8;
                        let a = fp("alpha").map(|i| (scale_col(el.props[i].ty, vals[i]) * 255.0).round() as u8).unwrap_or(255);
                        Some([c(r), c(g), c(b), a])
                    }
                    _ => None,
                };
                scratch.clear();
                triangulate(&p.pool, &poly, &mut scratch);
                if scratch.is_empty() || !p.room(scratch.len()) {
                    continue;
                }
                let at = color_slot(p, &mut slots, "", fc);
                p.objects[at].tris.extend_from_slice(&scratch);
            }
        }
    }
    // Eckpunktfarbe: Mittel über alle Eckpunkte als Objektfarbe (Scans haben Millionen Farben).
    if has_vcol && vn > 0 && slots.index.is_empty() {
        let c = [(vsum[0] / vn as f64) as f32, (vsum[1] / vn as f64) as f32, (vsum[2] / vn as f64) as f32, 1.0];
        for o in &mut p.objects {
            o.color = Some(c);
        }
    }
    if p.objects.is_empty() {
        return Err("PLY: keine gültigen Flächen".into());
    }
    Ok(())
}

// ── flache Kodierung ────────────────────────────────────────────────────────

/// Ergebnis → (Zahlenpuffer, Zeichenketten), Aufbau s. Dateikopf.
pub fn encode(m: &MeshImport) -> (Vec<f64>, Vec<String>) {
    let mut strings: Vec<String> = Vec::new();
    let intern = |s: &str, strings: &mut Vec<String>| -> f64 {
        strings.push(s.to_string());
        (strings.len() - 1) as f64
    };
    let mut flat: Vec<f64> = vec![
        FLAT_VERSION,
        m.format.code(),
        if m.up_used == Up::Y { 1.0 } else { 0.0 },
        if m.up_auto { 1.0 } else { 0.0 },
        if m.up_certain { 1.0 } else { 0.0 },
        m.unit_scale,
        m.triangles as f64,
        m.degenerate as f64,
        m.bad_faces as f64,
        if m.truncated { 1.0 } else { 0.0 },
        m.warnings.len() as f64,
        m.objects.len() as f64,
    ];
    for w in &m.warnings {
        let i = intern(w, &mut strings);
        flat.push(i);
    }
    for o in &m.objects {
        let n = intern(&o.name, &mut strings);
        let g = if o.group.is_empty() { -1.0 } else { intern(&o.group, &mut strings) };
        flat.push(n);
        flat.push(g);
        match o.color {
            Some(c) => flat.extend_from_slice(&[1.0, f64::from(c[0]), f64::from(c[1]), f64::from(c[2]), f64::from(c[3])]),
            None => flat.extend_from_slice(&[0.0, 0.0, 0.0, 0.0, 0.0]),
        }
        flat.push(o.positions.len() as f64);
        flat.push(o.indices.len() as f64);
        flat.extend_from_slice(&o.positions);
        flat.extend(o.indices.iter().map(|&i| f64::from(i)));
    }
    (flat, strings)
}

// ── WASM-Fassade ────────────────────────────────────────────────────────────

#[cfg(feature = "web")]
mod web {
    use super::*;
    use wasm_bindgen::prelude::*;

    /// Ergebnis; die Getter geben die Daten je einmal heraus (danach leer).
    #[wasm_bindgen]
    pub struct MeshImportResult {
        flat: Vec<f64>,
        strings: Vec<String>,
    }

    #[wasm_bindgen]
    impl MeshImportResult {
        /// Zahlenpuffer, Aufbau s. `mesh_import.rs`.
        pub fn flat(&mut self) -> Vec<f64> {
            std::mem::take(&mut self.flat)
        }
        /// Zeichenketten (Hinweise, Namen, Gruppen), per Index aus `flat`.
        pub fn strings(&mut self) -> Vec<String> {
            std::mem::take(&mut self.strings)
        }
    }

    /// Mesh-Datei lesen (OBJ/STL/glTF/GLB/PLY, erkannt am Inhalt).
    /// `up`: 0 = erkennen, 1 = Z oben, 2 = Y oben. `unit_scale` = Meter je Dateieinheit (glTF ignoriert es).
    /// `max_triangles` 0 = Voreinstellung. Nachbardateien (.bin, .mtl): Namen, Längen und alle Bytes hintereinander.
    #[wasm_bindgen]
    pub fn import_mesh(
        bytes: &[u8],
        name: &str,
        unit_scale: f64,
        up: u32,
        max_triangles: f64,
        ext_names: Vec<String>,
        ext_sizes: Vec<f64>,
        ext_blob: &[u8],
    ) -> Result<MeshImportResult, JsValue> {
        let mut files = Vec::new();
        let mut at = 0usize;
        for (n, s) in ext_names.iter().zip(ext_sizes.iter()) {
            let len = if s.is_finite() && *s >= 0.0 { *s as usize } else { 0 };
            let Some(end) = at.checked_add(len) else { break };
            let Some(b) = ext_blob.get(at..end) else { break };
            files.push((n.clone(), b.to_vec()));
            at = end;
        }
        let opts = Options {
            unit_scale,
            up: match up {
                1 => Up::Z,
                2 => Up::Y,
                _ => Up::Auto,
            },
            max_triangles: if max_triangles.is_finite() && max_triangles >= 1.0 { max_triangles.min(4.0e9) as usize } else { DEFAULT_MAX_TRIANGLES },
            files,
        };
        let m = super::import_mesh(bytes, name, &opts).map_err(|e| JsValue::from_str(&e))?;
        let (flat, strings) = encode(&m);
        Ok(MeshImportResult { flat, strings })
    }
}

#[cfg(test)]
#[path = "mesh_import_tests.rs"]
mod tests;
