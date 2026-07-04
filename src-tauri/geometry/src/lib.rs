// Wand-Verschneidung (Gehrung): an einer Ecke, wo zwei Waende aufeinander-
// treffen, sollen sich die Schicht-Baender nicht ueberlappen, sondern an einer
// gemeinsamen Gehrungslinie sauber stossen. Dieses Modul berechnet pro Wand
// die optionalen Schnittlinien an Start- und Endpunkt.
//
// Reine 2D-Mathematik, kein externer Kernel noetig. Portiert aus dem
// TS-Modell (joins.ts / geometry.ts); die Vektor-Helfer add/sub/scale/
// normalize/leftNormal/len/lineIntersect sind unten dupliziert.

use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Copy)]
pub struct Vec2 {
    pub x: f64,
    pub y: f64,
}

/// Eine unendliche Gerade als Stuetzpunkt + Richtung.
#[derive(Serialize, Deserialize, Clone, Copy)]
pub struct Line {
    pub point: Vec2,
    pub dir: Vec2,
}

/// Eine Schicht einer Wand, bereits aus dem WallType aufgeloest (Komponenten-Id
/// + Prioritaet + Dicke) -- fuer die materialbewusste T-Stoss-Erweiterung
/// (siehe `resolve_join_priority`/`apply_layer_cuts`). ADDITIV: fehlt der Key
/// `layers` in der JSON-Eingabe, liefert `#[serde(default)]` eine leere Liste,
/// sodass die bestehende Paritaets-Eingabe (ohne Schichten) unveraendert
/// funktioniert.
#[derive(Serialize, Deserialize, Clone)]
pub struct LayerInput {
    #[serde(rename = "componentId")]
    pub component_id: String,
    #[serde(rename = "joinPriority")]
    pub join_priority: f64,
    pub thickness: f64,
}

#[derive(Serialize, Deserialize)]
pub struct WallInput {
    pub id: String,
    pub start: Vec2,
    pub end: Vec2,
    pub thickness: f64,
    #[serde(rename = "referenceOffset")]
    pub reference_offset: f64,
    #[serde(default)]
    pub layers: Vec<LayerInput>,
}

#[derive(Serialize, Deserialize)]
pub struct JoinInput {
    pub walls: Vec<WallInput>,
}

/// Pro-Schicht-Override der Nahflaechen-Cuts (materialbewusster T-Stoss).
/// Index = Schicht-Index in `WallInput.layers` der Abzweig-Wand. Spiegelt
/// `LayerCuts` aus `model/joins.ts` 1:1.
#[derive(Serialize, Deserialize, Clone)]
pub struct LayerCuts {
    pub start: Vec<Option<Line>>,
    pub end: Vec<Option<Line>>,
    #[serde(rename = "startSide")]
    pub start_side: Vec<Option<Line>>,
    #[serde(rename = "endSide")]
    pub end_side: Vec<Option<Line>>,
}

/// Schnittlinien einer Wand an ihren beiden Achsenden.
#[derive(Serialize, Deserialize)]
pub struct WallCuts {
    #[serde(rename = "wallId")]
    pub wall_id: String,
    #[serde(rename = "startCut")]
    pub start_cut: Option<Line>,
    #[serde(rename = "endCut")]
    pub end_cut: Option<Line>,
    /// ADDITIV: nur gesetzt, wenn an einem T-Stoss mindestens eine Schicht
    /// materialbewusst verschmilzt (siehe `apply_layer_cuts`). Fehlt sie in der
    /// Ausgabe (`None` -> von serde bei Serialisierung weggelassen), gilt
    /// weiterhin `start_cut`/`end_cut` fuer alle Schichten.
    #[serde(rename = "layerCuts", skip_serializing_if = "Option::is_none")]
    pub layer_cuts: Option<LayerCuts>,
}

/// Verschneidungs-Entscheidung zweier Bauteile am Stoss -- Rust-Spiegel von
/// `JoinPriorityResolution`/`resolveJoinPriority` aus `model/joins.ts`.
#[derive(PartialEq)]
enum JoinPriorityResolution {
    Merge,
    TrimA,
    TrimB,
    Coexist,
}

fn resolve_join_priority(
    a_id: &str,
    a_prio: f64,
    b_id: &str,
    b_prio: f64,
) -> JoinPriorityResolution {
    if a_prio == b_prio {
        if a_id == b_id {
            JoinPriorityResolution::Merge
        } else {
            JoinPriorityResolution::Coexist
        }
    } else if a_prio > b_prio {
        JoinPriorityResolution::TrimB
    } else {
        JoinPriorityResolution::TrimA
    }
}

