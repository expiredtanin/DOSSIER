//! [158] Raumbuch: Oberflächen je Raum (Boden, Wand, Decke), Nutzung und die Mengen daraus.
//!
//! Je Raum eine Zeile mit Geschoss, Nummer, Name, Fläche, Nutzung (Nassraum abgeleitet), Bodenbelag,
//! Wand- und Deckenoberfläche (Bauteil-Material über seine Kennung oder Freitext) und Bodenaufbau.
//! Mengen: Bodenfläche = Deckenfläche = Raumfläche (netto); Wandfläche netto = Umfang × lichte Höhe (unter
//! Dachschrägen die mittlere Höhe je Wandseite) − Öffnungen in den Wänden am Raum. Lichte Höhe aus den Decken über/unter dem Raum (Oberkante der Decke
//! am Boden bis Unterkante der Decke darüber), sonst Geschosshöhe.
//! Die Tabelle wird im Kern gerechnet; CSV/PDF und Blatt-Tabelle formatieren dieselben Zeilen.

use crate::model::*;
use serde::Serialize;

impl RoomUsage {
    /// Kennung wie im JSON (`living`, `bath` …); leer für unbekannte Werte.
    pub fn key(self) -> &'static str {
        match self {
            RoomUsage::Living => "living",
            RoomUsage::Sleeping => "sleeping",
            RoomUsage::Kitchen => "kitchen",
            RoomUsage::Dining => "dining",
            RoomUsage::Bath => "bath",
            RoomUsage::Wc => "wc",
            RoomUsage::Shower => "shower",
            RoomUsage::Laundry => "laundry",
            RoomUsage::Circulation => "circulation",
            RoomUsage::Technical => "technical",
            RoomUsage::Storage => "storage",
            RoomUsage::Office => "office",
            RoomUsage::Other => "other",
            RoomUsage::Unknown => "",
        }
    }

    /// Alle wählbaren Nutzungen (Reihenfolge der Auswahl).
    pub const ALL: [RoomUsage; 13] = [
        RoomUsage::Living,
        RoomUsage::Sleeping,
        RoomUsage::Kitchen,
        RoomUsage::Dining,
        RoomUsage::Bath,
        RoomUsage::Wc,
        RoomUsage::Shower,
        RoomUsage::Laundry,
        RoomUsage::Circulation,
        RoomUsage::Technical,
        RoomUsage::Storage,
        RoomUsage::Office,
        RoomUsage::Other,
    ];

    pub fn from_key(k: &str) -> Option<RoomUsage> {
        let k = k.trim().to_lowercase();
        Self::ALL.into_iter().find(|u| u.key() == k)
    }

    /// Nassraum: Bad, WC, Dusche, Waschküche.
    pub fn is_wet(self) -> bool {
        matches!(self, RoomUsage::Bath | RoomUsage::Wc | RoomUsage::Shower | RoomUsage::Laundry)
    }
}

/// Bauteil-Material, auf das eine Oberflächen-Angabe verweist (Kennung, sonst gleicher Name).
pub fn finish_component<'a>(p: &'a Project, v: Option<&str>) -> Option<&'a Component> {
    let v = v.map(str::trim).filter(|s| !s.is_empty())?;
    p.component(v).or_else(|| p.components.iter().find(|c| c.name.trim() == v))
}

/// Anzeigetext einer Oberflächen-Angabe: Name des Materials, sonst der Freitext.
pub fn finish_label(p: &Project, v: Option<&str>) -> String {
    let t = v.map(str::trim).unwrap_or("");
    match p.component(t) {
        Some(c) if !t.is_empty() => c.name.clone(),
        _ => t.to_string(),
    }
}

fn level_of<'a>(p: &'a Project, id: &str) -> Option<&'a DrawingLevel> {
    p.drawing_levels.iter().find(|l| l.id == id)
}

fn in_ceiling(ce: &Ceiling, x: f64, y: f64) -> bool {
    use crate::opening_schedule::in_ring;
    ce.outline.len() >= 3 && in_ring(x, y, &ce.ring()) && !ce.hole_rings().iter().any(|h| h.len() >= 3 && in_ring(x, y, h))
}

/// Höhenbereich des Raums (Z unten, Z oben): von der Oberkante der Decke unter dem Raum (bis 0.3 m unter
/// bzw. 0.5 m über dem Geschossboden, sonst der Geschossboden) bis zur Unterkante der nächsten Decke
/// darüber (sonst Geschossoberkante). Ohne Geschosshöhe 2.5 m; ohne brauchbare Spanne Geschosshöhe.
pub fn clear_range(p: &Project, r: &Room) -> (f64, f64) {
    let lvl = level_of(p, &r.floor_id);
    let base = lvl.and_then(|l| l.base_elevation).filter(|v| v.is_finite()).unwrap_or(0.0);
    let fh = lvl.and_then(|l| l.floor_height).filter(|h| h.is_finite() && *h > 0.0).unwrap_or(2.5);
    let ring: Vec<[f64; 2]> = r.ring_xy();
    if ring.len() < 3 {
        return (base, base + fh);
    }
    let [x, y] = crate::room_area::label_point(&ring);
    let over: Vec<(f64, f64)> = p.ceilings.as_deref().unwrap_or(&[]).iter().filter(|ce| in_ceiling(ce, x, y)).map(|ce| p.ceiling_vertical_extent(ce)).filter(|(a, b)| a.is_finite() && b.is_finite()).collect();
    let floor_z = over.iter().map(|e| e.1).filter(|t| *t >= base - 0.3 && *t <= base + 0.5).fold(f64::NAN, f64::max);
    let floor_z = if floor_z.is_finite() { floor_z } else { base };
    let ceil_z = over.iter().map(|e| e.0).filter(|b| *b > floor_z + 1.0).fold(f64::NAN, f64::min);
    let ceil_z = if ceil_z.is_finite() { ceil_z } else { base + fh };
    if ceil_z - floor_z > 0.5 {
        (floor_z, ceil_z)
    } else {
        (base, base + fh)
    }
}

