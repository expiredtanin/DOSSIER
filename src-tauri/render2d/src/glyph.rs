// Glyphen-Text (glyphon/cosmic-text, GPU-Atlas) fuer BEIDE Renderer: den Szenen-Renderer
// (`gpu::Renderer`, Browser/WebGPU und headless) und den Chunk-Renderer der nativen macOS-Flaeche
// (`chunks::ChunkRenderer`, Metal) — [194]: Raumstempel und Textfelder im selben Frame wie die
// Linien, mit derselben Schrift (eingebettetes Inter) und derselben Zeilenlage (gesetzt im Kern,
// `core/src/plan/text.rs`), statt im SVG-Overlay der Webview.
//
// Schriftfamilien ([226]): `GlyphLine::family` waehlt eine der gebuendelten Familien (0 = Inter). Die Bytes
// kommen LAZY von aussen (`add_font`, WOFF2 oder SFNT, je Familie und Schnitt); `needed_fonts` sagt, was
// die aktuellen Zeilen noch brauchen. Fehlt eine Familie (noch nicht geladen, Datei fehlt, kaputt), zeichnet
// der Pass in Inter; fehlt nur der Schnitt (z. B. kursiv), in der naechstbesten Variante derselben Familie.
// Die Familiennamen in den Dateien sind unzuverlaessig (Instanzen heissen "Archivo SemiBold" o. ae.),
// darum merkt sich der Pass je geladener Datei Name, Gewicht und Neigung und fragt genau damit ab.
//
// Jede Zeile wird EINMAL bei einer Referenzgroesse geshapt; pro Frame aendert sich nur der Massstab
// (`TextArea::scale`) und die Lage — Pan/Zoom kostet kein erneutes Shaping. Die Glyphen rastert
// glyphon in der tatsaechlichen Pixelgroesse (scharf bei jedem Zoom).

use crate::text_lines::GlyphLine;
use crate::types::{TextAlign, STYLE_BOLD, STYLE_ITALIC};
use std::collections::{HashMap, HashSet};

/// Schluessel einer Schriftdatei: Familie << 8 | Schnitt (`STYLE_BOLD` | `STYLE_ITALIC`).
pub fn font_key(family: u32, style: u32) -> u32 {
    (family << 8) | (style & (STYLE_BOLD | STYLE_ITALIC))
}

/// Geladene Datei: wie sie in fontdb heisst und welcher Schnitt sie ist.
#[derive(Clone)]
struct Face {
    name: String,
    weight: u16,
    italic: bool,
}