/// Materialbewusste Pro-Schicht-Erweiterung eines T-Stoss-Cuts -- Rust-Spiegel
/// von `applyLayerCuts` aus `model/joins.ts`. Vergleicht jede Schicht der
/// Abzweig-Wand mit dem Rueckgrat (hoechste `joinPriority`) der Durchgangswand;
/// verschmilzt sie (gleiches Rueckgrat-Material, oder die Abzweig-Schicht ist
/// sogar prioritaerer), bekommt sie einen Cut an der NAHFLAECHE DES RUECKGRAT-
/// KERNS der Durchgangswand -- der verschmelzende Kern sticht nur durch den
/// Nah-Putz und stoppt am Durchgangs-Kern, statt bis zur Achse durchzulaufen.
/// Getrimmte Schichten neben einer verschmelzenden Nachbarschicht bekommen
/// zusaetzlich die seitliche L-Linie an eben dieser Rueckgrat-Nahflaeche.
/// `sign`/`off_t` = Nahseite bzw. Referenzversatz der Durchgangswand.
#[allow(clippy::too_many_arguments)]
fn apply_layer_cuts(
    result: &mut [WallCuts],
    branch_wall_idx: usize,
    branch_end: WallEndKind,
    branch_layers: &[LayerInput],
    through_layers: &[LayerInput],
    face_cut: Line,
    axis_point: Vec2,
    through_dir: Vec2,
    sign: f64,
    off_t: f64,
) {
    if branch_layers.is_empty() || through_layers.is_empty() {
        return;
    }

    // Rueckgrat der Durchgangswand: die Schicht mit der hoechsten joinPriority
    // (Index mitgefuehrt fuer die Nah-Putz-Dicke davor).
    let mut backbone = &through_layers[0];
    let mut backbone_idx = 0usize;
    for (i, l) in through_layers.iter().enumerate() {
        if l.join_priority > backbone.join_priority {
            backbone = l;
            backbone_idx = i;
        }
    }

    let n = branch_layers.len();
    let mut merged = vec![false; n];
    for (i, layer) in branch_layers.iter().enumerate() {
        let res = resolve_join_priority(
            &layer.component_id,
            layer.join_priority,
            &backbone.component_id,
            backbone.join_priority,
        );
        merged[i] = matches!(res, JoinPriorityResolution::Merge | JoinPriorityResolution::TrimB);
    }
    if !merged.iter().any(|&m| m) {
        return; // keine Materialuebereinstimmung -> Default (kein layer_cuts)
    }

    let cuts = &mut result[branch_wall_idx];
    if cuts.layer_cuts.is_none() {
        cuts.layer_cuts = Some(LayerCuts {
            start: vec![None; n],
            end: vec![None; n],
            start_side: vec![None; n],
            end_side: vec![None; n],
        });
    }
    let lc = cuts.layer_cuts.as_mut().unwrap();
    if lc.start.len() != n {
        return; // Schicht-Anzahl passt nicht zusammen (sollte nicht vorkommen)
    }

    // Nahflaechen-Cut des verschmelzenden Kerns: von der Durchgangswand-Nah-
    // flaeche (off_t + sign*t_t/2) um die Nah-Putz-Dicke nach innen versetzt =
    // die dem Abzweig zugewandte Flaeche des Rueckgrat-Kerns. Nah-Putz = Summe
    // der Durchgangswand-Schichten zwischen Nahseite (sign) und Rueckgrat: auf
    // der +nT-Nahseite (sign>0) die Schichten hinter dem Rueckgrat
    // (Index > backbone_idx), auf der -nT-Nahseite die davor.
    let t_t: f64 = through_layers.iter().map(|l| l.thickness).sum();
    let mut near_plaster = 0.0;
    for (i, l) in through_layers.iter().enumerate() {
        let near = if sign > 0.0 { i > backbone_idx } else { i < backbone_idx };
        if near {
            near_plaster += l.thickness;
        }
    }
    let n_t = left_normal(through_dir);
    let merge_point = add(axis_point, scale(n_t, off_t + sign * (t_t / 2.0 - near_plaster)));
    let merge_cut = Line { point: merge_point, dir: through_dir };

    // Getrimmte Nachbarschichten schliessen mit ihrer L-Seitenlinie an dieser
    // Rueckgrat-Nahflaeche ab (nicht an der Wandachse).
    let side_line = merge_cut;
    let (face_arr, side_arr) = match branch_end {
        WallEndKind::Start => (&mut lc.start, &mut lc.start_side),
        WallEndKind::End => (&mut lc.end, &mut lc.end_side),
    };
    for i in 0..n {
        face_arr[i] = if merged[i] { Some(merge_cut) } else { Some(face_cut) };
        let adj_merged =
            !merged[i] && ((i > 0 && merged[i - 1]) || (i + 1 < n && merged[i + 1]));
        side_arr[i] = if adj_merged { Some(side_line) } else { None };
    }
}

// --- Vektor-Helfer -----------------------------------------------------------

fn sub(a: Vec2, b: Vec2) -> Vec2 {
    Vec2 { x: a.x - b.x, y: a.y - b.y }
}

fn add(a: Vec2, b: Vec2) -> Vec2 {
    Vec2 { x: a.x + b.x, y: a.y + b.y }
}

fn scale(a: Vec2, s: f64) -> Vec2 {
    Vec2 { x: a.x * s, y: a.y * s }
}

fn len(a: Vec2) -> f64 {
    a.x.hypot(a.y)
}

fn normalize(a: Vec2) -> Vec2 {
    let l = len(a);
    let l = if l == 0.0 { 1.0 } else { l };
    Vec2 { x: a.x / l, y: a.y / l }
}

