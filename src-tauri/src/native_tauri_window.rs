// macOS-Pendant zu `native.rs` (dort winit-basiert — NICHT macOS-faehig, s.
// Kommentar bei `native.rs::build_event_loop`: eine zweite, manuell per
// `App::run_iteration` + winit `pump_app_events` verschraenkte Event-Loop
// wurde getestet und verworfen — dauerhaft ~100 % CPU, unabhaengig vom
// Pacing).
//
// Hier stattdessen: ein ECHTES, WEBVIEW-LOSES Tauri-Fenster (`tauri::Window`,
// nicht `WebviewWindow` — Cargo-Feature `tauri/unstable` fuer
// `tauri::window::WindowBuilder`/`Window`, s. Cargo.toml) direkt als
// wgpu-Surface-Ziel. KEINE zweite Event-Loop noetig — Tauris eigene
// (nachweislich korrekt leerlaufende) Schleife treibt alles.
//
// BEWUSST kein `WebviewWindow`: die erste Fassung nutzte eins (mit
// "about:blank") und blieb dauerhaft weiss — `WebviewWindow` haengt IMMER
// eine eigene Webview als deckende Kind-Ansicht ins Fenster, unabhaengig vom
// geladenen Inhalt; `HasWindowHandle` liefert zwar den Fenster-Root-Handle,
// aber die (deckende, weisse) Webview-Kindansicht ueberlagert davor
// gezeichneten wgpu-Inhalt vollstaendig (durch Quellcode-Recherche
// bestaetigt: `WebviewWindow::window_handle()` delegiert an das eingebettete
// `Window`, die `Webview` ist ein separates, zusaetzlich eingehaengtes
// Kind-View-Objekt). Ein reines `tauri::Window` hat GAR KEINE Webview.
//
// Rein PUSH-getrieben, kein kontinuierlicher Redraw-Loop: neu gezeichnet wird
// nur bei (a) einer neu gepushten Szene (`push_scene`, aus `lib.rs`s
// `push_native_scene`-Command) oder (b) einem Resize-Fenster-Event. Fuer eine
// statische 2D-CAD-Unterlage reicht das (kein Pan/Zoom in dieser ersten
// Stufe — s. Plan "2D-Ansicht nativ", Stufe 1).

use std::sync::Mutex;

use render2d::gpu::Renderer as Renderer2d;
use render2d::types::{Scene, ViewBox};
use render2d::{demo_scene, initial_view_box, PX_PER_M};
use tauri::window::{Window, WindowBuilder};
use tauri::{AppHandle, Manager};

const LABEL: &str = "native2d";

struct GpuState {
    surface: wgpu::Surface<'static>,
    device: wgpu::Device,
    queue: wgpu::Queue,
    config: wgpu::SurfaceConfiguration,
    renderer: Renderer2d,
    view_box: ViewBox,
}

/// In Tauris State verwaltet (`app.manage(NativePlanWindowState::default())`
/// in `lib.rs`); `None` bis das Fenster offen + die Surface konfiguriert ist.
#[derive(Default)]
pub struct NativePlanWindowState(Mutex<Option<GpuState>>);

