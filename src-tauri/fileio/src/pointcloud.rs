// Punktwolken-Leser ([B9], für [27]): gemeinsamer Kern der Formate LAS/LAZ (`pointcloud_las.rs`),
// E57 (`pointcloud_e57.rs`) sowie PLY/XYZ/PTS (`pointcloud_text.rs`).
//
// Ausgabe (`PointCloud`): Koordinaten als f32 RELATIV zu einem Ursprung (`origin`, f64, ganze Meter) —
// in LV95 (E ≈ 2,6 Mio., N ≈ 1,2 Mio.) hätte f32 absolut nur ~0,25 m Auflösung, relativ zum Ursprung
// genügt es auf Kachelgrösse (mm). Dazu optional Farbe (RGB8), Intensität (u16) und Klassifikation (u8).
//
// Ausdünnen STREAMEND beim Lesen (`Sink`): Voxel-Raster (erster Punkt je Zelle bleibt) und/oder
// Punktbudget. Bei Überschreiten des Budgets wächst die Voxelkante und die behaltenen Punkte werden neu
// gerastert — so brauchen auch 50 Mio. Punkte nie mehr Speicher als das Budget (nur der Eingabepuffer
// liegt ganz im Speicher). Bounding-Box, Klassen-Histogramm und Zähler beziehen sich auf ALLE gelesenen
// Punkte, nicht nur die behaltenen.
//
// Unsinn (kaputter Kopf, abgeschnittene Daten, NaN) ergibt einen Fehler-String bzw. verworfene Punkte,
// nie einen Panic.

use serde::Serialize;

/// Optionen des Lesens.
#[derive(Clone, Copy, Debug)]
pub struct Options {
    /// Voxel-Kantenlänge in Metern (0 = kein festes Raster).
    pub voxel: f64,
    /// Höchstzahl behaltener Punkte (0 = unbegrenzt). Wird sie überschritten, wächst die Voxelkante.
    pub max_points: usize,
}

impl Default for Options {
    fn default() -> Self {
        Options { voxel: 0.0, max_points: 0 }
    }
}

/// Gelesene (ausgedünnte) Punktwolke.
#[derive(Clone, Debug, Default)]
pub struct PointCloud {
    /// Ursprung in Dateikoordinaten (ganze Meter); absolut = `origin + xyz`.
    pub origin: [f64; 3],
    /// x,y,z je Punkt, relativ zu `origin`.
    pub xyz: Vec<f32>,
    /// r,g,b (8 Bit) je Punkt; leer, wenn die Datei keine Farbe hat.
    pub rgb: Vec<u8>,
    /// Intensität je Punkt (u16); leer, wenn nicht vorhanden.
    pub intensity: Vec<u16>,
    /// Klassifikation je Punkt (ASPRS-Code, LAS); leer, wenn nicht vorhanden.
    pub classification: Vec<u8>,
}

impl PointCloud {
    pub fn len(&self) -> usize {
        self.xyz.len() / 3
    }
    pub fn is_empty(&self) -> bool {
        self.xyz.is_empty()
    }
}

/// Bericht über das Gelesene (für CLI und UI).
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PointReport {
    /// "las", "laz", "e57", "ply", "xyz" oder "pts".
    pub format: String,
    /// Formatversion (LAS "1.4", E57 "1.0", PLY-Format …), sonst leer.
    pub version: String,
    /// LAS-Punktformat 0–10 (sonst `None`).
    pub point_format: Option<u8>,
    /// Punkte laut Datei (Kopf).
    pub points_declared: u64,
    /// Tatsächlich gelesene Punkte (ohne NaN/unlesbare).
    pub points_read: u64,
    /// Nach dem Ausdünnen behaltene Punkte.
    pub points_kept: u64,
    /// Verworfene Punkte (NaN/∞/unlesbare Zeilen).
    pub points_invalid: u64,
    /// Zuletzt verwendete Voxelkante in m (0 = nicht ausgedünnt).
    pub voxel: f64,
    /// Bounding-Box aller gelesenen Punkte (absolut, Dateikoordinaten).
    pub bbox_min: [f64; 3],
    pub bbox_max: [f64; 3],
    pub origin: [f64; 3],
    pub has_color: bool,
    pub has_intensity: bool,
    pub has_classification: bool,
    /// Intensitätsbereich aller gelesenen Punkte (nur mit Intensität).
    pub intensity_range: Option<[u16; 2]>,
    /// Häufigkeit je Klassifikationscode `[code, anzahl]` (nur mit Klassifikation), aufsteigend.
    pub class_counts: Vec<[u64; 2]>,
    /// EPSG-Code des Koordinatensystems, falls die Datei ihn nennt (LV95 = 2056, LV03 = 21781).
    pub epsg: Option<u32>,
    /// Die Datei war kürzer als im Kopf angegeben oder brach beim Dekodieren ab.
    pub truncated: bool,
    pub warnings: Vec<String>,
}

