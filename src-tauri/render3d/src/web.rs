// Browser-Bindings (wasm32 + WebGPU): fuehrt die native GPU-Schicht (`gpu::Renderer`)
// als WASM-Modul in die App-UI, mit einer HTML-Canvas als wgpu-Surface. Bewusst
// duenn — die gesamte Zeichenlogik (Wand-/Decken-Extrusion, Pipeline, Licht) ist
// mit dem nativen Fenster-Spike (bin/spike3d) geteilt; hier liegt nur die Canvas-/
// WebGPU-Anbindung + die wasm-bindgen-Fassade. Muster: render2d/src/web.rs.
//
// Ablauf im Frontend (siehe src/viewport/useWasm3dRenderer.ts):
//   const r = await WebModelRenderer.new(canvas);
//   r.set_model(JSON.stringify(projectToModel3d(project))); // bei Modelländerung
//   r.set_camera(eye.x, eye.y, eye.z, target.x, target.y, target.z,
//                up.x, up.y, up.z, perspective, fovY, orthoHalfHeight);
//   r.resize(px_w, px_h); r.render(); // pro Frame
//
// KAMERA: zwei Wege, dieselbe `Camera`. `set_camera` nimmt eine FERTIGE Kamera
// (eye/target/up + Projektionsart) entgegen — die freie Orbit/Pan/Zoom-Interaktion
// (Yaw/Pitch/Distanz) rechnet weiterhin die TS-Seite (`math::orbit_eye`-Konvention),
// damit die Maus-UX 1:1 der bestehenden three.js-OrbitControls-Bedienung folgt.
// `set_view_preset` wendet stattdessen eines der `View3d`-Praesete (front/back/
// top/side/left/iso/isoFrontLeft/isoBackRight/isoBackLeft/perspective) direkt
// ueber `math::preset_camera` an — alle ausser Perspective werden dabei ECHT
// orthografisch (`preset_camera`; die Iso-Varianten = echte Isometrie ohne
// perspektivische Verzerrung), was eine reine TS-Orbit-Naeherung nicht leisten
// kann. Nach einem Praeset-Sprung bleibt die weitere Navigation frei ueber
// `set_camera` (kein Lock).
//
// MODELL-FORMAT: JSON-Struct { walls: WallInput[], slabs: SlabInput[] } — identisch
// zu `RModel3d` (src/plan/toWalls3d.ts) und zum nativen Tauri-Push (nativeSync.ts).

use serde::Deserialize;
use wasm_bindgen::prelude::*;
use web_sys::HtmlCanvasElement;

use crate::gpu::Renderer;
use crate::math::preset_camera;
use crate::section::{cut_section, SectionPlane};
use crate::scene::{PartEntry, PartInput, PartsUpdate};
use crate::types::{Camera, CameraPreset, MeshInput, Projection, RoofLayerInput, SlabInput, WallInput};

/// JSON-Eingabe des Modells: Waende (bereits in Teilquader zerlegt, siehe
/// `projectToWalls3d`) + Deckenplatten. `slabs` optional (leeres Modell ohne
/// Decken bleibt gueltig).
#[derive(Deserialize)]
struct ModelInput {
    walls: Vec<WallInput>,
    #[serde(default)]
    slabs: Vec<SlabInput>,
    /// Rohe Kontext-Meshes (Terrain/importierte Volumen). `#[serde(default)]`
    /// haelt aeltere Payloads ohne `meshes` gueltig.
    #[serde(default)]
    meshes: Vec<MeshInput>,
    /// Dach-Schichten fuer den Live-Schnitt (`section::cut_section`/
    /// `roof_cut::cut_roof_layer`) — separat von `meshes` (die reine
    /// Render-Geometrie, kein Prisma-kompatibles Format). `#[serde(default)]`
    /// haelt aeltere Payloads ohne `roofLayers` gueltig (Daecher zeigen dann
    /// im Live-Schnitt weiterhin keine Cut-Flaeche/-Fugenlinien, wie bisher).
    #[serde(default, rename = "roofLayers")]
    roof_layers: Vec<RoofLayerInput>,
}

