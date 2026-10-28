// PDF-Objekte lesen ([76]): Lexer, Objektmodell, Querverweise (klassische Tabelle und XRef-Stream,
// /Prev-Kette, hybride Dateien über /XRefStm), Objekt-Streams (/ObjStm) und Stream-Filter
// (FlateDecode mit PNG-/TIFF-Prädiktor, ASCIIHex, ASCII85, RunLength, LZW). Eigene, kleine
// Implementierung statt `lopdf` (viele Abhängigkeiten, u. a. Krypto/Zeit): wir lesen nur, und nur
// so viel, wie der Vektor-Import (`pdf_vector.rs`) braucht.
//
// Robustheit: Ist die Querverweistabelle kaputt oder fehlt sie, wird die Datei nach `n g obj`
// abgesucht (Wiederherstellung wie in gängigen Lesern). Alle Zugriffe sind bereichsgeprüft,
// Rekursionen begrenzt — kaputte Dateien ergeben `Err`/leere Objekte, nie einen Panic.
// Verschlüsselte Dateien werden abgelehnt (`Err`).

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::rc::Rc;

/// Obergrenze für einen entpackten Stream (Schutz gegen „Zip-Bomben").
pub const MAX_DECODED: u64 = 256 * 1024 * 1024;
/// Verschachtelungstiefe von Arrays/Dictionaries beim Parsen.
const MAX_NEST: usize = 64;
/// Tiefe beim Auflösen indirekter Verweise (Length → Objekt → …).
const MAX_RESOLVE_DEPTH: usize = 32;

pub type Dict = HashMap<String, Obj>;

#[derive(Debug, Clone, PartialEq)]
pub struct Stream {
    pub dict: Dict,
    pub raw: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Obj {
    Null,
    Bool(bool),
    Int(i64),
    Real(f64),
    Str(Vec<u8>),
    Name(String),
    Array(Vec<Obj>),
    Dict(Dict),
    Stream(Rc<Stream>),
    Ref(u32, u16),
}

impl Obj {
    pub fn as_f64(&self) -> Option<f64> {
        match self {
            Obj::Int(i) => Some(*i as f64),
            Obj::Real(r) if r.is_finite() => Some(*r),
            _ => None,
        }
    }
    pub fn as_i64(&self) -> Option<i64> {
        match self {
            Obj::Int(i) => Some(*i),
            Obj::Real(r) if r.is_finite() => Some(*r as i64),
            _ => None,
        }
    }
    pub fn as_name(&self) -> Option<&str> {
        match self {
            Obj::Name(n) => Some(n),
            _ => None,
        }
    }
    pub fn as_dict(&self) -> Option<&Dict> {
        match self {
            Obj::Dict(d) => Some(d),
            Obj::Stream(s) => Some(&s.dict),
            _ => None,
        }
    }
    pub fn as_array(&self) -> Option<&[Obj]> {
        match self {
            Obj::Array(a) => Some(a),
            _ => None,
        }
    }
}

// ── Lexer ─────────────────────────────────────────────────────────────────────

pub fn is_ws(b: u8) -> bool {
    matches!(b, 0 | 9 | 10 | 12 | 13 | 32)
}
fn is_delim(b: u8) -> bool {
    matches!(b, b'(' | b')' | b'<' | b'>' | b'[' | b']' | b'{' | b'}' | b'/' | b'%')
}

#[derive(Debug, Clone, PartialEq)]
pub enum Tok<'a> {
    /// Zahl; `true` = ganzzahlig geschrieben.
    Num(f64, bool),
    Str(Vec<u8>),
    Name(String),
    DictOpen,
    DictClose,
    ArrOpen,
    ArrClose,
    BraceOpen,
    BraceClose,
    Kw(&'a [u8]),
    Eof,
}

/// Bytes → Zeichenkette (Latin-1, verlustfrei für Namen/Schlüssel).
pub fn latin1(b: &[u8]) -> String {
    b.iter().map(|&c| c as char).collect()
}

pub struct Lexer<'a> {
    pub buf: &'a [u8],
    pub pos: usize,
}

impl<'a> Lexer<'a> {
    pub fn new(buf: &'a [u8], pos: usize) -> Self {
        Lexer { buf, pos: pos.min(buf.len()) }
    }

    fn peek(&self) -> Option<u8> {
        self.buf.get(self.pos).copied()
    }

    pub fn skip_ws(&mut self) {
        while let Some(b) = self.peek() {
            if is_ws(b) {
                self.pos += 1;
            } else if b == b'%' {
                while let Some(c) = self.peek() {
                    if c == b'\n' || c == b'\r' {
                        break;
                    }
                    self.pos += 1;
                }
            } else {
                break;
            }
        }
    }

