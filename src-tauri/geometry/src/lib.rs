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

#[derive(Serialize, Deserialize)]
pub struct WallInput {
    pub id: String,
    pub start: Vec2,
    pub end: Vec2,
    pub thickness: f64,
    #[serde(rename = "referenceOffset")]
    pub reference_offset: f64,
}

#[derive(Serialize, Deserialize)]
pub struct JoinInput {
    pub walls: Vec<WallInput>,
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
 * Nur L-Ecken (genau zwei Wandenden treffen sich) werden behandelt; freie
 * Enden und T-/X-Stoesse bleiben rechtwinklig.
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
        // Freies Ende -> kein Schnitt.
        if ends.len() == 1 {
            continue;
        }
        // T-/X-Stoesse (>2 Enden): vorerst rechtwinklig lassen.
        if ends.len() != 2 {
            continue;
        }

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
    fn t_junction_no_cut() {
        // Drei Enden treffen sich in (5,0): rechtwinklig lassen.
        let input = JoinInput {
            walls: vec![
                w("A", 0.0, 0.0, 5.0, 0.0, 0.2),
                w("B", 5.0, 0.0, 5.0, 4.0, 0.2),
                w("C", 5.0, 0.0, 10.0, 0.0, 0.2),
            ],
        };
        let out = compute_joins(input);
        assert_eq!(out.len(), 3);
        for id in ["A", "B", "C"] {
            let c = find(&out, id);
            assert!(c.start_cut.is_none(), "{id} startCut none");
            assert!(c.end_cut.is_none(), "{id} endCut none");
        }
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
}
