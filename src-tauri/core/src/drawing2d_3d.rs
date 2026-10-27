//! Freie 2D-Zeichnungen im 3D (aus `src/plan/toWalls3d/drawing2d.ts`): Boden-Spuren als
//! LineList-Vertices für render3d und Pick-Strecken für den Raycast. Gezeigt werden Linie,
//! Polylinie und Rechteck (Kreis/Bogen/Text bleiben aussen vor). Ein Kataster-Import kann
//! Millionen Segmente liefern; deshalb rechnet der Kern in Chargen, die TS nacheinander übergibt.
//!
//! Eingabe (je Charge): `[n, (art, höhe, r, g, b, geschlossen, nPkt, x, y …)…]` mit `art` 1 Linie
//! (2 Punkte a, b), 2 Polylinie (nPkt Punkte), 3 Rechteck (2 Punkte min, max); `höhe` ist die
//! Spur-Höhe (Geschoss-UK + 0.01), `r g b` die Linienfarbe. Unsinn ergibt ein leeres Ergebnis.
//!
//! Vertices: `[px, höhe, py, r, g, b]` je Endpunkt, zwei je Segment (Modell `(x, y)` → world
//! `(x, Höhe, y)`); entartete Segmente (< 1e-9 m) entfallen. Pick-Strecken: `[ax, ay, bx, by,
//! baseElevation, zeichnung]` je Segment (Index in der Charge), ohne Entartungs-Filter.

use crate::flat_read::Reader;
use crate::jsmath::hypot2;

type P = [f64; 2];

/// Eine Zeichnung als Sicht auf den Eingabepuffer (keine Kopie): `pts` = `[x0, y0, x1, y1, …]`.
struct Drawing<'a> {
    kind: u8,
    elev: f64,
    rgb: [f64; 3],
    closed: bool,
    pts: &'a [f64],
}

impl Drawing<'_> {
    fn n(&self) -> usize {
        self.pts.len() / 2
    }
    fn p(&self, i: usize) -> P {
        [self.pts[2 * i], self.pts[2 * i + 1]]
    }
}

/// Liest die Zeichnungen der Reihe nach; bei kaputtem Puffer `None` (nichts wird ausgegeben).
fn decode(buf: &[f64]) -> Option<Vec<Drawing<'_>>> {
    let n = Reader::new(buf).count()?;
    let mut out = Vec::with_capacity(n.min(1 << 20));
    let mut pos = 1usize;
    for _ in 0..n {
        let head = buf.get(pos..pos + 7)?;
        let count = Reader::new(&head[6..]).count()?;
        let end = (pos + 7).saturating_add(2 * count);
        let pts = buf.get(pos + 7..end)?;
        let kind = match head[0] {
            k if k == 1.0 => 1,
            k if k == 2.0 => 2,
            k if k == 3.0 => 3,
            _ => 0,
        };
        out.push(Drawing { kind, elev: head[1], rgb: [head[2], head[3], head[4]], closed: head[5] != 0.0, pts });
        pos = end;
    }
    Some(out)
}

/// Segmente einer Zeichnung in der Reihenfolge der TS-Fassung.
fn segments(d: &Drawing, mut f: impl FnMut(P, P)) {
    let n = d.n();
    match d.kind {
        1 if n >= 2 => f(d.p(0), d.p(1)),
        2 if n >= 1 => {
            for i in 0..n - 1 {
                f(d.p(i), d.p(i + 1));
            }
            if d.closed && n > 2 {
                f(d.p(n - 1), d.p(0));
            }
        }
        3 if n >= 2 => {
            let (c1, c3) = (d.p(0), d.p(1));
            let (c2, c4) = ([c3[0], c1[1]], [c1[0], c3[1]]);
            f(c1, c2);
            f(c2, c3);
            f(c3, c4);
            f(c4, c1);
        }
        _ => {}
    }
}

pub fn line_verts(buf: &[f64]) -> Vec<f32> {
    let Some(ds) = decode(buf) else { return Vec::new() };
    let mut out = Vec::new();
    for d in &ds {
        if !(d.elev.is_finite() && d.rgb.iter().all(|c| c.is_finite())) {
            continue;
        }
        let (r, g, b) = (d.rgb[0] as f32, d.rgb[1] as f32, d.rgb[2] as f32);
        let e = d.elev as f32;
        segments(d, |p0, p1| {
            // `!(x >= 1e-9)` verwirft auch NaN-Strecken
            if !(hypot2(p1[0] - p0[0], p1[1] - p0[1]) >= 1e-9) {
                return;
            }
            out.extend([p0[0] as f32, e, p0[1] as f32, r, g, b]);
            out.extend([p1[0] as f32, e, p1[1] as f32, r, g, b]);
        });
    }
    out
}

