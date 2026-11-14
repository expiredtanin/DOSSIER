// Anonyme Wettbewerbs-Abgabe ([208]): was die Ausgaben über die Herkunft sagen dürfen. Ist
// `Project.competition` anonym, trägt keine Ausgabe Büro, Bearbeiter:in, Projektname, Projektnummer, Adresse
// oder Benutzername — nur das Kennwort. Gegenstück in TS: `src/export/competitionIdentity.ts` (dieselbe Regel für
// PDF, Berichte, STEP, Blender-Paket, Dateinamen). Der Plankopf löst das selbst auf (`layout_model.rs`).

use crate::model::Project;

/// Fester Zeitstempel anonymer Ausgaben: 2000-01-01 00:00:00 UTC (Sekunden seit 1970).
pub const NEUTRAL_EPOCH: f64 = 946_684_800.0;
/// Derselbe Zeitstempel als ISO-Text ohne Zone.
pub const NEUTRAL_ISO: &str = "2000-01-01T00:00:00";

/// Kennwort der Abgabe, wenn sie anonym ist (getrimmt; leer = anonym ohne Kennwort); `None` = nicht anonym.
pub fn anonymous_keyword(p: &Project) -> Option<String> {
    p.competition.as_ref().filter(|c| c.anonymous).map(|c| c.keyword.trim().to_string())
}

// ---------------------------------------------------------------------------------------------------------
// Anonymitäts-Prüfung des Freitexts (vor dem Export einer anonymen Abgabe)
// ---------------------------------------------------------------------------------------------------------
//
// Die Ausgaben neutralisieren die Stammdaten selbst (Plankopf, PDF-Info, IFC-/DXF-/STEP-Kopf, Dateinamen). Frei
// eingegebene Texte kennt keiner dieser Wege: ein Raum „Büro Muster", eine Ebene „Entwurf Meier", ein Textobjekt
// mit Telefonnummer. Die Prüfung läuft über das Projekt-JSON (jede Zeichenkette ausser Ids, Data-URLs und den
// Quellfeldern selbst) und sucht identifizierende Begriffe: Projektname, -nummer, Titelblock-Büro/-Bearbeiter,
// Adresse des Standort-Bezugs, die Angaben unter `competition.identifiers`, den Projekt-Dateinamen, dazu
// E-Mail-Adressen und Telefonnummern an sich. Treffer: ganze Wörter, Gross-/Kleinschreibung, Umlaute (ä = ae = a)
// und Trennzeichen egal.
//
// Producer in den PDF-Metadaten: bleibt leer, auch „Dossier" kommt nicht hinein — Programm und Version zusammen
// mit dem Datum grenzen die Herkunft ein (`export/pdfInfo.ts` neutralisiert Producer und Datum längengleich).

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Ein zusätzlicher Text von aussen (z. B. Dateiname der Ausgabe), den der Kern nicht im Projekt findet.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ExtraText {
    pub area: String,
    pub place: String,
    pub text: String,
}

/// Eingabe der Prüfung von der TS-Seite: Projekt-Dateiname (Begriff) und weitere zu prüfende Texte.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct CheckInput {
    /// Dateiname des Projekts (mit oder ohne Endung): als Begriff gesucht.
    #[serde(rename = "fileName")]
    pub file_name: String,
    /// Weitere Texte (Dateiname der Ausgabe …), geprüft wie Projekttexte.
    pub texts: Vec<ExtraText>,
}

/// Ein Treffer.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Finding {
    /// Oberste Projekt-Liste (`rooms`, `drawingLevels`, `layouts` …) bzw. Bereich des Zusatztexts.
    pub area: String,
    /// Fundstelle: Elementname und Feld, z. B. `Küche.name`.
    pub place: String,
    /// Der Text (gekürzt auf 80 Zeichen).
    pub text: String,
    /// Der gefundene Begriff bzw. die gefundene E-Mail/Telefonnummer.
    pub term: String,
    /// Herkunft des Begriffs: `name`, `number`, `titleBlock`, `address`, `identifier`, `file`, `email`, `phone`.
    pub kind: String,
}

