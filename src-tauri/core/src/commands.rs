//! Befehle und Werkzeuge im Kern ([K4] S3): die Zustandsautomaten der Befehle (Eingaben, Optionen,
//! Tasten) bleiben in der TS-Hülle; was aus dem Projekt Geometrie oder Ops rechnet, steht hier.
//! Eine Anfrage (`cmd` + Argumente, JSON) ergibt Ops (`cmdOps`, Wurzel-Abfrage; `doc_cmd_commit` rechnet
//! und wendet im selben Aufruf an) bzw. Vorschau-Formen (`doc_cmd_preview`). Module: `cmd_transform`
//! (Verschieben/Drehen/Spiegeln/Skalieren/Reihe, Ausrichten/Verteilen, Block definieren).

use crate::grips::{result_json, GripResult};
use crate::ops::Op;
use serde_json::{Map, Value};

fn parse<T: serde::de::DeserializeOwned>(v: &Value, what: &str) -> Result<T, String> {
    serde_json::from_value(v.clone()).map_err(|e| format!("{what}: {e}"))
}

/// Ops eines Befehls (`text` = JSON `{cmd, …}`, Zahlen dürfen Nicht-endlich-Marken sein).
pub fn ops(root: &Map<String, Value>, text: &str) -> Result<Vec<Op>, String> {
    let v: Value = serde_json::from_str(text).map_err(|e| format!("cmdOps: {e}"))?;
    let cmd = v.get("cmd").and_then(Value::as_str).unwrap_or("");
    let ids = |k: &str| -> Vec<String> { v.get(k).and_then(|x| serde_json::from_value(x.clone()).ok()).unwrap_or_default() };
    let s = |k: &str| v.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    if let Some(ops) = crate::cmd_edit::ops(root, &v) {
        return Ok(ops);
    }
    Ok(match cmd {
        "transform" => crate::cmd_transform::transform_ops(root, &parse(&v, cmd)?),
        "align" => crate::cmd_transform::align_ops(root, &ids("ids"), &s("mode")),
        "distribute" => crate::cmd_transform::distribute_ops(root, &ids("ids"), &s("axis")),
        "defblock" => crate::cmd_transform::defblock_ops(root, &parse(&v, cmd)?),
        "paste" => crate::cmd_paste::paste_ops(v.get("clip").unwrap_or(&Value::Null), &s("levelId"), &s("stamp")),
        other => return Err(format!("Unbekannter Befehl: {other}")),
    })
}

/// Wie [`ops`], als Antwort-JSON `{"ops": […]}` (Zahlen mit Nicht-endlich-Marken).
pub fn ops_json(root: &Map<String, Value>, text: &str) -> Result<String, String> {
    Ok(result_json(&GripResult { ops: ops(root, text)?, notice: None }))
}

/// Schneller Hasher für id-Mengen der Befehle (FNV-1a; je Mausschritt werden Tausende ids geprüft,
/// SipHash kostete dort den grössten Teil der Vorschau).
#[derive(Default)]
pub struct Fnv(u64);

impl std::hash::Hasher for Fnv {
    fn finish(&self) -> u64 {
        self.0
    }
    fn write(&mut self, bytes: &[u8]) {
        let mut h = if self.0 == 0 { 0xcbf2_9ce4_8422_2325 } else { self.0 };
        for b in bytes {
            h ^= *b as u64;
            h = h.wrapping_mul(0x0100_0000_01b3);
        }
        self.0 = h;
    }
}

/// Menge mit [`Fnv`].
pub type FastSet<T> = std::collections::HashSet<T, std::hash::BuildHasherDefault<Fnv>>;
