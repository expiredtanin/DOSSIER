// glTF 2.0 / GLB lesen ([C11]-Gegenstück zu `mesh_export.rs`): kleiner JSON-Leser (eigener Code, `serde_json`
// gibt es nur im Web-Feature), Puffer (GLB-BIN-Chunk, Base64-Data-URI, mitgegebene .bin-Dateien),
// Accessors (u8/i8/u16/i16/u32/f32, normalisiert, byteStride), Primitives TRIANGLES/STRIP/FAN, Knoten-
// Hierarchie mit Matrix oder TRS. Farbe = `baseColorFactor` (linear → sRGB). Nicht unterstützt (Fehler bzw.
// Hinweis): Draco/Meshopt-Kompression, Sparse-Accessors (ignoriert, Hinweis), Texturen, Skinning/Morphing.
//
// Koordinaten bleiben Datei-Koordinaten (Y-up, Knoten-Transformationen angewendet); die Umrechnung nach
// Modell (Z oben) macht `mesh_import::finish`.

use crate::mesh_import::{Options, Parsed, Raw, Up, MAX_VERTICES};

// ── JSON ────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub(crate) enum Json {
    Null,
    Bool(#[allow(dead_code)] bool),
    Num(f64),
    Str(String),
    Arr(Vec<Json>),
    Obj(Vec<(String, Json)>),
}

impl Json {
    pub fn get(&self, k: &str) -> Option<&Json> {
        match self {
            Json::Obj(v) => v.iter().find(|(n, _)| n == k).map(|(_, v)| v),
            _ => None,
        }
    }
    pub fn arr(&self) -> &[Json] {
        match self {
            Json::Arr(v) => v,
            _ => &[],
        }
    }
    pub fn num(&self) -> Option<f64> {
        match self {
            Json::Num(n) if n.is_finite() => Some(*n),
            _ => None,
        }
    }
    pub fn str(&self) -> Option<&str> {
        match self {
            Json::Str(s) => Some(s),
            _ => None,
        }
    }
    /// Nicht negative ganze Zahl (für Indizes und Grössen).
    pub fn idx(&self) -> Option<usize> {
        let n = self.num()?;
        if n >= 0.0 && n.fract() == 0.0 && n < 9.0e15 {
            Some(n as usize)
        } else {
            None
        }
    }
    fn nums(&self, n: usize) -> Option<Vec<f64>> {
        let a = self.arr();
        if a.len() != n {
            return None;
        }
        a.iter().map(Json::num).collect()
    }
}

struct JsonParser<'a> {
    b: &'a [u8],
    at: usize,
}

const MAX_DEPTH: usize = 96;