/// Berechnet einen Schnitt/eine Ansicht (`section::cut_section`) gegen das Modell
/// und gibt das `SectionOutput` als JSON-String zurueck. GPU-frei — reine
/// Prismen-Arithmetik (siehe `section.rs`); braucht KEINEN `WebModelRenderer`
/// (kein WebGPU-Kontext), nur das geladene WASM-Modul. Aufruf aus JS:
///
/// ```js
/// const json = mod.cut_section_json(
///   JSON.stringify({ walls, slabs }), // gleiches Format wie set_model
///   px, py, pz,   // Punkt auf der Schnittebene (world-Meter, Y-up)
///   nx, ny, nz,   // Ebenennormale = Blickrichtung (wird normalisiert)
/// );
/// const out = JSON.parse(json); // { cutPolygons, visibleEdges, hiddenEdges }
/// ```
///
/// Koordinaten der Ausgabe: (u, v) in Metern — `u` horizontal entlang der
/// Ebene, `v = world.y` (absolute Hoehe). Siehe `section.rs`-Moduldoc.
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn cut_section_json(
    model_json: &str,
    px: f32,
    py: f32,
    pz: f32,
    nx: f32,
    ny: f32,
    nz: f32,
) -> Result<String, JsValue> {
    let model: ModelInput = serde_json::from_str(model_json)
        .map_err(|e| JsValue::from_str(&format!("Modell parsen: {e}")))?;
    let plane = SectionPlane::new([px, py, pz], [nx, ny, nz]);
    let out = cut_section(&plane, &model.walls, &model.slabs, &model.roof_layers);
    serde_json::to_string(&out)
        .map_err(|e| JsValue::from_str(&format!("SectionOutput serialisieren: {e}")))
}

/// Der Browser-Renderer: haelt Surface + Device/Queue + den geteilten `Renderer`
/// und die aktuelle Kamera. Wird per `WebModelRenderer.new(canvas)` aus JS erzeugt.
#[wasm_bindgen]
pub struct WebModelRenderer {
    surface: wgpu::Surface<'static>,
    device: wgpu::Device,
    queue: wgpu::Queue,
    config: wgpu::SurfaceConfiguration,
    renderer: Renderer,
    camera: Camera,
    /// Achsparallele Bounding-Box (min, max) des zuletzt gesetzten Modells,
    /// world-Meter (Y-up) — Grundlage fuer `set_view_preset` (formatfuellendes
    /// Ziel/Distanz, mirror der TS-`fitTargetDist` in Wasm3DViewport.tsx).
    /// `None` bei leerem Modell (kein Wall-/Slab-Vertex) oder vor `set_model`.
    bounds: Option<([f32; 3], [f32; 3])>,
    /// Wand-/Decken-/Dach-Schicht-Eingabe des Modells fuer den Live-Schnitt (`cut_section`), aus den
    /// Teilen der Szene zusammengesetzt — erst bei aktivem Schnitt, verworfen bei jeder Modell-Aenderung.
    section_inputs: Option<(Vec<WallInput>, Vec<SlabInput>, Vec<RoofLayerInput>)>,
    /// Aktueller Live-Schnitt-Zustand: aktiv? + Ebene (point/normal). Gemerkt,
    /// damit ein `set_model` bei aktivem Schnitt die Caps automatisch neu baut.
    section: Option<([f32; 3], [f32; 3])>,
}

impl WebModelRenderer {
    /// Wendet ein Teil-Update an, merkt die Ausdehnung und baut bei aktivem Schnitt die Kappen neu.
    fn apply_parts(&mut self, upd: PartsUpdate) -> usize {
        let ch = self.renderer.update_parts(&self.device, upd);
        self.bounds = self.renderer.scene().bounds();
        self.section_inputs = None;
        if let Some((point, normal)) = self.section {
            self.refresh_section(true, point, normal);
        }
        ch.remeshed
    }

    fn refresh_section(&mut self, active: bool, point: [f32; 3], normal: [f32; 3]) {
        if active && self.section_inputs.is_none() {
            self.section_inputs = Some(self.renderer.scene().collect_inputs());
        }
        let empty = (Vec::new(), Vec::new(), Vec::new());
        let (w, s, r) = self.section_inputs.as_ref().unwrap_or(&empty);
        self.renderer.update_section(&self.device, active, point, normal, w, s, r);
    }
}

#[wasm_bindgen]
impl WebModelRenderer {
    /// Erzeugt den Renderer asynchron (Adapter/Device via WebGPU).
    /// Aus JS: `await WebModelRenderer.new(canvasEl)`.
    #[allow(clippy::new_ret_no_self)]
    pub async fn new(canvas: HtmlCanvasElement) -> Result<WebModelRenderer, JsValue> {
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
        // aber real limitierend: der binäre Linienbuffer für grosse 2D-Importe
        // (`set_drawing_lines`, Nutzer-Report 2026-10-09: 439-MB-Kataster-Import,
        // ~168 MB Vertexdaten) überschreitet den WebGL2-Downlevel-Wert locker.
        // Stattdessen direkt die ECHTEN Adapter-Limits anfordern.
        let (device, queue) = adapter
            .request_device(&wgpu::DeviceDescriptor {
                label: Some("render3d.web.device"),
                required_features: wgpu::Features::empty(),
                required_limits: adapter.limits(),
                experimental_features: wgpu::ExperimentalFeatures::disabled(),
                memory_hints: wgpu::MemoryHints::Performance,
                trace: wgpu::Trace::Off,
            })
            .await
            .map_err(|e| JsValue::from_str(&format!("request_device: {e:?}")))?;

        // WebGPU-Canvas liefert i.d.R. bgra8unorm (kein sRGB-Format fuer die
        // Surface) — Format vom Kontext abfragen statt hart zu kodieren (dieselbe
        // Wahl wie render2d: erstes NICHT-sRGB-Format, sonst das erste angebotene).
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

        let renderer = Renderer::new(&device, format);

        web_sys::console::log_1(&JsValue::from_str(&format!(
            "render3d WebGPU-Viewport initialisiert ({}x{}, {:?})",
            width, height, format
        )));

        Ok(WebModelRenderer {
            surface,
            device,
            queue,
            config,
            renderer,
            camera: Camera::default(),
            bounds: None,
            section_inputs: None,
            section: None,
        })
    }

