// STEP-Klartext-Leser (ISO 10303-21) für IFC ([B3]): zerlegt eine `.ifc`-Datei in Instanzen
// `#id = TYP(argumente);`. Kennt keine Schemata (IFC2x3, IFC4, IFC4.3 laufen gleich durch);
// die Bedeutung der Argumente liest `ifc_import.rs`.
//
// Eigener Code (nichts aus BIMCraft `step.rs` übernommen).
//
// Robustheit: kaputte Instanzen werden übersprungen und gezählt (Lesen geht beim nächsten `;`
// weiter), Verschachtelung und Dateigrösse sind begrenzt, nie Panic.
//
// Zeichenketten nach ISO 10303-21 §6.4.3: `''` → `'`, `\\` → `\`, `\S\c` (ISO 8859 obere Hälfte),
// `\X\hh` (ISO 8859-1), `\X2\hhhh…\X0\` (UTF-16), `\X4\hhhhhhhh…\X0\` (UTF-32), `\P?\` (Codeseite,
// ignoriert). Rohe Nicht-ASCII-Bytes (in der Praxis UTF-8 oder Latin-1) werden toleriert.

use std::collections::HashMap;

/// Obergrenze der Dateigrösse (Bytes) — darüber wird gar nicht erst gelesen.
pub const MAX_FILE_BYTES: usize = 400 * 1024 * 1024;
/// Obergrenze der Instanzen.
pub const MAX_ENTITIES: usize = 20_000_000;
/// Obergrenze der Listen-Verschachtelung (schützt den Stack).
const MAX_DEPTH: usize = 64;

/// Ein Argument einer Instanz.
#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    /// `$` — nicht gesetzt.
    Null,
    /// `*` — abgeleitet (redeklariert).
    Derived,
    Int(i64),
    Real(f64),
    Str(String),
    /// `.ENUM.` (ohne Punkte, gross).
    Enum(String),
    /// `#123`
    Ref(u64),
    /// `"…"` (Binärwert, Inhalt unbeachtet).
    Binary,
    List(Vec<Value>),
    /// Typisierter Wert `IFCLABEL('x')`, `IFCLENGTHMEASURE(1.)`.
    Typed(String, Vec<Value>),
}

impl Value {
    pub fn as_ref_id(&self) -> Option<u64> {
        match self {
            Value::Ref(r) => Some(*r),
            _ => None,
        }
    }
    /// Zahl (auch ganzzahlig oder typisiert wie `IFCREAL(1.)`); nur endliche Werte.
    pub fn as_f64(&self) -> Option<f64> {
        let v = match self {
            Value::Real(r) => *r,
            Value::Int(i) => *i as f64,
            Value::Typed(_, a) if a.len() == 1 => return a[0].as_f64(),
            _ => return None,
        };
        v.is_finite().then_some(v)
    }
    pub fn as_i64(&self) -> Option<i64> {
        match self {
            Value::Int(i) => Some(*i),
            Value::Typed(_, a) if a.len() == 1 => a[0].as_i64(),
            _ => None,
        }
    }
    pub fn as_str(&self) -> Option<&str> {
        match self {
            Value::Str(s) => Some(s),
            Value::Typed(_, a) if a.len() == 1 => a[0].as_str(),
            _ => None,
        }
    }
    pub fn as_enum(&self) -> Option<&str> {
        match self {
            Value::Enum(s) => Some(s),
            _ => None,
        }
    }
    pub fn as_list(&self) -> Option<&[Value]> {
        match self {
            Value::List(l) => Some(l),
            _ => None,
        }
    }
    pub fn is_null(&self) -> bool {
        matches!(self, Value::Null | Value::Derived)
    }
}

/// Eine Instanz `#id = TYP(args)`; komplexe Instanzen `#id = (A(..) B(..))` tragen den Typ
/// `""` und je Teil ein `Value::Typed` in `args`.
#[derive(Debug, Clone)]
pub struct Entity {
    pub ty: String,
    pub args: Vec<Value>,
}

impl Entity {
    pub fn arg(&self, i: usize) -> Option<&Value> {
        self.args.get(i)
    }
}

/// Inhalt einer STEP-Datei.
#[derive(Debug, Default)]
pub struct StepFile {
    /// Erstes Schema aus `FILE_SCHEMA` (gross, z. B. `IFC2X3`, `IFC4`, `IFC4X3_ADD2`).
    pub schema: String,
    pub entities: HashMap<u64, Entity>,
    /// Übersprungene, unlesbare Anweisungen.
    pub errors: usize,
}

