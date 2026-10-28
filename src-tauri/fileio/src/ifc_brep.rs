// IFC-Import ([B3]/[25]): Lesen von Freiform-Geometrie für `ifc_import` (Untermodul des Lesers):
// IfcBSplineCurveWithKnots/IfcRationalBSplineCurveWithKnots, IfcBSplineSurfaceWithKnots/
// IfcRationalBSplineSurfaceWithKnots, Kanten-Topologie (IfcEdgeLoop/IfcOrientedEdge/IfcEdgeCurve/
// IfcVertexPoint) der IfcAdvancedFace/IfcFaceSurface mit Trägerfläche Ebene, Zylinder, Kegel, Kugel, Torus
// oder B-Spline (Zerlegung in `ifc_nurbs`), StartParam/EndParam der Sweeps und IfcGridPlacement.
// Eigener Code.

use std::collections::HashMap;

use super::{dot, len, norm, sub, Mesh, Reader, Xf, MAX_CURVE_DEPTH, MAX_LOOP_POINTS, V3};
use crate::ifc_nurbs::{expand_knots, BSplineCurve, BSplineSurface, Surface};
use crate::ifc_step::{Entity, Value};

/// Parameter des Punkts von `pts` (Parameter, Punkt), der `p` am nächsten liegt (linear zwischen
/// Nachbarpunkten).
pub(super) fn nearest_param(pts: &[(f64, V3)], p: V3) -> Option<f64> {
    let mut best: Option<(f64, f64)> = None;
    for w in pts.windows(2) {
        let (a, b) = (w[0].1, w[1].1);
        let ab = sub(b, a);
        let l2 = dot(ab, ab);
        let f = if l2 > 0.0 { (dot(sub(p, a), ab) / l2).clamp(0.0, 1.0) } else { 0.0 };
        let q = [a[0] + ab[0] * f, a[1] + ab[1] * f, a[2] + ab[2] * f];
        let d = len(sub(p, q));
        if best.is_none_or(|bst| d < bst.0) {
            best = Some((d, w[0].0 + (w[1].0 - w[0].0) * f));
        }
    }
    if pts.len() == 1 {
        return Some(pts[0].0);
    }
    best.map(|b| b.1)
}

/// Lage von `p` auf der Punktfolge als (Segment, Anteil, Abstand).
fn locate(pts: &[V3], p: V3) -> Option<(usize, f64, f64)> {
    let mut best: Option<(usize, f64, f64)> = None;
    for i in 0..pts.len().saturating_sub(1) {
        let (a, b) = (pts[i], pts[i + 1]);
        let ab = sub(b, a);
        let l2 = dot(ab, ab);
        let f = if l2 > 0.0 { (dot(sub(p, a), ab) / l2).clamp(0.0, 1.0) } else { 0.0 };
        let q = [a[0] + ab[0] * f, a[1] + ab[1] * f, a[2] + ab[2] * f];
        let d = len(sub(p, q));
        if best.is_none_or(|bst| d < bst.2) {
            best = Some((i, f, d));
        }
    }
    best
}

/// Teil der Kurve `pts` (in Kurvenrichtung) von `a` nach `b`; bei geschlossener Kurve auch über den
/// Anfang hinweg, bei `a` = `b` die ganze Schleife ab `a`.
fn trim_polyline(pts: &[V3], a: V3, b: V3, whole: bool) -> Vec<V3> {
    let n = pts.len();
    if n < 2 {
        return vec![a, b];
    }
    let closed = len(sub(pts[0], pts[n - 1])) < 1e-9;
    let (Some((ia, fa, _)), Some((ib, fb, _))) = (locate(pts, a), locate(pts, b)) else { return vec![a, b] };
    let (sa, sb) = (ia as f64 + fa, ib as f64 + fb);
    let mut out = vec![a];
    if whole || (closed && sb <= sa) {
        if !closed {
            // Offene Kurve mit gleichem Anfangs- und Endpunkt der Kante: ganze Kurve.
            out.extend_from_slice(&pts[1..n - 1]);
            out.push(b);
            return out;
        }
        if whole {
            // Ganze Schleife ab `a`.
            out.extend_from_slice(&pts[ia + 1..n - 1]);
            out.extend_from_slice(&pts[..=ia]);
        } else {
            out.extend_from_slice(&pts[ia + 1..n - 1]);
            out.extend_from_slice(&pts[..=ib]);
        }
    } else if sb >= sa {
        out.extend_from_slice(&pts[ia + 1..=ib]);
    } else {
        // Offene Kurve, Endpunkt vor dem Anfang: rückwärts.
        for k in (ib + 1..=ia).rev() {
            out.push(pts[k]);
        }
    }
    out.push(b);
    out.dedup_by(|x, y| len(sub(*x, *y)) < 1e-12);
    out
}

