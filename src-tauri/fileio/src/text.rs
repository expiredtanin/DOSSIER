// Texte aus DXF/DWG für den Import: MTEXT-Formatcodes, %%-Sonderzeichen, Ausrichtung und Breite.
//
// Importierte Texte haben im Dossier keine Ausrichtung (`ImportedText`: Grundlinien-Anfang, Höhe,
// Winkel). Darum rechnet dieses Modul Ausrichtpunkt (TEXT 72/73, MTEXT-Anhängepunkt, ATTRIB) auf den
// Grundlinien-Anfang um. Die Textbreite ist dafür eine SCHÄTZUNG (die Schrift der Datei steht nicht
// zur Verfügung): mittlere Zeichenbreiten einer Proportionalschrift, bei Grossbuchstaben/Ziffern/
// schmalen Zeichen angepasst. Fehler von ±10 % verschieben zentrierte Texte also um wenige Prozent
// ihrer Länge — für Kontextgeometrie vertretbar.
//
// Reine Funktionen, keine Abhängigkeit von acadrust: einzeln testbar.

/// Zeilenabstand von MTEXT bei Faktor 1 (Grundlinie zu Grundlinie, in Texthöhen).
pub const LINE_PITCH: f64 = 5.0 / 3.0;
/// Abstand Unterkante (Unterlängen) zur Grundlinie in Texthöhen.
pub const DESCENT: f64 = 0.25;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HAlign {
    Left,
    Center,
    Right,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VAlign {
    Baseline,
    Bottom,
    Middle,
    Top,
}

/// Breite eines Zeichens in Texthöhen (Schätzwert, s. Dateikopf).
fn char_width(c: char) -> f64 {
    match c {
        'i' | 'l' | 'j' | '.' | ',' | ':' | ';' | '\'' | '|' | '!' | '`' => 0.28,
        ' ' => 0.32,
        'f' | 't' | 'r' | 'I' | '(' | ')' | '[' | ']' | '-' | '/' => 0.38,
        'm' | 'w' => 0.85,
        'M' | 'W' => 0.9,
        '0'..='9' => 0.58,
        c if c.is_ascii_uppercase() => 0.68,
        c if c.is_ascii_lowercase() => 0.55,
        // Umlaute, Symbole, CJK: mittlere bis breite Zeichen
        c if (c as u32) >= 0x2e80 => 1.0,
        _ => 0.58,
    }
}

/// Geschätzte Länge eines einzeiligen Textes (Meter) bei Höhe `height` und Breitenfaktor `wf`.
pub fn text_width(s: &str, height: f64, wf: f64) -> f64 {
    let wf = sane_width_factor(wf);
    s.chars().map(char_width).sum::<f64>() * height * wf
}

/// Breitenfaktor: nur endlich und > 0, sonst 1.
pub fn sane_width_factor(wf: f64) -> f64 {
    if wf.is_finite() && wf > 1e-6 {
        wf
    } else {
        1.0
    }
}

/// Grundlinien-Anfang einer Zeile, deren Ausrichtpunkt `anchor` ist. `angle` = Drehung des Textes.
pub fn baseline_start(anchor: [f64; 2], h: HAlign, v: VAlign, width: f64, height: f64, angle: f64) -> [f64; 2] {
    let dx = match h {
        HAlign::Left => 0.0,
        HAlign::Center => -width / 2.0,
        HAlign::Right => -width,
    };
    let dy = match v {
        VAlign::Baseline => 0.0,
        VAlign::Bottom => DESCENT * height,
        VAlign::Middle => -0.5 * height,
        VAlign::Top => -height,
    };
    let (s, c) = angle.sin_cos();
    [anchor[0] + c * dx - s * dy, anchor[1] + s * dx + c * dy]
}

/// Ein Block aus mehreren Zeilen (MTEXT): Grundlinien-Anfang je Zeile. Der Anhängepunkt `anchor`
/// liegt an Ober-/Mittel-/Unterkante des ganzen Blocks, links/mittig/rechts je Zeile.
pub fn layout_block(
    anchor: [f64; 2],
    h: HAlign,
    v: VAlign,
    lines: &[String],
    height: f64,
    wf: f64,
    angle: f64,
    spacing: f64,
) -> Vec<([f64; 2], String)> {
    let n = lines.len();
    if n == 0 {
        return Vec::new();
    }
    let pitch = LINE_PITCH * height * if spacing.is_finite() && spacing > 0.0 { spacing } else { 1.0 };
    // Block von Oberkante der ersten Zeile bis Grundlinie der letzten.
    let block_h = height + (n - 1) as f64 * pitch;
    // y der ersten Grundlinie relativ zum Anhängepunkt (lokal, vor der Drehung).
    let first_dy = match v {
        VAlign::Top => -height,
        VAlign::Middle => block_h / 2.0 - height,
        VAlign::Bottom | VAlign::Baseline => (n - 1) as f64 * pitch + DESCENT * height,
    };
    let (s, c) = angle.sin_cos();
    lines
        .iter()
        .enumerate()
        .map(|(i, line)| {
            let w = text_width(line, height, wf);
            let dx = match h {
                HAlign::Left => 0.0,
                HAlign::Center => -w / 2.0,
                HAlign::Right => -w,
            };
            let dy = first_dy - i as f64 * pitch;
            ([anchor[0] + c * dx - s * dy, anchor[1] + s * dx + c * dy], line.clone())
        })
        .collect()
}

/// Horizontale Ausrichtung von TEXT/ATTRIB (Gruppencode 72).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Hz {
    Left,
    Center,
    Right,
    /// Zwischen zwei Punkten, Höhe passt sich an
    Aligned,
    /// Mitte (horizontal und vertikal)
    Middle,
    /// Zwischen zwei Punkten, Höhe bleibt
    Fit,
}