    /// Setzt/aktualisiert das darzustellende Modell aus einem JSON-String
    /// (Format = `{ walls: WallInput[], slabs?: SlabInput[], meshes?, roofLayers? }`, identisch zum
    /// nativen Push) — als einziger Teil der Szene, alle GPU-Puffer neu. Ruft NICHT selbst `render`.
    /// Merkt sich zusaetzlich die Bounding-Box (fuer `set_view_preset`).
    pub fn set_model(&mut self, json: &str) -> Result<(), JsValue> {
        let model: ModelInput = serde_json::from_str(json)
            .map_err(|e| JsValue::from_str(&format!("Modell parsen: {e}")))?;
        let part = PartInput { walls: model.walls, slabs: model.slabs, meshes: model.meshes, roof_layers: model.roof_layers };
        self.apply_parts(PartsUpdate { reset: true, remove: Vec::new(), upsert: vec![PartEntry::new("", part)] });
        Ok(())
    }

    /// Teil-Update des Modells ([58], `scene.rs`): JSON `{ reset?, remove?: [id], upsert?: [{ id,
    /// walls?, slabs?, meshes?, roofLayers? }] }`. Ersetzt/entfernt nur die genannten Teile und laedt
    /// nur die betroffenen GPU-Klumpen neu hoch; `reset` leert vorher. Ruft NICHT selbst `render`.
    /// Gibt die Zahl der neu vernetzten Teile zurueck (Diagnose).
    pub fn set_parts(&mut self, json: &str) -> Result<u32, JsValue> {
        let upd: PartsUpdate =
            serde_json::from_str(json).map_err(|e| JsValue::from_str(&format!("Teile parsen: {e}")))?;
        Ok(self.apply_parts(upd) as u32)
    }

    /// Live-Schnitt ein-/ausschalten und die Schnittebene setzen. `active=false`
    /// hebt den Schnitt auf (Modell wieder komplett, keine Caps). `p*` = Punkt auf
    /// der Ebene, `n*` = Ebenennormale = Blickrichtung (world-Meter, Y-up; wird
    /// normalisiert). NUR VERTIKALE Ebenen sind sinnvoll (Normale ohne Y-Anteil —
    /// Annahme von `section.rs`). Kappt Mesh/Kanten/Grid per Shader-`discard` und
    /// baut aus den gecachten Waenden/Decken die Schnittflaechen-Schraffur (Caps).
    /// Wirkt erst beim naechsten `render`.
    #[allow(clippy::too_many_arguments)]
    pub fn set_section_plane(
        &mut self,
        active: bool,
        px: f32,
        py: f32,
        pz: f32,
        nx: f32,
        ny: f32,
        nz: f32,
    ) -> Result<(), JsValue> {
        let point = [px, py, pz];
        let normal = [nx, ny, nz];
        self.section = if active { Some((point, normal)) } else { None };
        self.refresh_section(active, point, normal);
        Ok(())
    }

