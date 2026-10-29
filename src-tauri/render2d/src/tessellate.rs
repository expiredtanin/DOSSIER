// Tessellierung: wandelt Szenen-Primitive in GPU-fertige Vertex-/Index-Puffer.
//  - Polygone -> echtes Ear-Clipping (konkav-faehig), Bildschirm-Raum-Dreiecke
//  - Linien   -> Quad mit Normale + Seiten-Flag (Breite spaeter im Shader)
//
// 1:1-Port von `src/plan/glPlan/glPlanCompile.ts`. Koordinaten: alles wird in
// BILDSCHIRM-Raum abgelegt (wie `to_screen`):
//   sx = mx * PX_PER_M,  sy = -my * PX_PER_M.
// Damit ist die Projektion eine reine viewBox-Orthografie (siehe `ortho`).
//
// WARUM Ear-Clipping selbst portiert (statt earcutr/lyon):
//  - Die Plan-Polygone haben wenige Ecken; O(n^2)-Ear-Clipping ist reichlich
//    schnell und exakt der bereits verifizierte Web-Algorithmus (gleiche Tests).
//  - Keine externe Abhaengigkeit -> die Tessellierungs-Bibliothek bleibt
//    serde-only und headless testbar (entscheidend fuer die saubere Trennung
//    vom GPU-Teil). earcutr/lyon zoegen zusaetzliche Crates in genau die
//    Schicht, die ohne Display gruen bleiben muss.
//  - Ergebnis ist byte-fuer-byte-vergleichbar mit dem WebGL-Referenzpfad.

use crate::types::{Arc, FillPolygon, Line, Point, Rgba, Scene};

/// viewBox-Einheiten je Meter (identisch zu PlanView/toScreen im Web-Pfad).
pub const PX_PER_M: f32 = 90.0;

/// Modell-Meter -> Bildschirm-Raum (identisch zu `toScreen`).
#[inline]
pub fn to_screen(p: Point) -> Point {
    [p[0] * PX_PER_M, -p[1] * PX_PER_M]
}

/// Hoechstzahl Dash-Muster-Eintraege je Bogen (An/Aus-Laengen), die der analytische
/// Bogen-Shader modulo rechnet. Deckt die real vorkommenden Muster (max. EIN An/Aus-
/// Paar, z.B. Tuerschwenk [0.06,0.04]) mit Reserve; laengere Muster werden gekappt.
pub const MAX_ARC_DASH: usize = 4;

/// GPU-fertige Beschreibung EINES analytisch (im Fragment-Shader) gezeichneten
/// Bogens — bereits in BILDSCHIRM-Raum-Parametern, damit ihn die GPU pro Frame
/// mathematisch exakt rund rendert (SDF), ohne Segment-Tessellierung. Alle Felder
/// sind zoom-INVARIANT (haengen nicht von der aktuellen Skala ab): `center`/
/// `r_screen` in Bildschirm-Einheiten, Winkel im Bildschirm-Raum, `dash` in
/// Modell-Metern. Die Strichbreite (`width_mm`) mappt der Shader pro Frame mit
/// derselben Formel wie die Linien (`ortho::mm_to_device_px`) auf Geraete-px.
#[derive(Debug, Clone)]
pub struct ArcInstanceData {
    /// Mittelpunkt in Bildschirm-Raum-Einheiten (`to_screen(center)`).
    pub center: Point,
    /// Radius in Bildschirm-Raum-Einheiten (`r * PX_PER_M`).
    pub r_screen: f32,
    /// Radius in MODELL-Metern (fuer die Dash-Bogenlaenge).
    pub r_model: f32,
    /// Start-Winkel im Bildschirm-Raum (atan2 relativ `center`).
    pub a0: f32,
    /// Vorzeichenbehafteter Sweep (kuerzerer Bogen, |sweep| <= pi).
    pub sweep: f32,
    /// Strichfarbe (RGBA 0..1).
    pub color: Rgba,
    /// Strichbreite in echten Papier-Millimetern.
    pub width_mm: f32,
    /// Dash-Zyklus in MODELL-Metern (An/Aus-Laengen), ggf. verdoppelt bei ungerader
    /// Laenge (Standard-Dash-Semantik, wie `split_dash`). Nur `dash_count` gueltig.
    pub dash: [f32; MAX_ARC_DASH],
    /// Anzahl gueltiger `dash`-Eintraege; 0 = durchgezogen.
    pub dash_count: u32,
    /// Summe der gueltigen `dash`-Eintraege (Zykluslaenge, Modell-Meter).
    pub dash_total: f32,
}

/// Hoechstzahl Eintraege eines Linien-Strichmusters (nach Verdoppeln ungerader Muster), die der
/// Strich-Shader (`DASH_LINE_WGSL`) rechnet; laengere Muster zerlegt die CPU wie frueher.
pub const MAX_LINE_DASH: usize = 8;

/// EIN Segment eines gestrichelten Linienzugs fuer die Strich-Pipeline (eine Instanz, das Quad
/// spannt der Vertex-Shader auf). Statt den Zug entlang des Musters in Hunderte Teilstuecke mit
/// runden Kappen zu zerlegen (`split_dash`: bei verdeckten Kanten grosser Schnitte zig Millionen
/// Vertices, > 256 MB Puffer), traegt jedes Segment seine Lauflaenge; der Fragment-Shader setzt
/// Striche, Luecken und runde Strich-Enden je Pixel (gleiche Semantik, s. [`dash_coverage`]).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DashSegment {
    /// Segment-Anfang/-Ende in Bildschirm-Raum (`to_screen`).
    pub a: Point,
    pub b: Point,
    /// Lauflaenge des Zugs bei `a` (Bildschirm-Einheiten, Phase laeuft ueber Ecken durch).
    pub s0: f32,
    /// Laenge des ganzen Zugs (Bildschirm-Einheiten): hinter dem Ende beginnt kein Strich mehr.
    pub run_len: f32,
    /// Zykluslaenge (Bildschirm-Einheiten).
    pub total: f32,
    /// Gueltige Eintraege in `dash` (gerade Indizes = Strich, ungerade = Luecke).
    pub count: u32,
    /// An/Aus-Laengen (Bildschirm-Einheiten).
    pub dash: [f32; MAX_LINE_DASH],
}

/// Ein Batch gestrichelter Segmente (Instanz-Bereich) mit Farbe + Strichbreite.
#[derive(Debug, Clone)]
pub struct DashBatch {
    pub start: u32,
    pub count: u32,
    pub color: Rgba,
    pub stroke_mm: f32,
    pub width_screen: bool,
}

/// Strichmuster (Papier-mm) → Zyklus in Modell-Metern: negative Werte zu 0, ungerade Laenge verdoppelt.
/// Nullen bleiben stehen ([96]): ein AN-Wert 0 ist ein PUNKT (der Shader zeichnet ihn mit runden
/// Enden, wie SVG mit `stroke-linecap: round`); frueher fielen sie weg und verschoben AN/AUS (eine
/// Strichpunktlinie wurde zur Strichlinie mit ungleichen Luecken). `None` = kein gueltiges Muster.
fn dash_cycle_m(dash: &[f32]) -> Option<Vec<f32>> {
    let pat: Vec<f32> = dash.iter().copied().map(|d| if d.is_finite() { d.max(0.0) * DASH_MM_TO_M } else { 0.0 }).collect();
    if pat.iter().all(|d| *d <= 0.0) {
        return None;
    }
    let cycle: Vec<f32> = if pat.len() % 2 == 0 { pat } else { [pat.as_slice(), pat.as_slice()].concat() };
    let total: f32 = cycle.iter().sum();
    (total > 1e-9).then_some(cycle)
}

