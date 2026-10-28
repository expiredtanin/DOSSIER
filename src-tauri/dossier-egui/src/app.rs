// Die App: Zustand, Werkzeugleiste, Dock-Layout (egui_dock) und Screenshot-Modus.
//
// Layout wie die TSX-App: Werkzeugleiste oben, links „Geschosse", Mitte die Ansicht mit den
// Tabs Grundriss | 3D, rechts „Eigenschaften" | „Flächenbilanz". Tabs lassen sich verschieben,
// abdocken und zusammenlegen (egui_dock); das Layout wird (noch) nicht gespeichert.

use std::path::PathBuf;

use egui::{RichText, ThemePreference};
use egui_dock::{DockArea, DockState, NodeIndex, TabViewer};

use crate::bundle::Bundle;
use crate::i18n::t;
use crate::plan_view::PlanView;
use crate::view3d::View3d;
use crate::{loader, panels, plan_view, theme, view3d};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tool {
    Select,
    Wall,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Selection {
    Element { level: usize, index: usize },
    Sketch(usize),
}

/// Eine skizzierte (nicht gespeicherte) Wand des Werkzeugs „Wand zeichnen".
#[derive(Debug, Clone, Copy)]
pub struct SketchWall {
    pub a: [f32; 2],
    pub b: [f32; 2],
    pub thickness: f32,
    pub level: usize,
}

pub struct Doc {
    pub bundle: Bundle,
    /// Woher geladen (Datei oder Beispiel) — für „Neu laden".
    pub source: Source,
    /// Steigt bei jedem Laden (GPU-Puffer neu hochladen).
    pub generation: u64,
}

#[derive(Debug, Clone)]
pub enum Source {
    File(PathBuf),
    Example,
}

pub struct State {
    pub doc: Option<Doc>,
    generation: u64,
    pub active_level: usize,
    pub visible3d: Vec<bool>,
    pub context_visible: bool,
    pub selection: Option<Selection>,
    pub tool: Tool,
    pub wall_thickness: f32,
    pub sketch: Vec<SketchWall>,
    /// Letzter gesetzter Punkt der laufenden Wandkette.
    pub wall_chain: Option<[f32; 2]>,
    pub plan: PlanView,
    pub view3d: View3d,
    pub fit_request: bool,
    pub status: String,
    pub error: bool,
    /// Screenshot-Modus: Mausposition (Modell-Meter) für die Vorschau des Wandwerkzeugs.
    pub demo_hover: Option<[f32; 2]>,
}

impl State {
    fn new() -> Self {
        Self {
            doc: None,
            generation: 0,
            active_level: 0,
            visible3d: vec![],
            context_visible: true,
            selection: None,
            tool: Tool::Select,
            wall_thickness: 0.2,
            sketch: vec![],
            wall_chain: None,
            plan: PlanView::default(),
            view3d: View3d::default(),
            fit_request: false,
            status: String::new(),
            error: false,
            demo_hover: None,
        }
    }

    pub fn set_active_level(&mut self, i: usize) {
        self.active_level = i;
        self.wall_chain = None;
        self.plan.invalidate(false);
    }

    fn load(&mut self, source: Source) {
        let res = match &source {
            Source::File(p) => loader::load_path(p),
            Source::Example => loader::bundle_via_cli(loader::EXAMPLE),
        };
        match res {
            Ok(bundle) => {
                self.generation += 1;
                // Aktiv: Erdgeschoss = das Geschoss mit der kleinsten |Höhe|, sonst das erste.
                self.active_level = bundle
                    .levels
                    .iter()
                    .enumerate()
                    .min_by(|a, b| a.1.elevation.abs().total_cmp(&b.1.elevation.abs()))
                    .map(|(i, _)| i)
                    .unwrap_or(0);
                self.visible3d = bundle.levels.iter().map(|l| l.visible).collect();
                self.status = format!("{}: {} · {} {}", t("load.loaded"), if bundle.name.is_empty() { "—" } else { &bundle.name }, bundle.levels.len(), t("tab.levels"));
                self.error = false;
                self.doc = Some(Doc { bundle, source, generation: self.generation });
                self.selection = None;
                self.sketch.clear();
                self.wall_chain = None;
                self.plan.invalidate(true);
                self.view3d.refit();
            }
            Err(e) => {
                log::error!("{e}");
                self.status = format!("{}: {e}", t("load.error"));
                self.error = true;
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tab {
    Levels,
    Plan,
    View3d,
    Properties,
    Areas,
}

/// Steuerung für Screenshots ohne Bildschirm-Interaktion (`--screenshot`).
#[derive(Debug, Clone, Default)]
pub struct Scripted {
    pub screenshot: Option<PathBuf>,
    pub focus_3d: bool,
    pub focus_areas: bool,
    pub select: Option<String>,
    pub sketch_demo: bool,
}

pub struct DossierApp {
    dock: DockState<Tab>,
    st: State,
    theme_pref: ThemePreference,
    scripted: Scripted,
    frame_no: u64,
    shot_requested: bool,
}

pub struct StartOptions {
    pub source: Option<Source>,
    pub theme: ThemePreference,
    pub scripted: Scripted,
}

impl DossierApp {
    pub fn new(cc: &eframe::CreationContext<'_>, opts: StartOptions) -> Self {
        theme::install(&cc.egui_ctx);
        cc.egui_ctx.set_theme(opts.theme);

        let mut dock = DockState::new(vec![Tab::Plan, Tab::View3d]);
        let surface = dock.main_surface_mut();
        let [center, _levels] = surface.split_left(NodeIndex::root(), 0.17, vec![Tab::Levels]);
        let [_center, _right] = surface.split_right(center, 0.76, vec![Tab::Properties, Tab::Areas]);
        for (on, tab) in [(opts.scripted.focus_3d, Tab::View3d), (opts.scripted.focus_areas, Tab::Areas)] {
            if let Some(loc) = dock.find_tab(&tab).filter(|_| on) {
                let _ = dock.set_active_tab(loc);
            }
        }

        let mut st = State::new();
        if let Some(src) = opts.source {
            st.load(src);
        }
        let mut app = Self { dock, st, theme_pref: opts.theme, scripted: opts.scripted, frame_no: 0, shot_requested: false };
        app.apply_scripted_setup();
        app
    }

    /// Screenshot-Modus: Auswahl und Beispiel-Skizze vorbereiten.
    fn apply_scripted_setup(&mut self) {
        let st = &mut self.st;
        if let (Some(id), Some(doc)) = (&self.scripted.select, &st.doc) {
            'outer: for (li, l) in doc.bundle.levels.iter().enumerate() {
                for (ei, e) in l.elements.iter().enumerate() {
                    if &e.id == id {
                        st.selection = Some(Selection::Element { level: li, index: ei });
                        st.active_level = li;
                        break 'outer;
                    }
                }
            }
        }
        if self.scripted.sketch_demo {
            let lvl = st.active_level;
            // Ein Anbau als Probe: zwei Wände ans bestehende Haus, die dritte noch in der Vorschau.
            let pts = [[5.25, 0.0], [8.0, 0.0], [8.0, 3.2]];
            for w in pts.windows(2) {
                st.sketch.push(SketchWall { a: w[0], b: w[1], thickness: 0.2, level: lvl });
            }
            st.tool = Tool::Wall;
            st.wall_chain = Some([8.0, 3.2]);
            st.demo_hover = Some([5.25, 3.2]);
            st.view3d.invalidate_model();
        }
    }

    fn toolbar(&mut self, ui: &mut egui::Ui) {
        let st = &mut self.st;
        ui.horizontal(|ui| {
            ui.add_space(4.0);
            ui.label(RichText::new("Dossier").strong().size(14.0));
            ui.separator();
            if ui.button(t("toolbar.open")).clicked() {
                let picked = rfd::FileDialog::new()
                    .add_filter(t("load.filter_json"), &["json"])
                    .add_filter(t("load.filter_obp"), &["obp"])
                    .pick_file();
                if let Some(p) = picked {
                    st.load(Source::File(p));
                }
            }
            let can_reload = st.doc.is_some();
            if ui.add_enabled(can_reload, egui::Button::new(t("toolbar.reload"))).clicked() {
                if let Some(src) = st.doc.as_ref().map(|d| d.source.clone()) {
                    st.load(src);
                }
            }
            ui.separator();
            let sel = ui.selectable_label(st.tool == Tool::Select, t("toolbar.select"));
            if sel.clicked() {
                st.tool = Tool::Select;
                st.wall_chain = None;
            }
            if ui.selectable_label(st.tool == Tool::Wall, t("toolbar.wall")).clicked() {
                st.tool = Tool::Wall;
            }
            if st.tool == Tool::Wall {
                ui.label(t("toolbar.wall_thickness"));
                ui.add(egui::DragValue::new(&mut st.wall_thickness).range(0.05..=1.0).speed(0.01).suffix(" m").fixed_decimals(2));
            }
            ui.separator();
            if ui.button(t("toolbar.fit")).clicked() {
                st.fit_request = true;
                st.view3d.refit();
            }
            if ui.add_enabled(!st.sketch.is_empty(), egui::Button::new(t("toolbar.clear_sketch"))).clicked() {
                st.sketch.clear();
                st.wall_chain = None;
                if matches!(st.selection, Some(Selection::Sketch(_))) {
                    st.selection = None;
                }
                st.view3d.invalidate_model();
            }

            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                ui.add_space(4.0);
                let before = self.theme_pref;
                egui::ComboBox::from_id_salt("theme")
                    .selected_text(match self.theme_pref {
                        ThemePreference::Light => t("theme.light"),
                        ThemePreference::Dark => t("theme.dark"),
                        ThemePreference::System => t("theme.system"),
                    })
                    .show_ui(ui, |ui| {
                        ui.selectable_value(&mut self.theme_pref, ThemePreference::System, t("theme.system"));
                        ui.selectable_value(&mut self.theme_pref, ThemePreference::Light, t("theme.light"));
                        ui.selectable_value(&mut self.theme_pref, ThemePreference::Dark, t("theme.dark"));
                    });
                if before != self.theme_pref {
                    ui.ctx().set_theme(self.theme_pref);
                }
                if let Some(doc) = &st.doc {
                    ui.weak(&doc.bundle.name);
                }
            });
        });
    }

    fn handle_screenshot(&mut self, ui: &mut egui::Ui) {
        let Some(path) = self.scripted.screenshot.clone() else { return };
        self.frame_no += 1;
        let ctx = ui.ctx().clone();
        // Ein paar Bilder abwarten (Layout, Schriftatlas, Offscreen-Texturen).
        if !self.shot_requested && self.frame_no >= 6 {
            ctx.send_viewport_cmd(egui::ViewportCommand::Screenshot(Default::default()));
            self.shot_requested = true;
        }
        let shot = ctx.input(|i| {
            i.events.iter().find_map(|e| match e {
                egui::Event::Screenshot { image, .. } => Some(image.clone()),
                _ => None,
            })
        });
        if let Some(img) = shot {
            let [w, h] = img.size;
            let rgba: Vec<u8> = img.pixels.iter().flat_map(|c| c.to_array()).collect();
            match image::save_buffer(&path, &rgba, w as u32, h as u32, image::ExtendedColorType::Rgba8) {
                Ok(()) => eprintln!("Screenshot: {} ({w}x{h})", path.display()),
                Err(e) => eprintln!("Screenshot fehlgeschlagen: {e}"),
            }
            ctx.send_viewport_cmd(egui::ViewportCommand::Close);
        }
        ctx.request_repaint();
    }
}

struct Viewer<'a> {
    st: &'a mut State,
    rs: Option<&'a egui_wgpu::RenderState>,
}

impl TabViewer for Viewer<'_> {
    type Tab = Tab;

    fn title(&mut self, tab: &mut Tab) -> egui::WidgetText {
        match tab {
            Tab::Levels => t("tab.levels"),
            Tab::Plan => t("tab.plan"),
            Tab::View3d => t("tab.3d"),
            Tab::Properties => t("tab.properties"),
            Tab::Areas => t("tab.areas"),
        }
        .into()
    }

    fn ui(&mut self, ui: &mut egui::Ui, tab: &mut Tab) {
        match tab {
            Tab::Levels => panels::levels(ui, self.st),
            Tab::Plan => plan_view::show(ui, self.st, self.rs),
            Tab::View3d => view3d::show(ui, self.st, self.rs),
            Tab::Properties => panels::properties(ui, self.st),
            Tab::Areas => panels::areas(ui, self.st),
        }
    }

    fn is_closeable(&self, _tab: &Tab) -> bool {
        false
    }

    fn scroll_bars(&self, tab: &Tab) -> [bool; 2] {
        match tab {
            Tab::Plan | Tab::View3d => [false, false],
            _ => [false, true],
        }
    }
}