impl StepFile {
    pub fn get(&self, id: u64) -> Option<&Entity> {
        self.entities.get(&id)
    }
}

struct Lexer<'a> {
    b: &'a [u8],
    i: usize,
}

impl<'a> Lexer<'a> {
    fn peek(&self) -> Option<u8> {
        self.b.get(self.i).copied()
    }

    /// Überspringt Leerraum und `/* … */`-Kommentare.
    fn ws(&mut self) {
        loop {
            while let Some(c) = self.peek() {
                if c.is_ascii_whitespace() {
                    self.i += 1;
                } else {
                    break;
                }
            }
            if self.b.get(self.i) == Some(&b'/') && self.b.get(self.i + 1) == Some(&b'*') {
                match find(self.b, self.i + 2, b"*/") {
                    Some(end) => self.i = end + 2,
                    None => self.i = self.b.len(),
                }
            } else {
                return;
            }
        }
    }

    fn eat(&mut self, c: u8) -> bool {
        self.ws();
        if self.peek() == Some(c) {
            self.i += 1;
            true
        } else {
            false
        }
    }

    /// Schlüsselwort (`IFCWALL`, `FILE_SCHEMA`, `END-ISO-10303-21`), gross gemacht.
    fn keyword(&mut self) -> Option<String> {
        self.ws();
        let start = self.i;
        while let Some(c) = self.peek() {
            if c.is_ascii_alphanumeric() || c == b'_' || c == b'-' {
                self.i += 1;
            } else {
                break;
            }
        }
        if self.i == start {
            return None;
        }
        Some(String::from_utf8_lossy(&self.b[start..self.i]).to_ascii_uppercase())
    }

    fn integer(&mut self) -> Option<u64> {
        let start = self.i;
        while let Some(c) = self.peek() {
            if c.is_ascii_digit() {
                self.i += 1;
            } else {
                break;
            }
        }
        std::str::from_utf8(&self.b[start..self.i]).ok()?.parse().ok()
    }

    /// Springt hinter das nächste `;` ausserhalb von Zeichenketten (Fehlererholung).
    fn skip_statement(&mut self) {
        while let Some(c) = self.peek() {
            self.i += 1;
            match c {
                b';' => return,
                b'\'' => {
                    // Zeichenkette bis zum schliessenden Hochkomma (`''` = Hochkomma).
                    while let Some(d) = self.peek() {
                        self.i += 1;
                        if d == b'\'' {
                            if self.peek() == Some(b'\'') {
                                self.i += 1;
                            } else {
                                break;
                            }
                        }
                    }
                }
                b'/' if self.peek() == Some(b'*') => {
                    self.i = find(self.b, self.i + 1, b"*/").map_or(self.b.len(), |e| e + 2);
                }
                _ => {}
            }
        }
    }

    /// Argumentliste nach der öffnenden Klammer bis zur schliessenden.
    fn args(&mut self, depth: usize) -> Option<Vec<Value>> {
        if depth > MAX_DEPTH {
            return None;
        }
        let mut out = Vec::new();
        if self.eat(b')') {
            return Some(out);
        }
        loop {
            out.push(self.value(depth)?);
            if self.eat(b',') {
                continue;
            }
            if self.eat(b')') {
                return Some(out);
            }
            return None;
        }
    }

    fn value(&mut self, depth: usize) -> Option<Value> {
        self.ws();
        let c = self.peek()?;
        match c {
            b'$' => {
                self.i += 1;
                Some(Value::Null)
            }
            b'*' => {
                self.i += 1;
                Some(Value::Derived)
            }
            b'#' => {
                self.i += 1;
                self.integer().map(Value::Ref)
            }
            b'\'' => self.string().map(Value::Str),
            b'"' => {
                self.i += 1;
                let end = self.b[self.i..].iter().position(|&d| d == b'"')?;
                self.i += end + 1;
                Some(Value::Binary)
            }
            b'.' if self.b.get(self.i + 1).is_some_and(|d| d.is_ascii_alphabetic() || *d == b'_') => {
                self.i += 1;
                let start = self.i;
                while let Some(d) = self.peek() {
                    if d == b'.' {
                        break;
                    }
                    if !(d.is_ascii_alphanumeric() || d == b'_') {
                        return None;
                    }
                    self.i += 1;
                }
                let s = String::from_utf8_lossy(&self.b[start..self.i]).to_ascii_uppercase();
                self.i += 1; // schliessender Punkt
                Some(Value::Enum(s))
            }
            b'(' => {
                self.i += 1;
                self.args(depth + 1).map(Value::List)
            }
            b'+' | b'-' | b'.' | b'0'..=b'9' => self.number(),
            c if c.is_ascii_alphabetic() => {
                let name = self.keyword()?;
                if !self.eat(b'(') {
                    return None;
                }
                let a = self.args(depth + 1)?;
                Some(Value::Typed(name, a))
            }
            _ => None,
        }
    }