    pub fn next_tok(&mut self) -> Tok<'a> {
        self.skip_ws();
        let Some(b) = self.peek() else { return Tok::Eof };
        match b {
            b'(' => {
                self.pos += 1;
                Tok::Str(self.literal_string())
            }
            b'<' => {
                if self.buf.get(self.pos + 1) == Some(&b'<') {
                    self.pos += 2;
                    Tok::DictOpen
                } else {
                    self.pos += 1;
                    Tok::Str(self.hex_string())
                }
            }
            b'>' => {
                if self.buf.get(self.pos + 1) == Some(&b'>') {
                    self.pos += 2;
                    Tok::DictClose
                } else {
                    self.pos += 1;
                    Tok::Kw(b">")
                }
            }
            b'[' => {
                self.pos += 1;
                Tok::ArrOpen
            }
            b']' => {
                self.pos += 1;
                Tok::ArrClose
            }
            b'{' => {
                self.pos += 1;
                Tok::BraceOpen
            }
            b'}' => {
                self.pos += 1;
                Tok::BraceClose
            }
            b')' => {
                self.pos += 1;
                Tok::Kw(b")")
            }
            b'/' => {
                self.pos += 1;
                Tok::Name(self.name())
            }
            _ => {
                let start = self.pos;
                while let Some(c) = self.peek() {
                    if is_ws(c) || is_delim(c) {
                        break;
                    }
                    self.pos += 1;
                }
                let word = &self.buf[start..self.pos];
                if word.is_empty() {
                    // Unerwartetes Zeichen: überspringen, damit es keine Endlosschleife gibt.
                    self.pos += 1;
                    return Tok::Kw(b"");
                }
                if matches!(word[0], b'0'..=b'9' | b'+' | b'-' | b'.') {
                    if let Some(v) = parse_number(word) {
                        let int = !word.contains(&b'.');
                        return Tok::Num(v, int);
                    }
                }
                Tok::Kw(word)
            }
        }
    }

    fn name(&mut self) -> String {
        let mut out = Vec::new();
        while let Some(c) = self.peek() {
            if is_ws(c) || is_delim(c) {
                break;
            }
            if c == b'#' {
                let h = self.buf.get(self.pos + 1..self.pos + 3).and_then(|s| {
                    let s = std::str::from_utf8(s).ok()?;
                    u8::from_str_radix(s, 16).ok()
                });
                if let Some(v) = h {
                    out.push(v);
                    self.pos += 3;
                    continue;
                }
            }
            out.push(c);
            self.pos += 1;
        }
        latin1(&out)
    }

    fn literal_string(&mut self) -> Vec<u8> {
        let mut out = Vec::new();
        let mut depth = 1usize;
        while let Some(c) = self.peek() {
            self.pos += 1;
            match c {
                b'(' => {
                    depth += 1;
                    out.push(c);
                }
                b')' => {
                    depth -= 1;
                    if depth == 0 {
                        break;
                    }
                    out.push(c);
                }
                b'\\' => {
                    let Some(e) = self.peek() else { break };
                    self.pos += 1;
                    match e {
                        b'n' => out.push(b'\n'),
                        b'r' => out.push(b'\r'),
                        b't' => out.push(b'\t'),
                        b'b' => out.push(8),
                        b'f' => out.push(12),
                        b'\r' => {
                            if self.peek() == Some(b'\n') {
                                self.pos += 1;
                            }
                        }
                        b'\n' => {}
                        b'0'..=b'7' => {
                            let mut v = (e - b'0') as u32;
                            for _ in 0..2 {
                                match self.peek() {
                                    Some(d @ b'0'..=b'7') => {
                                        v = v * 8 + (d - b'0') as u32;
                                        self.pos += 1;
                                    }
                                    _ => break,
                                }
                            }
                            out.push((v & 0xff) as u8);
                        }
                        other => out.push(other),
                    }
                }
                _ => out.push(c),
            }
        }
        out
    }

    fn hex_string(&mut self) -> Vec<u8> {
        let mut out = Vec::new();
        let mut hi: Option<u8> = None;
        while let Some(c) = self.peek() {
            self.pos += 1;
            if c == b'>' {
                break;
            }
            let v = match c {
                b'0'..=b'9' => c - b'0',
                b'a'..=b'f' => c - b'a' + 10,
                b'A'..=b'F' => c - b'A' + 10,
                _ => continue,
            };
            match hi.take() {
                Some(h) => out.push(h << 4 | v),
                None => hi = Some(v),
            }
        }
        if let Some(h) = hi {
            out.push(h << 4);
        }
        out
    }
}

fn parse_number(word: &[u8]) -> Option<f64> {
    let s = std::str::from_utf8(word).ok()?;
    // PDF erlaubt „--5" oder „5-" nicht offiziell, Erzeuger schreiben es trotzdem: tolerant lesen.
    let v = s.parse::<f64>().ok().or_else(|| {
        let t = s.trim_start_matches(['+', '-']);
        let neg = s.starts_with('-');
        let t: String = t.chars().take_while(|c| c.is_ascii_digit() || *c == '.').collect();
        t.parse::<f64>().ok().map(|v| if neg { -v } else { v })
    })?;
    v.is_finite().then_some(v)
}

/// Liest ein Objekt ab der aktuellen Position. `refs` = `n g R` erkennen (nicht in Content-Streams).
/// Gibt `None` bei EOF oder einem Schlüsselwort zurück, das kein Objekt ist (der Lexer steht danach).
pub fn parse_obj<'a>(lx: &mut Lexer<'a>, refs: bool) -> Option<Obj> {
    let t = lx.next_tok();
    parse_from(lx, t, refs, 0)
}