/// Linke Normale (90 Grad gegen den Uhrzeigersinn gedreht).
fn left_normal(a: Vec2) -> Vec2 {
    Vec2 { x: -a.y, y: a.x }
}

/// Kreuzprodukt (Z-Komponente) zweier 2D-Vektoren.
fn cross(p: Vec2, q: Vec2) -> f64 {
    p.x * q.y - p.y * q.x
}

/// Skalarprodukt zweier 2D-Vektoren.
fn dot(p: Vec2, q: Vec2) -> f64 {
    p.x * q.x + p.y * q.y
}

/// Schnittpunkt der Geraden (a + t*da) mit (b + s*db).
/// Liefert None bei (nahezu) parallelen Richtungen.
fn line_intersect(a: Vec2, da: Vec2, b: Vec2, db: Vec2) -> Option<Vec2> {
    let denom = cross(da, db);
    if denom.abs() < 1e-9 {
        return None; // parallel -> kein Schnitt
    }
    let t = cross(sub(b, a), db) / denom;
    Some(add(a, scale(da, t)))
}

// --- Verschneidung -----------------------------------------------------------

/// Rundet eine Koordinate auf ein Gitter, um Endpunkte robust zu gruppieren.
fn round_key(p: Vec2) -> String {
    let r = |v: f64| (v * 1e4).round() / 1e4;
    format!("{},{}", r(p.x), r(p.y))
}

#[derive(Clone, Copy, PartialEq)]
enum WallEndKind {
    Start,
    End,
}

struct WallEnd {
    wall_id: String,
    end: WallEndKind,
}

/// Achsrichtung start->end, normalisiert.
fn dir_of(w: &WallInput) -> Vec2 {
    normalize(sub(w.end, w.start))
}

/**
 * Berechnet fuer jede Wand die Gehrungs-Schnittlinien.
 * Behandelt werden: L-Ecken (genau zwei Wandenden treffen sich), T-Knoten
 * (drei Wandenden treffen sich, zwei davon kollinear) und Mittelspannen-
 * T-Stoesse (ein freies Wandende trifft auf die Seite einer anderen Wand).
 * X-Stoesse (vier und mehr Enden) bleiben vorerst rechtwinklig.
 */
pub fn compute_joins(input: JoinInput) -> Vec<WallCuts> {
    let walls = input.walls;

    // Ergebnis: pro Wand ein Eintrag, Reihenfolge wie in der Eingabe.
    let mut result: Vec<WallCuts> = walls
        .iter()
        .map(|w| WallCuts {
            wall_id: w.id.clone(),
            start_cut: None,
            end_cut: None,
            layer_cuts: None,
        })
        .collect();

    // Index Wand-Id -> Position im Ergebnis/Eingabe.
    let mut index: std::collections::HashMap<&str, usize> = std::collections::HashMap::new();
    for (i, w) in walls.iter().enumerate() {
        index.insert(w.id.as_str(), i);
    }

    // Knotenkarte: gerundeter Endpunkt -> Liste der dort endenden Wandenden.
    // BTreeMap fuer deterministische Reihenfolge.
    let mut junctions: std::collections::BTreeMap<String, Vec<WallEnd>> =
        std::collections::BTreeMap::new();
    let push = |p: Vec2, we: WallEnd, m: &mut std::collections::BTreeMap<String, Vec<WallEnd>>| {
        m.entry(round_key(p)).or_default().push(we);
    };
    for w in &walls {
        push(
            w.start,
            WallEnd { wall_id: w.id.clone(), end: WallEndKind::Start },
            &mut junctions,
        );
        push(
            w.end,
            WallEnd { wall_id: w.id.clone(), end: WallEndKind::End },
            &mut junctions,
        );
    }

    for (_key, ends) in &junctions {
        // Freies Ende -> kein Schnitt hier (wird unten separat auf Mittelspannen-T
        // geprueft, Fall 2).
        if ends.len() == 1 {
            continue;
        }

        if ends.len() == 2 {
            let a_idx = match index.get(ends[0].wall_id.as_str()) {
                Some(i) => *i,
                None => continue,
            };
            let b_idx = match index.get(ends[1].wall_id.as_str()) {
                Some(i) => *i,
                None => continue,
            };
            let a = &walls[a_idx];
            let b = &walls[b_idx];

            let cut = match miter_line(a, ends[0].end, b) {
                Some(c) => c,
                None => continue, // kollinear -> kein Schnitt
            };

            set_cut(&mut result[a_idx], ends[0].end, cut);
            set_cut(&mut result[b_idx], ends[1].end, cut);
            continue;
        }

        if ends.len() == 3 {
            apply_t_junction(&walls, &index, ends, &mut result);
            continue;
        }

        // X-Stoesse u. ae. (>3 Enden): vorerst rechtwinklig lassen (Folge-Arbeit).
    }

    // Fall 2: Mittelspannen-T-Stoss. Ein freies Wandende (kein anderes Wandende
    // teilt sich seinen Knoten) kann trotzdem auf die Seite einer anderen Wand
    // treffen (nicht an deren Endpunkten). In dem Fall bekommt das freie Ende
    // einen Schnitt entlang der zugewandten Flaeche dieser Wand.
    for (_key, ends) in &junctions {
        if ends.len() != 1 {
            continue;
        }
        apply_mid_span_tee(&walls, &index, &ends[0], &mut result);
    }

    result
}