    /// Setzt die Kamera fuer den naechsten `render`-Aufruf. `eye`/`target`/`up`
    /// in world-Metern (Y-up, wie `types::Camera`). `perspective=true` waehlt eine
    /// perspektivische Projektion (`fov_y` in Radiant), sonst orthografisch
    /// (`ortho_half_height` = halbe Sichthoehe in Metern). Die TS-Seite berechnet
    /// `eye` aus Orbit-Winkeln/Distanz oder einem Praeset (front/top/side/iso/persp)
    /// — siehe `useWasm3dRenderer`/`Wasm3DViewport`.
    ///
    /// FAR-EBENE: die feste `Camera::default()`-Far-Ebene (1000 m) reicht bei
    /// grossen georeferenzierten Importen (Suchradius bis 2000 m, Bounding-Kugel
    /// entsprechend gross) nicht mehr — Teile des Modells wurden je nach
    /// Blickwinkel/Distanz VOM FERN-CLIPPING abgeschnitten (Nutzer-Report: "Teile
    /// im 3D nicht sichtbar in einem Winkel"). Die Far-Ebene wird deshalb hier je
    /// Aufruf aus der zuletzt hochgeladenen Modell-Bounding-Box abgeleitet: der
    /// weiteste Bbox-Eckpunkt vom Auge aus + Sicherheitsmarge, mindestens der
    /// bisherige Default (kleine Modelle bleiben unveraendert).
    #[allow(clippy::too_many_arguments)]
    pub fn set_camera(
        &mut self,
        eye_x: f32,
        eye_y: f32,
        eye_z: f32,
        target_x: f32,
        target_y: f32,
        target_z: f32,
        up_x: f32,
        up_y: f32,
        up_z: f32,
        perspective: bool,
        fov_y: f32,
        ortho_half_height: f32,
    ) {
        let far = match self.bounds {
            Some((min, max)) => {
                let corners = [
                    [min[0], min[1], min[2]],
                    [max[0], min[1], min[2]],
                    [min[0], max[1], min[2]],
                    [max[0], max[1], min[2]],
                    [min[0], min[1], max[2]],
                    [max[0], min[1], max[2]],
                    [min[0], max[1], max[2]],
                    [max[0], max[1], max[2]],
                ];
                let mut max_dist = 0.0f32;
                for c in corners {
                    let dx = c[0] - eye_x;
                    let dy = c[1] - eye_y;
                    let dz = c[2] - eye_z;
                    let d = (dx * dx + dy * dy + dz * dz).sqrt();
                    if d > max_dist {
                        max_dist = d;
                    }
                }
                (max_dist * 1.5).max(crate::types::default_far())
            }
            None => crate::types::default_far(),
        };
        self.camera = Camera {
            eye: [eye_x, eye_y, eye_z],
            target: [target_x, target_y, target_z],
            up: [up_x, up_y, up_z],
            projection: if perspective {
                Projection::Perspective
            } else {
                Projection::Orthographic
            },
            fov_y,
            ortho_half_height,
            far,
            ..Camera::default()
        };
    }

    /// Wendet eines der Kardinal-/Iso-Kamera-Praesets der three.js-Sicht
    /// (`front`/`back`/`top`/`side`/`left`/`iso`/`isoFrontLeft`/`isoBackRight`/
    /// `isoBackLeft`/`perspective`, s. `View3d` in TopBar.tsx) auf das aktuelle
    /// Modell an: Ziel = Modell-Mitte, Distanz = formatfuellend (mirror der
    /// TS-`fitTargetDist`); alle Presets ausser Perspective werden orthografisch,
    /// nur Perspective ist perspektivisch (`math::preset_camera`). Wirkt erst beim
    /// naechsten `render`. „Praeset = hinspringen, kein Lock" — manuelles
    /// Orbit/Pan/Zoom bleibt danach frei ueber `set_camera` (s. Wasm3DViewport.tsx).
    pub fn set_view_preset(&mut self, preset: &str) -> Result<(), JsValue> {
        let preset = match preset {
            "front" => CameraPreset::Front,
            "back" => CameraPreset::Back,
            "top" => CameraPreset::Top,
            "side" => CameraPreset::Side,
            "left" => CameraPreset::Left,
            "iso" => CameraPreset::Iso,
            "isoFrontLeft" => CameraPreset::IsoFrontLeft,
            "isoBackRight" => CameraPreset::IsoBackRight,
            "isoBackLeft" => CameraPreset::IsoBackLeft,
            "perspective" => CameraPreset::Persp,
            other => {
                return Err(JsValue::from_str(&format!(
                    "unbekanntes Kamera-Praeset: {other}"
                )))
            }
        };
        // Modell UND sichtbare Punktwolken einpassen ([27]).
        let (target, dist) = self.fit_target_dist();
        self.camera = preset_camera(preset, target, dist);
        Ok(())
    }

    /// Bounding-Box aus Modell und sichtbaren Punktwolken → Ziel + Abstand (`math::fit_target_dist`).
    fn fit_target_dist(&self) -> ([f32; 3], f32) {
        let merged = crate::math::merge_bounds(self.bounds, self.renderer.point_cloud_bounds());
        crate::math::fit_target_dist(merged, crate::types::default_fov())
    }

    /// Formatfüllendes Ziel + Abstand für Modell + sichtbare Punktwolken (dieselbe Rechnung wie
    /// `set_view_preset`). Liefert `[tx, ty, tz, dist]` (world, Y-up), damit die TS-Seite ihren
    /// Orbit-Zustand daraus setzt statt die Rechnung zu spiegeln.
    pub fn view_fit(&self) -> Vec<f32> {
        let (t, d) = self.fit_target_dist();
        vec![t[0], t[1], t[2], d]
    }

