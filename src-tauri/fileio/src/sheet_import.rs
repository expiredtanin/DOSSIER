// Tabellen lesen ([61] Raumprogramm-Import): .xlsx, .ods und .csv/.tsv/.txt → Tabellenblätter mit Zellen
// (Text/Zahl/leer). Eigener Leser auf den ohnehin vorhandenen Crates `zip` und `quick-xml` (kein
// zusätzliches Crate, WASM-tauglich). Nur Werte, keine Formeln/Formate: bei xlsx/ods zählt der
// zwischengespeicherte Wert der Zelle; Daten erscheinen als Zahl (Seriennummer).
//
// Grenzen gegen Zip-Bomben und Riesenblätter: `MAX_ENTRY_BYTES`, `MAX_ROWS`, `MAX_COLS`. Unsinn ergibt
// einen Fehler-String, nie einen Panic.
//
// CSV: Kodierung UTF-8 (mit/ohne BOM), UTF-16 (mit BOM) oder sonst Windows-1252; Trenner Semikolon,
// Komma oder Tab, erkannt an den ersten Zeilen (Anführungszeichen beachtet). CSV-Zellen bleiben Text —
// ob "1'250,5" eine Zahl ist, entscheidet `parse_number`.

use std::collections::HashMap;
use std::io::{Cursor, Read};

use quick_xml::events::Event;
use quick_xml::Reader;

const MAX_ENTRY_BYTES: u64 = 256 * 1024 * 1024;
const MAX_ROWS: usize = 100_000;
const MAX_COLS: usize = 512;
const MAX_SHEETS: usize = 64;

#[derive(Debug, Clone, PartialEq)]
pub enum Cell {
    Empty,
    Text(String),
    Num(f64),
}

#[derive(Debug, Clone, PartialEq)]
pub struct Sheet {
    pub name: String,
    pub rows: Vec<Vec<Cell>>,
}

/// Tabelle lesen; das Format wird am Inhalt erkannt (ZIP → xlsx/ods, sonst CSV). `file_name` ist nur Hinweis
/// (Endung `.tsv` bevorzugt Tab als Trenner, Blattname bei CSV).
pub fn read_sheets(bytes: &[u8], file_name: &str) -> Result<Vec<Sheet>, String> {
    if bytes.is_empty() {
        return Err("Leere Datei".into());
    }
    if bytes.starts_with(b"PK\x03\x04") {
        read_zip(bytes)
    } else {
        Ok(vec![read_csv(bytes, file_name)])
    }
}

// ── Zahlen ──────────────────────────────────────────────────────────────────

/// Zahl aus Zelltext: Komma oder Punkt als Dezimaltrenner, Apostroph/Leerzeichen/Punkt/Komma als Tausender
/// ("1'250,5", "1 250,5", "1.250,5", "1,250.5"), Einheit am Ende ("25 m²", "m2", "qm") wird ignoriert.
/// Ein einzelnes Trennzeichen gilt als Dezimaltrenner ("12,5", "12.5", auch "1,250"); mehrere gleiche als
/// Tausender. Alles andere → `None`.
pub fn parse_number(text: &str) -> Option<f64> {
    let mut s = text.trim().to_string();
    let lower = s.to_lowercase();
    for unit in ["m²", "m2", "m^2", "qm", "㎡", "sqm"] {
        if lower.ends_with(unit) {
            // `lower` kann bei exotischen Zeichen andere Bytelängen haben als `s`: über Zeichen kürzen.
            let n = unit.chars().count();
            let keep = s.chars().count().saturating_sub(n);
            s = s.chars().take(keep).collect();
            break;
        }
    }
    let s = s.trim();
    if s.is_empty() {
        return None;
    }
    let (neg, body) = match s.strip_prefix('-').or_else(|| s.strip_prefix('−')) {
        Some(r) => (true, r.trim_start()),
        None => (false, s.strip_prefix('+').unwrap_or(s)),
    };
    // Tausender-Apostrophe und Leerzeichen (auch schmal/geschützt) entfernen.
    let body: String = body
        .chars()
        .filter(|c| !matches!(c, '\'' | '’' | 'ʼ' | '´' | '`' | ' ' | '\u{a0}' | '\u{202f}' | '\u{2009}'))
        .collect();
    if !body.chars().all(|c| c.is_ascii_digit() || c == '.' || c == ',') || !body.chars().any(|c| c.is_ascii_digit()) {
        return None;
    }
    let dots = body.matches('.').count();
    let commas = body.matches(',').count();
    let normalized = if dots > 0 && commas > 0 {
        // Das hintere der beiden Zeichen ist der Dezimaltrenner (nur einmal), das andere nur Tausender.
        let last_dot = body.rfind('.')?;
        let last_comma = body.rfind(',')?;
        let (dec, thou) = if last_dot > last_comma { ('.', ',') } else { (',', '.') };
        if body.matches(dec).count() != 1 || body.rfind(thou)? > body.rfind(dec)? {
            return None;
        }
        body.replace(thou, "").replace(dec, ".")
    } else if dots > 1 || commas > 1 {
        // Mehrfach gleiches Zeichen = Tausender: erste Gruppe 1–3 Ziffern, übrige genau 3.
        let sep = if dots > 1 { '.' } else { ',' };
        let groups: Vec<&str> = body.split(sep).collect();
        if groups.iter().skip(1).any(|g| g.len() != 3) || groups[0].is_empty() || groups[0].len() > 3 {
            return None;
        }
        groups.concat()
    } else {
        body.replace(',', ".")
    };
    let v: f64 = normalized.parse().ok()?;
    if v.is_finite() {
        Some(if neg { -v } else { v })
    } else {
        None
    }
}

