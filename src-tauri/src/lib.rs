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

// Live-Spiegelung: die Webview schiebt bei jeder Modellaenderung (debounced)
// die aktuelle 2D-Szene bzw. die 3D-Waende hierher; native.rs stellt sie ueber
// einen EventLoopProxy in die winit-Loop zu. Die Payload kommt als rohes JSON
// (`serde_json::Value`) an und wird erst in native.rs in die render2d-/render3d-
// Typen deserialisiert — so existieren beide Commands unter EINEM cfg, egal
// welche Feature-Kombination gebaut wird.
#[cfg(any(feature = "native2d", feature = "native3d"))]
#[tauri::command]
fn push_native_scene(scene: serde_json::Value) {
    #[cfg(feature = "native2d")]
    native::push_scene(scene);
    #[cfg(not(feature = "native2d"))]
    let _ = scene;
}

#[cfg(any(feature = "native2d", feature = "native3d"))]
#[tauri::command]
fn push_native_walls(walls: serde_json::Value) {
    #[cfg(feature = "native3d")]
    native::push_walls(walls);
    #[cfg(not(feature = "native3d"))]
    let _ = walls;
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default().setup(|_app| {
        // Native GPU-Fenster (2D und/oder 3D je nach Feature) auf einem eigenen
        // Thread hochfahren, damit der Tauri-/GTK-Hauptthread frei bleibt.
        #[cfg(any(feature = "native2d", feature = "native3d"))]
        native::spawn();
        Ok(())
    });

    #[cfg(any(feature = "native2d", feature = "native3d"))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        compute_joins,
        push_native_scene,
        push_native_walls
    ]);
    #[cfg(not(any(feature = "native2d", feature = "native3d")))]
    let builder = builder.invoke_handler(tauri::generate_handler![compute_joins]);

    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