/// Lichte Höhe eines Raums (m), s. [`clear_range`]: das Mass an der höchsten Stelle (Dachschrägen
/// berücksichtigt [`height_bands`]).
pub fn clear_height(p: &Project, r: &Room) -> f64 {
    let (a, b) = clear_range(p, r);
    b - a
}

/// Untergrenze der Höhenbereiche nach SIA 416 (m): unter 1.0 m Raumhöhe zählt die Fläche nicht zur NF,
/// 1.0–1.5 m nur eingeschränkt, ab 1.5 m voll.
pub const BAND_LOW: f64 = 1.0;
pub const BAND_MID: f64 = 1.5;

/// Lichte Höhe unter Dachschrägen: kleinste und mittlere Höhe sowie die Fläche je Höhenbereich.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeightBands {
    pub min: f64,
    pub mean: f64,
    /// Fläche mit lichter Höhe < 1.0 m (m²).
    pub area_low: f64,
    /// Fläche mit 1.0 m ≤ lichte Höhe < 1.5 m (m²).
    pub area_mid: f64,
    /// Fläche mit lichter Höhe ≥ 1.5 m (m²).
    pub area_full: f64,
}

/// Dachflächen (Grundriss-Polygone mit Z) und Schichtdicke je Dach des Geschosses; nur Dächer des
/// eigenen Geschosses wirken auf einen Raum (ein Dach darunter ist sein Boden, eines darüber hat Luft).
pub struct RoofPlanes {
    floor_id: String,
    roofs: Vec<(Vec<Vec<[f64; 3]>>, f64)>,
}

pub fn roof_planes(p: &Project, floor_id: &str) -> RoofPlanes {
    let roofs = p
        .roofs
        .as_deref()
        .unwrap_or(&[])
        .iter()
        .filter(|r| r.floor_id == floor_id)
        .map(|r| (crate::roof::roof_geometry(&r.params(), p.roof_base_elevation(r)).planes, Project::type_thickness(&p.roof_layers(r))))
        .collect();
    RoofPlanes { floor_id: floor_id.to_string(), roofs }
}

/// Höhenbereiche eines Raums mit den Dachflächen seines Geschosses. Ohne Dach (oder wo keine Dachfläche
/// über dem Raum liegt) gilt die lichte Höhe; sonst zählt je Punkt die Dachunterkante über dem Boden
/// (höchstens die lichte Höhe). Die Flächen kommen aus einem Raster über dem Raum (höchstens ~40 000
/// Stützstellen) und werden auf die Nettofläche skaliert.
pub fn height_bands(p: &Project, r: &Room, roofs: &RoofPlanes, net_area: f64) -> HeightBands {
    use crate::opening_schedule::in_ring;
    let (floor_z, ceil_z) = clear_range(p, r);
    let top = ceil_z - floor_z;
    let band = |h: f64, area: f64| -> (f64, f64, f64) {
        if h < BAND_LOW {
            (area, 0.0, 0.0)
        } else if h < BAND_MID {
            (0.0, area, 0.0)
        } else {
            (0.0, 0.0, area)
        }
    };
    let flat = |h: f64| {
        let (a, b, c) = band(h, net_area);
        HeightBands { min: h, mean: h, area_low: a, area_mid: b, area_full: c }
    };
    if roofs.floor_id != r.floor_id || roofs.roofs.is_empty() || r.boundary.len() < 3 || r.boundary.iter().any(|v| !v.x.is_finite() || !v.y.is_finite()) {
        return flat(top);
    }
    let ring = r.ring();
    let (x0, y0, x1, y1) = ring.iter().fold((f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY), |b, v| (b.0.min(v.x), b.1.min(v.y), b.2.max(v.x), b.3.max(v.y)));
    let step = (((x1 - x0) * (y1 - y0)) / 40_000.0).sqrt().max(0.05);
    let (nx, ny) = ((((x1 - x0) / step).ceil() as usize).max(1), (((y1 - y0) / step).ceil() as usize).max(1));
    // [258] Sehr lang gestreckter oder riesiger Raum (1e300 m): höchstens 1000 Zellen je Richtung, dann mit eigenem
    // Abstand je Achse (sonst Milliarden Zellen). Im Normalfall bleibt `step` für beide Achsen.
    let (sx, sy, nx, ny) = if nx > 1000 || ny > 1000 {
        let (nx, ny) = (nx.min(1000), ny.min(1000));
        ((x1 - x0) / nx as f64, (y1 - y0) / ny as f64, nx, ny)
    } else {
        (step, step, nx, ny)
    };
    let (mut n, mut sum, mut min) = (0usize, 0.0, f64::INFINITY);
    let mut counts = [0usize; 3];
    for j in 0..ny {
        for i in 0..nx {
            let (x, y) = (x0 + (i as f64 + 0.5) * sx, y0 + (j as f64 + 0.5) * sy);
            if !in_ring(x, y, &ring) {
                continue;
            }
            let mut h = top;
            for (planes, thick) in &roofs.roofs {
                if let Some(u) = crate::roof::roof_underside_at(planes, *thick, x, y) {
                    h = h.min((u - floor_z).max(0.0));
                }
            }
            n += 1;
            sum += h;
            min = min.min(h);
            counts[if h < BAND_LOW { 0 } else if h < BAND_MID { 1 } else { 2 }] += 1;
        }
    }
    if n == 0 {
        return flat(top);
    }
    let k = net_area / n as f64;
    HeightBands { min, mean: sum / n as f64, area_low: counts[0] as f64 * k, area_mid: counts[1] as f64 * k, area_full: counts[2] as f64 * k }
}

