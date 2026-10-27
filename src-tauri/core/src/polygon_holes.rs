//! Brücken-Trick (aus `src/geometry/polygonHoles.ts`): Aussparungen werden über schmale Brücken
//! in den Aussenring eingefügt, sodass EIN einfacher (nicht selbstüberschneidender) Ring entsteht.
//! Paritätsbasiert korrekt für Füllung, Schraffur, Triangulierung und Punkt-in-Polygon.
//!
//! Je Loch: nächstgelegenes SICHTBARES Paar (Ring-Vertex, Loch-Vertex) verbinden; das Loch wird
//! gegenläufig zum Aussenring eingefügt; die Brücke besteht aus zwei knapp parallelen Kanten
//! (Versatz `gap` quer zur Brücke). Löcher mit < 3 Punkten, ~Nullfläche oder Schwerpunkt ausserhalb
//! des aktuellen Rings werden übersprungen.

const EPS: f64 = 1e-9;

type P = [f64; 2];

/// Ring-Punkt mit fester Kennung (ersetzt die Objekt-Identität der TS-Fassung beim Auffinden
/// der Brückenkanten im fertigen Ring).
#[derive(Clone, Copy)]
struct Node {
    p: P,
    id: usize,
}

/// Ergebnis: Ring (offen) und die Kanten-Indizes der Brücken (Kante i = ring[i] → ring[i+1]).
#[derive(Debug, Clone, PartialEq)]
pub struct Merged {
    pub ring: Vec<P>,
    pub bridge_edges: Vec<usize>,
}

fn dist(a: P, b: P) -> f64 {
    (a[0] - b[0]).hypot(a[1] - b[1])
}

fn cross(a: P, b: P) -> f64 {
    a[0] * b[1] - a[1] * b[0]
}

fn sub(a: P, b: P) -> P {
    [a[0] - b[0], a[1] - b[1]]
}

fn signed_area(pts: &[P]) -> f64 {
    let n = pts.len();
    let mut s = 0.0;
    for i in 0..n {
        let (a, b) = (pts[i], pts[(i + 1) % n]);
        s += a[0] * b[1] - b[0] * a[1];
    }
    s / 2.0
}

/// Schwerpunkt als Punkt-Mittel (genügt für den Innen/Aussen-Test).
fn mean(pts: &[P]) -> P {
    let (mut x, mut y) = (0.0, 0.0);
    for p in pts {
        x += p[0];
        y += p[1];
    }
    [x / pts.len() as f64, y / pts.len() as f64]
}

