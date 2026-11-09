//! IFC-GUID-Kompression und STEP-Formatierung (Zeichenketten, Zahlen, Listen, Verweise); `ifc_guid`, `ifc_string`, `fmt_real` sind öffentlich (WASM, `mesh_export.rs`), der Rest dient dem Schreiber.
//! Teil von `ifc_export` (aus `ifc_export.rs` aufgeteilt, [164]).


// ── IFC-GUID (Kompression nach IfcOpenShell `guid.compress`) ────────────────

pub(super) const IFC_GUID_CHARS: &[u8; 64] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$";

/// Kodiert `v` big-endian in `len` IFC-GUID-Zeichen (Basis 64).
pub(super) fn guid_b64(v: u32, len: usize, out: &mut String) {
    for i in (0..len).rev() {
        out.push(IFC_GUID_CHARS[((v >> (6 * i)) & 63) as usize] as char);
    }
}

/// Komprimiert 16 Bytes zur 22-stelligen IFC-GUID (erstes Byte → 2 Zeichen, dann 5 × 3 Byte → 4 Zeichen).
pub(super) fn compress_guid(bytes: &[u8; 16]) -> String {
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
pub(super) fn fmix64(mut k: u64) -> u64 {
    k ^= k >> 33;
    k = k.wrapping_mul(0xff51_afd7_ed55_8ccd);
    k ^= k >> 33;
    k = k.wrapping_mul(0xc4ce_b9fe_1a85_ec53);
    k ^= k >> 33;
    k
}

/// FNV-1a-64 über Bytes (vorwärts oder rückwärts) — reines Streuungswerkzeug, keine Kryptografie.
pub(super) fn fnv1a64(bytes: &[u8], seed: u64, reverse: bool) -> u64 {
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
pub(super) fn exact_scaled_digits(a: f64) -> String {
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

pub(super) fn enum_(v: &str) -> String {
    format!(".{v}.")
}

pub(super) fn list(items: &[String]) -> String {
    format!("({})", items.join(","))
}

pub(super) fn refs(ids: &[usize]) -> String {
    let v: Vec<String> = ids.iter().map(|id| format!("#{id}")).collect();
    list(&v)
}

/// JSON-Zeichenkette für den Pset-Schlüssel (nur `"` und `\` kommen in IFC-Literalen vor, alles andere ist
/// druckbares ASCII).
pub(super) fn json_str(s: &str) -> String {
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