/// Wand-Öffnungen (Tür, Fenster) am Raum mit ihrer Wand: Öffnungen in Wänden des Geschosses, deren
/// Prüfpunkt neben der Wand (eine Seite) im Raum liegt.
fn room_openings<'a>(p: &'a Project, r: &Room) -> Vec<(&'a Opening, &'a Wall)> {
    use crate::opening_schedule::{in_ring, side_points};
    let mut out = Vec::new();
    let ring = r.ring();
    for o in p.openings.as_deref().unwrap_or(&[]) {
        if crate::opening_shape::is_surface_hosted(o) {
            continue;
        }
        let Some(w) = p.walls.iter().find(|w| w.id == o.host_wall_id && w.floor_id == r.floor_id) else { continue };
        let Some((a, b)) = side_points(p, w, o.position + o.width / 2.0) else { continue };
        if in_ring(a[0], a[1], &ring) || in_ring(b[0], b[1], &ring) {
            let area = o.width * o.height;
            if area.is_finite() && area > 0.0 {
                out.push((o, w));
            }
        }
    }
    out
}

/// Fläche der Wand-Öffnungen (Tür, Fenster) am Raum.
pub fn opening_area(p: &Project, r: &Room) -> f64 {
    room_openings(p, r).iter().map(|(o, _)| o.width * o.height).sum()
}

/// Wandseite am Raum: der Teil einer Wand, an dem der Raumumriss anliegt (Raumseite der Wand).
/// `wall_id` leer = Umrisskante ohne Wand (z. B. Bogenwand oder frei).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WallSide {
    pub wall_id: String,
    /// Länge der anliegenden Wandseite (m).
    pub length: f64,
    /// Fläche brutto = Länge × mittlere Höhe entlang der Seite (unter Schrägen < lichte Höhe) (m²).
    pub gross: f64,
    /// Öffnungen in diesem Abschnitt (m²).
    pub openings: f64,
    /// Fläche netto = brutto − Öffnungen (m²).
    pub area: f64,
    /// Leibungsflächen der Öffnungen: Laibungsumfang × Wanddicke (m²).
    pub reveals: f64,
}

/// Wandseiten eines Raums: je Wand die Länge der Umrisskanten, die auf ihrer Fläche liegen (Kante
/// parallel zur Wandachse, im Abstand Wanddicke/2 ± 8 cm), mit den Öffnungen des Abschnitts.
///
/// Unter Dachschrägen (`roofs`) zählt die mittlere Höhe entlang der Wandseite statt der vollen lichten
/// Höhe `height`: Stützstellen alle ~10 cm entlang des Kantenstücks, je Stelle die Dachunterkante über
/// dem Boden (höchstens `height`), s. [`edge_mean_height`].
pub fn wall_sides(p: &Project, r: &Room, height: f64, roofs: Option<&RoofPlanes>) -> Vec<WallSide> {
    let b: &[crate::model::Vec2] = &r.ring();
    let floor_z = clear_range(p, r).0;
    let mean_h = |a: [f64; 2], c: [f64; 2]| edge_mean_height(r, roofs, floor_z, height, a, c);
    let openings = room_openings(p, r);
    let mut sides: Vec<WallSide> = Vec::new();
    let mut add = |wall_id: &str, length: f64, gross: f64, ops: &[&(&Opening, &Wall)], thick: f64| {
        let open: f64 = ops.iter().map(|(o, _)| o.width * o.height).sum();
        let reveals: f64 = ops.iter().map(|(o, _)| (if o.kind == ElementKind::Door { 2.0 * o.height + o.width } else { 2.0 * (o.height + o.width) }) * thick).sum();
        match sides.iter_mut().find(|s| s.wall_id == wall_id) {
            Some(s) => {
                s.length += length;
                s.gross += gross;
                s.openings += open;
                s.reveals += reveals;
            }
            None => sides.push(WallSide { wall_id: wall_id.to_string(), length, gross, openings: open, area: 0.0, reveals }),
        }
    };
    for i in 0..b.len() {
        let (a, c) = (&b[i], &b[(i + 1) % b.len()]);
        let (ex, ey) = (c.x - a.x, c.y - a.y);
        let elen = ex.hypot(ey);
        if !(elen > 1e-9) || !elen.is_finite() {
            continue;
        }
        let mut covered: Vec<(f64, f64)> = Vec::new();
        for w in p.walls.iter().filter(|w| w.floor_id == r.floor_id && w.bulge.unwrap_or(0.0).abs() < 1e-9) {
            let (wx, wy) = (w.end.x - w.start.x, w.end.y - w.start.y);
            let wl = wx.hypot(wy);
            if !(wl > 1e-9) {
                continue;
            }
            let (ux, uy) = (wx / wl, wy / wl);
            if (ux * ey - uy * ex).abs() / elen > 0.02 {
                continue;
            }
            let thick = p.wall_thickness(w, 0.2);
            // Abstand der Kantenmitte zur Achse.
            let (mx, my) = ((a.x + c.x) / 2.0 - w.start.x, (a.y + c.y) / 2.0 - w.start.y);
            if ((-uy * mx + ux * my).abs() - thick / 2.0).abs() > 0.08 {
                continue;
            }
            // Überlappung der Kante mit der Wand (Achskoordinate ab Wandanfang).
            let (s0, s1) = ((a.x - w.start.x) * ux + (a.y - w.start.y) * uy, (c.x - w.start.x) * ux + (c.y - w.start.y) * uy);
            let (lo, hi) = (s0.min(s1).max(0.0), s0.max(s1).min(wl));
            if hi - lo < 1e-6 {
                continue;
            }
            let ops: Vec<&(&Opening, &Wall)> = openings.iter().filter(|(o, ow)| ow.id == w.id && o.position + o.width / 2.0 >= lo && o.position + o.width / 2.0 <= hi).collect();
            let at = |sv: f64| {
                let t = (sv - s0) / (s1 - s0);
                [a.x + t * ex, a.y + t * ey]
            };
            let (pa, pb) = (at(lo), at(hi));
            add(&w.id, hi - lo, (hi - lo) * mean_h(pa, pb), &ops, thick);
            covered.push((lo, hi));
        }
        // Rest der Kante ohne Wand (Überlappungen mehrerer Wände nicht doppelt zählen).
        let cov: f64 = covered.iter().map(|(a, b)| b - a).sum::<f64>().min(elen);
        if elen - cov > 1e-6 {
            add("", elen - cov, (elen - cov) * mean_h([a.x, a.y], [c.x, c.y]), &[], 0.0);
        }
    }
    for s in &mut sides {
        s.area = (s.gross - s.openings).max(0.0);
    }
    sides
}

