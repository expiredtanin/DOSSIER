// Teilt eine grosse ASCII-DXF-Datei VOR dem Lesen in N unabhängige, für sich gültige Mini-DXF-
// Dokumente, damit der Import über mehrere Web-Worker parallel laufen kann (`io/dxfParserAsync.ts`;
// Nutzer-Report 09.10.: 439-MB-Kataster-DXF). Portiert aus dem früheren `io/dxfEntityChunker.ts`,
// jetzt auf Bytes statt Text (Kodierung bleibt unangetastet, Binär-DXF/DWG werden nicht geteilt).
//
// Nur die ENTITIES-Sektion wird geteilt; HEADER/TABLES/BLOCKS stehen als Präambel vor jedem
// Stück (INSERT braucht die Blöcke). SICHERHEIT: ein Schnitt liegt NIE mitten in einem Datensatz.
// Gruppencode 0 beginnt jeden Datensatz, aber VERTEX/SEQEND (zu POLYLINE) und ATTRIB (zu INSERT)
// sind reine Fortsetzungen und nie Schnittstellen. Code/Wert werden strikt paarweise gelesen (ein
// MTEXT-Inhalt „0" auf eigener Zeile ist so keine Falle). Jeder unerwartete Aufbau → `None`, der
// Aufrufer liest dann am Stück. Lieber keine Parallelisierung als eine falsche.

/// Abschluss, der jedes Stück zu einem gültigen DXF macht (Stücke enden selbst mit Zeilenumbruch).
pub const CHUNK_CLOSER: &[u8] = b"0\nENDSEC\n0\nEOF\n";

/// Unterhalb dieser Grösse lohnt sich der Aufteilungs-Aufwand nicht (Worker-Start + Modul ≈ 0,1–0,2 s;
/// eine 4-MB-Datei liest ein Worker in ≈ 0,4 s).
pub const MIN_SIZE_FOR_SPLIT: usize = 4_000_000;

const CONTINUATION_TYPES: [&[u8]; 3] = [b"VERTEX", b"SEQEND", b"ATTRIB"];

struct Pair<'a> {
    code: &'a [u8],
    value: &'a [u8],
    /// Byte-Offset der Code-Zeile.
    start: usize,
    /// Byte-Offset des nächsten Paars.
    next: usize,
}

/// Eine Zeile ab `pos` (ohne `\n`/`\r\n`) und der Beginn der nächsten; `None` am Ende.
fn read_line(b: &[u8], pos: usize) -> Option<(&[u8], usize)> {
    if pos >= b.len() {
        return None;
    }
    match b[pos..].iter().position(|&c| c == b'\n') {
        None => Some((&b[pos..], b.len())),
        Some(rel) => {
            let nl = pos + rel;
            let end = if nl > pos && b[nl - 1] == b'\r' { nl - 1 } else { nl };
            Some((&b[pos..end], nl + 1))
        }
    }
}

fn trim(s: &[u8]) -> &[u8] {
    let start = s.iter().position(|c| !c.is_ascii_whitespace()).unwrap_or(s.len());
    let end = s.iter().rposition(|c| !c.is_ascii_whitespace()).map_or(start, |e| e + 1);
    &s[start..end]
}

fn read_pair(b: &[u8], pos: usize) -> Option<Pair<'_>> {
    let (code, n1) = read_line(b, pos)?;
    let (value, n2) = read_line(b, n1)?;
    Some(Pair { code: trim(code), value: trim(value), start: pos, next: n2 })
}

fn is(p: &Pair, code: &[u8], value: &[u8]) -> bool {
    p.code == code && p.value.eq_ignore_ascii_case(value)
}

/// Offset, an dem der Inhalt der ENTITIES-Sektion beginnt (nach `0 SECTION` / `2 ENTITIES`);
/// alle vorangehenden Sektionen werden bis zu ihrem `0 ENDSEC` übersprungen.
fn entities_start(b: &[u8]) -> Option<usize> {
    let mut pos = 0;
    loop {
        let open = read_pair(b, pos)?;
        if !is(&open, b"0", b"SECTION") {
            return None;
        }
        let name = read_pair(b, open.next)?;
        if name.code != b"2" {
            return None;
        }
        if name.value.eq_ignore_ascii_case(b"ENTITIES") {
            return Some(name.next);
        }
        let mut p = name.next;
        loop {
            let pair = read_pair(b, p)?;
            p = pair.next;
            if is(&pair, b"0", b"ENDSEC") {
                break;
            }
        }
        pos = p;
    }
}

/// Sichere Schnittstellen (Beginn jedes eigenständigen Datensatzes, inkl. `start`) und das Ende
/// der Sektion (Beginn von `0 ENDSEC`).
fn scan_split_points(b: &[u8], start: usize) -> Option<(Vec<usize>, usize)> {
    let mut offsets = vec![start];
    let mut pos = start;
    loop {
        let pair = read_pair(b, pos)?;
        if pair.code == b"0" {
            if pair.value.eq_ignore_ascii_case(b"ENDSEC") {
                return Some((offsets, pair.start));
            }
            let continuation = CONTINUATION_TYPES.iter().any(|t| pair.value.eq_ignore_ascii_case(t));
            if pair.start != start && !continuation {
                offsets.push(pair.start);
            }
        }
        pos = pair.next;
    }
}

/// Index des Elements, das `target` am nächsten liegt (sortiert, Binärsuche).
fn nearest_index(sorted: &[usize], target: f64) -> usize {
    let i = sorted.partition_point(|&v| (v as f64) < target).min(sorted.len() - 1);
    if i > 0 && (sorted[i - 1] as f64 - target).abs() <= (sorted[i] as f64 - target).abs() {
        i - 1
    } else {
        i
    }
}

