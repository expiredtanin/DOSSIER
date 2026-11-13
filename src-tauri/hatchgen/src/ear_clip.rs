//! Ear-Clipping eines einfachen (lochfreien) Polygons, konvex oder konkav — EINE Fassung für Kern
//! (`gpu_compile`, Plan-Chunks der Webview), `render2d` (WASM-Plan) und `render3d` (Platten-Deckel).
//!
//! Robust gegen das, was Booleans und abgetastete Umrisse liefern ([230], weisse Löcher im Geländeschatten):
//! doppelte und (fast) kollineare Ecken fallen vorab und nach jedem Ohr weg; gleich liegende, nicht benachbarte
//! Ecken (berührende Ringteile) sperren kein Ohr; findet ein Umlauf kein sauberes Ohr, wird die konvexste Ecke
//! trotzdem abgeschnitten, statt abzubrechen und den Rest leer zu lassen.

/// Dreiecks-Indizes (0-basiert auf `pts`, gegen den Uhrzeigersinn); leer bei < 3 Ecken oder Unsinn (NaN).
pub fn triangulate(pts: &[[f64; 2]]) -> Vec<u32> {
    let n = pts.len();
    if n < 3 || pts.iter().any(|p| !(p[0].is_finite() && p[1].is_finite())) {
        return Vec::new();
    }
    let mut area2 = 0.0;
    let (mut x0, mut y0, mut x1, mut y1) = (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
    for i in 0..n {
        let (p, q) = (pts[i], pts[(i + 1) % n]);
        area2 += p[0] * q[1] - q[0] * p[1];
        x0 = x0.min(p[0]);
        y0 = y0.min(p[1]);
        x1 = x1.max(p[0]);
        y1 = y1.max(p[1]);
    }
    let size = (x1 - x0).max(y1 - y0);
    if !(size > 0.0) || area2 == 0.0 {
        return Vec::new();
    }
    // Toleranzen relativ zur Ausdehnung (Plan in Metern, Glyphen/Bildschirm in anderen Einheiten).
    let eps_len2 = (size * 1e-9) * (size * 1e-9);
    let cross = |a: usize, b: usize, c: usize| {
        let (a, b, c) = (pts[a], pts[b], pts[c]);
        (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
    };
    let same = |a: usize, b: usize| {
        let (dx, dy) = (pts[a][0] - pts[b][0], pts[a][1] - pts[b][1]);
        dx * dx + dy * dy <= eps_len2
    };
    // Flach (kollinear oder Spitze, die zurückläuft): `b` liegt höchstens `size·1e-7` neben der Geraden a–c (bzw. den
    // Kanten), also unter dem Rundungsrauschen von f32-Koordinaten (render2d) — sonst kreuzen sich fast kollineare
    // Abtastkanten nach dem Runden und das Ohr-Schneiden überlappt.
    let tol = size * 1e-7;
    let flat = |a: usize, b: usize, c: usize| {
        if same(a, b) || same(b, c) {
            return true;
        }
        let len = |u: usize, v: usize| (pts[v][0] - pts[u][0]).hypot(pts[v][1] - pts[u][1]);
        let k = cross(a, b, c).abs();
        k <= 1e-10 * len(a, b) * len(b, c) || k <= tol * len(a, b).max(len(b, c)).max(len(a, c))
    };

    // Doppelt verkettete Liste gegen den Uhrzeigersinn.
    let order: Vec<usize> = if area2 > 0.0 { (0..n).collect() } else { (0..n).rev().collect() };
    let mut next = vec![0usize; n];
    let mut prev = vec![0usize; n];
    for i in 0..n {
        next[order[i]] = order[(i + 1) % n];
        prev[order[i]] = order[(i + n - 1) % n];
    }
    let mut alive = vec![true; n];
    let mut remaining = n;
    // Entartete Ecken entfernen, bis keine mehr übrig sind (Arbeitsliste: Nachbarn einer entfernten Ecke).
    let mut work: Vec<usize> = order.clone();
    let mut start = order[0];
    while let Some(b) = work.pop() {
        if remaining < 3 {
            return Vec::new();
        }
        if !alive[b] {
            continue;
        }
        let (a, c) = (prev[b], next[b]);
        if flat(a, b, c) {
            alive[b] = false;
            next[a] = c;
            prev[c] = a;
            remaining -= 1;
            start = a;
            work.push(a);
            work.push(c);
        }
    }
    if remaining < 3 {
        return Vec::new();
    }

    // Reflexe Ecken (inkl. flacher) als Liste mit Position: nur sie können in einem Ohr liegen.
    let mut reflex: Vec<usize> = Vec::new();
    let mut pos = vec![usize::MAX; n];
    fn add(i: usize, reflex: &mut Vec<usize>, pos: &mut [usize]) {
        if pos[i] == usize::MAX {
            pos[i] = reflex.len();
            reflex.push(i);
        }
    }
    fn del(i: usize, reflex: &mut Vec<usize>, pos: &mut [usize]) {
        let p = pos[i];
        if p != usize::MAX {
            let last = *reflex.last().unwrap();
            reflex.swap_remove(p);
            if last != i {
                pos[last] = p;
            }
            pos[i] = usize::MAX;
        }
    }
    let classify = |i: usize, prev: &[usize], next: &[usize], reflex: &mut Vec<usize>, pos: &mut [usize]| {
        if cross(prev[i], i, next[i]) <= 0.0 {
            add(i, reflex, pos);
        } else {
            del(i, reflex, pos);
        }
    };
    {
        let mut i = start;
        for _ in 0..remaining {
            classify(i, &prev, &next, &mut reflex, &mut pos);
            i = next[i];
        }
    }

    // Liegt p im Dreieck (a, b, c) (gegen den Uhrzeigersinn), Rand eingeschlossen — mit `tol` Spiel nach aussen: eine Ecke
    // genau auf der Diagonale (Ring, der sich längs einer Geraden berührt) sperrt das Ohr auch, wenn sie nach dem Runden
    // knapp ausserhalb liegt.
    // `strict` (zweite Stufe, wenn ein Umlauf kein Ohr fand): nur echt innen liegende Ecken sperren.
    let edge_in = |u: usize, v: usize, p: usize, strict: bool| {
        let l = (pts[v][0] - pts[u][0]).hypot(pts[v][1] - pts[u][1]);
        if strict {
            cross(u, v, p) > tol * l
        } else {
            cross(u, v, p) >= -tol * l
        }
    };
    let inside = |a: usize, b: usize, c: usize, p: usize, strict: bool| edge_in(a, b, p, strict) && edge_in(b, c, p, strict) && edge_in(c, a, p, strict);

    let mut tris: Vec<u32> = Vec::with_capacity(3 * (remaining - 2));
    let mut i = start;
    let mut streak = 0usize;
    let mut strict = false;
    // Beste Notlösung des laufenden Umlaufs: konvexste Ecke.
    let mut fallback: Option<(f64, usize)> = None;
    let mut guard: u64 = 0;
    let max_guard = (n as u64) * (n as u64) + 64;
    while remaining > 3 && guard < max_guard {
        guard += 1;
        let (a, b, c) = (prev[i], i, next[i]);
        let mut ear = false;
        if pos[b] == usize::MAX {
            let k = cross(a, b, c);
            if fallback.is_none_or(|(best, _)| k > best) {
                fallback = Some((k, b));
            }
            ear = !reflex.iter().any(|&v| v != a && v != c && !same(v, a) && !same(v, b) && !same(v, c) && inside(a, b, c, v, strict));
        }
        let cut = if ear {
            Some(b)
        } else {
            streak += 1;
            if streak > remaining && !strict {
                // Ein ganzer Umlauf ohne Ohr: noch einen Umlauf mit dem strengen Test (Ecken auf dem Rand sperren nicht).
                strict = true;
                streak = 0;
                fallback = None;
                None
            } else if streak > remaining {
                // Auch so keines: konvexste Ecke trotzdem (lieber eine Überlappung als ein Loch).
                fallback.map(|(_, v)| v)
            } else {
                None
            }
        };
        let Some(b) = cut else {
            i = c;
            if streak > remaining {
                break; // keine konvexe Ecke mehr (kann bei gültigem Umlaufsinn nicht vorkommen)
            }
            continue;
        };
        let (a, c) = (prev[b], next[b]);
        tris.extend_from_slice(&[a as u32, b as u32, c as u32]);
        alive[b] = false;
        next[a] = c;
        prev[c] = a;
        del(b, &mut reflex, &mut pos);
        remaining -= 1;
        streak = 0;
        strict = false;
        fallback = None;
        // Nachbarn, die jetzt flach sind, ohne Dreieck entfernen (Fläche null); deren Nachbarn erneut prüfen.
        let mut work = vec![a, c];
        let mut touched = vec![a, c];
        let mut keep = a;
        while let Some(v) = work.pop() {
            if remaining <= 3 {
                break;
            }
            if !alive[v] {
                continue;
            }
            let (p, q) = (prev[v], next[v]);
            if flat(p, v, q) {
                alive[v] = false;
                next[p] = q;
                prev[q] = p;
                del(v, &mut reflex, &mut pos);
                remaining -= 1;
                work.push(p);
                work.push(q);
                touched.push(p);
                touched.push(q);
                keep = p;
            }
        }
        let keep = if alive[keep] { keep } else if alive[c] { c } else { next[keep] };
        for v in touched {
            if alive[v] {
                classify(v, &prev, &next, &mut reflex, &mut pos);
            }
        }
        i = keep;
    }
    if remaining == 3 {
        let (a, b, c) = (prev[i], i, next[i]);
        if !flat(a, b, c) {
            tris.extend_from_slice(&[a as u32, b as u32, c as u32]);
        }
    }
    tris
}

#[cfg(test)]
mod tests {
    use super::triangulate;

    fn area(pts: &[[f64; 2]], t: &[u32]) -> f64 {
        t.chunks(3)
            .map(|c| {
                let (a, b, d) = (pts[c[0] as usize], pts[c[1] as usize], pts[c[2] as usize]);
                ((b[0] - a[0]) * (d[1] - a[1]) - (b[1] - a[1]) * (d[0] - a[0])) / 2.0
            })
            .sum()
    }

    fn poly_area(pts: &[[f64; 2]]) -> f64 {
        let n = pts.len();
        ((0..n).map(|i| pts[i][0] * pts[(i + 1) % n][1] - pts[(i + 1) % n][0] * pts[i][1]).sum::<f64>() / 2.0).abs()
    }

    #[test]
    fn quadrat_l_und_uhrzeigersinn() {
        let sq = [[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]];
        assert_eq!(triangulate(&sq).len(), 6);
        let l = [[0.0, 0.0], [2.0, 0.0], [2.0, 1.0], [1.0, 1.0], [1.0, 2.0], [0.0, 2.0]];
        let t = triangulate(&l);
        assert_eq!(t.len(), 12);
        assert!((area(&l, &t) - 3.0).abs() < 1e-12);
        let cw: Vec<_> = l.iter().rev().copied().collect();
        let t = triangulate(&cw);
        assert!((area(&cw, &t) - 3.0).abs() < 1e-12, "Dreiecke gegen den Uhrzeigersinn");
        assert!(triangulate(&sq[..2]).is_empty());
        assert!(triangulate(&[[0.0, 0.0], [f64::NAN, 1.0], [1.0, 1.0]]).is_empty());
        assert!(triangulate(&[[0.0, 0.0], [1.0, 1.0], [2.0, 2.0]]).is_empty());
    }

    /// [230] Abgetastete Umrisse (Geländeschatten): viele kollineare und doppelte Ecken, eine Kerbe, die eine
    /// Ecke genau auf die Diagonale legt — die Fläche wird ganz gedeckt, ohne Überlappung.
    #[test]
    fn kollineare_und_doppelte_ecken_decken_alles() {
        let mut pts = vec![];
        for k in 0..=40 {
            pts.push([k as f64 * 0.25, 0.0]);
        }
        pts.push([10.0, 0.0]); // doppelt
        for k in 1..=20 {
            pts.push([10.0, k as f64 * 0.25]);
        }
        pts.push([5.0, 5.0]);
        pts.push([5.0, 2.5]); // Kerbe bis zur halben Höhe
        pts.push([4.999_999_999_9, 5.0]);
        for k in (0..20).rev() {
            pts.push([0.0, k as f64 * 0.25]);
        }
        let t = triangulate(&pts);
        assert!((area(&pts, &t) - poly_area(&pts)).abs() < 1e-6, "{} vs {}", area(&pts, &t), poly_area(&pts));
    }

    /// Ring, der sich in einer Ecke selbst berührt (zwei Teile über einen Punkt): beide Teile gefüllt.
    #[test]
    fn beruehrender_ring() {
        let pts = [[0.0, 0.0], [2.0, 0.0], [2.0, 2.0], [4.0, 2.0], [4.0, 4.0], [2.0, 4.0], [2.0, 2.0], [0.0, 2.0]];
        let t = triangulate(&pts);
        assert!((area(&pts, &t) - 8.0).abs() < 1e-9, "{}", area(&pts, &t));
    }
    /// [230] Echte Stücke des Geländeschattens (Musterhaus komplex): eine Ecke doppelt entfernt liess den Rest leer;
    /// ein Ring, der sich längs einer Geraden selbst berührt, darf nicht überlappen — auch nach Runden auf f32 (render2d).
    #[test]
    fn echte_schattenstuecke() {
        let rings: [Vec<[f64; 2]>; 2] = [vec![[10.000000040828098, 15.084970913737656], [10.000000040828098, 14.999999962657334], [10.194999974070896, 14.999999962657334], [10.194999974070896, 14.744090877383591], [23.948633711634983, 11.860768519252185], [24.07260696202408, 11.900948367923142], [24.15000001698624, 11.999999962657334], [24.106066029368748, 12.106066070407271], [24.0000000408281, 12.150000058024766], [10.194999974070896, 15.044090948909163]], vec![[-3.144057814097323e-08, 10.182155557074182], [-0.19500002428802077, 10.000000007547968], [2.8164066634417395e-08, 10.000000007547968], [2.8164066634417395e-08, 10.19500000039541], [4.804999975711979, 10.19500000039541], [4.804999975711979, 14.683500476278894], [3.9529810233422897, 13.88760299245321], [3.952897755653538, 13.88752520839178], [3.7568593306848186, 13.886555202402704], [3.35824498370377, 13.514197059073084], [3.3705976291009563, 13.343580491938226], [1.051543561966099, 11.177279658712976], [1.0515312834092754, 11.17726821462118], [0.8562479300805705, 11.177003510393732], [0.7832402272531169, 11.108804710306757], [0.9419377727815288, 11.074893482126823], [0.7317420525857585, 10.878543086447351], [0.5367414636918681, 10.878542550005548], [-0.08068165346892897, 10.301788337626093], [-0.08068165346892897, 10.19500000039541], [-3.144057814097323e-08, 10.19500000039541]]];
        for r in &rings {
            for f32_ in [false, true] {
                let r: Vec<[f64; 2]> = if f32_ { r.iter().map(|p| [p[0] as f32 as f64, p[1] as f32 as f64]).collect() } else { r.clone() };
                let t = triangulate(&r);
                let abs: f64 = t.chunks(3).map(|c| area(&r, c).abs()).sum();
                assert!((abs - poly_area(&r)).abs() < 1e-4 * poly_area(&r), "{} vs {} (f32 {f32_})", abs, poly_area(&r));
            }
        }
    }
}
