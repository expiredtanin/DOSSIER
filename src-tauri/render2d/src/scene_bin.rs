// Binaerformat der Plan-Szene (Version 1): der Kern schreibt (`core/src/plan_scene.rs`),
// Rust liest — ersetzt den JSON-Weg zwischen Webview und render2d. Alles little-endian.
//
// Aufbau (alle Abschnitte lueckenlos hintereinander, kein Fuellmaterial):
//   Kopf, 48 Byte:  magic "DR2S" | version u32 | n_fills n_outlines n_polylines n_arcs
//                   n_lines n_texts (je u32) | n_pts u32 | n_dash u32 | str_bytes u32 | 0 u32
//   Punkte:         n_pts x (x f64, y f64) in Modell-Metern (LV95-gross moeglich). Gemeinsamer
//                   Pool, der der Reihe nach verbraucht wird: Fuellungen, Umrisse, Polylinien
//                   (je `n` Punkte), Boegen (je 3: Mitte, von, nach), Linien (je 2), Texte (je 1).
//   Strichmuster:   n_dash x f32, Pool in Reihenfolge Umrisse, Polylinien, Boegen, Linien.
//   Datensaetze:    je Kategorie ein Feld aus 4-Byte-Woertern (u32/f32), Reihenfolge wie oben:
//     Fuellung    [n, z, r g b a]                      6 Woerter
//     Umriss      [n, z, widthMm, dashLen, r g b a]    8
//     Polylinie   [n, z, widthMm, dashLen, flags, rgba] 9   (flags Bit0 = widthScreen)
//     Bogen       [r, widthMm, dashLen, rgba]          7
//     Linie       [widthMm, dashLen, z, rgba]          7
//     Text        [sizeMm, align(0 l,1 c,2 r), strOff, strLen, rgba] 8
//   Strings:        str_bytes UTF-8-Bytes; Texte verweisen mit Byte-Offset und -Laenge hinein.
// `dashLen` 0 = durchgezogen (None). Punkte werden beim Lesen auf f32 gekuerzt (wie bisher
// beim JSON-Weg), Farben und Masse sind f32. Nicht-endliche Zahlen gelten als kaputte Daten.
// Fremde Version, falsche Laenge, Offsets ausserhalb → `Err`, nie Panic.

use crate::types::{Arc, FillPolygon, Line, Outline, Point, Polyline, Rgba, Scene, Text, TextAlign};

/// Magie am Anfang jeder Szene.
pub const MAGIC: [u8; 4] = *b"DR2S";
/// Aktuelle Formatversion.
pub const VERSION: u32 = 1;
const HEADER: usize = 48;

/// Liest 4-Byte-Woerter; die Gesamtlaenge ist vorab geprueft, Zugriffe bleiben im Puffer.
struct Reader<'a> {
    b: &'a [u8],
    pos: usize,
}

impl Reader<'_> {
    fn u32(&mut self) -> u32 {
        let v = u32::from_le_bytes([self.b[self.pos], self.b[self.pos + 1], self.b[self.pos + 2], self.b[self.pos + 3]]);
        self.pos += 4;
        v
    }
    fn f32(&mut self) -> Result<f32, String> {
        let v = f32::from_bits(self.u32());
        if v.is_finite() {
            Ok(v)
        } else {
            Err("nicht-endliche Zahl".into())
        }
    }
    fn rgba(&mut self) -> Result<Rgba, String> {
        Ok([self.f32()?, self.f32()?, self.f32()?, self.f32()?])
    }
}

/// Punkt-Pool: liest der Reihe nach f64-Paare.
struct Points<'a> {
    b: &'a [u8],
    next: usize,
    total: usize,
}

impl Points<'_> {
    fn take(&mut self, n: usize) -> Result<Vec<Point>, String> {
        if n > self.total - self.next {
            return Err("Punkt-Pool zu klein".into());
        }
        let mut v = Vec::with_capacity(n);
        for i in self.next..self.next + n {
            let o = i * 16;
            let x = f64::from_le_bytes(self.b[o..o + 8].try_into().unwrap());
            let y = f64::from_le_bytes(self.b[o + 8..o + 16].try_into().unwrap());
            if !x.is_finite() || !y.is_finite() {
                return Err("nicht-endliche Koordinate".into());
            }
            v.push([x as f32, y as f32]);
        }
        self.next += n;
        Ok(v)
    }
}

/// Strichmuster-Pool.
struct Dashes {
    v: Vec<f32>,
    next: usize,
}

