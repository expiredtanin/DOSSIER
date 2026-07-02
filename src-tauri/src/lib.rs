// Tauri-v2-Einstieg. Die eigentliche Geometrie liegt im serde-only Crate
// `geometry`; hier nur die Befehls-Bruecke und der App-Start.

// M2: native wgpu-Viewports (2D und/oder 3D) im Tauri-Prozess. EIN Modul, EINE
// winit-Event-Loop fuer beide Fenster (winit erlaubt nur eine Loop pro Prozess).
#[cfg(any(feature = "native2d", feature = "native3d"))]
mod native;

/// Berechnet die Wand-Gehrungen im Rust-Kern und liefert sie ans Frontend.
#[tauri::command]
async fn compute_joins(
    input: geometry::JoinInput,
) -> Result<Vec<geometry::WallCuts>, String> {
    Ok(geometry::compute_joins(input))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|_app| {
            // Native GPU-Fenster (2D und/oder 3D je nach Feature) auf einem eigenen
            // Thread hochfahren, damit der Tauri-/GTK-Hauptthread frei bleibt.
            #[cfg(any(feature = "native2d", feature = "native3d"))]
            native::spawn();
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![compute_joins])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