/// Wie [`parse_obj`], aber mit schon gelesenem erstem Token (für Operanden in Content-Streams).
pub fn parse_from<'a>(lx: &mut Lexer<'a>, t: Tok<'a>, refs: bool, depth: usize) -> Option<Obj> {
    if depth > MAX_NEST {
        return Some(Obj::Null);
    }
    match t {
        Tok::Num(v, int) => {
            if refs && int && v >= 0.0 {
                let save = lx.pos;
                if let Tok::Num(g, true) = lx.next_tok() {
                    if lx.next_tok() == Tok::Kw(b"R") && g >= 0.0 && v <= u32::MAX as f64 {
                        return Some(Obj::Ref(v as u32, g.min(u16::MAX as f64) as u16));
                    }
                }
                lx.pos = save;
            }
            if int && v.abs() < 9.0e15 {
                Some(Obj::Int(v as i64))
            } else {
                Some(Obj::Real(v))
            }
        }
        Tok::Str(s) => Some(Obj::Str(s)),
        Tok::Name(n) => Some(Obj::Name(n)),
        Tok::ArrOpen => {
            let mut arr = Vec::new();
            loop {
                let t = lx.next_tok();
                match t {
                    Tok::ArrClose | Tok::Eof => break,
                    Tok::Kw(k) if k == b"endobj" || k == b"stream" || k == b"endstream" => break,
                    _ => {
                        if let Some(o) = parse_from(lx, t, refs, depth + 1) {
                            arr.push(o);
                        }
                    }
                }
            }
            Some(Obj::Array(arr))
        }
        Tok::DictOpen => {
            let mut d = Dict::new();
            loop {
                let t = lx.next_tok();
                match t {
                    Tok::DictClose | Tok::Eof => break,
                    Tok::Kw(k) if k == b"endobj" || k == b"stream" || k == b"endstream" => break,
                    Tok::Name(key) => {
                        let vt = lx.next_tok();
                        if vt == Tok::DictClose {
                            break;
                        }
                        if let Some(v) = parse_from(lx, vt, refs, depth + 1) {
                            d.insert(key, v);
                        }
                    }
                    _ => {}
                }
            }
            Some(Obj::Dict(d))
        }
        Tok::Kw(b"true") => Some(Obj::Bool(true)),
        Tok::Kw(b"false") => Some(Obj::Bool(false)),
        Tok::Kw(b"null") => Some(Obj::Null),
        _ => None,
    }
}

// ── Filter ───────────────────────────────────────────────────────────────────

fn inflate(data: &[u8]) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    let r = flate2::read::ZlibDecoder::new(data).take(MAX_DECODED).read_to_end(&mut out);
    if r.is_ok() || !out.is_empty() {
        return Some(out);
    }
    // Manche Erzeuger schreiben rohes Deflate ohne zlib-Kopf.
    out.clear();
    let r = flate2::read::DeflateDecoder::new(data).take(MAX_DECODED).read_to_end(&mut out);
    (r.is_ok() || !out.is_empty()).then_some(out)
}

fn ascii_hex(data: &[u8]) -> Vec<u8> {
    let mut lx = Lexer::new(data, 0);
    lx.hex_string()
}

fn ascii85(data: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut group = [0u32; 5];
    let mut n = 0usize;
    let mut i = 0usize;
    // Optionaler Anfang „<~".
    if data.starts_with(b"<~") {
        i = 2;
    }
    while i < data.len() {
        let c = data[i];
        i += 1;
        if c == b'~' {
            break;
        }
        if is_ws(c) {
            continue;
        }
        if c == b'z' && n == 0 {
            out.extend_from_slice(&[0, 0, 0, 0]);
            continue;
        }
        if !(b'!'..=b'u').contains(&c) {
            continue;
        }
        group[n] = (c - b'!') as u32;
        n += 1;
        if n == 5 {
            let v = group.iter().fold(0u64, |a, &d| a * 85 + d as u64) as u32;
            out.extend_from_slice(&v.to_be_bytes());
            n = 0;
        }
    }
    if n > 1 {
        for g in group.iter_mut().skip(n) {
            *g = 84;
        }
        let v = group.iter().fold(0u64, |a, &d| a * 85 + d as u64) as u32;
        out.extend_from_slice(&v.to_be_bytes()[..n - 1]);
    }
    out
}

fn run_length(data: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut i = 0usize;
    while i < data.len() {
        let l = data[i] as usize;
        i += 1;
        if l == 128 {
            break;
        } else if l < 128 {
            let end = (i + l + 1).min(data.len());
            out.extend_from_slice(&data[i..end]);
            i = end;
        } else if let Some(&b) = data.get(i) {
            out.extend(std::iter::repeat(b).take(257 - l));
            i += 1;
        }
        if out.len() as u64 > MAX_DECODED {
            break;
        }
    }
    out
}