/// Wörter, die als Einzelbegriff nie zählen (zu allgemein): Namensteile in Projekt- und Büronamen.
const GENERIC: &[&str] = &[
    "projekt", "neubau", "umbau", "wohnhaus", "gebäude", "architekten", "architektur", "architekt", "büro", "bureau",
    "wettbewerb", "haus", "strasse", "wohnen", "schule", "zentrum", "areal", "überbauung", "siedlung", "erweiterung",
    "sanierung", "entwurf", "vorprojekt", "studie", "partner", "pläne",
];

/// Mindestlänge: ganze Angabe (Phrase) und Einzelwort daraus.
const MIN_PHRASE: usize = 3;
const MIN_WORD: usize = 5;

/// Vergleichsform: klein, Umlaute/Akzente zu Grundbuchstaben (ä = ae = a), Nicht-Buchstaben/Ziffern → ein Leerzeichen.
fn norm(s: &str) -> String {
    let mut t = String::with_capacity(s.len());
    for c in s.chars().flat_map(|c| c.to_lowercase()) {
        match c {
            'ä' | 'à' | 'á' | 'â' | 'ã' | 'å' => t.push('a'),
            'ö' | 'ò' | 'ó' | 'ô' | 'õ' => t.push('o'),
            'ü' | 'ù' | 'ú' | 'û' => t.push('u'),
            'é' | 'è' | 'ê' | 'ë' => t.push('e'),
            'ì' | 'í' | 'î' | 'ï' => t.push('i'),
            'ç' => t.push('c'),
            'ß' => t.push_str("ss"),
            c if c.is_alphanumeric() => t.push(c),
            _ => t.push(' '),
        }
    }
    let t = t.replace("ae", "a").replace("oe", "o").replace("ue", "u");
    t.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn is_generic(word_norm: &str) -> bool {
    GENERIC.iter().any(|g| norm(g) == word_norm)
}

struct Term {
    raw: String,
    norm: String,
    kind: &'static str,
}

fn split_list(s: &str) -> impl Iterator<Item = &str> {
    s.split([',', ';', '\n']).map(str::trim).filter(|x| !x.is_empty())
}

/// Nimmt die Angabe als Phrase auf; mit `words` zusätzlich ihre Einzelwörter (lang genug, nicht allgemein, keine Zahl).
fn push_term(out: &mut Vec<Term>, raw: &str, kind: &'static str, words: bool) {
    let raw = raw.trim();
    let n = norm(raw);
    if n.chars().count() < MIN_PHRASE {
        return;
    }
    let digits_only = n.chars().all(|c| c.is_ascii_digit() || c == ' ');
    if !digits_only || kind == "number" {
        out.push(Term { raw: raw.to_string(), norm: n.clone(), kind });
    }
    if words {
        for w in n.split(' ') {
            if w.chars().count() >= MIN_WORD && !w.chars().all(|c| c.is_ascii_digit()) && !is_generic(w) && w != n {
                out.push(Term { raw: w.to_string(), norm: w.to_string(), kind });
            }
        }
    }
}

fn str_at<'a>(v: &'a Value, path: &[&str]) -> Option<&'a str> {
    let mut cur = v;
    for k in path {
        cur = cur.get(*k)?;
    }
    cur.as_str()
}