// ── ZIP: xlsx / ods ─────────────────────────────────────────────────────────

fn read_zip(bytes: &[u8]) -> Result<Vec<Sheet>, String> {
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).map_err(|e| format!("Keine Tabellendatei (ZIP): {e}"))?;
    let mut files: HashMap<String, Vec<u8>> = HashMap::new();
    for i in 0..zip.len() {
        let Ok(entry) = zip.by_index(i) else { continue };
        if entry.is_dir() {
            continue;
        }
        let name = entry.name().replace('\\', "/");
        // Nur, was wir brauchen (Bilder u. ä. nicht in den Speicher laden).
        let wanted = name == "content.xml"
            || name == "xl/workbook.xml"
            || name == "xl/_rels/workbook.xml.rels"
            || name == "xl/sharedStrings.xml"
            || (name.starts_with("xl/worksheets/") && name.ends_with(".xml"));
        if !wanted {
            continue;
        }
        let mut buf = Vec::new();
        entry.take(MAX_ENTRY_BYTES + 1).read_to_end(&mut buf).map_err(|e| format!("ZIP-Eintrag {name}: {e}"))?;
        if buf.len() as u64 > MAX_ENTRY_BYTES {
            return Err(format!("ZIP-Eintrag {name} ist zu gross"));
        }
        files.insert(name, buf);
    }
    if let Some(content) = files.get("content.xml") {
        return read_ods(content);
    }
    if files.contains_key("xl/workbook.xml") {
        return read_xlsx(&files);
    }
    Err("Weder xlsx noch ods: keine Tabelle in der ZIP-Datei".into())
}

fn local(name: &[u8]) -> String {
    let s = String::from_utf8_lossy(name);
    match s.rfind(':') {
        Some(i) => s[i + 1..].to_string(),
        None => s.into_owned(),
    }
}

fn attr(e: &quick_xml::events::BytesStart, key: &str) -> Option<String> {
    for a in e.attributes().flatten() {
        if local(a.key.as_ref()) == key {
            return a.unescape_value().ok().map(|c| c.into_owned());
        }
    }
    None
}

fn strip_bom(b: &[u8]) -> &[u8] {
    b.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(b)
}

/// "B3" → Spalte 1 (0-basiert); ohne Buchstaben → None.
fn col_of(r: &str) -> Option<usize> {
    let mut c = 0usize;
    let mut any = false;
    for ch in r.chars() {
        if ch.is_ascii_alphabetic() {
            c = c.checked_mul(26)?.checked_add((ch.to_ascii_uppercase() as u8 - b'A' + 1) as usize)?;
            any = true;
        } else {
            break;
        }
    }
    if any {
        Some(c - 1)
    } else {
        None
    }
}

fn set_cell(rows: &mut Vec<Vec<Cell>>, r: usize, c: usize, cell: Cell) {
    if r >= MAX_ROWS || c >= MAX_COLS {
        return;
    }
    while rows.len() <= r {
        rows.push(Vec::new());
    }
    let row = &mut rows[r];
    while row.len() <= c {
        row.push(Cell::Empty);
    }
    row[c] = cell;
}

fn trim_rows(rows: &mut Vec<Vec<Cell>>) {
    for row in rows.iter_mut() {
        while matches!(row.last(), Some(Cell::Empty)) {
            row.pop();
        }
    }
    while matches!(rows.last(), Some(r) if r.is_empty()) {
        rows.pop();
    }
}

fn entity_text(r: &quick_xml::events::BytesRef) -> String {
    if let Ok(Some(c)) = r.resolve_char_ref() {
        c.to_string()
    } else {
        quick_xml::escape::resolve_predefined_entity(&String::from_utf8_lossy(r)).unwrap_or("").to_string()
    }
}