/// Traegt eine Schnittlinie am passenden Ende einer Wand ein.
fn set_cut(cuts: &mut WallCuts, end: WallEndKind, cut: Line) {
    match end {
        WallEndKind::Start => cuts.start_cut = Some(cut),
        WallEndKind::End => cuts.end_cut = Some(cut),
    }
}

/**
 * Fall 1 -- T-Knoten: drei Wandenden treffen sich im selben (gerundeten)
 * Knoten. Typisch sind zwei davon kollinear (die zwei Haelften der
 * Durchgangswand, die geometrisch als eine Achse durchlaeuft) und das dritte
 * zweigt ab. Die kollinearen zwei bleiben ungeschnitten; der Abzweig bekommt
 * einen Schnitt entlang der ihm zugewandten Flaeche der Durchgangswand.
 * Findet sich kein eindeutig kollineares Paar (z. B. echter Y-/X-Knoten),
 * bleibt der Knoten unangetastet (rechtwinklig).
 */
fn apply_t_junction(
    walls: &[WallInput],
    index: &std::collections::HashMap<&str, usize>,
    ends: &[WallEnd],
    result: &mut [WallCuts],
) {
    let idx_of = |id: &str| index.get(id).copied();

    let dirs: Vec<Vec2> = match ends
        .iter()
        .map(|e| idx_of(e.wall_id.as_str()).map(|i| dir_of(&walls[i])))
        .collect::<Option<Vec<Vec2>>>()
    {
        Some(d) => d,
        None => return,
    };

    // Suche das (naeherungsweise) kollineare Paar: |cos(Winkel der Achsen)| ~ 1.
    let mut through_pair: Option<(usize, usize)> = None;
    'outer: for i in 0..3 {
        for k in (i + 1)..3 {
            if 1.0 - dot(dirs[i], dirs[k]).abs() < 1e-6 {
                through_pair = Some((i, k));
                break 'outer;
            }
        }
    }
    let (ti, tk) = match through_pair {
        Some(p) => p,
        None => return, // kein eindeutiger Durchgang erkennbar
    };

    let branch_idx = match (0..3).find(|&i| i != ti && i != tk) {
        Some(i) => i,
        None => return,
    };
    let branch_end = &ends[branch_idx];
    let through_end = &ends[ti];
    let branch_wall_idx = match idx_of(branch_end.wall_id.as_str()) {
        Some(i) => i,
        None => return,
    };
    let through_wall_idx = match idx_of(through_end.wall_id.as_str()) {
        Some(i) => i,
        None => return,
    };
    let branch_wall = &walls[branch_wall_idx];
    let through_wall = &walls[through_wall_idx];

    let j = match through_end.end {
        WallEndKind::Start => through_wall.start,
        WallEndKind::End => through_wall.end,
    };
    let t_t = through_wall.thickness;
    let u_t = dir_of(through_wall);
    let n_t = left_normal(u_t);
    let off_t = through_wall.reference_offset;

    // Auslaufrichtung des Abzweigs vom Knoten weg, in seinen eigenen Koerper
    // (gleiche Konvention wie d_a/d_b in miter_line).
    let d_branch = match branch_end.end {
        WallEndKind::Start => dir_of(branch_wall),
        WallEndKind::End => scale(dir_of(branch_wall), -1.0),
    };

    // Zugewandte Flaeche: die Seite der Durchgangsachse, zu der der Abzweig
    // zeigt (positive n_t-Seite, wenn der Abzweig dorthin auslaeuft).
    let sign = if dot(n_t, d_branch) >= 0.0 { 1.0 } else { -1.0 };
    let face_point = add(j, scale(n_t, off_t + sign * (t_t / 2.0)));
    let face_cut = Line { point: face_point, dir: u_t };

    set_cut(&mut result[branch_wall_idx], branch_end.end, face_cut);
    apply_layer_cuts(
        result,
        branch_wall_idx,
        branch_end.end,
        &branch_wall.layers,
        &through_wall.layers,
        face_cut,
        j,
        u_t,
        sign,
        off_t,
    );
}

/**
 * Fall 2 -- Mittelspannen-T-Stoss: prueft, ob das freie Wandende `free_end`
 * auf die innere Spanne einer anderen Wand trifft (projizierter Parameter im
 * Inneren, nicht an deren Endpunkten) und dabei senkrecht nah genug an deren
 * Achse liegt (<= halbe Dicke + Toleranz). Bei Treffer bekommt das freie Ende
 * einen Schnitt entlang der zugewandten Flaeche der getroffenen Wand; bei
 * mehreren Treffern gewinnt die naechstliegende Wand.
 */