/// Begriffe aus den Stammdaten des Projekts und der Eingabe.
fn terms_of(root: &Value, input: &CheckInput) -> Vec<Term> {
    let mut out = Vec::new();
    if let Some(n) = str_at(root, &["name"]) {
        push_term(&mut out, n, "name", true);
    }
    if let Some(n) = str_at(root, &["projectNumber"]) {
        push_term(&mut out, n, "number", false);
    }
    for m in root.get("masterLayouts").and_then(Value::as_array).into_iter().flatten() {
        for f in ["projectName", "author"] {
            if let Some(n) = str_at(m, &["titleBlock", f]) {
                push_term(&mut out, n, "titleBlock", true);
            }
        }
    }
    if let Some(label) = str_at(root, &["geoAnchor", "label"]) {
        for part in label.split([',', ';']) {
            push_term(&mut out, part, "address", false);
        }
    }
    if let Some(ids) = str_at(root, &["competition", "identifiers"]) {
        for e in split_list(ids) {
            push_term(&mut out, e, "identifier", true);
        }
    }
    let base = input.file_name.rsplit(['/', '\\']).next().unwrap_or("");
    let stem = base.rsplit_once('.').map(|(a, _)| a).unwrap_or(base);
    if norm(stem).chars().count() >= 4 {
        push_term(&mut out, stem, "file", false);
    }
    // Das Kennwort selbst ist erlaubt.
    let keyword = norm(str_at(root, &["competition", "keyword"]).unwrap_or(""));
    out.retain(|t| keyword.is_empty() || t.norm != keyword);
    let mut seen = std::collections::HashSet::new();
    out.retain(|t| seen.insert(t.norm.clone()));
    out
}

/// Kommt der Begriff (normiert) als ganze Wörter im Text (normiert) vor?
fn contains_words(hay_norm: &str, needle_norm: &str) -> bool {
    !needle_norm.is_empty() && format!(" {hay_norm} ").contains(&format!(" {needle_norm} "))
}

/// E-Mail-Adresse im Text (`x@y.z`)?
fn find_email(s: &str) -> Option<String> {
    for tok in s.split(|c: char| c.is_whitespace() || matches!(c, '<' | '>' | '(' | ')' | ',' | ';' | '"' | '\'')) {
        let tok = tok.trim_matches(|c: char| c == '.' || c == ':');
        if let Some((l, d)) = tok.split_once('@') {
            let dom_ok = d.contains('.') && !d.starts_with('.') && !d.ends_with('.') && d.chars().all(|c| c.is_alphanumeric() || c == '.' || c == '-');
            if !l.is_empty() && dom_ok {
                return Some(tok.to_string());
            }
        }
    }
    None
}

/// Telefonnummer im Text: beginnt mit `+` oder `0`, 9 bis 15 Ziffern, nur Ziffern und übliche Trenner, und
/// hat Trenner oder `+` (eine blosse Ziffernfolge ist eher eine Nummer als ein Telefon).
fn find_phone(s: &str) -> Option<String> {
    let cs: Vec<char> = s.chars().collect();
    let mut i = 0;
    while i < cs.len() {
        let next = cs.get(i + 1).copied().unwrap_or(' ');
        let starts = (i == 0 || !cs[i - 1].is_alphanumeric()) && ((cs[i] == '0' && next.is_ascii_digit()) || (cs[i] == '+' && (next.is_ascii_digit() || next == ' ' || next == '(')));
        if !starts {
            i += 1;
            continue;
        }
        let mut j = i;
        let mut digits = 0;
        while j < cs.len() && (cs[j].is_ascii_digit() || matches!(cs[j], ' ' | '-' | '/' | '.' | '(' | ')' | '+')) {
            if cs[j].is_ascii_digit() {
                digits += 1;
            }
            j += 1;
        }
        let run: String = cs[i..j].iter().collect::<String>().trim_end_matches([' ', '-', '/', '.']).to_string();
        let has_sep = run.chars().any(|c| matches!(c, ' ' | '-' | '/' | '(' | '+'));
        if (9..=15).contains(&digits) && has_sep {
            return Some(run);
        }
        i = j.max(i + 1);
    }
    None
}

fn shorten(s: &str) -> String {
    let one: String = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if one.chars().count() > 80 {
        let mut c: String = one.chars().take(79).collect();
        c.push('…');
        c
    } else {
        one
    }
}