/// Zieht `pts` (Schlüssel `keys` aufsteigend) auf den Bereich [k0, k1] zusammen (linear zwischen
/// Punkten); Schlüssel nicht aufsteigend → unverändert.
fn trim_by_keys(pts: &[V3], keys: &[f64], k0: f64, k1: f64) -> Vec<V3> {
    if pts.len() < 2 || keys.windows(2).any(|w| !(w[1] >= w[0])) {
        return pts.to_vec();
    }
    let (k0, k1) = if k0 <= k1 { (k0, k1) } else { (k1, k0) };
    let at = |k: f64| -> V3 {
        let k = k.clamp(keys[0], keys[keys.len() - 1]);
        let i = keys.partition_point(|x| *x <= k).clamp(1, keys.len() - 1);
        let (ka, kb) = (keys[i - 1], keys[i]);
        let f = if kb > ka { (k - ka) / (kb - ka) } else { 0.0 };
        let (a, b) = (pts[i - 1], pts[i]);
        [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f]
    };
    let mut out = vec![at(k0)];
    for (k, p) in keys.iter().zip(pts) {
        if *k > k0 && *k < k1 {
            out.push(*p);
        }
    }
    out.push(at(k1));
    out.dedup_by(|x, y| len(sub(*x, *y)) < 1e-12);
    out
}

/// Trägerfläche einer Seite.
pub(super) enum FaceSurface {
    Plane,
    Curved(Surface),
}

impl<'a> Reader<'a> {
    fn f64_list(v: Option<&Value>) -> Option<Vec<f64>> {
        v?.as_list()?.iter().map(|x| x.as_f64()).collect()
    }
    fn i64_list(v: Option<&Value>) -> Option<Vec<i64>> {
        v?.as_list()?.iter().map(|x| x.as_i64()).collect()
    }
    fn degree(v: Option<&Value>) -> Option<usize> {
        usize::try_from(v?.as_i64()?).ok()
    }

    /// IfcBSplineCurveWithKnots / IfcRationalBSplineCurveWithKnots.
    pub(super) fn bspline_curve(&self, e: &Entity) -> Option<BSplineCurve> {
        let p = Self::degree(e.arg(0))?;
        let ctrl: Vec<V3> = e.arg(1)?.as_list()?.iter().take(MAX_LOOP_POINTS).map(|v| self.point(Some(v))).collect::<Option<_>>()?;
        let knots = expand_knots(&Self::i64_list(e.arg(5))?, &Self::f64_list(e.arg(6))?)?;
        let weights = if e.ty == "IFCRATIONALBSPLINECURVEWITHKNOTS" { Some(Self::f64_list(e.arg(8))?) } else { None };
        BSplineCurve::new(p, ctrl, weights, knots)
    }

    /// IfcBSplineSurfaceWithKnots / IfcRationalBSplineSurfaceWithKnots.
    fn bspline_surface(&self, e: &Entity) -> Option<BSplineSurface> {
        let (pu, pv) = (Self::degree(e.arg(0))?, Self::degree(e.arg(1))?);
        let rows: Vec<Vec<V3>> = e
            .arg(2)?
            .as_list()?
            .iter()
            .map(|r| r.as_list().and_then(|r| r.iter().map(|v| self.point(Some(v))).collect::<Option<Vec<V3>>>()))
            .collect::<Option<_>>()?;
        let uk = expand_knots(&Self::i64_list(e.arg(7))?, &Self::f64_list(e.arg(9))?)?;
        let vk = expand_knots(&Self::i64_list(e.arg(8))?, &Self::f64_list(e.arg(10))?)?;
        let weights = if e.ty == "IFCRATIONALBSPLINESURFACEWITHKNOTS" {
            Some(e.arg(12)?.as_list()?.iter().map(|r| Self::f64_list(Some(r))).collect::<Option<Vec<_>>>()?)
        } else {
            None
        };
        BSplineSurface::new(pu, pv, rows, weights, uk, vk)
    }

