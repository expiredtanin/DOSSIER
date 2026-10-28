//! TS-Typen aus dem Rust-Modell ([K4] S4): Das Rust-Modell (`generated.rs`, `manual.rs`) ist die
//! Quelle der Projekt-Datentypen; `src/model/types.generated.ts` wird daraus erzeugt (ts-rs) und von
//! `src/model/types.ts` re-exportiert.
//!
//! - `npm run gen:types` schreibt die Datei neu (`DOSSIER_GEN_TYPES=1 cargo test … ts_types`).
//! - Ohne die Variable prüft der Test nur und schlägt fehl, wenn die Datei veraltet ist
//!   (läuft in `npm run check` mit `cargo test` des Kerns) — Schutz gegen Doppelpflege.
//!
//! Regeln für Modell-Felder (ts-rs-Attribute neben serde):
//! - optional in TS (`feld?: T`) ⇔ `Option<T>` mit `skip_serializing_if = "Option::is_none"` UND
//!   `#[ts(optional)]`; `T | null` ohne `?` ⇔ `Option<T>` ohne `skip_serializing_if`.
//! - Hilfstypen ohne eigenen TS-Namen (z. B. `LineStyleKind`) werden mit `#[ts(inline)]` eingesetzt.
//! - Wo Rust gröber ist als TS (Literal-Typen wie `type: "wall"`, `version: 1`, offene Unions als
//!   `serde_json::Value`), gibt `#[ts(type = "…")]` den genauen TS-Typ an.
//! - `extra: Extra` (Verlustfreiheit) und `Unknown`-Varianten (`serde(other)`) tragen `#[ts(skip)]`.
//! - `///`-Doku wird zu JSDoc.
//!
//! Getaggte Newtype-Varianten (`#[serde(tag = "type")] Grid(GridRule)`) erzeugt ts-rs als
//! `{ "type": "grid" } & GridRule`; hier wird daraus `GridRule | …`, und `GridRule` bekommt das
//! Feld `type: "grid"` — so wie die Struktur im JSON steht.

use super::*;
use std::any::TypeId;
use std::collections::{BTreeMap, HashSet};
use ts_rs::{Config, TypeVisitor, TS};

/// Pfad der erzeugten Datei, relativ zum Crate (`src-tauri/core`).
const OUT: &str = "../../src/model/types.generated.ts";

const HEADER: &str = "// GENERIERT aus dem Rust-Modell (src-tauri/core/src/model/) über ts-rs — NICHT von Hand ändern.
// Neue Modellfelder nur im Rust-Modell eintragen, dann `npm run gen:types` ([K4] S4).
// `npm run check` (cargo test im Kern) schlägt fehl, wenn diese Datei veraltet ist.
/* eslint-disable */
";

/// Ein deklarierbarer Typ: Name, Doku, Deklaration (`type X = …;`).
struct Decl {
    docs: Option<String>,
    decl: String,
}

struct Collect<'a> {
    cfg: &'a Config,
    seen: HashSet<TypeId>,
    out: BTreeMap<String, Decl>,
}

impl TypeVisitor for Collect<'_> {
    fn visit<T: TS + 'static + ?Sized>(&mut self) {
        if T::output_path().is_none() || !self.seen.insert(TypeId::of::<T>()) {
            return;
        }
        self.out.insert(T::ident(self.cfg), Decl { docs: T::docs(), decl: T::decl(self.cfg) });
        T::visit_dependencies(self);
    }
}

/// Alle Typen, die vom Projekt aus erreichbar sind (+ weitere Wurzeln, die TS einzeln braucht).
fn collect(cfg: &Config) -> BTreeMap<String, Decl> {
    let mut c = Collect { cfg, seen: HashSet::new(), out: BTreeMap::new() };
    c.visit::<Project>();
    c.out
}