/// Deckung eines Pixels durch einen gestrichelten Zug — CPU-Spiegel des Fragment-Shaders
/// (`DASH_LINE_WGSL`, gleiche Rechenschritte), fuer Tests. Alles in Geraete-px: `s` Lauflaenge
/// des Pixels (auch vor/hinter dem Segment, im Kappen-Bereich), `y` Abstand quer zur Achse,
/// `seg` = (Anfang, Ende des Segments, Laenge des Zugs, halbe Strichbreite), `total`/`cyc` das
/// Muster. Liefert den Abstand zum naechsten Strich (0 = auf einem Strich), den der Shader mit
/// der halben Breite vergleicht (runde Strich-Enden wie die frueheren Rund-Kappen).
pub fn dash_coverage(s: f32, y: f32, seg: [f32; 4], total: f32, cyc: &[f32]) -> f32 {
    let sc = s.clamp(seg[0], seg[1]);
    let e_out = (s - sc).abs();
    let mut e_in = 0.0f32;
    if !cyc.is_empty() && total > 1e-6 {
        let k = (sc / total).floor();
        let m = sc - k * total;
        let mut acc = 0.0f32;
        let mut on = true;
        let mut prev_end = 0.0f32;
        let mut next_start = 0.0f32;
        for (i, &d) in cyc.iter().enumerate() {
            if m >= acc && m < acc + d {
                on = i % 2 == 0;
                prev_end = acc;
                next_start = acc + d;
            }
            acc += d;
        }
        if !on {
            let base = k * total;
            let pe = sc - (base + prev_end);
            let ne = if base + next_start > seg[2] { f32::INFINITY } else { base + next_start - sc };
            e_in = pe.min(ne).max(0.0);
        }
    }
    let e = e_in + e_out;
    (e * e + y * y).sqrt()
}

/// Bildschirm-Raum-Parameter eines Bogens: Mittelpunkt + Radius (Bildschirm-
/// Einheiten) sowie Start- und Sweep-Winkel IM BILDSCHIRM-RAUM. Der Sweep ist der
/// KUERZERE Bogen (|sweep| <= pi) — exakt die Winkel-Normalisierung der frueheren
/// `tessellate_arc` (dort im Modell-Raum). Die Bildschirm-Y-Spiegelung (`to_screen`)
/// negiert lediglich beide Winkel; der BETRAG von `sweep` bleibt identisch, sodass
/// weiterhin derselbe (kuerzere) Bogen entsteht.
pub fn arc_screen_params(center: Point, from: Point, to: Point, r: f32) -> (Point, f32, f32, f32) {
    let cs = to_screen(center);
    let fs = to_screen(from);
    let ts = to_screen(to);
    let a0 = (fs[1] - cs[1]).atan2(fs[0] - cs[0]);
    let a1 = (ts[1] - cs[1]).atan2(ts[0] - cs[0]);
    let mut delta = a1 - a0;
    while delta > std::f32::consts::PI {
        delta -= 2.0 * std::f32::consts::PI;
    }
    while delta < -std::f32::consts::PI {
        delta += 2.0 * std::f32::consts::PI;
    }
    (cs, r * PX_PER_M, a0, delta)
}

/// Wandelt ein Papier-mm-Dash-Muster in den Modell-Meter-Zyklus, den der Bogen-
/// Shader modulo rechnet — IDENTISCHE Semantik zu `split_dash` (`DASH_MM_TO_M`-
/// Referenz, Verdopplung bei ungerader Musterlaenge). Auf `MAX_ARC_DASH` Eintraege
/// begrenzt; laengere Muster (kommen real nicht vor) werden gekappt. Rueckgabe:
/// (Zyklus, Anzahl, Gesamtlaenge); Anzahl 0 = durchgezogen.
pub fn prepare_arc_dash(dash: Option<&[f32]>) -> ([f32; MAX_ARC_DASH], u32, f32) {
    let mut out = [0.0f32; MAX_ARC_DASH];
    let Some(d) = dash else {
        return (out, 0, 0.0);
    };
    let pat: Vec<f32> = d
        .iter()
        .copied()
        .map(|v| v.max(0.0) * DASH_MM_TO_M)
        .filter(|v| *v > 0.0)
        .collect();
    if pat.is_empty() {
        return (out, 0, 0.0);
    }
    let cycle: Vec<f32> = if pat.len() % 2 == 0 {
        pat
    } else {
        [pat.as_slice(), pat.as_slice()].concat()
    };
    let n = cycle.len().min(MAX_ARC_DASH);
    let mut total = 0.0f32;
    for (i, v) in cycle.iter().take(n).enumerate() {
        out[i] = *v;
        total += *v;
    }
    (out, n as u32, total)
}

/// Faktor Papier-mm -> Modell-Meter fuer ALLGEMEINE Linien-/Bogen-Striche, bei
/// der Referenz-Skala `paper_scale_n = 100` des Renderers (siehe `gpu::Renderer`
/// und `toRenderScene.ts`s `MM_TO_M`): `N/1000`. Bewusst NICHT die Hatch-
/// spezifische `DASH_MM_TO_M`-Konstante aus `glPlanHatch.ts` (die ist an die
/// Musterkachel gekoppelt, nicht an den Papier-Massstab).
const DASH_MM_TO_M: f32 = 100.0 / 1000.0;

/// Portiert `applyDashRuns` (`src/plan/glPlan/glPlanHatch.ts`) auf Modell-Meter-
/// Punktzuege: zerlegt EINEN zusammenhaengenden Lauf entlang eines Strichmusters
/// (Papier-mm, `DASH_MM_TO_M`-Referenz) in seine durchgezogenen Teilstuecke. Die
/// Phase laeuft ENTLANG DES GESAMTEN LAUFS durch (ueber Stuetzpunkt-Ecken
/// hinweg) — wichtig fuer bereits verkettete Umriss-/Zeichnungszuege UND fuer
/// die neu adaptiv tessellierten Boegen. Ungerade Musterlaenge wird verdoppelt
/// (Standard-Dash-Semantik). Leeres/ungueltiges Muster oder <2 Punkte -> EIN
/// Stueck (unveraendert, durchgezogen).
fn split_dash(pts: &[Point], dash: &[f32]) -> Vec<Vec<Point>> {
    let pat: Vec<f32> = dash
        .iter()
        .copied()
        .map(|d| d.max(0.0) * DASH_MM_TO_M)
        .filter(|d| *d > 0.0)
        .collect();
    if pat.is_empty() || pts.len() < 2 {
        return vec![pts.to_vec()];
    }
    let cycle: Vec<f32> = if pat.len() % 2 == 0 {
        pat.clone()
    } else {
        [pat.as_slice(), pat.as_slice()].concat()
    };
    let total: f32 = cycle.iter().sum();
    if total <= 1e-9 {
        return vec![pts.to_vec()];
    }

    let mut out: Vec<Vec<Point>> = Vec::new();
    let mut idx = 0usize;
    let mut dash_left = cycle[0];
    let mut on = true;
    let mut piece: Option<Vec<Point>> = Some(vec![pts[0]]);

    for w in pts.windows(2) {
        let mut a = w[0];
        let b = w[1];
        let mut seg_len = ((b[0] - a[0]).powi(2) + (b[1] - a[1]).powi(2)).sqrt();
        if seg_len < 1e-12 {
            continue;
        }
        let ux = (b[0] - a[0]) / seg_len;
        let uy = (b[1] - a[1]) / seg_len;
        while seg_len > 1e-9 {
            let step = seg_len.min(dash_left);
            let mid = [a[0] + ux * step, a[1] + uy * step];
            if on {
                if piece.is_none() {
                    piece = Some(vec![a]);
                }
                piece.as_mut().unwrap().push(mid);
            }
            a = mid;
            seg_len -= step;
            dash_left -= step;
            if dash_left <= 1e-9 {
                if on {
                    if let Some(p) = piece.take() {
                        if p.len() >= 2 {
                            out.push(p);
                        }
                    }
                }
                on = !on;
                idx += 1;
                dash_left = cycle[idx % cycle.len()];
                if on {
                    piece = Some(vec![a]);
                }
            }
        }
    }
    if let Some(p) = piece.take() {
        if p.len() >= 2 {
            out.push(p);
        }
    }
    out
}

/// Zeichnet einen Linienzug entweder als EINEN gehrten Streifen (kein/leeres
/// Muster) oder — bei gesetztem `dash` — als seine durchgezogenen Teilstuecke
/// (`split_dash`), je einzeln offen gestrichen. Vereinfachung: ein gestrichelter
/// GESCHLOSSENER Umriss (`closed=true`) wird trotzdem als offene Teilstuecke
/// gezeichnet — der Ring-Schluss braucht bei einer Dash-Luecke ohnehin keine
/// durchgehende Gehrung.
fn stroke_dashed_or_solid(
    geo: &mut GpuGeometry,
    pts: &[Point],
    closed: bool,
    color: Rgba,
    stroke_mm: f32,
    width_screen: bool,
    dash: Option<&[f32]>,
    bounds: &mut Bounds,
) {
    match dash {
        Some(d) if !d.is_empty() => match dash_cycle_m(d) {
            // Strichmuster im Shader: je Segment eine Instanz mit Lauflaenge.
            Some(cycle) if cycle.len() <= MAX_LINE_DASH => geo.stroke_dashed(pts, &cycle, color, stroke_mm, width_screen, bounds),
            // Ungueltiges Muster: ein offener Zug (wie `split_dash` → ein Stueck); sehr lange
            // Muster zerlegt weiter die CPU.
            _ => {
                for piece in split_dash(pts, d) {
                    if piece.len() >= 2 {
                        geo.stroke_polyline(&piece, false, color, stroke_mm, width_screen, bounds);
                    }
                }
            }
        },
        _ => geo.stroke_polyline(pts, closed, color, stroke_mm, width_screen, bounds),
    }
}

