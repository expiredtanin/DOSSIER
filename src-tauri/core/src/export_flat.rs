//! Gemeinsames für die Export-Sammler im Kern ([K4], [B5], [C11]): der flache Puffer, den die
//! Schreiber in `src-tauri/fileio` lesen (Zahlen + Zeichenkettenliste, Kodierung dort in
//! `ifc_export.rs`/`mesh_export.rs`), die Byte-Hülle für die Übergabe an TS und Netz-Helfer
//! (Wicklung nach aussen, Volumen). Port von `src/export/meshOrient.ts` und den Puffer-Klassen aus
//! `exportIfc.ts`/`exportMesh.ts`; Rechenreihenfolge wie dort, damit die Dateien zeichengleich bleiben.
//!
//! Byte-Hülle (little endian, alles f64 bis auf die Zeichenketten):
//! `[MAGIC, nZahlen, nBytes, Zahlen…, UTF-8 der Zeichenketten durch \0 getrennt]`. Fehler kommen als
//! Fehlerpuffer des Plan-Puffers (`plan_buf::encode_error`, `[ERR_MAGIC, n, UTF-16…]`).

use std::collections::HashMap;

/// Kennung der Byte-Hülle ("DXEF").
pub const MAGIC: f64 = 1_146_635_590.0;

/// Zahlenpuffer + Zeichenkettenliste (`FlatIfc`/`encodeScene` in TS).
#[derive(Debug, Default, Clone, PartialEq)]
pub struct Flat {
    pub nums: Vec<f64>,
    pub strings: Vec<String>,
}

impl Flat {
    pub fn new(version: f64) -> Self {
        Flat { nums: vec![version], strings: Vec::new() }
    }

    pub fn num(&mut self, v: f64) -> &mut Self {
        self.nums.push(v);
        self
    }

    pub fn nums(&mut self, v: &[f64]) -> &mut Self {
        self.nums.extend_from_slice(v);
        self
    }

    /// Zeichenkette anhängen (ohne `\0`, das trennt die Liste) und ihren Index liefern.
    pub fn str(&mut self, s: &str) -> f64 {
        self.strings.push(s.replace('\0', ""));
        (self.strings.len() - 1) as f64
    }

    /// Byte-Hülle für TS (s. Modulkopf).
    pub fn to_bytes(&self) -> Vec<u8> {
        let text = self.strings.join("\0");
        let mut out = Vec::with_capacity(24 + self.nums.len() * 8 + text.len());
        out.extend_from_slice(&MAGIC.to_le_bytes());
        out.extend_from_slice(&(self.nums.len() as f64).to_le_bytes());
        out.extend_from_slice(&(text.len() as f64).to_le_bytes());
        for v in &self.nums {
            out.extend_from_slice(&v.to_le_bytes());
        }
        out.extend_from_slice(text.as_bytes());
        out
    }
}

/// Liest die Byte-Hülle zurück (Tests).
pub fn from_bytes(b: &[u8]) -> Option<(Vec<f64>, String)> {
    let f = |i: usize| -> Option<f64> { Some(f64::from_le_bytes(b.get(i * 8..i * 8 + 8)?.try_into().ok()?)) };
    if f(0)? != MAGIC {
        return None;
    }
    let (n, len) = (f(1)? as usize, f(2)? as usize);
    let nums = (0..n).map(|i| f(3 + i)).collect::<Option<Vec<f64>>>()?;
    let at = 24 + n * 8;
    let text = String::from_utf8(b.get(at..at + len)?.to_vec()).ok()?;
    Some((nums, text))
}

/// Zahl als Schlüssel wie `String(v)` in JS: −0 = 0, alle NaN gleich.
pub fn js_key(v: f64) -> u64 {
    if v.is_nan() {
        f64::NAN.to_bits()
    } else {
        (v + 0.0).to_bits()
    }
}

/// Volumen eines geschlossenen Dreiecks-Netzes (Betrag der Summe der Tetraeder zum Ursprung, `meshVolume`).
pub fn mesh_volume(positions: &[f64], indices: &[u32]) -> f64 {
    let p = |i: usize| positions.get(i).copied().unwrap_or(f64::NAN);
    let mut v = 0.0;
    let mut i = 0;
    while i + 2 < indices.len() {
        let a = indices[i] as usize * 3;
        let b = indices[i + 1] as usize * 3;
        let c = indices[i + 2] as usize * 3;
        v += p(a) * (p(b + 1) * p(c + 2) - p(b + 2) * p(c + 1)) - p(a + 1) * (p(b) * p(c + 2) - p(b + 2) * p(c)) + p(a + 2) * (p(b) * p(c + 1) - p(b + 1) * p(c));
        i += 3;
    }
    v.abs() / 6.0
}

