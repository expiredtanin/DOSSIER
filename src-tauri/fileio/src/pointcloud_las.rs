// LAS 1.0–1.4 und LAZ lesen (Punktformate 0–10). Eigener Leser für Kopf und Punktsätze (klein, ohne
// Dateisystem, kein Panic bei kaputten Dateien); nur die LAZ-Dekompression kommt aus dem Crate `laz`
// (laz-rs, Apache-2.0, Rust-Port von LASzip, s. NOTICE).
//
// Layout nach ASPRS LAS 1.4 R15: Kopf 227 Byte (1.0–1.2), 235 (1.3), 375 (1.4); VLRs ab `header_size`;
// Punktsätze ab `offset_to_point_data`. Koordinaten = ganzzahlig · Skala + Versatz.

use crate::pointcloud::{Attrs, Options, PointCloud, PointReport, Sink};

const LASZIP_USER_ID: &str = "laszip encoded";
const LASZIP_RECORD_ID: u16 = 22204;
/// Rohkoordinaten der Punkte werden in Blöcken dekodiert (Speicher unabhängig von der Punktzahl).
const BLOCK_POINTS: usize = 1 << 16;

fn u16_at(b: &[u8], o: usize) -> Option<u16> {
    Some(u16::from_le_bytes(b.get(o..o + 2)?.try_into().ok()?))
}
fn u32_at(b: &[u8], o: usize) -> Option<u32> {
    Some(u32::from_le_bytes(b.get(o..o + 4)?.try_into().ok()?))
}
fn u64_at(b: &[u8], o: usize) -> Option<u64> {
    Some(u64::from_le_bytes(b.get(o..o + 8)?.try_into().ok()?))
}
fn f64_at(b: &[u8], o: usize) -> Option<f64> {
    Some(f64::from_le_bytes(b.get(o..o + 8)?.try_into().ok()?))
}

/// Gelesener LAS-Kopf (nur, was der Leser braucht).
#[derive(Debug)]
struct Header {
    minor: u8,
    major: u8,
    header_size: usize,
    data_offset: usize,
    vlr_count: u32,
    /// Punktformat 0–10 ohne das LAZ-Bit.
    format: u8,
    compressed: bool,
    record_len: usize,
    count: u64,
    scale: [f64; 3],
    offset: [f64; 3],
    bbox_min: [f64; 3],
    bbox_max: [f64; 3],
}

fn parse_header(b: &[u8]) -> Result<Header, String> {
    let short = || "LAS-Kopf abgeschnitten".to_string();
    if b.len() < 227 {
        return Err(short());
    }
    let major = b[24];
    let minor = b[25];
    if major != 1 || minor > 4 {
        return Err(format!("LAS-Version {major}.{minor} wird nicht unterstützt (1.0–1.4)"));
    }
    let header_size = u16_at(b, 94).ok_or_else(short)? as usize;
    if header_size < 227 || header_size > b.len() {
        return Err("LAS-Kopfgrösse ungültig".into());
    }
    let data_offset = u32_at(b, 96).ok_or_else(short)? as usize;
    let vlr_count = u32_at(b, 100).ok_or_else(short)?;
    let raw_format = b[104];
    let format = raw_format & 0x3F;
    // LAZ: Bit 7 (LAS 1.2/1.3 nach LASzip-Konvention) bzw. Bit 6 (ältere Schreiber) des Formatbytes.
    let compressed = raw_format & 0xC0 != 0;
    if format > 10 {
        return Err(format!("LAS-Punktformat {format} unbekannt"));
    }
    let record_len = u16_at(b, 105).ok_or_else(short)? as usize;
    let legacy = u32_at(b, 107).ok_or_else(short)? as u64;
    let mut count = legacy;
    if minor >= 4 && header_size >= 375 {
        let c64 = u64_at(b, 247).ok_or_else(short)?;
        if c64 != 0 || legacy == 0 {
            count = c64;
        }
    }
    let mut scale = [0.0; 3];
    let mut offset = [0.0; 3];
    for i in 0..3 {
        scale[i] = f64_at(b, 131 + 8 * i).ok_or_else(short)?;
        offset[i] = f64_at(b, 155 + 8 * i).ok_or_else(short)?;
    }
    // Reihenfolge im Kopf: max x, min x, max y, min y, max z, min z.
    let mut bbox_max = [0.0; 3];
    let mut bbox_min = [0.0; 3];
    for i in 0..3 {
        bbox_max[i] = f64_at(b, 179 + 16 * i).ok_or_else(short)?;
        bbox_min[i] = f64_at(b, 187 + 16 * i).ok_or_else(short)?;
    }
    for s in scale {
        if !(s.is_finite() && s != 0.0) {
            return Err("LAS-Skalierung ungültig (0 oder NaN)".into());
        }
    }
    if offset.iter().any(|o| !o.is_finite()) {
        return Err("LAS-Versatz ungültig".into());
    }
    Ok(Header {
        minor,
        major,
        header_size,
        data_offset,
        vlr_count,
        format,
        compressed,
        record_len,
        count,
        scale,
        offset,
        bbox_min,
        bbox_max,
    })
}