fn lzw(data: &[u8], early: bool) -> Vec<u8> {
    let mut out: Vec<u8> = Vec::new();
    let mut table: Vec<Vec<u8>> = (0..=255u16).map(|b| vec![b as u8]).collect();
    table.push(Vec::new()); // 256 Clear
    table.push(Vec::new()); // 257 EOD
    let mut width = 9u32;
    let mut prev: Option<Vec<u8>> = None;
    let (mut acc, mut bits) = (0u32, 0u32);
    for &b in data {
        acc = (acc << 8) | b as u32;
        bits += 8;
        while bits >= width {
            let code = ((acc >> (bits - width)) & ((1 << width) - 1)) as usize;
            bits -= width;
            acc &= (1u32 << bits).wrapping_sub(1);
            if code == 256 {
                table.truncate(258);
                width = 9;
                prev = None;
                continue;
            }
            if code == 257 {
                return out;
            }
            let entry = if code < table.len() {
                table[code].clone()
            } else if let Some(p) = &prev {
                let mut e = p.clone();
                e.push(p[0]);
                e
            } else {
                return out;
            };
            out.extend_from_slice(&entry);
            if let Some(p) = prev.take() {
                if !p.is_empty() && !entry.is_empty() && table.len() < 4096 {
                    let mut ne = p;
                    ne.push(entry[0]);
                    table.push(ne);
                }
            }
            prev = Some(entry);
            let next = table.len() + usize::from(early);
            width = if next >= 2048 { 12 } else if next >= 1024 { 11 } else if next >= 512 { 10 } else { 9 };
            if out.len() as u64 > MAX_DECODED {
                return out;
            }
        }
    }
    out
}

/// PNG-/TIFF-Prädiktor (DecodeParms) rückgängig machen.
fn unpredict(data: Vec<u8>, parms: Option<&Dict>) -> Vec<u8> {
    let Some(p) = parms else { return data };
    let get = |k: &str, d: i64| p.get(k).and_then(Obj::as_i64).unwrap_or(d);
    let predictor = get("Predictor", 1);
    if predictor < 2 {
        return data;
    }
    let colors = get("Colors", 1).clamp(1, 32) as usize;
    let bpc = get("BitsPerComponent", 8).clamp(1, 16) as usize;
    let columns = get("Columns", 1).clamp(1, 1 << 20) as usize;
    let bpp = (colors * bpc).div_ceil(8).max(1);
    let row = (colors * bpc * columns).div_ceil(8);
    if predictor == 2 {
        // TIFF: nur 8 Bit je Komponente.
        if bpc != 8 {
            return data;
        }
        let mut out = data;
        for r in out.chunks_mut(row.max(1)) {
            for i in bpp..r.len() {
                r[i] = r[i].wrapping_add(r[i - bpp]);
            }
        }
        return out;
    }
    let mut out = Vec::with_capacity(data.len());
    let mut prev = vec![0u8; row];
    for chunk in data.chunks(row + 1) {
        let Some((&ft, src)) = chunk.split_first() else { break };
        let mut cur = vec![0u8; row];
        for i in 0..src.len().min(row) {
            let a = if i >= bpp { cur[i - bpp] } else { 0 };
            let b = prev[i];
            let c = if i >= bpp { prev[i - bpp] } else { 0 };
            let x = src[i];
            cur[i] = match ft {
                1 => x.wrapping_add(a),
                2 => x.wrapping_add(b),
                3 => x.wrapping_add(((a as u16 + b as u16) / 2) as u8),
                4 => {
                    let pa = (b as i16 - c as i16).abs();
                    let pb = (a as i16 - c as i16).abs();
                    let pc = (a as i16 + b as i16 - 2 * c as i16).abs();
                    let pr = if pa <= pb && pa <= pc { a } else if pb <= pc { b } else { c };
                    x.wrapping_add(pr)
                }
                _ => x,
            };
        }
        out.extend_from_slice(&cur[..src.len().min(row)]);
        prev = cur;
    }
    out
}

// ── Dokument ─────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy)]
enum XEntry {
    Off(usize),
    InStm(u32, u32),
}

pub struct Doc {
    buf: Rc<Vec<u8>>,
    xref: HashMap<u32, XEntry>,
    pub trailer: Dict,
    cache: RefCell<HashMap<u32, Obj>>,
    resolving: RefCell<Vec<u32>>,
    objstm: RefCell<HashMap<u32, Rc<(Vec<u8>, Vec<(u32, usize)>)>>>,
    /// Durch Absuchen gefundene Objekt-Offsets (bei kaputtem Querverweis, lazy).
    scanned: RefCell<Option<HashMap<u32, usize>>>,
}

fn find(hay: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    if needle.is_empty() || from >= hay.len() {
        return None;
    }
    hay[from..].windows(needle.len()).position(|w| w == needle).map(|p| p + from)
}

fn rfind(hay: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.len() > hay.len() {
        return None;
    }
    hay.windows(needle.len()).rposition(|w| w == needle)
}

