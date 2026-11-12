// Glyphen-Text (glyphon/cosmic-text, GPU-Atlas) fuer BEIDE Renderer: den Szenen-Renderer
// (`gpu::Renderer`, Browser/WebGPU und headless) und den Chunk-Renderer der nativen macOS-Flaeche
// (`chunks::ChunkRenderer`, Metal) — [194]: Raumstempel und Textfelder im selben Frame wie die
// Linien, mit derselben Schrift (eingebettetes Inter) und derselben Zeilenlage (gesetzt im Kern,
// `core/src/plan/text.rs`), statt im SVG-Overlay der Webview.
//
// Jede Zeile wird EINMAL bei einer Referenzgroesse geshapt; pro Frame aendert sich nur der Massstab
// (`TextArea::scale`) und die Lage — Pan/Zoom kostet kein erneutes Shaping. Die Glyphen rastert
// glyphon in der tatsaechlichen Pixelgroesse (scharf bei jedem Zoom).

use crate::text_lines::GlyphLine;
use crate::types::{TextAlign, STYLE_BOLD, STYLE_ITALIC};

/// Eingebettete Plan-Schrift (Inter, variabel). Wird in jedem Pfad geladen: auf wasm gibt es keine
/// Systemschriften, nativ macht sie das Schriftbild unabhaengig vom installierten Fontbestand.
pub const INTER_TTF: &[u8] = include_bytes!("../assets/Inter.ttf");

/// Familie, falls die eingebettete Schrift nicht registriert werden konnte (Systemschrift).
const DEFAULT_FAMILY: &str = "Inter";

/// Shaping-Groesse in px; gezeichnet wird mit `font_px / REF_PX`.
const REF_PX: f32 = 32.0;

/// Texte unter dieser Pixelhoehe werden nicht gezeichnet.
const MIN_FONT_PX: f32 = 1.0;

struct Shaped {
    buffer: glyphon::Buffer,
    /// Zeilenbreite und Baseline bei `REF_PX`.
    width: f32,
    baseline: f32,
}

struct State {
    font_system: glyphon::FontSystem,
    swash_cache: glyphon::SwashCache,
    viewport: glyphon::Viewport,
    atlas: glyphon::TextAtlas,
    renderer: glyphon::TextRenderer,
}

/// Glyphen-Pass: Zeilen setzen (`set_lines`), je Frame `prepare` vor und `render` im Render-Pass.
pub struct GlyphText {
    format: wgpu::TextureFormat,
    samples: u32,
    state: Option<State>,
    family: String,
    font_bytes: Option<Vec<u8>>,
    lines: Vec<GlyphLine>,
    shaped: Vec<Option<Shaped>>,
}

impl GlyphText {
    /// `samples` MUSS die MSAA-Stufe des Render-Passes sein, in dem `render` zeichnet.
    pub fn new(format: wgpu::TextureFormat, samples: u32) -> Self {
        GlyphText {
            format,
            samples,
            state: None,
            family: DEFAULT_FAMILY.to_string(),
            font_bytes: Some(INTER_TTF.to_vec()),
            lines: Vec::new(),
            shaped: Vec::new(),
        }
    }

    /// Andere Schrift-Bytes (vor dem ersten Frame mit Text).
    pub fn set_font(&mut self, bytes: Vec<u8>) {
        if self.state.is_none() {
            self.font_bytes = Some(bytes);
        }
    }

    /// Zeilen ersetzen. Unveraenderte Zeilen (gleicher Inhalt/Schnitt) behalten ihr Shaping.
    pub fn set_lines(&mut self, lines: Vec<GlyphLine>) {
        let mut old: std::collections::HashMap<(String, u32), Vec<Shaped>> = std::collections::HashMap::new();
        for (l, s) in self.lines.drain(..).zip(self.shaped.drain(..)) {
            if let Some(s) = s {
                old.entry((l.content, l.style)).or_default().push(s);
            }
        }
        self.shaped = lines.iter().map(|l| old.get_mut(&(l.content.clone(), l.style)).and_then(|v| v.pop())).collect();
        self.lines = lines;
    }

    pub fn lines(&self) -> &[GlyphLine] {
        &self.lines
    }

    fn ensure_state(&mut self, device: &wgpu::Device, queue: &wgpu::Queue) -> &mut State {
        if self.state.is_none() {
            // Nativ: Systemschriften als Rueckfall fuer Zeichen, die Inter nicht kennt (wie das SVG).
            let mut font_system = glyphon::FontSystem::new();
            if let Some(bytes) = self.font_bytes.take() {
                let db = font_system.db_mut();
                let before: std::collections::HashSet<_> = db.faces().map(|f| f.id).collect();
                db.load_font_data(bytes);
                // Die Inter-Variable-Datei meldet sich als "Inter Variable", nicht "Inter".
                if let Some((name, _)) = db.faces().find(|f| !before.contains(&f.id)).and_then(|f| f.families.first()) {
                    self.family = name.clone();
                }
            }
            let cache = glyphon::Cache::new(device);
            let viewport = glyphon::Viewport::new(device, &cache);
            // ColorMode::Web: die Ziele sind non-sRGB und die Geometrie schreibt ihre sRGB-Werte
            // unkonvertiert — Accurate wuerde die Glyphen dunkler zeichnen als das SVG.
            let mut atlas = glyphon::TextAtlas::with_color_mode(device, queue, &cache, self.format, glyphon::ColorMode::Web);
            let renderer = glyphon::TextRenderer::new(
                &mut atlas,
                device,
                wgpu::MultisampleState { count: self.samples, mask: !0, alpha_to_coverage_enabled: false },
                None,
            );
            self.state = Some(State { font_system, swash_cache: glyphon::SwashCache::new(), viewport, atlas, renderer });
        }
        self.state.as_mut().unwrap()
    }

