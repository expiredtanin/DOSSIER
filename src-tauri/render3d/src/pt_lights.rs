// [212] Etappe 5: Lichtliste des Pathtracers für Next-Event-Estimation (NEE) auf Flächenlichter — Fensterscheiben als
// Lichtportale des Himmels (wie das „Portal“ in Cycles), Leuchten (`MAT_EMISSIVE`) und bei Nacht ein einfaches Raumlicht
// an den Deckenuntersichten jedes Geschosses. GPU-frei: die Liste entsteht auf der CPU aus dem gebauten Baum (`bvh.rs`),
// die Auswahlgewichte hier sind 1:1 die des Shaders (`pathtrace::PT_WGSL`, `lweight`) und dienen den Tests als Referenz.
//
// Verfahren je Pfad-Ecke p (Normale n): ein Licht k wird mit Wahrscheinlichkeit w_k(p) / W(p) gewählt (w = geschätzter
// Beitrag: Leistung · Raumwinkel · Empfänger-Kosinus, `light_weight`), darauf ein Punkt gleichverteilt auf dem Dreieck.
// Die Dichte der Richtung ist für Leuchten P_k · d² / (cos θ_k · A_k); für Portale die Summe dieses Ausdrucks über ALLE
// gelisteten Scheiben, die der Strahl auf dem Weg in den Himmel kreuzt (eine Scheibe hat zwei Flächen, Fenster liegen
// hintereinander) — der Schattenstrahl zählt sie unterwegs. Mit der Dichte der BRDF-Wahl kombiniert die Power-Heuristik
// (Veach 1997) beide Wege: trifft ein BRDF-Pfad durch Portale den Himmel oder trifft er eine Leuchte, rechnet der Shader
// dieselbe Licht-Dichte vom letzten Punkt aus nach. Erwartungswert unverändert (Test `portal_nee_*`), Varianz im Raum viel
// kleiner. Ein Licht, das nicht in der Liste steht (Obergrenzen unten), hat die Licht-Dichte 0 und wird wie bisher nur
// über die BRDF gefunden — die Kombination bleibt erwartungstreu.
//
// Tempo (gemessen mit lavapipe: die Schleife über alle Lichter kostete nachts mehr als der Schattenstrahl): je Licht ein
// vorgerechneter Satz (`GpuLight`: Mitte, Fläche, Normale, Hüllradius — kein Kreuzprodukt je Ecke und Licht), räumlich
// sortiert (Morton-Reihenfolge) in Gruppen zu `CLUSTER` Lichtern (`GpuCluster`: Hüllkugel, Gesamtfläche). Gewählt wird in
// zwei Stufen: Gruppe nach Gruppengewicht, darin das Licht nach Lichtgewicht; P_k = W_g / ΣW · w_k / Σ_g w. Das
// Gruppengewicht ist nur dann 0, wenn die ganze Hüllkugel hinter der Empfängerfläche liegt (dann tragen auch alle Lichter
// darin nichts bei) — die Wahl bleibt erwartungstreu. Kosten je Ecke: Gruppen + ein Gruppeninhalt statt aller Lichter.
// Gelistete Dreiecke tragen ihren Licht-Index in den unteren 16 Bit von `GpuTriTex::tex` (Glas und Leuchten lesen keine
// Bildkarte), damit der Shader nach einem BRDF-Treffer dieselbe Dichte nachrechnen kann.
//
// Raumlicht (`LIGHT_CEILING`): nach unten gerichtete, waagrechte bis mässig geneigte Flächen (|n.y| ≥ 0.7) mit 1.8 … 6 m
// freiem Raum darunter (Deckenuntersichten, Dachschrägen über Räumen; nicht die verdeckten Schichten im Deckenpaket, nicht
// Tischplatten, nicht das Gelände) strahlen nur nach unten. Es ist ein reines NEE-Licht: für Blick- und BRDF-Strahlen
// unsichtbar (die Decke selbst bleibt eine gewöhnliche Fläche), daher ohne MIS. Nur bei Nacht und nur, wenn das Modell
// keine Leuchten kennt (`gpu_pathtrace`), abschaltbar.