/// Signierte Flaeche (Shoelace); >0 = CCW (Modell-Y nach oben).
fn signed_area(pts: &[Point]) -> f32 {
    let mut a = 0.0f32;
    let n = pts.len();
    let mut j = n - 1;
    for i in 0..n {
        a += pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
        j = i;
    }
    a / 2.0
}

/// Kreuzprodukt (b-a) x (c-a).
#[inline]
fn cross(a: Point, b: Point, c: Point) -> f32 {
    (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
}

/// Einheits-Richtung von `from` nach `to` (Bildschirm-Raum); None bei Nulllaenge.
#[inline]
fn unit_dir(from: Point, to: Point) -> Option<Point> {
    let dx = to[0] - from[0];
    let dy = to[1] - from[1];
    let len = (dx * dx + dy * dy).sqrt();
    if len < 1e-9 {
        None
    } else {
        Some([dx / len, dy / len])
    }
}

/// 90-Grad-Linksdrehung einer Einheits-Richtung -> Einheits-Links-Normale.
#[inline]
fn left_normal_of(d: Point) -> Point {
    [-d[1], d[0]]
}

/// Liegt p im (a,b,c)-Dreieck? (CCW-orientiert).
fn point_in_tri(a: Point, b: Point, c: Point, p: Point) -> bool {
    let d1 = cross(a, b, p);
    let d2 = cross(b, c, p);
    let d3 = cross(c, a, p);
    let has_neg = d1 < 0.0 || d2 < 0.0 || d3 < 0.0;
    let has_pos = d1 > 0.0 || d2 > 0.0 || d3 > 0.0;
    !(has_neg && has_pos)
}

/// Ear-Clipping-Triangulierung eines einfachen (lochfreien) Polygons. Robust fuer
/// konvexe UND konkave Ringe. O(n^2) — fuer Plan-Polygone (wenige Ecken) voellig
/// ausreichend. Gibt Dreiecks-Indizes (0-basiert auf `pts`) zurueck; leer bei <3
/// Ecken oder Degeneration.
pub fn triangulate(pts: &[Point]) -> Vec<u32> {
    let n = pts.len();
    if n < 3 {
        return Vec::new();
    }

    // Ohr-Test unten nutzt cross>0 = konvex, was CCW voraussetzt. Bei CW-Polygonen
    // die Index-Reihenfolge umdrehen (Triangulierung ist raum-affin-invariant, die
    // Indizes gelten danach auch fuer die Bildschirm-Raum-Vertices).
    let mut idx: Vec<usize> = (0..n).collect();
    if signed_area(pts) < 0.0 {
        idx.reverse(); // <0 = CW -> auf CCW drehen
    }

    let mut tris: Vec<u32> = Vec::new();
    let mut guard = 0usize;
    let max_guard = n * n + 16;

    while idx.len() > 3 && guard < max_guard {
        guard += 1;
        let mut clipped = false;
        let m = idx.len();
        for i in 0..m {
            let i_prev = idx[(i + m - 1) % m];
            let i_cur = idx[i];
            let i_next = idx[(i + 1) % m];
            let a = pts[i_prev];
            let b = pts[i_cur];
            let c = pts[i_next];

            // Konvexe Ecke? (bei CCW: cross > 0)
            if cross(a, b, c) <= 0.0 {
                continue;
            }

            // Kein anderer Vertex im Ohr?
            let mut contains = false;
            for &vi in &idx {
                if vi == i_prev || vi == i_cur || vi == i_next {
                    continue;
                }
                if point_in_tri(a, b, c, pts[vi]) {
                    contains = true;
                    break;
                }
            }
            if contains {
                continue;
            }

            // Ohr abschneiden.
            tris.push(i_prev as u32);
            tris.push(i_cur as u32);
            tris.push(i_next as u32);
            idx.remove(i);
            clipped = true;
            break;
        }
        if !clipped {
            break; // Degeneriert -> abbrechen (kein Absturz).
        }
    }
    if idx.len() == 3 {
        tris.push(idx[0] as u32);
        tris.push(idx[1] as u32);
        tris.push(idx[2] as u32);
    }
    tris
}

/// Pipeline-Art eines Batches in der Maler-Reihenfolge (`GpuGeometry::draw_sequence`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BatchKind {
    Fill,
    Line,
    /// Gestrichelte Segmente (`GpuGeometry::dash_batches`, Strich-Pipeline).
    Dash,
}

/// Ein zusammenhaengender Zeichen-Batch (Index-Bereich) mit einer Farbe.
#[derive(Debug, Clone)]
pub struct FillBatch {
    pub start_index: u32,
    pub index_count: u32,
    pub color: Rgba,
}

/// Ein Linien-Batch: Index-Bereich mit Farbe + echter Papier-Strichbreite.
#[derive(Debug, Clone)]
pub struct LineBatch {
    pub start_index: u32,
    pub index_count: u32,
    pub color: Rgba,
    /// ECHTE Strichbreite in Papier-Millimeter — bzw. in Bildschirm-Einheiten
    /// (viewBox-px), wenn `width_screen` gesetzt ist (Schraffur-Muster).
    pub stroke_mm: f32,
    /// true: `stroke_mm` traegt Bildschirm-Einheiten (zoom-skalierend); der
    /// Renderer nutzt dann die meet-Skala statt der mm->px-Umrechnung.
    pub width_screen: bool,
}

/// GPU-fertige Geometrie: getrennte Puffer fuer Flaechen (Poche) und Striche.
/// Einmal je Szene tessellieren; danach treibt nur die Projektionsmatrix Pan/Zoom.
#[derive(Debug, Clone, Default)]
pub struct GpuGeometry {
    /// Fuell-Positionen, interleaved [x,y, x,y, ...] in Bildschirm-Raum.
    pub fill_pos: Vec<f32>,
    pub fill_idx: Vec<u32>,
    pub fill_batches: Vec<FillBatch>,
    /// Linien-Vertices, interleaved [x,y, bx,by, side, miter] in Bildschirm-Raum
    /// (bx,by = Einheits-Versatzrichtung — Segment-Normale bei Quad-Raendern,
    /// Radialrichtung bei Rundkappen-/Rundecken-Faechern; side = 0 im Faecher-
    /// Zentrum, sonst +-1; miter ist stets 1 — die Strichbreite wird vollstaendig
    /// im Vertex-Shader angewandt, s. `shaders.rs`).
    pub line_verts: Vec<f32>,
    pub line_idx: Vec<u32>,
    pub line_batches: Vec<LineBatch>,
    /// Analytisch gezeichnete Boegen (je EINE Instanz, kein Segment-Mesh mehr):
    /// die GPU rendert sie pro Frame exakt rund per SDF-Fragment-Shader.
    pub arcs: Vec<ArcInstanceData>,
    /// Segmente gestrichelter Zuege (je EINE Instanz, Muster im Fragment-Shader).
    pub dash_segments: Vec<DashSegment>,
    pub dash_batches: Vec<DashBatch>,
    /// Maler-Reihenfolge ueber BEIDE Batch-Arten hinweg: (Art, Index in
    /// `fill_batches` bzw. `line_batches`). Der Renderer zeichnet exakt in dieser
    /// Reihenfolge (Pipeline-Wechsel pro Eintrag) — nur so deckt eine spaetere
    /// Fuellung (Wand-Poche) einen frueheren Strich (Raum-Umriss) ab, wie im
    /// SVG-Referenzpfad (Primitive strikt in Array-Reihenfolge).
    pub draw_sequence: Vec<(BatchKind, u32)>,
    /// Modell-Bounds (Meter) fuer Debug/Einpassen; nicht render-kritisch.
    pub bounds: [f32; 4], // [min_x, min_y, max_x, max_y]
}

#[inline]
fn same_rgba(a: Rgba, b: Rgba) -> bool {
    a[0] == b[0] && a[1] == b[1] && a[2] == b[2] && a[3] == b[3]
}

