// Browser-Bindings (wasm32 + WebGPU): fuehrt die native GPU-Schicht (`gpu::Renderer`)
// als WASM-Modul in die App-UI, mit einer HTML-Canvas als wgpu-Surface. Bewusst
// duenn — die gesamte Zeichenlogik (Tessellierung, Pipelines, Text) ist mit dem
// nativen Fenster geteilt; hier liegt nur die Canvas-/WebGPU-Anbindung + die
// wasm-bindgen-Fassade.
//
// Ablauf im Frontend (siehe src/views/plan/wasmRendererSession.ts, einziger Aufrufer; baut
// nach Geraeteverlust `is_lost()`/`set_lost_callback` einen neuen Renderer):
//   const r = await WebPlanRenderer.new(canvas, undefined);
//   r.set_scene_bin(encodeRenderScene(planToRenderScene(plan)));
//   r.set_view_box(x, y, w, h); r.resize(px_w, px_h); r.render();
//
// Szenenformat = Binaerpuffer (`scene_bin.rs`), dekodiert zu render2d::types::Scene. Pan/Zoom aendern nur die ViewBox (kein Re-Tess).

use std::cell::RefCell;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;

use wasm_bindgen::prelude::*;
use web_sys::HtmlCanvasElement;

use crate::gpu::Renderer;
use crate::scene_bin::decode_scene;
use crate::types::ViewBox;

/// Eingebettete Plan-Schrift (Inter). cosmic-text findet auf wasm KEINE
/// Systemfonts — ohne eingebettete Bytes bliebe der Grundriss textlos. Die
/// Familie meldet sich als "Inter Variable"; `Renderer::load_font` uebernimmt
/// den tatsaechlichen Namen automatisch.
const INTER_TTF: &[u8] = include_bytes!("../assets/Inter.ttf");

// Geraeteverlust (`device.lost`): wgpu verlangt einen `Send`-Rueckruf, eine JS-Funktion ist
// das nicht. Der Rueckruf traegt daher nur die Renderer-Nummer; die JS-Funktion liegt hier
// (WASM ist einfaedig, der Rueckruf laeuft im Ereignis-Takt des Browsers).
thread_local! {
    static LOST_CALLBACKS: RefCell<Vec<(u32, js_sys::Function)>> = const { RefCell::new(Vec::new()) };
}
static NEXT_RENDERER_ID: AtomicU32 = AtomicU32::new(1);

fn notify_lost(id: u32) {
    // Funktion zuerst herausnehmen: ein Rueckruf darf selbst wieder Renderer anlegen.
    let f = LOST_CALLBACKS.with(|c| {
        let mut c = c.borrow_mut();
        let pos = c.iter().position(|(i, _)| *i == id)?;
        Some(c.swap_remove(pos).1)
    });
    if let Some(f) = f {
        let _ = f.call0(&JsValue::NULL);
    }
}

/// Der Browser-Renderer: haelt Surface + Device/Queue + den geteilten `Renderer`
/// und die aktuelle ViewBox. Wird per `WebPlanRenderer.new(canvas)` aus JS erzeugt.
#[wasm_bindgen]
pub struct WebPlanRenderer {
    surface: wgpu::Surface<'static>,
    device: wgpu::Device,
    queue: wgpu::Queue,
    config: wgpu::SurfaceConfiguration,
    renderer: Renderer,
    view_box: ViewBox,
    /// Nummer fuer den Rueckruf bei Geraeteverlust.
    id: u32,
    /// Gesetzt aus `device.lost`. Danach ruft KEINE Methode mehr wgpu auf: auf einem
    /// verlorenen Geraet wirft z. B. `createBuffer(mappedAtCreation)` (auch in glyphon),
    /// wgpu macht daraus einen Panic, und das Objekt bliebe fuer immer gesperrt.
    lost: Arc<AtomicBool>,
}

impl Drop for WebPlanRenderer {
    fn drop(&mut self) {
        let id = self.id;
        LOST_CALLBACKS.with(|c| c.borrow_mut().retain(|(i, _)| *i != id));
    }
}

