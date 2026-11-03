//! Lese- und Bau-Hilfen für den rohen JSON-Baum des Projekts ([124], vorher in `grips.rs`): Felder
//! lesen, Zahlen wie JS (`null` = 0, Nicht-endlich-Marken), Wahrheitswerte, Punkte, Objekt-Spreizen
//! (`{...v, key: val}`) und Anfrage-Zahlen ([`N`]).
//!
//! Neuer Kern-Code liest das Projekt typisiert (`&Project`, `model`); diese Hilfen bleiben für Werte,
//! die verlustfrei durchgereicht werden müssen (unbekannte Felder, Schlüsselreihenfolge) und für
//! Anfragen der Hülle.

use serde_json::{Map, Value};

/// Feld `k` eines Objekts. Kleine Objekte (Punkte, Elemente) werden linear durchsucht: das ist deutlich
/// billiger als der Hash (SipHash) der `IndexMap` je Zugriff — die Griff- und Objekt-Info-Rechnung liest
/// Dutzende Felder je Aufruf.
#[inline]
pub fn field<'a>(v: &'a Value, k: &str) -> Option<&'a Value> {
    match v {
        Value::Object(m) if m.len() <= 32 => m.iter().find(|(kk, _)| kk.as_str() == k).map(|(_, x)| x),
        Value::Object(m) => m.get(k),
        _ => None,
    }
}

/// Zahl als JSON-Wert wie nach `JSON.stringify` → `serde_json`: ganze Zahlen als Ganzzahl, sonst f64;
/// NaN/±∞ als Marke (`"\u{1}NaN"` …), −0 als 0.
pub fn js_num(x: f64) -> Value {
    if x.is_nan() {
        return Value::String("\u{1}NaN".into());
    }
    if x.is_infinite() {
        return Value::String(if x > 0.0 { "\u{1}Infinity" } else { "\u{1}-Infinity" }.into());
    }
    if x.fract() == 0.0 {
        if (0.0..18446744073709551616.0).contains(&x) {
            return Value::from(x as u64);
        }
        if x < 0.0 && x >= -9223372036854775808.0 {
            return Value::from(x as i64);
        }
    }
    Value::from(x)
}

/// Zahl eines JSON-Werts wie in JS-Arithmetik auf der Leseansicht: Zahl, Nicht-endlich-Marke, `null` = 0
/// (so rechnet JS mit `null`; das Dokument speichert ein tief liegendes NaN als `null`, eine geladene
/// Datei liest es so zurück); fehlend und alles andere NaN.
pub fn num_of(v: Option<&Value>) -> f64 {
    match v {
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::Null) => 0.0,
        Some(m) => match crate::ops::non_finite_mark(m) {
            Some("Infinity") => f64::INFINITY,
            Some("-Infinity") => f64::NEG_INFINITY,
            _ => f64::NAN,
        },
        None => f64::NAN,
    }
}

/// `a ?? b` für Zahlen (fehlend/`null` → `b`).
pub fn num_or(v: Option<&Value>, b: f64) -> f64 {
    match v {
        None | Some(Value::Null) => b,
        v => num_of(v),
    }
}

/// JS-Wahrheitswert.
pub fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// Punkt `{x, y}` (wie ein neues Objekt-Literal in TS).
pub fn pt(x: f64, y: f64) -> Value {
    let mut m = Map::new();
    m.insert("x".into(), js_num(x));
    m.insert("y".into(), js_num(y));
    Value::Object(m)
}

/// `(x, y)` eines Punkt-Werts (fehlende Koordinaten NaN).
pub fn xy(v: &Value) -> (f64, f64) {
    (num_of(field(v, "x")), num_of(field(v, "y")))
}

/// `{...v, key: val}` (vorhandener Schlüssel behält seine Stelle). Der ersetzte Wert wird nicht kopiert
/// (eine grosse Polylinie kostet sonst je Mausschritt eine Kopie mehr).
pub fn with(v: &Value, key: &str, val: Value) -> Value {
    with_all(v, vec![(key, val)])
}

/// Wie [`with`] für mehrere Felder in einem Durchgang (`{...v, a, b}`).
pub fn with_all(v: &Value, fields: Vec<(&str, Value)>) -> Value {
    with_opt(v, fields.into_iter().map(|(k, x)| (k, Some(x))).collect())
}

/// Wie [`with_all`]; `None` = `undefined` (das Feld fällt weg, wie in JSON).
pub fn with_opt(v: &Value, fields: Vec<(&str, Option<Value>)>) -> Value {
    let mut fields: Vec<(&str, Option<Value>, bool)> = fields.into_iter().map(|(k, x)| (k, x, false)).collect();
    let src = v.as_object();
    let mut m = Map::with_capacity(src.map_or(0, Map::len) + fields.len());
    for (k, x) in src.into_iter().flatten() {
        match fields.iter_mut().find(|(f, _, _)| *f == k) {
            Some((_, new, done)) => {
                *done = true;
                if let Some(n) = new.take() {
                    m.insert(k.clone(), n);
                }
            }
            None => {
                m.insert(k.clone(), x.clone());
            }
        }
    }
    for (k, x, done) in fields {
        if let (false, Some(x)) = (done, x) {
            m.insert(k.into(), x);
        }
    }
    Value::Object(m)
}

pub fn arr(v: Option<&Value>) -> &[Value] {
    v.and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])
}

/// Zahl der Anfrage: Zahl oder Nicht-endlich-Marke, `null` = 0 (wie `num_of`), fehlend = NaN.
#[derive(Clone, Copy, Debug)]
pub struct N(pub f64);

impl Default for N {
    fn default() -> Self {
        N(f64::NAN)
    }
}

impl<'de> serde::Deserialize<'de> for N {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl serde::de::Visitor<'_> for V {
            type Value = N;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("Zahl")
            }
            fn visit_f64<E>(self, v: f64) -> Result<N, E> {
                Ok(N(v))
            }
            fn visit_i64<E>(self, v: i64) -> Result<N, E> {
                Ok(N(v as f64))
            }
            fn visit_u64<E>(self, v: u64) -> Result<N, E> {
                Ok(N(v as f64))
            }
            fn visit_str<E>(self, v: &str) -> Result<N, E> {
                Ok(N(num_of(Some(&Value::String(v.to_owned())))))
            }
            fn visit_unit<E>(self) -> Result<N, E> {
                Ok(N(0.0))
            }
            fn visit_bool<E>(self, _: bool) -> Result<N, E> {
                Ok(N(f64::NAN))
            }
        }
        d.deserialize_any(V)
    }
}
