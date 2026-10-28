// IFC4-Schreiber ([B5], Port von `src/export/exportIfc.ts`): erzeugt aus einer flachen Bauteilliste die
// STEP-Datei (ISO 10303-21). TS sammelt aus Projekt und Plan (Wand-Bänder, Öffnungen, Dach-Meshes,
// Raumflächen, Georeferenz — alles Geometrie, die im TS-Modell lebt) und gibt sie fertig gerechnet
// weiter; Rust vergibt die Entitätsnummern und baut die Entitäten, GUIDs, Typen mit Materialschichten,
// Eigenschaftssätze (gleicher Inhalt = ein Pset), Beziehungen, Räume und die Georeferenz. Die Reihenfolge
// der Entitäten ist die der TS-Fassung (Golden-Vergleich 28.10.).
//
// Flache Kodierung (Muster `export.rs`): Zahlen als `f64`-Puffer, Zeichenketten getrennt als EINE
// Zeichenkette, Teile durch `\0` getrennt; im Zahlenpuffer steht ihr Index (−1 = keine).
//
//   [FLAT_VERSION, META, Datensatz, Datensatz, …]
//   META     = project_id, project_name, now (Sekunden, ganzzahlig), iso (Zeitstempel, Text), has_geo (0/1),
//              ref_elevation (NaN = keine), n_storeys, (id, name, base) × n_storeys
//   PTS      = n, x0, y0, …, x(n−1), y(n−1)                   (Profil, offen; Rust schliesst es)
//   MESH     = n_verts, x, y, z, …, n_tris, i0, i1, i2, …, closed (0/1)      (Indizes 0-basiert)
//   TYPEREF  = has (0/1); wenn 1: kind (0 Wand, 1 Decke, 2 Dach), type_id, type_name, predefined (Text),
//              n_layers, (component_id, component_name, thickness) × n_layers
//   PSETS    = n, (name, n_props, (prop_name, kind, value) × n_props) × n
//              kind 0 = IfcIdentifier (value = Zeichenketten-Index), 1 = IfcBoolean (0/1),
//              2 = IfcPositiveRatioMeasure (value = Zahl)
//   structure= Geschoss-Index oder −1 (Gebäude)
//
//   WALL_SOLIDS = 1, structure, id, name, TYPEREF, PSETS, FRAME, n_solids, (PTS, z_rel, depth) × n_solids
//     FRAME = has_frame (0/1); wenn 1: ox, oy, ux, uy (Wandanfang und Achsrichtung in Welt-XY, ux²+uy² = 1),
//             axis_len, usage (0/1), offset. Mit Rahmen sitzt das Placement am Wandanfang, X = Achse, Y = linke
//             Normale ([B5]: so ordnen Revit/ArchiCAD die Schichten der Achse zu); die PTS bleiben Welt-XY und
//             werden hier ins Wandsystem gerechnet. Dazu eine „Axis“-Darstellung (IfcPolyline 0 … axis_len)
//             und, bei usage = 1 und vorhandenem Typ, IfcMaterialLayerSetUsage (AXIS2, POSITIVE, `offset` =
//             Abstand der ersten Schicht von der Achse entlang +Y). Ohne Rahmen: Placement ohne Drehung wie bisher.
//   WALL_MESH   = 2, structure, id, name, TYPEREF, PSETS, MESH
//   CEILING     = 3, structure, id, name, TYPEREF, PSETS, PTS, z_rel, depth
//   OPENING     = 4, wall_id, structure, opening_id, is_door (0/1), fill_name, PTS (Öffnungskörper), z_rel,
//                 depth, width, FILL, PSETS
//     FILL (Parameter aus dem Modell; Körper, Placement und OperationType/PartitioningType rechnet
//          `ifc_openings.rs`, Version 2 seit 28.10.; OPT = has (0/1), value):
//          wall_sx, wall_sy, wall_ex, wall_ey, from, to, z_bottom, z_top, n_lo, n_hi,
//          frame_depth OPT, inset OPT, inset_outside (0/1), frame_width OPT,
//          wing_count, panes (1–3), n_sashes, (post, post_width OPT, fixed, width OPT) × n_sashes,
//          door_kind (0 Dreh, 1 Schiebe, 2 Wandöffnung), leaf_count, swing_sign (±1), dir_sign (±1),
//          hinge_at_start (0/1), transom_height, glazed (0/1), glazing_ratio OPT
//     Die Füllung bekommt ein eigenes Placement (Ursprung = Öffnungsmitte auf der Achse, X = u, Y = linke
//     Normale von u; Tür: Y = Aufschlagrichtung); ohne Teile (Wandöffnung) kein Körper. Alle Teile
//     (0 Rahmen/Zarge, 1 Türblatt, 2 Glas) sind getrennte Körper in EINER Darstellung, je mit eigenem
//     IfcStyledItem (Farbe/Transparenz je Rolle).
//   STAIR       = 5, structure, id, predefined (Text), PTS, z_rel, depth
//   EXTRUSION   = 6, structure, id, PTS, z_rel, depth
//   SPACE       = 7, structure, id, name, long_name, external (0/1), height, PTS, net_area, gross_area,
//                 sia_category, PSETS
//   END_SPACES  = 8   (bündelt die Räume je Geschoss zu IfcRelAggregates)
//   ROOF        = 9, structure, id, name, predefined (Text), TYPEREF, PSETS, MESH
//   COLUMN      = 10, structure, id, label, PTS, z_rel, depth, component_id (−1 = keine), component_name, PSETS
//   END_COLUMNS = 11  (Materialzuordnung der Stützen)
//
// Danach folgen (am Pufferende) Typ-Zuordnungen, Eigenschaftssätze, räumliche Eingliederung und Fuss.
//
// Fehlerverhalten: ein kaputter Puffer (falsche Version, unbekannter Datensatz, abgeschnitten, Index
// ausserhalb, NaN/∞ in einer Koordinate) ergibt einen Fehler, nie einen Panic.
//
// Abweichungen zur TS-Fassung: Zeichenketten mit unpaarigen UTF-16-Surrogaten kommen über wasm-bindgen als
// U+FFFD an (TS schrieb `\X2\D800\X0\`); `\0` in Namen wird auf TS-Seite entfernt; NaN/∞ in Koordinaten
// ist ein Fehler statt der Zeichenkette „NaN“.

use std::collections::HashMap;

use crate::ifc_openings::{fill_geometry, DoorKind, FillParams, FillPart, Sash, MAX_SASHES};

/// Version der flachen Kodierung (erstes Element des Puffers).
pub const FLAT_VERSION: f64 = 2.0;

pub const REC_WALL_SOLIDS: f64 = 1.0;
pub const REC_WALL_MESH: f64 = 2.0;
pub const REC_CEILING: f64 = 3.0;
pub const REC_OPENING: f64 = 4.0;
pub const REC_STAIR: f64 = 5.0;
pub const REC_EXTRUSION: f64 = 6.0;
pub const REC_SPACE: f64 = 7.0;
pub const REC_END_SPACES: f64 = 8.0;
pub const REC_ROOF: f64 = 9.0;
pub const REC_COLUMN: f64 = 10.0;
pub const REC_END_COLUMNS: f64 = 11.0;

// ── IFC-GUID (Kompression nach IfcOpenShell `guid.compress`) ────────────────

const IFC_GUID_CHARS: &[u8; 64] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$";

/// Kodiert `v` big-endian in `len` IFC-GUID-Zeichen (Basis 64).
fn guid_b64(v: u32, len: usize, out: &mut String) {
    for i in (0..len).rev() {
        out.push(IFC_GUID_CHARS[((v >> (6 * i)) & 63) as usize] as char);
    }
}

/// Komprimiert 16 Bytes zur 22-stelligen IFC-GUID (erstes Byte → 2 Zeichen, dann 5 × 3 Byte → 4 Zeichen).
fn compress_guid(bytes: &[u8; 16]) -> String {
    let mut out = String::with_capacity(22);
    guid_b64(u32::from(bytes[0]), 2, &mut out);
    let mut i = 1;
    while i < 16 {
        let v = (u32::from(bytes[i]) << 16) + (u32::from(bytes[i + 1]) << 8) + u32::from(bytes[i + 2]);
        guid_b64(v, 4, &mut out);
        i += 3;
    }
    out
}

/// Mischt die Bits eines 64-Bit-Werts (MurmurHash3-fmix64).
fn fmix64(mut k: u64) -> u64 {
    k ^= k >> 33;
    k = k.wrapping_mul(0xff51_afd7_ed55_8ccd);
    k ^= k >> 33;
    k = k.wrapping_mul(0xc4ce_b9fe_1a85_ec53);
    k ^= k >> 33;
    k
}

/// FNV-1a-64 über Bytes (vorwärts oder rückwärts) — reines Streuungswerkzeug, keine Kryptografie.
fn fnv1a64(bytes: &[u8], seed: u64, reverse: bool) -> u64 {
    const PRIME: u64 = 0x0000_0100_0000_01b3;
    let mut hash = seed;
    for i in 0..bytes.len() {
        let b = if reverse { bytes[bytes.len() - 1 - i] } else { bytes[i] };
        hash ^= u64::from(b);
        hash = hash.wrapping_mul(PRIME);
    }
    hash
}

/// Deterministische 22-stellige IFC-GUID aus einem Namen: zwei unabhängige 64-Bit-Läufe (FNV-1a vorwärts/
/// rückwärts mit verschiedenen Startwerten, je fmix64-nachgemischt), gekennzeichnet als RFC-9562-UUID
/// Version 8 mit Variante 10. Im Export lautet der Name `<Projekt-id>/<Art>/<id>[/<Zusatz>]`.
pub fn ifc_guid(name: &str) -> String {
    let bytes = name.as_bytes();
    let h1 = fmix64(fnv1a64(bytes, 0xcbf2_9ce4_8422_2325, false));
    let h2 = fmix64(fnv1a64(bytes, 0x9e37_79b9_7f4a_7c15, true) ^ (bytes.len() as u64));
    let mut b = [0u8; 16];
    b[..8].copy_from_slice(&h1.to_be_bytes());
    b[8..].copy_from_slice(&h2.to_be_bytes());
    // Hex-Zeichen 12 (= obere Hälfte von Byte 6) = Version 8; Hex-Zeichen 16 (= obere Hälfte von Byte 8)
    // = Variante 10xx.
    b[6] = (b[6] & 0x0f) | 0x80;
    b[8] = (b[8] & 0x3f) | 0x80;
    compress_guid(&b)
}

// ── STEP-Formatierung ───────────────────────────────────────────────────────

/// STEP-String-Literal (ISO 10303-21): druckbares ASCII bleibt, Backslash und Apostroph werden verdoppelt,
/// alles andere (Umlaute, Steuerzeichen) als `\X2\HHHH…\X0\` (BMP) bzw. `\X4\HHHHHHHH…\X0\` (ausserhalb).
pub fn ifc_string(s: &str) -> String {
    use std::fmt::Write;
    let mut out = String::with_capacity(s.len() + 2);
    out.push('\'');
    let mut run: Vec<u32> = Vec::new();
    fn flush(run: &mut Vec<u32>, out: &mut String) {
        if run.is_empty() {
            return;
        }
        let wide = run.iter().any(|&c| c > 0xffff);
        out.push_str(if wide { "\\X4\\" } else { "\\X2\\" });
        for &c in run.iter() {
            if wide {
                let _ = write!(out, "{c:08X}");
            } else {
                let _ = write!(out, "{c:04X}");
            }
        }
        out.push_str("\\X0\\");
        run.clear();
    }
    for ch in s.chars() {
        let c = ch as u32;
        if (0x20..=0x7e).contains(&c) {
            flush(&mut run, &mut out);
            match ch {
                '\\' => out.push_str("\\\\"),
                '\'' => out.push_str("''"),
                _ => out.push(ch),
            }
        } else {
            // \X2\ und \X4\ nicht mischen: Wechsel der Breite beginnt einen neuen Block.
            if let Some(&first) = run.first() {
                if (first > 0xffff) != (c > 0xffff) {
                    flush(&mut run, &mut out);
                }
            }
            run.push(c);
        }
    }
    flush(&mut run, &mut out);
    out.push('\'');
    out
}