#[wasm_bindgen]
impl WebPlanRenderer {
    /// Erzeugt den Renderer asynchron (Adapter/Device via WebGPU). `font_bytes`
    /// optional — ohne Angabe wird die eingebettete Inter-Schrift genutzt.
    /// Aus JS: `await WebPlanRenderer.new(canvasEl, undefined)`.
    #[allow(clippy::new_ret_no_self)]
    pub async fn new(
        canvas: HtmlCanvasElement,
        font_bytes: Option<Vec<u8>>,
    ) -> Result<WebPlanRenderer, JsValue> {
        // Panics als lesbare Konsolen-Fehler statt "unreachable" ausgeben.
        console_error_panic_hook::set_once();

        let width = canvas.width().max(1);
        let height = canvas.height().max(1);

        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
            backends: wgpu::Backends::BROWSER_WEBGPU,
            ..wgpu::InstanceDescriptor::new_without_display_handle()
        });
        let surface = instance
            .create_surface(wgpu::SurfaceTarget::Canvas(canvas))
            .map_err(|e| JsValue::from_str(&format!("create_surface: {e:?}")))?;

        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::HighPerformance,
                force_fallback_adapter: false,
                compatible_surface: Some(&surface),
            })
            .await
            .map_err(|e| {
                JsValue::from_str(&format!("kein WebGPU-Adapter (navigator.gpu?): {e}"))
            })?;

        // `downlevel_webgl2_defaults()` setzt u. a. `max_buffer_size` fix auf den
        // konservativen WebGL2-Kompatibilitätswert — `using_resolution` hebt davon
        // NUR die auflösungsbezogenen Felder (Textur-/Viewport-Grössen) auf die
        // Adapter-Werte an, `max_buffer_size` bleibt unberührt klein. Für diese
        // App irrelevant (nur `Backends::BROWSER_WEBGPU`, kein WebGL2-Fallback),
        // aber real limitierend für grosse `set_scene_bin`-Tessellierungen (Nutzer-
        // Report 2026-10-09, Kataster-Import). Stattdessen direkt die ECHTEN
        // Adapter-Limits anfordern (s. render3d/src/web.rs, gleicher Fix).
        let (device, queue) = adapter
            .request_device(&wgpu::DeviceDescriptor {
                label: Some("render2d.web.device"),
                required_features: wgpu::Features::empty(),
                required_limits: adapter.limits(),
                experimental_features: wgpu::ExperimentalFeatures::disabled(),
                memory_hints: wgpu::MemoryHints::Performance,
                trace: wgpu::Trace::Off,
            })
            .await
            .map_err(|e| JsValue::from_str(&format!("request_device: {e:?}")))?;

        // WebGPU-Canvas liefert i.d.R. bgra8unorm (kein sRGB-Format fuer die
        // Surface). Wir nehmen das erste angebotene Format — MSAA-Textur nutzt
        // dasselbe (siehe Renderer::ensure_msaa).
        let caps = surface.get_capabilities(&adapter);
        let format = caps
            .formats
            .iter()
            .copied()
            .find(|f| !f.is_srgb())
            .unwrap_or(caps.formats[0]);
        let config = wgpu::SurfaceConfiguration {
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            format,
            width,
            height,
            present_mode: wgpu::PresentMode::Fifo,
            alpha_mode: caps.alpha_modes[0],
            view_formats: vec![],
            desired_maximum_frame_latency: 2,
        };
        surface.configure(&device, &config);

        // Geraeteverlust merken (und JS melden, s. `set_lost_callback`).
        let id = NEXT_RENDERER_ID.fetch_add(1, Ordering::Relaxed);
        let lost = Arc::new(AtomicBool::new(false));
        {
            let lost = lost.clone();
            device.set_device_lost_callback(move |reason, msg| {
                lost.store(true, Ordering::SeqCst);
                web_sys::console::warn_1(&JsValue::from_str(&format!(
                    "render2d: WebGPU-Geraet verloren ({reason:?}): {msg}"
                )));
                notify_lost(id);
            });
        }
        // Validierungsfehler melden statt paniken (wgpus Vorgabe-Handler paniert).
        device.on_uncaptured_error(Arc::new(|e: wgpu::Error| {
            web_sys::console::warn_1(&JsValue::from_str(&format!("render2d WebGPU-Fehler: {e}")));
        }));

        let mut renderer = Renderer::new(&device, format);
        // Font einspielen: uebergebene Bytes ODER die eingebettete Inter-Schrift.
        renderer.load_font(font_bytes.unwrap_or_else(|| INTER_TTF.to_vec()));

        web_sys::console::log_1(&JsValue::from_str(&format!(
            "render2d WebGPU-Viewport initialisiert ({}x{}, {:?})",
            width, height, format
        )));

        Ok(WebPlanRenderer {
            surface,
            device,
            queue,
            config,
            renderer,
            // Platzhalter bis set_view_box; verhindert Division durch 0.
            view_box: ViewBox::new(0.0, 0.0, width as f32, height as f32),
            id,
            lost,
        })
    }

    /// true, sobald das WebGPU-Geraet verloren ist: dann zeichnet dieser Renderer nichts
    /// mehr, der Aufrufer baut einen neuen (`src/views/plan/wasmRendererSession.ts`).
    pub fn is_lost(&self) -> bool {
        self.lost.load(Ordering::SeqCst)
    }

    /// JS-Funktion, die beim Geraeteverlust (einmal) gerufen wird.
    pub fn set_lost_callback(&self, f: js_sys::Function) {
        let id = self.id;
        LOST_CALLBACKS.with(|c| {
            let mut c = c.borrow_mut();
            c.retain(|(i, _)| *i != id);
            c.push((id, f));
        });
    }

    /// Setzt die zu zeichnende Szene aus dem Binaerformat von `scene_bin.rs` (Schreiber:
    /// `src-tauri/core/src/plan_scene.rs`). Fremde Version/kaputte Daten → Fehler, die alte
    /// Szene bleibt. Re-tesselliert + laedt die GPU-Puffer; ruft NICHT selbst `render`.
    pub fn set_scene_bin(&mut self, bytes: &[u8]) -> Result<(), JsValue> {
        let scene = decode_scene(bytes).map_err(|e| JsValue::from_str(&format!("Szene lesen: {e}")))?;
        if self.is_lost() {
            return Ok(());
        }
        self.renderer.upload_scene_queued(&self.device, &self.queue, &scene);
        Ok(())
    }

    /// Aktuellen Ausschnitt (viewBox-Einheiten, Bildschirm-Raum) setzen. Aendert
    /// nur die Ortho-Matrix im naechsten `render` (kein Re-Tessellieren).
    pub fn set_view_box(&mut self, x: f32, y: f32, w: f32, h: f32) {
        self.view_box = ViewBox::new(x, y, w, h);
    }

    /// Papier-Massstab-Nenner (1:N) fuer echte mm-Strichbreiten setzen.
    pub fn set_paper_scale(&mut self, n: f32) {
        if n > 0.0 {
            self.renderer.paper_scale_n = n;
        }
    }

    /// Papier-Massstab-Nenner (1:N) NUR fuer die Text-Schriftgroesse setzen —
    /// entkoppelt von `set_paper_scale` (siehe `Renderer::text_scale_n`-Doku).
    pub fn set_text_scale(&mut self, n: f32) {
        if n > 0.0 {
            self.renderer.text_scale_n = n;
        }
    }

    /// Surface an eine neue Pixelgroesse anpassen (DPR beachtet der Aufrufer).
    pub fn resize(&mut self, width: u32, height: u32) {
        let (w, h) = (width.max(1), height.max(1));
        if self.is_lost() || (self.config.width == w && self.config.height == h) {
            return;
        }
        self.config.width = w;
        self.config.height = h;
        self.surface.configure(&self.device, &self.config);
    }

    /// Zeichnet EINEN Frame in die Surface-Textur.
    pub fn render(&mut self) {
        if self.is_lost() {
            return;
        }
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
                web_sys::console::warn_1(&JsValue::from_str(&format!(
                    "render2d Surface-Fehler: {other:?}"
                )));
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
            self.view_box,
            (self.config.width, self.config.height),
        );
        frame.present();
    }
}