impl Dashes {
    fn take(&mut self, n: u32) -> Result<Option<Vec<f32>>, String> {
        if n == 0 {
            return Ok(None);
        }
        let n = n as usize;
        if n > self.v.len() - self.next {
            return Err("Strichmuster-Pool zu klein".into());
        }
        let s = self.v[self.next..self.next + n].to_vec();
        self.next += n;
        Ok(Some(s))
    }
}

/// Liest eine Szene (Format siehe Dateikopf). Gibt bei jedem Formatfehler `Err` zurueck.
pub fn decode_scene(bytes: &[u8]) -> Result<Scene, String> {
    if bytes.len() < HEADER {
        return Err("Szene zu kurz".into());
    }
    if bytes[0..4] != MAGIC {
        return Err("keine Szene (Magie falsch)".into());
    }
    let mut r = Reader { b: bytes, pos: 4 };
    let version = r.u32();
    if version != VERSION {
        return Err(format!("Szenenversion {version} nicht unterstuetzt (erwartet {VERSION})"));
    }
    let n_fills = r.u32() as u64;
    let n_outlines = r.u32() as u64;
    let n_polylines = r.u32() as u64;
    let n_arcs = r.u32() as u64;
    let n_lines = r.u32() as u64;
    let n_texts = r.u32() as u64;
    let n_pts = r.u32() as u64;
    let n_dash = r.u32() as u64;
    let str_bytes = r.u32() as u64;
    let _reserved = r.u32();

    // Gesamtlaenge in u64 vorab pruefen (u32-Zaehler * kleine Faktoren laufen nicht
    // ueber), bevor irgendetwas alloziert wird.
    let words = n_fills * 6 + n_outlines * 8 + n_polylines * 9 + n_arcs * 7 + n_lines * 7 + n_texts * 8;
    let expected = HEADER as u64 + n_pts * 16 + n_dash * 4 + words * 4 + str_bytes;
    if expected != bytes.len() as u64 {
        return Err(format!("Szenenlaenge {} statt {expected}", bytes.len()));
    }
    let n_pts = n_pts as usize;
    let mut pts = Points { b: &bytes[HEADER..HEADER + n_pts * 16], next: 0, total: n_pts };
    r.pos = HEADER + n_pts * 16;
    let mut dashes = Dashes { v: Vec::with_capacity(n_dash as usize), next: 0 };
    for _ in 0..n_dash {
        dashes.v.push(r.f32()?);
    }
    let str_start = bytes.len() - str_bytes as usize;
    let strings = std::str::from_utf8(&bytes[str_start..]).map_err(|_| "Strings: kein UTF-8".to_string())?;

    let mut scene = Scene::default();
    for _ in 0..n_fills {
        let n = r.u32() as usize;
        let z = r.u32();
        let color = r.rgba()?;
        scene.fills.push(FillPolygon { pts: pts.take(n)?, color, z });
    }
    for _ in 0..n_outlines {
        let n = r.u32() as usize;
        let z = r.u32();
        let width_mm = r.f32()?;
        let dl = r.u32();
        let color = r.rgba()?;
        scene.outlines.push(Outline { pts: pts.take(n)?, color, width_mm, dash: dashes.take(dl)?, z });
    }
    for _ in 0..n_polylines {
        let n = r.u32() as usize;
        let z = r.u32();
        let width_mm = r.f32()?;
        let dl = r.u32();
        let flags = r.u32();
        let color = r.rgba()?;
        scene.polylines.push(Polyline {
            pts: pts.take(n)?,
            color,
            width_mm,
            width_screen: flags & 1 != 0,
            dash: dashes.take(dl)?,
            z,
        });
    }
    for _ in 0..n_arcs {
        let radius = r.f32()?;
        let width_mm = r.f32()?;
        let dl = r.u32();
        let color = r.rgba()?;
        let p = pts.take(3)?;
        scene.arcs.push(Arc { center: p[0], from: p[1], to: p[2], r: radius, color, width_mm, dash: dashes.take(dl)? });
    }
    for _ in 0..n_lines {
        let width_mm = r.f32()?;
        let dl = r.u32();
        let z = r.u32();
        let color = r.rgba()?;
        let p = pts.take(2)?;
        scene.lines.push(Line { a: p[0], b: p[1], color, width_mm, dash: dashes.take(dl)?, z });
    }
    for _ in 0..n_texts {
        let size_mm = r.f32()?;
        let align = match r.u32() {
            0 => TextAlign::Left,
            1 => TextAlign::Center,
            2 => TextAlign::Right,
            _ => return Err("Text: Ausrichtung unbekannt".into()),
        };
        let off = r.u32() as usize;
        let len = r.u32() as usize;
        let color = r.rgba()?;
        let end = off.checked_add(len).filter(|&e| e <= strings.len()).ok_or("Text ausserhalb der Tabelle")?;
        let content = strings.get(off..end).ok_or("Text: Offset mitten im Zeichen")?.to_string();
        scene.texts.push(Text { pos: pts.take(1)?[0], content, size_mm, color, align });
    }
    if pts.next != n_pts || dashes.next != dashes.v.len() {
        return Err("Pools nicht vollstaendig verbraucht".into());
    }
    Ok(scene)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Beispielszene; MUSS mit `sample()` in `core/src/plan_scene.rs`
    /// uebereinstimmen (gemeinsame Bytes: `tests/fixtures/scene_v1.bin`).
    fn sample() -> Scene {
        Scene {
            fills: vec![
                FillPolygon { pts: vec![[0.0, 0.0], [4.0, 0.0], [4.0, 3.0]], color: [0.5, 0.25, 0.75, 1.0], z: 0 },
                FillPolygon { pts: vec![[1.5, 1.5], [2.5, 1.5], [2.5, 2.5], [1.5, 2.5]], color: [1.0, 1.0, 1.0, 0.5], z: 7 },
            ],
            outlines: vec![Outline {
                pts: vec![[0.0, 0.0], [4.0, 0.0], [4.0, 3.0]],
                color: [0.0, 0.0, 0.0, 1.0],
                width_mm: 0.25,
                dash: Some(vec![2.0, 1.0]),
                z: 1,
            }],
            polylines: vec![
                Polyline { pts: vec![[0.0, 0.0], [1.0, 1.0]], color: [0.25, 0.25, 0.25, 1.0], width_mm: 0.5, width_screen: false, dash: None, z: 2 },
                Polyline { pts: vec![[5.0, 5.0], [6.0, 5.0], [6.0, 6.0]], color: [0.5, 0.5, 0.5, 1.0], width_mm: 1.0, width_screen: true, dash: Some(vec![1.0]), z: 3 },
            ],
            arcs: vec![Arc { center: [1.0, 1.0], from: [2.0, 1.0], to: [1.0, 2.0], r: 1.0, color: [1.0, 0.0, 0.0, 1.0], width_mm: 0.125, dash: None }],
            lines: vec![Line { a: [0.0, 0.0], b: [2600000.5, 1200000.25], color: [0.0, 0.5, 0.0, 1.0], width_mm: 0.35, dash: Some(vec![3.0, 1.0, 0.5, 1.0]), z: 4 }],
            texts: vec![
                Text { pos: [1.0, 2.0], content: "Küche 12,5 m²".into(), size_mm: 2.5, color: [0.0, 0.0, 0.0, 1.0], align: TextAlign::Center },
                Text { pos: [3.0, 4.0], content: String::new(), size_mm: 2.0, color: [0.0, 0.0, 0.0, 1.0], align: TextAlign::Right },
                Text { pos: [5.0, 6.0], content: "A".into(), size_mm: 1.0, color: [0.0, 0.0, 1.0, 1.0], align: TextAlign::Left },
            ],
        }
    }

    const FIXTURE: &[u8] = include_bytes!("../tests/fixtures/scene_v1.bin");

    /// `Scene` hat kein `PartialEq`; der JSON-Vergleich deckt alle Felder ab.
    fn assert_same(a: &Scene, b: &Scene) {
        assert_eq!(serde_json::to_string(a).unwrap(), serde_json::to_string(b).unwrap());
    }

    #[test]
    fn decodes_ts_fixture_to_expected_scene() {
        assert_same(&decode_scene(FIXTURE).unwrap(), &sample());
    }

    #[test]
    fn empty_scene_decodes() {
        let mut b = Vec::new();
        b.extend_from_slice(&MAGIC);
        b.extend_from_slice(&VERSION.to_le_bytes());
        b.extend_from_slice(&[0u8; 40]);
        assert_same(&decode_scene(&b).unwrap(), &Scene::default());
    }

    #[test]
    fn rejects_foreign_version_magic_and_truncation() {
        let mut v = FIXTURE.to_vec();
        v[4] = 2;
        assert!(decode_scene(&v).unwrap_err().contains("version"));
        let mut m = FIXTURE.to_vec();
        m[0] = b'X';
        assert!(decode_scene(&m).is_err());
        assert!(decode_scene(&[]).is_err());
        for cut in 0..FIXTURE.len() {
            assert!(decode_scene(&FIXTURE[..cut]).is_err(), "cut {cut}");
        }
        let mut longer = FIXTURE.to_vec();
        longer.push(0);
        assert!(decode_scene(&longer).is_err());
    }

    #[test]
    fn rejects_huge_counts_without_allocating() {
        let mut v = FIXTURE[..HEADER].to_vec();
        for i in 0..9 {
            let o = 8 + i * 4;
            v[o..o + 4].copy_from_slice(&u32::MAX.to_le_bytes());
        }
        assert!(decode_scene(&v).is_err());
    }

    #[test]
    fn corrupted_bytes_never_panic() {
        for i in 0..FIXTURE.len() {
            for x in [0x00u8, 0xFF, 0x7F, 0x80] {
                let mut v = FIXTURE.to_vec();
                v[i] = x;
                let _ = decode_scene(&v);
            }
        }
        let mut seed = 0x1234_5678u32;
        for len in [48usize, 49, 100, 400] {
            let mut v: Vec<u8> = (0..len)
                .map(|_| {
                    seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
                    (seed >> 24) as u8
                })
                .collect();
            v[0..4].copy_from_slice(&MAGIC);
            v[4..8].copy_from_slice(&VERSION.to_le_bytes());
            let _ = decode_scene(&v);
        }
    }

    #[test]
    fn rejects_nonfinite_and_bad_text() {
        let mut v = FIXTURE.to_vec();
        v[HEADER..HEADER + 8].copy_from_slice(&f64::NAN.to_le_bytes());
        assert!(decode_scene(&v).is_err());
        // Der letzte Datensatz-Block vor der String-Tabelle sind die 3 Texte (je 32 Byte).
        let str_bytes = u32::from_le_bytes(FIXTURE[40..44].try_into().unwrap()) as usize;
        let text0 = FIXTURE.len() - str_bytes - 3 * 32;
        let mut a = FIXTURE.to_vec();
        a[text0 + 4..text0 + 8].copy_from_slice(&9u32.to_le_bytes());
        assert!(decode_scene(&a).unwrap_err().contains("Ausrichtung"));
        let mut b = FIXTURE.to_vec();
        b[text0 + 12..text0 + 16].copy_from_slice(&1000u32.to_le_bytes());
        assert!(decode_scene(&b).is_err());
        let mut c = FIXTURE.to_vec();
        let last = c.len() - 1;
        c[last] = 0xFF;
        assert!(decode_scene(&c).is_err());
    }
}