impl JsonParser<'_> {
    fn ws(&mut self) {
        while self.at < self.b.len() && matches!(self.b[self.at], b' ' | b'\t' | b'\n' | b'\r') {
            self.at += 1;
        }
    }
    fn lit(&mut self, s: &str, v: Json) -> Result<Json, String> {
        if self.b[self.at..].starts_with(s.as_bytes()) {
            self.at += s.len();
            Ok(v)
        } else {
            Err("JSON ungültig".into())
        }
    }
    fn value(&mut self, depth: usize) -> Result<Json, String> {
        if depth > MAX_DEPTH {
            return Err("JSON zu tief verschachtelt".into());
        }
        self.ws();
        match self.b.get(self.at).copied() {
            None => Err("JSON endet unerwartet".into()),
            Some(b'{') => {
                self.at += 1;
                let mut v = Vec::new();
                self.ws();
                if self.b.get(self.at) == Some(&b'}') {
                    self.at += 1;
                    return Ok(Json::Obj(v));
                }
                loop {
                    self.ws();
                    let k = match self.value(depth + 1)? {
                        Json::Str(s) => s,
                        _ => return Err("JSON: Schlüssel ist keine Zeichenkette".into()),
                    };
                    self.ws();
                    if self.b.get(self.at) != Some(&b':') {
                        return Err("JSON: „:“ erwartet".into());
                    }
                    self.at += 1;
                    let val = self.value(depth + 1)?;
                    v.push((k, val));
                    self.ws();
                    match self.b.get(self.at) {
                        Some(b',') => self.at += 1,
                        Some(b'}') => {
                            self.at += 1;
                            return Ok(Json::Obj(v));
                        }
                        _ => return Err("JSON: „,“ oder „}“ erwartet".into()),
                    }
                }
            }
            Some(b'[') => {
                self.at += 1;
                let mut v = Vec::new();
                self.ws();
                if self.b.get(self.at) == Some(&b']') {
                    self.at += 1;
                    return Ok(Json::Arr(v));
                }
                loop {
                    v.push(self.value(depth + 1)?);
                    self.ws();
                    match self.b.get(self.at) {
                        Some(b',') => self.at += 1,
                        Some(b']') => {
                            self.at += 1;
                            return Ok(Json::Arr(v));
                        }
                        _ => return Err("JSON: „,“ oder „]“ erwartet".into()),
                    }
                }
            }
            Some(b'"') => {
                self.at += 1;
                let mut out: Vec<u8> = Vec::new();
                loop {
                    let c = *self.b.get(self.at).ok_or("JSON: Zeichenkette nicht beendet")?;
                    self.at += 1;
                    match c {
                        b'"' => break,
                        b'\\' => {
                            let e = *self.b.get(self.at).ok_or("JSON: Escape unvollständig")?;
                            self.at += 1;
                            match e {
                                b'n' => out.push(b'\n'),
                                b't' => out.push(b'\t'),
                                b'r' => out.push(b'\r'),
                                b'b' => out.push(8),
                                b'f' => out.push(12),
                                b'/' | b'\\' | b'"' => out.push(e),
                                b'u' => {
                                    let mut cp = self.hex4()?;
                                    if (0xD800..0xDC00).contains(&cp) && self.b[self.at..].starts_with(b"\\u") {
                                        self.at += 2;
                                        let lo = self.hex4()?;
                                        if (0xDC00..0xE000).contains(&lo) {
                                            cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
                                        }
                                    }
                                    let ch = char::from_u32(cp).unwrap_or('\u{FFFD}');
                                    let mut buf = [0u8; 4];
                                    out.extend_from_slice(ch.encode_utf8(&mut buf).as_bytes());
                                }
                                _ => return Err("JSON: unbekannter Escape".into()),
                            }
                        }
                        _ => out.push(c),
                    }
                }
                Ok(Json::Str(String::from_utf8_lossy(&out).into_owned()))
            }
            Some(b't') => self.lit("true", Json::Bool(true)),
            Some(b'f') => self.lit("false", Json::Bool(false)),
            Some(b'n') => self.lit("null", Json::Null),
            Some(_) => {
                let start = self.at;
                while self.at < self.b.len() && matches!(self.b[self.at], b'-' | b'+' | b'.' | b'e' | b'E' | b'0'..=b'9') {
                    self.at += 1;
                }
                let s = std::str::from_utf8(&self.b[start..self.at]).map_err(|_| "JSON ungültig")?;
                s.parse::<f64>().map(Json::Num).map_err(|_| "JSON: Zahl ungültig".to_string())
            }
        }
    }
    fn hex4(&mut self) -> Result<u32, String> {
        let s = self.b.get(self.at..self.at + 4).ok_or("JSON: \\u unvollständig")?;
        self.at += 4;
        u32::from_str_radix(std::str::from_utf8(s).map_err(|_| "JSON: \\u ungültig")?, 16).map_err(|_| "JSON: \\u ungültig".to_string())
    }
}

pub(crate) fn parse_json(b: &[u8]) -> Result<Json, String> {
    let b = b.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(b);
    let mut p = JsonParser { b, at: 0 };
    let v = p.value(0)?;
    p.ws();
    if p.at != b.len() {
        return Err("JSON: Text nach dem Wert".into());
    }
    Ok(v)
}

