// M2: die nativen wgpu-Viewports (2D + 3D), gestartet AUS DEM Tauri-Prozess.
//
// Ziel: beweisen, dass die nativen GPU-Flaechen (render2d/render3d) im echten
// Tauri-Prozess laufen — NICHT in der WebKitGTK-Webview (dem Perf-Flaschenhals)
// und NICHT in einem separaten Chromium-Workaround-Fenster.
//
// Architektur (Ansatz B, siehe docs/welle-c-hlr-spike/m2-approach.md):
//   - Der Tauri-Hauptthread haelt weiterhin die GTK-Hauptschleife + die Webview.
//   - Dieses Modul oeffnet EIGENE native winit-Fenster mit eigener wgpu-Surface
//     auf EINEM HINTERGRUND-Thread. winit spricht auf Linux direkt Wayland/X11
//     (KEIN GTK) — die Fenster-/Surface-Ebene ist so voellig von WebKitGTK
//     getrennt (keine Surface-Contention/Flicker).
//   - winit erlaubt eine Event-Loop auf einem Nicht-Haupt-Thread via
//     `EventLoopBuilderExtWayland/X11::with_any_thread(true)`.
//
// WICHTIG: winit erlaubt nur EINE Event-Loop pro Prozess. Darum hosten wir das
// 2D- UND das 3D-Fenster in DERSELBEN Event-Loop (winit-Multi-Window-Muster) und
// verteilen Events per `WindowId`. Zwei getrennte Event-Loops (je Fenster) wuerden
// mit `RecreationAttempt` paniken.
//
// Die Renderer selbst werden NICHT reimplementiert: `render2d::gpu::Renderer` +
// `render3d::gpu::Renderer` — exakt der Code der standalone-Spikes.
//
// LIVE-Spiegelung: Die Webview schiebt bei jeder Modellaenderung (debounced)
// die aktuelle 2D-Szene bzw. die 3D-Waende per Tauri-Command
// (`push_native_scene`/`push_native_walls`, siehe lib.rs) hierher; ein
// `EventLoopProxy<UserEvent>` stellt sie in die winit-Loop zu. Die JSON-Assets
// `assets/native2d_scene.json`/`assets/native3d_walls.json` bleiben nur noch
// Start-Fallback (bis der erste Push ankommt); fehlen sie, greift die Demo-Szene.
//
// Hinter den Cargo-Features `native2d`/`native3d` — der normale Tauri-Build zieht
// weder winit noch wgpu und bleibt unveraendert. Beide Features sind
// gleichzeitig aktivierbar (dann oeffnen sich beide Fenster).

use std::sync::{Arc, OnceLock};

use winit::application::ApplicationHandler;
use winit::dpi::LogicalSize;
use winit::event::{ElementState, MouseButton, MouseScrollDelta, WindowEvent};
use winit::event_loop::{ActiveEventLoop, EventLoop, EventLoopProxy};
use winit::window::{Window, WindowId};

// ─────────────────────────────────────────────────────────────────────────────
// Live-Push aus der Webview
// ─────────────────────────────────────────────────────────────────────────────

/// Ereignisse, die die Webview (via Tauri-Command) in die native Event-Loop
/// schiebt: die frisch erzeugte 2D-Szene bzw. die geflachten 3D-Waende. So
/// spiegeln die nativen Fenster das LIVE-Modell statt des JSON-Snapshots.
enum UserEvent {
    #[cfg(feature = "native2d")]
    Scene2d(Scene),
    #[cfg(feature = "native3d")]
    Walls3d(Vec<WallInput>),
}

/// Proxy in die laufende Event-Loop; wird beim Start (vor `run`) gesetzt.
/// Solange die Loop noch nicht steht, verpuffen Pushes bewusst still.
static PROXY: OnceLock<EventLoopProxy<UserEvent>> = OnceLock::new();

/// Webview-Push der 2D-Szene (JSON = `render2d::types::Scene`). Parse-Fehler
/// werden geloggt, ein fehlender Proxy still ignoriert (Loop startet noch).
#[cfg(feature = "native2d")]
pub fn push_scene(value: serde_json::Value) {
    let Some(proxy) = PROXY.get() else { return };
    match serde_json::from_value::<Scene>(value) {
        Ok(scene) => {
            let _ = proxy.send_event(UserEvent::Scene2d(scene));
        }
        Err(e) => eprintln!("push_native_scene: ungueltige Szene: {e}"),
    }
}