fn skip_key(k: &str) -> bool {
    k == "id" || k.ends_with("Id") || k.ends_with("Ids") || matches!(k, "src" | "dataUrl" | "formatVersion")
}

/// Kennzeichnung eines Array-Elements: sein Name, sonst der Index.
fn element_label(v: &Value, i: usize) -> String {
    match v.get("name").and_then(Value::as_str).map(str::trim).filter(|n| !n.is_empty()) {
        Some(n) => shorten(n),
        None => i.to_string(),
    }
}

struct Walk<'a> {
    terms: &'a [Term],
    out: Vec<Finding>,
}

impl Walk<'_> {
    fn push(&mut self, area: &str, place: &str, text: &str, term: &str, kind: &str) {
        self.out.push(Finding { area: area.into(), place: place.into(), text: shorten(text), term: term.into(), kind: kind.into() });
    }

    fn check(&mut self, area: &str, place: &str, text: &str) {
        if text.trim().is_empty() || text.starts_with("data:") {
            return;
        }
        let hay = norm(text);
        let hits: Vec<&Term> = self.terms.iter().filter(|t| contains_words(&hay, &t.norm)).collect();
        // Ein Treffer, der in einem längeren steckt (Wort der Phrase), zählt nicht extra.
        for t in &hits {
            if !hits.iter().any(|o| o.norm != t.norm && contains_words(&o.norm, &t.norm)) {
                self.push(area, place, text, &t.raw, t.kind);
            }
        }
        if let Some(e) = find_email(text) {
            self.push(area, place, text, &e, "email");
        }
        if let Some(p) = find_phone(text) {
            self.push(area, place, text, &p, "phone");
        }
    }

    fn walk(&mut self, area: &str, path: &str, v: &Value) {
        match v {
            Value::String(s) => self.check(area, path, s),
            Value::Array(a) => {
                for (i, e) in a.iter().enumerate() {
                    let label = element_label(e, i);
                    let p = if path.is_empty() { label } else { format!("{path}.{label}") };
                    self.walk(area, &p, e);
                }
            }
            Value::Object(m) => {
                for (k, e) in m {
                    if skip_key(k) {
                        continue;
                    }
                    let p = if path.is_empty() { k.clone() } else { format!("{path}.{k}") };
                    self.walk(area, &p, e);
                }
            }
            _ => {}
        }
    }
}