// ── Base64 / URI ────────────────────────────────────────────────────────────

fn base64_decode(s: &str) -> Result<Vec<u8>, String> {
    let mut out = Vec::with_capacity(s.len() / 4 * 3);
    let (mut acc, mut bits) = (0u32, 0u32);
    for c in s.bytes() {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            b'=' | b'\n' | b'\r' | b' ' => continue,
            _ => return Err("Base64 ungültig".into()),
        };
        acc = (acc << 6) | u32::from(v);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    Ok(out)
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

// ── Dokument ────────────────────────────────────────────────────────────────

struct Doc {
    json: Json,
    buffers: Vec<Vec<u8>>,
}

/// Zugriff auf einen Accessor als f64-Liste (je Element `comps` Werte); `None` + Meldung bei Unsinn.
fn read_accessor(doc: &Doc, idx: usize, comps: usize, budget: usize) -> Result<Vec<f64>, String> {
    let acc = doc.json.get("accessors").map(Json::arr).and_then(|a| a.get(idx)).ok_or("glTF: Accessor fehlt")?;
    let count = acc.get("count").and_then(Json::idx).ok_or("glTF: Accessor ohne count")?;
    let ty = acc.get("type").and_then(Json::str).unwrap_or("");
    let n = match ty {
        "SCALAR" => 1,
        "VEC2" => 2,
        "VEC3" => 3,
        "VEC4" => 4,
        _ => return Err("glTF: Accessor-Typ nicht unterstützt".into()),
    };
    if n < comps {
        return Err("glTF: Accessor hat zu wenige Komponenten".into());
    }
    let total = count.checked_mul(n).filter(|t| *t <= budget).ok_or("glTF: Accessor zu gross")?;
    let ct = acc.get("componentType").and_then(Json::idx).unwrap_or(0);
    let (size, normalized_max): (usize, f64) = match ct {
        5120 => (1, 127.0),
        5121 => (1, 255.0),
        5122 => (2, 32767.0),
        5123 => (2, 65535.0),
        5125 => (4, 4294967295.0),
        5126 => (4, 0.0),
        _ => return Err("glTF: componentType nicht unterstützt".into()),
    };
    let normalized = matches!(acc.get("normalized"), Some(Json::Bool(true)));
    let Some(view_i) = acc.get("bufferView").and_then(Json::idx) else {
        // Ohne bufferView: Nullen (Sparse-Basis).
        return Ok(vec![0.0; count * n]);
    };
    if acc.get("sparse").is_some() {
        // Wird als Nullbasis + Hinweis nicht ausgewertet; Daten bleiben die Basis.
    }
    let view = doc.json.get("bufferViews").map(Json::arr).and_then(|a| a.get(view_i)).ok_or("glTF: bufferView fehlt")?;
    let buf_i = view.get("buffer").and_then(Json::idx).ok_or("glTF: bufferView ohne buffer")?;
    let buf = doc.buffers.get(buf_i).ok_or("glTF: buffer fehlt")?;
    let vo = view.get("byteOffset").and_then(Json::idx).unwrap_or(0);
    let vlen = view.get("byteLength").and_then(Json::idx).ok_or("glTF: bufferView ohne byteLength")?;
    let ao = acc.get("byteOffset").and_then(Json::idx).unwrap_or(0);
    let stride = view.get("byteStride").and_then(Json::idx).filter(|s| *s > 0).unwrap_or(size * n);
    let view_end = vo.checked_add(vlen).filter(|e| *e <= buf.len()).ok_or("glTF: bufferView ausserhalb des Puffers")?;
    let mut out = Vec::with_capacity(total);
    for k in 0..count {
        let base = k
            .checked_mul(stride)
            .and_then(|o| o.checked_add(ao))
            .and_then(|o| o.checked_add(vo))
            .ok_or("glTF: Offset-Überlauf")?;
        for c in 0..n {
            let at = base + c * size;
            let end = at.checked_add(size).filter(|e| *e <= view_end).ok_or("glTF: Accessor ausserhalb des bufferViews")?;
            let s = &buf[at..end];
            let v = match ct {
                5120 => f64::from(s[0] as i8),
                5121 => f64::from(s[0]),
                5122 => f64::from(i16::from_le_bytes([s[0], s[1]])),
                5123 => f64::from(u16::from_le_bytes([s[0], s[1]])),
                5125 => f64::from(u32::from_le_bytes([s[0], s[1], s[2], s[3]])),
                _ => f64::from(f32::from_le_bytes([s[0], s[1], s[2], s[3]])),
            };
            out.push(if normalized && normalized_max > 0.0 { (v / normalized_max).max(-1.0) } else { v });
        }
    }
    Ok(out)
}

// ── Matrizen (spaltenweise wie glTF) ────────────────────────────────────────

type Mat = [f64; 16];
const IDENT: Mat = [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0];

fn mul(a: &Mat, b: &Mat) -> Mat {
    let mut r = [0.0; 16];
    for c in 0..4 {
        for row in 0..4 {
            let mut s = 0.0;
            for k in 0..4 {
                s += a[k * 4 + row] * b[c * 4 + k];
            }
            r[c * 4 + row] = s;
        }
    }
    r
}

fn node_matrix(node: &Json) -> Mat {
    if let Some(m) = node.get("matrix").and_then(|m| m.nums(16)) {
        let mut a = IDENT;
        a.copy_from_slice(&m);
        return a;
    }
    let t = node.get("translation").and_then(|v| v.nums(3)).unwrap_or(vec![0.0, 0.0, 0.0]);
    let r = node.get("rotation").and_then(|v| v.nums(4)).unwrap_or(vec![0.0, 0.0, 0.0, 1.0]);
    let s = node.get("scale").and_then(|v| v.nums(3)).unwrap_or(vec![1.0, 1.0, 1.0]);
    let (mut x, mut y, mut z, mut w) = (r[0], r[1], r[2], r[3]);
    let len = (x * x + y * y + z * z + w * w).sqrt();
    if len > 0.0 {
        x /= len;
        y /= len;
        z /= len;
        w /= len;
    } else {
        w = 1.0;
    }
    // Drehmatrix aus dem Quaternion, Spalten skaliert, Verschiebung in Spalte 3.
    let (xx, yy, zz, xy, xz, yz, wx, wy, wz) = (x * x, y * y, z * z, x * y, x * z, y * z, w * x, w * y, w * z);
    [
        (1.0 - 2.0 * (yy + zz)) * s[0],
        2.0 * (xy + wz) * s[0],
        2.0 * (xz - wy) * s[0],
        0.0,
        2.0 * (xy - wz) * s[1],
        (1.0 - 2.0 * (xx + zz)) * s[1],
        2.0 * (yz + wx) * s[1],
        0.0,
        2.0 * (xz + wy) * s[2],
        2.0 * (yz - wx) * s[2],
        (1.0 - 2.0 * (xx + yy)) * s[2],
        0.0,
        t[0],
        t[1],
        t[2],
        1.0,
    ]
}

fn det3(m: &Mat) -> f64 {
    m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2])
}

