// WOFF2 -> SFNT (TrueType/OpenType) fuer den Glyphen-Pass ([226]): die gebuendelten Schriften
// (`public/fonts/<slug>/<slug>-<400|700>-<normal|italic>.woff2`) kommen als WOFF2 in die App (Browser-
// CSS), fontdb/cosmic-text lesen aber nur rohes SFNT. Dekodiert wird nach der W3C-Spezifikation
// (https://www.w3.org/TR/WOFF2/): Kopf, Tabellenverzeichnis, EIN Brotli-Strom, daraus die Tabellen.
//
// Grenze: Tabellen mit Transformation (`glyf`/`loca` Version 0, `hmtx` Version 1) werden NICHT
// zurueckgerechnet — die gebuendelten Dateien sind ohne Transformation gespeichert (fontTools
// `WOFF2FlavorData(transformedTables=set())`); ein transformiertes Paket und Sammlungen (TTC) liefern
// `Err` (der Aufrufer faellt dann auf Inter zurueck). Rohes SFNT (TTF/OTF) geht unveraendert durch.
// Nie Panic: jede Laengenangabe wird geprueft.

use std::io::Read;

/// Bekannte Tabellen-Tags (Spezifikation, Abschnitt 5.1), Index = Kennung 0..62.
const KNOWN_TAGS: [&[u8; 4]; 63] = [
    b"cmap", b"head", b"hhea", b"hmtx", b"maxp", b"name", b"OS/2", b"post", b"cvt ", b"fpgm", b"glyf", b"loca", b"prep", b"CFF ", b"VORG",
    b"EBDT", b"EBLC", b"gasp", b"hdmx", b"kern", b"LTSH", b"PCLT", b"VDMX", b"vhea", b"vmtx", b"BASE", b"GDEF", b"GPOS", b"GSUB", b"EBSC",
    b"JSTF", b"MATH", b"CBDT", b"CBLC", b"COLR", b"CPAL", b"SVG ", b"sbix", b"acnt", b"avar", b"bdat", b"bloc", b"bsln", b"cvar", b"fdsc",
    b"feat", b"fmtx", b"fvar", b"gvar", b"hsty", b"just", b"lcar", b"mort", b"morx", b"opbd", b"prop", b"trak", b"Zapf", b"Silf", b"Glat",
    b"Gloc", b"Feat", b"Sill",
];

/// Obergrenze des entpackten Datenstroms (Schutz vor Brotli-Bomben); die Schriften sind < 1 MB.
const MAX_UNPACKED: usize = 32 << 20;

struct Reader<'a> {
    b: &'a [u8],
    p: usize,
}

impl Reader<'_> {
    fn take(&mut self, n: usize) -> Result<&[u8], String> {
        let end = self.p.checked_add(n).filter(|&e| e <= self.b.len()).ok_or("WOFF2 abgeschnitten")?;
        let s = &self.b[self.p..end];
        self.p = end;
        Ok(s)
    }
    fn u8(&mut self) -> Result<u8, String> {
        Ok(self.take(1)?[0])
    }
    fn u32(&mut self) -> Result<u32, String> {
        Ok(u32::from_be_bytes(self.take(4)?.try_into().unwrap()))
    }
    /// `UIntBase128`: 7 Bit je Byte, hoechstens 5 Byte, keine fuehrenden Nullen.
    fn base128(&mut self) -> Result<u32, String> {
        let mut v: u32 = 0;
        for i in 0..5 {
            let b = self.u8()?;
            if i == 0 && b == 0x80 {
                return Err("UIntBase128 mit fuehrender Null".into());
            }
            if v & 0xfe00_0000 != 0 {
                return Err("UIntBase128 laeuft ueber".into());
            }
            v = (v << 7) | (b & 0x7f) as u32;
            if b & 0x80 == 0 {
                return Ok(v);
            }
        }
        Err("UIntBase128 zu lang".into())
    }
}

/// Pruefsumme einer Tabelle (Summe der Big-Endian-u32, Rest mit Nullen aufgefuellt).
fn checksum(d: &[u8]) -> u32 {
    let mut sum = 0u32;
    for c in d.chunks(4) {
        let mut w = [0u8; 4];
        w[..c.len()].copy_from_slice(c);
        sum = sum.wrapping_add(u32::from_be_bytes(w));
    }
    sum
}

/// Schrift-Bytes (WOFF2 oder rohes SFNT) -> SFNT.
pub fn to_sfnt(data: &[u8]) -> Result<Vec<u8>, String> {
    match data.get(..4) {
        Some(b"wOF2") => decode(data),
        Some([0, 1, 0, 0]) | Some(b"OTTO") | Some(b"true") => Ok(data.to_vec()),
        _ => Err("keine Schriftdatei (weder WOFF2 noch SFNT)".into()),
    }
}