    fn number(&mut self) -> Option<Value> {
        let start = self.i;
        let mut real = false;
        while let Some(c) = self.peek() {
            match c {
                b'0'..=b'9' | b'+' | b'-' => {}
                b'.' | b'E' | b'e' => real = true,
                _ => break,
            }
            self.i += 1;
        }
        let s = std::str::from_utf8(&self.b[start..self.i]).ok()?;
        if !real {
            if let Ok(i) = s.parse::<i64>() {
                return Some(Value::Int(i));
            }
        }
        // `1.` und `1.E-5` sind gültiges STEP; Rust liest beides, zur Sicherheit „1.0“-Form.
        let fixed;
        let t = if let Some(p) = s.find('.') {
            let after = s.as_bytes().get(p + 1);
            if after.is_none_or(|c| !c.is_ascii_digit()) {
                fixed = format!("{}0{}", &s[..=p], &s[p + 1..]);
                &fixed
            } else {
                s
            }
        } else {
            s
        };
        let v: f64 = t.parse().ok()?;
        Some(Value::Real(v))
    }

    /// Zeichenkette ab dem öffnenden Hochkomma, dekodiert.
    fn string(&mut self) -> Option<String> {
        self.i += 1;
        let mut raw: Vec<u8> = Vec::new();
        loop {
            let c = self.peek()?;
            self.i += 1;
            if c == b'\'' {
                if self.peek() == Some(b'\'') {
                    self.i += 1;
                    raw.push(b'\'');
                } else {
                    break;
                }
            } else {
                raw.push(c);
            }
        }
        Some(decode_string(&raw))
    }
}

fn find(hay: &[u8], from: usize, needle: &[u8]) -> Option<usize> {
    if from >= hay.len() {
        return None;
    }
    hay[from..].windows(needle.len()).position(|w| w == needle).map(|p| p + from)
}

fn hex_val(c: u8) -> Option<u32> {
    (c as char).to_digit(16)
}

/// Dekodiert die Steuersequenzen einer STEP-Zeichenkette (Inhalt ohne Hochkommas, `''` bereits
/// aufgelöst).
pub fn decode_string(raw: &[u8]) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut i = 0;
    // Rohe Nicht-ASCII-Bytes: als UTF-8 lesen, wenn gültig, sonst Latin-1.
    let push_raw = |out: &mut String, bytes: &[u8]| match std::str::from_utf8(bytes) {
        Ok(s) => out.push_str(s),
        Err(_) => out.extend(bytes.iter().map(|&b| b as char)),
    };
    let mut plain_start = 0;
    while i < raw.len() {
        if raw[i] != b'\\' {
            i += 1;
            continue;
        }
        push_raw(&mut out, &raw[plain_start..i]);
        let rest = &raw[i..];
        if rest.starts_with(b"\\\\") {
            out.push('\\');
            i += 2;
        } else if rest.starts_with(b"\\S\\") && rest.len() >= 4 {
            out.push(char::from_u32(rest[3] as u32 + 128).unwrap_or('?'));
            i += 4;
        } else if rest.starts_with(b"\\P") && rest.len() >= 4 && rest[3] == b'\\' {
            i += 4;
        } else if rest.starts_with(b"\\X\\") && rest.len() >= 5 {
            match (hex_val(rest[3]), hex_val(rest[4])) {
                (Some(h), Some(l)) => out.push(char::from_u32(h * 16 + l).unwrap_or('?')),
                _ => out.push('?'),
            }
            i += 5;
        } else if rest.starts_with(b"\\X2\\") || rest.starts_with(b"\\X4\\") {
            let width = if rest[2] == b'2' { 4 } else { 8 };
            let body_start = i + 4;
            let end = find(raw, body_start, b"\\X0\\").unwrap_or(raw.len());
            let body = &raw[body_start..end];
            let mut units: Vec<u32> = Vec::new();
            for chunk in body.chunks(width) {
                if chunk.len() < width {
                    break;
                }
                let mut v = 0u32;
                let mut ok = true;
                for &c in chunk {
                    match hex_val(c) {
                        Some(h) => v = v.wrapping_mul(16).wrapping_add(h),
                        None => ok = false,
                    }
                }
                if ok {
                    units.push(v);
                }
            }
            if width == 4 {
                let u16s: Vec<u16> = units.iter().map(|&u| u as u16).collect();
                out.push_str(&String::from_utf16_lossy(&u16s));
            } else {
                out.extend(units.iter().map(|&u| char::from_u32(u).unwrap_or('\u{FFFD}')));
            }
            i = (end + 4).min(raw.len());
        } else {
            // Unbekannte Sequenz: Backslash wörtlich behalten.
            out.push('\\');
            i += 1;
        }
        plain_start = i;
    }
    push_raw(&mut out, &raw[plain_start.min(raw.len())..]);
    out
}