// ── Farbe ───────────────────────────────────────────────────────────────────

fn linear_to_srgb(c: f64) -> f32 {
    let c = c.clamp(0.0, 1.0);
    (if c <= 0.003_130_8 { c * 12.92 } else { 1.055 * c.powf(1.0 / 2.4) - 0.055 }) as f32
}

fn material_color(doc: &Doc, mat: Option<usize>) -> Option<[f32; 4]> {
    let m = doc.json.get("materials")?.arr().get(mat?)?;
    let f = m.get("pbrMetallicRoughness")?.get("baseColorFactor")?.nums(4)?;
    Some([linear_to_srgb(f[0]), linear_to_srgb(f[1]), linear_to_srgb(f[2]), f[3].clamp(0.0, 1.0) as f32])
}

// ── Lesen ───────────────────────────────────────────────────────────────────

pub(crate) fn read_gltf(bytes: &[u8], opts: &Options, p: &mut Parsed) -> Result<(), String> {
    p.up_fixed = Some(Up::Y);
    let (json_bytes, glb_bin): (&[u8], Option<&[u8]>) = if bytes.starts_with(b"glTF") {
        if bytes.len() < 20 {
            return Err("GLB abgeschnitten".into());
        }
        let version = u32::from_le_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]);
        if version != 2 {
            return Err(format!("GLB-Version {version} nicht unterstützt (nur 2)"));
        }
        let mut at = 12usize;
        let (mut json, mut bin) = (None, None);
        while at + 8 <= bytes.len() {
            let len = u32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]]) as usize;
            let ty = u32::from_le_bytes([bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]]);
            let end = (at + 8).checked_add(len).filter(|e| *e <= bytes.len()).ok_or("GLB: Chunk ragt über das Dateiende")?;
            let chunk = &bytes[at + 8..end];
            match ty {
                0x4E4F_534A if json.is_none() => json = Some(chunk),
                0x004E_4942 if bin.is_none() => bin = Some(chunk),
                _ => {}
            }
            at = (end + 3) & !3;
        }
        (json.ok_or("GLB ohne JSON-Chunk")?, bin)
    } else {
        (bytes, None)
    };
    let json = parse_json(json_bytes)?;
    if !matches!(json, Json::Obj(_)) {
        return Err("glTF: JSON-Wurzel ist kein Objekt".into());
    }
    let version = json.get("asset").and_then(|a| a.get("version")).and_then(Json::str).unwrap_or("");
    if !version.starts_with('2') {
        return Err(format!("glTF-Version „{version}“ nicht unterstützt (nur 2.0)"));
    }
    for ext in json.get("extensionsRequired").map(Json::arr).unwrap_or(&[]) {
        if let Some(e) = ext.str() {
            if matches!(e, "KHR_draco_mesh_compression" | "EXT_meshopt_compression") {
                return Err(format!("glTF-Erweiterung {e} (Kompression) nicht unterstützt: bitte unkomprimiert exportieren"));
            }
        }
    }

    // Puffer.
    let mut buffers: Vec<Vec<u8>> = Vec::new();
    let mut missing: Vec<String> = Vec::new();
    for (i, b) in json.get("buffers").map(Json::arr).unwrap_or(&[]).iter().enumerate() {
        match b.get("uri").and_then(Json::str) {
            None => buffers.push(if i == 0 { glb_bin.map(<[u8]>::to_vec).unwrap_or_default() } else { Vec::new() }),
            Some(uri) if uri.starts_with("data:") => {
                let (_, data) = uri.split_once(',').ok_or("glTF: Data-URI ohne Daten")?;
                buffers.push(base64_decode(data)?);
            }
            Some(uri) => {
                let name = percent_decode(uri);
                let base = name.rsplit(['/', '\\']).next().unwrap_or(&name).to_ascii_lowercase();
                match opts.files.iter().find(|(n, _)| n.rsplit(['/', '\\']).next().unwrap_or(n).to_ascii_lowercase() == base) {
                    Some((_, d)) => buffers.push(d.clone()),
                    None => {
                        missing.push(name);
                        buffers.push(Vec::new());
                    }
                }
            }
        }
    }
    if !missing.is_empty() {
        return Err(format!("[extern] glTF verweist auf externe Datei(en), die fehlen: {} (mit der .gltf-Datei zusammen wählen)", missing.join(", ")));
    }
    let doc = Doc { json, buffers };

    // Gemeinsamer Eckpunkt-Pool je Mesh-Primitive wird beim Besuch eines Knotens transformiert eingetragen.
    let nodes = doc.json.get("nodes").map(Json::arr).unwrap_or(&[]);
    let mut roots: Vec<usize> = Vec::new();
    let scenes = doc.json.get("scenes").map(Json::arr).unwrap_or(&[]);
    let scene_i = doc.json.get("scene").and_then(Json::idx).unwrap_or(0);
    if let Some(sc) = scenes.get(scene_i) {
        roots.extend(sc.get("nodes").map(Json::arr).unwrap_or(&[]).iter().filter_map(Json::idx));
    } else if !nodes.is_empty() {
        let mut child = vec![false; nodes.len()];
        for n in nodes {
            for c in n.get("children").map(Json::arr).unwrap_or(&[]).iter().filter_map(Json::idx) {
                if c < child.len() {
                    child[c] = true;
                }
            }
        }
        roots.extend((0..nodes.len()).filter(|i| !child[*i]));
    }
    let mut state = Walk { visited: 0 };
    if nodes.is_empty() {
        // Ohne Knoten: jedes Mesh einmal, Einheitsmatrix.
        let n = doc.json.get("meshes").map(Json::arr).unwrap_or(&[]).len();
        for mi in 0..n {
            add_mesh(&doc, mi, &IDENT, "", "", p, mi)?;
        }
    } else {
        for r in roots {
            walk(&doc, r, &IDENT, "", 0, p, &mut state)?;
        }
    }
    if p.objects.is_empty() && !p.truncated {
        return Err("glTF enthält keine Dreiecks-Meshes".into());
    }
    Ok(())
}