/// Texte der `<si>`-Elemente (alle `<t>`, ohne Phonetik `<rPh>`).
fn read_xlsx_strings(xml: &[u8]) -> Result<Vec<String>, String> {
    let mut reader = Reader::from_reader(strip_bom(xml));
    let mut out = Vec::new();
    let mut cur = String::new();
    let (mut in_si, mut in_t, mut in_ph) = (false, false, false);
    loop {
        match reader.read_event().map_err(|e| format!("XML: {e}"))? {
            Event::Start(e) => match local(e.name().as_ref()).as_str() {
                "si" => {
                    in_si = true;
                    cur.clear();
                }
                "t" if in_si && !in_ph => in_t = true,
                "rPh" => in_ph = true,
                _ => {}
            },
            Event::Empty(e) if local(e.name().as_ref()) == "si" => out.push(String::new()),
            Event::End(e) => match local(e.name().as_ref()).as_str() {
                "si" => {
                    in_si = false;
                    out.push(std::mem::take(&mut cur));
                }
                "t" => in_t = false,
                "rPh" => in_ph = false,
                _ => {}
            },
            Event::Text(t) if in_t => cur.push_str(&t.decode().map_err(|e| format!("XML: {e}"))?),
            Event::GeneralRef(r) if in_t => cur.push_str(&entity_text(&r)),
            Event::Eof => break,
            _ => {}
        }
        if out.len() > 2_000_000 {
            return Err("Zu viele Texte".into());
        }
    }
    Ok(out)
}

fn read_xlsx(files: &HashMap<String, Vec<u8>>) -> Result<Vec<Sheet>, String> {
    let shared = match files.get("xl/sharedStrings.xml") {
        Some(x) => read_xlsx_strings(x)?,
        None => Vec::new(),
    };
    // Beziehungen: Id → Ziel
    let mut rels: HashMap<String, String> = HashMap::new();
    if let Some(x) = files.get("xl/_rels/workbook.xml.rels") {
        let mut reader = Reader::from_reader(strip_bom(x));
        loop {
            match reader.read_event().map_err(|e| format!("XML: {e}"))? {
                Event::Start(e) | Event::Empty(e) if local(e.name().as_ref()) == "Relationship" => {
                    if let (Some(id), Some(target)) = (attr(&e, "Id"), attr(&e, "Target")) {
                        rels.insert(id, target);
                    }
                }
                Event::Eof => break,
                _ => {}
            }
        }
    }
    // Blätter in Reihenfolge
    let mut sheet_refs: Vec<(String, String)> = Vec::new();
    {
        let wb = files.get("xl/workbook.xml").ok_or("workbook.xml fehlt")?;
        let mut reader = Reader::from_reader(strip_bom(wb));
        loop {
            match reader.read_event().map_err(|e| format!("XML: {e}"))? {
                Event::Start(e) | Event::Empty(e) if local(e.name().as_ref()) == "sheet" => {
                    sheet_refs.push((attr(&e, "name").unwrap_or_default(), attr(&e, "id").unwrap_or_default()));
                }
                Event::Eof => break,
                _ => {}
            }
        }
    }
    sheet_refs.truncate(MAX_SHEETS);
    let mut out = Vec::new();
    for (i, (name, rid)) in sheet_refs.iter().enumerate() {
        let target = rels.get(rid).cloned().unwrap_or_else(|| format!("worksheets/sheet{}.xml", i + 1));
        let path = match target.strip_prefix('/') {
            Some(abs) => abs.to_string(),
            None => format!("xl/{target}"),
        };
        let Some(xml) = files.get(&path) else { continue };
        out.push(Sheet { name: name.clone(), rows: read_xlsx_sheet(xml, &shared)? });
    }
    if out.is_empty() {
        return Err("Keine Tabellenblätter gefunden".into());
    }
    Ok(out)
}