/// STEP-REAL-Literal — immer mit Dezimalpunkt, ohne unnötige Nachkommastellen. Rundet wie JavaScripts
/// `toFixed(6)` (Betrag, bei Gleichstand auf), damit die Ausgabe der TS-Fassung gleicht.
pub fn fmt_real(x: f64) -> String {
    if !x.is_finite() {
        return "0.0".to_string();
    }
    let neg = x < 0.0;
    let a = x.abs();
    // Ziffernfolge aus Ganzzahl- und 6 Nachkommastellen (ohne Punkt).
    let digits: String = {
        let sc = a * 1e6;
        let fast = if sc < 1e12 {
            let fl = sc.floor();
            let frac = sc - fl;
            if (frac - 0.5).abs() > 1e-3 {
                let n = if frac > 0.5 { fl + 1.0 } else { fl } as u64;
                Some(format!("{n:07}"))
            } else {
                None
            }
        } else {
            None
        };
        match fast {
            Some(d) => d,
            None => exact_scaled_digits(a),
        }
    };
    let (int_part, frac_part) = digits.split_at(digits.len() - 6);
    let int_trim = int_part.trim_start_matches('0');
    let int_str = if int_trim.is_empty() { "0" } else { int_trim };
    let frac_trim = frac_part.trim_end_matches('0');
    let mut s = String::with_capacity(digits.len() + 3);
    if neg {
        s.push('-');
    }
    s.push_str(int_str);
    s.push('.');
    s.push_str(if frac_trim.is_empty() { "0" } else { frac_trim });
    s
}

/// `a · 10⁶` auf eine Ganzzahl gerundet (Gleichstand auf), aus der exakten Dezimaldarstellung des `f64`.
fn exact_scaled_digits(a: f64) -> String {
    let exact = format!("{a:.80}");
    let (int_s, frac_s) = exact.split_once('.').unwrap_or((exact.as_str(), ""));
    let frac_b = frac_s.as_bytes();
    let mut d: Vec<u8> = int_s.bytes().collect();
    for i in 0..6 {
        d.push(*frac_b.get(i).unwrap_or(&b'0'));
    }
    let round_up = frac_b.get(6).is_some_and(|&c| c >= b'5');
    if round_up {
        let mut i = d.len();
        loop {
            if i == 0 {
                d.insert(0, b'1');
                break;
            }
            i -= 1;
            if d[i] == b'9' {
                d[i] = b'0';
            } else {
                d[i] += 1;
                break;
            }
        }
    }
    while d.len() < 7 {
        d.insert(0, b'0');
    }
    String::from_utf8(d).unwrap_or_else(|_| "0000000".to_string())
}

fn enum_(v: &str) -> String {
    format!(".{v}.")
}

fn list(items: &[String]) -> String {
    format!("({})", items.join(","))
}

fn refs(ids: &[usize]) -> String {
    let v: Vec<String> = ids.iter().map(|id| format!("#{id}")).collect();
    list(&v)
}

/// JSON-Zeichenkette für den Pset-Schlüssel (nur `"` und `\` kommen in IFC-Literalen vor, alles andere ist
/// druckbares ASCII).
fn json_str(s: &str) -> String {
    let mut o = String::with_capacity(s.len() + 2);
    o.push('"');
    for ch in s.chars() {
        match ch {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            _ => o.push(ch),
        }
    }
    o.push('"');
    o
}

// ── Eingabe ─────────────────────────────────────────────────────────────────

struct Reader<'a> {
    buf: &'a [f64],
    pos: usize,
    strings: Vec<&'a str>,
}

impl<'a> Reader<'a> {
    fn done(&self) -> bool {
        self.pos >= self.buf.len()
    }
    fn raw(&mut self) -> Result<f64, String> {
        let v = *self
            .buf
            .get(self.pos)
            .ok_or_else(|| format!("Puffer abgeschnitten bei {}", self.pos))?;
        self.pos += 1;
        Ok(v)
    }
    /// Endliche Zahl.
    fn f(&mut self) -> Result<f64, String> {
        let v = self.raw()?;
        if !v.is_finite() {
            return Err(format!("Zahl ist NaN/∞ bei {}", self.pos - 1));
        }
        Ok(v)
    }
    /// Nicht-negative Ganzzahl (Index, Anzahl).
    fn idx(&mut self) -> Result<usize, String> {
        let v = self.raw()?;
        if !v.is_finite() || v < 0.0 || v.fract() != 0.0 || v > u32::MAX as f64 {
            return Err(format!("ungültiger Index {v} bei {}", self.pos - 1));
        }
        Ok(v as usize)
    }
    fn flag(&mut self) -> Result<bool, String> {
        Ok(self.idx()? != 0)
    }
    /// Index oder −1.
    fn opt_idx(&mut self) -> Result<Option<usize>, String> {
        let v = self.raw()?;
        if v == -1.0 {
            return Ok(None);
        }
        if !v.is_finite() || v < 0.0 || v.fract() != 0.0 || v > u32::MAX as f64 {
            return Err(format!("ungültiger Index {v} bei {}", self.pos - 1));
        }
        Ok(Some(v as usize))
    }
    fn string(&mut self) -> Result<String, String> {
        let i = self.idx()?;
        self.strings
            .get(i)
            .map(|s| (*s).to_string())
            .ok_or_else(|| format!("Zeichenketten-Index {i} ausserhalb ({})", self.strings.len()))
    }
    fn opt_string(&mut self) -> Result<Option<String>, String> {
        match self.opt_idx()? {
            None => Ok(None),
            Some(i) => self
                .strings
                .get(i)
                .map(|s| Some((*s).to_string()))
                .ok_or_else(|| format!("Zeichenketten-Index {i} ausserhalb ({})", self.strings.len())),
        }
    }
    fn take(&mut self, n: usize) -> Result<&'a [f64], String> {
        let end = self.pos.checked_add(n).ok_or("Überlauf")?;
        let s = self
            .buf
            .get(self.pos..end)
            .ok_or_else(|| format!("Puffer abgeschnitten bei {}", self.pos))?;
        self.pos = end;
        if s.iter().any(|v| !v.is_finite()) {
            return Err(format!("Zahl ist NaN/∞ vor {}", self.pos));
        }
        Ok(s)
    }
    /// Struktur: Geschoss-Index (geprüft gegen `n_storeys`) oder −1 = Gebäude.
    fn structure(&mut self, n_storeys: usize) -> Result<i64, String> {
        match self.opt_idx()? {
            None => Ok(-1),
            Some(i) if i < n_storeys => Ok(i as i64),
            Some(i) => Err(format!("Geschoss-Index {i} ausserhalb ({n_storeys})")),
        }
    }
    fn pts(&mut self) -> Result<Vec<(f64, f64)>, String> {
        let n = self.idx()?;
        let s = self.take(n.checked_mul(2).ok_or("Überlauf")?)?;
        Ok(s.chunks_exact(2).map(|c| (c[0], c[1])).collect())
    }
    /// Optionaler Wert: has (0/1), value.
    fn opt_f(&mut self) -> Result<Option<f64>, String> {
        let has = self.flag()?;
        let v = self.f()?;
        Ok(has.then_some(v))
    }
    /// FILL-Parameter einer Tür/eines Fensters (s. Kopf; Geometrie in `ifc_openings.rs`).
    fn fill_params(&mut self, is_door: bool) -> Result<FillParams, String> {
        let (sx, sy, ex, ey) = (self.f()?, self.f()?, self.f()?, self.f()?);
        let (from, to, z_bottom, z_top) = (self.f()?, self.f()?, self.f()?, self.f()?);
        let (n_lo, n_hi) = (self.f()?, self.f()?);
        let (frame_depth, inset) = (self.opt_f()?, self.opt_f()?);
        let inset_outside = self.flag()?;
        let frame_width = self.opt_f()?;
        let wing_count = self.f()?;
        let panes = self.idx()?;
        if !(1..=3).contains(&panes) {
            return Err(format!("Scheibenzahl {panes} bei {}", self.pos - 1));
        }
        let n = self.idx()?;
        if n > MAX_SASHES {
            return Err(format!("zu viele Flügel ({n}) bei {}", self.pos - 1));
        }
        let mut sashes = Vec::with_capacity(n);
        for _ in 0..n {
            let post = self.flag()?;
            let post_width = self.opt_f()?;
            let fixed = self.flag()?;
            let width = self.opt_f()?;
            sashes.push(Sash { post, post_width, fixed, width });
        }
        let door_kind = match self.idx()? {
            0 => DoorKind::Swing,
            1 => DoorKind::Sliding,
            2 => DoorKind::WallOpening,
            k => return Err(format!("unbekannte Türart {k} bei {}", self.pos - 1)),
        };
        let leaf_count = self.f()?;
        let (swing_sign, dir_sign) = (self.f()?, self.f()?);
        if swing_sign.abs() != 1.0 || dir_sign.abs() != 1.0 {
            return Err(format!("Aufschlag nicht ±1 bei {}", self.pos - 1));
        }
        let hinge_at_start = self.flag()?;
        let transom_height = self.f()?;
        let glazed = self.flag()?;
        let glazing_ratio = self.opt_f()?;
        Ok(FillParams {
            wall_start: (sx, sy),
            wall_end: (ex, ey),
            from,
            to,
            z_bottom,
            z_top,
            n_lo,
            n_hi,
            is_door,
            frame_depth,
            inset,
            inset_outside,
            frame_width,
            wing_count,
            panes,
            sashes,
            door_kind,
            leaf_count,
            swing_sign,
            dir_sign,
            hinge_at_start,
            transom_height,
            glazed,
            glazing_ratio,
        })
    }
    fn mesh(&mut self) -> Result<Mesh, String> {
        let nv = self.idx()?;
        let positions = self.take(nv.checked_mul(3).ok_or("Überlauf")?)?.to_vec();
        let nt = self.idx()?;
        let n_idx = nt.checked_mul(3).ok_or("Überlauf")?;
        let raw = self.take(n_idx)?;
        let mut indices = Vec::with_capacity(n_idx);
        for &v in raw {
            if v < 0.0 || v.fract() != 0.0 || v >= nv as f64 {
                return Err(format!("Dreiecks-Index {v} ausserhalb ({nv} Punkte)"));
            }
            indices.push(v as usize);
        }
        let closed = self.flag()?;
        Ok(Mesh { positions, indices, closed })
    }
    fn type_ref(&mut self) -> Result<Option<TypeRef>, String> {
        if !self.flag()? {
            return Ok(None);
        }
        let kind = match self.idx()? {
            0 => TypeKind::Wall,
            1 => TypeKind::Slab,
            2 => TypeKind::Roof,
            k => return Err(format!("unbekannte Typart {k}")),
        };
        let id = self.string()?;
        let name = self.string()?;
        let predefined = self.string()?;
        let n = self.idx()?;
        let mut layers = Vec::new();
        for _ in 0..n {
            let component_id = self.string()?;
            let component_name = self.string()?;
            let thickness = self.raw()?; // NaN → 0 (wie TS)
            layers.push(Layer { component_id, component_name, thickness });
        }
        Ok(Some(TypeRef { kind, id, name, predefined, layers }))
    }
    fn psets(&mut self) -> Result<Vec<Pset>, String> {
        let n = self.idx()?;
        let mut out = Vec::new();
        for _ in 0..n {
            let name = self.string()?;
            let np = self.idx()?;
            let mut props = Vec::new();
            for _ in 0..np {
                let pname = self.string()?;
                let value = match self.idx()? {
                    0 => PropVal::Ident(self.string()?),
                    1 => PropVal::Bool(self.flag()?),
                    2 => PropVal::Ratio(self.f()?),
                    k => return Err(format!("unbekannte Eigenschaftsart {k}")),
                };
                props.push((pname, value));
            }
            out.push(Pset { name, props });
        }
        Ok(out)
    }
}

/// Ein Körper einer Tür/eines Fensters (Welt-XY-Profil, Unterkante ab Öffnungs-UK; `ifc_openings.rs`).
type Part = FillPart;

/// Farbe und Durchsichtigkeit je Teilrolle (wie `PART_RGB` im 3D: Rahmen hellgrau, Blatt warm, Glas bläulich).
const PART_STYLES: [(&str, [f64; 3], f64); 3] = [
    ("Rahmen", [0.85, 0.85, 0.83], 0.0),
    ("Türblatt", [0.93, 0.90, 0.85], 0.0),
    ("Glas", [0.62, 0.76, 0.85], 0.6),
];

/// Lokales Wand-/Füllungssystem in Welt-XY: Ursprung und Richtung der X-Achse (Y = linke Normale).
#[derive(Clone, Copy)]
struct Frame {
    ox: f64,
    oy: f64,
    ux: f64,
    uy: f64,
}

impl Frame {
    /// Identität (Welt-Koordinaten).
    const WORLD: Frame = Frame { ox: 0.0, oy: 0.0, ux: 1.0, uy: 0.0 };

    fn is_world(&self) -> bool {
        self.ox == 0.0 && self.oy == 0.0 && self.ux == 1.0 && self.uy == 0.0
    }