/// Mittlere Höhe (m) einer Wandseite von `a` nach `c`: an Stützstellen (alle ~10 cm, höchstens 200) die
/// Dachunterkante über `floor_z`, begrenzt auf `0..=top`. Ohne Dach oder ausserhalb der Dachflächen `top`.
/// Die Stellen sitzen 1 cm im Raum, damit Kanten genau auf dem Dachrand nicht aus der Fläche fallen.
fn edge_mean_height(r: &Room, roofs: Option<&RoofPlanes>, floor_z: f64, top: f64, a: [f64; 2], c: [f64; 2]) -> f64 {
    use crate::opening_schedule::in_ring;
    let Some(roofs) = roofs.filter(|x| x.floor_id == r.floor_id && !x.roofs.is_empty()) else { return top };
    let (dx, dy) = (c[0] - a[0], c[1] - a[1]);
    let len = dx.hypot(dy);
    if !(len > 1e-9) || !len.is_finite() {
        return top;
    }
    let n = ((len / 0.1).ceil() as usize).clamp(1, 200);
    let (nx, ny) = (-dy / len * 0.01, dx / len * 0.01);
    let ring = r.ring();
    let mut sum = 0.0;
    for i in 0..n {
        let t = (i as f64 + 0.5) / n as f64;
        let (mut x, mut y) = (a[0] + t * dx, a[1] + t * dy);
        if in_ring(x + nx, y + ny, &ring) {
            x += nx;
            y += ny;
        } else if in_ring(x - nx, y - ny, &ring) {
            x -= nx;
            y -= ny;
        }
        let mut h = top;
        for (planes, thick) in &roofs.roofs {
            if let Some(u) = crate::roof::roof_underside_at(planes, *thick, x, y) {
                h = h.min((u - floor_z).max(0.0));
            }
        }
        sum += h;
    }
    sum / n as f64
}

/// Sockellänge: Umfang minus Türbreiten am Raum.
pub fn skirting_length(p: &Project, r: &Room, perimeter: f64) -> f64 {
    let doors: f64 = room_openings(p, r).iter().filter(|(o, _)| o.kind == ElementKind::Door).map(|(o, _)| o.width).sum();
    (perimeter - doors).max(0.0)
}

/// Nassraum: aus der Nutzung, ohne Nutzung nach dem Namen (`plan::floor_finish::is_wet_name`).
pub fn is_wet(r: &Room) -> bool {
    match r.usage {
        Some(u) if u != RoomUsage::Unknown => u.is_wet(),
        _ => crate::plan::floor_finish::is_wet_name(r),
    }
}

/// Eine Zeile des Raumbuchs (JSON-Form: `RoomBookRow` in TS).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomBookRow {
    pub id: String,
    pub floor: String,
    pub floor_id: String,
    pub number: String,
    pub name: String,
    /// Nettofläche (m²) = Boden- und Deckenfläche.
    pub area: f64,
    pub perimeter: f64,
    /// Lichte Höhe an der höchsten Stelle (m).
    pub clear_height: f64,
    /// Kleinste und mittlere lichte Höhe unter Dachschrägen (m), Flächen je SIA-416-Höhenbereich (m²).
    pub height_min: f64,
    pub height_mean: f64,
    pub area_under_1: f64,
    pub area_1_to_15: f64,
    pub area_over_15: f64,
    /// Nutzungs-Kennung (`living` …), leer ohne Angabe.
    pub usage: String,
    pub wet: bool,
    /// Anzeigetexte (Material-Name oder Freitext), leer ohne Angabe.
    pub floor_finish: String,
    pub wall_finish: String,
    pub ceiling_finish: String,
    pub floor_build_up: String,
    /// Wandfläche netto: Summe der Wandseiten (Länge × mittlere Höhe − Öffnungen) (m²).
    pub wall_area: f64,
    pub opening_area: f64,
    /// Wandoberflächen je Wandseite (Raumseite), Höhe = mittlere Höhe entlang der Seite.
    pub wall_sides: Vec<WallSide>,
    /// Leibungsflächen aller Öffnungen am Raum (m²).
    pub reveal_area: f64,
    /// Sockellänge: Umfang minus Türbreiten (m).
    pub skirting: f64,
}

