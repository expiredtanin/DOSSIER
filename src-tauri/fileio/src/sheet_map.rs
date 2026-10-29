//! Raumprogramm aus einer Tabelle ([61]): Zuordnung der Spalten und Abbildung der Zeilen auf Programmzeilen.
//! Hervorgegangen aus `src/io/roomProgramImport.ts` (TS-Fassung gelöscht; die TS-Seite ist eine dünne Fassade).
//!
//! * [`detect_header_row`] / [`suggest_mapping`]: Kopfzeile erkennen, Spalten nach Überschriften (de/en/fr) zuordnen,
//!   Fehlendes (Name, Fläche, Anzahl) aus den Daten raten.
//! * [`map_rows`]: Zeilen → [`ImportLine`] (Summen- und Leerzeilen überspringen, Zwischentitel als Gruppe).
//!
//! Vergleichsform der Überschriften wie in TS (`key`): klein, Umlaute/Akzente ohne Zeichen, nur a–z und 0–9.
//! Akzente ersetzt eine feste Tabelle (Latin-1/Latin Extended-A) statt Unicode-NFD.

use std::collections::HashSet;

use crate::sheet_import::{parse_number, Cell};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Field {
    Name,
    Area,
    Count,
    Kind,
    Group,
    Note,
}

pub const FIELDS: [Field; 6] = [Field::Name, Field::Area, Field::Count, Field::Kind, Field::Group, Field::Note];

impl Field {
    pub fn key(self) -> &'static str {
        match self {
            Field::Name => "name",
            Field::Area => "area",
            Field::Count => "count",
            Field::Kind => "kind",
            Field::Group => "group",
            Field::Note => "note",
        }
    }
    pub fn from_key(s: &str) -> Option<Field> {
        FIELDS.iter().copied().find(|f| f.key() == s)
    }
    fn idx(self) -> usize {
        self as usize
    }
}

/// Spaltenindex je Feld (0-basiert).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Columns(pub [Option<usize>; 6]);