    /// Welt-XY → lokal (X = u, Y = linke Normale (−uy, ux)).
    fn local(&self, x: f64, y: f64) -> (f64, f64) {
        let (dx, dy) = (x - self.ox, y - self.oy);
        (dx * self.ux + dy * self.uy, -dx * self.uy + dy * self.ux)
    }

    fn local_pts(&self, pts: &[(f64, f64)]) -> Vec<(f64, f64)> {
        pts.iter().map(|&(x, y)| self.local(x, y)).collect()
    }

    /// Dieses System (in Welt-XY) im System `parent` ausgedrückt: Ursprung abbilden, Richtung nur drehen.
    fn relative_to(&self, parent: &Frame) -> Frame {
        let (ox, oy) = parent.local(self.ox, self.oy);
        Frame { ox, oy, ux: self.ux * parent.ux + self.uy * parent.uy, uy: -self.ux * parent.uy + self.uy * parent.ux }
    }
}

struct Mesh {
    positions: Vec<f64>,
    indices: Vec<usize>,
    closed: bool,
}

#[derive(Clone, Copy, PartialEq)]
enum TypeKind {
    Wall,
    Slab,
    Roof,
}

impl TypeKind {
    fn ifc(self) -> &'static str {
        match self {
            TypeKind::Wall => "IFCWALLTYPE",
            TypeKind::Slab => "IFCSLABTYPE",
            TypeKind::Roof => "IFCROOFTYPE",
        }
    }
}

struct Layer {
    component_id: String,
    component_name: String,
    thickness: f64,
}

struct TypeRef {
    kind: TypeKind,
    id: String,
    name: String,
    predefined: String,
    layers: Vec<Layer>,
}

enum PropVal {
    Ident(String),
    Bool(bool),
    Ratio(f64),
}

impl PropVal {
    /// IFC-Wert-Ausdruck, z. B. `IFCIDENTIFIER('…')`.
    fn expr(&self) -> String {
        match self {
            PropVal::Ident(s) => format!("IFCIDENTIFIER({})", ifc_string(s)),
            PropVal::Bool(b) => format!("IFCBOOLEAN({})", if *b { ".T." } else { ".F." }),
            PropVal::Ratio(r) => format!("IFCPOSITIVERATIOMEASURE({})", fmt_real(*r)),
        }
    }
}

struct Pset {
    name: String,
    props: Vec<(String, PropVal)>,
}

// ── Schreiber ───────────────────────────────────────────────────────────────

struct Storey {
    id: String,
    entity: usize,
    placement: usize,
}

struct PsetAcc {
    name: String,
    key: String,
    props: Vec<(String, String)>,
    related: Vec<usize>,
}

struct TypeAcc {
    key: String,
    type_id: usize,
    /// IfcMaterialLayerSet des Typs (0 = keiner) für die LayerSetUsage der Exemplare.
    layer_set: usize,
    occurrences: Vec<usize>,
}

/// Entitäten-Schreiber mit allem Zustand, den die TS-Fassung in Closures hielt.
struct Builder {
    lines: Vec<String>,
    project_id: String,
    owner_history: usize,
    context: usize,
    identity_axis: usize,
    extrude_dir: usize,
    building_entity: usize,
    building_placement: usize,
    storeys: Vec<Storey>,
    /// Eingliederung je Struktur (−1 = Gebäude), in Reihenfolge des ersten Auftretens.
    containment: Vec<(i64, Vec<usize>)>,
    psets: Vec<PsetAcc>,
    pset_index: HashMap<String, usize>,
    materials: HashMap<String, usize>,
    types: Vec<TypeAcc>,
    type_index: HashMap<String, usize>,
    /// Wand-id → (Entität, Placement, Wandsystem) für die Öffnungen.
    walls: HashMap<String, (usize, usize, Frame)>,
    /// Oberflächenstil je Teilrolle (Rahmen, Blatt, Glas), beim ersten Gebrauch angelegt (0 = noch nicht).
    styles: [usize; 3],
    /// Untergeordneter Kontext „Axis“ (GRAPH_VIEW), beim ersten Gebrauch angelegt (0 = noch nicht).
    axis_context: usize,

    spaces: Vec<(i64, Vec<usize>)>,
    column_materials: Vec<(String, String, Vec<usize>)>,
}

impl Builder {
    /// Schreibt eine neue Entity-Zeile und liefert ihre Nummer.
    fn add(&mut self, ty: &str, params: String) -> usize {
        let id = self.lines.len() + 1;
        self.lines.push(format!("#{id}={ty}({params});"));
        id
    }

    /// Dauerhafte GlobalId (als STEP-String) aus `<Art>/<id>[/<Zusatz>]`, im Namensraum des Projekts.
    fn gid(&self, key: &str) -> String {
        ifc_string(&ifc_guid(&format!("{}/{key}", self.project_id)))
    }

    fn placement_of(&self, structure: i64) -> usize {
        if structure < 0 {
            self.building_placement
        } else {
            self.storeys[structure as usize].placement
        }
    }

    fn entity_of(&self, structure: i64) -> usize {
        if structure < 0 {
            self.building_entity
        } else {
            self.storeys[structure as usize].entity
        }
    }

    fn key_of(&self, structure: i64) -> String {
        if structure < 0 {
            "building".to_string()
        } else {
            format!("storey/{}", self.storeys[structure as usize].id)
        }
    }

    fn add_to_containment(&mut self, structure: i64, element: usize) {
        if let Some((_, v)) = self.containment.iter_mut().find(|(s, _)| *s == structure) {
            v.push(element);
        } else {
            self.containment.push((structure, vec![element]));
        }
    }

    /// Eigenschaftssatz vormerken: gleicher Inhalt ⇒ EIN Pset für alle Bauteile (GUID aus dem Inhalt).
    fn add_pset(&mut self, pset: &Pset, element: usize) {
        if pset.props.is_empty() {
            return; // IfcPropertySet verlangt mindestens eine Eigenschaft
        }
        let props: Vec<(String, String)> = pset.props.iter().map(|(n, v)| (n.clone(), v.expr())).collect();
        // Schlüssel wie in der TS-Fassung: `<Name>/<JSON der [Name, Wert]-Paare>`.
        let json: Vec<String> = props
            .iter()
            .map(|(n, v)| format!("[{},{}]", json_str(n), json_str(v)))
            .collect();
        let key = format!("{}/[{}]", pset.name, json.join(","));
        if let Some(&i) = self.pset_index.get(&key) {
            self.psets[i].related.push(element);
        } else {
            self.pset_index.insert(key.clone(), self.psets.len());
            self.psets.push(PsetAcc { name: pset.name.clone(), key, props, related: vec![element] });
        }
    }

    /// Profil (geschlossenes Polygon) als IfcExtrudedAreaSolid, Unterkante `z_rel` in `+Z`.
    fn emit_extrusion(&mut self, footprint: &[(f64, f64)], z_rel: f64, depth: f64) -> usize {
        let mut pt_ids = Vec::with_capacity(footprint.len() + 1);
        for p in footprint.iter().chain(footprint.first()) {
            let id = self.add("IFCCARTESIANPOINT", list(&[fmt_real(p.0), fmt_real(p.1)]));
            pt_ids.push(id);
        }
        let polyline = self.add("IFCPOLYLINE", refs(&pt_ids));
        let profile = self.add("IFCARBITRARYCLOSEDPROFILEDEF", format!("{},$,#{polyline}", enum_("AREA")));
        let mut position = self.identity_axis;
        if z_rel != 0.0 {
            let pt = self.add("IFCCARTESIANPOINT", list(&[fmt_real(0.0), fmt_real(0.0), fmt_real(z_rel)]));
            position = self.add("IFCAXIS2PLACEMENT3D", format!("#{pt},$,$"));
        }
        self.add(
            "IFCEXTRUDEDAREASOLID",
            format!("#{profile},#{position},#{},{}", self.extrude_dir, fmt_real(depth.max(0.001))),
        )
    }

    /// Placement im Abstand `z_rel` über `relative_to`.
    fn emit_placement(&mut self, z_rel: f64, relative_to: usize) -> usize {
        let origin = self.add("IFCCARTESIANPOINT", list(&[fmt_real(0.0), fmt_real(0.0), fmt_real(z_rel)]));
        let axis = self.add("IFCAXIS2PLACEMENT3D", format!("#{origin},$,$"));
        self.add("IFCLOCALPLACEMENT", format!("#{relative_to},#{axis}"))
    }

    /// Placement am Punkt (`frame.ox`, `frame.oy`, 0) mit gedrehter X-Achse relativ zu `relative_to`.
    fn emit_placement_frame(&mut self, frame: &Frame, relative_to: usize) -> usize {
        let origin = self.add("IFCCARTESIANPOINT", list(&[fmt_real(frame.ox), fmt_real(frame.oy), fmt_real(0.0)]));
        let dir = self.add("IFCDIRECTION", list(&[fmt_real(frame.ux), fmt_real(frame.uy), fmt_real(0.0)]));
        // IFC4: Axis und RefDirection stehen nur zusammen (Axis = +Z).
        let axis = self.add("IFCAXIS2PLACEMENT3D", format!("#{origin},#{},#{dir}", self.extrude_dir));
        self.add("IFCLOCALPLACEMENT", format!("#{relative_to},#{axis}"))
    }

    /// Oberflächenstil der Teilrolle (einmal je Datei): IfcSurfaceStyle mit IfcSurfaceStyleRendering.
    fn part_style(&mut self, role: usize) -> usize {
        if self.styles[role] == 0 {
            let (name, rgb, transparency) = PART_STYLES[role];
            let colour = self.add("IFCCOLOURRGB", format!("$,{},{},{}", fmt_real(rgb[0]), fmt_real(rgb[1]), fmt_real(rgb[2])));
            let rendering = self.add(
                "IFCSURFACESTYLERENDERING",
                format!("#{colour},{},$,$,$,$,$,$,{}", fmt_real(transparency), enum_("NOTDEFINED")),
            );
            self.styles[role] = self.add(
                "IFCSURFACESTYLE",
                format!("{},{},{}", ifc_string(name), enum_("BOTH"), refs(&[rendering])),
            );
        }
        self.styles[role]
    }

    /// Körper einer Tür/eines Fensters: je Teil eine Extrusion mit eigenem Stil, alle in EINER
    /// SweptSolid-Darstellung (getrennte Körper im selben Bauteil). Profile kommen im Füllungssystem.
    fn emit_parts_shape(&mut self, parts: &[Part], frame: &Frame) -> usize {
        let mut solids = Vec::with_capacity(parts.len());
        for p in parts {
            let solid = self.emit_extrusion(&frame.local_pts(&p.pts), p.z_rel, p.depth);
            let style = self.part_style(p.role);
            self.add("IFCSTYLEDITEM", format!("#{solid},{},$", refs(&[style])));
            solids.push(solid);
        }
        self.emit_swept_shape(&solids)
    }

    /// Untergeordneter Darstellungskontext „Axis“ (GRAPH_VIEW), einmal je Datei.
    fn axis_context(&mut self) -> usize {
        if self.axis_context == 0 {
            self.axis_context = self.add(
                "IFCGEOMETRICREPRESENTATIONSUBCONTEXT",
                format!("{},{},*,*,*,*,#{},$,{},$", ifc_string("Axis"), ifc_string("Model"), self.context, enum_("GRAPH_VIEW")),
            );
        }
        self.axis_context
    }

    /// Wand-Darstellung: „Axis“ (IfcPolyline 0 … `len` in lokal X) und „Body“ (SweptSolid aus `solids`).
    fn emit_wall_shape(&mut self, solids: &[usize], len: f64) -> usize {
        let p0 = self.add("IFCCARTESIANPOINT", list(&[fmt_real(0.0), fmt_real(0.0)]));
        let p1 = self.add("IFCCARTESIANPOINT", list(&[fmt_real(len), fmt_real(0.0)]));
        let curve = self.add("IFCPOLYLINE", refs(&[p0, p1]));
        let axis_ctx = self.axis_context();
        let axis = self.add(
            "IFCSHAPEREPRESENTATION",
            format!("#{axis_ctx},{},{},{}", ifc_string("Axis"), ifc_string("Curve2D"), refs(&[curve])),
        );
        let body = self.add(
            "IFCSHAPEREPRESENTATION",
            format!("#{},{},{},{}", self.context, ifc_string("Body"), ifc_string("SweptSolid"), refs(solids)),
        );
        self.add("IFCPRODUCTDEFINITIONSHAPE", format!("$,$,{}", refs(&[axis, body])))
    }

