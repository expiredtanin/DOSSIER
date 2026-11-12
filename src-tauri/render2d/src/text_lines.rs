// Textzeilen fuer den Glyphen-Pass (`glyph.rs`) — GPU-frei, damit Lesen/Pruefen ohne Feature testbar
// bleibt. Die Zeilen setzt der Kern (`core/src/plan/text.rs`, Bindung `plan_screen_texts`); die native
// macOS-Flaeche bekommt sie als rohe f64-Bytes (`native2d_scene_texts`), der Szenen-Pfad aus der Szene.

use crate::types::{Rgba, TextAlign, STYLE_BOLD, STYLE_ITALIC};

/// EINE Textzeile in Modell-Metern (doppelte Genauigkeit, auch bei Landeskoordinaten).
#[derive(Clone, Debug, PartialEq)]
pub struct GlyphLine {
    /// Anker X gemaess `align`, Y = Baseline (Modell-Meter).
    pub x: f64,
    pub y: f64,
    pub content: String,
    /// Schriftgroesse in Papier-mm beim Massstab, zu dem die Zeilen gesetzt wurden.
    pub size_mm: f32,
    pub color: Rgba,
    pub align: TextAlign,
    /// `STYLE_BOLD` | `STYLE_ITALIC`.
    pub style: u32,
}

impl From<&crate::types::Text> for GlyphLine {
    fn from(t: &crate::types::Text) -> Self {
        GlyphLine { x: t.pos[0] as f64, y: t.pos[1] as f64, content: t.content.clone(), size_mm: t.size_mm, color: t.color, align: t.align, style: t.style }
    }
}

/// Zeilen aus dem Format der Kern-Bindung `plan_screen_texts` (f64, little-endian):
/// `[n, (x, y, sizeMm, r, g, b, a, code, nUtf16)*, UTF-16-Einheiten…]`, `code` = Ausrichtung |
/// Schnitt << 8. `None` bei kaputtem Puffer (nie Panic).
pub fn lines_from_f64(f: &[f64]) -> Option<Vec<GlyphLine>> {
    let n = *f.first()?;
    if !(n.is_finite() && n >= 0.0 && n.fract() == 0.0) {
        return None;
    }
    let n = n as usize;
    let head_end = n.checked_mul(9)?.checked_add(1)?;
    if head_end > f.len() {
        return None;
    }
    let mut out = Vec::with_capacity(n);
    let mut u = head_end;
    for k in 0..n {
        let r = &f[1 + k * 9..1 + k * 9 + 9];
        let len = r[8];
        if !(len.is_finite() && len >= 0.0 && len.fract() == 0.0) || r[..8].iter().any(|v| !v.is_finite()) {
            return None;
        }
        let end = u.checked_add(len as usize).filter(|&e| e <= f.len())?;
        let units: Vec<u16> = f[u..end].iter().map(|&v| v as u16).collect();
        u = end;
        let code = r[7] as u32;
        let align = match code & 0xff {
            0 => TextAlign::Left,
            1 => TextAlign::Center,
            2 => TextAlign::Right,
            _ => return None,
        };
        out.push(GlyphLine {
            x: r[0],
            y: r[1],
            content: String::from_utf16_lossy(&units),
            size_mm: r[2] as f32,
            color: [r[3] as f32, r[4] as f32, r[5] as f32, r[6] as f32],
            align,
            style: (code >> 8) & (STYLE_BOLD | STYLE_ITALIC),
        });
    }
    Some(out)
}

/// Dasselbe aus rohen Bytes (Tauri-Aufruf mit Binaer-Body).
pub fn lines_from_bytes(bytes: &[u8]) -> Option<Vec<GlyphLine>> {
    if bytes.len() % 8 != 0 {
        return None;
    }
    let f: Vec<f64> = bytes.chunks_exact(8).map(|c| f64::from_le_bytes(c.try_into().unwrap())).collect();
    lines_from_f64(&f)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(x: f64, code: f64, text: &str) -> (Vec<f64>, Vec<f64>) {
        let units: Vec<f64> = text.encode_utf16().map(f64::from).collect();
        (vec![x, 2.0, 2.5, 0.1, 0.2, 0.3, 1.0, code, units.len() as f64], units)
    }

    #[test]
    fn zeilen_aus_kern_puffer() {
        let (a, ua) = rec(1.0, 1.0 + 256.0, "Wohnen");
        let (b, ub) = rec(2_600_000.25, 2.0, "17.01 m²");
        let mut f = vec![2.0];
        f.extend(a);
        f.extend(b);
        f.extend(ua);
        f.extend(ub);
        let l = lines_from_f64(&f).unwrap();
        assert_eq!(l.len(), 2);
        assert_eq!((l[0].content.as_str(), l[0].align, l[0].style), ("Wohnen", TextAlign::Center, STYLE_BOLD));
        assert_eq!((l[1].content.as_str(), l[1].align, l[1].style), ("17.01 m²", TextAlign::Right, 0));
        // Landeskoordinaten bleiben in doppelter Genauigkeit.
        assert_eq!(l[1].x, 2_600_000.25);
        let bytes: Vec<u8> = f.iter().flat_map(|v| v.to_le_bytes()).collect();
        assert_eq!(lines_from_bytes(&bytes).unwrap(), l);
    }

    #[test]
    fn kaputte_puffer_ergeben_none() {
        assert!(lines_from_f64(&[]).is_none());
        assert!(lines_from_f64(&[f64::NAN]).is_none());
        assert!(lines_from_f64(&[1.0, 0.0]).is_none()); // zu kurz
        let (mut a, u) = rec(0.0, 7.0, "x"); // Ausrichtung unbekannt
        a.insert(0, 1.0);
        a.extend(u);
        assert!(lines_from_f64(&a).is_none());
        let (mut a, _) = rec(0.0, 0.0, "xyz"); // Zeichen fehlen
        a.insert(0, 1.0);
        assert!(lines_from_f64(&a).is_none());
        assert!(lines_from_bytes(&[0u8; 7]).is_none());
        assert_eq!(lines_from_f64(&[0.0]).unwrap(), vec![]);
    }
}
