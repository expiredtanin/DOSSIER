// Tauri-v2-Einstieg. Die eigentliche Geometrie liegt im serde-only Crate
// `geometry`; hier nur die Befehls-Bruecke und der App-Start.

// M2-Spike: nativer wgpu-2D-Viewport im Tauri-Prozess (nur mit Feature `native2d`).
#[cfg(feature = "native2d")]
mod native2d;

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
            // Nur mit Feature `native2d`: das native GPU-Fenster auf einem eigenen
            // Thread hochfahren, damit der Tauri-/GTK-Hauptthread frei bleibt.
            #[cfg(feature = "native2d")]
            native2d::spawn();
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![compute_joins])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
