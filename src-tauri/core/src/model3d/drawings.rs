//! 2D-Zeichnungen im 3D als Boden-Spuren: Linien-Ecken in Chargen (`drawing_line_verts()`, angehoben je
//! Geschoss für die Explosionsansicht) und Segmente fürs Picken. Aufgerufen von `explode3d.rs` und der
//! Pick-Geometrie (`pick.rs`).

use super::*;

/// Doppelte je Charge an `drawing2d_3d` — begrenzt den Speicher bei Kataster-Importen.
const CHUNK_DOUBLES: usize = 1 << 18;
pub(super) const DRAWING_LINE_ELEVATION_EPS: f64 = 0.01;
pub(super) const DRAWING_PICK_TOLERANCE: f64 = 0.12;

/// Linienfarbe einer Zeichnung: color → Linienstil → Kategorie (`drawingColor3d`).
fn drawing_color(
    d: &Drawing2D,
    by_category: &HashMap<&str, &str>,
    by_line_style: &HashMap<&str, &str>,
) -> Rgb {
    let fb = style::DRAWING_LINE_FALLBACK_RGB;
    if let Some(c) = d.color.as_deref().filter(|c| !c.is_empty()) {
        return hex_to_rgb(c, fb);
    }
    if let Some(c) = d.line_style_id.as_deref().and_then(|id| by_line_style.get(id)) {
        return hex_to_rgb(c, fb);
    }
    by_category.get(d.category_code.as_str()).map_or(fb, |c| hex_to_rgb(c, fb))
}

/// Packt die darstellbaren Zeichnungen (Linie, Polylinie, Rechteck) in Chargen für `drawing2d_3d`.
/// `lift`: zusätzliche Höhe je Geschoss-id (Explosionsaxonometrie [65], `explode3d.rs`; leer = keine).
fn for_each_drawing_chunk(p: &Project, with_color: bool, lift: &HashMap<String, f64>, mut f: impl FnMut(&[f64], &[&Drawing2D])) {
    if p.drawings2d.is_empty() {
        return;
    }
    let cats = p.flat_categories();
    let by_category: HashMap<&str, &str> = cats.iter().filter(|c| !c.color.is_empty()).map(|c| (c.code.as_str(), c.color.as_str())).collect();
    let by_line_style: HashMap<&str, &str> = p.line_styles.iter().filter(|l| !l.color.is_empty()).map(|l| (l.id.as_str(), l.color.as_str())).collect();
    let mut elevations: HashMap<&str, f64> = HashMap::new();
    let mut buf: Vec<f64> = vec![0.0];
    let mut ids: Vec<&Drawing2D> = Vec::new();
    let flush = |buf: &mut Vec<f64>, ids: &mut Vec<&Drawing2D>, f: &mut dyn FnMut(&[f64], &[&Drawing2D])| {
        if ids.is_empty() {
            return;
        }
        buf[0] = ids.len() as f64;
        f(buf, ids);
        ids.clear();
        buf.truncate(1);
    };
    for d in &p.drawings2d {
        // Teile einer Zeichnung: (Art, Punkte); ein Achsraster mit `show3d` liefert je Achse eines.
        let parts: Vec<(f64, Vec<Vec2>)> = match &d.geom {
            Drawing2DGeom::Line { a, b } => vec![(1.0, vec![*a, *b])],
            Drawing2DGeom::Rect { min, max } => vec![(3.0, vec![*min, *max])],
            Drawing2DGeom::Polyline { pts, .. } => vec![(2.0, pts.clone())],
            Drawing2DGeom::Grid { show_3d: Some(true), .. } => crate::grid::Spec::of(&d.geom).map(|s| crate::grid::polylines_3d(&s)).unwrap_or_default().into_iter().map(|q| (2.0, q.into_iter().map(|(x, y)| Vec2 { x, y }).collect())).collect(),
            _ => continue,
        };
        let closed = matches!(&d.geom, Drawing2DGeom::Polyline { closed: true, .. });
        let elev = *elevations.entry(d.level_id.as_str()).or_insert_with(|| p.floor(&d.level_id).map_or(0.0, |l| l.base_elevation.unwrap_or(0.0)) + DRAWING_LINE_ELEVATION_EPS + lift.get(d.level_id.as_str()).copied().unwrap_or(0.0));
        let rgb = if with_color { drawing_color(d, &by_category, &by_line_style) } else { [0.0; 3] };
        for (kind, pts) in parts {
            let need = 7 + 2 * pts.len();
            if buf.len() + need > CHUNK_DOUBLES {
                flush(&mut buf, &mut ids, &mut f);
            }
            buf.extend([kind, elev, rgb[0], rgb[1], rgb[2], if closed { 1.0 } else { 0.0 }, pts.len() as f64]);
            for q in &pts {
                buf.extend([q.x, q.y]);
            }
            ids.push(d);
        }
    }
    flush(&mut buf, &mut ids, &mut f);
}

/// Boden-Spuren aller Zeichnungen als LineList-Vertices `[px, py, pz, r, g, b]` (`emitDrawingLineVerts`).
pub fn drawing_line_verts(p: &Project) -> Vec<f32> {
    drawing_line_verts_lifted(p, &HashMap::new())
}

/// Wie [`drawing_line_verts`], jede Spur um `lift[level_id]` angehoben (Explosion [65]).
pub fn drawing_line_verts_lifted(p: &Project, lift: &HashMap<String, f64>) -> Vec<f32> {
    let mut out = Vec::new();
    for_each_drawing_chunk(p, true, lift, |buf, _| out.extend(crate::drawing2d_3d::line_verts(buf)));
    out
}

/// Pick-Strecke einer Zeichnung (`PickDrawingSeg`).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickDrawingSeg {
    pub start: [f64; 2],
    pub end: [f64; 2],
    pub base_elevation: f64,
    pub drawing_id: String,
}

pub(crate) fn pick_drawing_segs(p: &Project, lift: &HashMap<String, f64>) -> Vec<PickDrawingSeg> {
    let mut out = Vec::new();
    for_each_drawing_chunk(p, false, lift, |buf, drawings| {
        let f = crate::drawing2d_3d::pick_segs(buf, DRAWING_PICK_TOLERANCE);
        for c in f.chunks_exact(6) {
            out.push(PickDrawingSeg { start: [c[0], c[1]], end: [c[2], c[3]], base_elevation: c[4], drawing_id: drawings[c[5] as usize].id.clone() });
        }
    });
    out
}