/// Liest eine STEP-Datei. Fehler nur bei grundsätzlich unbrauchbarer Eingabe (zu gross, kein
/// STEP); einzelne kaputte Instanzen zählen in `errors`.
pub fn parse(bytes: &[u8]) -> Result<StepFile, String> {
    if bytes.len() > MAX_FILE_BYTES {
        return Err(format!("Datei zu gross ({} MB, höchstens {} MB)", bytes.len() >> 20, MAX_FILE_BYTES >> 20));
    }
    let head = &bytes[..bytes.len().min(4096)];
    if find(head, 0, b"ISO-10303-21").is_none() {
        return Err("keine STEP-Datei (ISO-10303-21 fehlt)".into());
    }
    let mut lx = Lexer { b: bytes, i: 0 };
    let mut file = StepFile::default();
    loop {
        lx.ws();
        let Some(c) = lx.peek() else { break };
        if c == b'#' {
            lx.i += 1;
            let start = lx.i;
            let parsed = (|| {
                let id = lx.integer()?;
                if !lx.eat(b'=') {
                    return None;
                }
                lx.ws();
                let ent = if lx.peek() == Some(b'(') {
                    // Komplexe Instanz: Folge von TYP(args) in Klammern.
                    lx.i += 1;
                    let mut parts = Vec::new();
                    loop {
                        if lx.eat(b')') {
                            break;
                        }
                        let name = lx.keyword()?;
                        if !lx.eat(b'(') {
                            return None;
                        }
                        parts.push(Value::Typed(name, lx.args(1)?));
                    }
                    Entity { ty: String::new(), args: parts }
                } else {
                    let ty = lx.keyword()?;
                    if !lx.eat(b'(') {
                        return None;
                    }
                    Entity { ty, args: lx.args(1)? }
                };
                if !lx.eat(b';') {
                    return None;
                }
                Some((id, ent))
            })();
            match parsed {
                Some((id, ent)) => {
                    if file.entities.len() >= MAX_ENTITIES {
                        return Err(format!("zu viele Instanzen (höchstens {MAX_ENTITIES})"));
                    }
                    file.entities.insert(id, ent);
                }
                None => {
                    file.errors += 1;
                    lx.i = start;
                    lx.skip_statement();
                }
            }
            continue;
        }
        // Kopf- und Abschnitts-Anweisungen.
        let Some(kw) = lx.keyword() else {
            lx.i += 1;
            file.errors += 1;
            lx.skip_statement();
            continue;
        };
        match kw.as_str() {
            "END-ISO-10303-21" => break,
            "FILE_SCHEMA" => {
                if lx.eat(b'(') {
                    if let Some(a) = lx.args(1) {
                        if let Some(Value::List(l)) = a.first() {
                            if let Some(s) = l.first().and_then(|v| v.as_str()) {
                                file.schema = s.trim().to_ascii_uppercase();
                            }
                        }
                    }
                }
                lx.skip_statement();
            }
            _ => lx.skip_statement(),
        }
    }
    Ok(file)
}

#[cfg(test)]
mod tests {
    use super::*;

    const MINI: &str = "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');\n\
FILE_NAME('a.ifc','2024-01-01T00:00:00',(''),(''),'x','y','');\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n\
#1=IFCCARTESIANPOINT((0.,1.5,-2.E-1));\n/* Kommentar; mit Semikolon */\n\
#2 = IFCWALL('2O2Fr$t4X7Zf8NOew3FLOH',$,'K\\X2\\00FC\\X0\\che',*,.T.,#1,(#1,#3),IFCLABEL('it''s'));\n\
#3=IFCDIRECTION((1,0,0));\n#4=(IFCA(1)IFCB('x'));\nENDSEC;\nEND-ISO-10303-21;\n";