    /// SweptSolid-Körper aus Extrusionen.
    fn emit_swept_shape(&mut self, solids: &[usize]) -> usize {
        let rep = self.add(
            "IFCSHAPEREPRESENTATION",
            format!("#{},{},{},{}", self.context, ifc_string("Body"), ifc_string("SweptSolid"), refs(solids)),
        );
        self.add("IFCPRODUCTDEFINITIONSHAPE", format!("$,$,{}", refs(&[rep])))
    }

    /// Profil+Extrusion+Shape+Placement für einen geschlossenen Footprint; liefert (Placement, Shape).
    fn emit_box_product(&mut self, footprint: &[(f64, f64)], z_bottom_rel: f64, depth: f64, relative_to: usize) -> (usize, usize) {
        let solid = self.emit_extrusion(footprint, 0.0, depth);
        let shape = self.emit_swept_shape(&[solid]);
        let placement = self.emit_placement(z_bottom_rel, relative_to);
        (placement, shape)
    }

    /// Dreiecks-Mesh als IfcTriangulatedFaceSet + Shape + Placement (Punkte tragen die Geometrie absolut
    /// im Rahmen der Trägerstruktur).
    fn emit_triangulated_product(&mut self, mesh: &Mesh, relative_to: usize) -> (usize, usize) {
        let coords: Vec<String> = mesh
            .positions
            .chunks_exact(3)
            .map(|c| format!("({},{},{})", fmt_real(c[0]), fmt_real(c[1]), fmt_real(c[2])))
            .collect();
        let point_list = self.add("IFCCARTESIANPOINTLIST3D", format!("({})", coords.join(",")));
        let tris: Vec<String> = mesh
            .indices
            .chunks_exact(3)
            .map(|c| format!("({},{},{})", c[0] + 1, c[1] + 1, c[2] + 1))
            .collect();
        // Closed=.T. nur, wenn TS das Mesh als dichtes, aussen orientiertes Volumen geprüft hat.
        let closed = if mesh.closed { ".T." } else { "$" };
        let face_set = self.add("IFCTRIANGULATEDFACESET", format!("#{point_list},$,{closed},({}),$", tris.join(",")));
        let rep = self.add(
            "IFCSHAPEREPRESENTATION",
            format!("#{},{},{},{}", self.context, ifc_string("Body"), ifc_string("Tessellation"), refs(&[face_set])),
        );
        let shape = self.add("IFCPRODUCTDEFINITIONSHAPE", format!("$,$,{}", refs(&[rep])));
        let placement = self.emit_placement(0.0, relative_to);
        (placement, shape)
    }

    /// IfcBuildingElement-Subtyp mit dem üblichen 9-Attribut-Flatten.
    fn emit_building_element(&mut self, ty: &str, guid: String, name: &str, placement: usize, shape: usize, predefined: Option<String>) -> usize {
        self.add(
            ty,
            format!(
                "{guid},#{},{},$,$,#{placement},#{shape},$,{}",
                self.owner_history,
                ifc_string(name),
                predefined.as_deref().unwrap_or("$")
            ),
        )
    }

    /// Material je Bauteil (einmal, beim ersten Gebrauch).
    fn material_of(&mut self, component_id: &str, component_name: &str) -> usize {
        if let Some(&id) = self.materials.get(component_id) {
            return id;
        }
        let id = self.add("IFCMATERIAL", format!("{},$,$", ifc_string(component_name)));
        self.materials.insert(component_id.to_string(), id);
        id
    }

    /// Typ (IfcWallType/SlabType/RoofType mit IfcMaterialLayerSet), einmal je Typ; liefert den Index.
    fn type_for(&mut self, t: &TypeRef) -> usize {
        let key = format!("type/{}/{}", t.kind.ifc(), t.id);
        if let Some(&i) = self.type_index.get(&key) {
            return i;
        }
        let mut layer_ids = Vec::new();
        for l in &t.layers {
            let m = self.material_of(&l.component_id, &l.component_name);
            let thickness = if l.thickness.is_finite() { l.thickness.max(0.0) } else { 0.0 };
            layer_ids.push(self.add("IFCMATERIALLAYER", format!("#{m},{},$,$,$,$,$", fmt_real(thickness))));
        }
        let guid = self.gid(&key);
        let type_id = self.add(
            t.kind.ifc(),
            format!("{guid},#{},{},$,$,$,$,$,$,{}", self.owner_history, ifc_string(&t.name), enum_(&t.predefined)),
        );
        let mut layer_set = 0;
        if !layer_ids.is_empty() {
            let set = self.add("IFCMATERIALLAYERSET", format!("{},{},$", refs(&layer_ids), ifc_string(&t.name)));
            let rel_guid = self.gid(&format!("{key}/material"));
            self.add(
                "IFCRELASSOCIATESMATERIAL",
                format!("{rel_guid},#{},$,$,{},#{set}", self.owner_history, refs(&[type_id])),
            );
            layer_set = set;
        }
        self.type_index.insert(key.clone(), self.types.len());
        self.types.push(TypeAcc { key, type_id, layer_set, occurrences: Vec::new() });
        self.types.len() - 1
    }

    /// IfcMaterialLayerSet eines schon angelegten Typs (`finish_typed` legt ihn an).
    fn layer_set_of(&self, t: &TypeRef) -> Option<usize> {
        let key = format!("type/{}/{}", t.kind.ifc(), t.id);
        let set = self.types[*self.type_index.get(&key)?].layer_set;
        (set != 0).then_some(set)
    }

    /// Gemeinsamer Abschluss der Bauteile mit Typ und Psets: Typ (falls vorhanden) anlegen, Entität
    /// schreiben, Typ-Exemplar, Eingliederung und Psets vormerken.
    #[allow(clippy::too_many_arguments)]
    fn finish_typed(
        &mut self,
        ifc: &str,
        guid_key: String,
        name: &str,
        ty: &Option<TypeRef>,
        psets: &[Pset],
        structure: i64,
        placement: usize,
        shape: usize,
        predefined: Option<String>,
        type_first: bool,
    ) -> usize {
        // Wand und Decke legen den Typ vor dem Bauteil an, das Dach danach (Reihenfolge der TS-Fassung).
        let mut type_idx = if type_first { ty.as_ref().map(|t| self.type_for(t)) } else { None };
        let guid = self.gid(&guid_key);
        let entity = self.emit_building_element(ifc, guid, name, placement, shape, predefined);
        if !type_first {
            type_idx = ty.as_ref().map(|t| self.type_for(t));
        }
        if let Some(i) = type_idx {
            self.types[i].occurrences.push(entity);
        }
        self.add_to_containment(structure, entity);
        for p in psets {
            self.add_pset(p, entity);
        }
        entity
    }
}

/// Ob die Eingabe überhaupt einen Datensatz verlangt — Hilfe für die Fehlermeldung.
fn rec_name(code: f64) -> &'static str {
    match code {
        c if c == REC_WALL_SOLIDS => "WALL_SOLIDS",
        c if c == REC_WALL_MESH => "WALL_MESH",
        c if c == REC_CEILING => "CEILING",
        c if c == REC_OPENING => "OPENING",
        _ => "?",
    }
}