/// Mindestlänge eines Punktsatzes je Format (ASPRS LAS 1.4).
fn min_record_len(format: u8) -> usize {
    match format {
        0 => 20,
        1 => 28,
        2 => 26,
        3 => 34,
        4 => 57,
        5 => 63,
        6 => 30,
        7 => 36,
        8 => 38,
        9 => 59,
        _ => 67,
    }
}

/// Lage der Attribute im Punktsatz (Byte-Offsets).
struct Layout {
    rgb: Option<usize>,
    /// Format 6–10: Klassifikation als volles Byte (Offset 16); 0–5: Byte 15, untere 5 Bit.
    class_off: usize,
    class_mask: u8,
}

fn layout(format: u8) -> Layout {
    let rgb = match format {
        2 => Some(20),
        3 | 5 => Some(28),
        7 | 8 | 10 => Some(30),
        _ => None,
    };
    if format >= 6 {
        Layout { rgb, class_off: 16, class_mask: 0xFF }
    } else {
        Layout { rgb, class_off: 15, class_mask: 0x1F }
    }
}

struct Vlr<'a> {
    user: String,
    id: u16,
    data: &'a [u8],
}

fn parse_vlrs<'a>(b: &'a [u8], h: &Header) -> Vec<Vlr<'a>> {
    let mut out = Vec::new();
    let mut pos = h.header_size;
    for _ in 0..h.vlr_count.min(10_000) {
        let Some(hdr) = b.get(pos..pos + 54) else { break };
        let user = String::from_utf8_lossy(&hdr[2..18]).trim_end_matches('\0').to_string();
        let id = u16::from_le_bytes([hdr[18], hdr[19]]);
        let len = u16::from_le_bytes([hdr[20], hdr[21]]) as usize;
        let Some(data) = b.get(pos + 54..pos + 54 + len) else { break };
        out.push(Vlr { user, id, data });
        pos += 54 + len;
    }
    out
}

/// EPSG-Code aus GeoKey-Verzeichnis (34735, Schlüssel 3072 ProjectedCSType) oder – LAS 1.4 – aus dem
/// WKT-VLR (2112, letzter `ID["EPSG",n]` bzw. `AUTHORITY["EPSG","n"]` auf oberster Ebene des Textes).
fn find_epsg(vlrs: &[Vlr]) -> Option<u32> {
    for v in vlrs.iter().filter(|v| v.user == "LASF_Projection" && v.id == 34735) {
        let d = v.data;
        let n = u16_at(d, 6)? as usize;
        for k in 0..n.min(500) {
            let o = 8 + 8 * k;
            let (key, loc, val) = (u16_at(d, o)?, u16_at(d, o + 2)?, u16_at(d, o + 6)?);
            if key == 3072 && loc == 0 && val != 0 && val != 32767 {
                return Some(val as u32);
            }
        }
    }
    for v in vlrs.iter().filter(|v| v.user == "LASF_Projection" && v.id == 2112) {
        let text = String::from_utf8_lossy(v.data);
        // Der EPSG-Code des Gesamtsystems steht am Ende des WKT.
        if let Some(i) = text.rfind("EPSG") {
            let digits: String = text[i..]
                .chars()
                .skip_while(|c| !c.is_ascii_digit())
                .take_while(|c| c.is_ascii_digit())
                .collect();
            if let Ok(n) = digits.parse::<u32>() {
                return Some(n);
            }
        }
    }
    None
}

