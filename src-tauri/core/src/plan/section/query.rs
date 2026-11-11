//! Abfrage des Schnitts als Plan-Puffer (`section_plan_buf()`, Wurzel-Abfrage aus `queries.rs`) mit
//! einem kleinen Cache der zuletzt berechneten Schnitte; ergänzt Öffnungen, Bäume, Achsraster und
//! Strichstärken nach Massstab.

use super::*;

/// Zuletzt berechnete Schnitte je Schlüssel (> 0), wenige, älteste fallen weg.
const CACHE_SLOTS: usize = 6;

thread_local! {
    static CACHE: std::cell::RefCell<Vec<((f64, u64), std::rc::Rc<Output>)>> = const { std::cell::RefCell::new(Vec::new()) };
}

/// Schlüssel: (Schlüssel des Aufrufers, [33] Kennung der ausgeblendeten Elemente und [180] Klassen, 0 = keine).
fn cache_get(key: (f64, u64)) -> Option<std::rc::Rc<Output>> {
    if !(key.0 > 0.0) {
        return None;
    }
    CACHE.with(|c| {
        let mut c = c.borrow_mut();
        let i = c.iter().position(|e| e.0 == key)?;
        let e = c.remove(i);
        let o = e.1.clone();
        c.push(e);
        Some(o)
    })
}

fn cache_put(key: (f64, u64), o: std::rc::Rc<Output>) {
    if !(key.0 > 0.0) {
        return;
    }
    CACHE.with(|c| {
        let mut c = c.borrow_mut();
        c.retain(|e| e.0 != key);
        if c.len() >= CACHE_SLOTS {
            c.remove(0);
        }
        c.push((key, o));
    });
}

