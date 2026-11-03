//! `hypot` über `libm` (deterministisch auf allen Plattformen, kein Aufruf in die JS-Engine).

/// Euklidische Länge beliebig vieler Komponenten (NaN-Eingabe → NaN, ±∞ → ∞).
pub fn hypot(v: &[f64]) -> f64 {
    match v {
        [] => 0.0,
        [a] => a.abs(),
        [a, b] => libm::hypot(*a, *b),
        _ => {
            if v.iter().any(|x| x.is_infinite()) {
                return f64::INFINITY;
            }
            libm::sqrt(v.iter().map(|x| x * x).sum())
        }
    }
}

pub fn hypot2(a: f64, b: f64) -> f64 {
    hypot(&[a, b])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn werte() {
        assert_eq!(hypot2(3.0, 4.0), 5.0);
        assert_eq!(hypot2(0.0, 0.0), 0.0);
        assert!(hypot2(f64::NAN, 1.0).is_nan());
        assert_eq!(hypot2(f64::INFINITY, f64::NAN), f64::INFINITY);
        assert_eq!(hypot(&[2.0, 3.0, 6.0]), 7.0);
    }
}