/// Einzeiliger Text (TEXT/ATTRIB/ATTDEF) → Grundlinien-Anfang, Höhe, Winkel.
///
/// `ins` = Einfügepunkt (Gruppe 10), `align` = Ausrichtpunkt (Gruppe 11, nur bei nicht links/
/// Grundlinie gesetzt). Links/Grundlinie: Einfügepunkt. Zentriert/rechts/oben/mitte/unten: der
/// Ausrichtpunkt ist der Anker. Ausgerichtet/Eingepasst: Text von `ins` nach `align`, Winkel aus
/// den Punkten; „ausgerichtet" skaliert die Höhe mit der Länge (Eingepasst staucht nur die Breite,
/// was hier nicht abbildbar ist — Höhe bleibt).
pub fn place_single(
    value: &str,
    ins: [f64; 2],
    align: Option<[f64; 2]>,
    h: Hz,
    v: VAlign,
    height: f64,
    wf: f64,
    rotation: f64,
) -> ([f64; 2], f64, f64) {
    let align = align.filter(|a| a[0].is_finite() && a[1].is_finite() && (a[0] != 0.0 || a[1] != 0.0));
    let width = text_width(value, height, wf);
    match (h, align) {
        (Hz::Left, _) if v == VAlign::Baseline => (ins, height, rotation),
        (Hz::Left, a) => (baseline_start(a.unwrap_or(ins), HAlign::Left, v, width, height, rotation), height, rotation),
        (Hz::Center, a) => (baseline_start(a.unwrap_or(ins), HAlign::Center, v, width, height, rotation), height, rotation),
        (Hz::Right, a) => (baseline_start(a.unwrap_or(ins), HAlign::Right, v, width, height, rotation), height, rotation),
        (Hz::Middle, a) => {
            (baseline_start(a.unwrap_or(ins), HAlign::Center, VAlign::Middle, width, height, rotation), height, rotation)
        }
        (Hz::Aligned | Hz::Fit, Some(p2)) => {
            let (dx, dy) = (p2[0] - ins[0], p2[1] - ins[1]);
            let dist = dx.hypot(dy);
            if dist < 1e-12 {
                return (ins, height, rotation);
            }
            let angle = dy.atan2(dx);
            let new_h = if h == Hz::Aligned && width > 1e-12 { height * (dist / width).clamp(0.05, 20.0) } else { height };
            (ins, new_h, angle)
        }
        (Hz::Aligned | Hz::Fit, None) => (ins, height, rotation),
    }
}