    /// Glyphen dieses Frames vorbereiten. `place`: Anker (Modell-Meter) → Geraete-px (links oben = 0);
    /// `px_per_mm`: Geraete-px je Papier-mm der Schriftgroesse.
    pub fn prepare(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        viewport: (u32, u32),
        place: impl Fn(f64, f64) -> (f32, f32),
        px_per_mm: f32,
    ) {
        if self.lines.is_empty() && self.state.is_none() {
            return;
        }
        let family = self.family.clone();
        let (vw, vh) = (viewport.0 as f32, viewport.1 as f32);
        // `ensure_state` leiht `self` exklusiv; Zeilen/Shaping-Cache daher vorher herausnehmen.
        let lines = std::mem::take(&mut self.lines);
        let mut shaped = std::mem::take(&mut self.shaped);
        let st = self.ensure_state(device, queue);
        struct Placed {
            idx: usize,
            left: f32,
            top: f32,
            scale: f32,
            color: glyphon::Color,
        }
        let mut placed: Vec<Placed> = Vec::new();
        for (i, l) in lines.iter().enumerate() {
            let font_px = l.size_mm * px_per_mm;
            if !(font_px >= MIN_FONT_PX) || l.content.is_empty() {
                continue;
            }
            let (ax, ay) = place(l.x, l.y);
            if !(ax.is_finite() && ay.is_finite()) {
                continue;
            }
            // Grob vor dem Shaping (Breite noch unbekannt): Zeichenzahl als Obergrenze.
            let reach = font_px * (l.content.chars().count() as f32 + 2.0);
            if ax < -reach || ax > vw + reach || ay < -2.0 * font_px || ay > vh + 2.0 * font_px {
                continue;
            }
            let s = shaped[i].get_or_insert_with(|| {
                let mut buffer = glyphon::Buffer::new(&mut st.font_system, glyphon::Metrics::new(REF_PX, REF_PX * 1.2));
                buffer.set_size(&mut st.font_system, None, None);
                let mut attrs = glyphon::Attrs::new().family(glyphon::Family::Name(&family));
                if l.style & STYLE_BOLD != 0 {
                    attrs = attrs.weight(glyphon::Weight::BOLD);
                }
                if l.style & STYLE_ITALIC != 0 {
                    attrs = attrs.style(glyphon::Style::Italic);
                }
                buffer.set_text(&mut st.font_system, &l.content, &attrs, glyphon::Shaping::Advanced, None);
                buffer.shape_until_scroll(&mut st.font_system, false);
                let (width, baseline) = buffer.layout_runs().next().map(|r| (r.line_w, r.line_y)).unwrap_or((0.0, REF_PX * 0.8));
                Shaped { buffer, width, baseline }
            });
            let scale = font_px / REF_PX;
            let w = s.width * scale;
            let left = match l.align {
                TextAlign::Left => ax,
                TextAlign::Center => ax - w / 2.0,
                TextAlign::Right => ax - w,
            };
            let top = ay - s.baseline * scale; // Anker-Y ist die Baseline.
            if left > vw || left + w < 0.0 || top > vh || top + font_px * 1.4 < 0.0 {
                continue;
            }
            let c = l.color;
            let to8 = |v: f32| (v.clamp(0.0, 1.0) * 255.0).round() as u8;
            placed.push(Placed { idx: i, left, top, scale, color: glyphon::Color::rgba(to8(c[0]), to8(c[1]), to8(c[2]), to8(c[3])) });
        }
        st.viewport.update(queue, glyphon::Resolution { width: viewport.0, height: viewport.1 });
        let bounds = glyphon::TextBounds { left: 0, top: 0, right: viewport.0 as i32, bottom: viewport.1 as i32 };
        let areas = placed.iter().map(|p| glyphon::TextArea {
            buffer: &shaped[p.idx].as_ref().unwrap().buffer,
            left: p.left,
            top: p.top,
            scale: p.scale,
            bounds,
            default_color: p.color,
            custom_glyphs: &[],
        });
        if let Err(e) = st.renderer.prepare(device, queue, &mut st.font_system, &mut st.atlas, &st.viewport, areas, &mut st.swash_cache) {
            eprintln!("render2d Text-prepare fehlgeschlagen: {e:?}");
        }
        // Nicht mehr benoetigte Glyphen aus dem Atlas werfen (haelt ihn klein).
        st.atlas.trim();
        self.lines = lines;
        self.shaped = shaped;
    }

    /// Die vorbereiteten Glyphen in den laufenden Pass zeichnen (nach der Geometrie: zuoberst).
    pub fn render(&self, pass: &mut wgpu::RenderPass<'_>) {
        if let Some(st) = &self.state {
            if let Err(e) = st.renderer.render(&st.atlas, &st.viewport, pass) {
                eprintln!("render2d Text-render fehlgeschlagen: {e:?}");
            }
        }
    }
}
