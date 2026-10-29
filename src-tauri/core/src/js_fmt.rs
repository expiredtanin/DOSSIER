//! Zahlenformatierung wie JavaScript: `Number.prototype.toFixed` rundet exakte Halbwerte AUF
//! (`pick the larger n`), Rusts `{:.N}` zum geraden Nachbarn — bei dyadischen Werten wie 0.0078125
//! (6 Nachkommastellen) verschieden. Exporte (IFC, CSV) müssen byteweise wie die TS-Fassung sein.

/// `x.toFixed(d)` (|x| < 1e21).
pub fn to_fixed(x: f64, d: usize) -> String {
    if x.is_nan() {
        return "NaN".into();
    }
    if x.is_infinite() {
        return if x > 0.0 { "Infinity".into() } else { "-Infinity".into() };
    }
    let neg = x < 0.0;
    let ax = x.abs();
    if ax >= 1e21 {
        return format!("{}{}", if neg { "-" } else { "" }, ax);
    }
    // Schnellweg: Rust rundet `{:.N}` korrekt (zum geraden Nachbarn nur bei exakten Halbwerten); ohne
    // exakten Halbwert ist das Ergebnis dasselbe wie in JS, nur ohne die teure lange Formatierung.
    if !exact_half(ax, d) {
        let s = format!("{:.*}", d, ax);
        return if neg { format!("-{s}") } else { s };
    }
    to_fixed_wide(ax, d, neg)
}

/// Ob `ax` (endlich, ≥ 0) bei `d` Nachkommastellen genau auf der Mitte zwischen zwei Ergebnissen liegt:
/// `ax · 10^d · 2` ist eine ungerade ganze Zahl, d. h. das niedrigste gesetzte Bit von `ax` ist 2^-(d+1).
fn exact_half(ax: f64, d: usize) -> bool {
    if ax == 0.0 {
        return false;
    }
    let bits = ax.to_bits();
    let exp = ((bits >> 52) & 0x7ff) as i64;
    let frac = bits & ((1u64 << 52) - 1);
    let (m, e) = if exp == 0 { (frac, -1074) } else { (frac | (1u64 << 52), exp - 1075) };
    e + m.trailing_zeros() as i64 + d as i64 + 1 == 0
}

/// Langsamer, exakter Weg (für exakte Halbwerte): Ziffern mit 25 Stellen Reserve, dann aufrunden.
fn to_fixed_wide(ax: f64, d: usize, neg: bool) -> String {
    // 25 Stellen mehr als nötig: ein exakter Halbwert zeigt sich als '5' gefolgt von Nullen.
    let wide = format!("{:.*}", d + 25, ax);
    let (int_part, frac) = wide.split_once('.').expect("Nachkommastellen");
    let mut digits: Vec<u8> = int_part.bytes().chain(frac.bytes().take(d)).collect();
    let round_up = frac.as_bytes().get(d).is_some_and(|&c| c >= b'5');
    if round_up {
        let mut i = digits.len();
        loop {
            if i == 0 {
                digits.insert(0, b'1');
                break;
            }
            i -= 1;
            if digits[i] == b'9' {
                digits[i] = b'0';
            } else {
                digits[i] += 1;
                break;
            }
        }
    }
    let int_len = digits.len() - d;
    let mut s = String::new();
    if neg {
        s.push('-');
    }
    s.push_str(std::str::from_utf8(&digits[..int_len]).expect("ASCII"));
    if d > 0 {
        s.push('.');
        s.push_str(std::str::from_utf8(&digits[int_len..]).expect("ASCII"));
    }
    s
}

/// `String(x)` für Zahlen (ECMAScript `Number::toString`): kürzeste Ziffernfolge, Exponent erst ab
/// 1e21 bzw. unter 1e-6, `-0` → `"0"`.
pub fn js_number(x: f64) -> String {
    if x.is_nan() {
        return "NaN".into();
    }
    if x == 0.0 {
        return "0".into();
    }
    if x.is_infinite() {
        return if x > 0.0 { "Infinity".into() } else { "-Infinity".into() };
    }
    let sign = if x < 0.0 { "-" } else { "" };
    // Rusts `{:e}` liefert die kürzeste Ziffernfolge, z. B. "1.2345e3".
    let e = format!("{:e}", x.abs());
    let (mant, exp) = e.split_once('e').expect("Exponent");
    let digits: String = mant.chars().filter(|c| *c != '.').collect();
    let k = digits.len() as i64;
    let n = exp.parse::<i64>().expect("Exponent") + 1;
    let body = if k <= n && n <= 21 {
        format!("{digits}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat((-n) as usize))
    } else {
        let es = if n > 0 { format!("+{}", n - 1) } else { format!("{}", n - 1) };
        if k == 1 {
            format!("{digits}e{es}")
        } else {
            format!("{}.{}e{es}", &digits[..1], &digits[1..])
        }
    };
    format!("{sign}{body}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zahl_als_text_wie_js() {
        assert_eq!(js_number(3.0), "3");
        assert_eq!(js_number(-0.0), "0");
        assert_eq!(js_number(0.1 + 0.2), "0.30000000000000004");
        assert_eq!(js_number(1e21), "1e+21");
        assert_eq!(js_number(1.5e21), "1.5e+21");
        assert_eq!(js_number(1e20), "100000000000000000000");
        assert_eq!(js_number(1e-7), "1e-7");
        assert_eq!(js_number(1.25e-7), "1.25e-7");
        assert_eq!(js_number(0.000001), "0.000001");
        assert_eq!(js_number(-12.5), "-12.5");
        assert_eq!(js_number(123456.789), "123456.789");
        assert_eq!(js_number(f64::NAN), "NaN");
        assert_eq!(js_number(f64::NEG_INFINITY), "-Infinity");
    }

    #[test]
    fn rundet_halbwerte_auf_wie_js() {
        assert_eq!(to_fixed(0.0078125, 6), "0.007813"); // JS: "0.007813"; Rust {:.6}: 0.007812
        assert_eq!(to_fixed(12.5, 0), "13");
        assert_eq!(to_fixed(-2.5, 0), "-3");
        assert_eq!(to_fixed(0.5, 0), "1");
        assert_eq!(to_fixed(1.0, 6), "1.000000");
        assert_eq!(to_fixed(0.0, 6), "0.000000");
        assert_eq!(to_fixed(-1e-7, 6), "-0.000000");
        assert_eq!(to_fixed(9.9999996, 6), "10.000000");
        assert_eq!(to_fixed(123.456, 2), "123.46");
        assert_eq!(to_fixed(2.675, 2), "2.67"); // 2.675 ist binär 2.67499999… — JS: "2.67"
        assert_eq!(to_fixed(1e-9, 6), "0.000000");
        assert_eq!(to_fixed(0.25, 1), "0.3");
        assert_eq!(to_fixed(-0.25, 1), "-0.3");
        assert_eq!(to_fixed(-0.0, 2), "0.00");
    }

    #[test]
    fn schnellweg_gleich_dem_genauen_weg() {
        let mut x: u64 = 0x2545_f491_4f6c_dd1d;
        for i in 0..200_000 {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            let v = match i % 4 {
                0 => (x % 1_000_000) as f64 / 1000.0,
                1 => f64::from_bits(x) % 1e6,
                2 => (x % 4096) as f64 / 64.0,
                _ => (x as f64 / u64::MAX as f64 - 0.5) * 100.0,
            };
            if !v.is_finite() {
                continue;
            }
            for d in 0..8 {
                assert_eq!(to_fixed(v, d), to_fixed_wide(v.abs(), d, v < 0.0), "{v} {d}");
            }
        }
    }
}