impl eframe::App for DossierApp {
    fn ui(&mut self, ui: &mut egui::Ui, frame: &mut eframe::Frame) {
        let rs = frame.wgpu_render_state();
        egui::Panel::top("toolbar").frame(egui::Frame::side_top_panel(ui.style()).inner_margin(egui::Margin::symmetric(6, 6))).show(ui, |ui| self.toolbar(ui));
        egui::Panel::bottom("status").frame(egui::Frame::side_top_panel(ui.style()).inner_margin(egui::Margin::symmetric(10, 3))).show(ui, |ui| {
            ui.horizontal(|ui| {
                let text = RichText::new(&self.st.status).small();
                if self.st.error {
                    ui.label(text.color(ui.visuals().error_fg_color));
                } else {
                    ui.weak(text);
                }
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    ui.weak(RichText::new("egui · wgpu · render2d/render3d").small());
                });
            });
        });
        let mut style = egui_dock::Style::from_egui(ui.style());
        style.tab_bar.fill_tab_bar = false;
        egui::CentralPanel::default().frame(egui::Frame::NONE).show(ui, |ui| {
            DockArea::new(&mut self.dock)
                .style(style)
                .show_close_buttons(false)
                .show_add_buttons(false)
                .show_leaf_collapse_buttons(false)
                .show_leaf_close_all_buttons(false)
                .show_inside(ui, &mut Viewer { st: &mut self.st, rs });
        });
        self.handle_screenshot(ui);
    }
}