/// Test-Kodierer (Spiegel von `encodeRenderScene` in TS): fuer Hin-und-zurueck-Tests und
/// die Messung; die App kodiert nur auf der TS-Seite.
#[cfg(test)]
mod roundtrip {
    use super::*;
    use std::time::Instant;

    fn encode(s: &Scene) -> Vec<u8> {
        let (mut pts, mut dash, mut rec, mut strs) = (Vec::new(), Vec::new(), Vec::new(), Vec::<u8>::new());
        let w = |rec: &mut Vec<u8>, v: u32| rec.extend_from_slice(&v.to_le_bytes());
        let wf = |rec: &mut Vec<u8>, v: f32| rec.extend_from_slice(&v.to_le_bytes());
        let p = |pts: &mut Vec<u8>, q: &Point| {
            pts.extend_from_slice(&(q[0] as f64).to_le_bytes());
            pts.extend_from_slice(&(q[1] as f64).to_le_bytes());
        };
        let d = |rec: &mut Vec<u8>, dash: &mut Vec<u8>, v: &Option<Vec<f32>>| {
            let v = v.as_deref().unwrap_or(&[]);
            rec.extend_from_slice(&(v.len() as u32).to_le_bytes());
            for x in v {
                dash.extend_from_slice(&x.to_le_bytes());
            }
        };
        let c = |rec: &mut Vec<u8>, c: &Rgba| c.iter().for_each(|x| rec.extend_from_slice(&x.to_le_bytes()));
        for f in &s.fills {
            w(&mut rec, f.pts.len() as u32);
            w(&mut rec, f.z);
            c(&mut rec, &f.color);
            f.pts.iter().for_each(|q| p(&mut pts, q));
        }
        for o in &s.outlines {
            w(&mut rec, o.pts.len() as u32);
            w(&mut rec, o.z);
            wf(&mut rec, o.width_mm);
            d(&mut rec, &mut dash, &o.dash);
            c(&mut rec, &o.color);
            o.pts.iter().for_each(|q| p(&mut pts, q));
        }
        for o in &s.polylines {
            w(&mut rec, o.pts.len() as u32);
            w(&mut rec, o.z);
            wf(&mut rec, o.width_mm);
            d(&mut rec, &mut dash, &o.dash);
            w(&mut rec, o.width_screen as u32);
            c(&mut rec, &o.color);
            o.pts.iter().for_each(|q| p(&mut pts, q));
        }
        for a in &s.arcs {
            wf(&mut rec, a.r);
            wf(&mut rec, a.width_mm);
            d(&mut rec, &mut dash, &a.dash);
            c(&mut rec, &a.color);
            [a.center, a.from, a.to].iter().for_each(|q| p(&mut pts, q));
        }
        for l in &s.lines {
            wf(&mut rec, l.width_mm);
            d(&mut rec, &mut dash, &l.dash);
            w(&mut rec, l.z);
            c(&mut rec, &l.color);
            [l.a, l.b].iter().for_each(|q| p(&mut pts, q));
        }
        for t in &s.texts {
            wf(&mut rec, t.size_mm);
            w(&mut rec, t.align as u32);
            w(&mut rec, strs.len() as u32);
            w(&mut rec, t.content.len() as u32);
            c(&mut rec, &t.color);
            p(&mut pts, &t.pos);
            strs.extend_from_slice(t.content.as_bytes());
        }
        let mut out = Vec::new();
        out.extend_from_slice(&MAGIC);
        for v in [
            VERSION,
            s.fills.len() as u32,
            s.outlines.len() as u32,
            s.polylines.len() as u32,
            s.arcs.len() as u32,
            s.lines.len() as u32,
            s.texts.len() as u32,
            (pts.len() / 16) as u32,
            (dash.len() / 4) as u32,
            strs.len() as u32,
            0,
        ] {
            out.extend_from_slice(&v.to_le_bytes());
        }
        out.extend(pts);
        out.extend(dash);
        out.extend(rec);
        out.extend(strs);
        out
    }

