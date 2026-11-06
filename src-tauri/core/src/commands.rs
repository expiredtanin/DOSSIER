//! Befehle und Werkzeuge im Kern ([K4] S3): die Zustandsautomaten der Befehle (Eingaben, Optionen,
//! Tasten) bleiben in der TS-Hülle; was aus dem Projekt Geometrie oder Ops rechnet, steht hier.
//! Eine Anfrage (`cmd` + Argumente, JSON) ergibt Ops (`cmdOps`, Wurzel-Abfrage; `doc_cmd_commit` rechnet
//! und wendet im selben Aufruf an) bzw. Vorschau-Formen (`doc_cmd_preview`). Module: `cmd_transform`
//! (Verschieben/Drehen/Spiegeln/Skalieren/Reihe, Ausrichten/Verteilen, Block definieren).

use crate::grips::{result_json, GripResult};
use crate::model::Project;
use crate::ops::Op;
use serde_json::{Map, Value};

fn parse<T: serde::de::DeserializeOwned>(v: &Value, what: &str) -> Result<T, String> {
    serde_json::from_value(v.clone()).map_err(|e| format!("{what}: {e}"))
}

/// Ops eines Befehls (`text` = JSON `{cmd, …}`, Zahlen dürfen Nicht-endlich-Marken sein). `p` = typisierte
/// Sicht derselben Wurzel (Lesen, [124]); geänderte Elemente entstehen verlustfrei aus `root`.
pub fn ops(root: &Map<String, Value>, p: &Project, text: &str) -> Result<Vec<Op>, String> {
    let v: Value = serde_json::from_str(text).map_err(|e| format!("cmdOps: {e}"))?;
    // Zeichnen in einer betretenen Gruppe: neue Elemente werden ihr Mitglied (`cmd_create::group_ops`).
    if let Some(group) = v.get("group").and_then(Value::as_str) {
        let mut inner = v.clone();
        inner.as_object_mut().map(|m| m.remove("group"));
        let mut out = ops(root, p, &inner.to_string())?;
        let extra = crate::cmd_create::group_ops(root, &out, group);
        out.extend(extra);
        return Ok(out);
    }
    let cmd = v.get("cmd").and_then(Value::as_str).unwrap_or("");
    let ids = |k: &str| -> Vec<String> { v.get(k).and_then(|x| serde_json::from_value(x.clone()).ok()).unwrap_or_default() };
    let s = |k: &str| v.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    if let Some(ops) = crate::cmd_edit::ops(root, p, &v) {
        return Ok(ops);
    }
    if let Some(ops) = crate::cmd_create::ops(root, p, &v) {
        return Ok(ops);
    }
    Ok(match cmd {
        "transform" => crate::cmd_transform::transform_ops(root, p, &parse(&v, cmd)?),
        "align" => crate::cmd_transform::align_ops(root, &ids("ids"), &s("mode")),
        "distribute" => crate::cmd_transform::distribute_ops(root, &ids("ids"), &s("axis")),
        "defblock" => crate::cmd_transform::defblock_ops(root, &parse(&v, cmd)?),
        "paste" => crate::cmd_paste::paste_ops(v.get("clip").unwrap_or(&Value::Null), &s("levelId"), &s("stamp")),
        "split" => crate::cmd_split::split_ops(root, &ids("ids"), &s("stamp")),
        "cutSegment" => crate::cmd_split::cut_segment_ops(root, &s("id"), crate::cmd_split::point_arg(&v, "at")),
        other => return Err(format!("Unbekannter Befehl: {other}")),
    })
}

/// Wie [`ops`], mit Hinweis-Schlüssel (i18n) für die Hülle; bisher nur Verschieben ([144]: Öffnung an
/// der Nachbaröffnung angehalten).
pub fn result(root: &Map<String, Value>, p: &Project, text: &str) -> Result<GripResult, String> {
    let v: Value = serde_json::from_str(text).map_err(|e| format!("cmdOps: {e}"))?;
    if v.get("group").is_none() && v.get("cmd").and_then(Value::as_str) == Some("transform") {
        return Ok(crate::cmd_transform::transform_result(root, p, &parse(&v, "transform")?));
    }
    Ok(GripResult { ops: ops(root, p, text)?, notice: None })
}

/// Wie [`result`], als Antwort-JSON `{"ops": […], "notice": …}` (Zahlen mit Nicht-endlich-Marken).
pub fn ops_json(root: &Map<String, Value>, p: &Project, text: &str) -> Result<String, String> {
    Ok(result_json(&result(root, p, text)?))
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