/// Aufsteigende Schnittstellen `[entitiesStart, …, entitiesEnd]` für höchstens `chunk_count`
/// Stücke, oder `None` (zu klein, Binär-DXF, unerwarteter Aufbau, weniger als 2 Stücke).
pub fn split_offsets(b: &[u8], chunk_count: usize) -> Option<Vec<usize>> {
    if chunk_count <= 1 || b.len() < MIN_SIZE_FOR_SPLIT || b.starts_with(b"AutoCAD Binary DXF") {
        return None;
    }
    let start = entities_start(b)?;
    let (offsets, end) = scan_split_points(b, start)?;
    if offsets.len() < 2 {
        return None;
    }
    let n = chunk_count.min(offsets.len());
    let mut points = vec![start, end];
    for k in 1..n {
        let target = start as f64 + (k as f64 * (end - start) as f64) / n as f64;
        points.push(offsets[nearest_index(&offsets, target)]);
    }
    points.sort_unstable();
    points.dedup();
    if points.len() < 3 {
        return None;
    }
    Some(points)
}

/// Stücke als vollständige DXF-Dokumente (`Präambel + Stück + Abschluss`), z. B. für Tests.
pub fn split_chunks(b: &[u8], chunk_count: usize) -> Option<Vec<Vec<u8>>> {
    let points = split_offsets(b, chunk_count)?;
    let preamble = &b[..points[0]];
    Some(
        points
            .windows(2)
            .map(|w| {
                let mut doc = Vec::with_capacity(preamble.len() + (w[1] - w[0]) + CHUNK_CLOSER.len());
                doc.extend_from_slice(preamble);
                doc.extend_from_slice(&b[w[0]..w[1]]);
                doc.extend_from_slice(CHUNK_CLOSER);
                doc
            })
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::import::import_bytes;

    fn line() -> String {
        "0\nLINE\n8\n0\n10\n0\n20\n0\n30\n0\n11\n1\n21\n1\n31\n0\n".to_string()
    }
    fn polyline() -> String {
        let mut s = "0\nPOLYLINE\n8\n0\n66\n1\n70\n0\n".to_string();
        for (x, y) in [(0, 0), (1, 0), (1, 1), (0, 1), (0, 0)] {
            s += &format!("0\nVERTEX\n8\n0\n10\n{x}\n20\n{y}\n30\n0\n");
        }
        s + "0\nSEQEND\n"
    }
    fn insert_with_attrib(i: usize) -> String {
        format!("0\nINSERT\n2\nblk\n10\n0\n20\n0\n30\n0\n66\n1\n0\nATTRIB\n8\n0\n1\nAttribut {i}\n0\nSEQEND\n")
    }
    /// Füllt eine Entity mit einem Kommentar (999) auf, damit die 20-MB-Schwelle ohne riesige
    /// Entity-Zahl erreicht wird.
    fn pad() -> String {
        format!("999\n{}\n", "x".repeat(1024))
    }
    fn entities_only(body: &str) -> Vec<u8> {
        format!("0\nSECTION\n2\nENTITIES\n{body}0\nENDSEC\n0\nEOF\n").into_bytes()
    }
    fn many(f: impl Fn(usize) -> String, n: usize) -> String {
        (0..n).map(|i| f(i) + &pad()).collect()
    }

    #[test]
    fn zu_klein_oder_ein_stueck_oder_ohne_entities() {
        assert!(split_offsets(&entities_only(&(line() + &line())), 4).is_none());
        let big = entities_only(&many(|_| line(), 30_000));
        assert!(split_offsets(&big, 1).is_none());
        let header = format!("0\nSECTION\n2\nHEADER\n0\nENDSEC\n0\nEOF\n{}", "x".repeat(5_000_000));
        assert!(split_offsets(header.as_bytes(), 4).is_none());
    }

    #[test]
    fn linien_verlustfrei_aufgeteilt() {
        let big = entities_only(&many(|_| line(), 30_000));
        let chunks = split_chunks(&big, 4).expect("aufgeteilt");
        assert!(chunks.len() > 1);
        let total: usize = chunks.iter().map(|c| import_bytes(c).unwrap().contours.len()).sum();
        assert_eq!(total, 30_000);
    }

    #[test]
    fn nie_mitten_in_polyline() {
        let body: String = (0..20_000)
            .map(|i| {
                let mut s = line() + &pad();
                if i % 50 == 0 {
                    s += &(polyline() + &pad());
                }
                s
            })
            .collect();
        let big = entities_only(&body);
        let chunks = split_chunks(&big, 6).expect("aufgeteilt");
        let (mut lines, mut polys) = (0, 0);
        for c in &chunks {
            for k in import_bytes(c).expect("jedes Stück gültig").contours {
                if k.pts.len() == 2 {
                    lines += 1;
                } else {
                    polys += 1;
                }
            }
        }
        assert_eq!(lines, 20_000);
        assert_eq!(polys, 400);
    }

    #[test]
    fn nie_mitten_in_insert_mit_attributen() {
        let big = entities_only(&many(insert_with_attrib, 20_000));
        let chunks = split_chunks(&big, 5).expect("aufgeteilt");
        let mut inserts = 0;
        for c in &chunks {
            let d = import_bytes(c).expect("jedes Stück gültig");
            inserts += d.entity_counts.iter().find(|(t, _)| t == "INSERT").map_or(0, |(_, n)| *n);
        }
        assert_eq!(inserts, 20_000);
    }
}
