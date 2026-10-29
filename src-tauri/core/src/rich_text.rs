//! Bearbeiten von Rich-Text-Dokumenten ([K4]): Marks setzen/umschalten, Bereichs-Abfragen, Normalisieren,
//! stabile Serialisierung, Stile anwenden. Hervorgegangen aus `src/text/richText.ts` (dort bleiben
//! Konstruktoren, Reintext und die Standard-Stile; die Editor-Operationen sind Fassaden über dieses Modul).
//!
//! Adressierung wie in TS: linearer Offset in UTF-16-Einheiten über alle Absätze, jeder Absatzumbruch
//! zählt als ein Zeichen. Teilt ein Bereich ein Surrogatpaar, ersetzt Rust die Hälften durch U+FFFD
//! (TS behielte sie als einzelne Surrogate) — im Editor nicht erreichbar.

use serde_json::Value;

use crate::model::{Align, Marks, Paragraph, RichTextDoc, TextRun, TextStylePreset};

/// Namen der Marks in fester Reihenfolge (`MARK_KEYS` in TS).
pub const MARK_KEYS: [&str; 9] = ["bold", "italic", "underline", "strike", "super", "sub", "font", "sizePt", "color"];

fn utf16_len(s: &str) -> i64 {
    s.encode_utf16().count() as i64
}

/// Teilstring nach UTF-16-Einheiten `[a, b)`.
fn slice16(s: &str, a: i64, b: i64) -> String {
    let u: Vec<u16> = s.encode_utf16().collect();
    String::from_utf16_lossy(&u[(a.max(0) as usize).min(u.len())..(b.max(0) as usize).min(u.len())])
}

/// Entfernt „falsy"/leere Einträge und alles ausser den bekannten Marks.
pub fn normalize_marks(m: &Marks) -> Marks {
    let b = |v: Option<bool>| if v == Some(true) { Some(true) } else { None };
    let s = |v: &Option<String>| v.clone().filter(|x| !x.is_empty());
    Marks {
        bold: b(m.bold),
        italic: b(m.italic),
        underline: b(m.underline),
        strike: b(m.strike),
        super_: b(m.super_),
        sub: b(m.sub),
        font: s(&m.font),
        size_pt: m.size_pt,
        color: s(&m.color),
        ..Default::default()
    }
}

/// Führt benachbarte Runs mit gleichen Marks zusammen und entfernt leere Runs (idempotent).
pub fn normalize_doc(doc: &RichTextDoc) -> RichTextDoc {
    let mut paragraphs: Vec<Paragraph> = doc
        .paragraphs
        .iter()
        .map(|p| {
            let mut merged: Vec<TextRun> = Vec::new();
            for run in &p.runs {
                if run.text.is_empty() {
                    continue;
                }
                let marks = normalize_marks(&run.marks);
                match merged.last_mut() {
                    Some(last) if last.marks == marks => last.text.push_str(&run.text),
                    _ => merged.push(TextRun { text: run.text.clone(), marks, ..Default::default() }),
                }
            }
            Paragraph { runs: merged, align: p.align.filter(|a| *a != Align::Left), ..Default::default() }
        })
        .collect();
    if paragraphs.is_empty() {
        paragraphs.push(Paragraph::default());
    }
    RichTextDoc { version: 1.0, paragraphs, ..Default::default() }
}

fn range(start: f64, end: f64) -> (i64, i64) {
    let (a, b) = (if start.is_nan() { 0.0 } else { start }, if end.is_nan() { 0.0 } else { end });
    (a.min(b).max(0.0) as i64, a.max(b) as i64)
}

/// Läufer über alle Runs im Bereich: `f(absatz, run_index, von, bis)` mit Offsets relativ zum Run (UTF-16).
fn runs_in_range(doc: &RichTextDoc, start: i64, end: i64, mut f: impl FnMut(usize, usize, i64, i64) -> bool) {
    let mut cursor = 0;
    for (pi, p) in doc.paragraphs.iter().enumerate() {
        let len: i64 = p.runs.iter().map(|r| utf16_len(&r.text)).sum();
        let (ps, pe) = (cursor, cursor + len);
        cursor += len + 1;
        if pe <= start || ps >= end {
            continue;
        }
        let mut rs = ps;
        for (ri, run) in p.runs.iter().enumerate() {
            let re = rs + utf16_len(&run.text);
            let (a, b) = (start.max(rs), end.min(re));
            if b > a && !f(pi, ri, a - rs, b - rs) {
                return;
            }
            rs = re;
        }
    }
}

fn truthy(m: &Marks, mark: &str) -> bool {
    match mark {
        "bold" => m.bold == Some(true),
        "italic" => m.italic == Some(true),
        "underline" => m.underline == Some(true),
        "strike" => m.strike == Some(true),
        "super" => m.super_ == Some(true),
        "sub" => m.sub == Some(true),
        _ => false,
    }
}