impl GpuGeometry {
    /// Ordnungserhaltendes Batch-Merging fuer Fuellungen: aufeinanderfolgende
    /// Indizes gleicher Farbe werden zu EINEM Draw-Call zusammengefasst. Gemergt
    /// wird nur, wenn der letzte Eintrag der MALER-Reihenfolge (`draw_sequence`)
    /// derselbe Fuell-Batch ist — sonst wuerde ein dazwischenliegender Linien-
    /// Batch uebersprungen und die Z-Reihenfolge verfaelscht.
    fn add_fill_batch(&mut self, count: u32, color: Rgba) {
        let last_idx = self.fill_batches.len().wrapping_sub(1) as u32;
        if self.draw_sequence.last() == Some(&(BatchKind::Fill, last_idx)) {
            if let Some(last) = self.fill_batches.last_mut() {
                if same_rgba(last.color, color) {
                    last.index_count += count;
                    return;
                }
            }
        }
        self.fill_batches.push(FillBatch {
            start_index: self.fill_idx.len() as u32 - count,
            index_count: count,
            color,
        });
        self.draw_sequence
            .push((BatchKind::Fill, (self.fill_batches.len() - 1) as u32));
    }

    fn add_line_batch(&mut self, count: u32, color: Rgba, stroke_mm: f32, width_screen: bool) {
        let last_idx = self.line_batches.len().wrapping_sub(1) as u32;
        if self.draw_sequence.last() == Some(&(BatchKind::Line, last_idx)) {
            if let Some(last) = self.line_batches.last_mut() {
                if last.stroke_mm == stroke_mm
                    && last.width_screen == width_screen
                    && same_rgba(last.color, color)
                {
                    last.index_count += count;
                    return;
                }
            }
        }
        self.line_batches.push(LineBatch {
            start_index: self.line_idx.len() as u32 - count,
            index_count: count,
            color,
            stroke_mm,
            width_screen,
        });
        self.draw_sequence
            .push((BatchKind::Line, (self.line_batches.len() - 1) as u32));
    }

    fn add_dash_batch(&mut self, count: u32, color: Rgba, stroke_mm: f32, width_screen: bool) {
        let last_idx = self.dash_batches.len().wrapping_sub(1) as u32;
        if self.draw_sequence.last() == Some(&(BatchKind::Dash, last_idx)) {
            if let Some(last) = self.dash_batches.last_mut() {
                if last.stroke_mm == stroke_mm && last.width_screen == width_screen && same_rgba(last.color, color) {
                    last.count += count;
                    return;
                }
            }
        }
        self.dash_batches.push(DashBatch { start: self.dash_segments.len() as u32 - count, count, color, stroke_mm, width_screen });
        self.draw_sequence.push((BatchKind::Dash, (self.dash_batches.len() - 1) as u32));
    }

    /// Gestrichelter Linienzug (Modell-Meter) mit gueltigem Muster `cycle_m` (Modell-Meter, gerade
    /// Laenge): je Segment eine Instanz mit Lauflaenge — Phase wie `split_dash` ueber den ganzen Zug,
    /// Segmente kuerzer als 1e-12 m entfallen; ein geschlossener Umriss bleibt offen (wie frueher).
    fn stroke_dashed(&mut self, pts: &[Point], cycle_m: &[f32], color: Rgba, stroke_mm: f32, width_screen: bool, bounds: &mut Bounds) {
        if pts.len() < 2 {
            return;
        }
        let mut lens: Vec<f32> = Vec::with_capacity(pts.len() - 1);
        let mut run = 0.0f32;
        for w in pts.windows(2) {
            let l = ((w[1][0] - w[0][0]).powi(2) + (w[1][1] - w[0][1]).powi(2)).sqrt();
            lens.push(l);
            if l >= 1e-12 {
                run += l;
            }
        }
        let mut dash = [0.0f32; MAX_LINE_DASH];
        for (d, c) in dash.iter_mut().zip(cycle_m) {
            *d = c * PX_PER_M;
        }
        let total: f32 = cycle_m.iter().sum::<f32>() * PX_PER_M;
        let before = self.dash_segments.len();
        let mut s0 = 0.0f32;
        for (w, &l) in pts.windows(2).zip(&lens) {
            if l < 1e-12 {
                continue;
            }
            bounds.track(w[0]);
            bounds.track(w[1]);
            self.dash_segments.push(DashSegment {
                a: to_screen(w[0]),
                b: to_screen(w[1]),
                s0: s0 * PX_PER_M,
                run_len: run * PX_PER_M,
                total,
                count: cycle_m.len() as u32,
                dash,
            });
            s0 += l;
        }
        let n = (self.dash_segments.len() - before) as u32;
        if n > 0 {
            self.add_dash_batch(n, color, stroke_mm, width_screen);
        }
    }