    /// Trägerfläche einer Seite; nicht unterstützt → `None` (gezählt).
    pub(super) fn face_surface(&mut self, v: Option<&Value>) -> Option<FaceSurface> {
        let (_, e) = self.ent_v(v)?;
        let s = match e.ty.as_str() {
            "IFCPLANE" => return Some(FaceSurface::Plane),
            "IFCCYLINDRICALSURFACE" => Surface::Cylinder(self.axis_placement(e.arg(0)), self.length(e.arg(1)).filter(|r| *r > 0.0)?),
            "IFCCONICALSURFACE" => {
                let a = e.arg(2)?.as_f64()? * self.angle_scale;
                if !(a.abs() < std::f64::consts::FRAC_PI_2 - 1e-6) {
                    return None;
                }
                Surface::Cone(self.axis_placement(e.arg(0)), self.length(e.arg(1)).filter(|r| *r >= 0.0)?, a)
            }
            "IFCSPHERICALSURFACE" => Surface::Sphere(self.axis_placement(e.arg(0)), self.length(e.arg(1)).filter(|r| *r > 0.0)?),
            "IFCTOROIDALSURFACE" => {
                let big = self.length(e.arg(1)).filter(|r| *r > 0.0)?;
                let r = self.length(e.arg(2)).filter(|r| *r > 0.0)?;
                Surface::Torus(self.axis_placement(e.arg(0)), big, r)
            }
            "IFCBSPLINESURFACEWITHKNOTS" | "IFCRATIONALBSPLINESURFACEWITHKNOTS" => Surface::BSpline(self.bspline_surface(e)?),
            other => {
                let ty = format!("Fläche {other}");
                self.skip(&ty);
                return None;
            }
        };
        Some(FaceSurface::Curved(s))
    }

    fn vertex_point(&self, v: Option<&Value>) -> Option<V3> {
        let (_, e) = self.ent_v(v)?;
        if e.ty != "IFCVERTEXPOINT" {
            return None;
        }
        self.point(e.arg(0))
    }

    /// Punkte einer IfcEdgeCurve vom Anfangs- zum Endpunkt (zwischengespeichert, damit Nachbarseiten
    /// dieselben Punkte teilen).
    fn edge_points(&mut self, id: u64) -> Option<Vec<V3>> {
        if let Some(p) = self.edge_cache.get(&id) {
            return Some(p.clone());
        }
        let e = self.ent(id)?;
        if e.ty != "IFCEDGECURVE" {
            let ty = e.ty.clone();
            self.skip(&ty);
            return None;
        }
        let a = self.vertex_point(e.arg(0))?;
        let b = self.vertex_point(e.arg(1))?;
        let same = e.arg(3).and_then(|v| v.as_enum()) != Some("F");
        let whole = e.arg(0).and_then(|v| v.as_ref_id()) == e.arg(1).and_then(|v| v.as_ref_id()) || len(sub(a, b)) < 1e-9;
        let geom = self.ent_v(e.arg(2)).map(|(_, g)| g.ty.clone());
        let pts = match geom.as_deref() {
            // Gerade: nur die Endpunkte (die Linie ist unbegrenzt).
            Some("IFCLINE") => vec![a, b],
            _ => {
                let mut c = self.curve(e.arg(2), 0)?;
                // Ganze Schleife (Kreis ohne doppelten Schlusspunkt): ausdrücklich schliessen.
                if whole && c.len() > 2 && len(sub(c[0], c[c.len() - 1])) >= 1e-9 {
                    c.push(c[0]);
                }
                if same {
                    trim_polyline(&c, a, b, whole)
                } else {
                    let mut t = trim_polyline(&c, b, a, whole);
                    t.reverse();
                    t
                }
            }
        };
        if pts.len() > MAX_LOOP_POINTS || !pts.iter().all(|p| p.iter().all(|v| v.is_finite())) {
            return None;
        }
        self.edge_cache.insert(id, pts.clone());
        Some(pts)
    }

