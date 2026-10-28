// E57 (ASTM E2807) lesen über das Crate `e57` (cry-inc/e57, MIT, reines Rust, `forbid(unsafe_code)`,
// s. NOTICE). Alle Scans der Datei werden zusammengeführt; die Pose jedes Scans (Rotation + Translation)
// ist über den vereinfachten Leser bereits angewendet. Kugelkoordinaten werden in kartesische
// umgerechnet, ungültige Punkte (E57 "invalid state") verworfen. Farbe/Intensität werden vom Crate auf
// 0…1 normiert und hier auf 16 Bit gestreckt.

use std::io::Cursor;

use crate::pointcloud::{Attrs, Options, PointCloud, PointReport, Sink};

pub fn read_e57(bytes: &[u8], opts: Options) -> Result<(PointCloud, PointReport), String> {
    let mut reader = e57::E57Reader::new(Cursor::new(bytes)).map_err(|e| format!("E57 unlesbar: {e}"))?;
    let clouds = reader.pointclouds();
    if clouds.is_empty() {
        return Err("E57 enthält keine Punktwolke".into());
    }
    let attrs = Attrs {
        color: clouds.iter().any(|c| c.has_color()),
        intensity: clouds.iter().any(|c| c.has_intensity()),
        class: false,
    };
    let declared: u64 = clouds.iter().map(|c| c.records).sum();
    let mut report = PointReport {
        format: "e57".into(),
        version: {
            let h = reader.header();
            format!("{}.{}", h.major, h.minor)
        },
        points_declared: declared,
        ..Default::default()
    };
    if clouds.len() > 1 {
        report.warnings.push(format!("{} Scans zusammengeführt", clouds.len()));
    }
    if let Some(meta) = reader.coordinate_metadata() {
        // Meist WKT oder PROJ-String; EPSG-Code am Ende, falls genannt.
        if let Some(i) = meta.rfind("EPSG") {
            let digits: String = meta[i..].chars().skip_while(|c| !c.is_ascii_digit()).take_while(|c| c.is_ascii_digit()).collect();
            report.epsg = digits.parse().ok();
        }
    }
    let mut sink = Sink::new(opts, attrs, None);
    sink.reserve_hint(declared);
    for pc in &clouds {
        let it = reader.pointcloud_simple(pc).map_err(|e| format!("E57-Scan unlesbar: {e}"))?;
        for p in it {
            let p = match p {
                Ok(p) => p,
                Err(e) => {
                    // Mitten im Strom kaputt: bisher Gelesenes behalten.
                    report.truncated = true;
                    report.warnings.push(format!("E57-Daten brachen ab: {e}"));
                    break;
                }
            };
            let xyz = match p.cartesian {
                e57::CartesianCoordinate::Valid { x, y, z } => [x, y, z],
                _ => {
                    sink.count_invalid();
                    continue;
                }
            };
            let u = |v: f32| (v.clamp(0.0, 1.0) * 65535.0).round() as u16;
            let rgb = p.color.map(|c| [u(c.red), u(c.green), u(c.blue)]).unwrap_or([0; 3]);
            let inten = p.intensity.map(u).unwrap_or(0);
            sink.push(xyz, rgb, inten, 0);
        }
    }
    sink.finish(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use e57::{E57Writer, Record, RecordValue};

    fn make(n: usize, color: bool) -> Vec<u8> {
        let mut out = Cursor::new(Vec::new());
        {
            let mut w = E57Writer::new(&mut out, "guid-file").unwrap();
            let mut proto = vec![Record::CARTESIAN_X_F64, Record::CARTESIAN_Y_F64, Record::CARTESIAN_Z_F64, Record::INTENSITY_UNIT_F32];
            if color {
                proto.extend([Record::COLOR_RED_U8, Record::COLOR_GREEN_U8, Record::COLOR_BLUE_U8]);
            }
            let mut pw = w.add_pointcloud("guid-pc", proto).unwrap();
            for k in 0..n {
                let mut v = vec![
                    RecordValue::Double(2_600_000.0 + (k % 50) as f64 * 0.1),
                    RecordValue::Double(1_200_000.0 + (k / 50) as f64 * 0.1),
                    RecordValue::Double(400.0 + (k % 3) as f64),
                    RecordValue::Single(0.5),
                ];
                if color {
                    v.extend([RecordValue::Integer(255), RecordValue::Integer(0), RecordValue::Integer(128)]);
                }
                pw.add_point(v).unwrap();
            }
            pw.finalize().unwrap();
            w.finalize().unwrap();
        }
        out.into_inner()
    }

    #[test]
    fn e57_roundtrip() {
        let data = make(500, true);
        let (c, r) = read_e57(&data, Options::default()).unwrap();
        assert_eq!(r.format, "e57");
        assert_eq!(c.len(), 500);
        assert_eq!(r.points_declared, 500);
        assert!(r.has_color && r.has_intensity);
        assert_eq!(&c.rgb[..3], &[255, 0, 128]);
        assert!(c.intensity.iter().all(|&i| (i as i32 - 32768).abs() < 2));
        assert!((c.origin[0] + c.xyz[3] as f64 - 2_600_000.1).abs() < 1e-3);
        assert!((r.bbox_max[2] - 402.0).abs() < 1e-9);
    }

    #[test]
    fn e57_thinning_and_no_color() {
        let data = make(500, false);
        let (c, r) = read_e57(&data, Options { voxel: 0.0, max_points: 100 }).unwrap();
        assert!(c.len() <= 100);
        assert_eq!(r.points_read, 500);
        assert!(!r.has_color);
    }

    #[test]
    fn e57_broken_is_error_without_panic() {
        let data = make(200, true);
        for cut in (0..data.len()).step_by(97) {
            let _ = read_e57(&data[..cut], Options::default());
        }
        for i in (0..data.len()).step_by(53) {
            let mut d = data.clone();
            d[i] ^= 0xFF;
            let _ = read_e57(&d, Options::default());
        }
        assert!(read_e57(b"ASTM-E57", Options::default()).is_err());
    }
}