/// Richtet ein Dreiecks-Netz (Weltkoordinaten) so aus, dass die Flächennormalen nach AUSSEN zeigen
/// (`orientOutward`): Dreiecke werden über gemeinsame Kanten (Eckpunkte auf 0,01 mm verschweisst)
/// zu Zusammenhangs-Komponenten verbunden, jede Komponente zuerst in sich widerspruchsfrei gewickelt
/// (Nachbarn durchlaufen eine gemeinsame Kante gegenläufig) und dann nach dem Vorzeichen ihres
/// Volumens gedreht. Kanten mit mehr als zwei Dreiecken (Verschneidungen) verbinden nicht.
/// Indizes ausserhalb des Netzes lassen das Netz unverändert (kein Panic).
pub fn orient_outward(pos: &[f64], idx: &[u32]) -> Vec<u32> {
    let n_tri = idx.len() / 3;
    let n_vert = pos.len() / 3;
    if idx[..n_tri * 3].iter().any(|&i| i as usize >= n_vert) {
        return idx.to_vec();
    }
    let q = |v: f64| js_key(crate::jsnum::round(v * 1e5));
    let mut weld: HashMap<(u64, u64, u64), usize> = HashMap::new();
    let mut canon = vec![0usize; n_vert];
    for (i, c) in canon.iter_mut().enumerate() {
        let key = (q(pos[3 * i]), q(pos[3 * i + 1]), q(pos[3 * i + 2]));
        let next = weld.len();
        *c = *weld.entry(key).or_insert(next);
    }
    let n = weld.len() + 1;
    // Kante (min, max) → Einträge (Dreieck · 2 + vorwärts?), in der Reihenfolge des ersten Auftretens.
    let mut edge_at: HashMap<usize, usize> = HashMap::new();
    let mut edges: Vec<Vec<usize>> = Vec::new();
    let corner = |t: usize, k: usize| canon[idx[3 * t + k] as usize];
    for t in 0..n_tri {
        for k in 0..3 {
            let a = corner(t, k);
            let b = corner(t, (k + 1) % 3);
            if a == b {
                continue;
            }
            let key = a.min(b) * n + a.max(b);
            let entry = t * 2 + usize::from(a < b);
            match edge_at.get(&key) {
                Some(&e) => edges[e].push(entry),
                None => {
                    edge_at.insert(key, edges.len());
                    edges.push(vec![entry]);
                }
            }
        }
    }
    // Nachbarschaft über Kanten mit genau zwei Dreiecken: Wicklungs-Parität (1 = gegenläufig nötig).
    let mut adj: Vec<Vec<usize>> = vec![Vec::new(); n_tri];
    for list in &edges {
        if list.len() != 2 {
            continue;
        }
        let (e1, e2) = (list[0], list[1]);
        let (t1, t2) = (e1 >> 1, e2 >> 1);
        if t1 == t2 {
            continue;
        }
        let parity = usize::from((e1 & 1) == (e2 & 1));
        adj[t1].push(t2 * 2 + parity);
        adj[t2].push(t1 * 2 + parity);
    }
    let mut flip: Vec<i8> = vec![-1; n_tri];
    let mut out = idx.to_vec();
    for s in 0..n_tri {
        if flip[s] >= 0 {
            continue;
        }
        let mut comp = vec![s];
        flip[s] = 0;
        let mut h = 0;
        while h < comp.len() {
            let t = comp[h];
            for &e in &adj[t] {
                let u = e >> 1;
                if flip[u] < 0 {
                    flip[u] = flip[t] ^ (e & 1) as i8;
                    comp.push(u);
                }
            }
            h += 1;
        }
        let mut vol = 0.0;
        for &t in &comp {
            let (a, b, c) = if flip[t] != 0 { (idx[3 * t], idx[3 * t + 2], idx[3 * t + 1]) } else { (idx[3 * t], idx[3 * t + 1], idx[3 * t + 2]) };
            let (a, b, c) = (a as usize * 3, b as usize * 3, c as usize * 3);
            vol += pos[a] * (pos[b + 1] * pos[c + 2] - pos[b + 2] * pos[c + 1]) - pos[a + 1] * (pos[b] * pos[c + 2] - pos[b + 2] * pos[c]) + pos[a + 2] * (pos[b] * pos[c + 1] - pos[b + 1] * pos[c]);
        }
        let turn = i8::from(vol < 0.0);
        for &t in &comp {
            if flip[t] ^ turn != 0 {
                out[3 * t + 1] = idx[3 * t + 2];
                out[3 * t + 2] = idx[3 * t + 1];
            }
        }
    }
    out
}