/// Webview-Push der 3D-Waende (JSON = `Vec<render3d::types::WallInput>`).
#[cfg(feature = "native3d")]
pub fn push_walls(value: serde_json::Value) {
    let Some(proxy) = PROXY.get() else { return };
    match serde_json::from_value::<Vec<WallInput>>(value) {
        Ok(walls) => {
            let _ = proxy.send_event(UserEvent::Walls3d(walls));
        }
        Err(e) => eprintln!("push_native_walls: ungueltige Waende: {e}"),
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2D
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(feature = "native2d")]
use render2d::gpu::Renderer as Renderer2d;
#[cfg(feature = "native2d")]
use render2d::types::{Scene, ViewBox};
#[cfg(feature = "native2d")]
use render2d::{demo_scene, initial_view_box, meet_scale, PX_PER_M};

#[cfg(feature = "native2d")]
struct GpuState2d {
    surface: wgpu::Surface<'static>,
    device: wgpu::Device,
    queue: wgpu::Queue,
    config: wgpu::SurfaceConfiguration,
    renderer: Renderer2d,
    window: Arc<Window>,
}

#[cfg(feature = "native2d")]
impl GpuState2d {
    fn new(window: Arc<Window>, scene: &Scene) -> Self {
        let (surface, device, queue, config) = configure_surface(&window, "2d.device");
        let mut renderer = Renderer2d::new(&device, config.format);
        renderer.upload_scene(&device, scene);
        Self { surface, device, queue, config, renderer, window }
    }

    fn resize(&mut self, w: u32, h: u32) {
        if w == 0 || h == 0 {
            return;
        }
        self.config.width = w;
        self.config.height = h;
        self.surface.configure(&self.device, &self.config);
    }

    fn render(&mut self, view_box: ViewBox) {
        let frame = match self.surface.get_current_texture() {
            Ok(f) => f,
            Err(wgpu::SurfaceError::Lost | wgpu::SurfaceError::Outdated) => {
                self.surface.configure(&self.device, &self.config);
                return;
            }
            Err(e) => {
                eprintln!("native2d Surface-Fehler: {e:?}");
                return;
            }
        };
        let view = frame.texture.create_view(&wgpu::TextureViewDescriptor::default());
        self.renderer.render(
            &self.device,
            &self.queue,
            &view,
            view_box,
            (self.config.width, self.config.height),
        );
        frame.present();
    }
}

#[cfg(feature = "native2d")]
const SCENE_PATH: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/assets/native2d_scene.json");

#[cfg(feature = "native2d")]
fn load_scene() -> Scene {
    match std::fs::read_to_string(SCENE_PATH) {
        Ok(text) => match serde_json::from_str::<Scene>(&text) {
            Ok(scene) => scene,
            Err(e) => {
                eprintln!("native2d: Szene-Parse-Fehler ({SCENE_PATH}): {e} — nutze Demo-Szene");
                demo_scene()
            }
        },
        Err(e) => {
            eprintln!("native2d: Szene nicht ladbar ({SCENE_PATH}): {e} — nutze Demo-Szene");
            demo_scene()
        }
    }
}

/// Initialer viewBox-Ausschnitt (BILDSCHIRM-Einheiten) aus den Modell-Grenzen
/// einer Szene, mit ~1 m Rand. Bildschirm-Abbildung wie `tessellate::to_screen`:
/// `sx = mx * PX_PER_M`, `sy = -my * PX_PER_M`. Leere Szene -> `initial_view_box`.
#[cfg(feature = "native2d")]
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

// ─────────────────────────────────────────────────────────────────────────────
// 3D
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(feature = "native3d")]
use render3d::gpu::Renderer as Renderer3d;
#[cfg(feature = "native3d")]
use render3d::math::orbit_eye;
#[cfg(feature = "native3d")]
use render3d::types::{Camera, Projection, WallInput};

#[cfg(feature = "native3d")]
struct GpuState3d {
    surface: wgpu::Surface<'static>,
    device: wgpu::Device,
    queue: wgpu::Queue,
    config: wgpu::SurfaceConfiguration,
    renderer: Renderer3d,
    window: Arc<Window>,
}

#[cfg(feature = "native3d")]
impl GpuState3d {
    fn new(window: Arc<Window>, walls: &[WallInput]) -> Self {
        let (surface, device, queue, config) = configure_surface(&window, "3d.device");
        let mut renderer = Renderer3d::new(&device, config.format);
        renderer.upload_walls(&device, walls);
        renderer.set_light([6.0, 12.0, 4.0], 0.6);
        Self { surface, device, queue, config, renderer, window }
    }

