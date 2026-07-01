// Standalone-Fenster-Spike (Feature "window"): oeffnet ein winit-Fenster mit
// eigener wgpu-Surface und zeichnet eine Demo-Szene (gefuellte Polygone + Striche
// in echter Papier-mm-Breite). Pan (Ziehen mit linker Maustaste) und Zoom (Rad)
// veraendern NUR die Ortho-Matrix — kein Re-Tessellieren.
//
// Das ist bewusst Option 2 aus dem Briefing: das Rendering entkoppelt von der
// Tauri/Webview-Integration verifizieren. Die Anbindung unter die Webview
// (raw-window-handle) folgt in M2 (siehe docs/design/wgpu-integration-findings.md).
//
// Start:  cargo run --features window --bin spike
// (braucht eine aktive Wayland-/X11-Session; headless nicht sichtbar verifizierbar).

use std::sync::Arc;

use render2d::gpu::Renderer;
use render2d::types::{FillPolygon, Line, Outline, Scene, ViewBox};
use render2d::PX_PER_M;

use winit::application::ApplicationHandler;
use winit::event::{ElementState, MouseButton, MouseScrollDelta, WindowEvent};
use winit::event_loop::{ActiveEventLoop, EventLoop};
use winit::window::{Window, WindowId};

/// Demo-Szene in Modell-Metern: ein L-foermiger Wand-Poche (konkav!), ein Raum
/// und ein paar Striche — genug, um Fuellung, Umriss und Papier-mm-Linien zu sehen.
fn demo_scene() -> Scene {
    let wall_grey: [f32; 4] = [0.55, 0.55, 0.55, 1.0];
    let room_blue: [f32; 4] = [0.20, 0.45, 0.85, 0.18];
    let ink: [f32; 4] = [0.10, 0.10, 0.10, 1.0];

    // Konkaves L (Wandflaeche).
    let l = vec![
        [0.0, 0.0],
        [4.0, 0.0],
        [4.0, 2.0],
        [2.0, 2.0],
        [2.0, 4.0],
        [0.0, 4.0],
    ];
    // Ein transluzenter Raum daneben.
    let room = vec![[5.0, 0.0], [9.0, 0.0], [9.0, 4.0], [5.0, 4.0]];

    Scene {
        fills: vec![
            FillPolygon {
                pts: l.clone(),
                color: wall_grey,
            },
            FillPolygon {
                pts: room.clone(),
                color: room_blue,
            },
        ],
        outlines: vec![
            Outline {
                pts: l,
                color: ink,
                width_mm: 0.35,
            },
            Outline {
                pts: room,
                color: ink,
                width_mm: 0.18,
            },
        ],
        lines: vec![Line {
            a: [0.0, -1.0],
            b: [9.0, -1.0],
            color: ink,
            width_mm: 0.25,
        }],
    }
}

/// viewBox so, dass die Szene mittig einpasst (Bildschirm-Raum = Meter*PX_PER_M).
fn initial_view_box() -> ViewBox {
    // Szene ~ x[0..9], y[-1..4] in Meter -> Bildschirm x[0..810], y[-360..90].
    // Etwas Rand drumherum.
    let pad = 90.0;
    ViewBox::new(
        -pad,
        -4.0 * PX_PER_M - pad,
        9.0 * PX_PER_M + 2.0 * pad,
        5.0 * PX_PER_M + 2.0 * pad,
    )
}

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
        let attrs = Window::default_attributes().with_title("render2d — Spike");
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
                    // Pan: Cursor-Delta (Geraete-px) -> viewBox-Einheiten (meet-Skala).
                    let (vw, vh) = (state.config.width as f32, state.config.height as f32);
                    let meet = render2d::meet_scale(*vb, vw, vh);
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
                // Zoom um die viewBox-Mitte (Faktor pro Radschritt).
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

fn main() {
    env_logger::init();
    let event_loop = EventLoop::new().expect("Event-Loop erstellen");
    event_loop.set_control_flow(winit::event_loop::ControlFlow::Wait);
    let mut app = App::default();
    event_loop.run_app(&mut app).expect("App laufen lassen");
}