struct Walk {
    visited: usize,
}

fn walk(doc: &Doc, ni: usize, parent: &Mat, parent_name: &str, depth: usize, p: &mut Parsed, st: &mut Walk) -> Result<(), String> {
    if depth > 64 {
        return Err("glTF: Knotenhierarchie zu tief (Zyklus?)".into());
    }
    st.visited += 1;
    if st.visited > 400_000 || p.truncated {
        p.truncated = true;
        return Ok(());
    }
    let Some(node) = doc.json.get("nodes").map(Json::arr).and_then(|a| a.get(ni)) else {
        p.bad_faces += 1;
        return Ok(());
    };
    let m = mul(parent, &node_matrix(node));
    let name = node.get("name").and_then(Json::str).unwrap_or("");
    if let Some(mi) = node.get("mesh").and_then(Json::idx) {
        add_mesh(doc, mi, &m, name, parent_name, p, ni)?;
    }
    let children: Vec<usize> = node.get("children").map(Json::arr).unwrap_or(&[]).iter().filter_map(Json::idx).collect();
    let next_parent = if name.is_empty() { parent_name } else { name };
    for c in children {
        walk(doc, c, &m, next_parent, depth + 1, p, st)?;
    }
    Ok(())
}

/// Ein Knoten mit Mesh → je Material (Farbe) ein Objekt.
fn add_mesh(doc: &Doc, mi: usize, m: &Mat, node_name: &str, group: &str, p: &mut Parsed, node_i: usize) -> Result<(), String> {
    let Some(mesh) = doc.json.get("meshes").map(Json::arr).and_then(|a| a.get(mi)) else {
        p.bad_faces += 1;
        return Ok(());
    };
    let name = if !node_name.is_empty() {
        node_name.to_string()
    } else if let Some(n) = mesh.get("name").and_then(Json::str).filter(|n| !n.is_empty()) {
        n.to_string()
    } else {
        format!("Knoten {node_i}")
    };
    let flip = det3(m) < 0.0;
    // (Material, Objektindex)
    let mut by_mat: Vec<(Option<usize>, usize)> = Vec::new();
    for prim in mesh.get("primitives").map(Json::arr).unwrap_or(&[]) {
        let mode = prim.get("mode").and_then(Json::idx).unwrap_or(4);
        if !matches!(mode, 4..=6) {
            p.warn("glTF: Linien/Punkte übersprungen (nur Dreiecke)".into());
            continue;
        }
        if prim.get("extensions").and_then(|e| e.get("KHR_draco_mesh_compression")).is_some() {
            return Err("glTF: Draco-komprimierte Geometrie nicht unterstützt: bitte unkomprimiert exportieren".into());
        }
        let Some(pos_i) = prim.get("attributes").and_then(|a| a.get("POSITION")).and_then(Json::idx) else {
            p.bad_faces += 1;
            continue;
        };
        let remaining = MAX_VERTICES.saturating_sub(p.vertex_count());
        let pos = read_accessor(doc, pos_i, 3, remaining.saturating_mul(3))?;
        let nv = pos.len() / 3;
        if nv > remaining {
            p.truncated = true;
            break;
        }
        let base = p.vertex_count() as u32;
        for v in pos.chunks_exact(3) {
            // Spaltenmatrix: x' = m0·x + m4·y + m8·z + m12.
            p.pool.push(m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12]);
            p.pool.push(m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13]);
            p.pool.push(m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14]);
        }
        let idx: Vec<u32> = match prim.get("indices").and_then(Json::idx) {
            Some(ai) => read_accessor(doc, ai, 1, 60_000_000)?
                .into_iter()
                .map(|v| if v >= 0.0 && (v as usize) < nv { base + v as u32 } else { u32::MAX })
                .collect(),
            None => (0..nv as u32).map(|i| base + i).collect(),
        };
        let mut tris: Vec<[u32; 3]> = Vec::new();
        match mode {
            4 => {
                for t in idx.chunks_exact(3) {
                    tris.push([t[0], t[1], t[2]]);
                }
            }
            5 => {
                for k in 0..idx.len().saturating_sub(2) {
                    // Jedes zweite Dreieck umgekehrt, damit die Wicklung gleich bleibt.
                    if k % 2 == 0 {
                        tris.push([idx[k], idx[k + 1], idx[k + 2]]);
                    } else {
                        tris.push([idx[k + 1], idx[k], idx[k + 2]]);
                    }
                }
            }
            _ => {
                for k in 1..idx.len().saturating_sub(1) {
                    tris.push([idx[0], idx[k], idx[k + 1]]);
                }
            }
        }
        // Reservierte Indizes (u32::MAX) → ungültig zählen.
        let before = tris.len();
        tris.retain(|t| !t.contains(&u32::MAX));
        p.bad_faces += before - tris.len();
        if flip {
            for t in &mut tris {
                t.swap(1, 2);
            }
        }
        if tris.is_empty() || !p.room(tris.len()) {
            continue;
        }
        let mat = prim.get("material").and_then(Json::idx);
        let color = material_color(doc, mat);
        // Gleiche Farbe (nicht nur gleicher Material-Index) → ein Objekt.
        let at = match by_mat.iter().find(|(mm, _)| *mm == mat || (color.is_some() && material_color(doc, *mm) == color)) {
            Some((_, oi)) => *oi,
            None => {
                let oi = p.objects.len();
                p.objects.push(Raw { name: String::new(), group: group.to_string(), color, tris: Vec::new() });
                by_mat.push((mat, oi));
                oi
            }
        };
        p.objects[at].tris.extend_from_slice(&tris);
    }
    // Namen: bei mehreren Farben je Knoten das Material anhängen.
    let many = by_mat.len() > 1;
    for (mat, oi) in &by_mat {
        let mname = mat
            .and_then(|i| doc.json.get("materials").map(Json::arr).and_then(|a| a.get(i)))
            .and_then(|m| m.get("name"))
            .and_then(Json::str)
            .unwrap_or("");
        p.objects[*oi].name = if many && !mname.is_empty() { format!("{name} ({mname})") } else { name.clone() };
    }
    Ok(())
}
