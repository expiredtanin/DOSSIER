//! Treppen-Geometrie als flache Aufrufe für `src/geometry/stair.ts`. Die Mathematik steht in
//! `kernel2d` (`stair_geometry`, `stair_outline`, `stair_cut`, `stair_bbox`); hier Kodierung.
//!
//! Parameter (16 Zahlen): `[form (0 gerade, 1 L, 2 Wendel), startX, startY, dirX, dirY, lauf, lauf2,
//! richtung, zentrumX, zentrumY, radius, winkel°, breite, stufen, auf, referenz]`; optionale
//! Felder (`lauf2 … winkel`, `auf`) als NaN = fehlend; `richtung` ±1; `auf` 0/1; `referenz`
//! 0 mitte, 1 links, 2 rechts. Pflichtfelder müssen endlich sein, sonst leeres Ergebnis.
//!
//! Geometrie `[hoeheSetz, auftritt, steigung, nTritte, (index, oben, unten, x0, y0 … x3, y3)…,
//! nPodest (−1 = keins), x, y …, nLauf, x, y …, schaft ax, ay, bx, by, spitze 6 Zahlen]`.
//! Aussenlinie `[0, n, x, y …]` (Polygon) oder `[1, 4 Linien-Zahlen ×2, (cx, cy, r, a0, a1) ×2]`.
//! Schnitt `[nUnter, idx…, nUeber, idx…, nBruch (0|2), 8 Zahlen]`; Rahmen `[minX, minY, maxX, maxY]`.

use crate::flat_read::Reader;
use kernel2d::{
    stair_bbox, stair_cut, stair_geometry, stair_outline, StairArrow, StairGeometry, StairParams,
    TreadRect, Vec2,
};

/// Obergrenze der Stufenzahl (Schutz vor Endlosschleifen bei Unsinn).
const MAX_STEPS: f64 = 10_000.0;

fn opt(v: f64) -> Option<f64> {
    if v.is_nan() {
        None
    } else {
        Some(v)
    }
}

pub fn decode_params(buf: &[f64]) -> Option<StairParams> {
    let mut r = Reader::new(buf);
    let form = r.num()?;
    let (sx, sy, dx, dy, lauf) = (r.num()?, r.num()?, r.num()?, r.num()?, r.num()?);
    let (lauf2, turn, cx, cy, radius, sweep) = (r.num()?, r.num()?, r.num()?, r.num()?, r.num()?, r.num()?);
    let (width, steps, up, refz) = (r.num()?, r.num()?, r.num()?, r.num()?);
    let required = [form, sx, sy, dx, dy, lauf, width, steps];
    if !required.iter().all(|x| x.is_finite()) || steps.abs() > MAX_STEPS {
        return None;
    }
    let center = if cx.is_nan() || cy.is_nan() { None } else { Some(Vec2::new(cx, cy)) };
    // JS `Math.round`: .5 rundet auf
    let step_count = (steps + 0.5).floor() as i64;
    let shape = match form as i64 {
        1 => "L",
        2 => "spiral",
        _ => "straight",
    };
    let referenz = match refz as i64 {
        1 => Some("links".to_string()),
        2 => Some("rechts".to_string()),
        _ => None,
    };
    Some(StairParams {
        shape: shape.to_string(),
        start: Vec2::new(sx, sy),
        dir: Vec2::new(dx, dy),
        run_length: lauf,
        run2_length: opt(lauf2),
        turn: opt(turn).map(|t| t as i32),
        center,
        radius: opt(radius),
        sweep: opt(sweep),
        width,
        step_count,
        up: opt(up).map(|u| u != 0.0),
        referenz,
    })
}

fn push_pts(out: &mut Vec<f64>, pts: &[Vec2]) {
    for p in pts {
        out.push(p.x);
        out.push(p.y);
    }
}

fn to_vec2(pts: Vec<[f64; 2]>) -> Vec<Vec2> {
    pts.into_iter().map(|p| Vec2::new(p[0], p[1])).collect()
}