/// Menge einer Oberfläche: Fläche je Material/Freitext und Lage.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FinishQty {
    /// "floor", "wall" oder "ceiling".
    pub surface: &'static str,
    pub finish: String,
    pub area: f64,
    pub rooms: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomBook {
    pub rows: Vec<RoomBookRow>,
    pub quantities: Vec<FinishQty>,
}

/// Raumnummern natürlich vergleichen („1.2" vor „1.10").
fn natural_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    let split = |s: &str| -> Vec<(bool, String)> {
        let mut out: Vec<(bool, String)> = Vec::new();
        for ch in s.chars() {
            let d = ch.is_ascii_digit();
            match out.last_mut() {
                Some((k, t)) if *k == d => t.push(ch),
                _ => out.push((d, ch.to_string())),
            }
        }
        out
    };
    let (x, y) = (split(a), split(b));
    for (p, q) in x.iter().zip(y.iter()) {
        let o = match (p.0, q.0) {
            (true, true) => p.1.trim_start_matches('0').len().cmp(&q.1.trim_start_matches('0').len()).then_with(|| p.1.trim_start_matches('0').cmp(q.1.trim_start_matches('0'))),
            _ => p.1.cmp(&q.1),
        };
        if o != std::cmp::Ordering::Equal {
            return o;
        }
    }
    x.len().cmp(&y.len())
}