/// Wert einer Mark als JSON (`None` = nicht gesetzt).
fn mark_value(m: &Marks, mark: &str) -> Option<Value> {
    match mark {
        "bold" => m.bold.map(Value::Bool),
        "italic" => m.italic.map(Value::Bool),
        "underline" => m.underline.map(Value::Bool),
        "strike" => m.strike.map(Value::Bool),
        "super" => m.super_.map(Value::Bool),
        "sub" => m.sub.map(Value::Bool),
        "font" => m.font.clone().map(Value::String),
        "sizePt" => m.size_pt.and_then(|n| serde_json::Number::from_f64(n)).map(Value::Number),
        "color" => m.color.clone().map(Value::String),
        _ => None,
    }
}

fn clear_mark(m: &mut Marks, mark: &str) {
    match mark {
        "bold" => m.bold = None,
        "italic" => m.italic = None,
        "underline" => m.underline = None,
        "strike" => m.strike = None,
        "super" => m.super_ = None,
        "sub" => m.sub = None,
        "font" => m.font = None,
        "sizePt" => m.size_pt = None,
        "color" => m.color = None,
        _ => {}
    }
}

fn set_mark(m: &mut Marks, mark: &str, v: &Value) {
    let b = || Some(!matches!(v, Value::Null | Value::Bool(false)));
    match mark {
        "bold" => m.bold = b(),
        "italic" => m.italic = b(),
        "underline" => m.underline = b(),
        "strike" => m.strike = b(),
        "super" => {
            m.super_ = b();
            m.sub = None;
        }
        "sub" => {
            m.sub = b();
            m.super_ = None;
        }
        "font" => m.font = v.as_str().map(String::from).or(m.font.take()),
        "sizePt" => m.size_pt = v.as_f64().or(m.size_pt),
        "color" => m.color = v.as_str().map(String::from).or(m.color.take()),
        _ => {}
    }
}

/// Setzt ein Mark auf den Bereich (`Null`/`false` entfernt es); super/sub bleiben exklusiv.
pub fn apply_mark(doc: &RichTextDoc, start: f64, end: f64, mark: &str, value: &Value) -> RichTextDoc {
    let (s, e) = range(start, end);
    if s == e {
        return normalize_doc(doc);
    }
    let mut out = doc.clone();
    // Von hinten nach vorn je Absatz, damit das Aufteilen die Run-Indizes davor nicht verschiebt.
    let mut hits: Vec<(usize, usize, i64, i64)> = Vec::new();
    runs_in_range(doc, s, e, |pi, ri, a, b| {
        hits.push((pi, ri, a, b));
        true
    });
    for (pi, ri, a, b) in hits.into_iter().rev() {
        let run = out.paragraphs[pi].runs[ri].clone();
        let len = utf16_len(&run.text);
        let mut mid = run.marks.clone();
        if matches!(value, Value::Null | Value::Bool(false)) {
            clear_mark(&mut mid, mark);
        } else {
            set_mark(&mut mid, mark, value);
        }
        let mut parts: Vec<TextRun> = Vec::new();
        if a > 0 {
            parts.push(TextRun { text: slice16(&run.text, 0, a), marks: run.marks.clone(), ..Default::default() });
        }
        parts.push(TextRun { text: slice16(&run.text, a, b), marks: mid, ..Default::default() });
        if b < len {
            parts.push(TextRun { text: slice16(&run.text, b, len), marks: run.marks.clone(), ..Default::default() });
        }
        out.paragraphs[pi].runs.splice(ri..=ri, parts);
    }
    normalize_doc(&out)
}

/// Ist ein boolesches Mark über den GESAMTEN Bereich aktiv?
pub fn is_mark_active(doc: &RichTextDoc, start: f64, end: f64, mark: &str) -> bool {
    let (s, e) = range(start, end);
    if s == e {
        return false;
    }
    let (mut saw, mut all) = (false, true);
    runs_in_range(doc, s, e, |pi, ri, _, _| {
        saw = true;
        if !truthy(&doc.paragraphs[pi].runs[ri].marks, mark) {
            all = false;
            return false;
        }
        true
    });
    saw && all
}

/// Schaltet ein boolesches Mark über den Bereich um: überall aktiv → entfernen, sonst überall setzen.
pub fn toggle_mark(doc: &RichTextDoc, start: f64, end: f64, mark: &str) -> RichTextDoc {
    let active = is_mark_active(doc, start, end, mark);
    apply_mark(doc, start, end, mark, &if active { Value::Null } else { Value::Bool(true) })
}

/// Gemeinsamer Wert eines Marks über den Bereich; `None` = uneinheitlich, leer oder nicht gesetzt.
pub fn common_mark_value(doc: &RichTextDoc, start: f64, end: f64, mark: &str) -> Option<Value> {
    let (s, e) = range(start, end);
    if s == e {
        return None;
    }
    let mut value: Option<Value> = None;
    let mut first = true;
    let mut mixed = false;
    runs_in_range(doc, s, e, |pi, ri, _, _| {
        let v = mark_value(&doc.paragraphs[pi].runs[ri].marks, mark);
        if first {
            value = v;
            first = false;
        } else if v != value {
            mixed = true;
            return false;
        }
        true
    });
    if mixed { None } else { value }
}