/// Prüft den Freitext des Projekts (JSON-Wurzel) und die Zusatztexte; leer = sauber. Nur bei anonymer Abgabe
/// sinnvoll — die Aufrufer entscheiden das (`anonymous_keyword`).
pub fn anonymity_findings(root: &Value, input: &CheckInput) -> Vec<Finding> {
    let terms = terms_of(root, input);
    let mut w = Walk { terms: &terms, out: Vec::new() };
    if let Value::Object(m) = root {
        for (k, v) in m {
            // Quellen der Begriffe und Programm-Interna: nicht Freitext der Ausgabe.
            if skip_key(k) || matches!(k.as_str(), "name" | "projectNumber" | "competition" | "geoAnchor" | "uiState" | "publishLog") {
                continue;
            }
            w.walk(k, "", v);
        }
    }
    // Titelblock-Quellfelder sind Stammdaten (der Plankopf löst sie anonym auf): nicht melden.
    w.out.retain(|f| !(f.area == "masterLayouts" && (f.place.ends_with("titleBlock.projectName") || f.place.ends_with("titleBlock.author"))));
    for x in &input.texts {
        w.check(&x.area, &x.place, &x.text);
    }
    w.out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::CompetitionSettings;

    #[test]
    fn nur_anonym_liefert_kennwort() {
        let mut p = Project::default();
        assert_eq!(anonymous_keyword(&p), None);
        p.competition = Some(CompetitionSettings { anonymous: false, keyword: "K".into(), ..Default::default() });
        assert_eq!(anonymous_keyword(&p), None);
        p.competition = Some(CompetitionSettings { anonymous: true, keyword: " FALKE 7 ".into(), ..Default::default() });
        assert_eq!(anonymous_keyword(&p).as_deref(), Some("FALKE 7"));
    }

    fn root() -> Value {
        serde_json::json!({
            "name": "Haus Meierhofer",
            "projectNumber": "2026-017",
            "competition": { "anonymous": true, "keyword": "FALKE 7", "identifiers": "Atelier Brunner AG; Anna Zürcher\ninfo@brunner-arch.ch" },
            "geoAnchor": { "label": "Bahnhofstrasse 12, 8001 Zürich" },
            "masterLayouts": [{ "id": "m", "name": "Plakat", "titleBlock": { "projectName": "Meierhofer Haus", "author": "B. Brunner", "sheetName": "Grundriss" } }],
            "rooms": [{ "id": "r1", "name": "Küche" }, { "id": "r2", "name": "Büro Meierhofer", "note": "Tel +41 44 123 45 67" }],
            "drawingLevels": [{ "id": "l1", "name": "Erdgeschoss" }, { "id": "l2", "name": "EG MEIERHOFER" }],
            "layers": [{ "id": "k1", "name": "Wände", "layers": [{ "id": "k2", "name": "Anna Zuercher" }] }],
            "drawings2d": [{ "id": "d1", "kind": "text", "text": "Entwurf: Atelier  Brunner AG", "layerId": "Meierhofer" }],
            "layouts": [{ "id": "y1", "name": "Plan 2026/017 Süd", "images": [{ "id": "i1", "src": "data:image/png;base64,Meierhofer", "name": "logo-brunner.png" }] }],
            "blockDefs": [{ "id": "b1", "name": "Stuhl" }],
        })
    }
    fn find(r: &Value, input: &CheckInput) -> Vec<Finding> {
        anonymity_findings(r, input)
    }
    fn has(f: &[Finding], area: &str, kind: &str, contains: &str) -> bool {
        f.iter().any(|x| x.area == area && x.kind == kind && x.text.contains(contains) || x.area == area && x.kind == kind && x.place.contains(contains))
    }

    #[test]
    fn treffer_in_jedem_textort() {
        let f = find(&root(), &CheckInput::default());
        // Raumname (Wort aus dem Projektnamen), Geschoss (Gross-/Kleinschreibung), Kategorie (Umlaut-Variante)
        assert!(has(&f, "rooms", "name", "Büro Meierhofer"), "{f:?}");
        assert!(has(&f, "drawingLevels", "name", "EG MEIERHOFER"), "{f:?}");
        assert!(has(&f, "layers", "identifier", "Anna Zuercher"), "{f:?}");
        // Textobjekt: Angabe aus der Liste, trotz doppeltem Leerzeichen
        assert!(has(&f, "drawings2d", "identifier", "Atelier  Brunner AG") || has(&f, "drawings2d", "identifier", "Atelier Brunner AG"), "{f:?}");
        // Blattname mit Projektnummer, Bild-Dateiname mit Büro-Wort
        assert!(has(&f, "layouts", "number", "Plan 2026/017 Süd"), "{f:?}");
        assert!(has(&f, "layouts", "titleBlock", "logo-brunner.png"), "{f:?}");
        // Telefon im Raum
        assert!(f.iter().any(|x| x.kind == "phone" && x.area == "rooms"), "{f:?}");
    }

    #[test]
    fn stammdaten_und_ids_selbst_sind_keine_treffer() {
        let f = find(&root(), &CheckInput::default());
        // Projektname, Titelblock-Quellfelder, Adresse, competition und Data-URL/Ids nie melden
        assert!(f.iter().all(|x| x.area != "competition" && x.area != "geoAnchor" && x.area != "name"), "{f:?}");
        assert!(!f.iter().any(|x| x.place.contains("titleBlock.projectName") || x.place.contains("titleBlock.author")), "{f:?}");
        assert!(!f.iter().any(|x| x.text.starts_with("data:")), "{f:?}");
        assert!(!f.iter().any(|x| x.place.ends_with("layerId")), "{f:?}");
        // Das Kennwort ist erlaubt, auch im Freitext
        let mut r = root();
        r["rooms"][0]["name"] = Value::from("FALKE 7 Kern");
        assert!(!find(&r, &CheckInput::default()).iter().any(|x| x.text.contains("FALKE 7")));
    }

    #[test]
    fn adresse_und_email_und_dateiname() {
        let mut r = root();
        r["rooms"][0]["name"] = Value::from("Treffpunkt Bahnhofstrasse 12");
        r["layers"][0]["name"] = Value::from("mail info@brunner-arch.ch bitte");
        let f = find(&r, &CheckInput { file_name: "/tmp/Wettbewerb_Seeblick_v3.obp".into(), texts: vec![ExtraText { area: "export".into(), place: "Dateiname".into(), text: "Wettbewerb Seeblick v3.pdf".into() }] });
        assert!(has(&f, "rooms", "address", "Bahnhofstrasse 12"), "{f:?}");
        assert!(f.iter().any(|x| x.kind == "email" && x.area == "layers"), "{f:?}");
        assert!(f.iter().any(|x| x.area == "export" && x.kind == "file"), "{f:?}");
    }

    #[test]
    fn keine_fehlalarme_bei_kurzen_und_allgemeinen_woertern() {
        let r = serde_json::json!({
            "name": "Haus Muster Wohnen",
            "projectNumber": "26",
            "competition": { "anonymous": true, "keyword": "K", "identifiers": "AG, Ab, Anna" },
            "rooms": [{ "name": "Wohnen" }, { "name": "Haus" }, { "name": "Wohnhaus" }, { "name": "AG Raum" }, { "name": "Annahme" }, { "name": "Anna" }],
            "notes": [{ "text": "Fläche 1234567890 m2" }, { "text": "Mass 0.25 / 0.30 / 12.5" }, { "text": "a@b" }, { "text": "Preis 100.- 0 8 15" }],
        });
        let f = find(&r, &CheckInput::default());
        // „Muster" (≥ 5, kein allgemeines Wort) zählt, „Haus"/„Wohnen" nicht, „AG"/„Ab"/„Anna" (zu kurz) nicht als Wort
        assert!(f.iter().all(|x| x.kind != "email" && x.kind != "phone"), "{f:?}");
        assert!(!f.iter().any(|x| x.text == "Wohnen" || x.text == "Haus" || x.text == "Wohnhaus" || x.text == "Annahme"), "{f:?}");
        // ganze Wörter: „Annahme" enthält „Anna" nicht als Wort, „AG Raum" meldet die Phrase AG (≥ 3? nein, 2 Zeichen)
        assert!(!f.iter().any(|x| x.text == "AG Raum"), "{f:?}");
        // Die Phrase „Anna" (4 Zeichen, ≥ 3) trifft das ganze Wort in Raum „Anna".
        assert!(f.iter().any(|x| x.text == "Anna" && x.kind == "identifier"), "{f:?}");
    }

    #[test]
    fn umlaute_und_trenner_tolerant() {
        let r = serde_json::json!({ "name": "Müller-Schöni", "rooms": [{ "name": "Mueller Schoeni Studio" }, { "name": "MULLER/SCHONI" }] });
        let f = find(&r, &CheckInput::default());
        assert_eq!(f.iter().filter(|x| x.area == "rooms").count(), 2, "{f:?}");
    }

    #[test]
    fn leeres_oder_kaputtes_projekt_ist_sauber() {
        assert!(find(&Value::Null, &CheckInput::default()).is_empty());
        assert!(find(&serde_json::json!({}), &CheckInput::default()).is_empty());
    }
}
