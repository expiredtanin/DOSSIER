// Einfache Punktwolken-Formate: PLY (ASCII, binary_little_endian, binary_big_endian) und die
// Textformate XYZ/PTS. Eigener Leser, keine Abhängigkeit.
//
// XYZ/PTS (Spalten durch Leerraum, Komma oder Semikolon getrennt; Zeilen mit '#' oder '//' sind
// Kommentare; eine erste Zeile mit nur einer ganzen Zahl ist der PTS-Punktzähler):
//   3 Spalten  x y z
//   4 Spalten  x y z i
//   6 Spalten  x y z r g b   (ganze Zahlen 0–255; sonst x y z nx ny nz, Normalen werden ignoriert)
//   7 Spalten  x y z i r g b (PTS)
//   9 Spalten  x y z nx ny nz r g b
// Das Spaltenschema entscheidet die erste Datenzeile; Zeilen mit anderer Spaltenzahl oder
// unlesbaren Zahlen werden gezählt und verworfen. Intensität: Dezimalwerte in [0, 1] werden auf
// u16 gestreckt, sonst auf 0…65535 geklemmt (negative Leica-Werte → 0).

use crate::pointcloud::{Attrs, Options, PointCloud, PointReport, Sink};

// ---------------------------------------------------------------------------------------- XYZ/PTS

#[derive(Clone, Copy, PartialEq)]
enum Scheme {
    Xyz,
    XyzI,
    XyzRgb,
    XyzIRgb,
    XyzNRgb,
    XyzN,
}

fn split_fields(line: &str) -> Vec<&str> {
    line.split(|c: char| c.is_whitespace() || c == ',' || c == ';').filter(|s| !s.is_empty()).collect()
}

fn scheme_for(fields: &[&str]) -> Option<Scheme> {
    Some(match fields.len() {
        3 => Scheme::Xyz,
        4 => Scheme::XyzI,
        6 => {
            let is_rgb = fields[3..6].iter().all(|f| f.parse::<u32>().map(|v| v <= 255).unwrap_or(false));
            if is_rgb {
                Scheme::XyzRgb
            } else {
                Scheme::XyzN
            }
        }
        7 => Scheme::XyzIRgb,
        9 => Scheme::XyzNRgb,
        _ => return None,
    })
}

fn color16(v: f64) -> u16 {
    // 8-Bit-Wert → 16 Bit (·257), damit `Sink::finish` ihn wieder auf 8 Bit abbilden kann.
    (v.clamp(0.0, 255.0).round() as u16) * 257
}

