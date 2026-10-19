// Stufe 2 (macOS): die native wgpu-Flaeche sitzt als Kind-View im HAUPTfenster,
// UNTER der (transparent gemachten) Webview, exakt hinter dem Plan-Bereich.
//
// Die Webview bleibt fuer ALLE Eingaben und Overlays zustaendig (Auswahl,
// Griffe, Fang, Text) und liegt vorne; die native Flaeche liefert nur die
// Pixel der grossen Geometrie. Position/Groesse kommt aus der Webview
// (`native2d_embed_rect`, CSS-Pixel des Plan-Containers).

use std::ptr::NonNull;
use std::sync::Mutex;

use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::{msg_send, MainThreadMarker};
use objc2_app_kit::{NSView, NSWindowOrderingMode};
use objc2_foundation::{NSPoint, NSRect, NSSize, NSString};
use raw_window_handle::{
    AppKitDisplayHandle, AppKitWindowHandle, RawDisplayHandle, RawWindowHandle,
};
use render2d::chunks::{ChunkGeom, ChunkRenderer, TextIn, View};
use tauri::{AppHandle, Manager};

struct Embedded {
    ns_view: Retained<NSView>,
    surface: wgpu::Surface<'static>,
    device: wgpu::Device,
    queue: wgpu::Queue,
    config: wgpu::SurfaceConfiguration,
    renderer: ChunkRenderer,
    view: View,
    paper_scale: f64,
}

// NSView ist nicht Send; wir fassen es nur auf dem Hauptthread an
// (Tauri-Commands mit `run_on_main_thread`).
unsafe impl Send for Embedded {}

#[derive(Default)]
pub struct EmbedState(Mutex<Option<Embedded>>);

/// Macht die Webview transparent (kein weisser/deckender Hintergrund), damit
/// die native Flaeche dahinter durchscheint.
fn make_webview_transparent(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.with_webview(|wv| unsafe {
            let ptr = wv.inner() as *mut AnyObject;
            let no: Retained<AnyObject> =
                msg_send![objc2::class!(NSNumber), numberWithBool: false];
            let key = NSString::from_str("drawsBackground");
            let _: () = msg_send![ptr, setValue: &*no, forKey: &*key];
        });
    }
}

/// Legt die Flaeche an (beim ersten Aufruf) bzw. verschiebt/skaliert sie.
/// Koordinaten: CSS-Pixel relativ zur Webview-Oberkante links.
pub fn set_rect(app: &AppHandle, x: f64, y: f64, w: f64, h: f64) {
    let app2 = app.clone();
    let _ = app.run_on_main_thread(move || {
        let Some(mtm) = MainThreadMarker::new() else { return };
        let Some(win) = app2.get_webview_window("main") else { return };
        let Ok(parent_ptr) = win.ns_view() else { return };
        let parent: &NSView = unsafe { &*(parent_ptr as *const NSView) };
        let scale = win.scale_factor().unwrap_or(1.0);
        let pb = parent.bounds();
        // NSView-Ursprung ist unten links → y spiegeln.
        let frame = NSRect::new(
            NSPoint::new(x, pb.size.height - (y + h)),
            NSSize::new(w.max(1.0), h.max(1.0)),
        );
        let state = app2.state::<EmbedState>();
        let mut guard = state.0.lock().expect("embed lock");
        if let Some(e) = guard.as_mut() {
            e.ns_view.setHidden(false);
            e.ns_view.setFrame(frame);
            e.config.width = ((w * scale) as u32).max(1);
            e.config.height = ((h * scale) as u32).max(1);
            e.surface.configure(&e.device, &e.config);
            draw(e);
            return;
        }
        let view = NSView::initWithFrame(mtm.alloc::<NSView>(), frame);
        view.setWantsLayer(true);
        // Unter alle vorhandenen Geschwister (= unter die Webview).
        parent.addSubview_positioned_relativeTo(&view, NSWindowOrderingMode::Below, None);
        make_webview_transparent(&app2);
        let (surface, device, queue, config, adapter_flags) = create_surface(&view, w * scale, h * scale);
        let samples = [8u32, 4]
            .into_iter()
            .find(|s| adapter_flags.sample_count_supported(*s))
            .unwrap_or(4);
        let renderer = ChunkRenderer::new(&device, config.format, samples);
        let mut e = Embedded {
            ns_view: view,
            surface,
            device,
            queue,
            config,
            renderer,
            view: View { x: 0.0, y: 0.0, w: 1.0, h: 1.0 },
            paper_scale: 100.0,
        };
        draw(&mut e);
        *guard = Some(e);
        drop(guard);
        let app3 = app2.clone();
        std::thread::spawn(move || {
            for _ in 0..5 {
                std::thread::sleep(std::time::Duration::from_millis(300));
                let a = app3.clone();
                let _ = app3.run_on_main_thread(move || {
                    if let Some(e) = a.state::<EmbedState>().0.lock().unwrap().as_mut() {
                        draw(e);
                    }
                });
            }
        });
    });
}