    /// Zeichnet einen zusammenhaengenden Linienzug (Modell-Meter) mit ECHTEN
    /// RUNDEN Kappen/Ecken (wie SVG `stroke-linecap/linejoin: round` und der
    /// Vektor-PDF-Pfad) statt eckigem Butt-Cap/Gehrung:
    ///  - jedes Segment ist ein eigenstaendiges Quad mit BUTT-Enden (eigene
    ///    Segment-Normale, keine Miter-Verlaengerung);
    ///  - an jedem inneren Stuetzpunkt fuellt ein Dreiecksfaecher (Radius = halbe
    ///    Strichbreite) die Aussenseite der Ecke rund auf (Innenseite ueberlappt
    ///    unsichtbar, wie bei jedem Disjoint-Segment-Linienbreiten-Ansatz);
    ///  - an offenen Enden (nicht `closed`) sitzt ein Halbkreis-Faecher als runde
    ///    Kappe.
    /// Die tatsaechliche Pixel-Breite bleibt bildschirmkonstant: alle Faecher-/
    /// Quad-Vertices tragen nur eine EINHEITS-Richtung (`bx,by`) + `side`-Skalar;
    /// der Vertex-Shader multipliziert im Clip-Raum mit der aktuellen
    /// Strichbreite (`stroke_px*stroke_scale`) — die Tessellierung selbst kennt
    /// keine Pixelmasse. `closed` schliesst den Ring (letzter<->erster Punkt).
    /// Vertex-Layout unveraendert: [x,y, bx,by, side, miter] (miter bleibt hier
    /// immer 1, s. Shader-Vertrag in `shaders.rs`).
    ///
    /// 1:1-Port von `strokePolyline` in `src/plan/glPlan/glPlanCompile.ts`.
    fn stroke_polyline(
        &mut self,
        pts_m: &[Point],
        closed: bool,
        color: Rgba,
        stroke_mm: f32,
        width_screen: bool,
        bounds: &mut Bounds,
    ) {
        // Auf Bildschirm-Raum abbilden + aufeinanderfolgende Duplikate entfernen.
        let mut s: Vec<Point> = Vec::with_capacity(pts_m.len());
        for &p in pts_m {
            let sp = to_screen(p);
            if let Some(last) = s.last() {
                if (last[0] - sp[0]).abs() < 1e-6 && (last[1] - sp[1]).abs() < 1e-6 {
                    continue;
                }
            }
            s.push(sp);
            bounds.track(p);
        }
        if closed && s.len() > 1 {
            let f = s[0];
            let l = s[s.len() - 1];
            if (f[0] - l[0]).abs() < 1e-6 && (f[1] - l[1]).abs() < 1e-6 {
                s.pop();
            }
        }
        let k = s.len();
        if k < 2 {
            return;
        }

        let start_idx_len = self.line_idx.len();

        // Vertex fuer Quad-Rand ODER Faecher (Zentrum bei side=0, Rand bei side=1)
        // anhaengen; gibt den neuen Index zurueck.
        #[inline]
        fn push_vert(verts: &mut Vec<f32>, p: Point, n: Point, side: f32) -> u32 {
            verts.extend_from_slice(&[p[0], p[1], n[0], n[1], side, 1.0]);
            (verts.len() / 6 - 1) as u32
        }

        let segs = if closed { k } else { k - 1 };
        let mut seg_dir: Vec<Option<Point>> = Vec::with_capacity(segs);
        for i in 0..segs {
            seg_dir.push(unit_dir(s[i], s[(i + 1) % k]));
        }

        // Segment-Quads: buttendig, jedes mit seiner EIGENEN Normale (kein
        // gemeinsamer Bisektor mehr — Ecken werden separat durch Faecher geschlossen).
        for i in 0..segs {
            let Some(d) = seg_dir[i] else {
                continue; // entartetes (Laenge-0) Segment
            };
            let n = left_normal_of(d);
            let a = s[i];
            let b = s[(i + 1) % k];
            let i0 = push_vert(&mut self.line_verts, a, n, 1.0);
            let i1 = push_vert(&mut self.line_verts, a, n, -1.0);
            let i2 = push_vert(&mut self.line_verts, b, n, 1.0);
            let i3 = push_vert(&mut self.line_verts, b, n, -1.0);
            self.line_idx
                .extend_from_slice(&[i0, i1, i2, i1, i3, i2]);
        }

        // Kreisbogen-Faecher (Zentrum = Vertex, Radius = halbe Strichbreite, per
        // Shader skaliert): `side=0` am Zentrum (kein Versatz), `side=1` an den
        // Randpunkten (voller Versatz in Richtung (cos(t),sin(t))). Segmentzahl
        // skaliert mit dem ueberstrichenen Winkel (18 Grad je Schritt).
        #[inline]
        fn add_fan_arc(verts: &mut Vec<f32>, idx: &mut Vec<u32>, p: Point, a_from: f32, a_to: f32) {
            let delta = a_to - a_from;
            let steps = ((delta.abs() / (std::f32::consts::PI / 10.0)).ceil() as u32).max(1);
            let i_center = push_vert(verts, p, [1.0, 0.0], 0.0);
            let mut prev = push_vert(verts, p, [a_from.cos(), a_from.sin()], 1.0);
            for step in 1..=steps {
                let t = a_from + delta * (step as f32) / (steps as f32);
                let cur = push_vert(verts, p, [t.cos(), t.sin()], 1.0);
                idx.extend_from_slice(&[i_center, prev, cur]);
                prev = cur;
            }
        }

        // Runder Join an einem inneren Stuetzpunkt: Faecher NUR auf der konvexen
        // (aeusseren) Seite der Ecke — die konkave Seite ueberlappt bereits durch
        // die beiden Segment-Quads (kein Loch, keine zusaetzliche Geometrie noetig).
        #[inline]
        fn add_round_join(verts: &mut Vec<f32>, idx: &mut Vec<u32>, p: Point, d1: Point, d2: Point) {
            let turn = d1[0] * d2[1] - d1[1] * d2[0];
            let dot = d1[0] * d2[0] + d1[1] * d2[1];
            if turn.abs() < 1e-6 && dot > 0.0 {
                return; // praktisch gerade
            }
            let n1 = left_normal_of(d1);
            let n2 = left_normal_of(d2);
            if dot < -0.9999 {
                // ~180-Grad-Umkehr: Aussenseite mehrdeutig -> voller Kreis (robust,
                // entspricht zwei gestapelten Rund-Kappen an derselben Stelle).
                let a0 = n1[1].atan2(n1[0]);
                add_fan_arc(verts, idx, p, a0, a0 + 2.0 * std::f32::consts::PI);
                return;
            }
            let outer = if turn > 0.0 { -1.0 } else { 1.0 };
            let u1 = [outer * n1[0], outer * n1[1]];
            let u2 = [outer * n2[0], outer * n2[1]];
            let a1 = u1[1].atan2(u1[0]);
            let a2 = u2[1].atan2(u2[0]);
            let mut delta = a2 - a1;
            while delta <= -std::f32::consts::PI {
                delta += 2.0 * std::f32::consts::PI;
            }
            while delta > std::f32::consts::PI {
                delta -= 2.0 * std::f32::consts::PI;
            }
            if delta.abs() < 1e-4 {
                return;
            }
            add_fan_arc(verts, idx, p, a1, a1 + delta);
        }

        // Runde Kappe an einem offenen Ende: Halbkreis, der auf der Aussenseite
        // (weg von der Linie) ausbaucht.
        #[inline]
        fn add_round_cap(verts: &mut Vec<f32>, idx: &mut Vec<u32>, p: Point, n: Point, sweep_sign: f32) {
            let a0 = n[1].atan2(n[0]);
            add_fan_arc(verts, idx, p, a0, a0 + sweep_sign * std::f32::consts::PI);
        }

        for v in 0..k {
            let has_in = closed || v > 0;
            let has_out = closed || v < k - 1;
            let d_in = if has_in {
                seg_dir[(v + segs - 1) % segs]
            } else {
                None
            };
            let d_out = if has_out { seg_dir[v % segs] } else { None };
            match (d_in, d_out) {
                (Some(di), Some(do_)) => {
                    add_round_join(&mut self.line_verts, &mut self.line_idx, s[v], di, do_)
                }
                (None, Some(do_)) => {
                    // Start-Kappe: baucht rueckwaerts (weg vom ersten Segment) aus.
                    let n = left_normal_of(do_);
                    add_round_cap(&mut self.line_verts, &mut self.line_idx, s[v], n, 1.0)
                }
                (Some(di), None) => {
                    // End-Kappe: baucht vorwaerts (weg vom letzten Segment) aus.
                    let n = left_normal_of(di);
                    add_round_cap(&mut self.line_verts, &mut self.line_idx, s[v], n, -1.0)
                }
                (None, None) => {}
            }
        }

        self.add_line_batch(
            (self.line_idx.len() - start_idx_len) as u32,
            color,
            stroke_mm,
            width_screen,
        );
    }
}

/// Hilfsstruct zum Verfolgen der Modell-Bounds.
struct Bounds {
    min_x: f32,
    min_y: f32,
    max_x: f32,
    max_y: f32,
}

impl Bounds {
    fn new() -> Self {
        Self {
            min_x: f32::INFINITY,
            min_y: f32::INFINITY,
            max_x: f32::NEG_INFINITY,
            max_y: f32::NEG_INFINITY,
        }
    }
    #[inline]
    fn track(&mut self, p: Point) {
        if p[0] < self.min_x {
            self.min_x = p[0];
        }
        if p[1] < self.min_y {
            self.min_y = p[1];
        }
        if p[0] > self.max_x {
            self.max_x = p[0];
        }
        if p[1] > self.max_y {
            self.max_y = p[1];
        }
    }
    fn finish(self) -> [f32; 4] {
        [
            if self.min_x.is_finite() { self.min_x } else { 0.0 },
            if self.min_y.is_finite() { self.min_y } else { 0.0 },
            if self.max_x.is_finite() { self.max_x } else { 1.0 },
            if self.max_y.is_finite() { self.max_y } else { 1.0 },
        ]
    }
}