/// Abfrage `sectionPlan`: `args` = `[mono, openings, key]` (`key` > 0
/// = Schlüssel des vorbereiteten Schnitts, s. Cache unten, 0 = immer rechnen),
/// `text` = `{"level": {...}, "hiddenLines", "hasVis", "invisible", "hasDisplay", "norender", "grey"}`.
/// Puffer: Gruppe 0 Schnitt, Gruppe 1 geschnittene Öffnungen; Ausmass ohne die Öffnungen.
/// Ohne gültige Schnittlinie: leerer Puffer ohne Gruppen.
pub fn section_plan_buf(p: &Project, args: &[f64], text: &str) -> Result<Vec<u8>, String> {
    let v: serde_json::Value = serde_json::from_str(text).map_err(|e| format!("Schnitt-Argumente: {e}"))?;
    let level = LevelSpec::from_json(v.get("level").unwrap_or(&serde_json::Value::Null));
    let vis = Visibility::from_json(&v);
    let mono = args.first().is_some_and(|&x| x != 0.0);
    let openings = args.get(1).is_some_and(|&x| x != 0.0);
    let key = args.get(2).copied().unwrap_or(0.0);
    let scale = v.get("scale").and_then(|s| s.as_f64()).filter(|s| *s > 0.0 && s.is_finite()).unwrap_or(100.0);
    // [33] Eingeschaltete Override-Regeln eines Blatt-Viewports (`rules`: ids; fehlt = Schalter im Projekt).
    let on: Option<HashSet<String>> = v.get("rules").and_then(|a| a.as_array()).map(|a| a.iter().filter_map(|s| s.as_str().map(String::from)).collect());
    let rv = RuleView::at(scale, on.as_ref()).view("section");
    // [33] Regel „Ausblenden“: Schnitt ohne diese Elemente (sie verdecken nichts, Wände samt Öffnungen).
    let hidden_ids = crate::plan::overrides::hidden_elements(p, rv);
    let filtered = (!hidden_ids.is_empty()).then(|| without_elements(p, &hidden_ids));
    let p = filtered.as_ref().unwrap_or(p);
    // [180] Ausgeblendete Klassen gehören in den Schlüssel: sie nehmen an der Verdeckung nicht teil, der Schnitt
    // hängt also an ihnen (graue nicht).
    let hkey = {
        let mut ids: Vec<&String> = hidden_ids.iter().collect();
        ids.sort();
        let mut codes: Vec<&String> = vis.hidden_codes().collect();
        codes.sort();
        codes.dedup();
        let empty = ids.is_empty() && codes.is_empty();
        ids.iter().flat_map(|s| s.bytes().chain([0u8])).chain([1u8]).chain(codes.iter().flat_map(|s| s.bytes().chain([0u8]))).fold(if empty { 0 } else { 0xcbf2_9ce4_8422_2325u64 }, |h, b| (h ^ b as u64).wrapping_mul(0x0000_0100_0000_01b3))
    };
    let key = (key, hkey);
    let mut w = crate::plan::buf::Writer::new(true);
    // Der Schnitt selbst hängt nur am Projektstand und an der Ebene (= ein Aufruf von
    // `computeSection` in TS, Schlüssel `key`) und an den ausgeblendeten Klassen (`hkey`); Schwarz-Weiss, graue
    // Klassen und verdeckte Kanten nur an der Darstellung. Darum die zuletzt berechneten Schnitte merken (Umschalten ohne Neurechnen).
    let out = match cache_get(key) {
        Some(o) => o,
        None => {
            // [115] Körper-Netze aus dem Kern (`solid_mesh.rs`), nicht mehr aus TS.
            let bodies = crate::solid_mesh::body_meshes(p);
            let Some(o) = compute_section_vis(p, &level, &bodies, &vis)? else { return Ok(w.finish()) };
            let o = std::rc::Rc::new(o);
            cache_put(key, o.clone());
            o
        }
    };
    let hidden = v.get("hiddenLines").and_then(|b| b.as_bool()).unwrap_or(false);
    let detail = Detail::parse(v.get("detail").and_then(|d| d.as_str()).unwrap_or("mittel"));
    let detail_arg = detail;
    // [173] Modelldarstellung: ausdrücklich angefragt (Blatt-Ausschnitt), sonst die der Ebene; ihre Basis
    // ersetzt den Detailgrad. Ohne Wahl wie bisher.
    let mv_id = v.get("modelView").and_then(|m| m.as_str()).filter(|m| !m.is_empty()).or(level.model_view.as_deref());
    let mvo = mv_id.map(|id| crate::plan::model_view::for_view(p, Some(id), detail, scale));
    let smv = mvo.as_ref().map(|o| SectionMv::of(p, &out, o));
    let detail = mvo.as_ref().map_or(detail, |o| o.detail);
    let (mut prims, bounds) = section_primitives_mv(&out, mono, hidden, &vis, scale, detail, level.cut_hatch, &CutRules::of(p, &out, rv), smv.as_ref());
    w.post = crate::plan::extras::sketch_post(Some(level.sketch), scale);
    // Strichstärken nach Massstab ([32]) wie im Grundriss.
    crate::plan::extras::scale_line_weights(p, scale, &mut prims);
    // [149] Bäume hinter der Schnittebene: transparente Silhouette unter dem Schnitt (Bauteile verdecken sie).
    // [176] Geknickter Schnitt: Bäume, Öffnungen und Achsen je Segment, auf den Streifen geschnitten und abgewickelt.
    let parts = unfold::parts(&level);
    let mut trees: Vec<Primitive> = parts.iter().flat_map(|(l, s)| crate::plan::trees::view_trees(p, l, &vis, None, Some(mono)).into_iter().flat_map(move |(_, t)| unfold::keep_group(t, s.as_ref()))).collect();
    let bounds = crate::plan::trees::union_bounds(bounds, &trees);
    crate::plan::extras::scale_line_weights(p, scale, &mut trees);
    trees.extend(prims);
    // [176] Knicklinien (nur geknickter Schnitt).
    trees.extend(unfold::bend_lines(&level, bounds));
    let prims = trees;
    w.group(&prims);
    // [184] Öffnungen wie im Grundriss: Detailgrad aus Stufe bzw. Massstab (mittel ab 1:200 grob).
    let open_mv = crate::plan::model_view::for_view_scaled(p, mv_id, detail_arg, scale);
    let mut ops = Vec::new();
    if openings {
        for (l, s) in &parts {
            ops.extend(unfold::clip_prims(section_opening_primitives_mv(p, l, &vis, &open_mv)?, s.as_ref()));
        }
    }
    crate::plan::extras::scale_line_weights(p, scale, &mut ops);
    w.group(&ops);
    // Achsraster ([112]): Achsen quer zur Schnittebene.
    let grid: Vec<Primitive> = parts
        .iter()
        .flat_map(|(l, s)| {
            let off = s.as_ref().map_or(0.0, |s| s.offset);
            let b = if off == 0.0 { bounds } else { [bounds[0] - off, bounds[1], bounds[2] - off, bounds[3]] };
            unfold::clip_prims(crate::plan::grid_view::grid_prims_in(p, l, b, scale, &vis), s.as_ref())
        })
        .collect();
    if !grid.is_empty() {
        w.group(&grid);
    }
    w.bounds = Some(crate::plan::grid_view::union_bounds(bounds, &grid));
    Ok(w.finish())
}