/// Welche Attribute eine Datei liefert (vom Format-Leser vor dem ersten Punkt gesetzt).
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct Attrs {
    pub color: bool,
    pub intensity: bool,
    pub class: bool,
}

/// Menge von Rasterzellen: offene Adressierung mit linearer Suche über einem Potenz-von-2-Feld, ein
/// Multiplikations-Hash. Deutlich schneller als `HashSet` (im WASM ohne SIMD ~5×; 16 Mio. Punkte:
/// 12 s → s. Bericht). Schlüssel = 3 × 21 Bit der Zellindizes (Wrap bei > 2 Mio. Zellen je Achse, das
/// verschmilzt nur Zellen, die ≥ 2 Mio. Kantenlängen auseinanderliegen); Bit 63 markiert "belegt".
pub(crate) struct CellSet {
    slots: Vec<u64>,
    len: usize,
    shift: u32,
}

const OCCUPIED: u64 = 1 << 63;

impl CellSet {
    fn new() -> Self {
        CellSet { slots: Vec::new(), len: 0, shift: 64 }
    }
    fn clear(&mut self) {
        self.slots.iter_mut().for_each(|s| *s = 0);
        self.len = 0;
    }
    fn grow(&mut self) {
        let cap = (self.slots.len() * 2).max(1024);
        let old = std::mem::replace(&mut self.slots, vec![0; cap]);
        self.shift = 64 - cap.trailing_zeros();
        self.len = 0;
        for k in old.into_iter().filter(|&k| k != 0) {
            self.insert_key(k);
        }
    }
    fn insert_key(&mut self, key: u64) -> bool {
        let mask = self.slots.len() - 1;
        let mut i = (key.wrapping_mul(0x9E37_79B9_7F4A_7C15) >> self.shift) as usize;
        loop {
            let s = self.slots[i];
            if s == 0 {
                self.slots[i] = key;
                self.len += 1;
                return true;
            }
            if s == key {
                return false;
            }
            i = (i + 1) & mask;
        }
    }
    /// `true`, wenn die Zelle neu ist.
    fn insert(&mut self, key: u64) -> bool {
        if self.slots.is_empty() || (self.len + 1) * 10 > self.slots.len() * 6 {
            self.grow();
        }
        self.insert_key(key)
    }
}

/// Sammelt Punkte mit streamendem Ausdünnen. Die Format-Leser rufen nur `push`.
pub(crate) struct Sink {
    opts: Options,
    attrs: Attrs,
    origin: Option<[f64; 3]>,
    xyz: Vec<f32>,
    rgb16: Vec<u16>,
    intensity: Vec<u16>,
    class: Vec<u8>,
    voxel: f64,
    map: CellSet,
    last_key: u64,
    read: u64,
    invalid: u64,
    bmin: [f64; 3],
    bmax: [f64; 3],
    class_hist: [u64; 256],
    int_min: u16,
    int_max: u16,
    rgb_max: u16,
}

impl Sink {
    pub fn new(opts: Options, attrs: Attrs, origin: Option<[f64; 3]>) -> Self {
        let voxel = if opts.voxel.is_finite() && opts.voxel > 0.0 { opts.voxel } else { 0.0 };
        Sink {
            opts,
            attrs,
            origin: origin.filter(|o| o.iter().all(|v| v.is_finite())).map(|o| o.map(f64::round)),
            xyz: Vec::new(),
            rgb16: Vec::new(),
            intensity: Vec::new(),
            class: Vec::new(),
            voxel,
            map: CellSet::new(),
            last_key: 0,
            read: 0,
            invalid: 0,
            bmin: [f64::INFINITY; 3],
            bmax: [f64::NEG_INFINITY; 3],
            class_hist: [0; 256],
            int_min: u16::MAX,
            int_max: 0,
            rgb_max: 0,
        }
    }

