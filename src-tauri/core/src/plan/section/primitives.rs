//! Schnitt-Ergebnis zu Plan-Primitiven: Poché mit Stil und Schraffur, dünne Schichten nach Massstab
//! zusammengefasst, Override-Gruppen, Projektionslinien, Gelände (`section_primitives_at()`). Die
//! Bausteine `polygon()`, `line()`, `v2()` und `Acc` nutzt auch die Ansicht (`plan/elevation.rs`).

use super::*;

pub(crate) fn polygon(pts: Vec<Vec2>, fill: &str, stroke: &str, w: f64, hatch: HatchRender) -> Primitive {
    Primitive::Polygon {
        pts,
        fill: fill.into(),
        stroke: stroke.into(),
        stroke_width_mm: w,
        hatch,
        greyed: None,
        opacity: None,
        no_stroke_edges: None,
        wall_id: None,
        drawing_id: None,
        ceiling_id: None,
        opening_id: None,
        stair_id: None,
        room_id: None,
        extruded_solid_id: None,
        context_object_id: None,
        column_id: None,
        roof_id: None,
        section_line_id: None,
    }
}

pub(crate) fn line(a: Vec2, b: Vec2, cls: &str, w: f64, color: &str) -> Primitive {
    Primitive::Line { a, b, cls: cls.into(), weight_mm: w, dash: None, zigzag: None, motif: None, color: Some(color.into()), drawing_id: None, opening_id: None, stair_id: None, greyed: None, opacity: None }
}

pub(crate) fn v2(x: f64, y: f64) -> Vec2 {
    Vec2 { x, y }
}

/// Ausmass wie `acc` in TS (`<`/`>`-Vergleiche, NaN bleibt draussen).
#[derive(Clone, Copy)]
pub(crate) struct Acc {
    pub min_x: f64,
    pub min_y: f64,
    pub max_x: f64,
    pub max_y: f64,
}

impl Acc {
    pub fn new() -> Acc {
        Acc { min_x: f64::INFINITY, min_y: f64::INFINITY, max_x: f64::NEG_INFINITY, max_y: f64::NEG_INFINITY }
    }
    pub fn add(&mut self, x: f64, y: f64) {
        if x < self.min_x {
            self.min_x = x;
        }
        if y < self.min_y {
            self.min_y = y;
        }
        if x > self.max_x {
            self.max_x = x;
        }
        if y > self.max_y {
            self.max_y = y;
        }
    }
    pub fn bounds(&self) -> [f64; 4] {
        if !self.min_x.is_finite() {
            [0.0, 0.0, 1.0, 1.0]
        } else {
            [self.min_x, self.min_y, self.max_x, self.max_y]
        }
    }
}

fn ring_len(r: &[[f64; 2]]) -> f64 {
    (0..r.len()).map(|i| { let (a, b) = (r[i], r[(i + 1) % r.len()]); hypot2(b[0] - a[0], b[1] - a[1]) }).sum()
}

pub(super) fn ring_area(r: &[[f64; 2]]) -> f64 {
    let mut a = 0.0;
    for i in 0..r.len() {
        let (p, q) = (r[i], r[(i + 1) % r.len()]);
        a += p[0] * q[1] - q[0] * p[1];
    }
    (a / 2.0).abs()
}

pub(super) fn ring_bbox(r: &[[f64; 2]]) -> [f64; 4] {
    r.iter().fold([f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY], |b, q| [b[0].min(q[0]), b[1].min(q[1]), b[2].max(q[0]), b[3].max(q[1])])
}

/// [140] Dämmschichten (Dämmschlange, Zickzack, Welle) unter der gemeinsamen Schwelle (`style::is_thin_layer`, 0.5 mm Papier) ab 1:75
/// ohne Muster (nur Füllung und feine Fuge): die Schlange einer 3–4 cm Trittschalldämmung wäre in 1:100 ein
/// dichter Zickzack-Balken. 1:50 (und `scale` 0) zeichnet sie immer.
pub fn plain_thin_insulation(mut cuts: Vec<Cut>, scale: f64) -> Vec<Cut> {
    if !simplify_thin_layers(Detail::Mittel, scale) {
        return cuts;
    }
    for c in &mut cuts {
        let Some(h) = c.hatch.as_mut() else { continue };
        if !matches!(h.pattern, HatchPattern::Insulation | HatchPattern::InsulationHard | HatchPattern::InsulationWave) || h.kind.is_some() {
            continue;
        }
        let half = ring_len(&c.pts) / 2.0;
        let thick = if half > 0.0 { ring_area(&c.pts) / half } else { 0.0 };
        if is_thin_layer(thick, scale) {
            h.pattern = HatchPattern::None;
        }
    }
    cuts
}

