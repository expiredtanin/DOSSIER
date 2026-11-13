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
pub const MAX_CEILINGS: usize = 256;
/// Kleinere Glasflächen (Stirnseiten der Scheiben) sind keine Portale.
pub const MIN_PORTAL_AREA: f32 = 0.01;
/// Freier Raum unter einer Deckenuntersicht (m), damit sie Raumlicht wird.
pub const CEILING_MIN_DROP: f32 = 1.8;
pub const CEILING_MAX_DROP: f32 = 6.0;
/// Bit in `GpuTriTex::tex`: Dreieck steht in der Lichtliste (Portal oder Leuchte; MIS im Shader).
pub const LISTED_BIT: u32 = 1 << 25;

/// Lichtliste: Dreiecks-Indizes in den Baum (`Bvh::tris`), Bereiche [Portale | Leuchten | Decken].
#[derive(Clone, Debug, Default, PartialEq)]
pub struct LightList {
    pub idx: Vec<u32>,
    pub counts: [u32; 3],
}

impl LightList {
    pub fn is_empty(&self) -> bool {
        self.idx.is_empty()
    }
    /// Index-Bereich einer Art in `idx`.
    pub fn range(&self, kind: u32) -> std::ops::Range<usize> {
        let c = self.counts.map(|c| c as usize);
        match kind {
            LIGHT_PORTAL => 0..c[0],
            LIGHT_EMITTER => c[0]..c[0] + c[1],
            _ => c[0] + c[1]..c[0] + c[1] + c[2],
        }
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

/// Auswahlgewicht eines Lichts für den Empfänger p mit (geometrischer) Normale n — 1:1 `lweight` im Shader. 0 nur, wenn
/// das Licht sicher nichts beiträgt (alle Ecken hinter der Empfängerfläche; Raumlicht: p nicht unter der Decke), sonst
/// > 0 (MIS bleibt erwartungstreu). `power` = Leistung je Strahldichte-Einheit der Art (Himmel, Leuchtfarbe, Raumlicht).
pub fn light_weight(t: &GpuTri, kind: u32, power: f32, p: [f32; 3], n: [f32; 3]) -> f32 {
    let v1 = add(t.v0, t.e1);
    let v2 = add(t.v0, t.e2);
    let front = dot(sub(t.v0, p), n).max(dot(sub(v1, p), n)).max(dot(sub(v2, p), n));
    if !(front > 0.0) {
        return 0.0;
    }
    let Some((area, nl)) = tri_area_normal(t) else { return 0.0 };
    if kind == LIGHT_CEILING {
        let nd = if nl[1] > 0.0 { scale(nl, -1.0) } else { nl };
        if !(dot(sub(p, t.v0), nd) > 0.0) {
            return 0.0;
        }
    }
    let c = add(t.v0, scale(add(t.e1, t.e2), 1.0 / 3.0));
    let dv = sub(c, p);
    let d2 = dot(dv, dv).max(1e-12);
    let d = d2.sqrt();
    let cl = dot(nl, dv).abs() / d;
    let cr = (dot(n, dv) / d).max(0.0);
    power * area * cl.max(0.1) / d2.max(area) * (0.25 + cr)
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

/// Raumlicht-Kandidat: Untersicht mit Platz darunter (s. Moduldoc).
fn is_ceiling(bvh: &Bvh, t: &GpuTri, nl: [f32; 3]) -> bool {
    if nl[1].abs() < 0.7 {
        return false;
    }
    let c = add(t.v0, scale(add(t.e1, t.e2), 1.0 / 3.0));
    let probes = [c, scale(add(c, t.v0), 0.5), scale(add(c, add(t.v0, t.e1)), 0.5), scale(add(c, add(t.v0, t.e2)), 0.5)];
    probes.iter().any(|q| drop_below(bvh, *q).is_some_and(|d| (CEILING_MIN_DROP..=CEILING_MAX_DROP).contains(&d)))
}

/// Lichtliste aus dem Baum: Glasflächen ≥ `MIN_PORTAL_AREA` (je Scheibe eine Seite), Leuchten, Deckenuntersichten
/// (s. Moduldoc), je Art die grössten bis zur Obergrenze. Setzt `LISTED_BIT` in `bvh.tex` für Portale und Leuchten.
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
                if is_ceiling(bvh, t, nl) {
                    ceilings.push((area, i as u32));
                }
            }
        }
    }
    let mut out = LightList::default();
    for (k, (mut list, cap)) in [(portals, MAX_PORTALS), (emitters, MAX_EMITTERS), (ceilings, MAX_CEILINGS)].into_iter().enumerate() {
        // Grösste zuerst (stabil nach Index bei gleicher Grösse), dann in Baum-Reihenfolge (Speicherzugriff).
        list.sort_by(|a, b| b.0.total_cmp(&a.0).then(a.1.cmp(&b.1)));
        list.truncate(cap);
        let mut idx: Vec<u32> = list.into_iter().map(|(_, i)| i).collect();
        idx.sort_unstable();
        out.counts[k] = idx.len() as u32;
        if k != LIGHT_CEILING as usize {
            for &i in &idx {
                bvh.tex[i as usize].tex |= LISTED_BIT;
            }
        }
        out.idx.extend(idx);
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
        for i in lights.range(LIGHT_PORTAL) {
            let t = &bvh.tris[lights.idx[i] as usize];
            assert_eq!(t.mat >> 24, MAT_GLASS);
            assert!(bvh.tex[lights.idx[i] as usize].tex & LISTED_BIT != 0);
        }
        for i in lights.range(LIGHT_CEILING) {
            let t = &bvh.tris[lights.idx[i] as usize];
            assert!((t.v0[1] - 2.6).abs() < 1e-6, "Untersicht, nicht die verdeckte Schicht");
            assert!(bvh.tex[lights.idx[i] as usize].tex & LISTED_BIT == 0, "Raumlicht ohne MIS");
        }
        // Leere Szene: leere Liste.
        let mut e = Bvh::default();
        assert!(build_lights(&mut e).is_empty());
    }

    #[test]
    fn gewichte_null_nur_ohne_beitrag() {
        let mut bvh = Bvh::build(&room());
        let lights = build_lights(&mut bvh);
        let portal = bvh.tris[lights.idx[0] as usize];
        let ceil = bvh.tris[lights.idx[lights.range(LIGHT_CEILING).start] as usize];
        let floor_p = [2.0, 0.0, 2.0];
        let up = [0.0, 1.0, 0.0];
        assert!(light_weight(&portal, LIGHT_PORTAL, 1.0, floor_p, up) > 0.0);
        assert!(light_weight(&ceil, LIGHT_CEILING, 1.0, floor_p, up) > 0.0);
        // Hinter der Empfängerfläche: 0.
        assert_eq!(light_weight(&portal, LIGHT_PORTAL, 1.0, floor_p, [0.0, -1.0, 0.0]), 0.0);
        // Über der Decke: kein Raumlicht.
        assert_eq!(light_weight(&ceil, LIGHT_CEILING, 1.0, [2.0, 3.0, 2.0], [0.0, -1.0, 0.0]), 0.0);
        // Näher = schwerer.
        let near = light_weight(&portal, LIGHT_PORTAL, 1.0, [2.0, 1.0, 0.5], [0.0, 0.0, -1.0]);
        let far = light_weight(&portal, LIGHT_PORTAL, 1.0, [2.0, 1.0, 3.5], [0.0, 0.0, -1.0]);
        assert!(near > far && far > 0.0);
        // Entartet / NaN: 0, kein Panic.
        let bad = GpuTri { v0: [f32::NAN; 3], ..portal };
        assert_eq!(light_weight(&bad, LIGHT_PORTAL, 1.0, floor_p, up), 0.0);
        assert_eq!(light_weight(&GpuTri::default(), LIGHT_PORTAL, 1.0, floor_p, up), 0.0);
    }
}