    /// Reserviert Platz für höchstens `n` Punkte (begrenzt durch Budget; nie ungeprüft aus dem Kopf).
    pub fn reserve_hint(&mut self, n: u64) {
        let cap = if self.opts.max_points > 0 { self.opts.max_points as u64 } else { 50_000_000 };
        let n = n.min(cap).min(8_000_000) as usize;
        self.xyz.reserve(n * 3);
        if self.attrs.color {
            self.rgb16.reserve(n * 3);
        }
        if self.attrs.intensity {
            self.intensity.reserve(n);
        }
        if self.attrs.class {
            self.class.reserve(n);
        }
    }

    pub fn count_invalid(&mut self) {
        self.invalid += 1;
    }

    /// Ein Punkt in Dateikoordinaten. NaN/∞ werden verworfen.
    pub fn push(&mut self, p: [f64; 3], rgb: [u16; 3], intensity: u16, class: u8) {
        if !(p[0].is_finite() && p[1].is_finite() && p[2].is_finite()) {
            self.invalid += 1;
            return;
        }
        let origin = *self.origin.get_or_insert([p[0].round(), p[1].round(), p[2].round()]);
        self.read += 1;
        for i in 0..3 {
            if p[i] < self.bmin[i] {
                self.bmin[i] = p[i];
            }
            if p[i] > self.bmax[i] {
                self.bmax[i] = p[i];
            }
        }
        if self.attrs.class {
            self.class_hist[class as usize] += 1;
        }
        if self.attrs.intensity {
            self.int_min = self.int_min.min(intensity);
            self.int_max = self.int_max.max(intensity);
        }
        if self.attrs.color {
            self.rgb_max = self.rgb_max.max(rgb[0]).max(rgb[1]).max(rgb[2]);
        }

        let rel = [p[0] - origin[0], p[1] - origin[1], p[2] - origin[2]];
        if self.voxel > 0.0 {
            let key = voxel_key(rel, self.voxel);
            // Dichte Daten: oft liegen aufeinanderfolgende Punkte in derselben Zelle.
            if key == self.last_key || !self.map.insert(key) {
                self.last_key = key;
                return;
            }
            self.last_key = key;
        }
        self.xyz.extend_from_slice(&[rel[0] as f32, rel[1] as f32, rel[2] as f32]);
        if self.attrs.color {
            self.rgb16.extend_from_slice(&rgb);
        }
        if self.attrs.intensity {
            self.intensity.push(intensity);
        }
        if self.attrs.class {
            self.class.push(class);
        }
        if self.opts.max_points > 0 && self.xyz.len() / 3 > self.opts.max_points {
            self.shrink_to_budget();
        }
    }

    /// Budget überschritten: Voxelkante vergrössern und die behaltenen Punkte neu rastern, bis
    /// höchstens 3/4 des Budgets belegt sind (Luft, damit nicht bei jedem Punkt neu gerastert wird).
    fn shrink_to_budget(&mut self) {
        let max = self.opts.max_points;
        let target = (max / 4 * 3).max(1);
        if self.voxel <= 0.0 {
            // Startkante aus der Ausdehnung schätzen: Punktwolken (Gelände, Fassaden) sind Flächen,
            // daher Fläche der grössten Bounding-Box-Seite / Budget.
            let ext = [self.bmax[0] - self.bmin[0], self.bmax[1] - self.bmin[1], self.bmax[2] - self.bmin[2]];
            let mut e = ext;
            e.sort_by(|a, b| b.partial_cmp(a).unwrap_or(std::cmp::Ordering::Equal));
            let area = e[0] * e[1];
            let mut v = (area / max as f64).sqrt();
            if !(v.is_finite() && v > 0.0) {
                v = (e[0] / max as f64).max(1e-6);
            }
            self.voxel = v;
        } else {
            self.voxel *= 1.5;
        }
        loop {
            self.rethin();
            if self.xyz.len() / 3 <= target {
                break;
            }
            self.voxel *= 1.3;
        }
    }

