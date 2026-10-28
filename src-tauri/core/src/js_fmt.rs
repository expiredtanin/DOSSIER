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

#[cfg(test)]
mod tests {
    use super::*;

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
    }
}