impl Doc {
    pub fn load(bytes: Vec<u8>) -> Result<Doc, String> {
        let head = &bytes[..bytes.len().min(1024)];
        if find(head, b"%PDF-", 0).is_none() {
            return Err("keine PDF-Datei (Kopf %PDF- fehlt)".into());
        }
        let mut doc = Doc {
            buf: Rc::new(bytes),
            xref: HashMap::new(),
            trailer: Dict::new(),
            cache: RefCell::new(HashMap::new()),
            resolving: RefCell::new(Vec::new()),
            objstm: RefCell::new(HashMap::new()),
            scanned: RefCell::new(None),
        };
        let tail_from = doc.buf.len().saturating_sub(4096);
        if let Some(p) = rfind(&doc.buf[tail_from..], b"startxref") {
            let mut lx = Lexer::new(&doc.buf, tail_from + p + 9);
            if let Tok::Num(off, true) = lx.next_tok() {
                if off >= 0.0 {
                    let mut seen = HashSet::new();
                    doc.load_xref(off as usize, &mut seen, 0);
                }
            }
        }
        if doc.xref.is_empty() || !doc.trailer.contains_key("Root") || !doc.root_ok() {
            doc.reconstruct();
        }
        if doc.trailer.contains_key("Encrypt") {
            return Err("PDF ist verschlüsselt (passwortgeschützt) — bitte ungeschützt exportieren".into());
        }
        if !doc.trailer.contains_key("Root") {
            return Err("PDF ohne Dokumentkatalog (/Root) — Datei beschädigt".into());
        }
        Ok(doc)
    }

    fn root_ok(&self) -> bool {
        let root = self.trailer.get("Root").cloned().unwrap_or(Obj::Null);
        self.resolve(&root).as_dict().is_some()
    }

    fn merge_trailer(&mut self, d: &Dict) {
        for (k, v) in d {
            if matches!(k.as_str(), "Prev" | "XRefStm" | "W" | "Index" | "Filter" | "DecodeParms" | "Length" | "Type") {
                continue;
            }
            self.trailer.entry(k.clone()).or_insert_with(|| v.clone());
        }
    }

    fn load_xref(&mut self, off: usize, seen: &mut HashSet<usize>, depth: usize) {
        if depth > 64 || off >= self.buf.len() || !seen.insert(off) {
            return;
        }
        let buf = self.buf.clone();
        let mut lx = Lexer::new(&buf, off);
        let mut next: Vec<usize> = Vec::new();
        match lx.next_tok() {
            Tok::Kw(b"xref") => loop {
                match lx.next_tok() {
                    Tok::Num(start, true) => {
                        let Tok::Num(count, true) = lx.next_tok() else { break };
                        if start < 0.0 || count < 0.0 || count > buf.len() as f64 {
                            break;
                        }
                        for k in 0..count as u32 {
                            let (Tok::Num(o, _), Tok::Num(_g, _)) = (lx.next_tok(), lx.next_tok()) else { break };
                            let kind = lx.next_tok();
                            let num = (start as u32).saturating_add(k);
                            if kind == Tok::Kw(b"n") && o > 0.0 {
                                self.xref.entry(num).or_insert(XEntry::Off(o as usize));
                            } else if kind == Tok::Kw(b"f") {
                                // Freier Eintrag: als „bekannt" merken, damit ältere Abschnitte ihn nicht überschreiben.
                                self.xref.entry(num).or_insert(XEntry::Off(usize::MAX));
                            }
                        }
                    }
                    Tok::Kw(b"trailer") => {
                        if let Some(Obj::Dict(d)) = parse_obj(&mut lx, true) {
                            if let Some(x) = d.get("XRefStm").and_then(Obj::as_i64) {
                                next.push(x.max(0) as usize);
                            }
                            if let Some(p) = d.get("Prev").and_then(Obj::as_i64) {
                                next.push(p.max(0) as usize);
                            }
                            self.merge_trailer(&d);
                        }
                        break;
                    }
                    _ => break,
                }
            },
            Tok::Num(_, true) => {
                // XRef-Stream: `n g obj << /Type /XRef … >> stream … endstream`.
                if let Some(Obj::Stream(s)) = self.parse_indirect_body(off) {
                    self.read_xref_stream(&s);
                    if let Some(p) = s.dict.get("Prev").and_then(Obj::as_i64) {
                        next.push(p.max(0) as usize);
                    }
                    self.merge_trailer(&s.dict);
                }
            }
            _ => {}
        }
        for n in next {
            self.load_xref(n, seen, depth + 1);
        }
    }

