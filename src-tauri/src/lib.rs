// Tauri-v2-Einstieg: die Befehls-Bruecke und der App-Start.

// M2: native wgpu-Viewports (2D und/oder 3D) im Tauri-Prozess, ueber eine
// eigene winit-Event-Loop auf einem Hintergrund-Thread. NICHT auf macOS
// (winit verlangt dort den Hauptthread) — dort s. `native_tauri_window` (2D).
// `native3d` hat (noch) keinen macOS-Weg und ist dort ein No-op.
#[cfg(all(any(feature = "native2d", feature = "native3d"), not(target_os = "macos")))]
mod native;

// macOS-Pendant zu `native.rs` fuer den 2D-Viewport: ein ECHTES Tauri-Fenster
// als wgpu-Surface-Ziel statt einer zweiten Event-Loop (s. Modul-Kommentar
// dort — der naheliegende Ansatz, Tauris und winits Loop manuell zu
// verschraenken, wurde GETESTET und verworfen: dauerhaft ~100% CPU-Busy-Loop).
#[cfg(all(feature = "native2d", target_os = "macos"))]
mod native_tauri_window;

// Stufe 2 (macOS): native Metal-Flaeche als Kind-View im Hauptfenster, unter der
// transparenten Webview (s. Modul-Kommentar).
#[cfg(all(feature = "native2d", target_os = "macos"))]
mod native_embed;

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
// die aktuelle 2D-Szene bzw. die 3D-Waende hierher. Auf macOS (nur native2d)
// geht das direkt an `native_tauri_window` (Tauri-Fenster als Surface); sonst
// (Linux, oder native3d auf jeder Plattform) ueber `native.rs`s
// EventLoopProxy in die winit-Loop. Die Payload kommt als rohes JSON
// (`serde_json::Value`) an und wird erst dort in die render2d-/render3d-Typen
// deserialisiert — so existieren beide Commands unter EINEM cfg, egal welche
// Feature-Kombination gebaut wird.
#[cfg(any(feature = "native2d", feature = "native3d"))]
#[tauri::command]
fn push_native_scene(app: tauri::AppHandle, scene: serde_json::Value) {
    #[cfg(all(feature = "native2d", target_os = "macos"))]
    native_tauri_window::push_scene(&app, scene);
    #[cfg(all(feature = "native2d", not(target_os = "macos")))]
    {
        let _ = &app;
        native::push_scene(scene);
    }
    #[cfg(not(feature = "native2d"))]
    {
        let _ = (app, scene);
    }
}

#[cfg(any(feature = "native2d", feature = "native3d"))]
#[tauri::command]
fn push_native_walls(walls: serde_json::Value) {
    #[cfg(all(feature = "native3d", not(target_os = "macos")))]
    native::push_walls(walls);
    #[cfg(not(all(feature = "native3d", not(target_os = "macos"))))]
    let _ = walls;
}

/// Ob dieser Build ein natives wgpu-Fenster hat, das die Webview mit Szenen
/// füttern kann (Features native2d/native3d). Die Webview fragt einmal und
/// pusht nur dann — sonst würde sie bei JEDER Planänderung die gesamte Szene
/// (bei Kataster-Importen Millionen Primitive) serialisieren und an einen
/// nicht vorhandenen Befehl schicken.
/// Webview meldet Position/Groesse des Plan-Bereichs (CSS-Pixel); die native
/// Flaeche folgt. Ausserhalb macOS/native2d ein No-op.
#[tauri::command]
fn native2d_embed_rect(app: tauri::AppHandle, x: f64, y: f64, w: f64, h: f64) {
    #[cfg(all(feature = "native2d", target_os = "macos"))]
    native_embed::set_rect(&app, x, y, w, h);
    #[cfg(not(all(feature = "native2d", target_os = "macos")))]
    let _ = (app, x, y, w, h);
}

#[tauri::command]
fn native_viewport_enabled() -> bool {
    cfg!(any(feature = "native2d", feature = "native3d"))
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
        .manage(lock::LockState::default());

    #[cfg(all(feature = "native2d", target_os = "macos"))]
    let builder = builder.manage(native_tauri_window::NativePlanWindowState::default());

    #[cfg(all(feature = "native2d", target_os = "macos"))]
    let builder = builder.manage(native_embed::EmbedState::default());

    let builder = builder.setup(|_app| {
        // Native GPU-Fenster auf einem eigenen Thread hochfahren, damit der
        // Tauri-Hauptthread frei bleibt. NICHT auf macOS (winit verlangt dort
        // den Hauptthread) — dort s. `open_native2d_window`/`native_tauri_window`.
        #[cfg(all(any(feature = "native2d", feature = "native3d"), not(target_os = "macos")))]
        native::spawn();
        // macOS: natives 2D-Fenster direkt beim Start oeffnen (Stufe-1-Diagnose-
        // Feature; ein Menuepunkt/Shortcut kann das spaeter ersetzen, sobald
        // Stufe 1 den Performance-Gewinn bestaetigt hat).
        #[cfg(all(feature = "native2d", target_os = "macos"))]
        native_tauri_window::open(&_app.handle().clone());
        // SPIKE: DOSSIER_EMBED_TEST=1 → native Flaeche nach 4 s im Hauptfenster.
        #[cfg(all(feature = "native2d", target_os = "macos"))]
        if std::env::var("DOSSIER_EMBED_TEST").is_ok() {
            let h = _app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(4));
                native_embed::set_rect(&h, 300.0, 200.0, 500.0, 350.0);
            });
        }
        Ok(())
    });

    #[cfg(any(feature = "native2d", feature = "native3d"))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        native_viewport_enabled,
        native2d_embed_rect,
        push_native_scene,
        push_native_walls,
        acquire_project_lock,
        release_project_lock
    ]);
    #[cfg(not(any(feature = "native2d", feature = "native3d")))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        native_viewport_enabled,
        native2d_embed_rect,
        acquire_project_lock,
        release_project_lock
    ]);

    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