    /// Zufallsszene mit f32-genauen Koordinaten (damit der f64-Umweg verlustfrei ist).
    fn big(n_lines: usize, n_fills: usize, n_texts: usize) -> Scene {
        let mut seed = 42u32;
        let mut rnd = move || {
            seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
            ((seed >> 8) as f32) / 16777216.0
        };
        let mut s = Scene::default();
        for i in 0..n_lines {
            let (x, y) = (rnd() * 500.0, rnd() * 500.0);
            let dash = if i % 10 == 0 { Some(vec![2.0, 1.0]) } else { None };
            s.lines.push(Line { a: [x, y], b: [x + rnd(), y + rnd()], color: [0.1, 0.1, 0.1, 1.0], width_mm: 0.18, dash, z: (i % 50) as u32 });
        }
        for i in 0..n_fills {
            let (x, y) = (rnd() * 500.0, rnd() * 500.0);
            let pts = (0..6).map(|k| [x + k as f32 * rnd(), y + rnd() * k as f32]).collect();
            s.fills.push(FillPolygon { pts, color: [0.8, 0.8, 0.75, 1.0], z: (i % 50) as u32 });
        }
        for i in 0..n_texts {
            s.texts.push(Text { pos: [rnd() * 500.0, rnd() * 500.0], content: format!("Raum {i} 12,5 m²"), size_mm: 2.0, color: [0.0, 0.0, 0.0, 1.0], align: TextAlign::Center });
        }
        s
    }

