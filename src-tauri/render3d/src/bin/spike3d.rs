// Standalone-Fenster-Spike (Feature "window"): oeffnet ein winit-Fenster mit
// eigener wgpu-Surface und zeichnet eine Demo-Szene aus extrudierten Waenden (ein
// geschlossener Raum). Eine ORBIT-KAMERA laesst sich mit der Maus drehen (linke
// Taste ziehen = Yaw/Pitch) und mit dem Rad zoomen (Abstand). Nur die
// View-Projektions-Matrix aendert sich — kein Re-Meshing.
//
// Das ist bewusst der entkoppelte Rendering-Spike (M1): Rendering getrennt von der
// Tauri/Webview-Integration verifizieren. Die Anbindung unter die Webview
// (raw-window-handle) folgt in einem spaeteren Milestone.
//
// Start:  cargo run --features window --bin spike3d
// (braucht eine aktive Wayland-/X11-Session; headless nicht sichtbar verifizierbar).

use std::sync::Arc;

use render3d::gpu::Renderer;
use render3d::math::orbit_eye;
use render3d::types::{Camera, Projection, WallInput};

use winit::application::ApplicationHandler;
use winit::event::{ElementState, MouseButton, MouseScrollDelta, WindowEvent};
use winit::event_loop::{ActiveEventLoop, EventLoop};
use winit::window::{Window, WindowId};

/// Demo-Szene: ein rechteckiger Raum (4 Aussenwaende) plus eine Innenwand. Achsen
/// in Meter; Dicke 0.2 m, Hoehe 2.6 m. Genug, um Extrusion, Tiefenpuffer und
/// Beleuchtung im Orbit zu beurteilen.
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
        openings: vec![],
        layers: None,
        holes: vec![],
    };
    // Raum 6 x 4 m.
    vec![
        mk([0.0, 0.0], [6.0, 0.0]), // Sued
        mk([6.0, 0.0], [6.0, 4.0]), // Ost
        mk([6.0, 4.0], [0.0, 4.0]), // Nord
        mk([0.0, 4.0], [0.0, 0.0]), // West
        mk([3.0, 0.0], [3.0, 2.5]), // Innenwand (Teilung)
    ]
}

/// Zielpunkt (Raum-Mitte in world) und Start-Abstand fuer die Orbit-Kamera.
fn scene_target() -> [f32; 3] {
    // Raum 6x4 in der XZ-Ebene, Wandmitte-Hoehe ~1.3.
    [3.0, 1.3, 2.0]
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
        let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
            label: Some("3d.device"),
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

        let mut renderer = Renderer::new(&device, format);
        renderer.upload_walls(&device, &demo_walls());

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

    fn render(&mut self, camera: &Camera) {
        // wgpu 29: `get_current_texture` liefert ein Enum statt eines Results —
        // Suboptimal ist weiterhin praesentierbar, Lost/Outdated -> rekonfigurieren.
        let frame = match self.surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(f)
            | wgpu::CurrentSurfaceTexture::Suboptimal(f) => f,
            wgpu::CurrentSurfaceTexture::Lost | wgpu::CurrentSurfaceTexture::Outdated => {
                self.surface.configure(&self.device, &self.config);
                return;
            }
            other => {
                eprintln!("Surface-Fehler: {other:?}");
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
            camera,
            (self.config.width, self.config.height),
        );
        frame.present();
    }
}

/// Orbit-Zustand: Yaw/Pitch (Radiant) + Abstand. Steuert die Kamera-Position um
/// das feste Ziel (Raum-Mitte).
struct Orbit {
    yaw: f32,
    pitch: f32,
    dist: f32,
}

impl Default for Orbit {
    fn default() -> Self {
        // Schraeg von vorn-oben-rechts, ~10 m Abstand.
        Self {
            yaw: std::f32::consts::FRAC_PI_4,
            pitch: 0.5,
            dist: 11.0,
        }
    }
}

impl Orbit {
    fn camera(&self) -> Camera {
        let target = scene_target();
        Camera {
            eye: orbit_eye(target, self.yaw, self.pitch, self.dist),
            target,
            up: [0.0, 1.0, 0.0],
            projection: Projection::Perspective,
            ..Camera::default()
        }
    }
}

#[derive(Default)]
struct App {
    state: Option<GpuState>,
    orbit: Orbit,
    dragging: bool,
    last_cursor: (f64, f64),
}

impl ApplicationHandler for App {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        if self.state.is_some() {
            return;
        }
        let attrs = Window::default_attributes().with_title("render3d — Spike (Orbit)");
        let window = Arc::new(event_loop.create_window(attrs).expect("Fenster erstellen"));
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
                    // Maus-Delta -> Yaw/Pitch (Radiant je px). Pitch klemmt orbit_eye.
                    let dx = (position.x - self.last_cursor.0) as f32;
                    let dy = (position.y - self.last_cursor.1) as f32;
                    self.orbit.yaw -= dx * 0.01;
                    self.orbit.pitch += dy * 0.01;
                    let limit = std::f32::consts::FRAC_PI_2 - 0.01;
                    self.orbit.pitch = self.orbit.pitch.clamp(-limit, limit);
                    state.window.request_redraw();
                }
                self.last_cursor = (position.x, position.y);
            }
            WindowEvent::MouseWheel { delta, .. } => {
                let step = match delta {
                    MouseScrollDelta::LineDelta(_, y) => y,
                    MouseScrollDelta::PixelDelta(p) => (p.y as f32) / 40.0,
                };
                // Rad -> Abstand (multiplikativ), geklemmt auf sinnvollen Bereich.
                let factor = if step > 0.0 { 0.9 } else { 1.0 / 0.9 };
                self.orbit.dist = (self.orbit.dist * factor).clamp(1.5, 200.0);
                state.window.request_redraw();
            }
            WindowEvent::RedrawRequested => {
                let cam = self.orbit.camera();
                state.render(&cam);
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