    fn read_xref_stream(&mut self, s: &Stream) {
        let Some(data) = self.decode(s) else { return };
        let w: Vec<usize> = s
            .dict
            .get("W")
            .and_then(Obj::as_array)
            .map(|a| a.iter().map(|o| o.as_i64().unwrap_or(0).clamp(0, 8) as usize).collect())
            .unwrap_or_default();
        if w.len() < 3 {
            return;
        }
        let entry_len = w[0] + w[1] + w[2];
        if entry_len == 0 {
            return;
        }
        let size = s.dict.get("Size").and_then(Obj::as_i64).unwrap_or(0).max(0);
        let index: Vec<i64> = s
            .dict
            .get("Index")
            .and_then(Obj::as_array)
            .map(|a| a.iter().filter_map(Obj::as_i64).collect())
            .unwrap_or_else(|| vec![0, size]);
        let field = |b: &[u8]| b.iter().fold(0u64, |a, &x| (a << 8) | x as u64);
        let mut p = 0usize;
        for pair in index.chunks(2) {
            let [start, count] = pair else { break };
            for k in 0..(*count).max(0) {
                let Some(e) = data.get(p..p + entry_len) else { return };
                p += entry_len;
                let t = if w[0] == 0 { 1 } else { field(&e[..w[0]]) };
                let f2 = field(&e[w[0]..w[0] + w[1]]);
                let f3 = field(&e[w[0] + w[1]..]);
                let num = (*start + k).clamp(0, u32::MAX as i64) as u32;
                match t {
                    1 => {
                        self.xref.entry(num).or_insert(XEntry::Off(f2 as usize));
                    }
                    2 => {
                        self.xref.entry(num).or_insert(XEntry::InStm(f2 as u32, f3 as u32));
                    }
                    0 => {
                        self.xref.entry(num).or_insert(XEntry::Off(usize::MAX));
                    }
                    _ => {}
                }
            }
        }
    }

    /// Sucht alle `n g obj` in der Datei (spätere Fundstellen gewinnen, wie bei Nachträgen).
    fn scan_objects(&self) -> HashMap<u32, usize> {
        let buf = &self.buf;
        let mut map = HashMap::new();
        let mut i = 0usize;
        while let Some(p) = find(buf, b"obj", i) {
            i = p + 3;
            // Nachher muss ein Trenner kommen (nicht „objstm"/„endobj"-Teil).
            if buf.get(p + 3).is_some_and(|&c| !is_ws(c) && !is_delim(c)) {
                continue;
            }
            if p >= 3 && &buf[p - 3..p] == b"end" {
                continue;
            }
            // Rückwärts: ws, Generation, ws, Nummer.
            let mut j = p;
            let skip_ws_back = |j: &mut usize| {
                while *j > 0 && is_ws(buf[*j - 1]) {
                    *j -= 1;
                }
            };
            let digits_back = |j: &mut usize| -> Option<usize> {
                let end = *j;
                while *j > 0 && buf[*j - 1].is_ascii_digit() {
                    *j -= 1;
                }
                (end > *j && end - *j <= 10).then_some(end)
            };
            skip_ws_back(&mut j);
            if j == p || digits_back(&mut j).is_none() {
                continue;
            }
            let gen_start = j;
            skip_ws_back(&mut j);
            if j == gen_start {
                continue;
            }
            let Some(num_end) = digits_back(&mut j) else { continue };
            if j > 0 && !is_ws(buf[j - 1]) && !is_delim(buf[j - 1]) {
                continue;
            }
            let num: Option<u32> = std::str::from_utf8(&buf[j..num_end]).ok().and_then(|s| s.parse().ok());
            if let Some(n) = num {
                map.insert(n, j);
            }
        }
        map
    }