    #[test]
    fn parses_header_and_instances() {
        let f = parse(MINI.as_bytes()).unwrap();
        assert_eq!(f.schema, "IFC4");
        assert_eq!(f.errors, 0);
        let p = f.get(1).unwrap();
        assert_eq!(p.ty, "IFCCARTESIANPOINT");
        let c: Vec<f64> = p.args[0].as_list().unwrap().iter().map(|v| v.as_f64().unwrap()).collect();
        assert_eq!(c, vec![0.0, 1.5, -0.2]);
        let w = f.get(2).unwrap();
        assert_eq!(w.ty, "IFCWALL");
        assert_eq!(w.args[2].as_str(), Some("Küche"));
        assert_eq!(w.args[3], Value::Derived);
        assert_eq!(w.args[4], Value::Enum("T".into()));
        assert_eq!(w.args[5], Value::Ref(1));
        assert_eq!(w.args[7].as_str(), Some("it's"));
        assert_eq!(f.get(3).unwrap().args[0].as_list().unwrap()[0], Value::Int(1));
        let cx = f.get(4).unwrap();
        assert_eq!(cx.ty, "");
        assert_eq!(cx.args.len(), 2);
    }

    #[test]
    fn decodes_escapes() {
        assert_eq!(decode_string(b"\\X2\\00E400F6\\X0\\"), "äö");
        assert_eq!(decode_string(b"\\X4\\0001F600\\X0\\x"), "😀x");
        assert_eq!(decode_string(b"a\\\\b"), "a\\b");
        assert_eq!(decode_string(b"\\S\\d"), "ä"); // 'd' = 0x64, +128 = 0xE4
        assert_eq!(decode_string(b"\\X\\E9t\\X\\E9"), "été");
        assert_eq!(decode_string(b"\\PA\\Z"), "Z");
        assert_eq!(decode_string("Grüezi".as_bytes()), "Grüezi");
        assert_eq!(decode_string(&[0x47, 0xFC]), "Gü"); // Latin-1 roh
        // Kaputt: nie Panic.
        assert_eq!(decode_string(b"\\X2\\00E"), "");
        let _ = decode_string(b"\\X\\Z");
        let _ = decode_string(b"\\");
    }

    #[test]
    fn recovers_from_broken_instances() {
        let s = "ISO-10303-21;\nDATA;\n#1=IFCFOO(1,,2);\n#2=IFCBAR('a;b');\n#3=IFCBAZ((1,2);\n#4=IFCOK(.X.);\nENDSEC;\n";
        let f = parse(s.as_bytes()).unwrap();
        assert!(f.get(1).is_none());
        assert_eq!(f.get(2).unwrap().args[0].as_str(), Some("a;b"));
        assert!(f.get(4).is_some());
        assert!(f.errors >= 2);
    }

    #[test]
    fn rejects_nonsense_without_panic() {
        assert!(parse(b"").is_err());
        assert!(parse(b"hello world").is_err());
        for s in [
            "ISO-10303-21;#",
            "ISO-10303-21;#1=",
            "ISO-10303-21;#1=X(",
            "ISO-10303-21;#1=X('unterminated",
            "ISO-10303-21;#1=X(\"bin",
            "ISO-10303-21;#1=X(.E",
            "ISO-10303-21;/* offen",
            "ISO-10303-21;#99999999999999999999999=X();",
            "ISO-10303-21;#1=X(-);#2=X(1.2.3E);#3=X(+.E);",
        ] {
            let _ = parse(s.as_bytes());
        }
        // Tiefe Verschachtelung: Abbruch statt Stack-Überlauf.
        let deep = format!("ISO-10303-21;#1=X({}{});", "(".repeat(10_000), ")".repeat(10_000));
        let f = parse(deep.as_bytes()).unwrap();
        assert!(f.get(1).is_none());
        // Zufallsbytes.
        let mut x: u32 = 12345;
        let mut buf = b"ISO-10303-21;DATA;".to_vec();
        for _ in 0..20_000 {
            x = x.wrapping_mul(1103515245).wrapping_add(12345);
            let alphabet = b"#=(),;'$*.ABC0123456789\\X2 \n/*";
            buf.push(alphabet[(x >> 16) as usize % alphabet.len()]);
        }
        let _ = parse(&buf);
    }
}
