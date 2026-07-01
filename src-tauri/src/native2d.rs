// M2-Spike: der native wgpu-2D-Renderer, gestartet AUS DEM Tauri-Prozess heraus.
//
// Ziel: beweisen, dass die native GPU-Flaeche (render2d) im echten Tauri-Prozess
// laeuft — NICHT in der WebKitGTK-Webview (dem bekannten Perf-Flaschenhals) und
// NICHT in einem separaten Chromium-Workaround-Fenster.
//
// Architektur (Ansatz B, siehe docs/welle-c-hlr-spike/m2-approach.md):
//   - Der Tauri-Hauptthread haelt weiterhin die GTK-Hauptschleife + die
//     Webview-Fenster (HTML-Chrome).
//   - Dieses Modul oeffnet ein EIGENES natives winit-Fenster mit eigener
//     wgpu-Surface auf einem HINTERGRUND-Thread. winit spricht auf Linux direkt
//     Wayland/X11 (KEIN GTK) — dadurch ist die Fenster-/Surface-Ebene voellig
//     getrennt von WebKitGTK. Kein geteilter Wayland-Surface => keine
//     Surface-Contention/Flicker wie beim Unterlegen einer Roh-Surface unter die
//     Webview.
//   - winit erlaubt eine Event-Loop auf einem Nicht-Haupt-Thread via
//     `EventLoopBuilderExtWayland/X11::with_any_thread(true)`.
//
// Der Renderer selbst wird NICHT reimplementiert: wir verwenden
// `render2d::gpu::Renderer` + `render2d::demo_scene()` — exakt der Code, der im
// standalone `spike`-Bin bereits als fluessig verifiziert wurde.
//
// Bewusst hinter dem Cargo-Feature `native2d` — der normale Tauri-Build zieht
// weder winit noch wgpu und bleibt unveraendert.

use std::sync::Arc;

use render2d::gpu::Renderer;
use render2d::types::ViewBox;
use render2d::{demo_scene, initial_view_box, meet_scale};

use winit::application::ApplicationHandler;
use winit::event::{ElementState, MouseButton, MouseScrollDelta, WindowEvent};
use winit::event_loop::{ActiveEventLoop, EventLoop};
use winit::window::{Window, WindowId};

/// GPU-Zustand des nativen Fensters (Surface + Device + Renderer). 1:1 wie im
/// standalone Spike — die Surface haengt an DIESEM winit-Fenster, nicht an der
/// Webview.
struct GpuState {
    surface: wgpu::Surface<'static>,
    device: wgpu::Device,
    queue: wgpu::Queue,
    config: wgpu::SurfaceConfiguration,
    renderer: Renderer,
    window: Arc<Window>,
}

impl GpuState {
    fn new(window: Arc<Window>) -> Self {
        let size = window.inner_size();
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
        let (device, queue) = pollster::block_on(adapter.request_device(
            &wgpu::DeviceDescriptor {
                label: Some("2d.device"),
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

        let mut renderer = Renderer::new(&device, format);
        renderer.upload_scene(&device, &demo_scene());

        Self {
            surface,
            device,
            queue,
            config,
            renderer,
            window,
        }
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
                eprintln!("Surface-Fehler: {e:?}");
                return;
            }
        };
        let view = frame
            .texture
            .create_view(&wgpu::TextureViewDescriptor::default());
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

#[derive(Default)]
struct App {
    state: Option<GpuState>,
    view_box: Option<ViewBox>,
    dragging: bool,
    last_cursor: (f64, f64),
}

impl ApplicationHandler for App {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        if self.state.is_some() {
            return;
        }
        let attrs = Window::default_attributes().with_title("cad — nativer 2D-Viewport (wgpu, in Tauri)");
        let window = Arc::new(event_loop.create_window(attrs).expect("Fenster erstellen"));
        self.view_box.get_or_insert_with(initial_view_box);
        self.state = Some(GpuState::new(window));
    }

    fn window_event(
        &mut self,
        event_loop: &ActiveEventLoop,
        _id: WindowId,
        event: WindowEvent,
    ) {
        let Some(state) = self.state.as_mut() else {
            return;
        };
        let vb = self.view_box.get_or_insert_with(initial_view_box);
        match event {
            // Nur DIESES Fenster schliessen — die Tauri-Webview laeuft weiter.
            WindowEvent::CloseRequested => event_loop.exit(),
            WindowEvent::Resized(size) => {
                state.resize(size.width, size.height);
                state.window.request_redraw();
            }
            WindowEvent::MouseInput { state: s, button, .. } => {
                if button == MouseButton::Left {
                    self.dragging = s == ElementState::Pressed;
                }
            }
            WindowEvent::CursorMoved { position, .. } => {
                if self.dragging {
                    let (vw, vh) = (state.config.width as f32, state.config.height as f32);
                    let meet = meet_scale(*vb, vw, vh);
                    let dx = (position.x - self.last_cursor.0) as f32 / meet;
                    let dy = (position.y - self.last_cursor.1) as f32 / meet;
                    vb.x -= dx;
                    vb.y -= dy;
                    state.window.request_redraw();
                }
                self.last_cursor = (position.x, position.y);
            }
            WindowEvent::MouseWheel { delta, .. } => {
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
}

/// Baut die winit-Event-Loop so, dass sie auf DIESEM (Nicht-Haupt-)Thread laufen
/// darf. Auf Linux/Wayland ist das `EventLoopBuilderExtWayland::with_any_thread`,
/// auf X11 das X11-Pendant. Ohne diese Freigabe panict winit, weil es die
/// Event-Loop standardmaessig nur auf dem Hauptthread zulaesst (den haelt hier
/// aber die GTK-/Tauri-Schleife).
fn build_event_loop() -> EventLoop<()> {
    use winit::event_loop::EventLoopBuilder;
    let mut builder = EventLoopBuilder::default();

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        // Wayland zuerst versuchen; faellt winit intern auf X11 zurueck, greift
        // die X11-Freigabe. Beide Extension-Traits setzen dasselbe any-thread-Flag.
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

/// Blockierender Lauf der nativen Event-Loop. Gedacht fuer einen dedizierten
/// Thread (siehe `spawn`), NICHT fuer den Tauri-Hauptthread.
fn run_blocking() {
    let event_loop = build_event_loop();
    event_loop.set_control_flow(winit::event_loop::ControlFlow::Wait);
    let mut app = App::default();
    // `run_app` blockiert bis das native Fenster geschlossen wird.
    let _ = event_loop.run_app(&mut app);
}

/// Startet das native 2D-Fenster auf einem eigenen Thread und kehrt sofort
/// zurueck. So bleibt die Tauri-/GTK-Hauptschleife frei. Aufruf typischerweise
/// aus dem Tauri-`setup`-Hook.
pub fn spawn() {
    std::thread::Builder::new()
        .name("cad-native2d".into())
        .spawn(run_blocking)
        .expect("native2d-Thread starten");
}