/// XYZ oder PTS lesen (Textformat, UTF-8/ASCII).
pub fn read_xyz(bytes: &[u8], name: &str, opts: Options) -> Result<(PointCloud, PointReport), String> {
    let text = String::from_utf8_lossy(bytes);
    let mut lines = text.lines().map(str::trim).filter(|l| !l.is_empty() && !l.starts_with('#') && !l.starts_with("//"));
    let mut first = lines.next().ok_or("Punktwolken-Textdatei ist leer")?;
    let mut declared = 0u64;
    let mut is_pts = name.to_ascii_lowercase().ends_with(".pts");
    if !first.contains(char::is_whitespace) && first.parse::<u64>().is_ok() {
        declared = first.parse().unwrap_or(0);
        is_pts = true;
        first = lines.next().ok_or("PTS-Datei ohne Punkte")?;
    }
    let f0 = split_fields(first);
    let scheme = scheme_for(&f0).ok_or_else(|| format!("Textformat nicht erkannt ({} Spalten in der ersten Zeile)", f0.len()))?;
    let ncols = f0.len();
    if f0.iter().take(3).any(|f| f.parse::<f64>().is_err()) {
        return Err("Textformat nicht erkannt (Koordinaten sind keine Zahlen)".into());
    }
    let attrs = Attrs {
        color: matches!(scheme, Scheme::XyzRgb | Scheme::XyzIRgb | Scheme::XyzNRgb),
        intensity: matches!(scheme, Scheme::XyzI | Scheme::XyzIRgb),
        class: false,
    };
    let scale_unit_intensity = scheme == Scheme::XyzI || scheme == Scheme::XyzIRgb;
    // Intensität im Bereich [0,1] mit Nachkommastellen → strecken (Entscheid an der ersten Zeile).
    let int_idx = 3;
    let unit_intensity = scale_unit_intensity
        && f0.get(int_idx).and_then(|f| f.parse::<f64>().ok()).map(|v| (0.0..=1.0).contains(&v) && v.fract() != 0.0).unwrap_or(false);
    let mut sink = Sink::new(opts, attrs, None);
    let mut first_line = Some(first);
    let mut bad = 0u64;
    loop {
        let line = match first_line.take() {
            Some(l) => l,
            None => match lines.next() {
                Some(l) => l,
                None => break,
            },
        };
        let f = split_fields(line);
        if f.len() != ncols {
            bad += 1;
            sink.count_invalid();
            continue;
        }
        let num = |i: usize| f[i].parse::<f64>().ok();
        let (Some(x), Some(y), Some(z)) = (num(0), num(1), num(2)) else {
            bad += 1;
            sink.count_invalid();
            continue;
        };
        let (mut inten, mut rgb) = (0u16, [0u16; 3]);
        match scheme {
            Scheme::XyzI | Scheme::XyzIRgb => {
                let v = num(3).unwrap_or(0.0);
                inten = if unit_intensity { (v.clamp(0.0, 1.0) * 65535.0).round() as u16 } else { v.clamp(0.0, 65535.0).round() as u16 };
                if scheme == Scheme::XyzIRgb {
                    rgb = [color16(num(4).unwrap_or(0.0)), color16(num(5).unwrap_or(0.0)), color16(num(6).unwrap_or(0.0))];
                }
            }
            Scheme::XyzRgb => rgb = [color16(num(3).unwrap_or(0.0)), color16(num(4).unwrap_or(0.0)), color16(num(5).unwrap_or(0.0))],
            Scheme::XyzNRgb => rgb = [color16(num(6).unwrap_or(0.0)), color16(num(7).unwrap_or(0.0)), color16(num(8).unwrap_or(0.0))],
            _ => {}
        }
        sink.push([x, y, z], rgb, inten, 0);
    }
    let mut report = PointReport {
        format: if is_pts { "pts" } else { "xyz" }.into(),
        points_declared: declared,
        ..Default::default()
    };
    if bad > 0 {
        report.warnings.push(format!("{bad} Zeilen übersprungen (Spaltenzahl oder Zahl ungültig)"));
    }
    sink.finish(report)
}

