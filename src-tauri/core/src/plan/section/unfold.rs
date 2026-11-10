//! [176] Geknickter Schnitt (`DrawingLevel.bendPoints`): Abwicklung. Jedes Segment der Schnittlinie schneidet
//! mit seiner eigenen Ebene (Blickrichtung = Normale des Segments, Seite über `directionSign`). Was ein
//! Segment zeigt, ist auf seinen Streifen begrenzt: an den Knicken auf die Winkelhalbierende (Schnittflächen
//! und Projektion, nichts doppelt, nichts fehlt), aussen offen wie beim geraden Schnitt. Die Teilbilder
//! liegen entlang der Abwicklung lückenlos aneinander (u = abgewickelte Länge, gleiche Richtung wie der
//! gerade Schnitt vom ersten zum letzten Punkt). Ohne Knickpunkte läuft alles wie bisher.

use super::*;

/// Streifen eines Segments in dessen eigenen Ansichtskoordinaten (u entlang der Ebene, Tiefe hinter ihr).
#[derive(Clone, Debug)]
pub struct Strip {
    /// u-Bereich auf der Ebene (Tiefe 0); aussen am ersten/letzten Segment unendlich.
    pub lo: f64,
    pub hi: f64,
    /// Halbebenen `a·u + b·Tiefe <= c` (Winkelhalbierende an den Knicken).
    pub half: Vec<[f64; 3]>,
    /// Verschiebung in die Abwicklung (u global = u lokal + offset).
    pub offset: f64,
}

/// Teil-Ebenen eines Schnitts: ohne Knicke die Ebene selbst (ohne Streifen), sonst je Segment
/// (gerade Ebene, Streifen).
pub fn parts(level: &LevelSpec) -> Vec<(LevelSpec, Option<Strip>)> {
    segments(level).unwrap_or_else(|| vec![(level.clone(), None)])
}

/// Linienzug Anfang, Knicke, Ende; doppelte und gerade durchlaufende Knicke entfallen, ebenso
/// Umkehrungen (Winkelhalbierende unbestimmt).
fn path(level: &LevelSpec) -> Option<Vec<Vec2>> {
    let [p0, p1] = level.line?;
    if level.bends.is_empty() {
        return None;
    }
    let mut pts: Vec<Vec2> = vec![p0];
    for q in level.bends.iter().copied().chain([p1]) {
        if !(q.x.is_finite() && q.y.is_finite()) {
            continue;
        }
        let last = *pts.last()?;
        if hypot2(q.x - last.x, q.y - last.y) < 1e-6 {
            continue;
        }
        pts.push(q);
    }
    // Gerade durchlaufende oder umkehrende Knicke weglassen (wiederholt, bis stabil).
    loop {
        let n = pts.len();
        let bad = (1..n.saturating_sub(1)).find(|&i| {
            let (a, b, c) = (pts[i - 1], pts[i], pts[i + 1]);
            let (d0, d1) = ((b.x - a.x, b.y - a.y), (c.x - b.x, c.y - b.y));
            let (l0, l1) = (hypot2(d0.0, d0.1), hypot2(d1.0, d1.1));
            let cross = (d0.0 * d1.1 - d0.1 * d1.0) / (l0 * l1);
            let dot = (d0.0 * d1.0 + d0.1 * d1.1) / (l0 * l1);
            (cross.abs() < 1e-9 && dot > 0.0) || dot < -0.995
        });
        match bad {
            Some(i) => {
                pts.remove(i);
            }
            None => break,
        }
    }
    (pts.len() >= 3).then_some(pts)
}