    /// Aktuelle Kamera als `[eye(3), target(3), up(3), perspektivisch (1/0), fovY (rad), orthoHalbhöhe]`
    /// — 12 Werte, world Y-up. Für Lesezugriffe (BCF-Viewpoint, Orbit-Abgleich nach einem Preset).
    pub fn camera_state(&self) -> Vec<f32> {
        let c = &self.camera;
        vec![
            c.eye[0], c.eye[1], c.eye[2],
            c.target[0], c.target[1], c.target[2],
            c.up[0], c.up[1], c.up[2],
            if matches!(c.projection, Projection::Perspective) { 1.0 } else { 0.0 },
            c.fov_y,
            c.ortho_half_height,
        ]
    }

    /// Darstellungsart der Oberleiste setzen. Gueltige Werte:
    ///  - `"shaded"`   — beleuchtete Bauteilfarben (Default).
    ///  - `"white"`    — Clay-Look: einheitlich helles Material, beleuchtet
    ///    (identisch zum bisherigen `set_render_mode_white(true)`).
    ///  - `"textured"` — Material-Farbkarten je Wand-Band aus dem Textur-Array
    ///    (`set_material_textures`), Fallback-Schachbrett fuer Baender ohne Material.
    ///  - `"wireframe"`— nur Modell-Kanten (Feature-Edges), keine Flaechen.
    ///  - `"hidden"`   — Hidden-Line: flach-weisse Flaechen fuellen den Depth-
    ///    Buffer, dunkle Kanten liegen tiefengetestet obenauf (nur sichtbare).
    ///  - `"shaded-edges"` — "Schattiert mit Kanten" (typischer BIM-Look): wie
    ///    `"shaded"` (echte Bauteilfarben), ZUSAETZLICH dunkle Modell-Kanten
    ///    obenauf wie bei `"hidden"`.
    /// Unbekannte Werte fallen auf `"shaded"` zurueck. Wirkt erst beim naechsten
    /// `render`. Loest `set_render_mode_white` ab (das bleibt kompatibel).
    pub fn set_render_style(&mut self, style: &str) -> Result<(), JsValue> {
        self.renderer
            .set_render_style(crate::gpu::RenderStyle::from_str_or_shaded(style));
        Ok(())
    }

    /// Darstellungsart umschalten: `true` = weisses Clay-Material (beleuchtet,
    /// ohne Bauteil-Farben — Vectorworks „white"), `false` = normale Material-
    /// farbe (shaded, Default). Wirkt erst beim naechsten `render`. RUECKWAERTS-
    /// KOMPATIBEL — bildet intern auf denselben `render_style`-Zustand ab wie
    /// `set_render_style` (true→„white", false→„shaded"), sodass es keine zwei
    /// widersprechenden Zustaende gibt.
    pub fn set_render_mode_white(&mut self, white: bool) {
        self.renderer.set_white_mode(white);
    }

    /// Sonne der Sonnenstudie ([64]): Azimut (° von Nord im Uhrzeigersinn) und Hoehe (°) aus dem
    /// Kern (`sun_position`), `shadows` = Schatten im 3D zeichnen. `active = false` (keine Studie)
    /// oder Sonne unter dem Horizont: Standardlicht, keine Schatten. Der Schattenpass laeuft nur
    /// nach einer Aenderung, nicht je Kamera-Frame. Wirkt beim naechsten `render`. [212] Studie aktiv und
    /// Sonne unter dem Horizont: der Pathtracer zeigt einen Nachthimmel.
    pub fn set_sun(&mut self, active: bool, azimuth_deg: f64, elevation_deg: f64, shadows: bool) {
        let dir = if active { crate::shadow::sun_dir_world(azimuth_deg, elevation_deg) } else { None };
        self.renderer.set_sun(dir, shadows);
        self.renderer.set_night(active && elevation_deg.is_finite() && elevation_deg <= 0.0);
    }

    /// [212] Samples je Pixel des laufenden Pathtracing-Bildes (Stil `"pathtrace"`; 0 sonst). Der Viewport
    /// zeigt die Zahl an und zeichnet weiter, bis `pathtrace_done`.
    pub fn pathtrace_samples(&self) -> u32 {
        self.renderer.pathtrace_samples()
    }

    /// [212] Pathtracing-Bild fertig (Obergrenze erreicht)? Dann braucht es keine weiteren Bilder.
    pub fn pathtrace_done(&self) -> bool {
        self.renderer.pathtrace_done()
    }

    /// [212] Obergrenze der Samples je Pixel (Standard 1024; 0 → 1).
    pub fn set_pathtrace_max_samples(&mut self, n: u32) {
        self.renderer.set_pathtrace_max_samples(n);
    }

    /// [212] Samples je `render` (Standard 1; Bild-Export rechnet N auf einmal). 0 → 1.
    pub fn set_pathtrace_batch(&mut self, n: u32) {
        self.renderer.set_pathtrace_batch(n);
    }