// ------------------------------------------------------------------------------------------- PLY

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
    fn read(self, b: &[u8], big: bool) -> f64 {
        macro_rules! rd {
            ($t:ty, $n:expr) => {{
                let a: [u8; $n] = b[..$n].try_into().unwrap_or([0; $n]);
                (if big { <$t>::from_be_bytes(a) } else { <$t>::from_le_bytes(a) }) as f64
            }};
        }
        match self {
            Ty::I8 => b[0] as i8 as f64,
            Ty::U8 => b[0] as f64,
            Ty::I16 => rd!(i16, 2),
            Ty::U16 => rd!(u16, 2),
            Ty::I32 => rd!(i32, 4),
            Ty::U32 => rd!(u32, 4),
            Ty::F32 => rd!(f32, 4),
            Ty::F64 => rd!(f64, 8),
        }
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Role {
    X,
    Y,
    Z,
    R,
    G,
    B,
    Intensity,
    Class,
    Other,
}

struct Prop {
    ty: Ty,
    role: Role,
}

fn role_of(name: &str) -> Role {
    match name {
        "x" => Role::X,
        "y" => Role::Y,
        "z" => Role::Z,
        "red" | "r Red" | "diffuse_red" => Role::R,
        "green" | "diffuse_green" => Role::G,
        "blue" | "diffuse_blue" => Role::B,
        "intensity" | "scalar_intensity" | "reflectance" => Role::Intensity,
        "classification" | "class" | "scalar_classification" | "scalar_class" => Role::Class,
        _ => Role::Other,
    }
}

/// PLY lesen: nur das Element `vertex` (muss das erste sein), Flächen u. a. werden ignoriert.
pub fn read_ply(bytes: &[u8], opts: Options) -> Result<(PointCloud, PointReport), String> {
    // Kopf bis "end_header\n" (der Rest kann binär sein).
    let end = find_sub(bytes, b"end_header").ok_or("PLY ohne end_header")?;
    let mut body = end + b"end_header".len();
    // Zeilenende nach end_header (\n oder \r\n).
    if bytes.get(body) == Some(&b'\r') {
        body += 1;
    }
    if bytes.get(body) == Some(&b'\n') {
        body += 1;
    }
    let header = String::from_utf8_lossy(&bytes[..end]);
    let mut format = String::new();
    let mut count = 0u64;
    let mut props: Vec<Prop> = Vec::new();
    let mut in_vertex = false;
    let mut seen_vertex = false;
    let mut other_before = false;
    for line in header.lines().skip(1) {
        let w: Vec<&str> = line.split_whitespace().collect();
        match w.as_slice() {
            ["format", f, ..] => format = f.to_string(),
            ["element", "vertex", n] => {
                count = n.parse().map_err(|_| "PLY: Punktzahl ungültig")?;
                in_vertex = true;
                seen_vertex = true;
            }
            ["element", ..] => {
                if !seen_vertex {
                    other_before = true;
                }
                in_vertex = false;
            }
            ["property", "list", ..] if in_vertex => return Err("PLY: Listen-Eigenschaften im Element vertex nicht unterstützt".into()),
            ["property", ty, name] if in_vertex => {
                let ty = Ty::parse(ty).ok_or_else(|| format!("PLY: Datentyp {ty} unbekannt"))?;
                props.push(Prop { ty, role: role_of(name) });
            }
            _ => {}
        }
    }
    if !seen_vertex || other_before {
        return Err("PLY: Element vertex fehlt oder steht nicht an erster Stelle".into());
    }
    let has = |r: Role| props.iter().any(|p| p.role == r);
    if !(has(Role::X) && has(Role::Y) && has(Role::Z)) {
        return Err("PLY: x/y/z fehlen".into());
    }
    let attrs = Attrs {
        color: has(Role::R) && has(Role::G) && has(Role::B),
        intensity: has(Role::Intensity),
        class: has(Role::Class),
    };
    let mut sink = Sink::new(opts, attrs, None);
    let mut report = PointReport {
        format: "ply".into(),
        version: format.clone(),
        points_declared: count,
        ..Default::default()
    };
    // Farbskala: uchar → 8 Bit (·257), ushort → 16 Bit, Float → 0..1.
    let col = |p: &Prop, v: f64| -> u16 {
        match p.ty {
            Ty::F32 | Ty::F64 => (v.clamp(0.0, 1.0) * 65535.0).round() as u16,
            Ty::U8 | Ty::I8 => (v.clamp(0.0, 255.0) as u16) * 257,
            _ => v.clamp(0.0, 65535.0) as u16,
        }
    };
    let emit = |vals: &[f64], sink: &mut Sink| {
        let (mut p, mut rgb, mut it, mut cl) = ([0.0f64; 3], [0u16; 3], 0u16, 0u8);
        for (prop, &v) in props.iter().zip(vals) {
            match prop.role {
                Role::X => p[0] = v,
                Role::Y => p[1] = v,
                Role::Z => p[2] = v,
                Role::R => rgb[0] = col(prop, v),
                Role::G => rgb[1] = col(prop, v),
                Role::B => rgb[2] = col(prop, v),
                Role::Intensity => {
                    it = match prop.ty {
                        Ty::F32 | Ty::F64 if (0.0..=1.0).contains(&v) => (v * 65535.0).round() as u16,
                        _ => v.clamp(0.0, 65535.0).round() as u16,
                    }
                }
                Role::Class => cl = v.clamp(0.0, 255.0) as u8,
                Role::Other => {}
            }
        }
        sink.push(p, rgb, it, cl);
    };
    let data = &bytes[body.min(bytes.len())..];
    match format.as_str() {
        "ascii" => {
            let text = String::from_utf8_lossy(data);
            let mut n = 0u64;
            let mut vals = vec![0.0f64; props.len()];
            for line in text.lines() {
                if n >= count {
                    break;
                }
                let f: Vec<&str> = line.split_whitespace().collect();
                if f.len() < props.len() {
                    if f.is_empty() {
                        continue;
                    }
                    sink.count_invalid();
                    n += 1;
                    continue;
                }
                let mut ok = true;
                for (k, v) in vals.iter_mut().enumerate() {
                    match f[k].parse::<f64>() {
                        Ok(x) => *v = x,
                        Err(_) => ok = false,
                    }
                }
                n += 1;
                if ok {
                    emit(&vals, &mut sink);
                } else {
                    sink.count_invalid();
                }
            }
            if n < count {
                report.truncated = true;
                report.warnings.push(format!("PLY enthält nur {n} von {count} Punkten"));
            }
        }
        "binary_little_endian" | "binary_big_endian" => {
            let big = format == "binary_big_endian";
            let stride: usize = props.iter().map(|p| p.ty.size()).sum();
            if stride == 0 {
                return Err("PLY: leere Eigenschaftsliste".into());
            }
            let avail = (data.len() / stride) as u64;
            let n = count.min(avail);
            if n < count {
                report.truncated = true;
                report.warnings.push(format!("PLY enthält nur {n} von {count} Punkten"));
            }
            sink.reserve_hint(n);
            let mut vals = vec![0.0f64; props.len()];
            for k in 0..n as usize {
                let mut o = k * stride;
                for (v, p) in vals.iter_mut().zip(&props) {
                    *v = p.ty.read(&data[o..o + p.ty.size()], big);
                    o += p.ty.size();
                }
                emit(&vals, &mut sink);
            }
        }
        other => return Err(format!("PLY: Format {other:?} unbekannt")),
    }
    sink.finish(report)
}

fn find_sub(h: &[u8], n: &[u8]) -> Option<usize> {
    h.windows(n.len()).position(|w| w == n)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn o() -> Options {
        Options::default()
    }

    #[test]
    fn xyz_plain_and_comma() {
        let t = "# Kommentar\n1.5 2.5 3.5\n4,5,6\n7;8;9\n\n";
        let (c, r) = read_xyz(t.as_bytes(), "a.xyz", o()).unwrap();
        assert_eq!(r.format, "xyz");
        assert_eq!(c.len(), 3);
        assert!(!r.has_color && !r.has_intensity);
        assert!((c.origin[0] + c.xyz[3] as f64 - 4.0).abs() < 1e-5);
    }

    #[test]
    fn xyz_rgb_and_normals() {
        let (c, r) = read_xyz(b"0 0 0 255 128 0\n1 1 1 0 0 255\n", "a.xyz", o()).unwrap();
        assert!(r.has_color);
        assert_eq!(&c.rgb[..3], &[255, 128, 0]);
        let (c, r) = read_xyz(b"0 0 0 0.5 0.5 0.7\n1 1 1 0.0 1.0 0.0\n", "a.xyz", o()).unwrap();
        assert!(!r.has_color);
        assert_eq!(c.len(), 2);
    }

    #[test]
    fn pts_with_count_intensity_and_color() {
        let t = "2\n1.0 2.0 3.0 -5 10 20 30\n4.0 5.0 6.0 300 40 50 60\n";
        let (c, r) = read_xyz(t.as_bytes(), "scan.pts", o()).unwrap();
        assert_eq!(r.format, "pts");
        assert_eq!(r.points_declared, 2);
        assert_eq!(c.intensity, vec![0, 300]);
        assert_eq!(c.rgb, vec![10, 20, 30, 40, 50, 60]);
    }

    #[test]
    fn xyz_unit_intensity_is_stretched() {
        let (c, _) = read_xyz(b"0 0 0 0.5\n1 1 1 1.0\n", "a.xyz", o()).unwrap();
        assert_eq!(c.intensity, vec![32768, 65535]);
    }

    #[test]
    fn xyz_bad_lines_are_counted() {
        let (c, r) = read_xyz(b"0 0 0\nabc def ghi\n1 2\n3 4 5\nnan 1 1\n", "a.xyz", o()).unwrap();
        assert_eq!(c.len(), 2); // "nan" parst als NaN und wird im Sink verworfen? -> 0 0 0 und 3 4 5
        assert!(r.points_invalid >= 2);
    }

    #[test]
    fn xyz_garbage_is_error() {
        assert!(read_xyz(b"", "a.xyz", o()).is_err());
        assert!(read_xyz(b"hello world foo\n", "a.xyz", o()).is_err());
        assert!(read_xyz(b"1 2 3 4 5\n", "a.xyz", o()).is_err());
        assert!(read_xyz(&[0xFF, 0xFE, 0x00, 0x01], "a.xyz", o()).is_err());
    }

    fn ply_ascii() -> Vec<u8> {
        b"ply\nformat ascii 1.0\ncomment x\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nproperty uchar classification\nelement face 1\nproperty list uchar int vertex_indices\nend_header\n1 2 3 255 0 0 2\n4 5 6 0 255 0 6\n7 8 9 0 0 255 9\n3 0 1 2\n".to_vec()
    }

    #[test]
    fn ply_ascii_roundtrip() {
        let (c, r) = read_ply(&ply_ascii(), o()).unwrap();
        assert_eq!(c.len(), 3);
        assert_eq!(r.format, "ply");
        assert!(r.has_color && r.has_classification);
        assert_eq!(c.classification, vec![2, 6, 9]);
        assert_eq!(c.rgb, vec![255, 0, 0, 0, 255, 0, 0, 0, 255]);
        assert_eq!(r.bbox_max, [7.0, 8.0, 9.0]);
    }

    fn ply_bin(big: bool) -> Vec<u8> {
        let fmt = if big { "binary_big_endian" } else { "binary_little_endian" };
        let mut v = format!("ply\nformat {fmt} 1.0\nelement vertex 2\nproperty double x\nproperty double y\nproperty double z\nproperty ushort intensity\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nend_header\n").into_bytes();
        for (k, p) in [[2_600_000.25f64, 1_200_000.5, 400.0], [2_600_001.0, 1_200_002.0, 401.0]].iter().enumerate() {
            for x in p {
                v.extend(if big { x.to_be_bytes() } else { x.to_le_bytes() });
            }
            let i = 1000u16 * (k as u16 + 1);
            v.extend(if big { i.to_be_bytes() } else { i.to_le_bytes() });
            v.extend([10, 20, 30]);
        }
        v
    }

    #[test]
    fn ply_binary_both_endians() {
        for big in [false, true] {
            let (c, r) = read_ply(&ply_bin(big), o()).unwrap();
            assert_eq!(c.len(), 2);
            assert_eq!(c.intensity, vec![1000, 2000]);
            assert_eq!(r.bbox_min[0], 2_600_000.25);
            assert!((c.origin[0] + c.xyz[3] as f64 - 2_600_001.0).abs() < 1e-3);
            assert_eq!(&c.rgb[..3], &[10, 20, 30]);
        }
    }

    #[test]
    fn ply_truncated_and_broken() {
        let mut b = ply_bin(false);
        b.truncate(b.len() - 10);
        let (c, r) = read_ply(&b, o()).unwrap();
        assert_eq!(c.len(), 1);
        assert!(r.truncated);
        assert!(read_ply(b"ply\nformat ascii 1.0\n", o()).is_err());
        assert!(read_ply(b"ply\nformat ascii 1.0\nelement vertex 1\nproperty float x\nend_header\n1\n", o()).is_err());
        assert!(read_ply(b"ply\nformat ascii 1.0\nelement vertex 1\nproperty list uchar int x\nend_header\n", o()).is_err());
        assert!(read_ply(b"ply\nformat ascii 1.0\nelement vertex abc\nend_header\n", o()).is_err());
        for cut in 0..ply_ascii().len() {
            let _ = read_ply(&ply_ascii()[..cut], o());
        }
    }
}
