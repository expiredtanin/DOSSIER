//! Flache Kodierung von Punkten, Segmenten und Läufen für die Schraffur-Bindungen
//! (`[x, y, …]`, `[ax, ay, bx, by, …]`, `[n, x, y, …(n Punkte), n, …]`). Kaputte Eingaben
//! (ungerade Länge, Anzahl über das Pufferende) werden abgeschnitten, nie ein Panic.

use crate::hatch::{v2, Run, V2};

pub fn pts(buf: &[f64]) -> Vec<V2> {
    buf.chunks_exact(2).map(|c| v2(c[0], c[1])).collect()
}

pub fn segs_out(segs: &[(V2, V2)]) -> Vec<f64> {
    let mut out = Vec::with_capacity(segs.len() * 4);
    for (a, b) in segs {
        out.extend_from_slice(&[a.x, a.y, b.x, b.y]);
    }
    out
}

pub fn runs_out(runs: &[Run]) -> Vec<f64> {
    let mut out = Vec::new();
    for r in runs {
        out.push(r.len() as f64);
        for p in r {
            out.push(p.x);
            out.push(p.y);
        }
    }
    out
}

pub fn runs_in(buf: &[f64]) -> Vec<Run> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < buf.len() {
        let n = buf[i];
        if !(n >= 0.0) || n.fract() != 0.0 {
            break;
        }
        let end = match (n as usize).checked_mul(2).and_then(|k| k.checked_add(i + 1)) {
            Some(e) if e <= buf.len() => e,
            _ => break,
        };
        out.push(pts(&buf[i + 1..end]));
        i = end;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn laeufe_hin_und_zurueck() {
        let r = vec![vec![v2(0.0, 1.0), v2(2.0, 3.0)], vec![v2(4.0, 5.0)]];
        assert_eq!(runs_in(&runs_out(&r)), r);
        assert_eq!(runs_in(&[5.0, 1.0]), Vec::<Run>::new());
        assert_eq!(pts(&[1.0, 2.0, 3.0]), vec![v2(1.0, 2.0)]);
    }
}
