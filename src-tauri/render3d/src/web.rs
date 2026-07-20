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
use crate::types::{Camera, CameraPreset, MeshInput, Projection, SlabInput, WallInput};

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
    let out = cut_section(&plane, &model.walls, &model.slabs);
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
    /// Gecachte Wand-/Decken-Eingabe des zuletzt gesetzten Modells. `set_model`
    /// verwirft sie nach dem GPU-Upload NICHT (anders als der Renderer selbst),
    /// weil der Live-Schnitt (`set_section_plane`) daraus jederzeit die
    /// Cut-Cap-Geometrie neu berechnen koennen muss (GPU-frei, `cut_section`).
    walls: Vec<WallInput>,
    slabs: Vec<SlabInput>,
    /// Aktueller Live-Schnitt-Zustand: aktiv? + Ebene (point/normal). Gemerkt,
    /// damit ein `set_model` bei aktivem Schnitt die Caps automatisch neu baut.
    section: Option<([f32; 3], [f32; 3])>,
}

/// Achsparallele Bounding-Box des Modells in Welt-Metern (Y-up), aus Waenden +
/// Decken. Mirror der TS-`fitTargetDist`-Grow-Schleife (Wasm3DViewport.tsx):
/// Wand-Achsenpunkte auf Basis-/Firsthoehe, Decken-Umriss auf Unter-/Oberkante.
/// `None` bei leerem Modell.
fn model_bounds(
    walls: &[WallInput],
    slabs: &[SlabInput],
    meshes: &[MeshInput],
) -> Option<([f32; 3], [f32; 3])> {
    let mut min = [f32::INFINITY; 3];
    let mut max = [f32::NEG_INFINITY; 3];
    let mut grow = |x: f32, y: f32, z: f32| {
        if x < min[0] {
            min[0] = x;
        }
        if x > max[0] {
            max[0] = x;
        }
        if y < min[1] {
            min[1] = y;
        }
        if y > max[1] {
            max[1] = y;
        }
        if z < min[2] {
            min[2] = z;
        }
        if z > max[2] {
            max[2] = z;
        }
    };
    for w in walls {
        grow(w.start[0], w.base_elevation, w.start[1]);
        grow(w.end[0], w.base_elevation + w.height, w.end[1]);
    }
    for s in slabs {
        for p in &s.outline {
            grow(p[0], s.z_bottom, p[1]);
            grow(p[0], s.z_top, p[1]);
        }
    }
    // Meshes (Daecher, Extrusionen, Stuetzen UND importierte Gebaeude/Terrain):
    // model (x,y,z=Hoehe) -> world (x, z, y). Ohne sie kann ein Praeset/Fit den
    // (evtl. weit entfernten) Import nicht rahmen.
    for m in meshes {
        let p = &m.positions;
        let mut i = 0;
        while i + 2 < p.len() {
            grow(p[i], p[i + 2], p[i + 1]);
            i += 3;
        }
    }
    if !min[0].is_finite() {
        return None;
    }
    Some((min, max))
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

        let (device, queue) = adapter
            .request_device(&wgpu::DeviceDescriptor {
                label: Some("render3d.web.device"),
                required_features: wgpu::Features::empty(),
                required_limits: wgpu::Limits::downlevel_webgl2_defaults()
                    .using_resolution(adapter.limits()),
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
            walls: Vec::new(),
            slabs: Vec::new(),
            section: None,
        })
    }

    /// Setzt/aktualisiert das darzustellende Modell aus einem JSON-String
    /// (Format = `{ walls: WallInput[], slabs?: SlabInput[] }`, identisch zum
    /// nativen Push). Laedt die GPU-Puffer neu hoch; ruft NICHT selbst `render`.
    /// Merkt sich zusaetzlich die Bounding-Box (fuer `set_view_preset`).
    pub fn set_model(&mut self, json: &str) -> Result<(), JsValue> {
        let model: ModelInput = serde_json::from_str(json)
            .map_err(|e| JsValue::from_str(&format!("Modell parsen: {e}")))?;
        self.bounds = model_bounds(&model.walls, &model.slabs, &model.meshes);
        self.renderer
            .upload_model(&self.device, &model.walls, &model.slabs, &model.meshes);
        // Wand-/Decken-Eingabe fuer den Live-Schnitt cachen (Klon, da der Renderer
        // sie nur zu GPU-Puffern verarbeitet und verwirft).
        self.walls = model.walls;
        self.slabs = model.slabs;
        // Ist der Schnitt aktiv, die Caps am neuen Modell neu aufbauen.
        if let Some((point, normal)) = self.section {
            self.renderer.update_section(
                &self.device,
                true,
                point,
                normal,
                &self.walls,
                &self.slabs,
            );
        }
        Ok(())
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
        self.renderer
            .update_section(&self.device, active, point, normal, &self.walls, &self.slabs);
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
        let (target, dist) = match self.bounds {
            Some((min, max)) => {
                let center = [
                    (min[0] + max[0]) * 0.5,
                    (min[1] + max[1]) * 0.5,
                    (min[2] + max[2]) * 0.5,
                ];
                let (dx, dy, dz) = (max[0] - min[0], max[1] - min[1], max[2] - min[2]);
                let radius = (dx * dx + dy * dy + dz * dz).sqrt() * 0.5;
                let radius = if radius > 0.0 { radius } else { 1.0 };
                // Abstand so, dass die Bounding-Kugel ins vertikale Sichtfeld
                // passt (+ Rand) — identische Formel wie `fitTargetDist`.
                let fov_y = crate::types::default_fov();
                let dist = ((radius / (fov_y * 0.5).tan()) * 1.2).max(4.0);
                (center, dist)
            }
            // Leeres Modell: neutraler Standpunkt (entspricht dem three.js-Start).
            None => ([2.5_f32, 1.0, 2.0], 14.0_f32),
        };
        self.camera = preset_camera(preset, target, dist);
        Ok(())
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