/// Baut aus dem flachen Puffer die STEP-Datei (IFC4). Fehler als Text.
pub fn build_ifc(flat: &[f64], strings: &str) -> Result<String, String> {
    let mut r = Reader { buf: flat, pos: 0, strings: strings.split('\0').collect() };
    let version = r.raw()?;
    if version != FLAT_VERSION {
        return Err(format!("unbekannte Version {version}"));
    }
    // ── META ──
    let project_id = r.string()?;
    let project_name = r.string()?;
    let now_f = r.f()?;
    if now_f.fract() != 0.0 {
        return Err("Zeitstempel nicht ganzzahlig".to_string());
    }
    let now = now_f as i64;
    let iso = r.string()?;
    let has_geo = r.flag()?;
    let ref_elevation = r.raw()?;
    let n_storeys = r.idx()?;
    let mut storey_defs = Vec::new();
    for _ in 0..n_storeys {
        let id = r.string()?;
        let name = r.string()?;
        let base = r.f()?;
        storey_defs.push((id, name, base));
    }

    let mut w = Builder {
        lines: Vec::new(),
        project_id,
        owner_history: 0,
        context: 0,
        identity_axis: 0,
        extrude_dir: 0,
        building_entity: 0,
        building_placement: 0,
        storeys: Vec::new(),
        containment: Vec::new(),
        psets: Vec::new(),
        pset_index: HashMap::new(),
        materials: HashMap::new(),
        types: Vec::new(),
        type_index: HashMap::new(),
        walls: HashMap::new(),
        axis_context: 0,
        styles: [0; 3],
        spaces: Vec::new(),
        column_materials: Vec::new(),
    };
    let pname = |dflt: &str| if project_name.is_empty() { dflt.to_string() } else { project_name.clone() };

    // Geteilte Grundgeometrie: Ursprung, Z-Extrusionsrichtung, Identitäts-Placement.
    let origin = w.add("IFCCARTESIANPOINT", list(&[fmt_real(0.0), fmt_real(0.0), fmt_real(0.0)]));
    w.extrude_dir = w.add("IFCDIRECTION", list(&[fmt_real(0.0), fmt_real(0.0), fmt_real(1.0)]));
    w.identity_axis = w.add("IFCAXIS2PLACEMENT3D", format!("#{origin},$,$"));

    // Owner-History (minimal, aber vorhanden — manche Importer verlangen sie).
    let org = w.add("IFCORGANIZATION", format!("$,{},$,$,$", ifc_string("dossier")));
    let person = w.add("IFCPERSON", format!("{},$,$,$,$,$,$,$", ifc_string("dossier")));
    let person_org = w.add("IFCPERSONANDORGANIZATION", format!("#{person},#{org},$"));
    let app = w.add(
        "IFCAPPLICATION",
        format!("#{org},{},{},{}", ifc_string("1.0"), ifc_string("dossier"), ifc_string("dossier")),
    );
    // ChangeAction ADDED verlangt ein LastModifiedDate (IFC4-Regel IfcOwnerHistory.CorrectChangeAction).
    w.owner_history = w.add(
        "IFCOWNERHISTORY",
        format!("#{person_org},#{app},$,{},{now},$,$,{now}", enum_("ADDED")),
    );

    // Einheiten (Meter, Radiant, m², m³).
    let len_unit = w.add("IFCSIUNIT", format!("*,{},$,{}", enum_("LENGTHUNIT"), enum_("METRE")));
    let area_unit = w.add("IFCSIUNIT", format!("*,{},$,{}", enum_("AREAUNIT"), enum_("SQUARE_METRE")));
    let vol_unit = w.add("IFCSIUNIT", format!("*,{},$,{}", enum_("VOLUMEUNIT"), enum_("CUBIC_METRE")));
    let angle_unit = w.add("IFCSIUNIT", format!("*,{},$,{}", enum_("PLANEANGLEUNIT"), enum_("RADIAN")));
    let unit_assignment = w.add(
        "IFCUNITASSIGNMENT",
        refs(&[len_unit, area_unit, vol_unit, angle_unit]),
    );

    // Geometrischer Kontext (3D, Precision 1e-5).
    w.context = w.add(
        "IFCGEOMETRICREPRESENTATIONCONTEXT",
        format!("$,{},3,{},#{},$", ifc_string("Model"), fmt_real(0.00001), w.identity_axis),
    );

    // Georeferenz: Geometrie liegt schon in LV95-Weltkoordinaten (TS), die Abbildung ist die Identität;
    // das Koordinatensystem wird trotzdem deklariert (IFC4 IfcProjectedCRS + IfcMapConversion).
    if has_geo {
        let crs = w.add(
            "IFCPROJECTEDCRS",
            format!(
                "{},{},{},$,{},$,#{len_unit}",
                ifc_string("EPSG:2056"),
                ifc_string("CH1903+ / LV95"),
                ifc_string("CH1903+"),
                ifc_string("Swiss Oblique Mercator")
            ),
        );
        w.add(
            "IFCMAPCONVERSION",
            format!(
                "#{},#{crs},{},{},{},{},{},{}",
                w.context,
                fmt_real(0.0),
                fmt_real(0.0),
                fmt_real(0.0),
                fmt_real(1.0),
                fmt_real(0.0),
                fmt_real(1.0)
            ),
        );
    }

    // Räumliche Hierarchie: Project → Site → Building → Storeys.
    let site_axis = w.add("IFCAXIS2PLACEMENT3D", format!("#{origin},$,$"));
    let site_placement = w.add("IFCLOCALPLACEMENT", format!("$,#{site_axis}"));
    let building_axis = w.add("IFCAXIS2PLACEMENT3D", format!("#{origin},$,$"));
    w.building_placement = w.add("IFCLOCALPLACEMENT", format!("#{site_placement},#{building_axis}"));

    let g = w.gid("project");
    let project_entity = w.add(
        "IFCPROJECT",
        format!(
            "{g},#{},{},$,$,$,$,{},#{unit_assignment}",
            w.owner_history,
            ifc_string(&pname("Projekt")),
            refs(&[w.context])
        ),
    );
    // RefElevation (m ü. M.): rein informativ, die Geometrie wird nicht verschoben.
    let site_ref_elev = if ref_elevation.is_finite() { fmt_real(ref_elevation) } else { "$".to_string() };
    let g = w.gid("site");
    let site_entity = w.add(
        "IFCSITE",
        format!(
            "{g},#{},{},$,$,#{site_placement},$,$,{},$,$,{site_ref_elev},$,$",
            w.owner_history,
            ifc_string("Standort"),
            enum_("ELEMENT")
        ),
    );
    let g = w.gid("building");
    w.building_entity = w.add(
        "IFCBUILDING",
        format!(
            "{g},#{},{},$,$,#{},$,$,{},$,$,$",
            w.owner_history,
            ifc_string(&pname("Gebäude")),
            w.building_placement,
            enum_("ELEMENT")
        ),
    );
    let g = w.gid("aggregates/site");
    w.add(
        "IFCRELAGGREGATES",
        format!("{g},#{},$,$,#{project_entity},{}", w.owner_history, refs(&[site_entity])),
    );
    let g = w.gid("aggregates/building");
    w.add(
        "IFCRELAGGREGATES",
        format!("{g},#{},$,$,#{site_entity},{}", w.owner_history, refs(&[w.building_entity])),
    );

    // Je Geschoss ein IfcBuildingStorey (Elevation = base).
    let mut storey_entities = Vec::new();
    for (id, name, base) in storey_defs {
        let pt = w.add("IFCCARTESIANPOINT", list(&[fmt_real(0.0), fmt_real(0.0), fmt_real(base)]));
        let axis = w.add("IFCAXIS2PLACEMENT3D", format!("#{pt},$,$"));
        let placement = w.add("IFCLOCALPLACEMENT", format!("#{},#{axis}", w.building_placement));
        let g = w.gid(&format!("storey/{id}"));
        let entity = w.add(
            "IFCBUILDINGSTOREY",
            format!(
                "{g},#{},{},$,$,#{placement},$,$,{},{}",
                w.owner_history,
                ifc_string(&name),
                enum_("ELEMENT"),
                fmt_real(base)
            ),
        );
        w.storeys.push(Storey { id, entity, placement });
        storey_entities.push(entity);
    }
    if !storey_entities.is_empty() {
        let g = w.gid("aggregates/storeys");
        w.add(
            "IFCRELAGGREGATES",
            format!("{g},#{},$,$,#{},{}", w.owner_history, w.building_entity, refs(&storey_entities)),
        );
    }

    // ── Datensätze ──
    while !r.done() {
        let code = r.raw()?;
        match code {
            c if c == REC_WALL_SOLIDS => {
                let structure = r.structure(n_storeys)?;
                let id = r.string()?;
                let name = r.string()?;
                let ty = r.type_ref()?;
                let psets = r.psets()?;
                let has_frame = r.flag()?;
                let (frame, axis_len, usage, offset) = if has_frame {
                    let (ox, oy, ux, uy) = (r.f()?, r.f()?, r.f()?, r.f()?);
                    if ((ux * ux + uy * uy) - 1.0).abs() > 1e-6 {
                        return Err(format!("Achsrichtung nicht normiert bei {}", r.pos - 1));
                    }
                    let (len, usage, offset) = (r.f()?, r.flag()?, r.f()?);
                    (Frame { ox, oy, ux, uy }, len, usage, offset)
                } else {
                    (Frame::WORLD, 0.0, false, 0.0)
                };
                let n = r.idx()?;
                let mut solids = Vec::new();
                for _ in 0..n {
                    let pts = frame.local_pts(&r.pts()?);
                    let z_rel = r.f()?;
                    let depth = r.f()?;
                    solids.push(w.emit_extrusion(&pts, z_rel, depth));
                }
                let parent = w.placement_of(structure);
                let (placement, shape) = if has_frame {
                    (w.emit_placement_frame(&frame, parent), w.emit_wall_shape(&solids, axis_len))
                } else {
                    (w.emit_placement(0.0, parent), w.emit_swept_shape(&solids))
                };
                let entity = w.finish_typed("IFCWALL", format!("wall/{id}"), &name, &ty, &psets, structure, placement, shape, None, true);
                if has_frame && usage {
                    // Schichten des Typs der Wandachse zuordnen: erste Schicht (aussen) liegt bei `offset`
                    // von der Achse, die übrigen folgen in +Y (linke Normale).
                    let set = ty.as_ref().and_then(|t| w.layer_set_of(t));
                    if let Some(set) = set {
                        let u = w.add(
                            "IFCMATERIALLAYERSETUSAGE",
                            format!("#{set},{},{},{},$", enum_("AXIS2"), enum_("POSITIVE"), fmt_real(offset)),
                        );
                        let g = w.gid(&format!("wall/{id}/material"));
                        w.add(
                            "IFCRELASSOCIATESMATERIAL",
                            format!("{g},#{},$,$,{},#{u}", w.owner_history, refs(&[entity])),
                        );
                    }
                }
                w.walls.insert(id, (entity, placement, frame));
            }
            c if c == REC_WALL_MESH => {
                let structure = r.structure(n_storeys)?;
                let id = r.string()?;
                let name = r.string()?;
                let ty = r.type_ref()?;
                let psets = r.psets()?;
                let mesh = r.mesh()?;
                let (placement, shape) = w.emit_triangulated_product(&mesh, w.placement_of(structure));
                let entity = w.finish_typed("IFCWALL", format!("wall/{id}"), &name, &ty, &psets, structure, placement, shape, None, true);
                w.walls.insert(id, (entity, placement, Frame::WORLD));
            }
            c if c == REC_CEILING => {
                let structure = r.structure(n_storeys)?;
                let id = r.string()?;
                let name = r.string()?;
                let ty = r.type_ref()?;
                let psets = r.psets()?;
                let pts = r.pts()?;
                let z_rel = r.f()?;
                let depth = r.f()?;
                let (placement, shape) = w.emit_box_product(&pts, z_rel, depth, w.placement_of(structure));
                w.finish_typed("IFCSLAB", format!("slab/{id}"), &name, &ty, &psets, structure, placement, shape, Some(enum_("FLOOR")), true);
            }
            c if c == REC_OPENING => {
                let wall_id = r.string()?;
                let structure = r.structure(n_storeys)?;
                let opening_id = r.string()?;
                let is_door = r.flag()?;
                let fill_name = r.string()?;
                let void_pts = r.pts()?;
                let void_z = r.f()?;
                let depth = r.f()?;
                let width = r.f()?;
                let fill = fill_geometry(&r.fill_params(is_door)?);
                let (kind, parts) = (fill.kind, fill.parts);
                let ((fox, foy), (fux, fuy)) = (fill.origin, fill.u);
                if ((fux * fux + fuy * fuy) - 1.0).abs() > 1e-6 || !(fox.is_finite() && foy.is_finite()) {
                    return Err(format!("Füllungsrichtung nicht normiert bei {}", r.pos - 1));
                }
                if parts.iter().any(|p| !(p.z_rel.is_finite() && p.depth.is_finite() && p.pts.iter().all(|q| q.0.is_finite() && q.1.is_finite()))) {
                    return Err(format!("Füllung mit NaN/∞ bei {}", r.pos - 1));
                }
                let fill_frame = Frame { ox: fox, oy: foy, ux: fux, uy: fuy };
                let psets = r.psets()?;
                let Some(&(host_entity, host_placement, host_frame)) = w.walls.get(&wall_id) else {
                    continue; // Wirtswand nicht geschrieben (degeneriert)
                };
                // Die Geometrie kommt in Welt-XY; Wände mit eigenem Placement rechnen wir ins Wandsystem.
                let void_pts = if host_frame.is_world() { void_pts } else { host_frame.local_pts(&void_pts) };
                let (opening_placement, opening_shape) = w.emit_box_product(&void_pts, void_z, depth, host_placement);
                let g = w.gid(&format!("opening/{opening_id}"));
                let opening_entity = w.add(
                    "IFCOPENINGELEMENT",
                    format!(
                        "{g},#{},{},$,$,#{opening_placement},#{opening_shape},$,{}",
                        w.owner_history,
                        ifc_string(if is_door { "Türöffnung" } else { "Fensteröffnung" }),
                        enum_("OPENING")
                    ),
                );
                let g = w.gid(&format!("voids/{opening_id}"));
                w.add(
                    "IFCRELVOIDSELEMENT",
                    format!("{g},#{},$,$,#{host_entity},#{opening_entity}", w.owner_history),
                );
                // Füllung: eigenes Placement (Ursprung/Richtung aus dem Modell, relativ zur Öffnung = zur Wand),
                // Körper in diesem System; ohne Teile (reine Wandöffnung) keine Darstellung.
                let fill_placement = w.emit_placement_frame(&fill_frame.relative_to(&host_frame), opening_placement);
                let fill_shape = if parts.is_empty() { "$".to_string() } else { format!("#{}", w.emit_parts_shape(&parts, &fill_frame)) };
                let g = w.gid(&format!("fill/{opening_id}"));
                let operation = kind.map(enum_).unwrap_or_else(|| "$".to_string());
                let fill_entity = w.add(
                    if is_door { "IFCDOOR" } else { "IFCWINDOW" },
                    format!(
                        "{g},#{},{},$,$,#{fill_placement},{fill_shape},$,{},{},{},{operation},$",
                        w.owner_history,
                        ifc_string(&fill_name),
                        fmt_real(depth),
                        fmt_real(width),
                        enum_(if is_door { "DOOR" } else { "WINDOW" })
                    ),
                );
                let g = w.gid(&format!("fills/{opening_id}"));
                w.add(
                    "IFCRELFILLSELEMENT",
                    format!("{g},#{},$,$,#{opening_entity},#{fill_entity}", w.owner_history),
                );
                w.add_to_containment(structure, fill_entity);
                for p in &psets {
                    w.add_pset(p, fill_entity);
                }
            }
            c if c == REC_STAIR => {
                let structure = r.structure(n_storeys)?;
                let id = r.string()?;
                let predefined = r.string()?;
                let pts = r.pts()?;
                let z_rel = r.f()?;
                let depth = r.f()?;
                let (placement, shape) = w.emit_box_product(&pts, z_rel, depth, w.placement_of(structure));
                let g = w.gid(&format!("stair/{id}"));
                let entity = w.emit_building_element("IFCSTAIR", g, "Treppe", placement, shape, Some(enum_(&predefined)));
                w.add_to_containment(structure, entity);
            }
            c if c == REC_EXTRUSION => {
                let structure = r.structure(n_storeys)?;
                let id = r.string()?;
                let pts = r.pts()?;
                let z_rel = r.f()?;
                let depth = r.f()?;
                let (placement, shape) = w.emit_box_product(&pts, z_rel, depth, w.placement_of(structure));
                let g = w.gid(&format!("extrusion/{id}"));
                let entity = w.emit_building_element("IFCBUILDINGELEMENTPROXY", g, "Extrusion", placement, shape, None);
                w.add_to_containment(structure, entity);
            }
            c if c == REC_SPACE => {
                let structure = r.structure(n_storeys)?;
                let id = r.string()?;
                let name = r.string()?;
                let long_name = r.string()?;
                let external = r.flag()?;
                let height = r.f()?;
                let pts = r.pts()?;
                let net = r.f()?;
                let gross = r.f()?;
                let sia = r.string()?;
                let psets = r.psets()?;
                let (placement, shape) = w.emit_box_product(&pts, 0.0, height, w.placement_of(structure));
                let g = w.gid(&format!("space/{id}"));
                let space = w.add(
                    "IFCSPACE",
                    format!(
                        "{g},#{},{},$,$,#{placement},#{shape},{},{},{},$",
                        w.owner_history,
                        ifc_string(&name),
                        ifc_string(&long_name),
                        enum_("ELEMENT"),
                        enum_(if external { "EXTERNAL" } else { "INTERNAL" })
                    ),
                );
                if let Some((_, v)) = w.spaces.iter_mut().find(|(s, _)| *s == structure) {
                    v.push(space);
                } else {
                    w.spaces.push((structure, vec![space]));
                }
                let q_net = w.add("IFCQUANTITYAREA", format!("{},$,$,{},$", ifc_string("NetFloorArea"), fmt_real(net)));
                let q_gross = w.add("IFCQUANTITYAREA", format!("{},$,$,{},$", ifc_string("GrossFloorArea"), fmt_real(gross)));
                let q_height = w.add("IFCQUANTITYLENGTH", format!("{},$,$,{},$", ifc_string("Height"), fmt_real(height)));
                let g = w.gid(&format!("space/{id}/qto"));
                let qto = w.add(
                    "IFCELEMENTQUANTITY",
                    format!(
                        "{g},#{},{},$,$,{}",
                        w.owner_history,
                        ifc_string("Qto_SpaceBaseQuantities"),
                        refs(&[q_net, q_gross, q_height])
                    ),
                );
                let g = w.gid(&format!("space/{id}/qto-rel"));
                w.add(
                    "IFCRELDEFINESBYPROPERTIES",
                    format!("{g},#{},$,$,{},#{qto}", w.owner_history, refs(&[space])),
                );
                let sia_prop = w.add(
                    "IFCPROPERTYSINGLEVALUE",
                    format!("{},$,IFCLABEL({}),$", ifc_string("SIA416"), ifc_string(&sia)),
                );
                let g = w.gid(&format!("space/{id}/pset"));
                let pset = w.add(
                    "IFCPROPERTYSET",
                    format!("{g},#{},{},$,{}", w.owner_history, ifc_string("CH_Raum"), refs(&[sia_prop])),
                );
                let g = w.gid(&format!("space/{id}/pset-rel"));
                w.add(
                    "IFCRELDEFINESBYPROPERTIES",
                    format!("{g},#{},$,$,{},#{pset}", w.owner_history, refs(&[space])),
                );
                for p in &psets {
                    w.add_pset(p, space);
                }
            }
            c if c == REC_END_SPACES => {
                let spaces = std::mem::take(&mut w.spaces);
                for (structure, ids) in spaces {
                    let g = w.gid(&format!("aggregates/spaces/{}", w.key_of(structure)));
                    w.add(
                        "IFCRELAGGREGATES",
                        format!("{g},#{},$,$,#{},{}", w.owner_history, w.entity_of(structure), refs(&ids)),
                    );
                }
            }
            c if c == REC_ROOF => {
                let structure = r.structure(n_storeys)?;
                let id = r.string()?;
                let name = r.string()?;
                let predefined = r.string()?;
                let ty = r.type_ref()?;
                let psets = r.psets()?;
                let mesh = r.mesh()?;
                let (placement, shape) = w.emit_triangulated_product(&mesh, w.placement_of(structure));
                w.finish_typed("IFCROOF", format!("roof/{id}"), &name, &ty, &psets, structure, placement, shape, Some(enum_(&predefined)), false);
            }
            c if c == REC_COLUMN => {
                let structure = r.structure(n_storeys)?;
                let id = r.string()?;
                let label = r.string()?;
                let pts = r.pts()?;
                let z_rel = r.f()?;
                let depth = r.f()?;
                let component = r.opt_string()?;
                let component_name = r.opt_string()?;
                let psets = r.psets()?;
                let (placement, shape) = w.emit_box_product(&pts, z_rel, depth, w.placement_of(structure));
                let g = w.gid(&format!("column/{id}"));
                let entity = w.emit_building_element("IFCCOLUMN", g, &label, placement, shape, Some(enum_("COLUMN")));
                w.add_to_containment(structure, entity);
                for p in &psets {
                    w.add_pset(p, entity);
                }
                if let Some(cid) = component {
                    if let Some((_, _, v)) = w.column_materials.iter_mut().find(|(c, _, _)| *c == cid) {
                        v.push(entity);
                    } else {
                        let nm = component_name.unwrap_or_else(|| cid.clone());
                        w.column_materials.push((cid, nm, vec![entity]));
                    }
                }
            }
            c if c == REC_END_COLUMNS => {
                let mats = std::mem::take(&mut w.column_materials);
                for (cid, name, ids) in mats {
                    let g = w.gid(&format!("material/{cid}/columns"));
                    let material = w.material_of(&cid, &name);
                    w.add(
                        "IFCRELASSOCIATESMATERIAL",
                        format!("{g},#{},$,$,{},#{material}", w.owner_history, refs(&ids)),
                    );
                }
            }
            other => return Err(format!("unbekannter Datensatz {other} ({}) bei {}", rec_name(other), r.pos - 1)),
        }
    }

    // ── Typ-Zuordnung (je Bauteiltyp eine IfcRelDefinesByType) ──
    let types = std::mem::take(&mut w.types);
    for t in &types {
        if t.occurrences.is_empty() {
            continue;
        }
        let g = w.gid(&format!("{}/occurrences", t.key));
        w.add(
            "IFCRELDEFINESBYTYPE",
            format!("{g},#{},$,$,{},#{}", w.owner_history, refs(&t.occurrences), t.type_id),
        );
    }

    // ── Eigenschaftssätze ──
    let psets = std::mem::take(&mut w.psets);
    for ps in &psets {
        let mut prop_ids = Vec::new();
        for (n, v) in &ps.props {
            prop_ids.push(w.add("IFCPROPERTYSINGLEVALUE", format!("{},$,{v},$", ifc_string(n))));
        }
        let g = w.gid(&format!("pset/{}", ps.key));
        let pset_id = w.add(
            "IFCPROPERTYSET",
            format!("{g},#{},{},$,{}", w.owner_history, ifc_string(&ps.name), refs(&prop_ids)),
        );
        let g = w.gid(&format!("pset/{}/rel", ps.key));
        w.add(
            "IFCRELDEFINESBYPROPERTIES",
            format!("{g},#{},$,$,{},#{pset_id}", w.owner_history, refs(&ps.related)),
        );
    }

    // ── Räumliche Eingliederung (gebündelt je Trägerstruktur) ──
    let containment = std::mem::take(&mut w.containment);
    for (structure, ids) in &containment {
        let g = w.gid(&format!("contains/{}", w.key_of(*structure)));
        w.add(
            "IFCRELCONTAINEDINSPATIALSTRUCTURE",
            format!("{g},#{},$,$,{},#{}", w.owner_history, refs(ids), w.entity_of(*structure)),
        );
    }

    // ── Kopf + Zusammenbau ──
    let file_name = format!("{}.ifc", pname("modell"));
    let mut out = String::with_capacity(w.lines.iter().map(|l| l.len() + 1).sum::<usize>() + 512);
    out.push_str("ISO-10303-21;\nHEADER;\n");
    out.push_str(&format!("FILE_DESCRIPTION({},{});\n", list(&[ifc_string("")]), ifc_string("2;1")));
    out.push_str(&format!(
        "FILE_NAME({},{},{},{},{},{},{});\n",
        ifc_string(&file_name),
        ifc_string(&iso),
        list(&[ifc_string("dossier")]),
        list(&[ifc_string("dossier")]),
        ifc_string("dossier"),
        ifc_string("dossier"),
        ifc_string("")
    ));
    out.push_str("FILE_SCHEMA(('IFC4'));\nENDSEC;\n\nDATA;\n");
    for l in &w.lines {
        out.push_str(l);
        out.push('\n');
    }
    out.push_str("ENDSEC;\nEND-ISO-10303-21;\n");
    Ok(out)
}