/// Raumbuch des Projekts: Zeilen je Geschoss (Ebenen-Reihenfolge), dann nach Raumnummer (natürlich,
/// Räume ohne Nummer in Dokumentreihenfolge danach); dazu die Mengen je Oberfläche und Material.
pub fn room_book(p: &Project) -> RoomBook {
    let mut rows = Vec::new();
    let mut roofs: Vec<RoofPlanes> = Vec::new();
    for r in p.rooms.as_deref().unwrap_or(&[]) {
        if r.boundary.len() < 3 {
            continue;
        }
        let ev = crate::ring_arc::evaluate(&r.boundary, r.boundary_bulge.as_deref(), 0.0);
        let area = if ev.net.is_finite() { ev.net } else { 0.0 };
        let perimeter = if ev.perimeter.is_finite() { ev.perimeter } else { 0.0 };
        let h = clear_height(p, r);
        let open = opening_area(p, r);
        if !roofs.iter().any(|x| x.floor_id == r.floor_id) {
            roofs.push(roof_planes(p, &r.floor_id));
        }
        let hb = height_bands(p, r, roofs.iter().find(|x| x.floor_id == r.floor_id).unwrap(), area);
        let sides = wall_sides(p, r, h, roofs.iter().find(|x| x.floor_id == r.floor_id));
        let number = r.stamp.as_ref().and_then(|s| s.number.as_deref()).map(str::trim).unwrap_or("").to_string();
        rows.push(RoomBookRow {
            id: r.id.clone(),
            floor: level_of(p, &r.floor_id).map_or(r.floor_id.clone(), |l| l.name.clone()),
            floor_id: r.floor_id.clone(),
            number,
            name: r.name.clone(),
            area,
            perimeter,
            clear_height: h,
            height_min: hb.min,
            height_mean: hb.mean,
            area_under_1: hb.area_low,
            area_1_to_15: hb.area_mid,
            area_over_15: hb.area_full,
            usage: r.usage.map(|u| u.key().to_string()).unwrap_or_default(),
            wet: is_wet(r),
            floor_finish: finish_label(p, r.floor_finish.as_deref()),
            wall_finish: finish_label(p, r.wall_finish.as_deref()),
            ceiling_finish: finish_label(p, r.ceiling_finish.as_deref()),
            floor_build_up: r.floor_build_up.as_deref().map(str::trim).unwrap_or("").to_string(),
            wall_area: sides.iter().map(|s| s.area).sum(),
            opening_area: open,
            reveal_area: sides.iter().map(|s| s.reveals).sum(),
            skirting: skirting_length(p, r, perimeter),
            wall_sides: sides,
        });
    }
    let level_index = |id: &str| p.drawing_levels.iter().position(|l| l.id == id).unwrap_or(usize::MAX);
    rows.sort_by(|a, b| {
        level_index(&a.floor_id).cmp(&level_index(&b.floor_id)).then_with(|| match (a.number.is_empty(), b.number.is_empty()) {
            (false, false) => natural_cmp(&a.number, &b.number),
            (true, false) => std::cmp::Ordering::Greater,
            (false, true) => std::cmp::Ordering::Less,
            (true, true) => std::cmp::Ordering::Equal,
        })
    });
    let mut quantities: Vec<FinishQty> = Vec::new();
    for surface in ["floor", "wall", "ceiling"] {
        for r in &rows {
            let (finish, area) = match surface {
                "floor" => (&r.floor_finish, r.area),
                "wall" => (&r.wall_finish, r.wall_area),
                _ => (&r.ceiling_finish, r.area),
            };
            if finish.is_empty() {
                continue;
            }
            match quantities.iter_mut().find(|q| q.surface == surface && &q.finish == finish) {
                Some(q) => {
                    q.area += area;
                    q.rooms += 1;
                }
                None => quantities.push(FinishQty { surface, finish: finish.clone(), area, rooms: 1 }),
            }
        }
    }
    RoomBook { rows, quantities }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(x: f64, y: f64) -> Vec2 {
        Vec2 { x, y }
    }

    /// Wohnen 0.15..2.85 × 0.15..3.85 (2.7 × 3.7), Bad 3.15..5.85 × 0.15..2.15 (2.7 × 2.0), Innenwand x = 3
    /// mit Tür 0.9 × 2.1 zwischen beiden; Südwand mit Fenster 1.2 × 1.4 am Wohnen. Geschoss 2.8 m.
    fn sample() -> Project {
        let wall = |id: &str, a: Vec2, b: Vec2| Wall { id: id.into(), floor_id: "eg".into(), start: a, end: b, wall_type_id: "wt".into(), height: 2.8, ..Default::default() };
        let room = |id: &str, name: &str, pts: Vec<Vec2>| Room { id: id.into(), floor_id: "eg".into(), name: name.into(), boundary: pts, ..Default::default() };
        Project {
            drawing_levels: vec![DrawingLevel { id: "eg".into(), name: "EG".into(), floor_height: Some(2.8), ..Default::default() }],
            wall_types: vec![WallType { id: "wt".into(), name: "W".into(), layers: vec![Layer { thickness: 0.3, ..Default::default() }], ..Default::default() }],
            components: vec![Component { id: "parkett".into(), name: "Parkett Eiche".into(), ..Default::default() }, Component { id: "fliese".into(), name: "Feinsteinzeug".into(), ..Default::default() }],
            walls: vec![wall("s", v(0.0, 0.0), v(6.0, 0.0)), wall("m", v(3.0, 0.0), v(3.0, 4.0))],
            rooms: Some(vec![
                Room { floor_finish: Some("parkett".into()), wall_finish: Some("Abrieb 1 mm, weiss".into()), ceiling_finish: Some("Weissputz".into()), usage: Some(RoomUsage::Living), stamp: Some(RoomStamp { number: Some("1.10".into()), name: "Wohnen".into(), ..Default::default() }), ..room("r1", "Wohnen", vec![v(0.15, 0.15), v(2.85, 0.15), v(2.85, 3.85), v(0.15, 3.85)]) },
                Room { floor_finish: Some("fliese".into()), wall_finish: Some("fliese".into()), ceiling_finish: Some("Weissputz".into()), usage: Some(RoomUsage::Bath), stamp: Some(RoomStamp { number: Some("1.2".into()), name: "Nasszelle".into(), ..Default::default() }), ..room("r2", "Nasszelle", vec![v(3.15, 0.15), v(5.85, 0.15), v(5.85, 2.15), v(3.15, 2.15)]) },
            ]),
            openings: Some(vec![
                Opening { id: "t1".into(), host_wall_id: "m".into(), kind: ElementKind::Door, position: 1.0, width: 0.9, height: 2.1, ..Default::default() },
                Opening { id: "f1".into(), host_wall_id: "s".into(), kind: ElementKind::Window, position: 1.0, width: 1.2, height: 1.4, sill_height: 0.9, ..Default::default() },
            ]),
            ..Default::default()
        }
    }

    #[test]
    fn modell_rundreise_und_alte_daten() {
        let p = sample();
        let j = serde_json::to_value(&p.rooms.as_ref().unwrap()[1]).unwrap();
        assert_eq!(j["usage"], "bath");
        assert_eq!(j["floorFinish"], "fliese");
        let back: Room = serde_json::from_value(j).unwrap();
        assert_eq!(back, p.rooms.as_ref().unwrap()[1]);
        // Ohne Felder: nichts geschrieben (Alt-Daten unverändert).
        let plain = serde_json::to_value(Room { id: "x".into(), ..Default::default() }).unwrap();
        for k in ["usage", "floorFinish", "wallFinish", "ceilingFinish", "floorBuildUp"] {
            assert!(plain.get(k).is_none(), "{k}");
        }
        // Unbekannte Nutzung bricht das Laden nicht.
        let r: Room = serde_json::from_value(serde_json::json!({"id": "y", "usage": "sauna"})).unwrap();
        assert_eq!(r.usage, Some(RoomUsage::Unknown));
    }

    #[test]
    fn nassraum_aus_nutzung_sonst_name() {
        let mut r = Room { name: "Nasszelle".into(), usage: Some(RoomUsage::Storage), ..Default::default() };
        assert!(!is_wet(&r), "Nutzung geht vor dem Namen");
        r.usage = Some(RoomUsage::Shower);
        r.name = "Raum 3".into();
        assert!(is_wet(&r));
        r.usage = None;
        assert!(!is_wet(&r));
        r.name = "Bad/WC".into();
        assert!(is_wet(&r), "Rückfall Name");
        for u in RoomUsage::ALL {
            assert_eq!(RoomUsage::from_key(u.key()), Some(u));
        }
    }

    #[test]
    fn zeilen_und_reihenfolge() {
        let b = room_book(&sample());
        let ids: Vec<&str> = b.rows.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids, vec!["r2", "r1"], "1.2 vor 1.10");
        let w = b.rows.iter().find(|r| r.id == "r1").unwrap();
        assert_eq!((w.floor.as_str(), w.number.as_str(), w.usage.as_str(), w.wet), ("EG", "1.10", "living", false));
        assert_eq!((w.floor_finish.as_str(), w.wall_finish.as_str(), w.ceiling_finish.as_str()), ("Parkett Eiche", "Abrieb 1 mm, weiss", "Weissputz"));
        let bad = b.rows.iter().find(|r| r.id == "r2").unwrap();
        assert!(bad.wet);
        assert_eq!(bad.floor_finish, "Feinsteinzeug");
    }

    #[test]
    fn mengen_boden_wand_decke() {
        let b = room_book(&sample());
        let w = b.rows.iter().find(|r| r.id == "r1").unwrap();
        assert!((w.area - 2.7 * 3.7).abs() < 1e-9);
        assert!((w.clear_height - 2.8).abs() < 1e-9);
        // Wohnen: Tür 0.9 × 2.1 und Fenster 1.2 × 1.4.
        assert!((w.opening_area - (0.9 * 2.1 + 1.2 * 1.4)).abs() < 1e-9, "{}", w.opening_area);
        assert!((w.wall_area - (2.0 * (2.7 + 3.7) * 2.8 - 0.9 * 2.1 - 1.2 * 1.4)).abs() < 1e-9);
        let bad = b.rows.iter().find(|r| r.id == "r2").unwrap();
        assert!((bad.wall_area - (2.0 * (2.7 + 2.0) * 2.8 - 0.9 * 2.1)).abs() < 1e-9, "{}", bad.wall_area);
        let q = |s: &str, f: &str| b.quantities.iter().find(|q| q.surface == s && q.finish == f).map(|q| (q.area, q.rooms));
        let (a, n) = q("floor", "Parkett Eiche").unwrap();
        assert!((a - 2.7 * 3.7).abs() < 1e-9 && n == 1);
        let (a, n) = q("ceiling", "Weissputz").unwrap();
        assert!((a - (2.7 * 3.7 + 2.7 * 2.0)).abs() < 1e-9 && n == 2);
        let (a, _) = q("wall", "Feinsteinzeug").unwrap();
        assert!((a - bad.wall_area).abs() < 1e-9);
        assert!(q("floor", "").is_none());
    }

    #[test]
    fn lichte_hoehe_aus_decken() {
        let mut p = sample();
        // Decke unter dem Raum (OK 0.0 + Belag 0.1 über Boden) und darüber (UK 2.6).
        let ce = |id: &str, bottom: f64, top: f64| -> Ceiling {
            serde_json::from_value(serde_json::json!({ "id": id, "type": "ceiling", "floorId": "eg", "categoryCode": "50",
                "outline": [{"x": 0, "y": 0}, {"x": 6, "y": 0}, {"x": 6, "y": 4}, {"x": 0, "y": 4}],
                "bottom": {"mode": "custom", "z": bottom}, "top": {"mode": "custom", "z": top} })).unwrap()
        };
        p.ceilings = Some(vec![ce("unten", -0.25, 0.1), ce("oben", 2.6, 2.8)]);
        let r = &p.rooms.as_ref().unwrap()[0];
        assert_eq!(p.ceiling_vertical_extent(&p.ceilings.as_ref().unwrap()[0]), (-0.25, 0.1));
        assert!((clear_height(&p, r) - 2.5).abs() < 1e-9, "{}", clear_height(&p, r));
        assert!(clear_height(&Project::default(), &Room::default()) > 0.0);
    }

    fn roof_project(base: Option<f64>) -> Project {
        let sq = vec![v(0.0, 0.0), v(4.0, 0.0), v(4.0, 4.0), v(0.0, 4.0)];
        let roof: Roof = serde_json::from_value(serde_json::json!({ "id": "d", "type": "roof", "floorId": "dg", "categoryCode": "50",
            "outline": [{"x": 0, "y": 0}, {"x": 4, "y": 0}, {"x": 4, "y": 4}, {"x": 0, "y": 4}],
            "shape": "sattel", "pitchDeg": 45.0, "thickness": 0.0, "baseElevation": base })).unwrap();
        Project {
            drawing_levels: vec![DrawingLevel { id: "dg".into(), name: "DG".into(), floor_height: Some(3.0), ..Default::default() }],
            roofs: Some(vec![roof]),
            rooms: Some(vec![Room { id: "k".into(), floor_id: "dg".into(), name: "Studio".into(), boundary: sq, ..Default::default() }]),
            ..Default::default()
        }
    }

    #[test]
    fn hoehenbereiche_unter_dachschraege() {
        // Traufe auf Bodenhöhe, 45°: Höhe = Abstand zur nächsten Traufe (0..2 m), First 2 m.
        let b = room_book(&roof_project(Some(0.0)));
        let r = &b.rows[0];
        assert!((r.area - 16.0).abs() < 1e-6);
        assert!((r.clear_height - 3.0).abs() < 1e-9, "lichte Höhe bleibt das Geschossmass");
        assert!(r.height_min < 0.1, "{}", r.height_min);
        assert!((r.height_mean - 1.0).abs() < 0.05, "{}", r.height_mean);
        // < 1.0: je 1 m Streifen an den Traufen (8 m²), 1.0–1.5: 4 m², ≥ 1.5: 4 m².
        assert!((r.area_under_1 - 8.0).abs() < 0.3, "{}", r.area_under_1);
        assert!((r.area_1_to_15 - 4.0).abs() < 0.3, "{}", r.area_1_to_15);
        assert!((r.area_over_15 - 4.0).abs() < 0.3, "{}", r.area_over_15);
        assert!((r.area_under_1 + r.area_1_to_15 + r.area_over_15 - r.area).abs() < 1e-6);
    }

    #[test]
    fn ohne_dachschraege_gilt_die_lichte_hoehe() {
        // Traufe auf Geschossoberkante (3.0 m): der Raum steht voll unter dem Dach.
        let b = room_book(&roof_project(None));
        let r = &b.rows[0];
        assert!((r.height_min - 3.0).abs() < 0.05 && (r.height_mean - 3.0).abs() < 0.2, "{} {}", r.height_min, r.height_mean);
        assert!(r.area_under_1 < 1e-9 && r.area_1_to_15 < 1e-9);
        // Eben, ohne Dach: Höhe überall gleich.
        let s = room_book(&sample());
        assert!((s.rows[0].height_min - 2.8).abs() < 1e-9 && (s.rows[0].area_over_15 - s.rows[0].area).abs() < 1e-9);
    }

    #[test]
    fn wandseiten_leibungen_sockel() {
        let b = room_book(&sample());
        let w = b.rows.iter().find(|r| r.id == "r1").unwrap();
        let side = |id: &str| w.wall_sides.iter().find(|s| s.wall_id == id).unwrap();
        // Südwand: 2.7 m mit Fenster, Innenwand: 3.7 m mit Tür.
        let s = side("s");
        assert!((s.length - 2.7).abs() < 1e-9 && (s.openings - 1.2 * 1.4).abs() < 1e-9);
        assert!((s.area - (2.7 * 2.8 - 1.2 * 1.4)).abs() < 1e-9);
        assert!((s.reveals - 2.0 * (1.2 + 1.4) * 0.3).abs() < 1e-9, "{}", s.reveals);
        let m = side("m");
        assert!((m.length - 3.7).abs() < 1e-9 && (m.openings - 0.9 * 2.1).abs() < 1e-9);
        assert!((m.reveals - (2.0 * 2.1 + 0.9) * 0.3).abs() < 1e-9, "{}", m.reveals);
        // Kanten ohne Wand (West, Nord) in einem Eintrag; alle Längen zusammen = Umfang.
        assert!((side("").length - (3.7 + 2.7)).abs() < 1e-9);
        assert!((w.wall_sides.iter().map(|s| s.length).sum::<f64>() - w.perimeter).abs() < 1e-9);
        assert!((w.wall_sides.iter().map(|s| s.area).sum::<f64>() - w.wall_area).abs() < 1e-9);
        assert!((w.reveal_area - (s.reveals + m.reveals)).abs() < 1e-9);
        // Sockel: Umfang − Türbreite (Fenster zählen nicht).
        assert!((w.skirting - (2.0 * (2.7 + 3.7) - 0.9)).abs() < 1e-9);
        let bad = b.rows.iter().find(|r| r.id == "r2").unwrap();
        assert!((bad.skirting - (2.0 * (2.7 + 2.0) - 0.9)).abs() < 1e-9);
    }

    #[test]
    fn wandflaeche_unter_schraege_mittlere_hoehe() {
        let mut p = roof_project(Some(0.0));
        p.wall_types = vec![WallType { id: "wt".into(), name: "W".into(), layers: vec![Layer { thickness: 0.3, ..Default::default() }], ..Default::default() }];
        let wall = |id: &str, a: Vec2, b: Vec2| Wall { id: id.into(), floor_id: "dg".into(), start: a, end: b, wall_type_id: "wt".into(), height: 3.0, ..Default::default() };
        p.walls = vec![wall("s", v(-1.0, -0.15), v(5.0, -0.15)), wall("w", v(-0.15, -1.0), v(-0.15, 5.0))];
        let r = &room_book(&p).rows[0];
        let full = 3.0;
        // Beide Wandseiten laufen quer bzw. längs zum First: mindestens eine liegt klar unter der vollen Höhe.
        let gross: f64 = r.wall_sides.iter().map(|s| s.gross).sum();
        assert!(gross < r.perimeter * full - 2.0, "{} < {}", gross, r.perimeter * full);
        for s in r.wall_sides.iter().filter(|s| !s.wall_id.is_empty()) {
            assert!(s.gross <= s.length * full + 1e-9 && s.gross > 0.0 || s.gross.abs() < 0.2, "{s:?}");
        }
        assert!((r.wall_sides.iter().map(|s| s.area).sum::<f64>() - r.wall_area).abs() < 1e-9);
        assert!(r.wall_area < r.perimeter * full - 2.0);
    }

    #[test]
    fn leeres_projekt_und_unsinn() {
        assert!(room_book(&Project::default()).rows.is_empty());
        let mut p = sample();
        p.rooms.as_mut().unwrap()[0].boundary = vec![v(f64::NAN, 0.0), v(1.0, f64::INFINITY), v(0.0, 1.0)];
        let b = room_book(&p);
        assert!(b.rows.iter().all(|r| r.area.is_finite() && r.wall_area.is_finite()));
    }

    #[test]
    fn natuerliche_nummern() {
        use std::cmp::Ordering::*;
        assert_eq!(natural_cmp("1.2", "1.10"), Less);
        assert_eq!(natural_cmp("E01", "E1"), Equal);
        assert_eq!(natural_cmp("2.01", "10.01"), Less);
    }
}