/// [140] Dünne Schnitt-Schichten (Putz, Parkett, Trittschall, Folien) bei 1:`scale` zusammenfassen: eine Schicht
/// unter 0.5 mm Papierdicke (`style::is_thin_layer`; Dicke ≈ Fläche / halber Umfang) übernimmt Füllung und
/// Schraffur der dickeren Nachbarschicht desselben Bauteils, mit der sie die längste Kante teilt, und wird mit
/// ihr zu einer Fläche vereinigt (keine Fuge dazwischen). Unter 1:75 (oder `scale` 0) unverändert.
pub fn merge_thin_cuts(cuts: &[Cut], scale: f64) -> Vec<Cut> {
    if !simplify_thin_layers(Detail::Mittel, scale) {
        return cuts.to_vec();
    }
    let n = cuts.len();
    let mergeable = |c: &Cut| matches!(c.kind, Kind::Wall | Kind::Slab | Kind::Roof) && c.stair_id.is_none() && c.pts.len() >= 3;
    let thick: Vec<f64> = cuts.iter().map(|c| { let half = ring_len(&c.pts) / 2.0; if half > 0.0 { ring_area(&c.pts) / half } else { 0.0 } }).collect();
    let thin: Vec<bool> = (0..n).map(|i| mergeable(&cuts[i]) && thick[i] > 0.0 && is_thin_layer(thick[i], scale)).collect();
    if !thin.iter().any(|t| *t) {
        return cuts.to_vec();
    }
    let bbox: Vec<[f64; 4]> = cuts.iter().map(|c| ring_bbox(&c.pts)).collect();
    // [33] Nur Schichten mit gleichem Override (eine weisse Schicht geht nicht in der schwarzen auf).
    let same_part = |a: &Cut, b: &Cut| a.kind == b.kind && a.index == b.index && a.source_id == b.source_id && a.ov == b.ov;
    let touch = |i: usize, j: usize| {
        let (a, b) = (bbox[i], bbox[j]);
        a[0] <= b[2] + 1e-4 && b[0] <= a[2] + 1e-4 && a[1] <= b[3] + 1e-4 && b[1] <= a[3] + 1e-4
    };
    // Gemeinsame Kantenlänge zweier Flächen über die Vereinigung (0, wenn sie nicht zu einer Fläche verschmelzen).
    let shared = |i: usize, j: usize| -> f64 {
        let u = crate::polygon_bool::union(&[vec![cuts[i].pts.clone()], vec![cuts[j].pts.clone()]]);
        if u.len() != 1 || u[0].len() != 1 {
            return 0.0;
        }
        (ring_len(&cuts[i].pts) + ring_len(&cuts[j].pts) - ring_len(&u[0][0])) / 2.0
    };
    // Ziel je Fläche; dünne Ketten (dünn an dünn an dick) in wenigen Durchgängen.
    let mut target: Vec<Option<usize>> = (0..n).map(|i| (!thin[i]).then_some(i)).collect();
    for _ in 0..3 {
        let mut changed = false;
        let open: Vec<usize> = (0..n).filter(|&i| thin[i] && target[i].is_none()).collect();
        for i in open {
            let best = (0..n)
                .filter(|&j| j != i && target[j].is_some() && mergeable(&cuts[j]) && same_part(&cuts[i], &cuts[j]) && touch(i, j))
                .map(|j| (j, shared(i, j)))
                .filter(|(_, l)| *l > 1e-4)
                // Längste gemeinsame Kante; bei gleicher Länge die dickere Schicht (wie `thin_layer_targets`).
                .max_by(|a, b| {
                    if (a.1 - b.1).abs() <= 1e-3 * a.1.max(b.1) {
                        thick[a.0].total_cmp(&thick[b.0])
                    } else {
                        a.1.total_cmp(&b.1)
                    }
                });
            if let Some((j, _)) = best {
                target[i] = target[j];
                changed = true;
            }
        }
        if !changed {
            break;
        }
    }
    let mut groups: Vec<Vec<usize>> = vec![Vec::new(); n];
    for i in 0..n {
        groups[target[i].unwrap_or(i)].push(i);
    }
    let mut out = Vec::with_capacity(n);
    for (t, g) in groups.into_iter().enumerate() {
        match g.len() {
            0 => {}
            1 => out.push(cuts[g[0]].clone()),
            _ => {
                let polys: Vec<crate::flat::Polygon> = g.iter().map(|&i| vec![cuts[i].pts.clone()]).collect();
                let u = crate::polygon_bool::union(&polys);
                if u.iter().all(|poly| poly.len() == 1) {
                    for poly in u {
                        out.push(Cut { pts: poly.into_iter().next().unwrap_or_default(), nse: None, ..cuts[t].clone() });
                    }
                } else {
                    // Löcher: Flächen einzeln lassen, nur den Stil der Zielschicht übernehmen.
                    for &i in &g {
                        out.push(Cut { fill: cuts[t].fill.clone(), hatch: cuts[t].hatch.clone(), ..cuts[i].clone() });
                    }
                }
            }
        }
    }
    out
}