// ---------------------------------------------------------------------------
// WASM-Fassade (nur bei Feature "web")
// ---------------------------------------------------------------------------

#[cfg(feature = "web")]
mod wasm {
    use wasm_bindgen::prelude::*;

    /// Flache Bauteilliste → IFC4-Text (STEP); leer bei kaputtem Puffer (Grund: `export_ifc_check_flat`).
    #[wasm_bindgen]
    pub fn export_ifc_flat(flat: &[f64], strings: &str) -> String {
        super::build_ifc(flat, strings).unwrap_or_default()
    }

    /// Fehlertext zur Eingabe (leer = in Ordnung) — für Meldungen auf der TS-Seite.
    #[wasm_bindgen]
    pub fn export_ifc_check_flat(flat: &[f64], strings: &str) -> String {
        match super::build_ifc(flat, strings) {
            Ok(_) => String::new(),
            Err(e) => e,
        }
    }

    /// Deterministische 22-stellige IFC-GUID aus einem Namen.
    #[wasm_bindgen]
    pub fn ifc_guid(name: &str) -> String {
        super::ifc_guid(name)
    }

    /// STEP-String-Literal (mit Apostrophen, `\X2\`/`\X4\` für Nicht-ASCII).
    #[wasm_bindgen]
    pub fn ifc_string(s: &str) -> String {
        super::ifc_string(s)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strings_wie_ts() {
        assert_eq!(ifc_string("Gebäude"), "'Geb\\X2\\00E4\\X0\\ude'");
        assert_eq!(ifc_string("Grösse Ü"), "'Gr\\X2\\00F6\\X0\\sse \\X2\\00DC\\X0\\'");
        assert_eq!(ifc_string("it's a\\b"), "'it''s a\\\\b'");
        assert_eq!(ifc_string("äö"), "'\\X2\\00E400F6\\X0\\'");
        assert_eq!(ifc_string("a😀"), "'a\\X4\\0001F600\\X0\\'");
        assert_eq!(ifc_string("a\nb"), "'a\\X2\\000A\\X0\\b'");
        assert_eq!(ifc_string(""), "''");
        // BMP und Ausserhalb im selben Lauf: neuer Block bei Breitenwechsel.
        assert_eq!(ifc_string("ä😀"), "'\\X2\\00E4\\X0\\\\X4\\0001F600\\X0\\'");
    }

    #[test]
    fn reals_wie_tofixed() {
        assert_eq!(fmt_real(0.0), "0.0");
        assert_eq!(fmt_real(-0.0), "0.0");
        assert_eq!(fmt_real(1.0), "1.0");
        assert_eq!(fmt_real(100.0), "100.0");
        assert_eq!(fmt_real(0.00001), "0.00001");
        assert_eq!(fmt_real(-2.5), "-2.5");
        assert_eq!(fmt_real(0.1 + 0.2), "0.3");
        assert_eq!(fmt_real(2.6), "2.6");
        assert_eq!(fmt_real(-1e-9), "-0.0");
        assert_eq!(fmt_real(1e-9), "0.0");
        assert_eq!(fmt_real(0.999_999_6), "1.0");
        assert_eq!(fmt_real(2_600_000.123_456_7), "2600000.123457");
        // Gleichstand (exakt darstellbar): toFixed rundet auf, nicht auf gerade.
        assert_eq!(fmt_real(0.007_812_5), "0.007813");
        assert_eq!(fmt_real(0.023_437_5), "0.023438");
        assert_eq!(fmt_real(-0.007_812_5), "-0.007813");
        // Sehr grosse Werte (Langpfad).
        assert_eq!(fmt_real(1e15), "1000000000000000.0");
        assert_eq!(fmt_real(f64::NAN), "0.0");
    }

    #[test]
    fn guid_wie_ts() {
        // Werte aus der TS-Fassung (Golden vom 28.10., Projekt-id "t").
        assert_eq!(ifc_guid("t/project"), "2fgJPaxQwDyuZfE6V6_Rif");
        assert_eq!(ifc_guid("t/site"), "3rG4QSmdUCaBHFz1QMCvjw");
        assert_eq!(ifc_guid("t/wall/W1"), "0n_zVrPdE0cg_UxWSd1GmA");
        assert_eq!(ifc_guid("t/wall/W1"), ifc_guid("t/wall/W1"));
        assert_ne!(ifc_guid("t/wall/W1"), ifc_guid("t/wall/W2"));
    }

    /// Baut flache Puffer für die Tests (Gegenstück zu `FlatIfc` in `exportIfc.ts`).
    struct B {
        f: Vec<f64>,
        s: Vec<String>,
    }
    impl B {
        fn new() -> Self {
            B { f: vec![FLAT_VERSION], s: Vec::new() }
        }
        fn s(&mut self, x: &str) -> f64 {
            self.s.push(x.to_string());
            (self.s.len() - 1) as f64
        }
        fn n(&mut self, v: &[f64]) {
            self.f.extend_from_slice(v);
        }
        fn str(&mut self, x: &str) {
            let i = self.s(x);
            self.f.push(i);
        }
        fn pts(&mut self, p: &[(f64, f64)]) {
            self.f.push(p.len() as f64);
            for (x, y) in p {
                self.f.extend([*x, *y]);
            }
        }
        fn no_type(&mut self) {
            self.f.push(0.0);
        }
        /// OPENING-Datensatz (Gegenstück zu `FlatIfc.opening`), Füllung als Parameter.
        #[allow(clippy::too_many_arguments)]
        fn opening(&mut self, wall: &str, id: &str, is_door: bool, name: &str, void_pts: &[(f64, f64)], void_z: f64, depth: f64, width: f64, fill: &FillParams) {
            self.n(&[REC_OPENING]);
            self.str(wall);
            self.n(&[-1.0]);
            self.str(id);
            self.n(&[if is_door { 1.0 } else { 0.0 }]);
            self.str(name);
            self.pts(void_pts);
            self.n(&[void_z, depth, width]);
            self.fill(fill);
            self.no_psets();
        }
        fn opt(&mut self, v: Option<f64>) {
            self.n(&[if v.is_some() { 1.0 } else { 0.0 }, v.unwrap_or(0.0)]);
        }
        fn fill(&mut self, p: &FillParams) {
            self.n(&[p.wall_start.0, p.wall_start.1, p.wall_end.0, p.wall_end.1, p.from, p.to, p.z_bottom, p.z_top, p.n_lo, p.n_hi]);
            self.opt(p.frame_depth);
            self.opt(p.inset);
            self.n(&[if p.inset_outside { 1.0 } else { 0.0 }]);
            self.opt(p.frame_width);
            self.n(&[p.wing_count, p.panes as f64, p.sashes.len() as f64]);
            for s in &p.sashes {
                self.n(&[if s.post { 1.0 } else { 0.0 }]);
                self.opt(s.post_width);
                self.n(&[if s.fixed { 1.0 } else { 0.0 }]);
                self.opt(s.width);
            }
            let k = match p.door_kind {
                DoorKind::Swing => 0.0,
                DoorKind::Sliding => 1.0,
                DoorKind::WallOpening => 2.0,
            };
            self.n(&[k, p.leaf_count, p.swing_sign, p.dir_sign, if p.hinge_at_start { 1.0 } else { 0.0 }, p.transom_height]);
            self.n(&[if p.glazed { 1.0 } else { 0.0 }]);
            self.opt(p.glazing_ratio);
        }
        fn wall_type(&mut self) {
            self.n(&[1.0, 0.0]);
            self.str("T1");
            self.str("Aussenwand");
            self.str("STANDARD");
            self.f.push(2.0);
            for (c, name, t) in [("c1", "Beton", 0.2), ("c2", "Dämmung", 0.12)] {
                self.str(c);
                self.str(name);
                self.f.push(t);
            }
        }
        fn ref_pset(&mut self, set: &str, v: &str) {
            self.f.push(1.0);
            self.str(set);
            self.f.push(1.0);
            self.str("Reference");
            self.f.push(0.0);
            self.str(v);
        }
        fn no_psets(&mut self) {
            self.f.push(0.0);
        }
        fn mesh_tetra(&mut self) {
            self.n(&[4.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0]);
            self.n(&[4.0, 0.0, 2.0, 1.0, 0.0, 1.0, 3.0, 1.0, 2.0, 3.0, 2.0, 0.0, 3.0]);
            self.f.push(1.0);
        }
        fn data(&self) -> (&[f64], String) {
            (&self.f, self.s.join("\0"))
        }
    }

    const SQUARE: [(f64, f64); 4] = [(0.0, 0.0), (5.0, 0.0), (5.0, 0.4), (0.0, 0.4)];

    /// Ein Projekt mit je einem Bauteil jeder Art; zwei Wände gleichen Typs (Pset/Typ müssen sich teilen).
    /// Füllungs-Parameter: Wand (sx, sy) → (ex, ey), Achs-Intervall, Höhen, Dicke ±0.2.
    fn fill(is_door: bool, wall: [f64; 4], from: f64, to: f64, z0: f64, z1: f64) -> FillParams {
        FillParams {
            wall_start: (wall[0], wall[1]),
            wall_end: (wall[2], wall[3]),
            from,
            to,
            z_bottom: z0,
            z_top: z1,
            n_lo: -0.2,
            n_hi: 0.2,
            is_door,
            inset_outside: true,
            wing_count: 1.0,
            panes: 2,
            leaf_count: 1.0,
            swing_sign: 1.0,
            dir_sign: 1.0,
            hinge_at_start: true,
            ..Default::default()
        }
    }

    fn full_house(with_geo: bool) -> B {
        let mut b = B::new();
        b.str("t");
        b.str("Haus Ä");
        b.n(&[1_700_000_000.0]);
        b.str("2026-10-28T12:00:00");
        b.n(&[if with_geo { 1.0 } else { 0.0 }, if with_geo { 421.5 } else { f64::NAN }, 1.0]);
        b.str("eg");
        b.str("Erdgeschoss");
        b.n(&[0.0]);
        for wid in ["W1", "W2"] {
            b.n(&[REC_WALL_SOLIDS, 0.0]);
            b.str(wid);
            b.str("Aussenwand");
            b.wall_type();
            b.ref_pset("Pset_WallCommon", "Aussenwand");
            // W1 mit Wandsystem (Achse, LayerSetUsage), W2 ohne (altes Verhalten).
            if wid == "W1" {
                b.n(&[1.0, 0.0, 0.0, 1.0, 0.0, 5.0, 1.0, -0.2]);
            } else {
                b.n(&[0.0]);
            }
            b.n(&[1.0]);
            b.pts(&SQUARE);
            b.n(&[0.0, 2.6]);
        }
        // Öffnung in W1: Tür mit Zarge, Blatt und Glas.
        // Scharnier am Ende, Aufschlag nach +Y: LEFT; Oberlicht gibt Glas.
        b.opening(
            "W1", "T1", true, "Haustür",
            &[(1.0, -0.02), (1.9, -0.02), (1.9, 0.42), (1.0, 0.42)], 0.0, 2.1, 0.9,
            &FillParams { hinge_at_start: false, transom_height: 0.4, ..fill(true, [0.0, 0.0, 5.0, 0.0], 1.0, 1.9, 0.0, 2.1) },
        );
        // Decke, Treppe, Extrusion.
        b.n(&[REC_CEILING, 0.0]);
        b.str("D1");
        b.str("Decke");
        b.no_type();
        b.no_psets();
        b.pts(&SQUARE);
        b.n(&[2.6, 0.2]);
        b.n(&[REC_STAIR, 0.0]);
        b.str("S1");
        b.str("STRAIGHT_RUN_STAIR");
        b.pts(&SQUARE);
        b.n(&[0.0, 2.6]);
        b.n(&[REC_EXTRUSION, -1.0]);
        b.str("X1");
        b.pts(&SQUARE);
        b.n(&[0.0, 1.0]);
        // Raum.
        b.n(&[REC_SPACE, 0.0]);
        b.str("R1");
        b.str("101");
        b.str("Wohnen");
        b.n(&[0.0, 2.5]);
        b.pts(&SQUARE);
        b.n(&[1.9, 2.0]);
        b.str("HNF");
        b.f.push(1.0);
        b.str("Pset_SpaceCommon");
        b.f.push(2.0);
        b.str("Reference");
        b.f.push(0.0);
        b.str("101");
        b.str("IsExternal");
        b.n(&[1.0, 0.0]);
        b.n(&[REC_END_SPACES]);
        // Dach mit Typ.
        b.n(&[REC_ROOF, 0.0]);
        b.str("Ro1");
        b.str("Satteldach");
        b.str("GABLE_ROOF");
        b.n(&[1.0, 2.0]);
        b.str("RT1");
        b.str("Satteldach");
        b.str("GABLE_ROOF");
        b.n(&[1.0]);
        b.str("c1");
        b.str("Beton");
        b.n(&[0.3]);
        b.ref_pset("Pset_RoofCommon", "Satteldach");
        b.mesh_tetra();
        // Stütze mit Material.
        b.n(&[REC_COLUMN, 0.0]);
        b.str("C1");
        b.str("Stütze 30");
        b.pts(&SQUARE);
        b.n(&[0.0, 2.6]);
        b.str("c1");
        b.str("Beton");
        b.ref_pset("Pset_ColumnCommon", "Stütze 30");
        b.n(&[REC_END_COLUMNS]);
        b
    }

    fn build(b: &B) -> Result<String, String> {
        let (f, s) = b.data();
        build_ifc(f, &s)
    }

    /// Jede `#n` ist definiert, keine Nummer doppelt, Nummern lückenlos ab 1.
    fn check_structure(ifc: &str) {
        let mut defined = std::collections::HashSet::new();
        let mut order = Vec::new();
        for line in ifc.lines() {
            if let Some(rest) = line.strip_prefix('#') {
                let (num, _) = rest.split_once('=').expect("Entity ohne =");
                let n: usize = num.parse().expect("Nummer");
                assert!(defined.insert(n), "doppelte Nummer #{n}");
                order.push(n);
            }
        }
        assert!(order.iter().copied().eq(1..=order.len()), "Nummern nicht lückenlos");
        for line in ifc.lines().filter(|l| l.starts_with('#')) {
            let body = line.split_once('=').unwrap().1;
            let mut chars = body.chars().peekable();
            let mut in_str = false;
            while let Some(c) = chars.next() {
                if c == '\'' {
                    in_str = !in_str;
                } else if c == '#' && !in_str {
                    let mut num = String::new();
                    while let Some(&d) = chars.peek() {
                        if d.is_ascii_digit() {
                            num.push(d);
                            chars.next();
                        } else {
                            break;
                        }
                    }
                    let n: usize = num.parse().expect("Referenz");
                    assert!(defined.contains(&n), "hängende Referenz #{n} in {line}");
                }
            }
        }
    }

    fn count(ifc: &str, ty: &str) -> usize {
        let head = format!("{ty}(");
        ifc.lines().filter(|l| l.split_once('=').is_some_and(|(_, b)| b.starts_with(&head))).count()
    }

    #[test]
    fn volles_haus_ist_wohlgeformt() {
        let ifc = build(&full_house(true)).unwrap();
        assert!(ifc.starts_with("ISO-10303-21;\nHEADER;\n"));
        assert!(ifc.contains("FILE_SCHEMA(('IFC4'));"));
        assert!(ifc.ends_with("ENDSEC;\nEND-ISO-10303-21;\n"));
        assert!(ifc.is_ascii(), "Datei muss reines ASCII sein");
        check_structure(&ifc);
        assert_eq!(count(&ifc, "IFCWALL"), 2);
        assert_eq!(count(&ifc, "IFCSLAB"), 1);
        assert_eq!(count(&ifc, "IFCROOF"), 1);
        assert_eq!(count(&ifc, "IFCCOLUMN"), 1);
        assert_eq!(count(&ifc, "IFCSTAIR"), 1);
        assert_eq!(count(&ifc, "IFCSPACE"), 1);
        assert_eq!(count(&ifc, "IFCDOOR"), 1);
        assert_eq!(count(&ifc, "IFCOPENINGELEMENT"), 1);
        assert_eq!(count(&ifc, "IFCRELVOIDSELEMENT"), 1);
        assert_eq!(count(&ifc, "IFCRELFILLSELEMENT"), 1);
        assert_eq!(count(&ifc, "IFCBUILDINGELEMENTPROXY"), 1);
        assert_eq!(count(&ifc, "IFCBUILDINGSTOREY"), 1);
        assert_eq!(count(&ifc, "IFCPROJECTEDCRS"), 1);
        assert_eq!(count(&ifc, "IFCMAPCONVERSION"), 1);
        assert!(ifc.contains(",421.5,$,$);"), "RefElevation");
        assert!(ifc.contains("'Haus \\X2\\00C4\\X0\\'"));
        // Gleiche Wandtypen teilen Typ, Materialschichten und Pset.
        assert_eq!(count(&ifc, "IFCWALLTYPE"), 1);
        assert_eq!(count(&ifc, "IFCMATERIALLAYERSET"), 2); // Wandtyp + Dachtyp
        assert_eq!(count(&ifc, "IFCMATERIAL"), 2); // Beton (geteilt mit Dachtyp und Stütze) + Dämmung
        assert_eq!(count(&ifc, "IFCRELDEFINESBYTYPE"), 2);
        assert_eq!(count(&ifc, "IFCPROPERTYSET"), 5); // Wall, Space, Roof, Column + CH_Raum (Tür ohne Pset)
        // Eingliederung: Geschoss (Wände, Decke, Treppe, Tür, Dach, Stütze) und Gebäude (Extrusion).
        assert_eq!(count(&ifc, "IFCRELCONTAINEDINSPATIALSTRUCTURE"), 2);
        // Project→Site, Site→Building, Building→Storeys, Geschoss→Räume.
        assert_eq!(count(&ifc, "IFCRELAGGREGATES"), 4);
    }

    /// Zeile der ersten Entität eines Typs.
    fn first_line<'a>(ifc: &'a str, ty: &str) -> &'a str {
        let head = format!("{ty}(");
        ifc.lines().find(|l| l.split_once('=').is_some_and(|(_, b)| b.starts_with(&head))).unwrap_or_else(|| panic!("{ty} fehlt"))
    }

    /// Kopf (META) eines Mini-Projekts ohne Geschoss.
    fn mini() -> B {
        let mut b = B::new();
        b.str("t");
        b.str("H");
        b.n(&[1_700_000_000.0]);
        b.str("2026-10-28T12:00:00");
        b.n(&[0.0, f64::NAN, 0.0]);
        b
    }

    #[test]
    fn wand_mit_achse_und_layer_set_usage() {
        let ifc = build(&full_house(false)).unwrap();
        check_structure(&ifc);
        // Nur W1 hat Wandsystem: eine Usage, eine Axis-Darstellung, ein Axis-Kontext.
        assert_eq!(count(&ifc, "IFCMATERIALLAYERSETUSAGE"), 1);
        assert_eq!(count(&ifc, "IFCGEOMETRICREPRESENTATIONSUBCONTEXT"), 1);
        let usage = first_line(&ifc, "IFCMATERIALLAYERSETUSAGE");
        assert!(usage.contains(".AXIS2.,.POSITIVE.,-0.2,$"), "{usage}");
        // Die Usage verweist auf das LayerSet des Typs (dasselbe wie die Typ-Zuordnung).
        let set_no: usize = usage.split("(#").nth(1).unwrap().split(',').next().unwrap().parse().unwrap();
        assert!(ifc.contains(&format!("#{set_no}=IFCMATERIALLAYERSET(")));
        // Axis: IfcPolyline von (0,0) nach (5,0) in Kurve2D.
        assert!(ifc.contains("'Axis','Curve2D'"));
        assert!(ifc.contains("IFCCARTESIANPOINT((5.0,0.0))"));
        assert!(ifc.contains("IFCDIRECTION((1.0,0.0,0.0))"));
    }

    #[test]
    fn gedrehte_wand_rechnet_profil_und_oeffnung_ins_wandsystem() {
        // Wand von (10,20) nach (10,25): u = (0,1), linke Normale = (−1,0).
        let mut b = mini();
        b.n(&[REC_WALL_SOLIDS, -1.0]);
        b.str("W");
        b.str("Wand");
        b.no_type();
        b.no_psets();
        b.n(&[1.0, 10.0, 20.0, 0.0, 1.0, 5.0, 0.0, 0.0]);
        b.n(&[1.0]);
        b.pts(&[(10.2, 20.0), (10.2, 25.0), (9.8, 25.0), (9.8, 20.0)]);
        b.n(&[0.0, 2.6]);
        b.opening(
            "W", "O", false, "Fenster",
            &[(10.3, 21.0), (10.3, 22.0), (9.7, 22.0), (9.7, 21.0)], 0.9, 1.2, 1.0,
            &fill(false, [10.0, 20.0, 10.0, 25.0], 1.0, 2.0, 0.9, 2.1),
        );
        let ifc = build(&b).unwrap();
        check_structure(&ifc);
        // Wandprofil lokal: x = Länge entlang u, y = linke Normale (10.2 → −0.2, 9.8 → 0.2).
        assert!(ifc.contains("IFCCARTESIANPOINT((0.0,-0.2))"));
        assert!(ifc.contains("IFCCARTESIANPOINT((5.0,0.2))"));
        // Öffnung lokal bei x = 1…2, quer −0.3…0.3.
        assert!(ifc.contains("IFCCARTESIANPOINT((1.0,-0.3))"));
        assert!(ifc.contains("IFCCARTESIANPOINT((2.0,0.3))"));
        assert!(ifc.contains("IFCDIRECTION((0.0,1.0,0.0))"));
        // Ohne Typ keine Usage, trotzdem Axis.
        assert_eq!(count(&ifc, "IFCMATERIALLAYERSETUSAGE"), 0);
        assert!(ifc.contains("'Axis','Curve2D'"));
    }

    #[test]
    fn tuer_hat_getrennte_koerper_mit_stilen_und_operation() {
        let ifc = build(&full_house(false)).unwrap();
        check_structure(&ifc);
        let door = first_line(&ifc, "IFCDOOR");
        assert!(door.contains(".DOOR.,.SINGLE_SWING_LEFT.,$);"), "{door}");
        // Sechs Körper (Zarge 3, Kämpfer, Oberlicht-Glas, Blatt) in EINER Darstellung, je ein
        // IfcStyledItem, drei Stile (Rahmen, Blatt, Glas).
        assert_eq!(count(&ifc, "IFCSTYLEDITEM"), 6);
        assert_eq!(count(&ifc, "IFCSURFACESTYLE"), 3);
        assert_eq!(count(&ifc, "IFCSURFACESTYLERENDERING"), 3);
        assert!(ifc.contains("IFCSURFACESTYLE('Glas',.BOTH.,"));
        assert!(ifc.contains("IFCSURFACESTYLERENDERING(#"));
        let shapes = ifc.lines().filter(|l| l.contains("IFCSHAPEREPRESENTATION") && l.contains("'SweptSolid'") && l.matches('#').count() == 8).count();
        assert!(shapes >= 1, "Darstellung mit 6 Körpern fehlt");
        // Füllungs-Placement mit Richtung (0,1,0) relativ zur Öffnung; Ursprung lokal.
        assert!(ifc.contains("IFCCARTESIANPOINT((1.45,0.0,0.0))"));
    }

    #[test]
    fn fenster_ohne_teile_hat_keine_darstellung_und_enum_ist_geprueft() {
        let mut b = full_house(false);
        let w1 = [0.0, 0.0, 5.0, 0.0];
        b.opening("W1", "F1", false, "Fenster", &SQUARE, 0.9, 1.2, 1.2, &FillParams { wing_count: 2.0, ..fill(false, w1, 2.0, 3.2, 0.9, 2.1) });
        b.opening("W1", "T2", true, "Wandöffnung", &SQUARE, 0.0, 2.1, 1.0, &FillParams { door_kind: DoorKind::WallOpening, ..fill(true, w1, 3.0, 4.0, 0.0, 2.1) });
        let ifc = build(&b).unwrap();
        check_structure(&ifc);
        let win = first_line(&ifc, "IFCWINDOW");
        assert!(win.contains(".WINDOW.,.DOUBLE_PANEL_VERTICAL.,$);"), "{win}");
        let hole = ifc.lines().filter(|l| l.contains("IFCDOOR(")).find(|l| l.contains(",$,$,2.1,1.0,.DOOR.,$,$);"));
        assert!(hole.is_some(), "Wandöffnung ohne Darstellung und Ausführung");
        // Kaputte Parameter: Fehler, nie Panic.
        let bad_params = [
            FillParams { panes: 0, ..fill(false, w1, 1.0, 2.0, 0.9, 2.1) },
            FillParams { swing_sign: 0.0, ..fill(true, w1, 1.0, 2.0, 0.0, 2.1) },
            FillParams { wing_count: f64::NAN, ..fill(false, w1, 1.0, 2.0, 0.9, 2.1) },
            FillParams { sashes: vec![Sash::default(); MAX_SASHES + 1], ..fill(false, w1, 1.0, 2.0, 0.9, 2.1) },
            // Wand ohne Länge: keine Richtung.
            fill(false, [1.0, 1.0, 1.0, 1.0], 0.0, 1.0, 0.0, 1.0),
        ];
        for p in bad_params {
            let mut bad = full_house(false);
            bad.opening("W1", "F9", false, "Fenster", &SQUARE, 0.9, 1.2, 1.2, &p);
            assert!(build(&bad).is_err(), "{p:?}");
        }
        // Unbekannte Türart.
        let mut bad = full_house(false);
        bad.opening("W1", "T9", true, "Tür", &SQUARE, 0.0, 2.1, 1.0, &fill(true, w1, 1.0, 2.0, 0.0, 2.1));
        let at = bad.f.len() - 1 /* psets */ - 3 /* glazed, ratio-opt */ - 6;
        bad.f[at] = 7.0;
        assert!(build(&bad).is_err());
    }

    #[test]
    fn schiefe_achsrichtung_ist_fehler() {
        let mut b = mini();
        b.n(&[REC_WALL_SOLIDS, -1.0]);
        b.str("W");
        b.str("Wand");
        b.no_type();
        b.no_psets();
        b.n(&[1.0, 0.0, 0.0, 2.0, 0.0, 5.0, 0.0, 0.0, 0.0]);
        assert!(build(&b).is_err());
    }

    #[test]
    fn ohne_georeferenz_und_deterministisch() {
        let b = full_house(false);
        let ifc = build(&b).unwrap();
        assert_eq!(count(&ifc, "IFCPROJECTEDCRS"), 0);
        assert!(!ifc.contains(",421.5,"));
        assert_eq!(ifc, build(&b).unwrap(), "zweimal bauen = gleiche Datei");
        // GlobalIds eindeutig.
        let mut seen = std::collections::HashSet::new();
        for l in ifc.lines().filter(|l| l.starts_with('#')) {
            let body = l.split_once('(').unwrap().1;
            if let Some(rest) = body.strip_prefix('\'') {
                if rest.len() > 22 && rest.as_bytes()[22] == b'\'' {
                    assert!(seen.insert(rest[..22].to_string()), "doppelte GlobalId {}", &rest[..22]);
                }
            }
        }
        assert!(seen.len() > 20);
    }

    #[test]
    fn leeres_projekt_ist_gueltig() {
        let mut b = B::new();
        b.str("p");
        b.str("");
        b.n(&[1.0]);
        b.str("iso");
        b.n(&[0.0, f64::NAN, 0.0]);
        let ifc = build(&b).unwrap();
        check_structure(&ifc);
        assert!(ifc.contains("IFCPROJECT('"));
        assert!(ifc.contains("'Projekt'") && ifc.contains("'Geb\\X2\\00E4\\X0\\ude'"));
        assert!(ifc.contains("FILE_NAME('modell.ifc'"));
        assert_eq!(count(&ifc, "IFCBUILDINGSTOREY"), 0);
        assert_eq!(count(&ifc, "IFCRELAGGREGATES"), 2);
    }

    #[test]
    fn oeffnung_ohne_wirtswand_wird_uebersprungen() {
        let mut b = B::new();
        b.str("p");
        b.str("x");
        b.n(&[1.0]);
        b.str("iso");
        b.n(&[0.0, f64::NAN, 0.0]);
        b.opening("gibt-es-nicht", "O1", false, "Fenster", &SQUARE, 0.0, 1.0, 1.0, &fill(false, [0.0, 0.0, 5.0, 0.0], 0.0, 1.0, 0.0, 1.0));
        let ifc = build(&b).unwrap();
        check_structure(&ifc);
        assert_eq!(count(&ifc, "IFCOPENINGELEMENT"), 0);
    }

    #[test]
    fn kaputte_puffer_ergeben_fehler_nie_panic() {
        assert!(build_ifc(&[], "").is_err());
        assert!(build_ifc(&[2.0], "").is_err());
        assert!(build_ifc(&[FLAT_VERSION], "").is_err()); // META fehlt
        assert!(build_ifc(&[FLAT_VERSION, 0.0, 0.0, f64::NAN], "a\0b").is_err());
        assert!(build_ifc(&[FLAT_VERSION, 5.0], "a").is_err()); // Zeichenketten-Index ausserhalb
        let b = full_house(true);
        let (f, s) = b.data();
        // An jeder Stelle abgeschnitten: nie Panic (Fehler oder, auf Datensatzgrenzen, Erfolg).
        for n in 0..f.len() {
            let _ = build_ifc(&f[..n], &s);
        }
        // Jedes Element einzeln verdorben (NaN, ∞, −1, riesig, gebrochen): nie Panic.
        for i in 0..f.len() {
            for bad in [f64::NAN, f64::INFINITY, -1.0, 1e30, 0.5] {
                let mut g = f.to_vec();
                g[i] = bad;
                let _ = build_ifc(&g, &s);
            }
        }
        // Unbekannter Datensatz, Geschoss-Index ausserhalb, Dreiecks-Index ausserhalb.
        let mut g = vec![FLAT_VERSION, 0.0, 0.0, 1.0, 0.0, 0.0, f64::NAN, 0.0, 99.0];
        assert!(build_ifc(&g, "a").is_err());
        g[8] = REC_STAIR;
        g.extend([3.0]);
        assert!(build_ifc(&g, "a").is_err());
        let mut m = B::new();
        m.str("p");
        m.str("x");
        m.n(&[1.0]);
        m.str("i");
        m.n(&[0.0, f64::NAN, 0.0]);
        m.n(&[REC_ROOF, -1.0]);
        m.str("R");
        m.str("R");
        m.str("FLAT_ROOF");
        m.no_type();
        m.no_psets();
        m.n(&[1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0]); // Index 1 bei nur 1 Punkt
        let (f, s) = m.data();
        assert!(build_ifc(f, &s).is_err());
    }
}