pub fn encode_geometry(g: &StairGeometry) -> Vec<f64> {
    let mut out = vec![g.riser_height, g.tread_depth, g.total_rise, g.treads.len() as f64];
    for t in &g.treads {
        out.extend([t.index as f64, t.top_rise, t.base_rise]);
        push_pts(&mut out, &t.pts);
    }
    match &g.landing {
        Some(l) => {
            out.push(l.len() as f64);
            push_pts(&mut out, l);
        }
        None => out.push(-1.0),
    }
    out.push(g.run_line.len() as f64);
    push_pts(&mut out, &g.run_line);
    push_pts(&mut out, &[g.arrow.shaft.0, g.arrow.shaft.1, g.arrow.head.0, g.arrow.head.1, g.arrow.head.2]);
    out
}

pub fn decode_geometry(buf: &[f64]) -> Option<StairGeometry> {
    let mut r = Reader::new(buf);
    let (riser_height, tread_depth, total_rise) = (r.num()?, r.num()?, r.num()?);
    let n = r.count()?;
    let mut treads = Vec::with_capacity(n.min(1 << 16));
    for _ in 0..n {
        let (index, top_rise, base_rise) = (r.num()?, r.num()?, r.num()?);
        let pts = to_vec2(r.points(4)?);
        treads.push(TreadRect { pts, index: index as i64, top_rise, base_rise });
    }
    let nl = r.num()?;
    let landing = if nl < 0.0 {
        None
    } else if nl.is_finite() && nl.fract() == 0.0 && nl < 1e6 {
        Some(to_vec2(r.points(nl as usize)?))
    } else {
        return None;
    };
    let run_line = to_vec2(r.ring()?);
    let a = to_vec2(r.points(5)?);
    Some(StairGeometry {
        treads,
        landing,
        riser_height,
        tread_depth,
        run_line,
        arrow: StairArrow { shaft: (a[0], a[1]), head: (a[2], a[3], a[4]) },
        total_rise,
    })
}

/// Vorgabe-Stufenzahl (endlich, ≥ MIN_STEPS).
pub fn default_step_count(total_rise: f64, run_length: f64) -> u32 {
    kernel2d::default_step_count(total_rise, run_length).clamp(0, 1_000_000) as u32
}

pub fn geometry(params: &[f64], total_rise: f64) -> Vec<f64> {
    match decode_params(params) {
        Some(p) if total_rise.is_finite() => encode_geometry(&stair_geometry(&p, total_rise)),
        _ => Vec::new(),
    }
}

pub fn outline(params: &[f64]) -> Vec<f64> {
    let Some(p) = decode_params(params) else { return Vec::new() };
    let o = stair_outline(&p);
    if let Some(poly) = o.polygon {
        let mut out = vec![0.0, poly.len() as f64];
        push_pts(&mut out, &poly);
        return out;
    }
    let Some(s) = o.spiral else { return Vec::new() };
    let mut out = vec![1.0];
    for (a, b) in s.lines {
        push_pts(&mut out, &[a, b]);
    }
    for (c, r, a0, a1) in s.arcs {
        out.extend([c.x, c.y, r, a0, a1]);
    }
    out
}

pub fn cut(geo: &[f64], cut_rise: f64) -> Vec<f64> {
    let Some(g) = decode_geometry(geo) else { return Vec::new() };
    let c = stair_cut(&g, cut_rise);
    let mut out = vec![c.below_indices.len() as f64];
    out.extend(c.below_indices.iter().map(|i| *i as f64));
    out.push(c.above_indices.len() as f64);
    out.extend(c.above_indices.iter().map(|i| *i as f64));
    match c.break_line {
        Some(lines) => {
            out.push(lines.len() as f64);
            for (a, b) in lines {
                push_pts(&mut out, &[a, b]);
            }
        }
        None => out.push(0.0),
    }
    out
}