/// `JSON.stringify`-gleiche Zahlen: ganzzahlige `f64` ohne ".0".
fn int_numbers(v: Value) -> Value {
    match v {
        Value::Number(n) => match n.as_f64() {
            Some(f) if n.is_f64() && f.fract() == 0.0 && f.abs() < 1e15 => Value::Number((f as i64).into()),
            _ => Value::Number(n),
        },
        Value::Array(a) => Value::Array(a.into_iter().map(int_numbers).collect()),
        Value::Object(o) => Value::Object(o.into_iter().map(|(k, v)| (k, int_numbers(v))).collect()),
        o => o,
    }
}

/// Stabile JSON-Serialisierung (Schlüssel in fester Reihenfolge, normalisiert).
pub fn serialize(doc: &RichTextDoc) -> String {
    let n = normalize_doc(doc);
    let paragraphs: Vec<Value> = n
        .paragraphs
        .iter()
        .map(|p| {
            let runs: Vec<Value> = p
                .runs
                .iter()
                .map(|r| {
                    let mut marks = serde_json::Map::new();
                    for k in MARK_KEYS {
                        if let Some(v) = mark_value(&r.marks, k) {
                            marks.insert(k.into(), v);
                        }
                    }
                    serde_json::json!({ "text": r.text, "marks": marks })
                })
                .collect();
            let mut o = serde_json::Map::new();
            o.insert("runs".into(), Value::Array(runs));
            if let Some(a) = p.align {
                o.insert("align".into(), serde_json::to_value(a).unwrap_or(Value::Null));
            }
            Value::Object(o)
        })
        .collect();
    int_numbers(serde_json::json!({ "version": 1, "paragraphs": paragraphs })).to_string()
}

/// Wendet einen Stil auf den Bereich an (setzt jede Mark des Stils); ein leerer Bereich gilt für das ganze Dokument.
pub fn apply_preset(doc: &RichTextDoc, start: f64, end: f64, preset: &TextStylePreset) -> RichTextDoc {
    let (s, e) = range(start, end);
    let (s, e) = if s == e {
        let len: i64 = doc.paragraphs.iter().map(|p| p.runs.iter().map(|r| utf16_len(&r.text)).sum::<i64>()).sum::<i64>() + doc.paragraphs.len().saturating_sub(1) as i64;
        (0, len.max(1))
    } else {
        (s, e)
    };
    let mut out = doc.clone();
    for k in MARK_KEYS {
        if let Some(v) = mark_value(&preset.marks, k) {
            out = apply_mark(&out, s as f64, e as f64, k, &v);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn doc(v: Value) -> RichTextDoc {
        serde_json::from_value(v).unwrap()
    }
    fn sample() -> RichTextDoc {
        doc(json!({ "version": 1, "paragraphs": [
            { "runs": [{ "text": "Hallo ", "marks": {} }, { "text": "Welt", "marks": { "bold": true } }] },
            { "runs": [{ "text": "Zwei", "marks": { "sizePt": 12 } }], "align": "center" }
        ]}))
    }

    #[test]
    fn toggle_ueber_absatzgrenze() {
        let d = sample();
        let t = toggle_mark(&d, 3.0, 12.0, "italic");
        assert!(is_mark_active(&t, 3.0, 12.0, "italic"));
        assert!(!is_mark_active(&t, 0.0, 12.0, "italic"));
        assert_eq!(t.paragraphs[0].runs.len(), 3); // "Hal" | "lo " kursiv | "Welt" fett+kursiv
        assert_eq!(t.paragraphs[1].runs[0].text, "Z");
        let back = toggle_mark(&t, 3.0, 12.0, "italic");
        assert_eq!(serialize(&back), serialize(&d));
    }

    #[test]
    fn sub_super_exklusiv_und_gemeinsame_werte() {
        let d = apply_mark(&sample(), 0.0, 4.0, "super", &json!(true));
        let d = apply_mark(&d, 0.0, 2.0, "sub", &json!(true));
        assert!(!is_mark_active(&d, 0.0, 2.0, "super"));
        assert!(is_mark_active(&d, 2.0, 4.0, "super"));
        assert_eq!(common_mark_value(&sample(), 8.0, 14.0, "sizePt"), None);
        assert_eq!(common_mark_value(&sample(), 11.0, 14.0, "sizePt"), Some(json!(12.0)));
    }

    #[test]
    fn serialisierung_stabil_und_leerer_bereich_stil() {
        assert!(serialize(&sample()).starts_with("{\"version\":1,\"paragraphs\":[{\"runs\":[{\"text\":\"Hallo \",\"marks\":{}}"));
        assert!(serialize(&sample()).contains("\"sizePt\":12}"));
        let p: TextStylePreset = serde_json::from_value(json!({ "id": "t", "label": "T", "marks": { "bold": true, "sizePt": 18 } })).unwrap();
        let d = apply_preset(&sample(), 2.0, 2.0, &p);
        assert!(is_mark_active(&d, 0.0, 11.0, "bold"));
        assert_eq!(common_mark_value(&d, 0.0, 11.0, "sizePt"), Some(json!(18.0)));
    }
}