    /// IfcEdgeLoop → Punktfolge ohne doppelten Schlusspunkt.
    pub(super) fn edge_loop(&mut self, lp: &Entity) -> Option<Vec<V3>> {
        let mut out: Vec<V3> = Vec::new();
        for oe in lp.arg(0)?.as_list()? {
            let (oid, o) = self.ent_v(Some(oe))?;
            let mut pts = match o.ty.as_str() {
                "IFCORIENTEDEDGE" => {
                    let mut p = self.edge_points(o.arg(2)?.as_ref_id()?)?;
                    if o.arg(3).and_then(|v| v.as_enum()) == Some("F") {
                        p.reverse();
                    }
                    p
                }
                "IFCEDGECURVE" => self.edge_points(oid)?,
                _ => return None,
            };
            if let (Some(l), Some(f)) = (out.last(), pts.first()) {
                if len(sub(*l, *f)) < 1e-9 {
                    pts.remove(0);
                }
            }
            out.extend(pts);
            if out.len() > MAX_LOOP_POINTS {
                return None;
            }
        }
        while out.len() > 1 && len(sub(out[0], out[out.len() - 1])) < 1e-9 {
            out.pop();
        }
        Some(out)
    }

    /// Seite mit gekrümmter Trägerfläche → Dreiecke an `out`; `false`, wenn nicht gelungen.
    pub(super) fn curved_face(&mut self, s: &Surface, rings: &[Vec<V3>], same_sense: bool, out: &mut Mesh) -> bool {
        match crate::ifc_nurbs::tessellate_face(s, rings, same_sense) {
            Some(m) => {
                out.append(&m, &Xf::IDENTITY);
                true
            }
            None => {
                self.skip("IFCADVANCEDFACE (Parameterraum, eben zerlegt)");
                false
            }
        }
    }

    /// Leitkurve eines Sweeps mit StartParam/EndParam (`start`/`end` = Argumentnummern). Werte als
    /// IfcLengthMeasure (IFC4.3) = Länge ab Kurvenanfang, sonst Parameter der Kurve (`curve_t`).
    pub(super) fn sweep_path(&mut self, e: &Entity, path: usize, start: usize, end: usize) -> Option<Vec<V3>> {
        let pts = self.curve_t(e.arg(path), 0)?;
        let read = |v: Option<&Value>| -> Option<(f64, bool)> {
            match v? {
                Value::Typed(n, a) if n == "IFCLENGTHMEASURE" || n == "IFCNONNEGATIVELENGTHMEASURE" || n == "IFCPOSITIVELENGTHMEASURE" => {
                    Some((a.first()?.as_f64()? * self.len_scale, true))
                }
                other => other.as_f64().map(|x| (x, false)),
            }
        };
        let (s, t) = (read(e.arg(start)), read(e.arg(end)));
        let points: Vec<V3> = pts.iter().map(|x| x.1).collect();
        if s.is_none() && t.is_none() {
            return Some(points);
        }
        let params: Vec<f64> = pts.iter().map(|x| x.0).collect();
        let mut lengths = Vec::with_capacity(points.len());
        let mut acc = 0.0;
        for (i, p) in points.iter().enumerate() {
            if i > 0 {
                acc += len(sub(*p, points[i - 1]));
            }
            lengths.push(acc);
        }
        // Beide Grenzen als Länge ausdrücken (Parameter → Länge über die Punktfolge).
        let to_len = |x: Option<(f64, bool)>, dflt: f64| -> f64 {
            match x {
                None => dflt,
                Some((v, true)) => v,
                Some((v, false)) => {
                    if params.windows(2).any(|w| !(w[1] >= w[0])) {
                        return dflt;
                    }
                    let v = v.clamp(params[0], params[params.len() - 1]);
                    let i = params.partition_point(|p| *p <= v).clamp(1, params.len().max(2) - 1);
                    let (pa, pb) = (params[i - 1], params[i]);
                    let f = if pb > pa { (v - pa) / (pb - pa) } else { 0.0 };
                    lengths[i - 1] + (lengths[i] - lengths[i - 1]) * f
                }
            }
        };
        if points.len() < 2 {
            return Some(points);
        }
        let k0 = to_len(s, 0.0);
        let k1 = to_len(t, acc);
        Some(trim_by_keys(&points, &lengths, k0, k1))
    }