fn point_in_polygon(p: P, poly: &[P]) -> bool {
    let mut inside = false;
    let n = poly.len();
    if n == 0 {
        return false;
    }
    let mut j = n - 1;
    for i in 0..n {
        let (a, b) = (poly[i], poly[j]);
        let dy = b[1] - a[1];
        let denom = if dy == 0.0 { 1e-12 } else { dy };
        if (a[1] > p[1]) != (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / denom + a[0] {
            inside = !inside;
        }
        j = i;
    }
    inside
}

fn left_normal_unit(d: P) -> P {
    let l = d[0].hypot(d[1]);
    if l < EPS {
        [0.0, 0.0]
    } else {
        [-d[1] / l, d[0] / l]
    }
}

/// Ob sich zwei Strecken ECHT (im Inneren beider) schneiden.
fn properly_cross(a1: P, a2: P, b1: P, b2: P) -> bool {
    let (da, db) = (sub(a2, a1), sub(b2, b1));
    let denom = cross(da, db);
    if denom.abs() < EPS {
        return false;
    }
    let t = cross(sub(b1, a1), db) / denom;
    let s = cross(sub(b1, a1), da) / denom;
    let e = 1e-9;
    t > e && t < 1.0 - e && s > e && s < 1.0 - e
}

fn blocked(p: P, q: P, ring: &[P], hole: &[P]) -> bool {
    let any = |r: &[P]| (0..r.len()).any(|i| properly_cross(p, q, r[i], r[(i + 1) % r.len()]));
    any(ring) || any(hole)
}

/// Fügt `holes` in `outline` ein. Ohne Löcher oder bei < 3 Punkten: Kopie von `outline`.
pub fn merge_holes(outline: &[P], holes: &[Vec<P>], gap: f64) -> Merged {
    if outline.len() < 3 || holes.is_empty() {
        return Merged { ring: outline.to_vec(), bridge_edges: vec![] };
    }
    let outer_ccw = signed_area(outline) > 0.0;
    let mut next_id = 0usize;
    let mut fresh = |p: P| {
        next_id += 1;
        Node { p, id: next_id }
    };
    let mut ring: Vec<Node> = outline.iter().map(|&p| fresh(p)).collect();
    let mut bridges: Vec<(usize, usize)> = Vec::new();

    for hole_raw in holes {
        if hole_raw.len() < 3 || signed_area(hole_raw).abs() < 1e-9 {
            continue;
        }
        let plain: Vec<P> = ring.iter().map(|n| n.p).collect();
        if !point_in_polygon(mean(hole_raw), &plain) {
            continue;
        }
        let hole_ccw = signed_area(hole_raw) > 0.0;
        let mut hole = hole_raw.clone();
        if hole_ccw == outer_ccw {
            hole.reverse();
        }
        let m = hole.len();

        let mut cands: Vec<(usize, usize, f64)> = Vec::with_capacity(ring.len() * m);
        for i in 0..ring.len() {
            for j in 0..m {
                cands.push((i, j, dist(ring[i].p, hole[j])));
            }
        }
        // Stabil nach Abstand (bei Gleichstand i-, dann j-Reihenfolge wie in TS).
        cands.sort_by(|a, b| a.2.total_cmp(&b.2));
        let mut chosen = cands[0];
        for c in &cands {
            if !blocked(ring[c.0].p, hole[c.1], &plain, &hole) {
                chosen = *c;
                break;
            }
        }
        let (i, j, _) = chosen;
        let (a, b) = (ring[i].p, hole[j]);
        let perp = left_normal_unit(sub(b, a));
        let off = [perp[0] * gap, perp[1] * gap];
        let a1 = fresh([a[0] + off[0], a[1] + off[1]]);
        let a2 = fresh([a[0] - off[0], a[1] - off[1]]);
        let b1 = fresh([b[0] + off[0], b[1] + off[1]]);
        let b2 = fresh([b[0] - off[0], b[1] - off[1]]);

        let mut next: Vec<Node> = Vec::with_capacity(ring.len() + m + 4);
        next.extend_from_slice(&ring[..i]);
        next.push(a1);
        next.push(b1);
        for k in 1..m {
            next.push(fresh(hole[(j + k) % m]));
        }
        next.push(b2);
        next.push(a2);
        next.extend_from_slice(&ring[i + 1..]);
        ring = next;
        bridges.push((a1.id, b1.id));
        bridges.push((b2.id, a2.id));
    }

    let n = ring.len();
    let bridge_edges = (0..n).filter(|&k| bridges.contains(&(ring[k].id, ring[(k + 1) % n].id))).collect();
    Merged { ring: ring.iter().map(|n| n.p).collect(), bridge_edges }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x: f64, y: f64, w: f64, h: f64) -> Vec<P> {
        vec![[x, y], [x + w, y], [x + w, y + h], [x, y + h]]
    }

    fn simple(ring: &[P]) -> bool {
        let n = ring.len();
        for i in 0..n {
            for j in i + 1..n {
                if j == i + 1 || (i == 0 && j == n - 1) {
                    continue;
                }
                if properly_cross(ring[i], ring[(i + 1) % n], ring[j], ring[(j + 1) % n]) {
                    return false;
                }
            }
        }
        true
    }

    #[test]
    fn ohne_loecher_kopie() {
        let o = rect(0.0, 0.0, 4.0, 4.0);
        let m = merge_holes(&o, &[], 1e-4);
        assert_eq!(m.ring, o);
        assert!(m.bridge_edges.is_empty());
    }

    #[test]
    fn ein_loch_flaeche_einfach_zwei_bruecken() {
        let m = merge_holes(&rect(0.0, 0.0, 10.0, 10.0), &[rect(4.0, 4.0, 2.0, 2.0)], 1e-4);
        assert!((signed_area(&m.ring).abs() - 96.0).abs() < 1e-2);
        assert!(simple(&m.ring));
        assert_eq!(m.bridge_edges.len(), 2);
    }

    #[test]
    fn loch_gleiche_und_gegenlaeufige_wicklung() {
        let mut h = rect(4.0, 4.0, 2.0, 2.0);
        let a = merge_holes(&rect(0.0, 0.0, 10.0, 10.0), &[h.clone()], 1e-4);
        h.reverse();
        let b = merge_holes(&rect(0.0, 0.0, 10.0, 10.0), &[h], 1e-4);
        assert!((signed_area(&a.ring).abs() - signed_area(&b.ring).abs()).abs() < 1e-9);
    }

    #[test]
    fn mehrere_loecher() {
        let holes = vec![rect(1.0, 1.0, 1.0, 1.0), rect(5.0, 5.0, 2.0, 2.0), rect(1.0, 6.0, 1.0, 2.0)];
        let m = merge_holes(&rect(0.0, 0.0, 10.0, 10.0), &holes, 1e-4);
        assert!(simple(&m.ring));
        assert!((signed_area(&m.ring).abs() - (100.0 - 1.0 - 4.0 - 2.0)).abs() < 1e-2);
    }

    #[test]
    fn unsinnige_loecher_werden_uebersprungen() {
        let o = rect(0.0, 0.0, 10.0, 10.0);
        let holes = vec![vec![[1.0, 1.0], [2.0, 2.0]], rect(20.0, 20.0, 1.0, 1.0), vec![[3.0, 3.0], [4.0, 4.0], [5.0, 5.0]]];
        let m = merge_holes(&o, &holes, 1e-4);
        assert_eq!(m.ring, o);
        assert!(m.bridge_edges.is_empty());
    }

    #[test]
    fn unsinn_ohne_panik() {
        let nan = vec![[f64::NAN, 0.0], [1.0, 0.0], [0.0, 1.0]];
        let _ = merge_holes(&nan, &[rect(0.0, 0.0, 1.0, 1.0)], 1e-4);
        let _ = merge_holes(&rect(0.0, 0.0, 10.0, 10.0), &[nan.clone()], 1e-4);
        let _ = merge_holes(&rect(0.0, 0.0, 10.0, 10.0), &[rect(4.0, 4.0, 2.0, 2.0)], f64::NAN);
        assert!(merge_holes(&[], &[nan], 1e-4).ring.is_empty());
    }
}