/// `String.prototype.trim` (JS-Leerraum: Zs, Tab, VT, FF, BOM und Zeilenenden; anders als Rust ohne U+0085).
pub fn js_trim(s: &str) -> &str {
    let ws = |c: char| (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}';
    s.trim_matches(ws)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Würfel mit gemischter Wicklung (je zweites Dreieck gedreht).
    fn cube(mixed: bool) -> (Vec<f64>, Vec<u32>) {
        let pos = vec![0., 0., 0., 1., 0., 0., 1., 1., 0., 0., 1., 0., 0., 0., 1., 1., 0., 1., 1., 1., 1., 0., 1., 1.];
        let quads = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];
        let mut idx = Vec::new();
        for (k, q) in quads.iter().enumerate() {
            idx.extend([q[0], q[1], q[2]]);
            if mixed && k % 2 == 1 {
                idx.extend([q[0], q[3], q[2]]);
            } else {
                idx.extend([q[0], q[2], q[3]]);
            }
        }
        (pos, idx)
    }

    fn signed_volume(pos: &[f64], idx: &[u32]) -> f64 {
        let mut v = 0.0;
        for t in idx.chunks_exact(3) {
            let (a, b, c) = (t[0] as usize * 3, t[1] as usize * 3, t[2] as usize * 3);
            v += pos[a] * (pos[b + 1] * pos[c + 2] - pos[b + 2] * pos[c + 1]) - pos[a + 1] * (pos[b] * pos[c + 2] - pos[b + 2] * pos[c]) + pos[a + 2] * (pos[b] * pos[c + 1] - pos[b + 1] * pos[c]);
        }
        v / 6.0
    }

    #[test]
    fn wuerfel_wird_nach_aussen_gewickelt() {
        let (pos, idx) = cube(true);
        let out = orient_outward(&pos, &idx);
        assert!((signed_volume(&pos, &out) - 1.0).abs() < 1e-12);
        assert!((mesh_volume(&pos, &out) - 1.0).abs() < 1e-12);
        // Ganz umgedreht → wieder aussen.
        let rev: Vec<u32> = idx.chunks_exact(3).flat_map(|t| [t[0], t[2], t[1]]).collect();
        assert!((signed_volume(&pos, &orient_outward(&pos, &rev)) - 1.0).abs() < 1e-12);
    }

    #[test]
    fn unsinn_ohne_panik() {
        assert_eq!(orient_outward(&[0.0; 9], &[0, 1, 7]), vec![0, 1, 7]);
        assert!(orient_outward(&[], &[]).is_empty());
        assert_eq!(orient_outward(&[f64::NAN; 9], &[0, 1, 2]), vec![0, 1, 2]);
        assert!(mesh_volume(&[0.0; 3], &[0, 5, 9]).is_nan());
    }

    #[test]
    fn huelle_hin_und_zurueck() {
        let mut f = Flat::new(4.0);
        let a = f.str("Wand\0«ä»");
        f.num(a).nums(&[1.5, f64::NAN]);
        let i = f.str("x");
        f.num(i);
        let (nums, text) = from_bytes(&f.to_bytes()).unwrap();
        assert_eq!(nums.len(), 5);
        assert_eq!(nums[1], 0.0);
        assert!(nums[3].is_nan());
        assert_eq!(text, "Wand«ä»\0x");
    }

    #[test]
    fn trim_wie_js() {
        assert_eq!(js_trim("\u{feff} 20\t\n"), "20");
        assert_eq!(js_trim("\u{85}20"), "\u{85}20");
    }
}