    fn resize(&mut self, w: u32, h: u32) {
        if w == 0 || h == 0 {
            return;
        }
        self.config.width = w;
        self.config.height = h;
        self.surface.configure(&self.device, &self.config);
    }

    fn render(&mut self, camera: &Camera) {
        let frame = match self.surface.get_current_texture() {
            Ok(f) => f,
            Err(wgpu::SurfaceError::Lost | wgpu::SurfaceError::Outdated) => {
                self.surface.configure(&self.device, &self.config);
                return;
            }
            Err(e) => {
                eprintln!("native3d Surface-Fehler: {e:?}");
                return;
            }
        };
        let view = frame.texture.create_view(&wgpu::TextureViewDescriptor::default());
        self.renderer.render(
            &self.device,
            &self.queue,
            &view,
            camera,
            (self.config.width, self.config.height),
        );
        frame.present();
    }
}

#[cfg(feature = "native3d")]
const WALLS_PATH: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/assets/native3d_walls.json");

#[cfg(feature = "native3d")]
fn load_walls() -> Vec<WallInput> {
    match std::fs::read_to_string(WALLS_PATH) {
        Ok(text) => match serde_json::from_str::<Vec<WallInput>>(&text) {
            Ok(walls) => walls,
            Err(e) => {
                eprintln!("native3d: Waende-Parse-Fehler ({WALLS_PATH}): {e} — nutze Demo-Waende");
                demo_walls()
            }
        },
        Err(e) => {
            eprintln!("native3d: Waende nicht ladbar ({WALLS_PATH}): {e} — nutze Demo-Waende");
            demo_walls()
        }
    }
}

/// Demo-Szene (verbatim aus `render3d::bin::spike3d`): rechteckiger Raum + Innenwand.
#[cfg(feature = "native3d")]
fn demo_walls() -> Vec<WallInput> {
    let t = 0.2;
    let ht = 2.6;
    let grey = [0.82, 0.80, 0.76];
    let mk = |a: [f32; 2], b: [f32; 2]| WallInput {
        start: a,
        end: b,
        thickness: t,
        height: ht,
        base_elevation: 0.0,
        color: grey,
    };
    vec![
        mk([0.0, 0.0], [6.0, 0.0]),
        mk([6.0, 0.0], [6.0, 4.0]),
        mk([6.0, 4.0], [0.0, 4.0]),
        mk([0.0, 4.0], [0.0, 0.0]),
        mk([3.0, 0.0], [3.0, 2.5]),
    ]
}

/// Blickziel (world) + sinnvoller Start-Abstand, sodass alle Waende ins Bild
/// passen. world: `x=model.x`, `z=model.y`, `y=Hoehe` (render3d-Konvention).
#[cfg(feature = "native3d")]
fn frame_walls(walls: &[WallInput]) -> ([f32; 3], f32) {
    if walls.is_empty() {
        return ([3.0, 1.3, 2.0], 11.0);
    }
    let mut min = [f32::INFINITY; 3];
    let mut max = [f32::NEG_INFINITY; 3];
    let mut acc = |x: f32, y: f32, z: f32| {
        min[0] = min[0].min(x);
        min[1] = min[1].min(y);
        min[2] = min[2].min(z);
        max[0] = max[0].max(x);
        max[1] = max[1].max(y);
        max[2] = max[2].max(z);
    };
    for w in walls {
        let base = w.base_elevation;
        let top = w.base_elevation + w.height;
        for p in [w.start, w.end] {
            acc(p[0], base, p[1]);
            acc(p[0], top, p[1]);
        }
    }
    if !(min[0].is_finite() && max[0] >= min[0]) {
        return ([3.0, 1.3, 2.0], 11.0);
    }
    let center = [
        (min[0] + max[0]) * 0.5,
        (min[1] + max[1]) * 0.5,
        (min[2] + max[2]) * 0.5,
    ];
    let ext = [
        (max[0] - min[0]) * 0.5,
        (max[1] - min[1]) * 0.5,
        (max[2] - min[2]) * 0.5,
    ];
    let radius = (ext[0] * ext[0] + ext[1] * ext[1] + ext[2] * ext[2]).sqrt();
    let dist = (radius * 2.2).max(3.0);
    (center, dist)
}