/// `{ "type": "grid" } & GridRule` → `GridRule`, Tag-Feld in `GridRule` einsetzen.
fn resolve_tagged_newtypes(decls: &mut BTreeMap<String, Decl>) {
    let mut inject: Vec<(String, String, String)> = vec![];
    for d in decls.values_mut() {
        let mut s = d.decl.clone();
        while let Some(i) = s.find("{ \"") {
            // Muster: { "key": "val" } & Name
            let rest = &s[i + 3..];
            let Some(k_end) = rest.find('"') else { break };
            let key = &rest[..k_end];
            let rest2 = &rest[k_end..];
            let Some(r3) = rest2.strip_prefix("\": \"") else { break };
            let Some(v_end) = r3.find('"') else { break };
            let val = &r3[..v_end];
            let Some(r4) = r3[v_end..].strip_prefix("\" } & ") else { break };
            let name_len = r4.find(|c: char| !(c.is_alphanumeric() || c == '_')).unwrap_or(r4.len());
            let name = r4[..name_len].to_string();
            if name.is_empty() {
                break;
            }
            inject.push((name.clone(), key.to_string(), val.to_string()));
            let end = s.len() - r4.len() + name_len;
            s.replace_range(i..end, &name);
        }
        d.decl = s;
    }
    for (name, key, val) in inject {
        let d = decls.get_mut(&name).unwrap_or_else(|| panic!("getaggter Typ {name} fehlt"));
        let at = d.decl.find("= {").unwrap_or_else(|| panic!("{name} ist kein Objekt-Typ")) + 3;
        d.decl.insert_str(at, &format!(" {key}: {val:?},"));
    }
}

// ── Formatierer für die einzeilige ts-rs-Ausgabe ─────────────────────────────

#[derive(Debug, Clone)]
enum Tok {
    Text(String),
    Str(String),
    Comment(String),
    Comma,
    Pipe,
    Group(char, Vec<Tok>, char),
}

fn lex(s: &str) -> Vec<Tok> {
    fn group(chars: &[char], i: &mut usize, close: Option<char>) -> Vec<Tok> {
        let mut out = vec![];
        let mut text = String::new();
        let flush = |text: &mut String, out: &mut Vec<Tok>| {
            if !text.is_empty() {
                out.push(Tok::Text(std::mem::take(text)));
            }
        };
        while *i < chars.len() {
            let c = chars[*i];
            if Some(c) == close {
                *i += 1;
                flush(&mut text, &mut out);
                return out;
            }
            match c {
                '"' => {
                    flush(&mut text, &mut out);
                    let start = *i;
                    *i += 1;
                    while *i < chars.len() && chars[*i] != '"' {
                        if chars[*i] == '\\' {
                            *i += 1;
                        }
                        *i += 1;
                    }
                    *i += 1;
                    out.push(Tok::Str(chars[start..*i].iter().collect()));
                }
                '/' if chars.get(*i + 1) == Some(&'*') => {
                    flush(&mut text, &mut out);
                    let start = *i;
                    *i += 2;
                    while *i + 1 < chars.len() && !(chars[*i] == '*' && chars[*i + 1] == '/') {
                        *i += 1;
                    }
                    *i += 2;
                    out.push(Tok::Comment(chars[start..*i].iter().collect()));
                }
                '{' | '[' | '(' | '<' => {
                    flush(&mut text, &mut out);
                    let cl = match c {
                        '{' => '}',
                        '[' => ']',
                        '(' => ')',
                        _ => '>',
                    };
                    *i += 1;
                    let inner = group(chars, i, Some(cl));
                    out.push(Tok::Group(c, inner, cl));
                }
                ',' => {
                    flush(&mut text, &mut out);
                    out.push(Tok::Comma);
                    *i += 1;
                }
                '|' => {
                    flush(&mut text, &mut out);
                    out.push(Tok::Pipe);
                    *i += 1;
                }
                _ => {
                    text.push(c);
                    *i += 1;
                }
            }
        }
        flush(&mut text, &mut out);
        out
    }
    let chars: Vec<char> = s.chars().collect();
    let mut i = 0;
    group(&chars, &mut i, None)
}