/// [33] Schichten desselben Bauteils mit gleichem Override ohne Muster (Schraffur "none", z. B. „Deckenaufbau
/// weiss“) zu einer Fläche vereinigen: ein Umriss um den ganzen Aufbau, keine Fugen dazwischen. Flächen mit
/// Loch bleiben einzeln.
fn merge_override_groups(cuts: Vec<Cut>) -> Vec<Cut> {
    let plain = |c: &Cut| c.ov.as_ref().is_some_and(|o| o.hatch == HatchOv::None) && c.stair_id.is_none() && c.pts.len() >= 3;
    if !cuts.iter().any(plain) {
        return cuts;
    }
    // Gleiches Bauteil: Decken-Schichten sind je eine eigene Platte (eigener `index`), darum über `source_id`.
    let same = |a: &Cut, b: &Cut| a.kind == b.kind && a.source_id.is_some() && a.source_id == b.source_id && a.ov == b.ov;
    let n = cuts.len();
    let mut group: Vec<Option<usize>> = vec![None; n];
    for i in 0..n {
        if !plain(&cuts[i]) || group[i].is_some() {
            continue;
        }
        group[i] = Some(i);
        for j in i + 1..n {
            if group[j].is_none() && plain(&cuts[j]) && same(&cuts[i], &cuts[j]) {
                group[j] = Some(i);
            }
        }
    }
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        match group[i] {
            None => out.push(cuts[i].clone()),
            Some(g) if g != i => {}
            Some(_) => {
                let members: Vec<usize> = (i..n).filter(|&j| group[j] == Some(i)).collect();
                if members.len() == 1 {
                    out.push(cuts[i].clone());
                    continue;
                }
                let polys: Vec<crate::flat::Polygon> = members.iter().map(|&j| vec![cuts[j].pts.clone()]).collect();
                let u = crate::polygon_bool::union(&polys);
                if !u.is_empty() && u.iter().all(|poly| poly.len() == 1) {
                    for poly in u {
                        out.push(Cut { pts: poly.into_iter().next().unwrap_or_default(), nse: None, ..cuts[i].clone() });
                    }
                } else {
                    out.extend(members.iter().map(|&j| cuts[j].clone()));
                }
            }
        }
    }
    out
}

/// `generateSectionPlan`: Primitive (u → x, Höhe → y) und Ausmass.
pub fn section_primitives(out: &Output, mono: bool, hidden_lines: bool, vis: &Visibility) -> (Vec<Primitive>, [f64; 4]) {
    section_primitives_at(out, mono, hidden_lines, vis, 0.0, Detail::Mittel, false, &CutRules::default())
}

/// [140] Bauteile (ids) aus losen Schüttungen/Unterbau (`standards::is_loose_fill`: Kies, Magerbeton,
/// Erdreich …): im Schnitt ab 1:100 nicht schwarz.
pub fn loose_fill_components(p: &Project) -> HashSet<String> {
    p.components.iter().filter(|c| crate::standards::is_loose_fill(c)).map(|c| c.id.clone()).collect()
}