    /// [212] Entrauscher des Pathtracers in der Anzeige an/aus (Standard an).
    pub fn set_pathtrace_denoise(&mut self, on: bool) {
        self.renderer.set_pathtrace_denoise(on);
    }

    /// [212] Höchstzahl Pixel je Sample (0 = Standard ≈ 1.2 MPx; Bild-Export höher).
    pub fn set_pathtrace_max_pixels(&mut self, n: f64) {
        let n = if n.is_finite() && n > 0.0 { n.min(1e9) as u64 } else { 0 };
        self.renderer.set_pathtrace_max_pixels(n);
    }

    /// [212] Materialtabelle des Pathtracers als JSON `[{ "name": Baustoff, "map": Farbkarte }, …]`, Eintrag i =
    /// Material-Ebene i + 1 (Reihenfolge wie `set_material_textures`). Kaputtes JSON = leere Tabelle.
    pub fn set_pathtrace_materials(&mut self, json: &str) {
        let entries: Vec<crate::pt_material::PtMaterialEntry> = serde_json::from_str(json).unwrap_or_default();
        self.renderer.set_pathtrace_materials(&entries);
    }

    /// Kantenlaenge der Schattentextur (Standard 2048, geklemmt 256…8192).
    pub fn set_shadow_map_size(&mut self, size: u32) {
        self.renderer.set_shadow_map_size(size);
    }

    /// Diagnose: Zahl der bisher gerenderten Schatten-Tiefenpaesse (bleibt beim Kamera-Drehen gleich).
    pub fn shadow_pass_count(&self) -> u32 {
        self.renderer.shadow_pass_count()
    }

    /// Schaltet das Referenz-Bodengitter (grid.rs) ein/aus und setzt seine
    /// Parameter. `elevation_m` = Hoehe der XZ-Gitterebene (world-Meter, i. d. R.
    /// die z=0-Ebene des aktiven Geschosses); `extent_m` = quadratische Kantenlaenge
    /// (auf ein Vielfaches von `spacing_m` gerundet); `spacing_m` = Linienabstand.
    /// Das Gitter ist zentriert um den Welt-Ursprung (x=0, z=0). Wirkt erst beim
    /// naechsten `render`. Default ohne Aufruf: unsichtbar (bestehende Aufrufer
    /// bleiben unveraendert). Jede 5. Linie (inkl. Mittelachse) ist eine Major-Linie.
    pub fn set_ground_grid(
        &mut self,
        visible: bool,
        elevation_m: f32,
        extent_m: f32,
        spacing_m: f32,
    ) -> Result<(), JsValue> {
        self.renderer
            .set_ground_grid(&self.device, visible, elevation_m, extent_m, spacing_m);
        Ok(())
    }

    /// Setzt/loescht die Auswahl-Highlight-Linien (Umriss/Kanten des selektierten
    /// Bauteils). `vertices` = interleaved LineList-Vertices
    /// `[px,py,pz, r,g,b, ...]` (world-Meter, je 2 Vertices = 1 Segment) — exakt
    /// dasselbe Format wie die Grid-/Edge-Vertices. Ein leeres Slice loescht das
    /// Highlight (nichts wird gezeichnet). Die Linien liegen im Render-Pass ohne
    /// Tiefentest immer sichtbar obenauf (scheinen auch hinter Waenden durch).
    /// Wirkt erst beim naechsten `render`.
    pub fn set_highlight_lines(&mut self, vertices: &[f32]) -> Result<(), JsValue> {
        self.renderer.set_highlight_lines(&self.device, vertices);
        Ok(())
    }

    /// Durchscheinende Koerper ([63] zulaessige Huelle, Kern `doc_site_envelope`): `data` =
    /// `[nDreieckWerte, Dreiecke (x y z r g b a)…, Kanten (x y z r g b)…]` (world-Meter). Leer
    /// oder ungueltig loescht. Wirkt erst beim naechsten `render`.
    pub fn set_ghost(&mut self, data: &[f32]) -> Result<(), JsValue> {
        let (head, rest) = data.split_first().map_or((0.0, &[][..]), |(h, r)| (*h, r));
        let n = if head.is_finite() && head >= 0.0 { (head as usize).min(rest.len()) } else { 0 };
        self.renderer.set_ghost(&self.device, &rest[..n], &rest[n..]);
        Ok(())
    }

    /// [180] Geisterschicht: Elemente grauer Klassen (Darstellungsmodus „grau"), gedaempft und durchscheinend
    /// ueber dem Modell (`ghost.rs`). `json` = Modell wie bei `set_model` (vom Kern nur aus den grauen Elementen
    /// gebaut); leer oder ungueltig loescht. Wirkt erst beim naechsten `render`.
    pub fn set_ghost_model(&mut self, json: &str) -> Result<(), JsValue> {
        let part = if json.trim().is_empty() {
            PartInput::default()
        } else {
            match serde_json::from_str::<ModelInput>(json) {
                Ok(m) => PartInput { walls: m.walls, slabs: m.slabs, meshes: m.meshes, roof_layers: Vec::new() },
                Err(e) => {
                    self.renderer.set_ghost_model(&self.device, PartInput::default());
                    return Err(JsValue::from_str(&format!("Geisterschicht parsen: {e}")));
                }
            }
        };
        self.renderer.set_ghost_model(&self.device, part);
        Ok(())
    }