use std::collections::HashSet;

use crate::bvh::{Bvh, GpuTri, MAT_EMISSIVE, MAT_GLASS};

/// Art eines Lichts in der Liste (Reihenfolge der Bereiche im Index-Puffer).
pub const LIGHT_PORTAL: u32 = 0;
pub const LIGHT_EMITTER: u32 = 1;
pub const LIGHT_CEILING: u32 = 2;

/// Obergrenzen je Art (der Shader läuft je Pfad-Ecke einmal über die eingeschalteten Bereiche).
pub const MAX_PORTALS: usize = 256;
pub const MAX_EMITTERS: usize = 128;
pub const MAX_CEILINGS: usize = 512;
/// Kleinere Glasflächen (Stirnseiten der Scheiben) sind keine Portale.
pub const MIN_PORTAL_AREA: f32 = 0.01;
/// Reichweite des Raumlichts (m): weiter weg wählt die Lichtwahl es nicht (nachts sonst Schattenstrahlen von jedem Punkt
/// draussen zu Decken im Haus).
pub const CEILING_RANGE: f32 = 8.0;
/// Freier Raum unter einer Deckenuntersicht (m), damit sie Raumlicht wird.
pub const CEILING_MIN_DROP: f32 = 1.8;
pub const CEILING_MAX_DROP: f32 = 6.0;
/// Bit in `GpuTriTex::tex`: Dreieck steht in der Lichtliste (Portal oder Leuchte; MIS im Shader); die unteren 16 Bit sind
/// dann der Licht-Index.
pub const LISTED_BIT: u32 = 1 << 25;
/// Lichter je Gruppe (jede Art beginnt mit einer neuen Gruppe; aufgefüllt mit leeren Sätzen, Fläche 0).
pub const CLUSTER: usize = 16;

/// Vorgerechnetes Licht, 48 Byte, 1:1 zum WGSL-`Light`: Mitte, Fläche, Einheitsnormale (Windung des Baums), Radius der
/// Hüllkugel um die Mitte, Dreiecks-Index im Baum, Art.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
#[cfg_attr(feature = "render", derive(bytemuck::Pod, bytemuck::Zeroable))]
pub struct GpuLight {
    pub c: [f32; 3],
    pub area: f32,
    pub n: [f32; 3],
    pub r: f32,
    pub tri: u32,
    pub kind: u32,
    pub _pad: [u32; 2],
}

/// Lichtgruppe, 32 Byte, 1:1 zum WGSL-`Cluster`: Hüllkugel (Mitte, Radius) über die Hüllkugeln der Lichter, Gesamtfläche,
/// Art, erstes Licht, Zahl.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
#[cfg_attr(feature = "render", derive(bytemuck::Pod, bytemuck::Zeroable))]
pub struct GpuCluster {
    pub c: [f32; 3],
    pub r: f32,
    pub area: f32,
    pub kind: u32,
    pub first: u32,
    pub count: u32,
}

/// Lichtliste: Sätze (Bereiche Portale | Leuchten | Decken, je auf `CLUSTER` aufgefüllt), Gruppen, Zahl der echten
/// Lichter und der Gruppen je Art.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct LightList {
    pub lights: Vec<GpuLight>,
    pub clusters: Vec<GpuCluster>,
    pub counts: [u32; 3],
    pub cluster_counts: [u32; 3],
}

impl LightList {
    pub fn is_empty(&self) -> bool {
        self.lights.is_empty()
    }
    /// Ein Puffer für den Shader (höchstens 8 Speicher-Puffer je Stufe): erst die Gruppen im Satz-Format (`tri` = erstes
    /// Licht, `_pad[0]` = Zahl, beide als Index in diesen Puffer), dahinter die Lichter.
    pub fn gpu_records(&self) -> Vec<GpuLight> {
        let ncl = self.clusters.len() as u32;
        let mut out: Vec<GpuLight> =
            self.clusters.iter().map(|g| GpuLight { c: g.c, area: g.area, n: [0.0; 3], r: g.r, tri: g.first + ncl, kind: g.kind, _pad: [g.count, 0] }).collect();
        out.extend_from_slice(&self.lights);
        out
    }