fn decode(data: &[u8]) -> Result<Vec<u8>, String> {
    let mut r = Reader { b: data, p: 4 };
    let flavor = r.u32()?;
    if flavor == u32::from_be_bytes(*b"ttcf") {
        return Err("WOFF2-Sammlung (TTC) nicht unterstuetzt".into());
    }
    let _length = r.u32()?;
    let num_tables = u16::from_be_bytes(r.take(2)?.try_into().unwrap()) as usize;
    r.take(2 + 4)?; // reserved, totalSfntSize
    let comp_size = r.u32()? as usize;
    r.take(2 + 2 + 5 * 4)?; // Version, Metadaten (Offset, Laenge, Originallaenge), Privatdaten
    if num_tables == 0 || num_tables > 256 {
        return Err("WOFF2: unplausible Tabellenzahl".into());
    }
    // Tabellenverzeichnis: (tag, Laenge im entpackten Strom).
    let mut dir: Vec<([u8; 4], usize)> = Vec::with_capacity(num_tables);
    for _ in 0..num_tables {
        let flags = r.u8()?;
        let tag = if flags & 0x3f == 0x3f { r.take(4)?.try_into().unwrap() } else { *KNOWN_TAGS[(flags & 0x3f) as usize] };
        let version = flags >> 6;
        let orig = r.base128()? as usize;
        // glyf/loca: Version 3 = ohne Transformation; alle anderen: Version 0 = ohne.
        let transformed = if &tag == b"glyf" || &tag == b"loca" { version != 3 } else { version != 0 };
        if transformed {
            return Err(format!("WOFF2: Tabelle {} ist transformiert (nicht unterstuetzt)", String::from_utf8_lossy(&tag)));
        }
        dir.push((tag, orig));
    }
    let comp = r.take(comp_size)?;
    let total: usize = dir.iter().try_fold(0usize, |a, (_, l)| a.checked_add(*l)).filter(|&t| t <= MAX_UNPACKED).ok_or("WOFF2: Tabellen zu gross")?;
    let mut raw = Vec::with_capacity(total);
    brotli_decompressor::Decompressor::new(comp, 4096)
        .take(MAX_UNPACKED as u64 + 1)
        .read_to_end(&mut raw)
        .map_err(|e| format!("WOFF2: Brotli: {e}"))?;
    if raw.len() != total {
        return Err("WOFF2: entpackte Laenge passt nicht zum Verzeichnis".into());
    }
    // SFNT: Kopf (12) + Verzeichnis (16 je Tabelle, nach Tag sortiert) + Tabellen (4-Byte-ausgerichtet).
    let mut order: Vec<usize> = (0..dir.len()).collect();
    order.sort_by_key(|&i| dir[i].0);
    let mut starts = Vec::with_capacity(dir.len());
    let mut off = 0usize;
    for (_, l) in &dir {
        starts.push(off);
        off += l;
    }
    let n = dir.len();
    let mut out = Vec::with_capacity(12 + 16 * n + total + 4 * n);
    let mut pow = 1usize;
    let mut log = 0u16;
    while pow * 2 <= n {
        pow *= 2;
        log += 1;
    }
    out.extend_from_slice(&flavor.to_be_bytes());
    out.extend_from_slice(&(n as u16).to_be_bytes());
    out.extend_from_slice(&((pow * 16) as u16).to_be_bytes());
    out.extend_from_slice(&log.to_be_bytes());
    out.extend_from_slice(&((n * 16 - pow * 16) as u16).to_be_bytes());
    let mut data_off = 12 + 16 * n;
    for &i in &order {
        let (tag, len) = dir[i];
        let body = &raw[starts[i]..starts[i] + len];
        out.extend_from_slice(&tag);
        out.extend_from_slice(&checksum(body).to_be_bytes());
        out.extend_from_slice(&(data_off as u32).to_be_bytes());
        out.extend_from_slice(&(len as u32).to_be_bytes());
        data_off += (len + 3) & !3;
    }
    for &i in &order {
        let (_, len) = dir[i];
        out.extend_from_slice(&raw[starts[i]..starts[i] + len]);
        out.resize(out.len() + ((4 - len % 4) % 4), 0);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fonts_dir() -> std::path::PathBuf {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../public/fonts")
    }

    #[test]
    fn alle_gebuendelten_schriften_dekodieren() {
        let mut n = 0;
        for dir in std::fs::read_dir(fonts_dir()).unwrap() {
            for f in std::fs::read_dir(dir.unwrap().path()).unwrap() {
                let p = f.unwrap().path();
                if p.extension().and_then(|e| e.to_str()) != Some("woff2") {
                    continue;
                }
                let sfnt = to_sfnt(&std::fs::read(&p).unwrap()).unwrap_or_else(|e| panic!("{}: {e}", p.display()));
                let tables = u16::from_be_bytes([sfnt[4], sfnt[5]]) as usize;
                // `head`: Magic 0x5F0F3CF5 bei Offset 12 der Tabelle.
                let head = (0..tables)
                    .map(|k| &sfnt[12 + 16 * k..12 + 16 * k + 16])
                    .find(|r| &r[..4] == b"head")
                    .unwrap_or_else(|| panic!("{}: ohne head", p.display()));
                let off = u32::from_be_bytes(head[8..12].try_into().unwrap()) as usize;
                assert_eq!(&sfnt[off + 12..off + 16], &[0x5f, 0x0f, 0x3c, 0xf5], "{}", p.display());
                n += 1;
            }
        }
        assert!(n >= 50, "nur {n} Schriften gefunden");
    }

    #[test]
    fn rohes_sfnt_geht_durch_und_muell_wird_abgelehnt() {
        let ttf = to_sfnt(&std::fs::read(fonts_dir().join("inter/inter-400-normal.woff2")).unwrap()).unwrap();
        assert_eq!(to_sfnt(&ttf).unwrap(), ttf);
        assert!(to_sfnt(b"").is_err());
        assert!(to_sfnt(b"wOF2").is_err());
        assert!(to_sfnt(b"wOF2\0\0\0\0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa").is_err());
        assert!(to_sfnt(b"hello world").is_err());
    }
}