    /// [180]/[214] Teil-Update der Geisterschicht, Format wie `set_parts` (`{ reset?, remove?, upsert? }`, Teile vom Kern
    /// nur aus den grauen Elementen): vernetzt und laedt nur Geaendertes. Gibt die Zahl der neu vernetzten Teile zurueck.
    pub fn set_ghost_parts(&mut self, json: &str) -> Result<u32, JsValue> {
        let upd: PartsUpdate =
            serde_json::from_str(json).map_err(|e| JsValue::from_str(&format!("Geisterschicht-Teile parsen: {e}")))?;
        Ok(self.renderer.update_ghost_parts(&self.device, upd).remeshed as u32)
    }

    /// [180] 2D-Spuren (`drawing`, `[x y z r g b]` je Vertex) und Flaechenmuster (`pattern`, wie `set_pattern_lines`) der
    /// grauen Klassen, gedaempft in der Geisterschicht (`ghost::mute_lines`/`mute_pattern`); leer loescht.
    pub fn set_ghost_lines(&mut self, drawing: &[f32], pattern: &[f32]) -> Result<(), JsValue> {
        self.renderer.set_ghost_lines(&self.device, drawing, pattern);
        Ok(())
    }

    /// Ansichtsschraffur auf den Flaechen ([100]): je Linie `ax ay az bx by bz r g b maske`
    /// (`pattern_lines::PATTERN_STRIDE`), Auswahl nach Abstand je Kamera; leer loescht.
    pub fn set_pattern_lines(&mut self, data: &[f32]) -> Result<(), JsValue> {
        self.renderer.set_pattern_lines(data);
        Ok(())
    }

    /// Setzt die 2D-Zeichnungs-Unterlage (Boden-Spuren der `Drawing2D`-Elemente)
    /// als LineList. `vertices` = interleaved `[px,py,pz, r,g,b, ...]`
    /// (world-Meter, je 2 Vertices = 1 Segment), dasselbe Format wie
    /// `set_highlight_lines`. Leeres Slice loescht die Unterlage.
    ///
    /// Bewusst ein eigener BINAERER Kanal statt Teil von `set_model`: Letzteres
    /// nimmt EINEN JSON-String, und ein Kataster-DXF (Amtliche Vermessung einer
    /// ganzen Stadt, ~3,6 Mio. Segmente) sprengt damit die JS-String-Laengen-
    /// grenze komplett (`RangeError: Invalid string length`) — gemessen an
    /// `AMTVER_Luzern_RAW.dxf`. `&[f32]` bindet wasm-bindgen direkt an ein
    /// JS-`Float32Array`: roher Byte-Kopiervorgang, keine Textkodierung, keine
    /// Laengengrenze. Wirkt erst beim naechsten `render`.
    pub fn set_drawing_lines(&mut self, vertices: &[f32]) -> Result<(), JsValue> {
        self.renderer.set_drawing_lines(&self.device, vertices);
        Ok(())
    }

    /// Laedt die Material-Farbkarten fuer den Stil `Textured` als Textur-Array hoch
    /// (`Renderer::set_material_textures`). `rgba` = dicht gepackte RGBA8-Bytes von
    /// `layer_count` Ebenen, JEDE exakt 256×256 (der JS-Aufrufer dekodiert/skaliert
    /// die Material-Bilder, siehe `viewport/materialTextures.ts`). Ebene 0 bleibt
    /// intern das Fallback-Schachbrett; die hochgeladenen Karten belegen die Ebenen
    /// 1..N, auf die `WallInput::materialIndex` (1-basiert) zeigt. `layer_count == 0`
    /// oder zu kleine Daten setzen auf das reine Schachbrett zurueck. Wirkt erst beim
    /// naechsten `render`.
    pub fn set_material_textures(&mut self, rgba: &[u8], layer_count: u32) -> Result<(), JsValue> {
        self.renderer
            .set_material_textures(&self.device, &self.queue, rgba, layer_count);
        Ok(())
    }