    /// Echte Lichter einer Art (ohne Auffüllung).
    pub fn of_kind(&self, kind: u32) -> impl Iterator<Item = &GpuLight> + '_ {
        self.lights.iter().filter(move |l| l.kind == kind && l.area > 0.0)
    }
}

fn sub(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
fn add(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}
fn scale(a: [f32; 3], s: f32) -> [f32; 3] {
    [a[0] * s, a[1] * s, a[2] * s]
}
fn cross(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}
fn dot(a: [f32; 3], b: [f32; 3]) -> f32 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

/// Fläche und Einheitsnormale (Windung des Baums) eines Dreiecks; None bei entartetem.
pub fn tri_area_normal(t: &GpuTri) -> Option<(f32, [f32; 3])> {
    let c = cross(t.e1, t.e2);
    let len = dot(c, c).sqrt();
    (len.is_finite() && len > 1e-12).then(|| (0.5 * len, scale(c, 1.0 / len)))
}

/// Satz eines Lichts aus seinem Dreieck (None bei entartetem).
pub fn light_record(t: &GpuTri, tri: u32, kind: u32) -> Option<GpuLight> {
    let (area, n) = tri_area_normal(t)?;
    let c = add(t.v0, scale(add(t.e1, t.e2), 1.0 / 3.0));
    let r = [t.v0, add(t.v0, t.e1), add(t.v0, t.e2)].iter().map(|v| dot(sub(*v, c), sub(*v, c)).sqrt()).fold(0.0f32, f32::max);
    Some(GpuLight { c, area, n, r, tri, kind, _pad: [0; 2] })
}

/// Auswahlgewicht eines Lichts für den Empfänger p mit (geometrischer) Normale n — 1:1 `lweight` im Shader. 0 nur, wenn
/// das Licht sicher nichts beiträgt (Hüllkugel hinter der Empfängerfläche; Raumlicht: p nicht unter der Decke; leerer
/// Satz), sonst > 0 (MIS bleibt erwartungstreu). `power` = Leistung je Strahldichte-Einheit der Art.
pub fn light_weight(l: &GpuLight, power: f32, p: [f32; 3], n: [f32; 3]) -> f32 {
    if !(l.area > 0.0) {
        return 0.0;
    }
    let dv = sub(l.c, p);
    if !(dot(dv, n) + l.r > 0.0) {
        return 0.0;
    }
    if l.kind == LIGHT_PORTAL && !(dot(dv, l.n) > 0.0) {
        // Portal wirkt nur nach innen (Normale zum Himmel, `orient_portal`).
        return 0.0;
    }
    if l.kind == LIGHT_CEILING {
        let nd = if l.n[1] > 0.0 { scale(l.n, -1.0) } else { l.n };
        if !(dot(scale(dv, -1.0), nd) > 0.0) || dot(dv, dv) > CEILING_RANGE * CEILING_RANGE {
            return 0.0;
        }
    }
    let d2 = dot(dv, dv).max(1e-12);
    let d = d2.sqrt();
    let cl = dot(l.n, dv).abs() / d;
    let cr = (dot(n, dv) / d).max(0.0);
    power * l.area * cl.max(0.1) / d2.max(l.area) * (0.25 + cr)
}

/// Gruppengewicht (1:1 `cweight` im Shader): wie ein Licht mit der Gesamtfläche an der Kugelmitte, ohne Licht-Kosinus;
/// 0 nur, wenn die ganze Hüllkugel hinter der Empfängerfläche liegt.
pub fn cluster_weight(g: &GpuCluster, power: f32, p: [f32; 3], n: [f32; 3]) -> f32 {
    if !(g.area > 0.0) {
        return 0.0;
    }
    let dv = sub(g.c, p);
    if !(dot(dv, n) + g.r > 0.0) {
        return 0.0;
    }
    let d2 = dot(dv, dv).max(1e-12);
    if g.kind == LIGHT_CEILING && d2.sqrt() - g.r > CEILING_RANGE {
        return 0.0;
    }
    let cr = (dot(n, dv) / d2.sqrt()).max(0.0);
    power * g.area / d2.max(g.area) * (0.25 + cr)
}

/// Punkt auf dem Dreieck aus zwei Zufallszahlen (gleichverteilt, wie der Shader).
pub fn sample_point(t: &GpuTri, r1: f32, r2: f32) -> [f32; 3] {
    let s = r1.max(0.0).sqrt();
    add(t.v0, add(scale(t.e1, s * (1.0 - r2)), scale(t.e2, s * r2)))
}

/// Dichte (Raumwinkel) der Richtung zu einem Punkt im Abstand `dist` auf Licht `t` bei Wahl-Wahrscheinlichkeit `pick`.
pub fn solid_angle_pdf(t: &GpuTri, pick: f32, dist: f32, dir: [f32; 3]) -> f32 {
    let Some((area, nl)) = tri_area_normal(t) else { return 0.0 };
    let cl = dot(nl, dir).abs();
    if cl < 1e-6 {
        return 0.0;
    }
    pick * dist * dist / (cl * area)
}

/// Schlüssel einer Glasfläche unabhängig von der Seite der Scheibe: Ebenen-Richtung und der in die Ebene projizierte
/// Umriss (1 cm Raster). Vorder- und Rückseite einer Scheibe (Abstand Millimeter) haben denselben Schlüssel.
fn pane_key(t: &GpuTri, nl: [f32; 3]) -> Option<[i64; 8]> {
    let mut n = nl;
    let first = n.iter().copied().find(|c| c.abs() > 1e-3).unwrap_or(1.0);
    if first < 0.0 {
        n = scale(n, -1.0);
    }
    let a = if n[0].abs() < 0.9 { [1.0, 0.0, 0.0] } else { [0.0, 1.0, 0.0] };
    let u = cross(n, a);
    let ul = dot(u, u).sqrt();
    if !(ul > 1e-9) {
        return None;
    }
    let u = scale(u, 1.0 / ul);
    let v = cross(n, u);
    let q = |x: f32| (x as f64 * 100.0).round() as i64;
    let mut pts = [t.v0, add(t.v0, t.e1), add(t.v0, t.e2)].map(|p| [q(dot(p, u)), q(dot(p, v))]);
    pts.sort();
    let nq = n.map(|c| (c as f64 * 100.0).round() as i64);
    Some([nq[0], nq[1], pts[0][0], pts[0][1], pts[1][0], pts[1][1], pts[2][0] * 1_000_003 + pts[2][1], nq[2]])
}

/// Freier Fall unter einem Punkt (m) bis zur nächsten Fläche; None = nichts darunter.
fn drop_below(bvh: &Bvh, q: [f32; 3]) -> Option<f32> {
    bvh.intersect([q[0], q[1] - 1e-3, q[2]], [0.0, -1.0, 0.0], CEILING_MAX_DROP * 2.0).map(|(t, _)| t + 1e-3)
}

/// Erreicht ein Strahl den Himmel? Glas lässt ihn durch (bis 8 Scheiben).
fn escapes(bvh: &Bvh, mut o: [f32; 3], d: [f32; 3]) -> bool {
    for _ in 0..8 {
        match bvh.intersect(o, d, 1e4) {
            None => return true,
            Some((t, i)) if bvh.tris[i].mat >> 24 == MAT_GLASS => o = add(o, scale(d, t + 1e-3)),
            Some(_) => return false,
        }
    }
    false
}

/// Seite einer Scheibe, auf der der Himmel liegt: Normale dorthin gedreht; None, wenn von keiner Seite Himmel zu sehen
/// ist (Glas im Innern: kein Portal). Je Seite 9 Strahlen von der Mitte in die Halbkugel (etwas aufwärts geneigt).
fn orient_portal(bvh: &Bvh, l: &GpuLight) -> Option<[f32; 3]> {
    let open = |s: f32| {
        let n = scale(l.n, s);
        let a = if n[0].abs() < 0.9 { [1.0, 0.0, 0.0] } else { [0.0, 1.0, 0.0] };
        let u = cross(n, a);
        let u = scale(u, 1.0 / dot(u, u).sqrt().max(1e-9));
        let v = cross(n, u);
        let o = add(l.c, scale(n, 0.05));
        let mut k = 0;
        for i in 0..9 {
            let (x, y) = ((i % 3) as f32 - 1.0, (i / 3) as f32 - 1.0);
            let mut d = add(add(n, scale(u, 0.7 * x)), scale(v, 0.7 * y));
            d[1] += 0.3;
            let len = dot(d, d).sqrt();
            if dot(d, n) > 0.05 && escapes(bvh, o, scale(d, 1.0 / len)) {
                k += 1;
            }
        }
        k
    };
    let (a, b) = (open(1.0), open(-1.0));
    match (a, b) {
        (0, 0) => None,
        _ if a >= b => Some(l.n),
        _ => Some(scale(l.n, -1.0)),
    }
}

/// Raumlicht-Kandidat: Untersicht mit Platz darunter (s. Moduldoc).
fn is_ceiling(bvh: &Bvh, t: &GpuTri, nl: [f32; 3]) -> bool {
    if nl[1].abs() < 0.7 {
        return false;
    }
    let c = add(t.v0, scale(add(t.e1, t.e2), 1.0 / 3.0));
    let probes = [c, scale(add(c, t.v0), 0.5), scale(add(c, add(t.v0, t.e1)), 0.5), scale(add(c, add(t.v0, t.e2)), 0.5)];
    probes.iter().any(|q| drop_below(bvh, *q).is_some_and(|d| (CEILING_MIN_DROP..=CEILING_MAX_DROP).contains(&d)))
}

/// Morton-Schlüssel (10 Bit je Achse) einer Lage in der Box [lo, hi].
fn morton(p: [f32; 3], lo: [f32; 3], hi: [f32; 3]) -> u32 {
    let spread = |v: u32| {
        let mut x = v & 0x3FF;
        x = (x | (x << 16)) & 0x030000FF;
        x = (x | (x << 8)) & 0x0300F00F;
        x = (x | (x << 4)) & 0x030C30C3;
        (x | (x << 2)) & 0x09249249
    };
    let q = |k: usize| (((p[k] - lo[k]) / (hi[k] - lo[k]).max(1e-6)).clamp(0.0, 1.0) * 1023.0) as u32;
    spread(q(0)) | (spread(q(1)) << 1) | (spread(q(2)) << 2)
}

/// Lichtliste aus dem Baum: Glasflächen ≥ `MIN_PORTAL_AREA` (je Scheibe eine Seite), Leuchten, Deckenuntersichten
/// (s. Moduldoc), je Art die grössten bis zur Obergrenze, räumlich sortiert und in Gruppen. Setzt `LISTED_BIT` und den
/// Licht-Index in `bvh.tex` für Portale und Leuchten.
pub fn build_lights(bvh: &mut Bvh) -> LightList {
    let mut portals: Vec<(f32, u32)> = Vec::new();
    let mut emitters: Vec<(f32, u32)> = Vec::new();
    let mut ceilings: Vec<(f32, u32)> = Vec::new();
    let mut panes: HashSet<[i64; 8]> = HashSet::new();
    for (i, t) in bvh.tris.iter().enumerate() {
        let Some((area, nl)) = tri_area_normal(t) else { continue };
        match t.mat >> 24 {
            MAT_GLASS => {
                if area >= MIN_PORTAL_AREA && pane_key(t, nl).is_some_and(|k| panes.insert(k)) {
                    portals.push((area, i as u32));
                }
            }
            MAT_EMISSIVE => {
                let c = crate::bvh::unpack_linear(t.mat);
                emitters.push((area * (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]).max(1e-4), i as u32));
            }
            _ => {
                if area >= 0.01 && is_ceiling(bvh, t, nl) {
                    ceilings.push((area, i as u32));
                }
            }
        }
    }
    let (lo, hi) = bvh.nodes.first().map_or(([0.0; 3], [1.0; 3]), |r| (r.min, r.max));
    let mut out = LightList::default();
    for (k, (mut list, cap)) in [(portals, MAX_PORTALS), (emitters, MAX_EMITTERS), (ceilings, MAX_CEILINGS)].into_iter().enumerate() {
        // Grösste zuerst (stabil nach Index bei gleicher Grösse), dann räumlich sortiert.
        list.sort_by(|a, b| b.0.total_cmp(&a.0).then(a.1.cmp(&b.1)));
        list.truncate(cap);
        let mut recs: Vec<GpuLight> = list.iter().filter_map(|&(_, i)| light_record(&bvh.tris[i as usize], i, k as u32)).collect();
        if k as u32 == LIGHT_PORTAL {
            // Normale zum Himmel; Glas ohne Himmel auf beiden Seiten fällt weg.
            recs = recs.into_iter().filter_map(|l| orient_portal(bvh, &l).map(|n| GpuLight { n, ..l })).collect();
        }
        recs.sort_by_key(|l| (morton(l.c, lo, hi), l.tri));
        out.counts[k] = recs.len() as u32;
        for chunk in recs.chunks(CLUSTER) {
            let first = out.lights.len() as u32;
            let area: f32 = chunk.iter().map(|l| l.area).sum();
            let c = scale(chunk.iter().fold([0.0; 3], |a, l| add(a, scale(l.c, l.area))), 1.0 / area.max(1e-12));
            let r = chunk.iter().map(|l| dot(sub(l.c, c), sub(l.c, c)).sqrt() + l.r).fold(0.0f32, f32::max);
            out.clusters.push(GpuCluster { c, r: r * 1.0001 + 1e-5, area, kind: k as u32, first, count: CLUSTER as u32 });
            out.lights.extend_from_slice(chunk);
            out.lights.resize(first as usize + CLUSTER, GpuLight { kind: k as u32, ..GpuLight::default() });
            out.cluster_counts[k] += 1;
        }
    }
    // Index im Shader-Puffer (`gpu_records`: Gruppen vorn).
    let ncl = out.clusters.len();
    for (li, l) in out.lights.iter().enumerate() {
        if l.area > 0.0 && l.kind != LIGHT_CEILING {
            let t = &mut bvh.tex[l.tri as usize];
            t.tex = (t.tex & !0xFFFF) | LISTED_BIT | (ncl + li) as u32;
        }
    }
    out
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::bvh::{PtTri, GLASS_RGB, NO_UV};

    /// Rechteck (zwei Dreiecke) aus Ecke und zwei Kanten.
    pub(crate) fn quad(o: [f32; 3], a: [f32; 3], b: [f32; 3], color: [f32; 3]) -> [PtTri; 2] {
        let p1 = add(o, a);
        let p2 = add(add(o, a), b);
        let p3 = add(o, b);
        [PtTri { v: [o, p1, p2], color, layer: -1, uv: NO_UV }, PtTri { v: [o, p2, p3], color, layer: -1, uv: NO_UV }]
    }

    /// Geschlossener Raum 4 × 2.6 × 4 m (Boden y = 0) mit einem Fenster 1.6 × 1.2 m in der Wand z = 0 (Glas als
    /// Scheibe aus zwei Flächen 8 mm auseinander), darüber eine Decke als eigene Schicht (Untersicht in 2.6 m) und eine
    /// verdeckte zweite Schicht darüber.
    pub(crate) fn room() -> Vec<PtTri> {
        let w = [0.85, 0.85, 0.83];
        let mut t = Vec::new();
        t.extend(quad([0.0, 0.0, 0.0], [4.0, 0.0, 0.0], [0.0, 0.0, 4.0], w)); // Boden
        t.extend(quad([0.0, 2.6, 0.0], [4.0, 0.0, 0.0], [0.0, 0.0, 4.0], w)); // Decke (Untersicht)
        t.extend(quad([0.0, 2.8, 0.0], [4.0, 0.0, 0.0], [0.0, 0.0, 4.0], w)); // verdeckte Schicht
        t.extend(quad([0.0, 0.0, 4.0], [4.0, 0.0, 0.0], [0.0, 2.6, 0.0], w)); // Rückwand
        t.extend(quad([0.0, 0.0, 0.0], [0.0, 0.0, 4.0], [0.0, 2.6, 0.0], w)); // links
        t.extend(quad([4.0, 0.0, 0.0], [0.0, 0.0, 4.0], [0.0, 2.6, 0.0], w)); // rechts
        // Wand z = 0 mit Öffnung x 1.2..2.8, y 0.8..2.0.
        t.extend(quad([0.0, 0.0, 0.0], [1.2, 0.0, 0.0], [0.0, 2.6, 0.0], w));
        t.extend(quad([2.8, 0.0, 0.0], [1.2, 0.0, 0.0], [0.0, 2.6, 0.0], w));
        t.extend(quad([1.2, 0.0, 0.0], [1.6, 0.0, 0.0], [0.0, 0.8, 0.0], w));
        t.extend(quad([1.2, 2.0, 0.0], [1.6, 0.0, 0.0], [0.0, 0.6, 0.0], w));
        t.extend(quad([1.2, 0.8, 0.0], [1.6, 0.0, 0.0], [0.0, 1.2, 0.0], GLASS_RGB));
        t.extend(quad([1.2, 0.8, -0.008], [1.6, 0.0, 0.0], [0.0, 1.2, 0.0], GLASS_RGB));
        // Stirnseite der Scheibe (zu klein für ein Portal).
        t.extend(quad([1.2, 0.8, -0.008], [1.6, 0.0, 0.0], [0.0, 0.0, 0.008], GLASS_RGB));
        t
    }

    #[test]
    fn liste_portale_und_decke() {
        let mut bvh = Bvh::build(&room());
        let lights = build_lights(&mut bvh);
        // Eine Seite der Scheibe (2 Dreiecke), keine Stirnseite; Decke: nur die Untersicht in 2.6 m (2 Dreiecke).
        assert_eq!(lights.counts, [2, 0, 2], "{lights:?}");
        assert_eq!(lights.cluster_counts, [1, 0, 1]);
        assert_eq!(lights.lights.len(), 2 * CLUSTER, "je Art auf ganze Gruppen aufgefüllt");
        for (li, l) in lights.lights.iter().enumerate().filter(|(_, l)| l.area > 0.0) {
            let t = &bvh.tris[l.tri as usize];
            let tex = bvh.tex[l.tri as usize].tex;
            if l.kind == LIGHT_PORTAL {
                assert_eq!(t.mat >> 24, MAT_GLASS);
                assert_eq!((tex & LISTED_BIT != 0, tex & 0xFFFF), (true, (lights.clusters.len() + li) as u32), "Licht-Index im Dreieck");
                assert_eq!(lights.gpu_records()[(tex & 0xFFFF) as usize], *l);
            } else {
                assert!((t.v0[1] - 2.6).abs() < 1e-6, "Untersicht, nicht die verdeckte Schicht");
                assert!(tex & LISTED_BIT == 0, "Raumlicht ohne MIS");
            }
            // Gruppenkugel umschliesst die Lichtkugel.
            let g = lights.clusters.iter().find(|g| (g.first..g.first + g.count).contains(&(li as u32))).unwrap();
            assert!(dot(sub(l.c, g.c), sub(l.c, g.c)).sqrt() + l.r <= g.r);
        }
        // Leere Szene: leere Liste.
        let mut e = Bvh::default();
        assert!(build_lights(&mut e).is_empty());
    }

    #[test]
    fn gewichte_null_nur_ohne_beitrag() {
        let mut bvh = Bvh::build(&room());
        let lights = build_lights(&mut bvh);
        let portal = *lights.of_kind(LIGHT_PORTAL).next().unwrap();
        let ceil = *lights.of_kind(LIGHT_CEILING).next().unwrap();
        let floor_p = [2.0, 0.0, 2.0];
        let up = [0.0, 1.0, 0.0];
        assert!(light_weight(&portal, 1.0, floor_p, up) > 0.0);
        // Portal zeigt nach aussen (Fenster in der Wand z = 0, Raum bei z > 0): von draussen kein Gewicht.
        assert!(portal.n[2] < -0.99, "{:?}", portal.n);
        assert_eq!(light_weight(&portal, 1.0, [2.0, 1.0, -2.0], [0.0, 0.0, 1.0]), 0.0);
        // Kamera-Lage: im Raum ja, draussen (vor dem Fenster, über dem Dach) nein.
        assert!(bvh.encloses([2.0, 1.5, 2.0]));
        assert!(!bvh.encloses([2.0, 1.5, -3.0]) && !bvh.encloses([2.0, 4.0, 2.0]));
        // Raumlicht nur in Reichweite.
        assert_eq!(light_weight(&ceil, 1.0, [2.0, 0.0, 2.0 + CEILING_RANGE + 2.0], up), 0.0);
        assert!(light_weight(&ceil, 1.0, floor_p, up) > 0.0);
        // Hinter der Empfängerfläche: 0 (Licht und Gruppe).
        // (Hüllkugel ganz hinter der Fläche; die Kugel ist grob, darum ein Punkt weit unter dem Fenster.)
        let below = [2.0, -1.5, 2.0];
        assert_eq!(light_weight(&portal, 1.0, below, [0.0, -1.0, 0.0]), 0.0);
        assert_eq!(cluster_weight(&lights.clusters[0], 1.0, below, [0.0, -1.0, 0.0]), 0.0);
        assert!(cluster_weight(&lights.clusters[0], 1.0, floor_p, up) > 0.0);
        // Über der Decke: kein Raumlicht.
        assert_eq!(light_weight(&ceil, 1.0, [2.0, 3.0, 2.0], [0.0, -1.0, 0.0]), 0.0);
        // Näher = schwerer.
        let near = light_weight(&portal, 1.0, [2.0, 1.0, 0.5], [0.0, 0.0, -1.0]);
        let far = light_weight(&portal, 1.0, [2.0, 1.0, 3.5], [0.0, 0.0, -1.0]);
        assert!(near > far && far > 0.0);
        // Leerer Satz / NaN: 0, kein Panic.
        let bad = GpuLight { c: [f32::NAN; 3], ..portal };
        assert_eq!(light_weight(&bad, 1.0, floor_p, up), 0.0);
        assert_eq!(light_weight(&GpuLight::default(), 1.0, floor_p, up), 0.0);
        assert!(light_record(&GpuTri::default(), 0, LIGHT_PORTAL).is_none());
        // Erwartungstreue der Auswahl: jedes Licht mit Beitrag hat eine Wahrscheinlichkeit > 0 — Gruppe > 0, wo ein Licht > 0.
        let mut r = 0x9e3779b9u64;
        for _ in 0..2000 {
            let mut f = || {
                r ^= r << 13;
                r ^= r >> 7;
                r ^= r << 17;
                (r >> 40) as f32 / (1u64 << 24) as f32
            };
            let p = [f() * 6.0 - 1.0, f() * 4.0 - 1.0, f() * 6.0 - 1.0];
            let mut n = [f() - 0.5, f() - 0.5, f() - 0.5];
            let l = dot(n, n).sqrt().max(1e-6);
            n = scale(n, 1.0 / l);
            for g in &lights.clusters {
                let any = lights.lights[g.first as usize..(g.first + g.count) as usize].iter().any(|l| light_weight(l, 1.0, p, n) > 0.0);
                assert!(!any || cluster_weight(g, 1.0, p, n) > 0.0, "{p:?} {n:?}");
            }
        }
    }
}
