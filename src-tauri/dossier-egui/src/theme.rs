// Erscheinungsbild: Systemschrift (macOS: SF Pro/Helvetica Neue, sonst Inter/Noto/DejaVu),
// ruhige Abstände und je eine helle/dunkle Palette in der Nähe der TSX-App (neutrales Grau,
// ein gedämpftes Blau als Akzent). Hell/Dunkel folgt dem System (eframe/winit melden die
// Systemeinstellung), lässt sich aber in der Werkzeugleiste festlegen.

use egui::{Color32, CornerRadius, FontData, FontDefinitions, FontFamily, Stroke, Theme, Visuals};
use std::sync::Arc;

/// Akzentfarbe (Auswahl, aktives Werkzeug) — gedämpftes Blau.
pub const ACCENT: Color32 = Color32::from_rgb(0x2f, 0x6f, 0xd6);
/// Hervorhebung des gewählten Bauteils im Grundriss.
pub const SELECT: Color32 = Color32::from_rgb(0x1f, 0x7a, 0xff);
/// Vorschau „Wand zeichnen".
pub const SKETCH: Color32 = Color32::from_rgb(0xe0, 0x6a, 0x1b);

/// Kandidaten je Plattform, in dieser Reihenfolge gesucht (fontdb-Familiennamen).
fn ui_font_families() -> &'static [&'static str] {
    if cfg!(target_os = "macos") {
        // SF Pro liegt als SFNS.ttf vor und meldet sich je nach macOS als „System Font“.
        &["SF Pro", "SF Pro Text", "System Font", ".SF NS", "Helvetica Neue", "Helvetica"]
    } else if cfg!(target_os = "windows") {
        &["Segoe UI", "Inter", "Arial"]
    } else {
        &["Inter", "Cantarell", "Noto Sans", "DejaVu Sans"]
    }
}

/// Sucht die erste vorhandene Systemschrift (Bytes + Index der Fläche). `None` → egui-Standard.
pub fn find_system_font() -> Option<(String, Vec<u8>, u32)> {
    let mut db = fontdb::Database::new();
    db.load_system_fonts();
    for fam in ui_font_families() {
        let q = fontdb::Query { families: &[fontdb::Family::Name(fam)], weight: fontdb::Weight::NORMAL, stretch: fontdb::Stretch::Normal, style: fontdb::Style::Normal };
        let Some(id) = db.query(&q) else { continue };
        let Some(face) = db.face(id) else { continue };
        let bytes = match &face.source {
            fontdb::Source::File(p) => std::fs::read(p).ok(),
            fontdb::Source::Binary(b) | fontdb::Source::SharedFile(_, b) => Some(b.as_ref().as_ref().to_vec()),
        };
        let Some(bytes) = bytes else { continue };
        // egui bricht bei unlesbaren Schriften ab — vorher selbst prüfen.
        if ttf_parser::Face::parse(&bytes, face.index).is_err() {
            continue;
        }
        return Some((fam.to_string(), bytes, face.index));
    }
    None
}

/// Setzt Schrift und beide Paletten. Gibt den Namen der verwendeten Systemschrift zurück.
pub fn install(ctx: &egui::Context) -> Option<String> {
    let found = find_system_font();
    if let Some((name, bytes, index)) = &found {
        let mut fonts = FontDefinitions::default();
        fonts.font_data.insert("system-ui".into(), Arc::new(FontData { index: *index, ..FontData::from_owned(bytes.clone()) }));
        // Systemschrift zuerst, die egui-Schriften bleiben als Rückfall (Symbole, Emoji).
        fonts.families.entry(FontFamily::Proportional).or_default().insert(0, "system-ui".into());
        ctx.set_fonts(fonts);
        log::info!("Systemschrift: {name}");
    }
    ctx.set_visuals_of(Theme::Light, light());
    ctx.set_visuals_of(Theme::Dark, dark());
    ctx.all_styles_mut(|s| {
        s.spacing.item_spacing = egui::vec2(8.0, 6.0);
        s.spacing.button_padding = egui::vec2(8.0, 4.0);
        s.spacing.interact_size.y = 24.0;
        s.spacing.indent = 16.0;
        use egui::{FontId, TextStyle};
        s.text_styles.insert(TextStyle::Body, FontId::proportional(13.0));
        s.text_styles.insert(TextStyle::Button, FontId::proportional(13.0));
        s.text_styles.insert(TextStyle::Small, FontId::proportional(11.0));
        s.text_styles.insert(TextStyle::Heading, FontId::proportional(15.0));
        s.text_styles.insert(TextStyle::Monospace, FontId::monospace(12.0));
    });
    found.map(|f| f.0)
}

