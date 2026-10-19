// Tauri-v2-Einstieg: die Befehls-Bruecke und der App-Start.

// M2: native wgpu-Viewports (2D und/oder 3D) im Tauri-Prozess, ueber eine
// eigene winit-Event-Loop auf einem Hintergrund-Thread. NICHT auf macOS
// (winit verlangt dort den Hauptthread) — dort s. `native_tauri_window` (2D).
// `native3d` hat (noch) keinen macOS-Weg und ist dort ein No-op.
#[cfg(all(any(feature = "native2d", feature = "native3d"), not(target_os = "macos")))]
mod native;

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
    {
        // macOS: die 2D-Ansicht laeuft ueber `native_embed` (Chunk-Upload), nicht
        // ueber eine JSON-Szene.
        let _ = (&app, &scene);
    }
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

/// Gibt es in diesem Build die eingebettete native 2D-Flaeche (macOS + native2d)?
#[tauri::command]
fn native2d_embed_available() -> bool {
    cfg!(all(feature = "native2d", target_os = "macos"))
}

#[tauri::command]
fn native2d_embed_hide(app: tauri::AppHandle) {
    #[cfg(all(feature = "native2d", target_os = "macos"))]
    native_embed::hide(&app);
    #[cfg(not(all(feature = "native2d", target_os = "macos")))]
    let _ = app;
}

/// Binaerer Puffer-Upload (Header `x-buf-id`, Body = rohe Bytes). Synchroner
/// Command → laeuft auf dem Hauptthread, Reihenfolge der Aufrufe bleibt erhalten.
#[tauri::command]
fn native2d_upload(app: tauri::AppHandle, request: tauri::ipc::Request<'_>) -> Result<(), String> {
    #[cfg(all(feature = "native2d", target_os = "macos"))]
    {
        let id: u32 = request
            .headers()
            .get("x-buf-id")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse().ok())
            .ok_or("x-buf-id fehlt")?;
        let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
            return Err("Rohdaten erwartet".into());
        };
        native_embed::upload(&app, id, bytes);
    }
    #[cfg(not(all(feature = "native2d", target_os = "macos")))]
    let _ = (app, request);
    Ok(())
}

#[tauri::command]
fn native2d_layout(app: tauri::AppHandle, layout: serde_json::Value, delete: Vec<u32>) -> Result<(), String> {
    #[cfg(all(feature = "native2d", target_os = "macos"))]
    {
        let layout = serde_json::from_value(layout).map_err(|e| e.to_string())?;
        native_embed::set_layout(&app, layout, delete);
    }
    #[cfg(not(all(feature = "native2d", target_os = "macos")))]
    let _ = (app, layout, delete);
    Ok(())
}

/// Vektor-Texte (Delta): `upsert` = Eintraege, `remove` = IDs. Liefert `false`, wenn
/// keine Schrift gefunden wurde (dann zeichnet die Webview die Texte selbst).
#[tauri::command]
fn native2d_texts(app: tauri::AppHandle, upsert: serde_json::Value, remove: Vec<u32>) -> Result<bool, String> {
    #[cfg(all(feature = "native2d", target_os = "macos"))]
    {
        let upsert = serde_json::from_value(upsert).map_err(|e| e.to_string())?;
        return Ok(native_embed::set_texts(&app, upsert, remove));
    }
    #[cfg(not(all(feature = "native2d", target_os = "macos")))]
    {
        let _ = (app, upsert, remove);
        Ok(false)
    }
}

#[tauri::command]
fn native2d_frame(app: tauri::AppHandle, view: serde_json::Value, paper_scale: f64, clear: Option<[f64; 3]>) -> Result<(), String> {
    #[cfg(all(feature = "native2d", target_os = "macos"))]
    {
        let view = serde_json::from_value(view).map_err(|e| e.to_string())?;
        native_embed::frame(&app, view, paper_scale, clear);
    }
    #[cfg(not(all(feature = "native2d", target_os = "macos")))]
    let _ = (app, view, paper_scale, clear);
    Ok(())
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
    let builder = builder.manage(native_embed::EmbedState::default());

    let builder = builder.setup(|_app| {
        // Native GPU-Fenster auf einem eigenen Thread hochfahren, damit der
        // Tauri-Hauptthread frei bleibt. NICHT auf macOS (winit verlangt dort
        // den Hauptthread) — dort s. `open_native2d_window`/`native_tauri_window`.
        #[cfg(all(any(feature = "native2d", feature = "native3d"), not(target_os = "macos")))]
        native::spawn();
        // macOS: das separate Diagnose-Fenster (`native_tauri_window::open`) wird
        // nicht mehr automatisch geoeffnet — die 2D-Ansicht ist jetzt in das
        // Hauptfenster eingebettet (`native_embed`).
        Ok(())
    });

    #[cfg(any(feature = "native2d", feature = "native3d"))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        native_viewport_enabled,
        native2d_embed_rect,
        native2d_embed_available,
        native2d_embed_hide,
        native2d_upload,
        native2d_layout,
        native2d_frame,
        native2d_texts,
        push_native_scene,
        push_native_walls,
        acquire_project_lock,
        release_project_lock
    ]);
    #[cfg(not(any(feature = "native2d", feature = "native3d")))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        native_viewport_enabled,
        native2d_embed_rect,
        native2d_embed_available,
        native2d_embed_hide,
        native2d_upload,
        native2d_layout,
        native2d_frame,
        native2d_texts,
        acquire_project_lock,
        release_project_lock
    ]);

    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