    fn reconstruct(&mut self) {
        let map = self.scan_objects();
        self.xref.clear();
        for (&n, &off) in &map {
            self.xref.insert(n, XEntry::Off(off));
        }
        *self.scanned.borrow_mut() = Some(map.clone());
        self.cache.borrow_mut().clear();
        // Objekt-Streams: deren Inhalt ist beim Absuchen unsichtbar.
        let mut nums: Vec<u32> = map.keys().copied().collect();
        nums.sort_unstable();
        let mut trailer = Dict::new();
        for n in &nums {
            if let Some(Obj::Stream(s)) = self.get(*n) {
                match s.dict.get("Type").and_then(Obj::as_name) {
                    Some("ObjStm") => {
                        if let Some(stm) = self.objstm_index(*n) {
                            for (k, (num, _)) in stm.1.iter().enumerate() {
                                self.xref.entry(*num).or_insert(XEntry::InStm(*n, k as u32));
                            }
                        }
                    }
                    Some("XRef") => {
                        for (k, v) in &s.dict {
                            if matches!(k.as_str(), "Root" | "Info" | "Encrypt" | "ID") {
                                trailer.insert(k.clone(), v.clone());
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
        // Klassische Trailer (späterer gewinnt).
        let mut i = 0usize;
        while let Some(p) = find(&self.buf, b"trailer", i) {
            i = p + 7;
            let mut lx = Lexer::new(&self.buf, i);
            if let Some(Obj::Dict(d)) = parse_obj(&mut lx, true) {
                for (k, v) in d {
                    if matches!(k.as_str(), "Root" | "Info" | "Encrypt" | "ID") {
                        trailer.insert(k, v);
                    }
                }
            }
        }
        let root_valid = trailer.get("Root").is_some_and(|r| self.resolve(r).as_dict().is_some());
        if !root_valid {
            trailer.remove("Root");
            let mut cands: Vec<u32> = self.xref.keys().copied().collect();
            cands.sort_unstable();
            for n in cands {
                if let Some(Obj::Dict(d)) = self.get(n) {
                    if d.get("Type").and_then(Obj::as_name) == Some("Catalog") {
                        trailer.insert("Root".into(), Obj::Ref(n, 0));
                    }
                }
            }
        }
        if let Some(e) = self.trailer.get("Encrypt") {
            trailer.entry("Encrypt".into()).or_insert_with(|| e.clone());
        }
        self.trailer = trailer;
    }

    /// Liest `n g obj <Objekt> [stream … endstream]` ab `off`.
    fn parse_indirect_body(&self, off: usize) -> Option<Obj> {
        let mut lx = Lexer::new(&self.buf, off);
        let (Tok::Num(_, true), Tok::Num(_, true), Tok::Kw(b"obj")) = (lx.next_tok(), lx.next_tok(), lx.next_tok())
        else {
            return None;
        };
        let obj = parse_obj(&mut lx, true)?;
        let Obj::Dict(dict) = obj else { return Some(obj) };
        if lx.next_tok() != Tok::Kw(b"stream") {
            return Some(Obj::Dict(dict));
        }
        let mut start = lx.pos;
        if self.buf.get(start) == Some(&b'\r') {
            start += 1;
        }
        if self.buf.get(start) == Some(&b'\n') {
            start += 1;
        }
        let len = dict.get("Length").map(|l| self.resolve(l)).and_then(|l| l.as_i64()).unwrap_or(-1);
        let mut raw: Option<&[u8]> = None;
        if len >= 0 {
            let end = start.saturating_add(len as usize);
            if end <= self.buf.len() {
                let mut l2 = Lexer::new(&self.buf, end);
                if l2.next_tok() == Tok::Kw(b"endstream") {
                    raw = Some(&self.buf[start..end]);
                }
            }
        }
        let raw = match raw {
            Some(r) => r.to_vec(),
            None => {
                let end = find(&self.buf, b"endstream", start).unwrap_or(self.buf.len());
                let mut e = end;
                if e > start && self.buf[e - 1] == b'\n' {
                    e -= 1;
                }
                if e > start && self.buf[e - 1] == b'\r' {
                    e -= 1;
                }
                self.buf[start..e.max(start)].to_vec()
            }
        };
        Some(Obj::Stream(Rc::new(Stream { dict, raw })))
    }

    fn objstm_index(&self, stm_num: u32) -> Option<Rc<(Vec<u8>, Vec<(u32, usize)>)>> {
        if let Some(c) = self.objstm.borrow().get(&stm_num) {
            return Some(c.clone());
        }
        let Some(Obj::Stream(s)) = self.get(stm_num) else { return None };
        let data = self.decode(&s)?;
        let n = s.dict.get("N").and_then(Obj::as_i64).unwrap_or(0).clamp(0, 1_000_000) as usize;
        let first = s.dict.get("First").and_then(Obj::as_i64).unwrap_or(0).max(0) as usize;
        let mut lx = Lexer::new(&data, 0);
        let mut idx = Vec::with_capacity(n.min(65536));
        for _ in 0..n {
            let (Tok::Num(num, _), Tok::Num(o, _)) = (lx.next_tok(), lx.next_tok()) else { break };
            if num < 0.0 || o < 0.0 {
                break;
            }
            idx.push((num as u32, first.saturating_add(o as usize)));
        }
        let rc = Rc::new((data, idx));
        self.objstm.borrow_mut().insert(stm_num, rc.clone());
        Some(rc)
    }

    /// Objekt Nummer `num` (aufgelöst, aus dem Cache). `None` = unbekannt/kaputt.
    pub fn get(&self, num: u32) -> Option<Obj> {
        if let Some(o) = self.cache.borrow().get(&num) {
            return Some(o.clone());
        }
        {
            let r = self.resolving.borrow();
            if r.len() > MAX_RESOLVE_DEPTH || r.contains(&num) {
                return None;
            }
        }
        self.resolving.borrow_mut().push(num);
        let obj = self.fetch(num);
        self.resolving.borrow_mut().pop();
        if let Some(o) = &obj {
            self.cache.borrow_mut().insert(num, o.clone());
        }
        obj
    }

    fn fetch(&self, num: u32) -> Option<Obj> {
        match self.xref.get(&num).copied() {
            Some(XEntry::Off(off)) if off != usize::MAX => {
                if let Some(o) = self.parse_indirect_checked(off, num) {
                    return Some(o);
                }
                // Querverweis zeigt daneben: in der abgesuchten Datei nachsehen.
                let off2 = self.scanned_offset(num)?;
                if off2 == off {
                    return None;
                }
                self.parse_indirect_checked(off2, num)
            }
            Some(XEntry::InStm(stm, k)) => {
                let st = self.objstm_index(stm)?;
                let (data, idx) = &*st;
                let &(n, off) = idx.get(k as usize).filter(|e| e.0 == num).or_else(|| idx.iter().find(|e| e.0 == num))?;
                let _ = n;
                let mut lx = Lexer::new(data, off);
                parse_obj(&mut lx, true)
            }
            _ => None,
        }
    }

    fn parse_indirect_checked(&self, off: usize, num: u32) -> Option<Obj> {
        let mut lx = Lexer::new(&self.buf, off);
        match lx.next_tok() {
            Tok::Num(n, true) if n as u32 == num && n >= 0.0 => self.parse_indirect_body(off),
            _ => None,
        }
    }

    fn scanned_offset(&self, num: u32) -> Option<usize> {
        if self.scanned.borrow().is_none() {
            let m = self.scan_objects();
            *self.scanned.borrow_mut() = Some(m);
        }
        self.scanned.borrow().as_ref().and_then(|m| m.get(&num).copied())
    }

    /// Löst einen indirekten Verweis auf (andere Objekte unverändert).
    pub fn resolve(&self, o: &Obj) -> Obj {
        let mut cur = o.clone();
        for _ in 0..MAX_RESOLVE_DEPTH {
            match cur {
                Obj::Ref(n, _) => cur = self.get(n).unwrap_or(Obj::Null),
                other => return other,
            }
        }
        Obj::Null
    }

    /// `d[key]`, aufgelöst.
    pub fn dget(&self, d: &Dict, key: &str) -> Obj {
        d.get(key).map(|o| self.resolve(o)).unwrap_or(Obj::Null)
    }

    /// Entpackt einen Stream (alle Filter). `None` bei unbekanntem Filter (z. B. Bild-Codecs).
    pub fn decode(&self, s: &Stream) -> Option<Vec<u8>> {
        let filters: Vec<String> = match self.dget(&s.dict, "Filter") {
            Obj::Name(n) => vec![n],
            Obj::Array(a) => a.iter().map(|f| self.resolve(f)).filter_map(|f| f.as_name().map(str::to_owned)).collect(),
            _ => Vec::new(),
        };
        let parms: Vec<Option<Dict>> = match self.dget(&s.dict, "DecodeParms") {
            Obj::Dict(d) => vec![Some(d)],
            Obj::Array(a) => a.iter().map(|p| self.resolve(p).as_dict().cloned()).collect(),
            _ => Vec::new(),
        };
        let mut data = s.raw.clone();
        for (i, f) in filters.iter().enumerate() {
            let p = parms.get(i).and_then(|p| p.as_ref());
            data = match f.as_str() {
                "FlateDecode" | "Fl" => unpredict(inflate(&data)?, p),
                "LZWDecode" | "LZW" => {
                    let early = p.and_then(|p| p.get("EarlyChange")).and_then(Obj::as_i64).unwrap_or(1) != 0;
                    unpredict(lzw(&data, early), p)
                }
                "ASCIIHexDecode" | "AHx" => ascii_hex(&data),
                "ASCII85Decode" | "A85" => ascii85(&data),
                "RunLengthDecode" | "RL" => run_length(&data),
                _ => return None,
            };
        }
        Some(data)
    }

    /// Katalog-Dictionary.
    pub fn catalog(&self) -> Option<Dict> {
        self.resolve(self.trailer.get("Root")?).as_dict().cloned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lexer_tokens() {
        let src = b"<< /A 1 /B [2.5 -3 (x\\)y) <414> /N#20m] >> 12 0 R true";
        let mut lx = Lexer::new(src, 0);
        let o = parse_obj(&mut lx, true).unwrap();
        let d = o.as_dict().unwrap();
        assert_eq!(d.get("A"), Some(&Obj::Int(1)));
        let b = d.get("B").unwrap().as_array().unwrap();
        assert_eq!(b[0], Obj::Real(2.5));
        assert_eq!(b[1], Obj::Int(-3));
        assert_eq!(b[2], Obj::Str(b"x)y".to_vec()));
        assert_eq!(b[3], Obj::Str(vec![0x41, 0x40]));
        assert_eq!(b[4], Obj::Name("N m".into()));
        assert_eq!(parse_obj(&mut lx, true), Some(Obj::Ref(12, 0)));
        assert_eq!(parse_obj(&mut lx, true), Some(Obj::Bool(true)));
        assert_eq!(parse_obj(&mut lx, true), None);
    }

    #[test]
    fn ascii85_roundtrip_known() {
        // "Man " → 9jqo^
        assert_eq!(ascii85(b"9jqo^~>"), b"Man ".to_vec());
        assert_eq!(ascii85(b"<~9jqo^BlbD-BleB1DJ+*+F(f,q~>"), b"Man is distinguished".to_vec());
    }

    #[test]
    fn png_up_predictor() {
        // 2 Zeilen à 3 Byte, Filter 2 (Up).
        let enc = vec![2, 1, 2, 3, 2, 1, 1, 1];
        let mut p = Dict::new();
        p.insert("Predictor".into(), Obj::Int(12));
        p.insert("Columns".into(), Obj::Int(3));
        assert_eq!(unpredict(enc, Some(&p)), vec![1, 2, 3, 2, 3, 4]);
    }

    #[test]
    fn lzw_spec_example() {
        // Beispiel aus der PDF-Referenz: 45 45 45 45 45 65 45 45 45 66.
        let enc = [0x80, 0x0B, 0x60, 0x50, 0x22, 0x0C, 0x0C, 0x85, 0x01];
        assert_eq!(lzw(&enc, true), vec![45, 45, 45, 45, 45, 65, 45, 45, 45, 66]);
    }

    #[test]
    fn not_a_pdf() {
        assert!(Doc::load(b"hello".to_vec()).is_err());
        assert!(Doc::load(Vec::new()).is_err());
        assert!(Doc::load(b"%PDF-1.4\n".to_vec()).is_err());
    }
}