fn radius(v: &mut Visuals) {
    let r = CornerRadius::same(5);
    v.widgets.noninteractive.corner_radius = r;
    v.widgets.inactive.corner_radius = r;
    v.widgets.hovered.corner_radius = r;
    v.widgets.active.corner_radius = r;
    v.widgets.open.corner_radius = r;
    v.window_corner_radius = CornerRadius::same(8);
    v.menu_corner_radius = CornerRadius::same(6);
}

pub fn light() -> Visuals {
    let mut v = Visuals::light();
    v.panel_fill = Color32::from_rgb(0xf4, 0xf4, 0xf2);
    v.window_fill = Color32::from_rgb(0xfb, 0xfb, 0xfa);
    v.faint_bg_color = Color32::from_rgb(0xec, 0xec, 0xea);
    v.extreme_bg_color = Color32::WHITE;
    v.widgets.noninteractive.bg_stroke = Stroke::new(1.0, Color32::from_rgb(0xdd, 0xdd, 0xda));
    v.widgets.inactive.weak_bg_fill = Color32::from_rgb(0xe8, 0xe8, 0xe6);
    v.widgets.hovered.weak_bg_fill = Color32::from_rgb(0xde, 0xde, 0xdc);
    v.selection.bg_fill = Color32::from_rgb(0xd3, 0xe2, 0xfa);
    v.selection.stroke = Stroke::new(1.0, ACCENT);
    v.hyperlink_color = ACCENT;
    radius(&mut v);
    v
}

pub fn dark() -> Visuals {
    let mut v = Visuals::dark();
    v.panel_fill = Color32::from_rgb(0x24, 0x25, 0x27);
    v.window_fill = Color32::from_rgb(0x2a, 0x2b, 0x2e);
    v.faint_bg_color = Color32::from_rgb(0x2c, 0x2d, 0x30);
    v.extreme_bg_color = Color32::from_rgb(0x1b, 0x1c, 0x1e);
    v.widgets.noninteractive.bg_stroke = Stroke::new(1.0, Color32::from_rgb(0x3a, 0x3b, 0x3f));
    v.widgets.inactive.weak_bg_fill = Color32::from_rgb(0x34, 0x35, 0x39);
    v.widgets.hovered.weak_bg_fill = Color32::from_rgb(0x3e, 0x40, 0x44);
    v.selection.bg_fill = Color32::from_rgb(0x2b, 0x4a, 0x7a);
    v.selection.stroke = Stroke::new(1.0, Color32::from_rgb(0x8a, 0xb4, 0xf8));
    v.hyperlink_color = Color32::from_rgb(0x8a, 0xb4, 0xf8);
    radius(&mut v);
    v
}

/// Zeichenblatt des Grundrisses (linear 0..1 für wgpu). Der Plan bleibt auch im Dunkelmodus
/// ein helles Blatt — Strichfarben und Schraffuren sind für Papier gemacht; nur leicht gedimmt.
pub fn paper(dark: bool) -> wgpu::Color {
    if dark {
        wgpu::Color { r: 0.84, g: 0.84, b: 0.83, a: 1.0 }
    } else {
        wgpu::Color { r: 0.985, g: 0.985, b: 0.98, a: 1.0 }
    }
}

/// Hintergrund der 3D-Ansicht (sRGB-Ziel → lineare Werte).
pub fn sky(dark: bool) -> wgpu::Color {
    if dark {
        wgpu::Color { r: 0.075, g: 0.078, b: 0.085, a: 1.0 }
    } else {
        wgpu::Color { r: 0.90, g: 0.90, b: 0.89, a: 1.0 }
    }
}
