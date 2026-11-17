//! [215] Nachbearbeitung des Cycles-Bildes: lineares Licht (EXR, Fliesskomma) → Tonwert → sRGB, 8 Bit.
//!
//! Das Standalone-Programm `cycles` hat weder Tonwert-Abbildung noch Farbverwaltung (ohne OCIO gebaut, s. `doc/CYCLES.md`):
//! ein PNG von ihm wäre lineares Licht in 8 Bit. Dossier rechnet darum selbst. Die Belichtung steckt schon in der Szene
//! (`<film exposure>`, `cycles_scene.rs`); hier gibt es nur einen optionalen Zusatz in EV.
//!
//! Look `filmic` (Standard; ein einfacher Verlauf in der Art von Filmic/AgX, ohne Tabellen):
//!   1. Helligkeit L = 0.2126 R + 0.7152 G + 0.0722 B; Kurve `aces(x) = x(2.51x + 0.03) / (x(2.43x + 0.59) + 0.14)`
//!      (Narkowicz-Näherung von ACES: weicher Fuss, flache Schulter, 0.18 → 0.27, Weiss läuft aus).
//!   2. Farbton erhalten: Pixel · aces(L)/L; Lichter entsättigen: je heller, desto mehr Anteil der Kurve je Kanal
//!      (Mischung t = L/(1+L)) — sehr helle Farben laufen zu Weiss statt zu knalligem Gelb/Cyan.
//!   3. Begrenzen auf 0…1, sRGB-Übertragungsfunktion, auf 8 Bit runden.
//! Look `standard`: nur begrenzen und sRGB (für Vergleiche und Kontrollen).
//! Unterschied zu AgX in Blender: AgX bleibt auch bei sehr hellen Flächen farbiger und hat mehr Kontrastspielraum; für
//! Architekturbilder (Weiss besonnt ≈ 1.2 nach der Belichtung) genügt der einfache Verlauf. Nicht endliche Werte werden 0.

use crate::jsnum;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Look {
    Filmic,
    Standard,
}

impl Look {
    pub fn parse(s: &str) -> Look {
        if s.eq_ignore_ascii_case("standard") {
            Look::Standard
        } else {
            Look::Filmic
        }
    }
}

fn aces(x: f64) -> f64 {
    (x * (2.51 * x + 0.03) / (x * (2.43 * x + 0.59) + 0.14)).clamp(0.0, 1.0)
}

/// Lineares sRGB → Anzeigewert (Übertragungsfunktion).
fn oetf(x: f64) -> f64 {
    let x = x.clamp(0.0, 1.0);
    if x <= 0.003_130_8 {
        x * 12.92
    } else {
        1.055 * jsnum::pow(x, 1.0 / 2.4) - 0.055
    }
}

/// Ein Pixel: lineares RGB (Szenenwerte) → 8 Bit sRGB.
pub fn tonemap_pixel(rgb: [f64; 3], ev: f64, look: Look) -> [u8; 3] {
    let gain = if ev.is_finite() && ev != 0.0 { jsnum::pow(2.0, ev.clamp(-16.0, 16.0)) } else { 1.0 };
    let c = rgb.map(|v| if v.is_finite() { v.max(0.0) * gain } else { 0.0 });
    let out = match look {
        Look::Standard => c,
        Look::Filmic => {
            let l = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
            let ratio = if l > 1e-9 { aces(l) / l } else { 0.0 };
            let t = l / (1.0 + l);
            [0, 1, 2].map(|k| (c[k] * ratio * (1.0 - t) + aces(c[k]) * t).clamp(0.0, 1.0))
        }
    };
    out.map(|v| (oetf(v) * 255.0 + 0.5).floor().clamp(0.0, 255.0) as u8)
}

/// Pixelpuffer (RGB oder RGBA, Fliesskomma, zeilenweise von oben) → RGB 8 Bit. Ein Puffer mit anderer Kanalzahl oder
/// unvollständigen Pixeln ergibt einen leeren Puffer (nie Panic).
pub fn tonemap(data: &[f32], channels: usize, ev: f64, look: Look) -> Vec<u8> {
    if !(channels == 3 || channels == 4) || data.is_empty() || data.len() % channels != 0 {
        return Vec::new();
    }
    let mut out = Vec::with_capacity(data.len() / channels * 3);
    for px in data.chunks_exact(channels) {
        out.extend_from_slice(&tonemap_pixel([f64::from(px[0]), f64::from(px[1]), f64::from(px[2])], ev, look));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schwarz_bleibt_schwarz_weiss_laeuft_aus() {
        assert_eq!(tonemap_pixel([0.0; 3], 0.0, Look::Filmic), [0, 0, 0]);
        let hi = tonemap_pixel([50.0; 3], 0.0, Look::Filmic);
        assert_eq!(hi, [255, 255, 255]);
        // Weisser Putz nach der Belichtung (≈ 1.2) liegt unter Weiss, Mittelgrau (0.27) in der Mitte.
        let putz = tonemap_pixel([1.2; 3], 0.0, Look::Filmic)[0];
        let grau = tonemap_pixel([0.27; 3], 0.0, Look::Filmic)[0];
        assert!((220..=255).contains(&putz), "{putz}");
        assert!((110..=170).contains(&grau), "{grau}");
    }

    #[test]
    fn monoton_und_farbton_erhalten() {
        let mut last = 0;
        for i in 0..200 {
            let v = tonemap_pixel([f64::from(i) * 0.02; 3], 0.0, Look::Filmic)[1];
            assert!(v >= last, "bei {i}");
            last = v;
        }
        // Rotstich bleibt rot (mittlere Helligkeit), sehr helles Rot läuft Richtung Weiss.
        let rot = tonemap_pixel([0.6, 0.1, 0.1], 0.0, Look::Filmic);
        assert!(rot[0] > rot[1] + 60 && rot[1] == rot[2], "{rot:?}");
        let hell = tonemap_pixel([30.0, 3.0, 3.0], 0.0, Look::Filmic);
        assert!(hell[1] > rot[1], "Lichter entsättigen: {hell:?}");
    }

    #[test]
    fn zusatzbelichtung_in_ev() {
        let a = tonemap_pixel([0.2; 3], 0.0, Look::Standard)[0];
        let b = tonemap_pixel([0.1; 3], 1.0, Look::Standard)[0];
        assert_eq!(a, b, "ein Blendenwert mehr = doppelt so hell");
        // sRGB-Punkte: 0.2140411 linear = 0.5 → 128.
        assert!((127..=128).contains(&tonemap_pixel([0.2140411; 3], 0.0, Look::Standard)[0]));
    }

    #[test]
    fn kaputte_eingaben_ohne_panik() {
        assert!(tonemap(&[], 3, 0.0, Look::Filmic).is_empty());
        assert!(tonemap(&[1.0, 1.0], 3, 0.0, Look::Filmic).is_empty());
        assert!(tonemap(&[1.0; 6], 2, 0.0, Look::Filmic).is_empty());
        let o = tonemap(&[f32::NAN, f32::INFINITY, -1.0, 1.0, 1.0, 1.0, 1.0, 1.0], 4, f64::NAN, Look::Filmic);
        assert_eq!(o.len(), 6);
        assert_eq!(&o[..3], &[0, 0, 0]);
        assert_eq!(tonemap(&[0.5; 8], 4, 0.0, Look::Filmic).len(), 6, "RGBA → RGB");
    }
}