impl Columns {
    pub fn get(&self, f: Field) -> Option<usize> {
        self.0[f.idx()]
    }
    fn set(&mut self, f: Field, c: usize) {
        self.0[f.idx()] = Some(c);
    }
    fn len(&self) -> usize {
        self.0.iter().flatten().count()
    }
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Mapping {
    pub header_row: Option<usize>,
    pub columns: Columns,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RoomRow {
    pub name: String,
    pub area: f64,
    pub count: Option<f64>,
    pub sia_category: Option<&'static str>,
    pub group: Option<String>,
    pub note: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct ImportLine {
    pub sheet_row: usize,
    pub row: Option<RoomRow>,
    pub skip: Option<&'static str>,
    pub group_heading: Option<String>,
    pub unknown_kind: Option<String>,
}

// ── Zellen ──────────────────────────────────────────────────────────────────

/// Zahl einer Zelle (Zahl bleibt, Text wird geparst), sonst `None`.
pub fn cell_number(c: &Cell) -> Option<f64> {
    match c {
        Cell::Num(n) if n.is_finite() => Some(*n),
        Cell::Text(t) if !t.trim().is_empty() => parse_number(t),
        _ => None,
    }
}

/// Text einer Zelle (Zahlen ohne Nachkomma-Rauschen, leer = "").
pub fn cell_text(c: &Cell) -> String {
    match c {
        Cell::Empty => String::new(),
        Cell::Num(n) => {
            let v = if n.fract() == 0.0 { *n } else { (n * 1e6 + 0.5).floor() / 1e6 };
            if v == 0.0 {
                "0".into()
            } else {
                format!("{}", v)
            }
        }
        Cell::Text(t) => t.trim().to_string(),
    }
}

fn at(r: &[Cell], i: usize) -> &Cell {
    r.get(i).unwrap_or(&Cell::Empty)
}

// ── Spaltennamen ────────────────────────────────────────────────────────────

fn base_letter(c: char) -> Option<char> {
    Some(match c {
        'à' | 'á' | 'â' | 'ã' | 'å' | 'ā' | 'ă' | 'ą' => 'a',
        'ç' | 'ć' | 'ĉ' | 'ċ' | 'č' => 'c',
        'ď' => 'd',
        'è' | 'é' | 'ê' | 'ë' | 'ē' | 'ĕ' | 'ė' | 'ę' | 'ě' => 'e',
        'ĝ' | 'ğ' | 'ġ' | 'ģ' => 'g',
        'ì' | 'í' | 'î' | 'ï' | 'ĩ' | 'ī' | 'ĭ' | 'į' => 'i',
        'ñ' | 'ń' | 'ņ' | 'ň' => 'n',
        'ò' | 'ó' | 'ô' | 'õ' | 'ō' | 'ŏ' | 'ő' => 'o',
        'ŕ' | 'ř' => 'r',
        'ś' | 'ŝ' | 'ş' | 'š' => 's',
        'ţ' | 'ť' => 't',
        'ù' | 'ú' | 'û' | 'ũ' | 'ū' | 'ŭ' | 'ů' | 'ű' | 'ų' => 'u',
        'ý' | 'ÿ' | 'ŷ' => 'y',
        'ź' | 'ż' | 'ž' => 'z',
        _ => return None,
    })
}

/// Vergleichsform: klein, ohne Umlaut-Punkte/Akzente, nur Buchstaben und Ziffern.
fn key(s: &str) -> String {
    let mut out = String::new();
    for c in s.to_lowercase().chars() {
        match c {
            'ä' => out.push('a'),
            'ö' => out.push('o'),
            'ü' => out.push('u'),
            'ß' => out.push_str("ss"),
            '²' => out.push('2'),
            c if c.is_ascii_lowercase() || c.is_ascii_digit() => out.push(c),
            c => {
                if let Some(b) = base_letter(c) {
                    out.push(b);
                }
            }
        }
    }
    out
}

fn headers(f: Field) -> &'static [&'static str] {
    match f {
        Field::Name => &["raum", "raume", "raumname", "raumbezeichnung", "bezeichnung", "name", "nutzung", "raumnutzung", "room", "rooms", "roomname", "designation", "description", "space", "piece", "local", "pieces", "designationdupiece", "nomdupiece"],
        Field::Area => &["flache", "m2", "qm", "sollflache", "flachem2", "flachejeraum", "flacheproraum", "grosse", "area", "surface", "sollm2", "soll", "nettoflache", "nutzflache", "size", "m2jeraum", "flachesoll", "areasqm", "aream2"],
        Field::Count => &["anzahl", "anz", "stk", "stuck", "stuk", "menge", "n", "count", "qty", "quantity", "number", "nombre", "nb", "nbre", "quantite", "pcs", "sollanzahl"],
        Field::Kind => &["flachenart", "art", "kategorie", "category", "sia", "sia416", "typ", "type", "nutzungsart", "nutzungskategorie", "kat", "flachentyp", "kind", "categorie", "genre"],
        Field::Group => &["gruppe", "geschoss", "etage", "bereich", "group", "level", "floor", "storey", "abteilung", "zone", "nutzungseinheit", "cluster", "gruppierung", "stockwerk", "niveau", "groupe", "secteur"],
        Field::Note => &["bemerkung", "bemerkungen", "kommentar", "notiz", "notizen", "anmerkung", "anmerkungen", "note", "notes", "comment", "comments", "remark", "remarks", "remarque", "remarques", "commentaire", "hinweis", "beschreibung"],
    }
}

/// Wie gut passt eine Überschrift zu einem Feld: 2 = genau, 1 = enthält, 0 = nein.
fn header_score(cell: &str, field: Field) -> u8 {
    let k = key(cell);
    if k.is_empty() {
        return 0;
    }
    if headers(field).contains(&k.as_str()) {
        return 2;
    }
    let has = |ws: &[&str]| ws.iter().any(|w| k.contains(w));
    let hit = match field {
        Field::Area => has(&["flache", "m2", "qm"]) && k.len() <= 24,
        Field::Name => has(&["raum", "bezeichnung"]),
        Field::Count => has(&["anzahl", "stuck", "stk"]),
        Field::Kind => has(&["flachenart", "kategorie", "nutzungsart"]),
        Field::Group => has(&["gruppe", "geschoss", "etage"]),
        Field::Note => has(&["bemerk", "kommentar", "notiz"]),
    };
    hit as u8
}

/// Spalten nach Überschriften der Zeile: jedem Feld höchstens eine Spalte, beste Treffer zuerst.
fn columns_from_header(row: &[Cell]) -> Columns {
    let mut cand: Vec<(Field, usize, u8)> = Vec::new();
    for (col, c) in row.iter().enumerate() {
        let text = cell_text(c);
        if text.is_empty() {
            continue;
        }
        for f in FIELDS {
            let s = header_score(&text, f);
            if s > 0 {
                cand.push((f, col, s));
            }
        }
    }
    cand.sort_by(|a, b| b.2.cmp(&a.2).then(a.1.cmp(&b.1)));
    let mut out = Columns::default();
    let mut used = HashSet::new();
    for (f, col, _) in cand {
        if out.get(f).is_some() || used.contains(&col) {
            continue;
        }
        out.set(f, col);
        used.insert(col);
    }
    out
}

/// Kopfzeile in den ersten 20 Zeilen: die mit den meisten erkannten Feldern (mindestens Name und Fläche, oder zwei Felder).
pub fn detect_header_row(rows: &[Vec<Cell>]) -> Option<usize> {
    let mut best: Option<(usize, usize, bool)> = None;
    for (r, row) in rows.iter().take(20).enumerate() {
        let cols = columns_from_header(row);
        let n = cols.len();
        if n < 2 {
            continue;
        }
        let has_core = cols.get(Field::Name).is_some() && cols.get(Field::Area).is_some();
        let better = match best {
            None => true,
            Some((_, bn, bc)) => (has_core && !bc) || (has_core == bc && n > bn),
        };
        if better {
            best = Some((r, n, has_core));
        }
    }
    best.map(|b| b.0)
}

/// Spalten aus den Daten raten, wenn Überschriften fehlen.
fn columns_from_data(rows: &[Vec<Cell>], from: usize) -> Columns {
    let sample: &[Vec<Cell>] = if from >= rows.len() { &[] } else { &rows[from..rows.len().min(from + 60)] };
    let width = sample.iter().map(|r| r.len()).max().unwrap_or(0);
    struct St {
        col: usize,
        text: usize,
        nums: usize,
        ints: usize,
        mean: f64,
    }
    let stats: Vec<St> = (0..width)
        .map(|col| {
            let (mut text, mut nums, mut ints, mut sum) = (0, 0, 0, 0.0);
            for r in sample {
                let c = at(r, col);
                if cell_text(c).is_empty() {
                    continue;
                }
                match cell_number(c) {
                    None => text += 1,
                    Some(n) => {
                        nums += 1;
                        sum += n;
                        if n.fract() == 0.0 && (1.0..=50.0).contains(&n) {
                            ints += 1;
                        }
                    }
                }
            }
            St { col, text, nums, ints, mean: if nums > 0 { sum / nums as f64 } else { 0.0 } }
        })
        .collect();
    let mut out = Columns::default();
    if let Some(s) = stats.iter().find(|s| s.text > 0 && s.text >= s.nums) {
        out.set(Field::Name, s.col);
    }
    let numeric: Vec<&St> = stats.iter().filter(|s| s.nums > s.text && s.nums > 0).collect();
    let mut sorted = numeric.clone();
    sorted.sort_by(|a, b| b.mean.partial_cmp(&a.mean).unwrap_or(std::cmp::Ordering::Equal));
    let area = sorted.first().map(|s| s.col);
    if let Some(a) = area {
        out.set(Field::Area, a);
    }
    if let Some(s) = numeric.iter().find(|s| Some(s.col) != area && s.ints == s.nums) {
        out.set(Field::Count, s.col);
    }
    out
}

/// Vorschlag: Kopfzeile erkennen und Spalten zuordnen; was die Überschriften offen lassen, ergänzen die Daten.
pub fn suggest_mapping(rows: &[Vec<Cell>]) -> Mapping {
    let header_row = detect_header_row(rows);
    let mut columns = match header_row {
        Some(h) => columns_from_header(&rows[h]),
        None => Columns::default(),
    };
    let guessed = columns_from_data(rows, header_row.map_or(0, |h| h + 1));
    let mut taken: HashSet<usize> = columns.0.iter().flatten().copied().collect();
    for f in [Field::Name, Field::Area, Field::Count] {
        if let Some(col) = guessed.get(f) {
            if columns.get(f).is_none() && !taken.contains(&col) && (header_row.is_none() || f != Field::Count) {
                columns.set(f, col);
                taken.insert(col);
            }
        }
    }
    Mapping { header_row, columns }
}

// ── Zeilen abbilden ─────────────────────────────────────────────────────────

fn is_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// `\b` an Position `pos` (JS-Semantik ohne Unicode-Modus: Wortzeichen = ASCII).
fn boundary(cs: &[char], pos: usize) -> bool {
    let before = pos > 0 && is_word(cs[pos - 1]);
    let after = pos < cs.len() && is_word(cs[pos]);
    before != after
}

fn lower_chars(s: &str) -> Vec<char> {
    s.chars().flat_map(|c| if c == 'ς' { vec!['σ'] } else { c.to_lowercase().collect() }).collect()
}

/// Beginnt der Text (ohne Gross-/Kleinschreibung) mit einem der Wörter, gefolgt von `\b`?
fn starts_word(text: &str, words: &[&str]) -> bool {
    let cs = lower_chars(text);
    words.iter().any(|w| {
        let wc: Vec<char> = w.chars().collect();
        cs.len() >= wc.len() && cs[..wc.len()] == wc[..] && boundary(&cs, wc.len())
    })
}

fn starts_prefix(text: &str, prefixes: &[&str]) -> bool {
    let cs = lower_chars(text);
    prefixes.iter().any(|w| {
        let wc: Vec<char> = w.chars().collect();
        cs.len() >= wc.len() && cs[..wc.len()] == wc[..]
    })
}

const SUM_WORDS: [&str; 16] = [
    "σ", "∑", "total", "totale", "summe", "zwischensumme", "gesamt", "gesamtsumme", "gesamtfläche", "übertrag", "sum", "subtotal", "grand total", "somme", "sous-total", "totaux",
];

fn is_sum_word(text: &str) -> bool {
    starts_word(text, &SUM_WORDS)
}

/// Flächenart aus Text ("HNF", "HNF 1.1", "Hauptnutzfläche"); sonst `None`.
pub fn parse_kind(text: &str) -> Option<&'static str> {
    let t = text.trim();
    let table: [(&[&str], &[&str], &str); 6] = [
        (&["hnf"], &["hauptnutz"], "HNF"),
        (&["nnf"], &["nebennutz"], "NNF"),
        (&["vf"], &["verkehrsfl"], "VF"),
        (&["ff"], &["funktionsfl"], "FF"),
        (&["kgf", "kf"], &["konstruktionsfl"], "KGF"),
        (&["agf"], &["aussengeschoss", "außengeschoss"], "AGF"),
    ];
    for (words, prefixes, cat) in table {
        if starts_word(t, words) || starts_prefix(t, prefixes) {
            return Some(cat);
        }
    }
    None
}

fn js_round(x: f64) -> f64 {
    (x + 0.5).floor()
}

/// Eine Tabelle mit Zuordnung in Programmzeilen übersetzen.
pub fn map_rows(rows: &[Vec<Cell>], mapping: &Mapping, skip_sums: bool) -> Vec<ImportLine> {
    let cols = &mapping.columns;
    let start = mapping.header_row.map_or(0, |h| h + 1);
    let mut out = Vec::new();
    if let Some(h) = mapping.header_row {
        out.push(ImportLine { sheet_row: h, skip: Some("header"), ..Default::default() });
    }
    let get = |r: &[Cell], f: Field| -> Cell { cols.get(f).map_or(Cell::Empty, |c| at(r, c).clone()) };
    let mut heading = String::new();
    let mut running = 0.0_f64;
    for (i, r) in rows.iter().enumerate().skip(start) {
        let line = |skip| ImportLine { sheet_row: i, skip: Some(skip), ..Default::default() };
        if r.iter().all(|c| cell_text(c).is_empty()) {
            out.push(line("empty"));
            continue;
        }
        let name = cell_text(&get(r, Field::Name));
        let area = cell_number(&get(r, Field::Area));
        let count_raw = cell_number(&get(r, Field::Count));
        let keyword = is_sum_word(&name)
            || (name.is_empty() && r.iter().any(|c| matches!(c, Cell::Text(t) if !t.trim().is_empty() && is_sum_word(t.trim()))));
        let matches_running = name.is_empty() && area.map_or(false, |a| running > 0.0 && (a - running).abs() < 0.005 * running.max(1.0));
        if skip_sums && (keyword || matches_running) {
            out.push(line("sum"));
            running = 0.0;
            continue;
        }
        if name.is_empty() {
            out.push(line("noName"));
            continue;
        }
        if area.is_none() && count_raw.is_none() && cols.get(Field::Group).is_none() {
            let others = (0..r.len()).any(|c| Some(c) != cols.get(Field::Name) && !cell_text(&r[c]).is_empty());
            if !others {
                heading = name.clone();
                out.push(ImportLine { sheet_row: i, skip: Some("noArea"), group_heading: Some(name), ..Default::default() });
                continue;
            }
        }
        let area = match area {
            Some(a) if a > 0.0 => a,
            _ => {
                out.push(line("noArea"));
                continue;
            }
        };
        let count = count_raw.map_or(1.0, js_round);
        let mut row = RoomRow { name, area, count: if count > 1.0 { Some(count) } else { None }, sia_category: None, group: None, note: None };
        let kind_text = cell_text(&get(r, Field::Kind));
        let mut unknown_kind = None;
        if !kind_text.is_empty() {
            match parse_kind(&kind_text) {
                Some(k) => row.sia_category = Some(k),
                None => unknown_kind = Some(kind_text),
            }
        }
        let group = if cols.get(Field::Group).is_some() { cell_text(&get(r, Field::Group)) } else { heading.clone() };
        if !group.is_empty() {
            row.group = Some(group);
        }
        let note = cell_text(&get(r, Field::Note));
        if !note.is_empty() {
            row.note = Some(note);
        }
        running += area * count.max(1.0);
        out.push(ImportLine { sheet_row: i, row: Some(row), unknown_kind, ..Default::default() });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(s: &str) -> Cell {
        Cell::Text(s.into())
    }
    fn n(v: f64) -> Cell {
        Cell::Num(v)
    }

    fn table() -> Vec<Vec<Cell>> {
        use Cell::Empty as E;
        vec![
            vec![t("Raumprogramm Schulhaus"), E, E, E, E],
            vec![E, E, E, E, E],
            vec![t("Raum"), t("Fläche [m²]"), t("Anzahl"), t("Bemerkung"), t("Flächenart")],
            vec![t("Unterricht"), E, E, E, E],
            vec![t("Klassenzimmer"), t("72,0"), n(6.0), t("hell"), t("HNF")],
            vec![t("Gruppenraum"), n(36.0), n(4.0), E, t("Hauptnutzfläche")],
            vec![t("Total"), n(576.0), n(10.0), E, E],
            vec![t("Lehrerzimmer"), t("1'050,5"), E, E, t("xyz")],
            vec![E, E, E, E, E],
            vec![E, n(1626.5), E, E, E],
        ]
    }

    #[test]
    fn kopfzeile_und_spalten() {
        let tb = table();
        assert_eq!(detect_header_row(&tb), Some(2));
        let m = suggest_mapping(&tb);
        assert_eq!(m.columns.0, [Some(0), Some(1), Some(2), Some(4), None, Some(3)]);
    }

    #[test]
    fn zeilen_abbilden() {
        let tb = table();
        let lines = map_rows(&tb, &suggest_mapping(&tb), true);
        let rows: Vec<&RoomRow> = lines.iter().filter_map(|l| l.row.as_ref()).collect();
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0].group.as_deref(), Some("Unterricht"));
        assert_eq!(rows[0].count, Some(6.0));
        assert_eq!(rows[1].sia_category, Some("HNF"));
        assert_eq!(rows[2].area, 1050.5);
        assert_eq!(lines[1].group_heading.as_deref(), Some("Unterricht"));
        assert_eq!(lines.iter().find(|l| l.sheet_row == 6).unwrap().skip, Some("sum"));
        assert_eq!(lines.iter().find(|l| l.sheet_row == 7).unwrap().unknown_kind.as_deref(), Some("xyz"));
        assert_eq!(lines.iter().find(|l| l.sheet_row == 9).unwrap().skip, Some("noName"));
    }

    #[test]
    fn flaechenart_und_summenwoerter() {
        assert_eq!(parse_kind("HNF 1.1"), Some("HNF"));
        assert_eq!(parse_kind("Konstruktionsfläche"), Some("KGF"));
        assert_eq!(parse_kind("kf"), Some("KGF"));
        assert_eq!(parse_kind("hnfx"), None);
        assert!(is_sum_word("Zwischensumme 1"));
        assert!(is_sum_word("TOTAL"));
        assert!(!is_sum_word("Totalsanierung"));
        assert!(is_sum_word("Σ12"));
        assert!(!is_sum_word("Σ "));
    }

    #[test]
    fn ohne_kopfzeile_aus_daten() {
        let tb = vec![vec![t("Küche"), n(12.5), n(1.0)], vec![t("Bad"), n(6.0), n(2.0)], vec![t("Zimmer"), n(14.0), n(3.0)]];
        let m = suggest_mapping(&tb);
        assert_eq!(m.header_row, None);
        assert_eq!(m.columns.0, [Some(0), Some(1), Some(2), None, None, None]);
    }
}