/// Orbit-Zustand: Yaw/Pitch (Radiant) + Abstand um ein festes Ziel.
#[cfg(feature = "native3d")]
struct Orbit {
    yaw: f32,
    pitch: f32,
    dist: f32,
    target: [f32; 3],
}

#[cfg(feature = "native3d")]
impl Orbit {
    fn framed(walls: &[WallInput]) -> Self {
        let (target, dist) = frame_walls(walls);
        Self { yaw: std::f32::consts::FRAC_PI_4, pitch: 0.5, dist, target }
    }

    fn camera(&self) -> Camera {
        Camera {
            eye: orbit_eye(self.target, self.yaw, self.pitch, self.dist),
            target: self.target,
            up: [0.0, 1.0, 0.0],
            projection: Projection::Perspective,
            ..Camera::default()
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Gemeinsame Surface-Konfiguration
// ─────────────────────────────────────────────────────────────────────────────

/// Baut Surface + Device + Queue + SurfaceConfiguration fuer ein winit-Fenster.
/// Waehlt ein sRGB-Format, sonst das erste angebotene.
#[cfg(any(feature = "native2d", feature = "native3d"))]
fn configure_surface(
    window: &Arc<Window>,
    device_label: &str,
) -> (
    wgpu::Surface<'static>,
    wgpu::Device,
    wgpu::Queue,
    wgpu::SurfaceConfiguration,
) {
    let size = window.inner_size();
    let instance = wgpu::Instance::default();
    let surface = instance.create_surface(window.clone()).expect("Surface erstellen");
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        power_preference: wgpu::PowerPreference::HighPerformance,
        force_fallback_adapter: false,
        compatible_surface: Some(&surface),
    }))
    .expect("kein passender GPU-Adapter");
    let (device, queue) = pollster::block_on(adapter.request_device(
        &wgpu::DeviceDescriptor {
            label: Some(device_label),
            required_features: wgpu::Features::empty(),
            required_limits: wgpu::Limits::default(),
            memory_hints: wgpu::MemoryHints::Performance,
        },
        None,
    ))
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

// ─────────────────────────────────────────────────────────────────────────────
// App: EINE Event-Loop, beide Fenster, Routing per WindowId
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Default)]
struct App {
    #[cfg(feature = "native2d")]
    s2d: Option<GpuState2d>,
    #[cfg(feature = "native2d")]
    view_box: Option<ViewBox>,
    #[cfg(feature = "native2d")]
    id2d: Option<WindowId>,
    #[cfg(feature = "native2d")]
    drag2d: bool,
    #[cfg(feature = "native2d")]
    cur2d: (f64, f64),
    /// Hat der Nutzer im 2D-Fenster schon gepannt/gezoomt? Solange NICHT, wird
    /// die Ansicht bei jedem Live-Push neu eingepasst; danach bleibt sie stehen.
    #[cfg(feature = "native2d")]
    nav2d: bool,
    /// Live-Push, der ankam, bevor das 2D-Fenster stand (wird in `resumed` statt
    /// des JSON-Snapshots angewandt).
    #[cfg(feature = "native2d")]
    pending2d: Option<Scene>,

    #[cfg(feature = "native3d")]
    s3d: Option<GpuState3d>,
    #[cfg(feature = "native3d")]
    orbit: Option<Orbit>,
    #[cfg(feature = "native3d")]
    id3d: Option<WindowId>,
    #[cfg(feature = "native3d")]
    drag3d: bool,
    #[cfg(feature = "native3d")]
    cur3d: (f64, f64),
    /// Hat der Nutzer im 3D-Fenster schon orbitiert/gezoomt? Analog `nav2d`.
    #[cfg(feature = "native3d")]
    nav3d: bool,
    /// Live-Push vor Fenster-Erstellung (siehe `pending2d`).
    #[cfg(feature = "native3d")]
    pending3d: Option<Vec<WallInput>>,
}

impl App {
    /// Beendet die Event-Loop, sobald KEIN natives Fenster mehr offen ist.
    fn maybe_exit(&self, event_loop: &ActiveEventLoop) {
        let mut any_open = false;
        #[cfg(feature = "native2d")]
        {
            if self.s2d.is_some() {
                any_open = true;
            }
        }
        #[cfg(feature = "native3d")]
        {
            if self.s3d.is_some() {
                any_open = true;
            }
        }
        if !any_open {
            event_loop.exit();
        }
    }

