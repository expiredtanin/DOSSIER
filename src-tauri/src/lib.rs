// Tauri-v2-Einstieg. Die eigentliche Geometrie liegt im serde-only Crate
// `geometry`; hier nur die Befehls-Bruecke und der App-Start.

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
        .invoke_handler(tauri::generate_handler![compute_joins])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