/// Ersatzkette fuer einen Schnitt derselben Familie (zuerst der gewuenschte).
fn style_chain(style: u32) -> Vec<u32> {
    let mut v = vec![style];
    for s in [style & !STYLE_ITALIC, style & !STYLE_BOLD, 0] {
        if !v.contains(&s) {
            v.push(s);
        }
    }
    v
}

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
    /// Geladene Dateien je `font_key`.
    faces: HashMap<u32, Face>,
    /// Bytes, die vor dem ersten Frame mit Text eintrafen (`font_key`, SFNT).
    pending_fonts: Vec<(u32, Vec<u8>)>,
    /// Schluessel, die geladen wurden oder als nicht verfuegbar gemeldet sind (nicht erneut anfordern).
    tried: HashSet<u32>,
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
            faces: HashMap::new(),
            pending_fonts: Vec::new(),
            tried: HashSet::new(),
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
        let mut old: HashMap<(String, u32, u32), Vec<Shaped>> = HashMap::new();
        for (l, s) in self.lines.drain(..).zip(self.shaped.drain(..)) {
            if let Some(s) = s {
                old.entry((l.content, l.style, l.family)).or_default().push(s);
            }
        }
        self.shaped = lines.iter().map(|l| old.get_mut(&(l.content.clone(), l.style, l.family)).and_then(|v| v.pop())).collect();
        self.lines = lines;
    }

    pub fn lines(&self) -> &[GlyphLine] {
        &self.lines
    }

    /// Schriftdatei (WOFF2 oder SFNT) fuer Familie/Schnitt einspielen. `Err` bei Unbrauchbarem (der Schluessel
    /// gilt dann als nicht verfuegbar, die Zeilen bleiben in Inter bzw. der Ersatz-Variante).
    pub fn add_font(&mut self, family: u32, style: u32, bytes: &[u8]) -> Result<(), String> {
        let key = font_key(family, style);
        self.tried.insert(key);
        if family == 0 {
            return Err("Familie 0 ist das eingebettete Inter".into());
        }
        let sfnt = crate::woff2::to_sfnt(bytes)?;
        match self.state.as_mut() {
            Some(st) => {
                let face = register_face(&mut st.font_system, sfnt).ok_or("Schrift nicht lesbar")?;
                self.faces.insert(key, face);
                self.invalidate(family);
            }
            None => self.pending_fonts.push((key, sfnt)),
        }
        Ok(())
    }

    /// Datei fuer Familie/Schnitt gibt es nicht (404 o. ae.): nicht weiter anfordern.
    pub fn mark_font_unavailable(&mut self, family: u32, style: u32) {
        self.tried.insert(font_key(family, style));
    }

    /// Schriftdateien (`font_key`), die die aktuellen Zeilen noch brauchen und die noch niemand geliefert hat.
    /// Fuer einen Schnitt, den es nicht gibt, kommt der naechste der Ersatzkette (Manrope kursiv → Manrope).
    pub fn needed_fonts(&self) -> Vec<u32> {
        let mut out: Vec<u32> = Vec::new();
        let mut seen: HashSet<u32> = HashSet::new();
        for l in &self.lines {
            if l.family == 0 || l.content.is_empty() || !seen.insert(font_key(l.family, l.style)) {
                continue;
            }
            for s in style_chain(l.style & (STYLE_BOLD | STYLE_ITALIC)) {
                let k = font_key(l.family, s);
                if self.faces.contains_key(&k) || self.pending_fonts.iter().any(|(p, _)| *p == k) {
                    break;
                }
                if !self.tried.contains(&k) {
                    if !out.contains(&k) {
                        out.push(k);
                    }
                    break;
                }
            }
        }
        out.sort_unstable();
        out
    }

    /// Zeilen dieser Familie neu setzen (eine Datei kam dazu).
    fn invalidate(&mut self, family: u32) {
        for (l, s) in self.lines.iter().zip(self.shaped.iter_mut()) {
            if l.family == family {
                *s = None;
            }
        }
    }

    fn ensure_state(&mut self, device: &wgpu::Device, queue: &wgpu::Queue) -> &mut State {
        if self.state.is_none() {
            // Nativ: Systemschriften als Rueckfall fuer Zeichen, die Inter nicht kennt (wie das SVG).
            let mut font_system = glyphon::FontSystem::new();
            for (key, sfnt) in std::mem::take(&mut self.pending_fonts) {
                if let Some(face) = register_face(&mut font_system, sfnt) {
                    self.faces.insert(key, face);
                }
            }
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
        let faces = self.faces.clone();
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
                // Gebuendelte Familie (Datei mit genau ihrem Namen/Gewicht/Neigung), sonst Inter.
                let face = if l.family == 0 { None } else { style_chain(l.style).into_iter().find_map(|s| faces.get(&font_key(l.family, s))) };
                let mut attrs = glyphon::Attrs::new().family(glyphon::Family::Name(face.map_or(family.as_str(), |f| f.name.as_str())));
                let (bold, italic) = match face {
                    Some(f) => (f.weight >= 600, f.italic),
                    None => (l.style & STYLE_BOLD != 0, l.style & STYLE_ITALIC != 0),
                };
                if bold {
                    attrs = attrs.weight(face.map_or(glyphon::Weight::BOLD, |f| glyphon::Weight(f.weight)));
                }
                if italic {
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

/// SFNT in die Schriftdatenbank laden und die neue Datei beschreiben (`None`: nicht lesbar).
fn register_face(fs: &mut glyphon::FontSystem, sfnt: Vec<u8>) -> Option<Face> {
    let db = fs.db_mut();
    let before: HashSet<_> = db.faces().map(|f| f.id).collect();
    db.load_font_data(sfnt);
    let f = db.faces().find(|f| !before.contains(&f.id))?;
    Some(Face { name: f.families.first()?.0.clone(), weight: f.weight.0, italic: f.style != fontdb::Style::Normal })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(content: &str, style: u32, family: u32) -> GlyphLine {
        GlyphLine { x: 0.0, y: 0.0, content: content.into(), size_mm: 2.5, color: [0.0, 0.0, 0.0, 1.0], align: TextAlign::Left, style, family }
    }

    fn woff2(slug: &str, file: &str) -> Vec<u8> {
        std::fs::read(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("../../public/fonts/{slug}/{file}.woff2"))).unwrap()
    }

    /// [226] Was fehlt, wird verlangt (je Familie und Schnitt einmal); Inter (0) nie; geliefertes und als fehlend
    /// gemeldetes nicht erneut; fehlt ein Schnitt, kommt der naechste der Ersatzkette.
    #[test]
    fn benoetigte_schriften_und_ersatzkette() {
        let mut g = GlyphText::new(wgpu::TextureFormat::Rgba8Unorm, 1);
        g.set_lines(vec![line("a", 0, 0), line("b", 0, 15), line("c", STYLE_BOLD, 15), line("d", STYLE_BOLD, 15), line("e", STYLE_ITALIC, 7), line("", 0, 9)]);
        let (serif, serif_bold, manrope_it, manrope) = (font_key(15, 0), font_key(15, STYLE_BOLD), font_key(7, STYLE_ITALIC), font_key(7, 0));
        assert_eq!(g.needed_fonts(), vec![manrope_it, serif, serif_bold]);
        assert!(g.add_font(15, 0, &woff2("source-serif-4", "source-serif-4-400-normal")).is_ok());
        assert_eq!(g.needed_fonts(), vec![manrope_it, serif_bold]);
        // Datei fehlt (404): Ersatz = aufrechter Schnitt derselben Familie.
        g.mark_font_unavailable(7, STYLE_ITALIC);
        assert_eq!(g.needed_fonts(), vec![manrope, serif_bold]);
        // Unbrauchbare Bytes: kein Panic, Schluessel gilt als erledigt.
        assert!(g.add_font(15, STYLE_BOLD, b"<html>nicht gefunden</html>").is_err());
        g.mark_font_unavailable(7, 0);
        assert_eq!(g.needed_fonts(), Vec::<u32>::new());
        assert!(g.add_font(0, 0, &[]).is_err());
    }
}