/// Segmente eines geknickten Schnitts; `None` ohne (wirksame) Knicke.
pub fn segments(level: &LevelSpec) -> Option<Vec<(LevelSpec, Option<Strip>)>> {
    let pts = path(level)?;
    let sign = level.direction_sign.unwrap_or(1.0);
    let n = pts.len() - 1;
    let dir = |i: usize| {
        let (a, b) = (pts[i], pts[i + 1]);
        let l = hypot2(b.x - a.x, b.y - a.y);
        ((b.x - a.x) / l, (b.y - a.y) / l, l)
    };
    let mut out = Vec::with_capacity(n);
    let mut cum = 0.0;
    for i in 0..n {
        let (dx, dy, len) = dir(i);
        let perp = (-dy, dx);
        let mut half = Vec::new();
        // Lokal: P − S = sign·(u·d + Tiefe·perp).
        if i > 0 {
            let (px, py, _) = dir(i - 1);
            let w = (px + dx, py + dy);
            let (dw, pw) = (dx * w.0 + dy * w.1, perp.0 * w.0 + perp.1 * w.1);
            half.push([-sign * dw, -sign * pw, 0.0]);
        }
        if i + 1 < n {
            let (nx, ny, _) = dir(i + 1);
            let w = (dx + nx, dy + ny);
            let (dw, pw) = (dx * w.0 + dy * w.1, perp.0 * w.0 + perp.1 * w.1);
            half.push([sign * dw, sign * pw, len * dw]);
        }
        // u-Bereich auf der Ebene: Anfang bei 0, Ende bei sign·len.
        let start_open = i == 0;
        let end_open = i + 1 == n;
        let (s_u, e_u) = (0.0, sign * len);
        let (start_b, end_b) = (if start_open { -sign * f64::INFINITY } else { s_u }, if end_open { sign * f64::INFINITY } else { e_u });
        let (lo, hi) = (start_b.min(end_b), start_b.max(end_b));
        let seg = LevelSpec { line: Some([pts[i], pts[i + 1]]), bends: Vec::new(), ..level.clone() };
        out.push((seg, Some(Strip { lo, hi, half, offset: sign * cum })));
        cum += len;
    }
    Some(out)
}

/// Knicke in der Abwicklung (u global), für die Knicklinien im Schnitt.
pub fn bend_us(level: &LevelSpec) -> Vec<f64> {
    segments(level).map(|s| s.iter().skip(1).filter_map(|(_, st)| st.as_ref().map(|st| st.offset)).collect()).unwrap_or_default()
}

// ── Zuschneiden ───────────────────────────────────────────────────────────────

/// Sutherland-Hodgman an einer Halbebene `f(p) <= 0` mit Kanten-Merkmal (`flag[i]` gilt für Kante i → i+1):
/// Kanten entlang der Schnittgeraden bekommen `cut_flag`.
fn clip_ring<T: Copy>(pts: &[T], flags: &[bool], f: &dyn Fn(&T) -> f64, lerp: &dyn Fn(&T, &T, f64) -> T, cut_flag: bool) -> (Vec<T>, Vec<bool>) {
    let n = pts.len();
    let (mut out, mut of) = (Vec::with_capacity(n + 2), Vec::with_capacity(n + 2));
    for i in 0..n {
        let (p, q) = (&pts[i], &pts[(i + 1) % n]);
        let fl = flags.get(i).copied().unwrap_or(false);
        let (fp, fq) = (f(p), f(q));
        let (pin, qin) = (fp <= 0.0, fq <= 0.0);
        // Merkmal gilt für die vom Punkt ausgehende Kante: Teil der Originalkante oder (nach einem Austritt)
        // entlang der Schnittgeraden bis zum nächsten Eintritt.
        if pin {
            out.push(*p);
            of.push(fl);
        }
        if pin != qin {
            out.push(lerp(p, q, fp / (fp - fq)));
            of.push(if pin { cut_flag } else { fl });
        }
    }
    (out, of)
}