pub fn bbox(geo: &[f64]) -> Vec<f64> {
    let Some(g) = decode_geometry(geo) else { return Vec::new() };
    let b = stair_bbox(&g);
    vec![b.min_x, b.min_y, b.max_x, b.max_y]
}

#[cfg(test)]
mod tests {
    use super::*;

    const NAN: f64 = f64::NAN;

    fn straight() -> Vec<f64> {
        vec![0.0, 0.0, 0.0, 1.0, 0.0, 3.0, NAN, NAN, NAN, NAN, NAN, NAN, 1.2, 16.0, NAN, 0.0]
    }

    #[test]
    fn geometrie_hin_und_zurueck() {
        let buf = geometry(&straight(), 2.8);
        let g = decode_geometry(&buf).unwrap();
        assert_eq!(g.treads.len(), 16);
        assert_eq!(encode_geometry(&g), buf);
        assert!(g.landing.is_none());
    }

    #[test]
    fn schnitt_und_rahmen_aus_flacher_geometrie() {
        let buf = geometry(&straight(), 2.8);
        let c = cut(&buf, 1.0);
        assert_eq!(c[0], 5.0);
        assert_eq!(c[6], 11.0);
        assert_eq!(c[6 + 11 + 1], 2.0); // zwei Bruchstriche
        assert_eq!(c.len(), 1 + 5 + 1 + 11 + 1 + 8);
        let b = bbox(&buf);
        assert!((b[2] - 3.0).abs() < 1e-9 && (b[1] + 0.6).abs() < 1e-9);
        // oberhalb aller Tritte: kein Bruch
        assert_eq!(*cut(&buf, 99.0).last().unwrap(), 0.0);
    }

    #[test]
    fn aussenlinie_flach() {
        let o = outline(&straight());
        assert_eq!(&o[..2], &[0.0, 4.0]);
        let mut sp = straight();
        sp[0] = 2.0;
        sp[10] = 1.0;
        let o = outline(&sp);
        assert_eq!(o.len(), 1 + 8 + 10);
        assert_eq!(o[0], 1.0);
    }

    #[test]
    fn unsinn_ohne_panic() {
        assert!(geometry(&[], 2.8).is_empty());
        assert!(geometry(&straight()[..10], 2.8).is_empty());
        let mut p = straight();
        p[12] = NAN; // Breite
        assert!(geometry(&p, 2.8).is_empty());
        let mut p = straight();
        p[13] = 1e12; // Stufenzahl
        assert!(geometry(&p, 2.8).is_empty());
        assert!(geometry(&straight(), NAN).is_empty());
        assert!(outline(&[NAN]).is_empty());
        assert!(cut(&[], 1.0).is_empty());
        assert!(cut(&[1.0, 2.0, 3.0, 5.0, 0.0], 1.0).is_empty());
        assert!(bbox(&[0.0, 0.0, 0.0, -3.0]).is_empty());
        assert!(decode_geometry(&[0.0, 0.0, 0.0, 1e300]).is_none());
        // negative Stufenzahl wird auf die Mindestzahl gehoben
        let mut p = straight();
        p[13] = -4.0;
        assert_eq!(decode_geometry(&geometry(&p, 2.8)).unwrap().treads.len(), 2);
    }

    #[test]
    fn vorgabe_stufenzahl() {
        assert_eq!(default_step_count(2.8, 10.0), 16);
        assert_eq!(default_step_count(NAN, 3.0), 2);
        assert!(default_step_count(f64::INFINITY, 0.0) >= 2);
    }

    #[test]
    fn referenz_und_optionen() {
        let mut p = straight();
        p[15] = 1.0; // links
        let g = decode_geometry(&geometry(&p, 2.8)).unwrap();
        assert!((g.treads[0].pts[0].y - 0.0).abs() < 1e-9);
        p[14] = 0.0; // Pfeil nach unten
        let g = decode_geometry(&geometry(&p, 2.8)).unwrap();
        assert_eq!(g.arrow.head.1, g.run_line[0]);
    }
}