/// `%%`-Sonderzeichen von TEXT/ATTRIB: `%%c` Ø, `%%d` °, `%%p` ±, `%%%` %, `%%nnn` Zeichen-Code;
/// `%%u`/`%%o`/`%%k` (Unterstrich/Überstrich/Durchstrich) entfallen.
pub fn decode_percent_codes(s: &str) -> String {
    if !s.contains("%%") {
        return s.to_string();
    }
    let chars: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '%' && i + 2 < chars.len() && chars[i + 1] == '%' {
            let c = chars[i + 2];
            match c {
                'c' | 'C' => out.push('Ø'),
                'd' | 'D' => out.push('°'),
                'p' | 'P' => out.push('±'),
                '%' => out.push('%'),
                'u' | 'U' | 'o' | 'O' | 'k' | 'K' => {}
                '0'..='9' => {
                    let digits: String = chars[i + 2..].iter().take(3).take_while(|d| d.is_ascii_digit()).collect();
                    if let Some(ch) = digits.parse::<u32>().ok().and_then(char::from_u32) {
                        out.push(ch);
                        i += 2 + digits.len();
                        continue;
                    }
                }
                _ => {
                    out.push('%');
                    out.push('%');
                    out.push(c);
                }
            }
            i += 3;
            continue;
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

fn superscript(c: char) -> char {
    match c {
        '0' => '⁰',
        '1' => '¹',
        '2' => '²',
        '3' => '³',
        '4' => '⁴',
        '5' => '⁵',
        '6' => '⁶',
        '7' => '⁷',
        '8' => '⁸',
        '9' => '⁹',
        '+' => '⁺',
        '-' => '⁻',
        _ => c,
    }
}

/// Stapel `\S…;` → Text: `a/b` und `a#b` als „a/b", `a^b` ohne Zähler als Hochzahl, sonst „a b".
fn stack_text(body: &str) -> String {
    let Some(pos) = body.find(['/', '#', '^']) else {
        return body.to_string();
    };
    let sep = body[pos..].chars().next().unwrap_or('/');
    let (num, den) = (&body[..pos], &body[pos + sep.len_utf8()..]);
    match sep {
        '^' if num.is_empty() => den.chars().map(superscript).collect(),
        '^' if den.is_empty() => num.to_string(),
        '^' => format!("{num} {den}"),
        _ => format!("{num}/{den}"),
    }
}

/// MTEXT-Inhalt → Zeilen im Klartext. Umgesetzt: `\P`/`\N` Zeilenumbruch, `\~` Leerzeichen,
/// `\U+XXXX`, `\S` Stapel, `\\ \{ \}`, `%%`-Codes; entfernt: `{}`-Gruppen, `\f \F \H \W \T \Q \A \C \c
/// \p …;`, `\L \l \O \o \K \k \X`. Ränder je Zeile ohne Leerraum, leere Zeilen am Ende entfallen (am Anfang bleiben sie: sie verschieben den Text).
pub fn mtext_lines(s: &str) -> Vec<String> {
    let chars: Vec<char> = s.chars().collect();
    let mut lines: Vec<String> = vec![String::new()];
    let mut i = 0;
    let n = chars.len();
    // Position des nächsten ';' vor dem nächsten '\' (Argument-Ende eines Formatcodes).
    let arg_end = |from: usize| -> Option<usize> {
        let mut j = from;
        while j < n {
            match chars[j] {
                ';' => return Some(j),
                '\\' => return None,
                _ => j += 1,
            }
        }
        None
    };
    while i < n {
        let c = chars[i];
        match c {
            '\\' if i + 1 < n => {
                let e = chars[i + 1];
                match e {
                    '\\' | '{' | '}' => {
                        lines.last_mut().map(|l| l.push(e));
                        i += 2;
                    }
                    'P' | 'N' => {
                        lines.push(String::new());
                        i += 2;
                    }
                    '~' => {
                        lines.last_mut().map(|l| l.push(' '));
                        i += 2;
                    }
                    'L' | 'l' | 'O' | 'o' | 'K' | 'k' | 'X' => i += 2,
                    'U' if i + 6 < n && chars[i + 2] == '+' => {
                        let hex: String = chars[i + 3..].iter().take(4).collect();
                        match u32::from_str_radix(&hex, 16).ok().and_then(char::from_u32) {
                            Some(ch) if hex.len() == 4 => {
                                lines.last_mut().map(|l| l.push(ch));
                                i += 7;
                            }
                            _ => i += 2,
                        }
                    }
                    'S' => match arg_end(i + 2) {
                        Some(j) => {
                            let body: String = chars[i + 2..j].iter().collect();
                            let t = stack_text(&body);
                            lines.last_mut().map(|l| l.push_str(&t));
                            i = j + 1;
                        }
                        None => i += 2,
                    },
                    'p' => match arg_end(i + 2) {
                        Some(j) => i = j + 1,
                        None => {
                            // ohne Argumentende: wie früher als Absatz behandeln
                            lines.push(String::new());
                            i += 2;
                        }
                    },
                    'A' | 'C' | 'c' | 'F' | 'f' | 'H' | 'Q' | 'T' | 'W' => match arg_end(i + 2) {
                        Some(j) => i = j + 1,
                        None => i += 2,
                    },
                    _ => {
                        // unbekannter Code: Backslash weg, Zeichen bleibt
                        lines.last_mut().map(|l| l.push(e));
                        i += 2;
                    }
                }
            }
            '{' | '}' => i += 1,
            '\n' => {
                lines.push(String::new());
                i += 1;
            }
            '\r' => i += 1,
            _ => {
                lines.last_mut().map(|l| l.push(c));
                i += 1;
            }
        }
    }
    let mut out: Vec<String> = lines
        .into_iter()
        .map(|l| decode_percent_codes(&l).trim_matches(|ch: char| ch.is_whitespace() || ch == '\u{feff}').to_string())
        .collect();
    while out.last().is_some_and(|l| l.is_empty()) {
        out.pop();
    }
    out
}

/// Klartext in einer Zeile (Zeilen mit Leerzeichen verbunden) — für Stellen, die nur eine Zeile
/// aufnehmen (z. B. Bemassungstext).
pub fn mtext_plain(s: &str) -> String {
    mtext_lines(s).join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_codes() {
        assert_eq!(mtext_lines("{\\fArial|b1;Fett}\\PZeile \\H2x;gross\\P\\S1/2; \\L\\~u\\l"), vec!["Fett", "Zeile gross", "1/2  u"]);
        assert_eq!(mtext_lines("a\\\\b \\{x\\}"), vec!["a\\b {x}"]);
        assert_eq!(mtext_lines("\\pxqc;Mitte\\PRand"), vec!["Mitte", "Rand"]);
        assert_eq!(mtext_lines("m\\S^2;"), vec!["m²"]);
        assert_eq!(mtext_lines("\\U+00B0C und \\U+zzzz"), vec!["°C und +zzzz"]);
        assert_eq!(mtext_lines("\\C1;rot\\c255;blau\\Q15;\\W0.8;\\T2;\\A1;x"), vec!["rotblaux"]);
        assert_eq!(mtext_lines("12%%d, %%c20, %%p0.1, 100%%%"), vec!["12°, Ø20, ±0.1, 100%"]);
        assert_eq!(mtext_lines("\\P\\PA\\P\\P"), vec!["", "", "A"]);
    }

    #[test]
    fn leere_und_kaputte_eingaben() {
        assert!(mtext_lines("").is_empty());
        assert_eq!(mtext_lines("\\"), vec!["\\"]);
        assert_eq!(mtext_lines("ab\\"), vec!["ab\\"]);
        assert_eq!(mtext_lines("\\H2.5"), vec!["2.5"]); // ohne ';' nur der Backslash weg
        assert!(mtext_lines("\\S").is_empty());
    }

    #[test]
    fn prozent_codes() {
        assert_eq!(decode_percent_codes("%%u%%d45%%o"), "°45");
        assert_eq!(decode_percent_codes("%%065B"), "AB");
        assert_eq!(decode_percent_codes("100%"), "100%");
        assert_eq!(decode_percent_codes("a%%"), "a%%");
        assert_eq!(decode_percent_codes("%%x"), "%%x");
    }

    #[test]
    fn breite_wachsend_und_faktor() {
        let w1 = text_width("Wand", 0.25, 1.0);
        assert!(w1 > 0.25 && w1 < 1.0);
        assert!((text_width("Wand", 0.25, 0.5) - w1 / 2.0).abs() < 1e-12);
        assert_eq!(text_width("Wand", 0.25, 0.0), w1); // ungültiger Faktor → 1
        assert!(text_width("WWWW", 1.0, 1.0) > text_width("iiii", 1.0, 1.0));
    }

    #[test]
    fn ausrichtung_zeile() {
        let p = baseline_start([10.0, 5.0], HAlign::Center, VAlign::Middle, 4.0, 1.0, 0.0);
        assert!((p[0] - 8.0).abs() < 1e-12 && (p[1] - 4.5).abs() < 1e-12);
        // gedreht um 90°: lokale x-Achse zeigt nach +y
        let p = baseline_start([0.0, 0.0], HAlign::Right, VAlign::Baseline, 2.0, 1.0, std::f64::consts::FRAC_PI_2);
        assert!(p[0].abs() < 1e-12 && (p[1] + 2.0).abs() < 1e-12);
        let p = baseline_start([0.0, 0.0], HAlign::Left, VAlign::Top, 2.0, 1.0, 0.0);
        assert!((p[1] + 1.0).abs() < 1e-12);
    }

    #[test]
    fn einzelne_zeile_ausrichtung() {
        let w = text_width("Wand", 0.3, 1.0);
        // links/Grundlinie: Einfügepunkt
        let (p, h, a) = place_single("Wand", [1.0, 2.0], None, Hz::Left, VAlign::Baseline, 0.3, 1.0, 0.5);
        assert_eq!((p, h, a), ([1.0, 2.0], 0.3, 0.5));
        // zentriert: Anker ist der Ausrichtpunkt
        let (p, _, _) = place_single("Wand", [0.0, 0.0], Some([5.0, 1.0]), Hz::Center, VAlign::Baseline, 0.3, 1.0, 0.0);
        assert!((p[0] - (5.0 - w / 2.0)).abs() < 1e-12 && p[1] == 1.0);
        // Mitte/Mitte
        let (p, _, _) = place_single("Wand", [0.0, 0.0], Some([5.0, 1.0]), Hz::Middle, VAlign::Baseline, 0.3, 1.0, 0.0);
        assert!((p[1] - (1.0 - 0.15)).abs() < 1e-12);
        // rechts oben
        let (p, _, _) = place_single("Wand", [0.0, 0.0], Some([5.0, 1.0]), Hz::Right, VAlign::Top, 0.3, 1.0, 0.0);
        assert!((p[0] - (5.0 - w)).abs() < 1e-12 && (p[1] - 0.7).abs() < 1e-12);
        // links, aber oben: Ausrichtpunkt zählt
        let (p, _, _) = place_single("Wand", [0.0, 0.0], Some([2.0, 2.0]), Hz::Left, VAlign::Top, 0.3, 1.0, 0.0);
        assert_eq!(p[0], 2.0);
        // ausgerichtet: Höhe wächst mit der Strecke, Winkel aus den Punkten
        let (p, h, a) = place_single("Wand", [0.0, 0.0], Some([0.0, 6.0]), Hz::Aligned, VAlign::Baseline, 0.3, 1.0, 0.0);
        assert_eq!(p, [0.0, 0.0]);
        assert!((a - std::f64::consts::FRAC_PI_2).abs() < 1e-12);
        assert!((text_width("Wand", h, 1.0) - 6.0).abs() < 1e-9);
        let (_, h, _) = place_single("Wand", [0.0, 0.0], Some([6.0, 0.0]), Hz::Fit, VAlign::Baseline, 0.3, 1.0, 0.0);
        assert_eq!(h, 0.3);
        // ohne Ausrichtpunkt bei Zentriert: Einfügepunkt als Anker
        let (p, _, _) = place_single("Wand", [3.0, 3.0], None, Hz::Center, VAlign::Baseline, 0.3, 1.0, 0.0);
        assert!((p[0] - (3.0 - w / 2.0)).abs() < 1e-12);
    }

    #[test]
    fn block_mehrzeilig() {
        let lines = vec!["a".to_string(), "b".to_string()];
        let top = layout_block([0.0, 0.0], HAlign::Left, VAlign::Top, &lines, 1.0, 1.0, 0.0, 1.0);
        assert!((top[0].0[1] + 1.0).abs() < 1e-12);
        assert!((top[1].0[1] - (-1.0 - LINE_PITCH)).abs() < 1e-12);
        let bottom = layout_block([0.0, 0.0], HAlign::Left, VAlign::Bottom, &lines, 1.0, 1.0, 0.0, 1.0);
        assert!((bottom[1].0[1] - DESCENT).abs() < 1e-12);
        let mid = layout_block([0.0, 0.0], HAlign::Center, VAlign::Middle, &lines, 1.0, 1.0, 0.0, 1.0);
        // Block symmetrisch um y = 0: Oberkante erste Zeile = −Grundlinie letzte
        assert!(((mid[0].0[1] + 1.0) + mid[1].0[1]).abs() < 1e-12);
        assert!(mid[0].0[0] < 0.0);
    }
}
