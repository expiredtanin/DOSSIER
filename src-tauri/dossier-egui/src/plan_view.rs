// Grundriss-Ansicht: render2d rendert die Szene des aktiven Geschosses in eine Offscreen-Textur
// (gleiches wgpu-Device wie egui), egui zeigt sie und legt die Interaktion darüber: Pan/Zoom,
// Auswahl per Klick, Werkzeug „Wand zeichnen" mit Vorschau. Overlays (Auswahl, Skizze, Masse)
// zeichnet egui selbst — sie ändern sich pro Mausbewegung, die Szene nicht.

use egui::{Align2, Color32, FontId, Pos2, Rect, Sense, Shape, Stroke, Vec2};

use crate::app::{Selection, SketchWall, State, Tool};
use crate::bundle::{scene_bounds, Shape as ElShape};
use crate::geom::{band_corners, pick, seg_len, snap_point, PlanCamera};
use crate::i18n::t;
use crate::offscreen::{device_size, Offscreen};
use crate::theme;

/// Fangraster des Wandwerkzeugs (m).
const GRID: f32 = 0.05;

#[derive(Default)]
pub struct PlanView {
    renderer: Option<render2d::gpu::Renderer>,
    target: Option<Offscreen>,
    pub cam: Option<PlanCamera>,
    /// (Generation des Dokuments, Geschoss) der hochgeladenen Szene.
    uploaded: Option<(u64, usize)>,
    /// Schlüssel des zuletzt gerenderten Bilds (nur neu rendern, wenn er sich ändert).
    last_key: Option<[u64; 4]>,
    /// Gefangener Mauspunkt (Modell-Meter) für Vorschau und Statuszeile.
    pub hover: Option<[f32; 2]>,
}

impl PlanView {
    /// Nach dem Laden/Geschosswechsel: neu einpassen und neu hochladen.
    pub fn invalidate(&mut self, refit: bool) {
        self.uploaded = None;
        self.last_key = None;
        if refit {
            self.cam = None;
        }
    }
}

fn to_pos(rect: Rect, p: [f32; 2]) -> Pos2 {
    Pos2::new(rect.min.x + p[0], rect.min.y + p[1])
}