    /// Rastert die behaltenen Punkte mit der aktuellen Kante neu (erster Punkt je Zelle bleibt).
    fn rethin(&mut self) {
        let n = self.xyz.len() / 3;
        self.map.clear();
        self.last_key = 0;
        let mut w = 0usize;
        for i in 0..n {
            let rel = [self.xyz[3 * i] as f64, self.xyz[3 * i + 1] as f64, self.xyz[3 * i + 2] as f64];
            let key = voxel_key(rel, self.voxel);
            if !self.map.insert(key) {
                continue;
            }
            if w != i {
                self.xyz.copy_within(3 * i..3 * i + 3, 3 * w);
                if self.attrs.color {
                    self.rgb16.copy_within(3 * i..3 * i + 3, 3 * w);
                }
                if self.attrs.intensity {
                    self.intensity[w] = self.intensity[i];
                }
                if self.attrs.class {
                    self.class[w] = self.class[i];
                }
            }
            w += 1;
        }
        self.xyz.truncate(3 * w);
        if self.attrs.color {
            self.rgb16.truncate(3 * w);
        }
        if self.attrs.intensity {
            self.intensity.truncate(w);
        }
        if self.attrs.class {
            self.class.truncate(w);
        }
    }

    /// Schliesst ab: Farbe auf 8 Bit (Dateien mit 8-Bit-Werten in 16-Bit-Feldern erkennen), Bericht füllen.
    pub fn finish(mut self, mut report: PointReport) -> Result<(PointCloud, PointReport), String> {
        if self.read == 0 {
            return Err("Punktwolke enthält keine gültigen Punkte".into());
        }
        let origin = self.origin.unwrap_or([0.0; 3]);
        let rgb: Vec<u8> = if self.attrs.color {
            let shift8 = self.rgb_max > 255;
            self.rgb16.iter().map(|&v| if shift8 { (v >> 8) as u8 } else { v as u8 }).collect()
        } else {
            Vec::new()
        };
        self.xyz.shrink_to_fit();
        report.points_read = self.read;
        report.points_invalid = self.invalid;
        report.points_kept = (self.xyz.len() / 3) as u64;
        report.voxel = self.voxel;
        report.bbox_min = self.bmin;
        report.bbox_max = self.bmax;
        report.origin = origin;
        report.has_color = self.attrs.color;
        report.has_intensity = self.attrs.intensity;
        report.has_classification = self.attrs.class;
        if self.attrs.intensity {
            report.intensity_range = Some([self.int_min, self.int_max]);
        }
        if self.attrs.class {
            report.class_counts = (0..256usize)
                .filter(|&c| self.class_hist[c] > 0)
                .map(|c| [c as u64, self.class_hist[c]])
                .collect();
        }
        let cloud = PointCloud {
            origin,
            xyz: self.xyz,
            rgb,
            intensity: self.intensity,
            classification: self.class,
        };
        Ok((cloud, report))
    }
}

fn voxel_key(rel: [f64; 3], voxel: f64) -> u64 {
    // `as i32` sättigt (kein Panic); je 21 Bit (s. `CellSet`).
    let c = |v: f64| ((v / voxel).floor() as i32 as u32 as u64) & 0x1F_FFFF;
    OCCUPIED | (c(rel[0]) << 42) | (c(rel[1]) << 21) | c(rel[2])
}