fn read_xlsx_sheet(xml: &[u8], shared: &[String]) -> Result<Vec<Vec<Cell>>, String> {
    let mut reader = Reader::from_reader(strip_bom(xml));
    let mut rows: Vec<Vec<Cell>> = Vec::new();
    let (mut row_i, mut next_col, mut col) = (0usize, 0usize, 0usize);
    let mut ctype = String::new();
    let (mut in_v, mut in_t, mut in_cell) = (false, false, false);
    let (mut vtext, mut ttext) = (String::new(), String::new());
    loop {
        match reader.read_event().map_err(|e| format!("XML: {e}"))? {
            Event::Start(e) => match local(e.name().as_ref()).as_str() {
                "row" => {
                    if let Some(r) = attr(&e, "r").and_then(|s| s.parse::<usize>().ok()) {
                        row_i = r.saturating_sub(1);
                    }
                    next_col = 0;
                }
                "c" => {
                    col = attr(&e, "r").and_then(|r| col_of(&r)).unwrap_or(next_col);
                    next_col = col + 1;
                    ctype = attr(&e, "t").unwrap_or_default();
                    in_cell = true;
                    vtext.clear();
                    ttext.clear();
                }
                "v" if in_cell => in_v = true,
                "t" if in_cell => in_t = true,
                _ => {}
            },
            Event::Empty(e) => {
                if local(e.name().as_ref()) == "c" {
                    let c = attr(&e, "r").and_then(|r| col_of(&r)).unwrap_or(next_col);
                    next_col = c + 1;
                }
            }
            Event::Text(t) => {
                if in_v {
                    vtext.push_str(&t.decode().map_err(|e| format!("XML: {e}"))?);
                } else if in_t {
                    ttext.push_str(&t.decode().map_err(|e| format!("XML: {e}"))?);
                }
            }
            Event::GeneralRef(r) if in_v || in_t => {
                let s = entity_text(&r);
                if in_v {
                    vtext.push_str(&s)
                } else {
                    ttext.push_str(&s)
                }
            }
            Event::End(e) => match local(e.name().as_ref()).as_str() {
                "v" => in_v = false,
                "t" => in_t = false,
                "row" => row_i += 1,
                "c" => {
                    in_cell = false;
                    let cell = match ctype.as_str() {
                        "s" => vtext
                            .trim()
                            .parse::<usize>()
                            .ok()
                            .and_then(|i| shared.get(i))
                            .map(|s| Cell::Text(s.clone()))
                            .unwrap_or(Cell::Empty),
                        "inlineStr" => Cell::Text(ttext.clone()),
                        "str" | "e" => Cell::Text(vtext.clone()),
                        "b" => Cell::Num(if vtext.trim() == "1" { 1.0 } else { 0.0 }),
                        _ => match vtext.trim().parse::<f64>() {
                            Ok(v) if v.is_finite() => Cell::Num(v),
                            _ if !vtext.trim().is_empty() => Cell::Text(vtext.clone()),
                            _ => Cell::Empty,
                        },
                    };
                    match cell {
                        Cell::Empty => {}
                        Cell::Text(ref s) if s.is_empty() => {}
                        c => set_cell(&mut rows, row_i, col, c),
                    }
                }
                _ => {}
            },
            Event::Eof => break,
            _ => {}
        }
    }
    trim_rows(&mut rows);
    Ok(rows)
}

fn read_ods(xml: &[u8]) -> Result<Vec<Sheet>, String> {
    let mut reader = Reader::from_reader(strip_bom(xml));
    let mut sheets: Vec<Sheet> = Vec::new();
    let mut cur: Option<Sheet> = None;
    let (mut row_i, mut col_i) = (0usize, 0usize);
    let mut row_repeat = 1usize;
    let mut row_cells: Vec<(usize, Cell)> = Vec::new();
    let mut cell_val: Option<Cell> = None;
    let mut cell_repeat = 1usize;
    let (mut in_cell, mut in_p) = (false, false);
    let mut para: Vec<String> = Vec::new();
    let mut depth_table = 0usize; // verschachtelte Tabellen (Unterobjekte) ignorieren
    loop {
        let ev = reader.read_event().map_err(|e| format!("XML: {e}"))?;
        match &ev {
            Event::Start(e) | Event::Empty(e) => {
                let is_empty = matches!(ev, Event::Empty(_));
                match local(e.name().as_ref()).as_str() {
                    "table" => {
                        if depth_table == 0 && cur.is_none() && sheets.len() < MAX_SHEETS {
                            cur = Some(Sheet { name: attr(e, "name").unwrap_or_default(), rows: Vec::new() });
                            row_i = 0;
                        }
                        if !is_empty {
                            depth_table += 1;
                        } else if depth_table == 0 {
                            if let Some(s) = cur.take() {
                                sheets.push(s);
                            }
                        }
                    }
                    "table-row" if depth_table == 1 => {
                        row_repeat = attr(e, "number-rows-repeated").and_then(|s| s.parse().ok()).unwrap_or(1);
                        col_i = 0;
                        row_cells.clear();
                        if is_empty {
                            row_i = row_i.saturating_add(row_repeat);
                        }
                    }
                    "table-cell" | "covered-table-cell" if depth_table == 1 => {
                        cell_repeat = attr(e, "number-columns-repeated").and_then(|s| s.parse().ok()).unwrap_or(1);
                        let vtype = attr(e, "value-type").unwrap_or_default();
                        cell_val = match vtype.as_str() {
                            "float" | "percentage" | "currency" => {
                                attr(e, "value").and_then(|s| s.parse::<f64>().ok()).filter(|v| v.is_finite()).map(Cell::Num)
                            }
                            "boolean" => attr(e, "boolean-value").map(|s| Cell::Num(if s == "true" { 1.0 } else { 0.0 })),
                            "date" => attr(e, "date-value").map(Cell::Text),
                            _ => None,
                        };
                        para.clear();
                        if is_empty {
                            finish_ods_cell(&mut row_cells, &mut col_i, cell_val.take(), &para, cell_repeat);
                        } else {
                            in_cell = true;
                        }
                    }
                    "p" if in_cell => {
                        in_p = true;
                        para.push(String::new());
                    }
                    "s" if in_p => {
                        // text:s = Leerzeichen (c = Anzahl)
                        let n = attr(e, "c").and_then(|s| s.parse::<usize>().ok()).unwrap_or(1).min(100);
                        if let Some(p) = para.last_mut() {
                            p.push_str(&" ".repeat(n));
                        }
                    }
                    "tab" if in_p => {
                        if let Some(p) = para.last_mut() {
                            p.push('\t');
                        }
                    }
                    _ => {}
                }
            }
            Event::Text(t) if in_p => {
                if let Some(p) = para.last_mut() {
                    p.push_str(&t.decode().map_err(|e| format!("XML: {e}"))?);
                }
            }
            Event::GeneralRef(r) if in_p => {
                if let Some(p) = para.last_mut() {
                    p.push_str(&entity_text(r));
                }
            }
            Event::End(e) => match local(e.name().as_ref()).as_str() {
                "p" => in_p = false,
                "table-cell" | "covered-table-cell" if depth_table == 1 => {
                    in_cell = false;
                    finish_ods_cell(&mut row_cells, &mut col_i, cell_val.take(), &para, cell_repeat);
                }
                "table-row" if depth_table == 1 => {
                    if let Some(s) = cur.as_mut() {
                        if !row_cells.is_empty() {
                            for k in 0..row_repeat.min(1000) {
                                for (c, cell) in &row_cells {
                                    set_cell(&mut s.rows, row_i + k, *c, cell.clone());
                                }
                            }
                        }
                    }
                    row_i = row_i.saturating_add(row_repeat);
                }
                "table" => {
                    depth_table = depth_table.saturating_sub(1);
                    if depth_table == 0 {
                        if let Some(mut s) = cur.take() {
                            trim_rows(&mut s.rows);
                            sheets.push(s);
                        }
                    }
                }
                _ => {}
            },
            Event::Eof => break,
            _ => {}
        }
    }
    if sheets.is_empty() {
        return Err("Keine Tabellenblätter gefunden".into());
    }
    Ok(sheets)
}