pub fn show(ui: &mut egui::Ui, st: &mut State, rs: Option<&egui_wgpu::RenderState>) {
    let Some(doc) = st.doc.as_ref() else {
        ui.centered_and_justified(|ui| ui.weak(t("load.hint")));
        return;
    };
    let level_idx = st.active_level.min(doc.bundle.levels.len().saturating_sub(1));
    let Some(level) = doc.bundle.levels.get(level_idx) else {
        ui.centered_and_justified(|ui| ui.weak(t("plan.empty")));
        return;
    };
    let generation = doc.generation;
    let paper_n = doc.bundle.scale;

    let (rect, resp) = ui.allocate_exact_size(ui.available_size(), Sense::click_and_drag());
    let size = [rect.width(), rect.height()];
    if size[0] < 2.0 || size[1] < 2.0 {
        return;
    }
    let pv = &mut st.plan;
    if pv.cam.is_none() || st.fit_request {
        let mut b = scene_bounds(&level.scene);
        for w in st.sketch.iter().filter(|w| w.level == level_idx) {
            b.add(w.a);
            b.add(w.b);
        }
        pv.cam = Some(PlanCamera::fit(b, size));
        st.fit_request = false;
    }
    let cam = pv.cam.as_mut().expect("Kamera gesetzt");
    cam.match_aspect(size);

    // ── Eingabe: Pan/Zoom ────────────────────────────────────────────────────
    let local = |p: Pos2| [p.x - rect.min.x, p.y - rect.min.y];
    let pan_button = match st.tool {
        Tool::Select => resp.dragged_by(egui::PointerButton::Primary) || resp.dragged_by(egui::PointerButton::Middle) || resp.dragged_by(egui::PointerButton::Secondary),
        Tool::Wall => resp.dragged_by(egui::PointerButton::Middle) || resp.dragged_by(egui::PointerButton::Secondary),
    };
    if pan_button {
        let d = resp.drag_delta();
        cam.pan_px([d.x, d.y], size);
    }
    if let Some(hp) = resp.hover_pos() {
        let (scroll, zoom) = ui.input(|i| (i.smooth_scroll_delta, i.zoom_delta()));
        let mut factor = zoom;
        // Mausrad ohne Modifikator zoomt (CAD-Gewohnheit); Trackpad-Pinch kommt als zoom_delta.
        if scroll.y != 0.0 {
            factor *= (scroll.y * 0.0025).exp();
        }
        if (factor - 1.0).abs() > 1e-4 {
            cam.zoom_at(factor, local(hp), size);
        }
    }
    let cam = *cam;

    // ── Eingabe: Werkzeuge ───────────────────────────────────────────────────
    let shift = ui.input(|i| i.modifiers.shift);
    pv.hover = st.demo_hover.or_else(|| resp.hover_pos().map(|hp| cam.to_model(local(hp), size)));
    match st.tool {
        Tool::Select => {
            if resp.clicked() {
                if let Some(p) = pv.hover {
                    let tol = 4.0 / cam.m_to_px(1.0, size).max(1e-6);
                    // Skizzierte Wände zuerst (liegen oben).
                    let sketch_hit = st.sketch.iter().rposition(|w| {
                        w.level == level_idx && crate::geom::dist_point_segment(p, w.a, w.b) <= w.thickness * 0.5 + tol
                    });
                    st.selection = match sketch_hit {
                        Some(i) => Some(Selection::Sketch(i)),
                        None => pick(&level.elements, p, tol).map(|i| Selection::Element { level: level_idx, index: i }),
                    };
                    st.view3d.invalidate_highlight();
                }
            }
        }
        Tool::Wall => {
            if let Some(p) = pv.hover {
                let snapped = snap_point(p, st.wall_chain, GRID, shift);
                pv.hover = Some(snapped);
                if resp.clicked() {
                    match st.wall_chain {
                        Some(a) if seg_len(a, snapped) > 1e-3 => {
                            st.sketch.push(SketchWall { a, b: snapped, thickness: st.wall_thickness, level: level_idx });
                            st.wall_chain = Some(snapped);
                            st.view3d.invalidate_model();
                        }
                        Some(_) => {}
                        None => st.wall_chain = Some(snapped),
                    }
                }
            }
            let end = resp.double_clicked() || resp.secondary_clicked() || ui.input(|i| i.key_pressed(egui::Key::Escape) || i.key_pressed(egui::Key::Enter));
            if end {
                st.wall_chain = None;
            }
        }
    }

    // ── Rendern (nur wenn sich Bild oder Grösse geändert haben) ─────────────
    let painter = ui.painter_at(rect);
    let dark = ui.visuals().dark_mode;
    let Some(rs) = rs else {
        painter.rect_filled(rect, 0.0, ui.visuals().extreme_bg_color);
        painter.text(rect.center(), Align2::CENTER_CENTER, t("gpu.missing"), FontId::proportional(13.0), ui.visuals().error_fg_color);
        return;
    };
    let ppp = ui.ctx().pixels_per_point();
    let dsize = device_size(rect, ppp);
    let renderer = pv.renderer.get_or_insert_with(|| {
        let mut r = render2d::gpu::Renderer::new(&rs.device, wgpu::TextureFormat::Rgba8Unorm);
        r.text_scale_n = 100.0;
        r
    });
    if pv.uploaded != Some((generation, level_idx)) {
        renderer.upload_scene(&rs.device, &level.scene);
        renderer.paper_scale_n = paper_n.max(1.0);
        pv.uploaded = Some((generation, level_idx));
        pv.last_key = None;
    }
    let fresh = Offscreen::ensure(&mut pv.target, rs, dsize, wgpu::TextureFormat::Rgba8Unorm, wgpu::TextureFormat::Rgba8UnormSrgb, "plan.target");
    let key = [
        generation ^ ((level_idx as u64) << 48) ^ ((dark as u64) << 47),
        ((dsize[0] as u64) << 32) | dsize[1] as u64,
        ((cam.vb.x.to_bits() as u64) << 32) | cam.vb.y.to_bits() as u64,
        ((cam.vb.w.to_bits() as u64) << 32) | cam.vb.h.to_bits() as u64,
    ];
    let target = pv.target.as_ref().expect("Ziel angelegt");
    if fresh || pv.last_key != Some(key) {
        renderer.clear_color = theme::paper(dark);
        renderer.render(&rs.device, &rs.queue, &target.render_view, cam.vb, (dsize[0], dsize[1]));
        pv.last_key = Some(key);
    }
    painter.image(target.tex_id, rect, Rect::from_min_max(Pos2::ZERO, Pos2::new(1.0, 1.0)), Color32::WHITE);

    // ── Overlays ────────────────────────────────────────────────────────────
    let px = |p: [f32; 2]| to_pos(rect, cam.to_px(p, size));
    let poly = |pts: &[[f32; 2]]| pts.iter().map(|p| px(*p)).collect::<Vec<_>>();

    // Skizzierte Wände (nicht gespeichert)
    for (i, w) in st.sketch.iter().enumerate().filter(|(_, w)| w.level == level_idx) {
        let sel = st.selection == Some(Selection::Sketch(i));
        let c = band_corners(w.a, w.b, w.thickness);
        painter.add(Shape::convex_polygon(poly(&c), theme::SKETCH.gamma_multiply(0.35), Stroke::new(if sel { 2.0 } else { 1.2 }, if sel { theme::SELECT } else { theme::SKETCH })));
    }

    // Auswahl
    if let Some(Selection::Element { level: l, index }) = st.selection {
        if l == level_idx {
            if let Some(e) = level.elements.get(index) {
                let fill = theme::SELECT.gamma_multiply(0.12);
                let stroke = Stroke::new(2.0, theme::SELECT);
                match &e.shape {
                    ElShape::Segment { a, b, width } => {
                        painter.add(Shape::convex_polygon(poly(&band_corners(*a, *b, *width)), fill, stroke));
                    }
                    ElShape::Polygon { pts } => {
                        // Konkave Räume: nur Umriss (egui füllt nur konvex korrekt).
                        let mut p = poly(pts);
                        if let Some(f) = p.first().copied() {
                            p.push(f);
                        }
                        painter.add(Shape::line(p, stroke));
                    }
                    ElShape::Circle { c, r } => {
                        painter.circle(px(*c), cam.m_to_px(*r, size), fill, stroke);
                    }
                }
            }
        }
    }

    // Wandwerkzeug: Vorschau + Fangmarke
    if st.tool == Tool::Wall {
        if let Some(h) = pv.hover {
            if let Some(a) = st.wall_chain {
                if seg_len(a, h) > 1e-3 {
                    let c = band_corners(a, h, st.wall_thickness);
                    painter.add(Shape::convex_polygon(poly(&c), theme::SKETCH.gamma_multiply(0.22), Stroke::new(1.0, theme::SKETCH)));
                    painter.add(Shape::dashed_line(&[px(a), px(h)], Stroke::new(1.0, theme::SKETCH), 6.0, 4.0));
                    let mid = px([(a[0] + h[0]) * 0.5, (a[1] + h[1]) * 0.5]);
                    let label = format!("{:.2} m", seg_len(a, h));
                    let galley = painter.layout_no_wrap(label, FontId::proportional(12.0), Color32::WHITE);
                    let r = Rect::from_center_size(mid + Vec2::new(0.0, -16.0), galley.size() + Vec2::new(10.0, 4.0));
                    painter.rect_filled(r, 4.0, theme::SKETCH);
                    painter.galley(r.center() - galley.size() * 0.5, galley, Color32::WHITE);
                }
            }
            let hp = px(h);
            let s = Stroke::new(1.0, theme::SKETCH);
            painter.line_segment([hp - Vec2::new(8.0, 0.0), hp + Vec2::new(8.0, 0.0)], s);
            painter.line_segment([hp - Vec2::new(0.0, 8.0), hp + Vec2::new(0.0, 8.0)], s);
            painter.circle_stroke(hp, 3.0, s);
        }
    }

    // Massstabsleiste + Koordinaten (unten links)
    let ink = Color32::from_gray(40);
    let m_px = cam.m_to_px(1.0, size);
    let nice = [0.1f32, 0.2, 0.5, 1.0, 2.0, 5.0, 10.0, 20.0, 50.0, 100.0];
    let len_m = nice.iter().copied().find(|m| m * m_px >= 70.0).unwrap_or(100.0);
    let base = Pos2::new(rect.min.x + 16.0, rect.max.y - 16.0);
    let bar = len_m * m_px;
    painter.line_segment([base, base + Vec2::new(bar, 0.0)], Stroke::new(1.5, ink));
    for x in [0.0, bar] {
        painter.line_segment([base + Vec2::new(x, -4.0), base + Vec2::new(x, 0.0)], Stroke::new(1.5, ink));
    }
    // Näherung: 96 Punkte je Zoll (die tatsächliche Bildschirmdichte kennt egui nicht).
    let scale_n = cam.paper_scale(size, 96.0 / 25.4);
    let coords = pv.hover.map(|p| format!("   x {:.2}  y {:.2}", p[0], p[1])).unwrap_or_default();
    painter.text(base + Vec2::new(bar + 8.0, 0.0), Align2::LEFT_BOTTOM, format!("{len_m} m · ≈1:{:.0}{coords}", scale_n.round()), FontId::proportional(11.0), ink);

    // Hinweis oben links
    let hint = if st.tool == Tool::Wall { t("plan.hint_wall") } else { t("plan.hint_select") };
    painter.text(rect.min + Vec2::new(12.0, 10.0), Align2::LEFT_TOP, hint, FontId::proportional(11.0), Color32::from_gray(110));
    if st.tool == Tool::Wall && resp.hovered() {
        ui.ctx().set_cursor_icon(egui::CursorIcon::Crosshair);
    }
}