    fn same(a: &Scene, b: &Scene) -> bool {
        serde_json::to_string(a).unwrap() == serde_json::to_string(b).unwrap()
    }

    #[test]
    fn random_scene_roundtrips() {
        let s = big(500, 100, 30);
        assert!(same(&decode_scene(&encode(&s)).unwrap(), &s));
    }

    /// Messung: `cargo test --release scene_bin::roundtrip::measure -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn measure() {
        for (name, s) in [
            ("klein (200 Linien, 50 Fuellungen, 20 Texte)", big(200, 50, 20)),
            ("gross (200000 Linien, 20000 Fuellungen, 1000 Texte)", big(200_000, 20_000, 1000)),
        ] {
            let json = serde_json::to_string(&s).unwrap();
            let bin = encode(&s);
            let best = |f: &dyn Fn()| {
                (0..5)
                    .map(|_| {
                        let t = Instant::now();
                        f();
                        t.elapsed().as_secs_f64() * 1000.0
                    })
                    .fold(f64::MAX, f64::min)
            };
            let tj = best(&|| {
                std::hint::black_box(serde_json::from_str::<Scene>(&json).unwrap());
            });
            let tb = best(&|| {
                std::hint::black_box(decode_scene(&bin).unwrap());
            });
            println!("{name}: JSON {} KB parse {tj:.2} ms | binaer {} KB decode {tb:.2} ms", json.len() / 1024, bin.len() / 1024);
        }
    }
}