const WIDTH: usize = 100;

fn pad(n: usize) -> String {
    " ".repeat(n)
}

fn comment(c: &str, ind: usize) -> String {
    let lines: Vec<&str> = c.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    // Einzeiler kompakt: /** Text */
    if let [first, mid, last] = lines[..] {
        if first == "/**" && last == "*/" && mid.starts_with("* ") && mid.len() + ind + 4 <= WIDTH {
            return format!("{}/** {} */\n", pad(ind), &mid[2..]);
        }
    }
    let mut out = String::new();
    for line in c.lines() {
        let t = line.trim();
        if t.is_empty() {
            continue;
        }
        out.push_str(&pad(ind));
        if t.starts_with('*') {
            out.push(' ');
        }
        out.push_str(t);
        out.push('\n');
    }
    out
}

/// Einzelne Folge (ohne Kommentare) zusammenhängend ausgeben.
fn seq(toks: &[Tok], ind: usize) -> String {
    let mut s = String::new();
    for t in toks {
        match t {
            Tok::Text(x) => {
                let x = x.split_whitespace().collect::<Vec<_>>().join(" ");
                if !x.is_empty() {
                    if !s.is_empty() && !s.ends_with(' ') && !x.starts_with(':') && !x.starts_with('?') && !s.ends_with('[') {
                        s.push(' ');
                    }
                    s.push_str(&x);
                }
            }
            Tok::Str(x) => {
                if !s.is_empty() && !s.ends_with(' ') && !s.ends_with('<') && !s.ends_with('[') && !s.ends_with('(') {
                    s.push(' ');
                }
                s.push_str(x);
            }
            Tok::Comment(_) => {}
            Tok::Comma => s.push_str(", "),
            Tok::Pipe => {
                let t = s.trim_end().len();
                s.truncate(t);
                s.push_str(" | ");
            }
            Tok::Group(o, inner, c) => {
                if !s.is_empty() && !s.ends_with(' ') && *o == '{' {
                    s.push(' ');
                }
                s.push_str(&group(*o, inner, *c, ind));
            }
        }
    }
    s.trim().to_string()
}

/// `"shape": "line"` → `shape: "line"` (Tag-Schlüssel, die ts-rs in Anführungszeichen setzt).
fn unquote_key(member: String) -> String {
    if let Some(rest) = member.strip_prefix('"') {
        if let Some((key, tail)) = rest.split_once('"') {
            if tail.starts_with(':') && !key.is_empty() && key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
                return format!("{key}{tail}");
            }
        }
    }
    member
}

fn group(o: char, inner: &[Tok], c: char, ind: usize) -> String {
    if o != '{' {
        let body = seq(inner, ind);
        return format!("{o}{}{c}", body.trim_end_matches(", ").trim_end_matches(','));
    }
    // Objekt: Glieder an den Kommas trennen
    let mut members: Vec<(Vec<String>, Vec<Tok>)> = vec![(vec![], vec![])];
    for t in inner {
        match t {
            Tok::Comma => members.push((vec![], vec![])),
            Tok::Comment(x) => members.last_mut().unwrap().0.push(x.clone()),
            other => members.last_mut().unwrap().1.push(other.clone()),
        }
    }
    let members: Vec<(Vec<String>, String)> = members
        .into_iter()
        .map(|(cs, toks)| (cs, unquote_key(seq(&toks, ind + 2))))
        .filter(|(_, b)| !b.is_empty())
        .collect();
    if members.is_empty() {
        return "{}".into();
    }
    let one = format!("{{ {} }}", members.iter().map(|(_, b)| b.as_str()).collect::<Vec<_>>().join("; "));
    let multi = members.iter().any(|(cs, b)| !cs.is_empty() || b.contains('\n'));
    if !multi && one.len() + ind <= WIDTH {
        return one;
    }
    let mut s = String::from("{\n");
    for (cs, b) in &members {
        for x in cs {
            s.push_str(&comment(x, ind + 2));
        }
        s.push_str(&pad(ind + 2));
        s.push_str(b);
        s.push_str(";\n");
    }
    s.push_str(&pad(ind));
    s.push('}');
    s
}

