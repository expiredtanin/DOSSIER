//! Bilder auf Layout-Blättern ([208]): Kopfdaten (Format, Pixelgrösse) aus einer Data-URL lesen, Seitenverhältnis,
//! Zeichen- und Klipp-Rechteck mit Zuschnitt, Startgrösse auf dem Blatt und Auflösung (dpi). Die Bytes selbst
//! bleiben unverändert (PDF bettet JPEG ohne Neukompression ein); hier wird nichts dekodiert ausser dem Kopf.

use serde::Serialize;

/// Format und Pixelgrösse eines Bilds.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ImageInfo {
    /// "image/png" oder "image/jpeg".
    pub mime: String,
    pub width: u32,
    pub height: u32,
}

fn b64_val(c: u8) -> Option<u8> {
    match c {
        b'A'..=b'Z' => Some(c - b'A'),
        b'a'..=b'z' => Some(c - b'a' + 26),
        b'0'..=b'9' => Some(c - b'0' + 52),
        b'+' | b'-' => Some(62),
        b'/' | b'_' => Some(63),
        _ => None,
    }
}

/// Base64 (Standard und URL-sicher, Leerraum und Füllzeichen ignoriert); `None` bei Unsinn.
pub fn base64_decode(s: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(s.len() / 4 * 3);
    let (mut acc, mut bits) = (0u32, 0u32);
    for &c in s.as_bytes() {
        if c == b'=' || c.is_ascii_whitespace() {
            continue;
        }
        acc = (acc << 6) | u32::from(b64_val(c)?);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    Some(out)
}

/// Bytes einer `data:image/…;base64,…`-URL.
pub fn data_url_bytes(src: &str) -> Option<Vec<u8>> {
    let rest = src.strip_prefix("data:")?;
    let (head, body) = rest.split_once(',')?;
    if !head.ends_with(";base64") {
        return None;
    }
    base64_decode(body)
}

/// Format und Grösse aus den Bytes (PNG: IHDR, JPEG: erster Start-of-Frame-Marker).
pub fn image_info_bytes(b: &[u8]) -> Option<ImageInfo> {
    if b.len() >= 24 && b[..8] == [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a] && &b[12..16] == b"IHDR" {
        let w = u32::from_be_bytes([b[16], b[17], b[18], b[19]]);
        let h = u32::from_be_bytes([b[20], b[21], b[22], b[23]]);
        return (w > 0 && h > 0).then(|| ImageInfo { mime: "image/png".into(), width: w, height: h });
    }
    if b.len() >= 4 && b[0] == 0xff && b[1] == 0xd8 {
        let mut i = 2;
        while i + 4 <= b.len() {
            if b[i] != 0xff {
                i += 1;
                continue;
            }
            let m = b[i + 1];
            if m == 0xff {
                i += 1;
                continue;
            }
            // Marker ohne Länge
            if m == 0xd8 || m == 0x01 || (0xd0..=0xd7).contains(&m) {
                i += 2;
                continue;
            }
            let len = usize::from(u16::from_be_bytes([b[i + 2], b[i + 3]]));
            if (0xc0..=0xcf).contains(&m) && m != 0xc4 && m != 0xc8 && m != 0xcc {
                if i + 9 > b.len() {
                    return None;
                }
                let h = u32::from(u16::from_be_bytes([b[i + 5], b[i + 6]]));
                let w = u32::from(u16::from_be_bytes([b[i + 7], b[i + 8]]));
                return (w > 0 && h > 0).then(|| ImageInfo { mime: "image/jpeg".into(), width: w, height: h });
            }
            i += 2 + len.max(2);
        }
    }
    None
}

/// Format und Grösse einer Data-URL.
pub fn image_info(src: &str) -> Option<ImageInfo> {
    image_info_bytes(&data_url_bytes(src)?)
}

/// Rechteck in Papier-mm.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// Zuschnitt als Anteile des Originals `(x, y, w, h)`, auf sinnvolle Werte begrenzt (mindestens 1 % Kantenlänge).
pub fn clamp_crop(c: Option<(f64, f64, f64, f64)>) -> (f64, f64, f64, f64) {
    let Some((x, y, w, h)) = c else { return (0.0, 0.0, 1.0, 1.0) };
    if ![x, y, w, h].iter().all(|v| v.is_finite()) {
        return (0.0, 0.0, 1.0, 1.0);
    }
    let x = x.clamp(0.0, 0.99);
    let y = y.clamp(0.0, 0.99);
    let w = w.clamp(0.01, 1.0 - x);
    let h = h.clamp(0.01, 1.0 - y);
    (x, y, w, h)
}

/// Seitenverhältnis (Breite/Höhe) des gezeigten Ausschnitts.
pub fn aspect(px_w: f64, px_h: f64, crop: Option<(f64, f64, f64, f64)>) -> f64 {
    let (_, _, cw, ch) = clamp_crop(crop);
    if px_w > 0.0 && px_h > 0.0 {
        (px_w * cw) / (px_h * ch)
    } else {
        1.0
    }
}

/// Zeichen- und Klipp-Rechteck: `clip` = der Rahmen auf dem Blatt, `draw` = das GANZE Original so gelegt, dass
/// der Zuschnitt genau den Rahmen füllt (das PDF setzt das Bild dorthin und klippt auf `clip`).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Geometry {
    pub clip: Rect,
    pub draw: Rect,
    /// Auflösung des gezeigten Ausschnitts auf dem Blatt in dpi (Pixel je Zoll).
    pub dpi: f64,
}