/// Erkennt das Format an den Anfangsbytes und liest. `name` (Dateiname, nur zur Unterscheidung
/// XYZ/PTS bei Textdateien) darf leer sein.
pub fn read_point_cloud(bytes: &[u8], name: &str, opts: Options) -> Result<(PointCloud, PointReport), String> {
    if bytes.len() < 4 {
        return Err("Datei zu kurz für eine Punktwolke".into());
    }
    if &bytes[..4] == b"LASF" {
        crate::pointcloud_las::read_las(bytes, opts)
    } else if bytes.len() >= 8 && &bytes[..8] == b"ASTM-E57" {
        crate::pointcloud_e57::read_e57(bytes, opts)
    } else if bytes.starts_with(b"ply") {
        crate::pointcloud_text::read_ply(bytes, opts)
    } else {
        crate::pointcloud_text::read_xyz(bytes, name, opts)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn grid_sink(opts: Options) -> Sink {
        Sink::new(opts, Attrs { color: true, intensity: true, class: true }, None)
    }

    #[test]
    fn origin_rounded_and_relative() {
        let mut s = grid_sink(Options::default());
        s.push([2_600_000.4, 1_200_000.6, 500.0], [65535, 0, 0], 7, 2);
        let (c, r) = s.finish(PointReport::default()).unwrap();
        assert_eq!(c.origin, [2_600_000.0, 1_200_001.0, 500.0]);
        assert!((c.xyz[0] - 0.4).abs() < 1e-5 && (c.xyz[1] + 0.4).abs() < 1e-5);
        assert_eq!(c.rgb, vec![255, 0, 0]);
        assert_eq!(r.class_counts, vec![[2, 1]]);
        assert_eq!(r.intensity_range, Some([7, 7]));
    }

    #[test]
    fn eight_bit_color_in_16bit_fields_is_kept() {
        let mut s = grid_sink(Options::default());
        s.push([0.0, 0.0, 0.0], [200, 100, 3], 0, 0);
        let (c, _) = s.finish(PointReport::default()).unwrap();
        assert_eq!(c.rgb, vec![200, 100, 3]);
    }

    #[test]
    fn nan_points_are_dropped() {
        let mut s = grid_sink(Options::default());
        s.push([f64::NAN, 0.0, 0.0], [0; 3], 0, 0);
        s.push([1.0, 2.0, 3.0], [0; 3], 0, 0);
        let (c, r) = s.finish(PointReport::default()).unwrap();
        assert_eq!(c.len(), 1);
        assert_eq!(r.points_invalid, 1);
    }

    #[test]
    fn all_invalid_is_error() {
        let mut s = grid_sink(Options::default());
        s.push([f64::INFINITY, 0.0, 0.0], [0; 3], 0, 0);
        assert!(s.finish(PointReport::default()).is_err());
    }

    #[test]
    fn voxel_keeps_one_point_per_cell() {
        // 10 x 10 Raster mit 0,1 m Abstand, je 4 Punkte pro Zelle (0,25 m) → 4 x 4 Zellen = 16.
        let mut s = Sink::new(Options { voxel: 0.25, max_points: 0 }, Attrs::default(), Some([0.0; 3]));
        for i in 0..10 {
            for j in 0..10 {
                s.push([i as f64 * 0.1, j as f64 * 0.1, 0.0], [0; 3], 0, 0);
            }
        }
        let (c, r) = s.finish(PointReport::default()).unwrap();
        assert_eq!(r.points_read, 100);
        assert_eq!(c.len(), 16);
        assert_eq!(r.voxel, 0.25);
    }

    #[test]
    fn budget_is_never_exceeded_and_bbox_covers_all() {
        let mut s = Sink::new(Options { voxel: 0.0, max_points: 1000 }, Attrs { color: true, intensity: true, class: true }, None);
        let n = 200;
        for i in 0..n {
            for j in 0..n {
                s.push([i as f64 * 0.05, j as f64 * 0.05, 1.0], [i as u16, j as u16, 0], (i + j) as u16, (i % 7) as u8);
            }
        }
        let (c, r) = s.finish(PointReport::default()).unwrap();
        assert_eq!(r.points_read, (n * n) as u64);
        assert!(c.len() <= 1000 && c.len() > 100, "len {}", c.len());
        assert!(r.voxel > 0.05);
        // Alle Attribut-Arrays gleich lang.
        assert_eq!(c.rgb.len(), c.len() * 3);
        assert_eq!(c.intensity.len(), c.len());
        assert_eq!(c.classification.len(), c.len());
        // BBox über alle Punkte, nicht nur die behaltenen.
        assert_eq!(r.bbox_max[0], 199.0 * 0.05);
    }

    #[test]
    fn garbage_inputs_error_without_panic() {
        for data in [&b""[..], b"LA", b"LASF", b"ASTM-E57", b"ply", b"\x00\x01\x02\x03\x04"] {
            let _ = read_point_cloud(data, "x.bin", Options::default());
        }
    }
}