fn apply_mid_span_tee(
    walls: &[WallInput],
    index: &std::collections::HashMap<&str, usize>,
    free_end: &WallEnd,
    result: &mut [WallCuts],
) {
    let free_wall_idx = match index.get(free_end.wall_id.as_str()) {
        Some(i) => *i,
        None => return,
    };
    let free_wall = &walls[free_wall_idx];
    let p = match free_end.end {
        WallEndKind::Start => free_wall.start,
        WallEndKind::End => free_wall.end,
    };

    let end_gap = 1e-4; // Mindestabstand zu den Wandenden fuer "innere Spanne"
    let tol = 1e-3; // Toleranz fuer den senkrechten Abstand zur Wandflaeche

    // (Index in `walls`, perp-Abstand vorzeichenbehaftet, absoluter Abstand).
    let mut best: Option<(usize, f64, f64)> = None;
    for (i, w) in walls.iter().enumerate() {
        if w.id == free_wall.id {
            continue;
        }
        let u = dir_of(w);
        let w_len = len(sub(w.end, w.start));
        if w_len < 1e-9 {
            continue;
        }

        let rel = sub(p, w.start);
        let dist_along = dot(rel, u);
        if dist_along <= end_gap || dist_along >= w_len - end_gap {
            continue; // an Endpunkt, kein Mittelspann
        }

        let perp = dot(rel, left_normal(u));
        let tw = w.thickness;
        let dist = perp.abs();
        if dist > tw / 2.0 + tol {
            continue;
        }

        if best.map_or(true, |(_, _, best_dist)| dist < best_dist) {
            best = Some((i, perp, dist));
        }
    }
    let (w_idx, perp, _dist) = match best {
        Some(b) => b,
        None => return, // kein Treffer -> rechtwinklig
    };

    let w = &walls[w_idx];
    let tw = w.thickness;
    let u_w = dir_of(w);
    let n_w = left_normal(u_w);
    let off_w = w.reference_offset;
    let sign = if perp >= 0.0 { 1.0 } else { -1.0 };
    let face_point = add(w.start, scale(n_w, off_w + sign * (tw / 2.0)));
    let face_cut = Line { point: face_point, dir: u_w };

    set_cut(&mut result[free_wall_idx], free_end.end, face_cut);
    // Achsenpunkt auf der getroffenen Wand, auf Hoehe der Projektion des
    // freien Endes (nicht zwingend w.start) -- Anker fuer die
    // materialbewusste Pro-Schicht-Erweiterung (analog zum T-Knoten-Fall).
    let dist_along = dot(sub(p, w.start), u_w);
    let axis_point = add(w.start, scale(u_w, dist_along));
    apply_layer_cuts(
        result,
        free_wall_idx,
        free_end.end,
        &free_wall.layers,
        &w.layers,
        face_cut,
        axis_point,
        u_w,
        sign,
        off_w,
    );
}

/**
 * Gemeinsame Gehrungslinie zweier Waende A, B, die sich im Knoten J treffen.
 * Robust gegen beliebige Wicklung, ungleiche Dicken und JEDEN Oeffnungswinkel
 * (inkl. spitzer): Die Wandflaechen werden orientierungsbasiert (vorzeichen-
 * richtig) gepaart -- A's Aussenflaeche verschneidet B's Aussenflaeche zum
 * aeusseren Apex, A's Innenflaeche B's Innenflaeche zum inneren Apex. "Aussen"
 * ist jeweils die vom Koerper der anderen Wand ABGEWANDTE Flaeche. Die Gerade
 * durch beide Apexe ist die Gehrung; sie trennt beide Wandbaender ueberlappungs-
 * frei.
 *
 * Die fruehere Distanz-Heuristik ("naechstgelegene B-Flaeche") kippt bei spitzen
 * Winkeln -- dort wird die falsche Flaeche zur naeheren, sodass Aussen mit Innen
 * gepaart wird und die Poche-Baender sich kreuzweise ueberlappen.
 *
 * Dicke und Referenzversatz kommen direkt aus WallInput (bereits flach).
 */