/// Oeffnet das native 2D-Fenster (idempotent — ist es schon offen, nur
/// fokussieren). Zeigt zunaechst die Demo-Szene; ein folgender `push_scene`
/// ersetzt sie.
pub fn open(app: &AppHandle) {
    if let Some(w) = app.get_window(LABEL) {
        let _ = w.set_focus();
        return;
    }

    let window = WindowBuilder::new(app, LABEL)
        .title("cad — nativer 2D-Viewport (wgpu, in Tauri)")
        .inner_size(1000.0, 760.0)
        // Versetzt zum Hauptfenster + explizit fokussiert: zwei frisch erzeugte
        // Fenster landen sonst leicht deckungsgleich, das neue bleibt dann
        // (`CurrentSurfaceTexture::Occluded`) dauerhaft weiss, selbst mit dem
        // `Focused(true)`-Redraw-Trigger unten (beobachtet).
        .position(80.0, 80.0)
        .focused(true)
        .build()
        .expect("natives 2D-Fenster erstellen");

    let (surface, device, queue, config) = configure_surface(&window);
    let mut renderer = Renderer2d::new(&device, config.format);
    let scene = demo_scene();
    renderer.upload_scene(&device, &scene);
    let view_box = scene_view_box(&scene);

    let state = app.state::<NativePlanWindowState>();
    *state.0.lock().expect("native2d state lock") =
        Some(GpuState { surface, device, queue, config, renderer, view_box });
    drop(state);
    redraw(app);

    // Resize -> Surface rekonfigurieren + neu zeichnen. `Focused(true)` ZUSAETZLICH
    // als Redraw-Trigger: das allererste `redraw()` oben landet oft auf einer noch
    // nicht sichtbaren Surface (`CurrentSurfaceTexture::Occluded`, kein Fehler, aber
    // der Frame wird dabei NICHT praesentiert) — ohne diesen zweiten Trigger bliebe
    // das Fenster dauerhaft weiss (beobachtet: Fenster erscheint, zeigt nichts).
    // Kein Dauer-Redraw-Loop (s. Kopfkommentar) — nur bei echten Zustandswechseln.
    let app_for_events = app.clone();
    window.on_window_event(move |event| match event {
        tauri::WindowEvent::Resized(size) => resize(&app_for_events, size.width, size.height),
        tauri::WindowEvent::Focused(true) => redraw(&app_for_events),
        _ => {}
    });
}

/// Webview-Push der 2D-Szene (aus `lib.rs::push_native_scene`, macOS-Zweig).
/// Fenster noch nicht offen → still ignorieren (kein Pending-Mechanismus wie
/// im winit-Pfad — fuer die erste Stufe nicht noetig, das Fenster wird vor
/// dem ersten Push explizit geoeffnet).
pub fn push_scene(app: &AppHandle, value: serde_json::Value) {
    let scene: Scene = match serde_json::from_value(value) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("native2d (Tauri-Fenster): ungueltige Szene: {e}");
            return;
        }
    };
    let state = app.state::<NativePlanWindowState>();
    let mut guard = state.0.lock().expect("native2d state lock");
    let Some(gpu) = guard.as_mut() else { return };
    gpu.renderer.upload_scene(&gpu.device, &scene);
    gpu.view_box = scene_view_box(&scene);
    drop(guard);
    redraw(app);
}

fn resize(app: &AppHandle, w: u32, h: u32) {
    if w == 0 || h == 0 {
        return;
    }
    let state = app.state::<NativePlanWindowState>();
    let mut guard = state.0.lock().expect("native2d state lock");
    let Some(gpu) = guard.as_mut() else { return };
    gpu.config.width = w;
    gpu.config.height = h;
    gpu.surface.configure(&gpu.device, &gpu.config);
    drop(guard);
    redraw(app);
}

fn redraw(app: &AppHandle) {
    let state = app.state::<NativePlanWindowState>();
    let mut guard = state.0.lock().expect("native2d state lock");
    let Some(gpu) = guard.as_mut() else { return };
    // wgpu 29: `get_current_texture` liefert ein Enum statt eines Results —
    // Suboptimal ist weiterhin praesentierbar, Lost/Outdated -> rekonfigurieren.
    let frame = match gpu.surface.get_current_texture() {
        wgpu::CurrentSurfaceTexture::Success(f) | wgpu::CurrentSurfaceTexture::Suboptimal(f) => f,
        wgpu::CurrentSurfaceTexture::Lost | wgpu::CurrentSurfaceTexture::Outdated => {
            gpu.surface.configure(&gpu.device, &gpu.config);
            return;
        }
        wgpu::CurrentSurfaceTexture::Occluded => {
            // Surface (noch) nicht sichtbar — kein Fehler, aber dieser Frame
            // kann nicht praesentiert werden. EINMALIG kurz verzoegert erneut
            // versuchen (deckt den Moment kurz nach dem Erzeugen ab, bevor das
            // Fenster vom Fenster-Server tatsaechlich eingeblendet ist) —
            // sonst bliebe das Fenster dauerhaft weiss, s. Kopfkommentar `open`.
            drop(guard);
            let app = app.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(150));
                redraw(&app);
            });
            return;
        }
        other => {
            eprintln!("native2d (Tauri-Fenster) Surface-Fehler: {other:?}");
            return;
        }
    };
    let view = frame.texture.create_view(&wgpu::TextureViewDescriptor::default());
    gpu.renderer.render(
        &gpu.device,
        &gpu.queue,
        &view,
        gpu.view_box,
        (gpu.config.width, gpu.config.height),
    );
    frame.present();
}

