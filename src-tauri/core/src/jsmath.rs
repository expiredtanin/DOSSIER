//! `Math.hypot` wie in V8 (Kahan-Summe über die auf den Maximalwert skalierten Beträge). Die
//! 3D-Ableitungen (`stairs3d`, `drawing2d_3d`) lieferten in TS bitgenau diese Werte; `f64::hypot`
//! weicht in der letzten Stelle ab und würde Vergleiche alt/neu unnötig aufweichen.

pub fn hypot(v: &[f64]) -> f64 {
    let mut max = 0.0f64;
    let mut nan = false;
    for &x in v {
        let a = x.abs();
        if a.is_infinite() {
            return f64::INFINITY;
        }
        if a.is_nan() {
            nan = true;
        } else if a > max {
            max = a;
        }
    }
    if nan {
        return f64::NAN;
    }
    if max == 0.0 {
        return 0.0;
    }
    let (mut sum, mut comp) = (0.0f64, 0.0f64);
    for &x in v {
        let n = x.abs() / max;
        let summand = n * n - comp;
        let prelim = sum + summand;
        comp = (prelim - sum) - summand;
        sum = prelim;
    }
    sum.sqrt() * max
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