fn finish_ods_cell(row: &mut Vec<(usize, Cell)>, col: &mut usize, val: Option<Cell>, para: &[String], repeat: usize) {
    let cell = match val {
        Some(c) => c,
        None => {
            let text = para.join("\n");
            if text.is_empty() {
                Cell::Empty
            } else {
                Cell::Text(text)
            }
        }
    };
    if cell != Cell::Empty {
        for k in 0..repeat.min(64) {
            if *col + k < MAX_COLS {
                row.push((*col + k, cell.clone()));
            }
        }
    }
    *col = col.saturating_add(repeat);
}

// ── CSV ─────────────────────────────────────────────────────────────────────

const CP1252_HIGH: [char; 32] = [
    '€', '\u{81}', '‚', 'ƒ', '„', '…', '†', '‡', 'ˆ', '‰', 'Š', '‹', 'Œ', '\u{8d}', 'Ž', '\u{8f}', '\u{90}', '‘', '’', '“', '”', '•', '–', '—', '˜', '™', 'š', '›', 'œ',
    '\u{9d}', 'ž', 'Ÿ',
];

/// Bytes → Text: UTF-8 (mit/ohne BOM), UTF-16 mit BOM, sonst Windows-1252.
pub fn decode_text(bytes: &[u8]) -> String {
    if let Some(b) = bytes.strip_prefix(&[0xFF, 0xFE]) {
        return decode_utf16(b, true);
    }
    if let Some(b) = bytes.strip_prefix(&[0xFE, 0xFF]) {
        return decode_utf16(b, false);
    }
    let b = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
    match std::str::from_utf8(b) {
        Ok(s) => s.to_string(),
        Err(_) => b
            .iter()
            .map(|&x| match x {
                0x80..=0x9f => CP1252_HIGH[(x - 0x80) as usize],
                _ => x as char, // 0x00–0x7f ASCII, 0xa0–0xff = Latin-1 = gleiche Codepunkte
            })
            .collect(),
    }
}

fn decode_utf16(b: &[u8], le: bool) -> String {
    let units: Vec<u16> = b
        .chunks_exact(2)
        .map(|c| if le { u16::from_le_bytes([c[0], c[1]]) } else { u16::from_be_bytes([c[0], c[1]]) })
        .collect();
    String::from_utf16_lossy(&units)
}