    /// IfcGridPlacement: Schnittpunkt zweier (versetzter) Rasterachsen im System des Rasters, Richtung aus
    /// PlacementRefDirection (Richtung oder zweiter Schnittpunkt), sonst die des Rasters.
    pub(super) fn grid_placement(&mut self, e: &Entity, depth: usize) -> Option<Xf> {
        // IFC4.3: (PlacementRelTo, PlacementLocation, PlacementRefDirection); früher ohne PlacementRelTo.
        let off = if e.args.len() >= 3 { 1 } else { 0 };
        let (grid_xf, o) = self.grid_intersection(e.arg(off), depth)?;
        let x = match self.ent_v(e.arg(off + 1)) {
            Some((_, d)) if d.ty == "IFCDIRECTION" => {
                let d = self.direction(e.arg(off + 1))?;
                [d[0], d[1], 0.0]
            }
            Some((_, d)) if d.ty == "IFCVIRTUALGRIDINTERSECTION" => {
                let (_, q) = self.grid_intersection(e.arg(off + 1), depth)?;
                sub(q, o)
            }
            _ => [1.0, 0.0, 0.0],
        };
        let x = norm([x[0], x[1], 0.0]).unwrap_or([1.0, 0.0, 0.0]);
        let local = Xf::from_axes(x, [-x[1], x[0], 0.0], [0.0, 0.0, 1.0], o);
        Some(grid_xf.then_after(&local))
    }

    /// IfcVirtualGridIntersection → (Platzierung des Rasters, Punkt im Raster-System).
    fn grid_intersection(&mut self, v: Option<&Value>, depth: usize) -> Option<(Xf, V3)> {
        let (_, vi) = self.ent_v(v)?;
        if vi.ty != "IFCVIRTUALGRIDINTERSECTION" {
            return None;
        }
        let axes: Vec<u64> = vi.arg(0)?.as_list()?.iter().filter_map(|x| x.as_ref_id()).collect();
        if axes.len() != 2 {
            return None;
        }
        let offs: Vec<f64> = vi.arg(1).and_then(|v| v.as_list()).unwrap_or(&[]).iter().map(|x| x.as_f64().unwrap_or(0.0) * self.len_scale).collect();
        let off = |i: usize| offs.get(i).copied().filter(|x| x.is_finite()).unwrap_or(0.0);
        let mut lines = Vec::new();
        for (k, a) in axes.iter().enumerate() {
            let ax = self.ent(*a)?;
            if ax.ty != "IFCGRIDAXIS" {
                return None;
            }
            let mut c = self.curve2d(ax.arg(1), MAX_CURVE_DEPTH - 2)?;
            if ax.arg(2).and_then(|v| v.as_enum()) == Some("F") {
                c.reverse();
            }
            // Versatz nach links (positiv) je Segment.
            let segs: Vec<([f64; 2], [f64; 2])> = c
                .windows(2)
                .filter_map(|w| {
                    let d = [w[1][0] - w[0][0], w[1][1] - w[0][1]];
                    let l = (d[0] * d[0] + d[1] * d[1]).sqrt();
                    (l > 1e-12).then(|| {
                        let n = [-d[1] / l * off(k), d[0] / l * off(k)];
                        ([w[0][0] + n[0], w[0][1] + n[1]], [w[1][0] + n[0], w[1][1] + n[1]])
                    })
                })
                .collect();
            if segs.is_empty() {
                return None;
            }
            lines.push(segs);
        }
        // Schnittpunkt: zuerst innerhalb beider Segmente, sonst der Geraden mit dem kleinsten Überstand.
        let mut best: Option<(f64, [f64; 2])> = None;
        for a in &lines[0] {
            for b in &lines[1] {
                let (p, r) = (a.0, [a.1[0] - a.0[0], a.1[1] - a.0[1]]);
                let (q, s) = (b.0, [b.1[0] - b.0[0], b.1[1] - b.0[1]]);
                let den = r[0] * s[1] - r[1] * s[0];
                if den.abs() < 1e-15 {
                    continue;
                }
                let qp = [q[0] - p[0], q[1] - p[1]];
                let t = (qp[0] * s[1] - qp[1] * s[0]) / den;
                let u = (qp[0] * r[1] - qp[1] * r[0]) / den;
                let over = (-t).max(t - 1.0).max(0.0) + (-u).max(u - 1.0).max(0.0);
                if best.is_none_or(|bst| over < bst.0) {
                    best = Some((over, [p[0] + r[0] * t, p[1] + r[1] * t]));
                }
            }
        }
        let (_, pt) = best?;
        // Raster, zu dem die erste Achse gehört (UAxes/VAxes/WAxes).
        let grid = self.grid_of_axis(axes[0])?;
        let gp = self.ent(grid)?.arg(5).and_then(|v| v.as_ref_id());
        let xf = match gp {
            Some(p) if depth < super::MAX_PLACEMENT_DEPTH => self.object_placement(p, depth + 1),
            _ => Xf::IDENTITY,
        };
        Some((xf, [pt[0], pt[1], off(2)]))
    }