    #[cfg(feature = "native2d")]
    fn on_2d(&mut self, event_loop: &ActiveEventLoop, event: WindowEvent) {
        let Some(state) = self.s2d.as_mut() else {
            return;
        };
        let vb = self.view_box.get_or_insert_with(initial_view_box);
        match event {
            WindowEvent::CloseRequested => {
                self.s2d = None;
                self.id2d = None;
                self.maybe_exit(event_loop);
            }
            WindowEvent::Resized(size) => {
                state.resize(size.width, size.height);
                state.window.request_redraw();
            }
            WindowEvent::MouseInput { state: s, button, .. } => {
                if button == MouseButton::Left {
                    self.drag2d = s == ElementState::Pressed;
                }
            }
            WindowEvent::CursorMoved { position, .. } => {
                if self.drag2d {
                    let (vw, vh) = (state.config.width as f32, state.config.height as f32);
                    let meet = meet_scale(*vb, vw, vh);
                    let dx = (position.x - self.cur2d.0) as f32 / meet;
                    let dy = (position.y - self.cur2d.1) as f32 / meet;
                    vb.x -= dx;
                    vb.y -= dy;
                    self.nav2d = true;
                    state.window.request_redraw();
                }
                self.cur2d = (position.x, position.y);
            }
            WindowEvent::MouseWheel { delta, .. } => {
                self.nav2d = true;
                let step = match delta {
                    MouseScrollDelta::LineDelta(_, y) => y,
                    MouseScrollDelta::PixelDelta(p) => (p.y as f32) / 40.0,
                };
                let factor = if step > 0.0 { 0.9 } else { 1.0 / 0.9 };
                let cx = vb.x + vb.w * 0.5;
                let cy = vb.y + vb.h * 0.5;
                vb.w *= factor;
                vb.h *= factor;
                vb.x = cx - vb.w * 0.5;
                vb.y = cy - vb.h * 0.5;
                state.window.request_redraw();
            }
            WindowEvent::RedrawRequested => {
                let vb_copy = *vb;
                state.render(vb_copy);
            }
            _ => {}
        }
    }

    #[cfg(feature = "native3d")]
    fn on_3d(&mut self, event_loop: &ActiveEventLoop, event: WindowEvent) {
        let Some(state) = self.s3d.as_mut() else {
            return;
        };
        let Some(orbit) = self.orbit.as_mut() else {
            return;
        };
        match event {
            WindowEvent::CloseRequested => {
                self.s3d = None;
                self.id3d = None;
                self.maybe_exit(event_loop);
            }
            WindowEvent::Resized(size) => {
                state.resize(size.width, size.height);
                state.window.request_redraw();
            }
            WindowEvent::MouseInput { state: s, button, .. } => {
                if button == MouseButton::Left {
                    self.drag3d = s == ElementState::Pressed;
                }
            }
            WindowEvent::CursorMoved { position, .. } => {
                if self.drag3d {
                    let dx = (position.x - self.cur3d.0) as f32;
                    let dy = (position.y - self.cur3d.1) as f32;
                    orbit.yaw -= dx * 0.01;
                    orbit.pitch += dy * 0.01;
                    let limit = std::f32::consts::FRAC_PI_2 - 0.01;
                    orbit.pitch = orbit.pitch.clamp(-limit, limit);
                    self.nav3d = true;
                    state.window.request_redraw();
                }
                self.cur3d = (position.x, position.y);
            }
            WindowEvent::MouseWheel { delta, .. } => {
                self.nav3d = true;
                let step = match delta {
                    MouseScrollDelta::LineDelta(_, y) => y,
                    MouseScrollDelta::PixelDelta(p) => (p.y as f32) / 40.0,
                };
                let factor = if step > 0.0 { 0.9 } else { 1.0 / 0.9 };
                orbit.dist = (orbit.dist * factor).clamp(1.5, 200.0);
                state.window.request_redraw();
            }
            WindowEvent::RedrawRequested => {
                let cam = orbit.camera();
                state.render(&cam);
            }
            _ => {}
        }
    }
}

impl ApplicationHandler<UserEvent> for App {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        #[cfg(feature = "native2d")]
        if self.s2d.is_none() {
            let attrs = Window::default_attributes()
                .with_title("cad — nativer 2D-Viewport (wgpu, in Tauri)")
                .with_inner_size(LogicalSize::new(1000.0, 760.0));
            let window = Arc::new(event_loop.create_window(attrs).expect("2D-Fenster erstellen"));
            self.id2d = Some(window.id());
            // Kam schon ein Live-Push an, gewinnt der; sonst der JSON-Snapshot.
            let scene = self.pending2d.take().unwrap_or_else(load_scene);
            self.view_box = Some(scene_view_box(&scene));
            let state = GpuState2d::new(window, &scene);
            state.window.request_redraw();
            self.s2d = Some(state);
        }