fn lerp2(a: &[f64; 2], b: &[f64; 2], t: f64) -> [f64; 2] {
    [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
}

/// Polygon (u, v) auf `lo <= u <= hi`, mit „ohne Strich“-Kanten (`nse`, Indizes); neue Kanten auf den
/// Grenzen ohne Strich. `None`, wenn nichts bleibt.
pub(super) fn clip_poly_u(pts: &[[f64; 2]], nse: Option<&[f64]>, lo: f64, hi: f64) -> Option<(Vec<[f64; 2]>, Option<Vec<f64>>)> {
    if pts.iter().all(|q| q[0] >= lo && q[0] <= hi) {
        return Some((pts.to_vec(), nse.map(|n| n.to_vec())));
    }
    let mut flags = vec![false; pts.len()];
    for &k in nse.unwrap_or(&[]) {
        if let Some(f) = flags.get_mut(k as usize) {
            *f = true;
        }
    }
    let mut cur = pts.to_vec();
    if lo.is_finite() {
        (cur, flags) = clip_ring(&cur, &flags, &|q| lo - q[0], &|a, b, t| { let mut x = lerp2(a, b, t); x[0] = lo; x }, true);
    }
    if hi.is_finite() && cur.len() >= 3 {
        (cur, flags) = clip_ring(&cur, &flags, &|q| q[0] - hi, &|a, b, t| { let mut x = lerp2(a, b, t); x[0] = hi; x }, true);
    }
    if cur.len() < 3 {
        return None;
    }
    let nse: Vec<f64> = flags.iter().enumerate().filter(|(_, f)| **f).map(|(i, _)| i as f64).collect();
    Some((cur, (!nse.is_empty()).then_some(nse)))
}

/// Fläche der Projektion (u, Höhe, Tiefe) auf die Halbebenen des Streifens; neue Kanten ungezeichnet.
pub(super) fn clip_face(mut f: crate::hlr::Face, half: &[[f64; 3]]) -> Option<crate::hlr::Face> {
    for h in half {
        let g = |q: &[f64; 3]| h[0] * q[0] + h[1] * q[2] - h[2];
        if f.pts.iter().all(|q| g(q) <= 0.0) {
            continue;
        }
        let flags = if f.no_edge.is_empty() { vec![false; f.pts.len()] } else { f.no_edge.clone() };
        let (pts, ne) = clip_ring(&f.pts, &flags, &g, &|a, b, t| [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t], true);
        if pts.len() < 3 {
            return None;
        }
        f.pts = pts;
        f.no_edge = ne;
    }
    Some(f)
}

/// Ergebnis eines Segments auf seinen Streifen begrenzen (Ebenen-Teile: Schnittflächen, Gelände, Erdreich,
/// offene Netz-Schnittlinien; die Projektion ist schon in `projection_edges` zugeschnitten).
pub(super) fn clip_output(out: &mut Output, s: &Strip) {
    let (lo, hi) = (s.lo, s.hi);
    out.cuts = std::mem::take(&mut out.cuts)
        .into_iter()
        .filter_map(|mut c| {
            let (pts, nse) = clip_poly_u(&c.pts, c.nse.as_deref(), lo, hi)?;
            c.pts = pts;
            c.nse = nse;
            Some(c)
        })
        .collect();
    out.profiles = std::mem::take(&mut out.profiles).into_iter().flat_map(|pr| clip_line_to_u(&pr.pts, lo, hi).into_iter().map(move |pts| Profile { pts, ..pr.clone() })).collect();
    out.earth = std::mem::take(&mut out.earth).into_iter().filter_map(|(pts, h)| clip_poly_u(&pts, None, lo, hi).map(|(p, _)| (p, h))).collect();
    out.mesh_lines = std::mem::take(&mut out.mesh_lines).into_iter().flat_map(|(k, pts)| clip_line_to_u(&pts, lo, hi).into_iter().map(move |p| (k, p))).collect();
}

/// Ergebnis um `du` entlang u verschieben (in die Abwicklung).
pub(super) fn shift_output(out: &mut Output, du: f64) {
    if du == 0.0 {
        return;
    }
    let sh = |q: &mut [f64; 2]| q[0] += du;
    out.cuts.iter_mut().flat_map(|c| c.pts.iter_mut()).for_each(sh);
    for e in out.visible.iter_mut().chain(out.hidden.iter_mut()) {
        e.a[0] += du;
        e.b[0] += du;
    }
    out.profiles.iter_mut().flat_map(|p| p.pts.iter_mut()).for_each(sh);
    out.earth.iter_mut().flat_map(|p| p.0.iter_mut()).for_each(sh);
    out.mesh_lines.iter_mut().flat_map(|p| p.1.iter_mut()).for_each(sh);
}

/// Teilergebnis anhängen (Netze und Gelände-Id sind in allen Segmenten dieselben).
pub(super) fn merge_output(acc: &mut Option<Output>, o: Output) {
    let Some(a) = acc else {
        *acc = Some(o);
        return;
    };
    a.cuts.extend(o.cuts);
    a.visible.extend(o.visible);
    a.hidden.extend(o.hidden);
    a.profiles.extend(o.profiles);
    a.earth.extend(o.earth);
    a.mesh_lines.extend(o.mesh_lines);
    if a.terrain_id.is_none() {
        a.terrain_id = o.terrain_id;
    }
    if a.meshes.is_empty() {
        a.meshes = o.meshes;
    }
}

// ── Primitive (Öffnungen, Achsen, Bäume) ─────────────────────────────────────

/// Bezugs-u eines Primitivs (Mitte bzw. Anker).
fn anchor_u(q: &Primitive) -> f64 {
    match q {
        Primitive::Polygon { pts, .. } => pts.iter().map(|p| p.x).sum::<f64>() / pts.len().max(1) as f64,
        Primitive::Line { a, b, .. } => 0.5 * (a.x + b.x),
        Primitive::Arc { center, .. } | Primitive::DrawingCircle { center, .. } | Primitive::DrawingArc { center, .. } => center.x,
        Primitive::Text { at, .. } | Primitive::DrawingText { at, .. } => at.x,
        Primitive::DrawingTextPath { path_pts, .. } => path_pts.first().map_or(0.0, |p| p.x),
        Primitive::DrawingImage { min, max, .. } => 0.5 * (min.x + max.x),
    }
}

fn shift_prim(q: &mut Primitive, du: f64) {
    match q {
        Primitive::Polygon { pts, .. } => pts.iter_mut().for_each(|p| p.x += du),
        Primitive::Line { a, b, .. } => {
            a.x += du;
            b.x += du;
        }
        Primitive::Arc { center, from, to, .. } => {
            center.x += du;
            from.x += du;
            to.x += du;
        }
        Primitive::Text { at, .. } | Primitive::DrawingText { at, .. } => at.x += du,
        Primitive::DrawingTextPath { path_pts, .. } => path_pts.iter_mut().for_each(|p| p.x += du),
        Primitive::DrawingImage { min, max, .. } => {
            min.x += du;
            max.x += du;
        }
        Primitive::DrawingCircle { center, .. } | Primitive::DrawingArc { center, .. } => center.x += du,
    }
}

/// Primitive auf den u-Bereich des Streifens schneiden (Linien und Flächen geometrisch, sonst nach Anker)
/// und in die Abwicklung schieben. Ohne Streifen unverändert.
pub fn clip_prims(prims: Vec<Primitive>, s: Option<&Strip>) -> Vec<Primitive> {
    let Some(s) = s else { return prims };
    let (lo, hi) = (s.lo, s.hi);
    let mut out = Vec::with_capacity(prims.len());
    for mut q in prims {
        let keep = match &mut q {
            Primitive::Polygon { pts, no_stroke_edges, .. } => {
                let p2: Vec<[f64; 2]> = pts.iter().map(|p| [p.x, p.y]).collect();
                match clip_poly_u(&p2, no_stroke_edges.as_deref(), lo, hi) {
                    Some((c, nse)) => {
                        *pts = c.into_iter().map(|p| Vec2 { x: p[0], y: p[1] }).collect();
                        *no_stroke_edges = nse;
                        true
                    }
                    None => false,
                }
            }
            Primitive::Line { a, b, .. } => match clip_line_to_u(&[[a.x, a.y], [b.x, b.y]], lo, hi).first() {
                Some(l) if l.len() == 2 => {
                    *a = Vec2 { x: l[0][0], y: l[0][1] };
                    *b = Vec2 { x: l[1][0], y: l[1][1] };
                    true
                }
                _ => false,
            },
            other => {
                let u = anchor_u(other);
                u >= lo - 1e-9 && u <= hi + 1e-9
            }
        };
        if keep {
            shift_prim(&mut q, s.offset);
            out.push(q);
        }
    }
    out
}

/// [176] Grundriss-Unterlage: Primitive eines Segments in dessen Ansichtskoordinaten (x = u, y = Tiefe hinter
/// der Ebene) auf den ganzen Streifen schneiden (u-Bereich und Winkelhalbierende) und in die Abwicklung
/// schieben. Flächen und Linien geometrisch, alles andere nach Anker.
pub fn clip_plan_prims(prims: Vec<Primitive>, s: &Strip) -> Vec<Primitive> {
    let g = |h: &[f64; 3], x: f64, y: f64| h[0] * x + h[1] * y - h[2];
    let mut out = Vec::with_capacity(prims.len());
    for mut q in prims {
        let keep = match &mut q {
            Primitive::Polygon { pts, no_stroke_edges, .. } => {
                let p2: Vec<[f64; 2]> = pts.iter().map(|p| [p.x, p.y]).collect();
                match clip_poly_u(&p2, no_stroke_edges.as_deref(), s.lo, s.hi) {
                    Some((mut cur, nse)) => {
                        let mut flags = vec![false; cur.len()];
                        for &k in nse.as_deref().unwrap_or(&[]) {
                            if let Some(f) = flags.get_mut(k as usize) {
                                *f = true;
                            }
                        }
                        for h in &s.half {
                            if cur.iter().all(|q| g(h, q[0], q[1]) <= 0.0) {
                                continue;
                            }
                            (cur, flags) = clip_ring(&cur, &flags, &|q| g(h, q[0], q[1]), &|a, b, t| lerp2(a, b, t), true);
                            if cur.len() < 3 {
                                break;
                            }
                        }
                        if cur.len() < 3 {
                            false
                        } else {
                            let nse: Vec<f64> = flags.iter().enumerate().filter(|(_, f)| **f).map(|(i, _)| i as f64).collect();
                            *pts = cur.into_iter().map(|p| Vec2 { x: p[0], y: p[1] }).collect();
                            *no_stroke_edges = (!nse.is_empty()).then_some(nse);
                            true
                        }
                    }
                    None => false,
                }
            }
            Primitive::Line { a, b, .. } => match clip_line_to_u(&[[a.x, a.y], [b.x, b.y]], s.lo, s.hi).first() {
                Some(l) if l.len() == 2 => {
                    let (mut p, mut r) = (l[0], l[1]);
                    let mut ok = true;
                    for h in &s.half {
                        let (gp, gr) = (g(h, p[0], p[1]), g(h, r[0], r[1]));
                        if gp > 0.0 && gr > 0.0 {
                            ok = false;
                            break;
                        }
                        if gp > 0.0 {
                            p = lerp2(&p, &r, gp / (gp - gr));
                        } else if gr > 0.0 {
                            r = lerp2(&p, &r, gp / (gp - gr));
                        }
                    }
                    if ok {
                        *a = Vec2 { x: p[0], y: p[1] };
                        *b = Vec2 { x: r[0], y: r[1] };
                    }
                    ok
                }
                _ => false,
            },
            other => {
                let (u, w) = anchor_pt(other);
                u >= s.lo - 1e-9 && u <= s.hi + 1e-9 && s.half.iter().all(|h| g(h, u, w) <= 1e-9)
            }
        };
        if keep {
            shift_prim(&mut q, s.offset);
            out.push(q);
        }
    }
    out
}

/// Anker (x, y) eines Primitivs.
fn anchor_pt(q: &Primitive) -> (f64, f64) {
    match q {
        Primitive::Polygon { pts, .. } => {
            let n = pts.len().max(1) as f64;
            (pts.iter().map(|p| p.x).sum::<f64>() / n, pts.iter().map(|p| p.y).sum::<f64>() / n)
        }
        Primitive::Line { a, b, .. } => (0.5 * (a.x + b.x), 0.5 * (a.y + b.y)),
        Primitive::Arc { center, .. } | Primitive::DrawingCircle { center, .. } | Primitive::DrawingArc { center, .. } => (center.x, center.y),
        Primitive::Text { at, .. } | Primitive::DrawingText { at, .. } => (at.x, at.y),
        Primitive::DrawingTextPath { path_pts, .. } => path_pts.first().map_or((0.0, 0.0), |p| (p.x, p.y)),
        Primitive::DrawingImage { min, max, .. } => (0.5 * (min.x + max.x), 0.5 * (min.y + max.y)),
    }
}

/// Ganze Gruppe (z. B. ein Baum) behalten, wenn ihre Mitte im Streifen liegt; verschoben.
pub fn keep_group(prims: Vec<Primitive>, s: Option<&Strip>) -> Vec<Primitive> {
    let Some(s) = s else { return prims };
    let polys: Vec<f64> = prims.iter().filter(|q| matches!(q, Primitive::Polygon { .. })).map(anchor_u).collect();
    let all: Vec<f64> = if polys.is_empty() { prims.iter().map(anchor_u).collect() } else { polys };
    let u = all.iter().sum::<f64>() / all.len().max(1) as f64;
    if !(u >= s.lo && u <= s.hi) {
        return Vec::new();
    }
    let mut prims = prims;
    prims.iter_mut().for_each(|q| shift_prim(q, s.offset));
    prims
}

/// [176] Dünne senkrechte Knicklinien über die Höhe des Schnitts (CH-Praxis).
pub fn bend_lines(level: &LevelSpec, bounds: [f64; 4]) -> Vec<Primitive> {
    bend_us(level)
        .into_iter()
        .map(|u| Primitive::Line {
            a: Vec2 { x: u, y: bounds[1] },
            b: Vec2 { x: u, y: bounds[3] },
            cls: "section-bend".into(),
            weight_mm: BEND_LINE_MM,
            dash: None,
            zigzag: None,
            motif: None,
            color: Some(SECTION_VISIBLE_INK.into()),
            drawing_id: None,
            opening_id: None,
            stair_id: None,
            greyed: None,
            opacity: None,
        })
        .collect()
}

/// [176] Strichstärke der Knicklinie (Papier-mm).
const BEND_LINE_MM: f64 = 0.13;

/// `compute_section` für einen geknickten Schnitt: je Segment rechnen, zuschneiden, verschieben, sammeln.
pub(super) fn compute_unfolded(p: &Project, segs: &[(LevelSpec, Option<Strip>)], bodies: &[BodyMesh]) -> Result<Option<Output>, String> {
    let mut acc: Option<Output> = None;
    for (l, s) in segs {
        let Some(mut o) = compute_plane(p, l, bodies, s.as_ref())? else { continue };
        if let Some(s) = s {
            shift_output(&mut o, s.offset);
        }
        merge_output(&mut acc, o);
    }
    Ok(acc)
}
