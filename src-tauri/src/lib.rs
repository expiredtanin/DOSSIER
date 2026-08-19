// Tauri-v2-Einstieg: die Befehls-Bruecke und der App-Start.

// M2: native wgpu-Viewports (2D und/oder 3D) im Tauri-Prozess. EIN Modul, EINE
// winit-Event-Loop fuer beide Fenster (winit erlaubt nur eine Loop pro Prozess).
#[cfg(any(feature = "native2d", feature = "native3d"))]
mod native;

// Lock-Datei gegen gleichzeitiges Oeffnen derselben Projektdatei aus zwei
// App-Instanzen (OS-Advisory-Lock via `fs4`, siehe lock.rs).
mod lock;

use std::path::PathBuf;
use tauri::State;

/// Fordert den exklusiven Lock fuer eine Projektdatei an. `Ok(())` wenn frei
/// (oder schon von uns gehalten), sonst `Err(Some(LockInfo))` mit Angaben zur
/// haltenden Instanz (pid/hostname/timestamp), oder `Err(None)` falls die
/// Sidecar-Datei gesperrt, aber ihr Info-Block nicht lesbar war.
#[tauri::command]
fn acquire_project_lock(
    path: String,
    state: State<lock::LockState>,
) -> Result<(), Option<lock::LockInfo>> {
    lock::acquire(&state, &PathBuf::from(path))
}

/// Gibt einen von dieser Instanz gehaltenen Lock frei. No-op, wenn der Pfad
/// nicht gelockt war.
#[tauri::command]
fn release_project_lock(path: String, state: State<lock::LockState>) {
    lock::release(&state, &PathBuf::from(path));
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
    let builder = tauri::Builder::default()
        // Native „Speichern unter"-Dialog + Datei-Schreiben aus der Webview.
        // Immer aktiv (unabhaengig von native2d/native3d), damit Datei-Exporte
        // im Tauri-Fenster einen echten Save-Dialog zeigen statt still zu laden.
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        // Selbst-Update: prueft beim Start gegen `endpoints` aus tauri.conf.json
        // (Gitea-Release-Asset `latest.json`), Installation via JS-Seite
        // (@tauri-apps/plugin-updater). `tauri_plugin_process` liefert `relaunch()`
        // fuer den Neustart nach der Installation.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        // HTTP-Requests aus der Webview (Versionsverlauf, versions.json vom
        // selben Gitea-Release) ohne Browser-CORS-Einschraenkung; Shell: oeffnet
        // den DMG-Download einer aelteren Version im System-Browser (Rollback,
        // s. src/update/checkForUpdate.ts).
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_shell::init())
        // Haelt die pro Instanz offen gelockten Projektdatei-Handles (lock.rs).
        .manage(lock::LockState::default())
        .setup(|_app| {
        // Native GPU-Fenster (2D und/oder 3D je nach Feature) auf einem eigenen
        // Thread hochfahren, damit der Tauri-/GTK-Hauptthread frei bleibt.
        #[cfg(any(feature = "native2d", feature = "native3d"))]
        native::spawn();
        Ok(())
    });

    #[cfg(any(feature = "native2d", feature = "native3d"))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        push_native_scene,
        push_native_walls,
        acquire_project_lock,
        release_project_lock
    ]);
    #[cfg(not(any(feature = "native2d", feature = "native3d")))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        acquire_project_lock,
        release_project_lock
    ]);

    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