/// `type X = …;` → formatiert, mit `export`.
fn format_decl(decl: &str) -> String {
    let decl = decl.trim().trim_end_matches(';');
    let (head, body) = decl.split_once(" = ").expect("ts-rs-Deklaration");
    let toks = lex(body);
    // Union auf oberster Ebene: Glieder einzeln
    let mut alts: Vec<Vec<Tok>> = vec![vec![]];
    for t in toks {
        match t {
            Tok::Pipe => alts.push(vec![]),
            other => alts.last_mut().unwrap().push(other),
        }
    }
    let alts: Vec<(Vec<String>, String)> = alts
        .iter()
        .filter(|a| !a.is_empty())
        .map(|a| {
            let cs = a.iter().filter_map(|t| if let Tok::Comment(c) = t { Some(c.clone()) } else { None }).collect();
            (cs, seq(a, 2))
        })
        .collect();
    let one = alts.iter().map(|(_, b)| b.as_str()).collect::<Vec<_>>().join(" | ");
    let multi = alts.len() > 1 && (alts.iter().any(|(cs, b)| !cs.is_empty() || b.contains('\n')) || one.len() + head.len() > WIDTH);
    let mut s = format!("export {head} =");
    if !multi {
        let one = if alts.len() == 1 { seq(&lex(body), 0) } else { one };
        s.push(' ');
        s.push_str(&one);
    } else {
        for (cs, b) in &alts {
            s.push('\n');
            for c in cs {
                s.push_str(comment(c, 2).trim_end());
                s.push('\n');
            }
            s.push_str("  | ");
            s.push_str(b);
        }
    }
    s.push_str(";\n");
    s
}

/// JSON-Schlüssel der Felder eines Objekt-Typs, aus dem Modell (für `KNOWN_KEYS` in
/// `project_format.rs`, dort per Test abgeglichen).
pub(crate) fn object_keys<T: TS>() -> Vec<String> {
    let toks = lex(&T::inline(&Config::default()));
    let Some(Tok::Group('{', inner, _)) = toks.into_iter().find(|t| matches!(t, Tok::Group('{', ..))) else {
        panic!("kein Objekt-Typ");
    };
    let mut keys = vec![];
    let mut at_start = true;
    for t in inner {
        match t {
            Tok::Comma => at_start = true,
            Tok::Text(x) if at_start => {
                let k = x.trim_start().split([':', '?']).next().unwrap_or("").trim();
                if !k.is_empty() {
                    keys.push(k.to_string());
                    at_start = false;
                }
            }
            Tok::Str(x) if at_start => {
                keys.push(x.trim_matches('"').to_string());
                at_start = false;
            }
            _ => {}
        }
    }
    keys
}

/// Der ganze Dateiinhalt von `types.generated.ts`.
pub fn render() -> String {
    let cfg = Config::default();
    let mut decls = collect(&cfg);
    resolve_tagged_newtypes(&mut decls);
    let mut s = String::from(HEADER);
    for d in decls.values() {
        s.push('\n');
        if let Some(doc) = &d.docs {
            s.push_str(&comment(doc, 0));
        }
        s.push_str(&format_decl(&d.decl));
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ts_types_aktuell() {
        let want = render();
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(OUT);
        if std::env::var("DOSSIER_GEN_TYPES").is_ok_and(|v| v == "1") {
            std::fs::write(&path, &want).expect("types.generated.ts schreiben");
            return;
        }
        let have = std::fs::read_to_string(&path).unwrap_or_default();
        assert!(
            have == want,
            "src/model/types.generated.ts ist veraltet (Rust-Modell geändert?) — `npm run gen:types` laufen lassen"
        );
    }
}