/// Trenner erkennen: in den ersten Zeilen (ausserhalb von Anführungszeichen) je Kandidat zählen; die meisten
/// Zeilen mit dem Trenner (und dann die kleinste Anzahl je Zeile) gewinnen. Gleichstand: Reihenfolge der
/// Kandidaten (Semikolon, Tab, Komma; bei `.tsv` zuerst Tab).
fn detect_delimiter(text: &str, prefer_tab: bool) -> char {
    let candidates: [char; 3] = if prefer_tab { ['\t', ';', ','] } else { [';', '\t', ','] };
    let mut best = (candidates[0], 0usize);
    for &d in &candidates {
        let mut counts: Vec<usize> = Vec::new();
        let (mut n, mut quoted) = (0usize, false);
        for ch in text.chars() {
            if ch == '"' {
                quoted = !quoted;
            } else if !quoted && ch == d {
                n += 1;
            } else if !quoted && ch == '\n' {
                counts.push(n);
                n = 0;
                if counts.len() >= 12 {
                    break;
                }
            }
        }
        if counts.len() < 12 {
            counts.push(n);
        }
        let nonzero: Vec<usize> = counts.iter().copied().filter(|&c| c > 0).collect();
        let Some(&min) = nonzero.iter().min() else { continue };
        let score = nonzero.len() * 10 + min.min(9);
        if score > best.1 {
            best = (d, score);
        }
    }
    best.0
}

fn push_field(row: &mut Vec<String>, field: &mut String, was_quoted: &mut bool) {
    let f = std::mem::take(field);
    if row.len() < MAX_COLS {
        row.push(if *was_quoted { f } else { f.trim().to_string() });
    }
    *was_quoted = false;
}

fn parse_csv_text(text: &str, delim: char) -> Vec<Vec<String>> {
    let mut rows: Vec<Vec<String>> = Vec::new();
    let mut row: Vec<String> = Vec::new();
    let mut field = String::new();
    let (mut quoted, mut was_quoted) = (false, false);
    let mut chars = text.chars().peekable();
    while let Some(ch) = chars.next() {
        if quoted {
            if ch == '"' {
                if chars.peek() == Some(&'"') {
                    field.push('"');
                    chars.next();
                } else {
                    quoted = false;
                }
            } else {
                field.push(ch);
            }
        } else if ch == '"' && field.trim().is_empty() {
            field.clear();
            quoted = true;
            was_quoted = true;
        } else if ch == delim {
            push_field(&mut row, &mut field, &mut was_quoted);
        } else if ch == '\n' || ch == '\r' {
            if ch == '\r' && chars.peek() == Some(&'\n') {
                chars.next();
            }
            push_field(&mut row, &mut field, &mut was_quoted);
            rows.push(std::mem::take(&mut row));
            if rows.len() >= MAX_ROWS {
                return rows;
            }
        } else {
            field.push(ch);
        }
    }
    if !field.is_empty() || !row.is_empty() || was_quoted {
        push_field(&mut row, &mut field, &mut was_quoted);
        rows.push(row);
    }
    rows
}