fn miter_line(a: &WallInput, a_end: WallEndKind, b: &WallInput) -> Option<Line> {
    let j = match a_end {
        WallEndKind::Start => a.start,
        WallEndKind::End => a.end,
    };

    let t_a = a.thickness;
    let t_b = b.thickness;
    let u_a = dir_of(a);
    let u_b = dir_of(b);
    let n_a = left_normal(u_a);
    let n_b = left_normal(u_b);

    // Referenzlinien-Versatz: liegt die Achse nicht mittig, sind die beiden
    // Wandflaechen um diesen Betrag entlang +n verschoben. Fuer "center"
    // (Default) ist off=0 -> unveraendert.
    let off_a = a.reference_offset;
    let off_b = b.reference_offset;

    // Flaechen-Stuetzpunkte am Knoten (linke/rechte Wandseite), inkl. Versatz.
    let p_la = add(j, scale(n_a, off_a + t_a / 2.0));
    let p_ra = add(j, scale(n_a, off_a - t_a / 2.0));
    let p_lb = add(j, scale(n_b, off_b + t_b / 2.0));
    let p_rb = add(j, scale(n_b, off_b - t_b / 2.0));

    // Auslauf-Richtungen der Achsen vom Knoten weg, in den jeweiligen Wandkoerper.
    let d_a = match a_end {
        WallEndKind::Start => u_a,
        WallEndKind::End => scale(u_a, -1.0),
    };
    let b_at_start = len(sub(b.start, j)) <= len(sub(b.end, j));
    let d_b = if b_at_start { u_b } else { scale(u_b, -1.0) };

    // Orientierungsbasierte, vorzeichenrichtige Flaechen-Paarung. "Aussen" ist die
    // vom Koerper der anderen Wand ABGEWANDTE Flaeche: A's +nA-Flaeche (p_la) liegt
    // aussen, wenn nA*dB < 0; B's +nB-Flaeche (p_lb) aussen, wenn nB*dA < 0. Gepaart
    // wird Aussen-mit-Aussen und Innen-mit-Innen -- nie ueber Kreuz. (nA*dB = 0 tritt
    // nur bei kollinearen Achsen auf; dann sind die Flaechen parallel und
    // line_intersect liefert unten ohnehin None.)
    let b_outer = if dot(n_b, d_a) < 0.0 { p_lb } else { p_rb };
    let b_inner = if dot(n_b, d_a) < 0.0 { p_rb } else { p_lb };
    let a_left_is_outer = dot(n_a, d_b) < 0.0;
    let b_for_left = if a_left_is_outer { b_outer } else { b_inner };
    let b_for_right = if a_left_is_outer { b_inner } else { b_outer };

    // c1 an A's linke Flaeche (p_la), c2 an A's rechte (p_ra) gebunden -- Reihenfolge
    // wie zuvor, damit rechte/stumpfe Ecken bit-identisch bleiben; nur die
    // B-Partnerwahl ist jetzt orientierungs- statt distanzbasiert.
    let c1 = line_intersect(p_la, u_a, b_for_left, u_b)?;
    let c2 = line_intersect(p_ra, u_a, b_for_right, u_b)?;

    let dir = sub(c2, c1);
    if len(dir) < 1e-9 {
        return None;
    }
    Some(Line { point: c1, dir })
}