pub fn geometry(frame: Rect, px_w: f64, crop: Option<(f64, f64, f64, f64)>) -> Geometry {
    let (cx, cy, cw, ch) = clamp_crop(crop);
    let full_w = frame.w / cw;
    let full_h = frame.h / ch;
    let draw = Rect { x: frame.x - cx * full_w, y: frame.y - cy * full_h, w: full_w, h: full_h };
    let dpi = if frame.w > 0.0 { px_w * cw / (frame.w / 25.4) } else { 0.0 };
    Geometry { clip: frame, draw, dpi }
}

/// Startrahmen eines neuen Bilds: so gross wie möglich in `max_frac` des Blatts, Seitenverhältnis gehalten, mittig.
pub fn initial_frame(px_w: f64, px_h: f64, sheet_w: f64, sheet_h: f64, max_frac: f64) -> Rect {
    let a = aspect(px_w, px_h, None);
    let (bw, bh) = (sheet_w * max_frac, sheet_h * max_frac);
    let (w, h) = if bw / bh > a { (bh * a, bh) } else { (bw, bw / a) };
    Rect { x: (sheet_w - w) / 2.0, y: (sheet_h - h) / 2.0, w, h }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 1×1-PNG (rot).
    const PNG_1X1: &str = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

    fn png_header(w: u32, h: u32) -> Vec<u8> {
        let mut v = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, b'I', b'H', b'D', b'R'];
        v.extend_from_slice(&w.to_be_bytes());
        v.extend_from_slice(&h.to_be_bytes());
        v
    }

    #[test]
    fn png_kopf() {
        let i = image_info(PNG_1X1).unwrap();
        assert_eq!((i.mime.as_str(), i.width, i.height), ("image/png", 1, 1));
        let i = image_info_bytes(&png_header(4000, 2250)).unwrap();
        assert_eq!((i.width, i.height), (4000, 2250));
    }

    #[test]
    fn jpeg_kopf_ueberspringt_andere_segmente() {
        // SOI, APP0 (Länge 16), DHT (C4, darf nicht als Frame zählen), SOF0 480×640
        let mut b = vec![0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10];
        b.extend_from_slice(&[0u8; 14]);
        b.extend_from_slice(&[0xff, 0xc4, 0x00, 0x04, 0, 0]);
        b.extend_from_slice(&[0xff, 0xc0, 0x00, 0x11, 8, 0x02, 0x80, 0x01, 0xe0, 3]);
        let i = image_info_bytes(&b).unwrap();
        assert_eq!((i.mime.as_str(), i.width, i.height), ("image/jpeg", 480, 640));
    }

    #[test]
    fn unsinn_liefert_nichts() {
        assert!(image_info("data:image/png;base64,@@@").is_none());
        assert!(image_info("hallo").is_none());
        assert!(image_info("data:image/png;base64,AAAA").is_none());
        assert!(image_info_bytes(&[0xff, 0xd8, 0xff]).is_none());
        assert!(image_info_bytes(&png_header(0, 5)).is_none());
    }

    #[test]
    fn base64_wie_standard() {
        assert_eq!(base64_decode("TWFu").unwrap(), b"Man");
        assert_eq!(base64_decode("TWE=").unwrap(), b"Ma");
        assert_eq!(base64_decode("TQ").unwrap(), b"M");
    }

    #[test]
    fn seitenverhaeltnis_mit_zuschnitt() {
        assert_eq!(aspect(4000.0, 2000.0, None), 2.0);
        // Mitte-Hälfte der Breite: 2000×2000 → quadratisch
        assert_eq!(aspect(4000.0, 2000.0, Some((0.25, 0.0, 0.5, 1.0))), 1.0);
        assert_eq!(aspect(0.0, 0.0, None), 1.0);
        assert_eq!(aspect(10.0, 10.0, Some((f64::NAN, 0.0, 1.0, 1.0))), 1.0);
    }

    #[test]
    fn zeichenrechteck_fuellt_den_rahmen_mit_dem_zuschnitt() {
        let frame = Rect { x: 100.0, y: 50.0, w: 200.0, h: 100.0 };
        let g = geometry(frame, 4000.0, None);
        assert_eq!(g.draw, frame);
        assert!((g.dpi - 4000.0 / (200.0 / 25.4)).abs() < 1e-9);
        // rechte Hälfte: das ganze Bild ist doppelt so breit, beginnt links vom Rahmen
        let g = geometry(frame, 4000.0, Some((0.5, 0.0, 0.5, 1.0)));
        assert_eq!(g.draw, Rect { x: 100.0 - 200.0, y: 50.0, w: 400.0, h: 100.0 });
        assert_eq!(g.clip, frame);
    }

    #[test]
    fn startrahmen_haelt_verhaeltnis_und_passt_ins_blatt() {
        let r = initial_frame(3000.0, 2000.0, 841.0, 594.0, 0.6);
        assert!((r.w / r.h - 1.5).abs() < 1e-9);
        assert!(r.w <= 841.0 * 0.6 + 1e-9 && r.h <= 594.0 * 0.6 + 1e-9);
        assert!((r.x + r.w / 2.0 - 420.5).abs() < 1e-9 && (r.y + r.h / 2.0 - 297.0).abs() < 1e-9);
        let hoch = initial_frame(1000.0, 4000.0, 841.0, 594.0, 0.6);
        assert!((hoch.h - 594.0 * 0.6).abs() < 1e-9);
    }
}