pub fn pick_segs(buf: &[f64], tolerance: f64) -> Vec<f64> {
    let Some(ds) = decode(buf) else { return Vec::new() };
    let mut out = Vec::new();
    for (i, d) in ds.iter().enumerate() {
        if !d.elev.is_finite() {
            continue;
        }
        let base = d.elev - tolerance / 2.0;
        segments(d, |a, b| out.extend([a[0], a[1], b[0], b[1], base, i as f64]));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(kind: f64, closed: f64, pts: &[f64]) -> Vec<f64> {
        let mut v = vec![kind, 0.01, 0.5, 0.25, 1.0, closed, (pts.len() / 2) as f64];
        v.extend(pts);
        v
    }

    fn batch(ds: &[Vec<f64>]) -> Vec<f64> {
        let mut v = vec![ds.len() as f64];
        for x in ds {
            v.extend(x);
        }
        v
    }

    #[test]
    fn linie_weltabbildung() {
        let v = line_verts(&batch(&[d(1.0, 0.0, &[1.0, 2.0, 4.0, 6.0])]));
        assert_eq!(v, vec![1.0, 0.01f32, 2.0, 0.5, 0.25, 1.0, 4.0, 0.01f32, 6.0, 0.5, 0.25, 1.0]);
    }

    #[test]
    fn polylinie_offen_und_geschlossen() {
        let pts = [0.0, 0.0, 1.0, 0.0, 1.0, 1.0];
        assert_eq!(line_verts(&batch(&[d(2.0, 0.0, &pts)])).len(), 2 * 12);
        assert_eq!(line_verts(&batch(&[d(2.0, 1.0, &pts)])).len(), 3 * 12);
        // zwei Punkte geschlossen: kein Schlusssegment
        assert_eq!(line_verts(&batch(&[d(2.0, 1.0, &[0.0, 0.0, 1.0, 0.0])])).len(), 12);
    }

    #[test]
    fn rechteck_vier_kanten_und_entartete_fallen_weg() {
        assert_eq!(line_verts(&batch(&[d(3.0, 0.0, &[0.0, 0.0, 2.0, 1.0])])).len(), 4 * 12);
        // Nullbreite: zwei der vier Kanten entartet
        assert_eq!(line_verts(&batch(&[d(3.0, 0.0, &[0.0, 0.0, 0.0, 1.0])])).len(), 2 * 12);
        assert_eq!(line_verts(&batch(&[d(1.0, 0.0, &[1.0, 1.0, 1.0, 1.0])])).len(), 0);
    }

    #[test]
    fn pick_strecken() {
        let p = pick_segs(&batch(&[d(1.0, 0.0, &[0.0, 0.0, 1.0, 0.0]), d(3.0, 0.0, &[0.0, 0.0, 1.0, 1.0])]), 0.12);
        assert_eq!(p.len(), 5 * 6);
        assert_eq!(&p[0..6], &[0.0, 0.0, 1.0, 0.0, 0.01 - 0.06, 0.0]);
        assert_eq!(p[6 + 5], 1.0);
        // entartete Strecke bleibt beim Pick erhalten
        assert_eq!(pick_segs(&batch(&[d(1.0, 0.0, &[1.0, 1.0, 1.0, 1.0])]), 0.12).len(), 6);
    }

    #[test]
    fn unbekannte_art_und_unsinn() {
        assert!(line_verts(&batch(&[d(0.0, 0.0, &[0.0, 0.0, 1.0, 1.0])])).is_empty());
        assert!(line_verts(&batch(&[d(4.0, 0.0, &[0.0, 0.0, 1.0, 1.0])])).is_empty());
        assert!(line_verts(&[]).is_empty());
        assert!(line_verts(&[f64::NAN]).is_empty());
        assert!(line_verts(&[1.0, 1.0]).is_empty());
        assert!(pick_segs(&[1e300], 0.1).is_empty());
        assert!(line_verts(&batch(&[d(1.0, 0.0, &[0.0, f64::NAN, 1.0, 1.0])])).is_empty());
        let mut inf = d(1.0, 0.0, &[0.0, 0.0, 1.0, 1.0]);
        inf[1] = f64::INFINITY;
        assert!(line_verts(&batch(&[inf])).is_empty());
        // Polylinie ohne Punkte
        assert!(pick_segs(&batch(&[d(2.0, 1.0, &[])]), 0.1).is_empty());
    }
}