/// Kompiliert eine ganze Szene zu GPU-Geometrie: gefuellte Polygone +
/// Papier-mm-Striche (tesselliert) + analytische Boegen (je EINE Instanz).
/// Reihenfolge: Fuellungen -> Umrisse -> offene Polylinien -> freie Linien; die
/// Boegen sammelt `geo.arcs` (eigene Pipeline, gezeichnet nach den Linien). ALLES
/// ist zoom-INVARIANT: Papier-mm-Striche wie auch die Bogen-Kanten werden erst im
/// Shader auf Geraete-px abgebildet — keine Neu-Tessellierung bei Zoom noetig.
pub fn compile_scene(scene: &Scene) -> GpuGeometry {
    let mut geo = GpuGeometry::default();
    let mut bounds = Bounds::new();

    // Maler-Reihenfolge herstellen: alle Elemente (Fuellungen, Umrisse, offene
    // Polylinien, freie Linien) stabil nach ihrem `z` sortieren. Bei gleichem z
    // (insb. Alt-Szenen mit z=0 ueberall) gilt die bisherige Kategorien-
    // Reihenfolge Fuellungen -> Umrisse -> Polylinien -> Linien (`seq`).
    enum Item<'a> {
        Fill(&'a crate::types::FillPolygon),
        Outline(&'a crate::types::Outline),
        Poly(&'a crate::types::Polyline),
        Line(&'a Line),
    }
    let mut items: Vec<(u32, usize, Item)> = Vec::with_capacity(
        scene.fills.len() + scene.outlines.len() + scene.polylines.len() + scene.lines.len(),
    );
    let mut seq = 0usize;
    for f in &scene.fills {
        items.push((f.z, seq, Item::Fill(f)));
        seq += 1;
    }
    for o in &scene.outlines {
        items.push((o.z, seq, Item::Outline(o)));
        seq += 1;
    }
    for pl in &scene.polylines {
        items.push((pl.z, seq, Item::Poly(pl)));
        seq += 1;
    }
    for l in &scene.lines {
        items.push((l.z, seq, Item::Line(l)));
        seq += 1;
    }
    items.sort_by_key(|(z, s, _)| (*z, *s));

    for (_, _, item) in &items {
        match item {
            // Gefuellte Polygone.
            Item::Fill(poly) => compile_fill(&mut geo, poly, &mut bounds),
            // Umrisse (geschlossene Ringe als EIN gehrter Streifen, inkl.
            // Schluss-Kante — ausser bei Dash, siehe `stroke_dashed_or_solid`).
            Item::Outline(o) => {
                if o.width_mm > 0.0 && o.pts.len() >= 2 {
                    stroke_dashed_or_solid(&mut geo, &o.pts, true, o.color, o.width_mm, false, o.dash.as_deref(), &mut bounds);
                }
            }
            // Offene Polylinien (verbundene Umrisskanten / 2D-Zeichnungszuege) als
            // EIN gehrter Streifen — innere Ecken gehrt statt Stumpfkappen.
            Item::Poly(pl) => {
                if pl.width_mm > 0.0 && pl.pts.len() >= 2 {
                    stroke_dashed_or_solid(&mut geo, &pl.pts, false, pl.color, pl.width_mm, pl.width_screen, pl.dash.as_deref(), &mut bounds);
                }
            }
            // Freie Einzel-Linien (Tuerblaetter, Referenzlinien).
            Item::Line(l) => compile_line(&mut geo, l, &mut bounds),
        }
    }
    // Kreisboegen: NICHT in Segmente zerlegt — je Bogen eine analytische Instanz
    // (`ArcInstanceData`), die die GPU per SDF-Fragment-Shader exakt rund rendert
    // (eigene Pipeline, nach der uebrigen Geometrie — Tuerschwenk liegt oben).
    for a in &scene.arcs {
        compile_arc(&mut geo, a, &mut bounds);
    }

    geo.bounds = bounds.finish();
    geo
}

fn compile_fill(geo: &mut GpuGeometry, poly: &FillPolygon, bounds: &mut Bounds) {
    let tris = triangulate(&poly.pts);
    if tris.is_empty() {
        return;
    }
    let base = (geo.fill_pos.len() / 2) as u32;
    for &pt in &poly.pts {
        let s = to_screen(pt);
        geo.fill_pos.push(s[0]);
        geo.fill_pos.push(s[1]);
        bounds.track(pt);
    }
    let count = tris.len() as u32;
    for t in tris {
        geo.fill_idx.push(base + t);
    }
    geo.add_fill_batch(count, poly.color);
}

fn compile_arc(geo: &mut GpuGeometry, a: &Arc, bounds: &mut Bounds) {
    if a.width_mm <= 0.0 || a.r <= 0.0 {
        return;
    }
    let (center, r_screen, a0, sweep) = arc_screen_params(a.center, a.from, a.to, a.r);
    // Degenerierter Bogen (from == to -> Sweep ~ 0): nichts zu zeichnen. Echte
    // Vollkreise kommen als geschlossenes Polygon (siehe generatePlan `circle`).
    if sweep.abs() < 1e-6 {
        return;
    }
    // Muster mit Punkten oder mehr Eintraegen, als der Bogen-Shader fasst (Strich-Zweipunktlinie):
    // als feiner Polygonzug ueber den Linien-Strichpfad (Punkte rund, Phase durchgehend) ([96]).
    if let Some(cycle) = a.dash.as_deref().filter(|d| !d.is_empty()).and_then(dash_cycle_m) {
        if cycle.len() > MAX_ARC_DASH || cycle.iter().step_by(2).any(|d| *d <= 0.0) {
            // Modell-Winkel = gespiegelte Bildschirm-Winkel (`to_screen` negiert Y).
            let n = ((sweep.abs() / 0.03).ceil() as usize).clamp(8, 4096);
            let pts: Vec<Point> = (0..=n)
                .map(|i| {
                    let t = -(a0 + sweep * i as f32 / n as f32);
                    [a.center[0] + a.r * t.cos(), a.center[1] + a.r * t.sin()]
                })
                .collect();
            stroke_dashed_or_solid(geo, &pts, false, a.color, a.width_mm, false, a.dash.as_deref(), bounds);
            return;
        }
    }
    let (dash, dash_count, dash_total) = prepare_arc_dash(a.dash.as_deref());
    geo.arcs.push(ArcInstanceData {
        center,
        r_screen,
        r_model: a.r,
        a0,
        sweep,
        color: a.color,
        width_mm: a.width_mm,
        dash,
        dash_count,
        dash_total,
    });
    // Modell-Bounds: Bounding-Box des vollen Kreises (grosszuegig, aber sicher
    // fuer "Einpassen"; der sichtbare Bogen liegt stets darin).
    bounds.track([a.center[0] - a.r, a.center[1] - a.r]);
    bounds.track([a.center[0] + a.r, a.center[1] + a.r]);
}

fn compile_line(geo: &mut GpuGeometry, l: &Line, bounds: &mut Bounds) {
    let w = if l.width_mm > 0.0 { l.width_mm } else { 0.18 };
    stroke_dashed_or_solid(geo, &[l.a, l.b], false, l.color, w, false, l.dash.as_deref(), bounds);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{Arc, Outline};

    // --- arc_screen_params: analytische Bogen-Parameter ----------------------

    /// Modell-Raum-Sweep (kuerzerer Bogen) — Referenz fuer die Winkel-Paritaet
    /// (frueher die Winkellogik der `tessellate_arc`). Die Bildschirm-Y-Spiegelung
    /// aendert nur das Vorzeichen, nicht den Betrag.
    fn model_delta(center: Point, from: Point, to: Point) -> f32 {
        let a0 = (from[1] - center[1]).atan2(from[0] - center[0]);
        let a1 = (to[1] - center[1]).atan2(to[0] - center[0]);
        let mut d = a1 - a0;
        while d > std::f32::consts::PI {
            d -= 2.0 * std::f32::consts::PI;
        }
        while d < -std::f32::consts::PI {
            d += 2.0 * std::f32::consts::PI;
        }
        d
    }

    #[test]
    fn arc_screen_params_endpunkte_treffen_exakt() {
        let center = [1.0, 1.0];
        let from = [2.0, 1.0]; // r=1, Modell-Winkel 0
        let to = [1.0, 2.0]; // Modell-Winkel 90 Grad
        let (cs, r_s, a0, sweep) = arc_screen_params(center, from, to, 1.0);
        // Punkt bei a0 == to_screen(from), Punkt bei a0+sweep == to_screen(to).
        let p0 = [cs[0] + a0.cos() * r_s, cs[1] + a0.sin() * r_s];
        let p1 = [cs[0] + (a0 + sweep).cos() * r_s, cs[1] + (a0 + sweep).sin() * r_s];
        let fs = to_screen(from);
        let ts = to_screen(to);
        assert!((p0[0] - fs[0]).abs() < 1e-3 && (p0[1] - fs[1]).abs() < 1e-3, "Start trifft from");
        assert!((p1[0] - ts[0]).abs() < 1e-3 && (p1[1] - ts[1]).abs() < 1e-3, "Ende trifft to");
        assert!((r_s - PX_PER_M).abs() < 1e-3, "r_screen = r * PX_PER_M");
    }

    #[test]
    fn arc_screen_params_kuerzerer_bogen_paritaet() {
        let center = [0.0, 0.0];
        let from = [1.0, 0.0];
        // Ziel bei Modell-Winkel 200 Grad -> naiv 200 Grad, kuerzer aber -160 Grad.
        let ang = 200.0_f32.to_radians();
        let to = [ang.cos(), ang.sin()];
        let (_, _, _, sweep) = arc_screen_params(center, from, to, 1.0);
        assert!(sweep.abs() <= std::f32::consts::PI + 1e-4, "kuerzerer Bogen (|sweep|<=pi)");
        // Betrag identisch zur Modell-Raum-Winkellogik (Y-Spiegelung nur Vorzeichen).
        assert!(
            (sweep.abs() - model_delta(center, from, to).abs()).abs() < 1e-4,
            "Sweep-Betrag == Modell-Delta-Betrag (Paritaet zur alten tessellate_arc-Logik)"
        );
    }

    // --- prepare_arc_dash: Papier-mm -> Modell-Meter-Zyklus -------------------

    #[test]
    fn prepare_arc_dash_tuerschwenk_mapping() {
        // Tuerschwenk-Muster [0.06, 0.04] mm -> * DASH_MM_TO_M(0.1) = [0.006, 0.004] m.
        let (cyc, n, total) = prepare_arc_dash(Some(&[0.06, 0.04]));
        assert_eq!(n, 2, "ein An/Aus-Paar");
        assert!((cyc[0] - 0.006).abs() < 1e-6 && (cyc[1] - 0.004).abs() < 1e-6);
        assert!((total - 0.010).abs() < 1e-6, "Zykluslaenge 0.01 m");
    }

    #[test]
    fn prepare_arc_dash_ungerade_wird_verdoppelt() {
        // Einzelwert -> Standard-Dash-Semantik: verdoppelt auf [x, x].
        let (cyc, n, total) = prepare_arc_dash(Some(&[10.0]));
        assert_eq!(n, 2, "ungerade Laenge wird verdoppelt");
        assert!((cyc[0] - 1.0).abs() < 1e-6 && (cyc[1] - 1.0).abs() < 1e-6);
        assert!((total - 2.0).abs() < 1e-6);
    }

    #[test]
    fn prepare_arc_dash_leer_ist_durchgezogen() {
        assert_eq!(prepare_arc_dash(None).1, 0);
        assert_eq!(prepare_arc_dash(Some(&[])).1, 0);
    }

    // --- Strichmuster im Shader (DashSegment, dash_coverage) -------------------

    fn dashed_line(a: Point, b: Point, dash: Vec<f32>) -> Scene {
        Scene { lines: vec![Line { a, b, color: [0.2, 0.2, 0.2, 1.0], width_mm: 0.13, dash: Some(dash), z: 0 }], ..Scene::default() }
    }

    #[test]
    fn gestrichelte_linie_eine_instanz_statt_zerlegung() {
        let geo = compile_scene(&dashed_line([0.0, 0.0], [3.0, 0.0], vec![0.12, 0.08]));
        assert!(geo.line_verts.is_empty() && geo.line_idx.is_empty(), "keine Teilstuecke mehr");
        assert_eq!(geo.dash_segments.len(), 1);
        assert_eq!(geo.draw_sequence, vec![(BatchKind::Dash, 0)]);
        let d = &geo.dash_segments[0];
        assert_eq!(d.a, [0.0, 0.0]);
        assert_eq!(d.b, [3.0 * PX_PER_M, 0.0]);
        assert_eq!((d.s0, d.run_len, d.count), (0.0, 3.0 * PX_PER_M, 2));
        assert!((d.dash[0] - 0.012 * PX_PER_M).abs() < 1e-5 && (d.dash[1] - 0.008 * PX_PER_M).abs() < 1e-5);
        assert!((d.total - 0.02 * PX_PER_M).abs() < 1e-5);
        assert_eq!(geo.dash_batches[0].count, 1);
        assert_eq!(geo.dash_batches[0].stroke_mm, 0.13);
    }

    #[test]
    fn gestrichelter_zug_phase_ueber_ecken_und_offener_umriss() {
        let pts = vec![[0.0, 0.0], [1.0, 0.0], [1.0, 0.0], [1.0, 2.0]];
        let scene = Scene {
            polylines: vec![crate::types::Polyline { pts: pts.clone(), color: [0.0, 0.0, 0.0, 1.0], width_mm: 0.25, dash: Some(vec![1.0]), z: 0, width_screen: false }],
            outlines: vec![Outline { pts: vec![[0.0, 0.0], [1.0, 0.0], [1.0, 1.0]], color: [0.0, 0.0, 0.0, 1.0], width_mm: 0.25, dash: Some(vec![1.0]), z: 1 }],
            ..Scene::default()
        };
        let geo = compile_scene(&scene);
        // Polylinie: Nullsegment entfaellt, Phase laeuft weiter; Umriss bleibt offen (2 statt 3 Kanten).
        assert_eq!(geo.dash_segments.len(), 4);
        assert_eq!(geo.dash_segments[1].s0, 1.0 * PX_PER_M);
        assert_eq!(geo.dash_segments[1].run_len, 3.0 * PX_PER_M);
        assert_eq!(geo.dash_segments[1].count, 2, "ungerades Muster verdoppelt");
        // gleiche Farbe/Breite, aufeinanderfolgend → ein Batch
        assert_eq!(geo.dash_batches.len(), 1);
        assert_eq!(geo.dash_batches[0].count, 4);
    }

    #[test]
    fn ungueltiges_oder_langes_muster_wie_bisher() {
        // nur Nullen → durchgezogen (ein offener Zug)
        let geo = compile_scene(&dashed_line([0.0, 0.0], [1.0, 0.0], vec![0.0, 0.0]));
        assert!(geo.dash_segments.is_empty() && !geo.line_idx.is_empty());
        // 9 Eintraege → verdoppelt 18 > MAX_LINE_DASH: CPU-Zerlegung
        let geo = compile_scene(&dashed_line([0.0, 0.0], [1.0, 0.0], vec![1.0; 9]));
        assert!(geo.dash_segments.is_empty() && !geo.line_idx.is_empty());
    }

    /// [96] Punkte (AN = 0) bleiben im Zyklus: Strichpunktlinie [12, 1.5, 0, 1.5] behaelt vier
    /// Eintraege (Strich, Luecke, Punkt, Luecke) statt zu [12, 1.5, 1.5] zusammenzufallen.
    #[test]
    fn punkte_bleiben_im_muster() {
        let c = dash_cycle_m(&[12.0, 1.5, 0.0, 1.5]).unwrap();
        assert_eq!(c.len(), 4);
        assert_eq!(c[2], 0.0);
        assert!((c[0] - 12.0 * DASH_MM_TO_M).abs() < 1e-6);
        let geo = compile_scene(&dashed_line([0.0, 0.0], [5.0, 0.0], vec![12.0, 1.5, 0.0, 1.5]));
        assert_eq!(geo.dash_segments.len(), 1);
        assert_eq!(geo.dash_segments[0].count, 4);
        // Deckung: der Punkt liegt bei 13.5 mm (Muster-Raum) und ist rund sichtbar, die Luecken nicht.
        let px = PX_PER_M; // 1 Bildschirm-Einheit = 1 px
        let cyc: Vec<f32> = c.iter().map(|d| d * px).collect();
        let total: f32 = cyc.iter().sum();
        let seg = [0.0, 5.0 * px, 5.0 * px, 0.5];
        let dot = (12.0 + 1.5) * DASH_MM_TO_M * px;
        assert!(dash_coverage(dot, 0.0, seg, total, &cyc) < 0.01);
        assert!(dash_coverage(dot - 0.7 * DASH_MM_TO_M * px, 0.0, seg, total, &cyc) > 0.5);
    }

    /// [96] Boegen mit Punkten/langen Mustern laufen ueber den Linien-Strichpfad.
    #[test]
    fn bogen_mit_punktmuster_als_strichzug() {
        let scene = Scene {
            arcs: vec![Arc { center: [0.0, 0.0], from: [1.0, 0.0], to: [0.0, 1.0], r: 1.0, color: [0.0, 0.0, 0.0, 1.0], width_mm: 0.25, dash: Some(vec![12.0, 1.5, 0.0, 1.5, 0.0, 1.5]) }],
            ..Default::default()
        };
        let geo = compile_scene(&scene);
        assert!(geo.arcs.is_empty());
        assert!(!geo.dash_segments.is_empty());
        let plain = Scene { arcs: vec![Arc { dash: Some(vec![0.06, 0.04]), ..scene.arcs[0].clone() }], ..Default::default() };
        assert_eq!(compile_scene(&plain).arcs.len(), 1);
    }

    /// Der Shader-Spiegel deckt genau die Pixel, die die frueheren Teilstuecke samt runden Kappen
    /// deckten: Abstand zum naechsten `split_dash`-Stueck (Geraete-px) == `dash_coverage`.
    #[test]
    fn deckung_wie_zerlegung_mit_rundkappen() {
        let mut seed = 12345u32;
        let mut rnd = || {
            seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
            (seed >> 8) as f32 / (1u32 << 24) as f32
        };
        for case in 0..200 {
            let len_m = 0.05 + rnd() * 3.0;
            let n = 1 + (rnd() * 4.0) as usize;
            let pat: Vec<f32> = (0..n).map(|_| 0.02 + rnd() * 0.6).collect();
            let pps = 0.5 + rnd() * 4.0; // Geraete-px je Bildschirm-Einheit
            let hw = 0.5 + rnd() * 3.0;
            let to_px = |m: f32| m * PX_PER_M * pps;
            // gerade Strecke, in 1–3 kollineare Segmente geteilt
            let cuts: Vec<f32> = match case % 3 {
                0 => vec![0.0, len_m],
                1 => vec![0.0, len_m * 0.37, len_m],
                _ => vec![0.0, len_m * 0.2, len_m * 0.71, len_m],
            };
            let pts: Vec<Point> = cuts.iter().map(|&x| [x, 0.0]).collect();
            let geo = compile_scene(&Scene {
                polylines: vec![crate::types::Polyline { pts: pts.clone(), color: [0.0; 4], width_mm: 0.2, dash: Some(pat.clone()), z: 0, width_screen: false }],
                ..Scene::default()
            });
            let pieces = split_dash(&pts, &pat);
            for _ in 0..200 {
                let s = to_px(-0.1 + rnd() * (len_m + 0.2));
                let y = (rnd() * 2.0 - 1.0) * hw * 1.5;
                let old = pieces
                    .iter()
                    .map(|p| {
                        let (p0, p1) = (to_px(p[0][0]), to_px(p[p.len() - 1][0]));
                        let e = (p0 - s).max(s - p1).max(0.0);
                        (e * e + y * y).sqrt()
                    })
                    .fold(f32::INFINITY, f32::min);
                // jedes Segment deckt seinen Bereich samt halber Breite davor/dahinter
                let new = geo
                    .dash_segments
                    .iter()
                    .map(|d| {
                        let s0 = d.s0 * pps;
                        let s1 = s0 + (d.b[0] - d.a[0]) * pps;
                        let cyc: Vec<f32> = d.dash[..d.count as usize].iter().map(|v| v * pps).collect();
                        dash_coverage(s, y, [s0, s1, d.run_len * pps, hw], d.total * pps, &cyc)
                    })
                    .fold(f32::INFINITY, f32::min);
                // Gleiche Entscheidung (gedeckt ja/nein) bis auf Rundung an der Kante.
                let tol = 2e-3 * (1.0 + s.abs());
                assert!((old <= hw) == (new <= hw) || (old - hw).abs() < tol || (new - hw).abs() < tol, "Fall {case}: s={s} y={y} alt {old} neu {new} hw {hw}");
            }
        }
    }

    // --- split_dash: geometrische Strichmuster-Zerlegung ---------------------

    #[test]
    fn split_dash_gerade_linie_erwartete_stueckzahl_und_laenge() {
        let pts = [[0.0, 0.0], [10.0, 0.0]];
        // 10mm/10mm bei Referenz-Skala (DASH_MM_TO_M=0.1) -> 1m/1m Zyklus,
        // 10m Gesamtlaenge -> 5 "an"-Stuecke a 1m (50% Tastverhaeltnis).
        let pieces = split_dash(&pts, &[10.0, 10.0]);
        assert_eq!(pieces.len(), 5, "5 an-Stuecke erwartet");
        let total: f32 = pieces
            .iter()
            .map(|p| {
                p.windows(2)
                    .map(|w| ((w[1][0] - w[0][0]).powi(2) + (w[1][1] - w[0][1]).powi(2)).sqrt())
                    .sum::<f32>()
            })
            .sum();
        assert!((total - 5.0).abs() < 1e-3, "Gesamtlaenge der an-Stuecke ~5m, war {total}");
    }

    #[test]
    fn split_dash_leeres_muster_unveraendert() {
        let pts = [[0.0, 0.0], [3.0, 4.0], [10.0, 4.0]];
        let pieces = split_dash(&pts, &[]);
        assert_eq!(pieces.len(), 1);
        assert_eq!(pieces[0], pts.to_vec());
    }

    // --- compile_scene: End-zu-End-Verdrahtung --------------------------------

    #[test]
    fn compile_scene_mit_bogen_erzeugt_arc_instanz() {
        let scene = Scene {
            arcs: vec![Arc {
                center: [0.0, 0.0],
                from: [1.0, 0.0],
                to: [0.0, 1.0],
                r: 1.0,
                color: [0.1, 0.1, 0.1, 1.0],
                width_mm: 0.25,
                dash: None,
            }],
            ..Default::default()
        };
        let geo = compile_scene(&scene);
        // Analytisch: EINE Instanz, KEINE tessellierte Liniengeometrie.
        assert_eq!(geo.arcs.len(), 1, "genau eine Bogen-Instanz");
        assert!(geo.line_verts.is_empty(), "Bogen erzeugt keine Linien-Vertices mehr");
        let a = &geo.arcs[0];
        assert_eq!(a.dash_count, 0, "durchgezogen");
        assert!((a.r_screen - PX_PER_M).abs() < 1e-3);
        // Bounds decken den vollen Kreis (center +- r).
        assert!((geo.bounds[0] + 1.0).abs() < 1e-3 && (geo.bounds[2] - 1.0).abs() < 1e-3);
    }

    #[test]
    fn gestrichelter_umriss_als_shader_instanzen() {
        let ring = vec![[0.0, 0.0], [4.0, 0.0], [4.0, 4.0], [0.0, 4.0]];
        let solid = Scene {
            outlines: vec![Outline {
                pts: ring.clone(),
                color: [0.0, 0.0, 0.0, 1.0],
                width_mm: 0.2,
                dash: None,
                z: 0,
            }],
            ..Default::default()
        };
        let dashed = Scene {
            outlines: vec![Outline {
                pts: ring,
                color: [0.0, 0.0, 0.0, 1.0],
                width_mm: 0.2,
                dash: Some(vec![10.0, 10.0]),
                z: 0,
            }],
            ..Default::default()
        };
        let geo_solid = compile_scene(&solid);
        let geo_dashed = compile_scene(&dashed);
        assert!(!geo_solid.line_idx.is_empty());
        // Gestrichelt: keine Strich-Dreiecke, je Kante eine Shader-Instanz (Umriss offen wie bisher).
        assert!(geo_dashed.line_idx.is_empty());
        assert_eq!(geo_dashed.dash_segments.len(), 3);
    }

    #[test]
    fn gestrichelter_tuerschwenk_bogen_erzeugt_dash_instanz() {
        // Spiegelt den echten Anwendungsfall (Tuerschwenk-Boegen, dash 0.06/0.04mm).
        let center = [0.0, 0.0];
        let from = [1.0, 0.0];
        let to = [0.0, 1.0];
        let dash = vec![0.06, 0.04];
        let scene = Scene {
            arcs: vec![Arc {
                center,
                from,
                to,
                r: 1.0,
                color: [0.1, 0.1, 0.1, 1.0],
                width_mm: 0.05,
                dash: Some(dash.clone()),
            }],
            ..Default::default()
        };
        // Rundlauf durch die volle Pipeline: eine analytische, GESTRICHELTE Instanz.
        let geo = compile_scene(&scene);
        assert_eq!(geo.arcs.len(), 1, "genau eine Bogen-Instanz");
        let a = &geo.arcs[0];
        assert_eq!(a.dash_count, 2, "ein An/Aus-Paar (dash-Zyklus)");
        assert!((a.dash_total - 0.010).abs() < 1e-6, "Zykluslaenge 0.01 m");
        // Sweep = Viertelkreis (Betrag pi/2), Radius exakt.
        assert!((a.sweep.abs() - std::f32::consts::FRAC_PI_2).abs() < 1e-4);
        assert!((a.r_screen - PX_PER_M).abs() < 1e-3);
    }
}

#[cfg(test)]
mod bench {
    use super::*;
    use std::time::Instant;

    /// Messung: `SCENE_BENCH_FILE=szene.bin cargo test --release --lib tessellate::bench -- --ignored --nocapture`
    /// (Szene-Bytes wie für `set_scene_bin`).
    #[test]
    #[ignore]
    fn szene_kompilieren() {
        let Ok(path) = std::env::var("SCENE_BENCH_FILE") else { return };
        let bytes = std::fs::read(path).unwrap();
        for _ in 0..3 {
            let t = Instant::now();
            let scene = crate::scene_bin::decode_scene(&bytes).unwrap();
            let t_dec = t.elapsed();
            let t = Instant::now();
            let geo = compile_scene(&scene);
            println!(
                "decode {:?}  compile {:?}  lineVerts {} lineIdx {} fillIdx {}",
                t_dec,
                t.elapsed(),
                geo.line_verts.len() / 6,
                geo.line_idx.len(),
                geo.fill_idx.len()
            );
        }
    }
}