    fn grid_of_axis(&mut self, axis: u64) -> Option<u64> {
        if self.grid_axes.is_none() {
            let mut m: HashMap<u64, u64> = HashMap::new();
            for (id, e) in &self.f.entities {
                if e.ty != "IFCGRID" {
                    continue;
                }
                for k in 7..=9 {
                    for a in e.arg(k).and_then(|v| v.as_list()).unwrap_or(&[]) {
                        if let Some(a) = a.as_ref_id() {
                            m.entry(a).or_insert(*id);
                        }
                    }
                }
            }
            self.grid_axes = Some(m);
        }
        self.grid_axes.as_ref()?.get(&axis).copied()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trim_polyline_open_closed_and_whole() {
        let sq = vec![[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [1.0, 1.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 0.0]];
        // Von (1, 0.5) über die Ecken nach (0.5, 0): über den Anfang hinweg.
        let t = trim_polyline(&sq, [1.0, 0.5, 0.0], [0.5, 0.0, 0.0], false);
        assert_eq!(t, vec![[1.0, 0.5, 0.0], [1.0, 1.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 0.0], [0.5, 0.0, 0.0]]);
        // Ganze Schleife ab (0.5, 0).
        let w = trim_polyline(&sq, [0.5, 0.0, 0.0], [0.5, 0.0, 0.0], true);
        assert_eq!(w.len(), 6);
        assert_eq!(w[0], w[5]);
        // Offen, vorwärts.
        let open = [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [2.0, 0.0, 0.0]];
        assert_eq!(trim_polyline(&open, [0.5, 0.0, 0.0], [1.5, 0.0, 0.0], false), vec![[0.5, 0.0, 0.0], [1.0, 0.0, 0.0], [1.5, 0.0, 0.0]]);
    }

    #[test]
    fn trim_by_keys_interpolates() {
        let p = [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [2.0, 0.0, 0.0]];
        let k = [0.0, 1.0, 2.0];
        assert_eq!(trim_by_keys(&p, &k, 0.5, 1.5), vec![[0.5, 0.0, 0.0], [1.0, 0.0, 0.0], [1.5, 0.0, 0.0]]);
        assert_eq!(trim_by_keys(&p, &k, -1.0, 5.0), p.to_vec());
        assert_eq!(trim_by_keys(&p, &[0.0, 2.0, 1.0], 0.5, 1.0), p.to_vec());
    }
}
