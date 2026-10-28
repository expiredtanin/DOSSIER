// Gemeinsame Abbildungen für Import und Export (DXF/DWG über acadrust): Ebenenfarben, Format-
// Erkennung. Hier nur Dinge, die beide Richtungen brauchen; je Richtung eigenes Modul.

use acadrust::types::Color;

/// Dunkle Tinte statt Weiss: ACI 7 („weiss/schwarz" je nach Hintergrund) wäre auf dem hellen Plan
/// unsichtbar, daher wie in CAD-Programmen auf dunkle Tinte gekippt.
pub const INK_FOR_WHITE: u32 = 0x1a1a1a;

/// Farbe einer Ebene als `0xRRGGBB` (ACI über die AutoCAD-Tabelle, Echtfarbe direkt). Reines Weiss
/// wird zu [`INK_FOR_WHITE`]. `None` für VonEbene/VonBlock/keine Farbe.
pub fn layer_color_rgb(color: &Color) -> Option<u32> {
    let (r, g, b) = color.rgb()?;
    let rgb = (u32::from(r) << 16) | (u32::from(g) << 8) | u32::from(b);
    Some(if rgb == 0xffffff { INK_FOR_WHITE } else { rgb })
}

/// Dateiformat anhand der ersten Bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceKind {
    Dxf,
    Dwg,
}

/// DWG beginnt mit der Versionskennung `AC1xxx` (R12: `AC1009`, 2018: `AC1032`) bzw. bei sehr
/// alten Dateien `AC2.10`/`AC1.40`; alles andere (ASCII- oder Binär-DXF) gilt als DXF.
pub fn detect_kind(bytes: &[u8]) -> SourceKind {
    if bytes.len() >= 6 && bytes.starts_with(b"AC") && bytes[2..6].iter().all(|b| b.is_ascii_digit() || *b == b'.') {
        SourceKind::Dwg
    } else {
        SourceKind::Dxf
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn farben() {
        assert_eq!(layer_color_rgb(&Color::Index(1)), Some(0xff0000));
        assert_eq!(layer_color_rgb(&Color::Index(7)), Some(INK_FOR_WHITE));
        assert_eq!(layer_color_rgb(&Color::Rgb { r: 1, g: 2, b: 3 }), Some(0x010203));
        assert_eq!(layer_color_rgb(&Color::ByLayer), None);
    }

    #[test]
    fn format_erkennen() {
        assert_eq!(detect_kind(b"AC1032\0\0"), SourceKind::Dwg);
        assert_eq!(detect_kind(b"AC1009"), SourceKind::Dwg);
        assert_eq!(detect_kind(b"  0\nSECTION"), SourceKind::Dxf);
        assert_eq!(detect_kind(b"AutoCAD Binary DXF\r\n\x1a\0"), SourceKind::Dxf);
        assert_eq!(detect_kind(b"AC"), SourceKind::Dxf);
    }
}