        #[cfg(feature = "native3d")]
        if self.s3d.is_none() {
            let attrs = Window::default_attributes()
                .with_title("cad — nativer 3D-Viewport (wgpu, in Tauri)")
                .with_inner_size(LogicalSize::new(1000.0, 760.0));
            let window = Arc::new(event_loop.create_window(attrs).expect("3D-Fenster erstellen"));
            self.id3d = Some(window.id());
            let walls = self.pending3d.take().unwrap_or_else(load_walls);
            self.orbit = Some(Orbit::framed(&walls));
            let state = GpuState3d::new(window, &walls);
            state.window.request_redraw();
            self.s3d = Some(state);
        }
    }

    /// Live-Push aus der Webview: Szene/Waende ersetzen, GPU-Buffer neu bauen,
    /// neu zeichnen. Die Ansicht wird nur neu eingepasst, solange der Nutzer im
    /// jeweiligen Fenster noch nicht selbst navigiert hat (kein Zuruckspringen
    /// von Pan/Zoom/Orbit bei jeder Modellaenderung).
    fn user_event(&mut self, _event_loop: &ActiveEventLoop, event: UserEvent) {
        match event {
            #[cfg(feature = "native2d")]
            UserEvent::Scene2d(scene) => {
                let Some(state) = self.s2d.as_mut() else {
                    self.pending2d = Some(scene);
                    return;
                };
                state.renderer.upload_scene(&state.device, &scene);
                if !self.nav2d {
                    self.view_box = Some(scene_view_box(&scene));
                }
                state.window.request_redraw();
            }
            #[cfg(feature = "native3d")]
            UserEvent::Walls3d(walls) => {
                let Some(state) = self.s3d.as_mut() else {
                    self.pending3d = Some(walls);
                    return;
                };
                state.renderer.upload_walls(&state.device, &walls);
                if !self.nav3d {
                    self.orbit = Some(Orbit::framed(&walls));
                }
                state.window.request_redraw();
            }
        }
    }

    fn window_event(&mut self, event_loop: &ActiveEventLoop, id: WindowId, event: WindowEvent) {
        #[cfg(feature = "native2d")]
        if self.id2d == Some(id) {
            self.on_2d(event_loop, event);
            return;
        }
        #[cfg(feature = "native3d")]
        if self.id3d == Some(id) {
            self.on_3d(event_loop, event);
            return;
        }
        let _ = (event_loop, event);
    }
}

/// Baut die winit-Event-Loop so, dass sie auf DIESEM (Nicht-Haupt-)Thread laufen
/// darf. Auf Linux/Wayland via `EventLoopBuilderExtWayland::with_any_thread`, auf
/// X11 das Pendant. Ohne diese Freigabe panict winit (Event-Loop nur Hauptthread).
fn build_event_loop() -> EventLoop<UserEvent> {
    let mut builder = EventLoop::<UserEvent>::with_user_event();

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        use winit::platform::wayland::EventLoopBuilderExtWayland;
        EventLoopBuilderExtWayland::with_any_thread(&mut builder, true);
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        use winit::platform::x11::EventLoopBuilderExtX11;
        EventLoopBuilderExtX11::with_any_thread(&mut builder, true);
    }

    builder.build().expect("Event-Loop erstellen")
}

/// Blockierender Lauf der nativen Event-Loop (fuer einen dedizierten Thread).
fn run_blocking() {
    let event_loop = build_event_loop();
    event_loop.set_control_flow(winit::event_loop::ControlFlow::Wait);
    // Proxy VOR dem Lauf veroeffentlichen, damit die Tauri-Commands
    // (`push_native_scene`/`push_native_walls`) sofort zustellen koennen.
    let _ = PROXY.set(event_loop.create_proxy());
    let mut app = App::default();
    let _ = event_loop.run_app(&mut app);
}

/// Startet die nativen Fenster (2D und/oder 3D, je nach Feature) auf EINEM eigenen
/// Thread und kehrt sofort zurueck — die Tauri-/GTK-Hauptschleife bleibt frei.
pub fn spawn() {
    std::thread::Builder::new()
        .name("cad-native".into())
        .spawn(run_blocking)
        .expect("native-Thread starten");
}