/// Initialer viewBox-Ausschnitt (BILDSCHIRM-Einheiten) aus den Modell-Grenzen
/// einer Szene, mit ~1 m Rand — identisch zur Logik in `native.rs`.
fn scene_view_box(scene: &Scene) -> ViewBox {
    let mut min_x = f32::INFINITY;
    let mut min_y = f32::INFINITY;
    let mut max_x = f32::NEG_INFINITY;
    let mut max_y = f32::NEG_INFINITY;
    let mut acc = |p: &[f32; 2]| {
        let sx = p[0] * PX_PER_M;
        let sy = -p[1] * PX_PER_M;
        min_x = min_x.min(sx);
        min_y = min_y.min(sy);
        max_x = max_x.max(sx);
        max_y = max_y.max(sy);
    };
    for f in &scene.fills {
        for p in &f.pts {
            acc(p);
        }
    }
    for o in &scene.outlines {
        for p in &o.pts {
            acc(p);
        }
    }
    for l in &scene.lines {
        acc(&l.a);
        acc(&l.b);
    }
    if !(min_x.is_finite() && max_x >= min_x && max_y >= min_y) {
        return initial_view_box();
    }
    let pad = 90.0_f32; // ~1 m Rand (PX_PER_M).
    ViewBox::new(min_x - pad, min_y - pad, (max_x - min_x) + 2.0 * pad, (max_y - min_y) + 2.0 * pad)
}

/// Baut Surface + Device + Queue + SurfaceConfiguration direkt aus dem
/// Tauri-Fenster (`Window` implementiert `HasWindowHandle` +
/// `HasDisplayHandle`) — identisches Muster zu `native.rs::configure_surface`,
/// nur mit einem Tauri- statt einem winit-Fenster als Ziel.
fn configure_surface(
    window: &Window,
) -> (
    wgpu::Surface<'static>,
    wgpu::Device,
    wgpu::Queue,
    wgpu::SurfaceConfiguration,
) {
    let size = window.inner_size().expect("Fenstergroesse lesen");
    let instance = wgpu::Instance::default();
    let surface = instance
        .create_surface(window.clone())
        .expect("Surface erstellen");
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        power_preference: wgpu::PowerPreference::HighPerformance,
        force_fallback_adapter: false,
        compatible_surface: Some(&surface),
    }))
    .expect("kein passender GPU-Adapter");
    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
        label: Some("native2d.tauri-window.device"),
        required_features: wgpu::Features::empty(),
        required_limits: wgpu::Limits::default(),
        experimental_features: wgpu::ExperimentalFeatures::disabled(),
        memory_hints: wgpu::MemoryHints::Performance,
        trace: wgpu::Trace::Off,
    }))
    .expect("Device anfordern");

    let caps = surface.get_capabilities(&adapter);
    let format = caps
        .formats
        .iter()
        .copied()
        .find(|f| f.is_srgb())
        .unwrap_or(caps.formats[0]);
    let config = wgpu::SurfaceConfiguration {
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
        format,
        width: size.width.max(1),
        height: size.height.max(1),
        present_mode: caps.present_modes[0],
        alpha_mode: caps.alpha_modes[0],
        view_formats: vec![],
        desired_maximum_frame_latency: 2,
    };
    surface.configure(&device, &config);
    (surface, device, queue, config)
}