fn read_csv(bytes: &[u8], file_name: &str) -> Sheet {
    let text = decode_text(bytes);
    let delim = detect_delimiter(&text, file_name.to_lowercase().ends_with(".tsv"));
    let mut rows: Vec<Vec<Cell>> = parse_csv_text(&text, delim)
        .into_iter()
        .map(|r| r.into_iter().map(|f| if f.is_empty() { Cell::Empty } else { Cell::Text(f) }).collect())
        .collect();
    trim_rows(&mut rows);
    let base = file_name.rsplit(['/', '\\']).next().unwrap_or(file_name);
    let name = base.rsplit_once('.').map(|(n, _)| n).unwrap_or(base);
    Sheet { name: if name.is_empty() { "CSV".into() } else { name.to_string() }, rows }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn t(s: &str) -> Cell {
        Cell::Text(s.into())
    }

    #[test]
    fn zahlen_formate() {
        assert_eq!(parse_number("12"), Some(12.0));
        assert_eq!(parse_number("12,5"), Some(12.5));
        assert_eq!(parse_number("12.5"), Some(12.5));
        assert_eq!(parse_number("1'250,5"), Some(1250.5));
        assert_eq!(parse_number("1’250.5"), Some(1250.5));
        assert_eq!(parse_number("1 250,5"), Some(1250.5));
        assert_eq!(parse_number("1.250,5"), Some(1250.5));
        assert_eq!(parse_number("1,250.5"), Some(1250.5));
        assert_eq!(parse_number("1,250,000"), Some(1_250_000.0));
        assert_eq!(parse_number("1'250'000"), Some(1_250_000.0));
        assert_eq!(parse_number("25 m²"), Some(25.0));
        assert_eq!(parse_number("25,5m2"), Some(25.5));
        assert_eq!(parse_number("-3,5"), Some(-3.5));
        assert_eq!(parse_number(""), None);
        assert_eq!(parse_number("abc"), None);
        assert_eq!(parse_number("1.2.3"), None);
        assert_eq!(parse_number("12,5,3"), None);
        assert_eq!(parse_number("-"), None);
        assert_eq!(parse_number("."), None);
        assert_eq!(parse_number("1e5"), None);
        assert_eq!(parse_number("İİİ"), None);
    }

    #[test]
    fn csv_trenner_und_kodierung() {
        let s = read_sheets("Raum;Fläche;Anzahl\nKüche;12,5;1\n\"Bad; WC\";6;2\n".as_bytes(), "p.csv").unwrap();
        assert_eq!(s[0].name, "p");
        assert_eq!(s[0].rows[1], vec![t("Küche"), t("12,5"), t("1")]);
        assert_eq!(s[0].rows[2][0], t("Bad; WC"));
        let s = read_sheets(b"Raum,Fl\xe4che,Anzahl\nK\xfcche,12.5,1\n", "p.csv").unwrap();
        assert_eq!(s[0].rows[0], vec![t("Raum"), t("Fläche"), t("Anzahl")]);
        assert_eq!(s[0].rows[1][0], t("Küche"));
        // Windows-1252-Sonderzeichen: Euro und m²-Hochzahl (0xB2).
        let s = read_sheets(b"a\x80;m\xb2\n", "x.csv").unwrap();
        assert_eq!(s[0].rows[0], vec![t("a€"), t("m²")]);
        let s = read_sheets("Raum\tFläche\nKüche\t12,5\n".as_bytes(), "p.tsv").unwrap();
        assert_eq!(s[0].rows[1], vec![t("Küche"), t("12,5")]);
        // BOM + Zeilenumbruch in Anführungszeichen + CRLF
        let s = read_sheets(b"\xef\xbb\xbfA;B\r\n\"x\ny\";2\r\n", "q.csv").unwrap();
        assert_eq!(s[0].rows[1], vec![t("x\ny"), t("2")]);
        // Dezimalkomma in Semikolon-Datei darf nicht als Trenner gelten.
        let s = read_sheets(b"A;B\nx;1,5\ny;2,5\n", "q.csv").unwrap();
        assert_eq!(s[0].rows[1], vec![t("x"), t("1,5")]);
    }

    #[test]
    fn csv_utf16() {
        let mut b = vec![0xFF, 0xFE];
        for u in "A\tB\nä\t1\n".encode_utf16() {
            b.extend_from_slice(&u.to_le_bytes());
        }
        let s = read_sheets(&b, "u.txt").unwrap();
        assert_eq!(s[0].rows[1], vec![t("ä"), t("1")]);
    }

    #[test]
    fn unsinn_ist_fehler_oder_leer() {
        assert!(read_sheets(b"", "x.csv").is_err());
        assert!(read_sheets(b"PK\x03\x04kaputt", "x.xlsx").is_err());
        let s = read_sheets(&[0u8, 1, 2, 255, 254], "x.csv").unwrap();
        assert_eq!(s.len(), 1);
    }

    fn zip_of(files: &[(&str, &str)]) -> Vec<u8> {
        let mut z = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for (n, c) in files {
            z.start_file(*n, zip::write::SimpleFileOptions::default()).unwrap();
            z.write_all(c.as_bytes()).unwrap();
        }
        z.finish().unwrap().into_inner()
    }

    #[test]
    fn xlsx_lesen() {
        let bytes = zip_of(&[
            ("[Content_Types].xml", "<Types/>"),
            (
                "xl/workbook.xml",
                r#"<workbook xmlns="x" xmlns:r="r"><sheets><sheet name="Programm" sheetId="1" r:id="rId1"/><sheet name="Leer" sheetId="2" r:id="rId2"/></sheets></workbook>"#,
            ),
            (
                "xl/_rels/workbook.xml.rels",
                r#"<Relationships><Relationship Id="rId1" Type="t" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="t" Target="/xl/worksheets/sheet2.xml"/></Relationships>"#,
            ),
            (
                "xl/sharedStrings.xml",
                r#"<sst><si><t>Raum</t></si><si><t>Fläche</t></si><si><r><t>Wohn</t></r><r><t xml:space="preserve">en &amp; Essen</t></r></si><si><t>Bad</t><rPh><t>x</t></rPh></si></sst>"#,
            ),
            (
                "xl/worksheets/sheet1.xml",
                r#"<worksheet><sheetData>
                <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="D1" t="inlineStr"><is><t>Bem</t></is></c></row>
                <row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>28.5</v></c></row>
                <row r="4"><c r="B4"><f>B2*2</f><v>57</v></c><c r="A4" t="s"><v>3</v></c><c r="C4"/></row>
                </sheetData></worksheet>"#,
            ),
            ("xl/worksheets/sheet2.xml", "<worksheet><sheetData/></worksheet>"),
        ]);
        let s = read_sheets(&bytes, "p.xlsx").unwrap();
        assert_eq!(s.len(), 2);
        assert_eq!(s[0].name, "Programm");
        assert_eq!(s[0].rows[0], vec![t("Raum"), t("Fläche"), Cell::Empty, t("Bem")]);
        assert_eq!(s[0].rows[1], vec![t("Wohnen & Essen"), Cell::Num(28.5)]);
        assert!(s[0].rows[2].is_empty());
        assert_eq!(s[0].rows[3], vec![t("Bad"), Cell::Num(57.0)]);
        assert!(s[1].rows.is_empty());
    }

    #[test]
    fn ods_lesen() {
        let content = r#"<?xml version="1.0"?><office:document-content xmlns:office="o" xmlns:table="t" xmlns:text="x"><office:body><office:spreadsheet>
        <table:table table:name="Blatt1">
          <table:table-row><table:table-cell office:value-type="string"><text:p>Raum</text:p></table:table-cell><table:table-cell office:value-type="string"><text:p>Fl&#228;che</text:p></table:table-cell></table:table-row>
          <table:table-row><table:table-cell office:value-type="string"><text:p>Wohnen</text:p><text:p>zwei</text:p></table:table-cell><table:table-cell office:value-type="float" office:value="28.5"><text:p>28,5</text:p></table:table-cell></table:table-row>
          <table:table-row table:number-rows-repeated="3"><table:table-cell table:number-columns-repeated="2"/></table:table-row>
          <table:table-row><table:table-cell table:number-columns-repeated="100"/><table:table-cell office:value-type="float" office:value="7"/></table:table-row>
          <table:table-row table:number-rows-repeated="1048000"><table:table-cell table:number-columns-repeated="16384"/></table:table-row>
        </table:table>
        <table:table table:name="Zwei"><table:table-row><table:table-cell office:value-type="string"><text:p>a<text:s text:c="2"/>b</text:p></table:table-cell></table:table-row></table:table>
        </office:spreadsheet></office:body></office:document-content>"#;
        let bytes = zip_of(&[("mimetype", "application/vnd.oasis.opendocument.spreadsheet"), ("content.xml", content)]);
        let s = read_sheets(&bytes, "p.ods").unwrap();
        assert_eq!(s.len(), 2);
        assert_eq!(s[0].name, "Blatt1");
        assert_eq!(s[0].rows[0], vec![t("Raum"), t("Fläche")]);
        assert_eq!(s[0].rows[1], vec![t("Wohnen\nzwei"), Cell::Num(28.5)]);
        assert_eq!(s[0].rows.len(), 6);
        assert_eq!(s[0].rows[5].len(), 101);
        assert_eq!(s[0].rows[5][100], Cell::Num(7.0));
        assert_eq!(s[1].rows[0], vec![t("a  b")]);
    }

    /// Echte Dateien aus LibreOffice (xlsx, ods) mit Formel-Summe, zwei Blättern und Zahl-als-Text.
    fn check_fixture(bytes: &[u8], name: &str) {
        let s = read_sheets(bytes, name).unwrap();
        assert_eq!(s.len(), 2);
        assert_eq!(s[0].name, "Programm");
        assert_eq!(s[1].name, "Notizen");
        let r = &s[0].rows;
        assert_eq!(r[0], vec![t("Raumprogramm Schulhaus Muster")]);
        assert!(r[1].is_empty());
        assert_eq!(r[2], vec![t("Raum"), t("Fläche [m²]"), t("Anzahl"), t("Flächenart"), t("Gruppe"), t("Bemerkung")]);
        assert_eq!(r[3], vec![t("Klassenzimmer"), Cell::Num(72.0), Cell::Num(6.0), t("HNF"), t("Unterricht"), t("Südlicht")]);
        assert_eq!(r[4][1], Cell::Num(36.5));
        assert_eq!(r[6][1], t("18,5")); // als Text eingegeben
        // Summenzelle: zwischengespeicherter Wert der Formel (72·6 + 36.5·4 + 60 + 18,5-Text zählt 0 → 638).
        assert!(matches!(r[7][1], Cell::Num(v) if v > 600.0), "Formelwert fehlt: {:?}", r[7]);
        assert_eq!(s[1].rows, vec![vec![t("nur Text")]]);
    }

    #[test]
    fn echte_dateien() {
        check_fixture(include_bytes!("../testdata/raumprogramm.xlsx"), "p.xlsx");
        check_fixture(include_bytes!("../testdata/raumprogramm.ods"), "p.ods");
    }
}