fn draw(e: &mut Embedded) {
    let frame = match e.surface.get_current_texture() {
        wgpu::CurrentSurfaceTexture::Success(f) | wgpu::CurrentSurfaceTexture::Suboptimal(f) => f,
        wgpu::CurrentSurfaceTexture::Lost | wgpu::CurrentSurfaceTexture::Outdated => {
            e.surface.configure(&e.device, &e.config);
            return;
        }
        other => {
            eprintln!("native2d embed: Surface {other:?}");
            return;
        }
    };
    let tv = frame.texture.create_view(&wgpu::TextureViewDescriptor::default());
    e.renderer.render(&e.device, &e.queue, &tv, e.view, (e.config.width, e.config.height), e.paper_scale);
    frame.present();
}

fn create_surface(
    view: &NSView,
    pw: f64,
    ph: f64,
) -> (wgpu::Surface<'static>, wgpu::Device, wgpu::Queue, wgpu::SurfaceConfiguration, wgpu::TextureFormatFeatureFlags) {
    let instance = wgpu::Instance::default();
    let surface = unsafe {
        instance.create_surface_unsafe(wgpu::SurfaceTargetUnsafe::RawHandle {
            raw_display_handle: Some(RawDisplayHandle::AppKit(AppKitDisplayHandle::new())),
            raw_window_handle: RawWindowHandle::AppKit(AppKitWindowHandle::new(
                NonNull::from(view).cast(),
            )),
        })
    }
    .expect("Surface erstellen");
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        power_preference: wgpu::PowerPreference::HighPerformance,
        force_fallback_adapter: false,
        compatible_surface: Some(&surface),
    }))
    .expect("kein passender GPU-Adapter");
    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
        label: Some("native2d.embed.device"),
        required_features: wgpu::Features::empty(),
        required_limits: adapter.limits(),
        experimental_features: wgpu::ExperimentalFeatures::disabled(),
        memory_hints: wgpu::MemoryHints::Performance,
        trace: wgpu::Trace::Off,
    }))
    .expect("Device anfordern");
    let caps = surface.get_capabilities(&adapter);
    let format = caps.formats.iter().copied().find(|f| !f.is_srgb()).unwrap_or(caps.formats[0]);
    let config = wgpu::SurfaceConfiguration {
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
        format,
        width: (pw as u32).max(1),
        height: (ph as u32).max(1),
        present_mode: caps.present_modes[0],
        alpha_mode: caps.alpha_modes[0],
        view_formats: vec![],
        desired_maximum_frame_latency: 2,
    };
    surface.configure(&device, &config);
    let flags = adapter.get_texture_format_features(format).flags;
    (surface, device, queue, config, flags)
}

/// Roh-Bytes eines Puffers ablegen (Vertex-/Indexdaten eines Chunks).
pub fn upload(app: &AppHandle, id: u32, bytes: &[u8]) {
    if let Some(e) = app.state::<EmbedState>().0.lock().unwrap().as_mut() {
        e.renderer.upload(&e.device, id, bytes);
    }
}

/// Chunk-Layout setzen, nicht mehr benoetigte Puffer freigeben, neu zeichnen.
pub fn set_layout(app: &AppHandle, layout: Vec<ChunkGeom>, delete: Vec<u32>) {
    if let Some(e) = app.state::<EmbedState>().0.lock().unwrap().as_mut() {
        e.renderer.delete(&delete);
        e.renderer.set_layout(layout);
        draw(e);
    }
}

/// Ausschnitt (Pan/Zoom) setzen und zeichnen — der einzige Pro-Frame-Aufruf.
pub fn frame(app: &AppHandle, view: View, paper_scale: f64, clear: Option<[f64; 3]>) {
    if let Some(e) = app.state::<EmbedState>().0.lock().unwrap().as_mut() {
        e.view = view;
        e.paper_scale = paper_scale;
        if let Some(c) = clear {
            e.renderer.clear = c;
        }
        draw(e);
    }
}

/// Flaeche ausblenden (Plan-Ansicht nicht sichtbar, z. B. 3D-Reiter).
pub fn hide(app: &AppHandle) {
    let app2 = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(e) = app2.state::<EmbedState>().0.lock().unwrap().as_mut() {
            e.ns_view.setHidden(true);
        }
    });
}

/// Texte einfuegen/entfernen und neu zeichnen. `false` = keine Schrift verfuegbar
/// (die Webview zeichnet die Texte dann weiter im SVG-Overlay).
pub fn set_texts(app: &AppHandle, upsert: Vec<TextIn>, remove: Vec<u32>) -> bool {
    match app.state::<EmbedState>().0.lock().unwrap().as_mut() {
        Some(e) => {
            let ok = e.renderer.set_texts(upsert, &remove);
            draw(e);
            ok
        }
        None => false,
    }
}

/// Geaenderte Bereiche eines Puffers einspielen und ihn unter neuer ID fuehren.
pub fn patch(app: &AppHandle, from: u32, to: u32, ranges: &[(u64, u64)], bytes: &[u8]) -> bool {
    match app.state::<EmbedState>().0.lock().unwrap().as_mut() {
        Some(e) => e.renderer.patch(&e.queue, from, to, ranges, bytes),
        None => false,
    }
}
