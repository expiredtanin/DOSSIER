//! Bindungen der Griff-Geometrie (`crate::grips`): Griff-Änderung im Dokument rechnen und gleich als
//! Benutzer-Änderung anwenden (ein Aufruf je Mausschritt, keine Op-Übergabe hin und zurück), Griff-
//! und Kanten-Listen für die Anzeige als flache Puffer.

use super::document::with_doc;
use serde_json::{json, Value};
use wasm_bindgen::prelude::wasm_bindgen;

/// Griff-Änderung `req_json` (s. `crate::grips::run`) auf dem Dokument `h` rechnen und mit Verlauf
/// anwenden (`key` = coalesceKey, `now_ms` = Zeit für das Koaleszenz-Fenster, wie `doc_commit`).
/// Antwort: `{"ops":[…],"notice":…}` (angewendet; leer = nichts zu tun) oder `{"problems":[…]}`
/// (zurückgewiesen, Dokument unverändert); Fehler als Text mit vorangestelltem `\u{1}`.
#[wasm_bindgen]
pub fn doc_grip_commit(h: u32, req_json: &str, key: &str, now_ms: f64) -> String {
    let req: crate::grips::Request = match serde_json::from_str(req_json) {
        Ok(v) => v,
        Err(e) => return format!("\u{1}Griff-Anfrage: {e}"),
    };
    let key = (!key.is_empty()).then_some(key);
    let now = if now_ms.is_finite() { now_ms } else { 0.0 };
    let out = with_doc(h, |d| -> Result<String, String> {
        let res = crate::grips::run(d.root(), &req)?;
        let text = crate::grips::result_json(&res);
        if res.ops.is_empty() {
            return Ok(text);
        }
        // Nicht endliche Ergebnisse stehen als Marken in den Ops (die Prüfung weist sie zurück).
        let marks = text.contains("\\u0001");
        match d.commit(res.ops, key, now, marks) {
            Ok(()) => Ok(text),
            Err(problems) => Ok(json!({ "problems": problems }).to_string()),
        }
    });
    match out {
        Some(Ok(t)) => t,
        Some(Err(e)) => format!("\u{1}{e}"),
        None => "\u{1}Dokument nicht offen".to_string(),
    }
}

/// Editier-Griffe einer 2D-Zeichnung (JSON) beim Massstab 1:`scale`: `[n, x0, y0, …]`; `[-1]` = Textspalte
/// (Rahmen-Ecken rechnet die Hülle mit der Schrift-Metrik), `[]` bei kaputtem JSON.
#[wasm_bindgen]
pub fn grip_vertices(drawing_json: &str, scale: f64) -> Vec<f64> {
    let Ok(d) = serde_json::from_str::<Value>(drawing_json) else { return vec![] };
    let g = d.get("geom").unwrap_or(&d);
    match crate::grips::drawing_vertices(g, scale) {
        None => vec![-1.0],
        Some(v) => {
            let mut out = Vec::with_capacity(1 + 2 * v.len());
            out.push(v.len() as f64);
            for p in v {
                out.push(p.0);
                out.push(p.1);
            }
            out
        }
    }
}

/// Editier-Griffe einer Polylinie aus flachen Puffern (grosse Kataster-Umrisse ohne JSON): `pts = [x0, y0, …]`,
/// `bulge` je Segment (fehlend/NaN = gerade) → `[x0, y0, …]` (Eckpunkte, dann je Segment die Bogen-Mitte).
#[wasm_bindgen]
pub fn grip_vertices_polyline(pts: &[f64], bulge: &[f64], closed: bool) -> Vec<f64> {
    let verts: Vec<(f64, f64)> = pts.chunks_exact(2).map(|c| (c[0], c[1])).collect();
    crate::grips::polyline_vertices(verts, closed, |i| bulge.get(i).copied().unwrap_or(0.0)).into_iter().flat_map(|p| [p.0, p.1]).collect()
}

/// Kanten-Griffe eines Rings (`closed`) bzw. einer Kette aus `pts = [x0, y0, …]`; `bulge` je Segment
/// nur bei `use_bulge` (Polylinie: Bogen-Segmente ohne Kanten-Griff). Antwort je Kante
/// `[a, b, mitteX, mitteY, normaleX, normaleY]`.
#[wasm_bindgen]
pub fn edge_grips(pts: &[f64], closed: bool, bulge: &[f64], use_bulge: bool) -> Vec<f64> {
    let verts: Vec<(f64, f64)> = pts.chunks_exact(2).map(|c| (c[0], c[1])).collect();
    let edges = crate::grips::edge_grips(&verts, closed, use_bulge.then_some(bulge));
    let mut out = Vec::with_capacity(6 * edges.len());
    for (a, b, m, n) in edges {
        out.extend([a as f64, b as f64, m.0, m.1, n.0, n.1]);
    }
    out
}