/// Liest LAS oder LAZ.
pub fn read_las(bytes: &[u8], opts: Options) -> Result<(PointCloud, PointReport), String> {
    let h = parse_header(bytes)?;
    let min_len = min_record_len(h.format);
    if h.record_len < min_len {
        return Err(format!(
            "LAS-Punktsatzlänge {} zu klein für Punktformat {} (mindestens {min_len})",
            h.record_len, h.format
        ));
    }
    if h.data_offset > bytes.len() || h.data_offset < h.header_size {
        return Err("LAS-Offset der Punktdaten ungültig".into());
    }
    let vlrs = parse_vlrs(bytes, &h);
    let lay = layout(h.format);
    let attrs = Attrs { color: lay.rgb.is_some(), intensity: true, class: true };

    // Ursprung: Mitte der Kopf-Bounding-Box (ganze Meter), wenn plausibel; sonst erster Punkt.
    let mid = [0, 1, 2].map(|i| (h.bbox_min[i] + h.bbox_max[i]) / 2.0);
    let origin = if mid.iter().all(|v| v.is_finite()) && h.bbox_min.iter().zip(&h.bbox_max).all(|(a, b)| a <= b) {
        Some(mid)
    } else {
        None
    };
    let mut sink = Sink::new(opts, attrs, origin);

    let mut report = PointReport {
        format: if h.compressed { "laz" } else { "las" }.into(),
        version: format!("{}.{}", h.major, h.minor),
        point_format: Some(h.format),
        points_declared: h.count,
        epsg: find_epsg(&vlrs),
        ..Default::default()
    };

    let rec = h.record_len;
    let mut decode = |buf: &[u8], n: usize, sink: &mut Sink| {
        for k in 0..n {
            let r = &buf[k * rec..(k + 1) * rec];
            let ix = i32::from_le_bytes([r[0], r[1], r[2], r[3]]) as f64;
            let iy = i32::from_le_bytes([r[4], r[5], r[6], r[7]]) as f64;
            let iz = i32::from_le_bytes([r[8], r[9], r[10], r[11]]) as f64;
            let p = [
                ix * h.scale[0] + h.offset[0],
                iy * h.scale[1] + h.offset[1],
                iz * h.scale[2] + h.offset[2],
            ];
            let intensity = u16::from_le_bytes([r[12], r[13]]);
            let class = r[lay.class_off] & lay.class_mask;
            let rgb = match lay.rgb {
                Some(o) => [
                    u16::from_le_bytes([r[o], r[o + 1]]),
                    u16::from_le_bytes([r[o + 2], r[o + 3]]),
                    u16::from_le_bytes([r[o + 4], r[o + 5]]),
                ],
                None => [0; 3],
            };
            sink.push(p, rgb, intensity, class);
        }
    };

    if !h.compressed {
        let data = &bytes[h.data_offset..];
        let avail = (data.len() / rec) as u64;
        let n = h.count.min(avail);
        if n < h.count {
            report.truncated = true;
            report.warnings.push(format!("Datei enthält nur {n} von {} Punkten", h.count));
        }
        sink.reserve_hint(n);
        let n = n as usize;
        let mut done = 0usize;
        while done < n {
            let take = (n - done).min(BLOCK_POINTS);
            decode(&data[done * rec..(done + take) * rec], take, &mut sink);
            done += take;
        }
    } else {
        decode_laz(bytes, &h, &vlrs, &mut sink, &mut report, &mut decode)?;
    }
    sink.finish(report)
}