/// [140] Bleibt eine Schnittfläche ab 1:100 schraffiert? Schichten aus losen Schüttungen/Unterbau
/// (`loose`, Bauteil-ids) bzw. mit Schraffur Erdreich/Kies — sie tragen nicht und bilden keinen Raum.
fn loose_cut(cp: &Cut, loose: &HashSet<String>) -> bool {
    cp.component_id.as_deref().is_some_and(|id| loose.contains(id)) || cp.hatch.as_ref().is_some_and(|h| matches!(h.pattern, HatchPattern::Earth | HatchPattern::Gravel))
}

/// [`section_primitives`] beim Massstab 1:`scale` (dünne Schichten zusammengefasst, [`merge_thin_cuts`];
/// Detail „fein" zeigt alle Schichten, `style::simplify_thin_layers`). Ab 1:100 (`style::solid_cut`, ausser
/// `cut_hatch`/„fein") sind die geschnittenen Flächen schwarz ohne Fugen und Schraffur, nur mit dem Umriss —
/// ausser Schichten aus losen Schüttungen/Unterbau (`rules.loose`, s. [`loose_cut`]): die bleiben schraffiert.
/// [33] Overrides (`rules.ov`) haben Vorrang vor beidem: Füllung, Schraffur und Umriss der Regel.
#[allow(clippy::too_many_arguments)]
pub fn section_primitives_at(out: &Output, mono: bool, hidden_lines: bool, vis: &Visibility, scale: f64, detail: Detail, cut_hatch: bool, rules: &CutRules) -> (Vec<Primitive>, [f64; 4]) {
    let loose = &rules.loose;
    let black = solid_cut(detail, scale, cut_hatch);
    let thin_scale = if simplify_thin_layers(detail, scale) && !black { scale } else { 0.0 };
    let with_ov: Vec<Cut>;
    let cuts: &[Cut] = if rules.ov.is_empty() {
        &out.cuts
    } else {
        with_ov = out.cuts.iter().zip(rules.ov.iter().chain(std::iter::repeat(&None))).map(|(c, o)| Cut { ov: o.clone(), ..c.clone() }).collect();
        &with_ov
    };
    let merged = merge_override_groups(plain_thin_insulation(merge_thin_cuts(cuts, thin_scale), thin_scale));
    let mut prims = Vec::new();
    let mut acc = Acc::new();
    let shown = |code: &str| vis.visible(code) && vis.render(code);
    let mut cut_rings: Vec<crate::flat::Polygon> = Vec::new();
    let mut late_joints: Vec<Primitive> = Vec::new();
    // [T6] Erdreich zuerst (unter allem), ohne Umriss; Kategorie wie das Gelände.
    // [33] Regel für Gelände: Ausblenden, Füllung/Schraffur des Erdreichs, Linie der Geländelinie.
    let tov = rules.terrain.as_ref();
    let terrain_shown = out.profiles.iter().all(|pr| pr.category.as_deref().is_none_or(shown)) && !tov.is_some_and(|(a, _)| a.hidden());
    if terrain_shown {
        for (ring, hatch) in &out.earth {
            let hatch = match tov.and_then(|(_, l)| l.hatch.as_deref()) {
                Some("none") => no_hatch(),
                Some("material") | None => hatch.clone(),
                Some(_) => rules.terrain_hatch.clone().unwrap_or_else(|| hatch.clone()),
            };
            let hatch = if mono { HatchRender { color: SECTION_INK.into(), ..hatch } } else { hatch };
            let fill = tov.and_then(|(_, l)| l.fill_color.as_deref()).unwrap_or("none");
            let mut q = polygon(ring.iter().map(|q| v2(q[0], q[1])).collect(), fill, "none", 0.0, hatch);
            if let Primitive::Polygon { context_object_id, .. } = &mut q {
                *context_object_id = out.terrain_id.clone();
            }
            prims.push(q);
        }
    }
    // [157] Verdeckte Kanten kommen hier hinein (unter die Schnittflächen, die sie verdecken).
    let cut_start = prims.len();
    for cp in &merged {
        if cp.pts.len() < 3 {
            continue;
        }
        if let Some(code) = cp.category.as_deref() {
            if !shown(code) {
                continue;
            }
        }
        let pts: Vec<Vec2> = cp
            .pts
            .iter()
            .map(|q| {
                acc.add(q[0], q[1]);
                v2(q[0], q[1])
            })
            .collect();
        let fill = cp.fill.as_deref().unwrap_or(HATCH_PAPER);
        let hatch = cp.hatch.clone().unwrap_or_else(section_hatch);
        let solid = hatch.pattern == HatchPattern::Solid;
        let ov = cp.ov.as_ref();
        // Ohne Override: schwarz ab 1:100 (ausser lose Schüttungen). Mit Override, der Füllung oder Schraffur
        // setzt, gilt die Regel ([33]); eine Regel, die nur den Umriss setzt, lässt die Fläche schwarz.
        let base_black = black && !loose_cut(cp, loose);
        let black = base_black && !ov.is_some_and(|o| o.styles());
        let (mut fill, mut hatch) = if black {
            (HATCH_INK.to_string(), no_hatch())
        } else if mono {
            let mono_fill = if solid { HATCH_INK } else { HATCH_PAPER };
            let mono_hatch = if !solid && hatch.pattern != HatchPattern::None { HatchRender { color: SECTION_INK.into(), ..hatch } } else { hatch };
            (mono_fill.to_string(), mono_hatch)
        } else {
            (fill.to_string(), hatch)
        };
        if let Some(o) = ov.filter(|o| o.styles()) {
            match &o.hatch {
                // Nur Füllung gesetzt: ab 1:100 (sonst schwarz) ohne Muster, sonst Muster wie gehabt.
                HatchOv::Keep if base_black => hatch = no_hatch(),
                HatchOv::Keep | HatchOv::Material => {}
                HatchOv::None => hatch = no_hatch(),
                HatchOv::Pattern(h) => hatch = if mono { HatchRender { color: SECTION_INK.into(), ..h.clone() } } else { h.clone() },
            }
            if let Some(f) = &o.fill {
                fill = f.clone();
            }
        }
        let outline = ov.and_then(|o| o.outline);
        let src = cp.source_id.clone();
        let stroked = if black { outline == Some(true) } else { outline != Some(false) };
        // [33] Linienstil aus einer Schicht-Regel: Fugen der Fläche als eigene Linien mit Strichmuster.
        let dash = ov.and_then(|o| o.dash.clone()).filter(|_| stroked);
        if let Some(d) = &dash {
            let n = cp.pts.len();
            let skip: Vec<usize> = cp.nse.iter().flatten().map(|x| *x as usize).collect();
            for i in (0..n).filter(|i| !skip.contains(i)) {
                let (a, b) = (cp.pts[i], cp.pts[(i + 1) % n]);
                let mut l = line(v2(a[0], a[1]), v2(b[0], b[1]), "section-joint", SECTION_JOINT_MM, SECTION_INK);
                if let Primitive::Line { dash: ld, .. } = &mut l {
                    *ld = Some(d.clone());
                }
                late_joints.push(l);
            }
        }
        let mut pr = if stroked && dash.is_none() { polygon(pts, &fill, SECTION_INK, SECTION_JOINT_MM, hatch) } else { polygon(pts, &fill, "none", 0.0, hatch) };
        if let Primitive::Polygon { wall_id, ceiling_id, roof_id, stair_id, extruded_solid_id, no_stroke_edges, greyed, context_object_id, .. } = &mut pr {
            // [152] Importiertes Netz: Pick über die Kontext-Id.
            *context_object_id = if cp.kind == Kind::Mesh { src.clone() } else { None };
            *wall_id = if cp.kind == Kind::Wall { src.clone() } else { None };
            *ceiling_id = if cp.kind == Kind::Slab && cp.stair_id.is_none() { src.clone() } else { None };
            *roof_id = if cp.kind == Kind::Roof { src.clone() } else { None };
            *stair_id = cp.stair_id.clone();
            *extruded_solid_id = if cp.kind == Kind::Body { src } else { None };
            *no_stroke_edges = cp.nse.clone();
            *greyed = Some(cp.category.as_deref().is_some_and(|c| vis.greyed(c)));
        }
        cut_rings.push(vec![cp.pts.clone()]);
        prims.push(pr);
    }
    prims.append(&mut late_joints);
    // [140] Schnittkante: Umriss der vereinigten Schnittflächen schwer, Fugen dazwischen bleiben fein.
    for poly in crate::polygon_bool::union(&cut_rings) {
        for ring in &poly {
            for i in 0..ring.len() {
                let (a, b) = (ring[i], ring[(i + 1) % ring.len()]);
                prims.push(line(v2(a[0], a[1]), v2(b[0], b[1]), "section-cut-outline", SECTION_CUT_OUTLINE_MM, SECTION_INK));
            }
        }
    }
    for pr in &out.profiles {
        if let Some(code) = pr.category.as_deref() {
            if !shown(code) {
                continue;
            }
        }
        if !terrain_shown {
            continue;
        }
        for w in pr.pts.windows(2) {
            acc.add(w[0][0], w[0][1]);
            acc.add(w[1][0], w[1][1]);
            let mut l = line(v2(w[0][0], w[0][1]), v2(w[1][0], w[1][1]), "section-terrain", if pr.natural { SECTION_NATURAL_MM } else { SECTION_GROUND_MM }, SECTION_INK);
            if pr.natural {
                if let Primitive::Line { dash, .. } = &mut l {
                    *dash = Some(Some(SECTION_NATURAL_DASH.to_vec()));
                }
            }
            if let Some((a, _)) = tov.filter(|_| !pr.natural) {
                if let Primitive::Line { color, weight_mm, dash, .. } = &mut l {
                    if let Some(c) = &a.color {
                        *color = Some(c.clone());
                    }
                    if let Some(w) = a.lineweight.filter(|w| w.is_finite() && *w >= 0.0) {
                        *weight_mm = w;
                    }
                    if let Some(d) = &rules.terrain_dash {
                        *dash = Some(d.clone());
                    }
                }
            }
            prims.push(l);
        }
    }
    // [152] Importierte Netze: Kanten nur, wenn die Kategorie gezeigt wird; Linien nach den Regeln des Netzes.
    let mesh_shown = |e: &Edge| e.kind != Kind::Mesh || out.meshes.get(e.index).and_then(|m| m.category.as_deref()).is_none_or(shown);
    let mesh_style = |e: &Edge, l: &mut Primitive| {
        if e.kind == Kind::Mesh {
            if let Some(s) = rules.mesh.get(&e.index) {
                s.apply(l);
            }
        }
    };
    if hidden_lines {
        let mut hidden: Vec<Primitive> = Vec::new();
        for e in out.hidden.iter().filter(|e| mesh_shown(e)) {
            acc.add(e.a[0], e.a[1]);
            acc.add(e.b[0], e.b[1]);
            let mut l = line(v2(e.a[0], e.a[1]), v2(e.b[0], e.b[1]), "section-hidden", SECTION_HIDDEN_MM, SECTION_HIDDEN_INK);
            if let Primitive::Line { dash, .. } = &mut l {
                *dash = Some(Some(SECTION_HIDDEN_DASH.to_vec()));
            }
            hidden.push(l);
        }
        prims.splice(cut_start..cut_start, hidden);
    }
    for e in out.visible.iter().filter(|e| mesh_shown(e)) {
        acc.add(e.a[0], e.a[1]);
        acc.add(e.b[0], e.b[1]);
        let mut l = line(v2(e.a[0], e.a[1]), v2(e.b[0], e.b[1]), "section-visible", SECTION_VISIBLE_MM, SECTION_VISIBLE_INK);
        mesh_style(e, &mut l);
        prims.push(l);
    }
    // [152] Offene Schnittlinien importierter Netze (Flächen ohne Dicke, nicht-mannigfaltige Netze): schwer
    // wie der Umriss der geschnittenen Masse.
    for (k, pts) in &out.mesh_lines {
        let e = Edge { kind: Kind::Mesh, index: *k, a: [0.0; 2], b: [0.0; 2] };
        if !mesh_shown(&e) {
            continue;
        }
        for w in pts.windows(2) {
            acc.add(w[0][0], w[0][1]);
            acc.add(w[1][0], w[1][1]);
            let mut l = line(v2(w[0][0], w[0][1]), v2(w[1][0], w[1][1]), "section-cut-outline", SECTION_CUT_OUTLINE_MM, SECTION_INK);
            mesh_style(&e, &mut l);
            prims.push(l);
        }
    }
    // Mit Gelände ersetzt die Geländelinie die Grundlinie ([T6]).
    if acc.min_x.is_finite() && acc.max_x > acc.min_x && !(terrain_shown && !out.profiles.is_empty()) {
        prims.push(line(v2(acc.min_x, acc.min_y), v2(acc.max_x, acc.min_y), "section-ground", SECTION_GROUND_MM, SECTION_INK));
    }
    (prims, acc.bounds())
}