// --- Tests -------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn w(id: &str, sx: f64, sy: f64, ex: f64, ey: f64, thickness: f64) -> WallInput {
        WallInput {
            id: id.to_string(),
            start: Vec2 { x: sx, y: sy },
            end: Vec2 { x: ex, y: ey },
            thickness,
            reference_offset: 0.0,
            layers: Vec::new(),
        }
    }

    fn find<'a>(cuts: &'a [WallCuts], id: &str) -> &'a WallCuts {
        cuts.iter().find(|c| c.wall_id == id).expect("wall id present")
    }

    #[test]
    fn l_corner_shared_miter() {
        // Wand A (0,0)-(5,0) und Wand B (5,0)-(5,4) treffen sich in (5,0).
        let input = JoinInput {
            walls: vec![
                w("A", 0.0, 0.0, 5.0, 0.0, 0.2),
                w("B", 5.0, 0.0, 5.0, 4.0, 0.2),
            ],
        };
        let out = compute_joins(input);
        assert_eq!(out.len(), 2);

        let ca = find(&out, "A");
        let cb = find(&out, "B");

        // A endet im Knoten -> endCut gesetzt; B startet dort -> startCut gesetzt.
        let a_cut = ca.end_cut.expect("A endCut set");
        let b_cut = cb.start_cut.expect("B startCut set");
        assert!(ca.start_cut.is_none(), "A startCut is free end");
        assert!(cb.end_cut.is_none(), "B endCut is free end");

        // Beide Waende teilen sich dieselbe Gehrungslinie.
        assert!((a_cut.point.x - b_cut.point.x).abs() < 1e-9);
        assert!((a_cut.point.y - b_cut.point.y).abs() < 1e-9);
        assert!((a_cut.dir.x - b_cut.dir.x).abs() < 1e-9);
        assert!((a_cut.dir.y - b_cut.dir.y).abs() < 1e-9);

        // Sanity: die Gehrung einer 90-Grad-Ecke gleicher Dicke ist die
        // Diagonale durch (5,0), Richtung parallel zu (1,1) oder (-1,-1).
        let d = normalize(a_cut.dir);
        assert!(
            (d.x.abs() - d.y.abs()).abs() < 1e-6,
            "45-Grad-Gehrung erwartet"
        );
    }

    #[test]
    fn acute_corner_pairs_outer_with_outer() {
        // Symmetrische V-Ecke, Knoten (0,0), Oeffnungswinkel 60 Grad (spitz),
        // nach oben. Beide Wandkoerper laufen unter +/-30 Grad zur +y-Achse aus.
        // WA endet im Knoten, WB startet dort. Erwartet: vertikale Gehrung durch
        // Aussen-Apex (0,-0.4) und Innen-Apex (0,0.4). Die alte Distanz-Heuristik
        // lieferte hier eine um 90 Grad verdrehte, horizontale Gehrung.
        let s3 = 3.0_f64.sqrt() / 2.0;
        let input = JoinInput {
            walls: vec![
                w("WA", -1.0, 2.0 * s3, 0.0, 0.0, 0.4),
                w("WB", 0.0, 0.0, 1.0, 2.0 * s3, 0.4),
            ],
        };
        let out = compute_joins(input);
        let ca = find(&out, "WA");
        let cb = find(&out, "WB");
        let cut = ca.end_cut.or(cb.start_cut).expect("Gehrung gesetzt");

        // Abstand Punkt->Gerade: |cross(dir, q - point)| / len(dir).
        let dist = |q: Vec2| cross(cut.dir, sub(q, cut.point)).abs() / len(cut.dir);
        assert!(dist(Vec2 { x: 0.0, y: -0.4 }) < 1e-6, "Aussen-Apex auf Gehrung");
        assert!(dist(Vec2 { x: 0.0, y: 0.4 }) < 1e-6, "Innen-Apex auf Gehrung");
        // Gehrung vertikal: dir.x ~ 0 (die falsche, horizontale Gehrung haette
        // stattdessen dir.y ~ 0 gehabt).
        assert!(cut.dir.x.abs() / len(cut.dir) < 1e-6, "vertikale Gehrung erwartet");
    }

    #[test]
    fn free_end_no_cut() {
        let input = JoinInput {
            walls: vec![w("A", 0.0, 0.0, 5.0, 0.0, 0.2)],
        };
        let out = compute_joins(input);
        assert_eq!(out.len(), 1);
        let ca = find(&out, "A");
        assert!(ca.start_cut.is_none());
        assert!(ca.end_cut.is_none());
    }

    #[test]
    fn t_junction_branch_gets_face_cut() {
        // Drei Enden treffen sich in (5,0): A/C sind kollinear (Durchgangswand),
        // B zweigt ab. A/C bleiben ungeschnitten; B bekommt einen Schnitt entlang
        // der ihm zugewandten Flaeche der Durchgangswand (hier: y = +0.1, da B
        // nach +y auslaeuft und die Durchgangswand entlang +x verlaeuft, also
        // liegt deren linke Flaeche bei +0.1).
        let input = JoinInput {
            walls: vec![
                w("A", 0.0, 0.0, 5.0, 0.0, 0.2),
                w("B", 5.0, 0.0, 5.0, 4.0, 0.2),
                w("C", 5.0, 0.0, 10.0, 0.0, 0.2),
            ],
        };
        let out = compute_joins(input);
        assert_eq!(out.len(), 3);

        let ca = find(&out, "A");
        let cc = find(&out, "C");
        assert!(ca.start_cut.is_none(), "A startCut ist freies Ende");
        assert!(ca.end_cut.is_none(), "A durchgehend -> kein Schnitt");
        assert!(cc.start_cut.is_none(), "C durchgehend -> kein Schnitt");
        assert!(cc.end_cut.is_none(), "C endCut ist freies Ende");

        let cb = find(&out, "B");
        let cut = cb.start_cut.expect("B startCut gesetzt");
        assert!(cb.end_cut.is_none(), "B endCut ist freies Ende");
        assert!((cut.point.x - 5.0).abs() < 1e-9);
        assert!((cut.point.y - 0.1).abs() < 1e-9, "Flaeche bei y=+0.1 erwartet");
        // Schnittlinie verlaeuft entlang der Durchgangsachse (parallel zu +x).
        assert!(cut.dir.y.abs() / len(cut.dir) < 1e-9);
    }

    #[test]
    fn collinear_pair_no_cut() {
        // A (0,0)-(5,0) und B (5,0)-(10,0): parallel -> None.
        let input = JoinInput {
            walls: vec![
                w("A", 0.0, 0.0, 5.0, 0.0, 0.2),
                w("B", 5.0, 0.0, 10.0, 0.0, 0.2),
            ],
        };
        let out = compute_joins(input);
        assert_eq!(out.len(), 2);
        for id in ["A", "B"] {
            let c = find(&out, id);
            assert!(c.start_cut.is_none(), "{id} startCut none");
            assert!(c.end_cut.is_none(), "{id} endCut none");
        }
    }

    #[test]
    fn mid_span_tee_free_end_hits_wall_side() {
        // Freie Wand B endet bei (5,0) exakt auf der Achse der durchgehenden
        // Wand A (0,0)-(10,0), mittig auf deren Spanne (nicht an deren Enden).
        // B's anderes Ende (5,2) bleibt frei (zu weit von A entfernt). Der
        // Treffer liegt exakt auf A's Achse (perp=0) -> die zugewandte Flaeche
        // ist A's linke Flaeche bei y=+tw/2=+0.1 (sign=+1 per Konvention bei
        // perp>=0). Die Schnittlinie ist als Punkt+Richtung auf A's Anker
        // (A.start) verankert, verlaeuft aber unabhaengig davon entlang y=0.1.
        let input = JoinInput {
            walls: vec![
                w("A", 0.0, 0.0, 10.0, 0.0, 0.2),
                w("B", 5.0, 2.0, 5.0, 0.0, 0.2),
            ],
        };
        let out = compute_joins(input);
        assert_eq!(out.len(), 2);

        let ca = find(&out, "A");
        assert!(ca.start_cut.is_none(), "A durchgehend -> kein Schnitt");
        assert!(ca.end_cut.is_none(), "A durchgehend -> kein Schnitt");

        let cb = find(&out, "B");
        assert!(cb.start_cut.is_none(), "B startCut ist freies Ende bei (5,2)");
        let cut = cb.end_cut.expect("B endCut (Mittelspann-Treffer) gesetzt");

        // Verankert an A.start = (0,0), verschoben um A's halbe Dicke entlang
        // ihrer linken Normale (0,1) -> Punkt (0, 0.1), Richtung parallel zu A.
        assert!((cut.point.x - 0.0).abs() < 1e-9);
        assert!((cut.point.y - 0.1).abs() < 1e-9);
        assert!(cut.dir.y.abs() / len(cut.dir) < 1e-9, "Schnittlinie parallel zu A");

        // Robuster: die Gerade verlaeuft exakt bei y=0.1, unabhaengig vom x.
        let dist = |q: Vec2| cross(cut.dir, sub(q, cut.point)).abs() / len(cut.dir);
        assert!(dist(Vec2 { x: 5.0, y: 0.1 }) < 1e-9, "Treffpunkt (5,0.1) auf Gehrung");
    }

    /// W9-artiger Wandtyp: Innenputz (0.015) / Backstein-Kern (0.12) / Innenputz
    /// (0.015), joinPriority 10 bzw. 50 -- Spiegel von `layeredWallProject` aus
    /// `model/joins.test.ts`.
    fn w_iw(id: &str, sx: f64, sy: f64, ex: f64, ey: f64) -> WallInput {
        WallInput {
            id: id.to_string(),
            start: Vec2 { x: sx, y: sy },
            end: Vec2 { x: ex, y: ey },
            thickness: 0.15,
            reference_offset: 0.0,
            layers: vec![
                LayerInput { component_id: "render-int".into(), join_priority: 10.0, thickness: 0.015 },
                LayerInput { component_id: "brick".into(), join_priority: 50.0, thickness: 0.12 },
                LayerInput { component_id: "render-int".into(), join_priority: 10.0, thickness: 0.015 },
            ],
        }
    }

    #[test]
    fn t_junction_layer_cuts_merge_and_trim() {
        // Wie t_junction_branch_gets_face_cut, aber alle drei Waende vom
        // W9-artigen Wandtyp: der Backstein-Kern (Index 1) sticht durch den
        // Nah-Putz und stoppt an der Kern-Nahflaeche (y=0.06), die beiden
        // Innenputz-Schichten (Index 0/2) werden getrimmt und bekommen
        // zusaetzlich die seitliche L-Linie an derselben Flaeche.
        let input = JoinInput {
            walls: vec![
                w_iw("A", 0.0, 0.0, 5.0, 0.0),
                w_iw("B", 5.0, 0.0, 5.0, 3.0),
                w_iw("C", 5.0, 0.0, 10.0, 0.0),
            ],
        };
        let out = compute_joins(input);
        let cb = find(&out, "B");

        // Aggregat-Cut bleibt unveraendert (bit-identisch zum bisherigen Verhalten).
        let agg = cb.start_cut.expect("B startCut gesetzt");
        assert!((agg.point.x - 5.0).abs() < 1e-9);
        assert!((agg.point.y - 0.075).abs() < 1e-9);

        let lc = cb.layer_cuts.as_ref().expect("layerCuts gesetzt (Backstein verschmilzt)");
        assert_eq!(lc.start.len(), 3);

        let dist = |cut: Line, q: Vec2| cross(cut.dir, sub(q, cut.point)).abs() / len(cut.dir);

        // Schicht 1 (Backstein-Kern): Cut an der Rueckgrat-Nahflaeche y=0.06
        // (Halbdicke 0.075 minus Nah-Putz 0.015), NICHT null/Achse; keine
        // Seitenlinie (verschmilzt).
        let l1 = lc.start[1].expect("Schicht 1 (Kern) hat Merge-Cut");
        assert!(dist(l1, Vec2 { x: 5.0, y: 0.06 }) < 1e-9);
        assert!(dist(l1, Vec2 { x: 0.0, y: 0.06 }) < 1e-9);
        assert!(dist(l1, Vec2 { x: 5.0, y: 0.0 }) > 1e-6); // nicht bis zur Achse
        assert!(lc.start_side[1].is_none());

        // Schichten 0/2 (Innenputz): derselbe Nahflaechen-Cut wie das Aggregat...
        let l0 = lc.start[0].expect("Schicht 0 getrimmt");
        let l2 = lc.start[2].expect("Schicht 2 getrimmt");
        assert!((l0.point.y - 0.075).abs() < 1e-9);
        assert!((l2.point.y - 0.075).abs() < 1e-9);
        // ... UND die seitliche L-Linie an der Rueckgrat-Nahflaeche (y=0.06,
        // parallel zur x-Achse).
        let s0 = lc.start_side[0].expect("Schicht 0 hat L-Seitenlinie");
        let s2 = lc.start_side[2].expect("Schicht 2 hat L-Seitenlinie");
        assert!(dist(s0, Vec2 { x: 5.0, y: 0.06 }) < 1e-9);
        assert!(dist(s0, Vec2 { x: 0.0, y: 0.06 }) < 1e-9);
        assert!(dist(s2, Vec2 { x: 5.0, y: 0.06 }) < 1e-9);

        // Die kollineare Durchgangswand bleibt unangetastet (kein layerCuts).
        let ca = find(&out, "A");
        let cc = find(&out, "C");
        assert!(ca.layer_cuts.is_none());
        assert!(cc.layer_cuts.is_none());
    }
}