fn decode_laz(
    bytes: &[u8],
    h: &Header,
    vlrs: &[Vlr],
    sink: &mut Sink,
    report: &mut PointReport,
    decode: &mut dyn FnMut(&[u8], usize, &mut Sink),
) -> Result<(), String> {
    let vlr = vlrs
        .iter()
        .find(|v| v.user == LASZIP_USER_ID && v.id == LASZIP_RECORD_ID)
        .ok_or("LAZ ohne laszip-VLR (Kopf von komprimierten Daten fehlt)")?;
    let laz_vlr = laz::LazVlr::from_buffer(vlr.data).map_err(|e| format!("LAZ-VLR unlesbar: {e}"))?;
    if laz_vlr.items_size() as usize != h.record_len {
        return Err(format!(
            "LAZ-Punktsatzlänge {} passt nicht zum Kopf ({})",
            laz_vlr.items_size(),
            h.record_len
        ));
    }
    let mut cursor = std::io::Cursor::new(bytes);
    cursor.set_position(h.data_offset as u64);
    let mut dec = laz::LasZipDecompressor::new(cursor, laz_vlr).map_err(|e| format!("LAZ-Dekompressor: {e}"))?;
    sink.reserve_hint(h.count);
    let rec = h.record_len;
    let mut buf = vec![0u8; BLOCK_POINTS * rec];
    let mut remaining = h.count;
    let mut got_any = false;
    while remaining > 0 {
        let take = remaining.min(BLOCK_POINTS as u64) as usize;
        if let Err(e) = dec.decompress_many(&mut buf[..take * rec]) {
            if !got_any {
                return Err(format!("LAZ-Dekompression fehlgeschlagen: {e}"));
            }
            report.truncated = true;
            report.warnings.push(format!("LAZ-Dekompression brach nach {} Punkten ab: {e}", h.count - remaining));
            return Ok(());
        }
        got_any = true;
        decode(&buf[..take * rec], take, sink);
        remaining -= take as u64;
    }
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// Testpunkt: Koordinaten in m (absolut), Intensität, Klasse, Farbe 16 Bit.
    #[derive(Clone, Copy)]
    pub struct P {
        pub x: f64,
        pub y: f64,
        pub z: f64,
        pub i: u16,
        pub c: u8,
        pub rgb: [u16; 3],
    }

    pub const SCALE: f64 = 0.001;

    fn record(p: &P, format: u8, rec_len: usize, off: [f64; 3]) -> Vec<u8> {
        let mut r = vec![0u8; rec_len];
        let q = |v: f64, o: f64| ((v - o) / SCALE).round() as i32;
        r[0..4].copy_from_slice(&q(p.x, off[0]).to_le_bytes());
        r[4..8].copy_from_slice(&q(p.y, off[1]).to_le_bytes());
        r[8..12].copy_from_slice(&q(p.z, off[2]).to_le_bytes());
        r[12..14].copy_from_slice(&p.i.to_le_bytes());
        let lay = layout(format);
        r[lay.class_off] = p.c;
        if let Some(o) = lay.rgb {
            for k in 0..3 {
                r[o + 2 * k..o + 2 * k + 2].copy_from_slice(&p.rgb[k].to_le_bytes());
            }
        }
        r
    }

    /// Baut eine LAS-Datei (Minor 0–4) mit den Punkten; `laz` komprimiert die Punktdaten.
    pub fn make_las(minor: u8, format: u8, pts: &[P], laz: bool) -> Vec<u8> {
        let header_size = match minor {
            0..=2 => 227,
            3 => 235,
            _ => 375,
        };
        let rec_len = min_record_len(format);
        let off = [pts[0].x.floor(), pts[0].y.floor(), pts[0].z.floor()];
        let mut recs = Vec::new();
        for p in pts {
            recs.extend(record(p, format, rec_len, off));
        }
        let mut vlr_bytes = Vec::new();
        let mut vlr_count = 0u32;
        let mut raw_format = format;
        let mut laz_vlr_bytes = Vec::new();
        if laz {
            let items = laz::LazItemRecordBuilder::default_for_point_format_id(format, 0).unwrap();
            let vlr = laz::LazVlrBuilder::new(items).with_fixed_chunk_size(5000).build();
            vlr.write_to(&mut laz_vlr_bytes).unwrap();
            let mut hdr = vec![0u8; 54];
            hdr[2..2 + LASZIP_USER_ID.len()].copy_from_slice(LASZIP_USER_ID.as_bytes());
            hdr[18..20].copy_from_slice(&LASZIP_RECORD_ID.to_le_bytes());
            hdr[20..22].copy_from_slice(&(laz_vlr_bytes.len() as u16).to_le_bytes());
            vlr_bytes.extend(hdr);
            vlr_bytes.extend(&laz_vlr_bytes);
            vlr_count = 1;
            raw_format |= 0x80;
        }
        let data_offset = header_size + vlr_bytes.len();
        let mut f = vec![0u8; header_size];
        f[0..4].copy_from_slice(b"LASF");
        f[24] = 1;
        f[25] = minor;
        f[94..96].copy_from_slice(&(header_size as u16).to_le_bytes());
        f[96..100].copy_from_slice(&(data_offset as u32).to_le_bytes());
        f[100..104].copy_from_slice(&vlr_count.to_le_bytes());
        f[104] = raw_format;
        f[105..107].copy_from_slice(&(rec_len as u16).to_le_bytes());
        let n = pts.len() as u32;
        // 1.4: Formate 6+ tragen die Zahl nur im 64-Bit-Feld.
        f[107..111].copy_from_slice(&(if format >= 6 { 0 } else { n }).to_le_bytes());
        if minor >= 4 {
            f[247..255].copy_from_slice(&(pts.len() as u64).to_le_bytes());
        }
        for i in 0..3 {
            f[131 + 8 * i..139 + 8 * i].copy_from_slice(&SCALE.to_le_bytes());
            f[155 + 8 * i..163 + 8 * i].copy_from_slice(&off[i].to_le_bytes());
        }
        let coord = |sel: fn(&P) -> f64| {
            let (mut lo, mut hi) = (f64::INFINITY, f64::NEG_INFINITY);
            for p in pts {
                lo = lo.min(sel(p));
                hi = hi.max(sel(p));
            }
            (lo, hi)
        };
        for (i, sel) in [(0usize, (|p: &P| p.x) as fn(&P) -> f64), (1, |p| p.y), (2, |p| p.z)] {
            let (lo, hi) = coord(sel);
            f[179 + 16 * i..187 + 16 * i].copy_from_slice(&hi.to_le_bytes());
            f[187 + 16 * i..195 + 16 * i].copy_from_slice(&lo.to_le_bytes());
        }
        f.extend(vlr_bytes);
        if laz {
            let vlr = laz::LazVlr::from_buffer(&laz_vlr_bytes).unwrap();
            let mut cur = std::io::Cursor::new(f);
            cur.set_position(data_offset as u64);
            use std::io::Seek;
            cur.seek(std::io::SeekFrom::Start(data_offset as u64)).unwrap();
            laz::compress_buffer(&mut cur, &recs, vlr).unwrap();
            cur.into_inner()
        } else {
            f.extend(recs);
            f
        }
    }

    pub fn sample(n: usize) -> Vec<P> {
        (0..n)
            .map(|k| P {
                x: 2_683_000.0 + (k % 100) as f64 * 0.1,
                y: 1_248_000.0 + (k / 100) as f64 * 0.1,
                z: 410.0 + (k % 7) as f64 * 0.25,
                i: (k % 1000) as u16,
                c: [2, 3, 5, 6, 9][k % 5],
                rgb: [(k % 256) as u16 * 257, 1000, 65535],
            })
            .collect()
    }

    fn check_roundtrip(minor: u8, format: u8, laz: bool) {
        let pts = sample(1234);
        let data = make_las(minor, format, &pts, laz);
        let (c, r) = read_las(&data, Options::default()).unwrap();
        assert_eq!(r.format, if laz { "laz" } else { "las" });
        assert_eq!(r.version, format!("1.{minor}"));
        assert_eq!(r.points_declared, 1234);
        assert_eq!(c.len(), 1234);
        for (k, p) in pts.iter().enumerate() {
            assert!((c.origin[0] + c.xyz[3 * k] as f64 - p.x).abs() < 2e-3, "x {k}");
            assert!((c.origin[1] + c.xyz[3 * k + 1] as f64 - p.y).abs() < 2e-3, "y {k}");
            assert!((c.origin[2] + c.xyz[3 * k + 2] as f64 - p.z).abs() < 2e-3, "z {k}");
            assert_eq!(c.intensity[k], p.i);
            assert_eq!(c.classification[k], p.c);
        }
        // Origin liegt nahe der Wolke → f32 reicht für mm.
        assert!(c.xyz.iter().all(|v| v.abs() < 100.0));
        if layout(format).rgb.is_some() {
            assert_eq!(c.rgb.len(), 1234 * 3);
            assert_eq!(c.rgb[0], 0);
            assert_eq!(c.rgb[1], (1000u16 >> 8) as u8);
            assert_eq!(c.rgb[2], 255);
        } else {
            assert!(c.rgb.is_empty());
        }
        assert!((r.bbox_min[0] - 2_683_000.0).abs() < 1e-6);
        assert!((r.bbox_max[1] - (1_248_000.0 + 12.0 * 0.1)).abs() < 1e-6);
        assert_eq!(r.class_counts.iter().map(|c| c[1]).sum::<u64>(), 1234);
    }

    #[test]
    fn las_roundtrip_formats_and_versions() {
        for (minor, format) in [(0, 0), (1, 1), (2, 2), (2, 3), (3, 1), (4, 0), (4, 6), (4, 7), (4, 8)] {
            check_roundtrip(minor, format, false);
        }
    }

    #[test]
    fn laz_roundtrip_formats() {
        for (minor, format) in [(2, 0), (2, 1), (2, 2), (2, 3), (4, 6), (4, 7), (4, 8)] {
            check_roundtrip(minor, format, true);
        }
    }

    #[test]
    fn thinning_las() {
        let pts = sample(10_000);
        let data = make_las(2, 1, &pts, false);
        // 100 x 100 Raster à 0,1 m; Voxel 1 m → 10 x 10 (z variiert, Voxel ist 3D: z 410…411,5 → 2 Zellen).
        let (c, r) = read_las(&data, Options { voxel: 1.0, max_points: 0 }).unwrap();
        assert_eq!(r.points_read, 10_000);
        assert!(c.len() >= 100 && c.len() <= 300, "len {}", c.len());
        let (c, r) = read_las(&data, Options { voxel: 0.0, max_points: 500 }).unwrap();
        assert!(c.len() <= 500);
        assert_eq!(r.points_kept as usize, c.len());
        assert!(r.voxel > 0.0);
    }

    #[test]
    fn crs_from_geokeys() {
        let mut dir = vec![0u8; 8 + 8];
        dir[0..2].copy_from_slice(&1u16.to_le_bytes());
        dir[6..8].copy_from_slice(&1u16.to_le_bytes());
        dir[8..10].copy_from_slice(&3072u16.to_le_bytes());
        dir[14..16].copy_from_slice(&2056u16.to_le_bytes());
        let v = Vlr { user: "LASF_Projection".into(), id: 34735, data: &dir };
        assert_eq!(find_epsg(&[v]), Some(2056));
        let wkt = br#"PROJCRS["CH1903+ / LV95",ID["EPSG",2056]]"#;
        let v = Vlr { user: "LASF_Projection".into(), id: 2112, data: wkt };
        assert_eq!(find_epsg(&[v]), Some(2056));
    }

    #[test]
    fn truncated_las_keeps_complete_points() {
        let pts = sample(100);
        let mut data = make_las(2, 1, &pts, false);
        data.truncate(data.len() - 28 * 10 - 5);
        let (c, r) = read_las(&data, Options::default()).unwrap();
        assert_eq!(c.len(), 89);
        assert!(r.truncated);
    }

    #[test]
    fn broken_files_are_errors_without_panic() {
        let good = make_las(2, 3, &sample(50), false);
        let laz = make_las(2, 1, &sample(50), true);
        // Jede Kürzung und jedes verfälschte Kopfbyte: kein Panic.
        for data in [&good, &laz] {
            for cut in (0..data.len()).step_by(3) {
                let _ = read_las(&data[..cut], Options::default());
            }
            for i in 0..260.min(data.len()) {
                let mut d = data.clone();
                d[i] ^= 0xFF;
                let _ = read_las(&d, Options { voxel: 0.5, max_points: 10 });
            }
        }
        assert!(read_las(b"LASF", Options::default()).is_err());
        let mut d = good.clone();
        d[25] = 9;
        assert!(read_las(&d, Options::default()).is_err());
        let mut d = good.clone();
        d[131..139].copy_from_slice(&0f64.to_le_bytes());
        assert!(read_las(&d, Options::default()).is_err());
        let mut d = laz.clone();
        // LAZ-Daten zerstören: Fehler oder abgeschnitten, kein Panic.
        let n = d.len();
        for b in d[n / 2..].iter_mut() {
            *b = 0xA5;
        }
        let _ = read_las(&d, Options::default());
    }
}