    /// Setzt/ersetzt das aufs Gelaende drapierte Luftbild (SWISSIMAGE). `rgba` =
    /// dicht gepackte RGBA8-Bytes (`width*height*4`, zeilenweise von OBEN = Nord),
    /// die der JS-Aufrufer aus der Bild-Data-URL dekodiert (siehe
    /// `viewport/aerialTexture.ts`). `min_x/min_y/max_x/max_y` = Modell-Meter-
    /// Bounding-Box (x = Ost, y = Nord). Ungueltige/leere Eingabe loescht das
    /// Luftbild. Wirkt erst beim naechsten `render`.
    #[allow(clippy::too_many_arguments)]
    pub fn set_aerial_texture(
        &mut self,
        rgba: &[u8],
        width: u32,
        height: u32,
        min_x: f32,
        min_y: f32,
        max_x: f32,
        max_y: f32,
    ) -> Result<(), JsValue> {
        self.renderer.set_aerial_texture(
            &self.device,
            &self.queue,
            rgba,
            width,
            height,
            [min_x, min_y, max_x, max_y],
        );
        Ok(())
    }

    /// Loescht das drapierte Luftbild (Gelaende erscheint wieder einfarbig/shaded).
    pub fn clear_aerial(&mut self) {
        self.renderer.clear_aerial();
    }

    /// Setzt/ersetzt die Punktwolke `id` ([27], `points.rs`/`gpu_points.rs`). `xyz` = f32 je Punkt
    /// RELATIV zum Ursprung, `ox/oy/oz` = Modell-Meter dieses Ursprungs (f64; x = Ost, y = Nord,
    /// z = Hoehe) — die Summe bildet Rust in f64. `rgb`/`intensity`/`classification` leer = fehlt
    /// (falsche Laenge = ignoriert). `color_mode` ∈ rgb|intensity|class|height, `point_size` in
    /// Bildschirm-Pixeln. Gibt die Anzahl gezeichneter Punkte zurueck; 0 = Eingabe unbrauchbar
    /// (die Wolke `id` ist dann entfernt) — nie ein Panic.
    #[allow(clippy::too_many_arguments)]
    pub fn set_point_cloud(
        &mut self,
        id: u32,
        xyz: &[f32],
        rgb: &[u8],
        intensity: &[u16],
        classification: &[u8],
        ox: f64,
        oy: f64,
        oz: f64,
        color_mode: &str,
        point_size: f32,
        visible: bool,
    ) -> u32 {
        let cpu = crate::points::PointCloudCpu::from_raw(xyz, rgb, intensity, classification, [ox, oy, oz]);
        let style = crate::gpu_points::PointStyle {
            mode: crate::points::PointColorMode::from_str_or_rgb(color_mode),
            size_px: point_size,
            visible,
        };
        self.renderer.set_point_cloud(&self.device, id, cpu, style);
        self.renderer.point_cloud_len(id) as u32
    }

    /// Nur Darstellung der Punktwolke `id` aendern (ohne Neu-Hochladen der Positionen).
    /// `false`, wenn die Wolke unbekannt ist (dann `set_point_cloud` aufrufen).
    pub fn set_point_cloud_style(&mut self, id: u32, color_mode: &str, point_size: f32, visible: bool) -> bool {
        let style = crate::gpu_points::PointStyle {
            mode: crate::points::PointColorMode::from_str_or_rgb(color_mode),
            size_px: point_size,
            visible,
        };
        self.renderer.set_point_cloud_style(&self.queue, id, style)
    }

    /// Entfernt die Punktwolke `id` (unbekannt = nichts).
    pub fn remove_point_cloud(&mut self, id: u32) {
        self.renderer.remove_point_cloud(id);
    }

    /// Entfernt alle Punktwolken.
    pub fn clear_point_clouds(&mut self) {
        self.renderer.clear_point_clouds();
    }

    /// [223] Hintergrundfarbe (0..1) setzen; Standard #f5f5f5. Der Bild-Export rendert damit zweimal
    /// (schwarz/weiss) und rechnet daraus einen transparenten Hintergrund. NaN wird verworfen.
    pub fn set_clear_color(&mut self, r: f32, g: f32, b: f32) {
        if ![r, g, b].iter().all(|v| v.is_finite()) {
            return;
        }
        self.renderer.clear_color = wgpu::Color {
            r: r.clamp(0.0, 1.0) as f64,
            g: g.clamp(0.0, 1.0) as f64,
            b: b.clamp(0.0, 1.0) as f64,
            a: 1.0,
        };
    }

    /// Surface an eine neue Pixelgroesse anpassen (DPR beachtet der Aufrufer).
    pub fn resize(&mut self, width: u32, height: u32) {
        let (w, h) = (width.max(1), height.max(1));
        if self.config.width == w && self.config.height == h {
            return;
        }
        self.config.width = w;
        self.config.height = h;
        self.surface.configure(&self.device, &self.config);
    }

    /// Zeichnet EINEN Frame in die Surface-Textur.
    pub fn render(&mut self) {
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
                    "render3d Surface-Fehler: {other:?}"
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
            &self.camera,
            (self.config.width, self.config.height),
        );
        frame.present();
    }
}
