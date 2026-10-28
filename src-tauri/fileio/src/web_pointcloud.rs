// WASM-Bindung des Punktwolken-Lesers (`pointcloud*.rs`): Bytes rein, flache typisierte Puffer raus.
// TS-Seite: `src/io/pointCloud.ts` (Web-Worker `pointCloud.worker.ts`). Kaputte Dateien → JS-Fehler
// mit Meldung (kein Panic).

use wasm_bindgen::prelude::*;

use crate::pointcloud::{read_point_cloud as read, Options, PointCloud};

/// Ergebnis; die Getter geben die Puffer je einmal heraus (danach leer), damit nichts kopiert wird.
#[wasm_bindgen]
pub struct PointCloudResult {
    cloud: PointCloud,
    report: String,
}

#[wasm_bindgen]
impl PointCloudResult {
    /// Ursprung (Dateikoordinaten, ganze Meter): absolut = origin + xyz.
    pub fn origin(&self) -> Vec<f64> {
        self.cloud.origin.to_vec()
    }
    /// x,y,z je Punkt, relativ zum Ursprung.
    pub fn xyz(&mut self) -> Vec<f32> {
        std::mem::take(&mut self.cloud.xyz)
    }
    /// r,g,b (8 Bit) je Punkt; leer ohne Farbe.
    pub fn rgb(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.cloud.rgb)
    }
    /// Intensität (u16) je Punkt; leer ohne Intensität.
    pub fn intensity(&mut self) -> Vec<u16> {
        std::mem::take(&mut self.cloud.intensity)
    }
    /// Klassifikationscode je Punkt; leer ohne Klassifikation.
    pub fn classification(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.cloud.classification)
    }
    /// Bericht (`PointReport`) als JSON.
    pub fn report_json(&self) -> String {
        self.report.clone()
    }
}

/// Punktwolke lesen (LAS/LAZ/E57/PLY/XYZ/PTS, erkannt am Inhalt) und ausdünnen.
/// `voxel` in m (0 = aus), `max_points` (0 = unbegrenzt); NaN/negativ zählen als 0.
#[wasm_bindgen]
pub fn read_point_cloud(bytes: Vec<u8>, name: &str, voxel: f64, max_points: f64) -> Result<PointCloudResult, JsValue> {
    let opts = Options {
        voxel: if voxel.is_finite() && voxel > 0.0 { voxel } else { 0.0 },
        max_points: if max_points.is_finite() && max_points >= 1.0 { max_points.min(4.0e9) as usize } else { 0 },
    };
    let (cloud, report) = read(&bytes, name, opts).map_err(|e| JsValue::from_str(&e))?;
    let report = serde_json::to_string(&report).map_err(|e| JsValue::from_str(&e.to_string()))?;
    Ok(PointCloudResult { cloud, report })
}
